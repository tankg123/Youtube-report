// A content-stream tokenizer with byte offsets. Library independent (plain Uint8Array in, plain data out):
// usable for graphics-state analysis, for resource usage, for text surgery (splice byte ranges) and in a
// Web Worker.
//
// Covered syntax (ISO 32000-1 7.2, 7.3, 7.8.2, 8.9.7): numbers, names with #xx, literal strings (nested
// parentheses, every escape, octal, line continuation), hex strings, arrays, dictionaries (BDC property
// lists), comments, inline images BI ... ID <data> EI (length from /L, from the image geometry when the data
// is not filtered, from the filter's end marker for ASCIIHex / ASCII85, else a guarded search for EI).

const WS = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) WS[code] = 1;
const DELIM = new Uint8Array(256);
for (const char of "()<>[]{}/%") DELIM[char.charCodeAt(0)] = 1;
const isRegular = (code) => !WS[code] && !DELIM[code];

const latin1 = (bytes, start, end) => {
  let text = "";
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
};

/** Abbreviations of inline image dictionaries (ISO 32000-1 Tables 93 and 94). */
const INLINE_KEYS = { BPC: "BitsPerComponent", CS: "ColorSpace", D: "Decode", DP: "DecodeParms", F: "Filter", H: "Height", IM: "ImageMask", I: "Interpolate", W: "Width", L: "Length" };
const INLINE_FILTERS = { AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode", Fl: "FlateDecode", RL: "RunLengthDecode", CCF: "CCITTFaxDecode", DCT: "DCTDecode" };
const INLINE_COMPONENTS = { G: 1, DeviceGray: 1, RGB: 3, DeviceRGB: 3, CMYK: 4, DeviceCMYK: 4, I: 1, Indexed: 1 };

/**
 * @typedef {{ type: "number", value: number, start: number, end: number }
 *   | { type: "name", value: string, start: number, end: number }
 *   | { type: "string", bytes: Uint8Array, hex: boolean, start: number, end: number }
 *   | { type: "array", items: Token[], start: number, end: number }
 *   | { type: "dict", entries: Array<[string, Token]>, start: number, end: number }
 *   | { type: "bool", value: boolean, start: number, end: number }
 *   | { type: "null", start: number, end: number }} Token
 *
 * @typedef {{ op: string, operands: Token[], start: number, opStart: number, end: number,
 *             inline?: { dict: Record<string, Token>, dataStart: number, dataEnd: number, lengthFrom: string } }} Operation
 *   start = offset of the first operand (or of the operator when there is none); end = offset after the operator
 */

/**
 * @param {Uint8Array} bytes  decoded content stream (all streams of a page joined)
 * @param {{ tolerant?: boolean }} [options]  tolerant (default): unexpected bytes are skipped and reported
 * @returns {{ operations: Operation[], problems: string[] }}
 */
export function tokenizeContent(bytes, { tolerant = true } = {}) {
  const n = bytes.length;
  let pos = 0;
  const problems = [];
  const fail = (message) => {
    if (!tolerant) throw new Error(`content stream: ${message} at byte ${pos}`);
    if (problems.length < 20) problems.push(`${message} at byte ${pos}`);
  };

  const skipSpace = () => {
    for (;;) {
      while (pos < n && WS[bytes[pos]]) pos += 1;
      if (pos < n && bytes[pos] === 0x25) { // % comment up to end of line
        while (pos < n && bytes[pos] !== 10 && bytes[pos] !== 13) pos += 1;
      } else return;
    }
  };

  const readLiteralString = () => {
    const start = pos;
    pos += 1; // (
    const out = [];
    let depth = 1;
    while (pos < n) {
      let code = bytes[pos];
      pos += 1;
      if (code === 0x5c) { // backslash
        if (pos >= n) break;
        code = bytes[pos];
        pos += 1;
        switch (code) {
          case 0x6e: out.push(10); break;
          case 0x72: out.push(13); break;
          case 0x74: out.push(9); break;
          case 0x62: out.push(8); break;
          case 0x66: out.push(12); break;
          case 13: if (bytes[pos] === 10) pos += 1; break; // line continuation
          case 10: break;
          default:
            if (code >= 0x30 && code <= 0x37) {
              let value = code - 0x30;
              for (let digit = 0; digit < 2 && pos < n && bytes[pos] >= 0x30 && bytes[pos] <= 0x37; digit += 1) {
                value = value * 8 + (bytes[pos] - 0x30);
                pos += 1;
              }
              out.push(value & 0xff);
            } else out.push(code); // \( \) \\ and any other character stands for itself
        }
      } else if (code === 0x28) {
        depth += 1;
        out.push(code);
      } else if (code === 0x29) {
        depth -= 1;
        if (depth === 0) return { type: "string", bytes: Uint8Array.from(out), hex: false, start, end: pos };
        out.push(code);
      } else if (code === 13) { // an end-of-line inside a string is read as one LF
        if (bytes[pos] === 10) pos += 1;
        out.push(10);
      } else out.push(code);
    }
    fail("unterminated literal string");
    return { type: "string", bytes: Uint8Array.from(out), hex: false, start, end: pos };
  };

  const hexValue = (code) => (code >= 0x30 && code <= 0x39 ? code - 0x30 : code >= 0x41 && code <= 0x46 ? code - 55 : code >= 0x61 && code <= 0x66 ? code - 87 : -1);

  const readHexString = () => {
    const start = pos;
    pos += 1; // <
    const out = [];
    let high = -1;
    while (pos < n && bytes[pos] !== 0x3e) {
      const value = hexValue(bytes[pos]);
      pos += 1;
      if (value < 0) continue; // white space (and, tolerantly, anything else)
      if (high < 0) high = value;
      else {
        out.push((high << 4) | value);
        high = -1;
      }
    }
    if (high >= 0) out.push(high << 4);
    if (pos < n) pos += 1; // >
    else fail("unterminated hex string");
    return { type: "string", bytes: Uint8Array.from(out), hex: true, start, end: pos };
  };

  const readName = () => {
    const start = pos;
    pos += 1; // /
    let value = "";
    while (pos < n && isRegular(bytes[pos])) {
      if (bytes[pos] === 0x23 && pos + 2 < n && hexValue(bytes[pos + 1]) >= 0 && hexValue(bytes[pos + 2]) >= 0) {
        value += String.fromCharCode((hexValue(bytes[pos + 1]) << 4) | hexValue(bytes[pos + 2]));
        pos += 3;
      } else {
        value += String.fromCharCode(bytes[pos]);
        pos += 1;
      }
    }
    return { type: "name", value, start, end: pos };
  };

  /** number, or keyword (returned as { type: "keyword", value }) */
  const readRegular = () => {
    const start = pos;
    while (pos < n && isRegular(bytes[pos])) pos += 1;
    if (pos === start) { // a stray delimiter such as ")" or "}"
      fail(`unexpected character ${JSON.stringify(String.fromCharCode(bytes[pos]))}`);
      pos += 1;
      return null;
    }
    const text = latin1(bytes, start, pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return { type: "number", value: Number(text), start, end: pos };
    if (/^-{2,}(\d+\.?\d*|\.\d+)$/.test(text)) {
      // "--5": written by a few broken producers; Acrobat and pdf.js read it as -5
      return { type: "number", value: -Number(text.replace(/^-+/, "")), start, end: pos };
    }
    if (text === "true" || text === "false") return { type: "bool", value: text === "true", start, end: pos };
    if (text === "null") return { type: "null", start, end: pos };
    return { type: "keyword", value: text, start, end: pos };
  };

  const readObject = (depth = 0) => {
    skipSpace();
    if (pos >= n) return null;
    const code = bytes[pos];
    if (code === 0x28) return readLiteralString();
    if (code === 0x2f) return readName();
    if (code === 0x5b) { // [
      const start = pos;
      pos += 1;
      const items = [];
      for (;;) {
        skipSpace();
        if (pos >= n) {
          fail("unterminated array");
          break;
        }
        if (bytes[pos] === 0x5d) {
          pos += 1;
          break;
        }
        const item = depth < 64 ? readObject(depth + 1) : null;
        if (item === null) {
          if (pos >= n) break;
          continue;
        }
        if (item.type === "keyword") {
          fail(`operator ${item.value} inside an array`);
          continue;
        }
        items.push(item);
      }
      return { type: "array", items, start, end: pos };
    }
    if (code === 0x3c) {
      if (bytes[pos + 1] === 0x3c) { // <<
        const start = pos;
        pos += 2;
        const entries = [];
        for (;;) {
          skipSpace();
          if (pos >= n) {
            fail("unterminated dictionary");
            break;
          }
          if (bytes[pos] === 0x3e && bytes[pos + 1] === 0x3e) {
            pos += 2;
            break;
          }
          const key = depth < 64 ? readObject(depth + 1) : null;
          if (!key) {
            if (pos >= n) break;
            continue;
          }
          if (key.type !== "name") {
            fail("dictionary key is not a name");
            continue;
          }
          const value = readObject(depth + 1);
          if (!value) break;
          entries.push([key.value, value]);
        }
        return { type: "dict", entries, start, end: pos };
      }
      return readHexString();
    }
    if (code === 0x3e || code === 0x5d || code === 0x29 || code === 0x7b || code === 0x7d) {
      fail(`unexpected ${JSON.stringify(String.fromCharCode(code))}`);
      pos += 1;
      return null;
    }
    return readRegular();
  };

  const inlineImage = (opStart, operandStart) => {
    // key value pairs up to ID
    const dict = {};
    for (;;) {
      skipSpace();
      if (pos >= n) {
        fail("inline image without ID");
        return null;
      }
      const key = readObject();
      if (!key) continue;
      if (key.type === "keyword" && key.value === "ID") break;
      if (key.type !== "name") {
        fail("inline image key is not a name");
        continue;
      }
      const value = readObject();
      if (!value) break;
      dict[INLINE_KEYS[key.value] || key.value] = value;
    }
    // exactly one white-space byte follows ID (CR LF counts as one end-of-line)
    if (pos < n && bytes[pos] === 13 && bytes[pos + 1] === 10) pos += 2;
    else if (pos < n && WS[bytes[pos]]) pos += 1;
    const dataStart = pos;
    let dataEnd = -1;
    let lengthFrom = "";

    const filterToken = dict.Filter;
    const filters = !filterToken ? [] : filterToken.type === "array" ? filterToken.items.map((token) => token.value) : [filterToken.value];
    const firstFilter = filters.length ? (INLINE_FILTERS[filters[0]] || filters[0]) : null;
    const num = (key) => (dict[key] && dict[key].type === "number" ? dict[key].value : undefined);

    const followedByEI = (at) => {
      let p = at;
      while (p < n && WS[bytes[p]]) p += 1;
      return bytes[p] === 0x45 && bytes[p + 1] === 0x49 && (p + 2 >= n || !isRegular(bytes[p + 2])) ? p : -1;
    };

    if (num("Length") !== undefined) { // PDF 2.0
      const p = followedByEI(dataStart + num("Length"));
      if (p >= 0) {
        dataEnd = dataStart + num("Length");
        lengthFrom = "/L";
        pos = p + 2;
      }
    }
    if (dataEnd < 0 && !firstFilter) {
      const mask = dict.ImageMask && dict.ImageMask.type === "bool" && dict.ImageMask.value;
      const cs = dict.ColorSpace;
      const comps = mask ? 1 : cs && cs.type === "name" ? INLINE_COMPONENTS[cs.value] : cs && cs.type === "array" && cs.items[0] && (cs.items[0].value === "I" || cs.items[0].value === "Indexed") ? 1 : undefined;
      const bpc = mask ? 1 : num("BitsPerComponent");
      if (comps && bpc && num("Width") && num("Height")) {
        const length = Math.ceil((num("Width") * comps * bpc) / 8) * num("Height");
        const p = followedByEI(dataStart + length);
        if (p >= 0) {
          dataEnd = dataStart + length;
          lengthFrom = "geometry";
          pos = p + 2;
        }
      }
    }
    if (dataEnd < 0 && (firstFilter === "ASCIIHexDecode" || firstFilter === "ASCII85Decode")) {
      let p = dataStart;
      if (firstFilter === "ASCIIHexDecode") {
        while (p < n && bytes[p] !== 0x3e) p += 1;
        p += 1;
      } else {
        while (p + 1 < n && !(bytes[p] === 0x7e && bytes[p + 1] === 0x3e)) p += 1;
        p += 2;
      }
      const q = followedByEI(p);
      if (q >= 0) {
        dataEnd = p;
        lengthFrom = "filter end marker";
        pos = q + 2;
      }
    }
    if (dataEnd < 0) {
      // Binary data of unknown length: the first "EI" that stands between white space and is followed by
      // something that looks like content (not by more binary data).
      for (let p = dataStart; p + 1 < n; p += 1) {
        if (bytes[p] !== 0x45 || bytes[p + 1] !== 0x49) continue;
        if (p > dataStart && !WS[bytes[p - 1]]) continue;
        if (p + 2 < n && isRegular(bytes[p + 2])) continue;
        let plausible = true;
        for (let k = p + 2; k < Math.min(n, p + 22); k += 1) {
          const code = bytes[k];
          if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127))) {
            plausible = false;
            break;
          }
        }
        if (!plausible) continue;
        dataEnd = p > dataStart && WS[bytes[p - 1]] ? p - 1 : p;
        lengthFrom = "search for EI";
        pos = p + 2;
        break;
      }
    }
    if (dataEnd < 0) {
      fail("inline image without EI");
      dataEnd = n;
      pos = n;
      lengthFrom = "end of stream";
    }
    return { op: "BI", operands: [], start: operandStart, opStart, end: pos, inline: { dict, dataStart, dataEnd, lengthFrom } };
  };

  const operations = [];
  let operands = [];
  for (;;) {
    skipSpace();
    if (pos >= n) break;
    const token = readObject();
    if (!token) continue;
    if (token.type !== "keyword") {
      operands.push(token);
      continue;
    }
    const start = operands.length ? operands[0].start : token.start;
    if (token.value === "BI") {
      const operation = inlineImage(token.start, start);
      if (operation) operations.push(operation);
    } else {
      operations.push({ op: token.value, operands, start, opStart: token.start, end: token.end });
    }
    operands = [];
  }
  if (operands.length) problems.push(`${operands.length} operand(s) without an operator at the end of the stream`);
  return { operations, problems };
}

/**
 * What the content leaves behind: how many q are unbalanced, how far Q underflows, whether a text object,
 * marked-content sequences or a compatibility section are still open at the end.
 * @param {Operation[]} operations
 */
export function analyseBalance(operations) {
  let depth = 0;
  let minDepth = 0;
  let inText = false;
  let marked = 0;
  let compat = 0;
  let ctmChangesAtTopLevel = 0;
  for (const { op } of operations) {
    if (op === "q") depth += 1;
    else if (op === "Q") {
      depth -= 1;
      if (depth < minDepth) minDepth = depth;
    } else if (op === "BT") inText = true;
    else if (op === "ET") inText = false;
    else if (op === "BMC" || op === "BDC") marked += 1;
    else if (op === "EMC") {
      if (marked > 0) marked -= 1;
    } else if (op === "BX") compat += 1;
    else if (op === "EX") {
      if (compat > 0) compat -= 1;
    } else if (op === "cm" && depth <= 0) ctmChangesAtTopLevel += 1;
  }
  return {
    endDepth: depth, // > 0: q without Q
    underflow: minDepth < 0 ? -minDepth : 0, // > 0: Q without q
    inText,
    openMarkedContent: marked,
    openCompatibility: compat,
    ctmChangesAtTopLevel,
    balanced: depth === 0 && minDepth === 0 && !inText && marked === 0 && compat === 0,
    clean: depth === 0 && minDepth === 0 && !inText && marked === 0 && compat === 0 && ctmChangesAtTopLevel === 0
  };
}

/** Serialises one token back to content-stream syntax (for rewriting operands). */
export function serializeToken(token) {
  switch (token.type) {
    case "number": {
      if (Number.isInteger(token.value)) return String(token.value);
      const text = token.value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
      return text === "-0" ? "0" : text;
    }
    case "name": {
      let out = "/";
      for (const char of token.value) {
        const code = char.charCodeAt(0);
        out += code < 33 || code > 126 || DELIM[code] || code === 0x23 ? `#${code.toString(16).toUpperCase().padStart(2, "0")}` : char;
      }
      return out;
    }
    case "string": {
      let hex = "<";
      for (const byte of token.bytes) hex += byte.toString(16).toUpperCase().padStart(2, "0");
      return `${hex}>`;
    }
    case "array": return `[${token.items.map(serializeToken).join(" ")}]`;
    case "dict": return `<<${token.entries.map(([key, value]) => `${serializeToken({ type: "name", value: key })} ${serializeToken(value)}`).join(" ")}>>`;
    case "bool": return token.value ? "true" : "false";
    case "null": return "null";
    default: throw new Error(`cannot serialise token type ${token.type}`);
  }
}
