// The page operations of the PDF editor (src/pages/pdfEditor/pages/pageOps.js) and the state of the page
// panels (pagesState.js), against the real document store, UI store and actions (tests/helpers/pdfUiKit.mjs):
// every operation is one undo step, asks before a signed document is changed, refuses a view-only one, and
// says what happened.
import test from "node:test";
import assert from "node:assert/strict";
import { deletePages, duplicatePages, extractPages, insertBlankPages, insertImagePages, insertSourcePages, movePages, movePagesByStep, movePagesToPosition, pageIdsOfNumbers, pruneSelection, rotatePages } from "../src/pages/pdfEditor/pages/pageOps.js";
import { announce, getPagesState, openMenu, patchPagesState, resetPagesState, revealPage, selectedPageIds, setSelection, setThumbSize, targetPageIds } from "../src/pages/pdfEditor/pages/pagesState.js";
import { bytesOf, sample } from "./helpers/pdfModelKit.mjs";
import { fileItem, flush, makeKernel } from "./helpers/pdfUiKit.mjs";

const first = (seed) => bytesOf(1, seed)[0]; // the byte the stand-in viewer recognises a file by
const pagesOf = (kernel) => kernel.store.getState().pages;
const idsOf = (kernel) => pagesOf(kernel).map((page) => page.id);
const toastsOf = (kernel) => kernel.ui.getState().toasts.map((toast) => [toast.tone, toast.message, toast.undo]);
const said = (kernel) => getPagesState(kernel.ui).announcement.text;
const depth = (kernel) => kernel.store.getHistoryState().undoDepth;

/** A document of `count` pages from one file ("hop-dong.pdf"), the editability check answered. */
async function opened(count = 5, options = {}) {
  const kernel = makeKernel({ files: { [first(1)]: { pages: Array.from({ length: count }, () => ({})), ...(options.file || {}) }, ...(options.files || {}) }, plan: options.plan || {}, manifests: options.manifests || [] });
  await kernel.actions.openFiles([fileItem("hop-dong.pdf", 1)]);
  await flush();
  return kernel;
}

// --- state of the panels -----------------------------------------------------------------------------------------

test("the feature bag starts empty and keeps its identity while nothing changes", async () => {
  const kernel = await opened(3);
  const state = getPagesState(kernel.ui);
  assert.deepEqual(state.selected, []);
  assert.equal(state.anchor, null);
  assert.equal(state.menu, null);
  assert.equal(state.size, "m");
  let notified = 0;
  kernel.ui.subscribe(() => (notified += 1));
  assert.equal(patchPagesState(kernel.ui, { anchor: null }), false, "the same value is no change");
  assert.equal(setSelection(kernel.ui, { selected: [] }), false);
  assert.equal(notified, 0);
  const [a, b] = idsOf(kernel);
  assert.equal(setSelection(kernel.ui, { selected: [b, a], anchor: a, focus: b }), true);
  assert.equal(notified, 1);
  assert.deepEqual(selectedPageIds(kernel.editor), [a, b], "readers get the selection in document order");
  assert.equal(setSelection(kernel.ui, { selected: [b, a] }), false, "the same list again is no change");
});

test("a command without pages named acts on the selection, else the focused page, else the page being read", async () => {
  const kernel = await opened(4);
  const [a, b, c] = idsOf(kernel);
  kernel.viewer.getSnapshot = () => ({ currentPageId: c, currentPageNumber: 3, pageCount: 4, zoom: 1, zoomMode: "actual", search: { query: "", total: 0, current: -1, running: false } });
  assert.deepEqual(targetPageIds(kernel.editor), [c]);
  setSelection(kernel.ui, { focus: b });
  assert.deepEqual(targetPageIds(kernel.editor), [b]);
  setSelection(kernel.ui, { selected: [c, a] });
  assert.deepEqual(targetPageIds(kernel.editor), [a, c]);
  setSelection(kernel.ui, { selected: ["gone"], focus: "gone" });
  assert.deepEqual(targetPageIds(kernel.editor), [c], "pages that no longer exist do not count");
});

test("announcements, reveal requests, the menu and the thumbnail size live in the bag", async () => {
  const kernel = await opened(2);
  announce(kernel.ui, "one");
  const before = getPagesState(kernel.ui).announcement;
  announce(kernel.ui, "one");
  assert.equal(getPagesState(kernel.ui).announcement.token, before.token + 1, "the same sentence twice is said twice");
  revealPage(kernel.ui, "p");
  assert.equal(getPagesState(kernel.ui).reveal.id, "p");
  openMenu(kernel.ui, { kind: "page", x: 1, y: 2, pageIds: ["p"] });
  assert.equal(getPagesState(kernel.ui).menu.kind, "page");
  assert.equal(setThumbSize(kernel.ui, "l"), true);
  assert.equal(setThumbSize(kernel.ui, "huge"), false);
  setSelection(kernel.ui, { selected: idsOf(kernel), anchor: idsOf(kernel)[0] });
  resetPagesState(kernel.ui);
  const state = getPagesState(kernel.ui);
  assert.deepEqual([state.selected, state.anchor, state.focus, state.menu], [[], null, null, null]);
  assert.equal(state.size, "l", "the size is a preference, not part of a document");
});

test("the selection follows the document: undo removes what it named", async () => {
  const kernel = await opened(3);
  const copies = await duplicatePages(kernel.editor, [idsOf(kernel)[0]]);
  assert.deepEqual(getPagesState(kernel.ui).selected, copies);
  kernel.actions.undo();
  assert.equal(pruneSelection(kernel.editor), true);
  const state = getPagesState(kernel.ui);
  assert.deepEqual([state.selected, state.anchor, state.focus], [[], null, null]);
  assert.equal(pruneSelection(kernel.editor), false);
  assert.deepEqual(pageIdsOfNumbers(kernel.editor, [3, 1, 9]), [idsOf(kernel)[2], idsOf(kernel)[0]]);
});

// --- rotate, duplicate, delete ---------------------------------------------------------------------------------

test("rotate: one undo step, any number of pages, said for screen readers", async () => {
  const kernel = await opened(4);
  const [a, b, c] = idsOf(kernel);
  assert.deepEqual(await rotatePages(kernel.editor, [c, a], 90), [a, c]);
  assert.deepEqual(pagesOf(kernel).map((page) => page.rotation), [90, 0, 90, 0]);
  assert.equal(depth(kernel), 1);
  assert.equal(said(kernel), "2 pages rotated to the right");
  await rotatePages(kernel.editor, [b], -90);
  assert.equal(pagesOf(kernel)[1].rotation, 270);
  assert.equal(said(kernel), "Page 2 rotated to the left");
  assert.equal(depth(kernel), 2);
  kernel.actions.undo();
  kernel.actions.undo();
  assert.deepEqual(pagesOf(kernel).map((page) => page.rotation), [0, 0, 0, 0]);
  assert.equal(await rotatePages(kernel.editor, ["nobody"], 90), null, "unknown pages change nothing");
  assert.equal(await rotatePages(kernel.editor, [a], 45), null, "a refusal of the store is caught");
  assert.deepEqual(toastsOf(kernel), [["error", "<MODEL_INVALID_ROTATION>", false]]);
  assert.equal(depth(kernel), 0);
});

test("duplicate: the copy follows its page with the objects on it and becomes the selection", async () => {
  const kernel = await opened(3);
  const [a, b] = idsOf(kernel);
  kernel.store.addObjects([sample.rect(b)]);
  kernel.store.clearHistory();
  const copies = await duplicatePages(kernel.editor, [b, a]);
  assert.equal(copies.length, 2);
  const pages = pagesOf(kernel);
  assert.deepEqual(pages.map((page) => page.id), [a, copies[0], b, copies[1], idsOf(kernel)[4]]);
  assert.equal(pages[3].objectIds.length, 1, "the objects of the page are copied");
  assert.notEqual(pages[3].objectIds[0], pages[2].objectIds[0]);
  assert.deepEqual(getPagesState(kernel.ui).selected, copies);
  assert.equal(said(kernel), "2 pages duplicated");
  assert.equal(depth(kernel), 1);
  kernel.actions.undo();
  assert.equal(pagesOf(kernel).length, 3);
  await duplicatePages(kernel.editor, [b]);
  assert.equal(said(kernel), "Page 2 duplicated");
});

test("delete: no question, a toast with Undo that brings the pages back", async () => {
  const kernel = await opened(5);
  const [a, b, c, d, e] = idsOf(kernel);
  setSelection(kernel.ui, { selected: [b, c], anchor: b, focus: c });
  assert.deepEqual(await deletePages(kernel.editor, [c, b]), [b, c]);
  assert.deepEqual(idsOf(kernel), [a, d, e]);
  assert.deepEqual(toastsOf(kernel), [["success", "2 pages deleted", true]]);
  assert.equal(kernel.asked.length, 0, "nothing was asked");
  const state = getPagesState(kernel.ui);
  assert.deepEqual(state.selected, []);
  assert.equal(state.focus, d, "the keyboard stays where the first deleted page was");
  assert.equal(depth(kernel), 1);
  kernel.ui.undoToast(kernel.ui.getState().toasts[0].id);
  assert.deepEqual(idsOf(kernel), [a, b, c, d, e]);
  await deletePages(kernel.editor, [e]);
  assert.equal(toastsOf(kernel).at(-1)[1], "1 page deleted");
  assert.equal(getPagesState(kernel.ui).focus, d, "after the last page was deleted the focus is on the new last page");
});

test("the last page cannot be deleted: the sentence of the store's refusal, nothing changes", async () => {
  const kernel = await opened(2);
  const all = idsOf(kernel);
  assert.equal(await deletePages(kernel.editor, all), null);
  assert.deepEqual(idsOf(kernel), all);
  assert.deepEqual(toastsOf(kernel), [["error", "<MODEL_LAST_PAGE>", false]]);
  assert.equal(depth(kernel), 0);
  await deletePages(kernel.editor, [all[0]]);
  assert.equal(await deletePages(kernel.editor, [all[1]]), null, "the one page that is left stays");
  assert.equal(pagesOf(kernel).length, 1);
});

test("the Undo of a delete toast never takes back another change", async () => {
  const kernel = await opened(4);
  const [a, b] = idsOf(kernel);
  await deletePages(kernel.editor, [a]);
  const toast = kernel.ui.getState().toasts[0].id;
  await rotatePages(kernel.editor, [b], 90);
  kernel.ui.undoToast(toast);
  assert.equal(pagesOf(kernel).length, 3, "the deleted page did not come back by taking the rotation away");
  assert.equal(pagesOf(kernel)[0].rotation, 90, "the rotation is still there");
  assert.equal(toastsOf(kernel).at(-1)[1], "Other changes were made since. Use Undo (Ctrl+Z) to go back step by step.");
});

// --- moving -------------------------------------------------------------------------------------------------

test("move: by a drop index, one place by keyboard, to a position by number", async () => {
  const kernel = await opened(5);
  const [a, b, c, d, e] = idsOf(kernel);
  assert.equal(await movePages(kernel.editor, [b], 3), true);
  assert.deepEqual(idsOf(kernel), [a, c, d, b, e]);
  assert.equal(said(kernel), "Page 2 moved to position 4");
  assert.equal(depth(kernel), 1);
  assert.equal(await movePages(kernel.editor, [b], 3), false, "a move to the same place is no step");
  assert.equal(depth(kernel), 1);

  assert.equal(await movePagesByStep(kernel.editor, [b], "later"), true);
  assert.deepEqual(idsOf(kernel), [a, c, d, e, b]);
  assert.equal(said(kernel), "Page 4 moved to position 5");
  assert.equal(await movePagesByStep(kernel.editor, [b], "later"), false);
  assert.equal(said(kernel), "Already at the end");
  assert.equal(await movePagesByStep(kernel.editor, [a], "earlier"), false);
  assert.equal(said(kernel), "Already at the beginning");
  assert.equal(await movePagesByStep(kernel.editor, [d, e], "earlier"), true);
  assert.deepEqual(idsOf(kernel), [a, d, e, c, b]);
  assert.equal(said(kernel), "2 pages moved to position 2");

  assert.equal(await movePagesToPosition(kernel.editor, [b], 1), true);
  assert.deepEqual(idsOf(kernel), [b, a, d, e, c]);
  assert.equal(await movePagesToPosition(kernel.editor, [b], 1), false);
  assert.equal(await movePagesToPosition(kernel.editor, [a, c], 99), true);
  assert.deepEqual(idsOf(kernel), [b, d, e, a, c]);
  const steps = depth(kernel);
  for (let step = 0; step < steps; step += 1) kernel.actions.undo();
  assert.deepEqual(idsOf(kernel), [a, b, c, d, e], "every move was exactly one undo step");
});

// --- inserting -----------------------------------------------------------------------------------------------

test("blank pages: any number of them is one undo step; they are selected and shown", async () => {
  const kernel = await opened(3);
  const before = idsOf(kernel);
  const created = await insertBlankPages(kernel.editor, { size: [595.28, 841.89], index: 1, count: 3 });
  assert.equal(created.length, 3);
  assert.deepEqual(idsOf(kernel), [before[0], ...created, before[1], before[2]]);
  assert.deepEqual(pagesOf(kernel).slice(1, 4).map((page) => [page.kind, page.view]), Array.from({ length: 3 }, () => ["blank", [0, 0, 595.28, 841.89]]));
  assert.deepEqual(getPagesState(kernel.ui).selected, created);
  assert.equal(getPagesState(kernel.ui).reveal.id, created[0]);
  assert.deepEqual(kernel.viewer.calls.at(-1), ["scrollToPage", created[0]]);
  assert.equal(said(kernel), "3 blank pages inserted from page 2");
  assert.equal(depth(kernel), 1);
  kernel.actions.undo();
  assert.deepEqual(idsOf(kernel), before);
  await insertBlankPages(kernel.editor, { size: [300, 400], index: 3 });
  assert.equal(said(kernel), "Blank page inserted as page 4");
  assert.equal(await insertBlankPages(kernel.editor, { size: [0, 400], index: 0 }), null, "a size the store refuses inserts nothing");
  assert.equal(toastsOf(kernel).at(-1)[1], "<MODEL_INVALID_PAGE_SIZE>");
});

test("pages of another PDF: the chosen pages in the order given, one undo step, the other features are told", async () => {
  const heard = [];
  const kernel = await opened(3, { files: { [first(2)]: { pages: [{}, {}, {}, {}] } }, manifests: [{ id: "listener", onDocumentOpened: (editor, payload) => heard.push(payload.name) }] });
  heard.length = 0;
  const before = idsOf(kernel);
  const loaded = await kernel.actions.loadSource(fileItem("phu-luc.pdf", 2));
  assert.equal(loaded.pageCount, 4);
  assert.equal(depth(kernel), 0, "registering the file is not a step");
  const created = await insertSourcePages(kernel.editor, { sourceId: loaded.sourceId, indices: [2, 0], index: 1, fileName: loaded.name, facts: loaded.facts });
  assert.equal(created.length, 2);
  assert.deepEqual(idsOf(kernel), [before[0], ...created, before[1], before[2]]);
  assert.deepEqual(pagesOf(kernel).slice(1, 3).map((page) => [page.sourceId, page.sourceIndex]), [[loaded.sourceId, 2], [loaded.sourceId, 0]]);
  assert.deepEqual(heard, ["phu-luc.pdf"]);
  assert.deepEqual(toastsOf(kernel).at(-1), ["success", "2 pages added from phu-luc.pdf", true]);
  assert.equal(depth(kernel), 1);
  kernel.ui.undoToast(kernel.ui.getState().toasts.at(-1).id);
  assert.deepEqual(idsOf(kernel), before);
});

test("pages of another PDF: a refused insert forgets the file again", async () => {
  const kernel = await opened(2, { files: { [first(2)]: { pages: [{}, {}] } } });
  const loaded = await kernel.actions.loadSource(fileItem("phu-luc.pdf", 2));
  assert.ok(kernel.store.getState().sources[loaded.sourceId]);
  assert.equal(await insertSourcePages(kernel.editor, { sourceId: loaded.sourceId, indices: [7], index: 0, fileName: loaded.name }), null);
  assert.equal(kernel.store.getState().sources[loaded.sourceId], undefined, "the source that gave no page is discarded");
  assert.equal(pagesOf(kernel).length, 2);
});

test("pictures as pages: a blank page with an image object per picture, in one undo step", async () => {
  const kernel = await opened(2);
  const before = idsOf(kernel);
  const images = [
    { mime: "image/png", width: 800, height: 600, bytes: bytesOf(40, 7) },
    { mime: "image/jpeg", width: 600, height: 1200, bytes: bytesOf(40, 8) }
  ];
  const created = await insertImagePages(kernel.editor, { images, mode: "image", index: 2 });
  assert.equal(created.length, 2);
  const state = kernel.store.getState();
  assert.deepEqual(idsOf(kernel), [...before, ...created]);
  const [wide, tall] = state.pages.slice(2);
  assert.deepEqual([wide.kind, wide.view], ["blank", [0, 0, 600, 450]], "a page of the picture's own size");
  assert.deepEqual(tall.view, [0, 0, 450, 900]);
  const picture = state.objects[wide.objectIds[0]];
  assert.equal(picture.type, "image");
  assert.deepEqual(picture.frame, { x: 300, y: 225, w: 600, h: 450, rot: 0 }, "the picture covers its page");
  assert.equal(state.assets[picture.assetId].mime, "image/png");
  assert.equal(Object.keys(state.assets).length, 2);
  assert.deepEqual(toastsOf(kernel).at(-1), ["success", "2 images added as pages", true]);
  assert.equal(depth(kernel), 1);
  kernel.actions.undo();
  assert.deepEqual(idsOf(kernel), before);
  assert.equal(Object.keys(kernel.store.getState().objects).length, 0);

  const fitted = await insertImagePages(kernel.editor, { images: [images[0]], mode: "a4", index: 0 });
  const page = pagesOf(kernel)[0];
  assert.equal(page.id, fitted[0]);
  assert.deepEqual(page.view, [0, 0, 841.89, 595.28], "a lying picture on a lying A4 page");
  const frame = kernel.store.getState().objects[page.objectIds[0]].frame;
  assert.ok(frame.w <= 841.89 && frame.h <= 595.28 && Math.abs(frame.w / frame.h - 800 / 600) < 0.001, "fitted with its ratio kept");
  assert.equal(toastsOf(kernel).at(-1)[1], "1 image added as a page");
  assert.equal(await insertImagePages(kernel.editor, { images: [{ mime: "image/png", width: 0, height: 0, bytes: bytesOf(8, 1) }], mode: "a4", index: 0 }), null);
});

// --- extract -----------------------------------------------------------------------------------------------

test("extract: the chosen pages through the one way out, saved as <name>-pages-<range>.pdf", async () => {
  const kernel = await opened(5);
  const [, b, c] = idsOf(kernel);
  const result = await extractPages(kernel.editor, { pageIds: [c, b] });
  assert.deepEqual(result, { fileName: "hop-dong-pages-2-3.pdf", pageIds: [b, c], removed: false });
  assert.equal(kernel.saved.length, 1);
  assert.equal(kernel.saved[0].fileName, "hop-dong-pages-2-3.pdf");
  const build = kernel.pipeline.calls.find(([name]) => name === "buildOutput")[1];
  assert.equal(build.job.pages.length, 2, "only the two pages are in the job");
  assert.equal(pagesOf(kernel).length, 5, "the document keeps its pages");
  assert.equal(kernel.store.isDirty(), false, "an extract is not a change of the document");
  assert.equal(depth(kernel), 0);
  assert.ok(toastsOf(kernel).some(([tone, message]) => tone === "success" && message === "hop-dong-pages-2-3.pdf was downloaded."));
});

test("extract with 'also remove': the pages go in one undo step, after the file was saved", async () => {
  const kernel = await opened(5);
  const [a, b, c, d, e] = idsOf(kernel);
  const result = await extractPages(kernel.editor, { pageIds: [a, c, d], remove: true });
  assert.equal(result.fileName, "hop-dong-pages-1,3-4.pdf");
  assert.equal(result.removed, true);
  assert.deepEqual(idsOf(kernel), [b, e]);
  assert.equal(depth(kernel), 1);
  assert.ok(toastsOf(kernel).some(([, message, undo]) => message === "3 pages deleted" && undo));
  kernel.actions.undo();
  assert.deepEqual(idsOf(kernel), [a, b, c, d, e]);
});

test("extract cannot remove every page, and a failed build saves and removes nothing", async () => {
  const kernel = await opened(2);
  assert.equal(await extractPages(kernel.editor, { pageIds: idsOf(kernel), remove: true }), null);
  assert.equal(kernel.saved.length, 0, "nothing was built for a request that cannot be done");
  assert.deepEqual(toastsOf(kernel), [["error", "<MODEL_LAST_PAGE>", false]]);
  assert.equal(await extractPages(kernel.editor, { pageIds: [] }), null);

  const failing = await opened(3, { plan: { failures: [new Error("boom")] } });
  failing.answer({ confirm: false, exportFailed: undefined });
  assert.equal(await extractPages(failing.editor, { pageIds: [idsOf(failing)[0]], remove: true }), null);
  assert.equal(failing.saved.length, 0);
  assert.equal(pagesOf(failing).length, 3, "the pages stay when the file could not be made");
});

// --- documents that ask first, or cannot be changed ------------------------------------------------------------

test("a signed document asks once before the first page operation; No changes nothing", async () => {
  const kernel = await opened(3, { file: { facts: { signatureCount: 1 } } });
  const [a] = idsOf(kernel);
  kernel.answer({ confirm: false });
  assert.equal(await rotatePages(kernel.editor, [a], 90), null);
  assert.equal(await deletePages(kernel.editor, [a]), null);
  assert.equal(pagesOf(kernel)[0].rotation, 0);
  assert.equal(pagesOf(kernel).length, 3);
  assert.equal(kernel.asked.filter((entry) => entry.id === "confirm").length, 2, "asked again as long as the answer is No");
  kernel.answer({ confirm: true });
  assert.deepEqual(await rotatePages(kernel.editor, [a], 90), [a]);
  await duplicatePages(kernel.editor, [a]);
  assert.equal(kernel.asked.filter((entry) => entry.id === "confirm").length, 3, "after Yes it is not asked again");
});

test("a view-only document refuses every page operation", async () => {
  const kernel = await opened(3, { plan: { refuse: { [first(1)]: "EXPORT_PAGE_COUNT_MISMATCH" } } });
  assert.equal(kernel.ui.getState().flags.editable, "no");
  const ids = idsOf(kernel);
  assert.equal(await rotatePages(kernel.editor, [ids[0]], 90), null);
  assert.equal(await duplicatePages(kernel.editor, [ids[0]]), null);
  assert.equal(await deletePages(kernel.editor, [ids[0]]), null);
  assert.equal(await movePages(kernel.editor, [ids[0]], 2), false);
  assert.equal(await insertBlankPages(kernel.editor, { size: [300, 300], index: 0 }), null);
  assert.equal(await insertImagePages(kernel.editor, { images: [{ mime: "image/png", width: 10, height: 10, bytes: bytesOf(8, 3) }], mode: "a4", index: 0 }), null);
  assert.deepEqual(idsOf(kernel), ids);
  assert.deepEqual(pagesOf(kernel).map((page) => page.rotation), [0, 0, 0]);
  assert.equal(depth(kernel), 0);
  assert.ok(toastsOf(kernel).every(([tone]) => tone === "warning"), "each refusal says that the file cannot be edited here");
});

test("nothing is changed while a job runs", async () => {
  const kernel = await opened(3);
  const [a] = idsOf(kernel);
  let release;
  const job = kernel.actions.runJob({ titleKey: "Working…" }, () => new Promise((resolve) => (release = resolve)));
  await flush();
  assert.ok(kernel.ui.getState().job);
  assert.equal(await rotatePages(kernel.editor, [a], 90), null);
  assert.equal(await deletePages(kernel.editor, [a]), null);
  assert.equal(await extractPages(kernel.editor, { pageIds: [a] }), null);
  release();
  await job;
  assert.equal(pagesOf(kernel)[0].rotation, 0);
  assert.equal(kernel.saved.length, 0);
});
