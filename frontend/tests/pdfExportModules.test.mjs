// engine/export: the building blocks one by one. Pure maths (shapes, pictures), the content-stream tokenizer
// and decoders, graphics-state isolation, the sweep, the copier, outline and page labels, page geometry.
import test from "node:test";
import assert from "node:assert/strict";
import { viewportTransform } from "../src/pages/pdfEditor/engine/geometry.js";
import { listFieldNames } from "../src/pages/pdfEditor/engine/export/acroform.js";
import {
  decodeStreamBytes, describeFont, getPageContentBytes, getPageResources, isolatePageContent, ownResource, ownResourceCategory,
  pageContentRefs, setPageContentBytes
} from "../src/pages/pdfEditor/engine/export/content.js";
import { analyseBalance, serializeToken, tokenizeContent } from "../src/pages/pdfEditor/engine/export/contentTokens.js";
import { auditOutput, copyPagesSafe } from "../src/pages/pdfEditor/engine/export/copyPages.js";
import { buildXmp, readPageLabels, setDocumentId, writePageLabels } from "../src/pages/pdfEditor/engine/export/docSettings.js";
import { PageCanvas, fontMetrics, missingCharacters } from "../src/pages/pdfEditor/engine/export/draw.js";
import { collectGarbage, compactObjectNumbers, findOrphans } from "../src/pages/pdfEditor/engine/export/gc.js";
import { jpegOrientation, orientationMatrix, sniffImage } from "../src/pages/pdfEditor/engine/export/imageInfo.js";
import { escapeLiteral, mapOutline, readOutline, writeOutline } from "../src/pages/pdfEditor/engine/export/outline.js";
import { pageGeometry } from "../src/pages/pdfEditor/engine/export/pageGeometry.js";
import { createPainter } from "../src/pages/pdfEditor/engine/export/painter.js";
import { createResourcePruner, pruneSharedResources, usedResourceNames } from "../src/pages/pdfEditor/engine/export/pruneResources.js";
import {
  arrowHeadSize, dashPattern, ellipsePath, flipPath, lineParts, pathToSvg, quadCorners, rectPath, smoothPath, strokePointsLocal, underlineBar
} from "../src/pages/pdfEditor/engine/export/shapes.js";
import { parseToUnicode } from "../src/pages/pdfEditor/engine/export/tounicode.js";
import { canRender, extractText, fontBytes, fontkit, loadFont, makeTextPdf, pdfLib, withPdf } from "./helpers/pdfTestKit.mjs";
import { ascii85, asciiHex, flate, lzw, pngUpPredict, runLength, tiffPredict } from "./helpers/pdfExportFilters.mjs";
import {
  MARKERS, SAMPLE_JPEG, SAMPLE_PNG, buildGeometryFixture, buildGlobalResourcesFixture, buildLinkedFixture, makeTextObject, noiseBytes,
  rawPdfWithIndirectLength, withExifOrientation
} from "./helpers/pdfExportFixtures.mjs";
import { fileFacts, findText, loadPlain, textLeaks } from "./helpers/pdfExportScan.mjs";
import { differingPixels, findColorBox, renderAll } from "./helpers/pdfExportRender.mjs";

const { PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString, PDFArray, PDFNull } = pdfLib;
const N = (name) => PDFName.of(name);
const text = (bytes) => Buffer.from(bytes).toString("latin1");
const noCanvas = !canRender && "no canvas binary on this platform";

// -----------------------------------------------------------------------------------------------------------
// shapes.js: the rules the overlay shares with the export
// -----------------------------------------------------------------------------------------------------------

test("shapes: arrow heads, the parts of a line, dash patterns", () => {
  assert.deepEqual(arrowHeadSize(2), { length: 8, width: 6 });
  assert.deepEqual(arrowHeadSize(0.5), { length: 6, width: 4.5 }, "never shorter than 6 pt");
  assert.deepEqual(lineParts({ length: 100, strokeWidth: 2 }), { shaft: [0, 100], heads: [], headLength: 0, headWidth: 6 });
  const end = lineParts({ length: 100, strokeWidth: 2, headEnd: true });
  assert.deepEqual(end.shaft, [0, 92]);
  assert.deepEqual(end.heads, [[[100, 0], [92, -3], [92, 3]]], "the tip is the end point");
  const both = lineParts({ length: 100, strokeWidth: 2, headStart: true, headEnd: true });
  assert.deepEqual(both.shaft, [8, 92]);
  assert.deepEqual(both.heads[0][0], [0, 0]);
  const short = lineParts({ length: 10, strokeWidth: 2, headStart: true, headEnd: true });
  assert.equal(short.shaft, null, "heads that use up the line leave no shaft");
  assert.deepEqual(short.heads.map((head) => head[1][0]), [5, 5], "and meet in the middle");
  assert.deepEqual(lineParts({ length: 0, strokeWidth: 2, headEnd: true }).heads, []);
  assert.deepEqual(dashPattern("dashed", 3), [6, 9]);
  assert.deepEqual(dashPattern("dotted", 3).map((value) => Math.round(value * 1000) / 1000), [0.003, 6]);
  assert.equal(dashPattern("solid", 3), null);
});

test("shapes: outlines start and run like the SVG elements of the overlay; paths flip between the two frames", () => {
  assert.deepEqual(rectPath(40, 20), [["M", 0, 0], ["L", 40, 0], ["L", 40, 20], ["L", 0, 20], ["Z"]]);
  const ellipse = ellipsePath(20, 10, 20, 10);
  assert.deepEqual(ellipse[0], ["M", 40, 10], "from the rightmost point");
  assert.deepEqual(ellipse[1].slice(5), [20, 20], "towards the bottom of a y-down box: clockwise for the reader");
  assert.equal(ellipse.length, 6);
  assert.deepEqual(flipPath(rectPath(40, 20), 20), [["M", 0, 20], ["L", 40, 20], ["L", 40, 0], ["L", 0, 0], ["Z"]]);
  assert.deepEqual(flipPath([["C", 1, 2, 3, 4, 5, 6]], 10), [["C", 1, 8, 3, 6, 5, 4]]);
  assert.equal(pathToSvg(rectPath(40, 20)), "M0 0 L40 0 L40 20 L0 20 Z");
  assert.equal(pathToSvg([["C", 1 / 3, 0, 2, 2.00004, -0.00001, 5]]), "C0.333 0 2 2 0 5");
});

test("shapes: a smooth curve passes through every sample; quads become counter-clockwise; the underline bar", () => {
  const points = [[0, 0], [10, 20], [30, 5], [50, 25]];
  const path = smoothPath(points);
  assert.deepEqual(path[0], ["M", 0, 0]);
  assert.deepEqual(path.slice(1).map((command) => [command[0], command[5], command[6]]), [["C", 10, 20], ["C", 30, 5], ["C", 50, 25]]);
  assert.deepEqual(smoothPath([[1, 2], [3, 4]]), [["M", 1, 2], ["L", 3, 4]]);
  assert.deepEqual(smoothPath([[1, 2]]), []);
  assert.deepEqual(strokePointsLocal({ w: 200, h: 80 }, [[0, 0.5], [1, 0.25]]), [[0, 40], [200, 20]]);
  // corners as read (top-left, top-right, bottom-right, bottom-left) in user space are clockwise: reversed
  assert.deepEqual(quadCorners([0, 10, 20, 10, 20, 0, 0, 0]), [[0, 0], [20, 0], [20, 10], [0, 10]]);
  assert.deepEqual(quadCorners([0, 0, 20, 0, 20, 10, 0, 10]), [[0, 0], [20, 0], [20, 10], [0, 10]]);
  assert.deepEqual(underlineBar({ unitsPerEm: 2048, underlinePosition: -217, underlineThickness: 150 }, 20.48), { offset: 2.17, thickness: 1.5 });
  assert.deepEqual(underlineBar({ unitsPerEm: 1000 }, 10), { offset: 1, thickness: 0.5 }, "conventional values for a font without the metrics");
});

// -----------------------------------------------------------------------------------------------------------
// imageInfo.js
// -----------------------------------------------------------------------------------------------------------

test("pictures: the real format, the EXIF orientation of a JPEG and the matrix that turns it", () => {
  assert.equal(sniffImage(SAMPLE_PNG), "png");
  assert.equal(sniffImage(SAMPLE_JPEG), "jpeg");
  assert.equal(sniffImage(Uint8Array.from(Buffer.from("GIF89a"))), null);
  assert.equal(sniffImage("not bytes"), null);
  assert.equal(jpegOrientation(SAMPLE_JPEG), 1, "no EXIF data");
  assert.equal(jpegOrientation(SAMPLE_PNG), 1);
  for (let orientation = 1; orientation <= 8; orientation += 1) assert.equal(jpegOrientation(withExifOrientation(SAMPLE_JPEG, orientation)), orientation);
  assert.equal(jpegOrientation(withExifOrientation(SAMPLE_JPEG, 9)), 1, "a value outside 1..8");
  assert.equal(jpegOrientation(withExifOrientation(SAMPLE_JPEG, 6).subarray(0, 20)), 1, "a truncated file");
  // a view into a larger buffer
  const big = new Uint8Array(3000);
  big.set(withExifOrientation(SAMPLE_JPEG, 8), 500);
  assert.equal(jpegOrientation(big.subarray(500, 500 + SAMPLE_JPEG.length + 36)), 8);

  // EXIF defines an orientation by where the first stored row and the first stored column are shown
  const SHOWN = { 1: ["top", "left"], 2: ["top", "right"], 3: ["bottom", "right"], 4: ["bottom", "left"], 5: ["left", "top"], 6: ["right", "top"], 7: ["right", "bottom"], 8: ["left", "bottom"] };
  const [width, height] = [40, 30];
  const side = (x, y) => (Math.abs(x) < 1e-9 ? "left" : Math.abs(x - width) < 1e-9 ? "right" : Math.abs(y - height) < 1e-9 ? "top" : "bottom");
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const m = orientationMatrix(orientation, width, height);
    const at = (u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
    // in the unit square of an image the first row is v = 1, the first column u = 0
    assert.equal(side(...at(0.5, 1)), SHOWN[orientation][0], `orientation ${orientation}: first row`);
    assert.equal(side(...at(0, 0.5)), SHOWN[orientation][1], `orientation ${orientation}: first column`);
    // the picture always fills the box
    const corners = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
    assert.deepEqual([Math.min(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[1]))], [0, width, 0, height]);
  }
});

// -----------------------------------------------------------------------------------------------------------
// contentTokens.js, tounicode.js, decodeStreamBytes
// -----------------------------------------------------------------------------------------------------------

test("tokenizer: strings, names, numbers, arrays, dictionaries, comments, byte offsets", () => {
  const source = "/Span << /ActualText (a\\(b\\)c \\101\\\n) /MCID 3 >> BDC [(A) -20.5 <42 4> (C\\\\)] TJ /F#201 12 Tf .5 -.5 +3 --7 1e 0 0 cm (un(bal)anced) Tj EMC % comment (ignored\nBT ET";
  const { operations, problems } = tokenizeContent(new Uint8Array(Buffer.from(source, "latin1")));
  assert.deepEqual(operations.map((operation) => operation.op), ["BDC", "TJ", "Tf", "1e", "cm", "Tj", "EMC", "BT", "ET"]);
  const properties = Object.fromEntries(operations[0].operands[1].entries);
  assert.equal(text(properties.ActualText.bytes), "a(b)c A", "escapes, octal and line continuation");
  assert.equal(properties.MCID.value, 3);
  assert.deepEqual(operations[1].operands[0].items.map((item) => (item.type === "string" ? text(item.bytes) : item.value)), ["A", -20.5, "B@", "C\\"]);
  assert.equal(operations[2].operands[0].value, "F 1", "#20 in a name");
  assert.deepEqual(operations[3].operands.map((operand) => operand.value), [0.5, -0.5, 3, -7], "\"--7\" is read as -7; \"1e\" is not a number");
  assert.equal(text(operations[5].operands[0].bytes), "un(bal)anced");
  assert.deepEqual(problems, []);
  assert.equal(source.slice(operations[2].start, operations[2].end), "/F#201 12 Tf", "the slice [start, end) is the operation as written");
  assert.equal(serializeToken(operations[1].operands[0]), "[<41> -20.5 <4240> <435C>]");
  assert.equal(serializeToken(operations[2].operands[0]), "/F#201");
  assert.deepEqual(tokenizeContent(new Uint8Array(Buffer.from("1 0 0 1 (open"))).problems.length, 2, "an unterminated string and operands without an operator are reported");
});

test("tokenizer: inline images are skipped by length, also when their data contains \"EI\"", () => {
  const data = Uint8Array.from([1, 2, 32, 0x45, 0x49, 32, 3, 4, 5, 6, 7, 8]); // 4 x 3 grey pixels with " EI " inside
  const content = Buffer.concat([Buffer.from("q BI /W 4 /H 3 /BPC 8 /CS /G ID "), Buffer.from(data), Buffer.from(" EI Q 1 0 0 rg 0 0 5 5 re f\n")]);
  const { operations, problems } = tokenizeContent(new Uint8Array(content));
  assert.deepEqual(operations.map((operation) => operation.op), ["q", "BI", "Q", "rg", "re", "f"]);
  assert.deepEqual([operations[1].inline.dataEnd - operations[1].inline.dataStart, operations[1].inline.lengthFrom], [12, "geometry"]);
  assert.deepEqual(problems, []);
  const hex = tokenizeContent(new Uint8Array(Buffer.from("BI /W 2 /H 1 /BPC 8 /CS /G /F /AHx ID 00ff> EI 0 g")));
  assert.deepEqual([hex.operations.map((operation) => operation.op), hex.operations[0].inline.lengthFrom], [["BI", "g"], "filter end marker"]);
});

test("tokenizer: what the content leaves behind in the graphics state; which resources it uses", () => {
  const balance = (source) => analyseBalance(tokenizeContent(new Uint8Array(Buffer.from(source))).operations);
  assert.deepEqual(balance("q 1 0 0 1 5 5 cm Q BT ET"), { endDepth: 0, underflow: 0, inText: false, openMarkedContent: 0, openCompatibility: 0, ctmChangesAtTopLevel: 0, balanced: true, clean: true });
  assert.equal(balance("0.5 0 0 0.5 0 0 cm").clean, false, "a matrix at the top level");
  assert.deepEqual([balance("Q Q q").underflow, balance("Q Q q").endDepth], [2, -1]);
  assert.deepEqual([balance("q q BT /Tag BMC BX").endDepth, balance("q q BT /Tag BMC BX").inText, balance("q q BT /Tag BMC BX").openMarkedContent, balance("q q BT /Tag BMC BX").openCompatibility], [2, true, 1, 1]);
  // Every name among the operands counts, for every category: which operand an operator takes is the viewer's
  // business (pdf.js hands left-over operands to the next operator), and a name that is nowhere in the content
  // cannot be used by it. The first version read one operand per operator and lost fonts and pictures.
  const names = ["GS1", "Fm1", "F2", "OC", "Layer1", "Im3", "Pattern", "P7", "Sh4"];
  const used = usedResourceNames(new Uint8Array(Buffer.from("/GS1 gs /Fm1 Do BT /F2 9 Tf (x) Tj ET /OC /Layer1 BDC /Im3 Do EMC /Pattern cs /P7 scn 0 0 5 5 re f /Sh4 sh")));
  assert.deepEqual(Object.keys(used).sort(), ["ExtGState", "Font", "Pattern", "Properties", "Shading", "XObject"]);
  for (const [category, found] of Object.entries(used)) assert.deepEqual([...found], names, category);
  const odd = usedResourceNames(new Uint8Array(Buffer.from("BT /F2 /GS1 gs 20 Tf ET /ImB /ImA Do 0 /ImC Do")));
  assert.deepEqual([[...odd.Font], [...odd.XObject]], [["F2", "GS1", "ImB", "ImA", "ImC"], ["F2", "GS1", "ImB", "ImA", "ImC"]], "also a name that is not where the operator expects it");
  assert.ok(!usedResourceNames(new Uint8Array(Buffer.from("(a /Name in a string) Tj [/InArray] TJ"))).Font.has("Name"), "a name inside a string is no operand");
  assert.equal(usedResourceNames(new Uint8Array(Buffer.from("(unterminated"))), null, "content that is not understood proves nothing");
});

test("ToUnicode maps: bfchar, both forms of bfrange, multi-character targets", () => {
  const cmap = parseToUnicode(new Uint8Array(Buffer.from([
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    "2 beginbfchar <0003> <0020> <0005> <00660069> endbfchar",
    "2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<1EA4> <1EC6>] endbfrange"
  ].join("\n"))));
  assert.deepEqual(cmap.codeLengths, [2]);
  assert.equal(cmap.decode(Uint8Array.from([0, 0x10, 0, 0x11, 0, 0x12, 0, 3, 0, 5, 0, 0x20, 0, 0x21])), "ABC fiẤỆ");
  assert.equal(cmap.decode(Uint8Array.from([0, 0x77])), "", "an unmapped code");
});

test("decodeStreamBytes undoes every text filter, filter chains and predictors; image filters are refused", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const context = doc.context;
  // long enough to cross the 9 -> 10 -> 11 -> 12 bit code widths of LZW and to need a table reset
  let source = "";
  for (let index = 0; index < 2500; index += 1) source += `BT /F1 ${10 + (index % 7)} Tf ${(index * 37) % 500} ${(index * 91) % 700} Td (line ${index} - ${((index * 2654435761) % 4294967296).toString(36)}) Tj ET\n`;
  const raw = new Uint8Array(Buffer.from(source, "latin1"));
  const cases = {
    "no filter": [raw, {}],
    FlateDecode: [flate(raw), { Filter: "FlateDecode" }],
    "LZWDecode (EarlyChange 1, the default)": [lzw(raw, 1), { Filter: "LZWDecode" }],
    "LZWDecode /EarlyChange 0": [lzw(raw, 0), { Filter: "LZWDecode", DecodeParms: { EarlyChange: 0 } }],
    ASCII85Decode: [ascii85(raw), { Filter: "ASCII85Decode" }],
    ASCIIHexDecode: [asciiHex(raw), { Filter: "ASCIIHexDecode" }],
    RunLengthDecode: [runLength(raw), { Filter: "RunLengthDecode" }],
    "[ASCII85Decode FlateDecode]": [ascii85(flate(raw)), { Filter: ["ASCII85Decode", "FlateDecode"] }],
    "[ASCIIHexDecode LZWDecode]": [asciiHex(lzw(raw)), { Filter: ["ASCIIHexDecode", "LZWDecode"] }],
    "abbreviated names [A85 Fl]": [ascii85(flate(raw)), { Filter: ["A85", "Fl"] }],
    "FlateDecode + PNG predictor 12": [flate(pngUpPredict(raw, 64)), { Filter: "FlateDecode", DecodeParms: { Predictor: 12, Columns: 64 } }],
    "FlateDecode + TIFF predictor 2": [flate(tiffPredict(raw, 50)), { Filter: "FlateDecode", DecodeParms: { Predictor: 2, Columns: 50 } }],
    "[ASCII85Decode FlateDecode] + predictor on the second": [ascii85(flate(pngUpPredict(raw, 32))), { Filter: ["ASCII85Decode", "FlateDecode"], DecodeParms: [null, { Predictor: 15, Columns: 32 }] }]
  };
  for (const [label, [encoded, dict]] of Object.entries(cases)) {
    // predictors pad the last row with spaces
    assert.equal(text(decodeStreamBytes(context, PDFRawStream.of(context.obj(dict), encoded))).trimEnd(), source.trimEnd(), label);
  }
  assert.throws(() => decodeStreamBytes(context, PDFRawStream.of(context.obj({ Filter: "DCTDecode" }), raw)), /cannot be decoded/);
  const page = doc.addPage([100, 100]);
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: 10, y: 10 } });
  assert.match(text(getPageContentBytes(page)), /0 0 m\s+10 10 l/, "a stream the library generated itself is read without decoding");
});

// -----------------------------------------------------------------------------------------------------------
// content.js: page content, resources, isolation
// -----------------------------------------------------------------------------------------------------------

test("setPageContentBytes writes one Flate stream and deletes the old ones only when nothing else uses them", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const shared = doc.context.register(doc.context.stream("0 0 1 rg 10 10 30 30 re f\n"));
  const [a, b] = [doc.addPage([100, 100]), doc.addPage([100, 100])];
  a.node.set(N("Contents"), shared);
  b.node.set(N("Contents"), doc.context.obj([shared]));
  const kept = setPageContentBytes(a, new Uint8Array(Buffer.from("1 0 0 rg 10 10 30 30 re f\n")));
  assert.deepEqual([kept.deleted, kept.kept], [0, 1], "the stream page 2 still uses is kept");
  assert.deepEqual(pageContentRefs(a), [kept.ref]);
  assert.equal(String(doc.context.lookup(kept.ref).dict.get(N("Filter"))), "/FlateDecode");
  assert.equal(text(getPageContentBytes(a)), "1 0 0 rg 10 10 30 30 re f\n");
  assert.equal(text(getPageContentBytes(b)), "0 0 1 rg 10 10 30 30 re f\n");
  const gone = setPageContentBytes(b, new Uint8Array(0));
  assert.deepEqual([gone.deleted, gone.kept], [1, 0], "now nobody uses it");
  assert.equal(doc.context.lookup(shared), undefined);
});

test("resources: inherited dictionaries are found; changing one page's entry needs a private copy first", async () => {
  const fixture = await buildLinkedFixture();
  const doc = await loadPlain(fixture.bytes);
  const [first, second] = doc.getPages();
  assert.equal(first.node.get(N("Resources")), undefined, "the leaf has no /Resources entry");
  const inherited = getPageResources(first);
  assert.ok(inherited.lookup(N("Font")).has(N("F1")), "found through the page tree");
  const treeFonts = inherited.lookup(N("Font"));
  const privateFonts = ownResourceCategory(first, "Font");
  assert.notEqual(privateFonts, treeFonts);
  assert.equal(ownResourceCategory(first, "Font"), privateFonts, "asking again gives the same private dictionary");
  privateFonts.set(N("Extra"), privateFonts.get(N("F1")));
  assert.ok(!treeFonts.has(N("Extra")), "the dictionary of the page tree is untouched");
  const original = getPageResources(second).lookup(N("XObject")).get(N("Im1"));
  const own = ownResource(second, "XObject", "Im1");
  assert.notEqual(own.ref, original);
  assert.equal(getPageResources(second).lookup(N("XObject")).get(N("Im1")), own.ref);
  assert.throws(() => ownResource(second, "XObject", "Nope"), /does not exist/);
  const font = describeFont(doc.context, privateFonts.get(N("F1")));
  assert.deepEqual([font.subtype, font.baseFont, font.composite, font.encoding.base], ["Type1", "Helvetica", false, "WinAnsiEncoding"]);
});

test("isolatePageContent: whatever a page leaves in the graphics state, a drawing starts from the default state", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const context = doc.context;
  const dirty = context.register(context.stream("0.5 0 0 0.5 80 60 cm 0.8 0.9 1 rg 0 0 200 100 re f\n")); // scales and shifts, never restores
  const stray = context.register(context.stream("Q 0 1 -1 0 150 0 cm 1 0.9 0.8 rg 0 0 60 60 re f\n")); // pops whatever wrapper there is, then rotates
  const open = context.register(context.stream("q q 2 0 0 2 0 0 cm /Tag BMC BT\n")); // two q, marked content and a text object left open
  const sharedArray = context.register(context.obj([dirty, stray]));
  const make = (contents) => {
    const page = doc.addPage([300, 200]);
    if (contents === null) page.node.delete(N("Contents"));
    else page.node.set(N("Contents"), contents);
    return page;
  };
  const pages = [make(dirty), make(context.obj([dirty, stray])), make(sharedArray), make(sharedArray), make(null), make(context.obj([])), make(dirty), make(open)];
  const analyses = pages.map((page) => {
    const canvas = new PageCanvas(page);
    canvas.rect(220, 150, 30, 30, { fill: [1, 0, 1] });
    canvas.flush();
    return canvas.isolation;
  });
  // A Q without a q (pages 2 - 4) is BLANKED in a copy of the content that belongs to the page alone: a viewer
  // ignores such a Q, and inside any wrapper it would restore the wrapper's state instead and move the rest of
  // the page. (The first version put one more "q" in front for each of them, which changed how the page looked.)
  assert.deepEqual(analyses.map((isolation) => [isolation.wrapped, isolation.analysis.underflow, isolation.analysis.strayRestores, isolation.analysis.endDepth, isolation.unreadable]), [
    [true, 0, 0, 0, false], [true, 0, 1, 0, false], [true, 0, 1, 0, false], [true, 0, 1, 0, false], [false, 0, 0, 0, false], [false, 0, 0, 0, false], [true, 0, 0, 0, false], [true, 0, 0, 2, false]
  ]);
  assert.equal(analyses[7].analysis.inText, true);
  // the shared streams are not modified, the shared array is not touched, and no page got the library's own wrapper
  assert.equal(context.lookup(sharedArray).size(), 2);
  assert.equal(text(decodeStreamBytes(context, context.lookup(dirty))), "0.5 0 0 0.5 80 60 cm 0.8 0.9 1 rg 0 0 200 100 re f\n");
  assert.equal(text(decodeStreamBytes(context, context.lookup(stray))), "Q 0 1 -1 0 150 0 cm 1 0.9 0.8 rg 0 0 60 60 re f\n");
  assert.equal(context.pushGraphicsStateContentStreamRef, undefined);
  assert.equal(text(getPageContentBytes(pages[7])).replace(/\s+/g, " ").trim(), "q q q 2 0 0 2 0 0 cm /Tag BMC BT ET EMC Q Q Q q 1 0 1 rg 220 150 30 30 re f Q");
  // page 2: one q, the content of both streams in ONE stream of its own with the stray Q gone, one Q, the drawing
  assert.equal(text(getPageContentBytes(pages[1])).replace(/\s+/g, " ").trim(), "q 0.5 0 0 0.5 80 60 cm 0.8 0.9 1 rg 0 0 200 100 re f 0 1 -1 0 150 0 cm 1 0.9 0.8 rg 0 0 60 60 re f Q q 1 0 1 rg 220 150 30 30 re f Q");
  assert.equal(pageContentRefs(pages[1]).length, 4, "wrapper, the page's own copy, wrapper, drawing");
  assert.ok(!pageContentRefs(pages[1]).includes(stray) && !pageContentRefs(pages[2]).includes(stray), "the stream with the stray Q is no longer on these pages");
  assert.notEqual(pageContentRefs(pages[2])[1], pageContentRefs(pages[3])[1], "two pages that shared the array each have a copy");
  assert.equal(isolatePageContent(pages[0]).wrapped, false, "idempotent");
  const bytes = await doc.save({ useObjectStreams: false });
  const reloaded = await loadPlain(bytes);
  assert.deepEqual([isolatePageContent(reloaded.getPage(4)).wrapped, isolatePageContent(reloaded.getPage(0)).wrapped, isolatePageContent(reloaded.getPage(0)).wrapped], [true, true, false]);
  if (!canRender) return;
  const images = await renderAll(bytes, { scale: 1 });
  images.forEach((image, index) => {
    const box = findColorBox(image, [255, 0, 255], 20);
    assert.ok(box && Math.abs(box.cx - 235) <= 1 && Math.abs(box.cy - 35) <= 1 && Math.abs(box.w - 30) <= 1 && Math.abs(box.h - 30) <= 1, `page ${index + 1}: the square is at ${JSON.stringify(box)}`);
  });
});

test("the library's own single q ... Q wrapper puts a drawing in the wrong place when the content has a stray Q", { skip: noCanvas }, async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const context = doc.context;
  const page = doc.addPage([300, 200]);
  page.node.set(N("Contents"), context.register(context.stream("Q 0 1 -1 0 150 0 cm 1 0.9 0.8 rg 0 0 60 60 re f\n")));
  const loaded = await loadPlain(await doc.save({ useObjectStreams: false }));
  loaded.getPage(0).drawRectangle({ x: 220, y: 150, width: 30, height: 30, color: pdfLib.rgb(1, 0, 1) });
  const [image] = await renderAll(await loaded.save(), { scale: 1 });
  const box = findColorBox(image, [255, 0, 255], 20);
  assert.ok(!box || Math.abs(box.cx - 235) > 5 || Math.abs(box.cy - 35) > 5, "if this fails the library was fixed (isolatePageContent stays correct either way)");
});

// -----------------------------------------------------------------------------------------------------------
// gc.js
// -----------------------------------------------------------------------------------------------------------

test("removePage() + save() leaves the page in the file; collectGarbage() removes it", async () => {
  const secret = "TRANG HAI bí mật 4471";
  const source = await makeTextPdf([{ lines: ["Trang một"], size: [300, 200] }, { lines: [secret], size: [300, 200] }, { lines: ["Trang ba"], size: [300, 200] }]);
  for (const useObjectStreams of [false, true]) {
    const leaky = await loadPlain(source);
    leaky.removePage(1);
    const leakyBytes = await leaky.save({ useObjectStreams });
    assert.deepEqual(await extractText(leakyBytes), ["Trang một", "Trang ba"], "no viewer shows the removed page ...");
    assert.deepEqual(await textLeaks(leakyBytes, [secret]), [secret], "... and its text is still in the file");
    assert.ok((await fileFacts(leakyBytes)).orphans.length > 0);

    const doc = await loadPlain(source);
    doc.removePage(1);
    const stats = await collectGarbage(doc);
    assert.ok(stats.removed >= 1 && stats.after === stats.before - stats.removed);
    const clean = await doc.save({ useObjectStreams });
    assert.deepEqual(await textLeaks(clean, [secret]), []);
    assert.deepEqual((await fileFacts(clean)).orphans, []);
    assert.deepEqual(await extractText(clean), ["Trang một", "Trang ba"]);
    assert.equal((await collectGarbage(doc)).removed, 0, "idempotent");
  }
});

test("collectGarbage: an embedded but unused font is swept, indirect lengths leave no orphan, /Size is exact", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const used = await doc.embedFont(fontBytes("arimo-regular"), { subset: true });
  await doc.embedFont(fontBytes("tinos-regular"), { subset: true }); // never drawn
  doc.addPage([300, 200]).drawText("Phông được dùng", { x: 20, y: 100, size: 16, font: used });
  const dry = await collectGarbage(doc, { dryRun: true });
  assert.ok(dry.removed >= 4, "font file, descriptor, CID font, ToUnicode map, font dictionary");
  assert.equal(doc.context.enumerateIndirectObjects().length, dry.before, "a dry run deletes nothing");
  await collectGarbage(doc);
  const bytes = await doc.save({ useObjectStreams: false });
  assert.ok(!text(bytes).includes("Tinos"), "no trace of the unused font");
  assert.deepEqual(await extractText(bytes), ["Phông được dùng"]);
  const numbers = [...text(bytes).replace(/stream\r?\n[\s\S]*?endstream/g, "").matchAll(/(\d+) 0 obj/g)].map((match) => Number(match[1]));
  assert.equal(Number(/\/Size (\d+)/.exec(text(bytes))[1]), Math.max(...numbers) + 1, "the trailer /Size is one more than the highest object number");

  // a stream with an indirect /Length: the writer makes the length direct, the number object must not stay behind
  const indirect = await loadPlain(rawPdfWithIndirectLength("BT /F1 12 Tf 20 100 Td (INDIRECT) Tj ET"));
  await collectGarbage(indirect);
  const facts = await fileFacts(await indirect.save({ useObjectStreams: false }));
  assert.deepEqual(facts.orphans, []);
  assert.equal(facts.doc.context.lookup(PDFRef.of(6)), undefined, "the number object 6 is gone");
});

test("compactObjectNumbers: contiguous numbers, one cross-reference subsection, the same pages", async () => {
  const source = await makeTextPdf([{ lines: ["A"], size: [200, 100] }, { lines: ["B"], size: [200, 100] }, { lines: ["C"], size: [200, 100] }]);
  const doc = await loadPlain(source);
  doc.removePage(1);
  await collectGarbage(doc);
  const subsections = (bytes) => {
    const raw = text(bytes);
    return raw.slice(raw.lastIndexOf("\nxref\n") + 6, raw.lastIndexOf("trailer")).split("\n").filter((line) => /^\d+ \d+$/.test(line.trim()));
  };
  assert.ok(subsections(await doc.save({ useObjectStreams: false })).length > 1, "the sweep leaves gaps in the numbering");
  assert.ok(compactObjectNumbers(doc).renumbered > 0);
  const compact = await doc.save({ useObjectStreams: false });
  assert.equal(subsections(compact).length, 1);
  assert.deepEqual(await extractText(compact), ["A", "C"]);
  assert.deepEqual(findOrphans(await loadPlain(compact)), []);
});

// -----------------------------------------------------------------------------------------------------------
// copyPages.js, graphCopier.js
// -----------------------------------------------------------------------------------------------------------

test("the leak that copyPagesSafe() exists for: the library's copyPages() of page 1 alone brings pages 2 and 3 along", async () => {
  const fixture = await buildLinkedFixture();
  const source = await loadPlain(fixture.bytes);
  const naive = await PDFDocument.create({ updateMetadata: false });
  const [page] = await naive.copyPages(source, [0]);
  naive.addPage(page);
  const bytes = await naive.save({ useObjectStreams: false });
  assert.equal((await extractText(bytes)).length, 1, "one page for every viewer");
  const foreign = [MARKERS.page[1], MARKERS.formSecret2, MARKERS.structActualTextP2, MARKERS.page[2]];
  assert.deepEqual(await textLeaks(bytes, foreign), foreign, "text, a form value and structure text of other pages");
  assert.ok(Buffer.from(bytes).includes(fixture.imageSignature), "the picture of page 2");
  const problems = auditOutput(await loadPlain(bytes));
  for (const kind of ["ghost page", "structure tree object", "annotation"]) assert.ok(problems.some((problem) => problem.includes(kind)), `the audit names the ${kind}`);

  // the same page through copyPagesSafe()
  const safe = await PDFDocument.create({ updateMetadata: false });
  const result = await copyPagesSafe(await loadPlain(fixture.bytes), [0], safe);
  safe.addPage(result.pages[0]);
  await collectGarbage(safe);
  const clean = await safe.save({ useObjectStreams: false });
  assert.deepEqual(await textLeaks(clean, foreign), []);
  assert.deepEqual(auditOutput(await loadPlain(clean)), []);
  assert.deepEqual(listFieldNames(await loadPlain(clean)), [], "the form is rebuilt by the pipeline, not by the copy");
  const kept = await findText(clean, [MARKERS.page[0], MARKERS.formOnly1, MARKERS.formShared, MARKERS.popupText, MARKERS.header]);
  for (const [needle, hits] of Object.entries(kept)) assert.ok(hits.length > 0, `${needle} belongs to page 1`);
});

test("the copier has no recursion limit: a comment thread of 6 000 replies copies; a page can only arrive as a root", async () => {
  const REPLIES = 6000; // the library's recursive copier gives up at about 2 900 nested objects
  const deep = await PDFDocument.create({ updateMetadata: false });
  const page = deep.addPage([200, 200]);
  const other = deep.addPage([200, 200]);
  const context = deep.context;
  const annots = [];
  let previous = null;
  for (let index = 0; index < REPLIES; index += 1) {
    const dict = context.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 10, 30, 30], P: page.ref });
    if (previous) dict.set(N("IRT"), previous);
    previous = context.register(dict);
    annots.push(previous);
  }
  // a reference to another page from a place no rule knows: the copier must refuse it
  context.lookup(annots[0]).set(N("Elsewhere"), other.ref);
  page.node.set(N("Annots"), context.obj(annots.slice().reverse())); // the last reply first: the deepest chain at once
  const bytes = await deep.save({ objectsPerTick: Number.MAX_SAFE_INTEGER });
  const naive = await PDFDocument.create({ updateMetadata: false });
  await assert.rejects(() => naive.copyPages(deep, [0]), RangeError, "the library's recursive copier overflows the stack");
  const out = await PDFDocument.create({ updateMetadata: false });
  const result = await copyPagesSafe(await loadPlain(bytes), [0], out);
  out.addPage(result.pages[0]);
  assert.equal(out.getPage(0).node.Annots().size(), REPLIES);
  assert.equal(result.copier.refused, 0, "the other page was blanked by the scrub before the copier met it");
  assert.deepEqual(auditOutput(out), []);
  const first = out.context.lookup(out.getPage(0).node.Annots().get(REPLIES - 1));
  assert.equal(first.get(N("Elsewhere"), true), undefined, "a reference to a blanked object goes: no entry, and no new object that holds null");
  assert.equal(first.get(N("P")), out.getPage(0).ref, "its own page is the output page");
  assert.equal(out.context.enumerateIndirectObjects().filter(([, object]) => object === PDFNull).length, 0);

  // without the scrub the copier itself refuses a page that is not one of its roots
  const { createGraphCopier } = await import("../src/pages/pdfEditor/engine/export/graphCopier.js");
  const source = await loadPlain(bytes);
  const bare = await PDFDocument.create({ updateMetadata: false });
  const copier = createGraphCopier(source.context, bare.context);
  const copied = copier.copy(source.context.lookup(source.getPage(0).node.Annots().get(REPLIES - 1)));
  assert.equal(copied.get(N("Elsewhere"), true), undefined);
  assert.equal(copied.get(N("P"), true), undefined, "also its own page: only copyPagesSafe() seeds page references");
  assert.equal(copier.refused, 2, "two pages, each refused once");
  const inArray = copier.copy(source.context.obj([source.getPage(1).ref, N("Fit")]));
  assert.equal(inArray.get(0), PDFNull, "in an array the place is kept: a destination becomes [null /Fit]");
});

// -----------------------------------------------------------------------------------------------------------
// outline.js, docSettings.js
// -----------------------------------------------------------------------------------------------------------

test("readOutline survives a cyclic /Next chain and 10 000 items; the outline is rewritten without recursion trouble", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  const context = doc.context;
  const root = context.obj({ Type: "Outlines" });
  const rootRef = context.register(root);
  const items = [];
  for (let index = 0; index < 10000; index += 1) {
    const dict = context.obj({ Parent: rootRef, Dest: [page.ref, "Fit"] });
    dict.set(N("Title"), PDFString.of(`Item ${index}`));
    items.push({ dict, ref: context.register(dict) });
  }
  items.forEach((item, index) => item.dict.set(N("Next"), items[(index + 1) % items.length].ref)); // the last one points back at the first
  root.set(N("First"), items[0].ref);
  doc.catalog.set(N("Outlines"), rootRef);
  const read = readOutline(doc);
  assert.deepEqual([read.items.length, read.count, read.truncated], [10000, 10000, false]);
  assert.deepEqual([readOutline(doc, { maxItems: 50 }).items.length, readOutline(doc, { maxItems: 50 }).truncated], [50, true]);
  const mapped = mapOutline(read.items, () => page.ref);
  assert.deepEqual([mapped.kept, mapped.dropped], [10000, 0]);
  assert.equal(writeOutline(doc, mapped.items).written, 10000);
  assert.equal(readOutline(doc).items[9999].title, "Item 9999");
});

test("mapOutline: an entry whose page is gone is dropped, a parent with surviving children becomes a heading on its first child", () => {
  const item = (title, pageIndex, children = []) => ({ title, target: pageIndex === null ? null : { kind: "goto", pageIndex, fit: [{ name: "Fit" }] }, color: null, bold: false, italic: false, open: true, children });
  const tree = [item("gone", 0), item("parent of a kept page", 0, [item("dropped child", 0), item("kept child", 1)]), { ...item("site", null), target: { kind: "uri", uri: "https://example.test/a b" } }];
  const mapped = mapOutline(tree, (index) => (index === 1 ? "PAGE-TWO" : undefined));
  assert.deepEqual(mapped.items.map((entry) => [entry.title, entry.dest && entry.dest.pageRef, entry.children.map((child) => child.title)]), [["parent of a kept page", "PAGE-TWO", ["kept child"]], ["site", null, []]]);
  assert.deepEqual([mapped.kept, mapped.dropped], [3, 2]);
  assert.equal(escapeLiteral("https://example.test/a(b)\\é"), "https://example.test/a\\(b\\)\\\\%C3%A9");
});

test("page labels follow their pages; XMP is escaped; the document id takes a seed", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let index = 0; index < 4; index += 1) doc.addPage([100, 100]);
  doc.catalog.set(N("PageLabels"), doc.context.obj({ Nums: [0, { S: "r" }, 2, { S: "D", St: 1, P: PDFString.of("A-") }] }));
  const labels = readPageLabels(doc);
  assert.deepEqual(labels.map((label) => `${label.prefix}${label.style}${label.value}`), ["r1", "r2", "A-D1", "A-D2"]);
  // output order: source pages 4, 1, a blank page, 3
  assert.equal(writePageLabels(doc, [labels[3], labels[0], null, labels[2]]), 4);
  const bytes = await doc.save();
  await withPdf(bytes, async (pdf) => assert.deepEqual(await pdf.getPageLabels(), ["A-2", "i", "3", "A-1"]));
  assert.equal(writePageLabels(doc, [null, null]), 0);
  assert.ok(!doc.catalog.has(N("PageLabels")), "no labels at all: the entry goes");
  assert.equal(readPageLabels(doc), null);

  const xmp = buildXmp({ title: "A & B <c> \"d\"", author: "Nguyễn", keywords: `x${String.fromCharCode(1)}y` }, { producer: "P", now: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) });
  assert.ok(xmp.includes("<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">A &amp; B &lt;c&gt; &quot;d&quot;</rdf:li></rdf:Alt></dc:title>"));
  assert.ok(xmp.includes("<pdf:Keywords>xy</pdf:Keywords>"), "a character XML cannot carry is left out");
  assert.ok(xmp.includes("<xmp:ModifyDate>2026-01-02T03:04:05Z</xmp:ModifyDate>") && xmp.includes("<dc:creator><rdf:Seq><rdf:li>Nguyễn</rdf:li></rdf:Seq></dc:creator>"));
  assert.equal(xmp.charCodeAt(xmp.indexOf("begin=\"") + 7), 0xfeff);

  assert.equal(setDocumentId(doc, Uint8Array.of(1, 2, 3)), "01020300000000000000000000000000");
  assert.equal(setDocumentId(doc, new Uint8Array(40).fill(255)), "FF".repeat(16));
  assert.notEqual(setDocumentId(doc), setDocumentId(doc), "random without a seed");
  assert.ok(doc.context.trailerInfo.ID instanceof PDFArray);
});

// -----------------------------------------------------------------------------------------------------------
// pageGeometry.js, draw.js
// -----------------------------------------------------------------------------------------------------------

test("pageGeometry() of the writer equals page.view / rotate / userUnit of pdf.js, also for odd /Rotate values and boxes", async () => {
  const geo = await buildGeometryFixture();
  const odd = await PDFDocument.create({ updateMetadata: false });
  for (const [rotate, crop] of [[-90, null], [450, null], [45, null], [720, [50, 50, 20, 20]], [0, [500, 500, 600, 600]]]) {
    const page = odd.addPage([200, 100]);
    page.node.set(N("Rotate"), odd.context.obj(rotate));
    if (crop) page.node.set(N("CropBox"), odd.context.obj(crop)); // corners in the "wrong" order; a box outside the page
  }
  for (const bytes of [geo.bytes, await odd.save()]) {
    const doc = await loadPlain(bytes);
    await withPdf(bytes, async (viewer) => {
      for (let index = 0; index < viewer.numPages; index += 1) {
        const page = await viewer.getPage(index + 1);
        const geometry = pageGeometry(doc.getPage(index));
        assert.deepEqual(geometry.view, page.view, `page ${index + 1}: view`);
        assert.deepEqual([geometry.rotate, geometry.userUnit], [page.rotate, page.userUnit], `page ${index + 1}`);
        const mine = viewportTransform(geometry, 1.5);
        const theirs = page.getViewport({ scale: 1.5 });
        assert.deepEqual(mine.transform.map((value) => Math.round(value * 1e6) / 1e6), theirs.transform.map((value) => Math.round(value * 1e6) / 1e6));
      }
    });
  }
});

test("PageCanvas: one resource name per font, image and graphics state; font metrics; missing characters", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes("be-vietnam-pro-regular"), { subset: true });
  const image = await doc.embedPng(SAMPLE_PNG);
  const page = doc.addPage([300, 200]);
  const canvas = new PageCanvas(page);
  for (let index = 0; index < 20; index += 1) {
    canvas.text(`dòng ${index}`, { font, size: 8, x: 10, y: 190 - index * 9 });
    canvas.image(image, 150, 190 - index * 9, 16, 8, { opacity: 0.5 });
    canvas.rect(200, 190 - index * 9, 20, 6, { fill: [1, 0, 0], fillOpacity: 0.5, strokeOpacity: 0.5 });
  }
  canvas.flush();
  const resources = page.node.Resources();
  assert.deepEqual(["Font", "XObject", "ExtGState"].map((category) => resources.lookup(N(category)).keys().length), [1, 1, 1], "60 drawing calls, three resource names");
  const metrics = fontMetrics(font);
  assert.deepEqual([metrics.unitsPerEm, metrics.ascent, metrics.descent < 0, metrics.underlinePosition < 0, metrics.underlineThickness > 0], [1000, 1, true, true, true]);
  assert.ok(Math.abs(font.heightAtSize(20) - (metrics.ascent - metrics.descent) * 20) < 1e-6);
  assert.deepEqual(missingCharacters(font, "Giá 漢字 → xong\n"), ["漢", "字", "→"], "line feeds are skipped when a whole text is checked");
  assert.deepEqual(missingCharacters(font, "a\nb", { ignoreLineBreaks: false }), ["\n"]);
  assert.throws(() => canvas.text("→", { font, size: 8 }), (error) => error.code === "EXPORT_TEXT_MISSING_GLYPH" && error.params.characters === "→");
  assert.deepEqual(await extractText(await doc.save()), [Array.from({ length: 20 }, (_, index) => `dòng ${index}`).join("\n")]);
});

test("createPainter: prepare() finds every problem before the first page is drawn; one painter embeds a face once", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages = [doc.addPage([300, 200]), doc.addPage([300, 200])];
  const fine = makeTextObject({ id: "t1", lines: ["Xin chào"], x: 150, y: 100 });
  const cjk = makeTextObject({ id: "t2", lines: ["Giá 漢字"], x: 150, y: 100 });
  const failing = createPainter(doc, { fonts: loadFont });
  await assert.rejects(() => failing.prepare([[fine], [cjk]]), (error) => error.code === "EXPORT_TEXT_MISSING_GLYPH" && error.params.objectId === "t2" && error.params.characters === "漢字");
  assert.deepEqual(pages.map((page) => page.node.get(N("Contents"))), [undefined, undefined], "nothing was drawn on any page");

  const warnings = [];
  const painter = createPainter(doc, { fonts: loadFont, warnings });
  const loads = [];
  const counting = createPainter(doc, { fonts: async (key) => {
    loads.push(key);
    return loadFont(key);
  } });
  await counting.prepare([[fine, makeTextObject({ id: "t3", lines: ["lần hai"], x: 150, y: 60, underline: true })], [fine]]);
  assert.deepEqual(loads, ["arimo-regular"], "one request per face, whatever the number of objects that use it");
  await painter.prepare([[fine], [fine]]);
  painter.drawPage(pages[0], 0, [fine], [{ rect: [10, 10, 60, 40], color: "#ffeeaa" }]);
  painter.drawPage(pages[1], 1, [fine]);
  painter.drawPage(pages[1], 1, [], []); // nothing to draw: nothing happens
  assert.deepEqual([painter.fontsEmbedded, painter.imagesEmbedded, painter.stats, warnings], [["arimo-regular"], 0, { objects: 2, underlays: 1 }, []]);
  assert.equal(painter.canvasFor(pages[0], 0), painter.canvasFor(pages[0], 0), "one canvas per page");
  assert.deepEqual(await extractText(await doc.save()), ["Xin chào", "Xin chào"]);
});

test("pruneSharedResources: one call on a loaded source; the source bytes stay as they were", async () => {
  const fixture = await buildGlobalResourcesFixture();
  const before = Buffer.from(fixture.bytes).toString("base64");
  assert.deepEqual(pruneSharedResources(await loadPlain(fixture.bytes), [0, 2]), { pages: 2, forms: 6, removed: 66, unresolved: [] });
  assert.deepEqual(pruneSharedResources(await loadPlain(fixture.bytes), [0, 1, 2]), { pages: 0, forms: 0, removed: 0, unresolved: [] });
  assert.deepEqual(pruneSharedResources(await loadPlain(fixture.bytes), [1, 1]), { pages: 1, forms: 2, removed: 27, unresolved: [] }, "page 2 alone (7), its form TP2 (10) and its pattern P2 (10)");
  const opaque = await buildGlobalResourcesFixture({ opaquePattern: true });
  assert.deepEqual(pruneSharedResources(await loadPlain(opaque.bytes), [0, 2]).unresolved, [0]);
  assert.equal(Buffer.from(fixture.bytes).toString("base64"), before);

  // the two steps apart: verify() judges the document as it is when it is called
  const doc = await loadPlain(fixture.bytes);
  const pruner = createResourcePruner(doc, [2]);
  assert.deepEqual(pruner.verify(), [], "nothing is known before prune()");
  assert.equal(pruner.prune().pages, 1);
  assert.deepEqual(pruner.verify(), []);
  // somebody hangs the shared dictionary back on the page: found
  const shared = (await loadPlain(fixture.bytes)).getPage(0).node.get(N("Resources"));
  doc.getPage(2).node.set(N("Group"), doc.context.obj({ S: "Transparency", Leak: doc.context.obj({ Again: shared }) }));
  assert.deepEqual(pruner.verify(), [2]);
});

test("pruner details: fonts of a default appearance stay, a pattern borrows the category it lacks, shadings, exact dictionaries are left alone", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const helv = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }));
  const courier = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Courier" }));
  const image = (seed) => ctx.register(ctx.stream(noiseBytes(8 * 8 * 3, seed), { Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  const shading = (blue) => ctx.obj({ ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [120, 0, 180, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, blue], N: 1 } });
  // a tiling pattern whose own resources have NO /XObject category: viewers find the name in the page's dictionary
  const pattern = ctx.register(ctx.stream("q 10 0 0 10 0 0 cm /Borrowed Do Q", {
    Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: { ProcSet: ["PDF"] }
  }));
  const first = doc.addPage([200, 200]);
  first.node.set(N("Resources"), ctx.obj({
    Font: { F1: helv, Unused: courier },
    XObject: { Used: image(1), Borrowed: image(2), Dead: image(3) },
    Pattern: { P1: pattern },
    Shading: { S1: shading(1), S2: shading(0.5) }
  }));
  first.node.set(N("Contents"), ctx.register(ctx.stream("BT /F1 12 Tf 10 180 Td (x) Tj ET q 20 0 0 20 10 100 cm /Used Do Q /Pattern cs /P1 scn 50 50 40 40 re f q 120 120 60 60 re W n /S1 sh Q")));
  // a text field that shows nothing yet: the resources of its appearance hold the fonts its /DA strings name
  const appearance = ctx.register(ctx.stream("/Tx BMC EMC", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 20], Resources: { Font: { Helv: helv, Cour: courier, Other: courier } } }));
  const group = ctx.obj({ FT: "Tx", T: PDFString.of("group"), DA: PDFString.of("/Cour 9 Tf 0 g") });
  const groupRef = ctx.register(group);
  const widget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Parent: groupRef, T: PDFString.of("field"), Rect: [10, 10, 110, 30], F: 4, P: first.ref, DA: PDFString.of("/Helv 10 Tf 0 g"), AP: { N: appearance } }));
  group.set(N("Kids"), ctx.obj([widget]));
  first.node.set(N("Annots"), ctx.obj([widget]));
  doc.catalog.set(N("AcroForm"), ctx.obj({ Fields: [groupRef] }));
  // page 2 names exactly what it uses; page 3 is the one that goes; page 4 cannot be read and shares nothing
  const second = doc.addPage([200, 200]);
  second.node.set(N("Resources"), ctx.obj({ Font: { F1: helv } }));
  second.node.set(N("Contents"), ctx.register(ctx.stream("BT /F1 12 Tf 10 180 Td (y) Tj ET")));
  doc.addPage([200, 200]);
  const fourth = doc.addPage([200, 200]);
  fourth.node.set(N("Resources"), ctx.obj({ XObject: { Dead: image(4) } }));
  fourth.node.set(N("Contents"), ctx.register(ctx.stream("q 20 0 0 20 10 100 cm /Dead Do Q", { Filter: "JBIG2Decode" })));
  const bytes = await doc.save({ useObjectStreams: false });

  const loaded = await loadPlain(bytes);
  const exact = loaded.getPage(1).node.get(N("Resources"));
  // Unused (font), Dead (picture), S2 (shading) on page 1; Other (font) in the appearance of the field
  assert.deepEqual(pruneSharedResources(loaded, [0, 1, 3]), { pages: 1, forms: 1, removed: 4, unresolved: [] });
  const names = (dict, category) => (dict.lookup(N(category)) ? dict.lookup(N(category)).keys().map((key) => key.decodeText()) : null);
  const resources = loaded.getPage(0).node.Resources();
  assert.deepEqual(["Font", "XObject", "Pattern", "Shading"].map((category) => names(resources, category)), [["F1"], ["Used", "Borrowed"], ["P1"], ["S1"]]);
  const field = loaded.context.lookup(loaded.getPage(0).node.Annots().get(0));
  assert.deepEqual(names(field.lookup(N("AP")).lookup(N("N")).dict.lookup(N("Resources")), "Font"), ["Helv", "Cour"], "its own /DA and the one of its parent");
  assert.equal(loaded.getPage(1).node.get(N("Resources")), exact, "the same object: nothing to remove, nothing shared with page 3");
  assert.deepEqual(names(loaded.getPage(3).node.Resources(), "XObject"), ["Dead"], "without proof nothing is removed (and nothing is reported: the dictionary is its own)");

  // the whole export: page 1 looks the same, pattern and shading included
  const { exportDocument } = await import("../src/pages/pdfEditor/engine/export/export.js");
  const result = await exportDocument({ sources: [{ id: "s", bytes }], pages: [0, 1, 3].map((index) => ({ source: "s", index })), now: new Date(0), idSeed: new Uint8Array(16) });
  assert.deepEqual([result.report.sources.s.copy.resources, result.report.warnings.map((warning) => warning.code)], [{ pages: 1, forms: 1, removed: 4, unresolved: [] }, []]);
  assert.deepEqual(listFieldNames(await loadPlain(result.bytes)), ["group.field"]);
  if (!canRender) return;
  const [source, output] = [await renderAll(bytes, { scale: 1 }), await renderAll(result.bytes, { scale: 1 })];
  assert.equal(differingPixels(source[0], output[0]), 0, "page 1");
  assert.equal(differingPixels(source[1], output[1]), 0, "page 2");
  assert.ok(findColorBox(output[0], [255, 0, 0], 60, { x: 120, y: 20, w: 20, h: 60 }), "the shading is painted");
});
