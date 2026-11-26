// The rectangle of a visible certificate signature (signing/fieldGeometry.js): from the reducer's effects and
// running gestures to a user-space rectangle that the signing engine takes as it is.
import test from "node:test";
import assert from "node:assert/strict";
import { PAGE_SIZES } from "../src/pages/pdfEditor/engine/geometry.js";
import {
  FIELD_DEFAULT_SIZE,
  FIELD_MIN_SIZE,
  PRESET_MARGIN,
  clampBoxToPage,
  fieldAfterMove,
  fieldAfterResize,
  fieldForEngine,
  fieldFromBox,
  fieldFromCreateEffect,
  fieldMillimetres,
  fieldScreenBox,
  fieldWithMillimetres,
  liveField,
  presetField
} from "../src/pages/pdfEditor/signing/fieldGeometry.js";
import { SIGNATURE_FIELD_ID, initialState, step } from "../src/pages/pdfEditor/tools/interaction.js";

const [A4W, A4H] = PAGE_SIZES.A4;
const page = (id, patch = {}) => ({ id, kind: "blank", sourceId: null, sourceIndex: null, view: [0, 0, A4W, A4H], baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [], ...patch });
const near = (actual, expected, tolerance = 0.01) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
const boxIs = (box, expected, tolerance = 0.01) => {
  for (const key of ["left", "top", "width", "height"]) near(box[key], expected[key], tolerance);
};
const scaleOf = () => 2; // CSS pixels per point

test("field: a dragged rectangle becomes user space of the page (y up), a click the default size", () => {
  const p = page("p1");
  const dragged = fieldFromCreateEffect({ type: "create", tool: "certSign", pageId: "p1", from: { x: 200, y: 300 }, to: { x: 600, y: 460 } }, p, 2);
  assert.equal(dragged.pageId, "p1");
  boxIs(fieldScreenBox(dragged, p), { left: 100, top: 150, width: 200, height: 80 });
  // user space: the same box measured from the BOTTOM of the page
  near(dragged.rect[0], 100);
  near(dragged.rect[2], 300);
  near(dragged.rect[1], A4H - 230);
  near(dragged.rect[3], A4H - 150);

  const clicked = fieldFromCreateEffect({ type: "create", tool: "certSign", pageId: "p1", at: { x: 400, y: 400 } }, p, 2);
  const box = fieldScreenBox(clicked, p);
  near(box.width, FIELD_DEFAULT_SIZE[0]);
  near(box.height, FIELD_DEFAULT_SIZE[1]);
  near(box.left + box.width / 2, 200);
  near(box.top + box.height / 2, 200);
});

test("field: never smaller than 72 x 36 pt, never outside the page", () => {
  const p = page("p1");
  const tiny = fieldFromCreateEffect({ from: { x: 100, y: 100 }, to: { x: 110, y: 104 } }, p, 1);
  boxIs(fieldScreenBox(tiny, p), { left: 100, top: 100, width: FIELD_MIN_SIZE[0], height: FIELD_MIN_SIZE[1] });
  // dragged over the bottom-right corner of the page: moved back in
  const outside = fieldFromBox(p, { left: A4W - 20, top: A4H - 10, width: 100, height: 50 });
  boxIs(fieldScreenBox(outside, p), { left: A4W - 100, top: A4H - 50, width: 100, height: 50 });
  // larger than the page: the page
  boxIs(clampBoxToPage({ left: -50, top: -50, width: 5000, height: 5000 }, p), { left: 0, top: 0, width: A4W, height: A4H }, 0.01);
});

test("field: the reducer's move and resize effects, with the gesture maths of the model", () => {
  const p = page("p1");
  const pages = [p];
  const start = fieldFromBox(p, { left: 100, top: 100, width: 200, height: 80 });
  const moved = fieldAfterMove(start, { ids: [SIGNATURE_FIELD_ID], pageId: "p1", from: { x: 300, y: 300 }, dx: 40, dy: -20 }, { pages, scaleOf });
  boxIs(fieldScreenBox(moved, p), { left: 120, top: 90, width: 200, height: 80 });
  // Shift: only the larger component counts
  const locked = fieldAfterMove(start, { from: { x: 300, y: 300 }, dx: 40, dy: -20, axisLock: true }, { pages, scaleOf });
  boxIs(fieldScreenBox(locked, p), { left: 120, top: 100, width: 200, height: 80 });
  // a move never leaves the page
  const pushed = fieldAfterMove(start, { from: { x: 300, y: 300 }, dx: -9000, dy: 9000 }, { pages, scaleOf });
  boxIs(fieldScreenBox(pushed, p), { left: 0, top: A4H - 80, width: 200, height: 80 });

  const grown = fieldAfterResize(start, { id: SIGNATURE_FIELD_ID, handle: "se", dx: 80, dy: 40 }, p, 2);
  boxIs(fieldScreenBox(grown, p), { left: 100, top: 100, width: 240, height: 100 });
  const fromTopLeft = fieldAfterResize(start, { handle: "nw", dx: -40, dy: -20 }, p, 2);
  boxIs(fieldScreenBox(fromTopLeft, p), { left: 80, top: 90, width: 220, height: 90 });
  const edge = fieldAfterResize(start, { handle: "e", dx: 100, dy: 999 }, p, 2);
  boxIs(fieldScreenBox(edge, p), { left: 100, top: 100, width: 250, height: 80 });
  // the minimum holds while the opposite corner stays where it is
  const squeezed = fieldAfterResize(start, { handle: "se", dx: -9000, dy: -9000 }, p, 2);
  boxIs(fieldScreenBox(squeezed, p), { left: 100, top: 100, width: FIELD_MIN_SIZE[0], height: FIELD_MIN_SIZE[1] });
  // a handle dragged over the edge of the page stops at the edge
  const clipped = fieldAfterResize(start, { handle: "se", dx: 9000, dy: 9000 }, p, 2);
  boxIs(fieldScreenBox(clipped, p), { left: 100, top: 100, width: A4W - 100, height: A4H - 100 });
});

test("field: a move that ends over another page keeps the distance to the pointer", () => {
  const first = page("p1");
  const second = page("p2", { view: [0, 0, 400, 300] });
  const start = fieldFromBox(first, { left: 100, top: 100, width: 180, height: 60 });
  // pressed 20 pt right and 10 pt below the corner of the rectangle (scale 2), released at (150, 120) pt of page 2
  const dropped = fieldAfterMove(start, { from: { x: 240, y: 220 }, dx: 0, dy: 0, drop: { pageId: "p2", x: 300, y: 240 } }, { pages: [first, second], scaleOf });
  assert.equal(dropped.pageId, "p2");
  boxIs(fieldScreenBox(dropped, second), { left: 130, top: 110, width: 180, height: 60 });
});

test("field: pages that are turned (/Rotate and the user's own rotation) keep the rectangle upright for the reader", () => {
  for (const [baseRotation, rotation] of [[90, 0], [0, 90], [180, 0], [270, 90], [90, 270]]) {
    const p = page("p", { baseRotation, rotation, view: [0, 0, 400, 300] });
    const total = (baseRotation + rotation) % 360;
    const visible = total === 90 || total === 270 ? [300, 400] : [400, 300];
    const field = fieldFromBox(p, { left: 20, top: 30, width: 180, height: 60 });
    boxIs(fieldScreenBox(field, p), { left: 20, top: 30, width: 180, height: 60 });
    // the user-space rectangle is on the unrotated page: its size swaps on a quarter turn
    const [x0, y0, x1, y1] = field.rect;
    const size = total === 90 || total === 270 ? [60, 180] : [180, 60];
    near(x1 - x0, size[0]);
    near(y1 - y0, size[1]);
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= 400 && y1 <= 300, `inside the page box: ${field.rect}`);
    // bottom right as the reader sees it
    const preset = presetField(p, "bottomRight");
    const box = fieldScreenBox(preset, p);
    near(box.left + box.width, visible[0] - PRESET_MARGIN);
    near(box.top + box.height, visible[1] - PRESET_MARGIN);
    // a handle moves the edge the reader sees
    const grown = fieldAfterResize(field, { handle: "e", dx: 10, dy: 0 }, p, 1);
    boxIs(fieldScreenBox(grown, p), { left: 20, top: 30, width: 190, height: 60 });
  }
});

test("field: a shifted page box and /UserUnit", () => {
  const p = page("p", { view: [100, 50, 500, 350], userUnit: 2 });
  // the page is 800 x 600 pt for the reader
  const field = fieldFromBox(p, { left: 100, top: 100, width: 200, height: 80 });
  boxIs(fieldScreenBox(field, p), { left: 100, top: 100, width: 200, height: 80 });
  // user space: units of 2 pt, origin outside the box
  near(field.rect[0], 150);
  near(field.rect[2], 250);
  near(field.rect[3], 350 - 50);
  near(field.rect[1], 350 - 90);
});

test("field: presets, millimetres, and what the engine gets", () => {
  const p = page("p1");
  const pages = [page("p0"), p];
  const right = presetField(p, "bottomRight");
  boxIs(fieldScreenBox(right, p), { left: A4W - PRESET_MARGIN - 180, top: A4H - PRESET_MARGIN - 60, width: 180, height: 60 });
  const left = presetField(p, "bottomLeft", [200, 80]);
  boxIs(fieldScreenBox(left, p), { left: PRESET_MARGIN, top: A4H - PRESET_MARGIN - 80, width: 200, height: 80 });
  const top = presetField(p, "topRight");
  boxIs(fieldScreenBox(top, p), { left: A4W - PRESET_MARGIN - 180, top: PRESET_MARGIN, width: 180, height: 60 });

  const numbers = fieldMillimetres(right, p);
  near(numbers.width, 63.5, 0.05);
  near(numbers.height, 21.2, 0.05);
  const typed = fieldWithMillimetres(right, p, { left: 20, width: 100 });
  const box = fieldScreenBox(typed, p);
  near(box.left, (20 * 72) / 25.4, 0.01);
  near(box.width, (100 * 72) / 25.4, 0.01);
  near(box.height, 60);
  // nonsense in a field changes nothing
  boxIs(fieldScreenBox(fieldWithMillimetres(right, p, { left: "abc" }), p), fieldScreenBox(right, p));

  const engine = fieldForEngine(right, pages);
  assert.equal(engine.pageIndex, 1);
  assert.ok(engine.rect[0] < engine.rect[2] && engine.rect[1] < engine.rect[3]);
  assert.equal(fieldForEngine(right, [page("other")]), null, "the page is gone");
  assert.equal(fieldForEngine(null, pages), null);
});

test("field: driven by the interaction reducer (certSign tool, pseudo object)", () => {
  const p = page("p1");
  const pages = [p];
  const ctx = { objectExists: (id) => id === SIGNATURE_FIELD_ID, objectType: () => "signatureField" };
  let state = step(initialState(), { type: "tool", tool: "certSign" }, ctx).state;
  let field = null;
  const send = (event) => {
    const result = step(state, event, ctx);
    state = result.state;
    for (const effect of result.effects) {
      if (effect.type === "create" && effect.tool === "certSign") field = fieldFromCreateEffect(effect, p, 2);
      else if (effect.type === "move" && effect.ids.includes(SIGNATURE_FIELD_ID)) field = fieldAfterMove(field, effect, { pages, scaleOf });
      else if (effect.type === "resize" && effect.id === SIGNATURE_FIELD_ID) field = fieldAfterResize(field, effect, p, 2);
    }
    return result;
  };
  // draw
  send({ type: "pointerdown", pageId: "p1", x: 200, y: 200, target: { kind: "page" } });
  send({ type: "pointermove", x: 400, y: 300 });
  boxIs(fieldScreenBox(liveField(null, state, { pages, scaleOf }), p), { left: 100, top: 100, width: 100, height: 50 });
  send({ type: "pointerup", x: 600, y: 360 });
  boxIs(fieldScreenBox(field, p), { left: 100, top: 100, width: 200, height: 80 });
  assert.equal(state.tool, "select");
  assert.deepEqual(state.selection, [SIGNATURE_FIELD_ID]);
  // move by the body: the preview while dragging is what the release gives
  send({ type: "pointerdown", pageId: "p1", x: 300, y: 250, target: { kind: "object", id: SIGNATURE_FIELD_ID, type: "signatureField" } });
  send({ type: "pointermove", x: 340, y: 290 });
  const preview = liveField(field, state, { pages, scaleOf });
  send({ type: "pointerup", x: 340, y: 290 });
  assert.deepEqual(field, preview);
  boxIs(fieldScreenBox(field, p), { left: 120, top: 120, width: 200, height: 80 });
  // resize by a handle
  send({ type: "pointerdown", pageId: "p1", x: 640, y: 400, target: { kind: "handle", id: SIGNATURE_FIELD_ID, handle: "se" } });
  send({ type: "pointermove", x: 700, y: 440 });
  const resizing = liveField(field, state, { pages, scaleOf });
  send({ type: "pointerup", x: 700, y: 440 });
  assert.deepEqual(field, resizing);
  boxIs(fieldScreenBox(field, p), { left: 120, top: 120, width: 230, height: 100 });
  // Escape in the middle of a gesture changes nothing
  send({ type: "pointerdown", pageId: "p1", x: 300, y: 300, target: { kind: "object", id: SIGNATURE_FIELD_ID, type: "signatureField" } });
  send({ type: "pointermove", x: 500, y: 500 });
  send({ type: "key", key: "Escape" });
  assert.equal(state.mode, "idle");
  boxIs(fieldScreenBox(liveField(field, state, { pages, scaleOf }), p), { left: 120, top: 120, width: 230, height: 100 });
});
