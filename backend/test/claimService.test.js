const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

const calls = { get: [], patch: [] };
let patchMode = "success";
let claimListItems = [];
let assetListItems = [];
let labelRows = [];
const networkRow = {
  id: 7,
  name: "Primary CMS",
  network_code: "OWNER_123",
  cms_auth_status: "connected",
  cms_auth_email: "cms@example.com",
  cms_auth_name: "CMS Admin",
  cms_auth_scopes: "https://www.googleapis.com/auth/youtubepartner",
  cms_access_token: "fresh-token",
  cms_refresh_token: "refresh-token",
  cms_token_expiry: new Date(Date.now() + 3600000).toISOString()
};

const fakeDb = {
  prepare(sql) {
    if (sql.includes("user_content_id_labels")) return { all: () => labelRows };
    if (sql.includes("FROM networks")) {
      return {
        all: () => [networkRow],
        get: () => networkRow,
        run: () => ({ changes: 1 })
      };
    }
    return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
  }
};

const fakeAxios = {
  async get(url, config) {
    calls.get.push({ url, config });
    if (url.endsWith("/claimSearch")) {
      return {
        data: {
          items: [
            { id: "claim-active", videoId: "AAAAAAAAAAA", assetId: "asset-1", status: "ACTIVE", contentType: "AUDIO" },
            { id: "claim-pending", videoId: "BBBBBBBBBBB", assetId: "asset-2", status: "PENDING", contentType: "AUDIOVISUAL" },
            { id: "claim-disputed", videoId: "BBBBBBBBBBB", assetId: "asset-3", status: "DISPUTED", contentType: "AUDIO" }
          ]
        }
      };
    }
    if (url.endsWith("/claims")) return { data: { items: claimListItems } };
    if (url.endsWith("/assets")) return { data: { items: assetListItems } };
    throw new Error(`Unexpected GET ${url}`);
  },
  async patch(url, body, config) {
    calls.patch.push({ url, body, config });
    if (patchMode === "timeout") {
      const error = new Error("request timed out");
      error.code = "ECONNABORTED";
      error.response = { headers: { "retry-after": "0" } };
      throw error;
    }
    if (patchMode === "rate_limit") {
      const error = new Error("rate limited");
      error.response = {
        status: 429,
        headers: { "retry-after": "30" },
        data: { error: { message: "Rate limit exceeded", errors: [{ reason: "rateLimitExceeded" }] } }
      };
      throw error;
    }
    return {
      data: {
        id: "claim-active",
        videoId: "AAAAAAAAAAA",
        assetId: "asset-1",
        status: "inactive",
        timeStatusLastModified: "2026-07-12T00:00:00Z"
      }
    };
  }
};

const originalLoad = Module._load;
Module._load = function loadWithClaimFakes(request, parent, isMain) {
  if (request === "axios") return fakeAxios;
  if (request === "../config/database") return fakeDb;
  if (request === "./googleCmsAuthService") return { refreshAccessToken: async () => ({ access_token: "refreshed", expires_in: 3600 }) };
  if (request === "./youtubeService") return { getVideosMetadataFromYoutube: async () => ({}) };
  if (request === "../middlewares/authMiddleware") {
    return {
      parseRoles(value) {
        return Array.isArray(value) ? value : [value].filter(Boolean);
      }
    };
  }
  return originalLoad(request, parent, isMain);
};

const claimService = require("../src/services/claimService");
Module._load = originalLoad;

test("video input validation rejects malformed URL IDs before spending quota", () => {
  const parsed = claimService.parseVideoInputs([
    "https://youtu.be/too-short",
    "https://www.youtube.com/watch?v=AAAAAAAAAAA",
    "https://www.youtube.com/live/BBBBBBBBBBB"
  ]);

  assert.deepEqual(parsed.videoIds, ["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  assert.deepEqual(parsed.invalid, ["https://youtu.be/too-short"]);
});

test("claim search batches multiple videos per CMS and maps releasable statuses", async () => {
  calls.get.length = 0;
  const result = await claimService.searchClaims({
    accountIds: [7],
    videoInput: "AAAAAAAAAAA\nBBBBBBBBBBB",
    includeDetails: false,
    user: { roles: ["admin"] }
  });

  assert.equal(calls.get.length, 1);
  assert.match(calls.get[0].url, /\/claimSearch$/);
  assert.equal(calls.get[0].config.params.videoId, "AAAAAAAAAAA,BBBBBBBBBBB");
  assert.equal(Object.hasOwn(calls.get[0].config.params, "maxResults"), false);
  assert.equal(Object.hasOwn(calls.get[0].config.params, "part"), false);
  assert.match(calls.get[0].config.params.fields, /timeStatusLastModified/);
  assert.equal(result.requestPlan.claimSearchRequests, 1);
  assert.equal(result.totals.claims, 3);
  assert.equal(result.totals.releasable, 2);
  assert.equal(result.videos[0].claims[0].canRelease, true);
  assert.equal(result.videos[1].claims.find((claim) => claim.id === "claim-pending").canRelease, true);
  assert.equal(result.videos[1].claims.find((claim) => claim.id === "claim-disputed").canRelease, false);
});

test("claim search never falls back to scanning every CMS when selection is empty", async () => {
  calls.get.length = 0;
  await assert.rejects(
    claimService.searchClaims({
      accountIds: [],
      videoInput: "AAAAAAAAAAA",
      includeDetails: false,
      user: { roles: ["admin"] }
    }),
    /Select at least one connected CMS/
  );
  assert.equal(calls.get.length, 0);
});

test("release deduplicates claims and uses one official claims.patch request without polling", async () => {
  calls.get.length = 0;
  calls.patch.length = 0;
  patchMode = "success";
  claimListItems = [];
  const result = await claimService.releaseClaims({
    releases: [
      { accountId: 7, claimId: "claim-active", videoId: "AAAAAAAAAAA" },
      { accountId: 7, claimId: "claim-active", videoId: "AAAAAAAAAAA" }
    ],
    user: { roles: ["admin"] }
  });

  assert.equal(calls.patch.length, 1);
  assert.equal(calls.get.length, 0);
  assert.match(calls.patch[0].url, /\/claims\/claim-active$/);
  assert.deepEqual(calls.patch[0].body, { status: "inactive" });
  assert.equal(calls.patch[0].config.params.onBehalfOfContentOwner, "OWNER_123");
  assert.equal(Object.hasOwn(calls.patch[0].config.params, "part"), false);
  assert.equal(calls.patch[0].config.params.prettyPrint, false);
  assert.equal(result.successCount, 1);
  assert.equal(result.verifiedCount, 1);
  assert.match(result.operationId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.optimization.automaticPolling, false);
  assert.equal(result.optimization.method, "claims.patch");
});

test("optional asset details are fetched in one batched and partial-response request", async () => {
  calls.get.length = 0;
  assetListItems = [
    { id: "asset-1", label: ["label-a"], metadataEffective: { title: "Asset A", isrc: "ISRC-A" } },
    { id: "asset-2", label: ["label-b"], metadataEffective: { title: "Asset B", isrc: "ISRC-B" } },
    { id: "asset-3", label: ["label-c"], metadataEffective: { title: "Asset C", isrc: "ISRC-C" } }
  ];

  const result = await claimService.searchClaims({
    accountIds: [7],
    videoInput: "AAAAAAAAAAA\nBBBBBBBBBBB",
    includeDetails: true,
    user: { roles: ["admin"] }
  });

  const assetCalls = calls.get.filter((call) => call.url.endsWith("/assets"));
  assert.equal(assetCalls.length, 1);
  assert.equal(assetCalls[0].config.params.id, "asset-1,asset-2,asset-3");
  assert.equal(Object.hasOwn(assetCalls[0].config.params, "maxResults"), false);
  assert.match(assetCalls[0].config.params.fields, /metadataEffective/);
  assert.equal(result.detailsIncluded, true);
  assert.equal(result.videos[0].claims[0].asset.isrc, "ISRC-A");
});

test("an uncertain release response is reconciled once without sending a duplicate patch", async () => {
  calls.get.length = 0;
  calls.patch.length = 0;
  patchMode = "timeout";
  claimListItems = [{ id: "claim-active", videoId: "AAAAAAAAAAA", assetId: "asset-1", status: "inactive" }];

  const result = await claimService.releaseClaims({
    releases: [{ accountId: 7, claimId: "claim-active", videoId: "AAAAAAAAAAA" }],
    user: { roles: ["admin"] }
  });

  assert.equal(calls.patch.length, 1);
  assert.equal(calls.get.length, 1);
  assert.match(calls.get[0].url, /\/claims$/);
  assert.equal(calls.get[0].config.params.id, "claim-active");
  assert.equal(result.successCount, 1);
  assert.equal(result.results[0].reconciled, true);
  assert.equal(result.results[0].claim.status, "inactive");
});

test("a missing claim during reconciliation is never reported as released", async () => {
  calls.get.length = 0;
  calls.patch.length = 0;
  patchMode = "timeout";
  claimListItems = [];

  const result = await claimService.releaseClaims({
    releases: [{ accountId: 7, claimId: "claim-active", videoId: "AAAAAAAAAAA" }],
    user: { roles: ["admin"] }
  });

  assert.equal(calls.patch.length, 1);
  assert.equal(calls.get.length, 1);
  assert.equal(result.successCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].outcomeUnknown, true);
});

test("a definitive 429 response does not trigger quota-expensive reconciliation", async () => {
  calls.get.length = 0;
  calls.patch.length = 0;
  patchMode = "rate_limit";
  claimListItems = [];

  const result = await claimService.releaseClaims({
    releases: [{ accountId: 7, claimId: "claim-active", videoId: "AAAAAAAAAAA" }],
    user: { roles: ["admin"] }
  });

  assert.equal(calls.patch.length, 1);
  assert.equal(calls.get.length, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].retryable, true);
  assert.equal(result.results[0].outcomeUnknown, false);
  assert.equal(result.results[0].retryAfter, "30");
});

test("limited managers bypass stale asset cache and must pass label authorization before inactive shortcut", async () => {
  patchMode = "success";
  labelRows = [];
  assetListItems = [{ id: "asset-1", label: ["label-a"], metadataEffective: { title: "Cached A" } }];
  await claimService.searchClaims({
    accountIds: [7],
    videoInput: "AAAAAAAAAAA",
    includeDetails: true,
    user: { roles: ["admin"] }
  });

  calls.get.length = 0;
  calls.patch.length = 0;
  labelRows = [{ name: "label-a", display_name: "Label A" }];
  claimListItems = [{ id: "claim-active", videoId: "AAAAAAAAAAA", assetId: "asset-1", status: "inactive" }];
  assetListItems = [{ id: "asset-1", label: ["label-b"], metadataEffective: { title: "Fresh B" } }];

  const result = await claimService.releaseClaims({
    releases: [{ accountId: 7, claimId: "claim-active", videoId: "AAAAAAAAAAA", assetId: "asset-1" }],
    user: { id: 42, roles: ["Claim Manager"] }
  });

  assert.equal(calls.get.filter((call) => call.url.endsWith("/assets")).length, 1);
  assert.equal(calls.patch.length, 0);
  assert.equal(result.successCount, 0);
  assert.match(result.results[0].message, /not assigned to your allowed labels/i);
});
