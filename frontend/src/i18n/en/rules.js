// English rules for the backend's dynamic Vietnamese messages (see ./serverVietnamese.js for the fixed ones).
// Same shape as vi/rules.js: anchored patterns, no g flag, `to` as a string with {n} groups or a function.
function count(value, one, many) {
  return Number(value) === 1 ? `${value} ${one}` : `${value} ${many}`;
}

// Tail of collaboratorSyncMessage(): optional ". CHÚ Ý: …" and ". bỏ qua …" sentences.
function syncTail(tail) {
  let rest = String(tail || "");
  const parts = [];
  const noRate = rest.match(/CHÚ Ý: (\d+) channel chưa khai rate sharing collaborator nên đang tính 0% — hãy cập nhật Channel Management rồi bấm Sync lại/);
  if (noRate) parts.push(`NOTE: ${count(noRate[1], "channel has", "channels have")} no collaborator sharing rate yet and count as 0% — update Channel Management, then press Sync again`);
  const skipped = rest.match(/bỏ qua (\d+) channel vì tổng revenue share vượt 100%/);
  if (skipped) parts.push(`${count(skipped[1], "channel", "channels")} skipped because the total revenue share exceeds 100%`);
  rest = rest.replace(/\.\s*CHÚ Ý: [^.]*?Sync lại/, "").replace(/\.\s*bỏ qua \d+ channel vì tổng revenue share vượt 100%/, "");
  if (rest.trim()) parts.push(rest.replace(/^\.\s*/, ""));
  return parts.length ? `. ${parts.join(". ")}` : "";
}

export default [
  {
    pattern: /^Đã đồng bộ (\d+) channel từ Channel Management: thêm (\d+), cập nhật rate (\d+)(.*)$/,
    to: (match) => `Synced ${count(match[1], "channel", "channels")} from Channel Management: ${match[2]} added, ${count(match[3], "rate", "rates")} updated${syncTail(match[4])}`
  },
  {
    pattern: /^Đã tạo group\. (.+)$/,
    to: (match, { tm }) => `Group created. ${tm(match[1])}`
  },
  {
    pattern: /^Đã thêm (\d+) channel vào group(?:, bỏ qua (\d+) channel đã có sẵn)?$/,
    to: (match) => `Added ${count(match[1], "channel", "channels")} to the group${match[2] ? `, skipped ${count(match[2], "channel", "channels")} already in it` : ""}`
  },
  {
    pattern: /^Không có dữ liệu channel cho từ tháng (\S+) đến tháng (\S+)$/,
    to: "No channel data from {1} to {2}"
  },
  {
    pattern: /^Không có dữ liệu channel cho tháng (\S+)$/,
    to: "No channel data for {1}"
  }
];
