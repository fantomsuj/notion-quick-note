import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  connectionIdForAuthorization,
  connectionTransitionForAuthorization,
  DEFAULT_SETTINGS,
  hasBundledOAuthConfig,
  migrateLegacyOAuthCredentials,
  normalizeSettings
} from "../src/settings.js";

test("AI actions default on but retain master and per-feature controls", async () => {
  assert.equal(DEFAULT_SETTINGS.aiEnabled, true);
  assert.equal(DEFAULT_SETTINGS.aiSuggestTitle, true);
  assert.equal(DEFAULT_SETTINGS.aiExtractTodos, true);

  const html = await readFile(new URL("../options/options.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../options/options.ts", import.meta.url), "utf8");
  for (const id of ["ai-enabled", "ai-suggest-title", "ai-extract-todos"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const key of ["aiEnabled", "aiSuggestTitle", "aiExtractTodos"]) assert.match(script, new RegExp(key));
  assert.match(script, /chrome\.storage\.local\.set\(\{ aiEnabled:/);
  assert.match(script, /chrome\.storage\.local\.set\(\{ \[key\]:/);
});

test("normalizes partial historical settings without trusting malformed storage values", () => {
  const settings = normalizeSettings({
    authType: "token",
    token: "secret",
    workspaceName: "Personal",
    destinationType: "invalid",
    destinationName: 42,
    includeSource: false,
    aiEnabled: "yes",
    destinationSchemaVersion: Number.NaN,
    oauthReconnectRequired: true,
    ignored: "not part of Settings"
  });

  assert.equal(settings.authType, "token");
  assert.equal(settings.token, "secret");
  assert.equal(settings.workspaceName, "Personal");
  assert.equal(settings.destinationType, DEFAULT_SETTINGS.destinationType);
  assert.equal(settings.destinationName, DEFAULT_SETTINGS.destinationName);
  assert.equal(settings.includeSource, false);
  assert.equal(settings.aiEnabled, DEFAULT_SETTINGS.aiEnabled);
  assert.equal(settings.destinationSchemaVersion, DEFAULT_SETTINGS.destinationSchemaVersion);
  assert.equal(settings.oauthReconnectRequired, true);
  assert.equal("ignored" in settings, false);
});

test("deeply normalizes destination properties and preserves each valid historical entry", () => {
  const settings = normalizeSettings({
    destinationProperties: {
      title: { id: "title-id", name: "Name" },
      captureId: { id: "capture-id", name: "Capture ID", extra: true },
      malformedName: { id: "bad-id", name: 7 },
      malformedEntry: "bad"
    }
  });

  assert.deepEqual(settings.destinationProperties, {
    title: { id: "title-id", name: "Name" },
    captureId: { id: "capture-id", name: "Capture ID" }
  });
});

test("preserves the full persisted provisioning recovery state", () => {
  const settings = normalizeSettings({
    databaseProvisioning: {
      connectionId: "connection-1",
      marker: "marker-1",
      status: "failed",
      startedAt: 100,
      lastAttemptAt: 200,
      lastError: { message: "Notion unavailable", status: 503, code: "service_unavailable" }
    }
  });

  assert.deepEqual(settings.databaseProvisioning, {
    connectionId: "connection-1",
    marker: "marker-1",
    status: "failed",
    startedAt: 100,
    lastAttemptAt: 200,
    lastError: { message: "Notion unavailable", status: 503, code: "service_unavailable" }
  });
});

test("migrates legacy provisioning state and rejects malformed recovery state", () => {
  assert.deepEqual(normalizeSettings({
    databaseProvisioning: {
      connectionId: "connection-1",
      marker: "marker-1",
      status: "pending",
      attemptedAt: 123
    }
  }).databaseProvisioning, {
    connectionId: "connection-1",
    marker: "marker-1",
    status: "recovering",
    startedAt: 123,
    lastAttemptAt: 123,
    lastError: null
  });

  assert.equal(normalizeSettings({
    databaseProvisioning: {
      connectionId: "connection-1",
      marker: "marker-1",
      status: "uncertain",
      startedAt: "yesterday",
      lastAttemptAt: 123
    }
  }).databaseProvisioning, null);
});

test("OAuth connections use the Notion bot ID as a stable queue identity", () => {
  assert.equal(connectionIdForAuthorization({ authType: "oauth", botId: "bot-123" }), "notion:bot-123");
  assert.equal(connectionIdForAuthorization({ authType: "token", botId: "bot-123", randomUUID: () => "random-id" }), "random-id");
});

test("the first broker reconnect preserves a verified legacy bot identity and destination", () => {
  const transition = connectionTransitionForAuthorization({
    authType: "oauth",
    botId: "bot-123",
    connectionId: "legacy-random-id",
    legacyOAuthBotId: "bot-123",
    legacyOAuthConnectionId: "legacy-random-id",
    destinationId: "database-123"
  }, {
    authType: "oauth",
    botId: "bot-123"
  });

  assert.deepEqual(transition, {
    connectionId: "legacy-random-id",
    preservedDestination: true
  });
});

test("a different bot cannot adopt a legacy connection or destination", () => {
  const transition = connectionTransitionForAuthorization({
    authType: "oauth",
    botId: "old-bot",
    connectionId: "legacy-random-id",
    legacyOAuthBotId: "old-bot",
    legacyOAuthConnectionId: "legacy-random-id",
    destinationId: "database-123"
  }, {
    authType: "oauth",
    botId: "new-bot"
  });

  assert.deepEqual(transition, {
    connectionId: "notion:new-bot",
    preservedDestination: false
  });
});

test("an established broker connection keeps an adopted legacy identity on later reauthorization", () => {
  const transition = connectionTransitionForAuthorization({
    authType: "oauth",
    botId: "bot-123",
    connectionId: "legacy-random-id",
    connectionHandle: "broker-handle",
    destinationId: "database-123"
  }, {
    authType: "oauth",
    botId: "bot-123"
  });

  assert.equal(transition.connectionId, "legacy-random-id");
  assert.equal(transition.preservedDestination, true);
});

test("bundled production OAuth hides developer-only setup", async () => {
  assert.equal(hasBundledOAuthConfig({ notionClientId: "client", oauthBrokerUrl: "https://auth.example" }), true);
  assert.equal(hasBundledOAuthConfig({ notionClientId: "client", oauthBrokerUrl: "" }), false);
  const script = await readFile(new URL("../options/options.ts", import.meta.url), "utf8");
  const html = await readFile(new URL("../options/options.html", import.meta.url), "utf8");
  assert.match(script, /#personal-token-setup"\)\.hidden = hasBundledOAuthConfig\(PRODUCT_CONFIG\)/);
  assert.match(script, /#oauth-bundled-setup"\)\.hidden = !hasBundledOAuthConfig\(PRODUCT_CONFIG\)/);
  assert.match(script, /#oauth-test-setup"\)\.hidden = hasBundledOAuthConfig\(PRODUCT_CONFIG\)/);
  assert.match(html, /id="personal-token-setup"/);
  assert.match(html, /id="oauth-bundled-setup"/);
  assert.match(html, /id="oauth-test-setup"/);
  assert.match(html, /Connect with a personal Notion token/);
  assert.match(html, /Test OAuth instead/);
  assert.match(html, /dedicated test workspace or integration/);
  assert.match(html, /requires a configured test broker/);
  assert.match(html, /id="refresh-permissions"[^>]+hidden/);
  assert.match(script, /settings\.authType !== "oauth" \|\| !hasUsableOAuthConfig\(\)/);
});

test("Settings provides an Activity & Recovery section for capture queue controls", async () => {
  const html = await readFile(new URL("../options/options.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../options/options.ts", import.meta.url), "utf8");

  assert.match(html, /id="activity"/);
  assert.match(html, /Activity &amp; Recovery/);
  assert.match(html, /data-export="json"/);
  assert.match(html, /data-export="markdown"/);
  assert.match(html, /clear-delivered-history/);
  for (const request of [
    "LIST_CAPTURE_ACTIVITY",
    "RETRY_CAPTURE",
    "RETARGET_CAPTURE",
    "MARK_CAPTURE_DELIVERED",
    "DELETE_CAPTURE",
    "DELETE_DELIVERED_HISTORY",
    "GET_STORAGE_DIAGNOSTICS",
    "EXPORT_CAPTURE_RECOVERY"
  ]) assert.match(script, new RegExp(request));
  assert.match(script, /location\.hash !== "#activity"/);
  assert.match(script, /record\.status === "blocked_conflict"/);
  assert.match(script, /Prepare local edit/);
  assert.match(script, /LOAD_RECENT_NOTE/, "conflicts must provide a route back to the composer");
});

test("legacy browser refresh tokens are removed and OAuth must reconnect", async () => {
  const state: Record<string, unknown> = {
    authType: "oauth",
    token: "old-access",
    refreshToken: "old-refresh",
    botId: "bot-123",
    connectionId: "legacy-random-id"
  };
  const storage = {
    async get(keys: string[]) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
    },
    async remove(keys: string[]) {
      for (const key of keys) delete state[key];
    },
    async set(values: Record<string, unknown>) {
      Object.assign(state, values);
    }
  };

  assert.deepEqual(await migrateLegacyOAuthCredentials(storage), { requiresReconnect: true });
  assert.equal(state.token, undefined);
  assert.equal(state.refreshToken, undefined);
  assert.equal(state.oauthReconnectRequired, true);
  assert.equal(state.legacyOAuthBotId, "bot-123");
  assert.equal(state.legacyOAuthConnectionId, "legacy-random-id");
});

test("a nonempty legacy refresh token is treated as OAuth when authType is absent", async () => {
  const state: Record<string, unknown> = {
    token: "old-access",
    refreshToken: "old-refresh",
    botId: "bot-123",
    connectionId: "legacy-random-id"
  };
  const storage = storageFor(state);

  assert.deepEqual(await migrateLegacyOAuthCredentials(storage), { requiresReconnect: true });
  assert.equal(state.authType, "oauth");
  assert.equal(state.token, undefined);
  assert.equal(state.refreshToken, undefined);
  assert.equal(state.legacyOAuthBotId, "bot-123");
  assert.equal(state.legacyOAuthConnectionId, "legacy-random-id");
});

test("a personal token is preserved while an obsolete empty refresh field is removed", async () => {
  const state: Record<string, unknown> = { authType: "token", token: "personal", refreshToken: "" };
  const storage = {
    async get(keys: string[]) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
    },
    async remove(keys: string[]) {
      for (const key of keys) delete state[key];
    },
    async set(values: Record<string, unknown>) {
      Object.assign(state, values);
    }
  };

  assert.deepEqual(await migrateLegacyOAuthCredentials(storage), { requiresReconnect: false });
  assert.equal(state.token, "personal");
  assert.equal(state.refreshToken, undefined);
});

function storageFor(state: Record<string, unknown>) {
  return {
    async get(keys: string[]) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
    },
    async remove(keys: string[] | string) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
    async set(values: Record<string, unknown>) {
      Object.assign(state, values);
    }
  };
}
