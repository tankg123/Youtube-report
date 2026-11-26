// Helpers for tests that need text without a browser (tests/pdfText*.test.mjs, and any other suite that wants
// a TextLayout): the Vietnamese repertoire, the parsed bundled fonts, and a measurer that does in Node what
// the browser's hidden host does in the editor.
//
// nodeTextLayout() is NOT the product's layout: the product measures the DOM. It copies what Chrome on
// Windows does at device pixel ratio 1 (advances from hmtx, ascent and descent rounded to whole layout
// pixels, the half-leading floored, lengths kept in 1/64 px) and breaks lines at spaces and hyphens only.
// Measured against the layout service in Chrome 157 for 400 boxes (the four text families, 6 to 36 pt, five
// line heights, three alignments, wrapped Vietnamese / English prose and auto-width boxes with a fallback
// run): the same lines and runs in every box, baselines and heights equal, widths within 0.002 pt.
// Text with other break opportunities (CJK, slashes, soft hyphens) wraps differently in a browser.
// Use it to give export tests a realistic layout, not to prove what the screen shows.
import { fontkit } from "../../src/pages/pdfEditor/engine/lib.js";
import { quantizeFontSize } from "../../src/pages/pdfEditor/engine/textRules.js";
import { OBJECT_DEFAULTS, fontKey } from "../../src/pages/pdfEditor/model/schema.js";
import { fontPlan, graphemes } from "../../src/pages/pdfEditor/text/fontSupport.js";
import { buildTextLayout, hardLines } from "../../src/pages/pdfEditor/text/layoutCore.js";
import { LAYOUT_SCALE } from "../../src/pages/pdfEditor/text/textStyle.js";
import { fontBytes, fontManifest } from "./pdfTestKit.mjs";

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
const LATIN_1 = [0xc0, 0xc1, 0xc2, 0xc3, 0xc8, 0xc9, 0xca, 0xcc, 0xcd, 0xd2, 0xd3, 0xd4, 0xd5, 0xd9, 0xda, 0xdd];

/** The 134 precomposed Vietnamese letters outside ASCII (code points, ascending). */
export const VIETNAMESE_LETTERS = Object.freeze([
  ...LATIN_1, ...LATIN_1.map((codePoint) => codePoint + 0x20),
  0x102, 0x103, 0x110, 0x111, 0x128, 0x129, 0x168, 0x169, 0x1a0, 0x1a1, 0x1af, 0x1b0,
  ...range(0x1ea0, 0x1ef9)
].sort((a, b) => a - b));

/** A sentence that uses every Vietnamese tone and shape mark. */
export const VIETNAMESE_PANGRAM = "Kỹ sư Đỗ Thị Hường vừa xử lý xong hồ sơ ở quận Hoàn Kiếm, rồi ghé Phú Quốc ăn bữa tối: giá 1.234.567 ₫.";

/** A string from code points: invisible characters are never written literally in test files. */
export const fromCodePoints = (...codePoints) => String.fromCodePoint(...codePoints);

const parsed = new Map();
/** The bundled font parsed by the editor's own fontkit (cached). */
export function parsedFont(key) {
  let font = parsed.get(key);
  if (!font) {
    font = fontkit.create(fontBytes(key));
    parsed.set(key, font);
  }
  return font;
}

const manifestFont = (key) => fontManifest.fonts.find((font) => font.id === key);

/** A complete, valid text object; `frame.w` / `frame.h` are filled from nodeTextLayout unless a frame is given. */
export function makeTextObject(partial = {}) {
  const object = {
    id: partial.id || "text-1",
    type: "text",
    pageId: partial.pageId || "page-1",
    text: "",
    ...OBJECT_DEFAULTS.text,
    ...partial,
    frame: { x: 100, y: 700, w: 0, h: 0, rot: 0, ...(partial.frame || {}) }
  };
  if (!partial.frame || partial.frame.h === undefined) {
    const layout = nodeTextLayout(object);
    object.frame.w = layout.width;
    object.frame.h = layout.height;
  }
  return object;
}

/**
 * What layout.js would read from the hidden host, computed from the font files: the measurement that
 * layoutCore.buildTextLayout() takes (layout pixels).
 */
export function measureInNode(textObject) {
  const K = LAYOUT_SCALE;
  const key = fontKey(textObject);
  const plan = fontPlan(fontManifest, key);
  const fontPx = quantizeFontSize(textObject.size) * K;
  const entry = manifestFont(key);
  const up = entry.metrics.useTypoMetrics ? entry.metrics.typoAscender : entry.metrics.winAscent;
  const down = entry.metrics.useTypoMetrics ? -entry.metrics.typoDescender : entry.metrics.winDescent;
  const ascent = Math.round((up * fontPx) / entry.unitsPerEm);
  const textHeight = ascent + Math.round((down * fontPx) / entry.unitsPerEm);
  const pitch = Math.round(fontPx * textObject.lineHeight * 64) / 64; // browsers keep lengths in 1/64 px
  const lead = Math.floor((pitch - textHeight) / 2);

  const advance = (cluster) => {
    const face = plan.classify(cluster).font || key;
    const font = parsedFont(face);
    let total = 0;
    for (const char of cluster) {
      const codePoint = char.codePointAt(0);
      total += font.hasGlyphForCodePoint(codePoint) ? font.glyphForCodePoint(codePoint).advanceWidth / font.unitsPerEm : 0.5;
    }
    return total * fontPx;
  };

  const auto = Boolean(textObject.autoWidth);
  const limit = auto ? Infinity : textObject.frame.w * K;
  const text = textObject.text;
  const clusters = graphemes(text);
  const rows = []; // visual lines: arrays of { text, index, width }
  for (const [start, end] of hardLines(text)) {
    const items = clusters.filter(({ index, segment }) => index >= start && index < end && segment !== "\n").map(({ segment, index }) => ({ text: segment, index, width: advance(segment) }));
    let row = [];
    let used = 0; // advance of the row up to and including its last non-space cluster
    let pending = 0; // advance of the spaces behind it
    let word = [];
    let wordWidth = 0;
    const place = () => {
      if (word.length === 0) return;
      if (row.length > 0 && used + pending + wordWidth > limit + 1e-6) {
        rows.push(row);
        row = [];
        used = 0;
        pending = 0;
      }
      for (const item of word) {
        // a word wider than the box breaks wherever it has to
        if (row.length > 0 && used + pending + item.width > limit + 1e-6 && pending === 0) {
          rows.push(row);
          row = [];
          used = 0;
        }
        row.push(item);
        used += pending + item.width;
        pending = 0;
      }
      word = [];
      wordWidth = 0;
    };
    for (const item of items) {
      if (item.text === " ") {
        place();
        row.push(item);
        pending += item.width;
      } else {
        word.push(item);
        wordWidth += item.width;
        if (item.text === "-" || item.text === fromCodePoints(0x2010) || item.text === fromCodePoints(0x2013)) place();
      }
    }
    place();
    rows.push(row);
  }

  const inkWidth = (row) => {
    let end = row.length;
    while (end > 0 && row[end - 1].text === " ") end -= 1;
    return row.slice(0, end).reduce((sum, item) => sum + item.width, 0);
  };
  const fullWidth = (row) => row.reduce((sum, item) => sum + item.width, 0);
  const width = auto ? Math.max(0, ...rows.map(fullWidth)) : limit;
  const factor = textObject.align === "center" ? 0.5 : textObject.align === "right" ? 1 : 0;
  const out = [];
  rows.forEach((row, line) => {
    const top = line * pitch + lead;
    let x = (width - (auto ? fullWidth(row) : inkWidth(row))) * factor;
    for (const item of row) {
      out.push({ text: item.text, index: item.index, left: x, right: x + item.width, top, bottom: top + textHeight });
      x += item.width;
    }
  });
  return { width, height: rows.length * pitch, graphemes: out, ascent, textHeight, firstTop: lead };
}

/** A TextLayout (model/schema.js) of a text object, computed in Node. See the head of this file for its limits. */
export function nodeTextLayout(textObject) {
  return buildTextLayout(textObject, measureInNode(textObject), fontManifest);
}
