process.env.CONTENT_ID_RETRY_BASE_MS = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const { Readable } = require("node:stream");

const calls = [];
let handler = async () => ({ status: 200, headers: {}, data: {} });

const networkRow = {
  id: 7,
  name: "Primary CMS",
  network_code: "OWNER_123",
  cms_auth_status: "connected",
  cms_auth_email: "cms@example.com",
  cms_auth_scopes: "https://www.googleapis.com/auth/youtubepartner",
  cms_access_token: "fresh-token",
  cms_refresh_token: "refresh-token",
  cms_token_expiry: new Date(Date.now() + 3600000).toISOString()
};

const fakeDb = {
  prepare(sql) {
    if (sql.includes("FROM networks")) {
      return { all: () => [networkRow], get: () => networkRow, run: () => ({ changes: 1 }) };
    }
    return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
  }
};

const fakeAxios = {
  async request(config) {
    calls.push(config);
    return handler(config);
  }
};

const originalLoad = Module._load;
Module._load = function loadWithAssetDeliveryFakes(request, parent, isMain) {
  if (request === "axios") return fakeAxios;
  if (request === "../config/database") return fakeDb;
  if (request === "./googleCmsAuthService") {
    return { refreshAccessToken: async () => ({ access_token: "refreshed", expires_in: 3600 }) };
  }
  return originalLoad(request, parent, isMain);
};

const service = require("../src/services/assetDeliveryService");
Module._load = originalLoad;

const { PARTNER_API, PARTNER_UPLOAD_API } = service;

function httpError(status, message, reason, headers = {}) {
  const error = new Error(message);
  error.response = {
    status,
    headers,
    data: { error: { message, errors: reason ? [{ reason }] : [] } }
  };
  return error;
}

function ok(data, extra = {}) {
  return { status: 200, headers: {}, data, ...extra };
}

function reset(nextHandler) {
  calls.length = 0;
  handler = nextHandler;
}

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

test("buildSoundRecordingMetadata keeps only non-empty keys and normalizes lists, codes and dates", () => {
  const metadata = service.buildSoundRecordingMetadata({
    title: "  Song  ",
    artist: "Artist A, Artist B; Artist A",
    album: "",
    isrc: "vn-a12-24-00001",
    upc: "0123456789012",
    label: "ANS Records",
    genre: "Pop|Ballad",
    release_date: "2024-05-17",
    custom_id: "ANSRecords_VNA122400001",
    notes: ""
  });

  assert.deepEqual(metadata, {
    title: "Song",
    artist: ["Artist A", "Artist B"],
    isrc: "VNA122400001",
    upc: "0123456789012",
    label: "ANS Records",
    genre: ["Pop", "Ballad"],
    releaseDate: { year: 2024, month: 5, day: 17 },
    customId: "ANSRecords_VNA122400001"
  });
  assert.equal(Object.hasOwn(metadata, "album"), false);
  assert.equal(Object.hasOwn(metadata, "notes"), false);
});

test("buildSoundRecordingMetadata rejects a missing title or an invalid ISRC", () => {
  assert.throws(() => service.buildSoundRecordingMetadata({ title: "", isrc: "VNA122400001" }), /Title is required/);
  assert.throws(() => service.buildSoundRecordingMetadata({ title: "Song", isrc: "SHORT" }), /Valid ISRC is required/);
});

test("buildProductMetadata stores the album-level data of the product inside each track asset", () => {
  const product = {
    title: "Album",
    artist: "Album Artist",
    upc: "0123456789012",
    label: "ANS Records",
    genre: "Pop, Ballad",
    release_date: "2024-05-17",
    notes: "Product notes"
  };
  const track = { title: "Song", artist: "Track Artist", isrc: "vna122400001", custom_id: "ANSRecords_VNA122400001", notes: "" };

  assert.deepEqual(service.buildProductMetadata(product, track), {
    title: "Song",
    artist: ["Track Artist"],
    album: "Album",
    isrc: "VNA122400001",
    upc: "0123456789012",
    label: "ANS Records",
    genre: ["Pop", "Ballad"],
    releaseDate: { year: 2024, month: 5, day: 17 },
    customId: "ANSRecords_VNA122400001",
    notes: "Product notes"
  });

  const own = service.buildProductMetadata(product, { ...track, notes: "Track notes" });
  assert.equal(own.notes, "Track notes");
  assert.throws(() => service.buildProductMetadata({ ...product, upc: "12" }, track), /Valid UPC/);
});

test("buildOwnership supports worldwide, include and exclude modes", () => {
  assert.deepEqual(service.buildOwnership({ mode: "worldwide", contentOwnerId: "OWNER_123" }), {
    kind: "youtubePartner#rightsOwnership",
    general: [{ ratio: 100, owner: "OWNER_123", type: "exclude", territories: [] }]
  });

  assert.deepEqual(service.buildOwnership({ mode: "include", territories: ["vn", "US", "vn"], contentOwnerId: "OWNER_123" }), {
    kind: "youtubePartner#rightsOwnership",
    general: [{ ratio: 100, owner: "OWNER_123", type: "include", territories: ["VN", "US"] }]
  });

  assert.deepEqual(service.buildOwnership({ mode: "exclude", territories: "KR, JP", contentOwnerId: "OWNER_123", ratio: 100 }), {
    kind: "youtubePartner#rightsOwnership",
    general: [{ ratio: 100, owner: "OWNER_123", type: "exclude", territories: ["KR", "JP"] }]
  });

  assert.throws(() => service.buildOwnership({ mode: "include", territories: [], contentOwnerId: "OWNER_123" }), /at least one territory/i);
  assert.throws(() => service.buildOwnership({ mode: "worldwide", contentOwnerId: "" }), /Content owner ID/);
});

test("parseReleaseDate accepts the documented input formats", () => {
  assert.deepEqual(service.parseReleaseDate("2024-05-17"), { year: 2024, month: 5, day: 17 });
  assert.deepEqual(service.parseReleaseDate("2024-05"), { year: 2024, month: 5 });
  assert.deepEqual(service.parseReleaseDate("2024"), { year: 2024 });
  assert.deepEqual(service.parseReleaseDate("17/05/2024"), { year: 2024, month: 5, day: 17 });
  assert.deepEqual(service.parseReleaseDate("2024-05-17T00:00:00.000Z"), { year: 2024, month: 5, day: 17 });
  assert.deepEqual(service.parseReleaseDate({ year: "2024", month: 5, day: 17 }), { year: 2024, month: 5, day: 17 });
  assert.equal(service.parseReleaseDate("2024-13-01"), null);
  assert.equal(service.parseReleaseDate("May 2024"), null);
  assert.equal(service.parseReleaseDate(""), null);
  assert.equal(service.toDateOnly({ year: 2024, month: 5, day: 7 }), "2024-05-07");
});

test("summarizePolicyRules produces a short English summary", () => {
  const summary = service.summarizePolicyRules([
    { action: "monetize" },
    {
      action: "block",
      subaction: ["review"],
      conditions: { requiredTerritories: { type: "exclude", territories: ["VN"] } }
    }
  ]);
  assert.equal(summary, "Monetize (WW) · Block (exclude VN) · review");
  assert.equal(service.summarizePolicyRules([]), "");
});

test("normalizeIsrc / normalizeUpc / splitList / buildCustomId behave as documented", () => {
  assert.equal(service.normalizeIsrc("vn-a12-24-00001"), "VNA122400001");
  assert.equal(service.normalizeIsrc("VNA1224"), "");
  assert.equal(service.normalizeUpc("0123456789012"), "0123456789012");
  assert.equal(service.normalizeUpc("1234567"), "");
  assert.equal(service.isValidIsrc("VNA122400001"), true);
  assert.equal(service.isValidUpc("0123456789012"), true);
  assert.deepEqual(service.splitList(" a, b;c|d\ne ,a "), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(service.splitList(["x", "", "x"]), ["x"]);
  assert.equal(service.buildCustomId("Nhạc Số", "VNA122400001"), "NhacSo_VNA122400001");
  assert.equal(service.normalizeReferenceContentType("VIDEO"), "video");
  assert.equal(service.normalizeReferenceContentType("bogus", "audiovisual"), "audiovisual");
});

test("the package / uploader / CSV helpers from the first iteration are gone", () => {
  ["listUploaders", "listSpreadsheetTemplates", "validatePackageContent", "insertPackage", "getPackage",
    "buildSoundRecordingCsvRows", "buildArtTrackCsvRows"].forEach((name) => {
    assert.equal(service[name], undefined, `${name} should not be exported`);
  });
});

// ---------------------------------------------------------------------------
// runSoundRecordingSteps
// ---------------------------------------------------------------------------

test("runSoundRecordingSteps runs insert → ownership → policy and sends labels on insert", async () => {
  reset(async (config) => {
    if (config.method === "POST" && config.url === `${PARTNER_API}/assets`) return ok({ id: "asset-1", type: "sound_recording" });
    if (config.method === "PUT" && config.url === `${PARTNER_API}/assets/asset-1/ownership`) return ok({ kind: "youtubePartner#rightsOwnership" });
    if (config.method === "PUT" && config.url === `${PARTNER_API}/assets/asset-1/matchPolicy`) return ok({ policyId: "policy-9" });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const stepLog = [];
  const ownership = service.buildOwnership({ mode: "worldwide", contentOwnerId: "OWNER_123" });
  const result = await service.runSoundRecordingSteps(7, {
    metadata: { title: "Song", isrc: "VNA122400001" },
    labels: ["ANS", "Pop"],
    ownership,
    match_policy_id: "policy-9",
    match_policy_rules: null,
    steps_done: {}
  }, { onStep: (name, isOk) => stepLog.push(`${name}:${isOk}`) });

  assert.equal(result.error, null);
  assert.equal(result.asset_id, "asset-1");
  assert.deepEqual(result.steps, { insert: true, ownership: true, policy: true, labels: true });
  assert.deepEqual(stepLog, ["insert:true", "ownership:true", "policy:true"]);
  assert.equal(calls.length, 3);

  assert.deepEqual(calls[0].data, {
    kind: "youtubePartner#asset",
    type: "sound_recording",
    metadataMine: { title: "Song", isrc: "VNA122400001" },
    label: ["ANS", "Pop"]
  });
  assert.equal(calls[0].params.onBehalfOfContentOwner, "OWNER_123");
  assert.equal(calls[0].headers.Authorization, "Bearer fresh-token");
  assert.equal(calls[1].data.kind, "youtubePartner#rightsOwnership");
  assert.deepEqual(calls[1].data.general, ownership.general);
  assert.deepEqual(calls[2].data, { kind: "youtubePartner#assetMatchPolicy", policyId: "policy-9" });
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
});

test("runSoundRecordingSteps accepts a resolved auth context instead of a network id", async () => {
  reset(async (config) => {
    if (config.method === "POST" && config.url === `${PARTNER_API}/assets`) return ok({ id: "asset-ctx" });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const ctx = await service.authContext(7);
  assert.deepEqual({ contentOwnerId: ctx.contentOwnerId, accessToken: ctx.accessToken }, { contentOwnerId: "OWNER_123", accessToken: "fresh-token" });

  const result = await service.runSoundRecordingSteps(ctx, {
    metadata: { title: "Song", isrc: "VNA122400009" },
    labels: [],
    ownership: null,
    match_policy_id: "",
    steps_done: {}
  });
  assert.equal(result.asset_id, "asset-ctx");
  assert.deepEqual(result.steps, { insert: true, ownership: true, policy: true, labels: true });
  assert.equal(calls.length, 1);
});

test("runSoundRecordingSteps stops at the failing ownership step and reports it", async () => {
  reset(async (config) => {
    if (config.method === "POST" && config.url === `${PARTNER_API}/assets`) return ok({ id: "asset-2" });
    if (config.method === "PUT" && config.url.endsWith("/ownership")) throw httpError(403, "Insufficient permission", "forbidden");
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const result = await service.runSoundRecordingSteps(7, {
    metadata: { title: "Song", isrc: "VNA122400002" },
    labels: [],
    ownership: service.buildOwnership({ mode: "worldwide", contentOwnerId: "OWNER_123" }),
    match_policy_id: "policy-9",
    steps_done: {}
  });

  assert.equal(result.asset_id, "asset-2");
  assert.equal(result.step, "ownership");
  assert.deepEqual(result.error, { step: "ownership", message: "Insufficient permission", status: 403, reason: "forbidden" });
  assert.deepEqual(result.steps, { insert: true, ownership: false, policy: false, labels: false });
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.url.endsWith("/matchPolicy")), false);
});

test("runSoundRecordingSteps skips finished steps on retry and patches labels for an existing asset", async () => {
  reset(async (config) => {
    if (config.method === "PUT" && config.url === `${PARTNER_API}/assets/asset-3/matchPolicy`) return ok({ policyId: "policy-9" });
    if (config.method === "PATCH" && config.url === `${PARTNER_API}/assets/asset-3`) return ok({ id: "asset-3", label: ["ANS"] });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const result = await service.runSoundRecordingSteps(7, {
    asset_id: "asset-3",
    metadata: { title: "Song", isrc: "VNA122400003" },
    labels: ["ANS"],
    ownership: service.buildOwnership({ mode: "worldwide", contentOwnerId: "OWNER_123" }),
    match_policy_id: "policy-9",
    steps_done: { insert: true, ownership: true, policy: false, labels: false }
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.steps, { insert: true, ownership: true, policy: true, labels: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${PARTNER_API}/assets/asset-3/matchPolicy`);
  assert.equal(calls[1].method, "PATCH");
  assert.deepEqual(calls[1].data, { label: ["ANS"] });
});

test("transient Google errors are retried with backoff and non-transient ones are not", async () => {
  let attempts = 0;
  reset(async (config) => {
    if (config.method === "POST" && config.url === `${PARTNER_API}/assets`) {
      attempts += 1;
      if (attempts === 1) throw httpError(503, "Backend Error", "backendError", { "retry-after": "0" });
      return ok({ id: "asset-4" });
    }
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const asset = await service.insertSoundRecordingAsset(7, { title: "Song", isrc: "VNA122400004" });
  assert.equal(asset.id, "asset-4");
  assert.equal(calls.length, 2);

  reset(async () => {
    throw httpError(400, "Invalid metadata", "invalidValue");
  });
  await assert.rejects(
    service.insertSoundRecordingAsset(7, { title: "Song", isrc: "VNA122400005" }),
    (error) => error.message === "Invalid metadata" && error.status === 400 && error.reason === "invalidValue"
  );
  assert.equal(calls.length, 1);
});

test("creates (POST) are only retried on 429/503, never on socket errors or other 5xx", async () => {
  const socketError = (code, message = `socket ${code}`) => Object.assign(new Error(message), { code });

  // A timed-out POST /assets may already have created the asset: no second POST, and the error
  // says what happened instead of echoing Axios' "timeout of 30000ms exceeded".
  reset(async () => {
    throw socketError("ECONNABORTED", "timeout of 30000ms exceeded");
  });
  await assert.rejects(
    service.insertSoundRecordingAsset(7, { title: "Song", isrc: "VNA122400006" }),
    (error) => error.code === "ECONNABORTED" && error.networkId === 7 && error.timedOut === true && error.attempts === 1
      && error.message === "Google Content ID did not respond within 30 s (POST /youtube/partner/v1/assets)"
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeout, 30000);

  reset(async () => {
    throw socketError("ECONNRESET", "socket hang up");
  });
  await assert.rejects(
    service.insertSoundRecordingAsset(7, { title: "Song", isrc: "VNA122400006" }),
    (error) => error.code === "ECONNRESET" && /connection to Google Content ID was dropped/.test(error.message)
  );
  assert.equal(calls.length, 1);

  reset(async () => {
    throw httpError(500, "Backend Error", "backendError");
  });
  await assert.rejects(
    service.insertSoundRecordingAsset(7, { title: "Song", isrc: "VNA122400006" }),
    (error) => error.status === 500 && error.message === "Backend Error" && error.timedOut === undefined
  );
  assert.equal(calls.length, 1);

  // The other creates follow the same rule: a reference built from a claim and a new asset label.
  reset(async () => {
    throw socketError("ETIMEDOUT");
  });
  await assert.rejects(service.createReferenceFromClaim(7, "asset-1", "claim-1"), (error) => error.code === "ETIMEDOUT");
  assert.equal(calls.length, 1);

  reset(async () => {
    throw httpError(502, "Bad Gateway", "backendError");
  });
  await assert.rejects(service.createAssetLabel(7, "New label"), (error) => error.status === 502);
  assert.equal(calls.length, 1);

  // 429 and 503 prove Google did not process the call, so the create is re-sent (Retry-After honoured).
  let attempts = 0;
  reset(async (config) => {
    attempts += 1;
    if (attempts === 1) throw httpError(429, "Rate limit", "rateLimitExceeded", { "retry-after": "0" });
    return ok({ id: "asset-6", ...config.data });
  });
  const asset = await service.insertSoundRecordingAsset(7, { title: "Song", isrc: "VNA122400006" });
  assert.equal(asset.id, "asset-6");
  assert.equal(calls.length, 2);

  attempts = 0;
  reset(async () => {
    attempts += 1;
    if (attempts < 3) throw httpError(503, "Backend Error", "backendError", { "retry-after": "0" });
    return ok({ id: "asset-7" });
  });
  const insisted = await service.insertSoundRecordingAsset(7, { title: "Song", isrc: "VNA122400007" });
  assert.equal(insisted.id, "asset-7");
  assert.equal(calls.length, 3);
});

test("idempotent writes are retried on timeouts, dropped connections and 5xx with a growing deadline", async () => {
  const timeout = (ms) => Object.assign(new Error(`timeout of ${ms}ms exceeded`), { code: "ECONNABORTED" });

  // The failure seen in production: PUT .../matchPolicy timing out once. The second attempt is
  // sent after the backoff, gets twice the time and succeeds; the observer sees every phase.
  let attempts = 0;
  const events = [];
  const ctx = { accessToken: "fresh-token", contentOwnerId: "OWNER_123", network: { id: 7 }, onApiEvent: (event) => events.push(event) };
  reset(async (config) => {
    attempts += 1;
    if (attempts === 1) throw timeout(config.timeout);
    return ok({ kind: "youtubePartner#assetMatchPolicy", policyId: config.data.policyId });
  });
  const policy = await service.updateMatchPolicy(ctx, "A296103725916197", { policy_id: "S550455047368215" });
  assert.equal(policy.policyId, "S550455047368215");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.timeout), [30000, 60000]);
  assert.deepEqual(calls.map((call) => call.data), Array(2).fill({ kind: "youtubePartner#assetMatchPolicy", policyId: "S550455047368215" }));
  assert.deepEqual(
    events.map((event) => [event.phase, event.attempt, event.timeout_ms]),
    [["started", 1, 30000], ["failed", 1, 30000], ["retry", 1, 30000], ["started", 2, 60000], ["completed", 2, 60000]]
  );
  assert.equal(events[1].message, "Google Content ID did not respond within 30 s");
  assert.equal(events[1].http_status, null);
  assert.equal(events[1].error_code, "ECONNABORTED");
  assert.equal(events[2].retry_delay_ms, 1);
  assert.equal(events[4].http_status, 200);

  // When the answer never comes the call gives up after the second silent attempt, and the
  // error names the call and the number of attempts.
  reset(async (config) => {
    throw timeout(config.timeout);
  });
  const ownership = service.buildOwnership({ mode: "worldwide", contentOwnerId: "OWNER_123" });
  await assert.rejects(
    service.updateOwnership(7, "asset-1", ownership),
    (error) => error.timedOut === true && error.attempts === 2 && error.networkId === 7
      && error.message === "Google Content ID did not respond within 60 s (PUT /youtube/partner/v1/assets/asset-1/ownership, 2 attempts)"
  );
  assert.deepEqual(calls.map((call) => call.timeout), [30000, 60000]);

  // Answers that do arrive (5xx) keep the full three attempts; only silence lengthens the deadline.
  reset(async () => {
    throw httpError(502, "Bad Gateway", "backendError");
  });
  await assert.rejects(service.updateOwnership(7, "asset-1", ownership), (error) => error.status === 502 && error.attempts === 3);
  assert.deepEqual(calls.map((call) => call.timeout), [30000, 30000, 30000]);

  // One silent attempt followed by a 503 still leaves room for a third attempt.
  let mixed = 0;
  reset(async (config) => {
    mixed += 1;
    if (mixed === 1) throw timeout(config.timeout);
    if (mixed === 2) throw httpError(503, "Backend Error", "backendError", { "retry-after": "0" });
    return ok({ kind: "youtubePartner#rightsOwnership", ...config.data });
  });
  assert.equal((await service.updateOwnership(7, "asset-1", ownership)).kind, "youtubePartner#rightsOwnership");
  assert.deepEqual(calls.map((call) => call.timeout), [30000, 60000, 60000]);

  // A 503 first, then silence twice: the two silent waits are still 30 s and 60 s.
  let late = 0;
  reset(async (config) => {
    late += 1;
    if (late === 1) throw httpError(503, "Backend Error", "backendError", { "retry-after": "0" });
    throw timeout(config.timeout);
  });
  await assert.rejects(
    service.updateOwnership(7, "asset-1", ownership),
    (error) => error.timedOut === true && error.attempts === 3
      && error.message === "Google Content ID did not respond within 60 s (PUT /youtube/partner/v1/assets/asset-1/ownership, 3 attempts)"
  );
  assert.deepEqual(calls.map((call) => call.timeout), [30000, 30000, 60000]);

  // PATCH bodies that replace a whole field are opted in: label list, metadataMine, reference and claim status.
  const failOnce = (failure, data) => {
    let seen = 0;
    reset(async () => {
      seen += 1;
      if (seen === 1) throw failure;
      return ok(data);
    });
  };
  failOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), { id: "asset-1", label: ["ANS"] });
  assert.deepEqual((await service.patchAssetLabels(7, "asset-1", ["ANS"])).label, ["ANS"]);
  assert.equal(calls.length, 2);

  failOnce(httpError(504, "Gateway Timeout", "backendError"), { id: "asset-1", metadataMine: { title: "T" } });
  assert.equal((await service.patchAssetMetadata(7, "asset-1", { title: "T" })).id, "asset-1");
  assert.equal(calls.length, 2);

  failOnce(httpError(502, "Bad Gateway", "backendError"), { id: "ref-1", status: "inactive" });
  assert.equal((await service.patchReferenceStatus(7, "ref-1", "inactive")).status, "inactive");
  assert.equal(calls.length, 2);

  failOnce(httpError(500, "Backend Error", "backendError"), { id: "claim-1", status: "inactive" });
  assert.equal((await service.releaseClaim(7, "claim-1")).status, "inactive");
  assert.equal(calls.length, 2);

  // Opening a resumable session creates no reference, so a lost answer is simply asked again;
  // the upload itself still runs without a deadline.
  let initiations = 0;
  reset(async (config) => {
    if (config.method === "POST") {
      initiations += 1;
      if (initiations === 1) throw timeout(config.timeout);
      return { status: 200, headers: { location: "https://upload.example/session" }, data: "" };
    }
    if (config.method === "PUT") return ok({ id: "ref-2", assetId: "asset-1", status: "checking", contentType: "audio" });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });
  const reference = await service.uploadReferenceStream(7, "asset-1", {
    stream: Readable.from([Buffer.from("0123456789")]), contentLength: 10, mimeType: "audio/wav"
  });
  assert.equal(reference.id, "ref-2");
  assert.deepEqual(calls.map((call) => [call.method, call.timeout]), [["POST", 30000], ["POST", 60000], ["PUT", 0]]);

  // Answers from Google other than 429/5xx stay final.
  reset(async () => {
    throw httpError(400, "Policy not found", "notFound");
  });
  await assert.rejects(service.updateMatchPolicy(7, "asset-1", { policy_id: "missing" }), (error) => error.status === 400 && error.attempts === 1);
  assert.equal(calls.length, 1);
});

test("GET requests keep the full transient retry policy (socket errors and 5xx)", async () => {
  let attempts = 0;
  reset(async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return ok({ items: [] });
  });
  const matches = await service.searchAssetsByIsrc(7, ["VNA122400001"]);
  assert.equal(matches.size, 0);
  assert.equal(calls.length, 2);

  attempts = 0;
  reset(async () => {
    attempts += 1;
    if (attempts === 1) throw httpError(500, "Backend Error", "backendError");
    return ok({ id: "asset-1", status: "active" });
  });
  const asset = await service.getAssetDetail(7, "asset-1");
  assert.equal(asset.status, "active");
  assert.equal(calls.length, 2);

  reset(async () => {
    throw httpError(500, "Backend Error", "backendError");
  });
  await assert.rejects(service.getAssetDetail(7, "asset-1"), (error) => error.status === 500 && error.networkId === 7 && error.attempts === 3);
  assert.equal(calls.length, 3, "GET gives up after the maximum number of attempts");
  assert.deepEqual(calls.map((call) => call.timeout), [30000, 30000, 30000], "answered errors do not lengthen the deadline");
});

test("a status PATCH refused with 400 is confirmed by reading the resource back", async () => {
  const refusal = (message, reason) => httpError(400, message, reason);

  // Reference already deactivated (the first answer was lost): the read-back settles the call.
  reset(async (config) => {
    if (config.method === "PATCH") throw refusal("The reference has already been deactivated.", "permanentFailure");
    if (config.method === "GET" && config.url === `${PARTNER_API}/references/ref-1`) return ok({ id: "ref-1", assetId: "asset-1", status: "inactive" });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });
  const settled = await service.patchReferenceStatus(7, "ref-1", "inactive", { releaseClaims: true });
  assert.equal(settled.status, "inactive");
  assert.deepEqual(calls.map((call) => [call.method, call.url.replace(PARTNER_API, "")]), [["PATCH", "/references/ref-1"], ["GET", "/references/ref-1"]]);
  assert.equal(calls[0].params.releaseClaims, true);

  // The read-back disagrees: the original refusal is reported.
  reset(async (config) => {
    if (config.method === "PATCH") throw refusal("The reference has already been deactivated.", "permanentFailure");
    return ok({ id: "ref-1", assetId: "asset-1", status: "active" });
  });
  await assert.rejects(
    service.patchReferenceStatus(7, "ref-1", "inactive"),
    (error) => error.status === 400 && error.reason === "permanentFailure" && error.message === "The reference has already been deactivated."
  );
  assert.equal(calls.length, 2);

  // Reactivating a reference that is already live ("checking" counts as live).
  reset(async (config) => {
    if (config.method === "PATCH") throw refusal("Invalid reference state", "invalidReferenceState");
    return ok({ id: "ref-2", assetId: "asset-1", status: "checking" });
  });
  assert.equal((await service.patchReferenceStatus(7, "ref-2", "active")).status, "checking");

  // Claims: inactive -> inactive is refused; the read-back shows the claim released.
  reset(async (config) => {
    if (config.method === "PATCH") throw refusal("Supported status transitions are pending->inactive and active->inactive", "invalidStatusTransition");
    if (config.method === "GET" && config.url === `${PARTNER_API}/claims/claim-1`) return ok({ id: "claim-1", status: "inactive" });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });
  assert.equal((await service.releaseClaim(7, "claim-1")).status, "inactive");
  assert.equal(calls.length, 2);

  // A failing read-back leaves the original error untouched.
  reset(async (config) => {
    if (config.method === "PATCH") throw refusal("Supported status transitions are pending->inactive and active->inactive", "invalidStatusTransition");
    throw httpError(500, "Backend Error", "backendError");
  });
  await assert.rejects(service.releaseClaim(7, "claim-1"), (error) => error.status === 400 && error.reason === "invalidStatusTransition");
  assert.equal(calls.length, 4, "PATCH once, then the read-back GET exhausts its three attempts");

  // Only a 400 triggers a read-back.
  reset(async () => {
    throw httpError(403, "Forbidden", "forbidden");
  });
  await assert.rejects(service.releaseClaim(7, "claim-1"), (error) => error.status === 403);
  assert.equal(calls.length, 1);
});

test("reference status classifier: live, dead and unknown statuses", () => {
  assert.deepEqual(service.LIVE_REFERENCE_STATUSES, ["active", "activating", "checking", "checking_quota", "computing_fingerprint", "live_streaming_processing"]);
  assert.deepEqual(service.DEAD_REFERENCE_STATUSES, ["inactive", "deactivating", "deleted"]);

  service.LIVE_REFERENCE_STATUSES.forEach((status) => {
    assert.equal(service.isLiveReferenceStatus(status), true, status);
    assert.equal(service.isDeadReferenceStatus(status), false, status);
  });
  service.DEAD_REFERENCE_STATUSES.forEach((status) => {
    assert.equal(service.isDeadReferenceStatus(status), true, status);
    assert.equal(service.isLiveReferenceStatus(status), false, status);
  });
  assert.equal(service.isLiveReferenceStatus(" ACTIVE "), true, "case and whitespace are normalized");
  assert.equal(service.isDeadReferenceStatus("Deactivating"), true);

  ["", null, undefined, "pending", "unknown_status", "duplicate_on_hold"].forEach((status) => {
    assert.equal(service.isLiveReferenceStatus(status), false, `unknown "${status}" is not live`);
    assert.equal(service.isDeadReferenceStatus(status), false, `unknown "${status}" is not dead`);
  });
});

// ---------------------------------------------------------------------------
// Metadata edits
// ---------------------------------------------------------------------------

test("patchAssetMetadata sends the full metadataMine object we own", async () => {
  reset(async (config) => {
    if (config.method === "PATCH" && config.url === `${PARTNER_API}/assets/asset-1`) return ok({ id: "asset-1", ...config.data });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const metadata = { title: "New title", album: "Album", isrc: "VNA122400001", artist: ["A"] };
  const updated = await service.patchAssetMetadata(7, "asset-1", metadata);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data, { metadataMine: metadata });
  assert.equal(calls[0].params.onBehalfOfContentOwner, "OWNER_123");
  assert.equal(updated.metadataMine.title, "New title");

  await assert.rejects(service.patchAssetMetadata(7, "", metadata), /Asset ID is required/);
  await assert.rejects(service.patchAssetMetadata(7, "asset-1", null), /Metadata is required/);
});

// ---------------------------------------------------------------------------
// Reference upload (resumable) + status changes
// ---------------------------------------------------------------------------

test("uploadReferenceStream initiates a resumable session and PUTs the stream to the session URL", async () => {
  const sessionUrl = `${PARTNER_UPLOAD_API}/references?uploadType=resumable&upload_id=abc`;
  reset(async (config) => {
    if (config.method === "POST" && config.url === `${PARTNER_UPLOAD_API}/references`) {
      return { status: 200, headers: { location: sessionUrl }, data: "" };
    }
    if (config.method === "PUT" && config.url === sessionUrl) {
      return ok({ id: "ref-1", assetId: "asset-1", status: "checking", contentType: "audio", length: 12.5 });
    }
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const stream = Readable.from([Buffer.from("fake-audio")]);
  const reference = await service.uploadReferenceStream(7, "asset-1", {
    stream,
    contentLength: 10,
    mimeType: "audio/wav",
    contentType: "audio",
    urgent: false
  });

  assert.deepEqual(reference, { id: "ref-1", assetId: "asset-1", status: "checking", contentType: "audio", length: 12.5 });
  assert.equal(calls.length, 2);

  const initiate = calls[0];
  assert.equal(initiate.params.uploadType, "resumable");
  assert.equal(initiate.params.onBehalfOfContentOwner, "OWNER_123");
  assert.equal(initiate.headers["Content-Type"], "application/json");
  assert.equal(initiate.headers["X-Upload-Content-Type"], "audio/wav");
  assert.equal(initiate.headers["X-Upload-Content-Length"], "10");
  assert.deepEqual(initiate.data, { kind: "youtubePartner#reference", assetId: "asset-1", contentType: "audio", urgent: false });

  const upload = calls[1];
  assert.equal(upload.data, stream);
  assert.equal(upload.headers["Content-Type"], "audio/wav");
  assert.equal(upload.headers["Content-Length"], "10");
  assert.equal(upload.maxBodyLength, Infinity);
  assert.equal(upload.maxContentLength, Infinity);
  assert.equal(upload.timeout, 0);
  assert.equal(upload.validateStatus(308), true);
  assert.equal(upload.validateStatus(500), false);
});

test("uploadReferenceStream treats a 308 as an interrupted upload and validates the size first", async () => {
  reset(async (config) => {
    if (config.method === "POST") return { status: 200, headers: { location: "https://upload.example/session" }, data: "" };
    if (config.method === "PUT") return { status: 308, headers: { range: "bytes=0-4" }, data: "" };
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  await assert.rejects(
    service.uploadReferenceStream(7, "asset-1", { stream: Readable.from([Buffer.from("x")]), contentLength: 1, mimeType: "audio/wav" }),
    /Upload was interrupted/
  );

  reset(async () => {
    throw new Error("should not be called");
  });
  await assert.rejects(
    service.uploadReferenceStream(7, "asset-1", { stream: Readable.from([]), contentLength: 0, mimeType: "audio/wav" }),
    /positive integer/
  );
  await assert.rejects(
    service.uploadReferenceStream(7, "asset-1", { stream: Readable.from([]), contentLength: service.MAX_REFERENCE_BYTES + 1, mimeType: "audio/wav" }),
    (error) => error.status === 413
  );
  assert.equal(calls.length, 0);
});

test("createReferenceFromClaim posts the claim reference without a file", async () => {
  reset(async (config) => {
    if (config.method === "POST" && config.url === `${PARTNER_API}/references`) return ok({ id: "ref-2", status: "active" });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const reference = await service.createReferenceFromClaim(7, "asset-1", "claim-77");
  assert.equal(reference.id, "ref-2");
  assert.equal(calls[0].params.claimId, "claim-77");
  assert.equal(calls[0].data.assetId, "asset-1");
  assert.equal(calls[0].data.contentType, "audio");
});

test("patchReferenceStatus only sends releaseClaims when asked and validates the status", async () => {
  reset(async (config) => {
    if (config.method === "PATCH" && config.url === `${PARTNER_API}/references/ref-1`) {
      return ok({ id: "ref-1", assetId: "asset-1", status: config.data.status });
    }
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const takedown = await service.patchReferenceStatus(7, "ref-1", "inactive", { releaseClaims: true });
  assert.equal(takedown.status, "inactive");
  assert.deepEqual(calls[0].data, { status: "inactive" });
  assert.equal(calls[0].params.releaseClaims, true);
  assert.equal(calls[0].params.onBehalfOfContentOwner, "OWNER_123");

  const reactivate = await service.patchReferenceStatus(7, "ref-1", "ACTIVE");
  assert.equal(reactivate.status, "active");
  assert.deepEqual(calls[1].data, { status: "active" });
  assert.equal(Object.hasOwn(calls[1].params, "releaseClaims"), false);

  const plain = await service.patchReferenceStatus(7, "ref-1", "inactive");
  assert.equal(plain.status, "inactive");
  assert.equal(Object.hasOwn(calls[2].params, "releaseClaims"), false);

  await assert.rejects(service.patchReferenceStatus(7, "ref-1", "deleted"), /active.*inactive/);
  await assert.rejects(service.patchReferenceStatus(7, "", "inactive"), /Reference ID is required/);
  assert.equal(calls.length, 3);
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

test("searchClaimsByAsset walks every page, excludes third-party claims and normalizes items", async () => {
  reset(async (config) => {
    if (config.method === "GET" && config.url === `${PARTNER_API}/claimSearch`) {
      if (!config.params.pageToken) {
        return ok({
          items: [{
            id: "claim-1",
            assetId: "asset-1",
            videoId: "AAAAAAAAAAA",
            status: "ACTIVE",
            contentType: "AUDIO",
            origin: { source: "descriptiveSearch" },
            videoTitle: "Video one",
            timeCreated: "2026-01-01T00:00:00Z",
            timeStatusLastModified: "2026-01-02T00:00:00Z"
          }],
          nextPageToken: "page-2"
        });
      }
      return ok({ items: [{ id: "claim-2", videoId: "BBBBBBBBBBB", status: "pending", contentType: "audiovisual", origin: "webUpload" }] });
    }
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const claims = await service.searchClaimsByAsset(7, "asset-1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.assetId, "asset-1");
  assert.equal(calls[0].params.includeThirdPartyClaims, false);
  assert.equal(Object.hasOwn(calls[0].params, "status"), false);
  assert.equal(calls[1].params.pageToken, "page-2");
  assert.deepEqual(claims, [
    {
      claim_id: "claim-1",
      video_id: "AAAAAAAAAAA",
      status: "active",
      content_type: "audio",
      origin: "descriptiveSearch",
      video_title: "Video one",
      time_created: "2026-01-01T00:00:00Z",
      time_status_last_modified: "2026-01-02T00:00:00Z"
    },
    {
      claim_id: "claim-2",
      video_id: "BBBBBBBBBBB",
      status: "pending",
      content_type: "audiovisual",
      origin: "webUpload",
      video_title: "",
      time_created: "",
      time_status_last_modified: ""
    }
  ]);

  reset(async () => ok({ items: [] }));
  await service.searchClaimsByAsset(7, "asset-1", { status: "active" });
  assert.equal(calls[0].params.status, "active");
});

test("releaseClaim patches the claim to inactive on the partner host", async () => {
  reset(async (config) => {
    if (config.method === "PATCH" && config.url === `${PARTNER_API}/claims/claim-1`) return ok({ id: "claim-1", status: "inactive" });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const released = await service.releaseClaim(7, "claim-1");
  assert.equal(released.status, "inactive");
  assert.deepEqual(calls[0].data, { status: "inactive" });
  assert.equal(calls[0].params.onBehalfOfContentOwner, "OWNER_123");
  await assert.rejects(service.releaseClaim(7, ""), /Claim ID is required/);
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

test("searchAssetsByIsrc chunks 50 ISRCs per request and maps matches by ISRC", async () => {
  reset(async (config) => {
    if (config.method === "GET" && config.url === `${PARTNER_API}/assetSearch`) {
      const first = config.params.isrcs.split(",")[0];
      return ok({ items: [{ id: `asset-${first}`, title: "Existing", isrc: first, customId: "X", type: "sound_recording", timeCreated: "2025-01-01T00:00:00Z" }] });
    }
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const codes = Array.from({ length: 60 }, (_, index) => `VNA1224${String(index).padStart(5, "0")}`);
  const matches = await service.searchAssetsByIsrc(7, codes);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.ownershipRestriction, "NONE");
  assert.equal(calls[0].params.isrcs.split(",").length, 50);
  assert.equal(calls[1].params.isrcs.split(",").length, 10);
  assert.equal(matches.size, 2);
  assert.deepEqual(matches.get(codes[0]), [{
    asset_id: `asset-${codes[0]}`,
    title: "Existing",
    isrc: codes[0],
    custom_id: "X",
    type: "sound_recording",
    time_created: "2025-01-01T00:00:00Z"
  }]);
  assert.deepEqual(await service.searchAssetsByIsrc(7, []), new Map());
});

test("listReferences and getAssetDetail use the documented query parameters", async () => {
  reset(async (config) => {
    if (config.method === "GET" && config.url === `${PARTNER_API}/references`) {
      if (!config.params.pageToken) return ok({ items: [{ id: "ref-1", status: "active" }], nextPageToken: "n" });
      return ok({ items: [{ id: "ref-2", status: "inactive" }] });
    }
    if (config.method === "GET" && config.url === `${PARTNER_API}/assets/asset-1`) return ok({ id: "asset-1", status: "active" });
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const references = await service.listReferences(7, "asset-1");
  assert.deepEqual(references.map((item) => item.id), ["ref-1", "ref-2"]);
  assert.equal(calls[0].params.assetId, "asset-1");

  const asset = await service.getAssetDetail(7, "asset-1");
  assert.equal(asset.status, "active");
  assert.deepEqual(calls[2].params, {
    onBehalfOfContentOwner: "OWNER_123",
    fetchMetadata: "mine",
    fetchOwnership: "mine",
    fetchMatchPolicy: "mine"
  });
});

test("getDeliveryOptions collects policies, labels and owner info without uploaders and isolates failures", async () => {
  reset(async (config) => {
    if (config.url === `${PARTNER_API}/policies`) {
      return ok({ items: [
        { id: "p2", name: "Track in all countries", rules: [{ action: "track" }] },
        { id: "p1", name: "Monetize in all countries", rules: [{ action: "monetize" }], timeUpdated: "2026-01-01T00:00:00Z" }
      ] });
    }
    if (config.url === `${PARTNER_API}/assetLabels`) {
      if (!config.params.pageToken) return ok({ items: [{ labelName: "Pop" }], nextPageToken: "next" });
      return ok({ items: [{ labelName: "ANS" }] });
    }
    if (config.url === `${PARTNER_API}/contentOwners`) throw httpError(403, "Owner access denied", "forbidden");
    throw new Error(`Unexpected ${config.method} ${config.url}`);
  });

  const options = await service.getDeliveryOptions(7);
  assert.deepEqual(options.network, { id: 7, name: "Primary CMS", network_code: "OWNER_123", cms_auth_email: "cms@example.com" });
  assert.equal(options.content_owner, null);
  assert.deepEqual(options.policies.map((policy) => policy.id), ["p1", "p2"]);
  assert.equal(options.policies[0].summary, "Monetize (WW)");
  assert.deepEqual(options.asset_labels, ["ANS", "Pop"]);
  assert.equal(Object.hasOwn(options, "uploaders"), false);
  assert.deepEqual(options.errors, { content_owner: "Owner access denied" });
  assert.equal(calls.some((call) => call.url === `${PARTNER_API}/uploader`), false);
  assert.equal(calls.filter((call) => call.url === `${PARTNER_API}/assetLabels`).length, 2);
});

test("service errors never expose the access token", async () => {
  reset(async () => {
    const error = httpError(401, "Invalid Credentials", "authError");
    error.config = { headers: { Authorization: "Bearer fresh-token" } };
    throw error;
  });

  await assert.rejects(service.listPolicies(7), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.reason, "authError");
    assert.equal(error.config, undefined);
    assert.equal(error.response, undefined);
    assert.doesNotMatch(JSON.stringify(error), /fresh-token/);
    return true;
  });
});
