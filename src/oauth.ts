import { getDefaultOAuthDeviceKeyStore } from "./oauth-device.js";
import type { OAuthDeviceKeyStore } from "./oauth-device.js";

const INVALID_TOKEN_RESPONSE = "Notion returned an invalid token response. Reconnect Notion to continue.";

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<FetchResponse>;
type NonceGenerator = () => string | Promise<string>;
type TimeSource = () => number;

interface OAuthPorts {
  fetchImpl?: OAuthFetch | undefined;
  keyStore?: OAuthDeviceKeyStore | undefined;
  cryptoImpl?: Crypto | undefined;
  now?: TimeSource | undefined;
  nonceGenerator?: NonceGenerator | undefined;
}

interface BrokerConfig {
  brokerUrl: string;
}

interface ExchangePayload {
  access_token: string;
  connection_handle: string;
  bot_id: string;
  workspace_id: string;
  workspace_name?: string;
  workspace_icon?: string;
  refresh_token?: never;
}

interface RefreshPayload {
  access_token: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string;
  workspace_icon?: string;
}

interface RefreshableSettings {
  connectionId: string;
  connectionHandle: string;
  token: string;
  [key: string]: unknown;
}

export class OAuthRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "",
    readonly retryAfter = 0,
    readonly retryable = false
  ) {
    super(message);
    this.name = "OAuthRequestError";
  }
}

function normalizeBrokerUrl(value = ""): string {
  return value.trim().replace(/\/$/, "");
}

async function brokerRequest(
  brokerUrl: string,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: OAuthFetch = fetch
): Promise<Record<string, unknown>> {
  const baseUrl = normalizeBrokerUrl(brokerUrl);
  if (!baseUrl) throw new Error("OAuth is not configured for this build yet.");

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorPayload = isRecord(payload) ? payload : {};
    const retryAfter = numberValue(errorPayload.retry_after)
      || numberValue(errorPayload.retryAfter)
      || numberValue(response.headers?.get("Retry-After"));
    throw new OAuthRequestError(
      stringValue(errorPayload.error) || `Authentication failed (${response.status}).`,
      response.status,
      stringValue(errorPayload.code),
      retryAfter,
      errorPayload.retryable === true || response.status === 429 || response.status >= 500
    );
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
}: BrokerConfig & OAuthPorts & { redirectUri: string }): Promise<{ state: string }> {
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

export async function exchangeAuthorizationCode({
  brokerUrl,
  code,
  redirectUri,
  state,
  fetchImpl = fetch
}: BrokerConfig & Pick<OAuthPorts, "fetchImpl"> & {
  code: string;
  redirectUri: string;
  state?: string;
}): Promise<ExchangePayload> {
  requireString(code, "Notion did not return an authorization code.");
  requireString(redirectUri, "The OAuth redirect URI is missing.");
  requireString(state, "The OAuth state is missing. Start the connection again.");

  const payload = await brokerRequest(brokerUrl, "/exchange", {
    code,
    redirect_uri: redirectUri,
    state
  }, fetchImpl);
  return validateExchangePayload(payload);
}

export async function refreshAccessToken({
  brokerUrl,
  connectionHandle,
  fetchImpl = fetch,
  keyStore,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  nonceGenerator = () => randomNonce(cryptoImpl)
}: BrokerConfig & OAuthPorts & { connectionHandle: string }): Promise<RefreshPayload> {
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
  return validateRefreshPayload(payload);
}

export async function revokeAccessToken({
  brokerUrl,
  connectionHandle,
  token,
  fetchImpl = fetch,
  keyStore,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  nonceGenerator = () => randomNonce(cryptoImpl)
}: BrokerConfig & OAuthPorts & { connectionHandle: string; token: string }): Promise<Record<string, unknown>> {
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
  nonceGenerator = () => randomNonce(cryptoImpl)
}: BrokerConfig & OAuthPorts & { connectionHandle: string }): Promise<Record<string, unknown>> {
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

export function createAccessTokenRefresher<T extends RefreshableSettings>({
  loadSettings,
  saveSettings,
  brokerUrlForSettings,
  fetchImpl = fetch,
  keyStore,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  nonceGenerator = () => randomNonce(cryptoImpl)
}: OAuthPorts & {
  loadSettings: () => Promise<T>;
  saveSettings: (values: { token: string }) => Promise<void>;
  brokerUrlForSettings: (settings: T) => string;
}): (staleSettings?: Partial<T>) => Promise<T> {
  let activePromise: Promise<T> | undefined;

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

  async function refresh(settings: T): Promise<T> {
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
      throw new OAuthRequestError(
        "The Notion connection changed while its token was refreshing.",
        401,
        "connection_changed"
      );
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
}: {
  path: "/refresh" | "/revoke" | "/retire";
  connectionHandle: string;
  token: string;
  keyStore: OAuthDeviceKeyStore | undefined;
  cryptoImpl: Crypto;
  now: TimeSource;
  nonceGenerator: NonceGenerator;
}): Promise<{ timestamp: string; nonce: string; signature: string }> {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("Secure device cryptography is unavailable in this browser.");
  }
  const timestamp = String(now());
  if (!/^\d+$/.test(timestamp)) throw new Error("Could not create a valid authentication timestamp.");
  const nonce = await nonceGenerator();
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

function randomNonce(cryptoImpl: Crypto): string {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validateExchangePayload(payload: Record<string, unknown>): ExchangePayload {
  const accessToken = requirePayloadString(payload, "access_token", INVALID_TOKEN_RESPONSE);
  const connectionHandle = requirePayloadString(payload, "connection_handle", INVALID_TOKEN_RESPONSE);
  const botId = requirePayloadString(payload, "bot_id", INVALID_TOKEN_RESPONSE);
  const workspaceId = requirePayloadString(payload, "workspace_id", INVALID_TOKEN_RESPONSE);
  validateOptionalString(payload, "workspace_name", INVALID_TOKEN_RESPONSE);
  validateOptionalString(payload, "workspace_icon", INVALID_TOKEN_RESPONSE);
  return {
    access_token: accessToken,
    connection_handle: connectionHandle,
    bot_id: botId,
    workspace_id: workspaceId,
    ...(typeof payload.workspace_name === "string" ? { workspace_name: payload.workspace_name } : {}),
    ...(typeof payload.workspace_icon === "string" ? { workspace_icon: payload.workspace_icon } : {})
  };
}

function validateRefreshPayload(payload: Record<string, unknown>): RefreshPayload {
  const accessToken = requirePayloadString(payload, "access_token", INVALID_TOKEN_RESPONSE);
  for (const field of ["bot_id", "workspace_id", "workspace_name", "workspace_icon"]) {
    validateOptionalString(payload, field, INVALID_TOKEN_RESPONSE);
  }
  return {
    access_token: accessToken,
    ...(typeof payload.bot_id === "string" ? { bot_id: payload.bot_id } : {}),
    ...(typeof payload.workspace_id === "string" ? { workspace_id: payload.workspace_id } : {}),
    ...(typeof payload.workspace_name === "string" ? { workspace_name: payload.workspace_name } : {}),
    ...(typeof payload.workspace_icon === "string" ? { workspace_icon: payload.workspace_icon } : {})
  };
}

function validatePublicKey(value: unknown): asserts value is JsonWebKey {
  if (!isRecord(value)
    || value.kty !== "EC"
    || value.crv !== "P-256"
    || !stringValue(value.x)
    || !stringValue(value.y)
    || "d" in value) {
    throw new Error("Could not create a valid OAuth device key.");
  }
}

function requirePayloadString(payload: Record<string, unknown>, field: string, message: string): string {
  const value = stringValue(payload[field]);
  if (!value) throw new Error(message);
  return value;
}

function validateOptionalString(payload: Record<string, unknown>, field: string, message: string): void {
  if (field in payload && payload[field] !== undefined && typeof payload[field] !== "string") throw new Error(message);
}

function requireString(value: unknown, message: string): void {
  if (!stringValue(value)) throw new Error(message);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
