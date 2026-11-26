// engine/pipeline buildOutput(): the export job through the engines (assemble -> redact -> draw -> self-check).
// Hermetic: every PDF is generated in the test (tests/helpers), the checks on an output share no code with the
// pipeline (pdf.js text, the raw scan, the orphan walk, pixels).
import test from "node:test";
import assert from "node:assert/strict";
import { CODES, STAGES, buildOutput, detectSignatures, inspectSource } from "../src/pages/pdfEditor/engine/pipeline/index.js";
import * as exportEngine from "../src/pages/pdfEditor/engine/export/index.js";
import { VIETNAMESE_SAMPLE, canRender, makeTextPdf, pdfLib, squash } from "./helpers/pdfTestKit.mjs";
import { VIETNAMESE_PANGRAM } from "./helpers/pdfTextKit.mjs";
import { boxOf, findOrphans, found, makePdf, regionOf } from "./helpers/pdfRedactKit.mjs";
import { pictureUnderMarkPdf, plainTextPdf, unmeasurablePdf, vietnamesePdf } from "./helpers/pdfRedactFixtures.mjs";
import { fileFacts, textLeaks } from "./helpers/pdfExportScan.mjs";
import {
  assertFlatColour, deepFreeze, everyObjectType, fixedOptions, makeJob, pageTexts, pipelineEnv, progressRecorder, rejectsWith, snapshotJob, sourceOf,
  spyEngines, textBox
} from "./helpers/pdfPipelineKit.mjs";

const [STAGE_ASSEMBLE, STAGE_REDACT, STAGE_DRAW, STAGE_CHECK] = STAGES;
const SEED_A = "00112233445566778899aabbccddeeff";
const SEED_B = "ffeeddccbbaa99887766554433221100";
const pixels = { skip: !canRender && "no canvas" };
const codesOf = (entries) => entries.map((entry) => entry.code);

/** Two pages: the plain Helvetica fixture and the Vietnamese subset-font fixture, each with a secret and its box. */
async function twoPageJob() {
  const plain = await plainTextPdf();
  const viet = await vietnamesePdf();
  const plainRect = await boxOf(plain.bytes, plain.secret, { pad: 0.5 });
  const vietRect = await boxOf(viet.bytes, viet.secret, { pad: 0.5 });
  const job = makeJob({
    sources: [sourceOf("plain", plain.bytes, 1), sourceOf("viet", viet.bytes, 1)],
    pages: [{ source: "plain", index: 0, rotate: 0 }, { source: "viet", index: 0, rotate: 0 }]
  });
  return { job, plain, viet, plainRect, vietRect };
}

// ---------------------------------------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------------------------------------

test("the module exports the contract: stages, codes and the writer's inspection", () => {
  assert.deepEqual(STAGES, ["PIPELINE_STAGE_ASSEMBLE", "PIPELINE_STAGE_REDACT", "PIPELINE_STAGE_DRAW", "PIPELINE_STAGE_CHECK"]);
  assert.ok(Object.isFrozen(STAGES) && Object.isFrozen(CODES));
  for (const [code, params] of Object.entries(CODES)) {
    assert.match(code, /^PIPELINE_[A-Z_]+$/);
    assert.ok(Array.isArray(params) && params.every((name) => typeof name === "string"), code);
  }
  assert.deepEqual(CODES.PIPELINE_SELF_CHECK_FAILED, ["check", "page"]);
  assert.equal(CODES.PIPELINE_JOB_INVALID[0], "reason");
  assert.equal(inspectSource, exportEngine.inspectSource);
  assert.equal(detectSignatures, exportEngine.detectSignatures);
});

// ---------------------------------------------------------------------------------------------------------
// without marks: one pass
// ---------------------------------------------------------------------------------------------------------

test("without marks: pages of two sources reordered, deleted pages truly gone, every object type drawn", async () => {
  const keep = { a1: "ALPHA-ONE-KEEP-1101", a3: "ALPHA-THREE-KEEP-3303", b1: "BRAVO-ONE-KEEP-4404" };
  const gone = { a2: "ALPHA-TWO-GONE-2202", b2: "BRAVO-TWO-GONE-5505" };
  const sourceA = await makeTextPdf([{ lines: [keep.a1] }, { lines: [gone.a2, "Trang bị xóa của tệp A"] }, { lines: [keep.a3] }], { title: "Tệp nguồn A" });
  const sourceB = await makeTextPdf([{ lines: [keep.b1, VIETNAMESE_SAMPLE] }, { lines: [gone.b2] }]);
  const drawn = everyObjectType("page-b1");
  const note = textBox({ id: "note", pageId: "page-b1", text: VIETNAMESE_PANGRAM, left: 60, top: 560, size: 9 });
  const serif = textBox({ id: "serif", pageId: "page-a3", text: "Điều khoản bổ sung: thanh toán trong 30 ngày", left: 60, top: 500, font: "tinos", bold: true, size: 16 });
  const job = makeJob({
    sources: [sourceOf("a", sourceA, 3), sourceOf("b", sourceB, 2)],
    pages: [{ source: "b", index: 0, rotate: 0 }, { source: "a", index: 2, rotate: 0 }, { blank: [300, 400], rotate: 0 }, { source: "a", index: 0, rotate: 90 }],
    objects: [[...drawn.objects, note], [serif], [], []],
    assets: drawn.assets
  });
  const spy = spyEngines();
  const progress = progressRecorder();
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions({ onProgress: progress.onProgress, engines: spy.engines }));

  // one assemble pass that also draws; nothing else ran
  assert.deepEqual(spy.calls.map((call) => call.name), ["assembleDocument"]);
  assert.equal(spy.calls[0].args[1].draw, true);
  assert.equal(spy.calls[0].result.report.objectsDrawn, drawn.objects.length + 2);
  progress.assertComplete([STAGE_ASSEMBLE, STAGE_CHECK]);

  // the report
  assert.equal(report.pageCount, 4);
  assert.equal(report.byteLength, bytes.length);
  assert.equal(report.usedRedaction, false);
  assert.equal(report.redaction, null);
  assert.deepEqual(report.rasterizedTextObjectIds, []);
  assert.deepEqual(report.sources, { b: { signatures: 0, encrypted: false, tagged: false }, a: { signatures: 0, encrypted: false, tagged: false } });
  assert.deepEqual(Object.keys(report.timings).sort(), ["assemble", "check", "draw", "redact", "total"]);
  assert.ok(Object.values(report.timings).every((value) => Number.isFinite(value) && value >= 0));
  assert.deepEqual(report.warnings, []);

  // the pages, in the new order, with the user's Vietnamese text as real text
  const texts = await pageTexts(bytes);
  assert.equal(texts.length, 4);
  assert.ok(texts[0].includes(squash(keep.b1)) && texts[0].includes(squash(VIETNAMESE_SAMPLE)), texts[0]);
  assert.ok(texts[0].includes(squash(VIETNAMESE_PANGRAM)), "the text box is not extractable");
  assert.ok(texts[1].includes(squash(keep.a3)) && texts[1].includes(squash("Điều khoản bổ sung: thanh toán trong 30 ngày")), texts[1]);
  assert.equal(texts[2], "");
  assert.ok(texts[3].includes(squash(keep.a1)));

  // the deleted pages are nowhere in the file
  assert.deepEqual(await textLeaks(bytes, [gone.a2, gone.b2, "Trang bị xóa của tệp A"]), []);
  assert.deepEqual(await textLeaks(bytes, [keep.a1]), [keep.a1], "control: the scan finds text that is there");
  const facts = await fileFacts(bytes);
  assert.deepEqual(facts.orphans, []);
  assert.deepEqual(facts.audit, []);
  assert.equal(facts.revisions, 1);
  assert.equal(facts.pages, 4);
});

test("without marks: every object type shows its colour on the page", pixels, async () => {
  const source = await makeTextPdf([{ lines: ["Trang nền cho các đối tượng"] }]);
  const drawn = everyObjectType("page-1");
  const job = makeJob({ sources: [sourceOf("s", source, 1)], pages: [{ source: "s", index: 0, rotate: 0 }], objects: [drawn.objects], assets: drawn.assets });
  const { bytes } = await buildOutput(job, pipelineEnv(), fixedOptions());
  for (const probe of drawn.probes) await assertFlatColour(bytes, 0, probe.rect, probe.color, probe.type);
});

test("job.now is the clock of the file unless options.now is given; the same job gives the same bytes", async () => {
  const source = await makeTextPdf([{ lines: ["Một trang"] }]);
  const job = { ...makeJob({ sources: [sourceOf("s", source, 1)], pages: [{ source: "s", index: 0, rotate: 0 }] }), now: new Date(Date.UTC(2031, 4, 6, 7, 8, 9)) };
  const idSeed = new Uint8Array(16).fill(9);
  const modified = async (bytes) => (await pdfLib.PDFDocument.load(bytes, { updateMetadata: false })).getModificationDate().toISOString();
  const first = await buildOutput(job, pipelineEnv(), { idSeed });
  assert.equal(await modified(first.bytes), "2031-05-06T07:08:09.000Z");
  const again = await buildOutput(job, pipelineEnv(), { idSeed });
  assert.deepEqual(again.bytes, first.bytes);
  const other = await buildOutput(job, pipelineEnv(), { idSeed, now: new Date(Date.UTC(2040, 0, 2, 3, 4, 5)) });
  assert.equal(await modified(other.bytes), "2040-01-02T03:04:05.000Z");
});

// ---------------------------------------------------------------------------------------------------------
// with marks
// ---------------------------------------------------------------------------------------------------------

test("a redact mark removes the original text; the user's own text box over the mark is real text", async () => {
  const { job, plain, viet, plainRect } = await twoPageJob();
  const own = "Chữ của người dùng 2026";
  // the box starts 15 pt right of the mark's left edge, on the mark
  const note = textBox({ id: "note", pageId: "p0", text: own, left: plainRect[0] + 15, top: plainRect[3] + 1, size: 10, color: "#ffffff" });
  job.objects[0] = [note];
  job.marks = [{ pageIndex: 0, rect: plainRect, mode: "redact", color: "#112233", objectId: "mark-1" }];
  const spy = spyEngines();
  const progress = progressRecorder();
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions({ onProgress: progress.onProgress, engines: spy.engines }));

  // A without drawing, B with the mark, C with all objects in ONE call
  assert.deepEqual(spy.calls.map((call) => call.name), ["assembleDocument", "redactPdf", "drawOnDocument"]);
  assert.equal(spy.calls[0].args[1].draw, false);
  assert.deepEqual(spy.calls[1].args[1], [{ pageIndex: 0, rect: plainRect, mode: "redact", color: "#112233" }]);
  assert.equal(spy.calls[1].args[2].path, "hybrid");
  assert.deepEqual(spy.calls[2].args[1].map((list) => list.map((object) => object.id)), [["note"], []]);
  progress.assertComplete([STAGE_ASSEMBLE, STAGE_REDACT, STAGE_DRAW, STAGE_CHECK]);

  const texts = await pageTexts(bytes);
  assert.ok(!texts[0].includes(squash(plain.secret)), "pdf.js still extracts the redacted text");
  for (const kept of plain.kept) assert.ok(texts[0].includes(squash(kept)), `lost "${kept}"`);
  assert.ok(texts[0].includes(squash(own)), "the user's text over the mark is not extractable");
  assert.ok(texts[1].includes(squash(viet.secret)), "a page without marks changed");
  assert.equal(found(bytes, plain.secret), false, "the redacted text is still in the bytes");
  assert.deepEqual(await textLeaks(bytes, [plain.secret]), []);
  assert.deepEqual(await findOrphans(bytes), []);

  assert.equal(report.usedRedaction, true);
  assert.deepEqual(report.redaction.pages, [{ pageIndex: 0, path: "precise", reasons: [], areas: 1, replacedLines: 0 }]);
  assert.deepEqual(report.redaction.targets, [{ index: 0, pageIndex: 0, mode: "redact", outcome: "precise", objectId: "mark-1" }]);
  assert.deepEqual(report.redaction.coveredObjectIds, []);
  assert.deepEqual(report.redaction.elsewhere, []);
  assert.deepEqual(report.redaction.fontsNotCleaned, []);
  assert.deepEqual(report.redaction.rasterPagesNotApplied, []);
  assert.deepEqual(report.warnings, []);
  assert.ok(report.timings.redact > 0 && report.timings.total >= report.timings.redact);

  if (canRender) {
    // the box of the mark, left of the user's text
    await assertFlatColour(bytes, 0, [plainRect[0] + 1, plainRect[1] + 1, plainRect[0] + 12, plainRect[3] - 1], "#112233", "the redaction box");
  }
});

test("pixelate and blur marks: the text is gone, a mosaic is there, the seed of the mark reaches the engine", async () => {
  const { job, plain, viet, plainRect, vietRect } = await twoPageJob();
  job.marks = [
    { pageIndex: 0, rect: plainRect, mode: "pixelate", strength: 1, seed: SEED_A, objectId: "blur-1" },
    { pageIndex: 1, rect: vietRect, mode: "blur", strength: 2, seed: SEED_B, objectId: "blur-2" }
  ];
  const spy = spyEngines();
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions({ engines: spy.engines }));
  assert.deepEqual(spy.calls[1].args[1], [
    { pageIndex: 0, rect: plainRect, mode: "pixelate", strength: 1, seed: SEED_A },
    { pageIndex: 1, rect: vietRect, mode: "blur", strength: 2, seed: SEED_B }
  ]);
  // nothing to draw: stage C is skipped
  assert.deepEqual(spy.calls.map((call) => call.name), ["assembleDocument", "redactPdf"]);

  const texts = await pageTexts(bytes);
  assert.ok(!texts[0].includes(squash(plain.secret)) && !texts[1].includes(squash(viet.secret)));
  for (const kept of plain.kept) assert.ok(texts[0].includes(squash(kept)));
  for (const kept of viet.kept) assert.ok(texts[1].includes(squash(kept)), `lost "${kept}"`);
  assert.deepEqual(await textLeaks(bytes, [plain.secret, viet.secret]), []);
  assert.deepEqual(report.redaction.targets.map((row) => [row.mode, row.outcome, row.objectId]), [["pixelate", "precise", "blur-1"], ["blur", "precise", "blur-2"]]);
  assert.deepEqual(report.redaction.pages.map((page) => [page.pageIndex, page.path, page.areas]), [[0, "precise", 1], [1, "precise", 1]]);

  if (canRender) {
    for (const [pageIndex, rect, original] of [[0, plainRect, plain.bytes], [1, vietRect, viet.bytes]]) {
      const before = await regionOf(original, 0, rect);
      const now = await regionOf(bytes, pageIndex, rect);
      assert.ok(now.colours.size > 1, "a mosaic is not one flat colour");
      assert.ok(now.edges <= Math.max(12, before.edges * 0.25), `page ${pageIndex + 1}: edges ${before.edges} -> ${now.edges}`);
    }
  }

  // the same job again, with a fresh env: the same file
  const again = await buildOutput(job, pipelineEnv(), fixedOptions());
  assert.deepEqual(again.bytes, bytes);
});

test("an erase mark with a replacement text: the old line is gone, the new text is there", async () => {
  const plain = await plainTextPdf();
  const oldLine = "Account PLAIN-SECRET-4711 is due";
  const lineRect = await boxOf(plain.bytes, oldLine, { pad: 0.5 });
  const newLine = "Tài khoản mới 9001 đã thanh toán";
  const replacement = textBox({ id: "edit-1", pageId: "p0", text: newLine, left: lineRect[0], top: lineRect[3], replaces: { rect: lineRect, cover: null, sourceText: oldLine } });
  const job = makeJob({
    sources: [sourceOf("plain", plain.bytes, 1)],
    pages: [{ source: "plain", index: 0, rotate: 0 }],
    objects: [[replacement]],
    marks: [{ pageIndex: 0, rect: lineRect, mode: "erase", cover: null, objectId: "edit-1" }]
  });
  const spy = spyEngines();
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions({ engines: spy.engines }));
  assert.deepEqual(spy.calls[1].args[1], [{ pageIndex: 0, rect: lineRect, mode: "erase" }]);
  assert.deepEqual(spy.calls[2].args[2].underlays, [[]], "no cover where the line was erased");

  const [text] = await pageTexts(bytes);
  assert.ok(!text.includes(squash(plain.secret)) && !text.includes("Account") && !text.includes("isdue"), text);
  assert.ok(text.includes(squash(newLine)), text);
  assert.ok(text.includes(squash("Invoice for Alice Example")) && text.includes(squash("Last line stays untouched")));
  assert.equal(found(bytes, plain.secret), false);
  assert.deepEqual(await textLeaks(bytes, [plain.secret]), []);
  assert.deepEqual(await findOrphans(bytes), []);
  assert.deepEqual(report.redaction.targets, [{ index: 0, pageIndex: 0, mode: "erase", outcome: "precise", objectId: "edit-1" }]);
  assert.deepEqual(report.redaction.pages, [{ pageIndex: 0, path: "precise", reasons: [], areas: 0, replacedLines: 1 }]);
  assert.deepEqual(report.redaction.coveredObjectIds, []);
  assert.deepEqual(report.warnings, []);
});

/** A page whose first line cannot be erased precisely (a font the remover cannot measure), with its replacement. */
async function coverJob(cover) {
  const fixture = await unmeasurablePdf();
  const rect = fixture.unmeasurableRect;
  const newLine = "Dòng thay thế 7788";
  // (placed away from the old line, so that the pixels of the cover can be looked at)
  const replacement = textBox({ id: "edit-cover", pageId: "p0", text: newLine, left: 300, top: 500, replaces: { rect, cover, sourceText: "old" } });
  const job = makeJob({
    sources: [sourceOf("u", fixture.bytes, 1)],
    pages: [{ source: "u", index: 0, rotate: 0 }],
    objects: [[replacement]],
    marks: [{ pageIndex: 0, rect, mode: "erase", cover, objectId: "edit-cover" }]
  });
  return { job, fixture, rect, newLine, oldHex: "82A082A282A482A6" };
}

test("an erase mark that cannot be applied gets an underlay in its cover colour and is reported as covered", async () => {
  const { job, fixture, rect, newLine, oldHex } = await coverJob("#ffeecc");
  const oldText = (await pageTexts(fixture.bytes))[0].replace(squash("MEASURABLE-LINE-6034 here"), "").replace(squash("another plain line"), "");
  assert.ok(oldText.length >= 4, "the fixture has no extractable old line");
  const spy = spyEngines();
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions({ engines: spy.engines }));

  assert.deepEqual(spy.calls.map((call) => call.name), ["assembleDocument", "redactPdf", "drawOnDocument"]);
  assert.deepEqual(spy.calls[2].args[2].underlays, [[{ rect, color: "#ffeecc" }]]);
  assert.deepEqual(report.redaction.targets, [{
    index: 0, pageIndex: 0, mode: "erase", outcome: "cover-needed", objectId: "edit-cover", reason: { code: "REDACT_UNMEASURABLE_TEXT", params: { page: 1, font: "MS-Gothic" } }
  }]);
  assert.deepEqual(report.redaction.pages.map((page) => [page.pageIndex, page.path, codesOf(page.reasons), page.replacedLines]), [[0, "untouched", ["REDACT_UNMEASURABLE_TEXT"], 1]]);
  assert.deepEqual(report.redaction.coveredObjectIds, ["edit-cover"]);
  assert.deepEqual(report.warnings, [{ code: "PIPELINE_ERASE_COVERED", params: { count: 1 } }]);

  // honest: the old text is still in the file, only hidden
  const [text] = await pageTexts(bytes);
  assert.ok(text.includes(oldText), "the report says the old text is still in the file, and it is not");
  assert.equal(found(bytes, oldHex), true);
  assert.ok(text.includes(squash(newLine)));
  if (canRender) await assertFlatColour(bytes, 0, [rect[0] + 1, rect[1] + 1, rect[2] - 1, rect[3] - 1], "#ffeecc", "the cover");
});

test("a covered line without a cover colour gets a white underlay", async () => {
  const { job, rect } = await coverJob(null);
  const spy = spyEngines();
  const { report } = await buildOutput(job, pipelineEnv(), fixedOptions({ engines: spy.engines }));
  assert.deepEqual(spy.calls[1].args[1], [{ pageIndex: 0, rect, mode: "erase" }]);
  assert.deepEqual(spy.calls[2].args[2].underlays, [[{ rect, color: "#ffffff" }]]);
  assert.deepEqual(report.redaction.coveredObjectIds, ["edit-cover"]);
});

test("eraseFallback \"redact\": a line that cannot be erased is removed for real, and its page is reported as a picture", async () => {
  const { job, fixture, rect, newLine, oldHex } = await coverJob("#ffeecc");
  assert.equal(found(fixture.bytes, oldHex), true, "control: the raw scan finds the old line in the source");
  const spy = spyEngines();
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions({ eraseFallback: "redact", engines: spy.engines }));

  // the redaction ran twice from the ASSEMBLED bytes: first as asked, then with the line as a redaction
  assert.deepEqual(spy.calls.map((call) => call.name), ["assembleDocument", "redactPdf", "redactPdf", "drawOnDocument"]);
  assert.equal(spy.calls[1].args[0], spy.calls[0].result.bytes);
  assert.equal(spy.calls[2].args[0], spy.calls[0].result.bytes);
  assert.deepEqual(spy.calls[2].args[1], [{ pageIndex: 0, rect, mode: "redact", color: "#ffeecc" }]);
  assert.deepEqual(spy.calls[3].args[2].underlays, [[]]);

  assert.deepEqual(report.redaction.targets, [{ index: 0, pageIndex: 0, mode: "erase", outcome: "raster", objectId: "edit-cover", fallback: "redact" }]);
  assert.deepEqual(report.redaction.pages.map((page) => [page.pageIndex, page.path, codesOf(page.reasons)]), [[0, "raster", ["REDACT_UNMEASURABLE_TEXT"]]]);
  assert.deepEqual(report.redaction.coveredObjectIds, []);
  assert.ok(report.warnings.some((entry) => entry.code === "PIPELINE_PAGES_RASTERIZED" && entry.params.count === 1 && entry.params.pages[0] === 1), JSON.stringify(report.warnings));
  assert.ok(!codesOf(report.warnings).includes("PIPELINE_ERASE_COVERED"));

  const [text] = await pageTexts(bytes);
  assert.ok(text.includes(squash("MEASURABLE-LINE-6034 here")) && text.includes(squash("another plain line")), `the text layer of the picture lost a line: ${text}`);
  assert.ok(text.includes(squash(newLine)));
  assert.equal(text.replace(squash("MEASURABLE-LINE-6034 here"), "").replace(squash("another plain line"), "").replace(squash(newLine), ""), "", "the old line is still extractable");
  assert.equal(found(bytes, oldHex), false, "the old line is still in the bytes");
  assert.deepEqual(await findOrphans(bytes), []);
});

test("a page that the engine can only redact as a picture is reported as such", async () => {
  const picture = await pictureUnderMarkPdf();
  const rect = await boxOf(picture.bytes, picture.target, { pad: 0.5 });
  const own = "Ghi chú trên trang ảnh";
  const job = makeJob({
    sources: [sourceOf("pic", picture.bytes, 1)],
    pages: [{ source: "pic", index: 0, rotate: 0 }],
    objects: [[textBox({ id: "note", pageId: "p0", text: own, left: 72, top: 300 })]],
    marks: [{ pageIndex: 0, rect, mode: "redact", color: "#000000", objectId: "mark-1" }]
  });
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions());
  assert.deepEqual(report.redaction.targets, [{ index: 0, pageIndex: 0, mode: "redact", outcome: "raster", objectId: "mark-1" }]);
  assert.deepEqual(report.redaction.pages.map((page) => [page.path, codesOf(page.reasons)]), [["raster", ["REDACT_IMAGE_IN_TARGET"]]]);
  assert.deepEqual(report.warnings.at(-1), { code: "PIPELINE_PAGES_RASTERIZED", params: { count: 1, pages: [1] } });
  assert.ok(!codesOf(report.warnings).includes("PIPELINE_PAGES_RASTERIZED_ON_REQUEST"));
  const [text] = await pageTexts(bytes);
  assert.ok(!text.includes(squash(picture.secret)));
  for (const kept of picture.kept) assert.ok(text.includes(squash(kept)), `lost "${kept}"`);
  assert.ok(text.includes(squash(own)));
  assert.equal(found(bytes, picture.secret), false);
});

test("rasterPages: the listed pages become pictures in the one call of the engine, with or without marks", async () => {
  const { job, plain, viet, plainRect, vietRect } = await twoPageJob();
  // a third page WITHOUT any mark that shows text: listed in rasterPages it must become a picture too (that is
  // how a font the engine could not clean leaves the file: every page that uses it is converted)
  const extraWords = "UNMARKED-PAGE-WORDS-5150";
  const { bytes: extraBytes } = await makePdf([{ content: `BT /F1 12 Tf 72 700 Td (A page nobody marked: ${extraWords}) Tj ET` }]);
  job.sources.push(sourceOf("extra", extraBytes, 1));
  job.pages.push({ source: "extra", index: 0, rotate: 0 });
  job.objects.push([]);
  job.marks = [
    { pageIndex: 0, rect: plainRect, mode: "redact", color: "#000000", objectId: "mark-plain" },
    { pageIndex: 1, rect: vietRect, mode: "redact", color: "#000000", objectId: "mark-viet" }
  ];
  const spy = spyEngines();
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions({ rasterPages: [2, 1, 1], engines: spy.engines }));

  const redactions = spy.calls.filter((call) => call.name === "redactPdf");
  assert.deepEqual(redactions.map((call) => [call.args[2].path, call.args[2].rasterPages, call.args[1].map((target) => target.pageIndex)]), [["hybrid", [1, 2], [0, 1]]]);
  assert.deepEqual(report.redaction.targets.map((row) => [row.index, row.pageIndex, row.outcome, row.objectId]), [[0, 0, "precise", "mark-plain"], [1, 1, "raster", "mark-viet"]]);
  assert.deepEqual(
    report.redaction.pages.map((page) => [page.pageIndex, page.path, codesOf(page.reasons), page.areas, page.replacedLines]),
    [[0, "precise", [], 1, 0], [1, "raster", ["REDACT_RASTER_FORCED"], 1, 0], [2, "raster", ["REDACT_RASTER_FORCED"], 0, 0]]
  );
  assert.deepEqual(report.redaction.rasterPagesNotApplied, [], "every listed page is a picture, also the one without a mark");
  assert.ok(report.warnings.some((entry) => entry.code === "PIPELINE_PAGES_RASTERIZED_ON_REQUEST" && entry.params.count === 2 && entry.params.pages.join() === "2,3"));
  assert.ok(!codesOf(report.warnings).includes("PIPELINE_PAGES_RASTERIZED"));

  const texts = await pageTexts(bytes);
  assert.ok(!texts[0].includes(squash(plain.secret)) && !texts[1].includes(squash(viet.secret)));
  for (const kept of viet.kept) assert.ok(texts[1].includes(squash(kept)), `the text layer lost "${kept}"`);
  // the page without marks keeps its words as the invisible layer of the picture
  assert.ok(texts[2].includes(squash(extraWords)), "the text layer of the page that was converted on request lost its text");
  assert.deepEqual(await textLeaks(bytes, [plain.secret, viet.secret]), []);

  // without the option no env.rasterPages is sent at all
  const plainRun = spyEngines();
  await buildOutput(job, pipelineEnv(), fixedOptions({ engines: plainRun.engines }));
  assert.ok(!("rasterPages" in plainRun.calls.find((call) => call.name === "redactPdf").args[2]));

  // redactPath "raster" is one call for everything
  const all = spyEngines();
  const forced = await buildOutput(job, pipelineEnv(), fixedOptions({ redactPath: "raster", rasterPages: [0], engines: all.engines }));
  assert.deepEqual(all.calls.filter((call) => call.name === "redactPdf").map((call) => call.args[2].path), ["raster"]);
  assert.deepEqual(forced.report.redaction.pages.map((page) => page.path), ["raster", "raster"]);
});

test("the report carries what the engine says about fonts and about text repeated elsewhere", async () => {
  const { job, plainRect, vietRect } = await twoPageJob();
  job.marks = [
    { pageIndex: 0, rect: plainRect, mode: "redact", color: "#000000", objectId: "mark-plain" },
    { pageIndex: 1, rect: vietRect, mode: "redact", color: "#000000", objectId: "mark-viet" }
  ];
  const spy = spyEngines();
  const redactPdf = async (bytes, targets, env) => {
    const result = await spy.real.redactPdf(bytes, targets, env);
    return {
      bytes: result.bytes,
      report: {
        ...result.report,
        // (the same font twice and the same place twice: a careless engine must not double the rows)
        fontsNotCleaned: [{ font: "ABCDEF+Arimo", pageIndexes: [1] }, { font: "Helvetica", pageIndexes: [0, 5], reason: "type1" }, { font: "ABCDEF+Arimo", pageIndexes: [0] }],
        warnings: [
          ...result.report.warnings,
          { code: "REDACT_TEXT_ELSEWHERE", params: { where: "outline", count: 2 } },
          { code: "REDACT_TEXT_ELSEWHERE", params: { where: "attachment", count: 1 } },
          { code: "REDACT_TEXT_ELSEWHERE", params: { where: "outline", count: 3 } },
          { code: "REDACT_TEXT_ELSEWHERE", params: { where: "metadata", count: 1 } }
        ]
      }
    };
  };
  const { report } = await buildOutput(job, pipelineEnv(), fixedOptions({ rasterPages: [1], engines: { redactPdf } }));
  assert.deepEqual(report.redaction.fontsNotCleaned, [{ font: "ABCDEF+Arimo", pageIndexes: [0, 1], reason: null }, { font: "Helvetica", pageIndexes: [0, 5], reason: "type1" }]);
  assert.deepEqual(report.redaction.elsewhere, [{ where: "outline", count: 5 }, { where: "attachment", count: 1 }, { where: "metadata", count: 1 }]);
  // warnings: of every stage in order, without repeats
  const elsewhere = report.warnings.filter((entry) => entry.code === "REDACT_TEXT_ELSEWHERE");
  assert.deepEqual(elsewhere.map((entry) => entry.params.where), ["outline", "attachment", "outline", "metadata"]);
  assert.equal(new Set(report.warnings.map((entry) => JSON.stringify(entry))).size, report.warnings.length);
});

test("text that a mark removed and the document properties repeat is reported as \"elsewhere\"", async () => {
  const secret = "PIPELINE-TITLE-SECRET-9090";
  const { bytes: source } = await makePdf([{ content: `BT /F1 12 Tf 72 700 Td (The code is ${secret} today) Tj 0 -30 Td (a line that stays) Tj ET` }], { setup: (doc) => doc.setTitle(`Report about ${secret}`) });
  const rect = await boxOf(source, secret, { pad: 0.5 });
  const job = makeJob({ sources: [sourceOf("s", source, 1)], pages: [{ source: "s", index: 0, rotate: 0 }], marks: [{ pageIndex: 0, rect, mode: "redact", color: "#000000", objectId: "m" }] });
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions());
  assert.deepEqual(report.redaction.elsewhere.map((row) => row.where), ["metadata"]);
  assert.ok(report.redaction.elsewhere[0].count >= 1);
  assert.ok(report.warnings.some((entry) => entry.code === "REDACT_TEXT_ELSEWHERE" && entry.params.where === "metadata"));
  assert.equal(found(bytes, secret), true, "the report says the properties still hold the text");

  // the caller's answer: build again without the properties
  const cleaned = await buildOutput({ ...job, info: { title: "", author: "", subject: "", keywords: "", creator: "" } }, pipelineEnv(), fixedOptions());
  assert.deepEqual(cleaned.report.redaction.elsewhere, []);
  assert.equal(found(cleaned.bytes, secret), false);
});

test("a text box that is exported as a picture is listed in rasterizedTextObjectIds", async () => {
  const source = await makeTextPdf([{ lines: ["Trang có hộp văn bản dạng ảnh"] }]);
  const box = textBox({ id: "emoji-box", pageId: "p0", text: "Xin chào", left: 60, top: 500 });
  const picture = everyObjectType().assets["asset-red"].bytes;
  box.layout = { ...box.layout, lines: box.layout.lines.map((line) => ({ ...line, runs: [] })), raster: { png: picture, x: 0, y: 0, w: box.frame.w, h: box.frame.h }, problems: ["TEXT_RASTERIZED"] };
  const real = textBox({ id: "real-box", pageId: "p0", text: "Văn bản thật", left: 60, top: 440 });
  const job = makeJob({ sources: [sourceOf("s", source, 1)], pages: [{ source: "s", index: 0, rotate: 0 }], objects: [[box, real]] });
  const { bytes, report } = await buildOutput(job, pipelineEnv(), fixedOptions());
  assert.deepEqual(report.rasterizedTextObjectIds, ["emoji-box"]);
  const [text] = await pageTexts(bytes);
  assert.ok(text.includes(squash("Văn bản thật")) && !text.includes(squash("Xin chào")));
});

// ---------------------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------------------

test("an unusable job, option or env is refused before any engine runs", async () => {
  const source = await makeTextPdf([{ lines: ["Một trang"] }, { lines: ["Trang hai"] }]);
  const good = () => makeJob({ sources: [sourceOf("s", source, 2)], pages: [{ source: "s", index: 0, rotate: 0 }, { source: "s", index: 1, rotate: 0 }] });
  const rect = [10, 10, 50, 30];
  const text = textBox({ id: "t", pageId: "p0", text: "Chữ", left: 50, top: 300 });
  const { layout: ignoredLayout, ...withoutLayout } = text;
  assert.ok(ignoredLayout);
  const picture = { id: "img", type: "image", pageId: "p0", frame: { x: 100, y: 100, w: 20, h: 20, rot: 0 }, assetId: "missing", role: "image", opacity: 1 };
  const cases = [
    ["not an object", null, {}, { reason: "shape" }],
    ["no pages", { ...good(), pages: [] }, {}, { reason: "no-pages" }],
    ["unknown source", { ...good(), pages: [{ source: "nope", index: 0, rotate: 0 }] }, {}, { reason: "unknown-source", page: 0, source: "nope" }],
    ["duplicate source", { ...good(), sources: [sourceOf("s", source, 2), sourceOf("s", source, 2)] }, {}, { reason: "duplicate-source", source: "s" }],
    ["negative page index", { ...good(), pages: [{ source: "s", index: -1, rotate: 0 }] }, {}, { reason: "page-index", page: 0 }],
    ["rotation", { ...good(), pages: [{ source: "s", index: 0, rotate: 45 }] }, {}, { reason: "rotation", page: 0 }],
    ["blank size", { ...good(), pages: [{ blank: [1, 99999], rotate: 0 }] }, {}, { reason: "blank-size", page: 0 }],
    ["detached source bytes", { ...good(), sources: [sourceOf("s", new Uint8Array(0), 2)] }, {}, { reason: "source-bytes", source: "s" }],
    ["objects do not match the pages", { ...good(), objects: [[]] }, {}, { reason: "shape" }],
    ["objects of a page are not a list", { ...good(), objects: [{}, []] }, {}, { reason: "shape", page: 0 }],
    ["an invalid object", { ...good(), objects: [[], [{ ...text, size: 9999 }]] }, {}, { reason: "object", page: 1, objectId: "t", problems: ["size"] }],
    ["a mark among the objects", { ...good(), objects: [[{ id: "r", type: "redact", pageId: "p0", rect, color: "#000000" }], []] }, {}, { reason: "object", page: 0, objectId: "r", problems: ["mark"] }],
    ["a text object without its layout", { ...good(), objects: [[withoutLayout], []] }, {}, { reason: "layout", page: 0, objectId: "t" }],
    ["an image without its asset", { ...good(), objects: [[picture], []] }, {}, { reason: "asset", page: 0, objectId: "img", problems: ["missing"] }],
    ["marks are not a list", { ...good(), marks: {} }, {}, { reason: "shape" }],
    ["a mark on a page the job does not have", { ...good(), marks: [{ pageIndex: 2, rect, mode: "redact", objectId: "m" }] }, {}, { reason: "mark", objectId: "m", problems: ["pageIndex"] }],
    ["a mark without area", { ...good(), marks: [{ pageIndex: 0, rect: [10, 10, 10, 30], mode: "redact", objectId: "m" }] }, {}, { reason: "mark", page: 0, problems: ["rect"] }],
    ["a mark with an unknown mode", { ...good(), marks: [{ pageIndex: 0, rect, mode: "hide", objectId: "m" }] }, {}, { reason: "mark", problems: ["mode"] }],
    ["a mark with a bad colour", { ...good(), marks: [{ pageIndex: 0, rect, mode: "redact", color: "black", objectId: "m" }] }, {}, { reason: "mark", problems: ["color"] }],
    ["a mark with a bad cover", { ...good(), marks: [{ pageIndex: 0, rect, mode: "erase", cover: "paper", objectId: "m" }] }, {}, { reason: "mark", problems: ["cover"] }],
    ["a mark with a bad strength", { ...good(), marks: [{ pageIndex: 0, rect, mode: "blur", strength: 7, objectId: "m" }] }, {}, { reason: "mark", problems: ["strength"] }],
    ["a mark with a malformed seed", { ...good(), marks: [{ pageIndex: 0, rect, mode: "blur", seed: "12345", objectId: "m" }] }, {}, { reason: "mark", problems: ["seed"] }],
    ["eraseFallback", good(), { eraseFallback: "hope" }, { reason: "option", problems: ["eraseFallback"] }],
    ["redactPath", good(), { redactPath: "precise" }, { reason: "option", problems: ["redactPath"] }],
    ["rasterPages is not a list of page indices", good(), { rasterPages: [0.5] }, { reason: "option", problems: ["rasterPages"] }],
    ["rasterPages names a page the job does not have", good(), { rasterPages: [0, 2] }, { reason: "option", page: 2, problems: ["rasterPages"] }],
    ["onProgress is not a function", good(), { onProgress: "yes" }, { reason: "option", problems: ["onProgress"] }],
    ["now is not a date", good(), { now: "2026-11-20" }, { reason: "option", problems: ["now"] }],
    ["options is not an object", good(), "fast", { reason: "option", problems: ["options"] }]
  ];
  for (const [name, job, options, params] of cases) {
    const spy = spyEngines();
    const given = typeof options === "string" ? options : { ...options, engines: spy.engines };
    const error = await rejectsWith(buildOutput(job, pipelineEnv(), given), "PIPELINE_JOB_INVALID", params);
    assert.deepEqual(Object.keys(error.params), CODES.PIPELINE_JOB_INVALID, name);
    assert.deepEqual(spy.calls, [], `${name}: an engine ran`);
  }
  await rejectsWith(buildOutput(good(), null, {}), "PIPELINE_ENV_INVALID", { missing: "env" });
  await rejectsWith(buildOutput(good(), { fonts: async () => null }, {}), "PIPELINE_ENV_INVALID", { missing: "openPdf" });
});

test("what only the engines can see passes through with their own codes", async () => {
  const source = await makeTextPdf([{ lines: ["Một trang"] }]);
  const job = makeJob({ sources: [sourceOf("s", source, 1)], pages: [{ source: "s", index: 3, rotate: 0 }] });
  await rejectsWith(buildOutput(job, pipelineEnv(), {}), "EXPORT_JOB_INVALID", { reason: "page-index" });
  const wrongCount = makeJob({ sources: [sourceOf("s", source, 4)], pages: [{ source: "s", index: 0, rotate: 0 }] });
  await rejectsWith(buildOutput(wrongCount, pipelineEnv(), {}), "EXPORT_PAGE_COUNT_MISMATCH", { source: "s", writer: 1, viewer: 4 });
  const notPdf = makeJob({ sources: [sourceOf("s", new TextEncoder().encode("this is not a PDF file at all"), 1)], pages: [{ source: "s", index: 0, rotate: 0 }] });
  await rejectsWith(buildOutput(notPdf, pipelineEnv(), {}), "EXPORT_SOURCE_DAMAGED", { source: "s" });
  // a font that cannot be loaded
  const text = textBox({ id: "t", pageId: "p0", text: "Chữ", left: 50, top: 300 });
  const withText = makeJob({ sources: [sourceOf("s", source, 1)], pages: [{ source: "s", index: 0, rotate: 0 }], objects: [[text]] });
  const env = pipelineEnv({ fonts: async () => {
    throw new Error("offline");
  } });
  await rejectsWith(buildOutput(withText, env, {}), "EXPORT_FONT_UNAVAILABLE", { fontKey: "arimo-regular" });
});

// ---------------------------------------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------------------------------------

test("the signal cancels the job at every stage, and nothing is returned", async () => {
  const { job, plainRect } = await twoPageJob();
  job.objects[0] = [textBox({ id: "note", pageId: "p0", text: "Ghi chú", left: 72, top: 300 })];
  job.marks = [{ pageIndex: 0, rect: plainRect, mode: "redact", color: "#000000", objectId: "m" }];

  const already = new AbortController();
  already.abort();
  const idle = spyEngines();
  await rejectsWith(buildOutput(job, pipelineEnv(), { signal: already.signal, engines: idle.engines }), "CANCELLED");
  assert.deepEqual(idle.calls, []);

  const order = ["assembleDocument", "redactPdf", "drawOnDocument"];
  for (const stage of STAGES) {
    const controller = new AbortController();
    const spy = spyEngines();
    const seen = [];
    const run = buildOutput(job, pipelineEnv(), {
      signal: controller.signal,
      engines: spy.engines,
      onProgress: (fraction, code) => {
        seen.push(code);
        if (code === stage) controller.abort();
      }
    });
    await rejectsWith(run, "CANCELLED");
    assert.equal(seen.at(-1), stage, `the job went on after it was cancelled in ${stage}`);
    // no engine of a later stage was started
    const started = spy.calls.map((call) => call.name);
    assert.deepEqual(started, order.slice(0, Math.min(order.length, STAGES.indexOf(stage) + 1)), stage);
  }
});

// ---------------------------------------------------------------------------------------------------------
// the self-check
// ---------------------------------------------------------------------------------------------------------

test("the self-check refuses a redaction result that still has the text, and returns nothing", async () => {
  const { job, plainRect, vietRect } = await twoPageJob();
  job.objects[0] = [textBox({ id: "note", pageId: "p0", text: "Ghi chú", left: 72, top: 300 })];
  job.marks = [
    { pageIndex: 1, rect: vietRect, mode: "blur", strength: 1, seed: SEED_A, objectId: "b" },
    { pageIndex: 0, rect: plainRect, mode: "redact", color: "#000000", objectId: "m" }
  ];
  const rowsFor = (targets, outcome = "precise") => targets.map((target, index) => ({ index, pageIndex: target.pageIndex, mode: target.mode, outcome }));
  const pagesFor = (targets) => [...new Set(targets.map((target) => target.pageIndex))].sort().map((pageIndex) => ({ pageIndex, path: "precise", reasons: [], ok: true }));
  const lazy = (change = (result) => result) => async (bytes, targets) => change({ bytes, report: { pages: pagesFor(targets), targets: rowsFor(targets), warnings: [] } }, bytes, targets);
  const run = async (engines) => {
    const spy = spyEngines(engines);
    let result = null;
    let error = null;
    try {
      result = await buildOutput(job, pipelineEnv(), fixedOptions({ engines: spy.engines }));
    } catch (caught) {
      error = caught;
    }
    return { result, error, calls: spy.calls.map((call) => call.name) };
  };
  const refused = async (engines, check, page) => {
    const { result, error, calls } = await run(engines);
    assert.equal(result, null, `${check}: bytes were returned`);
    assert.equal(error?.code, "PIPELINE_SELF_CHECK_FAILED", String(error?.stack || error));
    assert.deepEqual(error.params, { check, page });
    return calls;
  };

  // an engine that says "done" and hands the bytes back untouched: caught BEFORE anything is drawn
  const calls = await refused({ redactPdf: lazy() }, "redaction-text", 1);
  assert.deepEqual(calls, ["assembleDocument", "redactPdf"]);
  // the same on the Vietnamese page only (the engine did its work on the other page)
  const { real } = spyEngines();
  const halfDone = async (bytes, targets, env) => {
    const done = await real.redactPdf(bytes, targets.filter((target) => target.pageIndex === 0), env);
    return { bytes: done.bytes, report: { pages: pagesFor(targets), targets: rowsFor(targets), warnings: [] } };
  };
  await refused({ redactPdf: halfDone }, "redaction-text", 2);

  // answers that do not fit the question
  await refused({ redactPdf: async () => null }, "redaction-result", 0);
  await refused({ redactPdf: lazy((result) => ({ ...result, bytes: new Uint8Array(0) })) }, "redaction-result", 0);
  await refused({ redactPdf: lazy((result) => ({ ...result, report: { ...result.report, targets: result.report.targets.slice(1) } })) }, "redaction-result", 0);
  await refused({ redactPdf: lazy((result, bytes, targets) => ({ ...result, report: { ...result.report, targets: rowsFor(targets, "cover-needed") } })) }, "redaction-result", 0);
  await refused({ redactPdf: lazy((result) => ({ ...result, report: { ...result.report, pages: result.report.pages.map((page) => ({ ...page, ok: false })) } })) }, "redaction-result", 0);
  await refused({ redactPdf: lazy((result) => ({ ...result, bytes: new TextEncoder().encode("not a PDF any more") })) }, "redaction-unreadable", 0);
  const onePage = await makeTextPdf([{ lines: ["Chỉ còn một trang"] }]);
  await refused({ redactPdf: lazy((result) => ({ ...result, bytes: onePage })) }, "redaction-page-count", 0);

  // the finished file
  await refused({ drawOnDocument: async () => ({ bytes: new TextEncoder().encode("%PDF-1.7 broken"), report: { warnings: [] } }) }, "output-unreadable", 0);
  await refused({ drawOnDocument: async () => ({ bytes: null, report: {} }) }, "output-unreadable", 0);
  await refused({ drawOnDocument: async () => ({ bytes: onePage, report: { warnings: [] } }) }, "output-page-count", 0);

  // control: the real engines pass
  const fine = await run({});
  assert.equal(fine.error, null, String(fine.error?.stack || fine.error));
  assert.ok(fine.result.bytes.length > 0);
});

test("the self-check also guards the one-pass export", async () => {
  const source = await makeTextPdf([{ lines: ["Một trang"] }, { lines: ["Trang hai"] }]);
  const job = makeJob({ sources: [sourceOf("s", source, 2)], pages: [{ source: "s", index: 0, rotate: 0 }, { source: "s", index: 1, rotate: 0 }] });
  const onePage = await makeTextPdf([{ lines: ["Chỉ còn một trang"] }]);
  await rejectsWith(buildOutput(job, pipelineEnv(), { engines: { assembleDocument: async () => ({ bytes: onePage, report: {} }) } }), "PIPELINE_SELF_CHECK_FAILED", { check: "output-page-count", page: 0 });
  await rejectsWith(buildOutput(job, pipelineEnv(), { engines: { assembleDocument: async () => ({ bytes: new Uint8Array([1, 2, 3]), report: {} }) } }), "PIPELINE_SELF_CHECK_FAILED", { check: "output-unreadable", page: 0 });
});

// ---------------------------------------------------------------------------------------------------------
// no state, no mutation
// ---------------------------------------------------------------------------------------------------------

test("no state between calls: two jobs interleaved give the files they give alone", async () => {
  const first = await twoPageJob();
  first.job.objects[0] = [textBox({ id: "note", pageId: "p0", text: "Công việc thứ nhất", left: 72, top: 300 })];
  first.job.marks = [
    { pageIndex: 0, rect: first.plainRect, mode: "redact", color: "#aa0000", objectId: "m1" },
    { pageIndex: 1, rect: first.vietRect, mode: "pixelate", strength: 1, seed: SEED_A, objectId: "b1" }
  ];
  const fixture = await unmeasurablePdf();
  const second = makeJob({
    sources: [sourceOf("u", fixture.bytes, 1)],
    pages: [{ source: "u", index: 0, rotate: 180 }, { blank: [200, 200], rotate: 0 }],
    objects: [[textBox({ id: "edit", pageId: "p0", text: "Công việc thứ hai", left: 300, top: 500, replaces: { rect: fixture.unmeasurableRect, cover: "#eeeeee", sourceText: "x" } })], everyObjectType("p1").objects.slice(0, 2)],
    marks: [{ pageIndex: 0, rect: fixture.unmeasurableRect, mode: "erase", cover: "#eeeeee", objectId: "edit" }]
  });
  const third = makeJob({ sources: [sourceOf("p", first.plain.bytes, 1)], pages: [{ source: "p", index: 0, rotate: 0 }] });
  const runs = [
    () => buildOutput(first.job, pipelineEnv(), fixedOptions()),
    () => buildOutput(second, pipelineEnv(), fixedOptions({ eraseFallback: "redact" })),
    () => buildOutput(third, pipelineEnv(), fixedOptions())
  ];
  const withoutTimings = (report) => ({ ...report, timings: null });
  const alone = [];
  for (const run of runs) alone.push(await run());
  const together = await Promise.all([runs[0](), runs[1](), runs[2](), runs[0]()]);
  for (const [index, expected] of [[0, alone[0]], [1, alone[1]], [2, alone[2]], [3, alone[0]]]) {
    assert.deepEqual(together[index].bytes, expected.bytes, `job ${index} differs when it runs next to others`);
    assert.deepEqual(withoutTimings(together[index].report), withoutTimings(expected.report));
  }
  // and after them, again alone
  const after = await runs[1]();
  assert.deepEqual(after.bytes, alone[1].bytes);
});

test("the job and its byte arrays are untouched after a run", async () => {
  const { job, plainRect, vietRect } = await twoPageJob();
  const drawn = everyObjectType("p1");
  job.objects = [[textBox({ id: "edit", pageId: "p0", text: "Dòng mới", left: plainRect[0], top: plainRect[3], replaces: { rect: plainRect, cover: "#ffffff", sourceText: "x" } })], [...drawn.objects, textBox({ id: "note", pageId: "p1", text: "Ghi chú", left: 60, top: 560 })]];
  job.assets = drawn.assets;
  job.marks = [
    { pageIndex: 1, rect: vietRect, mode: "blur", strength: 3, seed: SEED_B, objectId: "b" },
    { pageIndex: 0, rect: plainRect, mode: "erase", cover: "#ffffff", objectId: "edit" }
  ];
  job.now = new Date(Date.UTC(2026, 10, 20));
  const before = snapshotJob(job);
  deepFreeze(job); // a write to the job or to one of its objects throws from here on
  for (const options of [{}, { eraseFallback: "redact", rasterPages: [1] }, { redactPath: "raster", keepOutline: false, keepForms: false }]) {
    const { bytes } = await buildOutput(job, pipelineEnv(), { idSeed: new Uint8Array(16), ...options });
    assert.ok(bytes.length > 0);
    assert.deepEqual(job, before, `the job changed (${JSON.stringify(options)})`);
    for (const source of job.sources) assert.ok(source.bytes.byteLength > 0 && source.bytes.buffer.byteLength > 0, "a source buffer was detached");
    assert.ok(job.assets["asset-red"].bytes.byteLength > 0);
  }
  // the bytes that come back are not one of the job's arrays
  const plain = makeJob({ sources: job.sources.slice(0, 1), pages: [{ source: "plain", index: 0, rotate: 0 }] });
  const { bytes } = await buildOutput(plain, pipelineEnv(), {});
  assert.notEqual(bytes, plain.sources[0].bytes);
  assert.notEqual(bytes.buffer, plain.sources[0].bytes.buffer);
});

test("options reach the engines: outline, forms, attachments, producer, the trailer id and the noise source", async () => {
  const { job, vietRect } = await twoPageJob();
  job.marks = [{ pageIndex: 1, rect: vietRect, mode: "pixelate", strength: 1, objectId: "b" }];
  const spy = spyEngines();
  const random = () => 0.25;
  const idSeed = new Uint8Array(16).fill(0xab);
  const now = new Date(Date.UTC(2027, 0, 1));
  const { bytes } = await buildOutput(job, pipelineEnv(), {
    keepOutline: false, keepForms: false, keepAttachments: true, dropOrphanBookmarks: true, producer: "Trình chỉnh sửa thử nghiệm", now, idSeed, random, engines: spy.engines
  });
  const assembleOptions = spy.calls[0].args[1];
  assert.equal(assembleOptions.keepOutline, false);
  assert.equal(assembleOptions.keepForms, false);
  assert.equal(assembleOptions.keepAttachments, true);
  assert.equal(assembleOptions.dropOrphanBookmarks, true);
  assert.equal(assembleOptions.producer, "Trình chỉnh sửa thử nghiệm");
  assert.equal(assembleOptions.now, now);
  assert.equal(assembleOptions.idSeed, idSeed);
  assert.equal(spy.calls[1].args[2].random, random);
  assert.equal(typeof spy.calls[1].args[2].signal, "undefined");
  const facts = await fileFacts(bytes, { allowStructTree: true });
  assert.equal(facts.id, "AB".repeat(16));
  const loaded = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(loaded.getProducer(), "Trình chỉnh sửa thử nghiệm");
});

test("a listener that throws does not break the export", async () => {
  const source = await makeTextPdf([{ lines: ["Một trang"] }]);
  const job = makeJob({ sources: [sourceOf("s", source, 1)], pages: [{ source: "s", index: 0, rotate: 0 }] });
  const { bytes } = await buildOutput(job, pipelineEnv(), { onProgress: () => {
    throw new Error("the progress bar is gone");
  } });
  assert.ok(bytes.length > 0);
});

test("progress stays one rising fraction between 0 and 1, whatever an engine reports", async () => {
  const { job, plainRect } = await twoPageJob();
  job.objects[0] = [textBox({ id: "note", pageId: "p0", text: "Ghi chú", left: 72, top: 300 })];
  job.marks = [{ pageIndex: 0, rect: plainRect, mode: "redact", color: "#000000", objectId: "m" }];
  const spy = spyEngines();
  // engines that report backwards, beyond the ends and with things that are not numbers
  const noisy = (name, at) => async (...args) => {
    const options = args[at];
    for (const fraction of [0.9, 0.2, -3, 7, Number.NaN, "half", undefined, 0.5]) options.onProgress(fraction, "whatever");
    return spy.real[name](...args);
  };
  const progress = progressRecorder();
  const { bytes } = await buildOutput(job, pipelineEnv(), fixedOptions({
    onProgress: progress.onProgress,
    engines: { assembleDocument: noisy("assembleDocument", 1), redactPdf: noisy("redactPdf", 2), drawOnDocument: noisy("drawOnDocument", 2) }
  }));
  assert.ok(bytes.length > 0);
  progress.assertComplete(STAGES);
  for (const [fraction, stage] of progress.seen) {
    assert.ok(typeof fraction === "number" && fraction >= 0 && fraction <= 1, `fraction ${fraction}`);
    assert.ok(STAGES.includes(stage), `the stage code of an engine leaked: ${stage}`);
  }
  // each stage stays inside its own part of the scale
  const last = (stage) => Math.max(...progress.seen.filter((entry) => entry[1] === stage).map((entry) => entry[0]));
  assert.ok(last(STAGE_ASSEMBLE) <= 0.2 && last(STAGE_REDACT) <= 0.72 && last(STAGE_DRAW) <= 0.92, JSON.stringify(progress.seen));
});
