import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  beginAuthorization,
  createAccessTokenRefresher,
  exchangeAuthorizationCode,
  refreshAccessToken,
  retireOAuthConnection,
  revokeAccessToken
} from "../src/oauth.js";
import type { OAuthFetch } from "../src/oauth.js";
import {
  OAuthDeviceUnavailableError,
  createOAuthDeviceKeyStore,
  generateOAuthDeviceKeyPair
} from "../src/oauth-device.js";
import type { OAuthDeviceKeyStore } from "../src/oauth-device.js";

interface BrokerCall {
  url: string;
  body: Record<string, unknown>;
}

const redirectUri = "https://extension.chromiumapp.org/notion";

test("persists a non-exportable device private key in extension-origin IndexedDB", async () => {
  const indexedDBImpl = new IDBFactory();
  const firstStore = createOAuthDeviceKeyStore({ indexedDBImpl });
  const first = await firstStore.getOrCreateKeyPair();
  assert.equal(first.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("jwk", first.privateKey), /not extractable/i);

  const secondStore = createOAuthDeviceKeyStore({ indexedDBImpl });
  const second = await secondStore.getOrCreateKeyPair();
  assert.deepEqual(
    await crypto.subtle.exportKey("jwk", second.publicKey),
    await crypto.subtle.exportKey("jwk", first.publicKey)
  );
});

test("does not silently create a different device key in split incognito storage", async () => {
  const keyStore = createOAuthDeviceKeyStore({
    indexedDBImpl: new IDBFactory(),
    allowKeyCreation: false
  });
  await assert.rejects(
    keyStore.getOrCreateKeyPair(),
    (error) => error instanceof OAuthDeviceUnavailableError && /regular window/i.test(error.message)
  );
});

test("uses the device-bound broker routes for the OAuth lifecycle", async () => {
  const keyPair = await generateOAuthDeviceKeyPair();
  const keyStore = memoryKeyStore(keyPair);
  const calls: BrokerCall[] = [];
  const fetchImpl: OAuthFetch = async (input, options) => {
    const url = String(input);
    const body = requestBody(options);
    calls.push({ url, body });
    if (url.endsWith("/start")) return response(200, { state: "oauth-state" });
    if (url.endsWith("/exchange")) {
      return response(200, validExchangePayload({
        refresh_token: "must-not-escape",
        owner: { type: "workspace" }
      }));
    }
    if (url.endsWith("/refresh")) return response(200, { access_token: "access-2" });
    return response(200, {});
  };

  const started = await beginAuthorization({
    brokerUrl: "https://auth.example/",
    redirectUri,
    fetchImpl,
    keyStore
  });
  const exchanged = await exchangeAuthorizationCode({
    brokerUrl: "https://auth.example/",
    code: "code",
    redirectUri,
    state: started.state,
    fetchImpl
  });
  await refreshAccessToken({
    brokerUrl: "https://auth.example",
    connectionHandle: exchanged.connection_handle,
    fetchImpl,
    keyStore,
    now: () => 1_721_234_567_890,
    nonceGenerator: () => "refresh-nonce"
  });
  await revokeAccessToken({
    brokerUrl: "https://auth.example",
    connectionHandle: exchanged.connection_handle,
    token: "access-2",
    fetchImpl,
    keyStore,
    now: () => 1_721_234_567_891,
    nonceGenerator: () => "revoke-nonce"
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://auth.example/start",
    "https://auth.example/exchange",
    "https://auth.example/refresh",
    "https://auth.example/revoke"
  ]);
  const startCall = requiredItem(calls, 0);
  const exchangeCall = requiredItem(calls, 1);
  const refreshCall = requiredItem(calls, 2);
  const revokeCall = requiredItem(calls, 3);
  assert.deepEqual(startCall.body.redirect_uri, redirectUri);
  assert.ok(isRecord(startCall.body.public_key));
  assert.deepEqual(
    { kty: startCall.body.public_key.kty, crv: startCall.body.public_key.crv },
    { kty: "EC", crv: "P-256" }
  );
  assert.equal(startCall.body.public_key.d, undefined);
  assert.deepEqual(exchangeCall.body, {
    code: "code",
    redirect_uri: redirectUri,
    state: "oauth-state"
  });
  assert.equal(exchanged.refresh_token, undefined);
  assert.deepEqual(exchanged.owner, { type: "workspace" });
  assert.deepEqual(
    pick(refreshCall.body, ["connection_handle", "timestamp", "nonce"]),
    { connection_handle: "connection-handle", timestamp: "1721234567890", nonce: "refresh-nonce" }
  );
  assert.deepEqual(
    pick(revokeCall.body, ["connection_handle", "token", "timestamp", "nonce"]),
    {
      connection_handle: "connection-handle",
      token: "access-2",
      timestamp: "1721234567891",
      nonce: "revoke-nonce"
    }
  );
  await assertValidSignature(
    keyPair.publicKey,
    requiredField(refreshCall.body, "signature"),
    ["/refresh", "connection-handle", "1721234567890", "refresh-nonce", ""].join("\n")
  );
  await assertValidSignature(
    keyPair.publicKey,
    requiredField(revokeCall.body, "signature"),
    ["/revoke", "connection-handle", "1721234567891", "revoke-nonce", "access-2"].join("\n")
  );
});

test("surfaces a broker error message and metadata", async () => {
  const keyStore = await newMemoryKeyStore();
  const fetchImpl = async () => response(401, {
    error: "Reconnect Notion",
    code: "invalid_connection",
    retry_after: 7,
    retryable: true
  });
  await assert.rejects(
    refreshAccessToken({
      brokerUrl: "https://auth.example",
      connectionHandle: "expired",
      fetchImpl,
      keyStore
    }),
    (error) => isOAuthError(error)
      && error.message === "Reconnect Notion"
      && error.status === 401
      && error.code === "invalid_connection"
      && error.retryAfter === 7
      && error.retryable === true
  );
});

test("validates start and exchange responses before returning credentials", async () => {
  const keyStore = await newMemoryKeyStore();
  await assert.rejects(
    beginAuthorization({
      brokerUrl: "https://auth.example",
      redirectUri,
      keyStore,
      fetchImpl: async () => response(200, {})
    }),
    /invalid state/
  );

  for (const missing of ["access_token", "connection_handle", "bot_id", "workspace_id"]) {
    const payload = validExchangePayload();
    delete payload[missing];
    await assert.rejects(
      exchangeAuthorizationCode({
        brokerUrl: "https://auth.example",
        code: "code",
        redirectUri,
        state: "state",
        fetchImpl: async () => response(200, payload)
      }),
      /invalid token response/
    );
  }

  await assert.rejects(
    exchangeAuthorizationCode({
      brokerUrl: "https://auth.example",
      code: "code",
      redirectUri,
      state: "state",
      fetchImpl: async () => response(200, validExchangePayload({ workspace_name: 42 }))
    }),
    /invalid token response/
  );
});

test("requires state and a connection handle before contacting the broker", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return response(200, validExchangePayload());
  };
  await assert.rejects(
    exchangeAuthorizationCode({ brokerUrl: "https://auth.example", code: "code", redirectUri, fetchImpl }),
    /OAuth state is missing/
  );
  await assert.rejects(
    refreshAccessToken({ brokerUrl: "https://auth.example", connectionHandle: "", fetchImpl }),
    /Reconnect Notion/
  );
  assert.equal(requests, 0);
});

test("coalesces refreshes and stores only the returned access token", async () => {
  const state = {
    connectionId: "connection-1",
    connectionHandle: "handle-1",
    token: "expired-access",
    oauthBrokerUrl: "https://auth.example"
  };
  const keyStore = await newMemoryKeyStore();
  const savedValues: Array<{ token: string }> = [];
  let requests = 0;
  let release: (() => void) | undefined;
  const fetchImpl: OAuthFetch = async () => {
    requests += 1;
    return new Promise<Response>((resolve) => {
      release = () => resolve(response(200, {
        access_token: "access-2",
        refresh_token: "broker-secret-must-not-be-stored"
      }));
    });
  };
  const refresh = createAccessTokenRefresher({
    loadSettings: async () => ({ ...state }),
    saveSettings: async (values) => {
      savedValues.push(values);
      Object.assign(state, values);
    },
    brokerUrlForSettings: (settings) => settings.oauthBrokerUrl,
    fetchImpl,
    keyStore
  });
  const stale = { ...state };
  const first = refresh(stale);
  const second = refresh(stale);
  await waitFor(() => requests === 1);
  assert.equal(requests, 1);
  assert.ok(release);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(state.token, "access-2");
  assert.equal("refreshToken" in state ? state.refreshToken : undefined, undefined);
  assert.deepEqual(savedValues, [{ token: "access-2" }]);

  const third = await refresh(stale);
  assert.equal(requests, 1);
  assert.equal(third.token, "access-2");
});

test("rejects a successful refresh response without an access token", async () => {
  const state = {
    connectionId: "connection",
    connectionHandle: "handle",
    token: "expired",
    oauthBrokerUrl: "https://auth.example"
  };
  const refresh = createAccessTokenRefresher({
    loadSettings: async () => ({ ...state }),
    saveSettings: async () => assert.fail("invalid tokens must not be stored"),
    brokerUrlForSettings: (settings) => settings.oauthBrokerUrl,
    fetchImpl: async () => response(200, {}),
    keyStore: await newMemoryKeyStore()
  });
  await assert.rejects(refresh({ token: "expired" }), /invalid token response/);
});

test("refresh preserves broker fields, allows omitted identity fields, and rejects malformed optional metadata", async () => {
  const keyStore = await newMemoryKeyStore();
  const preserved = await refreshAccessToken({
    brokerUrl: "https://auth.example",
    connectionHandle: "handle",
    keyStore,
    fetchImpl: async () => response(200, {
      access_token: "access",
      owner: { type: "workspace" }
    })
  });
  assert.equal(preserved.access_token, "access");
  assert.deepEqual(preserved.owner, { type: "workspace" });
  assert.equal(preserved.bot_id, undefined);
  assert.equal(preserved.workspace_id, undefined);

  for (const field of ["bot_id", "workspace_id", "workspace_name", "workspace_icon"]) {
    await assert.rejects(
      refreshAccessToken({
        brokerUrl: "https://auth.example",
        connectionHandle: "handle",
        keyStore,
        fetchImpl: async () => response(200, { access_token: "access", [field]: 42 })
      }),
      /invalid token response/
    );
  }
});

test("does not restore a stale access token after the connection changes during refresh", async () => {
  const state = {
    connectionId: "connection-1",
    connectionHandle: "handle-1",
    token: "expired",
    oauthBrokerUrl: "https://auth.example"
  };
  let release: (() => void) | undefined;
  const fetchImpl: OAuthFetch = async () => new Promise<Response>((resolve) => {
    release = () => resolve(response(200, { access_token: "stale-access" }));
  });
  const refresh = createAccessTokenRefresher({
    loadSettings: async () => ({ ...state }),
    saveSettings: async (values) => { Object.assign(state, values); },
    brokerUrlForSettings: (settings) => settings.oauthBrokerUrl,
    fetchImpl,
    keyStore: await newMemoryKeyStore()
  });
  const pending = refresh({ ...state });
  await waitFor(() => typeof release === "function");
  Object.assign(state, { connectionId: "connection-2", connectionHandle: "handle-2", token: "new-access" });
  assert.ok(release);
  release();
  await assert.rejects(pending, (error) => isOAuthError(error) && error.status === 401 && error.code === "connection_changed");
  assert.equal(state.token, "new-access");
});

test("skips remote revocation when there is no access token", async () => {
  let requested = false;
  const result = await revokeAccessToken({
    brokerUrl: "https://auth.example",
    connectionHandle: "handle",
    token: "",
    fetchImpl: async () => {
      requested = true;
      return response(500, {});
    }
  });
  assert.deepEqual(result, {});
  assert.equal(requested, false);
});

test("retires replaced broker custody with a device-bound proof and no Notion token", async () => {
  const cryptoImpl = crypto;
  const keyPair = await generateOAuthDeviceKeyPair(cryptoImpl);
  const requests: BrokerCall[] = [];
  const fetchImpl: OAuthFetch = async (input, init) => {
    requests.push({ url: String(input), body: requestBody(init) });
    return response(200, { ok: true });
  };

  await retireOAuthConnection({
    brokerUrl: "https://auth.example",
    connectionHandle: "old-handle",
    fetchImpl,
    keyStore: memoryKeyStore(keyPair),
    cryptoImpl,
    now: () => 1_750_000_000_000,
    nonceGenerator: () => "retirement-nonce"
  });

  const retirementRequest = requiredItem(requests, 0);
  assert.equal(retirementRequest.url, "https://auth.example/retire");
  assert.deepEqual(Object.keys(retirementRequest.body).sort(), ["connection_handle", "nonce", "signature", "timestamp"]);
  assert.equal(retirementRequest.body.connection_handle, "old-handle");
  await assertValidSignature(
    keyPair.publicKey,
    requiredField(retirementRequest.body, "signature"),
    ["/retire", "old-handle", requiredField(retirementRequest.body, "timestamp"), "retirement-nonce", ""].join("\n")
  );
});

async function newMemoryKeyStore(): Promise<OAuthDeviceKeyStore> {
  return memoryKeyStore(await generateOAuthDeviceKeyPair());
}

function memoryKeyStore(keyPair: CryptoKeyPair): OAuthDeviceKeyStore {
  return { getOrCreateKeyPair: async () => keyPair };
}

async function assertValidSignature(publicKey: CryptoKey, signature: string, message: string): Promise<void> {
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(message)
  );
  assert.equal(valid, true);
}

function validExchangePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "access",
    connection_handle: "connection-handle",
    bot_id: "bot-id",
    workspace_id: "workspace-id",
    workspace_name: "Workspace",
    ...overrides
  };
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the OAuth request.");
}

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== "string") assert.fail("Expected a JSON request body.");
  const parsed: unknown = JSON.parse(body);
  assert.ok(isRecord(parsed));
  return parsed;
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item);
  return item;
}

function requiredField(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  assert.equal(typeof fieldValue, "string");
  return String(fieldValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthError(error: unknown): error is Error & {
  status: number;
  code: string;
  retryAfter: number;
  retryable: boolean;
} {
  return error instanceof Error
    && "status" in error && typeof error.status === "number"
    && "code" in error && typeof error.code === "string"
    && "retryAfter" in error && typeof error.retryAfter === "number"
    && "retryable" in error && typeof error.retryable === "boolean";
}
