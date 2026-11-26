// redactPdf() end to end. For every kind of input the same four facts are proven on the OUTPUT, with tools that
// share no code with the remover: the target text is gone for pdf.js (text items), gone from the bytes (raw
// scan of every stream) and from unreachable objects (none exist), the neighbouring text is still there and
// extractable, and the region looks as the mode promises (a uniform box, an unreadable mosaic, untouched
// paper). The report must say which path was taken.
// The last section holds one test per defect of the independent review of this engine (pictures inside forms,
// soft masks, pages without marks, stream lengths, damaged pages, seeds, thin marks, attachments) and the test
// of previewRemoval(); what the fonts keep is tested in pdfRedactFontCleanup.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { canRender, canvasLib, closePdf, loadFont, openPdf, pageItems, pdfLib, pdfjs, squash, withPdf } from "./helpers/pdfTestKit.mjs";
import {
  A, blockRuns, boxOf, bytesOf, findOrphans, found, latin1, load, makePdf, openPdfDocument, pageContent, pageGeometries, pageTextOf, patchImages, rawPdf, redactEnv,
  regionDifference, regionOf, seededRandom, snap
} from "./helpers/pdfRedactKit.mjs";
import { type1Pdf } from "./helpers/pdfRedactFontKit.mjs";
import {
  actualTextPdf, annotatedFormPdf, invisibleTextPdf, kernedPdf, pictureUnderMarkPdf, plainTextPdf, predictorStreamPdf, rotatedCropPdf, sharedFormPdf,
  supersededRevisionPdf, taggedPdf, twoFontsPdf, unmeasurablePdf, vietnamesePdf
} from "./helpers/pdfRedactFixtures.mjs";
import { BLUR_DEFAULTS, CODES, LAYER_FONT_KEY, PDFJS_CONSTANTS, PROGRESS_STAGES, createBrowserRedactEnv, redactPdf } from "../src/pages/pdfEditor/engine/redact/index.js";
import * as engineApi from "../src/pages/pdfEditor/engine/redact/index.js";
import * as blurApi from "../src/pages/pdfEditor/engine/redact/blur.js";
import { CANCELLED, PdfEditorError, isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";

const needCanvas = { skip: !canRender && "no canvas binary on this platform" };
const MODES = ["redact", "pixelate", "blur", "erase"];
const BOX_COLOUR = "#1a2b3c";

// ---- every code that a report or an error of this suite carried (checked against CODES at the end)
const seenCodes = new Set();
function noteReport(report) {
  if (!report) return;
  for (const page of report.pages || []) for (const reason of page.reasons || []) seenCodes.add(reason.code);
  for (const target of report.targets || []) if (target.reason) seenCodes.add(target.reason.code);
  for (const warning of report.warnings || []) seenCodes.add(warning.code);
}
async function redact(bytes, targets, options) {
  const result = await redactPdf(bytes, targets, redactEnv(options));
  noteReport(result.report);
  return result;
}
async function refuses(promise, code) {
  let error = null;
  try {
    await promise;
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, `expected ${code}, but the call resolved`);
  assert.ok(isPdfEditorError(error), `expected a PdfEditorError, got ${error?.stack || error}`);
  assert.equal(error.code, code);
  seenCodes.add(error.code);
  noteReport(error.report);
  return error;
}

/** What pdf.js extracts from a page: its text items and their text without white space. */
async function extracted(bytes, pageIndex = 0) {
  return withPdf(bytes, async (doc) => {
    const items = await pageItems(await doc.getPage(pageIndex + 1));
    return { items, text: squash(items.map((item) => item.str).join("")) };
  });
}

const hexDistance = (a, b) => Math.max(...[1, 3, 5].map((at) => Math.abs(parseInt(a.slice(at, at + 2), 16) - parseInt(b.slice(at, at + 2), 16))));
/** A mark as the editor passes it: a box has its colour, a mosaic its strength and the seed kept with the mark. */
const SEED = "5eed5eed5eed5eed5eed5eed5eed5eed";
const target = (rect, mode, pageIndex = 0) => ({ pageIndex, rect, mode, ...(mode === "redact" ? { color: BOX_COLOUR } : {}), ...(mode === "pixelate" || mode === "blur" ? { strength: 1, seed: SEED } : {}) });

/**
 * The checks every case shares.
 *   input / output   bytes;  rects: the targets of page `pageIndex`;  mode;  path: what the report must say
 *   gone             strings pdf.js must no longer extract;  kept: strings it must still extract
 *   goneRaw          strings that must be in no byte of the output;  inked: false when the target shows no ink
 *   paper            the colour under the text ("#ffffff"); null when the text lies on a picture
 */
async function assertRedacted({ input, output, report, rects, mode, path, gone, kept, goneRaw, pageIndex = 0, inked = true, paper = "#ffffff" }) {
  // the report
  const page = report.pages.find((entry) => entry.pageIndex === pageIndex);
  assert.equal(page.path, path, JSON.stringify(page.reasons));
  assert.equal(page.ok, true);
  if (path === "precise") assert.deepEqual(page.reasons, [], "a precise page gives no reason");
  else assert.ok(page.reasons.length > 0, "another path names its reason");
  for (const row of report.targets.filter((entry) => entry.pageIndex === pageIndex)) assert.equal(row.outcome, path === "raster" ? "raster" : "precise");
  // pdf.js
  const after = await extracted(output, pageIndex);
  for (const text of gone) assert.ok(!after.text.includes(squash(text)), `pdf.js still extracts "${text}"`);
  for (const text of kept) assert.ok(after.text.includes(squash(text)), `pdf.js lost "${text}" (has: ${after.text})`);
  for (const rect of rects) {
    for (const item of after.items) {
      const centre = [(item.box[0] + item.box[2]) / 2, (item.box[1] + item.box[3]) / 2];
      assert.ok(!(centre[0] > rect[0] && centre[0] < rect[2] && centre[1] > rect[1] && centre[1] < rect[3]), `a text item still sits in the target: "${item.str}"`);
    }
  }
  // the bytes, and objects nothing points at
  for (const text of goneRaw) assert.equal(found(output, text), false, `"${text}" is still in the bytes`);
  assert.deepEqual(await findOrphans(output), [], "unreachable objects in the output");
  // the pixels
  if (!canRender) return;
  for (const rect of rects) {
    const before = await regionOf(input, pageIndex, rect);
    const now = await regionOf(output, pageIndex, rect, { tolerance: path === "raster" ? 24 : 6 });
    if (mode === "redact") {
      assert.equal(now.uniform, true, `the box is not uniform (range ${now.range})`);
      assert.ok(hexDistance(now.mean, BOX_COLOUR) <= (path === "raster" ? 8 : 1), `box colour ${now.mean}`);
    } else if (mode === "erase") {
      assert.equal(now.uniform, true, `erased region is not plain paper (range ${now.range})`);
      assert.equal(now.mean, paper);
    } else {
      // a mosaic: what made the text readable (dark strokes, thousands of sharp edges) is gone
      if (inked) assert.ok(before.edges > 40 && before.dark > 40, `the fixture shows no ink in the target (${before.edges} edges)`);
      assert.ok(now.edges <= Math.max(12, before.edges * 0.25), `edges ${before.edges} -> ${now.edges}`);
      // on white paper the blocks are light greys: no dark pixel is left (over a picture a block may be darker
      // than mid grey by itself, depending on the noise: that says nothing there)
      if (paper === "#ffffff") assert.ok(now.dark <= before.dark * 0.1, `dark pixels ${before.dark} -> ${now.dark}`);
    }
  }
  // (rewritten after the review. This place asserted that the mosaic of an inked region is NOT one flat
  // colour: blocks small enough to show the shape of a word are blocks a number can be read out of. Now: a
  // block is at least twice as high as the mark, so across the line there are never more than two of them,
  // and the mosaic of a short mark may well be one flat colour)
  if ((mode === "pixelate" || mode === "blur") && path === "precise") {
    const pictures = await patchImages(output, pageIndex);
    assert.ok(pictures.length >= rects.length, "one stored picture per mosaic");
    if (mode === "pixelate") for (const picture of pictures) assert.ok(Math.min(blockRuns(picture).rows.length, blockRuns(picture).columns.length) <= 2, "more than two rows of blocks across one line");
  }
}

// ---------------------------------------------------------------------------------------------------------
// the inputs of the brief, each in all four modes

for (const mode of MODES) {
  test(`plain text: ${mode}`, needCanvas, async () => {
    const fixture = await plainTextPdf();
    const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "precise", gone: [fixture.secret], kept: fixture.kept, goneRaw: [fixture.secret] });
    assert.equal(report.pages[0].stats.glyphsRemoved, fixture.secret.length);
    // the neighbours did not move: same text items at the same place, apart from the line that was cut
    const before = await extracted(fixture.bytes);
    const after = await extracted(bytes);
    for (const line of ["Invoice for Alice Example", "Last line stays untouched"]) {
      const a = before.items.find((item) => item.str === line);
      const b = after.items.find((item) => item.str === line);
      assert.deepEqual(b.box, a.box, line);
    }
  });

  test(`Vietnamese text in an embedded subset font: ${mode}`, needCanvas, async () => {
    const fixture = await vietnamesePdf();
    const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "precise", gone: [fixture.secret], kept: fixture.kept, goneRaw: [] });
    // the stream holds glyph ids, which a raw scan cannot read: count them instead. Exactly the glyphs of the
    // target are missing from the only content stream of the page (and nothing unreachable is left, see above)
    const codes = (doc) => [...pageContent(doc).matchAll(/<([0-9A-Fa-f\s]+)>/g)].reduce((sum, match) => sum + match[1].replace(/\s/g, "").length / 4, 0);
    assert.equal(codes(await load(bytes)), codes(await load(fixture.bytes)) - fixture.secret.length);
  });

  test(`a partial word inside a kerned TJ array: ${mode}`, needCanvas, async () => {
    const fixture = await kernedPdf();
    const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.3 });
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "precise", gone: [fixture.secret], kept: fixture.kept, goneRaw: [fixture.secret, fixture.whole] });
    // the kerning of the untouched parts is still in the array, the hole is one adjustment
    assert.match(pageContent(await load(bytes)), /\[\(Ref\) -15 \(erence KERN\) 20 \(ED-\) -\d+(\.\d+)? \(-X\) -25 \(YZ tail\) 10 \( stays\)\] TJ/);
    assert.deepEqual((await extracted(bytes)).items.find((item) => item.str.includes("tail")).box.slice(1), (await extracted(fixture.bytes)).items[0].box.slice(1));
  });

  test(`two fonts on one line: ${mode}`, needCanvas, async () => {
    const fixture = await twoFontsPdf();
    const rect = await boxOf(fixture.bytes, fixture.target);
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "precise", gone: [fixture.secret, "lead", "courier tail"], kept: fixture.kept, goneRaw: [fixture.secret] });
    const before = await snap(fixture.bytes);
    const after = await snap(bytes);
    const tail = (snapshot) => snapshot.glyphs.filter((glyph) => glyph.unicode === "u").map((glyph) => glyph.origin[0].toFixed(3));
    assert.deepEqual(tail(after), tail(before), "the rest of the line (third font) kept its place");
  });

  test(`a page with /Rotate and a CropBox: ${mode}`, needCanvas, async () => {
    const fixture = await rotatedCropPdf();
    const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "precise", gone: [fixture.secret], kept: fixture.kept, goneRaw: [fixture.secret] });
    assert.deepEqual(await pageGeometries(bytes), [{ view: [40, 50, 500, 700], rotate: 90, userUnit: 1 }]);
  });

  test(`text inside a Form XObject shared by two pages: ${mode}`, needCanvas, async () => {
    const fixture = await sharedFormPdf();
    const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "precise", gone: [fixture.secret], kept: fixture.kept, goneRaw: [] });
    assert.equal(report.pages[0].stats.formsCloned, 1);
    // the other page still draws the ORIGINAL form: it keeps the text, so the string must still be in the file
    assert.ok((await pageTextOf(bytes, 1)).includes(squash(fixture.secret)), "page 2 lost the text of the shared form");
    assert.equal(found(bytes, fixture.secret), true);
    // ... in the form of page 2 only: the private copy page 1 draws now does not hold it
    const doc = await load(bytes);
    const formOf = (pageIndex) => {
      const xobjects = A.get(A.get(doc.getPage(pageIndex).node, "Resources"), "XObject");
      const forms = xobjects.keys().map((key) => xobjects.lookup(key)).filter((stream) => A.getName(stream.dict, "Subtype") === "Form");
      return forms.map((stream) => latin1(A.streamBytes(stream)));
    };
    assert.deepEqual(formOf(0).map((stream) => stream.includes("SHARED-FORM-TEXT")), [false]);
    assert.deepEqual(formOf(1).map((stream) => stream.includes("SHARED-FORM-TEXT")), [true]);
    assert.deepEqual(await pageGeometries(bytes), await pageGeometries(fixture.bytes));
  });

  test(`an /ActualText span: ${mode}`, needCanvas, async () => {
    const fixture = await actualTextPdf();
    const rects = [await boxOf(fixture.bytes, fixture.targets[0], { pad: 0.3 }), await boxOf(fixture.bytes, fixture.targets[1], { pad: 0.5 })];
    for (const text of [...fixture.goneRaw, ...fixture.keptRaw]) assert.equal(found(fixture.bytes, text), true, `fixture: ${text}`);
    const { bytes, report } = await redact(fixture.bytes, rects.map((rect) => target(rect, mode)));
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects, mode, path: "precise", gone: fixture.gone, kept: fixture.kept, goneRaw: fixture.goneRaw });
    // a span that lost one glyph lost its /ActualText (inline and through /Properties); an untouched span keeps it
    assert.equal(report.pages[0].stats.markedContentStripped, 2);
    for (const text of fixture.keptRaw) assert.equal(found(bytes, text), true, text);
  });

  test(`invisible text (text rendering mode 3): ${mode}`, needCanvas, async () => {
    const fixture = await invisibleTextPdf();
    const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
    assert.ok((await extracted(fixture.bytes)).text.includes(squash(fixture.secret)), "fixture: pdf.js extracts the invisible line");
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "precise", gone: [fixture.secret], kept: fixture.kept, goneRaw: ["INVISIBLE-SECRET-5521"], inked: false });
  });

  test(`a picture under the mark: ${mode}`, needCanvas, async () => {
    const fixture = await pictureUnderMarkPdf();
    const rect = await boxOf(fixture.bytes, fixture.target, { pad: 0.5 });
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    if (mode === "erase") {
      // only the glyphs go: the page stays vector and the picture under them is untouched paper
      assert.equal(report.pages[0].path, "precise");
      assert.equal(report.targets[0].outcome, "precise");
      const text = (await extracted(bytes)).text;
      assert.ok(!text.includes(squash(fixture.secret)) && fixture.kept.every((line) => text.includes(squash(line))));
      assert.equal(found(bytes, fixture.whole), false);
      assert.deepEqual(await findOrphans(bytes), []);
      const bare = await pictureUnderMarkPdf({ caption: false });
      assert.ok(regionDifference(await regionOf(bytes, 0, rect), await regionOf(bare.bytes, 0, rect)) <= 2, "the picture under the erased caption changed");
      assert.ok((await regionOf(bytes, 0, rect)).colours.size > 4, "the picture is still there");
      return;
    }
    // a picture that only reaches into the mark cannot be cut: the page becomes a picture itself
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "raster", gone: [fixture.secret], kept: fixture.kept, goneRaw: [fixture.whole], paper: null });
    assert.deepEqual(report.pages[0].reasons, [{ code: "REDACT_IMAGE_IN_TARGET", params: { page: 1, name: "Im" } }]);
    // the rest of the page is still text: an invisible layer in the bundled face, where the lines were
    const before = await extracted(fixture.bytes);
    const after = await extracted(bytes);
    for (const line of fixture.kept) {
      const a = before.items.find((item) => item.str === line);
      const b = after.items.find((item) => squash(item.str) === squash(line));
      assert.ok(b, `no text item for "${line}"`);
      for (let k = 0; k < 4; k++) assert.ok(Math.abs(a.box[k] - b.box[k]) < 2.5, `"${line}" moved: ${a.box} -> ${b.box}`);
    }
    const layer = await snap(bytes);
    assert.ok(layer.glyphs.length > 40 && layer.glyphs.every((glyph) => glyph.invisible), "the layer must be drawn in rendering mode 3");
    assert.ok(report.pages[0].stats.layer.fragments > 5);
    assert.deepEqual(await pageGeometries(bytes), await pageGeometries(fixture.bytes));
    // nothing but the picture and the layer font is left on the page
    const doc = await load(bytes);
    const resources = A.get(doc.getPage(0).node, "Resources");
    assert.deepEqual(A.get(resources, "XObject").keys().map((key) => key.decodeText()), ["RPage"]);
    assert.deepEqual(A.get(resources, "Font").keys().map((key) => key.decodeText()), ["RLayer"]);
  });

  test(`an input with a superseded revision: ${mode}`, needCanvas, async () => {
    const fixture = await supersededRevisionPdf();
    // the first revision is invisible to pdf.js and still in the bytes
    assert.ok(!(await extracted(fixture.bytes)).text.includes(squash(fixture.superseded)));
    assert.equal(found(fixture.bytes, fixture.superseded), true);
    const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
    const { bytes, report } = await redact(fixture.bytes, [target(rect, mode)]);
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [rect], mode, path: "precise", gone: [fixture.secret], kept: fixture.kept, goneRaw: [fixture.secret, fixture.superseded] });
    assert.equal(latin1(bytes).split("%%EOF").length - 1, 1, "the output is one revision");
  });
}

test("an annotation and a form field under the mark: removed, values cleared, others kept", needCanvas, async () => {
  for (const mode of ["redact", "pixelate"]) {
    const fixture = await annotatedFormPdf({ xfa: true });
    for (const text of [...fixture.goneRaw, ...fixture.keptRaw, "XFA-COPY-OF-VALUES"]) assert.equal(found(fixture.bytes, text), true, `fixture: ${text}`);
    const { bytes, report } = await redact(fixture.bytes, fixture.targets.map((rect) => target(rect, mode)));
    // the widget rectangle has no page text in it: only the first target has neighbours to speak of
    await assertRedacted({ input: fixture.bytes, output: bytes, report, rects: [fixture.targets[0]], mode, path: "precise", gone: [fixture.secret], kept: fixture.kept, goneRaw: [...fixture.goneRaw, "XFA-COPY-OF-VALUES"] });
    for (const text of fixture.keptRaw) assert.equal(found(bytes, text), true, `${text} must stay`);
    assert.deepEqual(report.pages[0].stats.annotationsRemoved, 3); // the note and the two widgets
    assert.deepEqual([report.pages[0].stats.fieldsRemoved, report.pages[0].stats.fieldsCleared], [1, 1]);
    // "fullName" had its only widget under the mark: the field is gone. "contractNo" keeps a widget on
    // page 2: the field stays, EMPTY, and the caller is told. "keptField" is untouched.
    assert.deepEqual(report.warnings, [{ code: "REDACT_FIELD_VALUE_CLEARED", params: { page: 1, field: "contractNo", widgets: 1 } }, { code: "REDACT_XFA_REMOVED", params: {} }]);
    const form = (await pdfLib.PDFDocument.load(bytes)).getForm();
    assert.deepEqual(form.getFields().map((field) => [field.getName(), field.getText() ?? null]), [["keptField", "KEPT-FIELD-VALUE"], ["contractNo", null]]);
    const doc = await load(bytes);
    assert.deepEqual(A.get(doc.getPage(0).node, "Annots").asArray().map((ref) => A.getName(doc.context.lookup(ref), "Subtype")).sort(), ["Link", "Widget"]);
    // the widget of the emptied field on page 2 shows nothing any more
    const second = await regionOf(bytes, 1, [74, 702, 270, 722]);
    assert.equal(second.dark, 0, "page 2 still shows the value of the cleared field");
  }
});

test("erase takes glyphs only: annotations and form fields under it stay", needCanvas, async () => {
  const fixture = await annotatedFormPdf();
  const { bytes, report } = await redact(fixture.bytes, fixture.targets.map((rect) => target(rect, "erase")));
  assert.deepEqual(report.targets.map((row) => row.outcome), ["precise", "precise"]);
  assert.ok(!(await extracted(bytes)).text.includes(squash(fixture.secret)));
  for (const text of [...fixture.goneRaw, ...fixture.keptRaw]) assert.equal(found(bytes, text), true, `${text} belongs to an annotation: erase must not touch it`);
  assert.equal((await pdfLib.PDFDocument.load(bytes)).getForm().getFields().length, 3);
  assert.deepEqual(report.warnings, []);
});

// ---------------------------------------------------------------------------------------------------------
// erase: precise or "cover-needed", never the reason for a picture

test("an erase target that cannot be removed precisely reports cover-needed and does not rasterise", async () => {
  const fixture = await unmeasurablePdf();
  const { bytes, report } = await redact(fixture.bytes, [target(fixture.unmeasurableRect, "erase")]);
  assert.deepEqual(report.pages, [{ pageIndex: 0, path: "untouched", reasons: [{ code: "REDACT_UNMEASURABLE_TEXT", params: { page: 1, font: "MS-Gothic" } }], targets: 1, ok: true }]);
  assert.deepEqual(report.targets, [{ index: 0, pageIndex: 0, mode: "erase", outcome: "cover-needed", reason: { code: "REDACT_UNMEASURABLE_TEXT", params: { page: 1, font: "MS-Gothic" } } }]);
  assert.equal(bytes, fixture.bytes, "nothing changed: the input is returned as it is");
  assert.equal(report.rasterPages, 0);
});

test("erase next to a redaction: the redaction stays precise, the erase that fails needs a cover", needCanvas, async () => {
  const fixture = await unmeasurablePdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  const other = await boxOf(fixture.bytes, "another plain line", { pad: 0.5 });
  const { bytes, report } = await redact(fixture.bytes, [target(fixture.unmeasurableRect, "erase"), target(rect, "redact"), target(other, "erase")]);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual(report.targets.map((row) => row.outcome), ["cover-needed", "precise", "precise"]);
  assert.equal(report.targets[0].reason.code, "REDACT_UNMEASURABLE_TEXT");
  const text = (await extracted(bytes)).text;
  assert.ok(!text.includes(squash(fixture.secret)) && !text.includes("anotherplainline"));
  // the line that needs a cover is still there, exactly as it was
  const before = await snap(fixture.bytes);
  const after = await snap(bytes);
  assert.deepEqual(after.glyphs.slice(0, 4).map((glyph) => [glyph.unicode, glyph.origin]), before.glyphs.slice(0, 4).map((glyph) => [glyph.unicode, glyph.origin]));
  assert.deepEqual(await findOrphans(bytes), []);
});

test("erase on a page that is rasterised for a redaction is satisfied by the picture", needCanvas, async () => {
  const fixture = await unmeasurablePdf();
  const line = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  const other = await boxOf(fixture.bytes, "another plain line", { pad: 0.5 });
  const { bytes, report } = await redact(fixture.bytes, [target(fixture.unmeasurableRect, "redact"), { pageIndex: 0, rect: line, mode: "erase", color: "#ffee00" }, { pageIndex: 0, rect: other, mode: "erase" }]);
  assert.equal(report.pages[0].path, "raster");
  assert.deepEqual(report.pages[0].reasons.map((reason) => reason.code), ["REDACT_UNMEASURABLE_TEXT"]);
  assert.deepEqual(report.targets.map((row) => row.outcome), ["raster", "raster", "raster"]);
  // the pixels of the old lines are painted over: with the cover colour that was given, or with the paper
  const covered = await regionOf(bytes, 0, line, { tolerance: 16 });
  assert.ok(covered.uniform && hexDistance(covered.mean, "#ffee00") <= 8, `cover ${covered.mean}`);
  const sampled = await regionOf(bytes, 0, other, { tolerance: 16 });
  assert.ok(sampled.uniform && hexDistance(sampled.mean, "#ffffff") <= 4, `sampled cover ${sampled.mean}`);
  // and their glyphs are not in the text layer (" here" was not part of the erased line box)
  assert.equal((await extracted(bytes)).text, "here");
  assert.deepEqual(await findOrphans(bytes), []);
});

// ---------------------------------------------------------------------------------------------------------
// the gate: nothing leaves without the final verification

test("a forced verification failure raises REDACT_VERIFICATION_FAILED and returns nothing", needCanvas, async () => {
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  // an env whose pdf.js shows the INPUT whenever it is asked to open an output: every check must see the
  // text that should be gone
  let calls = 0;
  const lying = redactEnv({ openPdf: (bytes, options) => openPdf((calls++ === 0 ? bytes : fixture.bytes), options) });
  let result = "nothing";
  const error = await refuses((async () => {
    result = await redactPdf(fixture.bytes, [target(rect, "redact")], lying);
  })(), "REDACT_VERIFICATION_FAILED");
  assert.equal(result, "nothing");
  assert.deepEqual(error.params, { page: 1, check: "G1-removal" });
  // the report travels with the error: the page first fell back to a picture, then failed for good
  assert.equal(error.report.pages[0].path, "raster");
  assert.equal(error.report.pages[0].ok, false);
  assert.deepEqual(error.report.pages[0].reasons, [{ code: "REDACT_GLYPHS_REMAIN", params: { page: 1, count: fixture.secret.length } }]);
  assert.ok(error.report.pages[0].verification.failures.length > 0);
  // a report never repeats text of the document
  assert.ok(!JSON.stringify(error.report).includes("PLAIN-SECRET"), "the report leaks the removed text");
  assert.ok(calls >= 3, "candidate and final output were both opened");
});

test("the verifier's findings decide the path: lost text and a surviving string send the page to the raster path", needCanvas, async () => {
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  // G2: the candidate (second document that is opened) is replaced by one in which a line far away is missing
  const { bytes: damaged } = await makePdf([{ content: "BT /F1 12 Tf 14 TL 72 700 Td (Invoice for Alice Example) Tj T* (Account ) Tj ET" }]);
  let calls = 0;
  let outcome = await redact(fixture.bytes, [target(rect, "redact")], { openPdf: (bytes, options) => openPdf(calls++ === 1 ? damaged : bytes, options) });
  assert.equal(outcome.report.pages[0].path, "raster");
  assert.equal(outcome.report.pages[0].reasons[0].code, "REDACT_TEXT_DISTURBED");
  assert.ok(outcome.report.pages[0].reasons[0].params.lost > 10);
  assert.ok((await extracted(outcome.bytes)).text.includes("Lastlinestaysuntouched"), "the final output is built from the original, not from the damaged candidate");
  // G3: the glyphs of the candidate are right, but its text content still spells the removed string
  calls = 0;
  const original = await openPdf(fixture.bytes);
  const originalText = await (await original.getPage(1)).getTextContent();
  await closePdf(original);
  outcome = await redact(fixture.bytes, [target(rect, "redact")], {
    openPdf: async (bytes, options) => {
      const doc = await openPdf(bytes, options);
      if (calls++ !== 1) return doc;
      return new Proxy(doc, {
        get(object, key) {
          if (key !== "getPage") return typeof object[key] === "function" ? object[key].bind(object) : object[key];
          return async (number) => {
            const page = await object.getPage(number);
            return new Proxy(page, { get: (inner, name) => (name === "getTextContent" ? async () => originalText : typeof inner[name] === "function" ? inner[name].bind(inner) : inner[name]) });
          };
        }
      });
    }
  });
  assert.equal(outcome.report.pages[0].path, "raster");
  assert.deepEqual(outcome.report.pages[0].reasons, [{ code: "REDACT_STRING_REMAINS", params: { page: 1, count: 1 } }]);
  assert.ok(!(await extracted(outcome.bytes)).text.includes(squash(fixture.secret)));
});

test("results are deterministic with an injected random source", needCanvas, async () => {
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  const other = await boxOf(fixture.bytes, "Alice Example", { pad: 0.5 });
  const targets = [{ pageIndex: 0, rect, mode: "pixelate", strength: 2 }, { pageIndex: 0, rect: other, mode: "blur", strength: 1 }];
  for (const path of ["hybrid", "raster"]) {
    const a = await redact(fixture.bytes, targets, { random: seededRandom(11), path });
    const b = await redact(fixture.bytes, targets, { random: seededRandom(11), path });
    const c = await redact(fixture.bytes, targets, { random: seededRandom(12), path });
    assert.equal(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)), 0, `${path}: same seed, different bytes`);
    assert.notEqual(Buffer.compare(Buffer.from(a.bytes), Buffer.from(c.bytes)), 0, `${path}: the noise does not depend on the random source`);
    assert.equal(a.report.pages[0].path, path === "raster" ? "raster" : "precise");
  }
  // without an injected source the platform CSPRNG is used: two runs differ
  const first = await redactPdf(fixture.bytes, targets, redactEnv({ random: undefined }));
  const second = await redactPdf(fixture.bytes, targets, redactEnv({ random: undefined }));
  assert.notEqual(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)), 0);
});

test("strength 1, 2, 3: the block follows the measured rule, and stronger means larger blocks", needCanvas, async () => {
  // (rewritten after the review: the test pinned blocks of half the height of the mark, the rule the reviewer's
  // attack read numbers out of. The figures behind the rule that is pinned now are in the header of blur.js)
  assert.deepEqual(BLUR_DEFAULTS, { blockRatio: 2, emRatio: 2.25, minBlockPt: 12, levels: 8, noise: 24, smoothRatio: 0.5, strengths: [1, 2, 3] });
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, "Account PLAIN-SECRET-4711 is due", { pad: 1 });
  const pxPerPt = 150 / 72; // the resolution of the stored picture (env.patchDpi)
  const edges = [];
  for (const strength of BLUR_DEFAULTS.strengths) {
    const { bytes } = await redact(fixture.bytes, [{ pageIndex: 0, rect, mode: "pixelate", strength }], { random: seededRandom(3) });
    // the picture as it is stored (lossless): its blocks can be measured to the pixel
    const [picture] = await patchImages(bytes);
    assert.ok(Math.abs(picture.height - (rect[3] - rect[1]) * pxPerPt) <= 2 && Math.abs(picture.width - (rect[2] - rect[0]) * pxPerPt) <= 2, "the picture is the mark");
    // block = the largest of 12 pt, twice the height of the mark, 2.25 x the font size (12 pt), times the strength
    const edge = Math.round(Math.max(12 * pxPerPt, picture.height * 2, 2.25 * 12 * pxPerPt) * strength);
    edges.push(edge);
    const { columns, rows } = blockRuns(picture);
    // twice the height: never more than two rows of blocks, and at most one boundary every `edge` pixels
    assert.ok(rows.length <= 2, `strength ${strength}: ${rows.length} rows of blocks`);
    assert.ok(columns.length <= Math.ceil(picture.width / edge) + 1, `strength ${strength}: blocks ${columns}`);
    // two boundaries are a whole number of blocks apart (neighbours of one level run together)
    for (const run of columns.slice(1, -1)) assert.equal(run % edge, 0, `strength ${strength}: a block of ${run} px between two others (the edge is ${edge})`);
    // 8 levels per channel, the same on the three channels (black text on white paper)
    for (let i = 0; i < picture.rgb.length; i += 3) {
      assert.ok([0, 36, 73, 109, 146, 182, 219, 255].includes(picture.rgb[i]) && picture.rgb[i + 1] === picture.rgb[i] && picture.rgb[i + 2] === picture.rgb[i], `a pixel of (${picture.rgb.subarray(i, i + 3)})`);
    }
    if (strength === 1) assert.ok(columns.length >= 3, `the fixture shows several blocks at strength 1 (${columns})`);
  }
  // one line of 12 pt text with a point around it: about 31 pt = 64 px at strength 1 (the reviewed rule: 25 px)
  assert.ok(edges[0] >= 56 && edges[0] <= 70 && edges[1] >= 2 * edges[0] - 2 && edges[2] >= 3 * edges[0] - 3, `blocks of ${edges} px`);
});

// ---------------------------------------------------------------------------------------------------------
// paths, fallback reasons and warnings

test("fallback reasons: what the precise path refuses becomes a picture, with the reason in the report", needCanvas, async () => {
  const line = "BT /F1 12 Tf 72 700 Td (target text SECRET-CODE-11) Tj 0 -60 Td (kept line below) Tj ET";
  const rect = [70, 695, 260, 714];
  const pattern = (ctx, refs, fonts) => ({ Font: fonts, Pattern: { P1: ctx.register(ctx.stream(Buffer.from("BT /F1 8 Tf 0 0 Td (pattern text) Tj ET"), { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 50, 20], XStep: 50, YStep: 20, Resources: { Font: fonts } })) } });
  const cases = [
    ["REDACT_VECTOR_IN_TARGET", { page: 1, curves: 1, lines: 0 }, { content: `${line} 60 690 m 100 730 200 600 300 705 c S` }],
    ["REDACT_PIXELS_REMAIN", null, { content: `${line} 0.5 w 60 705 m 300 705 l S` }],
    ["REDACT_TEXT_AS_CLIP", { page: 1 }, { content: line.replace("72 700 Td", "7 Tr 72 700 Td") }],
    ["REDACT_TEXT_IN_SUBCONTENT", { page: 1, where: "pattern" }, { content: `${line} /Pattern cs /P1 scn 300 300 100 100 re f`, resources: pattern }],
    ["REDACT_CONTENT_NOT_UNDERSTOOD", { page: 1, detail: "unknown-operator" }, { content: `${line} 1 2 frobnicate` }]
  ];
  for (const [code, params, page] of cases) {
    const { bytes: input } = await makePdf([page]);
    const { bytes, report } = await redact(input, [target(rect, "redact")]);
    assert.deepEqual(report.pages.map((entry) => [entry.path, entry.reasons.map((reason) => reason.code)]), [["raster", [code]]], code);
    if (params) assert.deepEqual(report.pages[0].reasons[0].params, params);
    else assert.ok(report.pages[0].reasons[0].params.outliers > 100 && report.pages[0].reasons[0].params.pixels > 1000);
    const text = (await extracted(bytes)).text;
    assert.ok(!text.includes("SECRET-CODE-11"), code);
    if (code !== "REDACT_TEXT_AS_CLIP") assert.ok(text.includes("keptlinebelow"), `${code}: the text layer lost the kept line (${text})`);
    assert.equal(found(bytes, "SECRET-CODE-11"), false, code);
    const box = await regionOf(bytes, 0, rect, { tolerance: 24 });
    assert.ok(box.uniform && hexDistance(box.mean, BOX_COLOUR) <= 8, `${code}: ${box.mean}`);
  }
  // a stream the library cannot decode
  const fixture = await predictorStreamPdf();
  assert.ok((await extracted(fixture.bytes)).text.includes(squash(fixture.secret)), "fixture: pdf.js reads the predictor stream");
  const { report } = await redact(fixture.bytes, [target(await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 }), "redact")]);
  assert.deepEqual(report.pages[0].reasons, [{ code: "REDACT_STREAM_NOT_DECODABLE", params: { page: 1 } }]);
});

test("path options: raster forces pictures (but not for erase), precise refuses instead of rasterising", needCanvas, async () => {
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  const forced = await redact(fixture.bytes, [target(rect, "redact")], { path: "raster" });
  assert.deepEqual(forced.report.pages[0].reasons, [{ code: "REDACT_RASTER_FORCED", params: { page: 1 } }]);
  assert.equal(forced.report.rasterPages, 1);
  const erased = await redact(fixture.bytes, [target(rect, "erase")], { path: "raster" });
  assert.equal(erased.report.pages[0].path, "precise");
  const picture = await pictureUnderMarkPdf();
  const error = await refuses(redactPdf(picture.bytes, [target(await boxOf(picture.bytes, picture.target), "redact")], redactEnv({ path: "precise" })), "REDACT_VERIFICATION_FAILED");
  assert.deepEqual(error.params, { page: 1, check: "precise-only" });
  // paint: false leaves the region blank (and verified as blank)
  const blank = await redact(fixture.bytes, [target(rect, "redact")], { paint: false });
  const region = await regionOf(blank.bytes, 0, rect);
  assert.ok(region.uniform && region.mean === "#ffffff");
});

test("a document the PDF library cannot edit: every page becomes a picture; erase alone changes nothing", needCanvas, async () => {
  const { bytes: good } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (page one NOEDIT-SECRET-1) Tj ET" }, { content: "BT /F1 12 Tf 72 700 Td (page two text) Tj ET" }]);
  // the second page dictionary loses its /Type (same length, so every offset stays valid): pdf.js still
  // shows two pages, the library counts one
  const text = latin1(good);
  const at = [...text.matchAll(/\/Type \/Page(?!s)/g)][1].index;
  const input = new Uint8Array(Buffer.from(`${text.slice(0, at)}${" ".repeat(11)}${text.slice(at + 11)}`, "latin1"));
  assert.equal((await pdfLib.PDFDocument.load(input)).getPageCount(), 1);
  const rect = await boxOf(input, "NOEDIT-SECRET-1", { pad: 0.5 });
  const { bytes, report } = await redact(input, [target(rect, "redact")]);
  assert.deepEqual(report.pages.map((page) => [page.pageIndex, page.path, page.reasons[0].code]), [[0, "raster", "REDACT_DOCUMENT_NOT_EDITABLE"], [1, "raster", "REDACT_DOCUMENT_NOT_EDITABLE"]]);
  assert.equal((await extracted(bytes, 0)).text, "pageone");
  assert.equal((await extracted(bytes, 1)).text, "pagetwotext");
  assert.equal(found(bytes, "NOEDIT-SECRET-1"), false);
  const erased = await redact(input, [target(rect, "erase")]);
  assert.equal(erased.bytes, input);
  assert.deepEqual(erased.report.targets.map((row) => [row.outcome, row.reason.code]), [["cover-needed", "REDACT_DOCUMENT_NOT_EDITABLE"]]);
});

test("warnings of the raster path: flattened annotations, text the layer font lacks, no layer font", needCanvas, async () => {
  const cjk = { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: { Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: [65, "uni4E2D", "uni6587"] } };
  const { bytes: input } = await makePdf([{
    content: "BT /F1 12 Tf 72 700 Td (target text SECRET-CODE-11) Tj 0 -40 Td (latin kept line) Tj /C 12 Tf 0 -40 Td (AB) Tj ET",
    resources: (ctx, refs, fonts) => ({ Font: { ...fonts, C: ctx.register(ctx.obj(cjk)) } }),
    annots: [{ Type: "Annot", Subtype: "Link", Rect: [72, 655, 200, 672], A: { S: "URI", URI: pdfLib.PDFString.of("https://flattened.example.test/") } }]
  }]);
  const rect = [70, 695, 260, 714];
  let asked = null;
  const { bytes, report } = await redact(input, [target(rect, "redact")], { path: "raster", fonts: async (key) => loadFont((asked = key)) });
  assert.equal(asked, LAYER_FONT_KEY);
  assert.deepEqual(report.warnings, [{ code: "REDACT_ANNOTATIONS_FLATTENED", params: { page: 1, count: 1 } }, { code: "REDACT_TEXT_LAYER_INCOMPLETE", params: { page: 1, glyphs: 2 } }]);
  assert.equal((await extracted(bytes)).text, "latinkeptline");
  assert.equal(found(bytes, "https://flattened.example.test/"), false, "the link is in the picture now, not in the file");
  const offline = await redact(input, [target(rect, "redact")], { path: "raster", fonts: async () => {
    throw new Error("offline");
  } });
  assert.deepEqual(offline.report.warnings.map((warning) => warning.code), ["REDACT_TEXT_LAYER_UNAVAILABLE", "REDACT_ANNOTATIONS_FLATTENED"]);
  assert.deepEqual(offline.report.warnings[0].params, { fontKey: "arimo-regular" });
  assert.equal((await extracted(offline.bytes)).text, "");
  const bare = await redact(input, [target(rect, "redact")], { path: "raster", textLayer: false, fonts: undefined });
  assert.deepEqual(bare.report.warnings.map((warning) => warning.code), ["REDACT_ANNOTATIONS_FLATTENED"]);
});

// ---------------------------------------------------------------------------------------------------------
// arguments, env, progress, cancellation

test("arguments: no target returns the input, bad targets and a bad env are refused with a code", async () => {
  const fixture = await plainTextPdf();
  const same = await redactPdf(fixture.bytes, [], redactEnv());
  assert.equal(same.bytes, fixture.bytes);
  assert.deepEqual([same.report.pages, same.report.targets, same.report.warnings], [[], [], []]);
  const rect = [70, 690, 200, 710];
  const bad = [
    [[{ pageIndex: 99, rect }], { index: 0, problem: "page-out-of-range" }],
    [[{ pageIndex: 0, rect }, { pageIndex: -1, rect }], { index: 1, problem: "pageIndex" }],
    [[{ pageIndex: 0, rect: [0, 0, 0, 10] }], { index: 0, problem: "rect" }],
    [[{ pageIndex: 0, rect: [0, 0, 10] }], { index: 0, problem: "rect" }],
    [[{ pageIndex: 0, rect, mode: "shred" }], { index: 0, problem: "mode" }],
    [[{ pageIndex: 0, rect, mode: "redact", color: "black" }], { index: 0, problem: "color" }],
    [[{ pageIndex: 0, rect, mode: "blur", strength: 0.5 }], { index: 0, problem: "strength" }],
    [[{ pageIndex: 0, rect, mode: "blur", strength: 1, seed: "not a seed" }], { index: 0, problem: "seed" }],
    [[null], { index: 0, problem: "shape" }],
    ["not a list", { index: -1, problem: "shape" }]
  ];
  for (const [targets, params] of bad) assert.deepEqual((await refuses(redactPdf(fixture.bytes, targets, redactEnv()), "REDACT_BAD_TARGET")).params, params);
  const one = [{ pageIndex: 0, rect, mode: "erase" }];
  for (const [env, missing] of [[{ ...redactEnv(), openPdf: undefined }, "openPdf"], [{ ...redactEnv(), createCanvas: null }, "createCanvas"], [{ ...redactEnv(), fonts: undefined }, "fonts"], [{ ...redactEnv(), path: "fast" }, "path"], [{ ...redactEnv(), rasterPages: [1] }, "rasterPages"], [{ ...redactEnv(), rasterPages: 0 }, "rasterPages"], [null, "env"]]) {
    assert.deepEqual((await refuses(redactPdf(fixture.bytes, one, env), "REDACT_ENV_INVALID")).params, { missing });
  }
  assert.deepEqual((await refuses(redactPdf(new Uint8Array(Buffer.from("this is not a PDF")), one, redactEnv()), "REDACT_INPUT_UNREADABLE")).params, { reason: "invalid" });
  assert.deepEqual((await refuses(redactPdf("a string", one, redactEnv()), "REDACT_INPUT_UNREADABLE")).params, { reason: "invalid" });
  // the input bytes are never modified, and pdf.js never gets the caller's buffer
  const copy = fixture.bytes.slice();
  const handed = [];
  await redactPdf(fixture.bytes, one, redactEnv({ openPdf: (bytes, options) => {
    handed.push(bytes);
    return openPdf(bytes, options);
  } }));
  assert.deepEqual(fixture.bytes, copy);
  assert.ok(handed.length >= 3 && handed.every((bytes) => bytes !== fixture.bytes && bytes.buffer !== fixture.bytes.buffer));
});

test("an encrypted input: unreadable without the password, redacted and decrypted with it", needCanvas, async () => {
  const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Encrypted ENCRYPTED-SECRET-55 line", { x: 72, y: 700, size: 12, font });
  doc.encrypt({ userPassword: "user-pw", ownerPassword: "owner-pw" });
  const input = await doc.save({ useObjectStreams: false });
  assert.equal(found(input, "ENCRYPTED-SECRET-55"), false, "fixture: the text is encrypted in the file");
  const rect = [140, 695, 300, 714];
  assert.deepEqual((await refuses(redactPdf(input, [target(rect, "redact")], redactEnv()), "REDACT_INPUT_UNREADABLE")).params, { reason: "password" });
  const { bytes, report } = await redact(input, [target(rect, "redact")], { password: "user-pw" });
  assert.equal(report.pages[0].path, "precise");
  const text = (await extracted(bytes)).text; // opens without a password
  assert.ok(text.includes("Encrypted") && !text.includes("ENCRYPTED-SECRET-55"), text);
  assert.equal(found(bytes, "ENCRYPTED-SECRET-55"), false);
});

test("progress and cancellation", needCanvas, async () => {
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  const calls = [];
  await redact(fixture.bytes, [target(rect, "redact")], { onProgress: (fraction, stage) => calls.push([fraction, stage]) });
  assert.deepEqual([...new Set(calls.map((call) => call[1]))], PROGRESS_STAGES);
  assert.ok(calls.every((call, i) => i === 0 || call[0] >= calls[i - 1][0]), "the fraction never goes back");
  assert.deepEqual([calls[0][0], calls[calls.length - 1][0]], [0, 1]);
  // already aborted: nothing is done
  const controller = new AbortController();
  controller.abort();
  let opened = 0;
  await refuses(redactPdf(fixture.bytes, [target(rect, "redact")], redactEnv({ signal: controller.signal, openPdf: (bytes, options) => {
    opened += 1;
    return openPdf(bytes, options);
  } })), CANCELLED);
  assert.equal(opened, 0);
  // aborted in the middle: the job stops at the next stage and returns nothing
  const later = new AbortController();
  await refuses(redactPdf(fixture.bytes, [target(rect, "redact")], redactEnv({ signal: later.signal, onProgress: (fraction, stage) => {
    if (stage === "REDACT_STAGE_VERIFY") later.abort();
  } })), CANCELLED);
  seenCodes.delete(CANCELLED); // a code of ../errors.js, not of this engine
});

test("the pinned pdf.js constants equal those of the installed pdf.js, and the engine works without env.pdfjs", needCanvas, async () => {
  for (const [name, value] of Object.entries(PDFJS_CONSTANTS.OPS)) assert.equal(pdfjs.OPS[name], value, `OPS.${name}`);
  for (const [name, value] of Object.entries(PDFJS_CONSTANTS.AnnotationMode)) assert.equal(pdfjs.AnnotationMode[name], value, `AnnotationMode.${name}`);
  const fixture = await pictureUnderMarkPdf();
  const rect = await boxOf(fixture.bytes, fixture.target, { pad: 0.5 });
  const { bytes, report } = await redact(fixture.bytes, [target(rect, "redact")], { pdfjs: undefined });
  assert.equal(report.pages[0].path, "raster");
  assert.ok(!(await extracted(bytes)).text.includes(squash(fixture.secret)));
});

test("createBrowserRedactEnv: OffscreenCanvas when there is one, the injected canvas otherwise, JPEG through blobs", needCanvas, async () => {
  const fixture = await pictureUnderMarkPdf();
  const rect = await boxOf(fixture.bytes, fixture.target, { pad: 0.5 });
  const made = { injected: 0, offscreen: 0, jpeg: 0 };
  // the one way of encoding a browser canvas of that kind offers (the Node canvas has both: one is hidden)
  const withBlob = (canvas, method) => {
    const encode = ({ type, quality }) => {
      made.jpeg += 1;
      return new Blob([canvas.toBuffer(type, Math.round(quality * 100))], { type });
    };
    if (method === "convertToBlob") canvas.convertToBlob = async (options) => encode(options);
    else {
      canvas.convertToBlob = undefined;
      canvas.toBlob = (callback, type, quality) => callback(encode({ type, quality }));
    }
    return canvas;
  };
  // openPdfDocument has the shape of pdfWorker.js: getDocument() parameters in, a pdf.js loading task out
  const opened = [];
  const base = {
    pdfjs,
    openPdfDocument: (params) => {
      const task = openPdfDocument(params);
      opened.push({ params, task });
      return task;
    },
    fonts: loadFont,
    random: seededRandom(2),
    imageFormat: "jpeg"
  };
  const inputCopy = fixture.bytes.slice();
  const hadOffscreen = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  try {
    delete globalThis.OffscreenCanvas;
    assert.throws(() => createBrowserRedactEnv(base), (error) => error.code === "REDACT_ENV_INVALID" && error.params.missing === "createCanvas");
    assert.throws(() => createBrowserRedactEnv({ ...base, pdfjs: {} }), (error) => error.params.missing === "pdfjs");
    assert.throws(() => createBrowserRedactEnv({ ...base, fonts: null }), (error) => error.params.missing === "fonts");
    assert.throws(() => createBrowserRedactEnv({ ...base, fonts: { bytes: loadFont } }), (error) => error.params.missing === "fonts");
    assert.throws(() => createBrowserRedactEnv({ ...base, openPdfDocument: null }), (error) => error.params.missing === "openPdf");
    // 1. no OffscreenCanvas: the injected factory (an HTML canvas has toBlob)
    let env = createBrowserRedactEnv({ ...base, createCanvas: (w, h) => {
      made.injected += 1;
      return withBlob(canvasLib.createCanvas(w, h), "toBlob");
    } });
    let outcome = await redactPdf(fixture.bytes, [target(rect, "redact")], env);
    assert.equal(outcome.report.pages[0].path, "raster");
    assert.equal(outcome.report.pages[0].stats.imageFormat, "jpeg");
    assert.ok(made.injected >= 2 && made.jpeg === 1);
    // what pdf.js was given: the bytes as `data` (never the caller's own array: pdf.js keeps what it gets), no
    // password that nobody set; and every document that was opened has been closed again
    assert.ok(opened.length >= 2, "the input and the output were opened");
    for (const { params, task } of opened) {
      assert.deepEqual(Object.keys(params), ["data"]);
      assert.ok(params.data instanceof Uint8Array && params.data !== fixture.bytes && params.data.buffer !== fixture.bytes.buffer);
      assert.equal(task.destroyed, true, "a pdf.js document was left open");
    }
    assert.deepEqual(fixture.bytes, inputCopy, "the input bytes were changed");
    // 2. OffscreenCanvas exists: it is used, the injected factory is not asked
    globalThis.OffscreenCanvas = function OffscreenCanvas(w, h) {
      made.offscreen += 1;
      return withBlob(canvasLib.createCanvas(w, h), "convertToBlob");
    };
    made.injected = 0;
    env = createBrowserRedactEnv({ ...base, createCanvas: () => {
      made.injected += 1;
      throw new Error("must not be used");
    } });
    outcome = await redactPdf(fixture.bytes, [target(rect, "redact")], env);
    assert.equal(outcome.report.pages[0].stats.imageFormat, "jpeg");
    assert.ok(made.offscreen >= 2 && made.injected === 0 && made.jpeg === 2);
    assert.ok(!(await extracted(outcome.bytes)).text.includes(squash(fixture.secret)));
    // 3. a canvas that cannot make a JPEG answers with a PNG: the picture is stored lossless instead
    globalThis.OffscreenCanvas = function OffscreenCanvas(w, h) {
      const canvas = canvasLib.createCanvas(w, h);
      canvas.convertToBlob = async () => new Blob([canvas.toBuffer("image/png")], { type: "image/png" });
      return canvas;
    };
    //    (here with the font registry of text/fonts.js in place of a function, a password, and an
    //    openPdfDocument that answers with the promise of the document instead of a loading task)
    opened.length = 0;
    const registry = { getFontBytes: async (fontKey) => loadFont(fontKey) };
    const asPromise = (params) => base.openPdfDocument(params).promise;
    outcome = await redactPdf(fixture.bytes, [target(rect, "redact")], createBrowserRedactEnv({ ...base, fonts: registry, openPdfDocument: asPromise, password: "not needed" }));
    assert.equal(outcome.report.pages[0].stats.imageFormat, "flate");
    assert.ok(outcome.report.pages[0].stats.layer.fragments > 0, "the text layer was built with the font of the registry");
    assert.deepEqual(opened.map(({ params }) => params.password), ["not needed", ...opened.slice(1).map(() => undefined)], "the password belongs to the input only");
    assert.ok(opened.every(({ task }) => task.destroyed));

    // 4. the pdf.js worker cannot be started: the loading task never settles, the editor tells through
    //    onPdfWorkerError, and the job ends instead of waiting for ever
    const listeners = new Set();
    const stuck = createBrowserRedactEnv({
      ...base,
      openPdfDocument: () => ({ promise: new Promise(() => {}) }),
      onPdfWorkerError: (listener) => {
        listeners.add(listener);
        setTimeout(() => listener(new Error("worker script 404")), 5);
        return () => listeners.delete(listener);
      }
    });
    const failure = await refuses(redactPdf(fixture.bytes, [target(rect, "redact")], stuck), "REDACT_ENV_INVALID");
    assert.deepEqual(failure.params, { missing: "worker" });
    assert.equal(failure.cause.message, "worker script 404");
    assert.equal(listeners.size, 0, "the listener was not removed");
    // ... and with a worker that works the listener is removed after every open
    opened.length = 0;
    await redactPdf(fixture.bytes, [target(rect, "redact")], createBrowserRedactEnv({ ...base, onPdfWorkerError: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    } }));
    assert.ok(opened.length >= 2 && listeners.size === 0);
  } finally {
    if (hadOffscreen) Object.defineProperty(globalThis, "OffscreenCanvas", hadOffscreen);
    else delete globalThis.OffscreenCanvas;
  }
});

test("the same text elsewhere in the document (bookmarks, properties, field names) is reported, not hidden", needCanvas, async () => {
  const secret = "ELSEWHERE-SECRET-88";
  const { bytes: input } = await makePdf([{ content: `BT /F1 14 Tf 72 720 Td (${secret}) Tj /F1 11 Tf 0 -30 Td (body text of the page) Tj ET` }], {
    setup: (doc, refs) => {
      const ctx = doc.context;
      doc.setTitle(`Quarterly report ${secret} draft`);
      doc.setAuthor("Somebody Else");
      const outlines = ctx.nextRef();
      const item = ctx.register(ctx.obj({ Title: pdfLib.PDFString.of(secret), Parent: outlines, Dest: [refs.pages[0], "Fit"] }));
      const other = ctx.register(ctx.obj({ Title: pdfLib.PDFString.of("Another chapter"), Parent: outlines, Dest: [refs.pages[0], "Fit"] }));
      ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: item, Last: other, Count: 2 }));
      doc.catalog.set(pdfLib.PDFName.of("Outlines"), outlines);
      const packet = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:li>${secret}</rdf:li></x:xmpmeta>`;
      doc.catalog.set(pdfLib.PDFName.of("Metadata"), ctx.register(ctx.stream(Buffer.from(packet), { Type: "Metadata", Subtype: "XML" })));
    }
  });
  const rect = await boxOf(input, secret, { pad: 0.5 });
  const { bytes, report } = await redact(input, [target(rect, "redact")]);
  assert.equal(report.pages[0].path, "precise");
  assert.ok(!(await extracted(bytes)).text.includes(secret));
  // the page is clean; the document still says it in its title, its XMP packet and one bookmark
  assert.deepEqual(report.warnings, [
    { code: "REDACT_TEXT_ELSEWHERE", params: { where: "metadata", count: 2 } },
    { code: "REDACT_TEXT_ELSEWHERE", params: { where: "outline", count: 1 } }
  ]);
  assert.equal(found(bytes, secret), true, "the engine does not rewrite bookmarks and properties: that is why it warns");
  assert.ok(!JSON.stringify(report).includes(secret), "the warning must not repeat the text");
  // the same on the raster path; a replaced line (erase) is not a secret and raises nothing
  const raster = await redact(input, [target(rect, "pixelate")], { path: "raster" });
  assert.deepEqual(raster.report.warnings.map((warning) => warning.params.where), ["metadata", "outline"]);
  const erased = await redact(input, [target(rect, "erase")]);
  assert.deepEqual(erased.report.warnings, []);
  // a short removed word proves nothing about a title that happens to hold it
  const short = await redact(input, [target(await boxOf(input, "body", { pad: 0.3 }), "redact")]);
  assert.deepEqual(short.report.warnings, []);
});

test("a page stored as a JPEG: boxes that meet are still exactly flat, in their own colours", needCanvas, async () => {
  const lines = Array.from({ length: 6 }, (_, i) => `(line ${i + 1} of dense text for the picture ${"word ".repeat(9)}) Tj 0 -16 Td`).join(" ");
  const { bytes: input } = await makePdf([{ content: `BT /F1 12 Tf 60 740 Td ${lines} ET` }]);
  const targets = [
    { pageIndex: 0, rect: [50, 650, 300, 750], mode: "redact" },
    { pageIndex: 0, rect: [200, 700, 420, 730], mode: "redact", color: "#22aa66" },
    { pageIndex: 0, rect: [100, 640, 350, 690], mode: "blur", strength: 1 },
    { pageIndex: 0, rect: [320, 660, 520, 690], mode: "erase", color: "#ffee00" }
  ];
  const { bytes, report } = await redact(input, targets, { path: "raster", imageFormat: "jpeg" });
  assert.equal(report.pages[0].stats.imageFormat, "jpeg");
  assert.equal(report.pages[0].ok, true);
  // tolerance 0: not one pixel of ringing inside a box, also where the green box and the cover start
  const black = await regionOf(bytes, 0, [50, 692, 198, 698], { tolerance: 0 });
  assert.deepEqual([black.uniform, black.mean], [true, "#000000"]);
  const green = await regionOf(bytes, 0, [200, 700, 420, 730], { tolerance: 0 });
  assert.deepEqual([green.uniform, green.mean], [true, "#22aa66"]);
  const cover = await regionOf(bytes, 0, [352, 660, 520, 690], { tolerance: 0 });
  assert.deepEqual([cover.uniform, cover.mean], [true, "#ffee00"]);
  assert.equal((await extracted(bytes)).text.includes("line1"), false);
});

test("a tagged PDF: the structure tree keeps no words and no reference of what was removed", needCanvas, async () => {
  const { bytes: input } = await taggedPdf();
  const strings = ["STRUCT-ACTUAL-ZERO", "STRUCT-ALT-ZERO", "STRUCT-TITLE-ZERO", "SECTION-EXPANSION", "STRUCT-ACTUAL-FORM", "FORM-TAGGED-TEXT", "STRUCT-ACTUAL-ONE", "SECTION-TITLE-KEPT"];
  for (const text of strings) assert.equal(found(input, text), true, `fixture: ${text}`);
  const facts = (bytes) => Object.fromEntries(strings.map((text) => [text, found(bytes, text)]));
  // precise: the paragraph with marked-content id 0 and the text inside the tagged Form XObject lose glyphs
  const rects = [await boxOf(input, "TAG-SECRET-1", { pad: 0.5 }), await boxOf(input, "FORM-TAGGED-TEXT 88", { pad: 0.5 })];
  const precise = await redact(input, rects.map((rect) => target(rect, "redact")));
  assert.equal(precise.report.pages[0].path, "precise");
  assert.deepEqual(facts(precise.bytes), {
    // the words of the two elements that own the touched content, and /E of their ancestor ...
    "STRUCT-ACTUAL-ZERO": false, "STRUCT-ALT-ZERO": false, "STRUCT-TITLE-ZERO": false, "SECTION-EXPANSION": false, "STRUCT-ACTUAL-FORM": false,
    // ... and the original form stream, which only the tree (/Stm) still pointed to, are gone
    "FORM-TAGGED-TEXT": false,
    // an untouched paragraph keeps its words, an ancestor keeps its title
    "STRUCT-ACTUAL-ONE": true, "SECTION-TITLE-KEPT": true
  });
  assert.deepEqual([precise.report.pages[0].stats.structAttributesStripped, precise.report.pages[0].stats.orphansReleased], [5, 1]);
  assert.deepEqual(await findOrphans(precise.bytes), []);
  // the marked-content ids of the page are all still in its content: the references of the tree stay valid
  const content = pageContent(await load(precise.bytes));
  for (const id of [0, 1, 2]) assert.ok(content.includes(`/MCID ${id} >>`), `MCID ${id} left the page content`);
  // raster: nothing of the page content survives, so the page leaves the tree altogether
  const raster = await redact(input, [target(rects[0], "redact")], { path: "raster" });
  assert.equal(raster.report.pages[0].stats.structureKidsRemoved, 4);
  const after = facts(raster.bytes);
  assert.deepEqual([after["STRUCT-ACTUAL-ZERO"], after["STRUCT-ACTUAL-ONE"], after["STRUCT-ACTUAL-FORM"], after["FORM-TAGGED-TEXT"], after["SECTION-TITLE-KEPT"]], [false, false, false, false, true]);
  const doc = await load(raster.bytes);
  assert.equal(doc.getPage(0).node.has(pdfLib.PDFName.of("StructParents")), false);
  assert.ok(A.isDict(A.get(doc.catalog, "StructTreeRoot")), "the tree itself stays (other pages may use it)");
  assert.deepEqual(await findOrphans(raster.bytes), []);
});

test("a tagged PDF: words anywhere in the structure tree that repeat the removed text go with it", needCanvas, async () => {
  // a "Chapter" element whose title is a copy of the text under the mark, and a note whose /Alt quotes it:
  // neither owns the content of the page, nobody can see or edit them in a viewer
  const { bytes: input } = await taggedPdf({ chapterTitle: "CHAPTER-COPY of TAG-SECRET-1" });
  const rect = await boxOf(input, "TAG-SECRET-1", { pad: 0.5 });
  assert.deepEqual([found(input, "CHAPTER-COPY"), found(input, "TAG-SECRET-1")], [true, true]);
  for (const path of ["hybrid", "raster"]) {
    const { bytes, report } = await redact(input, [target(rect, "redact")], { path });
    assert.equal(report.pages[0].path, path === "raster" ? "raster" : "precise");
    // (rewritten after the review: the count was 2. The title of the chapter is the title of an ANCESTOR of the
    // paragraph that lost glyphs, and since the repair such a title goes with the attributes of the owners,
    // short or long; what is left for the sweep of the tree is the /Alt of the note)
    assert.equal(report.structureWordsStripped, 1, `${path}: the /Alt of the note`);
    if (path === "hybrid") assert.equal(report.pages[0].stats.structAttributesStripped, 5, "the three words of the paragraph, /E of the section, /T of the chapter");
    assert.deepEqual([found(bytes, "CHAPTER-COPY"), found(bytes, "TAG-SECRET-1")], [false, false], `${path}: a copy of the removed text is still in the file`);
    // titles that repeat nothing stay
    assert.deepEqual([found(bytes, "NOTE-TITLE-KEPT"), found(bytes, "SECTION-TITLE-KEPT")], [true, true]);
    assert.deepEqual(report.warnings.filter((warning) => warning.code === "REDACT_TEXT_ELSEWHERE"), [], "nothing is left to report");
    assert.deepEqual(await findOrphans(bytes), []);
  }
  // nothing painted: the bytes of the verified candidate would be returned as they are, were it not for the words
  const blank = await redact(input, [target(rect, "redact")], { paint: false });
  assert.deepEqual([blank.report.pages[0].path, blank.report.structureWordsStripped, found(blank.bytes, "CHAPTER-COPY")], ["precise", 1, false]);
  assert.deepEqual(await findOrphans(blank.bytes), []);
  // an erased line is replaced text, not a secret: its copies in the tree are not hunted down
  const erased = await redact(input, [target(rect, "erase")]);
  assert.equal(erased.report.targets[0].outcome, "precise");
  assert.equal(erased.report.structureWordsStripped, 0);
  assert.equal(found(erased.bytes, "CHAPTER-COPY"), true);
});

test("an output that cannot be read back, or has another page count, is refused", needCanvas, async () => {
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  const { bytes: twoPages } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (one) Tj ET" }, { content: "BT /F1 12 Tf 72 700 Td (two) Tj ET" }]);
  // the documents the engine opens for a page that stays precise: 0 the input, 1 the unpainted candidate, 2 the output
  const attempt = async (at, answer) => {
    let calls = 0;
    let result = "nothing";
    const error = await refuses((async () => {
      result = await redactPdf(fixture.bytes, [target(rect, "redact")], redactEnv({ openPdf: (bytes, options) => (calls++ === at ? answer(bytes, options) : openPdf(bytes, options)) }));
    })(), "REDACT_VERIFICATION_FAILED");
    assert.equal(result, "nothing");
    assert.ok(error.report, "the report travels with the error");
    return error;
  };
  const broken = async () => {
    throw new Error("Invalid PDF structure.");
  };
  let error = await attempt(1, broken);
  assert.deepEqual(error.params, { page: 0, check: "output-unreadable" });
  assert.equal(error.cause.message, "Invalid PDF structure.");
  error = await attempt(2, broken);
  assert.deepEqual(error.params, { page: 0, check: "output-unreadable" });
  error = await attempt(2, (bytes, options) => openPdf(twoPages, options));
  assert.deepEqual(error.params, { page: 0, check: "page-count" });
  assert.deepEqual(error.report.pages.map((page) => page.verification), [undefined], "pages of a document with another page count are not compared");
  // an error of the engine's own kind from env.openPdf is not re-labelled
  let calls = 0;
  const own = await refuses(redactPdf(fixture.bytes, [target(rect, "redact")], redactEnv({ openPdf: (bytes, options) => (calls++ === 2 ? Promise.reject(new PdfEditorError("REDACT_ENV_INVALID", { missing: "worker" })) : openPdf(bytes, options)) })), "REDACT_ENV_INVALID");
  assert.deepEqual(own.params, { missing: "worker" });
});

// ---------------------------------------------------------------------------------------------------------
// the defects of the independent review: each of these tests fails on the engine as it was reviewed

/** The image XObjects the content of a page can reach (through Form XObjects as well). */
function reachableImages(doc, pageIndex) {
  const seen = new Set();
  let images = 0;
  const walk = (resources, depth) => {
    const xobjects = A.get(resources, "XObject");
    if (!A.isDict(xobjects) || depth > 8) return;
    for (const key of xobjects.keys()) {
      const stream = xobjects.lookup(key);
      if (!stream?.dict || seen.has(stream)) continue;
      seen.add(stream);
      if (A.getName(stream.dict, "Subtype") === "Image") images += 1;
      else walk(A.get(stream.dict, "Resources"), depth + 1);
    }
  };
  walk(A.get(doc.getPage(pageIndex).node, "Resources"), 0);
  return images;
}

test("a picture drawn through a Form XObject under a mark leaves the file, also through a nested form", needCanvas, async () => {
  // (the review: a scan placed with embedPdf / drawPage stayed in the private copy of the form, in full)
  const marker = "PICTURE-BYTES-IN-FORM-0001";
  const pixels = bytesOf(marker.repeat(40).slice(0, 32 * 32));
  const build = async (variant) => {
    const withForm = (ctx, refs, fonts) => ({ Font: fonts, XObject: { Fm: refs.Fm } });
    const pages = [{ content: "BT /F1 12 Tf 60 740 Td (public heading stays) Tj ET q 1 0 0 1 60 520 cm /Fm Do Q BT /F1 12 Tf 60 480 Td (paragraph below stays) Tj ET", resources: withForm }];
    if (variant === "shared") pages.push({ content: "q 1 0 0 1 60 520 cm /Fm Do Q", resources: withForm });
    const { bytes } = await makePdf(pages, {
      objects: {
        Im: (ctx) => ctx.register(ctx.stream(pixels, { Type: "XObject", Subtype: "Image", Width: 32, Height: 32, ColorSpace: "DeviceGray", BitsPerComponent: 8 })),
        Inner: (ctx, refs) => ctx.register(ctx.stream(bytesOf("q 240 0 0 150 0 0 cm /Im Do Q"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 240, 150], Resources: { XObject: { Im: refs.Im } } })),
        Fm: (ctx, refs) => (variant === "nested" ? ctx.register(ctx.stream(bytesOf("/Inner Do"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 240, 150], Resources: { XObject: { Inner: refs.Inner } } })) : refs.Inner)
      }
    });
    return bytes;
  };
  const rect = [55, 515, 305, 675]; // the picture (60 .. 300 x 520 .. 670) with 5 pt around it
  for (const variant of ["form", "nested"]) {
    const input = await build(variant);
    assert.equal(found(input, marker), true, "fixture: the bytes of the picture can be found");
    for (const mode of ["redact", "pixelate"]) {
      const { bytes, report } = await redact(input, [target(rect, mode)]);
      assert.equal(report.pages[0].path, "precise", `${variant}, ${mode}`);
      assert.equal(found(bytes, marker), false, `${variant}, ${mode}: the bytes of the picture are still in the file`);
      assert.equal(reachableImages(await load(bytes), 0), mode === "redact" ? 0 : 1, "only the mosaic is a picture of the page now");
      assert.deepEqual(await findOrphans(bytes), []);
      const text = (await extracted(bytes)).text;
      assert.ok(text.includes("publicheadingstays") && text.includes("paragraphbelowstays"), text);
    }
  }
  // the same form on a page without a mark: that page keeps its picture, pixel for pixel, and the copy page 1
  // draws does not hold it
  const shared = await build("shared");
  const { bytes, report } = await redact(shared, [target(rect, "redact")]);
  assert.equal(report.pages[0].path, "precise");
  const doc = await load(bytes);
  assert.deepEqual([reachableImages(doc, 0), reachableImages(doc, 1)], [0, 1]);
  assert.equal(regionDifference(await regionOf(bytes, 1, rect), await regionOf(shared, 1, rect)), 0, "page 2 changed");
  assert.deepEqual(await findOrphans(bytes), []);
});

test("a soft mask that draws a picture over a mark: the page becomes a picture; away from every mark the mask stays", needCanvas, async () => {
  // (the review: the picture inside the mask of an ExtGState is drawn by no operator of the page, so the
  // remover never met it and its bytes stayed)
  const marker = "MASK-PICTURE-BYTES-0002";
  const pixels = bytesOf(marker.repeat(50).slice(0, 32 * 32));
  const build = async (box) => (await makePdf([{
    content: "/GS1 gs BT /F1 12 Tf 72 700 Td (target text SECRET-CODE-11) Tj 0 -60 Td (kept line below) Tj ET",
    resources: (ctx, refs, fonts) => ({
      Font: fonts,
      ExtGState: { GS1: { Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: ctx.register(ctx.stream(bytesOf(`q ${box[2] - box[0]} 0 0 ${box[3] - box[1]} ${box[0]} ${box[1]} cm /Im Do Q`), {
        Type: "XObject", Subtype: "Form", BBox: box, Group: { S: "Transparency", CS: "DeviceGray" },
        Resources: { XObject: { Im: ctx.register(ctx.stream(pixels, { Type: "XObject", Subtype: "Image", Width: 32, Height: 32, ColorSpace: "DeviceGray", BitsPerComponent: 8 })) } }
      })) } } }
    })
  }])).bytes;
  const rect = [70, 695, 260, 714];
  const over = await build([60, 690, 260, 720]);
  assert.equal(found(over, marker), true, "fixture");
  for (const mode of ["redact", "blur"]) {
    const { bytes, report } = await redact(over, [target(rect, mode)]);
    assert.deepEqual(report.pages.map((page) => [page.path, page.reasons]), [["raster", [{ code: "REDACT_TEXT_IN_SUBCONTENT", params: { page: 1, where: "soft-mask" } }]]], mode);
    assert.equal(found(bytes, marker), false, `${mode}: the bytes of the picture in the mask are still in the file`);
    assert.equal(found(bytes, "SECRET-CODE-11"), false);
  }
  // an erased line never makes a picture of the page: only its glyphs go
  const erased = await redact(over, [target(rect, "erase")]);
  assert.deepEqual([erased.report.pages[0].path, erased.report.targets[0].outcome], ["precise", "precise"]);
  // a mask that reaches no mark hides nothing of what the mark covers: the page stays as it is
  const away = await build([60, 300, 260, 330]);
  const { bytes, report } = await redact(away, [target(rect, "redact")]);
  assert.equal(report.pages[0].path, "precise");
  assert.equal(found(bytes, marker), true);
  assert.equal(found(bytes, "SECRET-CODE-11"), false);
});

/** Two definitions of object 6 (the content of page 2): the cross-reference table points at the first one. */
function twoDefinitionsPdf() {
  const text = (line) => `BT /F1 14 Tf 72 700 Td (${line}) Tj ET`;
  const stream = (content) => `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  return rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    stream(text("Page one with the ACCOUNT-551-778 to redact")),
    "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>",
    stream(text("Page two as every viewer shows it: harmless text")),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  ], { after: `6 0 obj\n${stream(text("HIDDEN OLD VERSION of page two: salary 9 900 000"))}\nendobj\n` });
}

test("a file the PDF library reads differently from a viewer: no page without a mark may change", needCanvas, async () => {
  // (the review: pdf.js follows the cross-reference table, the library keeps the LAST definition of an object.
  // The output showed, on a page nobody marked, an old version that no viewer had shown)
  const input = twoDefinitionsPdf();
  const shown = "Pagetwoaseveryviewershowsit:harmlesstext";
  assert.equal((await extracted(input, 1)).text, shown, "fixture: pdf.js shows the first definition");
  const rect = [70, 690, 500, 716];
  for (const mode of ["redact", "pixelate"]) {
    const { bytes, report } = await redact(input, [target(rect, mode)]);
    // the library cannot be trusted with this file: every page is taken from what pdf.js draws
    assert.deepEqual(report.pages.map((page) => [page.pageIndex, page.path, page.reasons.map((reason) => reason.code)]), [[0, "raster", ["REDACT_DOCUMENT_NOT_EDITABLE"]], [1, "raster", ["REDACT_DOCUMENT_NOT_EDITABLE"]]], mode);
    assert.equal((await extracted(bytes, 1)).text, shown, `${mode}: page 2 shows something else now`);
    assert.equal(found(bytes, "HIDDEN OLD VERSION"), false, `${mode}: the hidden definition reached the output`);
    assert.equal(found(bytes, "ACCOUNT-551-778"), false);
    assert.equal((await extracted(bytes, 0)).text, "");
  }
  // erase never makes pictures: nothing is changed at all, and the line needs a cover
  const erased = await redact(input, [target(rect, "erase")]);
  assert.equal(erased.bytes, input);
  assert.deepEqual(erased.report.targets.map((row) => [row.outcome, row.reason.code]), [["cover-needed", "REDACT_DOCUMENT_NOT_EDITABLE"]]);
  assert.deepEqual(erased.report.pages.map((page) => page.path), ["untouched"]);
});

test("a stream with an indirect /Length whose data ends with a carriage return keeps every byte", needCanvas, async () => {
  // (the review: the library ignores an indirect /Length and looks for "endstream"; a data byte 0x0D in front
  // of it is taken for the end of the line and dropped: the picture of a page without a mark lost a sample)
  const text = "BT /F1 12 Tf 72 700 Td (Account 5512-KQ-9 to redact) Tj ET";
  const build = (pixels) => rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>",
    "<< /Length 31 >>\nstream\nq 200 0 0 200 100 400 cm /Im1 Do Q\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 9 0 R >>\nstream\n${latin1(pixels)}\nendstream`,
    "64"
  ]);
  const imageOf = async (bytes) => (await load(bytes)).context.enumerateIndirectObjects().map(([, object]) => object).find((object) => object.dict && A.getName(object.dict, "Subtype") === "Image");
  const endsWithReturn = new Uint8Array(64).fill(0x80);
  endsWithReturn[63] = 0x0d;
  // a sibling of the same mistake: the keyword inside the data ends the stream for the library
  const holdsKeyword = new Uint8Array(64).fill(0x80);
  holdsKeyword.set(Buffer.from("\nendstream\n", "latin1"), 20);
  for (const [pixels, readByLibrary] of [[endsWithReturn, 63], [holdsKeyword, 20]]) {
    const input = build(pixels);
    assert.equal((await imageOf(input)).contents.length, readByLibrary, "fixture: the library reads the stream short");
    const { bytes, report } = await redact(input, [target([60, 690, 400, 716], "redact")]);
    assert.equal(report.pages[0].path, "precise");
    assert.equal(report.streamsRepaired, 1);
    const image = await imageOf(bytes);
    assert.deepEqual([...image.contents], [...pixels], "the picture of page 2 lost data");
    assert.equal(regionDifference(await regionOf(bytes, 1, [100, 400, 300, 600]), await regionOf(input, 1, [100, 400, 300, 600])), 0);
    assert.equal(found(bytes, "5512-KQ-9"), false);
  }
});

test("a damaged input: a mark on a page pdf.js cannot read is refused with a code, the other pages are served", needCanvas, async () => {
  // the dictionary of page 2 becomes a number (same length, so every offset stays valid): pdf.js opens the
  // file, but cannot read its second page
  const damaged = async (pageCount) => {
    const lines = ["page one DAMAGED-SECRET-1", "page two text", "page three"].slice(0, pageCount);
    const { bytes: good } = await makePdf(lines.map((line) => ({ content: `BT /F1 12 Tf 72 700 Td (${line}) Tj ET` })));
    const text = latin1(good);
    const second = [...text.matchAll(/\d+ 0 obj\n<<\n?\/Type \/Page\b(?!s)/g)][1];
    const at = second.index + second[0].indexOf("<<");
    const end = text.indexOf("endobj", at);
    const bytes = bytesOf(`${text.slice(0, at)}42${" ".repeat(end - at - 3)}\n${text.slice(end)}`);
    assert.equal(bytes.length, good.length);
    return bytes;
  };
  const input = await damaged(3);
  await withPdf(input, async (doc) => {
    assert.equal(doc.numPages, 2, "fixture: pdf.js counts the pages it finds");
    await assert.rejects(doc.getPage(2), "fixture: pdf.js cannot read page 2");
  });
  const rect = [70, 690, 400, 716];
  // (the review: the error of pdf.js escaped as it was, without a code)
  for (const mode of ["redact", "erase"]) {
    const error = await refuses(redactPdf(input, [target(rect, mode, 1)], redactEnv()), "REDACT_INPUT_UNREADABLE");
    assert.deepEqual(error.params, { reason: "invalid" });
    assert.ok(error.cause, "the error of pdf.js is the cause");
  }
  // a mark on the readable page works; the broken page is as broken as it was (it must not come back readable)
  const { bytes, report } = await redact(input, [target(rect, "redact")]);
  assert.equal(report.pages[0].path, "precise");
  assert.equal(found(bytes, "DAMAGED-SECRET-1"), false);
  await withPdf(bytes, async (doc) => {
    assert.equal(doc.numPages, 2);
    await assert.rejects(doc.getPage(2));
  });
  // a file the library cannot edit either (it counts one page where pdf.js counts two): every page would have
  // to become a picture, and the broken one cannot. Refused with the same code, whatever page carries the mark
  const worse = await damaged(2);
  assert.equal((await pdfLib.PDFDocument.load(worse)).getPageCount(), 1);
  assert.deepEqual((await refuses(redactPdf(worse, [target(rect, "redact")], redactEnv()), "REDACT_INPUT_UNREADABLE")).params, { reason: "invalid" });
});

test("a mark with a seed shows the same mosaic in every export: noise and grid come from the seed alone", needCanvas, async () => {
  // (the review: every export drew fresh noise, so the mean of a few exports of one mark gave the number back)
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  const other = await boxOf(fixture.bytes, "Alice Example", { pad: 0.5 });
  const seed = "00112233445566778899aabbccddeeff";
  const mark = { pageIndex: 0, rect, mode: "pixelate", strength: 1, seed };
  const same = (a, b) => Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) === 0;
  let alone = null;
  for (const path of ["hybrid", "raster"]) {
    const a = await redact(fixture.bytes, [mark], { random: seededRandom(1), path });
    assert.equal(a.report.pages[0].path, path === "raster" ? "raster" : "precise");
    // another random source of the job, the platform's own, another spelling of the seed: the same file
    assert.ok(same(a, await redact(fixture.bytes, [mark], { random: seededRandom(2), path })), `${path}: the mosaic depends on env.random`);
    assert.ok(same(a, await redact(fixture.bytes, [mark], { random: undefined, path })), `${path}: the mosaic depends on the platform's random numbers`);
    assert.ok(same(a, await redact(fixture.bytes, [{ ...mark, seed: seed.toUpperCase() }], { random: seededRandom(3), path })), `${path}: upper case`);
    // another seed: another picture
    assert.ok(!same(a, await redact(fixture.bytes, [{ ...mark, seed: "ffeeddccbbaa99887766554433221100" }], { random: seededRandom(1), path })), `${path}: the seed is not used`);
    if (path === "hybrid") alone = a;
  }
  // the picture of the mark is the same whatever else the job holds, and wherever the mark stands in the list
  const [picture] = await patchImages(alone.bytes);
  const crowd = await redact(fixture.bytes, [{ pageIndex: 0, rect: other, mode: "blur", strength: 2 }, mark, { pageIndex: 0, rect: [72, 668, 150, 682], mode: "pixelate", strength: 1 }], { random: seededRandom(9) });
  const pictures = await patchImages(crowd.bytes);
  assert.equal(pictures.length, 3);
  assert.equal(pictures.filter((patch) => patch.width === picture.width && patch.height === picture.height && Buffer.compare(Buffer.from(patch.rgb), Buffer.from(picture.rgb)) === 0).length, 1, "the mosaic of the seeded mark changed with the other marks");
  // "blur" with the same seed is the smoothed mosaic of "pixelate" and nothing else: no second look at the content
  const soft = (await patchImages((await redact(fixture.bytes, [{ ...mark, mode: "blur" }], { random: seededRandom(4) })).bytes))[0];
  const image = { data: new Uint8ClampedArray(picture.width * picture.height * 4).fill(255), width: picture.width, height: picture.height };
  for (let i = 0; i < picture.width * picture.height; i++) image.data.set(picture.rgb.subarray(i * 3, i * 3 + 3), i * 4);
  const block = blurApi.mosaicBlock({ boxHeightPx: picture.height, pxPerPt: 150 / 72, strength: 1, emPt: 12 });
  blurApi.blurRegion(image, 0, 0, picture.width, picture.height, { sigma: block * BLUR_DEFAULTS.smoothRatio });
  assert.deepEqual([soft.width, soft.height], [picture.width, picture.height]);
  for (let i = 0; i < picture.width * picture.height; i++) assert.deepEqual([...soft.rgb.subarray(i * 3, i * 3 + 3)], [...image.data.subarray(i * 4, i * 4 + 3)], `pixel ${i} of the blurred mosaic`);
  // what is not a seed is refused, in every mode; no seed at all is fine
  for (const bad of ["abc", "0".repeat(31), "0".repeat(33), "g".repeat(32), "", 12345, {}]) {
    for (const mode of MODES) assert.deepEqual((await refuses(redactPdf(fixture.bytes, [{ pageIndex: 0, rect, mode, seed: bad }], redactEnv()), "REDACT_BAD_TARGET")).params, { index: 0, problem: "seed" }, `${JSON.stringify(bad)} in mode ${mode}`);
  }
  for (const none of [undefined, null]) assert.equal((await redact(fixture.bytes, [{ ...mark, seed: none }])).report.pages[0].ok, true);
  // a box has no noise: its seed changes nothing
  assert.ok(same(await redact(fixture.bytes, [{ pageIndex: 0, rect, mode: "redact", seed }]), await redact(fixture.bytes, [{ pageIndex: 0, rect, mode: "redact" }])));
  // a mosaic WITHOUT a seed still works (fresh noise each time), but the caller is told how many there are:
  // several exports of such a mark can be averaged
  const loose = [{ pageIndex: 0, rect, mode: "pixelate", strength: 1 }, { pageIndex: 0, rect: other, mode: "blur", strength: 1 }, { pageIndex: 0, rect: [72, 668, 150, 682], mode: "pixelate", strength: 1, seed }];
  for (const path of ["hybrid", "raster"]) assert.deepEqual((await redact(fixture.bytes, loose, { path })).report.warnings, [{ code: "REDACT_MOSAIC_NOT_SEEDED", params: { count: 2 } }], path);
  assert.deepEqual(alone.report.warnings, []);
  // (nothing is painted with paint: false: no noise, nothing to tell)
  assert.deepEqual((await redact(fixture.bytes, loose, { paint: false })).report.warnings, []);
});

test("a thin mark through a line: the mosaic is made of the whole glyphs it takes, with blocks to match", needCanvas, async () => {
  // (a glyph goes as a whole. The mosaic of the stripe alone is an average over the densest part of the
  // digits, in blocks of the old rule's 12 pt: the attack of blur.js read most of a number out of it)
  const { bytes: input } = await makePdf([{ content: "BT /F1 30 Tf 72 600 Td (4711 0815) Tj /F1 12 Tf 0 -60 Td (kept line) Tj ET" }]);
  const box = await boxOf(input, "4711 0815");
  const rect = [box[0], 608, box[2], 612]; // 4 pt high, through the middle of the digits
  for (const mode of ["pixelate", "blur"]) {
    const { bytes, report } = await redact(input, [{ pageIndex: 0, rect, mode, strength: 1 }], { random: seededRandom(5) });
    assert.equal(report.pages[0].path, "precise");
    assert.equal(report.pages[0].stats.glyphsRemoved, 9, "the mark takes the whole digits");
    assert.ok(!(await extracted(bytes)).text.includes("4711"));
    if (mode === "blur") continue;
    const [picture] = await patchImages(bytes);
    assert.ok(picture.height <= 10 && picture.width > 250, `the picture is the mark (${picture.width} x ${picture.height} px at 150 px per inch)`);
    // the block: 2.25 x the font size (30 pt) and twice the height of the glyph boxes, both about 141 px here;
    // the rule of the reviewed engine gave 12 pt = 25 px
    const { columns, rows } = blockRuns(picture);
    const edge = Math.round(2.25 * 30 * (150 / 72));
    assert.ok(rows.length <= 2 && columns.length <= Math.ceil(picture.width / edge) + 1, `blocks ${columns} x ${rows}`);
    for (const run of columns.slice(1, -1)) assert.equal(run % edge, 0, `a block of ${run} px between two others (expected ${edge})`);
    assert.ok(Math.max(...columns) >= Math.min(edge, picture.width / 3), `the widest block is ${Math.max(...columns)} px`);
  }
});

test("attached files: their names and plain text are searched in any Unicode encoding, and the caller is told that they are not opened", needCanvas, async () => {
  const secret = "ATTACHED-SECRET-4410";
  const utf16 = (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
  const build = async (copies) => (await makePdf([{ content: `BT /F1 14 Tf 72 720 Td (${secret}) Tj /F1 11 Tf 0 -30 Td (body text of the page) Tj ET` }], {
    setup: async (doc) => {
      if (copies) {
        // an XMP packet in UTF-16 (the reviewed engine read every packet as UTF-8 and found nothing)
        const packet = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:li>${secret}</rdf:li></x:xmpmeta>`;
        doc.catalog.set(pdfLib.PDFName.of("Metadata"), doc.context.register(doc.context.stream(utf16(packet), { Type: "Metadata", Subtype: "XML" })));
      }
      await doc.attach(Buffer.from(copies ? `invoice data\ncustomer;${secret};paid\n` : "nothing of interest\n"), "data.csv", { mimeType: "text/csv", description: "the data of the invoice" });
      await doc.attach(Buffer.from([0x50, 0x4b, 3, 4, 0, 1, 2, 3]), copies ? `${secret}.zip` : "archive.zip", { mimeType: "application/zip" });
    }
  })).bytes;
  const input = await build(true);
  const rect = await boxOf(input, secret, { pad: 0.5 });
  const { bytes, report } = await redact(input, [target(rect, "redact")]);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual(report.warnings, [
    // the text of data.csv, and the name of the archive in its file specification (/F, /UF) and in the name tree
    { code: "REDACT_TEXT_ELSEWHERE", params: { where: "attachment", count: 4 } },
    { code: "REDACT_TEXT_ELSEWHERE", params: { where: "metadata", count: 1 } },
    { code: "REDACT_ATTACHMENTS_NOT_CHECKED", params: { count: 2 } }
  ]);
  assert.ok(!JSON.stringify(report).includes(secret), "a warning must not repeat the text");
  assert.ok(!(await extracted(bytes)).text.includes(secret));
  // attachments that repeat nothing the engine can read: it says that it did not look inside
  const quiet = await redact(await build(false), [target(rect, "pixelate")]);
  assert.deepEqual(quiet.report.warnings, [{ code: "REDACT_ATTACHMENTS_NOT_CHECKED", params: { count: 2 } }]);
  // a replaced line (erase) is not a secret
  assert.deepEqual((await redact(input, [target(rect, "erase")])).report.warnings, []);
});

test("a font that still holds glyphs of the removed text is named in the report", needCanvas, async () => {
  const made = await type1Pdf({ pages: [["Account 0947-315-268 Zurich", "the contract runs for two years"], ["second page of the same font"]] });
  const { bytes, report } = await redact(made.bytes, [target(await boxOf(made.bytes, "0947-315-268", { pad: 1 }), "redact")]);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual(report.fontsNotCleaned, [{ font: made.fontName, pageIndexes: [0, 1], reason: "type1" }]);
  assert.deepEqual(report.warnings, [{ code: "REDACT_FONT_GLYPHS_REMAIN", params: { font: made.fontName, pages: 2 } }]);
  assert.deepEqual([report.fontsCleaned, report.streamsRepaired], [[], 0]);
  assert.ok(!(await extracted(bytes)).text.includes("0947"));
  // (what the fonts of every kind lose, and what env.rasterPages does: tests/pdfRedactFontCleanup.test.mjs)
});

test("previewRemoval: the boxes of the text a mark will take, exactly, before anything is exported", needCanvas, async () => {
  const fixture = await plainTextPdf();
  const rect = await boxOf(fixture.bytes, fixture.secret, { pad: 0.5 });
  // a hand-drawn mark with 6 pt around the word: it reaches the lines above and below (leading 14 pt)
  const padded = [rect[0] - 6, rect[1] - 6, rect[2] + 6, rect[3] + 6];
  const untouched = fixture.bytes.slice();
  const marks = [{ pageIndex: 0, rect }, { pageIndex: 0, rect: padded, mode: "pixelate" }, { pageIndex: 0, rect: [300, 100, 400, 120] }, { pageIndex: 0, rect: [1, 2, 3] }, { pageIndex: 7, rect }, null];
  const [tight, wide, empty, broken, far, nothing] = await engineApi.previewRemoval(fixture.bytes, marks);
  assert.deepEqual([tight.index, tight.pageIndex, tight.path, tight.glyphs, tight.boxes.length], [0, 0, "precise", fixture.secret.length, 1]);
  const [box] = tight.boxes;
  assert.deepEqual([box.glyphs, box.inside, box.quad.length], [fixture.secret.length, true, 8]);
  assert.ok(Math.abs(box.rect[0] - rect[0]) <= 0.51 && Math.abs(box.rect[2] - rect[2]) <= 0.51 && box.rect[1] >= rect[1] - 0.01 && box.rect[3] <= rect[3] + 0.01, `the box is the word: ${box.rect} in ${rect}`);
  // the padded mark takes more than it covers: runs on the neighbouring lines that reach out of the mark
  assert.equal(wide.path, "precise");
  assert.ok(wide.glyphs > fixture.secret.length + 4, `the padded mark takes ${wide.glyphs} glyphs`);
  const outside = wide.boxes.filter((item) => !item.inside);
  for (const item of outside) assert.ok(item.rect[0] < padded[0] || item.rect[1] < padded[1] || item.rect[2] > padded[2] || item.rect[3] > padded[3], "a run that is not inside reaches out of the mark");
  assert.ok(outside.some((item) => item.rect[3] > padded[3]) && outside.some((item) => item.rect[1] < padded[1]), "the lines above and below lose glyphs");
  assert.equal(wide.boxes.reduce((sum, item) => sum + item.glyphs, 0), wide.glyphs);
  // EXACT: the export removes what the preview said, glyph for glyph (the preview is the remover's own dry run)
  for (const [mark, preview] of [[rect, tight], [padded, wide], [[60, 668, 300, 676], null]]) {
    const said = preview || (await engineApi.previewRemoval(fixture.bytes, [{ pageIndex: 0, rect: mark }]))[0];
    const { report } = await redact(fixture.bytes, [{ pageIndex: 0, rect: mark, mode: "redact" }]);
    assert.equal(report.pages[0].path, "precise");
    assert.equal(report.pages[0].stats.glyphsRemoved, said.glyphs, `mark ${mark}`);
  }
  // a mark over nothing, a mark that is no rectangle, a page that does not exist, no mark at all
  assert.deepEqual(empty, { index: 2, pageIndex: 0, path: "precise", glyphs: 0, boxes: [] });
  assert.deepEqual([broken, far, nothing], [{ index: 3, pageIndex: 0, path: "none", glyphs: 0, boxes: [] }, { index: 4, pageIndex: 7, path: "none", glyphs: 0, boxes: [] }, { index: 5, pageIndex: undefined, path: "none", glyphs: 0, boxes: [] }]);
  // the result holds boxes and counts, never text; looking changed nothing, and looking twice gives the same
  assert.ok(!JSON.stringify([tight, wide]).includes("SECRET"));
  assert.deepEqual(fixture.bytes, untouched);
  assert.deepEqual(await engineApi.previewRemoval(fixture.bytes, marks), [tight, wide, empty, broken, far, nothing]);
  const seeded = (options) => redactPdf(fixture.bytes, [{ pageIndex: 0, rect, mode: "redact" }], redactEnv(options));
  assert.equal(Buffer.compare(Buffer.from((await seeded()).bytes), Buffer.from((await seeded()).bytes)), 0);

  // a page the export will turn into a picture: nothing but the rectangle goes, and the preview names the reason
  const picture = await pictureUnderMarkPdf();
  const caption = await boxOf(picture.bytes, picture.target, { pad: 0.5 });
  const [strict, erase] = await engineApi.previewRemoval(picture.bytes, [{ pageIndex: 0, rect: caption, mode: "blur" }, { pageIndex: 0, rect: caption, mode: "erase" }]);
  assert.deepEqual(strict, { index: 0, pageIndex: 0, path: "raster", reason: "REDACT_IMAGE_IN_TARGET", glyphs: 0, boxes: [] });
  assert.deepEqual(erase, { index: 1, pageIndex: 0, path: "raster", reason: "REDACT_IMAGE_IN_TARGET", glyphs: 0, boxes: [] }, "an erase mark beside a strict one shares the picture");
  // the erase mark alone only takes glyphs: the page stays as it is
  const [alone] = await engineApi.previewRemoval(picture.bytes, [{ pageIndex: 0, rect: caption, mode: "erase" }]);
  assert.deepEqual([alone.path, alone.glyphs], ["precise", picture.target.length]);
  // a file the library cannot load: the export makes pictures of all its pages
  const garbage = bytesOf("%PDF-1.4 this is not a document");
  assert.deepEqual(await engineApi.previewRemoval(garbage, [{ pageIndex: 0, rect }, { pageIndex: 0, rect, mode: "erase" }]), [
    { index: 0, pageIndex: 0, path: "raster", reason: "REDACT_DOCUMENT_NOT_EDITABLE", glyphs: 0, boxes: [] },
    { index: 1, pageIndex: 0, path: "cover-needed", reason: "REDACT_DOCUMENT_NOT_EDITABLE", glyphs: 0, boxes: [] }
  ]);
  assert.deepEqual(await engineApi.previewRemoval("not bytes", [{ pageIndex: 0, rect }]), [{ index: 0, pageIndex: 0, path: "none", glyphs: 0, boxes: [] }]);
  // the interface may hand over the pdf.js document it shows instead of the bytes: the same answer
  await withPdf(fixture.bytes, async (doc) => {
    const page = await doc.getPage(1);
    const viaPdfjs = await engineApi.previewRemoval(doc, [{ pageIndex: page.pageNumber - 1, rect: padded }, { pageIndex: 0, rect }]);
    assert.deepEqual(viaPdfjs.map((entry) => [entry.path, entry.glyphs, entry.boxes]), [[wide.path, wide.glyphs, wide.boxes], [tight.path, tight.glyphs, tight.boxes]]);
    assert.deepEqual(await engineApi.previewRemoval(doc, [{ pageIndex: 0, rect: padded }]), [{ ...wide, index: 0 }], "asked again: the same document object is reused");
    // (a page alone is not a document)
    assert.deepEqual((await engineApi.previewRemoval(page, [{ pageIndex: 0, rect }]))[0].path, "none");
  });
});

// ---------------------------------------------------------------------------------------------------------

test("every code of CODES is produced by this suite", { skip: !canRender && "the codes are collected by the tests that need a canvas" }, () => {
  // nothing is explained away: each code was seen in a report or on an error above
  const missing = Object.keys(CODES).filter((code) => !seenCodes.has(code));
  assert.deepEqual(missing, []);
  const unknown = [...seenCodes].filter((code) => !(code in CODES));
  assert.deepEqual(unknown, [], "a report carried a code that CODES does not list");
  for (const [code, names] of Object.entries(CODES)) {
    assert.match(code, /^REDACT_[A-Z_]+$/);
    assert.ok(Array.isArray(names) && names.every((name) => typeof name === "string"));
  }
});
