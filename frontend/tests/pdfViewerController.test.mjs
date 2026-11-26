// The viewer controller without a browser: sources (facts, passwords, damaged files, cancellation), the
// controlled page list, the store, zoom, text lines and search. pdf.js runs in this process (its main-thread
// worker); everything that needs the DOM is proved in the browser run.
import test from "node:test";
import assert from "node:assert/strict";
import { pdfjs } from "./helpers/pdfTestKit.mjs";
import { makeController, makePdf, nextTick, openPdfDocument } from "./helpers/pdfViewerKit.mjs";
import { CANCELLED, isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { userToViewport, viewportTransform } from "../src/pages/pdfEditor/engine/geometry.js";
import { CODES } from "../src/pages/pdfEditor/viewer/codes.js";
import { pagesFromFacts } from "../src/pages/pdfEditor/viewer/pageList.js";
import { createViewerController } from "../src/pages/pdfEditor/viewer/viewerController.js";

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(isPdfEditorError(error), `a PdfEditorError, got ${error}`);
    assert.equal(error.code, code);
    assert.ok(code === CANCELLED || code in CODES, `${code} is listed in codes.js`);
    return true;
  });

const contract = () =>
  makePdf(
    [
      {
        texts: [
          { text: "Hợp đồng dịch vụ số 12/2026", x: 50, y: 780, size: 14, fontKey: "arimo-bold" },
          { text: "Người đại diện: Nguyễn Văn An", x: 50, y: 750 },
          { text: "Địa chỉ: 25 Lý Thường Kiệt, Hà Nội", x: 50, y: 730, fontKey: "tinos-regular" }
        ]
      },
      { size: [400, 300], rotate: 90, texts: [{ text: "Phụ lục: đường Điện Biên Phủ", x: 40, y: 200 }] },
      { size: [300, 400], userUnit: 2, crop: [10, 20, 290, 380], texts: [{ text: "Trang ba, Nguyễn Văn An ký", x: 30, y: 300, size: 10 }] }
    ],
    {
      title: "Hợp đồng thử nghiệm",
      author: "Kiểm thử",
      subject: "Viewer",
      keywords: ["hợp đồng", "thử"],
      outline: [{ title: "Điều 1", page: 0, top: 790 }, { title: "Phụ lục", page: 1 }],
      links: [{ page: 0, rect: [50, 745, 250, 762], toPage: 2 }, { page: 0, rect: [50, 725, 250, 742], url: "https://example.org/contract" }]
    }
  );

test("openSource returns the facts of a file and leaves the caller's bytes alone", async () => {
  const controller = makeController();
  try {
    const bytes = await contract();
    const copy = bytes.slice();
    const facts = await controller.openSource("s1", bytes);
    assert.equal(bytes.byteLength, copy.byteLength, "the buffer was not detached");
    assert.deepEqual(bytes, copy);
    assert.equal(facts.pageCount, 3);
    assert.deepEqual(facts.pages, [
      { view: [0, 0, 595.28, 841.89], rotate: 0, userUnit: 1 },
      { view: [0, 0, 400, 300], rotate: 90, userUnit: 1 },
      { view: [10, 20, 290, 380], rotate: 0, userUnit: 2 }
    ]);
    assert.deepEqual({ ...facts.info, creator: "", producer: "" }, { title: "Hợp đồng thử nghiệm", author: "Kiểm thử", subject: "Viewer", keywords: "hợp đồng thử", creator: "", producer: "" });
    assert.match(facts.info.producer, /pdf-lib/);
    assert.equal(facts.encrypted, false);
    assert.equal(facts.permissions, null);
    assert.deepEqual(facts.outline, [
      { title: "Điều 1", pageIndex: 0, rect: [0, 790, 0, 790], children: [] },
      { title: "Phụ lục", pageIndex: 1, rect: null, children: [] }
    ]);
    assert.equal(facts.signatureFieldCount, 0);
    assert.equal(facts.signatureCount, 0);
    assert.match(facts.fingerprint, /^[0-9a-f]{32}$/);
    assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts.pages));
    assert.equal(controller.hasSource("s1"), true);
    assert.equal(controller.getSourceFacts("s1"), facts);
    assert.equal(controller.getSourcePassword("s1"), null);
    assert.equal(controller.getPdfDocument("s1").numPages, 3);
    // an ArrayBuffer is accepted and stays usable as well
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const again = await controller.openSource("s2", buffer);
    assert.equal(buffer.byteLength, bytes.byteLength);
    assert.equal(again.fingerprint, facts.fingerprint);
    await rejectsWith(controller.openSource("s1", bytes), "VIEW_SOURCE_EXISTS");
    await controller.closeSource("s1");
    assert.equal(controller.hasSource("s1"), false);
    assert.equal(controller.getSourceFacts("s1"), null);
    await controller.closeSource("s1"); // closing twice is harmless
  } finally {
    controller.dispose();
  }
});

test("an encrypted file: asks, reports a wrong password, opens with the right one, can be cancelled", async () => {
  const controller = makeController();
  try {
    const bytes = await makePdf([{ texts: [{ text: "Tài liệu mật: số tài khoản 0123456789", x: 50, y: 700 }] }], { title: "Mật", encrypt: { userPassword: "mở-khóa-123", ownerPassword: "chủ-456" } });

    await rejectsWith(controller.openSource("none", bytes), "VIEW_PASSWORD_REQUIRED");
    await rejectsWith(controller.openSource("wrong", bytes, { password: "sai" }), "VIEW_PASSWORD_INCORRECT");
    assert.equal(controller.hasSource("none") || controller.hasSource("wrong"), false);

    // need -> a wrong answer -> incorrect -> the right answer
    const asked = [];
    const answers = ["sai mật khẩu", "mở-khóa-123"];
    const facts = await controller.openSource("asked", bytes, {
      onPassword: async (reason) => {
        asked.push(reason);
        return answers.shift();
      }
    });
    assert.deepEqual(asked, ["need", "incorrect"]);
    assert.equal(facts.encrypted, true);
    assert.equal(facts.pageCount, 1);
    assert.equal(facts.info.title, "Mật");
    assert.equal(controller.getSourcePassword("asked"), "mở-khóa-123");
    assert.ok(facts.permissions && Array.isArray(facts.permissions.flags));

    // the right password in the options: nobody is asked
    let prompts = 0;
    await controller.openSource("direct", bytes, { password: "mở-khóa-123", onPassword: () => (prompts += 1) && null });
    assert.equal(prompts, 0);
    assert.equal(controller.getSourcePassword("direct"), "mở-khóa-123");

    // a wrong password in the options: the prompt starts with "incorrect"
    const reasons = [];
    await controller.openSource("retry", bytes, { password: "sai", onPassword: (reason) => reasons.push(reason) && "mở-khóa-123" });
    assert.deepEqual(reasons, ["incorrect"]);

    // the user gives up, at the first prompt or after a wrong answer
    await rejectsWith(controller.openSource("cancel-1", bytes, { onPassword: () => null }), "VIEW_PASSWORD_CANCELLED");
    const second = ["sai"];
    await rejectsWith(controller.openSource("cancel-2", bytes, { onPassword: () => second.shift() ?? null }), "VIEW_PASSWORD_CANCELLED");
    assert.equal(controller.hasSource("cancel-1") || controller.hasSource("cancel-2"), false);
    assert.equal(controller.getSnapshot().busy.opening, false);

    // the text of the opened copy is readable
    controller.setPages(pagesFromFacts("asked", facts));
    assert.deepEqual(await controller.search("so tai khoan"), { total: 1, current: 0, pageId: controller.getPages()[0].id });
  } finally {
    controller.dispose();
  }
});

test("a file with an owner password only opens without a prompt and reports its permissions", async () => {
  const controller = makeController();
  try {
    const bytes = await makePdf([{ texts: [{ text: "Chỉ hạn chế quyền", x: 50, y: 700 }] }], { encrypt: { ownerPassword: "chủ-456", permissions: { printing: "highResolution", copying: false, modifying: false } } });
    let prompts = 0;
    const facts = await controller.openSource("owner", bytes, { onPassword: () => (prompts += 1) && null });
    assert.equal(prompts, 0);
    assert.equal(facts.encrypted, true);
    assert.equal(controller.getSourcePassword("owner"), null, "no password was needed");
    assert.equal(facts.permissions.print, true);
    assert.equal(facts.permissions.printHighQuality, true);
    assert.equal(facts.permissions.copy, false);
    assert.equal(facts.permissions.modify, false);
    assert.ok(facts.permissions.flags.includes(pdfjs.PermissionFlag.PRINT));
    // pdf.js refuses such a file when a wrong password comes with it: never reuse a password
    await rejectsWith(controller.openSource("owner-wrong", bytes, { password: "of another file" }), "VIEW_PASSWORD_INCORRECT");
  } finally {
    controller.dispose();
  }
});

test("damaged and foreign files are refused with a code", async () => {
  const controller = makeController();
  try {
    const good = await contract();
    await rejectsWith(controller.openSource("empty", new Uint8Array(0)), "VIEW_FILE_EMPTY");
    await rejectsWith(controller.openSource("text", new TextEncoder().encode("this is not a PDF at all, just words")), "VIEW_INVALID_PDF");
    await rejectsWith(controller.openSource("html", new TextEncoder().encode("<!doctype html><html><body>404</body></html>")), "VIEW_INVALID_PDF");
    await rejectsWith(controller.openSource("cut", good.slice(0, Math.floor(good.length / 3))), "VIEW_INVALID_PDF");
    await assert.rejects(controller.openSource("type", "a string"), TypeError);
    await assert.rejects(controller.openSource("", good), TypeError);
    assert.equal(controller.getSnapshot().busy.opening, false);
    assert.equal(controller.stats().sources, 0);
    // the ids of failed attempts are free again
    assert.equal((await controller.openSource("empty", good)).pageCount, 3);
  } finally {
    controller.dispose();
  }
});

test("an open can be cancelled: closeSource, AbortSignal, dispose, a worker that fails", async () => {
  // a loading task that never settles, as with a worker whose script failed to load
  const pending = [];
  let workerListener = null;
  const controller = createViewerController({
    pdfjs,
    openPdfDocument: () => {
      const task = { promise: new Promise(() => {}), destroyed: false, destroy: async () => (task.destroyed = true) };
      pending.push(task);
      return task;
    },
    onWorkerError: (listener) => {
      workerListener = listener;
      return () => (workerListener = null);
    }
  });
  const bytes = new Uint8Array([37, 80, 68, 70]);

  const closed = controller.openSource("a", bytes);
  assert.equal(controller.getSnapshot().busy.opening, true);
  await controller.closeSource("a");
  await rejectsWith(closed, CANCELLED);

  const abort = new AbortController();
  const aborted = controller.openSource("b", bytes, { signal: abort.signal });
  abort.abort();
  await rejectsWith(aborted, CANCELLED);
  await rejectsWith(controller.openSource("b2", bytes, { signal: abort.signal }), CANCELLED);

  const disposed = controller.openSource("c", bytes);
  controller.dispose();
  await rejectsWith(disposed, CANCELLED);

  const crashed = controller.openSource("d", bytes);
  workerListener(new Error("worker script 404"));
  await rejectsWith(crashed, "VIEW_WORKER_FAILED");

  assert.equal(pending.length, 4);
  assert.ok(pending.every((task) => task.destroyed), "every abandoned loading task was destroyed");
  await nextTick();
  assert.equal(controller.getSnapshot().busy.opening, false);
  assert.equal(controller.stats().sources, 0);
  controller.destroy();
  assert.equal(workerListener, null, "destroy() stops listening to the worker");
});

test("the controlled list and the store", async () => {
  const controller = makeController();
  try {
    const facts = await controller.openSource("s1", await contract());
    const pages = pagesFromFacts("s1", facts);
    let notified = 0;
    const off = controller.subscribe(() => (notified += 1));
    const empty = controller.getSnapshot();
    assert.equal(empty.pageCount, 0);
    assert.equal(empty.currentPageId, null);
    assert.equal(empty.currentPageNumber, 0);
    assert.equal(controller.getSnapshot(), empty, "an unchanged snapshot keeps its identity");

    controller.setPages(pages);
    assert.equal(controller.getPages(), pages, "the list is the caller's array");
    assert.equal(notified, 0, "listeners are told in a microtask");
    await nextTick();
    assert.equal(notified, 1, "one notification for one change");
    const snapshot = controller.getSnapshot();
    assert.notEqual(snapshot, empty);
    assert.deepEqual(
      { pageCount: snapshot.pageCount, currentPageId: snapshot.currentPageId, currentPageNumber: snapshot.currentPageNumber, zoom: snapshot.zoom, zoomMode: snapshot.zoomMode, scale: snapshot.scale },
      { pageCount: 3, currentPageId: pages[0].id, currentPageNumber: 1, zoom: 1, zoomMode: "actual", scale: 96 / 72 }
    );
    assert.deepEqual(snapshot.busy, { opening: false, rendering: false, searching: false, any: false });
    assert.deepEqual(snapshot.search, { query: "", options: {}, total: 0, current: -1, pageId: null, running: false });
    assert.equal(controller.getPage(pages[1].id), pages[1]);
    assert.equal(controller.getPage("nope"), null);
    assert.equal(controller.getRenderState(pages[0].id), "pending");
    controller.setPages(pages); // the same array: nothing happens
    await nextTick();
    assert.equal(notified, 1);

    // list edits of the model: move, rotate, duplicate, blank, delete
    const blank = { id: "blank1", kind: "blank", sourceId: null, sourceIndex: null, view: [0, 0, 595.28, 841.89], baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [] };
    const copy = { ...pages[1], id: "copy1", rotation: 90 };
    const next = [pages[2], pages[0], copy, blank];
    controller.setPages(next);
    await nextTick();
    const after = controller.getSnapshot();
    assert.equal(after.pageCount, 4);
    assert.equal(after.currentPageId, pages[0].id, "the current page moved with its id");
    assert.equal(after.currentPageNumber, 2);
    assert.equal(controller.getRenderState("blank1"), "ready", "a blank page has nothing to draw");
    assert.equal(controller.getPage(pages[1].id), null, "the deleted page is gone");

    // what the overlay needs for a page: the arguments of engine/geometry.js
    const view = controller.getPageView("copy1");
    assert.equal(view.pageNumber, 3);
    assert.equal(view.scale, 96 / 72);
    assert.deepEqual(view.geometry, { view: [0, 0, 400, 300], rotate: 90, userUnit: 1 });
    assert.equal(view.extraRotation, 90);
    assert.equal(view.rotation, 180);
    const expected = viewportTransform(view.geometry, view.scale, 90);
    assert.equal(view.width, expected.width);
    assert.equal(view.height, expected.height);
    assert.equal(view.element, null, "no element without a browser");
    assert.deepEqual(userToViewport(view.geometry, [0, 0], view.scale, view.extraRotation), [view.width, 0], "180 degrees: the origin is at the top right");
    assert.equal(controller.getPageView("nope"), null);
    assert.equal(controller.clientToUser("copy1", 10, 10), null, "not mounted");
    assert.equal(controller.scrollToPage("copy1"), false);

    // the current page was deleted: the first page takes over
    controller.setPages([copy, blank]);
    await nextTick();
    assert.equal(controller.getSnapshot().currentPageId, "copy1");
    assert.throws(() => controller.setPages([copy, copy]), /duplicate id/);
    assert.throws(() => controller.setPages([{ id: "x", kind: "pdf" }]), TypeError);
    assert.equal(controller.getPages().length, 2, "a refused list changes nothing");
    off();
  } finally {
    controller.dispose();
  }
});

test("zoom in the store: factor, scale, mode, stops and limits", async () => {
  const controller = makeController();
  try {
    const views = [];
    controller.on("viewchanged", (detail) => views.push(detail));
    controller.setZoom(1.5);
    let snapshot = controller.getSnapshot();
    assert.deepEqual([snapshot.zoom, snapshot.scale, snapshot.zoomMode], [1.5, 2, "custom"]);
    assert.equal(controller.getScale(), 2);
    assert.equal(views.length, 1);
    assert.deepEqual(views[0], { scale: 2, zoom: 1.5, zoomMode: "custom", currentPageId: null, currentPageNumber: 0 });
    controller.zoomIn();
    assert.equal(controller.getSnapshot().zoom, 1.75);
    controller.zoomOut();
    controller.zoomOut();
    assert.equal(controller.getSnapshot().zoom, 1.25);
    controller.setZoom(100);
    assert.equal(controller.getSnapshot().zoom, 8);
    controller.zoomIn();
    assert.equal(controller.getSnapshot().zoom, 8);
    controller.setZoom(0.001);
    assert.equal(controller.getSnapshot().zoom, 0.1);
    controller.setScale(96 / 72);
    assert.equal(controller.getSnapshot().zoom, 1);
    assert.equal(controller.getSnapshot().zoomMode, "custom");
    controller.setZoom("actual");
    snapshot = controller.getSnapshot();
    assert.deepEqual([snapshot.zoom, snapshot.zoomMode], [1, "actual"]);
    // a fit mode without a container keeps the zoom and remembers the mode
    controller.setZoom(2);
    controller.setZoom("fit-width");
    snapshot = controller.getSnapshot();
    assert.deepEqual([snapshot.zoom, snapshot.zoomMode], [2, "fit-width"]);
    controller.setZoom("nonsense");
    controller.setZoom("custom");
    assert.equal(controller.getSnapshot().zoomMode, "fit-width");
    assert.equal(controller.isIdle(), false, "bitmaps are redrawn shortly after the last zoom step");
    await controller.whenIdle();
    assert.equal(controller.isIdle(), true);
  } finally {
    controller.dispose();
  }
});

test("getTextLines through the controller: user space, real font names, shared by duplicates", async () => {
  const controller = makeController();
  try {
    const facts = await controller.openSource("s1", await contract());
    const pages = pagesFromFacts("s1", facts);
    const copy = { ...pages[0], id: "copy", rotation: 270 };
    const blank = { id: "blank", kind: "blank", sourceId: null, sourceIndex: null, view: [0, 0, 100, 100], baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [] };
    const orphan = { ...pages[0], id: "orphan", sourceId: "closed" };
    controller.setPages([...pages, copy, blank, orphan]);

    const lines = await controller.getTextLines(pages[0].id);
    assert.deepEqual(lines.map((line) => line.text), ["Hợp đồng dịch vụ số 12/2026", "Người đại diện: Nguyễn Văn An", "Địa chỉ: 25 Lý Thường Kiệt, Hà Nội"]);
    assert.match(lines[0].font.name, /^Arimo-Bold/);
    assert.deepEqual([lines[0].font.bold, lines[0].font.serif, lines[0].fontSize], [true, false, 14]);
    assert.match(lines[2].font.name, /^Tinos-Regular/);
    assert.equal(lines[2].font.serif, true);
    assert.ok(lines[0].rect[1] < 780 && lines[0].rect[3] > 780);
    assert.equal(await controller.getTextLines(pages[0].id), lines, "cached");
    assert.equal(await controller.getTextLines("copy"), lines, "a rotated duplicate has the same lines: user space does not turn");
    assert.ok(Object.isFrozen(lines));

    const [turned] = await controller.getTextLines(pages[1].id);
    assert.equal(turned.text, "Phụ lục: đường Điện Biên Phủ");
    assert.equal(turned.angle, 0, "the page's /Rotate does not turn its user space");
    const [scaled] = await controller.getTextLines(pages[2].id);
    assert.equal(scaled.fontSize, 20, "points: 10 user units on a page with UserUnit 2");

    assert.deepEqual(await controller.getTextLines("blank"), []);
    await rejectsWith(controller.getTextLines("nope"), "VIEW_PAGE_UNKNOWN");
    await rejectsWith(controller.getTextLines("orphan"), "VIEW_SOURCE_MISSING");
    await rejectsWith(controller.sampleColors("nope", [0, 0, 1, 1]), "VIEW_PAGE_UNKNOWN");
    assert.deepEqual(await controller.sampleColors("blank", [0, 0, 10, 10]), { background: "#ffffff", text: "#000000", found: false });
    assert.throws(() => controller.renderToCanvas("nope"), (error) => error.code === "VIEW_PAGE_UNKNOWN");
    assert.throws(() => controller.renderToCanvas("orphan"), (error) => error.code === "VIEW_SOURCE_MISSING");
  } finally {
    controller.dispose();
  }
});

test("search runs over the list in order, across sources, and follows the list", async () => {
  const controller = makeController();
  try {
    const first = await controller.openSource("a", await contract());
    const second = await controller.openSource(
      "b",
      await makePdf([{ texts: [{ text: "Biên bản: ông Nguyễn Văn An và bà Trần Thị Bích", x: 50, y: 700 }, { text: "NGUYỄN VĂN AN đã ký", x: 50, y: 680 }] }, { texts: [{ text: "Không có gì ở đây", x: 50, y: 700 }] }])
    );
    const pagesA = pagesFromFacts("a", first);
    const pagesB = pagesFromFacts("b", second);
    const blank = { id: "blank", kind: "blank", sourceId: null, sourceIndex: null, view: [0, 0, 100, 100], baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [] };
    // file B's first page sits between the pages of file A
    const list = [pagesA[0], pagesB[0], blank, pagesA[1], pagesA[2], pagesB[1]];
    controller.setPages(list);

    const result = await controller.search("nguyen van an");
    assert.deepEqual(result, { total: 4, current: 0, pageId: pagesA[0].id });
    let search = controller.getSnapshot().search;
    assert.deepEqual({ ...search, options: null }, { query: "nguyen van an", options: null, total: 4, current: 0, pageId: pagesA[0].id, running: false });
    assert.deepEqual(search.options, { matchCase: false, wholeWord: false, matchDiacritics: false });

    // next walks through every hit in list order and wraps
    const seen = [result.pageId];
    for (let step = 0; step < 4; step += 1) seen.push(controller.searchNext().pageId);
    assert.deepEqual(seen, [pagesA[0].id, pagesB[0].id, pagesB[0].id, pagesA[2].id, pagesA[0].id]);
    assert.deepEqual(controller.searchPrevious(), { total: 4, current: 3, pageId: pagesA[2].id });
    await nextTick();
    assert.equal(controller.getSnapshot().search.current, 3);

    // options
    assert.equal((await controller.search("nguyen van an", { matchDiacritics: true })).total, 0);
    assert.equal((await controller.search("Nguyễn Văn An", { matchDiacritics: true })).total, 4);
    assert.equal((await controller.search("Nguyễn Văn An", { matchDiacritics: true, matchCase: true })).total, 3);
    assert.equal((await controller.search("an", { wholeWord: true })).total, 4);
    assert.ok((await controller.search("an")).total > 4);
    assert.equal((await controller.search("dien bien phu")).pageId, pagesA[1].id);
    assert.deepEqual(await controller.search("không tìm thấy đâu"), { total: 0, current: -1, pageId: null });
    assert.deepEqual(controller.searchNext(), { total: 0, current: -1, pageId: null });

    // the list changes while a search is shown: the results follow, the current hit is kept
    await controller.search("nguyen van an");
    controller.searchNext();
    controller.searchNext(); // the second hit on B's page
    controller.setPages([pagesB[0], pagesA[0], pagesA[2]]);
    await controller.whenIdle();
    search = controller.getSnapshot().search;
    assert.deepEqual([search.total, search.current, search.pageId], [4, 1, pagesB[0].id]);
    // the page of the current hit is deleted: the next hit after it takes over
    controller.setPages([pagesA[0], pagesA[2]]);
    await controller.whenIdle();
    search = controller.getSnapshot().search;
    assert.deepEqual([search.total, search.current, search.pageId], [2, 0, pagesA[0].id]);
    // a source is closed: its pages have no hits any more
    await controller.closeSource("a");
    await controller.whenIdle();
    assert.equal(controller.getSnapshot().search.total, 0);
    assert.equal(controller.getSnapshot().search.query, "nguyen van an");
    controller.clearSearch();
    await nextTick();
    assert.equal(controller.getSnapshot().search.query, "");
  } finally {
    controller.dispose();
  }
});

test("dispose() empties the controller and leaves it usable (React StrictMode: effect, cleanup, effect)", async () => {
  const controller = makeController();
  const bytes = await contract();
  const facts = await controller.openSource("s1", bytes);
  controller.setPages(pagesFromFacts("s1", facts));
  await controller.search("hop dong");
  const lines = controller.getTextLines(controller.getPages()[0].id);
  controller.dispose();
  await lines.catch(() => {}); // work in flight ends quietly or with CANCELLED, never with a crash
  await nextTick();
  const snapshot = controller.getSnapshot();
  assert.deepEqual([snapshot.pageCount, snapshot.currentPageId, snapshot.search.query, snapshot.busy.any], [0, null, "", false]);
  assert.deepEqual(controller.getPages(), []);
  assert.equal(controller.hasSource("s1"), false);
  assert.equal(controller.stats().sources, 0);
  controller.dispose(); // twice is harmless

  // the same instance again, with the same source id
  const again = await controller.openSource("s1", bytes);
  assert.equal(again.pageCount, 3);
  const pages = pagesFromFacts("s1", again);
  controller.setPages(pages);
  assert.equal((await controller.search("hop dong")).total, 1);
  assert.equal((await controller.getTextLines(pages[0].id)).length, 3);
  controller.dispose();
  // the injected function is the only way to pdf.js: nothing else was opened behind its back
  assert.equal(typeof openPdfDocument, "function");
  assert.throws(() => createViewerController({ pdfjs }), TypeError);
});

test("work that waits for pdf.js ends with CANCELLED when its source is closed", async () => {
  const controller = makeController();
  try {
    const bytes = await contract();
    const facts = await controller.openSource("s1", bytes);
    const pages = pagesFromFacts("s1", facts);
    controller.setPages(pages);
    // reading lines needs the operator list of a page that was never drawn: pdf.js leaves that promise
    // pending for ever when the document is destroyed meanwhile
    const lines = controller.getTextLines(pages[0].id);
    const searching = controller.search("nguyen");
    const closing = controller.closeSource("s1");
    await rejectsWith(lines, CANCELLED);
    await closing;
    await searching;
    await controller.whenIdle();
    assert.deepEqual(controller.getSnapshot().search.total, 0);
    await rejectsWith(controller.getTextLines(pages[0].id), "VIEW_SOURCE_MISSING");
    // the same file under the same id again: nothing of the closed document is reused
    const again = await controller.openSource("s1", bytes);
    assert.equal(again.pageCount, 3);
    assert.equal((await controller.getTextLines(pages[0].id)).length, 3);
    assert.equal((await controller.search("nguyen")).total, 2);
  } finally {
    controller.dispose();
  }
});

test("a result list for the search, and the list entry of a source page", async () => {
  const controller = makeController();
  try {
    const facts = await controller.openSource("s1", await contract());
    const pages = pagesFromFacts("s1", facts);
    const copy = { ...pages[0], id: "copy" };
    controller.setPages([pages[0], pages[1], pages[2], copy]);
    await controller.search("nguyen van an");
    const results = controller.getSearchResults();
    assert.deepEqual(results.map((result) => [result.index, result.pageNumber, result.match, result.current]), [
      [0, 1, "Nguyễn Văn An", true],
      [1, 3, "Nguyễn Văn An", false],
      [2, 4, "Nguyễn Văn An", false]
    ]);
    // 40 characters of context, the line break shown as a space
    assert.equal(results[0].before, "đồng dịch vụ số 12/2026 Người đại diện: ");
    assert.equal(results[0].before.length, 40);
    assert.equal(results[0].after.startsWith(" Địa chỉ: 25 Lý Thường Kiệt"), true);
    assert.equal(results[1].before, "Trang ba, ");
    assert.equal(results[1].after, " ký");
    assert.deepEqual(controller.getSearchResults({ offset: 1, limit: 1, context: 4 }).map((result) => [result.index, result.before, result.after]), [[1, "ba, ", " ký"]]);
    assert.deepEqual(controller.showSearchResult(2), { total: 3, current: 2, pageId: "copy" });
    assert.equal(controller.getSearchResults()[2].current, true);
    assert.deepEqual(controller.showSearchResult(99), { total: 3, current: 2, pageId: "copy" }, "an index outside the list changes nothing");
    controller.clearSearch();
    assert.deepEqual(controller.getSearchResults(), []);

    // bookmarks and links name a page of a source: which list entry shows it?
    assert.equal(controller.findPageId("s1", 1), pages[1].id);
    assert.equal(controller.findPageId("s1", 0), pages[0].id, "the first copy");
    assert.equal(controller.findPageId("s1", 0, { near: pages[2].id }), "copy", "the copy nearest to a given page");
    assert.equal(controller.findPageId("s1", 7), null);
    assert.equal(controller.findPageId("other", 0), null);
    const target = facts.outline[1];
    assert.equal(controller.findPageId("s1", target.pageIndex), pages[1].id);
  } finally {
    controller.dispose();
  }
});
