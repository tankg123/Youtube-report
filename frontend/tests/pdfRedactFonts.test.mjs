// Glyph advances from font dictionaries (engine/redact/fonts.js) and the standard font data it relies on.
import test from "node:test";
import assert from "node:assert/strict";
import { FontDecodeError, loadFont, parseCMap } from "../src/pages/pdfEditor/engine/redact/fonts.js";
import { ENCODINGS, STANDARD_FONT_ALIASES, standardWidths } from "../src/pages/pdfEditor/engine/redact/stdFontData.js";
import { VIETNAMESE_SAMPLE, makeTextPdf, pdfLib } from "./helpers/pdfTestKit.mjs";
import { A, bytesOf, load, pageContent, snap } from "./helpers/pdfRedactKit.mjs";

const { PDFDocument, StandardFontEmbedder } = pdfLib;
const ctx = (await PDFDocument.create({ updateMetadata: false })).context;
const font = (literal) => loadFont(ctx.obj(literal));
const codes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const widths = (info, bytes) => info.decode(bytes).map((g) => Math.round(g.w0 * 1000));

test("standard font metrics taken from pdf.js agree with the AFM data bundled with the PDF library", () => {
  const names = ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique", "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
    "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats"];
  let compared = 0;
  for (const name of names) {
    const embedder = StandardFontEmbedder.for(name);
    const table = standardWidths(name);
    for (const cp of embedder.encoding.supportedCodePoints) {
      const { name: glyph } = embedder.encoding.encodeUnicodeCodePoint(cp);
      const afm = embedder.font.getWidthOfGlyph(glyph);
      const ours = typeof table === "number" ? table : table[glyph];
      if (afm === undefined) continue;
      assert.equal(ours, afm, `${name} /${glyph}`);
      compared++;
    }
  }
  assert.ok(compared > 2500, `only ${compared} widths compared`);
  assert.equal(ENCODINGS.WinAnsiEncoding[0x80], "Euro");
  assert.equal(ENCODINGS.StandardEncoding[0x27], "quoteright");
  assert.equal(ENCODINGS.MacRomanEncoding[0x80], "Adieresis");
  assert.equal(STANDARD_FONT_ALIASES.ArialMT, "Helvetica");
});

test("simple font with /Widths, /FirstChar and /MissingWidth", () => {
  const f = font({ Type: "Font", Subtype: "TrueType", BaseFont: "ABCDEF+Some", FirstChar: 65, LastChar: 67, Widths: [600, 700, 800], FontDescriptor: { Type: "FontDescriptor", MissingWidth: 250, Ascent: 900, Descent: -250 } });
  assert.equal(f.measurable, true);
  assert.deepEqual(widths(f, codes("@ABCD ")), [250, 600, 700, 800, 250, 250]);
  assert.equal(f.ascent, 0.9);
  assert.equal(f.descent, -0.25);
  assert.deepEqual(f.decode(codes("A B")).map((g) => g.space), [false, true, false]);
});

test("standard font without /Widths: metrics through the base encoding and /Differences", () => {
  const win = font({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
  assert.deepEqual(widths(win, codes("Ai \x80\x27")), [667, 222, 278, 556, 191]); // 0x80 = Euro, 0x27 = quotesingle
  const std = font({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
  assert.deepEqual(widths(std, codes("\x27")), [222]); // StandardEncoding: 0x27 = quoteright
  const diff = font({ Type: "Font", Subtype: "Type1", BaseFont: "Times-Roman", Encoding: { Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: [65, "W", "period", 200, "A"] } });
  assert.deepEqual(widths(diff, codes("ABC\xc8")), [944, 250, 667, 722]); // A -> W, B -> period, 200 -> A
  const courier = font({ Type: "Font", Subtype: "Type1", BaseFont: "Courier-Bold" });
  assert.deepEqual(widths(courier, codes("iW\x01")), [600, 600, 600]);
  const symbol = font({ Type: "Font", Subtype: "Type1", BaseFont: "Symbol" });
  assert.deepEqual(widths(symbol, codes("a")), [631]); // alpha
  const alias = font({ Type: "Font", Subtype: "TrueType", BaseFont: "Arial,Bold", Encoding: "WinAnsiEncoding" });
  assert.deepEqual(widths(alias, codes("A")), [722]); // Helvetica-Bold
  const unknown = font({ Type: "Font", Subtype: "TrueType", BaseFont: "Verdana" });
  assert.equal(unknown.measurable, false);
  assert.match(unknown.reason, /no \/Widths/);
});

test("Type3: /Widths are scaled by the font matrix, the box comes from /FontBBox", () => {
  const f = font({ Type: "Font", Subtype: "Type3", FontMatrix: [0.01, 0, 0, 0.01, 0, 0], FontBBox: [0, -20, 90, 70], FirstChar: 97, LastChar: 98, Widths: [50, 60], CharProcs: {}, Encoding: { Type: "Encoding", Differences: [97, "a", "b"] } });
  assert.equal(f.kind, "type3");
  assert.deepEqual(widths(f, codes("abc")), [500, 600, 0]);
  assert.ok(Math.abs(f.ascent - 0.7) < 1e-9 && Math.abs(f.descent + 0.2) < 1e-9);
  assert.equal(font({ Type: "Font", Subtype: "Type3", Widths: [1] }).measurable, false);
});

test("Type0 with Identity-H: two-byte codes, /W in both forms, /DW", () => {
  const f = font({ Type: "Font", Subtype: "Type0", BaseFont: "X", Encoding: "Identity-H", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType2", DW: 900, W: [1, [100, 200, 300], 10, 12, 500], FontDescriptor: { Type: "FontDescriptor", Ascent: 905, Descent: -212 } }] });
  assert.equal(f.measurable, true);
  assert.equal(f.vertical, false);
  const g = f.decode(Uint8Array.of(0, 1, 0, 3, 0, 11, 0, 32, 1, 0));
  assert.deepEqual(g.map((x) => [x.start, x.length, x.cid, Math.round(x.w0 * 1000), x.space]), [[0, 2, 1, 100, false], [2, 2, 3, 300, false], [4, 2, 11, 500, false], [6, 2, 32, 900, false], [8, 2, 256, 900, false]]);
  assert.throws(() => f.decode(Uint8Array.of(0, 1, 0)), FontDecodeError); // an odd number of bytes
  assert.equal(f.ascent, 0.905);
});

test("Type0 with Identity-V: vertical metrics from /DW2 and /W2", () => {
  const f = font({ Type: "Font", Subtype: "Type0", BaseFont: "V", Encoding: "Identity-V", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType0", DW: 1000, W: [5, [500]], DW2: [800, -900], W2: [7, [-500, 250, 700], 8, 9, -600, 300, 750] }] });
  assert.equal(f.vertical, true);
  const g = f.decode(Uint8Array.of(0, 5, 0, 6, 0, 7, 0, 9));
  const r = (v) => Math.round(v * 1000);
  assert.deepEqual(g.map((x) => [r(x.w0), r(x.w1), r(x.vx), r(x.vy)]), [[500, -900, 250, 800], [1000, -900, 500, 800], [1000, -500, 250, 700], [1000, -600, 300, 750]]);
});

test("embedded CMap: codespace ranges of mixed length, cidrange, cidchar, WMode", () => {
  const program = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (Test) /Supplement 0 >> def /CMapName /Test-H def /CMapType 1 def",
    "2 begincodespacerange <00> <80> <8140> <9FFC> endcodespacerange",
    "2 begincidrange <20> <7E> 1 <8140> <817E> 633 endcidrange",
    "1 begincidchar <8180> 9000 endcidchar",
    "endcmap CMapName currentdict /CMap defineresource pop end end"
  ].join("\n");
  const cmap = parseCMap(bytesOf(program));
  assert.equal(cmap.codespaces.length, 2);
  assert.equal(cmap.cidRanges.length, 2);
  assert.equal(cmap.cidChars.get("2:33152"), 9000);
  const stream = ctx.stream(bytesOf(program), { Type: "CMap", CMapName: "Test-H" });
  const f = loadFont(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "M", Encoding: stream, DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType0", DW: 1000, W: [1, 95, 500, 9000, [750]] }] }));
  assert.equal(f.measurable, true);
  // "A " (one byte each), then two 2-byte codes
  const g = f.decode(Uint8Array.of(0x41, 0x20, 0x81, 0x41, 0x81, 0x80));
  assert.deepEqual(g.map((x) => [x.length, x.cid, Math.round(x.w0 * 1000), x.space]), [[1, 34, 500, false], [1, 1, 500, true], [2, 634, 1000, false], [2, 9000, 750, false]]);
  assert.throws(() => f.decode(Uint8Array.of(0xff)), FontDecodeError); // outside every codespace range
  const vertical = ctx.stream(bytesOf(program.replace("/CMapType 1 def", "/CMapType 1 def /WMode 1 def")), { Type: "CMap" });
  assert.equal(loadFont(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "M", Encoding: vertical, DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType0" }] })).vertical, true);
});

test("predefined CMaps: two-byte ones are measurable only without /W; others are not measurable at all", () => {
  const noW = font({ Type: "Font", Subtype: "Type0", BaseFont: "STSong", Encoding: "UniGB-UCS2-H", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType0", DW: 1000 }] });
  assert.equal(noW.measurable, true);
  assert.deepEqual(widths(noW, Uint8Array.of(0x4e, 0x2d, 0x65, 0x87)), [1000, 1000]);
  const withW = font({ Type: "Font", Subtype: "Type0", BaseFont: "STSong", Encoding: "UniGB-UCS2-H", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType0", DW: 1000, W: [1, 95, 500] }] });
  assert.equal(withW.measurable, false);
  assert.equal(withW.codeLengths, true);
  assert.match(withW.reason, /CIDs unknown/);
  const sjis = font({ Type: "Font", Subtype: "Type0", BaseFont: "MS-Gothic", Encoding: "90ms-RKSJ-H", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType2", DW: 1000 }] });
  assert.equal(sjis.measurable, false);
  assert.equal(sjis.codeLengths, false);
  assert.throws(() => sjis.decode(Uint8Array.of(0x82, 0xa0)), FontDecodeError);
  assert.equal(font({ Type: "Font", Subtype: "Type0", BaseFont: "V", Encoding: "UniJIS-UCS2-V", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType0" }] }).vertical, true);
});

test("unsupported dictionaries never throw: they are reported as not measurable", () => {
  assert.equal(loadFont(undefined).measurable, false);
  assert.equal(font({ Type: "Font", Subtype: "OpenType" }).measurable, false);
  assert.equal(font({ Type: "Font", Subtype: "Type0", BaseFont: "X", Encoding: "Identity-H" }).measurable, false);
  assert.equal(font({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: { Differences: [1, [2]] } }).measurable, false);
});

test("a subset font embedded by the PDF library: the advances of the dictionary equal those pdf.js draws with", async () => {
  // the font of every text box the editor writes (and of makeTextPdf): Type0 / Identity-H with /W
  const bytes = await makeTextPdf([{ lines: [VIETNAMESE_SAMPLE] }], { useObjectStreams: false });
  const doc = await load(bytes);
  const fonts = A.get(A.get(doc.getPage(0).node, "Resources"), "Font");
  const info = loadFont(fonts.lookup(fonts.keys()[0]));
  assert.equal(info.kind, "type0");
  assert.equal(info.measurable, true);
  const snapshot = await snap(bytes);
  const size = snapshot.glyphs[0].size;
  // glyph ids of the line, in content order, from the hex string of the page content
  const hex = /<([0-9A-Fa-f]+)>/.exec(pageContent(doc))[1];
  const glyphs = info.decode(Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16)));
  assert.equal(glyphs.length, snapshot.glyphs.length);
  for (const [index, glyph] of glyphs.entries()) {
    const drawn = snapshot.glyphs[index].quad[2] - snapshot.glyphs[index].quad[0];
    assert.ok(Math.abs(glyph.w0 * size - drawn) < 0.005, `glyph ${index}: ${glyph.w0 * size} against ${drawn}`);
  }
});
