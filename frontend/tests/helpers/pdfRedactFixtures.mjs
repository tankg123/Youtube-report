// Generated inputs of the redaction suites: one small PDF per situation the engine must handle. Every file is
// built here from hand-written content streams, the PDF library and the bundled fonts (nothing is downloaded
// or copied). Each fixture returns { bytes, ... } plus what a test needs to know about it.
import zlib from "node:zlib";
import { VIETNAMESE_SAMPLE, makeTextPdf, pdfLib } from "./pdfTestKit.mjs";
import { bytesOf, formXObject, latin1, makePdf } from "./pdfRedactKit.mjs";

const { PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts } = pdfLib;
const S = (text) => PDFString.of(text);

/** Three lines of Helvetica; the secret is the middle of the second line. */
export async function plainTextPdf() {
  const content = "BT /F1 12 Tf 14 TL 72 700 Td (Invoice for Alice Example) Tj T* (Account PLAIN-SECRET-4711 is due) Tj T* (Last line stays untouched) Tj ET";
  const { bytes } = await makePdf([{ content }]);
  return { bytes, secret: "PLAIN-SECRET-4711", kept: ["Invoice for Alice Example", "Account", "is due", "Last line stays untouched"] };
}

/** Vietnamese in an embedded subset font (Type0 / Identity-H: the content stream holds glyph ids). */
export async function vietnamesePdf() {
  const second = "Dòng thứ hai được giữ nguyên vẹn";
  const bytes = await makeTextPdf([{ lines: [VIETNAMESE_SAMPLE, second] }], { useObjectStreams: false });
  return { bytes, secret: "Nguyễn Văn An", kept: ["Hợp đồng dịch vụ số 12/2026:", "đã ký ngày 16 tháng 11", second] };
}

/** One TJ array with kerning adjustments; the secret is a part of a word inside one of its strings. */
export async function kernedPdf() {
  const content = "BT /F1 12 Tf 72 700 Td [(Ref) -15 (erence KERN) 20 (ED-ACCT-9920-X) -25 (YZ tail) 10 ( stays)] TJ 0 -30 Td (line below the kerned one) Tj ET";
  const { bytes } = await makePdf([{ content }]);
  return { bytes, secret: "ACCT-9920", whole: "KERNED-ACCT-9920-XYZ", kept: ["Reference KERNED-", "-XYZ tail stays", "line below the kerned one"] };
}

/** One line set in three fonts; the target starts in the first and ends in the third. */
export async function twoFontsPdf() {
  const content = "BT /F1 12 Tf 72 700 Td (Helvetica lead ) Tj /F2 12 Tf (TIMES-MIDDLE-5566) Tj /F3 12 Tf ( courier tail) Tj 0 -30 Td (courier line below) Tj ET";
  const { bytes } = await makePdf([{ content }]);
  return { bytes, target: "ad TIMES-MIDDLE-5566 co", secret: "TIMES-MIDDLE-5566", kept: ["Helvetica le", "urier tail", "courier line below"] };
}

/** A page with /Rotate 90 and a CropBox inside the MediaBox. */
export async function rotatedCropPdf() {
  const content = "BT /F1 12 Tf 100 600 Td (Rotated page ROT-SECRET-3141 here) Tj 0 -40 Td (kept on the rotated page) Tj ET";
  const { bytes } = await makePdf([{ content, extra: { Rotate: 90, CropBox: [40, 50, 500, 700] } }]);
  return { bytes, secret: "ROT-SECRET-3141", kept: ["Rotated page", "here", "kept on the rotated page"] };
}

/** One Form XObject drawn by two pages (and its own text on each page). */
export async function sharedFormPdf() {
  const form = formXObject("BT /F1 12 Tf 0 0 Td (SHARED-FORM-TEXT 4471) Tj 0 -16 Td (form second line kept) Tj ET");
  const page = (label) => ({
    content: `BT /F1 12 Tf 72 720 Td (${label} direct text) Tj ET q 1 0 0 1 72 600 cm /Fm Do Q`,
    resources: (ctx, refs, fonts) => ({ Font: fonts, XObject: { Fm: refs.Fm } })
  });
  const { bytes } = await makePdf([page("page one"), page("page two")], { objects: { Fm: form } });
  return { bytes, secret: "SHARED-FORM-TEXT 4471", kept: ["page one direct text", "form second line kept"] };
}

/** Marked content with /ActualText, inline and through /Properties. */
export async function actualTextPdf() {
  const content = [
    "/Span << /ActualText (ACTUAL-SECRET-8830) >> BDC BT /F1 12 Tf 72 700 Td (shown glyphs differ) Tj ET EMC",
    "/Span /MC0 BDC BT /F1 12 Tf 72 680 Td (second shown span) Tj ET EMC",
    "/Span << /ActualText (KEPT-ACTUAL-1207) >> BDC BT /F1 12 Tf 72 660 Td (untouched span) Tj ET EMC",
    "BT /F1 12 Tf 72 640 Td (plain neighbour line) Tj ET"
  ].join("\n");
  const { bytes } = await makePdf([{ content, resources: { Properties: { MC0: { ActualText: S("ACTUAL-PROPS-6612") } } } }]);
  return { bytes, targets: ["glyphs", "second shown span"], gone: ["glyphs", "second shown span"], goneRaw: ["ACTUAL-SECRET-8830", "ACTUAL-PROPS-6612"], keptRaw: ["KEPT-ACTUAL-1207"], kept: ["shown", "differ", "untouched span", "plain neighbour line"] };
}

/** A line in text rendering mode 3 (as an OCR layer writes it) between two visible lines. */
export async function invisibleTextPdf() {
  const content = "BT /F1 12 Tf 72 700 Td (visible heading line) Tj ET BT 3 Tr /F1 12 Tf 72 660 Td (INVISIBLE-SECRET-5521 hidden) Tj ET BT 0 Tr /F1 12 Tf 72 620 Td (visible footer line) Tj ET";
  const { bytes } = await makePdf([{ content }]);
  return { bytes, secret: "INVISIBLE-SECRET-5521 hidden", kept: ["visible heading line", "visible footer line"] };
}

/**
 * Two pages with annotations and an AcroForm: a note and two widgets under the marks of page 1, a link and a
 * field elsewhere, and one field ("contractNo") with a widget on each page.
 */
export async function annotatedFormPdf({ xfa = false } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([612, 792]);
  const page2 = doc.addPage([612, 792]);
  page1.drawText("Annotated line ANNOT-PAGE-TEXT here", { x: 72, y: 700, size: 12, font: helvetica });
  page1.drawText("kept text far below", { x: 72, y: 500, size: 12, font: helvetica });
  page2.drawText("second page text", { x: 72, y: 740, size: 12, font: helvetica });
  const form = doc.getForm();
  const fullName = form.createTextField("fullName");
  fullName.setText("FIELD-VALUE-7731");
  fullName.addToPage(page1, { x: 72, y: 660, width: 228, height: 24, font: helvetica });
  const keptField = form.createTextField("keptField");
  keptField.setText("KEPT-FIELD-VALUE");
  keptField.addToPage(page1, { x: 72, y: 300, width: 228, height: 24, font: helvetica });
  const contract = form.createTextField("contractNo");
  contract.setText("CONTRACT-VALUE-42");
  contract.addToPage(page1, { x: 320, y: 660, width: 200, height: 24, font: helvetica });
  contract.addToPage(page2, { x: 72, y: 700, width: 200, height: 24, font: helvetica });
  const annots = page1.node.Annots();
  annots.push(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [100, 690, 120, 710], Contents: S("NOTE-SECRET-A1") })));
  annots.push(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 495, 200, 512], A: { S: "URI", URI: S("https://kept.example.test/") } })));
  if (xfa) {
    form.acroForm.dict.set(PDFName.of("XFA"), ctx.register(ctx.stream(bytesOf("<xfa>XFA-COPY-OF-VALUES FIELD-VALUE-7731</xfa>"))));
    doc.preserveXFA = true; // the library deletes XFA data on save otherwise
  }
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  return {
    bytes,
    targets: [[70, 688, 400, 714], [70, 656, 530, 688]],
    secret: "ANNOT-PAGE-TEXT",
    goneRaw: ["NOTE-SECRET-A1", "FIELD-VALUE-7731", "CONTRACT-VALUE-42"],
    keptRaw: ["https://kept.example.test/", "KEPT-FIELD-VALUE"],
    kept: ["kept text far below"]
  };
}

/** A picture with a caption drawn over it, and text above and below the picture ({ caption: false }: without the caption). */
export async function pictureUnderMarkPdf({ caption = true } = {}) {
  const width = 64;
  const height = 16;
  const pixels = Uint8Array.from({ length: width * height }, (_, i) => 150 + ((i % width) + Math.floor(i / width) * 3) % 90);
  const content = [
    "BT /F1 12 Tf 72 720 Td (text above the picture stays) Tj ET",
    "q 300 0 0 60 72 600 cm /Im Do Q",
    caption ? "BT /F1 14 Tf 90 625 Td (PICTURE-CAPTION-SECRET 77) Tj ET" : "",
    "BT /F1 12 Tf 72 420 Td (text far below stays too) Tj ET"
  ].join("\n");
  const image = (ctx) => ctx.register(ctx.stream(pixels, { Type: "XObject", Subtype: "Image", Width: width, Height: height, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
  const { bytes } = await makePdf([{ content, resources: (ctx, refs, fonts) => ({ Font: fonts, XObject: { Im: image(ctx) } }) }]);
  return { bytes, target: "CAPTION-SECRET", secret: "CAPTION-SECRET", whole: "PICTURE-CAPTION-SECRET", kept: ["text above the picture stays", "text far below stays too"], picture: [72, 600, 372, 660] };
}

/** Appends an incremental update (classic cross-reference section) that redefines objects. */
export function appendRevision(bytes, objects) {
  const text = latin1(bytes);
  const previous = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)[1]);
  const trailer = text.slice(text.lastIndexOf("trailer"));
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(trailer)[1];
  const info = /\/Info\s+(\d+\s+\d+\s+R)/.exec(trailer)?.[1];
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)[1]);
  let out = text.endsWith("\n") ? text : `${text}\n`;
  const offsets = [];
  for (const object of objects) {
    offsets.push([object.objectNumber, out.length]);
    out += `${object.objectNumber} 0 obj\n${object.body}\nendobj\n`;
  }
  const xref = out.length;
  out += "xref\n";
  for (const [number, offset] of offsets) out += `${number} 1\n${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${size} /Root ${root}${info ? ` /Info ${info}` : ""} /Prev ${previous} >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytesOf(out);
}

/** Two revisions in one file: the second replaces the content stream, the first is still in the bytes. */
export async function supersededRevisionPdf() {
  const { bytes: first, refs } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (OLD-REVISION-SECRET 778 price) Tj ET" }]);
  const stream = "BT /F1 12 Tf 72 700 Td (New visible price REV-NEW-991) Tj 0 -30 Td (revision two kept line) Tj ET";
  const bytes = appendRevision(first, [{ objectNumber: refs.contents[0][0].objectNumber, body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` }]);
  return { bytes, secret: "REV-NEW-991", superseded: "OLD-REVISION-SECRET", kept: ["New visible price", "revision two kept line"] };
}

/** A non-embedded CID font with a predefined CMap the remover cannot measure (Shift-JIS), and plain text. */
export async function unmeasurablePdf() {
  const sjis = { Type: "Font", Subtype: "Type0", BaseFont: "MS-Gothic", Encoding: "90ms-RKSJ-H", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType2", BaseFont: "MS-Gothic", DW: 1000, W: [231, 389, 500], CIDSystemInfo: { Registry: S("Adobe"), Ordering: S("Japan1"), Supplement: 2 } }] };
  const content = "BT /J 12 Tf 72 700 Td <82A082A282A482A6> Tj ET BT /F1 12 Tf 72 600 Td (MEASURABLE-LINE-6034 here) Tj 0 -40 Td (another plain line) Tj ET";
  const { bytes } = await makePdf([{ content, resources: (ctx, refs, fonts) => ({ Font: { ...fonts, J: ctx.register(ctx.obj(sjis)) } }) }]);
  return { bytes, unmeasurableRect: [70, 696, 140, 714], secret: "MEASURABLE-LINE-6034", kept: ["another plain line"] };
}

/** A content stream stored with a PNG predictor: pdf.js reads it, the library's decoder does not. */
export async function predictorStreamPdf() {
  const columns = 16;
  let text = "BT /F1 12 Tf 72 700 Td (PREDICTOR-STREAM-TEXT 31) Tj ET";
  text += " ".repeat((columns - (text.length % columns)) % columns);
  const raw = bytesOf(text);
  const rows = raw.length / columns;
  const filtered = new Uint8Array(rows * (columns + 1));
  for (let row = 0; row < rows; row++) {
    filtered[row * (columns + 1)] = 2; // PNG filter "Up"
    for (let x = 0; x < columns; x++) filtered[row * (columns + 1) + 1 + x] = (raw[row * columns + x] - (row ? raw[(row - 1) * columns + x] : 0)) & 0xff;
  }
  const data = new Uint8Array(zlib.deflateSync(filtered));
  const { bytes } = await makePdf([{ content: "BT ET" }], {
    setup: (doc) => {
      const stream = pdfLib.PDFRawStream.of(doc.context.obj({ Filter: "FlateDecode", DecodeParms: { Predictor: 12, Columns: columns } }), data);
      doc.getPage(0).node.set(PDFName.of("Contents"), doc.context.register(stream));
    }
  });
  return { bytes, secret: "PREDICTOR-STREAM-TEXT" };
}

/**
 * A tagged page: two paragraphs with marked-content ids, a structure tree whose elements repeat the text in
 * /ActualText, /Alt, /E and /T, and a Form XObject the tree points to through /Stm.
 *   chapterTitle   adds a "Chapter" element around the section whose /T is this text (as writers do that copy
 *                  the heading of a chapter into the title of its element), and an element without content
 *                  whose /Alt is the same text
 */
export async function taggedPdf({ chapterTitle } = {}) {
  const content = [
    "/P << /MCID 0 >> BDC BT /F1 12 Tf 72 700 Td (first tagged paragraph TAG-SECRET-1) Tj ET EMC",
    "/P << /MCID 1 >> BDC BT /F1 12 Tf 72 680 Td (second tagged paragraph) Tj ET EMC",
    "/Figure << /MCID 2 >> BDC q 1 0 0 1 72 600 cm /Fm Do Q EMC"
  ].join("\n");
  const form = formXObject("/P << /MCID 0 >> BDC BT /F1 12 Tf 0 0 Td (FORM-TAGGED-TEXT 88) Tj ET EMC", { StructParents: 1 });
  const { bytes } = await makePdf([{ content, resources: (ctx, refs, fonts) => ({ Font: fonts, XObject: { Fm: refs.Fm } }), extra: { StructParents: 0 } }], {
    objects: { Fm: form },
    setup: (doc, refs) => {
      const ctx = doc.context;
      const pageRef = doc.getPage(0).ref;
      const root = ctx.nextRef();
      const sect = ctx.nextRef();
      const p0 = ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: sect, Pg: pageRef, K: 0, ActualText: S("STRUCT-ACTUAL-ZERO"), Alt: S("STRUCT-ALT-ZERO"), T: S("STRUCT-TITLE-ZERO") }));
      const p1 = ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: sect, Pg: pageRef, K: 1, ActualText: S("STRUCT-ACTUAL-ONE") }));
      const figure = ctx.nextRef();
      const inForm = ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: figure, Pg: pageRef, K: { Type: "MCR", Pg: pageRef, Stm: refs.Fm, MCID: 0 }, ActualText: S("STRUCT-ACTUAL-FORM") }));
      ctx.assign(figure, ctx.obj({ Type: "StructElem", S: "Figure", P: sect, Pg: pageRef, K: [2, inForm] }));
      let top = sect;
      let sectParent = root;
      if (chapterTitle) {
        const chapter = ctx.nextRef();
        const aside = ctx.register(ctx.obj({ Type: "StructElem", S: "Note", P: chapter, Alt: S(`see: ${chapterTitle}`), T: S("NOTE-TITLE-KEPT") }));
        ctx.assign(chapter, ctx.obj({ Type: "StructElem", S: "Chapter", P: root, K: [sect, aside], T: S(chapterTitle) }));
        top = chapter;
        sectParent = chapter;
      }
      ctx.assign(sect, ctx.obj({ Type: "StructElem", S: "Sect", P: sectParent, K: [p0, p1, figure], E: S("SECTION-EXPANSION"), T: S("SECTION-TITLE-KEPT") }));
      ctx.assign(root, ctx.obj({ Type: "StructTreeRoot", K: top, ParentTree: { Nums: [0, [p0, p1, figure], 1, [inForm]] } }));
      doc.catalog.set(PDFName.of("StructTreeRoot"), root);
      doc.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
    }
  });
  return { bytes };
}

/**
 * A Form XObject (with /Matrix) drawn twice on page 1 (once scaled 1.25), once on page 2, and inside another
 * form on page 3; every page lists both forms in its own resources and draws a line of its own.
 */
export async function formUsesPdf() {
  const fm1 = formXObject("BT /F1 11 Tf 0 14 Td (XOBJ-SHARED-TEXT stamp 4471) Tj 0 -14 Td (Approved by: Le Thi Thu Ha) Tj ET", { Matrix: [1, 0, 0, 1, 10, 5], BBox: [0, 0, 300, 40] });
  const fm2 = (ctx, refs, fonts) => ctx.register(ctx.stream(bytesOf("BT /F1 10 Tf 0 50 Td (XOBJ-NESTED-OUTER wrapper 9925) Tj ET q 1 0 0 1 16 0 cm /Inner Do Q"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 80], Resources: { Font: fonts, XObject: { Inner: refs.Fm1 } } }));
  const resources = (ctx, refs, fonts) => ({ Font: fonts, XObject: { Fm1: refs.Fm1, Fm2: refs.Fm2 } });
  const pages = [
    "BT /F1 12 Tf 60 700 Td (MARKER-XOBJ-P1 text drawn directly) Tj ET q 1 0 0 1 66 600 cm /Fm1 Do Q q 1.25 0 0 1.25 66 500 cm /Fm1 Do Q",
    "BT /F1 12 Tf 60 700 Td (MARKER-XOBJ-P2 text drawn directly) Tj ET q 1 0 0 1 66 580 cm /Fm1 Do Q",
    "BT /F1 12 Tf 60 700 Td (MARKER-XOBJ-P3 text drawn directly) Tj ET q 1 0 0 1 66 530 cm /Fm2 Do Q"
  ];
  const { bytes } = await makePdf(pages.map((content) => ({ content, resources })), { objects: { Fm1: fm1, Fm2: fm2 } });
  return { bytes, shared: "XOBJ-SHARED-TEXT stamp 4471", approved: "Approved by: Le Thi Thu Ha" };
}

/** Pages whose content leaves the graphics state dirty: a flipped CTM, an unclosed q over three streams, a stray Q. */
export async function dirtyCtmPdf() {
  const { bytes } = await makePdf([
    { content: "1 0 0 -1 0 792 cm BT /F1 12 Tf 1 0 0 -1 72 100 Tm (flipped page text DIRTY-ONE here) Tj ET" },
    { content: ["q 0.5 0 0 0.5 0 0 cm BT /F1 24 Tf 144 1400 Td", "(half scale DIRTY-TWO text) Tj ET", "BT /F1 24 Tf 144 1300 Td (second stream text) Tj ET"] },
    { content: "Q 0.9659 0.2588 -0.2588 0.9659 100 50 cm BT /F1 12 Tf 72 600 Td (rotated after a stray Q DIRTY-THREE) Tj ET" }
  ]);
  return { bytes };
}

/** One page that uses every text operator, several string syntaxes and awkward text matrices. */
export async function textOpsPdf() {
  const content = [
    "BT /F1 11 Tf 13 TL 60 760 Td (Td line one two three four) Tj",
    "T* (T-star line alpha beta gamma) Tj",
    "0 -13 TD (TD line sets leading red green blue) Tj",
    "(quote line moves down five six seven) '",
    "2 0.5 (double quote spacing eight nine ten) \"",
    "0 Tw 0 Tc",
    "1 0 0 1 60 680 Tm [(TJ ) -50 (array ) 30 (kerned words ) -20 (here now)] TJ",
    "/F2 11 Tf 1 0 0 1 60 660 Tm <48657820737472696E6720776F726473206865726520746F6F> Tj",
    "/F3 10 Tf 1 0 0 1 60 640 Tm (Courier \\(escaped\\) parens \\101\\102\\103 octal words) Tj",
    "/F1 11 Tf 120 Tz 1 0 0 1 60 620 Tm (horizontal scaling wide words here) Tj 100 Tz",
    "3 Ts 1 0 0 1 60 600 Tm (text rise raised words here) Tj 0 Ts",
    "1.5 Tc 1 0 0 1 60 580 Tm (char spacing spread words) Tj 0 Tc",
    "4 Tw 1 0 0 1 60 560 Tm (word spacing wide gaps here) Tj 0 Tw",
    "0.866 0.5 -0.5 0.866 300 400 Tm (rotated thirty degrees words here) Tj",
    "1 0 0.3 1 60 520 Tm (sheared matrix italic words here) Tj",
    "2 0 0 2 60 480 Tm (scaled matrix big words) Tj",
    "1 Tr 1 0 0 1 60 450 Tm (stroke mode outline words here) Tj 0 Tr",
    "ET",
    "q 0.8 0 0 0.8 30 20 cm BT /F1 12 Tf 60 500 Td (inside a scaled q block words) Tj ET Q",
    "BT /F1 12 Tf 60 340 Td (last plain line of the page) Tj ET"
  ].join("\n");
  const { bytes } = await makePdf([{ content }]);
  return { bytes };
}

export { PDFHexString, S };
