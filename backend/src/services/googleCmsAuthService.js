const crypto = require("crypto");
const axios = require("axios");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const CMS_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
  "https://www.googleapis.com/auth/youtubepartner"
];

function env(name) {
  return (process.env[name] || "").trim();
}

function oauthClients() {
  const id = env("GOOGLE_CLIENT_ID");
  const secret = env("GOOGLE_CLIENT_SECRET");
  const aliasId = env("GOOGLE_OAUTH_CLIENT_ID");
  const aliasSecret = env("GOOGLE_OAUTH_CLIENT_SECRET");
  const active = {
    clientId: id || aliasId,
    clientSecret: id ? secret || (!aliasId || id === aliasId ? aliasSecret : "") : aliasSecret || secret
  };
  const clients = [];
  for (const pair of [active, { clientId: aliasId, clientSecret: aliasSecret },
    { clientId: env("GOOGLE_PREVIOUS_CLIENT_ID"), clientSecret: env("GOOGLE_PREVIOUS_CLIENT_SECRET") }]) {
    if (pair.clientId && pair.clientSecret && !clients.some((c) => c.clientId === pair.clientId && c.clientSecret === pair.clientSecret)) {
      clients.push(pair);
    }
  }
  return { active, clients };
}

function clientError(message, reason = "oauth_client_not_configured") {
  return Object.assign(new Error(message), { oauthClientMisconfigured: true, reason });
}

function activeClient() {
  const { active } = oauthClients();
  if (!active.clientId || !active.clientSecret) throw clientError("Configure a matching GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.");
  return active;
}

function clientDiagnostics() {
  const { active, clients } = oauthClients();
  return {
    active: active.clientId && active.clientSecret ? active.clientId : null,
    configuredIds: [...new Set(clients.map((client) => client.clientId))]
  };
}

function redirectUri() {
  return env("GOOGLE_OAUTH_REDIRECT_URI") || env("GOOGLE_CMS_REDIRECT_URI") ||
    (env("BACKEND_PUBLIC_URL") || "http://localhost:4015").replace(/\/$/, "") + "/api/reports/networks/cms-auth/callback";
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signState(payload) {
  const secret = process.env.JWT_SECRET || process.env.BACKEND_API_KEY || "cms-auth-state";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function createState(networkId, authGeneration, clientId) {
  const payload = base64UrlEncode(
    JSON.stringify({
      network_id: Number(networkId),
      auth_generation: authGeneration,
      oauth_client_id: clientId,
      nonce: crypto.randomBytes(12).toString("hex"),
      ts: Date.now()
    })
  );
  return `${payload}.${signState(payload)}`;
}

function parseState(state) {
  const [payload, signature] = String(state || "").split(".");
  if (!payload || !signature || signState(payload) !== signature) {
    throw new Error("Invalid OAuth state");
  }

  const parsed = JSON.parse(base64UrlDecode(payload));
  if (!parsed.network_id) throw new Error("Invalid network in OAuth state");
  if (Date.now() - Number(parsed.ts || 0) > 15 * 60 * 1000) {
    throw new Error("OAuth state expired");
  }

  return parsed;
}

function buildAuthUrl(networkId, authGeneration = null) {
  const { clientId } = activeClient();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: CMS_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: createState(networkId, authGeneration, clientId)
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function exchangeCode(code, clientId) {
  return requestToken({ code, redirect_uri: redirectUri(), grant_type: "authorization_code" }, clientId || activeClient().clientId);
}

function refreshAccessToken(refreshToken, clientId) {
  return requestToken({ refresh_token: refreshToken, grant_type: "refresh_token" }, clientId);
}

async function requestToken(params, clientId) {
  const candidates = oauthClients().clients.filter((client) => !clientId || client.clientId === clientId);
  if (!candidates.length) throw clientError("Configure the original OAuth client ID and its matching secret on this server to renew the saved CMS grant.");
  let clientRejection;
  let grantRejection;
  for (const client of candidates) {
    const body = new URLSearchParams({ ...params, client_id: client.clientId, client_secret: client.clientSecret });
    try {
      const response = await axios.post(GOOGLE_TOKEN_URL, body.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20000, maxRedirects: 0
      });
      return { ...response.data, oauth_client_id: client.clientId };
    } catch (error) {
      const code = error.response?.data?.error;
      if (![400, 401].includes(error.response?.status)) throw error;
      if (code === "invalid_client" || code === "unauthorized_client") clientRejection = error;
      else if (code === "invalid_grant" && params.grant_type === "refresh_token") {
        if (clientId) throw error;
        grantRejection = error;
      } else throw error;
    }
  }
  // An older row has no recorded issuer. A different OAuth client can also get
  // invalid_grant, so do not mark that stored token revoked on this evidence alone.
  if (!clientRejection && grantRejection) throw clientError(
    "Google refused this older CMS grant (invalid_grant). Verify its original OAuth client and secret; if they match, renew consent in Settings > Network.",
    "oauth_client_unverified"
  );
  throw clientRejection;
}

async function getGoogleUser(accessToken) {
  const response = await axios.get(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000
  });

  return response.data;
}

// Operator diagnostic for legacy grants. Send the token only in the POST body
// to Google's fixed endpoint. A failed inspection never changes the saved grant.
async function inspectAccessTokenClient(accessToken) {
  if (!accessToken) return null;
  const response = await axios.post("https://oauth2.googleapis.com/tokeninfo",
    new URLSearchParams({ access_token: accessToken }).toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000, maxRedirects: 0,
      validateStatus: (status) => status === 200 || status === 400 || status === 401
    });
  if (response.status !== 200) return null;
  const issuerClient = response.data?.azp || response.data?.issued_to || response.data?.aud;
  return typeof issuerClient === "string" && issuerClient ? issuerClient : null;
}

module.exports = {
  CMS_SCOPES,
  clientDiagnostics,
  inspectAccessTokenClient,
  buildAuthUrl,
  parseState,
  exchangeCode,
  refreshAccessToken,
  getGoogleUser
};
