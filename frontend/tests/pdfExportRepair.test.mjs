// engine/export: regression tests of the defects an independent review found in the first version of the
// engine (what leaked, what failed, what changed a page), one group per defect. The writer-versus-viewer
// check has a file of its own (pdfExportConsistency.test.mjs).
//
//   forms and actions    nothing of a removed page's fields survives through an action, a field name or a
//                        /Parent chain; an annotation dropped from a KEPT page never fails the export
//   isolation            a Q without q in the page content: the page looks as the viewer showed it
//   resource pruning     names that are not the first operand; a page that cannot be read and names a
//                        picture of a removed page; an object reached through a key nobody knows
//   unparsed objects     odd syntax a viewer reads travels byte for byte with its references renumbered
//   the rest             signed input of drawOnDocument, glyphs shared by two characters, bookmarks of
//                        removed pages, the /URI base, the clock of the job
import test from "node:test";
import assert from "node:assert/strict";
import { assembleDocument, drawOnDocument, inspectSource } from "../src/pages/pdfEditor/engine/export/index.js";
import { analyseBalance, tokenizeContent } from "../src/pages/pdfEditor/engine/export/contentTokens.js";
import { isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { canRender, extractText, loadFont, pdfLib, withPdf } from "./helpers/pdfTestKit.mjs";
import { makeTextObject, noiseBytes, rawPdfWithTable, streamBody } from "./helpers/pdfExportFixtures.mjs";
import { fileFacts, loadPlain, pageContentText, resourceNames, textLeaks } from "./helpers/pdfExportScan.mjs";
import { differingPixels, findColorBox, firstDifference, outlineOf, renderAll } from "./helpers/pdfExportRender.mjs";

const { PDFDocument, PDFName, PDFString, PDFHexString, PDFRef, PDFDict, PDFArray, PDFInvalidObject, PDFStream } = pdfLib;
const N = (name) => PDFName.of(name);
const NOW = new Date(Date.UTC(2026, 10, 20, 2, 0, 0));
const OPTIONS = { fonts: loadFont, now: NOW, idSeed: new Uint8Array(16).fill(7) };
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const codes = (report) => report.warnings.map((warning) => warning.code);

// ---- hand-written documents: catalog 1, page tree 2, Helvetica 3, pages from object 4 on ----------------
const FONT = { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" };
const page = (contents, extra = "", resources = "<< /Font << /F1 3 0 R >> >>") => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources ${resources} /Contents ${contents} ${extra} >>`;
const text = (words, y = 150) => streamBody("", `BT /F1 14 Tf 20 ${y} Td (${words}) Tj ET`);
/** A document whose pages are the objects `pageNums`; `objects` holds them and everything else. */
const documentOf = (pageNums, objects, catalogExtra = "") => rawPdfWithTable([
  { num: 1, body: `<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>` },
  { num: 2, body: `<< /Type /Pages /Kids [${pageNums.map((num) => `${num} 0 R`).join(" ")}] /Count ${pageNums.length} >>` },
  FONT,
  ...objects
]);
const jobOf = (bytes, pages = [0], objects) => ({
  sources: [{ id: "s", bytes }],
  pages: pages.map((index) => ({ source: "s", index, rotate: 0 })),
  objects: objects || pages.map(() => []),
  marks: [], assets: {}, info: {}, fileName: "repair"
});
const widget = (pageNum, extra, rect = "[20 20 120 40]") => `<< /Type /Annot /Subtype /Widget /Rect ${rect} /P ${pageNum} 0 R ${extra} >>`;
const square = (extra = {}) => ({ id: "sq", type: "rect", pageId: "p", frame: { x: 280, y: 180, w: 20, h: 20, rot: 0 }, stroke: null, strokeWidth: 0, dash: "solid", fill: "#ff00ff", opacity: 1, ...extra });
/** The exported file as the library reads it. */
const reload = (bytes) => loadPlain(bytes);
const annotsOf = (doc, pageIndex) => {
  const annots = doc.getPage(pageIndex).node.Annots();
  return annots ? annots.asArray().map((ref) => doc.context.lookup(ref)) : [];
};

// -----------------------------------------------------------------------------------------------------------
// defect 1: form values and field names of a removed page
// -----------------------------------------------------------------------------------------------------------

test("fields of a removed page do not survive through the actions of kept annotations", async (t) => {
  // two pages (objects 4 and 5); page 2 is removed in every case
  const twoPages = (annots1, annots2, objects, catalogExtra) => documentOf([4, 5], [
    { num: 4, body: page("10 0 R", `/Annots [${annots1}]`) },
    { num: 5, body: page("11 0 R", `/Annots [${annots2}]`) },
    { num: 10, body: text("KEPT PAGE TEXT") },
    { num: 11, body: text("REMOVED PAGE TEXT") },
    ...objects
  ], catalogExtra);
  const cases = {
    "a reset button on the kept page lists the radio group of the removed page": {
      bytes: twoPages("21 0 R", "23 0 R 24 0 R", [
        { num: 20, body: "<< /FT /Btn /Ff 49152 /T (GENDER-OF-PAGE-TWO) /V /SECRETCHOICE-P2 /Kids [23 0 R 24 0 R] >>" },
        { num: 21, body: widget(4, "/FT /Btn /Ff 65536 /T (ResetButton) /A << /S /ResetForm /Fields [20 0 R] /Flags 0 >>") },
        { num: 23, body: widget(5, "/Parent 20 0 R /AS /SECRETCHOICE-P2") },
        { num: 24, body: widget(5, "/Parent 20 0 R /AS /Off", "[140 20 160 40]") }
      ], "/AcroForm << /Fields [20 0 R 21 0 R] >>"),
      secrets: ["GENDER-OF-PAGE-TWO", "SECRETCHOICE-P2"],
      check: (doc, copy) => {
        const [button] = annotsOf(doc, 0);
        assert.equal(button.get(N("A")), undefined, "an action that lost every field it was written for goes: it would reset ALL fields");
        assert.deepEqual([copy.actionTargetsDropped, copy.actionsDropped, copy.fieldsBlanked], [1, 1, 1]);
      }
    },
    "a submit button lists the field of the removed page by reference AND by name": {
      bytes: twoPages("21 0 R 22 0 R", "23 0 R 24 0 R", [
        { num: 20, body: "<< /FT /Tx /T (FULLNAME-OF-PAGE-TWO) /V (SECRET PERSON NAME-P2) /Kids [23 0 R 24 0 R] >>" },
        { num: 21, body: widget(4, "/FT /Btn /Ff 65536 /T (SendButton) /A << /S /SubmitForm /F << /FS /URL /F (https://example.test/submit) >> /Fields [20 0 R (FULLNAME-OF-PAGE-TWO) (KeptField) 22 0 R] >>") },
        { num: 22, body: widget(4, "/FT /Tx /T (KeptField) /V (KEPT-VALUE-P1)", "[20 60 120 80]") },
        { num: 23, body: widget(5, "/Parent 20 0 R") },
        { num: 24, body: widget(5, "/Parent 20 0 R", "[20 60 120 80]") }
      ], "/AcroForm << /Fields [20 0 R 21 0 R 22 0 R] >>"),
      secrets: ["FULLNAME-OF-PAGE-TWO", "SECRET PERSON NAME-P2"],
      check: (doc, copy) => {
        const fields = annotsOf(doc, 0)[0].lookup(N("A")).lookup(N("Fields"), PDFArray);
        assert.equal(fields.size(), 2, "the name and the reference of the kept field stay");
        assert.equal(latin1(fields.get(0).asBytes()), "KeptField");
        assert.equal(doc.context.lookup(fields.get(1)), annotsOf(doc, 0)[1]);
        assert.equal(copy.actionTargetsDropped, 2);
      }
    },
    "no /AcroForm in the catalog: the /Parent of a kept widget leads to a field of the removed page": {
      bytes: twoPages("21 0 R", "23 0 R", [
        { num: 20, body: "<< /T (person) /Kids [21 0 R 22 0 R] >>" },
        { num: 21, body: widget(4, "/FT /Tx /T (name) /V (KEPT NAME-P1) /Parent 20 0 R") },
        { num: 22, body: "<< /FT /Tx /T (SECRETFIELD-P2) /V (SECRET-SSN-123-P2) /Parent 20 0 R /Kids [23 0 R] >>" },
        { num: 23, body: widget(5, "/Parent 22 0 R") }
      ]),
      secrets: ["SECRETFIELD-P2", "SECRET-SSN-123-P2"],
      check: (doc, copy) => {
        const parent = annotsOf(doc, 0)[0].lookup(N("Parent"), PDFDict);
        assert.equal(parent.lookup(N("Kids"), PDFArray).size(), 1, "the branch of the removed page is cut out of /Kids");
        assert.equal(doc.catalog.get(N("AcroForm")), undefined, "no form is invented for a file that had none");
        assert.equal(copy.fieldsBlanked, 1);
      }
    },
    "a widget of the kept page with a Thread action (the article runs over the removed page)": {
      bytes: twoPages("21 0 R", "", [
        { num: 21, body: widget(4, "/FT /Btn /Ff 65536 /T (GoButton) /A << /S /Thread /D 30 0 R /B 32 0 R >>") },
        { num: 30, body: "<< /Type /Thread /F 31 0 R /I << /Title (SECRET-THREAD-TITLE-P2) >> >>" },
        { num: 31, body: "<< /Type /Bead /T 30 0 R /N 32 0 R /V 32 0 R /P 4 0 R /R [0 0 10 10] >>" },
        { num: 32, body: "<< /Type /Bead /T 30 0 R /N 31 0 R /V 31 0 R /P 5 0 R /R [0 0 10 10] /Note (SECRET-BEAD-NOTE-P2) >>" }
      ], "/AcroForm << /Fields [21 0 R] >> /Threads [30 0 R]"),
      secrets: ["SECRET-THREAD-TITLE-P2", "SECRET-BEAD-NOTE-P2"],
      goesAnyway: true, // article threads are never carried over, whichever pages are kept
      check: (doc) => assert.equal(annotsOf(doc, 0)[0].get(N("A")), undefined)
    },
    "a hide action, an /AA entry and a /Next chain name fields of the removed page": {
      bytes: twoPages("21 0 R 22 0 R", "23 0 R", [
        { num: 20, body: "<< /FT /Tx /T (HIDDENFIELD-OF-P2) /V (HIDDEN-VALUE-OF-P2) /Kids [23 0 R] >>" },
        { num: 21, body: widget(4, "/FT /Btn /Ff 65536 /T (ToggleButton) /A << /S /Hide /T [(HIDDENFIELD-OF-P2) 23 0 R 22 0 R] /H true /Next << /S /ResetForm /Fields [20 0 R] >> >> /AA << /U << /S /SubmitForm /F (https://example.test/) /Fields [(HIDDENFIELD-OF-P2)] >> /D << /S /URI /URI (https://example.test/kept) /Next [<< /S /ResetForm /Fields [20 0 R] >> << /S /Named /N /NextPage >>] >> >>") },
        { num: 22, body: widget(4, "/FT /Tx /T (KeptField) /V (KEPT-VALUE-P1)", "[20 60 120 80]") },
        { num: 23, body: widget(5, "/Parent 20 0 R") }
      ], "/AcroForm << /Fields [20 0 R 21 0 R 22 0 R] >>"),
      secrets: ["HIDDENFIELD-OF-P2", "HIDDEN-VALUE-OF-P2"],
      check: (doc) => {
        const button = annotsOf(doc, 0)[0];
        const hide = button.lookup(N("A"), PDFDict);
        assert.equal(hide.lookup(N("T"), PDFArray).size(), 1, "only the field of the kept page is still hidden by it");
        assert.equal(hide.get(N("Next")), undefined);
        const additional = button.lookup(N("AA"), PDFDict);
        assert.equal(additional.get(N("U")), undefined, "a submit action whose only field is gone");
        const down = additional.lookup(N("D"), PDFDict);
        assert.equal(latin1(down.lookup(N("URI")).asBytes()), "https://example.test/kept");
        assert.equal(down.lookup(N("Next"), PDFArray).size(), 1, "the harmless part of the chain stays");
      }
    },
    "a field tree of the removed page that /Fields does not list, named by a link of the kept page": {
      bytes: twoPages("21 0 R 22 0 R", "31 0 R", [
        { num: 21, body: "<< /Type /Annot /Subtype /Link /Rect [20 20 120 40] /A << /S /ResetForm /Fields [30 0 R] >> >>" },
        { num: 22, body: widget(4, "/FT /Tx /T (KeptField) /V (KEPT-VALUE-P1)", "[20 60 120 80]") },
        { num: 30, body: "<< /FT /Tx /T (ORPHAN-FIELD-OF-P2) /V (ORPHAN-VALUE-OF-P2) /Kids [31 0 R] >>" },
        { num: 31, body: widget(5, "/Parent 30 0 R") }
      ], "/AcroForm << /Fields [22 0 R] >>"),
      secrets: ["ORPHAN-FIELD-OF-P2", "ORPHAN-VALUE-OF-P2"],
      check: (doc, copy) => {
        assert.equal(annotsOf(doc, 0).length, 1, "a link without its action is no link");
        assert.equal(copy.linksDropped, 1);
      }
    }
  };
  for (const [label, spec] of Object.entries(cases)) {
    await t.test(label, async () => {
      assert.deepEqual(await textLeaks(spec.bytes, spec.secrets), spec.secrets, "the fixture holds what the test looks for");
      const { bytes, report } = await assembleDocument(jobOf(spec.bytes, [0]), OPTIONS);
      assert.deepEqual(await textLeaks(bytes, [...spec.secrets, "REMOVED PAGE TEXT"]), [], "nothing of the removed page is in the file");
      assert.deepEqual(await extractText(bytes), ["KEPT PAGE TEXT"]);
      const facts = await fileFacts(bytes);
      assert.deepEqual([facts.orphans, facts.audit], [[], []]);
      spec.check(facts.doc, report.sources.s.copy);
      // and with both pages kept nothing is taken away
      const whole = await assembleDocument(jobOf(spec.bytes, [0, 1]), OPTIONS);
      assert.deepEqual(await textLeaks(whole.bytes, spec.secrets), spec.goesAnyway ? [] : spec.secrets);
      assert.deepEqual([whole.report.sources.s.copy.fieldsBlanked, whole.report.sources.s.copy.actionTargetsDropped], [0, 0]);
    });
  }
});

// -----------------------------------------------------------------------------------------------------------
// defect 5: an annotation dropped from a KEPT page must not fail the export
// -----------------------------------------------------------------------------------------------------------

test("something that refers to an annotation dropped from a kept page: the export succeeds and the annotation is gone", async (t) => {
  const onePage = (annots, objects, catalogExtra) => documentOf([4, 5], [
    { num: 4, body: page("10 0 R", `/Annots [${annots}]`) },
    { num: 5, body: page("11 0 R") },
    { num: 10, body: text("KEPT PAGE TEXT") },
    { num: 11, body: text("SECOND PAGE TEXT") },
    ...objects
  ], catalogExtra);
  const cases = {
    "forms are not kept; a link of the same page resets one of its fields": {
      bytes: onePage("20 0 R 21 0 R", [
        { num: 20, body: widget(4, "/FT /Tx /T (NoteField) /V (VALUE-OF-DROPPED-FIELD)") },
        { num: 21, body: "<< /Type /Annot /Subtype /Link /Rect [150 20 250 40] /A << /S /ResetForm /Fields [20 0 R] >> >>" }
      ], "/AcroForm << /Fields [20 0 R] >>"),
      pages: [0, 1], options: { keepForms: false }, gone: ["VALUE-OF-DROPPED-FIELD", "NoteField"], annots: 0
    },
    "a note replies (/IRT) to a link whose target page is removed": {
      bytes: onePage("20 0 R 21 0 R", [
        { num: 20, body: "<< /Type /Annot /Subtype /Link /Rect [150 20 250 40] /Dest [5 0 R /Fit] >>" },
        { num: 21, body: "<< /Type /Annot /Subtype /Text /Rect [20 20 40 40] /Contents (REPLY-TEXT-KEPT) /IRT 20 0 R /RT /R /P 4 0 R >>" }
      ]),
      pages: [0], options: {}, gone: [], annots: 1,
      check: (doc) => assert.deepEqual([annotsOf(doc, 0)[0].get(N("IRT")), annotsOf(doc, 0)[0].get(N("RT"))], [undefined, undefined])
    },
    "a hide action of a kept button names a signed signature field of the same page": {
      bytes: onePage("20 0 R 21 0 R", [
        { num: 20, body: widget(4, "/FT /Sig /T (SignatureField) /V << /Type /Sig /Filter /Adobe.PPKLite /Name (SIGNER-NAME-DROPPED) /Contents <00> /ByteRange [0 1 2 3] >>") },
        { num: 21, body: widget(4, "/FT /Btn /Ff 65536 /T (ToggleButton) /A << /S /Hide /T [20 0 R] /H true >>", "[150 20 250 40]") }
      ], "/AcroForm << /Fields [20 0 R 21 0 R] /SigFlags 3 >>"),
      pages: [0, 1], options: {}, gone: ["SIGNER-NAME-DROPPED", "SignatureField"], annots: 1
    }
  };
  for (const [label, spec] of Object.entries(cases)) {
    await t.test(label, async () => {
      // before the repair each of these ended in EXPORT_AUDIT_FAILED: no export at all
      const { bytes, report } = await assembleDocument(jobOf(spec.bytes, spec.pages), { ...OPTIONS, ...spec.options });
      const facts = await fileFacts(bytes);
      assert.deepEqual([facts.orphans, facts.audit, report.audit], [[], [], []]);
      assert.equal(annotsOf(facts.doc, 0).length, spec.annots);
      assert.deepEqual(await textLeaks(bytes, spec.gone), []);
      assert.ok(report.sources.s.copy.annotsBlanked >= 1, "the dropped annotation is blanked, so that nothing keeps it alive");
      if (spec.check) spec.check(facts.doc);
    });
  }
});

// -----------------------------------------------------------------------------------------------------------
// defect 3: a Q without q in the page content
// -----------------------------------------------------------------------------------------------------------

const STRAY_RESTORES = {
  "balanced (control)": ["q 0.5 0 0 0.5 100 60 cm 1 0 0 rg 0 0 100 100 re f Q"],
  "an extra Q at the very end": ["q 1 0 0 rg 20 20 100 100 re f Q Q"],
  "a matrix, then a Q without q, then drawing": ["0.5 0 0 0.5 100 60 cm\nQ\n1 0 0 rg 0 0 100 100 re f"],
  "a top-level flip matrix (as Chrome and pdfkit write), a stray Q in the middle": ["1 0 0 -1 0 200 cm\n0 0 1 rg 10 10 60 20 re f\nQ\n0 0.6 0 rg 10 50 80 30 re f"],
  "a colour, then a Q without q, then drawing": ["1 0 0 rg\nQ\n20 20 100 100 re f"],
  "two streams: the first ends with Q Q, the second draws with the matrix of the first": ["q 1 0 0 rg 5 5 20 20 re f Q 2 0 0 2 30 30 cm Q", "0 0 1 rg 0 0 40 40 re f"]
};
const operationsOf = (source) => tokenizeContent(new Uint8Array(Buffer.from(source, "latin1"))).operations;
const strayDocument = (parts) => documentOf([4], [
  { num: 4, body: page(`[${parts.map((_, index) => `${10 + index} 0 R`).join(" ")}]`) },
  ...parts.map((part, index) => ({ num: 10 + index, body: streamBody("", part) }))
]);

test("a Q that has nothing to restore: after drawing, the content of the page is balanced and holds no such Q", async () => {
  for (const [label, parts] of Object.entries(STRAY_RESTORES)) {
    const source = strayDocument(parts);
    const stray = analyseBalance(operationsOf(parts.join("\n"))).underflow;
    for (const run of ["one pass", "two passes"]) {
      const out = run === "one pass"
        ? await assembleDocument(jobOf(source, [0], [[square()]]), OPTIONS)
        : await drawOnDocument((await assembleDocument(jobOf(source, [0]), OPTIONS)).bytes, [[square()]], OPTIONS);
      assert.deepEqual(codes(out.report), [], `${label}, ${run}`);
      const written = pageContentText((await reload(out.bytes)).getPage(0));
      const balance = analyseBalance(operationsOf(written));
      assert.deepEqual([balance.underflow, balance.endDepth, balance.balanced], [0, 0, true], `${label}, ${run}: ${written}`);
      // ONE q in front: every stray Q would otherwise restore the wrapper's state in the middle of the page
      assert.match(written, /^q\n(?!q)/, `${label}, ${run}`);
      // the page's own content: everything up to the closing line of the wrapper ("Q" alone on a line)
      const own = written.slice(2, written.indexOf("\n\nQ\n"));
      assert.ok(written.includes("\n\nQ\n"), `${label}, ${run}: ${written}`);
      const restores = (source) => operationsOf(source).filter((operation) => operation.op === "Q").length;
      assert.equal(analyseBalance(operationsOf(own)).underflow, 0, `${label}, ${run}`);
      assert.equal(restores(own), restores(parts.join("\n")) - stray, `${label}, ${run}: the page keeps its own Q, the ones without a q are blanked`);
    }
    // nothing drawn: the page content is not touched at all
    const untouched = await assembleDocument(jobOf(source, [0]), OPTIONS);
    assert.equal(pageContentText((await reload(untouched.bytes)).getPage(0)).trim(), parts.join("\n").trim(), label);
  }
});

test("a Q that has nothing to restore: what the page showed is still there after one object was drawn", { skip: !canRender && "no canvas binary on this platform" }, async () => {
  for (const [label, parts] of Object.entries(STRAY_RESTORES)) {
    const source = strayDocument(parts);
    const [before] = await renderAll(source, { scale: 2 });
    const drawn = await assembleDocument(jobOf(source, [0], [[square()]]), OPTIONS);
    const later = await drawOnDocument((await assembleDocument(jobOf(source, [0]), OPTIONS)).bytes, [[square()]], OPTIONS);
    for (const [run, out] of [["one pass", drawn], ["two passes", later]]) {
      const [after] = await renderAll(out.bytes, { scale: 2 });
      const box = findColorBox(after, [255, 0, 255], 20);
      assert.ok(box && Math.abs(box.cx - 560) <= 1 && Math.abs(box.cy - 40) <= 1 && Math.abs(box.w - 40) <= 1, `${label}, ${run}: the square is at ${JSON.stringify(box)}`);
      const exclude = [{ x: 536, y: 16, w: 48, h: 48 }];
      assert.equal(differingPixels(before, after, exclude), 0, `${label}, ${run}: ${firstDifference(before, after, exclude)}`);
    }
  }
});

// -----------------------------------------------------------------------------------------------------------
// defects 4 and 6: resource pruning
// -----------------------------------------------------------------------------------------------------------

/** A picture whose bytes can be searched for in a file: stored as raw grey samples. */
function picture(seed) {
  const pixels = noiseBytes(16 * 16, seed);
  return { body: streamBody("/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.from(pixels)), signature: Buffer.from(pixels.slice(64, 112)) };
}

test("a kept page that cannot be read and names a picture of a removed page: the picture stays, and the report says so", async () => {
  const [mine, theirs] = [picture(4101), picture(4102)];
  const build = (content1) => documentOf([4, 5], [
    // page 1 has a dictionary of its OWN that lists both pictures; page 2 lists and draws the second
    { num: 4, body: page("10 0 R", "", "<< /Font << /F1 3 0 R >> /XObject << /Im1 12 0 R /Im2 13 0 R >> >>") },
    { num: 5, body: page("11 0 R", "", "<< /Font << /F1 3 0 R >> /XObject << /Im2 13 0 R >> >>") },
    { num: 10, body: streamBody("", content1) },
    { num: 11, body: streamBody("", "q 60 0 0 60 20 40 cm /Im2 Do Q") },
    { num: 12, body: mine.body },
    { num: 13, body: theirs.body }
  ]);
  const readable = await assembleDocument(jobOf(build("q 60 0 0 60 20 40 cm /Im1 Do Q"), [0]), OPTIONS);
  assert.ok(Buffer.from(readable.bytes).includes(mine.signature) && !Buffer.from(readable.bytes).includes(theirs.signature), "control: the unused entry is pruned");
  // (two entries: the second picture, and the font that this page never selects)
  assert.deepEqual([codes(readable.report), readable.report.sources.s.copy.resources], [[], { pages: 1, forms: 0, removed: 2, unresolved: [] }]);

  // content that no tokenizer understands to the end: nothing can be proven about what it uses
  const opaque = await assembleDocument(jobOf(build("q 60 0 0 60 20 40 cm /Im1 Do Q (unterminated"), [0]), OPTIONS);
  assert.ok(Buffer.from(opaque.bytes).includes(theirs.signature), "nothing was removed without proof");
  assert.deepEqual(opaque.report.warnings, [{ code: "EXPORT_RESOURCES_NOT_PRUNED", params: { source: "s", pages: 1 } }]);
  assert.deepEqual(opaque.report.sources.s.copy.resources, { pages: 0, forms: 0, removed: 0, unresolved: [0] });
  // the same page in a file from which nothing is removed needs no warning
  const whole = await assembleDocument(jobOf(build("q 60 0 0 60 20 40 cm /Im1 Do Q (unterminated"), [0, 1]), OPTIONS);
  assert.deepEqual(codes(whole.report), []);
});

test("an annotation of a kept page that refers to the content of a removed page through a key of its own: reported", async () => {
  const bytes = documentOf([4, 5], [
    { num: 4, body: page("10 0 R", "/Annots [21 0 R]") },
    { num: 5, body: page("11 0 R") },
    { num: 10, body: text("KEPT PAGE TEXT") },
    { num: 11, body: text("REMOVED-PAGE-CONTENT-P2") },
    { num: 21, body: "<< /Type /Annot /Subtype /Text /Rect [20 20 40 40] /Contents (a note) /P 4 0 R /NextPage 5 0 R /PrivateSource 11 0 R >>" }
  ]);
  const { bytes: out, report } = await assembleDocument(jobOf(bytes, [0]), OPTIONS);
  // the stream travels with the annotation that names it (the engine does not delete what a kept page refers
  // to): the user must be told that text of a removed page may remain
  assert.deepEqual(await textLeaks(out, ["REMOVED-PAGE-CONTENT-P2"]), ["REMOVED-PAGE-CONTENT-P2"]);
  assert.deepEqual(report.warnings, [{ code: "EXPORT_RESOURCES_NOT_PRUNED", params: { source: "s", pages: 1 } }]);
  assert.equal(annotsOf(await reload(out), 0)[0].get(N("NextPage")), undefined, "a reference to the removed page itself is cut");
  // a content stream that a kept page SHOWS too is no secret of the removed page
  const shared = documentOf([4, 5], [
    { num: 4, body: page("[10 0 R 12 0 R]") },
    { num: 5, body: page("[11 0 R 12 0 R]") },
    { num: 10, body: text("KEPT PAGE TEXT") },
    { num: 11, body: text("REMOVED-PAGE-CONTENT-P2") },
    { num: 12, body: text("SHARED FOOTER TEXT", 30) }
  ]);
  const plain = await assembleDocument(jobOf(shared, [0]), OPTIONS);
  assert.deepEqual([codes(plain.report), await textLeaks(plain.bytes, ["REMOVED-PAGE-CONTENT-P2"])], [[], []]);
});

const OPERAND_CASES = {
  "plain (control)": ["BT /F2 20 Tf 20 150 Td (KEPT TEXT) Tj ET q 60 0 0 60 20 40 cm /ImA Do Q /GS1 gs 0 0 1 rg 120 40 60 60 re f", { Font: ["F2"], XObject: ["ImA"], ExtGState: ["GS1"] }],
  "/F2 /GS1 gs 20 Tf: the left-over name is the operand of the NEXT operator": ["BT /F2 /GS1 gs 20 Tf 20 150 Td (KEPT TEXT) Tj ET q 60 0 0 60 20 40 cm /ImA Do Q 0 0 1 rg 120 40 60 60 re f", { Font: ["F2"], XObject: ["ImA"], ExtGState: ["GS1"] }],
  "/ImB /ImA Do: a viewer paints the LAST operand": ["BT /F2 20 Tf 20 150 Td (KEPT TEXT) Tj ET q 60 0 0 60 20 40 cm /ImB /ImA Do Q /GS1 gs 0 0 1 rg 120 40 60 60 re f", { Font: ["F2"], XObject: ["ImB", "ImA"], ExtGState: ["GS1"] }],
  "0 /ImA Do: a stray number in front of the name": ["BT /F2 20 Tf 20 150 Td (KEPT TEXT) Tj ET q 60 0 0 60 20 40 cm 0 /ImA Do Q /GS1 gs 0 0 1 rg 120 40 60 60 re f", { Font: ["F2"], XObject: ["ImA"], ExtGState: ["GS1"] }],
  "1 /GS1 gs: a stray number in front of the name": ["BT /F2 20 Tf 20 150 Td (KEPT TEXT) Tj ET q 60 0 0 60 20 40 cm /ImA Do Q 1 /GS1 gs 0 0 1 rg 120 40 60 60 re f", { Font: ["F2"], XObject: ["ImA"], ExtGState: ["GS1"] }]
};
const grey = (level) => streamBody("/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.from([level]));
/** Two pages that share ONE resource dictionary (object 20); page 2 is removed. */
const operandDocument = (content1) => documentOf([4, 5], [
  { num: 4, body: page("10 0 R", "", "20 0 R") },
  { num: 5, body: page("11 0 R", "", "20 0 R") },
  { num: 8, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>" },
  { num: 10, body: streamBody("", content1) },
  { num: 11, body: streamBody("", "BT /F1 12 Tf 20 100 Td (page two) Tj ET q 50 0 0 50 200 100 cm /ImB Do Q") },
  { num: 12, body: grey(40) },
  { num: 13, body: grey(160) },
  { num: 14, body: "<< /Type /ExtGState /ca 0.3 >>" },
  { num: 20, body: "<< /Font << /F1 3 0 R /F2 8 0 R >> /XObject << /ImA 12 0 R /ImB 13 0 R >> /ExtGState << /GS1 14 0 R /GS2 << /Type /ExtGState /ca 0.6 >> >> >>" }
]);

test("pruning keeps every resource whose name stands anywhere among the operands, whichever operand the viewer takes", async () => {
  for (const [label, [content1, expected]] of Object.entries(OPERAND_CASES)) {
    const source = operandDocument(content1);
    const { bytes, report } = await assembleDocument(jobOf(source, [0]), OPTIONS);
    assert.deepEqual(codes(report), [], label);
    const names = resourceNames((await reload(bytes)).getPage(0));
    assert.deepEqual([names.Font, names.XObject, names.ExtGState], [expected.Font, expected.XObject, expected.ExtGState], label);
    assert.ok(report.sources.s.copy.resources.removed >= 2, `${label}: what is named nowhere still goes`);
    if (!canRender) continue;
    const [before] = await renderAll(source, { scale: 2 });
    const [after] = await renderAll(bytes, { scale: 2 });
    assert.equal(differingPixels(before, after), 0, `${label}: ${firstDifference(before, after)}`);
  }
});

// -----------------------------------------------------------------------------------------------------------
// defect 7: objects the parser of the library cannot read
// -----------------------------------------------------------------------------------------------------------

const GOOD_RESOURCES = "/Font << /F1 30 0 R >> /XObject << /Im1 31 0 R >>";
/** Page 1 takes its resources from object 20, whose body is given; padding objects make the output numbers differ. */
const oddDocument = (resources) => documentOf([4, 5], [
  { num: 4, body: page("10 0 R", "", "20 0 R") },
  { num: 5, body: page("11 0 R", "", "<< /Font << /F1 30 0 R >> >>") },
  { num: 10, body: streamBody("", "BT /F1 20 Tf 20 150 Td (PAGE ONE TEXT) Tj ET q 80 0 0 40 20 40 cm /Im1 Do Q") },
  { num: 11, body: streamBody("", "BT /F1 20 Tf 20 150 Td (PAGE TWO TEXT) Tj ET") },
  { num: 20, body: resources },
  { num: 30, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
  { num: 31, body: streamBody("/Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.from([0, 80, 160, 240])) },
  ...[40, 41, 42, 43, 44, 45].map((num) => ({ num, body: `(padding ${num})` }))
]);
const SELF_CONTAINED = {
  "a number written --5": `<< ${GOOD_RESOURCES} /X --5 >>`,
  "a number written 1.2.3": `<< ${GOOD_RESOURCES} /X 1.2.3 >>`,
  "a number with an exponent": `<< ${GOOD_RESOURCES} /X 1e3 >>`,
  "True instead of true": `<< ${GOOD_RESOURCES} /Flag True >>`,
  "a stray keyword inside the dictionary": `<< ${GOOD_RESOURCES} /K foo >>`
};

test("a resource dictionary the library cannot parse but a viewer reads: the page keeps its fonts and pictures", async (t) => {
  for (const [label, resources] of Object.entries(SELF_CONTAINED)) {
    await t.test(label, async () => {
      const source = oddDocument(resources);
      assert.ok((await loadPlain(source)).context.lookup(PDFRef.of(20)) instanceof PDFInvalidObject, "the library keeps the object as raw bytes");
      assert.deepEqual(await extractText(source), ["PAGE ONE TEXT", "PAGE TWO TEXT"], "the viewer reads it");
      const sourceImages = canRender ? await renderAll(source, { scale: 2 }) : null;
      for (const pages of [[0, 1], [0]]) {
        const { bytes, report } = await assembleDocument(jobOf(source, pages), OPTIONS);
        // with a page removed nobody can say what the unread object keeps alive
        const expected = pages.length === 2 ? ["EXPORT_OBJECTS_UNPARSED"] : ["EXPORT_OBJECTS_UNPARSED", "EXPORT_RESOURCES_NOT_PRUNED"];
        assert.deepEqual(codes(report), expected);
        assert.deepEqual(report.warnings[0].params, { source: "s", objects: 1 });
        assert.deepEqual((await extractText(bytes)).slice(0, 1), ["PAGE ONE TEXT"]);
        // the same bytes, with references that mean the same objects in the new file
        const { scanRawObject } = await import("../src/pages/pdfEditor/engine/export/rawObjects.js");
        const out = await reload(bytes);
        const raw = out.context.lookup(out.getPage(0).node.get(N("Resources")));
        assert.ok(raw instanceof PDFInvalidObject);
        const targets = scanRawObject(raw.data).refs.map((ref) => out.context.lookup(PDFRef.of(ref.number, ref.generation)));
        assert.equal(targets.length, 2);
        assert.equal(String(targets[0].get(N("BaseFont"))), "/Helvetica");
        assert.ok(targets[1] instanceof PDFStream && String(targets[1].dict.get(N("Subtype"))) === "/Image");
        assert.deepEqual((await fileFacts(bytes)).orphans, []);
        if (sourceImages) {
          const [after] = await renderAll(bytes, { scale: 2 });
          assert.equal(differingPixels(sourceImages[0], after), 0, firstDifference(sourceImages[0], after));
        }
      }
    });
  }
  await t.test("something drawn on such a page: the old content keeps its dictionary, the drawing gets one it can add to", async () => {
    const source = oddDocument(SELF_CONTAINED["True instead of true"]);
    const label = makeTextObject({ id: "label", lines: ["Đã duyệt"], x: 150, y: 100 });
    const one = await assembleDocument(jobOf(source, [0, 1], [[square(), label], []]), OPTIONS);
    const two = await drawOnDocument((await assembleDocument(jobOf(source, [0, 1]), OPTIONS)).bytes, [[square(), label]], OPTIONS);
    for (const [run, out] of [["one pass", one], ["two passes", two]]) {
      const texts = await extractText(out.bytes);
      assert.ok(texts[0].includes("PAGE ONE TEXT") && texts[0].includes("Đã duyệt"), `${run}: ${texts[0]}`);
      assert.equal(texts[1], "PAGE TWO TEXT");
      assert.deepEqual((await fileFacts(out.bytes)).audit, []);
      if (!canRender) continue;
      const [before] = await renderAll(source, { scale: 2 });
      const [after] = await renderAll(out.bytes, { scale: 2 });
      assert.ok(findColorBox(after, [255, 0, 255], 20), `${run}: the square is drawn`);
      // the picture of the page (four grey steps, 160 x 80 px at this scale) is where it was
      assert.equal(differingPixels(before, after, [{ x: 0, y: 0, w: 600, h: 230 }]), 0, `${run}: ${firstDifference(before, after, [{ x: 0, y: 0, w: 600, h: 230 }])}`);
    }
  });
  await t.test("an object that is not self-contained cannot be carried over: the source is refused", async () => {
    // a viewer reads on behind such an object until the brackets match: in another file it means something else
    for (const resources of [`<< ${GOOD_RESOURCES} /Bad >>`, `<< ${GOOD_RESOURCES} `, `<< ${GOOD_RESOURCES} /Note (never closed >>`]) {
      await assert.rejects(() => assembleDocument(jobOf(oddDocument(resources), [0, 1]), OPTIONS), (error) => isPdfEditorError(error) && error.code === "EXPORT_SOURCE_DAMAGED" && error.params.source === "s", resources);
    }
    // ... unless nothing the document uses refers to it
    const unused = documentOf([4], [{ num: 4, body: page("10 0 R") }, { num: 10, body: text("ONLY PAGE") }, { num: 20, body: "<< /Nobody /RefersToThis (((" }]);
    const { report } = await assembleDocument(jobOf(unused, [0]), OPTIONS);
    assert.deepEqual([codes(report), report.sources.s.invalidObjects], [[], 0]);
  });
});

test("an annotation, a form field or a bookmark the library cannot parse is left out of the export, and the report says so", async (t) => {
  const two = (pageExtra, more, catalogExtra = "") => documentOf([4, 5], [
    { num: 4, body: page("10 0 R", pageExtra) }, { num: 5, body: page("11 0 R") },
    { num: 10, body: text("PAGE ONE") }, { num: 11, body: text("PAGE TWO") }, ...more
  ], catalogExtra);
  const seenBy = (bytes) => withPdf(bytes, async (doc) => ({
    annotations: (await (await doc.getPage(1)).getAnnotations()).map((entry) => entry.subtype),
    outline: ((await doc.getOutline()) || []).map((item) => item.title)
  }));
  const cases = {
    "a link": [
      two("/Annots [20 0 R]", [{ num: 20, body: "<< /Type /Annot /Subtype /Link /Rect [20 20 120 40] /A << /S /URI /URI (https://example.com/ODDLINK) >> /K foo >>" }]),
      { annotations: ["Link"], outline: [] }
    ],
    "a text field with its widget": [
      two("/Annots [20 0 R]", [{ num: 20, body: "<< /Type /Annot /Subtype /Widget /FT /Tx /T (oddfield) /V (ODDVALUE) /Rect [20 20 120 40] /P 4 0 R /K foo >>" }], "/AcroForm << /Fields [20 0 R] /DA (/F1 12 Tf 0 g) >>"),
      { annotations: ["Widget"], outline: [] }
    ],
    // the bookmarks behind it on its level are reached only through its /Next: they go with it
    "a bookmark": [
      two("", [
        { num: 20, body: "<< /Type /Outlines /First 21 0 R /Last 22 0 R /Count 2 >>" },
        { num: 21, body: "<< /Title (ODD BOOKMARK) /Parent 20 0 R /Next 22 0 R /Dest [4 0 R /Fit] /K foo >>" },
        { num: 22, body: "<< /Title (Good bookmark) /Parent 20 0 R /Prev 21 0 R /Dest [5 0 R /Fit] >>" }
      ], "/Outlines 20 0 R"),
      { annotations: [], outline: ["ODD BOOKMARK", "Good bookmark"] }
    ]
  };
  for (const [label, [source, shown]] of Object.entries(cases)) {
    await t.test(label, async () => {
      assert.deepEqual(await seenBy(source), shown, "the viewer reads it");
      for (const pages of [[0, 1], [0]]) {
        const { bytes, report } = await assembleDocument(jobOf(source, pages), OPTIONS);
        assert.deepEqual(report.warnings, [{ code: "EXPORT_OBJECTS_UNPARSED", params: { source: "s", objects: 1 } }]);
        assert.deepEqual(await seenBy(bytes), { annotations: [], outline: [] });
        assert.deepEqual(await extractText(bytes), pages.map((index) => ["PAGE ONE", "PAGE TWO"][index]));
        assert.deepEqual(await textLeaks(bytes, ["ODDLINK", "ODDVALUE", "oddfield", "ODD BOOKMARK", "Good bookmark"]), []);
        const facts = await fileFacts(bytes);
        assert.deepEqual([facts.audit, facts.orphans], [[], []]);
      }
    });
  }
});

test("a page or a page tree node the library cannot parse: the writer would count fewer pages than the viewer shows, so the source is refused", async (t) => {
  // "/K foo" inside the dictionary: the viewer skips the stray word and shows the page; the library keeps the
  // whole object as raw bytes, and getPages() passes it over without a word
  const texts = [{ num: 10, body: text("FIRST PAGE") }, { num: 11, body: text("SECOND PAGE") }, { num: 12, body: text("THIRD PAGE") }];
  const below = (body) => body.replace("/Parent 2 0 R", "/Parent 7 0 R");
  const cases = {
    "the dictionary of the second page": documentOf([4, 5, 6], [
      { num: 4, body: page("10 0 R") }, { num: 5, body: page("11 0 R", "/K foo") }, { num: 6, body: page("12 0 R") }, ...texts
    ]),
    "an inner node of the page tree": rawPdfWithTable([
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [4 0 R 7 0 R] /Count 3 >>" },
      FONT,
      { num: 4, body: page("10 0 R") },
      { num: 7, body: "<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 /K foo >>" },
      { num: 5, body: below(page("11 0 R")) }, { num: 6, body: below(page("12 0 R")) }, ...texts
    ])
  };
  for (const [label, source] of Object.entries(cases)) {
    await t.test(label, async () => {
      assert.deepEqual(await extractText(source), ["FIRST PAGE", "SECOND PAGE", "THIRD PAGE"], "the viewer shows three pages");
      assert.ok((await loadPlain(source)).getPageCount() < 3, "the library sees fewer: its page index 1 is not the viewer's second page");
      const refused = (error) => isPdfEditorError(error) && error.code === "EXPORT_SOURCE_DAMAGED" && error.params.source === "s";
      // also without sources[].expectedPages (with it the job fails as EXPORT_PAGE_COUNT_MISMATCH anyway)
      await assert.rejects(() => assembleDocument(jobOf(source, [0, 1]), OPTIONS), refused);
      await assert.rejects(() => inspectSource(source, { source: "s" }), refused);
    });
  }
});

test("rawObjects: references outside strings and comments, and whether an object is closed", async () => {
  const { scanRawObject, rewriteRawObject } = await import("../src/pages/pdfEditor/engine/export/rawObjects.js");
  const bytes = (source) => new Uint8Array(Buffer.from(source, "latin1"));
  const scan = (source) => scanRawObject(bytes(source));
  const source = "<< /A 5 0 R /S (5 0 R in a string \\) 6 0 R) % 7 0 R in a comment\n /B [8 0 R 9 1 R] /H <48 30 20 52> /N --5 /C 10 0 R >>";
  assert.deepEqual(scan(source).refs.map((ref) => [ref.number, ref.generation]), [[5, 0], [8, 0], [9, 1], [10, 0]]);
  assert.equal(scan(source).closed, true);
  const renumbered = latin1(rewriteRawObject(bytes(source), (number, generation) => (number === 9 ? "null" : `${number + 100} ${generation} R`)));
  assert.equal(renumbered, "<< /A 105 0 R /S (5 0 R in a string \\) 6 0 R) % 7 0 R in a comment\n /B [108 0 R null] /H <48 30 20 52> /N --5 /C 110 0 R >>");
  for (const [closed, sample] of [
    [true, "<< /K foo /L 1 >>"], [true, "[1 2 (a) <</X 1>>]"], [true, "<< /A << /B [ /C ] >> >> trailing words"],
    [false, "<< /A 1 /Bad >>"], [false, "<< /A 1 "], [false, "<< /A (never closed >>"], [false, "<< /A <4142 >>"], [false, "[1 2"], [false, "<< /A 1 >> >>"],
    [true, "<< /Length 4 >>\nstream\nabcd\nendstream"], [false, "<< /Length 400 >>\nstream\nabcd"]
  ]) {
    assert.equal(scan(sample).closed, closed, sample);
  }
  assert.equal(scan("<< /Length 4 /F 3 0 R >>\nstream\n1 0 R\nendstream").refs.length, 1, "stream data is not searched for references");
});

// -----------------------------------------------------------------------------------------------------------
// defect 8: drawOnDocument() and a signed input
// -----------------------------------------------------------------------------------------------------------

test("drawOnDocument on a signed document: the signature fields that carry a signature go, and the report says why", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const first = doc.addPage([300, 200]);
  first.drawText("SIGNED PAGE TEXT", { x: 20, y: 150, size: 14 });
  const signature = ctx.register(ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 100, 200, 300], Contents: PDFHexString.of("00".repeat(64)), Name: PDFString.of("SIGNER-NAME-OF-INPUT") }));
  const signed = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature1"), Rect: [20, 20, 120, 60], P: first.ref, F: 132, V: signature }));
  const empty = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature2"), Rect: [150, 20, 250, 60], P: first.ref, F: 4 }));
  const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [20, 100, 40, 120], Contents: PDFString.of("a note"), P: first.ref, IRT: signed }));
  first.node.set(N("Annots"), ctx.obj([signed, empty, note]));
  doc.catalog.set(N("AcroForm"), ctx.obj({ Fields: [signed, empty], SigFlags: 3 }));
  doc.catalog.set(N("Perms"), ctx.obj({ DocMDP: signature }));
  doc.catalog.set(N("DSS"), ctx.obj({ Certs: [ctx.register(ctx.stream("CERTIFICATE-OF-THE-SIGNER"))] }));
  for (const useObjectStreams of [false, true]) {
    const input = await doc.save({ useObjectStreams });
    const { bytes, report } = await drawOnDocument(input, [[square()]], OPTIONS);
    assert.deepEqual(report.warnings, [{ code: "EXPORT_SOURCE_SIGNED", params: { source: null, signatures: 1 } }]);
    assert.equal(report.signatures, 1);
    const facts = await fileFacts(bytes);
    assert.deepEqual([facts.hasByteRange, facts.catalogKeys.includes("Perms"), facts.catalogKeys.includes("DSS"), facts.audit, facts.orphans], [false, false, false, [], []]);
    assert.deepEqual(await textLeaks(bytes, ["SIGNER-NAME-OF-INPUT", "CERTIFICATE-OF-THE-SIGNER", "Signature1"]), []);
    const acroForm = facts.doc.catalog.lookup(N("AcroForm"), PDFDict);
    assert.equal(acroForm.lookup(N("Fields"), PDFArray).size(), 1, "the empty signature field can still be signed");
    assert.equal(acroForm.lookup(N("SigFlags")).asNumber(), 1);
    assert.equal(annotsOf(facts.doc, 0).length, 2);
    assert.deepEqual(await extractText(bytes), ["SIGNED PAGE TEXT"]);
  }
  // an unsigned input is not touched in that respect
  const unsigned = await PDFDocument.create({ updateMetadata: false });
  const only = unsigned.addPage([300, 200]);
  const blank = unsigned.context.register(unsigned.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature2"), Rect: [150, 20, 250, 60], P: only.ref, F: 4 }));
  only.node.set(N("Annots"), unsigned.context.obj([blank]));
  unsigned.catalog.set(N("AcroForm"), unsigned.context.obj({ Fields: [blank], SigFlags: 1 }));
  unsigned.catalog.set(N("DSS"), unsigned.context.obj({ Certs: [] }));
  const plain = await drawOnDocument(await unsigned.save(), [[square()]], OPTIONS);
  assert.deepEqual([plain.report.warnings, plain.report.signatures], [[], 0]);
  const kept = await fileFacts(plain.bytes);
  assert.ok(kept.catalogKeys.includes("DSS"), "only a signed input loses its signature material");
  assert.equal(annotsOf(kept.doc, 0).length, 1);
});

// -----------------------------------------------------------------------------------------------------------
// defect 10: two characters that share one glyph
// -----------------------------------------------------------------------------------------------------------

test("characters that share a glyph of a face: a hyphen stays a hyphen and a space a space, whatever was drawn first", async () => {
  const softHyphen = String.fromCharCode(0xad);
  const noBreakSpace = String.fromCharCode(0xa0);
  const cases = [
    // [face, drawn first, drawn second, what the second line must read as]
    ["arimo", `ngh${softHyphen}iệp`, "12-2026 A-B", "12-2026 A-B"],
    ["tinos", `Hợp${noBreakSpace}đồng`, "số 12 ngày 16", "số 12 ngày 16"],
    ["cousine", `a${noBreakSpace}b`, "c d e", "c d e"]
  ];
  for (const [family, first, second, expected] of cases) {
    for (const order of [[first, second], [second, first]]) {
      const objects = order.map((line, index) => makeTextObject({ lines: [line], font: family, x: 150, y: 150 - index * 40 }));
      const { bytes } = await assembleDocument({
        sources: [], pages: [{ blank: [300, 200], rotate: 0 }], objects: [objects], marks: [], assets: {}, info: {}, fileName: "glyphs"
      }, OPTIONS);
      const lines = (await extractText(bytes))[0].split("\n");
      assert.ok(lines.includes(expected), `${family}, ${order[0] === first ? "the rarer character first" : "the common character first"}: ${JSON.stringify(lines)}`);
    }
  }
});

// -----------------------------------------------------------------------------------------------------------
// defect 11: the bookmark of a removed page that has kept children
// -----------------------------------------------------------------------------------------------------------

test("a bookmark whose own page was removed: kept with a warning by default, dropped on request with its children lifted", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages = ["OUTLINE PAGE ONE", "OUTLINE PAGE TWO", "OUTLINE PAGE THREE"].map((line) => {
    const made = doc.addPage([300, 200]);
    made.drawText(line, { x: 20, y: 150, size: 14 });
    return made;
  });
  const ctx = doc.context;
  const root = ctx.obj({ Type: "Outlines" });
  const rootRef = ctx.register(root);
  const item = (title, pageIndex, parentRef) => {
    const dict = ctx.obj({ Title: PDFString.of(title), Parent: parentRef, Dest: [pages[pageIndex].ref, "Fit"] });
    return { dict, ref: ctx.register(dict) };
  };
  // "Kept one" (page 1) | "PARENT-TITLE-OF-PAGE-TWO" (page 2) > [ "GRANDPARENT-OF-P2" (page 2) > [ "Kept child" (page 3) ], "Dropped child" (page 2) ]
  const one = item("Kept one", 0, rootRef);
  const parent = item("PARENT-TITLE-OF-PAGE-TWO", 1, rootRef);
  const inner = item("INNER-TITLE-OF-PAGE-TWO", 1, parent.ref);
  const child = item("Kept child", 2, inner.ref);
  const dropped = item("DROPPED-CHILD-OF-PAGE-TWO", 1, parent.ref);
  one.dict.set(N("Next"), parent.ref);
  parent.dict.set(N("Prev"), one.ref);
  parent.dict.set(N("First"), inner.ref);
  parent.dict.set(N("Last"), dropped.ref);
  parent.dict.set(N("Count"), ctx.obj(3));
  inner.dict.set(N("Next"), dropped.ref);
  inner.dict.set(N("First"), child.ref);
  inner.dict.set(N("Last"), child.ref);
  inner.dict.set(N("Count"), ctx.obj(1));
  dropped.dict.set(N("Prev"), inner.ref);
  root.set(N("First"), one.ref);
  root.set(N("Last"), parent.ref);
  root.set(N("Count"), ctx.obj(5));
  doc.catalog.set(N("Outlines"), rootRef);
  const source = await doc.save();
  const titles = ["PARENT-TITLE-OF-PAGE-TWO", "INNER-TITLE-OF-PAGE-TWO", "DROPPED-CHILD-OF-PAGE-TWO"];

  const kept = await assembleDocument(jobOf(source, [0, 2]), OPTIONS);
  assert.deepEqual(await outlineOf(kept.bytes), [["Kept one", 0, 0], ["PARENT-TITLE-OF-PAGE-TWO", 1, 0], ["INNER-TITLE-OF-PAGE-TWO", 1, 1], ["Kept child", 1, 2]]);
  assert.deepEqual(kept.report.sources.s.outline, { items: 5, kept: 4, dropped: 1, retargeted: 2, truncated: false });
  assert.deepEqual(kept.report.warnings, [{ code: "EXPORT_OUTLINE_RETARGETED", params: { source: "s", items: 2 } }]);
  assert.deepEqual(await textLeaks(kept.bytes, titles), titles.slice(0, 2), "their titles are in the file: that is what the warning is for");

  const lifted = await assembleDocument(jobOf(source, [0, 2]), { ...OPTIONS, dropOrphanBookmarks: true });
  assert.deepEqual(await outlineOf(lifted.bytes), [["Kept one", 0, 0], ["Kept child", 1, 0]], "the child of two removed levels ends up at the top");
  assert.deepEqual(lifted.report.sources.s.outline, { items: 5, kept: 2, dropped: 3, retargeted: 0, truncated: false });
  assert.deepEqual([lifted.report.warnings, await textLeaks(lifted.bytes, titles)], [[], []]);

  // nothing removed: nothing to report, whatever the option says
  for (const dropOrphanBookmarks of [false, true]) {
    const whole = await assembleDocument(jobOf(source, [0, 1, 2]), { ...OPTIONS, dropOrphanBookmarks });
    assert.deepEqual([whole.report.warnings, whole.report.sources.s.outline.kept, whole.report.sources.s.outline.retargeted], [[], 5, 0]);
  }
});

// -----------------------------------------------------------------------------------------------------------
// defect 12: the base of relative link addresses
// -----------------------------------------------------------------------------------------------------------

test("relative link addresses keep their target: the /URI base of the source comes along, or the addresses are written out", async () => {
  const withBase = (base, words) => documentOf([4, 5], [
    { num: 4, body: page("10 0 R", "/Annots [21 0 R 22 0 R]") },
    { num: 5, body: page("11 0 R") },
    { num: 10, body: text(words) },
    { num: 11, body: text("ANOTHER PAGE") },
    { num: 21, body: "<< /Type /Annot /Subtype /Link /Rect [20 20 120 40] /A << /S /URI /URI (relative/page.html) >> >>" },
    { num: 22, body: "<< /Type /Annot /Subtype /Link /Rect [20 60 120 80] /A << /S /URI /URI (https://absolute.example/x) >> >>" }
  ], base ? `/URI << /Base (${base}) >>` : "");
  const urlsOf = (bytes) => withPdf(bytes, async (doc) => {
    const out = [];
    for (let number = 1; number <= doc.numPages; number += 1) out.push((await (await doc.getPage(number)).getAnnotations()).map((annotation) => annotation.url || annotation.unsafeUrl).sort());
    return out;
  });
  const first = withBase("https://base.example/dir/", "FIRST SOURCE");
  const expected = ["https://absolute.example/x", "https://base.example/dir/relative/page.html"];
  assert.deepEqual((await urlsOf(first))[0], expected);

  const single = await assembleDocument(jobOf(first, [0]), OPTIONS);
  assert.deepEqual(await urlsOf(single.bytes), [expected], "before the repair the first link led to \"relative/page.html\" of nowhere");
  const catalog = (await reload(single.bytes)).catalog;
  assert.equal(latin1(catalog.lookup(N("URI"), PDFDict).lookup(N("Base")).asBytes()), "https://base.example/dir/");

  // two sources with different bases: the output can carry only one, so it carries none
  const second = withBase("https://other.example/", "SECOND SOURCE");
  const third = withBase(null, "THIRD SOURCE");
  const mixed = await assembleDocument({
    sources: [{ id: "a", bytes: first }, { id: "b", bytes: second }, { id: "c", bytes: third }],
    pages: [{ source: "b", index: 0, rotate: 0 }, { source: "a", index: 0, rotate: 0 }, { source: "c", index: 0, rotate: 0 }],
    objects: [[], [], []], marks: [], assets: {}, info: {}, fileName: "bases"
  }, OPTIONS);
  assert.equal((await reload(mixed.bytes)).catalog.get(N("URI")), undefined);
  const urls = await urlsOf(mixed.bytes);
  assert.deepEqual(urls[0], ["https://absolute.example/x", "https://other.example/relative/page.html"]);
  assert.deepEqual(urls[1], expected);
  // a source without a base keeps its relative address (it never had a target of its own)
  const relative = annotsOf(await reload(mixed.bytes), 2).map((annotation) => latin1(annotation.lookup(N("A"), PDFDict).lookup(N("URI")).asBytes())).sort();
  assert.deepEqual(relative, ["https://absolute.example/x", "relative/page.html"]);
});

// -----------------------------------------------------------------------------------------------------------
// the clock of the job
// -----------------------------------------------------------------------------------------------------------

test("job.now is the clock when options.now is not given: the same job gives the same file", async () => {
  const source = documentOf([4], [{ num: 4, body: page("10 0 R") }, { num: 10, body: text("CLOCK PAGE") }]);
  const stamp = new Date(Date.UTC(2026, 4, 6, 7, 8, 9));
  const job = { ...jobOf(source, [0]), now: stamp };
  const options = { fonts: loadFont, idSeed: new Uint8Array(16).fill(1) };
  const modDate = (bytes) => withPdf(bytes, async (doc) => (await doc.getMetadata()).info.ModDate);
  const first = await assembleDocument(job, options);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const again = await assembleDocument(job, options);
  assert.equal(await modDate(first.bytes), "D:20260506070809Z");
  assert.equal(Buffer.compare(Buffer.from(first.bytes), Buffer.from(again.bytes)), 0, "a second later, the same bytes");
  const other = await assembleDocument(job, { ...options, now: NOW });
  assert.equal(await modDate(other.bytes), "D:20261120020000Z", "options.now wins");
  const invalid = await assembleDocument({ ...job, now: "2026-05-06" }, options);
  assert.notEqual(await modDate(invalid.bytes), "D:20260506070809Z", "something that is not a date is not a clock");
});
