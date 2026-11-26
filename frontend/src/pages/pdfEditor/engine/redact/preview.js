// What a mark WILL take, before anything is exported: a dry run of the precise path for a list of marks. The
// interface shows the boxes it returns while the user draws or moves a mark.
//
// WHY. A mark does not cut glyphs in half: a glyph goes as a whole when the mark touches its core or covers
// more than a quarter of its box (GLYPH_RULE in pdfAccess.js). A hand-drawn mark with a few points of padding
// therefore takes characters of the lines above and below it (measured by the reviewer: 12 pt text with
// leading 1.2 and 5 pt of padding lose 23 characters of the neighbouring lines), and the box that is painted
// afterwards does not cover the holes. That is the rule working as designed; the user must SEE it.
//
//   previewRemoval(source, marks, options) -> Promise of [{ index, pageIndex, path, reason?, glyphs, boxes }]
//   source: the bytes of the document, or the pdf.js document the interface shows (its bytes are asked for once)
//
// EXACT, NOT ESTIMATED. The glyphs are found by the remover itself (textRemoval.js with dryRun: the same
// interpreter, the same font metrics, the same rule), on the document as the PDF library loads it. A reading
// of the page through pdf.js would be cheaper for an interface that has pdf.js pages at hand, but pdf.js and
// the remover do not give a glyph the same box in every font (for a standard font without a descriptor they
// differ by a fifth of the font size), and a preview that shows 54 characters where the export takes 38 is
// worse than none. The dry run changes nothing in the document.
//
// What the preview cannot know: whether the page passes the verification of the export. A page that fails it
// becomes a picture, and then exactly the rectangle is burned in: less goes than the preview shows, never more.
// What the remover already knows is in `path`:
//   "precise"       the page content can be edited: `boxes` are the runs of glyphs that go
//   "raster"        the page will become a picture (a scan or a picture that reaches into a mark, content that
//                   is not understood ...: `reason` is the code the report of the export will carry). Nothing
//                   outside the rectangle is taken: no boxes
//   "cover-needed"  an "erase" mark on a page whose content cannot be edited: nothing goes at all
//   "none"          the mark is not usable (no finite rectangle with an area, no such page)
// Not in the preview: annotations and form fields (one that touches a strict mark goes as a whole;
// page.getAnnotations() of pdf.js gives their rectangles) and pictures (one that lies inside a strict mark goes).
import { pdfLib } from "../lib.js";
import { fallbackReason } from "./codes.js";
import { GLYPH_RULE, normRect } from "./pdfAccess.js";
import { removeTextInRects } from "./textRemoval.js";

const { PDFDocument, ParseSpeeds } = pdfLib;

/**
 * The parsed document of a byte array, kept for as long as the caller keeps the array: a preview is asked for
 * again and again while a mark is dragged, and parsing is most of its cost. (A dry run changes nothing, so the
 * document can be used any number of times.)
 */
const parsedDocuments = new WeakMap();

async function parse(bytes, password) {
  const options = { updateMetadata: false, parseSpeed: ParseSpeeds.Fastest };
  let doc;
  try {
    doc = await PDFDocument.load(bytes, password === undefined ? options : { ...options, password });
  } catch (error) {
    // (as in redactPdf: a file that opens without a password has an empty user password)
    if (password !== undefined) throw error;
    doc = await PDFDocument.load(bytes, { ...options, password: "" });
  }
  if (!doc.catalog) throw new Error("the page tree is not usable");
  return { doc, pageCount: doc.getPageCount(), fontCache: new Map() };
}

/** The bytes behind a pdf.js document (PDFDocumentProxy.getData()), asked for once per document. */
const dataOfDocuments = new WeakMap();

function bytesOf(source) {
  if (source instanceof Uint8Array) return source;
  if (!source || typeof source.getData !== "function" || typeof source.numPages !== "number") return null;
  if (!dataOfDocuments.has(source)) {
    dataOfDocuments.set(source, Promise.resolve().then(() => source.getData()).then((data) => (data instanceof Uint8Array ? data : null), () => null));
  }
  return dataOfDocuments.get(source);
}

function documentOf(bytes, password) {
  const known = parsedDocuments.get(bytes);
  if (known && known.password === password) return known.promise;
  const promise = parse(bytes, password).catch(() => null); // null: the library cannot load the file
  parsedDocuments.set(bytes, { password, promise });
  return promise;
}

/** Glyphs that follow each other on one line become one box. */
function boxesOf(quads, rect) {
  const boxes = [];
  let run = null;
  const close = () => {
    if (!run) return;
    const xs = [];
    const ys = [];
    for (const quad of run) {
      for (let k = 0; k < 8; k += 2) {
        xs.push(quad[k]);
        ys.push(quad[k + 1]);
      }
    }
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const first = run[0];
    const last = run[run.length - 1];
    boxes.push({
      rect: bounds,
      // the parallelogram of the run: start and end of the line of glyphs, low and high edge (rotated text)
      quad: [first[0], first[1], last[2], last[3], last[4], last[5], first[6], first[7]],
      glyphs: run.length,
      // false: the run reaches beyond the mark (the mark takes more than it covers there)
      inside: bounds[0] >= rect[0] - 0.01 && bounds[1] >= rect[1] - 0.01 && bounds[2] <= rect[2] + 0.01 && bounds[3] <= rect[3] + 0.01
    });
    run = null;
  };
  for (const quad of quads) {
    if (!quad.every(Number.isFinite)) continue;
    if (run) {
      const previous = run[run.length - 1];
      const height = Math.hypot(previous[6] - previous[0], previous[7] - previous[1]) || 1;
      // the next glyph starts where the last one ended (its lower left corner on the lower right one)
      if (Math.hypot(quad[0] - previous[2], quad[1] - previous[3]) > 0.5 * height) close();
    }
    run ||= [];
    run.push(quad);
  }
  close();
  return boxes;
}

/**
 * The text a list of marks would take from a document, without changing anything.
 *   source    the document redactPdf() will be given: its bytes (Uint8Array), or the pdf.js document that was
 *             opened from them (PDFDocumentProxy: getData() is called once). The parsed document is
 *             remembered for as long as the caller keeps THIS array or pdf.js document (and does not change
 *             the array), so calling again while a mark moves costs the dry run only. For the marks of one
 *             pdf.js page pass its document and pageIndex = page.pageNumber - 1 (a page alone does not give
 *             access to the document, and the dry run needs the document)
 *   marks     [{ pageIndex, rect: [x0, y0, x1, y1], mode? }] as the targets of redactPdf (mode "redact" when
 *             missing; "erase" marks never make a page a picture)
 *   options   { password: of an encrypted document, thresholds: { core, full } (default GLYPH_RULE.remove; pass
 *               what env.thresholds of the export will be) }
 * Returns one entry per mark, in the order of `marks`:
 *   { index, pageIndex, path: "precise" | "raster" | "cover-needed" | "none", reason?: code of CODES,
 *     glyphs: number of glyphs taken,
 *     boxes: [{ rect: [x0, y0, x1, y1], quad: [x, y] x 4, glyphs, inside }] }
 *   A box is a run of taken glyphs on one line: `rect` its bounding box in the user space of the page, `quad`
 *   its outline for text that is not upright, `inside` whether it lies within the mark. Text of the page
 *   content and of the Form XObjects it draws, invisible text included; never a character of it: the result
 *   may be logged.
 * A document the PDF library cannot load is a document whose pages all become pictures in the export: every
 * strict mark is answered with path "raster" (reason REDACT_DOCUMENT_NOT_EDITABLE), every "erase" mark with
 * "cover-needed". Nothing is thrown for a mark or a document that is not usable: the export is where targets
 * are refused.
 */
export async function previewRemoval(source, marks, options = {}) {
  const thresholds = { ...GLYPH_RULE.remove, ...(options.thresholds || {}) };
  const list = (Array.isArray(marks) ? marks : []).map((mark, index) => {
    const rect = mark?.rect;
    const usable = Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite);
    const norm = usable ? normRect(rect) : null;
    return { index, pageIndex: mark?.pageIndex, erase: mark?.mode === "erase", rect: norm && norm[2] > norm[0] && norm[3] > norm[1] ? norm : null };
  });
  const out = list.map((mark) => ({ index: mark.index, pageIndex: mark.pageIndex, path: "none", glyphs: 0, boxes: [] }));
  const pdfBytes = await bytesOf(source);
  if (!pdfBytes) return out;
  const loaded = await documentOf(pdfBytes, options.password);
  const byPage = new Map();
  for (const mark of list) {
    if (!mark.rect || !Number.isInteger(mark.pageIndex) || mark.pageIndex < 0 || (loaded && mark.pageIndex >= loaded.pageCount)) continue;
    if (!byPage.has(mark.pageIndex)) byPage.set(mark.pageIndex, []);
    byPage.get(mark.pageIndex).push(mark);
  }
  for (const [pageIndex, pageMarks] of byPage) {
    const strict = pageMarks.filter((mark) => !mark.erase);
    const erase = pageMarks.filter((mark) => mark.erase);
    const answer = (mark, path, code) => Object.assign(out[mark.index], code ? { path, reason: code } : { path });
    if (!loaded) {
      for (const mark of pageMarks) answer(mark, mark.erase ? "cover-needed" : "raster", "REDACT_DOCUMENT_NOT_EDITABLE");
      continue;
    }
    const dryRun = (strictRects, eraseRects) => removeTextInRects(loaded.doc, pageIndex, strictRects, { eraseRects, thresholds, fontCache: loaded.fontCache, dryRun: true, collectQuads: true });
    // the page as a whole, as the export settles it: the strict marks decide between editing and a picture
    const all = dryRun(strict.map((mark) => mark.rect), erase.map((mark) => mark.rect));
    if (all.status !== "ok") {
      const code = fallbackReason(all.reason, pageIndex).code;
      if (strict.length) {
        // (an "erase" mark on a page that becomes a picture is satisfied by the picture)
        for (const mark of pageMarks) answer(mark, "raster", code);
        continue;
      }
      for (const mark of erase) answer(mark, "cover-needed", code);
      continue;
    }
    // each mark on its own, for the glyphs that are its doing
    for (const mark of pageMarks) {
      const own = mark.erase ? dryRun([], [mark.rect]) : dryRun([mark.rect], []);
      if (own.status !== "ok") {
        answer(mark, mark.erase ? "cover-needed" : "raster", fallbackReason(own.reason, pageIndex).code);
        continue;
      }
      answer(mark, "precise");
      out[mark.index].glyphs = own.glyphsRemoved;
      out[mark.index].boxes = boxesOf(own.removedQuads, mark.rect);
    }
  }
  return out;
}
