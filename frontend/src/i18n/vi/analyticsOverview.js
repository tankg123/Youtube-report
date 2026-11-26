// Vietnamese dictionary — Analytics overview: pages/analytics/AnalyticsPage.jsx (shell) and views/OverviewView.jsx (owner: F1).
// Keys are the exact English texts used in the source (t("…") / tk("…")). Keep {placeholders} identical to the key.
// Only sentences unique to these two files live here; the sections, metric / dimension / value / report / status
// labels, the buttons (Sync all, Export CSV, Fill missing days, Run the daily sync now, Open Networks, Done, …) and
// the shared sentences (CMS disconnected, Ask an administrator to reconnect…, Breakdowns are stored per Content
// Owner…, No stored data for this range, Nothing to show., Latest data: {date}) come from analyticsShared.js, and
// {covered}/{total} days stored from analyticsKit.js.
export default {
  // AnalyticsPage.jsx — header, filter bar, banner, empty state, revenue gate
  "Daily numbers of every managed channel, stored from the YouTube Analytics API: synced each morning, kept as reported and exportable at any time.":
    "Số liệu theo ngày của mọi kênh đang quản lý, lưu từ YouTube Analytics API: đồng bộ mỗi sáng, giữ nguyên như YouTube báo cáo và xuất được bất cứ lúc nào.",
  "{count} days stored": "Đã lưu {count} ngày",
  "A sync is already running": "Đang có một lượt đồng bộ chạy",
  "Reconnect the CMS OAuth to resume the daily sync. The stored numbers stay available.": "Ủy quyền lại OAuth CMS để đồng bộ hằng ngày chạy tiếp. Số liệu đã lưu vẫn xem được.",
  "The stored numbers stay available.": "Số liệu đã lưu vẫn xem được.",
  "No Content Owner connected": "Chưa kết nối Content Owner nào",
  "Connect a YouTube CMS (content owner) with the Content ID OAuth to start storing analytics.": "Kết nối YouTube CMS (content owner) bằng OAuth Content ID để bắt đầu lưu số liệu analytics.",
  "Revenue reports are available to administrators and Report Managers only": "Báo cáo doanh thu chỉ dành cho quản trị viên và Report Manager",
  "Newer data is stored up to {date} — this range ends earlier.": "Đã có số liệu mới hơn đến {date} — khoảng ngày này kết thúc sớm hơn.",
  "Use latest data": "Dùng số liệu mới nhất",

  // OverviewView.jsx — KPI tiles, trend, panels, actions
  "n/a · previous range has {n} missing days": "n/a · khoảng ngày trước còn thiếu {n} ngày",
  "n/a · this range has {n} missing days": "n/a · khoảng ngày này còn thiếu {n} ngày",
  "Revenue stored for {covered}/{total} days": "Doanh thu đã lưu cho {covered}/{total} ngày",
  "Trend": "Xu hướng",
  "Metric": "Chỉ số",
  "Compare with the previous range": "So sánh với khoảng ngày trước",
  "Updated {instant}": "Cập nhật lúc {instant}",
  "View all in Content": "Xem tất cả ở mục Nội dung",
  "Run Sync all to store this report.": "Chạy Đồng bộ toàn bộ để lưu báo cáo này.",
  "{count} selected channels are not in this Content Owner's inventory and were ignored": "{count} kênh đã chọn không thuộc danh sách kênh của Content Owner này và đã bị bỏ qua",
  "Daily sync queued": "Đã đưa đồng bộ hằng ngày vào hàng đợi",
  "Filling {n} missing days…": "Đang bổ sung {n} ngày còn thiếu…"
};
