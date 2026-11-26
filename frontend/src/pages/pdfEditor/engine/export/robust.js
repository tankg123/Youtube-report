// Loading a source the way the editor needs it, checking that the writer reads it as the viewer does, and
// repairing what the parser of the library gets wrong.
//
//   detectSignatures(bytes)            cheap byte scan: does this file carry signatures / a certification?
//   findViewerDisagreements(...)       objects of which the viewer and the writer read different definitions
//   findStreamLengthProblems(doc)      streams the parser read with the wrong length (plain files)
//   repairStreamLengths(doc, bytes)    re-reads those streams from the original bytes
//   predictStreamCuts(doc, bytes)      the same question answered from the bytes (also for decrypted files)
//   repairPageTree(doc)                page dictionaries without /Type, which the library silently skips
//                                      (a page it could not PARSE is skipped too and cannot be repaired:
//                                      loadForEdit() refuses the file, EXPORT_SOURCE_DAMAGED)
//   loadForEdit(bytes, options)        load + checks + repairs + facts for the user interface
//
// The library is loaded with { updateMetadata: false, parseSpeed: Fastest }: nothing is rewritten in a
// document that is only read, and no timer runs between objects. load() does NOT throw for a file without a
// usable catalog (it returns a document whose `catalog` is undefined): loadForEdit() checks and throws
// EXPORT_SOURCE_DAMAGED. The caller's bytes are only read, never written.
//
// THE VIEWER AND THE WRITER MUST READ THE SAME OBJECTS. The parser of the library reads a file from top to
// bottom and keeps the last definition of every object number; it never looks at the cross-reference
// sections. A viewer reads ONLY through them (viewerXref.js). A file in which the two select different bytes
// (the table points at an earlier definition, marks a defined object as free, lists it in another object
// stream; a trailer that names another catalog; a definition hidden inside stream data ...) shows one document
// in the editor and would export another, which the user then signs. loadForEdit() therefore
//   1. traces the parse of the library: for every object the writer holds, WHERE in the file its definition
//      was read (the offset behind "n g obj", or the object stream it came out of),
//   2. reads the cross-reference information as the viewer does,
//   3. compares the two for every object the document can reach, takes /Root and /Info from the trailer the
//      viewer uses, and throws EXPORT_SOURCE_INCONSISTENT when they differ or when it cannot tell.
// Positions are compared, not contents: equal positions are read by both from the same bytes (and so are two
// definitions that are the same bytes, as in a file that was simply written twice). "Reach" is what a reader
// follows (gc.js reachableRefs with exact: true), not everything that looks like a reference inside an object
// the parser could not read. A reference whose entry is free or missing is null for both. A reference whose
// entry is IN USE but leads to no definition (a damaged download) is refused as well: the viewer fails on it,
// the writer would silently write a file without the object.
//
// Private parts of the library touched here (the package is pinned; tests/pdfExportConsistency.test.mjs fails
// when one of them changes): the static factory PDFParser.forBytesWithOptions, which PDFDocument.load() calls
// and which is wrapped WHILE a load of this module runs (other callers pass through untouched), and on the
// parser it returns: parseIndirectObjectHeader(), parseDocument(), `bytes.offset()` and `context.assign()`.
// A parse that could not be traced is refused, never waved through.
import { pdfLib } from "../lib.js";
import { PdfEditorError } from "../errors.js";
import { reachableRefs, trailerRoots } from "./gc.js";
import { N, indexOfAscii, latin1, resolve } from "./pdfUtil.js";
import { scanRawObject } from "./rawObjects.js";
import { headerEnd, readViewerXref } from "./viewerXref.js";

const {
  PDFDocument, PDFRawStream, PDFInvalidObject, PDFRef, PDFNumber, PDFDict, PDFArray, PDFName, PDFNull, PDFObjectParser, PDFParser,
  PDFContext, PDFCatalog, PDFPageLeaf, PDFPageTree, ParseSpeeds
} = pdfLib;

const isSpace = (byte) => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const isDigit = (byte) => byte >= 48 && byte <= 57;
const SPACE = "[\\t\\n\\f\\r ]";

/**
 * Does the file contain digital signatures? A raw scan, no parsing: usable on the bytes the moment the user
 * drops a file, before anything is loaded, and on encrypted files (signature dictionaries are never inside
 * object streams, and /ByteRange is a name, not an encrypted string).
 *
 * @param {Uint8Array} bytes
 * @returns {{ signed: boolean, count: number,
 *             byteRanges: Array<{ offset: number, range: number[], coversWholeFile: boolean, kind: "signature" | "timestamp" | "mac" }>,
 *             docMDP: boolean, hasSigField: boolean }}
 */
export function detectSignatures(bytes) {
  const byteRanges = [];
  const head = new RegExp(`^/ByteRange${SPACE}*\\[${SPACE}*(\\d+)${SPACE}+(\\d+)${SPACE}+(\\d+)${SPACE}+(\\d+)${SPACE}*\\]`);
  // The text of the indirect object a position lies in (a signature dictionary with its hex /Contents can be
  // tens of kilobytes); a little of the surroundings when the position is not inside an object (the trailer).
  const WINDOW = 131072;
  const dictionaryAround = (at) => {
    const from = Math.max(0, at - WINDOW);
    const before = latin1(bytes, from, at);
    const closed = before.lastIndexOf("endobj");
    let opened = before.lastIndexOf("obj");
    while (opened >= 0 && opened >= 3 && before.slice(opened - 3, opened) === "end") opened = before.lastIndexOf("obj", opened - 1);
    if (opened > closed) {
      const end = indexOfAscii(bytes, "endobj", at, Math.min(bytes.length, at + WINDOW));
      if (end >= 0) return latin1(bytes, from + opened, end);
    }
    return latin1(bytes, Math.max(0, at - 600), Math.min(bytes.length, at + 600));
  };
  for (let at = indexOfAscii(bytes, "/ByteRange"); at >= 0; at = indexOfAscii(bytes, "/ByteRange", at + 10)) {
    const match = head.exec(latin1(bytes, at, Math.min(bytes.length, at + 160)));
    if (!match) continue;
    const range = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    // what kind of dictionary is it in?
    const around = dictionaryAround(at);
    let kind = "signature";
    if (new RegExp(`/Type${SPACE}*/DocTimeStamp`).test(around)) kind = "timestamp";
    else if (/\/MAC\b/.test(around) && !/\/Contents/.test(around)) kind = "mac"; // ISO 32004 integrity code, not a signature
    const end = range[2] + range[3];
    byteRanges.push({ offset: at, range, coversWholeFile: range[0] === 0 && Math.abs(bytes.length - end) <= 2, kind });
  }
  const followedBy = (needle, pattern) => {
    for (let at = indexOfAscii(bytes, needle); at >= 0; at = indexOfAscii(bytes, needle, at + needle.length)) {
      if (pattern.test(latin1(bytes, at, Math.min(bytes.length, at + 80)))) return true;
    }
    return false;
  };
  const signatures = byteRanges.filter((entry) => entry.kind !== "mac");
  return {
    signed: signatures.length > 0,
    count: signatures.length,
    byteRanges,
    docMDP: followedBy("/TransformMethod", new RegExp(`^/TransformMethod${SPACE}*/DocMDP`)),
    // an EMPTY signature field is not a signature, but worth telling the user about
    hasSigField: followedBy("/FT", new RegExp(`^/FT${SPACE}*/Sig(?![A-Za-z0-9])`))
  };
}

// ---------------------------------------------------------------------------------------------------
// tracing the parse of the library
// ---------------------------------------------------------------------------------------------------

/** The byte arrays of the loads in progress: array -> { loads, contexts: every context parsed from it }. */
const watched = new Map();
/** PDFContext -> { origins } of the parse that filled it. */
const traces = new WeakMap();
let unhook = null;

/**
 * Records where the parser reads each definition. `origins` holds, per reference, the LAST assignment (as the
 * context does): { at, end } = the offsets just behind the header "n g obj" and just behind the "endobj" of a
 * definition in the file, or { holder, holderAt, holderEnd } = a member of the object stream `holder` whose
 * own definition lies between those offsets.
 */
function traceParser(parser, entry) {
  const { context } = parser;
  const stream = parser.bytes;
  const parseHeader = parser.parseIndirectObjectHeader;
  const parseDocument = parser.parseDocument;
  // the library changed: no trace, and loadForEdit() refuses the file
  if (!context || !stream || typeof stream.offset !== "function" || typeof parseHeader !== "function" || typeof parseDocument !== "function" || typeof context.assign !== "function") return;
  const origins = new Map();
  let current = null;
  parser.parseIndirectObjectHeader = function tracedHeader() {
    const ref = parseHeader.call(this);
    current = { ref, at: stream.offset() };
    return ref;
  };
  const assign = context.assign;
  context.assign = function tracedAssign(ref, object) {
    // the object itself, or (assigned while its stream is being read) a member of an object stream; either
    // way the parser stands behind the definition now
    if (current) {
      const end = stream.offset();
      origins.set(ref, ref === current.ref ? { at: current.at, end } : { holder: current.ref, holderAt: current.at, holderEnd: end });
    }
    return assign.call(this, ref, object);
  };
  parser.parseDocument = async function tracedDocument() {
    try {
      return await parseDocument.call(this);
    } finally {
      // whatever is assigned later (repairs, the scrub) is not a definition of the file
      delete context.assign;
      current = null;
    }
  };
  traces.set(context, { origins });
  entry.contexts.push(context);
}

function hook() {
  if (unhook) return;
  const original = PDFParser.forBytesWithOptions;
  if (typeof original !== "function") return;
  const traced = (...args) => {
    const parser = original(...args);
    const entry = watched.get(args[0]);
    if (entry) traceParser(parser, entry);
    return parser;
  };
  PDFParser.forBytesWithOptions = traced;
  unhook = () => {
    if (PDFParser.forBytesWithOptions === traced) PDFParser.forBytesWithOptions = original;
    unhook = null;
  };
}

/**
 * PDFDocument.load() with its parse traced.
 * @returns {Promise<{ doc: any, trace: { origins: Map<any, object> } | null, plain: any }>}
 *          trace: null when the parse could not be traced. plain: the context of the parse WITHOUT decryption
 *          (an encrypted file is parsed twice): its trailer still names /Encrypt and /ID.
 */
async function tracedLoad(bytes, options) {
  let entry = watched.get(bytes);
  if (!entry) {
    entry = { loads: 0, contexts: [] };
    watched.set(bytes, entry);
  }
  entry.loads += 1;
  hook();
  let doc;
  try {
    doc = await PDFDocument.load(bytes, options);
  } finally {
    entry.loads -= 1;
    if (!entry.loads) watched.delete(bytes);
    if (!watched.size && unhook) unhook();
  }
  const { context } = doc;
  // two loads of the same array at the same time share the entry: every parse of it without decryption is the same
  const plain = context.isDecrypted === true ? entry.contexts.find((other) => other !== context && other.isDecrypted !== true) || null : context;
  return { doc, trace: traces.get(context) || null, plain };
}

// ---------------------------------------------------------------------------------------------------
// the viewer and the writer must read the same objects
// ---------------------------------------------------------------------------------------------------

/** /Root and /Info of the trailer the VIEWER uses become the writer's (the library merges every trailer it meets). */
function adoptViewerTrailer(pdfDoc, view) {
  if (!view || view.mode === "unknown") return;
  const { context } = pdfDoc;
  if (view.root instanceof PDFRef && view.root !== context.trailerInfo.Root && context.lookup(view.root) instanceof PDFDict) {
    context.trailerInfo.Root = view.root;
    pdfDoc.catalog = context.lookup(view.root);
  }
  // also where the library has lost /Info: for an encrypted file with a cross-reference stream it "decrypts"
  // the stream that carries the trailer entries
  if (view.info instanceof PDFRef && view.info !== context.trailerInfo.Info) {
    const info = context.lookup(view.info);
    if (info instanceof PDFDict && !(info instanceof PDFCatalog) && !(info instanceof PDFPageLeaf) && !(info instanceof PDFPageTree)) context.trailerInfo.Info = view.info;
  }
}

/**
 * The objects of which the viewer and the writer do not read the same definition, as English sentences about
 * object numbers (for logs; empty = they agree).
 *
 * @param {object} pdfDoc  PDFDocument, as loaded (before any repair assigns objects)
 * @param {Uint8Array} bytes  the file as the viewer gets it
 * @param {object} facts
 * @param {ReturnType<typeof readViewerXref>} facts.view
 * @param {{ origins: Map<any, object> } | null} facts.trace  where the writer read each definition
 * @param {object | null} facts.plain  context of the parse without decryption
 * @param {Uint8Array} [facts.parsed]  the bytes the writer parsed, when they are not `bytes` (stream lengths were
 *        written into a copy of an encrypted file), and
 * @param {(offset: number) => number} [facts.toLoaded]  the map from an offset of `bytes` to an offset of them
 * @param {Set<any>} [facts.reachable]  reachableRefs() of the document, when the caller has it
 * @returns {string[]}
 */
export function findViewerDisagreements(pdfDoc, bytes, { view, trace, plain, parsed = bytes, toLoaded = (offset) => offset, reachable } = {}) {
  const { context } = pdfDoc;
  if (!view || view.mode === "unknown") return [`what a viewer reads cannot be told: ${view ? view.reason : "no cross-reference information"}`];
  if (!trace) return ["the parse of the file could not be traced"];
  const problems = [];
  const { origins } = trace;
  const { entries, shift } = view;

  // the trailer: the catalog, and whether (and with which dictionary) the file is encrypted
  if (!(view.root instanceof PDFRef) || context.trailerInfo.Root !== view.root) problems.push("the viewer and the writer use different catalogs");
  const decrypted = context.isDecrypted === true;
  const viewerEncrypt = view.encrypt instanceof PDFRef ? (plain ? plain.lookup(view.encrypt) : undefined) : view.encrypt;
  const viewerEncrypted = viewerEncrypt instanceof PDFDict;
  const extra = [];
  if (decrypted !== viewerEncrypted) problems.push("the viewer and the writer disagree about the encryption of the file");
  else if (decrypted) {
    const mine = plain ? plain.trailerInfo : {};
    const firstId = (value, lookup) => {
      const array = value instanceof PDFRef ? lookup(value) : value;
      return array instanceof PDFArray && array.size() ? String(array.get(0)) : "";
    };
    if (!plain || String(mine.Encrypt) !== String(view.encrypt) || firstId(mine.ID, (ref) => plain.lookup(ref)) !== firstId(view.id, (ref) => plain.lookup(ref))) {
      problems.push("the viewer and the writer decrypt with different encryption dictionaries");
    }
    for (const value of [view.encrypt, view.id]) if (value instanceof PDFRef) extra.push(value);
  }

  /** Where the header of the definition that the viewer's entry selects ends, in the writer's offsets; -1: nothing readable there. */
  const headers = new Map();
  const viewerHeader = (number, generation, entry) => {
    const key = number * 65536 + generation;
    let end = headers.get(key);
    if (end === undefined) {
      const found = entry && entry.offset > 0 && entry.gen === generation ? headerEnd(bytes, entry.offset + shift, number, generation) : -1;
      end = found < 0 ? -1 : toLoaded(found);
      headers.set(key, end);
    }
    return end;
  };
  /**
   * Is the definition whose header ends at `viewerAt` the one the writer read between `writerAt` and
   * `writerEnd`? The same place, or the same bytes (a file that holds a definition twice, word for word: both
   * readers then parse the same text).
   */
  const sameDefinition = (viewerAt, writerAt, writerEnd) => {
    if (viewerAt === writerAt) return true;
    const length = writerEnd - writerAt;
    if (!(length > 0) || viewerAt + length > parsed.length) return false;
    for (let index = 0; index < length; index += 1) if (parsed[viewerAt + index] !== parsed[writerAt + index]) return false;
    return true;
  };
  const refs = reachable || reachableRefs(context, trailerRoots(context), { exact: true });
  let count = 0;
  const report = (ref, what) => {
    count += 1;
    if (problems.length < 8) problems.push(`${ref}: ${what}`);
  };
  const check = (ref) => {
    const number = ref.objectNumber;
    const generation = ref.generationNumber;
    if (number === 0) return;
    const held = context.lookup(ref);
    const origin = origins.get(ref);
    const entry = entries.get(number);
    if (!entry || entry.free || (entry.stream === undefined && !(entry.offset > 0))) {
      // free or not listed: the reference is null for the viewer
      if (held !== undefined && held !== PDFNull) report(ref, "the viewer reads no object, the writer holds one");
      return;
    }
    if (entry.stream !== undefined) {
      // a member of an object stream: the viewer fetches the stream through its own entry and takes the member
      // the stream's header lists under this number (it corrects a wrong index in the entry)
      const holder = PDFRef.of(entry.stream, 0);
      const holderAt = viewerHeader(entry.stream, 0, entries.get(entry.stream));
      if (holderAt < 0) report(ref, "the viewer cannot read the object stream that is said to hold it");
      else if (!origin || origin.holder !== holder || !sameDefinition(holderAt, origin.holderAt, origin.holderEnd)) {
        report(ref, "the viewer takes it from an object stream, the writer from another definition");
      }
      return;
    }
    // An entry that is in use must lead to a definition. Where it does not, the viewer does not read "null": it
    // fails on the reference (and loses the font, the picture, the page that needed it), or it gives the
    // cross-reference sections up altogether and scans the file. Neither is what the writer would export.
    const at = viewerHeader(number, generation, entry);
    if (at < 0) report(ref, "its cross-reference entry does not lead to a definition");
    else if (held === undefined) report(ref, "the viewer reads an object that the writer never met");
    else if (!origin || origin.at === undefined || !sameDefinition(at, origin.at, origin.end)) report(ref, "the viewer and the writer read different definitions");
    // A scan met several definitions of this number. The viewer takes the last one unless it runs into the end
    // of the file while reading it; a definition the writer's strict parser read without trouble is one the
    // viewer reads to its end too. Anything else is not guessed.
    else if (view.ambiguous.has(number) && held instanceof PDFInvalidObject) report(ref, "defined more than once in a file without usable cross-reference sections, and the last definition is not well formed");
  };
  for (const ref of refs) check(ref);
  for (const ref of extra) if (!refs.has(ref)) check(ref);
  if (count > 8) problems.push(`... ${count} objects in all`);
  return problems;
}

/**
 * Streams whose parsed length differs from the length the file declares (plain files only: after
 * decryption the two are not comparable).
 *
 * Background: when /Length is an INDIRECT reference (pdfTeX, LibreOffice, Ghostscript, Cairo ... write that
 * for every stream) the parser does not use it. It searches for the keyword "endstream" and cuts one
 * end-of-line before it:
 *   - data that ends with CR or LF can lose that byte,
 *   - data that contains "endstream" is truncated there,
 *   - data that contains the word "stream" breaks the nesting count: the object becomes a PDFInvalidObject.
 * pdf.js and qpdf read all three correctly, so the viewer shows what the export would then damage.
 */
export function findStreamLengthProblems(pdfDoc) {
  const { context } = pdfDoc;
  const problems = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      const length = object.dict.get(N("Length"));
      if (!(length instanceof PDFRef)) continue;
      const declared = resolve(context, length);
      if (!(declared instanceof PDFNumber)) continue;
      if (declared.asNumber() !== object.contents.length) {
        problems.push({ ref, declared: declared.asNumber(), parsed: object.contents.length, kind: "wrong length" });
      }
    } else if (object instanceof PDFInvalidObject) {
      const head = latin1(object.data, 0, Math.min(object.data.length, 4000));
      if (new RegExp(`>>${SPACE}*stream[\\r\\n]`).test(head)) problems.push({ ref, declared: undefined, parsed: undefined, kind: "unparsed stream" });
    }
  }
  return problems;
}

/**
 * Where the definitions "N G obj" of the wanted objects are in the file: Map<"N G", offsets[]> in file order,
 * each offset pointing just behind the keyword `obj`. One pass over the bytes, no copy. A guess (text inside
 * stream data matches too): only for a document whose parse was not traced.
 */
function objectOffsets(bytes, wanted) {
  const found = new Map();
  for (let at = bytes.indexOf(0x6f); at >= 0; at = bytes.indexOf(0x6f, at + 1)) {
    if (bytes[at + 1] !== 0x62 || bytes[at + 2] !== 0x6a) continue; // "obj"
    let index = at - 1;
    if (index < 0 || !isSpace(bytes[index])) continue;
    while (index >= 0 && isSpace(bytes[index])) index -= 1;
    let end = index;
    while (index >= 0 && isDigit(bytes[index])) index -= 1;
    if (index === end || end - index > 5) continue;
    const generation = Number(latin1(bytes, index + 1, end + 1));
    if (index < 0 || !isSpace(bytes[index])) continue;
    while (index >= 0 && isSpace(bytes[index])) index -= 1;
    end = index;
    while (index >= 0 && isDigit(bytes[index])) index -= 1;
    if (index === end || end - index > 10) continue;
    // no white space is asked for BEFORE the number: an update appended to a file without a final newline
    // reads "%%EOF2 0 obj"
    const key = `${Number(latin1(bytes, index + 1, end + 1))} ${generation}`;
    if (!wanted.has(key)) continue;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(at + 3);
  }
  return found;
}

/** The stream that starts at `at` (just behind "N G obj"): its dictionary and where its data begins. */
function locateStream(context, bytes, at) {
  // the same forms the parser accepts after the dictionary: "stream" + SP CR LF | CR LF | CR | LF | nothing
  const keyword = new RegExp(`>>${SPACE}*stream( \\r\\n|\\r\\n|\\r|\\n)?`);
  let start = null;
  // most stream dictionaries are a few hundred bytes: look at a small window first
  for (const size of [2048, 65536]) {
    start = keyword.exec(latin1(bytes, at, Math.min(bytes.length, at + size)));
    if (start && start.index + start[0].length < size - 2) break;
    start = null;
  }
  if (!start) return { reason: "no \"stream\" keyword after the dictionary" };
  const dictEnd = at + start.index + 2;
  let dict;
  try {
    dict = PDFObjectParser.forBytes(bytes.subarray(at, dictEnd), context, false).parseObject();
  } catch (error) {
    return { reason: `dictionary does not parse: ${error.message}` };
  }
  if (!(dict instanceof PDFDict)) return { reason: "not a dictionary" };
  const declared = resolve(context, dict.get(N("Length")));
  if (!(declared instanceof PDFNumber)) return { reason: "/Length does not resolve to a number" };
  const length = declared.asNumber();
  const dataStart = at + start.index + start[0].length;
  const dataEnd = dataStart + length;
  if (!(length >= 0) || dataEnd > bytes.length) return { reason: "declared length runs past the end of the file" };
  if (!new RegExp(`^${SPACE}*endstream`).test(latin1(bytes, dataEnd, Math.min(bytes.length, dataEnd + 24)))) {
    return { reason: "no \"endstream\" after the declared length" };
  }
  return { dict, dictStart: at, dictEnd, dataStart, dataEnd, length };
}

/** Where the parser's search for the end of a stream stops when it starts at `dataStart` (-1: not at a clean end). */
function parserStreamEnd(bytes, dataStart) {
  const keyword = indexOfAscii(bytes, "stream", dataStart);
  if (keyword < 0) return -1;
  const isEnd = keyword - 3 >= dataStart && bytes[keyword - 3] === 0x65 && bytes[keyword - 2] === 0x6e && bytes[keyword - 1] === 0x64;
  if (!isEnd) return -1; // the bare word "stream" inside the data: the parser counts a nested stream
  const end = keyword - 3;
  if (end - 2 >= dataStart && bytes[end - 2] === 13 && bytes[end - 1] === 10) return end - 2;
  if (end - 1 >= dataStart && (bytes[end - 1] === 13 || bytes[end - 1] === 10)) return end - 1;
  return end;
}

const refKey = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

/**
 * The definition of each wanted object as a well-formed stream with a resolvable /Length.
 * With `origins` (the trace of the parse) it is the definition the writer read, which the viewer reads too.
 * Without, the file is searched: the LAST "N G obj" that validates as a stream (a guess).
 */
function locateStreams(context, bytes, refs, origins) {
  const located = new Map();
  if (origins) {
    for (const ref of refs) {
      const origin = origins.get(ref);
      located.set(ref, origin && origin.at !== undefined ? locateStream(context, bytes, origin.at) : { reason: "the object is not defined on its own in the file" });
    }
    return located;
  }
  const offsets = objectOffsets(bytes, new Set(refs.map(refKey)));
  for (const ref of refs) {
    const candidates = offsets.get(refKey(ref)) || [];
    let result = { reason: "object not found in the file" };
    // the LAST definition wins (incremental updates append newer ones); a hit inside binary data does not validate
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const attempt = locateStream(context, bytes, candidates[index]);
      if (!attempt.reason) {
        result = attempt;
        break;
      }
      if (index === candidates.length - 1) result = attempt;
    }
    located.set(ref, result);
  }
  return located;
}

/**
 * Re-reads the problem streams of a PLAIN document from the original file with the declared length.
 * @param {object} pdfDoc
 * @param {Uint8Array} originalBytes
 * @param {{ origins?: Map<any, object> }} [options]  the trace of the parse (loadForEdit passes it): each stream
 *        is then re-read at the definition the writer parsed, instead of being searched for in the bytes
 * @returns {{ problems: number, repaired: number, failed: Array<{ ref: string, reason: string }> }}
 */
export function repairStreamLengths(pdfDoc, originalBytes, { origins } = {}) {
  const { context } = pdfDoc;
  const problems = findStreamLengthProblems(pdfDoc);
  const result = { problems: problems.length, repaired: 0, failed: [] };
  if (!problems.length) return result;
  const located = locateStreams(context, originalBytes, problems.map((problem) => problem.ref), origins);
  for (const { ref } of problems) {
    const found = located.get(ref);
    if (found.reason) {
      result.failed.push({ ref: ref.toString(), reason: found.reason });
      continue;
    }
    const fresh = PDFRawStream.of(found.dict, originalBytes.slice(found.dataStart, found.dataEnd));
    fresh.dict.set(N("Length"), PDFNumber.of(found.length)); // direct from now on
    context.assign(ref, fresh);
    result.repaired += 1;
  }
  return result;
}

/**
 * The streams with an indirect /Length that the parser cuts at the wrong byte, found by replaying its
 * search on the file itself. Unlike findStreamLengthProblems() this also works for a document that was
 * decrypted while loading (cipher text and plain text have different lengths, so nothing can be compared
 * afterwards), which is where it is used.
 * @param {object} pdfDoc
 * @param {Uint8Array} originalBytes
 * @param {{ origins?: Map<any, object> }} [options]  as for repairStreamLengths()
 * @returns {Array<{ ref: any, length: number, dictStart: number, dictEnd: number }>}
 */
export function predictStreamCuts(pdfDoc, originalBytes, { origins } = {}) {
  const { context } = pdfDoc;
  const candidates = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(N("Length")) instanceof PDFRef) candidates.push(ref);
    else if (object instanceof PDFInvalidObject) candidates.push(ref);
  }
  if (!candidates.length) return [];
  const cuts = [];
  for (const [ref, found] of locateStreams(context, originalBytes, candidates, origins)) {
    if (found.reason || !(found.dict.get(N("Length")) instanceof PDFRef)) continue;
    if (parserStreamEnd(originalBytes, found.dataStart) !== found.dataEnd) {
      cuts.push({ ref, length: found.length, lengthRef: found.dict.get(N("Length")), dictStart: found.dictStart, dictEnd: found.dictEnd });
    }
  }
  return cuts;
}

/**
 * A copy of the file in which the given streams carry their length as a direct number, so that the parser
 * takes it instead of searching. Offsets move (the parser reads sequentially and never uses them): `map`
 * turns an offset of the original into the offset of the same byte in the copy.
 * @returns {{ bytes: Uint8Array, patched: number, map: (offset: number) => number }}
 */
function withDirectLengths(originalBytes, cuts) {
  const edits = [];
  for (const cut of cuts) {
    const text = latin1(originalBytes, cut.dictStart, cut.dictEnd);
    const token = new RegExp(`/Length${SPACE}+${cut.lengthRef.objectNumber}${SPACE}+${cut.lengthRef.generationNumber}${SPACE}+R(?![0-9A-Za-z])`).exec(text);
    if (token) edits.push({ start: cut.dictStart + token.index, end: cut.dictStart + token.index + token[0].length, text: `/Length ${cut.length}` });
  }
  edits.sort((a, b) => a.start - b.start);
  let size = originalBytes.length;
  for (const edit of edits) size += edit.text.length - (edit.end - edit.start);
  const bytes = new Uint8Array(size);
  let from = 0;
  let to = 0;
  for (const edit of edits) {
    bytes.set(originalBytes.subarray(from, edit.start), to);
    to += edit.start - from;
    for (let index = 0; index < edit.text.length; index += 1) bytes[to + index] = edit.text.charCodeAt(index);
    to += edit.text.length;
    from = edit.end;
  }
  bytes.set(originalBytes.subarray(from), to);
  const map = (offset) => {
    let moved = offset;
    for (const edit of edits) {
      if (edit.end > offset) break;
      moved += edit.text.length - (edit.end - edit.start);
    }
    return moved;
  };
  return { bytes, patched: edits.length, map };
}

/**
 * Page tree nodes without a (correct) /Type.
 *
 * The parser decides by /Type whether a dictionary becomes a page object; getPages() then SKIPS every kid
 * of the page tree that is not one. A page dictionary without "/Type /Page" (pdf.js, Acrobat and every other
 * viewer accept it) silently disappears: the library counts 6 pages where the viewer shows 7, and every page
 * index after it is off by one. This walks the tree from the catalog and turns such kids into real page
 * objects (a kid with /Kids becomes a tree node). Call it right after load, before the first getPages().
 *
 * @returns {{ leavesFixed: number, nodesFixed: number }}
 */
export function repairPageTree(pdfDoc) {
  const { context, catalog } = pdfDoc;
  const result = { leavesFixed: 0, nodesFixed: 0 };
  const seen = new Set();
  const convert = (ref, parentRef, depth) => {
    if (!(ref instanceof PDFRef) || seen.has(ref) || depth > 64) return;
    seen.add(ref);
    let node = context.lookup(ref);
    if (!(node instanceof PDFDict)) return;
    const kids = resolve(context, node.get(N("Kids")));
    if (kids instanceof PDFArray) {
      if (!(node instanceof PDFPageTree)) {
        const map = new Map(node.entries());
        map.set(PDFName.of("Type"), PDFName.of("Pages"));
        node = PDFPageTree.fromMapWithContext(map, context);
        context.assign(ref, node);
        result.nodesFixed += 1;
      }
      if (!(node.get(N("Kids")) instanceof PDFArray)) node.set(N("Kids"), kids);
      for (const kid of kids.asArray()) convert(kid, ref, depth + 1);
    } else if (!(node instanceof PDFPageLeaf)) {
      const map = new Map(node.entries());
      map.set(PDFName.of("Type"), PDFName.of("Page"));
      if (!map.has(PDFName.of("Parent")) && parentRef) map.set(PDFName.of("Parent"), parentRef);
      context.assign(ref, PDFPageLeaf.fromMapWithContext(map, context));
      result.leavesFixed += 1;
    }
  };
  convert(catalog.get(N("Pages")), null, 0);
  return result;
}

/**
 * Nodes of the page tree (pages, inner nodes, /Kids arrays) that the parser could not read.
 *
 * getPages() passes such a kid over without a word, as it does with a page without /Type. But this one cannot
 * be repaired: a viewer, which skips what it does not understand inside a dictionary, usually shows the page,
 * so the writer would count fewer pages and every page index behind it would mean ANOTHER page than the one the
 * user sees (delete "page 2" and page 3 goes). The source is refused, with or without sources[].expectedPages.
 */
function unreadablePageNodes(pdfDoc) {
  const { context, catalog } = pdfDoc;
  let unreadable = 0;
  const seen = new Set();
  const stack = [[catalog.get(N("Pages")), 0]];
  while (stack.length) {
    const [ref, depth] = stack.pop();
    if (!(ref instanceof PDFRef) || seen.has(ref) || depth > 64) continue;
    seen.add(ref);
    const node = context.lookup(ref);
    if (node instanceof PDFInvalidObject) unreadable += 1;
    if (!(node instanceof PDFDict)) continue;
    const kids = resolve(context, node.get(N("Kids")));
    if (kids instanceof PDFInvalidObject) unreadable += 1;
    else if (kids instanceof PDFArray) for (const kid of kids.asArray()) stack.push([kid, depth + 1]);
  }
  return unreadable;
}

/** A catalog dictionary without "/Type /Catalog" (viewers accept it) becomes a real catalog object. */
function repairCatalog(pdfDoc) {
  const { context } = pdfDoc;
  const rootRef = context.trailerInfo.Root;
  const root = resolve(context, rootRef);
  if (root instanceof PDFCatalog) return true;
  if (!(rootRef instanceof PDFRef) || !(root instanceof PDFDict) || !root.has(N("Pages"))) return false;
  const map = new Map(root.entries());
  map.set(PDFName.of("Type"), PDFName.of("Catalog"));
  const catalog = PDFCatalog.fromMapWithContext(map, context);
  context.assign(rootRef, catalog);
  pdfDoc.catalog = catalog;
  return true;
}

const LOAD_OPTIONS = () => ({
  updateMetadata: false, // never touch Producer / ModDate of something that is only being read
  parseSpeed: ParseSpeeds.Fastest, // no setTimeout between objects: meant for a Web Worker
  throwOnInvalidObject: false
});

/**
 * Loads (traced) and checks; throws PdfEditorError with the `source` id in its parameters.
 * @param {ReturnType<typeof readViewerXref>} view  the cross-reference information of the ORIGINAL file
 */
async function loadChecked(bytes, password, source, view) {
  let loaded;
  try {
    // An empty password opens files that only restrict permissions (the viewer opens those without asking)
    // and is ignored by files that are not encrypted.
    loaded = await tracedLoad(bytes, { ...LOAD_OPTIONS(), password: password ?? "" });
  } catch (cause) {
    const message = String(cause?.message ?? cause);
    let code = "EXPORT_SOURCE_DAMAGED";
    if (/NEEDS PASSWORD/.test(message) || /is encrypted/.test(message)) code = "EXPORT_PASSWORD_REQUIRED";
    else if (/Password incorrect/.test(message)) code = "EXPORT_PASSWORD_WRONG";
    else if (/unknown encryption method|unsupported encryption algorithm|invalid key length|Invalid crypt filter|Unknown crypto method/.test(message)) code = "EXPORT_ENCRYPTION_UNSUPPORTED";
    // the message of the library may quote bytes of the file: it stays in `cause`, the detail is generic
    throw new PdfEditorError(code, { source }, { cause, detail: "the PDF library could not load the file" });
  }
  const { doc } = loaded;
  adoptViewerTrailer(doc, view); // before the catalog is looked at
  if (!repairCatalog(doc)) {
    throw new PdfEditorError("EXPORT_SOURCE_DAMAGED", { source }, { detail: "no document catalog was found" });
  }
  const unreadable = unreadablePageNodes(doc);
  if (unreadable) {
    throw new PdfEditorError("EXPORT_SOURCE_DAMAGED", { source }, { detail: `${unreadable} object(s) of the page tree have broken syntax: the writer cannot see pages that a viewer may show` });
  }
  const pageTree = repairPageTree(doc); // before the first getPages()
  let pages;
  try {
    pages = doc.getPageCount();
  } catch (cause) {
    throw new PdfEditorError("EXPORT_SOURCE_DAMAGED", { source }, { cause, detail: "the page tree cannot be read" });
  }
  if (!(pages > 0)) throw new PdfEditorError("EXPORT_SOURCE_DAMAGED", { source }, { detail: "the document has no pages" });
  return { doc, pageTree, pages, trace: loaded.trace, plain: loaded.plain };
}

/**
 * Loads a source the way the editor needs it and reports what the user interface should know.
 *
 * Throws EXPORT_SOURCE_INCONSISTENT when the writer would not read the file as the viewer shows it (see the
 * header), EXPORT_SOURCE_DAMAGED when it cannot read it at all, when a node of the page tree has broken syntax
 * (the writer would count fewer pages than the viewer shows) or when the document uses an object with broken
 * syntax that cannot be carried over (rawObjects.js), and the password codes.
 *
 * @param {Uint8Array} bytes  only read, never written
 * @param {{ password?: string, source?: string }} [options]  source = the id used in error parameters
 * @returns {Promise<{ doc: any, facts: { pages: number, encrypted: boolean, version: string,
 *            signatures: ReturnType<typeof detectSignatures>, repair: { problems: number, repaired: number, failed: object[] },
 *            pageTree: { leavesFixed: number, nodesFixed: number }, invalidObjects: number, xref: "sections" | "scan" } }>}
 *          invalidObjects: reachable objects the parser could not read (they travel as raw bytes);
 *          xref: how a viewer finds the objects of this file ("scan": it has no usable cross-reference section)
 */
export async function loadForEdit(bytes, { password, source = null } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new PdfEditorError("EXPORT_SOURCE_DAMAGED", { source }, { detail: "no bytes" });
  }
  const signatures = detectSignatures(bytes);
  const view = readViewerXref(bytes, PDFContext.create());
  let loaded = await loadChecked(bytes, password, source, view);
  const encrypted = loaded.doc.context.isDecrypted === true;
  /** Throws when the viewer would read other objects than the document that was just loaded (from `parsed`). */
  const agree = (parsed, toLoaded) => {
    const reachable = reachableRefs(loaded.doc.context, trailerRoots(loaded.doc.context), { exact: true });
    const problems = findViewerDisagreements(loaded.doc, bytes, { view, trace: loaded.trace, plain: loaded.plain, parsed, toLoaded, reachable });
    if (problems.length) {
      throw new PdfEditorError("EXPORT_SOURCE_INCONSISTENT", { source }, { detail: `the export would not be what the viewer shows: ${problems.slice(0, 4).join("; ")}` });
    }
    return reachable;
  };
  let repair;
  let reachable;
  if (!encrypted) {
    reachable = agree(bytes);
    repair = repairStreamLengths(loaded.doc, bytes, { origins: loaded.trace.origins });
    if (repair.repaired) reachable = null; // a repaired stream is a parsed object now
  } else {
    // The raw bytes of an encrypted file are cipher text: nothing can be re-read into the loaded document.
    // Instead the file is given to the parser again with the lengths written where it looks for them.
    repair = { problems: 0, repaired: 0, failed: [] };
    let toLoaded;
    let parsed = bytes;
    const cuts = predictStreamCuts(loaded.doc, bytes, { origins: loaded.trace ? loaded.trace.origins : undefined });
    if (cuts.length) {
      repair.problems = cuts.length;
      const fixed = withDirectLengths(bytes, cuts);
      let again;
      try {
        again = await loadChecked(fixed.bytes, password, source, view);
      } catch {
        again = null; // keep the first reading: it is what a plain load would have given
      }
      if (again && again.pages >= loaded.pages) {
        loaded = again;
        toLoaded = fixed.map;
        parsed = fixed.bytes;
        repair.repaired = fixed.patched;
      }
      for (let missing = repair.problems - repair.repaired; missing > 0; missing -= 1) {
        repair.failed.push({ ref: "", reason: "the stream could not be given a direct length" });
      }
    }
    reachable = agree(parsed, toLoaded);
  }
  // Objects the parser could not read. Only those the document can REACH count: the cross-reference stream of
  // an encrypted file always ends up as one (the parser "decrypts" it), and nothing ever refers to it.
  let invalidObjects = 0;
  const invalid = loaded.doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFInvalidObject);
  if (invalid.length) {
    if (!reachable) reachable = reachableRefs(loaded.doc.context, trailerRoots(loaded.doc.context), { exact: true });
    let open = 0;
    for (const [ref, object] of invalid) {
      if (!reachable.has(ref)) continue;
      invalidObjects += 1;
      if (!scanRawObject(object.data).closed) open += 1;
    }
    if (open) {
      // such an object is read on behind its end by a lenient viewer: copied into another file it would mean
      // something else there, so the page that uses it could not be exported as it was shown
      throw new PdfEditorError("EXPORT_SOURCE_DAMAGED", { source }, { detail: `${open} object(s) the document uses have broken syntax and are not self-contained: they cannot be carried over` });
    }
  }
  return {
    doc: loaded.doc,
    facts: {
      pages: loaded.pages,
      encrypted,
      version: loaded.doc.context.header.getVersionString(),
      signatures,
      repair,
      pageTree: loaded.pageTree,
      invalidObjects,
      xref: view.mode
    }
  };
}
