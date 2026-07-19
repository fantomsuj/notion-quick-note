const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
const MAX_REQUEST_BYTES = 16 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = requestIdFor(request, env);
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
        return json({ ok: false, error: error.message }, error.status || 503, cors);
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
      const notionResponse = await forwardOauthRequest(url.pathname, body, env);
      const payload = await notionResponse.json().catch(() => ({}));
      return json(payload, notionResponse.status, cors);
    } catch (error) {
      return json({
        error: error.message || "OAuth exchange failed",
        ...(error.code ? { code: error.code } : {})
      }, error.status || 500, cors);
    }
  }
};

function forwardOauthRequest(path, body, env) {
  const fetchImpl = env.FETCH || fetch;
  const credentials = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
  const headers = {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Notion-Version": "2026-03-11"
  };

  if (path === "/exchange") {
    const { code, redirect_uri: redirectUri } = body;
    if (!code || !redirectUri) return Promise.resolve(json({ error: "code and redirect_uri are required" }, 400, {}));
    if (!isAllowedRedirect(redirectUri, env)) return Promise.resolve(json({ error: "Redirect URI is not allowlisted" }, 403, {}));
    return fetchImpl(NOTION_TOKEN_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri })
    });
  }

  if (path === "/refresh") {
    if (!body.refresh_token) return Promise.resolve(json({ error: "refresh_token is required" }, 400, {}));
    return fetchImpl(NOTION_TOKEN_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: body.refresh_token })
    });
  }

  if (!body.token) return Promise.resolve(json({ error: "token is required" }, 400, {}));
  return fetchImpl(NOTION_REVOKE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ token: body.token })
  });
}

function isAllowedRedirect(redirectUri, env) {
  try {
    const url = new URL(redirectUri);
    const allowedIds = (env.ALLOWED_EXTENSION_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
    return url.protocol === "https:" && url.hostname.endsWith(".chromiumapp.org") && allowedIds.includes(url.hostname.split(".")[0]);
  } catch {
    return false;
  }
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
  if (typeof env.OAUTH_RATE_LIMITER?.limit !== "function") {
    throw httpError("OAuth broker rate limiter is not configured", 503, "invalid_configuration");
  }
}

async function rateLimitRequest(request, path, env) {
  const clientAddress = request.headers.get("CF-Connecting-IP") || "unknown";
  const result = await env.OAUTH_RATE_LIMITER.limit({ key: `${path}:${clientAddress}` });
  return result?.success === true;
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
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw httpError("Content-Type must be application/json", 415, "unsupported_media_type");
  }
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw httpError("Request body is too large", 413);

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw httpError("Request body is too large", 413);
  }
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

function httpError(message, status, code = "") {
  return Object.assign(new Error(message), { status, code });
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
