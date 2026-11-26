// The last look of the pipeline at bytes it is about to hand on. Cheap, always on, and made with pdf.js only
// (env.openPdf): it shares no code with the engines that produced the bytes.
//
//   checkRedactionResult(result, targets)                  the answer of the redaction engine has the right shape
//   checkRedacted(bytes, targets, pageCount, env, signal)  the redacted document opens, has the job's pages and
//                                                          no text under a redact / pixelate / blur mark
//   checkOutput(bytes, pageCount, env, signal)             the finished file opens and has the job's pages
//
// Every failure is PdfEditorError("PIPELINE_SELF_CHECK_FAILED", { check, page }): the pipeline returns nothing.
// Errors of the env itself (a pdf.js worker that cannot start, a cancelled job) pass through as they are.
//
// TEXT UNDER A MARK. The redaction engine verifies its own output glyph by glyph; this is the pipeline asserting
// the same promise once more on the very bytes it got back, BEFORE the user's own objects are drawn (their
// text may legitimately lie over a mark). It reads the text items of pdf.js (page.getTextContent) and uses
// three facts:
//   1. The engine removes every glyph whose core box has its centre inside a mark (GLYPH_RULE). That centre
//      lies in the "core band" of its text item: between 0.10 em and 0.59 em above the baseline (the core of an
//      ordinary font is 0.10 .. 0.45 em, that of a Type3 font 28 % .. 59 % of its box), in the middle of the
//      glyph's advance.
//   2. pdf.js ends a text item at every gap wider than 0.6 em (SPACE_IN_FLOW_MAX_FACTOR of its text
//      extraction), so two neighbouring glyphs of ONE item are never further apart than that.
//   3. Hence a stretch of an item's core band that holds no glyph centre is at most 0.6 em plus the two half
//      glyphs at its ends. No glyph of real text is wider than 1.5 em or three times the average advance of
//      its item, whichever is larger.
// A text item therefore still has glyphs under a mark when
//   - its whole core band lies inside the mark (every glyph centre of the item is in there), or
//   - the mark holds a stretch of the core band longer than 0.6 em + max(1.5 em, 3 x average advance).
// The check is deliberately one-sided. It does not see a leftover shorter than that stretch inside a longer
// item, nor text under a mark thinner than the core band, and of vertical writing only the first case: the
// engine's own verification stays the authority, this is the second lock on the door. What it does catch is
// the failure that matters most here: bytes that were handed on without the redaction in them.
import { PdfEditorError, isPdfEditorError, throwIfAborted } from "../errors.js";
import { GLYPH_RULE } from "../redact/index.js";

/** The core band of a text item, in em above the baseline: where the centre of every glyph's core box lies. */
export const CORE_BAND = Object.freeze([Math.min(GLYPH_RULE.coreLow, GLYPH_RULE.type3CoreLow), Math.max(GLYPH_RULE.coreHigh, GLYPH_RULE.type3CoreHigh)]);
/** pdf.js starts a new text item at a gap wider than this (em). */
export const MAX_GAP_EM = 0.6;
/** No glyph of real text is wider than this (em), or than WIDE_GLYPH_FACTOR times the average advance of its item. */
export const WIDE_GLYPH_EM = 1.5;
export const WIDE_GLYPH_FACTOR = 3;

const OUTCOMES = Object.freeze(["precise", "raster", "cover-needed"]);
const PATHS = Object.freeze(["precise", "raster", "untouched"]);
const EDGE = 1e-6;
// white space of every kind, built from code points so that this file holds no invisible character
const BLANK = new RegExp(`^[\\s${String.fromCharCode(0xa0, 0x200b, 0xfeff)}]*$`);

const failed = (check, page = 0, detail, cause) => new PdfEditorError("PIPELINE_SELF_CHECK_FAILED", { check, page }, { detail, cause });

/**
 * The bytes and the rows of a redaction result, checked against the targets that were sent: one row per
 * target, in order, with an outcome that mode can have. Returns { bytes, rows, pages, warnings, fontsNotCleaned }
 * (fontsNotCleaned: [{ font, pageIndexes, reason }], reason = the engine's token or null).
 */
export function checkRedactionResult(result, targets) {
  const bad = (detail) => failed("redaction-result", 0, detail);
  if (!result || typeof result !== "object") throw bad("no result");
  if (!(result.bytes instanceof Uint8Array) || result.bytes.length === 0) throw bad("no bytes");
  const report = result.report;
  if (!report || typeof report !== "object" || !Array.isArray(report.targets) || !Array.isArray(report.pages)) throw bad("no report");
  if (report.targets.length !== targets.length) throw bad("the report does not have one row per target");
  report.targets.forEach((row, index) => {
    const target = targets[index];
    if (!row || row.index !== index || row.pageIndex !== target.pageIndex || row.mode !== target.mode || !OUTCOMES.includes(row.outcome)) throw bad(`row ${index} does not belong to its target`);
    // only the line of a replaced text may be left in the file; a redaction is removed or the engine throws
    if (row.outcome === "cover-needed" && target.mode !== "erase") throw bad(`row ${index}: a ${target.mode} target cannot need a cover`);
  });
  for (const page of report.pages) {
    if (!page || !Number.isInteger(page.pageIndex) || !PATHS.includes(page.path) || page.ok === false) throw bad("a page of the report is not verified");
  }
  // fonts that still hold letter shapes of removed text: [{ font, pageIndexes, reason }] (absent in a report without any)
  const fontsNotCleaned = [];
  for (const entry of Array.isArray(report.fontsNotCleaned) ? report.fontsNotCleaned : []) {
    if (!entry || typeof entry.font !== "string") continue;
    const pageIndexes = (Array.isArray(entry.pageIndexes) ? entry.pageIndexes : []).filter((index) => Number.isInteger(index) && index >= 0);
    fontsNotCleaned.push({ font: entry.font, pageIndexes, reason: typeof entry.reason === "string" && entry.reason ? entry.reason : null });
  }
  return { bytes: result.bytes, rows: report.targets, pages: report.pages, warnings: Array.isArray(report.warnings) ? report.warnings : [], fontsNotCleaned };
}

/** Opens bytes with pdf.js (a private copy: pdf.js takes the buffer it is given) and always closes them again. */
async function withDocument(bytes, env, check, work) {
  let doc;
  try {
    doc = await env.openPdf(new Uint8Array(bytes), {});
  } catch (error) {
    // a worker that cannot start or a cancelled job is not a property of the bytes
    if (isPdfEditorError(error)) throw error;
    throw failed(check, 0, "pdf.js cannot open the bytes", error);
  }
  try {
    return await work(doc);
  } finally {
    try {
      await (typeof env.closePdf === "function" ? env.closePdf(doc) : doc?.destroy?.());
    } catch {
      // already closed
    }
  }
}

/**
 * The part of the segment p -> q that lies inside an axis-aligned rectangle (Liang-Barsky): [enter, leave]
 * as fractions of the segment, or null when no part of it is inside. A segment of length zero is a point.
 */
export function clipSegment(p, q, rect) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let enter = 0;
  let leave = 1;
  const edges = [[-dx, p[0] - rect[0]], [dx, rect[2] - p[0]], [-dy, p[1] - rect[1]], [dy, rect[3] - p[1]]];
  for (const [direction, distance] of edges) {
    if (direction === 0) {
      if (distance < 0) return null;
    } else {
      const at = distance / direction;
      if (direction < 0) enter = Math.max(enter, at);
      else leave = Math.min(leave, at);
      if (enter > leave) return null;
    }
  }
  return [enter, leave];
}

/**
 * Does a text item of pdf.js (getTextContent) still hold glyphs under one of the rectangles? See the head of
 * this file for the rule. `vertical`: the item is written top to bottom (textContent.styles[fontName].vertical).
 */
export function itemUnderMark(item, vertical, rects) {
  if (!item || typeof item.str !== "string" || BLANK.test(item.str) || !Array.isArray(item.transform)) return false;
  const [a, b, c, d, e, f] = item.transform;
  const emAlong = Math.hypot(a, b);
  const emUp = Math.hypot(c, d);
  if (!(emAlong > 0) || !(emUp > 0) || ![e, f].every(Number.isFinite)) return false;
  if (vertical) {
    // the glyph centres of a column lie on its middle line, which starts at the item's origin and runs down
    if (!Number.isFinite(item.height)) return false;
    const end = [e - (c / emUp) * item.height, f - (d / emUp) * item.height];
    return rects.some((rect) => {
      const inside = clipSegment([e, f], end, rect);
      return Boolean(inside) && inside[0] <= EDGE && inside[1] >= 1 - EDGE;
    });
  }
  if (!Number.isFinite(item.width) || item.width < 0) return false;
  const along = [(a / emAlong) * item.width, (b / emAlong) * item.width];
  const edgeOf = (height) => {
    const from = [e + height * c, f + height * d];
    return [from, [from[0] + along[0], from[1] + along[1]]];
  };
  const [lowFrom, lowTo] = edgeOf(CORE_BAND[0]);
  const [highFrom, highTo] = edgeOf(CORE_BAND[1]);
  const characters = Array.from(item.str).length;
  const limit = MAX_GAP_EM * emAlong + Math.max(WIDE_GLYPH_EM * emAlong, (WIDE_GLYPH_FACTOR * item.width) / characters);
  for (const rect of rects) {
    // the stretch of the item over which BOTH edges of the core band are inside the mark (a rectangle is
    // convex: the band between them is inside then)
    const low = clipSegment(lowFrom, lowTo, rect);
    const high = low && clipSegment(highFrom, highTo, rect);
    if (!high) continue;
    const enter = Math.max(low[0], high[0]);
    const leave = Math.min(low[1], high[1]);
    if (leave < enter) continue;
    if (enter <= EDGE && leave >= 1 - EDGE) return true;
    if ((leave - enter) * item.width > limit) return true;
  }
  return false;
}

/**
 * The redacted document (stage B) before anything is drawn on it.
 * @param {Uint8Array} bytes
 * @param {Array<{ pageIndex: number, rect: number[], mode: string }>} targets  as sent to the engine; only the
 *        redact / pixelate / blur ones are looked at (an "erase" line may still be there: it gets a cover)
 * @param {number} pageCount  pages of the job
 * @param {{ openPdf: Function, closePdf?: Function }} env
 * @param {AbortSignal} [signal]
 * @param {(fraction: number) => void} [onProgress]
 */
export async function checkRedacted(bytes, targets, pageCount, env, signal, onProgress) {
  const byPage = new Map();
  for (const target of targets) {
    if (target.mode === "erase") continue;
    if (!byPage.has(target.pageIndex)) byPage.set(target.pageIndex, []);
    byPage.get(target.pageIndex).push(target.rect);
  }
  throwIfAborted(signal);
  await withDocument(bytes, env, "redaction-unreadable", async (doc) => {
    if (doc.numPages !== pageCount) throw failed("redaction-page-count", 0, `${doc.numPages} pages, the job has ${pageCount}`);
    let done = 0;
    for (const [pageIndex, rects] of [...byPage].sort((first, second) => first[0] - second[0])) {
      throwIfAborted(signal);
      let content;
      let page;
      try {
        page = await doc.getPage(pageIndex + 1);
        content = await page.getTextContent();
      } catch (error) {
        if (isPdfEditorError(error)) throw error;
        throw failed("redaction-unreadable", pageIndex + 1, "pdf.js cannot read the text of the page", error);
      }
      for (const item of content.items) {
        if (itemUnderMark(item, Boolean(content.styles?.[item.fontName]?.vertical), rects)) {
          // (no text in the error: what lies under a mark must not travel in a message or a log)
          throw failed("redaction-text", pageIndex + 1, "a text item of pdf.js still lies under a mark");
        }
      }
      page.cleanup?.();
      done += 1;
      onProgress?.(done / byPage.size);
    }
  });
  throwIfAborted(signal);
}

/** The finished file: pdf.js opens it and counts the pages of the job. */
export async function checkOutput(bytes, pageCount, env, signal) {
  throwIfAborted(signal);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw failed("output-unreadable", 0, "no bytes");
  await withDocument(bytes, env, "output-unreadable", async (doc) => {
    if (doc.numPages !== pageCount) throw failed("output-page-count", 0, `${doc.numPages} pages, the job has ${pageCount}`);
  });
  throwIfAborted(signal);
}
