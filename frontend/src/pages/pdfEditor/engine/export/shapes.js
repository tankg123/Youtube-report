// The shape rules of the editor as pure maths: how a line gets its arrow heads, what "dashed" and "dotted"
// mean for a stroke width, how freehand points become a smooth curve, where an underline sits.
//
// No PDF library and no DOM in here ON PURPOSE: the export engine draws with these functions, and the page
// overlay can import this file alone (it does not pull the PDF library into the bundle of the page) to draw
// exactly the same geometry on screen. All lengths are points.
//
// A path is a list of commands: ["M", x, y] | ["L", x, y] | ["C", x1, y1, x2, y2, x, y] | ["Z"].

/** Control point distance of a quarter circle drawn with one cubic Bezier. */
export const KAPPA = 0.5522847498307936;

/** Stroke line cap of every shape the editor draws (PDF "1 J", SVG stroke-linecap="round"). */
export const LINE_CAP = "round";

/**
 * Arrow head for a stroke width: `length` along the line (four times the width, at least 6 pt) and `width`
 * across it (three quarters of the length).
 */
export function arrowHeadSize(strokeWidth) {
  const length = Math.max(6, strokeWidth * 4);
  return { length, width: length * 0.75 };
}

/**
 * The parts of a straight line drawn from (0, 0) to (length, 0) along the x axis:
 *   shaft  [x0, x1] the stroked part, with round caps (a cap reaches half the stroke width beyond an end
 *          WITHOUT a head); null when the heads use up the whole line
 *   heads  filled triangles [[tipX, tipY], [x, y], [x, y]]: the tip is exactly the end point of the line and
 *          nothing is painted beyond it
 * A line too short for its heads gets shorter heads of the same width and no shaft.
 */
export function lineParts({ length, strokeWidth, headStart = false, headEnd = false }) {
  const size = arrowHeadSize(strokeWidth);
  const count = (headStart ? 1 : 0) + (headEnd ? 1 : 0);
  const headLength = count ? Math.min(size.length, length / count) : 0;
  const half = size.width / 2;
  const heads = [];
  if (headStart && headLength > 0) heads.push([[0, 0], [headLength, half], [headLength, -half]]);
  if (headEnd && headLength > 0) heads.push([[length, 0], [length - headLength, -half], [length - headLength, half]]);
  const x0 = headStart ? headLength : 0;
  const x1 = length - (headEnd ? headLength : 0);
  const shaft = count === 0 || x1 - x0 > 1e-9 ? [x0, x1] : null;
  return { shaft, heads, headLength, headWidth: size.width };
}

/**
 * Dash pattern of a stroke: lengths of the "on" and "off" parts along the path, for round caps (a cap adds
 * half the stroke width at both ends of every dash).
 *   solid   null
 *   dashed  [2w, 3w]: a visible dash of 3 widths, a gap of 2
 *   dotted  [~0, 2w]: dots as wide as the stroke, one width apart (a tiny positive "on" length: some
 *           renderers skip a dash of exactly zero)
 * The same array works as an SVG stroke-dasharray together with stroke-linecap="round".
 */
export function dashPattern(dash, strokeWidth) {
  const width = Math.max(strokeWidth, 0.01);
  if (dash === "dashed") return [width * 2, width * 3];
  if (dash === "dotted") return [width * 0.001, width * 2];
  return null;
}

/**
 * The outline of a box of `width` x `height` in its LOCAL coordinates (origin top-left, y down), drawn the way
 * an SVG <rect> is: from the top-left corner along the top edge, clockwise for the reader. Dashes therefore
 * fall on the same places in the PDF and on an SVG overlay.
 */
export function rectPath(width, height) {
  return [["M", 0, 0], ["L", width, 0], ["L", width, height], ["L", 0, height], ["Z"]];
}

/**
 * The outline of an ellipse: four cubic Beziers from the rightmost point towards (cx, cy + ry). In local
 * coordinates (y down) that is clockwise for the reader, as an SVG <ellipse> runs.
 */
export function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    ["M", cx + rx, cy],
    ["C", cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ["C", cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ["C", cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ["C", cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ["Z"]
  ];
}

/**
 * A smooth open curve through the sampled points of a freehand stroke: a uniform Catmull-Rom spline as
 * cubic Beziers (it passes through every sample). Two points give a straight segment; fewer give nothing
 * (the caller draws a dot for a single tap).
 */
export function smoothPath(points) {
  if (points.length < 2) return [];
  const path = [["M", points[0][0], points[0][1]]];
  if (points.length === 2) {
    path.push(["L", points[1][0], points[1][1]]);
    return path;
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    path.push([
      "C",
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1]
    ]);
  }
  return path;
}

/**
 * A path mirrored between the local frame of a box (y down, origin top-left) and the frame the PDF writer
 * draws in (y up, origin bottom-left): y' = height - y.
 */
export function flipPath(path, height) {
  return path.map((command) => {
    const flipped = command.slice();
    for (let index = 2; index < flipped.length; index += 2) flipped[index] = height - flipped[index];
    return flipped;
  });
}

/**
 * The points of a pen / highlighter stroke (fractions of its frame, v downwards) in the frame's local
 * coordinates: origin top-left, y DOWN, points.
 */
export function strokePointsLocal(frame, points) {
  return points.map(([u, v]) => [u * frame.w, v * frame.h]);
}

/** A quad [x1, y1, ..., x4, y4] as four points in counter-clockwise order (y up), whatever order it came in. */
export function quadCorners(quad) {
  const corners = [[quad[0], quad[1]], [quad[2], quad[3]], [quad[4], quad[5]], [quad[6], quad[7]]];
  let doubleArea = 0;
  for (let index = 0; index < 4; index += 1) {
    const [x0, y0] = corners[index];
    const [x1, y1] = corners[(index + 1) % 4];
    doubleArea += x0 * y1 - x1 * y0;
  }
  return doubleArea < 0 ? corners.reverse() : corners;
}

/**
 * The underline of a line of text set in a font at `size` points, from the font's own "post" metrics:
 *   offset     distance from the baseline DOWN to the top edge of the bar
 *   thickness  height of the bar
 * `metrics` = { unitsPerEm, underlinePosition (negative: below the baseline), underlineThickness } in font
 * units, as in public/pdf-fonts/manifest.json and as fontkit reports them.
 */
export function underlineBar(metrics, size) {
  const unitsPerEm = metrics.unitsPerEm || 1000;
  const position = Number.isFinite(metrics.underlinePosition) && metrics.underlinePosition !== 0 ? metrics.underlinePosition : -0.1 * unitsPerEm;
  const thickness = Number.isFinite(metrics.underlineThickness) && metrics.underlineThickness > 0 ? metrics.underlineThickness : 0.05 * unitsPerEm;
  return { offset: (-position / unitsPerEm) * size, thickness: (thickness / unitsPerEm) * size };
}

const round = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** A path as the `d` attribute of an SVG <path> (same coordinates: flip y yourself where the frame needs it). */
export function pathToSvg(path) {
  return path.map(([command, ...numbers]) => (numbers.length ? `${command}${numbers.map(round).join(" ")}` : command)).join(" ");
}
