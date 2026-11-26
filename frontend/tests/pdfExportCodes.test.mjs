// engine/export: every code of CODES is produced here, with exactly the parameters CODES promises, so that
// messages.js can rely on the list. The last test fails when a code has no scenario.
import test from "node:test";
import assert from "node:assert/strict";
import { CODES, ERROR_CODES, STAGES, WARNING_CODES, assembleDocument, drawOnDocument, inspectSource } from "../src/pages/pdfEditor/engine/export/index.js";
import { exportDocument } from "../src/pages/pdfEditor/engine/export/export.js";
import { CANCELLED, isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { extractText, loadFont, makeTextPdf, pdfLib } from "./helpers/pdfTestKit.mjs";
import {
  ENCRYPTED_TITLE, SAMPLE_PNG, buildEncryptedFixture, buildLinkedFixture, buildSharedResourcesFixture, makeTextObject, rawPage,
  rawPdf, rawPdfWithIndirectLength, rawPdfWithTable, skeleton, streamBody
} from "./helpers/pdfExportFixtures.mjs";
import { fileFacts } from "./helpers/pdfExportScan.mjs";

const { PDFDocument, PDFName, PDFString, PDFHexString, PDFPageLeaf } = pdfLib;
const NOW = new Date(Date.UTC(2026, 10, 16, 2, 0, 0));
const OPTIONS = { fonts: loadFont, now: NOW, idSeed: new Uint8Array(16).fill(3) };
const produced = new Set();

const simple = await makeTextPdf([{ lines: ["CODES-P1"], size: [300, 200] }, { lines: ["CODES-P2"], size: [300, 200] }]);
const jobOf = (bytes, extra = {}, pages = 1) => ({
  sources: [{ id: "s", bytes, expectedPages: undefined, ...(extra.source || {}) }],
  pages: Array.from({ length: pages }, (_, index) => ({ source: "s", index, rotate: 0 })),
  objects: Array.from({ length: pages }, () => []),
  marks: [], assets: {}, info: {}, fileName: "codes",
  ...(extra.job || {})
});
const rect = (extra = {}) => ({ id: "r1", type: "rect", pageId: "p", frame: { x: 100, y: 100, w: 40, h: 30, rot: 0 }, stroke: null, strokeWidth: 0, dash: "solid", fill: "#111111", opacity: 1, ...extra });

/** The promise must reject with a PdfEditorError of this code that carries exactly the parameters of CODES. */
async function expectError(code, run, check) {
  await assert.rejects(run, (error) => {
    assert.ok(isPdfEditorError(error), `a PdfEditorError, got ${error && error.stack}`);
    assert.equal(error.code, code, error.message);
    assert.deepEqual(Object.keys(error.params).sort(), [...CODES[code]].sort(), `parameters of ${code}`);
    if (check) check(error);
    produced.add(code);
    return true;
  });
}

/** The report must hold this warning with exactly the parameters of CODES; returns the warnings found. */
function expectWarning(report, code, params) {
  const found = report.warnings.filter((warning) => warning.code === code);
  assert.ok(found.length > 0, `${code} is not in ${JSON.stringify(report.warnings)}`);
  for (const warning of found) assert.deepEqual(Object.keys(warning.params).sort(), [...CODES[code]].sort(), `parameters of ${code}`);
  if (params) assert.deepEqual(found[0].params, params);
  produced.add(code);
  return found;
}

test("CODES is the union of the error and the warning codes, all with the EXPORT_ prefix", () => {
  assert.deepEqual(Object.keys(CODES).sort(), [...Object.keys(ERROR_CODES), ...Object.keys(WARNING_CODES)].sort());
  for (const [code, params] of Object.entries(CODES)) {
    assert.match(code, /^EXPORT_[A-Z_]+$/);
    assert.ok(Array.isArray(params) && params.every((name) => typeof name === "string"), code);
  }
  assert.ok(Object.isFrozen(CODES) && Object.isFrozen(STAGES));
});

// -----------------------------------------------------------------------------------------------------------
// errors
// -----------------------------------------------------------------------------------------------------------

test("EXPORT_JOB_INVALID: a job that cannot be meant", async () => {
  const reason = (expected, page = null, source = null) => (error) => assert.deepEqual(error.params, { reason: expected, page, source });
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument({ ...jobOf(simple), pages: [], objects: [] }, OPTIONS), reason("no-pages"));
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument({ ...jobOf(simple), pages: [{ source: "nope", index: 0, rotate: 0 }] }, OPTIONS), reason("unknown-source", 0, "nope"));
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument({ ...jobOf(simple), sources: [{ id: "s", bytes: simple }, { id: "s", bytes: simple }] }, OPTIONS), reason("duplicate-source", null, "s"));
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument({ ...jobOf(simple), pages: [{ source: "s", index: 2, rotate: 0 }] }, OPTIONS), reason("page-index", 0, "s"));
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument({ ...jobOf(simple), pages: [{ source: "s", index: -1, rotate: 0 }] }, OPTIONS), reason("page-index", 0, "s"));
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument({ ...jobOf(simple), pages: [{ blank: [0, 200], rotate: 0 }] }, OPTIONS), reason("blank-size", 0));
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument({ ...jobOf(simple), pages: [{ source: "s", index: 0, rotate: 45 }] }, OPTIONS), reason("rotation", 0));
  // objects that would silently fall off the end of the page list
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument({ ...jobOf(simple), objects: [[], [rect()]] }, OPTIONS), reason("shape"));
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument(jobOf(simple), { ...OPTIONS, underlays: [[{ rect: [0, 0, 10], color: "#ffffff" }]] }), reason("shape", 0));
  await expectError("EXPORT_JOB_INVALID", () => assembleDocument(null, OPTIONS), reason("shape"));
  await expectError("EXPORT_JOB_INVALID", () => drawOnDocument(simple, [[], [], [rect()]], OPTIONS), reason("shape"));
});

test("EXPORT_OBJECT_INVALID: an object that fails the schema, and marks, which this engine must never paint", async () => {
  const withObjects = (objects) => assembleDocument({ ...jobOf(simple), objects: [objects] }, OPTIONS);
  await expectError("EXPORT_OBJECT_INVALID", () => withObjects([rect({ frame: undefined })]), (error) => assert.deepEqual(error.params, { objectId: "r1", type: "rect", problems: ["frame"] }));
  await expectError("EXPORT_OBJECT_INVALID", () => withObjects([{ id: "m1", type: "redact", pageId: "p", rect: [10, 10, 60, 30], color: "#000000" }]), (error) => assert.deepEqual(error.params, { objectId: "m1", type: "redact", problems: ["mark"] }));
  await expectError("EXPORT_OBJECT_INVALID", () => withObjects([{ id: "b1", type: "blur", pageId: "p", rect: [10, 10, 60, 30], style: "pixelate", strength: 2 }]));
  await expectError("EXPORT_OBJECT_INVALID", () => withObjects([{ id: "x1", type: "stamp", pageId: "p" }]), (error) => assert.deepEqual(error.params.problems, ["type"]));
  await expectError("EXPORT_OBJECT_INVALID", () => withObjects([null]));
  // nothing was written: a failed check happens before the first object is drawn
});

const encrypted = await buildEncryptedFixture({ userPassword: "user123" });

test("EXPORT_PASSWORD_REQUIRED / EXPORT_PASSWORD_WRONG / EXPORT_ENCRYPTION_UNSUPPORTED", async () => {
  const source = (error) => assert.deepEqual(error.params, { source: "s" });
  await expectError("EXPORT_PASSWORD_REQUIRED", () => assembleDocument(jobOf(encrypted), OPTIONS), source);
  await expectError("EXPORT_PASSWORD_REQUIRED", () => assembleDocument(jobOf(encrypted, { source: { password: "" } }), OPTIONS), source);
  await expectError("EXPORT_PASSWORD_WRONG", () => assembleDocument(jobOf(encrypted, { source: { password: "not-the-password" } }), OPTIONS), (error) => {
    source(error);
    assert.ok(!error.message.includes("not-the-password") && !JSON.stringify(error.params).includes("not-the-password"), "a password never travels in an error");
  });
  // a security handler the writer does not know (certificate security looks like this to it)
  const foreign = Uint8Array.from(encrypted);
  const at = Buffer.from(foreign).indexOf("/Filter /Standard");
  assert.ok(at > 0);
  foreign[at + "/Filter /Standar".length] = 0x78; // "/Standarx"
  await expectError("EXPORT_ENCRYPTION_UNSUPPORTED", () => assembleDocument(jobOf(foreign, { source: { password: "user123" } }), OPTIONS), source);
  await expectError("EXPORT_PASSWORD_REQUIRED", () => inspectSource(encrypted, { source: "s" }), source);
});

test("EXPORT_SOURCE_DAMAGED: what the writer cannot read", async () => {
  const source = (error) => assert.deepEqual(error.params, { source: "s" });
  const cases = {
    "cut before the catalog": simple.slice(0, 40),
    "an HTML page": Uint8Array.from(Buffer.from("<!doctype html><html><body>This is not a PDF</body></html>")),
    "zero bytes": new Uint8Array(0),
    "only the header line": Uint8Array.from(Buffer.from("%PDF-1.7\n")),
    "not bytes at all": "a string"
  };
  for (const [label, bytes] of Object.entries(cases)) {
    await expectError("EXPORT_SOURCE_DAMAGED", () => assembleDocument(jobOf(bytes), OPTIONS), (error) => {
      source(error);
      assert.ok(!(error instanceof TypeError), label);
    });
  }
  await expectError("EXPORT_SOURCE_DAMAGED", () => inspectSource(cases["cut before the catalog"], { source: "s" }), source);
});

test("EXPORT_PAGE_COUNT_MISMATCH: the writer and the viewer must agree before any page index is used", async () => {
  await expectError("EXPORT_PAGE_COUNT_MISMATCH", () => assembleDocument(jobOf(simple, { source: { expectedPages: 9 } }), OPTIONS), (error) => assert.deepEqual(error.params, { source: "s", writer: 2, viewer: 9 }));
  await expectError("EXPORT_PAGE_COUNT_MISMATCH", () => inspectSource(simple, { source: "s", expectedPages: 3 }));
});

test("EXPORT_TEXT_LAYOUT_MISSING / EXPORT_TEXT_MISSING_GLYPH / EXPORT_FONT_UNAVAILABLE", async () => {
  const draw = (object, options = OPTIONS) => assembleDocument({ ...jobOf(simple), objects: [[object]] }, options);
  const text = () => makeTextObject({ id: "t1", lines: ["Xin chào"], x: 150, y: 100 });

  await expectError("EXPORT_TEXT_LAYOUT_MISSING", () => draw({ ...text(), layout: undefined }), (error) => assert.deepEqual(error.params, { objectId: "t1" }));
  await expectError("EXPORT_TEXT_LAYOUT_MISSING", () => draw({ ...text(), layout: { width: 10, height: 10, lines: [{ baseline: 9, x: 0, width: 10, runs: [{ text: "a", x: 0 }] }], raster: null } }));
  await expectError("EXPORT_TEXT_LAYOUT_MISSING", () => draw({ ...text(), layout: { width: 10, height: 10, lines: [], raster: { png: "not bytes", x: 0, y: 0, w: 10, h: 10 } } }));

  // a character the face has no glyph for: the text service must send it to a fallback run or to a picture
  const cjk = makeTextObject({ id: "t2", lines: ["Giá 漢字"], x: 150, y: 100 });
  await expectError("EXPORT_TEXT_MISSING_GLYPH", () => draw(cjk), (error) => assert.deepEqual(error.params, { objectId: "t2", fontKey: "arimo-regular", characters: "漢字" }));
  const broken = text();
  broken.layout.lines[0].runs[0].text = "hai\ndòng";
  await expectError("EXPORT_TEXT_MISSING_GLYPH", () => draw(broken), (error) => assert.equal(error.params.characters, "\n"));

  await expectError("EXPORT_FONT_UNAVAILABLE", () => draw(text(), { now: NOW }), (error) => assert.deepEqual(error.params, { fontKey: "arimo-regular" }));
  await expectError("EXPORT_FONT_UNAVAILABLE", () => draw(text(), { ...OPTIONS, fonts: async () => { throw new Error("offline"); } }), (error) => assert.equal(error.cause.message, "offline"));
  await expectError("EXPORT_FONT_UNAVAILABLE", () => draw(text(), { ...OPTIONS, fonts: async () => new Uint8Array(0) }));
  await expectError("EXPORT_FONT_UNAVAILABLE", () => draw(text(), { ...OPTIONS, fonts: async () => Uint8Array.from(Buffer.from("this is not a font file at all")) }));
  // the same checks protect the second pass
  const assembled = await assembleDocument(jobOf(simple), OPTIONS);
  await expectError("EXPORT_TEXT_MISSING_GLYPH", () => drawOnDocument(assembled.bytes, [[cjk]], OPTIONS));
});

test("EXPORT_ASSET_MISSING / EXPORT_IMAGE_INVALID", async () => {
  const image = { id: "i1", type: "image", pageId: "p", frame: { x: 100, y: 100, w: 40, h: 30, rot: 0 }, assetId: "a1", role: "image", opacity: 1 };
  const draw = (assets) => assembleDocument({ ...jobOf(simple), objects: [[image]], assets }, OPTIONS);
  await expectError("EXPORT_ASSET_MISSING", () => draw({}), (error) => assert.deepEqual(error.params, { objectId: "i1", assetId: "a1" }));
  await expectError("EXPORT_ASSET_MISSING", () => draw({ a1: { mime: "image/png" } }));
  await expectError("EXPORT_IMAGE_INVALID", () => draw({ a1: { bytes: Uint8Array.from(Buffer.from("GIF89a not supported")), mime: "image/gif" } }), (error) => assert.deepEqual(error.params, { objectId: "i1", assetId: "a1" }));
  await expectError("EXPORT_IMAGE_INVALID", () => draw({ a1: { bytes: SAMPLE_PNG.slice(0, 40), mime: "image/png" } }));
  const raster = makeTextObject({ id: "t3", lines: ["x"], x: 150, y: 100 });
  raster.layout = { width: 10, height: 10, lines: [], raster: { png: Uint8Array.from(Buffer.from("no picture")), x: 0, y: 0, w: 10, h: 10 }, problems: [] };
  await expectError("EXPORT_IMAGE_INVALID", () => assembleDocument({ ...jobOf(simple), objects: [[raster]] }, OPTIONS), (error) => assert.deepEqual(error.params, { objectId: "t3", assetId: null }));
});

test("EXPORT_AUDIT_FAILED: a page object outside the page tree is never written; EXPORT_FAILED wraps the unexpected", async () => {
  const plan = (edit) => ({ sources: [{ id: "s", bytes: simple }], pages: [{ source: "s", index: 0 }], now: NOW, edit });
  await expectError("EXPORT_AUDIT_FAILED", () => exportDocument(plan(({ outDoc, pages }) => {
    // what a leaky copy would produce: a link that keeps a foreign page alive
    const { context } = outDoc;
    const ghost = context.register(PDFPageLeaf.withContextAndParent(context, outDoc.catalog.get(PDFName.of("Pages"))));
    pages[0].node.addAnnot(context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10], Dest: [ghost, "Fit"] })));
  })), (error) => {
    assert.equal(error.params.count, 1);
    assert.match(error.params.problems[0], /not in the page tree/);
  });
  await expectError("EXPORT_FAILED", () => exportDocument(plan(() => {
    throw new TypeError("boom: (text of the document)");
  })), (error) => {
    assert.deepEqual(error.params, { stage: "draw" });
    assert.ok(error.cause instanceof TypeError);
    // what the original error says may quote the document: it is kept as the cause, not repeated in the message
    assert.equal(error.message, "EXPORT_FAILED: unexpected TypeError in stage \"draw\"");
  });
  // the second pass wraps the same way
  const assembled = await assembleDocument(jobOf(simple), OPTIONS);
  await expectError("EXPORT_FAILED", () => drawOnDocument(assembled.bytes, [[rect()]], { ...OPTIONS, onProgress: (fraction, stage) => {
    if (stage === "save") throw new RangeError("from the caller's own callback");
  } }), (error) => assert.deepEqual([error.params, error.cause.name], [{ stage: "save" }, "RangeError"]));
});

test("EXPORT_DOCUMENT_UNREADABLE: drawOnDocument only takes a plain PDF", async () => {
  await expectError("EXPORT_DOCUMENT_UNREADABLE", () => drawOnDocument(Uint8Array.from(Buffer.from("not a pdf")), [[]], OPTIONS), (error) => assert.deepEqual(error.params, {}));
  const openForAll = await buildEncryptedFixture({});
  await expectError("EXPORT_DOCUMENT_UNREADABLE", () => drawOnDocument(openForAll, [[]], OPTIONS));
});

// -----------------------------------------------------------------------------------------------------------
// warnings
// -----------------------------------------------------------------------------------------------------------

/** One page with a "signed" signature field: a /Sig dictionary with a /ByteRange (the bytes are not a real signature). */
async function buildSignedLooking({ useObjectStreams }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([300, 200]);
  const signature = ctx.register(ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 100, 200, 300], Contents: PDFHexString.of("00".repeat(64)) }));
  const widget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature1"), Rect: [20, 20, 120, 60], P: page.ref, F: 132, V: signature }));
  const empty = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature2"), Rect: [150, 20, 250, 60], P: page.ref, F: 4 }));
  page.node.set(PDFName.of("Annots"), ctx.obj([widget, empty]));
  doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [widget, empty], SigFlags: 3 }));
  doc.catalog.set(PDFName.of("Perms"), ctx.obj({ DocMDP: signature }));
  return doc.save({ useObjectStreams });
}

test("EXPORT_SOURCE_SIGNED: a signed source is announced; the output carries no signature artefact", async () => {
  for (const useObjectStreams of [false, true]) {
    const signed = await buildSignedLooking({ useObjectStreams });
    const { bytes, report } = await assembleDocument(jobOf(signed), OPTIONS);
    expectWarning(report, "EXPORT_SOURCE_SIGNED", { source: "s", signatures: 1 });
    assert.equal(report.sources.s.copy.signaturesDropped, 1);
    const facts = await fileFacts(bytes);
    assert.equal(facts.hasByteRange, false);
    assert.ok(!facts.catalogKeys.includes("Perms"));
    // the empty field stays: it can be signed again; /SigFlags says "signature fields exist", never "signed"
    const acroForm = facts.doc.catalog.lookup(PDFName.of("AcroForm"));
    assert.equal(acroForm.lookup(PDFName.of("Fields")).size(), 1);
    assert.equal(acroForm.lookup(PDFName.of("SigFlags")).asNumber(), 1);
    const inspected = await inspectSource(signed, { source: "s" });
    assert.equal(inspected.signatures, 1);
    assert.equal(inspected.hasSignatureField, true);
    assert.deepEqual(inspected.warnings, [{ code: "EXPORT_SOURCE_SIGNED", params: { source: "s", signatures: 1 } }]);
  }
});

const linked = await buildLinkedFixture();

test("EXPORT_XFA_DROPPED / EXPORT_ATTACHMENTS_DROPPED / EXPORT_OUTLINE_TRUNCATED / EXPORT_OBJECT_BELOW_ANNOTATION", async () => {
  const overField = rect({ id: "over", frame: { x: 105, y: 109, w: 150, h: 18, rot: 0 } });
  const { report } = await assembleDocument({ ...jobOf(linked.bytes), objects: [[overField]] }, OPTIONS);
  expectWarning(report, "EXPORT_XFA_DROPPED", { source: "s" });
  expectWarning(report, "EXPORT_ATTACHMENTS_DROPPED", { source: "s", files: 1 });
  expectWarning(report, "EXPORT_OBJECT_BELOW_ANNOTATION", { page: 0, objectId: "over", subtype: "Widget" });

  const truncated = await exportDocument({ sources: [{ id: "s", bytes: linked.bytes }], pages: [{ source: "s", index: 0 }], now: NOW, limits: { outlineItems: 3 } });
  expectWarning(truncated.report, "EXPORT_OUTLINE_TRUNCATED", { source: "s", items: 3 });
});

test("EXPORT_OUTLINE_RETARGETED: a bookmark of a removed page that stays because bookmarks below it are kept", async () => {
  // "Chapter 1" of the fixture points at page 1 and has a child on page 3: without page 1 it is such a bookmark
  const { report } = await assembleDocument({ ...jobOf(linked.bytes), pages: [{ source: "s", index: 2, rotate: 0 }], objects: [[]] }, OPTIONS);
  expectWarning(report, "EXPORT_OUTLINE_RETARGETED", { source: "s", items: 1 });
  assert.equal(report.sources.s.outline.retargeted, 1);
  const dropped = await assembleDocument({ ...jobOf(linked.bytes), pages: [{ source: "s", index: 2, rotate: 0 }], objects: [[]] }, { ...OPTIONS, dropOrphanBookmarks: true });
  assert.deepEqual(dropped.report.warnings.filter((warning) => warning.code === "EXPORT_OUTLINE_RETARGETED"), []);
});

test("EXPORT_STREAMS_REPAIRED / EXPORT_STREAMS_DAMAGED: streams whose length the parser gets wrong", async () => {
  // data that ends with a carriage return: the parser takes it for the end-of-line before "endstream"
  const repaired = await assembleDocument(jobOf(rawPdfWithIndirectLength("BT /F1 12 Tf 20 100 Td (TAIL) Tj ET\r", { eolBeforeEndstream: "\n" })), OPTIONS);
  expectWarning(repaired.report, "EXPORT_STREAMS_REPAIRED", { source: "s", streams: 1 });
  assert.deepEqual(await extractText(repaired.bytes), ["TAIL"]);
  // a declared length that points nowhere: nothing to re-read, the page keeps what the parser found
  const damaged = await assembleDocument(jobOf(rawPdfWithIndirectLength("BT /F1 12 Tf 20 100 Td (KEPT) Tj ET", { declared: 20 })), OPTIONS);
  expectWarning(damaged.report, "EXPORT_STREAMS_DAMAGED", { source: "s", streams: 1 });
  assert.deepEqual(await extractText(damaged.bytes), ["KEPT"]);
});

test("EXPORT_PAGE_TREE_REPAIRED / EXPORT_OBJECTS_UNPARSED", async () => {
  const content = (text) => streamBody("", `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`);
  // the second page has no /Type: the library alone would skip it and every later index would be off by one
  const untyped = rawPdf([...skeleton([4, 6, 8]), { num: 4, body: rawPage(5) }, { num: 5, body: content("ONE") }, { num: 6, body: rawPage(7, { type: "" }) }, { num: 7, body: content("TWO") }, { num: 8, body: rawPage(9) }, { num: 9, body: content("THREE") }]);
  assert.equal((await PDFDocument.load(untyped, { updateMetadata: false })).getPageCount(), 2, "the library alone sees two pages");
  const fixed = await assembleDocument(jobOf(untyped, { source: { expectedPages: 3 } }, 3), OPTIONS);
  expectWarning(fixed.report, "EXPORT_PAGE_TREE_REPAIRED", { source: "s", pages: 1 });
  assert.deepEqual(await extractText(fixed.bytes), ["ONE", "TWO", "THREE"]);

  // An object with syntax the library cannot parse but that is complete in itself (here: a second font the page
  // lists, with a number written --5 and a reference in it) travels as raw bytes, its reference renumbered.
  const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R /F2 7 0 R >> >> /Contents 5 0 R >>";
  const odd = (seven) => rawPdf([
    ...skeleton([4]), { num: 4, body: page }, { num: 5, body: content("STILL HERE") }, { num: 7, body: seven },
    { num: 8, body: "<< /Nobody /RefersToThis (((" }, { num: 9, body: "<< /Type /FontDescriptor /FontName /OddFont /Flags 32 >>" }
  ]);
  const passed = await assembleDocument(jobOf(odd("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /OddNumber --5 /FontDescriptor 9 0 R >>")), OPTIONS);
  expectWarning(passed.report, "EXPORT_OBJECTS_UNPARSED", { source: "s", objects: 1 }); // object 8 is broken too, but nothing reaches it
  assert.deepEqual(await extractText(passed.bytes), ["STILL HERE"]);
  const written = Buffer.from(passed.bytes).toString("latin1");
  assert.ok(written.includes("/OddNumber --5"), "the same odd object is in the output, byte for byte ...");
  const descriptor = /\/OddNumber --5 \/FontDescriptor (\d+) 0 R/.exec(written);
  assert.ok(descriptor && descriptor[1] !== "9", "... but its reference names the object's new number");
  const reloaded = await PDFDocument.load(passed.bytes, { updateMetadata: false });
  assert.equal(String(reloaded.context.lookup(pdfLib.PDFRef.of(Number(descriptor[1]))).get(PDFName.of("FontName"))), "/OddFont", "and what it referred to came along");
  assert.ok(!written.includes("/RefersToThis"));

  // The same font with a string that is never closed is NOT complete in itself: a viewer reads on behind the
  // object, so its meaning depends on what follows it in the file. It cannot be carried over: no export.
  await expectError("EXPORT_SOURCE_DAMAGED", () => assembleDocument(jobOf(odd("<< /Type /Font /BaseFont (((unbalanced >>")), OPTIONS), (error) => assert.deepEqual(error.params, { source: "s" }));
});

test("EXPORT_SOURCE_INCONSISTENT: a file of which the viewer and the writer read different objects is for viewing only", async () => {
  // the content stream of the page is defined twice; the cross-reference table points at the first definition,
  // the parser of the library keeps the last one (tests/pdfExportConsistency.test.mjs has every variant)
  const content = (text) => streamBody("", `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`);
  const twice = rawPdfWithTable([...skeleton([4]), { num: 4, body: rawPage(5) }, { num: 5, body: content("SHOWN-BY-THE-VIEWER") }, { num: 5, body: content("TAKEN-BY-THE-WRITER"), table: false }]);
  assert.deepEqual(await extractText(twice), ["SHOWN-BY-THE-VIEWER"]);
  const source = (error) => {
    assert.deepEqual(error.params, { source: "s" });
    assert.ok(!error.message.includes("SHOWN") && !error.message.includes("TAKEN"), "no text of the document in the message");
  };
  await expectError("EXPORT_SOURCE_INCONSISTENT", () => assembleDocument(jobOf(twice), OPTIONS), source);
  await expectError("EXPORT_SOURCE_INCONSISTENT", () => inspectSource(twice, { source: "s" }), source);
  // as a document to draw on it is simply not usable
  await expectError("EXPORT_DOCUMENT_UNREADABLE", () => drawOnDocument(twice, [[]], OPTIONS));
});

test("EXPORT_RESOURCES_NOT_PRUNED / EXPORT_PAGE_CONTENT_UNREADABLE: a page whose content cannot be read", async () => {
  const opaque = await buildSharedResourcesFixture({ unreadablePage: 0 });
  const { report } = await assembleDocument({ ...jobOf(opaque.bytes), objects: [[rect()]] }, OPTIONS);
  expectWarning(report, "EXPORT_RESOURCES_NOT_PRUNED", { source: "s", pages: 1 });
  expectWarning(report, "EXPORT_PAGE_CONTENT_UNREADABLE", { page: 0 });
});

// -----------------------------------------------------------------------------------------------------------
// cancelling and progress
// -----------------------------------------------------------------------------------------------------------

test("a cancelled job ends with the shared code CANCELLED; progress goes from 0 to 1 through the stages", async () => {
  const already = new AbortController();
  already.abort();
  await assert.rejects(() => assembleDocument(jobOf(simple), { ...OPTIONS, signal: already.signal }), (error) => isPdfEditorError(error) && error.code === CANCELLED);
  await assert.rejects(() => drawOnDocument(simple, [[]], { ...OPTIONS, signal: already.signal }), (error) => error.code === CANCELLED);

  const during = new AbortController();
  const stagesSeen = [];
  await assert.rejects(() => assembleDocument(jobOf(simple), {
    ...OPTIONS,
    signal: during.signal,
    onProgress: (fraction, stage) => {
      stagesSeen.push(stage);
      if (stage === "copy") during.abort();
    }
  }), (error) => error.code === CANCELLED);
  assert.ok(stagesSeen.includes("copy") && !stagesSeen.includes("save"), `stopped after ${stagesSeen}`);

  const calls = [];
  const text = makeTextObject({ lines: ["tiến độ"], x: 150, y: 100 });
  await assembleDocument({ ...jobOf(simple, {}, 2), objects: [[text], [rect()]] }, { ...OPTIONS, onProgress: (fraction, stage) => calls.push([fraction, stage]) });
  assert.equal(calls[0][0], 0);
  assert.equal(calls[calls.length - 1][0], 1);
  calls.forEach(([fraction, stage], index) => {
    assert.ok(STAGES.includes(stage), stage);
    if (index > 0) assert.ok(fraction > calls[index - 1][0], "strictly increasing");
    if (index > 0) assert.ok(STAGES.indexOf(stage) >= STAGES.indexOf(calls[index - 1][1]), "stages in order");
  });
  assert.deepEqual([...new Set(calls.map(([, stage]) => stage))], [...STAGES]);
});

test("inspectSource: what the user interface learns before editing", async () => {
  const facts = await inspectSource(linked.bytes, { source: "fx", expectedPages: 4 });
  assert.equal(facts.pages, 4);
  assert.equal(facts.encrypted, false);
  assert.equal(facts.version, "1.7");
  assert.equal(facts.signatures, 0);
  assert.equal(facts.attachments, 1);
  assert.equal(facts.outlineItems, 9);
  assert.equal(facts.form.fields, 5, "only1, secret2, shared, group.child1, group.child2");
  assert.equal(facts.form.hasXFA, true);
  assert.deepEqual([facts.tagged, facts.certified, facts.hasSignatureField], [true, false, false]);
  assert.equal(facts.info.title, "Tài liệu thử nghiệm XREF");
  assert.deepEqual(facts.warnings, [{ code: "EXPORT_XFA_DROPPED", params: { source: "fx" } }]);
  const secret = await inspectSource(encrypted, { password: "user123" });
  assert.equal(secret.encrypted, true);
  assert.equal(secret.pages, 3);
  // The library alone loses /Info of an encrypted file with a cross-reference stream; the engine takes it from
  // the trailer the viewer uses (robust.js): the title is there without any help of the caller.
  assert.equal(secret.info.title, ENCRYPTED_TITLE);
});

test("every code of CODES was produced by a test above", () => {
  const missing = Object.keys(CODES).filter((code) => !produced.has(code));
  assert.deepEqual(missing, []);
});
