// What the FONTS of an output still hold of removed text (review defect 1: "the font spells the secret").
// Every test builds a document with a subset font, removes a line with redactPdf() and then reads the fonts of
// the output with the decoders of the test kit (which share no code with the engine):
//   - a font nothing shows any more is not in the file;
//   - a font other text still uses has lost the ToUnicode mappings, the widths and the outlines of the
//     characters only the removed text used, in every kind of font the engine edits (TrueType and CFF in a
//     Type0 font as pdf-lib / fontkit write them, hand-built simple TrueType and CFF fonts, Type3);
//   - everything else is exactly what it was: the text that stays is extracted as before and every pixel
//     outside the mark, on the marked page and on the pages without marks, is the same;
//   - where the engine is not certain it changes NOTHING and says so (REDACT_FONT_GLYPHS_REMAIN,
//     report.fontsNotCleaned), and env.rasterPages frees such a font.
import test from "node:test";
import assert from "node:assert/strict";
import { canRender, extractText, fontBytes, fontkit, pdfLib, squash } from "./helpers/pdfTestKit.mjs";
import { boxOf, bytesOf, found, makePdf, redactEnv } from "./helpers/pdfRedactKit.mjs";
import {
  cffGlyphs, fontsOf, glyphNameOf, inkPixels, makeOtfFont, pagePixels, pixelDifference, readCmapTable, readSfnt, simpleCffPdf, simpleTrueTypePdf, trueTypeOutlines,
  type1Pdf, type3Pdf
} from "./helpers/pdfRedactFontKit.mjs";
import { redactPdf } from "../src/pages/pdfEditor/engine/redact/index.js";

/** fontCleanup.js, loaded where a test calls it directly (the tests through redactPdf() need only the engine). */
const fontCleanup = () => import("../src/pages/pdfEditor/engine/redact/fontCleanup.js");

const { PDFDocument, PDFName, PDFString, PDFNumber, PDFArray, PDFDict, StandardFonts } = pdfLib;
const needCanvas = { skip: !canRender && "no canvas binary on this platform" };

const PAGE_ONE = ["Customer record of the branch office", "Account 0947-315-268 Zurich", "the contract runs for two years"];
const PAGE_TWO = ["second page of the same font", "nothing here is marked"];
const SECRET = "0947-315-268";
/** The characters of `secret` that no other text of `pages` uses. */
const onlyIn = (secret, pages) => {
  const rest = pages.flat().join("\n").replace(secret, "");
  return [...new Set(secret)].filter((ch) => !rest.includes(ch));
};
const SECRET_ONLY = onlyIn(SECRET, [PAGE_ONE, PAGE_TWO]);
const KEPT = [...new Set([...PAGE_ONE, ...PAGE_TWO].join("").replace(SECRET, ""))];
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** A document set in a font embedded by pdf-lib (a Type0 font with a subset made by fontkit). */
async function embeddedPdf({ fontData, subset = true, pages = [PAGE_ONE, PAGE_TWO], touch }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontData, { subset });
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, index) => page.drawText(line, { x: 60, y: 720 - index * 24, size: 14, font }));
  }
  if (touch) await touch(doc, font);
  return doc.save({ useObjectStreams: false });
}

/** Redacts `secret` on the first page; returns { bytes, report, rect }. */
async function redactLine(input, { secret = SECRET, mode = "redact", ...options } = {}) {
  const rect = await boxOf(input, secret, { pad: 1 });
  const { bytes, report } = await redactPdf(input, [{ pageIndex: 0, rect, mode }], redactEnv(options));
  return { bytes, report, rect };
}

/** The text that stays is extracted as before, and no pixel away from the mark changed (on any page). */
async function assertRestUntouched(input, output, rect, secret = SECRET) {
  const before = await extractText(input);
  const after = await extractText(output);
  assert.equal(after.length, before.length);
  assert.equal(squash(after[0]), squash(before[0]).replace(squash(secret), ""), "the text of the marked page");
  for (let p = 1; p < before.length; p++) assert.equal(after[p], before[p], `the text of page ${p + 1}`);
  const first = await pagePixels(input, 0);
  assert.ok(inkPixels(first) > 500, "fixture: the page shows ink");
  assert.equal(pixelDifference(first, await pagePixels(output, 0), [rect]), 0, "pixels of the marked page outside the mark");
  for (let p = 1; p < before.length; p++) assert.equal(pixelDifference(await pagePixels(input, p), await pagePixels(output, p)), 0, `pixels of page ${p + 1}`);
}

const fontNamed = (fonts, part) => fonts.find((entry) => entry.name.includes(part));
/** The font of the hand-built fixtures (makePdf also registers the standard fonts, which no page of them uses). */
const theFont = (fonts) => fonts.find((entry) => /HandBuilt|RedactBoxes|RedactType/.test(entry.name));
const codeOfText = (font) => new Map([...font.toUnicode].map(([code, text]) => [text, code]));
const noWarning = (report) => assert.deepEqual(report.warnings.filter((warning) => warning.code === "REDACT_FONT_GLYPHS_REMAIN"), []);
/** The bytes of the glyph records of a TrueType program, by glyph number. */
function glyphRecords(program) {
  const { tables } = readSfnt(program);
  const long = u16(tables.get("head"), 50) === 1;
  const loca = tables.get("loca");
  const at = (i) => (long ? u32(loca, i * 4) : u16(loca, i * 2) * 2);
  return (glyph) => tables.get("glyf").subarray(at(glyph), at(glyph + 1));
}

// ---------------------------------------------------------------------------------------------------------
// a font nothing shows any more

test("a font that only the removed text used leaves the file", needCanvas, async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const body = await doc.embedFont(fontBytes("arimo-regular"), { subset: true });
  const own = await doc.embedFont(fontBytes("tinos-regular"), { subset: true });
  const page = doc.addPage([612, 792]);
  page.drawText("Customer record of the branch", { x: 60, y: 720, size: 14, font: body });
  page.drawText(SECRET, { x: 60, y: 690, size: 14, font: own });
  const input = await doc.save({ useObjectStreams: false });
  assert.ok(fontNamed(await fontsOf(input), "Tinos"), "fixture: the secret has a font of its own");
  for (const mode of ["redact", "pixelate", "erase"]) {
    const { bytes, report, rect } = await redactLine(input, { mode });
    assert.equal(report.pages[0].path, "precise");
    const fonts = await fontsOf(bytes);
    assert.equal(fontNamed(fonts, "Tinos"), undefined, `${mode}: the font of the removed text is still in the file`);
    assert.equal(found(bytes, "Tinos-Regular"), false, `${mode}: its name is still in the bytes`);
    // the other font is what it was
    assert.equal(hex(fontNamed(fonts, "Arimo").program), hex(fontNamed(await fontsOf(input), "Arimo").program));
    noWarning(report);
    assert.deepEqual(report.fontsNotCleaned, []);
    await assertRestUntouched(input, bytes, rect);
  }
});

// ---------------------------------------------------------------------------------------------------------
// a subset other text still uses: the fonts pdf-lib writes

test("a shared TrueType subset (pdf-lib, fontkit) loses the mappings, widths and outlines only the removed text used", needCanvas, async () => {
  const input = await embeddedPdf({ fontData: fontBytes("arimo-regular") });
  const was = fontNamed(await fontsOf(input), "Arimo");
  assert.deepEqual([was.subtype, was.programKind], ["Type0", "truetype"]);
  const codes = codeOfText(was);
  const wasOutlines = trueTypeOutlines(was.program).outlines;
  for (const ch of SECRET_ONLY) assert.ok(codes.has(ch) && was.widths.has(codes.get(ch)) && wasOutlines.has(codes.get(ch)), `fixture: the font holds "${ch}"`);
  assert.equal(SECRET_ONLY.length, 11);

  const { bytes, report, rect } = await redactLine(input);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual(report.fontsCleaned, [{ font: was.name, codes: 11, widths: 11, glyphs: 11 }]);
  assert.deepEqual(report.fontsNotCleaned, []);
  noWarning(report);
  const now = fontNamed(await fontsOf(bytes), "Arimo");
  const outlines = trueTypeOutlines(now.program);
  const record = glyphRecords(was.program);
  for (const ch of SECRET_ONLY) {
    const code = codes.get(ch); // the code is the glyph number (Identity-H, /CIDToGIDMap /Identity)
    assert.equal(now.toUnicode.has(code), false, `ToUnicode still maps the code of "${ch}"`);
    assert.equal([...now.toUnicode.values()].includes(ch), false, `ToUnicode still names "${ch}"`);
    assert.equal(now.widths.has(code), false, `/W still holds the width of "${ch}"`);
    assert.equal(outlines.outlines.has(code), false, `the outline of "${ch}" is still in the font program`);
    assert.ok(record(code).length >= 20 && !hex(now.program).includes(hex(record(code))), `the glyph record of "${ch}" is still somewhere in the program`);
  }
  // nothing else changed: same glyph numbers, same mappings, widths and outlines for every character that stays
  assert.equal(outlines.numGlyphs, trueTypeOutlines(was.program).numGlyphs);
  const records = glyphRecords(now.program);
  for (const ch of KEPT) {
    const code = codes.get(ch);
    assert.equal(now.toUnicode.get(code), ch);
    assert.equal(now.widths.get(code), was.widths.get(code), `width of "${ch}"`);
    assert.equal(hex(records(code)), hex(record(code)), `outline of "${ch}"`);
  }
  assert.equal(now.toUnicode.size, was.toUnicode.size - 11);
  assert.ok(fontkit.create(Buffer.from(now.program)).numGlyphs === outlines.numGlyphs, "fontkit reads the program");
  await assertRestUntouched(input, bytes, rect);
  // the engine's own account agrees: nothing unused is left in the font
  const { fontInventory } = await fontCleanup();
  const [entry] = fontInventory(await PDFDocument.load(bytes)).filter((item) => item.font === was.name);
  assert.equal(entry.program.unusedOutlined, 0);
  assert.equal(entry.toUnicode.unused, 0);
});

test("accented letters: a glyph the kept text is composed of stays, pixel for pixel", needCanvas, async () => {
  const pages = [["Khách hàng của chi nhánh", "Tên: Nguyễn Thị Hương Zurich", "hợp đồng có thời hạn hai năm"], ["trang thứ hai", "không có gì ở đây"]];
  const secret = "Nguyễn Thị Hương";
  const only = onlyIn(secret, pages);
  assert.deepEqual(only, ["N", "ễ", "ị", "H", "ư", "ơ"]);
  const input = await embeddedPdf({ fontData: fontBytes("arimo-regular"), pages });
  const was = fontNamed(await fontsOf(input), "Arimo");
  const codes = codeOfText(was);
  const { bytes, report, rect } = await redactLine(input, { secret });
  assert.equal(report.pages[0].path, "precise");
  const now = fontNamed(await fontsOf(bytes), "Arimo");
  for (const ch of only) {
    assert.equal(now.toUnicode.has(codes.get(ch)), false, `ToUnicode still maps "${ch}"`);
    assert.equal(now.widths.has(codes.get(ch)), false, `/W still holds "${ch}"`);
  }
  const outlines = trueTypeOutlines(now.program).outlines;
  for (const ch of ["N", "H", "ễ", "ị"]) assert.equal(outlines.has(codes.get(ch)), false, `the outline of "${ch}" is still in the font program`);
  // "ư" and "ơ" are no characters of the document any more, but "ứ", "ợ", "ờ", "ở" are drawn with their
  // outlines: taking them out would change the kept text. The pixels are the proof that nothing did
  assert.equal(report.fontsCleaned.length, 1);
  assert.ok(report.fontsCleaned[0].glyphs >= 4 && report.fontsCleaned[0].codes === 6, JSON.stringify(report.fontsCleaned));
  await assertRestUntouched(input, bytes, rect, secret);
});

test("a shared CFF subset (pdf-lib, CID-keyed) loses the glyphs together with their CIDs", needCanvas, async () => {
  const chars = [...new Set([...PAGE_ONE, ...PAGE_TWO].join(""))].join("");
  const input = await embeddedPdf({ fontData: makeOtfFont({ chars }) });
  const was = fontNamed(await fontsOf(input), "RedactBoxes");
  assert.deepEqual([was.subtype, was.programKind], ["Type0", "cff"]);
  const codes = codeOfText(was);
  const before = cffGlyphs(was.program);
  assert.equal(before.isCID, true);
  const { bytes, report, rect } = await redactLine(input);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual(report.fontsCleaned, [{ font: was.name, codes: 11, widths: 11, glyphs: 11 }]);
  noWarning(report);
  const now = fontNamed(await fontsOf(bytes), "RedactBoxes");
  const after = cffGlyphs(now.program);
  assert.equal(after.count, before.count - 11);
  for (const ch of SECRET_ONLY) {
    const cid = codes.get(ch);
    assert.equal(now.toUnicode.has(cid), false, `ToUnicode still maps "${ch}"`);
    assert.equal(now.widths.has(cid), false, `/W still holds "${ch}"`);
    assert.equal(after.charset.includes(cid), false, `the charset still lists the CID of "${ch}"`);
    const glyph = before.charset.indexOf(cid);
    if (before.charStrings[glyph].length > 8) assert.ok(!hex(now.program).includes(hex(before.charStrings[glyph])), `the charstring of "${ch}" is still in the program`);
  }
  for (const ch of KEPT) {
    const cid = codes.get(ch);
    assert.equal(now.toUnicode.get(cid), ch);
    assert.equal(now.widths.get(cid), was.widths.get(cid));
    assert.equal(hex(after.charStrings[after.charset.indexOf(cid)]), hex(before.charStrings[before.charset.indexOf(cid)]), `charstring of "${ch}"`);
  }
  await assertRestUntouched(input, bytes, rect);
});

// ---------------------------------------------------------------------------------------------------------
// simple fonts, built by hand the way other producers write them

for (const [label, options] of [["symbolic, cmap format 0, ToUnicode", { style: "symbolic" }], ["symbolic, cmap format 6, ToUnicode", { style: "symbolic", cmap: 6 }], ["WinAnsiEncoding, Unicode cmap format 4", { style: "winansi" }]]) {
  test(`a shared simple TrueType font (${label}) loses what only the removed text used`, needCanvas, async () => {
    const made = await simpleTrueTypePdf({ pages: [PAGE_ONE, PAGE_TWO], ...options });
    const was = theFont(await fontsOf(made.bytes));
    assert.deepEqual([was.subtype, was.programKind], ["TrueType", "truetype"]);
    const { bytes, report, rect } = await redactLine(made.bytes);
    assert.equal(report.pages[0].path, "precise");
    assert.deepEqual(report.fontsCleaned, [{ font: made.fontName, codes: options.style === "symbolic" ? 11 : 0, widths: 11, glyphs: 11 }]);
    noWarning(report);
    const now = theFont(await fontsOf(bytes));
    const outlines = trueTypeOutlines(now.program);
    const cmap = readCmapTable(outlines.tables.get("cmap"));
    const wasCmap = readCmapTable(readSfnt(was.program).tables.get("cmap"));
    assert.deepEqual(cmap.map((sub) => [sub.platform, sub.encoding, sub.format]), wasCmap.map((sub) => [sub.platform, sub.encoding, sub.format]));
    const record = glyphRecords(was.program);
    for (const ch of SECRET_ONLY) {
      const code = made.codeOf.get(ch);
      const glyph = made.glyphOf.get(ch);
      if (was.toUnicode) assert.equal(now.toUnicode.has(code), false, `ToUnicode still maps "${ch}"`);
      assert.equal(now.widths.get(code), 0, `/Widths still holds the width of "${ch}"`);
      assert.ok(was.widths.get(code) > 0, "fixture: the width was there");
      assert.equal(outlines.outlines.has(glyph), false, `the outline of "${ch}" is still in the font program`);
      assert.ok(!hex(now.program).includes(hex(record(glyph))), `the glyph record of "${ch}" is still in the program`);
      for (const sub of cmap) assert.equal(sub.map.has(code), false, `the cmap still leads from the code of "${ch}" to a glyph`);
      assert.ok(wasCmap.every((sub) => sub.map.get(code) === glyph), "fixture: the cmap led to the glyph");
    }
    const records = glyphRecords(now.program);
    for (const ch of KEPT) {
      const code = made.codeOf.get(ch);
      if (was.toUnicode) assert.equal(now.toUnicode.get(code), ch);
      assert.equal(now.widths.get(code), was.widths.get(code));
      assert.equal(hex(records(made.glyphOf.get(ch))), hex(record(made.glyphOf.get(ch))), `outline of "${ch}"`);
      for (const sub of cmap) assert.equal(sub.map.get(code), made.glyphOf.get(ch), `cmap of "${ch}"`);
    }
    await assertRestUntouched(made.bytes, bytes, rect);
  });
}

test("a /Widths array written for the whole encoding keeps its entries: emptying some would mark them", needCanvas, async () => {
  const made = await simpleTrueTypePdf({ pages: [PAGE_ONE, PAGE_TWO], style: "winansi" });
  // as a producer that copies the widths of the whole font: every code of the range has one
  const doc = await PDFDocument.load(made.bytes, { updateMetadata: false });
  const fontDict = doc.getPage(0).node.Resources().lookup(PDFName.of("Font"), PDFDict).lookup(PDFName.of("TF"), PDFDict);
  const widths = fontDict.lookup(PDFName.of("Widths"), PDFArray);
  for (let i = 0; i < widths.size(); i++) if (widths.lookup(i, PDFNumber).asNumber() === 0) widths.set(i, PDFNumber.of(500));
  const input = await doc.save({ useObjectStreams: false });
  const was = theFont(await fontsOf(input));
  const { bytes, report, rect } = await redactLine(input);
  assert.deepEqual(report.fontsCleaned, [{ font: made.fontName, codes: 0, widths: 0, glyphs: 11 }]);
  const now = theFont(await fontsOf(bytes));
  assert.deepEqual([...now.widths], [...was.widths], "the widths are what they were");
  const outlines = trueTypeOutlines(now.program).outlines;
  for (const ch of SECRET_ONLY) assert.equal(outlines.has(made.glyphOf.get(ch)), false, `the outline of "${ch}" is still in the font program`);
  await assertRestUntouched(input, bytes, rect);
});

test("a shared simple CFF font (name-keyed) loses the glyphs, their names and the subroutines only they called", needCanvas, async () => {
  const made = await simpleCffPdf({ pages: [PAGE_ONE, PAGE_TWO] });
  const was = theFont(await fontsOf(made.bytes));
  assert.deepEqual([was.subtype, was.programKind], ["Type1", "cff"]);
  const before = cffGlyphs(was.program);
  const { bytes, report, rect } = await redactLine(made.bytes);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual(report.fontsCleaned, [{ font: made.fontName, codes: 0, widths: 11, glyphs: 11 }]);
  noWarning(report);
  const now = theFont(await fontsOf(bytes));
  const after = cffGlyphs(now.program);
  assert.equal(after.count, before.count - 11);
  const sidOf = (ch) => before.charset[made.chars.indexOf(ch) + 1];
  for (const ch of SECRET_ONLY) {
    assert.equal(now.widths.get(ch.charCodeAt(0)), 0, `/Widths still holds the width of "${ch}"`);
    assert.equal(after.charset.includes(sidOf(ch)), false, `the charset still names "${glyphNameOf(ch)}"`);
    assert.equal(after.encoding.has(ch.charCodeAt(0)), false, `the built-in encoding still has the code of "${ch}"`);
  }
  for (const ch of KEPT) {
    assert.equal(now.widths.get(ch.charCodeAt(0)), was.widths.get(ch.charCodeAt(0)));
    assert.equal(hex(after.charStrings[after.charset.indexOf(sidOf(ch))]), hex(before.charStrings[made.chars.indexOf(ch) + 1]), `charstring of "${ch}"`);
  }
  // a subroutine is a part of an outline: those of the removed glyphs are a bare "return" now
  const blank = (list) => list.filter((subr) => subr.length <= 1).length;
  assert.equal(blank(before.gsubrs) + blank(before.lsubrs), 0);
  assert.ok(blank(after.gsubrs) + blank(after.lsubrs) >= 4, "subroutines of removed glyphs were emptied");
  await assertRestUntouched(made.bytes, bytes, rect);
});

test("a shared Type3 font loses the glyph procedures, and the picture a removed glyph painted", needCanvas, async () => {
  const made = await type3Pdf({ pages: [PAGE_ONE, PAGE_TWO], pictures: "9" });
  const was = theFont(await fontsOf(made.bytes));
  assert.equal(was.subtype, "Type3");
  const images = async (bytes) => (await PDFDocument.load(bytes)).context.enumerateIndirectObjects().filter(([, object]) => object.dict?.get(PDFName.of("Subtype")) === PDFName.of("Image")).length;
  assert.equal(await images(made.bytes), 1, "fixture: the glyph of 9 paints a picture");
  const { bytes, report, rect } = await redactLine(made.bytes);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual(report.fontsCleaned, [{ font: "RedactType3", codes: 11, widths: 11, glyphs: 11 }]);
  noWarning(report);
  const now = theFont(await fontsOf(bytes));
  for (const ch of SECRET_ONLY) {
    const code = ch.charCodeAt(0);
    assert.equal(now.charProcs.includes(`g${code}`), false, `the glyph procedure of "${ch}" is still in the font`);
    assert.equal(now.differences.has(code), false, `/Differences still names the glyph of "${ch}"`);
    assert.equal(now.toUnicode.has(code), false, `ToUnicode still maps "${ch}"`);
    assert.equal(now.widths.get(code), 0, `/Widths still holds the width of "${ch}"`);
  }
  for (const ch of KEPT) {
    const code = ch.charCodeAt(0);
    assert.ok(now.charProcs.includes(`g${code}`) && now.differences.get(code) === `g${code}` && now.toUnicode.get(code) === ch && now.widths.get(code) === was.widths.get(code), `"${ch}" changed`);
  }
  assert.equal(await images(bytes), 0, "the picture of the removed glyph is still in the file");
  await assertRestUntouched(made.bytes, bytes, rect);
});

// ---------------------------------------------------------------------------------------------------------
// "used by anything in the whole document"

test("a character that a form or an annotation of another page still shows stays in the font", needCanvas, async () => {
  const made = await simpleTrueTypePdf({ pages: [PAGE_ONE, PAGE_TWO], style: "symbolic" });
  const doc = await PDFDocument.load(made.bytes, { updateMetadata: false });
  const ctx = doc.context;
  const page = doc.getPage(1);
  const fontRef = page.node.Resources().lookup(PDFName.of("Font"), PDFDict).get(PDFName.of("TF"));
  const show = (text) => `BT /TF 12 Tf 0 4 Td <${[...text].map((ch) => made.codeOf.get(ch).toString(16).padStart(2, "0")).join("")}> Tj ET`;
  const form = (text) => ctx.register(ctx.stream(bytesOf(show(text)), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 20], Resources: { Font: { TF: fontRef } } }));
  page.node.Resources().set(PDFName.of("XObject"), ctx.obj({ Fm1: form("947") }));
  page.node.set(PDFName.of("Contents"), ctx.obj([page.node.get(PDFName.of("Contents")), ctx.register(ctx.stream(bytesOf("q 1 0 0 1 60 500 cm /Fm1 Do Q")))]));
  page.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [60, 400, 260, 420], F: 4, AP: { N: form("03") } }))]));
  const input = await doc.save({ useObjectStreams: false });
  assert.ok(squash((await extractText(input))[1]).includes("947"), "fixture: the form of page 2 shows digits");

  const { bytes, report, rect } = await redactLine(input);
  assert.equal(report.pages[0].path, "precise");
  const still = ["9", "4", "7", "0", "3"];
  const gone = SECRET_ONLY.filter((ch) => !still.includes(ch));
  assert.deepEqual(report.fontsCleaned, [{ font: made.fontName, codes: gone.length, widths: gone.length, glyphs: gone.length }]);
  const now = theFont(await fontsOf(bytes));
  const outlines = trueTypeOutlines(now.program).outlines;
  for (const ch of still) assert.ok(now.toUnicode.get(made.codeOf.get(ch)) === ch && now.widths.get(made.codeOf.get(ch)) > 0 && outlines.has(made.glyphOf.get(ch)), `"${ch}" is still shown on page 2 and must stay`);
  for (const ch of gone) assert.ok(!now.toUnicode.has(made.codeOf.get(ch)) && now.widths.get(made.codeOf.get(ch)) === 0 && !outlines.has(made.glyphOf.get(ch)), `"${ch}" is shown nowhere and must go`);
  await assertRestUntouched(input, bytes, rect);
  // usedBy() of the marked page: its own content and the annotation appearances of every page
  const { usedBy } = await fontCleanup();
  const loaded = await PDFDocument.load(input, { updateMetadata: false });
  const usage = [...usedBy(loaded, [0]).values()];
  assert.equal(usage.length, 1);
  const shown = new Set([...usage[0].codes.values()].map((item) => item.code));
  assert.deepEqual([...shown].sort((a, b) => a - b), [...new Set([...PAGE_ONE.join(""), "0", "3"])].map((ch) => made.codeOf.get(ch)).sort((a, b) => a - b));
  assert.equal(usage[0].unknown, false);
});

test("a page that becomes a picture frees everything only it showed", needCanvas, async () => {
  const input = await embeddedPdf({ fontData: fontBytes("arimo-regular") });
  const was = fontNamed(await fontsOf(input), "Arimo");
  const { bytes, report } = await redactLine(input, { path: "raster" });
  assert.equal(report.pages[0].path, "raster");
  const now = fontNamed(await fontsOf(bytes), "Arimo");
  // the font holds the characters of page 2 and nothing else (the text layer of the picture has its own font)
  assert.deepEqual([...now.toUnicode.values()].sort(), [...new Set(PAGE_TWO.join(""))].sort());
  // (one outline per character that draws, and the .notdef glyph)
  assert.equal(trueTypeOutlines(now.program).outlines.size, new Set(PAGE_TWO.join("").replace(/ /g, "")).size + 1);
  assert.ok(now.program.length < was.program.length);
  noWarning(report);
  assert.equal(pixelDifference(await pagePixels(input, 1), await pagePixels(bytes, 1)), 0);
  assert.equal((await extractText(bytes))[1], (await extractText(input))[1]);
});

// ---------------------------------------------------------------------------------------------------------
// where the engine is not certain: nothing is changed, and the report says so

test("a Type1 font cannot be edited: it is reported, and env.rasterPages frees it", needCanvas, async () => {
  const made = await type1Pdf({ pages: [PAGE_ONE, PAGE_TWO] });
  const was = theFont(await fontsOf(made.bytes));
  const { bytes, report } = await redactLine(made.bytes);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual(report.fontsCleaned, []);
  assert.deepEqual(report.fontsNotCleaned, [{ font: made.fontName, pageIndexes: [0, 1], reason: "type1" }]);
  assert.deepEqual(report.warnings, [{ code: "REDACT_FONT_GLYPHS_REMAIN", params: { font: made.fontName, pages: 2 } }]);
  const now = theFont(await fontsOf(bytes));
  assert.deepEqual([...now.widths], [...was.widths], "a font that is not cleaned is not touched at all");
  assert.equal(hex(now.program), hex(was.program));
  assert.ok(!(await extractText(bytes))[0].includes(SECRET));
  // the caller's way out: the pages that use the font become pictures, and the font leaves the file
  const freed = await redactLine(made.bytes, { rasterPages: report.fontsNotCleaned[0].pageIndexes });
  assert.deepEqual(freed.report.pages.map((page) => [page.pageIndex, page.path, page.reasons.map((reason) => reason.code)]), [[0, "raster", ["REDACT_RASTER_FORCED"]], [1, "raster", ["REDACT_RASTER_FORCED"]]]);
  assert.deepEqual([freed.report.fontsNotCleaned, freed.report.warnings.filter((warning) => warning.code === "REDACT_FONT_GLYPHS_REMAIN")], [[], []]);
  assert.equal((await fontsOf(freed.bytes)).some((entry) => entry.name === made.fontName), false);
  assert.equal(found(freed.bytes, "RedactType1"), false);
  assert.equal(squash((await extractText(freed.bytes))[1]), squash(PAGE_TWO.join("")), "the text layer of the picture");
  // env.rasterPages is checked
  for (const rasterPages of [[7], [-1], [0.5], "all", [0, "1"]]) {
    await assert.rejects(redactLine(made.bytes, { rasterPages }), (error) => error.code === "REDACT_ENV_INVALID" && error.params.missing === "rasterPages", JSON.stringify(rasterPages));
  }
});

test("pages converted on request: a font that leaves with them is not reported, and their own text is not removed text", needCanvas, async () => {
  // Two Type 1 fonts the engine cannot edit. Font A shows the secret (alone on page 1) and a line of page 2;
  // font B shows the rest of page 1 and a line of page 2 with letters page 1 does not use.
  const program = (name) => bytesOf(`%!PS-AdobeFont-1.0: ${name} 001.000\n/FontName /${name} def\ncurrentfile eexec\n${"0123456789abcdef".repeat(40)}\ncleartomark\n`);
  const type1 = (name) => (ctx) => {
    const file = ctx.register(ctx.stream(program(name), { Length1: 80, Length2: 640, Length3: 12 }));
    const descriptor = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: `REDACT+${name}`, Flags: 32, FontBBox: [0, -250, 1000, 900], ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80, FontFile: file }));
    return ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: `REDACT+${name}`, Encoding: "WinAnsiEncoding", FirstChar: 32, LastChar: 126, FontDescriptor: descriptor, Widths: Array.from({ length: 95 }, () => 520) }));
  };
  const show = (font, y, text) => `BT /${font} 14 Tf 60 ${y} Td <${[...text].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("")}> Tj ET`;
  const KEPT_ONE = "the contract runs for two years";
  const OTHER_A = "a heading in the first font";
  const OTHER_B = "QUIZ: jackdaws vex my big sphinx";
  const { bytes: input } = await makePdf(
    [
      { content: [show("TA", 720, SECRET), show("TB", 696, KEPT_ONE)].join("\n"), resources: (ctx, refs) => ({ Font: { TA: refs.fontA, TB: refs.fontB } }) },
      { content: [show("TA", 720, OTHER_A), show("TB", 696, OTHER_B)].join("\n"), resources: (ctx, refs) => ({ Font: { TA: refs.fontA, TB: refs.fontB } }) }
    ],
    { objects: { fontA: type1("RedactTypeA"), fontB: type1("RedactTypeB") } }
  );
  const names = async (bytes) => (await fontsOf(bytes)).map((entry) => entry.name).filter((name) => /RedactType/.test(name)).sort();
  assert.deepEqual(await names(input), ["REDACT+RedactTypeA", "REDACT+RedactTypeB"]);

  // the mark takes all that page 1 shows with font A: the font stays for page 2 and is reported for that page
  const first = await redactLine(input);
  assert.deepEqual(first.report.pages.map((page) => [page.pageIndex, page.path]), [[0, "precise"]]);
  assert.deepEqual(first.report.fontsNotCleaned, [{ font: "REDACT+RedactTypeA", pageIndexes: [1], reason: "type1" }]);

  // the caller's answer: page 2 becomes a picture. Font A leaves the file, so nothing is left to report about
  // it; font B still serves page 1, and the letters only page 2 showed with it were not under any mark
  const freed = await redactLine(input, { rasterPages: [1] });
  assert.deepEqual(freed.report.pages.map((page) => [page.pageIndex, page.path, page.reasons.map((entry) => entry.code)]), [[0, "precise", []], [1, "raster", ["REDACT_RASTER_FORCED"]]]);
  assert.deepEqual(await names(freed.bytes), ["REDACT+RedactTypeB"], "font A is gone, font B stays");
  assert.equal(found(freed.bytes, "RedactTypeA"), false);
  assert.deepEqual(freed.report.fontsNotCleaned, [], "a font that left the file, or a font no mark took anything from, is not reported");
  assert.deepEqual(freed.report.warnings.filter((warning) => warning.code === "REDACT_FONT_GLYPHS_REMAIN"), []);
  const texts = await extractText(freed.bytes);
  assert.equal(squash(texts[0]), squash(KEPT_ONE));
  assert.equal(squash(texts[1]), squash(OTHER_A + OTHER_B), "the text layer of the picture");
  assert.ok(!JSON.stringify(freed.report).includes(SECRET));

  // a page with a mark that becomes a picture still counts: what the mark took there is removed text
  const marked = await redactLine(input, { path: "raster" });
  assert.deepEqual(marked.report.pages.map((page) => [page.pageIndex, page.path]), [[0, "raster"]]);
  assert.deepEqual(marked.report.fontsNotCleaned.map((entry) => entry.font).sort(), ["REDACT+RedactTypeA", "REDACT+RedactTypeB"], "the fonts page 2 still uses hold what page 1 showed");
});

test("a font whose use cannot be told completely is left alone and reported", needCanvas, async () => {
  const cases = [
    // the form fields of the document may write with the font (/AcroForm /DR)
    ["form-font", [0, 1], (doc, font) => doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [], DR: { Font: { F9: font.ref } }, DA: PDFString.of("/F9 10 Tf 0 g") }))],
    // something that is no resource dictionary of drawn content points at the font
    ["referenced-elsewhere", [0, 1], (doc, font) => doc.catalog.set(PDFName.of("PieceInfo"), doc.context.obj({ App: { Private: { KeepFont: font.ref } } }))],
    // a page whose content this engine cannot read may show anything with it
    ["usage-unknown", [0, 1, 2], (doc, font) => {
      const page = doc.addPage([612, 792]);
      page.drawText("third page", { x: 60, y: 720, size: 14, font });
      page.node.Contents().push(doc.context.register(doc.context.stream(Buffer.from("BT /F1 12 Tf (unterminated"))));
    }]
  ];
  for (const [reason, pageIndexes, touch] of cases) {
    const input = await embeddedPdf({ fontData: fontBytes("arimo-regular"), touch });
    const was = fontNamed(await fontsOf(input), "Arimo");
    const { bytes, report, rect } = await redactLine(input);
    assert.equal(report.pages[0].path, "precise", reason);
    assert.deepEqual(report.fontsNotCleaned, [{ font: was.name, pageIndexes, reason }]);
    assert.deepEqual(report.warnings.filter((warning) => warning.code === "REDACT_FONT_GLYPHS_REMAIN"), [{ code: "REDACT_FONT_GLYPHS_REMAIN", params: { font: was.name, pages: pageIndexes.length } }]);
    const now = fontNamed(await fontsOf(bytes), "Arimo");
    assert.equal(hex(now.program), hex(was.program), `${reason}: the program was changed`);
    assert.deepEqual([[...now.toUnicode], [...now.widths]], [[...was.toUnicode], [...was.widths]], `${reason}: the font was changed`);
    assert.ok(!JSON.stringify(report).includes(SECRET));
    await assertRestUntouched(input, bytes, rect);
  }
  // env.fontCleanup: false: the caller does not want fonts edited; he is told what they hold
  const input = await embeddedPdf({ fontData: fontBytes("arimo-regular") });
  const was = fontNamed(await fontsOf(input), "Arimo");
  const off = await redactLine(input, { fontCleanup: false });
  assert.deepEqual(off.report.fontsNotCleaned, [{ font: was.name, pageIndexes: [0, 1], reason: "disabled" }]);
  assert.equal(hex(fontNamed(await fontsOf(off.bytes), "Arimo").program), hex(was.program));
  // an erased line is replaced text, not a secret, but its glyphs go all the same (the font is cleaned)
  const erased = await redactLine(input, { mode: "erase" });
  assert.equal(erased.report.fontsCleaned.length, 1);
});

test("a font embedded as a whole is left alone: an emptied glyph would mark the removed characters", needCanvas, async () => {
  const input = await embeddedPdf({ fontData: fontBytes("arimo-regular"), subset: false });
  const was = fontNamed(await fontsOf(input), "Arimo");
  assert.ok(trueTypeOutlines(was.program).outlines.size > 1000, "fixture: the whole font is embedded");
  const { bytes, report, rect } = await redactLine(input);
  assert.equal(report.pages[0].path, "precise");
  assert.deepEqual([report.fontsCleaned, report.fontsNotCleaned], [[], []]);
  noWarning(report);
  const now = fontNamed(await fontsOf(bytes), "Arimo");
  assert.equal(hex(now.program), hex(was.program));
  assert.deepEqual([...now.toUnicode], [...was.toUnicode]);
  await assertRestUntouched(input, bytes, rect);
});

// ---------------------------------------------------------------------------------------------------------
// cleanFonts() on its own

test("cleanFonts: nothing to compare with, nothing to do; the result holds names and numbers only", async () => {
  const { cleanFonts, usedBy } = await fontCleanup();
  const input = await embeddedPdf({ fontData: fontBytes("arimo-regular") });
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  assert.deepEqual(cleanFonts(doc, {}), { cleaned: [], notCleaned: [], released: 0 });
  assert.deepEqual(cleanFonts(doc, { before: new Map() }), { cleaned: [], notCleaned: [], released: 0 });
  // nothing was removed: what the pages showed before is what they show now
  const before = usedBy(doc, [0, 1]);
  assert.equal(before.size, 1);
  assert.deepEqual(cleanFonts(doc, { before }), { cleaned: [], notCleaned: [], released: 0 });
  // the second page goes (as when it becomes a picture): what only it showed is freed
  const result = cleanFonts(doc, { before, skipPages: new Set([1]) });
  const onlyPageTwo = onlyIn(PAGE_TWO.join(""), [PAGE_ONE]).filter((ch) => !PAGE_ONE.join("").includes(ch));
  assert.deepEqual(result, { cleaned: [{ font: fontNamed(await fontsOf(input), "Arimo").name, codes: onlyPageTwo.length, widths: onlyPageTwo.length, glyphs: onlyPageTwo.length }], notCleaned: [], released: 0 });
  // a standard font without a program, widths or map holds nothing: never reported
  const plain = await PDFDocument.create({ updateMetadata: false });
  const helvetica = await plain.embedFont(StandardFonts.Helvetica);
  plain.addPage([300, 200]).drawText("plain 123", { x: 20, y: 100, size: 12, font: helvetica });
  plain.addPage([300, 200]).drawText("plain", { x: 20, y: 100, size: 12, font: helvetica });
  const reloaded = await PDFDocument.load(await plain.save({ useObjectStreams: false }), { updateMetadata: false });
  assert.deepEqual(cleanFonts(reloaded, { before: usedBy(reloaded, [0]), skipPages: new Set([0]) }), { cleaned: [], notCleaned: [], released: 0 });
});
