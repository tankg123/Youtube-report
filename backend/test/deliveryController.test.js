process.env.CONTENT_ID_RETRY_BASE_MS = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");
const Database = require("better-sqlite3");

// The media directory must be configured before the media service is loaded.
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cid-delivery-media-"));
process.env.CONTENT_ID_MEDIA_DIR = MEDIA_DIR;

// ---------------------------------------------------------------------------
// In-memory database built from the real CREATE TABLE statements in database.js
// ---------------------------------------------------------------------------

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
  // content_id_codes has foreign keys to the legacy Product Manager tables; SQLite refuses to
  // prepare an INSERT when the parent table does not exist, so they are created too.
  "content_id_products",
  "content_id_tracks",
  "content_id_codes",
  "content_id_delivery_products",
  "content_id_delivery_tracks",
  "content_id_delivery_events",
  "content_id_delivery_audio_uploads"
].forEach((name) => memoryDb.exec(extractCreateTable(name)));
(databaseSource.match(/CREATE INDEX IF NOT EXISTS idx_cid_delivery_\w+ ON [^;]+;/g) || []).forEach((sql) => memoryDb.exec(sql));

// The v3 columns must exist both in the CREATE TABLE (fresh installs) and as guarded ALTERs.
["file_path", "file_mime", "file_sha256", "file_uploaded_at"].forEach((column) => {
  assert.ok(memoryDb.prepare("PRAGMA table_info(content_id_delivery_tracks)").all().some((item) => item.name === column), `tracks.${column}`);
  assert.match(databaseSource, new RegExp(`ALTER TABLE content_id_delivery_tracks ADD COLUMN ${column} `));
});
["include_reference", "job_started_at", "job_finished_at"].forEach((column) => {
  assert.ok(memoryDb.prepare("PRAGMA table_info(content_id_delivery_products)").all().some((item) => item.name === column), `products.${column}`);
  assert.match(databaseSource, new RegExp(`ALTER TABLE content_id_delivery_products ADD COLUMN ${column} `));
});

// better-sqlite3 enforces foreign keys by default, so the actor referenced by created_by must exist.
memoryDb.prepare("INSERT INTO users (id, full_name, email, password, role) VALUES (1, 'Tester', 'tester@example.com', 'x', 'admin')").run();
memoryDb.prepare(`
  INSERT INTO networks (id, name, network_code, cms_auth_status, cms_auth_email, cms_access_token, cms_refresh_token, cms_token_expiry)
  VALUES (7, 'Primary CMS', 'OWNER_123', 'connected', 'cms@example.com', 'fresh-token', 'refresh-token', ?)
`).run(new Date(Date.now() + 3600000).toISOString());
memoryDb.prepare("INSERT INTO content_id_codes (type, code, status) VALUES ('ISRC', 'VNA122400002', 'unused')").run();

// ---------------------------------------------------------------------------
// Fake Google Content ID API
// ---------------------------------------------------------------------------

const PARTNER_API = "https://youtubepartner.googleapis.com/youtube/partner/v1";
const PARTNER_UPLOAD_API = "https://youtubepartner.googleapis.com/upload/youtube/partner/v1";
const SESSION_URL = `${PARTNER_UPLOAD_API}/references?uploadType=resumable&upload_id=sess-1`;

const calls = [];
const uploads = [];
const cms = {
  assetCounter: 0,
  referenceCounter: 0,
  assetSearchItems: [],
  references: [],
  claims: [],
  assetStatus: "active",
  failNextAssetInsert: false,
  authFail: false,
  failClaimPatch: null,
  failReferencePatch: null,
  timeoutMatchPolicyOnce: false,
  timeoutMatchPolicy: false,
  failOwnershipOnce: false,
  ownershipSnapshot: null,
  ownershipGate: null,
  refuseReferencePatch: null,
  refuseClaimPatch: null,
  lastInitiate: null
};

function ok(data, extra = {}) {
  return { status: 200, headers: {}, data, ...extra };
}

function httpError(status, message, reason) {
  const error = new Error(message);
  error.response = { status, headers: {}, data: { error: { message, errors: reason ? [{ reason }] : [] } } };
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

async function route(config) {
  const { method, url } = config;
  const upload = url.startsWith(PARTNER_UPLOAD_API) ? url.slice(PARTNER_UPLOAD_API.length) : "";
  const p = url.startsWith(PARTNER_API) ? url.slice(PARTNER_API.length) : "";
  const segment = (index) => p.split("/")[index];

  if (cms.authFail) throw httpError(401, "Invalid Credentials", "authError");

  if (method === "POST" && p === "/assets") {
    if (cms.failNextAssetInsert) {
      cms.failNextAssetInsert = false;
      throw httpError(400, "Invalid metadata", "invalidValue");
    }
    cms.assetCounter += 1;
    return ok({ id: `A${cms.assetCounter}`, type: "sound_recording", metadataMine: config.data.metadataMine, label: config.data.label });
  }
  if (method === "PUT" && /^\/assets\/[^/]+\/ownership$/.test(p)) {
    if (cms.ownershipGate) {
      // Holds the call open until the test releases it (a retry parked inside CMS).
      const gate = cms.ownershipGate;
      cms.ownershipGate = null;
      await gate;
    }
    if (cms.failOwnershipOnce) {
      cms.failOwnershipOnce = false;
      // What the database already knows about this asset while its ownership call is in flight.
      cms.ownershipSnapshot = memoryDb.prepare("SELECT asset_id, status, step, steps_json FROM content_id_delivery_tracks WHERE asset_id = ?").get(segment(2)) || null;
      throw httpError(400, "Ownership rejected", "invalidValue");
    }
    return ok(config.data);
  }
  if (method === "PUT" && /^\/assets\/[^/]+\/matchPolicy$/.test(p)) {
    if (cms.timeoutMatchPolicyOnce || cms.timeoutMatchPolicy) {
      // What Axios throws when Google never answers within config.timeout.
      cms.timeoutMatchPolicyOnce = false;
      throw Object.assign(new Error(`timeout of ${config.timeout}ms exceeded`), { code: "ECONNABORTED" });
    }
    return ok(config.data);
  }
  if (method === "PATCH" && /^\/assets\/[^/]+$/.test(p)) return ok({ id: segment(2), ...config.data });
  if (method === "GET" && /^\/assets\/[^/]+$/.test(p)) {
    return ok({
      id: segment(2),
      status: cms.assetStatus,
      ownership: { general: [{ ratio: 100, owner: "OWNER_123", type: "exclude", territories: [] }] },
      matchPolicy: { policyId: "policy-1" },
      metadataMine: { title: "from cms" }
    });
  }
  if (method === "GET" && p === "/assetSearch") {
    const wanted = String(config.params.isrcs).split(",");
    return ok({ items: cms.assetSearchItems.filter((item) => wanted.includes(item.isrc)) });
  }
  if (method === "POST" && upload === "/references") {
    cms.lastInitiate = config.data;
    return { status: 200, headers: { location: SESSION_URL }, data: "" };
  }
  if (method === "PUT" && url === SESSION_URL) {
    const received = await drain(config.data);
    uploads.push({ ...received, contentLength: config.headers["Content-Length"], mime: config.headers["Content-Type"] });
    cms.referenceCounter += 1;
    return ok({ id: `R${cms.referenceCounter}`, assetId: cms.lastInitiate?.assetId || "", status: "checking", contentType: "audio", length: 12 });
  }
  if (method === "POST" && p === "/references" && config.params.claimId) {
    return ok({ id: "R9", assetId: config.data.assetId, status: "active", contentType: config.data.contentType });
  }
  if (method === "GET" && p === "/references") {
    return ok({ items: cms.references.filter((item) => item.assetId === config.params.assetId) });
  }
  if (method === "GET" && /^\/references\/[^/]+$/.test(p)) {
    const reference = cms.references.find((item) => item.id === segment(2));
    if (!reference) throw httpError(404, "Reference not found", "notFound");
    return ok({ ...reference });
  }
  if (method === "PATCH" && /^\/references\/[^/]+$/.test(p)) {
    const id = segment(2);
    if (cms.failReferencePatch === id) throw httpError(500, "Backend Error", "backendError");
    if (cms.refuseReferencePatch && cms.refuseReferencePatch.id === id) {
      // Google's answer to a status that is already set; `thenStatus` is what a read-back sees.
      const { thenStatus } = cms.refuseReferencePatch;
      cms.refuseReferencePatch = null;
      const reference = cms.references.find((item) => item.id === id);
      if (reference && thenStatus) reference.status = thenStatus;
      throw httpError(400, "The reference has already been deactivated. You cannot update the status of a previously deactivated reference.", "permanentFailure");
    }
    const reference = cms.references.find((item) => item.id === id);
    if (reference) reference.status = config.data.status;
    return ok({ id, assetId: reference?.assetId || "", status: config.data.status, contentType: "audio" });
  }
  if (method === "GET" && p === "/claimSearch") {
    return ok({ items: cms.claims.filter((item) => item.assetId === config.params.assetId) });
  }
  if (method === "GET" && /^\/claims\/[^/]+$/.test(p)) {
    const claim = cms.claims.find((item) => item.id === segment(2));
    if (!claim) throw httpError(404, "Claim not found", "notFound");
    return ok({ ...claim });
  }
  if (method === "PATCH" && /^\/claims\/[^/]+$/.test(p)) {
    const id = segment(2);
    if (cms.failClaimPatch === id) throw httpError(400, "Claim is already inactive", "invalidValue");
    if (cms.refuseClaimPatch && cms.refuseClaimPatch.id === id) {
      const { thenStatus } = cms.refuseClaimPatch;
      cms.refuseClaimPatch = null;
      const claim = cms.claims.find((item) => item.id === id);
      if (claim && thenStatus) claim.status = thenStatus;
      throw httpError(400, "Supported status transitions are pending->inactive and active->inactive", "invalidStatusTransition");
    }
    const claim = cms.claims.find((item) => item.id === id);
    if (claim) claim.status = "inactive";
    return ok({ id, status: "inactive" });
  }
  throw new Error(`Unexpected ${method} ${url}`);
}

const fakeAxios = {
  async request(config) {
    calls.push(config);
    return route(config);
  }
};

const originalLoad = Module._load;
Module._load = function loadWithDeliveryFakes(request, parent, isMain) {
  if (request === "axios") return fakeAxios;
  if (request === "../config/database") return memoryDb;
  if (request === "./googleCmsAuthService") {
    return { refreshAccessToken: async () => ({ access_token: "refreshed", expires_in: 3600 }) };
  }
  return originalLoad(request, parent, isMain);
};

const controller = require("../src/controllers/deliveryController");
Module._load = originalLoad;
const jobs = require("../src/services/deliveryJobService");
const media = require("../src/services/deliveryMediaService");
const service = require("../src/services/assetDeliveryService");

assert.equal(media.MEDIA_DIR, MEDIA_DIR);

// ---------------------------------------------------------------------------
// Fake req / res
// ---------------------------------------------------------------------------

const USER = { id: 1, full_name: "Tester", email: "tester@example.com", roles: ["admin"] };

function makeRes() {
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
  return res;
}

// A writable response for the audio stream endpoint.
function makeStreamRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
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
  res.finished = new Promise((resolve) => res.on("finish", resolve));
  res.data = () => Buffer.concat(chunks);
  return res;
}

async function call(handler, req = {}) {
  const res = makeRes();
  // A stream request must keep its prototype (pipe/readableEnded), so it is passed through untouched.
  const request = typeof req.pipe === "function"
    ? req
    : { params: {}, query: {}, body: {}, headers: {}, user: USER, ...req };
  await handler(request, res);
  return res;
}

function streamReq(bytes, { params = {}, query = {}, headers = {} } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const req = Readable.from([buffer]);
  req.params = params;
  req.query = query;
  req.body = {};
  req.user = USER;
  req.headers = { "content-type": "audio/wav", "content-length": String(buffer.length), ...headers };
  return req;
}

function resetCalls() {
  calls.length = 0;
  uploads.length = 0;
}

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function callsMatching(method, pattern) {
  return calls.filter((item) => item.method === method && pattern.test(item.url));
}

function codeRow(code) {
  return memoryDb.prepare("SELECT * FROM content_id_codes WHERE code = ?").get(code) || null;
}

function networkRow() {
  return memoryDb.prepare("SELECT cms_auth_status, cms_auth_error FROM networks WHERE id = 7").get();
}

function eventActions(productId) {
  return memoryDb.prepare("SELECT action, status FROM content_id_delivery_events WHERE product_id = ? ORDER BY id ASC").all(productId);
}

function trackRow(id) {
  return memoryDb.prepare("SELECT * FROM content_id_delivery_tracks WHERE id = ?").get(id);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function getProduct(productId) {
  const res = await call(controller.getProduct, { params: { id: String(productId) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.product;
}

const state = { productId: 0, trackIds: {} };
const AUDIO_ONE = Buffer.from("RIFF-track-one-audio-bytes-0123456789");
const AUDIO_TWO = Buffer.from("RIFF-track-two-audio-bytes-abcdefghij");

const productPayload = {
  network_id: 7,
  product: {
    title: "Album One",
    artist: "Album Artist",
    upc: "0123456789012",
    label: "ANS Records",
    genre: "Pop, Ballad",
    release_date: "2024-05-17",
    artwork_name: "cover.jpg",
    artwork_data_url: "data:image/jpeg;base64,/9j/4AAQ",
    notes: "Product notes"
  },
  rights: {
    ownership: { mode: "worldwide", territories: [] },
    match_policy_id: "policy-1",
    match_policy_name: "Monetize in all countries",
    asset_labels: ["ANS", "Pop"]
  },
  reference: { content_type: "audio", urgent: false },
  options: { skip_duplicates: true },
  tracks: [
    { client_id: "c1", track_number: 1, title: "Song One", artist: "", isrc: "vn-a12-24-00001", custom_id: "", notes: "", asset_labels: null, file_name: "01.wav", file_size: 16 },
    { client_id: "c2", track_number: 2, title: "Song Two", artist: "Feat Artist", isrc: "VNA122400002", custom_id: "", notes: "Track notes", asset_labels: ["Custom"], file_name: "02.wav", file_size: 16 }
  ]
};

test.after(() => {
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Flow: create → deliver (job) → audio → reference → sync → patch → rights → takedown → reactivate → list → delete
// ---------------------------------------------------------------------------

test("createProduct validates the payload with field errors keyed by client_id", async () => {
  const res = await call(controller.createProduct, {
    body: {
      ...productPayload,
      product: { ...productPayload.product, title: "", upc: "12" },
      rights: { ...productPayload.rights, match_policy_id: "" },
      tracks: [
        { client_id: "x1", title: "", isrc: "bad" },
        { client_id: "x2", title: "Dup", isrc: "VNA122400009" },
        { client_id: "x3", title: "Dup again", isrc: "VNA122400009" }
      ]
    }
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.field_errors.title, /required/i);
  assert.match(res.body.field_errors.upc, /UPC/);
  assert.match(res.body.field_errors.match_policy_id, /policy/i);
  assert.match(res.body.field_errors.x1, /Title is required; Valid ISRC is required/);
  assert.match(res.body.field_errors.x3, /duplicated/);
  assert.equal(Object.hasOwn(res.body.field_errors, "x2"), false);
  assert.equal(memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_products").get().count, 0);

  const missingNetwork = await call(controller.createProduct, { body: { ...productPayload, network_id: 99 } });
  assert.equal(missingNetwork.statusCode, 404);
});

test("createProduct stores the draft product with pending tracks and default custom ids", async () => {
  const res = await call(controller.createProduct, { body: productPayload });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { product } = res.body;

  assert.equal(product.status, "draft");
  assert.equal(product.network_id, 7);
  assert.equal(product.network_name, "Primary CMS");
  assert.equal(product.content_owner_id, "OWNER_123");
  assert.equal(product.upc, "0123456789012");
  assert.equal(product.genre, "Pop, Ballad");
  assert.equal(product.release_date, "2024-05-17");
  assert.deepEqual(product.asset_labels, ["ANS", "Pop"]);
  assert.deepEqual(product.ownership, { mode: "worldwide", territories: [] });
  assert.equal(product.match_policy_id, "policy-1");
  assert.equal(product.skip_duplicates, true);
  assert.equal(product.include_reference, true);
  assert.equal(product.reference_urgent, false);
  assert.equal(product.track_count, 2);
  assert.equal(product.created_by_name, "Tester");
  assert.equal(product.tracks.length, 2);

  const [one, two] = product.tracks;
  assert.equal(one.status, "pending");
  assert.equal(one.isrc, "VNA122400001");
  assert.equal(one.artist, "Album Artist");
  assert.equal(one.custom_id, "ANSRecords_VNA122400001");
  assert.equal(one.asset_labels, null);
  assert.equal(one.has_audio, false);
  assert.deepEqual(one.steps, { insert: false, ownership: false, policy: false, labels: false, reference: false });
  assert.equal(two.isrc, "VNA122400002");
  assert.equal(two.artist, "Feat Artist");
  assert.deepEqual(two.asset_labels, ["Custom"]);
  assert.equal(two.file_name, "02.wav");
  assert.deepEqual(product.events.map((event) => event.action), ["create"]);

  state.productId = product.id;
  state.trackIds = { one: one.id, two: two.id };
});

test("deliverProduct answers 202, runs the job in the background, flags CMS duplicates and creates the other assets", async () => {
  resetCalls();
  cms.assetSearchItems = [{ id: "EXISTING-1", title: "Already there", isrc: "VNA122400001", customId: "X", type: "sound_recording", timeCreated: "2025-01-01T00:00:00Z" }];

  const res = await call(controller.deliverProduct, { params: { id: String(state.productId) }, body: {} });
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.job, { running: true, track_ids: [state.trackIds.one, state.trackIds.two] });
  assert.equal(res.body.product.status, "delivering");
  assert.ok(res.body.product.job_started_at);
  res.body.product.tracks.forEach((track) => {
    assert.equal(track.status, "creating");
    assert.equal(track.step, "queued");
  });
  assert.equal(jobs.isRunning(state.productId), true);

  const done = await jobs.waitForJob(state.productId);
  assert.deepEqual(done.summary, { created: 1, references: 0, duplicate: 1, error: 0 });
  assert.equal(jobs.isRunning(state.productId), false);

  assert.equal(callsMatching("GET", /\/assetSearch$/).length, 1);
  assert.equal(callsMatching("POST", /\/assets$/).length, 1);
  assert.equal(callsMatching("PUT", /\/assets\/A1\/ownership$/).length, 1);
  assert.equal(callsMatching("PUT", /\/assets\/A1\/matchPolicy$/).length, 1);
  assert.equal(uploads.length, 0, "no audio stored yet, so no reference upload");
  const insert = callsMatching("POST", /\/assets$/)[0];
  assert.deepEqual(insert.data.label, ["Custom"]);
  assert.deepEqual(insert.data.metadataMine, {
    title: "Song Two",
    artist: ["Feat Artist"],
    album: "Album One",
    isrc: "VNA122400002",
    upc: "0123456789012",
    label: "ANS Records",
    genre: ["Pop", "Ballad"],
    releaseDate: { year: 2024, month: 5, day: 17 },
    customId: "ANSRecords_VNA122400002",
    notes: "Track notes"
  });

  const product = await getProduct(state.productId);
  const trackOne = product.tracks.find((item) => item.id === state.trackIds.one);
  const trackTwo = product.tracks.find((item) => item.id === state.trackIds.two);
  assert.equal(trackOne.status, "duplicate");
  assert.equal(trackOne.duplicates[0].asset_id, "EXISTING-1");
  assert.equal(trackTwo.status, "created");
  assert.equal(trackTwo.asset_id, "A1");
  assert.deepEqual(trackTwo.steps, { insert: true, ownership: true, policy: true, labels: true, reference: false });
  assert.equal(trackTwo.metadata.isrc, "VNA122400002");
  assert.equal(trackTwo.ownership.general[0].owner, "OWNER_123");
  assert.equal(trackTwo.match_policy_id, "policy-1");
  assert.ok(trackTwo.delivered_at);

  assert.equal(product.status, "partial");
  assert.equal(product.delivered_count, 1);
  assert.equal(product.completed_count, 0);
  assert.equal(product.error_count, 0);
  assert.ok(product.delivered_at);
  assert.ok(product.job_finished_at);
  assert.deepEqual(product.job, { running: false, started_at: null });

  const isrcCode = codeRow("VNA122400002");
  assert.equal(isrcCode.status, "used");
  assert.equal(isrcCode.album_title, "Album One");
  assert.equal(isrcCode.song_title, "Song Two");
  assert.equal(isrcCode.product_id, null);
  const upcCode = codeRow("0123456789012");
  assert.equal(upcCode.status, "used");
  assert.equal(upcCode.type, "UPC");
  assert.equal(codeRow("VNA122400001"), null);
  // The job writes a step-by-step trace (api / delivery_step / track_delivery / delivery_progress);
  // the product timeline keeps the outcome-level rows only.
  const actions = eventActions(state.productId).map((event) => event.action);
  assert.deepEqual(actions.slice(0, 2), ["create", "deliver"]);
  assert.equal(actions[actions.length - 1], "deliver");
  assert.ok(actions.includes("api") && actions.includes("delivery_step") && actions.includes("track_delivery"));
  assert.deepEqual(product.events.map((event) => `${event.action}:${event.status}`).reverse(),
    ["create:ok", "deliver:started", "reference_upload:skipped", "deliver:ok"]);
  const deliverEvent = memoryDb.prepare("SELECT payload_json FROM content_id_delivery_events WHERE product_id = ? AND action = 'deliver' ORDER BY id DESC").get(state.productId);
  assert.deepEqual(JSON.parse(deliverEvent.payload_json).summary, { created: 1, references: 0, duplicate: 1, error: 0 });
  const runId = JSON.parse(deliverEvent.payload_json).run_id;
  assert.ok(runId);
  assert.ok(eventActions(state.productId).length > 10);
  const runs = await call(controller.listProductLogRuns, { params: { id: String(state.productId) } });
  assert.equal(runs.statusCode, 200);
  assert.equal(runs.body.runs.length, 1);
  assert.equal(runs.body.runs[0].run_id, runId);
  assert.equal(runs.body.runs[0].status, "completed");
  assert.deepEqual(runs.body.runs[0].track_ids, [state.trackIds.one, state.trackIds.two]);
  assert.deepEqual(runs.body.runs[0].summary, { created: 1, references: 0, duplicate: 1, error: 0 });
});

test("deliverProduct with force_duplicates creates the flagged track and the product becomes delivered", async () => {
  resetCalls();
  const res = await call(controller.deliverProduct, {
    params: { id: String(state.productId) },
    body: { track_ids: [state.trackIds.one], force_duplicates: true }
  });
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.job.track_ids, [state.trackIds.one]);
  const done = await jobs.waitForJob(state.productId);
  assert.deepEqual(done.summary, { created: 1, references: 0, duplicate: 0, error: 0 });

  assert.equal(callsMatching("GET", /\/assetSearch$/).length, 0);
  assert.equal(callsMatching("POST", /\/assets$/).length, 1);
  assert.deepEqual(callsMatching("POST", /\/assets$/)[0].data.label, ["ANS", "Pop"]);
  const product = await getProduct(state.productId);
  const trackOne = product.tracks.find((item) => item.id === state.trackIds.one);
  assert.equal(trackOne.status, "created");
  assert.equal(trackOne.asset_id, "A2");
  assert.equal(product.status, "delivered");
  assert.equal(product.delivered_count, 2);
  assert.equal(codeRow("VNA122400001").status, "used");
});

test("a failing asset insert leaves the track in error, retry recovers it and the failed insert is not retried", async () => {
  const draft = await call(controller.createProduct, {
    body: {
      ...productPayload,
      product: { ...productPayload.product, title: "Album Two", upc: "" },
      tracks: [{ client_id: "e1", title: "Broken", isrc: "VNA122400010" }]
    }
  });
  assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
  const productId = draft.body.product.id;
  const trackId = draft.body.product.tracks[0].id;

  resetCalls();
  cms.failNextAssetInsert = true;
  const res = await call(controller.deliverProduct, { params: { id: String(productId) }, body: {} });
  assert.equal(res.statusCode, 202);
  const done = await jobs.waitForJob(productId);
  assert.deepEqual(done.summary, { created: 0, references: 0, duplicate: 0, error: 1 });
  assert.equal(done.results[0].status, "error");
  assert.equal(done.results[0].step, "insert");
  assert.equal(done.results[0].error_message, "Invalid metadata");
  assert.equal(callsMatching("POST", /\/assets$/).length, 1, "a 400 on POST /assets is never retried");

  const product = await getProduct(productId);
  assert.equal(product.status, "error");
  assert.equal(product.error_count, 1);
  assert.equal(product.error_message, "Invalid metadata");
  assert.equal(product.tracks[0].status, "error");
  assert.equal(product.tracks[0].step, "insert");
  assert.equal(codeRow("VNA122400010"), null);

  const retry = await call(controller.retryTrack, { params: { id: String(trackId) } });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.track.status, "created");
  assert.equal(retry.body.track.asset_id, "A3");
  assert.equal(retry.body.product.status, "delivered");
  assert.equal(codeRow("VNA122400010").status, "used");

  const removed = await call(controller.deleteProduct, { params: { id: String(productId) } });
  assert.equal(removed.statusCode, 200);
});

test("retryTrack checkpoints the asset right after insert and refuses a track that is already in flight", async () => {
  const productId = Number(memoryDb.prepare(`INSERT INTO content_id_delivery_products
    (network_id, title, status, skip_duplicates, ownership_json, match_policy_id, match_policy_name, created_by)
    VALUES (7, 'Retry checkpoint', 'partial', 0, '{"mode":"worldwide","territories":[]}', 'policy-1', 'Monetize', 1)`).run().lastInsertRowid);
  const trackId = Number(memoryDb.prepare(`INSERT INTO content_id_delivery_tracks
    (product_id, track_number, title, isrc, status, step, error_message)
    VALUES (?, 1, 'Checkpoint song', 'VNA122400077', 'error', 'insert', 'boom')`).run(productId).lastInsertRowid);

  // The insert succeeds, the ownership call fails: the asset id must already be on record
  // while the ownership call is in flight, and the track must not be re-inserted later.
  resetCalls();
  cms.failOwnershipOnce = true;
  cms.ownershipSnapshot = null;
  const first = await call(controller.retryTrack, { params: { id: String(trackId) } });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(first.body.track.status, "error");
  assert.equal(first.body.track.step, "ownership");
  const assetId = first.body.track.asset_id;
  assert.match(assetId, /^A\d+$/);
  assert.equal(first.body.track.steps.insert, true);
  assert.equal(callsMatching("POST", /\/assets$/).length, 1);
  assert.ok(cms.ownershipSnapshot, "the row already carried the asset id during the ownership call");
  assert.equal(cms.ownershipSnapshot.asset_id, assetId);
  assert.equal(cms.ownershipSnapshot.status, "creating");
  assert.equal(cms.ownershipSnapshot.step, "ownership");
  assert.equal(JSON.parse(cms.ownershipSnapshot.steps_json).insert, true);

  resetCalls();
  const second = await call(controller.retryTrack, { params: { id: String(trackId) } });
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  assert.equal(second.body.track.status, "created");
  assert.equal(second.body.track.asset_id, assetId);
  assert.equal(callsMatching("POST", /\/assets$/).length, 0, "no second insert");
  assert.equal(callsMatching("PUT", /\/ownership$/).length, 1);

  // A track another request is still working on is not retried in parallel.
  memoryDb.prepare("UPDATE content_id_delivery_tracks SET status = 'creating', step = 'policy' WHERE id = ?").run(trackId);
  resetCalls();
  const busy = await call(controller.retryTrack, { params: { id: String(trackId) } });
  assert.equal(busy.statusCode, 409, JSON.stringify(busy.body));
  assert.match(busy.body.message, /being delivered right now/);
  assert.equal(calls.length, 0);

  const removed = await call(controller.deleteProduct, { params: { id: String(productId) } });
  assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
});

test("Deliver, sync and reference delivery refuse a track a retry request is still working on", async () => {
  const productId = Number(memoryDb.prepare(`INSERT INTO content_id_delivery_products
    (network_id, title, status, skip_duplicates, ownership_json, match_policy_id, match_policy_name, created_by)
    VALUES (7, 'Retry lock', 'partial', 0, '{"mode":"worldwide","territories":[]}', 'policy-1', 'Monetize', 1)`).run().lastInsertRowid);
  const trackId = Number(memoryDb.prepare(`INSERT INTO content_id_delivery_tracks
    (product_id, track_number, title, isrc, status, step, error_message, asset_id, steps_json)
    VALUES (?, 1, 'Locked song', 'VNA122400078', 'error', 'ownership', 'boom', 'A77', '{"insert":true}')`).run(productId).lastInsertRowid);

  // Park the retry inside its ownership call, as if Google were slow to answer.
  let release;
  cms.ownershipGate = new Promise((resolve) => { release = resolve; });
  resetCalls();
  const pending = call(controller.retryTrack, { params: { id: String(trackId) } });
  await waitFor(() => callsMatching("PUT", /\/assets\/A77\/ownership$/).length === 1);
  assert.equal(jobs.isTrackRunning(trackId), true);
  assert.equal(trackRow(trackId).status, "creating");

  const deliver = await call(controller.deliverProduct, { params: { id: String(productId) }, body: { track_ids: [trackId] } });
  assert.equal(deliver.statusCode, 409, JSON.stringify(deliver.body));
  assert.match(deliver.body.message, /being delivered right now/);
  const byDefault = await call(controller.deliverProduct, { params: { id: String(productId) }, body: {} });
  assert.equal(byDefault.statusCode, 400, JSON.stringify(byDefault.body));
  assert.equal(byDefault.body.message, "No tracks to deliver");
  const sync = await call(controller.syncTrack, { params: { id: String(trackId) } });
  assert.equal(sync.statusCode, 409, JSON.stringify(sync.body));
  const reference = await call(controller.deliverReference, { params: { id: String(trackId) }, body: {} });
  assert.equal(reference.statusCode, 409, JSON.stringify(reference.body));
  const again = await call(controller.retryTrack, { params: { id: String(trackId) } });
  assert.equal(again.statusCode, 409, JSON.stringify(again.body));
  assert.equal(callsMatching("POST", /\/assets$/).length, 0, "nothing else touched CMS");
  assert.equal(jobs.isRunning(productId), false);

  release();
  const finished = await pending;
  assert.equal(finished.statusCode, 200, JSON.stringify(finished.body));
  assert.equal(finished.body.track.status, "created");
  assert.equal(jobs.isTrackRunning(trackId), false);
  assert.equal(trackRow(trackId).status, "created");

  const removed = await call(controller.deleteProduct, { params: { id: String(productId) } });
  assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
});

test("uploadAudio stores the raw request body under the media dir with size and sha256", async () => {
  resetCalls();
  const json = await call(controller.uploadAudio, streamReq("{}", {
    params: { id: String(state.trackIds.two) },
    headers: { "content-type": "application/json" }
  }));
  assert.equal(json.statusCode, 415);

  const mismatch = await call(controller.uploadAudio, streamReq(AUDIO_TWO, {
    params: { id: String(state.trackIds.two) },
    query: { file_name: "02.wav", file_size: "999" }
  }));
  assert.equal(mismatch.statusCode, 400);
  assert.match(mismatch.body.message, /file_size/);

  const missing = await call(controller.uploadAudio, streamReq(AUDIO_TWO, { params: { id: "999" } }));
  assert.equal(missing.statusCode, 404);

  const res = await call(controller.uploadAudio, streamReq(AUDIO_TWO, {
    params: { id: String(state.trackIds.two) },
    query: { file_name: "../Song Two (mix).wav", file_size: String(AUDIO_TWO.length) }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { track } = res.body;
  assert.equal(track.has_audio, true);
  assert.equal(track.file_name, "_Song Two (mix).wav", "path separators and leading dots are stripped");
  assert.equal(track.file_size, AUDIO_TWO.length);
  assert.equal(track.file_mime, "audio/wav");
  assert.equal(track.file_sha256, sha256(AUDIO_TWO));
  assert.equal(track.file_path, `${state.productId}/${state.trackIds.two}___Song Two (mix).wav`);
  assert.ok(track.file_uploaded_at);
  assert.equal(track.status, "created", "storing audio never touches the CMS status");

  const absPath = path.join(MEDIA_DIR, String(state.productId), `${state.trackIds.two}___Song Two (mix).wav`);
  assert.ok(fs.existsSync(absPath), "file must exist on disk");
  assert.equal(sha256(fs.readFileSync(absPath)), sha256(AUDIO_TWO));
  assert.equal(fs.readdirSync(path.dirname(absPath)).some((name) => name.endsWith(".part")), false);
  assert.equal(calls.length, 0, "storing audio never calls Google");

  // Replacing the file removes the previous one for the same track.
  const replaced = await call(controller.uploadAudio, streamReq(AUDIO_TWO, {
    params: { id: String(state.trackIds.two) },
    query: { file_name: "02.wav" }
  }));
  assert.equal(replaced.statusCode, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.track.file_name, "02.wav");
  assert.deepEqual(fs.readdirSync(path.join(MEDIA_DIR, String(state.productId))), [`${state.trackIds.two}__02.wav`]);

  const events = eventActions(state.productId);
  assert.equal(events.filter((event) => event.action === "audio_upload" && event.status === "ok").length, 2);
});

test("getTrackAudio streams the stored file, honours Range requests and the download flag", async () => {
  const full = makeStreamRes();
  await controller.getTrackAudio({ params: { id: String(state.trackIds.two) }, query: {}, headers: {}, user: USER }, full);
  await full.finished;
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["content-type"], "audio/wav");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.headers["content-length"], String(AUDIO_TWO.length));
  assert.equal(full.headers["content-disposition"], "inline; filename=\"02.wav\"; filename*=UTF-8''02.wav");
  assert.equal(full.data().equals(AUDIO_TWO), true);

  const partial = makeStreamRes();
  await controller.getTrackAudio({ params: { id: String(state.trackIds.two) }, query: { download: "1" }, headers: { range: "bytes=5-9" }, user: USER }, partial);
  await partial.finished;
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.headers["content-range"], `bytes 5-9/${AUDIO_TWO.length}`);
  assert.equal(partial.headers["content-length"], "5");
  assert.match(partial.headers["content-disposition"], /^attachment; /);
  assert.equal(partial.data().equals(AUDIO_TWO.subarray(5, 10)), true);

  const tail = makeStreamRes();
  await controller.getTrackAudio({ params: { id: String(state.trackIds.two) }, query: {}, headers: { range: "bytes=-4" }, user: USER }, tail);
  await tail.finished;
  assert.equal(tail.statusCode, 206);
  assert.equal(tail.data().equals(AUDIO_TWO.subarray(AUDIO_TWO.length - 4)), true);

  const invalid = makeStreamRes();
  await controller.getTrackAudio({ params: { id: String(state.trackIds.two) }, query: {}, headers: { range: "bytes=999-" }, user: USER }, invalid);
  assert.equal(invalid.statusCode, 416);
  assert.equal(invalid.headers["content-range"], `bytes */${AUDIO_TWO.length}`);

  const none = await call(controller.getTrackAudio, { params: { id: String(state.trackIds.one) } });
  assert.equal(none.statusCode, 404);
});

test("deliverReference uploads the stored file as the reference and refuses a second live reference without force", async () => {
  resetCalls();
  const noAudio = await call(controller.deliverReference, { params: { id: String(state.trackIds.one) }, body: {} });
  assert.equal(noAudio.statusCode, 400);
  assert.match(noAudio.body.message, /No audio file is stored/);

  // The manual reference delivery is a background job (202), like a product delivery.
  const res = await call(controller.deliverReference, { params: { id: String(state.trackIds.two) }, body: { urgent: true } });
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.job.track_ids, [state.trackIds.two]);
  assert.ok(res.body.job.run_id);
  assert.equal(res.body.product.status, "delivering");
  assert.equal(res.body.track.status, "creating");
  const referenceJob = await jobs.waitForJob(state.productId);
  assert.deepEqual(referenceJob.summary, { created: 0, references: 1, duplicate: 0, error: 0 });

  const initiate = callsMatching("POST", /\/upload\/youtube\/partner\/v1\/references$/)[0];
  assert.ok(initiate, "resumable session must be initiated");
  assert.equal(initiate.params.uploadType, "resumable");
  assert.equal(initiate.headers["X-Upload-Content-Type"], "audio/wav");
  assert.equal(initiate.headers["X-Upload-Content-Length"], String(AUDIO_TWO.length));
  assert.deepEqual(initiate.data, { kind: "youtubePartner#reference", assetId: "A1", contentType: "audio", urgent: true });
  const upload = calls.find((item) => item.method === "PUT" && item.url === SESSION_URL);
  assert.ok(upload, "file bytes must be PUT to the session URL");
  assert.equal(typeof upload.data.pipe, "function");
  assert.equal(upload.headers["Content-Length"], String(AUDIO_TWO.length));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bytes, AUDIO_TWO.length);
  assert.equal(uploads[0].sha256, sha256(AUDIO_TWO), "the bytes sent to Google are the stored file");

  const delivered = (await getProduct(state.productId)).tracks.find((item) => item.id === state.trackIds.two);
  assert.equal(delivered.status, "completed");
  assert.equal(delivered.step, "reference");
  assert.equal(delivered.reference_id, "R1");
  assert.equal(delivered.reference_status, "checking");
  assert.equal(delivered.reference_content_type, "audio");
  assert.equal(delivered.steps.reference, true);
  assert.equal(delivered.has_audio, true);
  assert.equal(delivered.response.id, "R1");
  const referenceEvents = memoryDb.prepare("SELECT action, status, payload_json FROM content_id_delivery_events WHERE product_id = ? AND track_id = ? ORDER BY id DESC").all(state.productId, state.trackIds.two);
  const uploadedEvent = referenceEvents.find((event) => event.action === "reference_upload" && event.status === "ok");
  assert.ok(uploadedEvent, "the upload is logged");
  assert.equal(JSON.parse(uploadedEvent.payload_json).urgent, true);
  assert.equal(JSON.parse(uploadedEvent.payload_json).run_id, res.body.job.run_id);

  const product = memoryDb.prepare("SELECT * FROM content_id_delivery_products WHERE id = ?").get(state.productId);
  assert.equal(product.completed_count, 1);
  assert.equal(product.status, "delivered");

  resetCalls();
  const again = await call(controller.deliverReference, { params: { id: String(state.trackIds.two) }, body: {} });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.message, "A reference is already active for this asset");
  assert.equal(again.body.track.id, state.trackIds.two);
  assert.equal(calls.length, 0);

  cms.references.push({ id: "R1", assetId: "A1", status: "active", contentType: "audio", timeCreated: "2026-01-01T00:00:00Z" });
});

test("the delivery job uploads the stored audio as the reference for tracks that only miss the reference", async () => {
  const stored = await call(controller.uploadAudio, streamReq(AUDIO_ONE, {
    params: { id: String(state.trackIds.one) },
    query: { file_name: "01.flac" }
  }));
  assert.equal(stored.statusCode, 200, JSON.stringify(stored.body));
  assert.equal(stored.body.track.file_mime, "audio/wav", "the request MIME wins when it is an audio type");

  resetCalls();
  const res = await call(controller.deliverProduct, { params: { id: String(state.productId) }, body: {} });
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.job.track_ids, [state.trackIds.one], "only the track without a live reference is selected");

  const done = await jobs.waitForJob(state.productId);
  assert.deepEqual(done.summary, { created: 0, references: 1, duplicate: 0, error: 0 });
  assert.equal(callsMatching("POST", /\/assets$/).length, 0, "asset steps are skipped for a complete asset");
  assert.equal(callsMatching("GET", /\/assetSearch$/).length, 0);
  const initiate = callsMatching("POST", /\/upload\/youtube\/partner\/v1\/references$/)[0];
  assert.deepEqual(initiate.data, { kind: "youtubePartner#reference", assetId: "A2", contentType: "audio", urgent: false });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].sha256, sha256(AUDIO_ONE));
  assert.equal(uploads[0].contentLength, String(AUDIO_ONE.length));

  const product = await getProduct(state.productId);
  const trackOne = product.tracks.find((item) => item.id === state.trackIds.one);
  assert.equal(trackOne.status, "completed");
  assert.equal(trackOne.reference_id, "R2");
  assert.equal(trackOne.reference_status, "checking");
  assert.equal(product.status, "delivered");
  assert.equal(product.completed_count, 2);
  assert.deepEqual(product.events.slice(0, 2).map((event) => `${event.action}:${event.status}`).reverse(), ["reference_upload:ok", "deliver:ok"]);
  assert.equal(product.events[1].track_id, state.trackIds.one);
  assert.equal(product.events[1].track_title, "Song One");

  cms.references.push({ id: "R2", assetId: "A2", status: "active", contentType: "audio", timeCreated: "2026-01-02T00:00:00Z" });
});

test("a second deliver while the job runs answers 409 and the progress endpoint follows the job", async () => {
  const draft = await call(controller.createProduct, {
    body: {
      ...productPayload,
      product: { ...productPayload.product, title: "Album Three", upc: "" },
      tracks: [
        { client_id: "p1", title: "Progress One", isrc: "VNA122400020" },
        { client_id: "p2", title: "Progress Two", isrc: "VNA122400021" }
      ]
    }
  });
  assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
  const productId = draft.body.product.id;

  const first = await call(controller.deliverProduct, { params: { id: String(productId) }, body: { include_reference: false } });
  assert.equal(first.statusCode, 202, JSON.stringify(first.body));
  assert.equal(first.body.product.include_reference, false, "an explicit include_reference is stored on the product");

  const second = await call(controller.deliverProduct, { params: { id: String(productId) }, body: {} });
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.message, "Delivery is already running for this product");
  const retry = await call(controller.retryTrack, { params: { id: String(draft.body.product.tracks[0].id) } });
  assert.equal(retry.statusCode, 409);
  const reference = await call(controller.deliverReference, { params: { id: String(draft.body.product.tracks[0].id) }, body: {} });
  assert.equal(reference.statusCode, 400, "no asset yet, so the reference guard comes first");
  const removal = await call(controller.deleteProduct, { params: { id: String(productId) } });
  assert.equal(removal.statusCode, 409);

  const running = await call(controller.getProductProgress, { params: { id: String(productId) } });
  assert.equal(running.statusCode, 200);
  assert.equal(running.body.job.running, true);
  assert.equal(running.body.product.status, "delivering");
  assert.equal(running.body.product.track_count, 2);
  assert.equal(running.body.product.delivered_count, 0);
  assert.ok(running.body.product.job_started_at);
  assert.equal(running.body.product.job_finished_at, null);
  assert.deepEqual(Object.keys(running.body.tracks[0]).sort(), [
    "asset_id", "error_message", "file_name", "file_size", "has_audio", "id", "reference_id", "reference_status", "status", "step", "title", "track_number"
  ]);
  assert.equal(running.body.tracks[0].status, "creating");
  assert.equal(running.body.tracks[0].has_audio, false);
  assert.equal(Object.hasOwn(running.body.product, "artwork_data_url"), false);

  const done = await jobs.waitForJob(productId);
  assert.deepEqual(done.summary, { created: 2, references: 0, duplicate: 0, error: 0 });

  const finished = await call(controller.getProductProgress, { params: { id: String(productId) } });
  assert.equal(finished.body.job.running, false);
  assert.equal(finished.body.product.status, "delivered");
  assert.equal(finished.body.product.delivered_count, 2);
  assert.equal(finished.body.product.completed_count, 0);
  assert.ok(finished.body.product.job_finished_at);
  finished.body.tracks.forEach((track) => {
    assert.equal(track.status, "created");
    assert.match(track.asset_id, /^A\d+$/);
  });

  const missing = await call(controller.getProductProgress, { params: { id: "999" } });
  assert.equal(missing.statusCode, 404);

  const removed = await call(controller.deleteProduct, { params: { id: String(productId) } });
  assert.equal(removed.statusCode, 200);
});

test("an unexpected job failure marks the queued tracks as errors instead of leaving them in flight", async () => {
  const draft = await call(controller.createProduct, {
    body: {
      ...productPayload,
      product: { ...productPayload.product, title: "Album Crash", upc: "" },
      tracks: [{ client_id: "k1", title: "Crash", isrc: "VNA122400030" }]
    }
  });
  assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
  const productId = draft.body.product.id;
  const trackId = draft.body.product.tracks[0].id;

  const original = service.mapWithConcurrency;
  service.mapWithConcurrency = async () => {
    throw new Error("boom");
  };
  let done;
  try {
    const res = await call(controller.deliverProduct, { params: { id: String(productId) }, body: {} });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    done = await jobs.waitForJob(productId);
  } finally {
    service.mapWithConcurrency = original;
  }
  assert.equal(done.failed, true);
  assert.equal(jobs.isRunning(productId), false);

  const product = await getProduct(productId);
  assert.equal(product.status, "error");
  assert.match(product.error_message, /^Delivery job failed: boom/);
  assert.ok(product.job_finished_at);
  assert.deepEqual(product.job, { running: false, started_at: null });
  assert.equal(product.tracks[0].status, "error");
  assert.equal(product.tracks[0].step, "deliver");
  assert.match(product.tracks[0].error_message, /^Delivery job failed: boom/);
  assert.deepEqual(eventActions(productId).pop(), { action: "deliver", status: "error" });

  // The track is deliverable again once the cause is gone.
  resetCalls();
  const again = await call(controller.deliverProduct, { params: { id: String(productId) }, body: {} });
  assert.equal(again.statusCode, 202, JSON.stringify(again.body));
  assert.deepEqual(again.body.job.track_ids, [trackId]);
  const recovered = await jobs.waitForJob(productId);
  assert.deepEqual(recovered.summary, { created: 1, references: 0, duplicate: 0, error: 0 });
  assert.equal((await getProduct(productId)).status, "delivered");

  const removed = await call(controller.deleteProduct, { params: { id: String(productId) } });
  assert.equal(removed.statusCode, 200);
});

test("tracks stuck in creating/uploading by an interrupted run are deliverable again", async () => {
  memoryDb.prepare("UPDATE content_id_delivery_tracks SET status = 'uploading', step = 'reference' WHERE id = ?").run(state.trackIds.one);
  memoryDb.prepare("UPDATE content_id_delivery_products SET status = 'delivering' WHERE id = ?").run(state.productId);

  // recomputeProduct counts the stuck track as not delivered instead of collapsing to draft.
  controller.recomputeProduct(state.productId, { finalize: true });
  let row = memoryDb.prepare("SELECT status, delivered_count FROM content_id_delivery_products WHERE id = ?").get(state.productId);
  assert.equal(row.status, "partial");
  assert.equal(row.delivered_count, 1);

  resetCalls();
  const res = await call(controller.deliverProduct, { params: { id: String(state.productId) }, body: {} });
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.job.track_ids, [state.trackIds.one]);
  const done = await jobs.waitForJob(state.productId);
  assert.deepEqual(done.summary, { created: 0, references: 0, duplicate: 0, error: 0 });
  assert.equal(uploads.length, 0, "the track already has a live reference");

  const product = await getProduct(state.productId);
  const trackOne = product.tracks.find((item) => item.id === state.trackIds.one);
  assert.equal(trackOne.status, "completed");
  assert.equal(product.status, "delivered");
  row = memoryDb.prepare("SELECT delivered_count FROM content_id_delivery_products WHERE id = ?").get(state.productId);
  assert.equal(row.delivered_count, 2);
});

test("sync refuses the track a running job works on and a product sync skips it", async () => {
  // Track one only misses its reference again; the job is parked inside the reference upload so
  // the in-flight state is observable deterministically.
  memoryDb.prepare("UPDATE content_id_delivery_tracks SET status = 'created', reference_id = NULL, reference_status = NULL WHERE id = ?").run(state.trackIds.one);
  let release;
  const parked = new Promise((resolve) => {
    release = resolve;
  });
  const original = service.uploadReferenceStream;
  service.uploadReferenceStream = async () => {
    await parked;
    return { id: "R3", assetId: "A2", status: "checking", contentType: "audio", length: 12 };
  };

  try {
    resetCalls();
    const res = await call(controller.deliverProduct, { params: { id: String(state.productId) }, body: {} });
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body.job.track_ids, [state.trackIds.one]);
    // Let the job reach the parked upload.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(trackRow(state.trackIds.one).status, "uploading");

    const single = await call(controller.syncTrack, { params: { id: String(state.trackIds.one) } });
    assert.equal(single.statusCode, 409);
    assert.equal(single.body.message, "Delivery is already running for this product");
    assert.equal(single.body.track.status, "uploading");

    const whole = await call(controller.syncProduct, { params: { id: String(state.productId) } });
    assert.equal(whole.statusCode, 200, JSON.stringify(whole.body));
    assert.deepEqual(whole.body.errors, []);
    assert.deepEqual(callsMatching("GET", /\/assets\/A\d+$/).map((item) => item.url.split("/").pop()), ["A1"], "only the finished track is reconciled");
    assert.equal(whole.body.product.status, "delivering", "a running job is never finalized by a sync");
    assert.equal(whole.body.product.tracks.find((item) => item.id === state.trackIds.one).status, "uploading");

    release();
    const done = await jobs.waitForJob(state.productId);
    assert.deepEqual(done.summary, { created: 0, references: 1, duplicate: 0, error: 0 });
  } finally {
    service.uploadReferenceStream = original;
  }

  const product = await getProduct(state.productId);
  const trackOne = product.tracks.find((item) => item.id === state.trackIds.one);
  assert.equal(trackOne.status, "completed");
  assert.equal(trackOne.reference_id, "R3");
  assert.equal(product.status, "delivered");
});

test("syncTrack refreshes asset and reference status from CMS", async () => {
  resetCalls();
  const res = await call(controller.syncTrack, { params: { id: String(state.trackIds.two) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  assert.equal(callsMatching("GET", /\/assets\/A1$/).length, 1);
  assert.equal(callsMatching("GET", /\/references$/).length, 1);
  assert.equal(res.body.track.status, "completed");
  assert.equal(res.body.track.asset_status, "active");
  assert.equal(res.body.track.reference_id, "R1");
  assert.equal(res.body.track.reference_status, "active");
  assert.equal(res.body.track.cms.asset.id, "A1");
  assert.equal(res.body.track.cms.references.length, 1);
  assert.ok(res.body.track.last_synced_at);
  assert.equal(res.body.product.completed_count, 2);

  const noAsset = await call(controller.syncProduct, { params: { id: String(state.productId) } });
  assert.equal(noAsset.statusCode, 200);
  assert.deepEqual(noAsset.body.errors, []);
  assert.ok(noAsset.body.product.last_synced_at);
});

test("syncProduct finalizes a product left in delivering by an interrupted run", async () => {
  memoryDb.prepare("UPDATE content_id_delivery_products SET status = 'delivering' WHERE id = ?").run(state.productId);
  const res = await call(controller.syncProduct, { params: { id: String(state.productId) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.errors, []);
  assert.equal(res.body.product.status, "delivered");
  assert.equal(res.body.product.delivered_count, 2);
});

test("any mutation finalizes a product left in delivering when no job is running", async () => {
  memoryDb.prepare("UPDATE content_id_delivery_products SET status = 'delivering' WHERE id = ?").run(state.productId);
  const res = await call(controller.syncTrack, { params: { id: String(state.trackIds.two) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.product.status, "delivered");
});

test("updateProduct with apply_to_cms patches every delivered asset with the new album data", async () => {
  resetCalls();
  const res = await call(controller.updateProduct, {
    params: { id: String(state.productId) },
    body: { product: { title: "Album One (Deluxe)", release_date: "2024-06-01" }, apply_to_cms: true }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.errors, []);
  assert.equal(res.body.product.title, "Album One (Deluxe)");
  assert.equal(res.body.product.release_date, "2024-06-01");
  assert.equal(res.body.product.upc, "0123456789012");

  const patches = callsMatching("PATCH", /\/assets\/A[12]$/);
  assert.equal(patches.length, 2);
  patches.forEach((patch) => {
    assert.equal(patch.data.metadataMine.album, "Album One (Deluxe)");
    assert.deepEqual(patch.data.metadataMine.releaseDate, { year: 2024, month: 6, day: 1 });
    assert.equal(Object.hasOwn(patch.data, "label"), false);
  });
  const trackTwo = res.body.product.tracks.find((item) => item.id === state.trackIds.two);
  assert.equal(trackTwo.metadata.album, "Album One (Deluxe)");

  const invalid = await call(controller.updateProduct, { params: { id: String(state.productId) }, body: { product: { upc: "bad!" } } });
  assert.equal(invalid.statusCode, 400);
  assert.ok(invalid.body.field_errors.upc);
});

test("updateTrack validates the ISRC and applies metadata + labels to CMS", async () => {
  resetCalls();
  const clash = await call(controller.updateTrack, {
    params: { id: String(state.trackIds.two) },
    body: { track: { isrc: "VNA122400001" } }
  });
  assert.equal(clash.statusCode, 400);
  assert.match(clash.body.field_errors.isrc, /another track/);

  const res = await call(controller.updateTrack, {
    params: { id: String(state.trackIds.two) },
    body: { track: { title: "Song Two (Remaster)", asset_labels: [] }, apply_to_cms: true }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.track.title, "Song Two (Remaster)");
  assert.equal(res.body.track.asset_labels, null);
  assert.equal(res.body.track.metadata.title, "Song Two (Remaster)");

  const patches = callsMatching("PATCH", /\/assets\/A1$/);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].data.metadataMine.title, "Song Two (Remaster)");
  assert.deepEqual(patches[1].data, { label: ["ANS", "Pop"] });
});

test("updateRights pushes ownership, policy and labels to the delivered assets", async () => {
  resetCalls();
  const res = await call(controller.updateRights, {
    params: { id: String(state.productId) },
    body: {
      ownership: { mode: "include", territories: ["vn", "US"] },
      match_policy_id: "policy-2",
      match_policy_name: "Track in all countries",
      asset_labels: ["ANS", "Remaster"]
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.errors, []);
  assert.deepEqual(res.body.product.ownership, { mode: "include", territories: ["VN", "US"] });
  assert.equal(res.body.product.match_policy_id, "policy-2");
  assert.deepEqual(res.body.product.asset_labels, ["ANS", "Remaster"]);

  const ownershipCalls = callsMatching("PUT", /\/ownership$/);
  assert.equal(ownershipCalls.length, 2);
  assert.deepEqual(ownershipCalls[0].data.general, [{ ratio: 100, owner: "OWNER_123", type: "include", territories: ["VN", "US"] }]);
  const policyCalls = callsMatching("PUT", /\/matchPolicy$/);
  assert.equal(policyCalls.length, 2);
  assert.deepEqual(policyCalls[0].data, { kind: "youtubePartner#assetMatchPolicy", policyId: "policy-2" });
  const labelCalls = callsMatching("PATCH", /\/assets\/A[12]$/);
  assert.equal(labelCalls.length, 2);
  assert.deepEqual(labelCalls[0].data, { label: ["ANS", "Remaster"] });

  res.body.product.tracks.forEach((track) => {
    assert.equal(track.match_policy_id, "policy-2");
    assert.equal(track.ownership.general[0].type, "include");
    assert.equal(track.asset_labels, null);
  });

  const invalid = await call(controller.updateRights, { params: { id: String(state.productId) }, body: { ownership: { mode: "include", territories: [] } } });
  assert.equal(invalid.statusCode, 400);
  const empty = await call(controller.updateRights, { params: { id: String(state.productId) }, body: {} });
  assert.equal(empty.statusCode, 400);
});

test("updateRights re-sends a match policy update whose answer timed out and logs both attempts", async () => {
  resetCalls();
  cms.timeoutMatchPolicyOnce = true;
  const res = await call(controller.updateRights, {
    params: { id: String(state.productId) },
    body: { match_policy_id: "policy-3", match_policy_name: "Block in all countries" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.errors, [], "the timed-out PUT is retried instead of failing the track");
  assert.equal(res.body.product.match_policy_id, "policy-3");
  res.body.product.tracks.forEach((track) => assert.equal(track.match_policy_id, "policy-3"));

  const policyCalls = callsMatching("PUT", /\/matchPolicy$/);
  assert.equal(policyCalls.length, 3, "two assets, one of them asked twice");
  assert.deepEqual(policyCalls.map((item) => item.timeout).sort((left, right) => left - right), [30000, 30000, 60000]);
  assert.equal(callsMatching("PUT", /\/ownership$/).length, 0);

  const rightsEvent = memoryDb.prepare("SELECT payload_json FROM content_id_delivery_events WHERE product_id = ? AND action = 'rights_update' ORDER BY id DESC")
    .get(state.productId);
  const runId = JSON.parse(rightsEvent.payload_json).run_id;
  const api = memoryDb.prepare("SELECT message, status, payload_json FROM content_id_delivery_events WHERE product_id = ? AND action = 'api' ORDER BY id ASC")
    .all(state.productId)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }))
    .filter((row) => row.payload.run_id === runId);
  const failed = api.find((row) => row.payload.phase === "failed");
  assert.match(failed.message, /^PUT \/youtube\/partner\/v1\/assets\/A[12]\/matchPolicy: Google Content ID did not respond within 30 s$/);
  assert.equal(failed.status, "error");
  assert.equal(failed.payload.step, "rights");
  assert.equal(failed.payload.http_status, null);
  assert.ok(api.some((row) => row.payload.phase === "retry" && row.payload.attempt === 1));
  assert.ok(api.some((row) => row.payload.phase === "completed" && row.payload.attempt === 2 && row.payload.timeout_ms === 60000));
});

test("updateRights reports a match policy update that never got an answer per track and keeps the ownership checkpoint", async () => {
  resetCalls();
  cms.timeoutMatchPolicy = true;
  let res;
  try {
    res = await call(controller.updateRights, {
      params: { id: String(state.productId) },
      body: { ownership: { mode: "worldwide", territories: [] }, match_policy_id: "policy-4", match_policy_name: "Track in all countries" }
    });
  } finally {
    cms.timeoutMatchPolicy = false;
  }
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.errors.length, 2);
  assert.deepEqual(res.body.errors.map((item) => item.track_id).sort((left, right) => left - right), Object.values(state.trackIds).sort((left, right) => left - right));
  res.body.errors.forEach((item) => assert.match(item.message,
    /^Google Content ID did not respond within 60 s \(PUT \/youtube\/partner\/v1\/assets\/A[12]\/matchPolicy, 2 attempts\)$/));
  assert.equal(callsMatching("PUT", /\/ownership$/).length, 2, "ownership was applied before the policy call");
  const policyCalls = callsMatching("PUT", /\/matchPolicy$/);
  assert.equal(policyCalls.length, 4, "two silent attempts per asset, then the call gives up");
  assert.deepEqual(policyCalls.map((item) => item.timeout).sort((left, right) => left - right), [30000, 30000, 60000, 60000]);

  // The product row carries the requested policy, the tracks keep the one CMS still has, and
  // the ownership step is checkpointed.
  assert.equal(res.body.product.match_policy_id, "policy-4");
  res.body.product.tracks.forEach((track) => {
    assert.equal(track.match_policy_id, "policy-3");
    assert.equal(track.ownership.general[0].type, "exclude");
  });
  const stored = memoryDb.prepare("SELECT status, payload_json FROM content_id_delivery_events WHERE product_id = ? AND action = 'rights_update' ORDER BY id DESC").get(state.productId);
  assert.equal(stored.status, "error");
  assert.deepEqual(JSON.parse(stored.payload_json).errors, res.body.errors);

  // Once CMS answers again the same update converges.
  resetCalls();
  const again = await call(controller.updateRights, {
    params: { id: String(state.productId) },
    body: { match_policy_id: "policy-4", match_policy_name: "Track in all countries" }
  });
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.errors, []);
  again.body.product.tracks.forEach((track) => assert.equal(track.match_policy_id, "policy-4"));
});

test("a repeated Google API 401 returns 424 and the network works again when Google recovers", async () => {
  resetCalls();
  cms.authFail = true;
  try {
    const res = await call(controller.checkDuplicates, { body: { network_id: 7, isrcs: ["VNA122400002"] } });
    assert.equal(res.statusCode, 424);
    assert.equal(res.body.message, "CMS authorization failed: Invalid Credentials.");
    assert.equal(calls.length, 2, "a rejected access token is refreshed once");
    assert.deepEqual(networkRow(), { cms_auth_status: "connected", cms_auth_error: null });
    assert.doesNotMatch(JSON.stringify(res.body), /fresh-token/);

    const sync = await call(controller.syncTrack, { params: { id: String(state.trackIds.two) } });
    assert.equal(sync.statusCode, 424);
    assert.match(sync.body.track.error_message, /^CMS authorization failed: /);
    assert.equal(networkRow().cms_auth_status, "connected");
  } finally {
    cms.authFail = false;
  }
  const recovered = await call(controller.syncTrack, { params: { id: String(state.trackIds.two) } });
  assert.equal(recovered.statusCode, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.track.error_message, null);
});

test("takedownProduct deactivates references with releaseClaims and keeps going after a claim failure", async () => {
  resetCalls();
  cms.claims = [
    { id: "C1", assetId: "A1", videoId: "AAAAAAAAAAA", status: "active", contentType: "audio" },
    { id: "C2", assetId: "A1", videoId: "BBBBBBBBBBB", status: "inactive", contentType: "audio" },
    { id: "C3", assetId: "A1", videoId: "CCCCCCCCCCC", status: "active", contentType: "audio" },
    { id: "C4", assetId: "A1", videoId: "DDDDDDDDDDD", status: "pending", contentType: "audio" }
  ];
  cms.failClaimPatch = "C3";

  const res = await call(controller.takedownProduct, {
    params: { id: String(state.productId) },
    body: { release_claims: true, reason: "Rights expired" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const referencePatches = callsMatching("PATCH", /\/references\/R[12]$/);
  assert.equal(referencePatches.length, 2);
  referencePatches.forEach((patch) => {
    assert.deepEqual(patch.data, { status: "inactive" });
    assert.equal(patch.params.releaseClaims, true);
  });
  assert.equal(callsMatching("GET", /\/claimSearch$/).length, 2);
  const claimPatches = callsMatching("PATCH", /\/claims\/C\d$/);
  assert.deepEqual(claimPatches.map((patch) => patch.url.split("/").pop()), ["C1", "C3", "C4"], "every releasable claim is attempted");

  const byTrack = Object.fromEntries(res.body.results.map((item) => [item.track_id, item]));
  const two = byTrack[state.trackIds.two];
  assert.equal(two.references_deactivated, 1);
  assert.equal(two.claims_released, 2);
  assert.equal(two.errors.length, 1);
  assert.equal(two.errors[0].claim_id, "C3");
  assert.match(two.error, /Claim C3: Claim is already inactive/);
  assert.deepEqual(byTrack[state.trackIds.one], { track_id: state.trackIds.one, references_deactivated: 1, claims_released: 0, error: "", errors: [] });

  res.body.product.tracks.forEach((track) => assert.equal(track.status, "taken_down"));
  const trackTwo = res.body.product.tracks.find((item) => item.id === state.trackIds.two);
  assert.equal(trackTwo.reference_status, "inactive");
  assert.match(trackTwo.error_message, /Claim C3/);
  const trackOne = res.body.product.tracks.find((item) => item.id === state.trackIds.one);
  assert.equal(trackOne.error_message, null);
  assert.equal(res.body.product.status, "taken_down");

  const events = eventActions(state.productId);
  const takedown = events[events.length - 1];
  assert.equal(takedown.action, "takedown");
  assert.equal(takedown.status, "error");
  const stored = memoryDb.prepare("SELECT message, payload_json FROM content_id_delivery_events WHERE product_id = ? AND action = 'takedown' ORDER BY id DESC").get(state.productId);
  assert.match(stored.message, /Rights expired/);
  assert.equal(JSON.parse(stored.payload_json).reason, "Rights expired");
  cms.failClaimPatch = null;
});

test("sync keeps a taken-down track taken down while its reference is deactivating and a retried takedown does not re-patch", async () => {
  resetCalls();
  const ref = cms.references.find((item) => item.id === "R1");
  ref.status = "deactivating";

  let res = await call(controller.syncTrack, { params: { id: String(state.trackIds.two) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.track.status, "taken_down");
  assert.equal(res.body.track.reference_status, "deactivating");
  assert.equal(res.body.product.status, "taken_down");

  resetCalls();
  res = await call(controller.takedownTrack, { params: { id: String(state.trackIds.two) }, body: { release_claims: false } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(callsMatching("PATCH", /\/references\/R1$/).length, 0);
  assert.equal(res.body.results[0].references_deactivated, 0);
  assert.equal(res.body.track.status, "taken_down");

  // Reactivating while Google is still deactivating cannot succeed yet: the takedown marker
  // survives and the user is told to try again later.
  resetCalls();
  const early = await call(controller.reactivateTrack, { params: { id: String(state.trackIds.two) }, body: {} });
  assert.equal(early.statusCode, 200, JSON.stringify(early.body));
  assert.match(early.body.results[0].error, /Reference R1 is still being deactivated by Google/);
  assert.equal(early.body.results[0].references_activated, 0);
  assert.equal(callsMatching("PATCH", /\/references\//).length, 0);
  assert.equal(early.body.track.status, "taken_down");
  assert.match(early.body.track.error_message, /still being deactivated/);
  assert.equal(early.body.product.status, "taken_down");

  ref.status = "inactive";
  res = await call(controller.syncTrack, { params: { id: String(state.trackIds.two) } });
  assert.equal(res.body.track.status, "taken_down");
  assert.equal(res.body.track.reference_status, "inactive");
  assert.equal(res.body.product.status, "taken_down");
});

test("a failed reference deactivation leaves the track in error at the takedown step", async () => {
  resetCalls();
  const ref = cms.references.find((item) => item.id === "R2");
  ref.status = "active";
  cms.failReferencePatch = "R2";

  const failed = await call(controller.takedownTrack, { params: { id: String(state.trackIds.one) }, body: { release_claims: false } });
  assert.equal(failed.statusCode, 200, JSON.stringify(failed.body));
  assert.equal(callsMatching("PATCH", /\/references\/R2$/).length, 3, "a 5xx on the idempotent status PATCH is retried up to the attempt limit");
  assert.equal(failed.body.results[0].references_deactivated, 0);
  assert.match(failed.body.results[0].error, /Reference R2: Backend Error/);
  assert.equal(failed.body.track.status, "error");
  assert.equal(failed.body.track.step, "takedown");
  assert.match(failed.body.track.error_message, /Backend Error/);
  assert.equal(failed.body.product.status, "partial");

  cms.failReferencePatch = null;
  const retried = await call(controller.takedownTrack, { params: { id: String(state.trackIds.one) }, body: { release_claims: false } });
  assert.equal(retried.statusCode, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.track.status, "taken_down");
  assert.equal(retried.body.track.error_message, null);
  assert.equal(retried.body.product.status, "taken_down");
  assert.equal(ref.status, "inactive");
});

test("reactivateProduct re-enables inactive references without releasing claims", async () => {
  resetCalls();
  const res = await call(controller.reactivateProduct, { params: { id: String(state.productId) }, body: {} });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const referencePatches = callsMatching("PATCH", /\/references\/R[12]$/);
  assert.equal(referencePatches.length, 2);
  referencePatches.forEach((patch) => {
    assert.deepEqual(patch.data, { status: "active" });
    assert.equal(Object.hasOwn(patch.params, "releaseClaims"), false);
  });
  assert.equal(callsMatching("PATCH", /\/claims\//).length, 0);

  const trackTwo = res.body.product.tracks.find((item) => item.id === state.trackIds.two);
  const trackOne = res.body.product.tracks.find((item) => item.id === state.trackIds.one);
  assert.equal(trackTwo.status, "completed");
  assert.equal(trackTwo.reference_status, "active");
  assert.equal(trackOne.status, "completed");
  assert.equal(trackOne.reference_status, "active");
  assert.equal(res.body.product.status, "delivered");
  assert.equal(res.body.product.completed_count, 2);
});

test("single-track takedown and reactivate, claims listing and reference-from-claim", async () => {
  resetCalls();
  const takedown = await call(controller.takedownTrack, { params: { id: String(state.trackIds.two) }, body: { release_claims: false } });
  assert.equal(takedown.statusCode, 200, JSON.stringify(takedown.body));
  assert.equal(takedown.body.track.status, "taken_down");
  assert.equal(callsMatching("PATCH", /\/references\/R1$/)[0].params.releaseClaims, undefined);
  assert.equal(callsMatching("GET", /\/claimSearch$/).length, 0);
  assert.equal(takedown.body.product.status, "delivered");

  const reactivate = await call(controller.reactivateTrack, { params: { id: String(state.trackIds.two) }, body: {} });
  assert.equal(reactivate.statusCode, 200, JSON.stringify(reactivate.body));
  assert.equal(reactivate.body.track.status, "completed");

  const claims = await call(controller.listTrackClaims, { params: { id: String(state.trackIds.two) } });
  assert.equal(claims.statusCode, 200);
  assert.deepEqual(claims.body.claims.map((claim) => [claim.claim_id, claim.status]), [["C1", "inactive"], ["C2", "inactive"], ["C3", "active"], ["C4", "inactive"]]);

  const fromClaim = await call(controller.referenceFromClaim, {
    params: { id: String(state.trackIds.one) },
    body: { claim_id: "C7", content_type: "audio" }
  });
  assert.equal(fromClaim.statusCode, 200, JSON.stringify(fromClaim.body));
  assert.equal(fromClaim.body.reference.id, "R9");
  assert.equal(fromClaim.body.track.status, "completed");
  assert.equal(fromClaim.body.track.reference_id, "R9");
  const claimCall = callsMatching("POST", /\/references$/).find((item) => item.params.claimId === "C7");
  assert.equal(claimCall.data.assetId, "A2");
});

test("a status PATCH refused because the status is already set is confirmed by reading the resource back", async () => {
  const ref = cms.references.find((item) => item.id === "R1");
  assert.equal(ref.status, "active");

  // Google refuses but the reference really is still active: the takedown reports the refusal.
  resetCalls();
  cms.refuseReferencePatch = { id: "R1", thenStatus: "active" };
  const refused = await call(controller.takedownTrack, { params: { id: String(state.trackIds.two) }, body: { release_claims: false } });
  assert.equal(refused.statusCode, 200, JSON.stringify(refused.body));
  assert.equal(callsMatching("GET", /\/references\/R1$/).length, 1, "the refusal is checked against the live state");
  assert.equal(refused.body.results[0].references_deactivated, 0);
  assert.match(refused.body.results[0].error, /Reference R1: The reference has already been deactivated/);
  assert.equal(refused.body.track.status, "error");

  // Google refuses because the first attempt had been applied (its answer was lost): the
  // read-back shows the wanted state, so the takedown and the claim release count as done.
  resetCalls();
  cms.refuseReferencePatch = { id: "R1", thenStatus: "inactive" };
  cms.refuseClaimPatch = { id: "C3", thenStatus: "inactive" };
  const settled = await call(controller.takedownTrack, { params: { id: String(state.trackIds.two) }, body: { release_claims: true } });
  assert.equal(settled.statusCode, 200, JSON.stringify(settled.body));
  assert.deepEqual(settled.body.results[0], { track_id: state.trackIds.two, references_deactivated: 1, claims_released: 1, error: "", errors: [] });
  assert.equal(callsMatching("GET", /\/references\/R1$/).length, 1);
  assert.equal(callsMatching("GET", /\/claims\/C3$/).length, 1);
  assert.equal(settled.body.track.status, "taken_down");
  assert.equal(settled.body.track.error_message, null);
  assert.equal(cms.claims.find((item) => item.id === "C3").status, "inactive");

  const reactivated = await call(controller.reactivateTrack, { params: { id: String(state.trackIds.two) }, body: {} });
  assert.equal(reactivated.statusCode, 200, JSON.stringify(reactivated.body));
  assert.equal(reactivated.body.track.status, "completed");
  assert.equal(ref.status, "active");
});

test("an explicit empty track_ids list is rejected for takedown and reactivate", async () => {
  resetCalls();
  const takedown = await call(controller.takedownProduct, { params: { id: String(state.productId) }, body: { track_ids: [] } });
  assert.equal(takedown.statusCode, 400);
  assert.equal(takedown.body.message, "Select at least one track");
  const reactivate = await call(controller.reactivateProduct, { params: { id: String(state.productId) }, body: { track_ids: [] } });
  assert.equal(reactivate.statusCode, 400);
  assert.equal(reactivate.body.message, "Select at least one track");
  assert.equal(calls.length, 0);
});

test("deleteTrackAudio removes the file and clears the file columns but keeps the reference", async () => {
  const res = await call(controller.deleteTrackAudio, { params: { id: String(state.trackIds.one) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.track.has_audio, false);
  assert.equal(res.body.track.file_path, null);
  assert.equal(res.body.track.file_name, null);
  assert.equal(res.body.track.file_size, null);
  assert.equal(res.body.track.file_sha256, null);
  assert.equal(res.body.track.reference_id, "R9");
  assert.equal(res.body.track.status, "completed");
  assert.deepEqual(fs.readdirSync(path.join(MEDIA_DIR, String(state.productId))), [`${state.trackIds.two}__02.wav`]);
  assert.equal(eventActions(state.productId).pop().action, "audio_delete");
});

test("listProducts filters, searches by ISRC / asset id and returns the summary with audio counts", async () => {
  const all = await call(controller.listProducts, { query: { network_id: "7" } });
  assert.equal(all.statusCode, 200);
  assert.equal(all.body.total, 1);
  assert.equal(all.body.page, 1);
  assert.equal(all.body.page_size, 20);
  assert.equal(all.body.products[0].title, "Album One (Deluxe)");
  assert.equal(all.body.products[0].artwork_data_url, "data:image/jpeg;base64,/9j/4AAQ");
  assert.equal(all.body.products[0].audio_count, 1);
  assert.equal(all.body.products[0].job_running, false);
  assert.equal(Object.hasOwn(all.body.products[0], "tracks"), false);
  assert.deepEqual(all.body.summary, { products: 1, tracks: 2, delivered: 2, completed: 2, errors: 0, taken_down: 0 });

  const byIsrc = await call(controller.listProducts, { query: { search: "VNA122400002", page_size: "50" } });
  assert.equal(byIsrc.body.total, 1);
  assert.equal(byIsrc.body.page_size, 50);
  const byAsset = await call(controller.listProducts, { query: { search: "A2" } });
  assert.equal(byAsset.body.total, 1);
  const none = await call(controller.listProducts, { query: { status: "draft" } });
  assert.equal(none.body.total, 0);
  const otherNetwork = await call(controller.listProducts, { query: { network_id: "8" } });
  assert.equal(otherNetwork.body.total, 0);
  assert.equal(otherNetwork.body.summary.products, 0);

  const detail = await call(controller.getProduct, { params: { id: String(state.productId) } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.product.tracks.length, 2);
  assert.deepEqual(detail.body.product.job, { running: false, started_at: null });
  assert.deepEqual(detail.body.product.tracks.map((track) => track.has_audio), [false, true]);
  assert.ok(detail.body.product.events.length >= 8);
  assert.equal(detail.body.product.events[0].created_by_name, "Tester");
  const missing = await call(controller.getProduct, { params: { id: "999" } });
  assert.equal(missing.statusCode, 404);
});

test("deleteProduct removes the local rows and media, keeps codes of delivered products and never touches codes for drafts", async () => {
  const mediaDir = path.join(MEDIA_DIR, String(state.productId));
  assert.ok(fs.existsSync(mediaDir));

  const removed = await call(controller.deleteProduct, { params: { id: String(state.productId) } });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.body, { success: true });
  assert.equal(memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_products").get().count, 0);
  assert.equal(memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_tracks").get().count, 0);
  assert.equal(memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_events").get().count, 0);
  assert.equal(fs.existsSync(mediaDir), false, "the media folder of the product is removed");
  assert.equal(codeRow("VNA122400002").status, "used");
  assert.equal(codeRow("0123456789012").status, "used");
  assert.equal(calls.some((item) => item.method === "DELETE"), false);

  // A draft never marked any code, so deleting it must not flip codes backing live CMS assets.
  memoryDb.prepare("INSERT INTO content_id_codes (type, code, status) VALUES ('ISRC', 'VNA122400099', 'reserved')").run();
  const draft = await call(controller.createProduct, {
    body: {
      ...productPayload,
      tracks: [
        { client_id: "d1", title: "Draft song", isrc: "VNA122400002" },
        { client_id: "d2", title: "Draft song two", isrc: "VNA122400099" }
      ]
    }
  });
  assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
  assert.equal(codeRow("VNA122400002").status, "used");
  const removedDraft = await call(controller.deleteProduct, { params: { id: String(draft.body.product.id) } });
  assert.equal(removedDraft.statusCode, 200);
  assert.equal(codeRow("VNA122400002").status, "used");
  assert.equal(codeRow("VNA122400002").album_title, "Album One");
  assert.equal(codeRow("0123456789012").status, "used");
  assert.equal(codeRow("VNA122400099").status, "reserved");

  const gone = await call(controller.deleteProduct, { params: { id: String(state.productId) } });
  assert.equal(gone.statusCode, 404);
  assert.equal(trackRow(state.trackIds.one), undefined);
});
