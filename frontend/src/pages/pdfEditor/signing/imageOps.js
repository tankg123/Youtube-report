// Pixel work for signature pictures, on plain RGBA arrays (the data of an ImageData): removing a white
// background, finding the ink, trimming to it, and the smooth path of a drawn stroke. Pure: no canvas, no
// DOM (tests/pdfSigningImageOps.test.mjs); signatureImages.js feeds it from canvases.

/** The threshold slider of "Remove the white background": brightness above which a pixel is paper. */
export const BACKGROUND_THRESHOLD = Object.freeze({ min: 0.4, max: 0.98, step: 0.01, default: 0.8 });
/** Below the threshold the ink fades in over this much brightness (soft edges instead of a hard cut). */
export const BACKGROUND_SOFTNESS = 0.18;
/** Alpha (0..255) from which a pixel counts as ink when trimming. */
export const INK_ALPHA = 16;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const clampByte = (value) => Math.min(255, Math.max(0, Math.round(value)));

/** Perceived brightness of a colour, 0 (black) .. 1 (white). */
export const brightness = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/**
 * Makes the paper of a photographed or scanned signature transparent.
 * A pixel as bright as `threshold` or brighter becomes fully transparent; darker pixels become opaque over
 * `softness` of brightness. The colour of a half-transparent pixel has its share of white taken out again,
 * so that over white paper the result looks exactly like the scan, and over a coloured page the edge of the
 * ink is darker than the scanned pixel was (no white fringe).
 * @param {Uint8ClampedArray | Uint8Array | number[]} rgba   width x height x 4 bytes, not premultiplied
 * @param {number} width
 * @param {number} height
 * @param {{ threshold?: number, softness?: number }} [options]
 * @returns {Uint8ClampedArray} a new array of the same size
 */
export function removeWhiteBackground(rgba, width, height, { threshold = BACKGROUND_THRESHOLD.default, softness = BACKGROUND_SOFTNESS } = {}) {
  const total = Math.max(0, Math.floor(width)) * Math.max(0, Math.floor(height)) * 4;
  const out = new Uint8ClampedArray(total);
  const limit = clamp01(threshold);
  const ramp = Math.max(0.01, softness);
  for (let offset = 0; offset + 3 < total; offset += 4) {
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    const alpha = rgba[offset + 3] / 255;
    const coverage = clamp01((limit - brightness(r, g, b)) / ramp);
    const next = alpha * coverage;
    if (next <= 0) continue; // transparent black
    // the pixel is `coverage` ink over white paper: ink = (pixel - (1 - coverage) * white) / coverage
    out[offset] = clampByte((r - (1 - coverage) * 255) / coverage);
    out[offset + 1] = clampByte((g - (1 - coverage) * 255) / coverage);
    out[offset + 2] = clampByte((b - (1 - coverage) * 255) / coverage);
    out[offset + 3] = clampByte(next * 255);
  }
  return out;
}

/**
 * The box around every pixel whose alpha is at least `alpha`.
 * @returns {{ x: number, y: number, width: number, height: number } | null} null when there is no ink
 */
export function inkBounds(rgba, width, height, { alpha = INK_ALPHA } = {}) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (rgba[row + x * 4 + 3] < alpha) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Cuts a picture down to its ink plus `padding` pixels (inside the picture).
 * @returns {{ data: Uint8ClampedArray, width: number, height: number, x: number, y: number } | null}
 *          x / y: where the cut starts in the original; null when there is no ink
 */
export function trimToInk(rgba, width, height, { alpha = INK_ALPHA, padding = 0 } = {}) {
  const ink = inkBounds(rgba, width, height, { alpha });
  if (!ink) return null;
  const pad = Math.max(0, Math.floor(padding));
  const x = Math.max(0, ink.x - pad);
  const y = Math.max(0, ink.y - pad);
  const right = Math.min(width, ink.x + ink.width + pad);
  const bottom = Math.min(height, ink.y + ink.height + pad);
  const outWidth = right - x;
  const outHeight = bottom - y;
  const data = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let row = 0; row < outHeight; row += 1) {
    const from = ((y + row) * width + x) * 4;
    data.set(rgba.subarray ? rgba.subarray(from, from + outWidth * 4) : rgba.slice(from, from + outWidth * 4), row * outWidth * 4);
  }
  return { data, width: outWidth, height: outHeight, x, y };
}

/** The size that fits `width` x `height` into `maxWidth` x `maxHeight` without enlarging: { width, height, scale }. */
export function fitWithin(width, height, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / Math.max(1, width), maxHeight / Math.max(1, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

// --- drawn strokes --------------------------------------------------------------------------------------------

/** Samples closer than this to the last one are dropped while drawing (CSS pixels of the pad). */
export const STROKE_MIN_DISTANCE = 1.5;

/** Adds a pointer sample to a stroke unless it is (almost) where the last one was. Returns the same array. */
export function addStrokePoint(points, point, minDistance = STROKE_MIN_DISTANCE) {
  const last = points[points.length - 1];
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < minDistance) return points;
  points.push({ x: point.x, y: point.y });
  return points;
}

/**
 * The smooth path through the samples of one stroke: a curve through the midpoints of neighbouring samples,
 * with each sample as the control point (no corners where the pointer was sampled).
 * @param {Array<{ x: number, y: number }>} points
 * @returns {Array<["M" | "L" | "Q", ...number[]]>}  a lone sample gives ["M", x, y] and a zero-length line (a dot)
 */
export function strokePath(points) {
  if (!Array.isArray(points) || !points.length) return [];
  const [first] = points;
  const path = [["M", first.x, first.y]];
  if (points.length === 1) {
    path.push(["L", first.x, first.y]);
    return path;
  }
  if (points.length === 2) {
    path.push(["L", points[1].x, points[1].y]);
    return path;
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    const here = points[index];
    const next = points[index + 1];
    path.push(["Q", here.x, here.y, (here.x + next.x) / 2, (here.y + next.y) / 2]);
  }
  const last = points[points.length - 1];
  path.push(["L", last.x, last.y]);
  return path;
}

/** The box around all strokes, widened by half the pen width: { x, y, width, height } or null without strokes. */
export function strokesBounds(strokes, penWidth = 0) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const stroke of strokes || []) {
    for (const point of stroke.points || []) {
      if (point.x < left) left = point.x;
      if (point.x > right) right = point.x;
      if (point.y < top) top = point.y;
      if (point.y > bottom) bottom = point.y;
    }
  }
  if (!Number.isFinite(left)) return null;
  const half = Math.max(0, penWidth) / 2;
  return { x: left - half, y: top - half, width: right - left + penWidth, height: bottom - top + penWidth };
}
