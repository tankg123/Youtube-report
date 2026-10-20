const db = require("../config/database");
const { refreshAccessToken } = require("./googleCmsAuthService");

const YOUTUBE_PARTNER_API = "https://www.googleapis.com/youtube/partner/v1";

function toIsoExpiry(expiresIn) {
  const seconds = Number(expiresIn) || 3600;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function getGoogleError(error) {
  const data = error.response?.data;
  if (data?.error?.message) return data.error.message;
  if (data?.error_description) return data.error_description;
  if (data?.message) return data.message;
  return error.message || "Google Content ID request failed";
}

function getConnectedNetwork(networkId) {
  const network = db.prepare("SELECT * FROM networks WHERE id = ?").get(Number(networkId));
  if (!network) {
    const error = new Error("Network not found");
    error.status = 404;
    throw error;
  }

  if (network.cms_auth_status !== "connected") {
    const error = new Error("CMS auth is not connected for this network");
    error.status = 400;
    throw error;
  }

  if (!String(network.network_code || "").trim()) {
    const error = new Error("Network ID is required before using Content ID API");
    error.status = 400;
    throw error;
  }

  if (!network.cms_access_token && !network.cms_refresh_token) {
    const error = new Error("CMS token is missing. Please re-auth CMS.");
    error.status = 400;
    throw error;
  }

  return network;
}

async function getAccessToken(network) {
  const expiry = network.cms_token_expiry ? new Date(network.cms_token_expiry).getTime() : 0;
  if (network.cms_access_token && expiry > Date.now() + 60 * 1000) {
    return network.cms_access_token;
  }

  // Callers (claim manager, delivery) recognise a refused CMS credential by `cmsAuthFailed` and
  // `networkId`, whatever message or HTTP status the failure carries.
  if (!network.cms_refresh_token) {
    const error = new Error("CMS refresh token is missing. Please re-auth CMS.");
    error.status = 400;
    error.cmsAuthFailed = true;
    error.networkId = network.id;
    error.reason = "missing_refresh_token";
    throw error;
  }

  try {
    const refreshed = await refreshAccessToken(network.cms_refresh_token);
    const nextExpiry = toIsoExpiry(refreshed.expires_in);
    db.prepare(`
      UPDATE networks
      SET cms_access_token = ?,
          cms_token_expiry = ?,
          cms_auth_status = 'connected',
          cms_auth_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(refreshed.access_token, nextExpiry, network.id);

    return refreshed.access_token;
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    const data = error?.response?.data;
    // The token endpoint speaks OAuth: { error: "invalid_grant", error_description: "…" }.
    const oauthCode = typeof data?.error === "string" ? data.error : "";
    const message = oauthCode && data?.error_description ? `${oauthCode}: ${data.error_description}` : getGoogleError(error);
    const quoted = message.replace(/[.\s]+$/, ""); // embedded in parentheses below
    // Google's token endpoint refuses a credential with 400 (invalid_grant, …) or 401
    // (invalid_client). Anything else says nothing about the credential: a timeout, a dropped
    // socket, a DNS failure or a 5xx must not flag the CMS as needing re-authorization, or a blip
    // at Google would cost a manual OAuth round trip.
    if (status !== 400 && status !== 401) {
      if (!error?.response && !error?.request && !error?.code) throw error; // not a transport error: a bug or missing OAuth config
      const transient = new Error(error?.response
        ? `Google's token service answered ${status} while refreshing the CMS access token (${quoted}); try again.`
        : `Google's token service could not be reached to refresh the CMS access token (${quoted}); try again.`);
      transient.tokenRefreshTransient = true;
      transient.networkId = network.id;
      transient.code = error?.code;
      transient.googleMessage = transient.message;
      if (status >= 500 || status === 429) transient.status = status;
      if (!error?.response && (["ECONNABORTED", "ETIMEDOUT"].includes(error?.code) || /timeout of \d+ms exceeded/i.test(String(error?.message || "")))) {
        transient.timedOut = true;
      }
      const retryAfter = Number(error?.response?.headers?.["retry-after"]);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) transient.retryAfter = retryAfter;
      throw transient;
    }
    // Every OAuth refusal except invalid_grant is about this application's OAuth client (wrong or
    // rotated GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, client deleted): re-authorizing the CMS goes
    // through the same client and fails the same way, so the network is not flagged.
    if (oauthCode && oauthCode !== "invalid_grant") {
      const misconfigured = new Error(`Google rejected this application's OAuth client while refreshing the CMS token (${quoted}). An administrator must check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server; re-authorizing the CMS will not help.`);
      misconfigured.oauthClientMisconfigured = true;
      misconfigured.networkId = network.id;
      misconfigured.reason = oauthCode;
      misconfigured.googleMessage = misconfigured.message;
      throw misconfigured;
    }
    db.prepare(`
      UPDATE networks
      SET cms_auth_status = 'error',
          cms_auth_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(message, network.id);
    const failure = new Error(message);
    failure.cmsAuthFailed = true;
    failure.networkId = network.id;
    failure.reason = oauthCode || "invalid_grant";
    failure.googleMessage = message;
    throw failure;
  }
}

module.exports = {
  getAccessToken,
  getConnectedNetwork,
  getGoogleError,
  YOUTUBE_PARTNER_API
};
