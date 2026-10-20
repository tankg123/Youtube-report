// Transport proof: a real express app with the same middleware chain as server.js (helmet, cors,
// express.json, express.urlencoded) receives a raw binary PUT and stores it unchanged.
process.env.CONTENT_ID_RETRY_BASE_MS = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cid-delivery-http-"));
process.env.CONTENT_ID_MEDIA_DIR = MEDIA_DIR;

const databaseSource = fs.readFileSync(path.join(__dirname, "../src/config/database.js"), "utf8");

function extractCreateTable(name) {
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`);
  const match = databaseSource.match(pattern);
  if (!match) throw new Error(`CREATE TABLE ${name} not found in database.js`);
  return match[0];
}

const memoryDb = new Database(":memory:");
[
  "users",
  "networks",
  "content_id_labels",
  "content_id_products",
  "content_id_tracks",
  "content_id_codes",
  "content_id_delivery_products",
  "content_id_delivery_tracks",
  "content_id_delivery_events",
  "content_id_delivery_audio_uploads"
].forEach((name) => memoryDb.exec(extractCreateTable(name)));

memoryDb.prepare("INSERT INTO users (id, full_name, email, password, role) VALUES (1, 'Tester', 'tester@example.com', 'x', 'admin')").run();
memoryDb.prepare(`
  INSERT INTO networks (id, name, network_code, cms_auth_status, cms_access_token, cms_refresh_token, cms_token_expiry)
  VALUES (7, 'Primary CMS', 'OWNER_123', 'connected', 'fresh-token', 'refresh-token', ?)
`).run(new Date(Date.now() + 3600000).toISOString());
const productId = Number(memoryDb.prepare(`
  INSERT INTO content_id_delivery_products (network_id, network_name, title, match_policy_id, track_count, status)
  VALUES (7, 'Primary CMS', 'HTTP Album', 'policy-1', 1, 'draft')
`).run().lastInsertRowid);
const trackId = Number(memoryDb.prepare(`
  INSERT INTO content_id_delivery_tracks (product_id, track_number, title, isrc, status)
  VALUES (?, 1, 'HTTP Song', 'VNA122400077', 'pending')
`).run(productId).lastInsertRowid);

const fakeAxios = {
  async request(config) {
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  }
};

const originalLoad = Module._load;
Module._load = function loadWithHttpFakes(request, parent, isMain) {
  if (request === "axios") return fakeAxios;
  if (request === "../config/database") return memoryDb;
  if (request === "./googleCmsAuthService") {
    return { refreshAccessToken: async () => ({ access_token: "refreshed", expires_in: 3600 }) };
  }
  return originalLoad(request, parent, isMain);
};
const controller = require("../src/controllers/deliveryController");
Module._load = originalLoad;

const USER = { id: 1, full_name: "Tester", email: "tester@example.com", roles: ["admin"] };

function buildApp() {
  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors({
    origin: ["http://localhost:5173"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
    exposedHeaders: ["Content-Disposition", "X-Package-Skipped"]
  }));
  app.use(express.json({ limit: "25mb" }));
  app.use(express.urlencoded({ extended: true }));

  const router = express.Router();
  router.use((req, res, next) => {
    req.user = USER;
    next();
  });
  router.put("/delivery/tracks/:id/audio", controller.uploadAudio);
  router.get("/delivery/tracks/:id/audio", controller.getTrackAudio);
  router.put("/delivery/audio-uploads", controller.uploadDraftAudio);
  router.delete("/delivery/audio-uploads/:id", controller.deleteDraftAudio);
  app.use("/api/content-id", router);
  return app;
}

function request(port, { method, path: requestPath, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

let server;
let port;

test.before(async () => {
  server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
});

test("a 3 MB binary PUT passes helmet/cors/json/urlencoded untouched and is stored with the right sha256", async () => {
  const body = crypto.randomBytes(3 * 1024 * 1024);
  const query = new URLSearchParams({ file_name: "Bài hát 01.wav", file_size: String(body.length) });
  const res = await request(port, {
    method: "PUT",
    path: `/api/content-id/delivery/tracks/${trackId}/audio?${query}`,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(body.length),
      Origin: "http://localhost:5173"
    },
    body
  });

  assert.equal(res.status, 200, res.body.toString("utf8"));
  const payload = JSON.parse(res.body.toString("utf8"));
  assert.equal(payload.success, true);
  assert.equal(payload.track.id, trackId);
  assert.equal(payload.track.file_size, body.length);
  assert.equal(payload.track.file_mime, "audio/wav");
  assert.equal(payload.track.file_sha256, sha256(body));
  assert.equal(payload.track.file_name, "Bài hát 01.wav");
  assert.equal(payload.track.has_audio, true);
  assert.equal(payload.track.status, "pending");

  const stored = path.join(MEDIA_DIR, String(productId), `${trackId}__Bài hát 01.wav`);
  assert.ok(fs.existsSync(stored), "file must exist under the media dir");
  assert.equal(fs.statSync(stored).size, body.length);
  assert.equal(sha256(fs.readFileSync(stored)), sha256(body));

  const row = memoryDb.prepare("SELECT file_path, file_size, file_sha256 FROM content_id_delivery_tracks WHERE id = ?").get(trackId);
  assert.equal(row.file_path, `${productId}/${trackId}__Bài hát 01.wav`);
  assert.equal(row.file_size, body.length);
  assert.equal(row.file_sha256, sha256(body));

  // The same bytes come back through express, including a Range request.
  const full = await request(port, { method: "GET", path: `/api/content-id/delivery/tracks/${trackId}/audio` });
  assert.equal(full.status, 200);
  assert.equal(full.headers["content-type"], "audio/wav");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.body.equals(body), true);

  const partial = await request(port, {
    method: "GET",
    path: `/api/content-id/delivery/tracks/${trackId}/audio?download=1`,
    headers: { Range: "bytes=1000-1999" }
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers["content-range"], `bytes 1000-1999/${body.length}`);
  assert.equal(partial.headers["content-length"], "1000");
  assert.match(partial.headers["content-disposition"], /^attachment; filename="B_i h_t 01.wav"; filename\*=UTF-8''B%C3%A0i%20h%C3%A1t%2001\.wav$/);
  assert.equal(partial.body.equals(body.subarray(1000, 2000)), true);
});

test("a JSON body on the audio route is rejected with 415 and a size mismatch with 400", async () => {
  const json = await request(port, {
    method: "PUT",
    path: `/api/content-id/delivery/tracks/${trackId}/audio`,
    headers: { "Content-Type": "application/json", "Content-Length": "2" },
    body: Buffer.from("{}")
  });
  assert.equal(json.status, 415);

  const body = crypto.randomBytes(1024);
  const mismatch = await request(port, {
    method: "PUT",
    path: `/api/content-id/delivery/tracks/${trackId}/audio?file_size=999`,
    headers: { "Content-Type": "audio/mpeg", "Content-Length": String(body.length) },
    body
  });
  assert.equal(mismatch.status, 400);
  assert.match(JSON.parse(mismatch.body.toString("utf8")).message, /file_size/);

  const stored = path.join(MEDIA_DIR, String(productId));
  assert.deepEqual(fs.readdirSync(stored), [`${trackId}__Bài hát 01.wav`], "a rejected upload leaves the stored file alone");
});

test("a draft audio PUT (no product yet) is stored under _drafts through the same middleware chain and can be deleted", async () => {
  const body = crypto.randomBytes(512 * 1024);
  const query = new URLSearchParams({ file_name: "Nháp 02.flac", file_size: String(body.length) });
  const res = await request(port, {
    method: "PUT",
    path: `/api/content-id/delivery/audio-uploads?${query}`,
    headers: { "Content-Type": "audio/flac", "Content-Length": String(body.length), Origin: "http://localhost:5173" },
    body
  });
  assert.equal(res.status, 200, res.body.toString("utf8"));
  const payload = JSON.parse(res.body.toString("utf8"));
  assert.equal(payload.success, true);
  assert.match(payload.upload.id, /^[a-f0-9]{32}$/);
  assert.equal(payload.upload.file_name, "Nháp 02.flac");
  assert.equal(payload.upload.file_size, body.length);
  assert.equal(payload.upload.file_mime, "audio/flac");
  assert.equal(payload.upload.file_sha256, sha256(body));
  const stored = path.join(MEDIA_DIR, "_drafts", `${payload.upload.id}__Nháp 02.flac`);
  assert.ok(fs.existsSync(stored), "draft file must exist under the media dir");
  assert.equal(sha256(fs.readFileSync(stored)), sha256(body));
  const row = memoryDb.prepare("SELECT * FROM content_id_delivery_audio_uploads WHERE id = ?").get(payload.upload.id);
  assert.equal(row.file_path, `_drafts/${payload.upload.id}__Nháp 02.flac`);
  assert.equal(row.created_by, 1);
  assert.ok(Date.parse(row.expires_at) > Date.now());

  const removed = await request(port, { method: "DELETE", path: `/api/content-id/delivery/audio-uploads/${payload.upload.id}` });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(stored), false);
  assert.equal(memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_audio_uploads").get().count, 0);
});
