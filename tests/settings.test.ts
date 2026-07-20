// @ts-nocheck
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  connectionIdForAuthorization,
  connectionTransitionForAuthorization,
  DEFAULT_SETTINGS,
  hasBundledOAuthConfig,
  migrateLegacyOAuthCredentials
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
  assert.match(script, /#advanced-setup"\)\.hidden = hasBundledOAuthConfig\(PRODUCT_CONFIG\)/);
  assert.match(html, /id="refresh-permissions"[^>]+hidden/);
  assert.match(script, /settings\.authType !== "oauth" \|\| !hasUsableOAuthConfig\(\)/);
});

test("legacy browser refresh tokens are removed and OAuth must reconnect", async () => {
  const state = {
    authType: "oauth",
    token: "old-access",
    refreshToken: "old-refresh",
    botId: "bot-123",
    connectionId: "legacy-random-id"
  };
  const storage = {
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
    },
    async remove(keys) {
      for (const key of keys) delete state[key];
    },
    async set(values) {
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
  const state = {
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
  const state = { authType: "token", token: "personal", refreshToken: "" };
  const storage = {
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
    },
    async remove(keys) {
      for (const key of keys) delete state[key];
    },
    async set(values) {
      Object.assign(state, values);
    }
  };

  assert.deepEqual(await migrateLegacyOAuthCredentials(storage), { requiresReconnect: false });
  assert.equal(state.token, "personal");
  assert.equal(state.refreshToken, undefined);
});

function storageFor(state) {
  return {
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
    async set(values) {
      Object.assign(state, values);
    }
  };
}
