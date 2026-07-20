// @ts-nocheck
import {
  beginAuthorization,
  exchangeAuthorizationCode,
  retireOAuthConnection,
  revokeAccessToken
} from "../src/oauth.js";
import { PRODUCT_CONFIG } from "../src/product-config.js";
import { MANAGED_DATABASE_SCHEMA_VERSION } from "../src/constants.js";
import {
  connectionTransitionForAuthorization,
  DEFAULT_SETTINGS,
  hasBundledOAuthConfig,
  migrateLegacyOAuthCredentials
} from "../src/settings.js";

const $ = (selector) => document.querySelector(selector);
let settings = { ...DEFAULT_SETTINGS };
let searchTimer;
let searchSequence = 0;
let lastProvisioningOutcome = "existing";

init();

async function init() {
  $("#extension-version").textContent = chrome.runtime.getManifest().version;
  const migration = await migrateLegacyOAuthCredentials(chrome.storage.local);
  settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  const reconnectRequired = migration.requiresReconnect
    || Boolean((await chrome.storage.local.get("oauthReconnectRequired")).oauthReconnectRequired);
  $("#advanced-setup").hidden = hasBundledOAuthConfig(PRODUCT_CONFIG);
  hydrateForm();
  bindEvents();
  setConnectionState(Boolean(settings.token));

  if (!settings.token) {
    setStage("connect");
    if (reconnectRequired) flash("Quick Note updated how it protects your Notion connection. Reconnect once to continue.", false, true);
    return;
  }

  const legacyManagedDestination = Boolean(settings.destinationDatabaseId);
  const needsMigration = (settings.managedDestination || legacyManagedDestination)
    && Number(settings.destinationSchemaVersion || 0) < MANAGED_DATABASE_SCHEMA_VERSION;
  if (settings.destinationId && !needsMigration) {
    await showReady();
    return;
  }

  await provisionDefaultDatabase();
}

function hydrateForm() {
  $("#token").value = "";
  $("#oauth-client-id").value = PRODUCT_CONFIG.notionClientId || settings.oauthClientId;
  $("#oauth-broker-url").value = PRODUCT_CONFIG.oauthBrokerUrl || settings.oauthBrokerUrl;
  $("#include-source").checked = settings.includeSource;
  $("#ai-enabled").checked = settings.aiEnabled;
  $("#ai-suggest-title").checked = settings.aiSuggestTitle;
  $("#ai-extract-todos").checked = settings.aiExtractTodos;
  updateAiControls();
  $("#workspace-name").textContent = settings.workspaceName || "Notion";
  hydrateWorkspaceIcon($("#workspace-icon"), settings.workspaceIcon);
  $("#manual-destination-id").value = settings.destinationId;
  $("#manual-destination-name").value = settings.destinationName;
  $("#manual-title-property").value = settings.titleProperty;
}

function bindEvents() {
  $("#oauth-connect").addEventListener("click", () => connectOAuth($("#oauth-connect")));
  $("#save-developer-config").addEventListener("click", saveDeveloperConfig);
  $("#use-token").addEventListener("click", connectWithToken);
  $("#reveal-token").addEventListener("click", toggleToken);
  $("#create-database").addEventListener("click", provisionDefaultDatabase);
  $("#refresh-destinations").addEventListener("click", () => loadDestinations());
  $("#empty-refresh").addEventListener("click", () => loadDestinations());
  $("#destination-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadDestinations($("#destination-search").value), 250);
  });
  $("#include-source").addEventListener("change", async () => {
    settings.includeSource = $("#include-source").checked;
    await chrome.storage.local.set({ includeSource: settings.includeSource });
  });
  $("#ai-enabled").addEventListener("change", async () => {
    const previous = settings.aiEnabled;
    settings.aiEnabled = $("#ai-enabled").checked;
    updateAiControls();
    try {
      await chrome.storage.local.set({ aiEnabled: settings.aiEnabled });
    } catch {
      settings.aiEnabled = previous;
      $("#ai-enabled").checked = previous;
      updateAiControls();
      flash("Could not save the AI preference. Try again.", true);
    }
  });
  for (const [selector, key] of [["#ai-suggest-title", "aiSuggestTitle"], ["#ai-extract-todos", "aiExtractTodos"]]) {
    $(selector).addEventListener("change", async () => {
      const previous = settings[key];
      settings[key] = $(selector).checked;
      try {
        await chrome.storage.local.set({ [key]: settings[key] });
      } catch {
        settings[key] = previous;
        $(selector).checked = previous;
        flash("Could not save the AI preference. Try again.", true);
      }
    });
  }
  document.querySelectorAll("input[name=manual-destination-type]").forEach((radio) => {
    radio.addEventListener("change", updateManualDestinationType);
  });
  $("#use-manual-destination").addEventListener("click", useManualDestination);
  $("#change-destination").addEventListener("click", showDestinationPicker);
  $("#change-connection").addEventListener("click", disconnect);
  $("#disconnect").addEventListener("click", disconnect);
  $("#finish").addEventListener("click", finishSetup);
  $("#open-destination").addEventListener("click", openDestination);
  $("#refresh-permissions").addEventListener("click", () => connectOAuth($("#refresh-permissions")));
}

function updateAiControls() {
  const enabled = $("#ai-enabled").checked;
  $("#ai-feature-controls").dataset.disabled = String(!enabled);
  $("#ai-suggest-title").disabled = !enabled;
  $("#ai-extract-todos").disabled = !enabled;
}

async function saveDeveloperConfig() {
  const oauthClientId = $("#oauth-client-id").value.trim();
  const oauthBrokerUrl = normalizeBrokerUrl($("#oauth-broker-url").value);
  if (!oauthClientId || !oauthBrokerUrl) return flash("Add both OAuth configuration values.", true);
  try {
    new URL(oauthBrokerUrl);
  } catch {
    return flash("Enter a valid OAuth broker URL.", true);
  }
  await chrome.storage.local.set({ oauthClientId, oauthBrokerUrl });
  settings = { ...settings, oauthClientId, oauthBrokerUrl };
  flash("OAuth configuration saved.");
}

async function connectWithToken() {
  const token = $("#token").value.trim();
  if (!token) return flash("Paste a Notion token first.", true);

  await storeConnection({
    authType: "token",
    token,
    connectionHandle: "",
    workspaceId: "",
    workspaceName: "",
    workspaceIcon: "",
    botId: ""
  });
  $("#token").value = "";
  await provisionDefaultDatabase();
}

async function connectOAuth(button) {
  const clientId = PRODUCT_CONFIG.notionClientId || $("#oauth-client-id").value.trim();
  const brokerUrl = PRODUCT_CONFIG.oauthBrokerUrl || normalizeBrokerUrl($("#oauth-broker-url").value);
  if (!clientId || !brokerUrl) {
    $("#advanced-setup").open = true;
    return flash("Add a client ID and broker URL in Advanced setup first.", true);
  }

  const idleLabel = button === $("#refresh-permissions") ? "Grant access to more pages" : "Connect Notion";
  const previousConnection = settings.authType === "oauth" ? {
    token: settings.token,
    connectionHandle: settings.connectionHandle,
    botId: settings.botId,
    brokerUrl: PRODUCT_CONFIG.oauthBrokerUrl || settings.oauthBrokerUrl
  } : null;
  setBusy(button, true, "Connecting…");
  try {
    const origin = `${new URL(brokerUrl).origin}/*`;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error("Permission to contact the OAuth broker was declined.");

    const redirectUri = chrome.identity.getRedirectURL("notion");
    const transaction = await beginAuthorization({ brokerUrl, redirectUri });
    const state = String(transaction?.state || "");
    if (!state) throw new Error("The OAuth broker did not start a valid authorization transaction.");
    await chrome.storage.session.set({ oauthState: state });
    const url = new URL("https://api.notion.com/v1/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);

    const finalUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
    if (!finalUrl) throw new Error("Notion did not complete authorization.");
    const callback = new URL(finalUrl);
    const expectedCallback = new URL(redirectUri);
    if (callback.origin !== expectedCallback.origin || callback.pathname !== expectedCallback.pathname) {
      throw new Error("Notion returned authorization to an unexpected callback URL.");
    }
    if (callback.searchParams.get("state") !== state) throw new Error("OAuth state did not match.");
    const code = callback.searchParams.get("code");
    if (!code) throw new Error(callback.searchParams.get("error") || "No authorization code was returned.");

    const payload = await exchangeAuthorizationCode({ brokerUrl, code, redirectUri, state });
    for (const [field, label] of [
      ["access_token", "access token"],
      ["connection_handle", "connection handle"],
      ["bot_id", "bot ID"],
      ["workspace_id", "workspace ID"]
    ]) {
      if (!String(payload?.[field] || "").trim()) throw new Error(`Notion did not return a valid ${label}.`);
    }
    const { preservedDestination } = await storeConnection({
      authType: "oauth",
      token: payload.access_token,
      connectionHandle: payload.connection_handle,
      workspaceId: payload.workspace_id,
      workspaceName: payload.workspace_name || "",
      workspaceIcon: payload.workspace_icon || "",
      botId: payload.bot_id,
      oauthClientId: clientId,
      oauthBrokerUrl: brokerUrl
    });
    await retireReplacedConnection(previousConnection, payload, brokerUrl);
    if (preservedDestination) await showReady("existing");
    else await provisionDefaultDatabase();
  } catch (error) {
    flash(error.message, true);
  } finally {
    await chrome.storage.session.remove("oauthState");
    setBusy(button, false, idleLabel);
  }
}

async function retireReplacedConnection(previous, next, fallbackBrokerUrl) {
  if (!previous?.connectionHandle || previous.connectionHandle === next.connection_handle) return;
  const previousBrokerUrl = previous.brokerUrl || fallbackBrokerUrl;
  try {
    if (previous.botId && previous.botId !== next.bot_id && previous.token) {
      await revokeAccessToken({
        brokerUrl: previousBrokerUrl,
        connectionHandle: previous.connectionHandle,
        token: previous.token
      });
      return;
    }
    await retireOAuthConnection({
      brokerUrl: previousBrokerUrl,
      connectionHandle: previous.connectionHandle
    });
  } catch (error) {
    console.warn("Could not retire the replaced Notion connection; it will expire at the broker.", error);
  }
}

async function storeConnection(connection) {
  const { connectionId, preservedDestination } = connectionTransitionForAuthorization(settings, connection);
  const nextConnection = {
    ...connection,
    connectionId,
    legacyOAuthBotId: "",
    legacyOAuthConnectionId: ""
  };
  if (preservedDestination) {
    settings = { ...settings, ...nextConnection };
    await chrome.storage.local.set(nextConnection);
    await chrome.storage.local.remove(["oauthReconnectRequired", "legacyOAuthBotId", "legacyOAuthConnectionId"]);
    setConnectionState(true);
    hydrateWorkspace();
    return { connectionId, preservedDestination: true };
  }
  const resetDestination = {
    connectionId,
    destinationId: "",
    destinationDatabaseId: "",
    destinationType: "database",
    destinationName: "Quick Notes",
    destinationUrl: "",
    titleProperty: "Name",
    managedDestination: false,
    destinationSchemaVersion: 0,
    destinationMarker: "",
    destinationProperties: {},
    destinationConnectionId: "",
    databaseProvisioning: null,
    onboardingComplete: false
  };
  settings = { ...settings, ...nextConnection, ...resetDestination };
  await chrome.storage.local.set({ ...nextConnection, ...resetDestination });
  await chrome.storage.local.remove(["oauthReconnectRequired", "legacyOAuthBotId", "legacyOAuthConnectionId"]);
  setConnectionState(true);
  hydrateWorkspace();
  return { connectionId, preservedDestination: false };
}

async function provisionDefaultDatabase() {
  if (!settings.token) return setStage("connect");

  setStage("destination");
  showProvisioningState(true, settings.databaseProvisioning?.status === "uncertain"
    ? "Checking whether Notion finished creating your database…"
    : "Creating and organizing your private Quick Notes database…");
  setBusy($("#create-database"), true, "Creating Quick Notes…");
  flash("Creating your Quick Notes database in Notion…", false, true);
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "ENSURE_DEFAULT_DATABASE" });
  } catch (error) {
    response = { ok: false, error: error.message };
  }

  if (!response?.ok) {
    showProvisioningState(false);
    setBusy($("#create-database"), false, "Create Quick Notes database");
    flash(provisioningErrorMessage(response), true, true);
    await loadDestinations();
    return;
  }

  settings = { ...settings, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  lastProvisioningOutcome = response.outcome || "existing";
  showProvisioningState(false);
  setBusy($("#create-database"), false, "Create Quick Notes database");
  flash(outcomeMessage(lastProvisioningOutcome));
  await showReady(lastProvisioningOutcome);
}

async function showDestinationPicker() {
  setStage("destination");
  showProvisioningState(false);
  $("#create-database").hidden = Boolean(settings.destinationId);
  await loadDestinations();
}

async function loadDestinations(query = $("#destination-search").value) {
  if (!settings.token) return;
  const requestId = ++searchSequence;
  const results = $("#destination-results");
  const empty = $("#destination-empty");
  const loading = document.createElement("div");
  loading.className = "loading-row";
  loading.append(document.createElement("span"), Object.assign(document.createElement("span"), { textContent: "Looking in Notion…" }));
  results.replaceChildren(loading);
  empty.hidden = true;
  results.setAttribute("aria-busy", "true");

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "SEARCH_DESTINATIONS", query });
  } catch (error) {
    response = { ok: false, error: error.message };
  }
  if (requestId !== searchSequence) return;
  results.removeAttribute("aria-busy");
  results.replaceChildren();
  if (!response?.ok) {
    empty.hidden = false;
    flash(response?.error || "Could not load Notion destinations.", true, true);
    return;
  }

  for (const destination of response.destinations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "destination-option";
    button.setAttribute("role", "option");

    const icon = document.createElement("span");
    icon.className = "destination-icon";
    icon.textContent = destination.icon;
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = destination.name;
    const type = document.createElement("small");
    type.textContent = destination.type === "database" ? "Database" : "Page";
    copy.append(title, type);
    button.append(icon, copy);
    button.addEventListener("click", () => chooseDestination(destination));
    results.append(button);
  }
  empty.hidden = response.destinations.length > 0;
}

async function chooseDestination(destination) {
  flash("Checking destination access…", false, true);
  const validation = await chrome.runtime.sendMessage({
    type: "VALIDATE_DESTINATION",
    destination
  }).catch((error) => ({ ok: false, error: error.message }));
  if (!validation?.ready) {
    flash(validation?.error || "Quick Note cannot use this destination. Reshare it with the integration and allow Insert Content.", true, true);
    return;
  }
  const selected = {
    destinationType: destination.type,
    destinationId: destination.id,
    destinationName: destination.name,
    titleProperty: destination.titleProperty || "Name",
    destinationDatabaseId: "",
    destinationUrl: destination.url || "",
    managedDestination: false,
    destinationSchemaVersion: 0,
    destinationMarker: "",
    destinationProperties: {},
    destinationConnectionId: "",
    databaseProvisioning: null,
    includeSource: $("#include-source").checked,
    onboardingComplete: true
  };
  await chrome.storage.local.set(selected);
  settings = { ...settings, ...selected };
  lastProvisioningOutcome = "existing";
  await showReady("existing");
}

function updateManualDestinationType() {
  const type = $("input[name=manual-destination-type]:checked").value;
  $("#manual-title-property-wrap").hidden = type !== "database";
}

async function useManualDestination() {
  const id = $("#manual-destination-id").value.trim();
  if (!id) return flash("Paste a Notion destination URL or ID first.", true);
  const type = $("input[name=manual-destination-type]:checked").value;
  await chooseDestination({
    id,
    type,
    name: $("#manual-destination-name").value.trim() || (type === "database" ? "Quick Notes" : "Notion Inbox"),
    titleProperty: $("#manual-title-property").value.trim() || "Name"
  });
}

async function disconnect() {
  if (!confirm("Disconnect this Notion workspace? Your saved notes will not be changed.")) return;
  let response = await chrome.runtime.sendMessage({ type: "DISCONNECT_NOTION" });
  if (response?.requiresConfirmation) {
    const count = response.pendingCount;
    if (!confirm(`${count} capture${count === 1 ? " is" : "s are"} still waiting locally. Disconnect and keep ${count === 1 ? "it" : "them"} blocked until you reconnect or retarget?`)) return;
    response = await chrome.runtime.sendMessage({ type: "DISCONNECT_NOTION", confirmed: true });
  }
  if (!response?.ok) return flash(response?.error || "Could not disconnect Notion.", true);
  settings = {
    ...DEFAULT_SETTINGS,
    oauthClientId: settings.oauthClientId,
    oauthBrokerUrl: settings.oauthBrokerUrl
  };
  $("#token").value = "";
  setConnectionState(false);
  setStage("connect");
  flash(response.warning || "Notion disconnected.", Boolean(response.warning));
}

async function finishSetup() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) await chrome.tabs.remove(tab.id);
    else window.close();
  } catch {
    window.close();
  }
}

async function showReady(outcome = lastProvisioningOutcome) {
  flash("Checking your Notion connection and destination…", false, true);
  const health = await chrome.runtime.sendMessage({ type: "VALIDATE_CONNECTION" }).catch((error) => ({ ok: false, error: error.message }));
  if (!health?.ready) {
    setStage("destination");
    showProvisioningState(false);
    flash(health?.error || "Quick Note could not verify this destination. Reconnect or choose another destination.", true, true);
    return;
  }
  hydrateWorkspace();
  $("#ready-workspace").textContent = settings.workspaceName || "Notion";
  $("#ready-destination").textContent = settings.destinationName || "Quick Notes";
  $("#ready-outcome").textContent = outcomeMessage(outcome);
  $("#open-destination").hidden = !settings.destinationUrl;
  $("#refresh-permissions").hidden = settings.authType !== "oauth" || !hasUsableOAuthConfig();
  setStage("ready");
  flash("");
}

function hasUsableOAuthConfig() {
  return hasBundledOAuthConfig(PRODUCT_CONFIG) || hasBundledOAuthConfig({
    notionClientId: settings.oauthClientId,
    oauthBrokerUrl: settings.oauthBrokerUrl
  });
}

async function openDestination() {
  if (!settings.destinationUrl) return;
  await chrome.tabs.create({ url: settings.destinationUrl });
}

function hydrateWorkspace() {
  $("#workspace-name").textContent = settings.workspaceName || "Notion";
  hydrateWorkspaceIcon($("#workspace-icon"), settings.workspaceIcon);
}

function hydrateWorkspaceIcon(element, icon) {
  if (icon && !/^https?:/i.test(icon)) {
    element.textContent = icon;
    return;
  }

  const image = document.createElement("img");
  image.src = "../assets/brand/notion-mark.svg";
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  element.replaceChildren(image);
}

function setStage(stage) {
  $("#connect-panel").hidden = stage !== "connect";
  $("#destination-panel").hidden = stage !== "destination";
  $("#ready-panel").hidden = stage !== "ready";
  document.querySelectorAll("[data-progress]").forEach((item) => {
    const steps = ["connect", "destination", "ready"];
    const itemIndex = steps.indexOf(item.dataset.progress);
    const activeIndex = steps.indexOf(stage);
    item.classList.toggle("active", itemIndex === activeIndex);
    item.classList.toggle("complete", itemIndex < activeIndex);
  });
}

function showProvisioningState(visible, copy = "") {
  $("#provisioning-state").hidden = !visible;
  $("#destination-picker").hidden = visible;
  if (copy) $("#provisioning-copy").textContent = copy;
  if (!visible) $("#create-database").hidden = Boolean(settings.destinationId);
}

function outcomeMessage(outcome) {
  const messages = {
    created: "Created a new private Quick Notes database with source metadata.",
    reused: "Recovered and reused your existing Quick Notes database.",
    migrated: "Upgraded your Quick Notes database with source metadata.",
    existing: "Your selected destination is ready."
  };
  return messages[outcome] || messages.existing;
}

function provisioningErrorMessage(response = {}) {
  const messages = {
    authentication: "Your Notion connection expired. Reconnect Notion to continue.",
    capability: "This connection cannot create databases. Enable Insert Content for the connection, or choose an existing destination below.",
    rate_limited: `Notion is handling too many requests. ${response.retryAfter ? `Try again in ${response.retryAfter} seconds, or ` : ""}choose an existing destination below.`,
    recovering: "Notion may still be creating your database. Wait a moment and retry; Quick Note will recover it instead of creating a duplicate.",
    transient: "Notion could not confirm database creation. Retry in a moment, or choose an existing destination below."
  };
  return messages[response.kind]
    || `${response.error || "Could not create the database."} You can retry or choose an existing destination.`;
}

function setConnectionState(connected) {
  const state = $("#connection-state");
  state.classList.toggle("connected", connected);
  state.textContent = connected
    ? `Connected${settings.workspaceName ? ` · ${settings.workspaceName}` : ""}`
    : "Not connected";
}

function toggleToken() {
  const token = $("#token");
  token.type = token.type === "password" ? "text" : "password";
  $("#reveal-token").textContent = token.type === "password" ? "Show" : "Hide";
}

function normalizeBrokerUrl(value = "") {
  return value.trim().replace(/\/$/, "");
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.lastElementChild && button.children.length > 1
    ? button.lastElementChild.textContent = label
    : button.textContent = label;
}

function flash(message, error = false, persist = false) {
  const element = $("#message");
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle("error", error);
  clearTimeout(flash.timeout);
  if (!persist && message) {
    flash.timeout = setTimeout(() => {
      element.hidden = true;
      element.textContent = "";
    }, 4500);
  }
}
