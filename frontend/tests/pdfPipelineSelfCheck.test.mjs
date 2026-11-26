// engine/pipeline/selfCheck.js: the rule that decides whether a text item of pdf.js still has glyphs under a
// mark, on hand-made items and on real documents (redacted by the engine, and not redacted at all).
import test from "node:test";
import assert from "node:assert/strict";
import { CORE_BAND, MAX_GAP_EM, WIDE_GLYPH_EM, checkOutput, checkRedacted, checkRedactionResult, clipSegment, itemUnderMark } from "../src/pages/pdfEditor/engine/pipeline/selfCheck.js";
import { GLYPH_RULE, redactPdf } from "../src/pages/pdfEditor/engine/redact/index.js";
import { makeTextPdf, pageItems, withPdf } from "./helpers/pdfTestKit.mjs";
import { boxOf, makePdf } from "./helpers/pdfRedactKit.mjs";
import { plainTextPdf, rotatedCropPdf, vietnamesePdf } from "./helpers/pdfRedactFixtures.mjs";
import { pipelineEnv, rejectsWith } from "./helpers/pdfPipelineKit.mjs";

/** A horizontal text item of pdf.js: `size` pt, baseline from (x, y), `width` pt long. */
const item = (str, x, y, width, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width, height: size, fontName: "f1" });

test("the core band covers the core of every kind of glyph", () => {
  assert.deepEqual(CORE_BAND, [0.1, 0.59]);
  assert.ok(CORE_BAND[0] <= GLYPH_RULE.coreLow && CORE_BAND[1] >= GLYPH_RULE.coreHigh);
  assert.ok(CORE_BAND[0] <= GLYPH_RULE.type3CoreLow && CORE_BAND[1] >= GLYPH_RULE.type3CoreHigh);
  assert.equal(MAX_GAP_EM, 0.6);
});

test("clipSegment: the part of a segment inside a rectangle", () => {
  const rect = [10, 10, 20, 20];
  assert.deepEqual(clipSegment([0, 15], [40, 15], rect), [0.25, 0.5]);
  assert.deepEqual(clipSegment([12, 12], [18, 18], rect), [0, 1]);
  assert.equal(clipSegment([0, 25], [40, 25], rect), null);
  assert.equal(clipSegment([0, 0], [5, 5], rect), null);
  assert.deepEqual(clipSegment([15, 0], [15, 40], rect), [0.25, 0.5]);
  // a point
  assert.deepEqual(clipSegment([15, 15], [15, 15], rect), [0, 1]);
  assert.equal(clipSegment([25, 15], [25, 15], rect), null);
  // against the direction of the axes
  assert.deepEqual(clipSegment([40, 15], [0, 15], rect), [0.5, 0.75]);
});

test("itemUnderMark: an item whose core band lies inside the mark still has its glyphs there", () => {
  const word = item("SECRET", 100, 200, 36); // 10 pt, 3.6 em long
  assert.equal(itemUnderMark(word, false, [[98, 198, 138, 210]]), true, "a box around the word");
  assert.equal(itemUnderMark(word, false, [[98, 201, 138, 206]]), true, "a box around the core band only");
  assert.equal(itemUnderMark(word, false, [[0, 0, 50, 50], [98, 198, 138, 210]]), true, "the second of two marks");
  assert.equal(itemUnderMark(word, false, [[98, 220, 138, 232]]), false, "a box on the line above");
  assert.equal(itemUnderMark(word, false, [[140, 198, 180, 210]]), false, "a box behind the word");
  assert.equal(itemUnderMark(word, false, []), false);
  // a strip thinner than the band: left to the engine (a Type3 glyph may legitimately stay)
  assert.equal(itemUnderMark(word, false, [[98, 202, 138, 203]]), false);
  assert.equal(itemUnderMark(word, false, [[98, 198, 138, 204]]), false, "the lower half of the band only");
  // half of a short word: its remaining glyphs may all have their centres outside
  assert.equal(itemUnderMark(word, false, [[98, 198, 118, 210]]), false);
});

test("itemUnderMark: a mark over a stretch of a longer item that cannot be free of glyph centres", () => {
  const line = item("The account number 4711-0815 is due at the end of the month", 50, 500, 300); // 30 em, 59 characters
  const limit = (MAX_GAP_EM + WIDE_GLYPH_EM) * 10; // average advance 0.51 em: the 1.5 em bound counts
  assert.equal(itemUnderMark(line, false, [[100, 498, 100 + limit + 1, 510]]), true);
  assert.equal(itemUnderMark(line, false, [[100, 498, 100 + limit - 1, 510]]), false, "a stretch that two wide glyphs and a gap can bridge");
  assert.equal(itemUnderMark(line, false, [[40, 498, 360, 510]]), true, "the whole line");
  // glyphs that are much wider than the em of the item (an odd Type3 font): the bound grows with the average advance
  const wide = item("ab", 50, 500, 300, 10); // two glyphs of 15 em each
  assert.equal(itemUnderMark(wide, false, [[60, 498, 190, 510]]), false);
  assert.equal(itemUnderMark(wide, false, [[40, 498, 360, 510]]), true);
});

test("itemUnderMark: rotated and vertical text, and what is not text", () => {
  // the same word turned by 90 degrees: baseline runs up from (200, 100)
  const turned = { str: "SECRET", transform: [0, 10, -10, 0, 200, 100], width: 36, height: 10, fontName: "f1" };
  assert.equal(itemUnderMark(turned, false, [[188, 98, 202, 138]]), true);
  assert.equal(itemUnderMark(turned, false, [[202, 98, 214, 138]]), false, "the box lies on the other side of the baseline");
  // a column of vertical writing: the middle line runs down from the origin
  const column = { str: String.fromCharCode(0x7e26, 0x66f8, 0x304d), transform: [12, 0, 0, 12, 300, 700], width: 12, height: 36, fontName: "v" };
  assert.equal(itemUnderMark(column, true, [[290, 660, 310, 702]]), true);
  assert.equal(itemUnderMark(column, true, [[290, 680, 310, 702]]), false, "only a part of the column");
  for (const nothing of [null, {}, item("   ", 100, 200, 36), item("", 100, 200, 0), { str: "x", width: 5 }, { ...item("x", 100, 200, 5), transform: [0, 0, 0, 0, 100, 200] }, { ...item("x", 100, 200, 5), width: Number.NaN }]) {
    assert.equal(itemUnderMark(nothing, false, [[0, 0, 1000, 1000]]), false);
  }
  // a glyph without advance (a combining mark placed on its own) inside the mark
  assert.equal(itemUnderMark(item(String.fromCharCode(0x301), 100, 200, 0), false, [[98, 198, 138, 210]]), true);
});

test("checkRedacted: passes what the engine redacted, refuses the same document unredacted, with the page number", async () => {
  const cases = [
    [await plainTextPdf(), "redact"],
    [await vietnamesePdf(), "blur"],
    [await rotatedCropPdf(), "pixelate"]
  ];
  for (const [fixture, mode] of cases) {
    const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
    const targets = [{ pageIndex: 0, rect, mode }];
    const { bytes } = await redactPdf(fixture.bytes, targets, pipelineEnv());
    await checkRedacted(bytes, targets, 1, pipelineEnv());
    await rejectsWith(checkRedacted(fixture.bytes, targets, 1, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "redaction-text", page: 1 });
    // an "erase" target is never looked at: its line may still be there under a cover
    await checkRedacted(fixture.bytes, [{ pageIndex: 0, rect, mode: "erase" }], 1, pipelineEnv());
  }
});

test("checkRedacted: one word of a long line, a line in a Form XObject and a line on a later page", async () => {
  const long = "The account number SECRET-WORD-4711-0815 is due at the end of the month and not a day later";
  const form = (ctx, refs, fonts) => ctx.register(ctx.stream(new TextEncoder().encode("BT /F1 12 Tf 0 0 Td (FORM-SECRET-LINE 5521) Tj ET"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 612, 792], Resources: { Font: fonts } }));
  const { bytes } = await makePdf([
    { content: `BT /F1 9 Tf 40 700 Td (${long}) Tj ET` },
    { content: "BT /F1 12 Tf 72 720 Td (page two direct text) Tj ET q 1 0 0 1 72 600 cm /Fm Do Q", resources: (ctx, refs, fonts) => ({ Font: fonts, XObject: { Fm: refs.Fm } }) }
  ], { objects: { Fm: form } });
  const word = await boxOf(bytes, "SECRET-WORD-4711-0815", { pad: 0.5 });
  const inForm = await boxOf(bytes, "FORM-SECRET-LINE 5521", { page: 1, pad: 0.5 });
  const targets = [{ pageIndex: 0, rect: word, mode: "redact" }, { pageIndex: 1, rect: inForm, mode: "redact" }];
  const redacted = await redactPdf(bytes, targets, pipelineEnv());
  const seen = [];
  await checkRedacted(redacted.bytes, targets, 2, pipelineEnv(), undefined, (fraction) => seen.push(fraction));
  assert.deepEqual(seen, [0.5, 1]);
  // page 1 done, page 2 not: the page of the failure is named
  const half = await redactPdf(bytes, targets.slice(0, 1), pipelineEnv());
  await rejectsWith(checkRedacted(half.bytes, targets, 2, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "redaction-text", page: 2 });
  await rejectsWith(checkRedacted(bytes, targets, 2, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "redaction-text", page: 1 });
  // the items around the hole are still there and are not mistaken for leftovers
  const items = await withPdf(redacted.bytes, async (doc) => pageItems(await doc.getPage(1)));
  assert.ok(items.some((entry) => entry.str.includes("The account number")) && items.some((entry) => entry.str.includes("is due at the end")));
});

test("checkRedacted and checkOutput: page count, unreadable bytes, cancellation, a failing env", async () => {
  const two = await makeTextPdf([{ lines: ["Trang một"] }, { lines: ["Trang hai"] }]);
  await checkOutput(two, 2, pipelineEnv());
  await rejectsWith(checkOutput(two, 3, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "output-page-count", page: 0 });
  await rejectsWith(checkOutput(new Uint8Array(0), 1, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "output-unreadable", page: 0 });
  await rejectsWith(checkOutput("bytes", 1, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "output-unreadable" });
  const garbage = new TextEncoder().encode("%PDF-1.7\nnothing that follows is a document");
  const unreadable = await rejectsWith(checkOutput(garbage, 1, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "output-unreadable" });
  assert.ok(unreadable.cause, "the reason pdf.js gave is kept for logs");
  await rejectsWith(checkRedacted(two, [], 3, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "redaction-page-count", page: 0 });
  await rejectsWith(checkRedacted(garbage, [], 1, pipelineEnv()), "PIPELINE_SELF_CHECK_FAILED", { check: "redaction-unreadable", page: 0 });
  // the input is not handed to pdf.js itself (it would be detached)
  assert.ok(two.byteLength > 0 && two.buffer.byteLength > 0);

  const controller = new AbortController();
  controller.abort();
  await rejectsWith(checkOutput(two, 2, pipelineEnv(), controller.signal), "CANCELLED");
  await rejectsWith(checkRedacted(two, [], 2, pipelineEnv(), controller.signal), "CANCELLED");

  // an error of the env that carries a code is not turned into a verdict about the bytes
  const { PdfEditorError } = await import("../src/pages/pdfEditor/engine/errors.js");
  const broken = pipelineEnv({ openPdf: async () => {
    throw new PdfEditorError("REDACT_ENV_INVALID", { missing: "worker" });
  } });
  await rejectsWith(checkOutput(two, 2, broken), "REDACT_ENV_INVALID", { missing: "worker" });
  // every document that was opened is closed again, also when the check fails
  let open = 0;
  const base = pipelineEnv();
  const counting = pipelineEnv({
    openPdf: async (...args) => {
      open += 1;
      return base.openPdf(...args);
    },
    closePdf: async (doc) => {
      open -= 1;
      return base.closePdf(doc);
    }
  });
  await rejectsWith(checkOutput(two, 5, counting), "PIPELINE_SELF_CHECK_FAILED");
  await checkOutput(two, 2, counting);
  assert.equal(open, 0);
});

test("checkRedactionResult: one row per target, in order, with an outcome its mode can have", () => {
  const targets = [{ pageIndex: 0, rect: [0, 0, 10, 10], mode: "redact" }, { pageIndex: 2, rect: [0, 0, 10, 10], mode: "erase" }];
  const report = () => ({
    pages: [{ pageIndex: 0, path: "precise", reasons: [], ok: true }, { pageIndex: 2, path: "untouched", reasons: [], ok: true }],
    targets: [{ index: 0, pageIndex: 0, mode: "redact", outcome: "precise" }, { index: 1, pageIndex: 2, mode: "erase", outcome: "cover-needed" }],
    warnings: [{ code: "REDACT_XFA_REMOVED", params: {} }],
    fontsNotCleaned: [{ font: "ABCDEF+Arimo", pageIndexes: [0, 2, "x", -1] }, { font: 7, pageIndexes: [1] }, null, { font: "CMR10", pageIndexes: [1], reason: "type1" }, { font: "Odd", pageIndexes: [], reason: 3 }]
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const checked = checkRedactionResult({ bytes, report: report() }, targets);
  assert.equal(checked.bytes, bytes);
  assert.equal(checked.rows.length, 2);
  assert.deepEqual(checked.warnings, [{ code: "REDACT_XFA_REMOVED", params: {} }]);
  assert.deepEqual(checked.fontsNotCleaned, [{ font: "ABCDEF+Arimo", pageIndexes: [0, 2], reason: null }, { font: "CMR10", pageIndexes: [1], reason: "type1" }, { font: "Odd", pageIndexes: [], reason: null }]);
  assert.deepEqual(checkRedactionResult({ bytes, report: { ...report(), fontsNotCleaned: undefined, warnings: undefined } }, targets).fontsNotCleaned, []);

  const refuse = (change) => {
    const result = { bytes, report: report() };
    change(result);
    assert.throws(() => checkRedactionResult(result, targets), (error) => error.code === "PIPELINE_SELF_CHECK_FAILED" && error.params.check === "redaction-result" && error.params.page === 0);
  };
  refuse((result) => { result.bytes = bytes.buffer; });
  refuse((result) => { result.report = null; });
  refuse((result) => { result.report.targets.pop(); });
  refuse((result) => { result.report.targets.reverse(); });
  refuse((result) => { result.report.targets[0].pageIndex = 1; });
  refuse((result) => { result.report.targets[0].mode = "blur"; });
  refuse((result) => { result.report.targets[0].outcome = "done"; });
  refuse((result) => { result.report.targets[0].outcome = "cover-needed"; });
  refuse((result) => { result.report.pages[1].ok = false; });
  refuse((result) => { result.report.pages[0].path = "skipped"; });
  refuse((result) => { delete result.report.pages; });
  assert.throws(() => checkRedactionResult(undefined, targets), (error) => error.code === "PIPELINE_SELF_CHECK_FAILED");
});
