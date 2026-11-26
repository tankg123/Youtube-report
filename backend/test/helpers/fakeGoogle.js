// Deterministic stand-in for the YouTube Analytics API v2 and the Data API v3, routed over axios `options.params`
// (dimensions / filters / startDate / endDate / metrics / sort / startIndex / maxResults -> columnHeaders + rows), plus
// `installAnalyticsHarness` which prepares a temp analytics DB and the credential/database stubs before any require.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DAY = 86400000;
const EPOCH = "2026-01-01";
const MONEY = new Set(["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "grossRevenue", "monetizedPlaybacks", "playbackBasedCpm", "adImpressions", "cpm"]);
const NON_ADDITIVE = new Set(["averageViewDuration", "averageViewPercentage", "cpm", "playbackBasedCpm", "viewerPercentage"]);
const DIMENSION_VALUES = {
  deviceType: ["MOBILE", "DESKTOP", "TV", "TABLET"], operatingSystem: ["ANDROID", "IOS", "WINDOWS"], insightTrafficSourceType: ["YT_SEARCH", "RELATED_VIDEO", "EXT_URL"],
  insightPlaybackLocationType: ["WATCH", "EMBEDDED"], subscribedStatus: ["SUBSCRIBED", "UNSUBSCRIBED"], liveOrOnDemand: ["ON_DEMAND", "LIVE"], youtubeProduct: ["CORE", "SHORTS"],
  creatorContentType: ["VIDEO_ON_DEMAND", "SHORTS", "LIVE_STREAM"], adType: ["skippableVideo", "displayAd"], country: ["VN", "US", "TH"], sharingService: ["FACEBOOK", "COPY_PASTE"],
  ageGroup: ["age18-24", "age25-34"], gender: ["female", "male"], video: ["vid00000001", "vid00000002", "vid00000003"]
};
const SCOPE_BASE = { claimed: 1000, self: 700, thirdParty: 300 };

function addDays(day, count) { return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10); }
function daysBetween(startDate, endDate) { const days = []; for (let day = startDate; day <= endDate; day = addDays(day, 1)) days.push(day); return days; }
function dayIndex(day) { return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${EPOCH}T00:00:00Z`)) / DAY); }
// Indexes 0..25 keep the historical one-letter ids; higher indexes are zero-padded base36 (never a single repeated letter).
function channelId(index) { return index < 26 ? `UC${String.fromCharCode(97 + index).repeat(22)}` : `UC${index.toString(36).padStart(22, "0")}`; }
// `reason: null` models a 429 whose body carries only `status: RESOURCE_EXHAUSTED` and no errors[] array.
function googleError({ status = 500, reason = "internalError", message = "Backend Error", headers = {} }) {
  const error = new Error(message);
  const payload = { code: status, message, status: reason || "RESOURCE_EXHAUSTED" };
  if (reason) payload.errors = [{ reason, message, domain: "global" }];
  error.response = { status, headers: { ...headers }, data: { error: payload } };
  return error;
}
function badRequest(message) { return googleError({ status: 400, reason: "badRequest", message: `The query is not supported. ${message}` }); }
const PER_DAY_ONLY = new Set(["country", "sharingService", "ageGroup", "gender", "video"]);
const NO_MONEY = new Set(["deviceType", "operatingSystem", "insightTrafficSourceType", "insightPlaybackLocationType", "insightTrafficSourceDetail", "insightPlaybackLocationDetail", "subscribedStatus", "liveOrOnDemand", "youtubeProduct", "sharingService"]);
const DIMENSION_PAIRS = [["ageGroup", "gender"], ["operatingSystem", "deviceType"]];
// Content-owner reports need exactly one of these filter sets (plus optional country / extra playback-location filters).
const OWNER_FILTER_SETS = [["channel"], ["video"], ["group"], ["claimedStatus"], ["uploaderType"], ["claimedStatus", "uploaderType"]];
// The combinations the real Analytics API rejects with HTTP 400 (brief section 2); the engine must never send them.
function validateReport(params, filters, dims, metrics, owners) {
  const ids = String(params.ids || "");
  if (owners && !owners.some((owner) => ids === `contentOwner==${owner}`)) throw badRequest("ids must name the authorized content owner.");
  const breakdown = dims.filter((dim) => dim !== "day");
  if (dims.includes("day") && breakdown.some((dim) => PER_DAY_ONLY.has(dim))) throw badRequest(`day cannot be combined with ${breakdown.join(",")}.`);
  if (breakdown.length > 1 && !DIMENSION_PAIRS.some((pair) => pair.length === breakdown.length && pair.every((dim) => breakdown.includes(dim)))) throw badRequest("Only one breakdown dimension per request.");
  const keys = Object.keys(filters).filter((key) => !["country", "insightPlaybackLocationType"].includes(key)).sort();
  if (!OWNER_FILTER_SETS.some((set) => set.length === keys.length && set.every((key) => keys.includes(key)))) throw badRequest(`Unsupported filter combination ${keys.join(";") || "(none)"}.`);
  if (filters.claimedStatus && filters.claimedStatus !== "claimed") throw badRequest("claimedStatus must be claimed.");
  if (filters.uploaderType === "thirdParty" && !filters.claimedStatus) throw badRequest("uploaderType==thirdParty needs claimedStatus==claimed.");
  if (breakdown.includes("adType") && filters.channel) throw badRequest("adType does not accept a channel filter.");
  if (metrics.some((key) => MONEY.has(key)) && breakdown.some((dim) => NO_MONEY.has(dim))) throw badRequest(`Monetary metrics are not available with ${breakdown.join(",")}.`);
}
function parseFilters(text) {
  const result = {};
  for (const part of String(text || "").split(";").filter(Boolean)) { const [key, value] = part.split("=="); result[key] = key === "channel" || key === "video" ? value.split(",") : value; }
  return result;
}
function scopeOf(filters) {
  if (filters.channel || filters.video) return null;
  if (filters.uploaderType === "self" && !filters.claimedStatus) return "self";
  if (filters.uploaderType === "thirdParty") return "thirdParty";
  return "claimed";
}
// Every metric derives from the entity's views for the day: base + day index (+ any revision), so tests can predict values.
function allMetrics(views) {
  const redViews = Math.round(views / 20);
  return { views, engagedViews: Math.round(views * 0.8), redViews, estimatedMinutesWatched: views * 3, estimatedRedMinutesWatched: redViews * 3, averageViewDuration: 180, averageViewPercentage: 40,
    likes: Math.round(views / 10), dislikes: Math.round(views / 100), comments: Math.round(views / 50), shares: Math.round(views / 40), subscribersGained: Math.round(views / 200),
    subscribersLost: Math.round(views / 400), videosAddedToPlaylists: Math.round(views / 300), videosRemovedFromPlaylists: Math.round(views / 600),
    estimatedRevenue: Math.round(views) / 100, estimatedAdRevenue: Math.round(views) / 120, estimatedRedPartnerRevenue: Math.round(views) / 1000, grossRevenue: Math.round(views) / 50,
    monetizedPlaybacks: views, playbackBasedCpm: 2, adImpressions: views * 2, cpm: 1.5, viewerPercentage: 50 };
}

// `owners`: the content owner ids the fake accepts in `ids=contentOwner==<id>` (any id when omitted).
function createFakeGoogle({ channelCount = 5, channels: channelList, watermark = null, emptyScopes = [], revisions = [], owners = null } = {}) {
  const fixture = {
    channels: channelList || Array.from({ length: channelCount }, (_, index) => ({ id: channelId(index), title: `Channel ${index + 1}`, country: "VN" })),
    watermark, emptyScopes: new Set(emptyScopes), revisions: new Map(revisions), videos: DIMENSION_VALUES.video
  };
  const fake = { fixture, calls: [], rules: [], onRequest: null, tokens: new Set() };
  const baseViews = (entity, day) => {
    const index = dayIndex(day); const delta = fixture.revisions.get(`${entity}|${day}`) || 0;
    if (entity.startsWith("owner:")) return SCOPE_BASE[entity.slice(6)] + index + delta;
    const position = fixture.channels.findIndex((channel) => channel.id === entity.slice(8));
    return 100 + 10 * (position < 0 ? 0 : position) + index + delta;
  };
  // Channels without activity are omitted from grouped channel responses (fewer rows than ids, like the live CMS).
  const active = (id, day) => { const position = fixture.channels.findIndex((channel) => channel.id === id); return (Math.max(0, position) + dayIndex(day)) % 4 !== 3; };
  const pick = (entity, day, metrics) => { const all = allMetrics(baseViews(entity, day)); return Object.fromEntries(metrics.map((key) => [key, all[key]])); };
  const share = (values, metrics, index, count) => {
    const fraction = (index + 1) / (count * (count + 1) / 2);
    return Object.fromEntries(metrics.map((key) => [key, NON_ADDITIVE.has(key) ? values[key] : Math.round(values[key] * fraction * 100) / 100]));
  };
  const sumRows = (rows, metrics) => {
    const total = {};
    for (const key of metrics) total[key] = NON_ADDITIVE.has(key) ? rows[0]?.[key] ?? 0 : Math.round(rows.reduce((sum, row) => sum + (row[key] || 0), 0) * 100) / 100;
    return total;
  };
  function report(params) {
    const dims = String(params.dimensions || "").split(",").filter(Boolean);
    const metrics = String(params.metrics || "").split(",").filter(Boolean);
    const filters = parseFilters(params.filters);
    validateReport(params, filters, dims, metrics, owners);
    const money = metrics.some((key) => MONEY.has(key));
    const limit = fixture.watermark ? fixture.watermark[money ? "money" : "basic"] : null;
    const days = daysBetween(params.startDate, params.endDate).filter((day) => !limit || day <= limit);
    const scope = scopeOf(filters);
    const entities = filters.channel ? filters.channel.map((id) => `channel:${id}`) : scope && !fixture.emptyScopes.has(scope) ? [`owner:${scope}`] : [];
    const perDay = (entity) => days.filter((day) => !entity.startsWith("channel:") || active(entity.slice(8), day)).map((day) => ({ day, ...pick(entity, day, metrics) }));
    let rows = [];
    if (dims.includes("channel")) {
      for (const entity of entities) {
        const list = perDay(entity);
        if (dims.includes("day")) rows.push(...list.map((row) => ({ channel: entity.slice(8), ...row })));
        else if (list.length) rows.push({ channel: entity.slice(8), ...sumRows(list, metrics) });
      }
    } else if (!dims.length) {
      const list = entities.flatMap(perDay);
      if (list.length) rows.push(sumRows(list, metrics));
    } else if (dims.length === 1 && dims[0] === "day") {
      for (const entity of entities) rows.push(...perDay(entity));
    } else {
      const breakdown = dims.filter((dim) => dim !== "day");
      const values = breakdown.length === 1 ? DIMENSION_VALUES[breakdown[0]].map((value) => [value])
        : DIMENSION_VALUES[breakdown[0]].flatMap((a) => DIMENSION_VALUES[breakdown[1]].map((b) => [a, b]));
      for (const entity of entities) {
        const list = perDay(entity);
        if (dims.includes("day")) {
          for (const row of list) values.forEach((value, index) => rows.push({ ...Object.fromEntries(breakdown.map((dim, i) => [dim, value[i]])), day: row.day, ...share(row, metrics, index, values.length) }));
        } else if (list.length) {
          const total = sumRows(list, metrics);
          values.forEach((value, index) => rows.push({ ...Object.fromEntries(breakdown.map((dim, i) => [dim, value[i]])), ...share(total, metrics, index, values.length) }));
        }
      }
    }
    const sort = String(params.sort || "");
    if (sort) { const key = sort.replace(/^-/, ""); const direction = sort.startsWith("-") ? -1 : 1; rows.sort((a, b) => (a[key] > b[key] ? direction : a[key] < b[key] ? -direction : 0)); }
    const columns = [...dims, ...metrics];
    const startIndex = Number(params.startIndex || 1); const maxResults = Number(params.maxResults || 200);
    const page = rows.slice(startIndex - 1, startIndex - 1 + maxResults);
    return { columnHeaders: columns.map((name) => ({ name, columnType: dims.includes(name) ? "DIMENSION" : "METRIC", dataType: dims.includes(name) ? "STRING" : "FLOAT" })),
      rows: page.map((row) => columns.map((name) => row[name] ?? 0)) };
  }
  function channelsPage(params) {
    // A CMS inventory listing is only valid on behalf of the content owner with managedByMe.
    if (params.managedByMe !== true || !params.onBehalfOfContentOwner || (owners && !owners.includes(String(params.onBehalfOfContentOwner)))) throw badRequest("channels.list needs managedByMe and onBehalfOfContentOwner.");
    const pageSize = Number(params.maxResults || 50); const offset = params.pageToken ? Number(String(params.pageToken).replace("page-", "")) : 0;
    const items = fixture.channels.slice(offset, offset + pageSize).map((channel) => ({ id: channel.id, snippet: { title: channel.title, country: channel.country || null, publishedAt: "2020-01-01T00:00:00Z",
      thumbnails: { default: { url: `https://example.invalid/${channel.id}.jpg` } } }, statistics: { subscriberCount: "1000", viewCount: "50000", videoCount: "10" } }));
    return { items, ...(offset + pageSize < fixture.channels.length ? { nextPageToken: `page-${offset + pageSize}` } : {}) };
  }
  function videosPage(params) {
    return { items: String(params.id || "").split(",").filter(Boolean).map((id) => ({ id, snippet: { title: `Video ${id}`, channelId: fixture.channels[0]?.id || null, publishedAt: "2024-01-01T00:00:00Z" }, contentDetails: { duration: "PT3M" } })) };
  }
  fake.handler = async (url, options = {}) => {
    const params = { ...(options.params || {}) };
    fake.calls.push({ url, params, at: Date.now() });
    if (options.headers?.Authorization) fake.tokens.add(options.headers.Authorization);
    if (fake.onRequest) await fake.onRequest(url, params, fake.calls.length);
    for (const rule of fake.rules) {
      if (rule.remaining > 0 && rule.match(url, params)) { rule.remaining -= 1; rule.hits += 1; throw googleError(rule); }
    }
    if (url.endsWith("/channels")) return { data: channelsPage(params) };
    if (url.endsWith("/videos")) return { data: videosPage(params) };
    if (url.endsWith("/v2/reports")) return { data: report(params) };
    throw new Error(`Unexpected Google URL ${url}`);
  };
  // `headers` (e.g. { "retry-after": "1" }) ride on the error response; `reason: null` omits errors[] (see googleError).
  fake.fail = ({ match, status = 500, reason = "internalError", message = "Backend Error", times = 1, headers = {} }) => {
    const rule = { match, status, reason, message, headers, remaining: times, hits: 0 }; fake.rules.push(rule); return rule;
  };
  fake.revise = (entity, day, delta) => fixture.revisions.set(`${entity}|${day}`, (fixture.revisions.get(`${entity}|${day}`) || 0) + delta);
  fake.reset = () => { fake.calls.length = 0; fake.rules.length = 0; fake.onRequest = null; fixture.revisions.clear(); fixture.emptyScopes.clear(); fixture.watermark = null; };
  fake.views = (entity, day) => baseViews(entity, day);
  fake.active = active;
  fake.analyticsCalls = (predicate = () => true) => fake.calls.filter((call) => call.url.endsWith("/v2/reports") && predicate(call.params, call));
  return fake;
}

// Sets ANALYTICS_DB_PATH (temp file) and ANALYTICS_PACE_MS=0, installs the credential/database stubs, replaces axios.get with
// the fake router, then requires the analytics modules. Call it before any other require of the analytics code.
function installAnalyticsHarness({ network, networks, users = {}, fixture = {} } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-engine-"));
  process.env.ANALYTICS_DB_PATH = path.join(tempDir, "analytics.sqlite");
  process.env.ANALYTICS_PACE_MS = "0";
  const list = networks || [network || { id: 7, name: "Harness Owner", network_code: "OWNER_HARNESS", cms_auth_status: "connected", cms_refresh_token: "harness-refresh-token-never-stored", cms_access_token: null }];
  const harness = { tokenCalls: 0, tokenError: null, networks: list, network: list[0], users, tempDir };
  const databasePath = require.resolve("../../src/config/database");
  const credentialPath = require.resolve("../../src/services/googleContentIdService");
  const DEFAULT_SCOPES = "https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/yt-analytics-monetary.readonly";
  const withScopes = (entry) => (entry && !entry.cms_auth_scopes ? { ...entry, cms_auth_scopes: DEFAULT_SCOPES } : entry);
  const find = (value) => withScopes(list.find((entry) => entry.network_code === String(value) || String(entry.id) === String(value)));
  require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: {
    prepare: (sql) => ({ get: (value) => (/FROM users/.test(sql) ? users[value] : find(value)), all: () => list.map((entry) => ({ id: entry.id, name: entry.name,
      network_code: entry.network_code, cms_auth_status: entry.cms_auth_status, cms_auth_scopes: entry.cms_auth_scopes || DEFAULT_SCOPES })) })
  } };
  require.cache[credentialPath] = { id: credentialPath, filename: credentialPath, loaded: true, exports: {
    getAccessToken: async () => { if (harness.tokenError) throw harness.tokenError(); harness.tokenCalls += 1; return "fake-access-token"; },
    getConnectedNetwork: (id) => list.find((entry) => entry.id === id) || list[0]
  } };
  const axios = require("axios");
  const originalGet = axios.get;
  const fake = createFakeGoogle({ owners: list.map((entry) => entry.network_code), ...fixture });
  axios.get = (url, options) => fake.handler(url, options);
  const db = require("../../src/config/analyticsDatabase");
  const service = require("../../src/services/analyticsService");
  const warehouse = require("../../src/services/analyticsWarehouse");
  const engine = require("../../src/services/analyticsSyncEngine");
  const scheduler = require("../../src/services/analyticsScheduleService");
  harness.cleanup = () => { service.stopWorker(); axios.get = originalGet; db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); };
  return Object.assign(harness, { db, service, warehouse, engine, scheduler, fake });
}

module.exports = { createFakeGoogle, installAnalyticsHarness, addDays, daysBetween, dayIndex, channelId, googleError, validateReport, DIMENSION_VALUES };
