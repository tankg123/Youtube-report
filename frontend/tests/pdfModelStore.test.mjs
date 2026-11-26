// The document store of the PDF editor (src/pages/pdfEditor/model/store.js): commands, undo history,
// registries of sources and assets, text frames, saving state.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PdfEditorError, isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { localToUser } from "../src/pages/pdfEditor/engine/geometry.js";
import { CODES, USER_FACING_CODES } from "../src/pages/pdfEditor/model/codes.js";
import { OBJECT_DEFAULTS, objectBounds } from "../src/pages/pdfEditor/model/schema.js";
import { objectsOfPage, validateDocument } from "../src/pages/pdfEditor/model/selectors.js";
import { objectScreenBox } from "../src/pages/pdfEditor/model/shapes.js";
import { HISTORY_LIMIT, createEditorStore, normalizeFileName } from "../src/pages/pdfEditor/model/store.js";
import { A4, allIds, bytesOf, close, closeAll, fakeMeasure, holdsBytes, openStore, sample, sourceFacts } from "./helpers/pdfModelKit.mjs";

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(isPdfEditorError(error), `expected a PdfEditorError, got ${error}`);
    assert.ok(Object.hasOwn(CODES, error.code), `${error.code} is not listed in CODES`);
    assert.deepEqual(Object.keys(error.params).sort(), [...CODES[error.code]].sort(), `${error.code} parameters`);
    return error.code;
  }
  return null;
};
const consistent = (store) => assert.deepEqual(validateDocument(store.getState()), []);

/** Runs one command and proves: exactly one undo step, undo gives back the very same document, redo the new one. */
function oneStep(store, command, label) {
  const before = store.getState();
  const depth = store.getHistoryState().undoDepth;
  const result = command();
  const after = store.getState();
  assert.notEqual(after, before, `${label}: the state changed`);
  assert.equal(store.getHistoryState().undoDepth, depth + 1, `${label}: exactly one undo step`);
  consistent(store);
  assert.equal(store.undo(), true, `${label}: undo`);
  const undone = store.getState();
  assert.equal(undone.pages, before.pages, `${label}: undo restores the same pages`);
  assert.equal(undone.objects, before.objects, `${label}: undo restores the same objects`);
  assert.equal(undone.fileName, before.fileName, `${label}: undo restores the name`);
  consistent(store);
  assert.equal(store.redo(), true, `${label}: redo`);
  const redone = store.getState();
  assert.equal(redone.pages, after.pages, `${label}: redo restores the pages`);
  assert.equal(redone.objects, after.objects, `${label}: redo restores the objects`);
  assert.equal(redone.fileName, after.fileName, `${label}: redo restores the name`);
  assert.equal(store.canRedo(), false, label);
  return result;
}

test("a store starts empty and works with useSyncExternalStore (getState is stable, subscribe returns unsubscribe)", () => {
  const store = createEditorStore();
  const state = store.getState();
  assert.deepEqual(state, { fileName: "", sources: {}, pages: [], objects: {}, assets: {} });
  assert.equal(store.getState(), state, "the same snapshot until something changes");
  assert.equal(store.canUndo(), false);
  assert.equal(store.isDirty(), false);
  assert.equal(store.isPristine(), false);
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });
  store.insertBlankPage(0, [300, 400]);
  assert.equal(calls, 1);
  assert.equal(store.deletePages(["nope"]).length, 0);
  assert.equal(calls, 1, "a command that changes nothing does not notify");
  unsubscribe();
  store.insertBlankPage(1, [300, 400]);
  assert.equal(calls, 1);
  assert.equal(HISTORY_LIMIT, 200);
});

test("opening a document: reset(setup) leaves no undo step, a clean state and a pristine document", () => {
  const { store, sourceId, pageIds, bytes } = openStore({ pages: [{}, { rotate: 90 }, { view: [10, 20, 310, 420], userUnit: 2 }], password: "s3cret" });
  const state = store.getState();
  assert.equal(state.fileName, "hop-dong");
  assert.equal(pageIds.length, 3);
  assert.equal(store.canUndo(), false);
  assert.equal(store.isDirty(), false);
  assert.equal(store.isPristine(), true);
  assert.equal(store.pristineSourceId(), sourceId);
  assert.deepEqual(state.sources[sourceId], { id: sourceId, name: "hop-dong.pdf", byteLength: 96, pageCount: 3, encrypted: false, signatureCount: 0, info: { title: "Hợp đồng dịch vụ", author: "ANS Network" } });
  assert.deepEqual(state.pages[1], { id: pageIds[1], kind: "pdf", sourceId, sourceIndex: 1, view: A4.slice(), baseRotation: 90, userUnit: 1, rotation: 0, objectIds: [] });
  assert.deepEqual(state.pages[2].view, [10, 20, 310, 420]);
  assert.equal(state.pages[2].userUnit, 2);
  // bytes and password live outside the state
  assert.equal(store.getSourceBytes(sourceId), bytes);
  assert.equal(store.getSourcePassword(sourceId), "s3cret");
  assert.equal(holdsBytes(state), false);
  assert.ok(!JSON.stringify(state).includes("s3cret"));
  consistent(store);
});

test("addSource validates the viewer's facts and accepts pdf.js-style info keys", () => {
  const store = createEditorStore();
  assert.equal(codeOf(() => store.addSource(sourceFacts([{}]), new Uint8Array(0))), "MODEL_INVALID_SOURCE");
  assert.equal(codeOf(() => store.addSource({ pageCount: 2, pages: [{ view: A4 }] }, bytesOf())), "MODEL_INVALID_SOURCE");
  assert.equal(codeOf(() => store.addSource({ pageCount: 1, pages: [{ view: [0, 0, 0, 10] }] }, bytesOf())), "MODEL_INVALID_SOURCE");
  assert.equal(codeOf(() => store.addSource(null, bytesOf())), "MODEL_INVALID_SOURCE");
  assert.deepEqual(store.getState().sources, {}, "a refused source leaves nothing behind");
  const id = store.addSource({ pageCount: 1, pages: [{ view: A4, rotate: 450 }], info: { Title: "Báo cáo", Author: "", Producer: "x" }, encrypted: 1, signatureFieldCount: 2 }, bytesOf().buffer, { name: "b.pdf" });
  const source = store.getState().sources[id];
  assert.deepEqual(source.info, { title: "Báo cáo", producer: "x" });
  assert.equal(source.encrypted, true);
  assert.equal(source.signatureCount, 2);
  assert.ok(store.getSourceBytes(id) instanceof Uint8Array);
  assert.equal(store.getSourcePassword(id), undefined);
  assert.equal(store.pagesOfSource(id)[0].baseRotation, 90, "/Rotate is reduced to a right angle");
  assert.equal(store.canUndo(), false, "registering a source is not an undo step");
  assert.equal(store.isDirty(), false);
  // the viewer opens a file under an id before the facts exist: that id can be kept
  const own = store.addSource(sourceFacts([{}], { signatureFieldCount: 3, signatureCount: 1 }), bytesOf(20, 5), { id: "s_from_viewer" });
  assert.equal(own, "s_from_viewer");
  assert.equal(store.getState().sources[own].signatureCount, 1, "signatures that exist, not empty signature fields");
  assert.equal(codeOf(() => store.addSource(sourceFacts([{}]), bytesOf(20, 6), { id: "s_from_viewer" })), "MODEL_DUPLICATE_ID");
  assert.equal(codeOf(() => store.addSource(sourceFacts([{}]), bytesOf(20, 6), { id: "" })), "MODEL_INVALID_SOURCE");
  assert.equal(codeOf(() => store.pagesOfSource("nope")), "MODEL_UNKNOWN_SOURCE");
  assert.equal(codeOf(() => store.pagesOfSource(id, [3])), "MODEL_INVALID_ARGUMENT");
  assert.deepEqual(store.pagesOfSource(id, [0]).map((page) => page.sourceIndex), [0]);
});

test("every page command is one undo step, and undo / redo restore the exact document", () => {
  const { store, sourceId, pageIds } = openStore();
  const [a, b, c] = pageIds;
  const [rectId] = store.addObjects([sample.rect(b)]);
  store.clearHistory();

  const inserted = oneStep(store, () => store.insertPages(store.pagesOfSource(sourceId, [2, 0]), 1), "insertPages");
  assert.deepEqual(store.getState().pages.map((page) => page.sourceIndex), [0, 2, 0, 1, 2]);
  assert.equal(inserted.length, 2);

  const blank = oneStep(store, () => store.insertBlankPage(0, [300, 400]), "insertBlankPage");
  assert.deepEqual(store.getState().pages[0], { id: blank, kind: "blank", sourceId: null, sourceIndex: null, view: [0, 0, 300, 400], baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [] });

  const deleted = oneStep(store, () => store.deletePages([blank, ...inserted, "unknown"]), "deletePages");
  assert.deepEqual(deleted, [blank, ...inserted]);
  assert.deepEqual(store.getState().pages.map((page) => page.id), [a, b, c]);

  assert.equal(oneStep(store, () => store.movePages([c, a], 1), "movePages"), true);
  assert.deepEqual(store.getState().pages.map((page) => page.id), [b, a, c], "the moved pages keep their order and start at the index");
  assert.equal(store.movePages([b], 0), false, "already there: nothing happens");
  assert.equal(store.movePages([a, c], 99), false);

  const [copy] = oneStep(store, () => store.duplicatePages([b]), "duplicatePages");
  assert.deepEqual(store.getState().pages.map((page) => page.id), [b, copy, a, c], "the copy follows its original");
  const copied = store.getState().pages[1];
  assert.equal(copied.objectIds.length, 1);
  assert.notEqual(copied.objectIds[0], rectId);

  assert.deepEqual(oneStep(store, () => store.rotatePages([a, c], -90), "rotatePages"), [a, c]);
  assert.deepEqual(store.getState().pages.map((page) => page.rotation), [0, 0, 270, 270]);
  assert.deepEqual(store.rotatePages([a], 360), [], "a full turn is no change");
  assert.equal(codeOf(() => store.rotatePages([a], 45)), "MODEL_INVALID_ROTATION");

  assert.equal(oneStep(store, () => store.setFileName("  báo cáo: quý 3?.PDF "), "setFileName"), true);
  assert.equal(store.getState().fileName, "báo cáo- quý 3-");
  assert.equal(store.setFileName("báo cáo- quý 3-.pdf"), false);
});

test("page commands validate their arguments", () => {
  const { store, sourceId, pageIds } = openStore({ pages: [{}] });
  assert.equal(codeOf(() => store.insertPages([{ kind: "pdf", sourceId: "ghost", sourceIndex: 0, view: A4 }])), "MODEL_UNKNOWN_SOURCE");
  assert.equal(codeOf(() => store.insertPages([{ kind: "pdf", sourceId, sourceIndex: 5, view: A4 }])), "MODEL_INVALID_PAGE");
  assert.equal(codeOf(() => store.insertPages([{ kind: "sheet", view: A4 }])), "MODEL_INVALID_PAGE");
  assert.equal(codeOf(() => store.insertPages([{ ...store.pagesOfSource(sourceId)[0], id: pageIds[0] }])), "MODEL_DUPLICATE_ID");
  assert.equal(codeOf(() => store.insertPages("pages")), "MODEL_INVALID_ARGUMENT");
  assert.equal(codeOf(() => store.insertBlankPage(0, [0, 100])), "MODEL_INVALID_PAGE_SIZE");
  assert.equal(codeOf(() => store.insertBlankPage(0, [100, 20000])), "MODEL_INVALID_PAGE_SIZE");
  assert.equal(codeOf(() => store.movePages(pageIds, NaN)), "MODEL_INVALID_ARGUMENT");
  assert.equal(codeOf(() => store.deletePages(pageIds)), "MODEL_LAST_PAGE", "a document needs at least one page");
  assert.equal(store.getState().pages.length, 1);
  assert.equal(store.canUndo(), false, "nothing was recorded for refused commands");
  // inserted pages never bring object ids with them
  const [id] = store.insertPages([{ ...store.pagesOfSource(sourceId)[0], objectIds: ["x"] }]);
  assert.deepEqual(store.getState().pages.find((page) => page.id === id).objectIds, []);
});

test("every object command is one undo step", () => {
  const { store, pageIds } = openStore();
  const [a, b] = pageIds;
  const assetId = store.addAsset({ mime: "image/png", width: 200, height: 100 }, bytesOf(40, 3));
  assert.equal(store.canUndo(), false, "registering an asset is not an undo step");

  const ids = oneStep(store, () => store.addObjects([
    sample.rect(a), sample.ellipse(a), sample.line(a), sample.pen(a), sample.text(a), sample.image(a, assetId),
    sample.highlightText(a), sample.highlightStroke(a), sample.redact(a), sample.blur(a)
  ]), "addObjects");
  assert.equal(ids.length, 10);
  const [rect, ellipse, line, pen, text, image, , , redact, blur] = ids;
  const stack = () => store.getState().pages[0].objectIds;
  assert.deepEqual(stack().slice(0, 2), [redact, blur], "marks are stacked below everything else");

  assert.deepEqual(oneStep(store, () => store.updateObjects([{ id: rect, patch: { fill: "#00FF00", strokeWidth: 4 } }, { id: "ghost", patch: { fill: null } }]), "updateObjects"), [rect]);
  assert.equal(store.getState().objects[rect].fill, "#00ff00");
  assert.deepEqual(store.updateObjects([{ id: rect, patch: { fill: "#00ff00" } }]), [], "the same values: no step");

  assert.deepEqual(oneStep(store, () => store.deleteObjects([ellipse, "ghost", ellipse]), "deleteObjects"), [ellipse]);
  assert.equal(store.getState().objects[ellipse], undefined);
  assert.ok(!stack().includes(ellipse));

  for (const [direction, expected] of [
    ["front", (order) => [...order.filter((id) => id !== line), line]],
    ["backward", (order) => order],
    ["back", (order) => [line, ...order.filter((id) => id !== line)]],
    ["forward", (order) => order]
  ]) {
    const objectsBefore = stack().filter((id) => id !== redact && id !== blur);
    assert.equal(oneStep(store, () => store.arrange([line, redact], direction), `arrange ${direction}`), true);
    const objectsAfter = stack().filter((id) => id !== redact && id !== blur);
    if (direction === "front" || direction === "back") assert.deepEqual(objectsAfter, expected(objectsBefore));
    else assert.equal(Math.abs(objectsAfter.indexOf(line) - objectsBefore.indexOf(line)), 1, `${direction} moves one layer`);
    assert.deepEqual(stack().slice(0, 2), [redact, blur], "marks are never arranged");
  }
  assert.equal(store.arrange([redact], "front"), false);
  assert.equal(codeOf(() => store.arrange([line], "up")), "MODEL_INVALID_ARGUMENT");

  const copies = oneStep(store, () => store.duplicateObjects([pen, text, redact]), "duplicateObjects");
  assert.equal(copies.length, 3);
  assert.equal(new Set([...copies, ...ids]).size, 13, "copies have new ids");
  assert.deepEqual(stack().slice(0, 3), [redact, blur, copies[2]], "the copy of a mark stays with the marks");
  assert.deepEqual(stack().slice(-2), [copies[0], copies[1]], "other copies go on top");

  const moved = oneStep(store, () => store.moveObjectsToPage([image, redact, "ghost"], b), "moveObjectsToPage");
  assert.deepEqual(moved, [redact, image]);
  assert.deepEqual(store.getState().pages[1].objectIds, [redact, image]);
  assert.equal(store.getState().objects[image].pageId, b);
  assert.deepEqual(store.moveObjectsToPage([image], b), [], "already there");
  assert.equal(codeOf(() => store.moveObjectsToPage([image], "ghost")), "MODEL_UNKNOWN_PAGE");
  consistent(store);
});

test("arrange moves several objects together and keeps their order", () => {
  const { store, pageIds } = openStore({ pages: [{}] });
  const [a, b, c, d, e] = store.addObjects([1, 2, 3, 4, 5].map(() => sample.rect(pageIds[0])));
  const order = () => store.getState().pages[0].objectIds;
  store.arrange([b, c], "forward");
  assert.deepEqual(order(), [a, d, b, c, e]);
  store.arrange([b, c], "front");
  assert.deepEqual(order(), [a, d, e, b, c]);
  assert.equal(store.arrange([b, c], "forward"), false, "already on top");
  store.arrange([e, c], "backward");
  assert.deepEqual(order(), [a, e, d, c, b]);
  store.arrange([c, e], "back");
  assert.deepEqual(order(), [e, c, a, d, b]);
});

test("deleting, duplicating and moving pages keeps and copies their objects correctly", () => {
  const { store, pageIds } = openStore();
  const [a, b, c] = pageIds;
  const [text, redact, rect] = store.addObjects([sample.text(a, { replaces: { rect: [50, 700, 250, 720], cover: "#FFFFFF", sourceText: "cũ" } }), sample.redact(a), sample.rect(a, { frame: { x: 100, y: 100, w: 50, h: 50, rot: 30 } })]);
  const [other] = store.addObjects([sample.ellipse(b)]);

  const [copy] = store.duplicatePages([a]);
  const state = store.getState();
  const copyPage = state.pages[1];
  assert.equal(copyPage.id, copy);
  assert.equal(copyPage.sourceIndex, 0);
  assert.equal(copyPage.objectIds.length, 3);
  const originals = state.pages[0].objectIds.map((id) => state.objects[id]);
  const copies = copyPage.objectIds.map((id) => state.objects[id]);
  copies.forEach((object, index) => {
    const { id, pageId, ...rest } = object;
    const { id: originalId, pageId: originalPage, ...originalRest } = originals[index];
    assert.notEqual(id, originalId);
    assert.equal(pageId, copy);
    assert.equal(originalPage, a);
    assert.deepEqual(rest, originalRest, "same content, same order (marks first)");
  });
  assert.ok(copies.find((object) => object.type === "text").replaces, "the copy of a page still replaces the line: it shows the same source page");
  assert.equal(new Set(allIds(state)).size, allIds(state).length, "ids stay unique");

  store.movePages([a], 3);
  assert.deepEqual(store.getState().pages.map((page) => page.id), [copy, b, c, a]);
  assert.deepEqual(store.getState().pages[3].objectIds, [redact, text, rect], "a moved page keeps its objects and their order");

  store.rotatePages([a], 90);
  assert.deepEqual(store.getState().objects[rect].frame, { x: 100, y: 100, w: 50, h: 50, rot: 30 }, "rotating a page never changes a frame");

  store.deletePages([a, b]);
  const after = store.getState();
  assert.deepEqual(Object.keys(after.objects).sort(), [...copyPage.objectIds].sort(), "the objects of deleted pages are gone");
  assert.equal(after.objects[other], undefined);
  consistent(store);
  store.undo();
  assert.ok(store.getState().objects[other] && store.getState().objects[text], "undo brings pages and objects back together");
  consistent(store);
});

test("ids stay unique through every kind of copy, and a taken id is refused", () => {
  const { store, pageIds } = openStore();
  const first = store.addObjects([sample.rect(pageIds[0]), sample.redact(pageIds[0]), sample.text(pageIds[0])]);
  for (let round = 0; round < 4; round += 1) {
    store.duplicateObjects(Object.keys(store.getState().objects));
    store.duplicatePages(store.getState().pages.map((page) => page.id));
  }
  const ids = allIds(store.getState());
  assert.ok(ids.length > 100);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(codeOf(() => store.addObjects([{ ...sample.rect(pageIds[0]), id: first[0] }])), "MODEL_DUPLICATE_ID");
  const [own] = store.addObjects([{ ...sample.rect(pageIds[0]), id: "my-own-id" }]);
  assert.equal(own, "my-own-id", "a free id given by the caller is kept");
  consistent(store);
});

test("validateObject is enforced for everything that enters the document", () => {
  const { store, pageIds } = openStore({ measure: null });
  const [a] = pageIds;
  const before = store.getState();
  const invalid = [
    [{ type: "rect", pageId: a, frame: { x: 0, y: 0, w: -1, h: 5, rot: 0 }, ...OBJECT_DEFAULTS.rect }, ["frame"]],
    [{ ...sample.rect(a), stroke: "red" }, ["stroke"]],
    [{ ...sample.line(a), p2: [1, NaN] }, ["points"]],
    [{ ...sample.text(a), font: "comic-sans", size: 2 }, ["font", "size"]],
    [{ ...sample.text(a), text: 5 }, ["text"]],
    [{ ...sample.blur(a), strength: 7 }, ["strength"]],
    [{ ...sample.pen(a), points: [] }, ["points"]],
    [{ ...sample.highlightText(a), quads: [[1, 2, 3]] }, ["quads"]],
    [{ type: "polygon", pageId: a }, ["type"]],
    [{ ...sample.rect(a), id: 7 }, ["id"]]
  ];
  for (const [object, problems] of invalid) {
    try {
      store.addObjects([sample.rect(a), object]);
      assert.fail(`accepted ${JSON.stringify(object)}`);
    } catch (error) {
      assert.equal(error.code, "MODEL_INVALID_OBJECT", JSON.stringify(object));
      assert.deepEqual(error.params.problems, problems);
      assert.equal(error.params.type, object.type);
    }
  }
  assert.equal(codeOf(() => store.addObjects([null])), "MODEL_INVALID_OBJECT");
  assert.equal(codeOf(() => store.addObjects([{ ...sample.rect(a), pageId: "ghost" }])), "MODEL_UNKNOWN_PAGE");
  assert.equal(codeOf(() => store.addObjects([sample.image(a, "ghost")])), "MODEL_UNKNOWN_ASSET");
  assert.equal(codeOf(() => store.addObjects({})), "MODEL_INVALID_ARGUMENT");
  assert.equal(store.getState(), before, "a refused command changes nothing, not even for the valid objects of the same call");
  assert.equal(store.canUndo(), false);

  const [rect, text] = store.addObjects([sample.rect(a), sample.text(a)]);
  const valid = store.getState();
  assert.equal(codeOf(() => store.updateObjects([{ id: rect, patch: { frame: { w: 10 } } }])), "MODEL_INVALID_OBJECT", "a patch replaces a property as a whole");
  assert.equal(codeOf(() => store.updateObjects([{ id: rect, patch: { opacity: 2 } }])), "MODEL_INVALID_OBJECT");
  assert.equal(codeOf(() => store.updateObjects([{ id: rect, patch: { fill: null } }, { id: text, patch: { align: "justify" } }])), "MODEL_INVALID_OBJECT");
  assert.equal(codeOf(() => store.updateObjects([{ id: rect, patch: { type: "ellipse" } }])), "MODEL_INVALID_PATCH");
  assert.equal(codeOf(() => store.updateObjects([{ id: rect, patch: { pageId: pageIds[1] } }])), "MODEL_INVALID_PATCH");
  assert.equal(codeOf(() => store.updateObjects([{ id: rect, patch: { id: "other" } }])), "MODEL_INVALID_PATCH");
  assert.equal(codeOf(() => store.updateObjects([{ id: rect }])), "MODEL_INVALID_ARGUMENT");
  assert.equal(store.getState(), valid);
  // the same id and type in a patch are fine; undefined removes a property
  store.updateObjects([{ id: text, patch: { id: text, type: "text", replaces: { rect: [3, 4, 1, 2], cover: null, sourceText: "a" } } }]);
  assert.deepEqual(store.getState().objects[text].replaces.rect, [1, 2, 3, 4]);
  store.updateObjects([{ id: text, patch: { replaces: undefined } }]);
  assert.ok(!("replaces" in store.getState().objects[text]));
});

test("no object can carry the geometry of another type", () => {
  const { store, pageIds } = openStore({ measure: null });
  const [a] = pageIds;
  const [line, rect, mark, quads] = store.addObjects([sample.line(a), sample.rect(a), sample.redact(a), sample.highlightText(a)]);
  const before = store.getState();
  const problemsOf = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.equal(error.code, "MODEL_INVALID_OBJECT");
      return error.params.problems;
    }
    return null;
  };
  const frame = { x: 100, y: 100, w: 10, h: 10, rot: 0 };
  assert.deepEqual(problemsOf(() => store.updateObjects([{ id: line, patch: { frame } }])), ["unexpected frame"], "a line is placed by its two ends");
  assert.deepEqual(problemsOf(() => store.updateObjects([{ id: rect, patch: { rect: [0, 0, 5, 5] } }])), ["unexpected rect"], "a rectangle SHAPE is placed by its frame");
  assert.deepEqual(problemsOf(() => store.updateObjects([{ id: mark, patch: { frame, p1: [0, 0] } }])), ["unexpected frame", "unexpected p1"]);
  assert.deepEqual(problemsOf(() => store.updateObjects([{ id: quads, patch: { frame, points: [[0, 0]] } }])), ["unexpected frame", "unexpected points"]);
  assert.deepEqual(problemsOf(() => store.addObjects([{ ...sample.text(a), quads: [[1, 2, 3, 4, 5, 6, 7, 8]] }])), ["unexpected quads"]);
  assert.equal(store.getState(), before);
  // other extra properties are the caller's business and are kept
  store.updateObjects([{ id: rect, patch: { note: "của tôi" } }]);
  assert.equal(store.getState().objects[rect].note, "của tôi");
});

test("objects are normalised when they enter: colours, NFC text, font size, mark rectangles, angles", () => {
  const { store, pageIds } = openStore({ measure: null });
  const [a] = pageIds;
  const decomposed = "Tiếng Việt".normalize("NFD");
  assert.notEqual(decomposed, decomposed.normalize("NFC"));
  const [text, redact, rect] = store.addObjects([
    sample.text(a, { text: decomposed, size: 12.3456, color: "#ABCDEF" }),
    sample.redact(a, { rect: [180, 84, 60, 60], color: "#FFF" }),
    sample.rect(a, { stroke: "#DC2626", fill: "#Ff0", frame: { x: 100, y: 100, w: 50, h: 40, rot: -90 } })
  ]);
  const { objects } = store.getState();
  assert.equal(objects[text].text, "Tiếng Việt".normalize("NFC"));
  assert.equal(objects[text].size, 12.35);
  assert.equal(objects[text].color, "#abcdef");
  assert.deepEqual(objects[redact].rect, [60, 60, 180, 84]);
  assert.equal(objects[redact].color, "#ffffff");
  assert.equal(objects[rect].stroke, "#dc2626");
  assert.equal(objects[rect].fill, "#ffff00");
  assert.equal(objects[rect].frame.rot, 270);
  // "a" followed by a combining acute accent (built from code points) becomes the single letter
  store.updateObjects([{ id: text, patch: { text: String.fromCharCode(0x61, 0x301) } }]);
  assert.equal(store.getState().objects[text].text, String.fromCharCode(0xe1));
});

test("the store never shares structure with its callers and freezes what it holds", () => {
  const { store, pageIds } = openStore({ measure: null });
  const input = sample.pen(pageIds[0]);
  const [id] = store.addObjects([input]);
  input.points[0][0] = 0.9;
  input.frame.x = -5;
  const stored = store.getState().objects[id];
  assert.deepEqual(stored.points[0], [0, 0]);
  assert.equal(stored.frame.x, 300);
  assert.throws(() => {
    stored.frame.x = 1;
  }, TypeError);
  assert.throws(() => {
    stored.points[0][0] = 1;
  }, TypeError);
  assert.throws(() => {
    store.getState().pages.push({});
  }, TypeError);
  assert.throws(() => {
    store.getState().pages[0].objectIds.push("x");
  }, TypeError);
  assert.throws(() => {
    store.getState().objects.extra = {};
  }, TypeError);
  const patch = { frame: { x: 10, y: 10, w: 20, h: 20, rot: 0 } };
  store.updateObjects([{ id, patch }]);
  patch.frame.x = 999;
  assert.equal(store.getState().objects[id].frame.x, 10);
});

test("snapshots share structure: a command only replaces what it touches", () => {
  const { store, pageIds } = openStore();
  const [rect, other] = store.addObjects([sample.rect(pageIds[0]), sample.pen(pageIds[1])]);
  const before = store.getState();
  store.updateObjects([{ id: rect, patch: { opacity: 0.5 } }]);
  const after = store.getState();
  assert.equal(after.pages, before.pages, "the page list is untouched by a property change");
  assert.equal(after.objects[other], before.objects[other]);
  assert.equal(after.objects[other].points, before.objects[other].points);
  assert.equal(after.sources, before.sources);
  assert.notEqual(after.objects[rect], before.objects[rect]);
  assert.equal(after.objects[rect].frame, before.objects[rect].frame, "an untouched property of a changed object is shared too");
  store.rotatePages([pageIds[2]], 90);
  const rotated = store.getState();
  assert.equal(rotated.pages[0], after.pages[0]);
  assert.equal(rotated.objects, after.objects);
  assert.equal(holdsBytes(rotated), false);
});

test("text frames follow the measurer and keep the anchor of their alignment, also when rotated", () => {
  for (const rot of [0, 90, 30, 215]) {
    for (const [align, anchor] of [["left", 0], ["center", 0.5], ["right", 1]]) {
      const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 2000, 2000] }] });
      const [id] = store.addObjects([sample.text(pageIds[0], { text: "abcd", align, frame: { x: 1000, y: 1000, w: 1, h: 1, rot } })]);
      let object = store.getState().objects[id];
      close(object.frame.w, 4 * 12 * 0.5, 1e-9, "width from the measurer");
      close(object.frame.h, 12 * 1.2, 1e-9, "height from the measurer");
      const anchorOf = (frame) => localToUser(frame, [anchor * frame.w, 0]);
      const fixed = anchorOf(object.frame);
      store.updateObjects([{ id, patch: { text: "abcd efgh\nij" } }]);
      object = store.getState().objects[id];
      close(object.frame.w, 9 * 6, 1e-9, `${align} @${rot}: width`);
      close(object.frame.h, 2 * 14.4, 1e-9, `${align} @${rot}: height`);
      closeAll(anchorOf(object.frame), fixed, 1e-9, `${align} @${rot}: the anchor stays where it is on the page`);
      assert.equal(object.frame.rot, rot);
      store.updateObjects([{ id, patch: { size: 24, bold: true } }]);
      object = store.getState().objects[id];
      close(object.frame.w, 9 * 12, 1e-9);
      closeAll(anchorOf(object.frame), fixed, 1e-9, `${align} @${rot}: after a size change`);
    }
  }
});

test("a wrapping text box keeps its width and its top edge; moving and recolouring do not measure", () => {
  let calls = 0;
  const measure = (object) => {
    calls += 1;
    assert.ok(Object.isFrozen(object));
    return fakeMeasure(object);
  };
  const { store, pageIds } = openStore({ measure, pages: [{ view: [0, 0, 2000, 2000] }] });
  const [id] = store.addObjects([sample.text(pageIds[0], { autoWidth: false, align: "center", text: "abcdefghij", frame: { x: 500, y: 500, w: 30, h: 5, rot: 90 } })]);
  let { frame } = store.getState().objects[id];
  assert.equal(frame.w, 30, "the wrap width is the user's");
  close(frame.h, 2 * 14.4, 1e-9, "5 characters per line -> 2 lines");
  const topLeft = localToUser(frame, [0, 0]);
  assert.equal(calls, 1);
  store.updateObjects([{ id, patch: { text: "abcdefghijklmno" } }]);
  frame = store.getState().objects[id].frame;
  close(frame.h, 3 * 14.4, 1e-9);
  closeAll(localToUser(frame, [0, 0]), topLeft, 1e-9, "the top edge stays");
  assert.equal(calls, 2);
  store.updateObjects([{ id, patch: { color: "#ff0000", underline: true, opacity: 0.5, align: "right" } }]);
  store.updateObjects([{ id, patch: { frame: { ...frame, x: frame.x + 40, rot: 45 } } }]);
  assert.equal(calls, 2, "no layout property changed");
  // a new width (dragging a side handle) re-wraps
  store.updateObjects([{ id, patch: { frame: { ...store.getState().objects[id].frame, w: 90 } } }]);
  assert.equal(calls, 3);
  close(store.getState().objects[id].frame.h, 14.4, 1e-9);
  // a frame height that does not match the text is corrected
  store.updateObjects([{ id, patch: { frame: { ...store.getState().objects[id].frame, h: 300 } } }]);
  close(store.getState().objects[id].frame.h, 14.4, 1e-9);
  // switching to autoWidth takes the natural width
  store.updateObjects([{ id, patch: { autoWidth: true } }]);
  close(store.getState().objects[id].frame.w, 15 * 6, 1e-9);
});

test("without a measurer frames are taken as given; setMeasureText injects one later; a failing measurer fails the command", () => {
  const { store, pageIds } = openStore({ measure: null });
  assert.equal(store.hasMeasureText(), false);
  const [id] = store.addObjects([sample.text(pageIds[0], { frame: { x: 200, y: 600, w: 77, h: 33, rot: 0 } })]);
  assert.deepEqual(store.getState().objects[id].frame, { x: 200, y: 600, w: 77, h: 33, rot: 0 });
  store.setMeasureText(fakeMeasure);
  assert.equal(store.hasMeasureText(), true);
  assert.equal(store.getState().objects[id].frame.w, 77, "existing boxes are measured when they change next");
  store.updateObjects([{ id, patch: { text: "abc" } }]);
  close(store.getState().objects[id].frame.w, 18, 1e-9);

  const before = store.getState();
  store.setMeasureText(() => {
    throw new PdfEditorError("TEXT_FONT_NOT_LOADED", { font: "arimo-regular" });
  });
  assert.throws(() => store.updateObjects([{ id, patch: { text: "later" } }]), (error) => error.code === "TEXT_FONT_NOT_LOADED");
  assert.throws(() => store.addObjects([sample.text(pageIds[0])]), (error) => error.code === "TEXT_FONT_NOT_LOADED");
  assert.equal(store.getState(), before);
  store.setMeasureText(() => ({ w: NaN, h: 3 }));
  assert.equal(codeOf(() => store.updateObjects([{ id, patch: { text: "nan" } }])), "MODEL_INVALID_OBJECT");
  // copies are not measured again: they have the size of their original
  store.setMeasureText(() => {
    throw new Error("must not be called");
  });
  store.duplicateObjects([id]);
  store.duplicatePages([pageIds[0]]);
  store.moveObjectsToPage([id], pageIds[1]);
  store.updateObjects([{ id, patch: { color: "#123456" } }]);
});

test("at least 8 pt of every object stay on its page, whatever a command asks for", () => {
  const { store, pageIds } = openStore({ pages: [{ view: [100, 200, 400, 600] }], measure: null });
  const [a] = pageIds;
  const view = store.getState().pages[0].view;
  const visible = (object) => {
    const bounds = objectBounds(object);
    return [Math.min(bounds[2], view[2]) - Math.max(bounds[0], view[0]), Math.min(bounds[3], view[3]) - Math.max(bounds[1], view[1])];
  };
  const ids = store.addObjects([
    sample.rect(a, { frame: { x: -500, y: 9000, w: 120, h: 80, rot: 0 } }),
    sample.line(a, { p1: [900, 900], p2: [950, 950] }),
    sample.redact(a, { rect: [-300, -300, -100, -200] }),
    sample.pen(a, { frame: { x: 250, y: 0, w: 4, h: 4, rot: 0 } }),
    sample.rect(a, { frame: { x: 250, y: 400, w: 120, h: 80, rot: 0 } })
  ]);
  const state = store.getState();
  for (const id of ids.slice(0, 3)) {
    const [w, h] = visible(state.objects[id]);
    close(w, 8, 1e-9, `${state.objects[id].type}: 8 pt wide on the page`);
    close(h, 8, 1e-9, `${state.objects[id].type}: 8 pt high on the page`);
  }
  closeAll(visible(state.objects[ids[3]]), [4, 4], 1e-9, "a small object stays on the page entirely");
  assert.deepEqual(state.objects[ids[4]].frame, { x: 250, y: 400, w: 120, h: 80, rot: 0 }, "what is on the page is not touched");
  store.updateObjects([{ id: ids[4], patch: { frame: { x: 250, y: 5000, w: 120, h: 80, rot: 0 } } }]);
  closeAll(visible(store.getState().objects[ids[4]]), [120, 8], 1e-9);
  consistent(store);
});

test("coalescing: updates with the same key within 500 ms are one undo step", () => {
  let clock = 1000;
  const { store, pageIds } = openStore({ storeOptions: { now: () => clock } });
  const [rect, other] = store.addObjects([sample.rect(pageIds[0]), sample.rect(pageIds[0])]);
  store.clearHistory();
  const slide = (value, key = "opacity") => store.updateObjects([{ id: rect, patch: { opacity: value } }], { coalesceKey: key });

  for (let tick = 1; tick <= 20; tick += 1) {
    clock += 100; // a slow drag: two seconds in total, never more than 500 ms between two updates
    slide(1 - tick / 40);
  }
  assert.equal(store.getHistoryState().undoDepth, 1, "a slider drag is one step");
  store.undo();
  assert.equal(store.getState().objects[rect].opacity, 1, "undo goes back to before the drag");
  store.redo();
  assert.equal(store.getState().objects[rect].opacity, 0.5);

  clock += 100;
  slide(0.4);
  assert.equal(store.getHistoryState().undoDepth, 2, "redo ended the chain");
  clock += 501;
  slide(0.3);
  assert.equal(store.getHistoryState().undoDepth, 3, "too late: a new step");
  clock += 10;
  slide(0.2, "strokeWidth");
  assert.equal(store.getHistoryState().undoDepth, 4, "another key: a new step");
  clock += 10;
  slide(0.25, "strokeWidth");
  assert.equal(store.getHistoryState().undoDepth, 4);
  clock += 10;
  store.updateObjects([{ id: other, patch: { opacity: 0.9 } }]);
  clock += 10;
  slide(0.1, "strokeWidth");
  assert.equal(store.getHistoryState().undoDepth, 6, "a command in between ends the chain");
  clock += 10;
  store.undo();
  clock += 10;
  slide(0.15, "strokeWidth");
  clock += 10;
  slide(0.16, "strokeWidth");
  assert.equal(store.getHistoryState().undoDepth, 6, "after an undo the next update starts a new step, then merges again");
  // a transaction can be coalesced as a whole
  for (let tick = 0; tick < 5; tick += 1) {
    clock += 50;
    store.transaction(() => {
      store.updateObjects([{ id: rect, patch: { strokeWidth: 3 + tick } }]);
      store.updateObjects([{ id: other, patch: { strokeWidth: 3 + tick } }]);
    }, { coalesceKey: "both" });
  }
  assert.equal(store.getHistoryState().undoDepth, 7);
});

test("transaction: several commands are one step, nested ones join, a failure rolls everything back", () => {
  const { store, pageIds } = openStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  const result = store.transaction(() => {
    const [rect] = store.addObjects([sample.rect(pageIds[0])]);
    assert.ok(store.getState().objects[rect], "commands see the working state");
    store.transaction(() => {
      store.rotatePages([pageIds[1]], 90);
      store.setFileName("khác");
    });
    store.updateObjects([{ id: rect, patch: { opacity: 0.3 } }]);
    return rect;
  });
  assert.equal(typeof result, "string");
  assert.equal(notifications, 1, "one notification for the whole transaction");
  assert.equal(store.getHistoryState().undoDepth, 1);
  store.undo();
  assert.deepEqual(store.getState().objects, {});
  assert.equal(store.getState().pages[1].rotation, 0);
  assert.equal(store.getState().fileName, "hop-dong");
  store.redo();
  assert.equal(store.getState().objects[result].opacity, 0.3);

  const before = store.getState();
  const depth = store.getHistoryState().undoDepth;
  notifications = 0;
  let assetId;
  assert.throws(() => store.transaction(() => {
    assetId = store.addAsset({ mime: "image/png", width: 2, height: 2 }, bytesOf(10, 9));
    store.addObjects([sample.image(pageIds[0], assetId)]);
    store.deletePages([pageIds[2]]);
    store.addObjects([{ type: "nothing", pageId: pageIds[0] }]);
  }), (error) => error.code === "MODEL_INVALID_OBJECT");
  assert.equal(store.getState(), before, "the document is exactly what it was");
  assert.equal(store.getHistoryState().undoDepth, depth);
  assert.equal(notifications, 0);
  assert.equal(store.getAssetBytes(assetId), null, "what the transaction registered is gone too");

  // an inner failure that the outer function handles only undoes the inner part
  store.transaction(() => {
    store.rotatePages([pageIds[0]], 90);
    assert.throws(() => store.transaction(() => {
      store.rotatePages([pageIds[0]], 90);
      throw new Error("inner");
    }), /inner/);
    assert.equal(store.getState().pages[0].rotation, 90);
  });
  assert.equal(store.getState().pages[0].rotation, 90);

  assert.equal(codeOf(() => store.transaction(async () => {
    store.rotatePages([pageIds[0]], 90);
  })), "MODEL_TRANSACTION_ASYNC");
  assert.equal(store.getState().pages[0].rotation, 90, "an asynchronous function is refused and rolled back");
  assert.equal(codeOf(() => store.transaction(() => store.undo())), "MODEL_INVALID_CALL");
  assert.equal(codeOf(() => store.transaction(() => store.reset())), "MODEL_INVALID_CALL");
  assert.equal(codeOf(() => store.transaction("fn")), "MODEL_INVALID_ARGUMENT");
  // a transaction that changes nothing is no step
  const steps = store.getHistoryState().undoDepth;
  store.transaction(() => store.updateObjects([]));
  assert.equal(store.getHistoryState().undoDepth, steps);
});

test("the history keeps 200 steps; a new command after an undo drops the redo steps", () => {
  const { store, pageIds } = openStore({ measure: null });
  const [rect] = store.addObjects([sample.rect(pageIds[0])]);
  for (let step = 0; step < 230; step += 1) store.updateObjects([{ id: rect, patch: { strokeWidth: 1 + step / 100 } }]);
  assert.equal(store.getHistoryState().undoDepth, 200);
  let undone = 0;
  while (store.undo()) undone += 1;
  assert.equal(undone, 200);
  assert.ok(store.getState().objects[rect], "the oldest steps are gone: the rectangle can no longer be un-added");
  close(store.getState().objects[rect].strokeWidth, 1.29, 1e-9, "231 steps were made: the 31 oldest are gone");
  assert.equal(store.getHistoryState().redoDepth, 200);
  store.redo();
  store.updateObjects([{ id: rect, patch: { opacity: 0.5 } }]);
  assert.equal(store.canRedo(), false);
  assert.equal(store.getHistoryState().undoDepth, 2);

  const small = openStore({ storeOptions: { historyLimit: 3 }, measure: null });
  for (let step = 0; step < 10; step += 1) small.store.insertBlankPage(0, [100 + step, 100]);
  assert.equal(small.store.getHistoryState().undoDepth, 3);
});

test("isPristine: exactly one untouched source", () => {
  const { store, sourceId, pageIds } = openStore();
  const check = (expected, label) => {
    assert.equal(store.isPristine(), expected, label);
    assert.equal(store.pristineSourceId(), expected ? sourceId : null, label);
  };
  check(true, "freshly opened");
  store.addAsset({ mime: "image/jpeg", width: 5, height: 5 }, bytesOf(12, 5));
  const second = store.addSource(sourceFacts([{}]), bytesOf(50, 2), { name: "other.pdf" });
  check(true, "registering an asset or a source that no page uses changes nothing");

  store.rotatePages([pageIds[1]], 90);
  check(false, "a rotated page");
  store.undo();
  check(true, "undone");
  store.rotatePages([pageIds[1]], 90);
  store.rotatePages([pageIds[1]], 270);
  check(true, "turned all the way round");

  const [rect] = store.addObjects([sample.rect(pageIds[0])]);
  check(false, "an object");
  store.deleteObjects([rect]);
  check(true, "the object deleted again");
  store.addObjects([sample.redact(pageIds[2])]);
  check(false, "a mark");
  store.undo();

  store.movePages([pageIds[0]], 2);
  check(false, "another order");
  store.movePages([pageIds[0]], 0);
  check(true, "the original order again");
  store.deletePages([pageIds[2]]);
  check(false, "a page is missing");
  store.undo();
  store.duplicatePages([pageIds[0]]);
  check(false, "a page twice");
  store.undo();
  store.insertBlankPage(3, [100, 100]);
  check(false, "a blank page");
  store.undo();
  store.insertPages(store.pagesOfSource(second), 3);
  check(false, "pages of two sources");
  store.undo();
  check(true, "back to the original");

  const blank = createEditorStore();
  blank.insertBlankPage(0, [595, 842]);
  assert.equal(blank.isPristine(), false, "a blank document has no original bytes");
});

test("markSaved and isDirty follow pages and objects, not the download name or the registries", () => {
  const { store, pageIds } = openStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  assert.equal(store.isDirty(), false);
  store.setFileName("tên mới");
  store.addAsset({ mime: "image/png", width: 1, height: 1 }, bytesOf(8, 4));
  assert.equal(store.isDirty(), false);
  const [rect] = store.addObjects([sample.rect(pageIds[0])]);
  assert.equal(store.isDirty(), true);
  assert.equal(store.getHistoryState().dirty, true);
  store.undo();
  assert.equal(store.isDirty(), false, "back at the saved document");
  store.redo();
  notifications = 0;
  store.markSaved();
  assert.equal(notifications, 1, "subscribers learn that the document is clean");
  assert.equal(store.isDirty(), false);
  store.markSaved();
  assert.equal(notifications, 1);
  store.undo();
  assert.equal(store.isDirty(), true, "undoing past the saved point is a change");
  store.redo();
  assert.equal(store.isDirty(), false);
  store.deleteObjects([rect]);
  assert.equal(store.isDirty(), true);
  const history = store.getHistoryState();
  assert.equal(store.getHistoryState(), history, "the same object while nothing changes");
  assert.deepEqual(Object.keys(history).sort(), ["canRedo", "canUndo", "dirty", "redoDepth", "undoDepth"]);
});

test("reset starts a new document: state, history, bytes and saved marker are gone", () => {
  const { store, sourceId, pageIds } = openStore({ password: "pw" });
  const assetId = store.addAsset({ mime: "image/png", width: 2, height: 2 }, bytesOf(20, 6));
  store.addObjects([sample.image(pageIds[0], assetId)]);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  store.reset();
  assert.equal(notifications, 1);
  assert.deepEqual(store.getState(), { fileName: "", sources: {}, pages: [], objects: {}, assets: {} });
  assert.equal(store.canUndo(), false);
  assert.equal(store.isDirty(), false);
  assert.equal(store.getSourceBytes(sourceId), null);
  assert.equal(store.getSourcePassword(sourceId), undefined);
  assert.equal(store.getAssetBytes(assetId), null);
  // a setup that fails leaves an empty store
  assert.throws(() => store.reset(() => {
    store.insertBlankPage(0, [100, 100]);
    throw new Error("could not open");
  }), /could not open/);
  assert.equal(store.getState().pages.length, 0);
  assert.equal(codeOf(() => store.reset(async () => {})), "MODEL_TRANSACTION_ASYNC");
  // clearHistory keeps the document
  store.insertBlankPage(0, [100, 100]);
  store.insertBlankPage(0, [100, 100]);
  store.undo();
  store.clearHistory();
  assert.equal(store.getState().pages.length, 1);
  assert.deepEqual([store.canUndo(), store.canRedo()], [false, false]);
});

test("sources and assets stay registered exactly as long as the document or its history can need them", () => {
  const { store, pageIds } = openStore({ measure: null });
  const extraBytes = bytesOf(70, 9);
  const extra = store.addSource(sourceFacts([{}, {}]), extraBytes, { name: "phu-luc.pdf", password: "pw" });
  store.insertPages(store.pagesOfSource(extra), 3);
  store.undo();
  assert.ok(store.getState().sources[extra], "the redo step still needs it");
  assert.equal(store.getSourceBytes(extra), extraBytes);
  store.redo();
  store.undo();
  store.insertBlankPage(0, [100, 100]); // the redo step is dropped
  assert.equal(store.getState().sources[extra], undefined, "nothing can bring its pages back");
  assert.equal(store.getSourceBytes(extra), null);
  assert.equal(store.getSourcePassword(extra), undefined);

  const imageBytes = bytesOf(30, 8);
  const assetId = store.addAsset({ mime: "image/png", width: 4, height: 4 }, imageBytes);
  assert.equal(store.addAsset({ mime: "image/png", width: 4, height: 4 }, bytesOf(30, 8)), assetId, "the same picture is registered once");
  assert.notEqual(store.addAsset({ mime: "image/png", width: 4, height: 4 }, bytesOf(30, 2)), assetId);
  const [image] = store.addObjects([sample.image(pageIds[0], assetId)]);
  store.deleteObjects([image]);
  for (let step = 0; step < 5; step += 1) store.rotatePages([pageIds[0]], 90);
  assert.equal(store.getAssetBytes(assetId), imageBytes, "undo could bring the picture back");
  store.clearHistory();
  assert.equal(store.getAssetBytes(assetId), null);
  assert.equal(store.getState().assets[assetId], undefined);

  // a registered picture that was never used waits for its object (the user is still placing it)
  const waiting = store.addAsset({ mime: "image/jpeg", width: 9, height: 9 }, bytesOf(25, 1));
  store.rotatePages([pageIds[0]], 90);
  store.undo();
  store.rotatePages([pageIds[1]], 90);
  store.clearHistory();
  assert.ok(store.getAssetBytes(waiting));
  const [placed] = store.addObjects([sample.image(pageIds[0], waiting)]);
  assert.equal(store.discardAsset(waiting), false, "in use");
  store.deleteObjects([placed]);
  assert.equal(store.discardAsset(waiting), false, "the history still needs it");
  store.clearHistory();
  assert.equal(store.getAssetBytes(waiting), null, "used once, now unreachable: collected");
  const cancelled = store.addAsset({ mime: "image/jpeg", width: 9, height: 9 }, bytesOf(25, 1));
  assert.equal(store.discardAsset(cancelled), true, "the placement was cancelled");
  assert.equal(store.getState().assets[cancelled], undefined);
  const unusedSource = store.addSource(sourceFacts([{}]), bytesOf(33, 3));
  assert.equal(store.discardSource(unusedSource), true);
  assert.equal(store.discardSource(unusedSource), false);
  assert.equal(codeOf(() => store.addAsset({ mime: "image/gif", width: 1, height: 1 }, bytesOf(5))), "MODEL_INVALID_ASSET");
  assert.equal(codeOf(() => store.addAsset({ mime: "image/png", width: 0, height: 1 }, bytesOf(5))), "MODEL_INVALID_ASSET");
  consistent(store);
});

test("moveObjectsToPage keeps the place on screen, or puts the group where it is asked", () => {
  const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800] }, { view: [0, 0, 600, 800], rotate: 90 }, { view: [0, 0, 300, 300] }], measure: null });
  const [a, b, c] = pageIds;
  const page = (id) => store.getState().pages.find((candidate) => candidate.id === id);
  const [rect, text] = store.addObjects([
    sample.rect(a, { frame: { x: 150, y: 700, w: 100, h: 40, rot: 0 } }),
    sample.text(a, { frame: { x: 300, y: 650, w: 60, h: 20, rot: 0 }, replaces: { rect: [270, 640, 330, 660], cover: null, sourceText: "x" } })
  ]);
  const boxOnA = objectScreenBox(store.getState().objects[rect], page(a));
  assert.deepEqual(boxOnA, [100, 80, 200, 120]);

  store.moveObjectsToPage([rect, text], b);
  let state = store.getState();
  closeAll(objectScreenBox(state.objects[rect], page(b)), boxOnA, 1e-9, "the same place as the reader sees it");
  assert.equal(state.objects[rect].frame.rot, 90, "still upright on a page with /Rotate 90");
  assert.equal(state.objects[text].replaces, undefined, "the replaced line stays on the page it belongs to");
  assert.deepEqual(page(b).objectIds, [rect, text]);
  assert.deepEqual(page(a).objectIds, []);

  store.moveObjectsToPage([rect], c);
  closeAll(objectScreenBox(store.getState().objects[rect], page(c)), boxOnA, 1e-9, "it fits on the small page: same place");
  store.moveObjectsToPage([text], c);
  const textBox = objectScreenBox(store.getState().objects[text], page(c));
  closeAll(textBox, [240, 140, 300, 160], 1e-9, "it would stick out on the right: moved onto the page");

  store.moveObjectsToPage([rect, text], a, { at: [300, 400] });
  state = store.getState();
  const union = [rect, text].map((id) => objectScreenBox(state.objects[id], page(a)));
  close((Math.min(union[0][0], union[1][0]) + Math.max(union[0][2], union[1][2])) / 2, 300, 1e-9, "the middle of the group at the point");
  store.moveObjectsToPage([rect], b, "center");
  const centred = objectScreenBox(store.getState().objects[rect], page(b));
  closeAll([(centred[0] + centred[2]) / 2, (centred[1] + centred[3]) / 2], [400, 300], 1e-9, "the visible page with /Rotate 90 is 800 x 600");
  store.moveObjectsToPage([rect], a, { offset: [-390, -290], fit: false });
  closeAll(objectScreenBox(store.getState().objects[rect], page(a)), [-40, -10, 60, 30], 1e-9, "an offset without fitting: only the 8 pt rule applies");
  consistent(store);
});

test("duplicateObjects offsets the copies as the reader sees it and never copies a replacement marker or a text highlight", () => {
  for (const [rotate, extra] of [[0, 0], [90, 0], [180, 90], [270, 270]]) {
    const { store, pageIds } = openStore({ pages: [{ view: [0, 0, 600, 800], rotate }], measure: null });
    store.rotatePages(pageIds, extra);
    const page = () => store.getState().pages[0];
    const [rect, text, highlight] = store.addObjects([
      sample.rect(pageIds[0], { frame: { x: 300, y: 400, w: 100, h: 40, rot: 20 } }),
      sample.text(pageIds[0], { frame: { x: 300, y: 300, w: 60, h: 20, rot: 0 }, replaces: { rect: [1, 2, 3, 4], cover: null, sourceText: "x" } }),
      sample.highlightText(pageIds[0])
    ]);
    const copies = store.duplicateObjects([rect, text, highlight]);
    assert.equal(copies.length, 2, "a text highlight belongs to its text: it is not duplicated");
    const state = store.getState();
    const before = objectScreenBox(state.objects[rect], page());
    const after = objectScreenBox(state.objects[copies[0]], page());
    closeAll(after, before.map((value) => value + 12), 1e-9, `/Rotate ${rotate} + ${extra}: 12 pt right and down on screen`);
    assert.equal(state.objects[copies[0]].frame.rot, 20);
    assert.equal(state.objects[copies[1]].replaces, undefined);
    assert.ok(state.objects[text].replaces);
    const none = store.duplicateObjects([rect], [0, 0]);
    assert.deepEqual(store.getState().objects[none[0]].frame, state.objects[rect].frame, "offset [0, 0] for a copy that is dragged away");
  }
  const { store, pageIds } = openStore();
  assert.throws(() => store.duplicateObjects([], "12"), (error) => error.code === "MODEL_INVALID_ARGUMENT");
  assert.deepEqual(store.duplicateObjects(["ghost"]), []);
  assert.equal(objectsOfPage(store.getState(), pageIds[0]).objects.length, 0);
});

test("the codes of the model are complete and well formed", () => {
  for (const [code, params] of Object.entries(CODES)) {
    assert.match(code, /^MODEL_[A-Z0-9_]+$/);
    assert.ok(Array.isArray(params) && params.every((name) => typeof name === "string"), code);
  }
  for (const code of USER_FACING_CODES) assert.ok(Object.hasOwn(CODES, code));
  // every code the model sources mention is declared, and every declared code is thrown somewhere
  const directory = new URL("../src/pages/pdfEditor/model/", import.meta.url);
  const used = new Set();
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".js") || name === "codes.js" || name === "schema.js") continue;
    for (const match of fs.readFileSync(new URL(name, directory), "utf8").matchAll(/"(MODEL_[A-Z0-9_]+)"/g)) used.add(match[1]);
  }
  assert.deepEqual([...used].sort(), Object.keys(CODES).sort());
  assert.equal(normalizeFileName("  a/b\\c.pdf  "), "a-b-c");
  assert.equal(normalizeFileName(null), "");
  assert.equal(normalizeFileName("x".repeat(400)).length, 150);
  assert.equal(normalizeFileName(`tab${String.fromCharCode(9)}and${String.fromCharCode(0)}nul`), "tab and nul");
});
