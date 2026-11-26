// Allow-lists and query validation for the Analytics read routes. Every value reaching SQL is either bound as a
// parameter or taken from one of these lists; Express 5 can hand a route an array for a repeated query key, so
// each reader insists on one string. Messages are English; the UI translates them.
const { BREAKDOWN_DIMENSIONS } = require("./analyticsCatalog");

const DAY = 86400000;
const SCOPES = Object.freeze(["claimed", "self", "thirdParty"]);
const EXPORT_TYPES = Object.freeze(["overview", "daily", "channels", "channel-days", "breakdown", "top-videos", "video-revenue", "demographics", "revenue", "coverage", "history"]);
const EXPORT_FORMATS = Object.freeze(["csv", "xlsx"]);
const LANGUAGES = Object.freeze(["en", "vi"]);
const CHANNEL_STATUSES = Object.freeze(["ready", "partial", "missing"]);
const CHANNEL_SORT_KEYS = Object.freeze(["title", "country", "publishedAt", "subscribersTotal", "lifetimeViews", "videoCount", "coveredDays", "daysWithRows", "firstDay", "lastDay",
  "views", "engagedViews", "estimatedMinutesWatched", "watchHours", "averageViewDuration", "likes", "comments", "shares", "subscribersGained", "subscribersLost", "netSubscribers",
  "estimatedRevenue", "estimatedAdRevenue", "grossRevenue", "monetizedPlaybacks", "adImpressions", "cpm", "playbackBasedCpm", "rpm"]);
const DIMENSION_KEYS = Object.freeze(BREAKDOWN_DIMENSIONS.map((entry) => entry.key));
const MONETARY_DIMENSIONS = new Set(BREAKDOWN_DIMENSIONS.filter((entry) => entry.monetary).map((entry) => entry.key));
const LIMITS = Object.freeze({ maxDays: 366, maxChannelIds: 200, maxExportRows: 100000, maxWorkbookRows: 50000, interactiveRows: 100000, topVideos: 200,
  maxPageSize: 200, maxHistoryLimit: 1000, maxSearchLength: 200, minDay: "2009-01-01" });
const CHANNEL_ID = /^UC[\w-]{22}$/;
const ENTITY_KEY = /^(owner:(claimed|self|thirdParty)|channel:UC[\w-]{22})$/;
const MONETARY_MESSAGE = "Your role cannot access Analytics revenue.";

function fail(message, status = 400, reason = "invalidRequest") {
  const error = new Error(message); error.status = status; error.reason = reason; return error;
}
function single(query, name) {
  const value = query?.[name];
  if (value == null) return undefined;
  if (typeof value !== "string") throw fail(`${name} must be a single value.`);
  return value.trim();
}
function oneOf(query, name, allowed, fallback) {
  const value = single(query, name);
  if (!value) return fallback;
  if (!allowed.includes(value)) throw fail(`${name} must be one of: ${allowed.join(", ")}.`);
  return value;
}
function dateString(value, field) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw fail(`${field} must use YYYY-MM-DD.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw fail(`${field} is not a valid date.`);
  return text;
}
function dateRange(query, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const startDate = dateString(single(query, "startDate"), "startDate");
  const endDate = dateString(single(query, "endDate"), "endDate");
  if (startDate < LIMITS.minDay || endDate > today) throw fail("Dates must be between 2009-01-01 and today.");
  if (startDate > endDate) throw fail("startDate must not be after endDate.");
  const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY) + 1;
  if (days > LIMITS.maxDays) throw fail("Date range must contain between 1 and 366 days.");
  return { startDate, endDate, days };
}
function day(query, name) {
  const value = single(query, name);
  return value ? dateString(value, name) : null;
}
// Optional day bounds for the ledger (either side may be absent); the range routes keep the stricter dateRange rules.
function optionalRange(query) {
  const startDate = day(query, "startDate"); const endDate = day(query, "endDate");
  if (startDate && endDate && startDate > endDate) throw fail("startDate must not be after endDate.");
  return { startDate, endDate };
}
const scope = (query) => oneOf(query, "scope", SCOPES, "claimed");
function channelId(value, { required = true } = {}) {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : null;
  if (text === null) throw fail("channelId must be a single value.");
  if (!text) { if (required) throw fail("Invalid YouTube channel ID."); return ""; }
  if (!CHANNEL_ID.test(text)) throw fail("Invalid YouTube channel ID.");
  return text;
}
// GET csv list; unknown IDs are reported back instead of rejected so a stale URL still renders.
function channelIds(query, known) {
  const raw = single(query, "channelIds");
  const list = raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : [];
  if (list.length > LIMITS.maxChannelIds) throw fail(`Select at most ${LIMITS.maxChannelIds} channels.`);
  const unique = [...new Set(list)];
  for (const id of unique) if (!CHANNEL_ID.test(id)) throw fail("Invalid YouTube channel ID.");
  return { channelIds: unique.filter((id) => known.has(id)), unknownChannelIds: unique.filter((id) => !known.has(id)) };
}
function dimension(query, { canMonetary = false, required = true } = {}) {
  const value = single(query, "dimension");
  if (!value) { if (required) throw fail(`dimension must be one of: ${DIMENSION_KEYS.join(", ")}.`); return null; }
  if (!DIMENSION_KEYS.includes(value)) throw fail(`dimension must be one of: ${DIMENSION_KEYS.join(", ")}.`);
  if (MONETARY_DIMENSIONS.has(value) && !canMonetary) throw fail(MONETARY_MESSAGE, 403, "forbidden");
  return value;
}
function exportType(query) {
  const value = oneOf(query, "type", EXPORT_TYPES, null);
  if (!value) throw fail(`type must be one of: ${EXPORT_TYPES.join(", ")}.`);
  return value;
}
const exportFormat = (query) => oneOf(query, "format", EXPORT_FORMATS, "csv");
const language = (query) => oneOf(query, "lang", LANGUAGES, "en");
const channelStatus = (query) => oneOf(query, "status", CHANNEL_STATUSES, null);
function integer(query, name, { min, max, fallback }) {
  const value = single(query, name);
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw fail(`${name} must be an integer between ${min} and ${max}.`);
  return number;
}
function search(query) {
  const value = single(query, "search") || "";
  if (value.length > LIMITS.maxSearchLength) throw fail(`search must be at most ${LIMITS.maxSearchLength} characters.`);
  return value;
}
function country(query) {
  const value = single(query, "country");
  if (!value) return null;
  if (!/^[A-Za-z]{2}$/.test(value)) throw fail("country must use a two-letter ISO country code.");
  return value.toUpperCase();
}
// `sort=views` or `sort=-views`; `direction=asc|desc` overrides; metrics default to desc, text columns to asc.
function sort(query, { canMonetary = false, monetaryKeys = new Set(), textKeys = new Set() } = {}) {
  const raw = single(query, "sort") || "";
  const descending = raw.startsWith("-");
  const key = raw.replace(/^-/, "") || "title";
  if (!CHANNEL_SORT_KEYS.includes(key)) throw fail(`sort must be one of: ${CHANNEL_SORT_KEYS.join(", ")}.`);
  if (monetaryKeys.has(key) && !canMonetary) throw fail(MONETARY_MESSAGE, 403, "forbidden");
  const direction = oneOf(query, "direction", ["asc", "desc"], descending ? "desc" : textKeys.has(key) ? "asc" : "desc");
  return { key, direction };
}
function entityKey(query) {
  const value = single(query, "entityKey");
  if (!value) return null;
  if (!ENTITY_KEY.test(value)) throw fail("Invalid entity key.");
  return value;
}
function boolean(query, name, fallback) {
  const value = single(query, name);
  if (!value) return fallback;
  if (["true", "1"].includes(value)) return true;
  if (["false", "0"].includes(value)) return false;
  throw fail(`${name} must be true or false.`);
}
function reportId(query) {
  const value = single(query, "reportId");
  if (!value) return null;
  if (!/^[A-Za-z]{1,40}$/.test(value)) throw fail("Unknown catalog report.", 404, "notFound");
  return value;
}
function videoId(query) {
  const value = single(query, "videoId");
  if (!value) return "";
  if (!/^[\w-]{11}$/.test(value)) throw fail("Invalid YouTube video ID.");
  return value;
}
module.exports = { SCOPES, EXPORT_TYPES, EXPORT_FORMATS, LANGUAGES, CHANNEL_STATUSES, CHANNEL_SORT_KEYS, DIMENSION_KEYS, LIMITS, MONETARY_MESSAGE, fail, single, oneOf,
  dateString, dateRange, day, optionalRange, scope, channelId, channelIds, dimension, exportType, exportFormat, language, channelStatus, integer, search, country, sort, entityKey, boolean, reportId, videoId };
