// The whole chain of an edit: pointer events -> interaction reducer -> runEffect -> document store
// (src/pages/pdfEditor/model/gestures.js), and the model fed with the facts of the real viewer (pdf.js).
import test from "node:test";
import assert from "node:assert/strict";
import { buildExportJob } from "../src/pages/pdfEditor/model/exportJob.js";
import { runEffect } from "../src/pages/pdfEditor/model/gestures.js";
import { objectAtPoint, validateDocument } from "../src/pages/pdfEditor/model/selectors.js";
import { objectScreenBox, pageScreen } from "../src/pages/pdfEditor/model/shapes.js";
import { createEditorStore } from "../src/pages/pdfEditor/model/store.js";
import { createFromEffect, createMark, createTextHighlight, screenRotationOf } from "../src/pages/pdfEditor/model/transform.js";
import { NEW_ID, SIGNATURE_FIELD_ID, initialState, step } from "../src/pages/pdfEditor/tools/interaction.js";
import { bytesOf, close, closeAll, fakeLayout, fakeMeasure, openStore } from "./helpers/pdfModelKit.mjs";
import { VIETNAMESE_SAMPLE, makeTextPdf, pageItems, withPdf } from "./helpers/pdfTestKit.mjs";

/** A tiny stand-in for the overlay: it feeds events to the reducer and runs the effects against the store. */
function session(store, scale) {
  let ui = initialState();
  const ctx = { objectType: (id) => store.getState().objects[id]?.type, objectExists: (id) => Boolean(store.getState().objects[id]) };
  const dispatch = (event, context = {}) => {
    const result = step(ui, event, ctx);
    ui = result.state;
    const leftovers = [];
    for (const effect of result.effects) {
      const done = runEffect(store, effect, { scaleOf: () => scale, ...context });
      if (!done.handled) leftovers.push(effect);
      else if (done.created) ui = step(ui, { type: "created", ids: done.ids }, ctx).state;
    }
    return leftovers;
  };
  const at = (x, y) => ({ x: x * scale, y: y * scale });
  return {
    get ui() {
      return ui;
    },
    dispatch,
    down: (pageId, x, y, target, extra) => dispatch({ type: "pointerdown", pageId, ...at(x, y), button: 0, pointerType: "mouse", target, ...extra }),
    move: (x, y, extra) => dispatch({ type: "pointermove", ...at(x, y), ...extra }),
    up: (x, y, extra, context) => dispatch({ type: "pointerup", ...at(x, y), ...extra }, context),
    over: (pageId, x, y) => ({ over: { pageId, ...at(x, y) } }),
    sync: () => dispatch({ type: "documentChanged" })
  };
}

test("an editing session: every gesture is one undo step and lands where the reader put it", () => {
  const scale = 1.5;
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800], rotate: 90 }, { view: [0, 0, 600, 800] }], measure: fakeMeasure });
  const [a, b] = pageIds;
  const s = session(store, scale);
  const page = (id) => store.getState().pages.find((candidate) => candidate.id === id);
  const box = (id) => objectScreenBox(store.getState().objects[id], page(store.getState().objects[id].pageId));
  const steps = () => store.getHistoryState().undoDepth;
  const target = (id) => ({ kind: "object", id, type: store.getState().objects[id].type });
  const blank = { kind: "page" };
  const consistent = () => assert.deepEqual(validateDocument(store.getState()), []);

  // a rectangle, drawn with the one-shot tool
  s.dispatch({ type: "tool", tool: "rect" });
  s.down(a, 50, 60, blank);
  s.move(170, 100);
  s.up(170, 100, {}, { style: { stroke: "#2563EB" } });
  const [rect] = s.ui.selection;
  assert.notEqual(rect, NEW_ID);
  assert.equal(s.ui.tool, "select");
  closeAll(box(rect), [50, 60, 170, 100], 1e-9, "the rectangle is where it was dragged, on a page with /Rotate 90 at zoom 150 %");
  assert.equal(store.getState().objects[rect].stroke, "#2563eb");
  assert.equal(screenRotationOf(store.getState().objects[rect], page(a)), 0);
  assert.equal(steps(), 1);

  // move it
  s.down(a, 100, 80, target(rect));
  s.move(130, 100);
  s.up(130, 100);
  closeAll(box(rect), [80, 80, 200, 120], 1e-9);
  assert.equal(steps(), 2);

  // Alt-drag a copy: one step for "duplicate and move"
  s.down(a, 100, 100, target(rect), { alt: true });
  s.move(100, 200);
  s.up(100, 200);
  const [copy] = s.ui.selection;
  assert.notEqual(copy, rect);
  closeAll(box(copy), [80, 180, 200, 220], 1e-9);
  closeAll(box(rect), [80, 80, 200, 120], 1e-9, "the original stays");
  assert.equal(steps(), 3);
  store.undo();
  assert.equal(Object.keys(store.getState().objects).length, 1, "one undo removes the moved copy");
  s.sync();
  assert.deepEqual(s.ui.selection, [], "the selection follows the document");
  store.redo();

  // resize by a handle, rotate with snapping
  s.dispatch({ type: "setSelection", ids: [copy] });
  s.down(a, 200, 220, { kind: "handle", id: copy, handle: "se" });
  s.up(230, 250);
  closeAll(box(copy), [80, 180, 230, 250], 1e-9);
  s.down(a, 155, 150, { kind: "rotate", id: copy });
  s.move(200, 180, { shift: true });
  s.up(215, 208);
  close(screenRotationOf(store.getState().objects[copy], page(a)) % 15, 0, 1e-9, "Shift snaps the rotation");
  assert.ok(screenRotationOf(store.getState().objects[copy], page(a)) > 0);
  assert.equal(steps(), 5);

  // a redaction: sticky tool, selected at once, removed with Delete
  s.dispatch({ type: "tool", tool: "redact" });
  s.down(a, 300, 300, blank);
  s.move(420, 330);
  s.up(420, 330);
  const [mark] = s.ui.selection;
  assert.equal(store.getState().objects[mark].type, "redact");
  assert.equal(s.ui.tool, "redact");
  assert.equal(page(a).objectIds[0], mark, "below everything else");
  closeAll(pageScreen(page(a)).rectToScreen(store.getState().objects[mark].rect), [300, 300, 420, 330], 1e-9);
  s.dispatch({ type: "key", key: "Delete", phase: "down" });
  assert.equal(store.getState().objects[mark], undefined);
  assert.equal(steps(), 7);

  // a pen stroke, erased again: the eraser deletes in one step
  s.dispatch({ type: "tool", tool: "pen" });
  s.down(a, 300, 400, blank);
  s.move(350, 400);
  s.move(350, 450);
  s.up(350, 450, {}, { style: { width: 3 } });
  const stroke = page(a).objectIds.at(-1);
  assert.deepEqual([store.getState().objects[stroke].type, store.getState().objects[stroke].width], ["pen", 3]);
  assert.deepEqual(s.ui.selection, []);
  s.dispatch({ type: "tool", tool: "eraser" });
  const previews = s.down(a, 320, 400, target(stroke));
  assert.deepEqual(previews, [{ type: "erase", id: stroke }], "the preview is the overlay's business");
  assert.ok(store.getState().objects[stroke], "nothing is deleted before the release");
  s.up(330, 400);
  assert.equal(store.getState().objects[stroke], undefined);
  assert.equal(steps(), 9);

  // a picture: picker, then a click places it; the asset is found through the payload
  const assetId = store.addAsset({ mime: "image/png", width: 200, height: 100 }, bytesOf(40, 4));
  assert.deepEqual(s.dispatch({ type: "tool", tool: "image" }), [{ type: "openPicker", tool: "image" }]);
  s.dispatch({ type: "placeReady", payload: { assetId } });
  s.down(a, 400, 300, blank);
  s.up(400, 300);
  const [image] = s.ui.selection;
  assert.equal(store.getState().objects[image].assetId, assetId);
  closeAll(box(image), [325, 262.5, 475, 337.5], 1e-9, "150 x 75 pt (96 dpi) centred on the click");
  assert.equal(steps(), 10);

  // drag it onto the second page: it keeps its distance to the pointer
  s.down(a, 400, 300, target(image));
  s.move(400, 500);
  s.up(400, 700, s.over(b, 250, 120));
  assert.equal(store.getState().objects[image].pageId, b);
  closeAll(box(image), [175, 82.5, 325, 157.5], 1e-9, "the pointer still holds its middle");
  assert.equal(store.getState().objects[image].frame.rot, 0, "upright on the page without /Rotate");
  assert.equal(steps(), 11);

  // text: the reducer asks for a draft; the overlay adds the object when the editor commits
  s.dispatch({ type: "tool", tool: "text" });
  s.down(b, 100, 300, blank);
  const [draft] = s.up(100, 300);
  assert.deepEqual([draft.type, draft.tool, draft.autoWidth], ["create", "text", true]);
  assert.equal(s.ui.mode, "editingText");
  assert.equal(steps(), 11, "typing has not touched the document yet");
  const [commit] = s.dispatch({ type: "key", key: "Escape", phase: "down" });
  assert.deepEqual(commit, { type: "commitEdit", id: NEW_ID });
  const [text] = store.addObjects([createFromEffect(draft, page(b), scale, { content: "Đã thanh toán" })]);
  s.dispatch({ type: "created", ids: [text] });
  assert.deepEqual(s.ui.selection, [text]);
  closeAll(box(text).slice(0, 2), [100, 300 - 7.2], 1e-9);
  close(box(text)[2] - box(text)[0], 13 * 6, 1e-9, "measured by the store");
  assert.equal(steps(), 12, "a text editing session is one step");

  // what is not the store's business comes back unhandled
  assert.deepEqual(runEffect(store, { type: "pan", dx: 1, dy: 1 }), { handled: false, created: false, ids: [] });
  assert.equal(runEffect(store, { type: "move", ids: [SIGNATURE_FIELD_ID], pageId: a, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, dx: 1, dy: 1 }).handled, false);
  assert.equal(runEffect(store, { type: "resize", id: SIGNATURE_FIELD_ID, handle: "se", dx: 1, dy: 1 }).handled, false);
  assert.equal(runEffect(store, { type: "delete", ids: [SIGNATURE_FIELD_ID] }).handled, false);
  assert.equal(runEffect(store, { type: "create", tool: "certSign", pageId: a, at: { x: 1, y: 1 } }).handled, false);
  assert.equal(runEffect(store, null).handled, false);
  assert.deepEqual(runEffect(store, { type: "move", ids: ["ghost"], pageId: a, dx: 5, dy: 5 }), { handled: true, created: false, ids: [] });
  assert.deepEqual(runEffect(store, { type: "resize", id: "ghost", handle: "se", dx: 5, dy: 5 }).ids, []);
  // a creation that makes nothing still answers "created", so that the placeholder id leaves the selection
  assert.deepEqual(runEffect(store, { type: "create", tool: "rect", pageId: "ghost", at: { x: 1, y: 1 } }), { handled: true, created: true, ids: [] });
  assert.deepEqual(runEffect(store, { type: "create", tool: "image", pageId: a, at: { x: 1, y: 1 }, payload: "no-such-asset" }), { handled: true, created: true, ids: [] });
  assert.deepEqual(runEffect(store, { type: "move", ids: ["ghost"], pageId: a, dx: 5, dy: 5, duplicate: true }), { handled: true, created: true, ids: [] });
  assert.equal(steps(), 12);
  consistent();

  // everything can be undone, back to the untouched file
  while (store.undo());
  assert.deepEqual(store.getState().objects, {});
  assert.equal(store.isPristine(), true);
});

test("a selection that spans pages: all of it moves, only the objects of the start page change pages on a drop", () => {
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800] }, { view: [0, 0, 600, 800], rotate: 180 }, { view: [0, 0, 600, 800] }], measure: null });
  const [a, b, c] = pageIds;
  const page = (id) => store.getState().pages.find((candidate) => candidate.id === id);
  const first = createMark("redact", page(a), { at: pageScreen(page(a)).toUser([100, 100]) });
  const second = createMark("blur", page(b), { at: pageScreen(page(b)).toUser([100, 100]) });
  const [onA, onB] = store.addObjects([first, second]);
  const box = (id) => pageScreen(page(store.getState().objects[id].pageId)).rectToScreen(store.getState().objects[id].rect);
  const before = [box(onA), box(onB)];
  store.clearHistory();
  runEffect(store, { type: "move", ids: [onA, onB], pageId: a, from: { x: 100, y: 100 }, to: { x: 130, y: 90 }, dx: 30, dy: -10, axisLock: false, duplicate: false, drop: null });
  closeAll(box(onA), before[0].map((value, index) => value + (index % 2 ? -10 : 30)), 1e-9);
  closeAll(box(onB), before[1].map((value, index) => value + (index % 2 ? -10 : 30)), 1e-9, "the same move for the reader on the page turned upside down");
  assert.equal(store.getHistoryState().undoDepth, 1);
  runEffect(store, { type: "move", ids: [onA, onB], pageId: a, from: { x: 130, y: 90 }, to: { x: 130, y: 900 }, dx: 0, dy: 810, axisLock: false, duplicate: true, drop: { pageId: c, x: 300, y: 50 } });
  const state = store.getState();
  assert.equal(Object.keys(state.objects).length, 4);
  assert.equal(state.pages[2].objectIds.length, 1, "the copy of the mark of the start page went to the page under the pointer");
  assert.equal(state.pages[1].objectIds.length, 2, "the copy on the other page moved along on its page");
  assert.equal(store.getHistoryState().undoDepth, 2, "duplicate, move and change of page are one step");
  assert.deepEqual(validateDocument(state), []);
});

test("the model works on the facts of the real viewer: geometry, marks on text, export job", async () => {
  const bytes = await makeTextPdf([
    { lines: [VIETNAMESE_SAMPLE, "Số tài khoản: 0123456789"] },
    { lines: ["Trang hai"], size: [400, 300], rotate: 90 }
  ], { title: "Hợp đồng thử nghiệm" });
  await withPdf(bytes, async (doc) => {
    // what the viewer reports about a source
    const facts = { pageCount: doc.numPages, pages: [], info: (await doc.getMetadata()).info, encrypted: false, signatureFieldCount: 0 };
    const viewerPages = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const viewerPage = await doc.getPage(number);
      viewerPages.push(viewerPage);
      facts.pages.push({ view: viewerPage.view.slice(), rotate: viewerPage.rotate, userUnit: viewerPage.userUnit });
    }
    const store = createEditorStore({ measureText: fakeMeasure });
    let sourceId;
    store.reset(() => {
      sourceId = store.addSource(facts, bytes, { name: "hop-dong.pdf" });
      store.insertPages(store.pagesOfSource(sourceId), 0);
      store.setFileName("hop-dong.pdf");
    });
    assert.equal(store.getState().sources[sourceId].info.title, "Hợp đồng thử nghiệm");
    assert.equal(store.isPristine(), true);
    store.rotatePages([store.getState().pages[1].id], 90);

    // the screen of the model is the viewport of the viewer, with the rotation the user added
    for (const [index, viewerPage] of viewerPages.entries()) {
      const page = store.getState().pages[index];
      const screen = pageScreen(page);
      const viewport = viewerPage.getViewport({ scale: 1, rotation: viewerPage.rotate + page.rotation });
      close(screen.width, viewport.width, 1e-9);
      close(screen.height, viewport.height, 1e-9);
      for (const point of [[0, 0], [50, 70], [333.3, 12.5]]) closeAll(screen.toScreen(point), viewport.convertToViewportPoint(point[0], point[1]), 1e-9, `page ${index + 1}`);
    }

    // marks and highlights made from the boxes of the viewer's text items sit on that text
    const first = store.getState().pages[0];
    const items = await pageItems(viewerPages[0]);
    const account = items.find((item) => item.str.includes("0123456789"));
    assert.ok(account, "the viewer sees the line");
    const [redact, highlight] = store.addObjects([createMark("redact", first, { rect: account.box }), createTextHighlight(first, [items[0].box])]);
    const middle = (item) => [(item.box[0] + item.box[2]) / 2, (item.box[1] + item.box[3]) / 2];
    assert.equal(objectAtPoint(store.getState(), first, middle(account)).id, redact);
    assert.equal(objectAtPoint(store.getState(), first, middle(items[0])).id, highlight);
    const second = store.getState().pages[1];
    const [title] = await pageItems(viewerPages[1]);
    const [replacement] = store.addObjects([{ ...createMark("blur", second, { rect: title.box }) }]);
    assert.equal(objectAtPoint(store.getState(), second, middle(title)).id, replacement);

    const job = await buildExportJob(store, { layoutText: fakeLayout });
    assert.equal(job.sources[0].bytes, bytes);
    assert.equal(job.sources[0].expectedPages, doc.numPages);
    assert.deepEqual(job.pages, [{ source: sourceId, index: 0, rotate: 0 }, { source: sourceId, index: 1, rotate: 90 }]);
    assert.deepEqual(job.marks.map((mark) => [mark.pageIndex, mark.mode]), [[0, "redact"], [1, "pixelate"]]);
    closeAll(job.marks[0].rect, account.box, 1e-9);
    assert.deepEqual(job.info, { title: "Hợp đồng thử nghiệm" });
    assert.equal(job.fileName, "hop-dong");
    assert.equal(bytes.byteLength, store.getState().sources[sourceId].byteLength, "the viewer got a copy: the store's bytes are intact");
  });
});
