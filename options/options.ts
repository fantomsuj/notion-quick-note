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
  migrateLegacyOAuthCredentials,
  normalizeSettings
} from "../src/settings.js";
import {
  createShortcutSettingsController,
  type ShortcutSettingsState
} from "../src/shortcut-settings.js";
import type { CaptureRecord, DeliveryState, Destination, EditorNode, FailureResponse, RuntimeRequest, RuntimeResponse, Settings } from "../src/contracts.js";
import { sendRuntimeRequest } from "../src/runtime-message.js";

interface OptionsElements {
  "#token": HTMLInputElement;
  "#oauth-client-id": HTMLInputElement;
  "#oauth-broker-url": HTMLInputElement;
  "#include-source": HTMLInputElement;
  "#ai-enabled": HTMLInputElement;
  "#ai-suggest-title": HTMLInputElement;
  "#ai-extract-todos": HTMLInputElement;
  "#manual-destination-id": HTMLInputElement;
  "#manual-destination-name": HTMLInputElement;
  "#manual-title-property": HTMLInputElement;
  "#destination-search": HTMLInputElement;
  "#oauth-test-setup": HTMLDetailsElement;
  "#oauth-connect": HTMLButtonElement;
  "#oauth-connect-local": HTMLButtonElement;
  "#save-developer-config": HTMLButtonElement;
  "#use-token": HTMLButtonElement;
  "#reveal-token": HTMLButtonElement;
  "#create-database": HTMLButtonElement;
  "#refresh-destinations": HTMLButtonElement;
  "#empty-refresh": HTMLButtonElement;
  "#use-manual-destination": HTMLButtonElement;
  "#change-destination": HTMLButtonElement;
  "#change-connection": HTMLButtonElement;
  "#disconnect": HTMLButtonElement;
  "#finish": HTMLButtonElement;
  "#open-destination": HTMLButtonElement;
  "#refresh-permissions": HTMLButtonElement;
  "#change-shortcut": HTMLButtonElement;
  "#activity": HTMLDetailsElement;
  "#activity-status": HTMLElement;
  "#activity-content": HTMLElement;
  "#activity-incognito-note": HTMLElement;
  "#queue-count": HTMLElement;
  "#queue-list": HTMLElement;
  "#delivered-group": HTMLElement;
  "#delivered-list": HTMLElement;
  "#clear-delivered-history": HTMLButtonElement;
  "#storage-recovery": HTMLDetailsElement;
  "#diagnostics-status": HTMLElement;
  "#diagnostics-grid": HTMLElement;
  "#capture-bytes": HTMLElement;
  "#chrome-bytes": HTMLElement;
  "#origin-bytes": HTMLElement;
  "#record-counts": HTMLElement;
  "#storage-health": HTMLElement;
  "#persistence-state": HTMLElement;
  "#maintenance-time": HTMLElement;
  "#diagnostics-note": HTMLElement;
}

function $<S extends keyof OptionsElements>(selector: S): OptionsElements[S];
function $(selector: string): HTMLElement;
function $(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Quick Note options are missing required element: ${selector}`);
  return found;
}

let settings: Settings = { ...DEFAULT_SETTINGS };
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSequence = 0;
type ProvisioningOutcome = "created" | "reused" | "migrated" | "existing";
let lastProvisioningOutcome: ProvisioningOutcome = "existing";
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let activityRefreshTimer: ReturnType<typeof setTimeout> | undefined;

setupShortcutSettings();
init();

function setupShortcutSettings(): void {
  const status = $("#shortcut-assignment-status");
  const keycaps = $("#shortcut-keycaps");
  const warning = $("#shortcut-warning");
  const manualInstructions = $("#shortcut-manual-instructions");
  const changeButton = $("#change-shortcut");
  const controller = createShortcutSettingsController({
    commands: chrome.commands,
    tabs: chrome.tabs,
    focusSource: window,
    visibilitySource: document,
    view: {
      render(state: ShortcutSettingsState) {
        status.textContent = state.statusLabel;
        status.dataset.state = state.status;
        keycaps.setAttribute("aria-label", state.shortcut || state.statusLabel);
        if (state.keycaps.length) {
          keycaps.replaceChildren(...state.keycaps.map((label) => {
            const keycap = document.createElement("kbd");
            keycap.textContent = label;
            return keycap;
          }));
        } else {
          const empty = document.createElement("span");
          empty.className = "shortcut-unassigned";
          empty.textContent = state.status === "error" ? "Check assignment" : "No shortcut";
          keycaps.replaceChildren(empty);
        }
        warning.textContent = state.warning || "";
        warning.hidden = !state.warning;
      },
      showManualInstructions() {
        manualInstructions.hidden = false;
      }
    }
  });
  changeButton.addEventListener("click", () => controller.openEditor());
  void controller.start();
}

async function init(): Promise<void> {
  $("#extension-version").textContent = chrome.runtime.getManifest().version;
  const migration = await migrateLegacyOAuthCredentials(chrome.storage.local);
  settings = normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
  const reconnectRequired = migration.requiresReconnect
    || Boolean((await chrome.storage.local.get("oauthReconnectRequired")).oauthReconnectRequired);
  $("#personal-token-setup").hidden = hasBundledOAuthConfig(PRODUCT_CONFIG);
  $("#oauth-bundled-setup").hidden = !hasBundledOAuthConfig(PRODUCT_CONFIG);
  $("#oauth-test-setup").hidden = hasBundledOAuthConfig(PRODUCT_CONFIG);
  hydrateForm();
  bindEvents();
  setupActivityRecovery();
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

function hydrateForm(): void {
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

function bindEvents(): void {
  $("#oauth-connect").addEventListener("click", () => connectOAuth($("#oauth-connect")));
  $("#oauth-connect-local").addEventListener("click", () => connectOAuth($("#oauth-connect-local")));
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
  for (const [selector, key] of [["#ai-suggest-title", "aiSuggestTitle"], ["#ai-extract-todos", "aiExtractTodos"]] as const) {
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
  document.querySelectorAll<HTMLInputElement>("input[name=manual-destination-type]").forEach((radio) => {
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

function setupActivityRecovery(): void {
  $("#clear-delivered-history").addEventListener("click", clearDeliveredHistory);
  $("#storage-recovery").addEventListener("toggle", () => {
    if ($("#storage-recovery").open) void loadDiagnostics();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-export]").forEach((button) => {
    button.addEventListener("click", () => exportRecovery(button.dataset.export === "markdown" ? "markdown" : "json"));
  });
  chrome.storage.onChanged?.addListener(scheduleActivityRefresh);
  chrome.runtime.onMessage?.addListener((message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "CAPTURE_ACTIVITY_CHANGED") {
      scheduleActivityRefresh();
    }
  });
  window.addEventListener("hashchange", openActivityFromHash);
  void loadActivity();
  openActivityFromHash();
}

function openActivityFromHash(): void {
  if (location.hash !== "#activity") return;
  const section = $("#activity");
  section.open = true;
  requestAnimationFrame(() => {
    section.focus({ preventScroll: true });
    section.scrollIntoView({ block: "start" });
  });
  void loadActivity();
}

function scheduleActivityRefresh(): void {
  clearTimeout(activityRefreshTimer);
  activityRefreshTimer = setTimeout(() => {
    activityRefreshTimer = undefined;
    void loadActivity();
    if ($("#storage-recovery").open) void loadDiagnostics();
  }, 120);
}

async function loadActivity(): Promise<void> {
  const status = $("#activity-status");
  const content = $("#activity-content");
  status.hidden = false;
  status.textContent = "Loading delivery activity…";
  const response = await send({ type: "LIST_CAPTURE_ACTIVITY" });
  if (!response.ok) {
    content.hidden = true;
    status.textContent = response.error || "Couldn’t load local delivery activity.";
    return;
  }
  status.hidden = true;
  content.hidden = false;
  $("#activity-incognito-note").hidden = !response.incognito;
  $("#queue-count").textContent = String(response.queued.length);
  document.querySelector<HTMLElement>(".activity-summary-count")!.textContent = response.queued.length
    ? `${response.queued.length} waiting`
    : "All delivered";
  renderActivityList($("#queue-list"), response.queued, "Everything is delivered");
  $("#delivered-group").hidden = !response.delivered.length;
  renderActivityList($("#delivered-list"), response.delivered, "No recent deliveries");
}

function renderActivityList(container: HTMLElement, records: CaptureRecord[], emptyText: string): void {
  container.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  container.append(...records.map(renderActivityCard));
}

function renderActivityCard(record: CaptureRecord): HTMLElement {
  const capture = record.pendingCapture || record.syncedCapture || record.capture;
  const card = document.createElement("article");
  card.className = "activity-card";
  const heading = document.createElement("h3");
  heading.textContent = capture.document.title || documentPreview(capture.document.doc) || "Untitled note";
  const metadata = document.createElement("p");
  metadata.className = "activity-card-meta";
  metadata.textContent = `${deliveryStateLabel(record.status)} · ${record.destination?.destinationName || "Waiting for setup"} · ${relativeTime(record.updatedAt)}`;
  card.append(heading, metadata);
  const preview = documentPreview(capture.document.doc);
  if (preview) {
    const excerpt = document.createElement("p");
    excerpt.className = "activity-card-preview";
    excerpt.textContent = preview;
    card.append(excerpt);
  }
  if (record.lastError?.message) {
    const error = document.createElement("p");
    error.className = "activity-card-error";
    error.textContent = record.lastError.message;
    card.append(error);
  }
  const actions = document.createElement("div");
  actions.className = "activity-card-actions";
  addCaptureActions(actions, record);
  if (actions.childElementCount) card.append(actions);
  return card;
}

function addCaptureActions(actions: HTMLElement, record: CaptureRecord): void {
  const addAction = (label: string, handler: () => Promise<void>) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => void handler());
    actions.append(button);
  };
  if (record.status === "delivered") {
    addAction("Open in Notion", () => runActivityAction({ type: "OPEN_CAPTURE_RESULT", id: record.id }));
    addAction("Delete local history", () => runActivityAction({ type: "DELETE_CAPTURE", id: record.id }));
    return;
  }
  if (["blocked_destination", "blocked_auth"].includes(record.status)) {
    addAction("Retarget", () => runActivityAction({ type: "RETARGET_CAPTURE", id: record.id }));
  }
  if (record.status === "blocked_conflict") {
    if (record.remote?.url) addAction("Open in Notion", () => runActivityAction({ type: "OPEN_CAPTURE_RESULT", id: record.id }));
    addAction("Prepare local edit", () => prepareConflictReview(record.id));
    return;
  }
  if (record.status === "uncertain") {
    const remote = record.remote;
    if (remote) addAction("Mark delivered", () => runActivityAction({ type: "MARK_CAPTURE_DELIVERED", id: record.id, remote }));
    addAction("Retry anyway", async () => {
      if (!confirm("Notion may already contain this capture. Retry anyway and accept the duplicate risk?")) return;
      await runActivityAction({ type: "RETRY_CAPTURE", id: record.id, force: true });
    });
    return;
  }
  if (record.status !== "blocked_setup") {
    addAction("Retry", () => runActivityAction({ type: "RETRY_CAPTURE", id: record.id }));
  }
}

async function prepareConflictReview(id: string): Promise<void> {
  const response = await send({ type: "LOAD_RECENT_NOTE", id });
  if (!response.ok) {
    flash(response.error || "Couldn’t prepare the local edit.", true);
    return;
  }
  flash("Local edit prepared. Open Quick Note on a regular web page to continue.");
  await loadActivity();
}

async function runActivityAction<T extends RuntimeRequest>(message: T): Promise<void> {
  const response = await send(message);
  if (!response.ok) {
    flash(("error" in response ? response.error : "") || "That delivery action didn’t complete.", true);
    return;
  }
  await loadActivity();
}

async function clearDeliveredHistory(): Promise<void> {
  if (!confirm("Clear all delivered capture history stored on this device? This does not delete pages from Notion.")) return;
  const response = await send({ type: "DELETE_DELIVERED_HISTORY" });
  if (!response.ok) return flash(response.error || "Couldn’t clear delivered history.", true);
  flash(response.deleted ? `Cleared ${response.deleted} delivered ${response.deleted === 1 ? "capture" : "captures"}.` : "No delivered history to clear.");
  await loadActivity();
}

async function loadDiagnostics(): Promise<void> {
  const status = $("#diagnostics-status");
  const grid = $("#diagnostics-grid");
  status.textContent = "Checking storage…";
  status.dataset.tone = "";
  const response = await send({ type: "GET_STORAGE_DIAGNOSTICS" });
  if (!response.ok) {
    grid.hidden = true;
    status.textContent = response.error || "Couldn’t inspect local storage.";
    status.dataset.tone = "error";
    return;
  }
  const diagnostics = response.diagnostics;
  status.textContent = diagnostics.profile === "incognito" ? "Incognito session storage" : "Regular profile storage";
  grid.hidden = false;
  $("#capture-bytes").textContent = formatBytes(diagnostics.captureStorage.logicalBytes);
  $("#chrome-bytes").textContent = diagnostics.chromeStorage.quotaBytes
    ? `${formatBytes(diagnostics.chromeStorage.usedBytes)} of ${formatBytes(diagnostics.chromeStorage.quotaBytes)}`
    : formatBytes(diagnostics.chromeStorage.usedBytes);
  $("#origin-bytes").textContent = diagnostics.originStorage.quotaBytes
    ? `${formatBytes(diagnostics.originStorage.usedBytes)} of ${formatBytes(diagnostics.originStorage.quotaBytes)}`
    : "Unavailable";
  $("#record-counts").textContent = `${diagnostics.captureStorage.drafts} drafts · ${diagnostics.captureStorage.queued} queued · ${diagnostics.captureStorage.delivered} delivered`;
  $("#storage-health").textContent = diagnostics.migrationStatus === "warning"
    ? "Migration needs attention"
    : `${diagnostics.backend} · schema ${diagnostics.schemaVersion}`;
  $("#persistence-state").textContent = diagnostics.profile === "incognito"
    ? "Session only"
    : diagnostics.persistent ? "Granted" : "Browser managed";
  $("#maintenance-time").textContent = diagnostics.lastMaintenanceAt
    ? new Date(diagnostics.lastMaintenanceAt).toLocaleString()
    : "Not run yet";
  const note = $("#diagnostics-note");
  note.textContent = diagnostics.migrationError || (diagnostics.profile === "incognito"
    ? "These records are cleared when this Incognito extension session ends."
    : diagnostics.persistent ? "Chrome has granted persistent origin storage." : "Chrome manages IndexedDB persistence for this profile.");
  note.dataset.tone = diagnostics.migrationError ? "error" : "";
}

async function exportRecovery(format: "json" | "markdown"): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`[data-export="${format}"]`);
  if (!button) throw new Error("Quick Note recovery export button is missing.");
  const label = button.textContent || "Export";
  button.disabled = true;
  button.textContent = "Preparing…";
  const response = await send({ type: "EXPORT_CAPTURE_RECOVERY", format });
  button.disabled = false;
  button.textContent = label;
  if (!response.ok) return flash(response.error || "Couldn’t create the recovery export.", true);
  const blob = new Blob([response.export.content], { type: `${response.export.mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = response.export.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  flash(`${format === "json" ? "JSON" : "Markdown"} recovery exported.`);
}

function documentPreview(node: EditorNode | undefined): string {
  return truncateText(documentText(node).replace(/\s+/g, " ").trim(), 220);
}

function documentText(node: EditorNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(documentText).join(node.type === "doc" ? "\n" : "");
}

function truncateText(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length > limit ? `${characters.slice(0, limit).join("").trimEnd()}…` : value;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function deliveryStateLabel(status: DeliveryState): string {
  const labels: Record<DeliveryState, string> = {
    pending: "Queued",
    sending: "Sending",
    delivered: "Delivered",
    blocked_setup: "Connect required",
    blocked_auth: "Reconnect required",
    blocked_destination: "Destination needs attention",
    blocked_conflict: "Notion changed—review required",
    uncertain: "Review required"
  };
  return labels[status];
}

function updateAiControls(): void {
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

async function connectOAuth(button: HTMLButtonElement): Promise<void> {
  const clientId = PRODUCT_CONFIG.notionClientId || $("#oauth-client-id").value.trim();
  const brokerUrl = PRODUCT_CONFIG.oauthBrokerUrl || normalizeBrokerUrl($("#oauth-broker-url").value);
  if (!clientId || !brokerUrl) {
    $("#oauth-test-setup").open = true;
    return flash("Add a client ID and broker URL to test OAuth.", true);
  }

  const idleLabel = button === $("#refresh-permissions")
    ? "Grant access to more pages"
    : button === $("#oauth-connect-local")
      ? "Test OAuth"
      : "Connect Notion";
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
    ] as const) {
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
  } catch (error: unknown) {
    flash(errorMessage(error), true);
  } finally {
    await chrome.storage.session.remove("oauthState");
    setBusy(button, false, idleLabel);
  }
}

type OAuthExchange = Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
type PreviousConnection = { token: string; connectionHandle: string; botId: string; brokerUrl: string } | null;

async function retireReplacedConnection(previous: PreviousConnection, next: OAuthExchange, fallbackBrokerUrl: string): Promise<void> {
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

interface AuthorizationConnection {
  authType: "oauth" | "token";
  token: string;
  connectionHandle: string;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string;
  botId: string;
  oauthClientId?: string;
  oauthBrokerUrl?: string;
}

async function storeConnection(connection: AuthorizationConnection): Promise<{ connectionId: string; preservedDestination: boolean }> {
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
    destinationType: "database" as const,
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
  let response: RuntimeResponse<Extract<RuntimeRequest, { type: "ENSURE_DEFAULT_DATABASE" }>>;
  try {
    response = await send({ type: "ENSURE_DEFAULT_DATABASE" });
  } catch (error: unknown) {
    response = { ok: false, error: errorMessage(error) };
  }

  if (!response?.ok) {
    showProvisioningState(false);
    setBusy($("#create-database"), false, "Create Quick Notes database");
    flash(provisioningErrorMessage(response), true, true);
    await loadDestinations();
    return;
  }

  settings = normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
  lastProvisioningOutcome = isProvisioningOutcome(response.outcome) ? response.outcome : "existing";
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

async function loadDestinations(query = $("#destination-search").value): Promise<void> {
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

  let response: RuntimeResponse<Extract<RuntimeRequest, { type: "SEARCH_DESTINATIONS" }>>;
  try {
    response = await send({ type: "SEARCH_DESTINATIONS", query });
  } catch (error: unknown) {
    response = { ok: false, error: errorMessage(error) };
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
    icon.textContent = destination.icon || "↳";
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

async function chooseDestination(destination: Destination): Promise<void> {
  flash("Checking destination access…", false, true);
  const validation = await send({
    type: "VALIDATE_DESTINATION",
    destination
  });
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

function updateManualDestinationType(): void {
  const type = requiredRadioValue();
  $("#manual-title-property-wrap").hidden = type !== "database";
}

async function useManualDestination() {
  const id = $("#manual-destination-id").value.trim();
  if (!id) return flash("Paste a Notion destination URL or ID first.", true);
  const type = requiredRadioValue();
  await chooseDestination({
    id,
    type,
    name: $("#manual-destination-name").value.trim() || (type === "database" ? "Quick Notes" : "Notion Inbox"),
    titleProperty: $("#manual-title-property").value.trim() || "Name"
  });
}

async function disconnect() {
  if (!confirm("Disconnect this Notion workspace? Your saved notes will not be changed.")) return;
  let response = await send({ type: "DISCONNECT_NOTION" });
  if (!response.ok && "requiresConfirmation" in response && response.requiresConfirmation) {
    const count = response.pendingCount || 0;
    if (!confirm(`${count} capture${count === 1 ? " is" : "s are"} still waiting locally. Disconnect and keep ${count === 1 ? "it" : "them"} blocked until you reconnect or retarget?`)) return;
    response = await send({ type: "DISCONNECT_NOTION", confirmed: true });
  }
  if (!response.ok) return flash("error" in response ? response.error : "Could not disconnect Notion.", true);
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

async function showReady(outcome: ProvisioningOutcome = lastProvisioningOutcome): Promise<void> {
  flash("Checking your Notion connection and destination…", false, true);
  const health = await send({ type: "VALIDATE_CONNECTION" });
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

function hydrateWorkspaceIcon(element: HTMLElement, icon: string): void {
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

type SetupStage = "connect" | "destination" | "ready";

function setStage(stage: SetupStage): void {
  $("#connect-panel").hidden = stage !== "connect";
  $("#destination-panel").hidden = stage !== "destination";
  $("#ready-panel").hidden = stage !== "ready";
  document.querySelectorAll<HTMLElement>("[data-progress]").forEach((item) => {
    const steps: SetupStage[] = ["connect", "destination", "ready"];
    const progress = item.dataset.progress;
    const itemIndex = progress === "connect" || progress === "destination" || progress === "ready" ? steps.indexOf(progress) : -1;
    const activeIndex = steps.indexOf(stage);
    item.classList.toggle("active", itemIndex === activeIndex);
    item.classList.toggle("complete", itemIndex < activeIndex);
  });
}

function showProvisioningState(visible: boolean, copy = ""): void {
  $("#provisioning-state").hidden = !visible;
  $("#destination-picker").hidden = visible;
  if (copy) $("#provisioning-copy").textContent = copy;
  if (!visible) $("#create-database").hidden = Boolean(settings.destinationId);
}

function outcomeMessage(outcome: ProvisioningOutcome): string {
  const messages: Record<ProvisioningOutcome, string> = {
    created: "Created a new private Quick Notes database with source metadata.",
    reused: "Recovered and reused your existing Quick Notes database.",
    migrated: "Upgraded your Quick Notes database with source metadata.",
    existing: "Your selected destination is ready."
  };
  return messages[outcome] || messages.existing;
}

function provisioningErrorMessage(response: FailureResponse): string {
  const messages = {
    authentication: "Your Notion connection expired. Reconnect Notion to continue.",
    capability: "This connection cannot create databases. Enable Insert Content for the connection, or choose an existing destination below.",
    rate_limited: `Notion is handling too many requests. ${response.retryAfter ? `Try again in ${response.retryAfter} seconds, or ` : ""}choose an existing destination below.`,
    recovering: "Notion may still be creating your database. Wait a moment and retry; Quick Note will recover it instead of creating a duplicate.",
    transient: "Notion could not confirm database creation. Retry in a moment, or choose an existing destination below."
  };
  return (response.kind ? messages[response.kind as keyof typeof messages] : undefined)
    || `${response.error || "Could not create the database."} You can retry or choose an existing destination.`;
}

function setConnectionState(connected: boolean): void {
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

function normalizeBrokerUrl(value = ""): string {
  return value.trim().replace(/\/$/, "");
}

function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  button.disabled = busy;
  button.lastElementChild && button.children.length > 1
    ? button.lastElementChild.textContent = label
    : button.textContent = label;
}

function flash(message: string, error = false, persist = false): void {
  const element = $("#message");
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle("error", error);
  clearTimeout(flashTimer);
  if (!persist && message) {
    flashTimer = setTimeout(() => {
      element.hidden = true;
      element.textContent = "";
    }, 4500);
  }
}

async function send<T extends RuntimeRequest>(message: T): Promise<RuntimeResponse<T>> {
  try {
    return await sendRuntimeRequest(message);
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) };
  }
}

function requiredRadioValue(): "page" | "database" {
  const radio = document.querySelector<HTMLInputElement>("input[name=manual-destination-type]:checked");
  if (!radio || (radio.value !== "page" && radio.value !== "database")) throw new Error("Choose a destination type.");
  return radio.value;
}

function isProvisioningOutcome(value: string): value is ProvisioningOutcome {
  return value === "created" || value === "reused" || value === "migrated" || value === "existing";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
