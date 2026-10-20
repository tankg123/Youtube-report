// Vietnamese dictionary — Report: ManagerReportPage.jsx, ExportMultiPage.jsx.
// Keys are the exact English texts used in the source (t("…") / tk("…")) or produced at runtime (tm()).
// Keep {placeholders} identical to the key. Identity entries ("ISRC": "ISRC") are fine.
export default {
  // ── Shared by both pages ─────────────────────────────────────────────────────────────────────────
  "Revenue US": "Doanh thu US",
  "Revenue BR": "Doanh thu BR",
  "Month": "Tháng",
  "Channels": "Kênh",

  // ── ManagerReportPage — header and tax reminders ─────────────────────────────────────────────────
  "Manager report": "Báo cáo manager",
  "Manager Report": "Báo cáo manager",
  "The import file needs a Channel ID and a Revenue column. Channel IDs missing the UC prefix are completed before the YouTube Data API v3 update.": "File import cần có cột Channel ID và Revenue. Channel ID thiếu UC sẽ được tự bổ sung trước khi cập nhật YouTube Data API v3.",
  "US and BR tax are on: check that the file has the Revenue US and Revenue BR columns before importing.": "Thuế US và BR đang bật: kiểm tra file có cột Revenue US và Revenue BR trước khi import.",
  "US tax is on: check that the file has a Revenue US column before importing.": "Thuế US đang bật: kiểm tra file có cột Revenue US trước khi import.",
  "BR tax is on: check that the file has a Revenue BR column before importing.": "Thuế BR đang bật: kiểm tra file có cột Revenue BR trước khi import.",

  // ── ManagerReportPage — stored messages (tk) and the delete confirmation ─────────────────────────
  "Could not load the networks": "Lỗi tải network",
  "Could not load the report": "Lỗi tải report",
  "Select a network before importing": "Chọn network trước khi import",
  "Select an Excel or CSV file": "Chọn file Excel hoặc CSV",
  "Report imported": "Đã import report",
  "Could not import the report": "Lỗi import report",
  "Select the network whose import should be deleted": "Chọn network cần xóa import",
  "Delete the whole {month} import of network {network}?": "Xóa toàn bộ import tháng {month} của network {network}?",
  "Import deleted": "Đã xóa import",
  "Could not delete the import": "Lỗi xóa import",

  // ── ManagerReportPage — range picker ─────────────────────────────────────────────────────────────
  "This month": "Tháng này",
  "Last month": "Tháng trước",
  "This quarter": "Quý này",
  "Last quarter": "Quý trước",
  "This year": "Năm nay",
  "Last year": "Năm trước",
  "From": "Từ ngày",
  "To": "Đến ngày",
  "Recent months": "Các tháng gần đây",

  // ── ManagerReportPage — import form ──────────────────────────────────────────────────────────────
  "Select a network": "Chọn network",
  "Choose a .xlsx or .csv file": "Chọn file .xlsx hoặc .csv",
  "Import": "Import",

  // ── ManagerReportPage — notices and the per-network import card ──────────────────────────────────
  "Channels not found on YouTube": "Kênh không tìm thấy trên YouTube",
  "Tax column missing in the imported file": "File import thiếu cột thuế",
  "The file imported for {month} has no Revenue US column, so US tax for that month is calculated on 0. Import a file that has the column to correct it.": "File import tháng {month} không có cột Revenue US nên thuế US tháng đó tính trên 0. Import lại file có cột này để sửa.",
  "The file imported for {month} has no Revenue BR column, so BR tax for that month is calculated on 0. Import a file that has the column to correct it.": "File import tháng {month} không có cột Revenue BR nên thuế BR tháng đó tính trên 0. Import lại file có cột này để sửa.",
  "The file imported for {month} has neither a Revenue US nor a Revenue BR column, so US and BR tax for that month are calculated on 0. Import a file that has the columns to correct it.": "File import tháng {month} không có cột Revenue US và Revenue BR nên thuế US và BR tháng đó tính trên 0. Import lại file có các cột này để sửa.",
  "Import by network": "Import theo network",
  "The data is filtered by the selected month and network.": "Dữ liệu đang được lọc theo tháng và network đã chọn.",
  "Delete this month's import": "Xóa import tháng này",

  // ── ManagerReportPage — summary cards ────────────────────────────────────────────────────────────
  "Rows": "Số dòng",
  "Total Revenue": "Tổng doanh thu",

  // ── ManagerReportPage — YouTube API quota card ───────────────────────────────────────────────────
  "YouTube API quota": "Quota YouTube API",
  "No key": "Chưa có key",
  "Estimated quota used by this backend since it started. Google does not expose exact project quota through an API key.": "Quota ước tính backend này đã dùng kể từ khi khởi động. Google không cung cấp quota chính xác của project qua API key.",
  "Refresh quota": "Làm mới quota",
  "Estimated used": "Đã dùng (ước tính)",
  "Estimated remaining": "Còn lại (ước tính)",
  "Daily limit": "Giới hạn mỗi ngày",
  "Last YouTube error": "Lỗi YouTube gần nhất",

  // ── ManagerReportPage — import history ───────────────────────────────────────────────────────────
  "Import History": "Lịch sử import",
  "{count} import": "{count} lượt import",
  "{count} imports": "{count} lượt import",
  "No import history for this month / network yet.": "Chưa có lịch sử import cho tháng/network này.",
  "File": "File",
  "Network": "Network",
  "Imported at": "Thời điểm import",

  // ── ManagerReportPage — imported channels table ──────────────────────────────────────────────────
  "Imported Channels": "Kênh đã import",
  "{count} row": "{count} dòng",
  "{count} rows": "{count} dòng",
  "No report data for this month yet.": "Chưa có dữ liệu report cho tháng này.",
  "Channel": "Kênh",
  "Channel ID": "Channel ID",
  "Revenue": "Doanh thu",
  "Waiting for YouTube data": "Đang chờ dữ liệu YouTube",

  // ── ExportMultiPage — all-channels range options (tk) and the month label fallback ───────────────
  "Selected month only": "Chỉ tháng đã chọn",
  "Last 2 months": "2 tháng gần nhất",
  "Last 3 months": "3 tháng gần nhất",
  "Last 6 months": "6 tháng gần nhất",
  "Last 12 months": "12 tháng gần nhất",
  "This year (Jan → selected month)": "Năm nay (tháng 1 → tháng đã chọn)",
  "Select month": "Chọn tháng",

  // ── ExportMultiPage — stored and progress messages ───────────────────────────────────────────────
  "Could not load export data": "Không tải được dữ liệu xuất",
  "Exporting all channels for {range}...": "Đang xuất tất cả kênh cho {range}...",
  "Exported all channels for {range}.": "Đã xuất tất cả kênh cho {range}.",
  "Could not export all channels": "Không xuất được tất cả kênh",
  "Please choose at least one group to export.": "Chọn ít nhất một group để xuất.",
  "Exporting {count} group...": "Đang xuất {count} group...",
  "Exporting {count} groups...": "Đang xuất {count} group...",
  "Exported {count} group.": "Đã xuất {count} group.",
  "Exported {count} groups.": "Đã xuất {count} group.",
  "{count} with {taxes} tax columns.": "{count} group kèm cột thuế {taxes}.",
  "Could not export selected groups": "Không xuất được các group đã chọn",

  // ── ExportMultiPage — header and export buttons ──────────────────────────────────────────────────
  "Report export": "Xuất báo cáo",
  "Export Multi": "Xuất hàng loạt",
  "Choose multiple groups and export invoices for the selected month.": "Chọn nhiều group và xuất hóa đơn cho tháng đã chọn.",
  "Months included in the all-channels export: one revenue column per month": "Số tháng trong file xuất tất cả kênh: mỗi tháng một cột doanh thu",
  "Export every channel with revenue in {range} to Excel": "Xuất mọi kênh có doanh thu trong {range} ra Excel",
  "Export all channels": "Xuất tất cả kênh",
  "Export selected ({count})": "Xuất group đã chọn ({count})",

  // ── ExportMultiPage — filters and export options ─────────────────────────────────────────────────
  "Company": "Công ty",
  "Default company": "Công ty mặc định",
  "Format": "Định dạng",
  "PDF signature": "Chữ ký PDF",
  "Include sign boxes": "Có ô ký tên",
  "No sign boxes": "Không có ô ký tên",
  "{taxes} tax columns": "Cột thuế {taxes}",
  "Adds {columns} to the Excel of every selected group that applies {taxes} tax.": "Thêm {columns} vào file Excel của mỗi group đã chọn có áp dụng thuế {taxes}.",
  "Add {taxes} columns": "Thêm cột {taxes}",
  "No {taxes} columns": "Không thêm cột {taxes}",
  "Search": "Tìm kiếm",
  "Group or partner...": "Group hoặc đối tác...",

  // ── ExportMultiPage — group list ─────────────────────────────────────────────────────────────────
  "{count} group available": "Có {count} group",
  "{count} groups available": "Có {count} group",
  "Select all groups": "Chọn tất cả group",
  "No groups found for this month.": "Không có group nào trong tháng này.",
  "{taxes} tax": "Thuế {taxes}",
  "columns in Excel": "có cột trong Excel",
  "Currency": "Loại tiền",
  "Paid": "Thực trả"
};
