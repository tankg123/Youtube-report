// Draft audio uploads (upload while filling the form, attach on create, expiry sweep), the
// opt-in audio cleanup after delivery, the manual "free storage" action and the persisted
// delivery log endpoints (paging, filters, runs, export).
process.env.CONTENT_ID_RETRY_BASE_MS = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const Database = require("better-sqlite3");

const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cid-delivery-uploads-"));
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
(databaseSource.match(/CREATE INDEX IF NOT EXISTS idx_cid_delivery_\w+ ON [^;]+;/g) || []).forEach((sql) => memoryDb.exec(sql));

// The v4 column exists in the CREATE TABLE and as a guarded ALTER for existing databases.
assert.ok(memoryDb.prepare("PRAGMA table_info(content_id_delivery_products)").all().some((item) => item.name === "delete_reference_after_delivery"));
assert.match(databaseSource, /ALTER TABLE content_id_delivery_products ADD COLUMN delete_reference_after_delivery /);

memoryDb.prepare("INSERT INTO users (id, full_name, email, password, role) VALUES (1, 'Tester', 'tester@example.com', 'x', 'admin')").run();
memoryDb.prepare("INSERT INTO users (id, full_name, email, password, role) VALUES (2, 'Editor', 'editor@example.com', 'x', 'Content ID')").run();
memoryDb.prepare(`
  INSERT INTO networks (id, name, network_code, cms_auth_status, cms_auth_email, cms_access_token, cms_refresh_token, cms_token_expiry)
  VALUES (7, 'Primary CMS', 'OWNER_123', 'connected', 'cms@example.com', 'fresh-token', 'refresh-token', ?)
`).run(new Date(Date.now() + 3600000).toISOString());

// ---------------------------------------------------------------------------
// Fake Google Content ID API (assets, ownership, policy, resumable reference upload)
// ---------------------------------------------------------------------------

const PARTNER_API = "https://youtubepartner.googleapis.com/youtube/partner/v1";
const PARTNER_UPLOAD_API = "https://youtubepartner.googleapis.com/upload/youtube/partner/v1";
const SESSION_URL = `${PARTNER_UPLOAD_API}/references?uploadType=resumable&upload_id=sess-2`;

const calls = [];
const uploads = [];
// Two tracks upload concurrently (DELIVER_CONCURRENCY), so every resumable session gets its own URL.
const sessions = new Map();
const cms = { assetCounter: 0, referenceCounter: 0, sessionCounter: 0, failOwnership: false };

function ok(data, extra = {}) {
  return { status: 200, headers: {}, data, ...extra };
}

function httpError(status, message) {
  const error = new Error(message);
  error.response = { status, headers: {}, data: { error: { message, errors: [] } } };
  return error;
}

async function drain(stream) {
  let bytes = 0;
  const hash = crypto.createHash("sha256");
  for await (const chunk of stream) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

const fakeAxios = {
  async request(config) {
    calls.push(config);
    const { method, url } = config;
    const p = url.startsWith(PARTNER_API) ? url.slice(PARTNER_API.length) : "";
    const upload = url.startsWith(PARTNER_UPLOAD_API) ? url.slice(PARTNER_UPLOAD_API.length) : "";
    if (method === "POST" && p === "/assets") {
      cms.assetCounter += 1;
      return ok({ id: `A${cms.assetCounter}` });
    }
    if (method === "PUT" && /\/ownership$/.test(p)) {
      if (cms.failOwnership) throw httpError(400, "Ownership rejected");
      return ok(config.data);
    }
    if (method === "PUT" && /\/matchPolicy$/.test(p)) return ok(config.data);
    if (method === "PATCH" && /^\/assets\//.test(p)) return ok(config.data);
    if (method === "GET" && p === "/assetSearch") return ok({ items: [] });
    if (method === "POST" && upload === "/references") {
      cms.sessionCounter += 1;
      const location = `${SESSION_URL}-${cms.sessionCounter}`;
      sessions.set(location, config.data.assetId);
      return { status: 200, headers: { location }, data: "" };
    }
    if (method === "PUT" && sessions.has(url)) {
      const received = await drain(config.data);
      uploads.push(received);
      cms.referenceCounter += 1;
      return ok({ id: `R${cms.referenceCounter}`, assetId: sessions.get(url), status: "checking", contentType: "audio", length: 10 });
    }
    return ok({});
  }
};

const originalLoad = Module._load;
Module._load = function loadWithFakes(request, parent, isMain) {
  if (request === "axios") return fakeAxios;
  if (request === "../config/database") return memoryDb;
  if (request === "./googleCmsAuthService") {
    return { refreshAccessToken: async () => ({ access_token: "refreshed", expires_in: 3600 }) };
  }
  return originalLoad(request, parent, isMain);
};
const controller = require("../src/controllers/deliveryController");
const drafts = require("../src/services/deliveryDraftService");
Module._load = originalLoad;
const jobs = require("../src/services/deliveryJobService");
const media = require("../src/services/deliveryMediaService");
const store = require("../src/services/deliveryStore");
const service = require("../src/services/assetDeliveryService");

assert.equal(media.MEDIA_DIR, MEDIA_DIR);

// ---------------------------------------------------------------------------
// Fake req / res
// ---------------------------------------------------------------------------

const ADMIN = { id: 1, full_name: "Tester", email: "tester@example.com", roles: ["admin"] };
const EDITOR = { id: 2, full_name: "Editor", email: "editor@example.com", roles: ["Content ID"] };

function makeRes() {
  const chunks = [];
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = () => {
    res.text = Buffer.concat(chunks).toString("utf8");
  };
  return res;
}

async function call(handler, req = {}) {
  const res = makeRes();
  const request = typeof req.pipe === "function" ? req : { params: {}, query: {}, body: {}, headers: {}, user: ADMIN, ...req };
  await handler(request, res);
  return res;
}

function streamReq(bytes, { params = {}, query = {}, headers = {}, user = ADMIN } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const req = Readable.from([buffer]);
  req.params = params;
  req.query = query;
  req.body = {};
  req.user = user;
  req.headers = { "content-type": "audio/wav", "content-length": String(buffer.length), ...headers };
  return req;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function draftFiles() {
  const dir = path.join(MEDIA_DIR, media.DRAFT_DIR_NAME);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function uploadRows() {
  return memoryDb.prepare("SELECT * FROM content_id_delivery_audio_uploads ORDER BY created_at ASC").all();
}

async function uploadDraft(bytes, fileName, user = ADMIN) {
  const res = await call(controller.uploadDraftAudio, streamReq(bytes, { query: { file_name: fileName, file_size: String(bytes.length) }, user }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.upload;
}

const basePayload = {
  network_id: 7,
  product: { title: "Uploads Album", artist: "Album Artist", upc: "", label: "ANS", genre: "Pop", release_date: "2025-01-01" },
  rights: { ownership: { mode: "worldwide", territories: [] }, match_policy_id: "policy-1", match_policy_name: "Monetize", asset_labels: ["ANS"] },
  reference: { content_type: "audio", urgent: false },
  options: { skip_duplicates: false }
};

const AUDIO_ONE = Buffer.from("RIFF-draft-one-0123456789");
const AUDIO_TWO = Buffer.from("RIFF-draft-two-abcdefghij");
const state = {};

test.after(() => {
  drafts.stopDraftAudioSweep();
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Draft uploads
// ---------------------------------------------------------------------------

test("uploadDraftAudio stores the raw body under _drafts with a row that expires, and validates the request", async () => {
  const json = await call(controller.uploadDraftAudio, streamReq("{}", { headers: { "content-type": "application/json" } }));
  assert.equal(json.statusCode, 415);
  const mismatch = await call(controller.uploadDraftAudio, streamReq(AUDIO_ONE, { query: { file_size: "5" } }));
  assert.equal(mismatch.statusCode, 400);
  assert.deepEqual(draftFiles(), [], "rejected uploads leave nothing behind");

  const upload = await uploadDraft(AUDIO_ONE, "../01 Song One.wav");
  assert.match(upload.id, /^[a-f0-9]{32}$/);
  assert.equal(upload.file_name, "_01 Song One.wav");
  assert.equal(upload.file_size, AUDIO_ONE.length);
  assert.equal(upload.file_mime, "audio/wav");
  assert.equal(upload.file_sha256, sha256(AUDIO_ONE));
  assert.ok(Date.parse(upload.expires_at) > Date.now() + 60 * 60 * 1000, "expires in the future");
  assert.equal(Object.hasOwn(upload, "file_path"), false, "the server path is not exposed");
  assert.deepEqual(draftFiles(), [`${upload.id}___01 Song One.wav`]);
  assert.equal(sha256(fs.readFileSync(path.join(MEDIA_DIR, media.DRAFT_DIR_NAME, draftFiles()[0]))), sha256(AUDIO_ONE));
  assert.equal(uploadRows()[0].created_by, 1);
  assert.equal(calls.length, 0, "draft uploads never touch Google");

  const check = await call(controller.checkDraftAudio, { query: { ids: `${upload.id},ffffffffffffffffffffffffffffffff,not-an-id` } });
  assert.equal(check.statusCode, 200);
  assert.deepEqual(check.body.uploads.map((item) => item.id), [upload.id]);
  assert.deepEqual(check.body.missing, ["ffffffffffffffffffffffffffffffff"]);
  const foreign = await call(controller.checkDraftAudio, { query: { ids: upload.id }, user: EDITOR });
  assert.deepEqual(foreign.body.uploads, [], "another user cannot see the upload");
  assert.deepEqual(foreign.body.missing, [upload.id]);
  state.uploadOne = upload;
});

test("deleteDraftAudio removes the file and row, refuses other users and unknown ids", async () => {
  const upload = await uploadDraft(AUDIO_TWO, "temp.wav", EDITOR);
  assert.equal(uploadRows().length, 2);

  const unknown = await call(controller.deleteDraftAudio, { params: { id: "ffffffffffffffffffffffffffffffff" } });
  assert.equal(unknown.statusCode, 404);
  const invalid = await call(controller.deleteDraftAudio, { params: { id: "../etc" } });
  assert.equal(invalid.statusCode, 400);
  const foreign = await call(controller.deleteDraftAudio, { params: { id: state.uploadOne.id }, user: EDITOR });
  assert.equal(foreign.statusCode, 403);
  assert.equal(uploadRows().length, 2);

  const removed = await call(controller.deleteDraftAudio, { params: { id: upload.id }, user: EDITOR });
  assert.equal(removed.statusCode, 200);
  assert.equal(uploadRows().length, 1);
  assert.deepEqual(draftFiles(), [`${state.uploadOne.id}___01 Song One.wav`]);
  const admin = await uploadDraft(AUDIO_TWO, "temp2.wav", EDITOR);
  const byAdmin = await call(controller.deleteDraftAudio, { params: { id: admin.id }, user: ADMIN });
  assert.equal(byAdmin.statusCode, 200, "an admin may remove anyone's upload");
});

test("createProduct attaches the draft uploads to their tracks and reports bad references per row", async () => {
  const two = await uploadDraft(AUDIO_TWO, "02 Song Two.flac", EDITOR);

  const foreign = await call(controller.createProduct, {
    user: EDITOR,
    body: { ...basePayload, tracks: [{ client_id: "f1", title: "Song One", isrc: "VNA122500001", audio_upload_id: state.uploadOne.id }] }
  });
  assert.equal(foreign.statusCode, 400);
  assert.match(foreign.body.field_errors.f1, /belongs to another user/);

  const twice = await call(controller.createProduct, {
    body: {
      ...basePayload,
      tracks: [
        { client_id: "d1", title: "Song One", isrc: "VNA122500001", audio_upload_id: state.uploadOne.id },
        { client_id: "d2", title: "Song Two", isrc: "VNA122500002", audio_upload_id: state.uploadOne.id }
      ]
    }
  });
  assert.equal(twice.statusCode, 400);
  assert.match(twice.body.field_errors.d2, /attached to track 1 as well/);

  const expired = await call(controller.createProduct, {
    body: { ...basePayload, tracks: [{ client_id: "e1", title: "Song One", isrc: "VNA122500001", audio_upload_id: "ffffffffffffffffffffffffffffffff" }] }
  });
  assert.equal(expired.statusCode, 400);
  assert.match(expired.body.field_errors.e1, /expired or was removed/);
  assert.equal(memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_products").get().count, 0, "validation failures store nothing");
  assert.equal(uploadRows().length, 2, "failed attempts keep the uploads");

  const res = await call(controller.createProduct, {
    body: {
      ...basePayload,
      options: { skip_duplicates: false, delete_reference_after_delivery: true },
      tracks: [
        { client_id: "c1", title: "Song One", isrc: "VNA122500001", file_name: "ignored.wav", file_size: 1, audio_upload_id: state.uploadOne.id },
        { client_id: "c2", title: "Song Two", isrc: "VNA122500002", audio_upload_id: two.id },
        { client_id: "c3", title: "Song Three", isrc: "VNA122500003", file_name: "expected.wav" }
      ]
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { product } = res.body;
  assert.deepEqual(res.body.audio_errors, []);
  assert.equal(product.delete_reference_after_delivery, true);
  assert.equal(product.status, "draft");
  const [one, twoTrack, three] = product.tracks;
  assert.equal(one.has_audio, true);
  assert.equal(one.file_name, "_01 Song One.wav", "the uploaded file name wins over the placeholder");
  assert.equal(one.file_size, AUDIO_ONE.length);
  assert.equal(one.file_sha256, sha256(AUDIO_ONE));
  assert.equal(one.file_path, `${product.id}/${one.id}___01 Song One.wav`);
  assert.ok(one.file_uploaded_at);
  assert.equal(one.status, "pending");
  assert.equal(twoTrack.has_audio, true);
  assert.equal(twoTrack.file_name, "02 Song Two.flac");
  assert.equal(twoTrack.file_mime, "audio/wav", "the MIME sent with the upload is kept");
  assert.equal(three.has_audio, false);
  assert.equal(three.file_name, "expected.wav");
  assert.deepEqual(draftFiles(), [], "attached uploads leave the draft folder");
  assert.equal(uploadRows().length, 0, "attached uploads are consumed");
  assert.equal(sha256(fs.readFileSync(path.join(MEDIA_DIR, String(product.id), `${twoTrack.id}__02 Song Two.flac`))), sha256(AUDIO_TWO));
  const events = product.events.slice().reverse();
  assert.deepEqual(events.map((event) => event.action), ["create", "audio_upload", "audio_upload"]);
  assert.match(events[0].message, /2 audio file\(s\) uploaded beforehand/);
  assert.equal(events[1].track_id, one.id);
  assert.equal(events[1].track_title, "Song One");
  assert.equal(events[1].payload.upload_id, state.uploadOne.id);
  assert.equal(events[1].created_by_name, "Tester");

  const gone = await call(controller.createProduct, {
    body: { ...basePayload, product: { ...basePayload.product, title: "Reuse" }, tracks: [{ client_id: "g1", title: "Song", isrc: "VNA122500009", audio_upload_id: two.id }] }
  });
  assert.equal(gone.statusCode, 400, "a consumed upload cannot be attached twice");
  assert.match(gone.body.field_errors.g1, /expired or was removed/);
  state.productId = product.id;
  state.trackIds = { one: one.id, two: twoTrack.id, three: three.id };
});

test("the expiry sweep removes expired rows, orphaned and abandoned files but keeps live uploads", async () => {
  const live = await uploadDraft(AUDIO_ONE, "live.wav");
  const expired = await uploadDraft(AUDIO_TWO, "expired.wav");
  memoryDb.prepare("UPDATE content_id_delivery_audio_uploads SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), expired.id);
  const dir = path.join(MEDIA_DIR, media.DRAFT_DIR_NAME);
  const old = new Date(Date.now() - media.DRAFT_TTL_MS - 60000);
  fs.writeFileSync(path.join(dir, `${"a".repeat(32)}__orphan-old.wav`), "old orphan");
  fs.utimesSync(path.join(dir, `${"a".repeat(32)}__orphan-old.wav`), old, old);
  fs.writeFileSync(path.join(dir, `${"b".repeat(32)}__orphan-new.wav`), "new orphan");
  fs.writeFileSync(path.join(dir, `${"c".repeat(32)}__abandoned.wav.part`), "abandoned");
  fs.utimesSync(path.join(dir, `${"c".repeat(32)}__abandoned.wav.part`), old, old);
  fs.writeFileSync(path.join(dir, `${"d".repeat(32)}__writing.wav.part`), "in progress");

  const result = await drafts.sweepExpiredDraftAudio({ logger: { error() {}, log() {} } });
  assert.equal(result.expired_uploads, 1);
  assert.equal(result.removed_files, 1);
  assert.equal(result.orphan_files, 2);
  assert.equal(result.errors, 0);
  assert.equal(result.bytes_freed, AUDIO_TWO.length + "old orphan".length + "abandoned".length);
  assert.deepEqual(draftFiles(), [`${"b".repeat(32)}__orphan-new.wav`, `${"d".repeat(32)}__writing.wav.part`, `${live.id}__live.wav`].sort());
  assert.deepEqual(uploadRows().map((row) => row.id), [live.id]);

  const removed = await call(controller.deleteDraftAudio, { params: { id: live.id } });
  assert.equal(removed.statusCode, 200);
  fs.rmSync(path.join(dir, `${"b".repeat(32)}__orphan-new.wav`));
  fs.rmSync(path.join(dir, `${"d".repeat(32)}__writing.wav.part`));

  drafts.scheduleDraftAudioSweep({ initialDelayMs: 1, intervalMs: 3600000, logger: { error() {}, log() {} } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  drafts.stopDraftAudioSweep();
});

// ---------------------------------------------------------------------------
// Delivery with the stored uploads, opt-in cleanup and the persisted logs
// ---------------------------------------------------------------------------

test("deliverProduct delivers the attached audio as references and removes it afterwards when asked", async () => {
  const off = await call(controller.deliverProduct, { params: { id: String(state.productId) }, body: { delete_reference_after_delivery: false, track_ids: [state.trackIds.three] } });
  assert.equal(off.statusCode, 202, JSON.stringify(off.body));
  assert.equal(off.body.product.delete_reference_after_delivery, false, "an explicit flag is stored on the product");
  const first = await jobs.waitForJob(state.productId);
  assert.deepEqual(first.summary, { created: 1, references: 0, duplicate: 0, error: 0 });

  const res = await call(controller.deliverProduct, { params: { id: String(state.productId) }, body: { delete_reference_after_delivery: true } });
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.job.track_ids, [state.trackIds.one, state.trackIds.two, state.trackIds.three], "track three only misses its reference and is picked up again");
  const progress = await call(controller.getProductProgress, { params: { id: String(state.productId) } });
  assert.equal(progress.body.product.delete_reference_after_delivery, true);
  assert.equal(progress.body.product.include_reference, true);
  const done = await jobs.waitForJob(state.productId);
  assert.deepEqual(done.summary, { created: 2, references: 2, duplicate: 0, error: 0 });
  assert.deepEqual(uploads.map((item) => item.sha256).sort(), [sha256(AUDIO_ONE), sha256(AUDIO_TWO)].sort(), "the stored bytes reach Google");

  const detail = await call(controller.getProduct, { params: { id: String(state.productId) } });
  const product = detail.body.product;
  assert.equal(product.status, "delivered");
  const one = product.tracks.find((track) => track.id === state.trackIds.one);
  const two = product.tracks.find((track) => track.id === state.trackIds.two);
  assert.equal(one.status, "completed");
  assert.equal(one.has_audio, false, "cleanup removed the audio after a successful reference");
  assert.equal(one.file_path, null);
  assert.match(one.reference_id, /^R\d+$/);
  assert.equal(two.has_audio, false);
  assert.deepEqual(fs.readdirSync(path.join(MEDIA_DIR, String(state.productId))), []);
  const timeline = product.events.map((event) => event.action);
  assert.equal(timeline.filter((action) => action === "reference_cleanup").length, 2);
  assert.ok(!timeline.includes("api") && !timeline.includes("delivery_step"), "the timeline hides the trace rows");
  state.runId = product.events[0].payload.run_id;
});

test("cleanupProductAudio frees only the audio of fully delivered tracks and refuses to run during a delivery", async () => {
  const stored = await call(controller.uploadAudio, streamReq(AUDIO_ONE, { params: { id: String(state.trackIds.one) }, query: { file_name: "again.wav" } }));
  assert.equal(stored.statusCode, 200, JSON.stringify(stored.body));
  const pending = await call(controller.uploadAudio, streamReq(AUDIO_TWO, { params: { id: String(state.trackIds.three) }, query: { file_name: "three.wav" } }));
  assert.equal(pending.statusCode, 200, JSON.stringify(pending.body));
  assert.equal(pending.body.track.status, "created", "track three has an asset but no reference");

  const empty = await call(controller.cleanupProductAudio, { params: { id: String(state.productId) }, body: { track_ids: [] } });
  assert.equal(empty.statusCode, 400);
  const missing = await call(controller.cleanupProductAudio, { params: { id: "999" }, body: {} });
  assert.equal(missing.statusCode, 404);

  const res = await call(controller.cleanupProductAudio, { params: { id: String(state.productId) }, body: {} });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.removed, 1);
  assert.equal(res.body.bytes_freed, AUDIO_ONE.length);
  const byTrack = Object.fromEntries(res.body.results.map((item) => [item.track_id, item]));
  assert.equal(byTrack[state.trackIds.one].removed, true);
  assert.deepEqual(byTrack[state.trackIds.two], { track_id: state.trackIds.two, removed: false, reason: "no_audio" });
  assert.deepEqual(byTrack[state.trackIds.three], { track_id: state.trackIds.three, removed: false, reason: "no_live_reference" });
  const tracks = Object.fromEntries(res.body.product.tracks.map((track) => [track.id, track]));
  assert.equal(tracks[state.trackIds.one].has_audio, false);
  assert.match(tracks[state.trackIds.one].reference_id, /^R[12]$/, "the reference stays after the file is removed (R1/R2: tracks upload concurrently)");
  assert.equal(tracks[state.trackIds.three].has_audio, true, "audio still needed for the reference is kept");
  assert.deepEqual(res.body.product.events.slice(0, 2).map((event) => [event.action, event.track_id]), [["audio_cleanup", null], ["audio_cleanup", state.trackIds.one]]);
  assert.match(res.body.product.events[0].message, /removing 1 audio file/);

  // While a job streams a file the action is refused.
  let release;
  const parked = new Promise((resolve) => { release = resolve; });
  const original = service.uploadReferenceStream;
  service.uploadReferenceStream = async () => {
    await parked;
    return { id: "R9", assetId: pending.body.track.asset_id, status: "checking", contentType: "audio", length: 10 };
  };
  try {
    const started = await call(controller.deliverProduct, { params: { id: String(state.productId) }, body: { track_ids: [state.trackIds.three] } });
    assert.equal(started.statusCode, 202, JSON.stringify(started.body));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const busy = await call(controller.cleanupProductAudio, { params: { id: String(state.productId) }, body: {} });
    assert.equal(busy.statusCode, 409);
    release();
    const done = await jobs.waitForJob(state.productId);
    assert.deepEqual(done.summary, { created: 0, references: 1, duplicate: 0, error: 0 });
  } finally {
    service.uploadReferenceStream = original;
  }
  const after = await call(controller.getProduct, { params: { id: String(state.productId) } });
  const three = after.body.product.tracks.find((track) => track.id === state.trackIds.three);
  assert.equal(three.status, "completed");
  assert.equal(three.has_audio, false, "the product-level opt-in cleanup still applies to later runs");
});

test("log endpoints page with cursors, filter by track / status / action group / run / search and expose track titles", async () => {
  const total = store.countEvents(state.productId);
  assert.ok(total > 30, `expected a detailed trace, got ${total} events`);

  const collected = [];
  let beforeId;
  let pages = 0;
  do {
    const res = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { limit: "7", before_id: beforeId } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.job.running, false);
    collected.push(...res.body.events);
    beforeId = res.body.has_more ? res.body.next_before_id : null;
    pages += 1;
  } while (beforeId);
  assert.equal(collected.length, total, "cursor paging covers every event exactly once");
  assert.ok(pages > 4);
  assert.equal(new Set(collected.map((event) => event.id)).size, total);
  const newest = collected[0];
  assert.ok(collected.every((event, index) => index === 0 || event.id < collected[index - 1].id), "newest first");
  assert.ok(collected.some((event) => event.track_title === "Song One" && event.track_number === 1));
  assert.doesNotMatch(JSON.stringify(collected), /fresh-token|refreshed|sess-2|Authorization/, "secrets never reach the logs");

  const polled = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { after_id: String(collected[3].id) } });
  assert.deepEqual(polled.body.events.map((event) => event.id), [collected[2].id, collected[1].id, collected[0].id]);
  assert.equal(polled.body.latest_id, newest.id);
  const nothing = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { after_id: String(newest.id) } });
  assert.deepEqual(nothing.body.events, []);
  assert.equal(nothing.body.latest_id, newest.id);

  const byTrack = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { track_id: String(state.trackIds.two), limit: "200" } });
  assert.ok(byTrack.body.events.length > 5);
  assert.ok(byTrack.body.events.every((event) => event.track_id === state.trackIds.two && event.track_title === "Song Two"));

  const api = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { action: "api", limit: "200" } });
  assert.ok(api.body.events.length >= 6);
  assert.ok(api.body.events.every((event) => event.action === "api" && event.payload.endpoint && event.payload.method));
  assert.ok(api.body.events.some((event) => event.payload.phase === "completed" && event.payload.http_status === 200 && Number.isFinite(event.payload.duration_ms)));
  const delivery = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { action: "delivery", limit: "200" } });
  assert.ok(delivery.body.events.every((event) => ["deliver", "delivery_step", "track_delivery", "delivery_progress", "delivery_interrupted", "retry"].includes(event.action)));
  const audio = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { action: "audio", limit: "200" } });
  assert.ok(audio.body.events.every((event) => ["audio_upload", "audio_delete", "audio_cleanup", "reference_cleanup"].includes(event.action)));
  assert.ok(audio.body.events.some((event) => event.action === "reference_cleanup"));

  const byRun = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { run_id: state.runId, limit: "200" } });
  assert.ok(byRun.body.events.length > 10);
  assert.ok(byRun.body.events.every((event) => event.payload.run_id === state.runId));
  const search = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { search: "ownership", limit: "200" } });
  assert.ok(search.body.events.length >= 2);
  assert.ok(search.body.events.every((event) => JSON.stringify(event).toLowerCase().includes("ownership")));
  const escaped = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { search: "100%", limit: "200" } });
  assert.equal(escaped.statusCode, 200);
  const noErrors = await call(controller.listProductLogs, { params: { id: String(state.productId) }, query: { status: "error" } });
  assert.deepEqual(noErrors.body.events, []);
  const missing = await call(controller.listProductLogs, { params: { id: "999" } });
  assert.equal(missing.statusCode, 404);
});

test("runs summarize every delivery (completed, failed, interrupted) and the export streams JSONL or CSV", async () => {
  const draft = await call(controller.createProduct, {
    body: { ...basePayload, product: { ...basePayload.product, title: "Failing" }, tracks: [{ client_id: "x1", title: "Broken", isrc: "VNA122500050" }] }
  });
  assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
  const productId = draft.body.product.id;
  const trackId = draft.body.product.tracks[0].id;
  cms.failOwnership = true;
  const failed = await call(controller.deliverProduct, { params: { id: String(productId) }, body: {} });
  assert.equal(failed.statusCode, 202);
  await jobs.waitForJob(productId);
  cms.failOwnership = false;
  const retried = await call(controller.deliverProduct, { params: { id: String(productId) }, body: {} });
  assert.equal(retried.statusCode, 202);
  await jobs.waitForJob(productId);
  memoryDb.prepare("UPDATE content_id_delivery_products SET status = 'delivering' WHERE id = ?").run(productId);
  memoryDb.prepare("UPDATE content_id_delivery_tracks SET status = 'uploading', step = 'reference' WHERE id = ?").run(trackId);
  store.logEvent(productId, { action: "deliver", status: "started", message: "Started delivery of 1 track(s)", payload: { run_id: "run-interrupted", phase: "started", track_ids: [trackId] } });
  assert.equal(jobs.recordInterruptedJob(productId), true);

  const runs = await call(controller.listProductLogRuns, { params: { id: String(productId) } });
  assert.equal(runs.statusCode, 200);
  assert.deepEqual(runs.body.runs.map((run) => run.status), ["interrupted", "completed", "error"]);
  const [interrupted, completed, errored] = runs.body.runs;
  assert.equal(interrupted.run_id, "run-interrupted");
  assert.deepEqual(interrupted.track_ids, [trackId]);
  assert.ok(interrupted.finished_at);
  assert.deepEqual(errored.summary, { created: 0, references: 0, duplicate: 0, error: 1 });
  assert.ok(errored.started_at && errored.finished_at && Number.isFinite(errored.duration_ms));
  assert.equal(errored.created_by_name, "Tester");
  assert.match(errored.message, /1 failed/);
  assert.deepEqual(completed.summary, { created: 1, references: 0, duplicate: 0, error: 0 }, "the retry resumed at ownership and finished the asset");
  assert.equal(completed.include_reference, true);

  const errors = await call(controller.listProductLogs, { params: { id: String(productId) }, query: { status: "error", limit: "200" } });
  assert.ok(errors.body.events.length >= 3);
  assert.ok(errors.body.events.every((event) => event.status === "error"));
  assert.ok(errors.body.events.some((event) => event.action === "delivery_step" && event.payload.step === "ownership" && /Ownership rejected/.test(event.message)));
  assert.ok(errors.body.events.some((event) => event.action === "delivery_interrupted"));

  const jsonl = await call(controller.exportProductLogs, { params: { id: String(productId) }, query: {} });
  assert.equal(jsonl.statusCode, 200);
  assert.match(jsonl.headers["content-type"], /ndjson/);
  assert.match(jsonl.headers["content-disposition"], new RegExp(`^attachment; filename="cms-delivery-${productId}-logs-.*\\.jsonl"$`));
  const lines = jsonl.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, store.countEvents(productId));
  assert.ok(lines.every((line, index) => index === 0 || line.id > lines[index - 1].id), "export is oldest first");
  assert.equal(lines[0].action, "create");
  assert.ok(lines.some((line) => line.track_title === "Broken"));
  const csv = await call(controller.exportProductLogs, { params: { id: String(productId) }, query: { format: "csv", status: "error" } });
  assert.match(csv.headers["content-type"], /text\/csv/);
  const rows = csv.text.trim().split("\r\n");
  assert.equal(rows[0], "id,created_at,run_id,track_id,track_number,track_title,action,status,step,message,http_status,duration_ms,percent,asset_id,reference_id,created_by_name");
  assert.equal(rows.length - 1, errors.body.events.length);
  assert.ok(rows.slice(1).every((row) => row.split(",").length >= 16));
  const missing = await call(controller.exportProductLogs, { params: { id: "999" } });
  assert.equal(missing.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Review follow-ups: client_id echo, manual reference cleanup + API trace, restart
// reconciliation, run numbering, CSV hardening, guarded audio clearing
// ---------------------------------------------------------------------------

test("createProduct echoes each row's client_id so the form can map its rows to the stored tracks", async () => {
  const upload = await uploadDraft(AUDIO_ONE, "echo.wav");
  const res = await call(controller.createProduct, {
    body: {
      ...basePayload,
      product: { ...basePayload.product, title: "Echo" },
      options: { skip_duplicates: false, delete_reference_after_delivery: true },
      reference: { content_type: "audio", urgent: false, include_reference: false },
      tracks: [
        { client_id: "row-b", track_number: 2, title: "Second", isrc: "VNA122500062" },
        { client_id: "row-a", track_number: 1, title: "First", isrc: "VNA122500061", audio_upload_id: upload.id }
      ]
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const byClient = Object.fromEntries(res.body.product.tracks.map((track) => [track.client_id, track]));
  assert.equal(byClient["row-a"].isrc, "VNA122500061");
  assert.equal(byClient["row-a"].has_audio, true);
  assert.equal(byClient["row-b"].isrc, "VNA122500062");
  assert.equal(res.body.product.include_reference, false, "the form's reference switch is stored");
  assert.equal(uploadRows().length, 0, "the upload was claimed inside the create transaction");
  state.echoProductId = res.body.product.id;
  state.echoTrackId = byClient["row-a"].id;
});

test("a manual reference delivery traces its CMS calls under one run id and honours delete-after-delivery", async () => {
  const productId = state.echoProductId;
  const trackId = state.echoTrackId;
  const delivered = await call(controller.deliverProduct, { params: { id: String(productId) }, body: { track_ids: [trackId] } });
  assert.equal(delivered.statusCode, 202, JSON.stringify(delivered.body));
  const done = await jobs.waitForJob(productId);
  assert.deepEqual(done.summary, { created: 1, references: 0, duplicate: 0, error: 0 }, "references are off for this product");
  let track = store.getTrackParsed(trackId);
  assert.equal(track.status, "created");
  assert.equal(track.has_audio, true);

  const lastBefore = store.listEvents(productId, { limit: 1 }).events[0].id;
  const res = await call(controller.deliverReference, { params: { id: String(trackId) }, body: {} });
  assert.equal(res.statusCode, 202, JSON.stringify(res.body), "manual reference delivery runs as a background job");
  assert.deepEqual(res.body.job.track_ids, [trackId]);
  assert.equal(res.body.product.status, "delivering");
  assert.equal(jobs.isRunning(productId), true);
  const blocked = await call(controller.uploadAudio, streamReq(AUDIO_TWO, { params: { id: String(trackId) }, query: { file_name: "late.wav" } }));
  assert.equal(blocked.statusCode, 409, "the file cannot be replaced while it is being delivered");
  const manual = await jobs.waitForJob(productId);
  assert.deepEqual(manual.summary, { created: 0, references: 1, duplicate: 0, error: 0 });
  track = store.getTrackParsed(trackId);
  assert.equal(track.status, "completed");
  assert.equal(track.has_audio, false, "the product asked for the audio to be removed after delivery");
  assert.equal(track.file_path, null);
  assert.match(track.reference_id, /^R\d+$/);
  const events = store.listEvents(productId, { afterId: lastBefore, limit: 200 }).events;
  assert.ok(events.length >= 4);
  const runIds = new Set(events.map((event) => event.payload?.run_id).filter(Boolean));
  assert.equal(runIds.size, 1, "every event of the request shares one run id");
  const api = events.filter((event) => event.action === "api");
  assert.ok(api.length >= 2, "initiate + upload are traced");
  assert.ok(api.every((event) => event.track_id === trackId && event.payload.step === "reference"));
  assert.ok(api.some((event) => event.payload.endpoint === "/references/upload" && event.payload.phase === "completed" && event.payload.percent === 100));
  assert.ok(events.some((event) => event.action === "reference_upload" && event.status === "ok"));
  assert.ok(events.some((event) => event.action === "reference_cleanup" && event.status === "ok" && event.payload.bytes_freed === AUDIO_ONE.length));
  assert.doesNotMatch(JSON.stringify(events), /fresh-token|sess-2|Authorization/);

  // Retry of an errored track is traced the same way.
  cms.failOwnership = true;
  const failing = await call(controller.createProduct, {
    body: { ...basePayload, product: { ...basePayload.product, title: "Retry trace" }, tracks: [{ client_id: "r1", title: "Retry me", isrc: "VNA122500070" }] }
  });
  const failingId = failing.body.product.id;
  const failingTrack = failing.body.product.tracks[0].id;
  await call(controller.deliverProduct, { params: { id: String(failingId) }, body: {} });
  await jobs.waitForJob(failingId);
  cms.failOwnership = false;
  const retried = await call(controller.retryTrack, { params: { id: String(failingTrack) } });
  assert.equal(retried.statusCode, 200, JSON.stringify(retried.body));
  const retryEvents = store.listEvents(failingId, { action: "retry" }).events;
  assert.equal(retryEvents.length, 1);
  const retryApi = store.listEvents(failingId, { runId: retryEvents[0].payload.run_id, action: "api" }).events;
  assert.ok(retryApi.some((event) => /ownership$/.test(event.payload.endpoint) && event.status === "ok"), "the retried ownership call is logged under the retry's run id");
});

test("reconcileInterruptedJobs makes tracks left in flight retryable, finalizes the product and logs the interruption once", async () => {
  const draft = await call(controller.createProduct, {
    body: { ...basePayload, product: { ...basePayload.product, title: "Restart" }, tracks: [
      { client_id: "s1", title: "Stuck", isrc: "VNA122500080" },
      { client_id: "s2", title: "Done", isrc: "VNA122500081" }
    ] }
  });
  const productId = draft.body.product.id;
  const [stuck, fine] = draft.body.product.tracks.map((track) => track.id);
  memoryDb.prepare("UPDATE content_id_delivery_products SET status = 'delivering', job_started_at = ? WHERE id = ?").run(new Date().toISOString(), productId);
  memoryDb.prepare("UPDATE content_id_delivery_tracks SET status = 'uploading', step = 'reference', asset_id = 'A77' WHERE id = ?").run(stuck);
  memoryDb.prepare("UPDATE content_id_delivery_tracks SET status = 'created', asset_id = 'A78' WHERE id = ?").run(fine);
  store.logEvent(productId, { action: "deliver", status: "started", message: "Started delivery of 2 track(s)", payload: { run_id: "run-restart", phase: "started", track_ids: [stuck, fine] } });

  // Reading the product before the reconciliation already records the interruption (idempotent).
  const read = await call(controller.getProduct, { params: { id: String(productId) } });
  assert.equal(read.body.product.status, "delivering");
  assert.equal(store.listEvents(productId, { action: "delivery_interrupted" }).events.length, 1);

  // Earlier tests left another product parked in "delivering" on purpose; every such product is handled.
  const delivering = memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_products WHERE status = 'delivering'").get().count;
  assert.ok(delivering >= 1);
  assert.equal(jobs.reconcileInterruptedJobs(), delivering);
  assert.equal(jobs.reconcileInterruptedJobs(), 0, "nothing is left delivering afterwards");
  const product = (await call(controller.getProduct, { params: { id: String(productId) } })).body.product;
  assert.equal(product.status, "partial");
  assert.match(product.error_message, /interrupted by a server restart/);
  assert.ok(product.job_finished_at);
  const tracks = Object.fromEntries(product.tracks.map((track) => [track.id, track]));
  assert.equal(tracks[stuck].status, "error");
  assert.equal(tracks[stuck].step, "reference");
  assert.match(tracks[stuck].error_message, /interrupted by a server restart/);
  assert.equal(tracks[fine].status, "created", "tracks that were not in flight are untouched");
  assert.equal(store.listEvents(productId, { action: "delivery_interrupted" }).events.length, 1, "the interruption is logged once");
  const runs = await call(controller.listProductLogRuns, { params: { id: String(productId) } });
  assert.equal(runs.body.runs[0].status, "interrupted");
  assert.equal(runs.body.runs[0].run_id, "run-restart");
  // The stuck track is deliverable again.
  const again = await call(controller.deliverProduct, { params: { id: String(productId) }, body: {} });
  assert.equal(again.statusCode, 202, JSON.stringify(again.body));
  assert.ok(again.body.job.track_ids.includes(stuck));
  await jobs.waitForJob(productId);
});

test("runs carry an absolute sequence number and the total, so a limited page keeps its labels", async () => {
  const productId = state.echoProductId;
  const all = await call(controller.listProductLogRuns, { params: { id: String(productId) } });
  assert.equal(all.statusCode, 200);
  assert.equal(all.body.total, all.body.runs.length);
  assert.deepEqual(all.body.runs.map((run) => run.sequence), all.body.runs.map((_, index) => all.body.runs.length - index));
  const failingId = memoryDb.prepare("SELECT id FROM content_id_delivery_products WHERE title = 'Retry trace'").get().id;
  const limited = await call(controller.listProductLogRuns, { params: { id: String(failingId) }, query: { limit: "1" } });
  assert.equal(limited.body.total, 1);
  assert.equal(limited.body.runs[0].sequence, 1);
  const product2 = memoryDb.prepare("SELECT id FROM content_id_delivery_products WHERE title = 'Failing'").get().id;
  const page = await call(controller.listProductLogRuns, { params: { id: String(product2) }, query: { limit: "2" } });
  assert.equal(page.body.total, 3);
  assert.deepEqual(page.body.runs.map((run) => run.sequence), [3, 2]);
});

test("the CSV export starts with a UTF-8 BOM and neutralises spreadsheet formulas in free text", async () => {
  const hostile = "=HYPERLINK(\"http://evil.example\",\"open\")";
  const res = await call(controller.createProduct, {
    body: { ...basePayload, product: { ...basePayload.product, title: "Formula" }, tracks: [{ client_id: "f1", title: hostile, isrc: "VNA122500090" }] }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const productId = res.body.product.id;
  const trackId = res.body.product.tracks[0].id;
  store.logEvent(productId, { track_id: trackId, action: "audio_upload", message: "+1 |cmd", payload: { step: "-1" } });
  const csv = await call(controller.exportProductLogs, { params: { id: String(productId) }, query: { format: "csv" } });
  assert.equal(csv.statusCode, 200);
  assert.equal(csv.text.charCodeAt(0), 0xfeff, "BOM for Excel");
  const rows = csv.text.slice(1).trim().split("\r\n");
  assert.equal(rows[0].split(",")[0], "id");
  const quotedTitle = `"'${hostile.replace(/"/g, "\"\"")}"`;
  assert.ok(rows.some((row) => row.includes(quotedTitle)), "the title cell is quoted and prefixed with an apostrophe");
  assert.ok(rows.some((row) => row.includes(",'+1 |cmd,")));
  assert.ok(rows.some((row) => row.includes(",'-1,")), "payload step is neutralised too");
  assert.ok(rows.slice(1).every((row) => !/(^|,)[=+\-@]/.test(row.replace(/"(?:[^"]|"")*"/g, "x"))), "no cell starts with a formula character");
  const jsonl = await call(controller.exportProductLogs, { params: { id: String(productId) }, query: {} });
  assert.notEqual(jsonl.text.charCodeAt(0), 0xfeff, "JSONL stays plain");
  assert.ok(jsonl.text.trim().split("\n").map((line) => JSON.parse(line)).some((line) => line.track_title === hostile), "JSONL keeps the raw text");
});

test("clearTrackAudio with a stale path leaves a replaced file registered", async () => {
  const productId = state.echoProductId;
  const trackId = memoryDb.prepare("SELECT id FROM content_id_delivery_tracks WHERE product_id = ? AND isrc = 'VNA122500062'").get(productId).id;
  const stored = await call(controller.uploadAudio, streamReq(AUDIO_TWO, { params: { id: String(trackId) }, query: { file_name: "replaced.wav" } }));
  assert.equal(stored.statusCode, 200, JSON.stringify(stored.body));
  assert.equal(store.clearTrackAudio(trackId, { filePath: `${productId}/${trackId}__old.wav` }), false);
  assert.equal(store.getTrackParsed(trackId).file_name, "replaced.wav");
  assert.equal(store.clearTrackAudio(trackId, { filePath: stored.body.track.file_path }), true);
  assert.equal(store.getTrackParsed(trackId).file_path, null);
  assert.equal(store.clearTrackAudio(trackId), false, "nothing left to clear once file_path is empty");
});

test("reconcileInterruptedJobs also frees tracks a cut-off retry left in flight on a product that was not delivering", async () => {
  const draft = await call(controller.createProduct, {
    body: { ...basePayload, product: { ...basePayload.product, title: "Retry cut off" }, tracks: [
      { client_id: "q1", title: "Half retried", isrc: "VNA122500095" },
      { client_id: "q2", title: "Untouched", isrc: "VNA122500096" }
    ] }
  });
  assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
  const productId = draft.body.product.id;
  const [half, untouched] = draft.body.product.tracks.map((track) => track.id);
  await call(controller.deliverProduct, { params: { id: String(productId) }, body: { include_reference: false } });
  await jobs.waitForJob(productId);
  assert.equal(store.getProductRow(productId).status, "delivered");
  // What retryTrack leaves behind when the process dies during the ownership call.
  memoryDb.prepare("UPDATE content_id_delivery_tracks SET status = 'creating', step = 'ownership' WHERE id = ?").run(half);
  const finishedBefore = store.getProductRow(productId).job_finished_at;

  assert.equal(jobs.reconcileInterruptedJobs(), 1);
  const product = (await call(controller.getProduct, { params: { id: String(productId) } })).body.product;
  const tracks = Object.fromEntries(product.tracks.map((track) => [track.id, track]));
  assert.equal(tracks[half].status, "error");
  assert.equal(tracks[half].step, "ownership");
  assert.match(tracks[half].error_message, /interrupted by a server restart/);
  assert.equal(tracks[untouched].status, "created");
  assert.equal(product.status, "partial", "recomputed from the tracks, no fake job bookkeeping");
  assert.equal(product.job_finished_at, finishedBefore, "no job ran, so the job timestamps are untouched");
  const interrupted = store.listEvents(productId, { action: "delivery_interrupted" }).events;
  assert.equal(interrupted.length, 1);
  assert.match(interrupted[0].payload.run_id, /^interrupted-/);
  assert.deepEqual(interrupted[0].payload.interrupted_track_ids, [half]);
  assert.ok(store.listEvents(productId, { trackId: half, action: "track_delivery", status: "error" }).events.length >= 1);
  assert.equal(jobs.reconcileInterruptedJobs(), 0);

  // A run that finished every track but died before its bookkeeping keeps a clean product.
  memoryDb.prepare("UPDATE content_id_delivery_tracks SET status = 'created', step = NULL, error_message = NULL WHERE id = ?").run(half);
  memoryDb.prepare("UPDATE content_id_delivery_products SET status = 'delivering', error_message = NULL WHERE id = ?").run(productId);
  assert.equal(jobs.reconcileInterruptedJobs(), 1);
  const clean = store.getProductRow(productId);
  assert.equal(clean.status, "delivered");
  assert.equal(clean.error_message, null, "no in-flight track, so no interruption error is stamped");
  assert.ok(clean.job_finished_at);
});
