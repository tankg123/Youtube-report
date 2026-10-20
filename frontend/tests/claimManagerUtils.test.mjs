// The history filters convert local picker days into UTC instants: pin a non-UTC zone so a UTC
// implementation cannot pass by accident (node honours a runtime TZ assignment).
process.env.TZ = "Asia/Ho_Chi_Minh";

import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage, translate } from "../src/i18n/index.js";
import {
  ACTIVATABLE_STATUSES,
  ACTIVATE_CONFIRMATION_TEXT,
  CLAIM_STATUS_META,
  CONFIRMABLE_STATUSES,
  CONFIRM_BLOCK_DEFAULT,
  HISTORY_ACTION_LABELS,
  REINSTATE_BLOCK_DEFAULT,
  RELEASE_OUTCOMES,
  RELEASE_OUTCOME_META
} from "../src/pages/claimManager/constants.js";
import {
  CLAIM_CSV_HEADER,
  activateActionOf,
  activateBatches,
  activateBlockReason,
  applyActivateResults,
  applyRecheckResults,
  applyReinstateResults,
  applyReleaseResults,
  baseErrorMessage,
  batchFailureMessage,
  buildReleaseItems,
  buildRequestPlan,
  buildSearchPayload,
  claimFromHistoryEvent,
  claimKey,
  claimsToCsvRows,
  confirmBlockReason,
  countActiveFilters,
  countByStatus,
  describeApiError,
  extractVideoId,
  filterClaims,
  formatDurationMs,
  formatSeconds,
  groupClaimsByVideo,
  historyExportQuery,
  historyQuery,
  isActivatable,
  isClientTimeout,
  isConfirmable,
  isNetworkError,
  isReinstatable,
  isReleasable,
  isSelectable,
  isUnknownOutcomeError,
  mergeResultsByKey,
  mergeServerClaim,
  normalizeOutcome,
  orderedStatuses,
  outcomeLabel,
  outcomesForBatch,
  paginate,
  paginateGroups,
  parseIdList,
  parseVideoInput,
  recheckToOutcome,
  reconcileBatchResults,
  reconcileNetworkIds,
  reinstateBlockReason,
  releaseBlockReason,
  releaseSummaryText,
  removeLines,
  requestMessage,
  rowResultAction,
  selectActivatableKeys,
  selectReleasableKeys,
  sortClaims,
  statusLabel,
  summarizeRelease,
  summarizeSearch,
  toggleInList,
  toggleSort,
  unknownOutcomeMessage,
  unwrapBlobError,
  validateSearch
} from "../src/pages/claimManager/utils.js";

const ID = "dQw4w9WgXcQ";

function claim(overrides = {}) {
  return {
    key: `2:${overrides.claim_id || "C1"}`,
    claim_id: "C1",
    network_id: 2,
    network_name: "BPM Digital",
    content_owner_id: "ABC123",
    video_id: ID,
    video_url: `https://www.youtube.com/watch?v=${ID}`,
    video_title: "Song title",
    video: { title: "Song title", channel_title: "Channel", thumbnail: "https://i.ytimg.com/x.jpg", duration_text: "3:21" },
    asset_id: "A1",
    asset: { id: "A1", title: "Asset title", isrc: "VNA122400001", upc: "123456789012", labels: ["ANS", "Pop"] },
    status: "active",
    content_type: "audio",
    origin: "audioMatch",
    is_partner_uploaded: false,
    third_party: false,
    time_created: "2026-01-01T00:00:00Z",
    time_status_last_modified: "2026-01-02T00:00:00Z",
    video_views: 1234,
    can_release: true,
    release_block_reason: "",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Video id / id list parsing
// ---------------------------------------------------------------------------

test("extractVideoId handles every YouTube link shape and bare ids", () => {
  const cases = [
    [ID, ID],
    [`  ${ID}  `, ID],
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://www.youtube.com/watch?v=${ID}&t=42s&list=PLx`, ID],
    [`https://www.youtube.com/watch?feature=share&v=${ID}`, ID],
    [`https://m.youtube.com/watch?v=${ID}#comments`, ID],
    [`https://music.youtube.com/watch?v=${ID}`, ID],
    [`youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}`, ID],
    [`https://youtu.be/${ID}?si=abc123`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`https://www.youtube.com/live/${ID}?feature=share`, ID],
    [`https://www.youtube.com/embed/${ID}?autoplay=1`, ID],
    [`https://www.youtube.com/v/${ID}`, ID],
    [`https://studio.youtube.com/video/${ID}/edit`, ID],
    [`v=${ID}`, ID],
    [`<https://youtu.be/${ID}>`, ID],
    [`"https://www.youtube.com/watch?v=${ID}",`, ID],
    [`https://www.youtube.com/watch?v=${ID}.`, ID],
    ["not a video", null],
    ["not-a-video!", null],
    ["abcdefghij", null],
    ["abcdefghijkl", null],
    [`https://youtu.be/${ID}x`, null],
    ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", null],
    ["https://www.youtube.com/playlist?list=PLabcdefghijk", null],
    ["", null],
    [null, null],
    [undefined, null]
  ];
  cases.forEach(([input, expected]) => {
    assert.equal(extractVideoId(input), expected, `extractVideoId(${JSON.stringify(input)})`);
  });
});

test("parseVideoInput dedupes ids, keeps input order and reports invalid lines", () => {
  const text = [
    `https://www.youtube.com/watch?v=${ID}`,
    "",
    "   ",
    "https://youtu.be/AAAAAAAAAAA",
    `${ID}`,
    "not a video at all",
    "https://www.youtube.com/shorts/BBBBBBBBBBB, https://youtu.be/CCCCCCCCCCC",
    "https://www.youtube.com/watch?v=AAAAAAAAAAA\tTitle pasted from a sheet",
    "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"
  ].join("\n");
  const parsed = parseVideoInput(text);
  assert.deepEqual(parsed.ids, [ID, "AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]);
  assert.deepEqual(parsed.invalid, ["not a video at all", "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"]);
  assert.equal(parsed.duplicates, 2);
  assert.deepEqual(parseVideoInput(""), { ids: [], invalid: [], duplicates: 0 });
  assert.deepEqual(parseVideoInput([ID, "AAAAAAAAAAA"]).ids, [ID, "AAAAAAAAAAA"]);
  assert.deepEqual(parseVideoInput("a\r\nb\r\n").invalid, ["a", "b"]);
});

test("parseVideoInput gives links precedence over the other tokens of their line", () => {
  // A spreadsheet row "link <tab> title" never turns the title into bare ids.
  assert.deepEqual(parseVideoInput(`https://youtu.be/${ID}\tSong title here`), { ids: [ID], invalid: [], duplicates: 0 });
  assert.deepEqual(parseVideoInput(`https://www.youtube-nocookie.com/embed/${ID}\tTitle pasted next to it`), { ids: [ID], invalid: [], duplicates: 0 });
  assert.deepEqual(parseVideoInput(`https://youtu.be/${ID} Hello-World`), { ids: [ID], invalid: [], duplicates: 0 });
  // Without a link, every token is parsed on its own: bare ids count, other words are ignored …
  assert.deepEqual(parseVideoInput("AAAAAAAAAAA, BBBBBBBBBBB"), { ids: ["AAAAAAAAAAA", "BBBBBBBBBBB"], invalid: [], duplicates: 0 });
  assert.deepEqual(parseVideoInput(`${ID} Hello World`), { ids: [ID], invalid: [], duplicates: 0 });
  // … which, exactly like the backend's parseVideoInputs, takes any 11-character id-safe word for an id.
  assert.deepEqual(parseVideoInput(`${ID} Hello-World`).ids, [ID, "Hello-World"]);
  // A link that carries no id makes its line invalid, even when a bare id sits next to it.
  assert.deepEqual(parseVideoInput("https://youtu.be/short"), { ids: [], invalid: ["https://youtu.be/short"], duplicates: 0 });
  assert.deepEqual(parseVideoInput(`https://youtu.be/short ${ID}`), { ids: [], invalid: [`https://youtu.be/short ${ID}`], duplicates: 0 });
  // Bare "v=ID" / "?vi=ID" fragments are understood on their own too (same extractVideoId as links).
  assert.deepEqual(parseVideoInput(`v=${ID}`).ids, [ID]);
  assert.deepEqual(parseVideoInput(`?vi=${ID}`).ids, [ID]);
});

test("parseIdList splits on separators, trims quotes and dedupes", () => {
  assert.deepEqual(parseIdList("A1, A2;A3 | A4\nA5\r\n A1 "), ["A1", "A2", "A3", "A4", "A5"]);
  assert.deepEqual(parseIdList('"C1", (C2) <C3>'), ["C1", "C2", "C3"]);
  assert.deepEqual(parseIdList(""), []);
  assert.deepEqual(parseIdList(null), []);
  assert.deepEqual(parseIdList(["X", " X ", "Y"]), ["X", "Y"]);
});

test("removeLines drops the listed lines only", () => {
  assert.equal(removeLines(`${ID}\nbad line\n  bad line \nAAAAAAAAAAA`, ["bad line"]), `${ID}\nAAAAAAAAAAA`);
});

test("toggleInList adds a missing value and removes a present one without mutating", () => {
  assert.deepEqual(toggleInList(["active"], "pending"), ["active", "pending"]);
  assert.deepEqual(toggleInList(["active", "pending"], "active"), ["pending"]);
  assert.deepEqual(toggleInList(null, "x"), ["x"]);
  const list = ["a"];
  assert.notEqual(toggleInList(list, "b"), list);
  assert.deepEqual(list, ["a"]);
});

// ---------------------------------------------------------------------------
// Search validation, payload and request plan
// ---------------------------------------------------------------------------

test("validateSearch enforces CMS selection, mode limits and date ranges", () => {
  const limits = { max_videos: 2, max_assets: 1, max_claim_ids: 3, max_networks: 2 };
  assert.match(validateSearch({ mode: "videos", networkIds: [], parsed: { ids: [ID] }, limits }), /Select at least one CMS/);
  assert.match(validateSearch({ mode: "explore", networkIds: [1, 2], parsed: { ids: [] }, limits }), /exactly one CMS/);
  assert.match(validateSearch({ mode: "videos", networkIds: [1, 2, 3], parsed: { ids: [ID] }, limits }), /at most 2 CMS/);
  assert.match(validateSearch({ mode: "videos", networkIds: [1], parsed: { ids: [] }, limits }), /at least one YouTube video/);
  assert.match(validateSearch({ mode: "videos", networkIds: [1], parsed: { ids: ["a", "b", "c"] }, limits }), /at most 2 unique videos/);
  assert.match(validateSearch({ mode: "assets", networkIds: [1], parsed: { ids: [] }, limits }), /at least one asset ID/);
  assert.match(validateSearch({ mode: "assets", networkIds: [1], parsed: { ids: ["A", "B"] }, limits }), /at most 1 unique asset IDs/);
  assert.match(validateSearch({ mode: "claims", networkIds: [1], parsed: { ids: ["a", "b", "c", "d"] }, limits }), /at most 3 unique claim IDs/);
  assert.equal(validateSearch({ mode: "claims", networkIds: [1], parsed: { ids: ["a"] }, limits }), "");
  // Explore needs a search text or at least one filter (the backend refuses to list a whole CMS); the sort does not count.
  const exploreEmpty = "Enter a search text or at least one filter to explore claims.";
  assert.equal(validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [], query: "" }, limits }), exploreEmpty);
  assert.equal(validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [] }, limits, filters: { sort: "DAILY_ENGAGED_VIEWS" } }), exploreEmpty);
  assert.equal(validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [], query: "   " }, limits }), exploreEmpty);
  assert.equal(validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [], query: "lofi" }, limits }), "");
  assert.equal(validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [] }, limits, filters: { statuses: ["active"] } }), "");
  assert.equal(validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [] }, limits, filters: { created_after: "2026-01-01" } }), "");
  // The CMS checks still come first; the date checks still run after it.
  assert.match(validateSearch({ mode: "explore", networkIds: [], parsed: { ids: [] }, limits }), /Select at least one CMS/);
  assert.match(validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [] }, limits, filters: { created_after: "01/02/2026" } }), /YYYY-MM-DD/);
  assert.match(
    validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [] }, limits, filters: { created_after: "2026-02-01", created_before: "2026-01-01" } }),
    /Created date range is reversed/
  );
  assert.match(validateSearch({ mode: "videos", networkIds: [1], parsed: { ids: [ID] }, limits, filters: { status_modified_after: "01/02/2026" } }), /YYYY-MM-DD/);
  // Defaults apply when limits are missing.
  assert.equal(validateSearch({ mode: "videos", networkIds: [1], parsed: { ids: [ID] } }), "");
});

test("buildSearchPayload sends only the fields of the active mode and non-empty filters", () => {
  const filters = {
    statuses: ["active", ""],
    content_types: [],
    origins: ["audioMatch"],
    created_after: "2026-01-01",
    created_before: "",
    status_modified_after: "",
    status_modified_before: "",
    partner_uploaded: false,
    sort: "DAILY_ENGAGED_VIEWS"
  };
  const videos = buildSearchPayload({ mode: "videos", networkIds: ["2", 3], parsed: { ids: [ID] }, filters, includeDetails: true });
  assert.deepEqual(videos, {
    network_ids: [2, 3],
    mode: "videos",
    include_details: true,
    videos: [ID],
    filters: { statuses: ["active"], origins: ["audioMatch"], created_after: "2026-01-01", partner_uploaded: false }
  });
  const explore = buildSearchPayload({ mode: "explore", networkIds: [2], parsed: { ids: [] }, query: "  lofi  ", filters, includeDetails: false, pageToken: "tok" });
  assert.equal(explore.query, "lofi");
  assert.equal(explore.page_token, "tok");
  assert.equal(explore.filters.sort, "DAILY_ENGAGED_VIEWS");
  assert.equal(explore.include_details, false);
  assert.equal("videos" in explore, false);
  const claims = buildSearchPayload({ mode: "claims", networkIds: [2], parsed: { ids: ["C1"] }, filters: {} });
  assert.deepEqual(claims, { network_ids: [2], mode: "claims", include_details: true, claim_ids: ["C1"] });
  assert.deepEqual(buildSearchPayload({ mode: "assets", networkIds: [2], parsed: { ids: ["A1"] } }).asset_ids, ["A1"]);
  assert.equal(countActiveFilters(filters), 4);
  assert.equal(countActiveFilters({ sort: "DATE" }), 0);
});

test("buildRequestPlan estimates reads from videos × networks / batch size", () => {
  const limits = { video_batch_size: 50 };
  assert.equal(buildRequestPlan({ mode: "videos", count: 0, networkCount: 0, limits }).reads, 0);
  assert.equal(buildRequestPlan({ mode: "videos", count: 12, networkCount: 2, limits }).reads, 2);
  assert.equal(buildRequestPlan({ mode: "videos", count: 51, networkCount: 2, limits }).reads, 4);
  const detailed = buildRequestPlan({ mode: "videos", count: 51, networkCount: 1, includeDetails: true, limits });
  assert.equal(detailed.detailReads, 2);
  assert.match(detailed.text, /51 videos × 1 CMS ⇒ 2 claim-search reads \+ 2 video-detail reads/);
  assert.equal(buildRequestPlan({ mode: "assets", count: 3, networkCount: 2, limits }).reads, 6);
  assert.equal(buildRequestPlan({ mode: "claims", count: 120, networkCount: 1, limits }).reads, 3);
  assert.equal(buildRequestPlan({ mode: "explore", count: 0, networkCount: 1, limits }).reads, 1);
  assert.match(buildRequestPlan({ mode: "videos", count: 0, networkCount: 1, limits }).text, /Enter videos/);
});

// ---------------------------------------------------------------------------
// Claim rows
// ---------------------------------------------------------------------------

test("claimKey accepts ids or a row", () => {
  assert.equal(claimKey(2, "C1"), "2:C1");
  assert.equal(claimKey({ network_id: 2, claim_id: "C1" }), "2:C1");
  assert.equal(claimKey({ key: "9:X", network_id: 2, claim_id: "C1" }), "9:X");
});

test("releaseBlockReason explains every non-releasable row", () => {
  assert.equal(releaseBlockReason(claim()), "");
  assert.equal(releaseBlockReason(claim({ can_release: false, release_block_reason: "Asset is not in your allowed labels" })), "Asset is not in your allowed labels");
  assert.match(releaseBlockReason(claim({ can_release: false, status: "inactive", release_block_reason: "" })), /inactive status cannot be released/);
  assert.match(releaseBlockReason(claim({ can_release: false, status: "release_unknown", release_block_reason: "" })), /re-check/);
});

test("filterClaims matches claim, video, asset, title, ISRC, label and status chips", () => {
  const rows = [
    claim({ claim_id: "C1" }),
    claim({
      claim_id: "C2",
      status: "inactive",
      can_release: false,
      asset: { id: "A2", title: "Other", isrc: "USX999", labels: [] },
      video_title: "Another video",
      video: { title: "Another video", channel_title: "Other channel" }
    }),
    claim({ claim_id: "C3", status: "pending", video: null, video_title: "" })
  ];
  assert.deepEqual(filterClaims(rows, { query: "c2" }).map((row) => row.claim_id), ["C2"]);
  assert.deepEqual(filterClaims(rows, { query: "VNA1224" }).map((row) => row.claim_id), ["C1", "C3"]);
  assert.deepEqual(filterClaims(rows, { query: "another" }).map((row) => row.claim_id), ["C2"]);
  assert.deepEqual(filterClaims(rows, { query: "pop" }).map((row) => row.claim_id), ["C1", "C3"]);
  assert.deepEqual(filterClaims(rows, { query: "song channel" }).map((row) => row.claim_id), ["C1"]);
  assert.deepEqual(filterClaims(rows, { statuses: ["pending", "inactive"] }).map((row) => row.claim_id), ["C2", "C3"]);
  assert.deepEqual(filterClaims(rows, { query: "usx", statuses: ["active"] }), []);
  assert.equal(filterClaims(rows, {}).length, 3);
  assert.deepEqual(countByStatus(rows), { active: 1, inactive: 1, pending: 1 });
  assert.deepEqual(orderedStatuses({ inactive: 1, active: 1, release_unknown: 2, pending: 1 }), ["active", "pending", "inactive", "release_unknown"]);
});

test("sortClaims is stable and toggleSort cycles asc → desc → none", () => {
  const rows = [
    claim({ claim_id: "C1", status: "inactive", time_created: "2026-01-03T00:00:00Z", video_title: "b" }),
    claim({ claim_id: "C2", status: "active", time_created: "2026-01-01T00:00:00Z", video_title: "a" }),
    claim({ claim_id: "C3", status: "active", time_created: "2026-01-02T00:00:00Z", video_title: "a" })
  ];
  assert.deepEqual(sortClaims(rows, { key: "created", dir: "asc" }).map((row) => row.claim_id), ["C2", "C3", "C1"]);
  assert.deepEqual(sortClaims(rows, { key: "created", dir: "desc" }).map((row) => row.claim_id), ["C1", "C3", "C2"]);
  assert.deepEqual(sortClaims(rows, { key: "status", dir: "asc" }).map((row) => row.claim_id), ["C2", "C3", "C1"]);
  assert.deepEqual(sortClaims(rows, { key: "video", dir: "asc" }).map((row) => row.claim_id), ["C2", "C3", "C1"]);
  assert.equal(sortClaims(rows, null), rows);
  assert.deepEqual(toggleSort(null, "created"), { key: "created", dir: "asc" });
  assert.deepEqual(toggleSort({ key: "created", dir: "asc" }, "created"), { key: "created", dir: "desc" });
  assert.equal(toggleSort({ key: "created", dir: "desc" }, "created"), null);
  assert.deepEqual(toggleSort({ key: "created", dir: "desc" }, "status"), { key: "status", dir: "asc" });
});

test("paginate clamps the page and reports the visible range", () => {
  const items = Array.from({ length: 120 }, (_, index) => index);
  assert.deepEqual(paginate(items, 1, 50).items.length, 50);
  const last = paginate(items, 9, 50);
  assert.equal(last.page, 3);
  assert.equal(last.pageCount, 3);
  assert.deepEqual([last.start, last.end, last.total], [101, 120, 120]);
  assert.deepEqual(paginate([], 1, 50), { items: [], page: 1, pageCount: 1, total: 0, start: 0, end: 0 });
});

test("groupClaimsByVideo keeps the video order, empty videos and per-video errors", () => {
  const videos = [
    { video_id: "AAAAAAAAAAA", title: "First", channel_title: "Ch", thumbnail: "", duration_text: "1:00", claim_count: 0, errors: [{ network_id: 2, network_name: "BPM", message: "boom" }] },
    { video_id: ID, title: "Second", claim_count: 2 }
  ];
  const rows = [claim({ claim_id: "C1" }), claim({ claim_id: "C2", can_release: false, status: "inactive" }), claim({ claim_id: "C3", video_id: "ZZZZZZZZZZZ", video_url: "", video_title: "Orphan" })];
  const groups = groupClaimsByVideo(rows, videos);
  assert.deepEqual(groups.map((group) => group.video_id), ["AAAAAAAAAAA", ID, "ZZZZZZZZZZZ"]);
  assert.equal(groups[0].claim_count, 0);
  assert.equal(groups[0].errors.length, 1);
  assert.equal(groups[1].claim_count, 2);
  assert.equal(groups[1].releasable_count, 1);
  assert.equal(groups[2].title, "Orphan");
  assert.equal(groups[2].video_url, "https://www.youtube.com/watch?v=ZZZZZZZZZZZ");
  const withoutEmpty = groupClaimsByVideo(rows, videos, { includeEmpty: false });
  assert.deepEqual(withoutEmpty.map((group) => group.video_id), [ID, "ZZZZZZZZZZZ"]);
  const fromClaims = groupClaimsByVideo(rows, []);
  assert.deepEqual(fromClaims.map((group) => group.video_id), [ID, "ZZZZZZZZZZZ"]);
  assert.equal(fromClaims[0].thumbnail, "https://i.ytimg.com/x.jpg");
});

test("paginateGroups never splits a group and counts empty groups as one row", () => {
  const groups = [
    { video_id: "a", claims: [] },
    { video_id: "b", claims: Array(3).fill({}) },
    { video_id: "c", claims: Array(3).fill({}) },
    { video_id: "d", claims: Array(10).fill({}) },
    { video_id: "e", claims: [{}] }
  ];
  const pages = paginateGroups(groups, 5);
  assert.deepEqual(
    pages.map((page) => page.map((group) => group.video_id)),
    [["a", "b"], ["c"], ["d"], ["e"]]
  );
  assert.deepEqual(paginateGroups([], 5), [[]]);
});

test("selectReleasableKeys honours the release limit", () => {
  const rows = [claim({ claim_id: "C1" }), claim({ claim_id: "C2", can_release: false }), claim({ claim_id: "C3" }), claim({ claim_id: "C4", status: "release_unknown" }), claim({ claim_id: "C5" })];
  assert.deepEqual(selectReleasableKeys(rows), { keys: ["2:C1", "2:C3", "2:C5"], truncated: false });
  assert.deepEqual(selectReleasableKeys(rows, 2), { keys: ["2:C1", "2:C3"], truncated: true });
});

test("reconcileNetworkIds preselects everything until the user chooses", () => {
  assert.deepEqual(reconcileNetworkIds(null, [1, 2]), [1, 2]);
  assert.deepEqual(reconcileNetworkIds(undefined, ["3"]), [3]);
  assert.deepEqual(reconcileNetworkIds([2, 9], [1, 2, 3]), [2]);
  assert.deepEqual(reconcileNetworkIds([], [1, 2]), []);
  assert.deepEqual(reconcileNetworkIds(["1"], [1, 2]), [1]);
});

// ---------------------------------------------------------------------------
// Release flow
// ---------------------------------------------------------------------------

test("buildReleaseItems sends the ids and the audit metadata the backend expects", () => {
  const bare = claim({ claim_id: "C2", asset_id: "", asset: { id: "A9" }, video_id: "", video_title: "", video: null });
  assert.deepEqual(buildReleaseItems([claim(), bare]), [
    { network_id: 2, claim_id: "C1", video_id: ID, asset_id: "A1", video_title: "Song title", channel_title: "Channel", asset_title: "Asset title", isrc: "VNA122400001" },
    { network_id: 2, claim_id: "C2", video_id: null, asset_id: "A9", video_title: "", channel_title: "", asset_title: "", isrc: "" }
  ]);
  // The title falls back to the video block when the row has no flat video_title; ids are normalised.
  const fallback = buildReleaseItems([claim({ network_id: "2", claim_id: 77, video_title: "", video: { title: "From the video block", channel_title: "Ch" } })])[0];
  assert.equal(fallback.network_id, 2);
  assert.equal(fallback.claim_id, "77");
  assert.equal(fallback.video_title, "From the video block");
  assert.equal(fallback.channel_title, "Ch");
  assert.deepEqual(buildReleaseItems([]), []);
});

test("mergeServerClaim keeps what the row knows and follows the server for the status fields", () => {
  const row = claim({ third_party: true, can_release: false, release_block_reason: "Asset is not in your allowed labels", policy: { id: "P1" } });
  // What /release and /recheck build from the claims resource: no video block, no views, no third-party flag.
  const fresh = {
    network_id: 2,
    claim_id: "C1",
    status: "inactive",
    can_release: false,
    video: null,
    video_title: "",
    video_views: null,
    engaged_views: null,
    third_party: false,
    release_block_reason: "",
    asset: null,
    policy: null,
    time_status_last_modified: null
  };
  const merged = mergeServerClaim(row, fresh);
  assert.equal(merged.key, "2:C1");
  assert.equal(merged.status, "inactive");
  assert.equal(merged.release_block_reason, "", "an empty fresh block reason is authoritative");
  assert.equal(merged.can_release, false);
  assert.equal(merged.video_title, "Song title");
  assert.equal(merged.video.thumbnail, "https://i.ytimg.com/x.jpg");
  assert.equal(merged.video.channel_title, "Channel");
  assert.equal(merged.video_views, 1234);
  assert.equal(merged.third_party, true);
  assert.deepEqual(merged.asset, row.asset);
  assert.deepEqual(merged.policy, { id: "P1" });
  assert.equal(merged.time_status_last_modified, "2026-01-02T00:00:00Z");
  assert.equal(mergeServerClaim(row, null), row, "no fresh claim → the row itself");
  assert.equal(mergeServerClaim(row, undefined), row);
  // Everything else follows the server when it has a value; the key never changes.
  const detailed = mergeServerClaim(claim({ video: null, video_title: "" }), {
    key: "9:zzz",
    status: "active",
    can_release: true,
    video_title: "Now known",
    match_info: { reference_id: "R1" },
    time_status_last_modified: "2026-03-01T00:00:00Z"
  });
  assert.equal(detailed.key, "2:C1");
  assert.equal(detailed.video_title, "Now known");
  assert.deepEqual(detailed.match_info, { reference_id: "R1" });
  assert.equal(detailed.time_status_last_modified, "2026-03-01T00:00:00Z");
  // applyReleaseResults / applyRecheckResults go through the same merge, so the table keeps its previews.
  const [released] = applyReleaseResults([row], [{ key: "2:C1", outcome: "released", status: "inactive", claim: fresh }]);
  assert.equal(released.status, "inactive");
  assert.equal(released.video.thumbnail, "https://i.ytimg.com/x.jpg");
  assert.equal(released.video_views, 1234);
  const [rechecked] = applyRecheckResults(
    [claim({ status: "release_unknown", can_release: false })],
    [{ key: "2:C1", found: true, status: "active", claim: { ...fresh, status: "active", can_release: true } }]
  );
  assert.equal(rechecked.status, "active");
  assert.equal(rechecked.can_release, true);
  assert.equal(rechecked.video_title, "Song title");
  assert.equal(rechecked.video.channel_title, "Channel");
});

test("summarizeRelease counts outcomes and treats unknown outcomes as unknown", () => {
  const results = [
    { outcome: "released" },
    { outcome: "released" },
    { outcome: "already_inactive" },
    { outcome: "failed" },
    { outcome: "unknown" },
    { outcome: "skipped" },
    { outcome: "something-new" },
    null
  ];
  assert.deepEqual(summarizeRelease(results), { total: 7, released: 2, already_inactive: 1, reinstated: 0, confirmed: 0, already_active: 0, failed: 1, unknown: 2, skipped: 1 });
  assert.deepEqual(summarizeRelease([]), { total: 0, released: 0, already_inactive: 0, reinstated: 0, confirmed: 0, already_active: 0, failed: 0, unknown: 0, skipped: 0 });
});

test("a client timeout becomes an unknown outcome for the whole batch, never a failure", () => {
  const batch = [claim({ claim_id: "C1" }), claim({ claim_id: "C2" })];
  const timeout = { code: "ECONNABORTED", message: "timeout of 300000ms exceeded" };
  assert.equal(isUnknownOutcomeError(timeout), true);
  assert.equal(isUnknownOutcomeError({ response: { status: 504 } }), true);
  assert.equal(isUnknownOutcomeError({ code: "ERR_CANCELED" }), true);
  assert.equal(isUnknownOutcomeError({ response: { status: 429 } }), false);
  assert.equal(isUnknownOutcomeError({ request: {}, response: { status: 502 } }), false);
  assert.equal(isUnknownOutcomeError(null), false);
  const outcomes = outcomesForBatch(batch, "unknown", "timed out");
  assert.deepEqual(
    outcomes.map((item) => [item.key, item.outcome, item.retryable]),
    [
      ["2:C1", "unknown", false],
      ["2:C2", "unknown", false]
    ]
  );
  assert.equal(summarizeRelease(outcomes).failed, 0);
  assert.equal(summarizeRelease(outcomes).unknown, 2);
  const failed = outcomesForBatch(batch, "failed", "quota", { retryable: true, retry_after: 30 });
  assert.equal(failed[0].retryable, true);
  assert.equal(failed[0].retry_after, 30);
  assert.equal(outcomesForBatch(batch, "nonsense")[0].outcome, "unknown");
});

test("a dropped connection is an unknown outcome too, never a failure", () => {
  // axios: ERR_NETWORK, or a request object without any response (server restarted mid-batch).
  const dropped = { code: "ERR_NETWORK", message: "Network Error", request: {} };
  const silent = { request: {}, message: "socket hang up" };
  assert.equal(isNetworkError(dropped), true);
  assert.equal(isNetworkError(silent), true);
  assert.equal(isUnknownOutcomeError(dropped), true);
  assert.equal(isUnknownOutcomeError(silent), true);
  assert.match(unknownOutcomeMessage(dropped), /connection dropped before Google's answer arrived/);
  assert.match(unknownOutcomeMessage(silent), /re-check the claim status/);
  assert.match(unknownOutcomeMessage({ code: "ECONNABORTED", request: {} }), /timed out before Google answered/);
  assert.match(unknownOutcomeMessage({ code: "ETIMEDOUT", request: {} }), /timed out before Google answered/);
  assert.equal(
    unknownOutcomeMessage({ code: "ERR_CANCELED", request: {} }),
    "Cancelled while waiting for Google. The claims already sent may still be released on the server: wait about a minute, then re-check them."
  );
  assert.match(unknownOutcomeMessage({ response: { status: 504 } }), /^Google did not answer in time/);
  // Answered requests, cancels, timeouts and config errors are not network errors.
  assert.equal(isNetworkError({ request: {}, response: { status: 502 } }), false);
  assert.equal(isNetworkError({ code: "ERR_CANCELED", request: {} }), false);
  assert.equal(isNetworkError({ code: "ECONNABORTED", request: {} }), false);
  assert.equal(isNetworkError({ code: "ERR_BAD_OPTION_VALUE", message: "bad config" }), false);
  assert.equal(isNetworkError(null), false);
  // Both axios timeout codes count as a client timeout.
  assert.equal(isClientTimeout({ code: "ECONNABORTED" }), true);
  assert.equal(isClientTimeout({ code: "ETIMEDOUT" }), true);
  assert.equal(isUnknownOutcomeError({ code: "ETIMEDOUT" }), true);
  assert.equal(baseErrorMessage(dropped), "Network error: no response from the server");
  assert.equal(requestMessage(dropped), "Network error: no response from the server");
  assert.equal(summarizeRelease(outcomesForBatch([claim()], "unknown", unknownOutcomeMessage(dropped))).unknown, 1);
});

test("reconcileBatchResults fills missing claims with unknown and normalises outcomes", () => {
  const batch = [claim({ claim_id: "C1" }), claim({ claim_id: "C2" }), claim({ claim_id: "C3" })];
  const results = reconcileBatchResults(batch, [
    { network_id: 2, claim_id: "C1", outcome: "released", status: "inactive" },
    { key: "2:C3", network_id: 2, claim_id: "C3", outcome: "weird" }
  ]);
  assert.deepEqual(
    results.map((item) => [item.key, item.outcome]),
    [
      ["2:C1", "released"],
      ["2:C2", "unknown"],
      ["2:C3", "unknown"]
    ]
  );
  assert.match(results[1].message, /no result/);
  const merged = mergeResultsByKey(results, [{ key: "2:C2", outcome: "released" }]);
  assert.deepEqual(
    merged.map((item) => [item.key, item.outcome]),
    [
      ["2:C1", "released"],
      ["2:C2", "released"],
      ["2:C3", "unknown"]
    ]
  );
});

test("a budget_exhausted failure passes through as retryable and keeps the row releasable", () => {
  const batch = [claim({ claim_id: "C1" }), claim({ claim_id: "C2" })];
  const results = reconcileBatchResults(batch, [
    { key: "2:C1", network_id: 2, claim_id: "C1", outcome: "released", status: "inactive", retryable: false },
    {
      key: "2:C2",
      network_id: 2,
      claim_id: "C2",
      outcome: "failed",
      status: "active",
      reason: "budget_exhausted",
      retryable: true,
      retry_after: null,
      message: "The server ran out of time before this claim was sent; nothing was sent.",
      claim: null
    }
  ]);
  assert.equal(results[1].outcome, "failed");
  assert.equal(results[1].reason, "budget_exhausted");
  assert.equal(results[1].retryable, true);
  assert.match(results[1].message, /nothing was sent/);
  const updated = applyReleaseResults(batch, results);
  assert.equal(updated[1].status, "active");
  assert.equal(updated[1].can_release, true, "nothing was sent, so the claim can be retried");
  assert.equal(updated[1].release_result.outcome, "failed");
  assert.equal(summarizeRelease(results).failed, 1);
});

test("applyReleaseResults updates rows in place per outcome", () => {
  const rows = [claim({ claim_id: "C1" }), claim({ claim_id: "C2" }), claim({ claim_id: "C3" }), claim({ claim_id: "C4" }), claim({ claim_id: "C5" }), claim({ claim_id: "C6" })];
  const updated = applyReleaseResults(rows, [
    { key: "2:C1", outcome: "released", status: "inactive", message: "ok", claim: claim({ claim_id: "C1", status: "inactive", can_release: false, release_block_reason: "Claims in inactive status cannot be released" }) },
    { key: "2:C2", outcome: "already_inactive", status: "inactive", claim: null },
    { key: "2:C3", outcome: "unknown", message: "timeout" },
    { key: "2:C4", outcome: "failed", message: "invalidStatusTransition", retryable: false },
    { key: "2:C5", outcome: "skipped", message: "Asset is not in your allowed labels" }
  ]);
  assert.equal(updated[0].status, "inactive");
  assert.equal(updated[0].can_release, false);
  assert.equal(updated[0].release_result.outcome, "released");
  assert.equal(updated[1].status, "inactive");
  assert.equal(updated[1].can_release, false);
  assert.match(updated[1].release_block_reason, /inactive status/);
  assert.equal(updated[2].status, "release_unknown");
  assert.equal(updated[2].can_release, false);
  assert.equal(updated[3].status, "active", "failed rows keep their status");
  assert.equal(updated[3].can_release, true);
  assert.equal(updated[3].release_result.message, "invalidStatusTransition");
  assert.equal(updated[4].can_release, false);
  assert.equal(updated[4].release_block_reason, "Asset is not in your allowed labels");
  assert.equal(updated[5], rows[5], "untouched rows keep their identity");
  assert.equal(applyReleaseResults(rows, []), rows);
});

test("applyRecheckResults restores the Google status of unknown rows", () => {
  const rows = [
    claim({ claim_id: "C1", status: "release_unknown", can_release: false }),
    claim({ claim_id: "C2", status: "release_unknown", can_release: false }),
    claim({ claim_id: "C3", status: "release_unknown", can_release: false })
  ];
  const updated = applyRecheckResults(rows, [
    { key: "2:C1", found: true, status: "inactive", claim: null },
    { key: "2:C2", found: true, status: "active", claim: null },
    { key: "2:C3", found: false, status: null, claim: null }
  ]);
  assert.equal(updated[0].status, "inactive");
  assert.equal(updated[0].can_release, false);
  assert.equal(updated[1].status, "active");
  assert.equal(updated[1].can_release, true);
  assert.equal(updated[1].release_block_reason, "");
  assert.equal(updated[2].status, "release_unknown");
  const withRow = applyRecheckResults(rows, [{ key: "2:C1", found: true, status: "inactive", claim: claim({ claim_id: "C1", status: "inactive", can_release: false, release_block_reason: "x" }) }]);
  assert.equal(withRow[0].release_block_reason, "x");
});

test("recheckToOutcome maps Google's answer onto release outcomes", () => {
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C1", found: true, status: "inactive" }).outcome, "released");
  const active = recheckToOutcome({ key: "2:C2", network_id: 2, claim_id: "C2", found: true, status: "active" });
  assert.equal(active.outcome, "failed");
  assert.equal(active.retryable, true);
  const takedown = recheckToOutcome({ network_id: 2, claim_id: "C3", found: true, status: "takedown" });
  assert.equal(takedown.outcome, "failed");
  assert.equal(takedown.retryable, false);
  assert.equal(takedown.status, "takedown");
  assert.match(takedown.message, /now takedown and cannot be released/);
  // Not found (or the CMS could not be read): the outcome stays unknown and the server's message is kept.
  const missing = recheckToOutcome({ network_id: 2, claim_id: "C4", found: false, status: null, claim: null });
  assert.equal(missing.outcome, "unknown");
  assert.equal(missing.retryable, false);
  assert.equal(missing.key, "2:C4");
  assert.equal(missing.status, null);
  assert.match(missing.message, /could not find this claim/);
  const disconnected = recheckToOutcome({ key: "2:C5", network_id: 2, claim_id: "C5", found: false, message: "CMS token rejected by Google: re-authorize this CMS" });
  assert.equal(disconnected.outcome, "unknown");
  assert.equal(disconnected.retryable, false);
  assert.equal(disconnected.message, "CMS token rejected by Google: re-authorize this CMS");
  // The fresh claim's status is used when the result carries none, whatever its case.
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C6", found: true, claim: { status: "INACTIVE" } }).outcome, "released");
});

test("a re-check while the server is still releasing the claim stays unknown and leaves the row alone", () => {
  const serverMessage = "A release of this claim is still running on the server; its outcome will be recorded by that request. Re-check it in a minute.";
  const inFlight = {
    key: "2:C1",
    network_id: 2,
    claim_id: "C1",
    found: true,
    status: "active",
    in_flight: true,
    message: serverMessage,
    claim: { network_id: 2, claim_id: "C1", status: "active", can_release: true, release_block_reason: "" }
  };
  const outcome = recheckToOutcome(inFlight);
  assert.equal(outcome.outcome, "unknown");
  assert.equal(outcome.retryable, false, "nothing to retry while the server is still releasing it");
  assert.equal(outcome.status, "active", "the status read back is still reported");
  assert.equal(outcome.message, serverMessage);
  assert.equal(outcome.key, "2:C1");
  assert.match(recheckToOutcome({ ...inFlight, message: "" }).message, /still running on the server; re-check it in a minute/);
  // in_flight wins over every other branch; a result without the flag behaves as before.
  assert.equal(recheckToOutcome({ ...inFlight, status: "inactive" }).outcome, "unknown");
  assert.equal(recheckToOutcome({ ...inFlight, found: false, status: null, claim: null }).outcome, "unknown");
  assert.equal(recheckToOutcome({ ...inFlight, in_flight: false }).outcome, "failed");
  assert.equal(recheckToOutcome({ ...inFlight, in_flight: undefined }).retryable, true);
  // The table row keeps its "Check status" state and its release_result (identity included) …
  const row = claim({
    status: "release_unknown",
    can_release: false,
    release_block_reason: "Release outcome unknown: re-check the claim status first",
    release_result: { outcome: "unknown", message: "Cancelled while waiting for Google." }
  });
  const [unchanged] = applyRecheckResults([row], [inFlight]);
  assert.equal(unchanged, row);
  // … while the other results of the same re-check still apply.
  const rows = [row, claim({ claim_id: "C2", status: "release_unknown", can_release: false })];
  const mixed = applyRecheckResults(rows, [inFlight, { key: "2:C2", found: true, status: "inactive", claim: null }]);
  assert.equal(mixed[0], row);
  assert.equal(mixed[1].status, "inactive");
  assert.equal(mixed[1].release_result, null);
  // Without the flag the same answer resets the row to Active + releasable, as before.
  const [reset] = applyRecheckResults([row], [{ ...inFlight, in_flight: false }]);
  assert.equal(reset.status, "active");
  assert.equal(reset.can_release, true);
});

// ---------------------------------------------------------------------------
// Reinstate flow (a released claim set back to active)
// ---------------------------------------------------------------------------

/** A row the operator released: inactive, not releasable, allowed to be reinstated. */
function releasedClaim(overrides = {}) {
  return claim({
    status: "inactive",
    can_release: false,
    release_block_reason: "Claims in inactive status cannot be released",
    can_reinstate: true,
    reinstate_block_reason: "",
    ...overrides
  });
}

test("isReinstatable / reinstateBlockReason: only inactive claims the server allows", () => {
  const released = releasedClaim();
  assert.equal(isReinstatable(released), true);
  assert.equal(reinstateBlockReason(released), "");
  assert.equal(isReinstatable(claim()), false, "an active claim is not reinstatable");
  assert.equal(reinstateBlockReason(claim()), REINSTATE_BLOCK_DEFAULT);
  assert.equal(reinstateBlockReason(claim()), "Only inactive (released) claims can be reinstated");
  const limited = releasedClaim({ can_reinstate: false, reinstate_block_reason: "Asset is not in your allowed labels" });
  assert.equal(isReinstatable(limited), false);
  assert.equal(reinstateBlockReason(limited), "Asset is not in your allowed labels");
  assert.equal(isReinstatable(releasedClaim({ status: "INACTIVE" })), true, "status case does not matter");
  assert.equal(isReinstatable(claim({ status: "active", can_reinstate: true })), false, "can_reinstate alone is not enough");
  assert.equal(isReinstatable(claim({ status: "inactive", can_release: false })), false, "rows without the flag (older server) are not reinstatable");
  assert.equal(isReinstatable(null), false);
  assert.equal(isReinstatable(undefined), false);
  assert.equal(reinstateBlockReason(null), "");
  assert.match(reinstateBlockReason(claim({ status: "release_unknown", can_release: false, can_reinstate: false })), /re-check/);
  // A reinstatable row is never releasable and vice versa.
  assert.equal(isReleasable(released), false);
  assert.equal(isReinstatable(claim()), false);
  assert.equal(rowResultAction(claim({ release_result: { outcome: "unknown", action: "reinstate" } })), "reinstate");
  assert.equal(rowResultAction(claim({ release_result: { outcome: "unknown", action: "release" } })), "release");
  assert.equal(rowResultAction(claim({ release_result: { outcome: "unknown" } })), "release", "rows from before the action tag are releases");
  assert.equal(rowResultAction(claim()), "release");
  assert.equal(rowResultAction(null), "release");
});

test("applyReinstateResults updates rows in place per outcome", () => {
  const rows = ["C1", "C2", "C3", "C4", "C5", "C6"].map((claim_id) => releasedClaim({ claim_id }));
  const fresh = {
    network_id: 2,
    claim_id: "C1",
    status: "active",
    can_release: true,
    release_block_reason: "",
    can_reinstate: false,
    reinstate_block_reason: "Only inactive (released) claims can be reinstated",
    video: null,
    video_title: "",
    video_views: null,
    time_status_last_modified: "2026-10-16T00:00:00Z"
  };
  const updated = applyReinstateResults(rows, [
    { key: "2:C1", outcome: "reinstated", status: "active", message: "Google confirmed the claim is active again.", claim: fresh },
    { key: "2:C2", outcome: "already_active", status: "active", claim: null },
    { key: "2:C3", outcome: "unknown", message: "timeout" },
    { key: "2:C4", outcome: "failed", message: "invalidStatusTransition", retryable: false },
    { key: "2:C5", outcome: "skipped", message: "Asset is not in your allowed labels" }
  ]);
  // reinstated: active and releasable again, not reinstatable; the row keeps its preview; the result is tagged as a reinstate.
  assert.equal(updated[0].status, "active");
  assert.equal(updated[0].can_release, true);
  assert.equal(updated[0].release_block_reason, "");
  assert.equal(updated[0].can_reinstate, false);
  assert.equal(isReleasable(updated[0]), true);
  assert.equal(isReinstatable(updated[0]), false);
  assert.equal(updated[0].video.thumbnail, "https://i.ytimg.com/x.jpg");
  assert.equal(updated[0].video_views, 1234);
  assert.equal(updated[0].time_status_last_modified, "2026-10-16T00:00:00Z");
  assert.deepEqual(updated[0].release_result, { outcome: "reinstated", message: "Google confirmed the claim is active again.", action: "reinstate" });
  // already_active without a refreshed claim: active, releasable (the operator may touch it), not reinstatable.
  assert.equal(updated[1].status, "active");
  assert.equal(updated[1].can_release, true);
  assert.equal(updated[1].release_block_reason, "");
  assert.equal(updated[1].can_reinstate, false);
  assert.equal(updated[1].reinstate_block_reason, REINSTATE_BLOCK_DEFAULT);
  assert.equal(updated[1].release_result.outcome, "already_active");
  assert.equal(updated[1].release_result.action, "reinstate");
  // unknown: "Check status", neither button, the block reason names the reinstate.
  assert.equal(updated[2].status, "release_unknown");
  assert.equal(updated[2].can_release, false);
  assert.equal(updated[2].can_reinstate, false);
  assert.equal(updated[2].release_block_reason, "Reinstate outcome unknown: re-check the claim status first");
  assert.equal(reinstateBlockReason(updated[2]), "Reinstate outcome unknown: re-check the claim status first");
  assert.deepEqual(updated[2].release_result, { outcome: "unknown", message: "timeout", action: "reinstate" });
  // failed: the row is unchanged apart from the result (still inactive and reinstatable, so Reinstate can be clicked again).
  assert.equal(updated[3].status, "inactive");
  assert.equal(updated[3].can_reinstate, true);
  assert.equal(isReinstatable(updated[3]), true);
  assert.equal(updated[3].release_result.outcome, "failed");
  assert.equal(updated[3].release_result.message, "invalidStatusTransition");
  assert.equal(updated[3].release_result.action, "reinstate");
  // skipped without a refreshed claim: the button is withdrawn with the server's reason.
  assert.equal(updated[4].status, "inactive");
  assert.equal(updated[4].can_reinstate, false);
  assert.equal(reinstateBlockReason(updated[4]), "Asset is not in your allowed labels");
  assert.equal(updated[4].release_result.outcome, "skipped");
  assert.equal(updated[5], rows[5], "untouched rows keep their identity");
  assert.equal(applyReinstateResults(rows, []), rows);
  assert.equal(applyReinstateResults(rows, null), rows);
  // A skipped result with a refreshed claim (the status changed meanwhile) follows the server's row.
  const [moved] = applyReinstateResults(
    [releasedClaim({ claim_id: "C7" })],
    [
      {
        key: "2:C7",
        outcome: "skipped",
        message: "The claim is not inactive (now takedown).",
        claim: { status: "takedown", can_release: false, release_block_reason: "Claims in takedown status cannot be released", can_reinstate: false, reinstate_block_reason: "Only inactive (released) claims can be reinstated" }
      }
    ]
  );
  assert.equal(moved.status, "takedown");
  assert.equal(moved.can_reinstate, false);
  assert.equal(moved.can_release, false);
  assert.equal(moved.release_result.outcome, "skipped");
  // A refreshed claim that denies releasing the reinstated claim wins over the inference.
  const [denied] = applyReinstateResults(
    [releasedClaim({ claim_id: "C8" })],
    [{ key: "2:C8", outcome: "reinstated", status: "active", claim: { status: "active", can_release: false, release_block_reason: "Asset is not in your allowed labels", can_reinstate: false, reinstate_block_reason: "x" } }]
  );
  assert.equal(denied.status, "active");
  assert.equal(denied.can_release, false);
  assert.equal(denied.release_block_reason, "Asset is not in your allowed labels");
  // Results without a key are matched by their ids, like the release flow.
  const [byIds] = applyReinstateResults([releasedClaim({ claim_id: "C9" })], [{ network_id: 2, claim_id: "C9", outcome: "reinstated", status: "active", claim: null }]);
  assert.equal(byIds.status, "active");
  assert.equal(byIds.release_result.outcome, "reinstated");
});

test("a released row becomes reinstatable (server flag first, inference otherwise)", () => {
  const rows = ["C1", "C2", "C3", "C4"].map((claim_id) => claim({ claim_id }));
  const updated = applyReleaseResults(rows, [
    { key: "2:C1", outcome: "released", status: "inactive", claim: { status: "inactive", can_release: false, release_block_reason: "Claims in inactive status cannot be released", can_reinstate: true, reinstate_block_reason: "" } },
    { key: "2:C2", outcome: "released", status: "inactive", claim: { status: "inactive", can_release: false, can_reinstate: false, reinstate_block_reason: "Asset is not in your allowed labels" } },
    { key: "2:C3", outcome: "already_inactive", status: "inactive", claim: null },
    { key: "2:C4", outcome: "unknown", message: "timeout" }
  ]);
  assert.equal(isReinstatable(updated[0]), true);
  assert.equal(updated[0].reinstate_block_reason, "");
  assert.equal(updated[0].release_result.action, "release");
  assert.equal(isReinstatable(updated[1]), false);
  assert.equal(reinstateBlockReason(updated[1]), "Asset is not in your allowed labels");
  assert.equal(isReinstatable(updated[2]), true, "no refreshed claim: the operator could release it, so they may reinstate it");
  assert.equal(updated[2].reinstate_block_reason, "");
  assert.equal(isReinstatable(updated[3]), false);
  assert.equal(updated[3].can_reinstate, false);
  assert.match(reinstateBlockReason(updated[3]), /re-check/);
  // The server's empty reinstate_block_reason is authoritative in a merge, like release_block_reason.
  const merged = mergeServerClaim(claim({ can_reinstate: false, reinstate_block_reason: "stale reason" }), { status: "inactive", can_reinstate: true, reinstate_block_reason: "" });
  assert.equal(merged.can_reinstate, true);
  assert.equal(merged.reinstate_block_reason, "");
  assert.equal(mergeServerClaim(claim({ reinstate_block_reason: "kept" }), { status: "inactive" }).reinstate_block_reason, "kept", "absent fields leave the row alone");
});

test("recheckToOutcome follows a reinstate: active confirms it, inactive means it did not go through", () => {
  const options = { action: "reinstate" };
  const confirmed = recheckToOutcome({ network_id: 2, claim_id: "C1", found: true, status: "active" }, options);
  assert.equal(confirmed.outcome, "reinstated");
  assert.equal(confirmed.retryable, false);
  assert.equal(confirmed.message, "Confirmed active by Google.");
  assert.equal(confirmed.key, "2:C1");
  assert.equal(confirmed.status, "active");
  const recorded = recheckToOutcome({ network_id: 2, claim_id: "C1", found: true, status: "active", message: "Confirmed active; the earlier reinstate was recorded." }, options);
  assert.equal(recorded.outcome, "reinstated");
  assert.equal(recorded.message, "Confirmed active; the earlier reinstate was recorded.");
  const still = recheckToOutcome({ network_id: 2, claim_id: "C2", found: true, status: "inactive" }, options);
  assert.equal(still.outcome, "failed");
  assert.equal(still.retryable, true);
  assert.equal(still.message, "Claim is still inactive: the reinstate did not go through. Retry it.");
  const takedown = recheckToOutcome({ network_id: 2, claim_id: "C3", found: true, status: "takedown" }, options);
  assert.equal(takedown.outcome, "failed");
  assert.equal(takedown.retryable, false);
  assert.equal(takedown.message, "Claim is now takedown and cannot be reinstated.");
  // pending / potential are "other" statuses after a reinstate (Google did not land on active).
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C3", found: true, status: "pending" }, options).retryable, false);
  // The fresh claim's status is used when the result carries none, whatever its case.
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C3", found: true, claim: { status: "ACTIVE" } }, options).outcome, "reinstated");
  // in_flight and not-found stay unknown whatever the action; the in-flight message names the reinstate.
  const inFlight = recheckToOutcome({ network_id: 2, claim_id: "C4", found: true, status: "inactive", in_flight: true }, options);
  assert.equal(inFlight.outcome, "unknown");
  assert.equal(inFlight.retryable, false);
  assert.equal(inFlight.message, "A reinstate of this claim is still running on the server; re-check it in a minute.");
  const missing = recheckToOutcome({ network_id: 2, claim_id: "C5", found: false }, options);
  assert.equal(missing.outcome, "unknown");
  assert.match(missing.message, /could not find this claim/);
  // The release mapping is unchanged, with or without the options argument.
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C6", found: true, status: "inactive" }, { action: "release" }).outcome, "released");
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C6", found: true, status: "active" }).outcome, "failed");
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C6", found: true, status: "active" }, {}).retryable, true);
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C6", found: true, status: "active", in_flight: true }).message, "A release of this claim is still running on the server; re-check it in a minute.");
  // Array.prototype.map's index must never be read as the options.
  assert.equal([{ network_id: 2, claim_id: "C7", found: true, status: "inactive" }].map((item) => recheckToOutcome(item))[0].outcome, "released");
});

test("applyRecheckResults leaves a reinstate row consistent with the status Google reads back", () => {
  const reason = "Reinstate outcome unknown: re-check the claim status first";
  const pending = claim({
    claim_id: "C1",
    status: "release_unknown",
    can_release: false,
    release_block_reason: reason,
    can_reinstate: false,
    reinstate_block_reason: reason,
    release_result: { outcome: "unknown", message: "timeout", action: "reinstate" }
  });
  // Active (the reinstate went through): releasable, not reinstatable, result cleared.
  const [active] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "active", claim: null }]);
  assert.equal(active.status, "active");
  assert.equal(active.can_release, true);
  assert.equal(active.release_block_reason, "");
  assert.equal(active.can_reinstate, false);
  assert.equal(active.reinstate_block_reason, REINSTATE_BLOCK_DEFAULT);
  assert.equal(active.release_result, null);
  // Inactive (it did not go through): reinstatable again, not releasable.
  const [inactive] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "inactive", claim: null }]);
  assert.equal(inactive.status, "inactive");
  assert.equal(inactive.can_release, false);
  assert.equal(inactive.can_reinstate, true);
  assert.equal(inactive.reinstate_block_reason, "");
  assert.equal(inactive.release_result, null);
  assert.equal(isReinstatable(inactive), true);
  // Another status: neither action.
  const [takedown] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "takedown", claim: null }]);
  assert.equal(takedown.can_release, false);
  assert.equal(takedown.can_reinstate, false);
  // With a refreshed claim the server's flags win; without the reinstate fields the status rule applies.
  const [flagged] = applyRecheckResults(
    [pending],
    [{ key: "2:C1", found: true, status: "inactive", claim: { status: "inactive", can_release: false, release_block_reason: "x", can_reinstate: false, reinstate_block_reason: "Asset is not in your allowed labels" } }]
  );
  assert.equal(flagged.can_reinstate, false);
  assert.equal(flagged.reinstate_block_reason, "Asset is not in your allowed labels");
  assert.equal(flagged.release_result, null);
  const [legacy] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "inactive", claim: { status: "inactive", can_release: false, release_block_reason: "x" } }]);
  assert.equal(legacy.can_reinstate, true);
  assert.equal(legacy.reinstate_block_reason, "");
  const [legacyActive] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "active", claim: { status: "active", can_release: true, release_block_reason: "" } }]);
  assert.equal(legacyActive.can_reinstate, false);
  // The row of an in-flight reinstate is left alone, identity included.
  const [untouched] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "inactive", in_flight: true }]);
  assert.equal(untouched, pending);
});

test("releaseSummaryText and summarizeRelease cover the reinstate outcomes", () => {
  const summary = summarizeRelease([{ outcome: "reinstated" }, { outcome: "reinstated" }, { outcome: "already_active" }, { outcome: "failed" }, { outcome: "unknown" }]);
  assert.deepEqual(summary, { total: 5, released: 0, already_inactive: 0, reinstated: 2, confirmed: 0, already_active: 1, failed: 1, unknown: 1, skipped: 0 });
  assert.equal(releaseSummaryText(summary), "2 reinstated · 1 already active · 1 failed · 1 to re-check");
  assert.equal(releaseSummaryText({ released: 3, already_inactive: 1, failed: 0, unknown: 0, skipped: 2 }), "3 released · 1 already inactive · 2 skipped");
  assert.equal(releaseSummaryText({ released: 1, reinstated: 1 }), "1 released · 1 reinstated");
  assert.equal(releaseSummaryText({}), "No claim was processed");
  // normalizeOutcome / outcomeLabel and the shared constants know the new outcomes.
  assert.equal(normalizeOutcome("reinstated"), "reinstated");
  assert.equal(normalizeOutcome("already_active"), "already_active");
  assert.equal(normalizeOutcome("nonsense"), "unknown");
  assert.equal(outcomeLabel("reinstated"), "Reinstated");
  assert.equal(outcomeLabel("already_active"), "Already active");
  assert.deepEqual(RELEASE_OUTCOMES, ["released", "already_inactive", "reinstated", "confirmed", "already_active", "failed", "unknown", "skipped"]);
  RELEASE_OUTCOMES.forEach((outcome) => {
    assert.ok(RELEASE_OUTCOME_META[outcome]?.label, `label for ${outcome}`);
    assert.ok(RELEASE_OUTCOME_META[outcome]?.tone, `tone for ${outcome}`);
    assert.ok(RELEASE_OUTCOME_META[outcome]?.description, `description for ${outcome}`);
  });
  assert.equal(HISTORY_ACTION_LABELS.reinstate, "Reinstate");
  assert.equal(HISTORY_ACTION_LABELS.release, "Release");
});

test("unknownOutcomeMessage names the reinstate when asked and keeps the release wording otherwise", () => {
  const options = { action: "reinstate" };
  assert.equal(unknownOutcomeMessage({ code: "ECONNABORTED" }, options), "The request timed out before Google answered. The reinstate may still have been applied; re-check the claim status.");
  assert.equal(unknownOutcomeMessage({ code: "ERR_NETWORK", request: {} }, options), "The connection dropped before Google's answer arrived. The reinstate may still have been applied; re-check the claim status.");
  assert.equal(
    unknownOutcomeMessage({ code: "ERR_CANCELED" }, options),
    "Cancelled while waiting for Google. The claims already sent may still be reinstated on the server: wait about a minute, then re-check them."
  );
  assert.equal(unknownOutcomeMessage({ response: { status: 504 } }, options), "Google did not answer in time. The reinstate may still have been applied; re-check the claim status.");
  assert.doesNotMatch(unknownOutcomeMessage({ code: "ECONNABORTED" }, options), /release/);
  assert.equal(unknownOutcomeMessage({ code: "ECONNABORTED" }), "The request timed out before Google answered. The release may still have been applied; re-check the claim status.");
  assert.equal(unknownOutcomeMessage({ code: "ECONNABORTED" }, {}), "The request timed out before Google answered. The release may still have been applied; re-check the claim status.");
  assert.equal(unknownOutcomeMessage({ response: { status: 504 } }), "Google did not answer in time. The release may still have been applied; re-check the claim status.");
});

test("claimFromHistoryEvent builds a reinstatable row that buildReleaseItems understands", () => {
  const event = {
    id: 7,
    action: "release",
    result: "released",
    network_id: 2,
    network_name: "BPM Digital",
    content_owner_id: "ABC123",
    claim_id: "C9",
    video_id: ID,
    video_title: "Song title",
    channel_title: "Channel",
    asset_id: "A1",
    asset_title: "Asset title",
    isrc: "VNA122400001"
  };
  const row = claimFromHistoryEvent(event);
  assert.equal(row.key, "2:C9");
  assert.equal(claimKey(row), "2:C9");
  assert.equal(row.status, "inactive");
  assert.equal(isReinstatable(row), true);
  assert.equal(isReleasable(row), false);
  // The log knows the claim as inactive: it is reinstated, never confirmed.
  assert.equal(row.can_confirm, false);
  assert.equal(row.confirm_block_reason, "Only potential claims (matches awaiting confirmation) can be confirmed; this claim is inactive");
  assert.equal(isConfirmable(row), false);
  assert.equal(activateActionOf(row), "reinstate");
  assert.equal(row.video_url, `https://www.youtube.com/watch?v=${ID}`);
  assert.equal(row.network_name, "BPM Digital");
  assert.equal(row.video.channel_title, "Channel");
  assert.deepEqual(buildReleaseItems([row]), [{ network_id: 2, claim_id: "C9", video_id: ID, asset_id: "A1", video_title: "Song title", channel_title: "Channel", asset_title: "Asset title", isrc: "VNA122400001" }]);
  const bare = claimFromHistoryEvent({ network_id: 3, claim_id: "C10" });
  assert.equal(bare.key, "3:C10");
  assert.equal(bare.video_id, null);
  assert.equal(bare.video_url, "");
  assert.equal(bare.asset_id, null);
  assert.deepEqual(buildReleaseItems([bare])[0], { network_id: 3, claim_id: "C10", video_id: null, asset_id: null, video_title: "", channel_title: "", asset_title: "", isrc: "" });
  assert.equal(claimFromHistoryEvent(null).claim_id, undefined);
  // The reinstate outcomes apply to such a row like to a search row.
  const [done] = applyReinstateResults([row], [{ key: "2:C9", outcome: "reinstated", status: "active", claim: null }]);
  assert.equal(done.status, "active");
  assert.equal(done.can_reinstate, false);
});

// ---------------------------------------------------------------------------
// Confirm / activate flow (potential → active, and released + potential set active in one run)
// ---------------------------------------------------------------------------

/** A potential claim (a match awaiting confirmation) the server lets this user confirm and release. */
function potentialClaim(overrides = {}) {
  return claim({
    status: "potential",
    can_release: true,
    release_block_reason: "",
    can_reinstate: false,
    reinstate_block_reason: REINSTATE_BLOCK_DEFAULT,
    can_confirm: true,
    confirm_block_reason: "",
    ...overrides
  });
}

test("isConfirmable / confirmBlockReason: only potential claims the server allows", () => {
  const potential = potentialClaim();
  assert.equal(isConfirmable(potential), true);
  assert.equal(confirmBlockReason(potential), "");
  // Rows from an older server carry no can_confirm: can_release answers the same label check.
  const legacy = claim({ status: "potential", can_release: true });
  assert.equal("can_confirm" in legacy, false);
  assert.equal(isConfirmable(legacy), true);
  assert.equal(confirmBlockReason(legacy), "");
  assert.equal(isConfirmable(claim({ status: "potential", can_release: false })), false);
  assert.equal(isConfirmable(potentialClaim({ can_confirm: false, can_release: true })), false, "an explicit server refusal wins over can_release");
  const limited = potentialClaim({ can_confirm: false, confirm_block_reason: "Asset is not in your allowed labels" });
  assert.equal(isConfirmable(limited), false);
  assert.equal(confirmBlockReason(limited), "Asset is not in your allowed labels");
  assert.equal(isConfirmable(potentialClaim({ status: "POTENTIAL" })), true, "status case does not matter");
  // Inactive / active rows are never confirmable, flag or not.
  assert.equal(isConfirmable(releasedClaim({ can_confirm: true })), false);
  assert.equal(confirmBlockReason(releasedClaim()), CONFIRM_BLOCK_DEFAULT);
  assert.equal(confirmBlockReason(claim()), "Only potential claims (matches awaiting confirmation) can be confirmed");
  assert.equal(isConfirmable(claim({ status: "active", can_confirm: true })), false);
  assert.equal(confirmBlockReason(claim({ status: "release_unknown", can_release: false, can_confirm: false })), "Outcome unknown: re-check the claim status first");
  assert.equal(isConfirmable(null), false);
  assert.equal(isConfirmable(undefined), false);
  assert.equal(confirmBlockReason(null), "");
  // A confirmable row is releasable too (both writes take a potential claim).
  assert.equal(isReleasable(potential), true);
  assert.deepEqual(CONFIRMABLE_STATUSES, ["potential"]);
  assert.deepEqual(ACTIVATABLE_STATUSES, ["potential", "inactive"]);
});

test("activateActionOf / isActivatable / activateBlockReason / isSelectable cover both writes", () => {
  const released = releasedClaim();
  const potential = potentialClaim();
  assert.equal(activateActionOf(released), "reinstate");
  assert.equal(activateActionOf(potential), "confirm");
  assert.equal(activateActionOf(claim()), null, "an active claim is not activatable");
  assert.equal(activateActionOf(claim({ status: "pending" })), null);
  assert.equal(activateActionOf(releasedClaim({ can_reinstate: false })), null);
  assert.equal(activateActionOf(potentialClaim({ can_confirm: false })), null);
  assert.equal(activateActionOf(claim({ status: "release_unknown", can_release: false })), null);
  assert.equal(activateActionOf(null), null);
  assert.equal(isActivatable(released), true);
  assert.equal(isActivatable(potential), true);
  assert.equal(isActivatable(claim()), false);
  assert.equal(isActivatable(undefined), false);
  // Block reasons: the write the row's status would need, or the generic sentence.
  assert.equal(activateBlockReason(released), "");
  assert.equal(activateBlockReason(potential), "");
  assert.equal(activateBlockReason(releasedClaim({ can_reinstate: false, reinstate_block_reason: "Asset is not in your allowed labels" })), "Asset is not in your allowed labels");
  assert.equal(activateBlockReason(releasedClaim({ can_reinstate: false })), REINSTATE_BLOCK_DEFAULT);
  assert.equal(activateBlockReason(potentialClaim({ can_confirm: false, confirm_block_reason: "Asset is not in your allowed labels" })), "Asset is not in your allowed labels");
  assert.equal(activateBlockReason(potentialClaim({ can_confirm: false })), CONFIRM_BLOCK_DEFAULT);
  assert.equal(activateBlockReason(claim()), "Only potential and released (inactive) claims can be activated; this claim is active");
  assert.equal(activateBlockReason(claim({ status: "manual_review" })), "Only potential and released (inactive) claims can be activated; this claim is manual review");
  assert.equal(activateBlockReason(claim({ status: "release_unknown", can_release: false })), "Outcome unknown: re-check the claim status first");
  assert.equal(activateBlockReason(null), "");
  // Row checkbox rule: releasable or activatable.
  assert.equal(isSelectable(claim()), true, "active + releasable");
  assert.equal(isSelectable(released), true, "inactive + reinstatable");
  assert.equal(isSelectable(potential), true);
  assert.equal(isSelectable(claim({ can_release: false })), false);
  assert.equal(isSelectable(releasedClaim({ can_reinstate: false })), false);
  assert.equal(isSelectable(claim({ status: "release_unknown", can_release: false })), false);
  assert.equal(isSelectable(null), false);
});

test("selectActivatableKeys honours the per-run limit", () => {
  const rows = [releasedClaim({ claim_id: "C1" }), claim({ claim_id: "C2" }), potentialClaim({ claim_id: "C3" }), releasedClaim({ claim_id: "C4", can_reinstate: false }), potentialClaim({ claim_id: "C5" })];
  assert.deepEqual(selectActivatableKeys(rows), { keys: ["2:C1", "2:C3", "2:C5"], truncated: false });
  assert.deepEqual(selectActivatableKeys(rows, 2), { keys: ["2:C1", "2:C3"], truncated: true });
  assert.deepEqual(selectActivatableKeys(rows, 3), { keys: ["2:C1", "2:C3", "2:C5"], truncated: false });
  assert.deepEqual(selectActivatableKeys([]), { keys: [], truncated: false });
  // Potential rows belong to both selections, released rows only to the activate one, active rows only to the release one.
  assert.deepEqual(selectReleasableKeys(rows), { keys: ["2:C2", "2:C3", "2:C5"], truncated: false });
});

test("activateBatches sends the released rows first, then the potential ones, never mixed, chunked by size", () => {
  const rows = [
    potentialClaim({ claim_id: "P1" }),
    releasedClaim({ claim_id: "R1" }),
    claim({ claim_id: "A1" }),
    potentialClaim({ claim_id: "P2" }),
    releasedClaim({ claim_id: "R2" }),
    releasedClaim({ claim_id: "R3", can_reinstate: false }),
    potentialClaim({ claim_id: "P3" }),
    releasedClaim({ claim_id: "R4" })
  ];
  const batches = activateBatches(rows, 2);
  assert.deepEqual(
    batches.map((batch) => [batch.action, batch.claims.map((row) => row.claim_id)]),
    [
      ["reinstate", ["R1", "R2"]],
      ["reinstate", ["R4"]],
      ["confirm", ["P1", "P2"]],
      ["confirm", ["P3"]]
    ]
  );
  batches.forEach((batch) => {
    assert.ok(batch.claims.length <= 2, "never above the batch size");
    batch.claims.forEach((row) => assert.equal(activateActionOf(row), batch.action, "a batch never mixes the two writes"));
  });
  // The active row and the refused released row are left out; one batch per action when the size allows.
  assert.deepEqual(activateBatches(rows, 50).map((batch) => [batch.action, batch.claims.length]), [["reinstate", 3], ["confirm", 3]]);
  assert.deepEqual(activateBatches(rows).map((batch) => [batch.action, batch.claims.length]), [["reinstate", 3], ["confirm", 3]], "the default size is the release batch size");
  // One kind selected → only that kind of batches; nothing activatable → no batch at all.
  assert.deepEqual(activateBatches([potentialClaim(), potentialClaim({ claim_id: "P9" })], 10).map((batch) => batch.action), ["confirm"]);
  assert.deepEqual(activateBatches([releasedClaim()], 10).map((batch) => batch.action), ["reinstate"]);
  assert.deepEqual(activateBatches([claim(), releasedClaim({ can_reinstate: false })], 10), []);
  assert.deepEqual(activateBatches([], 10), []);
  assert.deepEqual(activateBatches(null, 10), []);
  // A size below 1 means one request per claim.
  assert.equal(activateBatches(rows, 0).length, 6);
});

test("groupClaimsByVideo counts the activatable claims of each video", () => {
  const rows = [
    claim({ claim_id: "C1" }),
    releasedClaim({ claim_id: "C2" }),
    potentialClaim({ claim_id: "C3" }),
    releasedClaim({ claim_id: "C4", can_reinstate: false }),
    claim({ claim_id: "C5", video_id: "ZZZZZZZZZZZ", status: "potential", can_release: true })
  ];
  const groups = groupClaimsByVideo(rows, []);
  assert.equal(groups[0].claim_count, 4);
  assert.equal(groups[0].releasable_count, 2, "C1 active + C3 potential");
  assert.equal(groups[0].activatable_count, 2, "C2 reinstate + C3 confirm");
  assert.equal(groups[1].releasable_count, 1);
  assert.equal(groups[1].activatable_count, 1, "a potential row without can_confirm (older server) counts through can_release");
  assert.equal(groupClaimsByVideo([], [{ video_id: "AAAAAAAAAAA", title: "Empty" }])[0].activatable_count, 0);
});

test("applyActivateResults updates rows in place after a confirm", () => {
  const rows = ["C1", "C2", "C3", "C4", "C5", "C6"].map((claim_id) => potentialClaim({ claim_id }));
  const fresh = {
    network_id: 2,
    claim_id: "C1",
    status: "active",
    can_release: true,
    release_block_reason: "",
    can_reinstate: false,
    reinstate_block_reason: "Only inactive (released) claims can be reinstated",
    can_confirm: false,
    confirm_block_reason: "Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is active",
    video: null,
    video_title: "",
    video_views: null,
    time_status_last_modified: "2026-10-17T00:00:00Z"
  };
  const updated = applyActivateResults(rows, [
    { key: "2:C1", outcome: "confirmed", status: "active", message: "Google confirmed the potential claim; it is active now.", action: "confirm", claim: fresh },
    { key: "2:C2", outcome: "already_active", status: "active", action: "confirm", claim: null },
    { key: "2:C3", outcome: "unknown", message: "timeout", action: "confirm" },
    { key: "2:C4", outcome: "failed", message: "invalidStatusTransition", retryable: false, action: "confirm" },
    { key: "2:C5", outcome: "skipped", message: "Asset is not in your allowed labels", action: "confirm" }
  ]);
  // confirmed: active and releasable, neither reinstatable nor confirmable; the row keeps its preview; tagged as a confirm.
  assert.equal(updated[0].status, "active");
  assert.equal(updated[0].can_release, true);
  assert.equal(updated[0].release_block_reason, "");
  assert.equal(updated[0].can_reinstate, false);
  assert.equal(updated[0].can_confirm, false);
  assert.equal(updated[0].confirm_block_reason, fresh.confirm_block_reason);
  assert.equal(isReleasable(updated[0]), true);
  assert.equal(isActivatable(updated[0]), false);
  assert.equal(updated[0].video.thumbnail, "https://i.ytimg.com/x.jpg");
  assert.equal(updated[0].video_views, 1234);
  assert.equal(updated[0].time_status_last_modified, "2026-10-17T00:00:00Z");
  assert.deepEqual(updated[0].release_result, { outcome: "confirmed", message: "Google confirmed the potential claim; it is active now.", action: "confirm" });
  assert.equal(rowResultAction(updated[0]), "confirm");
  // already_active without a refreshed claim: active, releasable, the confirm reason names the status.
  assert.equal(updated[1].status, "active");
  assert.equal(updated[1].can_release, true);
  assert.equal(updated[1].release_block_reason, "");
  assert.equal(updated[1].can_reinstate, false);
  assert.equal(updated[1].reinstate_block_reason, REINSTATE_BLOCK_DEFAULT);
  assert.equal(updated[1].can_confirm, false);
  assert.equal(updated[1].confirm_block_reason, "Only potential claims (matches awaiting confirmation) can be confirmed; this claim is active");
  assert.equal(updated[1].release_result.outcome, "already_active");
  assert.equal(updated[1].release_result.action, "confirm");
  // unknown: "Check status", no button at all, every reason names the confirm.
  const reason = "Confirm outcome unknown: re-check the claim status first";
  assert.equal(updated[2].status, "release_unknown");
  assert.equal(updated[2].can_release, false);
  assert.equal(updated[2].can_reinstate, false);
  assert.equal(updated[2].can_confirm, false);
  assert.equal(updated[2].release_block_reason, reason);
  assert.equal(updated[2].reinstate_block_reason, reason);
  assert.equal(updated[2].confirm_block_reason, reason);
  assert.equal(confirmBlockReason(updated[2]), reason);
  assert.equal(isSelectable(updated[2]), false);
  assert.deepEqual(updated[2].release_result, { outcome: "unknown", message: "timeout", action: "confirm" });
  // failed: the row is unchanged apart from the result (still potential and confirmable, so Confirm can be retried).
  assert.equal(updated[3].status, "potential");
  assert.equal(updated[3].can_confirm, true);
  assert.equal(isConfirmable(updated[3]), true);
  assert.equal(isReleasable(updated[3]), true);
  assert.deepEqual(updated[3].release_result, { outcome: "failed", message: "invalidStatusTransition", action: "confirm" });
  // skipped without a refreshed claim: Confirm is withdrawn with the server's reason; releasing is untouched.
  assert.equal(updated[4].status, "potential");
  assert.equal(updated[4].can_confirm, false);
  assert.equal(updated[4].confirm_block_reason, "Asset is not in your allowed labels");
  assert.equal(confirmBlockReason(updated[4]), "Asset is not in your allowed labels");
  assert.equal(updated[4].can_release, true);
  assert.equal(updated[4].release_result.outcome, "skipped");
  assert.equal(updated[5], rows[5], "untouched rows keep their identity");
  assert.equal(applyActivateResults(rows, []), rows);
  assert.equal(applyActivateResults(rows, null), rows);
  // An untagged result is read from the row: potential → confirm, inactive → reinstate.
  const [inferredConfirm] = applyActivateResults([potentialClaim({ claim_id: "C7" })], [{ key: "2:C7", outcome: "unknown", message: "timeout" }]);
  assert.equal(inferredConfirm.release_result.action, "confirm");
  assert.equal(inferredConfirm.confirm_block_reason, reason);
  const [inferredReinstate] = applyActivateResults([releasedClaim({ claim_id: "C8" })], [{ key: "2:C8", outcome: "unknown", message: "timeout" }]);
  assert.equal(inferredReinstate.release_result.action, "reinstate");
  assert.equal(inferredReinstate.release_block_reason, "Reinstate outcome unknown: re-check the claim status first");
  // A mixed run: a reinstate result and a confirm result side by side, each tagged with the write that was sent.
  const mixed = applyActivateResults(
    [releasedClaim({ claim_id: "R1" }), potentialClaim({ claim_id: "P1" })],
    [
      { key: "2:R1", outcome: "reinstated", status: "active", action: "reinstate", claim: null },
      { key: "2:P1", outcome: "confirmed", status: "active", action: "confirm", claim: null }
    ]
  );
  assert.deepEqual(
    mixed.map((row) => [row.status, row.can_release, row.can_reinstate, row.can_confirm, row.release_result.action]),
    [
      ["active", true, false, false, "reinstate"],
      ["active", true, false, false, "confirm"]
    ]
  );
  // A skipped result with a refreshed claim (the status moved on) follows the server's row.
  const [moved] = applyActivateResults(
    [potentialClaim({ claim_id: "P2" })],
    [
      {
        key: "2:P2",
        outcome: "skipped",
        action: "confirm",
        message: "The claim is not potential (now disputed).",
        claim: { status: "disputed", can_release: false, release_block_reason: "Claims in disputed status cannot be released", can_reinstate: false, reinstate_block_reason: "x", can_confirm: false, confirm_block_reason: "y" }
      }
    ]
  );
  assert.equal(moved.status, "disputed");
  assert.equal(moved.can_confirm, false);
  assert.equal(moved.confirm_block_reason, "y");
  assert.equal(moved.can_release, false);
  assert.equal(moved.release_result.outcome, "skipped");
  // A refreshed claim that denies releasing the confirmed claim wins over the inference.
  const [denied] = applyActivateResults(
    [potentialClaim({ claim_id: "P3" })],
    [{ key: "2:P3", outcome: "confirmed", status: "active", action: "confirm", claim: { status: "active", can_release: false, release_block_reason: "Asset is not in your allowed labels" } }]
  );
  assert.equal(denied.can_release, false);
  assert.equal(denied.release_block_reason, "Asset is not in your allowed labels");
  assert.equal(denied.can_confirm, false);
  // Results without a key are matched by their ids, like the release flow.
  const [byIds] = applyActivateResults([potentialClaim({ claim_id: "P4" })], [{ network_id: 2, claim_id: "P4", outcome: "confirmed", status: "active", action: "confirm", claim: null }]);
  assert.equal(byIds.status, "active");
  assert.equal(byIds.release_result.outcome, "confirmed");
});

test("applyReinstateResults still behaves as before (every untagged result is a reinstate)", () => {
  const rows = [releasedClaim({ claim_id: "C1" }), releasedClaim({ claim_id: "C2" }), releasedClaim({ claim_id: "C3" })];
  const updated = applyReinstateResults(rows, [
    { key: "2:C1", outcome: "reinstated", status: "active", claim: null },
    { key: "2:C2", outcome: "unknown", message: "timeout" },
    { key: "2:C3", outcome: "skipped", message: "Asset is not in your allowed labels" },
    null
  ]);
  assert.deepEqual(updated.map((row) => row.release_result.action), ["reinstate", "reinstate", "reinstate"]);
  assert.equal(updated[0].status, "active");
  assert.equal(updated[0].can_release, true);
  assert.equal(updated[0].can_reinstate, false);
  assert.equal(updated[0].can_confirm, false);
  assert.equal(updated[0].confirm_block_reason, "Only potential claims (matches awaiting confirmation) can be confirmed; this claim is active");
  assert.equal(updated[1].status, "release_unknown");
  assert.equal(updated[1].release_block_reason, "Reinstate outcome unknown: re-check the claim status first");
  assert.equal(updated[1].can_confirm, false);
  assert.equal(updated[2].can_reinstate, false);
  assert.equal(updated[2].reinstate_block_reason, "Asset is not in your allowed labels");
  // A result the caller tagged keeps its tag.
  const [tagged] = applyReinstateResults([potentialClaim({ claim_id: "P1" })], [{ key: "2:P1", outcome: "confirmed", status: "active", action: "confirm", claim: null }]);
  assert.equal(tagged.release_result.action, "confirm");
  assert.equal(tagged.status, "active");
  // Same rows as applyActivateResults with the reinstate tag.
  assert.deepEqual(
    applyReinstateResults(rows, [{ key: "2:C1", outcome: "already_active", status: "active", claim: null }]),
    applyActivateResults(rows, [{ key: "2:C1", outcome: "already_active", status: "active", action: "reinstate", claim: null }])
  );
});

test("applyReleaseResults withdraws Confirm from released rows (and from unknown ones)", () => {
  const rows = [potentialClaim({ claim_id: "C1" }), potentialClaim({ claim_id: "C2" }), potentialClaim({ claim_id: "C3" }), claim({ claim_id: "C4" }), potentialClaim({ claim_id: "C5" })];
  const serverReason = "Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is inactive";
  const updated = applyReleaseResults(rows, [
    {
      key: "2:C1",
      outcome: "released",
      status: "inactive",
      claim: { status: "inactive", can_release: false, release_block_reason: "Claims in inactive status cannot be released", can_reinstate: true, reinstate_block_reason: "", can_confirm: false, confirm_block_reason: serverReason }
    },
    { key: "2:C2", outcome: "already_inactive", status: "inactive", claim: null },
    { key: "2:C3", outcome: "unknown", message: "timeout" },
    { key: "2:C4", outcome: "released", status: "inactive", claim: null },
    { key: "2:C5", outcome: "failed", message: "quota", retryable: true }
  ]);
  assert.equal(updated[0].can_confirm, false);
  assert.equal(updated[0].confirm_block_reason, serverReason, "the server's reason wins");
  assert.equal(isConfirmable(updated[0]), false);
  assert.equal(isReinstatable(updated[0]), true);
  assert.equal(activateActionOf(updated[0]), "reinstate", "a released potential claim is reinstated from now on, not confirmed");
  assert.equal(updated[1].can_confirm, false);
  assert.equal(updated[1].confirm_block_reason, "Only potential claims (matches awaiting confirmation) can be confirmed; this claim is inactive");
  assert.equal(activateActionOf(updated[1]), "reinstate");
  assert.equal(updated[2].status, "release_unknown");
  assert.equal(updated[2].can_confirm, false);
  assert.equal(updated[2].confirm_block_reason, "Release outcome unknown: re-check the claim status first");
  assert.equal(confirmBlockReason(updated[2]), "Release outcome unknown: re-check the claim status first");
  assert.equal(isSelectable(updated[2]), false);
  assert.equal(updated[3].can_confirm, false);
  assert.equal(updated[3].confirm_block_reason, "Only potential claims (matches awaiting confirmation) can be confirmed; this claim is inactive");
  // A failed release leaves the potential row confirmable (nothing changed).
  assert.equal(updated[4].status, "potential");
  assert.equal(updated[4].can_confirm, true);
  assert.equal(isConfirmable(updated[4]), true);
  assert.equal(updated[4].release_result.action, "release");
});

test("recheckToOutcome follows a confirm: active confirms it, potential means it did not go through", () => {
  const options = { action: "confirm" };
  const confirmed = recheckToOutcome({ network_id: 2, claim_id: "C1", found: true, status: "active" }, options);
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(confirmed.retryable, false);
  assert.equal(confirmed.message, "Confirmed active by Google.");
  assert.equal(confirmed.key, "2:C1");
  assert.equal(confirmed.status, "active");
  const recorded = recheckToOutcome(
    { network_id: 2, claim_id: "C1", found: true, status: "active", message: "Confirmed active; the earlier confirm was recorded.", confirmed: { action: "confirm", result: "confirmed" } },
    options
  );
  assert.equal(recorded.outcome, "confirmed");
  assert.equal(recorded.message, "Confirmed active; the earlier confirm was recorded.");
  const still = recheckToOutcome({ network_id: 2, claim_id: "C2", found: true, status: "potential" }, options);
  assert.equal(still.outcome, "failed");
  assert.equal(still.retryable, true);
  assert.equal(still.message, "Claim is still potential: the confirm did not go through. Retry it.");
  const disputed = recheckToOutcome({ network_id: 2, claim_id: "C3", found: true, status: "disputed" }, options);
  assert.equal(disputed.outcome, "failed");
  assert.equal(disputed.retryable, false);
  assert.equal(disputed.message, "Claim is now disputed and cannot be confirmed.");
  // inactive after a confirm is "another status" too (a release happened meanwhile): not retryable.
  const inactive = recheckToOutcome({ network_id: 2, claim_id: "C3", found: true, status: "inactive" }, options);
  assert.deepEqual([inactive.outcome, inactive.retryable, inactive.message], ["failed", false, "Claim is now inactive and cannot be confirmed."]);
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C3", found: true, claim: { status: "ACTIVE" } }, options).outcome, "confirmed");
  // in_flight and not-found stay unknown; the in-flight message names the confirm, the server's message wins when present.
  const inFlight = recheckToOutcome({ network_id: 2, claim_id: "C4", found: true, status: "potential", in_flight: true }, options);
  assert.equal(inFlight.outcome, "unknown");
  assert.equal(inFlight.retryable, false);
  assert.equal(inFlight.message, "A confirm of this claim is still running on the server; re-check it in a minute.");
  const serverMessage = "A status change (release, reinstate or confirm) of this claim is still running on the server; its outcome will be recorded by that request. Re-check it in a minute.";
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C4", found: true, status: "potential", in_flight: true, message: serverMessage }, options).message, serverMessage);
  assert.match(recheckToOutcome({ network_id: 2, claim_id: "C5", found: false }, options).message, /could not find this claim/);
  // The server settled another write (an old release) while the operator follows up a confirm: its message is dropped …
  const other = recheckToOutcome(
    { network_id: 2, claim_id: "C6", found: true, status: "inactive", message: "Confirmed inactive; the earlier release was recorded.", confirmed: { action: "release", result: "released" } },
    options
  );
  assert.deepEqual([other.outcome, other.retryable, other.message], ["failed", false, "Claim is now inactive and cannot be confirmed."]);
  // … and a settled confirm is ignored when the operator follows up a release or a reinstate.
  const settledConfirm = { network_id: 2, claim_id: "C7", found: true, status: "active", message: "Confirmed active; the earlier confirm was recorded.", confirmed: { action: "confirm", result: "confirmed" } };
  assert.equal(recheckToOutcome(settledConfirm, { action: "release" }).message, "Claim is still active: the release did not go through. Retry it.");
  assert.deepEqual([recheckToOutcome(settledConfirm, { action: "reinstate" }).outcome, recheckToOutcome(settledConfirm, { action: "reinstate" }).message], ["reinstated", "Confirmed active by Google."]);
  // The release and reinstate mappings are unchanged.
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C8", found: true, status: "inactive" }).outcome, "released");
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C8", found: true, status: "active" }, { action: "reinstate" }).outcome, "reinstated");
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C8", found: true, status: "active", in_flight: true }).message, "A release of this claim is still running on the server; re-check it in a minute.");
  assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C8", found: true, status: "inactive", in_flight: true }, { action: "reinstate" }).message, "A reinstate of this claim is still running on the server; re-check it in a minute.");
});

test("applyRecheckResults leaves a confirm row consistent with the status Google reads back", () => {
  const reason = "Confirm outcome unknown: re-check the claim status first";
  const pending = claim({
    claim_id: "C1",
    status: "release_unknown",
    can_release: false,
    release_block_reason: reason,
    can_reinstate: false,
    reinstate_block_reason: reason,
    can_confirm: false,
    confirm_block_reason: reason,
    release_result: { outcome: "unknown", message: "timeout", action: "confirm" }
  });
  // Active (the confirm went through): releasable, neither reinstatable nor confirmable, result cleared.
  const [active] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "active", claim: null }]);
  assert.equal(active.status, "active");
  assert.equal(active.can_release, true);
  assert.equal(active.can_confirm, false);
  assert.equal(active.confirm_block_reason, CONFIRM_BLOCK_DEFAULT);
  assert.equal(active.can_reinstate, false);
  assert.equal(active.release_result, null);
  // Potential (it did not go through): confirmable again, and releasable.
  const [potential] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "potential", claim: null }]);
  assert.equal(potential.status, "potential");
  assert.equal(potential.can_confirm, true);
  assert.equal(potential.confirm_block_reason, "");
  assert.equal(potential.can_release, true);
  assert.equal(isConfirmable(potential), true);
  assert.equal(activateActionOf(potential), "confirm");
  assert.equal(potential.release_result, null);
  // Inactive (released meanwhile): reinstatable, not confirmable.
  const [inactive] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "inactive", claim: null }]);
  assert.equal(inactive.can_confirm, false);
  assert.equal(inactive.can_reinstate, true);
  assert.equal(activateActionOf(inactive), "reinstate");
  // With a refreshed claim the server's flags win; without the confirm fields the status rule applies.
  const [flagged] = applyRecheckResults(
    [pending],
    [{ key: "2:C1", found: true, status: "potential", claim: { status: "potential", can_release: false, release_block_reason: "x", can_confirm: false, confirm_block_reason: "Asset is not in your allowed labels" } }]
  );
  assert.equal(flagged.can_confirm, false);
  assert.equal(flagged.confirm_block_reason, "Asset is not in your allowed labels");
  assert.equal(isConfirmable(flagged), false);
  const [legacy] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "potential", claim: { status: "potential", can_release: true, release_block_reason: "" } }]);
  assert.equal(legacy.can_confirm, true);
  assert.equal(legacy.confirm_block_reason, "");
  const [legacyActive] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "active", claim: { status: "active", can_release: true, release_block_reason: "" } }]);
  assert.equal(legacyActive.can_confirm, false);
  assert.equal(legacyActive.confirm_block_reason, CONFIRM_BLOCK_DEFAULT);
  // The row of an in-flight confirm is left alone, identity included.
  const [untouched] = applyRecheckResults([pending], [{ key: "2:C1", found: true, status: "potential", in_flight: true }]);
  assert.equal(untouched, pending);
});

test("releaseSummaryText, summarizeRelease and the shared constants cover the confirm outcome", () => {
  const summary = summarizeRelease([{ outcome: "confirmed" }, { outcome: "confirmed" }, { outcome: "reinstated" }, { outcome: "already_active" }, { outcome: "skipped" }]);
  assert.deepEqual(summary, { total: 5, released: 0, already_inactive: 0, reinstated: 1, confirmed: 2, already_active: 1, failed: 0, unknown: 0, skipped: 1 });
  assert.equal(releaseSummaryText(summary), "1 reinstated · 2 confirmed · 1 already active · 1 skipped");
  assert.equal(releaseSummaryText({ confirmed: 3 }), "3 confirmed");
  assert.equal(releaseSummaryText({ released: 1, confirmed: 1, unknown: 1 }), "1 released · 1 confirmed · 1 to re-check");
  assert.equal(normalizeOutcome("confirmed"), "confirmed");
  assert.equal(outcomeLabel("confirmed"), "Confirmed");
  assert.equal(RELEASE_OUTCOME_META.confirmed.tone, "emerald");
  assert.equal(RELEASE_OUTCOME_META.confirmed.description, "Google confirmed the potential claim; it is active now.");
  assert.equal(RELEASE_OUTCOME_META.already_active.description, "The claim was already active; nothing changed.");
  assert.match(RELEASE_OUTCOME_META.failed.description, /rejected the status change/);
  assert.equal(HISTORY_ACTION_LABELS.confirm, "Confirm");
  assert.equal(CONFIRM_BLOCK_DEFAULT, "Only potential claims (matches awaiting confirmation) can be confirmed");
  assert.equal(ACTIVATE_CONFIRMATION_TEXT, "I understand the selected claims become active right away: the videos are claimed again and the assets' policies apply to them");
});

test("unknownOutcomeMessage names the confirm when asked", () => {
  const options = { action: "confirm" };
  assert.equal(unknownOutcomeMessage({ code: "ECONNABORTED" }, options), "The request timed out before Google answered. The confirm may still have been applied; re-check the claim status.");
  assert.equal(unknownOutcomeMessage({ code: "ERR_NETWORK", request: {} }, options), "The connection dropped before Google's answer arrived. The confirm may still have been applied; re-check the claim status.");
  assert.equal(
    unknownOutcomeMessage({ code: "ERR_CANCELED" }, options),
    "Cancelled while waiting for Google. The claims already sent may still be confirmed on the server: wait about a minute, then re-check them."
  );
  assert.equal(unknownOutcomeMessage({ response: { status: 504 } }, options), "Google did not answer in time. The confirm may still have been applied; re-check the claim status.");
  assert.doesNotMatch(unknownOutcomeMessage({ code: "ECONNABORTED" }, options), /release|reinstate/);
  // An action that is not a write falls back to the release wording; the reinstate wording is unchanged.
  assert.equal(unknownOutcomeMessage({ code: "ECONNABORTED" }, { action: "nonsense" }), "The request timed out before Google answered. The release may still have been applied; re-check the claim status.");
  assert.equal(
    unknownOutcomeMessage({ code: "ERR_CANCELED" }, { action: "reinstate" }),
    "Cancelled while waiting for Google. The claims already sent may still be reinstated on the server: wait about a minute, then re-check them."
  );
});

test("rowResultAction knows the confirm tag and mergeServerClaim follows can_confirm", () => {
  assert.equal(rowResultAction(claim({ release_result: { outcome: "confirmed", action: "confirm" } })), "confirm");
  assert.equal(rowResultAction(claim({ release_result: { outcome: "reinstated", action: "reinstate" } })), "reinstate");
  assert.equal(rowResultAction(claim({ release_result: { outcome: "released", action: "release" } })), "release");
  assert.equal(rowResultAction(claim({ release_result: { outcome: "unknown", action: "recheck" } })), "release", "an action that is not a write reads as a release");
  assert.equal(rowResultAction(claim({ release_result: { outcome: "unknown" } })), "release");
  // The server's confirm fields are authoritative in a merge, "" included; absent or null fields leave the row alone.
  const merged = mergeServerClaim(potentialClaim({ can_confirm: false, confirm_block_reason: "stale reason" }), { status: "potential", can_confirm: true, confirm_block_reason: "" });
  assert.equal(merged.can_confirm, true);
  assert.equal(merged.confirm_block_reason, "");
  assert.equal(isConfirmable(merged), true);
  const refused = mergeServerClaim(potentialClaim(), { status: "potential", can_confirm: false, confirm_block_reason: "Asset is not in your allowed labels" });
  assert.equal(refused.can_confirm, false);
  assert.equal(confirmBlockReason(refused), "Asset is not in your allowed labels");
  assert.equal(mergeServerClaim(potentialClaim({ confirm_block_reason: "kept" }), { status: "potential" }).confirm_block_reason, "kept");
  assert.equal(mergeServerClaim(potentialClaim(), { status: "potential", can_confirm: null }).can_confirm, true);
});

// ---------------------------------------------------------------------------
// Formatting, CSV, errors, history params
// ---------------------------------------------------------------------------

test("formatSeconds renders mm:ss and h:mm:ss", () => {
  assert.equal(formatSeconds(0), "00:00");
  assert.equal(formatSeconds(42), "00:42");
  assert.equal(formatSeconds(201), "03:21");
  assert.equal(formatSeconds(3723), "1:02:03");
  assert.equal(formatSeconds(59.6), "01:00");
  assert.equal(formatSeconds(null), "");
  assert.equal(formatSeconds("abc"), "");
  assert.equal(formatSeconds(-1), "");
});

test("formatDurationMs rounds to ms / tenths / seconds / minutes and never shows 60 s", () => {
  assert.equal(formatDurationMs(320), "320 ms");
  assert.equal(formatDurationMs(1234), "1.2 s");
  assert.equal(formatDurationMs(9999), "10 s");
  assert.equal(formatDurationMs(59999), "1 min");
  assert.equal(formatDurationMs(61000), "1 min 1 s");
  assert.equal(formatDurationMs(119999), "2 min");
  assert.equal(formatDurationMs(0), "0 ms");
  assert.equal(formatDurationMs("1500"), "1.5 s");
  assert.equal(formatDurationMs(null), "");
  assert.equal(formatDurationMs(undefined), "");
  assert.equal(formatDurationMs(""), "");
  assert.equal(formatDurationMs(-5), "");
  assert.equal(formatDurationMs("abc"), "");
});

test("claimsToCsvRows builds a header row and one row per claim", () => {
  const rows = claimsToCsvRows([claim(), claim({ claim_id: "C2", video: null, asset: null, asset_id: "", status: "release_unknown", can_release: false, release_block_reason: "", video_views: null })]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], CLAIM_CSV_HEADER);
  assert.equal(rows[0].length, rows[1].length);
  assert.deepEqual(rows[1].slice(0, 12), ["C1", "BPM Digital", "ABC123", ID, `https://www.youtube.com/watch?v=${ID}`, "Song title", "Channel", "A1", "Asset title", "VNA122400001", "123456789012", "ANS; Pop"]);
  assert.deepEqual(rows[1].slice(12), ["Active", "Audio", "Audio match", "no", "no", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", 1234, "yes", ""]);
  assert.equal(rows[2][7], "");
  assert.equal(rows[2][12], "Check status");
  assert.equal(rows[2][19], "");
  assert.equal(rows[2][20], "no");
  assert.match(rows[2][21], /re-check/);
  assert.deepEqual(claimsToCsvRows([]), [CLAIM_CSV_HEADER]);
});

test("describeApiError adds the operator hint for 424 / 429 / timeouts as its own sentence", () => {
  assert.equal(
    describeApiError({ response: { status: 424, data: { message: "Google rejected the token" } } }),
    "Google rejected the token. Re-authorize this CMS in Settings > Network, then try again."
  );
  // A server message that already tells the operator to re-authorize is not suffixed again.
  const already = "Google rejected the CMS token for BPM Digital. Re-authorize the CMS in Settings > Network and try again.";
  assert.equal(describeApiError({ response: { status: 424, data: { message: already } } }), already);
  assert.equal(describeApiError({ response: { status: 424 } }, "Please re-authorise the CMS."), "Please re-authorise the CMS.");
  assert.equal(describeApiError({ response: { status: 429, data: { message: "Quota", retry_after: 30 } } }), "Quota. Google rate limit reached: wait 30 s before retrying.");
  assert.equal(
    describeApiError({ response: { status: 429, data: {}, headers: { "retry-after": "12" } } }, "Quota!"),
    "Quota! Google rate limit reached: wait 12 s before retrying."
  );
  assert.match(describeApiError({ response: { status: 429, data: {} } }, "Quota"), /wait a moment/);
  // Only read requests reach this helper (writes go through unknownOutcomeMessage), so the timeout hint just says to retry.
  assert.equal(describeApiError({ code: "ECONNABORTED", message: "timeout" }, "Request timed out"), "Request timed out. Google did not answer in time; try again in a moment.");
  assert.equal(describeApiError({ response: { status: 504, data: { message: "Google did not answer." } } }), "Google did not answer. Google did not answer in time; try again in a moment.");
  // Endpoints that only read our own database (release history) must not blame Google for a timeout.
  assert.equal(describeApiError({ code: "ECONNABORTED" }, "Request timed out", { googleBacked: false }), "Request timed out. The server did not answer in time; try again in a moment.");
  assert.equal(requestMessage({ response: { status: 504, data: { message: "Gateway timeout" } } }, { googleBacked: false }), "Gateway timeout. The server did not answer in time; try again in a moment.");
  assert.equal(requestMessage({ response: { status: 424, data: { message: "Token rejected" } } }, { googleBacked: false }), "Token rejected. Re-authorize this CMS in Settings > Network, then try again.");
  assert.equal(describeApiError({ response: { status: 400, data: { message: "Bad input" } } }), "Bad input");
  assert.equal(describeApiError({ response: { status: 403 } }, "Not allowed"), "Not allowed");
  assert.equal(describeApiError(null), "Request failed");
});

test("requestMessage builds the operator message from the axios error alone", () => {
  assert.equal(requestMessage({ response: { status: 424, data: { message: "Token rejected" } } }), "Token rejected. Re-authorize this CMS in Settings > Network, then try again.");
  assert.equal(requestMessage({ code: "ECONNABORTED" }), "Request timed out. Google did not answer in time; try again in a moment.");
  assert.equal(requestMessage({ code: "ERR_CANCELED" }), "Cancelled");
  assert.equal(requestMessage({ response: { status: 400, data: { errors: [{ message: "a" }, { error: "b" }] } } }), "a; b");
  assert.equal(requestMessage({ response: { status: 500, data: "Internal" } }), "Internal");
  assert.equal(requestMessage({ message: "boom" }), "boom");
  assert.equal(requestMessage("plain text"), "plain text");
  assert.equal(requestMessage(null), "Request failed");
});

test("batchFailureMessage leaves the 429 wait to the results panel and keeps the other hints", () => {
  const quota = { response: { status: 429, data: { message: "Quota exceeded", retry_after: 30 } } };
  assert.equal(batchFailureMessage(quota), "Quota exceeded");
  assert.equal(requestMessage(quota), "Quota exceeded. Google rate limit reached: wait 30 s before retrying.", "the run banner keeps the full hint");
  assert.equal(
    batchFailureMessage({ message: "Request failed with status code 429", response: { status: 429, data: {}, headers: { "retry-after": "12" } } }),
    "Request failed with status code 429"
  );
  assert.equal(batchFailureMessage({ response: { status: 424, data: { message: "Token rejected" } } }), "Token rejected. Re-authorize this CMS in Settings > Network, then try again.");
  assert.equal(batchFailureMessage({ response: { status: 400, data: { message: "Bad input" } } }), "Bad input");
  assert.equal(batchFailureMessage({ response: { status: 503, data: { message: "Google unavailable" } } }), "Google unavailable");
  assert.equal(batchFailureMessage({ response: { status: 500, data: "Internal" } }), "Internal");
  assert.equal(batchFailureMessage(null), "Request failed");
});

test("unwrapBlobError decodes a Blob error body so requestMessage sees the backend message", async () => {
  const body = { success: false, message: "Export matches 25,000 rows; narrow the filters (maximum 20,000).", reason: "too_many_rows" };
  const jsonBlob = (value) => new Blob([JSON.stringify(value)], { type: "application/json" });
  const tooMany = { message: "Request failed with status code 400", response: { status: 400, data: jsonBlob(body) } };
  assert.equal(await unwrapBlobError(tooMany), tooMany, "the same error object comes back");
  assert.deepEqual(tooMany.response.data, body);
  assert.equal(requestMessage(tooMany), body.message);
  // A 424 whose message already says re-authorize is not suffixed again; a 429 reads retry_after from the decoded body.
  const already = "Google rejected the CMS token for BPM Digital. Re-authorize the CMS in Settings > Network and try again.";
  const reauth = { message: "Request failed with status code 424", response: { status: 424, data: jsonBlob({ success: false, message: already, reason: "cms_unauthorized" }) } };
  await unwrapBlobError(reauth);
  assert.equal(requestMessage(reauth), already);
  const rejected = { message: "Request failed with status code 424", response: { status: 424, data: jsonBlob({ success: false, message: "Token rejected" }) } };
  await unwrapBlobError(rejected);
  assert.equal(requestMessage(rejected), "Token rejected. Re-authorize this CMS in Settings > Network, then try again.");
  const quota = { message: "Request failed with status code 429", response: { status: 429, data: jsonBlob({ success: false, message: "Quota", retry_after: 30 }) } };
  await unwrapBlobError(quota);
  assert.equal(requestMessage(quota), "Quota. Google rate limit reached: wait 30 s before retrying.");
  // An HTML proxy error page stays a Blob: the generic axios message is shown, never the page.
  const html = { message: "Request failed with status code 502", response: { status: 502, data: new Blob(["<html><body>502 Bad Gateway</body></html>"], { type: "text/html" }) } };
  assert.equal(await unwrapBlobError(html), html);
  assert.ok(html.response.data instanceof Blob);
  assert.equal(baseErrorMessage(html), "Request failed with status code 502");
  assert.equal(requestMessage(html), "Request failed with status code 502");
  // A short text/plain body (with or without a charset) is used as the message; a long one stays a Blob.
  const plain = { message: "Request failed with status code 500", response: { status: 500, data: new Blob(["Internal error"], { type: "text/plain; charset=utf-8" }) } };
  await unwrapBlobError(plain);
  assert.equal(plain.response.data, "Internal error");
  assert.equal(requestMessage(plain), "Internal error");
  const long = { message: "Request failed with status code 500", response: { status: 500, data: new Blob(["x".repeat(501)], { type: "text/plain" }) } };
  await unwrapBlobError(long);
  assert.ok(long.response.data instanceof Blob);
  assert.equal(requestMessage(long), "Request failed with status code 500");
  // Anything that is not a Blob error passes through untouched; a Blob that cannot be read is kept.
  const json = { response: { status: 400, data: { message: "Bad input" } } };
  assert.equal(await unwrapBlobError(json), json);
  assert.equal(json.response.data.message, "Bad input");
  const network = { code: "ERR_NETWORK", request: {} };
  assert.equal(await unwrapBlobError(network), network);
  assert.equal(await unwrapBlobError(null), null);
  assert.equal(await unwrapBlobError(undefined), undefined);
  const unreadable = { message: "Request failed with status code 500", response: { status: 500, data: Object.assign(new Blob(["{}"]), { text: () => Promise.reject(new Error("boom")) }) } };
  assert.equal(await unwrapBlobError(unreadable), unreadable);
  assert.ok(unreadable.response.data instanceof Blob);
  assert.equal(requestMessage(unreadable), "Request failed with status code 500");
});

test("outcomeLabel reads the outcome meta and degrades gracefully", () => {
  assert.equal(outcomeLabel("released"), "Released");
  assert.equal(outcomeLabel("already_inactive"), "Already inactive");
  assert.equal(outcomeLabel("unknown"), "Check status");
  assert.equal(outcomeLabel("something_new"), "something new");
  assert.equal(outcomeLabel(""), "Unknown");
  assert.equal(outcomeLabel(undefined), "Unknown");
});

/** What historyQuery must send for a picker day: the UTC instant of its local midnight (`nextDay`: of the following one). */
function localMidnightIso(day, nextDay = false) {
  const date = new Date(`${day}T00:00:00`);
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

test("historyQuery drops empty filters and sends picker days as UTC instants (from inclusive, to exclusive)", () => {
  const endOfOct6 = localMidnightIso("2026-10-06", true);
  assert.deepEqual(historyQuery({ network_id: "", result: "unknown", user_id: null, search: "  C1 ", from: "", to: "2026-10-06" }, 2, 50), {
    page: 2,
    page_size: 50,
    result: "unknown",
    search: "C1",
    to: endOfOct6
  });
  assert.match(endOfOct6, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const range = historyQuery({ from: "2026-10-01", to: "2026-10-06" });
  assert.equal(range.from, localMidnightIso("2026-10-01"));
  assert.equal(range.to, endOfOct6);
  // Literal instants for the pinned zone (UTC+7): local midnight is 17:00Z of the previous day.
  assert.deepEqual(range, { page: 1, page_size: 50, from: "2026-09-30T17:00:00.000Z", to: "2026-10-06T17:00:00.000Z" });
  assert.match(range.from, /Z$/);
  assert.match(range.to, /Z$/);
  // `from` is the local midnight that starts its day, `to` the local midnight that starts the next one (so the picked day is covered).
  assert.equal(new Date(range.from).getHours(), 0);
  assert.equal(new Date(range.from).getDate(), 1);
  assert.equal(new Date(range.to).getHours(), 0);
  assert.equal(new Date(range.to).getDate(), 7);
  // Month and year ends roll over; a leap day too.
  assert.equal(historyQuery({ to: "2026-12-31" }).to, localMidnightIso("2026-12-31", true));
  assert.equal(new Date(historyQuery({ to: "2026-12-31" }).to).getMonth(), 0);
  assert.equal(historyQuery({ to: "2028-02-28" }).to, localMidnightIso("2028-02-29"));
  // An instant given by a caller, and anything that is not a picker day, pass through unchanged.
  assert.equal(historyQuery({ from: "2026-10-01T10:00:00Z" }).from, "2026-10-01T10:00:00Z");
  assert.equal(historyQuery({ to: " 2026-10-06T00:00:00.000Z " }).to, "2026-10-06T00:00:00.000Z");
  assert.equal(historyQuery({ from: "yesterday" }).from, "yesterday");
  assert.equal(historyQuery({ from: "2026-13-45" }).from, "2026-13-45", "a day the Date parser rejects is left for the backend to refuse");
  assert.deepEqual(historyQuery({}, 0, 0), { page: 1, page_size: 50 });
  assert.deepEqual(historyExportQuery({ result: "failed", from: "2026-01-01", search: "" }), { result: "failed", from: localMidnightIso("2026-01-01") });
  assert.deepEqual(historyExportQuery({ from: "", to: null }), {});
});

test("historyQuery lands on the real local midnight in a zone whose DST switch happens at midnight", () => {
  // Chile moves its clocks forward at 00:00 on 2026-09-06: midnight does not exist, 01:00 (UTC-3) follows 23:59 (UTC-4).
  const previous = process.env.TZ;
  process.env.TZ = "America/Santiago";
  try {
    assert.equal(historyQuery({ from: "2026-09-06" }).from, "2026-09-06T04:00:00.000Z", "the first instant of the day");
    assert.equal(historyQuery({ to: "2026-09-06" }).to, "2026-09-07T03:00:00.000Z", "the next day starts at a real 00:00, not at 01:00");
    assert.equal(historyQuery({ to: "2026-09-05" }).to, "2026-09-06T04:00:00.000Z");
  } finally {
    process.env.TZ = previous;
  }
});

test("summarizeSearch describes the result for the toast", () => {
  assert.equal(
    summarizeSearch({ mode: "videos", networks: [{ id: 2 }, { id: 3 }], totals: { videos: 3, claims: 5, releasable: 4, errors: 0 }, errors: [] }),
    "Found 5 claims on 3 videos across 2 CMS · 4 releasable"
  );
  assert.equal(summarizeSearch({ mode: "claims", networks: [{ id: 2 }], claims: [{}], totals: { claims: 1, releasable: 0 }, errors: [{}] }), "Found 1 claim across 1 CMS · 0 releasable · 1 CMS error");
  assert.equal(summarizeSearch(null), "");
});

test("recheckToOutcome ignores the server's message when it confirmed the other write", () => {
  // The operator follows up a reinstate; the server settled an OLD release instead and says so.
  const result = { network_id: 7, claim_id: "C1", found: true, status: "inactive", message: "Confirmed inactive; the earlier release was recorded.", confirmed: { action: "release", result: "released" } };
  const asReinstate = recheckToOutcome(result, { action: "reinstate" });
  assert.deepEqual([asReinstate.outcome, asReinstate.retryable, asReinstate.message], ["failed", true, "Claim is still inactive: the reinstate did not go through. Retry it."]);
  const asRelease = recheckToOutcome(result, { action: "release" });
  assert.deepEqual([asRelease.outcome, asRelease.message], ["released", "Confirmed inactive; the earlier release was recorded."]);
});

// ---------------------------------------------------------------------------
// Vietnamese: the English texts above are the keys; sentences built at call time follow the UI language,
// canonical labels / stored texts stay English and are translated where they are rendered.
// ---------------------------------------------------------------------------

test("the helpers speak Vietnamese while the UI language is Vietnamese and English again afterwards", () => {
  setLanguage("vi");
  try {
    // Canonical constants stay English (rendered with t(label) / tm(message) by the components). Labels, headers,
    // counted nouns and generic error texts are shared with other dictionaries, so only their *use* is asserted
    // here (through translate), never their wording; the sentences owned by this slice are asserted literally.
    const vi = (key, params) => translate(key, params);
    const lower = (key) => vi(key).toLowerCase();
    assert.equal(CLAIM_STATUS_META.active.label, "Active");
    assert.equal(statusLabel("active"), "Active");
    assert.notEqual(vi(CLAIM_STATUS_META.active.label), "Active", "the status label has a Vietnamese entry");
    assert.notEqual(vi(REINSTATE_BLOCK_DEFAULT), REINSTATE_BLOCK_DEFAULT, "the block-reason default has a Vietnamese entry");
    assert.equal(reinstateBlockReason(claim()), REINSTATE_BLOCK_DEFAULT, "fixed defaults stay canonical");
    // Sentences with dynamic parts are built in the current language.
    assert.equal(releaseSummaryText({ released: 2, unknown: 1 }), "2 đã gỡ · 1 cần kiểm tra lại");
    assert.equal(releaseSummaryText({}), "Không có claim nào được xử lý");
    assert.equal(validateSearch({ mode: "videos", networkIds: [], parsed: { ids: [ID] } }), "Chọn ít nhất một network CMS.");
    assert.equal(validateSearch({ mode: "assets", networkIds: [1], parsed: { ids: ["A", "B"] }, limits: { max_assets: 1 } }), `Mỗi lần tìm dùng tối đa 1 ${vi("asset IDs")} không trùng (hiện có 2).`);
    assert.equal(validateSearch({ mode: "explore", networkIds: [1], parsed: { ids: [] }, filters: { created_after: "01/02/2026" } }), `${vi("Created")}: mốc "sau" phải có dạng YYYY-MM-DD.`);
    assert.equal(
      buildRequestPlan({ mode: "videos", count: 1, networkCount: 2, limits: { video_batch_size: 50 } }).text,
      `${vi("{count} video", { count: 1 })} × 2 CMS ⇒ ${vi("{count} claim-search reads", { count: 2 })}`
    );
    assert.equal(formatDurationMs(61000), vi("{minutes} min {seconds} s", { minutes: 1, seconds: 1 }));
    assert.notEqual(formatDurationMs(61000), "1 min 1 s", "the duration units have Vietnamese entries");
    assert.equal(formatDurationMs(320), "320 ms");
    assert.equal(releaseBlockReason(claim({ can_release: false, status: "takedown", release_block_reason: "" })), `Claim ở trạng thái ${lower(CLAIM_STATUS_META.takedown.label)} không thể gỡ`);
    assert.equal(activateBlockReason(claim()), `Chỉ claim tiềm năng và claim đã gỡ (inactive) mới có thể kích hoạt; claim này đang ở trạng thái ${lower(CLAIM_STATUS_META.active.label)}`);
    assert.equal(recheckToOutcome({ network_id: 2, claim_id: "C3", found: true, status: "takedown" }).message, `Claim hiện ở trạng thái ${lower(CLAIM_STATUS_META.takedown.label)} và không thể gỡ.`);
    assert.equal(
      unknownOutcomeMessage({ code: "ERR_CANCELED" }, { action: "reinstate" }),
      "Đã hủy trong khi chờ Google. Các claim đã gửi có thể vẫn được khôi phục trên server: chờ khoảng một phút rồi kiểm tra lại."
    );
    // The base message (server text or canonical frontend text) and the operator hint are both translated.
    assert.equal(requestMessage({ response: { status: 429, data: { message: "Quota", retry_after: 30 } } }), `Quota. ${vi("Google rate limit reached: wait {seconds} s before retrying.", { seconds: 30 })}`);
    assert.equal(requestMessage({ code: "ECONNABORTED" }), `${vi("Request timed out")}. ${vi("Google did not answer in time; try again in a moment.")}`);
    assert.notEqual(requestMessage({ code: "ECONNABORTED" }), "Request timed out. Google did not answer in time; try again in a moment.");
    assert.equal(claimsToCsvRows([])[0][12], vi("Status"));
    assert.notEqual(claimsToCsvRows([])[0][12], "Status", "CSV headers follow the UI language");
    assert.equal(claimsToCsvRows([claim()])[1][12], vi(CLAIM_STATUS_META.active.label));
    assert.equal(summarizeSearch({ mode: "videos", networks: [{ id: 2 }], totals: { videos: 3, claims: 5, releasable: 4 }, errors: [] }), "Tìm thấy 5 claim trên 3 video trong 1 CMS · 4 có thể gỡ");
  } finally {
    setLanguage("en");
  }
  assert.equal(releaseSummaryText({ released: 2, unknown: 1 }), "2 released · 1 to re-check");
  assert.equal(formatDurationMs(61000), "1 min 1 s");
  assert.deepEqual(claimsToCsvRows([])[0], CLAIM_CSV_HEADER);
});
