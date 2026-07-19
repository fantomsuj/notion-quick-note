function normalizeBrokerUrl(value = "") {
  return value.trim().replace(/\/$/, "");
}

async function brokerRequest(brokerUrl, path, body, fetchImpl = fetch) {
  const baseUrl = normalizeBrokerUrl(brokerUrl);
  if (!baseUrl) throw new Error("OAuth is not configured for this build yet.");

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Authentication failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.code || "";
    throw error;
  }
  return payload;
}

export function exchangeAuthorizationCode({ brokerUrl, code, redirectUri, fetchImpl = fetch }) {
  return brokerRequest(brokerUrl, "/exchange", { code, redirect_uri: redirectUri }, fetchImpl);
}

export function refreshAccessToken({ brokerUrl, refreshToken, fetchImpl = fetch }) {
  if (!refreshToken) throw new Error("Reconnect Notion to continue.");
  return brokerRequest(brokerUrl, "/refresh", { refresh_token: refreshToken }, fetchImpl);
}

export function revokeAccessToken({ brokerUrl, token, fetchImpl = fetch }) {
  if (!token) return Promise.resolve({});
  return brokerRequest(brokerUrl, "/revoke", { token }, fetchImpl);
}

export function createAccessTokenRefresher({ loadSettings, saveSettings, brokerUrlForSettings }) {
  let activePromise;

  return async function refreshStoredToken(staleSettings = {}) {
    const currentSettings = await loadSettings();
    if (staleSettings.token && currentSettings.token && staleSettings.token !== currentSettings.token) {
      return currentSettings;
    }

    if (!activePromise) {
      activePromise = refresh(currentSettings).finally(() => {
        activePromise = undefined;
      });
    }
    return activePromise;
  };

  async function refresh(settings) {
    const payload = await refreshAccessToken({
      brokerUrl: brokerUrlForSettings(settings),
      refreshToken: settings.refreshToken
    });
    if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
      throw new Error("Notion returned an invalid token response. Reconnect Notion to continue.");
    }

    const latest = await loadSettings();
    const connectionChanged = latest.connectionId !== settings.connectionId
      || latest.token !== settings.token
      || latest.refreshToken !== settings.refreshToken;
    if (connectionChanged) {
      const error = new Error("The Notion connection changed while its token was refreshing.");
      error.status = 401;
      error.code = "connection_changed";
      throw error;
    }

    const updated = {
      token: payload.access_token,
      refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token
        ? payload.refresh_token
        : settings.refreshToken
    };
    await saveSettings(updated);
    return { ...settings, ...updated };
  }
}
