import test from "node:test";
import assert from "node:assert/strict";
import worker, { OAuthSession } from "../oauth-worker/src/index.js";
import type {
  ConfiguredOAuthWorkerEnv,
  OAuthConnectionRecord,
  OAuthRateLimiter,
  OAuthSessionId,
  OAuthSessionNamespace,
  OAuthSessionState,
  OAuthStorage,
  OAuthStoredRecord,
  OAuthTransactionRecord,
  WorkerFetch
} from "../oauth-worker/src/contracts.js";

interface NotionCall {
  url: string;
  body: Record<string, unknown>;
}

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
  const stored = transactionRecord(await storage.get("record"));
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
  const calls: NotionCall[] = [];
  const env = makeEnv(async (url, options) => {
    calls.push({ url: String(url), body: requestBody(options) });
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
  assert.ok(successResponse);
  const payload = await successResponse.json();
  assert.equal(payload.access_token, "access-one");
  assert.equal(payload.refresh_token, undefined);
  assert.match(payload.connection_handle, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await env.OAUTH_SESSIONS.storage(`transaction:${state}`).get("record")), undefined);
  assert.deepEqual(requiredItem(calls, 0).body, {
    grant_type: "authorization_code",
    code: "authorization-code",
    redirect_uri: REDIRECT_URI
  });

  const connectionStorage = env.OAUTH_SESSIONS.storage(`connection:${payload.connection_handle}`);
  const record = connectionRecord(await connectionStorage.get("record"));
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

  const malformedEnv = makeEnv(async () => notionResponse({
    ...tokenPayload("access", "refresh"),
    workspace_name: 42
  }));
  const malformedState = await start(malformedEnv, keys.publicJwk);
  const malformed = await worker.fetch(request("/exchange", {
    code: "code", redirect_uri: REDIRECT_URI, state: malformedState
  }), malformedEnv);
  assert.equal(malformed.status, 502);
});

test("refresh verifies proof, rotates custody, rejects replay, and renews the inactivity alarm", async () => {
  const calls: NotionCall[] = [];
  const env = makeEnv(async (url, options) => {
    const body = requestBody(options);
    calls.push({ url: String(url), body });
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
  assert.deepEqual(requiredItem(calls, 1).body, { grant_type: "refresh_token", refresh_token: "refresh-one" });
  const record = connectionRecord(await storage.get("record"));
  assert.equal(JSON.stringify(record).includes("refresh-two"), false);
  const nonceExpiry = record.nonces[proof.nonce];
  assert.ok(nonceExpiry && nonceExpiry > Date.now());
  assert.ok(storage.alarm !== null && oldAlarm !== null && storage.alarm >= oldAlarm);

  const replay = await worker.fetch(request("/refresh", proof), env);
  assert.equal(replay.status, 409);
  assert.equal(calls.length, 2);
});

test("concurrent refreshes allow exactly one rotation and deny the other while it is in progress", async () => {
  let releaseRefresh: (() => void) | undefined;
  const refreshStarted = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let refreshCalls = 0;
  const env = makeEnv(async (_url, options) => {
    const body = requestBody(options);
    if (body.grant_type === "authorization_code") return notionResponse(tokenPayload("access-one", "refresh-one"));
    refreshCalls += 1;
    assert.ok(signalStarted);
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
  assert.ok(releaseRefresh);
  releaseRefresh();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.equal(refreshCalls, 1);
});

test("a stale operation lease recovers while a Notion timeout releases its live lease", async () => {
  let timeOutRefresh = false;
  const env = makeEnv(async (_url, options) => {
    const body = requestBody(options);
    if (body.grant_type === "authorization_code") return notionResponse(tokenPayload("access-one", "refresh-one"));
    if (timeOutRefresh) {
      return new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
        const signal = options.signal;
        assert.ok(signal);
        signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(signal.reason);
        }, { once: true });
      });
    }
    return notionResponse(tokenPayload("access-two", "refresh-two"));
  });
  env.NOTION_REQUEST_TIMEOUT_MS = "5";
  const keys = await makeSigningKeys();
  const handle = await connect(env, keys.publicJwk);
  const storage = env.OAUTH_SESSIONS.storage(`connection:${handle}`);
  const crashed = connectionRecord(await storage.get("record"));
  crashed.operation_id = "crashed-operation";
  crashed.operation_expires_at = Date.now() - 1;
  await storage.put("record", crashed);

  const recovered = await worker.fetch(request("/refresh", await makeProof(keys.privateKey, "/refresh", handle)), env);
  assert.equal(recovered.status, 200);
  assert.equal(connectionRecord(await storage.get("record")).operation_id, null);

  timeOutRefresh = true;
  const timedOut = await worker.fetch(request("/refresh", await makeProof(keys.privateKey, "/refresh", handle)), env);
  assert.equal(timedOut.status, 504);
  assert.match((await timedOut.json()).error, /timed out/);
  assert.equal(connectionRecord(await storage.get("record")).operation_id, null);
});

test("refresh rejects expired and forged proofs without forwarding", async () => {
  let calls = 0;
  const env = makeEnv(async (_url, options) => {
    calls += 1;
    if (requestBody(options).grant_type === "authorization_code") {
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
    if (String(url).endsWith("/token")) return notionResponse(tokenPayload("access", "refresh"));
    assert.deepEqual(requestBody(options), { token: "access" });
    return notionResponse({ code: "service_unavailable" }, 503);
  });
  const keys = await makeSigningKeys();
  const handle = await connect(env, keys.publicJwk);
  const proof = { ...(await makeProof(keys.privateKey, "/revoke", handle, "access")), token: "access" };

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
  assert.match(requiredItem(limiter.keys, 0), /^device:[A-Za-z0-9_-]{43}$/);

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

class MemoryStorage implements OAuthStorage {
  entries = new Map<string, OAuthStoredRecord>();
  alarm: number | null = null;
  queue: Promise<void> = Promise.resolve();

  async get(key: "record"): Promise<OAuthStoredRecord | undefined> {
    const value = this.entries.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key: "record", value: OAuthStoredRecord): Promise<void> {
    this.entries.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.entries.clear();
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone(this.entries);
    try {
      return await callback(this);
    } catch (error) {
      this.entries = snapshot;
      throw error;
    } finally {
      assert.ok(release);
      release();
    }
  }
}

interface MemoryInstance {
  storage: MemoryStorage;
  object: OAuthSession;
}

class MemoryDurableObjectNamespace implements OAuthSessionNamespace {
  instances = new Map<string, MemoryInstance>();

  constructor(private readonly loadEnv: () => ConfiguredOAuthWorkerEnv) {}

  idFromName(name: string): OAuthSessionId {
    return name;
  }

  get(id: OAuthSessionId): { fetch(request: Request): Promise<Response> } {
    return { fetch: (request) => this.instance(String(id)).object.fetch(request) };
  }

  storage(name: string): MemoryStorage {
    return this.instance(name).storage;
  }

  alarm(name: string): Promise<void> {
    return this.instance(name).object.alarm();
  }

  instance(name: string): MemoryInstance {
    if (!this.instances.has(name)) {
      const storage = new MemoryStorage();
      const state = { storage };
      this.instances.set(name, { storage, object: new OAuthSession(state, this.loadEnv()) });
    }
    const instance = this.instances.get(name);
    assert.ok(instance);
    return instance;
  }
}

type RateLimitPredicate = (options: { key: string }) => boolean;

class MemoryRateLimiter implements OAuthRateLimiter {
  keys: string[] = [];
  predicate: RateLimitPredicate;

  constructor(predicate: RateLimitPredicate = () => true) {
    this.predicate = predicate;
  }

  async limit(options: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(options.key);
    return { success: this.predicate(options) };
  }
}

interface TestEnv extends ConfiguredOAuthWorkerEnv {
  OAUTH_SESSIONS: MemoryDurableObjectNamespace;
  OAUTH_RATE_LIMITER: MemoryRateLimiter;
}

function makeEnv(fetchImpl: WorkerFetch = async () => {
  throw new Error("Unexpected Notion request");
}, rateLimiter = new MemoryRateLimiter()): TestEnv {
  let env: TestEnv;
  const sessions = new MemoryDurableObjectNamespace(() => env);
  env = {
    NOTION_CLIENT_ID: "client",
    NOTION_CLIENT_SECRET: "secret",
    ALLOWED_EXTENSION_IDS: EXTENSION_ID,
    ALLOWED_ORIGINS: ORIGIN,
    TOKEN_ENCRYPTION_KEY: encodeBase64Url(new Uint8Array(32).fill(7)),
    OAUTH_SESSIONS: sessions,
    OAUTH_RATE_LIMITER: rateLimiter,
    FETCH: fetchImpl
  };
  return env;
}

async function start(env: TestEnv, publicKey: JsonWebKey): Promise<string> {
  const response = await worker.fetch(request("/start", { redirect_uri: REDIRECT_URI, public_key: publicKey }), env);
  assert.equal(response.status, 200);
  return (await response.json()).state;
}

async function connect(env: TestEnv, publicKey: JsonWebKey): Promise<string> {
  const state = await start(env, publicKey);
  const response = await worker.fetch(request("/exchange", {
    code: "code", redirect_uri: REDIRECT_URI, state
  }), env);
  assert.equal(response.status, 200);
  return (await response.json()).connection_handle;
}

async function makeProof(
  privateKey: CryptoKey,
  path: "/refresh" | "/revoke" | "/retire",
  connectionHandle: string,
  token = ""
): Promise<{ connection_handle: string; timestamp: string; nonce: string; signature: string }> {
  const timestamp = String(Date.now());
  const nonce = randomNonce();
  return {
    connection_handle: connectionHandle,
    timestamp,
    nonce,
    signature: await sign(privateKey, [path, connectionHandle, timestamp, nonce, token].join("\n"))
  };
}

async function makeSigningKeys(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  delete publicJwk.alg;
  delete publicJwk.key_ops;
  delete publicJwk.ext;
  return { privateKey: pair.privateKey, publicJwk };
}

async function sign(privateKey: CryptoKey, canonical: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(canonical)
  );
  return encodeBase64Url(new Uint8Array(signature));
}

function tokenPayload(accessToken: string, refreshToken: string): Record<string, unknown> {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    bot_id: "bot-id",
    workspace_id: "workspace-id"
  };
}

function notionResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function randomNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)));
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function request(path: string, body: unknown, origin: string | undefined = ORIGIN, method = "POST"): Request {
  const resolvedOrigin = arguments.length < 3 ? ORIGIN : arguments[2];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (resolvedOrigin !== undefined) headers.Origin = resolvedOrigin;
  return new Request(`https://broker.example${path}`, {
    method,
    headers,
    ...(body === null ? {} : { body: JSON.stringify(body) })
  });
}

function requestBody(init: RequestInit): Record<string, unknown> {
  const body = init.body;
  if (typeof body !== "string") assert.fail("Expected a JSON request body.");
  const parsed: unknown = JSON.parse(body);
  assert.ok(isRecord(parsed));
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item);
  return item;
}

function transactionRecord(value: OAuthStoredRecord | undefined): OAuthTransactionRecord {
  assert.ok(value && value.type === "transaction");
  return value;
}

function connectionRecord(value: OAuthStoredRecord | undefined): OAuthConnectionRecord {
  assert.ok(value && value.type === "connection");
  return value;
}
