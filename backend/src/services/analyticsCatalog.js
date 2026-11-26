// Supported Content Owner report combinations, reviewed against Google's report tables.
// https://developers.google.com/youtube/analytics/content_owner_reports
// Data only: report labels and descriptions live in the frontend dictionaries (REPORT_LABELS / REPORT_DESCRIPTIONS).
const { METRIC_REGISTRY, MONETARY_KEYS } = require("./analyticsWarehouse");

const registryKeys = (predicate) => METRIC_REGISTRY.filter((entry) => !entry.derived && predicate(entry)).map((entry) => entry.key);
const BASIC = "views,engagedViews,redViews,estimatedMinutesWatched,estimatedRedMinutesWatched,averageViewDuration,averageViewPercentage,likes,dislikes,comments,shares,subscribersGained,subscribersLost,videosAddedToPlaylists,videosRemovedFromPlaylists";
const WATCH = "views,engagedViews,estimatedMinutesWatched";
const PLAYBACK = "views,engagedViews,redViews,estimatedMinutesWatched,estimatedRedMinutesWatched,averageViewDuration,averageViewPercentage";
const MONEY = registryKeys((entry) => entry.monetary).join(",");
const ENGAGEMENT = "annotationClickThroughRate,annotationCloseRate,annotationImpressions,annotationClickableImpressions,annotationClosableImpressions,annotationClicks,annotationCloses,cardClickRate,cardTeaserClickRate,cardImpressions,cardTeaserImpressions,cardClicks,cardTeaserClicks";
function report(id, category, dimensions, metrics, options = {}) {
  return { id, category, dimensions, metrics, monetary: false, requiresVideo: false, limit: null, default: true, ...options };
}
const REPORT_CATALOG = [
  report("overview", "overview", "", BASIC),
  report("daily", "overview", "day", BASIC, { sort: "day" }),
  report("monetaryOverview", "revenue", "", MONEY, { monetary: true }),
  report("monetaryDaily", "revenue", "day", MONEY, { monetary: true, sort: "day" }),
  // Managed-channel reports are served from the warehouse now; they stay queryable but are no longer synced by default.
  report("channels", "content", "channel", BASIC, { managedChannels: true, default: false }),
  report("channelRevenue", "revenue", "channel", MONEY, { monetary: true, managedChannels: true, default: false }),
  report("videos", "content", "video", BASIC, { sort: "-views", limit: 200 }),
  report("videoRevenue", "revenue", "video", `views,estimatedMinutesWatched,${MONEY}`, { monetary: true, sort: "-estimatedRevenue", limit: 200 }),
  report("countries", "audience", "country", BASIC, { sort: "-views" }),
  report("countryRevenue", "revenue", "country", `views,${MONEY}`, { monetary: true, sort: "-estimatedRevenue" }),
  report("trafficSources", "reach", "insightTrafficSourceType", WATCH, { sort: "-views" }),
  report("playbackLocations", "reach", "insightPlaybackLocationType", WATCH, { sort: "-views" }),
  report("embeddedPlayers", "reach", "insightPlaybackLocationDetail", WATCH, { sort: "-views", limit: 25, extraFilters: "insightPlaybackLocationType==EMBEDDED" }),
  report("devices", "audience", "deviceType", WATCH, { sort: "-views" }),
  report("operatingSystems", "audience", "operatingSystem", WATCH, { sort: "-views" }),
  report("deviceSystems", "audience", "operatingSystem,deviceType", WATCH, { sort: "-views" }),
  report("demographics", "audience", "ageGroup,gender", "viewerPercentage"),
  report("subscribedStatus", "audience", "subscribedStatus", PLAYBACK, { sort: "-views" }),
  report("contentTypes", "content", "creatorContentType", PLAYBACK, { sort: "-views" }),
  report("liveStatus", "content", "liveOrOnDemand", "views,engagedViews,redViews,estimatedMinutesWatched,estimatedRedMinutesWatched,averageViewDuration", { sort: "-views" }),
  report("youtubeProducts", "reach", "youtubeProduct", PLAYBACK, { sort: "-views" }),
  report("sharing", "engagement", "sharingService", "shares", { sort: "-shares" }),
  report("engagement", "engagement", "", ENGAGEMENT),
  report("engagementDaily", "engagement", "day", ENGAGEMENT, { sort: "day" }),
  report("adTypes", "revenue", "adType", "grossRevenue,adImpressions,cpm", { monetary: true }),
  report("retention", "engagement", "elapsedVideoTimeRatio", "audienceWatchRatio,relativeRetentionPerformance", { requiresVideo: true, sort: "elapsedVideoTimeRatio" })
];
// Per-day breakdowns stored in analytic_daily_breakdowns (owner scopes only). perDay: `day` is not a valid companion
// dimension, so the sync engine requests one day at a time; monetary: needs the monetary OAuth scope and role.
const BREAKDOWN_DIMENSIONS = Object.freeze([
  { key: "insightTrafficSourceType", perDay: false, monetary: false },
  { key: "insightPlaybackLocationType", perDay: false, monetary: false },
  { key: "deviceType", perDay: false, monetary: false },
  { key: "operatingSystem", perDay: false, monetary: false },
  { key: "subscribedStatus", perDay: false, monetary: false },
  { key: "liveOrOnDemand", perDay: false, monetary: false },
  { key: "youtubeProduct", perDay: false, monetary: false },
  { key: "creatorContentType", perDay: false, monetary: false },
  { key: "adType", perDay: false, monetary: true },
  { key: "country", perDay: true, monetary: false },
  { key: "sharingService", perDay: true, monetary: false }
].map(Object.freeze));
const MONETARY_METRICS = MONETARY_KEYS;
const METRICS = new Set([...registryKeys(() => true), ...ENGAGEMENT.split(","), "audienceWatchRatio", "relativeRetentionPerformance", "uniques",
  "playlistViews", "playlistEstimatedMinutesWatched", "playlistAverageViewDuration", "playlistSaves", "playlistStarts", "viewsPerPlaylistStart", "averageTimeInPlaylist"]);
const DIMENSIONS = new Set(["day", "month", "video", "channel", "playlist", "group", "country", "province", "city", "continent", "subContinent",
  "creatorContentType", "subscribedStatus", "liveOrOnDemand", "youtubeProduct", "insightTrafficSourceType", "insightTrafficSourceDetail",
  "insightPlaybackLocationType", "insightPlaybackLocationDetail", "deviceType", "operatingSystem", "ageGroup", "gender", "sharingService", "adType",
  "elapsedVideoTimeRatio", "audienceType", "claimedStatus", "uploaderType"]);
module.exports = { REPORT_CATALOG, BREAKDOWN_DIMENSIONS, MONETARY_METRICS, METRICS, DIMENSIONS };
