export interface OAuthWorkerEnv {
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  ALLOWED_EXTENSION_IDS: string;
  ALLOWED_ORIGINS: string;
  TOKEN_ENCRYPTION_KEY: string;
  NOTION_REQUEST_TIMEOUT_MS?: string;
  OAUTH_SESSIONS: DurableObjectNamespace<OAuthSessionStub>;
  OAUTH_RATE_LIMITER: RateLimit;
  FETCH?: typeof fetch;
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

export interface ExchangeRequest extends StartRequest {
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
  constructor(message: string, readonly status: number) {
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
    && hasString(value, "workspace_id");
}
