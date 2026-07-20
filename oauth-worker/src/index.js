const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
const MAX_REQUEST_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 8_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const OUTCOME_PATTERN = /^[a-z0-9_]{1,64}$/;
const KNOWN_ROUTES = new Set(["/health", "/exchange", "/refresh", "/revoke"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = requestIdFor(request, env);
    const now = env.NOW || Date.now;
    const startedAt = now();
    const response = await handleRequest(request, env, url, requestId);
    const outcome = await outcomeFor(response);
    emitCompletion(env, {
      event: "oauth_request_completed",
      requestId,
      method: request.method,
      path: KNOWN_ROUTES.has(url.pathname) ? url.pathname : "unknown",
      status: response.status,
      outcome,
      durationMs: Math.max(0, now() - startedAt)
    });
    return response;
  }
};

async function handleRequest(request, env, url, requestId) {
  const cors = { ...corsHeaders(request, env), "X-Request-ID": requestId };

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
      return json({
        ok: false,
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      }, error.status || 503, cors);
    }
  }
  if (request.method !== "POST" || !["/exchange", "/refresh", "/revoke"].includes(url.pathname)) {
    return json({ error: "Not found" }, 404, cors);
  }
  if (!isAllowedOrigin(request, env)) return json({ error: "Origin is not allowlisted" }, 403, cors);

  try {
    validateEnvironment(env);
    const allowed = await rateLimitRequest(request, url.pathname, env);
    if (!allowed) {
      return json(
        { error: "Too many requests", code: "rate_limited" },
        429,
        { ...cors, "Retry-After": "60" }
      );
    }
    const body = await readJsonBody(request);
    const { status, payload } = await forwardOauthRequest(url.pathname, body, env);
    return json(payload, status, cors);
  } catch (error) {
    return json({
      error: error.message || "OAuth exchange failed",
      ...(error.code ? { code: error.code } : {})
    }, error.status || 500, cors);
  }
}

function emitCompletion(env, entry) {
  if (env.LOG) {
    env.LOG(entry);
    return;
  }
  console.info(JSON.stringify(entry));
}

async function outcomeFor(response) {
  if (response.status < 400) return "success";
  try {
    const code = (await response.clone().json())?.code;
    if (typeof code === "string" && OUTCOME_PATTERN.test(code)) return code;
  } catch {
    // Fall back to the status class without retaining response content.
  }
  if (response.status === 429) return "rate_limited";
  if (response.status >= 500) return "server_error";
  if (response.status >= 400) return "client_error";
  return "success";
}

async function forwardOauthRequest(path, body, env) {
  const fetchImpl = env.FETCH || fetch;
  const credentials = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
  const headers = {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Notion-Version": "2026-03-11"
  };

  let url = NOTION_TOKEN_URL;
  let payload;
  if (path === "/exchange") {
    const code = requiredString(body, "code", "code and redirect_uri are required");
    const redirectUri = requiredString(body, "redirect_uri", "code and redirect_uri are required");
    if (!isAllowedRedirect(redirectUri, env)) throw httpError("Redirect URI is not allowlisted", 403);
    payload = { grant_type: "authorization_code", code, redirect_uri: redirectUri };
  } else if (path === "/refresh") {
    const refreshToken = requiredString(body, "refresh_token", "refresh_token is required");
    payload = { grant_type: "refresh_token", refresh_token: refreshToken };
  } else {
    const token = requiredString(body, "token", "token is required");
    url = NOTION_REVOKE_URL;
    payload = { token };
  }

  const controller = new AbortController();
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS) > 0
    ? Number(env.UPSTREAM_TIMEOUT_MS)
    : UPSTREAM_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const responsePayload = await readUpstreamJson(response);
    return { status: response.status, payload: responsePayload };
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw httpError("Notion OAuth request timed out", 504, "upstream_timeout");
    }
    if (error?.status) throw error;
    throw httpError("Notion OAuth is temporarily unavailable", 502, "upstream_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function requiredString(body, field, message) {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(message, 400, "invalid_request");
  }
  return value;
}

async function readUpstreamJson(response) {
  const contentType = response.headers.get("Content-Type") || "";
  if (!/\bapplication\/json\b/i.test(contentType)) {
    throw httpError("Notion OAuth returned an invalid response", 502, "invalid_upstream_response");
  }
  try {
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError();
    return payload;
  } catch {
    throw httpError("Notion OAuth returned an invalid response", 502, "invalid_upstream_response");
  }
}

function isAllowedRedirect(redirectUri, env) {
  try {
    const url = new URL(redirectUri);
    const allowedIds = (env.ALLOWED_EXTENSION_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
    return url.protocol === "https:"
      && allowedIds.some((id) => url.hostname === `${id}.chromiumapp.org`)
      && url.pathname === "/notion"
      && !url.search
      && !url.hash
      && !url.username
      && !url.password
      && !url.port;
  } catch {
    return false;
  }
}

function validateEnvironment(env) {
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    throw httpError("OAuth broker credentials are not configured", 503, "invalid_configuration");
  }
  const allowedIds = commaSeparated(env.ALLOWED_EXTENSION_IDS);
  const allowedOrigins = commaSeparated(env.ALLOWED_ORIGINS);
  if (!allowedIds.length || !allowedOrigins.length) {
    throw httpError("OAuth broker allowlists are not configured", 503, "invalid_configuration");
  }
  const invalidId = allowedIds.some((id) => !/^[a-p]{32}$/.test(id));
  const mismatchedOrigin = allowedOrigins.some((origin) => {
    const id = origin.match(/^chrome-extension:\/\/([a-p]{32})$/)?.[1];
    return !id || !allowedIds.includes(id);
  });
  if (invalidId || mismatchedOrigin) {
    throw httpError("OAuth broker allowlists are invalid", 503, "invalid_configuration");
  }
  if (typeof env.OAUTH_RATE_LIMITER?.limit !== "function") {
    throw httpError("OAuth broker rate limiter is not configured", 503, "invalid_configuration");
  }
}

async function rateLimitRequest(request, path, env) {
  const clientAddress = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    const result = await env.OAUTH_RATE_LIMITER.limit({ key: `${path}:${clientAddress}` });
    return result?.success === true;
  } catch {
    throw httpError(
      "OAuth broker rate limiter is unavailable",
      503,
      "rate_limiter_unavailable"
    );
  }
}

function requestIdFor(request, env) {
  const supplied = request.headers.get("X-Request-ID") || "";
  if (REQUEST_ID_PATTERN.test(supplied)) return supplied;
  const createUuid = env.UUID || (() => crypto.randomUUID());
  return createUuid();
}

function commaSeparated(value = "") {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = commaSeparated(env.ALLOWED_ORIGINS);
  return {
    ...(allowedOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "Content-Type, X-Request-ID",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After, X-Request-ID",
    Vary: "Origin"
  };
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  return commaSeparated(env.ALLOWED_ORIGINS).includes(origin);
}

async function readJsonBody(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw httpError("Content-Type must be application/json", 415, "unsupported_media_type");
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const validLength = /^\d+$/.test(contentLength);
    const declaredLength = Number(contentLength);
    if (!validLength || !Number.isSafeInteger(declaredLength) || declaredLength > MAX_REQUEST_BYTES) {
      throw httpError("Request body is too large or invalid", 413);
    }
  }

  const text = await readBoundedText(request);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError("Request body must be valid JSON", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("Request body must be a JSON object", 400, "invalid_request");
  }
  return body;
}

async function readBoundedText(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytesRead += value.byteLength;
    if (bytesRead > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw httpError("Request body is too large", 413);
    }
    text += decoder.decode(value, { stream: true });
  }
}

function httpError(message, status, code = "") {
  return Object.assign(new Error(message), { status, code });
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
