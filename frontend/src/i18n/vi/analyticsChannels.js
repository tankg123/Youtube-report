// Vietnamese dictionary — Analytics channels: pages/analytics/views/ChannelsView.jsx and views/ChannelDetailView.jsx (owner: F2).
// Keys are the exact English texts used in the source (t("…") / tk("…")). Keep {placeholders} identical to the key.
// Only sentences unique to these two views live here. The words they share with the other analytics views come from
// analyticsShared.js (Channel, Views, Watch hours, Net subscribers, Estimated revenue, RPM, Subscribers, Videos,
// Covered days, Status, Sync all, Sync channel reports, No longer managed, Channel performance, Coverage, Range reports,
// Joined, Lifetime views, Video count, Not yet published, the report labels, the status labels…), analyticsKit.js
// ({covered}/{total} days stored, Not stored, Search channels by name or ID…, No channels in the inventory yet, Export CSV),
// analyticsOverview.js (Trend, Metric, Compare with the previous range, Updated {instant}, A sync is already running,
// Revenue stored for {covered}/{total} days, the two "n/a · … missing days" hints) and the older dictionaries (Clear
// filters, Clear selection, All statuses, Open on YouTube, Copy, Copied, Value).
export default {
  // ---------------------------------------------------------------------------
  // ChannelsView — tiles, coverage note, notices
  // ---------------------------------------------------------------------------
  "Channels in CMS": "Kênh trong CMS",
  "{count} no longer managed": "{count} kênh không còn quản lý",
  "With data in range": "Có dữ liệu trong khoảng ngày",
  "of {count} active channels": "trên {count} kênh đang quản lý",
  "Revenue is stored for part of the days": "Doanh thu mới được lưu cho một phần số ngày",
  "RPM {value}": "RPM {value}",
  "Inventory updated {instant}": "Danh sách kênh cập nhật lúc {instant}",
  "{count} days of this range are not stored yet": "{count} ngày trong khoảng này chưa được lưu",
  "Sums of the stored days in this range; “—” marks a channel with no stored day.": "Tổng của các ngày đã lưu trong khoảng này; “—” là kênh chưa có ngày nào được lưu.",
  "Unknown channel IDs were ignored: {ids}": "Đã bỏ qua các Channel ID không xác định: {ids}",
  "They are not in the inventory of this Content Owner.": "Các kênh này không có trong danh sách kênh của Content Owner.",

  // ChannelsView — table panel, filters, empty states
  "Open a channel to see its daily numbers, coverage calendar and range reports.": "Mở một kênh để xem số liệu theo ngày, lịch độ phủ dữ liệu và báo cáo theo kỳ.",
  "All countries": "Tất cả quốc gia",
  "Run Sync all to load the channel list and the first days of data.": "Chạy Đồng bộ toàn bộ để tải danh sách kênh và những ngày dữ liệu đầu tiên.",
  "No channels match the filters": "Không có kênh nào khớp bộ lọc",
  "No stored days for any channel in this range": "Chưa có ngày nào được lưu cho kênh nào trong khoảng này",
  "Run Sync all to store the daily numbers of every channel for this range.": "Chạy Đồng bộ toàn bộ để lưu số liệu theo ngày của mọi kênh trong khoảng này.",

  // ---------------------------------------------------------------------------
  // ChannelDetailView — navigation, hero, notices
  // ---------------------------------------------------------------------------
  "Back to channels": "Về danh sách kênh",
  "Invalid channel ID": "Channel ID không hợp lệ",
  "A YouTube channel ID starts with UC and has 24 characters.": "Channel ID YouTube bắt đầu bằng UC và có 24 ký tự.",
  "No data before {date} — the channel may not have been linked to the Content Owner yet.": "Không có dữ liệu trước {date} — có thể khi đó kênh chưa được liên kết với Content Owner.",
  "YouTube reported no activity for this channel on the {count} stored days of this range.": "YouTube không ghi nhận hoạt động nào của kênh này trong {count} ngày đã lưu của khoảng này.",
  "No stored days for this channel in this range": "Chưa có ngày nào được lưu cho kênh này trong khoảng này",
  "Sync channel reports stores the channel's daily numbers and refreshes its range reports for the selected dates.": "Đồng bộ báo cáo kênh sẽ lưu số liệu theo ngày của kênh và làm mới báo cáo theo kỳ cho khoảng ngày đã chọn.",
  "This channel sync is already queued": "Đồng bộ kênh này đã có trong hàng đợi",
  "Channel reports sync queued": "Đã đưa đồng bộ báo cáo kênh vào hàng đợi",

  // ChannelDetailView — trend and coverage panels
  "Daily values of one metric; a gap is a day that is not stored.": "Giá trị theo ngày của một chỉ số; chỗ đứt là ngày chưa được lưu.",
  "Days of this range stored for the channel; pick a day to read its numbers.": "Những ngày trong khoảng này đã lưu cho kênh; chọn một ngày để xem số liệu.",
  "Select a day in the calendar to see its stored numbers.": "Chọn một ngày trên lịch để xem số liệu đã lưu của ngày đó.",
  "No activity reported on this day": "YouTube không ghi nhận hoạt động trong ngày này",

  // ChannelDetailView — range reports (channel snapshots)
  "Not synced yet": "Chưa đồng bộ",
  "Show fewer": "Thu gọn",
  "Show all ({count})": "Xem tất cả ({count})",
  "Up to 200 videos of this channel ranked by views in the range.": "Tối đa 200 video của kênh xếp theo lượt xem trong khoảng ngày.",
  "Up to 200 videos ranked by estimated revenue (USD).": "Tối đa 200 video xếp theo doanh thu ước tính (USD).",
  "Channel reports have not been synced for this range": "Báo cáo kênh chưa được đồng bộ cho khoảng ngày này",
  "Top videos, countries, traffic sources, devices and the other reports of this channel are stored per range when you sync its reports.": "Video nổi bật, quốc gia, nguồn truy cập, thiết bị và các báo cáo khác của kênh được lưu theo từng khoảng ngày khi bạn đồng bộ báo cáo kênh."
};
