const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { after, beforeEach, test } = require("node:test");
const Database = require("better-sqlite3");

const db = new Database(":memory:");
const schema = fs.readFileSync(path.join(__dirname, "../src/config/database.js"), "utf8");
db.exec(schema.match(/CREATE TABLE IF NOT EXISTS networks \([\s\S]*?\n\s*\);/)[0]);

let refresh;
const originalLoad = Module._load;
Module._load = function loadWithCredentialFakes(request, parent, isMain) {
  if (request === "../config/database") return db;
  if (request === "./googleCmsAuthService") return { refreshAccessToken: (token) => refresh(token) };
  return originalLoad(request, parent, isMain);
};
const { getAccessToken, withCmsAccessToken } = require("../src/services/googleContentIdService");
// Separate module state represents a second worker using the same SQLite database.
delete require.cache[require.resolve("../src/services/googleContentIdService")];
const secondWorker = require("../src/services/googleContentIdService");
Module._load = originalLoad;

const networkId = 7;
const expiredAt = new Date(0).toISOString();
const freshExpiry = () => new Date(Date.now() + 3_600_000).toISOString();
const readNetwork = () => db.prepare("SELECT * FROM networks WHERE id = ?").get(networkId);

beforeEach(() => {
  db.prepare("DELETE FROM networks").run();
  db.prepare(`
    INSERT INTO networks (
      id, name, network_code, cms_auth_status, cms_auth_generation, cms_access_token, cms_refresh_token, cms_token_expiry
    ) VALUES (?, 'Test CMS', 'OWNER_TEST', 'connected', 'original-grant', 'old-access', 'old-refresh', ?)
  `).run(networkId, expiredAt);
  refresh = () => assert.fail("Unexpected call to the Google token endpoint");
});
after(() => db.close());

function googleError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("concurrent callers share one refresh and persist a rotated refresh token", async () => {
  const pending = deferred();
  const tokens = [];
  refresh = (token) => {
    tokens.push(token);
    return pending.promise;
  };

  const snapshot = readNetwork();
  const requests = [getAccessToken(snapshot), getAccessToken(snapshot), getAccessToken(snapshot)];
  assert.deepEqual(tokens, ["old-refresh"]);
  pending.resolve({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });

  assert.deepEqual(await Promise.all(requests), ["new-access", "new-access", "new-access"]);
  const saved = readNetwork();
  assert.equal(saved.cms_access_token, "new-access");
  assert.equal(saved.cms_refresh_token, "new-refresh");
  assert.ok(Date.parse(saved.cms_token_expiry) > Date.now());
  assert.equal(await getAccessToken(snapshot), "new-access");
  assert.deepEqual(tokens, ["old-refresh"]);
});

test("a refresh without a replacement refresh token keeps the stored token", async () => {
  refresh = async () => ({ access_token: "new-access", expires_in: 3600 });

  assert.equal(await getAccessToken(readNetwork()), "new-access");
  assert.equal(readNetwork().cms_refresh_token, "old-refresh");
});

test("independent workers share the database lease and the successful client binding", async () => {
  const pending = deferred();
  let attempts = 0;
  refresh = () => { attempts++; return pending.promise; };
  const original = readNetwork();
  const a = getAccessToken(original);
  const b = secondWorker.getAccessToken(original);
  assert.equal(attempts, 1);
  pending.resolve({ access_token: "rotated", refresh_token: "new-grant", oauth_client_id: "issuing-client" });
  assert.deepEqual(await Promise.all([a, b]), ["rotated", "rotated"]);
  assert.equal(attempts, 1);
  assert.equal(readNetwork().cms_oauth_client_id, "issuing-client");
  assert.equal(readNetwork().cms_refresh_lock_id, null);
});

test("an explicit recovery can renew a saved failed grant after a lease expires, but cannot reconnect a disconnected CMS", async () => {
  db.prepare("UPDATE networks SET cms_auth_status = 'error', cms_refresh_lock_id = 'crashed', cms_refresh_lock_until = 1").run();
  refresh = async () => ({ access_token: "working", expires_in: 3600 });
  await assert.rejects(getAccessToken(readNetwork()), /not connected/);
  assert.equal(await getAccessToken(readNetwork(), { retrySavedGrant: true }), "working");
  assert.equal(readNetwork().cms_auth_status, "connected");
  assert.equal(readNetwork().cms_refresh_token, "old-refresh");
  db.prepare("UPDATE networks SET cms_auth_status = 'not_connected'").run();
  await assert.rejects(getAccessToken(readNetwork(), { retrySavedGrant: true }), /not connected/);
});

test("a successful refresh started before disconnect cannot restore credentials", async () => {
  const pending = deferred();
  refresh = () => pending.promise;
  const request = getAccessToken(readNetwork());
  db.prepare(`
    UPDATE networks SET cms_auth_status = 'not_connected', cms_auth_generation = 'disconnected',
      cms_access_token = NULL, cms_refresh_token = NULL, cms_token_expiry = NULL WHERE id = ?
  `).run(networkId);

  pending.resolve({ access_token: "stale-access", refresh_token: "stale-refresh", expires_in: 3600 });
  await assert.rejects(request, /CMS auth is not connected/);
  const saved = readNetwork();
  assert.equal(saved.cms_auth_status, "not_connected");
  assert.equal(saved.cms_access_token, null);
  assert.equal(saved.cms_refresh_token, null);
});

test("invalid_grant from a refresh started before reconnect does not invalidate the new grant", async () => {
  const pending = deferred();
  refresh = () => pending.promise;
  const request = getAccessToken(readNetwork());
  db.prepare(`
    UPDATE networks SET cms_auth_generation = 'new-grant', cms_access_token = 'new-access',
      cms_refresh_token = 'new-refresh', cms_token_expiry = ? WHERE id = ?
  `).run(freshExpiry(), networkId);

  pending.reject(googleError(400, { error: "invalid_grant", error_description: "Token revoked" }));
  assert.equal(await request, "new-access");
  const saved = readNetwork();
  assert.equal(saved.cms_auth_status, "connected");
  assert.equal(saved.cms_auth_error, null);
  assert.equal(saved.cms_refresh_token, "new-refresh");
});

test("only a confirmed token rejection marks the network as needing OAuth again", async () => {
  for (const status of [400, 401]) {
    refresh = async () => { throw googleError(status, "<html>Gateway response</html>"); };
    await assert.rejects(getAccessToken(readNetwork()), { tokenRefreshTransient: true });
    assert.equal(readNetwork().cms_auth_status, "connected");
    assert.equal(readNetwork().cms_auth_error, null);
  }

  refresh = async () => {
    throw googleError(400, { error: "invalid_grant", error_description: "Token revoked" });
  };
  await assert.rejects(getAccessToken(readNetwork()), { cmsAuthFailed: true, reason: "invalid_grant" });
  assert.equal(readNetwork().cms_auth_status, "error");
  assert.match(readNetwork().cms_auth_error, /^invalid_grant:/);
});

test("a rejected access token is refreshed once and callers reuse any newer token", async () => {
  db.prepare("UPDATE networks SET cms_token_expiry = ? WHERE id = ?").run(freshExpiry(), networkId);
  const original = readNetwork();
  let refreshCalls = 0;
  refresh = async () => {
    refreshCalls += 1;
    return { access_token: "replacement", expires_in: 3600 };
  };

  assert.equal(await getAccessToken(original), "old-access");
  assert.equal(await getAccessToken(original, { rejectedAccessToken: "old-access" }), "replacement");
  assert.equal(await getAccessToken(original, { rejectedAccessToken: "old-access" }), "replacement");
  assert.equal(refreshCalls, 1);
});

test("an API still returning 401 after refresh leaves the OAuth grant connected", async () => {
  db.prepare("UPDATE networks SET cms_token_expiry = ? WHERE id = ?").run(freshExpiry(), networkId);
  refresh = async () => ({ access_token: "new-access", expires_in: 3600 });
  const attempted = [];

  await assert.rejects(withCmsAccessToken(readNetwork(), async (token) => {
    attempted.push(token);
    throw googleError(401, { error: { message: "Invalid Credentials" } });
  }), /Request failed with status code 401/);

  assert.deepEqual(attempted, ["old-access", "new-access"]);
  assert.equal(readNetwork().cms_auth_status, "connected");
  assert.equal(readNetwork().cms_auth_error, null);
});
