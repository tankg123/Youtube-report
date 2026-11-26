// Independent checks on the OUTPUT of a redaction, made with pdf.js only.
//
// Nothing here uses the bookkeeping of the code that removed the text: the page is read again with pdf.js
// (glyphs from the operator list, text items from getTextContent, pixels from a render) and compared with
// what pdf.js read from the ORIGINAL page. redactPdf.js runs these checks on the very bytes it returns and
// refuses to return them when one fails.
//
//   snapshotPage(page, pdfjs)                         -> { glyphs, items, text, view, rotate, userUnit }
//   verifyPageText(before, after, rects, options)     -> { ok, failures, warnings, stats }      (checks G1 G2 G3 I1)
//   verifyRasterPage(before, after, rects, options)   -> { ok, failures, warnings, stats }      (checks G1 G3 + layer)
//   compareUntouchedPage(before, after, options)      -> { ok, reason }                         (a page without marks:
//                                                        two readings by pageGlyphs(), packed or as glyph objects)
//   renderForCheck(page, pdfjs, createCanvas, opts)   -> { canvas, ctx, viewport }
//   checkRegions(page, pdfjs, createCanvas, regions, options) -> { ok, regions: [...] }         (check G4: pixels)
//
// G1 removal       no glyph of the output is in a target by the removal rule (GLYPH_RULE in pdfAccess.js, with
//                  the wider thresholds of the verifier); glyphs of annotation appearances included
// G2 preservation  every glyph of the input that is clearly away from all targets is still there, in the same
//                  order, with the same text and at the same place; no glyph was added; and the font it is
//                  drawn with still loads (a font program that pdf.js can no longer use would leave the text
//                  in place for a text extractor and draw it in a replacement font)
// G3 strings       the text of every run of 4+ removed glyphs occurs less often in the output page text
// I1 items         (warning only) text items of pdf.js that still span a target: a hole narrower than 0.6 em
//                  does not split an item
// G4 pixels        what a render of the output shows in the target region:
//                    blank     one flat colour, apart from the boxes of glyphs that were knowingly kept (the
//                              precise path BEFORE anything is painted: nothing but paper may be left there)
//                    painted   one flat colour, the colour of the box
//                    obscured  no fine detail compared with the same region of the original (a mosaic)
//
// PRIVACY: failures and warnings carry checks, counts and positions, never text of the document (a report
// may be logged; what a mark removes must not travel in it).
import { pageGlyphs } from "./pdfjsGlyphs.js";
import { normRect, quadCoverage, glyphInTargets, GLYPH_RULE } from "./pdfAccess.js";

export const VERIFY_DEFAULTS = Object.freeze({
  thresholds: GLYPH_RULE.verify, // G1: the removal rule with wider thresholds (core 30 %, full 40 %; the remover uses 25 % / 25 %)
  itemThreshold: 0.1, // I1 and the text layer check: share of a pdf.js text item inside the targets
  positionTolerance: 0.05, // G2: points
  minRunLength: 4, // G3
  pixelTolerance: 12, // G4 blank: levels per channel around the dominant colour
  maxOutlierPixels: 2, // G4 blank / painted
  renderScale: 2, // G4: pixels per point
  paintedTolerance: 48, // G4 painted (JPEG ringing stays below this)
  detailTilePt: 24, // G4 obscured: fine detail is measured per tile of this edge, the busiest tile counts
  obscuredRatio: 0.6, // G4 obscured: the busiest tile of the output may have at most this share of the original's detail ...
  obscuredFloor: 16 // ... or this much (levels): the edges between the blocks of a mosaic (12 pt or more) stay below 11
});

// White space of every kind, built from code points (no-break space, zero-width space, BOM) so that the
// source holds no invisible characters.
const WHITE_SPACE = new RegExp(`[\\s${String.fromCharCode(0xa0, 0x200b, 0xfeff)}]+`, "g");
/** Comparison form of extracted text: NFC, all white space removed. */
export const squash = (s) => s.normalize("NFC").replace(WHITE_SPACE, "");
const ITEM_SEPARATOR = String.fromCharCode(0);
const round2 = (v) => Math.round(v * 100) / 100;

function itemGeometry(item, style) {
  const [a, b, c, d, e, f] = item.transform;
  const lenU = Math.hypot(a, b);
  const lenV = Math.hypot(c, d);
  if (!(lenU > 0) || !(lenV > 0)) return null;
  const ux = a / lenU;
  const uy = b / lenU;
  const vx = c / lenV;
  const vy = d / lenV;
  let t0;
  let t1;
  let s0;
  let s1;
  if (style?.vertical) {
    t0 = -item.width / 2;
    t1 = item.width / 2;
    s0 = -item.height;
    s1 = 0;
  } else {
    let ascent = style?.ascent;
    let descent = style?.descent;
    if (!Number.isFinite(ascent) || !ascent) ascent = Number.isFinite(descent) && descent ? 1 + descent : 0.8;
    if (!Number.isFinite(descent) || !descent) descent = ascent - 1;
    if (descent > 0) descent = -descent;
    t0 = 0;
    t1 = item.width;
    s0 = descent * lenV;
    s1 = ascent * lenV;
  }
  const pt = (t, s) => [e + ux * t + vx * s, f + uy * t + vy * s];
  const q = [pt(t0, s0), pt(t1, s0), pt(t1, s1), pt(t0, s1)];
  const quad = q.flat();
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  return { quad, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], angle: (Math.atan2(b, a) * 180) / Math.PI, size: lenV };
}

/** Everything the verifier needs from one page, read with pdf.js. */
export async function snapshotPage(page, pdfjs, { annotations = true } = {}) {
  const tc = await page.getTextContent();
  const items = [];
  let text = "";
  for (const it of tc.items) {
    if (typeof it.str !== "string") continue;
    text += it.str;
    if (it.hasEOL) text += "\n";
    const style = tc.styles[it.fontName];
    const geom = itemGeometry(it, style);
    if (!geom) continue;
    items.push({ str: it.str, dir: it.dir, vertical: !!style?.vertical, transform: it.transform, width: it.width, height: it.height, fontName: it.fontName, hasEOL: !!it.hasEOL, ...geom });
  }
  const { glyphs } = await pageGlyphs(page, pdfjs, { annotations, styles: tc.styles });
  return { glyphs, items, text, view: page.view.slice(), rotate: page.rotate, userUnit: page.userUnit ?? 1 };
}

/** The quad grown across the writing direction (and a little along it): "clearly away" means this misses every target. */
function inflate(quad, factor = 0.35, vertical = false) {
  // corners: 0 = (start, low), 1 = (end, low), 2 = (end, high), 3 = (start, high)
  let ux = quad[6] - quad[0]; // across the line (horizontal writing)
  let uy = quad[7] - quad[1];
  let wx = quad[2] - quad[0]; // along the line
  let wy = quad[3] - quad[1];
  const ul = Math.hypot(ux, uy) || 1;
  const wl = Math.hypot(wx, wy) || 1;
  // the big margin goes across the writing direction, where the two sides may assume different box heights
  const fu = vertical ? (0.05 * Math.max(wl, 1)) / ul : factor;
  const fw = vertical ? factor : (0.05 * Math.max(ul, 1)) / wl;
  ux *= fu;
  uy *= fu;
  wx *= fw;
  wy *= fw;
  return [
    quad[0] - ux - wx, quad[1] - uy - wy,
    quad[2] - ux + wx, quad[3] - uy + wy,
    quad[4] + ux + wx, quad[5] + uy + wy,
    quad[6] + ux - wx, quad[7] + uy - wy
  ];
}

const isIn = (glyph, rects, thresholds) => glyphInTargets(glyph.quad, glyph.core, rects, thresholds).hit;

function classify(glyph, rects, thresholds) {
  if (isIn(glyph, rects, thresholds)) return "in";
  const near = quadCoverage(inflate(glyph.quad, 0.35, glyph.vertical), rects);
  if (glyph.zeroWidth || near.fraction > 0 || near.centreInside) return "edge";
  return "out";
}

const sameGlyph = (a, b, tol) =>
  a.unicode === b.unicode
  && Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1]) <= tol
  && Math.hypot(a.quad[2] - a.quad[0] - (b.quad[2] - b.quad[0]), a.quad[3] - a.quad[1] - (b.quad[3] - b.quad[1])) <= tol;

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

function removedRuns(before, rects, opts) {
  // maximal runs of consecutive input glyphs (content order) that must go
  const runs = [];
  let cur = "";
  for (const g of before.glyphs) {
    if (g.inAnnotation && !opts.includeAnnotations) continue;
    if (isIn(g, rects, opts.thresholds)) cur += g.unicode;
    else if (cur) {
      runs.push(cur);
      cur = "";
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

/**
 * The text of every run of consecutive glyphs of a page that the targets take, as pdf.js reads it.
 *   options   { thresholds (default: those of the verifier), includeAnnotations (false): also the text of
 *               annotation appearances, which a strict target removes with the annotation }
 * The strings are document text: they are for searching (documentScrub.findTextElsewhere), never for a report.
 */
export function removedText(before, rects, options = {}) {
  return removedRuns(before, rects.map(normRect), { ...VERIFY_DEFAULTS, ...options });
}

function checkStrings(before, after, rects, opts, failures, stats) {
  const runs = removedRuns(before, rects, opts);
  const wanted = new Map();
  for (const r of runs) {
    const s = squash(r);
    if ([...s].length >= opts.minRunLength) wanted.set(s, (wanted.get(s) || 0) + 1);
  }
  const inText = squash(before.text);
  // the text of annotation appearances is not in getTextContent(), but a page that became a picture carries it
  // in its text layer: the glyph stream of the input (annotations included) is the second reference
  const inGlyphText = squash(before.glyphs.map((g) => g.unicode).join(""));
  const outText = squash(after.text);
  // occurrences that only exist across two text items of the output are artefacts of joining, not text
  const outSeparated = after.items.map((it) => squash(it.str)).join(ITEM_SEPARATOR);
  stats.removedRuns = runs.length;
  stats.checkedStrings = wanted.size;
  for (const [s, times] of wanted) {
    const was = Math.max(countOccurrences(inText, s), countOccurrences(inGlyphText, s));
    if (was === 0) continue; // pdf.js does not report this text (outside the page view, for example)
    const allowed = Math.max(0, was - times);
    const found = countOccurrences(outSeparated, s);
    if (countOccurrences(outText, s) > allowed && found > allowed) {
      failures.push({ check: "G3-strings", message: `removed text still occurs ${found} time(s), at most ${allowed} expected`, count: found, length: [...s].length });
    }
  }
}

function checkRemoval(after, rects, opts, failures) {
  let offenders = 0;
  // text-only targets ("erase") take page text only: there the glyphs of annotation appearances may stay
  const annotationRects = opts.annotationRects ? opts.annotationRects.map(normRect) : rects;
  for (const g of after.glyphs) {
    const list = g.inAnnotation ? annotationRects : rects;
    if (!list.length || !isIn(g, list, opts.thresholds)) continue;
    offenders++;
    if (offenders <= 12) failures.push({ check: "G1-removal", message: `a glyph is still in a target${g.inAnnotation ? " (annotation appearance)" : ""}`, inAnnotation: g.inAnnotation, at: g.origin.map(round2), quad: g.quad.map(round2), core: g.core.map(round2) });
  }
  return offenders;
}

function spanningItems(after, rects, opts) {
  let count = 0;
  for (const it of after.items) {
    if (!squash(it.str)) continue;
    const cov = quadCoverage(it.quad, rects);
    if (cov.centreInside || cov.fraction > opts.itemThreshold) count++;
  }
  return count;
}

/**
 * Checks G1, G2, G3 (and I1 as a warning) for a page whose content was edited in place.
 * before / after: snapshotPage() of the original and of the output page. rects: targets in user space (with
 * no target at all this is the check "the page is unchanged").
 * options: VERIFY_DEFAULTS overrides + annotationRects (the targets that also take annotation glyphs).
 */
export function verifyPageText(before, after, rects, options = {}) {
  const opts = { ...VERIFY_DEFAULTS, ...options };
  const targets = rects.map(normRect);
  const failures = [];
  const warnings = [];
  const stats = { glyphsBefore: before.glyphs.length, glyphsAfter: after.glyphs.length, removed: 0, lost: 0, added: 0 };

  // G1
  stats.remainingInTargets = checkRemoval(after, targets, opts, failures);

  // G2: walk both glyph sequences of the page content (annotation appearances are compared by G1 only)
  const a = before.glyphs.filter((g) => !g.inAnnotation);
  const b = after.glyphs.filter((g) => !g.inAnnotation);
  let j = 0;
  let fontsLost = 0;
  const lost = [];
  for (const g of a) {
    if (j < b.length && sameGlyph(g, b[j], opts.positionTolerance)) {
      if (g.fontMissing === false && b[j].fontMissing === true) fontsLost++;
      j++;
      continue;
    }
    stats.removed++;
    if (classify(g, targets, opts.thresholds) === "out") lost.push(g);
  }
  stats.lost = lost.length;
  stats.added = b.length - j;
  if (lost.length) {
    failures.push({ check: "G2-preservation", message: `${lost.length} glyph(s) away from every target are missing or moved`, count: lost.length, at: lost[0].origin.map(round2) });
  }
  if (stats.added) failures.push({ check: "G2-preservation", message: `${stats.added} glyph(s) of the output have no counterpart in the input`, count: stats.added });
  stats.fontsLost = fontsLost;
  if (fontsLost) failures.push({ check: "G2-preservation", message: `${fontsLost} glyph(s) that stayed are drawn with a font that no longer loads`, count: fontsLost, fonts: true });

  // G3
  checkStrings(before, after, targets, opts, failures, stats);

  // I1
  const spans = targets.length ? spanningItems(after, targets, opts) : 0;
  if (spans) warnings.push({ check: "I1-items", message: `${spans} text item(s) of pdf.js still span a target (their glyphs in it are gone)`, count: spans });
  stats.spanningItems = spans;
  return { ok: failures.length === 0, failures, warnings, stats };
}

/**
 * A page that no mark touches must come out as it went in. The PDF library and pdf.js read a file in different
 * ways (the library takes the last definition of an object in the file, pdf.js follows the cross-reference
 * table; they repair damage differently), and the library writes what IT read: without this check a page could
 * show after the job what no viewer showed before it.
 *   before / after   pageGlyphs(page, pdfjs, { annotations: false }) of the page in the input and in the output,
 *                    both with `compact: true` (no object per glyph: a long document has hundreds of such
 *                    pages) or both without
 * Compared: the sequence of drawing operators (signature), every glyph (text, place, advance) and the fonts
 * (one that loaded must still load). Annotation appearances are left out: a job may empty a form field whose
 * other widget lies on this page.
 * Returns { ok, reason: null | "operators" | "glyphs" | "fonts" }.
 */
export function compareUntouchedPage(before, after, options = {}) {
  const tolerance = options.positionTolerance ?? VERIFY_DEFAULTS.positionTolerance;
  if (before.signature !== after.signature) return { ok: false, reason: "operators" };
  if (before.packed && after.packed) {
    const a = before.packed;
    const b = after.packed;
    if (a.count !== b.count) return { ok: false, reason: "glyphs" };
    // (numbers that are equal, or both not numbers, are the same reading; otherwise the distance decides)
    const same = (p, q) => p === q || (Number.isNaN(p) && Number.isNaN(q));
    const near = (i, j) => (same(a.numbers[i], b.numbers[i]) && same(a.numbers[j], b.numbers[j])) || Math.hypot(a.numbers[i] - b.numbers[i], a.numbers[j] - b.numbers[j]) <= tolerance;
    for (let g = 0; g < a.count; g++) {
      if (a.unicode[g] !== b.unicode[g] || !near(g * 4, g * 4 + 1) || !near(g * 4 + 2, g * 4 + 3)) return { ok: false, reason: "glyphs" };
      if (a.fontMissing[g] === 0 && b.fontMissing[g] === 1) return { ok: false, reason: "fonts" };
    }
    return { ok: true, reason: null };
  }
  if (before.glyphs.length !== after.glyphs.length) return { ok: false, reason: "glyphs" };
  for (let i = 0; i < before.glyphs.length; i++) {
    if (!sameGlyph(before.glyphs[i], after.glyphs[i], tolerance)) return { ok: false, reason: "glyphs" };
    if (before.glyphs[i].fontMissing === false && after.glyphs[i].fontMissing === true) return { ok: false, reason: "fonts" };
  }
  return { ok: true, reason: null };
}

/**
 * Checks for a page that was replaced by a picture with an invisible text layer: G1 on the layer, G3, and how
 * much of the text that did not touch a target came back (reported, a low share is a warning).
 */
export function verifyRasterPage(before, after, rects, options = {}) {
  const opts = { ...VERIFY_DEFAULTS, ...options };
  const targets = rects.map(normRect);
  const failures = [];
  const warnings = [];
  const stats = { glyphsBefore: before.glyphs.length, glyphsAfter: after.glyphs.length };
  stats.remainingInTargets = checkRemoval(after, targets, opts, failures);
  checkStrings(before, after, targets, opts, failures, stats);
  // I1 (warning, as for an edited page): pdf.js joins the words on both sides of a narrow hole into one item
  const spans = spanningItems(after, targets, opts);
  if (spans) warnings.push({ check: "I1-items", message: `${spans} text item(s) of pdf.js span a target (their glyphs in it are gone)`, count: spans });
  stats.spanningItems = spans;
  // text layer fidelity
  const clear = (it) => quadCoverage(it.quad, targets).fraction === 0 && squash(it.str);
  const expected = before.items.filter(clear);
  const outText = squash(after.text);
  let found = 0;
  let aligned = 0;
  let maxOffset = 0;
  for (const e of expected) {
    const s = squash(e.str);
    if (outText.includes(s)) found++;
    const hit = after.items.find((o) => squash(o.str) === s && Math.hypot(o.transform[4] - e.transform[4], o.transform[5] - e.transform[5]) <= 2 && Math.abs(o.width - e.width) <= 2);
    if (hit) {
      aligned++;
      maxOffset = Math.max(maxOffset, Math.hypot(hit.transform[4] - e.transform[4], hit.transform[5] - e.transform[5]), Math.abs(hit.width - e.width));
    }
  }
  stats.layerItemsExpected = expected.length;
  stats.layerTextFound = found;
  stats.layerItemsAligned = aligned;
  stats.layerMaxOffset = Math.round(maxOffset * 1000) / 1000;
  if (expected.length && found < expected.length) warnings.push({ check: "layer", message: `${expected.length - found} of ${expected.length} text items could not be put into the text layer`, count: expected.length - found });
  return { ok: failures.length === 0, failures, warnings, stats };
}

// ---------------------------------------------------------------- pixels
function fillPolygonMask(mask, w, h, pts) {
  // scanline fill of a convex polygon [[x, y], ...] into a Uint8Array mask (1 = masked)
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    let xa = Infinity;
    let xb = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      const lo = Math.min(p[1], q[1]);
      const hi = Math.max(p[1], q[1]);
      if (y + 1 < lo || y > hi) continue;
      // the span of the edge over the row [y, y + 1]
      for (const yy of [Math.max(lo, y), Math.min(hi, y + 1)]) {
        const t = hi === lo ? 0 : (yy - p[1]) / (q[1] - p[1]);
        const x = p[0] + t * (q[0] - p[0]);
        if (x < xa) xa = x;
        if (x > xb) xb = x;
      }
      if (hi === lo) {
        xa = Math.min(xa, p[0], q[0]);
        xb = Math.max(xb, p[0], q[0]);
      }
    }
    if (xa === Infinity) continue;
    const s = Math.max(0, Math.floor(xa));
    const e = Math.min(w - 1, Math.ceil(xb));
    for (let x = s; x <= e; x++) mask[y * w + x] = 1;
  }
}

/**
 * Statistics of the pixels of a region: dominant colour and the number of pixels that differ from it by more
 * than `tolerance` on some channel. `mask` (optional) marks pixels to ignore.
 * data: RGBA bytes of the region (w x h).
 */
export function regionFlatness(data, w, h, tolerance, mask) {
  // dominant colour: the most frequent colour after quantising to 4 bits per channel, then the mean of that bin
  const bins = new Map();
  let counted = 0;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (mask && mask[i]) continue;
    counted++;
    const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
    const b = bins.get(key);
    if (b) {
      b[0]++;
      b[1] += data[p];
      b[2] += data[p + 1];
      b[3] += data[p + 2];
    } else bins.set(key, [1, data[p], data[p + 1], data[p + 2]]);
  }
  if (!counted) return { pixels: 0, outliers: 0, dominant: null, range: 0 };
  let best = null;
  for (const b of bins.values()) if (!best || b[0] > best[0]) best = b;
  const dom = [best[1] / best[0], best[2] / best[0], best[3] / best[0]];
  let outliers = 0;
  let range = 0;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (mask && mask[i]) continue;
    const d = Math.max(Math.abs(data[p] - dom[0]), Math.abs(data[p + 1] - dom[1]), Math.abs(data[p + 2] - dom[2]));
    if (d > range) range = d;
    if (d > tolerance) outliers++;
  }
  return { pixels: counted, outliers, dominant: dom.map((v) => Math.round(v)), range: Math.round(range) };
}

/**
 * Fine detail of a region: the mean absolute difference between neighbouring pixels (luminance), per tile of
 * `tile` pixels. Returns { mean, max } over the tiles that have enough unmasked pixels. Text has a lot of it
 * (every stem is two edges), a mosaic has almost none (only the edges between its blocks).
 */
export function regionDetail(data, w, h, tile, mask) {
  const size = Math.max(4, Math.round(tile));
  const lum = (p) => (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  let total = 0;
  let pairs = 0;
  let max = 0;
  for (let ty = 0; ty < h; ty += size) {
    for (let tx = 0; tx < w; tx += size) {
      let sum = 0;
      let n = 0;
      const yEnd = Math.min(h, ty + size);
      const xEnd = Math.min(w, tx + size);
      for (let y = ty; y < yEnd; y++) {
        for (let x = tx; x < xEnd; x++) {
          const i = y * w + x;
          if (mask && mask[i]) continue;
          const value = lum(i * 4);
          if (x + 1 < w && !(mask && mask[i + 1])) {
            sum += Math.abs(value - lum((i + 1) * 4));
            n++;
          }
          if (y + 1 < h && !(mask && mask[i + w])) {
            sum += Math.abs(value - lum((i + w) * 4));
            n++;
          }
        }
      }
      total += sum;
      pairs += n;
      // a sliver of a tile at the edge of the region says little: it needs a quarter of a full tile
      if (n >= (size * size) / 2 && sum / n > max) max = sum / n;
    }
  }
  const mean = pairs ? total / pairs : 0;
  return { mean: Math.round(mean * 100) / 100, max: Math.round(Math.max(max, mean) * 100) / 100 };
}

/** Renders a page for the pixel checks: rotation 0 (the orientation of user space), white paper, annotations drawn. */
export async function renderForCheck(page, pdfjs, createCanvas, { scale = VERIFY_DEFAULTS.renderScale, annotations = true } = {}) {
  const viewport = page.getViewport({ scale, rotation: 0 });
  const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  const ctx = canvas.getContext("2d");
  await page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    background: "white",
    annotationMode: annotations ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE
  }).promise;
  return { canvas, ctx, viewport };
}

/**
 * G4: renders the page and looks at the target regions.
 *   regions   [{ rect, expect: "blank" | "painted" | "obscured" | "any", color?: [r, g, b], ignore?: rect[] }]
 *             blank    = flat colour apart from kept glyphs (precise path, before anything is painted)
 *             painted  = flat colour (after a solid box was painted / burned in); `color` is then compared too
 *             obscured = no fine detail left compared with options.reference (a pixelated / blurred region)
 *             any      = not checked (an "erase" region on a page that stays vector: the paper is untouched)
 *             ignore   = rectangles that another box covers afterwards
 *   options   { renderScale, pixelTolerance, maxOutlierPixels, paintedTolerance, keptGlyphs (snapshot.glyphs of
 *               the output), annotations (default true), canvas (reuse a render: { canvas, ctx, viewport }),
 *               reference (renderForCheck() of the ORIGINAL page at the same scale, needed for "obscured") }
 * The page is only rendered when a region needs pixels.
 * Returns { ok, regions: [{ rect, expect, ok, pixels, outliers, dominant, range, ... }], render }.
 */
export async function checkRegions(page, pdfjs, createCanvas, regions, options = {}) {
  const opts = { ...VERIFY_DEFAULTS, ...options };
  let render = options.canvas || null;
  if (!render && regions.some((r) => r.expect !== "any")) {
    render = await renderForCheck(page, pdfjs, createCanvas, { scale: opts.renderScale, annotations: options.annotations !== false });
  }
  const out = [];
  for (const region of regions) {
    const rect = normRect(region.rect);
    const res = { rect, expect: region.expect };
    if (region.expect === "any") {
      out.push({ ...res, ok: true, skipped: true });
      continue;
    }
    const { canvas, ctx, viewport } = render;
    const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
    const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
    // one pixel inside the rectangle: the edge pixels mix with what lies outside
    const px0 = Math.max(0, Math.ceil(Math.min(ax, bx)) + 1);
    const py0 = Math.max(0, Math.ceil(Math.min(ay, by)) + 1);
    const px1 = Math.min(canvas.width, Math.floor(Math.max(ax, bx)) - 1);
    const py1 = Math.min(canvas.height, Math.floor(Math.max(ay, by)) - 1);
    const w = px1 - px0;
    const h = py1 - py0;
    if (w <= 0 || h <= 0) {
      out.push({ ...res, ok: true, pixels: 0, note: "region smaller than 3 pixels or outside the page" });
      continue;
    }
    const { data } = ctx.getImageData(px0, py0, w, h);
    let mask = null;
    if (region.expect === "blank" && opts.keptGlyphs) {
      for (const g of opts.keptGlyphs) {
        if (g.invisible) continue;
        const q = inflate(g.quad, 0.3, g.vertical);
        // quick reject on the bounding box of the glyph
        let gx0 = Infinity;
        let gy0 = Infinity;
        let gx1 = -Infinity;
        let gy1 = -Infinity;
        for (let k = 0; k < 8; k += 2) {
          gx0 = Math.min(gx0, q[k]);
          gx1 = Math.max(gx1, q[k]);
          gy0 = Math.min(gy0, q[k + 1]);
          gy1 = Math.max(gy1, q[k + 1]);
        }
        if (gx1 < rect[0] || gx0 > rect[2] || gy1 < rect[1] || gy0 > rect[3]) continue;
        mask ??= new Uint8Array(w * h);
        const pts = [];
        for (let k = 0; k < 8; k += 2) {
          const [vx, vy] = viewport.convertToViewportPoint(q[k], q[k + 1]);
          pts.push([vx - px0, vy - py0]);
        }
        // one more pixel for anti-aliasing
        const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
        const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
        fillPolygonMask(mask, w, h, pts.map((p) => [p[0] + Math.sign(p[0] - cx) * 1.5, p[1] + Math.sign(p[1] - cy) * 1.5]));
      }
    }
    for (const other of region.ignore || []) {
      // pixels that another box covers afterwards are not this region's business
      const o = normRect(other);
      const [cx, cy] = viewport.convertToViewportPoint(o[0], o[1]);
      const [dx, dy] = viewport.convertToViewportPoint(o[2], o[3]);
      const ox0 = Math.max(0, Math.floor(Math.min(cx, dx)) - 1 - px0);
      const oy0 = Math.max(0, Math.floor(Math.min(cy, dy)) - 1 - py0);
      const ox1 = Math.min(w, Math.ceil(Math.max(cx, dx)) + 1 - px0);
      const oy1 = Math.min(h, Math.ceil(Math.max(cy, dy)) + 1 - py0);
      if (ox1 <= ox0 || oy1 <= oy0) continue;
      mask ??= new Uint8Array(w * h);
      for (let yy = oy0; yy < oy1; yy++) mask.fill(1, yy * w + ox0, yy * w + ox1);
    }
    const masked = mask ? mask.reduce((s, v) => s + v, 0) : 0;
    if (region.expect === "obscured") {
      const reference = options.reference;
      if (!reference || reference.canvas.width !== canvas.width || reference.canvas.height !== canvas.height) {
        out.push({ ...res, ok: false, pixels: w * h - masked, note: "no render of the original page to compare with" });
        continue;
      }
      const tile = opts.detailTilePt * opts.renderScale;
      const detail = regionDetail(data, w, h, tile, mask);
      const original = regionDetail(reference.ctx.getImageData(px0, py0, w, h).data, w, h, tile, mask);
      const limit = Math.max(opts.obscuredRatio * original.max, opts.obscuredFloor);
      out.push({ ...res, ok: detail.max <= limit, pixels: w * h - masked, detail: detail.max, originalDetail: original.max, limit: Math.round(limit * 100) / 100, masked });
      continue;
    }
    const tol = region.expect === "painted" ? opts.paintedTolerance : opts.pixelTolerance;
    const flat = regionFlatness(data, w, h, tol, mask);
    let ok = flat.outliers <= opts.maxOutlierPixels;
    if (ok && region.expect === "painted" && region.color && flat.dominant) {
      ok = flat.dominant.every((v, k) => Math.abs(v - region.color[k]) <= opts.paintedTolerance);
    }
    out.push({ ...res, ok, ...flat, masked });
  }
  return { ok: out.every((r) => r.ok), regions: out, render };
}
