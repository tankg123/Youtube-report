# Làm mới token CMS trên production

Chạy các lệnh sau trong thư mục `backend`, với cùng biến môi trường và cùng file SQLite mà tiến trình API hoặc worker đang dùng.

1. Chạy `npm run cms:oauth:check` để xem ID network, trạng thái kết nối, thời điểm access token hết hạn và dấu vân tay của các OAuth client đã cấu hình. Dấu vân tay là 12 ký tự đầu của SHA-256 của client ID. So sánh kết quả giữa các instance khi lỗi xuất hiện sau một lần deploy.
2. Chạy `npm run cms:oauth:check -- --identify 2` (thay 2 bằng ID network). Lệnh hiển thị **client ID công khai** đã cấp quyền. Với kết nối cũ, lệnh hỏi Google về access token hiện có. Nếu token này đã hết hạn và chưa có thông tin liên kết trong database, đối chiếu client với cấu hình của bản deploy đã kết nối CMS.
3. Nếu client cấp quyền khác client hiện tại, đặt `GOOGLE_PREVIOUS_CLIENT_ID` và `GOOGLE_PREVIOUS_CLIENT_SECRET` thành **cặp thông tin của client ban đầu** trong cấu hình bí mật của API và tất cả worker. Có thể tiếp tục dùng `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET` cho kết nối mới. Nếu chỉ xoay secret trên cùng một client ID, đặt secret đang hoạt động cho đúng ID đó. Nạp lại cấu hình trên các instance.
4. Chạy `npm run cms:oauth:check -- --refresh 2`. Lệnh dùng refresh token đã lưu và ghi lại token mới cùng client ID khi Google chấp nhận. Lệnh này cũng có thể phục hồi một kết nối đang ở trạng thái lỗi nếu grant còn dùng được. Một CMS đã được chủ động ngắt kết nối phải được kết nối lại qua giao diện.

Trong **Settings → Network**, quản trị viên có thể chọn **Kiểm tra kết nối đã lưu** trên đúng CMS để yêu cầu Google làm mới token ngay, kể cả khi access token hiện tại còn hạn. Sau khi thành công, nhấn **Thử lại** ở trang Check để tiếp tục truy vấn hiện tại.

Để kiểm tra cả quyền truy vấn asset trên máy production, chạy `npm run cms:oauth:check -- --refresh 2 "Yella"` trong thư mục `backend`. Dòng `refreshedNetwork` xác nhận Google đã chấp nhận refresh token. Dòng `assetsOnFirstPage` và `total` là kết quả tìm kiếm thực tế với bộ lọc All assets và All types.

`unauthorized_client` hoặc `invalid_client` là lỗi ở bước Google xử lý OAuth client. Kiểm tra cặp thông tin đã triển khai và trạng thái client trong Google Auth Platform. Nếu Google trả `invalid_grant` cho đúng client và quyền đã hết hạn hoặc bị thu hồi, cần cấp quyền lại một lần trong **Settings → Network**.

Grant CMS mới chỉ xin các quyền dùng trong ứng dụng. Grant cũ chứa `youtubepartner-channel-audit` vẫn chịu thời hạn thu hồi dành cho quy trình audit của YouTube. [Quy định về channel audit của YouTube](https://developers.google.com/youtube/v3/docs/channels/list)
