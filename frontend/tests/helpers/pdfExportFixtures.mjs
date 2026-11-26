// Fixtures of the export engine's tests (tests/pdfExport*.test.mjs). Everything is generated here with the
// editor's own PDF library and the bundled fonts: no third-party file, no canvas needed.
//
//   buildLinkedFixture()        4 pages tied together by every kind of cross-page reference the format has
//   buildGeometryFixture()      16 pages: /Rotate 0 / 90 / 180 / 270 x plain, CropBox, shifted MediaBox, UserUnit
//   buildSharedResourcesFixture()  pages that share ONE resource dictionary listing everybody's pictures
//   buildGlobalResourcesFixture()  the same dictionary also on patterns, a Type3 font, a soft mask, appearances
//   buildEncryptedFixture()     AES-256 encrypted, written by the library itself
//   rawPdf() / streamBody()     hand-written files (full control over the bytes) for parser edge cases
//   rawPdfWithTable() / appendRevision() / rawPdfWithObjectStreams() / rawHybridPdf()
//                               hand-written files in which the caller decides what the cross-reference
//                               information says (a viewer reads through it, the writing library does not)
//   makeTextObject()            a text object with a TextLayout computed from the font's own advances
//   SAMPLE_JPEG / SAMPLE_PNG    a 32 x 16 picture: red | green over blue | yellow; withExifOrientation()
import { fontBytes, fontkit, pdfLib } from "./pdfTestKit.mjs";
import { pdfFontFeatures } from "../../src/pages/pdfEditor/engine/textRules.js";
import { fontKeyOf } from "../../src/pages/pdfEditor/model/schema.js";

const { PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFNull, degrees } = pdfLib;
const N = (name) => PDFName.of(name);
const str = (value) => PDFString.of(value);
const text16 = (value) => PDFHexString.fromText(value);

// ---------------------------------------------------------------------------------------------------
// pictures
// ---------------------------------------------------------------------------------------------------

/** 32 x 16 pixels, stored rows: [red | green] over [blue | yellow] (made once with a canvas, kept as text). */
export const SAMPLE_JPEG = Uint8Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAQACADASIAAhEBAxEB/8QAGAABAAMBAAAAAAAAAAAAAAAAAAQGBwj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAABwYI/8QAGhEAAgMBAQAAAAAAAAAAAAAAAKMXZeMYZP/aAAwDAQACEQMRAD8Ax8Sxf892KdRB6hqn4loHcoxBL3jZmDsC2CtT/9k=",
  "base64"
));

/** The same picture as a PNG. */
export const SAMPLE_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAYAAAB3AH1ZAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAA5SURBVEiJY7yjpvafgQJgVatCiXYGJop0UwGMOmDUAaMOYPG0PUqRAU80tSjSP+AhMOqAUQeMOgAAXtIFpq1cz60AAAAASUVORK5CYII=",
  "base64"
));

/** The colours of SAMPLE_JPEG / SAMPLE_PNG by stored quadrant. */
export const SAMPLE_COLORS = Object.freeze({ topLeft: [220, 38, 38], topRight: [22, 163, 74], bottomLeft: [37, 99, 235], bottomRight: [250, 204, 21] });

/** A copy of a JPEG with an EXIF segment that says `orientation` (1..8). */
export function withExifOrientation(jpeg, orientation) {
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // "II", 42, offset of the first directory
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // 0x0112 SHORT x 1
    0x00, 0x00, 0x00, 0x00 // no next directory
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
  const segment = [0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload];
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0); // SOI
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// hand-written PDF files
// ---------------------------------------------------------------------------------------------------

const latin1 = (value) => Buffer.from(value, "latin1");

/**
 * @param {Array<{ num: number, body: string | Buffer }>} objects  body = everything between "N 0 obj\n" and "\nendobj"
 * @param {{ root?: string, info?: string, header?: string, trailerExtra?: string }} [options]
 * @returns {Uint8Array}
 */
export function rawPdf(objects, { root = "1 0 R", info, header = "%PDF-1.7", trailerExtra = "" } = {}) {
  const chunks = [latin1(`${header}\n%${String.fromCharCode(0xe2, 0xe3, 0xcf, 0xd3)}\n`)];
  let offset = chunks[0].length;
  const offsets = new Map();
  for (const { num, body } of objects) {
    offsets.set(num, offset);
    for (const part of [latin1(`${num} 0 obj\n`), Buffer.isBuffer(body) ? body : latin1(body), latin1("\nendobj\n")]) {
      chunks.push(part);
      offset += part.length;
    }
  }
  const max = Math.max(...objects.map((object) => object.num));
  let xref = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= max; num += 1) {
    xref += offsets.has(num) ? `${String(offsets.get(num)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
  }
  chunks.push(latin1(`${xref}trailer\n<< /Size ${max + 1} /Root ${root}${info ? ` /Info ${info}` : ""}${trailerExtra} >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

/** A stream object body: dictionary entries (without /Length unless given) + data. */
export function streamBody(dictEntries, data, { length, eolBeforeEndstream = "\n" } = {}) {
  const buffer = Buffer.isBuffer(data) ? data : latin1(data);
  const lengthEntry = length === undefined ? `/Length ${buffer.length}` : length;
  return Buffer.concat([latin1(`<< ${dictEntries} ${lengthEntry} >>\nstream\n`), buffer, latin1(`${eolBeforeEndstream}endstream`)]);
}

/** Catalog (1), page tree (2) and a Helvetica font (3) for the given page object numbers. */
export function skeleton(pageNums, { catalogExtra = "", catalogType = "/Type /Catalog" } = {}) {
  return [
    { num: 1, body: `<< ${catalogType} /Pages 2 0 R ${catalogExtra} >>` },
    { num: 2, body: `<< /Type /Pages /Kids [${pageNums.map((num) => `${num} 0 R`).join(" ")}] /Count ${pageNums.length} >>` },
    { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" }
  ];
}

/** A page object body of a rawPdf(): 300 x 200, font /F1 = object 3, one content stream. */
export const rawPage = (contentNum, { type = "/Type /Page", extra = "" } = {}) => `<< ${type} /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R ${extra} >>`;

/** A one-page file whose content stream has an INDIRECT /Length (object 6) and the given data. */
export function rawPdfWithIndirectLength(data, options = {}) {
  return rawPdf([
    ...skeleton([4]),
    { num: 4, body: rawPage(5) },
    { num: 5, body: streamBody("", data, { length: "/Length 6 0 R", ...options }) },
    { num: 6, body: String(options.declared ?? Buffer.byteLength(data, "latin1")) }
  ]);
}

// ---------------------------------------------------------------------------------------------------
// the linked fixture
// ---------------------------------------------------------------------------------------------------

export const MARKERS = Object.freeze({
  page: ["XREF-P1-MARKER", "XREF-P2-SECRET", "XREF-P3-MARKER", "XREF-P4-MARKER"],
  header: "XREF-SHARED-HEADER",
  hiddenLayer: "XREF-P3-HIDDEN-LAYER",
  formOnly1: "FORMVALUE-P1",
  formSecret2: "FORMVALUE-P2-SECRET",
  formShared: "FORMVALUE-SHARED",
  formChild1: "GROUPCHILD1-VALUE",
  formChild2: "GROUPCHILD2-VALUE",
  xfa: "XFA-DATA-MARKER",
  structActualTextP2: "STRUCT-ACTUALTEXT-P2",
  structAltP1: "STRUCT-ALT-P1",
  thumb: "THUMB-P1-MARKER",
  pieceInfo: "PIECEINFO-P1-PRIVATE",
  pageMetadata: "PAGEMETA-P1-XMP",
  pageAA: "AA-P1-JS",
  popupText: "POPUP-NOTE-P1",
  attachment: "ATTACHMENT-CONTENT-DOC",
  xmpTitle: "XMP-TITLE-MARKER",
  infoTitle: "Tài liệu thử nghiệm XREF",
  infoAuthor: "Nguyễn Văn An",
  outlineP2Title: "Mục 1.1 — Trang hai"
});

/** Everything that belongs to page index i only: none of it may survive when page i is not kept. */
export function secretsOfPage(pageIndex) {
  const secrets = [MARKERS.page[pageIndex]];
  if (pageIndex === 0) secrets.push(MARKERS.formOnly1, MARKERS.formChild1, MARKERS.thumb, MARKERS.pieceInfo, MARKERS.pageMetadata, MARKERS.pageAA, MARKERS.popupText, MARKERS.structAltP1);
  if (pageIndex === 1) secrets.push(MARKERS.formSecret2, MARKERS.formChild2, MARKERS.structActualTextP2, MARKERS.outlineP2Title);
  if (pageIndex === 2) secrets.push(MARKERS.hiddenLayer);
  return secrets;
}

/** Deterministic noise: `length` bytes that look like nothing else in a file (a picture's "pixels"). */
export function noiseBytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

/**
 * A 4-page document (400 x 300 pt each) in which every page is tied to the others:
 *   page 1  "XREF-P1-MARKER"   links to pages 2, 3, 4 (explicit, action, named string, named name, named action,
 *                              structure destination), a URI link, thumbnail, PieceInfo, page XMP, /AA script,
 *                              Text + Popup annotation, form widgets
 *   page 2  "XREF-P2-SECRET"   a picture; form field `secret2`; second widget of `shared`; /ActualText
 *   page 3  "XREF-P3-MARKER"   text in an optional-content group that is OFF; link back to page 1
 *   page 4  "XREF-P4-MARKER"   own resources; shares a header content stream with page 1; link to page 3
 * plus an outline, article thread, structure tree, page labels (i, ii, A-1, A-2), attachment, viewer
 * preferences, XMP, /OpenAction, and /Resources that pages 1 - 3 inherit from the page tree.
 * @returns {Promise<{ bytes: Uint8Array, imageSignature: Buffer }>}
 */
export async function buildLinkedFixture({ useObjectStreams = false } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;

  doc.setTitle(MARKERS.infoTitle);
  doc.setAuthor(MARKERS.infoAuthor);
  doc.setSubject("cross-page reference fixture");
  doc.setKeywords(["export", "fixture"]);
  doc.setCreator("tests/helpers/pdfExportFixtures.mjs");
  doc.setProducer("fixture");
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 15, 3, 0, 0)));
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 15, 3, 0, 0)));

  const fontRef = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const pages = [0, 1, 2, 3].map(() => doc.addPage([400, 300]));
  const refs = pages.map((page) => page.ref);
  const pagesNode = doc.catalog.Pages();

  // ---- resources: pages 1 - 3 inherit one dictionary from the page tree ---------------------------
  const sharedResRef = ctx.register(ctx.obj({ Font: { F1: fontRef } }));
  for (let index = 0; index < 4; index += 1) {
    pages[index].node.delete(N("Resources"));
    if (index === 3) pages[index].node.set(N("Resources"), ctx.obj({ Font: { F1: fontRef } }));
  }
  pagesNode.set(N("Resources"), sharedResRef);

  // ---- content --------------------------------------------------------------------------------------
  const headerRef = ctx.register(ctx.stream(`BT /F1 9 Tf 30 280 Td (${MARKERS.header}) Tj ET\n`));
  for (let index = 0; index < 4; index += 1) {
    let body = `BT /F1 16 Tf 30 240 Td (${MARKERS.page[index]}) Tj ET\n0.9 0.9 0.6 rg 30 ${180 - index * 10} 120 20 re f\n`;
    if (index === 1) body += "q 160 0 0 100 200 60 cm /Im1 Do Q\n";
    if (index === 2) body += `/OC /OC1 BDC BT /F1 12 Tf 30 120 Td (${MARKERS.hiddenLayer}) Tj ET EMC\n`;
    if (index < 2) body = `/P << /MCID 0 >> BDC\n${body}EMC\n`;
    const own = ctx.register(ctx.stream(body));
    pages[index].node.set(N("Contents"), index === 0 || index === 3 ? ctx.obj([headerRef, own]) : own);
  }

  // a picture on page 2: raw RGB samples, stored as they are, so that its bytes can be searched for
  const pixels = noiseBytes(16 * 10 * 3, 20261116);
  const imageSignature = Buffer.from(pixels.slice(200, 232));
  const imageRef = ctx.register(ctx.stream(pixels, { Type: "XObject", Subtype: "Image", Width: 16, Height: 10, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  pages[1].node.set(N("Resources"), ctx.obj({ Font: { F1: fontRef }, XObject: { Im1: imageRef } }));

  // ---- optional content: a layer that is OFF --------------------------------------------------------
  const ocgRef = ctx.register(ctx.obj({ Type: "OCG", Name: str("Hidden layer") }));
  pages[2].node.set(N("Resources"), ctx.obj({ Font: { F1: fontRef }, Properties: { OC1: ocgRef } }));
  doc.catalog.set(N("OCProperties"), ctx.obj({ OCGs: [ocgRef], D: { Name: str("Default"), OFF: [ocgRef], Order: [ocgRef], BaseState: "ON" } }));

  // ---- annotations ------------------------------------------------------------------------------------
  const annots = [[], [], [], []];
  const link = (pageIndex, rect, extra) => {
    const ref = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], P: refs[pageIndex], ...extra }));
    annots[pageIndex].push(ref);
    return ref;
  };
  link(0, [30, 200, 90, 215], { Dest: [refs[1], "Fit"] });
  link(0, [100, 200, 160, 215], { A: { S: "GoTo", D: [refs[2], "XYZ", 0, 300, 0] } });
  link(0, [170, 200, 230, 215], { Dest: str("named-p3") });
  link(0, [240, 200, 300, 215], { Dest: N("NamedP4") });
  link(0, [310, 200, 370, 215], { A: { S: "GoTo", D: str("named-p2") } });
  link(0, [30, 150, 90, 165], { A: { S: "URI", URI: str("https://example.test/xref") } });
  link(2, [30, 200, 90, 215], { Dest: [refs[0], "Fit"] });
  link(3, [30, 200, 90, 215], { Dest: [refs[2], "FitH", 250] });
  const noteDict = ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [340, 250, 360, 270], Contents: str(MARKERS.popupText), T: str("An"), P: refs[0], Name: "Comment" });
  const noteRef = ctx.register(noteDict);
  const popupRef = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [200, 100, 380, 180], Parent: noteRef, Open: false, P: refs[0] }));
  noteDict.set(N("Popup"), popupRef);
  annots[0].push(noteRef, popupRef);

  // ---- AcroForm: only1 (P1), secret2 (P2), shared (P1 + P2), group.child1 (P1) / group.child2 (P2), XFA ----
  const helvRef = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const appearance = (value) => ctx.register(ctx.stream(`/Tx BMC q BT /Helv 10 Tf 2 5 Td (${value}) Tj ET Q EMC`, {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 150, 18], Resources: { Font: { Helv: helvRef } }
  }));
  const widget = (pageIndex, rect, value, extra) => {
    const dict = ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: rect, P: refs[pageIndex], F: 4, DA: str("/Helv 10 Tf 0 g"), AP: { N: appearance(value) }, ...extra });
    const ref = ctx.register(dict);
    annots[pageIndex].push(ref);
    return ref;
  };
  const only1 = widget(0, [30, 100, 180, 118], MARKERS.formOnly1, { FT: "Tx", T: str("only1"), V: str(MARKERS.formOnly1) });
  const secret2 = widget(1, [30, 100, 180, 118], MARKERS.formSecret2, { FT: "Tx", T: str("secret2"), V: str(MARKERS.formSecret2) });
  const sharedParent = ctx.obj({ FT: "Tx", T: str("shared"), V: str(MARKERS.formShared), DA: str("/Helv 10 Tf 0 g") });
  const sharedRef = ctx.register(sharedParent);
  sharedParent.set(N("Kids"), ctx.obj([
    widget(0, [200, 100, 350, 118], MARKERS.formShared, { Parent: sharedRef }),
    widget(1, [200, 30, 350, 48], MARKERS.formShared, { Parent: sharedRef })
  ]));
  const group = ctx.obj({ T: str("group") });
  const groupRef = ctx.register(group);
  group.set(N("Kids"), ctx.obj([
    widget(0, [30, 70, 180, 88], MARKERS.formChild1, { FT: "Tx", T: str("child1"), V: str(MARKERS.formChild1), Parent: groupRef }),
    widget(1, [30, 60, 180, 78], MARKERS.formChild2, { FT: "Tx", T: str("child2"), V: str(MARKERS.formChild2), Parent: groupRef })
  ]));
  const xfaRef = ctx.register(ctx.stream(`<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><data>${MARKERS.xfa}</data></xdp:xdp>`));
  doc.catalog.set(N("AcroForm"), ctx.register(ctx.obj({
    Fields: [only1, secret2, sharedRef, groupRef],
    DA: str("/Helv 10 Tf 0 g"),
    DR: { Font: { Helv: helvRef } },
    NeedAppearances: false,
    CO: [secret2, only1],
    XFA: xfaRef
  })));

  // ---- article thread P1 <-> P2 -------------------------------------------------------------------------
  const thread = ctx.obj({ Type: "Thread", I: { Title: str("Thread one") } });
  const threadRef = ctx.register(thread);
  const bead1 = ctx.obj({ Type: "Bead", T: threadRef, P: refs[0], R: [30, 30, 370, 270] });
  const bead2 = ctx.obj({ Type: "Bead", T: threadRef, P: refs[1], R: [30, 30, 370, 270] });
  const bead1Ref = ctx.register(bead1);
  const bead2Ref = ctx.register(bead2);
  bead1.set(N("N"), bead2Ref);
  bead1.set(N("V"), bead2Ref);
  bead2.set(N("N"), bead1Ref);
  bead2.set(N("V"), bead1Ref);
  thread.set(N("F"), bead1Ref);
  pages[0].node.set(N("B"), ctx.obj([bead1Ref]));
  pages[1].node.set(N("B"), ctx.obj([bead2Ref]));
  doc.catalog.set(N("Threads"), ctx.register(ctx.obj([threadRef])));

  // ---- structure tree with /ActualText, /Alt, an OBJR and a PDF 2.0 structure destination --------------
  const structRoot = ctx.obj({ Type: "StructTreeRoot" });
  const structRootRef = ctx.register(structRoot);
  const docElem = ctx.obj({ Type: "StructElem", S: "Document", P: structRootRef });
  const docElemRef = ctx.register(docElem);
  const elem1Ref = ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: docElemRef, Pg: refs[0], K: 0, Alt: str(MARKERS.structAltP1) }));
  const elem2 = ctx.obj({ Type: "StructElem", S: "P", P: docElemRef, Pg: refs[1], ActualText: str(MARKERS.structActualTextP2) });
  const elem2Ref = ctx.register(elem2);
  elem2.set(N("K"), ctx.obj([0, ctx.obj({ Type: "OBJR", Obj: annots[0][0], Pg: refs[0] })]));
  docElem.set(N("K"), ctx.obj([elem1Ref, elem2Ref]));
  structRoot.set(N("K"), ctx.obj([docElemRef]));
  structRoot.set(N("ParentTree"), ctx.register(ctx.obj({ Nums: [0, [elem1Ref], 1, [elem2Ref]] })));
  structRoot.set(N("ParentTreeNextKey"), PDFNumber.of(2));
  pages[0].node.set(N("StructParents"), PDFNumber.of(0));
  pages[1].node.set(N("StructParents"), PDFNumber.of(1));
  doc.catalog.set(N("StructTreeRoot"), structRootRef);
  doc.catalog.set(N("MarkInfo"), ctx.obj({ Marked: true }));
  link(0, [100, 150, 160, 165], { A: { S: "GoTo", D: [refs[0], "Fit"], SD: [elem2Ref, "Fit"] } });

  // ---- page-level baggage on page 1 ------------------------------------------------------------------
  pages[0].node.set(N("Thumb"), ctx.register(ctx.stream(new Uint8Array(12).fill(128), {
    Type: "XObject", Subtype: "Image", Width: 2, Height: 2, ColorSpace: "DeviceRGB", BitsPerComponent: 8, FixtureMarker: str(MARKERS.thumb)
  })));
  pages[0].node.set(N("PieceInfo"), ctx.obj({ FixtureApp: { LastModified: str("D:20260115030000Z"), Private: ctx.register(ctx.obj({ Secret: str(MARKERS.pieceInfo) })) } }));
  pages[0].node.set(N("Metadata"), ctx.register(ctx.stream(`<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><note>${MARKERS.pageMetadata}</note></x:xmpmeta><?xpacket end="w"?>`, { Type: "Metadata", Subtype: "XML" })));
  pages[0].node.set(N("AA"), ctx.obj({ O: { S: "JavaScript", JS: str(`app.alert("${MARKERS.pageAA}")`) } }));

  for (let index = 0; index < 4; index += 1) if (annots[index].length) pages[index].node.set(N("Annots"), ctx.obj(annots[index]));

  // ---- named destinations, attachment --------------------------------------------------------------------
  const names = ctx.obj({});
  names.set(N("Dests"), ctx.register(ctx.obj({ Names: [str("named-p2"), ctx.obj({ D: [refs[1], "Fit"] }), str("named-p3"), [refs[2], "XYZ", 10, 200, PDFNull]] })));
  doc.catalog.set(N("Dests"), ctx.register(ctx.obj({ NamedP4: [refs[3], "Fit"], NamedP2: [refs[1], "Fit"] })));
  const embedded = ctx.register(ctx.stream(MARKERS.attachment, { Type: "EmbeddedFile" }));
  names.set(N("EmbeddedFiles"), ctx.obj({
    Names: [str("note.txt"), ctx.register(ctx.obj({ Type: "Filespec", F: str("note.txt"), UF: text16("ghi chú.txt"), EF: { F: embedded }, Desc: str("a note") }))]
  }));
  doc.catalog.set(N("Names"), ctx.register(names));

  // ---- outline ---------------------------------------------------------------------------------------------
  const tree = [
    { title: str("Chapter 1 (PDFDocEncoding)"), extra: { Dest: [refs[0], "XYZ", 0, 300, 0] }, kids: [
      { title: text16(MARKERS.outlineP2Title), extra: { A: { S: "GoTo", D: [refs[1], "Fit"] } } },
      { title: str("Section 1.2 (named string)"), extra: { Dest: str("named-p3") } }
    ] },
    { title: str("Chapter 2 (named name)"), extra: { Dest: N("NamedP4"), C: [1, 0, 0], F: 2 }, kids: [
      { title: str("2.1 only page 4"), extra: { Dest: [refs[3], "FitH", 250] } }
    ] },
    { title: str("Website"), extra: { A: { S: "URI", URI: str("https://example.test/outline") } } },
    { title: text16("Đóng — closed parent"), closed: true, extra: { Dest: [refs[2], "Fit"] }, kids: [
      { title: str("to page 3"), extra: { Dest: [refs[2], "FitH", 100] } },
      { title: str("to page 1"), extra: { Dest: [refs[0], "Fit"] } }
    ] }
  ];
  const outlines = ctx.obj({ Type: "Outlines" });
  const outlinesRef = ctx.register(outlines);
  const build = (items, parentRef) => {
    const made = items.map((item) => {
      const dict = ctx.obj({ Title: item.title, Parent: parentRef, ...item.extra });
      return { item, dict, ref: ctx.register(dict) };
    });
    let visible = 0;
    made.forEach((node, index) => {
      if (index > 0) node.dict.set(N("Prev"), made[index - 1].ref);
      if (index < made.length - 1) node.dict.set(N("Next"), made[index + 1].ref);
      visible += 1;
      if (node.item.kids) {
        const sub = build(node.item.kids, node.ref);
        node.dict.set(N("First"), sub.first);
        node.dict.set(N("Last"), sub.last);
        node.dict.set(N("Count"), PDFNumber.of(node.item.closed ? -sub.count : sub.count));
        if (!node.item.closed) visible += sub.count;
      }
    });
    return { first: made[0].ref, last: made[made.length - 1].ref, count: visible };
  };
  const top = build(tree, outlinesRef);
  outlines.set(N("First"), top.first);
  outlines.set(N("Last"), top.last);
  outlines.set(N("Count"), PDFNumber.of(top.count));
  doc.catalog.set(N("Outlines"), outlinesRef);

  // ---- catalog odds and ends ---------------------------------------------------------------------------------
  doc.catalog.set(N("OpenAction"), ctx.obj([refs[1], "Fit"]));
  doc.catalog.set(N("PageLabels"), ctx.obj({ Nums: [0, { S: "r" }, 2, { S: "D", St: 1, P: str("A-") }] }));
  doc.catalog.set(N("ViewerPreferences"), ctx.obj({ DisplayDocTitle: true, Direction: "L2R" }));
  doc.catalog.set(N("PageLayout"), N("TwoColumnLeft"));
  doc.catalog.set(N("PageMode"), N("UseOutlines"));
  doc.catalog.set(N("Lang"), str("vi-VN"));
  doc.catalog.set(N("Metadata"), ctx.register(ctx.stream(
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${MARKERS.xmpTitle}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    { Type: "Metadata", Subtype: "XML" }
  )));

  const bytes = await doc.save({ useObjectStreams, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, imageSignature };
}

// ---------------------------------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------------------------------

export const GEOMETRY_SETUPS = Object.freeze([
  { name: "plain", media: [0, 0, 300, 220] },
  { name: "cropbox", media: [0, 0, 300, 220], crop: [40, 30, 260, 200] },
  { name: "shifted mediabox", media: [-100, 50, 200, 270] },
  { name: "crop + shift + user unit 2", media: [100, -40, 400, 180], crop: [130, -20, 380, 160], userUnit: 2 }
]);

/**
 * 16 pages: every setup above with /Rotate 0, 90, 180, 270. Each page carries one line of text along the
 * user-space x axis and a pale band, so that "nothing else changed" has something to compare.
 * @returns {Promise<{ bytes: Uint8Array, cases: Array<{ name: string, rotate: number, view: number[], userUnit: number }> }>}
 */
export async function buildGeometryFixture() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes("arimo-regular"), { subset: true });
  const cases = [];
  for (const setup of GEOMETRY_SETUPS) {
    for (const rotate of [0, 90, 180, 270]) {
      const [x0, y0, x1, y1] = setup.media;
      const page = doc.addPage([x1 - x0, y1 - y0]);
      page.node.set(N("MediaBox"), doc.context.obj(setup.media));
      if (setup.crop) page.node.set(N("CropBox"), doc.context.obj(setup.crop));
      if (setup.userUnit) page.node.set(N("UserUnit"), PDFNumber.of(setup.userUnit));
      if (rotate) page.setRotation(degrees(rotate));
      const view = setup.crop || setup.media;
      page.drawRectangle({ x: view[0] + 4, y: view[1] + 4, width: view[2] - view[0] - 8, height: 6, color: pdfLib.rgb(0.85, 0.92, 1) });
      page.drawText(`${setup.name} rotate ${rotate}`, { x: view[0] + 6, y: view[1] + 14, size: 5, font, color: pdfLib.rgb(0.45, 0.45, 0.45) });
      cases.push({ name: `${setup.name} /Rotate ${rotate}`, rotate, view, userUnit: setup.userUnit || 1 });
    }
  }
  return { bytes: await doc.save({ useObjectStreams: false }), cases };
}

// ---------------------------------------------------------------------------------------------------
// shared resources
// ---------------------------------------------------------------------------------------------------

export const SHARED_MARKERS = Object.freeze({
  page: ["SHARED-P1-TEXT", "SHARED-P2-TEXT", "SHARED-P3-TEXT"],
  form: ["FORMTEXT-OF-P1", "FORMTEXT-OF-P2-SECRET", "FORMTEXT-OF-P3"],
  nested: "NESTED-FORM-OF-P2-SECRET"
});

/**
 * Three pages that inherit ONE /Resources dictionary from the page tree. It lists the picture and the form
 * of every page (Im1..Im3, Fm1..Fm3); each page draws only its own. Fm2 uses a form of its own (FmN), and
 * the form Fm3 carries the shared dictionary itself as its /Resources.
 * @param {{ unreadablePage?: number }} [options]  give that page (0-based) a content stream no tool can decode
 * @returns {Promise<{ bytes: Uint8Array, signatures: Buffer[] }>}  signatures[i] = bytes of the picture of page i
 */
export async function buildSharedResourcesFixture({ unreadablePage } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const fontRef = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const pages = [0, 1, 2].map(() => doc.addPage([300, 200]));
  const signatures = [];
  const xobjects = ctx.obj({});
  const shared = ctx.obj({ Font: { F1: fontRef } });
  const sharedRef = ctx.register(shared);
  for (let index = 0; index < 3; index += 1) {
    const pixels = noiseBytes(12 * 8 * 3, 7000 + index);
    signatures.push(Buffer.from(pixels.slice(100, 132)));
    xobjects.set(N(`Im${index + 1}`), ctx.register(ctx.stream(pixels, { Type: "XObject", Subtype: "Image", Width: 12, Height: 8, ColorSpace: "DeviceRGB", BitsPerComponent: 8 })));
  }
  const nestedRef = ctx.register(ctx.stream(`BT /F1 8 Tf 0 0 Td (${SHARED_MARKERS.nested}) Tj ET`, {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 20], Resources: { Font: { F1: fontRef } }
  }));
  for (let index = 0; index < 3; index += 1) {
    const dict = { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 40] };
    // Fm1: no /Resources (it draws with the page's); Fm2: its own, with a nested form; Fm3: the shared dictionary
    if (index === 1) dict.Resources = { Font: { F1: fontRef }, XObject: { FmN: nestedRef } };
    if (index === 2) dict.Resources = sharedRef;
    const body = `BT /F1 9 Tf 0 20 Td (${SHARED_MARKERS.form[index]}) Tj ET${index === 1 ? " q 1 0 0 1 0 2 cm /FmN Do Q" : ""}`;
    xobjects.set(N(`Fm${index + 1}`), ctx.register(ctx.stream(body, dict)));
  }
  shared.set(N("XObject"), xobjects);
  doc.catalog.Pages().set(N("Resources"), sharedRef);
  pages.forEach((page, index) => {
    page.node.delete(N("Resources"));
    const body = `BT /F1 14 Tf 20 160 Td (${SHARED_MARKERS.page[index]}) Tj ET\nq 60 0 0 40 20 90 cm /Im${index + 1} Do Q\nq 1 0 0 1 20 40 cm /Fm${index + 1} Do Q\n`;
    if (index === unreadablePage) page.node.set(N("Contents"), ctx.register(ctx.stream(body, { Filter: "JBIG2Decode" })));
    else page.node.set(N("Contents"), ctx.register(ctx.stream(body)));
  });
  return { bytes: await doc.save({ useObjectStreams: false }), signatures };
}

export const GLOBAL_MARKERS = Object.freeze({
  page: ["GLOBAL-P1-TEXT", "GLOBAL-P2-SECRET", "GLOBAL-P3-TEXT"],
  formOfPage1: "GLOBAL-FORM-P1",
  formOfPage2: "GLOBAL-FORM-P2-SECRET",
  appearance: "GLOBAL-AP-P1",
  inner: "GLOBAL-INNER-P3",
  defaultResources: "GLOBAL-DR-FORM-SECRET"
});

/**
 * Three pages of a file with ONE resource dictionary for everything: the layout of the FPDF family of
 * generators, which write "/Resources 2 0 R" on every page (here also on everything else that can carry
 * resources: forms, patterns, a Type3 font, a soft mask, an appearance stream). The dictionary lists the
 * pictures I1..I3, the forms TP1 / TP2 / W3, the tiling patterns P1 / P2, a Type3 font T3 and a graphics state
 * G1 with a soft mask.
 *   page 1  draws I1, the form TP1 (no resources of its own), the pattern P1, the soft mask G1, and carries a
 *           stamp annotation whose appearance stream points at the same dictionary
 *   page 2  draws I2, the form TP2 and the pattern P2 (which paints I2 again)
 *   page 3  draws I3, a glyph of T3 and the form W3, whose PRIVATE resources name a form that points at the
 *           shared dictionary again
 * With `defaultResources` the form of the document (/AcroForm /DR) names the picture I2 and a form with text
 * as well, and page 1 gets a text field so that the form survives.
 * With `opaquePattern` the content of the pattern P1 cannot be decoded by anything.
 * @returns {Promise<{ bytes: Uint8Array, signatures: Buffer[] }>}  signatures[i] = bytes of the picture of page i
 */
export async function buildGlobalResourcesFixture({ defaultResources = false, opaquePattern = false } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const pages = [0, 1, 2].map(() => doc.addPage([300, 200]));
  const global = ctx.obj({});
  const globalRef = ctx.register(global);
  const helv = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const form = (body, extra = {}) => ctx.register(ctx.stream(body, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 40], ...extra }));
  const label = (value) => `BT /F1 9 Tf 0 20 Td (${value}) Tj ET`;

  const signatures = [];
  const xobjects = ctx.obj({});
  for (let index = 0; index < 3; index += 1) {
    const pixels = noiseBytes(12 * 8 * 3, 9000 + index);
    signatures.push(Buffer.from(pixels.slice(100, 132)));
    xobjects.set(N(`I${index + 1}`), ctx.register(ctx.stream(pixels, { Type: "XObject", Subtype: "Image", Width: 12, Height: 8, ColorSpace: "DeviceRGB", BitsPerComponent: 8 })));
  }
  xobjects.set(N("TP1"), form(label(GLOBAL_MARKERS.formOfPage1))); // draws with the page's resources
  xobjects.set(N("TP2"), form(label(GLOBAL_MARKERS.formOfPage2), { Resources: globalRef }));
  const inner = form(label(GLOBAL_MARKERS.inner), { Resources: globalRef });
  xobjects.set(N("W3"), form("q 1 0 0 1 0 0 cm /Inner Do Q", { Resources: { XObject: { Inner: inner } } }));

  const pattern = (body, extra = {}) => ctx.register(ctx.stream(body, {
    Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: globalRef, ...extra
  }));
  const type3 = ctx.register(ctx.obj({
    Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 500, 500], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: { sq: ctx.register(ctx.stream("600 0 0 0 500 500 d1 0 0 500 500 re f")) },
    Encoding: { Type: "Encoding", Differences: [97, "sq"] }, FirstChar: 97, LastChar: 97, Widths: [600], Resources: globalRef
  }));
  const maskGroup = form("0.6 g 0 0 300 200 re f", { BBox: [0, 0, 300, 200], Group: { S: "Transparency", CS: "DeviceGray" }, Resources: globalRef });

  global.set(N("Font"), ctx.obj({ F1: helv, T3: type3 }));
  global.set(N("XObject"), xobjects);
  global.set(N("Pattern"), ctx.obj({ P1: pattern("0.2 0.6 0.9 rg 0 0 5 5 re f", opaquePattern ? { Filter: "JBIG2Decode" } : {}), P2: pattern("q 10 0 0 10 0 0 cm /I2 Do Q") }));
  global.set(N("ExtGState"), ctx.obj({ G1: { Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: maskGroup } } }));

  const title = (index) => `BT /F1 14 Tf 20 170 Td (${GLOBAL_MARKERS.page[index]}) Tj ET\n`;
  const bodies = [
    `${title(0)}q 60 0 0 40 20 100 cm /I1 Do Q\n/Pattern cs /P1 scn 100 100 80 40 re f\nq /G1 gs 0 0 1 rg 200 100 60 40 re f Q\nq 1 0 0 1 20 40 cm /TP1 Do Q\n`,
    `${title(1)}q 60 0 0 40 20 100 cm /I2 Do Q\n/Pattern cs /P2 scn 100 100 80 40 re f\nq 1 0 0 1 20 40 cm /TP2 Do Q\n`,
    `${title(2)}q 60 0 0 40 20 100 cm /I3 Do Q\nBT /T3 30 Tf 200 120 Td (a) Tj ET\nq 1 0 0 1 20 40 cm /W3 Do Q\n`
  ];
  pages.forEach((page, index) => {
    page.node.set(N("Resources"), globalRef);
    page.node.set(N("Contents"), ctx.register(ctx.stream(bodies[index])));
  });
  const appearance = form(`BT /F1 10 Tf 2 6 Td (${GLOBAL_MARKERS.appearance}) Tj ET`, { BBox: [0, 0, 140, 20], Resources: globalRef });
  const annots = [ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [20, 10, 160, 30], F: 4, P: pages[0].ref, AP: { N: appearance } }))];

  if (defaultResources) {
    const field = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: str("note"), Rect: [180, 10, 280, 30], F: 4, P: pages[0].ref, DA: str("/Helv 10 Tf 0 g") }));
    annots.push(field);
    const dr = ctx.obj({
      Font: { Helv: helv, T3: type3 },
      XObject: { I2: xobjects.get(N("I2")), Secret: form(label(GLOBAL_MARKERS.defaultResources), { Resources: { Font: { F1: helv } } }) }
    });
    doc.catalog.set(N("AcroForm"), ctx.obj({ Fields: [field], DA: str("/Helv 10 Tf 0 g"), DR: dr }));
  }
  pages[0].node.set(N("Annots"), ctx.obj(annots));
  return { bytes: await doc.save({ useObjectStreams: false }), signatures };
}

// ---------------------------------------------------------------------------------------------------
// encrypted
// ---------------------------------------------------------------------------------------------------

export const ENCRYPTED_TITLE = "Tiêu đề của tệp có mật khẩu";

/**
 * An AES-256 encrypted document with three pages "ENCRYPTED PAGE n", written by the library itself.
 * Without `userPassword` the file opens with an empty password (it only restricts permissions).
 * With object streams (the default) the writer loses /Info when it reads the file back, as it does for
 * every encrypted file with a cross-reference stream.
 */
export async function buildEncryptedFixture({ userPassword, ownerPassword = "owner123", useObjectStreams = true, pages = 3 } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  doc.setTitle(ENCRYPTED_TITLE);
  const font = await doc.embedFont(fontBytes("arimo-regular"), { subset: true });
  for (let number = 1; number <= pages; number += 1) {
    doc.addPage([300, 200]).drawText(`ENCRYPTED PAGE ${number}`, { x: 20, y: 100, size: 14, font });
  }
  const options = { ownerPassword, permissions: { printing: "highResolution" } };
  if (userPassword !== undefined) options.userPassword = userPassword;
  doc.encrypt(options);
  return doc.save({ useObjectStreams });
}

// ---------------------------------------------------------------------------------------------------
// text objects with a layout
// ---------------------------------------------------------------------------------------------------

const parsedFonts = new Map();
/** The fontkit font of a bundled face. */
export function parsedFont(fontKey) {
  if (!parsedFonts.has(fontKey)) parsedFonts.set(fontKey, fontkit.create(fontBytes(fontKey)));
  return parsedFonts.get(fontKey);
}

/** Advance of `text` in a face at `size` points, with the features of the editor (one glyph per character). */
export function textAdvance(fontKey, text, size) {
  const font = parsedFont(fontKey);
  const { glyphs } = font.layout(text.normalize("NFC"), pdfFontFeatures());
  return (glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) / font.unitsPerEm) * size;
}

let objectCounter = 0;

/**
 * A text object of model/schema.js with the TextLayout the text service would give it, computed from the
 * font's own advances (left aligned, no wrapping). `lines` may hold strings, or arrays of
 * { text, font: FontKey } for lines with fallback runs.
 * @param {{ lines: Array<string | Array<{ text: string, font: string }>>, x: number, y: number, rot?: number, font?: string,
 *           bold?: boolean, italic?: boolean, size?: number, lineHeight?: number, color?: string, underline?: boolean,
 *           opacity?: number, pageId?: string, id?: string }} spec  x / y = the CENTRE of the box in user space when `frame`
 *        is not given; pass `frame` to place it yourself (w and h are replaced by the laid-out size)
 */
export function makeTextObject(spec) {
  const family = spec.font || "arimo";
  const size = spec.size || 12;
  const lineHeight = spec.lineHeight || 1.2;
  const primary = fontKeyOf(family, Boolean(spec.bold), Boolean(spec.italic));
  const metrics = parsedFont(primary);
  const ascent = (metrics.ascent / metrics.unitsPerEm) * size;
  const descent = (-metrics.descent / metrics.unitsPerEm) * size;
  const lineBox = lineHeight * size;
  const lines = spec.lines.map((line, index) => {
    const runsIn = typeof line === "string" ? [{ text: line, font: primary }] : line;
    let x = 0;
    const runs = runsIn.map((run) => {
      const placed = { text: run.text, x, font: run.font || primary };
      x += textAdvance(placed.font, run.text, size);
      return placed;
    });
    // the CSS line box: the content area (ascent + descent) centred in the line height
    return { baseline: index * lineBox + (lineBox - (ascent + descent)) / 2 + ascent, x: 0, width: x, runs };
  });
  const width = Math.max(1, ...lines.map((line) => line.width));
  const height = lines.length * lineBox;
  objectCounter += 1;
  return {
    id: spec.id || `text${objectCounter}`,
    type: "text",
    pageId: spec.pageId || "page",
    frame: { x: spec.x ?? 0, y: spec.y ?? 0, rot: spec.rot || 0, ...(spec.frame || {}), w: width, h: height },
    text: spec.lines.map((line) => (typeof line === "string" ? line : line.map((run) => run.text).join(""))).join("\n"),
    font: family,
    size,
    bold: Boolean(spec.bold),
    italic: Boolean(spec.italic),
    underline: Boolean(spec.underline),
    color: spec.color || "#000000",
    align: "left",
    lineHeight,
    opacity: spec.opacity ?? 1,
    autoWidth: true,
    layout: { width, height, lines, raster: null, problems: [] }
  };
}

// ---------------------------------------------------------------------------------------------------
// hand-written files whose cross-reference information is under the caller's control
// ---------------------------------------------------------------------------------------------------

const BINARY_COMMENT = `%${String.fromCharCode(0xe2, 0xe3, 0xcf, 0xd3)}\n`;
const tableLine = (offset) => `${String(offset).padStart(10, "0")} 00000 n \n`;
const FREE_LINE = "0000000000 65535 f \n";

/**
 * A file with a classic cross-reference table in which the caller decides what the table says.
 * A viewer reads an object where the table points; the parser of the writing library keeps the LAST
 * definition in the file. Objects are written in the order given:
 *   { num, body }                the table points at it, unless an EARLIER object of the same number took the entry
 *   { num, body, table: false }  defined in the file, the table does not point at it
 *   { num, body, table: "free" } defined in the file, the table marks the number as free
 *   { num, body, header: "4 0obj\n" }  the text in front of the body instead of "num 0 obj\n"
 * @param {Array<{ num: number, body: string | Buffer, table?: false | "free", header?: string }>} objects
 * @param {{ root?: string, info?: string, header?: string, junk?: string, trailerExtra?: string, startxref?: string | null,
 *           afterEof?: Array<{ num: number, body: string | Buffer }> }} [options]
 *        junk: bytes in front of the "%PDF-" header (a viewer counts offsets from the header);
 *        startxref: what is written behind the keyword instead of the offset of the table (null: no startxref line at all);
 *        afterEof: definitions appended behind "%%EOF" without any cross-reference section
 * @returns {Uint8Array}
 */
export function rawPdfWithTable(objects, { root = "1 0 R", info, header = "%PDF-1.7", junk = "", trailerExtra = "", startxref, afterEof = [] } = {}) {
  const chunks = [latin1(`${header}\n${BINARY_COMMENT}`)];
  let offset = chunks[0].length;
  const entries = new Map();
  const write = (object) => {
    const head = latin1(object.header ?? `${object.num} 0 obj\n`);
    for (const part of [head, Buffer.isBuffer(object.body) ? object.body : latin1(object.body), latin1("\nendobj\n")]) {
      chunks.push(part);
      offset += part.length;
    }
  };
  for (const object of objects) {
    if (object.table === "free") entries.set(object.num, null);
    else if (object.table !== false && !entries.has(object.num)) entries.set(object.num, offset);
    write(object);
  }
  const size = Math.max(...objects.map((object) => object.num), ...afterEof.map((object) => object.num)) + 1;
  let table = `xref\n0 ${size}\n${FREE_LINE}`;
  for (let num = 1; num < size; num += 1) table += typeof entries.get(num) === "number" ? tableLine(entries.get(num)) : FREE_LINE;
  const trailer = `trailer\n<< /Size ${size} /Root ${root}${info ? ` /Info ${info}` : ""}${trailerExtra} >>\n`;
  const end = startxref === null ? "" : `startxref\n${startxref ?? offset}\n%%EOF\n`;
  chunks.push(latin1(table + trailer + end));
  for (const object of afterEof) write(object);
  return new Uint8Array(Buffer.concat([latin1(junk), ...chunks]));
}

/**
 * Appends an incremental update the way every editor writes one: the new definitions, a cross-reference
 * section for exactly those numbers, and a trailer whose /Prev points at the section before.
 * @param {Uint8Array} bytes  a file with a classic table (its last "startxref" and "/Size" are read)
 * @param {Array<{ num: number, body: string | Buffer }>} objects
 * @param {{ root?: string, trailerExtra?: string, free?: number[], separator?: string }} [options]
 *        free: numbers the update marks as deleted; separator: what stands between the old "%%EOF" and the update
 */
export function appendRevision(bytes, objects, { root = "1 0 R", trailerExtra = "", free = [], separator } = {}) {
  const text = Buffer.from(bytes).toString("latin1");
  const previous = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)[1]);
  const sizes = [...text.matchAll(/\/Size (\d+)/g)].map((match) => Number(match[1]));
  const size = Math.max(...sizes, ...objects.map((object) => object.num + 1));
  // signing tools append right behind "%%EOF", also when no newline follows it
  const base = separator === undefined ? Buffer.from(bytes) : Buffer.concat([Buffer.from(text.replace(/\s+$/, ""), "latin1"), latin1(separator)]);
  const chunks = [base];
  let offset = base.length;
  const entries = new Map(free.map((num) => [num, null]));
  for (const { num, body } of objects) {
    entries.set(num, offset);
    for (const part of [latin1(`${num} 0 obj\n`), Buffer.isBuffer(body) ? body : latin1(body), latin1("\nendobj\n")]) {
      chunks.push(part);
      offset += part.length;
    }
  }
  let table = "xref\n";
  for (const num of [...entries.keys()].sort((a, b) => a - b)) table += `${num} 1\n${entries.get(num) === null ? "0000000000 00001 f \n" : tableLine(entries.get(num))}`;
  chunks.push(latin1(`${table}trailer\n<< /Size ${size} /Root ${root} /Prev ${previous}${trailerExtra} >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * A file with a cross-reference STREAM and object streams, all stored without a filter, so that a test can
 * say exactly what they hold.
 * @param {object} parts
 * @param {Array<{ num: number, body: string | Buffer }>} parts.plain  objects written on their own, in this order
 * @param {Array<{ num: number, after?: number, members: Array<{ num: number, body: string, listedAs?: number }> }>} [parts.packed]
 *        object streams (number `num`), written behind the plain objects in this order; a member can be listed
 *        in the header of its stream under another number (listedAs)
 * @param {Record<number, [number, number, number] | null>} [parts.entries]  what the cross-reference stream says
 *        about a number instead of the truth: [type, second field, third field], or null for "free"
 * @param {string} [parts.root]
 * @returns {Uint8Array}
 */
export function rawPdfWithObjectStreams({ plain, packed = [], entries = {}, root = "1 0 R" }) {
  const chunks = [latin1(`%PDF-1.7\n${BINARY_COMMENT}`)];
  let offset = chunks[0].length;
  const rows = new Map();
  const write = (num, body) => {
    rows.set(num, [1, offset, 0]);
    for (const part of [latin1(`${num} 0 obj\n`), Buffer.isBuffer(body) ? body : latin1(body), latin1("\nendobj\n")]) {
      chunks.push(part);
      offset += part.length;
    }
  };
  for (const object of plain) write(object.num, object.body);
  for (const stream of packed) {
    let head = "";
    let data = "";
    stream.members.forEach((member, index) => {
      head += `${member.listedAs ?? member.num} ${data.length} `;
      data += `${member.body}\n`;
      // as in a real file: the LAST object stream that lists a number is the one the cross-reference stream names
      rows.set(member.num, [2, stream.num, index]);
    });
    write(stream.num, streamBody(`/Type /ObjStm /N ${stream.members.length} /First ${head.length}`, head + data));
  }
  const xrefNum = Math.max(...rows.keys()) + 1;
  rows.set(xrefNum, [1, offset, 0]);
  for (const [num, row] of Object.entries(entries)) rows.set(Number(num), row ?? [0, 0, 65535]);
  const table = Buffer.alloc((xrefNum + 1) * 7);
  table.writeUInt8(0, 0);
  table.writeUInt16BE(65535, 5);
  for (let num = 1; num <= xrefNum; num += 1) {
    const [type, second, third] = rows.get(num) ?? [0, 0, 65535];
    table.writeUInt8(type, num * 7);
    table.writeUInt32BE(second, num * 7 + 1);
    table.writeUInt16BE(third, num * 7 + 5);
  }
  const xref = Buffer.concat([latin1(`${xrefNum} 0 obj\n`), streamBody(`/Type /XRef /Size ${xrefNum + 1} /W [1 4 2] /Root ${root}`, table), latin1("\nendobj\n")]);
  chunks.push(xref, latin1(`startxref\n${offset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * A hybrid-reference file (ISO 32000-1, 7.5.8.4): a classic table for the objects written on their own and a
 * cross-reference stream, which the trailer names with /XRefStm, for the object streams and their members.
 * Producers write it so that readers older than PDF 1.5 still find the main objects.
 * @param {object} parts
 * @param {Array<{ num: number, body: string | Buffer, table?: false }>} parts.plain  written first, in this order;
 *        table: false = the classic table does not point at it
 * @param {Array<{ num: number, members: Array<{ num: number, body: string }> }>} parts.packed  object streams,
 *        written behind the plain objects; they and their members are listed in the cross-reference stream only
 * @param {"absent" | "free"} [parts.hidden]  how the classic table shows a number it does not point at: in no
 *        subsection at all, or as a free entry
 * @param {Array<{ num: number, body: string | Buffer }>} [parts.late]  definitions written BEHIND the object
 *        streams that no cross-reference information lists
 * @param {string} [parts.root]
 * @returns {Uint8Array}
 */
export function rawHybridPdf({ plain, packed, hidden = "absent", late = [], root = "1 0 R" }) {
  const chunks = [latin1(`%PDF-1.7\n${BINARY_COMMENT}`)];
  let offset = chunks[0].length;
  const write = (num, body) => {
    const at = offset;
    for (const part of [latin1(`${num} 0 obj\n`), Buffer.isBuffer(body) ? body : latin1(body), latin1("\nendobj\n")]) {
      chunks.push(part);
      offset += part.length;
    }
    return at;
  };
  const classic = new Map();
  const rows = new Map();
  for (const object of plain) {
    const at = write(object.num, object.body);
    if (object.table !== false) classic.set(object.num, at);
  }
  for (const stream of packed) {
    let head = "";
    let data = "";
    stream.members.forEach((member, index) => {
      head += `${member.num} ${data.length} `;
      data += `${member.body}\n`;
      rows.set(member.num, [2, stream.num, index]);
    });
    rows.set(stream.num, [1, write(stream.num, streamBody(`/Type /ObjStm /N ${stream.members.length} /First ${head.length}`, head + data)), 0]);
  }
  for (const object of late) write(object.num, object.body);
  const xrefNum = Math.max(...plain.map((object) => object.num), ...rows.keys(), ...late.map((object) => object.num)) + 1;
  const size = xrefNum + 1;
  // the cross-reference stream lists the hidden numbers only: one /Index subsection per number
  const numbers = [...rows.keys()].sort((a, b) => a - b);
  const table = Buffer.alloc(numbers.length * 7);
  numbers.forEach((num, index) => {
    const [type, second, third] = rows.get(num);
    table.writeUInt8(type, index * 7);
    table.writeUInt32BE(second, index * 7 + 1);
    table.writeUInt16BE(third, index * 7 + 5);
  });
  const streamAt = write(xrefNum, streamBody(`/Type /XRef /Size ${size} /W [1 4 2] /Index [${numbers.map((num) => `${num} 1`).join(" ")}]`, table));
  const tableAt = offset;
  let text = "xref\n";
  if (hidden === "free") {
    text += `0 ${size}\n${FREE_LINE}`;
    for (let num = 1; num < size; num += 1) text += classic.has(num) ? tableLine(classic.get(num)) : FREE_LINE;
  } else {
    text += `0 1\n${FREE_LINE}`;
    for (const num of [...classic.keys()].sort((a, b) => a - b)) text += `${num} 1\n${tableLine(classic.get(num))}`;
  }
  chunks.push(latin1(`${text}trailer\n<< /Size ${size} /Root ${root} /XRefStm ${streamAt} >>\nstartxref\n${tableAt}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}
