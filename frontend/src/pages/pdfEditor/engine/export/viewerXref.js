// Which definition of an object does the VIEWER read? The cross-reference information of a file, read the way
// pdf.js reads it.
//
// A viewer finds an object through the cross-reference sections: the section "startxref" points at, then
// /XRefStm and /Prev, and the first entry found for an object number wins. The parser of the writing library
// never looks at them: it reads the file from top to bottom and keeps the LAST definition of every object
// number. In an honest file both select the same bytes. In a prepared file they need not: the table can point
// at an earlier definition, mark a defined object as free, name an object stream that lists the number
// elsewhere ... and the editor would then show one document and export (and sign) another. robust.js compares
// the two readings object by object; this module supplies the viewer's side.
//
//   readViewerXref(bytes, context)   -> { mode, entries, root, info, shift, ... } (see the function)
//   headerEnd(bytes, at, n, g)       -> where the header "n g obj" that starts at `at` ends, or -1
//
// It follows pdf.js 6 (src/core/xref.js: readXRef, readXRefTable, readXRefStream, indexObjects;
// src/core/document.js: startXRef, checkHeader; src/core/parser.js: Linearization) and is deliberately
// narrower than pdf.js: where the viewer is lenient (numbers written 1.0 or +1, a cross-reference stream
// whose /Length is wrong, a trailer the library cannot parse ...) the answer is mode "unknown", and the caller
// refuses the file. A wrong guess here would be a file that is exported differently from what was shown.
// When the section "startxref" names cannot be used at all, the viewer indexes the file by scanning it; that
// scan is reproduced as well (mode "scan", see scanAsViewer), because such files are common enough: a
// download with a damaged end, a file with something in front of its header.
import { pdfLib } from "../lib.js";
import { decodeStreamBytes } from "./content.js";
import { N, indexOfAscii, latin1 } from "./pdfUtil.js";

const { PDFObjectParser, PDFDict, PDFArray, PDFNumber, PDFRef, PDFRawStream, PDFNull } = pdfLib;

/** White space of the PDF syntax (ISO 32000-1 7.2.2), as both parsers skip it between tokens. */
const isBlank = (byte) => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const isDigit = (byte) => byte >= 0x30 && byte <= 0x39;
/** ( ) < > [ ] { } / % */
const isDelimiter = (byte) => byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d
  || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;

/** The position behind white space and comments. */
function skipBlank(bytes, from) {
  let at = from;
  for (;;) {
    while (at < bytes.length && isBlank(bytes[at])) at += 1;
    if (bytes[at] !== 0x25) return at;
    while (at < bytes.length && bytes[at] !== 10 && bytes[at] !== 13) at += 1;
  }
}

/**
 * One token of a cross-reference section:
 *   int    a run of digits and nothing else                                  { value }
 *   word   a run of regular characters (xref, trailer, obj, n, f ...)        { text }
 *   odd    a number in a form that only a lenient reader takes for a number: the viewer may accept it
 *   other  anything else (a name, a string, an array ...): never a number or a keyword for any reader
 *   end    nothing left
 */
function readToken(bytes, from) {
  let at = skipBlank(bytes, from);
  if (at >= bytes.length) return { kind: "end", end: at };
  const first = bytes[at];
  /** The end of everything a lenient reader may take into one number. */
  const numberEnd = (position) => {
    let end = position;
    while (end < bytes.length && (isDigit(bytes[end]) || bytes[end] === 0x2e || bytes[end] === 0x2d || bytes[end] === 0x2b || bytes[end] === 0x45 || bytes[end] === 0x65)) end += 1;
    return end;
  };
  if (isDigit(first)) {
    const start = at;
    while (at < bytes.length && isDigit(bytes[at])) at += 1;
    const next = bytes[at];
    // the viewer's number goes on behind a dot, a minus sign or an exponent
    if (next === 0x2e || next === 0x2d || ((next === 0x45 || next === 0x65) && (isDigit(bytes[at + 1]) || bytes[at + 1] === 0x2b || bytes[at + 1] === 0x2d))) {
      return { kind: "odd", end: numberEnd(at) };
    }
    if (at - start > 15) return { kind: "odd", end: at };
    return { kind: "int", value: Number(latin1(bytes, start, at)), end: at };
  }
  if (first === 0x2b || first === 0x2d || first === 0x2e) return { kind: "odd", end: numberEnd(at) };
  if (isDelimiter(first)) return { kind: "other", end: at + 1 };
  const start = at;
  while (at < bytes.length && !isBlank(bytes[at]) && !isDelimiter(bytes[at])) at += 1;
  return { kind: "word", text: latin1(bytes, start, at), end: at };
}

/**
 * Where the header "number generation obj" that starts at `at` (white space and comments in front are
 * skipped) ends: the offset just behind the keyword. -1 when there is no such header in the plain form that
 * both the viewer and the writer read.
 */
export function headerEnd(bytes, at, number, generation) {
  if (!(at >= 0) || at >= bytes.length) return -1;
  const first = readToken(bytes, at);
  if (first.kind !== "int" || first.value !== number) return -1;
  const second = readToken(bytes, first.end);
  if (second.kind !== "int" || second.value !== generation) return -1;
  const keyword = skipBlank(bytes, second.end);
  if (bytes[keyword] !== 0x6f || bytes[keyword + 1] !== 0x62 || bytes[keyword + 2] !== 0x6a) return -1;
  const behind = bytes[keyword + 3];
  // "obj" must be the whole keyword (the viewer reads "objx" as another one)
  if (behind !== undefined && !isBlank(behind) && !isDelimiter(behind)) return -1;
  return keyword + 3;
}

/** The dictionary that starts at `at`, parsed by the library; undefined when it is not one or does not parse. */
function parseDictAt(bytes, at, context) {
  const start = skipBlank(bytes, at);
  if (bytes[start] !== 0x3c || bytes[start + 1] !== 0x3c) return { start, dict: undefined, end: start };
  try {
    const parser = PDFObjectParser.forBytes(bytes.subarray(start), context, false);
    // parseDict(), not parseObject(): the dictionary alone, whatever follows it
    const dict = parser.parseDict();
    return { start, dict: dict instanceof PDFDict ? dict : undefined, end: start + parser.bytes.offset(), failed: !(dict instanceof PDFDict) };
  } catch {
    return { start, dict: undefined, end: start, failed: true };
  }
}

const integerOf = (value) => (value instanceof PDFNumber && Number.isInteger(value.asNumber()) ? value.asNumber() : undefined);

const OK = { status: "ok" };
const failed = (reason) => ({ status: "error", reason });
const unknown = (reason) => ({ status: "unknown", reason });

/** A classic table; `at` is just behind the keyword "xref". Entries are added as the viewer adds them. */
function readTable(bytes, at, context, entries) {
  let position = at;
  for (;;) {
    const head = readToken(bytes, position);
    if (head.kind === "word" && head.text === "trailer") {
      position = head.end;
      break;
    }
    if (head.kind === "odd") return unknown("a subsection header of a cross-reference table is not a plain integer");
    if (head.kind !== "int") return failed("a cross-reference table without a trailer");
    const size = readToken(bytes, head.end);
    if (size.kind === "odd") return unknown("a subsection header of a cross-reference table is not a plain integer");
    if (size.kind !== "int") return failed("a subsection header without a count");
    let first = head.value;
    position = size.end;
    for (let index = 0; index < size.value; index += 1) {
      const offset = readToken(bytes, position);
      const generation = readToken(bytes, offset.end);
      const type = readToken(bytes, generation.end);
      if (offset.kind === "odd" || generation.kind === "odd") return unknown("an entry of a cross-reference table is not written with plain integers");
      const isFree = type.kind === "word" && type.text === "f";
      if (offset.kind !== "int" || generation.kind !== "int" || !(isFree || (type.kind === "word" && type.text === "n"))) {
        return failed("an invalid entry in a cross-reference table");
      }
      // a table that starts at object 1 with a free entry means object 0 (the viewer corrects it)
      if (index === 0 && isFree && first === 1) first = 0;
      if (!entries.has(first + index)) entries.set(first + index, isFree ? { free: true } : { offset: offset.value, gen: generation.value });
      position = type.end;
    }
  }
  const zero = entries.get(0);
  if (zero && !zero.free) return failed("object 0 is not free");
  const trailer = parseDictAt(bytes, position, context);
  if (!trailer.dict) return trailer.failed ? unknown("the trailer dictionary cannot be parsed") : failed("no trailer dictionary");
  return { ...OK, dict: trailer.dict, table: true };
}

/** A cross-reference stream; `at` is the start of its "n g obj" header, `first` the token already read. */
function readStream(bytes, first, context, entries) {
  // "n g obj" and a stream, or no reader takes it for a section; numbers in an unusual form may be integers
  // to the viewer
  const generation = readToken(bytes, first.end);
  if (generation.kind !== "int" && generation.kind !== "odd") return failed("not a cross-reference stream");
  const keyword = readToken(bytes, generation.end);
  if (keyword.kind !== "word" || keyword.text !== "obj") return failed("not a cross-reference stream");
  if (first.kind === "odd" || generation.kind === "odd") return unknown("the header of a cross-reference stream is not written with plain integers");
  const parsed = parseDictAt(bytes, keyword.end, context);
  if (!parsed.dict) return parsed.failed ? unknown("the dictionary of a cross-reference stream cannot be parsed") : failed("not a cross-reference stream");
  const { dict } = parsed;
  let data = skipBlank(bytes, parsed.end);
  if (latin1(bytes, data, Math.min(bytes.length, data + 6)) !== "stream") return failed("not a cross-reference stream");
  // a stream without /W is no cross-reference stream for any reader (a /Prev that leads to some other object)
  const widthsValue = dict.get(N("W"));
  if (!(widthsValue instanceof PDFArray) && !(widthsValue instanceof PDFRef)) return failed("a cross-reference stream without /W");
  // "stream" + end of line, then exactly /Length bytes, then "endstream": anything else and the viewer searches
  // for the end of the data in its own way
  data += 6;
  if (bytes[data] === 32 && bytes[data + 1] === 13 && bytes[data + 2] === 10) data += 3;
  else if (bytes[data] === 13 && bytes[data + 1] === 10) data += 2;
  else if (bytes[data] === 13 || bytes[data] === 10) data += 1;
  else return unknown("the data of a cross-reference stream does not start on a new line");
  const length = integerOf(dict.get(N("Length")));
  if (length === undefined || length < 0 || data + length > bytes.length) return unknown("a cross-reference stream without a direct /Length");
  if (latin1(bytes, skipBlank(bytes, data + length), Math.min(bytes.length, skipBlank(bytes, data + length) + 9)) !== "endstream") {
    return unknown("the /Length of a cross-reference stream does not end at \"endstream\"");
  }

  const indexValue = dict.get(N("Index"));
  const sizeValue = dict.get(N("Size"));
  if (widthsValue instanceof PDFRef || indexValue instanceof PDFRef || sizeValue instanceof PDFRef) return unknown("indirect values in a cross-reference stream dictionary");
  const widths = [0, 1, 2].map((index) => (index < widthsValue.size() ? integerOf(widthsValue.get(index)) : undefined));
  let ranges;
  if (indexValue instanceof PDFArray) ranges = indexValue.asArray().map(integerOf);
  else if (indexValue === undefined) ranges = [0, integerOf(sizeValue)];
  else ranges = []; // not an array: the viewer finds no range in it
  let rows;
  try {
    rows = decodeStreamBytes(context, PDFRawStream.of(dict, bytes.subarray(data, data + length)));
  } catch {
    return unknown("a cross-reference stream cannot be decoded");
  }
  const field = (from, width) => {
    let value = 0;
    for (let index = 0; index < width; index += 1) value = value * 256 + rows[from + index];
    return value;
  };
  let position = 0;
  for (let pair = 0; pair < ranges.length; pair += 2) {
    const start = ranges[pair];
    const count = ranges[pair + 1];
    if (start === undefined || count === undefined) return failed("an invalid /Index or /Size in a cross-reference stream");
    if (widths.some((width) => width === undefined || width < 0) || widths[0] + widths[1] + widths[2] === 0) return failed("invalid /W in a cross-reference stream");
    const rowLength = widths[0] + widths[1] + widths[2];
    for (let index = 0; index < count; index += 1) {
      // too little data: the viewer's own decoder may have produced more or less than this one
      if (position + rowLength > rows.length) return unknown("a cross-reference stream is shorter than its /Index says");
      const type = widths[0] === 0 ? 1 : field(position, widths[0]);
      const second = field(position + widths[0], widths[1]);
      const third = field(position + widths[0] + widths[1], widths[2]);
      position += rowLength;
      let entry;
      if (type === 0) entry = { free: true };
      else if (type === 1) entry = { offset: second, gen: third };
      else if (type === 2) entry = { stream: second, index: third };
      else return failed("an invalid entry type in a cross-reference stream");
      if (!entries.has(start + index)) entries.set(start + index, entry);
    }
  }
  return { ...OK, dict, table: false };
}

/**
 * The offset of "%PDF-" when it lies in the first 1024 bytes (the viewer counts every offset from there), and
 * where the viewer goes on reading: behind the version number, on the same line.
 */
function readHeader(bytes) {
  const at = indexOfAscii(bytes, "%PDF-", 0, Math.min(bytes.length, 1024));
  if (at < 0) return { shift: 0, behind: 0 };
  let behind = at + 5;
  for (let read = 0; behind < bytes.length; read += 1) {
    const byte = bytes[behind];
    behind += 1;
    if (!(byte > 0x20) || read >= 7) break;
  }
  return { shift: at, behind };
}

/**
 * Where the viewer starts reading cross-reference sections (relative to the header): behind the first object
 * of a linearized file whose /L equals the file length, otherwise where the LAST "startxref" of the file says.
 * @param {number} behind  where the first object is looked for (behind the header)
 * @returns {{ start: number } | { unknown: string }}
 */
function firstSection(bytes, shift, behind, context) {
  const number = readToken(bytes, behind);
  const generation = number.kind === "int" ? readToken(bytes, number.end) : null;
  const keyword = generation && generation.kind === "int" ? readToken(bytes, generation.end) : null;
  if (keyword && keyword.kind === "word" && keyword.text === "obj") {
    const parsed = parseDictAt(bytes, keyword.end, context);
    if (parsed.failed) return { unknown: "the first object of the file cannot be parsed" };
    const dict = parsed.dict;
    // only direct numbers count: the viewer reads this dictionary before it has any cross-reference entry
    const positive = (key) => integerOf(dict.get(N(key))) > 0;
    const version = dict ? dict.get(N("Linearized")) : undefined;
    if (dict && version instanceof PDFNumber && version.asNumber() > 0) {
      const hints = dict.get(N("H"));
      const page = dict.get(N("P"));
      const linearized = integerOf(dict.get(N("L"))) === bytes.length - shift
        && hints instanceof PDFArray && (hints.size() === 2 || hints.size() === 4) && hints.asArray().every((hint) => integerOf(hint) > 0)
        && positive("O") && positive("E") && positive("N") && positive("T")
        && (page === undefined || integerOf(page) >= 0);
      if (linearized) {
        const end = indexOfAscii(bytes, "endobj", shift, Math.min(bytes.length, shift + 1024));
        if (end < 0) return { start: 0 };
        let at = end + 6;
        while (bytes[at] === 32 || bytes[at] === 9 || bytes[at] === 13 || bytes[at] === 10) at += 1;
        return { start: at - shift };
      }
    }
  } else if ((number.kind === "odd") || (generation && generation.kind === "odd")) {
    return { unknown: "the first object of the file has an unusual header" };
  }
  let found = -1;
  for (let at = bytes.lastIndexOf(0x73); at >= 0 && found < 0; at = at > 0 ? bytes.lastIndexOf(0x73, at - 1) : -1) {
    if (indexOfAscii(bytes, "startxref", at, Math.min(bytes.length, at + 9)) === at) found = at;
  }
  if (found < 0) return { start: 0 };
  let at = found + 9;
  while (bytes[at] === 32 || bytes[at] === 9 || bytes[at] === 13 || bytes[at] === 10) at += 1;
  const from = at;
  while (bytes[at] >= 0x20 && bytes[at] <= 0x39) at += 1;
  const value = Number.parseInt(latin1(bytes, from, at), 10);
  return { start: Number.isNaN(value) ? 0 : value };
}

/**
 * The sections from `start` on, in the order and with the precedence of the viewer: an entry that exists is
 * never replaced.
 * @param {{ entries?: Map<number, object>, hybrids?: Set<number>, afterScan?: boolean }} [state]
 *        afterScan: the sections are read AFTER the viewer indexed the file by scanning (it then goes through the
 *        cross-reference streams it met): a section that cannot be read is skipped, whichever it is
 * @returns {{ mode: "sections" | "scan" | "unknown", reason?: string, entries: Map<number, object>, top: any, sections: number }}
 */
function readSections(bytes, shift, start, context, { entries = new Map(), hybrids = new Set(), afterScan = false } = {}) {
  const queue = [start];
  const visited = new Set();
  let top = null;
  let sections = 0;
  while (queue.length) {
    const offset = queue.shift();
    if (visited.has(offset)) continue;
    visited.add(offset);
    if (visited.size > 4096) return { mode: "unknown", reason: "more than 4096 cross-reference sections" };
    const position = offset + shift;
    const first = position >= 0 && position < bytes.length ? readToken(bytes, position) : { kind: "end" };
    let result;
    if (first.kind === "word" && first.text === "xref") result = readTable(bytes, first.end, context, entries);
    else if (first.kind === "int" || first.kind === "odd") result = readStream(bytes, first, context, entries);
    else result = failed("no cross-reference section at this offset");
    if (result.status === "unknown") return { mode: "unknown", reason: result.reason };
    if (result.status === "error") {
      // The section "startxref" names is unusable: the viewer indexes the file by scanning it. A broken OLDER
      // section is skipped (what it had added stays, as in the viewer).
      if (!top && !afterScan) return { mode: "scan", reason: result.reason, entries, top: null, sections };
      continue;
    }
    sections += 1;
    if (!top) top = result.dict;
    if (result.table) {
      const hybrid = integerOf(result.dict.get(N("XRefStm")));
      if (hybrid !== undefined && !hybrids.has(hybrid)) {
        hybrids.add(hybrid);
        queue.push(hybrid);
      }
    }
    const previous = result.dict.get(N("Prev"));
    if (integerOf(previous) !== undefined) queue.push(previous.asNumber());
    else if (previous instanceof PDFRef) queue.push(previous.objectNumber);
  }
  return { mode: "sections", entries, top, sections };
}

/**
 * The index a viewer builds by scanning when the cross-reference sections cannot be used (XRef.indexObjects()
 * of pdf.js):
 *   - line by line; "n g obj" at the start of a line is a definition, and the scan goes on behind its
 *     "endobj" (or at the next thing that looks like a definition, "xref" or a trailer);
 *   - everything between a line that starts with "xref" and the next "startxref" is skipped;
 *   - of several definitions of a number, a later one with the same generation replaces the earlier one unless
 *     the viewer runs into the end of the file while reading it. That test is NOT reproduced: the entry is the
 *     LAST such definition and the number is listed in `ambiguous`; the caller accepts it only where the writer
 *     parsed that very definition without trouble (then the viewer does too);
 *   - the cross-reference streams met on the way are then read, in file order, each with its /Prev chain; they
 *     fill in what the scan did not find (objects inside object streams);
 *   - the trailer is one of the "trailer" dictionaries of the file, or the dictionary of a cross-reference
 *     stream. Which one the viewer picks is not reproduced either: they must all name the same /Root and the
 *     same encryption, or the mode is "unknown".
 * @param {object | null} top  the dictionary of a section that was read before the scan (the viewer keeps it)
 */
function scanAsViewer(bytes, shift, context, top) {
  const length = bytes.length;
  const text = latin1(bytes);
  const endOfObject = /\b(endobj|\d+\s+\d+\s+obj|xref|trailer\s*<<)\b/g;
  const endOfTrailer = /\b(startxref|\d+\s+\d+\s+obj)\b/g;
  const header = /^(\d+)\s+(\d+)\s+obj\b/;
  const lineBreak = /[\n\r<]/g;
  const entries = new Map();
  const ambiguous = new Set();
  const trailers = [];
  const streams = [];
  const until = (keyword, from) => {
    const at = indexOfAscii(bytes, keyword, from);
    return at < 0 ? length - from : at - from;
  };
  const lengthUpTo = (pattern, from, position) => {
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    if (!match) return length - position;
    const size = pattern.lastIndex + 1 - position;
    return match[1] === "endobj" || match[1] === "startxref" ? size : size - (match[1].length + 1);
  };
  let position = shift;
  while (position < length) {
    const byte = bytes[position];
    if (byte === 9 || byte === 10 || byte === 13 || byte === 32) {
      position += 1;
      continue;
    }
    if (byte === 0x25) {
      do position += 1;
      while (position < length && bytes[position] !== 10 && bytes[position] !== 13);
      continue;
    }
    // the rest of the line (up to a line break or "<"; without its last character at the very end of the file)
    lineBreak.lastIndex = position;
    const stop = lineBreak.exec(text);
    const token = text.slice(position, stop ? stop.index : Math.max(position, length - 1));
    const object = header.exec(token);
    if (token.startsWith("xref") && (token.length === 4 || /\s/.test(token[4]))) {
      position += until("trailer", position);
      trailers.push(position);
      position += until("startxref", position);
    } else if (object) {
      if (object[1].length > 9 || object[2].length > 9) return { mode: "unknown", reason: "an object number with more than nine digits" };
      const number = Number(object[1]);
      const generation = Number(object[2]);
      const known = entries.get(number);
      if (!known) entries.set(number, { offset: position - shift, gen: generation });
      else {
        ambiguous.add(number);
        if (known.gen === generation) entries.set(number, { offset: position - shift, gen: generation });
      }
      const size = lengthUpTo(endOfObject, position + token.length, position);
      const tag = indexOfAscii(bytes, "/XRef", position, Math.min(length, position + size));
      if (tag >= 0 && bytes[tag + 5] < 64) streams.push(position - shift);
      position += size;
    } else if (token.startsWith("trailer") && (token.length === 7 || /\s/.test(token[7]))) {
      trailers.push(position);
      position += lengthUpTo(endOfTrailer, position + token.length, position);
    } else {
      position += token.length + 1;
    }
  }
  // the cross-reference streams the scan met: what they list is added where the scan found nothing
  let dictionary = top;
  let sections = 0;
  const hybrids = new Set();
  for (const start of streams) {
    const read = readSections(bytes, shift, start, context, { entries, hybrids, afterScan: true });
    if (read.mode === "unknown") return read;
    sections += read.sections;
    if (!dictionary) dictionary = read.top;
  }
  // every trailer the viewer could pick must name the same /Root and the same encryption
  const candidates = [];
  for (const at of trailers) {
    const keyword = readToken(bytes, at);
    if (keyword.kind !== "word" || keyword.text !== "trailer") continue;
    const parsed = parseDictAt(bytes, keyword.end, context);
    if (parsed.failed) return { mode: "unknown", reason: "a trailer dictionary cannot be parsed" };
    if (parsed.dict) candidates.push(parsed.dict);
  }
  if (dictionary) candidates.push(dictionary);
  let root;
  let info;
  let encrypt;
  let id;
  let named = 0;
  const firstOf = (value) => (value instanceof PDFArray && value.size() ? String(value.get(0)) : String(value));
  for (const candidate of candidates) {
    if (!candidate.has(N("Root"))) continue;
    const candidateRoot = candidate.get(N("Root"));
    if (!(candidateRoot instanceof PDFRef) || (named > 0 && candidateRoot !== root)) return { mode: "unknown", reason: "the trailers of the file disagree about /Root" };
    const candidateEncrypt = candidate.get(N("Encrypt"));
    const candidateId = candidate.get(N("ID"));
    if (named > 0 && (String(candidateEncrypt) !== String(encrypt) || (encrypt !== undefined && firstOf(candidateId) !== firstOf(id)))) {
      return { mode: "unknown", reason: "the trailers of the file disagree about the encryption" };
    }
    const candidateInfo = candidate.get(N("Info"));
    if (named === 0) info = candidateInfo;
    else if (candidateInfo !== info) info = null;
    root = candidateRoot;
    encrypt = candidateEncrypt;
    id = candidateId;
    named += 1;
  }
  if (!named) return { mode: "unknown", reason: "no cross-reference section and no trailer with /Root" };
  return { mode: "scan", entries, ambiguous, root, info: info instanceof PDFRef ? info : undefined, encrypt, id, sections };
}

/**
 * The viewer's cross-reference information of a file.
 *
 * @param {Uint8Array} bytes  the file as the viewer gets it (only read)
 * @param {object} context  any PDFContext (the dictionaries of the sections are parsed with the library)
 * @returns {{ mode: "sections" | "scan" | "unknown", reason?: string, shift: number,
 *             entries: Map<number, { free: true } | { offset: number, gen: number } | { stream: number, index: number }>,
 *             ambiguous: Set<number>, root: any, info: any, encrypt: any, id: any, sections: number }}
 *   mode      "sections": read from the cross-reference sections. "scan": the sections cannot be used, the viewer
 *             scans the file for objects (see scanAsViewer). "unknown": this module cannot tell what the viewer
 *             does (`reason`, English, for logs).
 *   shift     offset of the "%PDF-" header: the position of an entry in `bytes` is entry.offset + shift
 *   entries   by object number. An offset of 0 means "no object" to the viewer, as does a missing entry.
 *   ambiguous numbers the scan met more than once: their entry is the last definition, which the viewer takes
 *             only if it can read it to its end
 *   root, info  /Root and /Info of the trailer the viewer uses (references, or undefined)
 *   encrypt, id /Encrypt and /ID of that trailer as they are written (a reference, a direct object, undefined)
 */
export function readViewerXref(bytes, context) {
  const none = { shift: 0, entries: new Map(), ambiguous: new Set(), root: undefined, info: undefined, encrypt: undefined, id: undefined, sections: 0 };
  try {
    const { shift, behind } = readHeader(bytes);
    const first = firstSection(bytes, shift, behind, context);
    if (first.unknown) return { ...none, mode: "unknown", reason: first.unknown, shift };
    const read = readSections(bytes, shift, first.start, context);
    if (read.mode === "unknown") return { ...none, ...read, shift };
    if (read.mode === "sections") {
      const root = read.top.get(N("Root"));
      const info = read.top.get(N("Info"));
      // a trailer without /Root is no trailer for the viewer (it then scans the file); a catalog written INTO
      // the trailer is one, but not one the writer can work with
      if (root !== undefined && root !== PDFNull && !(root instanceof PDFRef)) return { ...none, mode: "unknown", reason: "the trailer holds the catalog itself", shift };
      if (root instanceof PDFRef) {
        return {
          ...none, mode: "sections", shift, entries: read.entries, sections: read.sections, root,
          info: info instanceof PDFRef ? info : undefined, encrypt: read.top.get(N("Encrypt")), id: read.top.get(N("ID"))
        };
      }
    }
    return { ...none, ...scanAsViewer(bytes, shift, context, read.top), shift };
  } catch (error) {
    return { ...none, mode: "unknown", reason: `the cross-reference information could not be read (${error && error.name})` };
  }
}
