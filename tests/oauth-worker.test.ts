// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import worker, { OAuthSession } from "../oauth-worker/src/index.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/notion`;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const CONNECTION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

test("health fails closed until credentials, durable storage, encryption, rate limiting, and matching allowlists exist", async () => {
  const env = makeEnv();
  const healthy = await worker.fetch(new Request("https://broker.example/health"), env);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true });

  for (const invalid of [
    { ...env, NOTION_CLIENT_SECRET: "" },
    { ...env, ALLOWED_EXTENSION_IDS: "short" },
    { ...env, ALLOWED_ORIGINS: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" },
    { ...env, OAUTH_SESSIONS: undefined },
    { ...env, OAUTH_RATE_LIMITER: undefined },
    { ...env, TOKEN_ENCRYPTION_KEY: encodeBase64Url(new Uint8Array(16)) }
  ]) {
    const response = await worker.fetch(new Request("https://broker.example/health"), invalid);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  }
});

test("start creates an alarm-backed ten-minute transaction for an exact redirect and valid P-256 key", async () => {
  const env = makeEnv();
  const keys = await makeSigningKeys();
  const before = Date.now();
  const response = await worker.fetch(request("/start", {
    redirect_uri: REDIRECT_URI,
    public_key: keys.publicJwk
  }), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const { state } = await response.json();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const storage = env.OAUTH_SESSIONS.storage(`transaction:${state}`);
  const stored = await storage.get("record");
  assert.equal(stored.type, "transaction");
  assert.equal(stored.redirect_uri, REDIRECT_URI);
  assert.deepEqual(stored.public_key, { ...keys.publicJwk, ext: true, key_ops: ["verify"] });
  assert.ok(stored.expires_at >= before + TRANSACTION_TTL_MS);
  assert.equal(storage.alarm, stored.expires_at);

  for (const redirect_uri of [`${REDIRECT_URI}/extra`, `${REDIRECT_URI}?next=1`, "https://unknown.chromiumapp.org/notion"]) {
    const denied = await worker.fetch(request("/start", { redirect_uri, public_key: keys.publicJwk }), env);
    assert.equal(denied.status, 403);
  }
  const badKey = await worker.fetch(request("/start", {
    redirect_uri: REDIRECT_URI,
    public_key: { kty: "EC", crv: "P-384", x: "x", y: "y" }
  }), env);
  assert.equal(badKey.status, 400);
});

test("exchange atomically consumes state and stores only an encrypted refresh token in a per-connection object", async () => {
  const calls = [];
  const env = makeEnv(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return notionResponse(tokenPayload("access-one", "refresh-one"));
  });
  const keys = await makeSigningKeys();
  const state = await start(env, keys.publicJwk);

  const [first, replay] = await Promise.all([
    worker.fetch(request("/exchange", { code: "authorization-code", redirect_uri: REDIRECT_URI, state }), env),
    worker.fetch(request("/exchange", { code: "authorization-code", redirect_uri: REDIRECT_URI, state }), env)
  ]);
  const responses = [first, replay];
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  assert.equal(calls.length, 1);

  const successResponse = responses.find((response) => response.status === 200);
  const payload = await successResponse.json();
  assert.equal(payload.access_token, "access-one");
  assert.equal(payload.refresh_token, undefined);
  assert.match(payload.connection_handle, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await env.OAUTH_SESSIONS.storage(`transaction:${state}`).get("record")), undefined);
  assert.deepEqual(calls[0].body, {
    grant_type: "authorization_code",
    code: "authorization-code",
    redirect_uri: REDIRECT_URI
  });

  const connectionStorage = env.OAUTH_SESSIONS.storage(`connection:${payload.connection_handle}`);
  const record = await connectionStorage.get("record");
  assert.equal(record.type, "connection");
  assert.equal(record.bot_id, "bot-id");
  assert.equal(record.workspace_id, "workspace-id");
  assert.equal(record.created_at, record.updated_at);
  assert.equal(typeof record.refresh_token.iv, "string");
  assert.equal(typeof record.refresh_token.ciphertext, "string");
  assert.equal(JSON.stringify(record).includes("refresh-one"), false);
  assert.equal(connectionStorage.alarm, record.expires_at);
  assert.ok(record.expires_at >= record.updated_at + CONNECTION_TTL_MS);
});

test("redirect mismatch consumes the transaction and never reaches Notion", async () => {
  let calls = 0;
  const env = makeEnv(async () => {
    calls += 1;
    return notionResponse(tokenPayload("access", "refresh"));
  });
  env.ALLOWED_EXTENSION_IDS += ",ponmlkjihgfedcbaponmlkjihgfedcba";
  env.ALLOWED_ORIGINS += ",chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
  const keys = await makeSigningKeys();
  const state = await start(env, keys.publicJwk);
  const otherRedirect = "https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/notion";
  const mismatch = await worker.fetch(request("/exchange", { code: "code", state, redirect_uri: otherRedirect }), env);
  assert.equal(mismatch.status, 400);
  const retry = await worker.fetch(request("/exchange", { code: "code", state, redirect_uri: REDIRECT_URI }), env);
  assert.equal(retry.status, 400);
  assert.equal(calls, 0);
});

test("exchange validates the complete Notion response and preserves Notion errors", async () => {
  const keys = await makeSigningKeys();
  const incompleteEnv = makeEnv(async () => notionResponse({ access_token: "access" }));
  const incompleteState = await start(incompleteEnv, keys.publicJwk);
  const incomplete = await worker.fetch(request("/exchange", {
    code: "code", redirect_uri: REDIRECT_URI, state: incompleteState
  }), incompleteEnv);
  assert.equal(incomplete.status, 502);
  assert.match((await incomplete.json()).error, /refresh_token, bot_id, workspace_id/);

  const deniedEnv = makeEnv(async () => notionResponse({ code: "unauthorized", message: "Denied" }, 401));
  const deniedState = await start(deniedEnv, keys.publicJwk);
  const denied = await worker.fetch(request("/exchange", {
    code: "code", redirect_uri: REDIRECT_URI, state: deniedState
  }), deniedEnv);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { code: "unauthorized", message: "Denied" });
});

test("refresh verifies proof, rotates custody, rejects replay, and renews the inactivity alarm", async () => {
  const calls = [];
  const env = makeEnv(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return notionResponse(body.grant_type === "authorization_code"
      ? tokenPayload("access-one", "refresh-one")
      : tokenPayload("access-two", "refresh-two"));
  });
  const keys = await makeSigningKeys();
  const handle = await connect(env, keys.publicJwk);
  const storage = env.OAUTH_SESSIONS.storage(`connection:${handle}`);
  const oldAlarm = storage.alarm;
  const proof = await makeProof(keys.privateKey, "/refresh", handle);

  const response = await worker.fetch(request("/refresh", proof), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    access_token: "access-two",
    bot_id: "bot-id",
    workspace_id: "workspace-id"
  });
  assert.deepEqual(calls[1].body, { grant_type: "refresh_token", refresh_token: "refresh-one" });
  const record = await storage.get("record");
  assert.equal(JSON.stringify(record).includes("refresh-two"), false);
  assert.equal(record.nonces[proof.nonce] > Date.now(), true);
  assert.ok(storage.alarm >= oldAlarm);

  const replay = await worker.fetch(request("/refresh", proof), env);
  assert.equal(replay.status, 409);
  assert.equal(calls.length, 2);
});

test("concurrent refreshes allow exactly one rotation and deny the other while it is in progress", async () => {
  let releaseRefresh;
  const refreshStarted = new Promise((resolve) => { releaseRefresh = resolve; });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let refreshCalls = 0;
  const env = makeEnv(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.grant_type === "authorization_code") return notionResponse(tokenPayload("access-one", "refresh-one"));
    refreshCalls += 1;
    signalStarted();
    await refreshStarted;
    return notionResponse(tokenPayload("access-two", "refresh-two"));
  });
  const keys = await makeSigningKeys();
  const handle = await connect(env, keys.publicJwk);
  const firstProof = await makeProof(keys.privateKey, "/refresh", handle);
  const secondProof = await makeProof(keys.privateKey, "/refresh", handle);

  const firstPromise = worker.fetch(request("/refresh", firstProof), env);
  await started;
  const second = await worker.fetch(request("/refresh", secondProof), env);
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /in progress/);
  releaseRefresh();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.equal(refreshCalls, 1);
});

test("a stale operation lease recovers while a Notion timeout releases its live lease", async () => {
  let timeOutRefresh = false;
  const env = makeEnv(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.grant_type === "authorization_code") return notionResponse(tokenPayload("access-one", "refresh-one"));
    if (timeOutRefresh) {
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
        options.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(options.signal.reason);
        }, { once: true });
      });
    }
    return notionResponse(tokenPayload("access-two", "refresh-two"));
  });
  env.NOTION_REQUEST_TIMEOUT_MS = 5;
  const keys = await makeSigningKeys();
  const handle = await connect(env, keys.publicJwk);
  const storage = env.OAUTH_SESSIONS.storage(`connection:${handle}`);
  const crashed = await storage.get("record");
  crashed.operation_id = "crashed-operation";
  crashed.operation_expires_at = Date.now() - 1;
  await storage.put("record", crashed);

  const recovered = await worker.fetch(request("/refresh", await makeProof(keys.privateKey, "/refresh", handle)), env);
  assert.equal(recovered.status, 200);
  assert.equal((await storage.get("record")).operation_id, null);

  timeOutRefresh = true;
  const timedOut = await worker.fetch(request("/refresh", await makeProof(keys.privateKey, "/refresh", handle)), env);
  assert.equal(timedOut.status, 504);
  assert.match((await timedOut.json()).error, /timed out/);
  assert.equal((await storage.get("record")).operation_id, null);
});

test("refresh rejects expired and forged proofs without forwarding", async () => {
  let calls = 0;
  const env = makeEnv(async (_url, options) => {
    calls += 1;
    if (JSON.parse(options.body).grant_type === "authorization_code") {
      return notionResponse(tokenPayload("access", "refresh"));
    }
    throw new Error("refresh must not be forwarded");
  });
  const owner = await makeSigningKeys();
  const attacker = await makeSigningKeys();
  const handle = await connect(env, owner.publicJwk);

  const staleTimestamp = String(Date.now() - 300_001);
  const staleNonce = randomNonce();
  const stale = await worker.fetch(request("/refresh", {
    connection_handle: handle,
    timestamp: staleTimestamp,
    nonce: staleNonce,
    signature: await sign(owner.privateKey, ["/refresh", handle, staleTimestamp, staleNonce, ""].join("\n"))
  }), env);
  assert.equal(stale.status, 401);

  const forged = await makeProof(attacker.privateKey, "/refresh", handle);
  const forgedResponse = await worker.fetch(request("/refresh", forged), env);
  assert.equal(forgedResponse.status, 401);
  assert.equal(calls, 1);
});

test("revoke deletes local custody even when Notion rejects revocation", async () => {
  const env = makeEnv(async (url, options) => {
    if (url.endsWith("/token")) return notionResponse(tokenPayload("access", "refresh"));
    assert.deepEqual(JSON.parse(options.body), { token: "access" });
    return notionResponse({ code: "service_unavailable" }, 503);
  });
  const keys = await makeSigningKeys();
  const handle = await connect(env, keys.publicJwk);
  const proof = await makeProof(keys.privateKey, "/revoke", handle, "access");
  proof.token = "access";

  const response = await worker.fetch(request("/revoke", proof), env);
  assert.equal(response.status, 503);
  assert.equal(await env.OAUTH_SESSIONS.storage(`connection:${handle}`).get("record"), undefined);
});

test("retire requires device proof and deletes custody without calling Notion", async () => {
  let calls = 0;
  const env = makeEnv(async (_url, options) => {
    calls += 1;
    return notionResponse(tokenPayload("access", "refresh"));
  });
  const keys = await makeSigningKeys();
  const handle = await connect(env, keys.publicJwk);
  assert.equal(calls, 1);

  const proof = await makeProof(keys.privateKey, "/retire", handle);
  const response = await worker.fetch(request("/retire", proof), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls, 1);
  assert.equal(await env.OAUTH_SESSIONS.storage(`connection:${handle}`).get("record"), undefined);
});

test("rate limiting fails with 429 and uses stable device/connection keys rather than request IP", async () => {
  const keys = await makeSigningKeys();
  const limiter = new MemoryRateLimiter(({ key }) => !key.startsWith("device:"));
  const env = makeEnv(undefined, limiter);
  const denied = await worker.fetch(request("/start", { redirect_uri: REDIRECT_URI, public_key: keys.publicJwk }), env);
  assert.equal(denied.status, 429);
  assert.match(limiter.keys[0], /^device:[A-Za-z0-9_-]{43}$/);

  const allowedEnv = makeEnv(async () => notionResponse(tokenPayload("access", "refresh")));
  const handle = await connect(allowedEnv, keys.publicJwk);
  allowedEnv.OAUTH_RATE_LIMITER.predicate = ({ key }) => !key.startsWith("connection:");
  const proof = await makeProof(keys.privateKey, "/refresh", handle);
  const connectionDenied = await worker.fetch(request("/refresh", proof), allowedEnv);
  assert.equal(connectionDenied.status, 429);
  assert.equal(allowedEnv.OAUTH_RATE_LIMITER.keys.at(-1), `connection:${handle}`);
});

test("alarms remove abandoned transaction and connection records", async () => {
  const env = makeEnv(async () => notionResponse(tokenPayload("access", "refresh")));
  const keys = await makeSigningKeys();
  const state = await start(env, keys.publicJwk);
  await env.OAUTH_SESSIONS.alarm(`transaction:${state}`);
  assert.equal(await env.OAUTH_SESSIONS.storage(`transaction:${state}`).get("record"), undefined);

  const handle = await connect(env, keys.publicJwk);
  await env.OAUTH_SESSIONS.alarm(`connection:${handle}`);
  assert.equal(await env.OAUTH_SESSIONS.storage(`connection:${handle}`).get("record"), undefined);
});

test("rejects missing, null, and hostile origins without creating Durable Objects", async () => {
  const env = makeEnv();
  const keys = await makeSigningKeys();
  for (const origin of [undefined, "null", "https://hostile.example"]) {
    const response = await worker.fetch(request("/start", {
      redirect_uri: REDIRECT_URI,
      public_key: keys.publicJwk
    }, origin), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(env.OAUTH_SESSIONS.instances.size, 0);
});

test("allows preflight only for the configured extension origin and rejects malformed bodies", async () => {
  const env = makeEnv();
  const allowed = await worker.fetch(request("/refresh", null, ORIGIN, "OPTIONS"), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const denied = await worker.fetch(request("/refresh", null, "null", "OPTIONS"), env);
  assert.equal(denied.status, 403);

  const malformed = new Request("https://broker.example/refresh", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal((await worker.fetch(malformed, env)).status, 400);
  assert.equal((await worker.fetch(request("/refresh", { signature: "x".repeat(17 * 1024) }), env)).status, 413);
});

class MemoryStorage {
  entries = new Map();
  alarm = null;
  queue = Promise.resolve();

  async get(key) {
    const value = this.entries.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key, value) {
    this.entries.set(key, structuredClone(value));
  }

  async delete(key) {
    this.entries.delete(key);
  }

  async deleteAll() {
    this.entries.clear();
  }

  async setAlarm(timestamp) {
    this.alarm = timestamp;
  }

  async deleteAlarm() {
    this.alarm = null;
  }

  async transaction(callback) {
    let release;
    const previous = this.queue;
    this.queue = new Promise((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone(this.entries);
    try {
      return await callback(this);
    } catch (error) {
      this.entries = snapshot;
      throw error;
    } finally {
      release();
    }
  }
}

class MemoryDurableObjectNamespace {
  instances = new Map();

  constructor(env) {
    this.env = env;
  }

  idFromName(name) {
    return name;
  }

  get(id) {
    return { fetch: (url, options) => this.instance(id).object.fetch(new Request(url, options)) };
  }

  storage(name) {
    return this.instance(name).storage;
  }

  alarm(name) {
    return this.instance(name).object.alarm();
  }

  instance(name) {
    if (!this.instances.has(name)) {
      const storage = new MemoryStorage();
      const state = { storage };
      this.instances.set(name, { storage, object: new OAuthSession(state, this.env) });
    }
    return this.instances.get(name);
  }
}

class MemoryRateLimiter {
  keys = [];

  constructor(predicate = () => true) {
    this.predicate = predicate;
  }

  async limit(options) {
    this.keys.push(options.key);
    return { success: this.predicate(options) };
  }
}

function makeEnv(fetchImpl = async () => {
  throw new Error("Unexpected Notion request");
}, rateLimiter = new MemoryRateLimiter()) {
  const env = {
    NOTION_CLIENT_ID: "client",
    NOTION_CLIENT_SECRET: "secret",
    ALLOWED_EXTENSION_IDS: EXTENSION_ID,
    ALLOWED_ORIGINS: ORIGIN,
    TOKEN_ENCRYPTION_KEY: encodeBase64Url(new Uint8Array(32).fill(7)),
    OAUTH_RATE_LIMITER: rateLimiter,
    FETCH: fetchImpl
  };
  env.OAUTH_SESSIONS = new MemoryDurableObjectNamespace(env);
  return env;
}

async function start(env, publicKey) {
  const response = await worker.fetch(request("/start", { redirect_uri: REDIRECT_URI, public_key: publicKey }), env);
  assert.equal(response.status, 200);
  return (await response.json()).state;
}

async function connect(env, publicKey) {
  const state = await start(env, publicKey);
  const response = await worker.fetch(request("/exchange", {
    code: "code", redirect_uri: REDIRECT_URI, state
  }), env);
  assert.equal(response.status, 200);
  return (await response.json()).connection_handle;
}

async function makeProof(privateKey, path, connectionHandle, token = "") {
  const timestamp = String(Date.now());
  const nonce = randomNonce();
  return {
    connection_handle: connectionHandle,
    timestamp,
    nonce,
    signature: await sign(privateKey, [path, connectionHandle, timestamp, nonce, token].join("\n"))
  };
}

async function makeSigningKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  delete publicJwk.alg;
  delete publicJwk.key_ops;
  delete publicJwk.ext;
  return { privateKey: pair.privateKey, publicJwk };
}

async function sign(privateKey, canonical) {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(canonical)
  );
  return encodeBase64Url(new Uint8Array(signature));
}

function tokenPayload(accessToken, refreshToken) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    bot_id: "bot-id",
    workspace_id: "workspace-id"
  };
}

function notionResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function randomNonce() {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)));
}

function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function request(path, body, origin = ORIGIN, method = "POST") {
  const resolvedOrigin = arguments.length < 3 ? ORIGIN : arguments[2];
  const headers = { "Content-Type": "application/json" };
  if (resolvedOrigin !== undefined) headers.Origin = resolvedOrigin;
  return new Request(`https://broker.example${path}`, {
    method,
    headers,
    ...(body === null ? {} : { body: JSON.stringify(body) })
  });
}
