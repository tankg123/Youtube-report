// A small /ToUnicode CMap reader (bfchar and bfrange, both forms), enough to map the character codes of a
// content stream to text. Library independent.

const hexToBytes = (hex) => {
  const clean = hex.replace(/\s+/g, "");
  const out = [];
  for (let index = 0; index + 1 < clean.length; index += 2) out.push(parseInt(clean.slice(index, index + 2), 16));
  return out;
};
const utf16be = (bytes) => {
  let text = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
  return text;
};
const codeOf = (bytes) => bytes.reduce((value, byte) => value * 256 + byte, 0);

/**
 * @param {Uint8Array} bytes decoded CMap stream
 * @returns {{ map: Map<number, string>, codeLengths: number[], decode: (codes: Uint8Array) => string }}
 */
export function parseToUnicode(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  const map = new Map();
  const lengths = new Set();
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)) lengths.add(hexToBytes(pair[1]).length);
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g)) {
      const code = hexToBytes(pair[1]);
      lengths.add(code.length);
      map.set(codeOf(code), utf16be(hexToBytes(pair[2])));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const entry of block[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(?:<([0-9A-Fa-f\s]*)>|\[([^\]]*)\])/g)) {
      const low = codeOf(hexToBytes(entry[1]));
      const high = codeOf(hexToBytes(entry[2]));
      lengths.add(hexToBytes(entry[1]).length);
      if (entry[4] !== undefined) {
        const targets = [...entry[4].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((target) => utf16be(hexToBytes(target[1])));
        for (let code = low; code <= high && code - low < targets.length; code += 1) map.set(code, targets[code - low]);
      } else {
        const start = hexToBytes(entry[3]);
        for (let code = low; code <= high && code - low < 65536; code += 1) {
          const target = start.slice();
          // the LAST byte pair is incremented
          let carry = code - low;
          for (let k = target.length - 1; k >= 0 && carry > 0; k -= 1) {
            const sum = target[k] + carry;
            target[k] = sum & 0xff;
            carry = sum >> 8;
          }
          map.set(code, utf16be(target));
        }
      }
    }
  }
  const codeLengths = [...lengths].sort((a, b) => a - b);
  const width = codeLengths.length ? codeLengths[codeLengths.length - 1] : 1;
  const decode = (codes) => {
    let out = "";
    for (let index = 0; index + width <= codes.length; index += width) {
      let code = 0;
      for (let k = 0; k < width; k += 1) code = code * 256 + codes[index + k];
      out += map.get(code) ?? "";
    }
    return out;
  };
  return { map, codeLengths, decode };
}
