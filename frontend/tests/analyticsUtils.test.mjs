import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage, translate } from "../src/i18n/index.js";
import {
  ANALYTICS_SECTIONS,
  DATE_PRESETS,
  EXPORTS_BY_VIEW,
  STATUS_META,
  addDays,
  buildFillMissingRequest,
  buildSyncRequest,
  countDays,
  dayDiff,
  detectPreset,
  dimensionLabel,
  dimensionValueLabel,
  downloadCsv,
  estimateRequests,
  exportChannelId,
  exportOptionAvailable,
  filtersToSearchParams,
  foldText,
  formatDay,
  formatMetric,
  formatScheduleDate,
  isRangeBehind,
  isRangeFallback,
  isValidDay,
  metricLabel,
  numberValue,
  oauthReasonMessage,
  pacificToday,
  percentChange,
  presetRange,
  rangeEndingAt,
  reportLabel,
  searchParamsToFilters
} from "../src/pages/analytics/analyticsUtils.js";

const CTX = { latestDay: "2026-10-27", latestAllowedDay: "2026-10-29", lagDays: 3 };
const OWNERS = [
  { id: 1, ownerId: "OWNER_A", authStatus: "connected", hasAnalyticsScope: true, coverage: { lastDay: "2026-10-27" } },
  { id: 2, ownerId: "OWNER_B", authStatus: "expired", hasAnalyticsScope: false, coverage: { lastDay: null } }
];
const channel = (suffix) => `UC${String(suffix).padStart(22, "x")}`;
const FILTERS = { ownerId: "OWNER_A", startDate: "2026-09-01", endDate: "2026-09-30", scope: "self", channelIds: [channel(1), channel(2)] };

test("formatMetric follows the language: money, counts, compact notation, durations and percents", () => {
  assert.equal(formatMetric(1234.567, "estimatedRevenue", { language: "en" }), "$1,234.57");
  // ICU separates the vi-VN currency code with a no-break space.
  assert.equal(formatMetric(1234.567, "estimatedRevenue", { language: "vi" }), ["1.234,57", "US$"].join(String.fromCharCode(160)));
  assert.equal(formatMetric(2.5, "rpm", { language: "en" }), "$2.50");
  assert.equal(formatMetric(1234567, "views", { language: "en" }), "1,234,567");
  assert.equal(formatMetric(1234567, "views", { language: "vi" }), "1.234.567");
  assert.equal(formatMetric(123456789, "views", { language: "en", compact: true }), "123M");
  assert.match(formatMetric(123456789, "views", { language: "vi", compact: true }), /^123\s*(Tr|M)$/);
  assert.equal(formatMetric(99999999, "views", { language: "en", compact: true }), "99,999,999");
  assert.equal(formatMetric(864, "averageViewDuration"), "14:24");
  assert.equal(formatMetric(3661, "averageViewDuration"), "1:01:01");
  assert.equal(formatMetric(59.9, "playlistAverageViewDuration"), "1:00");
  assert.equal(formatMetric(0.035, "cardClickRate", { language: "vi" }), "3,5%");
  assert.equal(formatMetric(0.012, "annotationClickThroughRate", { language: "en" }), "1.2%");
  assert.equal(formatMetric(22.75, "averageViewPercentage", { language: "en" }), "22.8%");
  assert.equal(formatMetric(42.5, "viewerPercentage", { language: "vi" }), "42,5%");
  assert.equal(formatMetric(1.2, "audienceWatchRatio", { language: "en" }), "120%");
  assert.equal(formatMetric(0.5, "relativeRetentionPerformance", { language: "vi" }), "0,5");
  assert.equal(formatMetric(0.37, "elapsedVideoTimeRatio", { language: "en" }), "37%");
  assert.equal(formatMetric(12.345, "watchHours", { language: "en" }), "12.3");
  assert.equal(formatMetric(1234.5, "watchHours", { language: "en" }), "1,235");
  assert.equal(formatMetric(120000, "estimatedMinutesWatched", { language: "en" }), "120,000");
});

test("missing analytics values stay missing while a reported zero stays zero", () => {
  for (const value of [undefined, null, "", "  ", false, {}, NaN, Infinity, "unavailable"]) {
    assert.equal(numberValue(value), null);
    assert.equal(formatMetric(value, "views"), "—");
  }
  assert.equal(numberValue("0"), 0);
  assert.equal(formatMetric(0, "views"), "0");
  assert.equal(formatMetric(0, "estimatedRevenue", { language: "en" }), "$0.00");
  assert.equal(numberValue("-12.5"), -12.5);
});

test("the current UI language is the default of formatMetric and formatDay", () => {
  setLanguage("vi");
  assert.equal(formatMetric(1000, "views"), "1.000");
  assert.equal(formatDay("2026-10-27"), "27/10/2026");
  setLanguage("en");
  assert.equal(formatMetric(1000, "views"), "1,000");
  assert.equal(formatDay("2026-10-27"), "10/27/2026");
  assert.equal(formatDay("2026-10-27", "vi"), "27/10/2026");
  assert.equal(formatDay("not a day"), "");
});

test("schedule instants are pinned to GMT+7 in both languages, including legacy UTC timestamps", () => {
  assert.equal(formatScheduleDate("2026-10-21T01:00:00.000Z", "vi"), "21/10/2026 08:00 GMT+7");
  assert.equal(formatScheduleDate("2026-10-21T01:00:00.000Z", "en"), "10/21/2026 08:00 GMT+7");
  assert.equal(formatScheduleDate("2026-12-31T17:00:00Z", "vi"), "01/01/2027 00:00 GMT+7");
  assert.equal(formatScheduleDate("2026-10-21T08:00:00+07:00", "vi"), "21/10/2026 08:00 GMT+7");
  assert.equal(formatScheduleDate("2026-10-21 01:00:00", "vi"), "21/10/2026 08:00 GMT+7");
  assert.equal(formatScheduleDate("2026-10-21T01:00:00", "en"), "10/21/2026 08:00 GMT+7");
  assert.equal(formatScheduleDate(new Date("2026-10-21T01:00:00Z"), "en"), "10/21/2026 08:00 GMT+7");
  for (const value of [null, undefined, "", "invalid date"]) assert.equal(formatScheduleDate(value, "vi"), "");
});

test("calendar day helpers handle leap days and reject impossible dates", () => {
  assert.equal(isValidDay("2024-02-29"), true);
  assert.equal(isValidDay("2023-02-29"), false);
  assert.equal(isValidDay("2026-02-30"), false);
  assert.equal(isValidDay("2026-13-01"), false);
  assert.equal(isValidDay("2026-1-1"), false);
  assert.equal(isValidDay(20260101), false);
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2026-10-27", -27), "2026-09-30");
  assert.equal(addDays("2026-02-30", 1), "");
  assert.equal(dayDiff("2026-01-01", "2026-12-31"), 364);
  assert.equal(dayDiff("2024-02-28", "2024-03-01"), 2);
  assert.equal(dayDiff("2026-10-27", "2026-10-26"), -1);
  assert.equal(dayDiff("2026-02-30", "2026-03-01"), null);
});

test("filters round-trip through the URL search params; channels are omitted when all are selected", () => {
  const params = filtersToSearchParams(FILTERS);
  assert.deepEqual(params, { owner: "OWNER_A", start: "2026-09-01", end: "2026-09-30", scope: "self", channels: `${channel(1)},${channel(2)}` });
  assert.deepEqual(searchParamsToFilters(new URLSearchParams(params), { owners: OWNERS, ...CTX }), FILTERS);
  assert.deepEqual(searchParamsToFilters(params, { owners: OWNERS, ...CTX }), FILTERS);
  assert.equal("channels" in filtersToSearchParams({ ...FILTERS, channelIds: [] }), false);
  assert.deepEqual(filtersToSearchParams({ ownerId: "OWNER_A", startDate: "2026-02-30", endDate: "nope", scope: "evil", channelIds: ["bad"] }), { owner: "OWNER_A" });
});

test("hostile search params fall back to the whitelisted defaults", () => {
  const hostile = new URLSearchParams({
    owner: "<script>alert(1)</script>",
    start: "2026-02-30",
    end: "2026-13-01",
    scope: "evil",
    channels: `${channel(1)},nope,${channel(1)},UC<script>,${channel(2)}`
  });
  assert.deepEqual(searchParamsToFilters(hostile, { owners: OWNERS, ...CTX }), {
    ownerId: "OWNER_A",
    startDate: "2026-09-30",
    endDate: "2026-10-27",
    scope: "claimed",
    channelIds: [channel(1), channel(2)]
  });
  const context = { owners: OWNERS, ...CTX };
  const range = (start, end) => searchParamsToFilters({ owner: "OWNER_A", start, end }, context);
  assert.deepEqual(range("2026-10-01", "2026-10-30"), range(undefined, undefined), "end after latestAllowedDay");
  assert.deepEqual(range("2026-10-20", "2026-10-10"), range(undefined, undefined), "start after end");
  assert.deepEqual(range("2025-09-01", "2026-10-27"), range(undefined, undefined), "longer than 366 days");
  assert.deepEqual(range("2008-12-31", "2009-01-05"), range(undefined, undefined), "before 2009");
  assert.deepEqual(range("2025-10-27", "2026-10-27"), { ...range(undefined, undefined), startDate: "2025-10-27" }, "exactly 366 days");
  assert.equal(range("2026-10-01", "2026-10-29").endDate, "2026-10-29", "latestAllowedDay itself is allowed");
  assert.deepEqual(searchParamsToFilters({ owner: ["OWNER_B"], start: 20261001, end: { toString: () => "2026-10-02" } }, context), range(undefined, undefined));
  assert.deepEqual(searchParamsToFilters(null, context), range(undefined, undefined));
  const many = Array.from({ length: 250 }, (_, index) => channel(index)).join(",");
  assert.equal(searchParamsToFilters({ channels: many }, context).channelIds.length, 200);
});

test("the owner defaults to the first connected owner with the Analytics scope and its coverage sets the range end", () => {
  assert.equal(searchParamsToFilters({}, { owners: OWNERS, ...CTX }).ownerId, "OWNER_A");
  assert.equal(searchParamsToFilters({ owner: "OWNER_B" }, { owners: OWNERS, ...CTX }).ownerId, "OWNER_B", "an existing owner is kept even when disconnected");
  assert.equal(searchParamsToFilters({}, { owners: [OWNERS[1], { ownerId: "OWNER_C", authStatus: "connected" }], latestAllowedDay: "2026-10-29" }).ownerId, "OWNER_C");
  assert.equal(searchParamsToFilters({}, { owners: [OWNERS[1]], latestAllowedDay: "2026-10-29" }).ownerId, "OWNER_B");
  assert.equal(searchParamsToFilters({}, { owners: [], latestAllowedDay: "2026-10-29" }).ownerId, "");
  assert.equal(searchParamsToFilters({ owner: "OWNER_A" }, { owners: [], latestAllowedDay: "2026-10-29" }).ownerId, "", "unknown until the owners are loaded");
  // OWNER_A's coverage ends on 2026-10-27; OWNER_B has none, so its range ends at latestAllowedDay − lagDays.
  const a = searchParamsToFilters({ owner: "OWNER_A" }, { owners: OWNERS, latestAllowedDay: "2026-10-29", lagDays: 3 });
  assert.deepEqual([a.startDate, a.endDate], ["2026-09-30", "2026-10-27"]);
  const b = searchParamsToFilters({ owner: "OWNER_B" }, { owners: OWNERS, latestAllowedDay: "2026-10-29", lagDays: 3 });
  assert.deepEqual([b.startDate, b.endDate], ["2026-09-29", "2026-10-26"]);
  const explicit = searchParamsToFilters({ owner: "OWNER_A" }, { owners: OWNERS, latestDay: "2026-10-20", latestAllowedDay: "2026-10-29", lagDays: 3 });
  assert.deepEqual([explicit.startDate, explicit.endDate], ["2026-09-23", "2026-10-20"]);
});

test("date presets end at the latest stored day, respect month boundaries and keep leap days", () => {
  assert.deepEqual(presetRange("7", CTX), { startDate: "2026-10-21", endDate: "2026-10-27" });
  assert.deepEqual(presetRange("28", CTX), { startDate: "2026-09-30", endDate: "2026-10-27" });
  assert.deepEqual(presetRange("90", CTX), { startDate: "2026-07-30", endDate: "2026-10-27" });
  assert.deepEqual(presetRange("thisMonth", CTX), { startDate: "2026-10-01", endDate: "2026-10-27" });
  assert.deepEqual(presetRange("lastMonth", CTX), { startDate: "2026-09-01", endDate: "2026-09-30" });
  assert.deepEqual(presetRange("last12Months", CTX), { startDate: "2025-11-01", endDate: "2026-10-27" });
  assert.deepEqual(presetRange("thisMonth", { ...CTX, latestDay: "2026-01-01" }), { startDate: "2026-01-01", endDate: "2026-01-01" });
  assert.deepEqual(presetRange("lastMonth", { ...CTX, latestDay: "2026-01-05" }), { startDate: "2025-12-01", endDate: "2025-12-31" });
  assert.deepEqual(presetRange("last12Months", { ...CTX, latestDay: "2026-01-05" }), { startDate: "2025-02-01", endDate: "2026-01-05" });
  assert.deepEqual(presetRange("lastMonth", { latestDay: "2024-03-01", latestAllowedDay: "2024-03-05" }), { startDate: "2024-02-01", endDate: "2024-02-29" });
  assert.deepEqual(presetRange("2", { latestDay: "2024-03-01", latestAllowedDay: "2024-03-05" }), { startDate: "2024-02-29", endDate: "2024-03-01" });
  const leapYear = presetRange("last12Months", { latestDay: "2024-03-31", latestAllowedDay: "2024-04-02" });
  assert.deepEqual(leapYear, { startDate: "2023-04-01", endDate: "2024-03-31" });
  assert.equal(dayDiff(leapYear.startDate, leapYear.endDate) + 1, 366, "the longest preset still fits the 366-day limit");
  assert.deepEqual(presetRange("7", { latestAllowedDay: "2026-10-29", lagDays: 3 }), { startDate: "2026-10-20", endDate: "2026-10-26" }, "no coverage yet: latestAllowedDay − lagDays");
  assert.deepEqual(presetRange("7", { latestDay: "2026-11-05", latestAllowedDay: "2026-10-29", lagDays: 3 }), { startDate: "2026-10-20", endDate: "2026-10-26" }, "a latest day after latestAllowedDay is ignored");
  assert.equal(presetRange("custom", CTX), null);
  assert.equal(presetRange("0", CTX), null);
  assert.equal(presetRange("400", CTX), null);
  const fallback = presetRange("28", {});
  assert.equal(isValidDay(fallback.endDate) && fallback.endDate <= new Date().toISOString().slice(0, 10), true, "without context the range ends before PT today");
});

test("detectPreset recognises every preset and reports custom otherwise", () => {
  for (const { key } of DATE_PRESETS) {
    if (key === "custom") continue;
    assert.equal(detectPreset(presetRange(key, CTX), CTX), key);
  }
  assert.equal(detectPreset({ startDate: "2026-10-01", endDate: "2026-10-20" }, CTX), "custom");
  assert.equal(detectPreset(null, CTX), "custom");
  assert.deepEqual(DATE_PRESETS.map((preset) => preset.key), ["7", "28", "90", "thisMonth", "lastMonth", "last12Months", "custom"]);
});

test("estimateRequests mirrors the engine's counting and grows with revenue, breakdowns and channels", () => {
  assert.equal(estimateRequests({ days: 0, channelCount: 223 }), 0);
  assert.equal(estimateRequests({}), 0);
  const base = { days: 7, channelCount: 223, batch: 200, monetary: false, breakdowns: false, snapshots: false, scopes: ["claimed"] };
  // owner facts 1 + channel batches 7 × 2 + Data API pages 5
  assert.equal(estimateRequests(base), 20);
  assert.equal(estimateRequests({ ...base, monetary: true }), 35);
  assert.equal(estimateRequests({ ...base, breakdowns: true }), 42);
  assert.equal(estimateRequests({ ...base, breakdowns: true, snapshots: true }), 54);
  assert.equal(estimateRequests({ ...base, scopes: ["claimed", "self"] }), 21);
  assert.equal(estimateRequests({ ...base, channelCount: 0 }), 2);
  assert.equal(estimateRequests({ ...base, batch: 500 }), 13);
  const year = estimateRequests({ days: 366, channelCount: 223, batch: 200, monetary: true, breakdowns: true, snapshots: true, scopes: ["claimed"] });
  assert.ok(year > estimateRequests({ ...base, days: 90, monetary: true, breakdowns: true, snapshots: true }));
  assert.ok(year < 5000, "a year of the live owner stays under the default request cap");
});

test("buildSyncRequest downgrades overwrite and revenue to the caller's rights and clamps the range", () => {
  const limited = buildSyncRequest({ mode: "overwrite", monetary: true }, FILTERS, { canMonetary: false, canOverwrite: false });
  assert.deepEqual(limited, {
    kind: "full",
    mode: "append",
    ownerId: "OWNER_A",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    scopes: ["self"],
    channelMode: "selected",
    channelIds: [channel(1), channel(2)],
    includeBreakdowns: true,
    includeSnapshots: true,
    monetary: false
  });
  const admin = buildSyncRequest(
    { mode: "overwrite", startDate: "2025-01-01", endDate: "2026-10-27", channelMode: "none", includeSnapshots: false, scopes: ["claimed", "thirdParty", "bogus"], dryRun: true },
    FILTERS,
    { canMonetary: true, canOverwrite: true }
  );
  assert.deepEqual(admin, {
    kind: "full",
    mode: "overwrite",
    ownerId: "OWNER_A",
    startDate: "2025-10-27",
    endDate: "2026-10-27",
    scopes: ["claimed", "thirdParty"],
    channelMode: "none",
    channelIds: [],
    includeBreakdowns: true,
    includeSnapshots: false,
    monetary: true,
    dryRun: true
  });
  assert.equal(buildSyncRequest({ monetary: false }, FILTERS, { canMonetary: true }).monetary, false);
  assert.deepEqual(buildSyncRequest({ channelMode: "all" }, FILTERS, {}).channelIds, []);
  assert.equal(buildSyncRequest({ startDate: "2026-10-20", endDate: "2026-10-10" }, FILTERS, {}).startDate, "2026-09-01", "an inverted form range falls back to the filters");
  assert.equal(buildSyncRequest({}, { ...FILTERS, channelIds: [] }, {}).channelMode, "all");
});

test("buildFillMissingRequest spans the missing days, skips pending ones and is null when nothing is missing", () => {
  const coverage = { missing: ["2026-10-05", "2026-10-02", "2026-10-26", "2026-10-27"], pending: ["2026-10-26", "2026-10-27"] };
  assert.deepEqual(buildFillMissingRequest(FILTERS, { canMonetary: true }, coverage), {
    kind: "full",
    mode: "append",
    ownerId: "OWNER_A",
    startDate: "2026-10-02",
    endDate: "2026-10-05",
    scopes: ["self"],
    channelMode: "selected",
    channelIds: [channel(1), channel(2)],
    includeBreakdowns: true,
    includeSnapshots: false,
    monetary: true
  });
  assert.equal(buildFillMissingRequest(FILTERS, {}, { missing: [], pending: [] }), null);
  assert.equal(buildFillMissingRequest(FILTERS, {}, { missing: ["2026-10-27"], pending: ["2026-10-27"] }), null);
  assert.equal(buildFillMissingRequest(FILTERS, {}, null), null);
  const wide = buildFillMissingRequest({ ...FILTERS, channelIds: [], scope: "bogus" }, { canMonetary: false }, { missing: ["2024-01-01", "2026-10-05"] });
  assert.deepEqual([wide.startDate, wide.endDate, wide.channelMode, wide.scopes, wide.monetary], ["2025-10-05", "2026-10-05", "all", ["claimed"], false]);
});

test("foldText strips Vietnamese tones, đ and case for searching", () => {
  assert.equal(foldText("Đồng Bộ Kênh"), "dong bo kenh");
  assert.equal(foldText("  Việt   Nam "), "viet nam");
  assert.equal(foldText("UCxyz-ABC_123"), "ucxyz-abc_123");
  assert.equal(foldText(null), "");
});

test("downloadCsv writes a BOM, CRLF rows and formula-safe quoted cells, numbers as numbers", () => {
  const columns = [{ key: "day", label: "Day" }, { key: "title", label: "Title" }, { key: "views", label: "Views" }, { key: "share", label: "Share", value: (row) => (row.views ? row.views / 10 : "") }];
  const rows = [
    { day: "2026-10-01", title: "=HYPERLINK(\"http://x\")", views: 1234 },
    { day: "2026-10-02", title: "He said \"hi\"", views: null },
    { day: "2026-10-03", title: "+1 -2 @cmd", views: -12, extra: { nested: true } }
  ];
  const text = downloadCsv(columns, rows, "x.csv");
  const lines = text.split("\r\n");
  assert.equal(lines[0], "\uFEFF\"Day\",\"Title\",\"Views\",\"Share\"");
  assert.equal(lines[1], "\"2026-10-01\",\"'=HYPERLINK(\"\"http://x\"\")\",1234,123.4");
  assert.equal(lines[2], "\"2026-10-02\",\"He said \"\"hi\"\"\",,\"\"");
  assert.equal(lines[3], "\"2026-10-03\",\"'+1 -2 @cmd\",-12,-1.2");
  assert.equal(lines[4], "");
  const hostile = downloadCsv([{ key: "v", label: "V" }], [{ v: "-12" }, { v: "\tx" }, { v: " =1" }, { v: "@cmd" }, { v: { nested: 1 } }, { v: true }], "h.csv").split("\r\n");
  // Objects are never serialised (empty cell like null); booleans are bare words.
  assert.deepEqual(hostile.slice(1, 7), ["\"'-12\"", "\"'\tx\"", "\"' =1\"", "\"'@cmd\"", "", "true"]);
});

test("percentChange is null without a usable previous value", () => {
  assert.equal(percentChange(110, 100), 10);
  assert.equal(percentChange(90, 100), -10);
  assert.equal(percentChange(-50, -100), 50);
  assert.equal(percentChange(5, 0), null);
  assert.equal(percentChange(null, 5), null);
  assert.equal(percentChange("12", "10"), 20);
});

test("labels are canonical English keys with Vietnamese entries and localised country names", () => {
  assert.equal(metricLabel("views"), "Views");
  assert.equal(metricLabel("madeUp"), "madeUp");
  assert.equal(reportLabel("videos"), "Top videos");
  assert.equal(reportLabel({ id: "demographics" }), "Age & gender");
  assert.equal(dimensionLabel("deviceType"), "Device type");
  assert.equal(dimensionValueLabel("MOBILE", "deviceType"), "Mobile");
  assert.equal(dimensionValueLabel("TV", "deviceType"), "TV");
  assert.equal(dimensionValueLabel("SHORTS_CONTENT_LINKS", "insightTrafficSourceType"), "Shorts content links");
  assert.equal(dimensionValueLabel("SOME_NEW_VALUE", "insightTrafficSourceType"), "Some new value");
  assert.equal(dimensionValueLabel("auctionDisplay", "adType"), "Auction display");
  assert.equal(dimensionValueLabel("age18-24", "ageGroup"), "18–24");
  assert.equal(dimensionValueLabel("age65-", "ageGroup"), "65+");
  assert.equal(dimensionValueLabel("claimed", "scope"), "Claimed content");
  assert.equal(dimensionValueLabel("", "deviceType"), "—");
  setLanguage("vi");
  assert.equal(dimensionValueLabel("VN", "country"), "Việt Nam");
  assert.equal(dimensionValueLabel("2026-10-27", "day"), "27/10/2026");
  setLanguage("en");
  assert.equal(dimensionValueLabel("VN", "country"), "Vietnam");
  assert.equal(dimensionValueLabel("123", "country"), "123", "an impossible code falls back to itself");
  assert.equal(STATUS_META.ready.tone, "emerald");
  assert.equal(STATUS_META.partial.tone, "amber");
  assert.equal(STATUS_META.running.tone, "blue");
  assert.equal(STATUS_META["not-run"].tone, "slate");
  assert.equal(STATUS_META.failed.tone, "red");
  assert.ok(Object.values(STATUS_META).every((meta) => typeof meta.label === "string" && ["emerald", "amber", "blue", "slate", "red"].includes(meta.tone)));
  // The canonical labels resolve to the Vietnamese dictionary entries.
  assert.equal(translate(STATUS_META.completed.label, null, "vi"), "Hoàn tất");
  assert.equal(translate(metricLabel("views"), null, "vi"), "Lượt xem");
  assert.equal(translate(reportLabel("videos"), null, "vi"), "Video nổi bật");
});

test("countDays prefers the true totals of a job result over the capped day arrays", () => {
  const capped = Array.from({ length: 100 }, (_, index) => addDays("2026-01-01", index));
  const days = { requested: 366, covered: 366, added: capped, addedCount: 293, drifted: capped.slice(0, 20), driftedCount: 150 };
  assert.equal(countDays(days), 293);
  assert.equal(countDays(days, "added"), 293);
  assert.equal(countDays(days, "drifted"), 150);
  assert.equal(countDays({ added: ["2026-10-21", "2026-10-22"] }), 2, "no addedCount: the array length");
  assert.equal(countDays({ drifted: ["2026-10-21"] }, "drifted"), 1);
  assert.equal(countDays({ addedCount: 0, added: capped }), 0, "a zero total wins over a stale array");
  assert.equal(countDays(capped), 100);
  assert.equal(countDays(7), 7);
  assert.equal(countDays("12"), 12);
  for (const value of [null, undefined, "", NaN, -3, {}, { addedCount: null }]) assert.equal(countDays(value), 0);
});

test("a single selected channel travels as channelId for snapshot exports but never for owner-scope types", () => {
  const one = [channel(1)];
  for (const type of ["breakdown", "top-videos", "video-revenue", "demographics", "coverage", "history"]) {
    assert.equal(exportChannelId(type, one), channel(1), type);
    assert.equal(exportChannelId(type, [channel(1), channel(2)]), undefined, `${type} with two channels`);
    assert.equal(exportChannelId(type, []), undefined, `${type} with all channels`);
  }
  for (const type of ["overview", "daily", "channels", "channel-days", "revenue"]) assert.equal(exportChannelId(type, one), undefined, type);
  assert.equal(exportChannelId("channel-days", one, channel(9)), channel(9), "an explicit channelId (channel detail) always wins");
  assert.equal(exportChannelId("breakdown", `${channel(1)}`), channel(1), "a csv string is parsed");
  const options = { canMonetary: true, channelId: null };
  const snapshot = EXPORTS_BY_VIEW.audience.find((option) => option.type === "breakdown");
  assert.equal(exportOptionAvailable(snapshot, { ...options, channelCount: 1 }), true);
  assert.equal(exportOptionAvailable(snapshot, { ...options, channelCount: 2 }), false, "several channels: hidden like the panels");
  assert.equal(exportOptionAvailable(EXPORTS_BY_VIEW.content.find((option) => option.type === "top-videos"), { ...options, channelCount: 3 }), false);
  assert.equal(exportOptionAvailable(EXPORTS_BY_VIEW.audience.find((option) => option.type === "demographics"), { ...options, channelCount: 2 }), false);
  assert.equal(exportOptionAvailable(EXPORTS_BY_VIEW.channels[0], { ...options, channelCount: 5 }), true, "owner-scope exports stay");
  assert.equal(exportOptionAvailable(EXPORTS_BY_VIEW.sync.find((option) => option.type === "coverage"), { ...options, channelCount: 5 }), false, "coverage is a single-entity export");
  assert.equal(exportOptionAvailable(EXPORTS_BY_VIEW.sync.find((option) => option.type === "history"), { ...options, channelCount: 5 }), true, "the ledger export stays");
  assert.equal(exportOptionAvailable(EXPORTS_BY_VIEW.revenue[0], { canMonetary: false, channelCount: 0 }), false, "monetary needs canMonetary");
  assert.equal(exportOptionAvailable(EXPORTS_BY_VIEW.channelDetail[0], { canMonetary: true, channelId: null, channelCount: 0 }), false, "channel options need a channelId");
  assert.equal(exportOptionAvailable(EXPORTS_BY_VIEW.channelDetail[0], { canMonetary: true, channelId: channel(1), channelCount: 0 }), true);
  assert.equal(exportOptionAvailable(null, options), false);
});

test("isRangeFallback flags a shared link whose range the whitelist replaced", () => {
  const context = { owners: OWNERS, ...CTX };
  const good = new URLSearchParams({ owner: "OWNER_A", start: "2026-10-01", end: "2026-10-20" });
  assert.equal(isRangeFallback(good, searchParamsToFilters(good, context)), false);
  const late = new URLSearchParams({ owner: "OWNER_A", start: "2026-10-01", end: "2026-10-31" });
  assert.equal(isRangeFallback(late, searchParamsToFilters(late, context)), true, "end after latestAllowedDay");
  const typo = { owner: "OWNER_A", start: "2026-02-30", end: "2026-03-10" };
  assert.equal(isRangeFallback(typo, searchParamsToFilters(typo, context)), true, "impossible day");
  const half = new URLSearchParams({ owner: "OWNER_A", end: "2026-10-20" });
  assert.equal(isRangeFallback(half, searchParamsToFilters(half, context)), true, "end without start");
  const none = new URLSearchParams({ owner: "OWNER_A", channels: channel(1) });
  assert.equal(isRangeFallback(none, searchParamsToFilters(none, context)), false, "no range in the link: the default is not a fallback");
  assert.equal(isRangeFallback(null, searchParamsToFilters(null, context)), false);
});

test("isRangeBehind / rangeEndingAt move a stale range to the latest stored day without changing its length", () => {
  const filters = { startDate: "2026-09-30", endDate: "2026-10-27" };
  assert.equal(isRangeBehind(filters, "2026-10-28"), true);
  assert.equal(isRangeBehind(filters, "2026-10-27"), false);
  assert.equal(isRangeBehind(filters, "2026-10-20"), false, "a range beyond the latest day is not behind");
  assert.equal(isRangeBehind(filters, null), false);
  assert.equal(isRangeBehind({ startDate: "2026-09-30", endDate: "nope" }, "2026-10-28"), false);
  assert.deepEqual(rangeEndingAt(filters, "2026-10-29"), { startDate: "2026-10-02", endDate: "2026-10-29" });
  assert.deepEqual(rangeEndingAt({ startDate: "2026-10-27", endDate: "2026-10-27" }, "2026-10-29"), { startDate: "2026-10-29", endDate: "2026-10-29" });
  assert.deepEqual(rangeEndingAt({ startDate: "2026-10-27", endDate: "2026-10-01" }, "2026-10-29"), presetRange("28", { latestDay: "2026-10-29", latestAllowedDay: "2026-10-29" }), "an inverted range falls back to the 28-day preset");
  assert.deepEqual(rangeEndingAt({ startDate: "2009-01-01", endDate: "2009-01-10" }, "2009-01-05"), { startDate: "2009-01-01", endDate: "2009-01-05" }, "never before 2009");
  assert.equal(rangeEndingAt(filters, "2026-13-01"), null);
});

test("known OAuth reasons of a disconnected CMS map to one sentence each; unknown ones stay raw", () => {
  assert.equal(oauthReasonMessage("invalid_grant: Token has been expired or revoked."), "The CMS authorisation expired or was revoked; reconnect it in Settings > Network.");
  assert.equal(oauthReasonMessage({ message: "unauthorized_client" }), "The OAuth client is not allowed to use this CMS account; check the OAuth client in Settings > Network.");
  assert.equal(oauthReasonMessage("Error: invalid_client (The OAuth client was not found.)"), "The OAuth client ID or secret is invalid; check the OAuth client in Settings > Network.");
  assert.equal(oauthReasonMessage("Network unreachable"), null);
  assert.equal(oauthReasonMessage(""), null);
  assert.equal(oauthReasonMessage(null), null);
  assert.equal(translate(oauthReasonMessage("invalid_grant"), null, "vi"), "Ủy quyền CMS đã hết hạn hoặc bị thu hồi; hãy ủy quyền lại trong Cài đặt > Network.");
});

test("pacificToday is the calendar day in Los Angeles", () => {
  assert.equal(pacificToday(new Date("2026-10-30T06:59:00Z")), "2026-10-29", "before PT midnight (UTC−7 in October)");
  assert.equal(pacificToday(new Date("2026-10-30T07:01:00Z")), "2026-10-30");
  assert.equal(pacificToday(new Date("2026-12-31T08:30:00Z")), "2026-12-31", "UTC−8 in winter");
  assert.match(pacificToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test("sections and export options carry the role flags the views filter on", () => {
  assert.deepEqual(ANALYTICS_SECTIONS.map((section) => section.key), ["overview", "channels", "content", "audience", "revenue", "explorer", "sync"]);
  assert.equal(ANALYTICS_SECTIONS.filter((section) => section.monetary).map((section) => section.key).join(), "revenue");
  assert.ok(ANALYTICS_SECTIONS.every((section) => typeof section.icon === "object" && section.path === section.key && section.label));
  for (const [view, options] of Object.entries(EXPORTS_BY_VIEW)) {
    const keys = options.map((option) => option.key);
    assert.equal(new Set(keys).size, keys.length, `${view} export keys are unique`);
    assert.ok(options.every((option) => ["csv", "xlsx"].includes(option.format) && option.type && option.label));
  }
  assert.ok(EXPORTS_BY_VIEW.revenue.every((option) => option.monetary));
  assert.ok(EXPORTS_BY_VIEW.content.find((option) => option.type === "video-revenue").monetary);
  assert.ok(EXPORTS_BY_VIEW.channelDetail.every((option) => option.channel));
  assert.deepEqual(EXPORTS_BY_VIEW.overview.map((option) => `${option.type}:${option.format}`), ["overview:xlsx", "daily:csv", "daily:xlsx"]);
  assert.deepEqual(EXPORTS_BY_VIEW.audience.filter((option) => option.type === "breakdown").map((option) => option.dimension), ["country", "insightTrafficSourceType", "deviceType", "operatingSystem", "subscribedStatus", "sharingService"]);
  assert.deepEqual(EXPORTS_BY_VIEW.explorer, []);
});
