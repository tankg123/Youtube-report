process.env.CONTENT_ID_RETRY_BASE_MS = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const Database = require("better-sqlite3");

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-logging-"));
process.env.CONTENT_ID_MEDIA_DIR = mediaDir;
const db = new Database(":memory:");
db.pragma("foreign_keys = OFF");
const source = fs.readFileSync(path.join(__dirname, "../src/config/database.js"), "utf8");
for (const table of ["content_id_delivery_products", "content_id_delivery_tracks", "content_id_delivery_events"]) {
  db.exec(source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\);`))[0]);
}

let assetCounter = 0;
let uploadResponse = null;
let failOwnership = false;
let retryInsert = false;
let failUpload = false;
let timeoutPolicyOnce = false;
const calls = [];
const fakeGoogle = {
  getConnectedNetwork: () => ({ id: 7, name: "Test CMS", network_code: "OWNER" }),
  getAccessToken: async () => "super-secret-token",
  getGoogleError: (error) => error?.googleMessage || error?.response?.data?.error?.message || error?.message || "Request failed"
};
function httpError(status, message) {
  return Object.assign(new Error(message), { response: { status, headers: { "retry-after": "0" }, data: { error: { message } } } });
}
const fakeAxios = {
  async request(config) {
    calls.push(config);
    if (config.method === "POST" && config.url.endsWith("/assets")) {
      if (retryInsert) { retryInsert = false; throw httpError(503, "Try again"); }
      return { status: 200, data: { id: `A${++assetCounter}` } };
    }
    if (config.url.endsWith("/ownership")) {
      if (failOwnership) throw httpError(400, "Ownership rejected");
      return { status: 200, data: config.data };
    }
    if (config.url.endsWith("/matchPolicy")) {
      if (timeoutPolicyOnce) {
        timeoutPolicyOnce = false;
        throw Object.assign(new Error(`timeout of ${config.timeout}ms exceeded`), { code: "ECONNABORTED" });
      }
      return { status: 200, data: config.data };
    }
    if (config.method === "POST" && config.url.endsWith("/references")) {
      return { status: 200, headers: { location: "https://example.invalid/upload?upload_id=private-session" }, data: {} };
    }
    if (config.url.includes("private-session")) {
      if (failUpload) throw httpError(400, "Upload failed");
      let loaded = 0;
      for await (const chunk of config.data) {
        loaded += chunk.length;
        config.onUploadProgress?.({ loaded });
      }
      return { status: 200, data: uploadResponse || { id: "R1", status: "checking", contentType: "audio" } };
    }
    return { status: 200, data: {} };
  }
};
const originalLoad = Module._load;
Module._load = function loadFakes(request, parent, isMain) {
  if (request === "axios") return fakeAxios;
  if (request === "../config/database") return db;
  if (request === "./googleContentIdService") return fakeGoogle;
  return originalLoad(request, parent, isMain);
};
const jobs = require("../src/services/deliveryJobService");
const store = require("../src/services/deliveryStore");
const media = require("../src/services/deliveryMediaService");
Module._load = originalLoad;

test.after(() => {
  db.close();
  fs.rmSync(mediaDir, { recursive: true, force: true });
});
test.beforeEach(() => {
  uploadResponse = null;
  failOwnership = false;
  retryInsert = false;
  failUpload = false;
  timeoutPolicyOnce = false;
  calls.length = 0;
});

async function draft({ cleanup = false, audio = true } = {}) {
  const productId = Number(db.prepare(`INSERT INTO content_id_delivery_products
    (network_id, title, skip_duplicates, delete_reference_after_delivery, ownership_json)
    VALUES (7, 'Test release', 0, ?, '{"mode":"worldwide"}')`).run(cleanup ? 1 : 0).lastInsertRowid);
  const trackId = Number(db.prepare(`INSERT INTO content_id_delivery_tracks
    (product_id, track_number, title, isrc) VALUES (?, 1, 'Test song', 'VNA122400001')`).run(productId).lastInsertRowid);
  if (audio) {
    store.setTrackAudio(trackId, await media.storeTrackAudio({ productId, trackId, fileName: "song.wav",
      stream: Readable.from(Buffer.from("reference bytes")), contentLength: 15, mimeType: "audio/wav" }));
  }
  return { productId, trackId };
}

async function deliver(productId, trackId, includeReference = true) {
  store.startProductJob(productId, { includeReference });
  store.markTrackQueued(trackId);
  const job = jobs.startDeliveryJob({ productId, trackIds: [trackId], includeReference });
  const result = await jobs.waitForJob(productId);
  return { job, result, track: store.getTrackParsed(trackId), logs: store.listEvents(productId, { limit: 200 }).events };
}

test("successful delivery retains audio by default and writes correlated API, retry and progress logs", async () => {
  const { productId, trackId } = await draft();
  retryInsert = true;
  const { job, result, track, logs } = await deliver(productId, trackId);
  assert.deepEqual(result.summary, { created: 1, references: 1, duplicate: 0, error: 0 });
  assert.equal(track.has_audio, true);
  assert.equal(store.parseProductRow(store.getProductRow(productId)).delete_reference_after_delivery, false);
  assert.ok(logs.length > 10);
  assert.ok(logs.every((event) => event.payload.run_id === job.run_id));
  assert.ok(logs.some((event) => event.action === "api" && event.payload.phase === "retry" && event.payload.retry_delay_ms === 0));
  assert.ok(logs.some((event) => event.action === "api" && event.payload.http_status === 503));
  assert.ok(logs.some((event) => event.action === "api" && event.payload.phase === "progress" && event.payload.percent === 100));
  assert.ok(logs.some((event) => event.action === "delivery_step" && event.track_id === trackId && event.payload.step === "insert" && event.status === "ok"));
  assert.equal(logs[0].action, "deliver");
  assert.equal(logs[0].payload.percent, 100);
  assert.ok(Number.isFinite(logs[0].payload.duration_ms));
  assert.doesNotMatch(JSON.stringify(logs), /super-secret-token|private-session|Authorization/);
});

test("a match policy update whose answer timed out is retried inside the job and both attempts are logged", async () => {
  const { productId, trackId } = await draft({ audio: false });
  db.prepare("UPDATE content_id_delivery_products SET match_policy_id = 'S550455047368215', match_policy_name = 'Monetize in all countries' WHERE id = ?")
    .run(productId);
  timeoutPolicyOnce = true;
  const { result, track, logs } = await deliver(productId, trackId, false);
  assert.deepEqual(result.summary, { created: 1, references: 0, duplicate: 0, error: 0 });
  assert.equal(track.status, "created");
  assert.ok(!track.error_message, track.error_message);
  assert.equal(track.steps.policy, true);
  assert.equal(track.match_policy_id, "S550455047368215");

  const policyCalls = calls.filter((call) => call.url.endsWith("/matchPolicy"));
  assert.deepEqual(policyCalls.map((call) => call.timeout), [30000, 60000], "the retry gets a longer deadline");
  const api = logs.filter((event) => event.action === "api" && /matchPolicy$/.test(event.payload.endpoint)).reverse();
  assert.deepEqual(api.map((event) => event.payload.phase), ["started", "failed", "retry", "started", "completed"]);
  const failed = api[1];
  assert.match(failed.message, /^PUT \/youtube\/partner\/v1\/assets\/A\d+\/matchPolicy: Google Content ID did not respond within 30 s$/);
  assert.equal(failed.status, "error");
  assert.equal(failed.payload.step, "policy");
  assert.equal(failed.payload.timeout_ms, 30000);
  assert.equal(failed.payload.http_status, null);
  assert.equal(api[4].payload.attempt, 2);
  assert.ok(logs.some((event) => event.action === "delivery_step" && event.payload.step === "policy" && event.status === "ok"));
  assert.ok(!logs.some((event) => event.action === "track_delivery" && event.status === "error"));
});

test("opt-in cleanup removes server bytes and audio columns but preserves successful CMS identities", async () => {
  const { productId, trackId } = await draft({ cleanup: true });
  const filePath = media.resolveTrackAudio(store.getTrackRow(trackId)).absPath;
  const { track, logs } = await deliver(productId, trackId);
  assert.equal(track.status, "completed");
  assert.equal(track.has_audio, false);
  assert.equal(track.file_path, null);
  assert.equal(track.file_sha256, null);
  assert.equal(track.reference_id, "R1");
  assert.match(track.asset_id, /^A/);
  assert.equal(track.steps.reference, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(logs.some((event) => event.action === "reference_cleanup" && event.status === "ok" && event.payload.bytes_freed === 15));
});

test("metadata-only delivery and failed or invalid reference uploads retain local audio", async () => {
  const metadataOnly = await draft({ cleanup: true });
  const metadata = await deliver(metadataOnly.productId, metadataOnly.trackId, false);
  assert.equal(metadata.track.status, "created");
  assert.equal(metadata.track.has_audio, true);
  for (const response of [{}, { id: "INVALID", status: "inactive" }, { id: "UNKNOWN", status: "unrecognized" },
    { id: "WRONG", assetId: "another-asset", status: "active" }]) {
    const { productId, trackId } = await draft({ cleanup: true });
    uploadResponse = response;
    const { track, result, logs } = await deliver(productId, trackId);
    assert.equal(track.status, "error");
    assert.equal(result.summary.error, 1);
    assert.equal(track.has_audio, true);
    assert.equal(logs.some((event) => event.action === "reference_cleanup"), false);
  }
  uploadResponse = null;
  failUpload = true;
  const failed = await draft({ cleanup: true });
  assert.equal((await deliver(failed.productId, failed.trackId)).track.has_audio, true);
});

test("a metadata step failure checkpoints the asset, preserves audio and retry resumes without a duplicate insert", async () => {
  const { productId, trackId } = await draft({ cleanup: true });
  failOwnership = true;
  const failed = await deliver(productId, trackId);
  assert.equal(failed.track.status, "error");
  assert.equal(failed.track.steps.insert, true);
  assert.equal(failed.track.has_audio, true);
  const assetId = failed.track.asset_id;
  assert.equal(calls.filter((call) => call.url.endsWith("/assets")).length, 1);
  failOwnership = false;
  const retried = await deliver(productId, trackId);
  assert.equal(retried.track.asset_id, assetId);
  assert.equal(retried.track.status, "completed");
  assert.equal(retried.track.has_audio, false);
  assert.equal(calls.filter((call) => call.url.endsWith("/assets")).length, 1);
  assert.notEqual(retried.job.run_id, failed.job.run_id);
});

test("cleanup failures remain visible while the successful CMS delivery and local file remain intact", async () => {
  const { productId, trackId } = await draft({ cleanup: true });
  const original = media.removeTrackAudio;
  media.removeTrackAudio = async () => { throw new Error("File locked"); };
  try {
    const { track, result, logs } = await deliver(productId, trackId);
    assert.equal(result.summary.error, 0);
    assert.equal(track.status, "completed");
    assert.equal(track.has_audio, true);
    assert.ok(logs.some((event) => event.action === "reference_cleanup" && event.status === "error" && /File locked/.test(event.message)));
  } finally {
    media.removeTrackAudio = original;
  }
});

test("persisted log cursors cover every event, poll new events, filter by track/run and redact secrets", async () => {
  const { productId, trackId } = await draft();
  const { job, logs } = await deliver(productId, trackId);
  const collected = [];
  let beforeId;
  do {
    const page = store.listEvents(productId, { limit: 3, beforeId });
    collected.push(...page.events);
    beforeId = page.has_more ? page.next_before_id : null;
  } while (beforeId);
  assert.deepEqual(collected.map((event) => event.id), logs.map((event) => event.id));
  const trackEvents = store.listEvents(productId, { trackId, runId: job.run_id, status: "ok" }).events;
  assert.ok(trackEvents.length);
  assert.ok(trackEvents.every((event) => event.track_id === trackId && event.status === "ok"));
  store.logEvent(productId, { action: "test", message: "Bearer secret-access", payload: {
    accessToken: "secret-access", nested: { refresh_token: "private-refresh" },
    url: "https://example.invalid/upload?upload_id=private-session"
  } });
  const polled = store.listEvents(productId, { afterId: logs[0].id });
  assert.equal(polled.events.length, 1);
  assert.doesNotMatch(JSON.stringify(polled), /secret-access|private-refresh|private-session/);
  assert.equal(store.listEvents(productId, { runId: "unknown" }).events.length, 0);
});

test("interrupted jobs produce durable track and run logs only once and retain audio", async () => {
  const { productId, trackId } = await draft({ cleanup: true });
  store.startProductJob(productId);
  store.markTrackQueued(trackId);
  store.logEvent(productId, { action: "deliver", status: "started", payload: { run_id: "old-run", phase: "started" } });
  assert.equal(jobs.recordInterruptedJob(productId), true);
  assert.equal(jobs.recordInterruptedJob(productId), false);
  const events = store.listEvents(productId).events;
  assert.equal(events.filter((event) => event.action === "delivery_interrupted").length, 1);
  assert.ok(events.some((event) => event.track_id === trackId && event.status === "error"));
  assert.equal(events[0].payload.run_id, "old-run");
  assert.equal(store.getTrackParsed(trackId).has_audio, true);
});
