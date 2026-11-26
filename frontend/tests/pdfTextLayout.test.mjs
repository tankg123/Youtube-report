// From a measurement to the TextLayout of model/schema.js: the logic of layoutCore.js with hand-made boxes and
// with the Node measurer of tests/helpers/pdfTextKit.mjs (the DOM measuring itself is checked in a browser),
// and the layout written to a PDF the way the contract says, read back with pdf.js.
import test from "node:test";
import assert from "node:assert/strict";
import { frameMatrixUp, localToUser } from "../src/pages/pdfEditor/engine/geometry.js";
import { pdfFontFeatures, quantizeFontSize } from "../src/pages/pdfEditor/engine/textRules.js";
import { colorToRgb, validateObject } from "../src/pages/pdfEditor/model/schema.js";
import { TEXT_BASELINE_UNCERTAIN, TEXT_RASTERIZED } from "../src/pages/pdfEditor/text/codes.js";
import { buildTextLayout, frameForLayout, hardLines, textAnchor, withRaster } from "../src/pages/pdfEditor/text/layoutCore.js";
import { LAYOUT_SCALE } from "../src/pages/pdfEditor/text/textStyle.js";
import { fontBytes, fontManifest, fontkit, pageItems, pdfLib, squash, withPdf } from "./helpers/pdfTestKit.mjs";
import { VIETNAMESE_PANGRAM, fromCodePoints as s, makeTextObject, measureInNode, nodeTextLayout, parsedFont } from "./helpers/pdfTextKit.mjs";

const K = LAYOUT_SCALE;
const LF = s(0x0a);
const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);

/** Boxes of a row of clusters, each `width` layout pixels wide, starting at `left`. */
function row(text, index, { left = 0, top = 0, height = 100, width = 40 } = {}) {
  return [...text].map((char, offset) => ({ text: char, index: index + offset, left: left + offset * width, right: left + (offset + 1) * width, top, bottom: top + height }));
}
const base = (partial) => makeTextObject({ font: "be-vietnam-pro", size: 10, lineHeight: 1.5, autoWidth: false, frame: { x: 0, y: 0, w: 100, h: 0, rot: 0 }, ...partial });
// size 10 pt, line height 1.5: font 80 px, pitch 120 px; a made-up face with ascent 70 and box height 100
const measured = (graphemes, extra = {}) => ({ width: 800, height: 240, graphemes, ascent: 70, textHeight: 100, firstTop: 10, ...extra });

test("hardLines splits at line feeds and never returns nothing", () => {
  assert.deepEqual(hardLines(""), [[0, 0]]);
  assert.deepEqual(hardLines("ab"), [[0, 2]]);
  assert.deepEqual(hardLines(`ab${LF}`), [[0, 2], [3, 3]]);
  assert.deepEqual(hardLines(`${LF}${LF}x`), [[0, 0], [1, 1], [2, 3]]);
});

test("lines come from box tops; x, width and baseline from the boxes, in points", () => {
  const text = `abc de${LF}fg`;
  const layout = buildTextLayout(base({ text }), measured([...row("abc de", 0, { left: 8, top: 10 }), ...row("fg", 7, { left: 0, top: 130 })]), fontManifest);
  assert.equal(layout.width, 100);
  assert.equal(layout.height, 30);
  assert.equal(layout.raster, null);
  assert.deepEqual(layout.problems, []);
  assert.deepEqual(layout.fonts, ["be-vietnam-pro-regular"]);
  assert.deepEqual(layout.metrics, { ascent: 70 / K, textHeight: 100 / K, lineHeight: 15 });
  assert.deepEqual(layout.lines, [
    { baseline: 80 / K, x: 1, width: 30, runs: [{ text: "abc de", x: 1, font: "be-vietnam-pro-regular" }], text: "abc de", start: 0, end: 6 },
    { baseline: 200 / K, x: 0, width: 10, runs: [{ text: "fg", x: 0, font: "be-vietnam-pro-regular" }], text: "fg", start: 7, end: 9 }
  ]);
  assert.deepEqual(layout.underlines, []);
});

test("a soft wrap starts a new line; spaces hanging at the end of a line are neither text nor width", () => {
  // "aaa bbb" wrapped after the space; the space hangs behind the first line, a second space has no box at all
  const text = "aaa  bbb";
  const boxes = [...row("aaa", 0, { top: 10 }), ...row(" ", 3, { left: 120, top: 10 }), ...row("bbb", 5, { top: 130 })];
  const layout = buildTextLayout(base({ text }), measured(boxes), fontManifest);
  assert.deepEqual(layout.lines.map((line) => [line.text, line.start, line.end, line.x, line.width]), [["aaa", 0, 3, 0, 15], ["bbb", 5, 8, 0, 15]]);
  assert.deepEqual(layout.lines.map((line) => line.runs.map((run) => run.text)), [["aaa"], ["bbb"]]);
  // spaces inside a line stay, leading spaces too
  const inner = buildTextLayout(base({ text: "  a b  " }), measured(row("  a b  ", 0, { top: 10 })), fontManifest);
  assert.deepEqual(inner.lines.map((line) => [line.text, line.x, line.width]), [["  a b", 0, 25]]);
});

test("every visual line is listed: empty lines get their baseline from the pitch", () => {
  const text = `a${LF}${LF}b${LF}`;
  const layout = buildTextLayout(base({ text, align: "center" }), measured([...row("a", 0, { left: 380, top: 10 }), ...row("b", 3, { left: 380, top: 250 })], { height: 480 }), fontManifest);
  assert.equal(layout.height, 60);
  assert.deepEqual(layout.lines.map((line) => [line.text, line.baseline, line.x, line.width, line.runs.length, line.start, line.end]), [
    ["a", 10, 47.5, 5, 1, 0, 1],
    ["", 25, 50, 0, 0, 2, 2], // an empty line: the caret would stand at the alignment position
    ["b", 40, 47.5, 5, 1, 3, 4],
    ["", 55, 50, 0, 0, 5, 5]
  ]);
  // a text without any box: the first baseline comes from the measured first-line top
  const blank = buildTextLayout(base({ text: `${LF}${LF}`, align: "right" }), measured([], { height: 360 }), fontManifest);
  assert.deepEqual(blank.lines.map((line) => [line.baseline, line.x, line.width]), [[10, 100, 0], [25, 100, 0], [40, 100, 0]]);
  const empty = buildTextLayout(base({ text: "", autoWidth: true }), measured([], { width: 0, height: 120 }), fontManifest);
  assert.equal(empty.width, 0);
  assert.equal(empty.height, 15);
  assert.deepEqual(empty.lines, [{ baseline: 10, x: 0, width: 0, runs: [], text: "", start: 0, end: 0 }]);
  assert.deepEqual(empty.fonts, []);
});

test("an autoWidth box takes its width from the measurement, a wrapping box from its frame", () => {
  const boxes = row("abcd", 0, { top: 10 });
  assert.equal(buildTextLayout(base({ text: "abcd", autoWidth: true }), measured(boxes, { width: 161 }), fontManifest).width, 161 / K);
  assert.equal(buildTextLayout(base({ text: "abcd", autoWidth: false, frame: { x: 0, y: 0, w: 77.25, h: 0, rot: 0 } }), measured(boxes, { width: 618 }), fontManifest).width, 77.25);
});

test("fallback runs: one run per face, and the baseline of EVERY line is box top + the BOX face's ascent", () => {
  // Be Vietnam Pro lacks Cyrillic and arrows; a line made only of fallback glyphs has the same box top as
  // any other line (browsers build glyph boxes from the primary font), so it gets the same ascent offset
  const text = `Giá → Привет, мир${LF}Привет${LF}→`;
  const boxes = [...row("Giá → Привет, мир", 0, { top: 10 }), ...row("Привет", 18, { top: 130 }), ...row("→", 25, { top: 250 })];
  const layout = buildTextLayout(base({ text }), measured(boxes, { height: 360 }), fontManifest);
  assert.deepEqual(layout.problems, []);
  assert.deepEqual(layout.fonts, ["arimo-regular", "be-vietnam-pro-regular"]);
  assert.deepEqual(layout.lines.map((line) => line.baseline), [10, 25, 40]);
  assert.deepEqual(layout.lines[0].runs, [
    { text: "Giá ", x: 0, font: "be-vietnam-pro-regular" },
    { text: "→", x: 20, font: "arimo-regular" },
    { text: " ", x: 25, font: "be-vietnam-pro-regular" },
    { text: "Привет", x: 30, font: "arimo-regular" },
    { text: ", ", x: 60, font: "be-vietnam-pro-regular" },
    { text: "мир", x: 70, font: "arimo-regular" }
  ]);
  assert.deepEqual(layout.lines[1].runs, [{ text: "Привет", x: 0, font: "arimo-regular" }]);
  assert.deepEqual(layout.lines[2].runs, [{ text: "→", x: 0, font: "arimo-regular" }]);
  // the last run of a line loses its hanging spaces, a run in the middle keeps its spaces
  const trailing = buildTextLayout(base({ text: "Привет a  " }), measured(row("Привет a  ", 0, { top: 10 })), fontManifest);
  assert.deepEqual(trailing.lines[0].runs.map((run) => run.text), ["Привет", " a"]);
  // a bold italic box uses the bold italic fallback face
  const bold = buildTextLayout(base({ text: "a→", bold: true, italic: true }), measured(row("a→", 0, { top: 10 })), fontManifest);
  assert.deepEqual(bold.lines[0].runs.map((run) => run.font), ["be-vietnam-pro-bold-italic", "arimo-bold-italic"]);
});

test("a space the fallback face writes for the box font stands in a run of its own, placed by its measured box", () => {
  // Cousine has no figure space: the browser draws one 600 units wide from Cousine's own space, Arimo's glyph
  // is 556 units wide. With the sign after it in the same run, that sign would be written 0.044 em too far left.
  const figure = s(0x2007);
  const celsius = s(0x2103);
  const text = `${celsius}${figure}${celsius} x`;
  const boxes = [...row(celsius, 0, { left: 0, top: 10 }), ...row(figure, 1, { left: 40, top: 10, width: 48 }), ...row(`${celsius} x`, 2, { left: 88, top: 10 })];
  const layout = buildTextLayout(base({ font: "cousine", text }), measured(boxes), fontManifest);
  assert.deepEqual(layout.problems, []);
  assert.deepEqual(layout.lines[0].runs, [
    { text: celsius, x: 0, font: "arimo-regular" },
    { text: figure, x: 5, font: "arimo-regular" },
    { text: celsius, x: 11, font: "arimo-regular" },
    { text: " x", x: 16, font: "cousine-regular" }
  ]);
  // a letter the box font builds from its own parts makes the box a picture
  const composed = buildTextLayout(base({ font: "be-vietnam-pro", text: "Ĉu ne" }), measured(row("Ĉu ne", 0, { top: 10 })), fontManifest);
  assert.deepEqual(composed.problems, [TEXT_RASTERIZED]);
  assert.deepEqual(composed.lines[0].runs, []);
});

test("a box with a character no bundled font writes: TEXT_RASTERIZED, no runs anywhere, the lines stay", () => {
  const text = `Hợp đồng${LF}合同 ${s(0x1f600)}`;
  const boxes = [...row("Hợp đồng", 0, { top: 10 }), ...row("合同 ", 9, { top: 130 }), { text: s(0x1f600), index: 12, left: 120, right: 200, top: 130, bottom: 230 }];
  const layout = buildTextLayout(base({ text, underline: true }), measured(boxes), fontManifest);
  assert.deepEqual(layout.problems, [TEXT_RASTERIZED]);
  assert.equal(layout.raster, null); // the picture is made by raster.js / service.layoutForExport
  assert.deepEqual(layout.fonts, []);
  assert.deepEqual(layout.lines.map((line) => [line.text, line.runs.length, line.width]), [["Hợp đồng", 0, 40], [`合同 ${s(0x1f600)}`, 0, 25]]);
  assert.equal(layout.underlines.length, 2); // the picture shows them
  const withPicture = withRaster(layout, { png: new Uint8Array([1, 2, 3]), x: -1, y: -2, w: 50, h: 30 });
  assert.notEqual(withPicture, layout);
  assert.deepEqual(withPicture.raster, { png: new Uint8Array([1, 2, 3]), x: -1, y: -2, w: 50, h: 30 });
  assert.equal(withPicture.lines, layout.lines);
  assert.equal(layout.raster, null);
});

test("glyph boxes of one line that do not share a top are reported, not trusted silently", () => {
  const boxes = [...row("ab", 0, { top: 10 }), ...row("→", 2, { left: 80, top: 14 })];
  assert.deepEqual(buildTextLayout(base({ text: "ab→" }), measured(boxes), fontManifest).problems, [TEXT_BASELINE_UNCERTAIN]);
  // half a layout pixel is rounding, not another metric
  const fine = [...row("ab", 0, { top: 10 }), ...row("→", 2, { left: 80, top: 10.4 })];
  assert.deepEqual(buildTextLayout(base({ text: "ab→" }), measured(fine), fontManifest).problems, []);
});

test("underlines: one rectangle per line with ink, below the baseline, from the box font's own metrics", () => {
  const font = fontManifest.fonts.find((entry) => entry.id === "arimo-regular");
  const object = base({ font: "arimo", text: `ab cd${LF}${LF}e`, underline: true, size: 20 });
  const boxes = [...row("ab cd", 0, { left: 40, top: 10 }), ...row("e", 7, { top: 250 })];
  const layout = buildTextLayout(object, measured(boxes, { height: 720 }), fontManifest);
  assert.equal(layout.underlines.length, 2);
  const [first, second] = layout.underlines;
  assert.equal(first.x, 5);
  assert.equal(first.w, 25);
  close(first.y - layout.lines[0].baseline, (-font.metrics.underlinePosition * 20) / font.unitsPerEm, 1e-9, "offset of the underline");
  close(first.h, (font.metrics.underlineThickness * 20) / font.unitsPerEm, 1e-9, "thickness");
  assert.ok(first.y > layout.lines[0].baseline && first.h > 0.5 && first.h < 3);
  assert.equal(second.x, 0);
  assert.equal(second.w, 5);
  close(second.y - layout.lines[2].baseline, first.y - layout.lines[0].baseline, 1e-9, "same offset on every line");
  // the same bar as two numbers, the form the exporter reads: every rectangle follows from them
  assert.deepEqual(Object.keys(layout.underline), ["offset", "thickness"]);
  for (const rect of layout.underlines) {
    const line = layout.lines.find((entry) => entry.x === rect.x && entry.width === rect.w);
    assert.ok(line && line.width > 0);
    assert.equal(rect.y, line.baseline + layout.underline.offset);
    assert.equal(rect.h, layout.underline.thickness);
  }
  const plain = buildTextLayout({ ...object, underline: false }, measured(boxes, { height: 720 }), fontManifest);
  assert.deepEqual(plain.underlines, []);
  assert.equal(plain.underline, null);
});

test("a layout is frozen all the way down", () => {
  const layout = nodeTextLayout(makeTextObject({ text: "Hợp đồng → Привет", font: "be-vietnam-pro", underline: true }));
  for (const value of [layout, layout.lines, layout.lines[0], layout.lines[0].runs, layout.lines[0].runs[0], layout.problems, layout.underlines, layout.underlines[0], layout.underline, layout.fonts, layout.metrics]) assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    layout.raster = {};
  }, TypeError);
});

test("the anchor of a text box: an autoWidth box grows away from its alignment edge, a wrapping box downwards", () => {
  assert.deepEqual(textAnchor({ autoWidth: true, align: "left" }), [0, 0]);
  assert.deepEqual(textAnchor({ autoWidth: true, align: "center" }), [0.5, 0]);
  assert.deepEqual(textAnchor({ autoWidth: true, align: "right" }), [1, 0]);
  assert.deepEqual(textAnchor({ autoWidth: false, align: "right" }), [0, 0]);
  const frame = { x: 200, y: 500, w: 100, h: 20, rot: 0 };
  const grown = { width: 140, height: 50 };
  // user space is y up: the top edge is at y + h / 2 = 510 and must stay there
  assert.deepEqual(frameForLayout({ frame, autoWidth: true, align: "left" }, grown), { x: 220, y: 485, w: 140, h: 50, rot: 0 });
  assert.deepEqual(frameForLayout({ frame, autoWidth: true, align: "center" }, grown), { x: 200, y: 485, w: 140, h: 50, rot: 0 });
  assert.deepEqual(frameForLayout({ frame, autoWidth: true, align: "right" }, grown), { x: 180, y: 485, w: 140, h: 50, rot: 0 });
  assert.deepEqual(frameForLayout({ frame, autoWidth: false, align: "center" }, { width: 100, height: 50 }), { x: 200, y: 485, w: 100, h: 50, rot: 0 });
  // a wrapping box keeps its own width: it is what the text was laid out for, never a result
  assert.deepEqual(frameForLayout({ frame, autoWidth: false, align: "right" }, { width: 100.001953125, height: 50 }), { x: 200, y: 485, w: 100, h: 50, rot: 0 });
  const same = frameForLayout({ frame, autoWidth: false, align: "left" }, { width: 99.998046875, height: 20 });
  assert.deepEqual(same, frame);
  // a box turned by 90 degrees grows along its own axes
  const turned = frameForLayout({ frame: { ...frame, rot: 90 }, autoWidth: true, align: "left" }, grown);
  close(turned.x, 215, 1e-9, "x");
  close(turned.y, 520, 1e-9, "y");
  // with a UserUnit of 2 a point is half a user-space unit
  assert.deepEqual(frameForLayout({ frame, autoWidth: true, align: "left" }, grown, 2), { x: 210, y: 492.5, w: 140, h: 50, rot: 0 });
});

// --- the Node measurer: real advances from the font files ---

test("node measurer: advances are the font's own, with the size the PDF gets", () => {
  for (const [font, text] of [["arimo", "AVATAR To Ty WA office"], ["tinos", VIETNAMESE_PANGRAM], ["cousine", "0123456789 mmm iii"], ["be-vietnam-pro", "Kỹ sư Đỗ Thị Hường – 1.234.567 ₫"]]) {
    for (const size of [6, 10.555, 12, 36]) {
      const object = makeTextObject({ font, size, text });
      const layout = nodeTextLayout(object);
      const parsed = parsedFont(`${font}-regular`);
      const expected = ([...text].reduce((sum, char) => sum + parsed.glyphForCodePoint(char.codePointAt(0)).advanceWidth, 0) / parsed.unitsPerEm) * quantizeFontSize(size);
      assert.equal(layout.lines.length, 1);
      close(layout.lines[0].width, expected, 1e-9, `${font} ${size}`);
      close(layout.width, expected, 1e-9, `${font} ${size} box`);
      close(layout.height, layout.metrics.lineHeight, 0.01, `${font} ${size} height`);
      assert.equal(object.frame.w, layout.width);
      assert.deepEqual(validateObject(object), []);
    }
  }
});

test("node measurer: wrapping keeps every character, alignment moves the lines, the frame follows", () => {
  const text = `Cộng hòa xã hội chủ nghĩa Việt Nam – Độc lập – Tự do – Hạnh phúc.${LF}${LF}Kỹ sư Đỗ Thị Hường vừa xử lý xong hồ sơ ở quận Hoàn Kiếm.`;
  for (const align of ["left", "center", "right"]) {
    const object = makeTextObject({ font: "tinos", size: 11, text, align, autoWidth: false, frame: { w: 150 } });
    const layout = nodeTextLayout(object);
    assert.ok(layout.lines.length > 5, `${layout.lines.length} lines`);
    assert.equal(layout.width, 150);
    assert.equal(squash(layout.lines.map((line) => line.text).join("")), squash(text));
    close(layout.height, layout.lines.length * layout.metrics.lineHeight, 0.05, "height");
    let previous = -Infinity;
    for (const line of layout.lines) {
      assert.ok(line.baseline > previous + layout.metrics.lineHeight * 0.9, "lines go down by one pitch");
      previous = line.baseline;
      assert.ok(line.width <= 150 + 1e-6, `${line.text} fits`);
      assert.equal(text.slice(line.start, line.end), line.text);
      if (line.width === 0) continue;
      if (align === "left") close(line.x, 0, 1e-9, "left");
      if (align === "center") close(line.x + line.width / 2, 75, 1e-6, "centre");
      if (align === "right") close(line.x + line.width, 150, 1e-6, "right");
    }
    assert.equal(layout.lines.filter((line) => line.text === "").length, 1);
  }
});

test("node measurer: the measurement has the shape the DOM measurer delivers", () => {
  const object = makeTextObject({ font: "be-vietnam-pro", size: 13, lineHeight: 1.4, text: "Giá: 100 ₫ → Привет", autoWidth: true });
  const measurement = measureInNode(object);
  // Chrome on Windows at device pixel ratio 1: ascent 104 px, glyph box 132 px, first box 6 px below the top
  assert.equal(measurement.ascent, 104);
  assert.equal(measurement.textHeight, 132);
  assert.equal(measurement.firstTop, 6);
  assert.equal(measurement.graphemes.length, [...object.text].length);
  for (const box of measurement.graphemes) assert.ok(box.right > box.left && box.bottom - box.top === 132 && Number.isInteger(box.index));
  const layout = nodeTextLayout(object);
  assert.equal(layout.lines[0].baseline, 13.75);
  assert.deepEqual(layout.lines[0].runs.map((run) => run.font), ["be-vietnam-pro-regular", "arimo-regular", "be-vietnam-pro-regular", "arimo-regular"]);
});

// --- the contract with the exporter ---

/** Writes text objects into a PDF exactly as the TextLayout contract says. */
async function writePdf(objects, pageSize = [420, 600]) {
  const { PDFDocument, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb } = pdfLib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage(pageSize);
  const embedded = new Map();
  for (const { object, layout } of objects) {
    for (const key of layout.fonts) {
      if (!embedded.has(key)) embedded.set(key, await doc.embedFont(fontBytes(key), { subset: true, features: pdfFontFeatures() }));
    }
    const [r, g, b] = colorToRgb(object.color);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frameMatrixUp(object.frame)));
    for (const line of layout.lines) {
      for (const run of line.runs) page.drawText(run.text, { x: run.x, y: object.frame.h - line.baseline, size: quantizeFontSize(object.size), font: embedded.get(run.font), color: rgb(r, g, b) });
    }
    for (const rect of layout.underlines) page.drawRectangle({ x: rect.x, y: object.frame.h - rect.y - rect.h, width: rect.w, height: rect.h, color: rgb(r, g, b) });
    page.pushOperators(popGraphicsState());
  }
  return doc.save();
}

test("a layout written to a PDF as the contract says is found by pdf.js where the layout says", async () => {
  const cases = [
    makeTextObject({ id: "a", font: "arimo", size: 12, text: `Hợp đồng dịch vụ số 12/2026${LF}Nguyễn Văn An`, frame: { x: 150, y: 520, rot: 0 } }),
    makeTextObject({ id: "b", font: "be-vietnam-pro", size: 13, lineHeight: 1.4, underline: true, text: `Giá: 100 ₫ → Привет, мир! αβγ${LF}Привет${LF}→`, frame: { x: 200, y: 400, rot: 0 } }),
    makeTextObject({ id: "c", font: "tinos", bold: true, italic: true, size: 10.5, align: "center", autoWidth: false, text: "Cộng hòa xã hội chủ nghĩa Việt Nam – Độc lập – Tự do – Hạnh phúc", frame: { x: 210, y: 250, w: 140, rot: 0 } }),
    makeTextObject({ id: "d", font: "cousine", size: 9, align: "right", text: `mã số 0123${LF}đã ký`, frame: { x: 210, y: 120, rot: 30 } })
  ].map((object) => ({ object, layout: nodeTextLayout(object) }));
  const bytes = await writePdf(cases);
  await withPdf(bytes, async (doc) => {
    const items = await pageItems(await doc.getPage(1));
    for (const { object, layout } of cases) {
      for (const line of layout.lines) {
        if (line.runs.length === 0) continue;
        // where the first glyph of the line must stand in user space
        const [x, y] = localToUser(object.frame, [line.runs[0].x, line.baseline]);
        const onLine = items.filter((item) => Math.hypot(item.transform[4] - x, item.transform[5] - y) < 0.02);
        assert.equal(onLine.length, 1, `${object.id}: "${line.text}" starts at ${x.toFixed(2)}, ${y.toFixed(2)}`);
        const item = onLine[0];
        close(item.angle, object.frame.rot, 0.01, `${object.id} angle`);
        // pdf.js joins the runs of one baseline into one item or splits a line at wide spaces: either way the
        // item at the start holds the start of the line, and the items along the baseline hold all of it
        const expected = squash(line.text);
        assert.ok(squash(item.str) !== "" && expected.startsWith(squash(item.str)), `${object.id}: "${line.text}" starts with "${item.str}"`);
        const joined = squash(items.filter((other) => Math.abs((other.transform[5] - y) * Math.cos((object.frame.rot * Math.PI) / 180) - (other.transform[4] - x) * Math.sin((object.frame.rot * Math.PI) / 180)) < 0.02).map((other) => other.str).join(""));
        assert.equal(joined, expected, `${object.id}: line text`);
      }
    }
    // the size in the PDF is the quantised size
    const sizes = new Set(items.map((item) => Math.round(Math.hypot(item.transform[0], item.transform[1]) * 1000) / 1000));
    assert.deepEqual([...sizes].sort((a, b) => a - b), [9, 10.5, 12, 13]);
  });
});

test("the width pdf.js reports for a written line is the width of the layout", async () => {
  const object = makeTextObject({ font: "arimo", size: 14, text: "Kỹ sư Đỗ Thị Hường vừa xử lý xong hồ sơ", frame: { x: 210, y: 300, rot: 0 } });
  const layout = nodeTextLayout(object);
  await withPdf(await writePdf([{ object, layout }]), async (doc) => {
    const items = await pageItems(await doc.getPage(1));
    assert.equal(items.length, 1);
    close(items[0].width, layout.lines[0].width, 0.01, "line width");
    assert.equal(squash(items[0].str), squash(object.text));
  });
});
