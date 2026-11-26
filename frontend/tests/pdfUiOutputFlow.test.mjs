// The document-level flows of actions.buildOutput() (src/pages/pdfEditor/ui/actions.js) against the real stores
// with stand-ins around them (tests/helpers/pdfUiKit.mjs): the question before a build, the review of a build
// that still holds removed content, the report, a failed verification, and documents whose author restricted changes.
import test from "node:test";
import assert from "node:assert/strict";
import { PdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { bytesOf, sample } from "./helpers/pdfModelKit.mjs";
import { fileItem, flush, makeKernel } from "./helpers/pdfUiKit.mjs";

const first = (seed) => bytesOf(1, seed)[0];
const pagesOf = (kernel) => kernel.store.getState().pages;
const toasts = (kernel) => kernel.ui.getState().toasts.map((toast) => [toast.tone, toast.message]);
const dialogs = (kernel, id) => kernel.asked.filter((entry) => entry.id === id);
const builds = (kernel) => kernel.pipeline.calls.filter(([name]) => name === "buildOutput").map(([, call]) => call);

async function opened(options = {}, items = [fileItem("hop-dong.pdf", 1)]) {
  const kernel = makeKernel({ files: { [first(1)]: { pages: [{}, {}, {}] } }, ...options });
  await kernel.actions.openFiles(items);
  await flush();
  return kernel;
}

/** A redaction report as the pipeline writes it, from the marks of the job; `tweak` changes it per build. */
const redactionReport = (tweak = () => ({})) => (job, options) => {
  const targets = job.marks.map((mark, index) => ({ index, pageIndex: mark.pageIndex, mode: mark.mode, outcome: "precise", objectId: mark.objectId }));
  const pageIndexes = [...new Set(job.marks.map((mark) => mark.pageIndex))];
  const base = {
    usedRedaction: job.marks.length > 0,
    redaction: {
      pages: pageIndexes.map((pageIndex) => ({ pageIndex, path: "precise", reasons: [], areas: job.marks.filter((mark) => mark.pageIndex === pageIndex && mark.mode !== "erase").length, replacedLines: 0 })),
      targets,
      coveredObjectIds: [],
      elsewhere: [],
      fontsNotCleaned: [],
      rasterPagesNotApplied: []
    }
  };
  const changed = tweak(job, options, base) || {};
  return { ...base, ...changed, redaction: changed.redaction === undefined ? base.redaction : changed.redaction };
};

// --- the question before a build ----------------------------------------------------------------------------------

test("pending marks are asked about before anything is built; Cancel builds and saves nothing", async () => {
  const kernel = await opened({ plan: { report: redactionReport() } });
  const [a, , c] = pagesOf(kernel).map((page) => page.id);
  kernel.store.addObjects([sample.redact(a), sample.redact(c), sample.blur(c)]);
  kernel.answer({ export: null });
  assert.equal(await kernel.actions.download(), null);
  const [question] = dialogs(kernel, "export");
  assert.equal(question.props.purpose, "download");
  assert.equal(question.props.suggestedName, "hop-dong-redacted");
  assert.deepEqual([question.props.plan.redact, question.props.plan.blur, question.props.plan.markPages], [2, 1, 2]);
  assert.equal(builds(kernel).length, 0, "the pipeline never ran");
  assert.equal(kernel.saved.length, 0);
  assert.equal(kernel.store.isDirty(), true);
  assert.deepEqual(toasts(kernel), []);
  assert.equal(kernel.ui.getState().job, null);
});

test("confirming builds, saves under the name of the dialog, and reports per page; the marks stay pending", async () => {
  const kernel = await opened({ plan: { report: redactionReport() } });
  const [a, , c] = pagesOf(kernel).map((page) => page.id);
  kernel.store.addObjects([sample.redact(a), sample.redact(c), sample.blur(c)]);
  kernel.answer({ export: { baseName: "ban-gui-doi-tac", removeProperties: true, removeBookmarks: false } });
  const result = await kernel.actions.download();
  assert.equal(result.fileName, "ban-gui-doi-tac.pdf");
  assert.deepEqual(kernel.saved.map((entry) => entry.fileName), ["ban-gui-doi-tac.pdf"]);
  const [{ job, options }] = builds(kernel);
  assert.deepEqual([...new Set(Object.values(job.info))], [""], "Remove document properties: the job is built with an empty info");
  assert.equal(options.keepOutline, undefined, "bookmarks are kept unless asked");
  assert.equal(job.marks.length, 3);

  const report = kernel.ui.getState().dialogs.find((dialog) => dialog.id === "report");
  assert.equal(report.props.fileName, "ban-gui-doi-tac.pdf");
  assert.deepEqual(report.props.summary.rows.map((row) => [row.pageNumber, row.areas, row.path]), [[1, 1, "precise"], [3, 2, "precise"]]);
  assert.deepEqual(toasts(kernel), [], "the report says that the file was downloaded: no second message");
  assert.equal(Object.values(kernel.store.getState().objects).filter((object) => object.type === "redact" || object.type === "blur").length, 3, "the working document keeps its marks");
  assert.equal(kernel.store.isDirty(), false);

  // the review step: the file that was handed out, in a new tab
  report.props.onOpen();
  assert.equal(kernel.openedTabs.length, 1);
  assert.deepEqual([kernel.openedTabs[0].type, kernel.openedTabs[0].size], ["application/pdf", 4]);
});

test("the default name of a redacted download ends in -redacted; without a changed name the report decides", async () => {
  const kernel = await opened({ plan: { report: redactionReport() } });
  kernel.store.addObjects([sample.redact(pagesOf(kernel)[0].id)]);
  kernel.answer({ export: (props) => ({ baseName: props.suggestedName, removeProperties: false, removeBookmarks: true }) });
  assert.equal((await kernel.actions.download()).fileName, "hop-dong-redacted.pdf");
  assert.equal(builds(kernel)[0].options.keepOutline, false, "Remove bookmarks");
  assert.equal(Object.values(builds(kernel)[0].job.info).some(Boolean), true, "the properties are kept");
});

test("Print and the document that gets signed go through the same question", async () => {
  const kernel = await opened({ plan: { report: redactionReport() } });
  kernel.store.addObjects([sample.blur(pagesOf(kernel)[1].id)]);
  kernel.answer({ export: null });
  assert.equal(await kernel.actions.print(), null);
  assert.equal(await kernel.actions.buildOutput({ purpose: "sign" }), null);
  assert.deepEqual(dialogs(kernel, "export").map((entry) => entry.props.purpose), ["print", "sign"]);
  assert.equal(kernel.viewer.calls.some(([name]) => name === "printBytes"), false, "nothing reached the printer");

  kernel.answer({ export: { baseName: null, removeProperties: false, removeBookmarks: false } });
  assert.deepEqual(await kernel.actions.print(), { loaded: true, printCalled: true });
  const report = kernel.ui.getState().dialogs.find((dialog) => dialog.id === "report");
  assert.deepEqual([report.props.purpose, report.props.fileName], ["print", null]);
  kernel.ui.closeAllDialogs();

  const signed = await kernel.actions.buildOutput({ purpose: "sign" });
  assert.equal(signed.baseName, "hop-dong-signed");
  const shown = kernel.ui.getState().dialogs.find((dialog) => dialog.id === "report");
  assert.equal(shown.props.purpose, "sign", "a caller that does not deliver itself gets the report at once");
  assert.equal(shown.props.onOpen, undefined, "the file that gets signed is not the file the user ends up with");
});

test("a build inside the caller's own job is still asked about, and an aborted caller gets nothing", async () => {
  const kernel = await opened({ plan: { report: redactionReport() } });
  kernel.store.addObjects([sample.redact(pagesOf(kernel)[0].id)]);
  const controller = new AbortController();
  kernel.answer({
    export: () => {
      controller.abort();
      return { baseName: null, removeProperties: false, removeBookmarks: false };
    }
  });
  assert.equal(await kernel.actions.buildOutput({ purpose: "sign", options: { signal: controller.signal } }), null);
  assert.equal(builds(kernel).length, 0);
});

test("text boxes that will become pictures are said before the build, with Go back", async () => {
  const kernel = await opened({ checkText: (object) => (object.text.includes("#") ? { ok: false, fallback: [], unsupported: [{ char: "#", reason: "no-font" }] } : { ok: true, fallback: [], unsupported: [] }) });
  const [a, b] = pagesOf(kernel).map((page) => page.id);
  kernel.store.addObjects([sample.text(a, { text: "a # b" }), sample.text(b, { text: "plain" })]);
  kernel.answer({ export: null });
  assert.equal(await kernel.actions.download(), null);
  const [question] = dialogs(kernel, "export");
  assert.deepEqual(question.props.plan.pictureText.map((entry) => [entry.pageNumber, entry.characters]), [[1, ["#"]]]);
  assert.equal(question.props.suggestedName, "hop-dong-edited", "no marks: the file is not called redacted");
  assert.equal(builds(kernel).length, 0);

  kernel.answer({ export: (props) => ({ baseName: props.suggestedName, removeProperties: false, removeBookmarks: false }) });
  assert.equal((await kernel.actions.download()).fileName, "hop-dong-edited.pdf");
});

test("a document with nothing to ask is built at once; Download options asks anyway and can strip an unchanged file", async () => {
  const kernel = await opened();
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  await kernel.actions.download();
  assert.deepEqual(dialogs(kernel, "export"), []);

  const pristine = await opened();
  pristine.answer({ export: (props) => ({ baseName: props.suggestedName, removeProperties: false, removeBookmarks: false }) });
  const same = await pristine.actions.download({ ask: true });
  assert.deepEqual([same.fileName, same.original], ["hop-dong.pdf", true], "nothing chosen: still the file itself");
  assert.equal(dialogs(pristine, "export")[0].props.suggestedName, "hop-dong");

  pristine.answer({ export: (props) => ({ baseName: props.suggestedName, removeProperties: true, removeBookmarks: false }) });
  const stripped = await pristine.actions.download({ ask: true });
  assert.deepEqual([stripped.fileName, stripped.original], ["hop-dong-edited.pdf", false], "leaving something out makes it a new file");
  assert.deepEqual([...new Set(Object.values(builds(pristine)[0].job.info))], [""]);
});

test("the options of a caller are the defaults of the dialog", async () => {
  const kernel = await opened({ plan: { report: redactionReport() } });
  kernel.store.addObjects([sample.redact(pagesOf(kernel)[0].id)]);
  kernel.answer({ export: null });
  await kernel.actions.buildOutput({ purpose: "extract", pageIds: [pagesOf(kernel)[0].id], options: { info: {}, keepOutline: false } });
  assert.deepEqual(dialogs(kernel, "export")[0].props.defaults, { removeProperties: true, removeBookmarks: true });
  await kernel.actions.buildOutput({ purpose: "extract", pageIds: [pagesOf(kernel)[1].id] });
  assert.equal(dialogs(kernel, "export").length, 1, "the marks are on page 1: an extract of page 2 has nothing to ask");
});

// --- removed content that is still in the built file ------------------------------------------------------------------

test("a file that still holds removed content is not handed out before the user decided; Cancel delivers nothing", async () => {
  const leaky = redactionReport(() => ({ redaction: undefined }));
  const kernel = await opened({
    plan: {
      report: (job, options) => {
        const report = leaky(job, options);
        report.redaction.elsewhere = [{ where: "outline", count: 2 }, { where: "form", count: 1 }];
        return report;
      }
    }
  });
  kernel.store.addObjects([sample.redact(pagesOf(kernel)[0].id)]);
  kernel.answer({ export: { baseName: null, removeProperties: false, removeBookmarks: false }, exportReview: null });
  assert.equal(await kernel.actions.download(), null);
  assert.equal(builds(kernel).length, 1, "the file was built");
  assert.equal(kernel.saved.length, 0, "and not handed out");
  const [review] = dialogs(kernel, "exportReview");
  assert.deepEqual(review.props.findings.items.map((item) => [item.id, item.remedy]), [["elsewhere-outline", "removeBookmarks"], ["elsewhere-form", null]]);
  assert.equal(kernel.ui.getState().dialogs.some((dialog) => dialog.id === "report"), false);
});

test("the remedies the user chooses build the file again; what the second build still holds is asked again without offers", async () => {
  let round = 0;
  const kernel = await opened({
    plan: {
      report: redactionReport((job, options, base) => {
        round += 1;
        const redaction = { ...base.redaction };
        // the replaced line is covered until the build removes it for real; the title repeats the redacted text
        // until the properties are left out; a form field keeps it whatever the options are
        if (options.eraseFallback !== "redact") {
          redaction.targets = redaction.targets.map((entry) => (entry.mode === "erase" ? { ...entry, outcome: "cover-needed" } : entry));
          redaction.coveredObjectIds = redaction.targets.filter((entry) => entry.outcome === "cover-needed").map((entry) => entry.objectId);
        }
        redaction.elsewhere = [...(Object.values(job.info).some(Boolean) ? [{ where: "metadata", count: 1 }] : []), { where: "form", count: 1 }];
        return { redaction };
      })
    }
  });
  const [a] = pagesOf(kernel).map((page) => page.id);
  kernel.store.addObjects([sample.redact(a), sample.text(a, { replaces: { rect: [50, 700, 250, 720], cover: "#ffffff", sourceText: "old words" } })]);
  const reviews = [];
  kernel.answer({
    export: { baseName: null, removeProperties: false, removeBookmarks: false },
    exportReview: (props) => {
      reviews.push(props.findings.items.map((item) => [item.id, item.remedy]));
      return reviews.length === 1 ? { remedies: ["removeCovered", "removeProperties"] } : { deliver: true };
    }
  });
  const result = await kernel.actions.download();
  assert.equal(round, 2);
  assert.deepEqual(reviews, [
    [["covered", "removeCovered"], ["elsewhere-metadata", "removeProperties"], ["elsewhere-form", null]],
    [["elsewhere-form", null]]
  ]);
  const [firstBuild, secondBuild] = builds(kernel);
  assert.equal(firstBuild.options.eraseFallback, undefined);
  assert.equal(secondBuild.options.eraseFallback, "redact");
  assert.deepEqual([...new Set(Object.values(secondBuild.job.info))], [""]);
  assert.equal(result.fileName, "hop-dong-redacted.pdf");
  assert.equal(kernel.saved.length, 1, "one file, the second one");
  const report = kernel.ui.getState().dialogs.find((dialog) => dialog.id === "report");
  assert.equal(report.props.summary.covered.count, 0);
  assert.deepEqual(report.props.summary.elsewhere, [{ where: "form", count: 1 }]);
});

test("deleted pages: a bookmark that was kept for the bookmarks under it is asked about before the file is handed out, and removed on request", async () => {
  const retargeted = { code: "EXPORT_OUTLINE_RETARGETED", params: { source: "s", items: 2 } };
  const kernel = await opened({ plan: { report: (job, options) => ({ warnings: options.dropOrphanBookmarks ? [] : [retargeted] }) } });
  kernel.store.deletePages([pagesOf(kernel)[1].id]);

  // Cancel: built once, nothing handed out, nothing said
  kernel.answer({ exportReview: null });
  assert.equal(await kernel.actions.download(), null);
  assert.equal(dialogs(kernel, "export").length, 0, "no marks: nothing is asked before the build");
  assert.deepEqual(dialogs(kernel, "exportReview")[0].props.findings.items.map((item) => [item.kind, item.remedy, item.count]), [["bookmarks", "removeOrphanBookmarks", 2]]);
  assert.equal(kernel.saved.length, 0);

  // the remedy: the file is built again with the option of the export engine, and that file is the one delivered
  kernel.answer({ exportReview: { remedies: ["removeOrphanBookmarks"] } });
  const result = await kernel.actions.download();
  const [, second, third] = builds(kernel);
  assert.deepEqual([second.options.dropOrphanBookmarks, third.options.dropOrphanBookmarks], [undefined, true]);
  assert.equal(result.fileName, "hop-dong-edited.pdf");
  assert.equal(kernel.saved.length, 1);
  assert.equal(dialogs(kernel, "exportReview").length, 2, "the clean build is not asked about again");
  assert.equal(kernel.ui.getState().dialogs.some((dialog) => dialog.id === "report"), false, "nothing is left to report");

  // "Download as it is": the first build goes out and the report says what is in it
  kernel.store.rotatePages([pagesOf(kernel)[0].id], 90);
  kernel.answer({ exportReview: { deliver: true } });
  await kernel.actions.download();
  assert.equal(kernel.saved.length, 2);
  const report = kernel.ui.getState().dialogs.find((dialog) => dialog.id === "report");
  assert.deepEqual(report.props.warnings.map((warning) => warning.code), ["EXPORT_OUTLINE_RETARGETED"]);
});

test("Download as it is hands out the first build, and the report still says what is in it", async () => {
  const kernel = await opened({
    plan: {
      warnings: [{ code: "PIPELINE_ERASE_COVERED", params: { count: 1 } }],
      report: redactionReport((job, options, base) => ({ redaction: { ...base.redaction, targets: base.redaction.targets.map((entry) => ({ ...entry, outcome: entry.mode === "erase" ? "cover-needed" : entry.outcome })) } }))
    }
  });
  const [a] = pagesOf(kernel).map((page) => page.id);
  kernel.store.addObjects([sample.text(a, { replaces: { rect: [50, 700, 250, 720], cover: "#ffffff", sourceText: "old words" } })]);
  kernel.answer({ exportReview: { deliver: true } });
  const result = await kernel.actions.download();
  assert.equal(dialogs(kernel, "export").length, 0, "a replaced line alone is not asked about before the build");
  assert.equal(builds(kernel).length, 1);
  assert.equal(result.fileName, "hop-dong-edited.pdf", "replaced text is an edit, not a redaction");
  const report = kernel.ui.getState().dialogs.find((dialog) => dialog.id === "report");
  assert.deepEqual(report.props.summary.covered, { count: 1, pageNumbers: [1] });
  assert.deepEqual(report.props.warnings.map((warning) => warning.code), ["PIPELINE_ERASE_COVERED"]);
});

// --- a build that failed --------------------------------------------------------------------------------------------

test("a failed verification delivers NOTHING and says so; converting the marked pages is offered once", async () => {
  const failures = [new PdfEditorError("REDACT_VERIFICATION_FAILED", { page: 1, check: "G1-removal" }), new PdfEditorError("PIPELINE_SELF_CHECK_FAILED", { check: "redaction-text", page: 1 })];
  const kernel = await opened({ plan: { failures, report: redactionReport() } });
  kernel.store.addObjects([sample.redact(pagesOf(kernel)[0].id)]);
  const answers = ["convert", null];
  kernel.answer({ export: { baseName: null, removeProperties: false, removeBookmarks: false }, exportFailed: () => answers.shift() });
  assert.equal(await kernel.actions.download(), null);
  assert.deepEqual(dialogs(kernel, "exportFailed").map((entry) => [entry.props.code, entry.props.hadMarks, entry.props.redactPath, entry.props.purpose]), [
    ["REDACT_VERIFICATION_FAILED", true, "hybrid", "download"],
    ["PIPELINE_SELF_CHECK_FAILED", true, "raster", "download"]
  ]);
  assert.deepEqual(builds(kernel).map((call) => call.options.redactPath), [undefined, "raster"]);
  assert.equal(kernel.saved.length, 0);
  assert.equal(kernel.openedTabs.length, 0);
  assert.equal(kernel.ui.getState().dialogs.some((dialog) => dialog.id === "report"), false);
  assert.equal(kernel.ui.getState().flags.savedAs, null);
  assert.equal(kernel.store.isDirty(), true);
  assert.equal(dialogs(kernel, "export").length, 1, "the question before the build is not asked again for a retry");
});

test("Cancel during the build of a redaction leaves everything as it was", async () => {
  const kernel = await opened({ plan: { report: redactionReport() } });
  kernel.store.addObjects([sample.redact(pagesOf(kernel)[0].id)]);
  const before = kernel.store.getState();
  kernel.answer({ export: { baseName: null, removeProperties: true, removeBookmarks: true } });
  const off = kernel.ui.subscribe(() => {
    if (kernel.ui.getState().job?.cancellable) kernel.actions.cancelJob();
  });
  assert.equal(await kernel.actions.download(), null);
  off();
  assert.equal(kernel.store.getState(), before, "the document is the same object");
  assert.equal(kernel.saved.length, 0);
  assert.deepEqual(toasts(kernel), []);
  assert.deepEqual(kernel.ui.getState().dialogs, []);
  assert.equal(kernel.ui.getState().job, null);
});

// --- documents whose author restricted changes ------------------------------------------------------------------------

const RESTRICTED = { modify: false, annotate: false, assemble: false, fillForms: true, print: true, copy: true };

test("a file whose author restricted changes opens for reading and asks once before the first edit", async () => {
  const kernel = await opened({ files: { [first(1)]: { pages: [{}, {}], permissions: RESTRICTED, facts: { encrypted: true } }, [first(2)]: {} } });
  assert.equal(kernel.ui.getState().flags.restricted, true);
  assert.equal(kernel.ui.getState().flags.restrictedEditConfirmed, false);
  assert.equal(await kernel.actions.setTool("hand"), true, "reading tools never ask");
  assert.deepEqual(kernel.asked, []);

  kernel.answer({ confirm: false });
  assert.equal(await kernel.actions.setTool("text"), false);
  assert.equal(kernel.ui.getState().interaction.tool, "hand");
  const question = kernel.asked.at(-1).props;
  assert.equal(question.title, "The author restricted changes to this file");
  assert.match(question.details, /is not protected/);
  assert.equal(question.confirmLabel, "I am allowed to edit this file");
  assert.equal(question.tone, "warning");

  kernel.answer({ confirm: true });
  assert.equal(await kernel.actions.beforeEdit(), true);
  assert.equal(kernel.ui.getState().flags.restrictedEditConfirmed, true);
  const asked = kernel.asked.length;
  assert.equal(await kernel.actions.setTool("text"), true);
  assert.equal(await kernel.actions.confirmEditingRestricted(), true);
  assert.equal(kernel.asked.length, asked, "not asked again");

  // another document starts again; a file without restrictions never asks
  await kernel.actions.openFiles([fileItem("plain.pdf", 2)]);
  assert.deepEqual([kernel.ui.getState().flags.restricted, kernel.ui.getState().flags.restrictedEditConfirmed], [false, false]);
  assert.equal(await kernel.actions.confirmEditingRestricted(), true);
});

test("restricted and signed: both questions, the restriction first; the flag follows the files in use", async () => {
  const kernel = await opened({ files: { [first(1)]: { pages: [{}], permissions: RESTRICTED, facts: { signatureCount: 1 } }, [first(2)]: { pages: [{}] } } });
  kernel.answer({ confirm: true });
  assert.equal(await kernel.actions.beforeEdit(), true);
  assert.deepEqual(kernel.asked.map((entry) => entry.props.title), ["The author restricted changes to this file", "This document is signed"]);

  // pages of an unrestricted file are added and the restricted page is removed: nothing restricts the document any more
  await kernel.actions.addFiles([fileItem("plain.pdf", 2)]);
  assert.equal(kernel.ui.getState().flags.restricted, true);
  kernel.store.deletePages([pagesOf(kernel)[0].id]);
  assert.equal(kernel.ui.getState().flags.restricted, false);
  kernel.store.undo();
  assert.equal(kernel.ui.getState().flags.restricted, true);
});

test("the plan of an output knows about restrictions, bookmarks and signatures of the files in use", async () => {
  const kernel = await opened({ files: { [first(1)]: { pages: [{}, {}], permissions: RESTRICTED, outline: [{ title: "1" }, { title: "2" }], facts: { signatureCount: 3 } } }, plan: { report: redactionReport() } });
  kernel.answer({ confirm: true, export: null });
  await kernel.actions.beforeEdit();
  kernel.store.addObjects([sample.redact(pagesOf(kernel)[0].id)]);
  await kernel.actions.download();
  const { plan } = dialogs(kernel, "export")[0].props;
  assert.deepEqual([plan.restricted, plan.hasOutline, plan.signatures, plan.hasProperties], [true, true, 3, true]);
});

test("a file that is only protected by a password: nothing is asked before the first edit, and the question before a download says that the copy is not protected", async () => {
  const kernel = await opened({ files: { [first(1)]: { pages: [{}, {}], facts: { encrypted: true } } }, plan: { report: redactionReport() } });
  assert.equal(kernel.ui.getState().flags.restricted, false, "no restriction of the author");
  kernel.answer({ export: null });
  assert.equal(await kernel.actions.beforeEdit(), true);
  assert.deepEqual(kernel.asked, [], "editing such a file needs no permission of its author");
  kernel.store.addObjects([sample.redact(pagesOf(kernel)[0].id)]);
  await kernel.actions.download();
  const { plan } = dialogs(kernel, "export")[0].props;
  assert.equal(plan.restricted, true, "the copy that is created is not protected: said in the question");
});

test("replacing the pages in one undoable step forgets what was answered about the old ones", async () => {
  const kernel = await opened({ files: { [first(1)]: { pages: [{}], facts: { signatureCount: 1 } }, [first(2)]: { pages: [{}], facts: { signatureCount: 2 } } } });
  kernel.answer({ confirm: true });
  await kernel.actions.beforeEdit();
  kernel.ui.setFlags({ savedAs: "downloaded" });
  assert.equal(kernel.ui.getState().flags.signedEditConfirmed, true);
  await kernel.actions.replaceDocument([fileItem("other.pdf", 2)], { resetHistory: false });
  assert.deepEqual([kernel.ui.getState().flags.signedEditConfirmed, kernel.ui.getState().flags.savedAs], [false, null]);
  assert.equal(kernel.store.canUndo(), true);
});

test("what the writer notes about a signed file is not said twice when a feature brings its own banner about signatures", async () => {
  const inspectWarnings = { [first(1)]: [{ code: "EXPORT_SOURCE_SIGNED", params: { source: "s", signatures: 2 } }, { code: "EXPORT_XFA_DROPPED", params: { source: "s" } }] };
  const plain = await opened({ plan: { inspectWarnings } });
  assert.deepEqual(plain.ui.getState().notices.map((notice) => notice.code), ["EXPORT_SOURCE_SIGNED", "EXPORT_XFA_DROPPED"]);
  const withBanner = await opened({ plan: { inspectWarnings }, manifests: [{ id: "signing", banners: [function Banner() {}] }] });
  assert.deepEqual(withBanner.ui.getState().notices.map((notice) => notice.code), ["EXPORT_XFA_DROPPED"]);
});
