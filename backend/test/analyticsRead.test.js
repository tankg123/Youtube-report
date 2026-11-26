const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const ExcelJS = require("exceljs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-read-"));
process.env.ANALYTICS_DB_PATH = path.join(tempDir, "analytics.sqlite");
process.env.JWT_SECRET = "analytics-read-tests-only";
const originalGet = axios.get;
const networks = [
  { id: 98, network_code: "read-owner", name: "Read Owner", cms_auth_status: "connected", cms_auth_error: null, cms_refresh_token: "private-refresh-token", cms_access_token: "ya29.private-access-token",
    cms_auth_scopes: "https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/yt-analytics-monetary.readonly" },
  { id: 99, network_code: "other-owner", name: "Other Owner", cms_auth_status: "error", cms_auth_error: "invalid_grant", cms_refresh_token: "private-other-token", cms_auth_scopes: "" }
];
const users = {
  1: { id: 1, full_name: "Alice Admin", email: "alice@example.com", role: "admin", status: "active" },
  2: { id: 2, full_name: "Cid Reader", email: "cid@example.com", role: "Content ID", status: "active" },
  3: { id: 3, full_name: "Rose Readonly", email: "rose@example.com", role: '["Report Manager","Read Only"]', status: "active" },
  4: { id: 4, full_name: "Pat Partner", email: "pat@example.com", role: "Partner", status: "active" },
  5: { id: 5, full_name: "Rita Manager", email: "rita@example.com", role: "Report Manager", status: "active" }
};
const credentialPath = require.resolve("../src/config/database");
require.cache[credentialPath] = { id: credentialPath, filename: credentialPath, loaded: true, exports: {
  prepare: (sql) => ({ get: (id) => /FROM users/.test(sql) ? users[id] : networks.find((network) => network.network_code === id || String(network.id) === String(id)), all: () => networks })
} };
const bridgePath = require.resolve("../src/services/googleContentIdService");
require.cache[bridgePath] = { id: bridgePath, filename: bridgePath, loaded: true, exports: {
  getAccessToken: async () => "private-access-token", getConnectedNetwork: (id) => networks.find((owner) => owner.id === id)
} };
axios.get = async () => { throw new Error("A local read must not call Google"); };
const db = require("../src/config/analyticsDatabase");
const w = require("../src/services/analyticsWarehouse");
const core = require("../src/services/analyticsService");
const scheduler = require("../src/services/analyticsScheduleService");
const engineLib = require("../src/services/analyticsSyncEngine");
const catalog = require("../src/services/analyticsCatalog").REPORT_CATALOG;
const { createReadService, NOTES } = require("../src/services/analyticsReadService");
const routes = require("../src/routes/analyticsRoutes");
const reads = createReadService({ db, warehouse: w, core });

const OWNER = "read-owner"; const OTHER = "other-owner";
const A = `UC${"a".repeat(22)}`; const B = `UC${"b".repeat(22)}`; const C = `UC${"c".repeat(22)}`; const Z = `UC${"z".repeat(22)}`;
const START = "2026-10-01"; const END = "2026-10-10";
const T1 = "2026-10-12T02:00:00.000Z"; const T2 = "2026-10-13T02:00:00.000Z"; const T3 = "2026-10-14T02:00:00.000Z";
const REVENUE = 777.77; // sentinel: must never appear in a non-monetary answer
const HOSTILE = '=HYPERLINK("https://evil.example")';
const ADMIN = { userId: 1, canMonetary: true, canSync: true, canOverwrite: true, canManageSchedules: true };
const CONTENT_ID = { userId: 2, canMonetary: false, canSync: true, canOverwrite: false, canManageSchedules: true };
const base = { ownerId: OWNER, startDate: START, endDate: END };
const days = (from, to) => w.daysBetween(from, to);
const n = (day) => Number(day.slice(-2));
const basic = (day) => ({ views: 1000 + n(day), engagedViews: 800 + n(day), estimatedMinutesWatched: 5000 + n(day), averageViewDuration: 300, averageViewPercentage: 25.5, likes: 10, subscribersGained: 5, subscribersLost: 1 });
const money = { estimatedRevenue: REVENUE, estimatedAdRevenue: 700.7, grossRevenue: 888.88, adImpressions: 10000, cpm: 88.888, monetizedPlaybacks: 5000, playbackBasedCpm: 177.776 };
const report = (id) => catalog.find((entry) => entry.id === id);
const table = (rows) => ({ columnHeaders: Object.keys(rows[0] || { video: "" }).map((name) => ({ name, columnType: "METRIC" })), rows, coverage: { rowCount: rows.length } });
const failAttempt = (selection, reportId, message) => db.prepare("INSERT INTO analytic_attempts(snapshot_key,owner_id,report_id,status,error_json) VALUES(?,?,?,'error',?) ON CONFLICT(snapshot_key) DO UPDATE SET status='error',error_json=excluded.error_json")
  .run(core.snapshotKey(selection, reportId), selection.ownerId, reportId, JSON.stringify({ message, reason: "backendError", status: 500 }));
function inventory(ownerId, channelId, title, extra = {}) {
  db.prepare("INSERT INTO analytic_channels(owner_id,channel_id,title,thumbnail,country,published_at,subscriber_count,view_count,video_count,metadata_json,removed_at,updated_at) VALUES(?,?,?,NULL,?,'2020-01-01T00:00:00Z',?,10000,20,'{}',?,?)")
    .run(ownerId, channelId, title, extra.country || "VN", "subscribers" in extra ? extra.subscribers : 1000, extra.removedAt || null, extra.updatedAt || T1);
}
function seed() {
  inventory(OWNER, A, "Alpha"); inventory(OWNER, B, "Kênh Beta", { removedAt: T2, subscribers: null }); inventory(OWNER, C, HOSTILE, { country: "US" }); inventory(OTHER, Z, "Other private channel");
  const owner = (rows, extra = {}) => w.writeFacts(db, { ownerId: OWNER, entityKey: "owner:claimed", rows, mode: extra.mode || "append", source: extra.source || "daily", jobId: extra.jobId || "job-daily-1", monetary: !!extra.monetary, now: extra.now || T1 });
  owner(days(START, "2026-10-08").map((day) => ({ day, metrics: basic(day) })));
  owner(days(START, "2026-10-06").map((day) => ({ day, metrics: money })), { monetary: true });
  w.markCoverage(db, { ownerId: OWNER, entityKey: "owner:claimed", days: days(START, "2026-10-06"), monetary: true, jobId: "job-daily-1", now: T1 });
  w.markCoverage(db, { ownerId: OWNER, entityKey: "owner:claimed", days: days("2026-10-07", "2026-10-08"), monetary: false, jobId: "job-daily-1", now: T1 });
  owner([{ day: "2026-10-03", metrics: { ...basic("2026-10-03"), views: 5003 } }], { jobId: "job-daily-2", now: T2 });
  owner([{ day: "2026-10-04", metrics: { estimatedRevenue: 999.99, views: 1004 } }], { mode: "overwrite", source: "full", jobId: "job-full-1", monetary: true, now: T3 });
  const channel = (id, rows, extra = {}) => w.writeFacts(db, { ownerId: OWNER, entityKey: `channel:${id}`, rows, mode: "append", source: "daily", jobId: "job-daily-1", monetary: !!extra.monetary, now: T1 });
  channel(A, days(START, "2026-10-08").map((day) => ({ day, metrics: { views: 100 + n(day), engagedViews: 80, estimatedMinutesWatched: 600, subscribersGained: 2, subscribersLost: 0 } })));
  channel(A, days(START, "2026-10-04").map((day) => ({ day, metrics: { estimatedRevenue: 12.34 } })), { monetary: true });
  channel(B, days(START, "2026-10-02").map((day) => ({ day, metrics: { views: 50, estimatedMinutesWatched: 100 } })));
  for (const id of [A, B, C]) w.markCoverage(db, { ownerId: OWNER, entityKey: `channel:${id}`, days: days(START, "2026-10-08"), monetary: false, jobId: "job-daily-1", now: T1 });
  w.markCoverage(db, { ownerId: OWNER, entityKey: `channel:${A}`, days: days(START, "2026-10-04"), monetary: true, jobId: "job-daily-1", now: T1 });
  const breakdown = (dimension, rows, extra = {}) => w.writeBreakdowns(db, { ownerId: OWNER, entityKey: "owner:claimed", dimension, rows, mode: "append", source: "daily", jobId: "job-daily-1", monetary: !!extra.monetary, now: T1, coveredDays: extra.coveredDays });
  breakdown("country", [{ day: START, value: "VN", metrics: { views: 500 } }, { day: START, value: "US", metrics: { views: 300 } }, { day: "2026-10-02", value: "VN", metrics: { views: 400 } }], { coveredDays: [START, "2026-10-02"] });
  breakdown("deviceType", [{ day: START, value: "MOBILE", metrics: { views: 600 } }, { day: START, value: "TV", metrics: { views: 100 } }], { coveredDays: [START] });
  breakdown("adType", [{ day: START, value: "auctionTrueviewInstream", metrics: { grossRevenue: 10, adImpressions: 1000, cpm: 10 } }], { monetary: true, coveredDays: [START] });
  // A non-monetary dimension that stores revenue keys: its export must strip them for Content ID.
  breakdown("creatorContentType", [{ day: START, value: "VIDEO_ON_DEMAND", metrics: { views: 700, estimatedRevenue: REVENUE } }], { monetary: true, coveredDays: [START] });
  const selection = core.normalizeSelection({ ...base, scope: "claimed" });
  core.persistReport(selection, report("videos"), {}, table([{ video: "vid00000001", views: 50 }]));
  core.persistReport(selection, report("videoRevenue"), {}, table([{ video: "vid00000001", views: 50, estimatedRevenue: 3.5 }]));
  core.persistReport(selection, report("demographics"), {}, table([{ ageGroup: "age18-24", gender: "female", viewerPercentage: 40.5 }]));
  db.prepare("INSERT INTO analytic_videos(owner_id,video_id,channel_id,title,thumbnail,duration,published_at,metadata_json) VALUES(?,?,?,?,NULL,'PT3M','2026-09-01T00:00:00Z','{}')").run(OWNER, "vid00000001", A, "First video");
  const pinned = core.normalizeSelection({ ...base, scope: "self", channelId: A });
  core.persistReport(pinned, report("countries"), {}, table([{ country: "VN", views: 70 }]));
  core.persistReport(pinned, report("devices"), {}, table([{ deviceType: "MOBILE", views: 60 }]));
  failAttempt(pinned, "devices", "Quota exceeded");
  failAttempt(pinned, "trafficSources", "Backend error");
  core.persistReport(pinned, report("videos"), {}, { columnHeaders: [], rows: [], coverage: { rowCount: 0 } });
  // Another owner with its own facts, ledger, inventory and snapshot: none of it may leak into read-owner answers.
  w.writeFacts(db, { ownerId: OTHER, entityKey: "owner:claimed", rows: [{ day: START, metrics: { views: 999999 } }], mode: "append", source: "daily", jobId: "job-other", now: T1 });
  w.writeFacts(db, { ownerId: OTHER, entityKey: "owner:claimed", rows: [{ day: START, metrics: { views: 1 } }], mode: "append", source: "daily", jobId: "job-other", now: T2 });
  w.markCoverage(db, { ownerId: OTHER, entityKey: "owner:claimed", days: [START], jobId: "job-other", now: T1 });
  core.persistReport(core.normalizeSelection({ ...base, ownerId: OTHER, scope: "claimed" }), report("videos"), {}, table([{ video: "vid00000002", views: 999999 }]));
  const insertJob = db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,completed,created_by,kind,mode,result_json,created_at,finished_at) VALUES(?,?,?,'completed',10,10,?,?,?,?,?,?)");
  const counts = (drift) => JSON.stringify({ counts: { inserted: 8, updated: 0, enriched: 0, unchanged: 0, drift, skipped: 0, failed: 0 }, days: { requested: 8, covered: 8, added: [], drifted: [] } });
  insertJob.run("job-daily-1", OWNER, JSON.stringify({ kind: "daily", ownerId: OWNER, monetary: true, canMonetary: true, requestedBy: "schedule" }), 1, "daily", "append", counts(0), T1, T1);
  insertJob.run("job-daily-2", OWNER, JSON.stringify({ kind: "daily", ownerId: OWNER, monetary: false, canMonetary: true, requestedBy: "schedule" }), 1, "daily", "append", counts(1), T2, T2);
  insertJob.run("job-full-1", OWNER, JSON.stringify({ kind: "full", mode: "overwrite", ownerId: OWNER, startDate: START, endDate: END, scopes: ["claimed"], channelMode: "none", channelIds: [], includeBreakdowns: false, includeSnapshots: false, monetary: true, canMonetary: true, requestedBy: "user" }), 5, "full", "overwrite", counts(0), T3, T3);
  insertJob.run("job-other", OTHER, JSON.stringify({ kind: "daily", ownerId: OTHER, monetary: false, canMonetary: false, requestedBy: "schedule" }), 1, "daily", "append", counts(0), T1, T1);
  db.prepare("INSERT INTO analytic_schedules(owner_id,enabled,lookback_days,scope,monetary,created_by,next_run_at,times_json,timezone) VALUES(?,1,7,'claimed',1,1,?,?,'Asia/Bangkok')")
    .run(OWNER, scheduler.nextSlot(new Date(), ["09:00"]), JSON.stringify(["09:00"]));
  // The latest 09:00 slot ran on time: its job started one minute after the slot (late = started > 15 minutes after the slot).
  const slot = scheduler.latestSlot(new Date(), ["09:00"]);
  db.prepare("INSERT INTO analytic_schedule_runs(owner_id,scheduled_for,status,attempts,job_id) VALUES(?,?,'queued',1,'job-daily-2')").run(OWNER, slot);
  db.prepare("UPDATE analytic_jobs SET started_at=? WHERE id='job-daily-2'").run(new Date(Date.parse(slot) + 60000).toISOString());
}
seed();
let server; let port;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/analytics", routes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); port = server.address().port;
});
after(async () => {
  axios.get = originalGet; core.stopWorker();
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close(); fs.rmSync(tempDir, { recursive: true, force: true });
});
// CSV answers come back as text (fetch strips the BOM there) or as raw bytes with { raw: true }.
async function request(userId, route, method = "GET", body, { raw = false } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/analytics${route}`, { method,
    headers: { ...(userId ? { Authorization: `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET)}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const type = response.headers.get("content-type") || "";
  return { status: response.status, headers: response.headers, body: type.includes("application/json") ? await response.json() : type.includes("text/csv") && !raw ? await response.text() : Buffer.from(await response.arrayBuffer()) };
}
const query = (extra = {}) => new URLSearchParams({ ...base, ...extra }).toString();
const hasMonetaryKey = (text) => [...w.MONETARY_KEYS].filter((key) => text.includes(`"${key}"`));
async function csv(service, params, access) {
  const file = await service.exportData(params, access);
  const text = [...file.stream].join("");
  const lines = text.split("\r\n").map((line) => (line.charCodeAt(0) === 0xfeff ? line.slice(1) : line));
  return { file, text, header: cells(lines[0]), rows: lines.slice(1).map(cells) };
}
const cells = (line) => line.slice(1, -1).split('","').map((cell) => cell.replace(/""/g, '"'));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);

test("bootstrap lists owners with coverage and the daily run, role permissions, a label-free catalog, limits and database stats", () => {
  const result = reads.bootstrap(ADMIN);
  const owner = result.owners.find((entry) => entry.ownerId === OWNER);
  assert.deepEqual(owner.coverage, { firstDay: START, lastDay: "2026-10-08", days: 8, lastSyncedAt: T1 });
  assert.deepEqual([owner.dailyRun.status, owner.dailyRun.jobId, owner.dailyRun.counts.drift, owner.dailyRun.consecutiveFailures, owner.dailyRun.late, owner.dailyRun.firstError], ["completed", "job-daily-2", 1, 0, false, null]);
  assert.equal(owner.dailyRun.enabled, true); assert.match(owner.dailyRun.scheduledFor, /T0?2:00:00\.000Z$/);
  assert.deepEqual([owner.hasAnalyticsScope, owner.hasMonetaryScope, owner.authStatus, owner.authError, owner.name], [true, true, "connected", null, "Read Owner"]);
  const other = result.owners.find((entry) => entry.ownerId === OTHER);
  assert.deepEqual([other.dailyRun.status, other.dailyRun.scheduledFor, other.dailyRun.enabled, other.coverage.days, other.hasAnalyticsScope], ["not-run", null, false, 1, false]);
  // The stored CMS auth reason travels to the UI (never a token); the request caps are the engine's own parsed values.
  assert.deepEqual([other.authStatus, other.authError], ["error", "invalid_grant"]);
  assert.deepEqual([result.defaults.channelBatch, result.limits.maxRequestsPerJob], [engineLib.effectiveLimits().channelBatch, engineLib.effectiveLimits().maxRequestsPerJob]);
  assert.deepEqual(result.permissions, { canMonetary: true, canSync: true, canOverwrite: true, canManageSchedules: true });
  assert.equal(result.catalog.metrics, w.METRIC_REGISTRY);
  assert.equal(result.catalog.breakdownDimensions.length, 11);
  assert.ok(result.catalog.reportCatalog.every((entry) => !("label" in entry) && !("description" in entry) && typeof entry.id === "string"));
  assert.equal(result.catalog.reportCatalog.find((entry) => entry.id === "channels").default, false);
  assert.deepEqual(Object.keys(result.limits).sort(), ["interactiveRows", "maxChannelIds", "maxDays", "maxExportRows", "maxRequestsPerJob", "maxWorkbookRows", "topVideos"]);
  assert.deepEqual([result.limits.maxExportRows, result.limits.maxDays, result.limits.maxChannelIds], [100000, 366, 200]);
  assert.deepEqual([result.database.isolated, result.database.name, result.database.facts > 0, result.database.coverageRows > 0, result.database.sizeBytes > 0], [true, "analytics.sqlite", true, true, true]);
  assert.match(result.latestAllowedDay, /^\d{4}-\d{2}-\d{2}$/); assert.ok(result.latestAllowedDay < new Date().toISOString().slice(0, 10));
  assert.deepEqual([result.defaults.timezone, result.defaults.lagDays, result.defaults.channelBatch], ["Asia/Bangkok", 3, 200]);
  assert.ok(Array.isArray(result.defaults.scheduleTimes) && result.defaults.scheduleTimes.every((time) => /^\d{2}:\d{2}$/.test(time)));
  const limited = reads.bootstrap(CONTENT_ID);
  assert.equal(limited.catalog.reportCatalog.some((entry) => entry.monetary), false);
  assert.deepEqual(limited.permissions, { canMonetary: false, canSync: true, canOverwrite: false, canManageSchedules: true });
  for (const secret of ["private-refresh-token", "ya29.", "cms_refresh_token", "@example.com"]) assert.equal(JSON.stringify(result).includes(secret), false, secret);
});

test("owner overview sums the stored days, reports coverage with stale days and notes, serves breakdowns and range reports, and drops unknown channel IDs", () => {
  const result = reads.overview({ ...base, scope: "claimed", channelIds: Z }, ADMIN);
  assert.deepEqual(result.selection, { ownerId: OWNER, startDate: START, endDate: END, scope: "claimed", channelIds: [], entity: "owner", currency: "USD", unknownChannelIds: [Z] });
  assert.equal(result.summary.current.views, 8036);
  close(result.summary.current.estimatedRevenue, REVENUE * 5 + 999.99);
  assert.equal(result.summary.current.netSubscribers, 32); close(result.summary.current.watchHours, (5000 * 8 + 36) / 60);
  assert.deepEqual([result.summary.coverage, result.summary.previousCoverage, result.summary.previousRange], [{ covered: 8, total: 10 }, { covered: 0, total: 10 }, { startDate: "2026-09-21", endDate: "2026-09-30" }]);
  assert.equal(result.summary.changes.views, null); assert.equal(result.summary.partialRevenue, true);
  assert.equal(result.series.length, 10); assert.equal(result.series[8].metrics, null); assert.equal(result.series[2].metrics.views, 1003);
  assert.equal(result.previousSeries.length, 10);
  assert.deepEqual([result.coverage.covered, result.coverage.missing, result.coverage.pending, result.coverage.status, result.coverage.driftDays, result.coverage.lastDay], [8, ["2026-10-09", "2026-10-10"], [], "partial", 1, "2026-10-08"]);
  assert.ok(result.coverage.staleDays > 0); assert.equal(result.coverage.lagDays, 3);
  assert.deepEqual(result.breakdowns.country.rows, [{ value: "VN", metrics: { views: 900 } }, { value: "US", metrics: { views: 300 } }]);
  assert.deepEqual([result.breakdowns.country.status, result.breakdowns.country.coveredDays, result.breakdowns.deviceType.rows[0].value, result.breakdowns.sharingService.status], ["partial", 2, "MOBILE", "missing"]);
  assert.equal(result.breakdowns.adType.rows[0].metrics.grossRevenue, 10);
  assert.deepEqual([result.topVideos.status, result.topVideos.empty, result.topVideos.rows[0].video, result.videoRevenue.rows[0].estimatedRevenue, result.demographics.rows[0].gender], ["ready", false, "vid00000001", 3.5, "female"]);
  assert.deepEqual(result.videos, [{ videoId: "vid00000001", channelId: A, title: "First video", thumbnail: null, duration: "PT3M", publishedAt: "2026-09-01T00:00:00Z" }]);
  assert.deepEqual([result.dailyRun.status, result.latestJob.id], ["completed", "job-full-1"]);
  for (const note of [NOTES.missing, NOTES.drift, NOTES.partialRevenue]) assert.ok(result.notes.includes(note), note);
  assert.equal(result.notes.includes(NOTES.pending), false);
  const plain = reads.overview({ ...base, compare: "false" }, ADMIN);
  assert.deepEqual([plain.previousSeries, plain.summary.previous, plain.summary.changes], [null, null, null]);
  assert.equal(JSON.stringify(result).includes("999999"), false);
});

test("one channel reads its breakdowns from the pinned snapshots with the status mapping; several channels are unsupported", () => {
  const single = reads.overview({ ...base, channelIds: A }, ADMIN);
  assert.deepEqual([single.selection.entity, single.summary.current.views, single.coverage.covered], ["channel", 836, 8]);
  const country = single.breakdowns.country;
  assert.deepEqual([country.status, country.source, country.coveredDays, country.totalDays, country.rows], ["ready", "snapshot", 10, 10, [{ value: "VN", metrics: { views: 70 } }]]);
  assert.deepEqual([single.breakdowns.deviceType.status, single.breakdowns.deviceType.stale, single.breakdowns.deviceType.error], ["ready", true, "Quota exceeded"]);
  assert.deepEqual([single.breakdowns.insightTrafficSourceType.status, single.breakdowns.insightTrafficSourceType.error, single.breakdowns.insightTrafficSourceType.rows], ["missing", "Backend error", []]);
  assert.deepEqual([single.breakdowns.liveOrOnDemand.status, single.breakdowns.adType.status, single.breakdowns.sharingService.status], ["unsupported", "unsupported", "unsupported"]);
  assert.deepEqual([single.topVideos.status, single.topVideos.empty, single.topVideos.rows, single.demographics.status], ["ready", true, [], "missing"]);
  assert.ok(single.notes.includes(NOTES.channelSnapshots));
  const several = reads.overview({ ...base, channelIds: `${A},${B}` }, ADMIN);
  assert.deepEqual([several.selection.entity, several.summary.current.views, several.coverage.covered, several.coverage.status], ["channels", 936, 8, "partial"]);
  assert.ok(Object.values(several.breakdowns).every((panel) => panel.status === "unsupported" && panel.totalDays === 10));
  assert.deepEqual([several.topVideos.status, several.videos], ["unsupported", []]);
  assert.ok(several.notes.includes(NOTES.channelsBreakdowns));
  assert.equal("adType" in reads.overview({ ...base, channelIds: A }, CONTENT_ID).breakdowns, false);
});

test("the channels table pages, sorts, searches and filters the managed inventory with coverage statuses; other owners never appear", () => {
  const list = reads.channels({ ...base, sort: "-views" }, ADMIN);
  assert.deepEqual(list.rows.map((row) => row.channelId), [A, B, C]);
  assert.deepEqual([list.total, list.page, list.pageSize, list.sort], [3, 1, 50, { key: "views", direction: "desc" }]);
  const [alpha, beta, gamma] = list.rows;
  assert.deepEqual([alpha.metrics.views, alpha.coveredDays, alpha.daysWithRows, alpha.totalDays, alpha.monetaryDays, alpha.status, alpha.monetaryStatus, alpha.firstDay, alpha.subscribersTotal], [836, 8, 8, 10, 4, "partial", "partial", START, 1000]);
  assert.deepEqual([beta.removedAt, beta.monetaryStatus, beta.subscribersTotal, beta.metrics.views], [T2, "missing", null, 100]);
  assert.deepEqual([gamma.metrics, gamma.daysWithRows, gamma.status, gamma.title, gamma.country], [null, 0, "partial", HOSTILE, "US"]);
  assert.deepEqual([list.totals.views, list.totals.rpmChannelCount, list.totalsMeta.coverage, list.totals.netSubscribers], [936, 1, { covered: 8, total: 10 }, 16]);
  assert.deepEqual(list.coverage, { inventoryCount: 3, activeCount: 2, withData: 2, inventoryUpdatedAt: T1 });
  assert.equal(list.latestJob.id, "job-full-1"); assert.ok(list.notes.includes(NOTES.publicCounts));
  assert.deepEqual(reads.channels({ ...base, sort: "views", direction: "asc" }, ADMIN).rows.map((row) => row.channelId), [B, A, C]);
  assert.deepEqual(reads.channels({ ...base }, ADMIN).rows.map((row) => row.title), [HOSTILE, "Alpha", "Kênh Beta"]);
  assert.deepEqual(reads.channels({ ...base, search: "kenh BETA" }, ADMIN).rows.map((row) => row.channelId), [B]);
  assert.deepEqual(reads.channels({ ...base, search: C.slice(5, 12) }, ADMIN).rows.map((row) => row.channelId), [C]);
  assert.deepEqual([reads.channels({ ...base, country: "us" }, ADMIN).total, reads.channels({ ...base, status: "missing" }, ADMIN).total, reads.channels({ ...base, status: "partial" }, ADMIN).total], [1, 0, 3]);
  const paged = reads.channels({ ...base, sort: "-views", page: "2", pageSize: "2" }, ADMIN);
  assert.deepEqual([paged.rows.map((row) => row.channelId), paged.total], [[C], 3]);
  const picked = reads.channels({ ...base, channelIds: `${A},${Z}` }, ADMIN);
  assert.deepEqual([picked.rows.map((row) => row.channelId), picked.unknownChannelIds, picked.totals.views, picked.coverage.inventoryCount], [[A], [Z], 836, 3]);
  const limited = reads.channels({ ...base }, CONTENT_ID);
  assert.ok(limited.rows.every((row) => row.monetaryStatus === "hidden")); assert.equal("rpmChannelCount" in limited.totals, false);
  assert.deepEqual(hasMonetaryKey(JSON.stringify(limited)), []);
  assert.throws(() => reads.channels({ ...base, sort: "estimatedRevenue" }, CONTENT_ID), (error) => error.status === 403);
  assert.throws(() => reads.channels({ ...base, sort: "rowid" }, ADMIN), (error) => error.status === 400 && /sort must be one of/.test(error.message));
  assert.throws(() => reads.channels({ ...base, pageSize: "201" }, ADMIN), (error) => error.status === 400);
  assert.equal(JSON.stringify(list).includes("Other private channel"), false);
  assert.deepEqual(reads.channelsInventory({ ownerId: OWNER }).channels.map((row) => row.channelId), [C, A, B]);
  assert.deepEqual(reads.channelsInventory({ ownerId: OWNER }).channels.find((row) => row.channelId === B).removedAt, T2);
});

test("channel detail validates the ID, 404s outside the owner's inventory and reports the channel's coverage statuses", () => {
  const detail = reads.channelDetail(A, base, ADMIN);
  assert.deepEqual([detail.channel.title, detail.channel.metrics.views, detail.channel.status, detail.channel.monetaryStatus, detail.channel.coveredDays, detail.channel.daysWithRows, detail.channel.totalDays], ["Alpha", 836, "partial", "partial", 8, 8, 10]);
  assert.deepEqual([detail.selection.entity, detail.selection.scope, detail.summary.current.views, detail.coverage.firstDay, detail.breakdowns.country.rows[0].value, detail.latestJob.id], ["channel", "self", 836, START, "VN", "job-full-1"]);
  assert.equal(detail.coverage.days.filter((day) => day.monetary).length, 4);
  assert.ok(reads.channelDetail(B, base, ADMIN).notes.includes(NOTES.removedChannel));
  assert.equal(reads.channelDetail(C, base, CONTENT_ID).channel.monetaryStatus, "hidden");
  assert.throws(() => reads.channelDetail("invalid-channel", base, ADMIN), (error) => error.status === 400);
  assert.throws(() => reads.channelDetail(Z, base, ADMIN), (error) => error.status === 404);
  assert.throws(() => reads.channelDetail(A, { ...base, ownerId: "unknown-owner" }, ADMIN), (error) => error.status === 404);
  assert.throws(() => reads.channelDetail(A, { ...base, ownerId: ["a", "b"] }, ADMIN), (error) => error.status === 400 && /single value/.test(error.message));
});

test("the coverage report summarises months, flags drift and revenue, and accepts a channel", () => {
  const owner = reads.coverageReport({ ...base, scope: "claimed" }, ADMIN);
  assert.deepEqual([owner.entityKey, owner.covered, owner.missing, owner.status, owner.lastDay, owner.lastSyncedAt], ["owner:claimed", 8, ["2026-10-09", "2026-10-10"], "partial", "2026-10-08", T1]);
  assert.deepEqual(owner.summaryByMonth, [{ month: "2026-10", covered: 8, total: 10, drift: 1, missing: 2, pending: 0 }]);
  assert.deepEqual(owner.days[0], { day: START, facts: true, monetary: true, breakdowns: ["adType", "country", "creatorContentType", "deviceType"], drift: false, pending: false });
  assert.deepEqual([owner.days[2].drift, owner.days[6].monetary, owner.days[9].facts], [true, false, false]);
  assert.deepEqual(reads.coverageReport({ ...base }, CONTENT_ID).days[0].breakdowns, ["country", "creatorContentType", "deviceType"]);
  const channel = reads.coverageReport({ ...base, channelId: A }, ADMIN);
  assert.deepEqual([channel.entityKey, channel.covered, channel.days[3].monetary, channel.days[4].monetary], [`channel:${A}`, 8, true, false]);
  assert.throws(() => reads.coverageReport({ ...base, channelId: "bad" }, ADMIN), (error) => error.status === 400);
  assert.throws(() => reads.coverageReport({ ...base, scope: "all" }, ADMIN), (error) => error.status === 400);
});

test("the ledger joins jobs and user names (never emails), hides revenue-only changes from Content ID and pages with before/day", () => {
  const full = reads.factHistory({ ownerId: OWNER }, ADMIN);
  assert.equal(full.total, 2); assert.equal(full.entries.length, 2);
  const [overwrite, drift] = full.entries;
  assert.deepEqual([overwrite.action, overwrite.day, overwrite.changedKeys, overwrite.requestedBy, overwrite.createdBy, overwrite.kind, overwrite.mode, overwrite.jobId],
    ["overwrite", "2026-10-04", [{ key: "estimatedRevenue", before: REVENUE, after: 999.99 }], "user", { id: 5, name: "Rita Manager" }, "full", "overwrite", "job-full-1"]);
  assert.deepEqual([drift.action, drift.day, drift.changedKeys, drift.requestedBy, drift.createdBy, drift.kind, drift.mode], ["drift", "2026-10-03", [{ key: "views", before: 1003, after: 5003 }], "schedule", { id: 1, name: "Alice Admin" }, "daily", "append"]);
  assert.equal("ownerId" in overwrite, false);
  assert.equal(JSON.stringify(full).includes("@example.com"), false);
  const limited = reads.factHistory({ ownerId: OWNER }, CONTENT_ID);
  assert.deepEqual([limited.entries.length, limited.entries[0].action, hasMonetaryKey(JSON.stringify(limited))], [1, "drift", []]);
  assert.equal(JSON.stringify(limited).includes(String(REVENUE)), false);
  assert.equal(reads.factHistory({ ownerId: OWNER, day: "2026-10-04" }, ADMIN).entries.length, 1);
  assert.equal(reads.factHistory({ ownerId: OWNER, before: String(overwrite.id) }, ADMIN).entries[0].id, drift.id);
  assert.equal(reads.factHistory({ ownerId: OWNER, limit: "1" }, ADMIN).entries.length, 1);
  assert.equal(reads.factHistory({ ownerId: OWNER, entityKey: `channel:${A}` }, ADMIN).entries.length, 0);
  assert.deepEqual(reads.factHistory({ ownerId: OTHER }, ADMIN).entries.map((entry) => [entry.entityKey, entry.changedKeys[0].after]), [["owner:claimed", 1]]);
  assert.throws(() => reads.factHistory({ ownerId: OWNER, entityKey: "owner:all" }, ADMIN), (error) => error.status === 400);
  assert.throws(() => reads.factHistory({ ownerId: OWNER, day: "2026-13-01" }, ADMIN), (error) => error.status === 400);
});

test("facts return titled provenance rows; the row caps answer 413 for facts and for Excel workbooks", async () => {
  const rows = reads.facts({ ...base, channelIds: `${A},${B}` }, ADMIN);
  assert.deepEqual([rows.total, rows.rows[0].title, rows.rows[0].channelId, rows.rows[0].day, rows.rows[0].revision, rows.rows[0].source, rows.selection.entity], [10, "Alpha", A, START, 1, "daily", "channels"]);
  const owner = reads.facts({ ...base }, CONTENT_ID);
  assert.deepEqual([owner.total, owner.rows[0].entityKey, owner.rows[0].title, owner.rows[3].revision, hasMonetaryKey(JSON.stringify(owner))], [8, "owner:claimed", null, 2, []]);
  const small = createReadService({ db, warehouse: w, core, limits: { maxExportRows: 3, maxWorkbookRows: 2 } });
  assert.throws(() => small.facts({ ...base }, ADMIN), (error) => error.status === 413 && error.reason === "tooManyRows");
  await assert.rejects(small.exportData({ ...base, type: "coverage", format: "xlsx" }, ADMIN), (error) => error.status === 413);
  await assert.rejects(small.exportData({ ...base, type: "daily", format: "csv" }, ADMIN), (error) => error.status === 413);
});

test("snapshots follow the public catalog and the status mapping; monetary report IDs are refused for Content ID", () => {
  const admin = reads.snapshots({ ...base, scope: "claimed" }, ADMIN);
  assert.deepEqual([admin.reports.videos.status, admin.reports.videos.rows[0].video, admin.reports.videoRevenue.rows[0].estimatedRevenue, admin.reports.overview.status, admin.reports.overview.empty], ["ready", "vid00000001", 3.5, "missing", false]);
  assert.equal(admin.selection.currency, "USD");
  const limited = reads.snapshots({ ...base, scope: "claimed" }, CONTENT_ID);
  assert.deepEqual([limited.reports.videoRevenue, limited.reports.monetaryDaily, limited.reports.videos.status, hasMonetaryKey(JSON.stringify(limited))], [undefined, undefined, "ready", []]);
  assert.deepEqual(Object.keys(reads.snapshots({ ...base, reportId: "videos" }, ADMIN).reports), ["videos"]);
  const channel = reads.snapshots({ ...base, scope: "self", channelId: A }, ADMIN);
  assert.equal(reads.snapshots({ ...base, channelId: A }, ADMIN).reports.countries.status, "missing");
  assert.deepEqual([channel.reports.countries.rows[0].country, channel.reports.devices.status, channel.reports.devices.stale, channel.reports.devices.error, channel.reports.videos.empty, channel.reports.trafficSources.status], ["VN", "ready", true, "Quota exceeded", true, "missing"]);
  assert.throws(() => reads.snapshots({ ...base, reportId: "nope" }, ADMIN), (error) => error.status === 404);
  assert.throws(() => reads.snapshots({ ...base, reportId: "videoRevenue" }, CONTENT_ID), (error) => error.status === 403);
  assert.equal(JSON.stringify(admin).includes("vid00000002"), false);
});

test("csv exports are streamed with a BOM, localised headers, formula-safe cells and never a monetary column for Content ID", async () => {
  const daily = await csv(reads, { ...base, type: "daily", format: "csv" }, ADMIN);
  assert.deepEqual([daily.file.filename, daily.file.contentType, daily.text.charCodeAt(0), daily.rows.length], ["analytics-daily-read-owner-2026-10-01-2026-10-10.csv", "text/csv; charset=utf-8", 0xfeff, 10]);
  for (const label of ["Day (Pacific time)", "Status", "Views", "Estimated revenue (USD)", "First synced (GMT+7)", "Last synced (GMT+7)", "Revision", "Source"]) assert.ok(daily.header.includes(label), label);
  const at = (table, label) => table.header.indexOf(label);
  assert.deepEqual([daily.rows[0][at(daily, "Day (Pacific time)")], daily.rows[0][at(daily, "Status")], daily.rows[0][at(daily, "Views")], daily.rows[0][at(daily, "First synced (GMT+7)")], daily.rows[8][at(daily, "Status")], daily.rows[8][at(daily, "Views")]],
    [START, "Stored", "1001", "2026-10-12 09:00", "Missing", ""]);
  assert.deepEqual([daily.rows[3][at(daily, "Revision")], daily.rows[3][at(daily, "Source")], daily.rows[3][at(daily, "Estimated revenue (USD)")]], ["2", "Sync all", "999.99"]);
  const vi = await csv(reads, { ...base, type: "daily", format: "csv", lang: "vi" }, CONTENT_ID);
  assert.ok(vi.header.includes("Lượt xem") && vi.header.includes("Ngày (giờ Thái Bình Dương)"));
  assert.deepEqual(vi.header.filter((label) => /USD|RPM|CPM/.test(label)), []);
  assert.equal(vi.text.includes(String(REVENUE)), false); assert.equal(vi.rows[0][vi.header.indexOf("Trạng thái")], "Đã lưu");
  const channels = await csv(reads, { ...base, type: "channels", format: "csv", sort: "-views" }, ADMIN);
  assert.equal(channels.rows.length, 3);
  assert.ok(channels.text.includes(`"'=HYPERLINK(""https://evil.example"")"`));
  assert.deepEqual([channels.rows[1][at(channels, "No longer managed")], channels.rows[0][at(channels, "Revenue status")], channels.rows[0][at(channels, "Views")]], ["Yes", "Partial", "836"]);
  const channelDays = await csv(reads, { ...base, type: "channel-days", format: "csv", channelId: A }, ADMIN);
  assert.deepEqual([channelDays.rows.length, channelDays.rows[0][at(channelDays, "Channel ID")], channelDays.rows[0][at(channelDays, "Channel")], channelDays.file.filename], [8, A, "Alpha", "analytics-channel-days-read-owner-2026-10-01-2026-10-10.csv"]);
  assert.equal((await csv(reads, { ...base, type: "channel-days", format: "csv" }, CONTENT_ID)).rows.length, 10);
  const country = await csv(reads, { ...base, type: "breakdown", dimension: "country", format: "csv", lang: "vi" }, ADMIN);
  assert.deepEqual([country.file.filename, country.header.slice(0, 2), country.rows[0].slice(0, 2), country.rows[0][country.header.indexOf("Tỷ trọng (%)")]], ["analytics-breakdown-country-read-owner-2026-10-01-2026-10-10.csv", ["Quốc gia", "Mã"], ["Việt Nam", "VN"], "75"]);
  const videos = await csv(reads, { ...base, type: "top-videos", format: "csv" }, CONTENT_ID);
  assert.deepEqual(videos.rows[0].slice(0, 4), ["vid00000001", "First video", "Alpha", "2026-09-01"]);
  const revenue = await csv(reads, { ...base, type: "video-revenue", format: "csv" }, ADMIN);
  assert.ok(revenue.header.includes("Estimated revenue (USD)")); assert.equal(revenue.rows[0][revenue.header.indexOf("Estimated revenue (USD)")], "3.5");
  const demographics = await csv(reads, { ...base, type: "demographics", format: "csv" }, ADMIN);
  assert.deepEqual(demographics.rows[0], ["18–24", "Female", "40.5"]);
  const coverage = await csv(reads, { ...base, type: "coverage", format: "csv" }, ADMIN);
  assert.deepEqual([coverage.rows.length, coverage.rows[0][at(coverage, "Stored")], coverage.rows[0][at(coverage, "Revenue included")], coverage.rows[2][at(coverage, "Drift")], coverage.rows[9][at(coverage, "Stored")]], [10, "Yes", "Yes", "Yes", "No"]);
  assert.equal((await csv(reads, { ...base, type: "coverage", format: "csv" }, CONTENT_ID)).header.includes("Revenue included"), false);
  const history = await csv(reads, { ...base, type: "history", format: "csv" }, ADMIN);
  assert.deepEqual([history.rows.length, history.rows[0][at(history, "Changed by")], history.rows[0][at(history, "Action")], history.rows[1][at(history, "Changed keys")], history.rows[0][at(history, "Mode")]], [2, "Rita Manager", "Overwrite", "Views: 1003 → 5003", "Overwrite"]);
  assert.equal((await csv(reads, { ...base, type: "history", format: "csv" }, CONTENT_ID)).rows.length, 1);
  for (const params of [{ type: "overview", format: "csv" }, { type: "revenue", format: "csv" }, { type: "nope" }, { type: "daily", format: "pdf" }, { type: "daily", lang: "fr" }, { type: "breakdown", dimension: "video" }, { type: "breakdown" }]) {
    await assert.rejects(reads.exportData({ ...base, ...params }, ADMIN), (error) => error.status === 400, JSON.stringify(params));
  }
  await assert.rejects(reads.exportData({ ...base, type: "video-revenue" }, CONTENT_ID), (error) => error.status === 403);
  await assert.rejects(reads.exportData({ ...base, type: "breakdown", dimension: "adType" }, CONTENT_ID), (error) => error.status === 403);
  await assert.rejects(reads.exportData({ ...base, type: "channel-days", channelId: Z }, ADMIN), (error) => error.status === 404);
});

test("xlsx exports carry a Summary sheet, localised sheet names, typed numeric cells and plain-string titles", async () => {
  const overview = await reads.exportData({ ...base, type: "overview", format: "xlsx", lang: "vi" }, ADMIN);
  assert.equal(overview.filename, "analytics-overview-read-owner-2026-10-01-2026-10-10.xlsx");
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(overview.buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name).slice(0, 4), ["Summary", "Theo ngày", "Kênh", "Nguồn truy cập"]);
  assert.ok(workbook.worksheets.map((sheet) => sheet.name).includes("Loại quảng cáo")); assert.equal(workbook.worksheets.length, 14);
  const daily = workbook.getWorksheet("Theo ngày");
  assert.equal(daily.getRow(1).getCell(1).value, "Ngày (giờ Thái Bình Dương)"); assert.equal(daily.getRow(1).font.bold, true);
  const viewsColumn = daily.getRow(1).values.indexOf("Lượt xem");
  assert.deepEqual([daily.getRow(2).getCell(viewsColumn).type, daily.getRow(2).getCell(viewsColumn).value, daily.getRow(12).getCell(viewsColumn).value, daily.getRow(12).font.bold], [ExcelJS.ValueType.Number, 1001, 8036, true]);
  const percentColumn = daily.getRow(1).values.indexOf("Tỷ lệ xem trung bình");
  assert.deepEqual([daily.getRow(2).getCell(percentColumn).value, daily.getRow(2).getCell(percentColumn).numFmt], [0.255, "0.0%"]);
  const channels = workbook.getWorksheet("Kênh");
  const titles = [2, 3, 4].map((row) => channels.getRow(row).getCell(1).value);
  assert.ok(titles.includes(HOSTILE)); assert.ok([2, 3, 4].every((row) => channels.getRow(row).getCell(1).type === ExcelJS.ValueType.String));
  const summary = workbook.getWorksheet("Summary");
  assert.equal(summary.getRow(2).getCell(2).value, "Tổng quan Analytics"); assert.equal(summary.getRow(3).getCell(2).value, OWNER);
  const revenue = await reads.exportData({ ...base, type: "revenue", format: "xlsx" }, ADMIN);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(revenue.buffer);
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ["Summary", "Daily revenue", "By channel", "By country", "By content type", "By ad type"]);
  const money = book.getWorksheet("Daily revenue"); const revenueColumn = money.getRow(1).values.indexOf("Estimated revenue (USD)");
  assert.deepEqual([money.getRow(2).getCell(revenueColumn).value, money.getRow(2).getCell(revenueColumn).numFmt, money.getRow(9).getCell(revenueColumn).value], [REVENUE, '"$"#,##0.00', null]);
  assert.equal(book.getWorksheet("By channel").getRow(2).getCell(1).value, "Alpha");
  await assert.rejects(reads.exportData({ ...base, type: "revenue", format: "xlsx" }, CONTENT_ID), (error) => error.status === 403);
  const limited = await reads.exportData({ ...base, type: "channels", format: "xlsx" }, CONTENT_ID);
  const plain = new ExcelJS.Workbook(); await plain.xlsx.load(limited.buffer);
  assert.equal(plain.getWorksheet("Channels").getRow(1).values.some((label) => /USD|RPM|Revenue status/.test(String(label))), false);
});

const col = (table, label) => table.header.indexOf(label);
test("single-entity exports follow the one channel of the global filter and refuse several or only-unknown channels", async () => {
  const owner = await csv(reads, { ...base, type: "top-videos", format: "csv" }, ADMIN);
  const pinned = await csv(reads, { ...base, type: "top-videos", format: "csv", channelIds: A }, ADMIN);
  assert.deepEqual([owner.rows.length, pinned.rows.length], [1, 0]);
  const country = await csv(reads, { ...base, type: "breakdown", dimension: "country", format: "csv", channelIds: A }, ADMIN);
  assert.deepEqual([country.rows.length, country.rows[0].slice(0, 2), country.rows[0][col(country, "Views")]], [1, ["Vietnam", "VN"], "70"]);
  assert.equal((await csv(reads, { ...base, type: "demographics", format: "csv", channelIds: A }, ADMIN)).rows.length, 0);
  const coverage = await csv(reads, { ...base, type: "coverage", format: "csv", channelIds: A }, ADMIN);
  const byId = await csv(reads, { ...base, type: "coverage", format: "csv", channelId: A }, ADMIN);
  assert.deepEqual(coverage.rows, byId.rows);
  assert.deepEqual([coverage.rows[3][col(coverage, "Revenue included")], coverage.rows[4][col(coverage, "Revenue included")]], ["Yes", "No"]);
  // `channelId` wins over the filter; a known + unknown mix uses the known channel; several channels export both channel-day sets.
  assert.equal((await csv(reads, { ...base, type: "breakdown", dimension: "country", format: "csv", channelId: A, channelIds: `${A},${B}` }, ADMIN)).rows[0][col(country, "Views")], "70");
  assert.equal((await csv(reads, { ...base, type: "breakdown", dimension: "country", format: "csv", channelIds: `${A},${Z}` }, ADMIN)).rows[0][col(country, "Views")], "70");
  assert.equal((await csv(reads, { ...base, type: "channel-days", format: "csv", channelIds: `${A},${B}` }, ADMIN)).rows.length, 10);
  for (const type of ["breakdown", "top-videos", "demographics", "coverage"]) {
    await assert.rejects(reads.exportData({ ...base, type, dimension: "country", format: "csv", channelIds: `${A},${B}` }, ADMIN), (error) => error.status === 400 && error.message === "Select one channel or none for this export.", type);
  }
  for (const type of ["daily", "channels", "channel-days", "breakdown", "top-videos", "demographics", "coverage", "overview"]) {
    await assert.rejects(reads.exportData({ ...base, type, dimension: "country", format: type === "overview" ? "xlsx" : "csv", channelIds: `${Z},UC${"y".repeat(22)}` }, ADMIN),
      (error) => error.status === 400 && error.message.includes(Z) && error.message.includes(`UC${"y".repeat(22)}`) && /Unknown channel IDs/.test(error.message), type);
  }
  assert.equal(reads.overview({ ...base, channelIds: Z }, ADMIN).selection.entity, "owner");
});

test("the history export binds the range before the 1,000-row cap and says when the cap cut rows; /history accepts day bounds", async () => {
  const capped = createReadService({ db, warehouse: w, core, limits: { maxHistoryLimit: 1 } });
  const whole = await csv(capped, { ...base, type: "history", format: "csv" }, ADMIN);
  assert.deepEqual([whole.rows.length, whole.rows[0][col(whole, "Action")], whole.rows[0][col(whole, "Day (Pacific time)")]], [1, "Overwrite", "2026-10-04"]);
  const older = await csv(capped, { ...base, endDate: "2026-10-03", type: "history", format: "csv" }, ADMIN);
  assert.deepEqual([older.rows.length, older.rows[0][col(older, "Action")]], [1, "Drift"]);
  const note = (params) => capped.exportData(params, ADMIN).then(async (file) => { const book = new ExcelJS.Workbook(); await book.xlsx.load(file.buffer); return book.getWorksheet("Summary").getSheetValues().flat().map(String).join("\n"); });
  assert.match(await note({ ...base, type: "history", format: "xlsx" }), /holds 2 entries in this range; only the newest 1 are exported/);
  assert.match(await note({ ...base, type: "history", format: "xlsx", lang: "vi" }), /có 2 mục trong khoảng này; chỉ 1 mục mới nhất/);
  assert.doesNotMatch(await note({ ...base, endDate: "2026-10-03", type: "history", format: "xlsx" }), /only the newest/);
  assert.equal(reads.factHistory({ ownerId: OWNER, startDate: "2026-10-03", endDate: "2026-10-03" }, ADMIN).entries.map((entry) => entry.action).join(), "drift");
  assert.equal(reads.factHistory({ ownerId: OWNER, startDate: "2026-10-04" }, ADMIN).entries.map((entry) => entry.action).join(), "overwrite");
  assert.deepEqual([reads.factHistory({ ownerId: OWNER, endDate: "2026-10-04" }, ADMIN).total, reads.factHistory({ ownerId: OWNER, endDate: "2026-10-02" }, ADMIN).total], [2, 0]);
  assert.throws(() => reads.factHistory({ ownerId: OWNER, startDate: "2026-10-05", endDate: "2026-10-04" }, ADMIN), (error) => error.status === 400 && /startDate must not be after endDate/.test(error.message));
  assert.throws(() => reads.factHistory({ ownerId: OWNER, startDate: "yesterday" }, ADMIN), (error) => error.status === 400);
});

test("non-monetary answers omit the revenue bookkeeping fields (currency, partialRevenue, monetaryCoverage)", () => {
  const limited = reads.overview({ ...base }, CONTENT_ID);
  assert.equal("currency" in limited.selection, false);
  for (const key of ["partialRevenue", "monetaryCoverage"]) assert.equal(key in limited.summary, false, key);
  const table = reads.channels({ ...base }, CONTENT_ID);
  assert.deepEqual([Object.keys(table.totalsMeta).sort(), "currency" in table.selection], [["approx", "coverage"], false]);
  assert.equal("currency" in reads.channelDetail(A, base, CONTENT_ID).selection, false);
  assert.equal("currency" in reads.facts({ ...base }, CONTENT_ID).selection, false);
  const admin = reads.overview({ ...base }, ADMIN);
  assert.deepEqual([admin.selection.currency, admin.summary.partialRevenue, typeof admin.summary.monetaryCoverage.monetaryDays], ["USD", true, "number"]);
  assert.deepEqual(Object.keys(reads.channels({ ...base }, ADMIN).totalsMeta).sort(), ["approx", "coverage", "monetaryCoverage", "partialRevenue"]);
});

// Every sheet name and every cell of every sheet (Summary notes included) as strings.
async function workbookCells(buffer) {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  const cells = [];
  for (const sheet of workbook.worksheets) { cells.push(sheet.name); sheet.eachRow((row) => row.eachCell({ includeEmpty: false }, (cell) => cells.push(cell.value))); }
  return cells.map((value) => (value instanceof Date ? value.toISOString() : value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "")));
}
const REVENUE_TEXT = /USD|RPM|CPM|revenue|doanh thu|quảng cáo/i;
const REVENUE_NUMBERS = [String(REVENUE), "999.99", "888.88", "12.34"];
const XLSX_TYPES = ["overview", "daily", "channels", "channel-days", "breakdown", "coverage", "history"];
test("Content ID workbooks carry no revenue word or amount in any sheet or cell, in both languages, locally and over HTTP", async () => {
  const scan = (cells, label) => {
    const text = cells.filter((cell) => REVENUE_TEXT.test(cell));
    assert.deepEqual(text, [], `${label}: ${text.join(" | ")}`);
    for (const needle of REVENUE_NUMBERS) assert.equal(cells.some((cell) => cell.includes(needle)), false, `${label} leaks ${needle}`);
    assert.ok(cells.length > 2, `${label} is empty`);
  };
  for (const lang of ["en", "vi"]) {
    for (const type of XLSX_TYPES) {
      const params = { ...base, type, format: "xlsx", lang, ...(type === "breakdown" ? { dimension: "creatorContentType" } : {}) };
      scan(await workbookCells((await reads.exportData(params, CONTENT_ID)).buffer), `${type} ${lang}`);
      const response = await request(2, `/export?${query(params)}`, "GET", undefined, { raw: true });
      assert.equal(response.status, 200, `${type} ${lang}`);
      scan(await workbookCells(response.body), `HTTP ${type} ${lang}`);
    }
  }
  // The same admin workbooks do carry revenue, so the scan is known to bite.
  const admin = await workbookCells((await reads.exportData({ ...base, type: "breakdown", dimension: "creatorContentType", format: "xlsx" }, ADMIN)).buffer);
  assert.ok(admin.some((cell) => cell.includes(String(REVENUE))) && admin.some((cell) => REVENUE_TEXT.test(cell)));
});

test("HTTP: a Content ID role never receives a monetary key, a revenue amount or a credential from any read route or CSV export", async () => {
  const routes = [`/bootstrap`, `/overview?${query({ scope: "claimed" })}`, `/overview?${query({ channelIds: A })}`, `/channels/inventory?ownerId=${OWNER}`, `/channels?${query()}`, `/channels/${A}?${query()}`,
    `/coverage?${query()}`, `/history?ownerId=${OWNER}`, `/facts?${query()}`, `/snapshots?${query()}`, `/jobs/job-full-1`, `/schedules`, `/queries?ownerId=${OWNER}`,
    ...["daily", "channels", "channel-days", "coverage", "history", "top-videos", "demographics"].map((type) => `/export?${query({ type, format: "csv" })}`), `/export?${query({ type: "breakdown", dimension: "country", format: "csv" })}`];
  for (const route of routes) {
    const response = await request(2, route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "no-store", route);
    const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    assert.deepEqual(hasMonetaryKey(text), [], route);
    if (typeof response.body === "string") assert.equal(/USD|RPM|CPM|Revenue status/.test(response.body), false, route);
    else if (!route.startsWith("/snapshots")) assert.equal(/"(currency|partialRevenue|monetaryCoverage)"/.test(text), false, `${route} carries revenue bookkeeping`);
    for (const needle of [String(REVENUE), "999.99", "888.88", "12.34", "private-refresh-token", "private-other-token", "ya29.", "cms_refresh_token", "@example.com", "Other private channel", "999999"]) assert.equal(text.includes(needle), false, `${route} leaks ${needle}`);
  }
  const history = await request(2, `/history?ownerId=${OWNER}`);
  assert.deepEqual(history.body.entries.map((entry) => entry.action), ["drift"]);
  assert.equal((await request(2, `/export?${query({ type: "video-revenue", format: "csv" })}`)).status, 403);
  assert.equal((await request(2, `/export?${query({ type: "revenue", format: "xlsx" })}`)).status, 403);
  assert.equal((await request(2, `/export?${query({ type: "breakdown", dimension: "adType", format: "csv" })}`)).status, 403);
  assert.equal((await request(2, `/snapshots?${query({ reportId: "videoRevenue" })}`)).status, 403);
  const admin = await request(1, `/overview?${query({ scope: "claimed" })}`);
  assert.equal(admin.body.summary.current.estimatedRevenue > 0, true);
  assert.equal(JSON.stringify(admin.body).includes("private-refresh-token"), false);
});

test("HTTP: Read Only Report Manager reads revenue but every POST and PUT is refused before any write", async () => {
  const overview = await request(3, `/overview?${query({ scope: "claimed" })}`);
  assert.equal(overview.status, 200); assert.ok(overview.body.summary.current.estimatedRevenue > 0);
  const bootstrap = await request(3, "/bootstrap");
  assert.deepEqual(bootstrap.body.permissions, { canMonetary: true, canSync: false, canOverwrite: false, canManageSchedules: false });
  const jobsBefore = db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs").get().n;
  for (const [route, method, body] of [["/sync", "POST", { ...base, kind: "full", mode: "append" }], ["/query", "POST", { ...base, metrics: "views" }], ["/jobs/job-full-1/cancel", "POST", {}], ["/schedules", "PUT", { ownerId: OWNER, enabled: false }]]) {
    assert.equal((await request(3, route, method, body)).status, 403, route);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs").get().n, jobsBefore);
  assert.equal(db.prepare("SELECT enabled FROM analytic_schedules WHERE owner_id=?").get(OWNER).enabled, 1);
  assert.equal((await request(4, "/bootstrap")).status, 403); assert.equal((await request(null, "/bootstrap")).status, 401);
});

test("HTTP: query validation answers 400 for arrays, bad dates, unknown dimensions and sorts, 404 for unknown owners and channels", async () => {
  for (const route of [`/overview?${query()}&ownerId=${OTHER}`, `/overview?ownerId=${OWNER}&startDate=2026-10-01&endDate=2026-13-01`, `/overview?ownerId=${OWNER}&startDate=2026-10-10&endDate=2026-10-01`,
    `/overview?ownerId=${OWNER}&startDate=2024-01-01&endDate=2026-10-01`, `/overview?${query({ scope: "everything" })}`, `/overview?${query({ channelIds: "nope" })}`, `/overview?${query({ compare: "maybe" })}`,
    `/channels?${query({ pageSize: "0" })}`, `/channels?${query({ sort: "rowid" })}`, `/channels?${query({ country: "VNM" })}`, `/channels?${query({ status: "great" })}`,
    `/export?${query({ type: "daily", format: "csv" })}&format=xlsx`, `/export?${query({ type: "breakdown", dimension: "video", format: "csv" })}`, `/export?${query({ type: "overview", format: "csv" })}`,
    `/history?ownerId=${OWNER}&entityKey=owner:all`, `/history?ownerId=${OWNER}&limit=5000`, `/coverage?${query({ channelId: "bad" })}`, `/facts?${query({ channelIds: "x" })}`,
    `/history?ownerId=${OWNER}&startDate=2026-10-10&endDate=2026-10-01`, `/export?${query({ type: "breakdown", dimension: "country", format: "csv", channelIds: `${A},${B}` })}`, `/export?${query({ type: "daily", format: "csv", channelIds: Z })}`]) {
    const response = await request(1, route);
    assert.equal(response.status, 400, route); assert.equal(response.body.success, false); assert.equal(typeof response.body.message, "string");
  }
  for (const route of [`/overview?${query({ ownerId: "unknown-owner" })}`, `/channels/${Z}?${query()}`, `/snapshots?${query({ reportId: "nope" })}`, `/export?${query({ type: "channel-days", format: "csv", channelId: Z })}`]) {
    assert.equal((await request(1, route)).status, 404, route);
  }
  assert.equal((await request(1, `/channels/not-a-channel?${query()}`)).status, 400);
  assert.equal((await request(1, `/overview?ownerId=${OWNER}&startDate=2026-10-01&endDate=2026-10-10&endDate=2026-10-11`)).status, 400);
});

test("HTTP: unexpected errors answer a generic 500 without details; Google-shaped errors keep their status", async () => {
  const original = core.listQueries;
  core.listQueries = () => { throw new Error("secret internal detail"); };
  try {
    const response = await request(1, `/queries?ownerId=${OWNER}`);
    assert.deepEqual([response.status, response.body.message, response.body.error.reason, JSON.stringify(response.body).includes("secret")], [500, "Internal error", "internalError", false]);
  } finally { core.listQueries = original; }
  core.listQueries = () => { const error = new Error("Quota exceeded"); error.status = 429; error.reason = "quotaExceeded"; throw error; };
  try {
    const response = await request(1, `/queries?ownerId=${OWNER}`);
    assert.deepEqual([response.status, response.body.message, response.body.error.reason], [429, "Quota exceeded", "quotaExceeded"]);
  } finally { core.listQueries = original; }
});

test("HTTP: exports stream CSV and workbooks with attachment headers; the legacy reportId export still answers", async () => {
  const daily = await request(1, `/export?${query({ type: "daily", format: "csv", lang: "vi" })}`, "GET", undefined, { raw: true });
  assert.equal(daily.status, 200); assert.equal(daily.headers.get("content-disposition"), 'attachment; filename="analytics-daily-read-owner-2026-10-01-2026-10-10.csv"');
  assert.equal(daily.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.deepEqual([...daily.body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = daily.body.toString("utf8");
  assert.ok(text.includes("Lượt xem")); assert.equal(text.split("\r\n").length, 11);
  const workbook = await request(1, `/export?${query({ type: "overview", format: "xlsx" })}`);
  assert.equal(workbook.status, 200); assert.equal(workbook.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(workbook.headers.get("content-disposition").endsWith('.xlsx"'));
  const parsed = new ExcelJS.Workbook(); await parsed.xlsx.load(workbook.body);
  assert.equal(parsed.getWorksheet("Daily").getRow(2).getCell(1).value, START);
  const legacy = await request(1, `/export?${query({ scope: "claimed", reportId: "videos" })}`);
  assert.equal(legacy.status, 200); assert.ok(legacy.body.includes('"video","views"')); assert.ok(legacy.body.includes("vid00000001"));
  assert.equal((await request(2, `/export?${query({ scope: "claimed", reportId: "videoRevenue" })}`)).status, 403);
  assert.equal((await request(1, `/export?${query({ scope: "claimed" })}&reportId=videos&reportId=daily`)).status, 400);
});

// These depend on Backend-B1's analyticsService rewrite (listJobs(ownerId, access, limit) and the v2 job sanitiser).
test("HTTP: the job list is scoped to the owner, sanitised per role and limited", async () => {
  const jobs = await request(2, `/jobs?ownerId=${OWNER}&limit=2`);
  assert.equal(jobs.status, 200); assert.deepEqual(jobs.body.jobs.map((job) => job.id), ["job-full-1", "job-daily-2"]);
  assert.deepEqual(hasMonetaryKey(JSON.stringify(jobs.body)), []);
  assert.equal(JSON.stringify((await request(1, `/jobs?ownerId=${OTHER}`)).body).includes("job-full-1"), false);
  assert.equal((await request(1, "/jobs?ownerId=nobody")).status, 404);
});
