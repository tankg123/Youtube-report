// Vietnamese dictionary — Analytics kit: src/pages/analytics/shared.jsx (owner / channel / date-range controls, KPI tiles,
// coverage strip, sync pill, export menu, metric table, panel chrome, daily-run line) and src/pages/analytics/charts.jsx
// (trend, bar list, donut, sparkline, coverage calendar, data table).
// Keys are the exact English texts used in the source (t("…") / tk("…")); keep {placeholders} identical to the key.
// Only sentences unique to the kit live here: the shared words (Content Owner, CMS disconnected, Select channels,
// All channels, Unknown channel, date presets, Custom, Latest data: {date}, Fill missing days, Run the daily sync now,
// Daily sync, View data, Day, Other, Drift, Missing, Not yet published, Exporting…, No stored data for this range,
// Added {days} · {drift} days drifted) come from analyticsShared.js, and Cancel, Close, Apply, Retry, Clear selection,
// Loading…, From, To, Total, Stored, This month, Last month, Last 12 months, {count} channels, {count} selected, Export
// from the older dictionaries.
export default {
  // OwnerSelect
  "No Content Owner available": "Chưa có Content Owner",

  // ChannelPicker
  "Search channels by name or ID…": "Tìm kênh theo tên hoặc ID…",
  "Up to {max} channels can be selected": "Chỉ chọn được tối đa {max} kênh",
  "No channels match “{query}”": "Không có kênh nào khớp “{query}”",
  "No channels in the inventory yet": "Chưa có kênh nào trong danh sách",
  "Showing the first {count} of {total} matches — refine the search": "Đang hiện {count} trong {total} kết quả — hãy thu hẹp tìm kiếm",

  // DateRangeControl — custom range validation
  "Enter both dates as YYYY-MM-DD": "Nhập đủ hai ngày theo dạng YYYY-MM-DD",
  "The start date must be on or before the end date": "Ngày bắt đầu phải trước hoặc bằng ngày kết thúc",
  "The range cannot exceed {max} days": "Khoảng ngày không được vượt quá {max} ngày",
  "The end date cannot be after {date}": "Ngày kết thúc không được sau {date}",

  // KpiTile
  "vs previous range": "so với khoảng ngày trước",

  // CoverageStrip
  "{covered}/{total} days stored": "Đã lưu {covered}/{total} ngày",
  "last sync {instant}": "đồng bộ lần cuối {instant}",
  "{count} days drifted": "{count} ngày có số liệu lệch",
  "data stops at {day} — {count} newer days not yet synced": "dữ liệu dừng ở {day} — còn {count} ngày mới hơn chưa đồng bộ",
  "No days stored yet": "Chưa lưu ngày nào",

  // SyncStatusPill / ExportMenu
  "Syncing {percent}%": "Đang đồng bộ {percent}%",
  "Export options": "Tùy chọn xuất",

  // ErrorPanel
  "Something went wrong": "Đã xảy ra lỗi",

  // DailyRunLine
  "View job": "Xem tác vụ",
  "Scheduled for {instant}": "Lên lịch lúc {instant}",
  "Finished {instant}": "Hoàn tất lúc {instant}",
  "Late": "Trễ",
  "{count} consecutive failures": "{count} lần thất bại liên tiếp",
  "The scheduled run has not started": "Lượt chạy theo lịch chưa bắt đầu",
  "{inserted} rows added · {drift} rows drifted": "Đã thêm {inserted} dòng · {drift} dòng có số liệu lệch",

  // charts.jsx — TrendChart
  "Current range": "Khoảng ngày hiện tại",
  "Previous range": "Khoảng ngày trước",
  "Hover or use the arrow keys to read each day": "Di chuột hoặc dùng phím mũi tên để xem từng ngày",
  "{title}, {count} days from {start} to {end}": "{title}, {count} ngày từ {start} đến {end}",
  "No data": "Không có dữ liệu",
  "Not stored": "Chưa lưu",

  // charts.jsx — Sparkline
  "Trend from {first} to {last}": "Xu hướng từ {first} đến {last}",

  // charts.jsx — CoverageCalendar
  "Coverage calendar": "Lịch độ phủ dữ liệu",
  "Revenue included": "Có doanh thu",
  "Use the arrow keys to move between days": "Dùng phím mũi tên để di chuyển giữa các ngày"
};
