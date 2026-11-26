// Analytics v2 — shared constants and pure helpers (no React; the DOM only in downloadCsv). Labels are
// canonical English (tk) rendered with t() / useI18n() where they appear; numbers, calendar days and
// instants follow the UI language. Filters live in the URL (?owner=&start=&end=&scope=&channels=).
import { BarChart3, CircleDollarSign, DatabaseZap, Film, Search, TvMinimal, UsersRound } from "lucide-react";
import { formatDate as formatCalendarDay, getLanguage, normalizeLanguage, regionName, tk } from "../../i18n/index.js";

export const ANALYTICS_SYNC_TIMEZONE = "Asia/Bangkok";
export const ACTIVE_JOBS = Object.freeze(["queued", "running", "cancelling"]);
const MAX_RANGE_DAYS = 366;
const MAX_CHANNEL_IDS = 200;
const EARLIEST_DAY = "2009-01-01";
const DEFAULT_LAG_DAYS = 3;
const DEFAULT_PRESET = "28";
const CHANNEL_ID = /^UC[\w-]{22}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86400000;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const SCOPE_LABELS = Object.freeze({
  claimed: tk("Claimed content"),
  self: tk("Partner channels"),
  thirdParty: tk("Third-party content")
});
const SCOPES = Object.keys(SCOPE_LABELS);

export const METRIC_LABELS = Object.freeze({
  views: tk("Views"),
  engagedViews: tk("Engaged views"),
  redViews: tk("Premium views"),
  estimatedMinutesWatched: tk("Minutes watched"),
  estimatedRedMinutesWatched: tk("Premium minutes watched"),
  averageViewDuration: tk("Average view duration"),
  averageViewPercentage: tk("Average percentage viewed"),
  likes: tk("Likes"),
  dislikes: tk("Dislikes"),
  comments: tk("Comments"),
  shares: tk("Shares"),
  subscribersGained: tk("Subscribers gained"),
  subscribersLost: tk("Subscribers lost"),
  videosAddedToPlaylists: tk("Added to playlists"),
  videosRemovedFromPlaylists: tk("Removed from playlists"),
  estimatedRevenue: tk("Estimated revenue"),
  estimatedAdRevenue: tk("Ad revenue"),
  estimatedRedPartnerRevenue: tk("YouTube Premium revenue"),
  grossRevenue: tk("Gross revenue"),
  monetizedPlaybacks: tk("Monetized playbacks"),
  playbackBasedCpm: tk("Playback-based CPM"),
  adImpressions: tk("Ad impressions"),
  cpm: tk("CPM"),
  viewerPercentage: tk("Viewer percentage"),
  watchHours: tk("Watch hours"),
  netSubscribers: tk("Net subscribers"),
  rpm: tk("RPM"),
  subscribersTotal: tk("Subscribers"),
  lifetimeViews: tk("Lifetime views"),
  videoCount: tk("Video count"),
  uniques: tk("Unique viewers"),
  annotationClickThroughRate: tk("Annotation click-through rate"),
  annotationCloseRate: tk("Annotation close rate"),
  annotationImpressions: tk("Annotation impressions"),
  annotationClickableImpressions: tk("Clickable annotation impressions"),
  annotationClosableImpressions: tk("Closable annotation impressions"),
  annotationClicks: tk("Annotation clicks"),
  annotationCloses: tk("Annotation closes"),
  cardClickRate: tk("Card click rate"),
  cardTeaserClickRate: tk("Card teaser click rate"),
  cardImpressions: tk("Card impressions"),
  cardTeaserImpressions: tk("Card teaser impressions"),
  cardClicks: tk("Card clicks"),
  cardTeaserClicks: tk("Card teaser clicks"),
  audienceWatchRatio: tk("Audience watch ratio"),
  relativeRetentionPerformance: tk("Relative retention performance"),
  elapsedVideoTimeRatio: tk("Video progress"),
  playlistViews: tk("Playlist views"),
  playlistEstimatedMinutesWatched: tk("Playlist minutes watched"),
  playlistAverageViewDuration: tk("Playlist average view duration"),
  playlistSaves: tk("Playlist saves"),
  playlistStarts: tk("Playlist starts"),
  viewsPerPlaylistStart: tk("Views per playlist start"),
  averageTimeInPlaylist: tk("Average time in playlist")
});

// count | minutes | seconds | percent | money | cpm | ratio | hours — mirrors the backend METRIC_REGISTRY kinds.
export const METRIC_KINDS = Object.freeze({
  views: "count", engagedViews: "count", redViews: "count", estimatedMinutesWatched: "minutes", estimatedRedMinutesWatched: "minutes",
  averageViewDuration: "seconds", averageViewPercentage: "percent", likes: "count", dislikes: "count", comments: "count", shares: "count",
  subscribersGained: "count", subscribersLost: "count", videosAddedToPlaylists: "count", videosRemovedFromPlaylists: "count",
  estimatedRevenue: "money", estimatedAdRevenue: "money", estimatedRedPartnerRevenue: "money", grossRevenue: "money",
  monetizedPlaybacks: "count", playbackBasedCpm: "cpm", adImpressions: "count", cpm: "cpm", viewerPercentage: "percent",
  watchHours: "hours", netSubscribers: "count", rpm: "money", subscribersTotal: "count", lifetimeViews: "count", videoCount: "count",
  uniques: "count", annotationClickThroughRate: "percent", annotationCloseRate: "percent", annotationImpressions: "count",
  annotationClickableImpressions: "count", annotationClosableImpressions: "count", annotationClicks: "count", annotationCloses: "count",
  cardClickRate: "percent", cardTeaserClickRate: "percent", cardImpressions: "count", cardTeaserImpressions: "count", cardClicks: "count",
  cardTeaserClicks: "count", audienceWatchRatio: "percent", relativeRetentionPerformance: "ratio", elapsedVideoTimeRatio: "percent",
  playlistViews: "count", playlistEstimatedMinutesWatched: "minutes", playlistAverageViewDuration: "seconds", playlistSaves: "count",
  playlistStarts: "count", viewsPerPlaylistStart: "ratio", averageTimeInPlaylist: "ratio"
});

// Google reports these as fractions (0.035); viewerPercentage / averageViewPercentage are already percentages.
const FRACTION_METRICS = new Set(["annotationClickThroughRate", "annotationCloseRate", "cardClickRate", "cardTeaserClickRate", "audienceWatchRatio", "elapsedVideoTimeRatio"]);

export const DIMENSION_LABELS = Object.freeze({
  day: tk("Day"),
  month: tk("Month"),
  video: tk("Video"),
  channel: tk("Channel"),
  playlist: tk("Playlist"),
  group: tk("Group"),
  country: tk("Country"),
  province: tk("Province"),
  city: tk("City"),
  continent: tk("Continent"),
  subContinent: tk("Sub-continent"),
  creatorContentType: tk("Content type"),
  subscribedStatus: tk("Subscribed status"),
  liveOrOnDemand: tk("Live or on demand"),
  youtubeProduct: tk("YouTube product"),
  insightTrafficSourceType: tk("Traffic source"),
  insightTrafficSourceDetail: tk("Traffic source detail"),
  insightPlaybackLocationType: tk("Playback location"),
  insightPlaybackLocationDetail: tk("Playback location detail"),
  deviceType: tk("Device type"),
  operatingSystem: tk("Operating system"),
  ageGroup: tk("Age group"),
  gender: tk("Gender"),
  sharingService: tk("Sharing service"),
  adType: tk("Ad type"),
  elapsedVideoTimeRatio: tk("Video progress"),
  audienceType: tk("Audience type"),
  claimedStatus: tk("Claimed status"),
  uploaderType: tk("Uploader type"),
  scope: tk("Scope"),
  entityKey: tk("Entity")
});

// Enum values per dimension. Brand names are identical in both languages and are not wrapped in tk().
export const DIMENSION_VALUE_LABELS = Object.freeze({
  deviceType: {
    DESKTOP: tk("Desktop"), GAME_CONSOLE: tk("Game console"), MOBILE: tk("Mobile"), TABLET: tk("Tablet"), TV: "TV", UNKNOWN_PLATFORM: tk("Unknown platform")
  },
  insightTrafficSourceType: {
    ADVERTISING: tk("Advertising"), ANNOTATION: tk("Annotation"), CAMPAIGN_CARD: tk("Campaign card"), END_SCREEN: tk("End screen"),
    EXT_URL: tk("External"), HASHTAGS: tk("Hashtags"), IMMERSIVE_LIVE: tk("Immersive live"), LIVE_REDIRECT: tk("Live redirect"),
    NOTIFICATION: tk("Notification"), NO_LINK_EMBEDDED: tk("Embedded (no link)"), NO_LINK_OTHER: tk("Direct or unknown"),
    PLAYLIST: tk("Playlist"), PRODUCT_PAGE: tk("Product page"), PROMOTED: tk("Promoted"), RELATED_VIDEO: tk("Suggested videos"),
    SHORTS: tk("Shorts feed"), SHORTS_CONTENT_LINKS: tk("Shorts content links"), SOUND_PAGE: tk("Sound page"),
    SUBSCRIBER: tk("Browse features"), VIDEO_REMIXES: tk("Video remixes"), YT_CHANNEL: tk("Channel page"),
    YT_OTHER_PAGE: tk("Other YouTube pages"), YT_PLAYLIST_PAGE: tk("Playlist page"), YT_SEARCH: tk("YouTube search")
  },
  insightPlaybackLocationType: {
    BROWSE: tk("Browse features"), CHANNEL: tk("Channel page"), EMBEDDED: tk("Embedded player"), EXTERNAL_APP: tk("External app"),
    MOBILE: tk("Mobile"), SEARCH: tk("Search page"), WATCH: tk("Watch page"), YT_OTHER: tk("Other YouTube pages")
  },
  subscribedStatus: { SUBSCRIBED: tk("Subscribed"), UNSUBSCRIBED: tk("Not subscribed") },
  gender: { male: tk("Male"), female: tk("Female"), user_specified: tk("User specified") },
  liveOrOnDemand: { LIVE: tk("Live"), ON_DEMAND: tk("On demand") },
  creatorContentType: { VIDEO_ON_DEMAND: tk("Videos"), SHORTS: tk("Shorts"), LIVE_STREAM: tk("Live streams"), STORY: tk("Stories"), UNSPECIFIED: tk("Unspecified") },
  youtubeProduct: { CORE: "YouTube", GAMING: "YouTube Gaming", KIDS: "YouTube Kids", MUSIC: "YouTube Music", UNKNOWN: tk("Unknown") },
  operatingSystem: {
    ANDROID: "Android", BADA: "Bada", BLACKBERRY: "BlackBerry", CHROMECAST: "Chromecast", DOCOMO: "DoCoMo", FIREFOX: "Firefox OS",
    HIPTOP: "Hiptop", IOS: "iOS", KAIOS: "KaiOS", LINUX: "Linux", MACINTOSH: "macOS", MEEGO: "MeeGo", NINTENDO_3DS: "Nintendo 3DS",
    OTHER: tk("Other"), PLAYSTATION: "PlayStation", PLAYSTATION_VITA: "PlayStation Vita", REALMEDIA: "RealMedia", SMART_TV: "Smart TV",
    SYMBIAN: "Symbian", TIZEN: "Tizen", VIDAA: "VIDAA", WEBOS: "webOS", WII: "Wii", WINDOWS: "Windows", WINDOWS_MOBILE: "Windows Mobile", XBOX: "Xbox"
  },
  adType: {
    auctionBumperInstream: tk("Auction bumper (in-stream)"), auctionDisplay: tk("Auction display"), auctionInstream: tk("Auction in-stream"),
    auctionTrueviewInslate: tk("Auction TrueView in-slate"), auctionTrueviewInstream: tk("Auction TrueView in-stream"), auctionUnknown: tk("Auction (unknown)"),
    reservedBumperInstream: tk("Reserved bumper (in-stream)"), reservedClickToPlay: tk("Reserved click-to-play"), reservedDisplay: tk("Reserved display"),
    reservedInstream: tk("Reserved in-stream"), reservedInstreamSelect: tk("Reserved in-stream select"), reservedMasthead: tk("Reserved masthead"),
    reservedUnknown: tk("Reserved (unknown)"), unknown: tk("Unknown")
  },
  sharingService: {
    COPY_PASTE: tk("Copy link"), EMBED: tk("Embed"), EMAIL: tk("Email"), GMAIL: "Gmail", OTHER: tk("Other"), TEXT_MESSAGE: tk("Text message"),
    UNKNOWN: tk("Unknown"), IOS_SYSTEM_ACTIVITY_DIALOG: tk("System share sheet"), NEARBY_SHARE: "Nearby Share", WHATS_APP: "WhatsApp",
    FACEBOOK_MESSENGER: "Messenger", FACEBOOK_PAGES: "Facebook Pages", GOOGLEPLUS: "Google+", LINKEDIN: "LinkedIn", VKONTAKTE: "VK",
    KAKAO: "KakaoTalk", KAKAO_STORY: "KakaoStory", TWITTER: "X (Twitter)", YOUTUBE_MUSIC: "YouTube Music", YOUTUBE_KIDS: "YouTube Kids",
    YOUTUBE_GAMING: "YouTube Gaming", YOUTUBE_TV: "YouTube TV", GO_SMS: "GO SMS", BBM: "BBM", HI5: "hi5", LINE: "LINE", WECHAT: "WeChat",
    ODNOKLASSNIKI: "Odnoklassniki", STUMBLEUPON: "StumbleUpon", LIVEJOURNAL: "LiveJournal", MYSPACE: "Myspace"
  },
  scope: SCOPE_LABELS,
  claimedStatus: { claimed: tk("Claimed") },
  uploaderType: { self: tk("Uploaded by the partner"), thirdParty: tk("Uploaded by third parties") }
});

export const REPORT_LABELS = Object.freeze({
  overview: tk("Performance overview"),
  daily: tk("Daily performance"),
  monetaryOverview: tk("Revenue overview"),
  monetaryDaily: tk("Daily revenue"),
  channels: tk("Channel performance"),
  channelRevenue: tk("Revenue by channel"),
  videos: tk("Top videos"),
  videoRevenue: tk("Video revenue"),
  countries: tk("Countries"),
  countryRevenue: tk("Revenue by country"),
  trafficSources: tk("Traffic sources"),
  playbackLocations: tk("Playback locations"),
  embeddedPlayers: tk("Embedded players"),
  devices: tk("Devices"),
  operatingSystems: tk("Operating systems"),
  deviceSystems: tk("Devices & operating systems"),
  demographics: tk("Age & gender"),
  subscribedStatus: tk("Subscribed status"),
  contentTypes: tk("Content types"),
  liveStatus: tk("Live vs on demand"),
  youtubeProducts: tk("YouTube products"),
  sharing: tk("Sharing services"),
  engagement: tk("Cards & annotations"),
  engagementDaily: tk("Cards & annotations by day"),
  adTypes: tk("Ad types"),
  retention: tk("Audience retention")
});

export const REPORT_DESCRIPTIONS = Object.freeze({
  overview: tk("Totals of the basic metrics for the range."),
  daily: tk("Basic metrics per day."),
  monetaryOverview: tk("Revenue totals for the range (USD)."),
  monetaryDaily: tk("Revenue per day (USD)."),
  channels: tk("Basic metrics grouped by managed channel (up to 500 IDs per request; channels without activity are omitted)."),
  channelRevenue: tk("Revenue grouped by managed channel."),
  videos: tk("The 200 most viewed videos; use the Bulk archive for every video."),
  videoRevenue: tk("The 200 videos with the highest estimated revenue."),
  countries: tk("Views and engagement by country."),
  countryRevenue: tk("Revenue by country."),
  trafficSources: tk("How viewers found the content."),
  playbackLocations: tk("Where the content was played."),
  embeddedPlayers: tk("The 25 external sites embedding the content most."),
  devices: tk("Views by device type."),
  operatingSystems: tk("Views by operating system."),
  deviceSystems: tk("Views by operating system and device type."),
  demographics: tk("Viewer percentage by age group and gender; YouTube hides rows below its privacy threshold."),
  subscribedStatus: tk("Views from subscribers and non-subscribers."),
  contentTypes: tk("Videos, Shorts, live streams and stories."),
  liveStatus: tk("Live streams versus on-demand videos."),
  youtubeProducts: tk("YouTube, YouTube Music, YouTube Kids and YouTube Gaming."),
  sharing: tk("Where viewers shared the content."),
  engagement: tk("Card and annotation totals."),
  engagementDaily: tk("Card and annotation metrics per day."),
  adTypes: tk("Gross revenue, impressions and CPM by ad type (Content Owner level only)."),
  retention: tk("Audience retention curve of one video (needs a Video ID).")
});

// Every status word of the API → badge label and tone (emerald | amber | blue | slate | red).
export const STATUS_META = Object.freeze({
  ready: { label: tk("Ready"), tone: "emerald" },
  complete: { label: tk("Complete"), tone: "emerald" },
  completed: { label: tk("Completed"), tone: "emerald" },
  connected: { label: tk("Connected"), tone: "emerald" },
  partial: { label: tk("Partial"), tone: "amber" },
  drift: { label: tk("Drift"), tone: "amber" },
  queued: { label: tk("Queued"), tone: "amber" },
  cancelling: { label: tk("Cancelling"), tone: "amber" },
  stale: { label: tk("Stale"), tone: "amber" },
  warning: { label: tk("Warning"), tone: "amber" },
  running: { label: tk("Running"), tone: "blue" },
  missing: { label: tk("Missing"), tone: "slate" },
  empty: { label: tk("Empty"), tone: "slate" },
  pending: { label: tk("Not yet published"), tone: "slate" },
  unsupported: { label: tk("Unsupported"), tone: "slate" },
  "not-run": { label: tk("Not run"), tone: "slate" },
  hidden: { label: tk("Hidden"), tone: "slate" },
  skipped: { label: tk("Skipped"), tone: "slate" },
  unknown: { label: tk("Unknown"), tone: "slate" },
  failed: { label: tk("Failed"), tone: "red" },
  cancelled: { label: tk("Cancelled"), tone: "red" },
  interrupted: { label: tk("Interrupted"), tone: "red" },
  error: { label: tk("Error"), tone: "red" },
  disconnected: { label: tk("Disconnected"), tone: "red" }
});

export const JOB_LABELS = Object.freeze({
  kind: { daily: tk("Daily sync"), full: tk("Sync all"), channelDetail: tk("Channel reports"), snapshot: tk("Range report") },
  mode: { append: tk("Only add missing"), overwrite: tk("Overwrite") },
  requestedBy: { schedule: tk("Schedule"), user: tk("Manual"), recovery: tk("Recovery") }
});

export const DATE_PRESETS = Object.freeze([
  { key: "7", label: tk("Last 7 days") },
  { key: "28", label: tk("Last 28 days") },
  { key: "90", label: tk("Last 90 days") },
  { key: "thisMonth", label: tk("This month") },
  { key: "lastMonth", label: tk("Last month") },
  { key: "last12Months", label: tk("Last 12 months") },
  { key: "custom", label: tk("Custom") }
]);

export const ANALYTICS_SECTIONS = Object.freeze([
  { key: "overview", path: "overview", icon: BarChart3, label: tk("Overview") },
  { key: "channels", path: "channels", icon: TvMinimal, label: tk("Channels") },
  { key: "content", path: "content", icon: Film, label: tk("Content") },
  { key: "audience", path: "audience", icon: UsersRound, label: tk("Audience") },
  { key: "revenue", path: "revenue", icon: CircleDollarSign, label: tk("Revenue"), monetary: true },
  { key: "explorer", path: "explorer", icon: Search, label: tk("Explorer") },
  { key: "sync", path: "sync", icon: DatabaseZap, label: tk("Data & sync") }
]);

export const BREAKDOWN_DIMENSIONS = Object.freeze([
  "insightTrafficSourceType", "insightPlaybackLocationType", "deviceType", "operatingSystem", "subscribedStatus",
  "liveOrOnDemand", "youtubeProduct", "creatorContentType", "adType", "country", "sharingService"
]);

const exportOption = (label, type, format, extra = {}) =>
  ({ key: `${type}${extra.dimension ? `:${extra.dimension}` : ""}:${format}`, label, type, format, ...extra });
const breakdownCsv = (label, dimension, extra) => exportOption(label, "breakdown", "csv", { dimension, ...extra });

// Server exports per view: { key, label, type, dimension?, format, monetary?, channel? } (channel: needs channelId).
export const EXPORTS_BY_VIEW = Object.freeze({
  overview: [
    exportOption(tk("Overview workbook (Excel)"), "overview", "xlsx"),
    exportOption(tk("Daily rows (CSV)"), "daily", "csv"),
    exportOption(tk("Daily rows (Excel)"), "daily", "xlsx")
  ],
  channels: [
    exportOption(tk("Channels (CSV)"), "channels", "csv"),
    exportOption(tk("Channels (Excel)"), "channels", "xlsx"),
    exportOption(tk("Channel days (CSV)"), "channel-days", "csv")
  ],
  channelDetail: [
    exportOption(tk("Channel days (CSV)"), "channel-days", "csv", { channel: true }),
    exportOption(tk("Top videos (CSV)"), "top-videos", "csv", { channel: true })
  ],
  content: [
    exportOption(tk("Top videos (CSV)"), "top-videos", "csv"),
    exportOption(tk("Video revenue (CSV)"), "video-revenue", "csv", { monetary: true }),
    breakdownCsv(tk("Content types (CSV)"), "creatorContentType"),
    breakdownCsv(tk("Live vs on demand (CSV)"), "liveOrOnDemand"),
    breakdownCsv(tk("Playback locations (CSV)"), "insightPlaybackLocationType"),
    breakdownCsv(tk("YouTube products (CSV)"), "youtubeProduct")
  ],
  audience: [
    breakdownCsv(tk("Countries (CSV)"), "country"),
    breakdownCsv(tk("Traffic sources (CSV)"), "insightTrafficSourceType"),
    breakdownCsv(tk("Devices (CSV)"), "deviceType"),
    breakdownCsv(tk("Operating systems (CSV)"), "operatingSystem"),
    breakdownCsv(tk("Subscribed status (CSV)"), "subscribedStatus"),
    breakdownCsv(tk("Sharing services (CSV)"), "sharingService"),
    exportOption(tk("Age & gender (CSV)"), "demographics", "csv")
  ],
  revenue: [
    exportOption(tk("Revenue workbook (Excel)"), "revenue", "xlsx", { monetary: true }),
    breakdownCsv(tk("Ad types (CSV)"), "adType", { monetary: true })
  ],
  sync: [
    exportOption(tk("Coverage (CSV)"), "coverage", "csv"),
    exportOption(tk("Change ledger (CSV)"), "history", "csv")
  ],
  explorer: []
});

// Server exports whose scope is the Content Owner / the selected channel list, never a single channel's snapshots.
const OWNER_EXPORT_TYPES = Object.freeze(["overview", "daily", "channels", "channel-days", "revenue"]);
// Exports served from per-entity snapshots / breakdowns: with several channels selected the panels show the
// "select one channel or none" notice, so these options are hidden from the filter-bar menu as well.
const SNAPSHOT_EXPORT_TYPES = Object.freeze(["breakdown", "top-videos", "video-revenue", "demographics", "coverage"]);

// exportChannelId(type, channelIds, explicit) → the `channelId` an export request should carry: the explicit one
// (channel detail), else the single selected channel of the global filter for every type except the owner-scope
// ones, so the file matches the channel snapshot shown on screen; undefined otherwise.
export function exportChannelId(type, channelIds, explicit) {
  if (explicit) return explicit;
  const ids = Array.isArray(channelIds) ? channelIds : parseChannelIds(channelIds);
  return ids.length === 1 && !OWNER_EXPORT_TYPES.includes(String(type || "")) ? ids[0] : undefined;
}

// exportOptionAvailable(option, { canMonetary, channelId, channelCount }) mirrors the filter-bar menu rule: monetary
// options need canMonetary, `channel` options a channelId, snapshot options at most one selected channel.
export function exportOptionAvailable(option, { canMonetary = false, channelId = null, channelCount = 0 } = {}) {
  if (!option || !option.type) return false;
  if (option.monetary && !canMonetary) return false;
  if (option.channel && !channelId) return false;
  return !(SNAPSHOT_EXPORT_TYPES.includes(option.type) && Number(channelCount) > 1);
}

// Known Google OAuth failure reasons of a disconnected CMS → one dictionary sentence each (the raw reason is shown
// only to users who can open Settings > Network).
const OAUTH_REASONS = Object.freeze([
  [/\binvalid_grant\b/i, tk("The CMS authorisation expired or was revoked; reconnect it in Settings > Network.")],
  [/\bunauthorized_client\b/i, tk("The OAuth client is not allowed to use this CMS account; check the OAuth client in Settings > Network.")],
  [/\binvalid_client\b/i, tk("The OAuth client ID or secret is invalid; check the OAuth client in Settings > Network.")]
]);

export function oauthReasonMessage(reason) {
  const text = typeof reason === "string" ? reason : reason?.message || "";
  const match = OAUTH_REASONS.find(([pattern]) => pattern.test(text));
  return match ? match[1] : null;
}

export function metricLabel(key) {
  return METRIC_LABELS[key] || String(key ?? "");
}

// dimensionLabel(key) → the dimension's label.
export function dimensionLabel(key) {
  return DIMENSION_LABELS[key] || String(key ?? "");
}

function humanize(token) {
  const words = token.toLowerCase().split("_").filter(Boolean).join(" ");
  return words ? words[0].toUpperCase() + words.slice(1) : token;
}

// Country names follow the UI language, calendar days the day formatter, age groups become "18–24" / "65+";
// enum values come from DIMENSION_VALUE_LABELS, unknown SCREAMING_CASE values are humanised.
export function dimensionValueLabel(value, dimension) {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value);
  if (dimension === "country") return regionName(text, getLanguage(), text);
  if (dimension === "day") return formatDay(text);
  if (dimension === "ageGroup") return text.replace(/^age/, "").replace(/-$/, "+").replace("-", "–");
  const table = DIMENSION_VALUE_LABELS[dimension];
  if (table && Object.prototype.hasOwnProperty.call(table, text)) return table[text];
  return /^[A-Z0-9_]+$/.test(text) ? humanize(text) : text;
}

export function reportLabel(id) {
  const key = typeof id === "string" ? id : id?.id;
  return REPORT_LABELS[key] || String(key ?? "");
}

// ---------------------------------------------------------------------------
// Numbers, days, instants
// ---------------------------------------------------------------------------

export function numberValue(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// countDays(value, key = "added") → a day count from a job result: the engine caps `days.added` / `days.drifted` at
// 100 entries and ships the true totals as `addedCount` / `driftedCount`, so a result `days` object answers its
// `<key>Count` first and the array length only as a fallback; a bare number or array counts itself.
export function countDays(value, key = "added") {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const name = String(key || "added");
    return countDays(value[`${name}Count`] ?? value[name]);
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

export function rowsOf(report) {
  return Array.isArray(report?.rows) ? report.rows : [];
}

export function percentChange(current, previous) {
  const now = numberValue(current);
  const before = numberValue(previous);
  if (now === null || before === null || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

const localeOf = (language) => (normalizeLanguage(language || getLanguage()) === "vi" ? "vi-VN" : "en-US");

function inferKind(key) {
  if (/Revenue$|^rpm$|^cpm$|Cpm$/.test(key)) return "money";
  if (/Percentage$|Rate$|Ratio$/.test(key)) return "percent";
  if (/Duration$/.test(key)) return "seconds";
  if (/Hours$/.test(key)) return "hours";
  if (/Performance$/.test(key)) return "ratio";
  return "count";
}

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// formatMetric(value, key, { language, compact }): vi-VN / en-US by language; money "$1,234.56" / "1.234,56 US$";
// durations m:ss; percents with one decimal; `compact` switches to compact notation from 1e8 upwards.
export function formatMetric(value, key = "", options = {}) {
  const { language, compact = false } = options || {};
  const n = numberValue(value);
  if (n === null) return "—";
  const locale = localeOf(language);
  const kind = METRIC_KINDS[key] || inferKind(key);
  const notation = compact && Math.abs(n) >= 1e8 ? "compact" : "standard";
  switch (kind) {
    case "money":
    case "cpm":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2, notation }).format(n);
    case "seconds":
      return clock(n);
    case "percent": {
      const fraction = FRACTION_METRICS.has(key) || (!METRIC_KINDS[key] && /Rate$|Ratio$/.test(key));
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(fraction ? n * 100 : n)}%`;
    }
    case "ratio":
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
    case "hours":
      return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 1, notation }).format(n);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, notation }).format(n);
  }
}

// Calendar day (YYYY-MM-DD) in the UI language without a timezone shift: 27/10/2026 (vi) / 10/27/2026 (en).
export function formatDay(value, language) {
  return formatCalendarDay(value, normalizeLanguage(language || getLanguage()));
}

function toInstant(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const text = String(value).trim().replace(" ", "T");
  // SQLite / legacy timestamps carry no zone and are UTC.
  const date = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? `${text}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Instants (schedule times, job and sync timestamps) pinned to Asia/Bangkok with the "GMT+7" suffix so travelling
// users read the scheduler's clock: "21/10/2026 08:00 GMT+7" (vi) / "10/21/2026 08:00 GMT+7" (en); "" when invalid.
export function formatScheduleDate(value, language) {
  const date = toInstant(value);
  if (!date) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ANALYTICS_SYNC_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date).map(({ type, value: part }) => [type, part])
  );
  const day = normalizeLanguage(language || getLanguage()) === "vi" ? `${parts.day}/${parts.month}/${parts.year}` : `${parts.month}/${parts.day}/${parts.year}`;
  return `${day} ${parts.hour}:${parts.minute} GMT+7`;
}

export function isValidDay(value) {
  const match = typeof value === "string" ? DAY.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function addDays(day, count) {
  if (!isValidDay(day)) return "";
  return new Date(Date.parse(`${day}T00:00:00Z`) + Math.trunc(Number(count) || 0) * MS_PER_DAY).toISOString().slice(0, 10);
}

// Signed number of days from start to end (same day = 0); null when either is not a calendar day.
export function dayDiff(start, end) {
  if (!isValidDay(start) || !isValidDay(end)) return null;
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / MS_PER_DAY);
}

// Today's calendar day in Pacific time (the API's day boundary); the provider re-reads /bootstrap when it changes.
export function pacificToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// The last completed Pacific-time day (PT today − 1): the latest day the API can report.
function pacificYesterday() {
  return addDays(pacificToday(), -1);
}

// isRangeBehind(filters, latestDay): the committed range ends before the owner's latest stored day (a persisted
// absolute range the morning after a sync), so the filter bar offers "Use latest data".
export function isRangeBehind(filters, latestDay) {
  return isValidDay(latestDay) && isValidDay(filters?.endDate) && filters.endDate < latestDay;
}

// rangeEndingAt(range, endDate) → the same number of days ending at `endDate` (the 28-day preset when the range is
// not usable); the start never goes before the earliest day the API serves.
export function rangeEndingAt(range, endDate) {
  if (!isValidDay(endDate)) return null;
  const length = dayDiff(range?.startDate, range?.endDate);
  if (length === null || length < 0 || length >= MAX_RANGE_DAYS) return { startDate: addDays(endDate, 1 - Number(DEFAULT_PRESET)), endDate };
  const startDate = addDays(endDate, -length);
  return { startDate: startDate < EARLIEST_DAY ? EARLIEST_DAY : startDate, endDate };
}

// Ranges end at the owner's latest stored day when known, else at latestAllowedDay − lagDays.
function rangeContext(ctx = {}) {
  const latestAllowedDay = isValidDay(ctx.latestAllowedDay) ? ctx.latestAllowedDay : pacificYesterday();
  const lag = Number.isFinite(Number(ctx.lagDays)) ? Math.min(7, Math.max(0, Math.trunc(Number(ctx.lagDays)))) : DEFAULT_LAG_DAYS;
  const fallback = addDays(latestAllowedDay, -lag);
  const latestDay = isValidDay(ctx.latestDay) && ctx.latestDay <= latestAllowedDay ? ctx.latestDay : fallback;
  return { latestAllowedDay, latestDay };
}

function isValidRange(startDate, endDate, ctx) {
  if (!isValidDay(startDate) || !isValidDay(endDate) || startDate > endDate || startDate < EARLIEST_DAY) return false;
  if (endDate > rangeContext(ctx).latestAllowedDay) return false;
  return dayDiff(startDate, endDate) < MAX_RANGE_DAYS;
}

function clampRange(startDate, endDate) {
  return dayDiff(startDate, endDate) >= MAX_RANGE_DAYS ? { startDate: addDays(endDate, 1 - MAX_RANGE_DAYS), endDate } : { startDate, endDate };
}

// ---------------------------------------------------------------------------
// Date presets
// ---------------------------------------------------------------------------

// presetRange("7" | "28" | "90" | "thisMonth" | "lastMonth" | "last12Months", { latestDay, latestAllowedDay, lagDays })
// → { startDate, endDate }; null for "custom" / unknown presets.
export function presetRange(preset, ctx = {}) {
  const { latestDay: end } = rangeContext(ctx);
  const key = String(preset ?? "");
  if (/^\d+$/.test(key)) {
    const days = Number(key);
    return days >= 1 && days <= MAX_RANGE_DAYS ? { startDate: addDays(end, 1 - days), endDate: end } : null;
  }
  const firstOfMonth = `${end.slice(0, 7)}-01`;
  if (key === "thisMonth") return { startDate: firstOfMonth, endDate: end };
  if (key === "lastMonth") {
    const lastOfPrevious = addDays(firstOfMonth, -1);
    return { startDate: `${lastOfPrevious.slice(0, 7)}-01`, endDate: lastOfPrevious };
  }
  if (key === "last12Months") {
    // The end month plus the eleven before it: at most 366 days (April → March of a leap year).
    const [year, month] = firstOfMonth.split("-").map(Number);
    return { startDate: new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10), endDate: end };
  }
  return null;
}

export function detectPreset(filters, ctx = {}) {
  const match = DATE_PRESETS.find(({ key }) => {
    if (key === "custom") return false;
    const range = presetRange(key, ctx);
    return Boolean(range) && range.startDate === filters?.startDate && range.endDate === filters?.endDate;
  });
  return match ? match.key : "custom";
}

// ---------------------------------------------------------------------------
// Filters ⇄ URL search params
// ---------------------------------------------------------------------------

const ownerIdOf = (owner) => String(owner?.ownerId || owner?.id || "");

function resolveOwnerId(requested, owners) {
  if (requested && owners.some((owner) => ownerIdOf(owner) === requested)) return requested;
  const fallback =
    owners.find((owner) => owner?.authStatus === "connected" && owner?.hasAnalyticsScope) ||
    owners.find((owner) => owner?.authStatus === "connected") ||
    owners[0];
  return fallback ? ownerIdOf(fallback) : "";
}

function parseChannelIds(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const seen = new Set();
  for (const item of list) {
    const id = String(item ?? "").trim();
    if (CHANNEL_ID.test(id)) seen.add(id);
    if (seen.size >= MAX_CHANNEL_IDS) break;
  }
  return [...seen];
}

function paramReader(params) {
  const raw = params && typeof params.get === "function" ? (key) => params.get(key) : (key) => params?.[key];
  return (key) => {
    const value = raw(key);
    return typeof value === "string" ? value.trim() : "";
  };
}

// filtersToSearchParams(filters) → { owner, start, end, scope, channels? } (channels omitted when all / none).
export function filtersToSearchParams(filters = {}) {
  const params = {};
  if (filters.ownerId) params.owner = String(filters.ownerId);
  if (isValidDay(filters.startDate)) params.start = filters.startDate;
  if (isValidDay(filters.endDate)) params.end = filters.endDate;
  if (SCOPES.includes(filters.scope)) params.scope = filters.scope;
  const channelIds = parseChannelIds(filters.channelIds);
  if (channelIds.length) params.channels = channelIds.join(",");
  return params;
}

// searchParamsToFilters(params, { owners, latestDay, latestAllowedDay, lagDays }) whitelists every value: an unknown
// owner falls back to the first connected owner, an invalid or out-of-bounds range to the 28-day preset ending at the
// owner's latest stored day, an unknown scope to "claimed", channel IDs to the valid deduplicated first 200.
export function searchParamsToFilters(params, ctx = {}) {
  const read = paramReader(params);
  const owners = Array.isArray(ctx.owners) ? ctx.owners : [];
  const ownerId = resolveOwnerId(read("owner"), owners);
  const owner = owners.find((item) => ownerIdOf(item) === ownerId);
  const context = {
    latestDay: isValidDay(ctx.latestDay) ? ctx.latestDay : owner?.coverage?.lastDay ?? null,
    latestAllowedDay: ctx.latestAllowedDay,
    lagDays: ctx.lagDays
  };
  const start = read("start");
  const end = read("end");
  const range = isValidRange(start, end, context) ? { startDate: start, endDate: end } : presetRange(DEFAULT_PRESET, context);
  const scope = read("scope");
  return { ownerId, ...range, scope: SCOPES.includes(scope) ? scope : "claimed", channelIds: parseChannelIds(read("channels")) };
}

// isRangeFallback(params, filters): the URL named a start or end day and searchParamsToFilters replaced the range
// (invalid day, inverted, too long, after latestAllowedDay). The provider then rewrites the URL and says so once.
export function isRangeFallback(params, filters) {
  const read = paramReader(params);
  const start = read("start");
  const end = read("end");
  if (!start && !end) return false;
  return start !== filters?.startDate || end !== filters?.endDate;
}

// ---------------------------------------------------------------------------
// Sync requests
// ---------------------------------------------------------------------------

const validScopes = (value) => (Array.isArray(value) ? [...new Set(value.filter((scope) => SCOPES.includes(scope)))] : []);

// buildSyncRequest(form, filters, permissions) → the POST /sync body of a `full` job. Overwrite needs canOverwrite,
// revenue needs canMonetary (both silently downgraded), the range is clamped to 366 days, channel IDs to 200.
export function buildSyncRequest(form = {}, filters = {}, permissions = {}) {
  const mode = form.mode === "overwrite" && permissions.canOverwrite ? "overwrite" : "append";
  const useForm = isValidDay(form.startDate) && isValidDay(form.endDate) && form.startDate <= form.endDate;
  const { startDate, endDate } = clampRange(useForm ? form.startDate : filters.startDate, useForm ? form.endDate : filters.endDate);
  const selected = parseChannelIds(form.channelIds ?? filters.channelIds);
  const channelMode = ["all", "selected", "none"].includes(form.channelMode) ? form.channelMode : selected.length ? "selected" : "all";
  const formScopes = validScopes(form.scopes);
  const scopes = formScopes.length ? formScopes : [SCOPES.includes(filters.scope) ? filters.scope : "claimed"];
  return {
    kind: "full",
    mode,
    ownerId: String(form.ownerId || filters.ownerId || ""),
    startDate,
    endDate,
    scopes,
    channelMode,
    channelIds: channelMode === "selected" ? selected : [],
    includeBreakdowns: form.includeBreakdowns !== false,
    includeSnapshots: form.includeSnapshots !== false,
    monetary: Boolean(permissions.canMonetary) && form.monetary !== false,
    ...(form.dryRun ? { dryRun: true } : {})
  };
}

// buildFillMissingRequest(filters, permissions, coverage) → an append `full` job over the span of the missing days
// (pending days excluded, at most 366 days ending at the last missing day); null when nothing is missing.
export function buildFillMissingRequest(filters = {}, permissions = {}, coverage = {}) {
  const pending = new Set(Array.isArray(coverage?.pending) ? coverage.pending : []);
  const missing = (Array.isArray(coverage?.missing) ? coverage.missing : []).filter((day) => isValidDay(day) && !pending.has(day)).sort();
  if (!missing.length) return null;
  const { startDate, endDate } = clampRange(missing[0], missing[missing.length - 1]);
  const channelIds = parseChannelIds(filters.channelIds);
  return {
    kind: "full",
    mode: "append",
    ownerId: String(filters.ownerId || ""),
    startDate,
    endDate,
    scopes: [SCOPES.includes(filters.scope) ? filters.scope : "claimed"],
    channelMode: channelIds.length ? "selected" : "all",
    channelIds,
    includeBreakdowns: true,
    includeSnapshots: false,
    monetary: Boolean(permissions.canMonetary)
  };
}

// Client-side placeholder for the server plan (shown while POST /sync { dryRun:true } answers). Mirrors the
// engine's counting: owner facts per scope (+1 MONEY request, 200 rows per page), channel batches per day,
// with-day breakdowns per ≤ 90-day chunk, per-day country / sharing shapes, range snapshots, Data API pages.
export function estimateRequests({ days, channelCount, batch, monetary, breakdowns, snapshots, scopes } = {}) {
  const dayCount = Math.max(0, Math.trunc(Number(days) || 0));
  if (!dayCount) return 0;
  const scopeCount = Math.max(1, Array.isArray(scopes) ? scopes.length : Math.trunc(Number(scopes) || 1));
  const money = monetary ? 1 : 0;
  const channels = Math.max(0, Math.trunc(Number(channelCount) || 0));
  const batchSize = Math.min(500, Math.max(1, Math.trunc(Number(batch) || 200)));
  let total = scopeCount * Math.ceil(dayCount / 200) * (1 + money);
  total += dayCount * Math.ceil(channels / batchSize) * (1 + money);
  if (breakdowns) {
    const chunkDays = Math.min(dayCount, 90);
    const pages = Math.ceil((chunkDays * 6) / 200);
    total += scopeCount * Math.ceil(dayCount / 90) * (8 + 2 * money) * pages;
    total += dayCount * (2 + money);
  }
  if (snapshots) total += 4 * (3 + money);
  total += Math.max(1, Math.ceil(channels / 50));
  return total;
}

// ---------------------------------------------------------------------------
// Client-side CSV and text helpers
// ---------------------------------------------------------------------------

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return "";
  let text = String(value);
  // Formula neutralisation: a leading = + - @ or control character would execute in Excel.
  if (/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

// downloadCsv(columns:[{ key, label, value? }], rows, filename): UTF-8 BOM, CRLF, quoted formula-safe cells, numbers as
// numbers. Saves the file in a browser and returns the CSV text (the node tests read it).
export function downloadCsv(columns, rows, filename) {
  const header = columns.map((column) => csvCell(column.label ?? column.key)).join(",");
  const lines = (Array.isArray(rows) ? rows : []).map((row) =>
    columns.map((column) => csvCell(typeof column.value === "function" ? column.value(row) : row?.[column.key])).join(",")
  );
  const text = `\uFEFF${[header, ...lines].join("\r\n")}\r\n`;
  if (typeof document !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "analytics.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return text;
}

// Search folding: "Đồng Bộ Kênh" → "dong bo kenh".
export function foldText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
