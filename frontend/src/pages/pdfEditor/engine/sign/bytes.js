// Uint8Array helpers shared by the signing modules: hex, base64, PEM, text encodings, comparison, wiping.
// Browser + Node (no Buffer, no dependency). Nothing here knows about PDF or ASN.1.

const HEX = "0123456789abcdef";

/** Lower-case hex of a byte array. */
export function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}

/** Hex (white space allowed, an odd length is padded with a trailing 0 like a PDF hex string) -> bytes. */
export function fromHex(text) {
  const clean = text.replace(/[^0-9a-fA-F]/g, "");
  const even = clean.length % 2 ? `${clean}0` : clean;
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Joins byte arrays; nested arrays are flattened and null / undefined parts are skipped. */
export function concatBytes(...parts) {
  const flat = parts.flat(Infinity).filter((part) => part != null);
  let total = 0;
  for (const part of flat) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of flat) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Equality without an early exit (the same time for equal and unequal MACs). */
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Lexicographic comparison of two byte strings (the DER SET OF ordering rule, X.690 11.6). */
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

const utf8Encoder = new TextEncoder();
export const utf8Encode = (text) => utf8Encoder.encode(text);

/** UTF-8 decode; with `strict` it returns null instead of replacement characters for bytes that are not UTF-8. */
export function utf8Decode(bytes, strict = false) {
  if (!strict) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function latin1Decode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return out;
}

/** Latin-1 text -> bytes; throws RangeError for a character above U+00FF (generated PDF syntax must be 8-bit). */
export function latin1Encode(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new RangeError("latin1Encode: character above U+00FF");
    out[i] = code;
  }
  return out;
}

/** "Binary string" (one char per byte, the currency of node-forge) <-> bytes. */
export const bytesToBinaryString = latin1Decode;
export function binaryStringToBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-16BE without a byte order mark (BMPString, PKCS#12 passwords). Lone surrogates are kept as they are. */
export function utf16beEncode(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = code >> 8;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

export function utf16beDecode(bytes) {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return out;
}

export function utf16leDecode(bytes) {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i + 1] << 8) | bytes[i]);
  return out;
}

export function toBase64(bytes) {
  return btoa(latin1Decode(bytes));
}

export function fromBase64(text) {
  return binaryStringToBytes(atob(text.replace(/\s+/g, "")));
}

/** DER -> PEM text with the given label ("CERTIFICATE", ...). */
export function toPem(der, label) {
  const lines = toBase64(der).match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** All PEM blocks of a text: [{ label, der }]. */
export function fromPem(text) {
  const blocks = [];
  const pattern = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  let match;
  while ((match = pattern.exec(text))) {
    try {
      blocks.push({ label: match[1], der: fromBase64(match[2]) });
    } catch {
      /* a block that is not base64 is not a PEM block */
    }
  }
  return blocks;
}

/** Uint8Array, ArrayBuffer or any typed-array view -> a Uint8Array VIEW (no copy); anything else -> null. */
export function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/** Overwrites key material held in a typed array (JS strings cannot be wiped: keep secrets in bytes). */
export function wipe(bytes) {
  if (bytes && typeof bytes.fill === "function") bytes.fill(0);
}

/** Unsigned big-endian bytes -> BigInt. */
export function bytesToBigInt(bytes) {
  const hex = toHex(bytes);
  return BigInt(`0x${hex || "0"}`);
}

/** Number of significant bits of an unsigned big-endian integer. */
export function bitLength(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i === bytes.length) return 0;
  return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i]));
}

/** An unsigned big-endian integer without its leading zero octets (at least one octet stays). */
export function stripLeadingZeros(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.subarray(i);
}

/** Random bytes from the platform generator (getRandomValues is limited to 65536 bytes per call). */
export function randomBytes(length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(length, i + 65536)));
  return out;
}
