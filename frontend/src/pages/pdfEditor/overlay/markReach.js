// What a pending redaction or blur mark WILL take from its page, asked from the redaction engine before
// anything is exported (engine/redact previewRemoval(): the remover's own dry run, so for a page that is
// edited precisely the answer is exactly what the export removes).
//
// WHY the interface needs it. The engine never cuts a letter in half: a letter goes as a whole when the mark
// touches its core. A mark that was drawn by hand with a few points of padding therefore takes letters of the
// lines above and below it, and the box that is painted afterwards does not cover the holes they leave. The
// page shows those runs of letters with an outline (overlay/MarkReach.jsx), so that the user sees it BEFORE
// the file is made. The same answer tells the live blur which area the export makes its mosaic of (the mark
// grown to the letters it takes) and how large their font is (overlay/ObjectView.jsx).
//
//   reachOf(entry, rect)                          one entry of previewRemoval(), arranged for the overlay
//   createMarkReach({ loadEngine, bytesOf, passwordOf })   -> markReach(page, rect, type) => Promise<reach | null>
//   mosaicPixels(geometry, extent, rect, pxPerPt) the pixels the export makes the mosaic of a mark from
//
// Pure apart from the engine it is given: no DOM, no React (tests/pdfOverlayMarkReach.test.mjs). The engine
// pulls in the PDF library, so it comes in as a loader and is only asked for when a mark exists.
import { applyMatrix, invertMatrix, viewportTransform } from "../engine/geometry.js";

/**
 * Sources above this size are not asked: the dry run parses the whole file with the PDF library on the page's
 * thread the first time, and a preview is not worth a frozen page. Measured on the test corpus: 30 to 50 ms for
 * a megabyte of text and drawings, a few ms for a megabyte of scans; a second mark of the same document costs
 * a few ms. The limit keeps the first answer under about two seconds in the worst case.
 */
export const REACH_MAX_BYTES = 32 * 1024 * 1024;
const MAX_CACHED = 256;

/**
 * The resolution the export computes a mosaic at, in pixels per point: its patch render on a page that is edited
 * precisely (engine/redact env.patchDpi, 150 dpi) and the picture of a page that becomes one
 * (RASTER_DEFAULTS.dpi, 200 dpi). The live picture is made at the same resolution, whatever the zoom: the level
 * of a block follows the mean of its pixels, and a picture of another resolution has slightly other means.
 */
export const EXPORT_PX_PER_PT = Object.freeze({ precise: 150 / 72, raster: 200 / 72 });
/** The picture of a whole page has at most this many pixels in the export (RASTER_DEFAULTS.maxPixels). */
export const EXPORT_MAX_PIXELS = 16_000_000;
/** The largest live picture in pixels: a mark over a whole large page is computed more coarsely. */
export const LIVE_MAX_PIXELS = 6_000_000;

const isRect = (rect) => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite);

/**
 * The pixels the export works on for one mark (engine/redact/rasterizePage.js: renderPageBitmap and
 * rectToPixels): the page as it is STORED, not turned, drawn at `pxPerPt` (less when the picture of the page
 * would exceed maxPixels). The live picture is made of the same pixels: a grid that starts between two pixels
 * gives the thin blocks at the edge of a mark other means, and with them other levels.
 * @param {{ view: number[], userUnit?: number }} geometry   model/schema.js pageGeometry(page); its rotation is not used
 * @param {number[]} extent   the area the mosaic is made of, user space (reachOf().extent)
 * @param {number[]} rect     the mark, user space
 * @param {number} pxPerPt    EXPORT_PX_PER_PT.precise | .raster
 * @returns {{ scale: number, width: number, height: number, area: number[], mark: number[], userRect: number[] }}
 *   scale      pixels per point of the picture (pxPerPt, or less)
 *   width, height   the size of the picture of the whole page
 *   area, mark [x, y, w, h] in that picture, grown to whole pixels and cut at its edges
 *   userRect   the rectangle of the page that is exactly the pixels of `area`
 */
export function mosaicPixels(geometry, extent, rect, pxPerPt, maxPixels = EXPORT_MAX_PIXELS) {
  const stored = { view: geometry.view, rotate: 0, userUnit: geometry.userUnit || 1 };
  let scale = pxPerPt;
  let viewport = viewportTransform(stored, scale, 0);
  if (viewport.width * viewport.height > maxPixels) {
    scale *= Math.sqrt(maxPixels / (viewport.width * viewport.height));
    viewport = viewportTransform(stored, scale, 0);
  }
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const pixelsOf = (box) => {
    const [ax, ay] = applyMatrix(viewport.transform, [Math.min(box[0], box[2]), Math.min(box[1], box[3])]);
    const [bx, by] = applyMatrix(viewport.transform, [Math.max(box[0], box[2]), Math.max(box[1], box[3])]);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by)));
    const x1 = Math.min(width, Math.ceil(Math.max(ax, bx)));
    const y1 = Math.min(height, Math.ceil(Math.max(ay, by)));
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  };
  const area = pixelsOf(extent);
  const inverse = invertMatrix(viewport.transform);
  const first = applyMatrix(inverse, [area[0], area[1]]);
  const second = applyMatrix(inverse, [area[0] + area[2], area[1] + area[3]]);
  return {
    scale,
    width,
    height,
    area,
    mark: pixelsOf(rect),
    userRect: [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[0], second[0]), Math.max(first[1], second[1])]
  };
}
const isQuad = (quad) => Array.isArray(quad) && quad.length === 8 && quad.every(Number.isFinite);

/**
 * @param {object | null} entry   { path, reason?, glyphs, boxes: [{ rect, quad, glyphs, inside }] } of previewRemoval()
 * @param {number[]} rect         the rectangle of the mark, user space
 * @returns {{ path: "precise" | "raster" | "cover-needed" | "none", reason: string | null, glyphs: number,
 *             outside: Array<{ rect: number[], quad: number[] }>, extent: number[], emPt: number }}
 *   outside   the runs of letters that go although they reach beyond the mark (what the outline shows)
 *   extent    the mark grown to every run it takes: the area the export makes a mosaic of
 *   emPt      the height of the tallest run, in points: the font size the block size of a mosaic follows (0: no text)
 */
export function reachOf(entry, rect) {
  const base = isRect(rect) ? [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])] : [0, 0, 0, 0];
  const path = ["precise", "raster", "cover-needed"].includes(entry?.path) ? entry.path : "none";
  const boxes = path === "precise" && Array.isArray(entry?.boxes) ? entry.boxes.filter((box) => box && isRect(box.rect) && isQuad(box.quad)) : [];
  const extent = base.slice();
  let emPt = 0;
  for (const box of boxes) {
    extent[0] = Math.min(extent[0], box.rect[0]);
    extent[1] = Math.min(extent[1], box.rect[1]);
    extent[2] = Math.max(extent[2], box.rect[2]);
    extent[3] = Math.max(extent[3], box.rect[3]);
    // a quad runs along the line: its first and last corner are the low and the high edge at the start of the run
    emPt = Math.max(emPt, Math.hypot(box.quad[6] - box.quad[0], box.quad[7] - box.quad[1]));
  }
  return {
    path,
    reason: typeof entry?.reason === "string" ? entry.reason : null,
    glyphs: Number.isFinite(entry?.glyphs) ? entry.glyphs : 0,
    outside: boxes.filter((box) => box.inside === false).map((box) => ({ rect: box.rect.slice(), quad: box.quad.slice() })),
    extent,
    emPt
  };
}

/**
 * @param {object} deps
 * @param {() => Promise<{ previewRemoval: Function }>} deps.loadEngine   import("../engine/redact/index.js")
 * @param {(sourceId: string) => Uint8Array | null} deps.bytesOf   the bytes of a source AS THE STORE KEEPS THEM
 *        (the same array every time: the engine remembers the parsed document for as long as that array lives;
 *        it only reads it)
 * @param {(sourceId: string) => string | undefined} deps.passwordOf
 * @param {number} [deps.maxBytes]
 * @returns {{ (page: object, rect: number[], type: string): Promise<object | null>, clear(): void }}
 *          null: nothing to tell (a blank page, a file that is too large, an engine that could not be loaded)
 */
export function createMarkReach({ loadEngine, bytesOf, passwordOf, maxBytes = REACH_MAX_BYTES }) {
  const cache = new Map();
  function markReach(page, rect, type) {
    if (!page || page.kind !== "pdf" || !page.sourceId || !Number.isInteger(page.sourceIndex) || !isRect(rect)) return Promise.resolve(null);
    const mode = type === "erase" ? "erase" : type === "blur" ? "blur" : "redact";
    const key = `${page.sourceId}:${page.sourceIndex}:${mode === "erase" ? "e" : "s"}:${rect.map((value) => Math.round(value * 1000) / 1000).join(",")}`;
    if (!cache.has(key)) {
      if (cache.size >= MAX_CACHED) cache.clear();
      const answer = (async () => {
        const bytes = bytesOf(page.sourceId);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
        const engine = await loadEngine();
        const password = passwordOf(page.sourceId);
        const [entry] = await engine.previewRemoval(bytes, [{ pageIndex: page.sourceIndex, rect, mode }], typeof password === "string" ? { password } : {});
        return entry ? reachOf(entry, rect) : null;
      })().catch(() => null);
      cache.set(key, answer);
    }
    return cache.get(key);
  }
  markReach.clear = () => cache.clear();
  return markReach;
}
