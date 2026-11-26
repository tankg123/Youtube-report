// Cross-reference data written AFTER a signature, checked against the object-by-object comparison of
// ./revisionDiff.js. Browser + Node.
//
// Why: the PDF library reads every object in file order ("the last definition wins") and ignores the
// cross-reference sections; a viewer does the opposite. A revision appended after a signature can therefore
// change what a viewer shows without adding or changing a single object:
//   - an entry that marks an object of the signed document as free (a page's content stream disappears);
//   - an entry that points an object number at OTHER bytes of the signed part (an older or a hidden
//     definition), or at one of two definitions in the appended part;
//   - a chain of sections that no longer reaches a revision of the signed document (/Prev missing or
//     pointing at an older section, a last startxref that points back): its objects drop out;
//   - a trailer that names another catalog, or switches encryption on or off.
// The audit builds the two pictures a viewer has (every object number -> where its definition is), one for
// the signed document and one for the file as it is now, and compares them: an object may only keep its
// place, or be defined anew after the signed part, and in that case the old and the new definition must be
// the two the comparison looked at. Whatever it cannot confirm is reported as a change that is not allowed:
// nothing is passed on a guess.

import { pdfLib } from "../lib.js";
import { findLastStartXref, readXrefSectionAt } from "./pdfRaw.js";
import { asciiBytes, indexOfBytes, parseObject as scanDirectObject, readUnsigned, skipWhiteSpace, startsWithAt } from "./pdfScan.js";

const KW_OBJ = asciiBytes("obj");
const KW_XREF = asciiBytes("xref");
const KW_TRAILER = asciiBytes("trailer");
const KW_STREAM = asciiBytes("stream");
const KW_ENDSTREAM = asciiBytes("endstream");

const FREE = 0;
const IN_USE = 1;
const COMPRESSED = 2;

// a hostile file must not keep the page busy: beyond these the answer is "unreadable"
const MAX_SECTIONS = 4096;
const MAX_ENTRIES = 1000000; // entries looked at per picture (ISO 32000 allows 8 388 607 objects; real files stay far below)
const MAX_ITEMS = 64; // findings reported (the first ones)

const name = (text) => pdfLib.PDFName.of(text);
const numberOf = (value) => (value instanceof pdfLib.PDFNumber ? value.asNumber() : null);
const numbersOf = (value) => (value instanceof pdfLib.PDFArray ? value.asArray().map(numberOf) : null);
const isStream = (object) => Boolean(object && object.dict && typeof object.getContents === "function");

/** /DecodeParms of the (last) filter, when it is a dictionary. */
function decodeParms(dict) {
  const parms = dict.get(name("DecodeParms"));
  if (parms instanceof pdfLib.PDFDict) return parms;
  if (parms instanceof pdfLib.PDFArray) {
    for (let i = parms.size() - 1; i >= 0; i--) if (parms.get(i) instanceof pdfLib.PDFDict) return parms.get(i);
  }
  return null;
}

/** Undoes the row predictor of a decoded stream (the library inflates, but leaves the prediction in place). */
function undoPredictor(data, parms) {
  const setting = (key, fallback) => {
    const value = parms ? numberOf(parms.get(name(key))) : null;
    return value === null ? fallback : value;
  };
  const predictor = setting("Predictor", 1);
  if (predictor === 1) return data;
  const colors = setting("Colors", 1);
  const bits = setting("BitsPerComponent", 8);
  const pixel = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowLength = Math.ceil((setting("Columns", 1) * colors * bits) / 8);
  if (!(rowLength > 0) || rowLength > 65536) throw new Error("predictor");
  if (predictor === 2) {
    if (bits !== 8) throw new Error("predictor");
    const out = Uint8Array.from(data);
    for (let row = 0; row + rowLength <= out.length; row += rowLength) {
      for (let i = pixel; i < rowLength; i++) out[row + i] = (out[row + i] + out[row + i - pixel]) & 255;
    }
    return out;
  }
  if (predictor < 10 || predictor > 15) throw new Error("predictor");
  // PNG filters: every row starts with the number of its filter
  const stride = rowLength + 1;
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * rowLength);
  for (let row = 0; row < rows; row++) {
    const filter = data[row * stride];
    const source = row * stride + 1;
    const target = row * rowLength;
    for (let i = 0; i < rowLength; i++) {
      const left = i >= pixel ? out[target + i - pixel] : 0;
      const up = row > 0 ? out[target - rowLength + i] : 0;
      const upLeft = row > 0 && i >= pixel ? out[target - rowLength + i - pixel] : 0;
      let predicted;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const byLeft = Math.abs(estimate - left);
        const byUp = Math.abs(estimate - up);
        const byUpLeft = Math.abs(estimate - upLeft);
        predicted = byLeft <= byUp && byLeft <= byUpLeft ? left : (byUp <= byUpLeft ? up : upLeft);
      } else throw new Error("predictor");
      out[target + i] = (data[source + i] + predicted) & 255;
    }
  }
  return out;
}

/**
 * Calls visit(number, type, a, b) for every entry of the cross-reference section at `offset`:
 *   FREE        b = generation
 *   IN_USE      a = byte offset, b = generation
 *   COMPRESSED  a = number of the object stream, b = index in it
 * An entry type a cross-reference stream may not use counts as FREE (ISO 32000: "a reference to the null
 * object"). -> { dict, prev: number | null, xrefStm: number | null }. Throws when the section cannot be read.
 */
function visitSection(bytes, offset, visit) {
  const section = readXrefSectionAt(bytes, offset);
  const dict = section.dict;
  const facts = { dict, prev: numberOf(dict.get(name("Prev"))), xrefStm: null };
  if (section.type === "table") {
    facts.xrefStm = numberOf(dict.get(name("XRefStm")));
    let p = skipWhiteSpace(bytes, skipWhiteSpace(bytes, offset) + KW_XREF.length);
    while (!startsWithAt(bytes, KW_TRAILER, p)) {
      const first = readUnsigned(bytes, p);
      const count = first && readUnsigned(bytes, skipWhiteSpace(bytes, first.end));
      if (!count) throw new Error("subsection");
      p = skipWhiteSpace(bytes, count.end);
      for (let i = 0; i < count.value; i++) {
        const a = readUnsigned(bytes, p);
        const b = a && readUnsigned(bytes, skipWhiteSpace(bytes, a.end));
        const keyword = b ? skipWhiteSpace(bytes, b.end) : -1;
        if (!b || (bytes[keyword] !== 0x6e && bytes[keyword] !== 0x66)) throw new Error("entry"); // n | f
        visit(first.value + i, bytes[keyword] === 0x6e ? IN_USE : FREE, a.value, b.value);
        p = skipWhiteSpace(bytes, keyword + 1);
      }
    }
    return facts;
  }

  if (!isStream(section.stream)) throw new Error("stream");
  const widths = numbersOf(dict.get(name("W")));
  if (!widths || widths.length < 3 || widths.some((width) => !Number.isInteger(width) || width < 0 || width > 8)) throw new Error("widths");
  const index = numbersOf(dict.get(name("Index"))) || [0, numberOf(dict.get(name("Size")))];
  if (index.length % 2 || index.some((value) => !Number.isInteger(value) || value < 0)) throw new Error("index");
  const data = undoPredictor(pdfLib.decodePDFRawStream(section.stream).decode(), decodeParms(dict));
  const [typeWidth, firstWidth, secondWidth] = widths;
  const rowLength = typeWidth + firstWidth + secondWidth;
  if (!rowLength) throw new Error("widths");
  let at = 0;
  const field = (width, fallback) => {
    if (!width) return fallback;
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + data[at++];
    return value;
  };
  for (let s = 0; s < index.length; s += 2) {
    for (let i = 0; i < index[s + 1]; i++) {
      if (at + rowLength > data.length) throw new Error("rows");
      const type = field(typeWidth, IN_USE);
      const a = field(firstWidth, 0);
      const b = field(secondWidth, 0);
      visit(index[s] + i, type === IN_USE || type === COMPRESSED ? type : FREE, a, b);
    }
  }
  return facts;
}

/**
 * The picture a viewer has when it follows the cross-reference sections from `head`: for every object number
 * the entry of the newest section that mentions it (in a hybrid file the cross-reference stream of a section
 * supplies what its table lists as free or not at all). A section that cannot be read ends the chain, as it
 * does in a viewer (a tool that writes "/Prev 0" exists); when the FIRST one cannot be read, or the file asks
 * for more entries than MAX_ENTRIES, there is no picture (null).
 * -> { entries: Map<number, { type, a, b }>, trailer: PDFDict of the newest section, sections: Set<offset> } | null
 */
function xrefView(bytes, head) {
  const entries = new Map();
  const seen = new Set();
  let trailer = null;
  let visits = 0;
  let offset = head;
  while (offset !== null && !seen.has(offset) && seen.size < MAX_SECTIONS) {
    seen.add(offset);
    const local = new Map();
    const collect = (hidden) => (number, type, a, b) => {
      if (++visits > MAX_ENTRIES) throw new RangeError("entries");
      if (entries.has(number)) return;
      const known = local.get(number);
      if (!known || (hidden && known.type === FREE && type !== FREE)) local.set(number, { type, a, b });
    };
    let section;
    try {
      section = visitSection(bytes, offset, collect(false));
      if (section.xrefStm !== null) visitSection(bytes, section.xrefStm, collect(true));
    } catch (error) {
      if (error instanceof RangeError || !trailer) return null;
      break; // an older section that cannot be read: what only it defined is gone for a viewer too
    }
    for (const [number, entry] of local) entries.set(number, entry);
    if (!trailer) trailer = section.dict;
    offset = section.prev;
  }
  return { entries, trailer, sections: seen };
}

/**
 * Where the data of a stream ends, decided as the PDF library decides it: at /Length when "endstream" follows
 * there, else before the "endstream" that closes it (a "stream" keyword inside the data opens another level,
 * and one end-of-line before "endstream" is not data). -1: no end. Plain searches, so that a stream without a
 * usable /Length costs a scan at memory speed and not the library's byte-by-byte search.
 */
function streamDataEnd(bytes, dataStart, lengthNode) {
  if (lengthNode && lengthNode.type === "number" && Number.isInteger(lengthNode.value) && lengthNode.value >= 0) {
    const end = dataStart + lengthNode.value;
    if (end <= bytes.length && startsWithAt(bytes, KW_ENDSTREAM, skipWhiteSpace(bytes, end))) return end;
  }
  let nesting = 1;
  let from = dataStart;
  for (;;) {
    const at = indexOfBytes(bytes, KW_STREAM, from);
    if (at < 0) return -1;
    const closes = at - 3 >= from && bytes[at - 3] === 0x65 && bytes[at - 2] === 0x6e && bytes[at - 1] === 0x64; // "end"
    if (!closes) nesting++;
    else if (--nesting === 0) {
      const end = at - 3;
      if (end - 2 >= from && bytes[end - 2] === 13 && bytes[end - 1] === 10) return end - 2;
      if (end - 1 >= from && (bytes[end - 1] === 13 || bytes[end - 1] === 10)) return end - 1;
      return end;
    }
    from = at + KW_STREAM.length;
  }
}

/**
 * The object a viewer finds at `offset` when it expects "number generation obj" there, or null.
 * The extent of the object is found with the tokenizer of ./pdfScan.js, the object itself is built by the PDF
 * library from exactly those bytes (so that it compares equal with what the library read from the file).
 * `work` = { used, budget } in bytes looked at: a hostile file could ask for a long search once per entry;
 * beyond the budget the audit stops ("unreadable").
 */
function readObjectAt(bytes, offset, number, generation, work) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) return null;
  const n = readUnsigned(bytes, skipWhiteSpace(bytes, offset));
  const g = n && readUnsigned(bytes, skipWhiteSpace(bytes, n.end));
  const keyword = g ? skipWhiteSpace(bytes, g.end) : -1;
  if (!g || n.value !== number || g.value !== generation || !startsWithAt(bytes, KW_OBJ, keyword)) return null;
  if (work.used > work.budget) throw new Error("budget");
  const fromLibrary = (start, end) => pdfLib.PDFObjectParser.forBytes(bytes.subarray(start, end), pdfLib.PDFContext.create()).parseObject();
  try {
    const node = scanDirectObject(bytes, keyword + KW_OBJ.length);
    work.used += node.end - offset;
    if (node.type !== "dict") return fromLibrary(node.start, node.end);
    let p = skipWhiteSpace(bytes, node.end);
    if (!startsWithAt(bytes, KW_STREAM, p)) return fromLibrary(node.start, node.end);
    // "stream" + ( SP CR LF | CR LF | CR | LF | nothing ), in the order the library tries them
    p += KW_STREAM.length;
    if (bytes[p] === 32 && bytes[p + 1] === 13 && bytes[p + 2] === 10) p += 3;
    else if (bytes[p] === 13 && bytes[p + 1] === 10) p += 2;
    else if (bytes[p] === 13 || bytes[p] === 10) p += 1;
    const end = streamDataEnd(bytes, p, node.entries.get("Length"));
    work.used += end < 0 ? bytes.length - p : end - p;
    if (end < 0) return null;
    const dict = fromLibrary(node.start, node.end);
    return dict instanceof pdfLib.PDFDict ? pdfLib.PDFRawStream.of(dict, bytes.subarray(p, end)) : null;
  } catch {
    return null;
  }
}

/** The objects inside the object stream `streamNumber` found at `offset`: Map<number, PDFObject>, or null. */
async function objectsInStream(bytes, offset, streamNumber, work) {
  const container = readObjectAt(bytes, offset, streamNumber, 0, work);
  if (!isStream(container) || container.dict.get(name("Type")) !== name("ObjStm")) return null;
  try {
    await pdfLib.PDFObjectStreamParser.forStream(container).parseIntoContext();
  } catch {
    return null;
  }
  const objects = new Map();
  for (const [ref, object] of container.dict.context.enumerateIndirectObjects()) objects.set(ref.objectNumber, object);
  return objects;
}

/**
 * @param {Uint8Array} bytes             the whole file
 * @param {number} signedEnd             end of the signed range
 * @param {Map<string, object>} before   objects of the signed prefix as the comparison saw them ("12 0" -> object)
 * @param {Map<string, object>} after    objects of the whole file as the comparison saw them
 * @param {(a: object, b: object) => boolean} sameObject
 * @returns {Promise<{ items: { code: string, params: object, allowed: false }[], defined: string[] }>}
 *          items: SIGN_CHANGE_XREF { reason, object } | SIGN_CHANGE_OBJECT_REMOVED { object } |
 *          SIGN_CHANGE_CATALOG_REPLACED (at most MAX_ITEMS); defined: objects ("12 0") that did not exist for a
 *          viewer of the signed document and do now
 */
export async function auditLaterXref(bytes, signedEnd, before, after, sameObject) {
  const items = [];
  const result = { items, defined: [] };
  const push = (code, params) => {
    if (items.length < MAX_ITEMS) items.push({ code, params, allowed: false });
  };
  const flag = (reason, object = null) => push("SIGN_CHANGE_XREF", { reason, object });

  let last;
  try {
    last = findLastStartXref(bytes);
  } catch {
    return result; // no startxref anywhere: a viewer rebuilds such a file object by object, as the comparison does
  }
  if (last.keywordOffset < signedEnd) return result; // loose bytes after the signed part, no cross-reference data
  const prefix = bytes.subarray(0, signedEnd);
  let signedHead;
  try {
    signedHead = findLastStartXref(prefix).xrefOffset;
  } catch {
    flag("unreadable");
    return result;
  }
  if (last.xrefOffset === signedHead) return result; // a repeated "startxref" that points at the signed revision itself

  // 1. the two pictures: what a viewer resolved in the signed document, and what it resolves now
  const now = xrefView(bytes, last.xrefOffset);
  const then = xrefView(prefix, signedHead);
  const rootOf = (dict) => (dict.get(name("Root")) instanceof pdfLib.PDFRef ? dict.get(name("Root")).toString() : null);
  const encryptionOf = (dict) => (dict.get(name("Encrypt")) ? dict.get(name("Encrypt")).toString() : null);
  if (!now || !then || !rootOf(now.trailer)) {
    flag("unreadable");
    return result;
  }
  if (rootOf(now.trailer) !== rootOf(then.trailer)) push("SIGN_CHANGE_CATALOG_REPLACED", {});
  if (encryptionOf(now.trailer) !== encryptionOf(then.trailer)) flag("encryption");

  // 2. object by object. An entry for bytes of the signed part is harmless only when it says what the signed
  //    revision said (a later section may repeat the whole table); an object that the signed picture had and
  //    the present one lacks is gone (a free entry, or a chain that no longer reaches its section).
  const keyOf = (number, entry) => `${number} ${entry.type === IN_USE ? entry.b : 0}`;
  const isNewContainer = (streamNumber) => {
    const container = now.entries.get(streamNumber);
    return Boolean(container && container.type === IN_USE && container.a >= signedEnd);
  };
  const redefined = [];
  const lost = []; // [code, params] of objects that are gone or re-pointed
  for (const [number, entry] of now.entries) {
    if (number === 0) continue;
    const was = then.entries.get(number) || null;
    const existed = Boolean(was && was.type !== FREE);
    if (entry.type === FREE) {
      if (existed) lost.push(["SIGN_CHANGE_OBJECT_REMOVED", { object: keyOf(number, was) }]);
      continue;
    }
    const pointsBack = entry.type === IN_USE ? entry.a < signedEnd : !isNewContainer(entry.a);
    if (pointsBack) {
      if (!was || was.type !== entry.type || was.a !== entry.a || was.b !== entry.b) lost.push(["SIGN_CHANGE_XREF", { reason: "redirected", object: keyOf(number, entry) }]);
      continue;
    }
    redefined.push({ number, entry, was: existed ? was : null });
  }
  for (const [number, was] of then.entries) {
    if (number !== 0 && was.type !== FREE && !now.entries.has(number)) lost.push(["SIGN_CHANGE_OBJECT_REMOVED", { object: keyOf(number, was) }]);
  }
  if (lost.length && !now.sections.has(signedHead)) {
    // the sections after the signature do not lead to the signed revision any more (no /Prev, a /Prev or a
    // last startxref into an older revision): one finding instead of one per object
    flag("chain");
    return result;
  }
  for (const [code, params] of lost) push(code, params);

  // 3. objects defined anew after the signed part: both definitions a viewer sees must be the compared ones
  const work = { used: 0, budget: Math.max(64 * 1024 * 1024, 8 * bytes.length) };
  const cache = new Map();
  const inStream = async (source, tag, streamOffset, streamNumber, number) => {
    const key = `${tag} ${streamOffset}`;
    if (!cache.has(key)) cache.set(key, await objectsInStream(source, streamOffset, streamNumber, work));
    const objects = cache.get(key);
    return (objects && objects.get(number)) || null;
  };
  try {
    for (const { number, entry, was } of redefined) {
      const key = keyOf(number, entry);
      const shown = entry.type === IN_USE
        ? readObjectAt(bytes, entry.a, number, entry.b, work)
        : await inStream(bytes, "after", now.entries.get(entry.a).a, entry.a, number);
      if (!shown) {
        flag("ambiguous", key);
        continue;
      }
      const type = isStream(shown) ? shown.dict.get(name("Type")) : null;
      if ((type === name("XRef") || type === name("ObjStm")) && !was && !before.has(key)) {
        result.defined.push(key); // the section itself, a new container: no part of the document
        continue;
      }
      const compared = after.get(key);
      if (!compared || !sameObject(shown, compared)) {
        flag("ambiguous", key);
        continue;
      }
      if (!was) {
        // the signed part may hold a definition that its own cross-reference data did not use
        if (before.has(key)) flag("ambiguous", key);
        else result.defined.push(key);
        continue;
      }
      const wasKey = keyOf(number, was);
      if (wasKey !== key) {
        // the number now belongs to another generation: references to the old one find nothing
        push("SIGN_CHANGE_OBJECT_REMOVED", { object: wasKey });
        continue;
      }
      let base = null;
      if (was.type === IN_USE) base = readObjectAt(prefix, was.a, number, was.b, work);
      else {
        const container = then.entries.get(was.a);
        if (container && container.type === IN_USE) base = await inStream(prefix, "before", container.a, was.a, number);
      }
      const comparedBase = before.get(key);
      if (!base || !comparedBase || !sameObject(base, comparedBase)) flag("ambiguous", key);
    }
  } catch {
    flag("unreadable"); // more work than a document of this size can honestly ask for
  }
  return result;
}
