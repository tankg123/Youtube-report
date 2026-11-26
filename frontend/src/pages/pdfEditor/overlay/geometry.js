// Geometry of the page overlay as pure functions (tests/pdfOverlayGeometry.test.mjs): from pointer pixels to
// the user space of a page and back, around every rotation of a page; where the outline, the handles and
// the rotation handle of a selected object stand on screen; the matrix that puts the local frame of a line
// on screen. No DOM, no React.
//
// "Pixels" are CSS pixels inside the element of ONE page (origin at its top-left corner, y down), at
// `scale` pixels per point: the coordinates of the interaction reducer (tools/interaction.js). Everything
// that knows /Rotate, a CropBox, /UserUnit and the rotation the user added lives in engine/geometry.js and
// model/transform.js; this file only puts those functions together for the screen.
import { frameCorners, frameFromUserRect, multiplyMatrix, normalizeRect, userToViewport, viewportToUser, viewportTransform } from "../engine/geometry.js";
import { objectBounds, pageGeometry } from "../model/schema.js";
import { geometryKind, quadToPolygon } from "../model/shapes.js";
import { canRotate, handlesOf, resizeCursor, screenRotationOf } from "../model/transform.js";

/** Handles are 8 px squares with a 16 px hit area (UX specification 5.2). */
export const HANDLE_SIZE = 8;
export const HANDLE_HIT = 16;
/** The rotation handle stands this far outside the top edge of the box (pixels). */
export const ROTATE_OFFSET = 24;
/** A press this near to an object still hits it (pixels); thin lines get a hit area about 12 px wide. */
export const HIT_TOLERANCE_PX = 5;

const extra = (page) => page.rotation || 0;

/** Pixels of the page element -> user space of the page. */
export function pixelsToUser(page, point, scale = 1) {
  const x = Array.isArray(point) ? point[0] : point.x;
  const y = Array.isArray(point) ? point[1] : point.y;
  return viewportToUser(pageGeometry(page), [x, y], scale, extra(page));
}

/** User space of the page -> pixels of the page element: [x, y]. */
export function userToPixels(page, point, scale = 1) {
  return userToViewport(pageGeometry(page), point, scale, extra(page));
}

/** A user-space rectangle -> its box in pixels: [left, top, right, bottom]. */
export function userRectToPixels(page, rect, scale = 1) {
  const a = userToPixels(page, [rect[0], rect[1]], scale);
  const b = userToPixels(page, [rect[2], rect[3]], scale);
  return normalizeRect([a[0], a[1], b[0], b[1]]);
}

/** A quad [x1, y1, ..., x4, y4] of the page -> its four corners in pixels. */
export function quadToPixels(page, quad, scale = 1) {
  return quadToPolygon(quad).map((corner) => userToPixels(page, corner, scale));
}

/** How near (in points) a press must be to an object to hit it, at a zoom. */
export const hitTolerance = (scale = 1) => HIT_TOLERANCE_PX / (scale > 0 ? scale : 1);

/**
 * The CSS matrix(a, b, c, d, e, f) of the local frame of a line object: origin at p1, x towards p2, one unit =
 * one point. The export engine draws a line in exactly this frame (engine/export/objects.js); the shaft lies
 * on the x axis and the heads are symmetric to it, so the direction of the local y axis does not matter.
 * @returns {{ matrix: number[], length: number }} length = the length of the line in points
 */
export function lineCssMatrix(page, line, scale = 1) {
  const geometry = pageGeometry(page);
  const k = 1 / (geometry.userUnit || 1); // one point in user-space units
  const dx = line.p2[0] - line.p1[0];
  const dy = line.p2[1] - line.p1[1];
  const distance = Math.hypot(dx, dy);
  const ux = distance > 0 ? dx / distance : 1;
  const uy = distance > 0 ? dy / distance : 0;
  const { transform } = viewportTransform(geometry, scale, extra(page));
  return { matrix: multiplyMatrix(transform, [k * ux, k * uy, -k * uy, k * ux, line.p1[0], line.p1[1]]), length: distance / k };
}

/** The outline of an object on screen: a list of polygons (or one open segment for a line), in pixels. */
export function outlineOf(object, page, scale = 1) {
  const userUnit = page.userUnit || 1;
  switch (geometryKind(object)) {
    case "frame":
      return [frameCorners(object.frame, userUnit).map((corner) => userToPixels(page, corner, scale))];
    case "rect": {
      const [left, top, right, bottom] = userRectToPixels(page, object.rect, scale);
      return [[[left, top], [right, top], [right, bottom], [left, bottom]]];
    }
    case "line":
      return [[userToPixels(page, object.p1, scale), userToPixels(page, object.p2, scale)]];
    case "quads":
      return object.quads.map((quad) => quadToPixels(page, quad, scale));
    default:
      return [];
  }
}

/** The box around polygons: [left, top, right, bottom], or null for none. */
export function boxOfPolygons(polygons) {
  let box = null;
  for (const polygon of polygons) {
    for (const [x, y] of polygon) {
      box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
    }
  }
  return box;
}

/** The bounding box of an object on screen in pixels: [left, top, right, bottom]. */
export function objectPixelBox(object, page, scale = 1) {
  return userRectToPixels(page, objectBounds(object, page.userUnit || 1), scale);
}

/** The box around several objects of ONE page in pixels, or null. */
export function selectionPixelBox(objects, page, scale = 1) {
  let box = null;
  for (const object of objects) {
    const [left, top, right, bottom] = objectPixelBox(object, page, scale);
    box = box ? [Math.min(box[0], left), Math.min(box[1], top), Math.max(box[2], right), Math.max(box[3], bottom)] : [left, top, right, bottom];
  }
  return box;
}

/**
 * Everything the selection frame of ONE object needs, in pixels of its page element:
 *   polygons  the outline (outlineOf)
 *   handles   [{ id, x, y, cursor }]: the handles of model/transform.js handlesOf with the CSS cursor that
 *             points the way the handle moves on screen (rotated boxes and rotated pages included)
 *   rotate    { x, y, anchorX, anchorY } | null: the rotation handle and the middle of the top edge it hangs on
 *   box       [left, top, right, bottom] around the outline
 */
export function selectionLayout(object, page, scale = 1) {
  const polygons = outlineOf(object, page, scale);
  const rotation = screenRotationOf(object, page);
  // a mark has no rotation of its own: its handles are those of a box that looks upright on screen
  const cursorRotation = geometryKind(object) === "rect" ? 0 : rotation;
  const handles = handlesOf(object, page).map(({ id, point }) => {
    const [x, y] = userToPixels(page, point, scale);
    return { id, x, y, cursor: id === "p1" || id === "p2" ? "move" : resizeCursor(id, cursorRotation) };
  });
  let rotate = null;
  if (canRotate(object) && polygons.length) {
    const [topLeft, topRight, bottomRight] = polygons[0];
    const anchorX = (topLeft[0] + topRight[0]) / 2;
    const anchorY = (topLeft[1] + topRight[1]) / 2;
    const centreX = (topLeft[0] + bottomRight[0]) / 2;
    const centreY = (topLeft[1] + bottomRight[1]) / 2;
    let dx = anchorX - centreX;
    let dy = anchorY - centreY;
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) {
      dx /= length;
      dy /= length;
    } else {
      // a box without height: "up" for the box is a quarter turn from its top edge
      const ex = topRight[0] - topLeft[0];
      const ey = topRight[1] - topLeft[1];
      const edge = Math.hypot(ex, ey) || 1;
      dx = ey / edge;
      dy = -ex / edge;
    }
    rotate = { x: anchorX + dx * ROTATE_OFFSET, y: anchorY + dy * ROTATE_OFFSET, anchorX, anchorY };
  }
  return { polygons, handles, rotate, box: boxOfPolygons(polygons) };
}

/** The frame that looks upright on screen and covers a mark: its width and height are what the reader sees. */
export function uprightFrameOf(object, page) {
  if (object.frame) return object.frame;
  if (Array.isArray(object.rect)) return frameFromUserRect(pageGeometry(page), object.rect, extra(page));
  return null;
}

/**
 * A line as the reader sees it: { length (points), angle (degrees, clockwise on screen, 0 = pointing right) }.
 * The numeric alternative to dragging its ends (the properties panel).
 */
export function lineOnScreen(line, page) {
  const a = userToPixels(page, line.p1, 1);
  const b = userToPixels(page, line.p2, 1);
  const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return { length: Math.hypot(b[0] - a[0], b[1] - a[1]), angle: ((angle % 360) + 360) % 360 };
}

/** The end p2 of a line (user space) for a length in points and an angle on screen; p1 stays where it is. */
export function lineEndFor(line, page, { length, angle }) {
  const now = lineOnScreen(line, page);
  const size = Number.isFinite(length) ? Math.max(0, length) : now.length;
  const turn = ((Number.isFinite(angle) ? angle : now.angle) * Math.PI) / 180;
  const a = userToPixels(page, line.p1, 1);
  return pixelsToUser(page, [a[0] + size * Math.cos(turn), a[1] + size * Math.sin(turn)], 1);
}

/** "M x y L x y ... Z" for a polygon in pixels (an SVG path). */
export function polygonPath(polygon, close = true) {
  if (!polygon.length) return "";
  const round = (value) => Math.round(value * 100) / 100;
  return `${polygon.map(([x, y], index) => `${index ? "L" : "M"}${round(x)} ${round(y)}`).join(" ")}${close ? " Z" : ""}`;
}
