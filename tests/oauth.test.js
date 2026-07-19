import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccessTokenRefresher,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeAccessToken
} from "../src/oauth.js";

test("uses dedicated broker routes for the OAuth lifecycle", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response(200, { access_token: "access", refresh_token: "refresh" });
  };

  await exchangeAuthorizationCode({
    brokerUrl: "https://auth.example/",
    code: "code",
    redirectUri: "https://extension.chromiumapp.org/notion",
    fetchImpl
  });
  await refreshAccessToken({ brokerUrl: "https://auth.example", refreshToken: "refresh", fetchImpl });
  await revokeAccessToken({ brokerUrl: "https://auth.example", token: "access", fetchImpl });

  assert.deepEqual(calls.map((call) => call.url), [
    "https://auth.example/exchange",
    "https://auth.example/refresh",
    "https://auth.example/revoke"
  ]);
  assert.equal(calls[1].body.refresh_token, "refresh");
});

test("surfaces a broker error message", async () => {
  const fetchImpl = async () => response(401, { error: "Reconnect Notion" });
  await assert.rejects(
    refreshAccessToken({ brokerUrl: "https://auth.example", refreshToken: "expired", fetchImpl }),
    /Reconnect Notion/
  );
});

test("coalesces rotating refresh tokens and reuses the stored result for stale callers", async () => {
  const state = {
    token: "expired-access",
    refreshToken: "refresh-1",
    oauthBrokerUrl: "https://auth.example"
  };
  let requests = 0;
  let release;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests += 1;
    return new Promise((resolve) => {
      release = () => resolve(response(200, { access_token: "access-2", refresh_token: "refresh-2" }));
    });
  };

  try {
    const refresh = createAccessTokenRefresher({
      loadSettings: async () => ({ ...state }),
      saveSettings: async (values) => Object.assign(state, values),
      brokerUrlForSettings: (settings) => settings.oauthBrokerUrl
    });
    const stale = { ...state };
    const first = refresh(stale);
    const second = refresh(stale);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    release();
    const [left, right] = await Promise.all([first, second]);
    assert.deepEqual(left, right);
    assert.equal(state.token, "access-2");
    assert.equal(state.refreshToken, "refresh-2");

    const third = await refresh(stale);
    assert.equal(requests, 1);
    assert.equal(third.token, "access-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a successful broker response without an access token", async () => {
  const refresh = createAccessTokenRefresher({
    loadSettings: async () => ({ token: "expired", refreshToken: "refresh", oauthBrokerUrl: "https://auth.example" }),
    saveSettings: async () => assert.fail("invalid tokens must not be stored"),
    brokerUrlForSettings: (settings) => settings.oauthBrokerUrl
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response(200, { refresh_token: "rotated" });
  try {
    await assert.rejects(refresh({ token: "expired" }), /invalid token response/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not restore stale credentials after the connection changes during refresh", async () => {
  const state = {
    connectionId: "connection-1",
    token: "expired",
    refreshToken: "refresh-1",
    oauthBrokerUrl: "https://auth.example"
  };
  let release;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Promise((resolve) => {
    release = () => resolve(response(200, { access_token: "stale-access", refresh_token: "stale-refresh" }));
  });
  try {
    const refresh = createAccessTokenRefresher({
      loadSettings: async () => ({ ...state }),
      saveSettings: async (values) => Object.assign(state, values),
      brokerUrlForSettings: (settings) => settings.oauthBrokerUrl
    });
    const pending = refresh({ ...state });
    await new Promise((resolve) => setImmediate(resolve));
    Object.assign(state, { connectionId: "connection-2", token: "new-access", refreshToken: "new-refresh" });
    release();
    await assert.rejects(pending, (error) => error.status === 401 && error.code === "connection_changed");
    assert.equal(state.token, "new-access");
    assert.equal(state.refreshToken, "new-refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}
