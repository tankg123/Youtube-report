// From what the browser measured to the TextLayout of model/schema.js. Pure (no DOM): the measuring itself
// lives in layout.js and hands over plain numbers, so this logic runs under `node --test` with a made-up
// measurer.
//
// A measurement (all numbers in LAYOUT pixels, origin = top-left corner of the text element):
//   {
//     width, height,        size of the laid-out element (an empty last line counts, and a box without text
//                           is one line tall: textStyle.boxDomText / textBoxStyle)
//     graphemes: [{ text, index, left, right, top, bottom }]
//                           every grapheme cluster that has a box, in reading order, `index` = UTF-16
//                           offset in the object's text; line feeds and clusters without a box are absent
//     ascent,               from the top of a text box of the BOX face to its baseline
//     textHeight,           height of a text box of the box face (where a caret stands)
//     firstTop              top of a text box on the first line of this box (used when no line has ink)
//   }
//
// The baseline of EVERY line is its glyph-box top + the ascent offset of the box face, also for a line drawn
// entirely by the fallback face: browsers build the box of each glyph from the primary font's metrics.
import { resizeFrame } from "../engine/geometry.js";
import { quantizeFontSize } from "../engine/textRules.js";
import { fontKey } from "../model/schema.js";
import { TEXT_BASELINE_UNCERTAIN, TEXT_RASTERIZED } from "./codes.js";
import { findFont, fontPlan, graphemes } from "./fontSupport.js";
import { LAYOUT_SCALE } from "./textStyle.js";

const SPACE = " ";
const LINE_FEED = String.fromCharCode(0x0a);
// rect tops of one line further apart than this (layout px) mean the browser does not build glyph boxes from
// the primary font: the baseline of that line cannot be trusted
const TOP_SPREAD_LIMIT = 0.5;

/** [start, end) offsets of the hard lines of a text (split at line feeds; never empty). */
export function hardLines(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf(LINE_FEED, start);
    if (end < 0) {
      lines.push([start, text.length]);
      return lines;
    }
    lines.push([start, end]);
    start = end + 1;
  }
}

/** Groups measured graphemes into visual lines; a hard line without any box yields one empty line. */
function visualLines(text, graphemes) {
  const lines = [];
  let next = 0;
  hardLines(text).forEach(([start, end], hard) => {
    let current = null;
    let found = false;
    while (next < graphemes.length && graphemes[next].index < end) {
      const grapheme = graphemes[next];
      next += 1;
      if (grapheme.index < start) continue;
      // a new visual line starts when a box sits lower by more than half the height of the line's first box
      if (current && grapheme.top > current.top + (current.bottom - current.top) / 2) current = null;
      if (!current) {
        current = { hard, start, top: grapheme.top, bottom: grapheme.bottom, items: [] };
        lines.push(current);
        found = true;
      }
      current.items.push(grapheme);
    }
    if (!found) lines.push({ hard, start, top: null, bottom: null, items: [] });
  });
  return lines;
}

const alignedX = (align, width) => (align === "center" ? width / 2 : align === "right" ? width : 0);

function deepFreeze(layout) {
  for (const line of layout.lines) {
    for (const run of line.runs) Object.freeze(run);
    Object.freeze(line.runs);
    Object.freeze(line);
  }
  Object.freeze(layout.lines);
  for (const rect of layout.underlines) Object.freeze(rect);
  Object.freeze(layout.underlines);
  if (layout.underline) Object.freeze(layout.underline);
  Object.freeze(layout.problems);
  Object.freeze(layout.fonts);
  Object.freeze(layout.metrics);
  return Object.freeze(layout);
}

/**
 * Builds the TextLayout of a text object from a measurement.
 * @param {object} textObject  a text object of model/schema.js (text already normalised)
 * @param {object} measurement see the head of this file
 * @param {object} manifest    public/pdf-fonts/manifest.json
 * @returns the TextLayout of model/schema.js (points, frozen) with these extra fields:
 *   lines[i].text / start / end   the visible text of the line (trailing spaces dropped) and its UTF-16
 *                                 offsets in textObject.text; EVERY visual line is listed, an empty one
 *                                 with runs [] and width 0
 *   underlines: [{ x, y, w, h }]  the underline of each line as rectangles in local points (y down), empty
 *                                 unless textObject.underline: draw them in the text colour
 *   underline: null | { offset, thickness }   the same line as two numbers (points): from a baseline DOWN to
 *                                 the top edge of the bar, and its height; a bar runs from line.x over
 *                                 line.width under every line with width > 0 (what the exporter reads)
 *   fonts: FontKey[]              the faces the runs use (what the exporter has to embed)
 *   metrics: { ascent, textHeight, lineHeight }   points: glyph-box top to baseline, glyph-box height, pitch
 * When the box must become a picture (problems holds TEXT_RASTERIZED) every line has runs [] and `raster` is
 * still null: the picture is made by raster.js / service.layoutForExport().
 */
export function buildTextLayout(textObject, measurement, manifest) {
  const K = LAYOUT_SCALE;
  const text = textObject.text;
  const size = quantizeFontSize(textObject.size);
  const plan = fontPlan(manifest, fontKey(textObject));
  const pitch = size * textObject.lineHeight * K;
  const boxWidth = textObject.autoWidth ? measurement.width : textObject.frame.w * K;

  const visual = visualLines(text, measurement.graphemes);
  // decided from the text, not from the boxes: a cluster the browser gave no box must not slip through
  const rasterized = graphemes(text).some(({ segment }) => segment !== LINE_FEED && !plan.classify(segment).font);
  let uncertain = false;
  const built = visual.map((line) => {
    if (line.items.length === 0) return { empty: true, baseline: null };
    // spaces hanging at the end of a line carry no ink: they are neither width nor text for the PDF
    let kept = line.items.length;
    while (kept > 0 && line.items[kept - 1].text === SPACE) kept -= 1;
    const items = line.items.slice(0, kept);
    let minTop = Infinity;
    let maxTop = -Infinity;
    let primaryTop = null;
    let right = line.items[0].left;
    const runs = [];
    let run = null;
    let closed = false; // the run ends with a cluster that has to stand alone (fontSupport.fontPlan)
    for (const item of items) {
      const { font, alone } = plan.classify(item.text);
      if (font === plan.primaryKey && primaryTop === null) primaryTop = item.top;
      if (item.top < minTop) minTop = item.top;
      if (item.top > maxTop) maxTop = item.top;
      if (item.right > right) right = item.right;
      if (!run || run.font !== font || alone || closed) {
        run = { text: "", x: item.left / K, font };
        runs.push(run);
      }
      run.text += item.text;
      closed = alone;
    }
    if (items.length > 0 && maxTop - minTop > TOP_SPREAD_LIMIT) uncertain = true;
    const first = line.items[0];
    const last = items[items.length - 1];
    const top = primaryTop ?? first.top;
    return {
      empty: false,
      baseline: top + measurement.ascent,
      x: first.left,
      width: right - first.left,
      runs,
      text: items.map((item) => item.text).join(""),
      start: first.index,
      end: last ? last.index + last.text.length : first.index
    };
  });

  // empty lines have no box to read: their baseline follows from the nearest measured line and the pitch
  const anchor = built.findIndex((line) => !line.empty);
  const baselineOf = (index) => {
    if (!built[index].empty) return built[index].baseline;
    if (anchor < 0) return measurement.firstTop + measurement.ascent + index * pitch;
    let nearest = anchor;
    for (let other = index - 1; other >= 0; other -= 1) {
      if (!built[other].empty) {
        nearest = other;
        break;
      }
    }
    return built[nearest].baseline + (index - nearest) * pitch;
  };

  const lines = built.map((line, index) => {
    const baseline = baselineOf(index) / K;
    if (line.empty) {
      const offset = visual[index].start;
      return { baseline, x: alignedX(textObject.align, boxWidth) / K, width: 0, runs: [], text: "", start: offset, end: offset };
    }
    return { baseline, x: line.x / K, width: line.width / K, runs: line.runs, text: line.text, start: line.start, end: line.end };
  });
  if (rasterized) {
    for (const line of lines) line.runs = [];
  }

  const underlines = [];
  let underline = null;
  if (textObject.underline) {
    const font = findFont(manifest, plan.primaryKey);
    const unit = size / font.unitsPerEm;
    const offset = -font.metrics.underlinePosition * unit; // the font gives the TOP of the line, negative = below the baseline
    const thickness = Math.max(font.metrics.underlineThickness * unit, size / 50);
    underline = { offset, thickness };
    for (const line of lines) {
      if (line.width > 0) underlines.push({ x: line.x, y: line.baseline + offset, w: line.width, h: thickness });
    }
  }

  const problems = [];
  if (rasterized) problems.push(TEXT_RASTERIZED);
  if (uncertain) problems.push(TEXT_BASELINE_UNCERTAIN);
  const fonts = [...new Set(lines.flatMap((line) => line.runs.map((run) => run.font)))].sort();
  return deepFreeze({
    width: boxWidth / K,
    height: measurement.height / K,
    lines,
    raster: null,
    problems,
    underlines,
    underline,
    fonts,
    metrics: { ascent: measurement.ascent / K, textHeight: measurement.textHeight / K, lineHeight: pitch / K }
  });
}

/**
 * The point of a text box that stays where it is when its size follows the text: [u, v] fractions of the box.
 * An autoWidth box grows away from its alignment edge (left: top-left, center: top-centre, right: top-right);
 * a wrapping box keeps its width and grows downwards.
 */
export function textAnchor(textObject) {
  if (!textObject.autoWidth) return [0, 0];
  return [textObject.align === "center" ? 0.5 : textObject.align === "right" ? 1 : 0, 0];
}

/**
 * The frame of a text object for a layout, anchored as textAnchor() says: an autoWidth box takes the laid-out
 * width and height; a wrapping box keeps its own width (the width it was laid out for is an input, never a
 * result) and takes the height. This is the rule of the store (model/store.js); the editor places the box
 * with it while it is typed in.
 */
export function frameForLayout(textObject, layout, userUnit = 1) {
  const width = textObject.autoWidth ? layout.width : textObject.frame.w;
  return resizeFrame(textObject.frame, width, layout.height, textAnchor(textObject), userUnit);
}

/** A copy of a layout that carries its picture (layouts are frozen: never assign to one). */
export function withRaster(layout, raster) {
  return Object.freeze({ ...layout, raster });
}
