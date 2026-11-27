const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const express = require("express");
const jwt = require("jsonwebtoken");

const db = new Database(":memory:");
const schema = fs.readFileSync(path.join(__dirname, "../src/config/database.js"), "utf8");
for (const table of ["users", "ownership_channels", "ownership_channel_owners", "ownership_api_keys", "system_settings", "sidebar_hidden_items"]) {
  db.exec(schema.match(new RegExp("CREATE TABLE IF NOT EXISTS " + table + " \\([\\s\\S]*?\\n\\s*\\);"))[0]);
}
function substitute(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
substitute("../src/config/database", db);
substitute("../src/services/claimManagerService", { listClaimAccounts: () => [{ id: 7, has_partner_scope: true }] });
const directory = require("../src/services/ownershipDirectory");
const channel = "UC" + "a".repeat(22);
const calls = [];
substitute("../src/services/ownershipEmailService", { async lookupOwnershipEmail({ id, pageToken }) {
  calls.push([id, pageToken]);
  if (id !== channel) throw Object.assign(new Error("Not found"), { status: 404 });
  const owner = pageToken ? { owner_id: "two", name: "Other CMS", email: "rights@example.org" }
    : { owner_id: "one", name: "First CMS", email: null };
  const asset = { evidence: "title", owners: [owner], ownership_url: "https://studio.youtube.com/asset/test/ownership" };
  const result = { channel: { id, title: "Channel", manager: pageToken ? owner : null },
    videos: [{ id: "video", assets: [asset, asset] }], next_page_token: pageToken ? null : "more" };
  return { ...result, ...directory.recordLookup(result, true) };
} });
process.env.JWT_SECRET = "test-only";
process.env.BACKEND_API_KEY = "internal-test-only";
const app = express();
app.use("/api/public", require("../src/routes/ownershipPublicRoutes"));
app.use(express.json());
app.use("/api", require("../src/middlewares/apiKeyMiddleware"));
app.use("/api/settings", require("../src/routes/settingsRoutes"));
const keysPath = "/api/settings/ownership-api-keys";
const publicPath = "/api/public/ownership-email";
let server, base;
test.before(async () => {
  db.prepare("INSERT INTO users(id,full_name,email,password,role) VALUES (1,'Admin','admin@example.org','x','admin'),(2,'User','user@example.org','x','Content ID')").run();
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => { await new Promise((resolve) => server.close(resolve)); db.close(); });
async function request(path, { method = "GET", key, user, token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers["x-api-key"] = key;
  if (user) headers.authorization = "Bearer " + jwt.sign({ id: user }, process.env.JWT_SECRET);
  if (token) headers.authorization = "Bearer " + token;
  return fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

test("sidebar changes require both admin and the backend code, and preserve individual page choices", async () => {
  const system = "/api/settings/system";
  const endpoint = "/api/settings/sidebar";
  const key = process.env.BACKEND_API_KEY;
  const code = "fixture-sidebar-secret";
  const page = "/content-id/check";
  const body = { id: page, visible: false, code };
  const login = jwt.sign({ id: 1, jti: "sidebar-test" }, process.env.JWT_SECRET);
  const unlock = (user, code) => request(endpoint + "/unlock", { method: "POST", key, user,
    token: user === 1 ? login : undefined, body: { code } });
  const put = (user, data, url = endpoint) => request(url, { method: "PUT", key, user, body: data });
  const read = async () => (await request(system, { key })).json();

  delete process.env.SIDEBAR_SETTINGS_CODE;
  assert.equal((await unlock(1, "")).status, 503);
  assert.equal((await put(1, body)).status, 503);
  process.env.SIDEBAR_SETTINGS_CODE = code;
  assert.equal((await unlock(null, code)).status, 401);
  assert.equal((await unlock(2, code)).status, 403);
  const denied = await unlock(1, "wrong");
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).menu, undefined);
  assert.equal((await put(null, body)).status, 401);
  assert.equal((await put(2, body)).status, 403);
  assert.equal((await put(1, { ...body, code: "wrong" })).status, 403);
  assert.equal((await put(1, { id: page, visible: false })).status, 403);
  assert.equal((await put(1, { ...body, id: "/invented" })).status, 400);
  assert.equal((await put(1, { ...body, visible: "false" })).status, 400);
  await put(1, { sidebar: { hidden: [page] }, SIDEBAR_SETTINGS_CODE: code }, system);
  const initial = await read();
  assert.deepEqual(initial.sidebar.hidden, []);
  assert.equal(initial.sidebar.menu, undefined);
  assert.ok(!JSON.stringify(initial).includes(code));
  const unlocked = await unlock(1, code);
  assert.equal(unlocked.headers.get("cache-control"), "no-store");
  const { menu, grant } = await unlocked.json();
  assert.ok(menu.find((item) => item.id === "content-id").children.find((child) => child.id === page).children.length);
  assert.ok(grant);
  const update = (data) => request(endpoint, { method: "PUT", token: login, key, body: { grant, ...data } });
  assert.equal((await update({ id: page, visible: false, grant: grant + "x" })).status, 403);
  assert.equal((await put(1, { id: page, visible: false, grant })).status, 403); // different login
  assert.deepEqual((await (await update({ id: page, visible: false })).json()).hidden, [page]);
  await put(1, { ...body, id: "content-id" });
  await put(1, { ...body, visible: true, code: "wrong" });
  assert.ok((await read()).sidebar.hidden.includes("/content-id/claims#check/uploads"));
  await put(1, { ...body, id: "content-id", visible: true });
  assert.deepEqual((await read()).sidebar.hidden, [page, page + "#detail"]);
  process.env.SIDEBAR_SETTINGS_CODE = "rotated";
  assert.equal((await update({ id: page, visible: true })).status, 403);
  delete process.env.SIDEBAR_SETTINGS_CODE;
  assert.equal((await put(1, { ...body, visible: true })).status, 503);
  assert.deepEqual((await read()).sidebar.hidden, [page, page + "#detail"]);
});

test("external GET and POST require a scoped key and return only the matching channel and CMS contact", async () => {
  const internal = { key: process.env.BACKEND_API_KEY };
  const admin = { ...internal, user: 1 };
  const data = { "Channel ID": channel, "CMS Name": "Other CMS" };
  assert.equal((await request(keysPath, internal)).status, 401);
  assert.equal((await request(keysPath, { ...internal, user: 2, method: "POST", body: { name: "client" } })).status, 403);
  const created = await request(keysPath, { ...admin, method: "POST", body: { name: "client" } });
  assert.equal(created.status, 201);
  const keyInfo = await created.json();
  const key = keyInfo.key;
  assert.ok(key && !JSON.stringify(db.prepare("SELECT * FROM ownership_api_keys").all()).includes(key));
  const listing = await (await request(keysPath, admin)).text();
  assert.ok(!listing.includes(key) && !listing.includes("key_hash"));
  const query = publicPath + "?" + new URLSearchParams(data);
  const preflight = await fetch(base + publicPath, { method: "OPTIONS", headers: {
    origin: "https://client.example", "access-control-request-method": "POST", "access-control-request-headers": "x-api-key,content-type"
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  for (const badKey of [null, "wrong", internal.key]) {
    const denied = await request(query, { key: badKey });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).status, "Please check manually");
    assert.equal((await request(publicPath, { method: "POST", key: badKey, body: data })).status, 401);
  }
  assert.equal(calls.length, 0);
  assert.equal((await request(keysPath, { key, user: 1 })).status, 401);
  const invalid = await request(publicPath, { key, method: "POST", body: { ...data, "Channel ID": "bad" } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).status, "Please check manually");
  const post = await request(publicPath, { key, method: "POST", body: { ...data, "CMS Name": " other   cms " } });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { ...data, Email: "rights@example.org", status: "Success" });
  assert.equal(calls.length, 2);
  const get = await request(query, { key });
  assert.deepEqual(await get.json(), { ...data, Email: "rights@example.org", status: "Success" });
  assert.equal(calls.length, 2, "a known contact is served from the directory");
  for (const cms of ["First CMS", "Missing CMS"]) {
    const body = { "Channel ID": channel, "CMS Name": cms };
    const miss = await request(publicPath, { method: "POST", key, body });
    assert.equal(miss.status, 200);
    const result = await miss.json();
    assert.equal(result.Email, "");
    assert.equal(result.status, "Please check manually");
    assert.ok(result.message);
  }
  const otherChannel = { ...data, "Channel ID": "UC" + "b".repeat(22) };
  const invisible = await (await request(publicPath, { key, method: "POST", body: otherChannel })).json();
  assert.equal(invisible.Email, "");
  assert.equal(invisible.status, "Please check manually");
  assert.match(invisible.message, /not visible/);
  assert.equal(db.prepare("SELECT owner_count FROM ownership_channels WHERE channel_id=?").get(channel).owner_count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ownership_channel_owners").get().n, 2);
  assert.equal((await request(keysPath + "/" + keyInfo.id, { ...admin, method: "DELETE" })).status, 204);
  assert.equal((await request(query, { key })).status, 401);
});

test("public lookup distinguishes a complete empty scan, CMS token rejection, quota and the shared channel deadline", async (t) => {
  const admin = { key: process.env.BACKEND_API_KEY, user: 1 };
  const created = await request(keysPath, { ...admin, method: "POST", body: { name: "test-status" } });
  const { key } = await created.json();
  const query = publicPath + "?" + new URLSearchParams({ channel_id: channel, cms_name: "Unseen CMS" });
  const lookup = t.mock.method(require("../src/services/ownershipEmailService"), "lookupOwnershipEmail");
  const page = (id, next) => ({ channel: { manager: null }, videos: [{ id, assets: [] }], next_page_token: next });
  lookup.mock.mockImplementation(async ({ pageToken }) => page(pageToken || "first", pageToken ? null : "second"));
  let res = await request(query, { key });
  let data = await res.json();
  assert.deepEqual([res.status, data.status, data.Email, data.videos_checked], [200, "Please check manually", "", 2]);
  assert.match(data.message, /No verified ownership/);
  for (const [error, http] of [
    [{ cmsAuthFailed: true, reason: "invalid_grant" }, 503],
    [{ oauthClientMisconfigured: true, reason: "unauthorized_client" }, 503],
    [{ status: 401 }, 503],
    [{ status: 403, reason: "quotaExceeded" }, 429]
  ]) {
    lookup.mock.mockImplementation(async () => { throw Object.assign(new Error("private-token-value"), error); });
    res = await request(query, { key });
    data = await res.json();
    assert.deepEqual([res.status, data.status, data.Email], [http, "Please check manually", ""]);
    assert.ok(data.message && !data.message.includes("private-token-value"));
  }
  const old = process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS;
  process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS = "1000";
  t.after(() => { if (old === undefined) delete process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS; else process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS = old; });
  let stopped = false;
  lookup.mock.mockImplementation(async ({ scan, pageToken }) => {
    if (!pageToken) {
      await require("node:timers/promises").setTimeout(450);
      return page("first", "second");
    }
    await new Promise((resolve) => scan.signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
    return page("second", "third");
  });
  const start = Date.now();
  res = await request(query, { key });
  data = await res.json();
  assert.deepEqual([res.status, data.status, data.Email, data.videos_checked, stopped], [504, "Please check manually", "", 1, true]);
  assert.match(data.message, /time limit.*incomplete/);
  assert.ok(Date.now() - start < 1400, "the second page must share the first page's deadline");
});

test("a unique same-title asset contact succeeds with its evidence, including on a partial-page deadline", async (t) => {
  const { key } = await (await request(keysPath, { method: "POST", key: process.env.BACKEND_API_KEY, user: 1, body: { name: "title-test" } })).json();
  const id = "UC" + "t".repeat(22);
  const name = "Example CMS";
  const email = "asset-owner@example.org";
  const input = { channel_id: id, cms_name: " example  cms " };
  const owner = { owner_id: "example", name, email };
  const url = "https://studio.youtube.com/asset/123/ownership";
  const channelInfo = { id, title: "Test channel" };
  const video = { id: "test-video1", assets: [{ evidence: "title", ownership_url: url, owners: [owner] }] };
  const save = (videos) => directory.recordLookup({ channel: channelInfo, videos }, true);
  const lookup = t.mock.method(require("../src/services/ownershipEmailService"), "lookupOwnershipEmail", async ({ scan }) => {
    scan.onVideo(channelInfo, video);
    await new Promise((resolve) => scan.signal.addEventListener("abort", resolve, { once: true }));
    throw scan.signal.reason;
  });
  const previous = process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS;
  process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS = "1000";
  t.after(() => { if (previous === undefined) delete process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS; else process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS = previous; });

  const post = await request(publicPath, { method: "POST", body: input, key });
  assert.equal(post.status, 200);
  const partial = await post.json();
  assert.deepEqual([partial["CMS Name"], partial.Email, partial.status, partial.evidence, partial.video_id, partial.asset_ownership_url],
    [name, email, "Success", "title", video.id, url]);
  assert.match(partial.message, /unconfirmed.*time limit/i);
  assert.equal(partial.videos_checked, 1);
  const get = () => request(publicPath + "?" + new URLSearchParams(input), { key });
  const cached = await (await get()).json();
  assert.deepEqual([cached.Email, cached.status, cached.videos_checked], [email, "Success", 0]);
  assert.equal(lookup.mock.callCount(), 1);

  const other = { ...owner, owner_id: "other", email: "other@example.org" };
  save([{ ...video, assets: [{ ...video.assets[0], owners: [other] }] }]);
  lookup.mock.mockImplementation(async () => ({ channel: channelInfo, videos: [] }));
  const ambiguous = await (await get()).json();
  assert.deepEqual([ambiguous.Email, ambiguous.status], ["", "Please check manually"]);
  save([{ ...video, assets: [{ ...video.assets[0], evidence: "upload_claim" }] }]);
  assert.deepEqual(await (await get()).json(), { "Channel ID": id, "CMS Name": name, Email: email, status: "Success" });
});
