// Thin helpers over the object model of the PDF library, the small matrix / polygon geometry of the
// redaction engine, and THE RULE that decides which glyphs a mark takes (GLYPH_RULE, shared by the remover,
// the text layer of a rasterised page and the verifier, so that the three can never disagree on purpose).
//
// The library comes from ../lib.js (the one place that names it). Everything here is synchronous and pure.
//
// Matrices are [a, b, c, d, e, f] as in a content stream. `mul(m1, m2)` applies m1 FIRST, then m2 (the
// row-vector convention of ISO 32000-1 8.3.4: "cm" multiplies from the left). This is the opposite order
// of multiplyMatrix() in ../geometry.js, which follows pdf.js; do not mix the two.
import { pdfLib } from "../lib.js";
import { normalizeRect, rectsIntersect as rectsIntersectShared } from "../geometry.js";
import { formatName } from "./contentStream.js";

const { PDFName, PDFNumber, PDFArray, PDFDict, PDFStream, PDFRawStream, PDFRef, PDFString, PDFHexString, PDFBool, PDFNull, decodePDFRawStream } = pdfLib;

/** A stream or object the engine cannot read: the caller turns it into a fallback reason, never into an error. */
export class UnsupportedPdfError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedPdfError";
  }
}

/** PDFName for a DECODED name (PDFName.of() decodes #xx itself, so "#" has to be escaped first). */
const N = (decoded) => PDFName.of(formatName(decoded).slice(1));
const isDict = (o) => o instanceof PDFDict;
const isArray = (o) => o instanceof PDFArray;
const isStream = (o) => o instanceof PDFStream;
const isRef = (o) => o instanceof PDFRef;
const isName = (o) => o instanceof PDFName;
const isNumber = (o) => o instanceof PDFNumber;
const isString = (o) => o instanceof PDFString || o instanceof PDFHexString;

const resolve = (context, o) => (o instanceof PDFRef ? context.lookup(o) : o);
/** dict[key] with indirect references resolved; undefined when absent or null. */
const get = (dict, key) => {
  if (!dict) return undefined;
  const d = dict instanceof PDFStream ? dict.dict : dict;
  if (!(d instanceof PDFDict)) return undefined;
  const v = d.lookup(typeof key === "string" ? N(key) : key);
  return v === PDFNull ? undefined : v;
};
/** dict[key] as stored (a PDFRef stays a PDFRef). */
const getRaw = (dict, key) => {
  if (!dict) return undefined;
  const d = dict instanceof PDFStream ? dict.dict : dict;
  return d instanceof PDFDict ? d.get(typeof key === "string" ? N(key) : key) : undefined;
};
const num = (o) => (o instanceof PDFNumber ? o.asNumber() : undefined);
const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : undefined);
const bool = (o) => (o instanceof PDFBool ? o.asBoolean() : undefined);
const getNum = (dict, key) => num(get(dict, key));
const getName = (dict, key) => nameOf(get(dict, key));
/** Array of numbers (elements resolved), or undefined when it is not an array of n numbers. */
const numArray = (o, n) => {
  if (!(o instanceof PDFArray)) return undefined;
  if (n !== undefined && o.size() !== n) return undefined;
  const out = [];
  for (let i = 0; i < o.size(); i++) {
    const v = num(o.lookup(i));
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
};
const stringBytes = (o) => (isString(o) ? o.asBytes() : undefined);
const sameRef = (a, b) => a === b || (a instanceof PDFRef && b instanceof PDFRef && a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber);

/**
 * Decoded bytes of a stream. Supports what the library's decoder supports (Flate, LZW, ASCII85, ASCIIHex,
 * RunLength) WITHOUT predictors; everything else throws UnsupportedPdfError.
 */
const streamBytes = (stream) => {
  if (!(stream instanceof PDFStream)) throw new UnsupportedPdfError("not a stream");
  if (stream instanceof PDFRawStream) {
    const parms = get(stream.dict, "DecodeParms") ?? get(stream.dict, "DP");
    const hasPredictor = (d) => d instanceof PDFDict && (getNum(d, "Predictor") ?? 1) > 1;
    if (hasPredictor(parms) || (parms instanceof PDFArray && parms.asArray().some((p) => hasPredictor(resolve(stream.dict.context, p))))) {
      throw new UnsupportedPdfError("stream uses a predictor");
    }
    if (getRaw(stream.dict, "F") !== undefined) throw new UnsupportedPdfError("stream data is in an external file");
    try {
      return decodePDFRawStream(stream).decode();
    } catch (err) {
      throw new UnsupportedPdfError(`stream cannot be decoded: ${err?.message || err}`);
    }
  }
  if (typeof stream.getUnencodedContents === "function") return stream.getUnencodedContents();
  throw new UnsupportedPdfError("unknown stream class");
};

/** Key identifying an object for caches: the reference when there is one, the object itself otherwise. */
const idOf = (raw) => (raw instanceof PDFRef ? `${raw.objectNumber} ${raw.generationNumber}` : raw);

/** The access helpers as one object (the ported modules call them as A.get(...), A.isDict(...)). */
export const A = Object.freeze({
  lib: pdfLib, N, isDict, isArray, isStream, isRef, isName, isNumber, isString, resolve, get, getRaw, num, nameOf, bool, getNum, getName, numArray,
  stringBytes, streamBytes, idOf, sameRef
});

// ---------------------------------------------------------------- small matrix / geometry helpers (shared)
/** [a b c d e f] x [a b c d e f]: apply m1 first, then m2 (row-vector convention of the PDF specification). */
export function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ];
}
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Inverse of a matrix, or null when it is singular (text with a degenerate matrix has no position). */
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!(Math.abs(det) > 1e-12)) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export const normRect = normalizeRect;
export const rectsIntersect = rectsIntersectShared;

/** Area of a simple polygon given as [x0, y0, x1, y1, ...] (absolute value). */
export function polygonArea(p) {
  let s = 0;
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(s) / 2;
}

/** Sutherland-Hodgman: clips a convex polygon [x0, y0, ...] to the axis-aligned rect [x0, y0, x1, y1]. */
export function clipPolygonToRect(poly, r) {
  let cur = poly;
  // each edge: inside test and intersection with the boundary
  const edges = [
    [(x) => x >= r[0], 0, r[0]],
    [(x) => x <= r[2], 0, r[2]],
    [(_, y) => y >= r[1], 1, r[1]],
    [(_, y) => y <= r[3], 1, r[3]]
  ];
  for (const [inside, axis, bound] of edges) {
    const out = [];
    const n = cur.length;
    if (!n) break;
    for (let i = 0; i < n; i += 2) {
      const ax = cur[i];
      const ay = cur[i + 1];
      const bx = cur[(i + 2) % n];
      const by = cur[(i + 3) % n];
      const ain = inside(ax, ay);
      const bin = inside(bx, by);
      if (ain) out.push(ax, ay);
      if (ain !== bin) {
        const t = axis === 0 ? (bound - ax) / (bx - ax) : (bound - ay) / (by - ay);
        out.push(ax + t * (bx - ax), ay + t * (by - ay));
      }
    }
    cur = out;
  }
  return cur;
}

// ---------------------------------------------------------------- the removal rule (shared by remover and verifier)
/**
 * Which glyphs does a target take?
 *
 * Every glyph has two boxes:
 *   full   advance width x [descent, ascent] of its font (what a text layer highlights)
 *   core   advance width x [0.10 em, 0.45 em] above the baseline: the lower part of the x-height band, where
 *          practically every letter and digit has ink and where the boxes of neighbouring LINES never reach,
 *          however tight the leading (Type3 fonts have no reliable em: 28 % .. 59 % of the height of their box;
 *          vertical writing: the middle half of the glyph cell across the column)
 * A glyph is removed when
 *   - the centre of its core box is inside a target, or
 *   - more than `core` (25 %) of its core box is inside the targets, or
 *   - more than `full` (25 %) of its full box is inside the targets.
 * Why a quarter (the measured choice; do not change it without repeating the measurement):
 *   - a box drawn exactly around one line covers about 10 % of the full boxes of the lines above and below when
 *     the leading is 1.0, about 19 % when it is 0.9, and 0.5 pt of padding covers 19 % of an "i" set in 12 pt:
 *     a smaller threshold eats the neighbours. Measured on the redaction benchmark (192 targets, 33 files) with
 *     remove thresholds (core, full) = 0.05/0.05, 0.05/0.25, 0.15/0.25, 0.25/0.25 and 0.50/0.50: removal passed
 *     on the same files and the same 65 pages stayed vector in all five runs, but of the 8 text items that only
 *     graze a target 2, 2, 3, 4 and 4 survived untouched. A quarter is therefore the smallest threshold that
 *     costs no neighbour; the four items that still change hold glyphs that really lie inside a target (rotated
 *     lines that cross the box, the end of a longer line). A larger threshold gains nothing and would leave a
 *     glyph that is half covered;
 *   - no glyph of the measured fonts (Arial, Times New Roman) has all of its ink inside a quarter of its box at
 *     the left or right edge; at the bottom edge only the underscore and the cedilla have, at the top edge only
 *     the macron: a glyph that is kept is never a glyph that the box hides completely, with those exceptions;
 *   - the core clause still takes every glyph whose body is crossed by a thin box (a strike-through shaped
 *     target covers little of the full box but much of the core).
 * The verifier uses the same rule with wider thresholds (core 30 %, full 40 %): the core box is identical on
 * both sides (it does not depend on font metrics), the full box may differ a little (pdf.js takes ascent and
 * descent from the font program, the remover from the font descriptor). The gap between the two pairs absorbs
 * those differences; where the two readings disagree by more than the gap the page fails its verification and
 * takes the raster path (or, for an "erase" target, is reported as "cover-needed").
 */
export const GLYPH_RULE = Object.freeze({
  coreLow: 0.1,
  coreHigh: 0.45,
  type3CoreLow: 0.28,
  type3CoreHigh: 0.59,
  verticalCoreHalfWidth: 0.25,
  remove: Object.freeze({ core: 0.25, full: 0.25 }),
  verify: Object.freeze({ core: 0.3, full: 0.4 })
});

/**
 * Applies the rule. quad / core: [x0,y0, ...] (4 corners each); rects: normalised targets;
 * thresholds: GLYPH_RULE.remove or GLYPH_RULE.verify (or { core, full }).
 * Returns { hit, core, full, centreInside } (fractions; `full` is only computed when the core did not decide).
 */
export function glyphInTargets(quad, core, rects, thresholds = GLYPH_RULE.remove) {
  const c = quadCoverage(core, rects);
  if (c.centreInside || c.fraction > thresholds.core) return { hit: true, core: c.fraction, full: null, centreInside: c.centreInside };
  const f = quadCoverage(quad, rects);
  // a degenerate full box (zero-width glyph) reports 1 when its centre is inside a target
  return { hit: f.fraction > thresholds.full, core: c.fraction, full: f.fraction, centreInside: false };
}

/**
 * How much of a glyph box lies inside the target rectangles.
 *   quad    [x0,y0, x1,y1, x2,y2, x3,y3] (a parallelogram, any orientation)
 *   rects   [[x0,y0,x1,y1], ...] normalised, axis-aligned
 * Returns { fraction, centreInside }: fraction = sum over the rects of area(quad inside rect) / area(quad)
 * (overlapping rects count twice: the error is on the side of removing); for a degenerate (zero-area) quad the
 * fraction is 1 when its centre is inside a rect and 0 otherwise.
 */
export function quadCoverage(quad, rects) {
  let minX = quad[0];
  let maxX = quad[0];
  let minY = quad[1];
  let maxY = quad[1];
  for (let i = 2; i < 8; i += 2) {
    if (quad[i] < minX) minX = quad[i];
    else if (quad[i] > maxX) maxX = quad[i];
    if (quad[i + 1] < minY) minY = quad[i + 1];
    else if (quad[i + 1] > maxY) maxY = quad[i + 1];
  }
  const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  let centreInside = false;
  let inter = 0;
  let touched = false;
  for (const r of rects) {
    if (maxX < r[0] || minX > r[2] || maxY < r[1] || minY > r[3]) continue;
    touched = true;
    if (cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]) centreInside = true;
    inter += polygonArea(clipPolygonToRect(quad, r));
  }
  if (!touched) return { fraction: 0, centreInside: false };
  const area = polygonArea(quad);
  if (!(area > 1e-9)) return { fraction: centreInside ? 1 : 0, centreInside };
  return { fraction: inter / area, centreInside };
}
