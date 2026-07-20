export interface OAuthWorkerEnv {
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  ALLOWED_EXTENSION_IDS?: string;
  ALLOWED_ORIGINS?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  NOTION_REQUEST_TIMEOUT_MS?: string;
  OAUTH_SESSIONS?: OAuthSessionNamespace;
  OAUTH_RATE_LIMITER?: OAuthRateLimiter;
  FETCH?: WorkerFetch;
}

export interface ConfiguredOAuthWorkerEnv extends OAuthWorkerEnv {
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  ALLOWED_EXTENSION_IDS: string;
  ALLOWED_ORIGINS: string;
  TOKEN_ENCRYPTION_KEY: string;
  OAUTH_SESSIONS: OAuthSessionNamespace;
  OAUTH_RATE_LIMITER: OAuthRateLimiter;
}

export type WorkerFetch = (input: string | URL | Request, init: RequestInit) => Promise<Response>;
export type OAuthSessionId = string | DurableObjectId;

export interface OAuthSessionNamespace {
  idFromName(name: string): OAuthSessionId;
  get(id: OAuthSessionId): OAuthSessionStub;
}

export interface OAuthRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface OAuthSessionStub extends Rpc.DurableObjectBranded {
  fetch(request: Request): Promise<Response>;
}

export interface DeviceProof {
  connection_handle: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface StartRequest {
  redirect_uri: string;
  public_key: JsonWebKey;
}

export interface ExchangeRequest {
  redirect_uri: string;
  code: string;
  state: string;
}

export interface RefreshRequest extends DeviceProof {}

export interface RevokeRequest extends DeviceProof {
  token: string;
}

export interface RetireRequest extends DeviceProof {}

export interface NotionTokenResponse {
  access_token: string;
  refresh_token: string;
  bot_id: string;
  workspace_id: string;
  workspace_name?: string;
  workspace_icon?: string;
}

export interface OAuthStorage {
  get(key: "record"): Promise<OAuthStoredRecord | undefined>;
  put(key: "record", value: OAuthStoredRecord): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  deleteAll(): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  transaction<T>(callback: (storage: OAuthStorage) => Promise<T>): Promise<T>;
}

export interface OAuthSessionState {
  storage: OAuthStorage;
}

export interface OAuthResult<T extends Record<string, unknown> = Record<string, unknown>> {
  ok: boolean;
  status: number;
  payload: T;
}

export interface OAuthTransactionRecord {
  type: "transaction";
  redirect_uri: string;
  public_key: JsonWebKey;
  expires_at: number;
}

export interface EncryptedToken {
  iv: string;
  ciphertext: string;
}

export interface OAuthConnectionRecord {
  type: "connection";
  handle: string;
  public_key: JsonWebKey;
  refresh_token: EncryptedToken;
  bot_id: string;
  workspace_id: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  operation_id: string | null;
  operation_expires_at: number;
  nonces: Record<string, number>;
}

export type OAuthStoredRecord = OAuthTransactionRecord | OAuthConnectionRecord;

export class OAuthHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "",
    readonly retryAfter = 0,
    readonly retryable = false
  ) {
    super(message);
    this.name = "OAuthHttpError";
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].length > 0;
}

export function isDeviceProof(value: unknown): value is DeviceProof {
  return isObject(value)
    && hasString(value, "connection_handle")
    && hasString(value, "timestamp")
    && hasString(value, "nonce")
    && hasString(value, "signature");
}

export function isNotionTokenResponse(value: unknown): value is NotionTokenResponse {
  return isObject(value)
    && hasString(value, "access_token")
    && hasString(value, "refresh_token")
    && hasString(value, "bot_id")
    && hasString(value, "workspace_id")
    && (!Object.prototype.hasOwnProperty.call(value, "workspace_name") || typeof value.workspace_name === "string")
    && (!Object.prototype.hasOwnProperty.call(value, "workspace_icon") || typeof value.workspace_icon === "string");
}
