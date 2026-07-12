const axios = require("axios");
const { randomUUID } = require("crypto");
const db = require("../config/database");
const cmsAuthService = require("./googleCmsAuthService");
const { getVideosMetadataFromYoutube } = require("./youtubeService");
const { parseRoles } = require("../middlewares/authMiddleware");

const CONTENT_ID_API_BASE = "https://youtubepartner.googleapis.com/youtube/partner/v1";
const YOUTUBE_PARTNER_SCOPE = "https://www.googleapis.com/auth/youtubepartner";
const CLAIM_SEARCH_BATCH_SIZE = 50;
const CLAIM_LIST_BATCH_SIZE = 50;
const ASSET_LIST_BATCH_SIZE = 50;
const MAX_LOOKUP_VIDEOS = Math.min(Math.max(Number(process.env.CONTENT_ID_MAX_LOOKUP_VIDEOS) || 50, 1), 200);
const MAX_LOOKUP_ACCOUNTS = Math.min(Math.max(Number(process.env.CONTENT_ID_MAX_LOOKUP_ACCOUNTS) || 20, 1), 100);
const MAX_RELEASE_ITEMS = Math.min(Math.max(Number(process.env.CONTENT_ID_MAX_RELEASE_ITEMS) || 100, 1), 500);
const READ_CONCURRENCY = Math.min(Math.max(Number(process.env.CONTENT_ID_READ_CONCURRENCY) || 4, 1), 8);
const WRITE_CONCURRENCY = Math.min(Math.max(Number(process.env.CONTENT_ID_WRITE_CONCURRENCY) || 4, 1), 8);
const ASSET_CACHE_TTL_MS = Math.min(Math.max(Number(process.env.CONTENT_ID_ASSET_CACHE_TTL_MS) || 300000, 30000), 3600000);
const ASSET_CACHE_MAX_ITEMS = Math.min(Math.max(Number(process.env.CONTENT_ID_ASSET_CACHE_MAX_ITEMS) || 5000, 100), 50000);
const RELEASABLE_STATUSES = new Set(["active", "pending"]);
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const tokenRefreshInFlight = new Map();
const assetMetadataCache = new Map();
const releaseInFlight = new Set();

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, runWorker));
  return results;
}

function normalizeClaimStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccount(row) {
  return {
    id: row.id,
    cms_id: row.network_code,
    cms_name: row.name,
    google_email: row.cms_auth_email,
    google_name: row.cms_auth_name,
    scopes: row.cms_auth_scopes || "",
    status: row.cms_auth_status,
    access_token: row.cms_access_token,
    refresh_token: row.cms_refresh_token,
    token_expiry: row.cms_token_expiry
  };
}

function listAccounts() {
  return db.prepare(`
    SELECT
      id,
      name,
      network_code,
      cms_auth_status,
      cms_auth_email,
      cms_auth_name,
      cms_auth_scopes,
      cms_access_token,
      cms_refresh_token,
      cms_token_expiry
    FROM networks
    WHERE cms_auth_status = 'connected'
      AND network_code IS NOT NULL
      AND trim(network_code) != ''
    ORDER BY name COLLATE NOCASE ASC
  `).all().map(normalizeAccount);
}

function isTokenFresh(expiry) {
  if (!expiry) return false;
  const expiryTime = new Date(expiry).getTime();
  if (!Number.isFinite(expiryTime)) return false;
  return expiryTime - Date.now() > 60 * 1000;
}

async function getFreshAccessTokenForAccount(accountId) {
  const row = db.prepare(`
    SELECT *
    FROM networks
    WHERE id = ?
      AND cms_auth_status = 'connected'
      AND network_code IS NOT NULL
      AND trim(network_code) != ''
  `).get(Number(accountId));

  if (!row) throw new Error("CMS network is not connected.");
  if (row.cms_access_token && isTokenFresh(row.cms_token_expiry)) {
    return { accessToken: row.cms_access_token, account: normalizeAccount(row) };
  }
  if (!row.cms_refresh_token) throw new Error("CMS refresh token is missing. Please re-auth this CMS network.");

  const refreshKey = String(row.id);
  const currentRefresh = tokenRefreshInFlight.get(refreshKey);
  if (currentRefresh) return currentRefresh;

  const refreshPromise = (async () => {
    const token = await cmsAuthService.refreshAccessToken(row.cms_refresh_token);
    const accessToken = token.access_token;
    if (!accessToken) throw new Error("Could not refresh CMS access token.");

    const expiresAt = new Date(Date.now() + (Number(token.expires_in || 3600) * 1000)).toISOString();
    db.prepare(`
      UPDATE networks
      SET cms_access_token = ?,
          cms_token_expiry = ?,
          cms_auth_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(accessToken, expiresAt, row.id);

    const updated = { ...row, cms_access_token: accessToken, cms_token_expiry: expiresAt };
    return { accessToken, account: normalizeAccount(updated) };
  })();

  tokenRefreshInFlight.set(refreshKey, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    if (tokenRefreshInFlight.get(refreshKey) === refreshPromise) tokenRefreshInFlight.delete(refreshKey);
  }
}

function extractVideoId(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  function validCandidate(candidate) {
    const normalized = String(candidate || "").trim();
    return /^[a-zA-Z0-9_-]{11}$/.test(normalized) ? normalized : null;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return validCandidate(url.pathname.split("/").filter(Boolean)[0]);
    if (url.searchParams.get("v")) return validCandidate(url.searchParams.get("v"));

    const pathMatch = url.pathname.match(/\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    if (pathMatch) return pathMatch[1];
  } catch {
    const match = value.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
  }

  return null;
}

function parseVideoInputs(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\n,\s]+/);
  const seen = new Set();
  const invalid = [];
  const videoIds = [];

  values.forEach((raw) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return;
    const videoId = extractVideoId(trimmed);
    if (!videoId) {
      invalid.push(trimmed);
      return;
    }
    if (!seen.has(videoId)) {
      seen.add(videoId);
      videoIds.push(videoId);
    }
  });

  return { videoIds, invalid };
}

function getClaimPolicy(rawClaim) {
  return rawClaim.policy || rawClaim.appliedPolicy || rawClaim.applied_policy || null;
}

function isInactiveClaim(claim) {
  const status = normalizeClaimStatus(claim?.status);
  return status === "inactive" || status === "released";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReleasableClaim(claim) {
  return Boolean(claim?.id) && RELEASABLE_STATUSES.has(normalizeClaimStatus(claim.status));
}

function hasYoutubePartnerScope(account) {
  return String(account.scopes || "").split(/\s+/).includes(YOUTUBE_PARTNER_SCOPE);
}

function actorHasRole(user, role) {
  const target = String(role || "").toLowerCase();
  return parseRoles(user?.roles?.length ? user.roles : user?.role).some((item) => String(item).toLowerCase() === target);
}

function isLimitedClaimManager(user) {
  return actorHasRole(user, "Claim Manager") && !actorHasRole(user, "admin") && !actorHasRole(user, "Content ID");
}

function normalizeLabelKey(value) {
  return String(value || "").trim().toLowerCase();
}

function getAllowedLabelKeys(user) {
  if (!isLimitedClaimManager(user)) return null;
  return new Set(
    db.prepare(`
      SELECT l.name, l.display_name
      FROM user_content_id_labels ucil
      JOIN content_id_labels l ON l.id = ucil.label_id
      WHERE ucil.user_id = ?
    `).all(user.id).flatMap((label) => [label.name, label.display_name]).map(normalizeLabelKey).filter(Boolean)
  );
}

function claimMatchesAllowedLabels(claim, allowedLabelKeys) {
  if (!allowedLabelKeys) return true;
  if (!claim) return false;
  const labels = normalizeLabels(claim.asset?.labels || []);
  return labels.some((label) => allowedLabelKeys.has(normalizeLabelKey(label)));
}

function normalizeClaim(rawClaim, account, videoId) {
  const status = normalizeClaimStatus(rawClaim.status);
  return {
    id: rawClaim.id,
    videoId: rawClaim.videoId || rawClaim.video_id || videoId,
    videoTitle: rawClaim.videoTitle || rawClaim.video_title || "",
    assetId: rawClaim.assetId || rawClaim.asset_id || rawClaim.asset?.id || null,
    status: status || null,
    contentType: rawClaim.contentType || rawClaim.content_type || null,
    origin: rawClaim.origin || null,
    isPartnerUploaded: rawClaim.isPartnerUploaded || rawClaim.is_partner_uploaded || false,
    policy: getClaimPolicy(rawClaim),
    matchInfo: rawClaim.matchInfo || rawClaim.match_info || null,
    timeCreated: rawClaim.timeCreated || rawClaim.createdTime || rawClaim.created_at || null,
    accountId: account.id,
    cmsName: account.cms_name,
    googleEmail: account.google_email,
    ownership: "managed_by_cms",
    canRelease: Boolean(rawClaim.id) && RELEASABLE_STATUSES.has(status),
    timeStatusLastModified: rawClaim.timeStatusLastModified || rawClaim.time_status_last_modified || null
  };
}

function normalizeLabels(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : item.name || item.label || item.id || "")).filter(Boolean);
  }
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeAsset(rawAsset) {
  if (!rawAsset) return null;
  const metadata =
    rawAsset.metadata ||
    rawAsset.metadataEffective ||
    rawAsset.metadataMine ||
    rawAsset.metadataOwner ||
    rawAsset.metadataOriginal ||
    {};

  return {
    id: rawAsset.id || rawAsset.assetId || rawAsset.asset_id || null,
    title: rawAsset.title || metadata.title || metadata.name || rawAsset.customId || null,
    type: rawAsset.type || rawAsset.assetType || rawAsset.kind || null,
    customId: rawAsset.customId || metadata.customId || metadata.custom_id || null,
    isrc: metadata.isrc || rawAsset.isrc || null,
    upc: metadata.upc || metadata.grid || rawAsset.upc || rawAsset.grid || null,
    labels: normalizeLabels(rawAsset.labels || rawAsset.assetLabels || rawAsset.label || metadata.labels || metadata.assetLabels),
    metadata,
    raw: rawAsset
  };
}

function attachAssetToClaim(claim, asset) {
  if (!asset) return claim;
  return {
    ...claim,
    asset: {
      id: asset.id || claim.assetId,
      title: asset.title,
      type: asset.type,
      customId: asset.customId,
      isrc: asset.isrc,
      upc: asset.upc,
      labels: asset.labels || []
    }
  };
}

function getCachedAsset(accountId, assetId) {
  const key = `${accountId}:${assetId}`;
  const cached = assetMetadataCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    assetMetadataCache.delete(key);
    return null;
  }
  return cached.asset;
}

function cacheAsset(accountId, assetId, asset) {
  if (!assetId || !asset) return;
  if (assetMetadataCache.size >= ASSET_CACHE_MAX_ITEMS) {
    const now = Date.now();
    for (const [key, cached] of assetMetadataCache) {
      if (cached.expiresAt <= now) assetMetadataCache.delete(key);
    }
    while (assetMetadataCache.size >= ASSET_CACHE_MAX_ITEMS) {
      assetMetadataCache.delete(assetMetadataCache.keys().next().value);
    }
  }
  assetMetadataCache.set(`${accountId}:${assetId}`, {
    asset,
    expiresAt: Date.now() + ASSET_CACHE_TTL_MS
  });
}

async function listAssetMetadataBatch({ accessToken, account, assetIds }) {
  const response = await withReadRetry(() => axios.get(`${CONTENT_ID_API_BASE}/assets`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      onBehalfOfContentOwner: account.cms_id,
      id: assetIds.join(","),
      fetchMetadata: "effective",
      fields: "items(id,aliasId,type,label,metadata,metadataMine,metadataEffective)",
      prettyPrint: false
    },
    timeout: 20000
  }));

  const assets = (response.data.items || []).map(normalizeAsset).filter(Boolean);
  assets.forEach((asset) => {
    const aliases = asset.raw?.aliasId || [];
    [asset.id, ...aliases].filter(Boolean).forEach((assetId) => cacheAsset(account.id, assetId, asset));
  });
  return assets;
}

async function hydrateClaimsWithAssets(claims, { strict = false, bypassCache = false, stats = null } = {}) {
  const groups = new Map();
  claims.forEach((claim) => {
    if (!claim.assetId || !claim.accountId) return;
    const key = String(claim.accountId);
    if (!groups.has(key)) groups.set(key, { accountId: claim.accountId, assetIds: new Set() });
    groups.get(key).assetIds.add(claim.assetId);
  });

  const assetByKey = new Map();
  const tasks = [];
  let cacheHits = 0;

  for (const group of groups.values()) {
    const missingIds = [];
    for (const assetId of group.assetIds) {
      const cached = bypassCache ? null : getCachedAsset(group.accountId, assetId);
      if (cached) {
        assetByKey.set(`${group.accountId}:${assetId}`, cached);
        cacheHits += 1;
      }
      else missingIds.push(assetId);
    }
    chunk(missingIds, ASSET_LIST_BATCH_SIZE).forEach((assetIds) => tasks.push({ accountId: group.accountId, assetIds }));
  }

  const taskResults = await mapWithConcurrency(tasks, READ_CONCURRENCY, async (task) => {
    try {
      const { accessToken, account } = await getFreshAccessTokenForAccount(task.accountId);
      await listAssetMetadataBatch({ accessToken, account, assetIds: task.assetIds });
      return null;
    } catch (error) {
      return error;
    }
  });

  const firstError = taskResults.find(Boolean);
  if (strict && firstError) {
    const error = new Error(`Could not verify asset labels: ${googleErrorMessage(firstError)}`);
    error.code = firstError.code;
    error.statusCode = firstError.statusCode;
    error.response = firstError.response;
    error.cause = firstError;
    throw error;
  }
  if (stats) {
    stats.assetMetadataBatches = tasks.length;
    stats.assetCacheHits = cacheHits;
    stats.assetMetadataErrors = taskResults.filter(Boolean).length;
  }

  for (const group of groups.values()) {
    for (const assetId of group.assetIds) {
      const asset = getCachedAsset(group.accountId, assetId);
      if (asset) assetByKey.set(`${group.accountId}:${assetId}`, asset);
    }
  }

  return claims.map((claim) => attachAssetToClaim(claim, assetByKey.get(`${claim.accountId}:${claim.assetId}`)));
}

function googleErrorMessage(error) {
  const data = error.response?.data;
  if (data?.error?.message) return data.error.message;
  if (data?.error_description) return data.error_description;
  return error.message || "Google Content ID API error";
}

function googleErrorReason(error) {
  return error.response?.data?.error?.errors?.[0]?.reason || error.response?.data?.error?.status || "";
}

function isTransientGoogleError(error) {
  const status = Number(error.response?.status || 0);
  return TRANSIENT_HTTP_STATUSES.has(status)
    || ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(error.code);
}

function isAmbiguousWriteError(error) {
  const status = Number(error.response?.status || error.statusCode || 0);
  return [500, 502, 503, 504].includes(status)
    || ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(error.code);
}

function retryDelayMs(error, attempt = 0) {
  const retryAfter = error.response?.headers?.["retry-after"];
  const retrySeconds = Number(retryAfter);
  if (Number.isFinite(retrySeconds) && retrySeconds >= 0) return Math.min(retrySeconds * 1000, 10000);
  return Math.min(400 * (2 ** attempt) + Math.floor(Math.random() * 250), 5000);
}

async function withReadRetry(operation, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (Number(error.response?.status || 0) === 429) throw error;
      if (!isTransientGoogleError(error) || attempt >= maxRetries) throw error;
      await wait(retryDelayMs(error, attempt));
    }
  }
  throw lastError;
}

async function searchClaimSnippetsForVideos({ accessToken, account, videoIds }) {
  if (!hasYoutubePartnerScope(account)) {
    throw new Error("This CMS is missing the YouTube Partner scope. Please re-auth the CMS network.");
  }

  const claims = [];
  let pageToken = "";
  let requestCount = 0;

  do {
    const response = await withReadRetry(() => {
      requestCount += 1;
      return axios.get(`${CONTENT_ID_API_BASE}/claimSearch`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          onBehalfOfContentOwner: account.cms_id,
          videoId: videoIds.join(","),
          includeThirdPartyClaims: false,
          pageToken: pageToken || undefined,
          fields: "items(id,videoId,videoTitle,assetId,status,contentType,origin,isPartnerUploaded,timeCreated,timeStatusLastModified,studioInfo),nextPageToken",
          prettyPrint: false
        },
        timeout: 20000
      }).catch((error) => {
        error.contentIdRequestCount = requestCount;
        throw error;
      });
    });

    claims.push(...(response.data.items || []).map((claim) => normalizeClaim(claim, account, claim.videoId || null)));
    pageToken = response.data.nextPageToken || "";
  } while (pageToken);

  return { claims, requestCount };
}

async function searchClaims({ accountIds, videoInput, user, includeDetails = false }) {
  const { videoIds, invalid } = parseVideoInputs(videoInput);
  if (!videoIds.length) throw new Error("Please enter at least one valid video link or video ID.");
  if (videoIds.length > MAX_LOOKUP_VIDEOS) {
    throw new Error(`A lookup can contain at most ${MAX_LOOKUP_VIDEOS} unique videos.`);
  }

  const allAccounts = listAccounts().filter((account) => account.status === "connected");
  const wantedIds = [...new Set((Array.isArray(accountIds) ? accountIds : []).map((id) => Number(id)).filter(Boolean))];
  if (!wantedIds.length) throw new Error("Select at least one connected CMS network for claim lookup.");
  if (wantedIds.length > MAX_LOOKUP_ACCOUNTS) {
    throw new Error(`A lookup can include at most ${MAX_LOOKUP_ACCOUNTS} CMS networks.`);
  }
  const accounts = allAccounts.filter((account) => wantedIds.includes(Number(account.id)));
  const allowedLabelKeys = getAllowedLabelKeys(user);

  if (!accounts.length || accounts.length !== wantedIds.length) {
    throw new Error("One or more selected CMS networks are unavailable or not connected.");
  }

  const loadDetails = Boolean(includeDetails) || Boolean(allowedLabelKeys);
  const assetReadStats = { assetMetadataBatches: 0, assetCacheHits: 0, assetMetadataErrors: 0 };
  let metadataByVideoId = {};
  let metadataError = null;
  const metadataPromise = includeDetails
    ? getVideosMetadataFromYoutube(videoIds).catch((error) => {
      metadataError = googleErrorMessage(error);
      return {};
    })
    : Promise.resolve({});

  const credentials = new Map();
  const credentialErrors = new Map();
  await mapWithConcurrency(accounts, READ_CONCURRENCY, async (account) => {
    try {
      credentials.set(account.id, await getFreshAccessTokenForAccount(account.id));
    } catch (error) {
      credentialErrors.set(account.id, error);
    }
  });

  const lookupTasks = [];
  accounts.forEach((account) => {
    chunk(videoIds, CLAIM_SEARCH_BATCH_SIZE).forEach((batchVideoIds) => {
      lookupTasks.push({ account, videoIds: batchVideoIds });
    });
  });

  const lookupResults = await mapWithConcurrency(lookupTasks, READ_CONCURRENCY, async (task) => {
    const credentialError = credentialErrors.get(task.account.id);
    if (credentialError) return { ...task, claims: [], requestCount: 0, error: credentialError };

    try {
      const { accessToken } = credentials.get(task.account.id);
      const data = await searchClaimSnippetsForVideos({ accessToken, account: task.account, videoIds: task.videoIds });
      return { ...task, ...data, error: null };
    } catch (error) {
      return { ...task, claims: [], requestCount: Number(error.contentIdRequestCount || 0), error };
    }
  });

  const requestedVideoIds = new Set(videoIds);
  const uniqueClaims = new Map();
  lookupResults
    .flatMap((item) => item.claims || [])
    .filter((claim) => requestedVideoIds.has(claim.videoId))
    .forEach((claim) => uniqueClaims.set(`${claim.accountId}:${claim.id}`, claim));
  let claims = [...uniqueClaims.values()];
  if (loadDetails && claims.length) {
    claims = await hydrateClaimsWithAssets(claims, {
      strict: Boolean(allowedLabelKeys),
      bypassCache: Boolean(allowedLabelKeys),
      stats: assetReadStats
    });
  }
  claims = claims.filter((claim) => claimMatchesAllowedLabels(claim, allowedLabelKeys));
  metadataByVideoId = await metadataPromise;

  const claimsByVideoId = new Map();
  claims.forEach((claim) => {
    if (!claimsByVideoId.has(claim.videoId)) claimsByVideoId.set(claim.videoId, []);
    claimsByVideoId.get(claim.videoId).push(claim);
  });

  const videos = videoIds.map((videoId) => {
    const videoClaims = claimsByVideoId.get(videoId) || [];
    const metadata = metadataByVideoId[videoId] || null;
    const errors = lookupResults
      .filter((item) => item.error && item.videoIds.includes(videoId))
      .map((item) => ({ accountId: item.account.id, cmsName: item.account.cms_name, message: googleErrorMessage(item.error) }));

    return {
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      metadata,
      videoTitle: metadata?.title || videoClaims[0]?.videoTitle || "",
      channelTitle: metadata?.channel_title || "",
      thumbnail: metadata?.thumbnail || "",
      durationText: metadata?.duration_text || "",
      publishedAt: metadata?.published_at || "",
      claimCount: videoClaims.length,
      claims: videoClaims,
      errors,
      status: videoClaims.length ? "claimed_by_authorized_cms" : "no_authorized_cms_claim"
    };
  });

  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      cms_name: account.cms_name,
      google_email: account.google_email,
      status: account.status,
      scopes: account.scopes
    })),
    invalid,
    metadataError,
    detailsIncluded: loadDetails,
    detailsRequired: Boolean(allowedLabelKeys),
    videoIds,
    videos,
    requestPlan: {
      claimSearchBatches: lookupTasks.length,
      claimSearchRequests: lookupResults.reduce((sum, item) => sum + Number(item.requestCount || 0), 0),
      videoMetadataBatches: includeDetails ? Math.ceil(videoIds.length / 50) : 0,
      assetMetadataBatches: assetReadStats.assetMetadataBatches,
      assetCacheHits: assetReadStats.assetCacheHits,
      assetMetadataErrors: assetReadStats.assetMetadataErrors,
      lookupModel: "batched_by_cms"
    },
    limits: {
      maxLookupVideos: MAX_LOOKUP_VIDEOS,
      maxLookupAccounts: MAX_LOOKUP_ACCOUNTS,
      maxReleaseItems: MAX_RELEASE_ITEMS
    },
    totals: {
      videos: videoIds.length,
      claims: videos.reduce((sum, video) => sum + video.claims.length, 0),
      releasable: videos.reduce((sum, video) => sum + video.claims.filter((claim) => claim.canRelease).length, 0),
      errors: videos.reduce((sum, video) => sum + video.errors.length, 0)
    }
  };
}

async function listClaimsByIdsForAccount({ accessToken, account, claimIds, hydrateAssets = false, strictAssets = false }) {
  const uniqueIds = [...new Set(claimIds.map((claimId) => String(claimId || "").trim()).filter(Boolean))];
  const claims = [];
  let requestCount = 0;

  for (const claimIdsBatch of chunk(uniqueIds, CLAIM_LIST_BATCH_SIZE)) {
    let pageToken = "";
    do {
      const response = await withReadRetry(() => axios.get(`${CONTENT_ID_API_BASE}/claims`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          onBehalfOfContentOwner: account.cms_id,
          id: claimIdsBatch.join(","),
          pageToken: pageToken || undefined,
          fields: "items(id,videoId,assetId,status,contentType,origin,isPartnerUploaded,timeCreated,timeStatusLastModified),nextPageToken",
          prettyPrint: false
        },
        timeout: 20000
      }));

      requestCount += 1;
      claims.push(...(response.data.items || []).map((claim) => normalizeClaim(claim, account, claim.videoId || null)));
      pageToken = response.data.nextPageToken || "";
    } while (pageToken);
  }

  return {
    claims: hydrateAssets && claims.length
      ? await hydrateClaimsWithAssets(claims, { strict: strictAssets, bypassCache: strictAssets })
      : claims,
    requestCount
  };
}

async function patchClaimInactive({ accessToken, account, claimId }) {
  const response = await axios.patch(
    `${CONTENT_ID_API_BASE}/claims/${encodeURIComponent(claimId)}`,
    { status: "inactive" },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      params: {
        onBehalfOfContentOwner: account.cms_id,
        fields: "id,videoId,assetId,status,contentType,timeStatusLastModified",
        prettyPrint: false
      },
      timeout: 30000
    }
  );

  const released = normalizeClaim(response.data || {}, account, response.data?.videoId || null);
  if (!released.id || !isInactiveClaim(released)) {
    const error = new Error("Google did not confirm the claim as inactive.");
    error.statusCode = 502;
    throw error;
  }
  return released;
}

async function releaseClaimWithRecovery({ accessToken, account, item }) {
  try {
    return { claim: await patchClaimInactive({ accessToken, account, claimId: item.claimId }), reconciled: false };
  } catch (firstError) {
    const reason = googleErrorReason(firstError);
    const ambiguous = isAmbiguousWriteError(firstError);
    if (!ambiguous && reason !== "invalidStatusTransition") throw firstError;

    if (ambiguous) await wait(retryDelayMs(firstError, 0));
    let lookup;
    try {
      lookup = await listClaimsByIdsForAccount({ accessToken, account, claimIds: [item.claimId] });
    } catch (lookupError) {
      lookupError.outcomeUnknown = ambiguous;
      throw lookupError;
    }

    const currentClaim = lookup.claims.find((claim) => claim.id === item.claimId);
    if (currentClaim && isInactiveClaim(currentClaim)) return { claim: currentClaim, reconciled: true };
    if (!currentClaim) {
      firstError.outcomeUnknown = ambiguous;
      throw firstError;
    }
    if (!isReleasableClaim(currentClaim) || reason === "invalidStatusTransition") throw firstError;

    try {
      return {
        claim: await patchClaimInactive({ accessToken, account, claimId: item.claimId }),
        reconciled: true
      };
    } catch (retryError) {
      const retryReason = googleErrorReason(retryError);
      if (!isAmbiguousWriteError(retryError) && retryReason !== "invalidStatusTransition") throw retryError;

      try {
        const finalLookup = await listClaimsByIdsForAccount({ accessToken, account, claimIds: [item.claimId] });
        const finalClaim = finalLookup.claims.find((claim) => claim.id === item.claimId);
        if (finalClaim && isInactiveClaim(finalClaim)) return { claim: finalClaim, reconciled: true };
      } catch {
        // The final read is best-effort; the caller receives an explicit unknown outcome below.
      }

      retryError.outcomeUnknown = true;
      throw retryError;
    }
  }
}

function normalizeReleaseItems(releases) {
  const unique = new Map();
  for (const rawItem of Array.isArray(releases) ? releases : []) {
    const item = {
      accountId: Number(rawItem.accountId),
      claimId: String(rawItem.claimId || rawItem.id || "").trim(),
      videoId: extractVideoId(rawItem.videoId || rawItem.video_id || rawItem.videoUrl || rawItem.video_url || ""),
      assetId: rawItem.assetId || rawItem.asset_id || rawItem.asset?.id || null
    };
    if (!item.accountId || !item.claimId) continue;
    const key = `${item.accountId}:${item.claimId}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function claimReleaseKey(item) {
  return `${item.accountId}:${item.claimId || item.id}`;
}

function recordReleaseAudit({ item, result, user, account, operationId }) {
  const status = result.ok
    ? "inactive"
    : result.outcomeUnknown ? "release_unknown" : "release_failed";
  const response = result.claim ? JSON.stringify(result.claim) : null;
  db.prepare(`
    INSERT INTO content_id_claims (
      network_id, network_name, content_owner_id, claim_id, video_id,
      asset_id, policy_id, content_type, status, claim_response,
      error_message, note, created_by, created_by_name
    )
    VALUES (?, ?, ?, ?, ?, ?, '-', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.accountId,
    account?.cms_name || null,
    account?.cms_id || null,
    item.claimId,
    item.videoId || result.claim?.videoId || "-",
    item.assetId || result.claim?.assetId || "-",
    result.claim?.contentType || "unknown",
    status,
    response,
    result.ok ? null : result.message || "Release failed",
    `Claim Manager official claims.patch workflow; operation=${operationId}`,
    user?.id || null,
    user?.full_name || user?.email || null
  );
}

async function releaseClaims({ releases, user }) {
  const items = normalizeReleaseItems(releases);
  if (!items.length) throw new Error("Please select at least one claim to release.");
  if (items.length > MAX_RELEASE_ITEMS) {
    throw new Error(`A release batch can contain at most ${MAX_RELEASE_ITEMS} unique claims.`);
  }
  const operationId = randomUUID();

  const allowedLabelKeys = getAllowedLabelKeys(user);
  const accountsById = new Map(listAccounts().map((account) => [Number(account.id), account]));
  const credentials = new Map();
  const credentialErrors = new Map();
  const accountIds = [...new Set(items.map((item) => item.accountId))];

  await mapWithConcurrency(accountIds, READ_CONCURRENCY, async (accountId) => {
    const account = accountsById.get(accountId);
    if (!account) {
      credentialErrors.set(accountId, new Error("CMS network is not connected."));
      return;
    }
    if (!hasYoutubePartnerScope(account)) {
      credentialErrors.set(accountId, new Error("This CMS is missing the YouTube Partner scope. Please re-auth the CMS network."));
      return;
    }
    try {
      credentials.set(accountId, await getFreshAccessTokenForAccount(accountId));
    } catch (error) {
      credentialErrors.set(accountId, error);
    }
  });

  const claimsBeforeRelease = new Map();
  if (allowedLabelKeys) {
    await mapWithConcurrency(accountIds, READ_CONCURRENCY, async (accountId) => {
      if (credentialErrors.has(accountId)) return;
      const credential = credentials.get(accountId);
      try {
        const lookup = await listClaimsByIdsForAccount({
          ...credential,
          claimIds: items.filter((item) => item.accountId === accountId).map((item) => item.claimId),
          hydrateAssets: true,
          strictAssets: true
        });
        lookup.claims.forEach((claim) => claimsBeforeRelease.set(claimReleaseKey(claim), claim));
      } catch (error) {
        credentialErrors.set(accountId, error);
      }
    });
  }

  const results = await mapWithConcurrency(items, WRITE_CONCURRENCY, async (item) => {
    const key = claimReleaseKey(item);
    if (releaseInFlight.has(key)) {
      return { ok: false, accountId: item.accountId, claimId: item.claimId, reason: "releaseInProgress", message: "This claim is already being released." };
    }

    releaseInFlight.add(key);
    try {
      const credentialError = credentialErrors.get(item.accountId);
      if (credentialError) throw credentialError;

      if (allowedLabelKeys) {
        const currentClaim = claimsBeforeRelease.get(key);
        if (!currentClaim) throw new Error("This claim could not be verified for your CMS account.");
        if (!claimMatchesAllowedLabels(currentClaim, allowedLabelKeys)) {
          throw new Error("This claim is not assigned to your allowed labels.");
        }
        if (isInactiveClaim(currentClaim)) {
          return {
            ok: true,
            releaseRequested: false,
            accountId: item.accountId,
            claimId: item.claimId,
            claim: currentClaim,
            verified: true,
            alreadyInactive: true,
            message: "Claim was already inactive; no write request was sent."
          };
        }
        if (!isReleasableClaim(currentClaim)) {
          throw new Error(`Claims in ${currentClaim.status || "this"} status cannot be released through the API.`);
        }
      }

      const credential = credentials.get(item.accountId);
      const release = await releaseClaimWithRecovery({ ...credential, item });
      return {
        ok: true,
        releaseRequested: true,
        pendingVerification: false,
        accountId: item.accountId,
        claimId: item.claimId,
        claim: release.claim,
        verified: true,
        reconciled: release.reconciled,
        message: release.reconciled
          ? "Claim release confirmed after reconciling an uncertain Google response."
          : "Claim released and confirmed inactive by Google."
      };
    } catch (error) {
      return {
        ok: false,
        accountId: item.accountId,
        claimId: item.claimId,
        reason: googleErrorReason(error) || undefined,
        retryable: isTransientGoogleError(error),
        outcomeUnknown: Boolean(error.outcomeUnknown),
        retryAfter: error.response?.headers?.["retry-after"] || undefined,
        message: googleErrorMessage(error)
      };
    } finally {
      releaseInFlight.delete(key);
    }
  });

  results.forEach((result) => {
    const item = items.find((candidate) => claimReleaseKey(candidate) === claimReleaseKey(result));
    if (!item) return;
    try {
      recordReleaseAudit({ item, result, user, account: accountsById.get(item.accountId), operationId });
    } catch (error) {
      console.error(`[ClaimManager] Audit persistence failed for operation ${operationId}: ${error.message}`);
    }
  });

  const successCount = results.filter((item) => item.ok).length;
  const verifiedCount = results.filter((item) => item.ok && item.verified).length;
  const pendingCount = results.filter((item) => item.ok && !item.verified).length;
  const failedCount = results.filter((item) => !item.ok).length;

  return {
    operationId,
    results,
    successCount,
    verifiedCount,
    pendingCount,
    failedCount,
    optimization: {
      uniqueClaims: items.length,
      concurrency: WRITE_CONCURRENCY,
      automaticPolling: false,
      method: "claims.patch"
    }
  };
}

module.exports = {
  extractVideoId,
  getFreshAccessTokenForAccount,
  listAccounts,
  parseVideoInputs,
  releaseClaims,
  searchClaims
};
