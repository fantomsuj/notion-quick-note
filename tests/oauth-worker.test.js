import test from "node:test";
import assert from "node:assert/strict";
import worker from "../oauth-worker/src/index.js";

const env = {
  NOTION_CLIENT_ID: "client",
  NOTION_CLIENT_SECRET: "secret",
  ALLOWED_EXTENSION_IDS: "abcdefghijklmnopabcdefghijklmnop",
  ALLOWED_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  OAUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  UUID: () => "generated-request-id",
  LOG: () => {}
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

test("normalizes rate-limit binding failures without exposing internals", async () => {
  const response = await worker.fetch(request("/refresh", { refresh_token: "refresh" }), {
    ...env,
    OAUTH_RATE_LIMITER: {
      async limit() {
        throw new Error("private binding failure details");
      }
    }
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "OAuth broker rate limiter is unavailable",
    code: "rate_limiter_unavailable"
  });
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

test("preserves valid Notion error responses", async () => {
  const response = await worker.fetch(request("/refresh", { refresh_token: "refresh" }), {
    ...env,
    FETCH: async () => new Response(JSON.stringify({
      object: "error",
      code: "unauthorized",
      message: "Refresh token expired"
    }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    })
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    object: "error",
    code: "unauthorized",
    message: "Refresh token expired"
  });
});

test("rejects non-string OAuth fields before forwarding", async () => {
  let forwarded = false;
  const testEnv = {
    ...env,
    FETCH: async () => {
      forwarded = true;
      throw new Error("should not forward");
    }
  };
  for (const [path, body] of [
    ["/exchange", { code: [], redirect_uri: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/notion" }],
    ["/exchange", { code: "code", redirect_uri: 42 }],
    ["/refresh", { refresh_token: { secret: true } }],
    ["/revoke", { token: ["token"] }]
  ]) {
    const response = await worker.fetch(request(path, body), testEnv);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_request");
  }
  assert.equal(forwarded, false);
});

test("normalizes Notion transport and response failures", async () => {
  const unavailable = await worker.fetch(request("/refresh", { refresh_token: "refresh" }), {
    ...env,
    FETCH: async () => { throw new TypeError("connect failed"); }
  });
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), {
    error: "Notion OAuth is temporarily unavailable",
    code: "upstream_unavailable"
  });

  const invalid = await worker.fetch(request("/refresh", { refresh_token: "refresh" }), {
    ...env,
    FETCH: async () => new Response("gateway failure", {
      status: 502,
      headers: { "Content-Type": "text/plain" }
    })
  });
  assert.equal(invalid.status, 502);
  assert.deepEqual(await invalid.json(), {
    error: "Notion OAuth returned an invalid response",
    code: "invalid_upstream_response"
  });
});

test("aborts a Notion request at the upstream deadline", async () => {
  let observedSignal;
  const response = await worker.fetch(request("/exchange", {
    code: "authorization-code",
    redirect_uri: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/notion"
  }), {
    ...env,
    UPSTREAM_TIMEOUT_MS: 5,
    FETCH: async (_url, options) => {
      observedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
  });

  assert.equal(observedSignal.aborted, true);
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: "Notion OAuth request timed out",
    code: "upstream_timeout"
  });
});

test("logs one secret-free completion event with correlation metadata", async () => {
  const logs = [];
  const times = [1_000, 1_037];
  const response = await worker.fetch(request("/refresh", {
    refresh_token: "client-refresh-secret"
  }), {
    ...env,
    NOW: () => times.shift(),
    LOG: (entry) => logs.push(entry),
    FETCH: async () => new Response(JSON.stringify({
      access_token: "notion-access-secret",
      refresh_token: "notion-refresh-secret"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(logs, [{
    event: "oauth_request_completed",
    requestId: "generated-request-id",
    method: "POST",
    path: "/refresh",
    status: 200,
    outcome: "success",
    durationMs: 37
  }]);
  const serialized = JSON.stringify(logs);
  for (const secret of ["client-refresh-secret", "notion-access-secret", "notion-refresh-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("logs stable failure outcomes and canonicalizes unknown routes", async () => {
  const failureLogs = [];
  await worker.fetch(request("/refresh", { refresh_token: "refresh" }), {
    ...env,
    LOG: (entry) => failureLogs.push(entry),
    FETCH: async () => { throw new TypeError("connect failed"); }
  });
  assert.equal(failureLogs[0].outcome, "upstream_unavailable");

  const unknownLogs = [];
  const response = await worker.fetch(request("/secret-in-url", {}), {
    ...env,
    LOG: (entry) => unknownLogs.push(entry)
  });
  assert.equal(response.status, 404);
  assert.equal(unknownLogs[0].path, "unknown");
  assert.equal(JSON.stringify(unknownLogs).includes("secret-in-url"), false);
});

test("rejects an exchange redirect from an unknown extension", async () => {
  const response = await worker.fetch(request("/exchange", {
    code: "code",
    redirect_uri: "https://unknown.chromiumapp.org/notion"
  }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Redirect URI is not allowlisted" });
});

test("requires the exact allowlisted OAuth redirect host and path", async () => {
  let forwarded = false;
  const testEnv = {
    ...env,
    FETCH: async () => {
      forwarded = true;
      throw new Error("should not forward");
    }
  };
  for (const redirectUri of [
    "https://abcdefghijklmnopabcdefghijklmnop.evil.chromiumapp.org/notion",
    "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/notion/extra",
    "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/notion?next=evil"
  ]) {
    const response = await worker.fetch(request("/exchange", {
      code: "code",
      redirect_uri: redirectUri
    }), testEnv);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Redirect URI is not allowlisted" });
  }
  assert.equal(forwarded, false);
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
