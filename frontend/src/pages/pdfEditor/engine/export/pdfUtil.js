// Small object-level helpers shared by the modules of the export engine.
import { pdfLib } from "../lib.js";

const { PDFDict, PDFArray, PDFStream, PDFRef, PDFName, PDFNumber, PDFString, PDFHexString, PDFNull, PDFBool } = pdfLib;

export const N = (name) => PDFName.of(name);

/** Follows references until a non-reference object (or undefined). Cycle-safe. */
export function resolve(context, object) {
  let current = object;
  for (let step = 0; step < 32 && current instanceof PDFRef; step += 1) current = context.lookup(current);
  if (current === PDFNull) return undefined;
  return current instanceof PDFRef ? undefined : current;
}

/** dict.get(key) resolved, or undefined. Accepts a PDFDict or a PDFStream (its dictionary). */
export function getResolved(context, dictOrStream, key) {
  const dict = dictOrStream instanceof PDFStream ? dictOrStream.dict : dictOrStream;
  if (!(dict instanceof PDFDict)) return undefined;
  return resolve(context, dict.get(typeof key === "string" ? N(key) : key));
}

export function dictOf(context, object) {
  const value = resolve(context, object);
  if (value instanceof PDFDict) return value;
  if (value instanceof PDFStream) return value.dict;
  return undefined;
}

export function arrayOf(context, object) {
  const value = resolve(context, object);
  return value instanceof PDFArray ? value : undefined;
}

export function numberOf(context, object) {
  const value = resolve(context, object);
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

export function nameOf(context, object) {
  const value = resolve(context, object);
  return value instanceof PDFName ? value.decodeText() : undefined;
}

export function boolOf(context, object) {
  const value = resolve(context, object);
  return value instanceof PDFBool ? value.asBoolean() : undefined;
}

export function isString(object) {
  return object instanceof PDFString || object instanceof PDFHexString;
}

const PDF_DOC_ENCODING_HIGH = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
  0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
  0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac
};

/**
 * Decodes a PDF "text string" (ISO 32000-1 7.9.2.2): UTF-16BE with BOM, PDFDocEncoding, and the two
 * variants met in the wild / PDF 2.0: UTF-16LE with BOM and UTF-8 with BOM.
 * (The library's decodeText() knows the first three; it reads a UTF-8 BOM string as PDFDocEncoding mojibake.)
 */
export function decodeTextBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    return text;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let text = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) text += String.fromCharCode((bytes[index + 1] << 8) | bytes[index]);
    return text;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(PDF_DOC_ENCODING_HIGH[bytes[index]] ?? bytes[index]);
  return text;
}

/** Text of a PDFString / PDFHexString (resolved), or undefined. */
export function textOf(context, object) {
  const value = resolve(context, object);
  if (!isString(value)) return undefined;
  return decodeTextBytes(value.asBytes());
}

/** Raw bytes of a string object as a latin1 JS string: the right key for name trees. */
export function bytesKey(object) {
  if (!isString(object)) return undefined;
  const bytes = object.asBytes();
  let key = "";
  for (let index = 0; index < bytes.length; index += 1) key += String.fromCharCode(bytes[index]);
  return key;
}

/** A text string object that every reader understands: UTF-16BE with BOM (hex string). */
export function textString(value) {
  return PDFHexString.fromText(value);
}

/**
 * Reads a name tree (ISO 32000-1 7.9.6) into a Map: key = raw bytes of the name as a latin1 string,
 * value = the (unresolved) value object. Iterative, cycle-safe, tolerant of missing /Limits.
 */
export function readNameTree(context, root) {
  const out = new Map();
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const node = dictOf(context, stack.pop());
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const names = arrayOf(context, node.get(N("Names")));
    if (names) {
      for (let index = 0; index + 1 < names.size(); index += 2) {
        const key = bytesKey(resolve(context, names.get(index)));
        if (key !== undefined && !out.has(key)) out.set(key, names.get(index + 1));
      }
    }
    const kids = arrayOf(context, node.get(N("Kids")));
    if (kids) for (let index = kids.size() - 1; index >= 0; index -= 1) stack.push(kids.get(index));
  }
  return out;
}

/** Reads a number tree (ISO 32000-1 7.9.7) into a Map<number, object>. */
export function readNumberTree(context, root) {
  const out = new Map();
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const node = dictOf(context, stack.pop());
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const nums = arrayOf(context, node.get(N("Nums")));
    if (nums) {
      for (let index = 0; index + 1 < nums.size(); index += 2) {
        const key = numberOf(context, nums.get(index));
        if (key !== undefined && !out.has(key)) out.set(key, nums.get(index + 1));
      }
    }
    const kids = arrayOf(context, node.get(N("Kids")));
    if (kids) for (let index = kids.size() - 1; index >= 0; index -= 1) stack.push(kids.get(index));
  }
  return out;
}

/** JS array of the items of a (possibly indirect) PDF array; [] when it is not an array. */
export function items(context, object) {
  const array = arrayOf(context, object);
  return array ? array.asArray() : [];
}

/** Bytes -> latin1 string (chunked: String.fromCharCode(...hugeArray) overflows the stack). */
export function latin1(bytes, start = 0, end = bytes.length) {
  let out = "";
  for (let index = start; index < end; index += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(end, index + 0x8000)));
  }
  return out;
}

/** Position of the ASCII string `needle` in `bytes` at or after `from`, or -1. No copy of the haystack. */
export function indexOfAscii(bytes, needle, from = 0, to = bytes.length) {
  const first = needle.charCodeAt(0);
  const length = needle.length;
  const last = to - length;
  let at = bytes.indexOf(first, from);
  while (at >= 0 && at <= last) {
    let matched = 1;
    while (matched < length && bytes[at + matched] === needle.charCodeAt(matched)) matched += 1;
    if (matched === length) return at;
    at = bytes.indexOf(first, at + 1);
  }
  return -1;
}
