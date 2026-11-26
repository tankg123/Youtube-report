// engine/export: drawing the editor's objects. Every object type must land where engine/geometry.js says,
// on pages with /Rotate 0 / 90 / 180 / 270, a CropBox, a shifted MediaBox and a /UserUnit (INV-5), without
// changing anything else on the page (INV-6). Pixel checks need a canvas (canRender); everything about text
// is checked through pdf.js text extraction and runs everywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleDocument, drawOnDocument } from "../src/pages/pdfEditor/engine/export/index.js";
import { frameFromScreen, viewportToUser, visibleSize } from "../src/pages/pdfEditor/engine/geometry.js";
import { arrowHeadSize, dashPattern, underlineBar } from "../src/pages/pdfEditor/engine/export/shapes.js";
import { canRender, extractText, fontBytes, loadFont, makeTextPdf, pdfLib, squash, withPdf } from "./helpers/pdfTestKit.mjs";
import {
  MARKERS, SAMPLE_COLORS, SAMPLE_JPEG, SAMPLE_PNG, buildGeometryFixture, buildLinkedFixture, makeTextObject, parsedFont,
  withExifOrientation
} from "./helpers/pdfExportFixtures.mjs";
import { fileFacts, loadPlain, pageContentText, resourceNames } from "./helpers/pdfExportScan.mjs";
import {
  annotationCensus, colorNear, differingPixels, findColorBox, firstDifference, linkTargets, outlineOf, pixelAt, renderAll, renderToPixels,
  screenTextItems
} from "./helpers/pdfExportRender.mjs";

const { PDFName, PDFDict, PDFStream } = pdfLib;
const NOW = new Date(Date.UTC(2026, 10, 16, 2, 0, 0));
const SEED = new Uint8Array(16).fill(9);
const OPTIONS = { fonts: loadFont, now: NOW, idSeed: SEED };
const noCanvas = !canRender && "no canvas binary on this platform";
const SCALE = 2;

let counter = 0;
const nextId = (prefix) => {
  counter += 1;
  return `${prefix}${counter}`;
};
const base = (type) => ({ id: nextId(type), type, pageId: "page" });
const blankJob = (size, objects, extra = {}) => ({
  sources: [], pages: [{ blank: size, rotate: 0 }], objects: [objects], marks: [], assets: {}, info: {}, fileName: "draw", ...extra
});
/** A frame from a box given as the reader sees it on a blank page of `height` points (y down from the top). */
const boxFrame = (left, top, w, h, pageHeight, rot = 0) => ({ x: left + w / 2, y: pageHeight - top - h / 2, w, h, rot });
const near = (actual, expected, tolerance, message) => assert.ok(colorNear(actual, expected, tolerance), `${message}: got rgb(${actual}), expected rgb(${expected}) +-${tolerance}`);

// -----------------------------------------------------------------------------------------------------------
// INV-5 / INV-6: every object type on every page geometry
// -----------------------------------------------------------------------------------------------------------

const TEXT = "Chữ Việt";
const COLORS = {
  rect: ["#ff00ff", [255, 0, 255]],
  ellipse: ["#00b4b4", [0, 180, 180]],
  image: ["#ff8000", [255, 128, 0]],
  line: ["#009900", [0, 153, 0]],
  pen: ["#0000ff", [0, 0, 255]],
  textHighlight: ["#00ffff", [0, 255, 255]],
  strokeHighlight: ["#ffff00", [255, 255, 0]],
  turned: ["#964b00", [150, 75, 0]]
};

/**
 * Nine objects on a 3 x 3 grid of the VISIBLE page, each given as the reader sees it and converted with
 * geometry.js. Returns the objects and where (screen points) each one must be found.
 */
function sceneFor(geometry) {
  const [width, height] = visibleSize(geometry, 0);
  const cell = (column, row) => [width * (0.27 + 0.23 * column), height * (0.27 + 0.23 * row)];
  const frame = (centre, w, h, rotation = 0) => frameFromScreen(geometry, { cx: centre[0], cy: centre[1], w, h, rotation }, 1, 0);
  const user = (point) => viewportToUser(geometry, point, 1, 0);
  const expected = {};
  const objects = [];

  let centre = cell(0, 0);
  objects.push({ ...base("rect"), frame: frame(centre, 30, 20), stroke: null, strokeWidth: 0, dash: "solid", fill: COLORS.rect[0], opacity: 1 });
  expected.rect = { cx: centre[0], cy: centre[1], w: 30, h: 20 };

  centre = cell(1, 0);
  objects.push({ ...base("ellipse"), frame: frame(centre, 30, 20), stroke: null, strokeWidth: 0, dash: "solid", fill: COLORS.ellipse[0], opacity: 1 });
  expected.ellipse = { cx: centre[0], cy: centre[1], w: 30, h: 20 };

  centre = cell(2, 0);
  objects.push({ ...base("image"), frame: frame(centre, 24, 24), assetId: "orange", role: "image", opacity: 1 });
  expected.image = { cx: centre[0], cy: centre[1], w: 24, h: 24 };

  centre = cell(0, 1);
  objects.push({ ...base("line"), p1: user([centre[0] - 13, centre[1]]), p2: user([centre[0] + 13, centre[1]]), stroke: COLORS.line[0], strokeWidth: 4, dash: "solid", headStart: false, headEnd: false, opacity: 1 });
  expected.line = { cx: centre[0], cy: centre[1], w: 30, h: 4 }; // 26 long + a round cap of 2 at both ends

  centre = cell(1, 1);
  const text = makeTextObject({ lines: [TEXT], font: "be-vietnam-pro", size: 7, color: "#333333", x: 0, y: 0 });
  text.frame = frame(centre, text.frame.w, text.frame.h);
  objects.push(text);
  expected.text = { left: centre[0] - text.frame.w / 2, baseline: centre[1] - text.frame.h / 2 + text.layout.lines[0].baseline, w: text.frame.w, h: text.frame.h, cx: centre[0], cy: centre[1] };

  centre = cell(2, 1);
  objects.push({ ...base("pen"), frame: frame(centre, 28, 12), points: [[0, 0.5], [1, 0.5]], color: COLORS.pen[0], width: 2, opacity: 1 });
  expected.pen = { cx: centre[0], cy: centre[1], w: 30, h: 2 };

  centre = cell(0, 2);
  const corners = [[centre[0] - 15, centre[1] - 8], [centre[0] + 15, centre[1] - 8], [centre[0] + 15, centre[1] + 8], [centre[0] - 15, centre[1] + 8]];
  objects.push({ ...base("highlight"), mode: "text", quads: [corners.flatMap(user)], color: COLORS.textHighlight[0] });
  expected.textHighlight = { cx: centre[0], cy: centre[1], w: 30, h: 16 };

  centre = cell(1, 2);
  objects.push({ ...base("highlight"), mode: "stroke", frame: frame(centre, 22, 10), points: [[0, 0.5], [1, 0.5]], thickness: 10, color: COLORS.strokeHighlight[0] });
  expected.strokeHighlight = { cx: centre[0], cy: centre[1], w: 32, h: 10 };

  centre = cell(2, 2);
  objects.push({ ...base("rect"), frame: frame(centre, 24, 12, 30), stroke: null, strokeWidth: 0, dash: "solid", fill: COLORS.turned[0], opacity: 1 });
  const turn = Math.PI / 6;
  expected.turned = { cx: centre[0], cy: centre[1], w: 24 * Math.cos(turn) + 12 * Math.sin(turn), h: 24 * Math.sin(turn) + 12 * Math.cos(turn) };

  return { objects, expected, size: [width, height] };
}

const geo = await buildGeometryFixture();
const scenes = geo.cases.map((entry) => sceneFor({ view: entry.view, rotate: entry.rotate, userUnit: entry.userUnit }));
const orangePng = (await import("./helpers/pdfTestKit.mjs")).makePng(4, 4, [255, 128, 0, 255]);
const geoJob = {
  sources: [{ id: "geo", bytes: geo.bytes, expectedPages: geo.cases.length }],
  pages: geo.cases.map((_, index) => ({ source: "geo", index, rotate: 0 })),
  objects: scenes.map((scene) => scene.objects),
  marks: [],
  assets: { orange: { bytes: orangePng, mime: "image/png" } },
  info: {},
  fileName: "geometry"
};
const geoOut = await assembleDocument(geoJob, OPTIONS);

test("INV-5 text: a text object is upright, at its size and at the place geometry.js gives, on all 16 page geometries", async () => {
  await withPdf(geoOut.bytes, async (doc) => {
    for (let index = 0; index < geo.cases.length; index += 1) {
      const label = geo.cases[index].name;
      const items = await screenTextItems(doc, index + 1, SCALE);
      const item = items.find((entry) => entry.str === TEXT);
      assert.ok(item, `${label}: the text is in the text layer`);
      const [a, b, c, d] = item.matrix;
      assert.ok(Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0 && d < 0, `${label}: not upright on screen: ${item.matrix.map((value) => value.toFixed(3))}`);
      assert.ok(Math.abs(item.height - 7 * SCALE) < 0.01, `${label}: ${item.height / SCALE} pt high on screen, expected 7 (sizes are points, also with a UserUnit)`);
      const want = scenes[index].expected.text;
      assert.ok(Math.abs(item.x - want.left * SCALE) < 0.05, `${label}: text starts at x ${item.x / SCALE}, expected ${want.left}`);
      assert.ok(Math.abs(item.y - want.baseline * SCALE) < 0.05, `${label}: baseline at y ${item.y / SCALE}, expected ${want.baseline}`);
    }
  });
});

test("INV-5 shapes: rect, ellipse, image, line, pen and both highlights land within 1.5 px of their place on all 16 page geometries", { skip: noCanvas }, async () => {
  const pages = await renderAll(geoOut.bytes, { scale: SCALE });
  geo.cases.forEach((entry, index) => {
    const image = pages[index];
    const { expected, size } = scenes[index];
    assert.ok(Math.abs(image.width - size[0] * SCALE) <= 1 && Math.abs(image.height - size[1] * SCALE) <= 1, `${entry.name}: visible size`);
    for (const [name, [, rgb]] of Object.entries(COLORS)) {
      const want = expected[name];
      const area = { x: (want.cx - want.w / 2 - 6) * SCALE, y: (want.cy - want.h / 2 - 6) * SCALE, w: (want.w + 12) * SCALE, h: (want.h + 12) * SCALE };
      const box = findColorBox(image, rgb, 40, area);
      assert.ok(box, `${entry.name}: ${name} not found near (${want.cx}, ${want.cy}) pt`);
      assert.ok(Math.abs(box.cx - want.cx * SCALE) <= 1.5 && Math.abs(box.cy - want.cy * SCALE) <= 1.5, `${entry.name}: ${name} centre (${box.cx / SCALE}, ${box.cy / SCALE}) pt, expected (${want.cx}, ${want.cy})`);
      assert.ok(Math.abs(box.w - want.w * SCALE) <= 2.5 && Math.abs(box.h - want.h * SCALE) <= 2.5, `${entry.name}: ${name} is ${box.w / SCALE} x ${box.h / SCALE} pt, expected ${want.w.toFixed(1)} x ${want.h.toFixed(1)}`);
    }
  });
});

test("INV-6 outside what was drawn not one pixel of the page differs from the source", { skip: noCanvas }, async () => {
  // Without the highlights: pdf.js renders a page that uses a blend mode through an intermediate canvas, which
  // moves single anti-aliased pixels of the page's own text by one grey level. That is the renderer, not the file.
  const opaque = await assembleDocument({ ...geoJob, objects: scenes.map((scene) => scene.objects.filter((object) => object.type !== "highlight")) }, OPTIONS);
  const [source, exact, full] = [await renderAll(geo.bytes, { scale: SCALE }), await renderAll(opaque.bytes, { scale: SCALE }), await renderAll(geoOut.bytes, { scale: SCALE })];
  geo.cases.forEach((entry, index) => {
    const exclude = Object.values(scenes[index].expected).map((want) => ({ x: Math.floor((want.cx - want.w / 2 - 3) * SCALE), y: Math.floor((want.cy - want.h / 2 - 3) * SCALE), w: Math.ceil((want.w + 6) * SCALE), h: Math.ceil((want.h + 6) * SCALE) }));
    assert.equal(differingPixels(source[index], exact[index], exclude), 0, `${entry.name}: ${firstDifference(source[index], exact[index], exclude)}`);
    assert.ok(differingPixels(source[index], exact[index]) > 500, `${entry.name}: the objects are there`);
    // with the highlights: the same within two levels per channel
    assert.equal(differingPixels(source[index], full[index], exclude, 2), 0, `${entry.name} with highlights: ${firstDifference(source[index], full[index], exclude, 2)}`);
  });
});

test("the page's own text survives on all 16 pages and the output is clean", async () => {
  const [before, after] = [await extractText(geo.bytes), await extractText(geoOut.bytes)];
  after.forEach((text, index) => assert.equal(squash(text).replace(squash(TEXT), ""), squash(before[index]), geo.cases[index].name));
  const facts = await fileFacts(geoOut.bytes);
  assert.deepEqual([facts.orphans, facts.audit, facts.redefined, facts.revisions], [[], [], [], 1]);
  assert.equal(geoOut.report.objectsDrawn, 16 * 9);
  assert.equal(geoOut.report.imagesEmbedded, 1, "one picture, embedded once for 16 pages");
  const images = facts.doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  assert.equal(images.length, 1);
});

// -----------------------------------------------------------------------------------------------------------
// text
// -----------------------------------------------------------------------------------------------------------

const VI = [
  "Hợp đồng dịch vụ số 12/2026: Nguyễn Văn An đã ký",
  "ẮẰẲẴẶ ẤẦẨẪẬ ẾỀỂỄỆ ỐỒỔỖỘ ỚỜỞỠỢ ỨỪỬỮỰ ỲÝỶỸỴ đĐ",
  "ắằẳẵặ ấầẩẫậ ếềểễệ ốồổỗộ ớờởỡợ ứừửữự ỳýỷỹỵ fi fl ffi"
];

test("Vietnamese text through a TextLayout is extracted exactly, measures what the layout says, and its fonts are subsets", async () => {
  const plain = makeTextObject({ id: "vi", lines: VI, font: "tinos", size: 13, x: 310, y: 300 });
  const styled = makeTextObject({ id: "styled", lines: ["Đậm nghiêng: Trần Thị Bích Ngọc"], font: "be-vietnam-pro", bold: true, italic: true, size: 16, color: "#b91c1c", x: 310, y: 200 });
  // a line whose arrows and Greek letters are not in the box font: real text in the fallback face
  const mixed = makeTextObject({ id: "mixed", lines: [[{ text: "Tiếng Việt ", font: "be-vietnam-pro-regular" }, { text: "→ αβγ", font: "arimo-regular" }]], font: "be-vietnam-pro", size: 12, x: 310, y: 120 });
  const { bytes, report } = await assembleDocument(blankJob([620, 400], [plain, styled, mixed]), OPTIONS);
  const [text] = await extractText(bytes);
  assert.deepEqual(text.split("\n").map((line) => line.trim()), [...VI, "Đậm nghiêng: Trần Thị Bích Ngọc", "Tiếng Việt → αβγ"]);
  assert.deepEqual(report.fontsEmbedded, ["tinos-regular", "be-vietnam-pro-bold-italic", "be-vietnam-pro-regular", "arimo-regular"]);

  // widths: what pdf.js measures in the file is what the layout promised
  await withPdf(bytes, async (doc) => {
    const items = await screenTextItems(doc, 1, 1);
    for (const [index, line] of plain.layout.lines.entries()) {
      const onLine = items.filter((item) => Math.abs(item.y - (400 - (plain.frame.y + plain.frame.h / 2) + line.baseline)) < 0.05);
      assert.ok(onLine.length > 0, `line ${index + 1}`);
      const start = Math.min(...onLine.map((item) => item.x));
      assert.ok(Math.abs(start - (plain.frame.x - plain.frame.w / 2)) < 0.01, `line ${index + 1} starts at the left edge of the box`);
    }
    const content = await (await doc.getPage(1)).getTextContent();
    const first = content.items.filter((item) => item.str && VI[0].startsWith(item.str.trim().slice(0, 6)) && item.str.length > 5);
    const drawnWidth = first.reduce((sum, item) => sum + item.width, 0);
    assert.ok(Math.abs(drawnWidth - plain.layout.lines[0].width) < 0.05, `advance in the file ${drawnWidth}, layout ${plain.layout.lines[0].width}`);
  });

  // every face: ONE resource name on the page, a tagged subset name, a font program far smaller than the file
  const doc = await loadPlain(bytes);
  const page = doc.getPage(0);
  assert.equal(resourceNames(page).Font.length, 4);
  const fonts = page.node.Resources().lookup(PDFName.of("Font"), PDFDict);
  const seen = [];
  for (const key of fonts.keys()) {
    const font = fonts.lookup(key, PDFDict);
    const baseFont = font.lookup(PDFName.of("BaseFont"), PDFName).decodeText();
    assert.match(baseFont, /^[A-Z]{6}\+[A-Za-z]+-[A-Za-z]+$/, baseFont);
    const descendant = font.lookup(PDFName.of("DescendantFonts")).lookup(0, PDFDict);
    const program = descendant.lookup(PDFName.of("FontDescriptor"), PDFDict).lookup(PDFName.of("FontFile2"), PDFStream);
    seen.push([baseFont.slice(7), program.contents.length]);
  }
  const fileSize = { "Tinos-Regular": fontBytes("tinos-regular").length, "BeVietnamPro-BoldItalic": fontBytes("be-vietnam-pro-bold-italic").length, "BeVietnamPro-Regular": fontBytes("be-vietnam-pro-regular").length, "Arimo-Regular": fontBytes("arimo-regular").length };
  for (const [name, size] of seen) assert.ok(size < fileSize[name] * 0.45, `${name}: ${size} bytes embedded of ${fileSize[name]}`);
  assert.deepEqual(seen.map(([name]) => name).sort(), Object.keys(fileSize).sort());
});

test("a text box turned by 30 degrees keeps its text and its angle", async () => {
  const turned = makeTextObject({ id: "turned", lines: ["Nghiêng ba mươi độ"], size: 14, x: 200, y: 150, rot: 30 });
  const { bytes } = await assembleDocument(blankJob([400, 300], [turned]), OPTIONS);
  assert.deepEqual(await extractText(bytes), ["Nghiêng ba mươi độ"]);
  await withPdf(bytes, async (doc) => {
    const [item] = await screenTextItems(doc, 1, 1);
    // counter-clockwise in user space = counter-clockwise for the reader of an unrotated page
    const angle = (Math.atan2(-item.matrix[1], item.matrix[0]) * 180) / Math.PI;
    assert.ok(Math.abs(angle - 30) < 0.01, `angle ${angle}`);
    assert.ok(Math.abs(item.height - 14) < 0.01);
  });
});

test("an underline is a bar per line from the font's metrics, or where the layout says", { skip: noCanvas }, async () => {
  const pageHeight = 200;
  const text = makeTextObject({ id: "u", lines: ["HHHH"], size: 40, underline: true, color: "#1d4ed8", frame: { x: 0, y: 0, rot: 0 } });
  text.frame = boxFrame(40, 30, text.frame.w, text.frame.h, pageHeight);
  const custom = makeTextObject({ id: "u2", lines: ["HHHH"], size: 40, underline: true, color: "#15803d", frame: { x: 0, y: 0, rot: 0 } });
  custom.frame = boxFrame(40, 110, custom.frame.w, custom.frame.h, pageHeight);
  custom.layout.underline = { offset: 9, thickness: 6 };
  const { bytes } = await assembleDocument(blankJob([300, pageHeight], [text, custom]), OPTIONS);
  const [image] = await renderAll(bytes, { scale: SCALE });
  const metrics = parsedFont("arimo-regular");
  const bar = underlineBar({ unitsPerEm: metrics.unitsPerEm, underlinePosition: metrics.underlinePosition, underlineThickness: metrics.underlineThickness }, 40);
  assert.ok(Math.abs(bar.offset - (217 / 2048) * 40) < 1e-9 && Math.abs(bar.thickness - (150 / 2048) * 40) < 1e-9, "Arimo: top of the bar 217 units below the baseline, 150 thick");
  const check = (object, top, offset, thickness, rgb) => {
    const line = object.layout.lines[0];
    const baseline = top + line.baseline;
    const middle = 40 + line.width / 2;
    near(pixelAt(image, middle * SCALE, (baseline + offset + thickness / 2) * SCALE), rgb, 6, "inside the bar");
    near(pixelAt(image, middle * SCALE, (baseline + offset - 1.2) * SCALE), [255, 255, 255], 6, "above the bar (between the letters and the line)");
    near(pixelAt(image, middle * SCALE, (baseline + offset + thickness + 1.2) * SCALE), [255, 255, 255], 6, "below the bar");
    near(pixelAt(image, (40 + 1) * SCALE, (baseline + offset + thickness / 2) * SCALE), rgb, 6, "the bar starts with the line");
    near(pixelAt(image, (40 + line.width - 1) * SCALE, (baseline + offset + thickness / 2) * SCALE), rgb, 6, "and ends with it");
    near(pixelAt(image, (40 + line.width + 2) * SCALE, (baseline + offset + thickness / 2) * SCALE), [255, 255, 255], 6, "not beyond");
  };
  check(text, 30, bar.offset, bar.thickness, [29, 78, 216]);
  check(custom, 110, 9, 6, [21, 128, 61]);
});

test("a rasterised text: its picture is drawn at the rectangle the layout gives, and nothing is written as text", async () => {
  const pageHeight = 200;
  const object = makeTextObject({ id: "raster", lines: ["漢字 không có trong phông"], size: 12, frame: { x: 0, y: 0, rot: 0 } });
  object.frame = boxFrame(60, 50, 120, 40, pageHeight);
  // the picture reaches beyond the box (ink above the first line): local points, y down
  object.layout = { width: 120, height: 40, lines: [], raster: { png: SAMPLE_PNG, x: -4, y: -6, w: 128, h: 64 }, problems: ["TEXT_RASTERIZED"] };
  const { bytes, report } = await assembleDocument(blankJob([300, pageHeight], [object]), OPTIONS);
  assert.deepEqual(await extractText(bytes), [""]);
  assert.deepEqual(report.fontsEmbedded, []);
  assert.equal(report.imagesEmbedded, 1);
  if (!canRender) return;
  const [image] = await renderAll(bytes, { scale: SCALE });
  const at = (u, v) => pixelAt(image, (60 - 4 + 128 * u) * SCALE, (50 - 6 + 64 * v) * SCALE);
  near(at(0.25, 0.25), SAMPLE_COLORS.topLeft, 8, "top-left quarter");
  near(at(0.75, 0.25), SAMPLE_COLORS.topRight, 8, "top-right quarter");
  near(at(0.25, 0.75), SAMPLE_COLORS.bottomLeft, 8, "bottom-left quarter");
  near(at(0.75, 0.75), SAMPLE_COLORS.bottomRight, 8, "bottom-right quarter");
  near(pixelAt(image, (60 - 4 - 2) * SCALE, 70 * SCALE), [255, 255, 255], 2, "nothing left of the picture");
});

// -----------------------------------------------------------------------------------------------------------
// shapes
// -----------------------------------------------------------------------------------------------------------

test("opacity is group opacity: a stroke over its fill, or a line under its head, does not get darker", { skip: noCanvas }, async () => {
  const pageHeight = 300;
  const rect = { ...base("rect"), frame: boxFrame(40, 40, 120, 80, pageHeight), stroke: "#0000ff", strokeWidth: 12, dash: "solid", fill: "#ff0000", opacity: 0.5 };
  const arrow = { ...base("line"), p1: [40, 100], p2: [200, 100], stroke: "#000000", strokeWidth: 8, dash: "solid", headStart: false, headEnd: true, opacity: 0.5 };
  const picture = { ...base("image"), frame: boxFrame(200, 40, 64, 32, pageHeight), assetId: "sample", role: "image", opacity: 0.4 };
  const text = makeTextObject({ id: "faint", lines: ["Mờ một nửa"], size: 20, underline: true, opacity: 0.5, frame: { x: 0, y: 0, rot: 0 } });
  text.frame = boxFrame(40, 230, text.frame.w, text.frame.h, pageHeight);
  const { bytes } = await assembleDocument(blankJob([300, pageHeight], [rect, arrow, picture, text], { assets: { sample: { bytes: SAMPLE_PNG, mime: "image/png" } } }), OPTIONS);
  const [image] = await renderAll(bytes, { scale: SCALE });
  near(pixelAt(image, 100 * SCALE, 80 * SCALE), [255, 128, 128], 3, "fill at 50 % over white");
  near(pixelAt(image, 100 * SCALE, 37 * SCALE), [128, 128, 255], 3, "outer half of the stroke");
  near(pixelAt(image, 100 * SCALE, 43 * SCALE), [128, 128, 255], 3, "inner half of the stroke: blue at 50 %, NOT blue over translucent red");
  // the arrow: the round cap of the shaft lies inside the head; with group opacity the head is one flat grey
  const head = arrowHeadSize(8);
  const baseX = 200 - head.length;
  near(pixelAt(image, (baseX + 2) * SCALE, (pageHeight - 100) * SCALE), [128, 128, 128], 3, "head over the end of the shaft");
  near(pixelAt(image, (baseX + head.length / 2) * SCALE, (pageHeight - 100) * SCALE), [128, 128, 128], 3, "head alone");
  near(pixelAt(image, 100 * SCALE, (pageHeight - 100) * SCALE), [128, 128, 128], 3, "shaft");
  // the picture at 40 %
  near(pixelAt(image, (200 + 16) * SCALE, (40 + 8) * SCALE), SAMPLE_COLORS.topLeft.map((value) => Math.round(255 - (255 - value) * 0.4)), 4, "image opacity");
  // structure: one transparency group per translucent object that has several parts; text inside is still text
  const doc = await loadPlain(bytes);
  const xobjects = doc.getPage(0).node.Resources().lookup(PDFName.of("XObject"), PDFDict);
  const groups = xobjects.keys().map((key) => xobjects.lookup(key, PDFStream)).filter((stream) => stream.dict.has(PDFName.of("Group")));
  assert.equal(groups.length, 3, "rect, arrow, text");
  for (const group of groups) assert.equal(String(group.dict.lookup(PDFName.of("Group"), PDFDict).get(PDFName.of("S"))), "/Transparency");
  assert.deepEqual(await extractText(bytes), ["Mờ một nửa"]);
});

test("dash patterns grow with the stroke width; shapes use round caps", async () => {
  const pageHeight = 200;
  const dashed = { ...base("rect"), frame: boxFrame(20, 20, 200, 60, pageHeight), stroke: "#000000", strokeWidth: 4, dash: "dashed", fill: null, opacity: 1 };
  const dotted = { ...base("ellipse"), frame: boxFrame(20, 110, 200, 60, pageHeight), stroke: "#000000", strokeWidth: 2, dash: "dotted", fill: null, opacity: 1 };
  const solid = { ...base("line"), p1: [240, 20], p2: [280, 20], stroke: "#000000", strokeWidth: 3, dash: "solid", headStart: false, headEnd: false, opacity: 1 };
  assert.deepEqual(dashPattern("dashed", 4), [8, 12]);
  assert.deepEqual(dashPattern("dotted", 2), [0.002, 4]);
  assert.equal(dashPattern("solid", 4), null);
  const { bytes } = await assembleDocument(blankJob([300, pageHeight], [dashed, dotted, solid]), OPTIONS);
  const content = pageContentText((await loadPlain(bytes)).getPage(0));
  // the outline starts at the top-left corner of the box and runs along its top edge, as an SVG <rect> does
  assert.match(content, /4 w\n1 J\n\[8 12\] 0 d\n0 60 m\n200 60 l\n200 0 l\n0 0 l\nh\nS/, "dashed rectangle");
  // ... and an ellipse from its rightmost point downwards, as an SVG <ellipse> does
  assert.match(content, /2 w\n1 J\n\[0\.002 4\] 0 d\n200 30 m\n200 13\.4\d* /, "dotted ellipse");
  assert.match(content, /3 w\n1 J\n0 0 m\n40 0 l\nS/, "a solid line has round caps and no dash");
  if (!canRender) return;
  const [image] = await renderAll(bytes, { scale: SCALE });
  // top edge of the rectangle (y = 20): dashes start at the corner x = 20: ink 18..30 (8 + caps), gap 30..38
  near(pixelAt(image, 24 * SCALE, 20 * SCALE), [0, 0, 0], 40, "inside the first dash");
  near(pixelAt(image, 34 * SCALE, 20 * SCALE), [255, 255, 255], 4, "inside the first gap");
  near(pixelAt(image, 44 * SCALE, 20 * SCALE), [0, 0, 0], 40, "inside the second dash");
  // the dotted ellipse: dots of the stroke width, every 4 pt along the outline, starting at its rightmost point
  near(pixelAt(image, 220 * SCALE, 140 * SCALE), [0, 0, 0], 90, "a dot at the start of the outline");
});

test("a line has round caps; an arrow head is a triangle whose tip is exactly the end point", { skip: noCanvas }, async () => {
  const pageHeight = 200;
  const y = (top) => pageHeight - top;
  const plain = { ...base("line"), p1: [50, y(30)], p2: [150, y(30)], stroke: "#000000", strokeWidth: 10, dash: "solid", headStart: false, headEnd: false, opacity: 1 };
  const arrow = { ...base("line"), p1: [50, y(70)], p2: [150, y(70)], stroke: "#000000", strokeWidth: 6, dash: "solid", headStart: false, headEnd: true, opacity: 1 };
  const both = { ...base("line"), p1: [50, y(110)], p2: [150, y(110)], stroke: "#000000", strokeWidth: 3, dash: "solid", headStart: true, headEnd: true, opacity: 1 };
  const tiny = { ...base("line"), p1: [50, y(150)], p2: [58, y(150)], stroke: "#000000", strokeWidth: 3, dash: "solid", headStart: false, headEnd: true, opacity: 1 };
  const dot = { ...base("line"), p1: [100, y(180)], p2: [100, y(180)], stroke: "#000000", strokeWidth: 8, dash: "solid", headStart: true, headEnd: true, opacity: 1 };
  const { bytes } = await assembleDocument(blankJob([200, pageHeight], [plain, arrow, both, tiny, dot]), OPTIONS);
  const [image] = await renderAll(bytes, { scale: SCALE });
  const inkBox = (top, halfHeight) => findColorBox(image, [0, 0, 0], 100, { x: 0, y: (top - halfHeight) * SCALE, w: 200 * SCALE, h: 2 * halfHeight * SCALE });
  const extent = (box) => [box.x / SCALE, (box.x + box.w) / SCALE];
  const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual}, expected ${expected}`);

  let [from, to] = extent(inkBox(30, 8));
  close(from, 45, 0.8, "round cap: half the width before the start point");
  close(to, 155, 0.8, "round cap: half the width beyond the end point");

  const head = arrowHeadSize(6);
  assert.deepEqual(head, { length: 24, width: 18 });
  let box = inkBox(70, 12);
  [from, to] = extent(box);
  close(from, 47, 0.8, "the tail keeps its round cap");
  close(to, 150, 1.3, "the tip is at the end point");
  assert.equal(findColorBox(image, [0, 0, 0], 200, { x: 150.6 * SCALE, y: 55 * SCALE, w: 30 * SCALE, h: 30 * SCALE }), null, "nothing is painted beyond the tip");
  close(box.h / SCALE, 18, 1.2, "the head is three quarters of its length wide");
  const base24 = findColorBox(image, [0, 0, 0], 100, { x: (150 - 24) * SCALE, y: 55 * SCALE, w: 2 * SCALE, h: 30 * SCALE });
  close(base24.h / SCALE, 18, 1.6, "widest at its base, 24 pt before the tip");

  [from, to] = extent(inkBox(110, 8));
  close(from, 50, 1.3, "a head at the start: its tip is the start point");
  close(to, 150, 1.3, "and one at the end");

  [from, to] = extent(inkBox(150, 8));
  close(from, 50, 0.8, "a line shorter than its head: the head alone, from the start point");
  close(to, 58, 1.3, "to the end point");

  box = inkBox(180, 8);
  close(box.w / SCALE, 8, 1, "both ends on one point: a dot as wide as the stroke");
  close(box.cx / SCALE, 100, 0.8, "centred on the point");
});

test("pen: a smooth curve through every sample; a single tap is a dot", { skip: noCanvas }, async () => {
  const pageHeight = 200;
  const samples = [[0, 0.5], [0.2, 0.05], [0.4, 0.95], [0.6, 0.05], [0.8, 0.95], [1, 0.5]];
  const pen = { ...base("pen"), frame: boxFrame(40, 40, 200, 80, pageHeight), points: samples, color: "#7c3aed", width: 4, opacity: 1 };
  const tap = { ...base("pen"), frame: boxFrame(40, 150, 0, 0, pageHeight), points: [[0, 0]], color: "#7c3aed", width: 10, opacity: 1 };
  const { bytes } = await assembleDocument(blankJob([300, pageHeight], [pen, tap]), OPTIONS);
  const [image] = await renderAll(bytes, { scale: SCALE });
  for (const [u, v] of samples) near(pixelAt(image, (40 + 200 * u) * SCALE, (40 + 80 * v) * SCALE), [124, 58, 237], 8, `ink at sample (${u}, ${v})`);
  const dot = findColorBox(image, [124, 58, 237], 60, { x: 20 * SCALE, y: 135 * SCALE, w: 40 * SCALE, h: 30 * SCALE });
  assert.ok(Math.abs(dot.w / SCALE - 10) <= 1 && Math.abs(dot.h / SCALE - 10) <= 1 && Math.abs(dot.cx / SCALE - 40) <= 0.8 && Math.abs(dot.cy / SCALE - 150) <= 0.8, JSON.stringify(dot));
  const content = pageContentText((await loadPlain(bytes)).getPage(0));
  assert.equal((content.match(/ c\n/g) || []).length, 5 + 4, "five Bezier segments for six samples (and four for the dot)");
  assert.match(content, /1 J\n1 j\n/, "round caps and round joins");
});

test("highlights multiply: the paper takes the colour, the ink stays dark, overlapping quads are painted once", async () => {
  const source = await makeTextPdf([{ lines: ["HIGHLIGHTED TEXT stays black", "second line"], size: [400, 200], fontSize: 16 }]);
  const highlight = { ...base("highlight"), mode: "text", quads: [[45, 160, 300, 160, 300, 135, 45, 135], [45, 140, 200, 140, 200, 112, 45, 112]], color: "#facc15" };
  const marker = { ...base("highlight"), mode: "stroke", frame: { x: 200, y: 60, w: 200, h: 20, rot: 0 }, points: [[0, 0.5], [0.5, 0.2], [1, 0.5]], thickness: 14, color: "#4ade80" };
  const job = {
    sources: [{ id: "s", bytes: source, expectedPages: 1 }], pages: [{ source: "s", index: 0, rotate: 0 }],
    objects: [[highlight, marker]], marks: [], assets: {}, info: {}, fileName: "highlight"
  };
  const { bytes } = await assembleDocument(job, OPTIONS);
  const doc = await loadPlain(bytes);
  const states = doc.getPage(0).node.Resources().lookup(PDFName.of("ExtGState"), PDFDict);
  assert.equal(states.keys().length, 1, "one graphics state for both highlights");
  const state = states.lookup(states.keys()[0], PDFDict);
  assert.equal(String(state.get(PDFName.of("BM"))), "/Multiply");
  assert.equal(state.lookup(PDFName.of("ca")).asNumber(), 1, "full strength: Multiply does the work, not transparency");
  assert.deepEqual(await extractText(bytes), ["HIGHLIGHTED TEXT stays black\nsecond line"], "the text under a highlight is untouched");
  if (!canRender) return;
  const [image] = await renderAll(bytes, { scale: SCALE });
  near(pixelAt(image, 290 * SCALE, (200 - 150) * SCALE), [250, 204, 21], 3, "paper under the highlight");
  near(pixelAt(image, 100 * SCALE, (200 - 137.5) * SCALE), [250, 204, 21], 3, "where the two quads overlap: multiplied ONCE");
  near(pixelAt(image, 190 * SCALE, (200 - 120) * SCALE), [250, 204, 21], 3, "second quad");
  const ink = findColorBox(image, [0, 0, 0], 45, { x: 45 * SCALE, y: (200 - 160) * SCALE, w: 255 * SCALE, h: 25 * SCALE });
  assert.ok(ink && ink.count > 200, "the letters under the highlight are still black");
  near(pixelAt(image, 150 * SCALE, (200 - 66) * SCALE), [74, 222, 128], 3, "the freehand marker");
});

test("images: PNG and JPEG, one XObject per asset however often it is used, a JPEG turned as its EXIF orientation asks", async () => {
  const pageHeight = 200;
  const image = (assetId, left, top, w, h) => ({ ...base("image"), frame: boxFrame(left, top, w, h, pageHeight), assetId, role: "image", opacity: 1 });
  const assets = {
    png: { bytes: SAMPLE_PNG, mime: "image/png" },
    jpeg: { bytes: SAMPLE_JPEG, mime: "image/jpeg" },
    turned: { bytes: withExifOrientation(SAMPLE_JPEG, 6), mime: "image/jpeg" },
    upsideDown: { bytes: withExifOrientation(SAMPLE_JPEG, 3), mime: "image/jpeg" },
    mislabelled: { bytes: SAMPLE_PNG, mime: "image/jpeg" } // the bytes decide, not the label
  };
  const first = [image("png", 20, 20, 64, 32), image("jpeg", 100, 20, 64, 32), image("turned", 180, 20, 32, 64), image("upsideDown", 230, 20, 64, 32), image("mislabelled", 20, 120, 64, 32)];
  const second = [image("png", 20, 20, 128, 64), image("jpeg", 20, 100, 32, 16)];
  const job = { sources: [], pages: [{ blank: [320, pageHeight], rotate: 0 }, { blank: [320, pageHeight], rotate: 0 }], objects: [first, second], marks: [], assets, info: {}, fileName: "images" };
  const { bytes, report } = await assembleDocument(job, OPTIONS);
  assert.equal(report.imagesEmbedded, 5);
  const doc = await loadPlain(bytes);
  const images = doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  assert.equal(images.length, 5, "seven image objects on two pages, five assets, five streams");
  assert.equal(resourceNames(doc.getPage(0)).XObject.length, 5);
  assert.equal(resourceNames(doc.getPage(1)).XObject.length, 2);
  assert.match(pageContentText(doc.getPage(0)), /0 -64 32 0 0 64 cm/, "orientation 6: the unit square of the image is turned");
  if (!canRender) return;
  const pages = await renderAll(bytes, { scale: SCALE });
  const quadrants = (page, left, top, w, h) => ({
    topLeft: pixelAt(page, (left + w * 0.25) * SCALE, (top + h * 0.25) * SCALE), topRight: pixelAt(page, (left + w * 0.75) * SCALE, (top + h * 0.25) * SCALE),
    bottomLeft: pixelAt(page, (left + w * 0.25) * SCALE, (top + h * 0.75) * SCALE), bottomRight: pixelAt(page, (left + w * 0.75) * SCALE, (top + h * 0.75) * SCALE)
  });
  const expectQuadrants = (actual, expected, tolerance, label) => {
    for (const key of Object.keys(expected)) near(actual[key], SAMPLE_COLORS[expected[key]], tolerance, `${label} ${key}`);
  };
  const upright = { topLeft: "topLeft", topRight: "topRight", bottomLeft: "bottomLeft", bottomRight: "bottomRight" };
  expectQuadrants(quadrants(pages[0], 20, 20, 64, 32), upright, 4, "PNG");
  expectQuadrants(quadrants(pages[0], 100, 20, 64, 32), upright, 14, "JPEG");
  // orientation 6: shown turned 90 degrees clockwise: the stored left edge is on top
  expectQuadrants(quadrants(pages[0], 180, 20, 32, 64), { topLeft: "bottomLeft", topRight: "topLeft", bottomLeft: "bottomRight", bottomRight: "topRight" }, 14, "JPEG orientation 6");
  expectQuadrants(quadrants(pages[0], 230, 20, 64, 32), { topLeft: "bottomRight", topRight: "bottomLeft", bottomLeft: "topRight", bottomRight: "topLeft" }, 14, "JPEG orientation 3");
  expectQuadrants(quadrants(pages[0], 20, 120, 64, 32), upright, 4, "PNG labelled as JPEG");
  expectQuadrants(quadrants(pages[1], 20, 20, 128, 64), upright, 4, "the same PNG on page 2");
});

// -----------------------------------------------------------------------------------------------------------
// underlays, drawOnDocument
// -----------------------------------------------------------------------------------------------------------

const fixture = await buildLinkedFixture();
const linkedJob = (objects) => ({
  sources: [{ id: "fx", bytes: fixture.bytes, expectedPages: 4 }],
  pages: [{ source: "fx", index: 0, rotate: 0 }, { source: "fx", index: 2, rotate: 0 }, { source: "fx", index: 0, rotate: 0 }],
  objects,
  marks: [], assets: {}, info: {}, fileName: "linked"
});
// fixture pages are 400 x 300: a replaced line (underlay + new text) on page 1, shapes on page 2
const replacement = () => {
  const text = makeTextObject({ id: "replacement", lines: ["Dòng chữ thay thế"], size: 16, color: "#111827", frame: { x: 0, y: 0, rot: 0 } });
  text.frame = boxFrame(30, 300 - 258, text.frame.w, text.frame.h, 300);
  return text;
};
const circle = () => ({ id: "circle", type: "ellipse", pageId: "p", frame: { x: 300, y: 80, w: 60, h: 40, rot: 0 }, stroke: "#dc2626", strokeWidth: 3, dash: "solid", fill: "#fef3c7", opacity: 1 });
const UNDERLAYS = [[{ rect: [26, 234, 240, 262], color: "#e0f2fe" }], [], []];
const OBJECTS = () => [[replacement()], [circle()], []];

test("underlays are painted below the objects and above the page content", { skip: noCanvas }, async () => {
  const { bytes } = await assembleDocument(linkedJob(OBJECTS()), { ...OPTIONS, underlays: UNDERLAYS });
  const [page] = await renderAll(bytes, { scale: SCALE, annotations: false });
  // the cover hides the original line "XREF-P1-MARKER" (16 pt text at y = 240) ...
  near(pixelAt(page, 235 * SCALE, (300 - 250) * SCALE), [224, 242, 254], 2, "the cover, right of the new text");
  const original = await renderAll(fixture.bytes, { scale: SCALE, annotations: false });
  const inkBefore = findColorBox(original[0], [0, 0, 0], 60, { x: 26 * SCALE, y: (300 - 262) * SCALE, w: 214 * SCALE, h: 28 * SCALE });
  assert.ok(inkBefore && inkBefore.w / SCALE > 120, "the original line was there");
  // ... and the new text is on top of the cover
  const inkAfter = findColorBox(page, [17, 24, 39], 50, { x: 26 * SCALE, y: (300 - 262) * SCALE, w: 214 * SCALE, h: 28 * SCALE });
  assert.ok(inkAfter && Math.abs(inkAfter.x / SCALE - 30) < 3, "the replacement text starts at the left edge of its box");
  assert.ok(squash((await extractText(bytes))[0]).includes(squash("Dòng chữ thay thế")));
  // NOTE: a cover hides, it does not remove: the original text is still in the file (removal is the redaction engine's job)
  assert.ok(squash((await extractText(bytes))[0]).includes(MARKERS.page[0]));
});

test("draw: false assembles the pages only; drawOnDocument then gives the same pages as drawing in one pass", async () => {
  const onePass = await assembleDocument(linkedJob(OBJECTS()), { ...OPTIONS, underlays: UNDERLAYS });
  const pagesOnly = await assembleDocument(linkedJob(OBJECTS()), { ...OPTIONS, underlays: UNDERLAYS, draw: false });
  assert.deepEqual(pagesOnly.report.fontsEmbedded, []);
  assert.equal(pagesOnly.report.objectsDrawn, 0);
  assert.ok(!squash((await extractText(pagesOnly.bytes))[0]).includes(squash("Dòng chữ thay thế")));
  const twoPass = await drawOnDocument(pagesOnly.bytes, OBJECTS(), { fonts: loadFont, underlays: UNDERLAYS });
  assert.deepEqual(await extractText(twoPass.bytes), await extractText(onePass.bytes));
  assert.deepEqual(twoPass.report.fontsEmbedded, ["arimo-regular"]);
  assert.equal(twoPass.report.objectsDrawn, 2);
  if (canRender) {
    const [a, b] = [await renderAll(onePass.bytes, { scale: SCALE }), await renderAll(twoPass.bytes, { scale: SCALE })];
    a.forEach((page, index) => assert.equal(differingPixels(page, b[index]), 0, `page ${index + 1}`));
  }
});

test("drawOnDocument changes nothing but what it draws: pixels elsewhere, outline, links, forms, labels, metadata, /ID", async () => {
  const before = await assembleDocument(linkedJob([[], [], []]), OPTIONS);
  const after = await drawOnDocument(before.bytes, OBJECTS(), { fonts: loadFont, underlays: UNDERLAYS });
  const again = await drawOnDocument(before.bytes, OBJECTS(), { fonts: loadFont, underlays: UNDERLAYS });
  assert.equal(Buffer.compare(Buffer.from(after.bytes), Buffer.from(again.bytes)), 0, "deterministic");

  assert.deepEqual(await outlineOf(after.bytes), await outlineOf(before.bytes));
  assert.deepEqual(await linkTargets(after.bytes), await linkTargets(before.bytes));
  assert.deepEqual(await annotationCensus(after.bytes), await annotationCensus(before.bytes));
  const describe = (bytes) => withPdf(bytes, async (doc) => {
    const { info, metadata } = await doc.getMetadata();
    const fields = await doc.getFieldObjects();
    const config = await doc.getOptionalContentConfig();
    return {
      info, title: metadata.get("dc:title"), labels: await doc.getPageLabels(), fingerprints: doc.fingerprints, mode: await doc.getPageMode(),
      fields: Object.entries(fields instanceof Map ? Object.fromEntries(fields) : fields).map(([name, list]) => [name, list.map((field) => `${field.type}|${field.value}|${field.page}`)]),
      layers: [...config].map(([, group]) => [group.name, group.visible])
    };
  });
  assert.deepEqual(await describe(after.bytes), await describe(before.bytes));

  const facts = await fileFacts(after.bytes);
  assert.deepEqual([facts.orphans, facts.audit, facts.redefined, facts.revisions, facts.encrypted], [[], [], [], 1, false]);
  assert.equal(facts.id, (await fileFacts(before.bytes)).id);
  const texts = [await extractText(before.bytes), await extractText(after.bytes)];
  assert.equal(squash(texts[1][0]).replace(squash("Dòng chữ thay thế"), ""), squash(texts[0][0]));
  assert.deepEqual(texts[1].slice(1), texts[0].slice(1));
  if (!canRender) return;
  const [a, b] = [await renderAll(before.bytes, { scale: SCALE }), await renderAll(after.bytes, { scale: SCALE })];
  // page 1: the cover (26..240 x 234..262 in user space); page 2: the ellipse with its stroke; page 3: nothing
  assert.equal(differingPixels(a[0], b[0], [{ x: 24 * SCALE, y: (300 - 264) * SCALE, w: 218 * SCALE, h: 32 * SCALE }]), 0, "page 1 outside the cover");
  assert.ok(differingPixels(a[0], b[0]) > 1000);
  assert.equal(differingPixels(a[1], b[1], [{ x: 266 * SCALE, y: (300 - 104) * SCALE, w: 68 * SCALE, h: 48 * SCALE }]), 0, "page 2 outside the ellipse");
  assert.equal(differingPixels(a[2], b[2]), 0, "page 3 is untouched");
});

test("an object that lies under an annotation of the source page is reported (viewers paint annotations on top)", async () => {
  // fixture page 1: a note icon at [340 250 360 270], form widgets, links (links paint nothing)
  const overNote = { id: "overNote", type: "rect", pageId: "p", frame: { x: 350, y: 260, w: 40, h: 30, rot: 0 }, stroke: null, strokeWidth: 0, dash: "solid", fill: "#000000", opacity: 1 };
  const overLink = { id: "overLink", type: "rect", pageId: "p", frame: { x: 60, y: 207, w: 40, h: 10, rot: 0 }, stroke: null, strokeWidth: 0, dash: "solid", fill: "#000000", opacity: 1 };
  // a pale box over the form field "only1" at [30 100 180 118], whose appearance shows its value
  const overField = { id: "overField", type: "rect", pageId: "p", frame: { x: 105, y: 109, w: 156, h: 24, rot: 0 }, stroke: null, strokeWidth: 0, dash: "solid", fill: "#fef9c3", opacity: 1 };
  const free = { id: "free", type: "rect", pageId: "p", frame: { x: 300, y: 30, w: 20, h: 20, rot: 0 }, stroke: null, strokeWidth: 0, dash: "solid", fill: "#000000", opacity: 1 };
  const { bytes, report } = await assembleDocument(linkedJob([[overNote, overLink, overField, free], [], []]), OPTIONS);
  assert.deepEqual(report.warnings.filter((warning) => warning.code === "EXPORT_OBJECT_BELOW_ANNOTATION"), [
    { code: "EXPORT_OBJECT_BELOW_ANNOTATION", params: { page: 0, objectId: "overNote", subtype: "Text" } },
    { code: "EXPORT_OBJECT_BELOW_ANNOTATION", params: { page: 0, objectId: "overField", subtype: "Widget" } }
  ]);
  if (!canRender) return;
  await withPdf(bytes, async (doc) => {
    const content = await renderToPixels(doc, 1, { scale: SCALE, annotations: false });
    const shown = await renderToPixels(doc, 1, { scale: SCALE, annotations: true });
    const area = { x: 30 * SCALE, y: (300 - 118) * SCALE, w: 150 * SCALE, h: 18 * SCALE };
    assert.equal(findColorBox(content, [0, 0, 0], 80, area), null, "in the page content the box covers the place of the field");
    assert.ok(findColorBox(shown, [0, 0, 0], 80, area).count > 50, "with annotations painted, the value of the field shows ABOVE the box");
  });
});
