const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-schedules-"));
process.env.ANALYTICS_DB_PATH = path.join(directory, "analytics.sqlite");
process.env.ANALYTICS_PACE_MS = "0";
const network = { id: 1, name: "Schedule fixture", network_code: "OWNER_SCHEDULE", cms_auth_status: "connected", cms_refresh_token: "fixture-only",
  cms_auth_scopes: "https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/yt-analytics-monetary.readonly" };
const FIXTURE_HORIZON = "2026-10-01T00:00:00.000Z";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
let creator = { id: 4, role: "Report Manager", status: "active" };
const mainDatabasePath = require.resolve("../src/config/database");
require.cache[mainDatabasePath] = { id: mainDatabasePath, filename: mainDatabasePath, loaded: true, exports: {
  prepare: (sql) => ({ get: () => /FROM users/.test(sql) ? creator : network, all: () => [network] })
} };
const axios = require("axios");
const originalGet = axios.get;
const db = require("../src/config/analyticsDatabase");
const scheduler = require("../src/services/analyticsScheduleService");
const service = require("../src/services/analyticsService");
const ownerId = network.network_code;
const LEGACY = ["08:00", "14:00"];
const readSchedule = () => db.prepare("SELECT * FROM analytic_schedules WHERE owner_id=?").get(ownerId);
const readRuns = () => db.prepare("SELECT * FROM analytic_schedule_runs WHERE owner_id=? ORDER BY scheduled_for").all(ownerId);
function insertSchedule(overrides = {}) {
  const values = { owner_id: ownerId, enabled: 1, lookback_days: 28, scope: "claimed", monetary: 1, created_by: 4,
    next_run_at: "2026-10-21T02:00:00.000Z", updated_at: FIXTURE_HORIZON, ...overrides };
  db.prepare(`INSERT INTO analytic_schedules(owner_id,enabled,lookback_days,scope,monetary,created_by,next_run_at,updated_at)
    VALUES(@owner_id,@enabled,@lookback_days,@scope,@monetary,@created_by,@next_run_at,@updated_at)`).run(values);
}
// The status horizon is the newest of the v3 migration instant and the schedule's updated_at; pin the migration (which ran
// at module load, i.e. "now") before the fixture dates so slots can be synthesised in these scenarios.
function pinMigrationAt(at) {
  db.prepare("INSERT INTO analytic_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(scheduler.MIGRATION_META_KEY, JSON.stringify({ done: true, at, migrated: 0 }), at);
}
function enqueue(schedule, scheduledFor) {
  const id = `fixture-${scheduledFor}`;
  db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status) VALUES(?,?,?,'queued')").run(id, schedule.owner_id, "{}");
  return { id };
}
beforeEach(() => {
  service.stopWorker();
  axios.get = async () => { throw new Error("Schedule tests never call Google"); };
  db.exec("DELETE FROM analytic_schedule_runs; DELETE FROM analytic_schedules; DELETE FROM analytic_jobs; DELETE FROM analytic_meta WHERE key LIKE 'alert:%' OR key LIKE 'rearm:%';");
  pinMigrationAt(FIXTURE_HORIZON);
  creator = { id: 4, role: "Report Manager", status: "active" };
  network.cms_auth_status = "connected";
});
after(() => { service.stopWorker(); axios.get = originalGet; db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test("the default schedule is one 09:00 GMT+7 slot (02:00 UTC) and the version is 3", () => {
  assert.deepEqual(scheduler.DEFAULT_TIMES, ["09:00"]);
  assert.equal(scheduler.SCHEDULE_VERSION, 3);
  for (const [local, next, latest] of [
    ["08:59", "2026-10-21T02:00:00.000Z", "2026-10-20T02:00:00.000Z"],
    ["09:00", "2026-10-22T02:00:00.000Z", "2026-10-21T02:00:00.000Z"],
    ["09:01", "2026-10-22T02:00:00.000Z", "2026-10-21T02:00:00.000Z"]
  ]) {
    const instant = `2026-10-21T${local}:00+07:00`;
    assert.equal(scheduler.nextSlot(instant), next, local);
    assert.equal(scheduler.latestSlot(instant), latest, local);
  }
  assert.equal(scheduler.previousSlot("2026-10-21T02:00:00.000Z"), "2026-10-20T02:00:00.000Z");
});

test("explicit GMT+7 timetables keep exact slot boundaries (legacy 08:00 and 14:00)", () => {
  for (const [local, next, latest] of [
    ["07:59", "2026-10-21T01:00:00.000Z", "2026-10-20T07:00:00.000Z"],
    ["08:00", "2026-10-21T07:00:00.000Z", "2026-10-21T01:00:00.000Z"],
    ["08:01", "2026-10-21T07:00:00.000Z", "2026-10-21T01:00:00.000Z"],
    ["13:59", "2026-10-21T07:00:00.000Z", "2026-10-21T01:00:00.000Z"],
    ["14:00", "2026-10-22T01:00:00.000Z", "2026-10-21T07:00:00.000Z"],
    ["14:01", "2026-10-22T01:00:00.000Z", "2026-10-21T07:00:00.000Z"]
  ]) {
    const instant = `2026-10-21T${local}:00+07:00`;
    assert.equal(scheduler.nextSlot(instant, LEGACY), next, local);
    assert.equal(scheduler.latestSlot(instant, LEGACY), latest, local);
  }
});

test("month, leap day and year rollover preserve the fixed local wall clock", () => {
  for (const [instant, next] of [
    ["2026-10-31T23:59:59+07:00", "2026-11-01T02:00:00.000Z"],
    ["2026-12-31T23:59:59+07:00", "2027-01-01T02:00:00.000Z"],
    ["2028-02-28T14:00:00+07:00", "2028-02-29T02:00:00.000Z"],
    ["2028-02-29T14:00:00+07:00", "2028-03-01T02:00:00.000Z"]
  ]) assert.equal(scheduler.nextSlot(instant), next);
});

test("host timezone and daylight-saving settings cannot change the UTC schedule", () => {
  const script = "const s=require('./src/services/analyticsScheduleService');process.stdout.write(JSON.stringify([s.nextSlot('2026-03-08T01:59:00Z'),s.latestSlot('2026-11-01T02:00:00Z')]))";
  for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Auckland"]) {
    const child = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { ...process.env, TZ: timezone } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ["2026-03-08T02:00:00.000Z", "2026-11-01T02:00:00.000Z"]);
  }
});

test("timing input rejects malformed, duplicate and non-GMT+7 schedules", () => {
  for (const times of [[], ["8:00"], ["24:00"], ["08:60"], [8], ["08:00", "08:00"], ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"]]) {
    assert.throws(() => scheduler.normalizeTiming(times), (error) => error.status === 400);
  }
  assert.throws(() => scheduler.normalizeTiming(["08:00"], "UTC"), /Asia\/Bangkok/);
  assert.deepEqual(scheduler.normalizeTiming(["14:00", "08:00"]), { times: ["08:00", "14:00"], timezone: "Asia/Bangkok" });
  assert.equal(scheduler.nextSlot("2026-10-21T03:00:00Z", ["11:30"]), "2026-10-21T04:30:00.000Z");
});

test("saving enables the 09:00 daily default with a 7-day lookback and the v3 fields; disabling has no future run", () => {
  const schedule = service.saveSchedule({ ownerId, enabled: true, monetary: true }, { userId: 4, canMonetary: true, canSync: true });
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.lookbackDays, 7); assert.equal(schedule.lagDays, 3); assert.equal(schedule.settleDays, 7);
  assert.deepEqual(schedule.times, ["09:00"]); assert.equal(schedule.timezone, "Asia/Bangkok");
  assert.deepEqual(schedule.scopes, ["claimed"]); assert.equal(schedule.scope, undefined);
  assert.equal(schedule.channelMode, "all"); assert.deepEqual(schedule.channelIds, []);
  assert.equal(schedule.includeBreakdowns, true); assert.equal(schedule.includeSnapshots, true); assert.equal(schedule.refreshProvisional, false);
  assert.equal(schedule.scheduleVersion, 3);
  assert.match(schedule.nextRunAt, /T02:00:00\.000Z$/);
  assert.ok(Date.parse(schedule.nextRunAt) > Date.now());
  assert.equal(schedule.lastRun.status, "not-run");
  const updated = service.saveSchedule({ ownerId, enabled: true, times: ["06:30", "18:00"], lagDays: 5, lookbackDays: 14, scopes: ["self", "claimed"], channelMode: "none",
    includeSnapshots: false, refreshProvisional: true, settleDays: 10 }, { userId: 4, canMonetary: true, canSync: true });
  assert.deepEqual(updated.times, ["06:30", "18:00"]); assert.equal(updated.lagDays, 5); assert.equal(updated.lookbackDays, 14);
  assert.deepEqual(updated.scopes, ["self", "claimed"]); assert.equal(updated.channelMode, "none");
  assert.equal(updated.includeSnapshots, false); assert.equal(updated.refreshProvisional, true); assert.equal(updated.settleDays, 10); assert.equal(updated.monetary, true);
  const kept = service.saveSchedule({ ownerId, enabled: true }, { userId: 4, canMonetary: true, canSync: true });
  assert.deepEqual(kept.times, ["06:30", "18:00"]); assert.equal(kept.lagDays, 5);
  for (const bad of [{ lagDays: 2 }, { lagDays: 8 }, { lookbackDays: 91 }, { settleDays: 1 }, { scopes: ["claimed", "claimed"] }, { scopes: [] }, { channelMode: "some" }, { channelMode: "selected", channelIds: [] },
    { channelMode: "selected", channelIds: ["UC" + "q".repeat(22)] }, { times: ["9:00"] }]) {
    assert.throws(() => service.saveSchedule({ ownerId, enabled: true, ...bad }, { userId: 4, canMonetary: true, canSync: true }), (error) => error.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => service.saveSchedule({ ownerId, enabled: true }, { userId: 4, canMonetary: true, canSync: false }), (error) => error.status === 403);
  network.cms_auth_status = "disconnected";
  const disabled = service.saveSchedule({ ownerId, enabled: false }, { userId: 4, canMonetary: true, canSync: true });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.nextRunAt, null);
  assert.equal(disabled.monetary, true);
  assert.throws(() => service.saveSchedule({ ownerId, enabled: true }, { userId: 4, canMonetary: true, canSync: true }), (error) => error.status === 409);
});

test("disabled and not-yet-due schedules never enqueue", () => {
  insertSchedule();
  assert.deepEqual(scheduler.tick(db, enqueue, { now: "2026-10-21T01:59:00Z" }), { queued: 0, failed: 0, skipped: 0 });
  db.prepare("UPDATE analytic_schedules SET enabled=0").run();
  assert.deepEqual(scheduler.tick(db, enqueue, { now: "2026-10-21T14:00:00Z" }), { queued: 0, failed: 0, skipped: 0 });
  assert.equal(readRuns().length, 0);
});

test("each daily slot queues once and survives a new process without duplicate work", () => {
  insertSchedule();
  const first = scheduler.tick(db, enqueue, { now: "2026-10-21T02:00:00Z" });
  assert.equal(first.queued, 1);
  assert.equal(readSchedule().next_run_at, "2026-10-22T02:00:00.000Z");
  scheduler.tick(db, enqueue, { now: "2026-10-21T02:00:30Z" });
  const script = "const db=require('./src/config/analyticsDatabase');const s=require('./src/services/analyticsScheduleService');db.prepare('UPDATE analytic_schedules SET next_run_at=?').run('2026-10-21T02:00:00.000Z');const r=s.tick(db,()=>{throw new Error('DUPLICATE')},{now:'2026-10-21T03:00:00Z'});process.stdout.write(JSON.stringify(r));db.close()";
  const restarted = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: process.env });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), { queued: 0, failed: 0, skipped: 1 });
  scheduler.tick(db, enqueue, { now: "2026-10-22T02:00:00Z" });
  assert.equal(readRuns().length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs").get().n, 2);
  assert.equal(readSchedule().next_run_at, "2026-10-23T02:00:00.000Z");
});

test("downtime catches only the most recent missed occurrence", () => {
  insertSchedule({ next_run_at: "2026-09-01T02:00:00.000Z" });
  assert.equal(scheduler.tick(db, enqueue, { now: "2026-10-21T09:00:00Z" }).queued, 1);
  assert.equal(readRuns().length, 1);
  assert.equal(readRuns()[0].scheduled_for, "2026-10-21T02:00:00.000Z");
  assert.equal(readSchedule().next_run_at, "2026-10-22T02:00:00.000Z");
});

test("an already queued current slot clears an obsolete retry without duplicate work", () => {
  insertSchedule();
  scheduler.tick(db, enqueue, { now: "2026-10-21T02:00:00Z" });
  db.prepare(`UPDATE analytic_schedules SET next_run_at=?,last_scheduled_for=?,retry_at=?,last_error='old enqueue error' WHERE owner_id=?`)
    .run("2026-10-21T02:00:00.000Z", "2026-10-20T02:00:00.000Z", "2026-10-21T00:01:00.000Z", ownerId);
  assert.equal(scheduler.tick(db, () => { throw new Error("Duplicate"); }, { now: "2026-10-21T03:00:00Z" }).skipped, 1);
  assert.equal(readSchedule().retry_at, null);
  assert.equal(readSchedule().last_error, null);
  assert.equal(readSchedule().last_scheduled_for, "2026-10-21T02:00:00.000Z");
  assert.equal(readRuns().length, 1);
});

test("failed enqueue is visible, rolls back a partial job, and retries the same slot", () => {
  insertSchedule();
  const failing = (schedule, scheduledFor) => { enqueue(schedule, scheduledFor); throw new Error("CMS is disconnected"); };
  const result = scheduler.tick(db, failing, { now: "2026-10-21T02:00:00Z" });
  assert.equal(result.failed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs").get().n, 0);
  assert.equal(readSchedule().last_error, "CMS is disconnected");
  assert.equal(readSchedule().next_run_at, "2026-10-22T02:00:00.000Z");
  assert.equal(readSchedule().retry_at, "2026-10-21T02:01:00.000Z");
  assert.equal(scheduler.tick(db, enqueue, { now: "2026-10-21T02:00:30Z" }).queued, 0);
  assert.equal(scheduler.tick(db, enqueue, { now: "2026-10-21T02:01:00Z" }).queued, 1);
  assert.equal(readRuns()[0].attempts, 2);
  assert.equal(readSchedule().last_error, null);
  assert.equal(readSchedule().retry_at, null);
  assert.equal(readSchedule().last_scheduled_for, "2026-10-21T02:00:00.000Z");
});

test("retry attempts are bounded and a later regular slot can still run", () => {
  insertSchedule();
  const failing = () => { throw new Error("Unavailable"); };
  for (const time of ["02:00", "02:01", "02:06", "02:21", "02:51"]) {
    assert.equal(scheduler.tick(db, failing, { now: `2026-10-21T${time}:00Z` }).failed, 1);
  }
  assert.equal(readRuns()[0].attempts, 5);
  assert.equal(readSchedule().retry_at, null);
  assert.equal(readSchedule().last_error, "Unavailable");
  assert.equal(scheduler.tick(db, enqueue, { now: "2026-10-21T07:00:00Z" }).queued, 0);
  assert.equal(scheduler.tick(db, enqueue, { now: "2026-10-22T02:00:00Z" }).queued, 1);
  assert.equal(readRuns().length, 2);
});

test("runtime rejects inactive, deleted, read-only and revenue-revoked schedule creators", () => {
  for (const user of [null, { id: 4, role: "Report Manager", status: "disabled" }, { id: 4, role: '["Report Manager","Read Only"]', status: "active" },
    { id: 4, role: "Content ID", status: "active" }, { id: 4, role: "user", status: "active" }]) {
    db.exec("DELETE FROM analytic_schedules");
    insertSchedule(); creator = user;
    const result = service.tickSchedules("2026-10-21T02:00:00Z");
    assert.equal(result.failed, 1);
    assert.match(readSchedule().last_error, /creator|permission/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs").get().n, 0);
  }
});

test("the scheduler enqueues a canonical daily request and the queue de-duplicates a user-triggered twin", () => {
  insertSchedule({ next_run_at: "2026-10-21T02:00:00.000Z" });
  const result = service.tickSchedules("2026-10-21T02:00:00Z");
  assert.equal(result.queued, 1);
  const run = readRuns()[0];
  assert.equal(run.status, "queued");
  const job = service.getJob(run.job_id, { canMonetary: true });
  assert.equal(job.kind, "daily"); assert.equal(job.requestedBy, "schedule"); assert.equal(job.monetary, true); assert.equal(job.status, "queued");
  const request = JSON.parse(db.prepare("SELECT request_json FROM analytic_jobs WHERE id=?").get(job.id).request_json);
  assert.deepEqual(request, { kind: "daily", ownerId, monetary: true, canMonetary: true, requestedBy: "schedule" });
  const twin = service.createSync({ kind: "daily", ownerId }, { userId: 4, canMonetary: true, canSync: true });
  assert.equal(twin.id, job.id); assert.equal(twin.deduplicated, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs").get().n, 1);
  const status = service.dailyRunStatus(ownerId, {}, "2026-10-21T02:05:00Z");
  assert.equal(status.status, "queued"); assert.equal(status.jobId, job.id); assert.equal(status.scheduledFor, "2026-10-21T02:00:00.000Z"); assert.equal(status.late, false);
  assert.equal(status.consecutiveFailures, 0); assert.equal(status.enabled, true); assert.equal(status.nextRunAt, "2026-10-22T02:00:00.000Z");
  assert.match(run.created_at, ISO); assert.match(run.updated_at, ISO);
  service.cancelJob(job.id, { canMonetary: true });
});

test("running the daily sync by hand downgrades revenue for a non-monetary user and records a note", () => {
  insertSchedule();
  const job = service.createSync({ kind: "daily", ownerId }, { userId: 2, canMonetary: false, canSync: true });
  assert.equal(job.kind, "daily"); assert.equal(job.monetary, false); assert.equal(job.requestedBy, "user");
  assert.match(job.notes[0], /cannot access Analytics revenue/);
  assert.equal(JSON.parse(db.prepare("SELECT request_json FROM analytic_jobs WHERE id=?").get(job.id).request_json).monetary, false);
  service.cancelJob(job.id, { canMonetary: false });
  const full = service.createSync({ kind: "daily", ownerId }, { userId: 4, canMonetary: true, canSync: true });
  assert.equal(full.monetary, true); assert.deepEqual(full.notes, []);
  service.cancelJob(full.id, { canMonetary: true });
});

test("a slot that failed while the CMS was disconnected is re-armed once as soon as the owner reconnects", () => {
  insertSchedule({ next_run_at: "2026-10-21T02:00:00.000Z" });
  network.cms_auth_status = "error";
  for (const time of ["02:00", "02:01", "02:06", "02:21", "02:51"]) assert.equal(service.tickSchedules(`2026-10-21T${time}:00Z`).failed, 1);
  assert.equal(readRuns()[0].attempts, 5); assert.equal(readSchedule().retry_at, null);
  assert.equal(JSON.parse(readRuns()[0].error_json).reason, "cmsNotConnected");
  assert.equal(service.dailyRunStatus(ownerId, {}, "2026-10-21T03:00:00Z").status, "failed");
  assert.equal(service.tickSchedules("2026-10-21T03:30:00Z").queued, 0);
  network.cms_auth_status = "connected";
  const result = service.tickSchedules("2026-10-21T04:00:00Z");
  assert.equal(result.queued, 1);
  assert.equal(readRuns()[0].status, "queued"); assert.equal(readRuns()[0].attempts, 5);
  assert.ok(readRuns()[0].job_id);
  assert.equal(service.getJob(readRuns()[0].job_id, { canMonetary: true }).kind, "daily");
  assert.equal(readSchedule().next_run_at, "2026-10-22T02:00:00.000Z");
  service.cancelJob(readRuns()[0].job_id, { canMonetary: true });
});

test("a job that failed with cmsNotConnected is re-armed after a reconnect, but only once per slot", () => {
  insertSchedule({ next_run_at: "2026-10-21T02:00:00.000Z" });
  assert.equal(service.tickSchedules("2026-10-21T02:00:00Z").queued, 1);
  const first = readRuns()[0].job_id;
  db.prepare("UPDATE analytic_jobs SET status='failed',errors_json=?,finished_at='2026-10-21T02:01:00.000Z' WHERE id=?")
    .run(JSON.stringify([{ reportId: "job", message: "invalid_grant: Token has been expired or revoked.", reason: "cmsNotConnected", status: 400 }]), first);
  network.cms_auth_status = "error";
  assert.equal(service.tickSchedules("2026-10-21T02:30:00Z").queued, 0);
  network.cms_auth_status = "connected";
  assert.equal(service.tickSchedules("2026-10-21T02:31:00Z").queued, 1);
  const second = readRuns()[0].job_id;
  assert.notEqual(second, first); assert.equal(readRuns()[0].attempts, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_meta WHERE key=?").get(`rearm:${ownerId}:2026-10-21T02:00:00.000Z`).n, 1);
  db.prepare("UPDATE analytic_jobs SET status='failed',errors_json=? WHERE id=?")
    .run(JSON.stringify([{ reportId: "job", message: "still broken", reason: "cmsNotConnected", status: 400 }]), second);
  assert.equal(service.tickSchedules("2026-10-21T02:40:00Z").queued, 0);
  assert.equal(readRuns()[0].job_id, second);
});

test("dailyRunStatus counts consecutive failed or never-run slots and the alert fires once per streak", async () => {
  insertSchedule({ next_run_at: "2026-10-19T02:00:00.000Z" });
  const failing = () => { throw new Error("Unavailable"); };
  for (const day of ["19", "20"]) for (const time of ["02:00", "02:01", "02:06", "02:21", "02:51"]) scheduler.tick(db, failing, { now: `2026-10-${day}T${time}:00Z` });
  const status = service.dailyRunStatus(ownerId, {}, "2026-10-21T03:00:00Z");
  assert.equal(status.status, "not-run"); assert.equal(status.late, true); assert.equal(status.consecutiveFailures, 3); assert.equal(status.streakStart, "2026-10-19T02:00:00.000Z");
  // within the 15-minute grace the missing slot is neither late nor counted, but the older streak is still reported
  const early = service.dailyRunStatus(ownerId, {}, "2026-10-21T02:10:00Z");
  assert.equal(early.status, "not-run"); assert.equal(early.late, false); assert.equal(early.consecutiveFailures, 2); assert.equal(early.firstError, null);
  creator = null;
  const mailPath = require.resolve("../src/services/mailService");
  const sent = [];
  let failDelivery = true;
  const original = require.cache[mailPath];
  require.cache[mailPath] = { id: mailPath, filename: mailPath, loaded: true, exports: { sendMail: async (message) => { if (failDelivery) throw new Error("SMTP down"); sent.push(message); } } };
  process.env.ANALYTICS_ALERT_EMAILS = "ops@example.com, second@example.com";
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const marker = () => db.prepare("SELECT value FROM analytic_meta WHERE key=?").get(`alert:dailyRun:${ownerId}`)?.value ?? null;
  const quiet = console.error; console.error = () => {};
  try {
    // a failed delivery stores no marker, so the next tick tries again (U9)
    service.tickSchedules("2026-10-21T02:59:00Z");
    await settle();
    assert.equal(sent.length, 0); assert.equal(marker(), null);
    failDelivery = false;
    service.tickSchedules("2026-10-21T03:00:00Z");
    service.tickSchedules("2026-10-21T03:01:00Z");
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "ops@example.com,second@example.com");
    // today's slot still has enqueue retries left, so only the two spent slots count; the streak start is unchanged
    assert.match(sent[0].subject, /failed 2 times in a row/);
    assert.match(sent[0].text, /First error: .*creator is missing/);
    assert.equal(marker(), "2026-10-19T02:00:00.000Z");
    service.tickSchedules("2026-10-21T03:02:00Z");
    await settle();
    assert.equal(sent.length, 1, "one email per streak");
    delete process.env.ANALYTICS_ALERT_EMAILS;
    service.tickSchedules("2026-10-21T03:03:00Z");
    await settle();
    assert.equal(sent.length, 1);
  } finally {
    console.error = quiet;
    delete process.env.ANALYTICS_ALERT_EMAILS;
    if (original) require.cache[mailPath] = original; else delete require.cache[mailPath];
  }
  const schedule = service.getSchedules().find((row) => row.ownerId === ownerId);
  assert.equal(schedule.lastRun.consecutiveFailures, service.dailyRunStatus(ownerId).consecutiveFailures);
  assert.equal(readRuns().length, 3); assert.equal(readRuns()[2].status, "failed");
});

test("a timetable change or the v3 migration never fabricates missed slots: the streak counts stored runs only", () => {
  insertSchedule({ next_run_at: "2026-10-19T02:00:00.000Z" });
  const failing = () => { throw new Error("Unavailable"); };
  for (const day of ["19", "20"]) for (const time of ["02:00", "02:01", "02:06", "02:21", "02:51"]) scheduler.tick(db, failing, { now: `2026-10-${day}T${time}:00Z` });
  // operator moves the time to 10:00 at 10:05 local on the 21st: the 10:00 slot of that day predates the save and is not a failure
  db.prepare("UPDATE analytic_schedules SET times_json='[\"10:00\"]',updated_at='2026-10-21T03:05:00.000Z',next_run_at='2026-10-22T03:00:00.000Z' WHERE owner_id=?").run(ownerId);
  const moved = service.dailyRunStatus(ownerId, {}, "2026-10-21T03:30:00Z");
  assert.equal(moved.status, "failed"); assert.equal(moved.scheduledFor, "2026-10-20T02:00:00.000Z"); assert.equal(moved.consecutiveFailures, 2);
  assert.equal(moved.streakStart, "2026-10-19T02:00:00.000Z"); assert.equal(moved.firstError, "Unavailable"); assert.equal(moved.nextRunAt, "2026-10-22T03:00:00.000Z");
  // the next day's slot is newer than the horizon: without a run row 15 minutes after it, it is a late not-run and counts
  const nextDay = service.dailyRunStatus(ownerId, {}, "2026-10-22T03:30:00Z");
  assert.equal(nextDay.status, "not-run"); assert.equal(nextDay.late, true); assert.equal(nextDay.scheduledFor, "2026-10-22T03:00:00.000Z"); assert.equal(nextDay.consecutiveFailures, 3);
  // the same protection applies to the v3 migration instant (legacy run rows stay visible, nothing is invented after it)
  db.prepare("UPDATE analytic_schedules SET updated_at=? WHERE owner_id=?").run(FIXTURE_HORIZON, ownerId);
  pinMigrationAt("2026-10-22T03:05:00.000Z");
  const migrated = service.dailyRunStatus(ownerId, {}, "2026-10-22T03:30:00Z");
  assert.equal(migrated.status, "failed"); assert.equal(migrated.scheduledFor, "2026-10-20T02:00:00.000Z"); assert.equal(migrated.consecutiveFailures, 2);
  // a freshly saved schedule without any run reads as not-run, not late, no streak
  db.exec("DELETE FROM analytic_schedule_runs");
  const fresh = service.dailyRunStatus(ownerId, {}, "2026-10-22T03:30:00Z");
  assert.deepEqual([fresh.status, fresh.late, fresh.consecutiveFailures, fresh.scheduledFor, fresh.jobId], ["not-run", false, 0, null, null]);
  assert.equal(service.dailyRunStatus("NOBODY", {}, "2026-10-22T03:30:00Z").enabled, false);
});

test("the daily status follows the job, is sanitised per role and does not count a slot while enqueue attempts remain", () => {
  insertSchedule({ next_run_at: "2026-10-21T02:00:00.000Z" });
  const failing = () => { throw new Error("CMS is disconnected"); };
  scheduler.tick(db, failing, { now: "2026-10-21T02:00:00Z" });
  const pending = service.dailyRunStatus(ownerId, {}, "2026-10-21T02:00:30Z");
  assert.equal(pending.status, "failed"); assert.equal(pending.consecutiveFailures, 0, "a retry is still scheduled"); assert.equal(pending.late, false); assert.equal(pending.firstError, "CMS is disconnected");
  assert.equal(service.dailyRunStatus(ownerId, {}, "2026-10-21T02:20:00Z").late, true);
  assert.equal(scheduler.tick(db, enqueue, { now: "2026-10-21T02:01:00Z" }).queued, 1);
  const jobId = readRuns()[0].job_id;
  db.prepare("UPDATE analytic_jobs SET status='running',started_at='2026-10-21T02:20:00.000Z',kind='daily' WHERE id=?").run(jobId);
  const running = service.dailyRunStatus(ownerId, {}, "2026-10-21T02:25:00Z");
  assert.equal(running.status, "running"); assert.equal(running.late, true, "started more than 15 minutes after the slot"); assert.equal(running.startedAt, "2026-10-21T02:20:00.000Z");
  db.prepare("UPDATE analytic_jobs SET status='partial',finished_at='2026-10-21T02:30:00.000Z',request_json=?,errors_json=?,result_json=? WHERE id=?").run(
    JSON.stringify({ kind: "daily", ownerId, monetary: true, canMonetary: true, requestedBy: "schedule" }),
    JSON.stringify([{ reportId: "ownerFacts:money", monetary: true, message: "estimatedRevenue report failed", reason: "internalError", status: 500 },
      { reportId: "breakdown:country", monetary: false, message: "country failed", reason: "internalError", status: 500 }]),
    JSON.stringify({ counts: { inserted: 7 }, days: { addedCount: 7, added: ["2026-10-18"], driftedCount: 2, drifted: [] }, steps: [] }), jobId);
  const manager = service.dailyRunStatus(ownerId, { canMonetary: true }, "2026-10-21T03:00:00Z");
  assert.equal(manager.status, "partial"); assert.equal(manager.firstError, "estimatedRevenue report failed"); assert.deepEqual(manager.days, { addedCount: 7, driftedCount: 2 });
  assert.deepEqual(manager.counts, { inserted: 7 }); assert.equal(manager.finishedAt, "2026-10-21T02:30:00.000Z"); assert.equal(manager.consecutiveFailures, 0);
  const contentId = service.dailyRunStatus(ownerId, { canMonetary: false }, "2026-10-21T03:00:00Z");
  assert.equal(contentId.firstError, "country failed"); assert.equal(JSON.stringify(contentId).includes("estimatedRevenue"), false);
  // GET /schedules reads the same status with the real clock: move the run onto the current slot and check the per-role sanitising there too
  db.prepare("UPDATE analytic_schedule_runs SET scheduled_for=? WHERE owner_id=?").run(scheduler.latestSlot(new Date()), ownerId);
  assert.equal(service.getSchedules({ canMonetary: false })[0].lastRun.firstError, "country failed");
  assert.equal(service.getSchedules({ canMonetary: true })[0].lastRun.firstError, "estimatedRevenue report failed");
  assert.equal(service.getSchedules()[0].lastRun.firstError, "country failed", "no access means no revenue details");
});

test("restart recovery re-points the daily slot at the continuation job so the morning status follows it", () => {
  insertSchedule({ next_run_at: "2026-10-21T02:00:00.000Z" });
  assert.equal(service.tickSchedules("2026-10-21T02:00:00Z").queued, 1);
  const first = readRuns()[0].job_id;
  db.prepare("UPDATE analytic_jobs SET status='running',started_at=? WHERE id=?").run("2026-10-21T02:00:05.000Z", first);
  assert.deepEqual(service.recoverInterruptedJobs("2026-10-21T02:03:00Z"), { interrupted: 1, requeued: 1 });
  const replacement = readRuns()[0].job_id;
  assert.notEqual(replacement, first);
  assert.equal(service.getJob(replacement, { canMonetary: true }).requestedBy, "recovery");
  const status = service.dailyRunStatus(ownerId, { canMonetary: true }, "2026-10-21T02:04:00Z");
  assert.equal(status.jobId, replacement); assert.equal(status.status, "queued"); assert.equal(status.consecutiveFailures, 0);
  service.cancelJob(replacement, { canMonetary: true });
});

test("re-saving the schedule keeps the pending retry of today's slot and re-arms a slot that failed on the creator check", () => {
  const now = new Date();
  const slot = scheduler.latestSlot(now);
  const access = { userId: 4, canMonetary: true, canSync: true };
  service.saveSchedule({ ownerId, enabled: true, monetary: true }, access);
  db.prepare("UPDATE analytic_schedules SET next_run_at=? WHERE owner_id=?").run(slot, ownerId);
  creator = { id: 4, role: "Report Manager", status: "disabled" };
  assert.equal(service.tickSchedules(now).failed, 1);
  assert.equal(JSON.parse(readRuns()[0].error_json).reason, "schedulePermissionDenied");
  const retryAt = readSchedule().retry_at;
  assert.ok(retryAt);
  // still broken: the save keeps the retry ladder but cannot re-arm (the creator is inactive)
  const kept = service.saveSchedule({ ownerId, enabled: true, lookbackDays: 9 }, access);
  assert.equal(kept.retryAt, retryAt); assert.equal(kept.lookbackDays, 9);
  // the creator is active again: the save re-arms today's slot immediately and the next tick queues it
  creator = { id: 4, role: "Report Manager", status: "active" };
  const fixed = service.saveSchedule({ ownerId, enabled: true }, access);
  assert.ok(Date.parse(fixed.retryAt) <= Date.now()); assert.equal(fixed.lastScheduledFor, slot);
  assert.equal(service.tickSchedules(new Date(Date.now() + 1000)).queued, 1);
  assert.equal(readRuns()[0].status, "queued");
  service.cancelJob(readRuns()[0].job_id, { canMonetary: true });
  // a new timetable starts clean
  db.prepare("UPDATE analytic_schedules SET retry_at=? WHERE owner_id=?").run(new Date(Date.now() + 60000).toISOString(), ownerId);
  assert.equal(service.saveSchedule({ ownerId, enabled: true, times: ["11:00", "23:00"] }, access).retryAt, null);
});

test("worker handles a missed slot immediately at startup", () => {
  insertSchedule({ next_run_at: "2026-01-01T02:00:00.000Z", created_by: null });
  service.startWorker();
  assert.equal(readRuns().length, 1);
  assert.equal(readRuns()[0].status, "failed");
  assert.match(readSchedule().last_error, /creator is missing/);
  assert.match(readSchedule().next_run_at, /T02:00:00\.000Z$/);
  service.stopWorker();
});

test("migration upgrades legacy daily schedules to v3 once and preserves missed slots on subsequent starts", () => {
  const legacyPath = path.join(directory, "legacy.sqlite");
  const legacy = new (require("better-sqlite3"))(legacyPath);
  legacy.exec(`CREATE TABLE analytic_schedules(owner_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,lookback_days INTEGER NOT NULL DEFAULT 7,
    scope TEXT NOT NULL DEFAULT 'claimed',monetary INTEGER NOT NULL DEFAULT 0,created_by INTEGER,next_run_at TEXT,last_run_at TEXT,last_job_id TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO analytic_schedules(owner_id,enabled,next_run_at) VALUES('enabled',1,'2026-01-01T19:43:12Z'),('disabled',0,'2026-01-01T19:43:12Z');`);
  legacy.close();
  const script = "const db=require('./src/config/analyticsDatabase');process.stdout.write(JSON.stringify(db.prepare('SELECT * FROM analytic_schedules ORDER BY owner_id').all()));db.close()";
  const first = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { ...process.env, ANALYTICS_DB_PATH: legacyPath } });
  assert.equal(first.status, 0, first.stderr);
  const [disabled, enabled] = JSON.parse(first.stdout);
  assert.equal(disabled.next_run_at, null);
  assert.equal(enabled.schedule_version, 3);
  assert.equal(enabled.times_json, '["09:00"]'); assert.equal(enabled.scopes_json, '["claimed"]'); assert.equal(enabled.lookback_days, 7); assert.equal(enabled.lag_days, 3);
  assert.match(enabled.next_run_at, /T02:00:00\.000Z$/);
  const reconnect = new (require("better-sqlite3"))(legacyPath);
  reconnect.prepare("UPDATE analytic_schedules SET next_run_at=? WHERE owner_id='enabled'").run("2026-01-01T02:00:00.000Z"); reconnect.close();
  const second = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { ...process.env, ANALYTICS_DB_PATH: legacyPath } });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout)[1].next_run_at, "2026-01-01T02:00:00.000Z");
});

test("v3 migration converts a v2 fixture: legacy default times become 09:00, custom times and the lookback stay, scope becomes scopes", () => {
  const v2Path = path.join(directory, "v2.sqlite");
  const v2 = new (require("better-sqlite3"))(v2Path);
  v2.exec(`CREATE TABLE analytic_schedules(owner_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,lookback_days INTEGER NOT NULL DEFAULT 7,scope TEXT NOT NULL DEFAULT 'claimed',
    monetary INTEGER NOT NULL DEFAULT 0,created_by INTEGER,next_run_at TEXT,last_run_at TEXT,last_job_id TEXT,times_json TEXT NOT NULL DEFAULT '["08:00","14:00"]',
    timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok',last_scheduled_for TEXT,last_error TEXT,last_error_at TEXT,retry_at TEXT,schedule_version INTEGER NOT NULL DEFAULT 2,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO analytic_schedules(owner_id,enabled,lookback_days,scope,monetary,next_run_at,times_json) VALUES
      ('legacy',1,28,'self',1,'2026-10-21T01:00:00.000Z','["08:00","14:00"]'),
      ('custom',1,10,'thirdParty',0,'2026-10-21T05:00:00.000Z','["12:00"]'),
      ('off',0,7,'claimed',0,NULL,'["08:00","14:00"]');`);
  v2.close();
  const script = "const db=require('./src/config/analyticsDatabase');process.stdout.write(JSON.stringify({rows:db.prepare('SELECT * FROM analytic_schedules ORDER BY owner_id').all(),meta:db.prepare(\"SELECT * FROM analytic_meta WHERE key='migration:schedule-v3'\").get()}));db.close()";
  const first = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { ...process.env, ANALYTICS_DB_PATH: v2Path } });
  assert.equal(first.status, 0, first.stderr);
  const { rows, meta } = JSON.parse(first.stdout);
  const byOwner = Object.fromEntries(rows.map((row) => [row.owner_id, row]));
  assert.equal(byOwner.legacy.times_json, '["09:00"]'); assert.equal(byOwner.legacy.scopes_json, '["self"]'); assert.equal(byOwner.legacy.lookback_days, 28);
  assert.equal(byOwner.legacy.scope, "self"); assert.equal(byOwner.legacy.schedule_version, 3); assert.match(byOwner.legacy.next_run_at, /T02:00:00\.000Z$/);
  assert.equal(byOwner.custom.times_json, '["12:00"]'); assert.equal(byOwner.custom.scopes_json, '["thirdParty"]'); assert.equal(byOwner.custom.lookback_days, 10);
  assert.match(byOwner.custom.next_run_at, /T05:00:00\.000Z$/);
  assert.equal(byOwner.off.times_json, '["09:00"]'); assert.equal(byOwner.off.next_run_at, null); assert.equal(byOwner.off.schedule_version, 3);
  for (const row of rows) { assert.equal(row.lag_days, 3); assert.equal(row.channel_mode, "all"); assert.equal(row.channel_ids_json, "[]"); assert.equal(row.include_breakdowns, 1); assert.equal(row.settle_days, 7); }
  assert.equal(JSON.parse(meta.value).migrated, 3);
  const edit = new (require("better-sqlite3"))(v2Path);
  edit.prepare("UPDATE analytic_schedules SET next_run_at='2026-01-01T02:00:00.000Z',times_json='[\"08:00\",\"14:00\"]' WHERE owner_id='legacy'").run(); edit.close();
  const second = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { ...process.env, ANALYTICS_DB_PATH: v2Path } });
  assert.equal(second.status, 0, second.stderr);
  const again = JSON.parse(second.stdout).rows.find((row) => row.owner_id === "legacy");
  assert.equal(again.next_run_at, "2026-01-01T02:00:00.000Z"); assert.equal(again.times_json, '["08:00","14:00"]');
});
