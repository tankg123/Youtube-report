// ENCODERS for the stream filters a content stream may use, so that the decoder under test
// (engine/export/content.js decodeStreamBytes) gets real input.
import zlib from "node:zlib";

export const flate = (bytes) => new Uint8Array(zlib.deflateSync(Buffer.from(bytes)));

export function asciiHex(bytes) {
  let text = "";
  bytes.forEach((byte, index) => {
    text += byte.toString(16).padStart(2, "0") + (index % 32 === 31 ? "\n" : "");
  });
  return new Uint8Array(Buffer.from(`${text}>`, "latin1"));
}

export function ascii85(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 4) {
    const chunk = bytes.subarray(index, index + 4);
    let value = 0;
    for (let k = 0; k < 4; k += 1) value = value * 256 + (chunk[k] ?? 0);
    if (chunk.length === 4 && value === 0) {
      out += "z";
      continue;
    }
    const digits = [];
    for (let k = 0; k < 5; k += 1) {
      digits.unshift(String.fromCharCode((value % 85) + 33));
      value = Math.floor(value / 85);
    }
    out += digits.slice(0, chunk.length + 1).join("");
    if (out.length % 76 < 5) out += "\n";
  }
  return new Uint8Array(Buffer.from(`${out}~>`, "latin1"));
}

/** RunLengthDecode: literal runs and repeat runs, end-of-data 128. */
export function runLength(bytes) {
  const out = [];
  let index = 0;
  while (index < bytes.length) {
    let run = 1;
    while (index + run < bytes.length && bytes[index + run] === bytes[index] && run < 128) run += 1;
    if (run >= 3) {
      out.push(257 - run, bytes[index]);
      index += run;
    } else {
      const start = index;
      let count = 0;
      while (index < bytes.length && count < 128) {
        if (index + 2 < bytes.length && bytes[index] === bytes[index + 1] && bytes[index] === bytes[index + 2]) break;
        index += 1;
        count += 1;
      }
      out.push(count - 1, ...bytes.subarray(start, start + count));
    }
  }
  out.push(128);
  return Uint8Array.from(out);
}

/** LZWDecode as PDF / TIFF define it: MSB-first codes of 9..12 bits, clear 256, end 257. */
export function lzw(bytes, earlyChange = 1) {
  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = 9;
  const emit = (code) => {
    bitBuffer = (bitBuffer << codeSize) | code;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push((bitBuffer >>> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
    bitBuffer &= (1 << bitCount) - 1;
  };
  let table = new Map();
  let next = 258;
  emit(256);
  let current = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    const candidate = current + char;
    if (candidate.length === 1 || table.has(candidate)) {
      current = candidate;
      continue;
    }
    emit(current.length === 1 ? current.charCodeAt(0) : table.get(current));
    table.set(candidate, next);
    next += 1;
    if (next + earlyChange > (1 << codeSize) && codeSize < 12) codeSize += 1;
    if (next >= 4094) {
      emit(256);
      table = new Map();
      next = 258;
      codeSize = 9;
    }
    current = char;
  }
  if (current) emit(current.length === 1 ? current.charCodeAt(0) : table.get(current));
  emit(257);
  if (bitCount > 0) out.push((bitBuffer << (8 - bitCount)) & 0xff);
  return Uint8Array.from(out);
}

/** PNG predictor (the "Up" filter on every row) applied before Flate: /Predictor 12 /Columns n. */
export function pngUpPredict(bytes, columns) {
  const rows = Math.ceil(bytes.length / columns);
  const padded = new Uint8Array(rows * columns);
  padded.fill(0x20); // pad the last row with spaces: harmless at the end of a content stream
  padded.set(bytes);
  const out = new Uint8Array(rows * (columns + 1));
  for (let row = 0; row < rows; row += 1) {
    out[row * (columns + 1)] = 2;
    for (let column = 0; column < columns; column += 1) {
      const up = row > 0 ? padded[(row - 1) * columns + column] : 0;
      out[row * (columns + 1) + 1 + column] = (padded[row * columns + column] - up) & 0xff;
    }
  }
  return out;
}

/** TIFF predictor 2 (horizontal differencing, 8 bits, 1 colour). */
export function tiffPredict(bytes, columns) {
  const rows = Math.ceil(bytes.length / columns);
  const padded = new Uint8Array(rows * columns);
  padded.fill(0x20);
  padded.set(bytes);
  const out = new Uint8Array(padded.length);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = column > 0 ? padded[row * columns + column - 1] : 0;
      out[row * columns + column] = (padded[row * columns + column] - left) & 0xff;
    }
  }
  return out;
}
