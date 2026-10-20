// Vietnamese rendering of the messages the backend sends to the Content ID / Report pages
// (src/i18n/vi/server.js exact entries + src/i18n/vi/rules.js regex rules), as the pages show
// them through tm(). Run with: node --test tests/i18nServerMessages.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { translateMessage, VI_RULES } from "../src/i18n/index.js";
import server from "../src/i18n/vi/server.js";

const VIETNAMESE_LETTER = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
// Status / verb words of the claim pipeline that must never survive in the Vietnamese text.
const ENGLISH_STATUS_WORD = /\b(active|inactive|pending|potential|disputed|appealed|released|reinstated|confirmed|release|reinstate|confirm|unknown|already|cannot|failed|skipped|not sent)\b/i;

function assertVietnamese(message, expected) {
  const result = translateMessage(message, "vi");
  assert.notEqual(result, message, `not translated: ${message}`);
  assert.match(result, VIETNAMESE_LETTER, `not Vietnamese: ${message} -> ${result}`);
  assert.doesNotMatch(result, ENGLISH_STATUS_WORD, `English status word left in: ${message} -> ${result}`);
  if (expected !== undefined) assert.equal(result, expected);
  return result;
}

// Every message of the CLAIM_WRITES descriptors (claimManagerService.js): emptyError, pending, success, cannot(status).
const CLAIM_WRITES_MESSAGES = [
  "Select at least one claim to release.",
  "Release sent to Google but the answer was not recorded (the server may have restarted); re-check the claim.",
  "Claim released and confirmed inactive by Google.",
  "Claims in disputed status cannot be released through the API.",
  "Select at least one claim to reinstate.",
  "Reinstate sent to Google but the answer was not recorded (the server may have restarted); re-check the claim.",
  "Claim reinstated and confirmed active by Google.",
  "Only inactive (released) claims can be reinstated through the API; this claim is active.",
  "Select at least one claim to confirm.",
  "Confirm sent to Google but the answer was not recorded (the server may have restarted); re-check the claim.",
  "Claim confirmed: Google reports it active.",
  "Only potential claims (matches awaiting confirmation) can be confirmed through the API; this claim is pending."
];

// Lookup limits (LIMITS.*, MAX_RECHECK_ITEMS, MAX_NOTE_LENGTH, MAX_EXPORT_ROWS).
const LIMIT_MESSAGES = [
  "A lookup can include at most 20 CMS networks.",
  "A lookup can contain at most 50 unique videos.",
  "A lookup can contain at most 20 asset IDs.",
  "A lookup can contain at most 200 claim IDs.",
  "A release batch can contain at most 100 claims.",
  "A reinstate batch can contain at most 100 claims.",
  "A re-check can contain at most 100 claims.",
  "The note must be at most 500 characters.",
  "Export matches 25000 rows; narrow the filters (maximum 20,000)."
];

// 409 conflicts, tokens, scopes and labels.
const AUTH_AND_LABEL_MESSAGES = [
  "The operation was aborted.",
  "Claim is now disputed and cannot be released through the API (Google: The operation was aborted.).",
  "CMS authorization failed: invalid_grant: Token has been expired or revoked. Re-authorize this CMS in Settings > Network.",
  "CMS authorization failed: CMS token refresh failed. Re-authorize this CMS in Settings > Network.",
  "CMS token is missing. Please re-auth CMS.",
  "CMS refresh token is missing. Please re-auth CMS.",
  "Google's token service answered 503 while refreshing the CMS access token (Backend Error); try again.",
  "Google's token service could not be reached to refresh the CMS access token (Google Content ID request failed); try again.",
  "Google rejected this application's OAuth client while refreshing the CMS token (invalid_client: Invalid Credentials). An administrator must check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server; re-authorizing the CMS will not help.",
  "Music Network: the CMS authorization is missing the YouTube Partner scope. Re-authorize it in Settings > Network.",
  "The CMS authorization is missing the YouTube Partner scope. Re-authorize it in Settings > Network.",
  "The CMS authorization is missing the YouTube Partner scope.",
  "CMS network is not connected.",
  "CMS permission denied: The caller does not have permission",
  "Content ID API quota or rate limit reached for this project; wait for the reset or raise the quota in Google Cloud. (Quota exceeded.)",
  "Asset labels could not be verified for your account",
  "Asset is not in your allowed labels",
  "This claim is not assigned to your allowed labels.",
  "The claim's asset could not be read, so its labels could not be verified for your account: Backend Error",
  "Label already exists",
  "Label is used by products",
  "You can only update labels assigned to your account",
  "Unexpected server error (ref 1a2b3c4d)"
];

// Outcomes of a release / reinstate / confirm batch and of a re-check.
const OUTCOME_MESSAGES = [
  "A status change (release, reinstate or confirm) of this claim is still running on the server; its outcome will be recorded by that request. Re-check it in a minute.",
  "Invalid claim ID.",
  "This claim could not be found in the selected CMS.",
  "This claim is being changed by another request right now; re-check it in a minute.",
  "Claim was already inactive; nothing was sent to Google.",
  "Claim was already active: the earlier reinstate call whose answer was lost had been applied. Nothing was sent to Google.",
  "Claim was already inactive: the earlier release call whose answer was lost had been applied. Nothing was changed by this call.",
  "Google refused the release because the claim was already inactive; nothing was changed by this call.",
  "Google refused the confirm because the claim was already active: the earlier unanswered reinstate call had been applied. Nothing was changed by this call.",
  "Google did not answer the first attempt; the repeat was refused because the claim was already inactive, so this call had been applied.",
  "Google accepted the release call without reporting the claim status, and the claim could not be read back; re-check it before trying again.",
  "Google answered with status \"pending\" instead of inactive.",
  "Google did not answer the release call, but the claim reads back inactive.",
  "Google Content ID did not respond within 30 s (PATCH /youtube/partner/v1/claims/abc123, 2 attempts) The claim still reads back as active, so the release was not applied; retry it.",
  "Google Content ID did not respond within 60 s (PATCH /youtube/partner/v1/claims/abc123) The release may still have been applied; re-check the claim before trying again.",
  "Not sent: the claim could not be read before the release (Google Content ID did not respond within 30 s (GET /youtube/partner/v1/claims, 2 attempts)). Retry.",
  "Not sent: the run was cancelled (the connection closed) before this claim was reached.",
  "Not sent: Google answered the earlier claims of this batch too slowly and the time budget ran out before this claim was reached. Retry it.",
  "Not sent: Backend Error",
  "Confirmed inactive by a later release attempt: the earlier unanswered release call had been applied.",
  "Confirmed inactive on re-check after an unanswered release call.",
  "Confirmed active; the earlier confirm was recorded.",
  "Claim was not found in this CMS.",
  "Select at least one claim to re-check."
];

// Delivery job / controller errors and log lines.
const DELIVERY_MESSAGES = [
  "Delivery is already running for this product",
  "Delivery failed: CMS token is missing. Please re-auth CMS.",
  "Delivery job failed: unknown error",
  "Delivery was interrupted by a server restart; retry to resume the remaining steps",
  "Duplicate check failed: Google Content ID could not be reached (DNS lookup failed)",
  "Google did not return a reference ID",
  "Google returned a reference for a different asset; local audio has been retained",
  "Reference REF123 is not ready for delivery (unknown status)",
  "Reference REF123 uploaded (activating)",
  "Reference REF123 is still being deactivated by Google; try again in a few minutes",
  "Delivered 8 of 10 track(s), 8 reference(s) uploaded, 1 duplicate, 1 failed",
  "Started delivery of 3 track(s)",
  "Retry failed at insert: The operation was aborted.",
  "Track finished (error)",
  "This track is being delivered right now; wait for it to finish",
  "This track has no asset ID yet. Deliver the track first.",
  "A reference is already active for this asset",
  "The uploaded audio file has expired or was removed. Select the file again.",
  "File is larger than the allowed 16384 MB",
  "\"clip.mp4\" is 12.3 s long; Content ID references must be at least 60 seconds. The file was not stored.",
  "ISRC VNA0A2400001 already belongs to product \"Album X\" (#12)",
  "Title must be 255 bytes or shorter",
  "Takedown: 2 of 3 track(s), 2 reference(s) deactivated, 5 claim(s) released - duplicate upload",
  "Reference REF123: The operation was aborted.",
  "Claim abc123: Backend Error",
  "Added 3 channel(s), 1 skipped, 0 error(s)",
  "Synced channel info for 12 channel(s). 2 channel(s) not found.",
  "No connected CMS network found. Please authorize CMS in Settings > Network first."
];

test("every CLAIM_WRITES message is Vietnamese without English status words", () => {
  CLAIM_WRITES_MESSAGES.forEach((message) => assertVietnamese(message));
  assert.equal(translateMessage("Claims in inactive status cannot be released through the API.", "vi"), "Claim ở trạng thái đã gỡ không thể gỡ qua API.");
  assert.equal(translateMessage("Claims in disputed status cannot be released through the API", "vi"), "Claim ở trạng thái tranh chấp không thể gỡ qua API");
  assert.equal(translateMessage("Claims in inactive status cannot be released", "vi"), "Claim ở trạng thái đã gỡ không thể gỡ");
  assert.equal(
    translateMessage("Only inactive (released) claims can be reinstated through the API; this claim is manual_review", "vi"),
    "Chỉ claim đã gỡ mới có thể khôi phục qua API; claim này đang ở trạng thái chờ xét duyệt"
  );
  assert.equal(translateMessage("Claim released and confirmed inactive by Google.", "vi"), "Đã gỡ claim; Google xác nhận claim không còn hoạt động.");
});

test("lookup and batch limits keep their numbers", () => {
  LIMIT_MESSAGES.forEach((message) => assertVietnamese(message));
  assert.equal(translateMessage("A lookup can contain at most 20 asset IDs.", "vi"), "Mỗi lần tra cứu tối đa 20 asset ID.");
  assert.equal(translateMessage("A release batch can contain at most 100 claims.", "vi"), "Mỗi lô gỡ claim tối đa 100 claim.");
  assert.equal(translateMessage("Export matches 25000 rows; narrow the filters (maximum 20,000).", "vi"), "Xuất file khớp 25000 dòng; thu hẹp bộ lọc (tối đa 20,000).");
});

test("409 / token / scope / label messages are Vietnamese and translate the quoted Google text", () => {
  AUTH_AND_LABEL_MESSAGES.forEach((message) => assertVietnamese(message));
  assert.equal(
    translateMessage("CMS authorization failed: invalid_grant: Token has been expired or revoked. Re-authorize this CMS in Settings > Network.", "vi"),
    "Ủy quyền CMS thất bại: invalid_grant: Token đã hết hạn hoặc bị thu hồi. Ủy quyền lại CMS này trong Cài đặt > Network."
  );
  assert.equal(
    translateMessage("Claim is now disputed and cannot be released through the API (Google: The operation was aborted.).", "vi"),
    "Claim hiện ở trạng thái tranh chấp và không thể gỡ qua API (Google: Thao tác đã bị hủy bỏ.)."
  );
  assert.equal(translateMessage("CMS permission denied: The caller does not have permission", "vi"), "CMS từ chối quyền truy cập: Tài khoản gọi API không có quyền thực hiện");
  assert.equal(translateMessage("Unexpected server error (ref 1a2b3c4d)", "vi"), "Lỗi server không mong đợi (mã tham chiếu 1a2b3c4d)");
});

test("release / reinstate / confirm outcomes translate the embedded status and verb words", () => {
  OUTCOME_MESSAGES.forEach((message) => assertVietnamese(message));
  assert.equal(
    translateMessage("Google refused the release because the claim was already inactive; nothing was changed by this call.", "vi"),
    "Google từ chối lệnh gỡ claim vì claim đã ở trạng thái đã gỡ; lệnh này không thay đổi gì."
  );
  assert.equal(
    translateMessage("Claim was already active: the earlier reinstate call whose answer was lost had been applied. Nothing was sent to Google.", "vi"),
    "Claim đã ở trạng thái hoạt động: lệnh khôi phục trước đó bị mất phản hồi nhưng đã được áp dụng. Không gửi gì tới Google."
  );
  assert.equal(
    translateMessage("Confirmed inactive by a later release attempt: the earlier unanswered release call had been applied.", "vi"),
    "Xác nhận trạng thái đã gỡ nhờ lệnh gỡ claim sau đó: lệnh gỡ claim trước không nhận được phản hồi nhưng đã được áp dụng."
  );
  assert.equal(
    translateMessage("Google Content ID did not respond within 60 s (PATCH /youtube/partner/v1/claims/abc123) The release may still have been applied; re-check the claim before trying again.", "vi"),
    "Google Content ID không phản hồi trong 60 giây (PATCH /youtube/partner/v1/claims/abc123) Lệnh gỡ claim có thể vẫn đã được áp dụng; kiểm tra lại claim trước khi thử tiếp."
  );
  assert.equal(
    translateMessage("Not sent: the claim could not be read before the release (Google Content ID did not respond within 30 s (GET /youtube/partner/v1/claims, 2 attempts)). Retry.", "vi"),
    "Chưa gửi: không đọc được claim trước khi gỡ claim (Google Content ID không phản hồi trong 30 giây (GET /youtube/partner/v1/claims, 2 lần thử)). Thử lại."
  );
  assert.equal(translateMessage("Google answered with status \"pending\" instead of inactive.", "vi"), "Google trả về trạng thái \"đang chờ\" thay vì đã gỡ.");
});

test("delivery job errors and log lines are Vietnamese", () => {
  DELIVERY_MESSAGES.forEach((message) => assertVietnamese(message));
  assert.equal(translateMessage("Reference REF123 is not ready for delivery (unknown status)", "vi"), "Reference REF123 chưa sẵn sàng để phân phối (trạng thái chưa rõ)");
  assert.equal(
    translateMessage("Delivered 8 of 10 track(s), 8 reference(s) uploaded, 1 duplicate, 1 failed", "vi"),
    "Đã phân phối 8/10 track, 8 reference đã tải lên, 1 trùng, 1 thất bại"
  );
  assert.equal(translateMessage("Delivered 10 of 10 track(s), 10 reference(s) uploaded", "vi"), "Đã phân phối 10/10 track, 10 reference đã tải lên");
  assert.equal(
    translateMessage("\"clip.mp4\" is 12.3 s long; Content ID references must be at least 60 seconds. The file was not stored.", "vi"),
    "\"clip.mp4\" chỉ dài 12.3 giây; reference Content ID phải dài ít nhất 60 giây. File chưa được lưu."
  );
  assert.equal(translateMessage("Retry failed at insert: The operation was aborted.", "vi"), "Thử lại thất bại ở bước tạo asset: Thao tác đã bị hủy bỏ.");
  assert.equal(translateMessage("Reference REF123: The operation was aborted.", "vi"), "Reference REF123: Thao tác đã bị hủy bỏ.");
  assert.equal(translateMessage("GET /youtube/partner/v1/assets: completed", "vi"), "GET /youtube/partner/v1/assets: hoàn tất");
  assert.equal(
    translateMessage("PATCH /youtube/partner/v1/claims/abc123: Google Content ID did not respond within 30 s", "vi"),
    "PATCH /youtube/partner/v1/claims/abc123: Google Content ID không phản hồi trong 30 giây"
  );
  assert.equal(translateMessage("3 errors: Backend Error; Reference R1: The operation was aborted.; Could not list claims: Invalid Value", "vi"),
    "3 lỗi: Lỗi phía Google (Backend Error); Reference R1: Thao tác đã bị hủy bỏ.; Không liệt kê được claim: Giá trị không hợp lệ");
});

test("policy summaries translate the action words and keep the territory codes", () => {
  assert.equal(translateMessage("Monetize (WW)", "vi"), "Kiếm tiền (toàn cầu)");
  assert.equal(translateMessage("Monetize (WW) · Block (exclude US, CA) · review", "vi"), "Kiếm tiền (toàn cầu) · Chặn (trừ US, CA) · cần xét duyệt");
  assert.equal(translateMessage("Track (VN, TH)", "vi"), "Theo dõi (VN, TH)");
});

test("English and unknown texts pass through unchanged", () => {
  const message = "Claims in inactive status cannot be released through the API.";
  assert.equal(translateMessage(message, "en"), message);
  assert.equal(translateMessage("Something Google said", "vi"), "Something Google said");
  assert.equal(translateMessage("Claim confirmed: Google reports it active.", "en"), "Claim confirmed: Google reports it active.");
  // A word the dictionary does not know keeps its spelling inside a rule.
  assert.equal(translateMessage("Claim was already routed; nothing was sent to Google.", "vi"), "Claim đã ở trạng thái routed; không gửi gì tới Google.");
});

test("every rule is anchored, has no g flag and renders a non-empty string", () => {
  assert.ok(VI_RULES.length >= 90);
  VI_RULES.forEach((rule) => {
    assert.ok(rule.pattern instanceof RegExp, `pattern missing: ${String(rule.pattern)}`);
    assert.equal(rule.pattern.global, false, `g flag on ${rule.pattern}`);
    assert.ok(rule.pattern.source.startsWith("^") && rule.pattern.source.endsWith("$"), `not anchored: ${rule.pattern}`);
    assert.ok(typeof rule.to === "string" || typeof rule.to === "function", `bad "to" on ${rule.pattern}`);
  });
});

// Vietnamese texts made only of the team's English loanwords (no diacritic to detect).
const LOANWORD_ONLY_VALUES = new Set(["file audio reference"]);

test("every exact entry is a non-empty Vietnamese (or identity) string", () => {
  const entries = Object.entries(server);
  assert.ok(entries.length >= 200);
  entries.forEach(([key, value]) => {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim().length > 0, `empty: ${key}`);
    assert.ok(VIETNAMESE_LETTER.test(value) || value === key || LOANWORD_ONLY_VALUES.has(value), `not Vietnamese: ${key} -> ${value}`);
  });
});
