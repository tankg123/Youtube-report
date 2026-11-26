// engine/export: sources that are encrypted, damaged or badly written. The four bugs of the PDF library the
// engine is built around (Info lost for an encrypted file with a cross-reference stream, a font subset written
// once, "?" for standard fonts, load() without a catalog) and the parser's trouble with indirect stream lengths.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleDocument, detectSignatures, inspectSource } from "../src/pages/pdfEditor/engine/export/index.js";
import { findStreamLengthProblems, loadForEdit, predictStreamCuts, repairPageTree, repairStreamLengths } from "../src/pages/pdfEditor/engine/export/robust.js";
import { createPainter } from "../src/pages/pdfEditor/engine/export/painter.js";
import { extractText, fontBytes, fontkit, loadFont, makeTextPdf, pdfLib, squash, withPdf } from "./helpers/pdfTestKit.mjs";
import {
  ENCRYPTED_TITLE, appendRevision, buildEncryptedFixture, makeTextObject, rawPage, rawPdf, rawPdfWithIndirectLength, skeleton, streamBody
} from "./helpers/pdfExportFixtures.mjs";
import { fileFacts } from "./helpers/pdfExportScan.mjs";

const { PDFDocument, PDFRawStream, PDFInvalidObject, PDFRef, StandardFonts } = pdfLib;
const NOW = new Date(Date.UTC(2026, 10, 16, 2, 0, 0));
const OPTIONS = { fonts: loadFont, now: NOW, idSeed: new Uint8Array(16).fill(4) };
const jobOf = (bytes, source = {}, pages = [0]) => ({
  sources: [{ id: "s", bytes, ...source }],
  pages: pages.map((index) => ({ source: "s", index, rotate: 0 })),
  objects: pages.map(() => []),
  marks: [], assets: {}, info: {}, fileName: "robust"
});
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

// -----------------------------------------------------------------------------------------------------------
// encrypted sources
// -----------------------------------------------------------------------------------------------------------

test("an encrypted source opens with the user or the owner password and comes out as a plain file", async () => {
  const encrypted = await buildEncryptedFixture({ userPassword: "user123", ownerPassword: "owner123" });
  await assert.rejects(() => extractText(encrypted), /password/i, "the viewer needs the password too");
  for (const password of ["user123", "owner123"]) {
    const { bytes, report } = await assembleDocument(jobOf(encrypted, { password, expectedPages: 3 }, [2, 0]), OPTIONS);
    assert.deepEqual(await extractText(bytes), ["ENCRYPTED PAGE 3", "ENCRYPTED PAGE 1"], `opened with ${password}, read without`);
    const facts = await fileFacts(bytes);
    assert.deepEqual([facts.encrypted, facts.orphans, facts.audit, facts.revisions], [false, [], [], 1]);
    assert.equal(report.sources.s.encrypted, true);
    // the parser keeps the cross-reference stream of an encrypted file as an unreadable object: not the document's
    assert.deepEqual([report.warnings, report.sources.s.invalidObjects], [[], 0]);
    assert.ok(!latin1(bytes).includes("ENCRYPTED PAGE 2"), "the dropped page is not in the plain output");
  }
});

test("a file that only restricts permissions needs no password (the viewer never asked for one)", async () => {
  const restricted = await buildEncryptedFixture({ ownerPassword: "owner123" });
  assert.deepEqual(await extractText(restricted), ["ENCRYPTED PAGE 1", "ENCRYPTED PAGE 2", "ENCRYPTED PAGE 3"], "pdf.js opens it without a password");
  for (const password of [undefined, "", "owner123"]) {
    const { bytes } = await assembleDocument(jobOf(restricted, { password, expectedPages: 3 }, [1]), OPTIONS);
    assert.deepEqual(await extractText(bytes), ["ENCRYPTED PAGE 2"]);
    assert.equal((await fileFacts(bytes)).encrypted, false);
  }
  assert.equal((await inspectSource(restricted)).encrypted, true);
});

test("library bug: /Info of an encrypted file with a cross-reference stream is lost by the library; the engine reads it from the trailer the viewer uses", async () => {
  const encrypted = await buildEncryptedFixture({ userPassword: "user123" });
  const viewerTitle = await withPdf(encrypted, async (doc) => (await doc.getMetadata()).info.Title, { password: "user123" });
  assert.equal(viewerTitle, ENCRYPTED_TITLE, "pdf.js reads the title");
  const titleOf = (bytes) => withPdf(bytes, async (doc) => (await doc.getMetadata()).info.Title);

  // the library alone: no document information at all (if this fails the library was fixed; the engine does
  // not depend on it either way)
  const alone = await PDFDocument.load(encrypted, { updateMetadata: false, password: "user123" });
  assert.equal(alone.context.trailerInfo.Info, undefined);
  assert.equal(alone.getTitle(), undefined);

  // the engine: the title is exported without any help of the caller (the first version exported none)
  const own = await assembleDocument(jobOf(encrypted, { password: "user123" }), OPTIONS);
  assert.equal(await titleOf(own.bytes), ENCRYPTED_TITLE);
  assert.equal(own.report.sources.s.info.title, ENCRYPTED_TITLE);
  const { doc } = await loadForEdit(encrypted, { password: "user123" });
  assert.ok(doc.context.trailerInfo.Info instanceof PDFRef);

  const fromViewer = await assembleDocument(jobOf(encrypted, { password: "user123", info: { title: viewerTitle, author: "Trần Thị Bình" } }), OPTIONS);
  assert.equal(await titleOf(fromViewer.bytes), ENCRYPTED_TITLE);
  await withPdf(fromViewer.bytes, async (doc) => {
    const { info, metadata } = await doc.getMetadata();
    assert.equal(info.Author, "Trần Thị Bình");
    assert.equal(metadata.get("dc:title"), ENCRYPTED_TITLE);
  });

  const fromJob = await assembleDocument({ ...jobOf(encrypted, { password: "user123", info: { title: viewerTitle } }), info: { title: "Tên do người dùng đặt" } }, OPTIONS);
  assert.equal(await titleOf(fromJob.bytes), "Tên do người dùng đặt", "job.info wins over the source's information");
});

/**
 * An encrypted file in which every stream has an INDIRECT /Length, as pdfTeX / LibreOffice / Ghostscript write
 * them. Made from a library-written file by rewriting its text: "/Length n" becomes "/Length k 0 R" and the
 * numbers are appended as objects (the parser reads sequentially, the cross-reference offsets do not matter
 * to it). Returns the rewritten file and the untouched one (same object numbers, direct lengths).
 */
async function encryptedWithIndirectLengths() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= 40; number += 1) {
    doc.addPage([200, 100]).drawText(`INDIRECT LENGTH PAGE ${number} ${"x".repeat(number % 7)}`, { x: 10, y: 50, size: 10, font });
  }
  doc.encrypt({ userPassword: "user123", ownerPassword: "owner123" });
  const original = await doc.save({ useObjectStreams: false });
  const text = latin1(original);
  let next = Math.max(...[...text.matchAll(/(\d+) 0 obj/g)].map((match) => Number(match[1]))) + 1;
  const extra = [];
  const startxref = text.lastIndexOf("xref\n0 ");
  const body = text.slice(0, startxref).replace(/\/Length (\d+)((?:(?!endobj)[\s\S])*?>>\nstream\n)/g, (whole, length, rest) => {
    extra.push(`${next} 0 obj\n${length}\nendobj\n`);
    next += 1;
    return `/Length ${next - 1} 0 R${rest}`;
  });
  return { original, rewritten: Uint8Array.from(Buffer.from(body + extra.join("") + text.slice(startxref), "latin1")), streams: extra.length };
}

test("an encrypted source with indirect stream lengths: the bytes the parser cuts off are not lost", async () => {
  // The parser searches for "endstream" instead of using an indirect /Length and takes a carriage return at the
  // end of the data for the end-of-line: one stream in 256. For cipher text that costs the last AES block.
  let fixture = null;
  let cuts = [];
  for (let attempt = 0; attempt < 400 && !cuts.length; attempt += 1) {
    fixture = await encryptedWithIndirectLengths();
    const plain = await PDFDocument.load(fixture.rewritten, { updateMetadata: false, password: "user123" });
    cuts = predictStreamCuts(plain, fixture.rewritten);
  }
  assert.ok(cuts.length > 0, "no fixture with a stream that ends in a carriage return was found");
  assert.ok(fixture.streams >= 40);

  const reference = await PDFDocument.load(fixture.original, { updateMetadata: false, password: "user123" }); // direct lengths: read correctly
  const libraryAlone = await PDFDocument.load(fixture.rewritten, { updateMetadata: false, password: "user123" });
  const { doc: repaired, facts } = await loadForEdit(fixture.rewritten, { password: "user123" });
  const contentsOf = (document, ref) => {
    const object = document.context.lookup(ref);
    return object instanceof PDFRawStream ? Buffer.from(object.contents).toString("base64") : `not a stream: ${object && object.constructor.name}`;
  };
  const streamRefs = reference.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream).map(([ref]) => ref);
  const damaged = streamRefs.filter((ref) => contentsOf(libraryAlone, ref) !== contentsOf(reference, ref));
  assert.deepEqual(damaged.map(String).sort(), cuts.map((cut) => String(cut.ref)).sort(), "the prediction names exactly the streams the library reads wrongly");
  for (const ref of streamRefs) assert.equal(contentsOf(repaired, ref), contentsOf(reference, ref), `stream ${ref} after the repair`);
  assert.equal(facts.encrypted, true);
  assert.deepEqual(facts.repair, { problems: cuts.length, repaired: cuts.length, failed: [] });

  const { bytes, report } = await assembleDocument(jobOf(fixture.rewritten, { password: "user123", expectedPages: 40 }, [...Array(40).keys()]), OPTIONS);
  assert.deepEqual(report.warnings.filter((warning) => warning.code === "EXPORT_STREAMS_REPAIRED"), [{ code: "EXPORT_STREAMS_REPAIRED", params: { source: "s", streams: cuts.length } }]);
  const texts = await extractText(bytes);
  texts.forEach((text, index) => assert.ok(text.startsWith(`INDIRECT LENGTH PAGE ${index + 1}`), `page ${index + 1}: ${text}`));
});

// -----------------------------------------------------------------------------------------------------------
// indirect /Length in plain files
// -----------------------------------------------------------------------------------------------------------

test("indirect /Length: what the parser loses, how it is found and repaired", async (t) => {
  const cases = [
    ["data ending in CR, then the end-of-line", "BT /F1 12 Tf 20 100 Td (TAIL-CR) Tj ET\r", { eolBeforeEndstream: "\n" }, "wrong length"],
    ["data ending in CR, endstream right behind it", "BT /F1 12 Tf 20 100 Td (TAIL-CR2) Tj ET\r", { eolBeforeEndstream: "" }, "wrong length"],
    ["data ending in LF, endstream right behind it", "BT /F1 12 Tf 20 100 Td (TAIL-LF) Tj ET\n", { eolBeforeEndstream: "" }, "wrong length"],
    ["data ending in CR LF, endstream right behind it", "BT /F1 12 Tf 20 100 Td (TAIL-CRLF) Tj ET\r\n", { eolBeforeEndstream: "" }, "wrong length"],
    ["data containing \"endstream\"", "BT /F1 12 Tf 20 100 Td (the keyword endstream ends a stream) Tj 0 -20 Td (SECOND-LINE) Tj ET", {}, "wrong length"],
    ["data containing the word \"stream\"", "BT /F1 12 Tf 20 100 Td (upstream and downstream) Tj ET", {}, "unparsed stream"]
  ];
  for (const [label, data, options, kind] of cases) {
    await t.test(label, async () => {
      const bytes = rawPdfWithIndirectLength(data, options);
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const problems = findStreamLengthProblems(doc);
      assert.deepEqual(problems.map((problem) => [String(problem.ref), problem.kind]), [["5 0 R", kind]]);
      if (kind === "unparsed stream") assert.ok(doc.context.lookup(PDFRef.of(5)) instanceof PDFInvalidObject, "the library keeps the object as raw bytes");
      // the byte-level prediction agrees with what the parsed document shows
      assert.deepEqual(predictStreamCuts(doc, bytes).map((cut) => String(cut.ref)), ["5 0 R"]);
      assert.deepEqual(repairStreamLengths(doc, bytes), { problems: 1, repaired: 1, failed: [] });
      assert.equal(latin1(doc.context.lookup(PDFRef.of(5)).contents), data);
      assert.deepEqual(findStreamLengthProblems(doc), []);
      // through the export: the page text is whole
      const { bytes: out, report } = await assembleDocument(jobOf(bytes, { expectedPages: 1 }), OPTIONS);
      assert.equal(report.sources.s.repair.repaired, 1);
      const expected = [...data.matchAll(/\(([^)]*)\) Tj/g)].map((match) => match[1]).join("");
      assert.equal(squash((await extractText(out))[0]), squash(expected));
    });
  }
  await t.test("a stream that is read correctly is left alone", async () => {
    const bytes = rawPdfWithIndirectLength("BT /F1 12 Tf 20 100 Td (FINE) Tj ET");
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.deepEqual(findStreamLengthProblems(doc), []);
    assert.deepEqual(predictStreamCuts(doc, bytes), []);
    const { report } = await assembleDocument(jobOf(bytes), OPTIONS);
    assert.deepEqual(report.warnings, []);
  });
  await t.test("an incremental update, also right behind %%EOF without a newline: the stream of the UPDATE is the one that is repaired", async () => {
    const first = rawPdfWithIndirectLength("BT /F1 12 Tf 20 100 Td (OLD) Tj ET");
    const newer = [{ num: 5, body: streamBody("", "BT /F1 12 Tf 20 100 Td (NEW) Tj ET\r", { length: "/Length 7 0 R" }) }, { num: 7, body: "35" }];
    // an update the way signing tools write it: "%%EOF" + "5 0 obj", then its own cross-reference section
    const updated = appendRevision(first, newer, { separator: "" });
    assert.ok(latin1(updated).includes("%%EOF5 0 obj"));
    assert.deepEqual(await extractText(updated), ["NEW"]);
    const { doc, facts } = await loadForEdit(updated);
    assert.equal(facts.repair.repaired, 1);
    assert.equal(latin1(doc.context.lookup(PDFRef.of(5)).contents), "BT /F1 12 Tf 20 100 Td (NEW) Tj ET\r");
    // The first version of this test appended the two objects WITHOUT a section and pinned that the last
    // definition wins. A viewer still shows "OLD" for such a file (its table knows nothing of the appendix):
    // the export would hold text that was never shown, so the file is refused.
    const appended = Uint8Array.from(Buffer.concat([
      Buffer.from(first).subarray(0, first.length - 1),
      Buffer.from("5 0 obj\n"), newer[0].body, Buffer.from("\nendobj\n7 0 obj\n35\nendobj\n")
    ]));
    assert.deepEqual(await extractText(appended), ["OLD"]);
    await assert.rejects(() => loadForEdit(appended, { source: "s" }), (error) => error.code === "EXPORT_SOURCE_INCONSISTENT" && error.params.source === "s");
  });
});

// -----------------------------------------------------------------------------------------------------------
// damaged structure
// -----------------------------------------------------------------------------------------------------------

test("files a viewer shows although they are not well formed: the export reads them the same way", async (t) => {
  const good = await makeTextPdf([{ lines: ["DAMAGE-P1"], size: [300, 200] }, { lines: ["DAMAGE-P2"], size: [300, 200] }], { useObjectStreams: false });
  const text = latin1(good);
  const variants = {
    "the healthy file (control)": good,
    "2 kB of text after %%EOF": Uint8Array.from(Buffer.concat([Buffer.from(good), Buffer.from("\n<html><body>".padEnd(2048, "x"))])),
    "100 bytes before the header": Uint8Array.from(Buffer.concat([Buffer.from("junk ".repeat(20)), Buffer.from(good)])),
    "the startxref line and %%EOF removed": Uint8Array.from(Buffer.from(text.slice(0, text.lastIndexOf("startxref")), "latin1")),
    "startxref points into the middle of the file": Uint8Array.from(Buffer.from(text.replace(/startxref\n\d+/, "startxref\n123"), "latin1"))
  };
  for (const [label, bytes] of Object.entries(variants)) {
    await t.test(label, async () => {
      assert.deepEqual(await extractText(bytes), ["DAMAGE-P1", "DAMAGE-P2"], "the viewer shows the file");
      const { bytes: out } = await assembleDocument(jobOf(bytes, { expectedPages: 2 }, [1, 0]), OPTIONS);
      assert.deepEqual(await extractText(out), ["DAMAGE-P2", "DAMAGE-P1"]);
      const facts = await fileFacts(out);
      assert.deepEqual([facts.orphans, facts.audit, facts.revisions], [[], [], 1]);
    });
  }
  await t.test("the cross-reference table and the trailer cut off: no viewer opens it, and the engine does not guess", async () => {
    // (The first version of this test cut at the "xref" inside "startxref", which left table and trailer in
    // place, and expected an export.) Without a trailer nothing says which catalog is the document's:
    // pdf.js refuses the file, and the engine cannot know what a viewer would show.
    const cut = Uint8Array.from(Buffer.from(text.slice(0, text.lastIndexOf("\nxref\n") + 1), "latin1"));
    assert.ok(!latin1(cut).includes("trailer"));
    await assert.rejects(() => extractText(cut), /Invalid PDF structure/);
    await assert.rejects(() => assembleDocument(jobOf(cut, {}, [1, 0]), OPTIONS), (error) => error.code === "EXPORT_SOURCE_INCONSISTENT");
  });
});

test("a page without /Type and a catalog without /Type are restored before pages are counted", async () => {
  const content = (text) => streamBody("", `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`);
  const objects = [{ num: 4, body: rawPage(5, { type: "" }) }, { num: 5, body: content("FIRST") }, { num: 6, body: rawPage(7) }, { num: 7, body: content("SECOND") }];
  const untypedPage = rawPdf([...skeleton([4, 6]), ...objects]);
  const plain = await PDFDocument.load(untypedPage, { updateMetadata: false });
  assert.equal(plain.getPageCount(), 1, "the library alone skips the page: the viewer shows two");
  assert.deepEqual(await extractText(untypedPage), ["FIRST", "SECOND"]);
  const again = await PDFDocument.load(untypedPage, { updateMetadata: false });
  assert.deepEqual(repairPageTree(again), { leavesFixed: 1, nodesFixed: 0 });
  assert.equal(again.getPageCount(), 2);

  const untypedCatalog = rawPdf([...skeleton([4, 6], { catalogType: "" }), ...objects.map((object) => (object.num === 4 ? { num: 4, body: rawPage(5) } : object))]);
  const { facts } = await loadForEdit(untypedCatalog);
  assert.equal(facts.pages, 2);
  const { bytes } = await assembleDocument(jobOf(untypedCatalog, { expectedPages: 2 }, [1, 0]), OPTIONS);
  assert.deepEqual(await extractText(bytes), ["SECOND", "FIRST"]);
});

// -----------------------------------------------------------------------------------------------------------
// signatures, input handling, the library's remaining bugs
// -----------------------------------------------------------------------------------------------------------

test("detectSignatures: a byte scan that needs no parser", () => {
  const head = "%PDF-1.7\n1 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /Contents <00> /ByteRange [0 120 180 ";
  const signedAll = Buffer.from(`${head}40] >>\nendobj\n`.padEnd(220, " "), "latin1");
  const one = detectSignatures(Uint8Array.from(signedAll));
  assert.deepEqual([one.signed, one.count, one.byteRanges[0].range, one.byteRanges[0].coversWholeFile, one.byteRanges[0].kind], [true, 1, [0, 120, 180, 40], true, "signature"]);

  const followed = detectSignatures(Uint8Array.from(Buffer.concat([signedAll, Buffer.from("\n9 0 obj\n<< /Type /DocTimeStamp /ByteRange [ 0 300 400 50 ] /Contents <00> >>\nendobj\n<< /FT /Sig /T (Empty) >>\n<< /TransformMethod /DocMDP >>\n".padEnd(450 - 220, " "))])));
  assert.deepEqual(followed.byteRanges.map((entry) => [entry.kind, entry.coversWholeFile]), [["signature", false], ["timestamp", true]]);
  assert.deepEqual([followed.count, followed.docMDP, followed.hasSigField], [2, true, true]);

  // an ISO 32004 integrity code has a /ByteRange too and is not a signature
  const mac = detectSignatures(Uint8Array.from(Buffer.from("trailer << /AuthCode << /MAC <00> /ByteRange [0 10 20 30] >> >> /FT /Signature /ByteRangeX [1 2 3 4]")));
  assert.deepEqual([mac.signed, mac.count, mac.byteRanges.map((entry) => entry.kind), mac.hasSigField], [false, 0, ["mac"], false]);
  assert.deepEqual(detectSignatures(new Uint8Array(0)), { signed: false, count: 0, byteRanges: [], docMDP: false, hasSigField: false });
});

test("the bytes of a source are only read: a view into a larger buffer works and nothing is written into it", async () => {
  const source = await makeTextPdf([{ lines: ["VIEW-P1"], size: [300, 200] }]);
  const big = new Uint8Array(source.length + 2000).fill(0x20);
  big.set(source, 1000);
  const copy = Uint8Array.from(big);
  const view = big.subarray(1000, 1000 + source.length);
  const { bytes } = await assembleDocument(jobOf(view, { expectedPages: 1 }), OPTIONS);
  assert.deepEqual(await extractText(bytes), ["VIEW-P1"]);
  assert.equal(Buffer.compare(Buffer.from(big), Buffer.from(copy)), 0);
});

test("library bug: text drawn with a subset font after the first flush is corrupt, so the engine flushes once", async () => {
  const first = "Trước khi ghi";
  const second = "Sau khi ghi ĐđẮắ";
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes("arimo-regular"), { subset: true });
  const page = doc.addPage([300, 100]);
  page.drawText(first, { x: 10, y: 60, size: 12, font });
  await doc.flush(); // what an intermediate save() would do
  page.drawText(second, { x: 10, y: 30, size: 12, font });
  const [broken] = await extractText(await doc.save());
  assert.ok(broken.startsWith(first));
  assert.ok(!broken.includes(second), "if this fails the library was fixed and the single-flush rule could be relaxed");

  // the engine: every object of every page is drawn before the one flush, also when a face is used on many pages
  const pages = Array.from({ length: 6 }, (_, index) => makeTextObject({ lines: [`Trang ${index + 1}: chữ mới ${"ĐđẮắỆệỞở".slice(index, index + 3)}`], x: 150, y: 100 }));
  const { bytes } = await assembleDocument({
    sources: [], pages: pages.map(() => ({ blank: [300, 200], rotate: 0 })), objects: pages.map((object) => [object]), marks: [], assets: {}, info: {}, fileName: "flush"
  }, OPTIONS);
  assert.deepEqual(await extractText(bytes), pages.map((object) => object.text));
});

test("library bug: a standard font writes \"?\" for what it cannot encode; the painter only knows embedded faces", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([200, 50]).drawText("Nguyễn", { x: 10, y: 20, size: 12, font: helvetica });
  assert.deepEqual(await extractText(await doc.save()), ["Nguy?n"], "if this fails the library was fixed");

  // the engine has no path to a standard font: a face is a FontKey whose bytes the caller supplies
  const out = await PDFDocument.create({ updateMetadata: false });
  const painter = createPainter(out, { fonts: async (fontKey) => fontBytes(fontKey) });
  const page = out.addPage([200, 50]);
  const text = makeTextObject({ lines: ["Nguyễn"], x: 100, y: 25 });
  await painter.prepare([[text]]);
  painter.drawPage(page, 0, [text]);
  assert.deepEqual(painter.fontsEmbedded, ["arimo-regular"]);
  assert.deepEqual(await extractText(await out.save()), ["Nguyễn"]);
});
