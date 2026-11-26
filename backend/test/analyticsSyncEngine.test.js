const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { installAnalyticsHarness, addDays, channelId } = require("./helpers/fakeGoogle");
const users = { 1: { id: 1, role: "admin", status: "active" }, 2: { id: 2, role: "Content ID", status: "active" } };
const h = installAnalyticsHarness({ users, fixture: { channelCount: 5 } });
const { db, service, warehouse, fake } = h;
const engineLib = h.engine;
const catalog = require("../src/services/analyticsCatalog").REPORT_CATALOG;
const ownerId = h.network.network_code;
const admin = { userId: 1, canMonetary: true, canSync: true, canOverwrite: true };
const contentId = { userId: 2, canMonetary: false, canSync: true };
const ids = fake.fixture.channels.map((channel) => channel.id);
const CLAIMED = "owner:claimed";
const DAY = 86400000;
const base = (overrides = {}) => ({ kind: "full", mode: "append", ownerId, startDate: "2026-09-01", endDate: "2026-09-03", scopes: ["claimed"], channelMode: "none",
  includeBreakdowns: false, includeSnapshots: false, monetary: false, ...overrides });
const fact = (key, day) => { const row = db.prepare("SELECT * FROM analytic_daily_facts WHERE owner_id=? AND entity_key=? AND day=?").get(ownerId, key, day); return row ? { ...row, metrics: JSON.parse(row.metrics_json) } : null; };
const coverageRows = (key, kind = "facts") => db.prepare("SELECT * FROM analytic_day_coverage WHERE owner_id=? AND entity_key=? AND kind=? ORDER BY day").all(ownerId, key, kind);
const ledger = () => db.prepare("SELECT * FROM analytic_daily_history ORDER BY id").all().map((row) => ({ ...row, previous: JSON.parse(row.previous_json), next: JSON.parse(row.new_json) }));
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
function seedInventory() {
  for (const channel of fake.fixture.channels) db.prepare("INSERT INTO analytic_channels(owner_id,channel_id,title,metadata_json) VALUES(?,?,?,'{}')").run(ownerId, channel.id, channel.title);
}
async function run(body, access = admin) {
  const job = service.createSync(body, access);
  await service.drainQueue();
  return service.getJob(job.id, access);
}
function insertJobRow(request, { status = "queued", createdAt = new Date().toISOString(), cancelRequested = 0 } = {}) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,created_by,created_at,updated_at,kind,mode,cancel_requested) VALUES(?,?,?,?,1,1,?,?,?,?,?)")
    .run(id, ownerId, JSON.stringify(request), status, createdAt, createdAt, request.kind || "snapshot", request.mode || null, cancelRequested);
  return db.prepare("SELECT * FROM analytic_jobs WHERE id=?").get(id);
}
// Direct engine with a core whose googleGet has no retry ladder: 500s reach the breaker immediately.
function directEngine() {
  const core = { ...service, googleGet: async (url, { params }) => (await fake.handler(url, { params })).data };
  return engineLib.createSyncEngine({ db, core, warehouse, pace: 0, log: () => {} });
}
beforeEach(() => {
  service.stopWorker(); fake.reset(); h.tokenError = null;
  db.exec(`DELETE FROM analytic_jobs; DELETE FROM analytic_daily_facts; DELETE FROM analytic_daily_breakdowns; DELETE FROM analytic_day_coverage; DELETE FROM analytic_daily_history;
    DELETE FROM analytic_channels; DELETE FROM analytic_snapshots; DELETE FROM analytic_attempts; DELETE FROM analytic_videos; DELETE FROM analytic_schedule_runs; DELETE FROM analytic_schedules;
    DELETE FROM analytic_owners; DELETE FROM analytic_meta WHERE key NOT LIKE 'migration:%';`);
  seedInventory();
});
after(() => h.cleanup());

test("planning counts requests per shape, rejects over-cap jobs with the plan attached and dry runs never enqueue", () => {
  const body = { kind: "full", mode: "append", ownerId, startDate: "2026-09-01", endDate: "2026-09-05", scopes: ["claimed"], channelMode: "all", monetary: true };
  const plan = service.planSync(body, admin);
  assert.equal(plan.days.requested, 5); assert.equal(plan.days.missingFacts, 5); assert.equal(plan.channels.planned, 5); assert.equal(plan.mode, "append"); assert.equal(plan.kind, "full");
  assert.deepEqual(plan.requests.breakdown, { inventory: 1, ownerFacts: 2, channelFacts: 10, breakdowns: 10, perDay: 15, snapshots: 12, videoMetadata: 8 });
  assert.equal(plan.requests.estimate, 58); assert.equal(plan.cap, 5000); assert.equal(plan.overCap, false);
  assert.equal(plan.channelIds, undefined); assert.equal(plan.latestAllowedDay, engineLib.latestAllowedDay());
  const dry = service.createSync({ ...body, dryRun: true }, admin);
  assert.equal(dry.dryRun, true); assert.equal(dry.plan.requests.estimate, 58);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_jobs"), 0);
  process.env.ANALYTICS_MAX_REQUESTS_PER_JOB = "10";
  try {
    assert.throws(() => service.createSync(body, admin), (error) => error.status === 400 && error.reason === "tooManyRequests" && error.plan.overCap === true && error.plan.cap === 10 && /Shorten the range/.test(error.message));
  } finally { delete process.env.ANALYTICS_MAX_REQUESTS_PER_JOB; }
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_jobs"), 0);
  const detail = service.planSync({ kind: "channelDetail", ownerId, channelId: ids[0], startDate: "2026-09-01", endDate: "2026-09-02", monetary: false }, admin);
  assert.deepEqual(detail.requests.breakdown, { inventory: 0, ownerFacts: 1, channelFacts: 0, breakdowns: 0, perDay: 0, snapshots: 10, videoMetadata: 4 });
});

test("append never changes stored numbers and records drift; overwrite replaces them through the ledger", async () => {
  const first = await run(base());
  assert.equal(first.status, "completed"); assert.equal(first.kind, "full"); assert.equal(first.mode, "append"); assert.equal(first.requestedBy, "user");
  assert.deepEqual(first.counts, { inserted: 3, updated: 0, enriched: 0, unchanged: 0, drift: 0, skipped: 0, failed: 0 });
  assert.deepEqual(first.result.days, { requested: 3, covered: 3, added: ["2026-09-01", "2026-09-02", "2026-09-03"], addedCount: 3, drifted: [], driftedCount: 0 });
  assert.equal(first.result.requests, 2); assert.equal(first.progress, 100);
  assert.deepEqual(first.steps.map((step) => [step.id, step.status]), [["inventory", "completed"], ["ownerFacts:claimed", "completed"]]);
  const before = fact(CLAIMED, "2026-09-02").metrics.views;
  assert.equal(before, fake.views(CLAIMED, "2026-09-02"));
  fake.revise(CLAIMED, "2026-09-02", 50);
  const second = await run(base());
  assert.equal(second.counts.drift, 1); assert.equal(second.counts.unchanged, 2); assert.equal(second.counts.inserted, 0);
  assert.equal(fact(CLAIMED, "2026-09-02").metrics.views, before); assert.equal(fact(CLAIMED, "2026-09-02").revision, 1);
  assert.deepEqual(second.result.days.drifted, ["2026-09-02"]);
  const drift = ledger().filter((row) => row.action === "drift");
  assert.equal(drift.length, 1); assert.deepEqual(drift[0].next.views, [before, before + 50]); assert.equal(drift[0].job_id, second.id);
  const third = await run(base({ mode: "overwrite" }));
  assert.equal(third.mode, "overwrite"); assert.equal(third.counts.updated, 1); assert.equal(third.counts.unchanged, 2);
  assert.equal(fact(CLAIMED, "2026-09-02").metrics.views, before + 50); assert.equal(fact(CLAIMED, "2026-09-02").revision, 2); assert.equal(fact(CLAIMED, "2026-09-02").source, "full");
  const overwrite = ledger().filter((row) => row.action === "overwrite");
  assert.equal(overwrite.length, 1); assert.equal(overwrite[0].previous.views, before); assert.equal(overwrite[0].next.views, before + 50);
  assert.equal(service.getJob(third.id, contentId).canCancel, true);
});

test("the daily job re-reads its whole window, leaves days after the watermark pending and covers an empty scope as true zeros", async () => {
  service.saveSchedule({ ownerId, enabled: true, lookbackDays: 5, lagDays: 3, scopes: ["claimed", "thirdParty"], channelMode: "none", includeBreakdowns: false, includeSnapshots: false, monetary: false }, admin);
  const endDate = addDays(engineLib.bangkokToday(new Date()), -3); const startDate = addDays(endDate, -4);
  fake.fixture.emptyScopes.add("thirdParty");
  fake.fixture.watermark = { basic: addDays(endDate, -1), money: addDays(endDate, -1) };
  const job = await run({ kind: "daily", ownerId });
  assert.equal(job.status, "completed"); assert.equal(job.kind, "daily"); assert.equal(job.mode, "append");
  assert.equal(job.plan.startDate, startDate); assert.equal(job.plan.endDate, endDate); assert.equal(job.plan.lagDays, 3); assert.deepEqual(job.plan.scopes, ["claimed", "thirdParty"]);
  assert.equal(job.startDate, startDate); assert.equal(job.counts.inserted, 4);
  assert.deepEqual(job.result.watermark.claimed.basic, addDays(endDate, -1)); assert.equal(job.result.watermark.thirdParty.empty.basic, true);
  const coverage = warehouse.coverage(db, { ownerId, entityKey: CLAIMED, startDate, endDate, latestAllowedDay: engineLib.latestAllowedDay(), lagDays: 3 });
  assert.equal(coverage.covered, 4); assert.deepEqual(coverage.pending, [endDate]); assert.deepEqual(coverage.missing, []);
  assert.equal(coverageRows("owner:thirdParty").length, 4); assert.equal(count("SELECT COUNT(*) AS n FROM analytic_daily_facts WHERE entity_key='owner:thirdParty'"), 0);
  assert.deepEqual(warehouse.missingDays(db, { ownerId, entityKey: "owner:thirdParty", startDate, endDate: addDays(endDate, -1) }), []);
  assert.equal(warehouse.readSeries(db, { ownerId, entityKeys: ["owner:thirdParty"], startDate, endDate })[0].covered, true);
  fake.revise(CLAIMED, startDate, 7);
  const again = await run({ kind: "daily", ownerId });
  assert.equal(again.counts.drift, 1); assert.equal(again.counts.unchanged, 3); assert.equal(again.counts.inserted, 0);
  const requests = fake.analyticsCalls((params) => params.dimensions === "day" && params.filters === "claimedStatus==claimed");
  assert.equal(requests.length, 2); assert.ok(requests.every((call) => call.params.startDate === startDate && call.params.endDate === endDate && call.params.sort === "day"));
  assert.ok(fake.calls.every((call) => !("startIndex" in call.params) || call.params.startIndex === 1));
});

test("a non-monetary run followed by a monetary run fills revenue without touching stored numbers or re-requesting basic channel facts", async () => {
  const body = base({ channelMode: "all", endDate: "2026-09-02" });
  const first = await run(body, contentId);
  assert.equal(first.status, "completed"); assert.equal(first.monetary, false);
  assert.deepEqual(warehouse.missingDays(db, { ownerId, entityKey: CLAIMED, startDate: "2026-09-01", endDate: "2026-09-02", monetary: true }), ["2026-09-01", "2026-09-02"]);
  assert.equal(fact(CLAIMED, "2026-09-01").metrics.estimatedRevenue, undefined); assert.equal(fact(CLAIMED, "2026-09-01").monetary, 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='facts' AND entity_key LIKE 'channel:%'"), 10);
  fake.calls.length = 0;
  const second = await run({ ...body, monetary: true });
  assert.equal(second.status, "completed"); assert.equal(second.monetary, true);
  assert.equal(second.counts.updated, 0); assert.equal(second.counts.drift, 0); assert.equal(second.counts.inserted, 0); assert.ok(second.counts.enriched >= 2);
  assert.equal(fact(CLAIMED, "2026-09-01").metrics.estimatedRevenue, fake.views(CLAIMED, "2026-09-01") / 100); assert.equal(fact(CLAIMED, "2026-09-01").monetary, 1);
  assert.equal(fact(CLAIMED, "2026-09-01").metrics.views, fake.views(CLAIMED, "2026-09-01"));
  assert.deepEqual(warehouse.missingDays(db, { ownerId, entityKey: CLAIMED, startDate: "2026-09-01", endDate: "2026-09-02", monetary: true }), []);
  const channelCalls = fake.analyticsCalls((params) => params.dimensions === "channel");
  assert.equal(channelCalls.length, 2); assert.ok(channelCalls.every((call) => call.params.metrics.startsWith("estimatedRevenue") && !("sort" in call.params)));
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='facts' AND entity_key LIKE 'channel:%' AND monetary=1"), 10);
  const active = ids.find((id) => fake.active(id, "2026-09-01"));
  assert.equal(fact(`channel:${active}`, "2026-09-01").metrics.grossRevenue, fake.views(`channel:${active}`, "2026-09-01") / 50);
  // The sanitised Content ID view still says the job is monetary but carries no monetary step, error or metric key.
  const hidden = service.getJob(second.id, contentId);
  assert.equal(hidden.monetary, true); assert.equal(hidden.canCancel, false);
  assert.ok(hidden.steps.length >= 3); assert.ok(hidden.steps.every((step) => !step.monetary));
  assert.equal(hidden.errors.some((error) => error.monetary), false);
  assert.deepEqual([...warehouse.MONETARY_KEYS].filter((key) => JSON.stringify(hidden).includes(`"${key}"`)), []);
  assert.equal(service.getJob(second.id, admin).steps.length, hidden.steps.length);
});

test("channel facts go out in batches of at most ANALYTICS_CHANNEL_BATCH ids without an extra page, inactive channels are covered as zeros and covered days are not re-requested", async () => {
  process.env.ANALYTICS_CHANNEL_BATCH = "2";
  try {
    const body = base({ channelMode: "all", endDate: "2026-09-02" });
    const job = await run(body);
    assert.equal(job.status, "completed");
    const channelCalls = fake.analyticsCalls((params) => params.dimensions === "channel");
    assert.equal(channelCalls.length, 6);
    for (const call of channelCalls) {
      const requested = call.params.filters.replace("channel==", "").split(",");
      assert.ok(requested.length <= 2); assert.equal(call.params.maxResults, requested.length); assert.equal(call.params.startIndex, 1); assert.equal(call.params.sort, "-views");
      assert.equal(call.params.startDate, call.params.endDate);
    }
    assert.deepEqual(job.result.channels, { planned: 5, covered: 5 });
    const inactive = ids.filter((id) => !fake.active(id, "2026-09-01"));
    assert.ok(inactive.length >= 1);
    assert.equal(fact(`channel:${inactive[0]}`, "2026-09-01"), null); assert.equal(coverageRows(`channel:${inactive[0]}`).length, 2);
    const totals = warehouse.readChannelTotals(db, { ownerId, channelIds: ids, startDate: "2026-09-01", endDate: "2026-09-02" });
    assert.equal(totals.get(inactive[0]).coveredDays, 2);
    fake.calls.length = 0;
    const again = await run(body);
    assert.equal(fake.analyticsCalls((params) => params.dimensions === "channel").length, 0);
    assert.equal(again.counts.inserted, 0); assert.equal(again.counts.unchanged, 2);
  } finally { delete process.env.ANALYTICS_CHANNEL_BATCH; }
});

test("a request shape that fails three times in a row is skipped for the rest of the job and the job ends partial", async () => {
  fake.fail({ match: (url, params) => params.dimensions === "country", status: 500, reason: "internalError", times: Infinity });
  const row = insertJobRow({ ...base({ endDate: "2026-09-06", includeBreakdowns: true }), canMonetary: true, requestedBy: "user" });
  const out = await directEngine().runJob(row);
  assert.equal(out.claimed, true); assert.equal(out.status, "partial");
  assert.equal(fake.analyticsCalls((params) => params.dimensions === "country").length, 3);
  const job = service.getJob(row.id, admin);
  assert.equal(job.status, "partial"); assert.equal(job.errors.length, 3); assert.ok(job.errors.every((error) => error.reportId === "breakdown:country" && error.reason === "internalError" && error.status === 500));
  const country = job.steps.find((step) => step.id === "breakdown:country");
  assert.equal(country.status, "failed"); assert.deepEqual(country.skippedShapes, [{ shape: "claimed|country|basic", firstFailedDay: "2026-09-01" }]);
  assert.equal(job.steps.find((step) => step.id === "breakdown:deviceType").inserted, 24);
  assert.equal(job.steps.find((step) => step.id === "breakdown:sharingService").inserted, 12);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='breakdown:country'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='breakdown:sharingService'"), 6);
});

test("quota and credential failures fail the job immediately, keep the counts and name the reason", async () => {
  fake.fail({ match: (url, params) => params.dimensions === "channel", status: 403, reason: "quotaExceeded", message: "Quota exceeded for quota metric 'Queries'", times: Infinity });
  const job = await run(base({ channelMode: "all", endDate: "2026-09-02" }));
  assert.equal(job.status, "failed"); assert.equal(job.counts.inserted, 2);
  assert.equal(job.errors.at(-1).reportId, "job"); assert.equal(job.errors.at(-1).reason, "quotaExceeded"); assert.equal(job.errors.at(-1).status, 403);
  assert.equal(fake.analyticsCalls((params) => params.dimensions === "channel").length, 1);
  assert.equal(job.steps.find((step) => step.id === "channelFacts").status, "failed");
  assert.equal(job.result.status, "failed"); assert.equal(job.finishedAt !== null, true);
  h.tokenError = () => Object.assign(new Error("invalid_grant: Token has been expired or revoked."), { status: 400, cmsAuthFailed: true, reason: "invalid_grant" });
  const refused = await run(base());
  assert.equal(refused.status, "failed"); assert.equal(refused.errors.at(-1).reason, "cmsNotConnected"); assert.match(refused.errors.at(-1).message, /invalid_grant/);
  assert.equal(refused.counts.inserted, 0); assert.equal(refused.steps[0].status, "failed");
});

test("cancellation stops the job at the next request and keeps the counts so far", async () => {
  let jobId = null;
  fake.onRequest = (url, params, number) => { if (number === 3) service.cancelJob(jobId, admin); };
  const job = service.createSync(base({ endDate: "2026-09-10", channelMode: "all" }), admin);
  jobId = job.id;
  await service.drainQueue();
  const done = service.getJob(jobId, admin);
  assert.equal(done.status, "cancelled"); assert.equal(done.cancelRequested, true); assert.equal(done.result.status, "cancelled");
  assert.ok(done.counts.inserted >= 10); assert.equal(fake.calls.length, 3);
  assert.equal(done.steps.find((step) => step.id === "channelFacts").status, "cancelled");
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE entity_key=? AND kind='facts'", CLAIMED), 10);
});

test("restart recovery marks jobs interrupted and queues recent, not-cancelled v2 jobs again as recovery jobs", () => {
  const recent = new Date().toISOString(); const old = new Date(Date.now() - 2 * DAY).toISOString();
  const running = insertJobRow({ ...base(), canMonetary: true, requestedBy: "user" }, { status: "running", createdAt: recent });
  const cancelling = insertJobRow({ ...base({ endDate: "2026-09-04" }), canMonetary: true, requestedBy: "user" }, { status: "running", createdAt: recent, cancelRequested: 1 });
  const legacy = insertJobRow({ selection: { ownerId, startDate: "2026-09-01", endDate: "2026-09-03" }, reportIds: ["overview"] }, { status: "queued", createdAt: recent });
  const stale = insertJobRow({ ...base({ endDate: "2026-09-05" }), canMonetary: true, requestedBy: "user" }, { status: "running", createdAt: old });
  const result = service.recoverInterruptedJobs();
  assert.deepEqual(result, { interrupted: 4, requeued: 1 });
  for (const row of [running, cancelling, legacy, stale]) assert.equal(service.getJob(row.id, admin).status, "interrupted");
  const queued = db.prepare("SELECT * FROM analytic_jobs WHERE status='queued'").all();
  assert.equal(queued.length, 1);
  const request = JSON.parse(queued[0].request_json);
  assert.equal(request.requestedBy, "recovery"); assert.equal(request.endDate, "2026-09-03"); assert.equal(request.kind, "full"); assert.equal(queued[0].created_by, 1); assert.equal(queued[0].kind, "full");
  assert.match(service.getJob(running.id, admin).errors.at(-1).message, new RegExp(queued[0].id));
  assert.equal(service.getJob(running.id, admin).errors.at(-1).reason, "serverRestart");
  assert.equal(service.getJob(queued[0].id, admin).notes[0].includes(running.id), true);
  assert.equal(service.getJob(queued[0].id, admin).requestedBy, "recovery");
  service.cancelJob(queued[0].id, admin);
});

test("the atomic claim lets exactly one runner execute a queued job", async () => {
  const row = insertJobRow({ ...base(), canMonetary: true, requestedBy: "user" });
  const engine = directEngine();
  const [a, b] = await Promise.all([engine.runJob(row), engine.runJob(row)]);
  assert.deepEqual([a.claimed, b.claimed].sort(), [false, true]);
  assert.equal(service.getJob(row.id, admin).status, "completed");
  assert.equal(engine.claim(row.id), false);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_daily_facts"), 3);
});

test("finishing a daily job prunes old drift history and old jobs beyond the newest 30 per owner", async () => {
  const old = new Date(Date.now() - 200 * DAY).toISOString();
  for (let index = 0; index < 35; index += 1) {
    db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,created_at,updated_at,kind) VALUES(?,?,'{}','completed',?,?,'snapshot')")
      .run(`old-${String(index).padStart(2, "0")}`, ownerId, new Date(Date.parse(old) + index * 60000).toISOString(), old);
  }
  const history = db.prepare("INSERT INTO analytic_daily_history(owner_id,entity_key,day,dimension,dimension_value,action,previous_json,new_json,job_id,recorded_at) VALUES(?,?,?,'','',?,'{}','{}',NULL,?)");
  history.run(ownerId, CLAIMED, "2026-03-01", "drift", old); history.run(ownerId, CLAIMED, "2026-03-01", "overwrite", old);
  service.saveSchedule({ ownerId, enabled: true, lookbackDays: 3, channelMode: "none", includeBreakdowns: false, includeSnapshots: false, monetary: false }, admin);
  const job = await run({ kind: "daily", ownerId });
  assert.equal(job.status, "completed");
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_daily_history WHERE action='drift'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_daily_history WHERE action='overwrite'"), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_jobs"), 30);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_jobs WHERE id IN ('old-05',?)", job.id), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_jobs WHERE id='old-06'"), 1);
});

test("no credential reaches the job rows, the ledger, the snapshots or the database file", async () => {
  const job = await run(base({ channelMode: "all", includeSnapshots: true, monetary: true }));
  assert.equal(job.status, "completed");
  const dump = JSON.stringify([db.prepare("SELECT * FROM analytic_jobs").all(), db.prepare("SELECT * FROM analytic_daily_history").all(), db.prepare("SELECT * FROM analytic_snapshots").all(),
    db.prepare("SELECT * FROM analytic_attempts").all(), service.getJob(job.id, admin)]);
  for (const secret of ["fake-access-token", h.network.cms_refresh_token, "Bearer "]) assert.equal(dump.includes(secret), false, secret);
  db.pragma("wal_checkpoint(TRUNCATE)");
  const bytes = fs.readFileSync(process.env.ANALYTICS_DB_PATH, "latin1");
  for (const secret of ["fake-access-token", h.network.cms_refresh_token]) assert.equal(bytes.includes(secret), false, secret);
  assert.ok(h.tokenCalls > 0); assert.ok(fake.tokens.has("Bearer fake-access-token"));
});

test("range snapshots refresh the presets plus the exact range and prune stale ones; channelDetail stores channel facts and the pinned channel reports", async () => {
  const stale = service.normalizeSelection({ ownerId, startDate: "2026-05-01", endDate: "2026-06-01", scope: "claimed" }, h.network);
  const table = { columnHeaders: [], rows: [], coverage: { rowCount: 0 } };
  const videos = catalog.find((report) => report.id === "videos");
  service.persistReport(stale, videos, {}, table);
  service.persistReport(stale, { id: `custom:${"a".repeat(20)}`, monetary: false }, {}, table);
  // A custom range a user synced 40 days ago is pruned; one synced recently is kept; an old 7-day preset is superseded by the new one.
  db.prepare("UPDATE analytic_snapshots SET updated_at=? WHERE owner_id=? AND report_id='videos' AND start_date='2026-05-01'").run(new Date(Date.now() - 40 * DAY).toISOString(), ownerId);
  service.persistReport(service.normalizeSelection({ ownerId, startDate: "2026-04-01", endDate: "2026-05-05", scope: "claimed" }, h.network), videos, {}, table);
  service.persistReport(service.normalizeSelection({ ownerId, startDate: "2026-06-01", endDate: "2026-06-07", scope: "claimed" }, h.network), videos, {}, table);
  const job = await run(base({ endDate: "2026-09-05", includeSnapshots: true, monetary: true }));
  assert.equal(job.status, "completed");
  // The planned total is reconciled with the single 50-id metadata call (estimate assumed 8), so completed reaches total naturally.
  assert.equal(job.plan.requests.breakdown.videoMetadata, 8); assert.equal(job.total, job.plan.requests.estimate - 7);
  assert.equal(job.completed, job.total); assert.equal(job.result.requests, job.total); assert.equal(job.progress, 100);
  const snapshots = db.prepare("SELECT report_id,start_date,end_date,selection_json FROM analytic_snapshots WHERE owner_id=? AND report_id IN ('videos','videoRevenue','demographics') ORDER BY report_id,start_date").all(ownerId);
  assert.equal(snapshots.length, 13);
  assert.deepEqual(snapshots.filter((row) => row.end_date !== "2026-09-05").map((row) => [row.report_id, row.start_date, row.end_date]), [["videos", "2026-04-01", "2026-05-05"]]);
  assert.deepEqual([...new Set(snapshots.map((row) => row.start_date))].sort(), ["2026-04-01", "2026-06-08", "2026-08-09", "2026-08-30", "2026-09-01"]);
  assert.ok(snapshots.every((row) => { const selection = JSON.parse(row.selection_json); return selection.scope === "claimed" && selection.channelId === "" && selection.videoId === "" && selection.currency === "USD" && selection.includeHistoricalChannelData === false; }));
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_snapshots WHERE report_id LIKE 'custom:%'"), 1);
  assert.ok(count("SELECT COUNT(*) AS n FROM analytic_videos WHERE owner_id=?", ownerId) >= 3);
  assert.equal(job.steps.find((step) => step.id === "snapshots").status, "completed");
  assert.equal(service.readReport(service.normalizeSelection({ ownerId, startDate: "2026-08-30", endDate: "2026-09-05", scope: "claimed" }, h.network), catalog.find((report) => report.id === "videos")).status, "ready");
  const detail = await run({ kind: "channelDetail", ownerId, channelId: ids[1], startDate: "2026-09-01", endDate: "2026-09-03", monetary: true });
  assert.equal(detail.status, "completed"); assert.equal(detail.kind, "channelDetail"); assert.equal(detail.channelId, ids[1]); assert.equal(detail.counts.inserted, 3); assert.equal(detail.counts.enriched, 3);
  assert.equal(detail.completed, detail.total); assert.equal(detail.total, detail.plan.requests.estimate - 7);
  const row = fact(`channel:${ids[1]}`, "2026-09-02");
  assert.equal(row.source, "channelDetail"); assert.equal(row.monetary, 1); assert.equal(row.metrics.views, fake.views(`channel:${ids[1]}`, "2026-09-02"));
  assert.equal(coverageRows(`channel:${ids[1]}`).length, 3); assert.ok(coverageRows(`channel:${ids[1]}`).every((entry) => entry.monetary === 1));
  const channelSnapshots = db.prepare("SELECT report_id,selection_json FROM analytic_snapshots WHERE owner_id=? AND selection_json LIKE ?").all(ownerId, `%${ids[1]}%`);
  assert.equal(channelSnapshots.length, 11);
  assert.ok(channelSnapshots.every((entry) => { const selection = JSON.parse(entry.selection_json); return selection.scope === "self" && selection.channelId === ids[1] && selection.startDate === "2026-09-01" && selection.endDate === "2026-09-03"; }));
  assert.deepEqual(detail.steps.map((step) => step.id), ["channelFacts", "snapshots"]);
  assert.throws(() => service.createSync({ kind: "channelDetail", ownerId, channelId: ids[1], startDate: "2026-09-01", endDate: "2026-09-03", monetary: true }, contentId), (error) => error.status === 403);
});

test("the inventory step flags channels that left the CMS, restores them when they reappear and falls back to stored channels when the listing fails", async () => {
  const removed = fake.fixture.channels.pop();
  await run(base());
  assert.ok(db.prepare("SELECT removed_at FROM analytic_channels WHERE owner_id=? AND channel_id=?").get(ownerId, removed.id).removed_at);
  assert.equal(engineLib.activeChannelIds(db, ownerId).length, 4);
  fake.fixture.channels.push(removed);
  const job = await run(base());
  assert.equal(db.prepare("SELECT removed_at FROM analytic_channels WHERE owner_id=? AND channel_id=?").get(ownerId, removed.id).removed_at, null);
  assert.match(job.steps[0].note, /1 restored/);
  fake.fail({ match: (url) => url.endsWith("/channels"), status: 500, times: Infinity });
  const row = insertJobRow({ ...base({ channelMode: "all" }), canMonetary: true, requestedBy: "user" });
  const out = await directEngine().runJob(row);
  assert.equal(out.status, "partial");
  const inventory = out.result.steps[0];
  assert.equal(inventory.id, "inventory"); assert.equal(inventory.status, "warning"); assert.match(inventory.note, /5 stored channels/);
  assert.deepEqual(out.result.channels, { planned: 5, covered: 5 });
  assert.equal(fake.analyticsCalls((params) => params.dimensions === "channel").length, 3);
});

test("refreshProvisional rewrites only the unsettled tail of the daily window in overwrite mode", async () => {
  service.saveSchedule({ ownerId, enabled: true, lookbackDays: 6, lagDays: 3, settleDays: 3, refreshProvisional: true, channelMode: "none", includeBreakdowns: false, includeSnapshots: false, monetary: false }, admin);
  const endDate = addDays(engineLib.bangkokToday(new Date()), -3); const startDate = addDays(endDate, -5);
  const first = await run({ kind: "daily", ownerId });
  assert.equal(first.counts.inserted, 6); assert.equal(first.plan.refreshProvisional, true); assert.equal(first.plan.settleDays, 3);
  fake.revise(CLAIMED, startDate, 5); fake.revise(CLAIMED, addDays(endDate, -1), 9);
  const second = await run({ kind: "daily", ownerId });
  assert.equal(second.counts.drift, 1); assert.equal(second.counts.updated, 1); assert.equal(second.counts.unchanged, 4);
  const rows = ledger();
  assert.deepEqual(rows.map((row) => [row.action, row.day]).sort(), [["drift", startDate], ["overwrite", addDays(endDate, -1)]].sort());
  assert.equal(fact(CLAIMED, addDays(endDate, -1)).revision, 2); assert.equal(fact(CLAIMED, startDate).revision, 1);
  assert.equal(fact(CLAIMED, addDays(endDate, -1)).metrics.views, fake.views(CLAIMED, addDays(endDate, -1)));
});

test("breakdowns are stored per day with coverage, revenue is merged into the content-type rows and per-day shapes are only requested for missing days", async () => {
  const body = base({ includeBreakdowns: true, monetary: true });
  const job = await run(body);
  assert.equal(job.status, "completed");
  const rows = (dimension) => count("SELECT COUNT(*) AS n FROM analytic_daily_breakdowns WHERE owner_id=? AND entity_key=? AND dimension=?", ownerId, CLAIMED, dimension);
  assert.equal(rows("deviceType"), 12); assert.equal(rows("country"), 9); assert.equal(rows("sharingService"), 6); assert.equal(rows("adType"), 6); assert.equal(rows("creatorContentType"), 9);
  const shorts = db.prepare("SELECT metrics_json,monetary FROM analytic_daily_breakdowns WHERE owner_id=? AND entity_key=? AND dimension='creatorContentType' AND day='2026-09-01' AND dimension_value='SHORTS'").get(ownerId, CLAIMED);
  const metrics = JSON.parse(shorts.metrics_json);
  assert.ok(metrics.views > 0 && metrics.estimatedRevenue > 0); assert.equal(shorts.monetary, 1);
  const coverage = warehouse.coverage(db, { ownerId, entityKey: CLAIMED, startDate: "2026-09-01", endDate: "2026-09-03", canMonetary: true });
  assert.deepEqual(coverage.days[0].breakdowns.sort(), ["adType", "country", "creatorContentType", "deviceType", "insightPlaybackLocationType", "insightTrafficSourceType", "liveOrOnDemand", "operatingSystem", "sharingService", "subscribedStatus", "youtubeProduct"]);
  assert.equal(db.prepare("SELECT monetary FROM analytic_day_coverage WHERE owner_id=? AND entity_key=? AND kind='breakdown:country' AND day='2026-09-01'").get(ownerId, CLAIMED).monetary, 1);
  assert.equal(fake.analyticsCalls((params) => ["country", "sharingService"].includes(params.dimensions)).length, 9);
  assert.equal(warehouse.readBreakdown(db, { ownerId, entityKey: CLAIMED, dimension: "country", startDate: "2026-09-01", endDate: "2026-09-03", canMonetary: true }).status, "ready");
  assert.equal(job.steps.filter((step) => step.id.startsWith("breakdown:")).length, 11);
  assert.equal(service.getJob(job.id, contentId).steps.some((step) => step.id === "breakdown:adType"), false);
  fake.calls.length = 0;
  const again = await run(body);
  assert.equal(fake.analyticsCalls((params) => ["country", "sharingService"].includes(params.dimensions)).length, 0);
  assert.equal(fake.analyticsCalls((params) => params.dimensions === "deviceType,day").length, 1);
  assert.equal(again.counts.drift, 0); assert.equal(again.counts.updated, 0); assert.ok(again.counts.unchanged >= 3);
});

test("an overwrite re-requests revenue by country for every covered day and refreshes it", async () => {
  const body = base({ includeBreakdowns: true, monetary: true });
  await run(body);
  const revenue = (day, value) => JSON.parse(db.prepare("SELECT metrics_json FROM analytic_daily_breakdowns WHERE owner_id=? AND entity_key=? AND dimension='country' AND day=? AND dimension_value=?")
    .get(ownerId, CLAIMED, day, value).metrics_json).estimatedRevenue;
  const before = revenue("2026-09-02", "TH");
  fake.revise(CLAIMED, "2026-09-02", 600);
  fake.calls.length = 0;
  const plan = service.planSync({ ...body, mode: "overwrite" }, admin);
  const job = await run({ ...body, mode: "overwrite" });
  assert.equal(job.status, "completed");
  const perDay = fake.analyticsCalls((params) => ["country", "sharingService"].includes(params.dimensions));
  assert.equal(perDay.length, 9); assert.equal(plan.requests.breakdown.perDay, 9);
  assert.equal(perDay.filter((call) => call.params.dimensions === "country" && call.params.metrics.startsWith("estimatedRevenue")).length, 3);
  // The fake hands TH half of the owner's revenue for the day.
  const expected = Math.round((fake.views(CLAIMED, "2026-09-02") / 100) * 0.5 * 100) / 100;
  assert.notEqual(revenue("2026-09-02", "TH"), before); assert.equal(revenue("2026-09-02", "TH"), expected);
});

test("a Data API quota refusal on channels.list is a warning that keeps the stored inventory; a refused credential still fails the job", async () => {
  fake.fail({ match: (url) => url.endsWith("/channels"), status: 403, reason: "quotaExceeded", message: "Quota exceeded for quota metric 'Queries'", times: Infinity });
  const job = await run(base({ channelMode: "all", endDate: "2026-09-02" }));
  assert.equal(job.status, "partial");
  assert.equal(job.steps[0].id, "inventory"); assert.equal(job.steps[0].status, "warning"); assert.match(job.steps[0].note, /5 stored channels/);
  assert.equal(job.errors.length, 1); assert.equal(job.errors[0].reportId, "inventory"); assert.equal(job.errors[0].reason, "quotaExceeded"); assert.equal(job.errors[0].status, 403);
  assert.deepEqual(job.result.channels, { planned: 5, covered: 5 });
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='facts' AND entity_key LIKE 'channel:%'"), 10);
  fake.reset();
  fake.fail({ match: (url) => url.endsWith("/channels"), status: 401, reason: "authError", message: "Invalid Credentials", times: Infinity });
  const refused = await run(base({ channelMode: "all", endDate: "2026-09-02" }));
  assert.equal(refused.status, "failed"); assert.equal(refused.steps[0].status, "failed"); assert.equal(refused.errors.at(-1).status, 401);
  assert.equal(fake.analyticsCalls().length, 0);
});

test("a MONEY request refused with 403 insufficientPermissions skips revenue for the rest of the job with one note instead of failing it", async () => {
  const isMoney = (params) => /estimatedRevenue|grossRevenue/.test(String(params.metrics || ""));
  fake.fail({ match: (url, params) => isMoney(params), status: 403, reason: "insufficientPermissions", message: "Insufficient Permission", times: Infinity });
  const job = await run(base({ channelMode: "all", includeBreakdowns: true, includeSnapshots: true, monetary: true }));
  assert.equal(job.status, "completed"); assert.equal(job.errors.length, 0); assert.equal(job.monetary, true);
  assert.deepEqual(job.notes, ["Revenue was skipped: the CMS token has no revenue scope."]);
  assert.equal(fake.analyticsCalls(isMoney).length, 1);
  assert.equal(fact(CLAIMED, "2026-09-01").metrics.views, fake.views(CLAIMED, "2026-09-01")); assert.equal(fact(CLAIMED, "2026-09-01").monetary, 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='facts' AND monetary=1"), 0);
  const step = (id) => job.steps.find((entry) => entry.id === id);
  assert.equal(step("ownerFacts:claimed").status, "completed"); assert.equal(step("ownerFacts:claimed").note, "Revenue was skipped: the CMS token has no revenue scope.");
  assert.equal(step("channelFacts").status, "completed"); assert.equal(step("breakdown:country").status, "completed"); assert.equal(step("breakdown:creatorContentType").status, "completed");
  assert.equal(step("breakdown:adType").status, "skipped"); assert.equal(step("breakdown:adType").requests, 0);
  assert.equal(step("snapshots").status, "completed");
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_snapshots WHERE report_id='videoRevenue'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_snapshots WHERE report_id='videos'"), 4);
  assert.deepEqual(service.getJob(job.id, contentId).notes, job.notes);
});

test("HTTP 429 that survives the retries is fatal even when the body carries no reason", async () => {
  fake.fail({ match: (url, params) => params.dimensions === "day", status: 429, reason: null, message: "Resource has been exhausted (e.g. check quota).", times: Infinity });
  const job = await run(base());
  assert.equal(job.status, "failed");
  assert.equal(job.errors.length, 1); assert.equal(job.errors[0].reportId, "job"); assert.equal(job.errors[0].status, 429); assert.equal(job.errors[0].reason, "RESOURCE_EXHAUSTED");
  assert.equal(fake.analyticsCalls((params) => params.dimensions === "day").length, 3);
  assert.equal(job.steps.find((step) => step.id === "ownerFacts:claimed").status, "failed");
});

test("googleGet retries 5xx through the service honouring retry-after, and a rate limit that outlives the retries fails the job", async () => {
  fake.fail({ match: (url, params) => params.dimensions === "country" && params.startDate === "2026-09-01", status: 503, reason: "backendError", times: 2, headers: { "retry-after": "1" } });
  const job = await run(base({ includeBreakdowns: true }));
  assert.equal(job.status, "completed"); assert.equal(job.errors.length, 0);
  const calls = fake.analyticsCalls((params) => params.dimensions === "country" && params.startDate === "2026-09-01");
  assert.equal(calls.length, 3);
  assert.ok(calls[1].at - calls[0].at >= 900 && calls[2].at - calls[1].at >= 900, "retry-after is honoured between attempts");
  assert.equal(job.steps.find((step) => step.id === "breakdown:country").failures, 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='breakdown:country'"), 3);
  fake.reset();
  fake.fail({ match: (url, params) => params.dimensions === "country", status: 429, reason: "rateLimitExceeded", message: "Rate Limit Exceeded", times: 3 });
  const limited = await run(base({ startDate: "2026-09-04", endDate: "2026-09-06", includeBreakdowns: true }));
  assert.equal(limited.status, "failed");
  assert.equal(limited.errors.length, 1); assert.equal(limited.errors[0].reason, "rateLimitExceeded"); assert.equal(limited.errors[0].status, 429);
  assert.equal(fake.analyticsCalls((params) => params.dimensions === "country").length, 3);
  assert.equal(limited.steps.find((step) => step.id === "breakdown:country").status, "failed");
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='breakdown:country'"), 3);
});

test("a job whose row stopped being `running` (taken over by another process) is never resurrected by finish or claim", async () => {
  const row = insertJobRow({ ...base({ endDate: "2026-09-05", channelMode: "all" }), canMonetary: true, requestedBy: "user" });
  fake.onRequest = (url, params, number) => { if (number === 2) db.prepare("UPDATE analytic_jobs SET status='interrupted' WHERE id=?").run(row.id); };
  const engine = directEngine();
  const out = await engine.runJob(row);
  assert.equal(out.claimed, true); assert.equal(out.status, "cancelled");
  assert.equal(fake.calls.length, 2);
  const stored = db.prepare("SELECT status,finished_at FROM analytic_jobs WHERE id=?").get(row.id);
  assert.equal(stored.status, "interrupted"); assert.equal(stored.finished_at, null);
  assert.equal(engine.claim(row.id), false);
  assert.equal(db.prepare("SELECT status FROM analytic_jobs WHERE id=?").get(row.id).status, "interrupted");
});

test("effectiveLimits is the single parser of the sync limits with the engine's clamps", () => {
  assert.deepEqual(engineLib.effectiveLimits(), { maxRequestsPerJob: 5000, channelBatch: 200, paceMs: 0 });
  process.env.ANALYTICS_CHANNEL_BATCH = "1000"; process.env.ANALYTICS_MAX_REQUESTS_PER_JOB = "12"; process.env.ANALYTICS_PACE_MS = "40";
  try {
    const limits = engineLib.effectiveLimits();
    assert.deepEqual(limits, { maxRequestsPerJob: 12, channelBatch: 200, paceMs: 40 });
    assert.equal(service.planSync(base({ channelMode: "all" }), admin).batch, limits.channelBatch);
    assert.equal(service.planSync(base(), admin).cap, limits.maxRequestsPerJob);
  } finally { delete process.env.ANALYTICS_CHANNEL_BATCH; delete process.env.ANALYTICS_MAX_REQUESTS_PER_JOB; process.env.ANALYTICS_PACE_MS = "0"; }
});

test("the fake refuses the request shapes the real Analytics API answers with 400", async () => {
  const reports = "https://youtubeanalytics.googleapis.com/v2/reports";
  const ok = { ids: `contentOwner==${ownerId}`, startDate: "2026-09-01", endDate: "2026-09-01", metrics: "views", dimensions: "day", filters: "claimedStatus==claimed" };
  const rejected = (params) => assert.rejects(fake.handler(reports, { params }), (error) => error.response.status === 400 && error.response.data.error.errors[0].reason === "badRequest");
  await rejected({ ...ok, dimensions: "country,day" });
  await rejected({ ...ok, dimensions: "sharingService,day", metrics: "shares" });
  await rejected({ ...ok, dimensions: "deviceType,country" });
  await rejected({ ...ok, dimensions: "channel", filters: `channel==${ids[0]};claimedStatus==claimed` });
  await rejected({ ...ok, dimensions: "adType,day", metrics: "grossRevenue,adImpressions,cpm", filters: `channel==${ids[0]}` });
  await rejected({ ...ok, dimensions: "deviceType,day", metrics: "views,estimatedRevenue" });
  await rejected({ ...ok, ids: "contentOwner==SOMEONE_ELSE" });
  await rejected({ ...ok, ids: undefined });
  await rejected({ ...ok, filters: "" });
  await rejected({ ...ok, filters: "uploaderType==thirdParty" });
  for (const params of [ok, { ...ok, dimensions: "ageGroup,gender", metrics: "viewerPercentage" }, { ...ok, dimensions: "channel", filters: `channel==${ids[0]}` },
    { ...ok, dimensions: "country", metrics: "estimatedRevenue" }, { ...ok, dimensions: "adType,day", metrics: "grossRevenue,adImpressions,cpm" },
    { ...ok, filters: "claimedStatus==claimed;uploaderType==thirdParty" }, { ...ok, filters: "uploaderType==self" }]) {
    assert.ok(Array.isArray((await fake.handler(reports, { params })).data.columnHeaders));
  }
  const channels = "https://www.googleapis.com/youtube/v3/channels";
  await assert.rejects(fake.handler(channels, { params: { part: "snippet", maxResults: 50 } }), (error) => error.response.status === 400);
  await assert.rejects(fake.handler(channels, { params: { part: "snippet", maxResults: 50, managedByMe: true } }), (error) => error.response.status === 400);
  assert.equal((await fake.handler(channels, { params: { part: "snippet", maxResults: 50, managedByMe: true, onBehalfOfContentOwner: ownerId } })).data.items.length, 5);
});

test("a 230-channel inventory pages channels.list five times and sends channel facts in batches of 200 and 30", async () => {
  const extra = Array.from({ length: 225 }, (_, index) => ({ id: channelId(5 + index), title: `Channel ${6 + index}`, country: "VN" }));
  assert.equal(new Set(extra.map((channel) => channel.id)).size, 225);
  fake.fixture.channels.push(...extra);
  // The inventory is known from earlier runs, so the plan already counts two batches per day.
  for (const channel of extra) db.prepare("INSERT INTO analytic_channels(owner_id,channel_id,title,metadata_json) VALUES(?,?,?,'{}')").run(ownerId, channel.id, channel.title);
  try {
    const job = await run(base({ channelMode: "all", endDate: "2026-09-02" }));
    assert.equal(job.status, "completed");
    const pages = fake.calls.filter((call) => call.url.endsWith("/channels"));
    assert.deepEqual(pages.map((call) => call.params.pageToken), [undefined, "page-50", "page-100", "page-150", "page-200"]);
    assert.ok(pages.every((call) => call.params.onBehalfOfContentOwner === ownerId && call.params.managedByMe === true && call.params.maxResults === 50));
    assert.equal(new Set(engineLib.activeChannelIds(db, ownerId)).size, 230);
    const channelCalls = fake.analyticsCalls((params) => params.dimensions === "channel");
    assert.equal(channelCalls.length, 4);
    for (const day of ["2026-09-01", "2026-09-02"]) {
      const sizes = channelCalls.filter((call) => call.params.startDate === day).map((call) => call.params.filters.replace("channel==", "").split(",").length).sort((a, b) => b - a);
      assert.deepEqual(sizes, [200, 30]);
    }
    assert.ok(channelCalls.every((call) => call.params.maxResults === call.params.filters.replace("channel==", "").split(",").length && call.params.startIndex === 1));
    assert.deepEqual(job.result.channels, { planned: 230, covered: 230 });
    assert.equal(job.plan.requests.breakdown.channelFacts, 4);
    assert.equal(count("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='facts' AND entity_key LIKE 'channel:%'"), 460);
  } finally { fake.fixture.channels.length = 5; }
});

test("report pages beyond 200 rows are fetched with startIndex and stored completely; a second run leaves them unchanged", async () => {
  const body = base({ startDate: "2026-01-01", endDate: "2026-09-07", includeBreakdowns: true });
  const job = await run(body);
  assert.equal(job.status, "completed");
  assert.deepEqual(fake.analyticsCalls((params) => params.dimensions === "day" && params.filters === "claimedStatus==claimed").map((call) => call.params.startIndex), [1, 201]);
  assert.ok(fake.analyticsCalls((params) => params.dimensions === "deviceType,day" && Number(params.startIndex) === 201).length >= 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_daily_facts WHERE owner_id=? AND entity_key=?", ownerId, CLAIMED), 250);
  for (const row of db.prepare("SELECT day,metrics_json FROM analytic_daily_facts WHERE owner_id=? AND entity_key=?").all(ownerId, CLAIMED)) assert.equal(JSON.parse(row.metrics_json).views, fake.views(CLAIMED, row.day));
  assert.equal(count("SELECT COUNT(*) AS n FROM analytic_daily_breakdowns WHERE owner_id=? AND entity_key=? AND dimension='deviceType'", ownerId, CLAIMED), 1000);
  assert.equal(job.steps.find((step) => step.id === "ownerFacts:claimed").inserted, 250);
  assert.deepEqual(job.result.days, { ...job.result.days, requested: 250, covered: 250, addedCount: 250, driftedCount: 0 }); assert.equal(job.result.days.added.length, 100);
  fake.calls.length = 0;
  const again = await run(body);
  assert.equal(again.status, "completed"); assert.equal(again.counts.drift, 0); assert.equal(again.counts.inserted, 0);
  assert.equal(again.steps.find((step) => step.id === "ownerFacts:claimed").unchanged, 250);
  assert.equal(fake.analyticsCalls((params) => ["country", "sharingService"].includes(params.dimensions)).length, 0);
});
