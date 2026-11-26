// Geometry of the PDF editor: pure functions shared by the viewer, the page overlay, the document model and
// the export engine. No DOM, no PDF library: it runs under `node --test`.
//
// Vocabulary
//   user space     the coordinate system of a page's content stream: y up, NOT shifted to a page box and NOT
//                  rotated by /Rotate. One unit = 1/72 inch x UserUnit. Everything the editor stores lives here.
//   point (pt)     1/72 inch. Sizes of objects (width, height, font size, stroke width) are in points whatever
//                  the page's UserUnit is; `k = 1 / userUnit` converts points to user-space units.
//   geometry       { view: [x0, y0, x1, y1], rotate, userUnit } of a page: `view` is the visible rectangle in
//                  user space (CropBox clipped to MediaBox = pdf.js page.view), `rotate` the page's own /Rotate.
//   extraRotation  the rotation the user added to the page (0 / 90 / 180 / 270, clockwise), on top of `rotate`.
//   viewport px    what is on screen: origin at the top-left corner of the VISIBLE page, y down,
//                  `scale` CSS pixels per point.
//   frame          { x, y, w, h, rot } of a box-shaped object:
//                    x, y   centre of the box in user space
//                    w, h   size in points along the box's own right / down axes
//                    rot    angle in degrees, counter-clockwise in user space, of the box's own "right" axis
//                  A box that looks upright on screen has rot = rotate + extraRotation; rotating the PAGE
//                  therefore never changes a frame: the objects turn with the page content.
//   local          coordinates inside a box: origin at its top-left corner, x right, y DOWN, in points.

const DEG = Math.PI / 180;
const clean = (value) => (Math.abs(value) < 1e-12 ? 0 : value);

/** Reduces any multiple of 90 to 0 / 90 / 180 / 270 (other values become 0, as pdf.js does for /Rotate). */
export function normalizeRightAngle(degrees) {
  const value = Number(degrees) || 0;
  if (value % 90 !== 0) return 0;
  return ((value % 360) + 360) % 360;
}

/** Any angle in degrees reduced to [0, 360). */
export function normalizeAngle(degrees) {
  const value = Number(degrees) || 0;
  return clean(((value % 360) + 360) % 360);
}

/** A rectangle given by any two opposite corners -> [x0, y0, x1, y1] with x0 <= x1 and y0 <= y1. */
export function normalizeRect(rect) {
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
}

export function rectsIntersect(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export function unionRects(rects) {
  let out = null;
  for (const rect of rects) {
    out = out ? [Math.min(out[0], rect[0]), Math.min(out[1], rect[1]), Math.max(out[2], rect[2]), Math.max(out[3], rect[3])] : rect.slice();
  }
  return out;
}

// --- matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (PDF, canvas and CSS matrix() order) ---

export const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);

export const applyMatrix = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function invertMatrix(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** m1 x m2: apply m2 first, then m1 (the convention of pdf.js Util.transform). */
export function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

// --- page viewport ---

/** Geometry of a blank page of `width` x `height` points. */
export function blankPageGeometry(width, height) {
  return { view: [0, 0, width, height], rotate: 0, userUnit: 1 };
}

/**
 * The matrix of pdf.js' PageViewport: user space -> viewport pixels (ported from pdfjs-dist 6.5.438 and
 * checked against page.getViewport() in tests/pdfGeometry.test.mjs).
 * @returns {{ transform: number[], width: number, height: number, rotation: number }} width / height in pixels
 */
export function viewportTransform({ view, rotate = 0, userUnit = 1 }, scale = 1, extraRotation = 0) {
  const s = scale * userUnit;
  const cx = (view[0] + view[2]) / 2;
  const cy = (view[1] + view[3]) / 2;
  const rotation = normalizeRightAngle(normalizeRightAngle(rotate) + normalizeRightAngle(extraRotation));
  let a;
  let b;
  let c;
  let d;
  switch (rotation) {
    case 180: a = -1; b = 0; c = 0; d = 1; break;
    case 90: a = 0; b = 1; c = 1; d = 0; break;
    case 270: a = 0; b = -1; c = -1; d = 0; break;
    default: a = 1; b = 0; c = 0; d = -1; break;
  }
  let offsetX;
  let offsetY;
  let width;
  let height;
  if (a === 0) {
    offsetX = Math.abs(cy - view[1]) * s;
    offsetY = Math.abs(cx - view[0]) * s;
    width = (view[3] - view[1]) * s;
    height = (view[2] - view[0]) * s;
  } else {
    offsetX = Math.abs(cx - view[0]) * s;
    offsetY = Math.abs(cy - view[1]) * s;
    width = (view[2] - view[0]) * s;
    height = (view[3] - view[1]) * s;
  }
  return {
    transform: [a * s, b * s, c * s, d * s, offsetX - a * s * cx - c * s * cy, offsetY - b * s * cx - d * s * cy],
    width,
    height,
    rotation
  };
}

/** Viewport pixel -> user-space point (pdf.js viewport.convertToPdfPoint). */
export function viewportToUser(geometry, point, scale = 1, extraRotation = 0) {
  return applyMatrix(invertMatrix(viewportTransform(geometry, scale, extraRotation).transform), point);
}

/** User-space point -> viewport pixel (pdf.js viewport.convertToViewportPoint). */
export function userToViewport(geometry, point, scale = 1, extraRotation = 0) {
  return applyMatrix(viewportTransform(geometry, scale, extraRotation).transform, point);
}

/** Size of the page as the reader sees it, in points: [width, height]. */
export function visibleSize(geometry, extraRotation = 0) {
  const { width, height } = viewportTransform(geometry, 1, extraRotation);
  return [width, height];
}

/** A user-space rectangle -> its bounding box in viewport pixels [left, top, right, bottom]. */
export function userRectToViewport(geometry, rect, scale = 1, extraRotation = 0) {
  const { transform } = viewportTransform(geometry, scale, extraRotation);
  const p = applyMatrix(transform, [rect[0], rect[1]]);
  const q = applyMatrix(transform, [rect[2], rect[3]]);
  return normalizeRect([p[0], p[1], q[0], q[1]]);
}

/** A rectangle in viewport pixels -> the user-space rectangle under it (axis-aligned: pages turn by 90 only). */
export function viewportRectToUser(geometry, rect, scale = 1, extraRotation = 0) {
  const inverse = invertMatrix(viewportTransform(geometry, scale, extraRotation).transform);
  const p = applyMatrix(inverse, [rect[0], rect[1]]);
  const q = applyMatrix(inverse, [rect[2], rect[3]]);
  return normalizeRect([p[0], p[1], q[0], q[1]]);
}

// --- frames ---

/** Unit vectors of a frame in user space, scaled to one point: ex = right, ey = UP, eyDown = down. */
export function frameAxes(frame, userUnit = 1) {
  const k = 1 / userUnit;
  const cos = Math.cos(frame.rot * DEG);
  const sin = Math.sin(frame.rot * DEG);
  const ex = [clean(k * cos), clean(k * sin)];
  const ey = [clean(-k * sin), clean(k * cos)];
  return { k, ex, ey, eyDown: [-ey[0] || 0, -ey[1] || 0] };
}

/** Corners of a frame in user space: [topLeft, topRight, bottomRight, bottomLeft] (as the box sees itself). */
export function frameCorners(frame, userUnit = 1) {
  const { ex, ey } = frameAxes(frame, userUnit);
  const hw = frame.w / 2;
  const hh = frame.h / 2;
  const at = (sx, sy) => [frame.x + sx * hw * ex[0] + sy * hh * ey[0], frame.y + sx * hw * ex[1] + sy * hh * ey[1]];
  return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
}

/** Axis-aligned bounding box of a frame in user space: [x0, y0, x1, y1]. */
export function frameBounds(frame, userUnit = 1) {
  const corners = frameCorners(frame, userUnit);
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Matrix of the frame's LOCAL space (origin top-left, y DOWN, points) -> user space.
 * Use it for hit tests and to place local geometry (pen points, text lines) in the page.
 */
export function frameMatrixDown(frame, userUnit = 1) {
  const { ex, eyDown } = frameAxes(frame, userUnit);
  const [topLeft] = frameCorners(frame, userUnit);
  return [ex[0], ex[1], eyDown[0], eyDown[1], topLeft[0], topLeft[1]];
}

/**
 * Matrix for the PDF writer: origin at the frame's BOTTOM-left corner, x right, y UP, unit = one point.
 * Emit `q M cm ... Q` and draw upright inside (local y-down coordinates convert with y' = frame.h - y).
 */
export function frameMatrixUp(frame, userUnit = 1) {
  const { ex, ey } = frameAxes(frame, userUnit);
  const bottomLeft = frameCorners(frame, userUnit)[3];
  return [ex[0], ex[1], ey[0], ey[1], bottomLeft[0], bottomLeft[1]];
}

/** Local point (y down, points) -> user space. */
export function localToUser(frame, point, userUnit = 1) {
  return applyMatrix(frameMatrixDown(frame, userUnit), point);
}

/** User-space point -> local point of the frame (y down, points). */
export function userToLocal(frame, point, userUnit = 1) {
  return applyMatrix(invertMatrix(frameMatrixDown(frame, userUnit)), point);
}

export function pointInFrame(frame, point, userUnit = 1, tolerance = 0) {
  const [lx, ly] = userToLocal(frame, point, userUnit);
  return lx >= -tolerance && ly >= -tolerance && lx <= frame.w + tolerance && ly <= frame.h + tolerance;
}

/**
 * CSS matrix(a, b, c, d, e, f) that places an element whose own box is `frame.w` x `frame.h` CSS pixels
 * (transform-origin: 0 0, positioned at left: 0; top: 0 of the page element) exactly over the frame.
 */
export function frameToCssMatrix(geometry, frame, scale = 1, extraRotation = 0) {
  const { transform } = viewportTransform(geometry, scale, extraRotation);
  return multiplyMatrix(transform, frameMatrixDown(frame, geometry.userUnit || 1)).map(clean);
}

/** Clockwise rotation, in degrees on screen, of a frame on a page shown with `extraRotation`. */
export function frameScreenRotation(geometry, frame, extraRotation = 0) {
  return normalizeAngle(normalizeRightAngle(geometry.rotate) + normalizeRightAngle(extraRotation) - frame.rot);
}

/** The frame as the reader sees it: centre in viewport pixels, size in pixels, clockwise rotation in degrees. */
export function frameOnScreen(geometry, frame, scale = 1, extraRotation = 0) {
  const [cx, cy] = userToViewport(geometry, [frame.x, frame.y], scale, extraRotation);
  return { cx, cy, w: frame.w * scale, h: frame.h * scale, rotation: frameScreenRotation(geometry, frame, extraRotation) };
}

/**
 * The inverse: a box drawn on screen -> the frame to store.
 * @param {{ cx: number, cy: number, w: number, h: number, rotation?: number }} box  centre and size in viewport
 *        pixels at `scale`, `rotation` clockwise in degrees on screen (0 = upright for the reader)
 */
export function frameFromScreen(geometry, box, scale = 1, extraRotation = 0) {
  const [x, y] = viewportToUser(geometry, [box.cx, box.cy], scale, extraRotation);
  const rot = normalizeAngle(normalizeRightAngle(geometry.rotate) + normalizeRightAngle(extraRotation) - (box.rotation || 0));
  return { x, y, w: box.w / scale, h: box.h / scale, rot };
}

/** A frame that looks upright on screen and covers the user-space rectangle `rect`. */
export function frameFromUserRect(geometry, rect, extraRotation = 0) {
  const [x0, y0, x1, y1] = normalizeRect(rect);
  const k = 1 / (geometry.userUnit || 1);
  const rot = normalizeRightAngle(normalizeRightAngle(geometry.rotate) + normalizeRightAngle(extraRotation));
  const across = (x1 - x0) / k;
  const along = (y1 - y0) / k;
  const turned = rot === 90 || rot === 270;
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: turned ? along : across, h: turned ? across : along, rot };
}

/**
 * Resizes a frame to `w` x `h` points while one of its own points stays where it is on the page.
 * `anchor` = [u, v] in the box: 0 = left / top, 0.5 = middle, 1 = right / bottom (e.g. [0, 0] keeps the
 * top-left corner: a text box that grows while typing; [0.5, 0] keeps the top centre for centred text).
 */
export function resizeFrame(frame, w, h, anchor = [0, 0], userUnit = 1) {
  const { ex, eyDown } = frameAxes(frame, userUnit);
  const dx = (anchor[0] - 0.5) * (frame.w - w);
  const dy = (anchor[1] - 0.5) * (frame.h - h);
  return { ...frame, w, h, x: frame.x + dx * ex[0] + dy * eyDown[0], y: frame.y + dx * ex[1] + dy * eyDown[1] };
}

/** Moves a frame by a vector given in user space. */
export function translateFrame(frame, dx, dy) {
  return { ...frame, x: frame.x + dx, y: frame.y + dy };
}

/** A drag of (dxPx, dyPx) viewport pixels -> the same displacement in user space. */
export function viewportDeltaToUser(geometry, delta, scale = 1, extraRotation = 0) {
  const inverse = invertMatrix(viewportTransform(geometry, scale, extraRotation).transform);
  return [inverse[0] * delta[0] + inverse[2] * delta[1], inverse[1] * delta[0] + inverse[3] * delta[1]];
}

/** Millimetres <-> points, for the numbers shown to the user. */
export const MM_PER_POINT = 25.4 / 72;
export const pointsToMm = (points) => points * MM_PER_POINT;
export const mmToPoints = (mm) => mm / MM_PER_POINT;

/** Standard page sizes in points (portrait). */
export const PAGE_SIZES = Object.freeze({
  A3: Object.freeze([841.89, 1190.55]),
  A4: Object.freeze([595.28, 841.89]),
  A5: Object.freeze([419.53, 595.28]),
  LETTER: Object.freeze([612, 792]),
  LEGAL: Object.freeze([612, 1008])
});
