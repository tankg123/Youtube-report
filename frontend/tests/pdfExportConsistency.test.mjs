// engine/export: the writer must read a source the way the viewer shows it.
//
// A viewer (pdf.js) finds every object through the cross-reference sections of a file; the parser of the
// writing library reads from top to bottom and keeps the last definition it meets. A prepared file can make
// the two read different objects: the editor then shows one contract and the export (which the user signs)
// holds another. The engine refuses such sources with EXPORT_SOURCE_INCONSISTENT, in assembleDocument() and
// in inspectSource(), and it must not refuse honest files: incremental updates, object streams, encrypted
// files, junk in front of the header, a missing "startxref".
//
// Every fixture is written by hand here (tests/helpers/pdfExportFixtures.mjs): the library itself cannot
// write a file that disagrees with its own cross-reference table.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleDocument, drawOnDocument, inspectSource } from "../src/pages/pdfEditor/engine/export/index.js";
import { loadForEdit } from "../src/pages/pdfEditor/engine/export/robust.js";
import { isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { extractText, pdfLib, withPdf } from "./helpers/pdfTestKit.mjs";
import {
  appendRevision, buildEncryptedFixture, buildLinkedFixture, rawHybridPdf, rawPage, rawPdfWithObjectStreams, rawPdfWithTable, skeleton, streamBody
} from "./helpers/pdfExportFixtures.mjs";
import { fileFacts } from "./helpers/pdfExportScan.mjs";

const { PDFDocument, PDFContext, PDFParser, PDFName, PDFRef, PDFRawStream } = pdfLib;
const OPTIONS = { now: new Date(Date.UTC(2026, 10, 20, 2, 0, 0)), idSeed: new Uint8Array(16).fill(9) };
const SHOWN = "SHOWN: pay 100 USD";
const HIDDEN = "HIDDEN: pay 900000 USD";
const content = (text, y = 100) => streamBody("", `BT /F1 14 Tf 20 ${y} Td (${text}) Tj ET`);
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const bytesOf = (text) => new Uint8Array(Buffer.from(text, "latin1"));
const jobOf = (bytes, pages = [0], source = {}) => ({
  sources: [{ id: "s", bytes, ...source }],
  pages: pages.map((index) => ({ source: "s", index, rotate: 0 })),
  objects: pages.map(() => []), marks: [], assets: {}, info: {}, fileName: "consistency"
});
/** One page (object 4) with one content stream (object 5), a font (3), a catalog (1) and a page tree (2). */
const onePage = (more = [], pageExtra = "") => [...skeleton([4]), { num: 4, body: rawPage(5, { extra: pageExtra }) }, { num: 5, body: content(SHOWN) }, ...more];

/** What the library alone reads as the content of page 1 (no cross-reference information is used). */
async function writerAlone(bytes, options = {}) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false, ...options });
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const refs = contents instanceof pdfLib.PDFArray ? contents.asArray() : [page.node.get(PDFName.of("Contents"))];
  return refs.map((ref) => doc.context.lookup(ref)).map((stream) => (stream instanceof PDFRawStream ? (/\((.*)\) Tj/.exec(latin1(stream.contents)) || [])[1] : String(stream))).join(" | ");
}

async function expectInconsistent(bytes, label, source = {}) {
  for (const [what, run] of [["assembleDocument", () => assembleDocument(jobOf(bytes, [0], source), OPTIONS)], ["inspectSource", () => inspectSource(bytes, { source: "s", password: source.password })]]) {
    await assert.rejects(run, (error) => {
      assert.ok(isPdfEditorError(error), `${label}: ${what} throws a PdfEditorError, got ${error && error.stack}`);
      assert.equal(error.code, "EXPORT_SOURCE_INCONSISTENT", `${label}: ${what}: ${error.message}`);
      assert.deepEqual(error.params, { source: "s" });
      // the detail names object numbers, never text of the document
      assert.ok(!error.message.includes("SHOWN") && !error.message.includes("HIDDEN"), error.message);
      return true;
    }, `${label}: ${what}`);
  }
}

/** The export of an honest file shows what the viewer shows, and the file comes out clean. */
async function expectSameAsViewer(bytes, label, source = {}) {
  const shown = await extractText(bytes, { password: source.password });
  const { bytes: out, report } = await assembleDocument(jobOf(bytes, shown.map((_, index) => index), { expectedPages: shown.length, ...source }), OPTIONS);
  assert.deepEqual(await extractText(out), shown, label);
  const facts = await fileFacts(out);
  assert.deepEqual([facts.orphans, facts.audit, facts.revisions], [[], [], 1], label);
  await inspectSource(bytes, { source: "s", password: source.password, expectedPages: shown.length });
  return report;
}

// -----------------------------------------------------------------------------------------------------------
// files in which the viewer and the writer read different objects: refused
// -----------------------------------------------------------------------------------------------------------

test("an object defined twice: the table selects one definition, the writer's parser the other", async (t) => {
  const twice = (second = {}, options = {}) => rawPdfWithTable(onePage([{ num: 5, body: content(HIDDEN), table: false, ...second }]), options);
  const cases = {
    "the table points at the first of two definitions": twice(),
    "the same file behind 7 bytes of junk (a viewer counts offsets from the header)": twice({}, { junk: "junk!!\n" }),
    "the second definition is written \"5 0obj\"": twice({ header: "5 0obj\n" }),
    "the header of the second definition is spread over three lines": twice({ header: "5\n0\nobj\n" }),
    "the second definition stands behind %%EOF, without any cross-reference section": rawPdfWithTable(onePage(), { afterEof: [{ num: 5, body: content(HIDDEN) }] }),
    "the page object itself is defined twice": rawPdfWithTable(onePage([{ num: 6, body: content(HIDDEN) }, { num: 4, body: rawPage(6), table: false }]))
  };
  for (const [label, bytes] of Object.entries(cases)) {
    await t.test(label, async () => {
      assert.deepEqual(await extractText(bytes), [SHOWN], "the viewer shows the definition the table selects");
      assert.equal(await writerAlone(bytes), HIDDEN, "the library alone reads the other one");
      await expectInconsistent(bytes, label);
    });
  }
});

test("an object the table marks as free, or does not list, is nothing for the viewer: the writer must not bring it back", async () => {
  const twoStreams = (second) => rawPdfWithTable([
    ...skeleton([4]),
    { num: 4, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents [5 0 R 6 0 R] >>" },
    { num: 5, body: content(SHOWN) },
    { num: 6, body: content("HIDDEN: deleted clause", 60), ...second }
  ]);
  const deleted = twoStreams({ table: "free" });
  assert.deepEqual(await extractText(deleted), [SHOWN]);
  assert.equal(await writerAlone(deleted), `${SHOWN} | HIDDEN: deleted clause`);
  await expectInconsistent(deleted, "marked free");

  // the honest form of the same thing: an update deletes the object AND takes it off the page
  const base = twoStreams({});
  assert.deepEqual(await extractText(base), [`${SHOWN}\nHIDDEN: deleted clause`]);
  const updated = appendRevision(base, [{ num: 4, body: rawPage(5) }], { free: [6] });
  const report = await expectSameAsViewer(updated, "an update that deletes an object");
  assert.deepEqual(await extractText(updated), [SHOWN]);
  assert.equal(report.sources.s.xref, "sections");
});

test("an entry that is in use but leads to no definition: the viewer fails on the reference, it does not read null", async () => {
  // the header of an appearance stream is wiped out (a damaged download); the table still points there
  const stamp = "<< /Type /Annot /Subtype /Stamp /Rect [20 20 220 60] /F 4 /P 4 0 R /AP << /N 7 0 R >> >>";
  const appearance = streamBody("/Type /XObject /Subtype /Form /BBox [0 0 200 40] /Resources << /Font << /F1 3 0 R >> >>", "BT /F1 12 Tf 4 14 Td (STAMP TEXT) Tj ET");
  const whole = rawPdfWithTable(onePage([{ num: 6, body: stamp }, { num: 7, body: appearance }], "/Annots [6 0 R]"));
  await expectSameAsViewer(whole, "the intact file");
  const text = latin1(whole);
  const at = text.indexOf("7 0 obj");
  const wiped = bytesOf(`${text.slice(0, at)}${" ".repeat(7)}${text.slice(at + 7)}`);
  assert.deepEqual(await extractText(wiped), [SHOWN], "the viewer still opens the file");
  // The writer never meets object 7, so for it the reference is simply empty: the export would be a clean file
  // with a stamp that has no appearance, where the viewer had a stamp it could not read. Not the same thing.
  const alone = await PDFDocument.load(wiped, { updateMetadata: false });
  assert.equal(alone.context.lookup(PDFRef.of(7)), undefined);
  await expectInconsistent(wiped, "an entry that leads nowhere");
});

test("a definition hidden inside the data of another stream: the table points into the data, the writer never parses it", async () => {
  const inner = `5 0 obj\n${latin1(content("SHOWN: inside the data"))}\nendobj\n`;
  const plain = rawPdfWithTable(onePage([{ num: 7, body: streamBody("", inner) }]).map((object) => (object.num === 5 ? { ...object, body: content(HIDDEN) } : object)));
  // make the table entry of object 5 point at the definition inside the data of object 7
  const text = latin1(plain);
  const at = text.indexOf(inner);
  const table = text.lastIndexOf("\nxref\n") + 1;
  const lines = text.slice(table).split("\n");
  lines[2 + 5] = `${String(at).padStart(10, "0")} 00000 n `;
  const bytes = bytesOf(text.slice(0, table) + lines.join("\n"));
  assert.deepEqual(await extractText(bytes), ["SHOWN: inside the data"]);
  assert.equal(await writerAlone(bytes), HIDDEN);
  await expectInconsistent(bytes, "definition inside stream data");
});

test("object streams: the cross-reference stream decides which stream a compressed object is taken from", async () => {
  const annotation = (words) => `<< /Type /Annot /Subtype /FreeText /Rect [20 20 280 60] /Contents (${words}) /DA (/F1 12 Tf 0 g) /P 4 0 R >>`;
  const plain = [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 5, body: content("PAGE TEXT") }
  ];
  const packedFirst = { num: 10, members: [{ num: 2, body: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>" }, { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" }, { num: 4, body: rawPage(5, { extra: "/Annots [6 0 R]" }) }, { num: 6, body: annotation("SHOWN NOTE") }] };
  const noteOf = (bytes) => withPdf(bytes, async (doc) => (await (await doc.getPage(1)).getAnnotations()).map((entry) => entry.contentsObj.str));
  const writerNote = async (bytes) => {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return latin1(doc.context.lookup(PDFRef.of(6)).get(PDFName.of("Contents")).asBytes());
  };

  const honest = rawPdfWithObjectStreams({ plain, packed: [packedFirst] });
  assert.deepEqual(await noteOf(honest), ["SHOWN NOTE"]);
  const report = await expectSameAsViewer(honest, "hand-written object streams");
  assert.deepEqual(report.warnings, []);

  // a second object stream lists object 6 again; the cross-reference stream still names the first
  const second = { num: 11, members: [{ num: 6, body: annotation("HIDDEN NOTE") }] };
  const shadowed = rawPdfWithObjectStreams({ plain, packed: [packedFirst, second], entries: { 6: [2, 10, 3] } });
  assert.deepEqual(await noteOf(shadowed), ["SHOWN NOTE"]);
  assert.equal(await writerNote(shadowed), "HIDDEN NOTE");
  await expectInconsistent(shadowed, "two object streams list the object");

  // an honest second stream (the cross-reference stream names it, as after an incremental save) is fine
  const updated = rawPdfWithObjectStreams({ plain, packed: [packedFirst, second] });
  assert.deepEqual(await noteOf(updated), ["HIDDEN NOTE"]);
  await expectSameAsViewer(updated, "the newer object stream is the one that is named");

  // the cross-reference stream sends object 6 into the first stream, a plain definition follows later
  const later = rawPdfWithObjectStreams({ plain: [...plain, { num: 6, body: annotation("HIDDEN NOTE") }], packed: [packedFirst] });
  // (the builder lets the stream win for the entry of 6; the library takes the stream too, it comes last)
  await expectSameAsViewer(later, "a stale plain definition BEFORE the object stream");
  const reversed = latin1(later);
  const streamAt = reversed.indexOf("10 0 obj");
  const plainAt = reversed.indexOf("6 0 obj");
  assert.ok(plainAt < streamAt);
  // the same objects with the plain definition BEHIND the object stream, the entry of 6 unchanged
  const moved = rawPdfWithObjectStreams({ plain, packed: [packedFirst], entries: {} });
  const movedText = latin1(moved);
  const xrefAt = movedText.lastIndexOf("12 0 obj");
  const extra = `6 0 obj\n${annotation("HIDDEN NOTE")}\nendobj\n`;
  const patched = bytesOf(movedText.slice(0, xrefAt) + extra + movedText.slice(xrefAt).replace(/startxref\n\d+/, `startxref\n${xrefAt + extra.length}`));
  // the row of the cross-reference stream itself (object 12) still holds its old offset: nobody refers to it
  assert.deepEqual(await noteOf(patched), ["SHOWN NOTE"]);
  assert.equal(await writerNote(patched), "HIDDEN NOTE");
  await expectInconsistent(patched, "a plain definition behind the object stream that the entry names");
});

test("hybrid-reference files: the classic table comes first, the stream named by /XRefStm fills in what it leaves out", async () => {
  const catalog = { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" };
  const tree = { num: 2, body: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>" };
  const font = { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" };
  const shown = { num: 5, body: content(SHOWN) };
  const hidden = { num: 6, body: content(HIDDEN) };

  // an honest one: the font and the page live in an object stream that only the cross-reference stream lists
  const honest = rawHybridPdf({ plain: [catalog, tree, shown], packed: [{ num: 10, members: [font, { num: 4, body: rawPage(5) }] }] });
  assert.match(latin1(honest), /\/XRefStm \d+/);
  const report = await expectSameAsViewer(honest, "a hybrid-reference file");
  assert.deepEqual([report.warnings, report.sources.s.xref], [[], "sections"]);

  // The same file with the hidden numbers marked FREE in the table: the viewer keeps the first entry it reads
  // for a number, so the page stays free for it and it cannot show the file. The library, which reads no
  // table, sees a perfectly good document: an export would be a file the user never saw.
  const marked = rawHybridPdf({ plain: [catalog, tree, shown], packed: [{ num: 10, members: [font, { num: 4, body: rawPage(5) }] }], hidden: "free" });
  await assert.rejects(() => extractText(marked), "the viewer does not open it");
  assert.equal(await writerAlone(marked), SHOWN);
  await expectInconsistent(marked, "hidden objects marked free");

  // the table points at one page object, the object stream (written later, so the library takes it) holds another
  const tableWins = rawHybridPdf({ plain: [catalog, tree, font, { num: 4, body: rawPage(5) }, shown, hidden], packed: [{ num: 10, members: [{ num: 4, body: rawPage(6) }] }] });
  assert.deepEqual(await extractText(tableWins), [SHOWN]);
  assert.equal(await writerAlone(tableWins), HIDDEN);
  await expectInconsistent(tableWins, "the table and the stream both list the page");

  // the cross-reference stream sends the page into the object stream; a plain definition nobody lists follows
  const streamWins = rawHybridPdf({ plain: [catalog, tree, font, shown, hidden], packed: [{ num: 10, members: [{ num: 4, body: rawPage(5) }] }], late: [{ num: 4, body: rawPage(6) }] });
  assert.deepEqual(await extractText(streamWins), [SHOWN]);
  assert.equal(await writerAlone(streamWins), HIDDEN);
  await expectInconsistent(streamWins, "a plain definition behind the object stream");
});

test("an encrypted source: the same check works on the decrypted parse", async () => {
  const encrypted = await buildEncryptedFixture({ userPassword: "user123", useObjectStreams: false });
  const source = { password: "user123" };
  await expectSameAsViewer(encrypted, "encrypted, classic table", source);

  // an honest update of an encrypted file: a new catalog (no string in it, so nothing to encrypt)
  const text = latin1(encrypted);
  const catalog = /(\d+) 0 obj\n<<\n\/Type \/Catalog\n\/Pages (\d+) 0 R/.exec(text);
  assert.ok(catalog, "the fixture has a catalog the test can find");
  const trailer = /trailer\n<<([\s\S]*?)>>\s*startxref/.exec(text)[1];
  const keep = ["Encrypt", "ID", "Info"].map((key) => new RegExp(`/${key} (\\d+ 0 R|\\[[^\\]]*\\])`).exec(trailer)).filter(Boolean).map((match) => ` ${match[0]}`).join("");
  const updated = appendRevision(encrypted, [{ num: Number(catalog[1]), body: `<< /Type /Catalog /Pages ${catalog[2]} 0 R /PageLayout /TwoColumnRight >>` }], { root: `${catalog[1]} 0 R`, trailerExtra: keep });
  await withPdf(updated, async (doc) => assert.equal(await doc.getPageLayout(), "TwoColumnRight"), source);
  const { bytes: out } = await assembleDocument(jobOf(updated, [0, 1, 2], { ...source, expectedPages: 3 }), OPTIONS);
  await withPdf(out, async (doc) => assert.equal(await doc.getPageLayout(), "TwoColumnRight", "the newer catalog, for both readers"));

  // the same definition appended WITHOUT a section: the viewer keeps the old catalog, the writer takes the new one
  const appended = bytesOf(`${text}${catalog[1]} 0 obj\n<< /Type /Catalog /Pages ${catalog[2]} 0 R /PageLayout /TwoColumnRight >>\nendobj\n`);
  await withPdf(appended, async (doc) => assert.notEqual(await doc.getPageLayout(), "TwoColumnRight"), source);
  await expectInconsistent(appended, "encrypted, a definition without a section", source);
});

test("which trailer counts: the one the viewer uses gives the catalog and the document information", async () => {
  // a second catalog (another page tree) and a later trailer that names it; "startxref" still leads to the first trailer
  const objects = onePage([
    { num: 7, body: "<< /Type /Catalog /Pages 8 0 R >>" },
    { num: 8, body: "<< /Type /Pages /Kids [9 0 R] /Count 1 >>" },
    { num: 9, body: rawPage(10) },
    { num: 10, body: content(HIDDEN) }
  ]);
  const base = rawPdfWithTable(objects);
  const bytes = bytesOf(`${latin1(base)}trailer\n<< /Size 11 /Root 7 0 R >>\n`);
  assert.deepEqual(await extractText(bytes), [SHOWN]);
  assert.equal(await writerAlone(bytes), HIDDEN, "the library merges every trailer it meets: the last /Root wins");
  // not refused: the engine takes the viewer's catalog and then finds every object of it in agreement
  await expectSameAsViewer(bytes, "two trailers");
  const { doc } = await loadForEdit(bytes);
  assert.equal(doc.context.trailerInfo.Root, PDFRef.of(1));
});

test("a linearized file is read from its first-page section, whatever \"startxref\" says (as the viewer does)", async () => {
  // object 20 = linearization dictionary; behind it the section the viewer uses when /L is the file length
  const build = (lengthOffset) => {
    const head = `%PDF-1.7\n%${String.fromCharCode(0xe2, 0xe3, 0xcf, 0xd3)}\n`;
    const lin = (length) => `20 0 obj\n<< /Linearized 1 /L ${String(length).padStart(8, "0")} /H [100 20] /O 4 /E 500 /N 1 /T 600 >>\nendobj\n`;
    const objects = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
      `4 0 obj\n${rawPage(5)}\nendobj\n`,
      `5 0 obj\n${latin1(content(SHOWN))}\nendobj\n`,
      `5 0 obj\n${latin1(content(HIDDEN))}\nendobj\n`
    ];
    const line = (offset) => `${String(offset).padStart(10, "0")} 00000 n \n`;
    const trailer = "trailer\n<< /Size 21 /Root 1 0 R >>\n";
    const sectionLength = "xref\n0 6\n".length + 6 * 20 + trailer.length;
    const offsets = [];
    let at = head.length + lin(0).length + sectionLength;
    for (const object of objects) {
      offsets.push(at);
      at += object.length;
    }
    // the first section selects the first definition of object 5, the section at the end the second
    const section = (five) => `xref\n0 6\n0000000000 65535 f \n${offsets.slice(0, 4).map(line).join("")}${line(five)}${trailer}`;
    const tail = `${section(offsets[5])}startxref\n${at}\n%%EOF\n`;
    return bytesOf(head + lin(at + tail.length + lengthOffset) + section(offsets[4]) + objects.join("") + tail);
  };
  const linearized = build(0);
  assert.deepEqual(await extractText(linearized), [SHOWN], "pdf.js starts at the section behind the first object");
  assert.equal(await writerAlone(linearized), HIDDEN);
  await expectInconsistent(linearized, "linearized");
  // with a wrong /L the file is not linearized for the viewer: it follows "startxref", and so agrees with the writer
  const plain = build(1);
  assert.deepEqual(await extractText(plain), [HIDDEN]);
  await expectSameAsViewer(plain, "not linearized after all");
});

// -----------------------------------------------------------------------------------------------------------
// honest files: never refused
// -----------------------------------------------------------------------------------------------------------

test("incremental updates are what they always were: the newest definition for both readers", async () => {
  const base = rawPdfWithTable(onePage().map((object) => (object.num === 5 ? { ...object, body: content("OLD TEXT") } : object)));
  const updates = {
    "an update on a new line": appendRevision(base, [{ num: 5, body: content("NEW TEXT") }]),
    "an update right behind %%EOF, as signing tools write it": appendRevision(base, [{ num: 5, body: content("NEW TEXT") }], { separator: "" }),
    "two updates": appendRevision(appendRevision(base, [{ num: 5, body: content("MIDDLE TEXT") }]), [{ num: 5, body: content("NEW TEXT") }]),
    "an update behind junk in front of the header": bytesOf(`junk in front\n${latin1(appendRevision(base, [{ num: 5, body: content("NEW TEXT") }]))}`)
  };
  for (const [label, bytes] of Object.entries(updates)) {
    if (label.includes("junk")) {
      // offsets count from the header: the whole file moved, the table did not
      assert.deepEqual(await extractText(bytes), ["NEW TEXT"], label);
    }
    const report = await expectSameAsViewer(bytes, label);
    assert.deepEqual(await extractText(bytes), ["NEW TEXT"], label);
    assert.deepEqual(report.warnings, [], label);
  }
});

test("the same definition twice, word for word, is no disagreement: a file that was written out twice in a row", async () => {
  // the last "startxref" belongs to the second copy, and its table holds offsets that lead into the FIRST copy;
  // the writer's parser keeps the definitions of the second. The same bytes: the same objects.
  for (const single of [rawPdfWithTable(onePage()), (await buildLinkedFixture({ useObjectStreams: true })).bytes]) {
    const doubled = new Uint8Array(Buffer.concat([Buffer.from(single), Buffer.from(single)]));
    assert.deepEqual(await extractText(doubled), await extractText(single));
    const report = await expectSameAsViewer(doubled, "the file twice");
    assert.equal(report.sources.s.xref, "sections");
  }
  // ... but only word for word
  const single = latin1(rawPdfWithTable(onePage()));
  const changed = bytesOf(single + single.replace(SHOWN, "SHOWN: pay 999 USD"));
  assert.deepEqual(await extractText(changed), [SHOWN]);
  await expectInconsistent(changed, "the second copy differs");
});

test("files written by the library, with and without object streams, plain and encrypted, pass the check", async () => {
  for (const useObjectStreams of [false, true]) {
    const linked = await buildLinkedFixture({ useObjectStreams });
    const facts = await inspectSource(linked.bytes, { expectedPages: 4 });
    assert.equal(facts.pages, 4);
    const { doc, facts: loaded } = await loadForEdit(linked.bytes);
    assert.equal(loaded.xref, "sections");
    assert.equal(Object.prototype.hasOwnProperty.call(doc.context, "assign"), false, "the trace leaves nothing on the document");
    const encrypted = await buildEncryptedFixture({ userPassword: "user123", useObjectStreams });
    await expectSameAsViewer(encrypted, `encrypted, object streams ${useObjectStreams}`, { password: "user123" });
  }
  // what the engine writes is read back by itself (the second pass of the pipeline)
  const first = await assembleDocument(jobOf(rawPdfWithTable(onePage())), OPTIONS);
  const second = await drawOnDocument(first.bytes, [[]], OPTIONS);
  assert.deepEqual(await extractText(second.bytes), [SHOWN]);
});

test("no usable cross-reference section: the viewer scans the file, and the engine only follows where the scan is unambiguous", async () => {
  const honest = rawPdfWithTable(onePage(), { startxref: null });
  assert.deepEqual(await extractText(honest), [SHOWN], "pdf.js indexes the objects itself");
  const report = await expectSameAsViewer(honest, "no startxref line");
  assert.equal(report.sources.s.xref, "scan");
  await expectSameAsViewer(rawPdfWithTable(onePage(), { startxref: "7" }), "startxref points nowhere");

  // Two definitions in such a file: the scanning viewer takes the LAST one, as the writer does (the table that
  // preferred the first is not read by anybody now) ...
  const twice = rawPdfWithTable(onePage([{ num: 5, body: content(HIDDEN), table: false }]), { startxref: null });
  assert.deepEqual(await extractText(twice), [HIDDEN]);
  await expectSameAsViewer(twice, "a scan with two definitions");
  // ... unless it cannot read that one to its end; the engine accepts the last definition only where the
  // writer parsed it without trouble, and does not guess otherwise
  const halfText = latin1(rawPdfWithTable(onePage(), { startxref: null }));
  const half = bytesOf(`${halfText}5 0 obj\n<< /Length 10 /Open [ (never closed\nendobj\n`);
  assert.deepEqual(await extractText(half), [SHOWN], "the viewer keeps the complete definition");
  await expectInconsistent(half, "a scan whose last definition is broken");
  // an object the scan does not see (its header is not at the start of a line) but the writer's parser does
  const tucked = rawPdfWithTable([
    ...skeleton([4]),
    { num: 4, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents [5 0 R 6 0 R] >>" },
    { num: 5, body: content(SHOWN) },
    { num: 6, body: content("HIDDEN: second stream", 60), header: "junk 6 0 obj\n" }
  ], { startxref: null });
  assert.deepEqual(await extractText(tucked), [SHOWN]);
  assert.equal(await writerAlone(tucked), `${SHOWN} | HIDDEN: second stream`);
  await expectInconsistent(tucked, "an object the scan cannot see");
  // a file with a cross-reference STREAM that "startxref" misses: the scanning viewer finds the stream on its
  // way and reads the objects inside object streams through it
  const packed = rawPdfWithObjectStreams({
    plain: [{ num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" }, { num: 5, body: content("TEXT BEHIND OBJECT STREAMS") }],
    packed: [{ num: 10, members: [{ num: 2, body: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>" }, { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" }, { num: 4, body: rawPage(5) }] }]
  });
  const lost = bytesOf(latin1(packed).replace(/startxref\n\d+/, "startxref\n17"));
  assert.deepEqual(await extractText(lost), ["TEXT BEHIND OBJECT STREAMS"]);
  const scanned = await expectSameAsViewer(lost, "a cross-reference stream that startxref misses");
  assert.equal(scanned.sources.s.xref, "scan");
  // nothing at all to start from: no section, no trailer. The viewer cannot open such a file either.
  const text = latin1(rawPdfWithTable(onePage()));
  const bare = bytesOf(text.slice(0, text.lastIndexOf("\nxref\n") + 1));
  await assert.rejects(() => extractText(bare), /Invalid PDF structure/);
  await expectInconsistent(bare, "no trailer");
});

// -----------------------------------------------------------------------------------------------------------
// the parts
// -----------------------------------------------------------------------------------------------------------

/** The parts are loaded where they are used, so that the tests above only need the public entry points. */
const parts = async () => ({
  ...(await import("../src/pages/pdfEditor/engine/export/viewerXref.js")),
  findViewerDisagreements: (await import("../src/pages/pdfEditor/engine/export/robust.js")).findViewerDisagreements
});

test("readViewerXref: tables, the header offset, free entries, the object-0 quirk, what it will not guess", async () => {
  const { readViewerXref, headerEnd } = await parts();
  const context = PDFContext.create();
  const plain = rawPdfWithTable(onePage());
  const view = readViewerXref(plain, context);
  assert.deepEqual([view.mode, view.shift, view.sections, String(view.root), view.info], ["sections", 0, 1, "1 0 R", undefined]);
  assert.deepEqual([...view.entries.keys()].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(view.entries.get(0), { free: true });
  const five = view.entries.get(5);
  assert.equal(latin1(plain).slice(five.offset, five.offset + 7), "5 0 obj");
  assert.equal(headerEnd(plain, five.offset, 5, 0), five.offset + 7);
  assert.equal(headerEnd(plain, five.offset, 4, 0), -1, "another object number");
  assert.equal(headerEnd(plain, five.offset, 5, 1), -1, "another generation");
  assert.equal(headerEnd(bytesOf("\n% a comment\n5 0 obj<<>>"), 0, 5, 0), 20, "white space and comments in front are skipped by both readers");
  assert.equal(headerEnd(bytesOf("5 0 objx"), 0, 5, 0), -1);

  const shifted = readViewerXref(rawPdfWithTable(onePage(), { junk: "0123456789" }), context);
  assert.deepEqual([shifted.mode, shifted.shift, shifted.entries.get(5).offset], ["sections", 10, five.offset]);

  const updated = readViewerXref(appendRevision(plain, [{ num: 5, body: content("NEW") }], { free: [3] }), context);
  assert.deepEqual([updated.sections, updated.entries.get(3)], [2, { free: true }]);
  assert.ok(updated.entries.get(5).offset > five.offset, "the entry of the newest section wins");

  // a table that starts at object 1 with a free entry means object 0 (pdf.js corrects it the same way)
  const text = latin1(plain);
  const quirk = readViewerXref(bytesOf(text.replace("xref\n0 6\n", "xref\n1 6\n")), context);
  assert.deepEqual([quirk.mode, quirk.entries.get(5).offset], ["sections", five.offset]);

  // numbers a lenient reader may or may not take for integers: no guess
  const odd = readViewerXref(bytesOf(text.replace(/(\d{10}) 00000 n \n(?=trailer)/, (line, offset) => `${Number(offset)}.0 00000 n \n`)), context);
  assert.equal(odd.mode, "unknown");
  assert.match(odd.reason, /plain integers/);
  // an entry that is no entry for any reader: the viewer gives the table up and scans
  const broken = readViewerXref(bytesOf(text.replace(/00000 n \n(?=trailer)/, "00000 x \n")), context);
  assert.equal(broken.mode, "scan");
  assert.deepEqual([...broken.entries.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(readViewerXref(bytesOf("not a pdf at all"), context).mode, "unknown");
});

test("findViewerDisagreements: positions are compared; a parse that was not traced is refused, never waved through", async () => {
  const { readViewerXref, headerEnd, findViewerDisagreements } = await parts();
  const bytes = rawPdfWithTable(onePage());
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const view = readViewerXref(bytes, PDFContext.create());
  assert.deepEqual(findViewerDisagreements(doc, bytes, { view, trace: null, plain: doc.context }), ["the parse of the file could not be traced"]);
  assert.match(findViewerDisagreements(doc, bytes, { view: { mode: "unknown", reason: "why" }, trace: { origins: new Map() }, plain: doc.context })[0], /cannot be told: why/);
  // a trace that says every definition was read 3 bytes further on
  const origins = new Map();
  for (const [number, entry] of view.entries) if (entry.offset) origins.set(PDFRef.of(number), { at: headerEnd(bytes, entry.offset, number, 0) });
  assert.deepEqual(findViewerDisagreements(doc, bytes, { view, trace: { origins }, plain: doc.context }), []);
  origins.set(PDFRef.of(5), { at: origins.get(PDFRef.of(5)).at + 3 });
  assert.deepEqual(findViewerDisagreements(doc, bytes, { view, trace: { origins }, plain: doc.context }), ["5 0 R: the viewer and the writer read different definitions"]);
});

test("the library's parser is traced only while this engine loads: its factory is back afterwards, also after an error", async () => {
  // if this fails after an upgrade of the library, robust.js traceParser() needs another way to learn where a
  // definition was read: until then loadForEdit() refuses every file (it never skips the check)
  const factory = PDFParser.forBytesWithOptions;
  assert.equal(typeof factory, "function");
  assert.equal(typeof PDFParser.prototype.parseIndirectObjectHeader, "function");
  assert.equal(typeof PDFParser.prototype.parseDocument, "function");
  const bytes = rawPdfWithTable(onePage());
  const loads = [loadForEdit(bytes), loadForEdit(bytes), loadForEdit(rawPdfWithTable(onePage(), { junk: "x\n" }))];
  assert.notEqual(PDFParser.forBytesWithOptions, factory, "wrapped while loads run");
  const other = await PDFDocument.load(rawPdfWithTable(onePage()), { updateMetadata: false });
  assert.equal(Object.prototype.hasOwnProperty.call(other.context, "assign"), false, "a load of somebody else is not traced");
  await Promise.all(loads);
  assert.equal(PDFParser.forBytesWithOptions, factory);
  await assert.rejects(() => loadForEdit(bytesOf("%PDF-1.7\nnothing")), (error) => error.code === "EXPORT_SOURCE_DAMAGED" || error.code === "EXPORT_SOURCE_INCONSISTENT");
  assert.equal(PDFParser.forBytesWithOptions, factory);
});
