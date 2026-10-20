// Video delivery through the same pipeline: web / music_video assets with an audiovisual
// reference, the file removed from the server once the reference is live.
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

const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cid-delivery-video-"));
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

// v5 columns: in the CREATE TABLE for fresh installs and as guarded ALTERs for existing databases.
assert.ok(memoryDb.prepare("PRAGMA table_info(content_id_delivery_products)").all().some((item) => item.name === "asset_type"));
["description", "source_url"].forEach((column) => {
  assert.ok(memoryDb.prepare("PRAGMA table_info(content_id_delivery_tracks)").all().some((item) => item.name === column), `tracks.${column}`);
  assert.match(databaseSource, new RegExp(`ALTER TABLE content_id_delivery_tracks ADD COLUMN ${column} `));
});
assert.match(databaseSource, /ALTER TABLE content_id_delivery_products ADD COLUMN asset_type /);

memoryDb.prepare("INSERT INTO users (id, full_name, email, password, role) VALUES (1, 'Tester', 'tester@example.com', 'x', 'admin')").run();
memoryDb.prepare(`
  INSERT INTO networks (id, name, network_code, cms_auth_status, cms_auth_email, cms_access_token, cms_refresh_token, cms_token_expiry)
  VALUES (7, 'Primary CMS', 'OWNER_123', 'connected', 'cms@example.com', 'fresh-token', 'refresh-token', ?)
`).run(new Date(Date.now() + 3600000).toISOString());

const PARTNER_API = "https://youtubepartner.googleapis.com/youtube/partner/v1";
const PARTNER_UPLOAD_API = "https://youtubepartner.googleapis.com/upload/youtube/partner/v1";
const SESSION_URL = `${PARTNER_UPLOAD_API}/references?uploadType=resumable&upload_id=video`;

const calls = [];
const uploads = [];
const sessions = new Map();
const cms = { assetCounter: 0, referenceCounter: 0, sessionCounter: 0, assetSearchItems: [] };

function ok(data, extra = {}) {
  return { status: 200, headers: {}, data, ...extra };
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
      return ok({ id: `V${cms.assetCounter}`, type: config.data.type, metadataMine: config.data.metadataMine });
    }
    if (method === "PUT" && /\/(ownership|matchPolicy)$/.test(p)) return ok(config.data);
    if (method === "PATCH" && /^\/assets\//.test(p)) return ok(config.data);
    if (method === "GET" && p === "/assetSearch") {
      const wanted = String(config.params.isrcs).split(",");
      return ok({ items: cms.assetSearchItems.filter((item) => wanted.includes(item.isrc)) });
    }
    if (method === "POST" && upload === "/references") {
      cms.sessionCounter += 1;
      const location = `${SESSION_URL}-${cms.sessionCounter}`;
      sessions.set(location, { assetId: config.data.assetId, contentType: config.data.contentType, mime: config.headers["X-Upload-Content-Type"] });
      return { status: 200, headers: { location }, data: "" };
    }
    if (method === "PUT" && sessions.has(url)) {
      const received = await drain(config.data);
      const session = sessions.get(url);
      uploads.push({ ...received, ...session, mime: config.headers["Content-Type"] });
      cms.referenceCounter += 1;
      return ok({ id: `VR${cms.referenceCounter}`, assetId: session.assetId, status: "checking", contentType: session.contentType, length: 42 });
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
Module._load = originalLoad;
const jobs = require("../src/services/deliveryJobService");
const media = require("../src/services/deliveryMediaService");
const store = require("../src/services/deliveryStore");
const service = require("../src/services/assetDeliveryService");

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
  res.setHeader = () => res;
  return res;
}

async function call(handler, req = {}) {
  const res = makeRes();
  const request = typeof req.pipe === "function" ? req : { params: {}, query: {}, body: {}, headers: {}, user: USER, ...req };
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
  req.headers = { "content-type": "video/mp4", "content-length": String(buffer.length), ...headers };
  return req;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function uploadDraft(bytes, fileName, mime = "video/mp4") {
  const res = await call(controller.uploadDraftAudio, streamReq(bytes, { query: { file_name: fileName, file_size: String(bytes.length) }, headers: { "content-type": mime } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.upload;
}

const VIDEO_ONE = Buffer.from("ftypisom-video-one-0123456789abcdef");
const VIDEO_TWO = Buffer.from("ftypisom-video-two-fedcba9876543210");
const basePayload = {
  network_id: 7,
  product: { title: "Channel uploads · September", artist: "ANS Creator", label: "ANS Media", notes: "Batch notes" },
  rights: { ownership: { mode: "worldwide", territories: [] }, match_policy_id: "policy-1", match_policy_name: "Monetize", asset_labels: ["Creators"] },
  reference: { urgent: false },
  options: { skip_duplicates: true }
};
const state = {};

test.after(() => {
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
});

test("metadata builders follow the Content ID field rules per asset type", () => {
  assert.deepEqual(service.buildWebMetadata({ title: "Clip", description: " About the clip ", custom_id: "ANS Media_abc", notes: "n", info_url: "https://youtu.be/x", director: "A, B" }),
    { title: "Clip", description: "About the clip", customId: "ANS_Media_abc", notes: "n", infoUrl: "https://youtu.be/x", director: ["A", "B"] });
  assert.throws(() => service.buildWebMetadata({ title: "" }), /Title is required/);
  assert.throws(() => service.buildWebMetadata({ title: "x", info_url: "ftp://nope" }), /official URL/);
  assert.throws(() => service.buildWebMetadata({ title: "x", description: "y".repeat(5001) }), /Description must be 5000 bytes/);
  assert.deepEqual(service.buildMusicVideoMetadata({ title: "MV", artist: "Lena", isrc: "vn-a12-25-00001", release_date: "2025-03-04", upc: "0123456789012", custom_id: "ANS_MV1", description: "d" }),
    { title: "MV", artist: ["Lena"], isrc: "VNA122500001", releaseDate: { year: 2025, month: 3, day: 4 }, description: "d", customId: "ANS_MV1", upc: "0123456789012" });
  assert.throws(() => service.buildMusicVideoMetadata({ title: "MV", isrc: "bad" }), /ISRC must be 12/);
  assert.equal(service.kindOfAssetType("web"), "video");
  assert.equal(service.kindOfAssetType("music_video"), "video");
  assert.equal(service.kindOfAssetType("sound_recording"), "music");
  assert.equal(service.kindOfAssetType("unknown"), "music", "unknown types fall back to sound recordings");
  assert.equal(service.defaultReferenceContentType("web"), "audiovisual");
  assert.equal(service.defaultReferenceContentType("sound_recording"), "audio");
  assert.match(service.buildVideoCustomId("ANS Media"), /^ANSMedia_[A-Za-z0-9]{12}$/);
  assert.equal(service.buildVideoCustomId("Nhãn Việt", "TOKEN123"), "NhanViet_TOKEN123");
  assert.ok(Buffer.byteLength(service.sanitizeCustomId("x".repeat(100))) <= 64);
  assert.equal(service.sanitizeCustomId("bad id!#"), "bad_id");
});

test("createProduct validates video items per asset type and ignores ISRC for web videos", async () => {
  const bad = await call(controller.createProduct, {
    body: {
      ...basePayload,
      product: { ...basePayload.product, asset_type: "movie" },
      tracks: [{ client_id: "v1", title: "Clip", isrc: "whatever" }]
    }
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.field_errors.asset_type, /sound_recording, web or music_video/);

  const invalid = await call(controller.createProduct, {
    body: {
      ...basePayload,
      product: { ...basePayload.product, asset_type: "web" },
      tracks: [
        { client_id: "v1", title: "", source_url: "youtube.com/watch?v=1" },
        { client_id: "v2", title: "Clip", custom_id: "!!!", description: "x".repeat(5001) }
      ]
    }
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body.field_errors.v1, /Title is required; The official URL must start with http/);
  assert.match(invalid.body.field_errors.v2, /Description must be 5000 bytes or shorter; Custom ID may only contain/);
  assert.equal(Object.hasOwn(invalid.body.field_errors, "tracks"), false);

  const mv = await call(controller.createProduct, {
    body: {
      ...basePayload,
      product: { ...basePayload.product, title: "MV batch", asset_type: "music_video" },
      tracks: [{ client_id: "m1", title: "MV", isrc: "short" }, { client_id: "m2", title: "MV two" }]
    }
  });
  assert.equal(mv.statusCode, 400);
  assert.match(mv.body.field_errors.m1, /ISRC must be 12 alphanumeric characters/);
  assert.equal(Object.hasOwn(mv.body.field_errors, "m2"), false, "music videos may omit the ISRC");

  const empty = await call(controller.createProduct, { body: { ...basePayload, product: { ...basePayload.product, asset_type: "web" }, tracks: [] } });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.body.field_errors.tracks, "Add at least one video");

  // Byte limits of the Content ID metadata are checked at create time, not only by the job.
  const longNotes = "Ghi chú tiếng Việt có dấu ".repeat(9); // < 255 characters, > 255 UTF-8 bytes
  assert.ok(longNotes.length < 300 && Buffer.byteLength(longNotes, "utf8") > 255);
  const limits = await call(controller.createProduct, {
    body: {
      ...basePayload,
      product: { ...basePayload.product, asset_type: "web", notes: longNotes, title: "T".repeat(256) },
      tracks: [
        { client_id: "l1", title: "Ok", notes: longNotes },
        { client_id: "l2", title: "Ok", source_url: `https://example.com/${"x".repeat(1540)}` },
        { client_id: "l3", title: "Ok", source_url: "http://[" },
        { client_id: "l4", title: "V".repeat(260) }
      ]
    }
  });
  assert.equal(limits.statusCode, 400);
  assert.match(limits.body.field_errors.notes, /Notes must be 255 bytes/);
  assert.match(limits.body.field_errors.title, /Title must be 255 bytes/);
  assert.match(limits.body.field_errors.l1, /Notes must be 255 bytes/);
  assert.match(limits.body.field_errors.l2, /Official URL must be 1536 bytes/);
  assert.match(limits.body.field_errors.l3, /official URL must start with http/);
  assert.match(limits.body.field_errors.l4, /Title must be 255 bytes/);
  assert.equal(memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_products").get().count, 0);
});

test("a web video batch is delivered as web assets with audiovisual references and the files are removed afterwards", async () => {
  const one = await uploadDraft(VIDEO_ONE, "Vlog 01 · Hà Nội.mp4");
  const two = await uploadDraft(VIDEO_TWO, "Vlog 02.mov", "video/quicktime");
  const res = await call(controller.createProduct, {
    body: {
      ...basePayload,
      product: { ...basePayload.product, asset_type: "web" },
      reference: { urgent: true },
      options: { skip_duplicates: true, delete_reference_after_delivery: true },
      tracks: [
        { client_id: "v1", title: "Vlog 01 · Hà Nội", description: "First vlog", source_url: "https://www.youtube.com/watch?v=abc", isrc: "VNA122500001", audio_upload_id: one.id },
        { client_id: "v2", title: "Vlog 02", custom_id: "ANS Media_vlog02", notes: "second", audio_upload_id: two.id },
        { client_id: "v3", title: "No file yet" }
      ]
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { product } = res.body;
  assert.equal(product.asset_type, "web");
  assert.equal(product.kind, "video");
  assert.equal(product.reference_content_type, "audiovisual", "video batches default to audiovisual references");
  assert.equal(product.delete_reference_after_delivery, true);
  const [v1, v2, v3] = product.tracks;
  assert.equal(v1.isrc, "", "web videos carry no ISRC even when one is sent");
  assert.match(v1.custom_id, /^ANSMedia_[A-Za-z0-9]{12}$/, "a readable custom id is generated from the label");
  assert.equal(v1.description, "First vlog");
  assert.equal(v1.source_url, "https://www.youtube.com/watch?v=abc");
  assert.equal(v1.has_audio, true);
  assert.equal(v1.file_mime, "video/mp4");
  assert.equal(v2.custom_id, "ANS_Media_vlog02", "a provided custom id is kept, spaces become underscores");
  assert.equal(v2.file_mime, "video/quicktime");
  assert.equal(v3.has_audio, false);
  assert.notEqual(v1.custom_id, v2.custom_id);
  state.productId = product.id;
  state.ids = { v1: v1.id, v2: v2.id, v3: v3.id };

  const deliver = await call(controller.deliverProduct, { params: { id: String(product.id) }, body: {} });
  assert.equal(deliver.statusCode, 202, JSON.stringify(deliver.body));
  const done = await jobs.waitForJob(product.id);
  assert.deepEqual(done.summary, { created: 3, references: 2, duplicate: 0, error: 0 });
  assert.equal(calls.filter((item) => item.method === "GET" && /\/assetSearch$/.test(item.url)).length, 0, "no ISRC, no duplicate check");

  const inserts = calls.filter((item) => item.method === "POST" && /\/assets$/.test(item.url));
  assert.equal(inserts.length, 3);
  inserts.forEach((insert) => {
    assert.equal(insert.data.type, "web");
    assert.deepEqual(insert.data.label, ["Creators"]);
    assert.equal(Object.hasOwn(insert.data.metadataMine, "isrc"), false);
    assert.equal(Object.hasOwn(insert.data.metadataMine, "album"), false);
    assert.equal(Object.hasOwn(insert.data.metadataMine, "label"), false);
  });
  const first = inserts.find((insert) => insert.data.metadataMine.title === "Vlog 01 · Hà Nội");
  assert.deepEqual(first.data.metadataMine, {
    title: "Vlog 01 · Hà Nội",
    description: "First vlog",
    customId: v1.custom_id,
    notes: "Batch notes",
    infoUrl: "https://www.youtube.com/watch?v=abc"
  });
  const second = inserts.find((insert) => insert.data.metadataMine.title === "Vlog 02");
  assert.equal(second.data.metadataMine.notes, "second");
  assert.equal(calls.filter((item) => item.method === "PUT" && /\/ownership$/.test(item.url)).length, 3);
  assert.equal(calls.filter((item) => item.method === "PUT" && /\/matchPolicy$/.test(item.url)).length, 3);

  assert.equal(uploads.length, 2);
  uploads.forEach((upload) => {
    assert.equal(upload.contentType, "audiovisual");
    assert.ok(["video/mp4", "video/quicktime"].includes(upload.mime), upload.mime);
  });
  assert.deepEqual(uploads.map((upload) => upload.sha256).sort(), [sha256(VIDEO_ONE), sha256(VIDEO_TWO)].sort());
  const initiates = calls.filter((item) => item.method === "POST" && /\/upload\/youtube\/partner\/v1\/references$/.test(item.url));
  initiates.forEach((initiate) => {
    assert.equal(initiate.data.contentType, "audiovisual");
    assert.equal(initiate.data.urgent, true);
  });

  const detail = (await call(controller.getProduct, { params: { id: String(product.id) } })).body.product;
  const byId = Object.fromEntries(detail.tracks.map((track) => [track.id, track]));
  assert.equal(byId[v1.id].status, "completed");
  assert.equal(byId[v1.id].has_audio, false, "the video file is removed once the reference is live");
  assert.equal(byId[v1.id].file_path, null);
  assert.match(byId[v1.id].reference_id, /^VR\d+$/);
  assert.equal(byId[v1.id].reference_content_type, "audiovisual");
  assert.equal(byId[v2.id].has_audio, false);
  assert.equal(byId[v3.id].status, "created", "no file: asset only");
  assert.equal(detail.status, "delivered");
  assert.deepEqual(fs.readdirSync(path.join(MEDIA_DIR, String(product.id))), [], "nothing is left on disk");
  assert.equal(detail.events.filter((event) => event.action === "reference_cleanup" && event.status === "ok").length, 2);
});

test("music video batches carry artist, ISRC, UPC and release date into the asset and run the duplicate check", async () => {
  cms.assetSearchItems = [{ id: "EXISTING-MV", title: "Already there", isrc: "VNA122500010", type: "music_video" }];
  const upload = await uploadDraft(VIDEO_ONE, "mv.mp4");
  const res = await call(controller.createProduct, {
    body: {
      ...basePayload,
      product: { ...basePayload.product, title: "MV batch", artist: "Lena Park", upc: "0123456789012", release_date: "2025-05-17", asset_type: "music_video" },
      reference: { content_type: "video" },
      tracks: [
        { client_id: "m1", title: "Song MV", isrc: "VNA122500011", audio_upload_id: upload.id },
        { client_id: "m2", title: "Second MV", artist: "Feat", isrc: "VNA122500010" },
        { client_id: "m3", title: "No ISRC MV" }
      ]
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { product } = res.body;
  assert.equal(product.asset_type, "music_video");
  assert.equal(product.reference_content_type, "video", "an explicit reference type is kept");
  const [m1, m2, m3] = product.tracks;
  assert.equal(m1.custom_id, "ANSMedia_VNA122500011", "music videos with an ISRC use the label_ISRC convention");
  assert.match(m3.custom_id, /^ANSMedia_[A-Za-z0-9]{12}$/);
  assert.equal(m3.isrc, "");

  calls.length = 0;
  const deliver = await call(controller.deliverProduct, { params: { id: String(product.id) }, body: {} });
  assert.equal(deliver.statusCode, 202, JSON.stringify(deliver.body));
  const done = await jobs.waitForJob(product.id);
  assert.deepEqual(done.summary, { created: 2, references: 1, duplicate: 1, error: 0 });
  const search = calls.find((item) => item.method === "GET" && /\/assetSearch$/.test(item.url));
  assert.deepEqual(String(search.params.isrcs).split(",").sort(), ["VNA122500010", "VNA122500011"], "only items with an ISRC are checked");
  const inserts = calls.filter((item) => item.method === "POST" && /\/assets$/.test(item.url));
  assert.equal(inserts.length, 2);
  const songMv = inserts.find((insert) => insert.data.metadataMine.title === "Song MV");
  assert.equal(songMv.data.type, "music_video");
  assert.deepEqual(songMv.data.metadataMine, {
    title: "Song MV",
    artist: ["Lena Park"],
    isrc: "VNA122500011",
    releaseDate: { year: 2025, month: 5, day: 17 },
    customId: "ANSMedia_VNA122500011",
    notes: "Batch notes",
    upc: "0123456789012"
  });
  const noIsrc = inserts.find((insert) => insert.data.metadataMine.title === "No ISRC MV");
  assert.equal(Object.hasOwn(noIsrc.data.metadataMine, "isrc"), false);
  assert.equal(uploads[uploads.length - 1].contentType, "video");
  const detail = (await call(controller.getProduct, { params: { id: String(product.id) } })).body.product;
  const byId = Object.fromEntries(detail.tracks.map((track) => [track.id, track]));
  assert.equal(byId[m2.id].status, "duplicate");
  assert.equal(byId[m1.id].status, "completed");
  assert.equal(byId[m1.id].has_audio, true, "this batch keeps its files (delete-after-delivery off)");
  state.mvProductId = product.id;
  state.mvTrack = m1.id;
  cms.assetSearchItems = [];
});

test("listProducts separates music and video batches and scopes the summary accordingly", async () => {
  const music = await call(controller.createProduct, {
    body: {
      ...basePayload,
      product: { title: "Album", artist: "Band", label: "ANS" },
      tracks: [{ client_id: "t1", title: "Song", isrc: "VNA122500099" }]
    }
  });
  assert.equal(music.statusCode, 200, JSON.stringify(music.body));
  assert.equal(music.body.product.asset_type, "sound_recording");
  assert.equal(music.body.product.reference_content_type, "audio");

  const all = await call(controller.listProducts, { query: {} });
  assert.equal(all.body.total, 3);
  const video = await call(controller.listProducts, { query: { kind: "video" } });
  assert.equal(video.body.total, 2);
  assert.ok(video.body.products.every((item) => item.kind === "video"));
  assert.deepEqual(video.body.summary, { products: 2, tracks: 6, delivered: 5, completed: 3, errors: 0, taken_down: 0 });
  const musicOnly = await call(controller.listProducts, { query: { kind: "music" } });
  assert.equal(musicOnly.body.total, 1);
  assert.equal(musicOnly.body.summary.products, 1);
  const webOnly = await call(controller.listProducts, { query: { asset_type: "web" } });
  assert.equal(webOnly.body.total, 1);
  assert.equal(webOnly.body.products[0].id, state.productId);
  // Web videos have no ISRC: their custom id and title are searchable.
  const byCustomId = await call(controller.listProducts, { query: { kind: "video", search: "ANS_Media_vlog02" } });
  assert.equal(byCustomId.body.total, 1);
  assert.equal(byCustomId.body.products[0].id, state.productId);
  const byTitle = await call(controller.listProducts, { query: { kind: "video", search: "Vlog 01" } });
  assert.equal(byTitle.body.total, 1);
  const noHit = await call(controller.listProducts, { query: { kind: "video", search: "nothing-like-this" } });
  assert.equal(noHit.body.total, 0);
});

test("updateTrack edits description / official URL and patches the web asset metadata", async () => {
  const res = await call(controller.updateTrack, {
    params: { id: String(state.ids.v1) },
    body: { track: { description: "Updated description", source_url: "https://example.com/v1", isrc: "VNA122500001" }, apply_to_cms: true }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.track.description, "Updated description");
  assert.equal(res.body.track.source_url, "https://example.com/v1");
  assert.equal(res.body.track.isrc, "", "ISRC stays empty for web videos");
  const patch = calls.filter((item) => item.method === "PATCH" && /\/assets\//.test(item.url)).pop();
  assert.equal(patch.data.metadataMine.description, "Updated description");
  assert.equal(patch.data.metadataMine.infoUrl, "https://example.com/v1");
  assert.equal(Object.hasOwn(patch.data.metadataMine, "isrc"), false);

  const badUrl = await call(controller.updateTrack, { params: { id: String(state.ids.v1) }, body: { track: { source_url: "nope" } } });
  assert.equal(badUrl.statusCode, 400);
  assert.match(badUrl.body.field_errors.source_url, /official URL/);

  const mv = await call(controller.updateTrack, { params: { id: String(state.mvTrack) }, body: { track: { isrc: "" }, apply_to_cms: false } });
  assert.equal(mv.statusCode, 200, "a music video may drop its ISRC");
  assert.equal(mv.body.track.isrc, "");
  const mvBad = await call(controller.updateTrack, { params: { id: String(state.mvTrack) }, body: { track: { isrc: "bad" } } });
  assert.equal(mvBad.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Minimum reference length: MP4/MOV clips shorter than 20 s are refused for video uploads
// ---------------------------------------------------------------------------

const mediaDuration = require("../src/services/mediaDurationService");

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

// Minimal ISO BMFF file: ftyp + (optional big mdat) + moov/mvhd with the given duration.
function fakeMp4(seconds, { version = 0, timescale = 1000, moovLast = true, mdatBytes = 3000 } = {}) {
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), Buffer.alloc(4), Buffer.from("isommp42", "latin1")]));
  const mdat = box("mdat", Buffer.alloc(mdatBytes, 1));
  let mvhdBody;
  if (version === 0) {
    mvhdBody = Buffer.alloc(4 + 4 + 4 + 4 + 4 + 80);
    mvhdBody.writeUInt32BE(timescale, 12);
    mvhdBody.writeUInt32BE(Math.round(seconds * timescale), 16);
  } else {
    mvhdBody = Buffer.alloc(4 + 8 + 8 + 4 + 8 + 80);
    mvhdBody[0] = 1;
    mvhdBody.writeUInt32BE(timescale, 20);
    mvhdBody.writeBigUInt64BE(BigInt(Math.round(seconds * timescale)), 24);
  }
  const moov = box("moov", Buffer.concat([box("iods", Buffer.alloc(12)), box("mvhd", mvhdBody), box("trak", Buffer.alloc(40))]));
  return moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

test("the MP4 duration probe reads mvhd (v0 and v1, moov before or after mdat) and ignores other containers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cid-duration-"));
  const write = (name, buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, buffer);
    return file;
  };
  assert.equal(Math.round(await mediaDuration.probeMp4Duration(write("a.mp4", fakeMp4(12.5))) * 10) / 10, 12.5);
  assert.equal(await mediaDuration.probeMp4Duration(write("b.mp4", fakeMp4(95, { version: 1, timescale: 90000, moovLast: false }))), 95);
  assert.equal(await mediaDuration.probeMp4Duration(write("c.mov", fakeMp4(20, { mdatBytes: 500000 }))), 20);
  assert.equal(await mediaDuration.probeMp4Duration(write("d.mkv", Buffer.from("\x1aE\xdf\xa3 not an mp4 at all", "latin1"))), null);
  assert.equal(await mediaDuration.probeMp4Duration(write("e.mp4", Buffer.alloc(3))), null);
  assert.equal(await mediaDuration.probeMediaDuration(write("f.webm", fakeMp4(5)), { fileName: "f.webm", mimeType: "video/webm" }), null, "only MP4-family files are parsed");
  assert.equal(await mediaDuration.probeMediaDuration(write("g.bin", fakeMp4(5)), { fileName: "g.bin", mimeType: "video/mp4" }), 5, "the MIME type is enough");
  await assert.rejects(() => mediaDuration.assertVideoReferenceLength(write("h.mp4", fakeMp4(8)), { fileName: "h.mp4" }), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "VIDEO_TOO_SHORT");
    assert.equal(error.duration_seconds, 8);
    assert.match(error.message, /8\.0 s long; Content ID references must be at least 20 seconds/);
    return true;
  });
  assert.equal(await mediaDuration.assertVideoReferenceLength(write("i.mp4", fakeMp4(20)), { fileName: "i.mp4" }), 20, "exactly 20 s passes");
  assert.equal(await mediaDuration.assertVideoReferenceLength(write("j.avi", Buffer.from("RIFF....AVI ")), { fileName: "j.avi" }), null, "unknown containers are not blocked");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("short video uploads are refused with 422 for the video form and video products, but not for music", async () => {
  const shortClip = fakeMp4(9);
  const longClip = fakeMp4(45);

  const refused = await call(controller.uploadDraftAudio, streamReq(shortClip, { query: { file_name: "short.mp4", file_size: String(shortClip.length), media_kind: "video" } }));
  assert.equal(refused.statusCode, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "VIDEO_TOO_SHORT");
  assert.equal(refused.body.duration_seconds, 9);
  assert.equal(refused.body.min_seconds, 20);
  assert.match(refused.body.message, /"short.mp4" is 9.0 s long/);
  const draftDir = path.join(MEDIA_DIR, "_drafts");
  assert.equal(fs.existsSync(draftDir) ? fs.readdirSync(draftDir).length : 0, 0, "nothing is kept on disk");
  assert.equal(memoryDb.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_audio_uploads").get().count, 0);

  const accepted = await call(controller.uploadDraftAudio, streamReq(longClip, { query: { file_name: "long.mp4", file_size: String(longClip.length), media_kind: "video" } }));
  assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.body));
  await call(controller.deleteDraftAudio, { params: { id: accepted.body.upload.id } });

  // The music form never sends media_kind: a short .mp4 audio clip is still stored.
  const music = await call(controller.uploadDraftAudio, streamReq(shortClip, { query: { file_name: "jingle.mp4", file_size: String(shortClip.length) }, headers: { "content-type": "audio/mp4" } }));
  assert.equal(music.statusCode, 200, JSON.stringify(music.body));
  await call(controller.deleteDraftAudio, { params: { id: music.body.upload.id } });

  // Replacing the file of a video product's item: the short clip is refused and the old file stays.
  const trackId = state.ids.v3;
  const first = await call(controller.uploadAudio, streamReq(longClip, { params: { id: String(trackId) }, query: { file_name: "keep.mp4", file_size: String(longClip.length) } }));
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  const replace = await call(controller.uploadAudio, streamReq(shortClip, { params: { id: String(trackId) }, query: { file_name: "short.mp4", file_size: String(shortClip.length) } }));
  assert.equal(replace.statusCode, 422, JSON.stringify(replace.body));
  assert.equal(replace.body.code, "VIDEO_TOO_SHORT");
  assert.equal(replace.body.track.file_name, "keep.mp4", "the previous file is untouched");
  assert.equal(replace.body.track.has_audio, true);
  assert.deepEqual(fs.readdirSync(path.join(MEDIA_DIR, String(state.productId))).filter((name) => name.startsWith(`${trackId}__`)), [`${trackId}__keep.mp4`]);
  const events = store.listEvents(state.productId, { trackId, action: "audio_upload", status: "error" }).events;
  assert.ok(events.some((event) => event.payload?.code === "VIDEO_TOO_SHORT" && event.payload?.duration_seconds === 9));
});
