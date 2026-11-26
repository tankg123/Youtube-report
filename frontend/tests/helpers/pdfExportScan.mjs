// What a leak check asks of an exported file, without any external tool:
//
//   findText(bytes, needles)   is this text anywhere in the file? In the raw bytes and inflated streams
//                              (pdfRawScan.mjs: single-byte, UTF-16, hex, string operands joined), in every
//                              string object the library parses (reachable or not), and in every text-like
//                              stream decoded through every /ToUnicode map of the file (the only way to see
//                              glyph-id coded text of a subset font, which is what the editor itself writes)
//   fileFacts(bytes)           orphans, structural audit, revisions, object numbers defined twice, /ID ...
//
// A text extractor sees none of this: it only reads what pages show.
import { rawScan } from "./pdfRawScan.mjs";
import { pdfLib, squash } from "./pdfTestKit.mjs";
import { auditOutput } from "../../src/pages/pdfEditor/engine/export/copyPages.js";
import { decodeStreamBytes } from "../../src/pages/pdfEditor/engine/export/content.js";
import { tokenizeContent } from "../../src/pages/pdfEditor/engine/export/contentTokens.js";
import { findOrphans } from "../../src/pages/pdfEditor/engine/export/gc.js";
import { decodeTextBytes } from "../../src/pages/pdfEditor/engine/export/pdfUtil.js";
import { parseToUnicode } from "../../src/pages/pdfEditor/engine/export/tounicode.js";

const { PDFDocument, PDFDict, PDFArray, PDFStream, PDFString, PDFHexString, PDFName, PDFRef } = pdfLib;

/** Loads a file the way the checks need it: nothing rewritten, broken objects kept. */
export function loadPlain(bytes, options = {}) {
  // Fastest: the default parse speed waits for a timer every 100 objects
  return PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false, parseSpeed: pdfLib.ParseSpeeds.Fastest, ...options });
}

/** Every string object inside `object` (not following references), decoded as a PDF text string. */
function stringsIn(object, out) {
  const stack = [object];
  while (stack.length) {
    const current = stack.pop();
    if (current instanceof PDFString || current instanceof PDFHexString) out.push(decodeTextBytes(current.asBytes()));
    else if (current instanceof PDFDict) stack.push(...current.values());
    else if (current instanceof PDFArray) stack.push(...current.asArray());
    else if (current instanceof PDFStream) stack.push(current.dict);
  }
}

/** String operands of a content-like stream: the byte arrays of every Tj / TJ / ' / " operand. */
function shownStrings(bytes) {
  const out = [];
  const { operations } = tokenizeContent(bytes);
  const collect = (token) => {
    if (token.type === "string") out.push(token.bytes);
    else if (token.type === "array") token.items.forEach(collect);
  };
  for (const operation of operations) operation.operands.forEach(collect);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {string[]} needles
 * @returns {Promise<Record<string, string[]>>} per needle: where it was found (empty = nowhere)
 */
export async function findText(bytes, needles) {
  const found = Object.fromEntries(needles.map((needle) => [needle, []]));
  const raw = rawScan(bytes, needles);
  for (const needle of needles) for (const hit of raw[needle]) found[needle].push(`${hit.where} as ${hit.encoding}`);

  const doc = await loadPlain(bytes);
  const { context } = doc;
  const cmaps = [];
  const streams = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    const strings = [];
    stringsIn(object, strings);
    for (const needle of needles) {
      if (strings.some((text) => squash(text).includes(squash(needle)))) found[needle].push(`string in object ${ref}`);
    }
    if (!(object instanceof PDFStream)) continue;
    let decoded;
    try {
      decoded = decodeStreamBytes(context, object);
    } catch {
      continue; // an image or another binary stream
    }
    streams.push({ ref, decoded });
    const head = Buffer.from(decoded.subarray(0, 400)).toString("latin1");
    if (head.includes("begincmap") || head.includes("beginbfchar") || head.includes("beginbfrange")) cmaps.push({ ref, cmap: parseToUnicode(decoded) });
  }
  for (const { ref, decoded } of streams) {
    let operands;
    try {
      operands = shownStrings(decoded);
    } catch {
      continue;
    }
    if (!operands.length) continue;
    for (const { ref: cmapRef, cmap } of cmaps) {
      const text = squash(operands.map((codes) => cmap.decode(codes)).join(""));
      for (const needle of needles) {
        if (text.includes(squash(needle))) found[needle].push(`stream ${ref} decoded through the ToUnicode map ${cmapRef}`);
      }
    }
  }
  return found;
}

/** The needles that were found somewhere: [] means the file is clean. */
export async function textLeaks(bytes, needles) {
  const found = await findText(bytes, needles);
  return needles.filter((needle) => found[needle].length > 0);
}

/**
 * Structure facts of a file:
 *   orphans     objects nothing reachable from the trailer points at (parser artefacts excluded)
 *   audit       problems of the structural self-check (ghost pages, annotations no page lists ...)
 *   revisions   number of "startxref" sections; redefined = object numbers defined more than once
 *   encrypted, hasByteRange (a signature dictionary), id (hex of the first trailer /ID string), header
 */
export async function fileFacts(bytes, { allowStructTree = false } = {}) {
  const doc = await loadPlain(bytes);
  const text = Buffer.from(bytes).toString("latin1");
  const outside = text.replace(/stream\r?\n[\s\S]*?endstream/g, "stream endstream");
  const seen = new Map();
  for (const match of outside.matchAll(/(?:^|[\r\n ])(\d+) (\d+) obj(?![a-z])/g)) seen.set(match[1], (seen.get(match[1]) || 0) + 1);
  const idObject = doc.context.trailerInfo.ID instanceof PDFRef ? doc.context.lookup(doc.context.trailerInfo.ID) : doc.context.trailerInfo.ID;
  const firstId = idObject instanceof PDFArray ? idObject.get(0) : undefined;
  return {
    doc,
    pages: doc.getPageCount(),
    orphans: findOrphans(doc).map(([ref]) => ref.toString()),
    audit: auditOutput(doc, { allowStructTree }),
    revisions: (outside.match(/startxref/g) || []).length,
    redefined: [...seen].filter(([, count]) => count > 1).map(([number]) => Number(number)),
    encrypted: outside.includes("/Encrypt"),
    hasByteRange: outside.includes("/ByteRange"),
    id: firstId instanceof PDFHexString || firstId instanceof PDFString ? Buffer.from(firstId.asBytes()).toString("hex").toUpperCase() : null,
    header: text.slice(0, 8),
    catalogKeys: doc.catalog.keys().map((key) => key.decodeText())
  };
}

/** The decoded content of a page as text (all its streams joined), for checks on the operators written. */
export function pageContentText(page) {
  const { context } = page.node;
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of("Contents"))];
  return refs
    .map((ref) => context.lookup(ref))
    .filter((stream) => stream instanceof PDFStream)
    .map((stream) => Buffer.from(decodeStreamBytes(context, stream)).toString("latin1"))
    .join("\n");
}

/** Resource names of a page by category: { Font: [...], XObject: [...], ExtGState: [...] }. */
export function resourceNames(page) {
  const resources = page.node.Resources();
  const out = {};
  for (const category of ["Font", "XObject", "Pattern", "ExtGState"]) {
    const dict = resources ? resources.lookupMaybe(PDFName.of(category), PDFDict) : undefined;
    out[category] = dict ? dict.keys().map((key) => key.decodeText()) : [];
  }
  return out;
}
