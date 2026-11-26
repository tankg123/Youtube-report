// The tokenizer and serializer of content streams (engine/redact/contentStream.js).
import test from "node:test";
import assert from "node:assert/strict";
import {
  ContentParseError, createTokenReader, formatHexString, formatLiteralString, formatName, formatNumber, parseContentStream, serializeOperations
} from "../src/pages/pdfEditor/engine/redact/contentStream.js";
import { VIETNAMESE_SAMPLE, makeTextPdf, pdfLib } from "./helpers/pdfTestKit.mjs";
import { A, bytesOf, latin1, load } from "./helpers/pdfRedactKit.mjs";
import { annotatedFormPdf } from "./helpers/pdfRedactFixtures.mjs";

const parse = (s) => parseContentStream(typeof s === "string" ? bytesOf(s) : s);
const ops = (s) => parse(s).ops;
const str = (t) => latin1(t.value);

test("numbers: integers, reals, signs, leading and trailing dot", () => {
  const [op] = ops("42 -7 +3 4. .5 -.25 0.0 d0x");
  // "d0x" is an unknown operator that collects the operands
  assert.deepEqual(op.args.map((a) => a.value), [42, -7, 3, 4, 0.5, -0.25, 0]);
  assert.deepEqual(op.args.map((a) => a.isInt), [true, true, true, false, false, false, false]);
  assert.equal(op.known, false);
});

test("names: #xx escapes are decoded, formatName writes them back", () => {
  const [op] = ops("/F#31 12 Tf");
  assert.equal(op.args[0].value, "F1");
  const [op2] = ops("/A#20B#23C /Lime#20Green DP");
  assert.equal(op2.args[0].value, "A B#C");
  assert.equal(op2.args[1].value, "Lime Green");
  assert.equal(formatName("A B#C"), "/A#20B#23C");
  assert.equal(formatName("F1"), "/F1");
  assert.equal(formatName("a(b)"), "/a#28b#29");
  assert.throws(() => ops("/A#2 Do"), ContentParseError);
});

test("literal strings: nesting, escapes, octal, line continuation, raw end of line", () => {
  assert.equal(str(ops("(a (nested (deep)) b) Tj")[0].args[0]), "a (nested (deep)) b");
  assert.equal(str(ops("(esc \\( \\) \\\\ end) Tj")[0].args[0]), "esc ( ) \\ end");
  assert.equal(str(ops("(\\n\\r\\t\\b\\f) Tj")[0].args[0]), "\n\r\t\b\f");
  assert.equal(str(ops("(\\101\\102\\103 \\351) Tj")[0].args[0]), "ABC \xe9");
  assert.equal(str(ops("(\\1\\12\\0053) Tj")[0].args[0]), "\x01\x0a\x053"); // one, two and three octal digits
  assert.equal(str(ops("(\\777) Tj")[0].args[0]), "\xff"); // overflow: high-order bits ignored
  assert.equal(str(ops("(line \\\ncontinued \\\r\nagain \\\rdone) Tj")[0].args[0]), "line continued again done");
  assert.equal(str(ops("(a\rb\r\nc\nd) Tj")[0].args[0]), "a\nb\nc\nd"); // every raw EOL reads as one LF
  assert.equal(str(ops("(un\\known \\q) Tj")[0].args[0]), "unknown q"); // unknown escape: the backslash is ignored
  assert.equal(str(ops("() Tj")[0].args[0]), "");
  assert.throws(() => ops("(never closed Tj"), ContentParseError);
});

test("hex strings: white space, odd number of digits, case", () => {
  assert.equal(str(ops("<4F50 532D\n48 45 58> Tj")[0].args[0]), "OPS-HEX");
  assert.equal(str(ops("<4f50532d4845582D4F44443> Tj")[0].args[0]), "OPS-HEX-ODD0");
  assert.equal(ops("<> Tj")[0].args[0].value.length, 0);
  assert.throws(() => ops("<4G> Tj"), ContentParseError);
  assert.throws(() => ops("<4F Tj"), ContentParseError);
});

test("arrays, dictionaries, keywords, comments", () => {
  const [tj] = ops("[(Am) -20 (ount) 0.5 <41>] TJ");
  assert.deepEqual(tj.args[0].items.map((t) => t.type), ["str", "num", "str", "num", "hex"]);
  const [bdc] = ops("/Span << /ActualText (x) /MCID 3 /Nested << /A [1 2 /N true null] >> >> BDC");
  assert.equal(bdc.op, "BDC");
  const dict = bdc.args[1];
  assert.deepEqual(dict.entries.map(([k]) => k.value), ["ActualText", "MCID", "Nested"]);
  const nested = dict.entries[2][1].entries[0][1];
  assert.deepEqual(nested.items.map((t) => t.value), [1, 2, "N", true, null]);
  const p = parse("% a comment (with parens) Tj ET BT\nBT % another [\n/F1 12 Tf ET");
  assert.deepEqual(p.ops.map((o) => o.op), ["BT", "Tf", "ET"]);
  assert.equal(p.comments.length, 2);
  assert.throws(() => ops("[1 2 Tj"), ContentParseError);
  assert.throws(() => ops("<< /A 1 Tj"), ContentParseError);
  assert.throws(() => ops("<< 1 2 >> BDC"), ContentParseError);
  assert.throws(() => ops("1 ] m"), ContentParseError);
});

test("operators: quotes, tight syntax, CR / CRLF line ends", () => {
  assert.deepEqual(ops("(a)'(b)'").map((o) => o.op), ["'", "'"]);
  assert.deepEqual(ops("1 2 (c)\"").map((o) => [o.op, o.args.length]), [["\"", 3]]);
  assert.deepEqual(ops("BT/F1 12 Tf 72 740 Td(tight)Tj ET").map((o) => o.op), ["BT", "Tf", "Td", "Tj", "ET"]);
  assert.deepEqual(ops("[(a)-0(b)0.0(c)]TJ[]TJ[()]TJ").map((o) => o.op), ["TJ", "TJ", "TJ"]);
  assert.deepEqual(ops("BT\r/F1 12 Tf\r\n(x) Tj\rET\r").map((o) => o.op), ["BT", "Tf", "Tj", "ET"]);
  assert.deepEqual(ops("f* B* b* W* T*").map((o) => [o.op, o.known]), [["f*", true], ["B*", true], ["b*", true], ["W*", true], ["T*", true]]);
});

test("inline images: the end of the data is found by length, by end-of-data marker and by scanning", () => {
  // ASCIIHex: ends at ">"
  let p = parse("q BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID FF0000 00FF00 > EI Q");
  assert.deepEqual(p.ops.map((o) => o.op), ["q", "BI", "Q"]);
  assert.equal(p.ops[1].inlineImage.method, "eod");
  // raw binary whose bytes contain "EI" surrounded by white space: the length is computed from W, H, BPC, CS
  const data = Buffer.alloc(64, 0x80);
  Buffer.from(" EI Q ").copy(data, 10);
  Buffer.from("\nEI\n").copy(data, 40);
  const raw = Buffer.concat([Buffer.from("q BI /W 8 /H 8 /CS /G /BPC 8 ID "), data, Buffer.from("\nEI\nQ BT ET")]);
  p = parse(new Uint8Array(raw));
  assert.deepEqual(p.ops.map((o) => o.op), ["q", "BI", "Q", "BT", "ET"]);
  assert.equal(p.ops[1].inlineImage.method, "computed");
  assert.equal(p.ops[1].inlineImage.dataEnd - p.ops[1].inlineImage.dataStart, 64);
  // image mask: 1 bit per pixel
  p = parse(new Uint8Array(Buffer.concat([Buffer.from("BI /W 16 /H 2 /IM true ID "), Buffer.from([1, 2, 3, 4]), Buffer.from(" EI n")])));
  assert.equal(p.ops[0].inlineImage.method, "computed");
  // ASCII85: ends at "~>"
  p = parse("BI /W 1 /H 1 /CS /G /BPC 8 /F /A85 ID 5l~> EI S");
  assert.equal(p.ops[0].inlineImage.method, "eod");
  // PDF 2.0 length
  p = parse(new Uint8Array(Buffer.concat([Buffer.from("BI /W 4 /H 4 /CS /MyCS /BPC 8 /L 5 ID "), Buffer.from([0x45, 0x49, 0x20, 0x45, 0x49]), Buffer.from(" EI Q")])));
  assert.equal(p.ops[0].inlineImage.method, "length");
  assert.deepEqual(p.ops.map((o) => o.op), ["BI", "Q"]);
  // unknown colour space and a filter that hides the length: scan, and skip an "EI" that is followed by binary data
  const flate = Buffer.concat([Buffer.from([0x78, 0x9c, 0x01]), Buffer.from(" EI \x00\x01\x02\xff\xfe", "latin1"), Buffer.from([0x90, 0x91])]);
  p = parse(new Uint8Array(Buffer.concat([Buffer.from("q BI /W 4 /H 4 /CS /MyCS /BPC 8 /F /Fl ID "), flate, Buffer.from("\nEI\nQ\nBT /F1 9 Tf (after) Tj ET")])));
  assert.deepEqual(p.ops.map((o) => o.op), ["q", "BI", "Q", "BT", "Tf", "Tj", "ET"]);
  assert.equal(p.ops[1].inlineImage.method, "scan");
  // no EI at all
  assert.throws(() => parse("BI /W 1 /H 1 /CS /MyCS /BPC 8 /F /Fl ID abc"), ContentParseError);
  assert.throws(() => parse("1 0 0 1 0 0 cm EI"), ContentParseError);
});

test("formatters", () => {
  assert.equal(formatNumber(12), "12");
  assert.equal(formatNumber(-0.50000001), "-0.5");
  assert.equal(formatNumber(1 / 3, 4), "0.3333");
  assert.equal(formatNumber(-0.000001), "0");
  assert.equal(formatNumber(1e-7), "0");
  assert.equal(formatNumber(123456.789, 2), "123456.79");
  assert.throws(() => formatNumber(NaN));
  assert.equal(formatLiteralString(bytesOf("a(b)c\\d\n\xe9")), "(a\\(b\\)c\\\\d\\012\\351)");
  assert.equal(formatHexString(Uint8Array.of(0, 10, 255)), "<000AFF>");
  // what the formatters write is read back identically
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(parse(`${formatLiteralString(all)} Tj`).ops[0].args[0].value, all);
  assert.deepEqual(parse(`${formatHexString(all)} Tj`).ops[0].args[0].value, all);
});

test("serialization: untouched operations are byte-identical; replacements and drops stay well-formed", () => {
  const src = bytesOf("q\n  1 0 0 1 10 20 cm % move\nBT/F1 12 Tf(abc)Tj ET\n[(x)-5(y)]TJ Q   % tail comment\n");
  const p = parse(src);
  assert.deepEqual(serializeOperations(src, p.ops, p.tailStart), src);
  // replace the Tj, drop the cm
  const items = p.ops.slice();
  items[1] = null;
  items[4] = { raw: "[(a) -100 (c)] TJ" };
  const out = serializeOperations(src, items, p.tailStart);
  assert.deepEqual(parse(out).ops.map((o) => o.op), ["q", "BT", "Tf", "TJ", "ET", "TJ", "Q"]);
  assert.ok(latin1(out).includes("BT/F1 12 Tf"));
  assert.ok(latin1(out).includes("[(x)-5(y)]TJ Q"));
  // comments can be stripped; operands and operators stay as they were
  const stripped = latin1(serializeOperations(src, p.ops, p.tailStart, { stripComments: p.comments }));
  assert.ok(!stripped.includes("move") && !stripped.includes("tail comment"));
  assert.deepEqual(parse(bytesOf(stripped)).ops.map((o) => o.op), p.ops.map((o) => o.op));
  assert.ok(stripped.includes("1 0 0 1 10 20 cm") && stripped.includes("BT/F1 12 Tf(abc)Tj ET"));
});

test("token reader (used for CMaps)", () => {
  const next = createTokenReader(bytesOf("1 begincodespacerange <00> <FF> endcodespacerange /WMode 1 def"));
  const kinds = [];
  for (let t = next(); t; t = next()) kinds.push(t.type);
  assert.deepEqual(kinds, ["num", "op", "hex", "hex", "op", "name", "num", "op"]);
});

test("every content stream the PDF library writes parses and serializes back byte-identically", async () => {
  let streams = 0;
  let operations = 0;
  const check = (bytes, what) => {
    const p = parseContentStream(bytes);
    assert.equal(Buffer.compare(Buffer.from(serializeOperations(bytes, p.ops, p.tailStart)), Buffer.from(bytes)), 0, `${what}: round trip differs`);
    for (const o of p.ops) assert.ok(o.known, `${what}: unknown operator "${o.op}"`);
    streams += 1;
    operations += p.ops.length;
  };
  // pages drawn by the library (text in embedded and standard fonts, shapes, images), and the appearance
  // streams it generates for form fields
  const drawn = await pdfLib.PDFDocument.create({ updateMetadata: false });
  const helvetica = await drawn.embedFont(pdfLib.StandardFonts.Helvetica);
  const page = drawn.addPage([400, 300]);
  page.drawText("drawn (with) \\ parens", { x: 20, y: 250, size: 11, font: helvetica, rotate: pdfLib.degrees(15) });
  page.drawRectangle({ x: 20, y: 20, width: 100, height: 40, borderWidth: 2, color: pdfLib.rgb(1, 0, 0), opacity: 0.5 });
  page.drawEllipse({ x: 200, y: 100, xScale: 50, yScale: 20 });
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: 400, y: 300 }, dashArray: [3, 2] });
  page.drawSvgPath("M 0 0 C 10 20 30 40 50 60 Z", { x: 100, y: 200 });
  const sources = [await drawn.save(), await makeTextPdf([{ lines: [VIETNAMESE_SAMPLE, "second line"] }, { lines: ["rotated"], rotate: 90 }]), (await annotatedFormPdf()).bytes];
  for (const [index, bytes] of sources.entries()) {
    const doc = await load(bytes);
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
      if (!A.isStream(object)) continue;
      const type = A.getName(object.dict, "Type");
      const subtype = A.getName(object.dict, "Subtype");
      const isPageContent = doc.getPages().some((p) => {
        const contents = p.node.get(pdfLib.PDFName.of("Contents"));
        return contents === ref || (A.isArray(doc.context.lookup(contents)) && doc.context.lookup(contents).asArray().includes(ref));
      });
      if (isPageContent || (type === "XObject" && subtype === "Form")) check(A.streamBytes(object), `source ${index} object ${ref.objectNumber}`);
    }
  }
  assert.ok(streams >= 8 && operations > 150, `${streams} streams, ${operations} operations`);
});
