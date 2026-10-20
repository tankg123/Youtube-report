import test from "node:test";
import assert from "node:assert/strict";
import {
  interpolate,
  normalizeLanguage,
  placeholdersOf,
  registerMessageRules,
  registerTranslations,
  setLanguage,
  subscribe,
  translate,
  translateMessage,
  getLanguage
} from "../src/i18n/core.js";
import { formatDate, formatDateTime, regionName, toDate } from "../src/i18n/format.js";
import { t, tm, hasTranslation } from "../src/i18n/index.js";

registerTranslations("vi", {
  "Release selected ({count})": "Gỡ claim đã chọn ({count})",
  "Hello {name}, you have {count} claims": "Chào {name}, bạn có {count} claim",
  "Claim released and confirmed inactive by Google.": "Đã gỡ claim; Google xác nhận claim không còn hoạt động.",
  "Plain label": "Nhãn thường",
  active: "đang hoạt động",
  inactive: "đã gỡ"
});
registerMessageRules("vi", [
  { pattern: /^Claims in (\S+) status cannot be released through the API\.$/, to: (match, { t: tr }) => `Claim ở trạng thái ${tr(match[1])} không thể gỡ qua API.` },
  { pattern: /^A lookup can contain at most (\d+) asset IDs\.$/, to: "Mỗi lần tra cứu tối đa {1} asset ID." }
]);

test("normalizeLanguage accepts vi / vn / vi-VN and defaults to en", () => {
  assert.equal(normalizeLanguage("vi"), "vi");
  assert.equal(normalizeLanguage("VN"), "vi");
  assert.equal(normalizeLanguage("vi-VN"), "vi");
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage(undefined), "en");
  assert.equal(normalizeLanguage("fr"), "en");
});

test("interpolate fills {placeholders}, keeps unknown ones and returns parts for element values", () => {
  assert.equal(interpolate("{count} of {total}", { count: 3, total: 10 }), "3 of 10");
  assert.equal(interpolate("{count} of {total}", { count: 0 }), "0 of {total}");
  assert.equal(interpolate("no params"), "no params");
  const element = { type: "strong" };
  assert.deepEqual(interpolate("Select {action} to go on", { action: element }), ["Select ", element, " to go on"]);
  assert.deepEqual(placeholdersOf("{a} and {b} and {a}"), ["a", "b", "a"]);
});

test("translate is the identity in English and looks the key up in Vietnamese", () => {
  assert.equal(translate("Plain label", undefined, "en"), "Plain label");
  assert.equal(translate("Plain label", undefined, "vi"), "Nhãn thường");
  assert.equal(translate("Unknown copy", undefined, "vi"), "Unknown copy");
  assert.equal(translate("Release selected ({count})", { count: 4 }, "vi"), "Gỡ claim đã chọn (4)");
  assert.equal(translate("Release selected ({count})", { count: 4 }, "en"), "Release selected (4)");
  assert.equal(translate("Hello {name}, you have {count} claims", { name: "An", count: 2 }, "vi"), "Chào An, bạn có 2 claim");
});

test("translate keeps the legacy t(key, fallback) form and the legacy short keys", () => {
  assert.equal(translate("missingKey", "Fallback text", "en"), "Fallback text");
  assert.equal(translate("missingKey", "Fallback text", "vi"), "Fallback text");
  assert.equal(translate("report", undefined, "en"), "Report");
  assert.equal(translate("report", undefined, "vi"), "Báo cáo");
  assert.equal(hasTranslation("report", "vi"), true);
});

test("a dictionary key is an English text and never falls back to a legacy short key of the same spelling", () => {
  // "active" is a lowercase status word of the server dictionary; a legacy short key "active" would read "Active".
  registerTranslations("vi", { "lowercase noun": "danh từ thường" });
  assert.equal(translate("lowercase noun", undefined, "en"), "lowercase noun");
  assert.equal(translate("lowercase noun", undefined, "vi"), "danh từ thường");
  // Legacy short keys still resolve for the pages that use them.
  assert.equal(translate("save", undefined, "en"), "Save");
  assert.equal(translate("save", undefined, "vi"), "Lưu");
  assert.equal(translate("not a key", undefined, "vi"), "not a key");
});

test("translateMessage: English passes through, Vietnamese uses exact entries then rules", () => {
  const message = "Claim released and confirmed inactive by Google.";
  assert.equal(translateMessage(message, "en"), message);
  assert.equal(translateMessage(message, "vi"), "Đã gỡ claim; Google xác nhận claim không còn hoạt động.");
  assert.equal(translateMessage(`  ${message}  `, "vi"), "Đã gỡ claim; Google xác nhận claim không còn hoạt động.");
  assert.equal(translateMessage("Claims in inactive status cannot be released through the API.", "vi"), "Claim ở trạng thái đã gỡ không thể gỡ qua API.");
  assert.equal(translateMessage("A lookup can contain at most 20 asset IDs.", "vi"), "Mỗi lần tra cứu tối đa 20 asset ID.");
  assert.equal(translateMessage("Something Google said", "vi"), "Something Google said");
  assert.equal(translateMessage("", "vi"), "");
  assert.equal(translateMessage(null, "vi"), null);
  assert.equal(translateMessage(42, "vi"), 42);
});

test("the current language drives t() / tm() of plain modules and notifies subscribers", () => {
  const seen = [];
  const unsubscribe = subscribe((language) => seen.push(language));
  try {
    assert.equal(setLanguage("vi"), "vi");
    assert.equal(getLanguage(), "vi");
    assert.equal(t("Plain label"), "Nhãn thường");
    assert.equal(tm("Claim released and confirmed inactive by Google."), "Đã gỡ claim; Google xác nhận claim không còn hoạt động.");
    assert.equal(setLanguage("en"), "en");
    assert.equal(t("Plain label"), "Plain label");
    assert.equal(setLanguage("en"), "en");
  } finally {
    unsubscribe();
    setLanguage("en");
  }
  assert.deepEqual(seen, ["vi", "en"]);
});

test("dates follow the language and SQLite / day-only values parse safely", () => {
  assert.equal(toDate(""), null);
  assert.equal(toDate("not a date"), null);
  const day = toDate("2026-10-17");
  assert.deepEqual([day.getFullYear(), day.getMonth(), day.getDate()], [2026, 9, 17]);
  assert.equal(formatDate("2026-10-17", "vi"), "17/10/2026");
  assert.equal(formatDate("2026-10-17", "en"), "10/17/2026");
  const stamp = toDate("2026-10-17 07:05:00");
  assert.equal(stamp.toISOString(), "2026-10-17T07:05:00.000Z");
  assert.match(formatDateTime(stamp, "vi"), /\d{2}:\d{2}/);
  assert.match(formatDateTime(stamp, "en"), /\d{2}:\d{2}/);
  assert.equal(formatDate(null, "vi"), "");
});

test("regionName gives the country name in the UI language", () => {
  assert.equal(regionName("VN", "vi"), "Việt Nam");
  assert.equal(regionName("VN", "en"), "Vietnam");
  assert.equal(regionName("", "vi", "Nowhere"), "Nowhere");
  // "1" is not a valid region subtag: Intl throws and the English fallback is used.
  assert.equal(regionName("1", "vi", "Unknown region"), "Unknown region");
});
