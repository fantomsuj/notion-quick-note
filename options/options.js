const DEFAULTS = {
  authType: "token",
  token: "",
  destinationType: "page",
  destinationId: "",
  destinationName: "Notion Inbox",
  titleProperty: "Name",
  includeSource: true,
  oauthClientId: "",
  oauthBrokerUrl: ""
};

const $ = (selector) => document.querySelector(selector);
let authType = "token";

init();

async function init() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  authType = settings.authType;
  $("#token").value = settings.token;
  $("#oauth-client-id").value = settings.oauthClientId;
  $("#oauth-broker-url").value = settings.oauthBrokerUrl;
  $("#destination-id").value = settings.destinationId;
  $("#destination-name").value = settings.destinationName;
  $("#title-property").value = settings.titleProperty;
  $("#include-source").checked = settings.includeSource;

  document.querySelector(`input[name=destination-type][value=${settings.destinationType}]`).checked = true;
  setDestinationType(settings.destinationType);
  setAuthType(authType);
  setConnectionState(Boolean(settings.token));

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => setAuthType(tab.dataset.auth)));
  document.querySelectorAll("input[name=destination-type]").forEach((radio) => radio.addEventListener("change", () => setDestinationType(radio.value)));
  $("#reveal-token").addEventListener("click", toggleToken);
  $("#save").addEventListener("click", save);
  $("#oauth-connect").addEventListener("click", connectOAuth);
}

function setAuthType(type) {
  authType = type;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.auth === type));
  $("#token-panel").hidden = type !== "token";
  $("#oauth-panel").hidden = type !== "oauth";
}

function setDestinationType(type) {
  document.querySelectorAll(".choice").forEach((choice) => {
    choice.classList.toggle("selected", choice.querySelector("input").value === type);
  });
  $("#title-property-wrap").hidden = type !== "database";
  $("#destination-id-label").textContent = type === "database" ? "Notion data source URL or ID" : "Notion page URL or ID";
  $("#destination-id").placeholder = type === "database" ? "Paste a data source ID" : "Paste a Notion page URL or ID";
}

function toggleToken() {
  const token = $("#token");
  token.type = token.type === "password" ? "text" : "password";
  $("#reveal-token").textContent = token.type === "password" ? "Show" : "Hide";
}

async function save() {
  const destinationType = $("input[name=destination-type]:checked").value;
  const settings = {
    authType,
    token: $("#token").value.trim(),
    oauthClientId: $("#oauth-client-id").value.trim(),
    oauthBrokerUrl: $("#oauth-broker-url").value.trim().replace(/\/$/, ""),
    destinationType,
    destinationId: $("#destination-id").value.trim(),
    destinationName: $("#destination-name").value.trim() || "Notion Inbox",
    titleProperty: $("#title-property").value.trim() || "Name",
    includeSource: $("#include-source").checked
  };
  await chrome.storage.local.set(settings);
  setConnectionState(Boolean(settings.token));
  flash("Settings saved");
}

async function connectOAuth() {
  const clientId = $("#oauth-client-id").value.trim();
  const brokerUrl = $("#oauth-broker-url").value.trim().replace(/\/$/, "");
  if (!clientId || !brokerUrl) return flash("Add a client ID and broker URL first", true);

  try {
    const origin = `${new URL(brokerUrl).origin}/*`;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error("Permission to contact the OAuth broker was declined.");

    const redirectUri = chrome.identity.getRedirectURL("notion");
    const state = crypto.randomUUID();
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
    if (callback.searchParams.get("state") !== state) throw new Error("OAuth state did not match.");
    const code = callback.searchParams.get("code");
    if (!code) throw new Error(callback.searchParams.get("error") || "No authorization code was returned.");

    const response = await fetch(`${brokerUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirectUri })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Token exchange failed.");

    $("#token").value = payload.access_token;
    await chrome.storage.local.set({
      authType: "oauth",
      token: payload.access_token,
      refreshToken: payload.refresh_token,
      workspaceName: payload.workspace_name,
      oauthClientId: clientId,
      oauthBrokerUrl: brokerUrl
    });
    setConnectionState(true, payload.workspace_name);
    flash(`Connected${payload.workspace_name ? ` to ${payload.workspace_name}` : ""}`);
  } catch (error) {
    flash(error.message, true);
  }
}

function setConnectionState(connected, workspace = "") {
  const state = $("#connection-state");
  state.classList.toggle("connected", connected);
  state.textContent = connected ? `Connected${workspace ? ` · ${workspace}` : ""}` : "Not connected";
}

function flash(message, error = false) {
  $("#message").textContent = message;
  $("#message").style.color = error ? "#d70015" : "#248a3d";
  clearTimeout(flash.timeout);
  flash.timeout = setTimeout(() => { $("#message").textContent = ""; }, 4500);
}
