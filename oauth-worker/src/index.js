const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/health") return json({ ok: true }, 200, cors);
    if (url.pathname !== "/exchange" || request.method !== "POST") return json({ error: "Not found" }, 404, cors);

    try {
      const { code, redirect_uri: redirectUri } = await request.json();
      if (!code || !redirectUri) return json({ error: "code and redirect_uri are required" }, 400, cors);
      if (!isAllowedRedirect(redirectUri, env)) return json({ error: "Redirect URI is not allowlisted" }, 403, cors);

      const credentials = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
      const notionResponse = await fetch(NOTION_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri })
      });
      const payload = await notionResponse.json();
      return json(payload, notionResponse.status, cors);
    } catch (error) {
      return json({ error: error.message || "OAuth exchange failed" }, 500, cors);
    }
  }
};

function isAllowedRedirect(redirectUri, env) {
  try {
    const url = new URL(redirectUri);
    const allowedIds = (env.ALLOWED_EXTENSION_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
    return url.protocol === "https:" && url.hostname.endsWith(".chromiumapp.org") && allowedIds.includes(url.hostname.split(".")[0]);
  } catch {
    return false;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim());
  return {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin"
  };
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
