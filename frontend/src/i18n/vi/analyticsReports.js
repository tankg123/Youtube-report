// Vietnamese dictionary — Analytics reports: pages/analytics/views/ContentView.jsx (top videos, video revenue, content
// breakdowns and the shared report panels), views/AudienceView.jsx (countries, traffic, devices, age & gender, sharing)
// and views/RevenueView.jsx (revenue KPIs, trend, revenue by channel / country / content type / ad type).
// Keys are the exact English texts used in the source (t("…") / tk("…")); keep {placeholders} identical to the key.
// Only sentences unique to these views live here. The report titles and descriptions (REPORT_LABELS /
// REPORT_DESCRIPTIONS), metric, dimension and value labels, the export option labels, Sync all, CMS disconnected,
// "Breakdowns are stored per Content Owner — select one channel or none", "Ad types are only reported at Content
// Owner level", "No stored data for this range", Share of total, Code, Title, Channel, Channel ID, Video, Video ID,
// Published, Status, Total, Day (Pacific time), Previous range, No longer managed, Search channels, Age group, Gender,
// Viewer percentage and "{covered}/{total} days stored" come from analyticsShared.js / analyticsKit.js; Updated {instant},
// Run Sync all to store this report., n/a · … missing days, Metric and Compare with the previous range are shared
// with analyticsOverview.js (same Vietnamese); Show less and Watch on YouTube come from the older dictionaries.
export default {
  // Shared report panels (ContentView.jsx)
  "This table (CSV)": "Bảng này (CSV)",
  "Not synced for this range yet": "Chưa đồng bộ cho khoảng ngày này",
  "A sync is already running": "Đang có một lượt đồng bộ chạy",
  "YouTube reported no rows for this range": "YouTube không trả về dòng dữ liệu nào cho khoảng ngày này",
  "Range reports are stored per Content Owner or for one channel — select one channel or none": "Báo cáo theo kỳ được lưu ở cấp Content Owner hoặc cho một kênh — chọn một kênh hoặc không chọn kênh nào",
  "Show all {count} rows": "Hiện tất cả {count} dòng",
  "Last refresh failed {instant}: {error}": "Lần làm mới gần nhất thất bại lúc {instant}: {error}",

  // Content view
  "Open the Bulk archive": "Mở kho Bulk",

  // Revenue view
  "Estimates in USD. YouTube keeps revising revenue for about 45 days after each day; the daily sync records those revisions as drift.":
    "Số liệu ước tính bằng USD. YouTube tiếp tục điều chỉnh doanh thu trong khoảng 45 ngày sau mỗi ngày; đồng bộ hằng ngày ghi nhận các điều chỉnh đó là số liệu lệch.",
  "n/a · previous range has {n} missing days": "n/a · khoảng ngày trước còn thiếu {n} ngày",
  "n/a · this range has {n} missing days": "n/a · khoảng ngày này còn thiếu {n} ngày",
  "Revenue stored for {covered}/{total} days": "Doanh thu đã lưu cho {covered}/{total} ngày",
  "Revenue trend": "Xu hướng doanh thu",
  "Metric": "Chỉ số",
  "Compare with the previous range": "So sánh với khoảng ngày trước",
  "No previous range to compare": "Chưa có khoảng ngày trước để so sánh",
  "{count} of {total} channels have revenue stored in this range": "{count}/{total} kênh có doanh thu được lưu trong khoảng ngày này",
  "Showing the first {count} of {total} channels": "Đang hiện {count} kênh đầu tiên trong {total} kênh",
  "Revenue days": "Số ngày có doanh thu",
  "Days in range": "Số ngày trong khoảng"
};
