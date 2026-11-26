// Random but reproducible command sequences against the document store: whatever is done in whatever order,
// the document keeps every invariant, the history walks back to the opened file and forward again, and the
// bytes of everything a state in the history shows are still there.
import test from "node:test";
import assert from "node:assert/strict";
import { createClipboard } from "../src/pages/pdfEditor/model/clipboard.js";
import { ALIGNMENTS, alignObjects, validateDocument } from "../src/pages/pdfEditor/model/selectors.js";
import { pageScreen } from "../src/pages/pdfEditor/model/shapes.js";
import { createEditorStore } from "../src/pages/pdfEditor/model/store.js";
import { HANDLES, createImage, createLine, createMark, createShape, createStroke, createTextBox, moveObject, resizeObject, rotateObject, styleUpdates } from "../src/pages/pdfEditor/model/transform.js";
import { PAGE_VARIANTS, allIds, bytesOf, fakeMeasure, holdsBytes, sourceFacts } from "./helpers/pdfModelKit.mjs";

/** A small seeded generator (mulberry32): the same seed gives the same sequence on every machine. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function check(store, label) {
  const state = store.getState();
  assert.deepEqual(validateDocument(state), [], label);
  const ids = allIds(state);
  assert.equal(new Set(ids).size, ids.length, `${label}: unique ids`);
  assert.equal(holdsBytes(state), false, `${label}: no bytes in the state`);
  for (const page of state.pages) if (page.kind === "pdf") assert.ok(store.getSourceBytes(page.sourceId), `${label}: bytes of a source in use`);
  for (const object of Object.values(state.objects)) if (object.type === "image") assert.ok(store.getAssetBytes(object.assetId), `${label}: bytes of a picture in use`);
}

test("random command sequences keep every invariant, and the history leads back and forth", () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    const random = generator(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const some = (list, max = 3) => list.filter(() => random() < 0.4).slice(0, max);
    const between = (low, high) => low + random() * (high - low);
    // even seeds keep the whole history, odd seeds a short one (old steps and their resources are dropped)
    const store = createEditorStore({ measureText: fakeMeasure, historyLimit: seed % 2 ? 15 : 100000 });
    const board = createClipboard();
    let sourceId;
    store.reset(() => {
      sourceId = store.addSource(sourceFacts([pick(PAGE_VARIANTS), pick(PAGE_VARIANTS), pick(PAGE_VARIANTS)]), bytesOf(40, seed));
      store.insertPages(store.pagesOfSource(sourceId), 0);
    });
    const opened = store.getState();
    const pages = () => store.getState().pages;
    const objectIds = () => Object.keys(store.getState().objects);
    const pointOn = (page) => {
      const screen = pageScreen(page);
      return screen.toUser([between(-30, screen.width + 30), between(-30, screen.height + 30)]);
    };
    const commands = [
      () => {
        const page = pick(pages());
        const at = pointOn(page);
        const to = pointOn(page);
        const assetId = store.addAsset({ mime: "image/png", width: 80, height: 40 }, bytesOf(16, Math.floor(random() * 5)));
        const made = pick([
          () => createShape(pick(["rect", "ellipse"]), page, { from: at, to }),
          () => createLine(page, { at }, undefined, { arrow: random() < 0.5 }),
          () => createMark(pick(["redact", "blur"]), page, { from: at, to }),
          () => createTextBox(page, random() < 0.5 ? { at } : { from: at, to }, { align: pick(["left", "center", "right"]) }, pick(["Xin chào", "", "hai\ndòng"])),
          () => createStroke(pick(["pen", "highlighter"]), page, [at, to, pointOn(page)]),
          () => createImage(page, store.getState().assets[assetId], { at })
        ])();
        store.addObjects([made]);
      },
      () => {
        const state = store.getState();
        const updates = some(objectIds()).map((id) => {
          const object = state.objects[id];
          const page = state.pages.find((candidate) => candidate.id === object.pageId);
          const patch = pick([
            () => moveObject(object, [between(-800, 800), between(-800, 800)]),
            () => resizeObject(object, pick([...HANDLES, "p1", "p2"]), [between(-150, 150), between(-150, 150)], page, { shift: random() < 0.5 }),
            () => rotateObject(object, pointOn(page), pointOn(page), { snap: random() < 0.5 }),
            () => styleUpdates(state, [id], { opacity: random(), color: "#123456", stroke: "#ABCDEF", fill: null, size: between(4, 60), bold: true })[0]?.patch
          ])();
          return patch ? { id, patch } : null;
        }).filter(Boolean);
        store.updateObjects(updates, random() < 0.3 ? { coalesceKey: "drag" } : undefined);
      },
      () => store.updateObjects(alignObjects(store.getState(), some(objectIds(), 5), pick(ALIGNMENTS))),
      () => store.deleteObjects(some(objectIds())),
      () => store.duplicateObjects(some(objectIds())),
      () => store.arrange(some(objectIds()), pick(["front", "forward", "backward", "back"])),
      () => store.moveObjectsToPage(some(objectIds()), pick(pages()).id, pick(["keep", "center", { offset: [between(-200, 200), between(-200, 200)], fit: false }])),
      () => (board.copy(store, some(objectIds())).length || !board.isEmpty()) && board.paste(store, { pageId: pick(pages()).id }),
      () => store.insertPages(store.pagesOfSource(sourceId, [Math.floor(random() * 3)]), Math.floor(random() * (pages().length + 1))),
      () => store.insertBlankPage(Math.floor(random() * (pages().length + 1)), [between(120, 700), between(120, 700)]),
      () => pages().length > 2 && store.deletePages([pick(pages()).id]),
      () => store.movePages(some(pages().map((page) => page.id), 2), Math.floor(random() * pages().length)),
      () => pages().length < 8 && store.duplicatePages([pick(pages()).id]),
      () => store.rotatePages(some(pages().map((page) => page.id)), pick([90, 180, 270])),
      () => store.undo(),
      () => store.redo(),
      () => store.transaction(() => {
        store.rotatePages([pages()[0].id], 90);
        store.insertBlankPage(0, [200, 200]);
      })
    ];
    for (let index = 0; index < 60; index += 1) {
      pick(commands)();
      check(store, `seed ${seed}, command ${index}`);
    }
    while (store.redo());
    const final = store.getState();
    let undone = 0;
    while (store.undo()) {
      undone += 1;
      check(store, `seed ${seed}, undo ${undone}`);
    }
    if (seed % 2 === 0) {
      assert.equal(store.getState().pages, opened.pages, `seed ${seed}: a full undo gives back the opened pages`);
      assert.equal(store.getState().objects, opened.objects, `seed ${seed}: and no objects`);
      assert.equal(store.isPristine(), true);
    } else {
      assert.ok(undone <= 15);
    }
    while (store.redo());
    assert.equal(store.getState().pages, final.pages, `seed ${seed}: a full redo gives back the final document`);
    assert.equal(store.getState().objects, final.objects);
  }
});
