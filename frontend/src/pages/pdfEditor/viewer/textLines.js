// Groups pdf.js text items into lines on a common baseline. The Edit text, Highlight and Redact tools mark
// whole lines (or the lines under a drag), and "Edit text" needs the size and the kind of font of a line.
// Pure functions: no DOM, no pdf.js import (tests/pdfViewerTextLines.test.mjs runs them on generated PDFs).
//
// A text item of pdf.js (getTextContent) has `transform = [a, b, c, d, e, f]` in PDF user space: (e, f) is the
// start of its baseline, (a, b) the reading direction, (c, d) the "up" direction of its glyphs; `width` is the
// advance along the baseline in user-space units. pdf.js breaks one visual line into several items (font
// changes, kerning jumps, marked content), adds items " " for gaps and items "" with hasEOL for line ends.
//
// Two items are on one line when they read in the same direction (1 degree), their baselines are less than a
// quarter of the smaller font size apart (pdf.js' own rule for "same line", VERTICAL_SHIFT_RATIO) and the gap
// between them along the baseline is at most `maxGap` font sizes: table cells and columns that merely share a
// baseline stay separate lines, which keeps a replaced line from swallowing its neighbour.
//
// Result, per line (all coordinates in PDF user space, y up, NOT rotated by /Rotate):
//   text      the line as a reader sees it, NFC (see the `normalize` option)
//   rect      [x0, y0, x1, y1] bounding box of `quad`
//   quad      [x1, y1, ..., x4, y4]: top-left, top-right, bottom-right, bottom-left as read (the shape of a
//             highlight quad in ../model/schema.js); top = ascent, bottom = descent of the fonts of the line
//   baseline  [x0, y0, x1, y1] start and end of the baseline
//   angle     reading direction in degrees, counter-clockwise in user space, (-180, 180]; 0 = left to right
//   fontSize  size of the font that sets most characters of the line, in POINTS (user units x userUnit)
//   font      { name, serif, monospace, bold, italic } of that font; name is null when pdf.js did not load it
//   vertical  true for a run of a vertical-writing font (one run = one line; quad = its box)
//   items     the items of the line in reading order: { index, str, fontName, fontSize, quad }
//             index = position among the items that have a `str` = index of pdf.js TextLayer.textDivs and
//             of the search matches of ./searchText.js

import { normalizeTextForm } from "../engine/textRules.js";

const DEGREES = 180 / Math.PI;
const SAME_DIRECTION = Math.cos(1 / DEGREES); // items within one degree read in the same direction
const BASELINE_SHIFT = 0.25; // of the smaller font size (pdf.js VERTICAL_SHIFT_RATIO)
const WORD_GAP = 0.2; // of the font size: a wider gap between two items is a space
const DEFAULT_MAX_GAP = 1.5; // of the font size: a wider gap starts another line

const clean = (value) => (Math.abs(value) < 1e-9 ? 0 : value);
const round = (value) => Math.round(value * 1000) / 1000 || 0;

// --- fonts ---

const SUBSET_PREFIX = /^[A-Z]{6}\+/;
const BOLD_NAME = /bold|black|heavy/i;
const HALF_BOLD_NAME = /(?:Demi|Semi)(?:[Bb]old|$|[-_ ,]|Italic|Oblique)/;
const ITALIC_NAME = /italic|oblique|kursiv|slanted|inclined/i;
const ITALIC_SUFFIX = /(?:[-_ ,]|[a-z])It$/;
const SANS_NAME = /sans|grotesk|gothic/i;
const SERIF_NAME = /times|georgia|garamond|cambria|palatino|minion|baskerville|bodoni|bookman|century|didot|caslon|libertine|tinos|serif|roman|charter|utopia|constantia|antiqua|mincho|simsun|batang|ming|cmr\d|cmbx\d|cmti\d|lmroman/i;
const MONO_NAME = /mono|courier|consol|typewriter|cousine|menlo|inconsolata|sourcecode|source code|lucida ?console|fixed|cmtt\d|lmmono/i;

/**
 * What can be said about a font of pdf.js: { name, serif, monospace, bold, italic }.
 * pdf.js only knows `bold` / `italic` for fonts that are not embedded, and its serif flag comes from the font
 * descriptor, which embedded subsets often leave wrong: the name decides first, the flags second.
 * @param {{ name?: string, fallbackName?: string, isSerifFont?: boolean, isMonospace?: boolean, bold?: boolean,
 *           italic?: boolean, black?: boolean } | null} font  a font object of page.commonObjs, or null
 * @param {string} [family]  the generic family of textContent.styles ("serif" | "sans-serif" | "monospace")
 */
export function describeFont(font, family = "") {
  const rawName = typeof font?.name === "string" ? font.name : "";
  const name = rawName.replace(SUBSET_PREFIX, "");
  const generic = family || font?.fallbackName || "";
  const monospace = font?.isMonospace === true || generic === "monospace" || MONO_NAME.test(name);
  let serif = font?.isSerifFont === true || generic === "serif";
  if (name) {
    if (SANS_NAME.test(name)) serif = false;
    else if (SERIF_NAME.test(name)) serif = true;
  }
  return {
    name: name || null,
    serif: serif && !monospace,
    monospace,
    bold: font?.bold === true || font?.black === true || BOLD_NAME.test(name) || HALF_BOLD_NAME.test(name),
    italic: font?.italic === true || ITALIC_NAME.test(name) || ITALIC_SUFFIX.test(name)
  };
}

// --- geometry of one item ---

function measureItem(item, style) {
  const [a, b, c, d, e, f] = item.transform;
  const lengthU = Math.hypot(a, b);
  if (!(lengthU > 0)) return null;
  // font height = the part of the glyphs' "up" vector that is perpendicular to the baseline (a sheared
  // matrix, the usual fake italic, would otherwise count its slant as size)
  const cross = a * d - b * c;
  const size = Math.abs(cross) / lengthU;
  if (!(size > 0)) return null;
  const u = [a / lengthU, b / lengthU];
  const n = cross >= 0 ? [-u[1], u[0]] : [u[1], -u[0]];
  let ascent = Number.isFinite(style?.ascent) && style.ascent ? style.ascent : 0.8;
  let descent = Number.isFinite(style?.descent) && style.descent ? style.descent : ascent - 1;
  if (descent > 0) descent = -descent;
  // font files with broken metrics must not blow the line box up
  ascent = Math.min(1.25, Math.max(0.5, ascent));
  descent = Math.max(-0.6, Math.min(-0.05, descent));
  const along = e * u[0] + f * u[1];
  const offset = e * n[0] + f * n[1];
  if (style?.vertical) {
    // vertical writing: (e, f) is the top centre of the first glyph, the run goes down by item.height
    const half = (item.width || size) / 2;
    return { u, n, size, vertical: true, start: along - half, end: along + half, top: offset, bottom: offset - (item.height || 0), offset };
  }
  const advance = Math.abs(item.width) || 0;
  return { u, n, size, vertical: false, start: along, end: along + advance, top: offset + ascent * size, bottom: offset + descent * size, offset };
}

const pointAt = (u, n, along, across) => [along * u[0] + across * n[0], along * u[1] + across * n[1]];

function quadOf(u, n, start, end, top, bottom) {
  const corners = [pointAt(u, n, start, top), pointAt(u, n, end, top), pointAt(u, n, end, bottom), pointAt(u, n, start, bottom)];
  return corners.flat().map(round);
}

function boundsOf(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// --- grouping ---

function lookupFont(fonts, fontName) {
  if (!fonts || !fontName) return null;
  if (typeof fonts === "function") return fonts(fontName) || null;
  if (typeof fonts.get === "function") return fonts.get(fontName) || null;
  return fonts[fontName] || null;
}

function finishLine(members, context) {
  const { styles, fonts, userUnit, normalize, blankAfter } = context;
  const first = members[0];
  const { u, n } = first.box;
  const rtl = members.filter((member) => member.item.dir === "rtl").length * 2 > members.length;
  const reading = rtl ? members.slice().reverse() : members;

  // the font that sets most characters decides the size and the kind of font of the line
  const weight = new Map();
  for (const member of members) {
    const key = `${member.item.fontName}|${Math.round(member.box.size * 100)}`;
    const entry = weight.get(key) || { count: 0, member };
    entry.count += member.item.str.trim().length;
    weight.set(key, entry);
  }
  let dominant = first;
  let best = -1;
  for (const entry of weight.values()) {
    if (entry.count > best) {
      best = entry.count;
      dominant = entry.member;
    }
  }

  let start = Infinity;
  let end = -Infinity;
  let top = -Infinity;
  let bottom = Infinity;
  for (const { box } of members) {
    start = Math.min(start, box.start);
    end = Math.max(end, box.end);
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }

  let text = "";
  let previous = null;
  for (const member of reading) {
    const { str } = member.item;
    if (previous) {
      const gap = rtl ? previous.box.start - member.box.end : member.box.start - previous.box.end;
      const spaced = /\s$/.test(text) || /^\s/.test(str);
      // pdf.js marks a gap it saw with an item " " right after the earlier run; wide gaps count as well
      const marked = blankAfter.has(Math.min(previous.index, member.index));
      if (!spaced && (marked || gap > WORD_GAP * Math.max(previous.box.size, member.box.size))) text += " ";
    }
    text += str;
    previous = member;
  }

  const quad = quadOf(u, n, start, end, top, bottom);
  const baselineStart = pointAt(u, n, start, dominant.box.offset);
  const baselineEnd = pointAt(u, n, end, dominant.box.offset);
  const style = styles[dominant.item.fontName];
  return {
    text: normalize(text.trim()),
    rect: boundsOf(quad),
    quad,
    baseline: [...baselineStart, ...baselineEnd].map(round),
    angle: round(clean(Math.atan2(u[1], u[0]) * DEGREES)),
    fontSize: round(dominant.box.size * userUnit),
    font: describeFont(lookupFont(fonts, dominant.item.fontName), style?.fontFamily),
    vertical: dominant.box.vertical,
    items: reading.map((member) => ({
      index: member.index,
      str: member.item.str,
      fontName: member.item.fontName,
      fontSize: round(member.box.size * userUnit),
      quad: quadOf(member.box.u, member.box.n, member.box.start, member.box.end, member.box.top, member.box.bottom)
    }))
  };
}

/**
 * @param {Array<object>} items  getTextContent().items in content order (entries without `str` are skipped)
 * @param {Record<string, { ascent?: number, descent?: number, vertical?: boolean, fontFamily?: string }>} [styles]
 *        getTextContent().styles
 * @param {{ userUnit?: number, maxGap?: number, normalize?: (text: string) => string,
 *           fonts?: Map<string, object> | Record<string, object> | ((fontName: string) => object | null) }} [options]
 *        userUnit   /UserUnit of the page (font sizes are returned in points)
 *        maxGap     widest gap inside one line, in font sizes (default 1.5)
 *        normalize  applied to the text of each line (default: NFC)
 *        fonts      fontName -> font object of page.commonObjs (name, isSerifFont, isMonospace, bold, italic)
 * @returns {Array<object>} lines in the order in which they first appear in the content (see the file header)
 */
export function groupTextLines(items, styles = {}, options = {}) {
  const userUnit = options.userUnit > 0 ? options.userUnit : 1;
  const maxGap = options.maxGap > 0 ? options.maxGap : DEFAULT_MAX_GAP;
  const normalize = typeof options.normalize === "function" ? options.normalize : normalizeTextForm;
  const context = { styles: styles || {}, fonts: options.fonts || null, userUnit, normalize, blankAfter: new Set() };

  // 1. measure; remember after which run pdf.js put a white-space item
  const runs = [];
  let index = -1;
  let lastRun = -1;
  for (const item of items || []) {
    if (typeof item?.str !== "string") continue;
    index += 1;
    if (item.str.trim() === "") {
      if (item.str !== "" && lastRun >= 0) context.blankAfter.add(lastRun);
      continue;
    }
    if (!Array.isArray(item.transform) && !ArrayBuffer.isView(item.transform)) continue;
    const box = measureItem(item, context.styles[item.fontName]);
    if (!box) continue;
    runs.push({ index, item, box });
    lastRun = index;
  }

  // 2. same direction + same baseline -> one row (whatever the distance along the baseline)
  const rows = [];
  for (const run of runs) {
    if (run.box.vertical) {
      rows.push({ vertical: true, members: [run] });
      continue;
    }
    let target = null;
    for (let at = rows.length - 1; at >= 0; at -= 1) {
      const row = rows[at];
      if (row.vertical) continue;
      const reference = row.members[row.members.length - 1].box;
      if (reference.u[0] * run.box.u[0] + reference.u[1] * run.box.u[1] < SAME_DIRECTION) continue;
      // both baselines measured along the row's own normal
      const offset = run.item.transform[4] * reference.n[0] + run.item.transform[5] * reference.n[1];
      if (Math.abs(offset - reference.offset) > BASELINE_SHIFT * Math.min(reference.size, run.box.size)) continue;
      target = row;
      break;
    }
    if (target) {
      // every member of a row is expressed in the frame of its first member
      const frame = target.members[0].box;
      const [, , , , e, f] = run.item.transform;
      const along = e * frame.u[0] + f * frame.u[1];
      const across = e * frame.n[0] + f * frame.n[1];
      const shift = along - run.box.start;
      const lift = across - run.box.offset;
      target.members.push({
        ...run,
        box: { ...run.box, u: frame.u, n: frame.n, start: along, end: run.box.end + shift, top: run.box.top + lift, bottom: run.box.bottom + lift, offset: across }
      });
    } else {
      rows.push({ vertical: false, members: [run] });
    }
  }

  // 3. sort each row along its baseline and cut it at wide gaps
  const lines = [];
  for (const row of rows) {
    if (row.vertical) {
      lines.push({ order: row.members[0].index, members: row.members });
      continue;
    }
    const sorted = row.members.slice().sort((left, right) => left.box.start - right.box.start || left.index - right.index);
    let current = [sorted[0]];
    let reach = sorted[0].box.end;
    for (let at = 1; at < sorted.length; at += 1) {
      const member = sorted[at];
      const limit = maxGap * Math.max(member.box.size, current[current.length - 1].box.size);
      if (member.box.start - reach > limit) {
        lines.push({ order: Math.min(...current.map((entry) => entry.index)), members: current });
        current = [member];
        reach = member.box.end;
      } else {
        current.push(member);
        reach = Math.max(reach, member.box.end);
      }
    }
    lines.push({ order: Math.min(...current.map((entry) => entry.index)), members: current });
  }

  lines.sort((left, right) => left.order - right.order);
  return lines.map((line) => finishLine(line.members, context));
}

// --- hit tests for the tools ---

/** Position of a user-space point in the frame of a line: [along the baseline, up from the bottom edge]. */
function inLineFrame(line, point) {
  const { quad } = line;
  const width = Math.hypot(quad[2] - quad[0], quad[3] - quad[1]);
  const height = Math.hypot(quad[0] - quad[6], quad[1] - quad[7]);
  const dx = point[0] - quad[6];
  const dy = point[1] - quad[7];
  const along = width > 0 ? (dx * (quad[4] - quad[6]) + dy * (quad[5] - quad[7])) / width : 0;
  const up = height > 0 ? (dx * (quad[0] - quad[6]) + dy * (quad[1] - quad[7])) / height : 0;
  return { along, up, width, height };
}

/**
 * The line under a user-space point, or null. `tolerance` (user-space units) widens every line box; when
 * several lines qualify the one whose vertical middle is nearest wins.
 */
export function lineAtPoint(lines, point, tolerance = 0) {
  let best = null;
  let bestDistance = Infinity;
  for (const line of lines) {
    const { along, up, width, height } = inLineFrame(line, point);
    if (along < -tolerance || along > width + tolerance || up < -tolerance || up > height + tolerance) continue;
    const distance = Math.abs(up - height / 2);
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

/** The lines whose box meets a user-space rectangle (the lines under a drag), in reading order. */
export function linesInRect(lines, rect) {
  const x0 = Math.min(rect[0], rect[2]);
  const y0 = Math.min(rect[1], rect[3]);
  const x1 = Math.max(rect[0], rect[2]);
  const y1 = Math.max(rect[1], rect[3]);
  return lines.filter((line) => line.rect[0] <= x1 && x0 <= line.rect[2] && line.rect[1] <= y1 && y0 <= line.rect[3]);
}
