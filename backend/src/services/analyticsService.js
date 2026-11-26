const crypto = require("crypto");
const path = require("path");
const axios = require("axios");
const db = require("../config/analyticsDatabase");
const { REPORT_CATALOG, MONETARY_METRICS, METRICS, DIMENSIONS } = require("./analyticsCatalog");
const scheduleService = require("./analyticsScheduleService");
const warehouse = require("./analyticsWarehouse");

const ANALYTICS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
const DATA_URL = "https://www.googleapis.com/youtube/v3";
const DAY = 86400000;
const V2_KINDS = new Set(["daily", "full", "channelDetail"]);
const SCOPES = ["claimed", "self", "thirdParty"];
const CHANNEL_ID = /^UC[\w-]{22}$/;
const MAX_CHANNEL_IDS = 200;
const QUEUED_JOBS_PER_OWNER = 2;
const RECOVERY_WINDOW_MS = 24 * 3600000;
const MAX_RECOVERY_ATTEMPTS = 2;
const LATE_AFTER_MS = 15 * 60000;
const LEASE_KEY = "worker:lease";
const LEASE_STALE_MS = 90000;
const MONETARY_SCOPE = /\/yt-analytics-monetary\.readonly$/;
const RUN_STATUSES = new Set(["completed", "partial", "failed", "running", "queued", "cancelled", "interrupted"]);
const FAILED_OUTCOMES = new Set(["failed", "interrupted", "cancelled"]);
const MONETARY_REPORT_IDS = new Set(REPORT_CATALOG.filter((report) => report.monetary).map((report) => report.id));
const controllers = new Map();
const alertsInFlight = new Set();
let workerBusy = false;
let timer;
let engineInstance;
let leaseHeld = false;
let leaseBlockedBy = null;

function errorWithStatus(message, status = 400, reason) {
  const error = new Error(message); error.status = status; error.reason = reason; return error;
}
function safeError(error) {
  const payload = error?.response?.data?.error;
  const reason = error?.reason || payload?.errors?.[0]?.reason || payload?.status || error?.code || "requestFailed";
  const raw = error?.safeMessage || payload?.message || error?.googleMessage || error?.message || "Google request failed";
  const message = String(raw).replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/ya29\.[\w.-]+/g, "[redacted]").replace(/1\/\/\S+/g, "[redacted]").slice(0, 1200);
  return { message, reason, status: Number(error?.status || error?.response?.status) || 502,
    retryable: [429, 500, 502, 503, 504].includes(Number(error?.status || error?.response?.status)) || !!error?.tokenRefreshTransient };
}
function nowIso(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw errorWithStatus("A valid instant is required.");
  return date.toISOString();
}
function parseJson(text, fallback) { try { const value = JSON.parse(text); return value ?? fallback; } catch { return fallback; } }
// The engine is required lazily: it must not load while this module's exports are still being assigned (CommonJS cycle).
function engineModule() { return require("./analyticsSyncEngine"); }
function engine() {
  if (!engineInstance) engineInstance = engineModule().createSyncEngine({ db, core: module.exports, warehouse });
  return engineInstance;
}
function scopeList(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* space-delimited OAuth scopes */ }
  return String(value || "").split(/[\s,]+/).filter(Boolean);
}
// This is deliberately the only bridge into Report persistence. No Report channel/revenue tables are read.
function credentialDb() { return require("../config/database"); }
// authError is the stored OAuth failure reason (e.g. invalid_grant); tokens never leave the credential database.
function listOwners() {
  return credentialDb().prepare("SELECT id, name, network_code, cms_auth_status, cms_auth_scopes, cms_auth_error FROM networks WHERE TRIM(COALESCE(network_code,'')) <> '' ORDER BY name").all().map((row) => {
    const scopes = scopeList(row.cms_auth_scopes);
    return { id: row.id, ownerId: row.network_code, name: row.name, authStatus: row.cms_auth_status, authError: row.cms_auth_error ? String(row.cms_auth_error).slice(0, 400) : null, scopes,
      hasAnalyticsScope: scopes.some((scope) => /\/yt-analytics(?:-monetary)?\.readonly$/.test(scope)),
      hasMonetaryScope: scopes.some((scope) => MONETARY_SCOPE.test(scope)) };
  });
}
// Whether the owner's CMS OAuth grant includes yt-analytics-monetary.readonly (same rule as listOwners().hasMonetaryScope).
function ownerHasMonetaryScope(network) { return scopeList(network?.cms_auth_scopes).some((scope) => MONETARY_SCOPE.test(scope)); }
function resolveOwner(ownerId, { requireConnected = true } = {}) {
  const value = String(ownerId || "").trim();
  if (!value || value.length > 160) throw errorWithStatus("Content Owner is required.");
  const network = credentialDb().prepare("SELECT * FROM networks WHERE network_code = ? OR CAST(id AS TEXT) = ? ORDER BY CASE WHEN network_code = ? THEN 0 ELSE 1 END LIMIT 1").get(value, value, value);
  if (!network) throw errorWithStatus("Content Owner is not configured.", 404);
  if (requireConnected && network.cms_auth_status !== "connected") throw errorWithStatus("CMS OAuth is not connected for this Content Owner.", 409, "cmsNotConnected");
  if (requireConnected && !network.cms_access_token && !network.cms_refresh_token) throw errorWithStatus("CMS credentials are missing.", 409, "missingCredentials");
  if (!/^[\w-]{1,160}$/.test(network.network_code || "")) throw errorWithStatus("Invalid Content Owner identifier.");
  return network;
}
async function googleGet(url, { params = {}, owner, signal } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["youtubeanalytics.googleapis.com", "www.googleapis.com", "youtubereporting.googleapis.com"].includes(parsed.hostname)) {
    throw errorWithStatus("Google endpoint is not allowed.");
  }
  const bridge = require("./googleContentIdService");
  let accessToken;
  let rejectedAccessToken;
  // Up to three attempts for transient errors; one token refresh per call on ANY 401, tracked separately from the attempts.
  for (let attempt = 0; attempt < 3;) {
    if (signal?.aborted) throw errorWithStatus("Cancelled", 499, "cancelled");
    try {
      if (!accessToken) accessToken = await bridge.getAccessToken(owner, { rejectedAccessToken });
      const response = await axios.get(url, { params, timeout: 35000, signal,
        headers: { Authorization: `Bearer ${accessToken}` }, maxContentLength: 64 * 1024 * 1024, maxRedirects: 0 });
      return response.data;
    } catch (error) {
      if (signal?.aborted || error.code === "ERR_CANCELED") throw errorWithStatus("Cancelled", 499, "cancelled");
      const status = Number(error.response?.status || error.status);
      const reason = error.response?.data?.error?.errors?.[0]?.reason;
      if (status === 401 && accessToken && rejectedAccessToken === undefined) {
        rejectedAccessToken = accessToken;
        accessToken = null;
        continue;
      }
      const transient = !status || [429, 500, 502, 503, 504].includes(status) || ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason);
      if (!transient || attempt === 2) { const safe = safeError(error); throw errorWithStatus(safe.message, safe.status, safe.reason); }
      const retryAfter = Math.min(5000, Math.max(0, Number(error.response?.headers?.["retry-after"]) * 1000 || 500 * 2 ** attempt));
      attempt += 1;
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(wait); reject(errorWithStatus("Cancelled", 499, "cancelled")); };
        const wait = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, retryAfter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
function dateString(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) throw errorWithStatus(`${field} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw errorWithStatus(`${field} is not a valid date.`);
  return value;
}
function defaultDates() {
  const end = new Date(Date.now() - 3 * DAY); const start = new Date(end.getTime() - 27 * DAY);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}
function normalizeSelection(input = {}, owner) {
  const defaults = defaultDates();
  const startDate = dateString(input.startDate || defaults.startDate, "startDate");
  const endDate = dateString(input.endDate || defaults.endDate, "endDate");
  const days = (Date.parse(endDate) - Date.parse(startDate)) / DAY + 1;
  if (days < 1 || days > 366) throw errorWithStatus("Date range must contain between 1 and 366 days.");
  if (startDate < "2009-01-01" || endDate > new Date().toISOString().slice(0, 10)) throw errorWithStatus("Dates must be between 2009-01-01 and today.");
  const scope = input.scope || "claimed";
  if (!SCOPES.includes(scope)) throw errorWithStatus("scope must be claimed, self, or thirdParty.");
  const channelId = String(input.channelId || "").trim();
  const videoId = String(input.videoId || "").trim();
  if (channelId && !CHANNEL_ID.test(channelId)) throw errorWithStatus("Invalid YouTube channel ID.");
  if (videoId && !/^[\w-]{11}$/.test(videoId)) throw errorWithStatus("Invalid YouTube video ID.");
  if (channelId && videoId) throw errorWithStatus("Choose either a channel filter or a video filter.");
  const currency = String(input.currency || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw errorWithStatus("currency must be a three-letter currency code.");
  const country = String(input.country || "").trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw errorWithStatus("country must use a two-letter ISO country code.");
  return { ownerId: String(owner?.network_code || input.ownerId || ""), startDate, endDate, scope, channelId, videoId, currency,
    includeHistoricalChannelData: input.includeHistoricalChannelData === true || input.includeHistoricalChannelData === "true", ...(country ? { country } : {}) };
}
function previousSelection(selection) {
  const days = (Date.parse(selection.endDate) - Date.parse(selection.startDate)) / DAY + 1;
  return { ...selection, startDate: new Date(Date.parse(selection.startDate) - days * DAY).toISOString().slice(0, 10),
    endDate: new Date(Date.parse(selection.startDate) - DAY).toISOString().slice(0, 10) };
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function snapshotKey(selection, reportId) { return hash({ selection, reportId }); }
function publicCatalog(canMonetary = true) { return REPORT_CATALOG.filter((r) => canMonetary || !r.monetary).map((r) => ({ ...r })); }
function baseFilters(selection) {
  if (selection.videoId) return `video==${selection.videoId}`;
  if (selection.channelId) return `channel==${selection.channelId}`;
  if (selection.scope === "self") return "uploaderType==self";
  if (selection.scope === "thirdParty") return "claimedStatus==claimed;uploaderType==thirdParty";
  return "claimedStatus==claimed";
}
function queryParams(selection, report) {
  if (report.requiresVideo && !selection.videoId) throw errorWithStatus("Select a video to retrieve audience retention.");
  if (report.requiresVideo && selection.country) throw errorWithStatus("Audience retention does not support a country filter. Clear the country selection.");
  if (report.id === "adTypes" && selection.channelId) throw errorWithStatus("Ad-type reports do not support a channel filter. Select the Content Owner or a video.");
  if (["videos", "videoRevenue"].includes(report.id) && selection.videoId) throw errorWithStatus("Top-video reports require an owner or channel selection.");
  return { ids: `contentOwner==${selection.ownerId}`, startDate: selection.startDate, endDate: selection.endDate,
    metrics: report.metrics, ...(report.dimensions ? { dimensions: report.dimensions } : {}),
    // The geographic report table does not support country as a filter; filter its returned country rows below.
    filters: [baseFilters(selection), report.extraFilters,
      selection.country && !["countries", "countryRevenue"].includes(report.id) ? `country==${selection.country}` : null].filter(Boolean).join(";"),
    ...(report.sort ? { sort: report.sort } : {}), currency: selection.currency,
    includeHistoricalChannelData: selection.includeHistoricalChannelData, maxResults: report.limit || 200 };
}
async function fetchTable(params, report, owner, signal) {
  const rows = []; let columnHeaders = []; let startIndex = 1; const pageSize = params.maxResults || 200;
  const maxRows = report.limit || 100000;
  for (;;) {
    const result = await googleGet(ANALYTICS_URL, { params: { ...params, startIndex }, owner, signal });
    if (!Array.isArray(result.columnHeaders)) throw errorWithStatus("Google returned an invalid report table.", 502);
    if (!columnHeaders.length) columnHeaders = result.columnHeaders;
    else if (JSON.stringify(columnHeaders) !== JSON.stringify(result.columnHeaders)) throw errorWithStatus("Report columns changed during pagination; previous snapshot was retained.", 502);
    const page = result.rows || [];
    if (!Array.isArray(page) || page.some((row) => !Array.isArray(row) || row.length !== columnHeaders.length)) throw errorWithStatus("Google returned invalid report rows.", 502);
    rows.push(...page.map((row) => Object.fromEntries(columnHeaders.map((header, i) => [header.name, row[i]]))));
    if (report.limit || page.length < pageSize) break;
    if (rows.length >= maxRows) throw errorWithStatus("Report exceeds the 100,000-row interactive limit. Use Bulk reports or a shorter date range. Previous complete snapshot retained.", 422, "interactiveRowLimit");
    startIndex += page.length;
  }
  const dayValues = rows.map((row) => row.day).filter(Boolean).sort();
  return { columnHeaders, rows, coverage: { rowCount: rows.length, limited: !!report.limit, limit: report.limit || null,
    requestedStartDate: params.startDate, requestedEndDate: params.endDate,
    availableStartDate: dayValues[0] || null, availableEndDate: dayValues.at(-1) || null,
    latestDaysMayBeDelayed: true, source: "YouTube Analytics API v2", currency: params.currency } };
}
function persistReport(selection, report, params, table) {
  const key = snapshotKey(selection, report.id);
  db.transaction(() => {
    db.prepare(`INSERT INTO analytic_snapshots (snapshot_key,owner_id,report_id,start_date,end_date,selection_json,query_json,headers_json,rows_json,coverage_json,monetary,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(snapshot_key) DO UPDATE SET query_json=excluded.query_json,headers_json=excluded.headers_json,
      rows_json=excluded.rows_json,coverage_json=excluded.coverage_json,monetary=excluded.monetary,updated_at=excluded.updated_at`)
      .run(key, selection.ownerId, report.id, selection.startDate, selection.endDate, JSON.stringify(selection), JSON.stringify(params),
        JSON.stringify(table.columnHeaders), JSON.stringify(table.rows), JSON.stringify(table.coverage), report.monetary ? 1 : 0, nowIso());
    db.prepare(`INSERT INTO analytic_attempts(snapshot_key,owner_id,report_id,status,error_json,attempted_at) VALUES(?,?,?,'success',NULL,?)
      ON CONFLICT(snapshot_key) DO UPDATE SET status='success',error_json=NULL,attempted_at=excluded.attempted_at`).run(key, selection.ownerId, report.id, nowIso());
  })();
  return readReport(selection, report);
}
function recordFailure(selection, report, error) {
  const detail = safeError(error);
  db.prepare(`INSERT INTO analytic_attempts(snapshot_key,owner_id,report_id,status,error_json,attempted_at) VALUES(?,?,?,'error',?,?)
    ON CONFLICT(snapshot_key) DO UPDATE SET status='error',error_json=excluded.error_json,attempted_at=excluded.attempted_at`)
    .run(snapshotKey(selection, report.id), selection.ownerId, report.id, JSON.stringify(detail), nowIso());
  return detail;
}
function readReport(selection, report) {
  const key = snapshotKey(selection, report.id);
  const stored = db.prepare("SELECT * FROM analytic_snapshots WHERE snapshot_key = ?").get(key);
  const attempt = db.prepare("SELECT * FROM analytic_attempts WHERE snapshot_key = ?").get(key);
  const failure = attempt?.status === "error" ? JSON.parse(attempt.error_json || "null") : null;
  const rows = stored ? JSON.parse(stored.rows_json) : [];
  return { id: report.id, status: stored ? (failure ? "stale" : rows.length ? "ready" : "empty") : failure ? "error" : "missing",
    rows, columnHeaders: stored ? JSON.parse(stored.headers_json) : [], updatedAt: stored?.updated_at || null,
    error: failure?.message || null, errorDetails: failure, attemptedAt: attempt?.attempted_at || null,
    coverage: stored ? JSON.parse(stored.coverage_json) : { rowCount: 0, limited: !!report.limit, limit: report.limit || null },
    query: stored ? JSON.parse(stored.query_json) : null };
}
// Data API inventory: upsert + `removed_at` for channels that left the CMS (never deleted), shared with the sync engine.
async function syncChannels(owner, signal) {
  return (await engineModule().fetchInventory({ db, get: googleGet, owner, now: new Date(), signal })).count;
}
async function syncVideoMetadata(owner, ids, signal) {
  const unique = [...new Set(ids)].filter((id) => /^[\w-]{11}$/.test(id));
  for (let offset = 0; offset < unique.length; offset += 50) {
    const result = await googleGet(`${DATA_URL}/videos`, { params: { part: "snippet,contentDetails,statistics", id: unique.slice(offset, offset + 50).join(","),
      onBehalfOfContentOwner: owner.network_code }, owner, signal });
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO analytic_videos(owner_id,video_id,channel_id,title,thumbnail,duration,published_at,metadata_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_id,video_id) DO UPDATE SET channel_id=excluded.channel_id,title=excluded.title,thumbnail=excluded.thumbnail,duration=excluded.duration,
        published_at=excluded.published_at,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`);
      for (const item of result.items || []) insert.run(owner.network_code, item.id, item.snippet?.channelId || null, item.snippet?.title || item.id,
        item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null, item.contentDetails?.duration || null,
        item.snippet?.publishedAt || null, JSON.stringify(item), nowIso());
    })();
  }
}
async function executeReport(selection, report, owner, signal) {
  try {
    if (report.managedChannels) {
      if (selection.videoId || selection.scope === "thirdParty") throw errorWithStatus("Managed-channel reports cover CMS-owned channels. Choose the owner or a channel; use Bulk reports for third-party content.");
      const ids = selection.channelId ? [selection.channelId] : db.prepare("SELECT channel_id FROM analytic_channels WHERE owner_id = ? ORDER BY channel_id").all(selection.ownerId).map((r) => r.channel_id);
      const combined = { rows: [], columnHeaders: [], coverage: { rowCount: 0, limited: false, limit: null,
        scope: "managedChannels", requestedStartDate: selection.startDate, requestedEndDate: selection.endDate,
        source: "YouTube Analytics API v2", currency: selection.currency, managedChannelCount: ids.length } };
      const params = queryParams(selection, report);
      for (let offset = 0; offset < ids.length; offset += 500) {
        const table = await fetchTable({ ...params, filters: [`channel==${ids.slice(offset, offset + 500).join(",")}`,
          selection.country ? `country==${selection.country}` : null].filter(Boolean).join(";") }, report, owner, signal);
        combined.columnHeaders = table.columnHeaders; combined.rows.push(...table.rows);
      }
      combined.coverage.rowCount = combined.rows.length;
      return persistReport(selection, report, { ...params, filters: "channel==[managed channel inventory]" }, combined);
    }
    const params = queryParams(selection, report);
    const table = await fetchTable(params, report, owner, signal);
    if (selection.country && ["countries", "countryRevenue"].includes(report.id)) {
      table.rows = table.rows.filter((row) => row.country === selection.country);
      table.coverage = { ...table.coverage, rowCount: table.rows.length, country: selection.country, countryFilteredLocally: true };
    }
    return persistReport(selection, report, params, table);
  } catch (error) {
    if (error.reason !== "cancelled") recordFailure(selection, report, error);
    throw error;
  }
}

// ---- jobs -------------------------------------------------------------------------------------
function isMonetaryReportId(id) { return MONETARY_REPORT_IDS.has(String(id || "").replace(/^previous:/, "")); }
function jobIsMonetary(request = {}) {
  return request.kind ? !!request.monetary : (Array.isArray(request.reportIds) ? request.reportIds : []).some(isMonetaryReportId);
}
function jobRow(id) {
  const row = db.prepare("SELECT * FROM analytic_jobs WHERE id = ?").get(String(id));
  if (!row) throw errorWithStatus("Sync job not found.", 404);
  return row;
}
function publicPlan(plan) {
  if (!plan) return null;
  const { channelIds: _ids, ...rest } = plan;
  return rest;
}
// Job objects are sanitised per role: without monetary access, monetary steps, errors and the current step name are dropped.
function jobFromRow(row, access = {}) {
  const canMonetary = !!access.canMonetary;
  const request = parseJson(row.request_json, {});
  const result = parseJson(row.result_json, null);
  const kind = row.kind || request.kind || "snapshot";
  const monetary = jobIsMonetary(request);
  const monetaryStep = (id) => !!id && (isMonetaryReportId(id) || (result?.steps || []).some((step) => step.id === id && step.monetary));
  const steps = (result?.steps || []).filter((step) => canMonetary || !step.monetary);
  const errors = parseJson(row.errors_json, []).filter((error) => canMonetary || (!error.monetary && !isMonetaryReportId(error.reportId)));
  const visibleResult = result && !canMonetary && Array.isArray(result.steps) ? { ...result, steps } : result;
  const plan = result?.plan ? publicPlan(result.plan) : null;
  const range = kind === "snapshot" ? request.selection || null : plan || request;
  return { id: row.id, ownerId: row.owner_id, kind, mode: row.mode || request.mode || (["daily", "channelDetail"].includes(kind) ? "append" : null), requestedBy: request.requestedBy || "user", status: row.status,
    completed: row.completed, total: row.total, progress: row.total ? Math.min(100, Math.round(100 * row.completed / row.total)) : 0,
    currentReport: !canMonetary && monetaryStep(row.current_report) ? null : row.current_report, errors, result: visibleResult, plan, counts: result?.counts || null, steps,
    notes: Array.isArray(result?.notes) ? result.notes : [], selection: request.selection ?? null, startDate: range?.startDate || null, endDate: range?.endDate || null,
    channelId: request.channelId || null, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, createdBy: row.created_by ?? null,
    cancelRequested: !!row.cancel_requested, monetary, canCancel: canMonetary || !monetary };
}
function getJob(id, access = {}) { return jobFromRow(jobRow(id), access); }
function listJobs(ownerId, access = {}, limit = 20) {
  const rows = ownerId ? db.prepare("SELECT * FROM analytic_jobs WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(ownerId, limit)
    : db.prepare("SELECT * FROM analytic_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
  return rows.map((row) => jobFromRow(row, access));
}
// A queued v2 job already carries its creation-time plan (the engine replaces it with the run-time plan when it starts).
function insertJob({ request, ownerId, owner, createdBy, total, notes = [], plan = null }) {
  const id = crypto.randomUUID(); const at = nowIso();
  if (owner) {
    db.prepare("INSERT INTO analytic_owners(owner_id,name,credential_network_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET name=excluded.name,credential_network_id=excluded.credential_network_id,updated_at=excluded.updated_at")
      .run(ownerId, owner.name, owner.id, at);
  }
  const result = notes.length || plan ? { ...(notes.length ? { notes } : {}), ...(plan ? { plan } : {}) } : null;
  db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,created_by,created_at,updated_at,kind,mode,result_json) VALUES(?,?,?,'queued',?,?,?,?,?,?,?)")
    .run(id, ownerId, JSON.stringify(request), Math.max(1, Number(total) || 1), createdBy ?? null, at, at, request.kind || "snapshot", request.mode || (["daily", "channelDetail"].includes(request.kind) ? "append" : null), result ? JSON.stringify(result) : null);
  return id;
}
// A started worker without the single-writer lease leaves queued jobs to the lease holder's next tick (<= 30 s).
function scheduleQueue() { if (timer && !leaseHeld) return; setImmediate(() => drainQueue().catch(() => {})); }
function createSnapshotSync(input, { userId = null, canMonetary = false } = {}) {
  const owner = resolveOwner(input.ownerId); const selection = normalizeSelection(input, owner);
  const supplied = input.reportIds;
  if (supplied != null && (!Array.isArray(supplied) || !supplied.length || supplied.length > REPORT_CATALOG.length)) throw errorWithStatus("reportIds must be a nonempty list of catalog report IDs.");
  const reports = supplied || REPORT_CATALOG.filter((r) => r.default && (!r.requiresVideo || selection.videoId) && (!r.monetary || canMonetary)
    && (!r.managedChannels || (!selection.videoId && selection.scope !== "thirdParty"))
    && (!selection.videoId || !["videos", "videoRevenue"].includes(r.id)) && (!selection.channelId || r.id !== "adTypes")).map((r) => r.id);
  for (const id of reports) {
    const report = REPORT_CATALOG.find((r) => r.id === id);
    if (!report) throw errorWithStatus(`Unknown report: ${String(id).slice(0, 80)}`);
    if (report.monetary && !canMonetary) throw errorWithStatus("Your role cannot access Analytics revenue.", 403);
    if (report.requiresVideo && !selection.videoId) throw errorWithStatus("Retention reports require a video ID.");
  }
  const unique = [...new Set(reports)];
  const compare = input.compare !== false;
  if (compare && previousSelection(selection).startDate < "2009-01-01") throw errorWithStatus("Previous comparison period is before Analytics data availability. Disable comparison for this range.");
  const request = { selection, reportIds: unique.sort(), compare, canMonetary };
  const duplicate = db.prepare("SELECT id,request_json FROM analytic_jobs WHERE owner_id = ? AND status IN ('queued','running')").all(selection.ownerId)
    .find((job) => JSON.stringify(JSON.parse(job.request_json)) === JSON.stringify(request));
  if (duplicate) return getJob(duplicate.id, { canMonetary });
  const total = 2 + unique.length + (compare ? unique.filter((rid) => ["overview", "monetaryOverview", "daily", "monetaryDaily"].includes(rid)).length : 0);
  const id = db.transaction(() => insertJob({ request, ownerId: selection.ownerId, owner, createdBy: userId, total }))();
  scheduleQueue();
  return getJob(id, { canMonetary });
}
function toBoolean(value, fallback) {
  if (value === true || value === "true" || value === 1) return true;
  if (value === false || value === "false" || value === 0) return false;
  return fallback;
}
function validateScopes(value) {
  const scopes = value == null ? ["claimed"] : Array.isArray(value) ? value : typeof value === "string" ? value.split(",").filter(Boolean) : null;
  if (!scopes || !scopes.length || scopes.some((scope) => !SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length) {
    throw errorWithStatus("scopes must list claimed, self or thirdParty without duplicates.");
  }
  return scopes;
}
function validateChannelIds(ownerId, value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : value == null ? [] : null;
  if (!list) throw errorWithStatus("channelIds must be a list of YouTube channel IDs.");
  const ids = [...new Set(list.map((id) => String(id || "").trim()).filter(Boolean))].sort();
  if (ids.length > MAX_CHANNEL_IDS) throw errorWithStatus(`At most ${MAX_CHANNEL_IDS} channels can be selected.`);
  if (ids.some((id) => !CHANNEL_ID.test(id))) throw errorWithStatus("Invalid YouTube channel ID.");
  if (ids.length) {
    const known = new Set(db.prepare(`SELECT channel_id FROM analytic_channels WHERE owner_id=? AND channel_id IN (${ids.map(() => "?").join(",")})`).all(ownerId, ...ids).map((row) => row.channel_id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw errorWithStatus(`Unknown channel IDs for this Content Owner: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? ` and ${unknown.length - 10} more` : ""}.`);
  }
  return ids;
}
function validateRange(input, now = new Date()) {
  const startDate = dateString(input.startDate, "startDate"); const endDate = dateString(input.endDate, "endDate");
  if (startDate < "2009-01-01") throw errorWithStatus("startDate must be 2009-01-01 or later.");
  const latest = engineModule().latestAllowedDay(now);
  if (endDate > latest) throw errorWithStatus(`endDate must not be after ${latest}, the last completed Pacific-time day.`);
  const days = (Date.parse(endDate) - Date.parse(startDate)) / DAY + 1;
  if (days < 1 || days > 366) throw errorWithStatus("Date range must contain between 1 and 366 days.");
  return { startDate, endDate };
}
function requireMonetary(value, canMonetary) {
  const monetary = toBoolean(value, false);
  if (monetary && !canMonetary) throw errorWithStatus("Your role cannot access Analytics revenue.", 403);
  return monetary;
}
// Canonical v2 request: primitives only, fixed key order; `requestedBy` is excluded from de-duplication.
function buildRequest(input, access, owner) {
  const kind = input.kind;
  if (!V2_KINDS.has(kind)) throw errorWithStatus("kind must be daily, full, channelDetail or snapshot.");
  const ownerId = owner.network_code; const canMonetary = !!access.canMonetary;
  const requestedBy = ["schedule", "recovery"].includes(access.requestedBy) ? access.requestedBy : "user";
  const notes = [];
  if (kind === "daily") {
    const schedule = db.prepare("SELECT monetary FROM analytic_schedules WHERE owner_id=?").get(ownerId);
    const wanted = schedule ? !!schedule.monetary : canMonetary;
    const scoped = ownerHasMonetaryScope(owner);
    if (wanted && !canMonetary) notes.push("Revenue was not requested: the user who started this run cannot access Analytics revenue.");
    // A token without the monetary scope would turn the revenue request into a fatal 403; run the basic job instead.
    else if (wanted && !scoped) notes.push("Revenue was not requested: the CMS token has no revenue scope.");
    return { request: { kind, ownerId, monetary: wanted && canMonetary && scoped, canMonetary, requestedBy }, notes };
  }
  const { startDate, endDate } = validateRange(input);
  const monetary = requireMonetary(input.monetary, canMonetary);
  if (kind === "channelDetail") {
    const channelId = String(input.channelId || "").trim();
    if (!CHANNEL_ID.test(channelId)) throw errorWithStatus("Invalid YouTube channel ID.");
    if (!db.prepare("SELECT 1 FROM analytic_channels WHERE owner_id=? AND channel_id=?").get(ownerId, channelId)) {
      throw errorWithStatus("Channel is not in this Content Owner's managed inventory. Refresh the channel inventory first.", 404);
    }
    return { request: { kind, ownerId, channelId, startDate, endDate, monetary, canMonetary, requestedBy }, notes };
  }
  const mode = input.mode;
  if (!["append", "overwrite"].includes(mode)) throw errorWithStatus("mode must be append or overwrite.");
  if (mode === "overwrite" && !(access.canOverwrite ?? canMonetary)) throw errorWithStatus("Your role cannot overwrite stored numbers.", 403);
  const scopes = validateScopes(input.scopes ?? (input.scope ? [input.scope] : undefined));
  const channelMode = input.channelMode ?? "all";
  if (!["all", "selected", "none"].includes(channelMode)) throw errorWithStatus("channelMode must be all, selected or none.");
  const channelIds = channelMode === "selected" ? validateChannelIds(ownerId, input.channelIds) : [];
  if (channelMode === "selected" && !channelIds.length) throw errorWithStatus("Select at least one channel or track all channels.");
  return { request: { kind, mode, ownerId, startDate, endDate, scopes, channelMode, channelIds, includeBreakdowns: toBoolean(input.includeBreakdowns, true),
    includeSnapshots: toBoolean(input.includeSnapshots, true), monetary, canMonetary, requestedBy }, notes };
}
// De-duplication key: `requestedBy`, the caller's `canMonetary` (the `monetary` flag already says what is fetched) and the
// recovery bookkeeping are excluded, so the same work requested by two roles or after a restart is queued once.
const NON_CANONICAL_KEYS = new Set(["requestedBy", "canMonetary", "recovery"]);
function canonicalRequest(request) {
  return JSON.stringify(Object.fromEntries(Object.entries(request || {}).filter(([key]) => !NON_CANONICAL_KEYS.has(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}
function scheduleRow(ownerId) { return db.prepare("SELECT * FROM analytic_schedules WHERE owner_id=?").get(ownerId) || null; }
// kind defaults to the legacy snapshot path; v2 kinds are validated, planned (400 over the request cap), de-duplicated
// against queued/running jobs and capped at two queued user jobs per owner. dryRun returns { plan } without enqueueing.
function createSync(input = {}, access = {}) {
  const kind = input.kind ?? "snapshot";
  if (kind === "snapshot") return createSnapshotSync(input, access);
  const owner = resolveOwner(input.ownerId);
  const { request, notes } = buildRequest(input, access, owner);
  const plan = engine().planJob(request, { schedule: kind === "daily" ? scheduleRow(owner.network_code) : null, now: new Date() });
  if (plan.overCap) {
    const error = errorWithStatus(`This sync needs about ${plan.requests.estimate} requests; the limit is ${plan.cap}. Shorten the range or select fewer channels.`, 400, "tooManyRequests");
    error.plan = publicPlan(plan);
    throw error;
  }
  if (input.dryRun === true) return { plan: publicPlan(plan), dryRun: true };
  const canonical = canonicalRequest(request);
  const id = db.transaction(() => {
    const active = db.prepare("SELECT id,status,request_json FROM analytic_jobs WHERE owner_id=? AND status IN ('queued','running')").all(owner.network_code);
    const duplicate = active.find((job) => canonicalRequest(parseJson(job.request_json, {})) === canonical);
    if (duplicate) return { duplicate: duplicate.id };
    if (request.requestedBy === "user" && active.filter((job) => job.status === "queued").length >= QUEUED_JOBS_PER_OWNER) {
      throw errorWithStatus("Too many sync jobs are waiting for this Content Owner. Wait for the queued jobs to finish.", 409, "tooManyJobs");
    }
    return { id: insertJob({ request, ownerId: owner.network_code, owner, createdBy: access.userId ?? null, total: plan.requests.estimate, notes, plan: publicPlan(plan) }) };
  })();
  if (id.duplicate) return { ...getJob(id.duplicate, access), deduplicated: true };
  scheduleQueue();
  return getJob(id.id, access);
}
function planSync(input = {}, access = {}) { return createSync({ ...input, dryRun: true }, access).plan; }
async function runSnapshotJob(row) {
  const request = JSON.parse(row.request_json); const { selection } = request; const errors = [];
  if (!engine().claim(row.id)) return { claimed: false };
  const controller = new AbortController(); controllers.set(row.id, controller);
  let completed = 0; let successes = 0;
  const advance = (name) => {
    const cancelled = db.prepare("SELECT cancel_requested FROM analytic_jobs WHERE id=?").get(row.id)?.cancel_requested;
    if (cancelled || controller.signal.aborted) throw errorWithStatus("Cancelled", 499, "cancelled");
    db.prepare("UPDATE analytic_jobs SET current_report=?,completed=?,errors_json=?,updated_at=? WHERE id=?").run(name, completed, JSON.stringify(errors), nowIso(), row.id);
  };
  const task = async (name, callback) => {
    advance(name);
    let succeeded = false;
    try { await callback(); successes += 1; succeeded = true; }
    catch (error) { if (error.reason === "cancelled") throw error; errors.push({ reportId: name, ...safeError(error) }); }
    completed += 1;
    db.prepare("UPDATE analytic_jobs SET completed=?,errors_json=?,updated_at=? WHERE id=?").run(completed, JSON.stringify(errors), nowIso(), row.id);
    return succeeded;
  };
  try {
    const owner = resolveOwner(selection.ownerId);
    const channelInventoryReady = await task("channelMetadata", () => syncChannels(owner, controller.signal));
    for (const id of request.reportIds) {
      const report = REPORT_CATALOG.find((r) => r.id === id);
      await task(id, () => {
        if (report.managedChannels && !channelInventoryReady) {
          const error = errorWithStatus("The managed-channel inventory could not be refreshed. Previous channel report snapshot was retained; retry the sync.", 502, "channelInventoryUnavailable");
          recordFailure(selection, report, error);
          throw error;
        }
        return executeReport(selection, report, owner, controller.signal);
      });
    }
    if (request.compare) {
      for (const id of request.reportIds.filter((rid) => ["overview", "monetaryOverview", "daily", "monetaryDaily"].includes(rid))) {
        await task(`previous:${id}`, () => executeReport(previousSelection(selection), REPORT_CATALOG.find((r) => r.id === id), owner, controller.signal));
      }
    }
    const videoIds = request.reportIds.filter((id) => ["videos", "videoRevenue"].includes(id))
      .flatMap((id) => readReport(selection, REPORT_CATALOG.find((r) => r.id === id)).rows.map((video) => video.video));
    if (selection.videoId) videoIds.push(selection.videoId);
    await task("videoMetadata", () => syncVideoMetadata(owner, videoIds, controller.signal));
    advance(null);
    const status = !errors.length ? "completed" : successes ? "partial" : "failed";
    db.prepare("UPDATE analytic_jobs SET status=?,current_report=NULL,result_json=?,finished_at=?,updated_at=? WHERE id=?")
      .run(status, JSON.stringify({ reports: request.reportIds.length, successfulTasks: successes, failedTasks: errors.length }), nowIso(), nowIso(), row.id);
    return { claimed: true, status };
  } catch (error) {
    const cancelled = error.reason === "cancelled" || controller.signal.aborted;
    if (!cancelled) errors.push({ reportId: "job", ...safeError(error) });
    db.prepare("UPDATE analytic_jobs SET status=?,errors_json=?,current_report=NULL,finished_at=?,updated_at=? WHERE id=?")
      .run(cancelled ? "cancelled" : "failed", JSON.stringify(errors), nowIso(), nowIso(), row.id);
    return { claimed: true, status: cancelled ? "cancelled" : "failed" };
  } finally { controllers.delete(row.id); }
}
async function runJob(row) {
  const request = parseJson(row.request_json, {});
  if (!V2_KINDS.has(request.kind)) return runSnapshotJob(row);
  const controller = new AbortController(); controllers.set(row.id, controller);
  try { return await engine().runJob(row, { signal: controller.signal }); }
  catch (error) {
    // The engine records its own failures; this only covers a defect that escaped it, so the job never stays `running`.
    const detail = safeError(error); const at = nowIso();
    db.prepare("UPDATE analytic_jobs SET status='failed',current_report=NULL,errors_json=?,finished_at=?,updated_at=? WHERE id=? AND status='running'")
      .run(JSON.stringify([...parseJson(row.errors_json, []), { reportId: "job", message: detail.message, reason: detail.reason, status: detail.status }]), at, at, row.id);
    console.error("[Analytics worker]", detail.message);
    return { claimed: true, status: "failed" };
  } finally { controllers.delete(row.id); }
}
async function drainQueue() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    for (;;) {
      const next = db.prepare("SELECT * FROM analytic_jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();
      if (!next) break;
      await runJob(next);
    }
  } finally { workerBusy = false; }
}
function cancelJob(id, access = {}) {
  const row = jobRow(id);
  if (!access.canMonetary && jobIsMonetary(parseJson(row.request_json, {}))) throw errorWithStatus("Your role cannot cancel an Analytics revenue sync.", 403);
  if (["queued", "running"].includes(row.status)) {
    const at = nowIso();
    db.prepare("UPDATE analytic_jobs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN ? ELSE finished_at END,updated_at=? WHERE id=?").run(at, at, row.id);
    controllers.get(String(row.id))?.abort();
  }
  return getJob(row.id, access);
}
// Jobs left queued/running by a dead process are marked interrupted; v2 jobs that were not being cancelled are queued again
// (idempotent through coverage; overwrite re-runs are safe) while the ORIGINAL job is younger than 24 h and the chain has
// been interrupted at most MAX_RECOVERY_ATTEMPTS times: `request.recovery = { originalCreatedAt, attempts }` travels with
// every re-queued job so a crash loop ends. The daily slot's run row follows the replacement job. Legacy snapshot jobs are not re-queued.
function recoverInterruptedJobs(now = new Date()) {
  const at = nowIso(now);
  const result = { interrupted: 0, requeued: 0 };
  db.transaction(() => {
    const rows = db.prepare("SELECT * FROM analytic_jobs WHERE status IN ('queued','running') ORDER BY created_at,rowid").all();
    const interruptedIds = new Set(rows.map((row) => row.id));
    for (const row of rows) {
      const request = parseJson(row.request_json, {});
      const note = { reportId: "worker", message: "Server restarted before this sync finished. Start a new sync; complete snapshots were retained.", reason: "serverRestart" };
      const chain = request.recovery && Number.isFinite(Date.parse(warehouse.normalizeTimestamp(request.recovery.originalCreatedAt))) ? request.recovery : null;
      const originalCreatedAt = warehouse.normalizeTimestamp(chain ? chain.originalCreatedAt : row.created_at);
      const attempts = (Number(chain?.attempts) || 0) + 1;
      const recent = Date.parse(originalCreatedAt) >= Date.parse(at) - RECOVERY_WINDOW_MS;
      if (V2_KINDS.has(request.kind) && !row.cancel_requested && recent && attempts <= MAX_RECOVERY_ATTEMPTS) {
        const canonical = canonicalRequest(request);
        // Rows interrupted in this same pass are never used as the continuation (they are about to be marked interrupted).
        const existing = db.prepare("SELECT id,request_json FROM analytic_jobs WHERE owner_id=? AND status='queued' AND id<>?").all(row.owner_id, row.id)
          .filter((job) => !interruptedIds.has(job.id)).find((job) => canonicalRequest(parseJson(job.request_json, {})) === canonical);
        const requeuedAs = existing?.id || insertJob({ request: { ...request, requestedBy: "recovery", recovery: { originalCreatedAt, attempts } }, ownerId: row.owner_id, createdBy: row.created_by, total: row.total,
          notes: [...(parseJson(row.result_json, null)?.notes || []), `Queued again after a restart interrupted job ${row.id}.`], plan: parseJson(row.result_json, null)?.plan || null });
        if (!existing) result.requeued += 1;
        note.message = `Server restarted before this sync finished. It was queued again as job ${requeuedAs}.`; note.requeuedAs = requeuedAs;
        db.prepare("UPDATE analytic_schedule_runs SET job_id=?,updated_at=? WHERE job_id=?").run(requeuedAs, at, row.id);
        db.prepare("UPDATE analytic_schedules SET last_job_id=? WHERE last_job_id=?").run(requeuedAs, row.id);
      } else if (V2_KINDS.has(request.kind) && !row.cancel_requested && recent) {
        note.message = `Server restarted before this sync finished. It was interrupted ${attempts} times and was not queued again; start a new sync.`;
      }
      db.prepare("UPDATE analytic_jobs SET status='interrupted',current_report=NULL,finished_at=?,updated_at=?,errors_json=? WHERE id=?")
        .run(at, at, JSON.stringify([...parseJson(row.errors_json, []), note]), row.id);
      result.interrupted += 1;
    }
  })();
  return result;
}

// ---- legacy dashboard/bootstrap (stage 3 removes them with the old pages) -------------------------
function summaryFrom(reports) {
  const overview = reports.overview; const money = reports.monetaryOverview;
  const value = { ...(overview?.rows?.[0] || {}), ...(money?.rows?.[0] || {}) };
  if (typeof value.estimatedMinutesWatched === "number") value.watchHours = value.estimatedMinutesWatched / 60;
  if (typeof value.subscribersGained === "number" && typeof value.subscribersLost === "number") value.netSubscribers = value.subscribersGained - value.subscribersLost;
  if (typeof value.estimatedRevenue === "number" && value.views > 0) value.rpm = value.estimatedRevenue * 1000 / value.views;
  return value;
}
function dashboard(input, { canMonetary = false } = {}) {
  const owner = resolveOwner(input.ownerId, { requireConnected: false }); const selection = normalizeSelection(input, owner);
  const reports = Object.fromEntries(publicCatalog(canMonetary).map((report) => [report.id, readReport(selection, report)]));
  const previous = Object.fromEntries(publicCatalog(canMonetary).filter((r) => ["overview", "monetaryOverview", "daily", "monetaryDaily"].includes(r.id))
    .map((report) => [report.id, readReport(previousSelection(selection), report)]));
  const current = summaryFrom(reports); const prior = summaryFrom(previous);
  const changes = Object.fromEntries(Object.keys(current).map((key) => [key, typeof prior[key] === "number" && prior[key] !== 0 ? (current[key] - prior[key]) * 100 / Math.abs(prior[key]) : null]));
  const channels = db.prepare("SELECT owner_id,channel_id,title,thumbnail,country,published_at,subscriber_count,view_count,video_count,updated_at FROM analytic_channels WHERE owner_id=? ORDER BY title").all(selection.ownerId);
  const videos = db.prepare("SELECT owner_id,video_id,channel_id,title,thumbnail,duration,published_at,updated_at FROM analytic_videos WHERE owner_id=? ORDER BY updated_at DESC LIMIT 1000").all(selection.ownerId);
  const latestJob = listJobs(selection.ownerId, { canMonetary }, 30).find((job) => JSON.stringify(job.selection) === JSON.stringify(selection)) || null;
  return { selection: { ...selection, effectiveScope: selection.videoId ? "video" : selection.channelId ? "channel" : selection.scope },
    summary: { current, previous: prior, changes, previousDates: previousSelection(selection) }, reports, previousReports: previous, channels, videos, latestJob,
    coverage: { ready: Object.values(reports).filter((r) => ["ready", "empty"].includes(r.status)).length,
      total: Object.keys(reports).length, lastSyncedAt: Object.values(reports).map((r) => r.updatedAt).filter(Boolean).sort().at(-1) || null,
      note: "YouTube applies privacy thresholds and delays. Missing rows are not zero. Revenue values are estimates; top video reports contain at most 200 videos." } };
}
function bootstrap({ canMonetary = false, canSync = false } = {}) {
  return { owners: listOwners(), reportCatalog: publicCatalog(canMonetary), defaultDates: defaultDates(),
    database: { name: path.basename(db.analyticsPath), isolated: true, source: "YouTube Analytics v2 + YouTube Reporting v1" },
    permissions: { canMonetary, canViewMonetary: canMonetary, canSync }, limits: { maxDays: 366, topVideos: 200, interactiveRows: 100000 },
    docs: { contentOwnerReports: "https://developers.google.com/youtube/analytics/content_owner_reports",
      query: "https://developers.google.com/youtube/analytics/reference/reports/query" } };
}
function validateList(value, allowed, label, max) {
  const values = Array.isArray(value) ? value : String(value || "").split(",").filter(Boolean);
  if (values.length > max || values.some((v) => !allowed.has(v)) || new Set(values).size !== values.length) throw errorWithStatus(`Invalid ${label}; choose supported YouTube Analytics names.`);
  return values;
}
async function advancedQuery(input, { canMonetary = false } = {}) {
  const owner = resolveOwner(input.ownerId); const selection = normalizeSelection(input, owner);
  if (input.reportId) {
    const report = REPORT_CATALOG.find((r) => r.id === input.reportId);
    if (!report) throw errorWithStatus("Unknown catalog report.");
    if (report.monetary && !canMonetary) throw errorWithStatus("Your role cannot access Analytics revenue.", 403);
    if (report.managedChannels) {
      try { await syncChannels(owner); }
      catch (error) { recordFailure(selection, report, error); throw error; }
    }
    return executeReport(selection, report, owner);
  }
  const dimensions = validateList(input.dimensions, DIMENSIONS, "dimensions", 8);
  const metrics = validateList(input.metrics, METRICS, "metrics", 40);
  if (!metrics.length) throw errorWithStatus("Choose at least one metric.");
  const monetary = metrics.some((metric) => MONETARY_METRICS.has(metric));
  if (monetary && !canMonetary) throw errorWithStatus("Your role cannot access Analytics revenue.", 403);
  let filters = String(input.filters || "").trim();
  if (filters.length > 16000) throw errorWithStatus("Filters are too long.");
  const filterParts = filters ? filters.split(";") : [];
  for (const part of filterParts) {
    const match = /^([A-Za-z]+)==([\w.,+-]+)$/.exec(part);
    if (!match || !DIMENSIONS.has(match[1])) throw errorWithStatus("Filters must use supported dimension==value expressions separated by semicolons.");
    if (match[2].split(",").length > 500) throw errorWithStatus("Resource filters support at most 500 IDs.");
  }
  const entityFilters = filterParts.filter((part) => /^(video|channel|group|playlist|uploaderType|claimedStatus)==/.test(part));
  if ((selection.channelId || selection.videoId) && entityFilters.length) {
    const selectedEntity = selection.videoId ? `video==${selection.videoId}` : `channel==${selection.channelId}`;
    if (entityFilters.length !== 1 || entityFilters[0] !== selectedEntity) {
      throw errorWithStatus("The advanced resource filter conflicts with the selected channel or video. Clear the selected resource before querying another entity.");
    }
  }
  if (!entityFilters.length) filters = [baseFilters(selection), filters].filter(Boolean).join(";");
  if (selection.country) {
    const existingCountry = filterParts.find((part) => part.startsWith("country=="));
    if (existingCountry && existingCountry !== `country==${selection.country}`) throw errorWithStatus("The country filter conflicts with the selected country.");
    if (!existingCountry) filters = [filters, `country==${selection.country}`].filter(Boolean).join(";");
  }
  if (dimensions.includes("elapsedVideoTimeRatio") && !/^video==[\w-]{11}(;|$)/.test(filters)) throw errorWithStatus("Audience retention requires one video filter.");
  const sort = String(input.sort || "");
  if (sort && sort.split(",").some((field) => ![...dimensions, ...metrics].includes(field.replace(/^-/, "")))) throw errorWithStatus("Sort fields must be selected dimensions or metrics.");
  const limit = Number(input.maxResults || 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw errorWithStatus("maxResults must be between 1 and 200 for advanced queries.");
  const report = { id: `custom:${hash({ dimensions, metrics, filters, sort, limit }).slice(0, 20)}`, dimensions: dimensions.join(","), metrics: metrics.join(","), monetary, limit };
  const params = { ...queryParams(selection, report), filters, ...(sort ? { sort } : {}) };
  try { return persistReport(selection, report, params, await fetchTable(params, report, owner)); }
  catch (error) { recordFailure(selection, report, error); throw error; }
}
function listQueries(ownerId, { canMonetary = false } = {}) {
  const owner = ownerId ? resolveOwner(ownerId, { requireConnected: false }).network_code : null;
  const clauses = ["report_id LIKE 'custom:%'"];
  const args = [];
  if (owner) { clauses.push("owner_id = ?"); args.push(owner); }
  if (!canMonetary) clauses.push("monetary = 0");
  return db.prepare(`SELECT report_id,selection_json FROM analytic_snapshots WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC,rowid DESC LIMIT 50`)
    .all(...args).map((row) => {
      const selection = JSON.parse(row.selection_json);
      return { ...readReport(selection, { id: row.report_id }), ownerId: selection.ownerId, startDate: selection.startDate,
        endDate: selection.endDate, selection };
    });
}
function exportReport(input, { canMonetary = false } = {}) {
  const owner = resolveOwner(input.ownerId, { requireConnected: false }); const selection = normalizeSelection(input, owner);
  const id = String(input.reportId || input.report || "daily");
  let report = REPORT_CATALOG.find((r) => r.id === id);
  if (!report && /^custom:[a-f0-9]{20}$/.test(id)) {
    const row = db.prepare("SELECT monetary FROM analytic_snapshots WHERE snapshot_key=?").get(snapshotKey(selection, id));
    if (row) report = { id, monetary: !!row.monetary };
  }
  if (!report) throw errorWithStatus("Unknown report.", 404);
  if (report.monetary && !canMonetary) throw errorWithStatus("Your role cannot access Analytics revenue.", 403);
  const result = readReport(selection, report);
  if (!["ready", "empty", "stale"].includes(result.status)) throw errorWithStatus("No stored snapshot is available for this report and selection.", 404);
  const headers = result.columnHeaders.map((h) => h.name);
  const csvValue = (value) => {
    let text = String(value ?? "");
    if (typeof value === "string" && (/^[\s﻿]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return { csv: `﻿${[headers, ...result.rows.map((row) => headers.map((name) => row[name]))].map((row) => row.map(csvValue).join(",")).join("\r\n")}`,
    filename: `analytic-${id.replace(/[^\w-]/g, "-")}-${selection.startDate}-${selection.endDate}.csv`, report: result };
}

// ---- schedules ----------------------------------------------------------------------------------
function scheduleTimes(row) {
  try { return scheduleService.timingFromRow(row); }
  catch { return { times: [...scheduleService.DEFAULT_TIMES], timezone: scheduleService.TIMEZONE }; }
}
// A run row joined with its job: the enqueue outcome when no job exists, otherwise the job's own status.
function runOutcome(run) {
  if (run.jobStatus) return RUN_STATUSES.has(run.jobStatus) ? run.jobStatus : "failed";
  return run.status === "failed" ? "failed" : "not-run";
}
function instantOf(value) { const ms = Date.parse(warehouse.normalizeTimestamp(value)); return Number.isFinite(ms) ? ms : null; }
// Slots older than this instant are never synthesised: a timetable change or the v3 migration must not read as missed runs.
function statusHorizon(schedule) {
  const migration = parseJson(db.prepare("SELECT value FROM analytic_meta WHERE key=?").get(scheduleService.MIGRATION_META_KEY)?.value, null);
  return Math.max(instantOf(migration?.at) ?? 0, instantOf(schedule?.updated_at) ?? 0);
}
// THE daily-run status (bootstrap owners[].dailyRun, overview.dailyRun, schedules[].lastRun, the alert email). Run-row based:
// the current slot is its analytic_schedule_runs row joined with the job, or a synthesised `not-run` when the latest expected
// slot (newer than the horizon) has no row yet. `late` = the job started more than 15 minutes after the slot, or no job
// 15 minutes after the slot. `consecutiveFailures` walks the rows newest-first and stops at the first completed/partial run;
// the current slot is not counted while it is still queued/running or while enqueue attempts remain. `firstError` is
// sanitised per role through jobFromRow (a monetary step's error is hidden from a role without revenue access).
function dailyRunStatus(ownerId, access = {}, now = new Date()) {
  const schedule = scheduleRow(ownerId);
  const nowAt = nowIso(now); const nowMs = Date.parse(nowAt);
  const runs = db.prepare(`SELECT r.*,j.status AS jobStatus FROM analytic_schedule_runs r LEFT JOIN analytic_jobs j ON j.id=r.job_id WHERE r.owner_id=? ORDER BY r.scheduled_for DESC LIMIT 30`).all(ownerId);
  const expected = schedule?.enabled ? scheduleService.latestSlot(nowAt, scheduleTimes(schedule).times) : null;
  const latest = runs[0] || null;
  const synthesised = !!expected && Date.parse(expected) >= statusHorizon(schedule) && (!latest || latest.scheduled_for < expected);
  const run = synthesised ? null : latest;
  const scheduledFor = synthesised ? expected : run?.scheduled_for || null;
  const job = run?.job_id ? db.prepare("SELECT * FROM analytic_jobs WHERE id=?").get(run.job_id) || null : null;
  const visible = job ? jobFromRow(job, access) : null;
  const status = synthesised ? "not-run" : run ? runOutcome(run) : "not-run";
  const startedAt = job?.started_at ? warehouse.normalizeTimestamp(job.started_at) : null;
  const late = !!schedule?.enabled && !!scheduledFor && (startedAt ? Date.parse(startedAt) - Date.parse(scheduledFor) > LATE_AFTER_MS : nowMs - Date.parse(scheduledFor) > LATE_AFTER_MS);
  let failures = 0; let streakStart = null;
  if (synthesised && late) { failures += 1; streakStart = expected; }
  for (let index = 0; index < runs.length; index += 1) {
    const item = runs[index]; const outcome = runOutcome(item);
    if (index === 0 && item === run) {
      if (["queued", "running"].includes(outcome)) continue;
      if (outcome === "failed" && !item.job_id && item.retry_at && Date.parse(item.retry_at) > nowMs) continue;
      if (outcome === "not-run") continue;
    }
    if (!FAILED_OUTCOMES.has(outcome)) break;
    failures += 1; streakStart = item.scheduled_for;
  }
  const result = job ? parseJson(job.result_json, null) : null;
  const days = result?.days ? { addedCount: Number(result.days.addedCount ?? (Array.isArray(result.days.added) ? result.days.added.length : 0)) || 0,
    driftedCount: Number(result.days.driftedCount ?? (Array.isArray(result.days.drifted) ? result.days.drifted.length : 0)) || 0 } : null;
  const firstError = visible ? visible.errors[0]?.message ?? null : run?.status === "failed" ? parseJson(run.error_json, null)?.message ?? null : null;
  return { scheduledFor, enqueuedAt: run?.job_id ? warehouse.normalizeTimestamp(run.updated_at || run.created_at) : null, jobId: job?.id || null, status, late, consecutiveFailures: failures, streakStart,
    startedAt, finishedAt: job?.finished_at ? warehouse.normalizeTimestamp(job.finished_at) : null, firstError, counts: result?.counts || null, days,
    nextRunAt: schedule?.next_run_at ?? null, enabled: !!schedule?.enabled };
}
function getSchedules(access = {}) {
  const { scheduleSettings } = engineModule();
  return db.prepare("SELECT * FROM analytic_schedules ORDER BY owner_id").all().map((row) => {
    const settings = scheduleSettings(row); const timing = scheduleTimes(row);
    return { ownerId: row.owner_id, enabled: !!row.enabled, monetary: !!row.monetary, times: timing.times, timezone: timing.timezone, lagDays: settings.lagDays,
      lookbackDays: settings.lookbackDays, channelMode: settings.channelMode, channelIds: settings.channelIds, scopes: settings.scopes, includeBreakdowns: settings.includeBreakdowns,
      includeSnapshots: settings.includeSnapshots, refreshProvisional: settings.refreshProvisional, settleDays: settings.settleDays, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
      lastScheduledFor: row.last_scheduled_for, lastJobId: row.last_job_id, lastError: row.last_error, lastErrorAt: row.last_error_at, retryAt: row.retry_at,
      scheduleVersion: row.schedule_version, createdBy: row.created_by, updatedAt: row.updated_at, lastRun: dailyRunStatus(row.owner_id, access) };
  });
}
function integerIn(value, fallback, [min, max], label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw errorWithStatus(`${label} must be between ${min} and ${max}.`);
  return number;
}
function saveSchedule(input = {}, { userId = null, canMonetary = false, canSync, canManageSchedules } = {}) {
  if (!(canManageSchedules ?? canSync ?? true)) throw errorWithStatus("Your role cannot change the Analytics schedule.", 403);
  const owner = resolveOwner(input.ownerId, { requireConnected: input.enabled === true });
  const existing = db.prepare("SELECT * FROM analytic_schedules WHERE owner_id = ?").get(owner.network_code);
  if (existing?.monetary && !canMonetary) throw errorWithStatus("Your role cannot change an existing revenue sync schedule.", 403);
  const { scheduleSettings, LIMITS } = engineModule();
  const current = scheduleSettings(existing);
  const lookback = integerIn(input.lookbackDays, existing ? current.lookbackDays : 7, LIMITS.lookbackDays, "lookbackDays");
  const lagDays = integerIn(input.lagDays, current.lagDays, LIMITS.lagDays, "lagDays");
  const settleDays = integerIn(input.settleDays, current.settleDays, LIMITS.settleDays, "settleDays");
  const scopes = validateScopes(input.scopes ?? (input.scope ? [input.scope] : current.scopes));
  const channelMode = input.channelMode ?? current.channelMode;
  if (!["all", "selected", "none"].includes(channelMode)) throw errorWithStatus("channelMode must be all, selected or none.");
  const channelIds = channelMode === "selected" ? validateChannelIds(owner.network_code, input.channelIds ?? current.channelIds) : [];
  if (channelMode === "selected" && !channelIds.length) throw errorWithStatus("Select at least one channel or track all channels.");
  const monetary = toBoolean(input.monetary, !!existing?.monetary);
  if (monetary && !canMonetary) throw errorWithStatus("Your role cannot schedule revenue syncs.", 403);
  const enabled = input.enabled === true; const at = nowIso();
  // An enabled revenue schedule needs the monetary OAuth scope, otherwise every run would die on a fatal 403.
  if (enabled && monetary && !ownerHasMonetaryScope(owner)) throw errorWithStatus("Revenue cannot be scheduled: the CMS token has no revenue scope.", 400, "monetaryScopeMissing");
  const previousTiming = existing ? scheduleTimes(existing) : {};
  const timing = scheduleService.normalizeTiming(input.times ?? previousTiming.times, input.timezone ?? previousTiming.timezone);
  // Same timetable: the pending enqueue retry of today's slot survives the save; a new timetable starts clean.
  const sameTimetable = !!existing && JSON.stringify(previousTiming.times) === JSON.stringify(timing.times) && previousTiming.timezone === timing.timezone;
  const retryAt = sameTimetable && enabled && !!existing.enabled ? existing.retry_at : null;
  db.prepare(`INSERT INTO analytic_schedules(owner_id,enabled,lookback_days,scope,monetary,created_by,next_run_at,times_json,timezone,schedule_version,lag_days,channel_mode,channel_ids_json,
    scopes_json,include_breakdowns,include_snapshots,refresh_provisional,settle_days,retry_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,lookback_days=excluded.lookback_days,scope=excluded.scope,monetary=excluded.monetary,created_by=excluded.created_by,
    next_run_at=excluded.next_run_at,times_json=excluded.times_json,timezone=excluded.timezone,schedule_version=excluded.schedule_version,lag_days=excluded.lag_days,
    channel_mode=excluded.channel_mode,channel_ids_json=excluded.channel_ids_json,scopes_json=excluded.scopes_json,include_breakdowns=excluded.include_breakdowns,
    include_snapshots=excluded.include_snapshots,refresh_provisional=excluded.refresh_provisional,settle_days=excluded.settle_days,retry_at=excluded.retry_at,updated_at=excluded.updated_at`)
    .run(owner.network_code, enabled ? 1 : 0, lookback, scopes[0], monetary && canMonetary ? 1 : 0, userId, enabled ? scheduleService.nextSlot(at, timing.times) : null,
      JSON.stringify(timing.times), timing.timezone, scheduleService.SCHEDULE_VERSION, lagDays, channelMode, JSON.stringify(channelIds), JSON.stringify(scopes),
      toBoolean(input.includeBreakdowns, current.includeBreakdowns) ? 1 : 0, toBoolean(input.includeSnapshots, current.includeSnapshots) ? 1 : 0,
      toBoolean(input.refreshProvisional, current.refreshProvisional) ? 1 : 0, settleDays, retryAt, at);
  if (sameTimetable && enabled) rearmPermissionFailure(owner.network_code, timing.times, at);
  return getSchedules({ canMonetary }).find((row) => row.ownerId === owner.network_code);
}
// Re-saving the schedule is what the schedulePermissionDenied message asks for: when the saved row now passes the
// creator check and today's slot failed for that reason, the slot gets one more attempt right away instead of tomorrow.
function rearmPermissionFailure(ownerId, times, nowAt) {
  const slot = scheduleService.latestSlot(nowAt, times);
  const run = db.prepare("SELECT * FROM analytic_schedule_runs WHERE owner_id=? AND scheduled_for=?").get(ownerId, slot);
  const detail = run?.status === "failed" && !run.job_id ? parseJson(run.error_json, null) : null;
  if (detail?.reason !== "schedulePermissionDenied") return;
  try { scheduleAccess(scheduleRow(ownerId)); } catch { return; }
  scheduleService.rearmRun(db, { ownerId, scheduledFor: slot, now: nowAt, detail: { message: detail.message, reason: detail.reason, status: detail.status } });
}
function scheduleAccess(schedule) {
  const user = schedule.created_by == null ? null : credentialDb().prepare("SELECT id,role,status FROM users WHERE id=?").get(schedule.created_by);
  if (!user || user.status !== "active") throw errorWithStatus("The schedule creator is missing or inactive. An authorized user must save the schedule again.", 403, "schedulePermissionDenied");
  const { normalizedRoles } = require("../middlewares/authMiddleware");
  const roles = normalizedRoles(user.role);
  const admin = roles.some((role) => ["admin", "super admin", "supper admin"].includes(role));
  if (roles.includes("read only") || (!admin && !roles.some((role) => ["report manager", "content id"].includes(role)))) {
    throw errorWithStatus("The schedule creator no longer has permission to sync Analytics.", 403, "schedulePermissionDenied");
  }
  if (schedule.monetary && !admin && !roles.includes("report manager")) {
    throw errorWithStatus("The schedule creator no longer has permission to sync revenue.", 403, "schedulePermissionDenied");
  }
  return { userId: user.id, canMonetary: !!schedule.monetary };
}
function ownerConnected(ownerId) {
  try { resolveOwner(ownerId); return true; } catch { return false; }
}
// A slot that failed because the CMS was disconnected gets one more attempt as soon as the owner is connected again
// (once per slot, remembered in analytic_meta so a job that fails the same way cannot loop).
function rearmReconnected(nowAt) {
  db.prepare("DELETE FROM analytic_meta WHERE key LIKE 'rearm:%' AND updated_at<?").run(new Date(Date.parse(nowAt) - 30 * DAY).toISOString());
  for (const schedule of db.prepare("SELECT * FROM analytic_schedules WHERE enabled=1 ORDER BY owner_id").all()) {
    const slot = scheduleService.latestSlot(nowAt, scheduleTimes(schedule).times);
    const marker = `rearm:${schedule.owner_id}:${slot}`;
    if (db.prepare("SELECT 1 FROM analytic_meta WHERE key=?").get(marker)) continue;
    const run = db.prepare("SELECT * FROM analytic_schedule_runs WHERE owner_id=? AND scheduled_for=?").get(schedule.owner_id, slot) || null;
    if (!run) continue;
    const job = run.job_id ? db.prepare("SELECT * FROM analytic_jobs WHERE id=?").get(run.job_id) || null : null;
    const detail = parseJson(run.error_json, null);
    let failure = null;
    if (run.status === "failed" && detail?.reason === "cmsNotConnected") failure = { message: detail.message, reason: detail.reason, status: detail.status };
    else if (run.status === "queued" && job?.status === "failed") {
      const jobError = parseJson(job.errors_json, []).find((error) => error.reason === "cmsNotConnected");
      if (jobError) failure = { message: jobError.message, reason: jobError.reason, status: jobError.status };
    }
    if (!failure || !ownerConnected(schedule.owner_id)) continue;
    scheduleService.rearmRun(db, { ownerId: schedule.owner_id, scheduledFor: slot, now: nowAt, detail: failure });
    db.prepare("INSERT INTO analytic_meta(key,value,updated_at) VALUES(?,?,?)").run(marker, nowAt, nowAt);
  }
}
function alertEmails() {
  return [...new Set(String(process.env.ANALYTICS_ALERT_EMAILS || "").split(/[\s,;]+/).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}
function smtpConfigured() { return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }
// One email per failure streak (two or more consecutive failed/not-run slots); nothing when ANALYTICS_ALERT_EMAILS is unset.
// The streak marker is stored only once sendMail resolved, so a failed delivery is retried on the next tick.
function notifyFailures(nowAt) {
  const emails = alertEmails();
  if (!emails.length) return;
  for (const schedule of db.prepare("SELECT owner_id FROM analytic_schedules WHERE enabled=1 ORDER BY owner_id").all()) {
    const status = dailyRunStatus(schedule.owner_id, { canMonetary: true }, nowAt);
    const key = `alert:dailyRun:${schedule.owner_id}`;
    const stored = db.prepare("SELECT value FROM analytic_meta WHERE key=?").get(key)?.value || null;
    if (!status || status.consecutiveFailures < 2) { if (stored) db.prepare("DELETE FROM analytic_meta WHERE key=?").run(key); continue; }
    if (stored === status.streakStart || alertsInFlight.has(key)) continue;
    const owner = listOwners().find((entry) => entry.ownerId === schedule.owner_id);
    const name = owner?.name || schedule.owner_id;
    alertsInFlight.add(key);
    require("./mailService").sendMail({ to: emails.join(","), subject: `[Analytics] Daily sync failed ${status.consecutiveFailures} times in a row for ${name}`,
      text: [`The Analytics daily sync for ${name} (${schedule.owner_id}) has not completed for ${status.consecutiveFailures} consecutive slots.`,
        `Latest slot: ${status.scheduledFor} (status ${status.status}${status.late ? ", late" : ""}).`, status.firstError ? `First error: ${status.firstError}` : "",
        "Check Analytics > Data & sync, reconnect the CMS OAuth in Settings > Network if needed, then run the daily sync."].filter(Boolean).join("\n") })
      .then(() => db.prepare("INSERT INTO analytic_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, status.streakStart, nowAt))
      .catch((error) => console.error("[Analytics alert]", safeError(error).message))
      .finally(() => alertsInFlight.delete(key));
  }
}
function tickSchedules(now = new Date()) {
  const nowAt = nowIso(now);
  rearmReconnected(nowAt);
  const result = scheduleService.tick(db, (schedule) => {
    const access = scheduleAccess(schedule);
    return createSync({ kind: "daily", ownerId: schedule.owner_id }, { ...access, canSync: true, requestedBy: "schedule" });
  }, { now, safeError });
  notifyFailures(nowAt);
  return result;
}
// Legacy rows mix 'YYYY-MM-DD HH:MM:SS' (CURRENT_TIMESTAMP) and ISO; one ISO form keeps string ordering safe.
const LEGACY_TIMESTAMP_COLUMNS = [["analytic_snapshots", "updated_at"], ["analytic_attempts", "attempted_at"], ["analytic_jobs", "created_at"], ["analytic_jobs", "updated_at"],
  ["analytic_schedule_runs", "created_at"], ["analytic_schedule_runs", "updated_at"], ["analytic_schedules", "updated_at"], ["analytic_owners", "updated_at"],
  ["analytic_channels", "updated_at"], ["analytic_videos", "updated_at"]];
function normalizeLegacyTimestamps() {
  db.exec(LEGACY_TIMESTAMP_COLUMNS.map(([table, column]) => `UPDATE ${table} SET ${column}=replace(${column},' ','T')||'Z' WHERE substr(${column},11,1)=' ';`).join("\n"));
}
// ---- single-writer lease ------------------------------------------------------------------------
// analytic_meta['worker:lease'] = { pid, at }: refreshed every tick, stale after 90 s. A second backend on the same database
// (nodemon beside pm2) only serves reads until the lease expires; ANALYTICS_FORCE_WORKER=1 takes it over.
function leaseRow() { return parseJson(db.prepare("SELECT value FROM analytic_meta WHERE key=?").get(LEASE_KEY)?.value, null); }
// Returns null when this process now holds the lease, otherwise the fresh lease of the other process.
function acquireLease(nowAt) {
  return db.transaction(() => {
    const current = leaseRow();
    const fresh = !!current && Number.isFinite(Date.parse(current.at)) && Date.parse(nowAt) - Date.parse(current.at) < LEASE_STALE_MS;
    if (fresh && current.pid !== process.pid && process.env.ANALYTICS_FORCE_WORKER !== "1") return current;
    db.prepare("INSERT INTO analytic_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(LEASE_KEY, JSON.stringify({ pid: process.pid, at: nowAt }), nowAt);
    return null;
  }).immediate();
}
function releaseLease() {
  try { if (leaseRow()?.pid === process.pid) db.prepare("DELETE FROM analytic_meta WHERE key=?").run(LEASE_KEY); } catch { /* closing */ }
  leaseHeld = false;
}
// Boot sequence, run once per acquired lease: timestamp normalisation, migrations (guarded, idempotent), restart recovery.
function bootWorker() {
  normalizeLegacyTimestamps();
  const migration = warehouse.migrateSnapshotsToFacts(db, { now: new Date() });
  if (!migration.skipped) console.log(`[analytics] snapshot migration: ${migration.facts} fact rows, ${migration.coverage} coverage rows`);
  const schedules = scheduleService.migrateToV3(db);
  if (!schedules.skipped) console.log(`[analytics] schedule v3 migration: ${schedules.migrated} rows`);
  const recovered = recoverInterruptedJobs();
  if (recovered.interrupted) console.log(`[analytics] recovery: ${recovered.interrupted} interrupted, ${recovered.requeued} queued again`);
  if (alertEmails().length && !smtpConfigured()) console.warn("[analytics] ANALYTICS_ALERT_EMAILS is set but SMTP_HOST/SMTP_USER/SMTP_PASS are missing; daily-sync alert emails cannot be sent");
}
function workerTick(now = new Date()) {
  const nowAt = nowIso(now);
  let blocker;
  try { blocker = acquireLease(nowAt); }
  catch (error) { console.error(`[analytics] worker lease unavailable (will retry on the next tick): ${safeError(error).message}`); return; }
  if (blocker) {
    if (leaseHeld || leaseBlockedBy !== blocker.pid) console.log(`[analytics] another backend (pid ${blocker.pid}) holds the analytics worker lease; this process serves reads only until it expires (ANALYTICS_FORCE_WORKER=1 takes over)`);
    leaseHeld = false; leaseBlockedBy = blocker.pid;
    return;
  }
  if (!leaseHeld) {
    try { bootWorker(); }
    catch (error) { console.error(`[analytics] worker startup failed (will retry on the next tick): ${safeError(error).message}`); return; }
    leaseHeld = true; leaseBlockedBy = null;
  }
  try { tickSchedules(nowAt); }
  catch (error) { console.error("[Analytics scheduler]", safeError(error).message); }
  drainQueue().catch((error) => console.error("[Analytics worker]", safeError(error).message));
}
// One backend process per analytics database: the worker, the scheduler and the migrations assume a single writer (the
// lease enforces it). Never throws: a failed boot is logged with context and retried on the 30 s tick.
function startWorker() {
  if (timer) return;
  timer = setInterval(() => workerTick(), 30000); timer.unref();
  try { workerTick(); }
  catch (error) { console.error(`[analytics] worker start failed: ${safeError(error).message}`); }
}
function stopWorker() { if (timer) clearInterval(timer); timer = null; releaseLease(); for (const controller of controllers.values()) controller.abort(); }

module.exports = { listOwners, resolveOwner, googleGet, safeError, normalizeSelection, previousSelection, defaultDates,
  bootstrap, dashboard, createSync, planSync, getJob, listJobs, cancelJob, jobIsMonetary, advancedQuery, listQueries, exportReport, getSchedules, saveSchedule, dailyRunStatus,
  startWorker, stopWorker, recoverInterruptedJobs, normalizeLegacyTimestamps, canonicalRequest, publicCatalog, snapshotKey, readReport, persistReport, recordFailure,
  fetchTable, queryParams, executeReport, drainQueue, syncChannels, syncVideoMetadata, summaryFrom, tickSchedules, latestAllowedDay: (now) => engineModule().latestAllowedDay(now) };
