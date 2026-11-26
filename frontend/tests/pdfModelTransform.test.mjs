// The maths of editing gestures (src/pages/pdfEditor/model/transform.js): move, resize, rotate, line ends,
// nudging, the factories of every object type and the bridge from interaction effects (CSS pixels).
import test from "node:test";
import assert from "node:assert/strict";
import { frameBounds, frameCorners, localToUser, userToViewport } from "../src/pages/pdfEditor/engine/geometry.js";
import { MIN_OBJECT_SIZE, OBJECT_DEFAULTS, pageGeometry, validateObject } from "../src/pages/pdfEditor/model/schema.js";
import { hitTestObject } from "../src/pages/pdfEditor/model/selectors.js";
import { objectScreenBox, pageScreen } from "../src/pages/pdfEditor/model/shapes.js";
import {
  CORNER_HANDLES,
  CREATION_KINDS,
  DEFAULT_LINE_LENGTH,
  DEFAULT_SIZES,
  DUPLICATE_OFFSET,
  HANDLES,
  MIXED,
  SIGNATURE_FIELD_MIN_SIZE,
  angleBetween,
  canRotate,
  constrainToAxis,
  createFromEffect,
  createImage,
  createLine,
  createMark,
  createReplacementText,
  createShape,
  createSignatureField,
  createStroke,
  createTextBox,
  createTextHighlight,
  defaultRatioLock,
  handleIdsOf,
  handlesOf,
  moveLineEnd,
  moveObject,
  moveObjectsOnScreen,
  nudgeDelta,
  nudgeObjects,
  objectTypeOfKind,
  pagePointFromPixels,
  patchForResizeEffect,
  patchForRotateEffect,
  patchesForMoveEffect,
  placeForDrop,
  placeOnPage,
  quadFromRect,
  rectFromPixels,
  resizeCursor,
  resizeFrameByHandle,
  resizeObject,
  rotateObject,
  sanitizeStyle,
  screenDeltaFromPixels,
  screenDeltaToUser,
  screenRotationOf,
  setObjectScreenPosition,
  setObjectSize,
  setScreenRotation,
  sharedStyle,
  snapAngle,
  styleFor,
  styleKeysOf,
  styleUpdates,
  userDeltaToScreen
} from "../src/pages/pdfEditor/model/transform.js";
import { EXTRA_ROTATIONS, PAGE_VARIANTS, close, closeAll, fakeMeasure, makePage, openStore, sample } from "./helpers/pdfModelKit.mjs";

const valid = (object, label = "") => assert.deepEqual(validateObject({ id: "test", ...object }), [], `${label} ${JSON.stringify(object)}`);
const everyPage = (fn) => {
  for (const variant of PAGE_VARIANTS) for (const extra of EXTRA_ROTATIONS) fn(makePage(variant, extra), `${variant.name} +${extra}`);
};
// corner i of frameCorners: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left (as the box sees itself)
const OPPOSITE_CORNER = { nw: 2, ne: 3, se: 0, sw: 1 };
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const OPPOSITE_EDGE = { n: [3, 2], s: [0, 1], e: [0, 3], w: [1, 2] };

test("moving: a delta in user space, axis lock, nothing for a text highlight", () => {
  assert.deepEqual(moveObject(sample.rect("p"), [5, -3]).frame, { x: 155, y: 497, w: 120, h: 80, rot: 0 });
  assert.deepEqual(moveObject(sample.line("p"), [1, 2]), { p1: [101, 102], p2: [221, 102] });
  assert.deepEqual(moveObject(sample.redact("p"), [10, 10]), { rect: [70, 70, 190, 94] });
  assert.deepEqual(moveObject({ rect: [0, 0, 10, 10] }, [1, 1]), { rect: [1, 1, 11, 11] }, "the certificate rectangle moves like a mark");
  assert.equal(moveObject(sample.highlightText("p"), [5, 5]), null);
  assert.deepEqual(constrainToAxis([8, -3]), [8, 0]);
  assert.deepEqual(constrainToAxis([2, -3]), [0, -3]);
});

test("screen directions: nudging and screen deltas follow the page as the reader sees it", () => {
  everyPage((page, label) => {
    const geometry = pageGeometry(page);
    const origin = [page.view[0] + 100, page.view[1] + 100];
    const seen = (point) => userToViewport(geometry, point, 1, page.rotation);
    for (const [direction, expected] of [["right", [1, 0]], ["left", [-1, 0]], ["up", [0, -1]], ["down", [0, 1]], ["ArrowDown", [0, 1]]]) {
      const delta = nudgeDelta(page, direction, 10);
      const before = seen(origin);
      const after = seen([origin[0] + delta[0], origin[1] + delta[1]]);
      closeAll([after[0] - before[0], after[1] - before[1]], [expected[0] * 10, expected[1] * 10], 1e-9, `${label} ${direction}`);
    }
    assert.deepEqual(nudgeDelta(page, "sideways"), [0, 0]);
    closeAll(userDeltaToScreen(page, screenDeltaToUser(page, [3, -7])), [3, -7], 1e-9, label);
  });
  assert.deepEqual(screenDeltaFromPixels({ dx: 30, dy: -15 }, 1.5), [20, -10]);
  assert.deepEqual(screenDeltaFromPixels([30, -15], 3), [10, -5]);
});

test("moveObjectsOnScreen and nudgeObjects move every object with the geometry of its own page", () => {
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800] }, { view: [0, 0, 600, 800], rotate: 90 }], measure: null });
  const [a, b] = pageIds;
  const ids = store.addObjects([sample.rect(a), sample.rect(b, { frame: { x: 300, y: 300, w: 40, h: 20, rot: 90 } }), sample.highlightText(a)]);
  const boxOf = (id, index) => objectScreenBox(store.getState().objects[id], store.getState().pages[index]);
  const before = [boxOf(ids[0], 0), boxOf(ids[1], 1)];
  const updates = moveObjectsOnScreen(store.getState(), ids, [10, 4]);
  assert.deepEqual(updates.map((update) => update.id), [ids[0], ids[1]], "the text highlight is left out");
  store.updateObjects(updates);
  closeAll(boxOf(ids[0], 0), before[0].map((value, index) => value + (index % 2 ? 4 : 10)), 1e-9);
  closeAll(boxOf(ids[1], 1), before[1].map((value, index) => value + (index % 2 ? 4 : 10)), 1e-9, "the same move on the turned page");
  assert.deepEqual(store.getState().objects[ids[0]].frame, { x: 160, y: 496, w: 120, h: 80, rot: 0 });
  assert.deepEqual(store.getState().objects[ids[1]].frame, { x: 304, y: 310, w: 40, h: 20, rot: 90 });
  assert.deepEqual(moveObjectsOnScreen(store.getState(), ids, [10, 4], { axisLock: true }).map((update) => update.patch.frame.y), [496, 320]);
  assert.deepEqual(moveObjectsOnScreen(store.getState(), ids, [0, 0]), []);
  store.updateObjects(nudgeObjects(store.getState(), [ids[1]], "up", 10));
  assert.deepEqual(store.getState().objects[ids[1]].frame, { x: 294, y: 310, w: 40, h: 20, rot: 90 });
  assert.deepEqual(nudgeObjects(store.getState(), ids, "nowhere"), []);
});

test("resizing a rotated frame keeps the opposite corner or edge where it is on the page", () => {
  for (const userUnit of [1, 2]) {
    for (const rot of [0, 30, 90, 200, 315]) {
      const frame = { x: 300, y: 400, w: 120, h: 60, rot };
      const before = frameCorners(frame, userUnit);
      for (const handle of HANDLES) {
        const resized = resizeFrameByHandle(frame, handle, [17, -9], { userUnit });
        const after = frameCorners(resized, userUnit);
        assert.equal(resized.rot, rot);
        if (handle in OPPOSITE_CORNER) {
          const index = OPPOSITE_CORNER[handle];
          closeAll(after[index], before[index], 1e-9, `${handle} @${rot}: the opposite corner stays`);
          assert.ok(Math.abs(resized.w - frame.w) > 1e-6 || Math.abs(resized.h - frame.h) > 1e-6);
        } else {
          const [i, j] = OPPOSITE_EDGE[handle];
          closeAll(midpoint(after[i], after[j]), midpoint(before[i], before[j]), 1e-9, `${handle} @${rot}: the opposite edge stays`);
          // an edge handle changes one dimension only
          if (handle === "n" || handle === "s") assert.equal(resized.w, frame.w);
          else assert.equal(resized.h, frame.h);
        }
      }
    }
  }
  // the dragged corner follows the pointer exactly
  const frame = { x: 300, y: 400, w: 120, h: 60, rot: 30 };
  const corner = frameCorners(frame)[2];
  const resized = resizeFrameByHandle(frame, "se", [21, 13]);
  closeAll(frameCorners(resized)[2], [corner[0] + 21, corner[1] + 13], 1e-9, "the dragged corner is under the pointer");
  // sizes are in points: with /UserUnit 2 a drag of 10 user-space units is 20 pt
  close(resizeFrameByHandle({ x: 0, y: 0, w: 100, h: 50, rot: 0 }, "e", [10, 0], { userUnit: 2 }).w, 120, 1e-9);
  assert.equal(resizeFrameByHandle(frame, "middle", [5, 5]), frame, "an unknown handle changes nothing");
});

test("resizing: ratio lock, minimum size, no flipping", () => {
  const frame = { x: 300, y: 400, w: 120, h: 60, rot: 30 };
  const corners = frameCorners(frame);
  for (const handle of CORNER_HANDLES) {
    const locked = resizeFrameByHandle(frame, handle, [31, 17], { lockRatio: true });
    close(locked.w / locked.h, 2, 1e-9, `${handle}: the ratio is kept`);
    closeAll(frameCorners(locked)[OPPOSITE_CORNER[handle]], corners[OPPOSITE_CORNER[handle]], 1e-9, `${handle}: locked, the opposite corner stays`);
  }
  // an edge handle with the ratio locked scales around the middle of the opposite edge
  const wider = resizeFrameByHandle(frame, "e", localToUserDelta(frame, [60, 0]), { lockRatio: true });
  close(wider.w, 180, 1e-9);
  close(wider.h, 90, 1e-9);
  closeAll(midpoint(frameCorners(wider)[0], frameCorners(wider)[3]), midpoint(corners[0], corners[3]), 1e-9);
  // dragging far past the opposite side stops at the minimum instead of flipping
  const squeezed = resizeFrameByHandle(frame, "se", localToUserDelta(frame, [-500, -500]));
  assert.equal(squeezed.w, MIN_OBJECT_SIZE);
  assert.equal(squeezed.h, MIN_OBJECT_SIZE);
  closeAll(frameCorners(squeezed)[0], corners[0], 1e-9);
  const lockedSmall = resizeFrameByHandle(frame, "nw", localToUserDelta(frame, [500, 500]), { lockRatio: true });
  close(lockedSmall.h, MIN_OBJECT_SIZE, 1e-9);
  close(lockedSmall.w, 2 * MIN_OBJECT_SIZE, 1e-9, "the ratio survives the minimum");
  const custom = resizeFrameByHandle(frame, "w", localToUserDelta(frame, [500, 0]), { minWidth: 72, minHeight: 36 });
  assert.equal(custom.w, 72);
});

// a displacement given along the frame's own right / down axes -> user space
function localToUserDelta(frame, [dx, dy]) {
  const origin = localToUser(frame, [0, 0]);
  const moved = localToUser(frame, [dx, dy]);
  return [moved[0] - origin[0], moved[1] - origin[1]];
}

test("resizeObject per type: text boxes change their width only, pictures keep their ratio, marks stay rectangles", () => {
  const page = makePage(PAGE_VARIANTS[0]);
  assert.deepEqual(handleIdsOf(sample.text("p")), ["w", "e"]);
  assert.deepEqual(handleIdsOf(sample.image("p", "a")), ["nw", "ne", "se", "sw"]);
  assert.deepEqual(handleIdsOf(sample.rect("p")), HANDLES);
  assert.deepEqual(handleIdsOf(sample.pen("p")), HANDLES);
  assert.deepEqual(handleIdsOf(sample.redact("p")), HANDLES);
  assert.deepEqual(handleIdsOf(sample.line("p")), ["p1", "p2"]);
  assert.deepEqual(handleIdsOf(sample.highlightText("p")), []);
  assert.equal(defaultRatioLock(sample.image("p", "a")), true);
  assert.equal(defaultRatioLock(sample.rect("p")), false);

  const text = sample.text("p", { frame: { x: 200, y: 600, w: 60, h: 14.4, rot: 0 }, size: 12 });
  const wider = resizeObject(text, "e", [40, 25], page);
  assert.deepEqual(wider, { frame: { x: 220, y: 600, w: 100, h: 14.4, rot: 0 }, autoWidth: false }, "the right handle sets the wrap width; the vertical part of the drag is ignored");
  assert.deepEqual(resizeObject(text, "w", [-20, 0], page).frame, { x: 190, y: 600, w: 80, h: 14.4, rot: 0 });
  assert.equal(resizeObject(text, "n", [0, 30], page), null, "no vertical handles on a text box");
  assert.deepEqual(resizeObject(text, "se", [40, 25], page), wider, "a corner acts as its side");
  assert.equal(resizeObject(text, "w", [500, 0], page).frame.w, 12, "never narrower than one em");

  const image = sample.image("p", "a", { frame: { x: 300, y: 400, w: 120, h: 60, rot: 0 } });
  const scaled = resizeObject(image, "se", [60, 0], page).frame;
  assert.deepEqual([scaled.w, scaled.h], [180, 90], "pictures keep their ratio by default");
  const free = resizeObject(image, "se", [60, 0], page, { shift: true }).frame;
  assert.deepEqual([free.w, free.h], [180, 60], "Shift releases it");
  const rect = sample.rect("p", { frame: { x: 300, y: 400, w: 120, h: 60, rot: 0 } });
  assert.deepEqual([resizeObject(rect, "se", [60, 0], page).frame.w, resizeObject(rect, "se", [60, 0], page).frame.h], [180, 60], "shapes are free by default");
  const square = resizeObject(rect, "se", [60, 0], page, { shift: true }).frame;
  assert.deepEqual([square.w, square.h], [180, 90], "Shift locks the ratio of a shape");
  assert.deepEqual(resizeObject(rect, "se", [60, 0], page, { lockRatio: false, shift: true }).frame.h, 60, "an explicit lockRatio wins");

  const pen = sample.pen("p");
  const stretched = resizeObject(pen, "e", [50, 0], page);
  assert.equal(stretched.frame.w, 150);
  assert.equal(stretched.points, undefined, "the points are fractions of the frame: they scale with it");

  assert.deepEqual(resizeObject(sample.line("p"), "p2", [30, 40], page), { p2: [250, 140] });
  assert.deepEqual(resizeObject(sample.line("p"), "p2", [30, 40], page, { shift: true }), { p2: [250, 100] }, "Shift snaps a line: 15 degrees become horizontal");
  closeAll(resizeObject(sample.line("p"), "p2", [-20, 110], page, { shift: true }).p2, [205, 205], 1e-9, "48 degrees become 45");
  assert.deepEqual(resizeObject(sample.line("p"), "p2", [-20, 110], page, { snap: false, shift: true }), { p2: [200, 210] }, "an explicit snap wins");
  assert.equal(resizeObject(sample.line("p"), "se", [1, 1], page), null);
  assert.equal(resizeObject(sample.highlightText("p"), "se", [1, 1], page), null);
  assert.equal(resizeObject(rect, "p1", [1, 1], page), null);
});

test("marks are resized as the reader sees them on every page geometry", () => {
  everyPage((page, label) => {
    const screen = pageScreen(page);
    const mark = { type: "redact", pageId: page.id, rect: screen.rectToUser([40, 50, 160, 74]), color: "#000000" };
    const drag = (dx, dy) => screen.deltaToUser([dx, dy]);
    const box = (patch) => screen.rectToScreen(patch.rect);
    closeAll(box(resizeObject(mark, "se", drag(20, 10), page)), [40, 50, 180, 84], 1e-9, `${label}: bottom-right corner`);
    closeAll(box(resizeObject(mark, "nw", drag(-10, -5), page)), [30, 45, 160, 74], 1e-9, `${label}: top-left corner`);
    closeAll(box(resizeObject(mark, "n", drag(99, -6), page)), [40, 44, 160, 74], 1e-9, `${label}: top edge`);
    closeAll(box(resizeObject(mark, "w", drag(500, 0), page)), [152, 50, 160, 74], 1e-9, `${label}: minimum width, right edge fixed`);
    const field = { rect: mark.rect };
    closeAll(box(resizeObject(field, "w", drag(500, 0), page, { minWidth: SIGNATURE_FIELD_MIN_SIZE[0], minHeight: SIGNATURE_FIELD_MIN_SIZE[1] })), [88, 50, 160, 74], 1e-9, `${label}: certificate field minimum`);
    const handles = handlesOf(mark, page);
    assert.deepEqual(handles.map((handle) => handle.id), HANDLES);
    closeAll(screen.toScreen(handles.find((handle) => handle.id === "nw").point), [40, 50], 1e-9, `${label}: the nw handle is top-left on screen`);
    closeAll(screen.toScreen(handles.find((handle) => handle.id === "e").point), [160, 62], 1e-9);
  });
});

test("handles and resize cursors", () => {
  const page = makePage(PAGE_VARIANTS[0]);
  const frame = { x: 100, y: 100, w: 40, h: 20, rot: 0 };
  const handles = Object.fromEntries(handlesOf({ type: "rect", frame }, page).map((handle) => [handle.id, handle.point]));
  assert.deepEqual(handles.nw, [80, 110]);
  assert.deepEqual(handles.se, [120, 90]);
  assert.deepEqual(handles.n, [100, 110]);
  assert.deepEqual(handlesOf(sample.line("p"), page), [{ id: "p1", point: [100, 100] }, { id: "p2", point: [220, 100] }]);
  assert.deepEqual(handlesOf(sample.highlightText("p"), page), []);
  assert.deepEqual(handlesOf(sample.text("p"), page).map((handle) => handle.id), ["w", "e"]);

  assert.equal(resizeCursor("e"), "ew-resize");
  assert.equal(resizeCursor("w"), "ew-resize");
  assert.equal(resizeCursor("n"), "ns-resize");
  assert.equal(resizeCursor("se"), "nwse-resize");
  assert.equal(resizeCursor("nw"), "nwse-resize");
  assert.equal(resizeCursor("ne"), "nesw-resize");
  assert.equal(resizeCursor("sw"), "nesw-resize");
  assert.equal(resizeCursor("e", 90), "ns-resize", "a box turned by 90 degrees: its east handle points down");
  assert.equal(resizeCursor("se", 45), "ns-resize");
  assert.equal(resizeCursor("n", 10), "ns-resize");
  assert.equal(resizeCursor("n", 30), "nesw-resize", "30 degrees off the vertical is nearer to the diagonal");
  assert.equal(resizeCursor("n", 60), "nesw-resize");
  assert.equal(resizeCursor("n", 80), "ew-resize");
  assert.equal(resizeCursor("n", 360 + 180), "ns-resize");
  assert.equal(resizeCursor("p1"), "move");
});

test("rotating about the centre, with 15 degree snapping", () => {
  const rect = sample.rect("p", { frame: { x: 100, y: 100, w: 40, h: 20, rot: 10 } });
  // dragging the handle a quarter turn counter-clockwise in user space
  assert.deepEqual(rotateObject(rect, [100, 150], [50, 100]).frame, { x: 100, y: 100, w: 40, h: 20, rot: 100 });
  assert.equal(rotateObject(rect, [100, 150], [150, 100]).frame.rot, 280);
  close(angleBetween([0, 0], [1, 0], [0, 1]), 90, 1e-9);
  const free = rotateObject(rect, [100, 150], [70, 150]).frame.rot;
  close(free, 10 + (Math.atan2(50, -30) * 180) / Math.PI - 90, 1e-9);
  assert.equal(rotateObject(rect, [100, 150], [70, 150], { snap: true }).frame.rot, 45, "41 degrees snaps to 45");
  assert.equal(rotateObject(rect, [100, 150], [99, 150], { snap: true }).frame.rot, 15);
  assert.equal(rotateObject({ ...rect, frame: { ...rect.frame, rot: 350 } }, [100, 150], [95, 150], { snap: true }).frame.rot, 0, "snapping wraps around");
  assert.equal(snapAngle(52), 45);
  assert.equal(snapAngle(-8), 345);
  assert.equal(snapAngle(100, 90), 90);

  for (const object of [sample.text("p"), sample.image("p", "a"), sample.rect("p"), sample.ellipse("p"), sample.pen("p")]) assert.equal(canRotate(object), true, object.type);
  for (const object of [sample.redact("p"), sample.blur("p"), sample.line("p"), sample.highlightText("p"), sample.highlightStroke("p"), { rect: [0, 0, 1, 1] }]) {
    assert.equal(canRotate(object), false, object.type);
    assert.equal(rotateObject(object, [0, 1], [1, 0]), null);
  }

  // what the reader sees: clockwise degrees, whatever the page rotation is
  everyPage((page, label) => {
    const screen = pageScreen(page);
    const upright = { type: "rect", frame: screen.frameFromBox({ left: 10, top: 10, width: 40, height: 20 }) };
    assert.equal(screenRotationOf(upright, page), 0, label);
    const turned = { ...upright, ...setScreenRotation(upright, page, 30) };
    close(screenRotationOf(turned, page), 30, 1e-9, label);
    assert.equal(screenRotationOf(sample.redact("p"), page), 0);
    assert.equal(setScreenRotation(sample.redact("p"), page, 30), null);
    // snapping in user space is snapping on screen: pages turn by right angles only
    const snapped = { ...turned, ...rotateObject(turned, [turned.frame.x + 10, turned.frame.y], [turned.frame.x + 10, turned.frame.y + 1], { snap: true }) };
    close(screenRotationOf(snapped, page) % 15, 0, 1e-9, `${label}: a multiple of 15 on screen`);
  });
});

test("dragging a line end, with 45 degree snapping and a minimum length", () => {
  const line = sample.line("p", { p1: [100, 100], p2: [220, 100] });
  assert.deepEqual(moveLineEnd(line, "p2", [200, 170]), { p2: [200, 170] });
  assert.deepEqual(moveLineEnd(line, "p1", [90, 80]), { p1: [90, 80] });
  assert.deepEqual(moveLineEnd(line, "p2", [200, 107], { snap: true }), { p2: [200, 100] }, "nearly horizontal: horizontal");
  assert.deepEqual(moveLineEnd(line, "p2", [104, 190], { snap: true }), { p2: [100, 190] }, "nearly vertical: vertical");
  const diagonal = moveLineEnd(line, "p2", [160, 150], { snap: true }).p2;
  close(diagonal[0] - 100, diagonal[1] - 100, 1e-9, "45 degrees");
  close(diagonal[0], 155, 1e-9, "the end is the pointer projected onto the snapped direction");
  for (let degrees = 0; degrees < 360; degrees += 7) {
    const point = [100 + 80 * Math.cos((degrees * Math.PI) / 180), 100 + 80 * Math.sin((degrees * Math.PI) / 180)];
    const end = moveLineEnd(line, "p2", point, { snap: true }).p2;
    const angle = (Math.atan2(end[1] - 100, end[0] - 100) * 180) / Math.PI;
    close(Math.abs(angle / 45 - Math.round(angle / 45)), 0, 1e-9, `${degrees} degrees`);
  }
  // never shorter than 8 pt: the direction is kept
  assert.deepEqual(moveLineEnd(line, "p2", [102, 100]), { p2: [108, 100] });
  assert.deepEqual(moveLineEnd(line, "p2", [100, 100]), { p2: [108, 100] }, "on top of the other end: the old direction");
  assert.deepEqual(moveLineEnd(line, "p2", [100, 102], { userUnit: 2 }), { p2: [100, 104] }, "8 pt are 4 units when /UserUnit is 2");
  assert.equal(moveLineEnd(line, "middle", [0, 0]), null);
});

test("typed numbers: size, position and rotation from the properties panel", () => {
  everyPage((page, label) => {
    const screen = pageScreen(page);
    const rect = { type: "rect", pageId: page.id, frame: screen.frameFromBox({ left: 40, top: 30, width: 60, height: 20 }), ...OBJECT_DEFAULTS.rect };
    const moved = { ...rect, ...setObjectScreenPosition(rect, page, { left: 100 }) };
    closeAll(objectScreenBox(moved, page), [100, 30, 160, 50], 1e-9, `${label}: X`);
    const placed = { ...rect, ...setObjectScreenPosition(rect, page, { left: 5, top: 7 }) };
    closeAll(objectScreenBox(placed, page), [5, 7, 65, 27], 1e-9, `${label}: X and Y`);
    const sized = { ...rect, ...setObjectSize(rect, page, { width: 90, height: 45 }) };
    closeAll(objectScreenBox(sized, page), [40, 30, 130, 75], 1e-9, `${label}: the top-left corner stays`);
    const mark = { type: "blur", rect: screen.rectToUser([40, 30, 100, 50]), style: "pixelate", strength: 2 };
    closeAll(screen.rectToScreen(setObjectSize(mark, page, { width: 20 }).rect), [40, 30, 60, 50], 1e-9, `${label}: a mark`);
    closeAll(screen.rectToScreen(setObjectScreenPosition(mark, page, { top: 0 }).rect), [40, 0, 100, 20], 1e-9);
  });
  const page = makePage(PAGE_VARIANTS[0]);
  const image = sample.image("p", "a", { frame: { x: 300, y: 400, w: 120, h: 60, rot: 0 } });
  assert.deepEqual(setObjectSize(image, page, { width: 60 }, { lockRatio: true }).frame, { x: 270, y: 415, w: 60, h: 30, rot: 0 });
  assert.equal(setObjectSize(image, page, { height: 2 }).frame.h, MIN_OBJECT_SIZE);
  assert.deepEqual(setObjectSize(sample.text("p"), page, { width: 120, height: 300 }), { frame: { x: 230, y: 600, w: 120, h: 14.4, rot: 0 }, autoWidth: false }, "a text box takes a width only");
  assert.equal(setObjectSize(sample.text("p"), page, { height: 300 }), null);
  assert.equal(setObjectSize(sample.line("p"), page, { width: 10 }), null);
  assert.equal(setObjectScreenPosition(sample.highlightText("p"), page, { left: 0 }), null);
});

test("styles: OBJECT_DEFAULTS merged with the tool's remembered defaults, garbage dropped", () => {
  assert.deepEqual(CREATION_KINDS.map(objectTypeOfKind), ["text", "rect", "ellipse", "line", "line", "pen", "highlight", "redact", "blur", "image", "image"]);
  assert.equal(objectTypeOfKind("stamp"), null);
  assert.deepEqual(styleFor("rect"), OBJECT_DEFAULTS.rect);
  assert.deepEqual(styleFor("arrow"), { ...OBJECT_DEFAULTS.line, headEnd: true }, "an arrow is a line with a head at its end");
  assert.deepEqual(styleFor("arrow", { headStart: true, headEnd: false }), { ...OBJECT_DEFAULTS.line, headStart: true, headEnd: false });
  assert.deepEqual(styleFor("line"), OBJECT_DEFAULTS.line);
  assert.deepEqual(styleFor("signature", { opacity: 0.5 }), { role: "signature", opacity: 0.5 });
  assert.deepEqual(styleFor("image"), { role: "image", opacity: 1 });
  assert.deepEqual(styleFor("highlighter", { color: "#22C55E", thickness: 24 }), { color: "#22c55e", thickness: 24 });
  const text = styleFor("text", { font: "tinos", size: 13.337, bold: true, color: "#00F", align: "center", autoWidth: false, text: "no" });
  assert.deepEqual(text, { font: "tinos", size: 13.34, bold: true, italic: false, underline: false, color: "#0000ff", align: "center", lineHeight: 1.2, opacity: 1 });

  assert.deepEqual(sanitizeStyle("rect", { stroke: null, fill: "#ABCDEF", strokeWidth: 500, dash: "wavy", opacity: -3, frame: {}, id: "x" }), { stroke: null, fill: "#abcdef", strokeWidth: 48, opacity: 0 });
  assert.deepEqual(sanitizeStyle("line", { stroke: null, strokeWidth: 0, headEnd: "yes" }), { strokeWidth: 0.25 }, "a line always has a stroke colour");
  assert.deepEqual(sanitizeStyle("text", { size: 9999, font: "comic", lineHeight: "1.5", color: "blue" }), { size: 400 });
  assert.deepEqual(sanitizeStyle("blur", { style: "blur", strength: 5 }), { style: "blur" });
  assert.deepEqual(sanitizeStyle("redact", { color: "#fff" }), { color: "#ffffff" });
  assert.deepEqual(sanitizeStyle("unknown", { color: "#fff" }), {});
  assert.deepEqual(sanitizeStyle("pen", null), {});
  assert.deepEqual(styleKeysOf("pen"), ["color", "width", "opacity"]);
  assert.deepEqual(styleKeysOf("nothing"), []);
});

test("the style of a selection: what the objects share, and a change that reaches each object in its own terms", () => {
  const { store, pageIds } = openStore({ measure: null });
  const [a] = pageIds;
  const [rect, ellipse, line, text, marker, quads, redact] = store.addObjects([
    sample.rect(a, { opacity: 0.5 }),
    sample.ellipse(a, { opacity: 0.5, strokeWidth: 4 }),
    sample.line(a, { opacity: 1 }),
    sample.text(a),
    sample.highlightStroke(a),
    sample.highlightText(a),
    sample.redact(a)
  ]);
  const pick = (...ids) => ids.map((id) => store.getState().objects[id]);
  assert.deepEqual(sharedStyle(pick(rect)), { stroke: "#dc2626", strokeWidth: 2, dash: "solid", fill: null, opacity: 0.5 });
  assert.deepEqual(sharedStyle(pick(rect, ellipse)), { stroke: "#dc2626", strokeWidth: MIXED, dash: "solid", fill: null, opacity: 0.5 });
  assert.deepEqual(sharedStyle(pick(rect, ellipse, line)), { stroke: "#dc2626", strokeWidth: MIXED, dash: "solid", opacity: MIXED }, "a line has no fill");
  assert.deepEqual(sharedStyle(pick(rect, text)), { opacity: MIXED });
  assert.deepEqual(sharedStyle(pick(marker, quads)), { color: "#facc15" }, "a text highlight has a colour only");
  assert.deepEqual(sharedStyle(pick(rect, redact)), {});
  assert.deepEqual(sharedStyle([]), {});

  const updates = styleUpdates(store.getState(), [rect, line, text, quads, marker, redact, "ghost"], { stroke: "#2563EB", color: "#16A34A", strokeWidth: 3, thickness: 24, bold: true, fill: null });
  assert.deepEqual(updates, [
    { id: rect, patch: { stroke: "#2563eb", strokeWidth: 3, fill: null } },
    { id: line, patch: { stroke: "#2563eb", strokeWidth: 3 } },
    { id: text, patch: { bold: true, color: "#16a34a" } },
    { id: quads, patch: { color: "#16a34a" } },
    { id: marker, patch: { color: "#16a34a", thickness: 24 } },
    { id: redact, patch: { color: "#16a34a" } }
  ]);
  assert.equal(store.updateObjects(updates, { coalesceKey: "style" }).length, 6);
  assert.equal(store.getState().objects[quads].thickness, undefined);
  assert.deepEqual(styleUpdates(store.getState(), [text], { stroke: "#000000" }), [], "nothing of that applies to a text box");
});

test("factories: a click gives the default size of the specification, upright for the reader, on every page geometry", () => {
  everyPage((page, label) => {
    const screen = pageScreen(page);
    const at = screen.toUser([150, 120]);
    const box = (object) => objectScreenBox(object, page);

    for (const type of ["rect", "ellipse"]) {
      const shape = createShape(type, page, { at });
      valid(shape, label);
      assert.equal(shape.pageId, page.id);
      assert.equal(shape.frame.rot, screen.uprightRot, `${label}: upright`);
      closeAll(box(shape), [90, 80, 210, 160], 1e-9, `${label}: ${type} 120 x 80 centred on the click`);
    }
    const redact = createMark("redact", page, { at });
    valid(redact);
    closeAll(box(redact), [90, 108, 210, 132], 1e-9, `${label}: redaction 120 x 24`);
    assert.equal(redact.color, "#000000");
    const blur = createMark("blur", page, { at }, { style: "blur", strength: 3 });
    valid(blur);
    closeAll(box(blur), [90, 90, 210, 150], 1e-9, `${label}: blur area 120 x 60`);
    assert.deepEqual([blur.style, blur.strength], ["blur", 3]);

    const line = createLine(page, { at });
    valid(line);
    closeAll([...screen.toScreen(line.p1), ...screen.toScreen(line.p2)], [90, 120, 210, 120], 1e-9, `${label}: a horizontal line of 120 pt`);
    assert.equal(line.headEnd, false);
    const arrow = createLine(page, { at }, { stroke: "#2563EB" }, { arrow: true });
    valid(arrow);
    assert.deepEqual([arrow.type, arrow.headEnd, arrow.headStart, arrow.stroke], ["line", true, false, "#2563eb"]);
    assert.ok(screen.toScreen(arrow.p2)[0] > screen.toScreen(arrow.p1)[0], `${label}: the arrow points right`);

    const text = createTextBox(page, { at }, { size: 20 }, "Ghi chú");
    valid(text);
    assert.equal(text.autoWidth, true);
    assert.equal(text.text, "Ghi chú");
    const textBox = box(text);
    close(textBox[0], 150, 1e-9, `${label}: the text starts at the click`);
    close((textBox[1] + textBox[3]) / 2, 120, 1e-9, `${label}: its first line is centred on the click`);
    close(textBox[3] - textBox[1], 24, 1e-9);
    assert.equal(text.frame.rot, screen.uprightRot);
    const centred = createTextBox(page, { at }, { align: "center" });
    close((box(centred)[0] + box(centred)[2]) / 2, 150, 1e-9, `${label}: centred text grows around the click`);
    close(box(createTextBox(page, { at }, { align: "right" }))[2], 150, 1e-9);

    const field = createSignatureField(page, { at });
    assert.equal(field.pageId, page.id);
    closeAll(screen.rectToScreen(field.rect), [60, 90, 240, 150], 1e-9, `${label}: certificate rectangle 180 x 60`);

    // near a corner the default-size object is moved onto the page
    const corner = createShape("rect", page, { at: screen.toUser([5, 5]) });
    closeAll(box(corner), [0, 0, 120, 80], 1e-9, `${label}: kept on the page`);
    const farCorner = createMark("redact", page, { at: screen.toUser([screen.width, screen.height]) });
    closeAll(box(farCorner), [screen.width - 120, screen.height - 24, screen.width, screen.height], 1e-9);
  });
  assert.equal(createShape("line", makePage(), { at: [0, 0] }), null);
  assert.equal(createMark("rect", makePage(), { at: [0, 0] }), null);
  // without a usable place every factory answers null: an effect without a position is no reason to throw
  const page = makePage();
  for (const input of [{}, undefined, null, { at: [1, NaN] }, { at: "here" }, { from: [1], to: "there" }]) {
    assert.equal(createShape("rect", page, input), null);
    assert.equal(createMark("redact", page, input), null);
    assert.equal(createTextBox(page, input), null);
    assert.equal(createImage(page, { id: "a", width: 10, height: 10 }, input), null);
    assert.equal(createSignatureField(page, input), null);
    assert.equal(createLine(page, input), null);
  }
  assert.equal(createShape("rect", page, { from: [100, 100] }).frame.w, 120, "a single point is a click, whatever it is called");
  assert.equal(createMark("redact", page, { rect: [1, 2, 3] }), null);
  assert.equal(createFromEffect({ type: "create", tool: "redact", pageId: page.id, textSelection: true }, page, 1), null, "a text selection without its line boxes");
  assert.equal(createFromEffect({ type: "create", tool: "highlighter", pageId: page.id, textSelection: true }, page, 1), null);
  assert.deepEqual(DEFAULT_SIZES.rect, [120, 80]);
  assert.equal(DEFAULT_LINE_LENGTH, 120);
  assert.deepEqual(DUPLICATE_OFFSET, [12, 12]);
});

test("factories: a drag gives that size; Shift constrains; nothing is smaller than the minimum", () => {
  everyPage((page, label) => {
    const screen = pageScreen(page);
    const from = screen.toUser([50, 60]);
    const box = (object) => objectScreenBox(object, page);
    const rect = createShape("rect", page, { from, to: screen.toUser([170, 100]) }, { fill: "#FACC15" });
    valid(rect);
    closeAll(box(rect), [50, 60, 170, 100], 1e-9, `${label}: the dragged box`);
    assert.equal(rect.fill, "#facc15");
    closeAll(box(createShape("ellipse", page, { from, to: screen.toUser([20, 10]) })), [20, 10, 50, 60], 1e-9, `${label}: dragged up and left`);
    closeAll(box(createShape("rect", page, { from, to: screen.toUser([170, 100]), constrain: true })), [50, 60, 170, 180], 1e-9, `${label}: a square from the start corner`);
    closeAll(box(createShape("ellipse", page, { from, to: screen.toUser([40, 20]), constrain: true })), [10, 20, 50, 60], 1e-9, `${label}: a circle towards the pointer`);
    closeAll(box(createShape("rect", page, { from, to: screen.toUser([52, 61]) })), [50, 60, 58, 68], 1e-9, `${label}: at least 8 x 8`);

    closeAll(box(createMark("redact", page, { from, to: screen.toUser([250, 75]) })), [50, 60, 250, 75], 1e-9, `${label}: a dragged redaction`);
    const lineRect = screen.rectToUser([30, 200, 260, 214]);
    assert.deepEqual(createMark("redact", page, { rect: [lineRect[2], lineRect[3], lineRect[0], lineRect[1]] }).rect, lineRect, "a known rectangle (a text line) is taken as it is");

    const line = createLine(page, { from, to: screen.toUser([150, 90]) });
    valid(line);
    closeAll([...screen.toScreen(line.p1), ...screen.toScreen(line.p2)], [50, 60, 150, 90], 1e-9, label);
    const snapped = createLine(page, { from, to: screen.toUser([150, 70]), constrain: true });
    closeAll([...screen.toScreen(snapped.p1), ...screen.toScreen(snapped.p2)], [50, 60, 150, 60], 1e-9, `${label}: Shift makes it horizontal on screen`);
    const short = createLine(page, { from, to: screen.toUser([51, 60]) });
    close(Math.hypot(...screen.deltaToScreen([short.p2[0] - short.p1[0], short.p2[1] - short.p1[1]])), 8, 1e-9, `${label}: at least 8 pt long`);

    const text = createTextBox(page, { from, to: screen.toUser([250, 200]) }, { size: 10 });
    valid(text);
    assert.equal(text.autoWidth, false, "a dragged text box wraps at its width");
    closeAll(box(text), [50, 60, 250, 72], 1e-9, `${label}: the dragged width, one line high`);
    close(box(createTextBox(page, { from, to: screen.toUser([52, 61]) }, { size: 10 }))[2], 70, 1e-9, `${label}: at least two ems wide`);

    const field = createSignatureField(page, { from, to: screen.toUser([60, 65]) });
    closeAll(screen.rectToScreen(field.rect), [50, 60, 122, 96], 1e-9, `${label}: a certificate rectangle is at least 72 x 36`);
    closeAll(screen.rectToScreen(createSignatureField(page, { from, to: screen.toUser([300, 200]) }).rect), [50, 60, 300, 200], 1e-9);
  });
});

test("factories: images and signatures", () => {
  everyPage((page, label) => {
    const screen = pageScreen(page);
    const at = screen.toUser([screen.width / 2, screen.height / 2]);
    const box = (object) => objectScreenBox(object, page);
    const small = createImage(page, { id: "asset_1", width: 200, height: 100 }, { at });
    valid(small);
    assert.deepEqual([small.assetId, small.role, small.opacity], ["asset_1", "image", 1]);
    const smallBox = box(small);
    const expectedWidth = Math.min(150, screen.width / 2);
    close(smallBox[2] - smallBox[0], expectedWidth, 1e-9, `${label}: natural size at 96 dpi, at most half the page`);
    close(smallBox[3] - smallBox[1], expectedWidth / 2, 1e-9);
    close((smallBox[0] + smallBox[2]) / 2, screen.width / 2, 1e-9, `${label}: centred on the click`);
    assert.equal(small.frame.rot, screen.uprightRot);

    const large = box(createImage(page, { id: "a", width: 4000, height: 1000 }, { at }));
    close(large[2] - large[0], screen.width / 2, 1e-9, `${label}: capped at half the page width`);
    close(large[3] - large[1], screen.width / 8, 1e-9, "ratio kept");
    const tall = box(createImage(page, { id: "a", width: 100, height: 100000 }, { at }));
    assert.ok(tall[3] - tall[1] <= screen.height + 1e-9, `${label}: never taller than the page`);
    const pixel = box(createImage(page, { id: "a", width: 1, height: 1 }, { at }));
    close(pixel[2] - pixel[0], 8, 1e-9, "a tiny picture is still 8 pt");

    const signature = createImage(page, { id: "sig", width: 600, height: 200 }, { at }, { role: "signature" });
    valid(signature);
    assert.equal(signature.role, "signature");
    const sigBox = box(signature);
    const sigWidth = Math.min(160, screen.width * 0.9);
    close(sigBox[2] - sigBox[0], sigWidth, 1e-9, `${label}: a signature is 160 pt wide`);
    close(sigBox[3] - sigBox[1], sigWidth / 3, 1e-9);

    const from = screen.toUser([40, 40]);
    const dragged = box(createImage(page, { id: "a", width: 200, height: 100 }, { from, to: screen.toUser([140, 60]) }));
    closeAll(dragged, [40, 40, 140, 90], 1e-9, `${label}: a drag sizes it, the ratio is kept`);
    closeAll(box(createImage(page, { id: "a", width: 200, height: 100 }, { from, to: screen.toUser([60, 100]) })), [40, 40, 160, 100], 1e-9, "the longer drag direction decides");
    closeAll(box(createImage(page, { id: "a", width: 200, height: 100 }, { from, to: screen.toUser([140, 60]), keepRatio: false })), [40, 40, 140, 60], 1e-9, "Shift releases the ratio");
    closeAll(box(createImage(page, { id: "a", width: 200, height: 100 }, { from, to: screen.toUser([42, 41]) })), [40, 40, 56, 48], 1e-9, "at least 8 pt on the short edge");
  });
  assert.equal(createImage(makePage(), null, { at: [0, 0] }), null);
  assert.equal(createImage(makePage(), { id: "a", width: 0, height: 10 }, { at: [0, 0] }), null);
});

test("factories: pen strokes, freehand and text highlights", () => {
  everyPage((page, label) => {
    const screen = pageScreen(page);
    const path = [[40, 40], [40.4, 40], [40.8, 40], [70, 40], [100, 40], [100, 80], [100, 120]].map((point) => screen.toUser(point));
    const pen = createStroke("pen", page, path, { color: "#2563EB", width: 3 });
    valid(pen, label);
    assert.deepEqual([pen.type, pen.color, pen.width], ["pen", "#2563eb", 3]);
    closeAll(objectScreenBox(pen, page), [40, 40, 100, 120], 1e-9, `${label}: the frame is the box around the stroke`);
    assert.deepEqual(pen.points, [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1]], `${label}: samples closer than 1 pt are dropped; fractions of the frame, v downwards`);
    assert.equal(createStroke("pen", page, path, undefined, { spacing: 0 }).points.length, 7, "spacing 0 keeps every sample");
    assert.equal(pen.frame.rot, screen.uprightRot);
    assert.equal(hitTestObject(pen, screen.toUser([70, 40.5]), { userUnit: page.userUnit }), true);

    const dot = createStroke("pen", page, [screen.toUser([200, 200]), screen.toUser([200, 200])]);
    valid(dot);
    assert.deepEqual(dot.points, [[0.5, 0.5]], "a tap is a dot");
    closeAll(objectScreenBox(dot, page), [196, 196, 204, 204], 1e-9, "in a box of the minimum size");
    const flat = createStroke("pen", page, [screen.toUser([10, 50]), screen.toUser([110, 50])]);
    closeAll(objectScreenBox(flat, page), [10, 46, 110, 54], 1e-9, `${label}: a straight stroke gets a box 8 pt high`);
    assert.deepEqual(flat.points, [[0, 0.5], [1, 0.5]]);

    const marker = createStroke("highlighter", page, path, { thickness: 16 });
    valid(marker);
    assert.deepEqual([marker.type, marker.mode, marker.thickness, marker.color], ["highlight", "stroke", 16, "#facc15"]);

    const rects = [screen.rectToUser([30, 200, 260, 214]), screen.rectToUser([30, 216, 180, 230])];
    const highlight = createTextHighlight(page, rects, { color: "#22C55E" });
    valid(highlight, label);
    assert.deepEqual([highlight.mode, highlight.color, highlight.quads.length], ["text", "#22c55e", 2]);
    const corners = [[30, 200], [260, 200], [260, 214], [30, 214]].flatMap((corner) => screen.toUser(corner));
    closeAll(highlight.quads[0], corners, 1e-9, `${label}: corners top-left, top-right, bottom-right, bottom-left as read`);
    closeAll(quadFromRect(page, rects[0]), corners, 1e-9);
    const quad = [1, 2, 3, 4, 5, 6, 7, 8];
    assert.deepEqual(createTextHighlight(page, [quad]).quads, [quad], "quads from the viewer are taken as they are");
  });
  const page = makePage();
  assert.equal(createStroke("pen", page, []), null);
  assert.equal(createStroke("brush", page, [[0, 0]]), null);
  assert.equal(createTextHighlight(page, []), null);
});

test("factories: the text box that replaces a line of the document", () => {
  const page = makePage(PAGE_VARIANTS[0]);
  const text = createReplacementText(page, { rect: [250, 712, 50, 700], text: "Điều 1. Phạm vi", cover: "#FFFFFF" }, { font: "tinos", size: 11 });
  valid(text);
  assert.deepEqual(text.frame, { x: 150, y: 706, w: 200, h: 12, rot: 0 });
  assert.deepEqual(text.replaces, { rect: [50, 700, 250, 712], cover: "#ffffff", sourceText: "Điều 1. Phạm vi" });
  assert.deepEqual([text.text, text.font, text.size, text.autoWidth, text.align], ["Điều 1. Phạm vi", "tinos", 11, true, "left"]);
  // a page with /Rotate 90: its text runs along the user-space y axis
  const turned = makePage(PAGE_VARIANTS[1]);
  const vertical = createReplacementText(turned, { rect: [100, 50, 112, 250], text: "x", angle: 90 });
  assert.deepEqual(vertical.frame, { x: 106, y: 150, w: 200, h: 12, rot: 90 });
  assert.equal(vertical.replaces.cover, null);
  assert.equal(createReplacementText(turned, { rect: [100, 50, 112, 250], text: "x" }).frame.rot, 90, "without an angle: upright for the reader");
  // the store accepts it and keeps the top-left corner of the line while the text grows
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800] }], measure: fakeMeasure });
  const [id] = store.addObjects([{ ...text, pageId: pageIds[0] }]);
  const stored = store.getState().objects[id];
  closeAll(objectScreenBox(stored, store.getState().pages[0]).slice(0, 2), [50, 88], 1e-9);
});

test("every factory result is accepted by the store", () => {
  for (const [variant, extra] of [[PAGE_VARIANTS[0], 0], [PAGE_VARIANTS[2], 90], [PAGE_VARIANTS[3], 270]]) {
    const { store, pageIds } = openStore({ pages: [variant] });
    if (extra) store.rotatePages(pageIds, extra);
    const page = store.getState().pages[0];
    const screen = pageScreen(page);
    const at = screen.toUser([120, 120]);
    const to = screen.toUser([200, 180]);
    const assetId = store.addAsset({ mime: "image/png", width: 300, height: 100 }, new Uint8Array([1, 2, 3]));
    const asset = store.getState().assets[assetId];
    const objects = [
      createTextBox(page, { at }, undefined, "Xin chào"),
      createTextBox(page, { from: at, to }, undefined, "Một đoạn văn bản dài hơn"),
      createShape("rect", page, { at }),
      createShape("ellipse", page, { from: at, to }),
      createLine(page, { at }),
      createLine(page, { from: at, to }, undefined, { arrow: true }),
      createMark("redact", page, { at }),
      createMark("blur", page, { from: at, to }),
      createStroke("pen", page, [at, to]),
      createStroke("highlighter", page, [at, to]),
      createTextHighlight(page, [screen.rectToUser([20, 20, 120, 32])]),
      createImage(page, asset, { at }),
      createImage(page, asset, { from: at, to }, { role: "signature" })
    ];
    const ids = store.addObjects(objects);
    assert.equal(ids.length, objects.length);
    const state = store.getState();
    for (const [index, id] of ids.entries()) {
      const stored = state.objects[id];
      // text boxes are measured by the store and a blur mark gets the seed of its mosaic there; everything
      // else is stored exactly as the factory made it
      if (stored.type === "blur") assert.match(stored.seed, /^[0-9a-f]{32}$/, "a blur mark gets its seed from the store");
      if (stored.type !== "text") assert.deepEqual({ ...stored, id: undefined, seed: undefined }, { ...objects[index], id: undefined, seed: undefined }, `${variant.name}: ${stored.type} unchanged`);
    }
  }
});

test("from interaction effects (CSS pixels at any zoom) to objects and patches", () => {
  for (const scale of [1, 1.5, 0.5]) {
    everyPage((page, label) => {
      const screen = pageScreen(page);
      const px = (x, y) => ({ x: x * scale, y: y * scale });
      closeAll(pagePointFromPixels(page, px(30, 40), scale), screen.toUser([30, 40]), 1e-9, label);
      closeAll(pagePointFromPixels(page, [30 * scale, 40 * scale], scale), screen.toUser([30, 40]), 1e-9);
      const box = (object) => objectScreenBox(object, page);
      const base = { type: "create", pageId: page.id };

      closeAll(box(createFromEffect({ ...base, tool: "rect", from: px(50, 60), to: px(170, 100), rect: {}, constrain: false }, page, scale)), [50, 60, 170, 100], 1e-9, `${label} x${scale}: rect`);
      closeAll(box(createFromEffect({ ...base, tool: "ellipse", at: px(150, 120) }, page, scale)), [90, 80, 210, 160], 1e-9, `${label} x${scale}: default ellipse`);
      const arrow = createFromEffect({ ...base, tool: "arrow", from: px(10, 10), to: px(110, 15), constrain: true }, page, scale);
      assert.equal(arrow.headEnd, true);
      closeAll([...screen.toScreen(arrow.p1), ...screen.toScreen(arrow.p2)], [10, 10, 110, 10], 1e-9, `${label}: constrained arrow`);
      assert.equal(createFromEffect({ ...base, tool: "line", at: px(100, 100) }, page, scale).headEnd, false);
      closeAll(box(createFromEffect({ ...base, tool: "redact", at: px(150, 120) }, page, scale)), [90, 108, 210, 132], 1e-9);
      const lineRect = screen.rectToUser([30, 200, 260, 214]);
      assert.deepEqual(createFromEffect({ ...base, tool: "redact", at: px(40, 205), lineId: "l1" }, page, scale, { rect: lineRect }).rect, lineRect, "Redact clicked on a text line");
      const marks = createFromEffect({ ...base, tool: "redact", textSelection: true }, page, scale, { boxes: [lineRect, [1, 2, 3, 2, 3, 4, 1, 4]] });
      assert.deepEqual(marks.map((mark) => mark.rect), [lineRect, [1, 2, 3, 4]], "one redaction per selected line");
      closeAll(box(createFromEffect({ ...base, tool: "blur", from: px(10, 10), to: px(70, 50) }, page, scale)), [10, 10, 70, 50], 1e-9);
      const text = createFromEffect({ ...base, tool: "text", at: px(100, 100), autoWidth: true }, page, scale, { style: { size: 20 }, content: "abc" });
      assert.deepEqual([text.autoWidth, text.size, text.text], [true, 20, "abc"]);
      assert.equal(createFromEffect({ ...base, tool: "text", from: px(100, 100), to: px(300, 110), autoWidth: false }, page, scale).autoWidth, false);
      const pen = createFromEffect({ ...base, tool: "pen", points: [px(40, 40), px(100, 40), px(100, 120)] }, page, scale, { style: { width: 5 } });
      closeAll(box(pen), [40, 40, 100, 120], 1e-9, `${label} x${scale}: pen`);
      assert.equal(pen.width, 5);
      assert.equal(createFromEffect({ ...base, tool: "highlighter", points: [px(40, 40), px(100, 40)] }, page, scale).mode, "stroke");
      assert.equal(createFromEffect({ ...base, tool: "highlighter", textSelection: true }, page, scale, { boxes: [lineRect] }).mode, "text");
      const asset = { id: "asset", width: 200, height: 100 };
      const image = createFromEffect({ ...base, tool: "image", payload: "x", from: px(40, 40), to: px(140, 60), keepRatio: true }, page, scale, { asset });
      closeAll(box(image), [40, 40, 140, 90], 1e-9);
      closeAll(box(createFromEffect({ ...base, tool: "image", from: px(40, 40), to: px(140, 60), keepRatio: false }, page, scale, { asset })), [40, 40, 140, 60], 1e-9);
      assert.equal(createFromEffect({ ...base, tool: "signature", at: px(100, 100) }, page, scale, { asset }).role, "signature");
      const field = createFromEffect({ ...base, tool: "certSign", from: px(50, 60), to: px(300, 200) }, page, scale);
      closeAll(screen.rectToScreen(field.rect), [50, 60, 300, 200], 1e-9);
      assert.equal(createFromEffect({ ...base, tool: "eraser", at: px(1, 1) }, page, scale), null);

      closeAll(rectFromPixels(page, { x: 10 * scale, y: 20 * scale, width: 30 * scale, height: 40 * scale }, scale), screen.rectToUser([10, 20, 40, 60]), 1e-9, `${label}: marquee`);
    });
  }
});

test("move, resize and rotate effects become store updates", () => {
  const scale = 2;
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800], rotate: 90 }, { view: [0, 0, 600, 800] }], measure: null });
  const [a, b] = pageIds;
  const pageA = () => store.getState().pages[0];
  const screen = pageScreen(pageA());
  const [rect, image, line] = store.addObjects([
    sample.rect(a, { frame: screen.frameFromBox({ left: 100, top: 100, width: 80, height: 40 }) }),
    { type: "image", pageId: a, frame: screen.frameFromBox({ left: 300, top: 100, width: 120, height: 60 }), assetId: store.addAsset({ mime: "image/png", width: 2, height: 1 }, new Uint8Array([9])), role: "image", opacity: 1 },
    sample.line(a, { p1: screen.toUser([100, 300]), p2: screen.toUser([200, 300]) })
  ]);
  const box = (id) => objectScreenBox(store.getState().objects[id], pageA());

  store.updateObjects(patchesForMoveEffect(store.getState(), { type: "move", ids: [rect, line], pageId: a, dx: 40, dy: -20, axisLock: false }, scale));
  closeAll(box(rect), [120, 90, 200, 130], 1e-9, "40 px at zoom 2 are 20 pt");
  store.updateObjects(patchesForMoveEffect(store.getState(), { type: "move", ids: [rect], pageId: a, dx: 40, dy: -30, axisLock: true }, scale));
  closeAll(box(rect), [140, 90, 220, 130], 1e-9, "axis lock keeps the larger direction");

  store.updateObjects([patchForResizeEffect(store.getState(), { type: "resize", id: rect, pageId: a, handle: "se", dx: 40, dy: 20, invertRatioLock: false }, scale)]);
  closeAll(box(rect), [140, 90, 240, 140], 1e-9);
  store.updateObjects([patchForResizeEffect(store.getState(), { type: "resize", id: image, pageId: a, handle: "se", dx: 120, dy: 0, invertRatioLock: false }, scale)]);
  closeAll(box(image), [300, 100, 480, 190], 1e-9, "a picture keeps its ratio");
  store.updateObjects([patchForResizeEffect(store.getState(), { type: "resize", id: image, pageId: a, handle: "se", dx: 40, dy: 0, invertRatioLock: true }, scale)]);
  closeAll(box(image), [300, 100, 500, 190], 1e-9, "Shift releases it");
  store.updateObjects([patchForResizeEffect(store.getState(), { type: "resize", id: line, pageId: a, handle: "p2", dx: 0, dy: 80, invertRatioLock: false }, scale)]);
  closeAll(screen.toScreen(store.getState().objects[line].p2), [220, 330], 1e-9, "the end of the (moved) line follows the pointer by 40 pt");
  assert.equal(patchForResizeEffect(store.getState(), { id: "ghost", handle: "se", dx: 1, dy: 1 }, scale), null);

  // rotation: the handle is dragged a quarter turn clockwise on screen around the centre of the box (190, 115)
  const turn = patchForRotateEffect(store.getState(), { type: "rotate", id: rect, pageId: a, from: { x: 380, y: 130 }, to: { x: 480, y: 230 }, snap: false }, scale);
  store.updateObjects([turn]);
  close(screenRotationOf(store.getState().objects[rect], pageA()), 90, 1e-9);
  const snapped = patchForRotateEffect(store.getState(), { type: "rotate", id: rect, pageId: a, from: { x: 480, y: 230 }, to: { x: 470, y: 280 }, snap: true }, scale);
  close(screenRotationOf({ ...store.getState().objects[rect], ...snapped.patch }, pageA()) % 15, 0, 1e-9);
  assert.equal(patchForRotateEffect(store.getState(), { id: line, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, scale), null, "lines have no rotation handle");

  // a move that ends over another page: the object keeps its distance to the pointer
  const effect = { type: "move", ids: [image], pageId: a, from: { x: 700, y: 250 }, to: { x: 700, y: 1400 }, dx: 0, dy: 1150, drop: { pageId: b, x: 300, y: 500 } };
  const place = placeForDrop(effect, scale, scale);
  assert.deepEqual(place, { offset: [-200, 125], fit: false });
  store.moveObjectsToPage([image], b, place);
  closeAll(objectScreenBox(store.getState().objects[image], store.getState().pages[1]), [100, 225, 300, 315], 1e-9, "the pointer grabbed it 50 pt right of its left edge and 25 pt below its top");
  assert.equal(placeForDrop({ from: { x: 1, y: 1 }, drop: null }), null);
});

test("placeOnPage: keep, offset, at, center, and fitting onto the page", () => {
  const from = makePage({ view: [0, 0, 600, 800], rotate: 0, userUnit: 1 }, 0, "from");
  const same = makePage({ view: [0, 0, 600, 800], rotate: 0, userUnit: 1 }, 0, "same");
  const small = makePage({ view: [0, 0, 200, 200], rotate: 90, userUnit: 1 }, 90, "small");
  const rect = { id: "r", type: "rect", pageId: "from", frame: { x: 500, y: 100, w: 100, h: 40, rot: 0 }, ...OBJECT_DEFAULTS.rect };
  const mark = { id: "m", type: "redact", pageId: "from", rect: [300, 60, 420, 84], color: "#000000" };
  const items = [{ object: rect, fromPage: from }, { object: mark, fromPage: from }];

  const kept = placeOnPage(items, same);
  assert.deepEqual(kept.map((object) => object.pageId), ["same", "same"]);
  assert.deepEqual(kept[0].frame, rect.frame, "the same geometry on a page of the same geometry");
  assert.equal(kept[0].id, "r");
  const shifted = placeOnPage(items, same, { offset: [12, 12] });
  assert.deepEqual(shifted[0].frame, { x: 512, y: 88, w: 100, h: 40, rot: 0 });
  assert.deepEqual(shifted[1].rect, [312, 48, 432, 72]);
  // near the edge the offset would push the group off the page: it is moved back as a whole
  const fitted = placeOnPage(items, same, { offset: [100, 0] });
  assert.deepEqual(fitted[0].frame.x - rect.frame.x, 50, "only as far as the page allows");
  assert.deepEqual(fitted[1].rect[0] - mark.rect[0], 50, "the group keeps its arrangement");
  assert.deepEqual(placeOnPage(items, same, { offset: [100, 0], fit: false })[0].frame.x, 600);

  const centred = placeOnPage([items[0]], same, "center");
  assert.deepEqual(centred[0].frame, { x: 300, y: 400, w: 100, h: 40, rot: 0 });
  const atPoint = placeOnPage(items, same, { at: [200, 300] });
  const bounds = [...frameBounds(atPoint[0].frame), ...atPoint[1].rect];
  close((Math.min(bounds[0], bounds[4]) + Math.max(bounds[2], bounds[6])) / 2, 200, 1e-9);
  close((Math.min(bounds[1], bounds[5]) + Math.max(bounds[3], bounds[7])) / 2, 300, 1e-9);

  // onto a small, turned page: upright for the reader, inside the page, larger than the page -> centred
  const onSmall = placeOnPage(items, small);
  assert.equal(onSmall[0].frame.rot, 180);
  const screen = pageScreen(small);
  const boxes = onSmall.map((object) => objectScreenBox(object, small));
  const union = [Math.min(boxes[0][0], boxes[1][0]), Math.min(boxes[0][1], boxes[1][1]), Math.max(boxes[0][2], boxes[1][2]), Math.max(boxes[0][3], boxes[1][3])];
  close((union[0] + union[2]) / 2, screen.width / 2, 1e-9, "250 pt wide on a 200 pt page: centred");
  assert.ok(union[1] >= -1e-9 && union[3] <= screen.height + 1e-9, "it fits vertically: inside");
  assert.deepEqual(placeOnPage([], same), []);
});
