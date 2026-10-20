// Claim Manager: looks up the claims a CMS owns (by video, asset, claim id or free search) and
// releases them with the official YouTube Partner API, keeping an audit trail in
// content_id_claim_events. Every Google call goes through the shared Partner API client of
// assetDeliveryService (deadlines, retries of idempotent calls, read-back after a refused
// status change), so a slow or silent Google answer never turns into a false failure.
const { randomUUID } = require("crypto");
const db = require("../config/database");
const service = require("./assetDeliveryService");
const store = require("./deliveryStore");
const { getVideosMetadataFromYoutube } = require("./youtubeService");
const { parseRoles, SUPER_ADMIN_ROLES: superAdminRoles } = require("../middlewares/authMiddleware");

const YOUTUBE_PARTNER_SCOPE = "https://www.googleapis.com/auth/youtubepartner";
// Roles that are never label-restricted (exported by authMiddleware; a test fake may omit it).
const SUPER_ADMIN_ROLES = Array.isArray(superAdminRoles) ? superAdminRoles.map((role) => String(role).toLowerCase()) : [];

function clampEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

const LIMITS = Object.freeze({
  max_videos: clampEnv("CONTENT_ID_MAX_LOOKUP_VIDEOS", 50, 1, 200),
  max_assets: clampEnv("CONTENT_ID_MAX_LOOKUP_ASSETS", 20, 1, 100),
  max_claim_ids: clampEnv("CONTENT_ID_MAX_LOOKUP_CLAIMS", 200, 1, 1000),
  max_release_items: clampEnv("CONTENT_ID_MAX_RELEASE_ITEMS", 100, 1, 500),
  video_batch_size: clampEnv("CONTENT_ID_CLAIM_SEARCH_BATCH", 50, 1, 50),
  max_networks: clampEnv("CONTENT_ID_MAX_LOOKUP_ACCOUNTS", 20, 1, 100),
  // Video previews come from the YouTube Data API (quota); a wide explore / asset lookup only
  // hydrates the newest videos.
  max_preview_videos: clampEnv("CONTENT_ID_MAX_PREVIEW_VIDEOS", 500, 50, 5000)
});
const READ_CONCURRENCY = clampEnv("CONTENT_ID_READ_CONCURRENCY", 4, 1, 8);
const WRITE_CONCURRENCY = clampEnv("CONTENT_ID_WRITE_CONCURRENCY", 3, 1, 8);
// Wall-clock budget of one release batch, measured from entry (the pre-read counts). The UI
// waits 300 s for a batch; with 30 s / 60 s per-attempt deadlines a few silent claims could
// otherwise keep the server busy long after the browser gave up.
const RELEASE_BUDGET_MS = clampEnv("CONTENT_ID_RELEASE_BUDGET_MS", 150000, 30000, 280000);
// Deadline of the single read-back after a release call Google never answered.
const READ_BACK_TIMEOUT_MS = 15000;
// Google answers 409 "The operation was aborted." when two writes touch claims of the same video
// at the same time; the batch therefore releases the claims of one video one after another and
// repeats a refused call after a short pause (the PATCH to inactive is idempotent).
const CONFLICT_RETRY_MS = clampEnv("CONTENT_ID_CONFLICT_RETRY_MS", 1500, 0, 30000);
const MAX_CONFLICT_RETRIES = 2;
const ID_BATCH_SIZE = 50;
const MAX_PAGES_PER_QUERY = 10;
const MAX_RECHECK_ITEMS = 100;
const MAX_NOTE_LENGTH = 500;
const MAX_EXPORT_ROWS = 20000;
const MAX_TITLE_LENGTH = 255;
const MAX_ISRC_LENGTH = 32;
const ASSET_CACHE_TTL_MS = clampEnv("CONTENT_ID_ASSET_CACHE_TTL_MS", 300000, 30000, 3600000);
const ASSET_CACHE_MAX_ITEMS = clampEnv("CONTENT_ID_ASSET_CACHE_MAX_ITEMS", 5000, 100, 50000);

const CLAIM_STATUSES = ["active", "pending", "potential", "disputed", "appealed", "manual_review", "takedown", "inactive"];
const RELEASABLE_STATUSES = new Set(["active", "pending", "potential"]);
const INACTIVE_STATUSES = new Set(["inactive"]);
// Google reinstates (inactive -> active) through claims.patch when the content owner may; the API
// cannot reinstate disputed claims, and only a released claim is offered for it here.
const REINSTATABLE_STATUSES = new Set(["inactive"]);
// Google confirms a potential claim (a match awaiting confirmation) through claims.patch
// status=active; no other status can be confirmed.
const CONFIRMABLE_STATUSES = new Set(["potential"]);
const CONTENT_TYPES = ["audio", "audiovisual", "video"];
const ORIGINS = [
  "audioMatch", "audioSwap", "batchTool", "cmsUpload", "contentIdApi", "cvpSearch", "descriptiveSearch", "dropboxUpload",
  "external", "gameId", "googleDevId", "hashcode", "inProductShorts", "inProductStudio", "melodyMatch", "syntheticVocal",
  "videoMatch", "webUpload", "youTubeAdmin"
];
const SORTS = ["DATE", "DAILY_ENGAGED_VIEWS", "LIFETIME_ENGAGED_VIEWS"];
const MODES = ["videos", "assets", "claims", "explore"];
const RESULTS = ["released", "already_inactive", "reinstated", "confirmed", "already_active", "failed", "unknown", "skipped"];
// A row with one of these results settles whatever write preceded it on the same claim.
const SETTLED_RESULTS = ["released", "already_inactive", "reinstated", "confirmed", "already_active"];
// claimSearch.list takes the enum names of the discovery document; Claim / ClaimSnippet
// resources report lowercase values and spell manual review "manual_review" and visual claims
// "video". The alias maps bring any spelling a resource might use back to the page's values.
const STATUS_FILTER_VALUES = {
  active: "ACTIVE", appealed: "APPEALED", disputed: "DISPUTED", inactive: "INACTIVE", manual_review: "ROUTED_FOR_REVIEW",
  pending: "PENDING", potential: "POTENTIAL", takedown: "TAKEDOWN"
};
const CONTENT_TYPE_FILTER_VALUES = { audio: "AUDIO", audiovisual: "AUDIOVISUAL", video: "VISUAL" };
const STATUS_ALIASES = { routedforreview: "manual_review", routed_for_review: "manual_review" };
const CONTENT_TYPE_ALIASES = { visual: "video" };
// Studio links a claim resource may carry, most specific first.
const STUDIO_URL_KEYS = ["claimUrl", "claimDetailsUrl", "issueUrl", "videoUrl"];
// Socket errors after the request went out: Google may have applied the call.
const LOST_ANSWER_CODES = new Set(["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE"]);
// Failures before any byte reached Google: the call can simply be repeated.
const NEVER_SENT_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"]);
const QUOTA_RETRY_AFTER_SECONDS = 60;
const RELEASE_IN_FLIGHT_MESSAGE = "A status change (release, reinstate or confirm) of this claim is still running on the server; its outcome will be recorded by that request. Re-check it in a minute.";
const HISTORY_COLUMNS = [
  "id", "operation_id", "action", "network_id", "network_name", "content_owner_id", "claim_id", "video_id", "video_title",
  "channel_title", "asset_id", "asset_title", "isrc", "content_type", "previous_status", "result", "result_status", "message",
  "note", "duration_ms", "created_by", "created_by_name", "created_by_email", "created_at"
].join(", ");

const assetCache = new Map();
// Claims whose PATCH is on the wire right now (one request at a time per claim) and, more widely,
// every claim a running release batch still owns (queued or in flight): a re-check of such a claim
// must not confirm the pending audit row, the release itself will complete it.
const releasesInFlight = new Set();
const releasesPending = new Map(); // key -> number of batches holding it

function holdPending(key) {
  releasesPending.set(key, (releasesPending.get(key) || 0) + 1);
}

function dropPending(key) {
  const count = (releasesPending.get(key) || 0) - 1;
  if (count > 0) releasesPending.set(key, count);
  else releasesPending.delete(key);
}

function isReleasePending(key) {
  return releasesInFlight.has(key) || releasesPending.has(key);
}

// Test hook: the environment clamps the batch budget to 30 s or more, far too long for a unit
// test that works with fake PATCH delays of a few milliseconds. Only honoured under the test
// runner; production reads CONTENT_ID_RELEASE_BUDGET_MS.
let releaseBudgetOverrideMs = null;
function _setReleaseBudgetMs(ms) {
  if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test") {
    throw new Error("_setReleaseBudgetMs is only available under the test runner");
  }
  releaseBudgetOverrideMs = Number(ms) > 0 ? Number(ms) : null;
}

function releaseBudgetMs() {
  return releaseBudgetOverrideMs ?? RELEASE_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cleanText(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return cleanText(value).toLowerCase();
}

function badRequest(message, extra = {}) {
  const error = new Error(message);
  error.status = 400;
  error.isClaimManagerError = true;
  Object.assign(error, extra);
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.status = 403;
  error.isClaimManagerError = true;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  error.isClaimManagerError = true;
  return error;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasPartnerScope(scopes) {
  return String(scopes || "").split(/\s+/).includes(YOUTUBE_PARTNER_SCOPE);
}

function claimKey(networkId, claimId) {
  return `${Number(networkId)}:${cleanText(claimId)}`;
}

function videoUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
}

// A real calendar day: Date.parse accepts "2026-02-31" (as March 3rd), the round trip does not.
function isDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function upstreamStatus(error) {
  return Number(error?.status || error?.response?.status || 0);
}

// Partner API segments are in milliseconds; the page (and longestMatch / totalMatch) use seconds.
function msToSeconds(value) {
  const number = toNumber(value);
  return number === null ? null : number / 1000;
}

// ---------------------------------------------------------------------------
// Users and label restrictions
// ---------------------------------------------------------------------------

function rolesOf(user) {
  return parseRoles(user?.roles?.length ? user.roles : user?.role).map(lower);
}

function actorHasRole(user, role) {
  const target = lower(role);
  return rolesOf(user).includes(target);
}

// A "Claim Manager" without admin / super admin / Content ID rights only sees and releases
// claims whose asset carries one of the labels assigned to the user.
function isLimitedUser(user) {
  if (!actorHasRole(user, "Claim Manager")) return false;
  const roles = rolesOf(user);
  return !roles.includes("admin") && !roles.includes("content id") && !roles.some((role) => SUPER_ADMIN_ROLES.includes(role));
}

function normalizeLabelKey(value) {
  return lower(value);
}

function allowedLabelsOf(user) {
  if (!isLimitedUser(user)) return null;
  const rows = db.prepare(`
    SELECT l.name, l.display_name
    FROM user_content_id_labels ucil
    JOIN content_id_labels l ON l.id = ucil.label_id
    WHERE ucil.user_id = ?
  `).all(Number(user?.id) || 0);
  const keys = new Set();
  const names = [];
  rows.forEach((row) => {
    [row.name, row.display_name].map(cleanText).filter(Boolean).forEach((label) => {
      if (!keys.has(normalizeLabelKey(label))) names.push(label);
      keys.add(normalizeLabelKey(label));
    });
  });
  return { keys, names };
}

function assetMatchesLabels(asset, allowed) {
  if (!allowed) return true;
  const labels = Array.isArray(asset?.labels) ? asset.labels : [];
  return labels.some((label) => allowed.keys.has(normalizeLabelKey(label)));
}

function describeUser(user) {
  const allowed = allowedLabelsOf(user);
  return { limited: Boolean(allowed), allowed_labels: allowed ? allowed.names : [] };
}

// ---------------------------------------------------------------------------
// Accounts (connected CMS networks)
// ---------------------------------------------------------------------------

function listClaimAccounts() {
  return db.prepare(`
    SELECT id, name, network_code, cms_auth_email, cms_auth_scopes, cms_auth_status
    FROM networks
    WHERE cms_auth_status = 'connected' AND network_code IS NOT NULL AND trim(network_code) != ''
    ORDER BY name COLLATE NOCASE ASC
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    network_code: row.network_code,
    cms_auth_email: row.cms_auth_email || "",
    has_partner_scope: hasPartnerScope(row.cms_auth_scopes),
    status: row.cms_auth_status
  }));
}

function resolveNetworks(networkIds, { max = LIMITS.max_networks } = {}) {
  const wanted = [...new Set((Array.isArray(networkIds) ? networkIds : [networkIds]).map(Number).filter((id) => id > 0))];
  if (!wanted.length) throw badRequest("Select at least one connected CMS network.");
  if (wanted.length > max) throw badRequest(`A lookup can include at most ${max} CMS networks.`);
  const accounts = listClaimAccounts();
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length) throw badRequest("One or more selected CMS networks are unavailable or not connected.");
  const noScope = wanted.map((id) => byId.get(id)).filter((account) => !account.has_partner_scope);
  if (noScope.length) {
    throw badRequest(`${noScope.map((account) => account.name).join(", ")}: the CMS authorization is missing the YouTube Partner scope. Re-authorize it in Settings > Network.`);
  }
  return wanted.map((id) => byId.get(id));
}

function publicNetwork(account) {
  return { id: account.id, name: account.name, network_code: account.network_code, cms_auth_email: account.cms_auth_email || "" };
}

// A per-request counter of Partner API calls, exposed as the "request plan" of a lookup.
function createStats() {
  return {
    claim_search_requests: 0,
    claim_list_requests: 0,
    claim_get_requests: 0,
    claim_patch_requests: 0,
    asset_requests: 0,
    video_metadata_requests: 0,
    claim_history_requests: 0
  };
}

function observe(ctx, stats) {
  return {
    ...ctx,
    deliveryStep: "claims",
    onApiEvent(event) {
      if (event.phase !== "started" || !stats) return;
      const endpoint = String(event.endpoint || "");
      const method = String(event.method || "GET").toUpperCase();
      if (endpoint.endsWith("/claimSearch")) stats.claim_search_requests += 1;
      else if (/\/claimHistory\//.test(endpoint)) stats.claim_history_requests += 1;
      else if (/\/claims\/[^/]+$/.test(endpoint)) stats[method === "PATCH" ? "claim_patch_requests" : "claim_get_requests"] += 1;
      else if (/\/claims$/.test(endpoint)) stats.claim_list_requests += 1;
      else if (/\/assets(\/|$)/.test(endpoint)) stats.asset_requests += 1;
    }
  };
}

// getAccessToken() reports a refused token refresh (typically Google's 400 invalid_grant) as an
// Error flagged `cmsAuthFailed` without a Google HTTP status, which the controller would answer
// with 400 and nobody would show the re-authorize hint for. It is tagged like a Google 401
// instead: 424 for the controller, the CMS flagged by noteCmsAuthFailure, one message everywhere.
function tagRefreshFailure(error, account) {
  if (!error || typeof error !== "object") return error;
  const message = cleanText(error.googleMessage || error.message);
  // getConnectedNetwork() words a missing token as "Please re-auth CMS."; a rejected OAuth client
  // (a server configuration problem) is deliberately not a credentials failure.
  const refreshFailure = Boolean(error.cmsAuthFailed) || (!error.oauthClientMisconfigured && /please re-auth cms/i.test(message));
  if (!refreshFailure) return error;
  const raw = message || "CMS token refresh failed";
  error.status = 401;
  error.networkId = account.id;
  error.reason = cleanText(error.reason) || "invalid_grant";
  error.googleMessage = raw;
  error.message = `CMS authorization failed: ${raw.replace(/[.\s]+$/, "")}. Re-authorize this CMS in Settings > Network.`;
  return error;
}

async function contextFor(account, stats) {
  try {
    return observe(await service.authContext(account.id), stats);
  } catch (error) {
    throw tagRefreshFailure(error, account);
  }
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
const SIMPLE_ID_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;

function extractVideoId(input) {
  const value = cleanText(input);
  if (!value) return null;
  if (VIDEO_ID_PATTERN.test(value)) return value;
  const candidate = (raw) => (VIDEO_ID_PATTERN.test(cleanText(raw)) ? cleanText(raw) : null);
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return candidate(url.pathname.split("/").filter(Boolean)[0]);
    if (/(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/.test(host)) {
      if (url.searchParams.get("v")) return candidate(url.searchParams.get("v"));
      const match = url.pathname.match(/\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})(?:[/?]|$)/);
      if (match) return match[1];
    }
  } catch {
    // not a URL
  }
  const match = value.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/);
  return match ? match[1] : null;
}

function splitInput(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return String(value || "").split(/[\r\n,;\t ]+/).map(cleanText).filter(Boolean);
}

function looksLikeVideoLink(token) {
  return /youtu\.be|youtube(?:-nocookie)?\.com|[?&]v=/i.test(token);
}

// One video per line, or several ids separated by commas/spaces. When a line holds a link,
// only links count on that line: a title pasted next to the link (spreadsheet rows) must not
// be mistaken for a bare 11-character id.
function parseVideoInputs(value) {
  const lines = Array.isArray(value) ? value.map((item) => String(item ?? "")) : String(value || "").split(/\r?\n/);
  const ids = [];
  const invalid = [];
  const seen = new Set();
  lines.forEach((line) => {
    const tokens = line.split(/[,;\t ]+/).map(cleanText).filter(Boolean);
    const links = tokens.filter(looksLikeVideoLink);
    (links.length ? links : tokens).forEach((token) => {
      const videoId = extractVideoId(token);
      if (!videoId) {
        invalid.push(token);
        return;
      }
      if (!seen.has(videoId)) {
        seen.add(videoId);
        ids.push(videoId);
      }
    });
  });
  return { ids, invalid };
}

function parseIdList(value) {
  const ids = [];
  const invalid = [];
  const seen = new Set();
  splitInput(value).forEach((raw) => {
    if (!SIMPLE_ID_PATTERN.test(raw)) {
      invalid.push(raw);
      return;
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      ids.push(raw);
    }
  });
  return { ids, invalid };
}

function parseFilters(input) {
  const source = input && typeof input === "object" ? input : {};
  const pick = (values, allowed, label) => {
    const list = [...new Set((Array.isArray(values) ? values : splitInput(values)).map(cleanText).filter(Boolean))];
    const unknown = list.filter((item) => !allowed.includes(item));
    if (unknown.length) throw badRequest(`Unknown ${label}: ${unknown.join(", ")}`);
    return list;
  };
  const date = (value, label) => {
    const text = cleanText(value);
    if (!text) return "";
    if (!isDateOnly(text)) throw badRequest(`${label} must be a date in YYYY-MM-DD format`);
    return text;
  };
  const filters = {
    statuses: pick(source.statuses, CLAIM_STATUSES, "claim status").map(lower),
    content_types: pick((Array.isArray(source.content_types) ? source.content_types : splitInput(source.content_types)).map(lower), CONTENT_TYPES, "content type"),
    origins: pick(source.origins, ORIGINS, "origin"),
    created_after: date(source.created_after, "created_after"),
    created_before: date(source.created_before, "created_before"),
    status_modified_after: date(source.status_modified_after, "status_modified_after"),
    status_modified_before: date(source.status_modified_before, "status_modified_before"),
    partner_uploaded: source.partner_uploaded === true || source.partner_uploaded === "true"
      ? true
      : source.partner_uploaded === false || source.partner_uploaded === "false" ? false : null,
    sort: cleanText(source.sort).toUpperCase()
  };
  if (filters.sort && !SORTS.includes(filters.sort)) throw badRequest(`Unknown sort: ${filters.sort}`);
  if (filters.created_after && filters.created_before && filters.created_after > filters.created_before) {
    throw badRequest("created_after must not be later than created_before");
  }
  if (filters.status_modified_after && filters.status_modified_before && filters.status_modified_after > filters.status_modified_before) {
    throw badRequest("status_modified_after must not be later than status_modified_before");
  }
  return filters;
}

function filterParams(filters) {
  const params = {};
  if (filters.statuses.length === 1) params.status = STATUS_FILTER_VALUES[filters.statuses[0]];
  if (filters.content_types.length === 1) params.contentType = CONTENT_TYPE_FILTER_VALUES[filters.content_types[0]];
  if (filters.origins.length) params.origin = filters.origins.join(",");
  if (filters.created_after) params.createdAfter = filters.created_after;
  if (filters.created_before) params.createdBefore = filters.created_before;
  if (filters.status_modified_after) params.statusModifiedAfter = filters.status_modified_after;
  if (filters.status_modified_before) params.statusModifiedBefore = filters.status_modified_before;
  if (filters.partner_uploaded !== null) params.partnerUploaded = filters.partner_uploaded;
  return params;
}

// Google's date semantics: "after" is inclusive, "before" exclusive, compared on the calendar
// day. A claim without the timestamp only passes when no bound of that pair is set.
function withinDays(timestamp, after, before) {
  if (!after && !before) return true;
  const day = cleanText(timestamp).slice(0, 10);
  if (!day) return false;
  if (after && day < after) return false;
  if (before && day >= before) return false;
  return true;
}

// Google only takes one status / content type per call, and claims.list (claim-id lookups)
// takes no filter at all; everything is applied here as well.
function matchesFilters(claim, filters) {
  if (filters.statuses.length && !filters.statuses.includes(claim.status)) return false;
  if (filters.content_types.length && !filters.content_types.includes(claim.content_type)) return false;
  if (filters.origins.length && !filters.origins.includes(claim.origin)) return false;
  if (filters.partner_uploaded !== null && Boolean(claim.is_partner_uploaded) !== filters.partner_uploaded) return false;
  if (!withinDays(claim.time_created, filters.created_after, filters.created_before)) return false;
  if (!withinDays(claim.time_status_last_modified, filters.status_modified_after, filters.status_modified_before)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Normalisation of Google resources
// ---------------------------------------------------------------------------

function normalizePolicy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  const summary = rules.length ? service.summarizePolicyRules(rules) : cleanText(raw.description);
  return {
    id: cleanText(raw.id) || null,
    name: cleanText(raw.name) || null,
    summary: summary || null
  };
}

// Match segments carry `start`/`duration`, manual segments `start`/`finish`; both in milliseconds.
function normalizeSegment(segment) {
  if (!segment || typeof segment !== "object") return null;
  const start = msToSeconds(segment.start);
  let duration = msToSeconds(segment.duration);
  if (duration === null) {
    const finish = msToSeconds(segment.finish);
    if (start !== null && finish !== null) duration = Math.max(0, finish - start);
  }
  return { start, duration };
}

function normalizeMatchInfo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const segments = (Array.isArray(raw.matchSegments) ? raw.matchSegments : []).map((segment) => {
    const video = normalizeSegment(segment.video_segment || segment.videoSegment);
    const reference = normalizeSegment(segment.reference_segment || segment.referenceSegment);
    const manual = normalizeSegment(segment.manual_segment || segment.manualSegment);
    return {
      channel: cleanText(segment.channel) || null,
      video_start: video?.start ?? manual?.start ?? null,
      video_duration: video?.duration ?? manual?.duration ?? null,
      reference_start: reference?.start ?? null,
      reference_duration: reference?.duration ?? null
    };
  });
  return {
    reference_id: cleanText(raw.referenceId) || null,
    longest_match: raw.longestMatch ? {
      duration_secs: toNumber(raw.longestMatch.durationSecs),
      user_video_offset: toNumber(raw.longestMatch.userVideoOffset),
      reference_offset: toNumber(raw.longestMatch.referenceOffset)
    } : null,
    total_match: raw.totalMatch ? {
      user_video_duration_secs: toNumber(raw.totalMatch.userVideoDurationSecs),
      reference_duration_secs: toNumber(raw.totalMatch.referenceDurationSecs)
    } : null,
    segments
  };
}

function studioUrl(info) {
  if (!info || typeof info !== "object") return null;
  const isUrl = (value) => typeof value === "string" && /^https?:\/\//i.test(value);
  return STUDIO_URL_KEYS.map((key) => info[key]).find(isUrl) || Object.values(info).find(isUrl) || null;
}

function normalizeAsset(raw) {
  if (!raw || typeof raw !== "object") return null;
  const metadata = raw.metadataEffective || raw.metadataMine || raw.metadata || {};
  const labels = (Array.isArray(raw.label) ? raw.label : []).map(cleanText).filter(Boolean);
  return {
    id: cleanText(raw.id) || null,
    title: cleanText(metadata.title) || null,
    type: cleanText(raw.type) || null,
    custom_id: cleanText(metadata.customId) || null,
    isrc: cleanText(metadata.isrc).toUpperCase() || null,
    upc: cleanText(metadata.upc) || null,
    artist: Array.isArray(metadata.artist) ? metadata.artist.map(cleanText).filter(Boolean).join(", ") || null : cleanText(metadata.artist) || null,
    labels
  };
}

function normalizeVideo(meta) {
  if (!meta || typeof meta !== "object") return null;
  return {
    title: cleanText(meta.title),
    channel_id: cleanText(meta.channel_id),
    channel_title: cleanText(meta.channel_title),
    thumbnail: cleanText(meta.thumbnail),
    duration_text: cleanText(meta.duration_text),
    published_at: cleanText(meta.published_at)
  };
}

function labelBlockReason(asset, allowed) {
  if (!allowed) return "";
  if (!asset) return "Asset labels could not be verified for your account";
  if (!assetMatchesLabels(asset, allowed)) return "Asset is not in your allowed labels";
  return "";
}

function releaseBlockReason(status, asset, allowed) {
  if (!RELEASABLE_STATUSES.has(status)) {
    return `Claims in ${status || "unknown"} status cannot be released through the API`;
  }
  return labelBlockReason(asset, allowed);
}

function reinstateBlockReason(status, asset, allowed) {
  if (!REINSTATABLE_STATUSES.has(status)) {
    return `Only inactive (released) claims can be reinstated through the API; this claim is ${status || "unknown"}`;
  }
  return labelBlockReason(asset, allowed);
}

function confirmBlockReason(status, asset, allowed) {
  if (!CONFIRMABLE_STATUSES.has(status)) {
    return `Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is ${status || "unknown"}`;
  }
  return labelBlockReason(asset, allowed);
}

function normalizeStatus(value) {
  const key = lower(value);
  return STATUS_ALIASES[key] || key;
}

function normalizeContentType(value) {
  const key = lower(value);
  return CONTENT_TYPE_ALIASES[key] || key;
}

function normalizeClaim(raw, account, { video = null, asset = null, allowed = null } = {}) {
  const status = normalizeStatus(raw.status);
  const contentType = normalizeContentType(raw.contentType);
  const origin = typeof raw.origin === "string" ? cleanText(raw.origin) : cleanText(raw.origin?.source);
  const videoId = cleanText(raw.videoId);
  const assetId = cleanText(raw.assetId) || null;
  const blockReason = releaseBlockReason(status, asset, allowed);
  const reinstateReason = reinstateBlockReason(status, asset, allowed);
  const confirmReason = confirmBlockReason(status, asset, allowed);
  return {
    key: claimKey(account.id, raw.id),
    claim_id: cleanText(raw.id),
    network_id: account.id,
    network_name: account.name,
    content_owner_id: account.network_code,
    video_id: videoId,
    video_url: videoUrl(videoId),
    video_title: cleanText(raw.videoTitle) || video?.title || "",
    video,
    asset_id: assetId,
    asset,
    status,
    content_type: contentType,
    origin: origin || "",
    is_partner_uploaded: Boolean(raw.isPartnerUploaded),
    third_party: Boolean(raw.thirdPartyClaim),
    time_created: cleanText(raw.timeCreated) || null,
    time_status_last_modified: cleanText(raw.timeStatusLastModified) || null,
    video_views: toNumber(raw.videoViews),
    engaged_views: toNumber(raw.engagedViews),
    can_release: !blockReason,
    release_block_reason: blockReason,
    can_reinstate: !reinstateReason,
    reinstate_block_reason: reinstateReason,
    can_confirm: !confirmReason,
    confirm_block_reason: confirmReason,
    policy: normalizePolicy(raw.policy),
    applied_policy: normalizePolicy(raw.appliedPolicy),
    match_info: normalizeMatchInfo(raw.matchInfo),
    block_outside_ownership: typeof raw.blockOutsideOwnership === "boolean" ? raw.blockOutsideOwnership : null,
    ugc_type: cleanText(raw.ugcType) || null,
    studio_url: studioUrl(raw.studioInfo)
  };
}

function normalizeHistoryEvent(raw) {
  const details = raw?.typeDetails && typeof raw.typeDetails === "object" ? raw.typeDetails : {};
  const source = raw?.source && typeof raw.source === "object" ? raw.source : {};
  return {
    time: cleanText(raw?.time) || null,
    type: cleanText(raw?.type) || null,
    reason: cleanText(raw?.reason) || null,
    source: {
      type: cleanText(source.type) || null,
      user_email: cleanText(source.userEmail) || null,
      content_owner_id: cleanText(source.contentOwnerId) || null
    },
    details: {
      dispute_reason: cleanText(details.disputeReason) || null,
      dispute_notes: cleanText(details.disputeNotes) || null,
      appeal_explanation: cleanText(details.appealExplanation) || null,
      update_status: cleanText(details.updateStatus) || null
    }
  };
}

// ---------------------------------------------------------------------------
// Google reads
// ---------------------------------------------------------------------------

const CLAIM_SNIPPET_FIELDS = "items(id,videoId,videoTitle,assetId,status,contentType,origin,isPartnerUploaded,thirdPartyClaim,timeCreated,timeStatusLastModified,videoViews,engagedViews,studioInfo),nextPageToken,previousPageToken";
const CLAIM_FIELDS = "items(id,videoId,assetId,status,contentType,origin,isPartnerUploaded,timeCreated,timeStatusLastModified,policy,appliedPolicy,matchInfo,blockOutsideOwnership,ugcType,studioInfo),nextPageToken";
const ASSET_FIELDS = "items(id,type,label,metadataEffective(title,customId,isrc,upc,artist))";

async function claimSearchPages(ctx, params, { maxPages = MAX_PAGES_PER_QUERY, pageToken = "" } = {}) {
  const items = [];
  let token = cleanText(pageToken);
  let page = { next_page_token: null, previous_page_token: null };
  for (let index = 0; index < maxPages; index += 1) {
    const response = await service.partnerRequest(ctx, "GET", "/claimSearch", {
      params: { includeThirdPartyClaims: false, fields: CLAIM_SNIPPET_FIELDS, prettyPrint: false, ...params, ...(token ? { pageToken: token } : {}) }
    });
    const data = response.data || {};
    items.push(...(Array.isArray(data.items) ? data.items : []));
    page = { next_page_token: cleanText(data.nextPageToken) || null, previous_page_token: cleanText(data.previousPageToken) || null };
    token = page.next_page_token;
    if (!token) break;
  }
  return { items, page, truncated: Boolean(page.next_page_token) };
}

async function listClaimsByIds(ctx, claimIds) {
  const items = [];
  for (const batch of chunk(claimIds, ID_BATCH_SIZE)) {
    let token = "";
    for (let index = 0; index < MAX_PAGES_PER_QUERY; index += 1) {
      const response = await service.partnerRequest(ctx, "GET", "/claims", {
        params: { id: batch.join(","), fields: CLAIM_FIELDS, prettyPrint: false, ...(token ? { pageToken: token } : {}) }
      });
      const data = response.data || {};
      items.push(...(Array.isArray(data.items) ? data.items : []));
      token = cleanText(data.nextPageToken);
      if (!token) break;
    }
  }
  return items;
}

// Test hook: lets each test start from an empty asset cache.
function clearAssetCache() {
  assetCache.clear();
}

function cachedAsset(networkId, assetId) {
  const entry = assetCache.get(`${networkId}:${assetId}`);
  if (!entry) return null;
  if (entry.expires_at <= Date.now()) {
    assetCache.delete(`${networkId}:${assetId}`);
    return null;
  }
  return entry.asset;
}

function rememberAsset(networkId, asset) {
  if (!asset?.id) return;
  if (assetCache.size >= ASSET_CACHE_MAX_ITEMS) {
    const now = Date.now();
    for (const [key, entry] of assetCache) if (entry.expires_at <= now) assetCache.delete(key);
    while (assetCache.size >= ASSET_CACHE_MAX_ITEMS) assetCache.delete(assetCache.keys().next().value);
  }
  assetCache.set(`${networkId}:${asset.id}`, { asset, expires_at: Date.now() + ASSET_CACHE_TTL_MS });
}

// Returns Map<assetId, asset> for one network, reading only what the cache does not hold.
async function loadAssets(ctx, account, assetIds, { fresh = false } = {}) {
  const wanted = [...new Set(assetIds.map(cleanText).filter(Boolean))];
  const found = new Map();
  const missing = [];
  wanted.forEach((assetId) => {
    const cached = fresh ? null : cachedAsset(account.id, assetId);
    if (cached) found.set(assetId, cached);
    else missing.push(assetId);
  });
  for (const batch of chunk(missing, ID_BATCH_SIZE)) {
    const response = await service.partnerRequest(ctx, "GET", "/assets", {
      params: { id: batch.join(","), fetchMetadata: "effective", fields: ASSET_FIELDS, prettyPrint: false }
    });
    (Array.isArray(response.data?.items) ? response.data.items : []).forEach((item) => {
      const asset = normalizeAsset(item);
      if (!asset?.id) return;
      found.set(asset.id, asset);
      rememberAsset(account.id, asset);
    });
  }
  return found;
}

async function loadVideoMetadata(videoIds, stats, errors) {
  const ids = [...new Set(videoIds.map(cleanText).filter(Boolean))];
  if (!ids.length) return new Map();
  try {
    const byId = await getVideosMetadataFromYoutube(ids);
    if (stats) stats.video_metadata_requests += Math.ceil(ids.length / 50);
    return new Map(Object.entries(byId || {}).map(([videoId, meta]) => [videoId, normalizeVideo(meta)]));
  } catch (error) {
    if (errors) errors.push({ network_id: null, network_name: "YouTube Data API", scope: "video_metadata", message: store.rawErrorMessage(error) });
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function normalizeSearchRequest(body) {
  const source = body && typeof body === "object" ? body : {};
  const mode = lower(source.mode) || "videos";
  if (!MODES.includes(mode)) throw badRequest(`Unknown search mode "${mode}"`);
  const request = {
    mode,
    networks: resolveNetworks(source.network_ids ?? source.networkIds ?? source.network_id),
    filters: parseFilters(source.filters),
    include_details: source.include_details === true || source.include_details === "true" || source.includeDetails === true,
    query: cleanText(source.query ?? source.q),
    page_token: cleanText(source.page_token ?? source.pageToken),
    video_ids: [],
    asset_ids: [],
    claim_ids: [],
    invalid: []
  };
  if (mode === "videos") {
    const parsed = parseVideoInputs(source.videos ?? source.video_input ?? source.videoInput);
    if (!parsed.ids.length) throw badRequest("Enter at least one valid YouTube video link or 11-character video ID.", { invalid: parsed.invalid });
    if (parsed.ids.length > LIMITS.max_videos) throw badRequest(`A lookup can contain at most ${LIMITS.max_videos} unique videos.`);
    request.video_ids = parsed.ids;
    request.invalid = parsed.invalid;
  } else if (mode === "assets") {
    const parsed = parseIdList(source.asset_ids ?? source.assetIds ?? source.assets);
    if (!parsed.ids.length) throw badRequest("Enter at least one asset ID.", { invalid: parsed.invalid });
    if (parsed.ids.length > LIMITS.max_assets) throw badRequest(`A lookup can contain at most ${LIMITS.max_assets} asset IDs.`);
    request.asset_ids = parsed.ids;
    request.invalid = parsed.invalid;
  } else if (mode === "claims") {
    const parsed = parseIdList(source.claim_ids ?? source.claimIds ?? source.claims);
    if (!parsed.ids.length) throw badRequest("Enter at least one claim ID.", { invalid: parsed.invalid });
    if (parsed.ids.length > LIMITS.max_claim_ids) throw badRequest(`A lookup can contain at most ${LIMITS.max_claim_ids} claim IDs.`);
    request.claim_ids = parsed.ids;
    request.invalid = parsed.invalid;
  } else if (mode === "explore") {
    if (request.networks.length !== 1) throw badRequest("Explore searches one CMS network at a time.");
    const hasFilter = request.query || request.filters.statuses.length || request.filters.content_types.length || request.filters.origins.length
      || request.filters.created_after || request.filters.created_before || request.filters.status_modified_after
      || request.filters.status_modified_before || request.filters.partner_uploaded !== null;
    if (!hasFilter) throw badRequest("Enter a search text or at least one filter to explore claims.");
  }
  if (request.page_token && mode !== "explore") request.page_token = "";
  return request;
}

async function searchClaims({ user, body }) {
  const started = Date.now();
  const request = normalizeSearchRequest(body);
  const allowed = allowedLabelsOf(user);
  const loadDetails = request.include_details || Boolean(allowed);
  const stats = createStats();
  const errors = [];
  const raw = new Map(); // key -> { raw, account }
  let page = null;

  const contexts = new Map();
  await service.mapWithConcurrency(request.networks, READ_CONCURRENCY, async (account) => {
    try {
      contexts.set(account.id, await contextFor(account, stats));
    } catch (error) {
      store.noteCmsAuthFailure(error, account.id);
      // A refused credential is a credentials problem (the page offers re-authorization); a token
      // service that merely did not answer is a transient read error like any other.
      const scope = upstreamStatus(error) === 401 ? "credentials" : "search";
      errors.push({ network_id: account.id, network_name: account.name, scope, message: store.errorMessage(error) });
    }
  });

  const remember = (items, account) => {
    items.forEach((item) => {
      if (!cleanText(item?.id)) return;
      raw.set(claimKey(account.id, item.id), { raw: item, account });
    });
  };
  // A token Google rejects mid-search is a credentials problem whatever call it answered: the
  // page then offers re-authorization instead of showing a per-batch search error.
  const record = (account, scope, error, extra = {}) => {
    store.noteCmsAuthFailure(error, account.id);
    const kind = upstreamStatus(error) === 401 ? "credentials" : scope;
    errors.push({ network_id: account.id, network_name: account.name, scope: kind, message: store.errorMessage(error), ...extra });
  };

  const tasks = [];
  request.networks.forEach((account) => {
    const ctx = contexts.get(account.id);
    if (!ctx) return;
    if (request.mode === "videos") {
      chunk(request.video_ids, LIMITS.video_batch_size).forEach((ids) => tasks.push({ account, ctx, kind: "videos", ids }));
    } else if (request.mode === "assets") {
      request.asset_ids.forEach((assetId) => tasks.push({ account, ctx, kind: "asset", assetId }));
    } else if (request.mode === "claims") {
      chunk(request.claim_ids, ID_BATCH_SIZE).forEach((ids) => tasks.push({ account, ctx, kind: "claims", ids }));
    } else {
      tasks.push({ account, ctx, kind: "explore" });
    }
  });

  await service.mapWithConcurrency(tasks, READ_CONCURRENCY, async (task) => {
    // Errors of a videos batch name their videos, so each video row only shows its own.
    const extra = task.kind === "videos" ? { video_ids: task.ids } : {};
    try {
      if (task.kind === "videos") {
        const result = await claimSearchPages(task.ctx, { videoId: task.ids.join(","), ...filterParams(request.filters) });
        remember(result.items, task.account);
        if (result.truncated) errors.push({ network_id: task.account.id, network_name: task.account.name, scope: "search", message: `More than ${MAX_PAGES_PER_QUERY} result pages for one batch of videos; narrow the lookup.`, ...extra });
      } else if (task.kind === "asset") {
        const result = await claimSearchPages(task.ctx, { assetId: task.assetId, ...filterParams(request.filters) });
        remember(result.items, task.account);
        if (result.truncated) errors.push({ network_id: task.account.id, network_name: task.account.name, scope: "search", message: `Asset ${task.assetId} has more claims than the ${MAX_PAGES_PER_QUERY} pages read; add filters to see the rest.` });
      } else if (task.kind === "claims") {
        remember(await listClaimsByIds(task.ctx, task.ids), task.account);
      } else {
        const params = { ...filterParams(request.filters) };
        if (request.query) params.q = request.query;
        if (request.filters.sort) params.sort = request.filters.sort;
        const result = await claimSearchPages(task.ctx, params, { maxPages: 1, pageToken: request.page_token });
        remember(result.items, task.account);
        page = result.page;
      }
    } catch (error) {
      record(task.account, "search", error, extra);
    }
  });

  // Hydration: asset metadata per network (labels are mandatory for limited users).
  const assetsByNetwork = new Map();
  if (loadDetails && raw.size) {
    const groups = new Map();
    raw.forEach(({ raw: item, account }) => {
      const assetId = cleanText(item.assetId);
      if (!assetId) return;
      if (!groups.has(account.id)) groups.set(account.id, { account, ids: new Set() });
      groups.get(account.id).ids.add(assetId);
    });
    await service.mapWithConcurrency([...groups.values()], READ_CONCURRENCY, async (group) => {
      try {
        assetsByNetwork.set(group.account.id, await loadAssets(contexts.get(group.account.id), group.account, [...group.ids], { fresh: Boolean(allowed) }));
      } catch (error) {
        record(group.account, "assets", error);
        assetsByNetwork.set(group.account.id, new Map());
      }
    });
  }

  const requestedVideos = new Set(request.video_ids);
  let claims = [...raw.values()].map(({ raw: item, account }) => normalizeClaim(item, account, {
    asset: assetsByNetwork.get(account.id)?.get(cleanText(item.assetId)) || null,
    allowed
  }));
  if (request.mode === "videos") claims = claims.filter((claim) => requestedVideos.has(claim.video_id));
  if (request.mode === "claims") {
    const wanted = new Set(request.claim_ids);
    claims = claims.filter((claim) => wanted.has(claim.claim_id));
  }
  claims = claims.filter((claim) => matchesFilters(claim, request.filters));
  if (allowed) claims = claims.filter((claim) => claim.asset && assetMatchesLabels(claim.asset, allowed));
  // An explore page keeps the order the user asked claimSearch for (sort=); the other modes
  // merge several calls and show the newest claims first.
  if (request.mode !== "explore") {
    claims.sort((left, right) => (right.time_created || "").localeCompare(left.time_created || "") || left.key.localeCompare(right.key));
  }

  // Video previews (YouTube Data API): every requested video in videos mode, otherwise the
  // videos of the claims shown, in that order, capped to protect the quota.
  let videos = new Map();
  if (request.include_details) {
    const wanted = request.mode === "videos" ? request.video_ids : [...new Set(claims.map((claim) => claim.video_id).filter(Boolean))];
    const hydrated = wanted.slice(0, LIMITS.max_preview_videos);
    if (hydrated.length < wanted.length) {
      errors.push({ network_id: null, network_name: "YouTube Data API", scope: "video_metadata", message: `Previews were loaded for the first ${LIMITS.max_preview_videos} videos only.` });
    }
    videos = await loadVideoMetadata(hydrated, stats, errors);
    claims.forEach((claim) => {
      claim.video = videos.get(claim.video_id) || null;
      if (!claim.video_title && claim.video?.title) claim.video_title = claim.video.title;
    });
  }

  const videoRows = request.mode === "videos"
    ? request.video_ids.map((videoId) => {
      const own = claims.filter((claim) => claim.video_id === videoId);
      const meta = videos.get(videoId) || null;
      return {
        video_id: videoId,
        video_url: videoUrl(videoId),
        title: meta?.title || own.find((claim) => claim.video_title)?.video_title || "",
        channel_title: meta?.channel_title || "",
        thumbnail: meta?.thumbnail || "",
        duration_text: meta?.duration_text || "",
        published_at: meta?.published_at || "",
        claim_count: own.length,
        releasable_count: own.filter((claim) => claim.can_release).length,
        // Credentials errors concern every video; a search error only the videos of its batch.
        errors: errors.filter((error) => error.network_id && (error.scope === "search" || error.scope === "credentials")
          && (error.scope === "credentials" || !Array.isArray(error.video_ids) || error.video_ids.includes(videoId)))
          .map((error) => ({ network_id: error.network_id, network_name: error.network_name, message: error.message }))
      };
    })
    : [];

  return {
    mode: request.mode,
    networks: request.networks.map(publicNetwork),
    invalid: request.invalid,
    videos: videoRows,
    claims,
    errors,
    details_included: loadDetails,
    details_required: Boolean(allowed),
    page,
    request_plan: { ...stats, duration_ms: Date.now() - started },
    limits: LIMITS,
    totals: {
      videos: request.video_ids.length,
      claims: claims.length,
      releasable: claims.filter((claim) => claim.can_release).length,
      errors: errors.length
    }
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

async function getClaimDetail({ user, networkId, claimId }) {
  const id = cleanText(claimId);
  if (!id) throw badRequest("Claim ID is required");
  const [account] = resolveNetworks([networkId], { max: 1 });
  const allowed = allowedLabelsOf(user);
  const stats = createStats();
  const ctx = await contextFor(account, stats);

  const rawClaim = await service.getClaim(ctx, id);
  if (!cleanText(rawClaim?.id)) throw notFound("Claim not found in this CMS");

  const errors = [];
  let asset = null;
  const assetId = cleanText(rawClaim.assetId);
  if (assetId) {
    try {
      asset = (await loadAssets(ctx, account, [assetId], { fresh: Boolean(allowed) })).get(assetId) || null;
    } catch (error) {
      // A limited user's labels cannot be verified without the asset: that is Google's error
      // (502/504/429 at the controller), not a "not in your labels" refusal.
      if (allowed) throw error;
      errors.push({ scope: "assets", message: store.errorMessage(error) });
    }
  }
  if (allowed && !(asset && assetMatchesLabels(asset, allowed))) throw forbidden("This claim is not assigned to your allowed labels.");

  const videos = await loadVideoMetadata([cleanText(rawClaim.videoId)], stats, errors);
  const claim = normalizeClaim(rawClaim, account, { video: videos.get(cleanText(rawClaim.videoId)) || null, asset, allowed });

  let history = [];
  let historyError = "";
  try {
    const response = await service.partnerRequest(ctx, "GET", `/claimHistory/${encodeURIComponent(id)}`);
    history = (Array.isArray(response.data?.event) ? response.data.event : []).map(normalizeHistoryEvent)
      .sort((left, right) => (right.time || "").localeCompare(left.time || ""));
  } catch (error) {
    historyError = store.errorMessage(error);
  }

  // Limited users see their own operations only, as in the history page.
  const limited = isLimitedUser(user);
  const localEvents = db.prepare(`
    SELECT ${HISTORY_COLUMNS} FROM content_id_claim_events
    WHERE network_id = ? AND claim_id = ? ${limited ? "AND created_by = ?" : ""}
    ORDER BY id DESC LIMIT 50
  `).all(...[account.id, id, ...(limited ? [Number(user?.id) || 0] : [])]).map(historyRow);

  return { claim, history, history_error: historyError, local_events: localEvents, errors, request_plan: stats };
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

// Items with a malformed claim id are kept (the frontend treats a missing result as "unknown")
// and marked, so the worker answers "skipped" without touching Google. The free-text fields are
// cut to what the audit columns are meant to hold.
function normalizeReleaseItems(releases) {
  const unique = new Map();
  (Array.isArray(releases) ? releases : []).forEach((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return;
    const item = {
      network_id: Number(rawItem.network_id ?? rawItem.networkId ?? rawItem.accountId),
      claim_id: cleanText(rawItem.claim_id ?? rawItem.claimId ?? rawItem.id),
      video_id: extractVideoId(rawItem.video_id ?? rawItem.videoId ?? rawItem.video_url ?? "") || "",
      asset_id: cleanText(rawItem.asset_id ?? rawItem.assetId) || "",
      video_title: cleanText(rawItem.video_title ?? rawItem.videoTitle).slice(0, MAX_TITLE_LENGTH),
      channel_title: cleanText(rawItem.channel_title ?? rawItem.channelTitle).slice(0, MAX_TITLE_LENGTH),
      asset_title: cleanText(rawItem.asset_title ?? rawItem.assetTitle).slice(0, MAX_TITLE_LENGTH),
      isrc: cleanText(rawItem.isrc).toUpperCase().slice(0, MAX_ISRC_LENGTH)
    };
    if (!(item.network_id > 0) || !item.claim_id) return;
    item.invalid = !SIMPLE_ID_PATTERN.test(item.claim_id);
    const key = claimKey(item.network_id, item.claim_id);
    if (!unique.has(key)) unique.set(key, { ...item, key });
  });
  return [...unique.values()];
}

// Google never answered: the deadline passed or the socket dropped after the request went out,
// so the call may or may not have been applied.
function answerLost(error) {
  if (upstreamStatus(error)) return false;
  if (error?.timedOut) return true;
  return LOST_ANSWER_CODES.has(error?.code) || /socket hang up/i.test(String(error?.message || ""));
}

function isQuotaError(error) {
  return upstreamStatus(error) === 403 && store.isQuotaReason(error?.reason);
}

function isConflict(error) {
  return upstreamStatus(error) === 409;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outcomeOfError(error) {
  const status = upstreamStatus(error);
  if (answerLost(error)) return { outcome: "unknown", retryable: false };
  if (status === 429 || isQuotaError(error)) return { outcome: "failed", retryable: true };
  // A 409 is Google aborting a write that collided with another one: the next attempt usually lands.
  if (isConflict(error)) return { outcome: "failed", retryable: true };
  if (status >= 500 || NEVER_SENT_CODES.has(error?.code)) return { outcome: "failed", retryable: true };
  return { outcome: "failed", retryable: false };
}

function retryAfterOf(error) {
  const value = Number(error?.retryAfter ?? error?.response?.headers?.["retry-after"]);
  if (Number.isFinite(value) && value >= 0) return value;
  return isQuotaError(error) ? QUOTA_RETRY_AFTER_SECONDS : null;
}

// One short, single-attempt read of a claim; null when Google did not answer that either.
async function readClaimBack(ctx, claimId) {
  try {
    const response = await service.partnerRequest(ctx, "GET", `/claims/${encodeURIComponent(claimId)}`, { timeout: READ_BACK_TIMEOUT_MS, retry: false });
    return response.data && typeof response.data === "object" ? response.data : null;
  } catch {
    return null;
  }
}

// The claim returned with a release / re-check result is built from the claims resource, which
// never carries the snippet-only fields (video title, views, third-party flag) and, after a
// PATCH, is a sparse body. The richer pre-read wins, the confirmed status is applied, and the
// keys the resource cannot know are dropped so the table row keeps what it already shows.
function confirmedClaim({ before = null, after = null, item = {}, status, allowed = null }) {
  const claim = { ...(after || {}), ...(before || {}) };
  const finalStatus = normalizeStatus(status) || claim.status || null;
  const videoId = before?.video_id || item.video_id || after?.video_id || "";
  const blockReason = releaseBlockReason(finalStatus, claim.asset || null, allowed);
  const reinstateReason = reinstateBlockReason(finalStatus, claim.asset || null, allowed);
  const confirmReason = confirmBlockReason(finalStatus, claim.asset || null, allowed);
  Object.assign(claim, {
    status: finalStatus,
    time_status_last_modified: after?.time_status_last_modified || before?.time_status_last_modified || null,
    video_id: videoId,
    video_url: videoUrl(videoId),
    video_title: before?.video_title || item.video_title || after?.video_title || "",
    can_release: !blockReason,
    release_block_reason: blockReason,
    can_reinstate: !reinstateReason,
    reinstate_block_reason: reinstateReason,
    can_confirm: !confirmReason,
    confirm_block_reason: confirmReason
  });
  if (!claim.video) delete claim.video;
  if (claim.video_views === null || claim.video_views === undefined) delete claim.video_views;
  if (claim.engaged_views === null || claim.engaged_views === undefined) delete claim.engaged_views;
  if (!claim.third_party) delete claim.third_party;
  if (!claim.asset) delete claim.asset;
  return claim;
}

function recordEvent(row) {
  const info = db.prepare(`
    INSERT INTO content_id_claim_events (
      operation_id, action, network_id, network_name, content_owner_id, claim_id, video_id, video_title, channel_title,
      asset_id, asset_title, isrc, content_type, previous_status, result, result_status, message, note, response_json,
      duration_ms, created_by, created_by_name, created_by_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.operation_id, row.action || "release", row.network_id, row.network_name || null, row.content_owner_id || null,
    row.claim_id, row.video_id || null, row.video_title || null, row.channel_title || null,
    row.asset_id || null, row.asset_title || null, row.isrc || null, row.content_type || null, row.previous_status || null,
    row.result, row.result_status || null, row.message || null, row.note || null,
    row.response_json ? String(row.response_json).slice(0, 20000) : null,
    Number.isFinite(row.duration_ms) ? Math.round(row.duration_ms) : null,
    row.created_by || null, row.created_by_name || null, row.created_by_email || null
  );
  return Number(info.lastInsertRowid);
}

// Completes the row written before a release call once Google's answer (or its absence) is known.
function updateEvent(id, patch) {
  db.prepare(`
    UPDATE content_id_claim_events
    SET result = ?, result_status = ?, message = ?, response_json = ?, duration_ms = COALESCE(?, duration_ms)
    WHERE id = ?
  `).run(
    patch.result, patch.result_status || null, patch.message || null,
    patch.response_json ? String(patch.response_json).slice(0, 20000) : null,
    Number.isFinite(patch.duration_ms) ? Math.round(patch.duration_ms) : null,
    id
  );
}

function actorFields(user) {
  return {
    created_by: Number(user?.id) || null,
    created_by_name: cleanText(user?.full_name) || cleanText(user?.email) || null,
    created_by_email: cleanText(user?.email) || null
  };
}

// The audit columns known before Google answers: the claim, what the page knew about its video
// and asset, the note and the actor. An unknown CMS leaves network_name / content_owner_id empty.
function auditFields({ operationId, item, before, account, note, actor, action = "release" }) {
  return {
    operation_id: operationId,
    action,
    network_id: item.network_id,
    network_name: account?.name || null,
    content_owner_id: account?.network_code || null,
    claim_id: item.claim_id,
    video_id: before?.video_id || item.video_id || null,
    video_title: item.video_title || before?.video_title || null,
    channel_title: item.channel_title || null,
    asset_id: before?.asset_id || item.asset_id || null,
    asset_title: before?.asset?.title || item.asset_title || null,
    isrc: before?.asset?.isrc || item.isrc || null,
    content_type: before?.content_type || null,
    previous_status: before?.status || null,
    note: note || null,
    ...actor
  };
}

function outcomeFields(result) {
  return {
    result: result.outcome,
    result_status: result.status || null,
    message: result.message || null,
    response_json: result.claim ? JSON.stringify(result.claim) : null,
    duration_ms: result.duration_ms
  };
}

// The three status writes of the page share one pipeline (pre-read, guards, audit row before the
// call, the PATCH, read-backs, outcome vocabulary); only the target status, the statuses a write
// starts from and the words differ. Reinstate and confirm both end active, so anything that maps
// a status back to "the write that produced it" must consider both (see writeOne / recheckClaims).
const CLAIM_WRITES = Object.freeze({
  release: Object.freeze({
    action: "release",
    verb: "release",
    past: "released",
    target: "inactive",
    from: RELEASABLE_STATUSES,
    done: "released",
    already: "already_inactive",
    refusedFlag: "releaseRefused",
    emptyError: "Select at least one claim to release.",
    pending: "Release sent to Google but the answer was not recorded (the server may have restarted); re-check the claim.",
    success: "Claim released and confirmed inactive by Google.",
    cannot: (status) => `Claims in ${status} status cannot be released through the API.`,
    patch: (ctx, claimId) => service.releaseClaim(ctx, claimId)
  }),
  reinstate: Object.freeze({
    action: "reinstate",
    verb: "reinstate",
    past: "reinstated",
    target: "active",
    from: REINSTATABLE_STATUSES,
    done: "reinstated",
    already: "already_active",
    refusedFlag: "reinstateRefused",
    emptyError: "Select at least one claim to reinstate.",
    pending: "Reinstate sent to Google but the answer was not recorded (the server may have restarted); re-check the claim.",
    success: "Claim reinstated and confirmed active by Google.",
    cannot: (status) => `Only inactive (released) claims can be reinstated through the API; this claim is ${status}.`,
    patch: (ctx, claimId) => service.reinstateClaim(ctx, claimId)
  }),
  confirm: Object.freeze({
    action: "confirm",
    verb: "confirm",
    past: "confirmed",
    target: "active",
    from: CONFIRMABLE_STATUSES,
    done: "confirmed",
    already: "already_active",
    refusedFlag: "confirmRefused",
    emptyError: "Select at least one claim to confirm.",
    pending: "Confirm sent to Google but the answer was not recorded (the server may have restarted); re-check the claim.",
    success: "Claim confirmed: Google reports it active.",
    cannot: (status) => `Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is ${status}.`,
    patch: (ctx, claimId) => service.confirmClaim(ctx, claimId)
  })
});

// The audit row of an unanswered write that nothing has settled since: the newest `unknown` row
// of that action with no later settled row of any action. A later failed or skipped attempt says
// nothing about the lost call, so it does not hide the pending row.
function pendingWriteRow(action, networkId, claimId, excludeEventId = 0) {
  const excluded = Number(excludeEventId) || 0;
  return db.prepare(`
    SELECT * FROM content_id_claim_events
    WHERE network_id = ? AND claim_id = ? AND id != ? AND result = 'unknown' AND action = ?
      AND id > COALESCE((
        SELECT MAX(id) FROM content_id_claim_events
        WHERE network_id = ? AND claim_id = ? AND id != ? AND result IN (${SETTLED_RESULTS.map(() => "?").join(", ")})
      ), 0)
    ORDER BY id DESC LIMIT 1
  `).get(networkId, claimId, excluded, action, networkId, claimId, excluded, ...SETTLED_RESULTS) || null;
}

// The unanswered call a status read answers: the NEWEST pending row among the writes that target
// that status (reinstate and confirm both end active). Older pending rows are left alone: a later
// call recorded while the claim was still elsewhere proves they had not landed, so settling them
// would invent a write that never happened. Returns { write, row } or null.
function newestPendingWrite(status, networkId, claimId, excludeEventId = 0) {
  let found = null;
  Object.values(CLAIM_WRITES).forEach((candidate) => {
    if (candidate.target !== status) return;
    const row = pendingWriteRow(candidate.action, networkId, claimId, excludeEventId);
    if (row && (!found || row.id > found.row.id)) found = { write: candidate, row };
  });
  return found;
}

// A write whose pre-read (or Google's refusal) shows the claim already in `status` completes the
// pending audit row of the earlier call that put it there, the way a re-check would; `by` is the
// verb of the write that found it. Returns the write whose row was settled, or null.
function settlePendingWrite(status, { networkId, claimId, excludeEventId = 0, claim, by }) {
  const found = newestPendingWrite(status, networkId, claimId, excludeEventId);
  if (!found) return null;
  updateEvent(found.row.id, {
    result: found.write.done,
    result_status: status,
    message: `Confirmed ${status} by a later ${by} attempt: the earlier unanswered ${found.write.verb} call had been applied.`,
    response_json: claim ? JSON.stringify(claim) : null
  });
  return found.write;
}

// The PATCH, repeated after a pause when Google aborted it because of a concurrent write, as long
// as the batch deadline leaves room for the pause and another attempt.
async function patchUntilNotAborted(write, ctx, claimId, deadline) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write.patch(ctx, claimId);
    } catch (error) {
      const pause = CONFLICT_RETRY_MS * (attempt + 1);
      if (!isConflict(error) || attempt >= MAX_CONFLICT_RETRIES || (deadline && Date.now() + pause >= deadline)) throw error;
      await sleep(pause);
    }
  }
}

async function sendWrite(write, { ctx, item, account, before, allowed, finish, onAuthFailure, eventId = 0, deadline = 0 }) {
  const { verb, past, target } = write;
  const normalized = (resource) => normalizeClaim({ ...resource, id: cleanText(resource?.id) || item.claim_id }, account, { asset: before?.asset || null, allowed });
  const confirmed = (after, message) => finish(write.done, {
    status: after.status,
    message,
    claim: confirmedClaim({ before, after, item, status: after.status, allowed })
  });
  try {
    const response = await patchUntilNotAborted(write, ctx, item.claim_id, deadline);
    if (response?.appliedOnEarlierAttempt) {
      // The first attempt was applied by Google but its answer was lost; the automatic repeat was
      // refused because the claim was already there. The work is this call's.
      const resource = { ...response };
      delete resource.appliedOnEarlierAttempt;
      return confirmed(normalized(resource), `Google did not answer the first attempt; the repeat was refused because the claim was already ${target}, so this call had been applied.`);
    }
    if (response?.[write.refusedFlag]) {
      // Google refused target -> target: the claim was already there when this call arrived, put
      // there by an earlier call whose answer was lost or by someone else meanwhile. Nothing
      // changed now, so the outcome is "already <target>", not a write of this call.
      const resource = { ...response };
      delete resource[write.refusedFlag];
      const after = normalized(resource);
      const claim = confirmedClaim({ before, after, item, status: target, allowed });
      let message = `Google refused the ${verb} because the claim was already ${target}; nothing was changed by this call.`;
      try {
        const settled = settlePendingWrite(target, { networkId: item.network_id, claimId: item.claim_id, excludeEventId: eventId, claim, by: verb });
        if (settled === write) message = `Claim was already ${target}: the earlier ${verb} call whose answer was lost had been applied. Nothing was changed by this call.`;
        else if (settled) message = `Google refused the ${verb} because the claim was already ${target}: the earlier unanswered ${settled.verb} call had been applied. Nothing was changed by this call.`;
      } catch (error) {
        console.error(`[claim-manager] could not confirm the pending write of ${item.key}: ${error?.message || error}`);
      }
      return finish(write.already, { status: target, message, claim });
    }
    let after = normalized(response);
    if (!after.status) {
      // A 200 without a status says nothing about the claim: read it back once.
      const readBack = await readClaimBack(ctx, item.claim_id);
      if (readBack) after = normalized(readBack);
    }
    if (!after.status) {
      return finish("unknown", { message: `Google accepted the ${verb} call without reporting the claim status, and the claim could not be read back; re-check it before trying again.` });
    }
    if (after.status !== target) {
      return finish("failed", {
        status: after.status,
        message: `Google answered with status "${after.status}" instead of ${target}.`,
        claim: confirmedClaim({ before, after, item, status: after.status, allowed })
      });
    }
    return confirmed(after, write.success);
  } catch (error) {
    // A token Google rejects stops the rest of this network's batch: the same token would fail.
    if (store.noteCmsAuthFailure(error, item.network_id) && typeof onAuthFailure === "function") onAuthFailure(store.errorMessage(error));
    const { outcome, retryable } = outcomeOfError(error);
    const reason = cleanText(error?.reason) || null;
    const retryAfter = retryAfterOf(error);
    // Google refused the transition and the read-back shows why: the claim is no longer in a
    // status this write accepts. The row gets its current status instead of the stale pre-read one.
    const currentStatus = upstreamStatus(error) === 400 && error?.currentClaim ? normalizeStatus(error.currentClaim.status) : "";
    if (currentStatus && !write.from.has(currentStatus)) {
      return finish("failed", {
        status: currentStatus,
        message: `Claim is now ${currentStatus} and cannot be ${past} through the API (Google: ${store.errorMessage(error)}).`,
        reason,
        retryable: false,
        claim: confirmedClaim({ before, after: normalized(error.currentClaim), item, status: currentStatus, allowed })
      });
    }
    if (outcome !== "unknown") return finish("failed", { message: store.errorMessage(error), reason, retryable, retry_after: retryAfter });
    // Google never answered: did the write land? One short read-back decides when it can.
    const readBack = await readClaimBack(ctx, item.claim_id);
    const status = readBack ? normalizeStatus(readBack.status) : "";
    if (status === target) return confirmed(normalized(readBack), `Google did not answer the ${verb} call, but the claim reads back ${target}.`);
    if (write.from.has(status)) {
      return finish("failed", {
        status,
        message: `${store.errorMessage(error)} The claim still reads back as ${status}, so the ${verb} was not applied; retry it.`,
        reason,
        retryable: true,
        retry_after: retryAfter,
        claim: confirmedClaim({ before, after: normalized(readBack), item, status, allowed })
      });
    }
    return finish("unknown", {
      message: `${store.errorMessage(error)} The ${verb} may still have been applied; re-check the claim before trying again.`,
      reason,
      retryable,
      retry_after: retryAfter
    });
  }
}

// A CMS whose claims cannot be released right now: `blocked` for reasons a retry cannot fix (not
// connected, no Partner scope, a token Google refused), `unavailable` for transient ones (Google's
// token service or the claim pre-read did not answer) which come back failed + retryable.
function isTransientFailure(error) {
  const status = upstreamStatus(error);
  return Boolean(error?.tokenRefreshTransient) || answerLost(error) || status >= 500 || status === 429 || isQuotaError(error) || NEVER_SENT_CODES.has(error?.code);
}

// `signal` (optional): the HTTP request's abort signal. Once the client is gone, the claims not
// reached yet are not sent; the ones in flight finish and are recorded.
async function releaseClaims({ user, releases, note, signal = null }) {
  return writeClaims(CLAIM_WRITES.release, { user, items: releases, note, signal });
}

// Reinstate (inactive -> active) released claims; same pipeline, audit action "reinstate".
async function reinstateClaims({ user, items, note, signal = null }) {
  return writeClaims(CLAIM_WRITES.reinstate, { user, items, note, signal });
}

// Confirm (potential -> active) matches awaiting confirmation; same pipeline, audit action "confirm".
async function confirmClaims({ user, items, note, signal = null }) {
  return writeClaims(CLAIM_WRITES.confirm, { user, items, note, signal });
}

async function writeClaims(write, { user, items: rawItems, note, signal }) {
  const items = normalizeReleaseItems(rawItems);
  if (!items.length) throw badRequest(write.emptyError);
  if (items.length > LIMITS.max_release_items) throw badRequest(`A ${write.verb} batch can contain at most ${LIMITS.max_release_items} claims.`);
  const noteText = cleanText(note);
  if (noteText.length > MAX_NOTE_LENGTH) throw badRequest(`The note must be at most ${MAX_NOTE_LENGTH} characters.`);
  // The batch owns its claims from here (pre-read included) until each outcome is decided, so a
  // re-check that runs meanwhile leaves their pending audit rows to this request.
  const held = new Set(items.filter((item) => !item.invalid).map((item) => item.key));
  held.forEach(holdPending);
  try {
    return await writeBatch(write, { user, items, noteText, signal, held });
  } finally {
    held.forEach(dropPending);
    held.clear();
  }
}

async function writeBatch(write, { user, items, noteText, signal, held }) {
  const { verb, past, target } = write;
  const deadline = Date.now() + releaseBudgetMs();
  const operationId = randomUUID();
  const actor = actorFields(user);
  const allowed = allowedLabelsOf(user);
  const accounts = new Map(listClaimAccounts().map((account) => [account.id, account]));
  const networkIds = [...new Set(items.map((item) => item.network_id))];
  const contexts = new Map();
  const blocked = new Map(); // network_id -> message (skipped, a retry would not help)
  const unavailable = new Map(); // network_id -> { reason, message, retry_after } (failed, retryable)
  const stats = createStats();

  await service.mapWithConcurrency(networkIds, READ_CONCURRENCY, async (networkId) => {
    const account = accounts.get(networkId);
    if (!account) {
      blocked.set(networkId, "CMS network is not connected.");
      return;
    }
    if (!account.has_partner_scope) {
      blocked.set(networkId, "The CMS authorization is missing the YouTube Partner scope. Re-authorize it in Settings > Network.");
      return;
    }
    try {
      contexts.set(networkId, await contextFor(account, stats));
    } catch (error) {
      if (!store.noteCmsAuthFailure(error, networkId) && isTransientFailure(error)) {
        unavailable.set(networkId, { reason: "cms_unavailable", message: `Not sent: ${store.errorMessage(error)}`, retry_after: retryAfterOf(error) });
        return;
      }
      blocked.set(networkId, store.errorMessage(error));
    }
  });

  // Read the claims first: the audit keeps the status before the write, limited users are
  // checked against their labels, and claims already in the target status are not written again.
  const current = new Map(); // key -> ClaimRow
  await service.mapWithConcurrency(networkIds.filter((id) => contexts.has(id)), READ_CONCURRENCY, async (networkId) => {
    const account = accounts.get(networkId);
    const ctx = contexts.get(networkId);
    const ids = items.filter((item) => item.network_id === networkId && !item.invalid).map((item) => item.claim_id);
    if (!ids.length) return;
    try {
      const rawClaims = await listClaimsByIds(ctx, ids);
      let assets = new Map();
      const assetIds = rawClaims.map((item) => cleanText(item.assetId)).filter(Boolean);
      if (assetIds.length) {
        try {
          assets = await loadAssets(ctx, account, assetIds, { fresh: Boolean(allowed) });
        } catch (error) {
          if (allowed) throw error;
        }
      }
      rawClaims.forEach((item) => {
        const claim = normalizeClaim(item, account, { asset: assets.get(cleanText(item.assetId)) || null, allowed });
        current.set(claim.key, claim);
      });
    } catch (error) {
      // Nothing is sent blind: without the pre-read the already-in-target and wrong-status guards
      // cannot run, the audit would lose the previous status, and a claim already in the target
      // status would be reported as written by this call. The CMS's items come back failed +
      // retryable instead.
      const message = store.errorMessage(error);
      console.error(`[claim-manager] ${verb} pre-read failed for network ${networkId}: ${message}`);
      if (store.noteCmsAuthFailure(error, networkId)) {
        blocked.set(networkId, message);
        return;
      }
      const transient = isTransientFailure(error);
      unavailable.set(networkId, {
        reason: "pre_read_failed",
        retryable: transient,
        message: `Not sent: the claim could not be read before the ${verb} (${message}).${transient ? " Retry." : ""}`,
        retry_after: transient ? retryAfterOf(error) : null
      });
    }
  });

  const writeOne = async (item) => {
    const started = Date.now();
    const account = accounts.get(item.network_id) || null;
    const before = current.get(item.key) || null;
    const base = {
      key: item.key,
      network_id: item.network_id,
      claim_id: item.claim_id,
      status: before?.status || null,
      message: "",
      reason: null,
      retryable: false,
      retry_after: null,
      claim: before ? confirmedClaim({ before, item, status: before.status, allowed }) : null
    };
    const finish = (outcome, patch = {}) => ({ ...base, outcome, ...patch, duration_ms: Date.now() - started });

    if (item.invalid) return finish("skipped", { message: "Invalid claim ID." });
    if (blocked.has(item.network_id)) return finish("skipped", { message: blocked.get(item.network_id) });
    if (unavailable.has(item.network_id)) {
      const failure = unavailable.get(item.network_id);
      return finish("failed", { reason: failure.reason, retryable: failure.retryable !== false, retry_after: failure.retry_after, message: failure.message });
    }
    if (allowed) {
      if (!before) return finish("skipped", { message: "This claim could not be found in the selected CMS." });
      if (!before.asset || !assetMatchesLabels(before.asset, allowed)) {
        return finish("skipped", { message: "This claim is not assigned to your allowed labels." });
      }
    }
    // Another request of this process is still writing the claim: whatever the pre-read says may be
    // superseded within seconds, so nothing is decided here.
    if (releasesInFlight.has(item.key)) return finish("skipped", { message: "This claim is being changed by another request right now; re-check it in a minute." });
    // The pre-read is evidence for the newest unanswered call that targeted the status it shows,
    // whichever write made it (reinstate and confirm both end active): that row is settled here,
    // before this write replaces the state and hides it from every later re-check. Same rule as
    // recheckClaims, so a write and a re-check of one state tell the same history.
    let settled = null;
    if (before) {
      try {
        settled = settlePendingWrite(before.status, { networkId: item.network_id, claimId: item.claim_id, claim: base.claim, by: verb });
      } catch (error) {
        console.error(`[claim-manager] could not confirm the pending write of ${item.key}: ${error?.message || error}`);
      }
    }
    if (before && before.status === target) {
      // A retry after a call whose answer was lost usually lands here (Google had applied it): its
      // pending audit row was completed above instead of staying "unknown" forever.
      const message = settled === write
        ? `Claim was already ${target}: the earlier ${verb} call whose answer was lost had been applied. Nothing was sent to Google.`
        : `Claim was already ${target}; nothing was sent to Google.`;
      return finish(write.already, { status: before.status, message });
    }
    if (before && !write.from.has(before.status)) {
      return finish("skipped", { message: write.cannot(before.status) });
    }
    // The client is gone (run cancelled, connection dropped): nothing more is sent, so a re-check
    // of this claim reads its untouched status and the dialog offers it again.
    if (signal?.aborted) {
      return finish("skipped", { reason: "cancelled", message: "Not sent: the run was cancelled (the connection closed) before this claim was reached." });
    }
    // Nothing is sent once the batch budget is spent. "failed" + retryable (not "skipped"): the
    // dialog offers Retry and the row keeps its releasable state.
    if (Date.now() >= deadline) {
      return finish("failed", {
        reason: "budget_exhausted",
        retryable: true,
        message: "Not sent: Google answered the earlier claims of this batch too slowly and the time budget ran out before this claim was reached. Retry it."
      });
    }

    // The audit row goes in before the call, so a restart mid-batch cannot lose the trace of a
    // claim Google already changed; it is completed once the answer is known. A database problem
    // must never change the outcome of the write itself.
    let eventId = null;
    try {
      eventId = recordEvent({
        ...auditFields({ operationId, item, before, account, note: noteText, actor, action: write.action }),
        result: "unknown",
        result_status: before?.status || null,
        message: write.pending
      });
    } catch (error) {
      console.error(`[claim-manager] could not record ${verb} event ${operationId}/${item.key}: ${error?.message || error}`);
    }
    releasesInFlight.add(item.key);
    let result;
    try {
      result = await sendWrite(write, {
        ctx: contexts.get(item.network_id),
        item,
        account,
        before,
        allowed,
        finish,
        eventId,
        deadline,
        // A token Google rejected mid-batch: the later claims of that CMS are skipped, not sent.
        onAuthFailure: (message) => blocked.set(item.network_id, message)
      });
    } finally {
      releasesInFlight.delete(item.key);
    }
    if (eventId) {
      try {
        updateEvent(eventId, outcomeFields(result));
      } catch (error) {
        console.error(`[claim-manager] could not complete ${verb} event ${operationId}/${item.key}: ${error?.message || error}`);
      }
      result.event_id = eventId;
    }
    return result;
  };

  // Claims of the same video are released one after another (Google aborts concurrent writes on
  // one video); different videos run in parallel. A claim stops being pending as soon as its own
  // outcome is decided, not when the batch ends. Results keep the order of the request.
  const results = new Array(items.length);
  const byVideo = new Map();
  items.forEach((item, index) => {
    const videoId = current.get(item.key)?.video_id || item.video_id || "";
    const group = videoId ? `video:${item.network_id}:${videoId}` : `claim:${item.key}`;
    if (!byVideo.has(group)) byVideo.set(group, []);
    byVideo.get(group).push(index);
  });
  await service.mapWithConcurrency([...byVideo.values()], WRITE_CONCURRENCY, async (indexes) => {
    for (const index of indexes) {
      const item = items[index];
      try {
        results[index] = await writeOne(item);
      } finally {
        if (held.delete(item.key)) dropPending(item.key);
      }
    }
  });

  // Outcomes decided without a Google call (skipped, already in the target status, budget) get
  // their row now.
  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  results.forEach((result) => {
    if (result.event_id) return;
    try {
      recordEvent({
        ...auditFields({
          operationId,
          item: itemsByKey.get(result.key),
          before: current.get(result.key) || null,
          account: accounts.get(result.network_id) || null,
          note: noteText,
          actor,
          action: write.action
        }),
        ...outcomeFields(result)
      });
    } catch (error) {
      console.error(`[claim-manager] could not record ${verb} event ${operationId}/${result.key}: ${error?.message || error}`);
    }
  });

  const summary = { total: results.length, [write.done]: 0, [write.already]: 0, failed: 0, unknown: 0, skipped: 0 };
  results.forEach((result) => { summary[result.outcome] += 1; });
  return {
    operation_id: operationId,
    results: results.map(({ duration_ms, event_id, ...rest }) => rest),
    summary,
    request_plan: stats
  };
}

// ---------------------------------------------------------------------------
// Re-check
// ---------------------------------------------------------------------------

async function recheckClaims({ user, items }) {
  const wanted = normalizeReleaseItems(items);
  if (!wanted.length) throw badRequest("Select at least one claim to re-check.");
  if (wanted.length > MAX_RECHECK_ITEMS) throw badRequest(`A re-check can contain at most ${MAX_RECHECK_ITEMS} claims.`);
  const allowed = allowedLabelsOf(user);
  const accounts = new Map(listClaimAccounts().map((account) => [account.id, account]));
  const stats = createStats();
  const wantedByKey = new Map(wanted.map((item) => [item.key, item]));
  // `in_flight`: a release batch of this process still owns the claim (queued or on the wire), so
  // the status read now may be superseded within a minute and its pending audit row is left alone.
  // `confirmed`: { action, result } when this re-check settled a pending write (so the caller can
  // tell a confirmed release from a confirmed reinstate whatever it was following up).
  const results = new Map(wanted.map((item) => [item.key, {
    key: item.key, network_id: item.network_id, claim_id: item.claim_id, found: false, status: null, claim: null, message: "", in_flight: isReleasePending(item.key), confirmed: null
  }]));
  wanted.filter((item) => item.invalid).forEach((item) => { results.get(item.key).message = "Invalid claim ID."; });

  await service.mapWithConcurrency([...new Set(wanted.map((item) => item.network_id))], READ_CONCURRENCY, async (networkId) => {
    const account = accounts.get(networkId);
    const ids = wanted.filter((item) => item.network_id === networkId && !item.invalid).map((item) => item.claim_id);
    if (!ids.length) return;
    const fail = (message) => ids.forEach((claimId) => { results.get(claimKey(networkId, claimId)).message = message; });
    if (!account) return fail("CMS network is not connected.");
    if (!account.has_partner_scope) return fail("The CMS authorization is missing the YouTube Partner scope.");
    try {
      const ctx = await contextFor(account, stats);
      const rawClaims = await listClaimsByIds(ctx, ids);
      let assets = new Map();
      let assetError = null;
      try {
        assets = await loadAssets(ctx, account, rawClaims.map((item) => cleanText(item.assetId)).filter(Boolean), { fresh: Boolean(allowed) });
      } catch (error) {
        // Asset metadata is optional for a status re-check, except that a limited user's labels
        // cannot be verified without it.
        assetError = error;
      }
      rawClaims.forEach((item) => {
        const claim = normalizeClaim(item, account, { asset: assets.get(cleanText(item.assetId)) || null, allowed });
        const entry = results.get(claim.key);
        if (!entry) return;
        if (allowed && !(claim.asset && assetMatchesLabels(claim.asset, allowed))) {
          entry.message = assetError && !claim.asset
            ? `The claim's asset could not be read, so its labels could not be verified for your account: ${store.errorMessage(assetError)}`
            : "This claim is not assigned to your allowed labels.";
          return;
        }
        entry.found = true;
        entry.status = claim.status;
        entry.claim = confirmedClaim({ before: claim, item: wantedByKey.get(claim.key) || {}, status: claim.status, allowed });
      });
      ids.forEach((claimId) => {
        const entry = results.get(claimKey(networkId, claimId));
        if (!entry.found && !entry.message) entry.message = "Claim was not found in this CMS.";
      });
    } catch (error) {
      store.noteCmsAuthFailure(error, networkId);
      fail(store.errorMessage(error));
    }
  });

  // An earlier write whose answer was lost is confirmed once the claim reads back in its target
  // status: inactive settles a pending release, active a pending reinstate or confirm.
  const actor = actorFields(user);
  const operationId = randomUUID();
  results.forEach((entry) => {
    if (!entry.found) return;
    const candidates = Object.values(CLAIM_WRITES).filter((candidate) => candidate.target === entry.status);
    if (!candidates.length) return;
    // Re-evaluated now, not when the request came in: a write of this claim may have started
    // while Google was answering the read.
    if (entry.in_flight || isReleasePending(entry.key)) {
      entry.in_flight = true;
      return;
    }
    // Reinstate and confirm both end active: the newest unanswered row of either is the call the
    // status most plausibly answers, so that is the one settled (an active claim after a lost
    // confirm must complete the confirm row, not look for a reinstate row and give up).
    const found = newestPendingWrite(entry.status, entry.network_id, entry.claim_id);
    if (!found) return;
    const { write, row: last } = found;
    const account = accounts.get(entry.network_id);
    recordEvent({
      operation_id: operationId,
      action: "recheck",
      network_id: entry.network_id,
      network_name: account?.name || null,
      content_owner_id: account?.network_code || null,
      claim_id: entry.claim_id,
      video_id: entry.claim?.video_id || last.video_id,
      video_title: last.video_title || entry.claim?.video_title || null,
      channel_title: last.channel_title,
      asset_id: entry.claim?.asset_id || last.asset_id,
      asset_title: entry.claim?.asset?.title || last.asset_title,
      isrc: entry.claim?.asset?.isrc || last.isrc,
      content_type: entry.claim?.content_type || last.content_type,
      previous_status: last.previous_status,
      result: write.done,
      result_status: entry.status,
      message: `Confirmed ${write.target} on re-check after an unanswered ${write.verb} call.`,
      note: last.note,
      response_json: entry.claim ? JSON.stringify(entry.claim) : null,
      ...actor
    });
    entry.message = `Confirmed ${write.target}; the earlier ${write.verb} was recorded.`;
    entry.confirmed = { action: write.action, result: write.done };
  });

  results.forEach((entry) => {
    if (entry.in_flight && !entry.message) entry.message = RELEASE_IN_FLIGHT_MESSAGE;
  });

  return { results: [...results.values()], request_plan: stats };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function historyRow(row) {
  return {
    id: row.id,
    operation_id: row.operation_id,
    action: row.action,
    network_id: row.network_id,
    network_name: row.network_name || "",
    content_owner_id: row.content_owner_id || "",
    claim_id: row.claim_id,
    video_id: row.video_id || "",
    video_url: videoUrl(row.video_id || ""),
    video_title: row.video_title || "",
    channel_title: row.channel_title || "",
    asset_id: row.asset_id || "",
    asset_title: row.asset_title || "",
    isrc: row.isrc || "",
    content_type: row.content_type || "",
    previous_status: row.previous_status || "",
    result: row.result,
    result_status: row.result_status || "",
    message: row.message || "",
    note: row.note || "",
    duration_ms: row.duration_ms ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name || "",
    created_by_email: row.created_by_email || "",
    created_at: row.created_at
  };
}

// created_at is SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC). A bound is either a UTC
// calendar day (YYYY-MM-DD; "to" covers the whole day) or an ISO-8601 UTC instant, which the page
// sends so that its local calendar days are honoured; an instant "to" is exclusive. The bound is
// rendered in the stored shape so the created_at index still applies.
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function sqlTimestamp(date) {
  // Beyond 9999 toISOString() switches to "+010000-…", which sorts before every stored value.
  if (date.getUTCFullYear() > 9999) return "9999-12-31 23:59:59";
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function historyBound(value, edge) {
  if (isDateOnly(value)) {
    if (edge === "from") return `${value} 00:00:00`;
    const next = new Date(`${value}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return sqlTimestamp(next);
  }
  const ms = INSTANT_PATTERN.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw badRequest(`${edge} must be a date in YYYY-MM-DD format or an ISO 8601 UTC instant`);
  // Whole seconds like the column: the start is floored, the (exclusive) end is ceiled.
  return sqlTimestamp(new Date(edge === "to" ? Math.ceil(ms / 1000) * 1000 : Math.floor(ms / 1000) * 1000));
}

function historyWhere({ user, filters }) {
  const clauses = [];
  const params = [];
  if (isLimitedUser(user)) {
    clauses.push("created_by = ?");
    params.push(Number(user?.id) || 0);
  }
  const networkId = Number(filters.network_id);
  if (networkId > 0) {
    clauses.push("network_id = ?");
    params.push(networkId);
  }
  const result = lower(filters.result);
  if (result) {
    if (!RESULTS.includes(result)) throw badRequest(`Unknown result "${result}"`);
    clauses.push("result = ?");
    params.push(result);
  }
  const userId = Number(filters.user_id);
  if (userId > 0) {
    clauses.push("created_by = ?");
    params.push(userId);
  }
  const from = cleanText(filters.from);
  if (from) {
    clauses.push("created_at >= ?");
    params.push(historyBound(from, "from"));
  }
  const to = cleanText(filters.to);
  if (to) {
    clauses.push("created_at < ?");
    params.push(historyBound(to, "to"));
  }
  const search = cleanText(filters.search);
  if (search) {
    const like = `%${search}%`;
    clauses.push("(claim_id LIKE ? OR video_id LIKE ? OR asset_id LIKE ? OR video_title LIKE ? OR asset_title LIKE ? OR isrc LIKE ? OR note LIKE ? OR message LIKE ? OR operation_id LIKE ?)");
    params.push(like, like, like, like, like, like, like, like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

// response_json (up to 20 KB per row) is never returned, so it is never read.
const MAX_HISTORY_PAGE = 1000000;

// Query-string numbers: fractions are truncated, anything that is not a finite number falls back,
// and the result is clamped so SQLite never receives a REAL or an int64 overflow for LIMIT / OFFSET.
function wholeNumber(value, fallback, min, max) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number || fallback, min), max);
}

function listHistory({ user, filters = {}, page = 1, pageSize = 50 }) {
  const { where, params } = historyWhere({ user, filters });
  const size = wholeNumber(pageSize, 50, 1, 200);
  const current = wholeNumber(page, 1, 1, MAX_HISTORY_PAGE);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM content_id_claim_events ${where}`).get(...params).n;
  const rows = db.prepare(`
    SELECT ${HISTORY_COLUMNS} FROM content_id_claim_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, size, (current - 1) * size);
  const summary = Object.fromEntries(RESULTS.map((result) => [result, 0]));
  db.prepare(`SELECT result, COUNT(*) AS n FROM content_id_claim_events ${where} GROUP BY result`).all(...params)
    .forEach((row) => { if (Object.hasOwn(summary, row.result)) summary[row.result] = row.n; });
  const scope = isLimitedUser(user) ? "WHERE created_by = ?" : "";
  const scopeParams = isLimitedUser(user) ? [Number(user?.id) || 0] : [];
  const users = db.prepare(`
    SELECT created_by AS id, MAX(created_by_name) AS name FROM content_id_claim_events ${scope}
    GROUP BY created_by HAVING created_by IS NOT NULL ORDER BY name COLLATE NOCASE
  `).all(...scopeParams);
  const networks = db.prepare(`
    SELECT network_id AS id, MAX(network_name) AS name FROM content_id_claim_events ${scope}
    GROUP BY network_id ORDER BY name COLLATE NOCASE
  `).all(...scopeParams);
  return { events: rows.map(historyRow), page: current, page_size: size, total, summary, users, networks };
}

// "YYYY-MM-DD HH:MM:SS" from SQLite is UTC; the export says so explicitly.
function csvUtcTime(value) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

// A silently cut export would look complete; the user narrows the filters instead.
function exportHistoryCsv({ user, filters = {} }) {
  const { where, params } = historyWhere({ user, filters });
  const total = db.prepare(`SELECT COUNT(*) AS n FROM content_id_claim_events ${where}`).get(...params).n;
  if (total > MAX_EXPORT_ROWS) throw badRequest(`Export matches ${total} rows; narrow the filters (maximum ${MAX_EXPORT_ROWS.toLocaleString("en-US")}).`);
  const rows = db.prepare(`SELECT ${HISTORY_COLUMNS} FROM content_id_claim_events ${where} ORDER BY id DESC LIMIT ?`).all(...params, MAX_EXPORT_ROWS).map(historyRow);
  const header = ["time_utc", "user", "cms", "content_owner_id", "action", "claim_id", "video_id", "video_title", "channel_title", "asset_id", "asset_title", "isrc", "content_type", "previous_status", "result", "result_status", "message", "note", "operation_id"];
  const lines = [header.join(",")];
  rows.forEach((row) => {
    lines.push([
      csvUtcTime(row.created_at), row.created_by_name || row.created_by_email, row.network_name, row.content_owner_id, row.action, row.claim_id, row.video_id, row.video_title,
      row.channel_title, row.asset_id, row.asset_title, row.isrc, row.content_type, row.previous_status, row.result, row.result_status, row.message, row.note, row.operation_id
    ].map(csvCell).join(","));
  });
  return `﻿${lines.join("\r\n")}\r\n`;
}

module.exports = {
  LIMITS,
  CLAIM_STATUSES,
  CONTENT_TYPES,
  ORIGINS,
  SORTS,
  RESULTS,
  _setReleaseBudgetMs,
  clearAssetCache,
  confirmClaims,
  describeUser,
  exportHistoryCsv,
  extractVideoId,
  getClaimDetail,
  isLimitedUser,
  listClaimAccounts,
  listHistory,
  normalizeClaim,
  normalizeMatchInfo,
  parseFilters,
  parseIdList,
  parseVideoInputs,
  recheckClaims,
  reinstateClaims,
  releaseClaims,
  searchClaims
};
