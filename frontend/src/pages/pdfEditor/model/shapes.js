// Low-level geometry of editor objects, shared by selectors.js, transform.js, the store and the clipboard.
// Pure functions: no DOM, no user text. Everything is in the page's PDF user space unless a name says
// "screen": screen coordinates are POINTS as the reader sees the page (origin at the top-left corner of the
// visible page, x right, y down, one unit = one point whatever the zoom is), i.e. the viewport of
// engine/geometry.js at scale 1 with the page's own /Rotate and the rotation the user added.
import {
  applyMatrix,
  frameCorners,
  frameFromScreen,
  frameScreenRotation,
  invertMatrix,
  localToUser,
  normalizeAngle,
  normalizeRect,
  unionRects,
  viewportTransform
} from "../engine/geometry.js";
import { objectBounds, pageGeometry } from "./schema.js";

// -0 would make two equal results differ under a strict deep comparison (tests, change detection).
const tidy = (value) => (value === 0 ? 0 : value);

/**
 * How an object is placed: "frame" (text, image, rect, ellipse, pen, freehand highlight), "rect" (redact,
 * blur and any { rect } pseudo-object such as the certificate signature field), "line" or "quads" (text
 * highlight). null for anything else.
 */
export function geometryKind(object) {
  if (!object || typeof object !== "object") return null;
  if (object.frame) return "frame";
  if (Array.isArray(object.rect)) return "rect";
  if (Array.isArray(object.p1) && Array.isArray(object.p2)) return "line";
  if (Array.isArray(object.quads)) return "quads";
  return null;
}

/** The patch that moves an object by (dx, dy) in user space; null when the object has no geometry. */
export function translatePatch(object, dx, dy) {
  switch (geometryKind(object)) {
    case "frame":
      return { frame: { ...object.frame, x: object.frame.x + dx, y: object.frame.y + dy } };
    case "rect":
      return { rect: [object.rect[0] + dx, object.rect[1] + dy, object.rect[2] + dx, object.rect[3] + dy] };
    case "line":
      return { p1: [object.p1[0] + dx, object.p1[1] + dy], p2: [object.p2[0] + dx, object.p2[1] + dy] };
    case "quads":
      return { quads: object.quads.map((quad) => quad.map((value, index) => value + (index % 2 ? dy : dx))) };
    default:
      return null;
  }
}

/** The patch that sends every point of an object through `mapPoint` (frames keep their size; see mapFrame). */
export function mapGeometryPatch(object, mapPoint, mapFrame) {
  switch (geometryKind(object)) {
    case "frame":
      return { frame: mapFrame(object.frame) };
    case "rect": {
      const a = mapPoint([object.rect[0], object.rect[1]]);
      const b = mapPoint([object.rect[2], object.rect[3]]);
      return { rect: normalizeRect([a[0], a[1], b[0], b[1]]) };
    }
    case "line":
      return { p1: mapPoint(object.p1), p2: mapPoint(object.p2) };
    case "quads":
      return {
        quads: object.quads.map((quad) => {
          const out = [];
          for (let index = 0; index < 8; index += 2) out.push(...mapPoint([quad[index], quad[index + 1]]));
          return out;
        })
      };
    default:
      return null;
  }
}

/**
 * The screen of one page: conversions between user space and screen points (see the header).
 * @param {{ view: number[], baseRotation: number, userUnit: number, rotation: number }} page  a Page of the model
 */
export function pageScreen(page) {
  const geometry = pageGeometry(page);
  const extra = page.rotation || 0;
  const { transform, width, height, rotation } = viewportTransform(geometry, 1, extra);
  const inverse = invertMatrix(transform);
  const toScreen = (point) => applyMatrix(transform, point).map(tidy);
  const toUser = (point) => applyMatrix(inverse, point).map(tidy);
  const corners = (rect, matrix) => {
    const a = applyMatrix(matrix, [rect[0], rect[1]]);
    const b = applyMatrix(matrix, [rect[2], rect[3]]);
    return normalizeRect([a[0], a[1], b[0], b[1]]).map(tidy);
  };
  return {
    page,
    geometry,
    extra,
    /** Visible size of the page in points. */
    width,
    height,
    /** /Rotate + the rotation added by the user: the `rot` of a frame that looks upright. */
    uprightRot: rotation,
    userUnit: geometry.userUnit || 1,
    toScreen,
    toUser,
    /** Displacements (no translation part). */
    deltaToScreen: ([dx, dy]) => [tidy(transform[0] * dx + transform[2] * dy), tidy(transform[1] * dx + transform[3] * dy)],
    deltaToUser: ([dx, dy]) => [tidy(inverse[0] * dx + inverse[2] * dy), tidy(inverse[1] * dx + inverse[3] * dy)],
    /** Axis-aligned rectangles: [x0, y0, x1, y1] in user space <-> [left, top, right, bottom] on screen. */
    rectToScreen: (rect) => corners(rect, transform),
    rectToUser: (box) => corners(box, inverse),
    /** A box on screen (points, clockwise `rotation` in degrees, 0 = upright for the reader) -> the frame to store. */
    frameFromBox: ({ left, top, width: w, height: h }, boxRotation = 0) => {
      const frame = frameFromScreen(geometry, { cx: left + w / 2, cy: top + h / 2, w, h, rotation: boxRotation }, 1, extra);
      return { x: tidy(frame.x), y: tidy(frame.y), w: frame.w, h: frame.h, rot: frame.rot };
    },
    /** Clockwise rotation of a frame as the reader sees it, in degrees. */
    screenRotation: (frame) => frameScreenRotation(geometry, frame, extra)
  };
}

/** Bounding box of an object on screen: [left, top, right, bottom] in points (see the header). */
export function objectScreenBox(object, page) {
  const screen = pageScreen(page);
  return screen.rectToScreen(objectBounds(object, screen.userUnit));
}

/** Union of the screen boxes of several objects of ONE page; null for an empty list. */
export function groupScreenBox(objects, page) {
  return unionRects(objects.map((object) => objectScreenBox(object, page)));
}

/**
 * The same object as it would look at the same place of ANOTHER page: the patch of its geometry such that its
 * position on screen (distance from the top-left corner of the visible page, plus `offset` in screen points)
 * and its rotation on screen stay what they are. Sizes in points are kept.
 */
export function mapToPagePatch(object, fromPage, toPage, offset = [0, 0]) {
  const from = pageScreen(fromPage);
  const to = pageScreen(toPage);
  const mapPoint = (point) => {
    const [sx, sy] = from.toScreen(point);
    return to.toUser([sx + offset[0], sy + offset[1]]);
  };
  const mapFrame = (frame) => {
    const [x, y] = mapPoint([frame.x, frame.y]);
    return { ...frame, x, y, rot: normalizeAngle(to.uprightRot - from.uprightRot + frame.rot) };
  };
  return mapGeometryPatch(object, mapPoint, mapFrame);
}

// --- points, segments, polygons ---

export function distanceToSegment(point, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = point[0] - a[0];
  const wy = point[1] - a[1];
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSquared)) : 0;
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** Distance from a point to a polyline (a single point counts as a dot). */
export function distanceToPolyline(point, points) {
  if (!points.length) return Infinity;
  if (points.length === 1) return Math.hypot(point[0] - points[0][0], point[1] - points[0][1]);
  let best = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    const distance = distanceToSegment(point, points[index - 1], points[index]);
    if (distance < best) best = distance;
  }
  return best;
}

/** Even-odd test: works for the quads of text highlights whatever their winding is. */
export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, yi] = polygon[index];
    const [xj, yj] = polygon[previous];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToPolygon(point, polygon) {
  if (pointInPolygon(point, polygon)) return 0;
  let best = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const distance = distanceToSegment(point, polygon[index], polygon[(index + 1) % polygon.length]);
    if (distance < best) best = distance;
  }
  return best;
}

/** Separating-axis test of a convex polygon (or a segment, or a point) against an axis-aligned rectangle; touching counts. */
export function polygonIntersectsRect(polygon, rect) {
  const [x0, y0, x1, y1] = normalizeRect(rect);
  const box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const axes = [[1, 0], [0, 1]];
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    if (ex !== 0 || ey !== 0) axes.push([-ey, ex]);
  }
  for (const [ax, ay] of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const [px, py] of polygon) {
      const projection = px * ax + py * ay;
      if (projection < minA) minA = projection;
      if (projection > maxA) maxA = projection;
    }
    for (const [px, py] of box) {
      const projection = px * ax + py * ay;
      if (projection < minB) minB = projection;
      if (projection > maxB) maxB = projection;
    }
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

export const quadToPolygon = (quad) => [[quad[0], quad[1]], [quad[2], quad[3]], [quad[4], quad[5]], [quad[6], quad[7]]];

/** The points of a pen stroke or freehand highlight (fractions of its frame) in user space. */
export function strokePointsInUser(object, userUnit = 1) {
  const { frame } = object;
  return object.points.map(([u, v]) => localToUser(frame, [u * frame.w, v * frame.h], userUnit));
}

/** The outline of a frame-shaped object in user space: [topLeft, topRight, bottomRight, bottomLeft]. */
export const framePolygon = (frame, userUnit = 1) => frameCorners(frame, userUnit);

/**
 * Thins out the samples of a freehand stroke: a point stays when it is at least `spacing` away from the last
 * point that stayed; the first and the last point always stay, repeated points go.
 *
 * Why by distance and not by "is it on the line between its neighbours" (Ramer-Douglas-Peucker): strokes are
 * drawn as a smooth curve THROUGH the stored points (a Catmull-Rom spline, engine/export/shapes.js
 * smoothPath). Such a curve follows the hand only while the points are close together; with nothing but the
 * corners of an "L" left, it swings several points away from what was drawn (measured against the export
 * engine: 3 pt on a 30 x 50 pt corner).
 */
export function thinPolyline(points, spacing = 1) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= spacing) out.push(point);
  }
  // the stroke ends where the pointer was released, however close that is to the last sample that stayed
  const end = points[points.length - 1];
  const last = out[out.length - 1];
  if (end && last && (end[0] !== last[0] || end[1] !== last[1])) out.push(end);
  return out;
}

// --- small data helpers ---

/** Structural equality of plain data (numbers, strings, booleans, null, arrays, plain objects, Uint8Array). */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
    return true;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (!deepEqual(a[index], b[index])) return false;
    return true;
  }
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** Freezes plain data in depth (typed arrays are left alone: they cannot be frozen). Returns its argument. */
export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}
