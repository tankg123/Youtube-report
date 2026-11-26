# Analytics: đồng bộ hằng ngày 09:00 và kho dữ liệu theo ngày (hướng dẫn vận hành)

Tài liệu này dành cho người vận hành backend. Nó mô tả lượt đồng bộ tự động lúc **09:00 GMT+7**, cách số liệu được ghi theo từng ngày (không ghi đè số đã lưu), các chế độ của nút **Đồng bộ toàn bộ**, cách đọc trạng thái buổi sáng, việc kết nối lại CMS, quy trình go-live và cách quay lui. Hợp đồng HTTP nằm ở `analytics-api.md`; cấu trúc bảng và quy tắc ghi nằm ở `analytics-warehouse.md`.

## 1. Tóm tắt

- Mỗi ngày lúc **09:00 GMT+7** (`02:00 UTC`), scheduler tạo một tác vụ `daily` cho mỗi Content Owner có lịch bật. Máy chủ kiểm tra lịch khi khởi động và mỗi 30 giây.
- Tác vụ `daily` đọc lại **toàn bộ cửa sổ** (mặc định 7 ngày, kết thúc ở ngày GMT+7 hiện tại trừ 3 ngày) và ghi ở chế độ **chỉ thêm số mới** (`append`): ngày chưa có thì thêm, ngày đã có thì **giữ nguyên**; nếu YouTube báo số khác, hệ thống ghi nhận **số liệu lệch** (`drift`) vào nhật ký thay đổi để xem lại.
- Nút **Đồng bộ toàn bộ** hỏi trước: *Chỉ thêm số mới* hay *Ghi đè số cũ*. Ghi đè chỉ dành cho quản trị viên / Report Manager và luôn đi qua nhật ký thay đổi (số cũ được giữ).
- Số liệu được lưu theo **ngày giờ Thái Bình Dương** cho từng thực thể: Content Owner theo phạm vi (`owner:claimed`, `owner:self`, `owner:thirdParty`) và từng kênh (`channel:UC…`). Bảng độ phủ (`analytic_day_coverage`) ghi nhận ngày nào đã được hỏi thành công, kể cả khi YouTube trả về 0 dòng.
- Báo cáo theo kỳ (top video, doanh thu video, độ tuổi/giới tính, báo cáo kênh chi tiết) vẫn là snapshot và được làm mới ở mỗi lượt.

## 2. Lượt 09:00: cửa sổ ngày, độ trễ và watermark

**Cửa sổ ngày.** `endDate = ngày GMT+7 hiện tại − lagDays` (`lagDays` 3–7, mặc định 3), `startDate = endDate − (lookbackDays − 1)` (`lookbackDays` 3–90, mặc định 7). Ví dụ chạy sáng `2026-10-30` sẽ hỏi `2026-10-21 … 2026-10-27`. `lagDays` chỉ là **giới hạn hỏi**, không phải lời hứa: YouTube công bố số liệu của một ngày sau 48–72 giờ (tính từ nửa đêm giờ Thái Bình Dương), nên lúc 09:00 GMT+7 ngày `T − 3` mới trôi qua khoảng 43 giờ và thường **chưa công bố**. Lượt chạy lưu **mọi ngày YouTube đã công bố** trong cửa sổ — bình thường đến `T − 4`, và 1–2 ngày cuối cửa sổ còn `pending` cho tới lượt hôm sau. Vì vậy số ngày đã phủ sau một lượt lành mạnh thường nhỏ hơn `days.requested` 1–2 ngày; đó là bình thường, không cần tăng `lagDays` hay giảm `lookbackDays`.

**Watermark.** Với mỗi phạm vi, backend hỏi báo cáo theo ngày cho cả cửa sổ. Ngày cuối cùng YouTube trả về là *watermark*. Mọi ngày ≤ watermark được đánh dấu độ phủ (kể cả ngày không có dòng nào: đó là số 0 thật). Ngày sau watermark **không** được đánh dấu: giao diện hiển thị là **chưa công bố** (`pending`) và lượt hôm sau sẽ hỏi lại. Chỉ số doanh thu có watermark riêng (`money`) vì YouTube công bố doanh thu muộn hơn; độ phủ doanh thu không bao giờ được đánh dấu vượt quá độ phủ số liệu cơ bản.

**Phạm vi trống.** Nếu một phạm vi (ví dụ `thirdParty`) không trả về dòng nào, nó mượn watermark của phạm vi đầu tiên có dữ liệu (thường là `claimed`) và các ngày đó được ghi nhận là số 0 thật, không bị hỏi lại ở các hình dạng theo ngày.

**Kênh.** Với mỗi ngày đã công bố, backend hỏi các kênh **chưa có độ phủ** cho ngày đó theo lô (`ANALYTICS_CHANNEL_BATCH`, mặc định 200, tối đa 500 ID mỗi yêu cầu). Kênh không có hoạt động bị YouTube bỏ khỏi kết quả: kênh đó vẫn được đánh dấu độ phủ (giao diện hiển thị "—" vì không có dòng) và không bị hỏi lại. Doanh thu kênh chỉ được hỏi cho kênh đã có số liệu cơ bản.

**Phân tích theo chiều.** Các chiều đi kèm `day` (nguồn truy cập, vị trí phát, thiết bị, hệ điều hành, trạng thái đăng ký, trực tiếp/VOD, sản phẩm YouTube, loại nội dung; `adType` khi có doanh thu) được hỏi theo khối ≤ 90 ngày cho cả cửa sổ. Các chiều không đi kèm `day` (`country`, `sharingService`) được hỏi **từng ngày**, chỉ cho ngày còn thiếu độ phủ.

**Drift.** Vì cửa sổ được đọc lại mỗi ngày, một số liệu đã lưu mà YouTube sửa lại (thường +1–3 % vài ngày đến vài tuần sau) được ghi vào `analytic_daily_history` với `action='drift'` (giá trị trước/sau, từng khóa). Số đã lưu **không đổi**. Dòng drift được giữ 180 ngày; dòng `overwrite` được giữ 365 ngày (`ANALYTICS_HISTORY_OVERWRITE_DAYS`, đọc lại ở mỗi lần dọn; với `refreshProvisional` bật, mỗi lượt có thể thêm nhiều dòng overwrite nên không giữ vĩnh viễn).

**Ngày chưa chốt (tùy chọn).** `refreshProvisional` (mặc định tắt): bật lên thì những ngày trong `settleDays` (3–30, mặc định 7) cuối cửa sổ được ghi ở chế độ **ghi đè** (qua nhật ký thay đổi), phần cũ hơn vẫn chỉ thêm số mới. Dùng khi muốn số của tuần gần nhất tự cập nhật theo YouTube thay vì chỉ ghi nhận lệch.

## 3. Đồng bộ toàn bộ, báo cáo kênh và "Điền ngày còn thiếu"

Thân yêu cầu `POST /api/analytics/sync`:

| Loại (`kind`) | Trường | Ghi chú |
| --- | --- | --- |
| `daily` | `ownerId` | kế hoạch tính lúc chạy từ lịch đã lưu; quyền doanh thu = lịch có doanh thu **và** người bấm có quyền doanh thu (nếu không, tác vụ ghi chú "Revenue was not requested…") |
| `full` | `mode` (`append`/`overwrite`), `startDate`, `endDate` (≤ 366 ngày, `endDate` ≤ ngày giờ Thái Bình Dương đã kết thúc gần nhất), `scopes` (tập con của `claimed`/`self`/`thirdParty`), `channelMode` (`all`/`selected`/`none`), `channelIds` (≤ 200, phải nằm trong danh sách kênh của CMS), `includeBreakdowns`, `includeSnapshots`, `monetary`, `dryRun` | `overwrite` cần quyền ghi đè (quản trị viên / Report Manager); `monetary` cần quyền doanh thu |
| `channelDetail` | `channelId`, `startDate`, `endDate`, `monetary` | số liệu theo ngày của một kênh (chế độ thêm số mới) + các báo cáo theo kỳ của kênh |

- **Chỉ thêm số mới** (`append`): như lượt 09:00 nhưng với khoảng ngày và lựa chọn do người dùng chọn. An toàn chạy nhiều lần.
- **Ghi đè số cũ** (`overwrite`): mọi ngày trong khoảng được thay bằng số mới nhất từ YouTube; mỗi thay đổi tạo một dòng `overwrite` trong nhật ký (số cũ nguyên vẹn, `revision` +1). Kênh được hỏi lại đủ, kể cả ngày đã có độ phủ.
- **Điền ngày còn thiếu** (nút trên dải độ phủ) gửi một yêu cầu `full`/`append` cho khoảng ngày còn thiếu (không gồm ngày chưa công bố), không làm mới snapshot.
- `dryRun: true` trả về **kế hoạch** (`plan`): số yêu cầu ước tính theo từng hình dạng, số ngày, số kênh, giới hạn (`ANALYTICS_MAX_REQUESTS_PER_JOB`, mặc định 5000). Vượt giới hạn → HTTP 400 kèm `plan`; rút ngắn khoảng ngày hoặc chọn ít kênh hơn.
- Hàng đợi: mỗi Content Owner tối đa 1 tác vụ đang chạy + 2 tác vụ chờ do người dùng tạo (HTTP 409 `tooManyJobs`); tác vụ của lịch không bị giới hạn này. Yêu cầu giống hệt một tác vụ đang chờ/đang chạy được dùng lại (`deduplicated: true`).
- Snapshot theo kỳ được làm mới cho các khoảng 7/28/90 ngày kết thúc tại `min(endDate, watermark)` (và cho đúng khoảng tùy chỉnh của `full`). Dọn dẹp (cùng báo cáo/phạm vi, cấp Content Owner, `end_date` cũ hơn mốc đó quá 7 ngày): một snapshot **preset** (dài đúng 7/28/90 ngày) chỉ bị xóa khi đã có snapshot mới hơn cùng độ dài thay thế (preset mà lượt này không ghi lại được, ví dụ yêu cầu lỗi, vẫn giữ); một snapshot **khoảng tùy chỉnh** (từ Đồng bộ toàn bộ của người dùng) được giữ **30 ngày** kể từ lúc lưu. Báo cáo `custom:` của Explorer không bị đụng tới.

Tiến độ tác vụ: `completed/total` là số yêu cầu đã gửi / dự kiến (`total` được chỉnh lại theo số lệnh gọi metadata video thực tế — `⌈số video khác nhau / 50⌉` — khi bước đó bắt đầu, nên `completed` đạt đúng `total` lúc kết thúc; `plan.requests.estimate` vẫn là cận trên "Tối đa N request"); `result.steps` liệt kê từng bước (`inventory`, `ownerFacts:<scope>`, `channelFacts`, `breakdown:<dimension>`, `snapshots`) với bộ đếm `inserted / updated / enriched / unchanged / drift / skipped`, trạng thái và lỗi đầu tiên. `result.days` cho biết ngày đã thêm / lệch; `result.channels` số kênh dự kiến / đã phủ.

**Lỗi và cầu dao.** Mỗi yêu cầu Google được thử tối đa **3 lần** (5xx/timeout; `retry-after` được tôn trọng, tối đa 5 giây; 401 → làm mới token một lần, không tính vào số lần thử). Với các yêu cầu Analytics: hết hạn mức (`quotaExceeded`, `dailyLimitExceeded`, `rateLimitExceeded`), **HTTP 429 còn sót sau 3 lần thử** (dù body không ghi lý do), thiếu quyền (HTTP 403), 401 sau khi làm mới token, CMS mất kết nối → tác vụ **thất bại ngay** (`failed`, số đã ghi được giữ, lý do ghi rõ). Hai ngoại lệ:
  - **Danh sách kênh (Data API `channels.list`)**: hạn mức Data API độc lập với Analytics, nên 403 `quotaExceeded`/`accessNotConfigured`/`forbidden`, 429 và 5xx/timeout chỉ là **cảnh báo** của bước `inventory` (ghi chú *The channel listing failed; continuing with {n} stored channels*) và tác vụ tiếp tục với các kênh đang hoạt động đã lưu (bước thất bại chỉ khi chưa có kênh nào được lưu). Chỉ lỗi **xác thực bị từ chối** (401 sau khi làm mới token, `invalid_grant`, `invalid_client`, `unauthorized_client`, CMS mất kết nối) mới làm tác vụ thất bại.
  - **Thiếu scope doanh thu**: một yêu cầu doanh thu (MONEY) bị Google trả 403 `insufficientPermissions` (token CMS không có `yt-analytics-monetary.readonly`) → doanh thu bị **bỏ qua cho phần còn lại của tác vụ** (không gửi thêm yêu cầu doanh thu nào), ghi chú *Revenue was skipped: the CMS token has no revenue scope.* một lần trong `result.notes` và ở bước đó; bước `breakdown:adType` thành `skipped` với cùng ghi chú. Tác vụ vẫn `completed`, số liệu cơ bản/phân tích/snapshot ghi bình thường, không ngày nào được đánh dấu độ phủ doanh thu. Lượt hôm sau thử doanh thu lại (một 403 mỗi ngày) và tự hồi phục khi scope được cấp. 403 `forbidden` trên yêu cầu doanh thu vẫn là lỗi chết (Content Owner không được phép, không phải thiếu scope).

  Lỗi phía Google (`internalError`, `backendError`, timeout) chỉ ảnh hưởng bước đó; một hình dạng yêu cầu thất bại **3 lần liên tiếp** bị bỏ qua cho phần còn lại của tác vụ (`skippedShapes`, có ngày đầu tiên thất bại) và lượt hôm sau thử lại. Các yêu cầu được giãn cách ≥ 250 ms (`ANALYTICS_PACE_MS`). Hủy tác vụ: `POST /jobs/:id/cancel` dừng ở yêu cầu kế tiếp, số đã ghi được giữ. Một tác vụ mà dòng `analytic_jobs` không còn `running` (bị tiến trình khác đánh dấu `interrupted`/`cancelled`) cũng dừng ở yêu cầu kế tiếp và **không bao giờ** được kết thúc ghi đè thành `completed` (`UPDATE … WHERE status='running'`).

## 4. Trạng thái buổi sáng

Mỗi sáng, kiểm tra một trong hai chỗ:

- **Analytics → Tổng quan**: dòng *Đồng bộ hằng ngày* hiển thị `scheduledFor`, trạng thái (`completed` / `partial` / `failed` / `running` / `queued` / `not-run` / `interrupted` / `cancelled`), số ngày đã thêm và số ngày lệch (`days.addedCount` / `days.driftedCount`), lỗi đầu tiên, cờ *muộn* và số mốc thất bại liên tiếp.
- **Analytics → Dữ liệu & đồng bộ**: lịch, tác vụ gần nhất, lịch sử tác vụ, lịch độ phủ theo tháng, nhật ký thay đổi. Thẻ lịch (`schedules[].lastRun`) và dòng trạng thái trên Tổng quan (`overview.dailyRun`, `bootstrap.owners[].dailyRun`) dùng **cùng một** hàm `dailyRunStatus(ownerId, access, now)` nên luôn kể cùng một câu chuyện.

**Định nghĩa (một nguồn duy nhất, `analyticsService.dailyRunStatus`).**

- *Mốc hiện tại*: dòng `analytic_schedule_runs` mới nhất của owner (nối với tác vụ của nó). Khi lịch đang bật và mốc gần nhất theo giờ hiện tại chưa có dòng nào, mốc đó được coi là `not-run` — **chỉ khi** mốc đó mới hơn *mốc giới hạn* = thời điểm mới nhất trong (`analytic_meta['migration:schedule-v3'].at`, `analytic_schedules.updated_at`). Đổi giờ chạy hoặc nâng cấp v3 vì thế không bao giờ tạo ra mốc "bị bỏ lỡ" giả; mốc cũ hơn giới hạn chỉ được đọc từ dòng đã lưu.
- *Trạng thái*: theo tác vụ (`queued`, `running`, `completed`, `partial`, `failed`, `cancelled`, `interrupted`); không có tác vụ thì `failed` (tạo tác vụ thất bại) hoặc `not-run`.
- *Muộn* (`late`): tác vụ bắt đầu quá **15 phút** sau mốc, hoặc chưa có tác vụ 15 phút sau mốc (chỉ tính khi lịch đang bật). Một tác vụ phải chờ backfill 90 ngày phía trước hàng đợi vì vậy cũng là *muộn*.
- *Thất bại liên tiếp* (`consecutiveFailures`, `streakStart`): đi từ dòng mới nhất về trước, dừng ở lượt `completed`/`partial` đầu tiên (`failed`, `interrupted`, `cancelled` đều tính). Mốc hiện tại **không** được tính khi tác vụ còn `queued`/`running`, khi việc tạo tác vụ còn lần thử lại (`retry_at` trong tương lai) hoặc khi còn trong 15 phút ân hạn; mốc `not-run` được suy ra chỉ tính khi đã *muộn*.
- *Lỗi đầu tiên* (`firstError`): lỗi đầu tiên của tác vụ **sau khi lọc theo vai trò** (lỗi của bước doanh thu bị ẩn với vai trò không có quyền doanh thu, giống `GET /jobs/:id`); nếu chưa có tác vụ thì là lỗi tạo tác vụ của mốc.
- Thêm: `startedAt`, `finishedAt`, `counts`, `nextRunAt`, `enabled`, `jobId`, `enqueuedAt`.

Đọc nhanh:

| Trạng thái | Ý nghĩa | Việc cần làm |
| --- | --- | --- |
| `completed`, 0 ngày lệch | lượt đã chạy đủ | không |
| `completed` kèm ngày lệch | YouTube sửa số cũ | xem nhật ký; nếu muốn cập nhật, chạy Đồng bộ toàn bộ → Ghi đè cho các ngày đó |
| `partial` | một số hình dạng lỗi (thường Google 5xx) | mở tác vụ, xem bước lỗi; lượt hôm sau tự thử lại các ngày thiếu |
| `failed` | hết hạn mức / mất kết nối CMS / thiếu quyền | xem lý do; với CMS, kết nối lại (mục 6) |
| `not-run`, *muộn* | backend không chạy lúc 09:00 | kiểm tra tiến trình (mục 9); khi backend quay lại, mốc gần nhất được chạy bù |
| `queued` / `running`, *muộn* | tác vụ xếp sau một tác vụ dài khác | chờ; chuỗi thất bại không đổi cho tới khi tác vụ kết thúc |
| `interrupted` | backend khởi động lại giữa chừng và tác vụ không được xếp lại (quá 2 lần hoặc quá 24 giờ) | chạy *Đồng bộ hằng ngày ngay* |

**Cảnh báo email (tùy chọn).** Đặt `ANALYTICS_ALERT_EMAILS=a@x.com,b@y.com` (cần `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`); sau **2 mốc liên tiếp** thất bại hoặc không chạy (theo định nghĩa trên), backend gửi một email cho mỗi chuỗi thất bại (không lặp lại cho tới khi có lượt thành công). Dấu "đã gửi" chỉ được lưu **sau khi** SMTP nhận thư, nên gửi thất bại sẽ được thử lại ở lần kiểm tra sau (30 giây). Khi biến được đặt mà thiếu cấu hình SMTP, backend in cảnh báo lúc khởi động. Không đặt biến thì bỏ qua. Vì chuỗi thất bại đếm cả các mốc **trước** khi go-live (ví dụ các lượt `cmsNotConnected` tuần trước), hãy đặt biến này **sau lượt 09:00 thành công đầu tiên** (mục 8).

## 5. Cấu hình lịch

`PUT /api/analytics/schedules` (cần quyền đồng bộ; Read Only bị từ chối). Các trường và giới hạn:

```json
{
  "ownerId": "CONTENT_OWNER_ID",
  "enabled": true,
  "times": ["09:00"],
  "timezone": "Asia/Bangkok",
  "lagDays": 3,
  "lookbackDays": 7,
  "scopes": ["claimed"],
  "channelMode": "all",
  "channelIds": [],
  "includeBreakdowns": true,
  "includeSnapshots": true,
  "refreshProvisional": false,
  "settleDays": 7,
  "monetary": true
}
```

- `times`: 1–6 mốc `HH:mm` GMT+7, mặc định `["09:00"]`; bỏ trống khi PUT thì giữ mốc đã lưu. `lagDays` 3–7, `lookbackDays` 3–90, `settleDays` 3–30. `scopes` không trùng; `channelMode: "selected"` cần `channelIds` (≤ 200, trong danh sách kênh). `monetary` cần quyền doanh thu **và**, khi `enabled: true`, token OAuth của CMS phải có scope `yt-analytics-monetary.readonly` (nếu không → HTTP 400 `monetaryScopeMissing`: *Revenue cannot be scheduled: the CMS token has no revenue scope.*); lịch doanh thu đang tắt vẫn lưu được. Nếu scope bị thu hồi sau khi lưu, lượt 09:00 tự hạ xuống không doanh thu và ghi chú *Revenue was not requested: the CMS token has no revenue scope.* thay vì thất bại. `enabled: true` cần CMS đang kết nối. Lưu lịch chọn mốc tiếp theo trong tương lai, không chạy ngay.
- Lưu lại lịch **không đổi giờ chạy** giữ nguyên lần thử lại đang chờ của mốc hôm nay (`retry_at`, `last_scheduled_for`); đổi giờ chạy thì bắt đầu sạch. Khi mốc hôm nay thất bại vì người tạo lịch mất quyền (`schedulePermissionDenied`) và lần lưu này sửa được (người lưu đủ quyền), mốc đó được **đánh thức ngay** (`retry_at = now`, thêm đúng một lần thử) nên dữ liệu về trong ngày mà không cần bấm *Chạy đồng bộ ngay*.
- `GET /api/analytics/schedules` trả về các trường trên (camelCase) cùng `nextRunAt`, `lastRunAt`, `lastScheduledFor`, `lastJobId`, `lastError`, `lastErrorAt`, `retryAt`, `scheduleVersion` và `lastRun` (trạng thái buổi sáng của mục 4, đã lọc theo vai trò người gọi).
- Lịch phiên bản 2 (hai mốc 08:00/14:00) được nâng lên phiên bản 3 **một lần** khi backend mở database (`analytic_meta['migration:schedule-v3']`): mốc mặc định cũ thành `09:00`, mốc tùy chỉnh giữ nguyên, `scope` cũ thành `scopes`, `lookbackDays` giữ nguyên, `next_run_at` tính lại nếu lịch đang bật. Các lần khởi động sau giữ nguyên con trỏ.

Biến môi trường: `ANALYTICS_DB_PATH` (đường dẫn database Analytics), `ANALYTICS_MAX_REQUESTS_PER_JOB` (5000, nhận 1–1.000.000), `ANALYTICS_CHANNEL_BATCH` (200, nhận 1–500), `ANALYTICS_PACE_MS` (250, ≥ 0) — ba giá trị này được sync engine phân tích **một lần** (`effectiveLimits()`: giá trị ngoài khoảng hoặc không phải số nguyên → dùng mặc định) và `GET /bootstrap` dùng lại đúng giá trị đó, nên kế hoạch giao diện hiển thị và giới hạn engine áp dụng không bao giờ lệch nhau; `ANALYTICS_HISTORY_OVERWRITE_DAYS` (365, số ngày giữ dòng `overwrite` trong nhật ký); `ANALYTICS_ALERT_EMAILS`; `ANALYTICS_FORCE_WORKER=1` (chiếm khóa worker, mục 9); `ANALYTICS_RERUN_SNAPSHOT_MIGRATION=1` (chạy lại việc chuyển snapshot cũ thành facts); `ANALYTICS_SKIP_SNAPSHOT_MIGRATION=1` (không bao giờ chuyển snapshot cũ thành facts — đặt sau khi quay lui, mục 9).

Hàng đợi dùng lại một tác vụ đang chờ/đang chạy khi yêu cầu **giống hệt** sau khi bỏ `requestedBy`, `canMonetary` (cờ `monetary` đã nói rõ sẽ lấy gì) và phần ghi nhớ khôi phục: hai người thuộc hai vai trò bấm cùng một đồng bộ không doanh thu chỉ tạo một tác vụ. Khi gọi Google, backend làm mới token **một lần cho mỗi yêu cầu** ngay khi gặp 401, kể cả sau một lần thử lại vì lỗi 5xx tạm thời.

## 6. Kết nối CMS và hạn 7 ngày của OAuth

- Mọi yêu cầu dùng OAuth CMS của Content Owner (Settings → Network, `/networks`). Khi refresh token bị thu hồi (`invalid_grant`), backend đánh dấu CMS lỗi; tác vụ đang chạy thất bại với lý do `cmsNotConnected`, các mốc sau thất bại khi tạo tác vụ.
- **Hạn 7 ngày.** Nếu màn hình đồng ý OAuth trên Google Cloud ở trạng thái *Testing*, refresh token hết hạn sau đúng 7 ngày (sự cố 2026-10-16 → 2026-10-23). Cách xử lý lâu dài: chuyển màn hình đồng ý sang **In production** (publish) rồi ủy quyền lại một lần; nếu không, phải ủy quyền lại mỗi tuần.
- **Kết nối lại trong ngày.** Khi Content Owner kết nối lại, scheduler tự cho mốc hôm nay **thêm một lần** (`retry_at = now`) nếu mốc đó thất bại vì `cmsNotConnected` (kể cả khi đã hết 5 lần thử, hoặc tác vụ đã thất bại vì lý do này). Mỗi mốc chỉ được "đánh thức" một lần (`analytic_meta['rearm:<owner>:<slot>']`), nên dữ liệu về trong ngày mà không lặp vô hạn.
- Dữ liệu đã lưu luôn đọc được khi CMS mất kết nối; chỉ đồng bộ và truy vấn trực tiếp bị chặn (HTTP 409).

## 7. Hàng đợi, khôi phục sau khởi động lại, dọn dẹp

- `analytic_schedule_runs` khóa duy nhất `(owner_id, scheduled_for)`; việc ghi nhận mốc và tạo tác vụ nằm trong một giao dịch. Thất bại khi tạo tác vụ được thử lại sau 1, 5, 15, 30 phút (tối đa 5 lần). Sau thời gian ngừng dài, chỉ **mốc đã qua gần nhất** được chạy bù.
- Tác vụ được **nhận nguyên tử** (`UPDATE … WHERE status='queued'`): hai tiến trình không thể cùng chạy một tác vụ (nhưng xem mục 9: chỉ chạy một backend).
- Khi khởi động, backend lấy **khóa worker** (mục 9) rồi chạy: chuẩn hóa timestamp cũ (`YYYY-MM-DD HH:MM:SS` → ISO cho `analytic_snapshots`, `analytic_attempts`, `analytic_jobs`, `analytic_schedule_runs`, `analytic_schedules`, `analytic_owners`, `analytic_channels`, `analytic_videos`), chuyển snapshot `daily`/`monetaryDaily` cũ thành facts (một lần), nâng lịch lên v3, rồi **khôi phục**: tác vụ còn `queued`/`running` bị đánh dấu `interrupted`; tác vụ v2 (`daily`/`full`/`channelDetail`) không bị hủy được **xếp hàng lại** với `requestedBy: "recovery"` (an toàn nhờ độ phủ; ghi đè chạy lại cũng an toàn). Chuỗi khôi phục nhớ tác vụ gốc (`request.recovery = { originalCreatedAt, attempts }`): chỉ xếp lại khi tác vụ **gốc** chưa quá 24 giờ và chuỗi chưa bị gián đoạn quá **2 lần** — một tác vụ làm backend sập sẽ không lặp vô hạn (ghi chú *…was interrupted {n} times and was not queued again; start a new sync.*). Mốc 09:00 có tác vụ bị gián đoạn được **trỏ sang tác vụ thay thế** (`analytic_schedule_runs.job_id`), nên trạng thái buổi sáng đi theo tác vụ mới thay vì báo thất bại cả ngày. Các dòng cùng bị gián đoạn trong một lượt không bao giờ được dùng làm "tác vụ thay thế" của nhau. Tác vụ snapshot cũ không được xếp lại. Mọi lỗi ở bước khởi động được ghi log (`[analytics] worker startup failed …`) và thử lại ở lần kiểm tra sau; tiến trình không bao giờ chết vì bước này.
- Kết thúc mỗi tác vụ: xóa dòng drift quá 180 ngày và dòng `overwrite` quá 365 ngày (`ANALYTICS_HISTORY_OVERWRITE_DAYS`); tác vụ `daily` còn xóa tác vụ cũ hơn 180 ngày (giữ 30 tác vụ mới nhất mỗi owner) và chạy `PRAGMA wal_checkpoint(TRUNCATE)`. Mỗi tác vụ in một dòng log: `[analytics] job=<id> kind=<kind> owner=<ownerId> status=<status> inserted=… updated=… enriched=… drift=… requests=… ms=…`.

## 8. Quy trình go-live

Danh sách kiểm tra ngắn (chi tiết từng bước bên dưới):

- [ ] Sao lưu `analytics.sqlite` vào `backend/data/backups/` (lệnh ở mục 9).
- [ ] Kết nối lại CMS OAuth trong `/networks`.
- [ ] Publish ứng dụng OAuth trên Google Cloud (chế độ *Testing* thu hồi refresh token sau 7 ngày).
- [ ] Chạy backend dưới supervisor — **một tiến trình cho một database Analytics**.
- [ ] Backfill ban đầu: Đồng bộ toàn bộ → *Chỉ thêm số mới* cho 90 ngày gần nhất.
- [ ] Kiểm tra lượt 09:00 đầu tiên trong **Analytics → Dữ liệu & đồng bộ**.
- [ ] Chỉ sau lượt 09:00 `completed` đầu tiên mới đặt `ANALYTICS_ALERT_EMAILS`.

1. **Sao lưu trước** (mục 9: lệnh `db.backup()` vào `backend/data/backups/`), để có đường quay lui thật sự.
2. **Kết nối lại CMS OAuth** trong Settings → Network (`/networks`). Để hết tình trạng hết hạn 7 ngày: publish màn hình đồng ý OAuth trên Google Cloud (trạng thái *In production*) hoặc ủy quyền lại hằng tuần.
3. **Chạy backend dưới supervisor** ở production: `pm2 start src/server.js --name ans-backend` + `pm2 save` + `pm2 startup` (hoặc Windows Task Scheduler, tác vụ *At startup* chạy `node src/server.js` trong `backend/`). `npm run dev` (nodemon) khởi động lại mỗi lần lưu file và làm gián đoạn tác vụ; không dùng cho production. Chỉ **một** tiến trình được ghi vào mỗi `analytics.sqlite`: tắt `npm run dev` trỏ vào cùng database trước khi bật pm2 (khóa worker ở mục 9 chặn tiến trình thứ hai, nhưng đừng dựa vào nó).
4. **Backfill ban đầu** từ hộp thoại Đồng bộ toàn bộ: 90 ngày gần nhất, tất cả kênh, có phân tích theo chiều + báo cáo theo kỳ + doanh thu, chế độ *Chỉ thêm số mới*. Có thể chạy `dryRun` trước để xem số yêu cầu.
5. **Kiểm tra mốc 09:00 kế tiếp** trong **Analytics → Dữ liệu & đồng bộ** (thẻ lịch: *Lần chạy gần nhất* `completed`/`partial`, không có cờ *muộn*; lịch độ phủ có các ngày mới; nhật ký thay đổi có dòng drift nếu YouTube sửa số) và trên Tổng quan (dòng *Đồng bộ hằng ngày* màu xanh). Độ phủ `lastDay` thường là `ngày chạy − 4` (mục 2): 1–2 ngày cuối cửa sổ còn *chưa công bố* là bình thường. Chỉ **sau** lượt `completed` đầu tiên mới đặt `ANALYTICS_ALERT_EMAILS` (nếu không, email đầu tiên sẽ kể lại chuỗi `cmsNotConnected` của tuần trước). Lệnh kiểm tra nhanh (đổi đường dẫn DB nếu dùng `ANALYTICS_DB_PATH`):
   `sqlite3 backend/data/analytics.sqlite "SELECT owner_id,scheduled_for,status,attempts,job_id FROM analytic_schedule_runs ORDER BY scheduled_for DESC LIMIT 3;"`
   `sqlite3 backend/data/analytics.sqlite "SELECT id,kind,status,completed,total,finished_at FROM analytic_jobs ORDER BY created_at DESC LIMIT 5;"`
6. **Quay lui** (mục 9 bên dưới) nếu cần.

## 9. Quay lui, quy tắc một tiến trình, supervisor

**Sao lưu (làm trước go-live và trước mọi lần quay lui).** Lưu vào đường dẫn bền `backend/data/backups/` (không dùng thư mục tạm của phiên làm việc). Lệnh dùng API sao lưu trực tuyến của better-sqlite3 (`db.backup()`), chạy trong `backend/`, an toàn kể cả khi backend đang chạy (đổi đường dẫn nguồn nếu dùng `ANALYTICS_DB_PATH`):

```
node -e "const Database=require('better-sqlite3');const fs=require('fs');fs.mkdirSync('data/backups',{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-');const target='data/backups/analytics-'+stamp+'.sqlite';new Database('data/analytics.sqlite',{readonly:true}).backup(target).then(()=>console.log('backup ok: '+target))"
```

Bản sao lưu là một file `.sqlite` hoàn chỉnh (đã gồm nội dung `-wal`). Phục hồi toàn bộ: dừng backend, chép đè `data/analytics.sqlite` bằng bản sao lưu và xóa `analytics.sqlite-wal` / `analytics.sqlite-shm` đi kèm, rồi khởi động lại.

**Quay lui dữ liệu đã chuyển đổi từ snapshot** (chạy khi backend đã dừng; cùng một khối SQL với `analytics-warehouse.md` → "Snapshot migration"):

```sql
DELETE FROM analytic_daily_facts WHERE source='migration';
DELETE FROM analytic_day_coverage WHERE job_id IS NULL AND kind='facts';
DELETE FROM analytic_meta WHERE key='migration:snapshots-to-facts';
```

Khối SQL này **chỉ đặt lại việc chuyển đổi**, không phải quay lui vĩnh viễn: các snapshot `daily`/`monetaryDaily` cũ vẫn còn trong `analytic_snapshots`, nên lần khởi động tiếp theo `migrateSnapshotsToFacts` chạy lại và tạo lại đúng các dòng đó trong cùng giây. Để quay lui **giữ được**, làm thêm **một** trong hai việc trước khi khởi động lại: đặt `ANALYTICS_SKIP_SNAPSHOT_MIGRATION=1` trong môi trường của backend (và giữ biến này chừng nào còn muốn quay lui; backend trả `{ skipped:true, reason:'ANALYTICS_SKIP_SNAPSHOT_MIGRATION=1' }` và không ghi dòng meta nào), hoặc xóa các snapshot nguồn (`DELETE FROM analytic_snapshots WHERE report_id IN ('daily','monetaryDaily');` — chúng không còn được giao diện đọc). Chỉ xóa đúng khóa `migration:snapshots-to-facts`: khóa `migration:schedule-v3` là *mốc giới hạn* của trạng thái buổi sáng (mục 4), xóa nó sẽ làm mốc cũ đọc thành "bị bỏ lỡ".

Lịch v3 không cần quay lui (các cột mới có giá trị mặc định; backend cũ bỏ qua chúng). Nếu cần phục hồi toàn bộ, dùng bản sao lưu ở `backend/data/backups/` như trên.

**Một tiến trình cho một database.** Worker, scheduler và các migration giả định chỉ có **một** backend ghi vào `analytics.sqlite`. Quy tắc này được **khóa worker** bảo vệ: `analytic_meta['worker:lease'] = { pid, at }`, làm mới mỗi 30 giây, coi là hết hạn sau **90 giây**. Backend thứ hai mở cùng database (ví dụ `npm run dev` bên cạnh pm2) thấy khóa còn hạn của tiến trình khác thì ghi một dòng log (`another backend (pid …) holds the analytics worker lease…`), **không** chạy migration/khôi phục/scheduler và không chạy tác vụ (yêu cầu đồng bộ từ giao diện vẫn được xếp hàng, tiến trình giữ khóa sẽ chạy trong vòng 30 giây); nó thử lấy khóa lại mỗi 30 giây và tiếp quản khi khóa hết hạn (tiến trình cũ chết) hoặc được giải phóng (dừng bình thường). `ANALYTICS_FORCE_WORKER=1` chiếm khóa ngay. Dù vậy vẫn không nên cố ý chạy hai bản: token OAuth bị làm mới chéo giữa hai tiến trình.

**Supervisor.** Backend và máy chủ phải chạy liên tục để mốc 09:00 có hiệu lực; trình duyệt không cần mở. Khi máy ngủ hoặc tiến trình dừng, không có đồng bộ đúng giờ; khi backend trở lại, chỉ mốc đã qua gần nhất được chạy bù (và được xem là *muộn* trên dòng trạng thái). Dùng pm2 (`pm2 start src/server.js --name ans-backend`, `pm2 save`, `pm2 startup`) hoặc Windows Task Scheduler với tác vụ *At startup* và *Restart on failure*.

## 10. User-facing messages (B1)

Các chuỗi tiếng Anh dưới đây có thể xuất hiện trong phản hồi HTTP, trong `errors[]`/`notes[]`/`steps[]` của tác vụ hoặc trong lịch; người tích hợp chép chúng vào `analytics-api.md` → "User-facing messages" và từ điển `vi/analyticsServer.js` (các chuỗi có `{…}` là phần động, dịch bằng quy tắc regex).

Mới trong stage 2 (`analyticsService.js`):

- `kind must be daily, full, channelDetail or snapshot.`
- `startDate must be 2009-01-01 or later.`
- `endDate must not be after {day}, the last completed Pacific-time day.`
- `mode must be append or overwrite.`
- `Your role cannot overwrite stored numbers.`
- `scopes must list claimed, self or thirdParty without duplicates.`
- `channelMode must be all, selected or none.`
- `channelIds must be a list of YouTube channel IDs.`
- `At most 200 channels can be selected.`
- `Unknown channel IDs for this Content Owner: {ids}.` (có thể kết thúc bằng ` and {n} more.`)
- `Select at least one channel or track all channels.`
- `This sync needs about {n} requests; the limit is {limit}. Shorten the range or select fewer channels.` (HTTP 400, kèm `plan`)
- `Too many sync jobs are waiting for this Content Owner. Wait for the queued jobs to finish.` (HTTP 409, `tooManyJobs`)
- `Revenue was not requested: the user who started this run cannot access Analytics revenue.` (ghi chú tác vụ)
- `Your role cannot change the Analytics schedule.`
- `lagDays must be between 3 and 7.` · `lookbackDays must be between 3 and 90.` · `settleDays must be between 3 and 30.`
- `Server restarted before this sync finished. It was queued again as job {id}.`
- `Queued again after a restart interrupted job {id}.` (ghi chú tác vụ)

Mới trong lượt sửa sau review (`analyticsService.js`):

- `Revenue cannot be scheduled: the CMS token has no revenue scope.` (HTTP 400, `monetaryScopeMissing`)
- `Revenue was not requested: the CMS token has no revenue scope.` (ghi chú tác vụ `daily`)
- `Server restarted before this sync finished. It was interrupted {n} times and was not queued again; start a new sync.` (`errors[]`, `serverRestart`)
- Dòng log (không dịch): `[analytics] another backend (pid {pid}) holds the analytics worker lease; this process serves reads only until it expires (ANALYTICS_FORCE_WORKER=1 takes over)`, `[analytics] worker startup failed (will retry on the next tick): {message}`, `[analytics] worker lease unavailable (will retry on the next tick): {message}`, `[analytics] worker start failed: {message}`, `[analytics] ANALYTICS_ALERT_EMAILS is set but SMTP_HOST/SMTP_USER/SMTP_PASS are missing; daily-sync alert emails cannot be sent`, `[analytics] job={id} ended {status} but its row was no longer running; left untouched`

Mới trong lượt sửa sau review (`analyticsSyncEngine.js`, trong `result.notes[]` / `steps[].note`):

- `Revenue was skipped: the CMS token has no revenue scope.` (mục 3: 403 `insufficientPermissions` trên yêu cầu doanh thu)

Mới trong lượt sửa sau review (`analyticsReadService.js`, HTTP 400 của `GET /export`; đã có trong `analytics-api.md`):

- `Select one channel or none for this export.`
- `Unknown channel IDs: {ids}. Refresh the channel inventory or clear the channel filter.`

Mới trong stage 2 (`analyticsSyncEngine.js`, trong `steps[].note` / `errors[]` / `steps[].label`):

- `{n} channels listed, {added} added, {removed} removed, {restored} restored`
- `The channel listing failed; continuing with {n} stored channels`
- `The channel listing failed and no stored channels exist`
- `No channels to request` · `No published days to request`
- `No owner rows were returned for the range; YouTube has not published these days yet`
- `Google returned an invalid report table.` · `Google returned invalid report rows.` · `Report exceeds the interactive row limit.`
- `Unsupported job kind.` · `A valid instant is required.`
- Nhãn bước: `Channel inventory`, `Owner facts ({scope})`, `Channel facts`, `Breakdown by {dimension}`, `Range reports`, `Channel reports`

Giữ nguyên từ trước (vẫn có thể xuất hiện): `Content Owner is required.`, `Content Owner is not configured.`, `CMS OAuth is not connected for this Content Owner.`, `CMS credentials are missing.`, `Invalid Content Owner identifier.`, `Date range must contain between 1 and 366 days.`, `Invalid YouTube channel ID.`, `Your role cannot access Analytics revenue.`, `Your role cannot cancel an Analytics revenue sync.`, `Sync job not found.`, `Channel is not in this Content Owner's managed inventory. Refresh the channel inventory first.`, `Your role cannot change an existing revenue sync schedule.`, `Your role cannot schedule revenue syncs.`, `times must contain between 1 and 6 daily HH:mm times in GMT+7.`, `Daily schedule times must be unique.`, `Analytics schedules use Asia/Bangkok (GMT+7).`, `The schedule creator is missing or inactive. An authorized user must save the schedule again.`, `The schedule creator no longer has permission to sync Analytics.`, `The schedule creator no longer has permission to sync revenue.`, `The Analytics sync job could not be queued.`, `Server restarted before this sync finished. Start a new sync; complete snapshots were retained.`, `Cancelled`, `Channel pagination repeated a page token.`, `Channel inventory exceeds the interactive safety limit.`

Lý do lỗi (`error.reason`) mới: `tooManyRequests`, `tooManyJobs`, `cmsNotConnected` (chuẩn hóa từ `invalid_grant` / `missing_refresh_token` / `missingCredentials`), `quotaExceeded`, `serverRestart`, `invalidTable`, `invalidRows`, `interactiveRowLimit`.
