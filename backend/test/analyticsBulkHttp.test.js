const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "bulk-auth-test-only";
const users = {
  1: { id: 1, role: "admin", status: "active" },
  2: { id: 2, role: "Content ID", status: "active" },
  3: { id: 3, role: "Report Manager", status: "active" },
  4: { id: 4, role: JSON.stringify(["Report Manager", "Read Only"]), status: "active" },
  5: { id: 5, role: "Partner", status: "active" },
  6: { id: 6, role: "super admin", status: "active" }
};
let writes = 0;
const fakeService = {
  catalog: async ownerId => ({ ownerId, reportTypes: [{ id: "financial-system-report" }], jobs: [] }),
  startSync: () => { writes += 1; return { id: "fixture-run", status: "queued" }; },
  startCreateJobs: () => { writes += 1; return { id: "fixture-jobs", status: "queued" }; },
  getRun: () => ({ id: "fixture-run", status: "running" }),
  listRuns: () => [],
  cancelRun: () => { writes += 1; return { id: "fixture-run", status: "cancelled" }; }
};
const realLoad = Module._load;
Module._load = function loadBulkFixtures(request, parent, isMain) {
  if (request === "../config/database") return { prepare: () => ({ get: id => users[id] }) };
  if (request === "../services/analyticsBulkService") return {
    getService: () => fakeService,
    publicError: error => ({ status: error.status || 500, message: error.message })
  };
  return realLoad(request, parent, isMain);
};
const routes = require("../src/routes/analyticsBulkRoutes");
Module._load = realLoad;
let server, port;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/analytics/bulk", routes);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function request(userId, path, method = "GET") {
  const headers = {};
  if (userId) headers.Authorization = `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET)}`;
  const response = await fetch(`http://127.0.0.1:${port}/api/analytics/bulk${path}`, {
    method, headers: { ...headers, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify({ ownerId: "OWNER_TEST", all: true }) } : {})
  });
  return { status: response.status, body: await response.json() };
}

test("financial bulk catalog requires authentication and existing monetary roles", async () => {
  assert.equal((await request(null, "/catalog?ownerId=OWNER_TEST")).status, 401);
  assert.equal((await request(2, "/catalog?ownerId=OWNER_TEST")).status, 403);
  assert.equal((await request(5, "/catalog?ownerId=OWNER_TEST")).status, 403);
  for (const userId of [1, 3, 4, 6]) {
    const response = await request(userId, "/catalog?ownerId=OWNER_TEST");
    assert.equal(response.status, 200);
    assert.equal(response.body.data.ownerId, "OWNER_TEST");
  }
});

test("Read Only plus Report Manager can read progress but cannot start, create or cancel", async () => {
  const initialWrites = writes;
  assert.equal((await request(4, "/runs/fixture-run")).status, 200);
  for (const path of ["/sync", "/jobs", "/runs/fixture-run/cancel"]) {
    assert.equal((await request(4, path, "POST")).status, 403);
  }
  assert.equal(writes, initialWrites);
});

test("Report Manager can queue sync and job creation through HTTP with 202 responses", async () => {
  const initialWrites = writes;
  assert.equal((await request(3, "/sync", "POST")).status, 202);
  assert.equal((await request(3, "/jobs", "POST")).status, 202);
  assert.equal(writes, initialWrites + 2);
});
