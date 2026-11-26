const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const axios = require("axios");
const Database = require("better-sqlite3");

process.env.GOOGLE_CLIENT_ID = "fixture-client";
process.env.GOOGLE_CLIENT_SECRET = "fixture-client-secret";
process.env.JWT_SECRET = "fixture-state-secret";

const databasePath = require.resolve("../src/config/database");
const schema = fs.readFileSync(databasePath, "utf8").match(/CREATE TABLE IF NOT EXISTS networks \([\s\S]*?\n\s*\);/)[0];
const db = new Database(":memory:");
db.exec(schema);
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: db };
const controller = require("../src/controllers/reportController");
const { refreshAccessToken, parseState, exchangeCode } = require("../src/services/googleCmsAuthService");
const { searchArtistAssets } = require("../src/services/assetCheckService");

const newGrant = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 3600,
  scope: "https://www.googleapis.com/auth/youtubepartner"
};

function network() {
  return db.prepare("SELECT * FROM networks WHERE id = 1").get();
}

function startAuth() {
  let url;
  controller.getNetworkCmsAuthUrl({ params: { id: 1 } }, { json: (payload) => { url = new URL(payload.data.url); } });
  return url;
}

function disconnect() {
  controller.disconnectNetworkCmsAuth({ params: { id: 1 } }, { json: (payload) => assert.equal(payload.success, true) });
}

async function callback(query) {
  let result;
  await controller.handleNetworkCmsAuthCallback({ query, get: () => undefined }, { redirect: (url) => { result = new URL(url); } });
  return result.searchParams;
}

test.beforeEach((t) => {
  db.exec("DELETE FROM networks");
  db.prepare(`
    INSERT INTO networks (id, name, network_code, cms_auth_status, cms_auth_email, cms_auth_name,
      cms_access_token, cms_refresh_token, cms_token_expiry, cms_authed_at, cms_auth_generation)
    VALUES (1, 'CMS fixture', 'OWNER_FIXTURE', 'connected', 'old@example.test', 'Old Account',
      'old-access', 'old-refresh', ?, CURRENT_TIMESTAMP, 'original-generation')
  `).run(new Date(Date.now() + 3600000).toISOString());
  t.mock.method(axios, "post", async () => ({ data: newGrant }));
  t.mock.method(axios, "get", async () => ({ data: { email: "new@example.test", name: "New Account" } }));
});

test.after(() => db.close());

test("opening or cancelling OAuth leaves an active CMS connection intact", async () => {
  const before = network();
  const url = startAuth();
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.ok(!url.searchParams.get("scope").includes("channel-audit"));
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.equal(parseState(url.searchParams.get("state")).oauth_client_id, "fixture-client");
  assert.deepEqual(network(), before);

  const result = await callback({ state: url.searchParams.get("state"), error: "access_denied" });
  assert.equal(result.get("cms_auth"), "error");
  assert.equal(result.get("message"), "access_denied");
  assert.deepEqual(network(), before);
  assert.equal(axios.post.mock.callCount(), 0);
});

test("an OAuth exchange failure or access-only grant leaves the entire prior connection intact", async () => {
  const before = network();
  axios.post.mock.mockImplementationOnce(async () => { throw new Error("Google token service timed out"); });
  axios.post.mock.mockImplementationOnce(async () => ({ data: { access_token: "access-only", expires_in: 3600 } }), 1);

  const exchangeFailure = await callback({ state: startAuth().searchParams.get("state"), code: "failed-code" });
  assert.equal(exchangeFailure.get("cms_auth"), "error");
  assert.match(exchangeFailure.get("message"), /timed out/);
  assert.deepEqual(network(), before);

  const incompleteGrant = await callback({ state: startAuth().searchParams.get("state"), code: "access-only-code" });
  assert.equal(incompleteGrant.get("cms_auth"), "error");
  assert.match(incompleteGrant.get("message"), /offline CMS access/);
  assert.deepEqual(network(), before);
});

test("a usable new grant replaces an old one even if Google user info is temporarily unavailable", async () => {
  axios.get.mock.mockImplementationOnce(async () => { throw new Error("Google user info unavailable"); });
  const grantResult = await callback({ state: startAuth().searchParams.get("state"), code: "good-code" });
  assert.equal(grantResult.get("cms_auth"), "success");

  const saved = network();
  assert.equal(saved.cms_auth_status, "connected");
  assert.equal(saved.cms_access_token, newGrant.access_token);
  assert.equal(saved.cms_refresh_token, newGrant.refresh_token);
  assert.equal(saved.cms_oauth_client_id, "fixture-client");
  assert.equal(saved.cms_auth_scopes, newGrant.scope);
  assert.equal(saved.cms_auth_email, "");
  assert.equal(saved.cms_auth_name, "");
  assert.equal(saved.cms_auth_error, null);
  assert.ok(Date.parse(saved.cms_token_expiry) > Date.now());
  assert.notEqual(saved.cms_auth_generation, "original-generation");
});

test("an older tab cannot restore a grant after CMS is disconnected during the exchange", async () => {
  const state = startAuth().searchParams.get("state");
  axios.post.mock.mockImplementationOnce(async () => {
    disconnect();
    return { data: newGrant };
  });

  const result = await callback({ state, code: "stale-code" });
  assert.equal(result.get("cms_auth"), "error");
  assert.match(result.get("message"), /CMS connection changed/);
  assert.equal(network().cms_auth_status, "not_connected");
  assert.equal(network().cms_access_token, null);
  assert.equal(network().cms_refresh_token, null);
});

test("an older signed link survives a rollout while the same CMS authorization is still open", async () => {
  db.exec("UPDATE networks SET cms_auth_status = 'pending', cms_auth_generation = NULL WHERE id = 1");
  const payload = Buffer.from(JSON.stringify({ network_id: 1, nonce: "legacy", ts: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.JWT_SECRET).update(payload).digest("base64url");
  const state = `${payload}.${signature}`;

  const first = await callback({ state, code: "legacy-code" });
  assert.equal(first.get("cms_auth"), "success");
  assert.equal(network().cms_auth_email, "new@example.test");
  const saved = network();

  const stale = await callback({ state, code: "stale-legacy-code" });
  assert.equal(stale.get("cms_auth"), "error");
  assert.match(stale.get("message"), /CMS connection changed/);
  assert.equal(axios.post.mock.callCount(), 1);
  assert.deepEqual(network(), saved);
});

function installPreviousClient(t) {
  const names = ["GOOGLE_PREVIOUS_CLIENT_ID", "GOOGLE_PREVIOUS_CLIENT_SECRET"];
  const old = names.map((name) => process.env[name]);
  process.env[names[0]] = "previous-client";
  process.env[names[1]] = "previous-secret";
  t.after(() => names.forEach((name, index) => {
    if (old[index] === undefined) delete process.env[name]; else process.env[name] = old[index];
  }));
}

function oauthRejection(code, status = 400) {
  return Object.assign(new Error("Token endpoint rejected request"), { response: { status, data: { error: code } } });
}

test("testing a saved connection forces renewal and restores asset search after installing the original client", async (t) => {
  const before = network();
  const attemptedClients = [];
  axios.post.mock.mockImplementation(async (_url, body) => {
    const params = new URLSearchParams(body);
    attemptedClients.push(params.get("client_id"));
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(params.get("refresh_token"), before.cms_refresh_token);
    if (params.get("client_id") !== "previous-client") throw oauthRejection("unauthorized_client");
    assert.equal(params.get("client_secret"), "previous-secret");
    return { data: { access_token: "renewed-access", expires_in: 3600 } };
  });
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await controller.retryNetworkCmsGrant({ params: { id: 1 } }, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.reason, "unauthorized_client");
  assert.deepEqual(network(), before);

  installPreviousClient(t);
  res.code = 200;
  await controller.retryNetworkCmsGrant({ params: { id: 1 } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(network().cms_oauth_client_id, "previous-client");
  assert.equal(network().cms_refresh_token, before.cms_refresh_token);
  db.exec("UPDATE networks SET cms_token_expiry = NULL");
  t.mock.method(axios, "request", async ({ headers, params }) => {
    assert.equal(headers.Authorization, "Bearer renewed-access");
    assert.equal(params.onBehalfOfContentOwner, before.network_code);
    assert.equal(params.metadataSearchFields, "artist:Yella");
    assert.equal(params.ownershipRestriction, "NONE");
    return { data: { items: [{ id: "ASSET-1" }], pageInfo: { totalResults: 1 } } };
  });
  const assets = await searchArtistAssets({ networkId: 1, artist: "Yella", scope: "all", type: "" });
  assert.equal(assets.items[0].id, "ASSET-1");
  assert.deepEqual(attemptedClients, ["fixture-client", "fixture-client", "previous-client", "previous-client"]);
});

test("an alias ID uses its own configured secret when a primary secret is left over", async (t) => {
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"];
  const prior = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i];
  }));
  delete process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "alias-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "alias-secret";
  axios.post.mock.mockImplementation(async (_url, body) => {
    const params = new URLSearchParams(body);
    assert.equal(params.get("client_id"), "alias-client");
    assert.equal(params.get("client_secret"), "alias-secret");
    return { data: newGrant };
  });
  await exchangeCode("fixture-code");
});

test("legacy grants learn the working client and bound grants only use its configured secrets", async (t) => {
  installPreviousClient(t);
  const clients = [];
  axios.post.mock.mockImplementation(async (_url, body) => {
    const params = new URLSearchParams(body);
    clients.push(params.get("client_id"));
    assert.equal(params.get("refresh_token"), "stored");
    if (params.get("client_id") === "fixture-client") throw oauthRejection("unauthorized_client");
    assert.equal(params.get("client_secret"), "previous-secret");
    return { data: { access_token: "renewed" } };
  });
  assert.equal((await refreshAccessToken("stored")).oauth_client_id, "previous-client");
  assert.equal((await refreshAccessToken("stored", "previous-client")).access_token, "renewed");
  await assert.rejects(refreshAccessToken("stored", "not-installed"), { reason: "oauth_client_not_configured" });
  assert.deepEqual(clients, ["fixture-client", "previous-client", "previous-client"]);
});

test("legacy client ambiguity preserves the grant, and transient errors do not probe other clients", async (t) => {
  installPreviousClient(t);
  axios.post.mock.mockImplementation(async () => { throw oauthRejection("invalid_grant"); });
  await assert.rejects(refreshAccessToken("stored"), { reason: "oauth_client_unverified", oauthClientMisconfigured: true });
  assert.equal(axios.post.mock.callCount(), 2);
  axios.post.mock.mockImplementation(async () => { throw oauthRejection("temporarily_unavailable", 503); });
  await assert.rejects(refreshAccessToken("stored"), /Token endpoint rejected/);
  assert.equal(axios.post.mock.callCount(), 3);
});

test("a callback reaching a worker with a different active client exchanges the code with the signed client", async (t) => {
  const state = startAuth().searchParams.get("state");
  const active = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET];
  installPreviousClient(t);
  process.env.GOOGLE_PREVIOUS_CLIENT_ID = active[0];
  process.env.GOOGLE_PREVIOUS_CLIENT_SECRET = active[1];
  process.env.GOOGLE_CLIENT_ID = "different";
  process.env.GOOGLE_CLIENT_SECRET = "different-secret";
  t.after(() => { [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET] = active; });
  axios.post.mock.mockImplementation(async (_url, body) => {
    assert.equal(new URLSearchParams(body).get("client_id"), active[0]);
    return { data: newGrant };
  });
  assert.equal((await callback({ state, code: "good" })).get("cms_auth"), "success");
  assert.equal(network().cms_oauth_client_id, active[0]);
});
