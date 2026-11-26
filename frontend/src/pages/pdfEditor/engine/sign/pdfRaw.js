// Facts read from the raw bytes of a PDF, independent of how the PDF library models the file: where the
// header is, where the LAST cross-reference section starts, whether it is a table or a stream, and what its
// trailer says. An incremental update is built on exactly these facts (the library's parser scans the file
// object by object and does not use the cross-reference data at all).
// Browser + Node. Only the dictionary parser of the PDF library is used here.

import { PdfEditorError } from "../errors.js";
import { pdfLib } from "../lib.js";
import { asciiBytes, indexOfBytes, lastIndexOfBytes, readUnsigned, skipWhiteSpace, startsWithAt } from "./pdfScan.js";

const KW = {
  header: asciiBytes("%PDF-"),
  startxref: asciiBytes("startxref"),
  eof: asciiBytes("%%EOF"),
  xref: asciiBytes("xref"),
  trailer: asciiBytes("trailer"),
  obj: asciiBytes("obj")
};

const damaged = (reason, detail, cause) => new PdfEditorError("SIGN_DAMAGED_XREF", { reason }, { detail, cause });

/** %PDF-x.y must be the first bytes of the file: offsets in the update are counted from byte 0. */
export function readHeader(bytes) {
  const at = indexOfBytes(bytes, KW.header, 0, Math.min(bytes.length, 1024 + KW.header.length));
  if (at < 0) throw new PdfEditorError("SIGN_NOT_A_PDF", {}, { detail: "the file has no %PDF- header" });
  const match = /^(\d)\.(\d)/.exec(String.fromCharCode(...bytes.subarray(at + 5, at + 8)));
  return { offset: at, version: match ? `${match[1]}.${match[2]}` : null, major: match ? Number(match[1]) : null, minor: match ? Number(match[2]) : null };
}

/**
 * The last `startxref` of the file (searched backwards through the WHOLE file, so trailing junk after
 * %%EOF does not matter).
 */
export function findLastStartXref(bytes) {
  let at = lastIndexOfBytes(bytes, KW.startxref);
  while (at >= 0) {
    const number = readUnsigned(bytes, skipWhiteSpace(bytes, at + KW.startxref.length));
    if (number) {
      const q = skipWhiteSpace(bytes, number.end);
      const hasEof = startsWithAt(bytes, KW.eof, q);
      return {
        keywordOffset: at,
        xrefOffset: number.value,
        eofOffset: hasEof ? q : null,
        // bytes after "%%EOF" (a single EOL is normal; anything else is junk that the update leaves in place)
        bytesAfterEof: hasEof ? bytes.length - (q + KW.eof.length) : null
      };
    }
    at = lastIndexOfBytes(bytes, KW.startxref, at - 1);
  }
  throw damaged("no-startxref", "the file has no startxref: its cross-reference data cannot be located");
}

const refOf = (value) => (value instanceof pdfLib.PDFRef ? value : null);
const numberOf = (value) => (value instanceof pdfLib.PDFNumber ? value.asNumber() : null);
const stringBytes = (value) => (value instanceof pdfLib.PDFHexString || value instanceof pdfLib.PDFString ? value.asBytes() : null);

/**
 * Reads ONE cross-reference section (table + trailer, or cross-reference stream) at `offset`.
 * @returns {{ type: "table" | "stream", offset: number, dict: PDFDict, xrefStreamRef: PDFRef | null,
 *            stream: PDFRawStream | null }}  stream: the cross-reference stream itself (its data holds the entries)
 */
export function readXrefSectionAt(bytes, offset) {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= bytes.length) {
    throw damaged("bad-startxref", `a cross-reference offset points outside the file (${offset})`);
  }
  const p = skipWhiteSpace(bytes, offset);
  const context = pdfLib.PDFContext.create();
  const name = (text) => pdfLib.PDFName.of(text);

  if (startsWithAt(bytes, KW.xref, p)) {
    // Entries hold only digits, blanks and the letters n / f, so the next "trailer" is the keyword.
    const t = indexOfBytes(bytes, KW.trailer, p);
    if (t < 0) throw damaged("bad-xref", "cross-reference table without a trailer");
    const d = skipWhiteSpace(bytes, t + KW.trailer.length);
    let parsed;
    try {
      parsed = pdfLib.PDFObjectParser.forBytes(bytes.subarray(d, Math.min(bytes.length, d + 65536)), context).parseObject();
    } catch (error) {
      throw damaged("bad-xref", "the trailer dictionary cannot be parsed", error);
    }
    if (!(parsed instanceof pdfLib.PDFDict)) throw damaged("bad-xref", "the trailer is not a dictionary");
    return { type: "table", offset, dict: parsed, xrefStreamRef: null, stream: null };
  }

  // "N G obj << ... /Type /XRef ... >> stream"
  const objectNumber = readUnsigned(bytes, p);
  const generation = objectNumber && readUnsigned(bytes, skipWhiteSpace(bytes, objectNumber.end));
  const keyword = generation ? skipWhiteSpace(bytes, generation.end) : -1;
  if (!objectNumber || !generation || !startsWithAt(bytes, KW.obj, keyword)) {
    throw damaged("bad-startxref", `offset ${offset} holds neither an xref table nor an object: the cross-reference data of this file is damaged`);
  }
  const d = skipWhiteSpace(bytes, keyword + KW.obj.length);
  let parsed;
  try {
    parsed = pdfLib.PDFObjectParser.forBytes(bytes.subarray(d), context).parseObject();
  } catch (error) {
    throw damaged("bad-xref", "the cross-reference stream cannot be parsed", error);
  }
  const dict = parsed instanceof pdfLib.PDFDict ? parsed : parsed && parsed.dict;
  if (!(dict instanceof pdfLib.PDFDict) || dict.get(name("Type")) !== name("XRef")) {
    throw damaged("bad-startxref", `the object at offset ${offset} is not a cross-reference stream`);
  }
  return { type: "stream", offset, dict, xrefStreamRef: pdfLib.PDFRef.of(objectNumber.value, generation.value), stream: parsed instanceof pdfLib.PDFDict ? null : parsed };
}

/**
 * Reads the cross-reference section the last startxref points to: the facts an incremental update is built on.
 * @returns {{ type: "table" | "stream", offset: number, hybrid: boolean, size: number, root: PDFRef,
 *            info: PDFRef | null, id: [Uint8Array, Uint8Array] | null, prev: number | null, encrypt: boolean,
 *            xrefStreamRef: PDFRef | null, startxref: object, header: object }}
 * @throws SIGN_NOT_A_PDF | SIGN_LEADING_BYTES | SIGN_DAMAGED_XREF
 */
export function readLastXrefSection(bytes) {
  const header = readHeader(bytes);
  if (header.offset !== 0) {
    throw new PdfEditorError("SIGN_LEADING_BYTES", { count: header.offset }, { detail: `${header.offset} byte(s) precede the %PDF- header: byte offsets are ambiguous in such a file, so it cannot be extended safely` });
  }
  const startxref = findLastStartXref(bytes);
  const { type, dict, xrefStreamRef } = readXrefSectionAt(bytes, startxref.xrefOffset);
  const name = (text) => pdfLib.PDFName.of(text);
  const size = numberOf(dict.get(name("Size")));
  const root = refOf(dict.get(name("Root")));
  if (!Number.isInteger(size) || size <= 0) throw damaged("bad-xref", "the trailer has no valid /Size");
  if (!root) throw damaged("bad-xref", "the trailer has no /Root reference");
  const idArray = dict.get(name("ID"));
  let id = null;
  if (idArray instanceof pdfLib.PDFArray && idArray.size() === 2) {
    const first = stringBytes(idArray.get(0));
    const second = stringBytes(idArray.get(1));
    if (first && second) id = [first, second];
  }
  return {
    type,
    offset: startxref.xrefOffset,
    hybrid: type === "table" && dict.has(name("XRefStm")),
    size,
    root,
    info: refOf(dict.get(name("Info"))),
    id,
    prev: numberOf(dict.get(name("Prev"))),
    encrypt: dict.has(name("Encrypt")),
    xrefStreamRef,
    startxref,
    header
  };
}

/**
 * Walks the /Prev chain from the last section. Nothing here throws for an OLDER section: a problem is
 * reported in `problems` (a viewer would rebuild such a file; an update appended to it is no worse).
 * @param {object} [last]  the result of readLastXrefSection(bytes) when the caller already has it
 * @returns {{ sections: { type, offset, hybrid, size, prev }[], hybrid: boolean, mixed: boolean, maxSize: number,
 *            problems: string[] }}  problems: "prev-loop" | "too-many-sections" | "unreadable-section"
 */
export function readXrefChain(bytes, last = readLastXrefSection(bytes), { maxSections = 1024 } = {}) {
  const name = (text) => pdfLib.PDFName.of(text);
  const sections = [{ type: last.type, offset: last.offset, hybrid: last.hybrid, size: last.size, prev: last.prev }];
  const problems = [];
  const seen = new Set([last.offset]);
  let prev = last.prev;
  while (prev !== null && prev !== undefined) {
    if (seen.has(prev)) {
      problems.push("prev-loop");
      break;
    }
    if (sections.length >= maxSections) {
      problems.push("too-many-sections");
      break;
    }
    seen.add(prev);
    let section;
    try {
      section = readXrefSectionAt(bytes, prev);
    } catch {
      problems.push("unreadable-section");
      break;
    }
    const size = numberOf(section.dict.get(name("Size")));
    const next = numberOf(section.dict.get(name("Prev")));
    sections.push({ type: section.type, offset: prev, hybrid: section.type === "table" && section.dict.has(name("XRefStm")), size, prev: next });
    prev = next;
  }
  return {
    sections,
    hybrid: sections.some((section) => section.hybrid),
    mixed: new Set(sections.map((section) => section.type)).size > 1,
    maxSize: Math.max(...sections.map((section) => section.size || 0)),
    problems
  };
}

/** True when the first object of the file is a linearization parameter dictionary. */
export function isLinearized(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
  return /\d+\s+\d+\s+obj\s*<<[^>]*\/Linearized[\s/]/.test(head);
}
