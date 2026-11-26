// Tokenizer and serializer for PDF content streams (page content, Form XObjects, Type3 glyph procedures,
// tiling patterns) and for the token language of embedded CMaps.
//
// Pure JavaScript on Uint8Array, no dependencies: the same code runs in the browser, in a worker and in Node.
//
// Design rule: an operation that is not changed is written back BYTE FOR BYTE. Every operation therefore
// remembers the slice [start, end) of the source it came from (start = end of the previous operation, so the
// white space and comments in front of it travel with it), and every operand token remembers its own slice.
// A caller edits a stream by replacing single operations with `{ raw: Uint8Array }` entries and calling
// serializeOperations().
//
// What is parsed (ISO 32000-1: 7.2 lexical conventions, 7.3 objects, 7.8.2 content streams, 8.9.7 inline images):
//   numbers (42, -7, +3, 4., .5, -.25), names with #xx escapes, literal strings (escapes, octal, balanced
//   parentheses, line continuations, raw end-of-line normalised to LF), hex strings (white space inside, odd
//   digit count), arrays, dictionaries (nested), comments, the keywords true / false / null, operators, and
//   inline images (BI <dict> ID <binary> EI) with several ways of finding the end of the data.
//
// Anything that is not understood throws ContentParseError: the caller must then treat the whole stream as
// "not understood" (textRemoval.js turns it into the fallback reason "content-syntax": the page is rasterised,
// or an "erase" target is reported as "cover-needed"). The error never leaves the engine.

export class ContentParseError extends Error {
  constructor(message, offset) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = "ContentParseError";
    this.offset = offset;
  }
}

// ---------------------------------------------------------------- character classes
const CH_WS = 1;
const CH_DELIM = 2;
const CLASS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) CLASS[c] = CH_WS;
for (const c of "()<>[]{}/%") CLASS[c.charCodeAt(0)] = CH_DELIM;

export const isWhiteSpace = (c) => CLASS[c] === CH_WS;
export const isDelimiter = (c) => CLASS[c] === CH_DELIM;
const isRegular = (c) => CLASS[c] === 0;

const hexVal = (c) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1);

// ---------------------------------------------------------------- operator table
// Operand counts of ISO 32000-1 Table 51 (null = variable). Only used to recognise operators; the interpreter
// validates the operands of the operators it executes.
export const OPERATORS = Object.freeze({
  w: 1, J: 1, j: 1, M: 1, d: 2, ri: 1, i: 1, gs: 1,
  q: 0, Q: 0, cm: 6,
  m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4,
  S: 0, s: 0, f: 0, F: 0, "f*": 0, B: 0, "B*": 0, b: 0, "b*": 0, n: 0,
  W: 0, "W*": 0,
  BT: 0, ET: 0,
  Tc: 1, Tw: 1, Tz: 1, TL: 1, Tf: 2, Tr: 1, Ts: 1,
  Td: 2, TD: 2, Tm: 6, "T*": 0,
  Tj: 1, TJ: 1, "'": 1, "\"": 3,
  d0: 2, d1: 6,
  CS: 1, cs: 1, SC: null, SCN: null, sc: null, scn: null, G: 1, g: 1, RG: 3, rg: 3, K: 4, k: 4,
  sh: 1,
  BI: 0, ID: 0, EI: 0,
  Do: 1,
  MP: 1, DP: 2, BMC: 1, BDC: 2, EMC: 0,
  BX: 0, EX: 0
});

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

// ---------------------------------------------------------------- tokenizer
class Lexer {
  constructor(bytes) {
    this.b = bytes;
    this.n = bytes.length;
    this.pos = 0;
    this.comments = [];
  }

  skipSpaceAndComments() {
    const { b, n } = this;
    let p = this.pos;
    for (;;) {
      while (p < n && CLASS[b[p]] === CH_WS) p++;
      if (p < n && b[p] === 0x25 /* % */) {
        const start = p;
        while (p < n && b[p] !== 0x0a && b[p] !== 0x0d) p++;
        this.comments.push([start, p]); // the end-of-line that follows is not part of the comment
        continue;
      }
      break;
    }
    this.pos = p;
  }

  /** Next object or operator token, or null at the end of the data. */
  next() {
    this.skipSpaceAndComments();
    const { b, n } = this;
    const start = this.pos;
    if (start >= n) return null;
    const c = b[start];
    if (c === 0x28) return this.literalString(start);
    if (c === 0x2f) return this.name(start);
    if (c === 0x5b) return this.array(start);
    if (c === 0x3c) return b[start + 1] === 0x3c ? this.dict(start) : this.hexString(start);
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      throw new ContentParseError(`unexpected delimiter "${String.fromCharCode(c)}"`, start);
    }
    // regular token: number, keyword or operator
    let p = start;
    while (p < n && isRegular(b[p])) p++;
    this.pos = p;
    const text = latin1(b, start, p);
    if (NUMBER_RE.test(text)) return { type: "num", start, end: p, value: Number(text), isInt: /^[+-]?\d+$/.test(text) };
    if (text === "true") return { type: "kw", start, end: p, value: true };
    if (text === "false") return { type: "kw", start, end: p, value: false };
    if (text === "null") return { type: "kw", start, end: p, value: null };
    return { type: "op", start, end: p, value: text };
  }

  name(start) {
    const { b, n } = this;
    let p = start + 1;
    let out = "";
    while (p < n && isRegular(b[p])) {
      if (b[p] === 0x23 /* # */) {
        const hi = hexVal(b[p + 1]);
        const lo = hexVal(b[p + 2]);
        if (hi < 0 || lo < 0) throw new ContentParseError("bad #xx escape in a name", p);
        out += String.fromCharCode(hi * 16 + lo);
        p += 3;
      } else {
        out += String.fromCharCode(b[p]);
        p++;
      }
    }
    this.pos = p;
    return { type: "name", start, end: p, value: out };
  }

  literalString(start) {
    const { b, n } = this;
    const out = [];
    let depth = 1;
    let p = start + 1;
    while (p < n) {
      const c = b[p];
      if (c === 0x5c /* \ */) {
        const d = b[p + 1];
        if (d === undefined) throw new ContentParseError("unterminated string", start);
        if (d >= 0x30 && d <= 0x37) {
          let v = 0;
          let k = 0;
          while (k < 3 && b[p + 1 + k] >= 0x30 && b[p + 1 + k] <= 0x37) {
            v = v * 8 + (b[p + 1 + k] - 0x30);
            k++;
          }
          out.push(v & 0xff); // high-order overflow is ignored (7.3.4.2)
          p += 1 + k;
        } else if (d === 0x0d) {
          p += b[p + 2] === 0x0a ? 3 : 2; // line continuation
        } else if (d === 0x0a) {
          p += 2;
        } else {
          const map = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c };
          out.push(map[d] ?? d); // \( \) \\ and "unknown escape: ignore the backslash"
          p += 2;
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
        p++;
      } else if (c === 0x29) {
        depth--;
        p++;
        if (depth === 0) {
          this.pos = p;
          return { type: "str", start, end: p, value: Uint8Array.from(out) };
        }
        out.push(c);
      } else if (c === 0x0d) {
        out.push(0x0a); // a raw end-of-line inside a string reads as one LF
        p += b[p + 1] === 0x0a ? 2 : 1;
      } else {
        out.push(c);
        p++;
      }
    }
    throw new ContentParseError("unterminated string", start);
  }

  hexString(start) {
    const { b, n } = this;
    const out = [];
    let hi = -1;
    let p = start + 1;
    while (p < n) {
      const c = b[p];
      if (c === 0x3e) {
        if (hi >= 0) out.push(hi * 16); // odd number of digits: the last one is followed by 0
        this.pos = p + 1;
        return { type: "hex", start, end: p + 1, value: Uint8Array.from(out) };
      }
      const v = hexVal(c);
      if (v >= 0) {
        if (hi < 0) hi = v;
        else {
          out.push(hi * 16 + v);
          hi = -1;
        }
      } else if (CLASS[c] !== CH_WS) {
        throw new ContentParseError("invalid character in a hex string", p);
      }
      p++;
    }
    throw new ContentParseError("unterminated hex string", start);
  }

  array(start) {
    this.pos = start + 1;
    const items = [];
    for (;;) {
      this.skipSpaceAndComments();
      if (this.pos >= this.n) throw new ContentParseError("unterminated array", start);
      if (this.b[this.pos] === 0x5d) {
        this.pos++;
        return { type: "arr", start, end: this.pos, items };
      }
      const t = this.next();
      if (t.type === "op") throw new ContentParseError(`operator "${t.value}" inside an array`, t.start);
      items.push(t);
    }
  }

  dict(start) {
    this.pos = start + 2;
    const entries = [];
    for (;;) {
      this.skipSpaceAndComments();
      if (this.pos >= this.n) throw new ContentParseError("unterminated dictionary", start);
      if (this.b[this.pos] === 0x3e && this.b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { type: "dict", start, end: this.pos, entries };
      }
      const key = this.next();
      if (key.type !== "name") throw new ContentParseError("dictionary key is not a name", key.start);
      this.skipSpaceAndComments();
      const value = this.next();
      if (!value || value.type === "op") throw new ContentParseError("dictionary value missing", key.end);
      entries.push([key, value]);
    }
  }
}

function latin1(b, start, end) {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

/**
 * Raw token reader (used for CMap programs, whose syntax is the same token language):
 * returns a function that yields the next token ({ type: 'num'|'name'|'str'|'hex'|'arr'|'dict'|'kw'|'op', ... })
 * or null at the end. Throws ContentParseError on malformed input.
 */
export function createTokenReader(bytes) {
  const lexer = new Lexer(bytes);
  return () => lexer.next();
}

// ---------------------------------------------------------------- inline images
const INLINE_KEYS = {
  BPC: "BitsPerComponent", CS: "ColorSpace", D: "Decode", DP: "DecodeParms", F: "Filter", H: "Height", IM: "ImageMask",
  I: "Interpolate", W: "Width", L: "Length"
};
const INLINE_FILTERS = {
  AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode", Fl: "FlateDecode", RL: "RunLengthDecode", CCF: "CCITTFaxDecode", DCT: "DCTDecode"
};
const CS_COMPONENTS = {
  G: 1, DeviceGray: 1, CalGray: 1, I: 1, Indexed: 1, RGB: 3, DeviceRGB: 3, CalRGB: 3, Lab: 3, CMYK: 4, DeviceCMYK: 4
};

function inlineImageInfo(entries) {
  const info = {};
  for (const [k, v] of entries) info[INLINE_KEYS[k.value] || k.value] = v;
  const num = (t) => (t && t.type === "num" ? t.value : undefined);
  let filter = info.Filter;
  if (filter && filter.type === "arr") filter = filter.items[0];
  const filterName = filter && filter.type === "name" ? INLINE_FILTERS[filter.value] || filter.value : filter ? "?" : null;
  let components;
  const cs = info.ColorSpace;
  if (info.ImageMask && info.ImageMask.type === "kw" && info.ImageMask.value === true) components = 1;
  else if (cs && cs.type === "name") components = CS_COMPONENTS[cs.value];
  else if (cs && cs.type === "arr" && cs.items[0]?.type === "name" && (cs.items[0].value === "I" || cs.items[0].value === "Indexed")) components = 1;
  const isMask = info.ImageMask?.value === true;
  return {
    width: num(info.Width),
    height: num(info.Height),
    bpc: isMask ? 1 : num(info.BitsPerComponent),
    components,
    filter: filterName,
    length: num(info.Length)
  };
}

/** Is there an "EI" keyword at p (optionally after white space)? Returns the offset just after it, or -1. */
function eiAt(b, p, allowLeadingSpace) {
  const n = b.length;
  if (allowLeadingSpace) while (p < n && CLASS[b[p]] === CH_WS) p++;
  if (b[p] !== 0x45 || b[p + 1] !== 0x49) return -1;
  const after = b[p + 2];
  if (after === undefined || CLASS[after] !== 0) return p + 2;
  return -1;
}

/**
 * Finds the end of the data of an inline image whose "ID" keyword ends at idEnd.
 * Returns { dataStart, dataEnd, end (offset after EI), method }.
 * Methods, in order of reliability:
 *   length     the /L (/Length) entry of PDF 2.0
 *   computed   no filter: height * ceil(width * components * bpc / 8) bytes
 *   eod        ASCIIHexDecode / ASCII85Decode: the end-of-data marker of the first filter
 *   scan       "EI" followed by white space, accepted only when what follows parses as content operations
 */
function findInlineImageEnd(b, idEnd, info, depth) {
  const n = b.length;
  const ascii = info.filter === "ASCIIHexDecode" || info.filter === "ASCII85Decode";
  let dataStart = idEnd;
  if (ascii) {
    while (dataStart < n && CLASS[b[dataStart]] === CH_WS) dataStart++;
  } else if (dataStart < n && CLASS[b[dataStart]] === CH_WS) {
    dataStart++; // exactly one white-space character follows ID (8.9.7)
  }
  const tryLength = (len, method) => {
    if (!Number.isInteger(len) || len < 0) return null;
    // a CR LF pair after ID is common: the LF may or may not have been counted as data by the producer
    for (const s of b[dataStart - 1] === 0x0d && b[dataStart] === 0x0a ? [dataStart, dataStart + 1] : [dataStart]) {
      const e = eiAt(b, s + len, true);
      if (e >= 0) return { dataStart: s, dataEnd: s + len, end: e, method };
    }
    return null;
  };
  if (info.length !== undefined) {
    const r = tryLength(info.length, "length");
    if (r) return r;
  }
  if (info.filter === null && info.width > 0 && info.height > 0 && info.bpc > 0 && info.components > 0) {
    const r = tryLength(info.height * Math.ceil((info.width * info.components * info.bpc) / 8), "computed");
    if (r) return r;
  }
  if (ascii) {
    let p = dataStart;
    if (info.filter === "ASCIIHexDecode") {
      while (p < n && b[p] !== 0x3e) p++;
      p++;
    } else {
      while (p < n - 1 && !(b[p] === 0x7e && b[p + 1] === 0x3e)) p++;
      p += 2;
    }
    if (p <= n) {
      const e = eiAt(b, p, true);
      if (e >= 0) return { dataStart, dataEnd: p, end: e, method: "eod" };
    }
  }
  // scan: every "EI" followed by white space / a delimiter / the end is a candidate
  for (let p = dataStart; p < n - 1; p++) {
    if (b[p] !== 0x45 || b[p + 1] !== 0x49) continue;
    const e = eiAt(b, p, false);
    if (e < 0) continue;
    if (!looksLikeContent(b, e, depth)) continue;
    let dataEnd = p;
    if (dataEnd > dataStart && CLASS[b[dataEnd - 1]] === CH_WS) dataEnd--; // the EOL in front of EI is not data
    return { dataStart, dataEnd, end: e, method: "scan" };
  }
  throw new ContentParseError("inline image without a recognisable EI", idEnd);
}

/** Trial parse: do the bytes from `from` on read as (up to 12) well-formed operations with known operators? */
function looksLikeContent(b, from, depth) {
  if (depth >= 2) {
    // deep nesting of trial parses: only the cheap test (no binary bytes in the next 16)
    for (let i = from; i < Math.min(b.length, from + 16); i++) if (b[i] > 0x7e || (b[i] < 0x20 && CLASS[b[i]] !== CH_WS)) return false;
    return true;
  }
  try {
    const ops = parseOperations(b, from, 12, depth + 1);
    return ops.ops.every((o) => o.known);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- parser
function parseOperations(bytes, from, maxOps, depth) {
  const lexer = new Lexer(bytes);
  lexer.pos = from;
  const ops = [];
  let args = [];
  let opStart = from;
  for (;;) {
    if (maxOps && ops.length >= maxOps) break;
    const t = lexer.next();
    if (t === null) break;
    if (t.type !== "op") {
      args.push(t);
      continue;
    }
    if (t.value === "BI") {
      if (args.length) throw new ContentParseError("operands in front of BI", t.start);
      const entries = [];
      let idEnd;
      for (;;) {
        const k = lexer.next();
        if (k === null) throw new ContentParseError("unterminated inline image dictionary", t.start);
        if (k.type === "op" && k.value === "ID") {
          idEnd = k.end;
          break;
        }
        if (k.type !== "name") throw new ContentParseError("inline image key is not a name", k.start);
        const v = lexer.next();
        if (v === null || v.type === "op") throw new ContentParseError("inline image value missing", k.end);
        entries.push([k, v]);
      }
      const info = inlineImageInfo(entries);
      const found = findInlineImageEnd(bytes, idEnd, info, depth);
      lexer.pos = found.end;
      ops.push({ op: "BI", args: [], start: opStart, opStart: t.start, end: found.end, known: true, inlineImage: { entries, info, ...found } });
      opStart = found.end;
      args = [];
      continue;
    }
    if (t.value === "ID" || t.value === "EI") throw new ContentParseError(`${t.value} without BI`, t.start);
    ops.push({ op: t.value, args, start: opStart, opStart: t.start, end: t.end, known: Object.prototype.hasOwnProperty.call(OPERATORS, t.value) });
    opStart = t.end;
    args = [];
  }
  return { ops, danglingArgs: args, tailStart: opStart, comments: lexer.comments };
}

/**
 * Parses a content stream.
 * Returns { source, ops, tailStart, danglingOperands }.
 *   ops[i] = { op, args, start, opStart, end, known, inlineImage? }
 *     op        operator name ("Tj", "BI" for a whole inline image ...)
 *     args      operand tokens: { type: 'num'|'name'|'str'|'hex'|'arr'|'dict'|'kw', start, end, value | items | entries }
 *     start     where the slice of this operation begins (= end of the previous one)
 *     opStart   where the operator keyword begins
 *     end       where the slice ends (just after the keyword, or after EI)
 *     known     whether the operator is in Table 51
 *   tailStart   offset of the bytes after the last operation (white space, comments)
 *   danglingOperands  operands after the last operator (a stream may end in the middle of an operation only
 *                     when it is one part of a /Contents array; a caller that parses the concatenation of all
 *                     parts can demand that this is empty)
 *   comments    [[start, end), ...] of every comment (% up to, not including, the end of line), in order
 */
export function parseContentStream(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("parseContentStream expects a Uint8Array");
  const { ops, danglingArgs, tailStart, comments } = parseOperations(bytes, 0, 0, 0);
  return { source: bytes, ops, tailStart, danglingOperands: danglingArgs, comments };
}

// ---------------------------------------------------------------- serializer
const enc = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
export const asciiBytes = enc;

/**
 * Number in PDF syntax: no exponent, at most `digits` decimals, no trailing zeros, "-0" avoided.
 */
export function formatNumber(v, digits = 5) {
  if (!Number.isFinite(v)) throw new RangeError(`cannot write ${v} into a content stream`);
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(digits);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s;
}

/** Literal string "(...)": the escapes that are needed, octal for everything outside printable ASCII. */
export function formatLiteralString(bytes) {
  let s = "(";
  for (const c of bytes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += `\\${String.fromCharCode(c)}`;
    else if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c);
    else s += `\\${c.toString(8).padStart(3, "0")}`;
  }
  return `${s})`;
}

export function formatHexString(bytes) {
  let s = "<";
  for (const c of bytes) s += (c < 16 ? "0" : "") + c.toString(16).toUpperCase();
  return `${s}>`;
}

export function formatName(name) {
  let s = "/";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & 0xff;
    if (c < 0x21 || c > 0x7e || c === 0x23 || CLASS[c] !== 0) s += `#${c.toString(16).toUpperCase().padStart(2, "0")}`;
    else s += String.fromCharCode(c);
  }
  return s;
}

/** The source bytes of a token (for copying an operand unchanged into a rewritten operation). */
export function tokenSource(source, token) {
  return source.subarray(token.start, token.end);
}

/**
 * Writes a list of operations back to bytes.
 *   items[i] is either an operation of parseContentStream(source) (copied verbatim: source[start, end)),
 *            or { raw: Uint8Array | string } (new bytes; a line feed is put in front of them),
 *            or null / undefined (operation dropped).
 * The tail of the source (white space and comments after the last operation) is appended when
 * `tailStart` is given.
 * options.stripComments: the `comments` ranges of parseContentStream(source). The comments are then left out of
 * the verbatim slices (operands and operators stay byte-identical; a comment can repeat the text that an edit
 * removes, and it means nothing to a viewer).
 */
export function serializeOperations(source, items, tailStart, options = {}) {
  const parts = [];
  let total = 0;
  const push = (u8) => {
    if (u8.length) {
      parts.push(u8);
      total += u8.length;
    }
  };
  const comments = options.stripComments || [];
  let ci = 0;
  /** source[start, end) without the comments in it (items come in source order, so `ci` only moves forward) */
  const pushSlice = (start, end) => {
    while (ci < comments.length && comments[ci][1] <= start) ci++;
    let pos = start;
    for (let k = ci; k < comments.length && comments[k][0] < end; k++) {
      if (comments[k][0] > pos) push(source.subarray(pos, comments[k][0]));
      pos = Math.max(pos, Math.min(end, comments[k][1]));
    }
    if (pos < end) push(source.subarray(pos, end));
  };
  const LF = Uint8Array.of(0x0a);
  let lastWasRaw = false;
  let wroteAnything = false;
  for (const it of items) {
    if (!it) continue;
    if (it.raw !== undefined) {
      const raw = typeof it.raw === "string" ? enc(it.raw) : it.raw;
      if (!raw.length) continue;
      if (wroteAnything) push(LF);
      push(raw);
      lastWasRaw = true;
    } else {
      // after new bytes (which end in an operator keyword) a verbatim slice needs a separator unless it
      // brings its own white space or starts with a delimiter
      if (lastWasRaw && it.end > it.start && CLASS[source[it.start]] === 0) push(LF);
      pushSlice(it.start, it.end);
      lastWasRaw = false;
    }
    wroteAnything = true;
  }
  if (tailStart !== undefined && tailStart < source.length) {
    if (lastWasRaw && CLASS[source[tailStart]] === 0) push(LF);
    pushSlice(tailStart, source.length);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Concatenates byte chunks and strings (strings are taken as Latin-1). */
export function concatBytes(chunks) {
  const arr = chunks.map((c) => (typeof c === "string" ? enc(c) : c));
  const out = new Uint8Array(arr.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of arr) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
