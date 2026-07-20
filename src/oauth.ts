// @ts-nocheck
import { getDefaultOAuthDeviceKeyStore } from "./oauth-device.js";

const INVALID_TOKEN_RESPONSE = "Notion returned an invalid token response. Reconnect Notion to continue.";

function normalizeBrokerUrl(value = "") {
  return value.trim().replace(/\/$/, "");
}

async function brokerRequest(brokerUrl, path, body, fetchImpl = fetch) {
  const baseUrl = normalizeBrokerUrl(brokerUrl);
  if (!baseUrl) throw new Error("OAuth is not configured for this build yet.");

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(stringValue(payload?.error) || `Authentication failed (${response.status}).`);
    error.status = response.status;
    error.code = stringValue(payload?.code);
    throw error;
  }
  if (!isRecord(payload)) throw new Error("The authentication service returned an invalid response.");
  return payload;
}

export async function beginAuthorization({
  brokerUrl,
  redirectUri,
  fetchImpl = fetch,
  keyStore,
  cryptoImpl = globalThis.crypto
}) {
  requireString(redirectUri, "The OAuth redirect URI is missing.");
  const keyPair = await (keyStore || getDefaultOAuthDeviceKeyStore()).getOrCreateKeyPair();
  const publicKey = await cryptoImpl.subtle.exportKey("jwk", keyPair.publicKey);
  validatePublicKey(publicKey);
  const payload = await brokerRequest(brokerUrl, "/start", {
    redirect_uri: redirectUri,
    public_key: publicKey
  }, fetchImpl);
  return { state: requirePayloadString(payload, "state", "The authentication service returned an invalid state.") };
}

export async function exchangeAuthorizationCode({ brokerUrl, code, redirectUri, state, fetchImpl = fetch }) {
  requireString(code, "Notion did not return an authorization code.");
  requireString(redirectUri, "The OAuth redirect URI is missing.");
  requireString(state, "The OAuth state is missing. Start the connection again.");

  const payload = await brokerRequest(brokerUrl, "/exchange", {
    code,
    redirect_uri: redirectUri,
    state
  }, fetchImpl);
  validateExchangePayload(payload);
  const { refresh_token: _discardedRefreshToken, ...safePayload } = payload;
  return safePayload;
}

export async function refreshAccessToken({
  brokerUrl,
  connectionHandle,
  fetchImpl = fetch,
  keyStore,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  nonceGenerator
}) {
  requireString(connectionHandle, "Reconnect Notion to continue.");
  const proof = await createDeviceProof({
    path: "/refresh",
    connectionHandle,
    token: "",
    keyStore,
    cryptoImpl,
    now,
    nonceGenerator
  });
  const payload = await brokerRequest(brokerUrl, "/refresh", {
    connection_handle: connectionHandle,
    ...proof
  }, fetchImpl);
  requirePayloadString(payload, "access_token", INVALID_TOKEN_RESPONSE);
  return payload;
}

export async function revokeAccessToken({
  brokerUrl,
  connectionHandle,
  token,
  fetchImpl = fetch,
  keyStore,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  nonceGenerator
}) {
  if (!token) return {};
  requireString(connectionHandle, "The Notion connection is missing. Disconnect locally and reconnect.");
  const proof = await createDeviceProof({
    path: "/revoke",
    connectionHandle,
    token,
    keyStore,
    cryptoImpl,
    now,
    nonceGenerator
  });
  return brokerRequest(brokerUrl, "/revoke", {
    connection_handle: connectionHandle,
    token,
    ...proof
  }, fetchImpl);
}

export async function retireOAuthConnection({
  brokerUrl,
  connectionHandle,
  fetchImpl = fetch,
  keyStore,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  nonceGenerator
}) {
  if (!connectionHandle) return {};
  const proof = await createDeviceProof({
    path: "/retire",
    connectionHandle,
    token: "",
    keyStore,
    cryptoImpl,
    now,
    nonceGenerator
  });
  return brokerRequest(brokerUrl, "/retire", {
    connection_handle: connectionHandle,
    ...proof
  }, fetchImpl);
}

export function createAccessTokenRefresher({
  loadSettings,
  saveSettings,
  brokerUrlForSettings,
  fetchImpl = fetch,
  keyStore,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  nonceGenerator
}) {
  let activePromise;

  return async function refreshStoredToken(staleSettings = {}) {
    const currentSettings = await loadSettings();
    if (staleSettings.token && currentSettings.token && staleSettings.token !== currentSettings.token) {
      return currentSettings;
    }

    if (!activePromise) {
      activePromise = refresh(currentSettings).finally(() => {
        activePromise = undefined;
      });
    }
    return activePromise;
  };

  async function refresh(settings) {
    const payload = await refreshAccessToken({
      brokerUrl: brokerUrlForSettings(settings),
      connectionHandle: settings.connectionHandle,
      fetchImpl,
      keyStore,
      cryptoImpl,
      now,
      nonceGenerator
    });

    const latest = await loadSettings();
    const connectionChanged = latest.connectionId !== settings.connectionId
      || latest.connectionHandle !== settings.connectionHandle
      || latest.token !== settings.token;
    if (connectionChanged) {
      const error = new Error("The Notion connection changed while its token was refreshing.");
      error.status = 401;
      error.code = "connection_changed";
      throw error;
    }

    const updated = { token: payload.access_token };
    await saveSettings(updated);
    return { ...settings, ...updated };
  }
}

async function createDeviceProof({
  path,
  connectionHandle,
  token,
  keyStore,
  cryptoImpl,
  now,
  nonceGenerator
}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("Secure device cryptography is unavailable in this browser.");
  }
  const timestamp = String(now());
  if (!/^\d+$/.test(timestamp)) throw new Error("Could not create a valid authentication timestamp.");
  const nonce = nonceGenerator ? await nonceGenerator() : randomNonce(cryptoImpl);
  requireString(nonce, "Could not create a valid authentication nonce.");
  const message = [path, connectionHandle, timestamp, nonce, token].join("\n");
  const keyPair = await (keyStore || getDefaultOAuthDeviceKeyStore()).getOrCreateKeyPair();
  const signatureBytes = await cryptoImpl.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(message)
  );
  return { timestamp, nonce, signature: base64UrlEncode(new Uint8Array(signatureBytes)) };
}

function randomNonce(cryptoImpl) {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validateExchangePayload(payload) {
  requirePayloadString(payload, "access_token", INVALID_TOKEN_RESPONSE);
  requirePayloadString(payload, "connection_handle", INVALID_TOKEN_RESPONSE);
  requirePayloadString(payload, "bot_id", INVALID_TOKEN_RESPONSE);
  requirePayloadString(payload, "workspace_id", INVALID_TOKEN_RESPONSE);
}

function validatePublicKey(value) {
  if (!isRecord(value)
    || value.kty !== "EC"
    || value.crv !== "P-256"
    || !stringValue(value.x)
    || !stringValue(value.y)
    || "d" in value) {
    throw new Error("Could not create a valid OAuth device key.");
  }
}

function requirePayloadString(payload, field, message) {
  const value = stringValue(payload?.[field]);
  if (!value) throw new Error(message);
  return value;
}

function requireString(value, message) {
  if (!stringValue(value)) throw new Error(message);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
