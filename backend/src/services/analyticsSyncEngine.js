// Analytics sync engine: plans and runs the v2 job kinds (daily, full, channelDetail) against the
// YouTube Analytics API v2 and the Data API v3 and writes per-day facts, breakdowns and coverage into
// the warehouse. No top-level require of analyticsService (CommonJS cycle): analyticsService wires the
// engine lazily and passes itself as `core` (googleGet, resolveOwner, normalizeSelection, executeReport,
// readReport, syncVideoMetadata, safeError).
const { REPORT_CATALOG } = require("./analyticsCatalog");

const ANALYTICS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
const DATA_URL = "https://www.googleapis.com/youtube/v3";
const DAY = 86400000;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const V2_KINDS = new Set(["daily", "full", "channelDetail"]);
const SCOPES = ["claimed", "self", "thirdParty"];
const SCOPE_FILTERS = { claimed: "claimedStatus==claimed", self: "uploaderType==self", thirdParty: "claimedStatus==claimed;uploaderType==thirdParty" };
const BASIC_METRICS = "views,engagedViews,redViews,estimatedMinutesWatched,estimatedRedMinutesWatched,averageViewDuration,averageViewPercentage,likes,dislikes,comments,shares,subscribersGained,subscribersLost,videosAddedToPlaylists,videosRemovedFromPlaylists";
const MONEY_METRICS = "estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,grossRevenue,monetizedPlaybacks,playbackBasedCpm,adImpressions,cpm";
const WATCH_METRICS = "views,engagedViews,estimatedMinutesWatched";
const COUNTRY_METRICS = "views,engagedViews,estimatedMinutesWatched,likes,comments,shares,subscribersGained,subscribersLost";
const AD_METRICS = "grossRevenue,adImpressions,cpm";
// `day` combines with these dimensions in one request (chunks of 90 days); country/sharingService need one request per day.
const WITH_DAY_DIMENSIONS = ["insightTrafficSourceType", "insightPlaybackLocationType", "deviceType", "operatingSystem", "subscribedStatus", "liveOrOnDemand", "youtubeProduct"];
const PER_DAY_DIMENSIONS = ["country", "sharingService"];
const BREAKDOWN_DIMENSIONS = [...WITH_DAY_DIMENSIONS, "creatorContentType", "adType", ...PER_DAY_DIMENSIONS];
const OWNER_SNAPSHOT_REPORTS = ["videos", "videoRevenue", "demographics"];
const CHANNEL_SNAPSHOT_REPORTS = ["videos", "videoRevenue", "demographics", "countries", "trafficSources", "devices", "operatingSystems", "subscribedStatus", "contentTypes", "playbackLocations", "youtubeProducts"];
const SNAPSHOT_PRESETS = [7, 28, 90];
const DEFAULTS = Object.freeze({ lagDays: 3, lookbackDays: 7, settleDays: 7, channelMode: "all", scopes: Object.freeze(["claimed"]), includeBreakdowns: true, includeSnapshots: true, refreshProvisional: false });
const LIMITS = Object.freeze({ lagDays: [3, 7], lookbackDays: [3, 90], settleDays: [3, 30], maxDays: 366, maxChannelIds: 200 });
const PAGE_SIZE = 200;
const BREAKDOWN_CHUNK_DAYS = 90;
const BREAKER_THRESHOLD = 3;
const JOB_RETENTION_DAYS = 180;
const JOBS_KEPT_PER_OWNER = 30;
const RESULT_DAY_LIMIT = 100;
const SNAPSHOT_GRACE_DAYS = 7;
// Range snapshots of a custom (non-preset) range come from a user's "Sync all"; they outlive the preset grace for this long.
const CUSTOM_SNAPSHOT_KEEP_DAYS = 30;
const CONNECTION_REASONS = new Set(["cmsNotConnected", "missingCredentials", "invalid_grant", "missing_refresh_token"]);
const CREDENTIAL_REASONS = new Set([...CONNECTION_REASONS, "invalid_client", "unauthorized_client"]);
const FATAL_REASONS = new Set([...CREDENTIAL_REASONS, "quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded",
  "insufficientPermissions", "forbidden", "accessNotConfigured"]);
const MONEY_SCOPE_NOTE = "Revenue was skipped: the CMS token has no revenue scope.";

function errorWithStatus(message, status = 400, reason) { const error = new Error(message); error.status = status; if (reason) error.reason = reason; return error; }
function cancelledError() { return errorWithStatus("Cancelled", 499, "cancelled"); }
function envInt(name, fallback, min, max) { const value = Number(process.env[name]); return Number.isInteger(value) && value >= min && value <= max ? value : fallback; }
function maxRequestsPerJob() { return envInt("ANALYTICS_MAX_REQUESTS_PER_JOB", 5000, 1, 1000000); }
function channelBatchSize() { return envInt("ANALYTICS_CHANNEL_BATCH", 200, 1, 500); }
// The one parser of the sync limits (same clamps as planJob/paceRequest); the read service advertises these values.
function effectiveLimits() { return { maxRequestsPerJob: maxRequestsPerJob(), channelBatch: channelBatchSize(), paceMs: resolvePace().minDelayMs }; }
function addDays(day, count) { return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10); }
function daysBetween(startDate, endDate) { const days = []; for (let day = startDate; day <= endDate; day = addDays(day, 1)) days.push(day); return days; }
function chunkRange(startDate, endDate, size) {
  const chunks = [];
  for (let start = startDate; start <= endDate; start = addDays(start, size)) { const end = addDays(start, size - 1); chunks.push({ startDate: start, endDate: end < endDate ? end : endDate }); }
  return chunks;
}
function minDay(a, b) { return !a ? b : !b ? a : a < b ? a : b; }
function toDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw errorWithStatus("A valid instant is required.");
  return date;
}
function parseJson(text, fallback) { try { const value = JSON.parse(text); return value ?? fallback; } catch { return fallback; } }
// `day` rows are Pacific-time days; the last completed one is PT yesterday.
function pacificToday(now = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(toDate(now)); }
function latestAllowedDay(now = new Date()) { return addDays(pacificToday(now), -1); }
function bangkokToday(now = new Date()) { return new Date(toDate(now).getTime() + 7 * 3600000).toISOString().slice(0, 10); }
function within(value, [min, max]) { return Number.isInteger(value) && value >= min && value <= max; }
// Parsed schedule row with defaults (also used for a daily job without a saved schedule).
function scheduleSettings(row) {
  if (!row) return { ...DEFAULTS, scopes: [...DEFAULTS.scopes], channelIds: [], monetary: false };
  const ids = parseJson(row.channel_ids_json, []); const scopes = parseJson(row.scopes_json, null);
  const number = (value, key) => within(value, LIMITS[key]) ? value : DEFAULTS[key];
  return { lagDays: number(row.lag_days, "lagDays"), lookbackDays: number(row.lookback_days, "lookbackDays"), settleDays: number(row.settle_days, "settleDays"),
    channelMode: ["all", "selected", "none"].includes(row.channel_mode) ? row.channel_mode : DEFAULTS.channelMode,
    channelIds: Array.isArray(ids) ? [...new Set(ids.filter((id) => CHANNEL_ID.test(String(id))))].slice(0, LIMITS.maxChannelIds) : [],
    scopes: Array.isArray(scopes) && scopes.length && scopes.every((scope) => SCOPES.includes(scope)) ? [...new Set(scopes)] : SCOPES.includes(row.scope) ? [row.scope] : [...DEFAULTS.scopes],
    includeBreakdowns: row.include_breakdowns == null ? true : !!row.include_breakdowns, includeSnapshots: row.include_snapshots == null ? true : !!row.include_snapshots,
    refreshProvisional: !!row.refresh_provisional, monetary: !!row.monetary };
}
// quota/permission/credential problems fail the job; Google-side 5xx, timeouts and shape errors stay step-level.
// HTTP 429 reaching the engine survived googleGet's retries, so it is a quota/rate limit whatever the reason string says.
function classifyError(error) {
  if (!error) return "transient";
  if (error.reason === "cancelled" || Number(error.status) === 499 || error.code === "ERR_CANCELED") return "cancelled";
  if (error.cmsAuthFailed || error.oauthClientMisconfigured || FATAL_REASONS.has(error.reason) || [401, 403, 429].includes(Number(error.status))) return "fatal";
  return "transient";
}
// Only a refused credential (401 after refresh, invalid_grant, disconnected CMS, broken OAuth client) is fatal for the Data API
// inventory; its quota (403), 429 and 5xx are independent of the Analytics API and fall back to the stored channels.
function isCredentialError(error) {
  return !!(error?.cmsAuthFailed || error?.oauthClientMisconfigured) || CREDENTIAL_REASONS.has(error?.reason) || Number(error?.status) === 401;
}
// Google answers a MONEY request with 403 insufficientPermissions when the token lacks yt-analytics-monetary.readonly.
function isScopeRefusal(error) { return Number(error?.status) === 403 && error?.reason === "insufficientPermissions"; }
function catalogReport(id) { return REPORT_CATALOG.find((report) => report.id === id); }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelledError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(cancelledError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function resolvePace(pace) {
  if (pace === false || pace === 0) return { minDelayMs: 0, jitterMs: 0 };
  if (typeof pace === "number") return { minDelayMs: pace, jitterMs: Math.round(pace / 5) };
  if (pace && typeof pace === "object") return { minDelayMs: Math.max(0, Number(pace.minDelayMs) || 0), jitterMs: Math.max(0, Number(pace.jitterMs) || 0) };
  const env = process.env.ANALYTICS_PACE_MS;
  const ms = env === undefined || env === "" ? 250 : Math.max(0, Number(env) || 0);
  return { minDelayMs: ms, jitterMs: Math.round(ms / 5) };
}

// Data API channel inventory: upsert, `removed_at` for channels missing from the listing, cleared when they reappear.
function applyInventory(db, { ownerId, items = [], now }) {
  const at = toDate(now).toISOString();
  const upsert = db.prepare(`INSERT INTO analytic_channels(owner_id,channel_id,title,thumbnail,description,country,published_at,subscriber_count,view_count,video_count,metadata_json,updated_at,removed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(owner_id,channel_id) DO UPDATE SET title=excluded.title,thumbnail=excluded.thumbnail,description=excluded.description,
    country=excluded.country,published_at=excluded.published_at,subscriber_count=excluded.subscriber_count,view_count=excluded.view_count,video_count=excluded.video_count,
    metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,removed_at=NULL`);
  const remove = db.prepare("UPDATE analytic_channels SET removed_at=?,updated_at=? WHERE owner_id=? AND channel_id=?");
  const number = (value) => value == null ? null : Number(value);
  const result = { count: 0, added: 0, restored: 0, removed: 0 };
  db.transaction(() => {
    const before = new Map(db.prepare("SELECT channel_id,removed_at FROM analytic_channels WHERE owner_id=?").all(ownerId).map((row) => [row.channel_id, row.removed_at]));
    const listed = new Set();
    for (const item of items) {
      const id = String(item?.id || "");
      if (!CHANNEL_ID.test(id) || listed.has(id)) continue;
      listed.add(id);
      upsert.run(ownerId, id, item.snippet?.title || id, item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null, item.snippet?.description || "",
        item.snippet?.country || null, item.snippet?.publishedAt || null, number(item.statistics?.subscriberCount), number(item.statistics?.viewCount), number(item.statistics?.videoCount), JSON.stringify(item), at);
      if (!before.has(id)) result.added += 1; else if (before.get(id)) result.restored += 1;
    }
    for (const [id, removedAt] of before) if (!listed.has(id) && !removedAt) { remove.run(at, at, ownerId, id); result.removed += 1; }
    result.count = listed.size;
  })();
  return result;
}
async function fetchInventory({ db, get, owner, now, signal }) {
  const items = []; let pageToken; const seen = new Set(); let pages = 0;
  do {
    const page = await get(`${DATA_URL}/channels`, { params: { part: "snippet,statistics,contentDetails", managedByMe: true, onBehalfOfContentOwner: owner.network_code,
      maxResults: 50, ...(pageToken ? { pageToken } : {}) }, owner, signal });
    pages += 1;
    items.push(...(Array.isArray(page?.items) ? page.items : []));
    pageToken = page?.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw errorWithStatus("Channel pagination repeated a page token.", 502);
    if (pageToken) seen.add(pageToken);
    if (items.length > 100000) throw errorWithStatus("Channel inventory exceeds the interactive safety limit.", 422);
  } while (pageToken);
  return { ...applyInventory(db, { ownerId: owner.network_code, items, now }), pages };
}
function activeChannelIds(db, ownerId) {
  return db.prepare("SELECT channel_id FROM analytic_channels WHERE owner_id=? AND removed_at IS NULL ORDER BY channel_id").all(ownerId).map((row) => row.channel_id);
}
function emptyCounts() { return { inserted: 0, updated: 0, enriched: 0, unchanged: 0, drift: 0, skipped: 0 }; }

function createSyncEngine({ db, core, warehouse, now = () => new Date(), pace, log = (line) => console.log(line) } = {}) {
  if (!db || !core || !warehouse) throw new Error("createSyncEngine needs db, core and warehouse.");
  const pacing = resolvePace(pace);
  let lastRequestAt = 0;
  const at = () => toDate(now()).toISOString();

  // ---- planning -------------------------------------------------------------------------------
  function planJob(request, { schedule = null, now: planNow } = {}) {
    const nowDate = toDate(planNow ?? now());
    const monetary = !!request.monetary;
    let plan;
    if (request.kind === "daily") {
      const settings = scheduleSettings(schedule);
      const endDate = addDays(bangkokToday(nowDate), -settings.lagDays);
      plan = { kind: "daily", mode: "append", startDate: addDays(endDate, -(settings.lookbackDays - 1)), endDate, lagDays: settings.lagDays, lookbackDays: settings.lookbackDays,
        scopes: settings.scopes, channelMode: settings.channelMode, channelIds: settings.channelIds, includeBreakdowns: settings.includeBreakdowns, includeSnapshots: settings.includeSnapshots,
        monetary, refreshProvisional: settings.refreshProvisional, settleDays: settings.settleDays };
    } else if (request.kind === "full") {
      plan = { kind: "full", mode: request.mode, startDate: request.startDate, endDate: request.endDate, lagDays: DEFAULTS.lagDays, scopes: [...request.scopes], channelMode: request.channelMode,
        channelIds: [...(request.channelIds || [])], includeBreakdowns: request.includeBreakdowns !== false, includeSnapshots: request.includeSnapshots !== false, monetary, refreshProvisional: false, settleDays: 0 };
    } else if (request.kind === "channelDetail") {
      plan = { kind: "channelDetail", mode: "append", startDate: request.startDate, endDate: request.endDate, lagDays: DEFAULTS.lagDays, channelId: request.channelId, scopes: [],
        channelMode: "selected", channelIds: [request.channelId], includeBreakdowns: false, includeSnapshots: true, monetary, refreshProvisional: false, settleDays: 0 };
    } else throw errorWithStatus("Unsupported job kind.");
    plan.ownerId = request.ownerId; plan.batch = channelBatchSize(); plan.latestAllowedDay = latestAllowedDay(nowDate);
    const channels = plan.channelMode === "none" ? [] : plan.channelMode === "selected" ? plan.channelIds : activeChannelIds(db, plan.ownerId);
    plan.channels = { planned: channels.length };
    plan.requests = estimate(plan, channels);
    plan.cap = maxRequestsPerJob(); plan.overCap = plan.requests.estimate > plan.cap;
    plan.days = { requested: daysBetween(plan.startDate, plan.endDate).length, ...missingSummary(plan) };
    return plan;
  }
  // missingFacts counts days without (monetary-aware) facts for the first entity; storedFacts counts days that already hold
  // basic facts for it, i.e. the days an overwrite job would rewrite.
  function missingSummary(plan) {
    const total = daysBetween(plan.startDate, plan.endDate).length;
    const missingFor = (entityKey, monetary) => warehouse.missingDays(db, { ownerId: plan.ownerId, entityKey, startDate: plan.startDate, endDate: plan.endDate, monetary }).length;
    if (plan.kind === "channelDetail") {
      const key = `channel:${plan.channelId}`;
      return { missingFacts: missingFor(key, plan.monetary), storedFacts: total - missingFor(key, false) };
    }
    const missing = {};
    for (const scope of plan.scopes) missing[scope] = missingFor(`owner:${scope}`, plan.monetary);
    const first = plan.scopes[0];
    return { missingFacts: missing[first] ?? 0, missingFactsByScope: missing, storedFacts: first ? total - missingFor(`owner:${first}`, false) : 0 };
  }
  function channelCoverageByDay(plan, channels, group) {
    const monetary = group === "money" ? " AND monetary=1" : "";
    const rows = plan.channelMode === "selected"
      ? db.prepare(`SELECT day,COUNT(*) AS n FROM analytic_day_coverage WHERE owner_id=? AND kind='facts' AND entity_key IN (${channels.map(() => "?").join(",")}) AND day BETWEEN ? AND ?${monetary} GROUP BY day`)
        .all(plan.ownerId, ...channels.map((id) => `channel:${id}`), plan.startDate, plan.endDate)
      : db.prepare(`SELECT day,COUNT(*) AS n FROM analytic_day_coverage WHERE owner_id=? AND kind='facts' AND entity_key LIKE 'channel:%' AND day BETWEEN ? AND ?${monetary} GROUP BY day`)
        .all(plan.ownerId, plan.startDate, plan.endDate);
    return new Map(rows.map((row) => [row.day, row.n]));
  }
  // Request estimate: owner facts per scope (pages of 200 rows), channel batches per missing day, with-day breakdowns per
  // 90-day chunk times expected pages, per-day country/sharing shapes, range snapshots plus metadata, Data API pages.
  function estimate(plan, channels) {
    const days = daysBetween(plan.startDate, plan.endDate); const n = days.length; const money = plan.monetary ? 1 : 0;
    const pages = Math.max(1, Math.ceil(n / PAGE_SIZE));
    const breakdown = { inventory: 0, ownerFacts: 0, channelFacts: 0, breakdowns: 0, perDay: 0, snapshots: 0, videoMetadata: 0 };
    if (plan.kind === "channelDetail") {
      breakdown.ownerFacts = pages * (1 + money);
      breakdown.snapshots = CHANNEL_SNAPSHOT_REPORTS.length - (money ? 0 : 1);
      breakdown.videoMetadata = 4 * (1 + money);
    } else {
      breakdown.inventory = Math.max(1, Math.ceil(activeChannelIds(db, plan.ownerId).length / 50));
      breakdown.ownerFacts = plan.scopes.length * pages * (1 + money);
      if (channels.length) {
        const basic = channelCoverageByDay(plan, channels, "basic"); const monetaryCovered = money ? channelCoverageByDay(plan, channels, "money") : null;
        for (const day of days) {
          const missingBasic = plan.mode === "overwrite" ? channels.length : Math.max(0, channels.length - (basic.get(day) || 0));
          const missingMoney = !money ? 0 : plan.mode === "overwrite" ? channels.length : Math.max(0, channels.length - (monetaryCovered.get(day) || 0));
          breakdown.channelFacts += Math.ceil(missingBasic / plan.batch) + Math.ceil(missingMoney / plan.batch);
        }
      }
      if (plan.includeBreakdowns) {
        const chunks = Math.ceil(n / BREAKDOWN_CHUNK_DAYS); const chunkPages = Math.max(1, Math.ceil(Math.min(n, BREAKDOWN_CHUNK_DAYS) * 6 / PAGE_SIZE));
        breakdown.breakdowns = plan.scopes.length * chunks * chunkPages * (WITH_DAY_DIMENSIONS.length + 1 + 2 * money);
        for (const scope of plan.scopes) {
          const key = `owner:${scope}`; const args = { ownerId: plan.ownerId, entityKey: key, startDate: plan.startDate, endDate: plan.endDate };
          const country = plan.mode === "overwrite" ? n : warehouse.missingDays(db, { ...args, kind: "breakdown:country" }).length;
          const countryMoney = !money ? 0 : plan.mode === "overwrite" ? n : warehouse.missingDays(db, { ...args, kind: "breakdown:country", monetary: true }).length;
          const sharing = plan.mode === "overwrite" ? n : warehouse.missingDays(db, { ...args, kind: "breakdown:sharingService" }).length;
          breakdown.perDay += country + countryMoney + sharing;
        }
      }
      if (plan.includeSnapshots) {
        const ranges = SNAPSHOT_PRESETS.length + (plan.kind === "full" && !SNAPSHOT_PRESETS.includes(n) ? 1 : 0);
        breakdown.snapshots = ranges * (2 + money);
        breakdown.videoMetadata = 4 * (1 + money);
      }
    }
    return { estimate: Object.values(breakdown).reduce((sum, value) => sum + value, 0), breakdown };
  }
  function publicPlan(plan) {
    const { channelIds: _ids, ...rest } = plan;
    return rest;
  }

  // ---- request plumbing -----------------------------------------------------------------------
  async function paceRequest(signal) {
    if (pacing.minDelayMs) {
      const jitter = pacing.jitterMs ? Math.round((Math.random() * 2 - 1) * pacing.jitterMs) : 0;
      const wait = lastRequestAt + pacing.minDelayMs + jitter - Date.now();
      if (wait > 0) await sleep(wait, signal);
    }
    lastRequestAt = Date.now();
  }
  // A row that is no longer `running` was taken over elsewhere (cancel, restart recovery of another process): stop, never resurrect it.
  function checkCancelled(ctx) {
    const row = db.prepare("SELECT cancel_requested,status FROM analytic_jobs WHERE id=?").get(ctx.id);
    if (ctx.signal?.aborted || !row || row.cancel_requested || row.status !== "running") throw cancelledError();
  }
  function progress(ctx) {
    ctx.requests += 1;
    if (ctx.current) ctx.current.requests += 1;
    db.prepare("UPDATE analytic_jobs SET completed=?,total=?,updated_at=? WHERE id=?").run(ctx.requests, Math.max(ctx.planned, ctx.requests), at(), ctx.id);
  }
  async function get(ctx, url, { params }) {
    checkCancelled(ctx);
    await paceRequest(ctx.signal);
    try { return await core.googleGet(url, { params, owner: ctx.owner, signal: ctx.signal }); }
    finally { progress(ctx); }
  }
  // Paginated report table -> array of { header: value } rows; stops at a short page or `rowLimit` rows.
  async function table(ctx, params, { rowLimit = Infinity } = {}) {
    const rows = []; let startIndex = 1; let headers = null;
    for (;;) {
      const data = await get(ctx, ANALYTICS_URL, { params: { ...params, startIndex } });
      if (!Array.isArray(data?.columnHeaders)) throw errorWithStatus("Google returned an invalid report table.", 502, "invalidTable");
      headers = headers || data.columnHeaders;
      const page = Array.isArray(data.rows) ? data.rows : [];
      for (const raw of page) {
        if (!Array.isArray(raw) || raw.length !== headers.length) throw errorWithStatus("Google returned invalid report rows.", 502, "invalidRows");
        rows.push(Object.fromEntries(headers.map((header, index) => [header.name, raw[index]])));
      }
      if (page.length < (params.maxResults || PAGE_SIZE) || rows.length >= rowLimit) return rows;
      if (rows.length >= 200000) throw errorWithStatus("Report exceeds the interactive row limit.", 422, "interactiveRowLimit");
      startIndex += page.length;
    }
  }
  function baseParams(ctx, { startDate, endDate, metrics, dimensions, filters, sort, maxResults = PAGE_SIZE }) {
    return { ids: `contentOwner==${ctx.ownerId}`, startDate, endDate, metrics, dimensions, filters, ...(sort ? { sort } : {}), currency: "USD", includeHistoricalChannelData: false, maxResults };
  }

  // ---- steps, counters, breaker ---------------------------------------------------------------
  function startStep(ctx, id, label, extra = {}) {
    const step = { id, label, status: "running", monetary: false, ...extra, requests: 0, ...emptyCounts(), failures: 0, successes: 0, error: null, note: null, skippedShapes: [] };
    ctx.steps.push(step); ctx.current = step;
    db.prepare("UPDATE analytic_jobs SET current_report=?,result_json=?,updated_at=? WHERE id=?").run(id, JSON.stringify(partialResult(ctx)), at(), ctx.id);
    return step;
  }
  function finishStep(ctx, step, status, note) {
    // Nothing ran because every shape was skipped (open breaker, revenue scope refused): the step is skipped, not completed.
    const idle = !step.successes && (step.skippedShapes.length || (step.monetary && ctx.moneySkipped));
    step.status = status || (step.failures ? (step.successes ? "partial" : "failed") : idle ? "skipped" : "completed");
    if (idle && ctx.moneySkipped && step.monetary && !note && !step.note) step.note = MONEY_SCOPE_NOTE;
    if (note) step.note = note;
    ctx.current = null;
    db.prepare("UPDATE analytic_jobs SET result_json=?,errors_json=?,updated_at=? WHERE id=?").run(JSON.stringify(partialResult(ctx)), JSON.stringify(ctx.errors), at(), ctx.id);
  }
  function apply(ctx, step, counters) {
    for (const key of Object.keys(emptyCounts())) { step[key] += counters[key] || 0; ctx.counts[key] += counters[key] || 0; }
    return counters;
  }
  function partialResult(ctx) {
    return { counts: { ...ctx.counts, failed: ctx.errors.length }, requests: ctx.requests, plan: ctx.plan ? publicPlan(ctx.plan) : null, steps: ctx.steps, notes: ctx.notes, watermark: ctx.watermark };
  }
  function fatal(error) {
    const detail = core.safeError(error);
    const wrapped = errorWithStatus(detail.message, detail.status, CONNECTION_REASONS.has(detail.reason) ? "cmsNotConnected" : detail.reason);
    wrapped.fatal = true;
    return wrapped;
  }
  // The token has no revenue scope: skip every remaining MONEY request of this job with one note instead of failing it.
  function skipMoney(ctx, step, shape, day) {
    if (!ctx.moneySkipped) { ctx.moneySkipped = true; ctx.notes.push(MONEY_SCOPE_NOTE); }
    if (!step.note) step.note = MONEY_SCOPE_NOTE;
    if (!step.skippedShapes.some((entry) => entry.shape === shape)) step.skippedShapes.push({ shape, firstFailedDay: day });
  }
  // Runs one request shape; transient failures are recorded per step and open the breaker after three in a row.
  async function guarded(ctx, step, shape, fn, { day = null, monetary = false } = {}) {
    const state = ctx.breaker.get(shape) || { failures: 0, open: false, firstFailedDay: null };
    ctx.breaker.set(shape, state);
    if (monetary && ctx.moneySkipped) { skipMoney(ctx, step, shape, day); return null; }
    if (state.open) {
      if (!step.skippedShapes.some((entry) => entry.shape === shape)) step.skippedShapes.push({ shape, firstFailedDay: state.firstFailedDay });
      return null;
    }
    try { const result = await fn(); state.failures = 0; step.successes += 1; return result; }
    catch (error) {
      const kind = classifyError(error);
      if (kind === "cancelled") throw error;
      if (monetary && isScopeRefusal(error)) { skipMoney(ctx, step, shape, day); return null; }
      if (kind === "fatal") throw fatal(error);
      const detail = core.safeError(error);
      ctx.errors.push({ reportId: step.id, shape, day, monetary, message: detail.message, reason: detail.reason, status: detail.status });
      step.failures += 1; if (!step.error) step.error = detail.message;
      state.failures += 1; if (state.firstFailedDay == null) state.firstFailedDay = day;
      if (state.failures >= BREAKER_THRESHOLD) { state.open = true; step.skippedShapes.push({ shape, firstFailedDay: state.firstFailedDay }); }
      db.prepare("UPDATE analytic_jobs SET errors_json=?,updated_at=? WHERE id=?").run(JSON.stringify(ctx.errors), at(), ctx.id);
      return null;
    }
  }
  function referenceWatermark(ctx) {
    const first = ctx.plan.scopes[0];
    const basic = ctx.watermark[first]?.basic || ctx.plan.scopes.map((scope) => ctx.watermark[scope]?.basic).find(Boolean) || null;
    const money = ctx.watermark[first]?.money || ctx.plan.scopes.map((scope) => ctx.watermark[scope]?.money).find(Boolean) || null;
    return { basic, money };
  }
  // refreshProvisional: the last `settleDays` days of the window are rewritten in overwrite mode (through the ledger); older days stay append-only.
  function provisionalFrom(plan) { return plan.refreshProvisional && plan.settleDays > 0 ? addDays(plan.endDate, -(plan.settleDays - 1)) : null; }
  function modeParts(plan, rows, days = []) {
    const from = provisionalFrom(plan);
    if (!from) return [{ mode: plan.mode, rows, days }];
    return [{ mode: plan.mode, rows: rows.filter((row) => row.day < from), days: days.filter((day) => day < from) },
      { mode: "overwrite", rows: rows.filter((row) => row.day >= from), days: days.filter((day) => day >= from) }];
  }
  function maxDay(rows) { return rows.reduce((max, row) => (row.day > max ? row.day : max), ""); }

  // ---- step 2: inventory ----------------------------------------------------------------------
  async function inventoryStep(ctx) {
    const step = startStep(ctx, "inventory", "Channel inventory");
    try {
      const result = await fetchInventory({ db, get: (url, options) => get(ctx, url, options), owner: ctx.owner, now: now(), signal: ctx.signal });
      step.successes += 1;
      finishStep(ctx, step, "completed", `${result.count} channels listed, ${result.added} added, ${result.removed} removed, ${result.restored} restored`);
    } catch (error) {
      if (classifyError(error) === "cancelled") throw error;
      // Data API quota (403), rate limit and 5xx are not Analytics problems: warn and keep yesterday's inventory.
      if (isCredentialError(error)) throw fatal(error);
      const detail = core.safeError(error);
      ctx.errors.push({ reportId: step.id, shape: "inventory", day: null, monetary: false, message: detail.message, reason: detail.reason, status: detail.status });
      step.failures += 1; step.error = detail.message;
      const stored = activeChannelIds(db, ctx.ownerId).length;
      finishStep(ctx, step, stored ? "warning" : "failed", stored ? `The channel listing failed; continuing with ${stored} stored channels` : "The channel listing failed and no stored channels exist");
    }
  }

  // ---- step 3: owner facts per scope -----------------------------------------------------------
  async function ownerFactsStep(ctx, scope) {
    const plan = ctx.plan; const key = `owner:${scope}`;
    const step = startStep(ctx, `ownerFacts:${scope}`, `Owner facts (${scope})`, { scope });
    const watermark = ctx.watermark[scope] = { basic: null, money: null, empty: { basic: false, money: false }, failed: { basic: false, money: false } };
    const existing = new Set(db.prepare("SELECT day FROM analytic_daily_facts WHERE owner_id=? AND entity_key=? AND day BETWEEN ? AND ?").all(ctx.ownerId, key, plan.startDate, plan.endDate).map((row) => row.day));
    for (const group of plan.monetary ? ["basic", "money"] : ["basic"]) {
      const monetary = group === "money";
      const rows = await guarded(ctx, step, `${scope}|facts|${group}`, () => table(ctx, baseParams(ctx, { startDate: plan.startDate, endDate: plan.endDate,
        metrics: monetary ? MONEY_METRICS : BASIC_METRICS, dimensions: "day", filters: SCOPE_FILTERS[scope], sort: "day" })), { monetary });
      if (!rows) { watermark.failed[group] = true; continue; }
      if (!rows.length) { watermark.empty[group] = true; continue; }
      watermark[group] = maxDay(rows);
      db.transaction(() => {
        for (const part of modeParts(plan, rows)) {
          if (!part.rows.length) continue;
          apply(ctx, step, warehouse.writeFacts(db, { ownerId: ctx.ownerId, entityKey: key, rows: part.rows.map(({ day, ...metrics }) => ({ day, metrics })), mode: part.mode, source: plan.kind, jobId: ctx.id, monetary, now: now() }));
        }
      })();
      if (scope === plan.scopes[0] && !monetary) for (const row of rows) if (!existing.has(row.day)) ctx.addedDays.add(row.day);
    }
    finishStep(ctx, step);
  }
  // Coverage for every day up to the watermark, including zero-row days; empty scopes borrow the first non-empty scope's
  // watermark. Monetary coverage is never marked beyond the basic watermark (a coverage row means the basic facts exist).
  function coverOwnerScopes(ctx) {
    const plan = ctx.plan;
    for (const scope of plan.scopes) {
      const watermark = ctx.watermark[scope];
      for (const group of ["basic", "money"]) {
        if (watermark.empty[group] && !watermark[group]) watermark[group] = plan.scopes.map((other) => ctx.watermark[other]?.[group]).find(Boolean) || null;
        const limit = group === "money" ? (watermark.money && watermark.basic ? minDay(watermark.money, watermark.basic) : null) : watermark.basic;
        if (!limit) continue;
        const days = daysBetween(plan.startDate, plan.endDate).filter((day) => day <= limit);
        warehouse.markCoverage(db, { ownerId: ctx.ownerId, entityKey: `owner:${scope}`, days, kind: "facts", monetary: group === "money", jobId: ctx.id, now: now() });
      }
    }
  }

  // ---- step 4: channel facts per day ------------------------------------------------------------
  function channelCoverageFor(ctx, day, channels) {
    const rows = db.prepare("SELECT entity_key,monetary FROM analytic_day_coverage WHERE owner_id=? AND kind='facts' AND day=? AND entity_key LIKE 'channel:%'").all(ctx.ownerId, day);
    const covered = new Map(rows.map((row) => [row.entity_key.slice("channel:".length), row.monetary]));
    return { basic: channels.filter((id) => !covered.has(id)), money: channels.filter((id) => !covered.get(id)) };
  }
  async function channelFactsStep(ctx, channels) {
    const plan = ctx.plan;
    const step = startStep(ctx, "channelFacts", "Channel facts");
    const reference = referenceWatermark(ctx);
    if (!channels.length) { finishStep(ctx, step, "skipped", "No channels to request"); return; }
    if (!reference.basic) { finishStep(ctx, step, "skipped", "No owner rows were returned for the range; YouTube has not published these days yet"); return; }
    for (const day of daysBetween(plan.startDate, plan.endDate).filter((day) => day <= reference.basic)) {
      const missing = plan.mode === "overwrite" ? { basic: channels, money: channels } : channelCoverageFor(ctx, day, channels);
      // Revenue is requested only for channels whose basic facts are covered (already stored or fetched by this run).
      const basicCovered = new Set(channels.filter((id) => !missing.basic.includes(id)));
      const groups = [["basic", missing.basic, BASIC_METRICS]];
      if (plan.monetary && reference.money && day <= reference.money) groups.push(["money", missing.money, MONEY_METRICS]);
      for (const [group, candidates, metrics] of groups) {
        const monetary = group === "money";
        const ids = monetary ? candidates.filter((id) => basicCovered.has(id)) : candidates;
        for (let offset = 0; offset < ids.length; offset += plan.batch) {
          const chunk = ids.slice(offset, offset + plan.batch);
          await guarded(ctx, step, `channels|facts|${group}`, async () => {
            const rows = await table(ctx, baseParams(ctx, { startDate: day, endDate: day, metrics, dimensions: "channel", filters: `channel==${chunk.join(",")}`,
              sort: monetary ? "" : "-views", maxResults: chunk.length }), { rowLimit: chunk.length });
            const allowed = new Set(chunk);
            db.transaction(() => {
              for (const { channel, ...rowMetrics } of rows) {
                if (!allowed.has(channel)) continue;
                apply(ctx, step, warehouse.writeFacts(db, { ownerId: ctx.ownerId, entityKey: `channel:${channel}`, rows: [{ day, metrics: rowMetrics }], mode: plan.mode, source: plan.kind, jobId: ctx.id, monetary, now: now() }));
              }
              for (const id of chunk) warehouse.markCoverage(db, { ownerId: ctx.ownerId, entityKey: `channel:${id}`, days: [day], kind: "facts", monetary, jobId: ctx.id, now: now() });
            })();
            if (!monetary) for (const id of chunk) basicCovered.add(id);
          }, { day, monetary });
        }
      }
    }
    finishStep(ctx, step);
  }

  // ---- step 5: breakdowns (owner scopes only) ----------------------------------------------------
  function breakdownRows(rows, dimension) {
    return rows.map(({ day, [dimension]: value, ...metrics }) => ({ day, value: String(value ?? ""), metrics }));
  }
  // Returns true when every chunk succeeded, so a monetary pass only follows a complete basic pass.
  async function withDayBreakdown(ctx, step, scope, dimension, metrics, group) {
    const plan = ctx.plan; const monetary = group === "money"; const watermark = ctx.watermark[scope]?.[group];
    if (!watermark) return false;
    const end = minDay(plan.endDate, watermark);
    let complete = true;
    for (const chunk of chunkRange(plan.startDate, end, BREAKDOWN_CHUNK_DAYS)) {
      const ok = await guarded(ctx, step, `${scope}|${dimension}|${group}`, async () => {
        const rows = await table(ctx, baseParams(ctx, { ...chunk, metrics, dimensions: `${dimension},day`, filters: SCOPE_FILTERS[scope], sort: "day" }));
        const parsed = breakdownRows(rows, dimension);
        db.transaction(() => {
          for (const part of modeParts(plan, parsed, daysBetween(chunk.startDate, chunk.endDate))) {
            apply(ctx, step, warehouse.writeBreakdowns(db, { ownerId: ctx.ownerId, entityKey: `owner:${scope}`, dimension, rows: part.rows, mode: part.mode, source: plan.kind, jobId: ctx.id, monetary, now: now(), coveredDays: part.days, metricKeys: metrics.split(",") }));
          }
        })();
        return true;
      }, { day: chunk.startDate, monetary });
      if (!ok) complete = false;
    }
    return complete;
  }
  async function perDayBreakdown(ctx, step, scope, dimension, metrics, group, sort) {
    const plan = ctx.plan; const monetary = group === "money"; const watermark = ctx.watermark[scope]?.[group]; const key = `owner:${scope}`;
    if (!watermark || (monetary && !ctx.watermark[scope]?.basic)) return;
    const end = minDay(plan.endDate, monetary ? minDay(watermark, ctx.watermark[scope].basic) : watermark);
    const args = { ownerId: ctx.ownerId, entityKey: key, startDate: plan.startDate, endDate: end, kind: `breakdown:${dimension}` };
    const uncovered = new Set(warehouse.missingDays(db, args));
    // Basic: every day without coverage (all days in overwrite mode); money: days with basic coverage but no monetary coverage
    // (in overwrite mode every day with basic coverage, so the user's overwrite also refreshes revenue by country).
    const days = monetary ? (plan.mode === "overwrite" ? daysBetween(plan.startDate, end) : warehouse.missingDays(db, { ...args, monetary: true })).filter((day) => !uncovered.has(day))
      : plan.mode === "overwrite" ? daysBetween(plan.startDate, end) : [...uncovered];
    for (const day of days) {
      await guarded(ctx, step, `${scope}|${dimension}|${group}`, async () => {
        const rows = await table(ctx, baseParams(ctx, { startDate: day, endDate: day, metrics, dimensions: dimension, filters: SCOPE_FILTERS[scope], sort }));
        const parsed = breakdownRows(rows.map((row) => ({ ...row, day })), dimension);
        apply(ctx, step, warehouse.writeBreakdowns(db, { ownerId: ctx.ownerId, entityKey: key, dimension, rows: parsed, mode: plan.mode, source: plan.kind, jobId: ctx.id, monetary, now: now(), coveredDays: [day], metricKeys: metrics.split(",") }));
      }, { day, monetary });
    }
  }
  async function breakdownsStep(ctx) {
    const plan = ctx.plan;
    for (const dimension of WITH_DAY_DIMENSIONS) {
      const step = startStep(ctx, `breakdown:${dimension}`, `Breakdown by ${dimension}`, { dimension });
      for (const scope of plan.scopes) await withDayBreakdown(ctx, step, scope, dimension, WATCH_METRICS, "basic");
      finishStep(ctx, step);
    }
    const contentType = startStep(ctx, "breakdown:creatorContentType", "Breakdown by creatorContentType", { dimension: "creatorContentType" });
    for (const scope of plan.scopes) {
      const complete = await withDayBreakdown(ctx, contentType, scope, "creatorContentType", BASIC_METRICS, "basic");
      if (plan.monetary && complete) await withDayBreakdown(ctx, contentType, scope, "creatorContentType", MONEY_METRICS, "money");
    }
    finishStep(ctx, contentType);
    if (plan.monetary) {
      const adType = startStep(ctx, "breakdown:adType", "Breakdown by adType", { dimension: "adType", monetary: true });
      for (const scope of plan.scopes) await withDayBreakdown(ctx, adType, scope, "adType", AD_METRICS, "money");
      finishStep(ctx, adType);
    }
    const country = startStep(ctx, "breakdown:country", "Breakdown by country", { dimension: "country" });
    for (const scope of plan.scopes) {
      await perDayBreakdown(ctx, country, scope, "country", COUNTRY_METRICS, "basic", "-views");
      if (plan.monetary) await perDayBreakdown(ctx, country, scope, "country", MONEY_METRICS, "money", "-estimatedRevenue");
    }
    finishStep(ctx, country);
    const sharing = startStep(ctx, "breakdown:sharingService", "Breakdown by sharingService", { dimension: "sharingService" });
    for (const scope of plan.scopes) await perDayBreakdown(ctx, sharing, scope, "sharingService", "shares", "basic", "-shares");
    finishStep(ctx, sharing);
  }

  // ---- step 6: range snapshots through the legacy snapshot machinery -----------------------------
  async function snapshotReport(ctx, step, selection, reportId, videoIds) {
    const report = catalogReport(reportId);
    await guarded(ctx, step, `snapshot|${reportId}`, async () => {
      checkCancelled(ctx);
      await paceRequest(ctx.signal);
      try {
        const result = await core.executeReport(selection, report, ctx.owner, ctx.signal);
        for (const row of result.rows || []) if (row.video) videoIds.add(row.video);
      } finally { progress(ctx); }
    }, { day: selection.startDate, monetary: !!report.monetary });
  }
  async function videoMetadata(ctx, step, videoIds) {
    // The estimate assumed a full top-video page per report; now the unique ids are known, so the planned total is reconciled
    // with the 50-id Data API calls that are really sent and completed/total reaches the total naturally.
    const calls = Math.ceil(videoIds.size / 50);
    ctx.planned = Math.max(1, ctx.requests, ctx.planned - (ctx.plan.requests?.breakdown?.videoMetadata || 0) + calls);
    db.prepare("UPDATE analytic_jobs SET total=?,updated_at=? WHERE id=?").run(Math.max(ctx.planned, ctx.requests), at(), ctx.id);
    if (!videoIds.size) return;
    await guarded(ctx, step, "snapshot|videoMetadata", async () => {
      checkCancelled(ctx);
      await paceRequest(ctx.signal);
      try { await core.syncVideoMetadata(ctx.owner, [...videoIds], ctx.signal); }
      finally { for (let i = 0; i < Math.ceil(videoIds.size / 50); i += 1) progress(ctx); }
    });
  }
  // Owner-scope range snapshots older than the grace window are pruned when a newer run of the same range length superseded
  // them (presets); a custom range (a user's "Sync all") is kept for CUSTOM_SNAPSHOT_KEEP_DAYS after it was stored.
  function pruneSnapshots(ctx, scope, end) {
    const cutoff = addDays(end, -SNAPSHOT_GRACE_DAYS);
    const keepSince = toDate(now()).getTime() - CUSTOM_SNAPSHOT_KEEP_DAYS * DAY;
    const rows = db.prepare(`SELECT snapshot_key,report_id,start_date,end_date,updated_at,selection_json FROM analytic_snapshots WHERE owner_id=? AND report_id IN (${OWNER_SNAPSHOT_REPORTS.map(() => "?").join(",")})`)
      .all(ctx.ownerId, ...OWNER_SNAPSHOT_REPORTS).filter((row) => {
        const selection = parseJson(row.selection_json, null);
        return selection && selection.scope === scope && !selection.channelId && !selection.videoId && !selection.country;
      });
    const length = (row) => daysBetween(row.start_date, row.end_date).length;
    const superseded = (row) => SNAPSHOT_PRESETS.includes(length(row)) && rows.some((other) => other.report_id === row.report_id && other.end_date > row.end_date && length(other) === length(row));
    const storedAt = (row) => Date.parse(String(row.updated_at || "").includes("T") ? row.updated_at : `${String(row.updated_at || "").replace(" ", "T")}Z`) || 0;
    db.transaction(() => {
      for (const row of rows) {
        if (row.end_date >= cutoff) continue;
        if (!superseded(row) && (SNAPSHOT_PRESETS.includes(length(row)) || storedAt(row) >= keepSince)) continue;
        db.prepare("DELETE FROM analytic_snapshots WHERE snapshot_key=?").run(row.snapshot_key);
        db.prepare("DELETE FROM analytic_attempts WHERE snapshot_key=?").run(row.snapshot_key);
      }
    })();
  }
  async function snapshotsStep(ctx) {
    const plan = ctx.plan;
    const step = startStep(ctx, "snapshots", "Range reports");
    const reference = referenceWatermark(ctx).basic;
    if (!reference) { finishStep(ctx, step, "skipped", "No published days to request"); return; }
    const end = minDay(plan.endDate, reference);
    const ranges = SNAPSHOT_PRESETS.map((length) => ({ startDate: addDays(end, -(length - 1)), endDate: end }));
    if (plan.kind === "full" && !ranges.some((range) => range.startDate === plan.startDate && range.endDate === plan.endDate)) ranges.push({ startDate: plan.startDate, endDate: plan.endDate });
    const reports = OWNER_SNAPSHOT_REPORTS.filter((id) => plan.monetary || !catalogReport(id).monetary);
    const videoIds = new Set();
    for (const range of ranges) {
      let selection;
      try { selection = core.normalizeSelection({ ownerId: ctx.ownerId, startDate: range.startDate, endDate: range.endDate, scope: plan.scopes[0] }, ctx.owner); }
      catch (error) { ctx.errors.push({ reportId: step.id, shape: "snapshot|range", day: range.startDate, monetary: false, ...core.safeError(error) }); step.failures += 1; continue; }
      for (const id of reports) await snapshotReport(ctx, step, selection, id, videoIds);
    }
    await videoMetadata(ctx, step, videoIds);
    pruneSnapshots(ctx, plan.scopes[0], end);
    finishStep(ctx, step);
  }

  // ---- channelDetail: facts for one channel + the pinned channel snapshots ------------------------
  async function channelDetailJob(ctx) {
    const plan = ctx.plan; const key = `channel:${plan.channelId}`;
    const step = startStep(ctx, "channelFacts", "Channel facts");
    const fallback = warehouse.latestCoveredDay(db, ctx.ownerId, "owner:");
    for (const group of plan.monetary ? ["basic", "money"] : ["basic"]) {
      const monetary = group === "money";
      if (monetary && !ctx.watermark.channel?.basic) break;
      const rows = await guarded(ctx, step, `channel|facts|${group}`, () => table(ctx, baseParams(ctx, { startDate: plan.startDate, endDate: plan.endDate,
        metrics: monetary ? MONEY_METRICS : BASIC_METRICS, dimensions: "day", filters: `channel==${plan.channelId}`, sort: "day" })), { monetary });
      if (!rows) continue;
      // An empty channel response cannot tell "no activity" from "not published": cover only days the owner facts already proved published.
      const published = rows.length ? maxDay(rows) : fallback ? minDay(plan.endDate, fallback) : null;
      const watermark = monetary ? (published ? minDay(published, ctx.watermark.channel.basic) : null) : published;
      ctx.watermark.channel = { ...(ctx.watermark.channel || {}), [group]: watermark };
      db.transaction(() => {
        apply(ctx, step, warehouse.writeFacts(db, { ownerId: ctx.ownerId, entityKey: key, rows: rows.map(({ day, ...metrics }) => ({ day, metrics })), mode: "append", source: "channelDetail", jobId: ctx.id, monetary, now: now() }));
        if (watermark) warehouse.markCoverage(db, { ownerId: ctx.ownerId, entityKey: key, days: daysBetween(plan.startDate, plan.endDate).filter((day) => day <= watermark), kind: "facts", monetary, jobId: ctx.id, now: now() });
      })();
      for (const row of rows) ctx.addedDays.add(row.day);
    }
    finishStep(ctx, step);
    const snapshots = startStep(ctx, "snapshots", "Channel reports");
    let selection;
    try { selection = core.normalizeSelection({ ownerId: ctx.ownerId, startDate: plan.startDate, endDate: plan.endDate, scope: "self", channelId: plan.channelId }, ctx.owner); }
    catch (error) { ctx.errors.push({ reportId: snapshots.id, shape: "snapshot|range", day: plan.startDate, monetary: false, ...core.safeError(error) }); snapshots.failures += 1; finishStep(ctx, snapshots); return; }
    const videoIds = new Set();
    for (const id of CHANNEL_SNAPSHOT_REPORTS.filter((report) => plan.monetary || !catalogReport(report).monetary)) await snapshotReport(ctx, snapshots, selection, id, videoIds);
    await videoMetadata(ctx, snapshots, videoIds);
    finishStep(ctx, snapshots);
  }

  // ---- finish: status, result, retention, log line ------------------------------------------------
  function daysCovered(ctx) {
    const key = ctx.plan.kind === "channelDetail" ? `channel:${ctx.plan.channelId}` : `owner:${ctx.plan.scopes[0]}`;
    return db.prepare("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE owner_id=? AND entity_key=? AND kind='facts' AND day BETWEEN ? AND ?").get(ctx.ownerId, key, ctx.plan.startDate, ctx.plan.endDate).n;
  }
  function channelsCovered(ctx, channels) {
    const reference = ctx.plan.kind === "channelDetail" ? ctx.watermark.channel?.basic : referenceWatermark(ctx).basic;
    if (!channels.length || !reference) return 0;
    const needed = daysBetween(ctx.plan.startDate, ctx.plan.endDate).filter((day) => day <= reference).length;
    const planned = new Set(channels.map((id) => `channel:${id}`));
    return db.prepare("SELECT entity_key FROM analytic_day_coverage WHERE owner_id=? AND kind='facts' AND entity_key LIKE 'channel:%' AND day BETWEEN ? AND ? GROUP BY entity_key HAVING COUNT(*)>=?")
      .all(ctx.ownerId, ctx.plan.startDate, ctx.plan.endDate, needed).filter((row) => planned.has(row.entity_key)).length;
  }
  function retention(ctx) {
    const nowDate = toDate(now());
    warehouse.pruneHistory(db, { now: nowDate });
    if (ctx.plan.kind !== "daily") return;
    const cutoff = new Date(nowDate.getTime() - JOB_RETENTION_DAYS * DAY).toISOString();
    db.prepare(`DELETE FROM analytic_jobs WHERE id IN (SELECT id FROM (SELECT id,created_at,status,ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY created_at DESC,rowid DESC) AS rn FROM analytic_jobs)
      WHERE rn>? AND created_at<? AND status NOT IN ('queued','running'))`).run(JOBS_KEPT_PER_OWNER, cutoff);
    db.pragma("wal_checkpoint(TRUNCATE)");
  }
  function finish(ctx, status, channels, startedAt) {
    const drifted = db.prepare("SELECT DISTINCT day FROM analytic_daily_history WHERE job_id=? AND action='drift' ORDER BY day").all(ctx.id).map((row) => row.day);
    const added = [...ctx.addedDays].sort();
    const result = { ...partialResult(ctx), status, days: { requested: ctx.plan.days.requested, covered: daysCovered(ctx), added: added.slice(0, RESULT_DAY_LIMIT), addedCount: added.length,
      drifted: drifted.slice(0, RESULT_DAY_LIMIT), driftedCount: drifted.length }, channels: { planned: channels.length, covered: channelsCovered(ctx, channels) }, finishedAt: at() };
    const completed = ["completed", "partial"].includes(status) ? Math.max(ctx.planned, ctx.requests) : ctx.requests;
    // Only a row still `running` is finished here: a job cancelled or marked interrupted elsewhere is never resurrected.
    const changes = db.prepare("UPDATE analytic_jobs SET status=?,completed=?,total=?,current_report=NULL,errors_json=?,result_json=?,finished_at=?,updated_at=? WHERE id=? AND status='running'")
      .run(status, completed, Math.max(ctx.planned, ctx.requests), JSON.stringify(ctx.errors), JSON.stringify(result), result.finishedAt, result.finishedAt, ctx.id).changes;
    if (!changes) log(`[analytics] job=${ctx.id} ended ${status} but its row was no longer running; left untouched`);
    try { retention(ctx); } catch (error) { log(`[analytics] job=${ctx.id} retention failed: ${core.safeError(error).message}`); }
    log(`[analytics] job=${ctx.id} kind=${ctx.plan.kind} owner=${ctx.ownerId} status=${status} inserted=${ctx.counts.inserted} updated=${ctx.counts.updated} enriched=${ctx.counts.enriched} drift=${ctx.counts.drift} requests=${ctx.requests} ms=${Date.now() - startedAt}`);
    return result;
  }
  function claim(id) {
    return db.prepare("UPDATE analytic_jobs SET status='running',started_at=?,updated_at=? WHERE id=? AND status='queued'").run(at(), at(), id).changes === 1;
  }
  function failRun(ctx, error) {
    const detail = core.safeError(error);
    ctx.errors.push({ reportId: "job", shape: "job", day: null, monetary: false, message: detail.message, reason: error.fatal ? error.reason : detail.reason, status: detail.status });
    if (ctx.current) { ctx.current.status = "failed"; ctx.current.error = detail.message; ctx.current = null; }
  }
  async function runJob(row, { signal } = {}) {
    const startedAt = Date.now();
    const request = parseJson(row.request_json, {});
    if (!V2_KINDS.has(request.kind)) throw errorWithStatus("Unsupported job kind.");
    if (!claim(row.id)) return { claimed: false };
    const existing = parseJson(row.result_json, null);
    const ctx = { id: row.id, request, ownerId: request.ownerId, owner: null, signal, plan: null, planned: 1, requests: 0, steps: [], errors: [], counts: emptyCounts(),
      watermark: {}, breaker: new Map(), addedDays: new Set(), notes: Array.isArray(existing?.notes) ? existing.notes : [], current: null, moneySkipped: false };
    let channels = [];
    let status = "completed";
    try {
      ctx.owner = core.resolveOwner(request.ownerId);
      const schedule = request.kind === "daily" ? db.prepare("SELECT * FROM analytic_schedules WHERE owner_id=?").get(request.ownerId) : null;
      ctx.plan = planJob(request, { schedule, now: now() });
      ctx.planned = Math.max(1, ctx.plan.requests.estimate);
      db.prepare("UPDATE analytic_jobs SET total=?,result_json=?,updated_at=? WHERE id=?").run(ctx.planned, JSON.stringify(partialResult(ctx)), at(), ctx.id);
      if (request.kind === "channelDetail") {
        channels = [ctx.plan.channelId];
        await channelDetailJob(ctx);
      } else {
        await inventoryStep(ctx);
        channels = ctx.plan.channelMode === "none" ? [] : ctx.plan.channelMode === "selected" ? ctx.plan.channelIds : activeChannelIds(db, ctx.ownerId);
        for (const scope of ctx.plan.scopes) await ownerFactsStep(ctx, scope);
        coverOwnerScopes(ctx);
        if (ctx.plan.channelMode !== "none") await channelFactsStep(ctx, channels);
        if (ctx.plan.includeBreakdowns) await breakdownsStep(ctx);
        if (ctx.plan.includeSnapshots) await snapshotsStep(ctx);
      }
      const finished = ctx.steps.filter((step) => step.status !== "skipped");
      if (ctx.errors.length) status = finished.some((step) => step.successes > 0) ? "partial" : "failed";
      checkCancelled(ctx);
    } catch (error) {
      if (classifyError(error) === "cancelled") { status = "cancelled"; if (ctx.current) { ctx.current.status = "cancelled"; ctx.current = null; } }
      else { status = "failed"; failRun(ctx, error); }
    }
    if (!ctx.plan) {
      // resolveOwner/planJob failed before any request: a minimal plan keeps the result shape stable.
      ctx.plan = { kind: request.kind, startDate: request.startDate || null, endDate: request.endDate || null, scopes: request.scopes || [], channelId: request.channelId || null, days: { requested: 0 } };
      const finishedAt = at();
      const result = { ...partialResult(ctx), status, days: { requested: 0, covered: 0, added: [], addedCount: 0, drifted: [], driftedCount: 0 }, channels: { planned: 0, covered: 0 }, finishedAt };
      db.prepare("UPDATE analytic_jobs SET status=?,current_report=NULL,errors_json=?,result_json=?,finished_at=?,updated_at=? WHERE id=? AND status='running'")
        .run(status, JSON.stringify(ctx.errors), JSON.stringify(result), finishedAt, finishedAt, ctx.id);
      log(`[analytics] job=${ctx.id} kind=${request.kind} owner=${ctx.ownerId} status=${status} inserted=0 updated=0 enriched=0 drift=0 requests=0 ms=${Date.now() - startedAt}`);
      return { claimed: true, status, result };
    }
    return { claimed: true, status, result: finish(ctx, status, channels, startedAt) };
  }
  return { planJob, runJob, claim };
}

module.exports = { createSyncEngine, fetchInventory, applyInventory, activeChannelIds, classifyError, scheduleSettings, latestAllowedDay, pacificToday, bangkokToday,
  addDays, daysBetween, maxRequestsPerJob, channelBatchSize, effectiveLimits, V2_KINDS, SCOPES, DEFAULTS, LIMITS, BASIC_METRICS, MONEY_METRICS, WITH_DAY_DIMENSIONS, PER_DAY_DIMENSIONS,
  BREAKDOWN_DIMENSIONS, CHANNEL_SNAPSHOT_REPORTS, OWNER_SNAPSHOT_REPORTS, SNAPSHOT_PRESETS, BREAKER_THRESHOLD, JOB_RETENTION_DAYS, JOBS_KEPT_PER_OWNER };
