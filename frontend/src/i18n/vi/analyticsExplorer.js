// Vietnamese dictionary — Analytics explorer: pages/analytics/views/ExplorerView.jsx (owner: F5).
// Keys are the exact English texts used in the source (t("…") / tk("…")). Keep {placeholders} identical to the key.
// Only sentences unique to the Explorer live here; the report / metric / dimension / status labels, Channel, Video ID,
// Country, Channel ID, No longer managed, Export CSV, Overview / Revenue / Content / Audience, Unknown, {count} rows and
// "Could not export the file: {message}" come from analyticsShared.js and the older dictionaries.
export default {
  // Form card
  "Explore reports": "Khám phá báo cáo",
  "Query YouTube Analytics for this Content Owner; every successful result is stored as a range report.": "Truy vấn YouTube Analytics cho Content Owner này; mỗi kết quả thành công được lưu thành báo cáo theo kỳ.",
  "Report": "Báo cáo",
  "Reach": "Phạm vi tiếp cận",
  "Engagement": "Tương tác",
  "Needs a Video ID": "Cần Video ID",
  "Up to {limit} rows": "Tối đa {limit} dòng",
  "Whole Content Owner": "Toàn bộ Content Owner",
  "Other channel ID…": "Channel ID khác…",
  "The filter bar's channel selection does not apply here; the Explorer queries one channel at a time.": "Kênh đã chọn trên thanh bộ lọc không áp dụng ở đây; Khám phá dữ liệu truy vấn từng kênh một.",
  "Enter a valid channel ID (UC + 22 characters)": "Nhập Channel ID hợp lệ (UC + 22 ký tự)",
  "Optional. A video filter replaces the channel filter.": "Không bắt buộc. Bộ lọc video thay cho bộ lọc kênh.",
  "This report needs a Video ID": "Báo cáo này cần Video ID",
  "Enter a valid 11-character video ID": "Nhập Video ID hợp lệ gồm 11 ký tự",
  "e.g. dQw4w9WgXcQ": "ví dụ: dQw4w9WgXcQ",
  "Two-letter ISO code, e.g. VN": "Mã ISO 2 ký tự, ví dụ VN",
  "Not available for this report": "Không áp dụng cho báo cáo này",
  "Enter a two-letter country code": "Nhập mã quốc gia 2 ký tự",

  // Custom query
  "Custom query": "Truy vấn tùy chỉnh",
  "Dimensions, metrics, filters and sort of your choice": "Tự chọn dimension, metric, bộ lọc và sắp xếp",
  "Dimension and metric combinations must be supported by YouTube; the Content Owner filter and your role's permissions always apply.": "Tổ hợp dimension và metric phải được YouTube hỗ trợ; bộ lọc Content Owner và quyền của tài khoản luôn được áp dụng.",
  "Dimensions": "Dimensions",
  "Metrics": "Metrics",
  "Extra filters": "Bộ lọc bổ sung",
  "Sort": "Sắp xếp",
  "Max rows": "Số dòng tối đa",
  "Enter at least one metric": "Nhập ít nhất một metric",
  "Max rows must be between 1 and 200": "Số dòng tối đa phải từ 1 đến 200",

  // Run
  "Run report": "Chạy báo cáo",
  "Run query": "Chạy truy vấn",
  "Your role can browse stored results but cannot run new queries.": "Vai trò của bạn chỉ xem được kết quả đã lưu, không chạy được truy vấn mới.",
  "Reconnect the CMS to run new queries; stored results stay browsable.": "Kết nối lại CMS để chạy truy vấn mới; kết quả đã lưu vẫn xem được.",
  "Querying YouTube Analytics…": "Đang truy vấn YouTube Analytics…",
  "A successful result is stored as a range report.": "Kết quả thành công được lưu thành báo cáo theo kỳ.",
  "Report saved: {count} rows": "Đã lưu báo cáo: {count} dòng",
  "The Analytics service answered without a report.": "Dịch vụ Analytic trả lời nhưng không có báo cáo.",

  // Results card
  "Custom query result": "Kết quả truy vấn tùy chỉnh",
  "Video {id}": "Video {id}",
  "Stored result from {instant}": "Kết quả đã lưu từ {instant}",
  "Fetched {instant}": "Truy vấn lúc {instant}",
  "The latest attempt on {instant} failed: {message}": "Lần truy vấn gần nhất lúc {instant} thất bại: {message}",
  "YouTube returns at most {limit} rows for this report; use the Bulk archive for the full data.": "YouTube trả tối đa {limit} dòng cho báo cáo này; dùng kho Bulk để lấy toàn bộ dữ liệu.",
  "Search in the result…": "Tìm trong kết quả…",
  "No rows match the search": "Không có dòng nào khớp tìm kiếm",
  "Open {id} on YouTube": "Mở {id} trên YouTube",
  "Not stored yet": "Chưa có kết quả lưu",
  "Run the report to fetch it from YouTube Analytics; the result is kept for this selection.": "Chạy báo cáo để lấy dữ liệu từ YouTube Analytics; kết quả được lưu cho lựa chọn này.",
  "No rows for this selection": "Không có dòng dữ liệu cho lựa chọn này",
  "YouTube answered without rows — missing rows are not zero.": "YouTube trả về không có dòng nào — thiếu dòng không có nghĩa là bằng 0.",
  "Ready to explore": "Sẵn sàng khám phá",
  "Set dimensions, metrics and filters, then run the query; results are kept in the saved queries below.": "Đặt dimension, metric và bộ lọc rồi chạy truy vấn; kết quả được giữ trong danh sách truy vấn đã lưu bên dưới.",

  // Saved queries and report structure
  "Saved queries": "Truy vấn đã lưu",
  "Custom query results kept for this Content Owner": "Kết quả truy vấn tùy chỉnh đã lưu của Content Owner này",
  "Totals": "Tổng hợp",
  "Report structure": "Cấu trúc báo cáo",
  "Availability depends on the CMS permissions, the content type and what YouTube publishes; empty results are shown as they are.": "Khả năng truy xuất phụ thuộc quyền CMS, loại nội dung và dữ liệu YouTube công bố; kết quả trống được hiển thị nguyên trạng."
};
