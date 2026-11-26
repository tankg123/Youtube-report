// The commands of the PDF editor kernel (src/pages/pdfEditor/ui/actions.js) against the real document store
// and UI store, with a viewer, a pipeline and a platform made in tests/helpers/pdfUiKit.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { PdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { AUTO_ZOOM_MAX, LARGE_FILE_PAGES, VIEW_ONLY_NOTICE, ZOOM_LIMITS } from "../src/pages/pdfEditor/ui/actions.js";
import { bytesOf, sample } from "./helpers/pdfModelKit.mjs";
import { fileItem, flush, makeKernel } from "./helpers/pdfUiKit.mjs";

const first = (seed) => bytesOf(1, seed)[0]; // the byte the stand-in viewer recognises a file by
const pagesOf = (kernel) => kernel.store.getState().pages;
const messagesOf = (kernel) => kernel.ui.getState().toasts.map((toast) => [toast.tone, toast.message]);

async function opened(options = {}, items = [fileItem("hop-dong.pdf", 1)]) {
  const kernel = makeKernel(options);
  const result = await kernel.actions.openFiles(items);
  await flush();
  return { kernel, result };
}

// --- opening ---------------------------------------------------------------------------------------------------

test("one file becomes the working document under its name; viewer and store share the source id", async () => {
  const { kernel, result } = await opened({ files: { [first(1)]: { pages: [{}, {}, {}] } } });
  const state = kernel.store.getState();
  assert.equal(state.pages.length, 3);
  assert.equal(state.fileName, "hop-dong");
  assert.equal(result.opened.length, 1);
  const [source] = Object.values(state.sources);
  assert.equal(source.id, result.opened[0].sourceId);
  assert.ok(kernel.viewer.open.has(source.id), "the viewer opened it under the same id");
  assert.equal(kernel.store.isDirty(), false);
  assert.equal(kernel.store.canUndo(), false, "a new document starts with an empty history");
  assert.equal(kernel.ui.getState().job, null);
  assert.deepEqual(messagesOf(kernel), [], "nothing to say about one file that simply opened");
  assert.equal(kernel.ui.getState().flags.editable, "yes", "the writer was asked in idle time");
  assert.deepEqual(kernel.pipeline.calls[0], ["inspectSource", { source: source.id, expectedPages: 3 }]);
});

test("several files open as ONE document, pages in the order given, with a toast that counts them", async () => {
  const { kernel, result } = await opened(
    { files: { [first(1)]: { pages: [{}, {}] }, [first(2)]: { pages: [{}] }, [first(3)]: { pages: [{}, {}, {}] } } },
    [fileItem("a.pdf", 1), fileItem("b.pdf", 2), fileItem("c.pdf", 3)]
  );
  const state = kernel.store.getState();
  assert.equal(state.pages.length, 6);
  assert.deepEqual(state.pages.map((page) => state.sources[page.sourceId].name), ["a.pdf", "a.pdf", "b.pdf", "c.pdf", "c.pdf", "c.pdf"]);
  assert.equal(state.fileName, "a");
  assert.deepEqual(result.opened.map((entry) => entry.pageCount), [2, 1, 3]);
  assert.deepEqual(messagesOf(kernel), [["success", "Opened 3 files as one document (6 pages)"]]);
  assert.equal(kernel.pipeline.calls.filter(([name]) => name === "inspectSource").length, 3, "every file of a combined document passed the writer first");
});

test("a password is asked in one dialog that stays open for a wrong answer; the right one is kept for the export", async () => {
  const kernel = makeKernel({ files: { [first(1)]: { password: "user123" } } });
  const tried = [];
  kernel.answer({
    password: (props) => {
      tried.push([props.reason, props.attempt]);
      return props.reason === "need" ? "wrong" : "user123";
    }
  });
  await kernel.actions.openFiles([fileItem("secret.pdf", 1)]);
  await flush();
  assert.deepEqual(tried, [["need", 1], ["incorrect", 2]]);
  assert.equal(kernel.asked.filter((entry) => entry.id === "password").length, 2, "asked twice");
  assert.deepEqual(kernel.ui.getState().dialogs, [], "the dialog is closed once the file is open");
  const [source] = Object.values(kernel.store.getState().sources);
  assert.equal(kernel.store.getSourcePassword(source.id), "user123");
  assert.equal(source.encrypted, true);
  assert.deepEqual(kernel.pipeline.calls[0][1], { source: source.id, expectedPages: 1, password: "user123" });
});

test("giving up at the password dialog opens nothing and says nothing", async () => {
  const kernel = makeKernel({ files: { [first(1)]: { password: "user123" } } });
  kernel.answer({ password: null });
  assert.equal(await kernel.actions.openFiles([fileItem("secret.pdf", 1)]), null);
  assert.equal(pagesOf(kernel).length, 0);
  assert.deepEqual(messagesOf(kernel), []);
  assert.equal(kernel.ui.getState().openError, null);
  assert.deepEqual(kernel.ui.getState().dialogs, []);
  assert.equal(kernel.viewer.open.size, 0);
});

test("a file that is no PDF is shown as a card in the empty editor; with a document open it is a toast", async () => {
  const kernel = makeKernel({ files: { [first(1)]: { fail: "VIEW_INVALID_PDF" }, [first(2)]: {} } });
  assert.equal(await kernel.actions.openFiles([fileItem("broken.pdf", 1)]), null);
  assert.deepEqual(kernel.ui.getState().openError, { fileName: "broken.pdf", code: "VIEW_INVALID_PDF", params: {} });
  assert.deepEqual(messagesOf(kernel), []);

  await kernel.actions.openFiles([fileItem("good.pdf", 2)]);
  assert.equal(kernel.ui.getState().openError, null, "a document that opens clears the card");
  assert.equal(await kernel.actions.openFiles([fileItem("broken.pdf", 1)]), null);
  assert.equal(pagesOf(kernel).length, 1, "the open document stays");
  assert.deepEqual(messagesOf(kernel), [["error", "broken.pdf: <VIEW_INVALID_PDF>"]]);
});

test("a very large file asks before it is opened", async () => {
  const many = Array.from({ length: LARGE_FILE_PAGES + 1 }, () => ({}));
  const kernel = makeKernel({ files: { [first(1)]: { pages: many } } });
  kernel.answer({ confirm: false });
  assert.equal(await kernel.actions.openFiles([fileItem("big.pdf", 1)]), null);
  assert.equal(pagesOf(kernel).length, 0);
  assert.equal(kernel.viewer.open.size, 0, "the viewer let go of the file");
  assert.equal(kernel.asked[0].id, "confirm");
  assert.match(kernel.asked[0].props.message, /501 pages/);

  kernel.answer({ confirm: true });
  await kernel.actions.openFiles([fileItem("big.pdf", 1)]);
  assert.equal(pagesOf(kernel).length, LARGE_FILE_PAGES + 1);
});

test("opening over a document with changes asks first; No keeps the document", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] }, [first(2)]: {} } });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  kernel.answer({ confirm: false });
  assert.equal(await kernel.actions.openFiles([fileItem("other.pdf", 2)]), null);
  assert.equal(pagesOf(kernel).length, 2);
  assert.equal(kernel.asked.at(-1).props.title, "Open another document?");

  kernel.answer({ confirm: true });
  await kernel.actions.openFiles([fileItem("other.pdf", 2)]);
  assert.equal(pagesOf(kernel).length, 1);
  assert.equal(kernel.store.getState().fileName, "other");
  assert.equal(Object.keys(kernel.store.getState().sources).length, 1, "the old source is gone with its document");
});

test("Add files appends at the end (or at an index) as one undo step", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] }, [first(2)]: { pages: [{}, {}, {}] } } });
  const before = pagesOf(kernel).map((page) => page.id);
  const result = await kernel.actions.addFiles([fileItem("more.pdf", 2)], 1);
  const after = pagesOf(kernel);
  assert.equal(after.length, 5);
  assert.deepEqual([after[0].id, after[4].id], before, "inserted between the two old pages");
  assert.equal(result.pageIds.length, 3);
  assert.deepEqual(kernel.viewer.calls.at(-1), ["scrollToPage", result.pageIds[0]]);
  assert.equal(kernel.store.isDirty(), true);
  const [tone, text] = messagesOf(kernel).at(-1);
  assert.deepEqual([tone, text], ["success", "Files added: 1. Pages added: 3."]);
  kernel.ui.undoToast(kernel.ui.getState().toasts.at(-1).id);
  assert.deepEqual(pagesOf(kernel).map((page) => page.id), before, "Undo of the toast takes the whole addition back");
});

test("a file the writer refuses cannot be combined with others, and one that opens alone becomes view-only", async () => {
  const refuse = { [first(2)]: "EXPORT_SOURCE_DAMAGED" };
  const { kernel } = await opened({ files: { [first(1)]: {}, [first(2)]: {} }, plan: { refuse } });
  assert.equal(await kernel.actions.addFiles([fileItem("odd.pdf", 2)]), null);
  assert.equal(pagesOf(kernel).length, 1);
  assert.match(messagesOf(kernel).at(-1)[1], /^odd\.pdf can be viewed but not edited here/);
  assert.equal(kernel.viewer.open.size, 1, "the refused file was closed again");

  const alone = await opened({ files: { [first(2)]: { pages: [{}, {}] } }, plan: { refuse } }, [fileItem("odd.pdf", 2)]);
  const { flags, notices } = alone.kernel.ui.getState();
  assert.equal(flags.editable, "no");
  assert.equal(flags.viewOnly.code, "EXPORT_SOURCE_DAMAGED");
  assert.deepEqual(notices.map((notice) => [notice.id, notice.code, notice.dismissible]), [[VIEW_ONLY_NOTICE, "EXPORT_SOURCE_DAMAGED", false]]);
  assert.equal(alone.kernel.actions.canEdit({ silent: true }), false);
  assert.equal(await alone.kernel.actions.setTool("pen"), false, "tools that change the document are refused");
  assert.equal(await alone.kernel.actions.setTool("hand"), true);
  assert.equal(alone.kernel.ui.getState().interaction.tool, "hand");
});

test("a view-only document: the signing flow is asked (it explains why such a file is not signed), with the verdict of the writer already known", async () => {
  // the signing feature decides and explains; what it sees when it is asked is the settled view-only state
  for (const code of ["EXPORT_SOURCE_INCONSISTENT", "EXPORT_SOURCE_DAMAGED"]) {
    const seen = [];
    const manifest = { id: "probe", toolActivators: { certSign: (editor) => seen.push(editor.ui.getState().flags.viewOnly?.code ?? null), pen: () => seen.push("pen") } };
    const kernel = makeKernel({ files: { [first(1)]: {} }, plan: { refuse: { [first(1)]: code } }, manifests: [manifest], idleDelay: 15 });
    await kernel.actions.openFiles([fileItem("odd.pdf", 1)]);
    assert.equal(kernel.ui.getState().flags.editable, "checking");
    assert.equal(await kernel.actions.setTool("certSign"), true, "the flow was asked");
    assert.deepEqual(seen, [code], "after the check had its answer, and no editing tool was started");
    assert.equal(kernel.ui.getState().interaction.tool, "select");
    assert.equal(await kernel.actions.setTool("pen"), false);
    assert.deepEqual(seen, [code]);
    assert.equal(kernel.ui.getState().toasts.length, 1, "only the refused editing tool said its sentence");
  }
  // no document: nothing to sign, the flow is not even asked
  const asked = [];
  const empty = makeKernel({ manifests: [{ id: "probe", toolActivators: { certSign: () => asked.push(1) } }] });
  assert.equal(await empty.actions.setTool("certSign"), false);
  assert.deepEqual(asked, []);
});

test("an edit that comes while the writer is still being asked waits for the answer", async () => {
  const refused = makeKernel({ files: { [first(1)]: {} }, plan: { refuse: { [first(1)]: "EXPORT_SOURCE_DAMAGED" } }, idleDelay: 15 });
  await refused.actions.openFiles([fileItem("odd.pdf", 1)]);
  assert.equal(refused.ui.getState().flags.editable, "checking");
  assert.equal(await refused.actions.setTool("pen"), false, "the tool was not started on a file that turned out to be view-only");
  assert.equal(refused.ui.getState().flags.editable, "no");
  assert.equal(refused.ui.getState().interaction.tool, "select");
  assert.equal(await refused.actions.beforeEdit(), false);

  const fine = makeKernel({ files: { [first(1)]: {} }, idleDelay: 15 });
  await fine.actions.openFiles([fileItem("good.pdf", 1)]);
  const [tool, page] = await Promise.all([fine.actions.setTool("pen"), fine.actions.beforeEdit()]);
  assert.deepEqual([tool, page, fine.ui.getState().flags.editable, fine.ui.getState().interaction.tool], [true, true, "yes", "pen"]);
  // tools that change nothing never wait
  const reading = makeKernel({ files: { [first(1)]: {} }, idleDelay: 15 });
  await reading.actions.openFiles([fileItem("good.pdf", 1)]);
  assert.equal(await reading.actions.setTool("hand"), true);
  assert.equal(reading.ui.getState().flags.editable, "checking");
  await flush();
});

test("what the writer notes about a file (signed, a dropped dynamic form) becomes a notice, once", async () => {
  const warning = { code: "EXPORT_SOURCE_SIGNED", params: { source: "x", signatures: 2 } };
  const { kernel } = await opened({ files: { [first(1)]: {} }, plan: { inspectWarnings: { [first(1)]: [warning, warning] } } });
  assert.deepEqual(kernel.ui.getState().notices.map((notice) => [notice.tone, notice.code]), [["warning", "EXPORT_SOURCE_SIGNED"]]);
});

test("feature hooks hear about opened and closed documents", async () => {
  const heard = [];
  const manifest = { id: "probe", onDocumentOpened: (editor, info) => heard.push(["opened", info.name, info.facts.pageCount, Boolean(editor.store)]), onDocumentClosed: () => heard.push(["closed"]) };
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] }, [first(2)]: {} }, manifests: [manifest] });
  await kernel.actions.openFiles([fileItem("next.pdf", 2)]);
  await kernel.actions.closeDocument();
  assert.deepEqual(heard, [["opened", "hop-dong.pdf", 2, true], ["closed"], ["opened", "next.pdf", 1, true], ["closed"]]);
  assert.equal(pagesOf(kernel).length, 0);
});

// --- output ----------------------------------------------------------------------------------------------------

test("a document without any change is delivered as the ORIGINAL bytes, as a private copy", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } } });
  const [source] = Object.values(kernel.store.getState().sources);
  const stored = kernel.store.getSourceBytes(source.id);
  const output = await kernel.actions.buildOutput({ purpose: "download" });
  assert.equal(output.original, true);
  assert.equal(output.report, null);
  assert.equal(output.baseName, "hop-dong");
  assert.deepEqual(output.bytes, stored);
  assert.notEqual(output.bytes, stored, "handing the store's own array to pdf.js would empty it");
  assert.equal(kernel.pipeline.calls.some(([name]) => name === "buildOutput"), false, "the pipeline did not run");
  assert.equal((await kernel.actions.buildOutput({ purpose: "sign" })).baseName, "hop-dong-signed");
});

test("any change sends the document through the pipeline; the job runs inside the job runner", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}, {}] } } });
  const [a, b, c] = pagesOf(kernel).map((page) => page.id);
  kernel.store.rotatePages([a], 90);
  kernel.store.deletePages([b]);
  const jobs = [];
  kernel.ui.subscribe(() => {
    const { job } = kernel.ui.getState();
    if (job) jobs.push([job.titleKey, job.progress, job.stage, job.cancellable]);
  });
  const output = await kernel.actions.buildOutput({ purpose: "download" });
  assert.equal(output.original, false);
  assert.equal(output.baseName, "hop-dong-edited");
  assert.deepEqual([...output.bytes], [80, 68, 70, 2]);
  assert.equal(output.report.pageCount, 2);
  const { job, options } = kernel.pipeline.calls.find(([name]) => name === "buildOutput")[1];
  assert.deepEqual(job.pages.map((page) => [page.index, page.rotate]), [[0, 90], [2, 0]]);
  assert.equal(job.sources.length, 1);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(jobs.at(0), ["Building the document…", null, null, true]);
  assert.ok(jobs.some(([, progress, stage]) => progress === 0.5 && stage === "PIPELINE_STAGE_ASSEMBLE"), "progress and stage reach the job card");
  assert.equal(kernel.ui.getState().job, null);
  assert.equal(c, pagesOf(kernel)[1].id, "the working document is untouched");
});

test("applied marks name the file -redacted; warnings of the report are shown, never dropped", async () => {
  const warnings = [{ code: "EXPORT_XFA_DROPPED", params: { source: "s" } }, { code: "EXPORT_STREAMS_REPAIRED", params: { source: "s", streams: 2 } }];
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } }, plan: { usedRedaction: true, warnings } });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 180);
  const output = await kernel.actions.buildOutput({ purpose: "download" });
  assert.equal(output.baseName, "hop-dong-redacted");
  const report = kernel.ui.getState().dialogs.find((dialog) => dialog.id === "report");
  assert.deepEqual(report.props.warnings, warnings);
  assert.equal(report.props.purpose, "download");
});

test("an extract builds only the pages asked for and is named after them, also from an unchanged document", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}, {}, {}] } } });
  const ids = pagesOf(kernel).map((page) => page.id);
  const output = await kernel.actions.buildOutput({ purpose: "extract", pageIds: [ids[1], ids[2]] });
  assert.equal(output.original, false);
  assert.equal(output.baseName, "hop-dong-pages-2-3");
  assert.deepEqual([...output.bytes], [80, 68, 70, 2]);
  assert.deepEqual(kernel.pipeline.calls.at(-1)[1].job.pages.map((page) => page.index), [1, 2]);
});

test("options reach the pipeline; info and now reach the export job; a caller's own job gets no second card", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } } });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  let cards = 0;
  kernel.ui.subscribe(() => {
    if (kernel.ui.getState().job) cards += 1;
  });
  const progress = [];
  const controller = new AbortController();
  const now = new Date("2026-11-20T03:00:00Z");
  await kernel.actions.buildOutput({ purpose: "sign", options: { keepOutline: false, info: {}, now, signal: controller.signal, onProgress: (fraction, stage) => progress.push([fraction, stage]) } });
  const { job, options } = kernel.pipeline.calls.at(-1)[1];
  assert.equal(options.keepOutline, false);
  assert.equal(options.signal, controller.signal);
  assert.equal("info" in options, false, "info belongs to the job, not to the pipeline options");
  assert.equal(job.now.getTime(), now.getTime());
  assert.deepEqual([...new Set(Object.values(job.info))], [""], "an empty override strips the document properties");
  assert.deepEqual(progress, [[0.5, "PIPELINE_STAGE_ASSEMBLE"]]);
  assert.equal(cards, 0);
});

test("a failed build delivers nothing: the failure is shown with Try again, and the document stays", async () => {
  const failures = [new PdfEditorError("EXPORT_AUDIT_FAILED"), new PdfEditorError("PIPELINE_SELF_CHECK_FAILED", { check: "text" })];
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } }, plan: { failures } });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  const answers = ["retry", null]; // Try again, then Close
  kernel.answer({ exportFailed: () => answers.shift() });
  assert.equal(await kernel.actions.buildOutput({ purpose: "download" }), null);
  const questions = kernel.asked.filter((entry) => entry.id === "exportFailed").map((entry) => [entry.props.code, entry.props.message, entry.props.purpose]);
  assert.deepEqual(questions, [
    ["EXPORT_AUDIT_FAILED", "<EXPORT_AUDIT_FAILED>", "download"],
    ["PIPELINE_SELF_CHECK_FAILED", "<PIPELINE_SELF_CHECK_FAILED>", "download"]
  ]);
  assert.equal(kernel.saved.length, 0);
  assert.equal(kernel.store.isDirty(), true);
  assert.equal(kernel.ui.getState().job, null);

  // the third attempt works
  kernel.answer({ exportFailed: "retry" });
  assert.deepEqual([...(await kernel.actions.buildOutput({ purpose: "download" })).bytes], [80, 68, 70, 2]);
});

test("Cancel during a build ends it without a word", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } } });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  const off = kernel.ui.subscribe(() => {
    if (kernel.ui.getState().job?.cancellable) kernel.actions.cancelJob();
  });
  assert.equal(await kernel.actions.buildOutput({ purpose: "download" }), null);
  off();
  assert.deepEqual(kernel.asked, []);
  assert.deepEqual(messagesOf(kernel), []);
  assert.equal(kernel.ui.getState().job, null);
  assert.equal(kernel.actions.cancelJob(), false, "nothing runs any more");
});

test("a view-only document is delivered as the file itself and is never built", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } }, plan: { refuse: { [first(1)]: "EXPORT_ENCRYPTION_UNSUPPORTED" } } });
  const output = await kernel.actions.buildOutput({ purpose: "print" });
  assert.equal(output.original, true);
  assert.equal(await kernel.actions.buildOutput({ purpose: "extract", pageIds: [pagesOf(kernel)[0].id] }), null, "an extract would need the writer");
  assert.deepEqual(messagesOf(kernel).at(-1), ["error", "<EXPORT_ENCRYPTION_UNSUPPORTED>"]);
});

test("printing a protected, unchanged file builds a copy: the print frame cannot ask for a password", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { password: "user123" } } }, [{ ...fileItem("secret.pdf", 1), password: "user123" }]);
  assert.equal((await kernel.actions.buildOutput({ purpose: "print" })).original, false);
  assert.equal((await kernel.actions.buildOutput({ purpose: "download" })).original, true, "the download is still the file itself");
});

test("Download saves under the right name, releases the unsaved-changes guard and says so", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } } });
  const unchanged = await kernel.actions.download();
  assert.deepEqual(unchanged, { fileName: "hop-dong.pdf", original: true, report: null });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  kernel.store.setFileName("Hợp đồng 2026");
  assert.equal(kernel.store.isDirty(), true);
  const edited = await kernel.actions.download();
  assert.equal(edited.fileName, "Hợp đồng 2026-edited.pdf");
  assert.equal(edited.original, false);
  assert.deepEqual(kernel.saved.map((entry) => [entry.fileName, entry.blob.type, entry.blob.size]), [["hop-dong.pdf", "application/pdf", 64], ["Hợp đồng 2026-edited.pdf", "application/pdf", 4]]);
  assert.equal(kernel.store.isDirty(), false);
  assert.equal(kernel.store.canUndo(), true, "the history stays: the user can go on and download again");
  assert.equal(kernel.ui.getState().flags.savedAs, "downloaded");
  assert.deepEqual(messagesOf(kernel).at(-1), ["success", "Hợp đồng 2026-edited.pdf was downloaded."]);
  assert.equal(await makeKernel().actions.download(), null, "nothing to download without a document");
});

test("Print hands the built bytes to the viewer; a browser that cannot print offers the download", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } } });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  assert.deepEqual(await kernel.actions.print(), { loaded: true, printCalled: true });
  assert.deepEqual(kernel.viewer.calls.at(-1), ["printBytes", 4]);
  assert.equal(kernel.store.isDirty(), true, "printing is not saving");

  kernel.viewer.canPrint = () => false;
  kernel.answer({ confirm: true });
  const fallback = await kernel.actions.print();
  assert.equal(kernel.asked.at(-1).props.title, "Printing is not available in this browser");
  assert.equal(fallback.fileName, "hop-dong-edited.pdf");
  assert.equal(kernel.saved.length, 1);

  kernel.viewer.canPrint = () => true;
  kernel.viewer.printBytes = async () => ({ loaded: false, printCalled: false, reason: "timeout" });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  await kernel.actions.print();
  assert.equal(kernel.asked.at(-1).props.title, "The print dialog could not be opened");
  assert.equal(kernel.saved.length, 2, "the offered download was taken");
});

// --- jobs, questions, tools ------------------------------------------------------------------------------------------

test("runJob publishes title, progress, stage and detail, and always clears the job", async () => {
  const kernel = makeKernel();
  const seen = [];
  kernel.ui.subscribe(() => seen.push(kernel.ui.getState().job));
  const result = await kernel.actions.runJob({ titleKey: "Signing…", cancellable: true }, async ({ signal, progress, describe }) => {
    describe("contract.pdf");
    progress(0.25, "PIPELINE_STAGE_DRAW");
    progress(null);
    assert.equal(signal.aborted, false);
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(seen.map((job) => job && [job.titleKey, job.progress, job.stage, job.detail, job.cancellable]), [
    ["Signing…", null, null, "", true],
    ["Signing…", null, null, "contract.pdf", true],
    ["Signing…", 0.25, "PIPELINE_STAGE_DRAW", "contract.pdf", true],
    ["Signing…", null, "PIPELINE_STAGE_DRAW", "contract.pdf", true],
    null
  ]);
  await assert.rejects(kernel.actions.runJob({ titleKey: "Signing…" }, async () => Promise.reject(new Error("no"))), /no/);
  assert.equal(kernel.ui.getState().job, null);
});

test("Cancel aborts the signal of a cancellable job only; history and tools wait while a job runs", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } } });
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  let release;
  const running = kernel.actions.runJob({ titleKey: "Working…", cancellable: false }, () => new Promise((resolve) => (release = resolve)));
  assert.equal(kernel.actions.cancelJob(), false);
  assert.equal(kernel.actions.undo(), false);
  assert.equal(await kernel.actions.setTool("hand"), false);
  assert.equal(await kernel.actions.download(), null);
  release();
  await running;
  assert.equal(kernel.actions.undo(), true);

  const aborted = kernel.actions.runJob({ titleKey: "Working…", cancellable: true }, ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(signal.aborted))));
  await flush(1); // the task has started and waits
  assert.equal(kernel.actions.cancelJob(), true);
  assert.equal(await aborted, true);

  // Cancel before the task even began: it never runs, the job ends as cancelled
  let ran = false;
  const early = kernel.actions.runJob({ titleKey: "Working…", cancellable: true }, () => (ran = true));
  assert.equal(kernel.actions.cancelJob(), true);
  await assert.rejects(early, (error) => error.code === "CANCELLED");
  assert.equal(ran, false);
  assert.equal(kernel.ui.getState().job, null);
});

test("confirm resolves true only for an explicit yes", async () => {
  const kernel = makeKernel();
  kernel.answer({ confirm: true });
  assert.equal(await kernel.actions.confirm({ title: "Sure?" }), true);
  kernel.answer({ confirm: undefined });
  assert.equal(await kernel.actions.confirm({ title: "Sure?" }), false, "closed with Escape or the X");
  assert.deepEqual(kernel.asked[0].props, { title: "Sure?", message: undefined, confirmLabel: undefined, cancelLabel: undefined, tone: "primary", details: null });
});

test("editing a signed document asks once per document", async () => {
  const signed = { facts: { signatureCount: 2 }, pages: [{}, {}] };
  const { kernel } = await opened({ files: { [first(1)]: signed, [first(2)]: {} } });
  kernel.answer({ confirm: false });
  assert.equal(await kernel.actions.setTool("text"), false);
  assert.equal(kernel.ui.getState().interaction.tool, "select");
  assert.match(kernel.asked.at(-1).props.message, /invalidate 2 existing signatures/);
  assert.equal(await kernel.actions.setTool("hand"), true, "tools that change nothing never ask");

  kernel.answer({ confirm: true });
  assert.equal(await kernel.actions.beforeEdit(), true);
  assert.equal(kernel.ui.getState().flags.signedEditConfirmed, true);
  const questions = kernel.asked.length;
  assert.equal(await kernel.actions.setTool("text"), true);
  assert.equal(await kernel.actions.confirmEditingSigned(), true);
  assert.equal(kernel.asked.length, questions, "not asked again");

  // two callers at the same moment share one question
  const again = await opened({ files: { [first(1)]: signed } });
  again.kernel.answer({ confirm: true });
  const [one, two] = await Promise.all([again.kernel.actions.confirmEditingSigned(), again.kernel.actions.confirmEditingSigned()]);
  assert.deepEqual([one, two, again.kernel.asked.length], [true, true, 1]);

  // another document is asked again; an unsigned one never
  await kernel.actions.openFiles([fileItem("plain.pdf", 2)]);
  assert.equal(kernel.ui.getState().flags.signedEditConfirmed, false);
  assert.equal(await kernel.actions.confirmEditingSigned(), true);
});

test("setTool: editing tools need a document; shapes are remembered; activators of the features run; certSign is a flow", async () => {
  const activated = [];
  const manifest = { id: "probe", toolActivators: { image: () => activated.push("image"), certSign: async () => activated.push("certSign"), pen: () => { throw new PdfEditorError("TEXT_FONT_FETCH_FAILED", { font: "arimo-regular", status: 0 }); } } };
  const empty = makeKernel({ manifests: [manifest] });
  assert.equal(await empty.actions.setTool("text"), false, "nothing to edit");
  assert.equal(await empty.actions.setTool("laser"), false);

  const { kernel } = await opened({ files: { [first(1)]: {} }, manifests: [manifest] });
  assert.equal(await kernel.actions.setTool("arrow", { lock: true }), true);
  assert.deepEqual([kernel.ui.getState().interaction.tool, kernel.ui.getState().interaction.toolLocked], ["arrow", true]);
  assert.equal(kernel.ui.getState().preferences.lastShape, "arrow");
  assert.equal(await kernel.actions.setTool("image"), true);
  assert.equal(await kernel.actions.setTool("certSign"), true);
  assert.equal(kernel.ui.getState().interaction.tool, "image", "the signing flow chooses the tool itself, for its position step");
  assert.deepEqual(activated, ["image", "certSign"]);
  assert.equal(await kernel.actions.setTool("pen"), true);
  assert.deepEqual(messagesOf(kernel).at(-1), ["error", "<TEXT_FONT_FETCH_FAILED>"], "an activator that fails is reported, not thrown");
});

// --- view, shell ----------------------------------------------------------------------------------------------------

test("zoom stays between 25 % and 400 %; Automatic fits the width but not above 125 %", async () => {
  const { kernel } = await opened({ files: { [first(1)]: {} } });
  const zoomOf = () => kernel.viewer.getSnapshot().zoom;
  kernel.actions.setZoom(9);
  assert.equal(zoomOf(), ZOOM_LIMITS.max);
  kernel.actions.setZoom(0.01);
  assert.equal(zoomOf(), ZOOM_LIMITS.min);
  assert.equal(kernel.ui.getState().autoZoom, false);
  kernel.actions.zoomBy(2);
  assert.equal(zoomOf(), 0.5);
  kernel.actions.zoomIn();
  assert.equal(zoomOf(), 0.67);
  kernel.actions.zoomOut();
  assert.equal(zoomOf(), 0.5);

  kernel.viewer.setFitWidth(2.1);
  kernel.actions.zoomAuto();
  assert.equal(zoomOf(), AUTO_ZOOM_MAX);
  assert.equal(kernel.ui.getState().autoZoom, true);
  kernel.viewer.setFitWidth(0.8);
  kernel.actions.zoomAuto();
  assert.equal(zoomOf(), 0.8);
  assert.equal(kernel.viewer.getSnapshot().zoomMode, "fit-width", "below the cap the viewer keeps fitting by itself");
  kernel.viewer.setFitWidth(0.05);
  kernel.actions.setZoom("fit-width");
  assert.equal(zoomOf(), ZOOM_LIMITS.min, "a fit mode never leaves the range either");
});

test("page navigation scrolls by number or id and stays inside the document", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}, {}] } } });
  const ids = pagesOf(kernel).map((page) => page.id);
  const last = () => kernel.viewer.calls.at(-1);
  assert.equal(kernel.actions.goToPage(2), true);
  assert.deepEqual(last(), ["scrollToPage", ids[1]]);
  kernel.actions.goToPage(99);
  assert.deepEqual(last(), ["scrollToPage", ids[2]]);
  kernel.actions.goToPage(-3);
  assert.deepEqual(last(), ["scrollToPage", ids[0]]);
  assert.equal(kernel.actions.goToPage(ids[2]), true);
  assert.equal(kernel.actions.goToPage("nope"), false);
  kernel.viewer.setCurrentPage(3);
  kernel.actions.nextPage();
  assert.deepEqual(last(), ["scrollToPage", ids[2]], "there is no page after the last");
  kernel.actions.previousPage();
  assert.deepEqual(last(), ["scrollToPage", ids[1]]);
  kernel.actions.firstPage();
  assert.deepEqual(last(), ["scrollToPage", ids[0]]);
  kernel.actions.lastPage();
  assert.deepEqual(last(), ["scrollToPage", ids[2]]);
  assert.equal(makeKernel().actions.nextPage(), false, "no document, no page");
});

test("search keeps query and options in the UI store and runs the viewer's search", async () => {
  const { kernel } = await opened({ files: { [first(1)]: {} } });
  await kernel.actions.search("hop dong", { matchCase: true });
  assert.deepEqual(kernel.viewer.calls.at(-1), ["search", "hop dong"]);
  assert.deepEqual(kernel.ui.getState().search.options, { matchCase: true, wholeWord: false, matchDiacritics: false });
  kernel.actions.openSearch();
  assert.equal(kernel.ui.getState().search.open, true);
  assert.equal(kernel.ui.getState().search.focusToken, 1);
  kernel.actions.findNext();
  assert.deepEqual(kernel.viewer.calls.at(-1), ["search", "hop dong"], "the viewer has not searched this query yet: search, do not step");
  kernel.actions.closeSearch();
  assert.deepEqual(kernel.viewer.calls.at(-1), ["clearSearch"]);
  assert.deepEqual([kernel.ui.getState().search.open, kernel.ui.getState().search.query], [false, ""]);
  kernel.actions.findNext();
  assert.equal(kernel.ui.getState().search.open, true, "without a query the key opens the field");
});

test("panels and views come from the manifests; F4 reopens the panel that was open last", async () => {
  const Panel = () => null;
  const manifest = { id: "probe", panels: { pages: { labelKey: "Pages", component: Panel, order: 10 }, outline: { labelKey: "Outline", component: Panel, order: 20 } }, fullScreenViews: { organiser: Panel }, dialogs: { shortcuts: Panel } };
  const { kernel } = await opened({ files: { [first(1)]: {} }, manifests: [manifest] });
  assert.equal(kernel.ui.getState().leftPanel, "pages", "a first document on a wide screen starts with its pages panel");
  kernel.actions.toggleLeftPanel("outline");
  kernel.actions.toggleLeftPanel();
  assert.equal(kernel.ui.getState().leftPanel, null);
  kernel.actions.toggleLeftPanel();
  assert.equal(kernel.ui.getState().leftPanel, "outline");
  assert.equal(kernel.actions.openLeftPanel("nope"), false);

  assert.equal(kernel.actions.toggleView("organiser"), true);
  assert.equal(kernel.ui.getState().view, "organiser");
  kernel.actions.toggleView("organiser");
  assert.equal(kernel.ui.getState().view, null);
  assert.equal(kernel.actions.toggleView("nope"), false);
  assert.equal(kernel.actions.openKernelDialog("shortcuts"), true);
  assert.equal(kernel.actions.openKernelDialog("properties"), true, "the kernel has its own");
  assert.equal(kernel.actions.openKernelDialog("certificate"), false, "nobody registered it");
  assert.equal(makeKernel().actions.toggleLeftPanel(), false, "no panels, nothing to open");
});

test("what the reducer leaves to the shell: Escape closes what lies over the pages, hints are toasts said once", async () => {
  const Panel = () => null;
  const { kernel } = await opened({ files: { [first(1)]: {} }, manifests: [{ id: "probe", panels: { pages: { labelKey: "Pages", component: Panel } } }] });
  // wide: nothing lies over the pages
  kernel.ui.runInteraction({ type: "shortcut", id: "escape" });
  assert.equal(kernel.ui.getState().leftPanel, "pages");

  kernel.ui.setLayout("medium");
  kernel.ui.openLeftPanel("pages");
  kernel.ui.setInspector({ open: true });
  kernel.ui.setSearch({ open: true });
  const escape = () => kernel.ui.runInteraction({ type: "shortcut", id: "escape" });
  escape();
  assert.equal(kernel.ui.getState().search.open, false, "first the search field");
  escape();
  assert.equal(kernel.ui.getState().leftPanel, null, "then the panel");
  escape();
  assert.equal(kernel.ui.getState().inspector.open, false, "then the properties panel");

  // the cascade of the reducer comes first: tool, then the shell
  await kernel.actions.setTool("pen");
  kernel.ui.openLeftPanel("pages");
  escape();
  assert.deepEqual([kernel.ui.getState().interaction.tool, kernel.ui.getState().leftPanel], ["select", "pages"]);

  kernel.actions.runShellEffects([{ type: "hint", id: "editTextNoLine", message: "Click a line of text to edit it. This page may be a scan without editable text." }]);
  kernel.actions.runShellEffects([{ type: "hint", id: "editTextNoLine", message: "Click a line of text to edit it. This page may be a scan without editable text." }]);
  assert.equal(kernel.ui.getState().toasts.filter((toast) => toast.message.startsWith("Click a line")).length, 1);
});

test("the pending-marks counter asks the features first, then opens the properties panel", async () => {
  const heard = [];
  const { kernel } = await opened({ files: { [first(1)]: {} }, manifests: [{ id: "probe", commands: { showPendingMarks: (editor, event) => (heard.push(event.id), true) } }] });
  kernel.ui.setInspector({ open: false });
  kernel.actions.showPendingMarks();
  assert.deepEqual(heard, ["showPendingMarks"]);
  assert.equal(kernel.ui.getState().inspector.open, false);
  const plain = await opened({ files: { [first(1)]: {} } });
  plain.kernel.ui.setInspector({ open: false });
  plain.kernel.actions.showPendingMarks();
  assert.equal(plain.kernel.ui.getState().inspector.open, true);
});

test("leaving: at once without changes; with changes Stay, Leave, or Download and leave", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } } });
  let left = 0;
  const go = () => (left += 1);
  assert.equal(await kernel.actions.requestLeave(go), true);
  assert.equal(left, 1);
  assert.equal(kernel.asked.length, 0);

  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  kernel.answer({ leave: "stay" });
  assert.equal(await kernel.actions.requestLeave(go), false);
  kernel.answer({ leave: undefined });
  assert.equal(await kernel.actions.requestLeave(go), false, "closing the dialog means stay");
  assert.equal(left, 1);

  kernel.answer({ leave: "download" });
  assert.equal(await kernel.actions.requestLeave(go), true);
  assert.equal(left, 2);
  assert.equal(kernel.saved.at(-1).fileName, "hop-dong-edited.pdf");

  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  kernel.answer({ leave: "leave" });
  assert.equal(await kernel.actions.requestLeave(go), true);
  assert.equal(left, 3);
  assert.equal(kernel.saved.length, 1, "nothing more was downloaded");
});

test("the store, the selection and the viewer stay in step through undo", async () => {
  const { kernel } = await opened({ files: { [first(1)]: { pages: [{}, {}] } } });
  const pageId = pagesOf(kernel)[0].id;
  const [id] = kernel.store.addObjects([sample.rect(pageId)]);
  kernel.ui.runInteraction({ type: "setSelection", ids: [id] });
  assert.deepEqual(kernel.ui.getState().interaction.selection, [id]);
  kernel.actions.undo();
  assert.deepEqual(kernel.ui.getState().interaction.selection, [], "what was selected is gone: the reducer heard documentChanged");
  kernel.actions.redo();
  assert.ok(kernel.store.getState().objects[id]);
});

test("reportError says a sentence for an engine code and nothing for a cancellation", () => {
  const kernel = makeKernel();
  assert.equal(kernel.actions.reportError(new PdfEditorError("CANCELLED")), false);
  assert.equal(kernel.actions.reportError(new PdfEditorError("VIEW_PASSWORD_CANCELLED")), false);
  assert.equal(kernel.actions.reportError(null), false);
  assert.equal(kernel.actions.reportError(new PdfEditorError("MODEL_LAST_PAGE")), true);
  assert.equal(kernel.actions.reportError(new TypeError("x is undefined")), true);
  assert.deepEqual(messagesOf(kernel), [["error", "<MODEL_LAST_PAGE>"], ["error", "<UNEXPECTED>"]], "a raw exception never shows its own text");
});
