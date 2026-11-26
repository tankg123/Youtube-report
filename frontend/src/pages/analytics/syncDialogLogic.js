// Pure logic of the Sync-all dialog (no React, node-testable through tests/analyticsSyncDialog.test.mjs): the
// initial form, the submit-blocking predicate behind "Sync all asks before overwriting", the fetch end of the default
// range and the number of stored days an overwrite replaces. SyncDialog.jsx renders these; nothing here touches the DOM.
import { addDays, dayDiff, isValidDay, presetRange } from "./analyticsUtils.js";

const MAX_RANGE_DAYS = 366;
export const SYNC_CHANNEL_MODES = Object.freeze(["all", "selected", "none"]);

// The newest day a sync can fetch: latestAllowedDay − lagDays (the dialog's own presets end there when the owner has
// no stored data). A default range never stops at the stored latestDay, which would exclude the "newer days not yet
// synced" the Overview reports.
export function fetchEndDay(context = {}) {
  return presetRange("1", { latestAllowedDay: context.latestAllowedDay, lagDays: context.lagDays })?.endDate || "";
}

// The filters' range with its end extended to fetchEndDay(context) (never shortened), clamped to 366 days from the end.
function defaultRange(filters = {}, context = {}) {
  const { startDate, endDate } = filters;
  const fetchEnd = fetchEndDay(context);
  if (!isValidDay(startDate) || !isValidDay(endDate) || !isValidDay(fetchEnd) || fetchEnd <= endDate) return { startDate, endDate };
  return { startDate: dayDiff(startDate, fetchEnd) >= MAX_RANGE_DAYS ? addDays(fetchEnd, 1 - MAX_RANGE_DAYS) : startDate, endDate: fetchEnd };
}

// initialSyncForm(options, filters, permissions, { latestAllowedDay, lagDays }): append is the default for everyone
// (an explicit options.mode "overwrite" is honoured only with canOverwrite) and the confirmation starts unchecked, so
// an overwrite always needs the user's consent. The range comes from explicit options, else from the filters via
// defaultRange(); channels, breakdowns, snapshots and revenue mirror the options with the filters as the fallback.
export function initialSyncForm(options = {}, filters = {}, permissions = {}, context = {}) {
  const opts = options || {};
  const customRange = isValidDay(opts.startDate) && isValidDay(opts.endDate) && opts.startDate <= opts.endDate;
  const channelIds = Array.isArray(opts.channelIds) ? opts.channelIds : Array.isArray(filters.channelIds) ? filters.channelIds : [];
  const range = customRange ? { startDate: opts.startDate, endDate: opts.endDate } : defaultRange(filters, context);
  return {
    mode: opts.mode === "overwrite" && permissions.canOverwrite ? "overwrite" : "append",
    startDate: range.startDate,
    endDate: range.endDate,
    channelMode: SYNC_CHANNEL_MODES.includes(opts.channelMode) ? opts.channelMode : channelIds.length ? "selected" : "all",
    channelIds,
    includeBreakdowns: opts.includeBreakdowns !== false,
    includeSnapshots: opts.includeSnapshots !== false,
    monetary: Boolean(permissions.canMonetary) && opts.monetary !== false,
    confirmed: false
  };
}

// Days after `endDate` a sync could still fetch (0 when the range reaches fetchEndDay or the inputs are not days).
export function newerDaysOutside(endDate, context = {}) {
  const diff = dayDiff(endDate, fetchEndDay(context));
  return diff === null ? 0 : Math.max(0, diff);
}

// isSyncSubmitBlocked({ syncing, connected, overCap, needsChannels, dayCount, form }): the footer button stays disabled
// while a sync starts, without a CMS connection, above the request cap, with "selected" and no channel, with an empty
// range, and — the overwrite gate — until the consent checkbox is ticked in overwrite mode.
export function isSyncSubmitBlocked({ syncing = false, connected = true, overCap = false, needsChannels = false, dayCount = 0, form = {} } = {}) {
  const overwrite = form?.mode === "overwrite";
  return Boolean(syncing || !connected || overCap || needsChannels || !(Number(dayCount) >= 1) || (overwrite && !form?.confirmed));
}

// overwriteDayCount(plan, dayCount): the stored days an overwrite replaces = plan.days.requested − plan.days.missingFacts
// of the dry-run plan (missingFacts = days without owner facts, or without revenue when revenue is requested); the
// range length only while the plan is loading or carries no day summary.
export function overwriteDayCount(plan, dayCount) {
  const stored = Number(plan?.days?.storedFacts);
  if (plan?.days && Number.isFinite(stored)) return Math.max(0, stored);
  const requested = Number(plan?.days?.requested);
  const missing = Number(plan?.days?.missingFacts);
  if (plan?.days && Number.isFinite(requested) && Number.isFinite(missing)) return Math.max(0, requested - missing);
  return Math.max(0, Math.trunc(Number(dayCount) || 0));
}
