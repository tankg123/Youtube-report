// Read side of the Analytics module: every GET of /api/analytics is answered from the warehouse (daily facts,
// breakdowns, coverage, ledger), the range snapshots and the job/schedule tables. No Google calls, no writes.
// `core` (analyticsService) is injected only for owner resolution, snapshot reads, the public catalog and job
// sanitising, so the service can be exercised against the warehouse alone. Messages are English (the UI translates).
const path = require("path");
const { REPORT_CATALOG, BREAKDOWN_DIMENSIONS } = require("./analyticsCatalog");
const scheduleService = require("./analyticsScheduleService");
const engine = require("./analyticsSyncEngine");
const labels = require("./analyticsLabels");
const v = require("./analyticsValidate");

const DAY = 86400000;
const BANGKOK_OFFSET = 7 * 3600000;
const BREAKDOWN_LIMIT = 1000;
const BOM = String.fromCharCode(0xfeff);
const CSV_TYPE = "text/csv; charset=utf-8";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SNAPSHOT_READY = new Set(["ready", "empty", "stale"]);
const CHANNEL_NOT_FOUND = "Channel is not in this Content Owner's managed inventory. Refresh the channel inventory first.";
const SELECT_ONE_CHANNEL = "Select one channel or none for this export.";
const unknownChannelsMessage = (ids) => `Unknown channel IDs: ${ids.join(", ")}. Refresh the channel inventory or clear the channel filter.`;
// Export note when the ledger cap cut rows (bilingual here because the labels table is owned by the sync side).
const LEDGER_TRUNCATED = { en: "The ledger holds {total} entries in this range; only the newest {count} are exported. Shorten the range for the rest.",
  vi: "Nhật ký thay đổi có {total} mục trong khoảng này; chỉ {count} mục mới nhất được xuất. Hãy thu hẹp khoảng ngày để lấy phần còn lại." };
// A channel's breakdowns come from its pinned range snapshots (scope self, USD, no historical data).
const DIMENSION_SNAPSHOTS = { country: "countries", insightTrafficSourceType: "trafficSources", deviceType: "devices", operatingSystem: "operatingSystems",
  subscribedStatus: "subscribedStatus", creatorContentType: "contentTypes", insightPlaybackLocationType: "playbackLocations", youtubeProduct: "youtubeProducts" };
const BREAKDOWN_SORT_KEY = { sharingService: "shares", adType: "grossRevenue" };
const BASIC_KEYS = ["views", "engagedViews", "redViews", "estimatedMinutesWatched", "watchHours", "estimatedRedMinutesWatched", "averageViewDuration", "averageViewPercentage",
  "likes", "dislikes", "comments", "shares", "subscribersGained", "subscribersLost", "netSubscribers", "videosAddedToPlaylists", "videosRemovedFromPlaylists"];
const MONEY_KEYS = ["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "grossRevenue", "rpm", "monetizedPlaybacks", "playbackBasedCpm", "adImpressions", "cpm"];
const EXPORT_ORDER = new Map([...BASIC_KEYS, ...MONEY_KEYS].map((key, index) => [key, index]));
const TYPE_BY_KIND = { count: "int", minutes: "float", seconds: "float", ratio: "float", percent: "percent", money: "money", cpm: "money" };
const TEXT_SORT_KEYS = new Set(["title", "country", "publishedAt", "firstDay", "lastDay"]);
const INVENTORY_SELECT = "SELECT channel_id,title,thumbnail,country,published_at,subscriber_count,view_count,video_count,removed_at,updated_at FROM analytic_channels WHERE owner_id=?";
const DOCS = { contentOwnerReports: "https://developers.google.com/youtube/analytics/content_owner_reports", query: "https://developers.google.com/youtube/analytics/reference/reports/query",
  dataApi: "https://developers.google.com/youtube/v3/docs/channels/list" };
const NOTES = {
  missing: "Missing days have not been synced yet; they are not zero.",
  pending: "The most recent days are not published by YouTube yet.",
  drift: "YouTube now reports different numbers for some stored days; see the change ledger.",
  partialRevenue: "Revenue is stored for only part of this range.",
  approx: "Average view duration is approximated from minutes watched and engaged views.",
  channelsBreakdowns: "Breakdowns are stored per Content Owner; select one channel or none.",
  rangeReports: "Range reports (top videos, age and gender) exist only for ranges that were synced as a whole.",
  channelSnapshots: "Channel breakdowns come from the channel's range reports; sync the channel reports for this range.",
  removedChannel: "This channel is no longer managed by the Content Owner.",
  publicCounts: "Subscribers, lifetime views and video counts are current public numbers from the YouTube Data API, not changes within the range.",
  noRows: "A channel without stored rows shows no metrics: YouTube omits channels without activity.",
  totals: "Totals include only channels with stored rows in the range."
};

function parseJson(text, fallback) { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } }
function addDays(day, count) { return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10); }
function dayDiff(from, to) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY); }
function pacificToday(now) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
function foldText(value) { return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/\s+/g, " ").trim(); }
function coverageStatus(covered, total) { return !covered ? "missing" : covered >= total ? "ready" : "partial"; }
function orderKeys(keys) { return [...new Set(keys)].sort((a, b) => (EXPORT_ORDER.get(a) ?? 999) - (EXPORT_ORDER.get(b) ?? 999)); }
const unsupported = (totalDays) => ({ rows: [], coveredDays: 0, totalDays, status: "unsupported" });
// Rows with a null sort value go last in both directions; ties fall back to the title so paging is stable.
function comparator({ key, direction }) {
  const sign = direction === "asc" ? 1 : -1;
  const valueOf = (row) => (key in row ? row[key] : row.metrics?.[key]) ?? null;
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.channelId.localeCompare(b.channelId);
  return (a, b) => {
    const x = valueOf(a); const y = valueOf(b);
    if (x === y) return byTitle(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === "string" ? x.localeCompare(y, undefined, { sensitivity: "base" }) : x - y) * sign || byTitle(a, b);
  };
}
function* csvChunks(columns, rows, cell) {
  const line = (values) => values.map(cell).join(",");
  yield BOM + line(columns.map((column) => column.label));
  let batch = [];
  for (const row of rows) {
    batch.push(`\r\n${line(columns.map((column) => row[column.key]))}`);
    if (batch.length === 500) { yield batch.join(""); batch = []; }
  }
  if (batch.length) yield batch.join("");
}

function createReadService({ db, warehouse, core, limits: overrides = {}, now = () => new Date() }) {
  // Request caps come from the engine's own env parser so the UI never advertises a limit the engine does not use.
  const engineLimits = engine.effectiveLimits();
  const limits = { ...v.LIMITS, ...overrides, maxRequestsPerJob: engineLimits.maxRequestsPerJob };
  const channelBatch = engineLimits.channelBatch;
  const registry = new Map(warehouse.METRIC_REGISTRY.map((entry) => [entry.key, entry]));
  // Deliberately the only bridge into Report persistence (same pattern as analyticsService.credentialDb): names only, never emails or tokens.
  const credentialDb = () => require("../config/database");
  const normalize = (value) => (value ? warehouse.normalizeTimestamp(value) : null);
  const latestAllowedDay = () => addDays(pacificToday(now()), -1);
  const bangkok = (value) => {
    const ms = value ? Date.parse(warehouse.normalizeTimestamp(value)) : NaN;
    return Number.isFinite(ms) ? new Date(ms + BANGKOK_OFFSET).toISOString().slice(0, 16).replace("T", " ") : "";
  };
  const columnType = (key) => TYPE_BY_KIND[registry.get(key)?.kind] || "int";

  function resolveOwner(query) {
    const network = core.resolveOwner(v.single(query, "ownerId"), { requireConnected: false });
    return { ownerId: network.network_code, name: network.name };
  }
  function inventory(ownerId) {
    return new Map(db.prepare(`${INVENTORY_SELECT} ORDER BY title COLLATE NOCASE,channel_id`).all(ownerId).map((row) => [row.channel_id, row]));
  }
  const channelMeta = (row) => ({ channelId: row.channel_id, title: row.title, thumbnail: row.thumbnail || null, country: row.country || null, publishedAt: row.published_at || null, removedAt: row.removed_at || null });
  const publicCounts = (row) => ({ subscribersTotal: row.subscriber_count ?? null, lifetimeViews: row.view_count ?? null, videoCount: row.video_count ?? null });
  const scheduleRow = (ownerId) => db.prepare("SELECT * FROM analytic_schedules WHERE owner_id=?").get(ownerId) || null;
  const lagDays = (ownerId) => { const row = scheduleRow(ownerId); return Number.isInteger(row?.lag_days) ? row.lag_days : 3; };
  function requireChannel(ownerId, channelId) {
    const row = db.prepare(`${INVENTORY_SELECT} AND channel_id=?`).get(ownerId, channelId);
    if (!row) throw v.fail(CHANNEL_NOT_FOUND, 404, "notFound");
    return row;
  }
  // One validated selection for the owner-level routes: owner, range, scope and the channel filter → one entity.
  function selection(query) {
    const owner = resolveOwner(query);
    const range = v.dateRange(query);
    const scope = v.scope(query);
    const channels = inventory(owner.ownerId);
    const picked = v.channelIds(query, channels);
    const entity = picked.channelIds.length > 1 ? "channels" : picked.channelIds.length === 1 ? "channel" : "owner";
    return { ...owner, ...range, scope, inventory: channels, ...picked, entity, entityKeys: entity === "owner" ? [`owner:${scope}`] : picked.channelIds.map((id) => `channel:${id}`) };
  }
  function channelSelection(query, channelId) {
    const owner = resolveOwner(query);
    const row = requireChannel(owner.ownerId, channelId);
    return { ...owner, ...v.dateRange(query), scope: "self", inventory: new Map([[channelId, row]]), channelIds: [channelId], unknownChannelIds: [], entity: "channel", entityKeys: [`channel:${channelId}`], row };
  }
  // The currency echo is a revenue detail: non-monetary roles get a selection without it.
  const publicSelection = (sel, canMonetary = true) => ({ ownerId: sel.ownerId, startDate: sel.startDate, endDate: sel.endDate, scope: sel.scope, channelIds: sel.channelIds, entity: sel.entity,
    ...(canMonetary ? { currency: "USD" } : {}), unknownChannelIds: sel.unknownChannelIds });
  // Exports never widen silently: a channel filter made only of unknown IDs is refused instead of falling back to the owner.
  function exportSelection(query) {
    const sel = selection(query);
    if (sel.unknownChannelIds.length && !sel.channelIds.length) throw v.fail(unknownChannelsMessage(sel.unknownChannelIds));
    return sel;
  }
  // Single-entity exports (breakdown, videos, demographics, coverage) take `channelId` or the one channel of the global filter.
  function exportChannel(sel, query) {
    const single = v.channelId(query.channelId, { required: false });
    if (single) { requireChannel(sel.ownerId, single); return single; }
    if (sel.channelIds.length > 1) throw v.fail(SELECT_ONE_CHANNEL);
    return sel.channelIds[0] || "";
  }

  function multiCoverage({ ownerId, entityKeys, startDate, endDate, lag, latest }) {
    const marks = entityKeys.map(() => "?").join(",");
    const facts = new Map(db.prepare(`SELECT day,MAX(monetary) AS monetary FROM analytic_day_coverage WHERE owner_id=? AND entity_key IN (${marks}) AND kind='facts' AND day BETWEEN ? AND ? GROUP BY day`)
      .all(ownerId, ...entityKeys, startDate, endDate).map((row) => [row.day, row]));
    const drifted = new Set(db.prepare(`SELECT DISTINCT day FROM analytic_daily_history WHERE owner_id=? AND entity_key IN (${marks}) AND action='drift' AND day BETWEEN ? AND ?`)
      .all(ownerId, ...entityKeys, startDate, endDate).map((row) => row.day));
    const pendingAfter = addDays(latest, -lag);
    const days = warehouse.daysBetween(startDate, endDate).map((day) => {
      const row = facts.get(day);
      return { day, facts: !!row, monetary: !!row?.monetary, breakdowns: [], drift: drifted.has(day), pending: !row && day > pendingAfter };
    });
    const bounds = db.prepare(`SELECT MIN(day) AS firstDay,MAX(day) AS lastDay,MAX(synced_at) AS lastSyncedAt FROM analytic_day_coverage WHERE owner_id=? AND entity_key IN (${marks}) AND kind='facts'`).get(ownerId, ...entityKeys);
    return { days, covered: days.filter((d) => d.facts).length, missing: days.filter((d) => !d.facts && !d.pending).map((d) => d.day), pending: days.filter((d) => d.pending).map((d) => d.day),
      firstDay: bounds.firstDay || null, lastDay: bounds.lastDay || null, lastSyncedAt: bounds.lastSyncedAt || null, driftDays: days.filter((d) => d.drift).length };
  }
  // Several channels count a day as covered when any of them is (the series sums whatever is stored for that day).
  function entityCoverage({ ownerId, entityKeys, startDate, endDate, canMonetary }) {
    const lag = lagDays(ownerId); const latest = latestAllowedDay();
    const base = entityKeys.length === 1
      ? warehouse.coverage(db, { ownerId, entityKey: entityKeys[0], startDate, endDate, canMonetary, lagDays: lag, latestAllowedDay: latest })
      : multiCoverage({ ownerId, entityKeys, startDate, endDate, lag, latest });
    const staleDays = base.lastDay ? Math.max(0, dayDiff(base.lastDay, addDays(latest, -lag))) : null;
    return { ...base, staleDays, status: !base.covered ? "empty" : base.missing.length ? "partial" : "complete", lagDays: lag, latestAllowedDay: latest };
  }
  function seriesBlock({ ownerId, entityKeys, startDate, endDate }, canMonetary, compare) {
    const series = warehouse.readSeries(db, { ownerId, entityKeys, startDate, endDate, canMonetary });
    const previousRange = warehouse.previousRange({ startDate, endDate });
    const previousSeries = compare ? warehouse.readSeries(db, { ownerId, entityKeys, ...previousRange, canMonetary }) : null;
    const current = warehouse.summarize(series); const previous = previousSeries ? warehouse.summarize(previousSeries) : null;
    return { series, previousSeries, summary: { current: current.totals, previous: previous?.totals ?? null, changes: previous ? warehouse.compareSummaries(current, previous) : null, previousRange,
      coverage: current.coverage, previousCoverage: previous?.coverage ?? null, ...monetaryMeta(current, canMonetary), approx: current.approx } };
  }
  // Revenue coverage counts are only meaningful (and only rendered) for monetary roles.
  const monetaryMeta = (summary, canMonetary) => (canMonetary ? { monetaryCoverage: summary.monetaryCoverage, partialRevenue: summary.partialRevenue } : {});

  // Range snapshots: the owner selection uses the requested scope, a channel the pinned detail selection.
  function snapshotSelection(sel, channelId = "") {
    return core.normalizeSelection({ ownerId: sel.ownerId, startDate: sel.startDate, endDate: sel.endDate, scope: channelId ? "self" : sel.scope, channelId, currency: "USD", includeHistoricalChannelData: false });
  }
  function snapshotReport(selection, reportId, canMonetary) {
    const stored = core.readReport(selection, REPORT_CATALOG.find((report) => report.id === reportId));
    return { id: reportId, status: SNAPSHOT_READY.has(stored.status) ? "ready" : "missing", empty: stored.status === "empty", stale: stored.status === "stale", attemptedAt: stored.attemptedAt,
      error: stored.error, rows: stored.rows.map((row) => warehouse.stripMonetary(row, canMonetary)), updatedAt: stored.updatedAt, coverage: stored.coverage };
  }
  function snapshotBreakdown(selection, dimension, totalDays, canMonetary) {
    const reportId = DIMENSION_SNAPSHOTS[dimension];
    if (!reportId) return unsupported(totalDays);
    const report = snapshotReport(selection, reportId, canMonetary);
    const rows = report.rows.map(({ [dimension]: value, ...metrics }) => ({ value: String(value ?? ""), metrics: warehouse.normalizeMetrics(metrics) }));
    return { rows, coveredDays: report.status === "ready" ? totalDays : 0, totalDays, status: report.status, empty: report.empty, stale: report.stale, attemptedAt: report.attemptedAt, error: report.error, updatedAt: report.updatedAt, source: "snapshot" };
  }
  function ownerBreakdown(sel, dimension, canMonetary) {
    return warehouse.readBreakdown(db, { ownerId: sel.ownerId, entityKey: `owner:${sel.scope}`, dimension, startDate: sel.startDate, endDate: sel.endDate, canMonetary, limit: BREAKDOWN_LIMIT });
  }
  function breakdowns(sel, canMonetary, selection) {
    const dimensions = BREAKDOWN_DIMENSIONS.filter((entry) => canMonetary || !entry.monetary).map((entry) => entry.key);
    return Object.fromEntries(dimensions.map((dimension) => [dimension, sel.entity === "owner" ? ownerBreakdown(sel, dimension, canMonetary)
      : sel.entity === "channel" && dimension !== "adType" ? snapshotBreakdown(selection, dimension, sel.days, canMonetary) : unsupported(sel.days)]));
  }
  function videoMetadata(ownerId, ids) {
    const unique = [...new Set(ids.filter((id) => /^[\w-]{11}$/.test(String(id))))];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      rows.push(...db.prepare(`SELECT video_id,channel_id,title,thumbnail,duration,published_at FROM analytic_videos WHERE owner_id=? AND video_id IN (${chunk.map(() => "?").join(",")})`).all(ownerId, ...chunk));
    }
    return rows.map((row) => ({ videoId: row.video_id, channelId: row.channel_id || null, title: row.title, thumbnail: row.thumbnail || null, duration: row.duration || null, publishedAt: row.published_at || null }));
  }
  function rangeReports(sel, canMonetary, selection) {
    if (!selection) { const none = { status: "unsupported", rows: [] }; return { topVideos: none, ...(canMonetary ? { videoRevenue: none } : {}), demographics: none, videos: [] }; }
    const topVideos = snapshotReport(selection, "videos", canMonetary);
    const videoRevenue = canMonetary ? snapshotReport(selection, "videoRevenue", true) : null;
    const demographics = snapshotReport(selection, "demographics", canMonetary);
    const videos = videoMetadata(sel.ownerId, [...topVideos.rows, ...(videoRevenue?.rows || [])].map((row) => row.video));
    return { topVideos, ...(videoRevenue ? { videoRevenue } : {}), demographics, videos };
  }
  // Everything the overview and the channel detail share for one entity (owner scope, one channel or several channels).
  function entityReport(sel, access, compare) {
    const canMonetary = !!access.canMonetary;
    const block = seriesBlock(sel, canMonetary, compare);
    const coverage = entityCoverage({ ...sel, canMonetary });
    const selection = sel.entity === "channels" ? null : snapshotSelection(sel, sel.entity === "channel" ? sel.channelIds[0] : "");
    const panels = breakdowns(sel, canMonetary, selection);
    const reports = rangeReports(sel, canMonetary, selection);
    const notes = [];
    if (coverage.missing.length) notes.push(NOTES.missing);
    if (coverage.pending.length) notes.push(NOTES.pending);
    if (coverage.driftDays) notes.push(NOTES.drift);
    if (canMonetary && block.summary.partialRevenue) notes.push(NOTES.partialRevenue);
    if (block.summary.approx.includes("averageViewDuration")) notes.push(NOTES.approx);
    if (sel.entity === "channels") notes.push(NOTES.channelsBreakdowns);
    else if (reports.topVideos.status !== "ready") notes.push(NOTES.rangeReports);
    if (sel.entity === "channel" && Object.values(panels).some((panel) => panel.source === "snapshot" && panel.status !== "ready")) notes.push(NOTES.channelSnapshots);
    return { ...block, coverage, breakdowns: panels, ...reports, notes };
  }
  function latestJob(ownerId, access) {
    const row = db.prepare("SELECT id FROM analytic_jobs WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(ownerId);
    return row ? core.getJob(row.id, access) : null;
  }
  // One daily-run story everywhere: the service's run-row based status, sanitised per role (monetary step errors hidden).
  const dailyRunStatus = (ownerId, access = {}) => core.dailyRunStatus(ownerId, access, now());
  function ownerCoverage(ownerId) {
    const row = db.prepare("SELECT MIN(day) AS firstDay,MAX(day) AS lastDay,COUNT(DISTINCT day) AS days,MAX(synced_at) AS lastSyncedAt FROM analytic_day_coverage WHERE owner_id=? AND kind='facts' AND entity_key LIKE 'owner:%'").get(ownerId);
    return { firstDay: row.firstDay || null, lastDay: row.lastDay || null, days: row.days || 0, lastSyncedAt: row.lastSyncedAt || null };
  }

  function bootstrap(access = {}) {
    const canMonetary = !!access.canMonetary;
    const owners = core.listOwners().map((owner) => ({ id: owner.id, ownerId: owner.ownerId, name: owner.name, authStatus: owner.authStatus, authError: owner.authError ?? null,
      hasAnalyticsScope: !!owner.hasAnalyticsScope, hasMonetaryScope: !!owner.hasMonetaryScope, coverage: ownerCoverage(owner.ownerId), dailyRun: dailyRunStatus(owner.ownerId, access) }));
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { owners,
      permissions: { canMonetary, canSync: !!access.canSync, canOverwrite: !!access.canOverwrite, canManageSchedules: !!access.canManageSchedules },
      defaults: { scheduleTimes: scheduleService.DEFAULT_TIMES, timezone: scheduleService.TIMEZONE, lagDays: 3, lookbackDays: 7, settleDays: 7, channelBatch },
      latestAllowedDay: latestAllowedDay(),
      catalog: { metrics: canMonetary ? warehouse.METRIC_REGISTRY : warehouse.METRIC_REGISTRY.filter((entry) => !entry.monetary), breakdownDimensions: BREAKDOWN_DIMENSIONS,
        reportCatalog: core.publicCatalog(canMonetary).map((report) => ({ id: report.id, category: report.category, dimensions: report.dimensions, metrics: report.metrics, monetary: report.monetary, requiresVideo: report.requiresVideo, limit: report.limit, default: report.default })) },
      limits: { maxDays: limits.maxDays, maxChannelIds: limits.maxChannelIds, maxRequestsPerJob: limits.maxRequestsPerJob, maxExportRows: limits.maxExportRows, maxWorkbookRows: limits.maxWorkbookRows, interactiveRows: limits.interactiveRows, topVideos: limits.topVideos },
      database: { name: path.basename(db.analyticsPath || ":memory:"), isolated: true, facts: count("analytic_daily_facts"), coverageRows: count("analytic_day_coverage"), sizeBytes: db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true }) },
      docs: DOCS };
  }
  function overview(query, access = {}) {
    const sel = selection(query);
    const report = entityReport(sel, access, v.boolean(query, "compare", true));
    return { selection: publicSelection(sel, !!access.canMonetary), ...report, dailyRun: dailyRunStatus(sel.ownerId, access), latestJob: latestJob(sel.ownerId, access) };
  }
  function channelsInventory(query) {
    const owner = resolveOwner(query);
    const rows = [...inventory(owner.ownerId).values()];
    return { ownerId: owner.ownerId, channels: rows.map(channelMeta), updatedAt: rows.map((row) => normalize(row.updated_at)).filter(Boolean).sort().at(-1) || null };
  }
  const channelFilters = (query, canMonetary) => ({ search: v.search(query), country: v.country(query), status: v.channelStatus(query),
    sort: v.sort(query, { canMonetary, monetaryKeys: warehouse.MONETARY_KEYS, textKeys: TEXT_SORT_KEYS }) });
  function channelRows(sel, canMonetary, { search, country, status, sort }) {
    const { ownerId, startDate, endDate, days } = sel;
    const selected = sel.channelIds.length ? new Set(sel.channelIds) : null;
    const totals = warehouse.readChannelTotals(db, { ownerId, channelIds: selected ? [...selected] : null, startDate, endDate, canMonetary });
    const monetaryCovered = canMonetary ? new Map(db.prepare("SELECT entity_key,COUNT(*) AS n FROM analytic_day_coverage WHERE owner_id=? AND kind='facts' AND monetary=1 AND entity_key LIKE 'channel:%' AND day BETWEEN ? AND ? GROUP BY entity_key")
      .all(ownerId, startDate, endDate).map((row) => [row.entity_key.slice("channel:".length), row.n])) : null;
    const needle = foldText(search);
    const rows = [];
    for (const item of sel.inventory.values()) {
      if (selected && !selected.has(item.channel_id)) continue;
      const meta = channelMeta(item);
      if (country && meta.country !== country) continue;
      if (needle && !foldText(`${meta.title} ${meta.channelId}`).includes(needle)) continue;
      const stats = totals.get(item.channel_id) || { metrics: null, coveredDays: 0, daysWithRows: 0, monetaryDays: 0, firstDay: null, lastDay: null };
      const rowStatus = coverageStatus(stats.coveredDays, days);
      if (status && rowStatus !== status) continue;
      rows.push({ ...meta, ...publicCounts(item), ...stats, totalDays: days, status: rowStatus, monetaryStatus: canMonetary ? coverageStatus(monetaryCovered.get(item.channel_id) || 0, stats.coveredDays) : "hidden" });
    }
    rows.sort(comparator(sort));
    const keys = rows.map((row) => `channel:${row.channelId}`);
    const summary = warehouse.summarize(keys.length ? warehouse.readSeries(db, { ownerId, entityKeys: keys, startDate, endDate, canMonetary }) : []);
    const all = [...sel.inventory.values()];
    return { rows, totals: { ...summary.totals, ...(canMonetary ? { rpmChannelCount: rows.filter((row) => row.metrics?.estimatedRevenue != null && row.metrics.views > 0).length } : {}) },
      totalsMeta: { coverage: summary.coverage, ...monetaryMeta(summary, canMonetary), approx: summary.approx },
      coverage: { inventoryCount: all.length, activeCount: all.filter((row) => !row.removed_at).length, withData: rows.filter((row) => row.daysWithRows > 0).length,
        inventoryUpdatedAt: all.map((row) => normalize(row.updated_at)).filter(Boolean).sort().at(-1) || null } };
  }
  function channels(query, access = {}) {
    const sel = selection(query); const canMonetary = !!access.canMonetary;
    const filters = channelFilters(query, canMonetary);
    const page = v.integer(query, "page", { min: 1, max: 100000, fallback: 1 });
    const pageSize = v.integer(query, "pageSize", { min: 1, max: limits.maxPageSize, fallback: 50 });
    const table = channelRows(sel, canMonetary, filters);
    const start = (page - 1) * pageSize;
    return { selection: publicSelection(sel, canMonetary), rows: table.rows.slice(start, start + pageSize), totals: table.totals, totalsMeta: table.totalsMeta, coverage: table.coverage, total: table.rows.length,
      page, pageSize, sort: filters.sort, unknownChannelIds: sel.unknownChannelIds, latestJob: latestJob(sel.ownerId, access), notes: [NOTES.publicCounts, NOTES.noRows, NOTES.totals] };
  }
  function channelDetail(channelId, query, access = {}) {
    const sel = channelSelection(query, v.channelId(channelId)); const canMonetary = !!access.canMonetary;
    const report = entityReport(sel, access, v.boolean(query, "compare", true));
    const stats = warehouse.readChannelTotals(db, { ownerId: sel.ownerId, channelIds: sel.channelIds, startDate: sel.startDate, endDate: sel.endDate, canMonetary }).get(sel.channelIds[0]);
    const monetaryCovered = canMonetary ? db.prepare("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE owner_id=? AND entity_key=? AND kind='facts' AND monetary=1 AND day BETWEEN ? AND ?")
      .get(sel.ownerId, sel.entityKeys[0], sel.startDate, sel.endDate).n : 0;
    const channel = { ...channelMeta(sel.row), ...publicCounts(sel.row), ...stats, totalDays: sel.days, status: coverageStatus(stats.coveredDays, sel.days),
      monetaryStatus: canMonetary ? coverageStatus(monetaryCovered, stats.coveredDays) : "hidden" };
    return { selection: publicSelection(sel, canMonetary), channel, ...report, notes: sel.row.removed_at ? [...report.notes, NOTES.removedChannel] : report.notes, latestJob: latestJob(sel.ownerId, access) };
  }
  function coverageReport(query, access = {}) {
    const owner = resolveOwner(query); const range = v.dateRange(query);
    const channelId = v.channelId(query.channelId, { required: false });
    const entityKey = channelId ? `channel:${channelId}` : `owner:${v.scope(query)}`;
    const coverage = entityCoverage({ ownerId: owner.ownerId, entityKeys: [entityKey], startDate: range.startDate, endDate: range.endDate, canMonetary: !!access.canMonetary });
    const months = new Map();
    for (const day of coverage.days) {
      const month = day.day.slice(0, 7);
      if (!months.has(month)) months.set(month, { month, covered: 0, total: 0, drift: 0, missing: 0, pending: 0 });
      const entry = months.get(month);
      entry.total += 1;
      if (day.facts) entry.covered += 1; else if (day.pending) entry.pending += 1; else entry.missing += 1;
      if (day.drift) entry.drift += 1;
    }
    return { ownerId: owner.ownerId, entityKey, startDate: range.startDate, endDate: range.endDate, ...coverage, summaryByMonth: [...months.values()] };
  }
  function decorateHistory(ownerId, entries) {
    const jobIds = [...new Set(entries.map((entry) => entry.jobId).filter(Boolean))];
    const jobs = new Map(jobIds.length ? db.prepare(`SELECT id,kind,mode,request_json,created_by FROM analytic_jobs WHERE owner_id=? AND id IN (${jobIds.map(() => "?").join(",")})`).all(ownerId, ...jobIds)
      .map((job) => { const request = parseJson(job.request_json, {}); return [job.id, { kind: job.kind || request.kind || "snapshot", mode: job.mode || request.mode || null, requestedBy: request.requestedBy || null, createdBy: job.created_by }]; }) : []);
    const names = new Map();
    const userName = (id) => {
      if (!names.has(id)) {
        const user = credentialDb().prepare("SELECT id,full_name,first_name,last_name FROM users WHERE id=?").get(id);
        names.set(id, user ? { id: user.id, name: user.full_name || [user.first_name, user.last_name].filter(Boolean).join(" ") || `#${user.id}` } : null);
      }
      return names.get(id);
    };
    return entries.map(({ ownerId: _owner, ...entry }) => {
      const job = jobs.get(entry.jobId) || null;
      return { ...entry, requestedBy: job?.requestedBy ?? null, createdBy: job?.createdBy != null ? userName(job.createdBy) : null, kind: job?.kind ?? null, mode: job?.mode ?? null };
    });
  }
  function factHistory(query, access = {}) {
    const owner = resolveOwner(query);
    const result = warehouse.history(db, { ownerId: owner.ownerId, entityKey: v.entityKey(query), day: v.day(query, "day"), ...v.optionalRange(query), canMonetary: !!access.canMonetary,
      limit: v.integer(query, "limit", { min: 1, max: limits.maxHistoryLimit, fallback: 100 }), before: v.integer(query, "before", { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: null }) });
    return { ownerId: owner.ownerId, entries: decorateHistory(owner.ownerId, result.entries), total: result.total, nextBefore: result.nextBefore ?? null };
  }
  function facts(query, access = {}) {
    const sel = selection(query);
    const rows = warehouse.readFactRows(db, { ownerId: sel.ownerId, entityKeys: sel.entityKeys, startDate: sel.startDate, endDate: sel.endDate, canMonetary: !!access.canMonetary, limit: limits.maxExportRows })
      .map((row) => ({ ...row, title: row.channelId ? sel.inventory.get(row.channelId)?.title ?? null : null }));
    return { selection: publicSelection(sel, !!access.canMonetary), rows, total: rows.length };
  }
  // The Explorer's stored-result source: every public catalog report for one exact legacy selection.
  function snapshots(query, access = {}) {
    const owner = resolveOwner(query); const range = v.dateRange(query); const canMonetary = !!access.canMonetary;
    const selection = core.normalizeSelection({ ownerId: owner.ownerId, startDate: range.startDate, endDate: range.endDate, scope: v.scope(query), channelId: v.channelId(query.channelId, { required: false }),
      videoId: v.videoId(query), country: v.single(query, "country") || "", currency: v.single(query, "currency") || "USD", includeHistoricalChannelData: false });
    const reportId = v.reportId(query);
    if (reportId) {
      const known = REPORT_CATALOG.find((report) => report.id === reportId);
      if (!known) throw v.fail("Unknown catalog report.", 404, "notFound");
      if (known.monetary && !canMonetary) throw v.fail(v.MONETARY_MESSAGE, 403, "forbidden");
    }
    const reports = core.publicCatalog(canMonetary).filter((report) => !reportId || report.id === reportId).map((report) => {
      const stored = core.readReport(selection, report);
      return [report.id, { ...stored, status: SNAPSHOT_READY.has(stored.status) ? "ready" : "missing", empty: stored.status === "empty", stale: stored.status === "stale", rows: stored.rows.map((row) => warehouse.stripMonetary(row, canMonetary)) }];
    });
    return { selection, reports: Object.fromEntries(reports) };
  }

  // Exports: every type builds { ownerId, startDate, endDate, title, sheets:[{ name, columns, rows, totals? }], notes }.
  // CSV takes the first sheet; xlsx gets a Summary sheet plus every sheet, with the labels of the requested language.
  const metricColumns = (keys, L) => keys.map((key) => ({ key, label: L.metric(key), type: columnType(key) }));
  const column = (L, key, type) => ({ key, label: L.column(key), type });
  const metricKeys = (canMonetary) => (canMonetary ? [...BASIC_KEYS, ...MONEY_KEYS] : BASIC_KEYS);
  const bounds = (sel) => ({ ownerId: sel.ownerId, startDate: sel.startDate, endDate: sel.endDate });
  const sourceLabel = (L, sources) => [...sources].map((source) => L.word("kind", source)).join(" + ");
  // The series zero-fills additive keys on covered days; a day without a revenue row exports blank revenue cells instead.
  const dayMetrics = (entry) => (entry.metrics && !entry.monetaryRows ? Object.fromEntries(Object.entries(entry.metrics).map(([key, value]) => [key, warehouse.MONETARY_KEYS.has(key) ? null : value])) : entry.metrics || {});
  function dailySheet(sel, canMonetary, L) {
    const series = warehouse.readSeries(db, { ownerId: sel.ownerId, entityKeys: sel.entityKeys, startDate: sel.startDate, endDate: sel.endDate, canMonetary });
    const provenance = new Map();
    for (const row of warehouse.readFactRows(db, { ownerId: sel.ownerId, entityKeys: sel.entityKeys, startDate: sel.startDate, endDate: sel.endDate, canMonetary, limit: limits.maxExportRows })) {
      const entry = provenance.get(row.day) || { first: row.firstSyncedAt, last: row.lastSyncedAt, revision: row.revision, sources: new Set() };
      entry.first = entry.first < row.firstSyncedAt ? entry.first : row.firstSyncedAt; entry.last = entry.last > row.lastSyncedAt ? entry.last : row.lastSyncedAt;
      entry.revision = Math.max(entry.revision, row.revision); entry.sources.add(row.source);
      provenance.set(row.day, entry);
    }
    const pendingAfter = addDays(latestAllowedDay(), -lagDays(sel.ownerId));
    const rows = series.map((entry) => {
      const stamp = provenance.get(entry.day);
      return { day: entry.day, status: L.status(entry.covered ? "stored" : entry.day > pendingAfter ? "pending" : "missing"), ...dayMetrics(entry),
        firstSynced: bangkok(stamp?.first), lastSynced: bangkok(stamp?.last), revision: stamp?.revision ?? null, source: stamp ? sourceLabel(L, stamp.sources) : "" };
    });
    const summary = warehouse.summarize(series);
    return { summary, sheet: { name: L.sheet("daily"), columns: [column(L, "day", "date"), column(L, "status", "text"), ...metricColumns(metricKeys(canMonetary), L), column(L, "firstSynced", "datetime"),
      column(L, "lastSynced", "datetime"), column(L, "revision", "int"), column(L, "source", "text")], rows, totals: { day: L.column("total"), ...summary.totals } } };
  }
  function channelsSheet(sel, canMonetary, filters, L) {
    const table = channelRows(sel, canMonetary, filters);
    const rows = table.rows.map((row) => ({ channel: row.title, channelId: row.channelId, country: row.country, published: row.publishedAt ? row.publishedAt.slice(0, 10) : "", removed: L.bool(!!row.removedAt),
      subscribersTotal: row.subscribersTotal, lifetimeViews: row.lifetimeViews, videoCount: row.videoCount, status: L.status(row.status), revenueStatus: L.status(row.monetaryStatus),
      coveredDays: row.coveredDays, daysWithRows: row.daysWithRows, totalDays: row.totalDays, firstDay: row.firstDay, lastDay: row.lastDay, ...(row.metrics || {}) }));
    const { rpmChannelCount: _count, ...totals } = table.totals;
    return { sheet: { name: L.sheet("channels"), columns: [column(L, "channel", "text"), column(L, "channelId", "text"), column(L, "country", "text"), column(L, "published", "date"), column(L, "removed", "text"),
      ...metricColumns(["subscribersTotal", "lifetimeViews", "videoCount"], L), column(L, "status", "text"), ...(canMonetary ? [column(L, "revenueStatus", "text")] : []), column(L, "coveredDays", "int"),
      column(L, "daysWithRows", "int"), column(L, "totalDays", "int"), column(L, "firstDay", "date"), column(L, "lastDay", "date"), ...metricColumns(metricKeys(canMonetary), L)], rows,
      totals: { channel: L.column("total"), ...totals } } };
  }
  function breakdownSheet(sel, dimension, channelId, canMonetary, L) {
    const panel = channelId ? snapshotBreakdown(snapshotSelection(sel, channelId), dimension, sel.days, canMonetary) : ownerBreakdown(sel, dimension, canMonetary);
    const sortKey = BREAKDOWN_SORT_KEY[dimension] || "views";
    const total = panel.rows.reduce((sum, row) => sum + (Number(row.metrics[sortKey]) || 0), 0);
    const keys = orderKeys(panel.rows.flatMap((row) => Object.keys(row.metrics)));
    const rows = panel.rows.map((row) => ({ value: L.value(dimension, row.value), code: row.value, ...row.metrics, share: total ? (Number(row.metrics[sortKey]) || 0) * 100 / total : null }));
    return { panel, sheet: { name: L.dimension(dimension), columns: [{ key: "value", label: L.dimension(dimension), type: "text" }, column(L, "code", "text"), ...metricColumns(keys, L), column(L, "share", "percent")], rows } };
  }
  function videoSheet(sel, reportId, channelId, canMonetary, L) {
    const report = snapshotReport(snapshotSelection(sel, channelId), reportId, canMonetary);
    const meta = new Map(videoMetadata(sel.ownerId, report.rows.map((row) => row.video)).map((video) => [video.videoId, video]));
    const keys = orderKeys(report.rows.flatMap((row) => Object.keys(row).filter((key) => key !== "video")));
    const rows = report.rows.map(({ video, ...metrics }) => {
      const info = meta.get(video);
      return { videoId: video, title: info?.title ?? "", channel: info?.channelId ? sel.inventory.get(info.channelId)?.title ?? info.channelId : "", published: info?.publishedAt ? info.publishedAt.slice(0, 10) : "", ...metrics };
    });
    return { report, sheet: { name: L.sheet(reportId === "videos" ? "topVideos" : "videoRevenue"), columns: [column(L, "videoId", "text"), column(L, "title", "text"), column(L, "channel", "text"), column(L, "published", "date"), ...metricColumns(keys, L)], rows } };
  }
  const builders = {
    daily(ctx) {
      const sel = exportSelection(ctx.query); const { summary, sheet } = dailySheet(sel, ctx.canMonetary, ctx.L);
      return { ...bounds(sel), title: ctx.L.sheet("daily"), sheets: [sheet], notes: [ctx.L.note("pacific"), ctx.L.note("missing"), ...(ctx.canMonetary ? [ctx.L.note("revenue")] : []), ...(summary.approx.length ? [ctx.L.note("approx")] : [])] };
    },
    channels(ctx) {
      const sel = exportSelection(ctx.query); const { sheet } = channelsSheet(sel, ctx.canMonetary, channelFilters(ctx.query, ctx.canMonetary), ctx.L);
      return { ...bounds(sel), title: ctx.L.sheet("channels"), sheets: [sheet], notes: [ctx.L.note("pacific"), ctx.L.note("missing"), ...(ctx.canMonetary ? [ctx.L.note("revenue")] : [])] };
    },
    "channel-days"(ctx) {
      const sel = exportSelection(ctx.query); const single = v.channelId(ctx.query.channelId, { required: false });
      if (single) requireChannel(sel.ownerId, single);
      const ids = single ? [single] : sel.channelIds.length ? sel.channelIds : [...sel.inventory.keys()];
      const rows = warehouse.readFactRows(db, { ownerId: sel.ownerId, entityKeys: ids.map((id) => `channel:${id}`), startDate: sel.startDate, endDate: sel.endDate, canMonetary: ctx.canMonetary, limit: limits.maxExportRows })
        .map((row) => ({ channel: sel.inventory.get(row.channelId)?.title ?? row.channelId, channelId: row.channelId, day: row.day, ...row.metrics, firstSynced: bangkok(row.firstSyncedAt), lastSynced: bangkok(row.lastSyncedAt), revision: row.revision, source: ctx.L.word("kind", row.source) }));
      return { ...bounds(sel), title: ctx.L.sheet("channelDays"), notes: [ctx.L.note("pacific"), ctx.L.note("missing"), ...(ctx.canMonetary ? [ctx.L.note("revenue")] : [])],
        sheets: [{ name: ctx.L.sheet("channelDays"), columns: [column(ctx.L, "channel", "text"), column(ctx.L, "channelId", "text"), column(ctx.L, "day", "date"), ...metricColumns(metricKeys(ctx.canMonetary), ctx.L),
          column(ctx.L, "firstSynced", "datetime"), column(ctx.L, "lastSynced", "datetime"), column(ctx.L, "revision", "int"), column(ctx.L, "source", "text")], rows }] };
    },
    breakdown(ctx) {
      const sel = exportSelection(ctx.query); const single = exportChannel(sel, ctx.query);
      const { sheet } = breakdownSheet(sel, ctx.dimension, single, ctx.canMonetary, ctx.L);
      return { ...bounds(sel), title: ctx.L.dimension(ctx.dimension), sheets: [sheet], notes: [ctx.L.note("pacific"), ...(single ? [ctx.L.note("snapshot")] : []), ...(ctx.canMonetary ? [ctx.L.note("revenue")] : [])] };
    },
    "top-videos"(ctx) { return builders.videos(ctx, "videos"); },
    "video-revenue"(ctx) { return builders.videos(ctx, "videoRevenue"); },
    videos(ctx, reportId) {
      const sel = exportSelection(ctx.query); const single = exportChannel(sel, ctx.query);
      const { sheet } = videoSheet(sel, reportId, single, ctx.canMonetary, ctx.L);
      return { ...bounds(sel), title: sheet.name, sheets: [sheet], notes: [ctx.L.note("topVideos"), ...(reportId === "videoRevenue" ? [ctx.L.note("revenue")] : [])] };
    },
    demographics(ctx) {
      const sel = exportSelection(ctx.query); const single = exportChannel(sel, ctx.query);
      const report = snapshotReport(snapshotSelection(sel, single), "demographics", ctx.canMonetary);
      const rows = report.rows.map((row) => ({ ageGroup: ctx.L.value("ageGroup", row.ageGroup), gender: ctx.L.value("gender", row.gender), viewerPercentage: row.viewerPercentage }));
      return { ...bounds(sel), title: ctx.L.sheet("demographics"), notes: [ctx.L.note("pacific")], sheets: [{ name: ctx.L.sheet("demographics"),
        columns: [{ key: "ageGroup", label: ctx.L.dimension("ageGroup"), type: "text" }, { key: "gender", label: ctx.L.dimension("gender"), type: "text" }, { key: "viewerPercentage", label: ctx.L.metric("viewerPercentage"), type: "percent" }], rows }] };
    },
    revenue(ctx) {
      const sel = exportSelection(ctx.query); const L = ctx.L; const money = ["views", ...MONEY_KEYS];
      const pick = (metrics) => Object.fromEntries(money.map((key) => [key, metrics?.[key] ?? null]));
      const series = warehouse.readSeries(db, { ownerId: sel.ownerId, entityKeys: sel.entityKeys, startDate: sel.startDate, endDate: sel.endDate, canMonetary: true });
      const daily = series.filter((entry) => entry.covered).map((entry) => ({ day: entry.day, ...pick(dayMetrics(entry)) }));
      const table = channelRows(sel, true, { search: "", country: null, status: null, sort: { key: "estimatedRevenue", direction: "desc" } });
      const byChannel = table.rows.filter((row) => row.metrics).map((row) => ({ channel: row.title, channelId: row.channelId, ...pick(row.metrics) }));
      const sheetFor = (dimension, name) => { const { sheet } = breakdownSheet(sel, dimension, "", true, L); return { ...sheet, name: L.sheet(name) }; };
      return { ...bounds(sel), title: L.sheet("revenue"), notes: [L.note("pacific"), L.note("revenue"), L.note("missing"), L.note("ownerBreakdowns")], sheets: [
        { name: L.sheet("dailyRevenue"), columns: [column(L, "day", "date"), ...metricColumns(money, L)], rows: daily, totals: { day: L.column("total"), ...pick(warehouse.summarize(series).totals) } },
        { name: L.sheet("byChannel"), columns: [column(L, "channel", "text"), column(L, "channelId", "text"), ...metricColumns(money, L)], rows: byChannel },
        sheetFor("country", "byCountry"), sheetFor("creatorContentType", "byContentType"), sheetFor("adType", "byAdType")] };
    },
    overview(ctx) {
      const sel = exportSelection(ctx.query); const L = ctx.L; const single = sel.entity === "channel" ? sel.channelIds[0] : "";
      const { summary, sheet: daily } = dailySheet(sel, ctx.canMonetary, L);
      const { sheet: channelsTable } = channelsSheet(sel, ctx.canMonetary, { search: "", country: null, status: null, sort: { key: "views", direction: "desc" } }, L);
      const dimensions = sel.entity === "channels" ? [] : BREAKDOWN_DIMENSIONS.filter((entry) => (ctx.canMonetary || !entry.monetary) && (!single || DIMENSION_SNAPSHOTS[entry.key])).map((entry) => entry.key);
      return { ...bounds(sel), title: L.sheet("overview"), sheets: [daily, channelsTable, ...dimensions.map((dimension) => breakdownSheet(sel, dimension, single, ctx.canMonetary, L).sheet)],
        notes: [L.note("pacific"), L.note("missing"), ...(ctx.canMonetary ? [L.note("revenue")] : []), ...(summary.approx.length ? [L.note("approx")] : []), ...(single ? [L.note("snapshot")] : [])] };
    },
    coverage(ctx) {
      const sel = exportSelection(ctx.query); const L = ctx.L; const channelId = exportChannel(sel, ctx.query);
      const coverage = entityCoverage({ ownerId: sel.ownerId, entityKeys: [channelId ? `channel:${channelId}` : `owner:${sel.scope}`], startDate: sel.startDate, endDate: sel.endDate, canMonetary: ctx.canMonetary });
      const rows = coverage.days.map((day) => ({ day: day.day, stored: L.bool(day.facts), revenueIncluded: L.bool(day.monetary), breakdowns: day.breakdowns.map((key) => L.dimension(key)).join(", "), drift: L.bool(day.drift), pending: L.bool(day.pending) }));
      return { ...bounds(sel), title: L.sheet("coverage"), notes: [L.note("pacific"), L.note("missing")], sheets: [{ name: L.sheet("coverage"),
        columns: [column(L, "day", "date"), column(L, "stored", "text"), ...(ctx.canMonetary ? [column(L, "revenueIncluded", "text")] : []), column(L, "breakdowns", "text"), column(L, "drift", "text"), column(L, "pending", "text")], rows }] };
    },
    history(ctx) {
      const owner = resolveOwner(ctx.query); const range = v.dateRange(ctx.query); const L = ctx.L;
      const dayFilter = v.day(ctx.query, "day"); const bounds = dayFilter ? { startDate: dayFilter, endDate: dayFilter } : range;
      // The range is bound in SQL so the 1,000-row cap applies to in-range rows only; the file says so when the cap still cut rows.
      const ledger = warehouse.history(db, { ownerId: owner.ownerId, entityKey: v.entityKey(ctx.query), day: dayFilter, startDate: bounds.startDate, endDate: bounds.endDate, limit: limits.maxHistoryLimit, canMonetary: ctx.canMonetary });
      const entries = decorateHistory(owner.ownerId, ledger.entries);
      const truncated = ledger.total > entries.length ? [LEDGER_TRUNCATED[L.language].replace("{total}", String(ledger.total)).replace("{count}", String(entries.length))] : [];
      const channels = inventory(owner.ownerId);
      const entityLabel = (key) => (key.startsWith("owner:") ? L.word("scope", key.slice("owner:".length)) : channels.get(key.slice("channel:".length))?.title ?? key.slice("channel:".length));
      const change = (entry, item) => `${item.value ? `${L.value(entry.dimension, item.value)} · ` : ""}${L.metric(item.key)}: ${item.before ?? "—"} → ${item.after ?? "—"}`;
      const rows = entries.map((entry) => ({ recordedAt: bangkok(entry.recordedAt), entity: entityLabel(entry.entityKey), day: entry.day, dimension: entry.dimension ? L.dimension(entry.dimension) : "",
        action: L.word("action", entry.action), changedKeys: entry.changedKeys.map((item) => change(entry, item)).join("; "),
        addedValues: (entry.dimension && entry.next?.added ? entry.next.added : []).map((value) => L.value(entry.dimension, value)).join(", "),
        missingValues: (entry.dimension && entry.next?.missing ? entry.next.missing : []).map((value) => L.value(entry.dimension, value)).join(", "),
        job: entry.jobId || "", requestedBy: entry.requestedBy ? L.word("requestedBy", entry.requestedBy) : "", changedBy: entry.createdBy?.name || "",
        kind: entry.kind ? L.word("kind", entry.kind) : "", mode: entry.mode ? L.word("mode", entry.mode) : "" }));
      return { ownerId: owner.ownerId, startDate: range.startDate, endDate: range.endDate, title: L.sheet("history"), notes: [L.note("ledger"), ...truncated], sheets: [{ name: L.sheet("history"),
        columns: [column(L, "recordedAt", "datetime"), column(L, "entity", "text"), column(L, "day", "date"), column(L, "dimension", "text"), column(L, "action", "text"), column(L, "changedKeys", "text"),
          column(L, "addedValues", "text"), column(L, "missingValues", "text"), column(L, "job", "text"), column(L, "requestedBy", "text"), column(L, "changedBy", "text"), column(L, "kind", "text"), column(L, "mode", "text")], rows }] };
    }
  };
  async function exportData(query, access = {}) {
    const type = v.exportType(query); const format = v.exportFormat(query); const language = v.language(query); const canMonetary = !!access.canMonetary;
    if (["video-revenue", "revenue"].includes(type) && !canMonetary) throw v.fail(v.MONETARY_MESSAGE, 403, "forbidden");
    if (["overview", "revenue"].includes(type) && format !== "xlsx") throw v.fail("This export is available as xlsx only.");
    const dimension = type === "breakdown" ? v.dimension(query, { canMonetary }) : null;
    const file = builders[type]({ query, canMonetary, L: labels.forLanguage(language), dimension });
    const filename = `analytics-${type}${dimension ? `-${dimension}` : ""}-${file.ownerId}-${file.startDate}-${file.endDate}.${format}`;
    if (format === "csv") return { filename, contentType: CSV_TYPE, stream: csvChunks(file.sheets[0].columns, file.sheets[0].rows, warehouse.csvCell) };
    if (file.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) > limits.maxWorkbookRows) {
      throw v.fail("The export is too large for Excel (more than 50,000 rows). Export CSV or shorten the range.", 413, "tooManyRows");
    }
    const workbook = warehouse.buildWorkbook({ sheets: file.sheets, meta: { title: file.title, ownerId: file.ownerId, range: `${file.startDate} – ${file.endDate}`, generatedAt: now().toISOString(), language, notes: file.notes } });
    return { filename, contentType: XLSX_TYPE, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
  }

  return { bootstrap, overview, channelsInventory, channels, channelDetail, coverageReport, factHistory, facts, snapshots, exportData, dailyRunStatus, latestAllowedDay };
}

module.exports = { createReadService, NOTES, CHANNEL_NOT_FOUND };
