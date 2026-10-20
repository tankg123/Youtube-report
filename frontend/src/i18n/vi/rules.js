// Vietnamese message rules for texts with dynamic parts that tm() cannot match exactly (server
// answers such as `Claims in ${status} status cannot be released through the API.`).
// Each rule: { pattern: /^…$/ (no g flag), to: "text with {1} {2} groups" | (match, { t, tm }) => string }.
// Rules are tried in order after the exact dictionaries; the first non-empty result wins.
//
// Claim statuses and write verbs (active, inactive, release, reinstate, …) are dictionary entries
// of server.js and are read with t(); an unknown word comes back unchanged. The maps below hold the
// other vocabularies embedded in server sentences (delivery steps, track / reference states, API
// phases, policy actions) so they never collide with the keys of another slice.

const PAST_VERB = Object.freeze({ released: "gỡ", reinstated: "khôi phục", confirmed: "xác nhận" });

const STEPS = Object.freeze({
  insert: "tạo asset", ownership: "quyền sở hữu", policy: "chính sách khớp nội dung", labels: "gắn label",
  reference: "tải reference", auth: "ủy quyền CMS", check: "kiểm tra ISRC trùng", deliver: "phân phối",
  metadata: "metadata", track: "track", cleanup: "dọn file", sync: "đồng bộ", retry: "thử lại",
  rights: "cập nhật quyền", takedown: "gỡ nội dung", reactivate: "kích hoạt lại", queued: "hàng đợi", unknown: "chưa rõ"
});

const TRACK_STATUSES = Object.freeze({
  completed: "hoàn tất", created: "đã tạo asset", error: "lỗi", duplicate: "trùng ISRC", pending: "đang chờ",
  queued: "trong hàng đợi", creating: "đang tạo", uploading: "đang tải lên", taken_down: "đã gỡ nội dung",
  partial: "một phần", delivered: "đã phân phối", delivering: "đang phân phối", draft: "bản nháp", skipped: "bỏ qua"
});

const REFERENCE_STATUSES = Object.freeze({
  active: "đang hoạt động", activating: "đang kích hoạt", checking: "đang kiểm tra", checking_quota: "đang kiểm tra quota",
  computing_fingerprint: "đang tính fingerprint", live_streaming_processing: "đang xử lý livestream",
  inactive: "không hoạt động", deactivating: "đang hủy kích hoạt", deleted: "đã xóa", "unknown status": "trạng thái chưa rõ"
});

const PHASES = Object.freeze({
  started: "bắt đầu", completed: "hoàn tất", failed: "thất bại", retry: "thử lại", progress: "đang tiến hành", skipped: "bỏ qua", ok: "ok"
});

const FIELDS = Object.freeze({ Title: "Tiêu đề", Notes: "Ghi chú", Description: "Mô tả", "Official URL": "URL chính thức" });

const POLICY_ACTIONS = Object.freeze({ Monetize: "Kiếm tiền", Track: "Theo dõi", Block: "Chặn", Takedown: "Gỡ video", Rule: "Quy tắc" });
const POLICY_PART = /^(Monetize|Track|Block|Takedown|Rule) \((.+)\)$/;
const POLICY_SCOPE = "(?:WW|(?:exclude )?[A-Z]{2}(?:, [A-Z]{2})*)";
const POLICY_SUMMARY = new RegExp(`^(?:Monetize|Track|Block|Takedown|Rule) \\(${POLICY_SCOPE}\\)(?: · (?:(?:Monetize|Track|Block|Takedown|Rule) \\(${POLICY_SCOPE}\\)|review))*$`);

const word = (map, value) => map[value] || value;
const step = (value) => word(STEPS, value);
const trackStatus = (value) => word(TRACK_STATUSES, value);
const referenceStatus = (value) => word(REFERENCE_STATUSES, value);
const phase = (value, tm) => PHASES[value] || tm(value);
const policyScope = (scope) => (scope === "WW" ? "toàn cầu" : scope.replace(/^exclude /, "trừ "));
const policyPart = (part) => {
  if (part === "review") return "cần xét duyệt";
  const found = POLICY_PART.exec(part);
  return found ? `${word(POLICY_ACTIONS, found[1])} (${policyScope(found[2])})` : part;
};
// "12.3 s", "45 s", "1 min 5 s" or "unknown length" (mediaDurationService.formatSeconds).
const duration = (text) => (text === "unknown length" ? "không rõ thời lượng" : text.replace(/(\d+) min/, "$1 phút").replace(/([\d.]+) s$/, "$1 giây"));
const fileName = (name) => (name === "This video" ? "Video này" : name);
const each = (text, tm) => text.split("; ").map((item) => tm(item)).join("; ");
const optional = (value, render) => (value ? render(value) : "");

export default [
  // --- Claim Manager: limits and validation (claimManagerService.js) ---
  { pattern: /^A lookup can include at most (\d+) CMS networks\.$/, to: "Mỗi lần tra cứu tối đa {1} network CMS." },
  { pattern: /^A lookup can contain at most (\d+) unique videos\.$/, to: "Mỗi lần tra cứu tối đa {1} video (không trùng)." },
  { pattern: /^A lookup can contain at most (\d+) asset IDs\.$/, to: "Mỗi lần tra cứu tối đa {1} asset ID." },
  { pattern: /^A lookup can contain at most (\d+) claim IDs\.$/, to: "Mỗi lần tra cứu tối đa {1} claim ID." },
  { pattern: /^A (release|reinstate|confirm) batch can contain at most (\d+) claims\.$/, to: (match, { t }) => `Mỗi lô ${t(match[1])} tối đa ${match[2]} claim.` },
  { pattern: /^A re-check can contain at most (\d+) claims\.$/, to: "Mỗi lần kiểm tra lại tối đa {1} claim." },
  { pattern: /^The note must be at most (\d+) characters\.$/, to: "Ghi chú tối đa {1} ký tự." },
  { pattern: /^Unknown claim status: (.+)$/, to: "Trạng thái claim không hợp lệ: {1}" },
  { pattern: /^Unknown content type: (.+)$/, to: "Loại nội dung không hợp lệ: {1}" },
  { pattern: /^Unknown origin: (.+)$/, to: "Nguồn claim không hợp lệ: {1}" },
  { pattern: /^Unknown sort: (.+)$/, to: "Kiểu sắp xếp không hợp lệ: {1}" },
  { pattern: /^Unknown search mode "(.*)"$/, to: "Chế độ tìm kiếm không hợp lệ \"{1}\"" },
  { pattern: /^Unknown result "(.*)"$/, to: "Kết quả không hợp lệ \"{1}\"" },
  { pattern: /^(\w+) must be a date in YYYY-MM-DD format$/, to: "{1} phải là ngày theo định dạng YYYY-MM-DD" },
  { pattern: /^(\w+) must be a date in YYYY-MM-DD format or an ISO 8601 UTC instant$/, to: "{1} phải là ngày YYYY-MM-DD hoặc thời điểm UTC theo chuẩn ISO 8601" },
  { pattern: /^Export matches (\S+) rows; narrow the filters \(maximum (\S+)\)\.$/, to: "Xuất file khớp {1} dòng; thu hẹp bộ lọc (tối đa {2})." },
  { pattern: /^More than (\d+) result pages for one batch of videos; narrow the lookup\.$/, to: "Một lô video có hơn {1} trang kết quả; thu hẹp phạm vi tra cứu." },
  { pattern: /^Asset (\S+) has more claims than the (\d+) pages read; add filters to see the rest\.$/, to: "Asset {1} có nhiều claim hơn {2} trang đã đọc; thêm bộ lọc để xem phần còn lại." },
  { pattern: /^Previews were loaded for the first (\d+) videos only\.$/, to: "Chỉ tải xem trước cho {1} video đầu tiên." },
  { pattern: /^Unexpected server error \(ref ([0-9a-f]+)\)$/, to: "Lỗi server không mong đợi (mã tham chiếu {1})" },

  // --- CMS authorization, Google token service, quota (claimManagerService.js, googleContentIdService.js, deliveryStore.js) ---
  { pattern: /^(.+): the CMS authorization is missing the YouTube Partner scope\. Re-authorize it in Settings > Network\.$/, to: "{1}: ủy quyền CMS thiếu scope YouTube Partner. Ủy quyền lại trong Cài đặt > Network." },
  { pattern: /^CMS authorization failed: (.+)\. Re-authorize this CMS in Settings > Network\.$/, to: (match, { tm }) => `Ủy quyền CMS thất bại: ${tm(match[1])}. Ủy quyền lại CMS này trong Cài đặt > Network.` },
  { pattern: /^Google's token service answered (\d+) while refreshing the CMS access token \((.+)\); try again\.$/, to: (match, { tm }) => `Dịch vụ token của Google trả về ${match[1]} khi làm mới access token CMS (${tm(match[2])}); thử lại.` },
  { pattern: /^Google's token service could not be reached to refresh the CMS access token \((.+)\); try again\.$/, to: (match, { tm }) => `Không kết nối được dịch vụ token của Google để làm mới access token CMS (${tm(match[1])}); thử lại.` },
  { pattern: /^Google rejected this application's OAuth client while refreshing the CMS token \((.+)\)\. An administrator must check GOOGLE_CLIENT_ID \/ GOOGLE_CLIENT_SECRET on the server; re-authorizing the CMS will not help\.$/, to: (match, { tm }) => `Google từ chối OAuth client của ứng dụng này khi làm mới token CMS (${tm(match[1])}). Quản trị viên cần kiểm tra GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET trên server; ủy quyền lại CMS sẽ không giúp được.` },
  { pattern: /^(invalid_grant|invalid_client|unauthorized_client|invalid_request|invalid_scope|access_denied|unsupported_grant_type): (.+)$/, to: (match, { tm }) => `${match[1]}: ${tm(match[2])}` },
  { pattern: /^CMS permission denied: (.+)$/, to: (match, { tm }) => `CMS từ chối quyền truy cập: ${tm(match[1])}` },
  { pattern: /^Content ID API quota or rate limit reached for this project; wait for the reset or raise the quota in Google Cloud\. \((.+)\)$/, to: (match, { tm }) => `Đã chạm quota hoặc giới hạn tốc độ Content ID API của project này; chờ reset hoặc nâng quota trong Google Cloud. (${tm(match[1])})` },

  // --- Claim Manager: block reasons (the frontend builds the same sentence without "through the API") ---
  { pattern: /^Claims in (.+?) status cannot be released( through the API)?(\.)?$/, to: (match, { t }) => `Claim ở trạng thái ${t(match[1])} không thể gỡ${match[2] ? " qua API" : ""}${match[3] || ""}` },
  { pattern: /^Only inactive \(released\) claims can be reinstated through the API; this claim is (.+?)(\.)?$/, to: (match, { t }) => `Chỉ claim đã gỡ mới có thể khôi phục qua API; claim này đang ở trạng thái ${t(match[1])}${match[2] || ""}` },
  { pattern: /^Only potential claims \(matches awaiting confirmation\) can be confirmed through the API; this claim is (.+?)(\.)?$/, to: (match, { t }) => `Chỉ claim tiềm năng (khớp nội dung chờ xác nhận) mới có thể xác nhận qua API; claim này đang ở trạng thái ${t(match[1])}${match[2] || ""}` },

  // --- Claim Manager: outcomes of a release / reinstate / confirm call ---
  { pattern: /^Confirmed (\S+) by a later (release|reinstate|confirm) attempt: the earlier unanswered (release|reinstate|confirm) call had been applied\.$/, to: (match, { t }) => `Xác nhận trạng thái ${t(match[1])} nhờ lệnh ${t(match[2])} sau đó: lệnh ${t(match[3])} trước không nhận được phản hồi nhưng đã được áp dụng.` },
  { pattern: /^Google did not answer the first attempt; the repeat was refused because the claim was already (\S+), so this call had been applied\.$/, to: (match, { t }) => `Google không phản hồi lần thử đầu; lần gửi lại bị từ chối vì claim đã ở trạng thái ${t(match[1])}, nghĩa là lệnh này đã được áp dụng.` },
  { pattern: /^Google refused the (release|reinstate|confirm) because the claim was already (\S+); nothing was changed by this call\.$/, to: (match, { t }) => `Google từ chối lệnh ${t(match[1])} vì claim đã ở trạng thái ${t(match[2])}; lệnh này không thay đổi gì.` },
  { pattern: /^Claim was already (\S+): the earlier (release|reinstate|confirm) call whose answer was lost had been applied\. Nothing was changed by this call\.$/, to: (match, { t }) => `Claim đã ở trạng thái ${t(match[1])}: lệnh ${t(match[2])} trước đó bị mất phản hồi nhưng đã được áp dụng. Lệnh này không thay đổi gì.` },
  { pattern: /^Google refused the (release|reinstate|confirm) because the claim was already (\S+): the earlier unanswered (release|reinstate|confirm) call had been applied\. Nothing was changed by this call\.$/, to: (match, { t }) => `Google từ chối lệnh ${t(match[1])} vì claim đã ở trạng thái ${t(match[2])}: lệnh ${t(match[3])} trước không nhận được phản hồi nhưng đã được áp dụng. Lệnh này không thay đổi gì.` },
  { pattern: /^Google accepted the (release|reinstate|confirm) call without reporting the claim status, and the claim could not be read back; re-check it before trying again\.$/, to: (match, { t }) => `Google chấp nhận lệnh ${t(match[1])} nhưng không báo trạng thái claim, và không đọc lại được claim; kiểm tra lại trước khi thử tiếp.` },
  { pattern: /^Google answered with status "(.*)" instead of (\S+)\.$/, to: (match, { t }) => `Google trả về trạng thái "${t(match[1])}" thay vì ${t(match[2])}.` },
  { pattern: /^Claim is now (\S+) and cannot be (released|reinstated|confirmed) through the API \(Google: (.+)\)\.$/, to: (match, { t, tm }) => `Claim hiện ở trạng thái ${t(match[1])} và không thể ${PAST_VERB[match[2]]} qua API (Google: ${tm(match[3])}).` },
  { pattern: /^Google did not answer the (release|reinstate|confirm) call, but the claim reads back (\S+)\.$/, to: (match, { t }) => `Google không phản hồi lệnh ${t(match[1])}, nhưng đọc lại thấy claim đã ở trạng thái ${t(match[2])}.` },
  { pattern: /^(.+) The claim still reads back as (\S+), so the (release|reinstate|confirm) was not applied; retry it\.$/, to: (match, { t, tm }) => `${tm(match[1])} Đọc lại thấy claim vẫn ở trạng thái ${t(match[2])}, nên lệnh ${t(match[3])} chưa được áp dụng; thử lại.` },
  { pattern: /^(.+) The (release|reinstate|confirm) may still have been applied; re-check the claim before trying again\.$/, to: (match, { t, tm }) => `${tm(match[1])} Lệnh ${t(match[2])} có thể vẫn đã được áp dụng; kiểm tra lại claim trước khi thử tiếp.` },
  { pattern: /^Not sent: the claim could not be read before the (release|reinstate|confirm) \((.+)\)\.( Retry\.)?$/, to: (match, { t, tm }) => `Chưa gửi: không đọc được claim trước khi ${t(match[1])} (${tm(match[2])}).${match[3] ? " Thử lại." : ""}` },
  { pattern: /^Claim was already (\S+): the earlier (release|reinstate|confirm) call whose answer was lost had been applied\. Nothing was sent to Google\.$/, to: (match, { t }) => `Claim đã ở trạng thái ${t(match[1])}: lệnh ${t(match[2])} trước đó bị mất phản hồi nhưng đã được áp dụng. Không gửi gì tới Google.` },
  { pattern: /^Claim was already (\S+); nothing was sent to Google\.$/, to: (match, { t }) => `Claim đã ở trạng thái ${t(match[1])}; không gửi gì tới Google.` },
  { pattern: /^Confirmed (\S+) on re-check after an unanswered (release|reinstate|confirm) call\.$/, to: (match, { t }) => `Kiểm tra lại xác nhận trạng thái ${t(match[1])} sau lệnh ${t(match[2])} không nhận được phản hồi.` },
  { pattern: /^Confirmed (\S+); the earlier (release|reinstate|confirm) was recorded\.$/, to: (match, { t }) => `Đã xác nhận trạng thái ${t(match[1])}; lệnh ${t(match[2])} trước đó đã được ghi nhận.` },
  { pattern: /^The claim's asset could not be read, so its labels could not be verified for your account: (.+)$/, to: (match, { tm }) => `Không đọc được asset của claim nên không kiểm tra được label cho tài khoản của bạn: ${tm(match[1])}` },
  { pattern: /^Not sent: (.+)$/, to: (match, { tm }) => `Chưa gửi: ${tm(match[1])}` },

  // --- Google Content ID transport and API log lines (assetDeliveryService.js, deliveryJobService.js, deliveryController.js) ---
  { pattern: /^Google Content ID did not respond within (\d+) s$/, to: "Google Content ID không phản hồi trong {1} giây" },
  { pattern: /^(.+?) \((GET|POST|PUT|PATCH|DELETE|HEAD) (\/\S*)(?:, (\d+) attempts)?\)$/, to: (match, { tm }) => `${tm(match[1])} (${match[2]} ${match[3]}${optional(match[4], (count) => `, ${count} lần thử`)})` },
  { pattern: /^(GET|POST|PUT|PATCH|DELETE|HEAD) (\S+): (.+)$/, to: (match, { tm }) => `${match[1]} ${match[2]}: ${phase(match[3], tm)}` },

  // --- CMS Delivery: validation (deliveryController.js, assetDeliveryService.js, deliveryMediaService.js) ---
  { pattern: /^(Title|Notes|Description|Official URL) must be (\d+) bytes or shorter$/, to: (match) => `${word(FIELDS, match[1])} tối đa ${match[2]} byte` },
  { pattern: /^Unknown ownership mode "(.*)"$/, to: "Chế độ sở hữu không hợp lệ \"{1}\"" },
  { pattern: /^Unsupported asset type "(.*)"$/, to: "Loại asset không hỗ trợ \"{1}\"" },
  { pattern: /^File is larger than the allowed (\d+) MB$/, to: "File lớn hơn giới hạn cho phép {1} MB" },
  { pattern: /^The uploaded body \((\d+) bytes\) does not match the declared file size \((\d+) bytes\)$/, to: "Dữ liệu tải lên ({1} byte) không khớp với kích thước file đã khai báo ({2} byte)" },
  { pattern: /^ISRC (\S+) already belongs to product "(.*)" \(#(\d+)\)$/, to: "ISRC {1} đã thuộc sản phẩm \"{2}\" (#{3})" },
  { pattern: /^ISRC (\S+) is duplicated in this product \(see (track|video) (\d+)\)$/, to: "ISRC {1} bị trùng trong sản phẩm này (xem {2} {3})" },
  { pattern: /^ISRC (\S+) is already used by another (track|video) in this product$/, to: "ISRC {1} đã được một {2} khác trong sản phẩm này sử dụng" },
  { pattern: /^You can check at most (\d+) ISRCs per request$/, to: "Mỗi lần kiểm tra tối đa {1} ISRC" },
  { pattern: /^The same uploaded audio file is attached to track (\d+) as well$/, to: "File audio đã tải lên này cũng đang gắn với track {1}" },
  { pattern: /^"(.+)" is (.+) long; Content ID references must be at least (\d+) seconds\. The file was not stored\.$/, to: (match) => `"${fileName(match[1])}" chỉ dài ${duration(match[2])}; reference Content ID phải dài ít nhất ${match[3]} giây. File chưa được lưu.` },

  // --- CMS Delivery: job and request log messages ---
  { pattern: /^Audio "(.*)" attached \((.+), uploaded while preparing the product\)$/, to: "Đã gắn audio \"{1}\" ({2}, tải lên trong lúc chuẩn bị sản phẩm)" },
  { pattern: /^The uploaded audio could not be attached to the track: (.+)$/, to: (match, { tm }) => `Không gắn được audio đã tải lên vào track: ${tm(match[1])}` },
  { pattern: /^Product created with (\d+) track\(s\)(?:, (\d+) audio file\(s\) uploaded beforehand)?$/, to: (match) => `Đã tạo sản phẩm với ${match[1]} track${optional(match[2], (count) => `, ${count} file audio đã tải lên trước`)}` },
  { pattern: /^Retry failed at (\S+): (.+)$/, to: (match, { tm }) => `Thử lại thất bại ở bước ${step(match[1])}: ${tm(match[2])}` },
  { pattern: /^Retry succeeded \((\S+)\)$/, to: (match) => `Thử lại thành công (${trackStatus(match[1])})` },
  { pattern: /^(Video|Audio) "(.*)" stored \((.+)\)$/, to: (match) => `Đã lưu ${match[1] === "Video" ? "video" : "audio"} "${match[2]}" (${match[3]})` },
  { pattern: /^Could not read the stored audio: (.+)$/, to: (match, { tm }) => `Không đọc được audio đã lưu: ${tm(match[1])}` },
  { pattern: /^Audio "(.*)" removed$/, to: "Đã xóa audio \"{1}\"" },
  { pattern: /^Removed "(.*)" from this server \((.+)\); reference (\S+) stays in CMS$/, to: "Đã xóa \"{1}\" khỏi server này ({2}); reference {3} vẫn còn trong CMS" },
  { pattern: /^Could not remove "(.*)": (.+)$/, to: (match, { tm }) => `Không xóa được "${match[1]}": ${tm(match[2])}` },
  { pattern: /^Freed (.+) by removing (\d+) audio file\(s\)(?:, (\d+) track\(s\) kept their file)?$/, to: (match) => `Giải phóng ${match[1]} bằng cách xóa ${match[2]} file audio${optional(match[3], (count) => `, ${count} track vẫn giữ file`)}` },
  { pattern: /^Reference(?: (\S+))? created from claim (\S+)$/, to: (match) => `Đã tạo reference${optional(match[1], (id) => ` ${id}`)} từ claim ${match[2]}` },
  { pattern: /^Synced from CMS \((\S+), (\d+) reference\(s\)\)$/, to: (match) => `Đã đồng bộ từ CMS (${trackStatus(match[1])}, ${match[2]} reference)` },
  { pattern: /^Synced (\d+) of (\d+) track\(s\) from CMS$/, to: "Đã đồng bộ {1}/{2} track từ CMS" },
  { pattern: /^Release info updated and applied to (\d+) asset\(s\)(?:, (\d+) failed)?$/, to: (match) => `Đã cập nhật thông tin bản phát hành và áp dụng cho ${match[1]} asset${optional(match[2], (count) => `, ${count} thất bại`)}` },
  { pattern: /^Track updated locally but the CMS update failed: (.+)$/, to: (match, { tm }) => `Đã cập nhật track trên hệ thống nhưng cập nhật CMS thất bại: ${tm(match[1])}` },
  { pattern: /^Rights updated on (\d+) of (\d+) asset\(s\)(?:, (\d+) failed)?$/, to: (match) => `Đã cập nhật quyền trên ${match[1]}/${match[2]} asset${optional(match[3], (count) => `, ${count} thất bại`)}` },
  { pattern: /^(\d+) errors: (.+)$/, to: (match, { tm }) => `${match[1]} lỗi: ${each(match[2], tm)}` },
  { pattern: /^Could not list references: (.+)$/, to: (match, { tm }) => `Không liệt kê được reference: ${tm(match[1])}` },
  { pattern: /^Could not list claims: (.+)$/, to: (match, { tm }) => `Không liệt kê được claim: ${tm(match[1])}` },
  { pattern: /^Reference (\S+) is still being deactivated by Google; try again in a few minutes$/, to: "Reference {1} vẫn đang được Google hủy kích hoạt; thử lại sau vài phút" },
  { pattern: /^Reference (\S+) is not ready for delivery \((.+)\)$/, to: (match) => `Reference ${match[1]} chưa sẵn sàng để phân phối (${referenceStatus(match[2])})` },
  { pattern: /^Reference (\S+) uploaded \((.+)\)$/, to: (match) => `Đã tải lên reference ${match[1]} (${referenceStatus(match[2])})` },
  { pattern: /^Takedown: (\d+) of (\d+) track\(s\), (\d+) reference\(s\) deactivated, (\d+) claim\(s\) released(?: - (.+))?$/, to: (match) => `Gỡ nội dung: ${match[1]}/${match[2]} track, ${match[3]} reference đã hủy kích hoạt, ${match[4]} claim đã gỡ${optional(match[5], (reason) => ` - ${reason}`)}` },
  { pattern: /^Reactivated (\d+) of (\d+) track\(s\), (\d+) reference\(s\) activated$/, to: "Đã kích hoạt lại {1}/{2} track, {3} reference đã kích hoạt" },
  { pattern: /^Uploading (.+)$/, to: (match, { tm }) => `Đang tải lên ${tm(match[1])}` },
  { pattern: /^Starting (\S+)$/, to: (match) => `Bắt đầu bước ${step(match[1])}` },
  { pattern: /^Completed (\S+)$/, to: (match) => `Hoàn tất bước ${step(match[1])}` },
  { pattern: /^Removed the delivered file "(.*)" from this server$/, to: "Đã xóa file đã phân phối \"{1}\" khỏi server này" },
  { pattern: /^Delivery succeeded, but removing the local file failed: (.+)$/, to: (match, { tm }) => `Phân phối thành công, nhưng xóa file trên server thất bại: ${tm(match[1])}` },
  { pattern: /^Delivering track (\d+): (.*)$/, to: "Đang phân phối track {1}: {2}" },
  { pattern: /^Track finished \((\S+)\)$/, to: (match) => `Track kết thúc (${trackStatus(match[1])})` },
  { pattern: /^Delivery failed: (.+)$/, to: (match, { tm }) => `Phân phối thất bại: ${tm(match[1])}` },
  { pattern: /^Checking (\d+) track\(s\) for duplicate ISRCs$/, to: "Đang kiểm tra {1} track có ISRC trùng" },
  { pattern: /^Duplicate check failed: (.+)$/, to: (match, { tm }) => `Kiểm tra trùng thất bại: ${tm(match[1])}` },
  { pattern: /^Processed (\d+)\/(\d+) track\(s\)$/, to: "Đã xử lý {1}/{2} track" },
  { pattern: /^Delivered (\d+) of (\d+) track\(s\), (\d+) reference\(s\) uploaded(?:, (\d+) duplicate)?(?:, (\d+) failed)?$/, to: (match) => `Đã phân phối ${match[1]}/${match[2]} track, ${match[3]} reference đã tải lên${optional(match[4], (count) => `, ${count} trùng`)}${optional(match[5], (count) => `, ${count} thất bại`)}` },
  { pattern: /^Started reference delivery of (\d+) track\(s\)$/, to: "Bắt đầu phân phối reference cho {1} track" },
  { pattern: /^Started delivery of (\d+) track\(s\)$/, to: "Bắt đầu phân phối {1} track" },
  { pattern: /^Delivery job failed: (.+)$/, to: (match, { tm }) => `Tác vụ phân phối thất bại: ${tm(match[1])}` },

  // --- Policy summaries built by the server ("Monetize (WW) · Block (exclude US, CA) · review") ---
  { pattern: POLICY_SUMMARY, to: (match) => match[0].split(" · ").map(policyPart).join(" · ") },

  // --- Content ID codes, products, whitelist, label sync (contentIdController.js, assetLabelSyncService.js) ---
  { pattern: /^(\S+) already exists as (ISRC|UPC)$/, to: "{1} đã tồn tại dưới dạng {2}" },
  { pattern: /^(ISRC|UPC) (\S+) is already used$/, to: "{1} {2} đã được sử dụng" },
  { pattern: /^Invalid ISRC: (.+)$/, to: "ISRC không hợp lệ: {1}" },
  { pattern: /^Duplicated ISRC in this product: (\S+)$/, to: "ISRC bị trùng trong sản phẩm này: {1}" },
  { pattern: /^Could not fetch channel info for (\d+) channel\(s\)\.$/, to: "Không lấy được thông tin của {1} kênh." },
  { pattern: /^Synced channel info for (\d+) channel\(s\)\. (\d+) channel\(s\) not found\.$/, to: "Đã đồng bộ thông tin {1} kênh. {2} kênh không tìm thấy." },
  { pattern: /^Added (\d+) channel\(s\), (\d+) skipped, (\d+) error\(s\)$/, to: "Đã thêm {1} kênh, {2} bỏ qua, {3} lỗi" },
  { pattern: /^Removed (\d+) channel\(s\), (\d+) error\(s\)$/, to: "Đã xóa {1} kênh, {2} lỗi" },
  { pattern: /^YouTube Data API batch (\d+)$/, to: "Lô YouTube Data API {1}" },
  { pattern: /^CMS is connected but Network ID is missing for: (.+)\. Please fill ID Network in Settings > Network\.$/, to: "CMS đã kết nối nhưng thiếu Network ID cho: {1}. Điền ID Network trong Cài đặt > Network." },
  { pattern: /^CMS refresh token is missing for: (.+)\. Please re-auth CMS in Settings > Network\.$/, to: "Thiếu refresh token CMS cho: {1}. Ủy quyền lại CMS trong Cài đặt > Network." },
  { pattern: /^No usable connected CMS network found\. Current CMS auth state: (.+)\.$/, to: "Không tìm thấy network CMS đã kết nối nào dùng được. Trạng thái ủy quyền CMS hiện tại: {1}." },

  // --- Generic "<resource> <id>: <message>" prefixes of the takedown report (last: the fixed sentences above win first) ---
  { pattern: /^Reference (\S+): (.+)$/, to: (match, { tm }) => `Reference ${match[1]}: ${tm(match[2])}` },
  { pattern: /^Claim (\S+): (.+)$/, to: (match, { tm }) => `Claim ${match[1]}: ${tm(match[2])}` }
];
