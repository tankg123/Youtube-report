// Vietnamese dictionary — Claim Manager: ClaimManagerPage.jsx, ResultsPanel.jsx, ClaimsTable.jsx.
// Keys are the exact English texts used in the source (t("…") / tk("…")) or produced at runtime (tm()).
// Keep {placeholders} identical to the key. Identity entries ("ISRC": "ISRC") are fine.
export default {
  // ---------------------------------------------------------------------------
  // ClaimManagerPage.jsx — header, tabs, empty state
  // ---------------------------------------------------------------------------
  "Content ID operations": "Vận hành Content ID",
  "Claim Manager": "Quản lý claim",
  "Look up the Content ID claims owned by your CMS networks, release active, pending or potential claims, confirm potential ones and reinstate released ones through the official YouTube Partner API. Every status change is recorded in the release history.":
    "Tra cứu các claim Content ID thuộc các network CMS của bạn, gỡ claim đang hoạt động, đang chờ hoặc tiềm năng, xác nhận claim tiềm năng và khôi phục claim đã gỡ qua YouTube Partner API chính thức. Mọi thay đổi trạng thái đều được ghi vào lịch sử gỡ claim.",
  "Refresh CMS": "Làm mới CMS",
  "{count} CMS ready": "{count} CMS sẵn sàng",
  "{count} need re-authorization": "{count} cần ủy quyền lại",
  "Retry": "Thử lại",
  "Could not load CMS networks: {error}": "Không tải được network CMS: {error}",
  "Check claims": "Kiểm tra claim",
  "Release history": "Lịch sử gỡ claim",
  "No connected CMS network": "Chưa kết nối network CMS nào",
  "Connect a YouTube CMS (content owner) with the Content ID OAuth in Settings > Network, then come back to check claims.":
    "Kết nối một YouTube CMS (content owner) bằng OAuth Content ID trong Cài đặt > Network, rồi quay lại để kiểm tra claim.",
  "Ask an administrator to connect a YouTube CMS (content owner) with the Content ID OAuth in Settings > Network, then come back to check claims.":
    "Nhờ quản trị viên kết nối một YouTube CMS (content owner) bằng OAuth Content ID trong Cài đặt > Network, rồi quay lại để kiểm tra claim.",
  "Open Networks": "Mở Network",

  // ClaimManagerPage.jsx — bulk write guards, row re-check toasts
  "None of these claims can be released.": "Không claim nào trong số này có thể gỡ.",
  "None of these claims can be activated: only potential and released claims can.": "Không claim nào trong số này có thể kích hoạt: chỉ claim tiềm năng và claim đã gỡ mới kích hoạt được.",
  "No answer from the server for this claim": "Server không trả lời cho claim này",
  "Claim {id}: {message}": "Claim {id}: {message}",
  "Claim {id} is now {status}": "Claim {id} hiện ở trạng thái {status}",
  "Claim {id} is now {status}: {message}": "Claim {id} hiện ở trạng thái {status}: {message}",
  "Re-check failed: {message}": "Kiểm tra lại thất bại: {message}",

  // ClaimManagerPage.jsx — single-claim reinstate / confirm dialog (ACTIVATE_ONE_COPY) and its toasts
  "Reinstate claim": "Khôi phục claim",
  "Reinstate": "Khôi phục",
  "Set claim {id} back to active? The video is claimed again right away and the asset's policy applies to it.":
    "Đặt claim {id} về trạng thái hoạt động? Video sẽ bị claim lại ngay và policy của asset được áp dụng cho video.",
  "Reinstating": "Việc khôi phục",
  "the claim is no longer inactive, or the status change is not allowed": "claim không còn ở trạng thái đã gỡ, hoặc không được phép đổi trạng thái",
  "Reason for the reinstate, ticket number, requester…": "Lý do khôi phục, số ticket, người yêu cầu…",
  "Confirm claim": "Xác nhận claim",
  "Confirm": "Xác nhận",
  "Confirm claim {id} as a valid match? It becomes active right away and the asset's policy applies to the video.":
    "Xác nhận claim {id} là kết quả khớp hợp lệ? Claim sẽ hoạt động ngay và policy của asset được áp dụng cho video.",
  "Confirming": "Việc xác nhận",
  "the claim is no longer potential, or the status change is not allowed": "claim không còn ở trạng thái tiềm năng, hoặc không được phép đổi trạng thái",
  "Reason for the confirm, ticket number, requester…": "Lý do xác nhận, số ticket, người yêu cầu…",
  "This claim cannot be confirmed.": "Không thể xác nhận claim này.",
  "This claim cannot be reinstated.": "Không thể khôi phục claim này.",
  "Claim ID": "Claim ID",
  "Asset": "Asset",
  "CMS": "CMS",
  "{action} is logged in Release history with your name and note. If Google refuses ({refused}), nothing changes.":
    "{action} được ghi vào lịch sử gỡ claim cùng tên bạn và ghi chú. Nếu Google từ chối ({refused}), sẽ không có gì thay đổi.",
  "{action} is logged in Release history with your name. If Google refuses ({refused}), nothing changes.":
    "{action} được ghi vào lịch sử gỡ claim cùng tên bạn. Nếu Google từ chối ({refused}), sẽ không có gì thay đổi.",
  "Note (optional, saved in the release log)": "Ghi chú (không bắt buộc, lưu vào log gỡ claim)",
  "Claim {id} reinstated: active again on {video}": "Đã khôi phục claim {id}: hoạt động lại trên {video}",
  "Claim {id} confirmed: active on {video}": "Đã xác nhận claim {id}: đang hoạt động trên {video}",
  "Claim {id} was already active; nothing changed.": "Claim {id} vốn đã hoạt động; không có gì thay đổi.",
  "Google did not answer; re-check the claim status before retrying.": "Google không phản hồi; kiểm tra lại trạng thái claim trước khi thử lại.",
  "refused by the server": "server từ chối",
  "Claim {id} was not confirmed: {reason}": "Claim {id} chưa được xác nhận: {reason}",
  "Claim {id} was not reinstated: {reason}": "Claim {id} chưa được khôi phục: {reason}",
  "Retry after {seconds} s.": "Thử lại sau {seconds} giây.",
  "{action} failed: {message}": "{action} thất bại: {message}",

  // ---------------------------------------------------------------------------
  // ResultsPanel.jsx — request plan, loading, pagination summary
  // ---------------------------------------------------------------------------
  "{count} claim-search read": "{count} lượt đọc claim-search",
  "{count} claim-search reads": "{count} lượt đọc claim-search",
  "{count} claim read": "{count} lượt đọc claim",
  "{count} claim reads": "{count} lượt đọc claim",
  "{count} claim status read": "{count} lượt đọc trạng thái claim",
  "{count} claim status reads": "{count} lượt đọc trạng thái claim",
  "{count} status call": "{count} lượt gọi đổi trạng thái",
  "{count} status calls": "{count} lượt gọi đổi trạng thái",
  "{count} asset read": "{count} lượt đọc asset",
  "{count} asset reads": "{count} lượt đọc asset",
  "{count} video read": "{count} lượt đọc video",
  "{count} video reads": "{count} lượt đọc video",
  "Requests made for this search": "Số request của lần tìm này",
  "Searching the selected CMS networks…": "Đang tìm trong các network CMS đã chọn…",
  "{claims} claim in {videos} video": "{claims} claim trong {videos} video",
  "{claims} claim in {videos} videos": "{claims} claim trong {videos} video",
  "{claims} claims in {videos} video": "{claims} claim trong {videos} video",
  "{claims} claims in {videos} videos": "{claims} claim trong {videos} video",
  "{count} video on this page": "{count} video trên trang này",
  "{count} videos on this page": "{count} video trên trang này",
  "Showing {start}–{end} of {total} claim": "Hiển thị {start}–{end} trong {total} claim",
  "Showing {start}–{end} of {total} claims": "Hiển thị {start}–{end} trong {total} claim",
  "No claims": "Không có claim",

  // ResultsPanel.jsx — stat tiles
  "Videos": "Video",
  "Requested videos": "Video đã yêu cầu",
  "Distinct videos in the results": "Số video khác nhau trong kết quả",
  "Claims": "Claim",
  "{count} match the filters": "{count} khớp bộ lọc",
  "Across the selected CMS": "Trên các CMS đã chọn",
  "Releasable": "Có thể gỡ",
  "Active, pending or potential, allowed for you": "Đang hoạt động, đang chờ hoặc tiềm năng, trong quyền của bạn",
  "Activatable": "Có thể kích hoạt",
  "Potential or released, allowed for you": "Tiềm năng hoặc đã gỡ, trong quyền của bạn",
  "Selected": "Đã chọn",
  "of {max} per run": "trong {max} mỗi lượt chạy",
  "Errors": "Lỗi",
  "See the messages below": "Xem thông báo bên dưới",
  "No CMS error": "Không có lỗi CMS",

  // ResultsPanel.jsx — server messages, empty states
  "Some CMS could not be read completely": "Một số CMS chưa đọc được đầy đủ",
  "{count} input skipped by the server": "Server đã bỏ qua {count} dòng nhập",
  "{count} inputs skipped by the server": "Server đã bỏ qua {count} dòng nhập",
  "Search for claims": "Tìm claim",
  "Pick your CMS networks, paste video links, asset IDs or claim IDs on the left and press Search (Ctrl+Enter).":
    "Chọn network CMS, dán link video, asset ID hoặc claim ID ở bên trái rồi nhấn Tìm kiếm (Ctrl+Enter).",
  "The search did not complete": "Tìm kiếm chưa hoàn tất",
  "Fix the problem above and search again.": "Khắc phục lỗi ở trên rồi tìm lại.",
  "No claims found": "Không tìm thấy claim",
  "The selected CMS own no claim matching this search.": "Các CMS đã chọn không sở hữu claim nào khớp tìm kiếm này.",
  "No claims match the filters": "Không có claim khớp bộ lọc",
  "Try another text or status.": "Thử từ khóa hoặc trạng thái khác.",
  "Clear filters": "Xóa bộ lọc",

  // ResultsPanel.jsx — toolbar
  "Quick filter": "Bộ lọc nhanh",
  "Filter by claim, video, asset, title, ISRC, UPC or label…": "Lọc theo claim, video, asset, tiêu đề, ISRC, UPC hoặc label…",
  "Clear quick filter": "Xóa bộ lọc nhanh",
  "Clear the text filter": "Xóa từ khóa lọc",
  "Group by video": "Nhóm theo video",
  "Select all releasable": "Chọn tất cả claim có thể gỡ",
  "Select all activatable": "Chọn tất cả claim có thể kích hoạt",
  "No releasable claim in the current view": "Không có claim có thể gỡ trong khung nhìn hiện tại",
  "Every releasable claim in view is already selected": "Mọi claim có thể gỡ trong khung nhìn đã được chọn",
  "Add the releasable claims of the current view to the selection": "Thêm các claim có thể gỡ trong khung nhìn hiện tại vào danh sách chọn",
  "No activatable claim in the current view": "Không có claim có thể kích hoạt trong khung nhìn hiện tại",
  "Every activatable claim in view is already selected": "Mọi claim có thể kích hoạt trong khung nhìn đã được chọn",
  "Add the activatable claims of the current view to the selection": "Thêm các claim có thể kích hoạt trong khung nhìn hiện tại vào danh sách chọn",
  "Clear selection": "Bỏ chọn",
  "Export the filtered rows (all pages)": "Xuất các dòng đã lọc (mọi trang)",
  "Export CSV": "Xuất CSV",
  "Set the selected active, pending or potential claims to inactive": "Chuyển các claim đang hoạt động, đang chờ hoặc tiềm năng đã chọn sang đã gỡ",
  "Release selected ({count})": "Gỡ claim đã chọn ({count})",
  "Confirm the selected potential claims and reinstate the selected released claims (set them active)":
    "Xác nhận các claim tiềm năng đã chọn và khôi phục các claim đã gỡ đã chọn (chuyển sang hoạt động)",
  "Activate selected ({count})": "Kích hoạt claim đã chọn ({count})",
  "{count} selected claim can only be released: Activate cannot take it.": "{count} claim đã chọn chỉ có thể gỡ: Kích hoạt không nhận claim này.",
  "{count} selected claims can only be released: Activate cannot take them.": "{count} claim đã chọn chỉ có thể gỡ: Kích hoạt không nhận các claim này.",
  "{count} selected claim can only be activated: Release cannot take it.": "{count} claim đã chọn chỉ có thể kích hoạt: Gỡ không nhận claim này.",
  "{count} selected claims can only be activated: Release cannot take them.": "{count} claim đã chọn chỉ có thể kích hoạt: Gỡ không nhận các claim này.",
  "All": "Tất cả",

  // ResultsPanel.jsx — selection / export toasts
  "A run can include at most {max} claims. Release or activate the current selection first.": "Mỗi lượt chạy tối đa {max} claim. Gỡ hoặc kích hoạt các claim đã chọn trước.",
  "Only {room} more claims fit in this run (limit {max}). Release or activate the current selection first.":
    "Chỉ thêm được {room} claim nữa vào lượt chạy này (giới hạn {max}). Gỡ hoặc kích hoạt các claim đã chọn trước.",
  "The selection is full ({max} claims per run). Release it, then select the rest.": "Danh sách chọn đã đầy ({max} claim mỗi lượt chạy). Gỡ các claim này trước, rồi chọn phần còn lại.",
  "The selection is full ({max} claims per run). Activate it, then select the rest.":
    "Danh sách chọn đã đầy ({max} claim mỗi lượt chạy). Kích hoạt các claim này trước, rồi chọn phần còn lại.",
  "Added {added} of {total} releasable claim: a run can include at most {max} claims. Release them, then select the rest.":
    "Đã thêm {added} trong {total} claim có thể gỡ: mỗi lượt chạy tối đa {max} claim. Gỡ các claim này trước, rồi chọn phần còn lại.",
  "Added {added} of {total} releasable claims: a run can include at most {max} claims. Release them, then select the rest.":
    "Đã thêm {added} trong {total} claim có thể gỡ: mỗi lượt chạy tối đa {max} claim. Gỡ các claim này trước, rồi chọn phần còn lại.",
  "Added {added} of {total} activatable claim: a run can include at most {max} claims. Activate them, then select the rest.":
    "Đã thêm {added} trong {total} claim có thể kích hoạt: mỗi lượt chạy tối đa {max} claim. Kích hoạt các claim này trước, rồi chọn phần còn lại.",
  "Added {added} of {total} activatable claims: a run can include at most {max} claims. Activate them, then select the rest.":
    "Đã thêm {added} trong {total} claim có thể kích hoạt: mỗi lượt chạy tối đa {max} claim. Kích hoạt các claim này trước, rồi chọn phần còn lại.",
  "Selected {count} more releasable claim ({total} in total)": "Đã chọn thêm {count} claim có thể gỡ (tổng cộng {total})",
  "Selected {count} more releasable claims ({total} in total)": "Đã chọn thêm {count} claim có thể gỡ (tổng cộng {total})",
  "Selected {count} more activatable claim ({total} in total)": "Đã chọn thêm {count} claim có thể kích hoạt (tổng cộng {total})",
  "Selected {count} more activatable claims ({total} in total)": "Đã chọn thêm {count} claim có thể kích hoạt (tổng cộng {total})",
  "Exported {count} claim to CSV": "Đã xuất {count} claim ra CSV",
  "Exported {count} claims to CSV": "Đã xuất {count} claim ra CSV",

  // ---------------------------------------------------------------------------
  // ClaimsTable.jsx — columns, row cells and actions
  // ---------------------------------------------------------------------------
  "Video": "Video",
  "Claim": "Claim",
  "Status": "Trạng thái",
  "Type": "Loại",
  "Origin": "Nguồn",
  "Created": "Ngày tạo",
  "Modified": "Ngày sửa",
  "Actions": "Thao tác",
  "Sort by {column}": "Sắp xếp theo {column}",
  "Select claim {id}": "Chọn claim {id}",
  "Deselect claim {id}": "Bỏ chọn claim {id}",
  "Open claim details": "Mở chi tiết claim",
  "3rd party": "Bên thứ ba",
  "Partner upload": "Đối tác tải lên",
  "{outcome} in this session": "{outcome} trong phiên này",
  "Reinstate failed: ": "Khôi phục thất bại: ",
  "Confirm failed: ": "Xác nhận thất bại: ",
  "Re-check before retrying": "Kiểm tra lại trước khi thử lại",
  "Details": "Chi tiết",
  "Ask Google for the current status": "Hỏi Google trạng thái hiện tại",
  "Re-check": "Kiểm tra lại",
  "Set this released claim back to active": "Đặt claim đã gỡ này về trạng thái hoạt động",
  "Confirm this potential claim: set it active": "Xác nhận claim tiềm năng này: chuyển sang hoạt động",
  "Release": "Gỡ",

  // ClaimsTable.jsx — grouped view headers, pager
  "Select all releasable or activatable claims of video {id}": "Chọn tất cả claim có thể gỡ hoặc kích hoạt của video {id}",
  "Select all releasable or activatable claims of this video": "Chọn tất cả claim có thể gỡ hoặc kích hoạt của video này",
  "No releasable or activatable claim on this video": "Video này không có claim có thể gỡ hoặc kích hoạt",
  "{count} claim": "{count} claim",
  "{count} claims": "{count} claim",
  "No owned claim": "Không có claim sở hữu",
  "{count} releasable": "{count} có thể gỡ",
  "{count} activatable": "{count} có thể kích hoạt",
  "Previous page": "Trang trước",
  "Next page": "Trang sau",
  "Page {page} / {pageCount}": "Trang {page} / {pageCount}"
};
