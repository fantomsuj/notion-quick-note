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
