// The editor's own clipboard for objects (src/pages/pdfEditor/model/clipboard.js).
import test from "node:test";
import assert from "node:assert/strict";
import { clipboard, createClipboard } from "../src/pages/pdfEditor/model/clipboard.js";
import { validateDocument } from "../src/pages/pdfEditor/model/selectors.js";
import { objectScreenBox, pageScreen } from "../src/pages/pdfEditor/model/shapes.js";
import { PAGE_VARIANTS, allIds, bytesOf, closeAll, fakeMeasure, openStore, sample } from "./helpers/pdfModelKit.mjs";

const shifted = (box, dx, dy = dx) => [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];

test("copy and paste on the same page: new ids, 12 pt right and down as the reader sees it, one undo step", () => {
  for (const [variant, extra] of [[PAGE_VARIANTS[0], 0], [PAGE_VARIANTS[1], 0], [PAGE_VARIANTS[2], 90], [PAGE_VARIANTS[3], 270]]) {
    const { store, pageIds } = openStore({ pages: [variant], measure: fakeMeasure });
    if (extra) store.rotatePages(pageIds, extra);
    store.clearHistory();
    const page = () => store.getState().pages[0];
    const screen = pageScreen(page());
    const board = createClipboard();
    assert.equal(board.isEmpty(), true);
    assert.deepEqual(board.paste(store, { pageId: pageIds[0] }), [], "nothing to paste");

    const [rect, text, redact, line] = store.addObjects([
      sample.rect(pageIds[0], { frame: screen.frameFromBox({ left: 40, top: 40, width: 60, height: 30 }, 20) }),
      sample.text(pageIds[0], { frame: screen.frameFromBox({ left: 40, top: 100, width: 10, height: 10 }), text: "Xin chào" }),
      sample.redact(pageIds[0], { rect: screen.rectToUser([40, 150, 100, 170]) }),
      sample.line(pageIds[0], { p1: screen.toUser([40, 200]), p2: screen.toUser([100, 220]) })
    ]);
    const steps = store.getHistoryState().undoDepth;
    assert.deepEqual(board.copy(store, [line, rect, "ghost", redact, text]), [redact, rect, text, line], "in stacking order");
    assert.equal(store.getHistoryState().undoDepth, steps, "copying changes nothing");
    assert.equal(board.count(), 4);
    assert.deepEqual(board.types().sort(), ["line", "rect", "redact", "text"]);

    const box = (id) => objectScreenBox(store.getState().objects[id], page());
    const originals = [redact, rect, text, line].map(box);
    const pasted = board.paste(store, { pageId: pageIds[0] });
    assert.equal(pasted.length, 4);
    assert.equal(store.getHistoryState().undoDepth, steps + 1, "a paste is one undo step");
    assert.equal(new Set(allIds(store.getState())).size, allIds(store.getState()).length);
    pasted.forEach((id, index) => closeAll(box(id), shifted(originals[index], 12), 1e-6, `${variant.name} +${extra}: object ${index}`));
    const state = store.getState();
    assert.deepEqual(state.pages[0].objectIds.slice(0, 2), [redact, pasted[0]], "a pasted mark stays with the marks");
    assert.deepEqual(state.pages[0].objectIds.slice(-3), pasted.slice(1), "the rest goes on top, in the same order");
    assert.equal(state.objects[pasted[1]].frame.rot, state.objects[rect].frame.rot);
    assert.deepEqual({ ...state.objects[pasted[1]], id: 0, frame: 0 }, { ...state.objects[rect], id: 0, frame: 0 }, "same properties");

    const again = board.paste(store, { pageId: pageIds[0] });
    again.forEach((id, index) => closeAll(box(id), shifted(originals[index], 24), 1e-6, "a second paste goes 12 pt further"));
    store.undo();
    store.undo();
    assert.equal(Object.keys(store.getState().objects).length, 4);
    assert.deepEqual(validateDocument(store.getState()), []);
  }
});

test("paste onto another page keeps the place where it fits, and moves the group onto the page where it does not", () => {
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800] }, { view: [0, 0, 600, 800], rotate: 90 }, { view: [0, 0, 200, 200] }], measure: fakeMeasure });
  const [a, b, c] = pageIds;
  const pageOf = (id) => store.getState().pages.find((page) => page.id === id);
  const box = (id) => objectScreenBox(store.getState().objects[id], pageOf(store.getState().objects[id].pageId));
  const [rect, mark] = store.addObjects([
    sample.rect(a, { frame: { x: 150, y: 700, w: 100, h: 40, rot: 0 } }),
    sample.redact(a, { rect: [300, 600, 400, 640] })
  ]);
  const board = createClipboard();
  board.copy(store, [rect, mark]);
  const before = [box(mark), box(rect)];
  assert.deepEqual(before, [[300, 160, 400, 200], [100, 80, 200, 120]]);

  const onB = board.paste(store, { pageId: b });
  closeAll(box(onB[0]), before[0], 1e-9, "the same place on a page with /Rotate 90");
  closeAll(box(onB[1]), before[1], 1e-9);
  assert.equal(store.getState().objects[onB[1]].frame.rot, 90, "upright for the reader there");
  assert.equal(store.getState().objects[onB[1]].pageId, b);
  const secondOnB = board.paste(store, { pageId: b });
  closeAll(box(secondOnB[1]), shifted(before[1], 12), 1e-9, "a repeated paste on that page is offset");

  // the 200 x 200 page: the group (300 pt wide) cannot keep its place; it is centred horizontally and stays together
  const onC = board.paste(store, { pageId: c });
  const [markBox, rectBox] = onC.map(box);
  closeAll([rectBox[0] - markBox[0], rectBox[1] - markBox[1]], [-200, -80], 1e-9, "the arrangement of the group is kept");
  closeAll([(Math.min(markBox[0], rectBox[0]) + Math.max(markBox[2], rectBox[2])) / 2], [100], 1e-9, "wider than the page: centred");
  assert.ok(Math.min(markBox[1], rectBox[1]) >= 0 && Math.max(markBox[3], rectBox[3]) <= 200, "it fits vertically: on the page");

  // "Paste here": the middle of the group at a point of the page
  const here = board.paste(store, { pageId: a, at: [300, 400] });
  const boxes = here.map(box);
  closeAll([(Math.min(boxes[0][0], boxes[1][0]) + Math.max(boxes[0][2], boxes[1][2])) / 2, (Math.min(boxes[0][1], boxes[1][1]) + Math.max(boxes[0][3], boxes[1][3])) / 2], [300, 400], 1e-9);
  // back on the page of the originals the first plain paste is one step away from them
  const onA = board.paste(store, { pageId: a });
  closeAll(box(onA[1]), shifted(before[1], 12), 1e-9);
  assert.throws(() => board.paste(store, { pageId: "ghost" }), (error) => error.code === "MODEL_UNKNOWN_PAGE");
  assert.deepEqual(validateDocument(store.getState()), []);
});

test("cut removes the objects in one step; the clipboard keeps them", () => {
  const { store, pageIds } = openStore({ measure: fakeMeasure });
  const [rect, pen] = store.addObjects([sample.rect(pageIds[0]), sample.pen(pageIds[0])]);
  const board = createClipboard();
  const steps = store.getHistoryState().undoDepth;
  assert.deepEqual(board.cut(store, [rect, pen]), [rect, pen]);
  assert.equal(store.getHistoryState().undoDepth, steps + 1);
  assert.deepEqual(store.getState().objects, {});
  assert.deepEqual(board.cut(store, ["ghost"]), [], "nothing to cut: the clipboard keeps what it had");
  assert.equal(board.count(), 2);
  const pasted = board.paste(store, { pageId: pageIds[1] });
  assert.deepEqual(pasted.map((id) => store.getState().objects[id].type), ["rect", "pen"]);
  assert.deepEqual(store.getState().objects[pasted[0]].frame, { x: 150, y: 500, w: 120, h: 80, rot: 0 }, "cut from one page, pasted at the same place of another");
  board.clear();
  assert.equal(board.isEmpty(), true);
  assert.deepEqual(board.types(), []);
});

test("a copy of a blur mark gets a seed of its own; the marks of a duplicated page keep theirs", () => {
  const { store, pageIds } = openStore({ measure: fakeMeasure });
  const seedOf = (id) => store.getState().objects[id].seed;
  const [mark] = store.addObjects([sample.blur(pageIds[0])]);
  const seed = seedOf(mark);
  assert.match(seed, /^[0-9a-f]{32}$/);

  // the same noise over other content could be subtracted by whoever sees both pictures
  const [duplicate] = store.duplicateObjects([mark]);
  assert.match(seedOf(duplicate), /^[0-9a-f]{32}$/);
  assert.notEqual(seedOf(duplicate), seed, "a duplicate is another mark");
  const board = createClipboard();
  board.copy(store, [mark]);
  const [samePlace] = board.paste(store, { pageId: pageIds[1] });
  assert.deepEqual(store.getState().objects[samePlace].rect, store.getState().objects[mark].rect, "the same rectangle on another page");
  assert.match(seedOf(samePlace), /^[0-9a-f]{32}$/);
  assert.notEqual(seedOf(samePlace), seed, "a pasted mark covers other content");
  const [again] = board.paste(store, { pageId: pageIds[1] });
  assert.notEqual(seedOf(again), seedOf(samePlace), "every paste is a mark of its own");
  board.cut(store, [mark]);
  const [moved] = board.paste(store, { pageId: pageIds[1], at: [200, 200] });
  assert.notEqual(seedOf(moved), seed, "cut and paste as well");
  store.undo();
  store.undo();
  assert.equal(seedOf(mark), seed, "undo brings the mark back as it was");

  // a duplicated page shows the same content under the same mark: the same mosaic tells nothing new,
  // a second seed would be a second sample of that content
  const [copyOfPage] = store.duplicatePages([pageIds[0]]);
  const copies = store.getState().pages.find((page) => page.id === copyOfPage).objectIds;
  const twin = copies.find((id) => store.getState().objects[id].type === "blur" && store.getState().objects[id].seed === seed);
  assert.ok(twin, "the mark of the copied page has the seed of its original");
  assert.notEqual(twin, mark);
  assert.deepEqual(validateDocument(store.getState()), []);
});

test("pictures survive the document they came from; replaced lines are pasted as plain text", () => {
  const first = openStore({ measure: fakeMeasure });
  const bytes = bytesOf(64, 9);
  const assetId = first.store.addAsset({ mime: "image/png", width: 300, height: 100 }, bytes);
  const [image, text] = first.store.addObjects([
    sample.image(first.pageIds[0], assetId),
    sample.text(first.pageIds[0], { text: "Số 12/2026", replaces: { rect: [50, 700, 250, 720], cover: "#ffffff", sourceText: "Số 11/2026" } })
  ]);
  const board = createClipboard();
  assert.deepEqual(board.copy(first.store, [image, text]), [image, text]);

  // the same document: the picture is registered once
  const sameDoc = board.paste(first.store, { pageId: first.pageIds[1] });
  assert.equal(first.store.getState().objects[sameDoc[0]].assetId, assetId);
  assert.equal(Object.keys(first.store.getState().assets).length, 1);
  assert.equal(first.store.getState().objects[sameDoc[1]].replaces, undefined, "a copy does not replace the line again");
  assert.ok(first.store.getState().objects[text].replaces);

  // another document in the same tab: the clipboard brings the bytes along
  first.store.reset();
  assert.equal(first.store.getAssetBytes(assetId), null);
  const second = openStore({ measure: fakeMeasure });
  const pasted = board.paste(second.store, { pageId: second.pageIds[0] });
  const state = second.store.getState();
  const newAsset = state.objects[pasted[0]].assetId;
  assert.deepEqual(state.assets[newAsset], { id: newAsset, mime: "image/png", width: 300, height: 100, byteLength: 64 });
  assert.equal(second.store.getAssetBytes(newAsset), bytes);
  assert.equal(state.objects[pasted[1]].text, "Số 12/2026");
  assert.deepEqual(state.objects[pasted[0]].frame, { x: 300, y: 400, w: 120, h: 60, rot: 0 }, "another document: the same place, no offset");
  assert.equal(second.store.getHistoryState().undoDepth, 1);
  second.store.undo();
  assert.deepEqual(second.store.getState().objects, {});
  assert.deepEqual(validateDocument(second.store.getState()), []);

  // a paste that fails leaves nothing behind
  second.store.setMeasureText(() => {
    throw new Error("font not loaded");
  });
  second.store.clearHistory();
  assert.equal(Object.keys(second.store.getState().assets).length, 0, "nothing needs the pasted picture any more");
  assert.throws(() => board.paste(second.store, { pageId: second.pageIds[0] }), /font not loaded/);
  assert.equal(Object.keys(second.store.getState().objects).length, 0);
  assert.equal(Object.keys(second.store.getState().assets).length, 0, "the picture the failed paste had registered is gone again");
  assert.equal(second.store.canUndo(), false);
  assert.equal(typeof clipboard.paste, "function", "the tab has one shared clipboard");
});
