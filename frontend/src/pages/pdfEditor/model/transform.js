// The pure maths of every editing gesture: move, resize, rotate, drag a line end, nudge, align to the screen,
// and the factories that make each object type from one or two points. No DOM, no store, no user text.
//
// Everything works in the page's PDF USER SPACE (engine/geometry.js) and takes the Page of the model, so that
// /Rotate, a CropBox, /UserUnit and the rotation the user added to the page are all accounted for. "Screen"
// means points as the reader sees the page (origin top-left of the visible page, y down: model/shapes.js).
// The overlay converts pointer positions with pagePointFromPixels() / screenDeltaFromPixels().
//
// Every function returns a PATCH for store.updateObjects([{ id, patch }]) (or null when the gesture does not
// apply to that object), and every factory returns an object WITHOUT id for store.addObjects([object]).
// The same functions drive the live preview: { ...object, ...patch }.
import { frameAxes, frameBounds, frameFromUserRect, normalizeAngle, normalizeRect, resizeFrame, viewportToUser } from "../engine/geometry.js";
import { quantizeFontSize } from "../engine/textRules.js";
import {
  BLUR_STYLES,
  DASH_STYLES,
  FONT_SIZE_LIMITS,
  MIN_OBJECT_SIZE,
  OBJECT_DEFAULTS,
  STROKE_WIDTH_LIMITS,
  TEXT_ALIGNMENTS,
  TEXT_FONTS,
  normalizeColor,
  pageGeometry
} from "./schema.js";
import { isMovable } from "./selectors.js";
import { geometryKind, groupScreenBox, mapToPagePatch, objectScreenBox, pageScreen, thinPolyline, translatePatch } from "./shapes.js";

const DEG = Math.PI / 180;
const tidy = (value) => (value === 0 ? 0 : value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

// --- constants of the interaction model (UX specification, sections 5 and 7) ---

/** Handles of a box, named as the box sees itself (its own top-left corner is "nw" whatever its rotation). */
export const HANDLES = Object.freeze(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
export const CORNER_HANDLES = Object.freeze(["nw", "ne", "se", "sw"]);
export const TEXT_HANDLES = Object.freeze(["w", "e"]);
/** Handles of a line: its two ends. */
export const LINE_HANDLES = Object.freeze(["p1", "p2"]);

export const ROTATION_SNAP_DEGREES = 15;
export const LINE_SNAP_DEGREES = 45;
export const NUDGE_STEP = 1;
export const NUDGE_BIG_STEP = 10;
/** A duplicate or a paste lands this far right and down of the original, as seen on screen (points). */
export const DUPLICATE_OFFSET = Object.freeze([12, 12]);
/** Size in points of what a click (no drag) creates. */
export const DEFAULT_SIZES = Object.freeze({
  rect: Object.freeze([120, 80]),
  ellipse: Object.freeze([120, 80]),
  redact: Object.freeze([120, 24]),
  blur: Object.freeze([120, 60]),
  signatureField: Object.freeze([180, 60])
});
export const DEFAULT_LINE_LENGTH = 120;
/** A signature picture placed by a click is this wide (points). */
export const SIGNATURE_DEFAULT_WIDTH = 160;
/** Smallest rectangle of a visible certificate signature (points). */
export const SIGNATURE_FIELD_MIN_SIZE = Object.freeze([72, 36]);
/** A picture placed by a click gets its natural size at 96 dpi ... */
export const IMAGE_POINTS_PER_PIXEL = 72 / 96;
/** ... but never more than this share of the visible page width. */
export const IMAGE_MAX_PAGE_SHARE = 0.5;
/**
 * Pen and highlighter samples are kept this far apart (points). Strokes are drawn as a smooth curve through
 * the stored points, so the points must stay close together: see thinPolyline in shapes.js.
 */
export const STROKE_SPACING = 1;

const HANDLE_SIGNS = Object.freeze({ nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] });
// Direction of each handle seen from the centre of the box, clockwise from "e", for the resize cursor.
const HANDLE_ANGLES = Object.freeze({ e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 });

// --- what a tool creates, and with which style ---

/** The things a tool can create. "arrow" is a line with a head, "highlighter" a freehand highlight, "signature" an image. */
export const CREATION_KINDS = Object.freeze(["text", "rect", "ellipse", "line", "arrow", "pen", "highlighter", "redact", "blur", "image", "signature"]);
const KIND_TYPES = Object.freeze({ text: "text", rect: "rect", ellipse: "ellipse", line: "line", arrow: "line", pen: "pen", highlighter: "highlight", redact: "redact", blur: "blur", image: "image", signature: "image" });

/** The object type of model/schema.js that a creation kind makes (null for an unknown kind). */
export const objectTypeOfKind = (kind) => KIND_TYPES[kind] || null;

const paint = (allowNone) => (value) => (value === null ? (allowNone ? null : undefined) : normalizeColor(value) ?? undefined);
const flag = (value) => (typeof value === "boolean" ? value : undefined);
const oneOf = (list) => (value) => (list.includes(value) ? value : undefined);
const within = (min, max) => (value) => (finite(value) ? clampNumber(value, min, max) : undefined);
const strokeWidth = within(STROKE_WIDTH_LIMITS.min, STROKE_WIDTH_LIMITS.max);
const opacity = within(0, 1);

// The style properties of each object type with the function that accepts (and normalises) a value.
const STYLE_RULES = Object.freeze({
  text: {
    font: oneOf(TEXT_FONTS.map((font) => font.id)),
    size: (value) => (finite(value) ? quantizeFontSize(clampNumber(value, FONT_SIZE_LIMITS.min, FONT_SIZE_LIMITS.max)) : undefined),
    bold: flag,
    italic: flag,
    underline: flag,
    color: paint(false),
    align: oneOf(TEXT_ALIGNMENTS),
    lineHeight: within(0.5, 5),
    opacity
  },
  image: { opacity },
  rect: { stroke: paint(true), strokeWidth, dash: oneOf(DASH_STYLES), fill: paint(true), opacity },
  ellipse: { stroke: paint(true), strokeWidth, dash: oneOf(DASH_STYLES), fill: paint(true), opacity },
  line: { stroke: paint(false), strokeWidth, dash: oneOf(DASH_STYLES), headStart: flag, headEnd: flag, opacity },
  pen: { color: paint(false), width: strokeWidth, opacity },
  highlight: { color: paint(false), thickness: strokeWidth },
  redact: { color: paint(false) },
  blur: { style: oneOf(BLUR_STYLES), strength: oneOf([1, 2, 3]) }
});

/** The names of the style properties of an object type (what a properties panel may edit besides the geometry). */
export const styleKeysOf = (type) => Object.keys(STYLE_RULES[type] || {});

/**
 * Keeps only the style properties that `type` has, with valid values (colours become "#rrggbb", numbers are
 * brought into their limits); everything else is dropped. Use it on values that come from localStorage.
 */
export function sanitizeStyle(type, style) {
  const rules = STYLE_RULES[type];
  const out = {};
  if (!rules || !style || typeof style !== "object") return out;
  for (const [key, accept] of Object.entries(rules)) {
    if (!Object.prototype.hasOwnProperty.call(style, key)) continue;
    const value = accept(style[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The style of a new object: OBJECT_DEFAULTS of its type, what the kind adds (an arrow has a head), then the tool's own defaults. */
export function styleFor(kind, toolDefaults) {
  const type = objectTypeOfKind(kind) || kind;
  const style = { ...OBJECT_DEFAULTS[type], ...sanitizeStyle(type, toolDefaults) };
  if (type === "text") delete style.autoWidth; // decided by the gesture (click or drag), not by the style
  if (type === "image") style.role = kind === "signature" ? "signature" : "image";
  if (kind === "arrow" && !style.headStart && !style.headEnd) style.headEnd = true;
  return style;
}

/** The value sharedStyle() reports for a property that the selected objects do not agree on. */
export const MIXED = Symbol("mixed");

/**
 * What a properties panel shows for a selection: the style properties that EVERY object has, each with the
 * common value or MIXED. Empty for no objects.
 */
export function sharedStyle(objects) {
  const out = {};
  if (!objects.length) return out;
  const keys = styleKeysOfObject(objects[0]).filter((key) => objects.every((object) => styleKeysOfObject(object).includes(key)));
  for (const key of keys) {
    const value = objects[0][key];
    out[key] = objects.every((object) => object[key] === value) ? value : MIXED;
  }
  return out;
}

/**
 * A style change for a selection: the updates for store.updateObjects(), where every object only gets the
 * properties its type has, with normalised values (a stroke colour is not written onto a text box).
 * @returns {Array<{ id: string, patch: object }>}
 */
export function styleUpdates(state, ids, style) {
  const updates = [];
  for (const id of ids) {
    const object = state.objects[id];
    if (!object) continue;
    const own = styleKeysOfObject(object);
    const patch = Object.fromEntries(Object.entries(sanitizeStyle(object.type, style)).filter(([key]) => own.includes(key)));
    if (Object.keys(patch).length) updates.push({ id, patch });
  }
  return updates;
}

// a highlight of document text has a colour and nothing else (the thickness belongs to the freehand marker)
function styleKeysOfObject(object) {
  const keys = styleKeysOf(object.type);
  return object.type === "highlight" && object.mode === "text" ? keys.filter((key) => key === "color") : keys;
}

// --- pointer positions ---

/** A pointer position in CSS pixels inside the page element (zoom `scale` = pixels per point) -> user space. */
export function pagePointFromPixels(page, point, scale = 1) {
  const x = Array.isArray(point) ? point[0] : point.x;
  const y = Array.isArray(point) ? point[1] : point.y;
  return viewportToUser(pageGeometry(page), [x, y], scale, page.rotation || 0).map(tidy);
}

/** A drag in CSS pixels -> the same drag in screen points. */
export function screenDeltaFromPixels(delta, scale = 1) {
  const dx = Array.isArray(delta) ? delta[0] : delta.dx;
  const dy = Array.isArray(delta) ? delta[1] : delta.dy;
  return [dx / scale, dy / scale];
}

/** A displacement in screen points (x right, y down, as the reader sees it) -> user space of that page. */
export const screenDeltaToUser = (page, delta) => pageScreen(page).deltaToUser(delta);
export const userDeltaToScreen = (page, delta) => pageScreen(page).deltaToScreen(delta);

const DIRECTIONS = Object.freeze({ left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });

/** The user-space displacement of an arrow key: "left" | "right" | "up" | "down" (or the key names) as seen on screen. */
export function nudgeDelta(page, direction, distance = NUDGE_STEP) {
  const unit = DIRECTIONS[direction];
  if (!unit) return [0, 0];
  return screenDeltaToUser(page, [unit[0] * distance, unit[1] * distance]);
}

/** Shift while moving: only the larger component of the drag counts (pages turn by 90 degrees only, so this is the screen axis too). */
export function constrainToAxis([dx, dy]) {
  return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
}

// --- move ---

/** The patch that moves an object by a user-space displacement; null for what cannot move (a text highlight). */
export function moveObject(object, [dx, dy]) {
  return isMovable(object) ? translatePatch(object, dx, dy) : null;
}

/**
 * Moves objects by a displacement given in screen points: every object with the geometry of its OWN page
 * (a selection can span pages that are turned differently).
 * @returns {Array<{ id: string, patch: object }>}
 */
export function moveObjectsOnScreen(state, ids, screenDelta, { axisLock = false } = {}) {
  const delta = axisLock ? constrainToAxis(screenDelta) : screenDelta;
  if (!delta[0] && !delta[1]) return [];
  const wanted = new Set(ids);
  const updates = [];
  for (const page of state.pages) {
    let userDelta = null;
    for (const id of page.objectIds) {
      if (!wanted.has(id)) continue;
      const object = state.objects[id];
      if (!object || !isMovable(object)) continue;
      userDelta = userDelta || screenDeltaToUser(page, delta);
      updates.push({ id, patch: translatePatch(object, userDelta[0], userDelta[1]) });
    }
  }
  return updates;
}

/** Arrow keys: the selection moves `distance` points in a screen direction. */
export function nudgeObjects(state, ids, direction, distance = NUDGE_STEP) {
  const unit = DIRECTIONS[direction];
  return unit ? moveObjectsOnScreen(state, ids, [unit[0] * distance, unit[1] * distance]) : [];
}

// --- resize ---

/** Pictures keep their aspect ratio unless Shift is held; everything else is free unless Shift is held. */
export const defaultRatioLock = (object) => object?.type === "image";

/**
 * The handles an object shows.
 *   text boxes            left and right only (they set the wrap width; the height follows the text)
 *   images, signatures    the four corners
 *   shapes, pen strokes, freehand highlights, redactions, blur areas: all eight
 *   lines and arrows      the two ends ("p1", "p2")
 *   text highlights       none
 */
export function handleIdsOf(object) {
  switch (geometryKind(object)) {
    case "frame":
      if (object.type === "text") return TEXT_HANDLES;
      if (object.type === "image") return CORNER_HANDLES;
      return HANDLES;
    case "rect":
      return HANDLES;
    case "line":
      return LINE_HANDLES;
    default:
      return [];
  }
}

/** Rotation is offered for text boxes, images, shapes and pen strokes; never for marks, lines and highlights. */
export const canRotate = (object) => geometryKind(object) === "frame" && object.type !== "highlight";

/** The box an object is resized through: its frame, or for a mark the frame that covers it and looks upright on screen. */
function resizeBox(object, page) {
  if (object.frame) return object.frame;
  return frameFromUserRect(pageGeometry(page), object.rect, page.rotation || 0);
}

/**
 * The handles of an object with their position in user space: [{ id, point: [x, y] }].
 * (An overlay that draws the selection box as a transformed element can also place them with CSS.)
 */
export function handlesOf(object, page) {
  const kind = geometryKind(object);
  if (kind === "line") return [{ id: "p1", point: object.p1.slice() }, { id: "p2", point: object.p2.slice() }];
  if (kind !== "frame" && kind !== "rect") return [];
  const frame = resizeBox(object, page);
  const { ex, eyDown } = frameAxes(frame, page.userUnit || 1);
  return handleIdsOf(object).map((id) => {
    const [sx, sy] = HANDLE_SIGNS[id];
    const u = (sx * frame.w) / 2;
    const v = (sy * frame.h) / 2;
    return { id, point: [tidy(frame.x + u * ex[0] + v * eyDown[0]), tidy(frame.y + u * ex[1] + v * eyDown[1])] };
  });
}

/**
 * The CSS cursor of a resize handle, from the direction the handle points to on screen.
 * @param {string} handle           one of HANDLES
 * @param {number} screenRotation   clockwise rotation of the box on screen in degrees (frameScreenRotation)
 */
export function resizeCursor(handle, screenRotation = 0) {
  const base = HANDLE_ANGLES[handle];
  if (base === undefined) return "move";
  const angle = (((base + screenRotation) % 180) + 180) % 180;
  if (angle < 22.5 || angle >= 157.5) return "ew-resize";
  if (angle < 67.5) return "nwse-resize";
  if (angle < 112.5) return "ns-resize";
  return "nesw-resize";
}

/**
 * Drags one of the eight handles of a frame by `delta` (user space). The opposite corner or edge stays where
 * it is on the page, also for a rotated frame; the box never gets smaller than the minimum and never flips.
 * With `lockRatio` the proportions are kept: a corner follows the pointer on the axis that moved further, an
 * edge handle scales the other direction around the middle of the opposite edge.
 * @returns {{ x, y, w, h, rot }} the new frame
 */
export function resizeFrameByHandle(frame, handle, delta, { userUnit = 1, lockRatio = false, minWidth = MIN_OBJECT_SIZE, minHeight = MIN_OBJECT_SIZE } = {}) {
  const signs = HANDLE_SIGNS[handle];
  if (!signs) return frame;
  const [sx, sy] = signs;
  const { k, ex, eyDown } = frameAxes(frame, userUnit);
  // the drag along the box's own right / down axes, in points
  const alongX = (delta[0] * ex[0] + delta[1] * ex[1]) / (k * k);
  const alongY = (delta[0] * eyDown[0] + delta[1] * eyDown[1]) / (k * k);
  let w = frame.w + sx * alongX;
  let h = frame.h + sy * alongY;
  if (lockRatio && frame.w > 0 && frame.h > 0) {
    let factor;
    if (sx !== 0 && sy !== 0) factor = Math.max(w / frame.w, h / frame.h);
    else factor = sx !== 0 ? w / frame.w : h / frame.h;
    factor = Math.max(factor, minWidth / frame.w, minHeight / frame.h);
    w = frame.w * factor;
    h = frame.h * factor;
  } else {
    w = sx !== 0 ? Math.max(minWidth, w) : frame.w;
    h = sy !== 0 ? Math.max(minHeight, h) : frame.h;
  }
  const anchor = [sx > 0 ? 0 : sx < 0 ? 1 : 0.5, sy > 0 ? 0 : sy < 0 ? 1 : 0.5];
  const next = resizeFrame(frame, w, h, anchor, userUnit);
  return { ...next, x: tidy(next.x), y: tidy(next.y) };
}

/**
 * The patch of a resize gesture on any object.
 * @param {object} object
 * @param {string} handle    a handle of handleIdsOf(object)
 * @param {[number, number]} delta   how far the handle was dragged, in user space
 * @param {object} page      the Page the object is on
 * @param {{ shift?: boolean, lockRatio?: boolean, snap?: boolean, minWidth?: number, minHeight?: number }} [options]
 *        shift: the modifier of the gesture: it inverts the ratio lock of the object type (pictures are locked by
 *        default, the rest is free) and snaps a line to multiples of 45 degrees. lockRatio / snap say it explicitly.
 * @returns {object | null}
 *   text boxes: { frame, autoWidth: false } (the width only: the store sets the height from the text);
 *   lines: { p1 } or { p2 }; marks: { rect }; other boxes: { frame }; null when the handle does not apply.
 */
export function resizeObject(object, handle, delta, page, options = {}) {
  const userUnit = page?.userUnit || 1;
  const kind = geometryKind(object);
  if (kind === "line") {
    if (handle !== "p1" && handle !== "p2") return null;
    const end = object[handle];
    return moveLineEnd(object, handle, [end[0] + delta[0], end[1] + delta[1]], { snap: options.snap ?? Boolean(options.shift), userUnit });
  }
  if (kind !== "frame" && kind !== "rect") return null;
  const signs = HANDLE_SIGNS[handle];
  if (!signs) return null;
  if (object.type === "text") {
    if (signs[0] === 0) return null;
    const minWidth = Math.max(MIN_OBJECT_SIZE, options.minWidth || 0, object.size || 0);
    const frame = resizeFrameByHandle(object.frame, signs[0] > 0 ? "e" : "w", delta, { userUnit, minWidth });
    return { frame, autoWidth: false };
  }
  const lockRatio = options.lockRatio ?? (defaultRatioLock(object) !== Boolean(options.shift));
  const limits = { userUnit, lockRatio, minWidth: options.minWidth ?? MIN_OBJECT_SIZE, minHeight: options.minHeight ?? MIN_OBJECT_SIZE };
  if (kind === "frame") return { frame: resizeFrameByHandle(object.frame, handle, delta, limits) };
  const resized = resizeFrameByHandle(resizeBox(object, page), handle, delta, limits);
  return { rect: frameBounds(resized, userUnit).map(tidy) };
}

/**
 * Sets the size of an object from typed numbers (points): { width?, height? }. The top-left corner of the box
 * (as the box sees itself) stays in place. Text boxes take a width only and stop growing with their text.
 */
export function setObjectSize(object, page, size, { lockRatio = false } = {}) {
  const kind = geometryKind(object);
  if (kind !== "frame" && kind !== "rect") return null;
  const userUnit = page?.userUnit || 1;
  const frame = resizeBox(object, page);
  let w = finite(size.width) ? Math.max(MIN_OBJECT_SIZE, size.width) : frame.w;
  let h = finite(size.height) ? Math.max(MIN_OBJECT_SIZE, size.height) : frame.h;
  if (object.type === "text") {
    if (!finite(size.width)) return null;
    return { frame: resizeFrame(frame, Math.max(w, object.size || 0), frame.h, [0, 0], userUnit), autoWidth: false };
  }
  if (lockRatio && frame.w > 0 && frame.h > 0) {
    if (finite(size.width) && !finite(size.height)) h = (frame.h * w) / frame.w;
    else if (finite(size.height) && !finite(size.width)) w = (frame.w * h) / frame.h;
  }
  const resized = resizeFrame(frame, w, h, [0, 0], userUnit);
  return kind === "frame" ? { frame: resized } : { rect: frameBounds(resized, userUnit).map(tidy) };
}

/**
 * Sets the position of an object from typed numbers: { left?, top? } = where the bounding box of the object
 * starts on screen, in points from the top-left corner of the visible page (what the properties panel shows).
 */
export function setObjectScreenPosition(object, page, position) {
  if (!isMovable(object)) return null;
  const box = objectScreenBox(object, page);
  const dx = finite(position.left) ? position.left - box[0] : 0;
  const dy = finite(position.top) ? position.top - box[1] : 0;
  const [ux, uy] = screenDeltaToUser(page, [dx, dy]);
  return translatePatch(object, ux, uy);
}

// --- rotate ---

/** The nearest multiple of `step` degrees, in [0, 360). */
export const snapAngle = (degrees, step = ROTATION_SNAP_DEGREES) => normalizeAngle(Math.round(degrees / step) * step);

/** Counter-clockwise angle in user space, in degrees, that turns the direction centre -> from into centre -> to. */
export function angleBetween(centre, from, to) {
  const a = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
  const b = Math.atan2(to[1] - centre[1], to[0] - centre[0]);
  return (b - a) / DEG;
}

/**
 * The rotation handle was dragged from `from` to `to` (user space): the box turns about its centre by the angle
 * between them. `snap` (Shift) rounds the result to multiples of 15 degrees, which is the same on screen
 * because pages turn by 90 degrees only. null for objects that do not rotate.
 */
export function rotateObject(object, from, to, { snap = false } = {}) {
  if (!canRotate(object)) return null;
  const { frame } = object;
  const rot = frame.rot + angleBetween([frame.x, frame.y], from, to);
  return { frame: { ...frame, rot: snap ? snapAngle(rot) : normalizeAngle(rot) } };
}

/** Clockwise rotation of an object as the reader sees it, in degrees [0, 360); 0 for what has no rotation. */
export function screenRotationOf(object, page) {
  return geometryKind(object) === "frame" ? pageScreen(page).screenRotation(object.frame) : 0;
}

/** Sets the rotation the reader sees (clockwise degrees, typed in the properties panel). */
export function setScreenRotation(object, page, degrees) {
  if (!canRotate(object) || !finite(degrees)) return null;
  return { frame: { ...object.frame, rot: normalizeAngle(pageScreen(page).uprightRot - degrees) } };
}

// --- lines ---

/**
 * Puts one end of a line ("p1" or "p2") at `point` (user space). `snap` (Shift) keeps the line at a multiple of
 * 45 degrees around its other end; the line never gets shorter than `minLength` points.
 * @returns {{ p1: number[] } | { p2: number[] } | null}
 */
export function moveLineEnd(line, end, point, { snap = false, userUnit = 1, minLength = MIN_OBJECT_SIZE } = {}) {
  if (end !== "p1" && end !== "p2") return null;
  const fixed = end === "p1" ? line.p2 : line.p1;
  const previous = line[end];
  let vx = point[0] - fixed[0];
  let vy = point[1] - fixed[1];
  if (snap && (vx !== 0 || vy !== 0)) {
    const step = LINE_SNAP_DEGREES * DEG;
    const angle = Math.round(Math.atan2(vy, vx) / step) * step;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const along = vx * ux + vy * uy;
    vx = along * ux;
    vy = along * uy;
  }
  const minimum = minLength / userUnit;
  const length = Math.hypot(vx, vy);
  if (length < minimum) {
    // too short to keep a direction: fall back to the one the line had
    let dx = length > 1e-9 ? vx / length : previous[0] - fixed[0];
    let dy = length > 1e-9 ? vy / length : previous[1] - fixed[1];
    const norm = Math.hypot(dx, dy);
    if (norm < 1e-9) {
      dx = 1;
      dy = 0;
    } else {
      dx /= norm;
      dy /= norm;
    }
    vx = dx * minimum;
    vy = dy * minimum;
  }
  // rounding noise of the trigonometry would otherwise show up as 1e-15 offsets on axis-parallel lines
  const snapNoise = (value) => (Math.abs(value) < 1e-9 ? 0 : value);
  return { [end]: [tidy(fixed[0] + snapNoise(vx)), tidy(fixed[1] + snapNoise(vy))] };
}

// --- factories ---

const screenPoint = (screen, point) => screen.toScreen(point);

/** A box of w x h screen points centred on a point, moved onto the page where it fits. */
function centredBox(screen, centre, width, height) {
  const w = Math.min(width, screen.width);
  const h = Math.min(height, screen.height);
  const left = clampNumber(centre[0] - w / 2, 0, Math.max(0, screen.width - w));
  const top = clampNumber(centre[1] - h / 2, 0, Math.max(0, screen.height - h));
  return { left, top, width: w, height: h };
}

/**
 * The box of a drag between two screen points. It starts at `from` and extends towards `to`:
 * `square` makes both edges as long as the longer one, `ratio` (width / height) keeps proportions, and the
 * box is never smaller than the minimum.
 */
function dragBox(from, to, { square = false, ratio = 0, minWidth = MIN_OBJECT_SIZE, minHeight = MIN_OBJECT_SIZE } = {}) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  let width = Math.abs(dx);
  let height = Math.abs(dy);
  if (ratio > 0) {
    if (width / ratio >= height) height = width / ratio;
    else width = height * ratio;
    const grow = Math.max(1, width > 0 ? minWidth / width : Infinity, height > 0 ? minHeight / height : Infinity);
    if (Number.isFinite(grow)) {
      width *= grow;
      height *= grow;
    } else {
      width = Math.max(minWidth, minHeight * ratio);
      height = width / ratio;
    }
  } else {
    if (square) width = height = Math.max(width, height);
    width = Math.max(width, minWidth);
    height = Math.max(height, minHeight);
  }
  return { left: dx >= 0 ? from[0] : from[0] - width, top: dy >= 0 ? from[1] : from[1] - height, width, height };
}

const isPoint = (value) => Array.isArray(value) && value.length === 2 && value.every(finite);
const isDrag = (input) => Boolean(input) && isPoint(input.from) && isPoint(input.to);
const clickPoint = (input) => [input?.at, input?.from, input?.to].find(isPoint);
// Every factory answers null when it is given no usable place (an effect without a position): never a throw.
const hasPlace = (input) => isDrag(input) || Boolean(clickPoint(input));

/**
 * A rectangle or an ellipse. `input` is { at: [x, y] } for a click (default size centred on the point) or
 * { from, to, constrain? } for a drag (constrain = Shift: a square / a circle). Points are in user space.
 */
export function createShape(type, page, input, toolDefaults) {
  if ((type !== "rect" && type !== "ellipse") || !hasPlace(input)) return null;
  const screen = pageScreen(page);
  const box = isDrag(input)
    ? dragBox(screenPoint(screen, input.from), screenPoint(screen, input.to), { square: Boolean(input.constrain) })
    : centredBox(screen, screenPoint(screen, clickPoint(input)), DEFAULT_SIZES[type][0], DEFAULT_SIZES[type][1]);
  return { type, pageId: page.id, frame: screen.frameFromBox(box), ...styleFor(type, toolDefaults) };
}

/**
 * A line (or an arrow: a line with headEnd). A click gives a horizontal line of the default length centred on
 * the point, pointing right as seen on screen; a drag runs from `from` to `to` (constrain = Shift: 45 degree steps).
 */
export function createLine(page, input, toolDefaults, { arrow = false } = {}) {
  if (!hasPlace(input)) return null;
  const screen = pageScreen(page);
  const style = styleFor(arrow ? "arrow" : "line", toolDefaults);
  if (isDrag(input)) {
    const end = moveLineEnd({ p1: input.from, p2: input.to }, "p2", input.to, { snap: Boolean(input.constrain), userUnit: screen.userUnit });
    return { type: "line", pageId: page.id, p1: [tidy(input.from[0]), tidy(input.from[1])], p2: end.p2, ...style };
  }
  const length = Math.min(DEFAULT_LINE_LENGTH, screen.width);
  const centre = screenPoint(screen, clickPoint(input));
  const left = clampNumber(centre[0] - length / 2, 0, Math.max(0, screen.width - length));
  const y = clampNumber(centre[1], 0, screen.height);
  return { type: "line", pageId: page.id, p1: screen.toUser([left, y]), p2: screen.toUser([left + length, y]), ...style };
}

/**
 * A redaction or a blur area: { at } (default size), { from, to } (the dragged area) or { rect } (a user-space
 * rectangle that is already known: a line of text). Marks never rotate: they are rectangles in user space.
 */
export function createMark(type, page, input, toolDefaults) {
  if (type !== "redact" && type !== "blur") return null;
  const known = Array.isArray(input?.rect) && input.rect.length === 4 && input.rect.every(finite);
  if (!known && !hasPlace(input)) return null;
  const screen = pageScreen(page);
  let rect;
  if (known) {
    rect = normalizeRect(input.rect);
  } else {
    const box = isDrag(input)
      ? dragBox(screenPoint(screen, input.from), screenPoint(screen, input.to))
      : centredBox(screen, screenPoint(screen, clickPoint(input)), DEFAULT_SIZES[type][0], DEFAULT_SIZES[type][1]);
    rect = screen.rectToUser([box.left, box.top, box.left + box.width, box.top + box.height]);
  }
  return { type, pageId: page.id, rect, ...styleFor(type, toolDefaults) };
}

/**
 * A text box. A click ({ at }) makes a box that grows with its text (autoWidth) and starts at the point: its
 * first line is centred on the point vertically, and the point is the left edge, the middle or the right edge
 * according to the alignment. A drag ({ from, to }) makes a box that wraps at the dragged width.
 * The store sets the real size from the text measurer.
 */
export function createTextBox(page, input, toolDefaults, content = "") {
  if (!hasPlace(input)) return null;
  const screen = pageScreen(page);
  const style = styleFor("text", toolDefaults);
  const lineHeight = style.size * style.lineHeight;
  let box;
  let autoWidth;
  if (isDrag(input)) {
    const from = screenPoint(screen, input.from);
    const to = screenPoint(screen, input.to);
    const width = Math.max(Math.abs(to[0] - from[0]), MIN_OBJECT_SIZE, style.size * 2);
    box = { left: Math.min(from[0], to[0]), top: Math.min(from[1], to[1]), width, height: lineHeight };
    autoWidth = false;
  } else {
    const at = screenPoint(screen, clickPoint(input));
    const width = MIN_OBJECT_SIZE;
    const left = style.align === "center" ? at[0] - width / 2 : style.align === "right" ? at[0] - width : at[0];
    box = { left, top: at[1] - lineHeight / 2, width, height: lineHeight };
    autoWidth = true;
  }
  return { type: "text", pageId: page.id, frame: screen.frameFromBox(box), text: String(content ?? ""), ...style, autoWidth };
}

/**
 * The text box that replaces a line of the document ("Edit text").
 * @param {object} page
 * @param {{ rect: number[], text: string, angle?: number, cover?: string | null }} line
 *        rect: the box of the original line in user space; angle: direction of its baseline in user space,
 *        counter-clockwise degrees (a multiple of 90; default: upright on screen); cover: the background colour
 *        sampled under the line, or null
 * @param {object} [toolDefaults]  font, size, colour ... detected for the line
 * The box starts at the line's own top-left corner and has the line's size; whoever knows the font metrics may
 * refine the frame so that the new baseline sits exactly on the old one.
 */
export function createReplacementText(page, line, toolDefaults) {
  const screen = pageScreen(page);
  const style = styleFor("text", toolDefaults);
  const rect = normalizeRect(line.rect);
  const rot = finite(line.angle) ? normalizeAngle(Math.round(line.angle / 90) * 90) : screen.uprightRot;
  const turned = rot === 90 || rot === 270;
  const across = (rect[2] - rect[0]) * screen.userUnit;
  const along = (rect[3] - rect[1]) * screen.userUnit;
  const frame = { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2, w: turned ? along : across, h: turned ? across : along, rot };
  const cover = line.cover === null || line.cover === undefined ? null : normalizeColor(line.cover);
  return {
    type: "text",
    pageId: page.id,
    frame,
    text: String(line.text ?? ""),
    ...style,
    align: "left",
    autoWidth: true,
    replaces: { rect, cover, sourceText: String(line.text ?? "") }
  };
}

/**
 * A pen stroke ("pen") or a freehand highlight ("highlighter") from the pointer positions in user space.
 * The samples are thinned out to one per point of length (`spacing`), the frame is the box around them as
 * seen on screen (never smaller than the minimum, so that a tap is a dot in a small box) and the points are
 * stored as fractions of it. Renderers draw a smooth curve through them (engine/export/shapes.js smoothPath).
 * null without points.
 */
export function createStroke(kind, page, points, toolDefaults, { spacing = STROKE_SPACING } = {}) {
  if (kind !== "pen" && kind !== "highlighter") return null;
  if (!Array.isArray(points) || !points.length) return null;
  const screen = pageScreen(page);
  const path = thinPolyline(points.map((point) => screenPoint(screen, point)), spacing);
  let left = Math.min(...path.map((point) => point[0]));
  let right = Math.max(...path.map((point) => point[0]));
  let top = Math.min(...path.map((point) => point[1]));
  let bottom = Math.max(...path.map((point) => point[1]));
  if (right - left < MIN_OBJECT_SIZE) {
    const middle = (left + right) / 2;
    left = middle - MIN_OBJECT_SIZE / 2;
    right = middle + MIN_OBJECT_SIZE / 2;
  }
  if (bottom - top < MIN_OBJECT_SIZE) {
    const middle = (top + bottom) / 2;
    top = middle - MIN_OBJECT_SIZE / 2;
    bottom = middle + MIN_OBJECT_SIZE / 2;
  }
  const width = right - left;
  const height = bottom - top;
  const fraction = (value) => Math.round(clampNumber(value, 0, 1) * 1e5) / 1e5;
  const fractions = path.map(([x, y]) => [fraction((x - left) / width), fraction((y - top) / height)]);
  const frame = screen.frameFromBox({ left, top, width, height });
  if (kind === "pen") return { type: "pen", pageId: page.id, frame, points: fractions, ...styleFor("pen", toolDefaults) };
  return { type: "highlight", mode: "stroke", pageId: page.id, frame, points: fractions, ...styleFor("highlighter", toolDefaults) };
}

/** A user-space rectangle -> the quad of a text highlight (corners top-left, top-right, bottom-right, bottom-left as read on screen). */
export function quadFromRect(page, rect) {
  const screen = pageScreen(page);
  const [left, top, right, bottom] = screen.rectToScreen(rect);
  return [[left, top], [right, top], [right, bottom], [left, bottom]].flatMap((corner) => screen.toUser(corner));
}

/**
 * A highlight of document text: one quad (8 numbers) or one rectangle (4 numbers, user space) per line box.
 * null without boxes.
 */
export function createTextHighlight(page, boxes, toolDefaults) {
  if (!Array.isArray(boxes) || !boxes.length) return null;
  const quads = boxes.map((box) => (box.length === 4 ? quadFromRect(page, box) : box.slice(0, 8)));
  const { color } = styleFor("highlighter", toolDefaults);
  return { type: "highlight", mode: "text", pageId: page.id, quads, color };
}

/**
 * An image or a signature picture.
 * @param {object} page
 * @param {{ id: string, width: number, height: number }} asset   the Asset of the store (pixels)
 * @param {object} input   { at } : natural size at 96 dpi, at most half the page width (a signature: 160 pt wide),
 *                         centred on the point; { from, to, keepRatio? } : the dragged size (the ratio is kept
 *                         unless keepRatio is false)
 * @param {{ role?: "image" | "signature", style?: object }} [options]
 */
export function createImage(page, asset, input, { role = "image", style } = {}) {
  if (!asset || !(asset.width > 0) || !(asset.height > 0) || !hasPlace(input)) return null;
  const screen = pageScreen(page);
  const ratio = asset.width / asset.height;
  let box;
  if (isDrag(input)) {
    box = dragBox(screenPoint(screen, input.from), screenPoint(screen, input.to), input.keepRatio === false ? {} : { ratio });
  } else {
    let width = role === "signature" ? SIGNATURE_DEFAULT_WIDTH : asset.width * IMAGE_POINTS_PER_PIXEL;
    let height = width / ratio;
    const maxWidth = role === "signature" ? screen.width * 0.9 : screen.width * IMAGE_MAX_PAGE_SHARE;
    const shrink = Math.min(1, maxWidth / width, screen.height / height);
    const grow = Math.max(1, MIN_OBJECT_SIZE / (width * shrink), MIN_OBJECT_SIZE / (height * shrink));
    width *= shrink * grow;
    height *= shrink * grow;
    box = centredBox(screen, screenPoint(screen, clickPoint(input)), width, height);
  }
  return { type: "image", pageId: page.id, frame: screen.frameFromBox(box), assetId: asset.id, ...styleFor(role === "signature" ? "signature" : "image", style) };
}

/**
 * The rectangle of a visible certificate signature: { pageId, rect } in user space (not an object of the
 * document: the signing flow keeps it). A click gives the default size, a drag that area; never smaller than
 * SIGNATURE_FIELD_MIN_SIZE. moveObject / resizeObject work on it as on a mark.
 */
export function createSignatureField(page, input) {
  if (!hasPlace(input)) return null;
  const screen = pageScreen(page);
  const [minWidth, minHeight] = SIGNATURE_FIELD_MIN_SIZE;
  const box = isDrag(input)
    ? dragBox(screenPoint(screen, input.from), screenPoint(screen, input.to), { minWidth, minHeight })
    : centredBox(screen, screenPoint(screen, clickPoint(input)), DEFAULT_SIZES.signatureField[0], DEFAULT_SIZES.signatureField[1]);
  return { pageId: page.id, rect: screen.rectToUser([box.left, box.top, box.left + box.width, box.top + box.height]) };
}

// --- from the effects of tools/interaction.js (CSS pixels of a page element) to patches and objects ---

const pixelPoint = (page, point, scale) => pagePointFromPixels(page, point, scale);

/**
 * What a "create" effect of the interaction reducer makes.
 * @param {object} effect   { type: "create", tool, at | from + to | points, constrain?, keepRatio?, ... }: positions in
 *                          CSS pixels inside the element of `page`
 * @param {object} page     the Page with id effect.pageId
 * @param {number} scale    zoom of that page element: CSS pixels per point
 * @param {{ style?: object, asset?: object, rect?: number[], boxes?: number[][], content?: string }} [context]
 *        style: the tool's remembered defaults; asset: for image / signature (the Asset record); rect: the
 *        user-space box of a text line (Redact clicked on a line); boxes: line boxes of a text selection
 *        (highlighter / redact over document text)
 * @returns an object without id, an ARRAY of objects (one redaction per text line), { pageId, rect } for the
 *          certificate position tool, or null
 */
export function createFromEffect(effect, page, scale = 1, context = {}) {
  const input = {};
  if (effect.at) input.at = pixelPoint(page, effect.at, scale);
  if (effect.from && effect.to) {
    input.from = pixelPoint(page, effect.from, scale);
    input.to = pixelPoint(page, effect.to, scale);
  }
  if (effect.constrain) input.constrain = true;
  if (effect.keepRatio === false) input.keepRatio = false;
  const { style } = context;
  switch (effect.tool) {
    case "text":
      return createTextBox(page, input, style, context.content);
    case "rect":
    case "ellipse":
      return createShape(effect.tool, page, input, style);
    case "line":
      return createLine(page, input, style);
    case "arrow":
      return createLine(page, input, style, { arrow: true });
    case "redact":
      if (context.boxes?.length) return context.boxes.map((box) => createMark("redact", page, { rect: boundsOfBox(box) }, style));
      return createMark("redact", page, context.rect ? { rect: context.rect } : input, style);
    case "blur":
      return createMark("blur", page, input, style);
    case "pen":
    case "highlighter":
      if (effect.tool === "highlighter" && context.boxes?.length) return createTextHighlight(page, context.boxes, style);
      return createStroke(effect.tool, page, (effect.points || []).map((point) => pixelPoint(page, point, scale)), style);
    case "image":
    case "signature":
      return createImage(page, context.asset, input, { role: effect.tool === "signature" ? "signature" : "image", style });
    case "certSign":
      return createSignatureField(page, input);
    default:
      return null;
  }
}

function boundsOfBox(box) {
  if (box.length === 4) return normalizeRect(box);
  const xs = [box[0], box[2], box[4], box[6]];
  const ys = [box[1], box[3], box[5], box[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The updates of a "move" effect ({ ids, dx, dy, axisLock } in CSS pixels) for objects that stay on their page. */
export function patchesForMoveEffect(state, effect, scale = 1) {
  return moveObjectsOnScreen(state, effect.ids, screenDeltaFromPixels(effect, scale), { axisLock: Boolean(effect.axisLock) });
}

/**
 * Where a "move" effect that ended over ANOTHER page puts its objects: the `place` argument of
 * store.moveObjectsToPage(ids, effect.drop.pageId, place). The objects keep their distance to the pointer.
 * @param {object} effect       { from: { x, y } (press, pixels of the page it started on), drop: { pageId, x, y } (release, pixels of the page under the pointer) }
 * @param {number} scale        zoom of the page the gesture started on
 * @param {number} [dropScale]  zoom of the page under the pointer (default: the same)
 */
export function placeForDrop(effect, scale = 1, dropScale = scale) {
  if (!effect.drop || !effect.from) return null;
  return { offset: [effect.drop.x / dropScale - effect.from.x / scale, effect.drop.y / dropScale - effect.from.y / scale], fit: false };
}

/** The update of a "resize" effect ({ id, handle, dx, dy, invertRatioLock } in CSS pixels): { id, patch } or null. */
export function patchForResizeEffect(state, effect, scale = 1, options = {}) {
  const object = state.objects[effect.id];
  const page = object && state.pages.find((candidate) => candidate.id === object.pageId);
  if (!page) return null;
  const delta = screenDeltaToUser(page, screenDeltaFromPixels(effect, scale));
  const patch = resizeObject(object, effect.handle, delta, page, { ...options, shift: Boolean(effect.invertRatioLock) });
  return patch ? { id: object.id, patch } : null;
}

/** The update of a "rotate" effect ({ id, from, to, snap } in CSS pixels): { id, patch } or null. */
export function patchForRotateEffect(state, effect, scale = 1) {
  const object = state.objects[effect.id];
  const page = object && state.pages.find((candidate) => candidate.id === object.pageId);
  if (!page) return null;
  const patch = rotateObject(object, pixelPoint(page, effect.from, scale), pixelPoint(page, effect.to, scale), { snap: Boolean(effect.snap) });
  return patch ? { id: object.id, patch } : null;
}

/** The user-space rectangle of a "marqueeSelect" effect ({ rect: { x, y, width, height } in CSS pixels }). */
export function rectFromPixels(page, rect, scale = 1) {
  const a = pixelPoint(page, [rect.x, rect.y], scale);
  const b = pixelPoint(page, [rect.x + rect.width, rect.y + rect.height], scale);
  return normalizeRect([a[0], a[1], b[0], b[1]]);
}

// --- placing objects on another page (move to a page, paste) ---

const sameGeometry = (a, b) =>
  a.baseRotation === b.baseRotation && (a.rotation || 0) === (b.rotation || 0) && (a.userUnit || 1) === (b.userUnit || 1) && a.view.every((value, index) => value === b.view[index]);

/**
 * Puts objects on `toPage` so that they look as they did where they came from.
 * @param {Array<{ object: object, fromPage: object }>} items   fromPage = the Page (or a copy of its geometry)
 *        that the object's coordinates belong to
 * @param {object} toPage
 * @param {"keep" | "center" | { offset?: [number, number], at?: [number, number], center?: boolean, fit?: boolean }} [place]
 *        "keep" (default)  the same place as seen on screen (distance from the top-left corner of the visible page)
 *        offset            that place moved by [dx, dy] screen points (right, down)
 *        at                the middle of the group at this user-space point of toPage
 *        "center"          the middle of the group in the middle of the page
 *        fit (default true) the group is moved onto the page when it would stick out and fits; a group larger
 *                          than the page is centred
 * @returns {object[]} the objects with their new geometry and pageId = toPage.id (ids unchanged)
 */
export function placeOnPage(items, toPage, place = "keep") {
  const options = typeof place === "string" ? { center: place === "center" } : place || {};
  const screen = pageScreen(toPage);
  const offset = options.offset && !options.at && !options.center ? options.offset : [0, 0];
  let placed = items.map(({ object, fromPage }) => {
    const identity = sameGeometry(fromPage, toPage) && !offset[0] && !offset[1];
    const patch = identity ? null : mapToPagePatch(object, fromPage, toPage, offset);
    return { ...object, ...patch, pageId: toPage.id };
  });
  if (!placed.length) return placed;
  let box = groupScreenBox(placed, toPage);
  let dx = 0;
  let dy = 0;
  if (options.at || options.center) {
    const target = options.at ? screen.toScreen(options.at) : [screen.width / 2, screen.height / 2];
    dx = target[0] - (box[0] + box[2]) / 2;
    dy = target[1] - (box[1] + box[3]) / 2;
    box = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
  }
  if (options.fit !== false) {
    const fitAxis = (low, high, size) => {
      if (high - low >= size) return size / 2 - (low + high) / 2;
      if (low < 0) return -low;
      if (high > size) return size - high;
      return 0;
    };
    dx += fitAxis(box[0], box[2], screen.width);
    dy += fitAxis(box[1], box[3], screen.height);
  }
  if (dx || dy) {
    const [ux, uy] = screen.deltaToUser([dx, dy]);
    placed = placed.map((object) => ({ ...object, ...translatePatch(object, ux, uy) }));
  }
  return placed;
}
