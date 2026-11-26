// Byte-level PDF helpers for signature inspection: revisions, /ByteRange search, a small tokenizer for
// direct objects (enough for signature dictionaries), text-string and date decoding.
// Browser + Node, no dependency. It works on the raw file, independently of any cross-reference table, so it
// also finds signature dictionaries that the current revision no longer references, and it cannot be fooled
// by a parser that resolves objects differently than the signer saw them.

import { PdfEditorError } from "../errors.js";
import { fromHex, latin1Decode, utf16beDecode, utf16leDecode, utf8Decode } from "./bytes.js";

const WS = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) WS[code] = 1;
const DELIMITER = new Uint8Array(256);
for (const char of "()<>[]{}/%") DELIMITER[char.charCodeAt(0)] = 1;
const isDigit = (code) => code >= 0x30 && code <= 0x39;

export const isPdfWhiteSpace = (code) => WS[code] === 1;

/** ASCII text -> bytes (search patterns, keywords). */
export const asciiBytes = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** First offset >= from where `pattern` (Uint8Array) occurs before `to`, or -1. */
export function indexOfBytes(bytes, pattern, from = 0, to = bytes.length) {
  const first = pattern[0];
  const last = to - pattern.length;
  let i = from;
  while (i <= last) {
    i = bytes.indexOf(first, i);
    if (i < 0 || i > last) return -1;
    let j = 1;
    while (j < pattern.length && bytes[i + j] === pattern[j]) j++;
    if (j === pattern.length) return i;
    i++;
  }
  return -1;
}

/** Last offset <= from (and >= floor) where `pattern` occurs, or -1. */
export function lastIndexOfBytes(bytes, pattern, from = bytes.length - pattern.length, floor = 0) {
  const first = pattern[0];
  let i = Math.min(from, bytes.length - pattern.length);
  while (i >= floor) {
    i = bytes.lastIndexOf(first, i);
    if (i < floor) return -1;
    let j = 1;
    while (j < pattern.length && bytes[i + j] === pattern[j]) j++;
    if (j === pattern.length) return i;
    i--;
  }
  return -1;
}

/** True when `pattern` sits exactly at offset `at`. */
export function startsWithAt(bytes, pattern, at) {
  if (at < 0 || at + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i++) if (bytes[at + i] !== pattern[i]) return false;
  return true;
}

const P_EOF = asciiBytes("%%EOF");
const P_STARTXREF = asciiBytes("startxref");
const P_BYTERANGE = asciiBytes("/ByteRange");
const P_OBJ = asciiBytes("obj");
const P_ENCRYPT = asciiBytes("/Encrypt");
const P_XREF = asciiBytes("xref");

export function skipWhiteSpace(bytes, pos) {
  let p = pos;
  while (p < bytes.length && WS[bytes[p]]) p++;
  return p;
}

/** Unsigned decimal integer at `pos` (at most 16 digits) -> { value, end } or null. */
export function readUnsigned(bytes, pos) {
  let p = pos;
  let value = 0;
  let digits = 0;
  while (p < bytes.length && isDigit(bytes[p]) && digits < 16) {
    value = value * 10 + (bytes[p] - 0x30);
    p++;
    digits++;
  }
  return digits ? { value, end: p } : null;
}

/**
 * Revisions of the file = every "startxref <offset> %%EOF" whose offset points at a cross-reference
 * section ("xref" or the object of an xref stream). A linearized file has one extra entry near the top
 * (its first-page section, "startxref 0"), which is skipped.
 * -> [{ index, startxrefOffset, xrefOffset, eofOffset, end }]  (end = first byte after %%EOF and its EOL)
 */
export function scanRevisions(bytes) {
  const revisions = [];
  let from = 0;
  for (;;) {
    const at = indexOfBytes(bytes, P_STARTXREF, from);
    if (at < 0) break;
    from = at + P_STARTXREF.length;
    let p = skipWhiteSpace(bytes, from);
    const number = readUnsigned(bytes, p);
    if (!number) continue;
    p = skipWhiteSpace(bytes, number.end);
    if (!startsWithAt(bytes, P_EOF, p)) continue;
    const eofOffset = p;
    let end = p + P_EOF.length;
    if (bytes[end] === 13 && bytes[end + 1] === 10) end += 2;
    else if (bytes[end] === 13 || bytes[end] === 10) end += 1;
    // does the offset point at a cross-reference section?
    let looksLikeXref = false;
    if (number.value > 0 && number.value < bytes.length) {
      const target = skipWhiteSpace(bytes, number.value);
      if (startsWithAt(bytes, P_XREF, target)) looksLikeXref = true;
      else {
        const objectNumber = readUnsigned(bytes, target);
        if (objectNumber) {
          const generation = readUnsigned(bytes, skipWhiteSpace(bytes, objectNumber.end));
          if (generation) looksLikeXref = startsWithAt(bytes, P_OBJ, skipWhiteSpace(bytes, generation.end));
        }
      }
    }
    if (!looksLikeXref) continue;
    revisions.push({ index: revisions.length + 1, startxrefOffset: at, xrefOffset: number.value, eofOffset, end });
  }
  return revisions;
}

/** True when the file has an /Encrypt entry in a trailer (strings of the document are then encrypted). */
export function looksEncrypted(bytes) {
  // the trailer dictionaries live near "startxref"; a plain search is enough for a yes / no hint
  let from = 0;
  for (;;) {
    const at = indexOfBytes(bytes, P_ENCRYPT, from);
    if (at < 0) return false;
    const next = bytes[at + P_ENCRYPT.length];
    if (WS[next] || isDigit(next) || next === 0x3c) return true; // "/Encrypt 12 0 R" or "/Encrypt <<"
    from = at + 1;
  }
}

// ------------------------------------------------------------------------------------------------
// tokenizer for direct objects

const syntaxError = (reason, offset) => new PdfEditorError("SIGN_PDF_SYNTAX", { reason, offset }, { detail: `${reason} (at byte ${offset})` });

export const isPdfSyntaxError = (error) => Boolean(error) && error.code === "SIGN_PDF_SYNTAX";

function skipWhiteSpaceAndComments(bytes, pos) {
  let p = pos;
  for (;;) {
    while (p < bytes.length && WS[bytes[p]]) p++;
    if (bytes[p] !== 0x25) return p; // %
    while (p < bytes.length && bytes[p] !== 10 && bytes[p] !== 13) p++;
  }
}

function parseLiteralString(bytes, pos) {
  // pos is at "("
  const out = [];
  let depth = 1;
  let p = pos + 1;
  while (p < bytes.length) {
    const code = bytes[p];
    if (code === 0x5c) { // backslash
      const next = bytes[p + 1];
      p += 2;
      if (next === 0x6e) out.push(10);
      else if (next === 0x72) out.push(13);
      else if (next === 0x74) out.push(9);
      else if (next === 0x62) out.push(8);
      else if (next === 0x66) out.push(12);
      else if (next === 13) {
        if (bytes[p] === 10) p++; // line continuation
      } else if (next === 10) {
        /* line continuation */
      } else if (next >= 0x30 && next <= 0x37) {
        let value = next - 0x30;
        let count = 1;
        while (count < 3 && bytes[p] >= 0x30 && bytes[p] <= 0x37) {
          value = value * 8 + (bytes[p] - 0x30);
          p++;
          count++;
        }
        out.push(value & 0xff);
      } else if (next !== undefined) out.push(next);
      continue;
    }
    if (code === 0x28) depth++;
    else if (code === 0x29) {
      depth--;
      if (depth === 0) return { type: "string", hex: false, bytes: Uint8Array.from(out), start: pos, end: p + 1 };
    }
    out.push(code);
    p++;
  }
  throw syntaxError("unterminated-string", pos);
}

function parseName(bytes, pos) {
  let p = pos + 1;
  let name = "";
  while (p < bytes.length && !WS[bytes[p]] && !DELIMITER[bytes[p]]) {
    if (bytes[p] === 0x23 && p + 2 < bytes.length) { // #xx
      const code = parseInt(latin1Decode(bytes.subarray(p + 1, p + 3)), 16);
      if (!Number.isNaN(code)) {
        name += String.fromCharCode(code);
        p += 3;
        continue;
      }
    }
    name += String.fromCharCode(bytes[p]);
    p++;
  }
  return { type: "name", value: name, start: pos, end: p };
}

/**
 * Parses one direct object at `pos`.
 * -> { type: "dict" | "array" | "name" | "string" | "number" | "ref" | "bool" | "null", start, end, ... }
 *    dict: entries = Map(name -> node); string: bytes (decoded) and hex; the offsets are those of the token in
 *    the source (for /Contents: what the byte range is compared with). Throws SIGN_PDF_SYNTAX.
 */
export function parseObject(bytes, pos, depth = 0) {
  if (depth > 40) throw syntaxError("too-deep", pos);
  const p = skipWhiteSpaceAndComments(bytes, pos);
  const code = bytes[p];
  if (code === undefined) throw syntaxError("unexpected-end", p);
  if (code === 0x3c) { // <
    if (bytes[p + 1] === 0x3c) {
      const entries = new Map();
      let q = p + 2;
      for (;;) {
        q = skipWhiteSpaceAndComments(bytes, q);
        if (bytes[q] === 0x3e && bytes[q + 1] === 0x3e) return { type: "dict", entries, start: p, end: q + 2 };
        if (bytes[q] !== 0x2f) throw syntaxError("bad-dictionary-key", q);
        const key = parseName(bytes, q);
        const value = parseObject(bytes, key.end, depth + 1);
        if (!entries.has(key.value)) entries.set(key.value, value); // the first occurrence wins, as in pdf.js
        q = value.end;
      }
    }
    const close = bytes.indexOf(0x3e, p + 1);
    if (close < 0) throw syntaxError("unterminated-hex-string", p);
    return {
      type: "string",
      hex: true,
      start: p,
      end: close + 1,
      get bytes() {
        return fromHex(latin1Decode(bytes.subarray(p + 1, close)));
      }
    };
  }
  if (code === 0x5b) { // [
    const items = [];
    let q = p + 1;
    for (;;) {
      q = skipWhiteSpaceAndComments(bytes, q);
      if (bytes[q] === 0x5d) return { type: "array", items, start: p, end: q + 1 };
      const item = parseObject(bytes, q, depth + 1);
      items.push(item);
      q = item.end;
    }
  }
  if (code === 0x28) return parseLiteralString(bytes, p);
  if (code === 0x2f) return parseName(bytes, p);
  if (isDigit(code) || code === 0x2b || code === 0x2d || code === 0x2e) {
    let q = p;
    if (bytes[q] === 0x2b || bytes[q] === 0x2d) q++;
    while (q < bytes.length && (isDigit(bytes[q]) || bytes[q] === 0x2e)) q++;
    const text = latin1Decode(bytes.subarray(p, q));
    const value = Number(text);
    if (/^\d+$/.test(text)) {
      // "N G R" ?
      const g = skipWhiteSpace(bytes, q);
      const generation = readUnsigned(bytes, g);
      if (generation && g > q) {
        const r = skipWhiteSpace(bytes, generation.end);
        if (r > generation.end && bytes[r] === 0x52 && (r + 1 >= bytes.length || WS[bytes[r + 1]] || DELIMITER[bytes[r + 1]])) {
          return { type: "ref", num: value, gen: generation.value, start: p, end: r + 1 };
        }
      }
    }
    return { type: "number", value, start: p, end: q };
  }
  const word = latin1Decode(bytes.subarray(p, Math.min(bytes.length, p + 5)));
  if (word.startsWith("true")) return { type: "bool", value: true, start: p, end: p + 4 };
  if (word.startsWith("false")) return { type: "bool", value: false, start: p, end: p + 5 };
  if (word.startsWith("null")) return { type: "null", start: p, end: p + 4 };
  throw syntaxError("unexpected-token", p);
}

/**
 * The indirect object header "N G obj" that encloses `offset` (searching backwards at most `maxBack`
 * bytes), or null when `offset` is not inside an object (trailer dictionary, xref area).
 * -> { num, gen, headerOffset, bodyOffset }
 */
export function enclosingObject(bytes, offset, maxBack = 4 * 1024 * 1024) {
  const floor = Math.max(0, offset - maxBack);
  let at = offset;
  for (;;) {
    at = lastIndexOfBytes(bytes, P_OBJ, at - 1, floor);
    if (at < 0) return null;
    // "endobj" before our offset: we are between objects
    if (at >= 3 && bytes[at - 3] === 0x65 && bytes[at - 2] === 0x6e && bytes[at - 1] === 0x64) return null;
    // must be followed by a non-regular character and preceded by "N G "
    const after = bytes[at + 3];
    if (after !== undefined && !WS[after] && !DELIMITER[after]) continue;
    let p = at - 1;
    if (!WS[bytes[p]]) continue;
    while (p >= 0 && WS[bytes[p]]) p--;
    const genEnd = p + 1;
    while (p >= 0 && isDigit(bytes[p])) p--;
    const genStart = p + 1;
    if (genStart === genEnd || !WS[bytes[p]]) continue;
    while (p >= 0 && WS[bytes[p]]) p--;
    const numEnd = p + 1;
    while (p >= 0 && isDigit(bytes[p])) p--;
    const numStart = p + 1;
    if (numStart === numEnd) continue;
    return {
      num: Number(latin1Decode(bytes.subarray(numStart, numEnd))),
      gen: Number(latin1Decode(bytes.subarray(genStart, genEnd))),
      headerOffset: numStart,
      bodyOffset: at + 3
    };
  }
}

/**
 * Latest definition of object `num gen` found by scanning for its header (works only for objects that are
 * not inside an object stream). -> parsed node or null. At most `maxAttempts` definitions are tried.
 */
export function findObjectByScan(bytes, num, gen = 0, maxAttempts = 16) {
  const header = asciiBytes(`${num} ${gen} obj`);
  let at = bytes.length;
  for (let attempt = 0; attempt < maxAttempts;) {
    at = lastIndexOfBytes(bytes, header, at - 1);
    if (at < 0) return null;
    const before = at === 0 ? 10 : bytes[at - 1];
    // a digit before would make it a different object number; "%%EOF12 0 obj" is legitimate
    if (isDigit(before)) continue;
    attempt++;
    try {
      return parseObject(bytes, at + header.length);
    } catch {
      /* a damaged definition: try the one before */
    }
  }
  return null;
}

/**
 * Every "/ByteRange [ ... ]" in the raw bytes.
 * -> [{ keyOffset, values: number[], arrayStart, arrayEnd }]
 */
export function scanByteRanges(bytes) {
  const found = [];
  let from = 0;
  for (;;) {
    const at = indexOfBytes(bytes, P_BYTERANGE, from);
    if (at < 0) break;
    from = at + P_BYTERANGE.length;
    let p = skipWhiteSpace(bytes, from);
    if (bytes[p] !== 0x5b) continue;
    const arrayStart = p;
    p++;
    const values = [];
    let ok = true;
    for (;;) {
      p = skipWhiteSpace(bytes, p);
      if (bytes[p] === 0x5d) {
        p++;
        break;
      }
      const number = readUnsigned(bytes, p);
      if (!number || values.length > 64) {
        ok = false;
        break;
      }
      values.push(number.value);
      p = number.end;
    }
    if (!ok || values.length < 2 || values.length % 2) continue;
    found.push({ keyOffset: at, values, arrayStart, arrayEnd: p });
  }
  return found;
}

// ------------------------------------------------------------------------------------------------
// text strings and dates

// PDFDocEncoding differs from Latin-1 in 0x18-0x1F and 0x80-0xAD (ISO 32000-1 annex D.2)
const PDF_DOC_ENCODING = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
  0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
  0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac
};

/** PDF text string (ISO 32000-1 7.9.2.2) -> JS string: UTF-16BE / UTF-16LE / UTF-8 with BOM, else PDFDocEncoding. */
export function decodeTextString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16beDecode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return utf16leDecode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8Decode(bytes.subarray(3));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(PDF_DOC_ENCODING[bytes[i]] || bytes[i]);
  return out;
}

/**
 * PDF date "D:YYYYMMDDHHmmSSOHH'mm'" -> { date: Date | null, text, hasTimeZone }.
 * Missing fields default as the standard says; a missing zone is read as UTC and flagged.
 */
export function parsePdfDate(text) {
  const match = /^\s*(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(text || "");
  if (!match) return { date: null, text, hasTimeZone: false };
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", sign, zoneHours = "00", zoneMinutes = "00"] = match;
  let time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (sign === "+" || sign === "-") time -= (sign === "-" ? -1 : 1) * (Number(zoneHours) * 60 + Number(zoneMinutes)) * 60000;
  const date = new Date(time);
  return { date: Number.isNaN(date.getTime()) ? null : date, text, hasTimeZone: Boolean(sign) };
}
