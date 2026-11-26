// engine/sign: the byte-level layers under the signer and the inspector: PDF syntax helpers, the incremental
// writer, the raw cross-reference reader and the raw scanner / tokenizer.
import test from "node:test";
import assert from "node:assert/strict";
import { concatBytes, toHex, utf16beEncode } from "../src/pages/pdfEditor/engine/sign/bytes.js";
import { buildIncrementalUpdate } from "../src/pages/pdfEditor/engine/sign/incremental.js";
import { findLastStartXref, isLinearized, readHeader, readLastXrefSection, readXrefChain } from "../src/pages/pdfEditor/engine/sign/pdfRaw.js";
import {
  decodeTextString, enclosingObject, findObjectByScan, indexOfBytes, isPdfSyntaxError, lastIndexOfBytes, looksEncrypted, parseObject, parsePdfDate,
  scanByteRanges, scanRevisions
} from "../src/pages/pdfEditor/engine/sign/pdfScan.js";
import { appearanceMatrix, pdfDate, pdfName, pdfTextString } from "../src/pages/pdfEditor/engine/sign/pdfSign.js";
import { signPdf } from "../src/pages/pdfEditor/engine/sign/index.js";
import { pdfLib } from "./helpers/pdfTestKit.mjs";
import { CERTS, KEYS } from "./helpers/pdfSignFixtures.mjs";
import { importTestKey, latin1, makeSignablePdf } from "./helpers/pdfSignKit.mjs";

const ascii = (text) => new TextEncoder().encode(text);
// PDF bytes that were turned into latin1 text go back the same way (UTF-8 would shift every offset)
const fromLatin1 = (text) => new Uint8Array(Buffer.from(text, "latin1"));
const coded = (fn, code, params) => assert.throws(fn, (error) => {
  assert.equal(error.name, "PdfEditorError", `${error && error.name}: ${error && error.message}`);
  assert.equal(error.code, code);
  if (params) assert.deepEqual(error.params, params);
  return true;
});

const fixtures = {};
test.before(async () => {
  fixtures.classic = await makeSignablePdf({ objectStreams: false });
  fixtures.stream = await makeSignablePdf({ objectStreams: true });
  const signer = { certificate: CERTS.signer1, chain: [CERTS.intermediateCa, CERTS.rootCa], privateKey: await importTestKey(KEYS.signer1, "rsa") };
  fixtures.signed = (await signPdf(fixtures.classic, { signer, reason: "Đồng ý", signingTime: new Date("2026-11-16T01:00:00Z"), timeZoneOffsetMinutes: 420 })).bytes;
  fixtures.signedStream = (await signPdf(fixtures.stream, { signer })).bytes;
});

// ---------------------------------------------------------------------------------------------
// PDF syntax helpers of the signer
// ---------------------------------------------------------------------------------------------

test("raw: pdfTextString writes ASCII as an escaped literal and everything else as UTF-16BE hex with a BOM", () => {
  assert.equal(pdfTextString("Approved"), "(Approved)");
  assert.equal(pdfTextString("a (b) \\ c"), "(a \\(b\\) \\\\ c)");
  assert.equal(pdfTextString("Hà Nội"), "<FEFF004800E00020004E1ED90069>");
  assert.equal(pdfTextString(String.fromCodePoint(0x1d518)), "<FEFFD835DD18>");
  assert.equal(pdfTextString(""), "()");
  assert.equal(pdfTextString("line\nbreak"), "<FEFF006C0069006E0065000A0062007200650061006B>");
  // what the scanner reads back is what was written
  for (const text of ["Approved", "a (b) \\ c", "Tôi đồng ý với nội dung tài liệu", "line\nbreak"]) {
    assert.equal(decodeTextString(parseObject(ascii(pdfTextString(text)), 0).bytes), text);
  }
});

test("raw: pdfDate, pdfName and the appearance matrix of rotated pages", () => {
  const time = new Date("2026-11-16T01:02:03Z");
  assert.equal(pdfDate(time, 0), "D:20261116010203Z");
  assert.equal(pdfDate(time, 420), "D:20261116080203+07'00'");
  assert.equal(pdfDate(time, -330), "D:20261115193203-05'30'");
  assert.equal(parsePdfDate(pdfDate(time, 420)).date.toISOString(), time.toISOString());
  assert.equal(pdfName("ETSI.CAdES.detached"), "/ETSI.CAdES.detached");
  assert.equal(pdfName("My App (v2)"), "/My#20App#20#28v2#29");
  assert.equal(parseObject(ascii(pdfName("My App (v2)")), 0).value, "My App (v2)");
  const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  for (const rotation of [0, 90, 180, 270]) {
    const matrix = appearanceMatrix(rotation, 150, 50);
    const corners = [[0, 0], [150, 0], [0, 50], [150, 50]].map((point) => apply(matrix, point));
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    // counter-rotated by the page rotation and shifted back into the positive quadrant
    assert.equal(Math.min(...xs), 0);
    assert.equal(Math.min(...ys), 0);
    const quarter = rotation === 90 || rotation === 270;
    assert.equal(Math.max(...xs), quarter ? 50 : 150);
    assert.equal(Math.max(...ys), quarter ? 150 : 50);
  }
  // rotation 90: the "up" axis of the stamp points to -x of user space (which the viewer turns upwards)
  assert.deepEqual(appearanceMatrix(90, 150, 50).slice(2, 4), [-1, 0]);
  assert.deepEqual(appearanceMatrix(450, 10, 10), appearanceMatrix(90, 10, 10));
  assert.deepEqual(appearanceMatrix(-90, 10, 10), appearanceMatrix(270, 10, 10));
});

// ---------------------------------------------------------------------------------------------
// incremental writer
// ---------------------------------------------------------------------------------------------

test("raw: incremental update with a classic table (20-byte entries, subsections, allow-listed trailer)", () => {
  const original = ascii("%PDF-1.7\nfake\n%%EOF");
  const update = buildIncrementalUpdate({
    original,
    objects: [
      { objectNumber: 9, generationNumber: 0, body: ascii("<< /A 1 >>") },
      { objectNumber: 2, generationNumber: 0, body: ascii("<< /B 2 >>") },
      { objectNumber: 3, generationNumber: 1, body: ascii("[ 1 2 ]") },
      { objectNumber: 10, generationNumber: 0, body: ascii("(x)") }
    ],
    xrefType: "table",
    prevXrefOffset: 1234,
    size: 11,
    root: { objectNumber: 1, generationNumber: 0 },
    info: null,
    id: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)]
  });
  const text = latin1(update.bytes);
  assert.ok(text.startsWith("%PDF-1.7\nfake\n%%EOF\n2 0 obj\n"), "a newline is inserted when the original has none");
  assert.equal(update.updateStart, original.length + 1);
  const xref = text.slice(update.startxref);
  assert.match(xref, /^xref\n0 1\n0000000000 65535 f \n2 2\n\d{10} 00000 n \n\d{10} 00001 n \n9 2\n\d{10} 00000 n \n\d{10} 00000 n \ntrailer\n<< \/Size 11 \/Root 1 0 R \/ID \[<0102> <0304>\] \/Prev 1234 >>\nstartxref\n\d+\n%%EOF\n$/);
  for (const line of xref.split("\n").filter((entry) => /^\d{10} /.test(entry))) assert.equal(line.length + 1, 20);
  for (const [number, entry] of update.offsets) {
    assert.ok(text.slice(entry.offset).startsWith(`${number} `), `offset of object ${number}`);
    assert.equal(text.slice(entry.bodyOffset + entry.bodyLength, entry.bodyOffset + entry.bodyLength + 8), "\nendobj\n");
  }
  const common = { original, xrefType: "table", prevXrefOffset: 1, size: 11, root: { objectNumber: 1, generationNumber: 0 } };
  coded(() => buildIncrementalUpdate({ ...common, objects: [{ objectNumber: 11, generationNumber: 0, body: ascii("1") }] }), "SIGN_INTERNAL");
  coded(() => buildIncrementalUpdate({ ...common, objects: [{ objectNumber: 4, generationNumber: 0, body: ascii("1") }, { objectNumber: 4, generationNumber: 0, body: ascii("2") }] }), "SIGN_INTERNAL");
  coded(() => buildIncrementalUpdate({ ...common, objects: [{ objectNumber: 0, generationNumber: 0, body: ascii("1") }] }), "SIGN_INTERNAL");
  coded(() => buildIncrementalUpdate({ ...common, objects: [], xrefType: "hybrid" }), "SIGN_INTERNAL");
});

test("raw: incremental update with a cross-reference stream (own entry, /W, /Index, no extra EOL)", () => {
  const original = ascii("%PDF-1.7\nfake\n%%EOF\r\n");
  const update = buildIncrementalUpdate({
    original,
    objects: [
      { objectNumber: 5, generationNumber: 0, body: ascii("<< /A 1 >>") },
      { objectNumber: 12, generationNumber: 0, body: ascii("<< /B 2 >>") }
    ],
    xrefType: "stream",
    prevXrefOffset: 99,
    size: 13,
    root: { objectNumber: 1, generationNumber: 0 },
    info: { objectNumber: 2, generationNumber: 0 },
    id: null
  });
  const text = latin1(update.bytes);
  assert.equal(update.updateStart, original.length, "no blank line added when the file ends with an EOL");
  assert.equal(update.xrefStreamObjectNumber, 13);
  assert.equal(update.size, 14);
  const head = text.slice(update.startxref);
  assert.match(head, /^13 0 obj\n<< \/Type \/XRef \/Size 14 \/Root 1 0 R \/Info 2 0 R \/Prev 99 \/W \[1 4 2\] \/Index \[0 1 5 1 12 2\] \/Length 28 >>\nstream\n/);
  const data = Buffer.from(update.bytes.subarray(update.startxref + head.indexOf("stream\n") + 7)).subarray(0, 28);
  const row = (index) => [data[index * 7], data.readUInt32BE(index * 7 + 1), data.readUInt16BE(index * 7 + 5)];
  assert.deepEqual(row(0), [0, 0, 65535]);
  assert.deepEqual(row(1), [1, update.offsets.get(5).offset, 0]);
  assert.deepEqual(row(2), [1, update.offsets.get(12).offset, 0]);
  assert.deepEqual(row(3), [1, update.startxref, 0], "the stream lists itself");
  assert.ok(text.endsWith(`\nendstream\nendobj\nstartxref\n${update.startxref}\n%%EOF\n`));
});

// ---------------------------------------------------------------------------------------------
// raw cross-reference reader
// ---------------------------------------------------------------------------------------------

test("raw: last startxref, section type, /Prev chain of generated and signed files", () => {
  const classic = readLastXrefSection(fixtures.classic);
  assert.deepEqual([classic.type, classic.hybrid, classic.encrypt, classic.prev, classic.header.version], ["table", false, false, null, "1.7"]);
  assert.ok(classic.size > 5 && classic.root instanceof pdfLib.PDFRef);
  const stream = readLastXrefSection(fixtures.stream);
  assert.equal(stream.type, "stream");
  assert.ok(stream.xrefStreamRef instanceof pdfLib.PDFRef);
  assert.equal(isLinearized(fixtures.classic), false);
  assert.equal(readHeader(fixtures.classic).offset, 0);
  // a "startxref" without a number in trailing junk is skipped
  const junk = concatBytes(fixtures.classic, ascii("\n\n%%EOF junk startxref not-a-number\n"));
  assert.equal(findLastStartXref(junk).xrefOffset, findLastStartXref(fixtures.classic).xrefOffset);
  // the signed files: one more section of the same style, chained with /Prev
  const signed = readLastXrefSection(fixtures.signed);
  assert.deepEqual([signed.type, signed.prev], ["table", classic.offset]);
  assert.equal(signed.root.tag, classic.root.tag);
  assert.ok(signed.size > classic.size && signed.id);
  assert.deepEqual(readXrefChain(fixtures.signed).sections.map((section) => section.type), ["table", "table"]);
  assert.deepEqual(readXrefChain(fixtures.signedStream).sections.map((section) => section.type), ["stream", "stream"]);
  assert.deepEqual([readXrefChain(fixtures.signed).hybrid, readXrefChain(fixtures.signed).mixed, readXrefChain(fixtures.signed).problems], [false, false, []]);
});

test("raw: files an update must not be appended to, each with its code", () => {
  coded(() => readLastXrefSection(ascii("not a pdf")), "SIGN_NOT_A_PDF");
  coded(() => readLastXrefSection(new Uint8Array(0)), "SIGN_NOT_A_PDF");
  coded(() => readLastXrefSection(concatBytes(ascii("junk\n"), fixtures.classic)), "SIGN_LEADING_BYTES", { count: 5 });
  const text = latin1(fixtures.classic);
  const at = text.lastIndexOf("startxref");
  coded(() => readLastXrefSection(fixtures.classic.subarray(0, at)), "SIGN_DAMAGED_XREF", { reason: "no-startxref" });
  coded(() => readLastXrefSection(fromLatin1(`${text.slice(0, at)}startxref\n17\n%%EOF\n`)), "SIGN_DAMAGED_XREF", { reason: "bad-startxref" });
  coded(() => readLastXrefSection(fromLatin1(`${text.slice(0, at)}startxref\n99999999\n%%EOF\n`)), "SIGN_DAMAGED_XREF", { reason: "bad-startxref" });
  coded(() => readLastXrefSection(fromLatin1(text.replace("trailer", "tralier"))), "SIGN_DAMAGED_XREF", { reason: "bad-xref" });
  coded(() => readLastXrefSection(fromLatin1(text.replace(/\/Root \d+ 0 R/, "/Toor 1 0 R"))), "SIGN_DAMAGED_XREF", { reason: "bad-xref" });
  // an OLDER damaged section is a finding, not a refusal
  const chained = fromLatin1(`${text}\nxref\n0 0\ntrailer\n<< /Size ${readLastXrefSection(fixtures.classic).size} /Root ${readLastXrefSection(fixtures.classic).root} /Prev 12 >>\nstartxref\n${text.length + 1}\n%%EOF\n`);
  assert.deepEqual(readXrefChain(chained).problems, ["unreadable-section"]);
  const looping = fromLatin1(`${text}\nxref\n0 0\ntrailer\n<< /Size 9 /Root 1 0 R /Prev ${text.length + 1} >>\nstartxref\n${text.length + 1}\n%%EOF\n`);
  assert.deepEqual(readXrefChain(looping).problems, ["prev-loop"]);
});

// ---------------------------------------------------------------------------------------------
// raw scanner and tokenizer
// ---------------------------------------------------------------------------------------------

test("raw: the tokenizer reads dictionaries, arrays, names, numbers, references and strings with exact offsets", () => {
  const source = ascii("<< /Type /Sig /A#20B (x) /N [1 -2.5 +3 .5 12 0 R 7 8 ] /S (a\\(b\\)c \\\\ \\101\\n(nested (deep)) end) /H <48 65 6C 6c 6F> /E <> /D << /K true /L null /M false >> % comment\n /Z 1 >> tail");
  const dict = parseObject(source, 0);
  assert.equal(dict.type, "dict");
  assert.equal(dict.entries.get("Type").value, "Sig");
  assert.ok(dict.entries.has("A B")); // #20 is a space
  const numbers = dict.entries.get("N").items;
  assert.deepEqual(numbers.map((item) => item.type), ["number", "number", "number", "number", "ref", "number", "number"]);
  assert.deepEqual(numbers.filter((item) => item.type === "number").map((item) => item.value), [1, -2.5, 3, 0.5, 7, 8]);
  assert.deepEqual([numbers[4].num, numbers[4].gen], [12, 0]);
  assert.equal(new TextDecoder().decode(dict.entries.get("S").bytes), "a(b)c \\ A\n(nested (deep)) end");
  assert.equal(new TextDecoder().decode(dict.entries.get("H").bytes), "Hello");
  assert.equal(dict.entries.get("H").hex, true);
  assert.equal(dict.entries.get("E").bytes.length, 0);
  assert.equal(dict.entries.get("D").entries.get("K").value, true);
  assert.equal(dict.entries.get("D").entries.get("L").type, "null");
  assert.equal(dict.entries.get("Z").value, 1);
  assert.equal(new TextDecoder().decode(source.subarray(dict.end)), " tail");
  // offsets of a value are exact: this is what the byte range is compared with
  const hexString = dict.entries.get("H");
  assert.equal(new TextDecoder().decode(source.subarray(hexString.start, hexString.end)), "<48 65 6C 6c 6F>");
  // the first value of a repeated key wins (as in pdf.js)
  assert.equal(toHex(parseObject(ascii("<< /Contents <AA> /Contents <BB> >>"), 0).entries.get("Contents").bytes), "aa");
});

test("raw: tokenizer errors are SIGN_PDF_SYNTAX; hostile input neither crashes nor hangs", () => {
  for (const [bad, reason] of [["<< /A (unterminated", "unterminated-string"], ["<< /A <00", "unterminated-hex-string"], ["<< 12 >>", "bad-dictionary-key"], ["[ 1 2", "unexpected-end"], ["", "unexpected-end"], ["<< /A @ >>", "unexpected-token"]]) {
    assert.throws(() => parseObject(ascii(bad), 0), (error) => isPdfSyntaxError(error) && error.params.reason === reason, bad);
  }
  assert.throws(() => parseObject(ascii("[".repeat(100)), 0), (error) => error.code === "SIGN_PDF_SYNTAX" && error.params.reason === "too-deep");
  assert.throws(() => parseObject(ascii("(a\\"), 0), isPdfSyntaxError);
  let seed = 99;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = "<>[]()/ 0123456789RtrueFALSEnul\\\n%#.-+";
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: 1 + Math.floor(random() * 60) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    try {
      const node = parseObject(ascii(text), 0);
      assert.ok(node.end <= text.length + 1);
    } catch (error) {
      assert.ok(isPdfSyntaxError(error), `${JSON.stringify(text)}: ${error && error.stack}`);
    }
  }
});

test("raw: byte search, revisions, byte ranges and the object around them", () => {
  const data = ascii("abc startxref abc startxref end");
  const needle = ascii("startxref");
  assert.deepEqual([indexOfBytes(data, needle), indexOfBytes(data, needle, 5), indexOfBytes(data, needle, 19)], [4, 18, -1]);
  assert.deepEqual([lastIndexOfBytes(data, needle), lastIndexOfBytes(data, needle, 17), lastIndexOfBytes(data, ascii("zzz"))], [18, 4, -1]);

  assert.equal(scanRevisions(fixtures.classic).length, 1);
  assert.equal(scanRevisions(fixtures.stream).length, 1);
  const revisions = scanRevisions(fixtures.signed);
  assert.equal(revisions.length, 2);
  // the unsigned file ends right after %%EOF; the EOL that follows belongs to the update
  assert.equal(revisions[0].eofOffset + 5, fixtures.classic.length, "the first revision ends where the unsigned file ended");
  assert.equal(revisions[0].end, fixtures.classic.length + 1);
  assert.equal(revisions[1].end, fixtures.signed.length);
  assert.equal(revisions[1].xrefOffset, readLastXrefSection(fixtures.signed).offset);
  // "startxref 1400 %%EOF" as text whose number points into the file body, not at a cross-reference section
  const at = latin1(fixtures.classic).lastIndexOf("startxref");
  const fake = concatBytes(fixtures.classic.subarray(0, at), ascii("% startxref\n1400\n%%EOF\n"), fixtures.classic.subarray(at));
  assert.deepEqual(scanRevisions(fake).map((revision) => revision.xrefOffset), scanRevisions(fixtures.classic).map((revision) => revision.xrefOffset));

  const hits = scanByteRanges(fixtures.signed);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].values.length, 4);
  assert.equal(hits[0].values[0], 0);
  const object = enclosingObject(fixtures.signed, hits[0].keyOffset);
  assert.equal(object.gen, 0);
  const dict = parseObject(fixtures.signed, object.bodyOffset);
  assert.equal(dict.entries.get("Type").value, "Sig");
  const contents = dict.entries.get("Contents");
  assert.equal(contents.start, hits[0].values[1]);
  assert.equal(contents.end, hits[0].values[2]);
  assert.equal(hits[0].values[2] + hits[0].values[3], fixtures.signed.length);
  assert.equal(decodeTextString(dict.entries.get("Reason").bytes), "Đồng ý");
  assert.equal(parsePdfDate(decodeTextString(dict.entries.get("M").bytes)).date.toISOString(), "2026-11-16T01:00:00.000Z");
  // latest definition of an object by scanning; nothing encloses the cross-reference area
  assert.equal(findObjectByScan(fixtures.signed, object.num, 0).entries.get("Type").value, "Sig");
  assert.equal(findObjectByScan(fixtures.signed, 99999, 0), null);
  assert.equal(enclosingObject(fixtures.signed, fixtures.signed.length - 10), null);
  assert.deepEqual(scanByteRanges(ascii("/ByteRange [0 1 2] /ByteRange [a b] /ByteRange 5 /ByteRange[ 0 10 20 30 ]")).map((hit) => hit.values), [[0, 10, 20, 30]]);
});

test("raw: encryption hint, text strings and dates", async () => {
  assert.equal(looksEncrypted(fixtures.signed), false);
  const doc = await pdfLib.PDFDocument.load(fixtures.classic);
  doc.encrypt({ userPassword: "userpw", ownerPassword: "ownerpw" });
  assert.equal(looksEncrypted(await doc.save({ useObjectStreams: false })), true);
  assert.equal(decodeTextString(ascii("Signature1")), "Signature1");
  assert.equal(decodeTextString(concatBytes(Uint8Array.of(0xfe, 0xff), utf16beEncode("Tôi đồng ý"))), "Tôi đồng ý");
  assert.equal(decodeTextString(concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), new TextEncoder().encode("Hà Nội"))), "Hà Nội");
  assert.equal(decodeTextString(Uint8Array.of(0xff, 0xfe, 0x48, 0x00, 0xe0, 0x00)), "Hà");
  // PDFDocEncoding: bullet, em dash, euro, e acute, trade mark
  assert.equal(decodeTextString(Uint8Array.of(0x80, 0x84, 0xa0, 0xe9, 0x92)), String.fromCharCode(0x2022, 0x2014, 0x20ac, 0xe9, 0x2122));
  assert.equal(decodeTextString(new Uint8Array(0)), "");
  assert.equal(parsePdfDate("D:20261115235618+07'00'").date.toISOString(), "2026-11-15T16:56:18.000Z");
  assert.equal(parsePdfDate("D:20261115165618Z").date.toISOString(), "2026-11-15T16:56:18.000Z");
  assert.equal(parsePdfDate("D:20251104174614-08'00'").date.toISOString(), "2025-11-05T01:46:14.000Z");
  assert.equal(parsePdfDate("D:20261115").date.toISOString(), "2026-11-15T00:00:00.000Z");
  assert.equal(parsePdfDate("20261115235618+0700").date.toISOString(), "2026-11-15T16:56:18.000Z");
  assert.equal(parsePdfDate("D:20261115235618").hasTimeZone, false);
  assert.equal(parsePdfDate("garbage").date, null);
  assert.equal(parsePdfDate("").date, null);
});
