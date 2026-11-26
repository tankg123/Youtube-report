// The ONE ASN.1 module of the signing engine: a BER / DER reader and a DER writer on Uint8Array.
// Browser + Node, no dependency.
//
// Reader: definite and indefinite lengths (BER as BouncyCastle and "openssl cms -indef" write it), constructed
// (chunked) OCTET STRINGs, high tag numbers. Every node keeps its byte offsets in the source, so "the exact
// bytes that were signed" are always cut from the original and never re-encoded.
// Writer: DER only (definite minimal lengths, SET OF sorted on request).
//
// Malformed input never hangs and never crashes: the reader has a depth limit and a node limit and throws
// PdfEditorError("CERT_ASN1_MALFORMED", { reason, offset }) for everything it cannot read.

import { PdfEditorError } from "../errors.js";
import { bytesToBigInt, compareBytes, concatBytes, latin1Decode, toHex, utf16beDecode, utf16beEncode, utf8Decode, utf8Encode } from "./bytes.js";

export const ASN1_MALFORMED = "CERT_ASN1_MALFORMED";

/** The error of this module. `reason` is a stable keyword, `detail` an English text for logs. */
export function asn1Error(reason, offset, detail) {
  return new PdfEditorError(ASN1_MALFORMED, { reason, offset: offset ?? null }, { detail: detail || reason });
}

export const isAsn1Error = (error) => Boolean(error) && error.code === ASN1_MALFORMED;

export const CLASS = Object.freeze({ UNIVERSAL: 0, APPLICATION: 1, CONTEXT: 2, PRIVATE: 3 });
export const TAG = Object.freeze({
  BOOLEAN: 1, INTEGER: 2, BIT_STRING: 3, OCTET_STRING: 4, NULL: 5, OID: 6, ENUMERATED: 10, UTF8String: 12,
  SEQUENCE: 16, SET: 17, NumericString: 18, PrintableString: 19, TeletexString: 20, VideotexString: 21,
  IA5String: 22, UTCTime: 23, GeneralizedTime: 24, GraphicString: 25, VisibleString: 26, GeneralString: 27,
  UniversalString: 28, BMPString: 30
});
const STRING_TYPE_NAMES = {
  12: "UTF8String", 18: "NumericString", 19: "PrintableString", 20: "TeletexString", 21: "VideotexString",
  22: "IA5String", 25: "GraphicString", 26: "VisibleString", 27: "GeneralString", 28: "UniversalString",
  30: "BMPString"
};

const DEFAULT_LIMITS = { maxDepth: 64, maxNodes: 500000 };
// U+FFFD, built from its code so that the source holds no exotic character
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

export class Asn1Node {
  constructor(buf) {
    this.buf = buf;
    this.tagClass = 0;
    this.constructed = false;
    this.tag = 0;
    this.start = 0; // first identifier octet
    this.contentStart = 0;
    this.contentEnd = 0; // for an indefinite length: position of the end-of-contents octets
    this.end = 0; // one past the whole TLV (including end-of-contents octets)
    this.indefinite = false;
    this.children = null; // Asn1Node[] for constructed values
  }

  /** The whole TLV exactly as it is in the source. */
  get raw() {
    return this.buf.subarray(this.start, this.end);
  }

  /** Content octets. For a constructed (chunked) string type: the concatenation of the chunks. */
  get content() {
    if (!this.constructed) return this.buf.subarray(this.contentStart, this.contentEnd);
    if (this.tagClass === CLASS.UNIVERSAL && (this.tag === TAG.OCTET_STRING || STRING_TYPE_NAMES[this.tag])) {
      return concatBytes(this.children.map((child) => child.content));
    }
    return this.buf.subarray(this.contentStart, this.contentEnd);
  }

  get length() {
    return this.contentEnd - this.contentStart;
  }

  isUniversal(tag) {
    return this.tagClass === CLASS.UNIVERSAL && this.tag === tag;
  }

  isContext(tag) {
    return this.tagClass === CLASS.CONTEXT && this.tag === tag;
  }

  get isSequence() {
    return this.isUniversal(TAG.SEQUENCE) && this.constructed;
  }

  get isSet() {
    return this.isUniversal(TAG.SET) && this.constructed;
  }

  /** Child `index`, or an error that names what was expected. */
  child(index, what = "element") {
    if (!this.children || index >= this.children.length) throw asn1Error("missing-element", this.start, `Missing ${what}`);
    return this.children[index];
  }

  /** First child with the given context tag ([n]), or null. */
  context(tag) {
    if (!this.children) return null;
    return this.children.find((child) => child.isContext(tag)) || null;
  }

  // ---- typed readers (they throw on the wrong type) ----

  oid() {
    if (!this.isUniversal(TAG.OID) || this.constructed) throw asn1Error("unexpected-type", this.start, "Expected an OBJECT IDENTIFIER");
    return oidFromBytes(this.content);
  }

  /** Unsigned hex of an INTEGER (leading sign octets removed). */
  integerHex() {
    this.#expect(TAG.INTEGER, TAG.ENUMERATED);
    let content = this.content;
    while (content.length > 1 && content[0] === 0) content = content.subarray(1);
    return toHex(content);
  }

  integerBytes() {
    this.#expect(TAG.INTEGER, TAG.ENUMERATED);
    return this.content;
  }

  /** True when the INTEGER is negative (two's complement). */
  integerIsNegative() {
    const content = this.content;
    return content.length > 0 && (content[0] & 0x80) !== 0;
  }

  integerBigInt() {
    this.#expect(TAG.INTEGER, TAG.ENUMERATED);
    const content = this.content;
    const unsigned = bytesToBigInt(content);
    return this.integerIsNegative() ? unsigned - (1n << BigInt(content.length * 8)) : unsigned;
  }

  integerNumber() {
    const value = this.integerBigInt();
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw asn1Error("integer-too-large", this.start, "INTEGER too large");
    return Number(value);
  }

  boolean() {
    this.#expect(TAG.BOOLEAN);
    return this.content.length > 0 && this.content[0] !== 0;
  }

  /** OCTET STRING content (chunks joined). */
  octets() {
    this.#expect(TAG.OCTET_STRING);
    return this.content;
  }

  /** BIT STRING -> { unusedBits, bytes }. Constructed bit strings are not supported (never seen in PKI data). */
  bitString() {
    this.#expect(TAG.BIT_STRING);
    if (this.constructed) throw asn1Error("unsupported", this.start, "Constructed BIT STRING is not supported");
    const content = this.content;
    if (content.length === 0) return { unusedBits: 0, bytes: new Uint8Array(0) };
    return { unusedBits: content[0], bytes: content.subarray(1) };
  }

  /** Any ASN.1 string type decoded to a JS string. */
  string() {
    return decodeString(this);
  }

  stringType() {
    return this.tagClass === CLASS.UNIVERSAL ? STRING_TYPE_NAMES[this.tag] || null : null;
  }

  /** UTCTime / GeneralizedTime -> Date (an invalid Date when the text cannot be parsed). */
  time() {
    return decodeTime(this);
  }

  #expect(...tags) {
    if (this.tagClass !== CLASS.UNIVERSAL || !tags.includes(this.tag)) {
      throw asn1Error("unexpected-type", this.start, `Unexpected ASN.1 type (class ${this.tagClass}, tag ${this.tag}), expected tag ${tags.join(" or ")}`);
    }
  }
}

/**
 * Parses ONE value at `options.offset`. Bytes after it are ignored (see node.end): PDF /Contents is zero padded.
 * options: strict (reject indefinite lengths and non-minimal length octets = DER), maxDepth, maxNodes, limit.
 */
export function decode(buf, options = {}) {
  if (!(buf instanceof Uint8Array)) throw asn1Error("not-bytes", null, "decode() needs a Uint8Array");
  const state = {
    strict: Boolean(options.strict),
    maxDepth: options.maxDepth || DEFAULT_LIMITS.maxDepth,
    maxNodes: options.maxNodes || DEFAULT_LIMITS.maxNodes,
    nodes: 0
  };
  const limit = options.limit == null ? buf.length : options.limit;
  return parseNode(buf, options.offset || 0, limit, 0, state);
}

/** decode() that also requires the value to span the whole buffer. */
export function decodeExact(buf, options = {}) {
  const node = decode(buf, options);
  if (node.end !== buf.length) throw asn1Error("trailing-bytes", node.end, `Trailing bytes after the ASN.1 value (${buf.length - node.end})`);
  return node;
}

/**
 * Total length of the BER / DER value that starts at `offset`, or -1 when the bytes are not a complete,
 * well-formed value. This is how PDF /Contents has to be cut: NOT by stripping zero bytes (an
 * indefinite-length value legitimately ends with 00 00).
 */
export function berLength(buf, offset = 0) {
  try {
    return decode(buf, { offset }).end - offset;
  } catch {
    return -1;
  }
}

function parseNode(buf, offset, limit, depth, state) {
  if (depth > state.maxDepth) throw asn1Error("too-deep", offset, "ASN.1 nesting too deep");
  if (++state.nodes > state.maxNodes) throw asn1Error("too-large", offset, "ASN.1 structure too large");
  if (offset + 2 > limit) throw asn1Error("truncated", offset, "Truncated ASN.1 header");
  const node = new Asn1Node(buf);
  node.start = offset;
  const first = buf[offset];
  node.tagClass = first >> 6;
  node.constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  let p = offset + 1;
  if (tag === 0x1f) {
    tag = 0;
    let octet;
    let count = 0;
    do {
      if (p >= limit) throw asn1Error("truncated", offset, "Truncated high tag number");
      if (++count > 4) throw asn1Error("tag-too-large", offset, "Tag number too large");
      octet = buf[p++];
      tag = tag * 128 + (octet & 0x7f);
    } while (octet & 0x80);
  }
  node.tag = tag;
  if (p >= limit) throw asn1Error("truncated", offset, "Truncated ASN.1 length");
  const lengthOctet = buf[p++];
  let length = 0;
  if (lengthOctet < 0x80) {
    length = lengthOctet;
  } else if (lengthOctet === 0x80) {
    if (!node.constructed) throw asn1Error("indefinite-primitive", offset, "Indefinite length on a primitive value");
    if (state.strict) throw asn1Error("not-der", offset, "Indefinite length is not DER");
    node.indefinite = true;
  } else {
    const count = lengthOctet & 0x7f;
    if (count > 6) throw asn1Error("length-too-large", offset, "ASN.1 length too large");
    if (p + count > limit) throw asn1Error("truncated", offset, "Truncated ASN.1 length");
    for (let i = 0; i < count; i++) length = length * 256 + buf[p++];
    if (state.strict && (length < 0x80 || buf[p - count] === 0)) throw asn1Error("not-der", offset, "Non-minimal length octets are not DER");
  }
  node.contentStart = p;
  if (node.indefinite) {
    node.children = [];
    let q = p;
    for (;;) {
      if (q + 2 > limit) throw asn1Error("truncated", offset, "Missing end-of-contents octets");
      if (buf[q] === 0 && buf[q + 1] === 0) break;
      const child = parseNode(buf, q, limit, depth + 1, state);
      node.children.push(child);
      q = child.end;
    }
    node.contentEnd = q;
    node.end = q + 2;
  } else {
    node.contentEnd = p + length;
    node.end = node.contentEnd;
    if (node.end > limit) throw asn1Error("truncated", offset, `ASN.1 value runs past the end of the data (${node.end} > ${limit})`);
    if (node.constructed) {
      node.children = [];
      let q = p;
      while (q < node.contentEnd) {
        const child = parseNode(buf, q, node.contentEnd, depth + 1, state);
        node.children.push(child);
        q = child.end;
      }
    }
  }
  return node;
}

// ------------------------------------------------------------------------------------------------
// value decoding

export function oidFromBytes(bytes) {
  if (!bytes.length) return "";
  const arcs = [];
  let value = 0n;
  let started = false;
  for (let i = 0; i < bytes.length; i++) {
    const octet = bytes[i];
    value = (value << 7n) | BigInt(octet & 0x7f);
    if (!(octet & 0x80)) {
      if (!started) {
        const first = value < 40n ? 0n : value < 80n ? 1n : 2n;
        arcs.push(String(first), String(value - first * 40n));
        started = true;
      } else {
        arcs.push(String(value));
      }
      value = 0n;
    }
  }
  return arcs.join(".");
}

export function oidToBytes(dotted) {
  const parts = String(dotted).split(".");
  if (parts.length < 2 || parts.some((part) => !/^\d+$/.test(part))) throw asn1Error("bad-oid", null, `Invalid OID "${dotted}"`);
  const arcs = parts.map((part) => BigInt(part));
  const values = [arcs[0] * 40n + arcs[1], ...arcs.slice(2)];
  const out = [];
  for (let value of values) {
    const chunk = [Number(value & 0x7fn)];
    value >>= 7n;
    while (value > 0n) {
      chunk.unshift(Number(value & 0x7fn) | 0x80);
      value >>= 7n;
    }
    out.push(...chunk);
  }
  return Uint8Array.from(out);
}

/**
 * ASN.1 string -> JS string.
 *  UTF8String: UTF-8. BMPString: UTF-16BE. UniversalString: UTF-32BE.
 *  TeletexString / PrintableString / IA5String / VisibleString / ...: 7 / 8-bit types, but real certificates
 *  (also Vietnamese ones) sometimes put UTF-8 bytes into them. So: when the content has bytes >= 0x80 and is
 *  valid UTF-8 it is read as UTF-8, otherwise as Latin-1 (what OpenSSL shows for T61).
 */
export function decodeString(node) {
  const bytes = node.content;
  const tag = node.tagClass === CLASS.UNIVERSAL ? node.tag : -1;
  if (tag === TAG.UTF8String) return utf8Decode(bytes);
  if (tag === TAG.BMPString) return utf16beDecode(bytes);
  if (tag === TAG.UniversalString) {
    let out = "";
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      const codePoint = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      out += codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER;
    }
    return out;
  }
  let high = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) {
      high = true;
      break;
    }
  }
  if (high) {
    const asUtf8 = utf8Decode(bytes, true);
    if (asUtf8 !== null) return asUtf8;
  }
  return latin1Decode(bytes);
}

export function decodeTime(node) {
  const text = latin1Decode(node.content);
  let match;
  if (node.tag === TAG.UTCTime && (match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})?$/.exec(text))) {
    const year = Number(match[1]) < 50 ? 2000 + Number(match[1]) : 1900 + Number(match[1]);
    return buildDate(year, match[2], match[3], match[4], match[5], match[6] || "00", "", match[7]);
  }
  if ((match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?([.,]\d+)?(Z|[+-]\d{4})?$/.exec(text))) {
    return buildDate(Number(match[1]), match[2], match[3], match[4], match[5] || "00", match[6] || "00", match[7] || "", match[8]);
  }
  return new Date(NaN);
}

function buildDate(year, month, day, hour, minute, second, fraction, zone) {
  const ms = fraction ? Math.round(Number(`0.${fraction.slice(1)}`) * 1000) : 0;
  let time = Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), ms);
  if (zone && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    time -= sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60000;
  }
  return new Date(time);
}

// ------------------------------------------------------------------------------------------------
// DER writer

export function encodeLength(length) {
  if (!Number.isInteger(length) || length < 0) throw asn1Error("bad-length", null, "DER length must be a non-negative integer");
  if (length < 0x80) return Uint8Array.of(length);
  const octets = [];
  let n = length;
  while (n > 0) {
    octets.unshift(n % 256);
    n = Math.floor(n / 256);
  }
  return Uint8Array.of(0x80 | octets.length, ...octets);
}

/** One TLV. `identifier` is the full first octet (0x30 SEQUENCE, 0xA0 [0] constructed, ...). */
export function tlv(identifier, ...content) {
  const body = concatBytes(content);
  return concatBytes(Uint8Array.of(identifier), encodeLength(body.length), body);
}

/** Encoded elements in DER SET OF order (sorted as octet strings). */
export const sortSetOf = (items) => items.flat(Infinity).filter(Boolean).sort(compareBytes);

function minimalInteger(bytes) {
  // unsigned big-endian magnitude -> DER INTEGER content (positive)
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  if (trimmed.length === 0) return Uint8Array.of(0);
  return trimmed[0] & 0x80 ? concatBytes(Uint8Array.of(0), trimmed) : trimmed;
}

const twoDigits = (n) => String(n).padStart(2, "0");

export const der = {
  seq: (...items) => tlv(0x30, items),
  /** SET with the elements in the given order (correct for a SET with one element). */
  set: (...items) => tlv(0x31, items),
  /** SET OF: elements sorted by their encodings, as DER requires. */
  setOf: (...items) => tlv(0x31, sortSetOf(items)),
  oid: (dotted) => tlv(0x06, oidToBytes(dotted)),
  /** INTEGER from a non-negative Number / BigInt. */
  int: (value) => {
    const big = BigInt(value);
    if (big < 0n) throw asn1Error("negative-integer", null, "Negative INTEGER not supported by the writer");
    let hex = big.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return tlv(0x02, minimalInteger(bytes));
  },
  /** INTEGER from an unsigned big-endian magnitude (adds the 00 sign octet when needed). */
  intFromBytes: (bytes) => tlv(0x02, minimalInteger(bytes)),
  bool: (value) => tlv(0x01, Uint8Array.of(value ? 0xff : 0x00)),
  nul: () => Uint8Array.of(0x05, 0x00),
  octets: (bytes) => tlv(0x04, bytes),
  bitString: (bytes, unusedBits = 0) => tlv(0x03, Uint8Array.of(unusedBits), bytes),
  utf8: (text) => tlv(0x0c, utf8Encode(text)),
  printable: (text) => tlv(0x13, utf8Encode(text)),
  ia5: (text) => tlv(0x16, utf8Encode(text)),
  bmp: (text) => tlv(0x1e, utf16beEncode(text)),
  utcTime: (date) => tlv(0x17, utf8Encode(
    `${twoDigits(date.getUTCFullYear() % 100)}${twoDigits(date.getUTCMonth() + 1)}${twoDigits(date.getUTCDate())}`
    + `${twoDigits(date.getUTCHours())}${twoDigits(date.getUTCMinutes())}${twoDigits(date.getUTCSeconds())}Z`
  )),
  generalizedTime: (date) => tlv(0x18, utf8Encode(
    `${String(date.getUTCFullYear()).padStart(4, "0")}${twoDigits(date.getUTCMonth() + 1)}${twoDigits(date.getUTCDate())}`
    + `${twoDigits(date.getUTCHours())}${twoDigits(date.getUTCMinutes())}${twoDigits(date.getUTCSeconds())}Z`
  )),
  /** X.509 / CMS Time: UTCTime for 1950..2049, GeneralizedTime otherwise (RFC 5280 4.1.2.5, RFC 5652 11.3). */
  time: (date) => {
    const year = date.getUTCFullYear();
    return year >= 1950 && year <= 2049 ? der.utcTime(date) : der.generalizedTime(date);
  },
  /** [n] constructed context tag around already encoded content (EXPLICIT, or IMPLICIT for SEQUENCE / SET). */
  ctx: (tag, ...content) => tlv(0xa0 | tag, content),
  /** [n] IMPLICIT primitive context tag. */
  ctxPrimitive: (tag, bytes) => tlv(0x80 | tag, bytes)
};

/**
 * Re-encodes a parsed value as DER: definite lengths, chunked strings joined, SET OF sorted when `sortSets`.
 * Used as a fallback to rebuild the signed-attributes SET of a BER-encoded CMS.
 */
export function toDer(node, { sortSets = true } = {}) {
  const identifierLength = node.contentStart - node.start - lengthOctetCount(node);
  let identifier = node.buf.subarray(node.start, node.start + identifierLength);
  if (!node.constructed) return concatBytes(identifier, encodeLength(node.length), node.buf.subarray(node.contentStart, node.contentEnd));
  const isString = node.tagClass === CLASS.UNIVERSAL && (node.tag === TAG.OCTET_STRING || STRING_TYPE_NAMES[node.tag]);
  if (isString) {
    const joined = node.content;
    identifier = Uint8Array.of(identifier[0] & ~0x20, ...identifier.subarray(1));
    return concatBytes(identifier, encodeLength(joined.length), joined);
  }
  let parts = node.children.map((child) => toDer(child, { sortSets }));
  if (sortSets && node.isUniversal(TAG.SET)) parts = parts.sort(compareBytes);
  const body = concatBytes(parts);
  return concatBytes(identifier, encodeLength(body.length), body);
}

function lengthOctetCount(node) {
  // number of length octets in the source encoding
  let p = node.start + 1;
  if ((node.buf[node.start] & 0x1f) === 0x1f) {
    while (node.buf[p] & 0x80) p++;
    p++;
  }
  return node.contentStart - p;
}

/** True when any value of the tree uses an indefinite length (the container is BER, not DER). */
export function hasIndefiniteLength(node) {
  if (node.indefinite) return true;
  return Boolean(node.children) && node.children.some(hasIndefiniteLength);
}
