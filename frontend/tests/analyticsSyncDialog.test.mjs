import test from "node:test";
import assert from "node:assert/strict";
import { buildSyncRequest } from "../src/pages/analytics/analyticsUtils.js";
import { fetchEndDay, initialSyncForm, isSyncSubmitBlocked, newerDaysOutside, overwriteDayCount } from "../src/pages/analytics/syncDialogLogic.js";

// The "Sync all asks before overwriting" gate (user requirement 2): the dialog opens in append mode for everyone,
// an overwrite needs canOverwrite plus the consent checkbox, and the default range reaches the newest fetchable day.

const CONTEXT = { latestAllowedDay: "2026-10-29", lagDays: 3 }; // fetch end 2026-10-26
const channel = (suffix) => `UC${String(suffix).padStart(22, "x")}`;
const FILTERS = { ownerId: "OWNER_A", startDate: "2026-09-23", endDate: "2026-10-20", scope: "claimed", channelIds: [] };
const ADMIN = { canOverwrite: true, canMonetary: true };
const BASE = { syncing: false, connected: true, overCap: false, needsChannels: false, dayCount: 28 };

test("the dialog opens in append mode with the confirmation unchecked, even for users who may overwrite", () => {
  const admin = initialSyncForm({}, FILTERS, ADMIN, CONTEXT);
  assert.equal(admin.mode, "append");
  assert.equal(admin.confirmed, false);
  assert.equal(admin.monetary, true);
  assert.equal(initialSyncForm(null, FILTERS, ADMIN, CONTEXT).mode, "append");
  // An explicit overwrite request is honoured only with canOverwrite, and still starts unconfirmed.
  const requested = initialSyncForm({ mode: "overwrite" }, FILTERS, ADMIN, CONTEXT);
  assert.equal(requested.mode, "overwrite");
  assert.equal(requested.confirmed, false);
  assert.equal(initialSyncForm({ mode: "overwrite" }, FILTERS, { canOverwrite: false, canMonetary: true }, CONTEXT).mode, "append");
  // buildSyncRequest downgrades the same way, so the POST body can never overwrite without the right.
  assert.equal(buildSyncRequest({}, FILTERS, ADMIN).mode, "append");
  assert.equal(buildSyncRequest({ mode: "overwrite" }, FILTERS, {}).mode, "append");
  assert.equal(buildSyncRequest({ mode: "overwrite" }, FILTERS, ADMIN).mode, "overwrite");
});

test("the default range ends at latestAllowedDay − lagDays so append fetches the newer days the page calls missing", () => {
  assert.equal(fetchEndDay(CONTEXT), "2026-10-26");
  const form = initialSyncForm({}, FILTERS, ADMIN, CONTEXT);
  assert.deepEqual([form.startDate, form.endDate], ["2026-09-23", "2026-10-26"], "the end is extended, the start kept");
  assert.equal(newerDaysOutside(form.endDate, CONTEXT), 0);
  // A filter range that already reaches (or passes) the fetch end is kept as it is.
  const reaching = initialSyncForm({}, { ...FILTERS, endDate: "2026-10-26" }, ADMIN, CONTEXT);
  assert.deepEqual([reaching.startDate, reaching.endDate], ["2026-09-23", "2026-10-26"]);
  const later = initialSyncForm({}, { ...FILTERS, endDate: "2026-10-29" }, ADMIN, CONTEXT);
  assert.equal(later.endDate, "2026-10-29");
  // Extending the end never produces a range above 366 days: the start moves instead.
  const year = initialSyncForm({}, { ...FILTERS, startDate: "2025-10-24", endDate: "2026-10-20" }, ADMIN, CONTEXT);
  assert.deepEqual([year.startDate, year.endDate], ["2025-10-26", "2026-10-26"]);
  // Explicit options win over the filters and are not extended.
  const explicit = initialSyncForm({ startDate: "2026-09-01", endDate: "2026-09-30" }, FILTERS, ADMIN, CONTEXT);
  assert.deepEqual([explicit.startDate, explicit.endDate], ["2026-09-01", "2026-09-30"]);
  assert.equal(newerDaysOutside("2026-09-30", CONTEXT), 26, "the hint counts the fetchable days the range excludes");
  assert.equal(newerDaysOutside("2026-10-28", CONTEXT), 0);
  assert.equal(newerDaysOutside("nope", CONTEXT), 0);
  // Without a bootstrap the context is empty: the range still ends on a calendar day, never after the filters' end.
  const noContext = initialSyncForm({}, FILTERS, ADMIN, {});
  assert.ok(noContext.endDate >= FILTERS.endDate && /^\d{4}-\d{2}-\d{2}$/.test(noContext.endDate));
  // Invalid filter days pass through untouched (buildSyncRequest falls back to the filters later).
  assert.deepEqual(initialSyncForm({}, { ...FILTERS, startDate: "2026-02-30" }, ADMIN, CONTEXT).startDate, "2026-02-30");
});

test("channel, breakdown, snapshot and revenue options mirror the opener with the filters as the fallback", () => {
  const selected = initialSyncForm({}, { ...FILTERS, channelIds: [channel(1)] }, ADMIN, CONTEXT);
  assert.equal(selected.channelMode, "selected");
  assert.deepEqual(selected.channelIds, [channel(1)]);
  const none = initialSyncForm({ channelMode: "none", includeBreakdowns: false, includeSnapshots: false, monetary: false }, FILTERS, ADMIN, CONTEXT);
  assert.deepEqual([none.channelMode, none.includeBreakdowns, none.includeSnapshots, none.monetary], ["none", false, false, false]);
  assert.equal(initialSyncForm({ channelMode: "bogus" }, FILTERS, ADMIN, CONTEXT).channelMode, "all");
  assert.equal(initialSyncForm({}, FILTERS, { canOverwrite: true, canMonetary: false }, CONTEXT).monetary, false, "revenue needs canMonetary");
});

test("submit is blocked until an overwrite is confirmed, and by over-cap, missing channels, a dead CMS or an empty range", () => {
  assert.equal(isSyncSubmitBlocked({ ...BASE, form: { mode: "append", confirmed: false } }), false);
  assert.equal(isSyncSubmitBlocked({ ...BASE, form: { mode: "overwrite", confirmed: false } }), true, "the overwrite gate");
  assert.equal(isSyncSubmitBlocked({ ...BASE, form: { mode: "overwrite", confirmed: true } }), false);
  assert.equal(isSyncSubmitBlocked({ ...BASE, overCap: true, form: { mode: "append" } }), true);
  assert.equal(isSyncSubmitBlocked({ ...BASE, needsChannels: true, form: { mode: "append" } }), true);
  assert.equal(isSyncSubmitBlocked({ ...BASE, connected: false, form: { mode: "append" } }), true);
  assert.equal(isSyncSubmitBlocked({ ...BASE, syncing: true, form: { mode: "append" } }), true);
  assert.equal(isSyncSubmitBlocked({ ...BASE, dayCount: 0, form: { mode: "append" } }), true);
  assert.equal(isSyncSubmitBlocked({ ...BASE, dayCount: null, form: { mode: "append" } }), true);
  assert.equal(isSyncSubmitBlocked({ form: { mode: "overwrite", confirmed: true } }), true, "no range yet");
  assert.equal(isSyncSubmitBlocked(), true);
});

test("the Overwrite button counts the stored days of the dry-run plan, with the range length only while it loads", () => {
  assert.equal(overwriteDayCount({ days: { requested: 90, missingFacts: 80 } }, 90), 10);
  assert.equal(overwriteDayCount({ days: { requested: 90, missingFacts: 80, storedFacts: 12 } }, 90), 12, "storedFacts (days with facts) wins when the plan carries it");
  assert.equal(overwriteDayCount({ days: { requested: 28, missingFacts: 0 } }, 28), 28);
  assert.equal(overwriteDayCount({ days: { requested: 5, missingFacts: 9 } }, 5), 0, "never negative");
  assert.equal(overwriteDayCount(null, 90), 90);
  assert.equal(overwriteDayCount({ requests: { estimate: 12 } }, 90), 90, "a plan without a day summary");
  assert.equal(overwriteDayCount({ days: { requested: 90 } }, 90), 90, "missingFacts absent");
  assert.equal(overwriteDayCount(null, -3), 0);
  assert.equal(overwriteDayCount(null, "x"), 0);
});
