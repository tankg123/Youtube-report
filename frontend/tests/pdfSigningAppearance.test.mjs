// The visible stamp of a certificate signature (signing/appearanceLayout.js): which lines it shows, how they
// wrap, where the picture and the lines go. The measurer of the tests gives every character half its font
// size, so the numbers can be checked by hand.
import test from "node:test";
import assert from "node:assert/strict";
import {
  APPEARANCE_LAYOUTS, APPEARANCE_LAYOUT_LABELS, DEFAULT_SHOW, DETAIL_CHOICES, DETAIL_KEYS, DETAIL_LABELS, FONT_SIZE_LIMITS, LINE_HEIGHT, REASON_PRESETS, appearanceIsEmpty, detailLines, layoutAppearance, wrapText
} from "../src/pages/pdfEditor/signing/appearanceLayout.js";

const measure = (text, size) => Array.from(text).length * size * 0.5;
const VALUES = { name: "Nguyễn Văn An", date: "20/11/2026 14:03:05 GMT+7", reason: "Tôi phê duyệt tài liệu này", location: "Hà Nội", organisation: "ANS Network" };
const ALL = { name: true, date: true, reason: true, location: true, organisation: true, labels: true };
const vi = { "Signed by:": "Ký bởi:", "Date:": "Ngày ký:", "Reason:": "Lý do:", "Location:": "Địa điểm:", "Organisation:": "Tổ chức:" };
const inside = (box, area) => box.x >= area.x - 1e-6 && box.y >= area.y - 1e-6 && box.x + box.w <= area.x + area.w + 1e-6 && box.y + box.h <= area.y + area.h + 1e-6;

test("appearance: the lines follow the check boxes, in a fixed order, in the language of the interface", () => {
  assert.deepEqual(detailLines({ show: DEFAULT_SHOW, values: VALUES }).map((line) => line.text), ["Signed by: Nguyễn Văn An", "Date: 20/11/2026 14:03:05 GMT+7"]);
  const all = detailLines({ show: ALL, values: VALUES, t: (text) => vi[text] || text });
  assert.deepEqual(all.map((line) => line.key), ["name", "date", "reason", "location", "organisation"]);
  assert.deepEqual(all.map((line) => line.text), ["Ký bởi: Nguyễn Văn An", "Ngày ký: 20/11/2026 14:03:05 GMT+7", "Lý do: Tôi phê duyệt tài liệu này", "Địa điểm: Hà Nội", "Tổ chức: ANS Network"]);
  // labels off: the values alone
  assert.deepEqual(detailLines({ show: { ...ALL, labels: false }, values: VALUES }).map((line) => line.text), Object.values(VALUES));
  // a detail without a value is left out, and white space is tidied
  const some = detailLines({ show: ALL, values: { name: "  An \n Nguyễn ", date: "", reason: "   ", location: undefined } });
  assert.deepEqual(some.map((line) => line.text), ["Signed by: An Nguyễn"]);
  assert.deepEqual(detailLines({ show: { labels: true }, values: VALUES }), []);
  // every detail has its label, every layout its name, and there are three reasons to choose from
  for (const key of DETAIL_KEYS) assert.ok(DETAIL_LABELS[key].endsWith(":") && DETAIL_CHOICES[key]);
  for (const layout of APPEARANCE_LAYOUTS) assert.ok(APPEARANCE_LAYOUT_LABELS[layout]);
  assert.equal(REASON_PRESETS.length, 3);
});

test("appearance: wrapping at spaces, and inside a word only when the word alone is too wide", () => {
  const width = (text) => measure(text, 10);
  assert.deepEqual(wrapText("Signed by: Nguyễn Văn An", 60, width), ["Signed by:", "Nguyễn Văn", "An"]);
  assert.deepEqual(wrapText("short", 100, width), ["short"]);
  assert.deepEqual(wrapText("", 100, width), []);
  assert.deepEqual(wrapText("an@very-long-address.example.test", 50, width), ["an@very-lo", "ng-address", ".example.t", "est"]);
  // Vietnamese letters with marks are single characters and are never torn apart
  assert.deepEqual(wrapText("Nguyễn", 15, width), ["Ngu", "yễn"]);
  for (const row of wrapText("Tôi phê duyệt tài liệu này và đồng ý với toàn bộ nội dung", 70, width)) assert.ok(width(row) <= 70, row);
});

test("appearance: image and details side by side in a wide stamp, stacked in a narrow one", () => {
  const lines = detailLines({ show: DEFAULT_SHOW, values: VALUES });
  const wide = layoutAppearance({ width: 180, height: 60, layout: "imageAndDetails", image: { width: 400, height: 100 }, lines, measure });
  assert.equal(wide.width, 180);
  assert.equal(wide.height, 60);
  const whole = { x: 0, y: 0, w: 180, h: 60 };
  assert.ok(inside(wide.image, whole));
  // the picture keeps its proportions and sits left of the text
  assert.ok(Math.abs(wide.image.w / wide.image.h - 4) < 1e-9);
  assert.ok(wide.text.rows.every((row) => row.x >= wide.image.x + wide.image.w), "text right of the picture");
  assert.ok(wide.text.rows.every((row) => row.x + row.width <= 180 && row.y <= 60 && row.y - wide.text.size >= 0), "every row is inside the stamp");
  assert.equal(wide.text.clipped, false);
  assert.ok(wide.text.size <= FONT_SIZE_LIMITS.max && wide.text.size >= FONT_SIZE_LIMITS.min);
  // rows are one line pitch apart, top to bottom
  const ys = wide.text.rows.map((row) => row.y);
  for (let index = 1; index < ys.length; index += 1) assert.ok(Math.abs(ys[index] - ys[index - 1] - wide.text.size * LINE_HEIGHT) < 1e-6);

  const narrow = layoutAppearance({ width: 90, height: 120, layout: "imageAndDetails", image: { width: 400, height: 100 }, lines, measure });
  assert.ok(narrow.text.rows.every((row) => row.y - narrow.text.size >= narrow.image.y + narrow.image.h - 1e-6), "text under the picture");
  assert.ok(inside(narrow.image, { x: 0, y: 0, w: 90, h: 120 }));
});

test("appearance: the largest font size at which every line fits; fewer rows rather than text outside the stamp", () => {
  const few = layoutAppearance({ width: 300, height: 100, layout: "detailsOnly", lines: [{ text: "Signed by: An" }], measure });
  assert.equal(few.text.size, FONT_SIZE_LIMITS.max);
  assert.equal(few.image, null);
  // vertically centred: one row of 11 pt in 100 pt
  assert.ok(few.text.rows[0].y > 40 && few.text.rows[0].y < 60);

  const many = layoutAppearance({ width: 180, height: 60, layout: "detailsOnly", lines: detailLines({ show: ALL, values: VALUES }), measure });
  assert.ok(many.text.size < FONT_SIZE_LIMITS.max && many.text.size >= FONT_SIZE_LIMITS.min);
  assert.equal(many.text.clipped, false);
  assert.ok(many.text.rows.length * many.text.size * LINE_HEIGHT <= 60);
  // one step larger would not fit
  const larger = many.text.size + FONT_SIZE_LIMITS.step;
  const rows = detailLines({ show: ALL, values: VALUES }).flatMap((line) => wrapText(line.text, 180 - 2 * 3.6, (text) => measure(text, larger)));
  assert.ok(rows.length * larger * LINE_HEIGHT > 60 - 2 * 3.6, "the chosen size is the largest that fits");

  // the smallest rectangle (72 x 36 pt) with every detail: rows that do not fit are left out, none is drawn outside
  const wordy = { ...VALUES, reason: "Tôi phê duyệt tài liệu này và xác nhận rằng toàn bộ nội dung của hợp đồng dịch vụ số 12/2026 là chính xác, đầy đủ và đã được hai bên thống nhất" };
  const tiny = layoutAppearance({ width: 72, height: 36, layout: "detailsOnly", lines: detailLines({ show: ALL, values: wordy }), measure });
  assert.equal(tiny.text.size, FONT_SIZE_LIMITS.min);
  assert.equal(tiny.text.clipped, true);
  assert.ok(tiny.text.rows.length >= 1 && tiny.text.rows.every((row) => row.y <= 36 && row.x + row.width <= 72), JSON.stringify(tiny.text.rows));
});

test("appearance: a layout that asks for what is not there falls back; nothing at all is empty", () => {
  const lines = [{ text: "Signed by: An" }];
  const image = { width: 200, height: 100 };
  const imageOnly = layoutAppearance({ width: 180, height: 60, layout: "imageOnly", image, lines, measure });
  assert.ok(imageOnly.image && !imageOnly.text);
  assert.ok(Math.abs(imageOnly.image.w / imageOnly.image.h - 2) < 1e-9);
  // centred in the stamp
  assert.ok(Math.abs(imageOnly.image.x + imageOnly.image.w / 2 - 90) < 1e-6 && Math.abs(imageOnly.image.y + imageOnly.image.h / 2 - 30) < 1e-6);
  const detailsOnly = layoutAppearance({ width: 180, height: 60, layout: "detailsOnly", image, lines, measure });
  assert.ok(!detailsOnly.image && detailsOnly.text);
  const noPicture = layoutAppearance({ width: 180, height: 60, layout: "imageAndDetails", image: null, lines, measure });
  assert.ok(!noPicture.image && noPicture.text.rows.length === 1);
  const noLines = layoutAppearance({ width: 180, height: 60, layout: "imageAndDetails", image, lines: [], measure });
  assert.ok(noLines.image && !noLines.text);
  const nothing = layoutAppearance({ width: 180, height: 60, layout: "imageAndDetails", image: null, lines: [], measure });
  assert.deepEqual([nothing.image, nothing.text], [null, null]);

  assert.equal(appearanceIsEmpty({ layout: "imageOnly", hasImage: false, lines }), true);
  assert.equal(appearanceIsEmpty({ layout: "imageOnly", hasImage: true, lines: [] }), false);
  assert.equal(appearanceIsEmpty({ layout: "detailsOnly", hasImage: true, lines: [] }), true);
  assert.equal(appearanceIsEmpty({ layout: "imageAndDetails", hasImage: false, lines: [] }), true);
  assert.equal(appearanceIsEmpty({ layout: "imageAndDetails", hasImage: false, lines }), false);
});
