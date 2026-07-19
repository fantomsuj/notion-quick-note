import test from "node:test";
import assert from "node:assert/strict";
import worker from "../oauth-worker/src/index.js";

const env = {
  NOTION_CLIENT_ID: "client",
  NOTION_CLIENT_SECRET: "secret",
  ALLOWED_EXTENSION_IDS: "abcdefghijklmnopabcdefghijklmnop",
  ALLOWED_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  OAUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  UUID: () => "generated-request-id"
};

test("health fails closed until credentials and matching production allowlists exist", async () => {
  const healthy = await worker.fetch(new Request("https://broker.example/health"), env);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true });

  for (const invalid of [
    { ...env, NOTION_CLIENT_SECRET: "" },
    { ...env, ALLOWED_EXTENSION_IDS: "short" },
    { ...env, ALLOWED_ORIGINS: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" },
    { ...env, OAUTH_RATE_LIMITER: undefined }
  ]) {
    const response = await worker.fetch(new Request("https://broker.example/health"), invalid);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  }
});

test("rate limits each client and OAuth route before forwarding", async () => {
  const keys = [];
  let forwarded = false;
  const testEnv = {
    ...env,
    OAUTH_RATE_LIMITER: {
      async limit(input) {
        keys.push(input.key);
        return { success: false };
      }
    },
    FETCH: async () => {
      forwarded = true;
      throw new Error("should not forward");
    }
  };
  const oauthRequest = request("/refresh", { refresh_token: "refresh" });
  oauthRequest.headers.set("CF-Connecting-IP", "203.0.113.7");
  oauthRequest.headers.set("X-Request-ID", "caller-request-42");

  const response = await worker.fetch(oauthRequest, testEnv);

  assert.deepEqual(keys, ["/refresh:203.0.113.7"]);
  assert.equal(forwarded, false);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("X-Request-ID"), "caller-request-42");
  assert.deepEqual(await response.json(), { error: "Too many requests", code: "rate_limited" });
});

test("requires JSON object request bodies", async () => {
  const plainText = new Request("https://broker.example/refresh", {
    method: "POST",
    headers: { Origin: env.ALLOWED_ORIGINS, "Content-Type": "text/plain" },
    body: "refresh"
  });
  const unsupported = await worker.fetch(plainText, env);
  assert.equal(unsupported.status, 415);
  assert.deepEqual(await unsupported.json(), {
    error: "Content-Type must be application/json",
    code: "unsupported_media_type"
  });

  for (const body of [null, [], "refresh"]) {
    const response = await worker.fetch(new Request("https://broker.example/refresh", {
      method: "POST",
      headers: { Origin: env.ALLOWED_ORIGINS, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Request body must be a JSON object",
      code: "invalid_request"
    });
  }
});

test("adds a generated request ID when the caller does not supply a safe one", async () => {
  const response = await worker.fetch(request("/missing", {}), env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Request-ID"), "generated-request-id");
});

test("forwards refresh and revoke requests to Notion", async () => {
  const calls = [];
  const testEnv = { ...env, FETCH: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } };

  await worker.fetch(request("/refresh", { refresh_token: "refresh" }), testEnv);
  await worker.fetch(request("/revoke", { token: "access" }), testEnv);

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.notion.com/v1/oauth/token",
    "https://api.notion.com/v1/oauth/revoke"
  ]);
  assert.deepEqual(calls[0].body, { grant_type: "refresh_token", refresh_token: "refresh" });
  assert.deepEqual(calls[1].body, { token: "access" });
});

test("rejects an exchange redirect from an unknown extension", async () => {
  const response = await worker.fetch(request("/exchange", {
    code: "code",
    redirect_uri: "https://unknown.chromiumapp.org/notion"
  }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Redirect URI is not allowlisted" });
});

test("rejects missing, null, and hostile origins without forwarding", async () => {
  let forwarded = false;
  const testEnv = { ...env, FETCH: async () => {
    forwarded = true;
    throw new Error("should not forward");
  } };

  for (const origin of [undefined, "null", "https://hostile.example"]) {
    const response = await worker.fetch(request("/refresh", { refresh_token: "refresh" }, origin), testEnv);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(forwarded, false);
});

test("allows preflight only for the configured extension origin", async () => {
  const allowed = await worker.fetch(request("/refresh", null, env.ALLOWED_ORIGINS, "OPTIONS"), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), env.ALLOWED_ORIGINS);

  const denied = await worker.fetch(request("/refresh", null, "null", "OPTIONS"), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

test("rejects malformed and oversized request bodies", async () => {
  const malformed = new Request("https://broker.example/refresh", {
    method: "POST",
    headers: { Origin: env.ALLOWED_ORIGINS, "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal((await worker.fetch(malformed, env)).status, 400);

  const oversized = request("/refresh", { refresh_token: "x".repeat(17 * 1024) });
  assert.equal((await worker.fetch(oversized, env)).status, 413);
});

function request(path, body, origin = env.ALLOWED_ORIGINS, method = "POST") {
  const resolvedOrigin = arguments.length < 3 ? env.ALLOWED_ORIGINS : arguments[2];
  const headers = { "Content-Type": "application/json" };
  if (resolvedOrigin !== undefined) headers.Origin = resolvedOrigin;
  return new Request(`https://broker.example${path}`, {
    method,
    headers,
    ...(body === null ? {} : { body: JSON.stringify(body) })
  });
}
