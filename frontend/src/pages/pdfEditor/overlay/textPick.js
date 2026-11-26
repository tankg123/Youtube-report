// Picking lines of document text for the tools that work on them (Edit text, Redact, Highlighter), from the
// lines of viewer/textLines.js (viewer.getTextLines(pageId)). Pure functions: tests/pdfOverlayTextPick.test.mjs.
//
// A line has { text, rect, quad (top-left, top-right, bottom-right, bottom-left as read), baseline
// [x0, y0, x1, y1], angle (degrees, counter-clockwise in user space), fontSize (points), font: { name, serif,
// monospace, bold, italic }, vertical }. Everything here is in the user space of the page.
import { frameAxes } from "../engine/geometry.js";
import { quantizeFontSize } from "../engine/textRules.js";
import { FONT_SIZE_LIMITS } from "../model/schema.js";
import { lineAtPoint } from "../viewer/textLines.js";

const RIGHT_ANGLE_SLACK = 1; // degrees

/** True when a line reads along one of the axes of the page (0, 90, 180 or 270 degrees). */
export function isAxisAligned(line) {
  const angle = (((Number(line?.angle) || 0) % 90) + 90) % 90;
  return angle <= RIGHT_ANGLE_SLACK || angle >= 90 - RIGHT_ANGLE_SLACK;
}

/** Edit text offers horizontal and vertical lines of ordinary fonts that hold something to read. */
export function isEditableLine(line) {
  return Boolean(line) && !line.vertical && isAxisAligned(line) && typeof line.text === "string" && line.text.trim() !== "";
}

/**
 * The line under a user-space point: { index, line } (index = its position in `lines`: the id the
 * interaction reducer carries for a "textline" target), or null.
 * @param {{ editableOnly?: boolean }} [options]  editableOnly: only lines Edit text can replace
 */
export function pickLine(lines, point, tolerance = 0, { editableOnly = false } = {}) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const pool = editableOnly ? lines.filter(isEditableLine) : lines;
  const line = lineAtPoint(pool, point, tolerance);
  return line ? { index: lines.indexOf(line), line } : null;
}

/** Where a point lies along the baseline of a line: 0 = its start, `width` = its end (user-space units). */
function along(line, point) {
  const { quad } = line;
  const width = Math.hypot(quad[2] - quad[0], quad[3] - quad[1]);
  if (!(width > 0)) return { at: 0, width: 0 };
  const at = ((point[0] - quad[0]) * (quad[2] - quad[0]) + (point[1] - quad[1]) * (quad[3] - quad[1])) / width;
  return { at, width };
}

/** The part of a line's quad between two positions along its baseline (clamped to the line). */
function sliceQuad(line, from, to) {
  const { quad } = line;
  const { width } = along(line, [quad[0], quad[1]]);
  if (!(width > 0)) return quad.slice();
  const low = Math.max(0, Math.min(width, Math.min(from, to)));
  const high = Math.max(0, Math.min(width, Math.max(from, to)));
  const ux = (quad[2] - quad[0]) / width;
  const uy = (quad[3] - quad[1]) / width;
  return [
    quad[0] + ux * low, quad[1] + uy * low,
    quad[0] + ux * high, quad[1] + uy * high,
    quad[6] + ux * high, quad[7] + uy * high,
    quad[6] + ux * low, quad[7] + uy * low
  ];
}

const meetsRect = (line, rect) => line.rect[0] <= rect[2] && rect[0] <= line.rect[2] && line.rect[1] <= rect[3] && rect[1] <= line.rect[3];

/** Distance from a point to the box of a line (0 inside it). */
function distanceToLine(line, point) {
  const dx = Math.max(line.rect[0] - point[0], 0, point[0] - line.rect[2]);
  const dy = Math.max(line.rect[1] - point[1], 0, point[1] - line.rect[3]);
  return Math.hypot(dx, dy);
}

/** A stretch shorter than this (points) is a slip of the hand: the whole line is meant. */
const MIN_STRETCH = 1;

/**
 * What a drag across document text marks, the way a text selection would: on the line where the drag began
 * from that point to the end of the line, the lines between entirely, on the line where it ended from the
 * start of the line to that point; a drag inside one line marks the stretch between the two points.
 * A drag that only touches one line by less than a point marks that whole line.
 * @param {object[]} lines   the lines of the page in reading order
 * @param {[number, number]} from   where the drag began (user space)
 * @param {[number, number]} to     where it ended
 * @returns {number[][]} quads [x1, y1, ..., x4, y4] (top-left, top-right, bottom-right, bottom-left as read),
 *          one per marked line, in reading order; [] when the drag touches no text
 */
export function textDragQuads(lines, from, to) {
  if (!Array.isArray(lines) || !lines.length) return [];
  const rect = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[0], to[0]), Math.max(from[1], to[1])];
  const touched = [];
  lines.forEach((line, index) => {
    if (line.text.trim() && meetsRect(line, rect)) touched.push(index);
  });
  if (!touched.length) return [];
  const nearest = (point) => touched.reduce((best, index) => (distanceToLine(lines[index], point) < distanceToLine(lines[best], point) ? index : best), touched[0]);
  let first = nearest(from);
  let last = nearest(to);
  let start = from;
  let end = to;
  if (first > last) {
    [first, last] = [last, first];
    [start, end] = [end, start];
  }
  const quads = [];
  for (const index of touched) {
    if (index < first || index > last) continue;
    const line = lines[index];
    if (!isAxisAligned(line) || line.vertical) {
      quads.push(line.quad.slice());
      continue;
    }
    const { width } = along(line, start);
    let low = 0;
    let high = width;
    if (first === last) {
      low = along(line, start).at;
      high = along(line, end).at;
      const stretch = Math.abs(Math.max(0, Math.min(width, high)) - Math.max(0, Math.min(width, low)));
      if (stretch < MIN_STRETCH) {
        low = 0;
        high = width;
      }
    } else if (index === first) {
      low = along(line, start).at;
      if (width - Math.max(0, low) < MIN_STRETCH) low = 0;
    } else if (index === last) {
      high = along(line, end).at;
      if (Math.min(width, high) < MIN_STRETCH) high = width;
    }
    quads.push(sliceQuad(line, low, high));
  }
  return quads;
}

/** The bounding box [x0, y0, x1, y1] of a quad. */
export function quadBounds(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The style of the text box that replaces a line (Edit text): the bundled family nearest to the line's font
 * (serif -> Tinos, monospace -> Cousine, everything else -> Arimo), its size, weight and slant.
 * @param {object} line
 * @param {{ text?: string } | null} [colours]  what viewer.sampleColors found for the line
 */
export function replacementStyle(line, colours = null) {
  const font = line.font?.monospace ? "cousine" : line.font?.serif ? "tinos" : "arimo";
  const size = quantizeFontSize(Math.min(FONT_SIZE_LIMITS.max, Math.max(FONT_SIZE_LIMITS.min, Number(line.fontSize) || 12)));
  const style = { font, size, bold: Boolean(line.font?.bold), italic: Boolean(line.font?.italic), underline: false, align: "left", lineHeight: 1.2, opacity: 1 };
  if (typeof colours?.text === "string") style.color = colours.text;
  return style;
}

/**
 * Moves a frame so that the baseline of its first line starts exactly where the baseline of the replaced line
 * starts. `first` = { x, baseline } of the first line of the box's TextLayout (points from its top-left corner).
 * The size and the rotation of the frame stay.
 */
export function frameOnBaseline(frame, baselineStart, first, userUnit = 1) {
  const { ex, eyDown } = frameAxes(frame, userUnit);
  const x = Number(first?.x) || 0;
  const y = Number(first?.baseline) || 0;
  // the top-left corner that puts the local point (x, y) on the start of the old baseline ...
  const left = baselineStart[0] - x * ex[0] - y * eyDown[0];
  const top = baselineStart[1] - x * ex[1] - y * eyDown[1];
  // ... and the centre of a box of this size with that corner
  return { ...frame, x: left + (frame.w / 2) * ex[0] + (frame.h / 2) * eyDown[0], y: top + (frame.w / 2) * ex[1] + (frame.h / 2) * eyDown[1] };
}
