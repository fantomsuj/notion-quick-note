// @ts-nocheck
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
const MAX_REQUEST_BYTES = 16 * 1024;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const PROOF_TOLERANCE_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const CONNECTION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const OPERATION_LEASE_MS = 60 * 1000;
const NOTION_REQUEST_TIMEOUT_MS = 30 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return isAllowedOrigin(request, env)
        ? new Response(null, { status: 204, headers: cors })
        : json({ error: "Origin is not allowlisted" }, 403, cors);
    }
    if (url.pathname === "/health") {
      try {
        validateEnvironment(env);
        return json({ ok: true }, 200, cors);
      } catch (error) {
        return json({ ok: false, error: error.message }, error.status || 503, cors);
      }
    }
    if (request.method !== "POST" || !["/start", "/exchange", "/refresh", "/revoke", "/retire"].includes(url.pathname)) {
      return json({ error: "Not found" }, 404, cors);
    }
    if (!isAllowedOrigin(request, env)) return json({ error: "Origin is not allowlisted" }, 403, cors);

    try {
      validateEnvironment(env);
      const body = await readJsonBody(request);
      const result = await routeRequest(url.pathname, body, env);
      return json(result.payload, result.status, cors);
    } catch (error) {
      return json({ error: error.message || "OAuth exchange failed" }, error.status || 500, cors);
    }
  }
};

// Every transaction and connection gets its own Durable Object. This makes
// one-time state consumption, nonce use, and refresh-token rotation strongly
// consistent without putting every installation behind a global lock.
export class OAuthSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      let result;
      if (path === "/transaction/create") result = await this.createTransaction(body);
      else if (path === "/transaction/consume") result = await this.consumeTransaction(body);
      else if (path === "/connection/create") result = await this.createConnection(body);
      else if (path === "/connection/refresh") result = await this.refreshConnection(body);
      else if (path === "/connection/revoke") result = await this.revokeConnection(body);
      else if (path === "/connection/retire") result = await this.retireConnection(body);
      else throw httpError("Not found", 404);
      return json(result.payload, result.status, {});
    } catch (error) {
      return json({ error: error.message || "OAuth session failed" }, error.status || 500, {});
    }
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }

  async createTransaction(body) {
    const existing = await this.state.storage.get("record");
    if (existing) throw httpError("OAuth transaction already exists", 409);
    const now = Date.now();
    await this.state.storage.put("record", {
      type: "transaction",
      redirect_uri: body.redirect_uri,
      public_key: body.public_key,
      expires_at: now + TRANSACTION_TTL_MS
    });
    await this.state.storage.setAlarm(now + TRANSACTION_TTL_MS);
    return success({ ok: true }, 201);
  }

  async consumeTransaction(body) {
    let transaction;
    let failure;
    await this.state.storage.transaction(async (storage) => {
      transaction = await storage.get("record");
      if (!transaction || transaction.type !== "transaction" || transaction.expires_at <= Date.now()) {
        await storage.delete("record");
        failure = "OAuth transaction is invalid or expired";
        return;
      }
      // Consume before redirect validation or any external request. Every code
      // exchange attempt is single-use, including malformed/failed attempts.
      await storage.delete("record");
      if (transaction.redirect_uri !== body.redirect_uri) {
        failure = "OAuth transaction redirect does not match";
      }
    });
    await this.state.storage.deleteAlarm();
    if (failure) throw httpError(failure, 400);
    return success({ public_key: transaction.public_key });
  }

  async createConnection(body) {
    const existing = await this.state.storage.get("record");
    if (existing) throw httpError("OAuth connection already exists", 409);
    const now = Date.now();
    await this.state.storage.put("record", {
      type: "connection",
      handle: body.handle,
      public_key: body.public_key,
      refresh_token: body.refresh_token,
      bot_id: body.bot_id,
      workspace_id: body.workspace_id,
      created_at: now,
      updated_at: now,
      expires_at: now + CONNECTION_TTL_MS,
      operation_id: null,
      operation_expires_at: 0,
      nonces: {}
    });
    await this.state.storage.setAlarm(now + CONNECTION_TTL_MS);
    return success({ ok: true }, 201);
  }

  async refreshConnection(body) {
    const { handle, record, operationId } = await this.authenticateAndLock("/refresh", body, "");
    try {
      const refreshToken = await decryptRefreshToken(record.refresh_token, handle, this.env.TOKEN_ENCRYPTION_KEY);
      const notion = await notionRequest(NOTION_TOKEN_URL, {
        grant_type: "refresh_token",
        refresh_token: refreshToken
      }, this.env);
      if (!notion.ok) {
        await this.releaseLock(operationId);
        return notion;
      }
      requireTokenFields(notion.payload, ["access_token", "refresh_token"]);
      const encrypted = await encryptRefreshToken(notion.payload.refresh_token, handle, this.env.TOKEN_ENCRYPTION_KEY);
      const now = Date.now();
      await this.state.storage.transaction(async (storage) => {
        const current = await storage.get("record");
        if (!current || current.type !== "connection") throw httpError("Connection is invalid or expired", 401);
        if (current.operation_id !== operationId) {
          throw httpError("Connection operation lease expired", 409);
        }
        current.refresh_token = encrypted;
        current.updated_at = now;
        current.expires_at = now + CONNECTION_TTL_MS;
        current.operation_id = null;
        current.operation_expires_at = 0;
        await storage.put("record", current);
      });
      await this.state.storage.setAlarm(now + CONNECTION_TTL_MS);
      return success(withoutRefreshToken(notion.payload));
    } catch (error) {
      await this.releaseLock(operationId);
      throw error;
    }
  }

  async revokeConnection(body) {
    if (typeof body.token !== "string" || !body.token) throw httpError("token is required", 400);
    await this.authenticateAndLock("/revoke", body, body.token);
    try {
      return await notionRequest(NOTION_REVOKE_URL, { token: body.token }, this.env);
    } finally {
      // Local custody must end even when Notion is unavailable or rejects the
      // revocation request. A reconnect can then create an independent handle.
      await this.state.storage.deleteAll();
      await this.state.storage.deleteAlarm();
    }
  }

  async retireConnection(body) {
    await this.authenticateAndLock("/retire", body, "");
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
    return success({ ok: true });
  }

  async authenticateAndLock(path, body, token) {
    validateProofShape(body);
    const initial = await this.state.storage.get("record");
    if (!initial || initial.type !== "connection" || initial.expires_at <= Date.now()) {
      if (initial?.expires_at <= Date.now()) await this.state.storage.deleteAll();
      throw httpError("Connection is invalid or expired", 401);
    }
    if (initial.handle !== body.connection_handle) throw httpError("Connection is invalid or expired", 401);

    const canonical = [path, initial.handle, body.timestamp, body.nonce, token].join("\n");
    if (!await verifySignature(initial.public_key, body.signature, canonical)) {
      throw httpError("Invalid proof signature", 401);
    }

    let locked;
    const now = Date.now();
    const operationId = randomBase64Url(18);
    await this.state.storage.transaction(async (storage) => {
      const current = await storage.get("record");
      if (!current || current.type !== "connection" || current.expires_at <= now) {
        throw httpError("Connection is invalid or expired", 401);
      }
      current.nonces = Object.fromEntries(
        Object.entries(current.nonces || {}).filter(([, expiresAt]) => expiresAt > now)
      );
      if (current.nonces[body.nonce]) throw httpError("Proof nonce has already been used", 409);
      if (current.operation_id && current.operation_expires_at > now) {
        throw httpError("Another connection operation is in progress", 409);
      }
      current.nonces[body.nonce] = now + NONCE_TTL_MS;
      current.operation_id = operationId;
      current.operation_expires_at = now + OPERATION_LEASE_MS;
      await storage.put("record", current);
      locked = current;
    });
    return { handle: initial.handle, record: locked, operationId };
  }

  async releaseLock(operationId) {
    await this.state.storage.transaction(async (storage) => {
      const current = await storage.get("record");
      if (!current || current.type !== "connection") return;
      // A timed-out request must never release a newer request's lease.
      if (current.operation_id !== operationId) return;
      current.operation_id = null;
      current.operation_expires_at = 0;
      await storage.put("record", current);
    });
  }
}

async function routeRequest(path, body, env) {
  if (path === "/start") return startTransaction(body, env);
  if (path === "/exchange") return exchangeCode(body, env);
  return connectionRequest(path, body, env);
}

async function startTransaction(body, env) {
  const redirectUri = requireAllowedRedirect(body.redirect_uri, env);
  const publicKey = await validatePublicKey(body.public_key);
  await enforceRateLimit(env, `device:${await publicKeyFingerprint(publicKey)}`);
  const state = randomBase64Url(32);
  const result = await callSession(env, `transaction:${state}`, "/transaction/create", {
    redirect_uri: redirectUri,
    public_key: publicKey
  });
  if (result.status >= 400) return result;
  return success({ state });
}

async function exchangeCode(body, env) {
  if (typeof body.code !== "string" || !body.code) throw httpError("code is required", 400);
  if (typeof body.state !== "string" || !body.state) throw httpError("state is required", 400);
  const redirectUri = requireAllowedRedirect(body.redirect_uri, env);
  const consumed = await callSession(env, `transaction:${body.state}`, "/transaction/consume", {
    redirect_uri: redirectUri
  });
  if (consumed.status >= 400) return consumed;
  await enforceRateLimit(env, `device:${await publicKeyFingerprint(consumed.payload.public_key)}`);

  const notion = await notionRequest(NOTION_TOKEN_URL, {
    grant_type: "authorization_code",
    code: body.code,
    redirect_uri: redirectUri
  }, env);
  if (!notion.ok) return notion;
  requireTokenFields(notion.payload, ["access_token", "refresh_token", "bot_id", "workspace_id"]);

  const connectionHandle = randomBase64Url(32);
  const encrypted = await encryptRefreshToken(notion.payload.refresh_token, connectionHandle, env.TOKEN_ENCRYPTION_KEY);
  const created = await callSession(env, `connection:${connectionHandle}`, "/connection/create", {
    handle: connectionHandle,
    public_key: consumed.payload.public_key,
    refresh_token: encrypted,
    bot_id: notion.payload.bot_id,
    workspace_id: notion.payload.workspace_id
  });
  if (created.status >= 400) return created;
  return success({ ...withoutRefreshToken(notion.payload), connection_handle: connectionHandle });
}

async function connectionRequest(path, body, env) {
  const handle = body.connection_handle;
  if (typeof handle !== "string" || !handle) throw httpError("connection_handle is required", 400);
  await enforceRateLimit(env, `connection:${handle}`);
  return callSession(env, `connection:${handle}`, `/connection${path}`, body);
}

async function callSession(env, name, path, body) {
  const id = env.OAUTH_SESSIONS.idFromName(name);
  const response = await env.OAUTH_SESSIONS.get(id).fetch(`https://oauth-session${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

async function enforceRateLimit(env, key) {
  const result = await env.OAUTH_RATE_LIMITER.limit({ key });
  if (!result?.success) throw httpError("Too many OAuth requests", 429);
}

async function publicKeyFingerprint(publicKey) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${publicKey.crv}.${publicKey.x}.${publicKey.y}`)
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function validateProofShape(body) {
  if (typeof body.connection_handle !== "string" || !body.connection_handle) {
    throw httpError("connection_handle is required", 400);
  }
  if (typeof body.timestamp !== "string" || !/^\d{13}$/.test(body.timestamp)) {
    throw httpError("timestamp must be Unix milliseconds", 400);
  }
  const timestamp = Number(body.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > PROOF_TOLERANCE_MS) {
    throw httpError("Proof timestamp is expired", 401);
  }
  if (typeof body.nonce !== "string" || body.nonce.length < 16 || body.nonce.length > 128 || !/^[A-Za-z0-9_-]+$/.test(body.nonce)) {
    throw httpError("nonce must be base64url", 400);
  }
  if (typeof body.signature !== "string" || !body.signature) throw httpError("signature is required", 400);
}

async function verifySignature(publicJwk, encodedSignature, canonical) {
  let signature;
  try {
    signature = decodeBase64(encodedSignature);
  } catch {
    throw httpError("signature must be base64url", 400);
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    new TextEncoder().encode(canonical)
  );
}

async function notionRequest(url, body, env) {
  const credentials = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
  const configuredTimeout = Number(env.NOTION_REQUEST_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, NOTION_REQUEST_TIMEOUT_MS)
    : NOTION_REQUEST_TIMEOUT_MS;
  let response;
  try {
    response = await (env.FETCH || fetch)(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Notion-Version": "2026-03-11"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw httpError("Notion OAuth request timed out", 504);
    }
    throw error;
  }
  return {
    ok: response.ok,
    status: response.status,
    payload: await response.json().catch(() => ({}))
  };
}

function requireTokenFields(payload, fields) {
  const missing = fields.filter((field) => typeof payload[field] !== "string" || !payload[field]);
  if (missing.length) throw httpError(`Notion token response is missing ${missing.join(", ")}`, 502);
}

function withoutRefreshToken(payload) {
  const { refresh_token: _refreshToken, ...safePayload } = payload;
  return safePayload;
}

async function validatePublicKey(jwk) {
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw httpError("public_key is required", 400);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw httpError("public_key must be an ECDSA P-256 public JWK", 400);
  }
  let x;
  let y;
  try {
    x = decodeBase64(jwk.x);
    y = decodeBase64(jwk.y);
  } catch {
    throw httpError("public_key must be an ECDSA P-256 public JWK", 400);
  }
  if (x.byteLength !== 32 || y.byteLength !== 32) {
    throw httpError("public_key must be an ECDSA P-256 public JWK", 400);
  }
  const sanitized = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true, key_ops: ["verify"] };
  try {
    await crypto.subtle.importKey("jwk", sanitized, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw httpError("public_key must be an ECDSA P-256 public JWK", 400);
  }
  return sanitized;
}

async function encryptRefreshToken(refreshToken, connectionHandle, encodedKey) {
  const key = await importEncryptionKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(connectionHandle) },
    key,
    new TextEncoder().encode(refreshToken)
  );
  return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(new Uint8Array(ciphertext)) };
}

async function decryptRefreshToken(encrypted, connectionHandle, encodedKey) {
  if (!encrypted || typeof encrypted.iv !== "string" || typeof encrypted.ciphertext !== "string") {
    throw httpError("Stored connection is invalid", 500);
  }
  try {
    const key = await importEncryptionKey(encodedKey);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64(encrypted.iv),
        additionalData: new TextEncoder().encode(connectionHandle)
      },
      key,
      decodeBase64(encrypted.ciphertext)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw httpError("Stored connection could not be decrypted", 500);
  }
}

function importEncryptionKey(encodedKey) {
  return crypto.subtle.importKey("raw", decodeEncryptionKey(encodedKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function decodeEncryptionKey(encodedKey) {
  let bytes;
  try {
    bytes = decodeBase64(encodedKey);
  } catch {
    throw httpError("TOKEN_ENCRYPTION_KEY must be a 32-byte base64 secret", 503);
  }
  if (bytes.byteLength !== 32) throw httpError("TOKEN_ENCRYPTION_KEY must be a 32-byte base64 secret", 503);
  return bytes;
}

function requireAllowedRedirect(redirectUri, env) {
  if (typeof redirectUri !== "string" || !redirectUri) throw httpError("redirect_uri is required", 400);
  if (!isAllowedRedirect(redirectUri, env)) throw httpError("Redirect URI is not allowlisted", 403);
  return redirectUri;
}

function isAllowedRedirect(redirectUri, env) {
  return commaSeparated(env.ALLOWED_EXTENSION_IDS)
    .some((id) => redirectUri === `https://${id}.chromiumapp.org/notion`);
}

function validateEnvironment(env) {
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    throw httpError("OAuth broker credentials are not configured", 503);
  }
  const allowedIds = commaSeparated(env.ALLOWED_EXTENSION_IDS);
  const allowedOrigins = commaSeparated(env.ALLOWED_ORIGINS);
  if (!allowedIds.length || !allowedOrigins.length) throw httpError("OAuth broker allowlists are not configured", 503);
  const invalidId = allowedIds.some((id) => !/^[a-p]{32}$/.test(id));
  const mismatchedOrigin = allowedOrigins.some((origin) => {
    const id = origin.match(/^chrome-extension:\/\/([a-p]{32})$/)?.[1];
    return !id || !allowedIds.includes(id);
  });
  if (invalidId || mismatchedOrigin) throw httpError("OAuth broker allowlists are invalid", 503);
  if (!env.OAUTH_SESSIONS || typeof env.OAUTH_SESSIONS.idFromName !== "function" || typeof env.OAUTH_SESSIONS.get !== "function") {
    throw httpError("OAuth durable storage is not configured", 503);
  }
  if (!env.OAUTH_RATE_LIMITER || typeof env.OAUTH_RATE_LIMITER.limit !== "function") {
    throw httpError("OAuth rate limiter is not configured", 503);
  }
  decodeEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
}

function commaSeparated(value = "") {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = commaSeparated(env.ALLOWED_ORIGINS);
  return {
    ...(allowedOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin"
  };
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  return commaSeparated(env.ALLOWED_ORIGINS).includes(origin);
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw httpError("Request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) throw httpError("Request body is too large", 413);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw httpError("Request body must be valid JSON", 400);
  }
}

function randomBase64Url(byteLength) {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error("invalid base64");
  const unpadded = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (unpadded.length % 4 === 1) throw new Error("invalid base64");
  const binary = atob(unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function success(payload, status = 200) {
  return { ok: true, status, payload };
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
