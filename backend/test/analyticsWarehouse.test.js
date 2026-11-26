const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const ExcelJS = require("exceljs");
const w = require("../src/services/analyticsWarehouse");

const ownerId = "owner-test";
const OWNER = "owner:claimed";
const A = `channel:UC${"a".repeat(22)}`;
const B = `channel:UC${"b".repeat(22)}`;
const T1 = "2026-10-25T02:00:00.000Z";
const T2 = "2026-10-26T02:00:00.000Z";
// Live numbers from the Content Owner (brief §1): minutes*60/engagedViews is about 813 seconds.
const LIVE = { views: 360588, estimatedMinutesWatched: 3746465, engagedViews: 276492, averageViewDuration: 813, averageViewPercentage: 20.4, subscribersGained: 50, subscribersLost: 20 };
const MONEY = { estimatedRevenue: 198.486, grossRevenue: 389.178, adImpressions: 238345, cpm: 1.633, monetizedPlaybacks: 141056, playbackBasedCpm: 2.759 };
const SMALL = { views: 100000, estimatedMinutesWatched: 500000, engagedViews: 80000, averageViewDuration: 375, averageViewPercentage: 30, subscribersGained: 5, subscribersLost: 1 };

function fresh() { const db = new Database(":memory:"); w.ensureWarehouseSchema(db); return db; }
const fact = (db, key, day) => { const row = db.prepare("SELECT * FROM analytic_daily_facts WHERE owner_id=? AND entity_key=? AND day=?").get(ownerId, key, day); return row ? { ...row, metrics: JSON.parse(row.metrics_json) } : null; };
const ledger = (db) => db.prepare("SELECT * FROM analytic_daily_history ORDER BY id").all().map((row) => ({ ...row, previous: JSON.parse(row.previous_json), next: JSON.parse(row.new_json) }));
const write = (db, key, rows, mode, extra = {}) => w.writeFacts(db, { ownerId, entityKey: key, rows, mode, source: extra.source || "daily", jobId: extra.jobId || "job-1", monetary: !!extra.monetary, now: extra.now || T1 });
const counts = (partial) => ({ inserted: 0, updated: 0, enriched: 0, unchanged: 0, drift: 0, skipped: 0, ...partial });

test("schema creation is idempotent on :memory: and adds the job/channel columns only when those tables exist", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE analytic_jobs(id TEXT PRIMARY KEY, status TEXT); CREATE TABLE analytic_channels(owner_id TEXT, channel_id TEXT)");
  w.ensureWarehouseSchema(db); w.ensureWarehouseSchema(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  for (const table of ["analytic_meta", "analytic_daily_facts", "analytic_daily_breakdowns", "analytic_day_coverage", "analytic_daily_history"]) assert.ok(names.includes(table), table);
  assert.deepEqual(db.prepare("PRAGMA table_info(analytic_jobs)").all().map((c) => c.name), ["id", "status", "kind", "mode"]);
  assert.deepEqual(db.prepare("PRAGMA table_info(analytic_channels)").all().map((c) => c.name), ["owner_id", "channel_id", "removed_at"]);
  assert.equal(fresh().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('analytic_jobs','analytic_channels')").get().n, 0);
});

test("registry, monetary keys, entity keys and metric normalisation", () => {
  assert.deepEqual([...w.MONETARY_KEYS], ["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "grossRevenue", "monetizedPlaybacks", "playbackBasedCpm", "adImpressions", "cpm", "rpm"]);
  assert.equal(w.METRIC_REGISTRY.find((m) => m.key === "averageViewDuration").additive, false);
  assert.equal(w.METRIC_REGISTRY.find((m) => m.key === "rpm").derived && w.METRIC_REGISTRY.find((m) => m.key === "rpm").monetary, true);
  assert.deepEqual(w.stripMonetary({ views: 1, cpm: 2, rpm: 3 }, false), { views: 1 });
  assert.deepEqual(w.stripMonetary({ views: 1, cpm: 2 }, true), { views: 1, cpm: 2 });
  assert.equal(w.entityKey({ scope: "self" }), "owner:self"); assert.equal(w.entityKey({ channelId: `UC${"a".repeat(22)}` }), A);
  assert.deepEqual(w.parseEntityKey("owner:thirdParty"), { type: "owner", scope: "thirdParty" });
  assert.deepEqual(w.parseEntityKey(A), { type: "channel", channelId: `UC${"a".repeat(22)}` });
  assert.throws(() => w.parseEntityKey("owner:all"), (e) => e.status === 400); assert.throws(() => w.entityKey({ channelId: "bad" }), (e) => e.status === 400);
  assert.equal(w.isOwnerKey(OWNER), true); assert.equal(w.isOwnerKey(A), false);
  assert.deepEqual(w.normalizeMetrics({ views: "12", b: null, a: NaN, day: "2026-10-01", z: Infinity, c: 1.5, d: undefined, e: "" }), { c: 1.5, views: 12 });
  assert.deepEqual(Object.keys(w.normalizeMetrics({ z: 1, a: 2 })), ["a", "z"]);
  assert.deepEqual(w.previousRange({ startDate: "2026-10-04", endDate: "2026-10-10" }), { startDate: "2026-09-27", endDate: "2026-10-03" });
});

test("decision table: insert, append unchanged and append enrichment", () => {
  const db = fresh();
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: LIVE }], "append"), counts({ inserted: 1 }));
  let row = fact(db, OWNER, "2026-10-01");
  assert.deepEqual([row.revision, row.monetary, row.source, row.job_id, row.first_synced_at, row.last_synced_at, row.last_changed_at], [1, 0, "daily", "job-1", T1, T1, T1]);
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, nothing: null } }], "append", { now: T2, jobId: "job-2" }), counts({ unchanged: 1 }));
  row = fact(db, OWNER, "2026-10-01");
  assert.deepEqual([row.revision, row.job_id, row.last_synced_at, row.last_changed_at], [1, "job-1", T2, T1]);
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: MONEY }], "append", { monetary: true, now: T2, jobId: "job-3" }), counts({ enriched: 1 }));
  row = fact(db, OWNER, "2026-10-01");
  assert.deepEqual(row.metrics, w.normalizeMetrics({ ...LIVE, ...MONEY }));
  assert.deepEqual([row.revision, row.monetary, row.job_id, row.last_changed_at, row.last_synced_at], [1, 1, "job-3", T1, T2]);
  assert.deepEqual(Object.keys(row.metrics), Object.keys(row.metrics).slice().sort());
  assert.equal(ledger(db).length, 0);
  assert.throws(() => write(db, OWNER, [{ day: "2026-10-01", metrics: LIVE }], "both"), /append or overwrite/);
  assert.throws(() => w.writeFacts(db, { ownerId, entityKey: OWNER, rows: [], mode: "append", source: "daily", currency: "VND" }), /USD/);
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-02", metrics: { views: null, likes: NaN } }], "append"), counts({ skipped: 1 }));
});

test("decision table: append drift keeps stored values, merges new keys, records changed keys once", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: LIVE }], "append");
  const revised = { ...LIVE, views: 370000, engagedViews: 280000, likes: 42 };
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: revised }], "append", { now: T2, jobId: "job-2" }), counts({ drift: 1 }));
  const row = fact(db, OWNER, "2026-10-01");
  assert.deepEqual(row.metrics, w.normalizeMetrics({ ...LIVE, likes: 42 }));
  assert.deepEqual([row.revision, row.job_id, row.source, row.last_synced_at, row.last_changed_at], [1, "job-1", "daily", T2, T1]);
  let rows = ledger(db);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].action, rows[0].dimension, rows[0].job_id, rows[0].recorded_at], ["drift", "", "job-2", T2]);
  assert.deepEqual(rows[0].next, { engagedViews: [276492, 280000], views: [360588, 370000] });
  assert.deepEqual(rows[0].previous, { engagedViews: 276492, views: 360588 });
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: revised }], "append", { now: T2, jobId: "job-3" }), counts({ drift: 1 }));
  assert.equal(ledger(db).length, 1);
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: { ...revised, views: 371000 } }], "append", { jobId: "job-4" }), counts({ drift: 1 }));
  rows = ledger(db);
  assert.equal(rows.length, 2); assert.deepEqual(rows[1].next, { engagedViews: [276492, 280000], views: [360588, 371000] });
  assert.equal(fact(db, OWNER, "2026-10-01").metrics.views, 360588);
});

test("drift dedupe survives the alternating basic and monetary passes of the daily sync", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, ...MONEY } }], "append", { monetary: true });
  const basic = { ...LIVE, views: 370000 }; const money = { ...MONEY, estimatedRevenue: 200 };
  // run 1: basic pass then money pass → two drift rows
  write(db, OWNER, [{ day: "2026-10-01", metrics: basic }], "append", { now: T2, jobId: "run-1" });
  write(db, OWNER, [{ day: "2026-10-01", metrics: money }], "append", { now: T2, jobId: "run-1", monetary: true });
  assert.deepEqual(ledger(db).map((row) => [row.job_id, Object.keys(row.next)]), [["run-1", ["views"]], ["run-1", ["estimatedRevenue"]]]);
  // run 2 reports the same numbers again: nothing new is recorded, although the latest row belongs to the other pass
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: basic }], "append", { now: T2, jobId: "run-2" }), counts({ drift: 1 }));
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: money }], "append", { now: T2, jobId: "run-2", monetary: true }), counts({ drift: 1 }));
  assert.equal(ledger(db).length, 2);
  // a different observation is still recorded
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...basic, views: 371000 } }], "append", { now: T2, jobId: "run-3" });
  assert.deepEqual(ledger(db).at(-1).next, { views: [360588, 371000] });
  assert.equal(fact(db, OWNER, "2026-10-01").metrics.views, 360588);
});

test("one overwriting job bumps the revision once across its basic and monetary passes; another job bumps it again", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, ...MONEY } }], "append", { monetary: true });
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, views: 370000 } }], "overwrite", { now: T2, jobId: "job-2", source: "full" }), counts({ updated: 1 }));
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: { ...MONEY, estimatedRevenue: 200 } }], "overwrite", { now: T2, jobId: "job-2", source: "full", monetary: true }), counts({ updated: 1 }));
  assert.deepEqual([fact(db, OWNER, "2026-10-01").revision, fact(db, OWNER, "2026-10-01").metrics.views, fact(db, OWNER, "2026-10-01").metrics.estimatedRevenue], [2, 370000, 200]);
  assert.deepEqual(ledger(db).map((row) => [row.action, row.job_id, Object.keys(row.next)]), [["overwrite", "job-2", ["views"]], ["overwrite", "job-2", ["estimatedRevenue"]]]);
  assert.deepEqual(ledger(db)[0].previous.views, 360588);
  write(db, OWNER, [{ day: "2026-10-01", metrics: { views: 380000 } }], "overwrite", { jobId: "job-3", source: "full" });
  assert.equal(fact(db, OWNER, "2026-10-01").revision, 3);
  // without job ids every overwrite call still counts
  for (const views of [390000, 400000]) w.writeFacts(db, { ownerId, entityKey: OWNER, rows: [{ day: "2026-10-01", metrics: { views } }], mode: "overwrite", source: "full", jobId: null, now: T2 });
  assert.equal(fact(db, OWNER, "2026-10-01").revision, 5);
});

test("decision table: overwrite merges key-wise, keeps absent keys, bumps revision and records the full previous object", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, ...MONEY } }], "append", { monetary: true });
  const incoming = { views: 370000, likes: 7 };
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: incoming }], "overwrite", { now: T2, jobId: "job-2", source: "full" }), counts({ updated: 1 }));
  const row = fact(db, OWNER, "2026-10-01");
  assert.deepEqual(row.metrics, w.normalizeMetrics({ ...LIVE, ...MONEY, ...incoming }));
  assert.deepEqual([row.revision, row.monetary, row.source, row.job_id, row.last_synced_at, row.last_changed_at, row.first_synced_at], [2, 1, "full", "job-2", T2, T2, T1]);
  const rows = ledger(db);
  assert.equal(rows.length, 1); assert.equal(rows[0].action, "overwrite");
  assert.deepEqual(rows[0].previous, w.normalizeMetrics({ ...LIVE, ...MONEY }));
  assert.deepEqual(rows[0].next, { views: 370000 });
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: incoming }], "overwrite", { jobId: "job-3" }), counts({ unchanged: 1 }));
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: { comments: 3 } }], "overwrite", { jobId: "job-4" }), counts({ enriched: 1 }));
  assert.deepEqual([fact(db, OWNER, "2026-10-01").revision, fact(db, OWNER, "2026-10-01").metrics.comments, ledger(db).length], [2, 3, 1]);
});

test("a non-monetary overwrite never touches revenue and writes no ledger entry about it", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, ...MONEY } }], "append", { monetary: true });
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: { views: 1, estimatedRevenue: 0, cpm: 0, grossRevenue: 999 } }], "overwrite", { jobId: "job-2", now: T2 }), counts({ updated: 1 }));
  const row = fact(db, OWNER, "2026-10-01");
  assert.deepEqual(w.stripMonetary(row.metrics, true), w.normalizeMetrics({ ...LIVE, ...MONEY, views: 1 }));
  assert.equal(row.monetary, 1);
  const [entry] = ledger(db);
  assert.deepEqual(entry.next, { views: 1 });
  assert.equal(Object.keys(entry.next).some((key) => w.MONETARY_KEYS.has(key)), false);
  const hidden = w.history(db, { ownerId, canMonetary: false }).entries[0];
  assert.deepEqual(hidden.changedKeys, [{ key: "views", before: 360588, after: 1 }]);
  assert.equal(Object.keys(hidden.previous).some((key) => w.MONETARY_KEYS.has(key)), false);
  assert.deepEqual(write(db, OWNER, [{ day: "2026-10-01", metrics: { estimatedRevenue: 5 } }], "overwrite", { jobId: "job-3" }), counts({ skipped: 1 }));
  assert.equal(fact(db, OWNER, "2026-10-01").metrics.estimatedRevenue, 198.486);
});

test("coverage marks never lower the monetary flag and missing days are monetary-aware", () => {
  const db = fresh();
  w.markCoverage(db, { ownerId, entityKey: OWNER, days: ["2026-10-01", "2026-10-02"], kind: "facts", monetary: false, jobId: "j1", now: T1 });
  w.markCoverage(db, { ownerId, entityKey: OWNER, days: ["2026-10-01"], kind: "facts", monetary: true, jobId: "j2", now: T2 });
  w.markCoverage(db, { ownerId, entityKey: OWNER, days: ["2026-10-01"], kind: "facts", monetary: false, jobId: "j3", now: T2 });
  assert.deepEqual(db.prepare("SELECT day,monetary,job_id,synced_at FROM analytic_day_coverage ORDER BY day").all(),
    [{ day: "2026-10-01", monetary: 1, job_id: "j3", synced_at: T2 }, { day: "2026-10-02", monetary: 0, job_id: "j1", synced_at: T1 }]);
  const range = { ownerId, entityKey: OWNER, startDate: "2026-10-01", endDate: "2026-10-04", kind: "facts" };
  assert.deepEqual(w.missingDays(db, { ...range, monetary: false }), ["2026-10-03", "2026-10-04"]);
  assert.deepEqual(w.missingDays(db, { ...range, monetary: true }), ["2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(w.missingDays(db, { ...range, kind: "breakdown:country" }), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.equal(w.latestCoveredDay(db, ownerId, "owner:"), "2026-10-02");
  assert.equal(w.latestCoveredDay(db, ownerId, "channel:"), null);
  assert.throws(() => w.missingDays(db, { ...range, startDate: "2026-10-05" }), /startDate/);
});

test("breakdowns: append inserts uncovered days, records day-level drift without writing, overwrite replaces the set", () => {
  const db = fresh();
  const rows = (day, values) => Object.entries(values).map(([value, views]) => ({ day, value, metrics: { views } }));
  const call = (list, mode, extra = {}) => w.writeBreakdowns(db, { ownerId, entityKey: OWNER, dimension: "deviceType", rows: list, mode, source: "daily", jobId: extra.jobId || "b1", monetary: !!extra.monetary, now: extra.now || T1, coveredDays: extra.coveredDays });
  assert.deepEqual(call(rows("2026-10-01", { MOBILE: 10, TV: 5 }), "append", { coveredDays: ["2026-10-01"] }), counts({ inserted: 2 }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_day_coverage WHERE kind='breakdown:deviceType'").get().n, 1);
  assert.deepEqual(call(rows("2026-10-01", { MOBILE: 10, TV: 5 }), "append"), counts({ unchanged: 1 }));
  assert.deepEqual(call(rows("2026-10-01", { MOBILE: 11, DESKTOP: 1 }), "append", { jobId: "b2", now: T2 }), counts({ drift: 1 }));
  assert.deepEqual(db.prepare("SELECT dimension_value,metrics_json FROM analytic_daily_breakdowns ORDER BY dimension_value").all(), [{ dimension_value: "MOBILE", metrics_json: '{"views":10}' }, { dimension_value: "TV", metrics_json: '{"views":5}' }]);
  let entries = ledger(db);
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].action, entries[0].dimension, entries[0].dimension_value], ["drift", "deviceType", ""]);
  assert.deepEqual(entries[0].next, { added: ["DESKTOP"], changed: { MOBILE: { views: [10, 11] } }, missing: ["TV"] });
  assert.deepEqual(call(rows("2026-10-01", { MOBILE: 11, DESKTOP: 1 }), "append", { jobId: "b3" }), counts({ drift: 1 }));
  assert.equal(ledger(db).length, 1);
  assert.deepEqual(call([{ day: "2026-10-01", value: "MOBILE", metrics: { views: 10, grossRevenue: 2 } }, { day: "2026-10-01", value: "TV", metrics: { views: 5 } }], "append", { monetary: true, jobId: "b4" }), counts({ enriched: 1 }));
  assert.deepEqual(JSON.parse(db.prepare("SELECT metrics_json FROM analytic_daily_breakdowns WHERE dimension_value='MOBILE'").get().metrics_json), { grossRevenue: 2, views: 10 });
  // Overwrite (non-monetary): MOBILE's views are replaced and its revenue survives, DESKTOP is added, TV loses its only incoming key and disappears.
  assert.deepEqual(call(rows("2026-10-01", { MOBILE: 11, DESKTOP: 1 }), "overwrite", { jobId: "b5", now: T2 }), counts({ updated: 1 }));
  assert.deepEqual(db.prepare("SELECT dimension_value,metrics_json,revision FROM analytic_daily_breakdowns ORDER BY dimension_value").all(), [{ dimension_value: "DESKTOP", metrics_json: '{"views":1}', revision: 1 }, { dimension_value: "MOBILE", metrics_json: '{"grossRevenue":2,"views":11}', revision: 2 }]);
  entries = ledger(db);
  assert.equal(entries[1].action, "overwrite");
  assert.deepEqual(entries[1].previous, [{ value: "MOBILE", metrics: { grossRevenue: 2, views: 10 } }, { value: "TV", metrics: { views: 5 } }]);
  assert.deepEqual(entries[1].next, [{ value: "DESKTOP", metrics: { views: 1 } }, { value: "MOBILE", metrics: { grossRevenue: 2, views: 11 } }]);
  assert.deepEqual(call(rows("2026-10-01", { MOBILE: 11, DESKTOP: 1 }), "overwrite", { monetary: true, jobId: "b6" }), counts({ unchanged: 1 }));
  assert.deepEqual(db.prepare("SELECT dimension_value FROM analytic_daily_breakdowns ORDER BY dimension_value").all().map((r) => r.dimension_value), ["DESKTOP", "MOBILE"]);
  assert.equal(ledger(db).length, 2);
  // Empty incoming metric objects (a non-monetary job sent only monetary keys) are skipped, never stored as {} rows.
  assert.deepEqual(call([{ day: "2026-10-02", value: "TV", metrics: { grossRevenue: 3 } }], "append", { jobId: "b8" }), counts({ skipped: 1 }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_daily_breakdowns WHERE day='2026-10-02'").get().n, 0);
});

const bd = (db, dimension, list, mode, extra = {}) => w.writeBreakdowns(db, { ownerId, entityKey: OWNER, dimension, rows: list, mode, source: extra.source || "daily", jobId: extra.jobId || "b1", monetary: !!extra.monetary, now: extra.now || T1, coveredDays: extra.coveredDays, metricKeys: extra.metricKeys });
const bdRows = (db, day = "2026-10-01") => db.prepare("SELECT dimension_value AS value,metrics_json,revision,source,job_id,last_changed_at,last_synced_at FROM analytic_daily_breakdowns WHERE day=? ORDER BY dimension_value").all(day).map((row) => ({ ...row, metrics: JSON.parse(row.metrics_json) }));
const BASIC_KEYS = ["views", "engagedViews", "likes"]; const MONEY_KEYS = ["estimatedRevenue", "grossRevenue"];

test("breakdowns overwrite: the money pass keeps the basic keys, both passes bump the revision once and the ledger holds complete row sets (C1)", () => {
  const db = fresh(); const day = "2026-10-01";
  bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { views: 100, engagedViews: 80, likes: 3 } }, { day, value: "SHORTS", metrics: { views: 50, engagedViews: 40, likes: 1 } }], "append", { coveredDays: [day], metricKeys: BASIC_KEYS });
  assert.deepEqual(bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { estimatedRevenue: 1.5, grossRevenue: 2 } }, { day, value: "SHORTS", metrics: { estimatedRevenue: 0.5, grossRevenue: 1 } }], "append", { monetary: true, coveredDays: [day], metricKeys: MONEY_KEYS }), counts({ enriched: 1 }));
  // overwrite job j2: basic pass changes one value, money pass changes the other → both key groups survive on every row
  assert.deepEqual(bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { views: 110, engagedViews: 80, likes: 3 } }, { day, value: "SHORTS", metrics: { views: 50, engagedViews: 40, likes: 1 } }], "overwrite", { jobId: "j2", source: "full", now: T2, coveredDays: [day], metricKeys: BASIC_KEYS }), counts({ updated: 1 }));
  assert.deepEqual(bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { estimatedRevenue: 1.5, grossRevenue: 2 } }, { day, value: "SHORTS", metrics: { estimatedRevenue: 0.7, grossRevenue: 1 } }], "overwrite", { jobId: "j2", source: "full", monetary: true, now: T2, coveredDays: [day], metricKeys: MONEY_KEYS }), counts({ updated: 1 }));
  const rows = bdRows(db);
  assert.deepEqual(rows.map((row) => [row.value, row.metrics, row.revision, row.job_id]), [
    ["SHORTS", { engagedViews: 40, estimatedRevenue: 0.7, grossRevenue: 1, likes: 1, views: 50 }, 2, "j2"],
    ["VIDEO_ON_DEMAND", { engagedViews: 80, estimatedRevenue: 1.5, grossRevenue: 2, likes: 3, views: 110 }, 2, "j2"]]);
  const entries = ledger(db).filter((row) => row.action === "overwrite");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].previous, [{ value: "SHORTS", metrics: { engagedViews: 40, estimatedRevenue: 0.5, grossRevenue: 1, likes: 1, views: 50 } }, { value: "VIDEO_ON_DEMAND", metrics: { engagedViews: 80, estimatedRevenue: 1.5, grossRevenue: 2, likes: 3, views: 100 } }]);
  assert.deepEqual(entries[0].next.find((row) => row.value === "VIDEO_ON_DEMAND").metrics, { engagedViews: 80, estimatedRevenue: 1.5, grossRevenue: 2, likes: 3, views: 110 });
  assert.deepEqual(entries[1].previous, entries[0].next);
  assert.equal(entries[1].next.find((row) => row.value === "SHORTS").metrics.estimatedRevenue, 0.7);
  // the same passes again: nothing differs
  assert.deepEqual(bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { views: 110, engagedViews: 80, likes: 3 } }, { day, value: "SHORTS", metrics: { views: 50, engagedViews: 40, likes: 1 } }], "overwrite", { jobId: "j3", source: "full", metricKeys: BASIC_KEYS }), counts({ unchanged: 1 }));
  // a later job changing a basic value bumps the revision again; the value that did not change keeps revision 2 (U2)
  bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { views: 120, engagedViews: 80, likes: 3 } }, { day, value: "SHORTS", metrics: { views: 50, engagedViews: 40, likes: 1 } }], "overwrite", { jobId: "j4", source: "full", now: T2, metricKeys: BASIC_KEYS });
  assert.deepEqual(bdRows(db).map((row) => [row.value, row.revision, row.last_changed_at]), [["SHORTS", 2, T2], ["VIDEO_ON_DEMAND", 3, T2]]);
  // a value Google no longer returns loses only the requested keys: the basic pass keeps its revenue, the money pass then removes the row
  assert.deepEqual(bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { views: 120, engagedViews: 80, likes: 3 } }], "overwrite", { jobId: "j5", source: "full", metricKeys: BASIC_KEYS }), counts({ updated: 1 }));
  assert.deepEqual(bdRows(db).find((row) => row.value === "SHORTS").metrics, { estimatedRevenue: 0.7, grossRevenue: 1 });
  assert.deepEqual(bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { estimatedRevenue: 1.5, grossRevenue: 2 } }], "overwrite", { jobId: "j5", source: "full", monetary: true, metricKeys: MONEY_KEYS }), counts({ updated: 1 }));
  assert.deepEqual(bdRows(db).map((row) => row.value), ["VIDEO_ON_DEMAND"]);
  // a non-monetary job never names a monetary key in metricKeys: revenue survives a basic pass that lists it
  bd(db, "creatorContentType", [{ day, value: "SHORTS", metrics: { views: 1, estimatedRevenue: 9, grossRevenue: 9 } }], "overwrite", { jobId: "j6", source: "full", monetary: true, metricKeys: [...BASIC_KEYS, ...MONEY_KEYS] });
  assert.deepEqual(bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { views: 120, engagedViews: 80, likes: 3 } }], "overwrite", { jobId: "j7", source: "full", metricKeys: [...BASIC_KEYS, ...MONEY_KEYS] }), counts({ updated: 1 }));
  assert.deepEqual(bdRows(db).find((row) => row.value === "SHORTS").metrics, { estimatedRevenue: 9, grossRevenue: 9 });
  // the string form of metricKeys is accepted as well
  assert.deepEqual(bd(db, "creatorContentType", [{ day, value: "VIDEO_ON_DEMAND", metrics: { views: 120, engagedViews: 80, likes: 3 } }], "overwrite", { jobId: "j8", source: "full", metricKeys: BASIC_KEYS.join(",") }), counts({ unchanged: 1 }));
});

test("breakdowns overwrite with additions only is an enrichment: stored, no ledger row, no revision bump (C2)", () => {
  const db = fresh(); const day = "2026-10-01";
  bd(db, "country", [{ day, value: "VN", metrics: { views: 100 } }, { day, value: "US", metrics: { views: 50 } }], "append", { coveredDays: [day], metricKeys: ["views"] });
  assert.deepEqual(bd(db, "country", [{ day, value: "VN", metrics: { estimatedRevenue: 2 } }, { day, value: "US", metrics: { estimatedRevenue: 1 } }], "overwrite", { jobId: "full-1", source: "full", monetary: true, now: T2, coveredDays: [day], metricKeys: MONEY_KEYS }), counts({ enriched: 1 }));
  assert.deepEqual(bdRows(db).map((row) => [row.value, row.metrics, row.revision, row.source, row.job_id, row.last_changed_at, row.last_synced_at]),
    [["US", { estimatedRevenue: 1, views: 50 }, 1, "full", "full-1", T1, T2], ["VN", { estimatedRevenue: 2, views: 100 }, 1, "full", "full-1", T1, T2]]);
  assert.equal(ledger(db).length, 0);
  assert.equal(db.prepare("SELECT monetary FROM analytic_day_coverage WHERE kind='breakdown:country'").get().monetary, 1);
});

test("breakdowns append: provenance moves only when a key was added; drift dedupe is order-independent (U1, C10)", () => {
  const db = fresh(); const day = "2026-10-01";
  bd(db, "deviceType", [{ day, value: "TV", metrics: { views: 5 } }, { day, value: "MOBILE", metrics: { views: 10 } }], "append", { coveredDays: [day] });
  assert.deepEqual(bd(db, "deviceType", [{ day, value: "TV", metrics: { views: 5 } }, { day, value: "MOBILE", metrics: { views: 10 } }], "append", { jobId: "d2", source: "daily", now: T2 }), counts({ unchanged: 1 }));
  assert.deepEqual(bdRows(db).map((row) => [row.value, row.job_id, row.last_synced_at, row.last_changed_at]), [["MOBILE", "b1", T2, T1], ["TV", "b1", T2, T1]]);
  assert.deepEqual(bd(db, "deviceType", [{ day, value: "TV", metrics: { views: 5, grossRevenue: 1 } }, { day, value: "MOBILE", metrics: { views: 10 } }], "append", { jobId: "d3", monetary: true, now: T2 }), counts({ enriched: 1 }));
  assert.deepEqual(bdRows(db).map((row) => [row.value, row.job_id]), [["MOBILE", "b1"], ["TV", "d3"]]);
  // the same drifted numbers arrive in a different row order: one ledger row, not two
  assert.deepEqual(bd(db, "deviceType", [{ day, value: "TV", metrics: { views: 6 } }, { day, value: "MOBILE", metrics: { views: 11 } }], "append", { jobId: "d4" }), counts({ drift: 1 }));
  assert.deepEqual(bd(db, "deviceType", [{ day, value: "MOBILE", metrics: { views: 11 } }, { day, value: "TV", metrics: { views: 6 } }], "append", { jobId: "d5" }), counts({ drift: 1 }));
  assert.equal(ledger(db).length, 1);
  assert.deepEqual(Object.keys(ledger(db)[0].next.changed), ["MOBILE", "TV"]);
});

test("history: breakdown overwrite entries expose changedKeys per value and metric, added and missing values included (S1)", () => {
  const db = fresh(); const day = "2026-10-01";
  bd(db, "deviceType", [{ day, value: "TV", metrics: { views: 5, grossRevenue: 1 } }, { day, value: "MOBILE", metrics: { views: 10 } }], "append", { monetary: true, coveredDays: [day] });
  bd(db, "deviceType", [{ day, value: "TV", metrics: { views: 6 } }, { day, value: "DESKTOP", metrics: { views: 1 } }], "overwrite", { jobId: "o1", source: "full", now: T2, metricKeys: ["views"] });
  const [entry] = w.history(db, { ownerId, canMonetary: true }).entries;
  assert.deepEqual(entry.changedKeys, [{ key: "views", value: "DESKTOP", before: null, after: 1 }, { key: "views", value: "MOBILE", before: 10, after: null }, { key: "views", value: "TV", before: 5, after: 6 }]);
  assert.deepEqual(entry.next, [{ value: "DESKTOP", metrics: { views: 1 } }, { value: "TV", metrics: { grossRevenue: 1, views: 6 } }]);
  const [hidden] = w.history(db, { ownerId, canMonetary: false }).entries;
  assert.deepEqual(hidden.changedKeys, entry.changedKeys);
  assert.equal(hidden.next.some((row) => "grossRevenue" in row.metrics), false);
  // a money-only overwrite is invisible to non-monetary readers and flagged monetary_only at write time
  bd(db, "deviceType", [{ day, value: "TV", metrics: { grossRevenue: 2 } }], "overwrite", { jobId: "o2", source: "full", monetary: true, metricKeys: ["grossRevenue"] });
  assert.deepEqual(db.prepare("SELECT action,monetary_only FROM analytic_daily_history ORDER BY id").all(), [{ action: "overwrite", monetary_only: 0 }, { action: "overwrite", monetary_only: 1 }]);
  assert.deepEqual(w.history(db, { ownerId, canMonetary: true }).entries[0].changedKeys, [{ key: "grossRevenue", value: "TV", before: 1, after: 2 }]);
  assert.equal(w.history(db, { ownerId, canMonetary: false }).total, 1);
});

test("history pages are exact for non-monetary readers, accept a date range and expose nextBefore (C11, C5)", () => {
  const db = fresh();
  for (let i = 1; i <= 12; i += 1) {
    const day = `2026-10-${String(i).padStart(2, "0")}`;
    write(db, OWNER, [{ day, metrics: { ...LIVE, ...MONEY } }], "append", { monetary: true });
    write(db, OWNER, [{ day, metrics: { ...LIVE, views: LIVE.views + i } }], "append", { now: T2, jobId: `basic-${i}` });
    for (let k = 1; k <= 3; k += 1) write(db, OWNER, [{ day, metrics: { ...MONEY, estimatedRevenue: 200 + k } }], "append", { monetary: true, now: T2, jobId: `money-${i}-${k}` });
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_daily_history").get().n, 48);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_daily_history WHERE monetary_only=1").get().n, 36);
  const page1 = w.history(db, { ownerId, canMonetary: false, limit: 5 });
  assert.deepEqual([page1.entries.length, page1.total, page1.entries.every((e) => e.changedKeys.length === 1 && e.changedKeys[0].key === "views")], [5, 12, true]);
  assert.equal(page1.nextBefore, page1.entries[4].id);
  const page2 = w.history(db, { ownerId, canMonetary: false, limit: 5, before: page1.nextBefore });
  assert.deepEqual([page2.entries.length, page2.total, page2.entries[0].id < page1.nextBefore], [5, 7, true]);
  const page3 = w.history(db, { ownerId, canMonetary: false, limit: 5, before: page2.nextBefore });
  assert.deepEqual([page3.entries.length, page3.total, page3.nextBefore], [2, 2, null]);
  assert.deepEqual([...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.day).sort(), [...Array(12)].map((_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`));
  const admin = w.history(db, { ownerId, canMonetary: true, limit: 10 });
  assert.deepEqual([admin.entries.length, admin.total, admin.nextBefore], [10, 48, admin.entries[9].id]);
  const ranged = w.history(db, { ownerId, canMonetary: true, startDate: "2026-10-03", endDate: "2026-10-04", limit: 100 });
  assert.deepEqual([ranged.total, ranged.entries.length, new Set(ranged.entries.map((e) => e.day)).size], [8, 8, 2]);
  assert.equal(w.history(db, { ownerId, canMonetary: false, startDate: "2026-10-12", endDate: "2026-10-12" }).total, 1);
  assert.equal(w.history(db, { ownerId, canMonetary: true, endDate: "2026-10-01" }).total, 4);
  assert.throws(() => w.history(db, { ownerId, startDate: "2026-10-05", endDate: "2026-10-04" }), /startDate/);
  assert.throws(() => w.history(db, { ownerId, startDate: "2026-13-01" }), /startDate must use/);
});

test("schema upgrade backfills monetary_only on an existing ledger", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE analytic_daily_history (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, entity_key TEXT NOT NULL, day TEXT NOT NULL,
    dimension TEXT NOT NULL DEFAULT '', dimension_value TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, previous_json TEXT NOT NULL, new_json TEXT NOT NULL, job_id TEXT, recorded_at TEXT NOT NULL)`);
  const insert = db.prepare("INSERT INTO analytic_daily_history(owner_id,entity_key,day,dimension,action,previous_json,new_json,recorded_at) VALUES(?,?,?,?,?,?,?,?)");
  insert.run(ownerId, OWNER, "2026-10-01", "", "drift", '{"views":1}', '{"views":[1,2]}', T1);
  insert.run(ownerId, OWNER, "2026-10-01", "", "drift", '{"cpm":1}', '{"cpm":[1,2]}', T1);
  insert.run(ownerId, OWNER, "2026-10-01", "", "overwrite", '{"views":1,"cpm":1}', '{"cpm":3}', T1);
  insert.run(ownerId, OWNER, "2026-10-01", "deviceType", "drift", "[]", '{"added":[],"changed":{"TV":{"grossRevenue":[1,2]}},"missing":[]}', T1);
  insert.run(ownerId, OWNER, "2026-10-01", "deviceType", "overwrite", '[{"value":"TV","metrics":{"views":1}}]', '[{"value":"TV","metrics":{"views":2}}]', T1);
  insert.run(ownerId, OWNER, "2026-10-01", "adType", "overwrite", "[]", '[{"value":"x","metrics":{"views":2}}]', T1);
  insert.run(ownerId, OWNER, "2026-10-01", "", "drift", "not json", "{}", T1);
  w.ensureWarehouseSchema(db); w.ensureWarehouseSchema(db);
  assert.deepEqual(db.prepare("SELECT monetary_only FROM analytic_daily_history ORDER BY id").all().map((r) => r.monetary_only), [0, 1, 1, 1, 0, 1, 0]);
  db.prepare("DELETE FROM analytic_daily_history WHERE previous_json='not json'").run();
  assert.equal(w.history(db, { ownerId, canMonetary: false }).total, 2);
});

test("readSeries treats a stored day without a coverage row as not synced (U4)", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: LIVE }, { day: "2026-10-02", metrics: SMALL }], "append");
  w.markCoverage(db, { ownerId, entityKey: OWNER, days: ["2026-10-01"], now: T1 });
  const [day1, day2] = w.readSeries(db, { ownerId, entityKeys: [OWNER], startDate: "2026-10-01", endDate: "2026-10-02" });
  assert.deepEqual([day1.covered, day1.metrics.views], [true, LIVE.views]);
  assert.deepEqual(day2, { day: "2026-10-02", metrics: null, covered: false, rows: 0, monetaryRows: 0, monetaryViews: 0, approx: [] });
  assert.deepEqual(w.summarize([day1, day2]).coverage, { covered: 1, total: 2 });
  assert.deepEqual(w.missingDays(db, { ownerId, entityKey: OWNER, startDate: "2026-10-01", endDate: "2026-10-02" }), ["2026-10-02"]);
});

test("pruneHistory removes overwrite rows after ANALYTICS_HISTORY_OVERWRITE_DAYS (default 365) (C39)", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: LIVE }], "append");
  write(db, OWNER, [{ day: "2026-10-01", metrics: { views: 1 } }], "overwrite", { source: "full", jobId: "o1", now: T1 });
  write(db, OWNER, [{ day: "2026-10-01", metrics: { views: 2 } }], "overwrite", { source: "full", jobId: "o2", now: "2026-12-01T00:00:00.000Z" });
  write(db, OWNER, [{ day: "2026-10-01", metrics: { views: 3 } }], "append", { jobId: "d1", now: "2026-12-02T00:00:00.000Z" });
  // 2027-10-24: the drift row (180 days) goes, the overwrite rows (365 days) stay; two days later the first overwrite row goes too
  assert.equal(w.pruneHistory(db, { now: "2027-10-24T00:00:00.000Z" }), 1);
  assert.deepEqual(db.prepare("SELECT job_id FROM analytic_daily_history ORDER BY id").all().map((r) => r.job_id), ["o1", "o2"]);
  assert.equal(w.pruneHistory(db, { now: "2027-10-26T00:00:00.000Z" }), 1);
  assert.deepEqual(db.prepare("SELECT job_id FROM analytic_daily_history ORDER BY id").all().map((r) => r.job_id), ["o2"]);
  process.env.ANALYTICS_HISTORY_OVERWRITE_DAYS = "30";
  try { assert.equal(w.pruneHistory(db, { now: "2027-01-05T00:00:00.000Z" }), 1); } finally { delete process.env.ANALYTICS_HISTORY_OVERWRITE_DAYS; }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_daily_history").get().n, 0);
});

test("readSeries rejects mixed or multiple owner keys and aggregates with the documented rules", () => {
  const db = fresh();
  for (const keys of [[OWNER, A], [OWNER, "owner:self"], []]) assert.throws(() => w.readSeries(db, { ownerId, entityKeys: keys, startDate: "2026-10-01", endDate: "2026-10-01" }), (e) => e.status === 400);
  write(db, A, [{ day: "2026-10-01", metrics: { ...LIVE, ...MONEY } }], "append", { monetary: true });
  write(db, B, [{ day: "2026-10-01", metrics: SMALL }], "append");
  for (const key of [A, B]) w.markCoverage(db, { ownerId, entityKey: key, days: ["2026-10-01", "2026-10-02"], monetary: key === A, now: T1 });
  const [single] = w.readSeries(db, { ownerId, entityKeys: [A], startDate: "2026-10-01", endDate: "2026-10-01", canMonetary: true });
  assert.equal(single.metrics.averageViewDuration, 813); assert.equal(single.metrics.averageViewPercentage, 20.4);
  assert.ok(Math.abs(single.metrics.estimatedMinutesWatched * 60 / single.metrics.engagedViews - 813) < 0.01);
  const series = w.readSeries(db, { ownerId, entityKeys: [A, B], startDate: "2026-10-01", endDate: "2026-10-03", canMonetary: true });
  const [day1, day2, day3] = series;
  assert.equal(day1.metrics.views, 460588); assert.equal(day1.metrics.estimatedMinutesWatched, 4246465);
  assert.ok(Math.abs(day1.metrics.averageViewDuration - 4246465 * 60 / 356492) < 1e-9);
  assert.equal(day1.metrics.averageViewPercentage, null);
  assert.ok(Math.abs(day1.metrics.cpm - 389.178 * 1000 / 238345) < 1e-9);
  assert.ok(Math.abs(day1.metrics.playbackBasedCpm - 389.178 * 1000 / 141056) < 1e-9);
  assert.ok(Math.abs(day1.metrics.rpm - 198.486 * 1000 / 360588) < 1e-9);
  assert.equal(day1.metrics.watchHours, 4246465 / 60); assert.equal(day1.metrics.netSubscribers, 34);
  assert.deepEqual([day1.rows, day1.monetaryRows, day1.approx], [2, 1, ["averageViewDuration"]]);
  assert.deepEqual([day2.covered, day2.metrics.views, day2.metrics.estimatedRevenue, day2.metrics.rpm, day2.rows], [true, 0, 0, null, 0]);
  assert.deepEqual(day3, { day: "2026-10-03", metrics: null, covered: false, rows: 0, monetaryRows: 0, monetaryViews: 0, approx: [] });
  const hidden = w.readSeries(db, { ownerId, entityKeys: [A, B], startDate: "2026-10-01", endDate: "2026-10-01", canMonetary: false })[0].metrics;
  assert.equal(Object.keys(hidden).some((key) => w.MONETARY_KEYS.has(key)), false); assert.equal(hidden.views, 460588);
  const zeroEngaged = w.readSeries(db, { ownerId, entityKeys: [A, B], startDate: "2026-10-02", endDate: "2026-10-02", canMonetary: true })[0].metrics;
  assert.equal("averageViewDuration" in zeroEngaged, false);
});

test("summarize recomputes totals from sums, reports monetary coverage and compareSummaries yields percent changes", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, ...MONEY } }, { day: "2026-10-02", metrics: SMALL }], "append", { monetary: true });
  w.markCoverage(db, { ownerId, entityKey: OWNER, days: ["2026-10-01", "2026-10-02", "2026-10-03"], monetary: true, now: T1 });
  const series = w.readSeries(db, { ownerId, entityKeys: [OWNER], startDate: "2026-10-01", endDate: "2026-10-04", canMonetary: true });
  const summary = w.summarize(series);
  assert.equal(summary.totals.views, 460588);
  assert.ok(Math.abs(summary.totals.averageViewDuration - 4246465 * 60 / 356492) < 1e-9);
  assert.notEqual(summary.totals.averageViewDuration, (813 + 375) / 2);
  assert.equal(summary.totals.averageViewPercentage, null);
  assert.ok(Math.abs(summary.totals.cpm - 389.178 * 1000 / 238345) < 1e-9);
  assert.ok(Math.abs(summary.totals.rpm - 198.486 * 1000 / 360588) < 1e-9);
  assert.equal(summary.totals.netSubscribers, 34); assert.equal(summary.totals.watchHours, 4246465 / 60);
  assert.deepEqual(summary.coverage, { covered: 3, total: 4 });
  assert.deepEqual(summary.monetaryCoverage, { rows: 2, monetaryRows: 1, days: 3, monetaryDays: 1 });
  assert.deepEqual([summary.partialRevenue, summary.approx], [true, ["averageViewDuration"]]);
  const previous = w.summarize([{ day: "2026-09-30", covered: true, metrics: { views: 230294, estimatedRevenue: 0 }, rows: 1, monetaryRows: 1, monetaryViews: 230294 }]);
  const changes = w.compareSummaries(summary, previous);
  assert.ok(Math.abs(changes.views - 100) < 1e-9); assert.equal(changes.estimatedRevenue, null); assert.equal(changes.likes, undefined); assert.equal(changes.cpm, null);
  assert.deepEqual(w.summarize([]).totals, {}); assert.equal(w.summarize([]).partialRevenue, false);
  const oneDay = w.summarize(series.slice(0, 1));
  assert.equal(oneDay.metrics, undefined); assert.equal(oneDay.totals.averageViewDuration, 813); assert.deepEqual(oneDay.approx, []);
});

test("channel totals, breakdown reads, coverage flags and raw fact rows", () => {
  const db = fresh();
  write(db, A, [{ day: "2026-10-01", metrics: { ...LIVE, ...MONEY } }, { day: "2026-10-02", metrics: SMALL }], "append", { monetary: true });
  for (const key of [A, B]) w.markCoverage(db, { ownerId, entityKey: key, days: ["2026-10-01", "2026-10-02"], monetary: key === A, now: T1 });
  const totals = w.readChannelTotals(db, { ownerId, channelIds: null, startDate: "2026-10-01", endDate: "2026-10-03", canMonetary: false });
  assert.deepEqual([...totals.keys()].sort(), [`UC${"a".repeat(22)}`, `UC${"b".repeat(22)}`]);
  const a = totals.get(`UC${"a".repeat(22)}`); const b = totals.get(`UC${"b".repeat(22)}`);
  assert.deepEqual([a.coveredDays, a.daysWithRows, a.monetaryDays, a.firstDay, a.lastDay, a.metrics.views, "estimatedRevenue" in a.metrics], [2, 2, 1, "2026-10-01", "2026-10-02", 460588, false]);
  assert.deepEqual(b, { metrics: null, coveredDays: 2, daysWithRows: 0, monetaryDays: 0, firstDay: null, lastDay: null });
  const selected = w.readChannelTotals(db, { ownerId, channelIds: [`UC${"c".repeat(22)}`], startDate: "2026-10-01", endDate: "2026-10-03", canMonetary: true });
  assert.deepEqual(selected.get(`UC${"c".repeat(22)}`), { metrics: null, coveredDays: 0, daysWithRows: 0, monetaryDays: 0, firstDay: null, lastDay: null });
  write(db, OWNER, [{ day: "2026-10-01", metrics: LIVE }], "append");
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, views: 1 } }], "append", { jobId: "drift-job", now: T2 });
  w.markCoverage(db, { ownerId, entityKey: OWNER, days: ["2026-10-01"], now: T2 });
  w.writeBreakdowns(db, { ownerId, entityKey: OWNER, dimension: "sharingService", mode: "append", source: "daily", now: T1, coveredDays: ["2026-10-01"],
    rows: [{ day: "2026-10-01", value: "WHATS_APP", metrics: { shares: 3 } }, { day: "2026-10-01", value: "COPY_PASTE", metrics: { shares: 9 } }] });
  w.writeBreakdowns(db, { ownerId, entityKey: OWNER, dimension: "adType", mode: "append", source: "daily", monetary: true, now: T1, coveredDays: ["2026-10-01"],
    rows: [{ day: "2026-10-01", value: "auctionTrueview", metrics: { grossRevenue: 10, adImpressions: 1000, cpm: 10 } }, { day: "2026-10-01", value: "reservedBumper", metrics: { grossRevenue: 20, adImpressions: 500, cpm: 40 } }] });
  const cov = w.coverage(db, { ownerId, entityKey: OWNER, startDate: "2026-10-01", endDate: "2026-10-05", canMonetary: false, lagDays: 2, latestAllowedDay: "2026-10-05" });
  assert.deepEqual(cov.days[0], { day: "2026-10-01", facts: true, monetary: false, breakdowns: ["sharingService"], drift: true, pending: false });
  assert.deepEqual([cov.covered, cov.missing, cov.pending, cov.firstDay, cov.lastDay, cov.lastSyncedAt, cov.driftDays], [1, ["2026-10-02", "2026-10-03"], ["2026-10-04", "2026-10-05"], "2026-10-01", "2026-10-01", T2, 1]);
  assert.deepEqual(w.coverage(db, { ownerId, entityKey: OWNER, startDate: "2026-10-01", endDate: "2026-10-01", canMonetary: true }).days[0].breakdowns, ["adType", "sharingService"]);
  const sharing = w.readBreakdown(db, { ownerId, entityKey: OWNER, dimension: "sharingService", startDate: "2026-10-01", endDate: "2026-10-02" });
  assert.deepEqual(sharing, { rows: [{ value: "COPY_PASTE", metrics: { shares: 9 } }, { value: "WHATS_APP", metrics: { shares: 3 } }], coveredDays: 1, totalDays: 2, status: "partial" });
  assert.equal(w.readBreakdown(db, { ownerId, entityKey: OWNER, dimension: "sharingService", startDate: "2026-10-01", endDate: "2026-10-01", limit: 1 }).status, "ready");
  assert.equal(w.readBreakdown(db, { ownerId, entityKey: OWNER, dimension: "country", startDate: "2026-10-01", endDate: "2026-10-01" }).status, "missing");
  assert.deepEqual(w.readBreakdown(db, { ownerId, entityKey: OWNER, dimension: "adType", startDate: "2026-10-01", endDate: "2026-10-01", canMonetary: false }), { rows: [], coveredDays: 0, totalDays: 1, status: "unsupported" });
  const ads = w.readBreakdown(db, { ownerId, entityKey: OWNER, dimension: "adType", startDate: "2026-10-01", endDate: "2026-10-01", canMonetary: true });
  assert.deepEqual(ads.rows.map((r) => r.value), ["reservedBumper", "auctionTrueview"]); assert.equal(ads.status, "ready");
  const raw = w.readFactRows(db, { ownerId, entityKeys: [A, OWNER], startDate: "2026-10-01", endDate: "2026-10-02", canMonetary: false, limit: 10 });
  assert.equal(raw.length, 3);
  assert.deepEqual(Object.keys(raw[0]).sort(), ["channelId", "day", "entityKey", "firstSyncedAt", "lastSyncedAt", "metrics", "monetary", "revision", "source"]);
  assert.equal(raw.find((r) => r.entityKey === A).channelId, `UC${"a".repeat(22)}`); assert.equal(raw.find((r) => r.entityKey === OWNER).channelId, null);
  assert.equal(raw.some((r) => Object.keys(r.metrics).some((key) => w.MONETARY_KEYS.has(key))), false);
  assert.throws(() => w.readFactRows(db, { ownerId, entityKeys: [A, OWNER], startDate: "2026-10-01", endDate: "2026-10-02", limit: 2 }), (e) => e.status === 413);
  assert.equal(w.readChannelTotals(db, { ownerId: "someone-else", channelIds: null, startDate: "2026-10-01", endDate: "2026-10-03" }).size, 0);
});

test("history hides monetary-only changes and adType rows from non-monetary readers; pruning removes only old drift rows", () => {
  const db = fresh();
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...LIVE, ...MONEY } }], "append", { monetary: true });
  write(db, OWNER, [{ day: "2026-10-01", metrics: { ...MONEY, estimatedRevenue: 200 } }], "append", { monetary: true, now: T2, jobId: "m1" });
  write(db, OWNER, [{ day: "2026-10-01", metrics: { views: 1, estimatedRevenue: 300 } }], "overwrite", { monetary: true, now: T2, jobId: "m2" });
  w.writeBreakdowns(db, { ownerId, entityKey: OWNER, dimension: "adType", mode: "overwrite", source: "full", monetary: true, now: T1, rows: [{ day: "2026-10-01", value: "x", metrics: { grossRevenue: 1 } }] });
  w.writeBreakdowns(db, { ownerId, entityKey: OWNER, dimension: "adType", mode: "overwrite", source: "full", monetary: true, now: T2, rows: [{ day: "2026-10-01", value: "x", metrics: { grossRevenue: 2 } }] });
  w.writeBreakdowns(db, { ownerId, entityKey: OWNER, dimension: "deviceType", mode: "append", source: "daily", monetary: true, now: T1, coveredDays: ["2026-10-01"], rows: [{ day: "2026-10-01", value: "TV", metrics: { views: 1, grossRevenue: 1 } }] });
  w.writeBreakdowns(db, { ownerId, entityKey: OWNER, dimension: "deviceType", mode: "append", source: "daily", monetary: true, now: T2, rows: [{ day: "2026-10-01", value: "TV", metrics: { views: 1, grossRevenue: 5 } }] });
  const full = w.history(db, { ownerId, canMonetary: true });
  assert.equal(full.total, 4); assert.deepEqual(full.entries.map((e) => [e.action, e.dimension]), [["drift", "deviceType"], ["overwrite", "adType"], ["overwrite", ""], ["drift", ""]]);
  assert.deepEqual(full.entries[3].changedKeys, [{ key: "estimatedRevenue", before: 198.486, after: 200 }]);
  assert.deepEqual(full.entries[0].changedKeys, [{ key: "grossRevenue", value: "TV", before: 1, after: 5 }]);
  const limited = w.history(db, { ownerId, canMonetary: false });
  // total counts only what this reader can see (monetary-only rows are filtered in SQL)
  assert.equal(limited.total, 1); assert.equal(limited.entries.length, 1);
  assert.deepEqual([limited.entries[0].action, limited.entries[0].changedKeys, limited.entries[0].next], ["overwrite", [{ key: "views", before: 360588, after: 1 }], { views: 1 }]);
  assert.equal(w.history(db, { ownerId, entityKey: OWNER, day: "2026-10-02", canMonetary: true }).entries.length, 0);
  assert.deepEqual(w.history(db, { ownerId, canMonetary: true, limit: 1 }).nextBefore, 4);
  assert.deepEqual(w.history(db, { ownerId, canMonetary: true, before: 2 }).nextBefore, null);
  assert.equal(w.history(db, { ownerId, canMonetary: true, before: 2 }).entries.length, 1);
  assert.equal(w.pruneHistory(db, { now: "2027-04-20T00:00:00.000Z" }), 0);
  assert.equal(w.pruneHistory(db, { now: "2027-04-26T00:00:00.000Z" }), 2);
  assert.deepEqual(db.prepare("SELECT action FROM analytic_daily_history ORDER BY id").all().map((r) => r.action), ["overwrite", "overwrite"]);
});

const SNAPSHOT_TABLE = `CREATE TABLE analytic_snapshots (snapshot_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, report_id TEXT NOT NULL,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, selection_json TEXT NOT NULL, query_json TEXT NOT NULL, headers_json TEXT NOT NULL, rows_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL, monetary INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`;
function snapshot(db, key, reportId, selection, rows, updatedAt, availableEndDate) {
  const full = { ownerId, startDate: rows[0].day, endDate: rows.at(-1).day, scope: "claimed", channelId: "", videoId: "", currency: "USD", includeHistoricalChannelData: false, ...selection };
  db.prepare("INSERT INTO analytic_snapshots(snapshot_key,owner_id,report_id,start_date,end_date,selection_json,query_json,headers_json,rows_json,coverage_json,monetary,updated_at) VALUES(?,?,?,?,?,?,'{}','[]',?,?,?,?)")
    .run(key, ownerId, reportId, full.startDate, full.endDate, JSON.stringify(full), JSON.stringify(rows), JSON.stringify({ rowCount: rows.length, availableEndDate }), reportId === "monetaryDaily" ? 1 : 0, updatedAt);
}

test("snapshot migration: newest normalised timestamp wins, channel snapshots map to channel keys, re-run is a no-op unless forced", () => {
  const db = fresh(); db.exec(SNAPSHOT_TABLE);
  // Space-separated timestamp is the NEWER instant; a raw string sort would put the ISO one first.
  snapshot(db, "s1", "daily", {}, [{ day: "2026-10-02", views: 250, estimatedMinutesWatched: 2500 }, { day: "2026-10-03", views: 300 }, { day: "2026-10-04", views: 400 }], "2026-10-21 16:33:02", "2026-10-03");
  snapshot(db, "s2", "daily", {}, [{ day: "2026-10-01", views: 100, likes: 1 }, { day: "2026-10-02", views: 200, likes: 2 }, { day: "2026-10-03", views: 300 }], "2026-10-21T07:00:43.000Z", "2026-10-03");
  snapshot(db, "s3", "monetaryDaily", {}, [{ day: "2026-10-01", estimatedRevenue: 1.5, cpm: 2 }, { day: "2026-10-02", estimatedRevenue: 2.5, cpm: 2 }], "2026-10-21T07:00:50.000Z", "2026-10-02");
  snapshot(db, "s4", "daily", { scope: "self", channelId: "UCFF6WzTgG_b6SF44jb9Iu1g" }, [{ day: "2026-10-01", views: 7038 }], "2026-10-20 17:02:34", "2026-10-01");
  snapshot(db, "s5", "daily", { videoId: "dQw4w9WgXcQ" }, [{ day: "2026-10-01", views: 1 }], "2026-10-22 00:00:00", "2026-10-01");
  snapshot(db, "s6", "daily", { country: "VN" }, [{ day: "2026-10-01", views: 2 }], "2026-10-22 00:00:00", "2026-10-01");
  snapshot(db, "s7", "daily", { includeHistoricalChannelData: true }, [{ day: "2026-10-01", views: 3 }], "2026-10-22 00:00:00", "2026-10-01");
  snapshot(db, "s8", "overview", {}, [{ day: "2026-10-01", views: 4 }], "2026-10-22 00:00:00", "2026-10-01");
  const result = w.migrateSnapshotsToFacts(db, { now: T2 });
  assert.deepEqual(result, { done: true, at: T2, facts: 5, coverage: 4 });
  const owner = (day) => fact(db, OWNER, day);
  assert.deepEqual(owner("2026-10-02").metrics, { cpm: 2, estimatedMinutesWatched: 2500, estimatedRevenue: 2.5, likes: 2, views: 250 });
  assert.deepEqual([owner("2026-10-02").source, owner("2026-10-02").monetary, owner("2026-10-02").first_synced_at, owner("2026-10-02").last_synced_at, owner("2026-10-02").job_id],
    ["migration", 1, "2026-10-21T07:00:43.000Z", "2026-10-21T16:33:02.000Z", null]);
  assert.deepEqual(owner("2026-10-01").metrics, { cpm: 2, estimatedRevenue: 1.5, likes: 1, views: 100 });
  assert.equal(owner("2026-10-04").metrics.views, 400);
  assert.equal(fact(db, "channel:UCFF6WzTgG_b6SF44jb9Iu1g", "2026-10-01").metrics.views, 7038);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_daily_facts").get().n, 5);
  assert.deepEqual(db.prepare("SELECT entity_key,day,monetary,synced_at FROM analytic_day_coverage WHERE kind='facts' ORDER BY entity_key,day").all(), [
    { entity_key: "channel:UCFF6WzTgG_b6SF44jb9Iu1g", day: "2026-10-01", monetary: 0, synced_at: "2026-10-20T17:02:34.000Z" },
    { entity_key: OWNER, day: "2026-10-01", monetary: 1, synced_at: "2026-10-21T07:00:50.000Z" },
    { entity_key: OWNER, day: "2026-10-02", monetary: 1, synced_at: "2026-10-21T16:33:02.000Z" },
    { entity_key: OWNER, day: "2026-10-03", monetary: 0, synced_at: "2026-10-21T16:33:02.000Z" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_daily_history").get().n, 0);
  const meta = JSON.parse(db.prepare("SELECT value FROM analytic_meta WHERE key='migration:snapshots-to-facts'").get().value);
  assert.deepEqual(meta, result);
  snapshot(db, "s9", "daily", {}, [{ day: "2026-10-05", views: 500 }], "2026-10-23 00:00:00", "2026-10-05");
  assert.deepEqual(w.migrateSnapshotsToFacts(db, { now: "2026-10-27T00:00:00.000Z" }), { ...result, skipped: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_daily_facts").get().n, 5);
  write(db, OWNER, [{ day: "2026-10-02", metrics: { views: 999 } }], "overwrite", { source: "full" });
  process.env.ANALYTICS_RERUN_SNAPSHOT_MIGRATION = "1";
  try { assert.deepEqual(w.migrateSnapshotsToFacts(db, { now: "2026-10-27T00:00:00.000Z" }), { done: true, at: "2026-10-27T00:00:00.000Z", facts: 1, coverage: 5 }); }
  finally { delete process.env.ANALYTICS_RERUN_SNAPSHOT_MIGRATION; }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_daily_facts").get().n, 6);
  assert.equal(owner("2026-10-02").metrics.views, 999); assert.equal(owner("2026-10-05").metrics.views, 500);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM analytic_meta WHERE key='migration:snapshots-to-facts'").get().value).at, "2026-10-27T00:00:00.000Z");
  // opt-out flag: nothing is read or written, even on a database that never migrated
  const untouched = fresh(); untouched.exec(SNAPSHOT_TABLE);
  snapshot(untouched, "s1", "daily", {}, [{ day: "2026-10-01", views: 1 }], "2026-10-22 00:00:00", "2026-10-01");
  process.env.ANALYTICS_SKIP_SNAPSHOT_MIGRATION = "1";
  try { assert.deepEqual(w.migrateSnapshotsToFacts(untouched, { now: T2 }), { skipped: true, reason: "ANALYTICS_SKIP_SNAPSHOT_MIGRATION=1" }); }
  finally { delete process.env.ANALYTICS_SKIP_SNAPSHOT_MIGRATION; }
  assert.equal(untouched.prepare("SELECT COUNT(*) AS n FROM analytic_daily_facts").get().n + untouched.prepare("SELECT COUNT(*) AS n FROM analytic_meta").get().n, 0);
});

test("CSV cells neutralise formulas after whitespace, BOM and newlines without touching negative numbers", () => {
  const csv = w.buildCsv({ columns: [{ key: "label", label: "Label" }, { key: "amount", label: "Amount" }],
    rows: [{ label: "   =SUM(1,1)", amount: -7 }, { label: "﻿+1", amount: -2 }, { label: "\n@payload", amount: 0 }, { label: " \t-2+3", amount: -1 }, { label: 'He said "hi"', amount: null }] });
  assert.ok(csv.startsWith("﻿\"Label\",\"Amount\"\r\n"));
  assert.ok(csv.includes('"\'   =SUM(1,1)","-7"')); assert.ok(csv.includes('"\'﻿+1","-2"'));
  assert.ok(csv.includes('"\'\n@payload","0"')); assert.ok(csv.includes('"\' \t-2+3","-1"'));
  assert.ok(csv.includes('"He said ""hi""",""')); assert.equal(csv.includes('"\'-7"'), false);
  assert.equal(w.csvCell(-7), '"-7"'); assert.equal(w.csvCell(undefined), '""'); assert.equal(w.csvCell({ a: 1 }), '""'); assert.equal(w.csvCell("=1"), '"\'=1"');
});

test("workbook cells keep hostile titles as plain strings, type numeric columns and bound sheet names", async () => {
  const workbook = w.buildWorkbook({ meta: { title: "Analytics", ownerId, range: "2026-10-01..2026-10-02", generatedAt: T1, language: "en", notes: ["=1+1", "second"] },
    sheets: [{ name: "Channels and everything else in a very long label", columns: [{ key: "title", label: "Title", type: "text" }, { key: "views", label: "Views", type: "int" }, { key: "revenue", label: "Revenue", type: "money" }, { key: "pct", label: "Average view percentage", type: "percent" }, { key: "day", label: "Day", type: "date" }],
      rows: [{ title: '=HYPERLINK("http://x","y")', views: "12", revenue: 1.5, pct: 18.59, day: "2026-10-01" }, { title: { formula: "SUM(1)" }, views: null, revenue: "abc", pct: null, day: new Date(Date.UTC(2026, 9, 2)) }], totals: { title: "Total", views: 12, revenue: 1.5 } },
      { name: "Channels and everything else in a very long label" }, { name: "Bad/Name:[x]?*" }] });
  assert.deepEqual(workbook.worksheets.map((s) => s.name), ["Summary", "Channels and everything else in", "Channels and everything els (2)", "Bad Name x"]);
  assert.ok(workbook.worksheets.every((s) => s.name.length <= 31));
  const sheet = workbook.worksheets[1];
  const title = sheet.getCell(2, 1);
  assert.equal(title.type, ExcelJS.ValueType.String); assert.equal(title.value, '=HYPERLINK("http://x","y")'); assert.equal(title.numFmt, "@");
  assert.equal(sheet.getCell(3, 1).value, "");
  assert.deepEqual([sheet.getCell(2, 2).type, sheet.getCell(2, 2).value, sheet.getCell(2, 2).numFmt], [ExcelJS.ValueType.Number, 12, "#,##0"]);
  assert.deepEqual([sheet.getCell(2, 3).value, sheet.getCell(2, 3).numFmt, sheet.getCell(3, 3).value], [1.5, '"$"#,##0.00', null]);
  assert.deepEqual([sheet.getCell(2, 4).value, sheet.getCell(2, 4).numFmt], [0.1859, "0.0%"]);
  assert.equal(sheet.getCell(3, 5).value, "2026-10-02T00:00:00.000Z");
  assert.equal(sheet.getRow(1).font.bold, true); assert.deepEqual(sheet.views[0], { state: "frozen", ySplit: 1 });
  assert.equal(sheet.getRow(4).font.bold, true); assert.equal(sheet.getCell(4, 2).value, 12);
  const summary = workbook.worksheets[0];
  assert.equal(summary.getCell(2, 2).value, "Analytics"); assert.equal(summary.getCell(7, 2).value, "=1+1"); assert.equal(summary.getCell(7, 2).type, ExcelJS.ValueType.String);
  const buffer = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook(); await reloaded.xlsx.load(buffer);
  const cell = reloaded.getWorksheet("Channels and everything else in").getCell(2, 1);
  assert.equal(cell.type, ExcelJS.ValueType.String); assert.equal(cell.value, '=HYPERLINK("http://x","y")');
});
