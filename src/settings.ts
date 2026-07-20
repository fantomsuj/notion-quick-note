import type { Settings } from "./contracts.js";

interface PublicProductConfig {
  notionClientId: string;
  oauthBrokerUrl: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  authType: "oauth",
  token: "",
  connectionHandle: "",
  workspaceId: "",
  workspaceName: "",
  workspaceIcon: "",
  botId: "",
  connectionId: "",
  legacyOAuthBotId: "",
  legacyOAuthConnectionId: "",
  destinationType: "database",
  destinationId: "",
  destinationDatabaseId: "",
  destinationName: "Quick Notes",
  destinationUrl: "",
  titleProperty: "Name",
  managedDestination: false,
  destinationSchemaVersion: 0,
  destinationMarker: "",
  destinationProperties: {},
  destinationConnectionId: "",
  databaseProvisioning: null,
  onboardingComplete: false,
  includeSource: true,
  aiEnabled: true,
  aiSuggestTitle: true,
  aiExtractTodos: true,
  oauthClientId: "",
  oauthBrokerUrl: ""
});

const STRING_SETTING_KEYS = [
  "token", "connectionHandle", "workspaceId", "workspaceName", "workspaceIcon", "botId", "connectionId",
  "legacyOAuthBotId", "legacyOAuthConnectionId", "destinationId", "destinationDatabaseId", "destinationName",
  "destinationUrl", "titleProperty", "destinationMarker", "destinationConnectionId", "oauthClientId", "oauthBrokerUrl"
] as const satisfies readonly (keyof Settings)[];

const BOOLEAN_SETTING_KEYS = [
  "managedDestination", "onboardingComplete", "includeSource", "aiEnabled", "aiSuggestTitle", "aiExtractTodos"
] as const satisfies readonly (keyof Settings)[];

export function normalizeSettings(value: unknown): Settings {
  const source = isRecord(value) ? value : {};
  const normalized: Settings = { ...DEFAULT_SETTINGS, destinationProperties: {} };

  if (source.authType === "oauth" || source.authType === "token") normalized.authType = source.authType;
  if (source.destinationType === "page" || source.destinationType === "database") normalized.destinationType = source.destinationType;
  for (const key of STRING_SETTING_KEYS) {
    const candidate = source[key];
    if (typeof candidate === "string") normalized[key] = candidate;
  }
  for (const key of BOOLEAN_SETTING_KEYS) {
    const candidate = source[key];
    if (typeof candidate === "boolean") normalized[key] = candidate;
  }
  if (typeof source.destinationSchemaVersion === "number" && Number.isFinite(source.destinationSchemaVersion)) {
    normalized.destinationSchemaVersion = source.destinationSchemaVersion;
  }
  normalized.destinationProperties = normalizeDestinationProperties(source.destinationProperties);
  normalized.databaseProvisioning = normalizeDatabaseProvisioning(source.databaseProvisioning);
  if (typeof source.oauthReconnectRequired === "boolean") normalized.oauthReconnectRequired = source.oauthReconnectRequired;
  return normalized;
}

function normalizeDestinationProperties(value: unknown): Settings["destinationProperties"] {
  if (!isRecord(value)) return {};
  const properties: Settings["destinationProperties"] = {};
  for (const [key, property] of Object.entries(value)) {
    if (!isRecord(property) || typeof property.id !== "string" || typeof property.name !== "string") continue;
    properties[key] = { id: property.id, name: property.name };
  }
  return properties;
}

function normalizeDatabaseProvisioning(value: unknown): Settings["databaseProvisioning"] {
  if (!isRecord(value) || typeof value.connectionId !== "string" || typeof value.marker !== "string") return null;

  if ((value.status === "pending" || value.status === "uncertain") && isFiniteNumber(value.attemptedAt)) {
    return {
      connectionId: value.connectionId,
      marker: value.marker,
      status: value.status === "pending" ? "recovering" : "uncertain",
      startedAt: value.attemptedAt,
      lastAttemptAt: value.attemptedAt,
      lastError: null
    };
  }

  if (!isProvisioningStatus(value.status) || !isFiniteNumber(value.startedAt) || !isFiniteNumber(value.lastAttemptAt)) return null;
  const lastError = normalizeProvisioningError(value.lastError);
  if (value.lastError !== undefined && value.lastError !== null && !lastError) return null;
  return {
    connectionId: value.connectionId,
    marker: value.marker,
    status: value.status,
    startedAt: value.startedAt,
    lastAttemptAt: value.lastAttemptAt,
    lastError: lastError ?? null
  };
}

function normalizeProvisioningError(value: unknown): NonNullable<Settings["databaseProvisioning"]>["lastError"] {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.message !== "string" || !isFiniteNumber(value.status) || typeof value.code !== "string") return undefined;
  return { message: value.message, status: value.status, code: value.code };
}

function isProvisioningStatus(value: unknown): value is NonNullable<Settings["databaseProvisioning"]>["status"] {
  return value === "recovering" || value === "creating" || value === "uncertain" || value === "failed";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasBundledOAuthConfig(config: Partial<PublicProductConfig> = {}): boolean {
  return Boolean(String(config.notionClientId || "").trim() && String(config.oauthBrokerUrl || "").trim());
}

interface AuthorizationIdentity {
  authType?: "oauth" | "token";
  botId?: string;
  randomUUID?: () => string;
}

type AuthorizationState = Partial<Settings>;

export function connectionIdForAuthorization({ authType, botId, randomUUID = () => crypto.randomUUID() }: AuthorizationIdentity = {}): string {
  const stableBotId = String(botId || "").trim();
  if (authType === "oauth" && stableBotId) return `notion:${stableBotId}`;
  return randomUUID();
}

export function connectionTransitionForAuthorization(
  current: AuthorizationState = {},
  incoming: AuthorizationIdentity = {},
  randomUUID: () => string = () => crypto.randomUUID()
): { connectionId: string; preservedDestination: boolean } {
  const canonicalConnectionId = connectionIdForAuthorization({ ...incoming, randomUUID });
  if (incoming.authType !== "oauth") {
    return { connectionId: canonicalConnectionId, preservedDestination: false };
  }

  const currentBotId = String(current.botId || "").trim();
  const incomingBotId = String(incoming.botId || "").trim();
  const currentConnectionId = String(current.connectionId || "").trim();
  const sameBot = Boolean(currentBotId && incomingBotId && currentBotId === incomingBotId);
  const validLegacyBridge = sameBot
    && String(current.legacyOAuthBotId || "").trim() === incomingBotId
    && String(current.legacyOAuthConnectionId || "").trim() === currentConnectionId;
  const establishedBrokerConnection = sameBot
    && current.authType === "oauth"
    && Boolean(String(current.connectionHandle || "").trim());
  const preserveIdentity = Boolean(currentConnectionId && (validLegacyBridge || establishedBrokerConnection));

  return {
    connectionId: preserveIdentity ? currentConnectionId : canonicalConnectionId,
    preservedDestination: preserveIdentity && Boolean(current.destinationId)
  };
}

interface LegacyCredentialStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  remove(keys: string[]): Promise<void>;
  set(values: Record<string, unknown>): Promise<void>;
}

export async function migrateLegacyOAuthCredentials(storage: LegacyCredentialStorage): Promise<{ requiresReconnect: boolean }> {
  const stored = await storage.get([
    "authType", "token", "refreshToken", "connectionHandle", "botId", "connectionId"
  ]);
  const hasLegacyRefreshToken = Object.prototype.hasOwnProperty.call(stored, "refreshToken");
  const inferredOAuth = stored.authType === "oauth"
    || (!stored.authType && Boolean(String(stored.refreshToken || "").trim()));
  const oauthMissingHandle = inferredOAuth && Boolean(stored.token) && !stored.connectionHandle;
  if (!hasLegacyRefreshToken && !oauthMissingHandle) return { requiresReconnect: false };

  const remove = ["refreshToken"];
  const requiresReconnect = inferredOAuth
    && (Boolean(stored.token) || Boolean(String(stored.refreshToken || "").trim()));
  if (requiresReconnect) remove.push("token", "connectionHandle");
  await storage.remove(remove);
  if (requiresReconnect) {
    const legacyOAuthBotId = String(stored.botId || "").trim();
    const legacyOAuthConnectionId = String(stored.connectionId || "").trim();
    await storage.set({
      authType: "oauth",
      oauthReconnectRequired: true,
      ...(legacyOAuthBotId && legacyOAuthConnectionId
        ? { legacyOAuthBotId, legacyOAuthConnectionId }
        : {})
    });
  }
  return { requiresReconnect };
}
