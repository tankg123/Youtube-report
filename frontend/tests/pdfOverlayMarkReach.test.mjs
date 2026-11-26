// What a pending mark takes beyond its own rectangle (src/pages/pdfEditor/overlay/markReach.js), against the
// REAL redaction engine: the outline the page shows must be the letters the export removes.
import test from "node:test";
import assert from "node:assert/strict";
import { previewRemoval, redactPdf } from "../src/pages/pdfEditor/engine/redact/index.js";
import { RASTER_DEFAULTS, rectToPixels } from "../src/pages/pdfEditor/engine/redact/rasterizePage.js";
import { EXPORT_MAX_PIXELS, EXPORT_PX_PER_PT, REACH_MAX_BYTES, createMarkReach, mosaicPixels, reachOf } from "../src/pages/pdfEditor/overlay/markReach.js";
import { plainTextPdf } from "./helpers/pdfRedactFixtures.mjs";
import { boxOf, makePdf, openPdfDocument, pageTextOf, redactEnv } from "./helpers/pdfRedactKit.mjs";

const page = (extra = {}) => ({ id: "p1", kind: "pdf", sourceId: "s1", sourceIndex: 0, ...extra });
const engine = () => ({ previewRemoval });

function reachFor(bytes, options = {}) {
  const calls = { engine: 0, bytes: 0 };
  const markReach = createMarkReach({
    loadEngine: async () => {
      calls.engine += 1;
      return options.engine || engine();
    },
    bytesOf: (sourceId) => {
      calls.bytes += 1;
      return sourceId === "s1" ? bytes : null;
    },
    passwordOf: () => options.password,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {})
  });
  return { markReach, calls };
}

test("a mark that fits its line takes that line only; with padding it takes letters of the lines around it, and the outline is exactly what the export removes", async () => {
  const { bytes, secret } = await plainTextPdf(); // three lines of 12 pt text, 14 pt apart
  const tight = await boxOf(bytes, secret, { pad: 0.5 });
  const { markReach } = reachFor(bytes);

  const fits = await markReach(page(), tight, "redact");
  assert.equal(fits.path, "precise");
  assert.equal(fits.glyphs, secret.length);
  assert.deepEqual(fits.outside, [], "nothing goes that the mark does not cover");
  assert.ok(Math.abs(fits.emPt - 12) < 3, `the font size of what is taken: ${fits.emPt}`);
  assert.ok(fits.extent[0] <= tight[0] && fits.extent[1] <= tight[1] && fits.extent[2] >= tight[2] && fits.extent[3] >= tight[3], "the area of a mosaic holds the mark");

  // 6 pt of padding reach into the lines above and below
  const padded = [tight[0] - 6, tight[1] - 6, tight[2] + 6, tight[3] + 6];
  const wide = await markReach(page(), padded, "redact");
  assert.equal(wide.path, "precise");
  assert.ok(wide.glyphs > secret.length, `more letters go than the word has: ${wide.glyphs}`);
  assert.ok(wide.outside.length >= 2, `runs of letters on the lines around it: ${wide.outside.length}`);
  for (const box of wide.outside) {
    assert.equal(box.quad.length, 8);
    assert.ok(box.rect[1] < padded[1] || box.rect[3] > padded[3] || box.rect[0] < padded[0] || box.rect[2] > padded[2], "an outlined run reaches beyond the mark");
  }
  assert.ok(wide.extent[1] < padded[1] && wide.extent[3] > padded[3], "the area of a mosaic grows to the letters that go");

  // the export removes exactly as many letters as the preview counted
  const { bytes: redacted, report } = await redactPdf(bytes, [{ pageIndex: 0, rect: padded, mode: "redact", color: "#000000" }], redactEnv());
  assert.equal(report.pages[0].path, "precise");
  assert.equal(report.pages[0].stats.glyphsRemoved, wide.glyphs, "the outline shows what the export takes");
  const left = (await pageTextOf(redacted)).replace(/\s+/g, "");
  assert.ok(!left.includes("InvoiceforAliceExample") && !left.includes("Lastlinestaysuntouched"), `the lines around the mark lost letters: ${left}`);
});

test("the same mark is asked once; the engine is loaded when the first mark asks, not before", async () => {
  const { bytes, secret } = await plainTextPdf();
  const rect = await boxOf(bytes, secret, { pad: 0.5 });
  const { markReach, calls } = reachFor(bytes);
  assert.equal(calls.engine, 0, "nothing is loaded for a document without marks");
  const first = markReach(page(), rect, "redact");
  assert.equal(markReach(page(), rect.slice(), "redact"), first, "the same geometry gives the same promise");
  assert.equal(markReach(page({ id: "copy-of-the-page" }), rect, "blur"), first, "a duplicated page and a blur mark share the answer: the same content, the same rule");
  await first;
  assert.equal(calls.engine, 1);
  assert.notEqual(markReach(page(), [rect[0], rect[1], rect[2] + 1, rect[3]], "redact"), first, "a mark that moved is asked again");
  markReach.clear();
  assert.notEqual(markReach(page(), rect, "redact"), first, "a closed document forgets its answers");
});

test("where there is nothing to tell the answer is null, never an error", async () => {
  const { bytes, secret } = await plainTextPdf();
  const rect = await boxOf(bytes, secret, { pad: 0.5 });
  const { markReach, calls } = reachFor(bytes, { maxBytes: 100 });
  assert.equal(await markReach(page(), rect, "redact"), null, "a source above the size limit is not parsed on the page's thread");
  assert.equal(calls.engine, 0);
  assert.ok(REACH_MAX_BYTES >= 8 * 1024 * 1024);

  const normal = reachFor(bytes);
  assert.equal(await normal.markReach(page({ kind: "blank", sourceId: null, sourceIndex: null }), rect, "redact"), null, "a blank page has no original content");
  assert.equal(await normal.markReach(page({ sourceId: "unknown" }), rect, "redact"), null);
  assert.equal(await normal.markReach(page(), [1, 2, Number.NaN, 4], "redact"), null);
  assert.equal(await normal.markReach(null, rect, "redact"), null);
  // an engine that cannot be loaded, or that throws
  const broken = reachFor(bytes, { engine: { previewRemoval: async () => { throw new Error("no engine"); } } });
  assert.equal(await broken.markReach(page(), rect, "redact"), null);
  // a page the document does not have: the engine answers "none"
  const beyond = await normal.markReach(page({ sourceIndex: 7 }), rect, "redact");
  assert.deepEqual([beyond.path, beyond.outside, beyond.glyphs], ["none", [], 0]);
});

test("reachOf: only the precise path has runs; a page that becomes a picture, an unusable answer and damaged boxes are told apart", () => {
  const rect = [100, 200, 300, 220];
  const run = (y0, y1, inside) => ({ rect: [90, y0, 310, y1], quad: [90, y0, 310, y0, 310, y1, 90, y1], glyphs: 5, inside });
  const precise = reachOf({ path: "precise", glyphs: 15, boxes: [run(201, 213, true), run(214, 227, false), run(188, 199, false), { rect: [1, 2], quad: [] }, null] }, rect);
  assert.deepEqual([precise.path, precise.glyphs, precise.outside.length], ["precise", 15, 2]);
  assert.deepEqual(precise.extent, [90, 188, 310, 227]);
  assert.equal(precise.emPt, 13, "the tallest run");
  const raster = reachOf({ path: "raster", reason: "REDACT_IMAGE_IN_TARGET", glyphs: 0, boxes: [run(214, 227, false)] }, rect);
  assert.deepEqual([raster.path, raster.reason, raster.outside, raster.extent, raster.emPt], ["raster", "REDACT_IMAGE_IN_TARGET", [], rect, 0], "a page that becomes a picture loses exactly the rectangle");
  for (const entry of [null, undefined, {}, { path: "weird", boxes: "x" }]) assert.deepEqual([reachOf(entry, rect).path, reachOf(entry, rect).outside], ["none", []]);
  // a rectangle given upside down is put right; no rectangle at all is an empty area
  assert.deepEqual(reachOf({ path: "precise", boxes: [] }, [300, 220, 100, 200]).extent, rect);
  assert.deepEqual(reachOf({ path: "precise", boxes: [] }, null).extent, [0, 0, 0, 0]);
});

test("mosaicPixels: the live blur is made of the pixels the export uses, on upright, turned, cropped, scaled and oversized pages", async () => {
  assert.equal(EXPORT_PX_PER_PT.raster, RASTER_DEFAULTS.dpi / 72, "the resolution of a page that becomes a picture");
  assert.equal(EXPORT_MAX_PIXELS, RASTER_DEFAULTS.maxPixels);
  const { bytes } = await makePdf([
    { content: "" },
    { content: "", size: [400, 600], extra: { Rotate: 90, CropBox: [50.5, 60.25, 380, 590] } },
    { content: "", size: [300, 300], extra: { UserUnit: 2, Rotate: 270 } },
    { content: "", size: [14400, 14400], extra: { Rotate: 180 } }
  ]);
  const task = openPdfDocument({ data: bytes.slice() });
  try {
    const doc = await task.promise;
    // [the area a mosaic is made of, the mark inside it]: between pixels, over an edge of the page, corners swapped
    const pairs = [
      [[71.3, 498.2, 301.77, 517.9], [72, 500, 300, 512]],
      [[100, 300, 112, 485], [100, 300, 112, 485]],
      [[-20.5, 10.1, 90.9, 44.4], [-10, 12, 80, 40]],
      [[250.25, 580.6, 420.2, 640.8], [260, 590, 400, 630]],
      [[301.77, 517.9, 71.3, 498.2], [300, 512, 72, 500]]
    ];
    let reduced = 0;
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      for (const pxPerPt of [EXPORT_PX_PER_PT.precise, EXPORT_PX_PER_PT.raster]) {
        // the picture of the page as renderPageBitmap() of the engine sizes it (rotation 0: the page as it is stored)
        let scale = pxPerPt;
        let viewport = page.getViewport({ scale, rotation: 0 });
        if (viewport.width * viewport.height > RASTER_DEFAULTS.maxPixels) {
          scale *= Math.sqrt(RASTER_DEFAULTS.maxPixels / (viewport.width * viewport.height));
          viewport = page.getViewport({ scale, rotation: 0 });
          reduced += 1;
        }
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        for (const [extent, rect] of pairs) {
          const pixels = mosaicPixels({ view: page.view, rotate: page.rotate, userUnit: page.userUnit }, extent, rect, pxPerPt);
          const label = `page ${number} at ${pxPerPt.toFixed(3)} px/pt, area ${extent.join(" ")}`;
          assert.deepEqual([pixels.width, pixels.height], [width, height], label);
          assert.ok(Math.abs(pixels.scale - scale) < 1e-9, label);
          assert.deepEqual(pixels.area, rectToPixels(viewport, extent, width, height, 0), `the area: ${label}`);
          assert.deepEqual(pixels.mark, rectToPixels(viewport, rect, width, height, 0), `the mark: ${label}`);
          // the rectangle that is asked from the viewer is exactly those pixels
          const first = viewport.convertToViewportPoint(pixels.userRect[0], pixels.userRect[1]);
          const second = viewport.convertToViewportPoint(pixels.userRect[2], pixels.userRect[3]);
          const back = [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[0], second[0]), Math.max(first[1], second[1])];
          const wanted = [pixels.area[0], pixels.area[1], pixels.area[0] + pixels.area[2], pixels.area[1] + pixels.area[3]];
          back.forEach((value, index) => assert.ok(Math.abs(value - wanted[index]) < 1e-6, `the rectangle of the area: ${label}: ${back} / ${wanted}`));
          // the mark lies inside its area, so the crop of the export never leaves the picture
          if (pixels.mark[2] && pixels.mark[3]) {
            assert.ok(pixels.mark[0] >= pixels.area[0] && pixels.mark[1] >= pixels.area[1] && pixels.mark[0] + pixels.mark[2] <= pixels.area[0] + pixels.area[2] && pixels.mark[1] + pixels.mark[3] <= pixels.area[1] + pixels.area[3], label);
          }
        }
      }
    }
    assert.equal(reduced, 2, "the oversized page is drawn with fewer pixels per point, at both resolutions");
  } finally {
    await task.destroy();
  }
});
