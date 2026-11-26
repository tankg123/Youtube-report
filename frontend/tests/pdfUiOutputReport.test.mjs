// What the editor asks before a build and says after it (src/pages/pdfEditor/ui/outputReport.js): the plan of an
// output from the document, the summary and the findings of a pipeline report, the remedies, the sentences.
import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../src/i18n/index.js";
import {
  REMEDIES,
  VERIFICATION_CODES,
  appliedFromOptions,
  appliedStrictMarks,
  applyRemedies,
  buildChoices,
  cleanBaseName,
  describeFailure,
  describePlan,
  describeReport,
  describeReview,
  pictureCharacters,
  planNeedsQuestion,
  planOutput,
  reportIsWorthShowing,
  reviewFindings,
  stripsProperties,
  suggestedBaseName,
  summarizeReport
} from "../src/pages/pdfEditor/ui/outputReport.js";
import { openStore, sample } from "./helpers/pdfModelKit.mjs";

// built from code points: no character outside the keyboard is written into this file
const HAN = String.fromCodePoint(0x4e2d);
const FACE = String.fromCodePoint(0x1f600);
const describeWarning = (warning) => `<${warning.code}${warning.params?.where ? `:${warning.params.where}` : ""}>`;
const page = (pageIndex, path, extra = {}) => ({ pageIndex, path, reasons: [], areas: 0, replacedLines: 0, ...extra });
const target = (index, pageIndex, mode, outcome, extra = {}) => ({ index, pageIndex, mode, outcome, objectId: `o${index}`, ...extra });
const report = (redaction, extra = {}) => ({ pageCount: 4, usedRedaction: Boolean(redaction), redaction, rasterizedTextObjectIds: [], warnings: [], ...extra });
const redaction = (extra = {}) => ({ pages: [], targets: [], coveredObjectIds: [], elsewhere: [], fontsNotCleaned: [], rasterPagesNotApplied: [], ...extra });

function documentWithMarks() {
  const { store, pageIds, sourceId } = openStore({ pages: [{}, {}, {}, {}], facts: { signatureCount: 2 } });
  store.addObjects([sample.redact(pageIds[0]), sample.redact(pageIds[0], { rect: [60, 100, 180, 124] }), sample.redact(pageIds[2]), sample.blur(pageIds[2])]);
  store.addObjects([sample.text(pageIds[1], { text: "plain" }), sample.text(pageIds[3], { text: "needs a picture" })]);
  return { store, pageIds, sourceId };
}

// --- before the build ---------------------------------------------------------------------------------------------

test("the plan counts what will be removed, on how many pages, and what the file will not keep", () => {
  const { store, sourceId } = documentWithMarks();
  const plan = planOutput(store.getState(), {
    checkText: (object) => (object.text === "needs a picture" ? { ok: false, unsupported: [{ char: FACE }, { char: FACE }, { char: HAN }] } : { ok: true, unsupported: [] }),
    outlineOf: (id) => (id === sourceId ? 3 : 0),
    restrictedOf: () => true
  });
  assert.deepEqual(
    { redact: plan.redact, blur: plan.blur, marks: plan.marks, markPages: plan.markPages, replaced: plan.replaced, signatures: plan.signatures },
    { redact: 3, blur: 1, marks: 4, markPages: 2, replaced: 0, signatures: 2 }
  );
  assert.equal(plan.pageNumbers, null);
  assert.equal(plan.hasProperties, true, "the stand-in source has a title");
  assert.equal(plan.hasOutline, true);
  assert.equal(plan.restricted, true);
  assert.equal(plan.pictureText.length, 1);
  assert.equal(plan.pictureText[0].pageNumber, 4);
  assert.deepEqual(plan.pictureText[0].characters, [FACE, HAN], "every character once");
  assert.equal(planNeedsQuestion(plan), true);
});

test("an extract plans only its pages; a document without marks and odd text needs no question", () => {
  const { store, pageIds } = documentWithMarks();
  const plan = planOutput(store.getState(), { pageIds: [pageIds[2], pageIds[1]] });
  assert.deepEqual(plan.pageNumbers, [2, 3], "page numbers of the working document, in document order");
  assert.deepEqual([plan.redact, plan.blur, plan.markPages], [1, 1, 1]);
  assert.equal(suggestedBaseName("hop-dong.pdf", "extract", plan), "hop-dong-pages-2-3");

  const clean = planOutput(openStore().store.getState(), { checkText: () => ({ ok: true, unsupported: [] }) });
  assert.equal(planNeedsQuestion(clean), false);
  assert.equal(clean.hasOutline, false, "without viewer facts nothing is claimed");
  assert.equal(suggestedBaseName("hop-dong", "download", clean), "hop-dong-edited");
});

test("a text check that is not ready or throws never blocks the plan; replaced lines are counted", () => {
  const { store, pageIds } = openStore({ pages: [{}, {}] });
  store.addObjects([sample.text(pageIds[0], { replaces: { rect: [50, 700, 250, 720], cover: "#ffffff", sourceText: "old" } }), sample.text(pageIds[1])]);
  const plan = planOutput(store.getState(), {
    checkText: (object) => {
      if (object.pageId === pageIds[0]) throw new Error("TEXT_FONT_NOT_LOADED");
      return null;
    }
  });
  assert.equal(plan.pictureText.length, 0);
  assert.equal(plan.replaced, 1);
  assert.equal(plan.marks, 0);
  assert.equal(planNeedsQuestion(plan), false, "replaced lines alone are not asked about before the build");
});

test("the suffix is -redacted only when redact or blur marks are applied", () => {
  const { store } = documentWithMarks();
  assert.equal(suggestedBaseName("Hop dong.pdf", "download", planOutput(store.getState())), "Hop dong-redacted");
  assert.equal(suggestedBaseName("Hop dong-redacted", "download", planOutput(store.getState())), "Hop dong-redacted", "not added twice");
  assert.equal(appliedStrictMarks(report(redaction({ targets: [target(0, 0, "erase", "precise")] }))), false, "a replaced line does not make a file redacted");
  assert.equal(appliedStrictMarks(report(redaction({ targets: [target(0, 0, "erase", "precise"), target(1, 0, "pixelate", "precise")] }))), true);
  assert.equal(appliedStrictMarks({ usedRedaction: true, redaction: null }), true, "an older report without targets is believed");
  assert.equal(appliedStrictMarks(null), false);
  assert.equal(cleanBaseName("  bao cao: quy 3?.pdf "), "bao cao- quy 3-");
  assert.equal(cleanBaseName(null), "");
});

test("the dialog of a redaction: title and button name the action, the warning says it is permanent and where", () => {
  const { store } = documentWithMarks();
  const plan = planOutput(store.getState());
  const texts = describePlan(plan, "download");
  assert.equal(texts.redaction, true);
  assert.equal(texts.title, "Apply redactions and download");
  assert.equal(texts.confirmLabel, "Apply and download");
  assert.match(texts.warning, /permanently removes the marked content from the downloaded file/);
  assert.match(texts.warning, /Your original file is not changed/);
  assert.deepEqual(texts.facts, ["Areas that will be redacted: 3", "Areas that will be blurred: 1", "Pages with marked areas: 2"]);
  assert.match(texts.blurNote, /content under it is removed as well/);
  assert.match(texts.pending, /marks stay pending/);
  assert.equal(texts.signatures, "The 2 existing signatures are not kept in the edited copy.");
  assert.equal(texts.restricted, null);
  assert.equal(texts.pictures, null);

  assert.deepEqual([describePlan(plan, "print").title, describePlan(plan, "print").confirmLabel], ["Apply redactions and print", "Apply and print"]);
  assert.deepEqual([describePlan(plan, "sign").title, describePlan(plan, "sign").confirmLabel], ["Apply redactions and sign", "Apply and continue"]);
  assert.match(describePlan(plan, "print").warning, /from the file that is created/);
  assert.equal(describePlan({ ...plan, signatures: 1 }, "download").signatures, "The existing signature is not kept in the edited copy.");
});

test("text that becomes a picture is said with its number and the characters at fault; plain options have no warning", () => {
  const base = { pageNumbers: null, redact: 0, blur: 0, marks: 0, markPages: 0, replaced: 0, signatures: 0, restricted: true, hasProperties: true, hasOutline: false, pictureText: [] };
  const one = describePlan({ ...base, pictureText: [{ id: "a", pageNumber: 1, characters: [HAN] }] }, "download");
  assert.equal(one.redaction, false);
  assert.equal(one.title, "Text that will be exported as pictures");
  assert.equal(one.confirmLabel, "Download");
  assert.ok(one.pictures.startsWith(`1 text box contains characters that none of the editor's fonts can write (${HAN}). It will be put into the file as a picture`));
  assert.equal(one.warning, null);
  assert.match(one.restricted, /is not protected/);
  const many = describePlan({ ...base, pictureText: [{ id: "a", pageNumber: 1, characters: ["x"] }, { id: "b", pageNumber: 2, characters: ["y"] }] }, "print");
  assert.match(many.pictures, /^2 text boxes contain .*\(x y\)/);
  assert.equal(describePlan(base, "download").title, "Download options");
  assert.equal(describePlan(base, "download").pictures, null);
  const letters = Array.from({ length: 15 }, (unused, index) => String.fromCharCode(0x4e00 + index));
  assert.equal(pictureCharacters([{ characters: letters }]).split(" ").length, 13, "twelve characters and an ellipsis");
});

test("the choices of the dialog only ever remove more than the caller asked", () => {
  assert.deepEqual(buildChoices({ removeProperties: true, removeBookmarks: true }, { info: { title: "T" }, pipeline: { keepForms: false } }), { info: {}, pipeline: { keepForms: false, keepOutline: false } });
  assert.deepEqual(buildChoices({}, { info: undefined, pipeline: { keepOutline: false } }), { info: undefined, pipeline: { keepOutline: false } });
  const pipeline = { eraseFallback: "cover" };
  buildChoices({ removeBookmarks: true }, { pipeline });
  assert.deepEqual(pipeline, { eraseFallback: "cover" }, "the caller's options are not changed");
  assert.deepEqual([stripsProperties(undefined), stripsProperties({}), stripsProperties(null), stripsProperties({ title: "" }), stripsProperties({ title: "T" })], [false, true, true, true, false]);
});

// --- when the build comes back ---------------------------------------------------------------------------------------

test("the summary has one row per page with marks: precise, converted (why), covered", () => {
  const built = report(
    redaction({
      pages: [
        page(0, "precise", { areas: 3 }),
        page(1, "untouched"),
        page(2, "raster", { areas: 1, reasons: [{ code: "REDACT_IMAGE_IN_TARGET", params: { page: 3, name: "Im1" } }] }),
        page(3, "raster", { areas: 2, replacedLines: 1, reasons: [{ code: "REDACT_RASTER_FORCED", params: { page: 4 } }] }),
        page(4, "untouched", { replacedLines: 2 })
      ],
      targets: [target(0, 0, "redact", "precise"), target(1, 2, "blur", "raster"), target(2, 4, "erase", "cover-needed"), target(3, 4, "erase", "precise")],
      coveredObjectIds: ["o2"]
    }),
    { rasterizedTextObjectIds: ["t1", "t2"], warnings: [{ code: "PIPELINE_PAGES_RASTERIZED", params: { count: 1, pages: [3] } }, { code: "EXPORT_XFA_DROPPED", params: { source: "s" } }] }
  );
  const summary = summarizeReport(built);
  assert.deepEqual(summary.rows.map((row) => [row.pageNumber, row.areas, row.replacedLines, row.covered, row.path, row.onRequest, row.reasons.map((entry) => entry.code)]), [
    [1, 3, 0, 0, "precise", false, []],
    [3, 1, 0, 0, "raster", false, ["REDACT_IMAGE_IN_TARGET"]],
    [4, 2, 1, 0, "raster", true, []],
    [5, 0, 2, 1, "untouched", false, []]
  ]);
  assert.deepEqual(summary.covered, { count: 1, pageNumbers: [5] });
  assert.equal(summary.pictureText, 2);
  assert.equal(summary.usedMarks, true);
  assert.equal(summary.warnings.length, 2);

  const extract = summarizeReport(built, { pageNumbers: [7, 8, 9, 12, 20] });
  assert.deepEqual(extract.rows.map((row) => row.pageNumber), [7, 9, 12, 20], "page numbers of the working document");
  assert.deepEqual(extract.covered.pageNumbers, [20]);
});

test("a report without redaction, an empty one and a damaged one are all summarised without a throw", () => {
  for (const input of [null, {}, report(null), { redaction: { pages: "x", targets: null, elsewhere: [null, { where: "form", count: 0 }], fontsNotCleaned: [{ font: "F" }] }, warnings: [null, { nothing: 1 }] }]) {
    const summary = summarizeReport(input);
    assert.deepEqual([summary.rows, summary.elsewhere, summary.fonts, summary.warnings, summary.covered.count, summary.pictureText], [[], [], [], [], 0, 0]);
    assert.equal(reviewFindings(summary).needed, false);
    assert.equal(reportIsWorthShowing(summary), false);
  }
});

test("findings: each kind of leftover with the remedy the editor can offer, never a remedy that was already in force", () => {
  const built = report(
    redaction({
      pages: [page(0, "precise", { areas: 1, replacedLines: 1 }), page(1, "precise", { areas: 1 }), page(2, "precise", { replacedLines: 1 })],
      targets: [target(0, 0, "redact", "precise"), target(1, 0, "erase", "cover-needed"), target(2, 1, "redact", "precise"), target(3, 2, "erase", "cover-needed")],
      elsewhere: [{ where: "outline", count: 2 }, { where: "metadata", count: 1 }, { where: "form", count: 4 }],
      fontsNotCleaned: [{ font: "ABCDEF+Times", pageIndexes: [0, 1, 2, 3] }]
    })
  );
  const summary = summarizeReport(built);
  assert.deepEqual(summary.fonts[0].convertible, [0, 1, 2, 3], "every page that shows the font can become a picture, with or without marks");
  const findings = reviewFindings(summary);
  assert.equal(findings.needed, true);
  assert.deepEqual(findings.items.map((item) => [item.id, item.kind, item.remedy, item.count]), [
    ["covered", "covered", "removeCovered", 2],
    ["elsewhere-outline", "elsewhere", "removeBookmarks", 2],
    ["elsewhere-metadata", "elsewhere", "removeProperties", 1],
    ["elsewhere-form", "elsewhere", null, 4],
    ["font-ABCDEF+Times", "font", "convertPages", 4]
  ]);
  assert.deepEqual(findings.items[0].pageNumbers, [1, 3]);
  assert.deepEqual(findings.items[4].pageIndexes, [0, 1, 2, 3]);
  assert.deepEqual(findings.items[4].convertNumbers, [1, 2, 3, 4]);
  for (const item of findings.items) assert.ok(item.remedy === null || REMEDIES.includes(item.remedy));

  const second = reviewFindings(summary, { applied: { removeCovered: true, removeBookmarks: true, removeProperties: true, convertPages: [0, 1, 2, 3] } });
  assert.equal(second.needed, true, "what is still there is still told");
  assert.deepEqual(second.items.map((item) => item.remedy), [null, null, null, null, null], "but nothing is offered a second time");

  const refused = summarizeReport(report(redaction({ targets: [target(0, 0, "redact", "precise")], fontsNotCleaned: [{ font: "F", pageIndexes: [0, 1] }], rasterPagesNotApplied: [0] })));
  assert.deepEqual(refused.fonts[0].convertible, [1], "a page the engine could not convert is not offered again; the other one is");
  // pages that are pictures already, and pages the output does not have, are never offered
  const bounded = summarizeReport(report(redaction({
    pages: [page(0, "precise", { areas: 1 }), page(1, "raster", { reasons: [{ code: "REDACT_RASTER_FORCED", params: { page: 2 } }] })],
    targets: [target(0, 0, "redact", "precise")],
    fontsNotCleaned: [{ font: "F", pageIndexes: [0, 1, 2, 7, -1, 1.5] }]
  }), { pageCount: 3 }));
  assert.deepEqual(bounded.fonts[0].convertible, [0, 2]);
  assert.deepEqual(bounded.rows.map((row) => [row.pageNumber, row.areas, row.path, row.onRequest]), [[1, 1, "precise", false], [2, 0, "raster", true]], "a page that became a picture on request has a row, also without marks");
});

test("remedies become options of the next build and are remembered as applied", () => {
  const summary = summarizeReport(
    report(
      redaction({
        targets: [target(0, 2, "redact", "precise"), target(1, 0, "erase", "cover-needed")],
        elsewhere: [{ where: "outline", count: 1 }, { where: "metadata", count: 1 }],
        fontsNotCleaned: [{ font: "F", pageIndexes: [2] }]
      })
    )
  );
  const findings = reviewFindings(summary);
  const current = { info: { title: "Keep" }, pipeline: { keepForms: true, rasterPages: [5] }, applied: appliedFromOptions({ info: { title: "Keep" }, pipeline: {} }) };
  const next = applyRemedies(["removeCovered", "removeBookmarks", "removeProperties", "convertPages", "launchRockets"], findings, current);
  assert.deepEqual(next.pipeline, { keepForms: true, rasterPages: [2, 5], eraseFallback: "redact", keepOutline: false });
  assert.deepEqual(next.info, {});
  assert.deepEqual(next.applied, { removeCovered: true, removeBookmarks: true, removeProperties: true, convertPages: [2], removeOrphanBookmarks: false });
  assert.deepEqual(current.pipeline, { keepForms: true, rasterPages: [5] }, "the options of the build that ran are not changed");

  const partial = applyRemedies(["removeBookmarks"], findings, current);
  assert.deepEqual([partial.pipeline.eraseFallback, partial.pipeline.keepOutline, partial.info], [undefined, false, { title: "Keep" }]);
  // a remedy that no finding offers is ignored, also when the user interface would send it
  const none = applyRemedies(["removeCovered"], reviewFindings(summarizeReport(report(redaction()))), current);
  assert.equal(none.pipeline.eraseFallback, undefined);
  assert.deepEqual(appliedFromOptions({ info: {}, pipeline: { eraseFallback: "redact", keepOutline: false, rasterPages: [1] } }), { removeCovered: true, removeBookmarks: true, removeProperties: true, convertPages: [1], removeOrphanBookmarks: false });
  assert.equal(appliedFromOptions({ pipeline: { dropOrphanBookmarks: true } }).removeOrphanBookmarks, true);
});

test("what is left of REMOVED PAGES is a finding too: bookmarks kept for their children (with a remedy) and data that may travel along (without one)", () => {
  const leftovers = [
    { code: "EXPORT_OUTLINE_RETARGETED", params: { source: "s1", items: 2 } },
    { code: "EXPORT_XFA_DROPPED", params: { source: "s1" } },
    { code: "EXPORT_OUTLINE_RETARGETED", params: { source: "s2", items: 1 } },
    { code: "EXPORT_RESOURCES_NOT_PRUNED", params: { source: "s1", pages: 3 } }
  ];
  // no marks at all: pages were deleted, nothing was redacted
  const summary = summarizeReport(report(null, { warnings: leftovers }));
  assert.equal(summary.orphanBookmarks, 3);
  assert.deepEqual(summary.removedPageData.map((entry) => entry.params.pages), [3]);
  const findings = reviewFindings(summary);
  assert.equal(findings.needed, true);
  assert.deepEqual(findings.items.map((item) => [item.id, item.kind, item.remedy, item.count]), [["bookmarks", "bookmarks", "removeOrphanBookmarks", 3], ["removed-pages-0", "removedPages", null, 3]]);
  assert.ok(REMEDIES.includes("removeOrphanBookmarks"));

  const texts = describeReview(findings, "download", (warning) => `<${warning.code} ${warning.params.pages}>`);
  assert.match(texts.items[0].text, /^3 bookmarks of pages you removed are still in the file/);
  assert.equal(texts.items[0].choice, "Remove these bookmarks (the bookmarks under them move up one level)");
  assert.deepEqual([texts.items[1].text, texts.items[1].choice, texts.items[1].remedy], ["<EXPORT_RESOURCES_NOT_PRUNED 3>", null, null], "the sentence of the catalogue, and nothing the editor could do");
  const one = describeReview(reviewFindings(summarizeReport(report(null, { warnings: [{ code: "EXPORT_OUTLINE_RETARGETED", params: { source: "s", items: 1 } }] }))), "download", () => "");
  assert.match(one.items[0].text, /^1 bookmark of a page you removed is still in the file/);

  // the remedy is an option of the export engine; once it was applied (or no bookmark is kept at all) it is not offered again
  const next = applyRemedies(["removeOrphanBookmarks"], findings, { info: undefined, pipeline: { keepForms: true }, applied: {} });
  assert.deepEqual(next.pipeline, { keepForms: true, dropOrphanBookmarks: true });
  assert.equal(next.applied.removeOrphanBookmarks, true);
  assert.equal(reviewFindings(summary, { applied: { removeOrphanBookmarks: true } }).items[0].remedy, null);
  assert.equal(reviewFindings(summary, { applied: { removeBookmarks: true } }).items[0].remedy, null);
  // a warning without a count still counts as one bookmark; a report without these warnings has nothing to ask
  assert.equal(summarizeReport(report(null, { warnings: [{ code: "EXPORT_OUTLINE_RETARGETED", params: {} }] })).orphanBookmarks, 1);
  assert.equal(reviewFindings(summarizeReport(report(null, { warnings: [{ code: "EXPORT_XFA_DROPPED", params: { source: "s" } }] }))).needed, false);
});

test("the review question: one sentence per finding, a choice where the editor can help, a way out where it cannot", () => {
  const summary = summarizeReport(
    report(
      redaction({
        targets: [target(0, 1, "redact", "precise"), target(1, 0, "erase", "cover-needed")],
        elsewhere: [{ where: "outline", count: 2 }, { where: "metadata", count: 1 }, { where: "annotation", count: 3 }],
        fontsNotCleaned: [{ font: "F", pageIndexes: [1] }]
      })
    )
  );
  const texts = describeReview(reviewFindings(summary), "download", describeWarning);
  assert.equal(texts.title, "Removed content is still in the file");
  assert.match(texts.lead, /has not been handed out yet/);
  assert.match(texts.items[0].text, /^1 text line you replaced could only be covered \(page 1\).*still in the file/);
  assert.match(texts.items[0].choice, /Remove the old text for real/);
  assert.match(texts.items[1].text, /bookmarks of the document \(places: 2\)/);
  assert.equal(texts.items[1].choice, "Leave the bookmarks out of the file");
  assert.match(texts.items[2].text, /document properties.*\(places: 1\)/);
  assert.deepEqual([texts.items[3].text, texts.items[3].choice, texts.items[3].remedy], ["<REDACT_TEXT_ELSEWHERE:annotation>", null, null]);
  assert.deepEqual([texts.items[4].text, texts.items[4].choice], ["<REDACT_FONT_GLYPHS_REMAIN>", "Convert these pages to images: 2"]);
  assert.equal(texts.deliverLabel, "Download as it is");
  assert.match(texts.note, /The file is then created again/);

  const stuck = describeReview(reviewFindings(summary, { applied: { removeCovered: true, removeBookmarks: true, removeProperties: true, convertPages: [1] } }), "print", describeWarning);
  assert.equal(stuck.items.every((item) => item.choice === null), true);
  assert.equal(stuck.deliverLabel, "Print as it is");
  assert.match(stuck.note, /cannot remove this for you/);
  assert.equal(describeReview(reviewFindings(summary), "sign", describeWarning).deliverLabel, "Continue as it is");
});

// --- after delivery ------------------------------------------------------------------------------------------------

test("the result report: per page what happened and what a converted page lost; every other warning as a sentence", () => {
  const summary = summarizeReport(
    report(
      redaction({
        pages: [
          page(0, "precise", { areas: 3 }),
          page(1, "raster", { areas: 1, reasons: [{ code: "REDACT_IMAGE_IN_TARGET", params: { page: 2 } }] }),
          page(2, "raster", { areas: 1, reasons: [{ code: "REDACT_RASTER_FORCED", params: { page: 3 } }] }),
          page(3, "precise", { areas: 1, replacedLines: 2 }),
          page(4, "untouched", { replacedLines: 1 })
        ],
        targets: [target(0, 3, "erase", "cover-needed"), target(1, 3, "erase", "precise"), target(2, 4, "erase", "cover-needed")]
      }),
      {
        rasterizedTextObjectIds: ["t"],
        warnings: [
          { code: "EXPORT_SOURCE_SIGNED", params: { source: "s", signatures: 2 } },
          { code: "PIPELINE_PAGES_RASTERIZED", params: { count: 1, pages: [2] } },
          { code: "PIPELINE_PAGES_RASTERIZED_ON_REQUEST", params: { count: 1, pages: [3] } },
          { code: "PIPELINE_ERASE_COVERED", params: { count: 2 } },
          { code: "REDACT_TEXT_ELSEWHERE", params: { where: "form", count: 1 } }
        ]
      }
    )
  );
  const texts = describeReport(summary, { purpose: "download", fileName: "hop-dong-redacted.pdf", describeWarning });
  assert.equal(texts.headline, "Redaction finished. hop-dong-redacted.pdf was downloaded.");
  assert.deepEqual(texts.rows.map((row) => [row.label, row.areas, row.tone]), [["Page 1", "3 areas", "success"], ["Page 2", "1 area", "warning"], ["Page 3", "1 area", "warning"], ["Page 4", "1 area", "warning"], ["Page 5", "", "warning"]]);
  assert.equal(texts.rows[0].outcome, "Removed precisely and verified.");
  assert.deepEqual(texts.rows[0].details, []);
  assert.match(texts.rows[1].outcome, /^Converted to an image, because the content under the marks could not be removed precisely\.$/);
  assert.match(texts.rows[1].details[0], /Links and form fields of this page are gone and its text is no longer sharp/);
  assert.equal(texts.rows[1].details[1], "<REDACT_IMAGE_IN_TARGET>", "why the page was converted, in the words of messages.js");
  assert.equal(texts.rows[2].outcome, "Converted to an image, as chosen.");
  assert.equal(texts.rows[3].outcome, "Removed precisely and verified.");
  assert.deepEqual(texts.rows[3].details, ["1 replaced text line was only covered: its old text is still in the file."]);
  assert.equal(texts.rows[4].outcome, "The lines you replaced were covered.");
  assert.deepEqual(texts.notes.map((note) => note.code), ["EXPORT_SOURCE_SIGNED", "PIPELINE_ERASE_COVERED", "REDACT_TEXT_ELSEWHERE", "TEXT_RASTERIZED"], "the two warnings the rows tell are not repeated");
  assert.match(texts.notes.at(-1).text, /^1 text box was put into the file as a picture/);
  assert.equal(texts.review, "Check the result before you share the file.");
  assert.equal(reportIsWorthShowing(summary), true);
});

test("the headline says how the file left the editor; a report with nothing to tell is not shown", () => {
  const redacted = summarizeReport(report(redaction({ pages: [page(0, "precise", { areas: 1 })], targets: [target(0, 0, "redact", "precise")] })));
  const plain = summarizeReport(report(null, { warnings: [{ code: "EXPORT_XFA_DROPPED", params: {} }] }));
  const headline = (summary, facts) => describeReport(summary, { describeWarning, ...facts }).headline;
  assert.equal(headline(redacted, { purpose: "print" }), "Redaction finished. The document was sent to the print dialog.");
  assert.equal(headline(plain, { purpose: "print" }), "The document was sent to the print dialog.");
  assert.equal(headline(redacted, { purpose: "sign" }), "Redaction finished. The file was created.");
  assert.equal(headline(plain, { purpose: "extract" }), "The file was created.");
  assert.equal(headline(plain, { purpose: "download", fileName: "a-edited.pdf" }), "a-edited.pdf was downloaded.");
  assert.equal(headline(redacted, { purpose: "download" }), "Redaction finished. The file was created.", "without a name nothing is claimed about a download");

  assert.equal(reportIsWorthShowing(plain), true);
  assert.equal(reportIsWorthShowing(summarizeReport(report(null))), false);
  assert.equal(reportIsWorthShowing(summarizeReport(report(null, { warnings: [{ code: "PIPELINE_PAGES_RASTERIZED", params: {} }] }))), false);
  assert.equal(reportIsWorthShowing(summarizeReport(report(null, { rasterizedTextObjectIds: ["t"] }))), true);
});

// --- a failed build ---------------------------------------------------------------------------------------------------

test("a failed build says that nothing was handed out; a failed verification says why and what can still help", () => {
  assert.deepEqual(VERIFICATION_CODES, ["REDACT_VERIFICATION_FAILED", "PIPELINE_SELF_CHECK_FAILED", "EXPORT_AUDIT_FAILED"]);
  const failed = describeFailure("PIPELINE_SELF_CHECK_FAILED", { purpose: "download", hadMarks: true });
  assert.equal(failed.verification, true);
  assert.equal(failed.nothing, "No file was created: nothing was downloaded.");
  assert.match(failed.explanation, /did not pass the check, so it was discarded/);
  assert.equal(failed.canConvert, true);
  assert.equal(describeFailure("REDACT_VERIFICATION_FAILED", { hadMarks: true, redactPath: "raster" }).canConvert, false, "not offered twice");
  assert.equal(describeFailure("PIPELINE_SELF_CHECK_FAILED", { hadMarks: false }).canConvert, false);
  assert.deepEqual([describeFailure("EXPORT_AUDIT_FAILED", { hadMarks: true }).verification, describeFailure("EXPORT_AUDIT_FAILED", { hadMarks: true }).canConvert], [true, false]);
  const other = describeFailure("EXPORT_FONT_UNAVAILABLE", { purpose: "print", hadMarks: true });
  assert.deepEqual([other.verification, other.explanation, other.canConvert, other.nothing], [false, null, false, "No file was created: nothing was printed."]);
  assert.equal(describeFailure("", { purpose: "sign" }).nothing, "No file was created.");
});

test("every sentence exists in Vietnamese too", () => {
  const { store } = documentWithMarks();
  const plan = planOutput(store.getState());
  const summary = summarizeReport(
    report(redaction({ pages: [page(0, "raster", { areas: 1 })], targets: [target(0, 0, "redact", "raster"), target(1, 0, "erase", "cover-needed")], elsewhere: [{ where: "outline", count: 1 }, { where: "metadata", count: 1 }] }), { rasterizedTextObjectIds: ["t"] })
  );
  const strings = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [null]);
  const collect = () =>
    strings([
      describePlan({ ...plan, restricted: true, pictureText: [{ id: "a", pageNumber: 1, characters: ["x"] }] }, "download"),
      describePlan(plan, "print"),
      describeReview(reviewFindings(summary), "download", describeWarning),
      describeReport(summary, { purpose: "download", fileName: "a.pdf", describeWarning }),
      describeReport(summary, { purpose: "print", describeWarning }),
      describeFailure("PIPELINE_SELF_CHECK_FAILED", { hadMarks: true })
    ]);
  const english = collect();
  setLanguage("vi");
  try {
    const vietnamese = collect();
    assert.equal(vietnamese.length, english.length);
    // codes of the stand-in for messages.js ("<...>"), ids and file names are the same in both languages
    const sentences = english.map((sentence, index) => [sentence, vietnamese[index]]).filter(([sentence]) => typeof sentence === "string" && /[a-z]{3} [a-z]/i.test(sentence) && !sentence.startsWith("<"));
    assert.ok(sentences.length > 30, `only ${sentences.length} sentences were compared`);
    assert.deepEqual(sentences.filter(([sentence, translated]) => sentence === translated), [], "sentences that were not translated");
  } finally {
    setLanguage("en");
  }
});

test("replaced text lines alone are reported as an edit, not as a redaction", () => {
  const summary = summarizeReport(report(redaction({ pages: [page(0, "untouched", { replacedLines: 1 })], targets: [target(0, 0, "erase", "cover-needed")] })));
  const texts = describeReport(summary, { purpose: "download", fileName: "a-edited.pdf", describeWarning });
  assert.equal(texts.redacted, false);
  assert.equal(texts.headline, "a-edited.pdf was downloaded.");
  assert.equal(texts.rows[0].outcome, "The lines you replaced were covered.");
  assert.equal(describeReport(summarizeReport(report(redaction({ pages: [page(0, "precise", { areas: 1 })], targets: [target(0, 0, "blur", "precise")] }))), { describeWarning }).redacted, true);
});
