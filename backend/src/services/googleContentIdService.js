const db = require("../config/database");
const { refreshAccessToken } = require("./googleCmsAuthService");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const YOUTUBE_PARTNER_API = "https://www.googleapis.com/youtube/partner/v1";
const pendingRefreshes = new Map();

function toIsoExpiry(expiresIn) {
  const seconds = Number(expiresIn);
  return new Date(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000).toISOString();
}

function getGoogleError(error) {
  const data = error.response?.data;
  if (data?.error?.message) return data.error.message;
  if (data?.error_description) return data.error_description;
  if (data?.message) return data.message;
  return error.message || "Google Content ID request failed";
}

function getConnectedNetwork(networkId, { retrySavedGrant = false } = {}) {
  const network = db.prepare("SELECT * FROM networks WHERE id = ?").get(Number(networkId));
  if (!network) {
    const error = new Error("Network not found");
    error.status = 404;
    throw error;
  }

  const recoverable = retrySavedGrant && network.cms_auth_status === "error" && network.cms_refresh_token;
  if (network.cms_auth_status !== "connected" && !recoverable) {
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
    error.cmsAuthFailed = true;
    error.networkId = network.id;
    error.reason = "missing_refresh_token";
    throw error;
  }

  return network;
}

const CURRENT_CREDENTIALS = `
  id = ? AND network_code IS ? AND cms_auth_status IS ? AND cms_auth_generation IS ?
  AND cms_refresh_token IS ? AND cms_access_token IS ? AND cms_token_expiry IS ? AND cms_oauth_client_id IS ?
`;

function credentialVersion(network) {
  return [
    network.id, network.network_code, network.cms_auth_status, network.cms_auth_generation ?? null,
    network.cms_refresh_token, network.cms_access_token, network.cms_token_expiry, network.cms_oauth_client_id ?? null
  ];
}

function rejectCredentials(network, version, lockId, reason, message) {
  const { changes } = db.prepare(`
    UPDATE networks
    SET cms_auth_status = 'error', cms_auth_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE ${CURRENT_CREDENTIALS} AND cms_refresh_lock_id = ?
  `).run(message, ...version, lockId);
  if (!changes) return null;
  const error = new Error(message);
  error.status = 424;
  error.cmsAuthFailed = true;
  error.networkId = network.id;
  error.reason = reason;
  error.googleMessage = message;
  throw error;
}

async function refreshNetworkToken(network, version, lockId) {
  if (!network.cms_refresh_token) {
    return rejectCredentials(network, version, lockId, "missing_refresh_token", "CMS refresh token is missing. Please re-auth CMS.");
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(network.cms_refresh_token, network.cms_oauth_client_id);
  } catch (error) {
    if (error.oauthClientMisconfigured) {
      error.networkId = network.id;
      throw error;
    }
    const status = Number(error?.response?.status || 0);
    const data = error?.response?.data;
    // The token endpoint speaks OAuth: { error: "invalid_grant", error_description: "…" }.
    const oauthCode = typeof data?.error === "string" ? data.error : "";
    const message = oauthCode ? [oauthCode, data.error_description].filter(Boolean).join(": ") : getGoogleError(error);
    const quoted = message.replace(/[.\s]+$/, ""); // embedded in parentheses below
    if (oauthCode === "invalid_grant" && (status === 400 || status === 401)) {
      return rejectCredentials(network, version, lockId, oauthCode, message);
    }
    if (!oauthCode || (status !== 400 && status !== 401)) {
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
    const misconfigured = new Error(`Google rejected the CMS token refresh (${quoted}). Check the issuing OAuth client and its matching secret on every server and worker, then retry the saved grant.`);
    misconfigured.oauthClientMisconfigured = true;
    misconfigured.networkId = network.id;
    misconfigured.reason = oauthCode;
    misconfigured.googleMessage = misconfigured.message;
    throw misconfigured;
  }

  if (typeof refreshed?.access_token !== "string" || !refreshed.access_token.trim()) {
    const error = new Error("Google's token service did not return a CMS access token.");
    error.status = 502;
    error.tokenRefreshTransient = true;
    throw error;
  }

  const { changes } = db.prepare(`
    UPDATE networks
    SET cms_access_token = ?, cms_refresh_token = ?, cms_token_expiry = ?, cms_auth_status = 'connected',
        cms_oauth_client_id = COALESCE(?, cms_oauth_client_id), cms_refresh_lock_id = NULL, cms_refresh_lock_until = NULL,
        cms_auth_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE ${CURRENT_CREDENTIALS} AND cms_refresh_lock_id = ?
  `).run(
    refreshed.access_token, refreshed.refresh_token || network.cms_refresh_token,
    toIsoExpiry(refreshed.expires_in), refreshed.oauth_client_id || null, ...version, lockId
  );
  return changes ? refreshed.access_token : null;
}

async function refreshWithLease(network, version) {
  // The token endpoint can rotate a grant. Serialize refreshes across all API
  // and worker processes sharing this database, including after a worker crash.
  const now = Date.now();
  if (network.cms_refresh_lock_id && network.cms_refresh_lock_until > now) {
    await delay(Math.min(250, network.cms_refresh_lock_until - now));
    return null;
  }
  const lockId = randomUUID();
  const won = db.prepare(`UPDATE networks SET cms_refresh_lock_id = ?, cms_refresh_lock_until = ?
    WHERE ${CURRENT_CREDENTIALS} AND (cms_refresh_lock_id IS NULL OR COALESCE(cms_refresh_lock_until, 0) <= ?)`
  ).run(lockId, now + 90_000, ...version, now);
  if (!won.changes) return null;
  try {
    return await refreshNetworkToken(network, version, lockId);
  } finally {
    db.prepare("UPDATE networks SET cms_refresh_lock_id = NULL, cms_refresh_lock_until = NULL WHERE id = ? AND cms_refresh_lock_id = ?")
      .run(network.id, lockId);
  }
}

async function getAccessToken(network, { rejectedAccessToken, retrySavedGrant = false } = {}) {
  let token;
  do {
    const current = getConnectedNetwork(network.id, { retrySavedGrant });
    if (network.network_code && network.network_code !== current.network_code) {
      const error = new Error("CMS network ID changed. Retry with the current network.");
      error.status = 409;
      throw error;
    }

    const expiry = Date.parse(current.cms_token_expiry);
    if (current.cms_auth_status === "connected" && current.cms_access_token && current.cms_access_token !== rejectedAccessToken && expiry > Date.now() + 60_000) {
      return current.cms_access_token;
    }

    const version = credentialVersion(current);
    let pending = pendingRefreshes.get(current.id);
    if (!pending || !version.every((value, index) => value === pending.version[index])) {
      pending = { version, promise: refreshWithLease(current, version) };
      pendingRefreshes.set(current.id, pending);
    }
    try {
      token = await pending.promise;
    } finally {
      if (pendingRefreshes.get(current.id) === pending) pendingRefreshes.delete(current.id);
    }
    // A reconnect, disconnect or another process may have changed the row during refresh.
    // Reload the winning credentials and honor the new state.
  } while (!token);
  return token;
}

async function renewSavedGrant(networkId) {
  const network = getConnectedNetwork(networkId, { retrySavedGrant: true });
  if (!network.cms_refresh_token) {
    throw Object.assign(new Error("No saved CMS refresh token is available."), { status: 400 });
  }
  // Ignore the cached access token so a successful check proves offline renewal works.
  await getAccessToken(network, { rejectedAccessToken: network.cms_access_token, retrySavedGrant: true });
}

async function withCmsAccessToken(network, request) {
  const token = await getAccessToken(network);
  try {
    return await request(token);
  } catch (error) {
    if (Number(error.response?.status) !== 401) throw error;
    return request(await getAccessToken(network, { rejectedAccessToken: token }));
  }
}

module.exports = {
  getAccessToken,
  renewSavedGrant,
  withCmsAccessToken,
  getConnectedNetwork,
  getGoogleError,
  YOUTUBE_PARTNER_API
};
