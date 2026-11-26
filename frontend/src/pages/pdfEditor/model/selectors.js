// Read-only questions about a DocumentState (model/schema.js): lookups, paint order, pending marks, hit
// testing, bounding boxes, alignment and the rule that keeps objects on their page. Pure functions over the
// immutable state of the store: no DOM, no user text.
//
// Coordinates: user space of the page unless a name says "screen" (points as the reader sees the page, origin
// at the top-left corner of the visible page, y down: see shapes.js). Tolerances are in points.
import { normalizeRect, rectsIntersect, unionRects, userToLocal } from "../engine/geometry.js";
import { MIN_OBJECT_SIZE, isMark, objectBounds, validateObject } from "./schema.js";
import {
  distanceToPolygon,
  distanceToPolyline,
  distanceToSegment,
  framePolygon,
  geometryKind,
  objectScreenBox,
  pageScreen,
  polygonIntersectsRect,
  quadToPolygon,
  strokePointsInUser,
  translatePatch
} from "./shapes.js";

/** At least this many points of an object stay on its page (UX rule; smaller objects stay on it entirely). */
export const MIN_VISIBLE_ON_PAGE = MIN_OBJECT_SIZE;

export const ALIGNMENTS = Object.freeze(["left", "center", "right", "top", "middle", "bottom"]);

const RIGHT_ANGLES = [0, 90, 180, 270];
const finite = (value) => typeof value === "number" && Number.isFinite(value);

// --- lookups ---

export const pageIndexOf = (state, pageId) => state.pages.findIndex((page) => page.id === pageId);
export const pageById = (state, pageId) => state.pages.find((page) => page.id === pageId) || null;
export const objectById = (state, objectId) => state.objects[objectId] || null;

/** The page an object is on (null for an unknown id). */
export function pageOfObject(state, objectId) {
  const object = state.objects[objectId];
  return object ? pageById(state, object.pageId) : null;
}

// A page object in the hands of a caller can be older than the state (its objectIds are then stale): the
// page of the state with the same id is the one that counts.
const resolvePage = (state, pageOrId) => {
  if (typeof pageOrId === "string") return pageById(state, pageOrId);
  if (!pageOrId || typeof pageOrId !== "object") return null;
  return pageById(state, pageOrId.id) || pageOrId;
};

/**
 * The objects of a page in paint order (bottom -> top), marks apart: marks act on the original page content
 * and are always painted below everything the user added.
 * @returns {{ marks: object[], objects: object[] }}
 */
export function objectsOfPage(state, pageOrId) {
  const page = resolvePage(state, pageOrId);
  const marks = [];
  const objects = [];
  if (page) {
    for (const id of page.objectIds) {
      const object = state.objects[id];
      if (!object) continue;
      (isMark(object) ? marks : objects).push(object);
    }
  }
  return { marks, objects };
}

/**
 * objectsOfPage with stable results for rendering: as long as the same objects are on a page in the same
 * order, the SAME arrays come back (a change on another page does not re-render this one). One selector per
 * consumer (it holds the last result of every page it was asked for).
 */
export function createObjectsOfPageSelector() {
  const cache = new Map();
  const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
  return function select(state, pageId) {
    const next = objectsOfPage(state, pageId);
    const previous = cache.get(pageId);
    if (previous && same(previous.marks, next.marks) && same(previous.objects, next.objects)) return previous;
    cache.set(pageId, next);
    return next;
  };
}

/** Ids of the objects of a page from bottom to top, marks first. */
export function paintOrder(state, pageOrId) {
  const { marks, objects } = objectsOfPage(state, pageOrId);
  return [...marks, ...objects].map((object) => object.id);
}

/**
 * The redaction and blur marks that will be applied at export, in page order.
 * @returns {Array<{ id, type, pageId, pageIndex, pageNumber, rect, object }>}  pageNumber = pageIndex + 1
 */
export function pendingMarks(state) {
  const out = [];
  state.pages.forEach((page, pageIndex) => {
    for (const id of page.objectIds) {
      const object = state.objects[id];
      if (!object || !isMark(object)) continue;
      out.push({ id, type: object.type, pageId: page.id, pageIndex, pageNumber: pageIndex + 1, rect: normalizeRect(object.rect), object });
    }
  });
  return out;
}

/** { redact, blur, total, pages } where `pages` counts the pages that carry at least one mark. */
export function countPendingMarks(state) {
  const counts = { redact: 0, blur: 0, total: 0, pages: 0 };
  const pages = new Set();
  for (const mark of pendingMarks(state)) {
    counts[mark.type] += 1;
    counts.total += 1;
    pages.add(mark.pageId);
  }
  counts.pages = pages.size;
  return counts;
}

/** Text boxes that replace a line of the document ("Edit text"), in page order: same row shape as pendingMarks. */
export function replacedTexts(state) {
  const out = [];
  state.pages.forEach((page, pageIndex) => {
    for (const id of page.objectIds) {
      const object = state.objects[id];
      if (object?.type !== "text" || !object.replaces) continue;
      out.push({ id, type: "text", pageId: page.id, pageIndex, pageNumber: pageIndex + 1, rect: normalizeRect(object.replaces.rect), object });
    }
  });
  return out;
}

/** The sources that at least one page of the document comes from, in the order of their first page. */
export function sourcesInUse(state) {
  const seen = new Set();
  const out = [];
  for (const page of state.pages) {
    if (page.kind !== "pdf" || seen.has(page.sourceId)) continue;
    seen.add(page.sourceId);
    if (state.sources[page.sourceId]) out.push(state.sources[page.sourceId]);
  }
  return out;
}

/**
 * The id of the source when the document is exactly that file, untouched: every page of ONE source, all of
 * them, in the original order, no rotation added, no object and no mark. null otherwise.
 * Only then may a certificate signature be appended to the ORIGINAL bytes (existing signatures stay valid).
 */
export function pristineSourceId(state) {
  const first = state.pages[0];
  if (!first || first.kind !== "pdf") return null;
  const source = state.sources[first.sourceId];
  if (!source || state.pages.length !== source.pageCount) return null;
  for (const id in state.objects) if (Object.prototype.hasOwnProperty.call(state.objects, id)) return null;
  for (let index = 0; index < state.pages.length; index += 1) {
    const page = state.pages[index];
    if (page.kind !== "pdf" || page.sourceId !== first.sourceId || page.sourceIndex !== index || page.rotation !== 0 || page.objectIds.length) return null;
  }
  return first.sourceId;
}

/**
 * Where movePages() must put pages that were dropped in the gap `gapIndex` of the CURRENT page list
 * (0 = before the first page, pages.length = after the last one).
 */
export function moveIndexForDrop(pages, pageIds, gapIndex) {
  const moving = new Set(pageIds);
  const gap = Math.max(0, Math.min(pages.length, Math.trunc(gapIndex) || 0));
  let before = 0;
  for (let index = 0; index < gap; index += 1) if (!moving.has(pages[index].id)) before += 1;
  return before;
}

// --- structure check ---

/** Problems of one Page record (empty = valid). `sources` is optional: with it, the source page must exist. */
export function validatePage(page, sources) {
  const problems = [];
  if (!page || typeof page !== "object") return ["not a page"];
  if (typeof page.id !== "string" || !page.id) problems.push("id");
  const view = page.view;
  if (!Array.isArray(view) || view.length !== 4 || !view.every(finite) || !(view[2] > view[0]) || !(view[3] > view[1])) problems.push("view");
  if (!RIGHT_ANGLES.includes(page.baseRotation)) problems.push("baseRotation");
  if (!RIGHT_ANGLES.includes(page.rotation)) problems.push("rotation");
  if (!finite(page.userUnit) || !(page.userUnit > 0)) problems.push("userUnit");
  if (!Array.isArray(page.objectIds) || !page.objectIds.every((id) => typeof id === "string" && id)) problems.push("objectIds");
  if (page.kind === "pdf") {
    if (typeof page.sourceId !== "string" || !page.sourceId) problems.push("sourceId");
    if (!Number.isInteger(page.sourceIndex) || page.sourceIndex < 0) problems.push("sourceIndex");
    if (sources && typeof page.sourceId === "string") {
      const source = sources[page.sourceId];
      if (!source) problems.push("unknown source");
      else if (Number.isInteger(page.sourceIndex) && page.sourceIndex >= source.pageCount) problems.push("sourceIndex out of range");
    }
  } else if (page.kind === "blank") {
    if (page.sourceId !== null || page.sourceIndex !== null) problems.push("blank page with a source");
    if (page.baseRotation !== 0 || page.userUnit !== 1) problems.push("blank page geometry");
  } else {
    problems.push("kind");
  }
  return problems;
}

/**
 * Every invariant of a DocumentState, as a list of problems in English for developers (empty = consistent).
 * The store keeps them true; tests and the export job check them.
 */
export function validateDocument(state) {
  const problems = [];
  if (!state || typeof state !== "object") return ["not a document"];
  if (typeof state.fileName !== "string") problems.push("fileName");
  const pageIds = new Set();
  const owner = new Map();
  for (const page of state.pages || []) {
    for (const problem of validatePage(page, state.sources)) problems.push(`page ${page?.id}: ${problem}`);
    if (!page || typeof page !== "object") continue;
    if (pageIds.has(page.id)) problems.push(`page ${page.id}: duplicate id`);
    pageIds.add(page.id);
    let afterMarks = false;
    for (const id of Array.isArray(page.objectIds) ? page.objectIds : []) {
      const object = state.objects[id];
      if (!object) {
        problems.push(`page ${page.id}: lists unknown object ${id}`);
        continue;
      }
      if (owner.has(id)) problems.push(`object ${id}: listed twice (pages ${owner.get(id)} and ${page.id})`);
      owner.set(id, page.id);
      if (object.pageId !== page.id) problems.push(`object ${id}: pageId ${object.pageId} but listed on page ${page.id}`);
      if (isMark(object)) {
        if (afterMarks) problems.push(`object ${id}: a mark above an object (marks stay below)`);
      } else {
        afterMarks = true;
      }
      if (!rectsIntersect(objectBounds(object, page.userUnit || 1), expand(page.view, 1e-6))) problems.push(`object ${id}: outside its page`);
    }
  }
  for (const [id, object] of Object.entries(state.objects || {})) {
    if (object?.id !== id) problems.push(`object ${id}: stored under another id`);
    for (const problem of validateObject(object)) problems.push(`object ${id}: ${problem}`);
    if (!owner.has(id)) problems.push(`object ${id}: on no page`);
    if (object?.type === "image" && !state.assets[object.assetId]) problems.push(`object ${id}: unknown asset ${object.assetId}`);
  }
  for (const [id, source] of Object.entries(state.sources || {})) {
    if (source?.id !== id) problems.push(`source ${id}: stored under another id`);
    if (!Number.isInteger(source?.pageCount) || source.pageCount < 1) problems.push(`source ${id}: pageCount`);
  }
  for (const [id, asset] of Object.entries(state.assets || {})) {
    if (asset?.id !== id) problems.push(`asset ${id}: stored under another id`);
  }
  return problems;
}

const expand = (rect, by) => [rect[0] - by, rect[1] - by, rect[2] + by, rect[3] + by];

// --- hit testing ---

function hitBox(local, frame, grow) {
  return local[0] >= -grow && local[1] >= -grow && local[0] <= frame.w + grow && local[1] <= frame.h + grow;
}

function hitEllipse(local, frame, grow) {
  const a = frame.w / 2 + grow;
  const b = frame.h / 2 + grow;
  if (!(a > 0) || !(b > 0)) return false;
  const dx = (local[0] - frame.w / 2) / a;
  const dy = (local[1] - frame.h / 2) / b;
  return dx * dx + dy * dy <= 1;
}

/**
 * Is `point` (user space) on the object? `tolerance` (points) widens every shape; the overlay passes a few
 * screen pixels divided by the zoom.
 *   text, image             the frame, with its rotation
 *   rect, ellipse           filled: the whole shape; without a fill: only a band along the outline, so that
 *                           what lies inside an empty rectangle stays reachable (`solid: true` = always whole)
 *   line                    distance to the segment <= half the stroke width
 *   pen, freehand highlight distance to the polyline <= half the stroke width / thickness
 *   text highlight          inside one of its quads
 *   redact, blur            inside the rectangle
 */
export function hitTestObject(object, point, { userUnit = 1, tolerance = 0, solid = false } = {}) {
  const k = 1 / userUnit; // points -> user-space units
  switch (geometryKind(object)) {
    case "frame": {
      const { frame } = object;
      const local = userToLocal(frame, point, userUnit);
      if (object.type === "pen" || (object.type === "highlight" && object.mode === "stroke")) {
        const half = (object.type === "pen" ? object.width : object.thickness) / 2;
        const points = object.points.map(([u, v]) => [u * frame.w, v * frame.h]);
        return distanceToPolyline(local, points) <= half + tolerance;
      }
      if (object.type === "rect" || object.type === "ellipse") {
        const inside = object.type === "rect" ? hitBox : hitEllipse;
        const strokeHalf = object.stroke ? (object.strokeWidth || 0) / 2 : 0;
        if (!inside(local, frame, strokeHalf + tolerance)) return false;
        // No fill and no stroke: an invisible shape must still be selectable, so that it can be deleted.
        if (solid || object.fill || !object.stroke) return true;
        return !inside(local, frame, -(strokeHalf + tolerance));
      }
      return hitBox(local, frame, tolerance);
    }
    case "rect": {
      const [x0, y0, x1, y1] = normalizeRect(object.rect);
      const grow = tolerance * k;
      return point[0] >= x0 - grow && point[0] <= x1 + grow && point[1] >= y0 - grow && point[1] <= y1 + grow;
    }
    case "line":
      return distanceToSegment(point, object.p1, object.p2) <= ((object.strokeWidth || 0) / 2 + tolerance) * k;
    case "quads":
      return object.quads.some((quad) => distanceToPolygon(point, quadToPolygon(quad)) <= tolerance * k);
    default:
      return false;
  }
}

/**
 * The objects of a page under a user-space point, topmost first; marks come last (they lie below everything).
 * @param {object} state
 * @param {string | object} pageOrId
 * @param {[number, number]} point      user space of that page
 * @param {number} [tolerance]          points
 * @param {{ solid?: boolean }} [options]
 * @returns {object[]}
 */
export function objectsAtPoint(state, pageOrId, point, tolerance = 0, options = {}) {
  const page = resolvePage(state, pageOrId);
  if (!page) return [];
  const { marks, objects } = objectsOfPage(state, page);
  const test = { userUnit: page.userUnit || 1, tolerance, solid: Boolean(options.solid) };
  const hit = (list) => list.filter((object) => hitTestObject(object, point, test)).reverse();
  return [...hit(objects), ...hit(marks)];
}

/** The topmost object under a point, or null. */
export function objectAtPoint(state, pageOrId, point, tolerance = 0, options = {}) {
  return objectsAtPoint(state, pageOrId, point, tolerance, options)[0] || null;
}

/** Does the object touch the user-space rectangle? (rotated frames, segments and quads are tested exactly) */
export function objectTouchesRect(object, rect, userUnit = 1) {
  const box = normalizeRect(rect);
  switch (geometryKind(object)) {
    case "frame":
      if (object.type === "pen" || (object.type === "highlight" && object.mode === "stroke")) {
        const points = strokePointsInUser(object, userUnit);
        if (points.length === 1) return polygonIntersectsRect(points, box);
        for (let index = 1; index < points.length; index += 1) {
          if (polygonIntersectsRect([points[index - 1], points[index]], box)) return true;
        }
        return false;
      }
      return polygonIntersectsRect(framePolygon(object.frame, userUnit), box);
    case "rect": {
      const [x0, y0, x1, y1] = normalizeRect(object.rect);
      return x0 <= box[2] && box[0] <= x1 && y0 <= box[3] && box[1] <= y1;
    }
    case "line":
      return polygonIntersectsRect([object.p1, object.p2], box);
    case "quads":
      return object.quads.some((quad) => polygonIntersectsRect(quadToPolygon(quad), box));
    default:
      return false;
  }
}

/** The objects of a page that a marquee (user-space rectangle) touches, bottom -> top, marks first. */
export function objectsInRect(state, pageOrId, rect) {
  const page = resolvePage(state, pageOrId);
  if (!page) return [];
  const { marks, objects } = objectsOfPage(state, page);
  return [...marks, ...objects].filter((object) => objectTouchesRect(object, rect, page.userUnit || 1));
}

// --- bounding boxes ---

/** Union of the user-space bounding boxes of objects of ONE page ([x0, y0, x1, y1]); null for none. */
export function boundsOfObjects(objects, userUnit = 1) {
  return unionRects(objects.map((object) => objectBounds(object, userUnit)));
}

/**
 * The box of a selection as the reader sees it, per page: screen points, see shapes.js.
 * @returns {Array<{ pageId, ids: string[], box: [left, top, right, bottom] }>}  in page order
 */
export function selectionScreenBoxes(state, ids) {
  const wanted = new Set(ids);
  const out = [];
  for (const page of state.pages) {
    const objects = page.objectIds.filter((id) => wanted.has(id)).map((id) => state.objects[id]).filter(Boolean);
    if (!objects.length) continue;
    out.push({ pageId: page.id, ids: objects.map((object) => object.id), box: unionRects(objects.map((object) => objectScreenBox(object, page))) });
  }
  return out;
}

// --- alignment ---

/** A text highlight marks text of the document: it has no position of its own. */
export const isMovable = (object) => Boolean(geometryKind(object)) && !(object.type === "highlight" && object.mode === "text");

/**
 * Aligns objects as the reader sees them: "left" | "center" | "right" move horizontally on screen,
 * "top" | "middle" | "bottom" vertically, whatever the rotation of the page is.
 * Several objects of a page line up with the box around them; a single one (or `relativeTo: "page"`) lines up
 * with the visible page. Objects of different pages are aligned page by page.
 * @returns {Array<{ id: string, patch: object }>}  for store.updateObjects(); objects already in place are left out
 */
export function alignObjects(state, ids, mode, { relativeTo = "selection" } = {}) {
  if (!ALIGNMENTS.includes(mode)) return [];
  const wanted = new Set(ids);
  const updates = [];
  for (const page of state.pages) {
    const objects = page.objectIds.filter((id) => wanted.has(id)).map((id) => state.objects[id]).filter((object) => object && isMovable(object));
    if (!objects.length) continue;
    const screen = pageScreen(page);
    const boxes = objects.map((object) => screen.rectToScreen(objectBounds(object, screen.userUnit)));
    const reference = relativeTo === "page" || objects.length < 2 ? [0, 0, screen.width, screen.height] : unionRects(boxes);
    objects.forEach((object, index) => {
      const box = boxes[index];
      let dx = 0;
      let dy = 0;
      if (mode === "left") dx = reference[0] - box[0];
      else if (mode === "right") dx = reference[2] - box[2];
      else if (mode === "center") dx = (reference[0] + reference[2]) / 2 - (box[0] + box[2]) / 2;
      else if (mode === "top") dy = reference[1] - box[1];
      else if (mode === "bottom") dy = reference[3] - box[3];
      else dy = (reference[1] + reference[3]) / 2 - (box[1] + box[3]) / 2;
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
      const [ux, uy] = screen.deltaToUser([dx, dy]);
      updates.push({ id: object.id, patch: translatePatch(object, ux, uy) });
    });
  }
  return updates;
}

// --- staying on the page ---

function clampShift(bounds, view, margin) {
  const shiftAxis = (low, high, viewLow, viewHigh) => {
    const need = Math.min(margin, high - low, viewHigh - viewLow);
    if (high < viewLow + need) return viewLow + need - high;
    if (low > viewHigh - need) return viewHigh - need - low;
    return 0;
  };
  return [shiftAxis(bounds[0], bounds[2], view[0], view[2]), shiftAxis(bounds[1], bounds[3], view[1], view[3])];
}

/**
 * Moves a frame back until at least `minVisible` points of its bounding box are on the page (in both
 * directions; a box smaller than that stays on the page entirely). Returns the SAME frame when nothing moves.
 */
export function clampFrameToPage(frame, page, minVisible = MIN_VISIBLE_ON_PAGE) {
  const clamped = clampObjectToPage({ frame }, page, minVisible);
  return clamped.frame;
}

/** clampFrameToPage for any object (frames, lines, marks, quads). Returns the SAME object when nothing moves. */
export function clampObjectToPage(object, page, minVisible = MIN_VISIBLE_ON_PAGE) {
  if (!geometryKind(object)) return object;
  const userUnit = page.userUnit || 1;
  const [dx, dy] = clampShift(objectBounds(object, userUnit), page.view, minVisible / userUnit);
  if (dx === 0 && dy === 0) return object;
  return { ...object, ...translatePatch(object, dx, dy) };
}

