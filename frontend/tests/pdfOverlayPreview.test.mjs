// The preview of a running gesture (src/pages/pdfEditor/overlay/preview.js) against what the gesture commits:
// the overlay draws the preview while the pointer is down, model/gestures.js runEffect changes the document
// on pointer-up. Both must give the same objects, or the page would jump when the button is released.
import test from "node:test";
import assert from "node:assert/strict";
import { runEffect } from "../src/pages/pdfEditor/model/gestures.js";
import { objectScreenBox } from "../src/pages/pdfEditor/model/shapes.js";
import { GHOST_ID, NO_PREVIEW, PREVIEW_ID, gesturePreview, previewTouches } from "../src/pages/pdfEditor/overlay/preview.js";
import { initialState, step } from "../src/pages/pdfEditor/tools/interaction.js";
import { bytesOf, closeAll, openStore, sample } from "./helpers/pdfModelKit.mjs";

const SCALE = 1.5;
const at = (x, y) => ({ x: x * SCALE, y: y * SCALE });

/** A stand-in for the overlay: reducer + store, with the preview taken just before the release. */
function session(store, context = {}) {
  let ui = initialState();
  const ctx = { objectType: (id) => store.getState().objects[id]?.type, objectExists: (id) => Boolean(store.getState().objects[id]) };
  const dispatch = (event) => {
    const result = step(ui, event, ctx);
    ui = result.state;
    for (const effect of result.effects) {
      const done = runEffect(store, effect, { scaleOf: () => SCALE, ...context });
      if (done.handled && done.created) ui = step(ui, { type: "created", ids: done.ids }, ctx).state;
    }
  };
  return {
    get ui() {
      return ui;
    },
    tool: (tool) => dispatch({ type: "tool", tool }),
    select: (ids) => dispatch({ type: "setSelection", ids }),
    down: (pageId, x, y, target, extra = {}) => dispatch({ type: "pointerdown", pageId, ...at(x, y), button: 0, pointerType: "mouse", target, ...extra }),
    move: (x, y, extra = {}) => dispatch({ type: "pointermove", ...at(x, y), ...extra }),
    up: (x, y, extra = {}) => dispatch({ type: "pointerup", ...at(x, y), ...extra }),
    preview: (options = {}) => gesturePreview(store.getState(), ui, { scale: SCALE, ...options })
  };
}

const geometryOf = (object) => object.frame || object.rect || [object.p1, object.p2];

test("no gesture, no preview", () => {
  const { store } = openStore();
  assert.equal(gesturePreview(store.getState(), initialState(), { scale: 1 }), NO_PREVIEW);
  assert.equal(gesturePreview(null, initialState()), NO_PREVIEW);
  assert.equal(previewTouches(NO_PREVIEW, store.getState(), "p"), false);
});

test("moving: the preview shows the objects where the release puts them, also with Shift (one axis)", () => {
  for (const shift of [false, true]) {
    const { store, pageIds } = openStore({ pages: [{ rotate: 90 }, {}] });
    const [rectId, lineId] = store.addObjects([sample.rect(pageIds[0]), sample.line(pageIds[0])]);
    const run = session(store);
    run.select([rectId, lineId]);
    run.down(pageIds[0], 100, 100, { kind: "object", id: rectId, type: "rect" });
    run.move(140, 115, { shift });
    const preview = run.preview();
    assert.equal(run.ui.mode, "moving");
    assert.deepEqual([...preview.patched.keys()].sort(), [rectId, lineId].sort());
    assert.equal(previewTouches(preview, store.getState(), pageIds[0]), true);
    assert.equal(previewTouches(preview, store.getState(), pageIds[1]), false);
    const shown = Object.fromEntries([...preview.patched].map(([id, object]) => [id, geometryOf(object)]));
    run.up(140, 115);
    for (const id of [rectId, lineId]) assert.deepEqual(geometryOf(store.getState().objects[id]), shown[id], `the document has what the preview showed (shift ${shift})`);
    const moved = objectScreenBox(store.getState().objects[rectId], store.getState().pages[0]);
    const before = objectScreenBox({ ...sample.rect(pageIds[0]) }, store.getState().pages[0]);
    closeAll([moved[0] - before[0], moved[1] - before[1]], shift ? [40, 0] : [40, 15], 1e-6, "moved by the drag as seen on screen");
  }
});

test("an Alt-drag previews copies and leaves the originals where they are", () => {
  const { store, pageIds } = openStore();
  const [rectId] = store.addObjects([sample.rect(pageIds[0])]);
  const original = store.getState().objects[rectId];
  const run = session(store);
  run.down(pageIds[0], 100, 100, { kind: "object", id: rectId, type: "rect" }, { alt: true });
  run.move(160, 130);
  const preview = run.preview();
  assert.equal(preview.patched.size, 0, "the original is not moved");
  const [copy] = preview.extras.get(pageIds[0]);
  assert.ok(copy.id.startsWith("$"), "a preview copy has a pseudo id");
  run.up(160, 130);
  const objects = store.getState().pages[0].objectIds.map((id) => store.getState().objects[id]);
  assert.equal(objects.length, 2);
  assert.deepEqual(store.getState().objects[rectId].frame, original.frame);
  assert.deepEqual(objects.find((object) => object.id !== rectId).frame, copy.frame, "the copy lands where its preview was");
});

test("a move that ends over another page: the object leaves its page in the preview and arrives where the document will have it", () => {
  const { store, pageIds } = openStore({ pages: [{}, { rotate: 90 }] });
  const [rectId] = store.addObjects([sample.rect(pageIds[0])]);
  const run = session(store);
  run.down(pageIds[0], 100, 100, { kind: "object", id: rectId, type: "rect" });
  run.move(120, 400, { over: { pageId: pageIds[1], ...at(200, 50) } });
  const preview = run.preview();
  assert.ok(preview.hidden.has(rectId));
  assert.equal(previewTouches(preview, store.getState(), pageIds[0]), true);
  assert.equal(previewTouches(preview, store.getState(), pageIds[1]), true);
  const [arriving] = preview.extras.get(pageIds[1]);
  assert.equal(arriving.pageId, pageIds[1]);
  run.up(120, 400, { over: { pageId: pageIds[1], ...at(200, 50) } });
  const landed = store.getState().objects[rectId];
  assert.equal(landed.pageId, pageIds[1]);
  assert.deepEqual(landed.frame, arriving.frame);
});

test("resizing and rotating preview exactly the patch of the release", () => {
  const { store, pageIds } = openStore({ pages: [{ rotate: 270, userUnit: 2, view: [50, 10, 350, 410] }] });
  const [rectId] = store.addObjects([{ ...sample.rect(pageIds[0]), frame: { x: 200, y: 200, w: 120, h: 80, rot: 270 } }]);
  const run = session(store);
  run.select([rectId]);
  run.down(pageIds[0], 300, 300, { kind: "handle", id: rectId, handle: "se" });
  run.move(330, 320, { shift: true });
  let preview = run.preview();
  assert.equal(run.ui.mode, "resizing");
  let shown = preview.patched.get(rectId).frame;
  run.up(330, 320);
  assert.deepEqual(store.getState().objects[rectId].frame, shown);
  assert.ok(Math.abs(shown.w / shown.h - 1.5) < 1e-9, "Shift keeps the proportions of a shape");

  run.down(pageIds[0], 300, 200, { kind: "rotate", id: rectId });
  run.move(350, 260, { shift: true });
  preview = run.preview();
  assert.equal(run.ui.mode, "rotating");
  shown = preview.patched.get(rectId).frame;
  run.up(350, 260);
  assert.deepEqual(store.getState().objects[rectId].frame, shown);
  assert.equal(Math.round(shown.rot * 1000) % 15000, 0, "Shift turns in steps of 15 degrees");
});

test("a resized text box asks the measurer for its height in the preview, as the store does on release", () => {
  const { store, pageIds } = openStore();
  const [textId] = store.addObjects([sample.text(pageIds[0], { text: "một hai ba bốn năm sáu bảy tám chín mười", autoWidth: true })]);
  const run = session(store);
  run.select([textId]);
  run.down(pageIds[0], 300, 200, { kind: "handle", id: textId, handle: "e" });
  run.move(220, 200);
  const calls = [];
  const preview = run.preview({
    textFrame: (object) => {
      calls.push(object.frame.w);
      return { ...object.frame, h: 99 };
    }
  });
  const shown = preview.patched.get(textId);
  assert.equal(shown.autoWidth, false, "a dragged side handle fixes the wrap width");
  assert.equal(calls.length, 1);
  assert.equal(shown.frame.h, 99, "the height comes from the text");
  assert.ok(shown.frame.w < store.getState().objects[textId].frame.w);
});

test("drawing: the preview is the object the release creates (shapes, lines, marks, strokes)", () => {
  for (const tool of ["rect", "ellipse", "line", "arrow", "redact", "blur"]) {
    const { store, pageIds } = openStore({ pages: [{ rotate: 180 }] });
    const style = tool === "rect" ? { stroke: "#16a34a", strokeWidth: 3 } : {};
    const run = session(store, { style });
    run.tool(tool);
    run.down(pageIds[0], 100, 100, { kind: "page" });
    run.move(102, 101);
    assert.equal(run.preview({ styleOf: () => style }).extras.size, 0, `${tool}: nothing is shown before the drag threshold`);
    run.move(220, 170, { shift: tool === "rect" });
    const preview = run.preview({ styleOf: () => style });
    const [shown] = preview.extras.get(pageIds[0]);
    assert.equal(shown.id, PREVIEW_ID);
    run.up(220, 170);
    const [created] = Object.values(store.getState().objects);
    const { id: previewId, ...expected } = shown;
    const { id: realId, seed, ...actual } = created;
    assert.ok(previewId && realId);
    assert.deepEqual(actual, expected, `${tool}: created what was previewed`);
    if (tool === "blur") assert.match(seed, /^[0-9a-f]{32}$/);
  }
  // a pen stroke grows with every move
  const { store, pageIds } = openStore();
  const run = session(store);
  run.tool("pen");
  run.down(pageIds[0], 50, 50, { kind: "page" });
  run.move(60, 70);
  run.move(90, 60);
  const [stroke] = run.preview().extras.get(pageIds[0]);
  assert.equal(stroke.type, "pen");
  assert.ok(stroke.points.length >= 3);
});

test("a drag that began on document text previews the marked stretch instead of a rectangle or a stroke", () => {
  const { store, pageIds } = openStore();
  const quads = [[10, 20, 30, 20, 30, 10, 10, 10]];
  for (const tool of ["redact", "highlighter"]) {
    const run = session(store);
    run.tool(tool);
    run.down(pageIds[0], 100, 100, { kind: "textline", id: 0 });
    run.move(200, 104);
    const asked = [];
    const preview = run.preview({
      textQuads: (pageId, from, to) => {
        asked.push([pageId, from, to]);
        return quads;
      }
    });
    assert.deepEqual(preview.textMark, { pageId: pageIds[0], tool, quads });
    assert.equal(preview.extras.size, 0);
    assert.deepEqual(asked[0], [pageIds[0], at(100, 100), at(200, 104)]);
    assert.equal(previewTouches(preview, store.getState(), pageIds[0]), true);
  }
});

test("the Text tool previews the box a drag will wrap in; the selection rectangle and the eraser have their own entries", () => {
  const { store, pageIds } = openStore();
  const [rectId] = store.addObjects([sample.rect(pageIds[0])]);
  let run = session(store);
  run.tool("text");
  run.down(pageIds[0], 100, 100, { kind: "page" });
  run.move(260, 110);
  let preview = run.preview();
  assert.equal(preview.textArea.pageId, pageIds[0]);
  assert.ok(Math.abs(preview.textArea.frame.w - 160) < 1e-6, "as wide as the drag");
  assert.equal(preview.extras.size, 0);

  run = session(store);
  run.down(pageIds[0], 20, 20, { kind: "page" });
  run.move(120, 90);
  preview = run.preview();
  assert.deepEqual(preview.marquee, { pageId: pageIds[0], rect: { x: 30, y: 30, width: 150, height: 105 } });

  run = session(store);
  run.tool("eraser");
  run.down(pageIds[0], 20, 20, { kind: "object", id: rectId, type: "rect" });
  preview = run.preview();
  assert.deepEqual([...preview.erased], [rectId]);
  assert.equal(previewTouches(preview, store.getState(), pageIds[0]), true);
});

test("placing a picture: the ghost is the picture a click or a drag would put there", () => {
  const { store, pageIds } = openStore();
  const assetId = store.addAsset({ mime: "image/png", width: 160, height: 100 }, bytesOf(40, 3));
  const run = session(store);
  run.tool("image");
  let state = step(run.ui, { type: "placeReady", payload: assetId }).state;
  assert.equal(gesturePreview(store.getState(), state, { scale: SCALE }).extras.size, 0, "no ghost before the pointer is over a page");
  state = step(state, { type: "pointermove", ...at(200, 200), pageId: pageIds[0] }).state;
  const [ghost] = gesturePreview(store.getState(), state, { scale: SCALE }).extras.get(pageIds[0]);
  assert.equal(ghost.id, GHOST_ID);
  assert.equal(ghost.type, "image");
  closeAll([ghost.frame.w, ghost.frame.h], [120, 75], 1e-9, "its size at 96 dpi");
  closeAll(objectScreenBox(ghost, store.getState().pages[0]), [140, 162.5, 260, 237.5], 1e-6, "centred on the pointer");
  // pressed and dragged: the size of the drag, proportions kept
  state = step(state, { type: "pointerdown", pageId: pageIds[0], ...at(200, 200), button: 0, pointerType: "mouse", target: { kind: "page" } }).state;
  state = step(state, { type: "pointermove", ...at(360, 230) }).state;
  const [stretched] = gesturePreview(store.getState(), state, { scale: SCALE }).extras.get(pageIds[0]);
  assert.ok(Math.abs(stretched.frame.w / stretched.frame.h - 1.6) < 1e-9);
  closeAll([stretched.frame.w], [160], 1e-6);
});
