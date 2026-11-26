// Bilingual (en / vi) labels for the files people download: metric keys, breakdown dimensions, dimension values,
// statuses, export columns, sheet names and summary notes. The UI has its own dictionaries; the Vietnamese wording
// here follows frontend/src/i18n/vi/analyticsShared.js so an exported file reads like the screen it came from.
// Table entries are [en, vi] pairs; a plain string is a brand name identical in both languages.
const METRICS = {
  views: ["Views", "Lượt xem"], engagedViews: ["Engaged views", "Lượt xem tương tác"], redViews: ["Premium views", "Lượt xem Premium"],
  estimatedMinutesWatched: ["Minutes watched", "Số phút xem"], estimatedRedMinutesWatched: ["Premium minutes watched", "Số phút xem Premium"],
  averageViewDuration: ["Average view duration (s)", "Thời lượng xem trung bình (giây)"], averageViewPercentage: ["Average percentage viewed", "Tỷ lệ xem trung bình"],
  likes: ["Likes", "Lượt thích"], dislikes: ["Dislikes", "Lượt không thích"], comments: ["Comments", "Bình luận"], shares: ["Shares", "Lượt chia sẻ"],
  subscribersGained: ["Subscribers gained", "Người đăng ký mới"], subscribersLost: ["Subscribers lost", "Người hủy đăng ký"],
  videosAddedToPlaylists: ["Added to playlists", "Thêm vào danh sách phát"], videosRemovedFromPlaylists: ["Removed from playlists", "Xóa khỏi danh sách phát"],
  estimatedRevenue: ["Estimated revenue (USD)", "Doanh thu ước tính (USD)"], estimatedAdRevenue: ["Ad revenue (USD)", "Doanh thu quảng cáo (USD)"],
  estimatedRedPartnerRevenue: ["YouTube Premium revenue (USD)", "Doanh thu YouTube Premium (USD)"], grossRevenue: ["Gross revenue (USD)", "Doanh thu gộp (USD)"],
  monetizedPlaybacks: ["Monetized playbacks", "Lượt phát có quảng cáo"], playbackBasedCpm: ["Playback-based CPM (USD)", "CPM theo lượt phát (USD)"],
  adImpressions: ["Ad impressions", "Lượt hiển thị quảng cáo"], cpm: ["CPM (USD)", "CPM (USD)"], rpm: ["RPM (USD)", "RPM (USD)"],
  viewerPercentage: ["Viewer percentage", "Tỷ lệ người xem"], watchHours: ["Watch hours", "Giờ xem"], netSubscribers: ["Net subscribers", "Đăng ký ròng"],
  subscribersTotal: ["Subscribers", "Người đăng ký"], lifetimeViews: ["Lifetime views", "Tổng lượt xem từ đầu"], videoCount: ["Video count", "Số video"]
};
const DIMENSIONS = {
  day: ["Day", "Ngày"], month: ["Month", "Tháng"], video: ["Video", "Video"], channel: ["Channel", "Kênh"], country: ["Country", "Quốc gia"],
  creatorContentType: ["Content type", "Loại nội dung"], subscribedStatus: ["Subscribed status", "Trạng thái đăng ký"],
  liveOrOnDemand: ["Live or on demand", "Trực tiếp hoặc theo yêu cầu"], youtubeProduct: ["YouTube product", "Sản phẩm YouTube"],
  insightTrafficSourceType: ["Traffic source", "Nguồn truy cập"], insightPlaybackLocationType: ["Playback location", "Vị trí phát"],
  deviceType: ["Device type", "Loại thiết bị"], operatingSystem: ["Operating system", "Hệ điều hành"], ageGroup: ["Age group", "Độ tuổi"],
  gender: ["Gender", "Giới tính"], sharingService: ["Sharing service", "Dịch vụ chia sẻ"], adType: ["Ad type", "Loại quảng cáo"]
};
const VALUES = {
  deviceType: { DESKTOP: ["Desktop", "Máy tính"], GAME_CONSOLE: ["Game console", "Máy chơi game"], MOBILE: ["Mobile", "Điện thoại"], TABLET: ["Tablet", "Máy tính bảng"], TV: "TV", UNKNOWN_PLATFORM: ["Unknown platform", "Nền tảng không xác định"] },
  insightTrafficSourceType: {
    ADVERTISING: ["Advertising", "Quảng cáo"], ANNOTATION: ["Annotation", "Chú thích"], CAMPAIGN_CARD: ["Campaign card", "Thẻ chiến dịch"], END_SCREEN: ["End screen", "Màn hình kết thúc"],
    EXT_URL: ["External", "Bên ngoài"], HASHTAGS: ["Hashtags", "Hashtag"], IMMERSIVE_LIVE: ["Immersive live", "Live toàn màn hình"], LIVE_REDIRECT: ["Live redirect", "Chuyển hướng live"],
    NOTIFICATION: ["Notification", "Thông báo"], NO_LINK_EMBEDDED: ["Embedded (no link)", "Nhúng (không có liên kết)"], NO_LINK_OTHER: ["Direct or unknown", "Trực tiếp hoặc không xác định"],
    PLAYLIST: ["Playlist", "Danh sách phát"], PRODUCT_PAGE: ["Product page", "Trang sản phẩm"], PROMOTED: ["Promoted", "Được quảng bá"], RELATED_VIDEO: ["Suggested videos", "Video đề xuất"],
    SHORTS: ["Shorts feed", "Nguồn cấp Shorts"], SHORTS_CONTENT_LINKS: ["Shorts content links", "Liên kết nội dung Shorts"], SOUND_PAGE: ["Sound page", "Trang âm thanh"],
    SUBSCRIBER: ["Browse features", "Tính năng duyệt xem"], VIDEO_REMIXES: ["Video remixes", "Video phối lại"], YT_CHANNEL: ["Channel page", "Trang kênh"],
    YT_OTHER_PAGE: ["Other YouTube pages", "Trang YouTube khác"], YT_PLAYLIST_PAGE: ["Playlist page", "Trang danh sách phát"], YT_SEARCH: ["YouTube search", "Tìm kiếm YouTube"]
  },
  insightPlaybackLocationType: {
    BROWSE: ["Browse features", "Tính năng duyệt xem"], CHANNEL: ["Channel page", "Trang kênh"], EMBEDDED: ["Embedded player", "Trình phát nhúng"], EXTERNAL_APP: ["External app", "Ứng dụng bên ngoài"],
    MOBILE: ["Mobile", "Điện thoại"], SEARCH: ["Search page", "Trang tìm kiếm"], WATCH: ["Watch page", "Trang xem"], YT_OTHER: ["Other YouTube pages", "Trang YouTube khác"]
  },
  subscribedStatus: { SUBSCRIBED: ["Subscribed", "Đã đăng ký"], UNSUBSCRIBED: ["Not subscribed", "Chưa đăng ký"] },
  gender: { male: ["Male", "Nam"], female: ["Female", "Nữ"], user_specified: ["User specified", "Người dùng tự xác định"] },
  liveOrOnDemand: { LIVE: ["Live", "Trực tiếp"], ON_DEMAND: ["On demand", "Theo yêu cầu"] },
  creatorContentType: { VIDEO_ON_DEMAND: ["Videos", "Video"], SHORTS: "Shorts", LIVE_STREAM: ["Live streams", "Phát trực tiếp"], STORY: ["Stories", "Story"], UNSPECIFIED: ["Unspecified", "Chưa phân loại"] },
  youtubeProduct: { CORE: "YouTube", GAMING: "YouTube Gaming", KIDS: "YouTube Kids", MUSIC: "YouTube Music", UNKNOWN: ["Unknown", "Chưa rõ"] },
  operatingSystem: {
    ANDROID: "Android", BADA: "Bada", BLACKBERRY: "BlackBerry", CHROMECAST: "Chromecast", DOCOMO: "DoCoMo", FIREFOX: "Firefox OS", HIPTOP: "Hiptop", IOS: "iOS", KAIOS: "KaiOS",
    LINUX: "Linux", MACINTOSH: "macOS", MEEGO: "MeeGo", NINTENDO_3DS: "Nintendo 3DS", OTHER: ["Other", "Khác"], PLAYSTATION: "PlayStation", PLAYSTATION_VITA: "PlayStation Vita",
    REALMEDIA: "RealMedia", SMART_TV: "Smart TV", SYMBIAN: "Symbian", TIZEN: "Tizen", VIDAA: "VIDAA", WEBOS: "webOS", WII: "Wii", WINDOWS: "Windows", WINDOWS_MOBILE: "Windows Mobile", XBOX: "Xbox"
  },
  adType: {
    auctionBumperInstream: ["Auction bumper (in-stream)", "Bumper đấu giá (trong luồng)"], auctionDisplay: ["Auction display", "Hiển thị đấu giá"], auctionInstream: ["Auction in-stream", "Trong luồng đấu giá"],
    auctionTrueviewInslate: ["Auction TrueView in-slate", "TrueView in-slate đấu giá"], auctionTrueviewInstream: ["Auction TrueView in-stream", "TrueView trong luồng đấu giá"],
    auctionUnknown: ["Auction (unknown)", "Đấu giá (không rõ)"], reservedBumperInstream: ["Reserved bumper (in-stream)", "Bumper đặt trước (trong luồng)"],
    reservedClickToPlay: ["Reserved click-to-play", "Nhấp để phát đặt trước"], reservedDisplay: ["Reserved display", "Hiển thị đặt trước"], reservedInstream: ["Reserved in-stream", "Trong luồng đặt trước"],
    reservedInstreamSelect: ["Reserved in-stream select", "Trong luồng chọn lọc đặt trước"], reservedMasthead: ["Reserved masthead", "Masthead đặt trước"],
    reservedUnknown: ["Reserved (unknown)", "Đặt trước (không rõ)"], unknown: ["Unknown", "Chưa rõ"]
  },
  sharingService: {
    COPY_PASTE: ["Copy link", "Sao chép liên kết"], EMBED: ["Embed", "Nhúng"], EMAIL: ["Email", "Email"], GMAIL: "Gmail", OTHER: ["Other", "Khác"], TEXT_MESSAGE: ["Text message", "Tin nhắn"],
    UNKNOWN: ["Unknown", "Chưa rõ"], IOS_SYSTEM_ACTIVITY_DIALOG: ["System share sheet", "Bảng chia sẻ hệ thống"], NEARBY_SHARE: "Nearby Share", WHATS_APP: "WhatsApp",
    FACEBOOK_MESSENGER: "Messenger", FACEBOOK_PAGES: "Facebook Pages", GOOGLEPLUS: "Google+", LINKEDIN: "LinkedIn", VKONTAKTE: "VK", KAKAO: "KakaoTalk", KAKAO_STORY: "KakaoStory",
    TWITTER: "X (Twitter)", YOUTUBE_MUSIC: "YouTube Music", YOUTUBE_KIDS: "YouTube Kids", YOUTUBE_GAMING: "YouTube Gaming", YOUTUBE_TV: "YouTube TV", GO_SMS: "GO SMS", BBM: "BBM",
    HI5: "hi5", LINE: "LINE", WECHAT: "WeChat", ODNOKLASSNIKI: "Odnoklassniki", STUMBLEUPON: "StumbleUpon", LIVEJOURNAL: "LiveJournal", MYSPACE: "Myspace"
  }
};
const STATUSES = {
  ready: ["Ready", "Sẵn sàng"], complete: ["Complete", "Đầy đủ"], completed: ["Completed", "Hoàn tất"], partial: ["Partial", "Một phần"], missing: ["Missing", "Còn thiếu"],
  empty: ["Empty", "Không có dòng dữ liệu"], unsupported: ["Unsupported", "Không hỗ trợ"], pending: ["Not yet published", "Chưa công bố"], stale: ["Stale", "Cần làm mới"],
  stored: ["Stored", "Đã lưu"], hidden: ["Hidden", "Đã ẩn"], running: ["Running", "Đang chạy"], queued: ["Queued", "Đang chờ"], failed: ["Failed", "Thất bại"],
  cancelled: ["Cancelled", "Đã hủy"], interrupted: ["Interrupted", "Bị gián đoạn"], error: ["Error", "Lỗi"], "not-run": ["Not run", "Chưa chạy"]
};
const COLUMNS = {
  channel: ["Channel", "Kênh"], channelId: ["Channel ID", "Channel ID"], title: ["Title", "Tiêu đề"], day: ["Day (Pacific time)", "Ngày (giờ Thái Bình Dương)"],
  status: ["Status", "Trạng thái"], revenueStatus: ["Revenue status", "Trạng thái doanh thu"], firstSynced: ["First synced (GMT+7)", "Đồng bộ lần đầu (GMT+7)"],
  lastSynced: ["Last synced (GMT+7)", "Đồng bộ gần nhất (GMT+7)"], revision: ["Revision", "Phiên bản"], source: ["Source", "Nguồn"], country: ["Country", "Quốc gia"],
  published: ["Published", "Ngày đăng"], removed: ["No longer managed", "Không còn quản lý"], coveredDays: ["Covered days", "Số ngày có dữ liệu"],
  daysWithRows: ["Days with rows", "Số ngày có dòng dữ liệu"], totalDays: ["Days in range", "Số ngày trong khoảng"], firstDay: ["First day", "Ngày đầu tiên"],
  lastDay: ["Last day", "Ngày cuối cùng"], value: ["Value", "Giá trị"], code: ["Code", "Mã"], share: ["Share of total (%)", "Tỷ trọng (%)"], videoId: ["Video ID", "Video ID"],
  month: ["Month", "Tháng"], stored: ["Stored", "Đã lưu"], revenueIncluded: ["Revenue included", "Có doanh thu"], breakdowns: ["Breakdowns", "Phân tích theo"],
  drift: ["Drift", "Số liệu lệch"], pending: ["Not yet published", "Chưa công bố"], recordedAt: ["Recorded at (GMT+7)", "Ghi nhận lúc (GMT+7)"],
  entity: ["Entity", "Đối tượng dữ liệu"], dimension: ["Dimension", "Chiều phân tích"], action: ["Action", "Thao tác"], changedKeys: ["Changed keys", "Chỉ số thay đổi"],
  addedValues: ["Added values", "Giá trị mới"], missingValues: ["Missing values", "Giá trị thiếu"], job: ["Job", "Tác vụ"], requestedBy: ["Requested by", "Người yêu cầu"],
  changedBy: ["Changed by", "Người thực hiện"], kind: ["Kind", "Loại tác vụ"], mode: ["Mode", "Chế độ"], total: ["Total", "Tổng"]
};
const SHEETS = {
  daily: ["Daily", "Theo ngày"], channels: ["Channels", "Kênh"], channelDays: ["Channel days", "Kênh theo ngày"], dailyRevenue: ["Daily revenue", "Doanh thu theo ngày"],
  byChannel: ["By channel", "Theo kênh"], byCountry: ["By country", "Theo quốc gia"], byContentType: ["By content type", "Theo loại nội dung"], byAdType: ["By ad type", "Theo loại quảng cáo"],
  topVideos: ["Top videos", "Video nổi bật"], videoRevenue: ["Video revenue", "Doanh thu từng video"], demographics: ["Age & gender", "Độ tuổi & giới tính"],
  coverage: ["Coverage", "Độ phủ dữ liệu"], history: ["Change ledger", "Nhật ký thay đổi"], overview: ["Analytics overview", "Tổng quan Analytics"], revenue: ["Revenue", "Doanh thu"]
};
const WORDS = {
  scope: { claimed: ["Claimed content", "Nội dung đã claim"], self: ["Partner channels", "Kênh thuộc CMS"], thirdParty: ["Third-party content", "Nội dung bên thứ ba"] },
  action: { overwrite: ["Overwrite", "Ghi đè"], drift: ["Drift", "Số liệu lệch"], migration: ["Migration", "Chuyển từ báo cáo theo kỳ"] },
  kind: { daily: ["Daily sync", "Đồng bộ hằng ngày"], full: ["Sync all", "Đồng bộ toàn bộ"], channelDetail: ["Channel reports", "Báo cáo kênh"], snapshot: ["Range report", "Báo cáo theo kỳ"], migration: ["Migration", "Chuyển từ báo cáo theo kỳ"] },
  mode: { append: ["Only add missing", "Chỉ thêm số mới"], overwrite: ["Overwrite", "Ghi đè"] },
  requestedBy: { schedule: ["Schedule", "Lịch tự động"], user: ["Manual", "Thủ công"], recovery: ["Recovery", "Khôi phục sau khởi động lại"] },
  bool: { true: ["Yes", "Có"], false: ["No", "Không"] }
};
const NOTES = {
  pacific: ["Days are Pacific-time days as reported by YouTube Analytics.", "Ngày tính theo giờ Thái Bình Dương như YouTube Analytics báo cáo."],
  revenue: ["Revenue values are USD estimates; YouTube revises them for about 45 days.", "Doanh thu là ước tính bằng USD; YouTube có thể điều chỉnh trong khoảng 45 ngày."],
  missing: ["A missing day has not been synced yet; it is not zero.", "Ngày còn thiếu là ngày chưa được đồng bộ, không phải bằng 0."],
  approx: ["Average view duration over several channels or days is minutes watched × 60 / engaged views.", "Thời lượng xem trung bình trên nhiều kênh hoặc nhiều ngày = số phút xem × 60 / lượt xem tương tác."],
  topVideos: ["Top-video reports contain at most 200 videos; use the Bulk archive for every video.", "Báo cáo video nổi bật chỉ gồm tối đa 200 video; dùng kho Bulk để lấy toàn bộ video."],
  snapshot: ["Breakdowns of one channel come from its range reports for exactly this range.", "Phân tích theo của một kênh lấy từ báo cáo theo kỳ đúng khoảng ngày này."],
  ownerBreakdowns: ["By country, by content type and by ad type are Content Owner totals for the selected scope; a channel selection applies to the daily and by-channel sheets only.", "Theo quốc gia, theo loại nội dung và theo loại quảng cáo là tổng ở cấp Content Owner theo phạm vi đã chọn; kênh đã chọn chỉ áp dụng cho trang theo ngày và theo kênh."],
  ledger: ["The newest 1,000 ledger entries whose day falls in the range; stored numbers are never changed silently.", "1.000 mục mới nhất của nhật ký thay đổi có ngày thuộc khoảng đã chọn; số đã lưu không bao giờ bị đổi âm thầm."]
};
const LANGUAGES = ["en", "vi"];
const pick = (entry, index) => (Array.isArray(entry) ? entry[index] : entry);
const table = (source, index) => Object.fromEntries(Object.entries(source).map(([key, entry]) => [key, pick(entry, index)]));
const nested = (source, index) => Object.fromEntries(Object.entries(source).map(([key, entries]) => [key, table(entries, index)]));
const LABELS = Object.fromEntries(LANGUAGES.map((language, index) => [language, {
  metrics: table(METRICS, index), dimensions: table(DIMENSIONS, index), values: nested(VALUES, index), statuses: table(STATUSES, index),
  columns: table(COLUMNS, index), sheets: table(SHEETS, index), words: nested(WORDS, index), notes: table(NOTES, index)
}]));
const regionNames = new Map();
function regionName(language, code) {
  if (!regionNames.has(language)) regionNames.set(language, new Intl.DisplayNames([language], { type: "region", fallback: "none" }));
  try { return regionNames.get(language).of(code) || null; } catch { return null; }
}
// Unknown enum values keep Google's spelling but read as words: SOME_NEW_SOURCE → "Some new source".
function humanize(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^[A-Z0-9_]+$/.test(text)) { const words = text.toLowerCase().replace(/_/g, " "); return words[0].toUpperCase() + words.slice(1); }
  return text;
}
function forLanguage(language) {
  const lang = LANGUAGES.includes(language) ? language : "en";
  const set = LABELS[lang];
  const lookup = (group, key) => set[group][key] ?? LABELS.en[group][key] ?? String(key);
  return {
    language: lang,
    metric: (key) => lookup("metrics", key),
    dimension: (key) => lookup("dimensions", key),
    value: (dimension, value) => {
      const text = String(value ?? "");
      if (dimension === "country") return regionName(lang, text) || text;
      if (dimension === "ageGroup") return /^age(\d+)-(\d*)$/.test(text) ? text.replace(/^age(\d+)-(\d*)$/, (_match, from, to) => (to ? `${from}–${to}` : `${from}+`)) : text;
      return set.values[dimension]?.[text] ?? LABELS.en.values[dimension]?.[text] ?? humanize(text);
    },
    status: (key) => lookup("statuses", key),
    column: (key) => lookup("columns", key),
    sheet: (key) => lookup("sheets", key),
    word: (group, key) => set.words[group]?.[key] ?? LABELS.en.words[group]?.[key] ?? String(key ?? ""),
    bool: (value) => set.words.bool[value ? "true" : "false"],
    note: (key) => lookup("notes", key)
  };
}
module.exports = { LABELS, LANGUAGES, forLanguage };
