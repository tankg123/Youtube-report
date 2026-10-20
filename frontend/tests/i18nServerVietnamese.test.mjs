// The backend still answers a few report / group / channel / auth messages in Vietnamese: in English mode
// tm() renders them in English, in Vietnamese they pass through untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { EN_SERVER, translateMessage } from "../src/i18n/index.js";

const VIETNAMESE = /[À-ỹ]/;

test("every Vietnamese server message has a non-empty English text without Vietnamese letters", () => {
  const problems = [];
  for (const [key, value] of Object.entries(EN_SERVER)) {
    if (typeof value !== "string" || !value.trim()) problems.push(`${key}: empty`);
    else if (VIETNAMESE.test(value)) problems.push(`${key}: English text still has Vietnamese letters`);
    if (!VIETNAMESE.test(key)) problems.push(`${key}: key is not a Vietnamese message`);
  }
  assert.deepEqual(problems, []);
});

test("fixed Vietnamese messages become English in English mode and stay Vietnamese in Vietnamese mode", () => {
  assert.equal(translateMessage("Lỗi import report", "en"), "Could not import the report");
  assert.equal(translateMessage("Lỗi import report", "vi"), "Lỗi import report");
  assert.equal(translateMessage("Không tìm thấy channel trên YouTube", "en"), "Channel not found on YouTube");
  assert.equal(translateMessage("Bạn không có quyền thực hiện hành động này", "en"), "You do not have permission to perform this action");
  assert.equal(translateMessage("  Đã xóa group  ", "en"), "Group deleted");
  // English messages are left alone in English mode.
  assert.equal(translateMessage("Claim released and confirmed inactive by Google.", "en"), "Claim released and confirmed inactive by Google.");
});

test("dynamic Vietnamese messages are translated by the English rules", () => {
  assert.equal(translateMessage("Đã thêm 3 channel vào group", "en"), "Added 3 channels to the group");
  assert.equal(translateMessage("Đã thêm 1 channel vào group, bỏ qua 2 channel đã có sẵn", "en"), "Added 1 channel to the group, skipped 2 channels already in it");
  assert.equal(translateMessage("Không có dữ liệu channel cho tháng 2026-09", "en"), "No channel data for 2026-09");
  assert.equal(translateMessage("Không có dữ liệu channel cho từ tháng 2026-07 đến tháng 2026-09", "en"), "No channel data from 2026-07 to 2026-09");
  assert.equal(
    translateMessage("Đã đồng bộ 12 channel từ Channel Management: thêm 2, cập nhật rate 3", "en"),
    "Synced 12 channels from Channel Management: 2 added, 3 rates updated"
  );
  assert.equal(
    translateMessage("Đã đồng bộ 12 channel từ Channel Management: thêm 2, cập nhật rate 1. CHÚ Ý: 1 channel chưa khai rate sharing collaborator nên đang tính 0% — hãy cập nhật Channel Management rồi bấm Sync lại. bỏ qua 2 channel vì tổng revenue share vượt 100%", "en"),
    "Synced 12 channels from Channel Management: 2 added, 1 rate updated. NOTE: 1 channel has no collaborator sharing rate yet and count as 0% — update Channel Management, then press Sync again. 2 channels skipped because the total revenue share exceeds 100%"
  );
  assert.equal(
    translateMessage("Đã tạo group. Đã đồng bộ 4 channel từ Channel Management: thêm 4, cập nhật rate 0", "en"),
    "Group created. Synced 4 channels from Channel Management: 4 added, 0 rates updated"
  );
  // Vietnamese mode: untouched.
  assert.equal(translateMessage("Đã thêm 3 channel vào group", "vi"), "Đã thêm 3 channel vào group");
});
