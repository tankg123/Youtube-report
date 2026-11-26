const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-analytics-test-"));
process.env.ANALYTICS_DB_PATH = path.join(tempDir, "analytics.sqlite");
const axios = require("axios");
const originalGet = axios.get;
const credentialPath = require.resolve("../src/services/googleContentIdService");
const databasePath = require.resolve("../src/config/database");
const BOTH_SCOPES = "https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/yt-analytics-monetary.readonly";
const network = { id: 991, name: "Test Content Owner", network_code: "owner-test", cms_auth_status: "connected", cms_refresh_token: "never-output-this-token",
  cms_auth_scopes: BOTH_SCOPES, cms_auth_error: null };
let tokenCalls = 0;
let tokenSources = [];
const fakeMainDb = {
  prepare: (sql) => ({ get: () => (/FROM users/.test(sql) ? { id: 1, role: "Report Manager", status: "active" } : network), all: () => [{ id: network.id, name: network.name, network_code: network.network_code,
    cms_auth_status: network.cms_auth_status, cms_auth_scopes: network.cms_auth_scopes, cms_auth_error: network.cms_auth_error, cms_refresh_token: network.cms_refresh_token }] })
};
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: fakeMainDb };
require.cache[credentialPath] = { id: credentialPath, filename: credentialPath, loaded: true, exports: {
  getAccessToken: async (source, options) => { tokenCalls += 1; tokenSources.push({ source, ...options }); return "fake-access-token"; }
} };
const db = require("../src/config/analyticsDatabase");
const service = require("../src/services/analyticsService");
const catalog = require("../src/services/analyticsCatalog").REPORT_CATALOG;
const owner = network;
const input = { ownerId: owner.network_code, startDate: "2025-05-01", endDate: "2025-05-28", scope: "claimed" };
const selection = service.normalizeSelection(input);
const headers = [{ name: "day", columnType: "DIMENSION", dataType: "STRING" }, { name: "views", columnType: "METRIC", dataType: "INTEGER" }];
beforeEach(() => { axios.get = originalGet; tokenCalls = 0; tokenSources = []; });
after(() => {
  service.stopWorker(); axios.get = originalGet; db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("date validation rejects rollover, future dates, reversed and excessive ranges", () => {
  for (const override of [{ startDate: "2025-02-30" }, { endDate: "2050-01-01" }, { startDate: "2025-06-01" }, { startDate: "2020-01-01" }]) {
    assert.throws(() => service.normalizeSelection({ ...input, ...override }));
  }
  assert.throws(() => service.normalizeSelection({ ...input, channelId: "UC" + "a".repeat(22), videoId: "dQw4w9WgXcQ" }), /either a channel/);
  assert.deepEqual(service.previousSelection(selection), { ...selection, startDate: "2025-04-03", endDate: "2025-04-30" });
});

test("Analytics cannot target the Report database including an existing copied Report schema", () => {
  const child = spawnSync(process.execPath, ["-e", "require('./src/config/analyticsDatabase')"], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, ANALYTICS_DB_PATH: path.join(__dirname, "../data/database.sqlite") }, encoding: "utf8"
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /different from the Report database/);
  assert.notEqual(db.analyticsPath, path.resolve(__dirname, "../data/database.sqlite"));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('channels','channel_revenues','networks')").all().length, 0);
  const copiedPath = path.join(tempDir, "report-copy.sqlite");
  const reportCopy = new (require("better-sqlite3"))(copiedPath);
  reportCopy.exec("CREATE TABLE networks(id INTEGER PRIMARY KEY)"); reportCopy.close();
  const copied = spawnSync(process.execPath, ["-e", "require('./src/config/analyticsDatabase')"], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, ANALYTICS_DB_PATH: copiedPath }, encoding: "utf8"
  });
  assert.notEqual(copied.status, 0); assert.match(copied.stderr, /containing Report tables/);
});

test("pagination is complete and refreshes each request's credential from the bridge", async () => {
  const indexes = [];
  axios.get = async (_url, options) => {
    indexes.push(options.params.startIndex);
    assert.equal(options.maxRedirects, 0);
    return { data: { columnHeaders: headers, rows: options.params.startIndex === 1 ? [["2025-05-01", 11], ["2025-05-02", 17]] : [["2025-05-03", 5]] } };
  };
  const result = await service.fetchTable({ maxResults: 2, startDate: input.startDate, endDate: input.endDate }, { limit: null }, owner);
  assert.deepEqual(indexes, [1, 3]); assert.equal(result.rows.length, 3);
  assert.equal(tokenCalls, 2);
  assert.deepEqual(tokenSources.map(({ source }) => source.id), [owner.id, owner.id]);
  assert.equal(result.coverage.availableEndDate, "2025-05-03");
});

test("top video reports never paginate beyond YouTube's 200-result cap", async () => {
  let requests = 0;
  axios.get = async () => { requests += 1; return { data: { columnHeaders: headers, rows: Array.from({ length: 200 }, (_, i) => [String(i), i]) } }; };
  const result = await service.fetchTable({ maxResults: 200 }, { limit: 200 }, owner);
  assert.equal(requests, 1); assert.equal(result.rows.length, 200); assert.equal(result.coverage.limited, true);
});

test("failed pagination retains the prior complete snapshot and records an explicit stale error", async () => {
  const report = catalog.find((entry) => entry.id === "daily");
  const originalRows = [{ day: "2025-05-01", views: 99 }];
  const table = { columnHeaders: headers, rows: originalRows, coverage: { rowCount: 1 } };
  service.persistReport(selection, report, {}, table);
  service.persistReport(selection, report, {}, table);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_snapshots").get().n, 1);
  axios.get = async () => { const error = new Error("Forbidden"); error.response = { status: 403, data: { error: { message: "Analytics access denied", errors: [{ reason: "forbidden" }] } } }; throw error; };
  await assert.rejects(() => service.executeReport(selection, report, owner), /Analytics access denied/);
  const stored = service.readReport(selection, report);
  assert.equal(stored.status, "stale"); assert.deepEqual(stored.rows, originalRows);
  assert.equal(stored.errorDetails.reason, "forbidden");
});

test("malformed Google tables are never accepted as an empty or successful snapshot", async () => {
  axios.get = async () => ({ data: { columnHeaders: headers, rows: [["2025-05-01"]] } });
  await assert.rejects(() => service.fetchTable({ maxResults: 200 }, {}, owner), /invalid report rows/);
});

test("monetary metrics are denied before issuing a Google request", async () => {
  axios.get = async () => { throw new Error("Google should never be called"); };
  await assert.rejects(() => service.advancedQuery({ ...input, metrics: "estimatedRevenue" }, { canMonetary: false }), (error) => error.status === 403);
  assert.equal(service.publicCatalog(false).some((report) => report.monetary), false);
  assert.deepEqual(service.summaryFrom({ overview: { rows: [] } }), {});
});

test("sync de-duplication distinguishes requested reports and monetary access", () => {
  const base = { ...input, compare: false, reportIds: ["overview"] };
  const first = service.createSync(base, { canMonetary: false });
  const duplicate = service.createSync(base, { canMonetary: false });
  const larger = service.createSync({ ...base, reportIds: ["overview", "daily"] }, { canMonetary: false });
  const monetary = service.createSync(base, { canMonetary: true });
  assert.equal(first.id, duplicate.id); assert.notEqual(first.id, larger.id); assert.notEqual(first.id, monetary.id);
  for (const job of [first, larger, monetary]) service.cancelJob(job.id);
  assert.equal(service.getJob(first.id).status, "cancelled");
});

test("401 forces one fresh token refresh and does not follow redirects", async () => {
  let requests = 0;
  axios.get = async () => {
    requests += 1;
    if (requests === 1) { const error = new Error("Unauthorized"); error.response = { status: 401 }; throw error; }
    return { data: { ok: true } };
  };
  const result = await service.googleGet("https://youtubeanalytics.googleapis.com/v2/reports", { owner });
  assert.equal(result.ok, true); assert.equal(requests, 2);
  assert.equal(tokenSources[1].rejectedAccessToken, "fake-access-token");
  await assert.rejects(() => service.googleGet("https://example.com/tokens", { owner }), /endpoint is not allowed/);
});

test("recovery marks unfinished jobs interrupted without deleting saved snapshots", () => {
  db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total) VALUES('interrupted-test','owner-test',?,'running',1)").run(JSON.stringify({ selection }));
  service.recoverInterruptedJobs();
  assert.equal(service.getJob("interrupted-test").status, "interrupted");
  assert.equal(service.readReport(selection, catalog.find((entry) => entry.id === "daily")).rows[0].views, 99);
});

test("country selection changes snapshots and reaches owner, channel and custom query filters", async () => {
  const noCountry = service.normalizeSelection({ ...input, country: "" });
  assert.deepEqual(noCountry, selection);
  const selectedCountry = service.normalizeSelection({ ...input, country: "vn" });
  assert.equal(selectedCountry.country, "VN");
  assert.notEqual(service.snapshotKey(selectedCountry, "daily"), service.snapshotKey(noCountry, "daily"));
  assert.match(service.queryParams(selectedCountry, catalog.find((entry) => entry.id === "daily")).filters, /country==VN/);
  assert.throws(() => service.normalizeSelection({ ...input, country: "Vietnam" }), /two-letter/);
  assert.throws(() => service.queryParams({ ...selectedCountry, videoId: "dQw4w9WgXcQ" }, catalog.find((entry) => entry.id === "retention")), /does not support a country/);
  let params;
  axios.get = async (_url, options) => { params = options.params; return { data: { columnHeaders: headers, rows: [["2025-05-01", 2]] } }; };
  await service.advancedQuery({ ...input, country: "VN", dimensions: "day", metrics: "views" });
  assert.match(params.filters, /country==VN/);
});

test("geographic country selection is applied without an unsupported country filter in Google's query", async () => {
  const selectedCountry = service.normalizeSelection({ ...input, country: "VN" });
  const report = catalog.find((entry) => entry.id === "countries");
  axios.get = async (_url, options) => {
    assert.equal(options.params.filters.includes("country=="), false);
    return { data: { columnHeaders: [{ name: "country", columnType: "DIMENSION", dataType: "STRING" }, headers[1]], rows: [["VN", 11], ["US", 9]] } };
  };
  const result = await service.executeReport(selectedCountry, report, owner);
  assert.deepEqual(result.rows, [{ country: "VN", views: 11 }]);
  assert.equal(result.coverage.countryFilteredLocally, true);
});

test("failed channel inventory cannot replace a previous channel report with a false empty success", async () => {
  const report = catalog.find((entry) => entry.id === "channels");
  const previous = [{ channel: "UC" + "a".repeat(22), views: 123 }];
  service.persistReport(selection, report, {}, { ...fixtureTableForChannel(), rows: previous });
  axios.get = async () => { const error = new Error("Channel inventory unavailable"); error.response = { status: 403, data: { error: { message: "Missing Data API access" } } }; throw error; };
  const job = service.createSync({ ...input, reportIds: ["channels"], compare: false }, { canMonetary: false });
  await service.drainQueue();
  const stored = service.readReport(selection, report);
  assert.equal(stored.status, "stale"); assert.deepEqual(stored.rows, previous);
  assert.equal(stored.errorDetails.reason, "channelInventoryUnavailable");
  assert.equal(service.getJob(job.id).errors.some((error) => error.reportId === "channelMetadata"), true);
});
function fixtureTableForChannel() {
  return { columnHeaders: [{ name: "channel", columnType: "DIMENSION", dataType: "STRING" }, headers[1]], rows: [], coverage: { rowCount: 1 } };
}

test("saved dashboard, CSV and query history remain readable after CMS disconnect while remote sync/query stay blocked", async () => {
  const oldStatus = network.cms_auth_status;
  network.cms_auth_status = "error";
  try {
    assert.equal(service.resolveOwner(input.ownerId, { requireConnected: false }).network_code, input.ownerId);
    assert.throws(() => service.resolveOwner(input.ownerId), (error) => error.status === 409);
    const dashboard = service.dashboard(input, { canMonetary: false });
    assert.equal(dashboard.reports.daily.rows[0].views, 99);
    assert.match(service.exportReport({ ...input, reportId: "daily" }).csv, /99/);
    assert.equal(service.listQueries(input.ownerId).some((query) => query.query.metrics === "views"), true);
    assert.throws(() => service.createSync({ ...input, reportIds: ["overview"] }), (error) => error.status === 409);
    await assert.rejects(() => service.advancedQuery({ ...input, metrics: "views" }), (error) => error.status === 409);
  } finally { network.cms_auth_status = oldStatus; }
});

test("advanced queries cannot replace a selected channel or video with a conflicting entity filter", async () => {
  const channelId = "UC" + "a".repeat(22);
  const videoId = "dQw4w9WgXcQ";
  axios.get = async (_url, options) => {
    assert.equal(options.params.filters, `channel==${channelId}`);
    return { data: { columnHeaders: headers, rows: [] } };
  };
  for (const filters of [`video==${videoId}`, `channel==UC${"b".repeat(22)}`, "uploaderType==self", `channel==${channelId};claimedStatus==claimed`]) {
    await assert.rejects(() => service.advancedQuery({ ...input, channelId, filters, dimensions: "day", metrics: "views" }), /conflicts with the selected/);
  }
  await assert.rejects(() => service.advancedQuery({ ...input, videoId, filters: `channel==${channelId}`, metrics: "views" }), /conflicts with the selected/);
  const matching = await service.advancedQuery({ ...input, channelId, filters: `channel==${channelId}`, dimensions: "day", metrics: "views" });
  assert.equal(matching.status, "empty");
  assert.equal(matching.query.filters, `channel==${channelId}`);
});

test("a daily schedule can be disabled after OAuth disconnect but enabling still requires connected CMS", () => {
  const oldStatus = network.cms_auth_status;
  network.cms_auth_status = "error";
  try {
    const disabled = service.saveSchedule({ ownerId: input.ownerId, enabled: false, lookbackDays: 7 });
    assert.equal(disabled.enabled, false);
    assert.throws(() => service.saveSchedule({ ownerId: input.ownerId, enabled: true, lookbackDays: 7 }), (error) => error.status === 409);
  } finally { network.cms_auth_status = oldStatus; }
});

test("a nonmonetary role cannot replace or disable an existing financial schedule", () => {
  service.saveSchedule({ ownerId: input.ownerId, enabled: true, monetary: true, lookbackDays: 21 }, { canMonetary: true });
  const before = db.prepare("SELECT * FROM analytic_schedules WHERE owner_id=?").get(input.ownerId);
  for (const enabled of [false, true]) {
    assert.throws(() => service.saveSchedule({ ownerId: input.ownerId, enabled, monetary: false, lookbackDays: 7 }, { canMonetary: false }), (error) => error.status === 403);
  }
  const after = db.prepare("SELECT * FROM analytic_schedules WHERE owner_id=?").get(input.ownerId);
  assert.deepEqual(after, before);
  assert.equal(service.saveSchedule({ ownerId: input.ownerId, enabled: false, monetary: true, lookbackDays: 21 }, { canMonetary: true }).enabled, false);
});

test("CSV export protects formulas after whitespace, BOM and newlines without changing numeric negative values", () => {
  const csvSelection = service.normalizeSelection({ ...input, startDate: "2025-08-01", endDate: "2025-08-01" });
  const report = { id: "custom:" + "c".repeat(20), monetary: false };
  service.persistReport(csvSelection, report, {}, {
    columnHeaders: [{ name: "label", dataType: "STRING", columnType: "DIMENSION" }, { name: "amount", dataType: "FLOAT", columnType: "METRIC" }],
    rows: [{ label: "   =SUM(1,1)", amount: -7 }, { label: "\uFEFF+1", amount: -2 }, { label: "\n@payload", amount: 0 }, { label: " \t-2+3", amount: -1 }],
    coverage: { rowCount: 4 }
  });
  const result = service.exportReport({ ...csvSelection, reportId: report.id });
  assert.ok(result.csv.includes('"\'   =SUM(1,1)","-7"'));
  assert.ok(result.csv.includes('"\'\uFEFF+1","-2"'));
  assert.ok(result.csv.includes('"\'\n@payload","0"'));
  assert.ok(result.csv.includes('"\' \t-2+3","-1"'));
  assert.equal(result.csv.includes('"\'-7"'), false);
});

test("legacy bodies take the snapshot path and v2 requests are validated before anything is queued", () => {
  axios.get = async () => { throw new Error("No Google call expected"); };
  db.prepare("INSERT OR IGNORE INTO analytic_channels(owner_id,channel_id,title,metadata_json) VALUES(?,?,?,'{}')").run(input.ownerId, "UC" + "a".repeat(22), "Alpha");
  const legacy = service.createSync({ ...input, reportIds: ["overview"], compare: false }, { canMonetary: false });
  assert.equal(legacy.kind, "snapshot"); assert.equal(legacy.requestedBy, "user"); assert.equal(legacy.mode, null); assert.deepEqual(legacy.selection, selection);
  service.cancelJob(legacy.id);
  const full = { kind: "full", mode: "append", ownerId: input.ownerId, startDate: "2026-09-01", endDate: "2026-09-03", scopes: ["claimed"], channelMode: "none", includeBreakdowns: false, includeSnapshots: false };
  const tooLate = new Date(Date.parse(`${service.latestAllowedDay()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const cases = [
    [{ ...full, kind: "weird" }, 400, /kind must be/],
    [{ ...full, endDate: tooLate }, 400, /Pacific-time/],
    [{ ...full, startDate: "2008-12-31", endDate: "2009-01-02" }, 400, /2009-01-01/],
    [{ ...full, startDate: "2025-01-01", endDate: "2026-01-02" }, 400, /between 1 and 366/],
    [{ ...full, mode: "replace" }, 400, /mode must be/],
    [{ ...full, mode: "overwrite" }, 403, /overwrite/],
    [{ ...full, monetary: true }, 403, /revenue/],
    [{ ...full, scopes: ["claimed", "claimed"] }, 400, /scopes/],
    [{ ...full, scopes: ["everything"] }, 400, /scopes/],
    [{ ...full, channelMode: "some" }, 400, /channelMode/],
    [{ ...full, channelMode: "selected", channelIds: ["UC" + "z".repeat(22)] }, 400, /Unknown channel IDs/],
    [{ ...full, channelMode: "selected", channelIds: [] }, 400, /Select at least one/],
    [{ ...full, channelMode: "selected", channelIds: ["not-a-channel"] }, 400, /channel ID/],
    [{ kind: "channelDetail", ownerId: input.ownerId, channelId: "UC" + "z".repeat(22), startDate: "2026-09-01", endDate: "2026-09-02" }, 404, /inventory/],
    [{ kind: "channelDetail", ownerId: input.ownerId, channelId: "bad", startDate: "2026-09-01", endDate: "2026-09-02" }, 400, /channel ID/]
  ];
  for (const [body, status, pattern] of cases) {
    assert.throws(() => service.createSync(body, { canMonetary: false, canSync: true, userId: 1 }), (error) => error.status === status && pattern.test(error.message), JSON.stringify(body));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs WHERE kind<>'snapshot'").get().n, 0);
  const oldStatus = network.cms_auth_status; network.cms_auth_status = "error";
  try { assert.throws(() => service.createSync(full, { canMonetary: true, canSync: true }), (error) => error.status === 409 && error.reason === "cmsNotConnected"); }
  finally { network.cms_auth_status = oldStatus; }
});

test("v2 jobs are de-duplicated, capped at two queued per owner (schedules bypass) and sanitised per role", () => {
  axios.get = async () => { throw new Error("No Google call expected"); };
  const full = { kind: "full", mode: "append", ownerId: input.ownerId, startDate: "2026-09-01", endDate: "2026-09-03", scopes: ["claimed"], channelMode: "none", includeBreakdowns: false, includeSnapshots: false };
  const admin = { userId: 1, canMonetary: true, canSync: true };
  const a = service.createSync(full, admin);
  assert.equal(a.status, "queued"); assert.equal(a.kind, "full"); assert.equal(a.mode, "append"); assert.equal(a.monetary, false); assert.equal(a.deduplicated, undefined);
  assert.equal(a.startDate, "2026-09-01"); assert.equal(a.endDate, "2026-09-03"); assert.equal(a.createdBy, 1); assert.ok(a.total >= 1);
  // a queued job already exposes its plan (without channelIds); counts/steps stay empty until it runs
  assert.equal(a.plan.requests.estimate, a.total); assert.equal(a.plan.channelIds, undefined); assert.equal(a.plan.kind, "full"); assert.equal(a.counts, null); assert.deepEqual(a.steps, []);
  const twin = service.createSync({ ...full, includeBreakdowns: "false" }, { userId: 2, canMonetary: true, canSync: true });
  assert.equal(twin.id, a.id); assert.equal(twin.deduplicated, true);
  // the same non-monetary work requested by a role without revenue access is the same job (canMonetary is not part of the key)
  const contentIdTwin = service.createSync(full, { userId: 3, canMonetary: false, canSync: true });
  assert.equal(contentIdTwin.id, a.id); assert.equal(contentIdTwin.deduplicated, true);
  const b = service.createSync({ ...full, endDate: "2026-09-04" }, admin);
  assert.notEqual(b.id, a.id);
  assert.throws(() => service.createSync({ ...full, endDate: "2026-09-05" }, admin), (error) => error.status === 409 && error.reason === "tooManyJobs");
  const scheduled = service.createSync({ kind: "daily", ownerId: input.ownerId }, { ...admin, requestedBy: "schedule" });
  assert.equal(scheduled.kind, "daily"); assert.equal(scheduled.requestedBy, "schedule"); assert.equal(scheduled.monetary, true);
  assert.equal(service.createSync({ kind: "daily", ownerId: input.ownerId }, { ...admin, requestedBy: "evil" }).id, scheduled.id);
  db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,kind,mode,current_report,errors_json,result_json) VALUES('money-job',?,?,'partial',5,'full','append','breakdown:adType',?,?)").run(input.ownerId,
    JSON.stringify({ kind: "full", mode: "append", ownerId: input.ownerId, startDate: "2026-09-01", endDate: "2026-09-03", scopes: ["claimed"], channelMode: "none", channelIds: [], includeBreakdowns: true,
      includeSnapshots: false, monetary: true, canMonetary: true, requestedBy: "user" }),
    JSON.stringify([{ reportId: "breakdown:adType", monetary: true, message: "adType failed", reason: "internalError", status: 500 }, { reportId: "ownerFacts:claimed", monetary: false, message: "facts failed", reason: "internalError", status: 500 }]),
    JSON.stringify({ counts: { inserted: 1 }, steps: [{ id: "ownerFacts:claimed", monetary: false, status: "completed" }, { id: "breakdown:adType", monetary: true, status: "failed" }], plan: { startDate: "2026-09-01", endDate: "2026-09-03", channelIds: ["x"] } }));
  const hidden = service.getJob("money-job", { canMonetary: false });
  assert.equal(hidden.monetary, true); assert.equal(hidden.canCancel, false); assert.equal(hidden.currentReport, null);
  assert.deepEqual(hidden.steps.map((step) => step.id), ["ownerFacts:claimed"]); assert.deepEqual(hidden.errors.map((error) => error.reportId), ["ownerFacts:claimed"]);
  assert.deepEqual(hidden.result.steps.map((step) => step.id), ["ownerFacts:claimed"]); assert.equal(hidden.plan.channelIds, undefined); assert.equal(hidden.startDate, "2026-09-01");
  const shown = service.getJob("money-job", { canMonetary: true });
  assert.equal(shown.canCancel, true); assert.equal(shown.currentReport, "breakdown:adType"); assert.equal(shown.steps.length, 2); assert.equal(shown.errors.length, 2);
  assert.equal(service.jobIsMonetary({ kind: "full", monetary: true }), true); assert.equal(service.jobIsMonetary({ reportIds: ["overview", "previous:monetaryDaily"] }), true);
  assert.equal(service.jobIsMonetary({ reportIds: ["overview"] }), false); assert.equal(service.jobIsMonetary({ kind: "daily", monetary: false }), false);
  assert.equal(service.listJobs(input.ownerId, { canMonetary: false }, 50).find((job) => job.id === "money-job").steps.length, 1);
  db.prepare("UPDATE analytic_jobs SET status='queued' WHERE id='money-job'").run();
  assert.throws(() => service.cancelJob("money-job", { canMonetary: false }), (error) => error.status === 403);
  assert.equal(service.cancelJob("money-job", { canMonetary: true }).status, "cancelled");
  for (const job of [a, b, scheduled]) service.cancelJob(job.id, admin);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs WHERE status IN ('queued','running')").get().n, 0);
});

test("a 401 after a transient retry still refreshes the token once, and only once per call", async () => {
  const statuses = [503, 401];
  let requests = 0;
  axios.get = async () => {
    const status = statuses[requests]; requests += 1;
    if (status) { const error = new Error(`HTTP ${status}`); error.response = { status, headers: { "retry-after": "0" } }; throw error; }
    return { data: { ok: true } };
  };
  const result = await service.googleGet("https://youtubeanalytics.googleapis.com/v2/reports", { owner });
  assert.equal(result.ok, true); assert.equal(requests, 3);
  assert.equal(tokenSources.filter((source) => source.rejectedAccessToken === "fake-access-token").length, 1);
  statuses.splice(0, statuses.length, 401, 401); requests = 0;
  await assert.rejects(() => service.googleGet("https://youtubeanalytics.googleapis.com/v2/reports", { owner }), (error) => error.status === 401);
  assert.equal(requests, 2);
});

test("listOwners exposes the stored CMS auth error but never a token", () => {
  network.cms_auth_error = "invalid_grant: Token has been expired or revoked.";
  try {
    const row = service.listOwners().find((entry) => entry.ownerId === owner.network_code);
    assert.equal(row.authError, "invalid_grant: Token has been expired or revoked."); assert.equal(row.hasMonetaryScope, true);
    assert.equal(JSON.stringify(row).includes("never-output-this-token"), false);
  } finally { network.cms_auth_error = null; }
  assert.equal(service.listOwners()[0].authError, null);
});

test("an enabled revenue schedule needs the monetary OAuth scope and the daily request downgrades without it", () => {
  const admin = { userId: 1, canMonetary: true, canSync: true };
  const previousScopes = network.cms_auth_scopes;
  network.cms_auth_scopes = "https://www.googleapis.com/auth/yt-analytics.readonly";
  try {
    assert.throws(() => service.saveSchedule({ ownerId: input.ownerId, enabled: true, monetary: true }, admin), (error) => error.status === 400 && /no revenue scope/.test(error.message));
    // a disabled revenue schedule can still be saved (for example to switch it off after the scope was removed)
    assert.equal(service.saveSchedule({ ownerId: input.ownerId, enabled: false, monetary: true }, admin).monetary, true);
    const job = service.createSync({ kind: "daily", ownerId: input.ownerId }, { ...admin, requestedBy: "schedule" });
    assert.equal(job.monetary, false); assert.match(job.notes[0], /no revenue scope/);
    service.cancelJob(job.id, admin);
  } finally { network.cms_auth_scopes = previousScopes; }
  assert.equal(service.saveSchedule({ ownerId: input.ownerId, enabled: true, monetary: true }, admin).monetary, true);
  const full = service.createSync({ kind: "daily", ownerId: input.ownerId }, { ...admin, requestedBy: "schedule" });
  assert.equal(full.monetary, true); assert.deepEqual(full.notes, []);
  service.cancelJob(full.id, admin);
  service.saveSchedule({ ownerId: input.ownerId, enabled: false, monetary: true }, admin);
});

test("restart recovery follows the original job: one continuation per request, the slot follows it, and the chain ends after two restarts or 24 h", () => {
  const admin = { userId: 1, canMonetary: true, canSync: true };
  const request = { kind: "full", mode: "append", ownerId: input.ownerId, startDate: "2026-09-01", endDate: "2026-09-02", scopes: ["claimed"], channelMode: "none", channelIds: [],
    includeBreakdowns: false, includeSnapshots: false, monetary: false, canMonetary: true, requestedBy: "user" };
  const insert = (id, status, extra = {}) => db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,kind,mode,created_at,updated_at) VALUES(?,?,?,?,3,'full','append',?,?)")
    .run(id, input.ownerId, JSON.stringify({ ...request, ...extra }), status, extra.createdAt || new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO analytic_schedules(owner_id,enabled,created_by,updated_at) VALUES(?,0,1,?)").run(input.ownerId, new Date().toISOString());
  db.prepare("INSERT OR REPLACE INTO analytic_schedule_runs(owner_id,scheduled_for,status,attempts,job_id,created_at,updated_at) VALUES(?,?,'queued',1,'rec-a',?,?)")
    .run(input.ownerId, "2026-10-21T02:00:00.000Z", new Date().toISOString(), new Date().toISOString());
  insert("rec-a", "running"); insert("rec-b", "queued", { requestedBy: "user", canMonetary: false });
  let result = service.recoverInterruptedJobs();
  assert.deepEqual(result, { interrupted: 2, requeued: 1 });
  const continuation = service.listJobs(input.ownerId, admin, 10).find((job) => job.status === "queued" && job.requestedBy === "recovery");
  assert.ok(continuation);
  // the queued twin (rec-b) is interrupted in the same pass, so it is never used as the continuation (U8)
  assert.equal(service.getJob("rec-a", admin).errors.at(-1).requeuedAs, continuation.id); assert.equal(service.getJob("rec-b", admin).errors.at(-1).requeuedAs, continuation.id);
  assert.equal(db.prepare("SELECT job_id FROM analytic_schedule_runs WHERE owner_id=? AND scheduled_for=?").get(input.ownerId, "2026-10-21T02:00:00.000Z").job_id, continuation.id);
  const stored = JSON.parse(db.prepare("SELECT request_json FROM analytic_jobs WHERE id=?").get(continuation.id).request_json);
  assert.equal(stored.recovery.attempts, 1); assert.ok(Date.parse(stored.recovery.originalCreatedAt) > 0);
  assert.equal(service.canonicalRequest(stored), service.canonicalRequest(request));
  // second crash: one more continuation (attempt 2); third crash: the chain stops with an explicit note
  db.prepare("UPDATE analytic_jobs SET status='running' WHERE id=?").run(continuation.id);
  result = service.recoverInterruptedJobs();
  assert.deepEqual(result, { interrupted: 1, requeued: 1 });
  const second = service.listJobs(input.ownerId, admin, 10).find((job) => job.status === "queued");
  assert.equal(JSON.parse(db.prepare("SELECT request_json FROM analytic_jobs WHERE id=?").get(second.id).request_json).recovery.attempts, 2);
  assert.equal(db.prepare("SELECT job_id FROM analytic_schedule_runs WHERE owner_id=? AND scheduled_for=?").get(input.ownerId, "2026-10-21T02:00:00.000Z").job_id, second.id);
  db.prepare("UPDATE analytic_jobs SET status='running' WHERE id=?").run(second.id);
  result = service.recoverInterruptedJobs();
  assert.deepEqual(result, { interrupted: 1, requeued: 0 });
  assert.match(service.getJob(second.id, admin).errors.at(-1).message, /interrupted 3 times and was not queued again/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs WHERE status='queued'").get().n, 0);
  // an original job older than 24 h is not continued even when the interrupted row itself is fresh
  insert("rec-old", "running", { requestedBy: "recovery", recovery: { originalCreatedAt: new Date(Date.now() - 30 * 3600000).toISOString(), attempts: 1 } });
  assert.deepEqual(service.recoverInterruptedJobs(), { interrupted: 1, requeued: 0 });
  assert.match(service.getJob("rec-old", admin).errors.at(-1).message, /Start a new sync/);
  db.prepare("DELETE FROM analytic_schedule_runs WHERE owner_id=?").run(input.ownerId);
});

test("startWorker normalises legacy timestamps before recovery and takes the single-writer lease; a fresh foreign lease blocks it", () => {
  const admin = { userId: 1, canMonetary: true, canSync: true };
  const at = (value) => db.prepare("SELECT value FROM analytic_meta WHERE key='worker:lease'").get()?.value ? JSON.parse(db.prepare("SELECT value FROM analytic_meta WHERE key='worker:lease'").get().value)[value] : null;
  db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,kind,created_at,updated_at) VALUES('legacy-ts','owner-test','{}','completed',1,'snapshot','2026-10-21 16:33:02','2026-10-21 16:33:02')").run();
  db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,kind,created_at,updated_at) VALUES('iso-ts','owner-test','{}','completed',1,'snapshot','2026-10-21T10:00:00.000Z','2026-10-21T10:00:00.000Z')").run();
  db.prepare("INSERT INTO analytic_snapshots(snapshot_key,owner_id,report_id,start_date,end_date,selection_json,query_json,headers_json,rows_json,coverage_json,updated_at) VALUES('legacy-snap','owner-test','daily','2026-01-01','2026-01-02','{}','{}','[]','[]','{}','2026-10-21 07:00:43')").run();
  db.prepare("INSERT OR IGNORE INTO analytic_schedules(owner_id,enabled,created_by) VALUES('owner-test',0,1)").run();
  db.prepare("UPDATE analytic_schedules SET updated_at='2026-10-20 01:02:03' WHERE owner_id='owner-test'").run();
  db.prepare("INSERT OR REPLACE INTO analytic_schedule_runs(owner_id,scheduled_for,status,attempts,created_at,updated_at) VALUES('owner-test','2026-10-20T02:00:00.000Z','failed',5,'2026-10-20 02:00:01','2026-10-20 02:00:01')").run();
  // another live process holds the lease: no boot, no normalisation, nothing scheduled
  const foreign = JSON.stringify({ pid: process.pid + 100000, at: new Date().toISOString() });
  db.prepare("INSERT INTO analytic_meta(key,value,updated_at) VALUES('worker:lease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(foreign, new Date().toISOString());
  service.startWorker();
  assert.equal(db.prepare("SELECT created_at FROM analytic_jobs WHERE id='legacy-ts'").get().created_at, "2026-10-21 16:33:02");
  assert.equal(at("pid"), process.pid + 100000);
  service.stopWorker();
  assert.equal(at("pid"), process.pid + 100000, "a foreign lease is never released by this process");
  // the foreign lease went stale (owner died): the worker boots and takes over
  db.prepare("UPDATE analytic_meta SET value=? WHERE key='worker:lease'").run(JSON.stringify({ pid: process.pid + 100000, at: new Date(Date.now() - 120000).toISOString() }));
  service.startWorker();
  assert.equal(at("pid"), process.pid);
  assert.equal(db.prepare("SELECT created_at,updated_at FROM analytic_jobs WHERE id='legacy-ts'").get().created_at, "2026-10-21T16:33:02Z");
  assert.equal(db.prepare("SELECT created_at FROM analytic_jobs WHERE id='iso-ts'").get().created_at, "2026-10-21T10:00:00.000Z");
  assert.equal(db.prepare("SELECT updated_at FROM analytic_snapshots WHERE snapshot_key='legacy-snap'").get().updated_at, "2026-10-21T07:00:43Z");
  assert.equal(db.prepare("SELECT updated_at FROM analytic_schedules WHERE owner_id='owner-test'").get().updated_at, "2026-10-20T01:02:03Z");
  assert.equal(db.prepare("SELECT created_at FROM analytic_schedule_runs WHERE owner_id='owner-test' AND scheduled_for='2026-10-20T02:00:00.000Z'").get().created_at, "2026-10-20T02:00:01Z");
  const ordered = service.listJobs(input.ownerId, admin, 50).filter((job) => ["legacy-ts", "iso-ts"].includes(job.id)).map((job) => job.id);
  assert.deepEqual(ordered, ["legacy-ts", "iso-ts"], "jobs order by instant, not by the legacy string form");
  service.stopWorker();
  assert.equal(at("pid"), null, "a graceful stop releases our lease");
  // ANALYTICS_FORCE_WORKER=1 takes a fresh foreign lease over
  db.prepare("INSERT INTO analytic_meta(key,value,updated_at) VALUES('worker:lease',?,?)").run(foreign, new Date().toISOString());
  process.env.ANALYTICS_FORCE_WORKER = "1";
  try { service.startWorker(); assert.equal(at("pid"), process.pid); }
  finally { delete process.env.ANALYTICS_FORCE_WORKER; service.stopWorker(); }
  db.prepare("DELETE FROM analytic_schedule_runs WHERE owner_id='owner-test'").run();
  db.prepare("DELETE FROM analytic_jobs WHERE id IN ('legacy-ts','iso-ts')").run();
});
