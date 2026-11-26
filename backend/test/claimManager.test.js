// Claim Manager: lookups (videos / assets / claim ids / explore), label restrictions, release
// outcomes with the audit trail, re-check and history, plus the controller's error mapping.
process.env.CONTENT_ID_RETRY_BASE_MS = "1";
// The preview cap is clamped to 50 or more; the lowest value keeps the cap test small.
process.env.CONTENT_ID_MAX_PREVIEW_VIDEOS = "50";
// The budget test counts on three release workers.
process.env.CONTENT_ID_WRITE_CONCURRENCY = "3";
// Three videos per claimSearch batch: a four-video lookup spans two batches, which is the only way
// to observe that a batch error is attributed to its own videos (the default of 50 never splits).
process.env.CONTENT_ID_CLAIM_SEARCH_BATCH = "3";
// A conflict retry waits 1.5 s in production; the tests only need the retry itself.
process.env.CONTENT_ID_CONFLICT_RETRY_MS = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const databaseSource = fs.readFileSync(path.join(__dirname, "../src/config/database.js"), "utf8");

function extractCreateTable(name) {
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`);
  const match = databaseSource.match(pattern);
  if (!match) throw new Error(`CREATE TABLE ${name} not found in database.js`);
  return match[0];
}

const memoryDb = new Database(":memory:");
["users", "networks", "content_id_labels", "user_content_id_labels", "content_id_claim_events",
  "ownership_channels", "ownership_channel_owners", "ownership_api_keys"].forEach((name) => memoryDb.exec(extractCreateTable(name)));
(databaseSource.match(/ALTER TABLE networks ADD COLUMN [^"]+/g) || []).forEach((sql) => {
  try { memoryDb.exec(sql); } catch { /* column already part of CREATE TABLE */ }
});
(databaseSource.match(/CREATE INDEX IF NOT EXISTS idx_cid_claim_events_\w+ ON [^;"]+/g) || []).forEach((sql) => memoryDb.exec(sql));

const PARTNER_SCOPE = "https://www.googleapis.com/auth/youtubepartner";
memoryDb.prepare("INSERT INTO users (id, full_name, email, password, role) VALUES (1, 'Tester', 'tester@example.com', 'x', 'admin')").run();
memoryDb.prepare("INSERT INTO users (id, full_name, email, password, role) VALUES (2, 'Limited', 'limited@example.com', 'x', 'Claim Manager')").run();
const insertNetwork = memoryDb.prepare(`
  INSERT INTO networks (id, name, network_code, cms_auth_status, cms_auth_email, cms_auth_scopes, cms_access_token, cms_refresh_token, cms_token_expiry)
  VALUES (?, ?, ?, 'connected', ?, ?, ?, ?, ?)
`);
const fresh = new Date(Date.now() + 3600000).toISOString();
insertNetwork.run(7, "Primary CMS", "OWNER_7", "cms7@example.com", `${PARTNER_SCOPE} openid`, "token-7", "refresh-7", fresh);
insertNetwork.run(8, "No Scope CMS", "OWNER_8", "cms8@example.com", "openid", "token-8", "refresh-8", fresh);
insertNetwork.run(9, "Broken CMS", "OWNER_9", "cms9@example.com", PARTNER_SCOPE, "token-9", "bad", new Date(Date.now() - 1000).toISOString());
memoryDb.prepare("INSERT INTO content_id_labels (id, name, display_name) VALUES (1, 'ANS', 'ANS Music')").run();
memoryDb.prepare("INSERT INTO user_content_id_labels (user_id, label_id) VALUES (2, 1)").run();

const PARTNER_API = "https://youtubepartner.googleapis.com/youtube/partner/v1";
const ADMIN = { id: 1, full_name: "Tester", email: "tester@example.com", roles: ["admin"] };
const LIMITED = { id: 2, full_name: "Limited", email: "limited@example.com", roles: ["Claim Manager"] };
const QUOTA_MESSAGE = "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'";

// The controller logs 424/429/502/504 answers and every 500 reference; the lines are collected
// so tests can assert on them without noise in the test output.
const logged = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  logged.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" "));
};

const calls = [];
const youtubeCalls = [];
const patchTimeline = []; // { id, started, ended } per PATCH, to check what overlapped
const abortedOnce = new Set(); // claim ids whose first PATCH Google aborted (409)
const cms = {
  authFail: false,
  rateLimit: false,
  quotaFail: false,
  serverError: false,
  assetsFail: false,
  timeoutAll: false,
  historyFails: false,
  videoMetadataFails: false,
  endlessAssetPages: false,
  patchDelayMs: 0,
  claimGetTimeouts: new Set(),
  patchBehaviour: {},
  refreshFailure: null, // "timeout" | "server_error" | "reset" | "rate_limit" | "invalid_client": how the refresh of the "flaky" token fails
  claimListFails: false, // true -> 500, "forbidden" -> 403
  claimListDelayOnce: 0, // ms added to the next claims.list answer only
  failVideoBatches: new Set(),
  snippets: [],
  claims: new Map(),
  assets: new Map(),
  explorePages: {}
};

function ok(data) {
  return { status: 200, headers: {}, data };
}

function httpError(status, message, reason, headers = {}) {
  const error = new Error(message);
  error.response = { status, headers, data: { error: { message, errors: reason ? [{ reason }] : [] } } };
  return error;
}

// Google's token endpoint answers { error: "<oauth code>", error_description: "…" }.
function oauthError(status, code, description, headers = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, headers, data: { error: code, error_description: description } };
  return error;
}

function timeoutError(config) {
  return Object.assign(new Error(`timeout of ${config.timeout}ms exceeded`), { code: "ECONNABORTED" });
}

// The socket dropped after the request went out: no HTTP answer, Google may have applied it.
function socketError() {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetFixtures() {
  calls.length = 0;
  youtubeCalls.length = 0;
  patchTimeline.length = 0;
  abortedOnce.clear();
  cms.authFail = false;
  cms.rateLimit = false;
  cms.quotaFail = false;
  cms.serverError = false;
  cms.assetsFail = false;
  cms.timeoutAll = false;
  cms.historyFails = false;
  cms.videoMetadataFails = false;
  cms.endlessAssetPages = false;
  cms.patchDelayMs = 0;
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};
  cms.refreshFailure = null;
  cms.claimListFails = false;
  cms.claimListDelayOnce = 0;
  cms.failVideoBatches = new Set();
  cms.snippets = [
    { id: "C-ok", videoId: "AAAAAAAAAAA", videoTitle: "Song A (CMS title)", assetId: "AS1", status: "active", contentType: "audio", origin: { source: "audioMatch" }, isPartnerUploaded: false, timeCreated: "2026-09-01T00:00:00Z", timeStatusLastModified: "2026-09-02T00:00:00Z", videoViews: "1200", engagedViews: "34", studioInfo: { claimDetailsUrl: "https://studio.youtube.com/claim/C-ok" } },
    { id: "C-inactive", videoId: "AAAAAAAAAAA", assetId: "AS1", status: "inactive", contentType: "audio", origin: { source: "videoMatch" }, timeCreated: "2026-08-01T00:00:00Z" },
    { id: "C-other", videoId: "BBBBBBBBBBB", videoTitle: "Clip B", assetId: "AS2", status: "pending", contentType: "audiovisual", origin: { source: "descriptiveSearch" }, thirdPartyClaim: true, isPartnerUploaded: true, timeCreated: "2026-09-03T00:00:00Z" },
    { id: "C-disputed", videoId: "BBBBBBBBBBB", assetId: "AS1", status: "disputed", contentType: "video", origin: { source: "melodyMatch" }, timeCreated: "2026-09-04T00:00:00Z" },
    { id: "C-manual", videoId: "CCCCCCCCCCC", assetId: "AS1", status: "manual_review", contentType: "audio", origin: { source: "audioMatch" }, timeCreated: "2026-09-05T00:00:00Z" }
  ];
  const full = (snippet, extra = {}) => ({
    ...snippet,
    policy: { id: "P1", name: "Monetize in all countries", rules: [{ action: "monetize" }] },
    appliedPolicy: { id: "P1", name: "Monetize in all countries", rules: [{ action: "monetize" }] },
    matchInfo: {
      referenceId: "R1",
      longestMatch: { durationSecs: "42.5", userVideoOffset: "10", referenceOffset: "0" },
      totalMatch: { userVideoDurationSecs: "42.5", referenceDurationSecs: "42.5" },
      // Segments are milliseconds on the wire (uint64 strings); manual segments have start/finish.
      matchSegments: [
        { channel: "Audio", video_segment: { start: "10000", duration: "42500" }, reference_segment: { start: "0", duration: "42500" } },
        { channel: "Audio", manual_segment: { start: "5000", finish: "20000" } }
      ]
    },
    blockOutsideOwnership: false,
    ugcType: "standard",
    ...extra
  });
  cms.claims = new Map();
  cms.snippets.forEach((snippet) => cms.claims.set(snippet.id, full(snippet)));
  ["C-timeout", "C-timeout-live", "C-refused", "C-forbidden", "C-429", "C-later", "C-reset", "C-reset-lost", "C-quota", "C-conflict", "C-empty"].forEach((id) => {
    cms.claims.set(id, full({ id, videoId: "DDDDDDDDDDD", assetId: "AS1", status: "active", contentType: "audio", origin: { source: "audioMatch" }, timeCreated: "2026-09-06T00:00:00Z" }));
  });
  cms.claims.set("C-foreign", full({ id: "C-foreign", videoId: "EEEEEEEEEEE", assetId: "AS2", status: "active", contentType: "audio", origin: { source: "audioMatch" }, timeCreated: "2026-09-07T00:00:00Z" }));
  cms.assets = new Map([
    ["AS1", { id: "AS1", type: "sound_recording", label: ["ANS", "Pop"], metadataEffective: { title: "Song A", customId: "ANS_1", isrc: "vna122400001", upc: "0123456789012", artist: ["Artist A", "Artist B"] } }],
    ["AS2", { id: "AS2", type: "web", label: ["Other"], metadataEffective: { title: "Clip B", customId: "OTHER_2" } }]
  ]);
  cms.explorePages = {
    "": { items: [cms.snippets[0], cms.snippets[2]], nextPageToken: "page-2" },
    "page-2": { items: [cms.snippets[3]], previousPageToken: "" }
  };
}
resetFixtures();

// claimSearch takes the enum names of the discovery document; the resources report lowercase
// values and spell ROUTED_FOR_REVIEW "manual_review".
function resourceStatus(enumName) {
  if (!enumName) return "";
  return enumName === "ROUTED_FOR_REVIEW" ? "manual_review" : String(enumName).toLowerCase();
}

const fakeAxios = {
  async request(config) {
    calls.push(config);
    const { method, url, params = {} } = config;
    const p = url.startsWith(PARTNER_API) ? url.slice(PARTNER_API.length) : url;
    if (cms.authFail) throw httpError(401, "Invalid Credentials", "authError");
    if (cms.rateLimit) throw httpError(429, "Rate limit exceeded", "rateLimitExceeded", { "retry-after": "0" });
    if (cms.quotaFail) throw httpError(403, QUOTA_MESSAGE, "quotaExceeded");
    if (cms.serverError) throw httpError(500, "Backend Error", "backendError");
    if (cms.timeoutAll) throw timeoutError(config);

    if (method === "GET" && p === "/claimSearch") {
      if (params.videoId) {
        const wanted = new Set(String(params.videoId).split(","));
        if ([...wanted].some((id) => cms.failVideoBatches.has(id))) throw httpError(500, "Backend Error", "backendError");
        const wantedStatus = resourceStatus(params.status);
        const items = cms.snippets.filter((item) => wanted.has(item.videoId) && (!wantedStatus || item.status === wantedStatus));
        return ok({ items });
      }
      if (params.assetId) {
        const items = cms.snippets.filter((item) => item.assetId === params.assetId);
        if (cms.endlessAssetPages) return ok({ items, nextPageToken: `more-${String(params.pageToken || "").length + 1}` });
        if (params.assetId === "AS1" && !params.pageToken) return ok({ items, nextPageToken: "more" });
        if (params.pageToken === "more") return ok({ items: [], nextPageToken: "" });
        return ok({ items });
      }
      const page = cms.explorePages[params.pageToken || ""] || { items: [] };
      return ok(page);
    }
    if (method === "GET" && p === "/ownershipHistory" && params.assetId === "AS2") {
      return ok({ items: [
        { origination: { owner: "UPLOAD_OWNER" }, ownership: { general: [{ territories: ["US"] }] } },
        { origination: { owner: "FORMER_OWNER" }, ownership: { general: [] } }
      ] });
    }
    if (method === "GET" && p === "/contentOwners/UPLOAD_OWNER") {
      return ok({ id: "UPLOAD_OWNER", displayName: "Upload owner", conflictNotificationEmail: "ownership@example.com" });
    }
    if (method === "GET" && p === "/contentOwners" && params.id) {
      const owner = { id: "UPLOAD_OWNER", displayName: "Upload owner", conflictNotificationEmail: "ownership@example.com" };
      return ok({ items: params.id.split(",").includes(owner.id) ? [owner] : [] });
    }
    if (method === "GET" && p === "/contentOwners/OTHER_OWNER") throw httpError(404, "Owner unavailable", "notFound");
    if (method === "GET" && p === "/assetSearch" && params.metadataSearchFields === "artist:Thanh Nhuong") {
      if (params.ownershipRestriction === "MINE") {
        if (params.pageToken === "more-owned") return ok({ items: [{ id: "AS2" }] });
        return ok({ items: [{ id: "AS1" }], nextPageToken: "more-owned" });
      }
      if (params.pageToken === "second-page") return ok({ items: [{ id: "AS3", title: "Second asset" }], pageInfo: { totalResults: 2 } });
      return ok({
        items: [{ id: "AS2", title: "Merged asset", isrc: "ISRC1", isrcs: ["ISRC1", "ISRC2"] }],
        pageInfo: { totalResults: 2 },
        nextPageToken: "second-page"
      });
    }
    if (method === "GET" && p === "/assets/AS2") {
      return ok({
        id: "AS2",
        metadataEffective: { title: "Merged asset", artist: ["Artist A", "Artist B"] },
        ownership: { general: [{ owner: "FORMER_OWNER", territories: ["US"] }] },
        ownershipEffective: {
          general: [{ owner: "UPLOAD_OWNER", territories: ["US", "VN"] }, { owner: "FORMER_OWNER", territories: [] }],
          performance: [{ owner: "UPLOAD_OWNER", territories: ["VN"] }]
        }
      });
    }
    // The claims resource (claims.list / claims.get) has no snippet-only fields.
    const asResource = ({ videoTitle, thirdPartyClaim, videoViews, engagedViews, ...rest }) => rest;
    if (method === "GET" && p === "/claims") {
      if (cms.claimListDelayOnce) {
        const delay = cms.claimListDelayOnce;
        cms.claimListDelayOnce = 0;
        await sleep(delay);
      }
      if (cms.claimListFails === "forbidden") throw httpError(403, "The caller does not have permission", "forbidden");
      if (cms.claimListFails) throw httpError(500, "Backend Error", "backendError");
      const wanted = String(params.id || "").split(",");
      return ok({ items: wanted.map((id) => cms.claims.get(id)).filter(Boolean).map(asResource) });
    }
    const claimGet = p.match(/^\/claims\/([^/?]+)$/);
    if (method === "GET" && claimGet) {
      const id = decodeURIComponent(claimGet[1]);
      if (cms.claimGetTimeouts.has(id)) throw timeoutError(config);
      const claim = cms.claims.get(id);
      if (!claim) throw httpError(404, "Claim not found", "notFound");
      return ok(asResource(claim));
    }
    if (method === "PATCH" && claimGet) {
      const id = decodeURIComponent(claimGet[1]);
      if (!cms.claims.has(id)) throw httpError(404, "Claim not found", "notFound");
      const timeline = { id, started: Date.now(), ended: null };
      patchTimeline.push(timeline);
      if (cms.patchDelayMs) await sleep(cms.patchDelayMs);
      timeline.ended = Date.now();
      const wantedStatus = String(config.data?.status || "inactive");
      let behaviour = cms.patchBehaviour[id] || "ok";
      if (behaviour === "apply_silently_then_refuse") {
        // Attempt 1: Google applies the write but the answer is lost. Attempt 2: refused, already there.
        const claim = cms.claims.get(id);
        if (claim.status !== wantedStatus) {
          claim.status = wantedStatus;
          throw timeoutError(config);
        }
        throw httpError(400, "Supported status transitions are pending->inactive and active->inactive", "invalidStatusTransition");
      }
      if (behaviour === "aborted_once") {
        // Google's answer when two writes touched claims of the same video at the same time.
        if (!abortedOnce.has(id)) {
          abortedOnce.add(id);
          throw httpError(409, "The operation was aborted.", "aborted");
        }
        behaviour = "ok";
      }
      if (behaviour === "timeout") throw timeoutError(config);
      if (behaviour === "auth") throw httpError(401, "Invalid Credentials", "authError");
      if (behaviour === "forbidden") throw httpError(403, "The caller does not have permission", "forbidden");
      if (behaviour === "quota") throw httpError(403, QUOTA_MESSAGE, "quotaExceeded");
      if (behaviour === "conflict") throw httpError(409, "The claim is being modified by another request", "conflict");
      if (behaviour === "rate_limit") throw httpError(429, "Rate limit exceeded", "rateLimitExceeded", { "retry-after": "0" });
      if (behaviour === "reset_lost") throw socketError();
      const claim = cms.claims.get(id);
      if (behaviour === "refuse_disputed") {
        // The claim changed status since the pre-read: Google refuses the transition.
        claim.status = "disputed";
        throw httpError(400, "Supported status transitions are pending->inactive and active->inactive", "invalidStatusTransition");
      }
      claim.status = wantedStatus;
      if (behaviour === "flip_active_then_refuse") {
        // Someone set the claim active between the pre-read and this call: Google refuses the stale write.
        cms.claims.get(id).status = "active";
        throw httpError(400, "Supported status transitions are pending->inactive and active->inactive", "invalidStatusTransition");
      }
      if (behaviour === "refuse_then_inactive") throw httpError(400, "Supported status transitions are pending->inactive and active->inactive", "invalidStatusTransition");
      if (behaviour === "reset") throw socketError();
      if (behaviour === "empty") return ok({ id });
      return ok({ id, videoId: claim.videoId, assetId: claim.assetId, status: wantedStatus, timeStatusLastModified: "2026-10-06T00:00:00Z" });
    }
    if (method === "GET" && p === "/assets") {
      if (cms.assetsFail) throw httpError(500, "Backend Error", "backendError");
      const wanted = String(params.id || "").split(",");
      return ok({ items: wanted.map((id) => cms.assets.get(id)).filter(Boolean) });
    }
    const history = p.match(/^\/claimHistory\/([^/?]+)$/);
    if (method === "GET" && history) {
      if (cms.historyFails) throw httpError(500, "Backend Error", "backendError");
      return ok({ id: history[1], event: [
        { time: "2026-09-01T00:00:00Z", type: "claim_create", source: { type: "cms_user", userEmail: "ops@example.com", contentOwnerId: "OWNER_7" } },
        { time: "2026-09-02T00:00:00Z", type: "claim_update", reason: "closed_manually", source: { type: "yt_admin" }, typeDetails: { updateStatus: "active" } }
      ] });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }
};

const fakeYoutube = {
  async getVideosMetadataFromYoutube(ids) {
    youtubeCalls.push([...ids]);
    if (cms.videoMetadataFails) throw new Error("quotaExceeded");
    const byId = {};
    ids.forEach((id) => {
      if (id === "AAAAAAAAAAA") byId[id] = { video_id: id, title: "Song A on YouTube", channel_id: "UC1", channel_title: "Channel A", thumbnail: "https://i.ytimg.com/a.jpg", duration_text: "3:21", published_at: "2025-01-01T00:00:00Z", url: `https://www.youtube.com/watch?v=${id}` };
    });
    return byId;
  }
};

const originalLoad = Module._load;
Module._load = function loadWithClaimFakes(request, parent, isMain) {
  if (request === "axios") return fakeAxios;
  if (request === "../config/database") return memoryDb;
  if (request === "./youtubeService") return fakeYoutube;
  if (request === "./googleCmsAuthService") {
    return {
      refreshAccessToken: async (refreshToken) => {
        if (refreshToken === "bad") throw oauthError(400, "invalid_grant", "Token has been expired or revoked.");
        if (refreshToken === "flaky") {
          if (cms.refreshFailure === "timeout") throw timeoutError({ timeout: 20000 });
          if (cms.refreshFailure === "server_error") throw httpError(500, "Backend Error", "backendError");
          if (cms.refreshFailure === "reset") throw socketError();
          if (cms.refreshFailure === "rate_limit") throw oauthError(429, "rate_limit_exceeded", "Too many requests", { "retry-after": "7" });
          if (cms.refreshFailure === "invalid_client") throw oauthError(401, "invalid_client", "The OAuth client was not found.");
        }
        return { access_token: "refreshed", expires_in: 3600 };
      }
    };
  }
  if (request === "../middlewares/authMiddleware") {
    return {
      SUPER_ADMIN_ROLES: ["supper admin", "super admin"],
      parseRoles: (value) => (Array.isArray(value) ? value : [value].filter(Boolean))
    };
  }
  return originalLoad(request, parent, isMain);
};
const service = require("../src/services/claimManagerService");
const assetCheck = require("../src/services/assetCheckService");
const controller = require("../src/controllers/claimManagerController");
Module._load = originalLoad;

function callsTo(method, pattern) {
  return calls.filter((item) => item.method === method && pattern.test(item.url));
}

function makeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.send = (payload) => { res.body = payload; return res; };
  res.set = (name, value) => { res.headers[String(name).toLowerCase()] = value; return res; };
  res.setHeader = res.set;
  return res;
}

async function call(handler, req = {}) {
  const res = makeRes();
  await handler({ params: {}, query: {}, body: {}, user: ADMIN, ...req }, res);
  return res;
}

test("ownership email keeps same-title candidates separate from the channel manager and match claims", async (t) => {
  const delivery = require("../src/services/assetDeliveryService");
  const videoId = "abcdefghijk";
  const channelId = "UC" + "a".repeat(22);
  const seen = [];
  let referenceAvailable = false;
  t.mock.method(delivery, "partnerRequest", async (_ctx, method, path, { params }) => {
    assert.equal(method, "GET");
    seen.push(path);
    if (path.endsWith("/channels")) return { data: { items: [{ id: channelId, snippet: { title: "Channel" },
      contentDetails: { relatedPlaylists: { uploads: "uploads" } }, contentOwnerDetails: {} }] } };
    if (path.endsWith("/playlistItems")) {
      assert.equal(params.pageToken, "older");
      return { data: { items: [{ contentDetails: { videoId } }], nextPageToken: "more" } };
    }
    if (path.endsWith("/videos")) return { data: { items: [{ id: videoId, snippet: { channelId, title: "Video: title!" } }] } };
    if (path === "/claimSearch") return { data: { items: [
      { videoId, assetId: "song", isPartnerUploaded: true, origin: { source: "audioMatch" }, status: "active" },
      { videoId, assetId: "former", origin: "cmsUpload", status: "inactive" }
    ] } };
    if (path === "/assetSearch") return { data: { items: [{ id: "good", title: "Video title" }, { id: "other", title: "Video title remix" }] } };
    if (path === "/assets/good") return { data: { id: "good", metadataEffective: { title: "Video title" },
      ownershipEffective: { general: [{ owner: "assetOwner", territories: ["VN"] }] } } };
    if (path === "/references") {
      if (!referenceAvailable) throw Object.assign(new Error("private"), { status: 403 });
      return { data: params.pageToken ? { items: [{ videoId }] } : { nextPageToken: "more-references" } };
    }
    if (path === "/contentOwners/assetOwner") return { data: { displayName: "Asset owner", conflictNotificationEmail: "rights@example.com" } };
    throw new Error("Unexpected path " + path);
  });
  const res = await call(controller.checkOwnershipEmail, { query: { network_id: 7, id: channelId, page_token: "older" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.channel.manager, null);
  assert.equal(res.body.next_page_token, "more");
  assert.deepEqual(res.body.owners.map((owner) => [owner.cms_name, owner.email, owner.evidence]), [
    ["Asset owner", "rights@example.com", "title"]
  ]);
  assert.equal(res.body.channel_owner_count, 1);
  assert.deepEqual(res.body.videos[0].assets.map((a) => [a.id, a.evidence, a.owners[0].email]), [["good", "title", "rights@example.com"]]);
  assert.deepEqual(res.body.videos[0].warnings, []);
  assert.ok(!seen.some((url) => url.includes("former") || url.includes("song")));
  const { findChannelContact } = require("../src/services/ownershipDirectory");
  assert.equal(findChannelContact(channelId, "Asset owner"), null);
  referenceAvailable = true;
  const verified = await call(controller.checkOwnershipEmail, { query: { network_id: 7, id: videoId } });
  assert.equal(verified.body.videos[0].assets[0].evidence, "reference_video");
  assert.equal(verified.body.channel_owner_count, 1);
  assert.equal(verified.body.owners[0].evidence, "reference_video");
  assert.equal(findChannelContact(channelId, "Asset owner").email, "rights@example.com");
  assert.equal(verified.body.channel.manager, null);
});

test("ownership email attributes a visible manager and an active upload to their respective owners", async (t) => {
  const delivery = require("../src/services/assetDeliveryService");
  const id = "01234567890";
  const channelId = "UC" + "b".repeat(22);
  t.mock.method(delivery, "partnerRequest", async (_ctx, _method, path, { params }) => {
    if (path.endsWith("/videos")) return { data: { items: [{ id, snippet: { channelId, title: "Video" } }] } };
    if (path.endsWith("/channels")) return { data: { items: [{ id: channelId, contentOwnerDetails: { contentOwner: "manager" } }] } };
    if (path === "/contentOwners/manager") return { data: { displayName: "Channel network" } };
    if (path === "/claimSearch") {
      assert.equal(params.includeThirdPartyClaims, true);
      assert.equal(params.status, "ACTIVE");
      return { data: { items: [{ videoId: id, assetId: "upload", origin: "cmsUpload", status: "active" }] } };
    }
    if (path === "/assets/upload") return { data: { id: "upload", ownershipEffective: {
      general: [{ owner: "uploader", territories: ["US"] }] } } };
    if (path === "/contentOwners/uploader") return { data: { displayName: "Asset owner", conflictNotificationEmail: "upload@example.com" } };
    throw new Error("Unexpected path " + path);
  });
  const res = await call(controller.checkOwnershipEmail, { query: { network_id: 7, id } });
  assert.equal(res.body.channel.manager.name, "Channel network");
  assert.equal(res.body.channel_owner_count, 2);
  assert.equal(res.body.channel.manager.email, null);
  assert.equal(res.body.videos[0].assets[0].evidence, "upload_claim");
  assert.equal(res.body.videos[0].assets[0].owners[0].email, "upload@example.com");
  assert.deepEqual(res.body.videos[0].warnings, []);
  const invalid = await call(controller.checkOwnershipEmail, { query: { network_id: 7, id: "bad" } });
  assert.equal(invalid.statusCode, 400);
});

test("public channel scan checks linked uploads first, propagates nested token errors and reuses verified ownership", async (t) => {
  const delivery = require("../src/services/assetDeliveryService");
  const { lookupOwnershipEmail } = require("../src/services/ownershipEmailService");
  const { findChannelContact } = require("../src/services/ownershipDirectory");
  const id = "UC" + "q".repeat(22);
  const linked = "01234567890";
  const other = "abcdefghijk";
  const calls = [];
  let rejectContact = true;
  t.mock.method(delivery, "partnerRequest", async (_ctx, _method, path) => {
    calls.push(path);
    if (path.endsWith("/channels")) return { data: { items: [{ id, contentDetails: { relatedPlaylists: { uploads: "uploads" } } }] } };
    if (path.endsWith("/playlistItems")) return { data: { items: [other, linked].map((videoId) => ({ contentDetails: { videoId } })) } };
    if (path.endsWith("/videos")) return { data: { items: [other, linked].map((videoId) => ({ id: videoId, snippet: { title: "Video", channelId: id } })) } };
    if (path === "/claimSearch") return { data: { items: [{ videoId: linked, assetId: "upload", origin: "cmsUpload", status: "active" }] } };
    if (path === "/assets/upload") return { data: { id: "upload", ownershipEffective: { general: [{ owner: "owner", territories: ["VN"] }] } } };
    if (path === "/contentOwners/owner") {
      if (rejectContact) throw Object.assign(new Error("CMS token rejected"), { cmsAuthFailed: true });
      return { data: { displayName: "Requested CMS", conflictNotificationEmail: "rights@example.org" } };
    }
    throw new Error("Unexpected " + path);
  });
  const run = () => lookupOwnershipEmail({ networkId: 7, id, scan: {
    signal: new AbortController().signal, contacts: new Map(), assets: new Map(), target: "requested cms"
  } });
  await assert.rejects(run(), { cmsAuthFailed: true });
  rejectContact = false;
  const result = await run();
  assert.deepEqual(result.videos.map((video) => video.id), [linked]);
  assert.equal(findChannelContact(id, "requested cms").email, "rights@example.org");
  assert.ok(!calls.includes("/assetSearch"));
});

function eventRows(where = "1 = 1", ...params) {
  return memoryDb.prepare(`SELECT * FROM content_id_claim_events WHERE ${where} ORDER BY id`).all(...params);
}

function authStatus(networkId) {
  return memoryDb.prepare("SELECT cms_auth_status FROM networks WHERE id = ?").get(networkId).cms_auth_status;
}

// Every test starts from the same CMS fixtures, an empty audit table, connected networks and an
// empty asset cache; tests that need audit rows seed them themselves.
test.beforeEach(() => {
  resetFixtures();
  logged.length = 0;
  memoryDb.prepare("DELETE FROM content_id_claim_events").run();
  memoryDb.prepare("UPDATE networks SET cms_auth_status = 'connected', cms_auth_error = NULL").run();
  service.clearAssetCache();
});
test.after(() => {
  console.error = originalConsoleError;
  memoryDb.close();
});

// ---------------------------------------------------------------------------
// Parsing and normalisation
// ---------------------------------------------------------------------------

test("video inputs accept every YouTube URL shape, dedupe ids and report invalid lines", () => {
  assert.equal(service.extractVideoId("https://www.youtube.com/watch?v=AAAAAAAAAAA&t=10s"), "AAAAAAAAAAA");
  assert.equal(service.extractVideoId("https://youtu.be/AAAAAAAAAAA?si=abc"), "AAAAAAAAAAA");
  assert.equal(service.extractVideoId("https://www.youtube.com/shorts/BBBBBBBBBBB"), "BBBBBBBBBBB");
  assert.equal(service.extractVideoId("https://youtube.com/live/CCCCCCCCCCC?feature=share"), "CCCCCCCCCCC");
  assert.equal(service.extractVideoId("https://www.youtube.com/embed/DDDDDDDDDDD"), "DDDDDDDDDDD");
  assert.equal(service.extractVideoId("m.youtube.com/watch?v=EEEEEEEEEEE"), "EEEEEEEEEEE");
  assert.equal(service.extractVideoId("AAAAAAAAAAA"), "AAAAAAAAAAA");
  assert.equal(service.extractVideoId("https://youtu.be/too-short"), null);
  assert.equal(service.extractVideoId("https://example.com/watch?v=AAAAAAAAAAA"), "AAAAAAAAAAA", "unknown hosts still fall back to the v= pattern");
  assert.equal(service.extractVideoId("not a video"), null);

  const parsed = service.parseVideoInputs("https://youtu.be/AAAAAAAAAAA\nAAAAAAAAAAA, https://www.youtube.com/watch?v=BBBBBBBBBBB\nbroken!line");
  assert.deepEqual(parsed, { ids: ["AAAAAAAAAAA", "BBBBBBBBBBB"], invalid: ["broken!line"] });
  // A title pasted next to a link (spreadsheet rows) is not mistaken for a bare id.
  assert.deepEqual(service.parseVideoInputs("https://youtu.be/AAAAAAAAAAA\tSong Title Here 2024\nCCCCCCCCCCC DDDDDDDDDDD"),
    { ids: ["AAAAAAAAAAA", "CCCCCCCCCCC", "DDDDDDDDDDD"], invalid: [] });
  assert.deepEqual(service.parseVideoInputs(["https://youtu.be/AAAAAAAAAAA", "https://youtu.be/short"]), { ids: ["AAAAAAAAAAA"], invalid: ["https://youtu.be/short"] });
  assert.deepEqual(service.parseIdList("AS1, AS2\nAS1 bad id!"), { ids: ["AS1", "AS2", "bad"], invalid: ["id!"] });
});

test("filters are validated and translated to claimSearch parameters", () => {
  const filters = service.parseFilters({ statuses: ["active", "manual_review"], content_types: ["Video"], origins: "audioMatch,videoMatch", created_after: "2026-01-01", partner_uploaded: "false", sort: "date" });
  assert.deepEqual(filters.statuses, ["active", "manual_review"]);
  assert.deepEqual(filters.content_types, ["video"]);
  assert.deepEqual(filters.origins, ["audioMatch", "videoMatch"]);
  assert.equal(filters.partner_uploaded, false);
  assert.equal(filters.sort, "DATE");
  assert.throws(() => service.parseFilters({ statuses: ["bogus"] }), /Unknown claim status: bogus/);
  assert.throws(() => service.parseFilters({ created_after: "01/02/2026" }), /YYYY-MM-DD/);
  assert.throws(() => service.parseFilters({ created_after: "2026-02-31" }), /YYYY-MM-DD/, "impossible calendar days are rejected");
  assert.throws(() => service.parseFilters({ created_after: "2026-02-01", created_before: "2026-01-01" }), /created_after must not be later/);
  assert.throws(() => service.parseFilters({ sort: "views" }), /Unknown sort/);
});

test("claim resources are normalised whatever spelling Google uses, and the Studio link prefers the claim page", () => {
  const account = { id: 7, name: "Primary CMS", network_code: "OWNER_7" };
  const claim = service.normalizeClaim({
    id: "X", status: "ROUTED_FOR_REVIEW", contentType: "VISUAL", origin: "webUpload",
    studioInfo: { videoUrl: "https://studio.youtube.com/video/x", other: "https://example.com/first", claimUrl: "https://studio.youtube.com/claim/x" }
  }, account);
  assert.equal(claim.status, "manual_review");
  assert.equal(claim.content_type, "video");
  assert.equal(claim.studio_url, "https://studio.youtube.com/claim/x");
  assert.equal(service.normalizeClaim({ id: "Y", status: "routedForReview", contentType: "visual" }, account).status, "manual_review");
  assert.equal(service.normalizeClaim({ id: "Z", studioInfo: { anything: "https://example.com/only" } }, account).studio_url, "https://example.com/only");
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

test("connected CMS networks are listed with their partner-scope flag and the limited-user description", () => {
  const accounts = service.listClaimAccounts();
  assert.deepEqual(accounts.map((account) => [account.id, account.has_partner_scope]), [[9, true], [8, false], [7, true]]);
  assert.deepEqual(service.describeUser(ADMIN), { limited: false, allowed_labels: [] });
  assert.deepEqual(service.describeUser(LIMITED), { limited: true, allowed_labels: ["ANS", "ANS Music"] });
  // Super admins are never label-restricted, whatever other roles they carry.
  assert.deepEqual(service.describeUser({ id: 2, roles: ["Claim Manager", "Super Admin"] }), { limited: false, allowed_labels: [] });
  assert.equal(service.isLimitedUser({ id: 2, roles: ["Claim Manager", "supper admin"] }), false);
  assert.equal(service.isLimitedUser({ id: 2, roles: ["Claim Manager", "Content ID"] }), false);
  assert.equal(service.LIMITS.max_preview_videos, 50);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("video lookups batch ids per CMS, hydrate assets and previews, and summarise per video", async () => {
  const result = await service.searchClaims({ user: ADMIN, body: {
    network_ids: [7], mode: "videos", include_details: true,
    videos: "https://youtu.be/AAAAAAAAAAA\nBBBBBBBBBBB\nZZZZZZZZZZZ\nnope"
  } });

  const searches = callsTo("GET", /\/claimSearch$/);
  assert.equal(searches.length, 1, "one batched claimSearch for three videos");
  assert.equal(searches[0].params.videoId, "AAAAAAAAAAA,BBBBBBBBBBB,ZZZZZZZZZZZ");
  assert.equal(searches[0].params.includeThirdPartyClaims, false);
  assert.equal(searches[0].params.onBehalfOfContentOwner, "OWNER_7");
  assert.equal(searches[0].headers.Authorization, "Bearer token-7");
  const assetReads = callsTo("GET", /\/assets$/);
  assert.equal(assetReads.length, 1);
  assert.equal(assetReads[0].params.fetchMetadata, "effective");
  assert.deepEqual(assetReads[0].params.id.split(",").sort(), ["AS1", "AS2"]);

  assert.equal(result.mode, "videos");
  assert.deepEqual(result.invalid, ["nope"]);
  assert.deepEqual(result.networks, [{ id: 7, name: "Primary CMS", network_code: "OWNER_7", cms_auth_email: "cms7@example.com" }]);
  assert.equal(result.totals.videos, 3);
  assert.equal(result.totals.claims, 4);
  assert.equal(result.totals.releasable, 2, "active + pending");
  assert.equal(result.details_included, true);
  assert.equal(result.details_required, false);
  assert.equal(result.request_plan.claim_search_requests, 1);
  assert.equal(result.request_plan.asset_requests, 1);
  assert.equal(result.request_plan.video_metadata_requests, 1);
  assert.equal(result.request_plan.claim_get_requests, 0);
  assert.equal(result.request_plan.claim_patch_requests, 0);
  assert.deepEqual(youtubeCalls, [["AAAAAAAAAAA", "BBBBBBBBBBB", "ZZZZZZZZZZZ"]], "every requested video gets a preview slot");
  assert.deepEqual(result.claims.map((claim) => claim.claim_id), ["C-disputed", "C-other", "C-ok", "C-inactive"], "newest first");

  const ok = result.claims.find((claim) => claim.claim_id === "C-ok");
  assert.equal(ok.key, "7:C-ok");
  assert.equal(ok.video_url, "https://www.youtube.com/watch?v=AAAAAAAAAAA");
  assert.equal(ok.video_title, "Song A (CMS title)");
  assert.equal(ok.video.channel_title, "Channel A");
  assert.deepEqual(ok.asset, { id: "AS1", title: "Song A", type: "sound_recording", custom_id: "ANS_1", isrc: "VNA122400001", upc: "0123456789012", artist: "Artist A, Artist B", labels: ["ANS", "Pop"] });
  assert.equal(ok.origin, "audioMatch");
  assert.equal(ok.video_views, 1200);
  assert.equal(ok.engaged_views, 34);
  assert.equal(ok.can_release, true);
  assert.equal(ok.release_block_reason, "");
  assert.equal(ok.studio_url, "https://studio.youtube.com/claim/C-ok");
  assert.equal(ok.policy, null, "claim snippets carry no policy");
  const inactive = result.claims.find((claim) => claim.claim_id === "C-inactive");
  assert.equal(inactive.can_release, false);
  assert.match(inactive.release_block_reason, /inactive status cannot be released/);
  assert.equal(inactive.video_title, "Song A on YouTube", "a snippet without a title takes the YouTube one");
  const other = result.claims.find((claim) => claim.claim_id === "C-other");
  assert.equal(other.third_party, true);
  assert.equal(other.is_partner_uploaded, true);
  assert.equal(other.video, null, "no YouTube metadata for this video");
  assert.equal(other.video_title, "Clip B");

  assert.deepEqual(result.videos.map((video) => [video.video_id, video.claim_count, video.releasable_count]), [["AAAAAAAAAAA", 2, 1], ["BBBBBBBBBBB", 2, 1], ["ZZZZZZZZZZZ", 0, 0]]);
  assert.equal(result.videos[0].title, "Song A on YouTube");
  assert.equal(result.videos[0].thumbnail, "https://i.ytimg.com/a.jpg");
  assert.equal(result.videos[1].title, "Clip B", "falls back to the CMS video title");
  assert.deepEqual(result.errors, []);
  assert.equal(result.limits.max_preview_videos, 50);
});

test("a single status filter is sent to Google as its enum name, several are applied locally", async () => {
  let result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: "CCCCCCCCCCC", filters: { statuses: ["manual_review"] } } });
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.status, "ROUTED_FOR_REVIEW");
  assert.deepEqual(result.claims.map((claim) => claim.claim_id), ["C-manual"]);

  calls.length = 0;
  result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA", "BBBBBBBBBBB"], filters: { statuses: ["active", "pending"], content_types: ["audio", "audiovisual"] } } });
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.status, undefined);
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.contentType, undefined);
  assert.deepEqual(result.claims.map((claim) => claim.claim_id).sort(), ["C-ok", "C-other"]);
  assert.equal(result.details_included, false);
  assert.equal(callsTo("GET", /\/assets$/).length, 0, "no asset reads without details");

  calls.length = 0;
  result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["BBBBBBBBBBB"], filters: { content_types: ["video"], origins: ["melodyMatch"] } } });
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.contentType, "VISUAL");
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.origin, "melodyMatch");
  assert.deepEqual(result.claims.map((claim) => claim.claim_id), ["C-disputed"]);

  calls.length = 0;
  await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA"], filters: { statuses: ["active"] } } });
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.status, "ACTIVE");
});

test("asset lookups query one asset per call and flag truncated result sets", async () => {
  const result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "assets", asset_ids: "AS1 AS2" } });
  const searches = callsTo("GET", /\/claimSearch$/);
  assert.deepEqual(searches.map((item) => item.params.assetId).sort(), ["AS1", "AS1", "AS2"], "AS1 needed a second page");
  assert.equal(result.totals.claims, 5);
  assert.deepEqual(result.videos, []);
  assert.equal(result.errors.length, 0);
});

test("an asset with endless result pages stops after the page cap and reports it once", async () => {
  cms.endlessAssetPages = true;
  const result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "assets", asset_ids: "AS2" } });
  assert.equal(callsTo("GET", /\/claimSearch$/).length, 10, "MAX_PAGES_PER_QUERY");
  assert.equal(result.totals.claims, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].scope, "search");
  assert.match(result.errors[0].message, /Asset AS2 has more claims than the 10 pages read/);
});

test("claim-id lookups return full claims with policy and match details in seconds, and apply date filters locally", async () => {
  const result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "claims", claim_ids: ["C-ok", "C-unknown", "C-later"] } });
  const lists = callsTo("GET", /\/claims$/);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].params.id, "C-ok,C-unknown,C-later");
  assert.equal(result.request_plan.claim_list_requests, 1);
  assert.deepEqual(result.claims.map((claim) => claim.claim_id).sort(), ["C-later", "C-ok"]);
  const claim = result.claims.find((item) => item.claim_id === "C-ok");
  assert.equal(claim.policy.name, "Monetize in all countries");
  assert.equal(typeof claim.policy.summary, "string");
  assert.equal(claim.applied_policy.id, "P1");
  assert.equal(claim.match_info.reference_id, "R1");
  assert.deepEqual(claim.match_info.longest_match, { duration_secs: 42.5, user_video_offset: 10, reference_offset: 0 });
  assert.deepEqual(claim.match_info.segments, [
    { channel: "Audio", video_start: 10, video_duration: 42.5, reference_start: 0, reference_duration: 42.5 },
    { channel: "Audio", video_start: 5, video_duration: 15, reference_start: null, reference_duration: null }
  ], "milliseconds on the wire, seconds on the page; manual segments span start..finish");
  assert.equal(claim.block_outside_ownership, false);
  assert.equal(claim.ugc_type, "standard");

  // claims.list has no date parameters: after is inclusive, before exclusive, on the calendar day.
  const after = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "claims", claim_ids: ["C-ok", "C-later"], filters: { created_after: "2026-09-02" } } });
  assert.deepEqual(after.claims.map((item) => item.claim_id), ["C-later"]);
  const before = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "claims", claim_ids: ["C-ok", "C-later"], filters: { created_before: "2026-09-06" } } });
  assert.deepEqual(before.claims.map((item) => item.claim_id), ["C-ok"]);
  const sameDay = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "claims", claim_ids: ["C-ok", "C-later"], filters: { created_after: "2026-09-01", created_before: "2026-09-02" } } });
  assert.deepEqual(sameDay.claims.map((item) => item.claim_id), ["C-ok"]);
  const modified = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "claims", claim_ids: ["C-ok", "C-later"], filters: { status_modified_after: "2026-09-01" } } });
  assert.deepEqual(modified.claims.map((item) => item.claim_id), ["C-ok"], "a claim without the timestamp is dropped when that pair is filtered");
});

test("explore searches one CMS with free text and filters, pages through tokens and keeps Google's order", async () => {
  await assert.rejects(service.searchClaims({ user: ADMIN, body: { network_ids: [7, 9], mode: "explore", query: "song" } }), /one CMS network at a time/);
  await assert.rejects(service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "explore" } }), /search text or at least one filter/);

  const first = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "explore", query: "song", filters: { statuses: ["active"], sort: "DATE", partner_uploaded: false } } });
  const search = callsTo("GET", /\/claimSearch$/)[0];
  assert.equal(search.params.q, "song");
  assert.equal(search.params.status, "ACTIVE");
  assert.equal(search.params.sort, "DATE");
  assert.equal(search.params.partnerUploaded, false);
  assert.equal(search.params.pageToken, undefined);
  assert.deepEqual(first.page, { next_page_token: "page-2", previous_page_token: null });
  assert.deepEqual(first.claims.map((claim) => claim.claim_id), ["C-ok"], "the pending claim is filtered out locally");

  calls.length = 0;
  const second = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "explore", query: "song", page_token: "page-2" } });
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.pageToken, "page-2");
  assert.deepEqual(second.claims.map((claim) => claim.claim_id), ["C-disputed"]);
  assert.equal(second.page.next_page_token, null);

  // The page comes back as claimSearch ordered it (sort=), not re-sorted newest first.
  calls.length = 0;
  const ordered = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "explore", query: "song", filters: { sort: "LIFETIME_ENGAGED_VIEWS" } } });
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.sort, "LIFETIME_ENGAGED_VIEWS");
  assert.deepEqual(ordered.claims.map((claim) => claim.claim_id), ["C-ok", "C-other"], "C-other is newer but Google listed it second");

  // Two statuses: nothing sent to Google, filtered locally, the page token intact.
  calls.length = 0;
  const two = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "explore", filters: { statuses: ["active", "pending"] } } });
  assert.equal(callsTo("GET", /\/claimSearch$/)[0].params.status, undefined);
  assert.deepEqual(two.claims.map((claim) => claim.claim_id), ["C-ok", "C-other"]);
  assert.equal(two.page.next_page_token, "page-2");
});

test("video previews are hydrated for the first videos of the result only, up to the configured cap", async () => {
  const ids = [];
  for (let index = 0; index < 60; index += 1) {
    const id = `C-many-${String(index).padStart(2, "0")}`;
    ids.push(id);
    cms.claims.set(id, { id, videoId: `VID${String(index).padStart(8, "0")}`, assetId: "AS1", status: "active", contentType: "audio", origin: { source: "audioMatch" }, timeCreated: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z` });
  }
  const result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "claims", include_details: true, claim_ids: ids } });
  assert.equal(result.totals.claims, 60);
  assert.equal(result.request_plan.claim_list_requests, 2, "60 ids in two claims.list batches");
  assert.equal(result.request_plan.video_metadata_requests, 1, "50 ids fit in one YouTube Data API call");
  assert.equal(youtubeCalls.length, 1);
  assert.deepEqual(youtubeCalls[0], result.claims.slice(0, 50).map((claim) => claim.video_id), "the newest 50 claims get the preview slots");
  const capped = result.errors.find((error) => error.scope === "video_metadata");
  assert.deepEqual(capped, { network_id: null, network_name: "YouTube Data API", scope: "video_metadata", message: "Previews were loaded for the first 50 videos only." });
  assert.equal(result.totals.errors, 1);
});

test("a limited Claim Manager only sees claims whose asset carries one of their labels, with fresh asset reads", async () => {
  await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA", "BBBBBBBBBBB"], include_details: true } });
  calls.length = 0;
  const result = await service.searchClaims({ user: LIMITED, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA", "BBBBBBBBBBB"] } });
  assert.equal(result.details_required, true);
  assert.equal(result.details_included, true);
  assert.equal(callsTo("GET", /\/assets$/).length, 1, "labels are re-read even though the cache holds the assets");
  assert.deepEqual(result.claims.map((claim) => claim.claim_id).sort(), ["C-disputed", "C-inactive", "C-ok"], "C-other (label Other) is hidden");
  assert.equal(result.totals.releasable, 1);
  assert.deepEqual(result.videos.map((video) => video.claim_count), [2, 1]);
});

test("third-party upload lookup reads ownership email only for uploads and enforces the CMS label before reading contacts", async () => {
  const videoId = "BBBBBBBBBBB";
  const existing = cms.snippets.find((claim) => claim.id === "C-disputed");
  existing.thirdPartyClaim = false;
  cms.snippets.push({ id: "C-third-party-match", videoId, assetId: "AS1", thirdPartyClaim: true, isPartnerUploaded: false });

  const result = await service.getThirdPartyUploads({ user: LIMITED, videoId, networkIds: [7] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.claims.map((claim) => claim.claim_id), ["C-other"]);
  assert.equal(result.claims[0].asset_title, "Merged asset");
  assert.deepEqual(result.claims[0].artists, ["Artist A", "Artist B"]);
  assert.equal(result.claims[0].ownership_source, "effective");
  assert.deepEqual(result.claims[0].contacts, [{ owner_id: "UPLOAD_OWNER", name: "Upload owner", email: "ownership@example.com" }]);
  assert.equal(callsTo("GET", /\/assets\/AS2$/)[0].params.fetchOwnership, "effective");
  assert.equal(callsTo("GET", /\/ownershipHistory$/).length, 0);

  calls.length = 0;
  existing.thirdPartyClaim = true;
  const denied = await service.getThirdPartyUploads({ user: LIMITED, videoId, networkIds: [7] });
  assert.deepEqual(denied.claims, []);
  assert.match(denied.errors[0].message, /allowed labels/);
  assert.equal(callsTo("GET", /\/assets\/AS2$/).length, 0);
  assert.equal(callsTo("GET", /\/ownershipHistory$/).length, 0);
  assert.equal(callsTo("GET", /\/contentOwners\//).length, 0);
});

test("third-party upload keeps worldwide owners when the CMS exposes only submitted ownership", async (t) => {
  const delivery = require("../src/services/assetDeliveryService");
  const request = delivery.partnerRequest;
  const videoId = "BBBBBBBBBBB";
  let effective;
  const lookedUp = [];
  t.mock.method(delivery, "partnerRequest", async (ctx, method, path, options) => {
    if (path === "/assets/AS2") return { data: { id: "AS2", metadataEffective: { title: "Upload asset" }, ownershipEffective: effective } };
    if (path === "/ownershipHistory") return { data: { items: [
      { origination: { owner: "SUBMITTER" }, ownership: { general: [{ owner: "UPLOAD_OWNER", type: "exclude", ratio: 100 }] } },
      { origination: { owner: "UPLOAD_OWNER" }, ownership: { performance: [{ type: "exclude", territories: ["US"] }] } },
      { origination: { owner: "FORMER" }, ownership: { general: [{ type: "include", territories: [] }, { type: "exclude", ratio: 0 }] } }
    ] } };
    if (path.startsWith("/contentOwners/")) lookedUp.push(path);
    return request(ctx, method, path, options);
  });
  const lookup = () => service.getThirdPartyUploads({ user: ADMIN, videoId, networkIds: [7] });
  const submitted = await lookup();
  assert.deepEqual(submitted.errors, []);
  assert.equal(submitted.claims[0].ownership_source, "submitted");
  assert.deepEqual(submitted.claims[0].contacts.map((owner) => owner.email), ["ownership@example.com"]);
  effective = { general: [{ owner: "UPLOAD_OWNER", type: "exclude", territories: [], ratio: 100 }] };
  const current = await lookup();
  assert.equal(current.claims[0].ownership_source, "effective");
  assert.deepEqual(current.claims[0].contacts, submitted.claims[0].contacts);
  effective = { general: [] };
  assert.deepEqual((await lookup()).claims[0].contacts, []);
  assert.deepEqual(lookedUp, ["/contentOwners/UPLOAD_OWNER", "/contentOwners/UPLOAD_OWNER"]);
});

test("artist asset check uses the All assets restriction and preserves Google's pagination", async () => {
  const query = { networkId: 7, artist: " Thanh Nhuong ", scope: "all" };
  const first = await assetCheck.searchArtistAssets(query);
  assert.deepEqual(first.items[0].isrcs, ["ISRC1", "ISRC2"]);
  assert.equal(first.total, 2);
  const second = await assetCheck.searchArtistAssets({ ...query, pageToken: first.next_page_token });
  assert.deepEqual(second.items.map((item) => item.id), ["AS3"]);
  assert.equal(second.next_page_token, null);
  const searches = callsTo("GET", /\/assetSearch$/);
  assert.deepEqual(searches.map((call) => call.params.ownershipRestriction), ["NONE", "NONE"]);
  assert.equal(searches[1].params.pageToken, "second-page");
});

test("artist asset check shows effective owners only and loads each contact once", async () => {
  const detail = await assetCheck.getAssetOwnership({ networkId: 7, assetId: "AS2" });
  assert.deepEqual(detail.asset.artists, ["Artist A", "Artist B"]);
  assert.deepEqual(detail.owners, [{
    owner_id: "UPLOAD_OWNER", name: "Upload owner", email: "ownership@example.com",
    rights: [{ type: "general", territories: ["US", "VN"] }, { type: "performance", territories: ["VN"] }]
  }]);
  assert.equal(callsTo("GET", /\/contentOwners\//).length, 1);
  assert.equal(callsTo("GET", /\/assets\/AS2$/)[0].params.fetchOwnership, "effective");
});

test("external scope excludes later owned pages and preserves the unrestricted cursor and type filter", async () => {
  const query = { networkId: 7, artist: "Thanh Nhuong", scope: "external", type: "sound_recording" };
  const first = await assetCheck.searchArtistAssets(query);
  assert.deepEqual(first.items, []);
  assert.equal(first.total, null);
  assert.equal(first.next_page_token, "second-page");
  const second = await assetCheck.searchArtistAssets({ ...query, pageToken: first.next_page_token });
  assert.deepEqual(second.items.map((item) => item.id), ["AS3"]);
  assert.equal(second.next_page_token, null);
  const searches = callsTo("GET", /\/assetSearch$/);
  assert.deepEqual(searches.map((call) => call.params.ownershipRestriction), ["NONE", "MINE", "MINE", "NONE", "MINE", "MINE"]);
  assert.ok(searches.every((call) => call.params.type === "sound_recording" && call.params.onBehalfOfContentOwner === "OWNER_7"));
  const owned = await assetCheck.searchArtistAssets({ ...query, scope: "owned" });
  assert.deepEqual(owned.items.map((item) => item.id), ["AS1"]);
  await assert.rejects(assetCheck.searchArtistAssets({ ...query, type: "unsupported" }), /valid asset type/);
});

test("Excel export keeps the selection, merged ISRCs, distinct owners and assets missing from CMS", async () => {
  const { Workbook } = require("exceljs");
  const { buildAssetCheckWorkbook } = require("../src/services/assetCheckWorkbook");
  cms.assets.get("AS2").ownershipEffective = { general: [
    { owner: "UPLOAD_OWNER", territories: ["VN", "US"] },
    { owner: "OTHER_OWNER", territories: ["GB"] }
  ] };
  const items = [{ id: "AS2", isrcs: ["0012", "0043"] }, { id: "AS2", isrcs: ["0012", "0043"] }, { id: "AS3", title: "Missing asset" }];
  const selected = await assetCheck.loadSelectedAssets({ networkId: 7, items });
  assert.deepEqual(callsTo("GET", /\/contentOwners$/).map((call) => call.params.id.split(",").sort()), [["OTHER_OWNER", "UPLOAD_OWNER"]]);
  assert.deepEqual(callsTo("GET", /\/contentOwners\//).map((call) => call.url.split("/").pop()), ["OTHER_OWNER"]);
  assert.deepEqual(callsTo("GET", /\/assets$/).map((call) => call.params.id), ["AS2,AS3"]);
  const book = new Workbook();
  await book.xlsx.load(await buildAssetCheckWorkbook(selected, "vi"));
  const sheet = book.getWorksheet("Assets");
  assert.deepEqual(sheet.getColumn(1).values.slice(1), ["Asset ID", "AS2", "AS2", "AS3"]);
  assert.equal(sheet.getCell("E2").value, "ownership@example.com");
  assert.equal(sheet.getCell("F3").value, "OTHER_OWNER");
  assert.equal(sheet.getCell("G2").value, "general: VN, US");
  assert.equal(sheet.getCell("H2").value, "0012, 0043");
  assert.equal(sheet.getCell("B4").value, "Missing asset");
  assert.equal(sheet.getCell("P4").value, "CMS không trả về chi tiết asset.");
  await assert.rejects(assetCheck.loadSelectedAssets({ networkId: 7, items: [] }), /Select at least one asset/);
});

test("all-matching export follows all cursors, applies exclusions and keeps the selected CMS scope and type", async () => {
  const filter = { artist: "Thanh Nhuong", scope: "all", type: "sound_recording" };
  async function ids(scope, excludedIds = []) {
    const assets = await Array.fromAsync(assetCheck.iterateExportAssets({ networkId: 7, filter: { ...filter, scope }, excludedIds }));
    return assets.map((item) => item.id);
  }
  assert.deepEqual(await ids("all", ["AS2"]), ["AS3"]);
  assert.deepEqual(await ids("external"), ["AS3"]);
  assert.deepEqual(await ids("owned"), ["AS1", "AS2"]);
  assert.ok(callsTo("GET", /\/assetSearch$/).every((call) => call.params.type === "sound_recording"));
  await assert.rejects(ids("all", ["AS2", "AS3"]), /Select at least one asset/);
});

test("asset export streams counted progress and a complete workbook, while keeping binary downloads compatible", async (t) => {
  const express = require("express");
  const { Workbook } = require("exceljs");
  const { readAssetExport } = await import("../../frontend/src/api/readAssetExport.js");
  const app = express();
  app.use(express.json());
  app.post("/export/:networkId", controller.exportSelectedAssets);
  const server = app.listen(0, "127.0.0.1");
  await require("node:events").once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/export/7`;
  const filter = { artist: "Thanh Nhuong", scope: "all", type: "" };
  async function post(accept, body) {
    return fetch(url, { method: "POST", headers: { accept, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  const response = await post("application/x-ndjson", { filter });
  const progress = [];
  const { blob, written } = await readAssetExport(response.body, (event) => progress.push(event));
  assert.equal(written, 2);
  assert.equal(progress[0].written, 0);
  assert.deepEqual(progress.at(-1), { type: "progress", written: 2, finalizing: true });
  const book = new Workbook();
  await book.xlsx.load(await blob.arrayBuffer());
  assert.deepEqual(book.worksheets[0].getColumn(1).values.slice(2), ["AS2", "AS3"]);
  const binary = await post("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { filter, excluded_ids: ["AS3"] });
  await book.xlsx.load(await binary.arrayBuffer());
  assert.deepEqual(book.worksheets[0].getColumn(1).values.slice(2), ["AS2"]);

  const invalid = await post("application/x-ndjson", { items: [] });
  await assert.rejects(readAssetExport(invalid.body), /Select at least one asset/);
  const partial = new Response('{"type":"xlsx","data":"UEs="}\n');
  await assert.rejects(readAssetExport(partial.body), /interrupted/);
});

test("asset export cancellation stops the in-flight detail batches before another batch starts", async (t) => {
  const delivery = require("../src/services/assetDeliveryService");
  const controller = new AbortController();
  let active = 0;
  let started = 0;
  t.mock.method(delivery, "partnerRequest", async (ctx, method, path, { params }) => {
    assert.equal(path, "/assets");
    assert.ok(params.id.split(",").length <= 50);
    started++;
    active++;
    try {
      await require("node:timers/promises").setTimeout(1000, undefined, { signal: ctx.signal });
      assert.fail("The cancelled batch should not finish");
    } finally {
      active--;
    }
  });
  const items = Array.from({ length: 500 }, (_, index) => ({ id: `AS${index}` }));
  const pending = assetCheck.loadSelectedAssets({ networkId: 7, items, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 5);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(started, 5);
  assert.equal(active, 0);
});

test("a CMS whose token cannot be refreshed is reported per network while the others are searched", async () => {
  const result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7, 9], mode: "videos", videos: ["AAAAAAAAAAA"] } });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].network_id, 9);
  assert.equal(result.errors[0].scope, "credentials");
  assert.match(result.errors[0].message, /^CMS authorization failed: invalid_grant: Token has been expired or revoked\. Re-authorize this CMS/);
  assert.equal(result.totals.claims, 2);
  assert.deepEqual(result.videos[0].errors.map((error) => error.network_name), ["Broken CMS"]);
  assert.equal(authStatus(9), "error");

  await assert.rejects(service.searchClaims({ user: ADMIN, body: { network_ids: [8], mode: "videos", videos: ["AAAAAAAAAAA"] } }), /missing the YouTube Partner scope/);
  await assert.rejects(service.searchClaims({ user: ADMIN, body: { network_ids: [], mode: "videos", videos: ["AAAAAAAAAAA"] } }), /Select at least one connected CMS network/);
  await assert.rejects(service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: "nothing-valid" } }), /at least one valid YouTube video link/);
});

test("a search error of a videos batch names its videos and only shows on those video rows", async () => {
  cms.serverError = true;
  const result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA", "BBBBBBBBBBB"] } });
  assert.equal(callsTo("GET", /\/claimSearch$/).length, 3, "an idempotent read is retried three times");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].scope, "search");
  assert.deepEqual(result.errors[0].video_ids, ["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  assert.match(result.errors[0].message, /Backend Error/);
  assert.deepEqual(result.videos.map((video) => video.errors.length), [1, 1]);
  assert.deepEqual(Object.keys(result.videos[0].errors[0]).sort(), ["message", "network_id", "network_name"]);
  assert.equal(result.totals.claims, 0);
});

test("a failing YouTube Data API read only drops the previews", async () => {
  cms.videoMetadataFails = true;
  const result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA"], include_details: true } });
  assert.equal(result.totals.claims, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].scope, "video_metadata");
  assert.equal(result.videos[0].title, "Song A (CMS title)");
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

test("claim detail joins the claim, its asset, the video preview and the Google claim history", async () => {
  const detail = await service.getClaimDetail({ user: ADMIN, networkId: 7, claimId: "C-ok" });
  assert.equal(detail.claim.claim_id, "C-ok");
  assert.equal(detail.claim.policy.name, "Monetize in all countries");
  assert.equal(detail.claim.asset.isrc, "VNA122400001");
  assert.equal(detail.claim.video.channel_title, "Channel A");
  assert.deepEqual(detail.history.map((event) => event.type), ["claim_update", "claim_create"], "newest first");
  assert.equal(detail.history[0].reason, "closed_manually");
  assert.equal(detail.history[0].details.update_status, "active");
  assert.equal(detail.history[1].source.user_email, "ops@example.com");
  assert.equal(detail.history_error, "");
  assert.deepEqual(detail.local_events, []);
  assert.equal(callsTo("GET", /\/claimHistory\/C-ok$/).length, 1);
  assert.equal(detail.request_plan.claim_get_requests, 1);

  cms.historyFails = true;
  const degraded = await service.getClaimDetail({ user: ADMIN, networkId: 7, claimId: "C-ok" });
  assert.deepEqual(degraded.history, []);
  assert.match(degraded.history_error, /Backend Error/);

  await assert.rejects(service.getClaimDetail({ user: LIMITED, networkId: 7, claimId: "C-foreign" }), (error) => error.status === 403);
  await assert.rejects(service.getClaimDetail({ user: ADMIN, networkId: 7, claimId: "C-missing" }), (error) => error.status === 404);
});

test("a failed asset read degrades the detail for admins but is Google's error for a limited user", async () => {
  cms.assetsFail = true;
  const detail = await service.getClaimDetail({ user: ADMIN, networkId: 7, claimId: "C-later" });
  assert.equal(detail.claim.asset, null);
  assert.deepEqual(detail.errors.map((error) => error.scope), ["assets"]);
  await assert.rejects(service.getClaimDetail({ user: LIMITED, networkId: 7, claimId: "C-later" }), (error) => Number(error.status) === 500 && error.reason === "backendError");
  const res = await call(controller.getDetail, { user: LIMITED, params: { networkId: "7", claimId: "C-later" } });
  assert.equal(res.statusCode, 502, "not a 403 'outside your labels'");
  assert.equal(res.body.reason, "backendError");
});

test("claim detail lists the local release events of the claim, scoped to their own for limited users", async () => {
  await service.releaseClaims({ user: ADMIN, note: "Rights expired", releases: [{ network_id: 7, claim_id: "C-later" }] });
  const detail = await service.getClaimDetail({ user: ADMIN, networkId: 7, claimId: "C-later" });
  assert.equal(detail.local_events.length, 1);
  assert.equal(detail.local_events[0].result, "released");
  assert.equal(detail.local_events[0].note, "Rights expired");
  assert.equal(detail.local_events[0].created_by_name, "Tester");
  assert.equal("response_json" in detail.local_events[0], false);
  const limited = await service.getClaimDetail({ user: LIMITED, networkId: 7, claimId: "C-later" });
  assert.deepEqual(limited.local_events, [], "another user's operations are not shown to a limited user");
});

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

test("releasing claims reports one outcome per claim, never writes inactive claims again and keeps an audit trail", async () => {
  cms.patchBehaviour = { "C-forbidden": "forbidden", "C-429": "rate_limit" };
  const result = await service.releaseClaims({ user: ADMIN, note: "Rights expired", releases: [
    { network_id: 7, claim_id: "C-ok", video_id: "https://youtu.be/AAAAAAAAAAA", video_title: "Song A (page)", channel_title: "Channel A" },
    { network_id: 7, claim_id: "C-ok" },
    { network_id: 7, claim_id: "C-inactive" },
    { network_id: 7, claim_id: "C-disputed" },
    { network_id: 7, claim_id: "C-forbidden" },
    { network_id: 7, claim_id: "C-429" },
    { network_id: 7, claim_id: "C-missing" },
    { network_id: 7, claim_id: "bad id!" },
    { network_id: 8, claim_id: "C-ok" },
    { network_id: 999, claim_id: "C-ok" }
  ] });

  assert.match(result.operation_id, /^[0-9a-f-]{36}$/);
  const byId = Object.fromEntries(result.results.map((item) => [item.key, item]));
  assert.equal(result.results.length, 9, "duplicates collapse");
  assert.equal("event_id" in result.results[0], false);
  const released = byId["7:C-ok"];
  assert.equal(released.outcome, "released");
  assert.equal(released.status, "inactive");
  assert.equal(released.claim.can_release, false);
  assert.equal(released.claim.release_block_reason, "Claims in inactive status cannot be released through the API");
  assert.equal(released.claim.video_title, "Song A (page)", "the claims resource has no title, the page's is kept");
  assert.equal(released.claim.asset.isrc, "VNA122400001");
  assert.equal(released.claim.time_status_last_modified, "2026-10-06T00:00:00Z");
  assert.equal(released.claim.content_type, "audio", "the sparse PATCH answer does not blank the pre-read");
  assert.equal(released.claim.origin, "audioMatch");
  assert.equal(released.claim.time_created, "2026-09-01T00:00:00Z");
  assert.equal(released.claim.policy.name, "Monetize in all countries");
  assert.equal("video" in released.claim, false, "keys the claims resource cannot know are left out");
  assert.equal("video_views" in released.claim, false);
  assert.equal("third_party" in released.claim, false);
  assert.equal(byId["7:C-inactive"].outcome, "already_inactive");
  assert.equal(byId["7:C-inactive"].claim.can_release, false);
  assert.equal(byId["7:C-disputed"].outcome, "skipped");
  assert.match(byId["7:C-disputed"].message, /disputed status cannot be released/);
  assert.equal(byId["7:C-forbidden"].outcome, "failed");
  assert.equal(byId["7:C-forbidden"].retryable, false);
  assert.match(byId["7:C-forbidden"].message, /^CMS permission denied: /);
  assert.equal(byId["7:C-forbidden"].claim.can_release, true, "the row stays releasable");
  assert.equal(byId["7:C-429"].outcome, "failed");
  assert.equal(byId["7:C-429"].retryable, true);
  assert.equal(byId["7:C-429"].retry_after, 0);
  assert.equal(byId["7:C-429"].reason, "rateLimitExceeded");
  assert.equal(byId["7:C-missing"].outcome, "failed");
  assert.equal(byId["7:C-missing"].reason, "notFound");
  assert.equal(byId["7:C-missing"].retryable, false);
  assert.equal(byId["7:C-missing"].claim, null);
  assert.equal(byId["7:bad id!"].outcome, "skipped");
  assert.equal(byId["7:bad id!"].message, "Invalid claim ID.");
  assert.equal(byId["8:C-ok"].outcome, "skipped");
  assert.match(byId["8:C-ok"].message, /Partner scope/);
  assert.equal(byId["999:C-ok"].outcome, "skipped");
  assert.deepEqual(result.summary, { total: 9, released: 1, already_inactive: 1, failed: 3, unknown: 0, skipped: 4 });

  const patches = callsTo("PATCH", /\/claims\//);
  assert.deepEqual(patches.filter((item) => /C-inactive|C-disputed|bad/.test(item.url)), [], "inactive, disputed and malformed claims are not written");
  assert.equal(patches.filter((item) => /C-429$/.test(item.url)).length, 3);
  assert.equal(patches.filter((item) => /C-missing$/.test(item.url)).length, 1, "a 404 is not retried");
  assert.equal(result.request_plan.claim_list_requests, 1);
  assert.equal(result.request_plan.claim_patch_requests, patches.length);
  assert.equal(result.request_plan.claim_get_requests, 0);
  assert.equal(result.request_plan.asset_requests, 1);

  const rows = eventRows("operation_id = ?", result.operation_id);
  assert.equal(rows.length, 9, "every result gets an audit row, including the unknown CMS");
  const okRow = rows.find((row) => row.claim_id === "C-ok" && row.network_id === 7);
  assert.equal(okRow.result, "released");
  assert.equal(okRow.previous_status, "active");
  assert.equal(okRow.result_status, "inactive");
  assert.equal(okRow.video_id, "AAAAAAAAAAA");
  assert.equal(okRow.video_title, "Song A (page)");
  assert.equal(okRow.channel_title, "Channel A");
  assert.equal(okRow.asset_id, "AS1");
  assert.equal(okRow.asset_title, "Song A");
  assert.equal(okRow.isrc, "VNA122400001");
  assert.equal(okRow.note, "Rights expired");
  assert.equal(okRow.created_by, 1);
  assert.equal(okRow.created_by_name, "Tester");
  assert.equal(okRow.network_name, "Primary CMS");
  assert.ok(okRow.duration_ms >= 0);
  assert.equal(rows.find((row) => row.claim_id === "C-missing").result, "failed");
  assert.equal(rows.find((row) => row.claim_id === "bad id!").result, "skipped");
  assert.equal(rows.find((row) => row.network_id === 8).result, "skipped");
  const orphan = rows.find((row) => row.network_id === 999);
  assert.equal(orphan.result, "skipped");
  assert.equal(orphan.network_name, null);

  await assert.rejects(service.releaseClaims({ user: ADMIN, releases: [] }), /Select at least one claim/);
  await assert.rejects(service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }], note: "x".repeat(501) }), /at most 500 characters/);
});

test("a release call Google never answered is read back: inactive confirms it, a live claim fails retryably, silence stays unknown", async () => {
  cms.patchBehaviour = { "C-timeout": "timeout", "C-timeout-live": "timeout", "C-refused": "refuse_then_inactive", "C-reset": "reset", "C-reset-lost": "reset_lost", "C-empty": "empty" };
  cms.claimGetTimeouts = new Set(["C-timeout"]);
  const result = await service.releaseClaims({ user: ADMIN, releases: ["C-timeout", "C-timeout-live", "C-refused", "C-reset", "C-reset-lost", "C-empty"].map((claim_id) => ({ network_id: 7, claim_id })) });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));

  assert.equal(byId["C-timeout"].outcome, "unknown");
  assert.equal(byId["C-timeout"].retryable, false);
  assert.match(byId["C-timeout"].message, /did not respond within 60 s .*2 attempts.*re-check/);
  assert.equal(callsTo("PATCH", /\/claims\/C-timeout$/).length, 2, "two silent attempts, then the read-back");
  assert.equal(callsTo("GET", /\/claims\/C-timeout$/).length, 1, "one single-attempt read-back, which also timed out");
  assert.equal(callsTo("GET", /\/claims\/C-timeout$/)[0].timeout, 15000);

  assert.equal(byId["C-timeout-live"].outcome, "failed");
  assert.equal(byId["C-timeout-live"].retryable, true);
  assert.match(byId["C-timeout-live"].message, /did not respond within 60 s .*still reads back as active.*retry/);
  assert.equal(byId["C-timeout-live"].status, "active");
  assert.equal(byId["C-timeout-live"].claim.can_release, true);

  assert.equal(byId["C-refused"].outcome, "already_inactive", "a refused repeat reads the claim back: it was already inactive, this call changed nothing");
  assert.equal(byId["C-refused"].status, "inactive");
  assert.equal(byId["C-refused"].claim.can_release, false);
  assert.match(byId["C-refused"].message, /^Google refused the release because the claim was already inactive; nothing was changed by this call\.$/);
  assert.equal(callsTo("GET", /\/claims\/C-refused$/).length, 1);

  assert.equal(byId["C-reset"].outcome, "released");
  assert.match(byId["C-reset"].message, /did not answer the release call, but the claim reads back inactive/);
  assert.equal(byId["C-reset"].status, "inactive");
  assert.equal(byId["C-reset"].claim.can_release, false);
  assert.equal(callsTo("PATCH", /\/claims\/C-reset$/).length, 3, "a dropped socket is retried like a timeout");
  assert.equal(callsTo("GET", /\/claims\/C-reset$/).length, 1);

  assert.equal(byId["C-reset-lost"].outcome, "failed");
  assert.equal(byId["C-reset-lost"].retryable, true);
  assert.match(byId["C-reset-lost"].message, /dropped before it answered.*still reads back as active/);

  assert.equal(byId["C-empty"].outcome, "released", "an answer without a status is read back");
  assert.equal(byId["C-empty"].message, "Claim released and confirmed inactive by Google.");
  assert.equal(callsTo("GET", /\/claims\/C-empty$/).length, 1);

  assert.deepEqual(result.summary, { total: 6, released: 2, already_inactive: 1, failed: 2, unknown: 1, skipped: 0 });
  assert.equal(result.request_plan.claim_get_requests, 6);
  const rows = eventRows("operation_id = ?", result.operation_id);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.claim_id, row.result])), {
    "C-timeout": "unknown", "C-timeout-live": "failed", "C-refused": "already_inactive", "C-reset": "released", "C-reset-lost": "failed", "C-empty": "released"
  });
});

test("quota 403s are retryable failures with a retry hint, a persistent 409 is retried twice and stays retryable", async () => {
  cms.patchBehaviour = { "C-quota": "quota", "C-conflict": "conflict" };
  const result = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-quota" }, { network_id: 7, claim_id: "C-conflict" }] });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));
  assert.equal(byId["C-quota"].outcome, "failed");
  assert.equal(byId["C-quota"].retryable, true);
  assert.equal(byId["C-quota"].retry_after, 60);
  assert.equal(byId["C-quota"].reason, "quotaExceeded");
  assert.match(byId["C-quota"].message, /^Content ID API quota or rate limit reached for this project; wait for the reset or raise the quota in Google Cloud\. \(Quota exceeded/);
  assert.equal(callsTo("PATCH", /\/claims\/C-quota$/).length, 1, "the shared client does not retry a 403");
  assert.equal(byId["C-conflict"].outcome, "failed");
  assert.equal(byId["C-conflict"].reason, "conflict");
  assert.equal(byId["C-conflict"].retryable, true, "a 409 is Google aborting a colliding write: the next attempt usually lands");
  assert.equal(byId["C-conflict"].retry_after, null);
  assert.equal(byId["C-conflict"].message, "The claim is being modified by another request");
  assert.equal(callsTo("PATCH", /\/claims\/C-conflict$/).length, 3, "the PATCH is repeated twice after a pause before giving up");
});

test("a release batch stops sending once its time budget is spent; the rest come back failed and retryable", async () => {
  service._setReleaseBudgetMs(50);
  cms.patchDelayMs = 150;
  try {
    // Videos A (C-ok), D (C-later, then C-timeout and C-refused queued behind it) and E (C-foreign).
    const result = await service.releaseClaims({ user: ADMIN, releases: ["C-ok", "C-later", "C-foreign", "C-timeout", "C-refused"].map((claim_id) => ({ network_id: 7, claim_id })) });
    const outcomes = result.results.map((item) => item.outcome);
    assert.deepEqual(outcomes, ["released", "released", "released", "failed", "failed"], "the three claims in flight when the budget ran out still complete");
    result.results.slice(3).forEach((item) => {
      assert.equal(item.reason, "budget_exhausted");
      assert.equal(item.retryable, true);
      assert.match(item.message, /^Not sent: .*time budget ran out.*Retry it\.$/);
      assert.equal(item.claim.can_release, true);
      assert.equal(item.status, "active");
    });
    assert.deepEqual(callsTo("PATCH", /\/claims\//).map((item) => item.url.split("/").pop()).sort(), ["C-foreign", "C-later", "C-ok"], "nothing was sent for the two queued behind C-later");
    const rows = eventRows("operation_id = ?", result.operation_id);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.filter((row) => row.result === "failed").map((row) => row.claim_id).sort(), ["C-refused", "C-timeout"]);
    assert.ok(rows.filter((row) => row.result === "failed").every((row) => /time budget/.test(row.message)));
  } finally {
    service._setReleaseBudgetMs(null);
    cms.patchDelayMs = 0;
  }
});

test("the audit row is written before the release call and completed with Google's answer", async () => {
  cms.patchDelayMs = 80;
  const pending = service.releaseClaims({ user: ADMIN, note: "trace", releases: [{ network_id: 7, claim_id: "C-ok", video_title: "Song A (page)" }] });
  await sleep(25);
  const inFlight = eventRows("claim_id = 'C-ok'");
  assert.equal(inFlight.length, 1, "the row exists while the PATCH is in flight");
  assert.equal(inFlight[0].result, "unknown");
  assert.equal(inFlight[0].result_status, "active");
  assert.equal(inFlight[0].previous_status, "active");
  assert.equal(inFlight[0].message, "Release sent to Google but the answer was not recorded (the server may have restarted); re-check the claim.");
  assert.equal(inFlight[0].note, "trace");
  assert.equal(inFlight[0].video_title, "Song A (page)");
  assert.equal(inFlight[0].asset_title, "Song A");
  assert.equal(inFlight[0].duration_ms, null);

  const result = await pending;
  assert.equal(result.results[0].outcome, "released");
  const done = eventRows("claim_id = 'C-ok'");
  assert.equal(done.length, 1, "the row is completed, not duplicated");
  assert.equal(done[0].id, inFlight[0].id);
  assert.equal(done[0].result, "released");
  assert.equal(done[0].result_status, "inactive");
  assert.equal(done[0].message, "Claim released and confirmed inactive by Google.");
  assert.ok(done[0].duration_ms >= 80);
  assert.equal(JSON.parse(done[0].response_json).video_title, "Song A (page)");
});

test("a claim already being released by another request is skipped, and only one PATCH goes out", async () => {
  cms.patchDelayMs = 80;
  const first = service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }] });
  await sleep(20);
  const second = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }] });
  const done = await first;
  assert.deepEqual([done.results[0].outcome, second.results[0].outcome], ["released", "skipped"]);
  assert.match(second.results[0].message, /being changed by another request right now/);
  assert.equal(callsTo("PATCH", /\/claims\/C-ok$/).length, 1);
  assert.deepEqual(eventRows("claim_id = 'C-ok'").map((row) => row.result), ["released", "skipped"]);
});

test("a limited Claim Manager can only release claims inside their labels", async () => {
  const result = await service.releaseClaims({ user: LIMITED, releases: [
    { network_id: 7, claim_id: "C-later" },
    { network_id: 7, claim_id: "C-foreign" },
    { network_id: 7, claim_id: "C-missing" }
  ] });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));
  assert.equal(byId["C-later"].outcome, "released");
  assert.equal(byId["C-foreign"].outcome, "skipped");
  assert.match(byId["C-foreign"].message, /not assigned to your allowed labels/);
  assert.equal(byId["C-missing"].outcome, "skipped");
  assert.match(byId["C-missing"].message, /could not be found/);
  assert.equal(callsTo("PATCH", /\/claims\//).length, 1);
  assert.equal(callsTo("GET", /\/assets$/).length, 1, "labels are verified before any write");
  const row = memoryDb.prepare("SELECT created_by, result FROM content_id_claim_events WHERE claim_id = 'C-later'").get();
  assert.deepEqual(row, { created_by: 2, result: "released" });
});

test("a CMS whose token refresh fails blocks only its own claims; the healthy CMS is still processed", async () => {
  const result = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 9, claim_id: "C-ok" }, { network_id: 7, claim_id: "C-later" }] });
  const byId = Object.fromEntries(result.results.map((item) => [item.key, item]));
  assert.equal(byId["9:C-ok"].outcome, "skipped");
  assert.match(byId["9:C-ok"].message, /invalid_grant/);
  assert.match(byId["9:C-ok"].message, /Re-authorize this CMS in Settings > Network\.$/);
  assert.equal(byId["7:C-later"].outcome, "released");
  assert.equal(callsTo("PATCH", /\/claims\//).length, 1);
  const rows = eventRows("operation_id = ?", result.operation_id);
  // The released row goes in before its PATCH, the skipped one in the post-loop: ids follow that.
  assert.deepEqual(rows.map((row) => [row.network_id, row.result]), [[7, "released"], [9, "skipped"]]);
  assert.equal(rows[1].network_name, "Broken CMS");
  assert.match(rows[1].message, /invalid_grant/);
  assert.equal(authStatus(9), "error");
});

// ---------------------------------------------------------------------------
// Re-check
// ---------------------------------------------------------------------------

test("re-checking confirms an unanswered release once the claim reads back as inactive", async () => {
  cms.patchBehaviour = { "C-timeout": "timeout" };
  cms.claimGetTimeouts = new Set(["C-timeout"]);
  const release = await service.releaseClaims({ user: ADMIN, note: "Rights expired", releases: [{ network_id: 7, claim_id: "C-timeout", video_title: "Video D" }] });
  assert.equal(release.results[0].outcome, "unknown");
  cms.claimGetTimeouts = new Set();

  // Still active: the status is reported as is and nothing is recorded.
  let result = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.deepEqual([result.results[0].found, result.results[0].status, result.results[0].message], [true, "active", ""]);
  assert.equal(eventRows("claim_id = 'C-timeout'").length, 1);

  cms.claims.get("C-timeout").status = "inactive";
  result = await service.recheckClaims({ user: ADMIN, items: [
    { network_id: 7, claim_id: "C-timeout", video_title: "Video D" },
    { network_id: 7, claim_id: "C-missing" },
    { network_id: 8, claim_id: "C-ok" },
    { network_id: 7, claim_id: "bad id!" }
  ] });
  const byId = Object.fromEntries(result.results.map((item) => [item.key, item]));
  assert.equal(byId["7:C-timeout"].found, true);
  assert.equal(byId["7:C-timeout"].status, "inactive");
  assert.match(byId["7:C-timeout"].message, /Confirmed inactive/);
  assert.equal(byId["7:C-timeout"].claim.video_title, "Video D", "the page's title is kept on the result claim");
  assert.equal(byId["7:C-timeout"].claim.can_release, false);
  assert.equal("video" in byId["7:C-timeout"].claim, false);
  assert.equal(byId["7:C-missing"].found, false);
  assert.match(byId["7:C-missing"].message, /not found/);
  assert.equal(byId["8:C-ok"].found, false);
  assert.match(byId["8:C-ok"].message, /Partner scope/);
  assert.equal(byId["7:bad id!"].found, false);
  assert.equal(byId["7:bad id!"].message, "Invalid claim ID.");
  assert.equal(callsTo("GET", /\/claims$/).every((item) => !/bad/.test(item.params.id)), true, "malformed ids are never sent to Google");
  const rows = eventRows("claim_id = 'C-timeout'");
  assert.deepEqual(rows.map((row) => [row.action, row.result]), [["release", "unknown"], ["recheck", "released"]]);
  assert.equal(rows[1].note, "Rights expired", "the re-check row carries the note of the original release");
  assert.equal(rows[1].video_title, "Video D");

  // A second re-check records nothing new.
  await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.equal(eventRows("claim_id = 'C-timeout'").length, 2);
  await assert.rejects(service.recheckClaims({ user: ADMIN, items: [] }), /Select at least one claim to re-check/);
});

test("a re-check against a CMS whose token refresh fails reports the credentials problem per item", async () => {
  const result = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 9, claim_id: "C-ok" }, { network_id: 7, claim_id: "C-ok" }] });
  const byId = Object.fromEntries(result.results.map((item) => [item.key, item]));
  assert.equal(byId["9:C-ok"].found, false);
  assert.match(byId["9:C-ok"].message, /^CMS authorization failed: invalid_grant.*Re-authorize this CMS/);
  assert.equal(byId["7:C-ok"].found, true);
  assert.equal(authStatus(9), "error");
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

// Eight audit rows: an admin batch (released, already inactive, skipped, failed, unknown, skipped
// for the no-scope CMS), one release by the limited user and the re-check that confirmed the
// unanswered release.
async function seedHistory() {
  cms.patchBehaviour = { "C-forbidden": "forbidden", "C-timeout": "timeout" };
  cms.claimGetTimeouts = new Set(["C-timeout"]);
  const admin = await service.releaseClaims({ user: ADMIN, note: "Rights expired", releases: [
    { network_id: 7, claim_id: "C-ok", video_id: "AAAAAAAAAAA" },
    { network_id: 7, claim_id: "C-inactive" },
    { network_id: 7, claim_id: "C-disputed" },
    { network_id: 7, claim_id: "C-forbidden" },
    { network_id: 7, claim_id: "C-timeout" },
    { network_id: 8, claim_id: "C-ok" }
  ] });
  const limited = await service.releaseClaims({ user: LIMITED, releases: [{ network_id: 7, claim_id: "C-later" }] });
  cms.claimGetTimeouts = new Set();
  cms.claims.get("C-timeout").status = "inactive";
  await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-timeout" }] });
  return { admin, limited };
}

test("release history is filterable, paged, summarised, scoped for limited users and exportable as CSV", async () => {
  await seedHistory();
  const all = service.listHistory({ user: ADMIN, filters: {}, page: 1, pageSize: 5 });
  assert.equal(all.total, 8);
  assert.equal(all.events.length, 5);
  assert.equal(all.page_size, 5);
  assert.deepEqual(all.summary, { released: 3, already_inactive: 1, reinstated: 0, confirmed: 0, already_active: 0, failed: 1, unknown: 1, skipped: 2 });
  assert.deepEqual(all.users.map((user) => user.name), ["Limited", "Tester"]);
  assert.deepEqual(all.networks.map((network) => network.id).sort(), [7, 8]);
  assert.equal(all.events[0].action, "recheck", "newest first");
  assert.equal("response_json" in all.events[0], false);
  const everything = service.listHistory({ user: ADMIN, filters: {}, page: 1, pageSize: 200 });
  const noScopeRow = everything.events.find((event) => event.network_id === 8);
  assert.equal(noScopeRow.video_url, "", "no video id, no link");
  const okRow = everything.events.find((event) => event.claim_id === "C-ok" && event.network_id === 7 && event.result === "released");
  assert.equal(okRow.video_url, "https://www.youtube.com/watch?v=AAAAAAAAAAA");

  const released = service.listHistory({ user: ADMIN, filters: { result: "released", network_id: 7 } });
  assert.deepEqual(released.events.map((event) => event.claim_id).sort(), ["C-later", "C-ok", "C-timeout"]);
  assert.equal(service.listHistory({ user: ADMIN, filters: { search: "Rights expired" } }).total, 7, "the re-check row carries the note of the original release");
  assert.equal(service.listHistory({ user: ADMIN, filters: { user_id: 2 } }).total, 1);
  assert.equal(service.listHistory({ user: ADMIN, filters: { from: "2030-01-01" } }).total, 0);
  assert.throws(() => service.listHistory({ user: ADMIN, filters: { result: "bogus" } }), /Unknown result/);
  assert.throws(() => service.listHistory({ user: ADMIN, filters: { from: "2026-02-30" } }), /YYYY-MM-DD/);

  const limited = service.listHistory({ user: LIMITED, filters: {} });
  assert.equal(limited.total, 1, "limited users only see their own operations");
  assert.deepEqual(limited.users.map((user) => user.name), ["Limited"]);
  assert.deepEqual(limited.networks.map((network) => network.id), [7]);

  const csv = service.exportHistoryCsv({ user: ADMIN, filters: { result: "released" } });
  assert.ok(csv.startsWith("﻿time_utc,user,cms,"), "the time column says it is UTC");
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 4, "header + three released rows");
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z,/, "ISO 8601 UTC instants");
  assert.ok(lines.some((line) => line.includes("Rights expired")));
  const limitedCsv = service.exportHistoryCsv({ user: LIMITED, filters: {} }).trim().split("\r\n");
  assert.equal(limitedCsv.length, 2, "header + the limited user's only row");
  assert.ok(limitedCsv[1].includes("C-later") && limitedCsv[1].includes("Limited"));
  memoryDb.prepare("INSERT INTO content_id_claim_events (operation_id, network_id, claim_id, result, note) VALUES ('op-x', 7, '=CMD()', 'failed', '-1')").run();
  const unsafe = service.exportHistoryCsv({ user: ADMIN, filters: { search: "CMD" } });
  assert.ok(unsafe.includes("'=CMD()"), "formula-looking cells are neutralised");
  assert.ok(unsafe.includes(",'-1,"));
});

test("a history export larger than the cap is refused instead of silently truncated", () => {
  const insert = memoryDb.prepare("INSERT INTO content_id_claim_events (operation_id, network_id, claim_id, result) VALUES ('op-bulk', 7, ?, 'skipped')");
  memoryDb.transaction(() => {
    for (let index = 0; index < 20001; index += 1) insert.run(`C-bulk-${index}`);
  })();
  assert.throws(() => service.exportHistoryCsv({ user: ADMIN, filters: {} }), (error) => error.status === 400 && /Export matches 20001 rows; narrow the filters \(maximum 20,000\)\./.test(error.message));
  assert.equal(service.exportHistoryCsv({ user: ADMIN, filters: { search: "C-bulk-20000" } }).trim().split("\r\n").length, 2, "header + the one matching row once the filters narrow the export");
});

test("the audit table no longer cascades on network deletion, and databases with the old cascade are rebuilt once", () => {
  const ddl = extractCreateTable("content_id_claim_events");
  assert.doesNotMatch(ddl, /REFERENCES networks/);
  assert.match(ddl, /FOREIGN KEY \(created_by\) REFERENCES users\(id\) ON DELETE SET NULL/);
  memoryDb.prepare("INSERT INTO content_id_claim_events (operation_id, network_id, claim_id, result) VALUES ('op-orphan', 999, 'C-x', 'skipped')").run();
  assert.equal(eventRows("network_id = 999").length, 1, "a row for a network that no longer exists is accepted");

  // The migration SQL of database.js, run against a database created with the old cascade.
  const migration = databaseSource.match(/foreign_key_list\(content_id_claim_events\)[\s\S]*?db\.exec\(`([\s\S]*?)`\)/)[1];
  assert.doesNotMatch(migration, /\$\{/, "plain SQL, no template placeholders");
  const scratch = new Database(":memory:");
  scratch.pragma("foreign_keys = ON");
  ["users", "networks"].forEach((name) => scratch.exec(extractCreateTable(name)));
  scratch.exec(ddl.replace("FOREIGN KEY (created_by)", "FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,\n    FOREIGN KEY (created_by)"));
  scratch.exec("CREATE INDEX IF NOT EXISTS idx_cid_claim_events_result ON content_id_claim_events(result)");
  scratch.prepare("INSERT INTO networks (id, name) VALUES (7, 'Primary CMS')").run();
  scratch.prepare("INSERT INTO content_id_claim_events (operation_id, network_id, network_name, claim_id, result, note) VALUES ('op-1', 7, 'Primary CMS', 'C-ok', 'released', 'keep me')").run();
  const hasCascade = () => scratch.pragma("foreign_key_list(content_id_claim_events)").some((fk) => fk.table === "networks");
  assert.equal(hasCascade(), true);
  if (hasCascade()) {
    scratch.pragma("foreign_keys = OFF");
    scratch.exec(migration);
    scratch.pragma("foreign_keys = ON");
  }
  assert.equal(hasCascade(), false);
  assert.deepEqual(scratch.prepare("SELECT id, network_id, network_name, claim_id, result, note FROM content_id_claim_events").all(),
    [{ id: 1, network_id: 7, network_name: "Primary CMS", claim_id: "C-ok", result: "released", note: "keep me" }]);
  scratch.prepare("DELETE FROM networks WHERE id = 7").run();
  assert.equal(scratch.prepare("SELECT COUNT(*) AS n FROM content_id_claim_events").get().n, 1, "deleting the network keeps the audit row");
  scratch.exec("CREATE INDEX IF NOT EXISTS idx_cid_claim_events_result ON content_id_claim_events(result)");
  scratch.close();
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

test("the controller answers accounts, validation errors and searches", async () => {
  const accounts = await call(controller.listAccounts, { user: LIMITED });
  assert.equal(accounts.statusCode, 200);
  assert.equal(accounts.body.accounts.length, 3);
  assert.equal(accounts.body.limits.max_release_items, 100);
  assert.equal(accounts.body.limits.max_preview_videos, 50);
  assert.deepEqual(accounts.body.user, { limited: true, allowed_labels: ["ANS", "ANS Music"] });

  const invalid = await call(controller.search, { body: { network_ids: [7], mode: "videos", videos: "garbage" } });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body.message, /valid YouTube video link/);
  assert.deepEqual(invalid.body.invalid, ["garbage"]);

  const tooMany = await call(controller.search, { body: { network_ids: [7], mode: "videos", videos: Array.from({ length: 51 }, (_, index) => `V${String(index).padStart(10, "0")}`) } });
  assert.equal(tooMany.statusCode, 400);
  assert.match(tooMany.body.message, /at most 50 unique videos/);

  const searched = await call(controller.search, { body: { network_ids: [7], mode: "videos", videos: "AAAAAAAAAAA" } });
  assert.equal(searched.statusCode, 200);
  assert.equal(searched.body.success, true);
  assert.equal(searched.body.totals.claims, 2);
  assert.deepEqual(logged, []);
});

test("a resource 401 after refresh reports a credentials error without disconnecting the CMS", async () => {
  cms.authFail = true;
  const res = await call(controller.search, { body: { network_ids: [7], mode: "videos", videos: "AAAAAAAAAAA" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].scope, "credentials");
  assert.equal(res.body.errors[0].message, "CMS authorization failed: Invalid Credentials.");
  assert.deepEqual(res.body.videos[0].errors.map((error) => error.network_id), [7]);
  assert.equal(authStatus(7), "connected");
});

test("the controller maps a repeated Google API 401 to 424 and leaves the connection intact", async () => {
  cms.authFail = true;
  const unauthorized = await call(controller.getDetail, { params: { networkId: "7", claimId: "C-ok" } });
  assert.equal(unauthorized.statusCode, 424);
  assert.equal(unauthorized.body.message, "CMS authorization failed: Invalid Credentials.");
  assert.equal(authStatus(7), "connected");
  assert.ok(logged.some((line) => /^\[claim-manager\] 424 network=7 reason=authError: CMS authorization failed/.test(line)), "the answer is logged with the network id");
});

test("the controller maps a failed token refresh to 424 and flags the network", async () => {
  const res = await call(controller.getDetail, { params: { networkId: "9", claimId: "C-ok" } });
  assert.equal(res.statusCode, 424);
  assert.equal(res.body.reason, "invalid_grant", "the OAuth error code of the token endpoint's body");
  assert.match(res.body.message, /^CMS authorization failed: invalid_grant: Token has been expired or revoked\. Re-authorize this CMS/);
  assert.equal(authStatus(9), "error");
  assert.equal(memoryDb.prepare("SELECT cms_auth_error FROM networks WHERE id = 9").get().cms_auth_error, "invalid_grant: Token has been expired or revoked.");
  assert.ok(logged.some((line) => line.startsWith("[claim-manager] 424 network=9 reason=invalid_grant")));
});

test("the controller maps Google rate limits and quota 403s to 429 with Retry-After", async () => {
  cms.rateLimit = true;
  const limited = await call(controller.getDetail, { params: { networkId: "7", claimId: "C-ok" } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.retry_after, 0);
  assert.equal(limited.headers["retry-after"], "0");
  assert.equal(limited.body.reason, "rateLimitExceeded");
  cms.rateLimit = false;

  cms.quotaFail = true;
  const quota = await call(controller.getDetail, { params: { networkId: "7", claimId: "C-ok" } });
  assert.equal(quota.statusCode, 429);
  assert.equal(quota.body.retry_after, 60, "no Retry-After from Google: a minute");
  assert.equal(quota.headers["retry-after"], "60");
  assert.equal(quota.body.reason, "quotaExceeded");
  assert.match(quota.body.message, /^Content ID API quota or rate limit reached for this project/);
  assert.doesNotMatch(quota.body.message, /CMS permission denied/);
  assert.equal(authStatus(7), "connected");
  assert.ok(logged.some((line) => line.startsWith("[claim-manager] 429 network=7 reason=quotaExceeded")));
});

test("the controller maps an unanswered Google call to 504 and a Google 5xx to 502", async () => {
  cms.timeoutAll = true;
  const silent = await call(controller.getDetail, { params: { networkId: "7", claimId: "C-ok" } });
  assert.equal(silent.statusCode, 504);
  assert.match(silent.body.message, /did not respond within 60 s/);
  cms.timeoutAll = false;

  calls.length = 0;
  cms.serverError = true;
  const broken = await call(controller.getDetail, { params: { networkId: "7", claimId: "C-ok" } });
  assert.equal(broken.statusCode, 502);
  assert.equal(broken.body.reason, "backendError");
  assert.match(broken.body.message, /Backend Error/);
  assert.equal(callsTo("GET", /\/claims\/C-ok$/).length, 3, "the idempotent read was retried three times");
  assert.ok(logged.some((line) => line.startsWith("[claim-manager] 504 network=7")));
  assert.ok(logged.some((line) => line.startsWith("[claim-manager] 502 network=7 reason=backendError")));
});

test("the controller passes 403 and 404 through and answers release, re-check, history and export", async () => {
  const forbidden = await call(controller.getDetail, { user: LIMITED, params: { networkId: "7", claimId: "C-foreign" } });
  assert.equal(forbidden.statusCode, 403);
  assert.match(forbidden.body.message, /not assigned to your allowed labels/);

  const missing = await call(controller.getDetail, { params: { networkId: "7", claimId: "C-missing" } });
  assert.equal(missing.statusCode, 404);

  cms.claims.get("C-later").status = "inactive";
  const released = await call(controller.release, { body: { releases: [{ network_id: 7, claim_id: "C-later" }], note: "again" } });
  assert.equal(released.statusCode, 200);
  assert.equal(released.body.results[0].outcome, "already_inactive");
  assert.equal(released.body.summary.already_inactive, 1);
  assert.equal("event_id" in released.body.results[0], false);

  const rechecked = await call(controller.recheck, { body: { items: [{ network_id: 7, claim_id: "C-later" }] } });
  assert.equal(rechecked.statusCode, 200);
  assert.deepEqual([rechecked.body.results[0].found, rechecked.body.results[0].status], [true, "inactive"]);
  const emptyRecheck = await call(controller.recheck, { body: {} });
  assert.equal(emptyRecheck.statusCode, 400);
  assert.match(emptyRecheck.body.message, /Select at least one claim to re-check/);

  const history = await call(controller.listHistory, { query: { result: "already_inactive", page: "1", page_size: "2" } });
  assert.equal(history.statusCode, 200);
  assert.equal(history.body.events.length, 1);
  assert.equal(history.body.page_size, 2);

  const exported = await call(controller.exportHistory, { query: {} });
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers["content-disposition"], /claim-release-history-\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(String(exported.body).startsWith("﻿"));
});

test("an unexpected error answers 500 with a reference that is also logged", async () => {
  const original = service.listClaimAccounts;
  service.listClaimAccounts = () => { throw new TypeError("boom"); };
  try {
    const res = await call(controller.listAccounts);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.message, /^Unexpected server error \(ref [0-9a-f]{8}\)$/);
    const ref = res.body.message.match(/ref ([0-9a-f]{8})/)[1];
    assert.ok(logged.some((line) => line.startsWith(`[claim-manager] ${ref} TypeError: boom`)), "the reference and the error are in the log");
  } finally {
    service.listClaimAccounts = original;
  }
});

// ---------------------------------------------------------------------------
// Round 2: token service outages, blind releases, overlapping requests, cancel, history bounds
// ---------------------------------------------------------------------------

const expired = () => new Date(Date.now() - 1000).toISOString();

// A network added for one test only: the fixture counts (three networks) stay untouched.
async function withNetwork(id, fields, fn) {
  insertNetwork.run(id, fields.name, `OWNER_${id}`, `cms${id}@example.com`, PARTNER_SCOPE, fields.accessToken, fields.refreshToken, fields.expiry);
  try {
    await fn();
  } finally {
    memoryDb.prepare("DELETE FROM networks WHERE id = ?").run(id);
  }
}

test("a token service that does not answer is a transient error: the CMS is not flagged and nothing says re-authorize", async () => {
  await withNetwork(11, { name: "Flaky CMS", accessToken: "token-11", refreshToken: "flaky", expiry: expired() }, async () => {
    cms.refreshFailure = "timeout";
    const timedOut = await call(controller.getDetail, { params: { networkId: "11", claimId: "C-ok" } });
    assert.equal(timedOut.statusCode, 504);
    assert.match(timedOut.body.message, /^Google's token service could not be reached to refresh the CMS access token \(timeout of 20000ms exceeded\); try again\.$/);
    assert.equal("reason" in timedOut.body, false);
    assert.equal(authStatus(11), "connected", "a timeout says nothing about the credential");
    assert.ok(logged.some((line) => line.startsWith("[claim-manager] 504 network=11 reason=-: Google's token service could not be reached")));

    cms.refreshFailure = "server_error";
    const outage = await call(controller.getDetail, { params: { networkId: "11", claimId: "C-ok" } });
    assert.equal(outage.statusCode, 502);
    assert.match(outage.body.message, /^Google's token service answered 500 while refreshing the CMS access token \(Backend Error\); try again\.$/);
    assert.equal(authStatus(11), "connected");

    cms.refreshFailure = "reset";
    const dropped = await call(controller.getDetail, { params: { networkId: "11", claimId: "C-ok" } });
    assert.equal(dropped.statusCode, 502);
    assert.match(dropped.body.message, /could not be reached .*socket hang up/);

    // Search: a transient read error of that CMS, not a credentials problem; the other CMS is read.
    cms.refreshFailure = "timeout";
    const search = await service.searchClaims({ user: ADMIN, body: { network_ids: [7, 11], mode: "videos", videos: ["AAAAAAAAAAA"] } });
    assert.equal(search.errors.length, 1);
    assert.deepEqual([search.errors[0].network_id, search.errors[0].scope], [11, "search"]);
    assert.match(search.errors[0].message, /^Google's token service could not be reached/);
    assert.equal(search.totals.claims, 2);

    // Release: nothing is sent for that CMS and the claims come back failed + retryable, not skipped.
    const release = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 11, claim_id: "C-ok" }, { network_id: 7, claim_id: "C-later" }] });
    const byId = Object.fromEntries(release.results.map((item) => [item.key, item]));
    assert.equal(byId["11:C-ok"].outcome, "failed");
    assert.equal(byId["11:C-ok"].retryable, true);
    assert.equal(byId["11:C-ok"].reason, "cms_unavailable");
    assert.match(byId["11:C-ok"].message, /^Not sent: Google's token service could not be reached/);
    assert.equal(byId["7:C-later"].outcome, "released");
    assert.deepEqual(callsTo("PATCH", /\/claims\//).map((item) => item.url.split("/").pop()), ["C-later"]);
    assert.equal(eventRows("network_id = 11")[0].result, "failed");

    const recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 11, claim_id: "C-ok" }] });
    assert.equal(recheck.results[0].found, false);
    assert.match(recheck.results[0].message, /^Google's token service could not be reached/);
    assert.equal(authStatus(11), "connected");

    // A rate-limited token endpoint: 429 with its Retry-After, the CMS stays connected.
    cms.refreshFailure = "rate_limit";
    const limited = await call(controller.getDetail, { params: { networkId: "11", claimId: "C-ok" } });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.retry_after, 7);
    assert.equal(limited.headers["retry-after"], "7");
    assert.match(limited.body.message, /^Google's token service answered 429 while refreshing the CMS access token \(rate_limit_exceeded: Too many requests\); try again\.$/);
    assert.equal(authStatus(11), "connected");

    // A rejected OAuth client is the server's configuration, not the CMS credential: no flag, no
    // re-authorize hint, an actionable message for the administrator.
    cms.refreshFailure = "invalid_client";
    const misconfigured = await call(controller.getDetail, { params: { networkId: "11", claimId: "C-ok" } });
    assert.equal(misconfigured.statusCode, 500);
    assert.match(misconfigured.body.message, /^Google rejected the CMS token refresh \(invalid_client: The OAuth client was not found\).*retry the saved grant\.$/);
    assert.equal(misconfigured.body.reason, "invalid_client");
    assert.equal(misconfigured.body.recovery, "restore_oauth_client");
    assert.equal(authStatus(11), "connected", "re-authorizing could not fix a rejected client");
    assert.ok(logged.some((line) => line.startsWith("[claim-manager] 500 network=11 reason=invalid_client: Google rejected the CMS token refresh")));
    const clientSearch = await service.searchClaims({ user: ADMIN, body: { network_ids: [7, 11], mode: "videos", videos: ["AAAAAAAAAAA"] } });
    assert.deepEqual([clientSearch.errors[0].network_id, clientSearch.errors[0].scope], [11, "search"]);
    assert.match(clientSearch.errors[0].message, /OAuth client/);
    const clientRelease = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 11, claim_id: "C-ok" }] });
    assert.equal(clientRelease.results[0].outcome, "skipped", "a retry cannot fix it, so it is not offered");
    assert.match(clientRelease.results[0].message, /OAuth client/);

    // Once Google answers again the CMS works without anyone re-authorizing it.
    cms.refreshFailure = null;
    const detail = await call(controller.getDetail, { params: { networkId: "11", claimId: "C-ok" } });
    assert.equal(detail.statusCode, 200);
    assert.equal(memoryDb.prepare("SELECT cms_access_token FROM networks WHERE id = 11").get().cms_access_token, "refreshed");
  });
});

test("an expired CMS grant without a refresh token is marked as requiring authorization", async () => {
  await withNetwork(10, { name: "Stale CMS", accessToken: "token-10", refreshToken: null, expiry: expired() }, async () => {
    const res = await call(controller.getDetail, { params: { networkId: "10", claimId: "C-ok" } });
    assert.equal(res.statusCode, 424);
    assert.equal(res.body.reason, "missing_refresh_token");
    assert.match(res.body.message, /^CMS authorization failed: CMS refresh token is missing\. Please re-auth CMS\. Re-authorize this CMS in Settings > Network\.$/);
    assert.equal(authStatus(10), "error");
    assert.ok(logged.some((line) => line.startsWith("[claim-manager] 424 network=10 reason=missing_refresh_token")));

    memoryDb.prepare("UPDATE networks SET cms_auth_status = 'connected' WHERE id = 10").run();
    const search = await service.searchClaims({ user: ADMIN, body: { network_ids: [7, 10], mode: "videos", videos: ["AAAAAAAAAAA"] } });
    assert.deepEqual([search.errors[0].network_id, search.errors[0].scope], [10, "credentials"]);
    assert.equal(authStatus(10), "error");

    memoryDb.prepare("UPDATE networks SET cms_auth_status = 'connected' WHERE id = 10").run();
    const release = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 10, claim_id: "C-ok" }] });
    assert.equal(release.results[0].outcome, "skipped");
    assert.match(release.results[0].message, /^CMS authorization failed: CMS refresh token is missing/);
    assert.equal(callsTo("PATCH", /\/claims\//).length, 0);
    assert.equal(eventRows("network_id = 10")[0].result, "skipped");
    assert.equal(authStatus(10), "error");
  });
});

test("a failed claim pre-read sends nothing: the claims come back failed and retryable for every user", async () => {
  cms.claimListFails = true;
  const admin = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }, { network_id: 7, claim_id: "C-inactive" }] });
  admin.results.forEach((item) => {
    assert.equal(item.outcome, "failed");
    assert.equal(item.reason, "pre_read_failed");
    assert.equal(item.retryable, true);
    assert.match(item.message, /^Not sent: the claim could not be read before the release \(Backend Error\)\. Retry\.$/);
  });
  assert.equal(callsTo("PATCH", /\/claims\//).length, 0, "a blind PATCH would report an already inactive claim as released");
  const rows = eventRows("operation_id = ?", admin.operation_id);
  assert.deepEqual(rows.map((row) => [row.claim_id, row.result, row.previous_status]), [["C-ok", "failed", null], ["C-inactive", "failed", null]]);
  assert.ok(logged.some((line) => /^\[claim-manager\] release pre-read failed for network 7: Backend Error/.test(line)));

  const limited = await service.releaseClaims({ user: LIMITED, releases: [{ network_id: 7, claim_id: "C-later" }] });
  assert.deepEqual([limited.results[0].outcome, limited.results[0].reason, limited.results[0].retryable], ["failed", "pre_read_failed", true]);

  // A token Google rejects on the pre-read blocks the CMS for the batch: the PATCHes would fail the same way.
  cms.claimListFails = false;
  cms.authFail = true;
  const rejected = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(rejected.results[0].outcome, "skipped");
  assert.equal(rejected.results[0].message, "CMS authorization failed: Invalid Credentials.");
  assert.equal(callsTo("PATCH", /\/claims\//).length, 0);
  assert.equal(authStatus(7), "connected");
});

test("a release PATCH still rejected after refresh stops the batch and preserves the CMS connection", async () => {
  cms.claims.set("C-auth", { ...cms.claims.get("C-later"), id: "C-auth" });
  cms.patchBehaviour = { "C-auth": "auth" };
  cms.patchDelayMs = 30;
  const result = await service.releaseClaims({ user: ADMIN, releases: ["C-auth", "C-ok", "C-later", "C-timeout", "C-refused"].map((claim_id) => ({ network_id: 7, claim_id })) });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));
  assert.equal(byId["C-auth"].outcome, "failed");
  assert.equal(byId["C-auth"].reason, "authError");
  assert.equal(byId["C-auth"].retryable, false);
  assert.equal(byId["C-auth"].message, "CMS authorization failed: Invalid Credentials.");
  assert.equal(byId["C-ok"].outcome, "released", "the claim in flight on another video finishes");
  ["C-later", "C-timeout", "C-refused"].forEach((id) => {
    assert.equal(byId[id].outcome, "skipped", `${id} (queued behind C-auth on the same video) is not sent after the 401 retry fails`);
    assert.equal(byId[id].message, "CMS authorization failed: Invalid Credentials.");
  });
  assert.deepEqual(callsTo("PATCH", /\/claims\//).map((item) => item.url.split("/").pop()).sort(), ["C-auth", "C-auth", "C-ok"]);
  assert.equal(authStatus(7), "connected");
  assert.deepEqual(eventRows("operation_id = ?", result.operation_id).map((row) => row.result).sort(), ["failed", "released", "skipped", "skipped", "skipped"]);
});

test("a re-check while a release of the claim is still running does not record the release a second time", async () => {
  cms.patchDelayMs = 120;
  // Four claims, three workers: C-refused waits in the queue while the first three are on the wire.
  const pending = service.releaseClaims({ user: ADMIN, releases: ["C-ok", "C-later", "C-timeout", "C-refused"].map((claim_id) => ({ network_id: 7, claim_id })) });
  await sleep(30);
  cms.claims.get("C-ok").status = "inactive"; // Google applied it; the answer is still on the wire
  const recheck = await service.recheckClaims({ user: ADMIN, items: [
    { network_id: 7, claim_id: "C-ok" }, { network_id: 7, claim_id: "C-refused" }, { network_id: 7, claim_id: "C-inactive" }
  ] });
  const byId = Object.fromEntries(recheck.results.map((item) => [item.key, item]));
  assert.deepEqual([byId["7:C-ok"].in_flight, byId["7:C-ok"].found, byId["7:C-ok"].status], [true, true, "inactive"]);
  assert.match(byId["7:C-ok"].message, /^A status change \(release, reinstate or confirm\) of this claim is still running on the server; its outcome will be recorded by that request\. Re-check it in a minute\.$/);
  assert.deepEqual([byId["7:C-refused"].in_flight, byId["7:C-refused"].status], [true, "active"], "a queued claim is pending too");
  assert.match(byId["7:C-refused"].message, /still running/);
  assert.deepEqual([byId["7:C-inactive"].in_flight, byId["7:C-inactive"].status, byId["7:C-inactive"].message], [false, "inactive", ""]);
  assert.equal(eventRows("action = 'recheck'").length, 0, "no confirmation row while the release owns the claim");

  const result = await pending;
  assert.deepEqual(result.results.map((item) => item.outcome), ["released", "released", "released", "released"]);
  const rows = eventRows("claim_id = 'C-ok'");
  assert.deepEqual(rows.map((row) => [row.action, row.result]), [["release", "released"]], "exactly one row for one release");
  assert.equal(service.listHistory({ user: ADMIN, filters: { result: "released" } }).summary.released, 4);

  const after = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.deepEqual([after.results[0].in_flight, after.results[0].message], [false, ""], "nothing pending once the batch is done");
});

test("a client that goes away stops the claims not reached yet: they are skipped, the ones in flight finish", async () => {
  cms.patchDelayMs = 60;
  const aborter = new AbortController();
  const pending = service.releaseClaims({ user: ADMIN, signal: aborter.signal, releases: ["C-ok", "C-later", "C-timeout", "C-refused", "C-forbidden"].map((claim_id) => ({ network_id: 7, claim_id })) });
  await sleep(15);
  aborter.abort();
  const result = await pending;
  assert.deepEqual(result.results.map((item) => item.outcome), ["released", "released", "skipped", "skipped", "skipped"], "C-ok and C-later were in flight; the rest of video D waited behind C-later");
  result.results.slice(2).forEach((item) => {
    assert.equal(item.reason, "cancelled");
    assert.match(item.message, /^Not sent: the run was cancelled \(the connection closed\) before this claim was reached\.$/);
  });
  assert.equal(callsTo("PATCH", /\/claims\//).length, 2);
  const rows = eventRows("operation_id = ?", result.operation_id);
  assert.deepEqual(rows.map((row) => row.result).sort(), ["released", "released", "skipped", "skipped", "skipped"]);
  assert.ok(rows.filter((row) => row.result === "skipped").every((row) => /cancelled/.test(row.message)));

  // Through the controller: the response's close event (before it ended) is the abort.
  cms.claims.get("C-ok").status = "active";
  cms.claims.get("C-later").status = "active";
  const res = makeRes();
  let onClose = null;
  res.writableEnded = false;
  res.on = (event, handler) => { if (event === "close") onClose = handler; };
  const done = controller.release({ params: {}, query: {}, user: ADMIN, body: { releases: ["C-ok", "C-later"].map((claim_id) => ({ network_id: 7, claim_id })) } }, res);
  await sleep(5);
  assert.equal(typeof onClose, "function");
  onClose();
  await done;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.results.map((item) => item.outcome), ["released", "released"], "both were already in flight");
  assert.equal(res.body.summary.skipped, 0);
});

test("a refused repeat completes the pending row of the earlier unanswered release instead of counting a second one", async () => {
  cms.patchBehaviour = { "C-timeout": "timeout" };
  cms.claimGetTimeouts = new Set(["C-timeout"]);
  const first = await service.releaseClaims({ user: ADMIN, note: "Rights expired", releases: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.equal(first.results[0].outcome, "unknown");

  // Google had applied the first call: the retry is refused and the read-back says inactive.
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = { "C-timeout": "refuse_then_inactive" };
  const second = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.equal(second.results[0].outcome, "already_inactive");
  assert.match(second.results[0].message, /^Claim was already inactive: the earlier release call whose answer was lost had been applied\. Nothing was changed by this call\.$/);
  assert.equal(second.results[0].claim.can_release, false);
  const rows = eventRows("claim_id = 'C-timeout'");
  assert.deepEqual(rows.map((row) => [row.action, row.result, row.result_status]), [["release", "released", "inactive"], ["release", "already_inactive", "inactive"]]);
  assert.match(rows[0].message, /^Confirmed inactive by a later release attempt/);
  assert.equal(rows[0].note, "Rights expired");
  assert.deepEqual(service.listHistory({ user: ADMIN, filters: {} }).summary, { released: 1, already_inactive: 1, reinstated: 0, confirmed: 0, already_active: 0, failed: 0, unknown: 0, skipped: 0 });
});

test("a release refused because the claim changed status reports the current status instead of the stale one", async () => {
  cms.patchBehaviour = { "C-later": "refuse_disputed" };
  const result = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-later" }] });
  const item = result.results[0];
  assert.deepEqual([item.outcome, item.retryable, item.status, item.reason], ["failed", false, "disputed", "invalidStatusTransition"]);
  assert.match(item.message, /^Claim is now disputed and cannot be released through the API \(Google: Supported status transitions .*\)\.$/);
  assert.equal(item.claim.status, "disputed");
  assert.equal(item.claim.can_release, false);
  assert.ok(item.claim.release_block_reason);
  assert.equal(callsTo("GET", /\/claims\/C-later$/).length, 1, "the read-back of the refusal is reused, not repeated");
  const row = eventRows("operation_id = ?", result.operation_id)[0];
  assert.deepEqual([row.result, row.previous_status, row.result_status], ["failed", "active", "disputed"]);
});

test("a search error of one videos batch is attributed to its own videos only", async () => {
  cms.failVideoBatches = new Set(["ZZZZZZZZZZZ"]);
  const result = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "ZZZZZZZZZZZ"] } });
  const searches = callsTo("GET", /\/claimSearch$/);
  assert.deepEqual([...new Set(searches.map((item) => item.params.videoId))].sort(), ["AAAAAAAAAAA,BBBBBBBBBBB,CCCCCCCCCCC", "ZZZZZZZZZZZ"], "two batches of at most three videos");
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0].video_ids, ["ZZZZZZZZZZZ"]);
  assert.deepEqual(result.videos.map((video) => [video.video_id, video.errors.length]), [["AAAAAAAAAAA", 0], ["BBBBBBBBBBB", 0], ["CCCCCCCCCCC", 0], ["ZZZZZZZZZZZ", 1]]);
  assert.equal(result.totals.claims, 5, "the healthy batch is kept");
});

test("history date bounds accept UTC calendar days and ISO instants, and paging is whole numbers", () => {
  const insert = memoryDb.prepare("INSERT INTO content_id_claim_events (operation_id, network_id, claim_id, result, created_at) VALUES ('op-time', 7, ?, 'released', ?)");
  insert.run("C-late", "2026-10-14 23:00:00");
  insert.run("C-early", "2026-10-15 01:00:00");
  const total = (filters) => service.listHistory({ user: ADMIN, filters }).total;
  assert.equal(total({ from: "2026-10-15" }), 1, "a date is a UTC calendar day");
  assert.equal(total({ to: "2026-10-14" }), 1, "a 'to' date covers the whole day");
  assert.equal(total({ from: "2026-10-14", to: "2026-10-14" }), 1);
  assert.equal(total({ from: "2026-10-14T17:00:00Z" }), 2, "an instant 'from' is inclusive (local midnight of UTC+7)");
  assert.equal(total({ from: "2026-10-14T23:00:00Z" }), 2);
  assert.equal(total({ to: "2026-10-14T23:00:00Z" }), 0, "an instant 'to' is exclusive");
  assert.equal(total({ to: "2026-10-14T23:00:00.500Z" }), 1, "a fractional end is rounded up to the next second");
  assert.equal(total({ from: "2026-10-14T17:00:00Z", to: "2026-10-15T17:00:00Z" }), 2);
  assert.throws(() => total({ from: "2026-10-14T25:00:00Z" }), /YYYY-MM-DD format or an ISO 8601 UTC instant/);
  assert.throws(() => total({ to: "yesterday" }), /YYYY-MM-DD/);
  const paged = service.listHistory({ user: ADMIN, filters: {}, page: "1.9", pageSize: "2.5" });
  assert.deepEqual([paged.page, paged.page_size, paged.events.length], [1, 2, 2], "fractions are truncated instead of reaching SQLite");
  const overflow = service.listHistory({ user: ADMIN, filters: {}, page: "1e400", pageSize: "Infinity" });
  assert.deepEqual([overflow.page, overflow.page_size], [1, 50], "non-finite numbers fall back instead of answering 500");
  assert.deepEqual([service.listHistory({ user: ADMIN, filters: {}, page: "1e18" }).page, service.listHistory({ user: ADMIN, filters: {}, page: "-4", pageSize: "0" }).page_size], [1000000, 50]);
  assert.equal(total({ to: "9999-12-31" }), 2, "a far-future day is an open upper bound, not an empty one");
  assert.equal(total({ from: "0001-01-01", to: "9999-12-31T23:59:59.999Z" }), 2);
  const csv = service.exportHistoryCsv({ user: ADMIN, filters: { search: "C-late" } }).trim().split("\r\n");
  assert.ok(csv[1].startsWith("2026-10-14T23:00:00Z,"), "CSV times are explicit UTC instants");
  assert.equal(service.exportHistoryCsv({ user: ADMIN, filters: { from: "2026-10-14T17:00:00Z", to: "2026-10-14T23:00:01Z" } }).trim().split("\r\n").length, 2);
});

test("a limited user's re-check says when the asset could not be read instead of denying the labels", async () => {
  cms.assetsFail = true;
  const limited = await service.recheckClaims({ user: LIMITED, items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(limited.results[0].found, false);
  assert.match(limited.results[0].message, /^The claim's asset could not be read, so its labels could not be verified for your account: Backend Error$/);
  const admin = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.deepEqual([admin.results[0].found, admin.results[0].status], [true, "active"], "asset metadata is optional for an admin's status read");
});

test("a retry whose pre-read already shows the claim inactive completes the earlier unanswered release", async () => {
  cms.patchBehaviour = { "C-timeout": "timeout" };
  cms.claimGetTimeouts = new Set(["C-timeout"]);
  const first = await service.releaseClaims({ user: ADMIN, note: "Rights expired", releases: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.equal(first.results[0].outcome, "unknown");
  const pendingRow = eventRows("claim_id = 'C-timeout'")[0];
  assert.equal(typeof pendingRow.duration_ms, "number");

  // Google had applied the lost call: the operator's retry reads the claim back as inactive before sending anything.
  cms.claimGetTimeouts = new Set();
  cms.claims.get("C-timeout").status = "inactive";
  const second = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.equal(second.results[0].outcome, "already_inactive");
  assert.match(second.results[0].message, /^Claim was already inactive: the earlier release call whose answer was lost had been applied\. Nothing was sent to Google\.$/);
  assert.equal(callsTo("PATCH", /\/claims\//).length, 2, "only the first attempt's two silent PATCHes went out");
  const rows = eventRows("claim_id = 'C-timeout'");
  assert.deepEqual(rows.map((row) => [row.action, row.result, row.result_status]), [["release", "released", "inactive"], ["release", "already_inactive", "inactive"]]);
  assert.match(rows[0].message, /^Confirmed inactive by a later release attempt/);
  assert.equal(rows[0].duration_ms, pendingRow.duration_ms, "completing the row keeps the duration of the unanswered call");
  assert.deepEqual(service.listHistory({ user: ADMIN, filters: {} }).summary, { released: 1, already_inactive: 1, reinstated: 0, confirmed: 0, already_active: 0, failed: 0, unknown: 0, skipped: 0 });

  // Nothing is left pending: a re-check records nothing more.
  const recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.deepEqual([recheck.results[0].status, recheck.results[0].message], ["inactive", ""]);
  assert.equal(eventRows("claim_id = 'C-timeout'").length, 2);
});

test("an unanswered release followed by a failed attempt is still confirmed by a later re-check", async () => {
  cms.patchBehaviour = { "C-timeout": "timeout" };
  cms.claimGetTimeouts = new Set(["C-timeout"]);
  await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-timeout" }] });
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = { "C-timeout": "conflict" }; // the retry itself fails: that says nothing about the lost call
  const retry = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.equal(retry.results[0].outcome, "failed");
  cms.claims.get("C-timeout").status = "inactive";
  const recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-timeout" }] });
  assert.match(recheck.results[0].message, /Confirmed inactive/);
  assert.deepEqual(eventRows("claim_id = 'C-timeout'").map((row) => [row.action, row.result]), [["release", "unknown"], ["release", "failed"], ["recheck", "released"]]);
});

test("a release that starts while a re-check is reading the claim is not recorded twice", async () => {
  cms.claimListDelayOnce = 100; // the re-check's claims.list answer takes a while
  const recheck = service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-ok" }] });
  await sleep(10);
  cms.patchDelayMs = 200;
  const release = service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }] });
  await sleep(30);
  cms.claims.get("C-ok").status = "inactive"; // Google applied the PATCH; its answer is still on the wire
  const checked = await recheck;
  assert.deepEqual([checked.results[0].in_flight, checked.results[0].status], [true, "inactive"], "the pending state is evaluated when the confirmation is decided");
  assert.match(checked.results[0].message, /still running/);
  assert.equal(eventRows("action = 'recheck'").length, 0);
  const released = await release;
  assert.equal(released.results[0].outcome, "released");
  assert.deepEqual(eventRows("claim_id = 'C-ok'").map((row) => [row.action, row.result]), [["release", "released"]]);
});

test("a pre-read refusal that a retry cannot fix is reported as a plain failure", async () => {
  cms.claimListFails = "forbidden";
  const result = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }] });
  const item = result.results[0];
  assert.deepEqual([item.outcome, item.reason, item.retryable, item.retry_after], ["failed", "pre_read_failed", false, null]);
  assert.match(item.message, /^Not sent: the claim could not be read before the release \(CMS permission denied: The caller does not have permission\)\.$/);
  assert.equal(callsTo("PATCH", /\/claims\//).length, 0);
});

test("claims of one video are released one after another, other videos in parallel, and an aborted write is repeated", async () => {
  // C-later, C-timeout and C-refused share video D; C-ok is on video A.
  cms.patchDelayMs = 40;
  cms.patchBehaviour = { "C-timeout": "aborted_once" };
  const result = await service.releaseClaims({ user: ADMIN, releases: ["C-later", "C-ok", "C-timeout", "C-refused"].map((claim_id) => ({ network_id: 7, claim_id })) });
  assert.deepEqual(result.results.map((item) => [item.claim_id, item.outcome]), [["C-later", "released"], ["C-ok", "released"], ["C-timeout", "released"], ["C-refused", "released"]], "results keep the request order");
  assert.equal(callsTo("PATCH", /\/claims\/C-timeout$/).length, 2, "the aborted PATCH was repeated once");
  const sameVideo = patchTimeline.filter((entry) => entry.id !== "C-ok");
  for (let index = 1; index < sameVideo.length; index += 1) {
    assert.ok(sameVideo[index].started >= sameVideo[index - 1].ended, `${sameVideo[index].id} waited for ${sameVideo[index - 1].id} to finish (same video)`);
  }
  const other = patchTimeline.find((entry) => entry.id === "C-ok");
  assert.ok(other.started < sameVideo[0].ended, "a claim on another video is not held back");
  assert.equal(eventRows("operation_id = ?", result.operation_id).filter((row) => row.result === "released").length, 4);
});

test("potential claims (matches awaiting confirmation) can be released", async () => {
  cms.claims.set("C-potential", { ...cms.claims.get("C-later"), id: "C-potential", status: "potential" });
  cms.snippets.push({ id: "C-potential", videoId: "DDDDDDDDDDD", assetId: "AS1", status: "potential", contentType: "audio", origin: { source: "audioMatch" }, timeCreated: "2026-10-08T06:30:37Z" });
  const search = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["DDDDDDDDDDD"] } });
  const found = search.claims.find((claim) => claim.claim_id === "C-potential");
  assert.deepEqual([found.status, found.can_release, found.release_block_reason], ["potential", true, ""]);
  const result = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-potential" }] });
  assert.equal(result.results[0].outcome, "released");
  assert.equal(result.results[0].status, "inactive");
  assert.equal(eventRows("claim_id = 'C-potential'")[0].previous_status, "potential");
});

// ---------------------------------------------------------------------------
// Reinstate (inactive -> active)
// ---------------------------------------------------------------------------

test("reinstating a released claim sets it active again with its own audit row; active and disputed claims are not sent", async () => {
  const result = await service.reinstateClaims({ user: ADMIN, note: "Released by mistake", items: [
    { network_id: 7, claim_id: "C-inactive", video_title: "Song A" },
    { network_id: 7, claim_id: "C-ok" },
    { network_id: 7, claim_id: "C-disputed" },
    { network_id: 7, claim_id: "bad id!" }
  ] });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));
  assert.deepEqual([byId["C-inactive"].outcome, byId["C-inactive"].status], ["reinstated", "active"]);
  assert.equal(byId["C-inactive"].message, "Claim reinstated and confirmed active by Google.");
  assert.deepEqual([byId["C-inactive"].claim.can_release, byId["C-inactive"].claim.can_reinstate], [true, false]);
  assert.deepEqual([byId["C-ok"].outcome, byId["C-ok"].message], ["already_active", "Claim was already active; nothing was sent to Google."]);
  assert.equal(byId["C-disputed"].outcome, "skipped");
  assert.equal(byId["C-disputed"].message, "Only inactive (released) claims can be reinstated through the API; this claim is disputed.");
  assert.equal(byId["bad id!"].outcome, "skipped");
  const patches = callsTo("PATCH", /\/claims\//);
  assert.deepEqual(patches.map((item) => [item.url.split("/").pop(), item.data.status]), [["C-inactive", "active"]], "only the inactive claim is written, with status active");
  assert.deepEqual(result.summary, { total: 4, reinstated: 1, already_active: 1, failed: 0, unknown: 0, skipped: 2 });
  const rows = eventRows("operation_id = ?", result.operation_id);
  assert.deepEqual(rows.map((row) => [row.action, row.claim_id, row.previous_status, row.result, row.result_status]).sort(), [
    ["reinstate", "C-disputed", "disputed", "skipped", "disputed"], ["reinstate", "C-inactive", "inactive", "reinstated", "active"], ["reinstate", "C-ok", "active", "already_active", "active"], ["reinstate", "bad id!", null, "skipped", null]
  ], "a skipped row keeps the status it was read with");
  assert.equal(rows.find((row) => row.claim_id === "C-inactive").note, "Released by mistake");
  assert.equal(rows.find((row) => row.claim_id === "C-inactive").video_title, "Song A");
  // The claim can be released again afterwards.
  const again = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.equal(again.results[0].outcome, "released");
  await assert.rejects(service.reinstateClaims({ user: ADMIN, items: [] }), /Select at least one claim to reinstate/);
});

test("search rows say whether a claim can be reinstated, and a limited Claim Manager stays inside their labels", async () => {
  const search = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA"] } });
  const inactive = search.claims.find((claim) => claim.claim_id === "C-inactive");
  const active = search.claims.find((claim) => claim.claim_id === "C-ok");
  assert.deepEqual([inactive.can_reinstate, inactive.reinstate_block_reason], [true, ""]);
  assert.deepEqual([active.can_reinstate, active.reinstate_block_reason], [false, "Only inactive (released) claims can be reinstated through the API; this claim is active"]);

  cms.claims.get("C-foreign").status = "inactive"; // asset AS2, label "Other": outside the limited user's labels
  const result = await service.reinstateClaims({ user: LIMITED, items: [{ network_id: 7, claim_id: "C-inactive" }, { network_id: 7, claim_id: "C-foreign" }] });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));
  assert.equal(byId["C-inactive"].outcome, "reinstated");
  assert.deepEqual([byId["C-foreign"].outcome, byId["C-foreign"].message], ["skipped", "This claim is not assigned to your allowed labels."]);
  assert.equal(callsTo("PATCH", /\/claims\//).length, 1);
});

test("an unanswered reinstate is confirmed by a re-check once the claim reads back active, and history counts it", async () => {
  cms.patchBehaviour = { "C-inactive": "timeout" };
  cms.claimGetTimeouts = new Set(["C-inactive"]);
  const pending = await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.equal(pending.results[0].outcome, "unknown");
  assert.match(pending.results[0].message, /The reinstate may still have been applied; re-check/);
  cms.claimGetTimeouts = new Set();

  // Still inactive: nothing is confirmed (the pending row is a reinstate, not a release).
  let recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.deepEqual([recheck.results[0].status, recheck.results[0].message], ["inactive", ""]);
  assert.equal(eventRows("claim_id = 'C-inactive'").length, 1);

  cms.claims.get("C-inactive").status = "active";
  recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.equal(recheck.results[0].message, "Confirmed active; the earlier reinstate was recorded.");
  assert.deepEqual(eventRows("claim_id = 'C-inactive'").map((row) => [row.action, row.result, row.result_status]), [["reinstate", "unknown", "inactive"], ["recheck", "reinstated", "active"]]);
  assert.equal(eventRows("claim_id = 'C-inactive'")[1].message, "Confirmed active on re-check after an unanswered reinstate call.");

  const history = service.listHistory({ user: ADMIN, filters: { result: "reinstated" } });
  assert.equal(history.total, 1);
  assert.deepEqual(history.events.map((event) => event.action), ["recheck"]);
  const everything = service.listHistory({ user: ADMIN, filters: {} }).summary;
  assert.deepEqual([everything.reinstated, everything.unknown], [1, 1]);
  const csv = service.exportHistoryCsv({ user: ADMIN, filters: { result: "reinstated" } }).trim().split("\r\n");
  assert.equal(csv.length, 2);
  assert.ok(csv[1].includes(",recheck,") && csv[1].includes(",reinstated,"));
});

test("the controller answers reinstate like release", async () => {
  const res = await call(controller.reinstate, { body: { items: [{ network_id: 7, claim_id: "C-inactive" }], note: "undo" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].outcome, "reinstated");
  assert.equal(res.body.summary.reinstated, 1);
  assert.equal("event_id" in res.body.results[0], false);
  const empty = await call(controller.reinstate, { body: {} });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.body.message, /Select at least one claim to reinstate/);
});

test("a write whose pre-read shows the other action landed confirms that action's unanswered row before writing", async () => {
  // Release applied by Google, answer lost, read-back silent: row #1 release/unknown, claim inactive.
  cms.patchBehaviour = { "C-ok": "reset" };
  cms.claimGetTimeouts = new Set(["C-ok"]);
  const release = await service.releaseClaims({ user: ADMIN, note: "Rights expired", releases: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(release.results[0].outcome, "unknown");
  assert.equal(cms.claims.get("C-ok").status, "inactive");
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};

  // The operator reinstates it: the pre-read (inactive) proves the lost release landed.
  const reinstate = await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(reinstate.results[0].outcome, "reinstated");
  const rows = eventRows("claim_id = 'C-ok'");
  assert.deepEqual(rows.map((row) => [row.action, row.result, row.result_status]), [["release", "released", "inactive"], ["reinstate", "reinstated", "active"]]);
  assert.equal(rows[0].message, "Confirmed inactive by a later reinstate attempt: the earlier unanswered release call had been applied.");
  assert.equal(rows[0].note, "Rights expired");
  assert.deepEqual(service.listHistory({ user: ADMIN, filters: {} }).summary.unknown, 0, "nothing stays pending");

  // Mirror: an unanswered reinstate that landed is confirmed by the next release.
  cms.patchBehaviour = { "C-inactive": "reset" };
  cms.claimGetTimeouts = new Set(["C-inactive"]);
  assert.equal((await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] })).results[0].outcome, "unknown");
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};
  assert.equal((await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-inactive" }] })).results[0].outcome, "released");
  assert.deepEqual(eventRows("claim_id = 'C-inactive'").map((row) => [row.action, row.result]), [["reinstate", "reinstated"], ["release", "released"]]);
});

test("a write applied by a silent first attempt and refused on the repeat is this call's own success", async () => {
  cms.patchBehaviour = { "C-ok": "apply_silently_then_refuse", "C-inactive": "apply_silently_then_refuse" };
  const release = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(release.results[0].outcome, "released");
  assert.equal(release.results[0].message, "Google did not answer the first attempt; the repeat was refused because the claim was already inactive, so this call had been applied.");
  assert.equal(callsTo("PATCH", /\/claims\/C-ok$/).length, 2, "the silent attempt and its refused repeat");
  assert.deepEqual(release.summary, { total: 1, released: 1, already_inactive: 0, failed: 0, unknown: 0, skipped: 0 });
  assert.equal(eventRows("claim_id = 'C-ok'")[0].result, "released");

  const reinstate = await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.equal(reinstate.results[0].outcome, "reinstated");
  assert.match(reinstate.results[0].message, /already active, so this call had been applied/);
});

test("a write on a claim another request is still changing is skipped before any pre-read verdict", async () => {
  cms.patchDelayMs = 120;
  const reinstating = service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] });
  await sleep(30);
  // The pre-read still reads inactive: without the in-flight guard this would answer "already inactive".
  const release = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.equal(release.results[0].outcome, "skipped");
  assert.equal(release.results[0].message, "This claim is being changed by another request right now; re-check it in a minute.");
  assert.equal((await reinstating).results[0].outcome, "reinstated");
  assert.equal(cms.claims.get("C-inactive").status, "active");
  assert.equal(callsTo("PATCH", /\/claims\//).length, 1);
});

test("a re-check says which write it confirmed", async () => {
  cms.patchBehaviour = { "C-timeout": "timeout" };
  cms.claimGetTimeouts = new Set(["C-timeout"]);
  await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-timeout" }] });
  cms.claimGetTimeouts = new Set();
  cms.claims.get("C-timeout").status = "inactive";
  const recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-timeout" }, { network_id: 7, claim_id: "C-ok" }] });
  const byId = Object.fromEntries(recheck.results.map((item) => [item.claim_id, item]));
  assert.deepEqual(byId["C-timeout"].confirmed, { action: "release", result: "released" });
  assert.equal(byId["C-ok"].confirmed, null);
});

// ---------------------------------------------------------------------------
// Confirm (potential -> active)
// ---------------------------------------------------------------------------

test("confirming potential claims sets them active with audit action confirm; other statuses are skipped", async () => {
  cms.claims.get("C-ok").status = "potential";
  cms.claims.get("C-foreign").status = "potential";
  const result = await service.confirmClaims({ user: ADMIN, note: "Checked by hand", items: [
    { network_id: 7, claim_id: "C-ok", video_title: "Song A" },
    { network_id: 7, claim_id: "C-foreign" },
    { network_id: 7, claim_id: "C-inactive" },
    { network_id: 7, claim_id: "C-disputed" }
  ] });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));
  assert.deepEqual([byId["C-ok"].outcome, byId["C-ok"].status], ["confirmed", "active"]);
  assert.equal(byId["C-ok"].message, "Claim confirmed: Google reports it active.");
  assert.deepEqual([byId["C-ok"].claim.status, byId["C-ok"].claim.can_release, byId["C-ok"].claim.can_reinstate, byId["C-ok"].claim.can_confirm], ["active", true, false, false]);
  assert.equal(byId["C-ok"].claim.confirm_block_reason, "Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is active");
  assert.equal(byId["C-ok"].claim.video_title, "Song A", "the page's title is kept on the result claim");
  assert.deepEqual([byId["C-foreign"].outcome, byId["C-foreign"].status], ["confirmed", "active"]);
  assert.deepEqual([byId["C-inactive"].outcome, byId["C-inactive"].message], ["skipped", "Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is inactive."]);
  assert.deepEqual([byId["C-disputed"].outcome, byId["C-disputed"].message], ["skipped", "Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is disputed."]);
  assert.deepEqual(result.summary, { total: 4, confirmed: 2, already_active: 0, failed: 0, unknown: 0, skipped: 2 });
  const patches = callsTo("PATCH", /\/claims\//);
  assert.deepEqual(patches.map((item) => [item.url.split("/").pop(), item.data.status]).sort(), [["C-foreign", "active"], ["C-ok", "active"]], "only the potential claims are written, with status active");
  const rows = eventRows("operation_id = ?", result.operation_id);
  assert.deepEqual(rows.map((row) => [row.action, row.claim_id, row.previous_status, row.result, row.result_status]).sort(), [
    ["confirm", "C-disputed", "disputed", "skipped", "disputed"],
    ["confirm", "C-foreign", "potential", "confirmed", "active"],
    ["confirm", "C-inactive", "inactive", "skipped", "inactive"],
    ["confirm", "C-ok", "potential", "confirmed", "active"]
  ]);
  assert.ok(rows.every((row) => row.note === "Checked by hand"), "the note is kept on every row");
  assert.equal(rows.find((row) => row.claim_id === "C-ok").video_title, "Song A");
  assert.equal(cms.claims.get("C-ok").status, "active");

  // A second confirm finds the claim already active and sends nothing.
  calls.length = 0;
  const again = await service.confirmClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.deepEqual([again.results[0].outcome, again.results[0].message], ["already_active", "Claim was already active; nothing was sent to Google."]);
  assert.equal(callsTo("PATCH", /\/claims\//).length, 0);
  assert.deepEqual(again.summary, { total: 1, confirmed: 0, already_active: 1, failed: 0, unknown: 0, skipped: 0 });
  await assert.rejects(service.confirmClaims({ user: ADMIN, items: [] }), /Select at least one claim to confirm/);
});

test("a confirm Google refuses because the claim is already active, applied on a silent first attempt, or refused for a changed status follows the shared read-back rules", async () => {
  cms.claims.get("C-ok").status = "potential";
  cms.claims.get("C-later").status = "potential";
  cms.claims.get("C-timeout").status = "potential";
  cms.patchBehaviour = { "C-ok": "refuse_then_inactive", "C-later": "apply_silently_then_refuse", "C-timeout": "refuse_disputed" };
  const result = await service.confirmClaims({ user: ADMIN, items: ["C-ok", "C-later", "C-timeout"].map((claim_id) => ({ network_id: 7, claim_id })) });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));
  assert.deepEqual([byId["C-ok"].outcome, byId["C-ok"].status], ["already_active", "active"], "the fake applies the wanted status before refusing: someone else got there first");
  assert.equal(byId["C-ok"].message, "Google refused the confirm because the claim was already active; nothing was changed by this call.");
  assert.deepEqual([byId["C-later"].outcome, byId["C-later"].status], ["confirmed", "active"]);
  assert.equal(byId["C-later"].message, "Google did not answer the first attempt; the repeat was refused because the claim was already active, so this call had been applied.");
  assert.deepEqual([byId["C-timeout"].outcome, byId["C-timeout"].status, byId["C-timeout"].retryable], ["failed", "disputed", false]);
  assert.match(byId["C-timeout"].message, /^Claim is now disputed and cannot be confirmed through the API \(Google: Supported status transitions/);
  assert.deepEqual([byId["C-timeout"].claim.can_confirm, byId["C-timeout"].claim.can_release], [false, false]);
  assert.deepEqual(result.summary, { total: 3, confirmed: 1, already_active: 1, failed: 1, unknown: 0, skipped: 0 });
  assert.deepEqual(eventRows("operation_id = ?", result.operation_id).map((row) => [row.claim_id, row.action, row.result, row.previous_status, row.result_status]).sort(), [
    ["C-later", "confirm", "confirmed", "potential", "active"], ["C-ok", "confirm", "already_active", "potential", "active"], ["C-timeout", "confirm", "failed", "potential", "disputed"]
  ]);
});

test("search rows carry can_confirm, and a limited Claim Manager's confirm stays inside their labels", async () => {
  cms.snippets[0].status = "potential"; // C-ok as claimSearch reports it
  cms.claims.get("C-ok").status = "potential";
  const search = await service.searchClaims({ user: ADMIN, body: { network_ids: [7], mode: "videos", videos: ["AAAAAAAAAAA"] } });
  const potential = search.claims.find((claim) => claim.claim_id === "C-ok");
  const inactive = search.claims.find((claim) => claim.claim_id === "C-inactive");
  assert.deepEqual([potential.status, potential.can_confirm, potential.confirm_block_reason], ["potential", true, ""]);
  assert.deepEqual([potential.can_release, potential.can_reinstate], [true, false], "a potential claim can be released or confirmed, not reinstated");
  assert.equal(inactive.can_confirm, false);
  assert.match(inactive.confirm_block_reason, /^Only potential claims/);
  assert.equal(inactive.confirm_block_reason, "Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is inactive");

  // A limited Claim Manager: a potential claim on an asset outside their labels is not confirmable
  // for the labels reason, in the row shape and in a write's result alike.
  const account = { id: 7, name: "Primary CMS", network_code: "OWNER_7" };
  const allowed = { keys: new Set(["ans"]), names: ["ANS"] };
  const outside = service.normalizeClaim({ id: "C-foreign", status: "potential", assetId: "AS2" }, account, { asset: { id: "AS2", labels: ["Other"] }, allowed });
  assert.deepEqual([outside.can_confirm, outside.confirm_block_reason], [false, "Asset is not in your allowed labels"]);
  const inside = service.normalizeClaim({ id: "C-ok", status: "potential", assetId: "AS1" }, account, { asset: { id: "AS1", labels: ["ANS", "Pop"] }, allowed });
  assert.deepEqual([inside.can_confirm, inside.confirm_block_reason], [true, ""]);
  const unverified = service.normalizeClaim({ id: "C-x", status: "potential" }, account, { asset: null, allowed });
  assert.deepEqual([unverified.can_confirm, unverified.confirm_block_reason], [false, "Asset labels could not be verified for your account"]);

  cms.claims.get("C-foreign").status = "potential"; // asset AS2, label "Other": outside the limited user's labels
  const result = await service.confirmClaims({ user: LIMITED, items: [{ network_id: 7, claim_id: "C-ok" }, { network_id: 7, claim_id: "C-foreign" }] });
  const byId = Object.fromEntries(result.results.map((item) => [item.claim_id, item]));
  assert.equal(byId["C-ok"].outcome, "confirmed");
  assert.deepEqual([byId["C-foreign"].outcome, byId["C-foreign"].message], ["skipped", "This claim is not assigned to your allowed labels."]);
  assert.deepEqual([byId["C-foreign"].claim.can_confirm, byId["C-foreign"].claim.confirm_block_reason], [false, "Asset is not in your allowed labels"]);
  assert.equal(callsTo("PATCH", /\/claims\//).length, 1);
  assert.equal(memoryDb.prepare("SELECT created_by FROM content_id_claim_events WHERE claim_id = 'C-ok' AND action = 'confirm'").get().created_by, 2);
});

test("an unanswered confirm is settled by a re-check once the claim reads back active, and history counts it", async () => {
  cms.claims.get("C-ok").status = "potential";
  cms.patchBehaviour = { "C-ok": "timeout" };
  cms.claimGetTimeouts = new Set(["C-ok"]);
  const pending = await service.confirmClaims({ user: ADMIN, note: "Checked by hand", items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(pending.results[0].outcome, "unknown");
  assert.match(pending.results[0].message, /The confirm may still have been applied; re-check/);
  assert.deepEqual(eventRows("claim_id = 'C-ok'").map((row) => [row.action, row.result, row.result_status]), [["confirm", "unknown", "potential"]]);
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};

  // Still potential: nothing is settled (no write ends potential).
  let recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.deepEqual([recheck.results[0].status, recheck.results[0].message, recheck.results[0].confirmed], ["potential", "", null]);
  assert.equal(eventRows("claim_id = 'C-ok'").length, 1);

  // Active now: the pending row is a confirm, not a reinstate, and the re-check settles it as such.
  cms.claims.get("C-ok").status = "active";
  recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.deepEqual(recheck.results[0].confirmed, { action: "confirm", result: "confirmed" });
  assert.equal(recheck.results[0].message, "Confirmed active; the earlier confirm was recorded.");
  assert.deepEqual([recheck.results[0].claim.status, recheck.results[0].claim.can_confirm, recheck.results[0].claim.can_release], ["active", false, true]);
  const rows = eventRows("claim_id = 'C-ok'");
  assert.deepEqual(rows.map((row) => [row.action, row.result, row.result_status]), [["confirm", "unknown", "potential"], ["recheck", "confirmed", "active"]], "the unanswered row stays as recorded; the settled recheck row completes the trail");
  assert.equal(rows[1].message, "Confirmed active on re-check after an unanswered confirm call.");
  assert.deepEqual([rows[1].note, rows[1].previous_status], ["Checked by hand", "potential"], "the re-check row carries the note and the pre-read status of the original confirm");

  const history = service.listHistory({ user: ADMIN, filters: { result: "confirmed" } });
  assert.equal(history.total, 1, "the result filter accepts \"confirmed\"");
  assert.deepEqual(history.events.map((event) => event.action), ["recheck"]);
  assert.deepEqual(service.listHistory({ user: ADMIN, filters: {} }).summary, { released: 0, already_inactive: 0, reinstated: 0, confirmed: 1, already_active: 0, failed: 0, unknown: 1, skipped: 0 });
  const csv = service.exportHistoryCsv({ user: ADMIN, filters: { result: "confirmed" } }).trim().split("\r\n");
  assert.equal(csv.length, 2);
  assert.ok(csv[1].includes(",recheck,") && csv[1].includes(",confirmed,"));

  // Nothing is left pending: a second re-check records nothing more.
  await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(eventRows("claim_id = 'C-ok'").length, 2);
});

test("a re-check settles the newest unanswered write when both a reinstate and a confirm are pending", async () => {
  // Both writes end active. An unanswered reinstate (the claim stays inactive), then the claim turns
  // potential and an unanswered confirm follows: once it reads back active, the confirm is the call
  // the status answers, so its row is the one settled.
  cms.patchBehaviour = { "C-inactive": "timeout" };
  cms.claimGetTimeouts = new Set(["C-inactive"]);
  assert.equal((await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] })).results[0].outcome, "unknown");
  cms.claims.get("C-inactive").status = "potential";
  assert.equal((await service.confirmClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] })).results[0].outcome, "unknown");
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};
  cms.claims.get("C-inactive").status = "active";
  const recheck = await service.recheckClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.deepEqual(recheck.results[0].confirmed, { action: "confirm", result: "confirmed" });
  assert.equal(recheck.results[0].message, "Confirmed active; the earlier confirm was recorded.");
  assert.deepEqual(eventRows("claim_id = 'C-inactive'").map((row) => [row.action, row.result]), [["reinstate", "unknown"], ["confirm", "unknown"], ["recheck", "confirmed"]]);
});

test("a release whose pre-read shows active settles the pending confirm row before writing; reinstate and confirm do the same for each other", async () => {
  // Confirm applied by Google, answer lost, read-back silent: row #1 confirm/unknown.
  cms.claims.get("C-ok").status = "potential";
  cms.patchBehaviour = { "C-ok": "timeout" };
  cms.claimGetTimeouts = new Set(["C-ok"]);
  const pending = await service.confirmClaims({ user: ADMIN, note: "Checked by hand", items: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(pending.results[0].outcome, "unknown");
  cms.claims.get("C-ok").status = "active"; // Google had applied it
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};

  // The operator releases it: the pre-read (active) proves the lost confirm landed.
  const release = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-ok" }] });
  assert.equal(release.results[0].outcome, "released");
  const rows = eventRows("claim_id = 'C-ok'");
  assert.deepEqual(rows.map((row) => [row.action, row.result, row.result_status]), [["confirm", "confirmed", "active"], ["release", "released", "inactive"]]);
  assert.equal(rows[0].message, "Confirmed active by a later release attempt: the earlier unanswered confirm call had been applied.");
  assert.equal(rows[0].note, "Checked by hand");
  assert.equal(service.listHistory({ user: ADMIN, filters: {} }).summary.unknown, 0, "nothing stays pending");

  // A reinstate whose pre-read shows active settles a pending confirm too, and answers already active.
  cms.claims.get("C-later").status = "potential";
  cms.patchBehaviour = { "C-later": "timeout" };
  cms.claimGetTimeouts = new Set(["C-later"]);
  assert.equal((await service.confirmClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-later" }] })).results[0].outcome, "unknown");
  cms.claims.get("C-later").status = "active";
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};
  calls.length = 0;
  const reinstate = await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-later" }] });
  assert.deepEqual([reinstate.results[0].outcome, reinstate.results[0].message], ["already_active", "Claim was already active; nothing was sent to Google."]);
  assert.equal(callsTo("PATCH", /\/claims\//).length, 0);
  assert.deepEqual(eventRows("claim_id = 'C-later'").map((row) => [row.action, row.result, row.result_status]), [["confirm", "confirmed", "active"], ["reinstate", "already_active", "active"]]);
  assert.equal(eventRows("claim_id = 'C-later'")[0].message, "Confirmed active by a later reinstate attempt: the earlier unanswered confirm call had been applied.");

  // And a confirm whose pre-read shows active settles a pending reinstate.
  cms.patchBehaviour = { "C-inactive": "timeout" };
  cms.claimGetTimeouts = new Set(["C-inactive"]);
  assert.equal((await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] })).results[0].outcome, "unknown");
  cms.claims.get("C-inactive").status = "active";
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};
  calls.length = 0;
  const confirm = await service.confirmClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.equal(confirm.results[0].outcome, "already_active");
  assert.equal(callsTo("PATCH", /\/claims\//).length, 0);
  assert.deepEqual(eventRows("claim_id = 'C-inactive'").map((row) => [row.action, row.result]), [["reinstate", "reinstated"], ["confirm", "already_active"]]);
  assert.equal(eventRows("claim_id = 'C-inactive'")[0].message, "Confirmed active by a later confirm attempt: the earlier unanswered reinstate call had been applied.");
});

test("a release whose pre-read shows active settles only the newest pending row, like a re-check", async () => {
  cms.patchBehaviour = { "C-inactive": "timeout" };
  cms.claimGetTimeouts = new Set(["C-inactive"]);
  assert.equal((await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] })).results[0].outcome, "unknown");
  cms.claims.get("C-inactive").status = "potential";
  assert.equal((await service.confirmClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-inactive" }] })).results[0].outcome, "unknown");
  cms.claimGetTimeouts = new Set();
  cms.patchBehaviour = {};
  cms.claims.get("C-inactive").status = "active";
  const release = await service.releaseClaims({ user: ADMIN, releases: [{ network_id: 7, claim_id: "C-inactive" }] });
  assert.equal(release.results[0].outcome, "released");
  // The confirm row was recorded while the claim was still potential, which proves the older reinstate
  // had not landed: only the newest pending row is settled and the reinstate stays unknown (exactly what
  // a re-check of the same state leaves), so the history never counts a reinstate that never happened.
  const rows = eventRows("claim_id = 'C-inactive'");
  assert.deepEqual(rows.map((row) => [row.action, row.result, row.result_status]), [["reinstate", "unknown", "inactive"], ["confirm", "confirmed", "active"], ["release", "released", "inactive"]]);
  assert.equal(rows[1].message, "Confirmed active by a later release attempt: the earlier unanswered confirm call had been applied.");
  const summary = service.listHistory({ user: ADMIN, filters: {} }).summary;
  assert.deepEqual([summary.unknown, summary.reinstated, summary.confirmed], [1, 0, 1]);

  // Google's refusal of a stale write settles by the same rule. A confirm whose answer was lost left a
  // pending row; the operator reinstates the claim (the pre-read still reads inactive) and Google refuses
  // because it is active when the PATCH arrives: the read-back settles the newest pending call that
  // targeted active, and the message says which call that was.
  cms.claims.get("C-later").status = "potential";
  cms.patchBehaviour = { "C-later": "timeout" };
  cms.claimGetTimeouts = new Set(["C-later"]);
  assert.equal((await service.confirmClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-later" }] })).results[0].outcome, "unknown");
  cms.claimGetTimeouts = new Set();
  cms.claims.get("C-later").status = "inactive";
  cms.patchBehaviour = { "C-later": "flip_active_then_refuse" };
  const refused = await service.reinstateClaims({ user: ADMIN, items: [{ network_id: 7, claim_id: "C-later" }] });
  assert.equal(refused.results[0].outcome, "already_active");
  assert.equal(refused.results[0].message, "Google refused the reinstate because the claim was already active: the earlier unanswered confirm call had been applied. Nothing was changed by this call.");
  assert.deepEqual(eventRows("claim_id = 'C-later'").map((row) => [row.action, row.result, row.result_status]), [["confirm", "confirmed", "active"], ["reinstate", "already_active", "active"]]);
});

test("the controller answers confirm like reinstate", async () => {
  cms.claims.get("C-ok").status = "potential";
  const res = await call(controller.confirm, { body: { items: [{ network_id: 7, claim_id: "C-ok" }], note: "checked" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.results[0].outcome, "confirmed");
  assert.equal(res.body.summary.confirmed, 1);
  assert.equal("event_id" in res.body.results[0], false);
  assert.deepEqual(eventRows("claim_id = 'C-ok'").map((row) => [row.action, row.result, row.note]), [["confirm", "confirmed", "checked"]]);
  const empty = await call(controller.confirm, { body: {} });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.body.message, /Select at least one claim to confirm/);
  const tooLong = await call(controller.confirm, { body: { items: [{ network_id: 7, claim_id: "C-ok" }], note: "x".repeat(501) } });
  assert.equal(tooLong.statusCode, 400);
  assert.match(tooLong.body.message, /at most 500 characters/);
  assert.deepEqual(logged, []);
});
