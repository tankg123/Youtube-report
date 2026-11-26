// Read-only questions about the document (src/pages/pdfEditor/model/selectors.js and shapes.js): lookups,
// paint order, pending marks, hit testing, bounding boxes, alignment, staying on the page.
import test from "node:test";
import assert from "node:assert/strict";
import { frameBounds, viewportTransform } from "../src/pages/pdfEditor/engine/geometry.js";
import { OBJECT_DEFAULTS, objectBounds, pageGeometry } from "../src/pages/pdfEditor/model/schema.js";
import {
  ALIGNMENTS,
  MIN_VISIBLE_ON_PAGE,
  alignObjects,
  boundsOfObjects,
  clampFrameToPage,
  clampObjectToPage,
  countPendingMarks,
  createObjectsOfPageSelector,
  hitTestObject,
  isMovable,
  moveIndexForDrop,
  objectAtPoint,
  objectById,
  objectTouchesRect,
  objectsAtPoint,
  objectsInRect,
  objectsOfPage,
  pageById,
  pageIndexOf,
  pageOfObject,
  paintOrder,
  pendingMarks,
  pristineSourceId,
  replacedTexts,
  selectionScreenBoxes,
  sourcesInUse,
  validateDocument,
  validatePage
} from "../src/pages/pdfEditor/model/selectors.js";
import {
  deepEqual,
  deepFreeze,
  distanceToPolyline,
  distanceToSegment,
  geometryKind,
  mapToPagePatch,
  objectScreenBox,
  pageScreen,
  pointInPolygon,
  polygonIntersectsRect,
  thinPolyline,
  translatePatch
} from "../src/pages/pdfEditor/model/shapes.js";
import { EXTRA_ROTATIONS, PAGE_VARIANTS, bytesOf, close, closeAll, makePage, openStore, sample, sourceFacts } from "./helpers/pdfModelKit.mjs";

/** A store whose single page has the geometry of `variant` and the extra rotation `extra`. */
function storeFor(variant, extra) {
  const opened = openStore({ pages: [variant], measure: null });
  if (extra) opened.store.rotatePages(opened.pageIds, extra);
  const page = () => opened.store.getState().pages[0];
  return { ...opened, page, screen: () => pageScreen(page()) };
}

test("pageScreen is the pdf.js viewport at scale 1 with the rotation the user added", () => {
  for (const variant of PAGE_VARIANTS) {
    for (const extra of EXTRA_ROTATIONS) {
      const page = makePage(variant, extra);
      const screen = pageScreen(page);
      const viewport = viewportTransform(pageGeometry(page), 1, extra);
      close(screen.width, viewport.width, 1e-9);
      close(screen.height, viewport.height, 1e-9);
      assert.equal(screen.uprightRot, (variant.rotate + extra) % 360);
      const point = [variant.view[0] + 30, variant.view[1] + 70];
      const [sx, sy] = screen.toScreen(point);
      closeAll(screen.toUser([sx, sy]), point, 1e-9, variant.name);
      // one point to the right on screen is 1 / userUnit user-space units along a page axis
      const right = screen.deltaToUser([1, 0]);
      close(Math.hypot(right[0], right[1]), 1 / variant.userUnit, 1e-12);
      closeAll(screen.deltaToScreen(right), [1, 0], 1e-12);
      // a box that looks upright on screen
      const frame = screen.frameFromBox({ left: 10, top: 20, width: 80, height: 30 });
      assert.equal(frame.rot, screen.uprightRot);
      closeAll(screen.rectToScreen(frameBounds(frame, variant.userUnit)), [10, 20, 90, 50], 1e-9, `${variant.name} +${extra}`);
      assert.equal(screen.screenRotation(frame), 0);
    }
  }
});

test("lookups, paint order with marks apart, pending marks with page numbers", () => {
  const { store, sourceId, pageIds } = openStore({ measure: null });
  const [a, b, c] = pageIds;
  const [rect, redactA, text, blurA] = store.addObjects([sample.rect(a), sample.redact(a), sample.text(a, { replaces: { rect: [250, 720, 50, 700], cover: "#ffffff", sourceText: "Điều 1" } }), sample.blur(a)]);
  const [redactC, pen] = store.addObjects([sample.redact(c), sample.pen(c)]);
  const state = store.getState();

  assert.equal(pageIndexOf(state, b), 1);
  assert.equal(pageIndexOf(state, "ghost"), -1);
  assert.equal(pageById(state, c).id, c);
  assert.equal(pageById(state, "ghost"), null);
  assert.equal(objectById(state, rect).type, "rect");
  assert.equal(objectById(state, "ghost"), null);
  assert.equal(pageOfObject(state, pen).id, c);
  assert.equal(pageOfObject(state, "ghost"), null);

  const onA = objectsOfPage(state, a);
  assert.deepEqual(onA.marks.map((object) => object.id), [redactA, blurA]);
  assert.deepEqual(onA.objects.map((object) => object.id), [rect, text]);
  assert.deepEqual(paintOrder(state, a), [redactA, blurA, rect, text], "bottom -> top, marks below everything");
  assert.deepEqual(objectsOfPage(state, "ghost"), { marks: [], objects: [] });
  // a stale page object in the hands of a caller is resolved through the state
  const stale = { ...state.pages[0], objectIds: [] };
  assert.equal(objectsOfPage(state, stale).objects.length, 2);

  assert.deepEqual(pendingMarks(state).map((mark) => [mark.id, mark.type, mark.pageId, mark.pageIndex, mark.pageNumber]), [
    [redactA, "redact", a, 0, 1],
    [blurA, "blur", a, 0, 1],
    [redactC, "redact", c, 2, 3]
  ]);
  assert.deepEqual(pendingMarks(state)[0].rect, [60, 60, 180, 84]);
  assert.equal(pendingMarks(state)[0].object, state.objects[redactA]);
  assert.deepEqual(countPendingMarks(state), { redact: 2, blur: 1, total: 3, pages: 2 });
  assert.deepEqual(replacedTexts(state).map((row) => [row.id, row.pageNumber, row.rect]), [[text, 1, [50, 700, 250, 720]]]);
  assert.deepEqual(sourcesInUse(state).map((source) => source.id), [sourceId]);

  // page numbers follow the page order
  store.movePages([c], 0);
  assert.deepEqual(pendingMarks(store.getState()).map((mark) => mark.pageNumber), [1, 2, 2]);
});

test("createObjectsOfPageSelector returns the same arrays while a page shows the same objects", () => {
  const { store, pageIds } = openStore({ measure: null });
  const [a, b] = pageIds;
  const [rect] = store.addObjects([sample.rect(a), sample.redact(a)]);
  const [other] = store.addObjects([sample.pen(b)]);
  const select = createObjectsOfPageSelector();
  const first = select(store.getState(), a);
  store.updateObjects([{ id: other, patch: { opacity: 0.5 } }]);
  store.rotatePages([b], 90);
  assert.equal(select(store.getState(), a), first, "changes on another page keep the result");
  assert.notEqual(objectsOfPage(store.getState(), a), objectsOfPage(store.getState(), a), "the plain selector builds new arrays every time");
  store.updateObjects([{ id: rect, patch: { opacity: 0.5 } }]);
  const second = select(store.getState(), a);
  assert.notEqual(second, first);
  assert.equal(second.objects[0].opacity, 0.5);
  assert.equal(select(store.getState(), a), second);
});

test("sourcesInUse, moveIndexForDrop and pristineSourceId on plain states", () => {
  const { store, sourceId, pageIds } = openStore();
  const second = store.addSource(sourceFacts([{}]), bytesOf(40, 2), { name: "b.pdf" });
  store.insertPages(store.pagesOfSource(second), 1);
  const state = store.getState();
  assert.deepEqual(sourcesInUse(state).map((source) => source.id), [sourceId, second], "in the order of their first page");
  assert.equal(pristineSourceId(state), null);
  assert.equal(pristineSourceId({ ...state, pages: state.pages.filter((page) => page.sourceId === sourceId) }), sourceId);
  assert.equal(pristineSourceId({ ...state, pages: [] }), null);

  const pages = pageIds.map((id) => ({ id }));
  const [a, b, c] = pageIds;
  assert.equal(moveIndexForDrop(pages, [a], 3), 2, "dropped after the last page");
  assert.equal(moveIndexForDrop(pages, [a], 0), 0);
  assert.equal(moveIndexForDrop(pages, [a], 1), 0, "dropped right after itself: it stays");
  assert.equal(moveIndexForDrop(pages, [c], 1), 1);
  assert.equal(moveIndexForDrop(pages, [a, b], 3), 1);
  assert.equal(moveIndexForDrop(pages, [b], -5), 0);
  // the store command takes exactly that index
  store.movePages([a], moveIndexForDrop(store.getState().pages, [a], 2));
  assert.equal(store.getState().pages[1].id, a);
});

test("hit testing follows the page geometry: /Rotate, shifted boxes, /UserUnit and the user's rotation", () => {
  for (const variant of PAGE_VARIANTS) {
    for (const extra of EXTRA_ROTATIONS) {
      const label = `${variant.name} +${extra}`;
      const { store, pageIds, page, screen } = storeFor(variant, extra);
      const s = screen();
      const upright = (left, top, width, height, boxRotation = 0) => s.frameFromBox({ left, top, width, height }, boxRotation);
      const [filled, hollow, ellipse, tilted, line, pen, highlight, quads, redact, text] = store.addObjects([
        sample.rect(pageIds[0], { frame: upright(20, 20, 60, 40), fill: "#ffffff" }),
        sample.rect(pageIds[0], { frame: upright(100, 20, 60, 40), fill: null, strokeWidth: 2 }),
        sample.ellipse(pageIds[0], { frame: upright(20, 80, 60, 40), fill: "#ffffff", stroke: null }),
        sample.rect(pageIds[0], { frame: upright(100, 80, 80, 20, 45), fill: "#000000" }),
        sample.line(pageIds[0], { p1: s.toUser([20, 150]), p2: s.toUser([120, 150]), strokeWidth: 2 }),
        sample.pen(pageIds[0], { frame: upright(140, 140, 40, 40), points: [[0, 0], [1, 0], [1, 1]], width: 4 }),
        sample.highlightStroke(pageIds[0], { frame: upright(20, 200, 100, 20), points: [[0, 0.5], [1, 0.5]], thickness: 12 }),
        sample.highlightText(pageIds[0], { quads: [[...s.toUser([150, 200]), ...s.toUser([250, 200]), ...s.toUser([250, 215]), ...s.toUser([150, 215])]] }),
        sample.redact(pageIds[0], { rect: s.rectToUser([20, 240, 140, 264]) }),
        sample.text(pageIds[0], { frame: upright(160, 240, 60, 14.4) })
      ]);
      const at = (x, y, tolerance = 0, options) => objectsAtPoint(store.getState(), page(), s.toUser([x, y]), tolerance, options).map((object) => object.id);

      assert.deepEqual(at(50, 40), [filled], `${label}: inside a filled rectangle`);
      assert.deepEqual(at(84, 40), [], `${label}: beside it`);
      assert.deepEqual(at(84, 40, 4), [filled], `${label}: within the tolerance`);
      assert.deepEqual(at(130, 40), [], `${label}: the inside of an empty rectangle is free`);
      assert.deepEqual(at(130, 40, 0, { solid: true }), [hollow], `${label}: unless the caller wants whole shapes`);
      assert.deepEqual(at(100.5, 40), [hollow], `${label}: on its outline`);
      assert.deepEqual(at(130, 61.5, 1), [hollow], `${label}: near its outline`);
      assert.deepEqual(at(50, 100), [ellipse], `${label}: inside the ellipse`);
      assert.deepEqual(at(23, 83), [], `${label}: the corner of its box is outside the ellipse`);
      assert.deepEqual(at(140, 90), [tilted], `${label}: centre of the tilted box`);
      assert.deepEqual(at(104, 82), [], `${label}: inside its bounding box but outside the tilted box`);
      assert.deepEqual(at(70, 150.9), [line], `${label}: on the line`);
      assert.deepEqual(at(70, 153), [], `${label}: 3 pt off a 2 pt line`);
      assert.deepEqual(at(70, 153, 3), [line], `${label}: within the tolerance`);
      assert.deepEqual(at(124, 150), [], `${label}: beyond its end`);
      assert.deepEqual(at(160, 141.5), [pen], `${label}: on the first segment of the stroke`);
      assert.deepEqual(at(150, 170), [], `${label}: inside the box of the stroke but away from the ink`);
      assert.deepEqual(at(60, 214), [highlight], `${label}: within the thickness of the highlighter`);
      assert.deepEqual(at(60, 218), [], `${label}: below it`);
      assert.deepEqual(at(200, 207), [quads], `${label}: inside the quad of a text highlight`);
      assert.deepEqual(at(200, 217), [], `${label}: under the quad`);
      assert.deepEqual(at(200, 217, 3), [quads]);
      assert.deepEqual(at(80, 250), [redact], `${label}: inside a mark`);
      assert.deepEqual(at(190, 247), [text], `${label}: on a text box`);
      assert.equal(objectAtPoint(store.getState(), page(), s.toUser([400, 400])), null);

      // everything stacked on one spot: topmost first, marks last
      const [top, mark] = store.addObjects([sample.rect(pageIds[0], { frame: upright(30, 30, 20, 20), fill: "#00ff00" }), sample.blur(pageIds[0], { rect: s.rectToUser([30, 30, 50, 50]) })]);
      assert.deepEqual(at(40, 40), [top, filled, mark], `${label}: stacking order`);
      assert.equal(objectAtPoint(store.getState(), pageIds[0], s.toUser([40, 40])).id, top);
      store.arrange([filled], "front");
      assert.deepEqual(at(40, 40), [filled, top, mark]);
      assert.deepEqual(validateDocument(store.getState()), []);
    }
  }
});

test("hitTestObject details: invisible shapes, dots, degenerate ellipses, unknown things", () => {
  const frame = { x: 100, y: 100, w: 40, h: 20, rot: 0 };
  const ghost = { type: "rect", frame, stroke: null, fill: null, strokeWidth: 2 };
  assert.equal(hitTestObject(ghost, [100, 100]), true, "a shape without stroke and fill can still be picked (to delete it)");
  const thick = { type: "rect", frame, stroke: "#000000", fill: null, strokeWidth: 30 };
  assert.equal(hitTestObject(thick, [100, 100]), true, "a stroke wider than the shape fills it");
  assert.equal(hitTestObject({ ...thick, type: "ellipse" }, [100, 100]), true);
  const dot = { type: "pen", frame: { x: 50, y: 50, w: 8, h: 8, rot: 0 }, points: [[0.5, 0.5]], width: 4 };
  assert.equal(hitTestObject(dot, [51, 51]), true);
  assert.equal(hitTestObject(dot, [54, 54]), false);
  assert.equal(hitTestObject(dot, [54, 54], { tolerance: 4 }), true);
  // with /UserUnit 2 a point is half a user-space unit: tolerances are in points
  const line = { type: "line", p1: [0, 0], p2: [100, 0], strokeWidth: 2 };
  assert.equal(hitTestObject(line, [50, 1.4], { userUnit: 1 }), false);
  assert.equal(hitTestObject(line, [50, 0.4], { userUnit: 2 }), true);
  assert.equal(hitTestObject(line, [50, 0.6], { userUnit: 2 }), false);
  assert.equal(hitTestObject(line, [50, 0.6], { userUnit: 2, tolerance: 1 }), true);
  assert.equal(hitTestObject({ type: "mystery" }, [0, 0]), false);
  assert.equal(hitTestObject(null, [0, 0]), false);
  assert.equal(geometryKind({ rect: [0, 0, 1, 1] }), "rect");
  assert.equal(geometryKind({ type: "rect", frame }), "frame");
  assert.equal(geometryKind({}), null);
});

test("objectsInRect: a marquee selects what it touches, also on turned pages", () => {
  for (const [variant, extra] of [[PAGE_VARIANTS[0], 0], [PAGE_VARIANTS[1], 90], [PAGE_VARIANTS[3], 180]]) {
    const { store, pageIds, page, screen } = storeFor(variant, extra);
    const s = screen();
    const upright = (left, top, width, height, boxRotation = 0) => s.frameFromBox({ left, top, width, height }, boxRotation);
    const [rect, tilted, line, pen, quads, redact] = store.addObjects([
      sample.rect(pageIds[0], { frame: upright(20, 20, 40, 40) }),
      sample.rect(pageIds[0], { frame: upright(100, 20, 80, 10, 45) }),
      sample.line(pageIds[0], { p1: s.toUser([20, 100]), p2: s.toUser([120, 160]) }),
      sample.pen(pageIds[0], { frame: upright(150, 100, 60, 60), points: [[0, 0], [1, 1]] }),
      sample.highlightText(pageIds[0], { quads: [[...s.toUser([20, 200]), ...s.toUser([90, 200]), ...s.toUser([90, 212]), ...s.toUser([20, 212])]] }),
      sample.redact(pageIds[0], { rect: s.rectToUser([120, 200, 200, 220]) })
    ]);
    const marquee = (left, top, right, bottom) => objectsInRect(store.getState(), page(), s.rectToUser([left, top, right, bottom])).map((object) => object.id);
    assert.deepEqual(marquee(0, 0, 30, 30), [rect], `${variant.name}: a corner is enough`);
    assert.deepEqual(marquee(62, 0, 98, 60), [], "between the two boxes");
    assert.deepEqual(marquee(160, 0, 170, 8), [], "a corner of the tilted box's bounds, away from the box itself");
    assert.deepEqual(marquee(130, 15, 150, 35), [tilted]);
    assert.deepEqual(marquee(60, 110, 80, 150), [line], "a segment that crosses the marquee");
    assert.deepEqual(marquee(20, 140, 60, 160), [], "the bounds of the line, away from the line");
    assert.deepEqual(marquee(190, 100, 210, 115), [], "the box of the stroke, away from the ink");
    assert.deepEqual(marquee(170, 115, 190, 135), [pen]);
    assert.deepEqual(marquee(0, 190, 300, 230), [redact, quads], "marks first, then bottom to top");
    assert.equal(marquee(0, 0, 300, 300).length, 6);
    assert.equal(objectTouchesRect(store.getState().objects[rect], s.rectToUser([60, 60, 70, 70]), variant.userUnit), true, "touching counts");
    assert.deepEqual(objectsInRect(store.getState(), "ghost", [0, 0, 1, 1]), []);
  }
});

test("bounding boxes on screen: objects, selections, several pages", () => {
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800] }, { view: [0, 0, 600, 800], rotate: 90 }], measure: null });
  const [a, b] = pageIds;
  const pageB = pageScreen(store.getState().pages[1]);
  const [rect, line, other] = store.addObjects([
    sample.rect(a, { frame: { x: 150, y: 700, w: 100, h: 40, rot: 0 } }),
    sample.line(a, { p1: [300, 600], p2: [400, 500], strokeWidth: 4 }),
    sample.rect(b, { frame: pageB.frameFromBox({ left: 40, top: 50, width: 60, height: 30 }) })
  ]);
  const state = store.getState();
  assert.deepEqual(objectScreenBox(state.objects[rect], state.pages[0]), [100, 80, 200, 120]);
  assert.deepEqual(objectScreenBox(state.objects[line], state.pages[0]), [298, 198, 402, 302], "a line with half its stroke width around it");
  closeAll(objectScreenBox(state.objects[other], state.pages[1]), [40, 50, 100, 80], 1e-9);
  assert.deepEqual(boundsOfObjects([state.objects[rect], state.objects[line]]), [100, 498, 402, 720]);
  assert.equal(boundsOfObjects([]), null);
  const boxes = selectionScreenBoxes(state, [other, line, rect, "ghost"]);
  assert.deepEqual(boxes.map((entry) => [entry.pageId, entry.ids]), [[a, [rect, line]], [b, [other]]]);
  assert.deepEqual(boxes[0].box, [100, 80, 402, 302]);
  assert.deepEqual(selectionScreenBoxes(state, []), []);
});

test("alignObjects lines objects up as the reader sees them, whatever the page geometry is", () => {
  assert.deepEqual(ALIGNMENTS, ["left", "center", "right", "top", "middle", "bottom"]);
  for (const variant of PAGE_VARIANTS) {
    for (const extra of EXTRA_ROTATIONS) {
      const label = `${variant.name} +${extra}`;
      const { store, pageIds, page, screen } = storeFor(variant, extra);
      const s = screen();
      const ids = store.addObjects([
        sample.rect(pageIds[0], { frame: s.frameFromBox({ left: 30, top: 40, width: 60, height: 20 }) }),
        sample.rect(pageIds[0], { frame: s.frameFromBox({ left: 120, top: 100, width: 40, height: 40 }, 30) }),
        sample.line(pageIds[0], { p1: s.toUser([60, 180]), p2: s.toUser([200, 220]), strokeWidth: 2 }),
        sample.redact(pageIds[0], { rect: s.rectToUser([80, 250, 140, 270]) }),
        sample.highlightText(pageIds[0], { quads: [[...s.toUser([10, 10]), ...s.toUser([20, 10]), ...s.toUser([20, 16]), ...s.toUser([10, 16])]] })
      ]);
      const movable = ids.slice(0, 4);
      const boxes = () => movable.map((id) => objectScreenBox(store.getState().objects[id], page()));
      const before = boxes();
      const union = [Math.min(...before.map((box) => box[0])), Math.min(...before.map((box) => box[1])), Math.max(...before.map((box) => box[2])), Math.max(...before.map((box) => box[3]))];
      const edgeOf = { left: (box) => box[0], center: (box) => (box[0] + box[2]) / 2, right: (box) => box[2], top: (box) => box[1], middle: (box) => (box[1] + box[3]) / 2, bottom: (box) => box[3] };
      for (const mode of ALIGNMENTS) {
        const updates = alignObjects(store.getState(), ids, mode);
        assert.ok(updates.every((update) => update.id !== ids[4]), `${label}: a text highlight never moves`);
        store.transaction(() => store.updateObjects(updates));
        const after = boxes();
        const target = edgeOf[mode](union);
        after.forEach((box, index) => {
          close(edgeOf[mode](box), target, 1e-6, `${label} ${mode}: object ${index}`);
          // the other direction is untouched
          const horizontal = mode === "left" || mode === "center" || mode === "right";
          close(horizontal ? box[1] : box[0], horizontal ? before[index][1] : before[index][0], 1e-6, `${label} ${mode}: other axis`);
          close(box[2] - box[0], before[index][2] - before[index][0], 1e-6, `${label} ${mode}: size`);
        });
        assert.deepEqual(alignObjects(store.getState(), ids, mode), [], `${label} ${mode}: aligned objects need no update`);
        store.undo();
      }
      // one object (or relativeTo: "page") lines up with the visible page
      const [single] = alignObjects(store.getState(), [ids[0]], "right");
      store.updateObjects([single]);
      close(objectScreenBox(store.getState().objects[ids[0]], page())[2], s.width, 1e-6, `${label}: right edge of the page`);
      store.updateObjects(alignObjects(store.getState(), movable, "middle", { relativeTo: "page" }));
      for (const box of boxes()) close((box[1] + box[3]) / 2, s.height / 2, 1e-6, `${label}: middle of the page`);
      assert.deepEqual(alignObjects(store.getState(), ids, "diagonal"), []);
      assert.deepEqual(validateDocument(store.getState()), []);
    }
  }
});

test("alignObjects aligns the objects of each page among themselves", () => {
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800] }, { view: [0, 0, 600, 800], rotate: 90 }], measure: null });
  const [a, b] = pageIds;
  const ids = store.addObjects([
    sample.rect(a, { frame: { x: 100, y: 700, w: 40, h: 40, rot: 0 } }),
    sample.rect(a, { frame: { x: 300, y: 500, w: 40, h: 40, rot: 0 } }),
    // on a page with /Rotate 90 the reader's x axis is the user-space y axis
    sample.rect(b, { frame: { x: 100, y: 150, w: 40, h: 40, rot: 90 } }),
    sample.rect(b, { frame: { x: 400, y: 600, w: 40, h: 40, rot: 90 } })
  ]);
  store.updateObjects(alignObjects(store.getState(), ids, "left"));
  const state = store.getState();
  const left = (id, pageIndex) => objectScreenBox(state.objects[id], state.pages[pageIndex])[0];
  close(left(ids[0], 0), 80, 1e-9);
  close(left(ids[1], 0), 80, 1e-9);
  close(left(ids[2], 1), 130, 1e-9);
  close(left(ids[3], 1), 130, 1e-9);
  assert.equal(state.objects[ids[3]].frame.x, 400, "only the reader's horizontal position changed");
});

test("clampFrameToPage and clampObjectToPage keep 8 pt of an object on its page", () => {
  assert.equal(MIN_VISIBLE_ON_PAGE, 8);
  for (const variant of PAGE_VARIANTS) {
    const page = makePage(variant, 90);
    const k = 1 / variant.userUnit;
    const [x0, y0, x1, y1] = variant.view;
    const inside = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: 40, h: 20, rot: 30 };
    assert.equal(clampFrameToPage(inside, page), inside, "a frame on the page comes back as it is");
    const far = clampFrameToPage({ ...inside, x: x1 + 5000, y: y0 - 5000 }, page);
    const bounds = frameBounds(far, variant.userUnit);
    close(x1 - bounds[0], 8 * k, 1e-9, `${variant.name}: 8 pt left of the right edge`);
    close(bounds[3] - y0, 8 * k, 1e-9, `${variant.name}: 8 pt above the bottom edge`);
    assert.equal(far.rot, 30);
    assert.equal(far.w, 40);
    close(x1 - frameBounds(clampFrameToPage({ ...inside, x: x1 + 5000 }, page, 20), variant.userUnit)[0], 20 * k, 1e-9, "another minimum");
    // an object smaller than the minimum stays on the page entirely
    const tiny = clampFrameToPage({ x: x0 - 300, y: y1 + 300, w: 4, h: 4, rot: 0 }, page);
    closeAll(frameBounds(tiny, variant.userUnit), [x0, y1 - 4 * k, x0 + 4 * k, y1], 1e-9, `${variant.name}: tiny object`);

    const line = clampObjectToPage({ type: "line", p1: [x0 - 100, y0 - 100], p2: [x0 - 50, y0 - 80], strokeWidth: 2 }, page);
    const lineBounds = objectBounds(line, variant.userUnit);
    close(lineBounds[2] - x0, 8 * k, 1e-9);
    close(lineBounds[3] - y0, 8 * k, 1e-9);
    close(line.p2[0] - line.p1[0], 50, 1e-9, "the line keeps its shape");
    const mark = clampObjectToPage({ type: "redact", rect: [x1 + 10, y1 + 10, x1 + 60, y1 + 30] }, page);
    close(x1 - mark.rect[0], 8 * k, 1e-9);
    const quads = { type: "highlight", mode: "text", quads: [[x0 + 10, y0 + 20, x0 + 60, y0 + 20, x0 + 60, y0 + 10, x0 + 10, y0 + 10]] };
    assert.equal(clampObjectToPage(quads, page), quads);
    assert.equal(clampObjectToPage({ type: "mystery" }, page).type, "mystery");
  }
});

test("validatePage and validateDocument name what is wrong", () => {
  const { store, pageIds } = openStore({ measure: null });
  const [rect, redact] = store.addObjects([sample.rect(pageIds[0]), sample.redact(pageIds[0])]);
  const state = store.getState();
  assert.deepEqual(validateDocument(state), []);
  assert.deepEqual(validatePage(state.pages[0], state.sources), []);
  assert.deepEqual(validatePage(null), ["not a page"]);
  assert.deepEqual(validatePage({ ...state.pages[0], view: [0, 0, 0, 5], rotation: 45, kind: "pdf", sourceIndex: 9 }, state.sources), ["view", "rotation", "sourceIndex out of range"]);
  assert.deepEqual(validatePage({ id: "p", kind: "blank", sourceId: "s", sourceIndex: null, view: [0, 0, 1, 1], baseRotation: 90, userUnit: 1, rotation: 0, objectIds: [] }), ["blank page with a source", "blank page geometry"]);
  assert.deepEqual(validatePage({ ...state.pages[0], sourceId: "ghost" }, state.sources), ["unknown source"]);

  const broken = (change) => {
    const copy = structuredClone(state);
    change(copy);
    return validateDocument(copy);
  };
  assert.ok(broken((copy) => copy.pages[1].objectIds.push(rect)).some((problem) => problem.includes("listed twice")));
  assert.ok(broken((copy) => copy.pages[0].objectIds.reverse()).some((problem) => problem.includes("marks stay below")), "a mark above an object");
  assert.ok(broken((copy) => delete copy.objects[redact]).some((problem) => problem.includes("unknown object")));
  assert.ok(broken((copy) => copy.pages[0].objectIds.pop()).some((problem) => problem.includes("on no page")));
  assert.ok(broken((copy) => (copy.objects[rect].pageId = pageIds[1])).some((problem) => problem.includes("pageId")));
  assert.ok(broken((copy) => (copy.objects[rect].frame.w = -3)).some((problem) => problem.includes("frame")));
  assert.ok(broken((copy) => (copy.objects[rect].frame.x = 99999)).some((problem) => problem.includes("outside its page")));
  assert.ok(broken((copy) => (copy.pages[1].id = pageIds[0])).some((problem) => problem.includes("duplicate id")));
  assert.ok(broken((copy) => (copy.fileName = 3)).includes("fileName"));
  assert.deepEqual(validateDocument(null), ["not a document"]);
});

test("geometry helpers of shapes.js", () => {
  close(distanceToSegment([5, 3], [0, 0], [10, 0]), 3);
  close(distanceToSegment([-4, 3], [0, 0], [10, 0]), 5);
  close(distanceToSegment([1, 1], [0, 0], [0, 0]), Math.SQRT2);
  close(distanceToPolyline([5, 5], [[0, 0], [10, 0], [10, 10]]), 5);
  assert.equal(distanceToPolyline([0, 0], []), Infinity);
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon([5, 5], square), true);
  assert.equal(pointInPolygon([5, 5], [...square].reverse()), true, "either winding");
  assert.equal(pointInPolygon([15, 5], square), false);
  assert.equal(polygonIntersectsRect([[20, 5], [30, 5]], [0, 0, 10, 10]), false);
  assert.equal(polygonIntersectsRect([[-5, 5], [30, 5]], [0, 0, 10, 10]), true);
  assert.equal(polygonIntersectsRect([[12, -2], [22, 8], [12, 18], [2, 8]], [0, 0, 3, 3]), false, "a diamond next to the corner");
  assert.equal(polygonIntersectsRect([[5, 5]], [0, 0, 10, 10]), true);

  // samples of a slow stroke, 0.25 pt apart, thinned to one per point of length
  const dense = [];
  for (let index = 0; index <= 400; index += 1) dense.push([index / 4, 0]);
  const thinned = thinPolyline(dense, 1);
  assert.equal(thinned.length, 101);
  assert.deepEqual([thinned[0], thinned[1], thinned.at(-1)], [[0, 0], [1, 0], [100, 0]]);
  for (let index = 1; index < thinned.length; index += 1) close(thinned[index][0] - thinned[index - 1][0], 1, 1e-9, "evenly spaced: a smooth curve through them follows the hand");
  assert.deepEqual(thinPolyline([[0, 0], [0, 0], [5, 5], [5, 5], [10, 0]]), [[0, 0], [5, 5], [10, 0]], "repeated points go, corners stay");
  assert.deepEqual(thinPolyline([[0, 0], [0.4, 0], [0.8, 0], [1.1, 0], [1.3, 0]]), [[0, 0], [1.1, 0], [1.3, 0]], "the stroke ends where the pointer was released");
  assert.deepEqual(thinPolyline([[1, 1], [1, 1]]), [[1, 1]], "a tap is one point");
  assert.deepEqual(thinPolyline([[1, 1], [1.2, 1]]), [[1, 1], [1.2, 1]]);
  assert.deepEqual(thinPolyline([[0, 0], [10, 0], [10, 10], [0, 0]]).length, 4, "a closed stroke keeps its shape");
  assert.deepEqual(thinPolyline([]), []);
  assert.equal(thinPolyline(dense, 0).length, 401, "spacing 0 keeps every distinct sample");

  assert.deepEqual(translatePatch({ quads: [[0, 0, 1, 0, 1, 1, 0, 1]] }, 2, 3), { quads: [[2, 3, 3, 3, 3, 4, 2, 4]] });
  assert.deepEqual(translatePatch({ p1: [0, 0], p2: [1, 1] }, 1, -1), { p1: [1, -1], p2: [2, 0] });
  assert.equal(translatePatch({ type: "nothing" }, 1, 1), null);
  assert.equal(isMovable(sample.highlightText("p")), false);
  assert.equal(isMovable(sample.highlightStroke("p")), true);
  assert.equal(isMovable({ rect: [0, 0, 1, 1] }), true);

  assert.equal(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(deepEqual([1, 2], { 0: 1, 1: 2 }), false);
  assert.equal(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  const frozen = deepFreeze({ list: [{ value: 1 }], bytes: new Uint8Array(2) });
  assert.ok(Object.isFrozen(frozen.list[0]));
  assert.ok(!Object.isFrozen(frozen.bytes), "typed arrays cannot be frozen and are left alone");
});

test("mapToPagePatch keeps the place and the look of an object on another page", () => {
  for (const from of PAGE_VARIANTS) {
    for (const to of PAGE_VARIANTS) {
      const fromPage = makePage(from, 90, "from");
      const toPage = makePage(to, 180, "to");
      const source = pageScreen(fromPage);
      const target = pageScreen(toPage);
      const frame = source.frameFromBox({ left: 40, top: 30, width: 60, height: 20 }, 15);
      const objects = [
        { type: "rect", frame, ...OBJECT_DEFAULTS.rect },
        { type: "line", p1: source.toUser([10, 10]), p2: source.toUser([60, 40]), ...OBJECT_DEFAULTS.line },
        { type: "redact", rect: source.rectToUser([20, 60, 90, 80]), color: "#000000" },
        { type: "highlight", mode: "text", quads: [[...source.toUser([5, 5]), ...source.toUser([50, 5]), ...source.toUser([50, 15]), ...source.toUser([5, 15])]], color: "#facc15" }
      ];
      for (const object of objects) {
        const moved = { ...object, ...mapToPagePatch(object, fromPage, toPage, [7, -3]) };
        const before = objectScreenBox(object, fromPage);
        closeAll(objectScreenBox(moved, toPage), [before[0] + 7, before[1] - 3, before[2] + 7, before[3] - 3], 1e-6, `${from.name} -> ${to.name}: ${object.type}`);
      }
      const movedFrame = mapToPagePatch(objects[0], fromPage, toPage).frame;
      close(target.screenRotation(movedFrame), 15, 1e-9, "the rotation on screen stays");
      assert.equal(movedFrame.w, 60, "sizes in points stay");
    }
  }
});
