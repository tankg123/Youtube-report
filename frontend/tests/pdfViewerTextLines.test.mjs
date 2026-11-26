// Text lines of the PDF viewer: pdf.js text items grouped on their baselines (viewer/textLines.js), on PDFs
// generated with the editor's own library and fonts, plus hand-made items for the cases a generator cannot
// produce on demand.
import test from "node:test";
import assert from "node:assert/strict";
import { VIETNAMESE_SAMPLE, makeTextPdf, pageItems, withPdf } from "./helpers/pdfTestKit.mjs";
import { makePdf, textContentOf } from "./helpers/pdfViewerKit.mjs";
import { describeFont, groupTextLines, lineAtPoint, linesInRect } from "../src/pages/pdfEditor/viewer/textLines.js";

const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label || "value"}: expected ${expected} +- ${tolerance}, got ${actual}`);
const linesOf = async (bytes, pageNumber = 1, options = {}) => {
  const content = await textContentOf(bytes, pageNumber);
  return { content, lines: groupTextLines(content.items, content.styles, { fonts: content.fonts, userUnit: content.userUnit, ...options }) };
};

test("one line per drawn line, top to bottom, with text, box, size and font", async () => {
  const drawn = [VIETNAMESE_SAMPLE, "Điều 1. Phạm vi dịch vụ", "Bên A thanh toán trong 30 ngày."];
  const bytes = await makeTextPdf([{ lines: drawn, fontSize: 14 }]);
  const { lines } = await linesOf(bytes);
  assert.deepEqual(lines.map((line) => line.text), drawn);
  lines.forEach((line, index) => {
    // makeTextPdf draws at x = 50, 24 points apart from y = height - 60
    const baseline = 841.89 - 60 - index * 24;
    near(line.rect[0], 50, 0.5, "left");
    assert.ok(line.rect[1] < baseline && line.rect[3] > baseline, "the box holds the baseline");
    near(line.rect[3] - line.rect[1], 14 * 1.117, 1.5, "height = ascent + descent of Arimo");
    near(line.baseline[1], baseline, 0.01, "baseline y");
    assert.equal(line.angle, 0);
    assert.equal(line.fontSize, 14);
    assert.equal(line.vertical, false);
    assert.equal(line.font.serif, false);
    assert.equal(line.font.monospace, false);
    assert.equal(line.font.bold, false);
    assert.match(line.font.name, /^Arimo-Regular/);
    // quad: top-left, top-right, bottom-right, bottom-left as read
    const [x1, y1, x2, y2, x3, y3, x4, y4] = line.quad;
    assert.ok(x1 < x2 && y1 === y2 && x3 === x2 && y3 < y2 && x4 === x1 && y4 === y3, `quad order ${line.quad}`);
    assert.deepEqual(line.rect, [x1, y3, x2, y1]);
  });
  assert.ok(lines[0].rect[1] > lines[1].rect[3], "lines do not overlap");
});

test("the line box covers the boxes of its items", async () => {
  const bytes = await makeTextPdf([{ lines: [VIETNAMESE_SAMPLE, "gjpqy ÀÉÔ"] }]);
  const { lines } = await linesOf(bytes);
  await withPdf(bytes, async (doc) => {
    const items = await pageItems(await doc.getPage(1));
    for (const item of items) {
      const line = lines.find((candidate) => candidate.items.some((member) => member.str === item.str));
      assert.ok(line, `item ${item.str} belongs to a line`);
      assert.ok(line.rect[0] <= item.box[0] + 0.01 && line.rect[2] >= item.box[2] - 0.01, "horizontal extent");
      assert.ok(line.rect[1] <= item.box[1] + 0.01 && line.rect[3] >= item.box[3] - 0.01, "vertical extent");
    }
  });
});

test("runs in several fonts on one baseline are one line; the font that sets most characters describes it", async () => {
  const bytes = await makePdf([
    {
      texts: [
        { text: "Tên:", x: 50, y: 700, fontKey: "arimo-bold" },
        { text: "Nguyễn Văn An, sinh năm 1990", x: 81, y: 700, fontKey: "tinos-italic" },
        { text: "Mã số: 0109876543", x: 50, y: 680, fontKey: "cousine-regular", size: 10 }
      ]
    }
  ]);
  const { lines } = await linesOf(bytes);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Tên: Nguyễn Văn An, sinh năm 1990");
  assert.equal(lines[0].items.length, 2);
  assert.deepEqual(lines[0].items.map((item) => item.str), ["Tên:", "Nguyễn Văn An, sinh năm 1990"]);
  assert.match(lines[0].font.name, /^Tinos-Italic/);
  assert.deepEqual({ ...lines[0].font, name: null }, { name: null, serif: true, monospace: false, bold: false, italic: true });
  assert.equal(lines[0].fontSize, 12);
  near(lines[0].rect[0], 50, 0.5, "the line starts with the bold run");
  // every item carries its own quad and its index among the page's text items
  assert.ok(lines[0].items[0].quad[2] <= lines[0].items[1].quad[0] + 0.01);
  assert.ok(lines[0].items.every((item) => Number.isInteger(item.index)));
  assert.deepEqual({ ...lines[1].font, name: null }, { name: null, serif: false, monospace: true, bold: false, italic: false });
  assert.equal(lines[1].fontSize, 10);
});

test("columns and table cells that share a baseline stay separate lines", async () => {
  const bytes = await makePdf([
    {
      texts: [
        { text: "Cột trái dòng một", x: 50, y: 700 },
        { text: "Cột phải dòng một", x: 320, y: 700 },
        { text: "Cột trái dòng hai", x: 50, y: 684 },
        { text: "Cột phải dòng hai", x: 320, y: 684 }
      ]
    }
  ]);
  const { content, lines } = await linesOf(bytes);
  assert.deepEqual(lines.map((line) => line.text), ["Cột trái dòng một", "Cột phải dòng một", "Cột trái dòng hai", "Cột phải dòng hai"]);
  assert.ok(lines[0].rect[2] < 320 && lines[1].rect[0] >= 319.9);
  // with a generous gap the two cells of a row read as one line
  const wide = groupTextLines(content.items, content.styles, { maxGap: 20 });
  assert.deepEqual(wide.map((line) => line.text), ["Cột trái dòng một Cột phải dòng một", "Cột trái dòng hai Cột phải dòng hai"]);
});

test("rotated text: the quad follows the reading direction", async () => {
  const bytes = await makePdf([
    {
      texts: [
        { text: "Dọc lên trên", x: 300, y: 200, angle: 90 },
        { text: "Chéo ba mươi độ", x: 100, y: 400, angle: 30 },
        { text: "Ngược đầu", x: 400, y: 600, angle: 180 }
      ]
    }
  ]);
  const { lines } = await linesOf(bytes);
  const byText = Object.fromEntries(lines.map((line) => [line.text, line]));
  const up = byText["Dọc lên trên"];
  assert.equal(up.angle, 90);
  // reading upwards: "top-left as read" is the left side of the page, at the start of the text
  const [x1, y1, x2, y2, , , x4, y4] = up.quad;
  near(x2, x1, 0.001, "top edge is vertical on the page");
  assert.ok(y2 > y1, "the text runs up the page");
  assert.ok(x4 > x1, "the descent side is to the right");
  near(y4, y1, 0.001);
  near(up.baseline[0], 300, 0.01);
  near(up.baseline[1], 200, 0.01);
  assert.ok(up.rect[3] - up.rect[1] > 50 && up.rect[2] - up.rect[0] < 20, "tall and narrow");

  const slanted = byText["Chéo ba mươi độ"];
  near(slanted.angle, 30, 0.01);
  const width = Math.hypot(slanted.quad[2] - slanted.quad[0], slanted.quad[3] - slanted.quad[1]);
  const height = Math.hypot(slanted.quad[6] - slanted.quad[0], slanted.quad[7] - slanted.quad[1]);
  assert.ok(width > 80 && height > 11 && height < 16, `a rotated rectangle of the line's size: ${width} x ${height}`);
  // the bounding box is larger than the rotated box
  assert.ok((slanted.rect[2] - slanted.rect[0]) * (slanted.rect[3] - slanted.rect[1]) > width * height);

  const upsideDown = byText["Ngược đầu"];
  assert.equal(upsideDown.angle, 180);
  assert.ok(upsideDown.quad[2] < upsideDown.quad[0], "read from right to left on the page");
  assert.ok(upsideDown.rect[2] <= 400.01, "the text extends to the left of its origin");
});

test("a rotated page (/Rotate) and a cropped page keep their lines in user space", async () => {
  const text = "Trang xoay 90 độ: Nguyễn Văn An";
  const plain = await makeTextPdf([{ lines: [text] }]);
  const rotated = await makeTextPdf([{ lines: [text], rotate: 90 }]);
  const cropped = await makePdf([{ texts: [{ text, x: 50, y: 841.89 - 60, size: 14 }], crop: [20, 300, 500, 830], rotate: 270 }]);
  const [first, second, third] = await Promise.all([linesOf(plain), linesOf(rotated), linesOf(cropped)]);
  assert.equal(second.content.rotate, 90);
  assert.equal(third.content.rotate, 270);
  assert.deepEqual(third.content.view, [20, 300, 500, 830]);
  for (const result of [second, third]) {
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].text, text);
    assert.equal(result.lines[0].angle, 0, "/Rotate does not turn user space");
    result.lines[0].rect.forEach((value, index) => near(value, first.lines[0].rect[index], 0.01, `rect[${index}]`));
  }
});

test("UserUnit: positions stay in user space, the font size is in points", async () => {
  const bytes = await makePdf([{ size: [300, 400], userUnit: 2, texts: [{ text: "Đơn vị gấp đôi", x: 40, y: 300, size: 10 }] }]);
  const { content, lines } = await linesOf(bytes);
  assert.equal(content.userUnit, 2);
  assert.equal(lines[0].fontSize, 20);
  assert.equal(lines[0].items[0].fontSize, 20);
  near(lines[0].rect[0], 40, 0.01);
  near(lines[0].baseline[1], 300, 0.01);
  assert.ok(lines[0].rect[3] - lines[0].rect[1] < 13, "the box is in user space units, not in points");
});

test("a raised small run is its own line, and a slightly shifted run of the same size is not", async () => {
  const bytes = await makePdf([
    {
      texts: [
        { text: "Giá trị hợp đồng", x: 50, y: 700 },
        { text: "(1)", x: 142, y: 705, size: 7 },
        { text: "Dòng lệch", x: 50, y: 650 },
        { text: "nửa điểm", x: 110, y: 650.5 }
      ]
    }
  ]);
  const { lines } = await linesOf(bytes);
  assert.deepEqual(lines.map((line) => line.text), ["Giá trị hợp đồng", "(1)", "Dòng lệch nửa điểm"]);
});

test("hit tests: the line under a point and the lines under a drag", async () => {
  const drawn = ["Dòng một", "Dòng hai dài hơn một chút", "Dòng ba"];
  const bytes = await makeTextPdf([{ lines: drawn }]);
  const { lines } = await linesOf(bytes);
  const middle = (line) => [(line.rect[0] + line.rect[2]) / 2, (line.rect[1] + line.rect[3]) / 2];
  for (const line of lines) assert.equal(lineAtPoint(lines, middle(line)), line);
  assert.equal(lineAtPoint(lines, [300, 100]), null, "empty paper");
  assert.equal(lineAtPoint(lines, [lines[0].rect[2] + 3, middle(lines[0])[1]]), null, "just right of a line");
  assert.equal(lineAtPoint(lines, [lines[0].rect[2] + 3, middle(lines[0])[1]], 4), lines[0], "... within the tolerance");
  // a drag from the middle of line 1 to the middle of line 2
  const drag = [60, middle(lines[0])[1], 200, middle(lines[1])[1]];
  assert.deepEqual(linesInRect(lines, drag).map((line) => line.text), drawn.slice(0, 2));
  assert.deepEqual(linesInRect(lines, [drag[2], drag[3], drag[0], drag[1]]).map((line) => line.text), drawn.slice(0, 2), "corners in any order");
  assert.deepEqual(linesInRect(lines, [400, 50, 500, 100]), []);

  // a rotated line is hit inside its rotated box, not inside its bounding box
  const turned = await makePdf([{ texts: [{ text: "Chéo bốn mươi lăm độ", x: 100, y: 400, angle: 45 }] }]);
  const [slanted] = (await linesOf(turned)).lines;
  assert.equal(lineAtPoint([slanted], [130, 431]), slanted, "on the baseline, 43 points along");
  assert.equal(lineAtPoint([slanted], [slanted.rect[2] - 1, slanted.rect[1] + 1]), null, "a corner of the bounding box");
});

test("hand-made items: spaces, line ends, out-of-order drawing, degenerate matrices", () => {
  const style = { ascent: 0.9, descent: -0.2 };
  const run = (str, x, y, width, extra = {}) => ({ str, dir: "ltr", width, height: 10, transform: [10, 0, 0, 10, x, y], fontName: "f1", hasEOL: false, ...extra });
  const items = [
    { type: "beginMarkedContent" },
    run("world", 80, 100, 25), // drawn first, although it reads second
    run("Hello", 50, 100, 25),
    run(" ", 75, 100, 5),
    { str: "", dir: "ltr", width: 0, height: 0, transform: [10, 0, 0, 10, 50, 80], fontName: "f1", hasEOL: true },
    run("tight", 50, 80, 22),
    run("ly", 72, 80, 8), // no gap: no space
    run("zero", 50, 60, 20, { transform: [0, 0, 0, 0, 50, 60] }), // cannot be placed
    run("next", 50, 40, 20),
    { type: "endMarkedContent" }
  ];
  const lines = groupTextLines(items, { f1: style });
  assert.deepEqual(lines.map((line) => line.text), ["Hello world", "tightly", "next"]);
  // indexes count the items that have a string: the marked-content entries do not count
  assert.deepEqual(lines[0].items.map((item) => item.index), [1, 0]);
  assert.deepEqual(lines[1].items.map((item) => item.index), [4, 5]);
  assert.deepEqual(lines[2].items.map((item) => item.index), [7]);
  assert.deepEqual(lines[0].rect, [50, 98, 105, 109]);
  assert.equal(lines[0].font.name, null);
  assert.equal(groupTextLines([], {}).length, 0);
  assert.equal(groupTextLines(null).length, 0);
});

test("hand-made items: missing or broken font metrics, a fake italic, right-to-left and vertical runs", () => {
  const run = (str, transform, width, extra = {}) => ({ str, dir: "ltr", width, height: 12, transform, fontName: "f1", hasEOL: false, ...extra });
  // no metrics: pdf.js' own defaults (0.8 / -0.2); absurd metrics are clamped
  const [plain] = groupTextLines([run("abc", [12, 0, 0, 12, 10, 100], 20)], { f1: { ascent: null, descent: null } });
  assert.deepEqual(plain.rect, [10, 97.6, 30, 109.6]);
  const [clamped] = groupTextLines([run("abc", [12, 0, 0, 12, 10, 100], 20)], { f1: { ascent: 5, descent: -4 } });
  assert.ok(clamped.rect[3] - clamped.rect[1] <= 12 * 1.85 + 0.001);
  // a sheared matrix (synthetic italic) does not inflate the size or tilt the baseline
  const [sheared] = groupTextLines([run("abc", [12, 0, 4, 12, 10, 100], 20)], { f1: { ascent: 0.8, descent: -0.2 } });
  assert.equal(sheared.fontSize, 12);
  assert.equal(sheared.angle, 0);
  // right-to-left items read from the right
  const rtl = groupTextLines([run("B", [12, 0, 0, 12, 10, 100], 8, { dir: "rtl" }), run("A", [12, 0, 0, 12, 22, 100], 8, { dir: "rtl" })], { f1: {} });
  assert.equal(rtl[0].text, "A B");
  // a vertical-writing run is a line of its own: a box hanging from its origin
  const [vertical] = groupTextLines([run("TATE", [12, 0, 0, 12, 100, 500], 12, { height: 48 })], { f1: { vertical: true } });
  assert.equal(vertical.vertical, true);
  assert.deepEqual(vertical.rect, [94, 452, 106, 500]);
});

test("describeFont: the name decides, the flags of pdf.js help", () => {
  const font = (name, extra = {}) => describeFont({ name, ...extra });
  assert.deepEqual(font("ABCDEF+TimesNewRomanPS-BoldItalicMT"), { name: "TimesNewRomanPS-BoldItalicMT", serif: true, monospace: false, bold: true, italic: true });
  assert.deepEqual(font("Arial-BoldMT-4533"), { name: "Arial-BoldMT-4533", serif: false, monospace: false, bold: true, italic: false });
  assert.deepEqual(font("CourierNewPSMT"), { name: "CourierNewPSMT", serif: false, monospace: true, bold: false, italic: false });
  assert.equal(font("MinionPro-It").italic, true);
  assert.equal(font("MyriadPro-SemiboldIt").bold, true);
  assert.equal(font("MyriadPro-SemiCondensed").bold, false);
  assert.equal(font("Helvetica-Oblique").italic, true);
  assert.equal(font("NotoSans-Regular", { isSerifFont: true }).serif, false, "a sans name beats a wrong serif flag");
  assert.equal(font("BeVietnamPro-Regular").serif, false);
  assert.equal(font("Georgia").serif, true);
  assert.equal(font("UnknownFace", { isSerifFont: true }).serif, true);
  assert.equal(font("UnknownFace", { bold: true, italic: true }).bold, true);
  assert.equal(font("DejaVuSansMono").monospace, true);
  // nothing known about the font: the generic family of the text content is the last resort
  assert.deepEqual(describeFont(null, "serif"), { name: null, serif: true, monospace: false, bold: false, italic: false });
  assert.deepEqual(describeFont(null, "monospace"), { name: null, serif: false, monospace: true, bold: false, italic: false });
  assert.deepEqual(describeFont(undefined), { name: null, serif: false, monospace: false, bold: false, italic: false });
});
