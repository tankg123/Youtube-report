// Digital signature of a PDF as ONE incremental update (PAdES B-B or adbe.pkcs7.detached).
//
// The result is the input, byte for byte, followed by the new revision. The PDF library is used as a parser
// and object model only (PDFParser -> PDFContext with the original object numbers, PngEmbedder / JpegEmbedder
// for the stamp picture); nothing is ever saved through it, and none of its mutating helpers is called
// (PDFDocument.load, getForm, getOrCreateAcroForm and page.node.addAnnot all change objects). The objects of
// the update and the cross-reference section are serialised here (./incremental.js); /Size, /Root, /Info,
// /ID, /Prev and the section style come from the raw last cross-reference section (./pdfRaw.js).
//
// What the appended revision contains:
//   N 0 obj  << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached
//               /ByteRange [0 a b c          ]      fixed-width slot, written once the layout is known
//               /Contents <00...00>                 hex placeholder, 2 x contentsBytes digits
//               /M (D:...) [/Name /Reason /Location /ContactInfo] [/Prop_Build] [/Reference [DocMDP]] >>
//   [image XObject (+ soft mask), form XObject = the appearance]      visible signatures only
//   W 0 obj  << /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /F 132 /Rect [...] /P page /V N 0 R
//               [/AP << /N form >>] [/MK << /R rotation >>] >>        field and widget in one dictionary
//   [A 0 obj << /Fields [ W 0 R ] /SigFlags 3 >>]                     only when the document had no AcroForm
//   rewritten existing objects (same number, same generation): the page or its indirect /Annots array; the
//   catalog (no AcroForm, a direct one, /Perms) or the AcroForm object or its indirect /Fields array
//   xref table + trailer, or one cross-reference stream; startxref; %%EOF
// The signature dictionary is written by hand, so the offsets of /ByteRange and /Contents are known and
// nothing is ever searched in the file.
//
// Visible signature on a rotated page: the appearance is ONE form XObject with /BBox [0 0 W H], W x H = the
// stamp as the reader sees it (for /Rotate 90 or 270 the sides of the rectangle swapped), and a /Matrix that
// turns it against the page rotation (see appearanceMatrix), so the picture is upright on the displayed page.
//
// Browser + Node: Uint8Array in and out, WebCrypto, no DOM.

import { PdfEditorError, isPdfEditorError, throwIfAborted, warning } from "../errors.js";
import { pdfLib } from "../lib.js";
import { berLength } from "./asn1.js";
import { fromHex, latin1Encode, randomBytes, toHex } from "./bytes.js";
import { createCms, describeSigner, estimateCmsSize, measureTimestampTokenSize, SUBFILTER_PADES, SUBFILTER_PKCS7 } from "./cms.js";
import { buildIncrementalUpdate } from "./incremental.js";
import { isLinearized, readLastXrefSection, readXrefChain } from "./pdfRaw.js";
import { digest } from "./sigverify.js";
import { certificateFacts } from "./x509.js";

export { SUBFILTER_PADES, SUBFILTER_PKCS7 };

const { PDFName, PDFRef, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFStream } = pdfLib;
const N = (text) => PDFName.of(text);

/** Width of one number of the /ByteRange placeholder: offsets up to 9 999 999 999 (9.3 GB). */
const BYTE_RANGE_DIGITS = 10;
const DEFAULT_HEADROOM = 512;
const ANNOT_FLAG_PRINT = 4;
const ANNOT_FLAG_LOCKED = 128;

const fail = (code, params, detail, cause) => new PdfEditorError(code, params || {}, { detail, cause });
const internal = (check, detail) => fail("SIGN_INTERNAL", { check }, detail);

// ---------------------------------------------------------------------------------------------
// PDF syntax helpers
// ---------------------------------------------------------------------------------------------

/**
 * PDF text string (ISO 32000-1 7.9.2.2): printable ASCII as a literal string, anything else as UTF-16BE
 * with a byte order mark, written as a hex string. Vietnamese always takes the second form.
 */
export function pdfTextString(text) {
  const value = String(text);
  if (/^[\x20-\x7e]*$/.test(value)) return `(${value.replace(/[\\()]/g, (char) => `\\${char}`)})`;
  let out = "FEFF";
  for (let i = 0; i < value.length; i++) out += value.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return `<${out}>`;
}

/** D:YYYYMMDDHHmmSS+HH'mm' in the given UTC offset (minutes east of UTC). */
export function pdfDate(date, offsetMinutes = 0) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const stamp = pad(shifted.getUTCFullYear(), 4) + pad(shifted.getUTCMonth() + 1) + pad(shifted.getUTCDate())
    + pad(shifted.getUTCHours()) + pad(shifted.getUTCMinutes()) + pad(shifted.getUTCSeconds());
  if (offsetMinutes === 0) return `D:${stamp}Z`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `D:${stamp}${sign}${pad(Math.floor(absolute / 60))}'${pad(absolute % 60)}'`;
}

/** Name object with #xx escapes for everything outside the regular characters. */
export function pdfName(name) {
  const bytes = new TextEncoder().encode(String(name));
  let out = "/";
  for (const byte of bytes) {
    const regular = byte > 0x20 && byte < 0x7f && !"()<>[]{}/%#".includes(String.fromCharCode(byte));
    out += regular ? String.fromCharCode(byte) : `#${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const round = (value, digits = 3) => {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const normalizeRotation = (degrees) => (((Math.round((degrees || 0) / 90) * 90) % 360) + 360) % 360;

/**
 * /Matrix of the appearance stream for a page displayed with /Rotate `rotation`: the form space [0 0 W H]
 * (W x H = the stamp as the reader sees it, upright) is turned counter-clockwise by the page rotation and
 * shifted back into the positive quadrant, so that the stamp is upright on screen. The viewer then maps
 * the transformed box onto /Rect (ISO 32000-1 12.5.5, algorithm 8.1).
 */
export function appearanceMatrix(rotation, width, height) {
  switch (normalizeRotation(rotation)) {
    case 90:
      return [0, 1, -1, 0, height, 0];
    case 180:
      return [-1, 0, 0, -1, width, height];
    case 270:
      return [0, -1, 1, 0, 0, width];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

const objectBytes = (object) => {
  const buffer = new Uint8Array(object.sizeInBytes());
  const written = object.copyBytesInto(buffer, 0);
  return written === buffer.length ? buffer : buffer.subarray(0, written);
};

const textOf = (object) => {
  if (object instanceof PDFString || object instanceof PDFHexString) {
    try {
      return object.decodeText();
    } catch {
      return null;
    }
  }
  return null;
};

const numbersOf = (context, object) => {
  const array = context.lookup(object);
  if (!(array instanceof PDFArray)) return null;
  const out = [];
  for (let i = 0; i < array.size(); i++) {
    const value = context.lookup(array.get(i));
    if (!(value instanceof PDFNumber)) return null;
    out.push(value.asNumber());
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// reading the document
// ---------------------------------------------------------------------------------------------

/** Parses the file; returns the object graph, the raw facts of the last xref section and the catalog. */
async function open(pdfBytes, { objectsPerTick = Infinity, raw = null } = {}) {
  if (!(pdfBytes instanceof Uint8Array)) throw fail("SIGN_BAD_OPTIONS", { option: "bytes" }, "the PDF must be a Uint8Array");
  const last = raw || readLastXrefSection(pdfBytes);
  if (last.encrypt) throw fail("SIGN_ENCRYPTED", {}, "the document is encrypted: the new objects would have to be encrypted with the file key");
  const chain = readXrefChain(pdfBytes, last);
  let context;
  try {
    context = await pdfLib.PDFParser.forBytesWithOptions(pdfBytes, objectsPerTick, false).parseDocument();
  } catch (error) {
    throw fail("SIGN_DAMAGED_XREF", { reason: "unparseable" }, "the objects of the file cannot be parsed", error);
  }
  const catalog = context.lookup(last.root);
  if (!(catalog instanceof PDFDict) || !catalog.has(N("Pages"))) {
    throw fail("SIGN_DAMAGED_XREF", { reason: "bad-catalog" }, `the trailer /Root (${last.root}) is not a document catalog`);
  }
  return { bytes: pdfBytes, raw: last, chain, context, catalog };
}

/** Warnings that come from the file structure alone (shared by the inspection and the signer). */
function structureWarnings(chain) {
  const out = [];
  // strict validators (pyHanko's default) refuse to judge signatures in a hybrid-reference file
  if (chain.hybrid) out.push(warning("SIGN_HYBRID_XREF"));
  if (chain.problems.length) out.push(warning("SIGN_XREF_CHAIN_DAMAGED", { problems: chain.problems }));
  return out;
}

/** The largest object number any reference in the file points to, defined or not. */
function largestReferencedObjectNumber(context) {
  let max = 0;
  const stack = [];
  for (const [, object] of context.enumerateIndirectObjects()) stack.push(object);
  while (stack.length) {
    const object = stack.pop();
    if (object instanceof PDFRef) {
      if (object.objectNumber > max) max = object.objectNumber;
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) stack.push(value);
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) stack.push(value);
    } else if (object instanceof PDFStream) {
      stack.push(object.dict);
    }
  }
  return max;
}

/** Pages in document order with the inherited attributes resolved. */
function collectPages(context, catalog) {
  const pages = [];
  const seen = new Set();
  const inheritable = ["Rotate", "MediaBox", "CropBox"];
  const walk = (nodeRef, inherited, depth) => {
    if (depth > 64 || !(nodeRef instanceof PDFRef) || seen.has(nodeRef.tag)) return;
    seen.add(nodeRef.tag);
    const node = context.lookup(nodeRef);
    if (!(node instanceof PDFDict)) return;
    const mine = { ...inherited };
    for (const key of inheritable) if (node.has(N(key))) mine[key] = node.get(N(key));
    const kids = context.lookup(node.get(N("Kids")));
    const type = node.get(N("Type"));
    if (kids instanceof PDFArray && type !== N("Page")) {
      for (let i = 0; i < kids.size(); i++) walk(kids.get(i), mine, depth + 1);
    } else {
      const rotate = context.lookup(mine.Rotate);
      const userUnit = context.lookup(node.get(N("UserUnit")));
      pages.push({
        index: pages.length,
        ref: nodeRef,
        dict: node,
        rotation: normalizeRotation(rotate instanceof PDFNumber ? rotate.asNumber() : 0),
        mediaBox: numbersOf(context, mine.MediaBox),
        cropBox: numbersOf(context, mine.CropBox),
        userUnit: userUnit instanceof PDFNumber ? userUnit.asNumber() : 1
      });
    }
  };
  walk(catalog.get(N("Pages")), {}, 0);
  return pages;
}

/** AcroForm state: where it lives, every field name, every signature. */
function readForm(context, catalog, pages, fileLength) {
  const entry = catalog.get(N("AcroForm"));
  const dict = context.lookup(entry);
  const form = {
    present: dict instanceof PDFDict,
    ref: entry instanceof PDFRef && dict instanceof PDFDict ? entry : null,
    dict: dict instanceof PDFDict ? dict : null,
    fieldsRef: null,
    fields: null,
    sigFlags: 0,
    hasXfa: false,
    needAppearances: false,
    names: new Set(),
    rootNames: new Set(),
    fieldCount: 0,
    signatures: [],
    emptySignatureFields: []
  };
  if (!form.present) return form;
  const fieldsEntry = dict.get(N("Fields"));
  const fields = context.lookup(fieldsEntry);
  if (fields instanceof PDFArray) {
    form.fields = fields;
    form.fieldsRef = fieldsEntry instanceof PDFRef ? fieldsEntry : null;
  }
  const sigFlags = context.lookup(dict.get(N("SigFlags")));
  form.sigFlags = sigFlags instanceof PDFNumber ? sigFlags.asNumber() : 0;
  form.hasXfa = dict.has(N("XFA"));
  form.needAppearances = String(context.lookup(dict.get(N("NeedAppearances")))) === "true";

  const pageIndexByTag = new Map(pages.map((page) => [page.ref.tag, page.index]));
  const seen = new Set();
  const visit = (ref, parentName, inheritedType, depth) => {
    if (depth > 32) return;
    const field = context.lookup(ref);
    if (!(field instanceof PDFDict)) return;
    if (ref instanceof PDFRef) {
      if (seen.has(ref.tag)) return;
      seen.add(ref.tag);
    }
    const partial = textOf(context.lookup(field.get(N("T"))));
    if (partial === null && depth > 0) return; // a widget of its parent, not a field
    const name = partial === null ? parentName : parentName ? `${parentName}.${partial}` : partial;
    const fieldType = context.lookup(field.get(N("FT"))) || inheritedType;
    if (depth === 0 && partial !== null) form.rootNames.add(partial);
    if (name) form.names.add(name);
    const kids = context.lookup(field.get(N("Kids")));
    let childFields = 0;
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = context.lookup(kids.get(i));
        if (kid instanceof PDFDict && kid.has(N("T"))) {
          childFields++;
          visit(kids.get(i), name, fieldType, depth + 1);
        }
      }
    }
    if (childFields > 0) return;
    form.fieldCount++;
    if (fieldType !== N("Sig")) return;
    const value = context.lookup(field.get(N("V")));
    // the widget is the field itself (merged) or its first kid
    let widget = field;
    let widgetRef = ref instanceof PDFRef ? ref : null;
    if (!field.has(N("Rect")) && kids instanceof PDFArray && kids.size() > 0) {
      const kid = context.lookup(kids.get(0));
      if (kid instanceof PDFDict) {
        widget = kid;
        widgetRef = kids.get(0) instanceof PDFRef ? kids.get(0) : null;
      }
    }
    const pageRef = widget.get(N("P"));
    const rect = numbersOf(context, widget.get(N("Rect")));
    let pageIndex = pageRef instanceof PDFRef && pageIndexByTag.has(pageRef.tag) ? pageIndexByTag.get(pageRef.tag) : null;
    if (pageIndex === null && widgetRef) {
      // no usable /P: look the widget up in the /Annots of the pages
      for (const page of pages) {
        const annots = context.lookup(page.dict.get(N("Annots")));
        if (annots instanceof PDFArray && annots.asArray().some((annot) => annot instanceof PDFRef && annot.tag === widgetRef.tag)) {
          pageIndex = page.index;
          break;
        }
      }
    }
    const base = {
      fieldName: name,
      pageIndex,
      rect,
      visible: Boolean(rect) && rect.length === 4 && Math.abs(rect[2] - rect[0]) > 0 && Math.abs(rect[3] - rect[1]) > 0,
      hasLock: field.has(N("Lock")),
      internal: { fieldRef: ref instanceof PDFRef ? ref : null, fieldDict: field, widgetRef, widgetDict: widget }
    };
    if (!(value instanceof PDFDict)) {
      form.emptySignatureFields.push(base);
      return;
    }
    const byteRange = numbersOf(context, value.get(N("ByteRange")));
    const contents = context.lookup(value.get(N("Contents")));
    const type = value.get(N("Type"));
    const subFilter = value.get(N("SubFilter"));
    let docMdp = null;
    const reference = context.lookup(value.get(N("Reference")));
    if (reference instanceof PDFArray) {
      for (let i = 0; i < reference.size(); i++) {
        const sigRef = context.lookup(reference.get(i));
        if (sigRef instanceof PDFDict && sigRef.get(N("TransformMethod")) === N("DocMDP")) {
          const params = context.lookup(sigRef.get(N("TransformParams")));
          const level = params instanceof PDFDict ? context.lookup(params.get(N("P"))) : null;
          docMdp = level instanceof PDFNumber ? level.asNumber() : 2;
        }
      }
    }
    form.signatures.push({
      ...base,
      type: type === N("DocTimeStamp") ? "DocTimeStamp" : "Sig",
      subFilter: subFilter instanceof PDFName ? subFilter.asString().replace(/^\//, "") : null,
      byteRange,
      coversWholeFile: Boolean(byteRange) && byteRange.length === 4 && byteRange[0] === 0 && byteRange[2] + byteRange[3] === fileLength,
      signedLength: byteRange && byteRange.length === 4 ? byteRange[2] + byteRange[3] : null,
      contentsBytes: contents instanceof PDFHexString || contents instanceof PDFString ? contents.asBytes().length : null,
      name: textOf(context.lookup(value.get(N("Name")))),
      reason: textOf(context.lookup(value.get(N("Reason")))),
      location: textOf(context.lookup(value.get(N("Location")))),
      signingTime: textOf(context.lookup(value.get(N("M")))),
      docMdp,
      valueRef: field.get(N("V")) instanceof PDFRef ? field.get(N("V")) : null
    });
  };
  if (form.fields) for (let i = 0; i < form.fields.size(); i++) visit(form.fields.get(i), "", undefined, 0);
  return form;
}

/** A field / signature entry of readForm() without the library objects it carries for the writer. */
function withoutInternals(entry) {
  const copy = { ...entry };
  delete copy.internal;
  delete copy.valueRef;
  return copy;
}

/** Level of an existing certification signature (/Perms /DocMDP), or null. */
function readCertification(context, catalog, form) {
  const perms = context.lookup(catalog.get(N("Perms")));
  if (!(perms instanceof PDFDict)) return null;
  const entry = perms.get(N("DocMDP"));
  if (!entry) return null;
  const viaField = form.signatures.find((signature) => signature.valueRef && entry instanceof PDFRef && signature.valueRef.tag === entry.tag);
  if (viaField && viaField.docMdp) return { level: viaField.docMdp, fieldName: viaField.fieldName };
  const signature = context.lookup(entry);
  if (signature instanceof PDFDict) {
    const reference = context.lookup(signature.get(N("Reference")));
    if (reference instanceof PDFArray && reference.size() > 0) {
      const sigRef = context.lookup(reference.get(0));
      const params = sigRef instanceof PDFDict ? context.lookup(sigRef.get(N("TransformParams"))) : null;
      const level = params instanceof PDFDict ? context.lookup(params.get(N("P"))) : null;
      return { level: level instanceof PDFNumber ? level.asNumber() : 2, fieldName: null };
    }
  }
  return { level: 2, fieldName: null };
}

/**
 * What the signer (and the interface in front of it) needs to know before signing. Never throws for a
 * property of the document: what makes signing impossible is listed in `blockers` (the codes signPdf would
 * throw), everything else in `warnings`.
 * @returns {Promise<object>} { fileLength, version, lastXref, encrypted, linearized, hybrid, pageCount, pages,
 *          acroForm, signatures, emptySignatureFields, certification, canSign, canCertify, blockers, warnings }
 */
export async function describePdf(pdfBytes, options = {}) {
  if (!(pdfBytes instanceof Uint8Array)) throw fail("SIGN_BAD_OPTIONS", { option: "bytes" }, "the PDF must be a Uint8Array");
  const base = {
    fileLength: pdfBytes.length,
    version: null,
    lastXref: null,
    encrypted: false,
    linearized: false,
    hybrid: false,
    pageCount: 0,
    pages: [],
    acroForm: { present: false, indirect: false, fieldsIndirect: false, sigFlags: 0, fieldCount: 0, fieldNames: [], hasXfa: false, needAppearances: false },
    signatures: [],
    emptySignatureFields: [],
    certification: null,
    canSign: false,
    canCertify: false,
    blockers: [],
    warnings: []
  };
  const blocked = (error) => {
    if (!isPdfEditorError(error)) throw error;
    return { ...base, blockers: [warning(error.code, error.params)] };
  };
  let raw;
  try {
    raw = readLastXrefSection(pdfBytes);
  } catch (error) {
    return blocked(error);
  }
  base.version = raw.header.version;
  base.lastXref = { type: raw.type, offset: raw.offset, hybrid: raw.hybrid, size: raw.size, prev: raw.prev, hasId: Boolean(raw.id) };
  base.encrypted = raw.encrypt;
  base.linearized = isLinearized(pdfBytes);
  base.bytesAfterEof = raw.startxref.bytesAfterEof;
  base.endsWithEol = pdfBytes.length > 0 && (pdfBytes[pdfBytes.length - 1] === 0x0a || pdfBytes[pdfBytes.length - 1] === 0x0d);
  let opened;
  try {
    opened = await open(pdfBytes, { ...options, raw });
  } catch (error) {
    return blocked(error);
  }
  const { context, catalog, chain } = opened;
  const pages = collectPages(context, catalog);
  const form = readForm(context, catalog, pages, pdfBytes.length);
  const certification = readCertification(context, catalog, form);
  const blockers = [];
  const warnings = structureWarnings(chain);
  if (pages.length === 0) blockers.push(warning("SIGN_NO_PAGES"));
  // DocMDP 1 ("no changes allowed"): any update invalidates the certification
  if (certification && certification.level === 1) blockers.push(warning("SIGN_CERTIFIED_NO_CHANGES"));
  // With /NeedAppearances true viewers rebuild field appearances: a visible stamp may not be shown (Adobe
  // Reader) or may be replaced (Xpdf). Sign invisibly or export the document first.
  if (form.needAppearances) warnings.push(warning("SIGN_NEED_APPEARANCES"));
  // A certified document: an invisible signature or an existing field is safe; a NEW visible field is treated
  // as a forbidden change by strict validators.
  if (certification && certification.level > 1) warnings.push(warning("SIGN_CERTIFIED", { level: certification.level }));
  if (form.hasXfa) warnings.push(warning("SIGN_XFA"));
  return {
    ...base,
    xrefSections: chain.sections.map((section) => ({ type: section.type, offset: section.offset, hybrid: section.hybrid, size: section.size })),
    hybrid: chain.hybrid,
    pageCount: pages.length,
    pages: pages.map((page) => ({ index: page.index, rotation: page.rotation, mediaBox: page.mediaBox, cropBox: page.cropBox, userUnit: page.userUnit, ref: page.ref.tag })),
    acroForm: {
      present: form.present,
      indirect: Boolean(form.ref),
      fieldsIndirect: Boolean(form.fieldsRef),
      sigFlags: form.sigFlags,
      fieldCount: form.fieldCount,
      fieldNames: [...form.names],
      hasXfa: form.hasXfa,
      needAppearances: form.needAppearances
    },
    signatures: form.signatures.map(withoutInternals),
    emptySignatureFields: form.emptySignatureFields.map(withoutInternals),
    certification,
    canSign: blockers.length === 0,
    canCertify: blockers.length === 0 && form.signatures.length === 0,
    blockers,
    warnings
  };
}

// ---------------------------------------------------------------------------------------------
// writing the revision
// ---------------------------------------------------------------------------------------------

function chooseFieldName(form, requested) {
  if (requested !== undefined && requested !== null) {
    const name = String(requested);
    if (name === "" || name.includes(".")) throw fail("SIGN_BAD_FIELD_NAME", {}, "a field name must not be empty and must not contain a period");
    if (form.names.has(name) || form.rootNames.has(name)) throw fail("SIGN_FIELD_NAME_TAKEN", { fieldName: name });
    return name;
  }
  for (let i = 1; ; i++) {
    const name = `Signature${i}`;
    if (!form.names.has(name) && !form.rootNames.has(name)) return name;
  }
}

/** The signature dictionary, written by hand so that the placeholders sit at known offsets. */
function buildSignatureDictionary({ subFilter, contentsBytes, m, name, reason, location, contactInfo, appName, certify }) {
  const byteRangeSlot = `[0 ${" ".repeat(3 * BYTE_RANGE_DIGITS + 2)}]`;
  const head = `<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter ${pdfName(subFilter)}\n/ByteRange `;
  const afterByteRange = "\n/Contents ";
  const contents = `<${"0".repeat(contentsBytes * 2)}>`;
  let tail = `\n/M (${m})`;
  if (name) tail += `\n/Name ${pdfTextString(name)}`;
  if (reason) tail += `\n/Reason ${pdfTextString(reason)}`;
  if (location) tail += `\n/Location ${pdfTextString(location)}`;
  if (contactInfo) tail += `\n/ContactInfo ${pdfTextString(contactInfo)}`;
  if (appName) tail += `\n/Prop_Build << /App << /Name ${pdfName(appName)} >> >>`;
  if (certify) {
    tail += `\n/Reference [ << /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P ${certify} /V /1.2 >> >> ]`;
  }
  tail += "\n>>";
  return {
    body: latin1Encode(head + byteRangeSlot + afterByteRange + contents + tail),
    byteRangeAt: head.length,
    byteRangeLength: byteRangeSlot.length,
    contentsAt: head.length + byteRangeSlot.length + afterByteRange.length,
    contentsLength: contents.length
  };
}

async function embedImage(context, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw fail("SIGN_BAD_IMAGE", { reason: "missing" }, "appearance.png must be the bytes of a PNG picture");
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) throw fail("SIGN_BAD_IMAGE", { reason: "format" }, "the signature picture is neither PNG nor JPEG");
  try {
    const embedder = await (isPng ? pdfLib.PngEmbedder : pdfLib.JpegEmbedder).for(bytes);
    const ref = await embedder.embedIntoContext(context);
    if (!(embedder.width > 0) || !(embedder.height > 0)) throw new Error("empty picture");
    return { ref, width: embedder.width, height: embedder.height };
  } catch (error) {
    throw fail("SIGN_BAD_IMAGE", { reason: "decode" }, "the signature picture cannot be decoded", error);
  }
}

const isText = (value) => value === undefined || value === null || typeof value === "string";

/**
 * Phase 1: builds the revision with an empty /Contents and a final /ByteRange. Everything the CMS needs
 * afterwards is in the result. Options as signPdfDetailed, plus contentsBytes (size of the placeholder).
 */
export async function prepareSignature(pdfBytes, options = {}) {
  const {
    subFilter = SUBFILTER_PADES,
    contentsBytes,
    signingTime = new Date(),
    timeZoneOffsetMinutes = -new Date().getTimezoneOffset(),
    name,
    reason,
    location,
    contactInfo,
    appName,
    fieldName,
    appearance = null,
    pageIndex,
    declareExtension = true,
    clearNeedAppearances = "auto",
    objectsPerTick,
    newDocumentId,
    signal
  } = options;
  const certify = options.certify ? options.certify : null; // 0 / null / undefined = an ordinary signature
  if (subFilter !== SUBFILTER_PADES && subFilter !== SUBFILTER_PKCS7) throw fail("SIGN_BAD_SUBFILTER", { subFilter: String(subFilter) });
  if (!Number.isInteger(contentsBytes) || contentsBytes < 256) throw fail("SIGN_BAD_OPTIONS", { option: "contentsBytes" }, "contentsBytes must be an integer >= 256");
  if (certify !== null && ![1, 2, 3].includes(certify)) throw fail("SIGN_BAD_OPTIONS", { option: "certify" }, "certify must be 0, 1, 2 or 3 (DocMDP level)");
  if (!(signingTime instanceof Date) || Number.isNaN(signingTime.getTime())) throw fail("SIGN_BAD_OPTIONS", { option: "signingTime" });
  if (!Number.isFinite(timeZoneOffsetMinutes) || Math.abs(timeZoneOffsetMinutes) > 24 * 60) throw fail("SIGN_BAD_OPTIONS", { option: "timeZoneOffsetMinutes" });
  for (const [option, value] of Object.entries({ name, reason, location, contactInfo, appName })) {
    if (!isText(value)) throw fail("SIGN_BAD_OPTIONS", { option }, `${option} must be a string`);
  }
  if (appearance !== null && (typeof appearance !== "object" || Array.isArray(appearance))) throw fail("SIGN_BAD_OPTIONS", { option: "appearance" });

  throwIfAborted(signal);
  const { bytes, raw, chain, context, catalog } = await open(pdfBytes, { objectsPerTick });
  throwIfAborted(signal);
  const pages = collectPages(context, catalog);
  if (pages.length === 0) throw fail("SIGN_NO_PAGES");
  const form = readForm(context, catalog, pages, bytes.length);
  const certification = readCertification(context, catalog, form);
  if (certify !== null && form.signatures.length > 0) throw fail("SIGN_CERTIFY_NOT_FIRST", {}, "a certification signature must be the first signature of a document");
  if (certification && certification.level === 1) throw fail("SIGN_CERTIFIED_NO_CHANGES", {}, "the document is certified with \"no changes allowed\"");

  // An existing EMPTY signature field with the requested name is signed in place; otherwise a new field is
  // created (and the name must be free).
  const existing = fieldName !== undefined && fieldName !== null ? form.emptySignatureFields.find((field) => field.fieldName === String(fieldName)) : null;
  if (existing && !(existing.internal.fieldRef && existing.internal.widgetRef)) {
    throw fail("SIGN_UNSUPPORTED_FIELD", { fieldName: existing.fieldName }, "the signature field or its widget is not an indirect object");
  }
  let targetIndex;
  if (existing) targetIndex = existing.pageIndex === null ? 0 : existing.pageIndex;
  else if (appearance && appearance.pageIndex !== undefined) targetIndex = appearance.pageIndex;
  else targetIndex = pageIndex !== undefined ? pageIndex : 0;
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= pages.length) {
    throw fail("SIGN_BAD_PAGE", { pageIndex: targetIndex, pageCount: pages.length });
  }
  const page = pages[targetIndex];
  const finalFieldName = existing ? existing.fieldName : chooseFieldName(form, fieldName);

  // --- object numbers: never below the /Size of the last section, never an existing object, and never a
  // number that a dangling reference of the original already points to (it would suddenly resolve to one of
  // the new objects).
  const firstNew = Math.max(raw.size, chain.maxSize, context.largestObjectNumber + 1, largestReferencedObjectNumber(context) + 1);
  context.largestObjectNumber = firstNew - 1;
  const dirty = new Map(); // tag -> [ref, object]: existing objects that are rewritten
  const touch = (ref) => {
    dirty.set(ref.tag, [ref, context.lookup(ref)]);
  };
  const warnings = structureWarnings(chain);

  const sigRef = context.nextRef();

  // --- appearance -----------------------------------------------------------------------------
  let rect = [0, 0, 0, 0];
  let apRef = null;
  let wantsStamp = Boolean(appearance);
  if (existing) {
    const fieldRect = existing.rect && existing.rect.length === 4 ? existing.rect : [0, 0, 0, 0];
    rect = [Math.min(fieldRect[0], fieldRect[2]), Math.min(fieldRect[1], fieldRect[3]), Math.max(fieldRect[0], fieldRect[2]), Math.max(fieldRect[1], fieldRect[3])];
    if (wantsStamp && !existing.visible) {
      wantsStamp = false; // the existing field has an empty rectangle: the signature stays invisible
      warnings.push(warning("SIGN_FIELD_NOT_VISIBLE", { fieldName: finalFieldName }));
    } else if (wantsStamp && existing.pageIndex === null) {
      wantsStamp = false; // the existing field is not attached to a page: no stamp is drawn
      warnings.push(warning("SIGN_FIELD_NOT_ON_A_PAGE", { fieldName: finalFieldName }));
    }
  } else if (appearance) {
    const given = appearance.rect;
    if (!Array.isArray(given) || given.length !== 4 || given.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw fail("SIGN_BAD_RECT", {}, "appearance.rect must be [x0, y0, x1, y1] in the user space of the page");
    }
    rect = [Math.min(given[0], given[2]), Math.min(given[1], given[3]), Math.max(given[0], given[2]), Math.max(given[1], given[3])].map((value) => round(value));
  }
  if (wantsStamp) {
    const rectWidth = rect[2] - rect[0];
    const rectHeight = rect[3] - rect[1];
    if (!(rectWidth > 0) || !(rectHeight > 0)) throw fail("SIGN_BAD_RECT", {}, "appearance.rect is empty");
    const quarterTurn = page.rotation === 90 || page.rotation === 270;
    const W = round(quarterTurn ? rectHeight : rectWidth); // the stamp as the reader sees it
    const H = round(quarterTurn ? rectWidth : rectHeight);
    const image = await embedImage(context, appearance.png);
    let w = W;
    let h = H;
    let dx = 0;
    let dy = 0;
    if ((appearance.fit || "contain") === "contain") {
      const scale = Math.min(W / image.width, H / image.height);
      w = round(image.width * scale);
      h = round(image.height * scale);
      dx = round((W - w) / 2);
      dy = round((H - h) / 2);
    }
    const content = `q\n${w} 0 0 ${h} ${dx} ${dy} cm\n/Img Do\nQ\n`;
    const apDict = {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: [0, 0, W, H],
      Resources: { XObject: { Img: image.ref } }
    };
    if (page.rotation !== 0) apDict.Matrix = appearanceMatrix(page.rotation, W, H);
    apRef = context.register(context.stream(content, apDict));
  }

  // pyHanko's default policy rejects a NEW visible signature field after a certification signature (it is
  // stricter than Acrobat by its own comment); an invisible signature or an existing field is accepted
  if (certification && apRef && !existing) warnings.push(warning("SIGN_CERTIFIED_VISIBLE"));
  if (form.hasXfa) warnings.push(warning("SIGN_XFA"));

  let catalogChanged = false;
  let formChanged = false;
  if (existing) {
    // --- existing field: /V on the field, /AP + flags on its widget ---------------------------
    const { fieldRef, fieldDict, widgetRef: existingWidgetRef, widgetDict } = existing.internal;
    fieldDict.set(N("V"), sigRef);
    touch(fieldRef);
    const flags = context.lookup(widgetDict.get(N("F")));
    const current = flags instanceof PDFNumber ? flags.asNumber() : 0;
    widgetDict.set(N("F"), PDFNumber.of(current | ANNOT_FLAG_PRINT | ANNOT_FLAG_LOCKED));
    if (apRef) {
      widgetDict.set(N("AP"), context.obj({ N: apRef }));
      if (page.rotation !== 0 && !widgetDict.has(N("MK"))) widgetDict.set(N("MK"), context.obj({ R: page.rotation }));
    }
    touch(existingWidgetRef);
    // a /Lock dictionary (FieldMDP) is not turned into a /Reference entry of the signature
    if (existing.hasLock) warnings.push(warning("SIGN_FIELD_LOCK", { fieldName: finalFieldName }));
  } else {
    // --- new field + widget (merged) ----------------------------------------------------------
    const widgetRef = context.nextRef();
    const widget = context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      F: ANNOT_FLAG_PRINT | ANNOT_FLAG_LOCKED,
      Rect: rect,
      P: page.ref,
      V: sigRef
    });
    widget.set(N("T"), /^[\x20-\x7e]*$/.test(finalFieldName) ? PDFString.of(finalFieldName.replace(/[\\()]/g, (char) => `\\${char}`)) : PDFHexString.fromText(finalFieldName));
    if (apRef) {
      widget.set(N("AP"), context.obj({ N: apRef }));
      if (page.rotation !== 0) widget.set(N("MK"), context.obj({ R: page.rotation }));
    }
    context.assign(widgetRef, widget);

    // --- page /Annots -------------------------------------------------------------------------
    const annotsEntry = page.dict.get(N("Annots"));
    const annots = context.lookup(annotsEntry);
    if (annotsEntry instanceof PDFRef && annots instanceof PDFArray) {
      annots.push(widgetRef);
      touch(annotsEntry);
    } else if (annots instanceof PDFArray) {
      annots.push(widgetRef);
      touch(page.ref);
    } else {
      page.dict.set(N("Annots"), context.obj([widgetRef]));
      touch(page.ref);
    }

    // --- AcroForm /Fields ---------------------------------------------------------------------
    if (!form.present) {
      const acroFormRef = context.register(context.obj({ Fields: [widgetRef], SigFlags: 3 }));
      catalog.set(N("AcroForm"), acroFormRef);
      catalogChanged = true;
    } else if (form.fields) {
      form.fields.push(widgetRef);
      if (form.fieldsRef) touch(form.fieldsRef);
      else formChanged = true;
    } else {
      form.dict.set(N("Fields"), context.obj([widgetRef]));
      formChanged = true;
    }
  }

  // --- AcroForm flags -------------------------------------------------------------------------
  if (form.present) {
    if ((form.sigFlags & 3) !== 3) {
      form.dict.set(N("SigFlags"), PDFNumber.of(form.sigFlags | 3));
      formChanged = true;
    }
    if (form.needAppearances) {
      // With /NeedAppearances true a viewer rebuilds every field appearance, the signature's included.
      // Removing the flag is only safe when no other field depends on it.
      const clear = clearNeedAppearances === true || (clearNeedAppearances === "auto" && form.fieldCount === 0);
      if (clear) {
        form.dict.delete(N("NeedAppearances"));
        formChanged = true;
      } else if (apRef) {
        warnings.push(warning("SIGN_NEED_APPEARANCES"));
      }
    }
    if (formChanged) {
      if (form.ref) touch(form.ref);
      else catalogChanged = true;
    }
  }

  // --- certification: catalog /Perms /DocMDP --------------------------------------------------
  if (certify !== null) {
    const permsEntry = catalog.get(N("Perms"));
    const perms = context.lookup(permsEntry);
    if (perms instanceof PDFDict) {
      perms.set(N("DocMDP"), sigRef);
      if (permsEntry instanceof PDFRef) touch(permsEntry);
      else catalogChanged = true;
    } else {
      catalog.set(N("Perms"), context.obj({ DocMDP: sigRef }));
      catalogChanged = true;
    }
  }

  // --- /Extensions /ESIC (PAdES on a PDF 1.x file), only when the catalog is rewritten anyway -
  if (declareExtension && catalogChanged && subFilter === SUBFILTER_PADES && raw.header.major === 1) {
    const extensionsEntry = catalog.get(N("Extensions"));
    const esic = { Type: "DeveloperExtensions", BaseVersion: "1.7", ExtensionLevel: 1 };
    if (extensionsEntry === undefined) {
      catalog.set(N("Extensions"), context.obj({ ESIC: esic }));
    } else if (extensionsEntry instanceof PDFDict && !extensionsEntry.has(N("ESIC"))) {
      extensionsEntry.set(N("ESIC"), context.obj(esic));
    }
  }
  if (catalogChanged) touch(raw.root);

  // --- signature dictionary -------------------------------------------------------------------
  const time = new Date(Math.floor(signingTime.getTime() / 1000) * 1000);
  const sigDict = buildSignatureDictionary({
    subFilter,
    contentsBytes,
    m: pdfDate(time, Math.round(timeZoneOffsetMinutes)),
    name,
    reason,
    location,
    contactInfo,
    appName,
    certify
  });

  // --- serialise ------------------------------------------------------------------------------
  const objects = [{ objectNumber: sigRef.objectNumber, generationNumber: 0, body: sigDict.body }];
  for (const [ref, object] of dirty.values()) {
    if (ref.objectNumber >= firstNew) continue;
    if (object instanceof PDFStream) throw internal("rewrite-stream", `refusing to rewrite stream object ${ref.tag}`);
    objects.push({ objectNumber: ref.objectNumber, generationNumber: ref.generationNumber, body: objectBytes(object) });
  }
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (ref.objectNumber < firstNew || ref.objectNumber === sigRef.objectNumber) continue;
    objects.push({ objectNumber: ref.objectNumber, generationNumber: ref.generationNumber, body: objectBytes(object) });
  }
  const size = context.largestObjectNumber + 1;
  throwIfAborted(signal);

  const secondId = newDocumentId instanceof Uint8Array && newDocumentId.length ? newDocumentId : randomBytes(16);
  const update = buildIncrementalUpdate({
    original: bytes,
    objects,
    xrefType: raw.type,
    prevXrefOffset: raw.startxref.xrefOffset,
    size,
    root: raw.root,
    info: raw.info,
    id: raw.id ? [raw.id[0], secondId] : [secondId, secondId]
  });

  // --- /ByteRange -----------------------------------------------------------------------------
  const out = update.bytes;
  const sigAt = update.offsets.get(sigRef.objectNumber).bodyOffset;
  const contentsStart = sigAt + sigDict.contentsAt; // offset of "<"
  const contentsEnd = contentsStart + sigDict.contentsLength; // offset after ">"
  const byteRange = [0, contentsStart, contentsEnd, out.length - contentsEnd];
  const text = `[${byteRange.join(" ")}`;
  if (text.length + 1 > sigDict.byteRangeLength) throw fail("SIGN_TOO_LARGE", {}, "the file is too large for the /ByteRange placeholder");
  out.set(latin1Encode(`${text.padEnd(sigDict.byteRangeLength - 1, " ")}]`), sigAt + sigDict.byteRangeAt);
  if (out[contentsStart] !== 0x3c || out[contentsEnd - 1] !== 0x3e) throw internal("contents-placeholder", "/Contents placeholder is not where it was written");

  return {
    bytes: out,
    byteRange,
    contentsStart,
    contentsEnd,
    contentsBytes,
    subFilter,
    signingTime: time,
    fieldName: finalFieldName,
    pageIndex: targetIndex,
    pageRotation: page.rotation,
    rect,
    xrefType: raw.type,
    originalLength: bytes.length,
    updateStart: update.updateStart,
    startxref: update.startxref,
    rewrittenObjects: [...dirty.values()].map(([ref]) => ref.tag).sort(),
    newObjectNumbers: objects.map((object) => object.objectNumber).filter((number) => number >= firstNew).sort((a, b) => a - b),
    xrefStreamObjectNumber: update.xrefStreamObjectNumber,
    previousSignatures: form.signatures.length,
    usedExistingField: Boolean(existing),
    visible: Boolean(apRef),
    certified: certify || 0,
    warnings
  };
}

/** The bytes a signature covers: everything except the /Contents value. */
export function signedBytes(prepared) {
  const [a, b, c, d] = prepared.byteRange;
  const out = new Uint8Array(b + d);
  out.set(prepared.bytes.subarray(a, a + b), 0);
  out.set(prepared.bytes.subarray(c, c + d), b);
  return out;
}

/** Phase 3: writes the CMS into the placeholder (in place) and returns the file. */
export function embedSignature(prepared, cmsDer) {
  if (cmsDer.length > prepared.contentsBytes) {
    throw fail("SIGN_PLACEHOLDER_TOO_SMALL", { needed: cmsDer.length, available: prepared.contentsBytes });
  }
  const hexText = toHex(cmsDer);
  const at = prepared.contentsStart + 1;
  for (let i = 0; i < hexText.length; i++) prepared.bytes[at + i] = hexText.charCodeAt(i);
  return prepared.bytes;
}

/** Cheap structural invariants of a signed result (no cryptography): a failure returns nothing at all. */
function checkOutput(original, prepared, cmsDer) {
  const out = prepared.bytes;
  if (out.length < original.length) throw internal("output-shorter", "the output is shorter than the input");
  for (let i = 0; i < original.length; i++) {
    if (out[i] !== original[i]) throw internal("prefix-modified", `byte ${i} of the original was modified`);
  }
  const [a, b, c, d] = prepared.byteRange;
  if (a !== 0 || c + d !== out.length || b !== prepared.contentsStart || c !== prepared.contentsEnd) {
    throw internal("byte-range", "/ByteRange does not describe the file");
  }
  let hexText = "";
  for (let i = b + 1, end = b + 1 + cmsDer.length * 2; i < end; i++) hexText += String.fromCharCode(out[i]);
  const back = fromHex(hexText);
  if (berLength(back) !== cmsDer.length) throw internal("embedded-cms", "the embedded CMS is not the one that was built");
  for (let i = 0; i < cmsDer.length; i++) if (back[i] !== cmsDer[i]) throw internal("embedded-cms", "the embedded CMS differs");
}

/**
 * Signs `pdfBytes` and returns { bytes, ...details }.
 *
 * options.signer        { certificate: Uint8Array (DER), chain?: Uint8Array[] (DER), privateKey: CryptoKey }
 * options.subFilter     "ETSI.CAdES.detached" (default, PAdES) | "adbe.pkcs7.detached"
 * options.signingTime   Date (default now): /M, and the signing-time attribute of adbe.pkcs7.detached
 * options.timeZoneOffsetMinutes   offset used to write /M (default: the local zone)
 * options.name / reason / location / contactInfo   text strings (any Unicode)
 * options.fieldName     default: first free "SignatureN"; the name of an EMPTY signature field = sign that field
 * options.appearance    null (invisible: widget with /Rect [0 0 0 0] on options.pageIndex or page 0) or
 *                       { pageIndex, rect: [x0, y0, x1, y1] (page user space), png: Uint8Array, fit?: "contain" | "stretch" }
 * options.certify       0 (default) | 1 | 2 | 3: certification signature (DocMDP), only for an unsigned document
 * options.timestamp     { request: async (tsq: Uint8Array) => Uint8Array, tokenBytes?, policyOid? }: RFC 3161
 *                       signature timestamp through a function the CALLER supplies (never used by default)
 * options.headroom      extra bytes in /Contents beyond the computed CMS size (default 512)
 * options.signal        AbortSignal
 */
export async function signPdfDetailed(pdfBytes, options = {}) {
  const { signer, subFilter = SUBFILTER_PADES, timestamp = null, headroom = DEFAULT_HEADROOM, signal } = options;
  if (subFilter !== SUBFILTER_PADES && subFilter !== SUBFILTER_PKCS7) throw fail("SIGN_BAD_SUBFILTER", { subFilter: String(subFilter) });
  if (!Number.isInteger(headroom) || headroom < 0 || headroom > 1 << 20) throw fail("SIGN_BAD_OPTIONS", { option: "headroom" });
  const requestedTime = options.signingTime === undefined || options.signingTime === null ? new Date() : options.signingTime;
  if (!(requestedTime instanceof Date) || Number.isNaN(requestedTime.getTime())) throw fail("SIGN_BAD_OPTIONS", { option: "signingTime" });
  throwIfAborted(signal);
  const { cert: signerCertificate } = describeSigner(signer); // fail early, before any PDF work
  const signingTime = new Date(Math.floor(requestedTime.getTime() / 1000) * 1000);

  let tokenBytes = 0;
  if (timestamp) tokenBytes = Number.isInteger(timestamp.tokenBytes) ? timestamp.tokenBytes : await measureTimestampTokenSize(timestamp);
  for (let attempt = 1; ; attempt++) {
    const cmsSize = await estimateCmsSize({ signer, subFilter, signingTime, timestampTokenBytes: tokenBytes ? tokenBytes + 64 : 0 });
    const contentsBytes = cmsSize + headroom;
    const prepared = await prepareSignature(pdfBytes, { ...options, subFilter, signingTime, contentsBytes });
    throwIfAborted(signal);
    const documentDigest = await digest("SHA-256", signedBytes(prepared));
    throwIfAborted(signal);
    const cms = await createCms({ documentDigest, signer, subFilter, signingTime, timestamp });
    if (cms.der.length > contentsBytes) {
      // only a timestamp token larger than announced can cause this: redo ONCE with the real size (the
      // placeholder size changes /ByteRange and therefore the signature)
      if (timestamp && attempt === 1 && cms.timestampToken) {
        tokenBytes = cms.timestampToken.length + 256;
        continue;
      }
      throw fail("SIGN_PLACEHOLDER_TOO_SMALL", { needed: cms.der.length, available: contentsBytes });
    }
    const bytes = embedSignature(prepared, cms.der);
    checkOutput(pdfBytes, prepared, cms.der);
    throwIfAborted(signal);
    const details = { ...prepared };
    delete details.bytes;
    const facts = await certificateFacts(signerCertificate, { now: signingTime, role: "signer" });
    return {
      bytes,
      ...details,
      warnings: [...details.warnings, ...facts.warnings],
      cmsBytes: cms.der.length,
      cmsEstimate: cmsSize,
      mechanism: cms.mechanism,
      certificateCount: cms.certificateCount,
      timestamp: cms.timestampInfo ? { genTime: cms.timestampInfo.genTime, tokenBytes: cms.timestampToken.length, policy: cms.timestampInfo.policy } : null,
      attempts: attempt
    };
  }
}
