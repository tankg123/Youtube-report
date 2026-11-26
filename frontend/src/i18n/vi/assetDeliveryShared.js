// Vietnamese dictionary — CMS Delivery: shared.jsx, utils.js, constants.js, hooks.js, draftAudioQueue.js, mediaProbe.js, runState.js and src/api/deliveryApi.js.
// Keys are the exact English texts used in the source (t("…") / tk("…")) or produced at runtime (tm()).
// Keep {placeholders} identical to the key. Identity entries ("ISRC": "ISRC") are fine.
export default {
  // constants.js — territory presets and ownership modes
  "Vietnam": "Việt Nam",
  "US + CA": "US + CA",
  "ASEAN": "ASEAN",
  "EU": "EU",
  "Worldwide": "Toàn cầu",
  "Own the recording everywhere": "Sở hữu bản ghi ở mọi nơi",
  "Include": "Bao gồm",
  "Own only in the listed territories": "Chỉ sở hữu tại các vùng lãnh thổ được liệt kê",
  "Exclude": "Loại trừ",
  "Own everywhere except the listed territories": "Sở hữu ở mọi nơi trừ các vùng lãnh thổ được liệt kê",

  // constants.js — asset types and their nouns (item / items / media / mediaFile)
  "Sound recording": "Bản ghi âm",
  "Web video": "Video web",
  "Music video": "Music video",
  "track": "track",
  "tracks": "track",
  "video": "video",
  "videos": "video",
  "audio": "audio",
  "audio file": "file audio",
  "video file": "file video",
  "Any video: vlogs, shows, clips. Title, description, custom ID, official URL.": "Mọi loại video: vlog, show, clip. Tiêu đề, mô tả, custom ID, URL chính thức.",
  "Official music videos: adds artist, optional ISRC, UPC and release date.": "Music video chính thức: thêm nghệ sĩ, ISRC (tùy chọn), UPC và ngày phát hành.",

  // constants.js — product / track / reference status badges
  "Draft": "Draft",
  "Delivering": "Đang phân phối",
  "Delivered": "Đã phân phối",
  "Partially delivered": "Phân phối một phần",
  "Error": "Lỗi",
  "Taken down": "Đã gỡ xuống",
  "Pending": "Đang chờ",
  "Creating": "Đang tạo",
  "Uploading reference": "Đang tải reference lên",
  "Asset created": "Đã tạo asset",
  "Duplicate": "Trùng lặp",
  "Active": "Hoạt động",
  "Activating": "Đang kích hoạt",
  "Checking": "Đang kiểm tra",
  "Checking quota": "Đang kiểm tra quota",
  "Fingerprinting": "Đang tạo fingerprint",
  "Live processing": "Đang xử lý live",
  "Deactivating": "Đang hủy kích hoạt",
  "Inactive": "Đã gỡ",
  "Deleted": "Đã xóa",

  // constants.js — delivery steps
  "Queued": "Đang chờ",
  "Creating asset": "Đang tạo asset",
  "Ownership": "Quyền sở hữu",
  "Match policy": "Chính sách khớp nội dung",
  "Labels": "Label",
  "Uploading audio": "Đang tải audio lên",
  "Checking duplicates": "Đang kiểm tra trùng lặp",
  "CMS authorization": "Ủy quyền CMS",
  "Metadata": "Metadata",
  "Validation": "Kiểm tra hợp lệ",
  "Delivery": "Phân phối",
  "Takedown": "Gỡ xuống",
  "Reactivation": "Kích hoạt lại",
  "Sync": "Đồng bộ",

  // constants.js — timeline / log events and log filter groups
  "Product created": "Đã tạo sản phẩm",
  "Delivered to CMS": "Đã phân phối lên CMS",
  "Reference uploaded": "Đã tải reference lên",
  "Reference from claim": "Reference từ claim",
  "Audio stored": "Đã lưu audio",
  "Audio removed": "Đã xóa audio",
  "Retried": "Đã thử lại",
  "Synced from CMS": "Đã đồng bộ từ CMS",
  "Metadata updated": "Đã cập nhật metadata",
  "Rights updated": "Đã cập nhật quyền",
  "Reactivated": "Đã kích hoạt lại",
  "Delivery step": "Bước phân phối",
  "Track delivery": "Phân phối track",
  "Progress": "Tiến độ",
  "Delivery interrupted": "Phân phối bị gián đoạn",
  "CMS API call": "Lệnh gọi API CMS",
  "Server audio removed after delivery": "Đã xóa audio trên server sau khi phân phối",
  "Server storage freed": "Đã giải phóng dung lượng server",
  "All events": "Tất cả sự kiện",
  "Delivery steps & progress": "Bước phân phối & tiến độ",
  "CMS API calls": "Lệnh gọi API CMS",
  "References": "Reference",
  "Audio files & storage": "File audio & dung lượng",
  "Edits, sync, takedowns": "Chỉnh sửa, đồng bộ, gỡ xuống",

  // utils.js — file ↔ track matching reasons
  "ISRC in file name": "ISRC trong tên file",
  "Track number {number}": "Track số {number}",
  "Title match": "Khớp tiêu đề",
  "Similar title ({percent}%)": "Tiêu đề tương tự ({percent}%)",
  "No matching track": "Không có track khớp",

  // utils.js — client error messages
  "Request failed": "Yêu cầu thất bại",
  "Cancelled": "Đã hủy",
  "Request timed out": "Yêu cầu quá thời gian chờ",
  "The file exceeds the server's upload size limit (HTTP 413). Ask an administrator to increase the limit, then retry the upload.": "File vượt quá giới hạn dung lượng tải lên của máy chủ (HTTP 413). Hãy nhờ quản trị viên tăng giới hạn rồi thử tải lại.",
  "The server returned an error page. Please try again or contact an administrator.": "Máy chủ trả về trang báo lỗi. Hãy thử lại hoặc liên hệ quản trị viên.",

  // utils.js — ownership / policy summaries
  "Include: {list}": "Bao gồm: {list}",
  "Include: (none selected)": "Bao gồm: (chưa chọn)",
  "Exclude: {list}": "Loại trừ: {list}",
  "Worldwide (nothing excluded)": "Toàn cầu (không loại trừ)",
  "Monetize ({scope})": "Kiếm tiền ({scope})",
  "Track ({scope})": "Theo dõi ({scope})",
  "Block ({scope})": "Chặn ({scope})",
  "Takedown ({scope})": "Gỡ video ({scope})",
  "Unknown ({scope})": "Chưa rõ ({scope})",
  "exclude {list}": "trừ {list}",
  "review": "xem xét thủ công",

  // mediaProbe.js — durations
  "unknown length": "không rõ thời lượng",
  "{seconds} s": "{seconds} giây",
  "{minutes} min {seconds} s": "{minutes} phút {seconds} giây",

  // draftAudioQueue.js — upload errors
  "The server did not return an audio upload ID. Please retry.": "Server không trả về ID tải lên audio. Hãy thử lại.",
  "Audio upload failed. Please retry.": "Tải audio lên thất bại. Hãy thử lại.",

  // shared.jsx — Modal / ConfirmDialog / StatusBadge / CopyButton
  "Close": "Đóng",
  "Finish or cancel the current action before closing": "Hoàn tất hoặc hủy thao tác hiện tại trước khi đóng",
  "Are you sure?": "Bạn chắc chắn chứ?",
  "Confirm": "Xác nhận",
  "Cancel": "Hủy",
  "Unknown": "Chưa rõ",
  "Copy": "Sao chép",
  "Copied": "Đã sao chép",

  // shared.jsx — ChipInput
  "Type and press Enter": "Nhập rồi nhấn Enter",
  "Invalid value": "Giá trị không hợp lệ",
  "Remove {value}": "Xóa {value}",
  "Create «{value}» in CMS": "Tạo «{value}» trong CMS",
  "No matches — press Enter to add “{value}”": "Không có kết quả phù hợp — nhấn Enter để thêm “{value}”",

  // shared.jsx — TerritoryPicker
  "Ownership scope": "Phạm vi sở hữu",
  "Type a country code or name…": "Nhập mã hoặc tên quốc gia…",
  "Presets": "Chọn nhanh",
  "Clear": "Xóa",
  "Select at least one territory to include.": "Chọn ít nhất một vùng lãnh thổ để bao gồm.",
  "Unknown territory code(s): {codes}": "Mã vùng lãnh thổ không xác định: {codes}",

  // shared.jsx — PolicySelect
  "Policy ID (e.g. 1234567890)": "Policy ID (vd. 1234567890)",
  "Select a match policy": "Chọn chính sách khớp nội dung",
  "Loading saved policies…": "Đang tải policy đã lưu…",
  "Loading saved policies from CMS…": "Đang tải policy đã lưu từ CMS…",
  "Using policy ID {value} (not in the saved policy list).": "Đang dùng policy ID {value} (không có trong danh sách policy đã lưu).",
  "Choose from saved policies": "Chọn từ policy đã lưu",
  "Enter policy ID manually": "Nhập policy ID thủ công"
};
