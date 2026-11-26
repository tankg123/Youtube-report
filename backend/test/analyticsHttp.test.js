const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "analytics-auth-test-only";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-http-"));
process.env.ANALYTICS_DB_PATH = path.join(tempDir, "analytics.sqlite");
const users = {
  1: { id: 1, role: "admin", status: "active" },
  2: { id: 2, role: "Content ID", status: "active" },
  3: { id: 3, role: "Report Manager", status: "active" },
  4: { id: 4, role: JSON.stringify(["Report Manager", "Read Only"]), status: "active" },
  5: { id: 5, role: "Partner", status: "active" },
  6: { id: 6, role: "Read Only", status: "active" },
  7: { id: 7, role: "super admin", status: "active" }
};
const SECRETS = ["secret-never-returned", "ya29.secret-access", "cms_refresh_token", "cms_access_token", "Bearer "];
const network = { id: 99, name: "Fixture Owner", network_code: "OWNER_FIXTURE", cms_auth_status: "connected", cms_refresh_token: "secret-never-returned",
  cms_access_token: "ya29.secret-access-never-returned", cms_auth_scopes: "https://www.googleapis.com/auth/yt-analytics.readonly" };
const fixtureDb = { prepare: sql => ({ get: id => /FROM users/.test(sql) ? users[id] : network, all: () => [network] }) };
const credentialPath = require.resolve("../src/config/database");
require.cache[credentialPath] = { id: credentialPath, filename: credentialPath, loaded: true, exports: fixtureDb };
const service = require("../src/services/analyticsService");
const db = require("../src/config/analyticsDatabase");
const w = require("../src/services/analyticsWarehouse");
const routes = require("../src/routes/analyticsRoutes");
const scheduler = require("../src/services/analyticsScheduleService");
const OWNER = "OWNER_FIXTURE";
const selection = service.normalizeSelection({ ownerId: OWNER, startDate: "2025-05-01", endDate: "2025-05-28" });
const fixtureTable = { columnHeaders: [{ name: "views", columnType: "METRIC", dataType: "INTEGER" }], rows: [{ views: 77 }], coverage: { rowCount: 1 } };
service.persistReport(selection, { id: "custom:" + "a".repeat(20), monetary: false }, { metrics: "views" }, fixtureTable);
service.persistReport(selection, { id: "custom:" + "b".repeat(20), monetary: true }, { metrics: "estimatedRevenue" }, fixtureTable);
// Warehouse facts with a revenue overwrite so /overview, /coverage and /history carry monetary data and a ledger row.
w.writeFacts(db, { ownerId: OWNER, entityKey: "owner:claimed", rows: [{ day: "2025-05-01", metrics: { views: 10, estimatedRevenue: 1.5 } }], mode: "append", source: "daily", jobId: "fixture-job", monetary: true, now: "2025-05-05T00:00:00.000Z" });
w.markCoverage(db, { ownerId: OWNER, entityKey: "owner:claimed", days: ["2025-05-01"], monetary: true, jobId: "fixture-job", now: "2025-05-05T00:00:00.000Z" });
w.writeFacts(db, { ownerId: OWNER, entityKey: "owner:claimed", rows: [{ day: "2025-05-01", metrics: { views: 12, estimatedRevenue: 2.5 } }], mode: "overwrite", source: "full", jobId: "fixture-job", monetary: true, now: "2025-05-06T00:00:00.000Z" });
let server, port;
test.before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/analytics", routes);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  service.stopWorker(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true });
});
async function request(userId, routePath, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/analytics${routePath}`, {
    method, headers: { ...(userId ? { Authorization: `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET)}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const params = `ownerId=${OWNER}&startDate=2025-05-01&endDate=2025-05-28`;
const payload = { ownerId: OWNER, startDate: "2025-05-01", endDate: "2025-05-28" };
const monetaryKeys = (body) => [...w.MONETARY_KEYS].filter((key) => JSON.stringify(body).includes(`"${key}"`));

test("Analytics requires authentication and an existing Report Manager or Content ID business role", async () => {
  assert.equal((await request(null, "/bootstrap")).status, 401);
  assert.equal((await request(5, "/bootstrap")).status, 403);
  assert.equal((await request(6, "/bootstrap")).status, 403);
  for (const userId of [1, 2, 3, 4, 7]) assert.equal((await request(userId, "/bootstrap")).status, 200);
});

test("super admin is a full revenue role: every permission, revenue numbers and the overwrite right", async () => {
  assert.deepEqual((await request(7, "/bootstrap")).body.permissions, { canMonetary: true, canSync: true, canOverwrite: true, canManageSchedules: true });
  const overview = await request(7, `/overview?${params}`);
  assert.equal(overview.status, 200); assert.equal(overview.body.summary.current.estimatedRevenue, 2.5);
  const workbook = await fetch(`http://127.0.0.1:${port}/api/analytics/export?${params}&type=revenue&format=xlsx`, { headers: { Authorization: `Bearer ${jwt.sign({ id: 7 }, process.env.JWT_SECRET)}` } });
  assert.deepEqual([workbook.status, workbook.headers.get("content-disposition")], [200, 'attachment; filename="analytics-revenue-OWNER_FIXTURE-2025-05-01-2025-05-28.xlsx"']);
  await workbook.arrayBuffer();
  const history = await request(7, "/history?ownerId=OWNER_FIXTURE");
  assert.deepEqual(history.body.entries.map((entry) => entry.changedKeys[0].key), ["estimatedRevenue"]);
});

test("Content ID can read regular Analytics but cannot view monetary snapshots, facts or run monetary queries/syncs", async () => {
  const snapshots = await request(2, `/snapshots?${params}`);
  assert.equal(snapshots.status, 200);
  assert.equal(snapshots.body.reports.overview.status, "missing");
  assert.equal(snapshots.body.reports.monetaryOverview, undefined);
  const overview = await request(2, `/overview?${params}`);
  assert.equal(overview.status, 200); assert.equal(overview.body.summary.current.views, 12);
  assert.deepEqual(monetaryKeys(overview.body), []);
  assert.equal(JSON.stringify(overview.body).includes("2.5"), false);
  const manager = await request(3, `/overview?${params}`);
  assert.equal(manager.body.summary.current.estimatedRevenue, 2.5);
  assert.equal((await request(2, `/export?${params}&reportId=monetaryDaily`)).status, 403);
  assert.equal((await request(2, `/export?${params}&reportId=custom:${"b".repeat(20)}`)).status, 403);
  assert.equal((await request(2, `/export?${params}&type=revenue&format=xlsx`)).status, 403);
  assert.equal((await request(2, "/query", "POST", { ...payload, metrics: "views,estimatedRevenue" })).status, 403);
  assert.equal((await request(2, "/query", "POST", { ...payload, reportId: "monetaryOverview" })).status, 403);
  assert.equal((await request(2, "/sync", "POST", { ...payload, reportIds: ["monetaryOverview"] })).status, 403);
});

test("Read Only modifies Report Manager to allow GET but rejects all business writes", async () => {
  assert.equal((await request(4, `/overview?${params}`)).status, 200);
  assert.equal((await request(4, "/queries?ownerId=OWNER_FIXTURE")).body.queries.length, 2);
  assert.deepEqual((await request(4, "/bootstrap")).body.permissions, { canMonetary: true, canSync: false, canOverwrite: false, canManageSchedules: false });
  for (const [routePath, method] of [["/sync", "POST"], ["/query", "POST"], ["/jobs/example/cancel", "POST"], ["/schedules", "PUT"]]) {
    const response = await request(4, routePath, method, { ownerId: OWNER });
    assert.equal(response.status, 403); assert.equal(response.body.success, false);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_jobs").get().n, 0);
});

test("query history filters monetary records and never returns CMS credentials", async () => {
  const cid = await request(2, "/queries?ownerId=OWNER_FIXTURE");
  assert.equal(cid.status, 200); assert.equal(cid.body.queries.length, 1);
  assert.equal(cid.body.queries[0].rows[0].views, 77);
  const manager = await request(3, "/queries?ownerId=OWNER_FIXTURE");
  assert.equal(manager.body.queries.length, 2);
  assert.equal(JSON.stringify(manager.body).includes("secret-never-returned"), false);
  assert.equal(JSON.stringify(manager.body).includes("cms_refresh_token"), false);
});

test("disconnected OAuth still permits stored overview, coverage, ledger, query history and schedule reads through HTTP", async () => {
  network.cms_auth_status = "error";
  try {
    for (const routePath of [`/overview?${params}`, `/coverage?${params}`, "/history?ownerId=OWNER_FIXTURE", "/queries?ownerId=OWNER_FIXTURE", "/schedules", "/bootstrap"]) {
      assert.equal((await request(3, routePath)).status, 200, routePath);
    }
    assert.equal((await request(3, "/bootstrap")).body.owners[0].authStatus, "error");
    assert.equal((await request(3, "/sync", "POST", { ...payload, reportIds: ["overview"] })).status, 409);
    assert.equal((await request(3, "/query", "POST", { ...payload, metrics: "views" })).status, 409);
  } finally { network.cms_auth_status = "connected"; }
});

test("Content ID cannot cancel a monetary legacy sync but can cancel a regular one", async () => {
  const insert = db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total) VALUES(?,?,?,'queued',1)");
  insert.run("financial-job", network.network_code, JSON.stringify({ selection, reportIds: ["monetaryOverview"] }));
  insert.run("regular-job", network.network_code, JSON.stringify({ selection, reportIds: ["overview"] }));
  assert.equal((await request(2, "/jobs/financial-job/cancel", "POST", {})).status, 403);
  assert.equal(service.getJob("financial-job").status, "queued");
  assert.equal((await request(2, "/jobs/regular-job/cancel", "POST", {})).status, 200);
  assert.equal(service.getJob("regular-job").status, "cancelled");
  assert.equal((await request(3, "/jobs/financial-job/cancel", "POST", {})).status, 200);
  assert.equal(service.getJob("financial-job").status, "cancelled");
});

test("no response and no byte of the analytics database carries a CMS credential; every answer is uncacheable", async () => {
  assert.equal((await request(1, "/schedules", "PUT", { ownerId: OWNER, enabled: true, lookbackDays: 7, times: ["09:00"] })).status, 200);
  for (const routePath of [`/overview?${params}`, `/coverage?${params}`, "/history?ownerId=OWNER_FIXTURE", "/jobs/financial-job", "/schedules", "/bootstrap", `/snapshots?${params}`, `/channels?${params}`, `/facts?${params}`, `/channels/inventory?ownerId=${OWNER}`]) {
    const response = await request(1, routePath);
    assert.equal(response.status, 200, routePath);
    assert.equal(response.headers.get("cache-control"), "no-store", routePath);
    const text = JSON.stringify(response.body);
    for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${routePath} leaks ${secret}`);
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  const bytes = [process.env.ANALYTICS_DB_PATH, `${process.env.ANALYTICS_DB_PATH}-wal`].filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, "latin1")).join("");
  assert.ok(bytes.includes("OWNER_FIXTURE"));
  for (const secret of ["secret-never-returned", "ya29.secret-access"]) assert.equal(bytes.includes(secret), false, `database stores ${secret}`);
});

// Depends on Backend-B1's analyticsService rewrite: listJobs(ownerId, access, limit) and jobIsMonetary() for v2 request shapes.
test("v2 jobs: Content ID cannot cancel a monetary sync but can cancel a non-monetary one, and the job list is sanitised", async () => {
  const insert = db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,kind,mode) VALUES(?,?,?,'queued',1,?,?)");
  insert.run("v2-money", OWNER, JSON.stringify({ kind: "full", mode: "append", ownerId: OWNER, startDate: "2025-05-01", endDate: "2025-05-28", scopes: ["claimed"], channelMode: "none", channelIds: [],
    includeBreakdowns: true, includeSnapshots: true, monetary: true, canMonetary: true, requestedBy: "user" }), "full", "append");
  insert.run("v2-plain", OWNER, JSON.stringify({ kind: "daily", ownerId: OWNER, monetary: false, canMonetary: false, requestedBy: "schedule" }), "daily", "append");
  assert.equal((await request(2, "/jobs/v2-money/cancel", "POST", {})).status, 403);
  assert.equal(db.prepare("SELECT status FROM analytic_jobs WHERE id='v2-money'").get().status, "queued");
  assert.equal((await request(2, "/jobs/v2-plain/cancel", "POST", {})).status, 200);
  assert.equal(db.prepare("SELECT status FROM analytic_jobs WHERE id='v2-plain'").get().status, "cancelled");
  assert.equal((await request(3, "/jobs/v2-money/cancel", "POST", {})).status, 200);
  const jobs = await request(2, `/jobs?ownerId=${OWNER}`);
  assert.equal(jobs.status, 200); assert.ok(jobs.body.jobs.some((job) => job.id === "v2-money"));
  for (const secret of SECRETS) assert.equal(JSON.stringify(jobs.body).includes(secret), false, secret);
  assert.equal((await request(3, `/jobs?ownerId=${OWNER}&limit=1`)).body.jobs.length, 1);
});

// The schedule row exists from the PUT above; the latest 09:00 slot gets a run whose job failed on a monetary step.
test("GET /schedules sanitises lastRun per role: a monetary step's error is hidden from Content ID and shown to revenue roles", async () => {
  const slot = scheduler.latestSlot(new Date(), ["09:00"]);
  db.prepare("INSERT INTO analytic_jobs(id,owner_id,request_json,status,total,completed,kind,mode,errors_json,result_json,started_at,finished_at) VALUES(?,?,?,'failed',4,1,'daily','append',?,?,?,?)")
    .run("sched-money-fail", OWNER, JSON.stringify({ kind: "daily", ownerId: OWNER, monetary: true, canMonetary: true, requestedBy: "schedule" }),
      JSON.stringify([{ message: "Revenue report failed: estimatedRevenue is not available.", reportId: "monetaryOverview", monetary: true, status: 403 }]),
      JSON.stringify({ steps: [{ id: "owner:claimed|money", label: "Revenue", monetary: true, status: "failed" }], counts: { inserted: 0, updated: 0, drift: 0 } }), slot, slot);
  db.prepare("INSERT INTO analytic_schedule_runs(owner_id,scheduled_for,status,attempts,job_id) VALUES(?,?,'queued',1,'sched-money-fail')").run(OWNER, slot);
  const admin = await request(1, "/schedules");
  const schedule = admin.body.schedules.find((entry) => entry.ownerId === OWNER);
  assert.deepEqual([admin.status, schedule.lastRun.jobId, schedule.lastRun.status, schedule.lastRun.scheduledFor], [200, "sched-money-fail", "failed", slot]);
  assert.match(schedule.lastRun.firstError, /Revenue report failed/);
  const limited = await request(2, "/schedules");
  const hidden = limited.body.schedules.find((entry) => entry.ownerId === OWNER);
  assert.deepEqual([limited.status, hidden.lastRun.jobId, hidden.lastRun.status, hidden.lastRun.firstError], [200, "sched-money-fail", "failed", null]);
  assert.equal(JSON.stringify(limited.body).includes("Revenue report failed"), false);
  // The same story on the overview and bootstrap: one implementation, sanitised the same way.
  const overview = await request(2, `/overview?${params}`);
  assert.deepEqual([overview.body.dailyRun.jobId, overview.body.dailyRun.status, overview.body.dailyRun.firstError], ["sched-money-fail", "failed", null]);
  assert.match((await request(1, "/bootstrap")).body.owners[0].dailyRun.firstError, /Revenue report failed/);
});
