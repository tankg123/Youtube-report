// The raster path (engine/redact/rasterizePage.js) and the mosaic (blur.js): a page becomes a picture with
// the regions burned in and an invisible text layer where its text was.
import { createCipheriv, createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { redactPdf } from "../src/pages/pdfEditor/engine/redact/index.js";
import { BLUR_DEFAULTS, blurRegion, obscureRegion, pixelateRegion } from "../src/pages/pdfEditor/engine/redact/blur.js";
import * as blurApi from "../src/pages/pdfEditor/engine/redact/blur.js";
import { buildTextLayer, burnRegions, imageXObjectFromCanvas, imageXObjectFromRgba, makeTtfLayerFont, predictRgbRows } from "../src/pages/pdfEditor/engine/redact/rasterizePage.js";
import { verifyRasterPage } from "../src/pages/pdfEditor/engine/redact/verifyRedaction.js";
import { VIETNAMESE_SAMPLE, canRender, canvasLib, closePdf, fontBytes, fontkit, makeTextPdf, openPdf, pdfLib, squash } from "./helpers/pdfTestKit.mjs";
import { A, boxOf, load, makePdf, pageGeometries, pageTextOf, redactEnv, seededRandom, snap } from "./helpers/pdfRedactKit.mjs";

const needCanvas = { skip: !canRender && "no canvas binary on this platform" };
const createCanvas = (w, h) => canvasLib.createCanvas(w, h);

/** Pages whose geometry a picture must reproduce: /Rotate, a CropBox, a shifted MediaBox, /UserUnit. */
async function geometryPdf() {
  const line = (label, x, y) => `BT /F1 12 Tf ${x} ${y} Td (${label} GEOMETRY-SECRET here) Tj 0 -30 Td (${label} second line kept) Tj 0 -30 Td (${label} third line kept) Tj ET`;
  const { bytes } = await makePdf([
    { content: line("rotate ninety", 100, 600), extra: { Rotate: 90 } },
    { content: line("rotate one eighty", 100, 600), extra: { Rotate: 180 } },
    { content: line("cropped", 100, 600), extra: { CropBox: [50, 60, 500, 700] } },
    { content: line("shifted box", 0, 600), extra: { MediaBox: [-100, -50, 512, 742] } },
    { content: line("user unit two", 60, 300), size: [306, 396], extra: { UserUnit: 2, Rotate: 270 } }
  ]);
  return bytes;
}

test("the raster path keeps the page geometry and rebuilds the text layer in place", needCanvas, async () => {
  const bytes = await geometryPdf();
  const targets = [];
  for (let pageIndex = 0; pageIndex < 5; pageIndex++) targets.push({ pageIndex, rect: await boxOf(bytes, "GEOMETRY-SECRET", { page: pageIndex, pad: 0.5 }), mode: "redact" });
  const { bytes: out, report } = await redactPdf(bytes, targets, redactEnv({ path: "raster" }));
  assert.deepEqual(await pageGeometries(out), await pageGeometries(bytes)); // boxes, /Rotate and /UserUnit are untouched
  assert.deepEqual((await pageGeometries(out)).map((g) => [g.rotate, g.userUnit]), [[90, 1], [180, 1], [0, 1], [0, 1], [270, 2]]);
  for (const page of report.pages) {
    assert.equal(page.path, "raster");
    assert.equal(page.ok, true);
    const before = await snap(bytes, page.pageIndex);
    const after = await snap(out, page.pageIndex);
    const rects = targets.filter((t) => t.pageIndex === page.pageIndex).map((t) => t.rect);
    const v = verifyRasterPage(before, after, rects);
    assert.equal(v.ok, true, JSON.stringify(v.failures));
    // every text item that did not touch a target is back, with the same text, within a point of its place
    assert.equal(v.stats.layerItemsAligned, v.stats.layerItemsExpected, `page ${page.pageIndex + 1}: ${JSON.stringify(v.stats)}`);
    assert.ok(v.stats.layerItemsExpected >= 2);
    assert.ok(v.stats.layerMaxOffset <= 1, `offset ${v.stats.layerMaxOffset}`);
    assert.ok(after.glyphs.every((g) => g.invisible), "the layer must be drawn in rendering mode 3");
    assert.ok(page.verification.regions.every((r) => r.expect === "painted" && r.ok));
    assert.ok(!(await pageTextOf(out, page.pageIndex)).includes("GEOMETRY-SECRET"));
  }
  // the picture has the resolution asked for (200 dpi of the visible box, /UserUnit counted), in user-space orientation
  assert.deepEqual(report.pages.map((page) => page.stats.pixels), [[1700, 2200], [1700, 2200], [1250, 1778], [1700, 2200], [1700, 2200]]);
  // a lower resolution and the pixel budget are honoured
  const small = await redactPdf(bytes, targets.slice(0, 1), redactEnv({ path: "raster", dpi: 72 }));
  assert.deepEqual(small.report.pages[0].stats.pixels, [612, 792]);
  const capped = await redactPdf(bytes, targets.slice(0, 1), redactEnv({ path: "raster", maxPixels: 100000 }));
  assert.ok(capped.report.pages[0].stats.pixels[0] * capped.report.pages[0].stats.pixels[1] <= 100500);
});

test("the text layer of a Vietnamese page reads the same as the original text around the mark", needCanvas, async () => {
  const lines = [VIETNAMESE_SAMPLE, "Bên A: Công ty TNHH Truyền thông Số", "Giá trị hợp đồng: 125.000.000 đồng (chưa VAT)"];
  const bytes = await makeTextPdf([{ lines }]);
  const rect = await boxOf(bytes, "125.000.000", { pad: 0.5 });
  const { bytes: out, report } = await redactPdf(bytes, [{ pageIndex: 0, rect, mode: "redact" }], redactEnv({ path: "raster" }));
  const text = await pageTextOf(out);
  assert.ok(text.includes(squash(lines[0])) && text.includes(squash(lines[1])), text);
  assert.ok(text.includes(squash("Giá trị hợp đồng:")) && text.includes(squash("đồng (chưa VAT)")) && !text.includes("125.000.000"), text);
  assert.equal(report.pages[0].stats.layer.unencodable, 0);
  assert.deepEqual(report.warnings, []);
});

test("buildTextLayer: fragments per word, glyphs in a target and annotation text left out", async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (alpha beta gamma) Tj 0 -20 Td [(kerned) -400 (apart)] TJ ET" }]);
  const before = await snap(bytes);
  const font = { ref: null, canEncode: (ch) => ch !== "g", encode: (t) => `(${t})`, width: (t) => t.length * 0.5 };
  const beta = before.glyphs.slice(6, 10);
  const rect = [beta[0].quad[0], beta[0].quad[1], beta[3].quad[2], beta[0].quad[7]];
  const { content, stats } = buildTextLayer(before.glyphs, [rect], font);
  const words = [...content.matchAll(/\(([\w ]+)\) Tj/g)].map((m) => m[1]);
  // "beta" is in the target, "g" cannot be encoded; the space after a word is the last character of its fragment
  assert.deepEqual(words, ["alpha ", "amma", "kerned", "apart"]);
  assert.equal(stats.dropped, 4);
  assert.equal(stats.unencodable, 1);
  assert.match(content, /^q\n3 Tr\n/);
  // the first fragment starts at the origin of its first glyph and is stretched to its measured width
  const m = /BT \/RLayer 12 Tf ([\d.]+) Tz 1 0 0 1 72 700 Tm \(alpha \) Tj ET/.exec(content);
  assert.ok(m, content);
  const alphaWidth = before.glyphs[6].origin[0] - before.glyphs[0].origin[0]; // up to where "beta" started
  assert.ok(Math.abs((Number(m[1]) / 100) * 6 * 0.5 * 12 - alphaWidth) < 0.01);
  // glyphs of annotation appearances are counted, not written
  const annotated = before.glyphs.map((g, i) => (i < 5 ? { ...g, inAnnotation: true } : g));
  const second = buildTextLayer(annotated, [], font);
  assert.equal(second.stats.annotationGlyphs, 5);
  assert.ok(!second.content.includes("(alpha"));
  // nothing to write: no content at all
  assert.equal(buildTextLayer([], [], font).content, "");
});

test("the layer font is the bundled face, embedded as a subset with the editor's font rules", async () => {
  const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const layerFont = await makeTtfLayerFont(doc, fontBytes("arimo-regular"));
  assert.equal(layerFont.canEncode("ễ"), true);
  assert.equal(layerFont.canEncode(String.fromCodePoint(0x4e2d)), false);
  assert.match(layerFont.encode("Nguyễn"), /^<[0-9A-F]{24}>$/); // six glyphs, two bytes each: no ligature, no reordering
  assert.ok(Math.abs(layerFont.width("fi") - (layerFont.width("f") + layerFont.width("i"))) < 1e-9, "one advance per character");
});

test("burnRegions: mosaics first, then the cover of erased lines, then the boxes; the paper colour is sampled", needCanvas, () => {
  const canvas = createCanvas(200, 100);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f0e8d0"; // tinted paper
  ctx.fillRect(0, 0, 200, 100);
  ctx.fillStyle = "#101010";
  for (let x = 4; x < 196; x += 6) ctx.fillRect(x, 20, 2, 60); // strokes
  // a viewport that maps user space 1:1 onto the pixels, y up
  const viewport = { convertToViewportPoint: (x, y) => [x, 100 - y] };
  const render = { canvas, ctx, viewport, width: 200, height: 100, dpi: 72 };
  const regions = [
    { rect: [0, 0, 60, 100], mode: "redact", color: [200, 0, 0] },
    { rect: [40, 10, 120, 90], mode: "pixelate", strength: 1 },
    { rect: [100, 30, 180, 70], mode: "erase", color: null },
    { rect: [150, 0, 200, 20], mode: "erase", color: [0, 0, 255] }
  ];
  const done = burnRegions(render, regions, { random: seededRandom(9) });
  assert.deepEqual(done.map((d) => d.mode), ["pixelate", "erase", "erase", "redact"]);
  const pixel = (x, yUp) => [...ctx.getImageData(x, 100 - yUp, 1, 1).data.slice(0, 3)];
  assert.deepEqual(pixel(30, 50), [200, 0, 0]);
  assert.deepEqual(pixel(50, 50), [200, 0, 0], "the box wins over the mosaic it overlaps");
  assert.deepEqual(pixel(60, 50), [200, 0, 0], "boxes are grown by one pixel");
  assert.notDeepEqual(pixel(61, 50), [200, 0, 0], "... and by no more");
  // the erased region is covered with the paper colour that was sampled BEFORE anything was burned
  assert.deepEqual(done[1].color, [240, 232, 208]);
  assert.deepEqual(pixel(140, 50), [240, 232, 208]);
  assert.deepEqual(pixel(110, 50), [240, 232, 208], "the cover wins over the mosaic it overlaps");
  assert.deepEqual(pixel(170, 10), [0, 0, 255], "a cover colour that was given is used as it is");
  // the mosaic left no stroke: its pixels are block means, far from the ink
  const mosaic = ctx.getImageData(70, 20, 25, 60).data;
  for (let i = 0; i < mosaic.length; i += 4) assert.ok(mosaic[i] > 60, `a stroke survived in the mosaic (${mosaic[i]})`);
  assert.deepEqual([pixel(193, 50), pixel(190, 50)], [[240, 232, 208], [16, 16, 16]], "outside the regions nothing changed");
});

test("pixelate: every block is the mean of its pixels; noise and quantisation need a random source", () => {
  const w = 8;
  const h = 4;
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < w * h; i++) img.data.set([i * 4, i * 4, i * 4, 255], i * 4);
  const copy = { data: img.data.slice(), width: w, height: h };
  const info = pixelateRegion(img, 0, 0, 8, 4, { block: 4 });
  assert.equal(info.blocks, 2);
  const mean = (x0) => {
    let s = 0;
    for (let y = 0; y < 4; y++) for (let x = x0; x < x0 + 4; x++) s += copy.data[(y * w + x) * 4];
    return Math.round(s / 16);
  };
  assert.equal(img.data[0], mean(0));
  assert.equal(img.data[(3 * w + 7) * 4], mean(4));
  assert.equal(new Set(img.data.filter((_, i) => i % 4 === 0)).size, 2);
  // a region inside a bigger picture: nothing outside changes
  const big = { data: new Uint8ClampedArray(10 * 10 * 4).fill(200), width: 10, height: 10 };
  for (let i = 0; i < 100; i++) big.data[i * 4] = i;
  const outside = big.data.slice();
  pixelateRegion(big, 2, 2, 4, 4, { block: 2 });
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (x < 2 || x >= 6 || y < 2 || y >= 6) assert.equal(big.data[(y * 10 + x) * 4], outside[(y * 10 + x) * 4]);
  // with a random source the same input gives different pictures, and only `levels` values per channel
  const a = { data: copy.data.slice(), width: w, height: h };
  const b = { data: copy.data.slice(), width: w, height: h };
  const rnd = seededRandom(1);
  pixelateRegion(a, 0, 0, 8, 4, { block: 2, levels: 4, noise: 60, random: rnd });
  pixelateRegion(b, 0, 0, 8, 4, { block: 2, levels: 4, noise: 60, random: rnd });
  assert.notDeepEqual(a.data, b.data);
  assert.ok([...a.data].filter((_, i) => i % 4 === 0).every((v) => [0, 85, 170, 255].includes(v)));
});

test("blur and obscureRegion: the block follows the measured rule, and nothing weaker than the default can be asked for", () => {
  const w = 40;
  const h = 20;
  const img = { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h };
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) img.data.set([0, 0, 0, 255], (y * w + x) * 4);
  const before = img.data.slice();
  blurRegion(img, 5, 5, 30, 10, { sigma: 4 });
  const px = (x, y) => img.data[(y * w + x) * 4];
  assert.ok(px(19, 10) > 60 && px(19, 10) < 200); // the edge became a ramp
  assert.ok(px(6, 10) < 40 && px(33, 10) > 215);
  assert.equal(px(2, 2), before[(2 * w + 2) * 4]);
  assert.equal(px(38, 18), 255);
  const fresh = () => ({ data: new Uint8ClampedArray(400 * 60 * 4).fill(255), width: 400, height: 60 });
  const block = (options) => obscureRegion(fresh(), 0, 0, 400, 60, { random: seededRandom(1), ...options }).block;
  // (rewritten after the review: this test pinned max(12 pt, HALF the region height), the rule the reviewer's
  // attack read a number out of. The figures behind the rule that is pinned now are in the header of blur.js)
  // block = the largest of 12 pt, TWICE the region height and 2.25 x the font size under the region, x strength
  assert.deepEqual(BLUR_DEFAULTS, { blockRatio: 2, emRatio: 2.25, minBlockPt: 12, levels: 8, noise: 24, smoothRatio: 0.5, strengths: [1, 2, 3] });
  assert.equal(block({ pxPerPt: 2 }), 120); // 60 px high: twice of it beats 12 pt = 24 px
  assert.equal(block({ pxPerPt: 12 }), 144); // 12 pt = 144 px beats twice the height
  assert.equal(block({ pxPerPt: 2, emPt: 40 }), 180); // text of 40 pt under a low mark: 2.25 x 40 pt = 90 pt
  assert.equal(block({ pxPerPt: 2, emPt: 20 }), 120); // ... of 20 pt: 45 pt = 90 px, the height rule is larger
  assert.deepEqual(BLUR_DEFAULTS.strengths.map((strength) => block({ pxPerPt: 2, strength })), [120, 240, 360]);
  // weaker than the default is not offered: a strength below 1, or nonsense, is the default
  assert.deepEqual([0, 0.2, -3, NaN, undefined].map((strength) => block({ pxPerPt: 2, strength })), [120, 120, 120, 120, 120]);
  assert.deepEqual([-5, NaN, Infinity, undefined].map((emPt) => block({ pxPerPt: 2, emPt })), [120, 120, 120, 120]);
  // the rule as a function (what the engine, the tests and the attack measurement share)
  assert.equal(blurApi.mosaicBlock({ boxHeightPx: 60, pxPerPt: 2 }), 120);
  assert.equal(blurApi.mosaicBlock({ boxHeightPx: 6, pxPerPt: 150 / 72, strength: 2, emPt: 12 }), Math.round(2.25 * 12 * (150 / 72) * 2));
  assert.equal(blurApi.mosaicBlock({ boxHeightPx: 1, pxPerPt: 0.01 }), 2);
  // on a page that is shown turned by 90 degrees the line height is the width of the region
  const tall = () => ({ data: new Uint8ClampedArray(60 * 400 * 4).fill(255), width: 60, height: 400 });
  assert.equal(obscureRegion(tall(), 0, 0, 60, 400, { pxPerPt: 2, sideways: true, random: seededRandom(1) }).block, 120);
  assert.equal(obscureRegion(tall(), 0, 0, 60, 400, { pxPerPt: 2, random: seededRandom(1) }).block, 800);
  // the noise cannot be switched off through obscureRegion: `random: null` falls back to the platform CSPRNG
  const text = () => {
    const image = fresh();
    for (let x = 10; x < 390; x += 9) for (let y = 10; y < 50; y++) image.data.set([0, 0, 0, 255], (y * 400 + x) * 4);
    return image;
  };
  const pictures = new Set();
  for (let k = 0; k < 12; k++) {
    const image = text();
    obscureRegion(image, 0, 0, 400, 60, { pxPerPt: 2, random: null });
    pictures.add(Buffer.from(image.data).toString("base64"));
    // 8 levels per channel survive
    const levels = new Set(image.data.filter((_, i) => i % 4 === 0));
    assert.ok(levels.size <= 8 && [...levels].every((v) => [0, 36, 73, 109, 146, 182, 219, 255].includes(v)), [...levels].join(" "));
  }
  assert.ok(pictures.size > 6, `twelve mosaics of one picture without a seed: ${pictures.size} different ones`);
});

test("the key stream of a seeded mosaic: a cipher stream keyed with the seed, started by the context, the same in every export", async () => {
  const seed = "000102030405060708090a0b0c0d0e0f";
  const context = "10.000 20.000 110.000 40.000|1";
  const stream = await blurApi.mosaicKeyStream(seed, context, 16);
  // the known answer, computed with node:crypto: AES-128 in counter mode, the seed as the key, the first 16
  // bytes of SHA-256 of the labelled context as the counter, over zero bytes
  const counter = createHash("sha256").update(`pdf-editor/redact/mosaic/1|${context}`).digest().subarray(0, 16);
  const expected = createCipheriv("aes-128-ctr", Buffer.from(seed, "hex"), counter).update(Buffer.alloc(64));
  assert.equal(Buffer.from(stream).toString("hex"), expected.toString("hex"));
  // asking for more numbers continues the same stream: the size of a grid never changes the first blocks
  const longer = await blurApi.mosaicKeyStream(seed, context, 500);
  assert.equal(longer.length, 2000);
  assert.equal(Buffer.from(longer.subarray(0, 64)).toString("hex"), expected.toString("hex"));
  // another rectangle, another strength, another seed: unrelated streams (the same noise on another grid could be subtracted)
  const others = await Promise.all([blurApi.mosaicKeyStream(seed, "10.000 20.000 110.000 41.000|1", 16), blurApi.mosaicKeyStream(seed, "10.000 20.000 110.000 40.000|2", 16), blurApi.mosaicKeyStream("0f0e0d0c0b0a09080706050403020100", context, 16)]);
  assert.equal(new Set([stream, ...others].map((bytes) => Buffer.from(bytes).toString("hex"))).size, 4);
  assert.equal(Buffer.from(await blurApi.mosaicKeyStream(seed.toUpperCase(), context, 16)).toString("hex"), expected.toString("hex"), "the spelling of the seed does not matter");
  // the reader: numbers in [0, 1), from the start for every reader, and never past the end
  const read = blurApi.keyStreamReader(stream);
  const numbers = Array.from({ length: 16 }, () => read());
  assert.ok(numbers.every((v) => v >= 0 && v < 1) && new Set(numbers).size === 16);
  assert.equal(numbers[0], expected.readUInt32BE(0) / 4294967296);
  assert.throws(() => read(), RangeError);
  assert.equal(blurApi.keyStreamReader(stream)(), numbers[0]);
  // what is a seed
  assert.deepEqual(["00112233445566778899aabbccddeeff", "00112233445566778899AABBCCDDEEFF", "0011", "00112233445566778899aabbccddeefg", "", null, undefined, 5, "00112233445566778899aabbccddeeff00"].map(blurApi.isSeed), [true, true, false, false, false, false, false, false, false]);
  await assert.rejects(blurApi.mosaicKeyStream("nonsense", context, 16), TypeError);
  // mosaicDraws: never fewer numbers than the largest grid of the smallest blocks draws
  for (const [widthPt, heightPt, pxPerPt] of [[100, 20, 150 / 72], [3, 3, 2], [612, 792, 200 / 72], [47.3, 11.9, 1]]) {
    let drawn = 0;
    const image = { data: new Uint8ClampedArray(Math.ceil(widthPt * pxPerPt) * Math.ceil(heightPt * pxPerPt) * 4), width: Math.ceil(widthPt * pxPerPt), height: Math.ceil(heightPt * pxPerPt) };
    pixelateRegion(image, 0, 0, image.width, image.height, { block: Math.round(BLUR_DEFAULTS.minBlockPt * pxPerPt), levels: 8, noise: 24, random: () => (drawn++, 0.999) });
    assert.ok(drawn <= blurApi.mosaicDraws(widthPt, heightPt), `${widthPt} x ${heightPt} pt at ${pxPerPt} px/pt drew ${drawn} numbers, ${blurApi.mosaicDraws(widthPt, heightPt)} were reserved`);
  }
  // a platform without WebCrypto cannot keep the promise of a seed: refused with a code, not replaced by Math.random
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (array) => array }, configurable: true });
    await assert.rejects(blurApi.mosaicKeyStream(seed, context, 16), (error) => error.code === "REDACT_ENV_INVALID" && error.params.missing === "random");
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

test("burnRegions: a mosaic is made of the mark together with the glyphs it takes, and shown inside the mark only", needCanvas, () => {
  const make = () => {
    const canvas = createCanvas(200, 100);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 200, 100);
    ctx.fillStyle = "#000000";
    ctx.fillRect(20, 20, 160, 40); // a band of ink: the "glyphs" (pixel rows 20 .. 59)
    return { canvas, ctx, viewport: { convertToViewportPoint: (x, y) => [x, 100 - y] }, width: 200, height: 100, dpi: 72 };
  };
  const mark = [20, 30, 180, 40]; // user space: pixel rows 60 .. 69, white paper just below the band
  const source = [20, 30, 180, 80]; // the mark grown to the band (pixel rows 20 .. 69)
  const rows = (render, from, to) => [...new Set(render.ctx.getImageData(20, from, 160, to - from).data.filter((_, i) => i % 4 === 0))];
  // offsets 0 and the darkest noise: one row of blocks from the corner of the source
  const dark = { random: () => 0 };
  const own = make();
  burnRegions(own, [{ rect: mark, mode: "pixelate", strength: 1 }], dark);
  assert.deepEqual(rows(own, 60, 70), [219], "the mosaic of the stripe alone is the paper");
  const grown = make();
  const [done] = burnRegions(grown, [{ rect: mark, mode: "pixelate", strength: 1, source }], dark);
  assert.deepEqual(done.pixels, [20, 60, 160, 10], "what is reported (and verified) is the mark");
  // the mark shows the mean of mark AND band: 40 of 50 rows are ink
  assert.deepEqual(rows(grown, 60, 70), [36]);
  assert.equal(done.block, 100, "the block follows the height of the source (2 x 50 px), not of the mark");
  // nothing outside the mark changed: the band is still ink, the paper still paper
  assert.deepEqual(rows(grown, 20, 60), [0]);
  assert.deepEqual([rows(grown, 0, 20), rows(grown, 70, 100)], [[255], [255]]);
  // a source that does not hold the mark is not used
  const odd = make();
  burnRegions(odd, [{ rect: mark, mode: "blur", strength: 1, source: [0, 90, 10, 100] }], dark);
  assert.ok(rows(odd, 60, 70).every((value) => value >= 200));
});

test("lossless image XObject (Flate + PNG Up predictor) renders back to the same pixels", needCanvas, async () => {
  const w = 37;
  const h = 23;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255], i * 4);
  const rows = predictRgbRows(rgba, w, h);
  assert.equal(rows.length, (w * 3 + 1) * h);
  assert.ok(rows.every((v, i) => i % (w * 3 + 1) !== 0 || v === 2));
  const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([w, h]);
  const { ref, format } = imageXObjectFromRgba(doc, { data: rgba, width: w, height: h });
  assert.equal(format, "flate");
  page.node.set(pdfLib.PDFName.of("Resources"), doc.context.obj({ XObject: { Im: ref } }));
  page.node.set(pdfLib.PDFName.of("Contents"), doc.context.register(doc.context.stream(`q ${w} 0 0 ${h} 0 0 cm /Im Do Q`)));
  const bytes = await doc.save();
  const pjs = await openPdf(bytes);
  const p = await pjs.getPage(1);
  const viewport = p.getViewport({ scale: 1 });
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  await p.render({ canvasContext: ctx, canvas, viewport }).promise;
  const got = ctx.getImageData(0, 0, w, h).data;
  let maxDiff = 0;
  for (let i = 0; i < w * h * 4; i++) maxDiff = Math.max(maxDiff, Math.abs(got[i] - rgba[i]));
  await closePdf(pjs);
  assert.ok(maxDiff <= 1, `max channel difference ${maxDiff}`);
});

test("the picture of a page: lossless for flat pages, JPEG for photographs, lossless when no JPEG can be made", needCanvas, async () => {
  const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
  const encodeJpeg = async (canvas, quality) => new Uint8Array(canvas.toBuffer("image/jpeg", Math.round(quality * 100)));
  const flat = createCanvas(300, 200);
  flat.getContext("2d").fillStyle = "#ffffff";
  flat.getContext("2d").fillRect(0, 0, 300, 200);
  flat.getContext("2d").fillStyle = "#000000";
  flat.getContext("2d").fillRect(20, 20, 100, 10);
  const noisy = createCanvas(300, 200);
  const image = noisy.getContext("2d").getImageData(0, 0, 300, 200);
  const random = seededRandom(6);
  for (let i = 0; i < image.data.length; i += 4) image.data.set([random() * 255, random() * 255, random() * 255, 255], i);
  noisy.getContext("2d").putImageData(image, 0, 0);
  const objects = () => doc.context.enumerateIndirectObjects().length;
  const start = objects();
  const text = await imageXObjectFromCanvas(doc, flat, { format: "auto", encodeJpeg });
  assert.equal(text.format, "flate");
  assert.ok(text.alternativeBytes > 0);
  const photo = await imageXObjectFromCanvas(doc, noisy, { format: "auto", encodeJpeg });
  assert.equal(photo.format, "jpeg");
  assert.equal(A.getName(doc.context.lookup(photo.ref).dict, "Filter"), "DCTDecode");
  assert.equal(objects(), start + 2, "the encoding that was not chosen is not registered");
  assert.equal((await imageXObjectFromCanvas(doc, noisy, { format: "flate", encodeJpeg })).format, "flate");
  assert.equal((await imageXObjectFromCanvas(doc, flat, { format: "jpeg", encodeJpeg })).format, "jpeg");
  // no encoder, an encoder that gives up, an encoder that answers with something that is not a JPEG
  assert.equal((await imageXObjectFromCanvas(doc, noisy, { format: "auto" })).format, "flate");
  assert.equal((await imageXObjectFromCanvas(doc, noisy, { format: "jpeg", encodeJpeg: async () => null })).format, "flate");
  assert.equal((await imageXObjectFromCanvas(doc, noisy, { format: "jpeg", encodeJpeg: async (canvas) => new Uint8Array(canvas.toBuffer("image/png")) })).format, "flate");
  await assert.rejects(imageXObjectFromCanvas(doc, flat, { format: "webp" }), RangeError);
  void load;
});
