// The verifier (engine/redact/verifyRedaction.js) must FAIL on everything that is not a clean redaction:
// these are its negative controls, next to the proof that a correct result passes.
import test from "node:test";
import assert from "node:assert/strict";
import { removeTextInRects } from "../src/pages/pdfEditor/engine/redact/textRemoval.js";
import { VERIFY_DEFAULTS, checkRegions, regionDetail, regionFlatness, renderForCheck, snapshotPage, verifyPageText, verifyRasterPage } from "../src/pages/pdfEditor/engine/redact/verifyRedaction.js";
import * as verifyApi from "../src/pages/pdfEditor/engine/redact/verifyRedaction.js";
import * as glyphsApi from "../src/pages/pdfEditor/engine/redact/pdfjsGlyphs.js";
import { obscureRegion } from "../src/pages/pdfEditor/engine/redact/blur.js";
import { canRender, canvasLib, closePdf, fontBytes, fontkit, openPdf, pdfLib, pdfjs } from "./helpers/pdfTestKit.mjs";
import { load, makePdf, originOf, save, seededRandom, snap } from "./helpers/pdfRedactKit.mjs";

const { rgb } = pdfLib;
const needCanvas = { skip: !canRender && "no canvas binary on this platform" };
const createCanvas = (w, h) => canvasLib.createCanvas(w, h);
const CONTENT = "BT /F1 12 Tf 14 TL 72 700 Td (Name: Alice Example, account 4711) Tj T* (second line stays where it is) Tj ET";

async function fixture() {
  const { bytes } = await makePdf([{ content: CONTENT }]);
  const before = await snap(bytes);
  const at = before.glyphs.map((g) => g.unicode).join("").indexOf("Alice Example");
  const g = before.glyphs.slice(at, at + "Alice Example".length);
  const rect = [g[0].quad[0], g[0].quad[1], g[g.length - 1].quad[2], g[0].quad[7]];
  return { bytes, before, rect };
}

async function regions(bytes, list, options = {}) {
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(1);
    const after = await snapshotPage(page, pdfjs);
    return await checkRegions(page, pdfjs, createCanvas, list, { keptGlyphs: after.glyphs, ...options });
  } finally {
    await closePdf(doc);
  }
}

test("a correct removal passes every check", needCanvas, async () => {
  const { bytes, before, rect } = await fixture();
  const doc = await load(bytes);
  removeTextInRects(doc, 0, [rect]);
  const out = await save(doc);
  const v = verifyPageText(before, await snap(out), [rect]);
  assert.equal(v.ok, true, JSON.stringify(v.failures));
  assert.equal(v.stats.removed, 13);
  assert.equal(v.stats.checkedStrings, 1);
  const r = await regions(out, [{ rect, expect: "blank" }]);
  assert.equal(r.ok, true, JSON.stringify(r.regions));
});

test("G1: the untouched file fails, and so does a black box drawn over the text", needCanvas, async () => {
  const { bytes, before, rect } = await fixture();
  let v = verifyPageText(before, await snap(bytes), [rect]);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.check === "G1-removal"));
  assert.ok(v.failures.some((f) => f.check === "G3-strings"));
  assert.equal(v.stats.remainingInTargets, 13);
  // "redaction" by covering: looks right, the text is still there
  const doc = await load(bytes);
  doc.getPage(0).drawRectangle({ x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1], color: rgb(0, 0, 0) });
  const covered = await save(doc);
  v = verifyPageText(before, await snap(covered), [rect]);
  assert.ok(v.failures.some((f) => f.check === "G1-removal"));
  // ... although the pixels are a flat black
  const r = await regions(covered, [{ rect, expect: "painted", color: [0, 0, 0] }]);
  assert.equal(r.ok, true);
});

test("G2: text that moved, text that vanished elsewhere and text that was added are all caught", async () => {
  const { bytes, before, rect } = await fixture();
  // the name is cut out of the string without compensation: what follows slides to the left
  const moved = await makePdf([{ content: CONTENT.replace("Alice Example", "") }]);
  let v = verifyPageText(before, await snap(moved.bytes), [rect]);
  assert.ok(v.failures.some((f) => f.check === "G2-preservation"), JSON.stringify(v.failures));
  assert.ok(v.stats.lost > 0 && v.stats.added > 0);
  // the second line is gone as well
  const doc = await load(bytes);
  removeTextInRects(doc, 0, [rect, [70, 680, 400, 695]]);
  v = verifyPageText(before, await snap(await save(doc)), [rect]);
  assert.ok(v.failures.some((f) => f.check === "G2-preservation" && /missing or moved/.test(f.message)));
  // something was added to the page
  const doc2 = await load(bytes);
  removeTextInRects(doc2, 0, [rect]);
  doc2.getPage(0).drawText("extra", { x: 300, y: 300, size: 10 });
  v = verifyPageText(before, await snap(await save(doc2)), [rect]);
  assert.ok(v.failures.some((f) => f.check === "G2-preservation" && /no counterpart/.test(f.message)));
  // with no target at all the check means "the page is unchanged"
  assert.equal(verifyPageText(before, await snap(bytes), []).ok, true);
  assert.equal(verifyPageText(before, await snap(moved.bytes), []).ok, false);
});

test("G3: the removed string must occur less often, wherever it went", async () => {
  const { before, rect } = await fixture();
  // the name left the target but sits somewhere else on the page now
  const relocated = await makePdf([{ content: `${CONTENT.replace("Alice Example", "             ")} BT /F1 12 Tf 72 300 Td (Alice Example) Tj ET` }]);
  const v = verifyPageText(before, await snap(relocated.bytes), [rect]);
  assert.ok(v.failures.some((f) => f.check === "G3-strings"), JSON.stringify(v.failures));
});

test("failures and warnings never repeat text of the document", async () => {
  const { bytes, before, rect } = await fixture();
  const relocated = await makePdf([{ content: `${CONTENT} BT /F1 12 Tf 72 300 Td (Alice Example again) Tj ET` }]);
  for (const after of [await snap(bytes), await snap(relocated.bytes)]) {
    for (const verdict of [verifyPageText(before, after, [rect]), verifyRasterPage(before, after, [rect])]) {
      assert.equal(verdict.ok, false);
      const text = JSON.stringify([verdict.failures, verdict.warnings, verdict.stats]);
      for (const word of ["Alice", "Example", "account", "4711", "second"]) assert.ok(!text.includes(word), `${word} in ${text.slice(0, 300)}`);
    }
  }
});

test("the verifier does not care how the text was removed: a hand-made redaction passes", async () => {
  const { before, rect } = await fixture();
  const x = originOf(before, ", account")[0];
  const manual = await makePdf([{ content: `BT /F1 12 Tf 72 700 Td (Name: ) Tj 1 0 0 1 ${x.toFixed(4)} 700 Tm (, account 4711) Tj 1 0 0 1 72 686 Tm (second line stays where it is) Tj ET` }]);
  const v = verifyPageText(before, await snap(manual.bytes), [rect]);
  assert.equal(v.ok, true, JSON.stringify(v.failures));
});

test("I1 is a warning: a hole narrower than 0.6 em does not split the text item of pdf.js", async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (A1B) Tj ET" }]);
  const before = await snap(bytes);
  const g = before.glyphs[1];
  const rect = [g.quad[0], g.quad[1], g.quad[2], g.quad[7]];
  const doc = await load(bytes);
  removeTextInRects(doc, 0, [rect]);
  const after = await snap(await save(doc));
  assert.equal(after.items.filter((it) => it.str.trim()).length, 1); // still one item, spanning the hole
  const v = verifyPageText(before, after, [rect]);
  assert.equal(v.ok, true, JSON.stringify(v.failures));
  assert.equal(v.stats.removed, 1);
  assert.deepEqual([v.warnings[0]?.check, v.warnings[0]?.count], ["I1-items", 1]);
});

test("glyphs of annotation appearances count for strict targets only", async () => {
  // a free-text note whose appearance stream shows text: it is not page text, but it is under the target
  const appearance = (ctx, refs, fonts) => ctx.register(ctx.stream(Buffer.from("BT /F1 10 Tf 2 4 Td (note text) Tj ET"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 80, 16], Resources: { Font: fonts } }));
  const { bytes } = await makePdf([{
    content: "BT /F1 12 Tf 72 700 Td (page text) Tj ET",
    annots: [(ctx, refs) => ctx.register(ctx.obj({ Type: "Annot", Subtype: "FreeText", Rect: [72, 640, 152, 656], Contents: pdfLib.PDFString.of("note text"), DA: pdfLib.PDFString.of("/F1 10 Tf"), AP: { N: refs.ap } }))]
  }], { objects: { ap: appearance } });
  const before = await snap(bytes);
  assert.ok(before.glyphs.some((g) => g.inAnnotation), "fixture: pdf.js lists the glyphs of the appearance");
  const rect = [70, 638, 160, 658];
  const strict = verifyPageText(before, before, [rect]);
  assert.ok(strict.failures.some((f) => f.check === "G1-removal" && f.inAnnotation));
  const textOnly = verifyPageText(before, before, [rect], { annotationRects: [] });
  assert.equal(textOnly.ok, true, JSON.stringify(textOnly.failures));
});

test("G4: the region must be blank after the removal: pictures, paths and pictures of text are not", needCanvas, async () => {
  // text over a grey bar that is wider than the target: removing the glyphs leaves the bar
  const { bytes } = await makePdf([{ content: "0.8 g 60 696 300 16 re f 0 g BT /F1 12 Tf 72 700 Td (secret on a grey bar) Tj ET BT /F1 12 Tf 72 600 Td (secret on white) Tj ET" }]);
  const doc = await load(bytes);
  const bar = [70, 697, 200, 711];
  const white = [70, 597, 170, 611];
  removeTextInRects(doc, 0, [bar, white], { mode: "text-only" });
  const out = await save(doc);
  let r = await regions(out, [{ rect: bar, expect: "blank" }, { rect: white, expect: "blank" }]);
  assert.deepEqual(r.regions.map((x) => x.ok), [true, true]); // a flat grey is blank too
  // a target that crosses the edge of the bar is not flat
  r = await regions(out, [{ rect: [70, 705, 200, 720], expect: "blank" }]);
  assert.equal(r.ok, false);
  assert.ok(r.regions[0].outliers > 100);
  // a "scanned" page: a picture of text with an invisible text layer. The invisible text goes, the picture stays
  const canvas = createCanvas(300, 40);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f0e6";
  ctx.fillRect(0, 0, 300, 40);
  ctx.fillStyle = "#222";
  for (let x = 8; x < 290; x += 7) ctx.fillRect(x, 10 + (x % 5), 3, 18); // strokes that look like a line of text
  const scan = await makePdf([{ content: "q 300 0 0 40 72 690 cm /Scan Do Q BT 3 Tr /F1 14 Tf 80 702 Td (pictured line of text) Tj ET", resources: {} }], {
    setup: async (document) => {
      const image = await document.embedPng(new Uint8Array(canvas.toBuffer("image/png")));
      document.getPage(0).node.set(pdfLib.PDFName.of("Resources"), document.context.obj({ Font: document.getPage(0).node.Resources().get(pdfLib.PDFName.of("Font")), XObject: { Scan: image.ref } }));
    }
  });
  const target = [78, 696, 230, 718];
  const scanDoc = await load(scan.bytes);
  const rep = removeTextInRects(scanDoc, 0, [target], { mode: "text-only" });
  assert.ok(rep.glyphsRemoved > 10);
  const scanOut = await save(scanDoc);
  assert.equal(verifyPageText(await snap(scan.bytes), await snap(scanOut), [target]).ok, true); // the text checks pass
  r = await regions(scanOut, [{ rect: target, expect: "blank" }]);
  assert.equal(r.ok, false); // the pixel check does not
});

test("G4: the ink of glyphs that were knowingly kept does not count; a region that should be painted must be", needCanvas, async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 12 TL 72 700 Td (upper gjpqy gjpqy) Tj T* (TARGET LINE HERE) Tj T* (LOWER ABCDEF) Tj ET" }]);
  const before = await snap(bytes);
  const item = before.items.find((it) => it.str === "TARGET LINE HERE");
  const rect = [item.box[0] - 0.5, item.box[1] - 0.5, item.box[2] + 0.5, item.box[3] + 0.5];
  const doc = await load(bytes);
  removeTextInRects(doc, 0, [rect]);
  const out = await save(doc);
  // descenders of the line above and capitals of the line below reach into the rectangle
  const masked = await regions(out, [{ rect, expect: "blank" }]);
  assert.equal(masked.ok, true, JSON.stringify(masked.regions));
  assert.ok(masked.regions[0].masked > 0);
  const unmasked = await regions(out, [{ rect, expect: "blank" }], { keptGlyphs: [] });
  assert.equal(unmasked.ok, false);
  // "painted" fails when nothing was painted, or when the colour is wrong
  const far = [300, 300, 380, 320];
  assert.equal((await regions(out, [{ rect: far, expect: "painted", color: [0, 0, 0] }])).ok, false);
  doc.getPage(0).drawRectangle({ x: far[0], y: far[1], width: 80, height: 20, color: rgb(1, 0, 0) });
  const painted = await save(doc);
  assert.equal((await regions(painted, [{ rect: far, expect: "painted", color: [255, 0, 0] }])).ok, true);
  assert.equal((await regions(painted, [{ rect: far, expect: "painted", color: [0, 0, 0] }])).ok, false);
  // a box painted later over a part of the region is not this region's business
  // (a fresh load: the library does not write what is drawn on a page after it was saved once)
  const again = await load(painted);
  again.getPage(0).drawRectangle({ x: 340, y: 290, width: 60, height: 40, color: rgb(0, 0, 1) });
  const overlapped = await save(again);
  assert.equal((await regions(overlapped, [{ rect: far, expect: "painted", color: [255, 0, 0] }])).ok, false);
  assert.equal((await regions(overlapped, [{ rect: far, expect: "painted", color: [255, 0, 0], ignore: [[340, 290, 400, 330]] }])).ok, true);
  // "any" needs no pixels: the page is not even rendered
  let rendered = 0;
  const any = await regions(painted, [{ rect: far, expect: "any" }], { canvas: undefined });
  assert.deepEqual([any.ok, any.render], [true, null]);
  const lazy = await openPdf(painted);
  await checkRegions(await lazy.getPage(1), pdfjs, () => {
    rendered += 1;
    return createCanvas(10, 10);
  }, [{ rect: far, expect: "any" }]);
  await closePdf(lazy);
  assert.equal(rendered, 0);
});

test("G4 obscured: a mosaic passes, the untouched text does not, and without the original nothing passes", needCanvas, async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (readable text that must be obscured) Tj ET" }]);
  const rect = [70, 695, 280, 714];
  const original = await openPdf(bytes);
  const page = await original.getPage(1);
  const reference = await renderForCheck(page, pdfjs, createCanvas);
  // 1. the page as it is: every stroke of the text is still there
  let r = await checkRegions(page, pdfjs, createCanvas, [{ rect, expect: "obscured" }], { reference });
  assert.equal(r.ok, false);
  assert.ok(r.regions[0].detail > 20 && r.regions[0].detail === r.regions[0].originalDetail, JSON.stringify(r.regions[0]));
  // 2. the same render with the region turned into the engine's mosaic (both styles)
  for (const style of ["pixelate", "blur"]) {
    const render = await renderForCheck(page, pdfjs, createCanvas);
    const [ax, ay] = render.viewport.convertToViewportPoint(rect[0], rect[3]);
    const [bx, by] = render.viewport.convertToViewportPoint(rect[2], rect[1]);
    const image = render.ctx.getImageData(Math.floor(ax), Math.floor(ay), Math.ceil(bx - ax), Math.ceil(by - ay));
    obscureRegion(image, 0, 0, image.width, image.height, { style, pxPerPt: VERIFY_DEFAULTS.renderScale, random: seededRandom(4) });
    render.ctx.putImageData(image, Math.floor(ax), Math.floor(ay));
    r = await checkRegions(page, pdfjs, createCanvas, [{ rect, expect: "obscured" }], { reference, canvas: render });
    assert.equal(r.ok, true, `${style}: ${JSON.stringify(r.regions[0])}`);
    assert.ok(r.regions[0].detail < r.regions[0].limit / 2, `${style}: detail ${r.regions[0].detail}`);
  }
  // 3. no render of the original: the check cannot vouch for anything
  r = await checkRegions(page, pdfjs, createCanvas, [{ rect, expect: "obscured" }]);
  assert.equal(r.ok, false);
  // 4. a blank region is "obscured" whatever is done to it
  r = await checkRegions(page, pdfjs, createCanvas, [{ rect: [300, 300, 400, 330], expect: "obscured" }], { reference });
  assert.equal(r.ok, true);
  await closePdf(original);
});

test("regionFlatness and regionDetail: dominant colour, outliers, mask, fine detail per tile", () => {
  const w = 20;
  const h = 10;
  const data = new Uint8ClampedArray(w * h * 4).fill(250);
  assert.deepEqual(regionFlatness(data, w, h, 12), { pixels: 200, outliers: 0, dominant: [250, 250, 250], range: 0 });
  for (let i = 0; i < 5; i++) data.set([10, 10, 10, 255], i * 4);
  let f = regionFlatness(data, w, h, 12);
  assert.equal(f.outliers, 5);
  assert.equal(f.range, 240);
  const mask = new Uint8Array(w * h);
  mask.fill(1, 0, 5);
  f = regionFlatness(data, w, h, 12, mask);
  assert.deepEqual([f.pixels, f.outliers], [195, 0]);
  // within the tolerance
  data.set([240, 245, 255, 255], 40);
  assert.equal(regionFlatness(data, w, h, 12, mask).outliers, 0);
  assert.equal(regionFlatness(data, w, h, 4, mask).outliers, 1);
  // fine detail: stripes two pixels wide in one tile of an otherwise flat picture
  const size = 96;
  const picture = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (x % 4 < 2) picture.set([0, 0, 0, 255], (y * size + x) * 4);
  const detail = regionDetail(picture, size, size, 48);
  assert.ok(detail.max > 50 && detail.mean < detail.max / 3, JSON.stringify(detail));
  assert.deepEqual(regionDetail(new Uint8ClampedArray(size * size * 4).fill(128), size, size, 48), { mean: 0, max: 0 });
  // two flat blocks side by side (a mosaic): one edge in a tile is far below the limit of the check
  const blocks = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 48; x < size; x++) blocks.set([146, 146, 146, 255], (y * size + x) * 4);
  assert.ok(regionDetail(blocks, size, size, 48).max < VERIFY_DEFAULTS.obscuredFloor / 4);
});

// ---------------------------------------------------------------------------------------------------------
// pages without marks, and fonts that were edited (the review: defects 4 and 1)

/** What the engine compares of a page no mark touches: its drawing as pdf.js reads it, without annotations. */
async function drawingOfPage(bytes, pageIndex = 0, compact = true) {
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(pageIndex + 1);
    return await glyphsApi.pageGlyphs(page, pdfjs, compact ? { annotations: false, compact: true } : { annotations: false, styles: {} });
  } finally {
    await closePdf(doc);
  }
}

/** A page set in an embedded subset font; `damage` replaces the font program by bytes that are no font. */
async function embeddedFontPdf({ text = "Embedded line 4711", damage = false } = {}) {
  const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes("arimo-regular"), { subset: true });
  doc.addPage([400, 200]).drawText(text, { x: 40, y: 100, size: 14, font });
  const bytes = await doc.save({ useObjectStreams: false });
  if (!damage) return bytes;
  const loaded = await load(bytes);
  for (const [, object] of loaded.context.enumerateIndirectObjects()) {
    if (!(object instanceof pdfLib.PDFDict) || !object.has(pdfLib.PDFName.of("FontFile2"))) continue;
    object.set(pdfLib.PDFName.of("FontFile2"), loaded.context.register(loaded.context.flateStream(new Uint8Array(600).fill(0x41), { Length1: 600 })));
  }
  return save(loaded);
}

for (const compact of [true, false]) {
  test(`a page no mark touches (${compact ? "packed glyphs, as the engine reads it" : "a glyph object each"}): the same drawing passes; other text, moved text, other operators and a lost font do not`, async () => {
  const drawingOf = (bytes, pageIndex) => drawingOfPage(bytes, pageIndex, compact);
  const page = (content) => makePdf([{ content }]).then((made) => made.bytes);
  const base = "BT /F1 12 Tf 72 700 Td (Unmarked page, account 4711) Tj ET 72 690 m 300 690 l S";
  const before = await drawingOf(await page(base));
  assert.equal(typeof before.signature, "number");
  assert.equal(compact ? before.packed.count : before.glyphs.length, "Unmarked page, account 4711".length);
  assert.equal(compact ? before.glyphs.length : before.packed, compact ? 0 : null);
  // the same page written again (other bytes, other object numbers) is the same page
  const { bytes: again } = await makePdf([{ content: "BT /F1 12 Tf 72 500 Td (a page in front) Tj ET" }, { content: base }]);
  assert.deepEqual(verifyApi.compareUntouchedPage(before, await drawingOf(again, 1)), { ok: true, reason: null });
  // one character differs (the same operators, the same places: only the comparison of the glyphs can tell)
  assert.deepEqual(verifyApi.compareUntouchedPage(before, await drawingOf(await page(base.replace("4711", "4712")))), { ok: false, reason: "glyphs" });
  // the line stands 3 pt lower
  assert.deepEqual(verifyApi.compareUntouchedPage(before, await drawingOf(await page(base.replace("72 700 Td", "72 697 Td")))), { ok: false, reason: "glyphs" });
  // a glyph more, a glyph less
  assert.deepEqual(verifyApi.compareUntouchedPage(before, await drawingOf(await page(base.replace("4711", "47111")))), { ok: false, reason: "glyphs" });
  // the drawing differs where no text is: a second rule, or the rule missing
  assert.deepEqual(verifyApi.compareUntouchedPage(before, await drawingOf(await page(`${base} 72 680 m 300 680 l S`))), { ok: false, reason: "operators" });
  assert.deepEqual(verifyApi.compareUntouchedPage(before, await drawingOf(await page(base.replace(" 72 690 m 300 690 l S", "")))), { ok: false, reason: "operators" });
  // the text of ANOTHER definition of the page (what the review showed): every glyph differs
  assert.equal(verifyApi.compareUntouchedPage(before, await drawingOf(await page("BT /F1 12 Tf 72 700 Td (HIDDEN OLD VERSION, salary 9 900) Tj ET 72 690 m 300 690 l S"))).ok, false);
  // annotation appearances are not part of the comparison (a job may empty a field whose widget lies here)
  const withNote = (await makePdf([{ content: base, annots: [{ Type: "Annot", Subtype: "FreeText", Rect: [72, 600, 300, 620], Contents: pdfLib.PDFString.of("a note"), DA: pdfLib.PDFString.of("/Helv 10 Tf 0 g") }] }])).bytes;
  assert.deepEqual(verifyApi.compareUntouchedPage(before, await drawingOf(withNote)), { ok: true, reason: null });

  // a font that loaded before and does not load any more: the glyphs are where they were, drawn with a stand-in
  const intact = await drawingOf(await embeddedFontPdf());
  const broken = await drawingOf(await embeddedFontPdf({ damage: true }));
  const missing = (drawing) => (compact ? [...drawing.packed.fontMissing].map(Boolean) : drawing.glyphs.map((glyph) => glyph.fontMissing));
  assert.ok(missing(intact).length > 10 && missing(intact).every((flag) => flag === false), "fixture: the font loads");
  assert.ok(missing(broken).some((flag) => flag === true), "fixture: pdf.js could not use the damaged program");
  assert.deepEqual(verifyApi.compareUntouchedPage(intact, broken), { ok: false, reason: "fonts" });
  // (a font that never loaded is no change)
  assert.deepEqual(verifyApi.compareUntouchedPage(broken, broken), { ok: true, reason: null });
  });
}

test("G2: text that stays but is drawn with a font that no longer loads fails the page", async () => {
  // (the fonts are edited since the repair of defect 1: a program that pdf.js rejects afterwards must never
  // be returned, even though every glyph is still reported at its place)
  const before = await snap(await embeddedFontPdf());
  const after = await snap(await embeddedFontPdf({ damage: true }));
  const verdict = verifyPageText(before, after, []);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.stats.fontsLost > 10, `fontsLost ${verdict.stats.fontsLost}`);
  assert.deepEqual(verdict.failures.map((failure) => failure.check), ["G2-preservation"]);
  assert.ok(!JSON.stringify(verdict.failures).includes("Embedded"), "a failure never repeats text of the document");
  // the other way round nothing is lost
  assert.equal(verifyPageText(after, after, []).stats.fontsLost, 0);
  assert.equal(verifyPageText(before, before, []).ok, true);
});
