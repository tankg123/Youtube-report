// Objects the parser of the library could not read (PDFInvalidObject: the bytes between "n g obj" and
// "endobj", kept as they are). A viewer reads many of them without trouble (a number written --5 or 1e3,
// "True", a stray keyword inside a dictionary ...), so they must travel into the export: byte for byte, with
// the references in them renumbered, because the output has other object numbers.
//
//   scanRawObject(data)   -> { refs, closed, streamAt }
//     refs      every "n g R" outside strings, comments and stream data: { start, end, number, generation }
//     closed    the object can be read without looking behind its last byte: every string, array and
//               dictionary is closed and every key has a value (and a stream ends with "endstream")
//     streamAt  where the keyword "stream" of a stream object starts, or -1
//   rewriteRawObject(data, map)   the same bytes with every reference replaced by map(number, generation)
//
// An object that is NOT closed means something else in every file it is copied into (a viewer goes on reading
// behind it until the brackets match): robust.js refuses a source that reaches one.
const isBlank = (byte) => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const isDigit = (byte) => byte >= 0x30 && byte <= 0x39;
const isDelimiter = (byte) => byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d
  || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;

const matches = (data, at, word) => {
  for (let index = 0; index < word.length; index += 1) if (data[at + index] !== word.charCodeAt(index)) return false;
  return true;
};

/**
 * @param {Uint8Array} data  the bytes of a PDFInvalidObject
 * @returns {{ refs: Array<{ start: number, end: number, number: number, generation: number }>, closed: boolean, streamAt: number }}
 */
export function scanRawObject(data) {
  const refs = [];
  const frames = []; // "array" | { dict: true, wantsValue: boolean }
  const integers = []; // the last plain integers, for "n g R": { start, value }
  let closed = true;
  let streamAt = -1;
  let at = 0;
  const length = data.length;
  /** A complete value (or a token that stands for one) was read: the dictionary around it wants a key again. */
  const value = () => {
    const top = frames[frames.length - 1];
    if (top && top.dict) top.wantsValue = false;
  };
  while (at < length) {
    const byte = data[at];
    if (isBlank(byte)) {
      at += 1;
      continue;
    }
    if (byte === 0x25) { // a comment
      while (at < length && data[at] !== 10 && data[at] !== 13) at += 1;
      continue;
    }
    if (byte === 0x28) { // a literal string, with nested parentheses and escapes
      let depth = 0;
      let end = -1;
      for (let index = at; index < length; index += 1) {
        const char = data[index];
        if (char === 0x5c) index += 1;
        else if (char === 0x28) depth += 1;
        else if (char === 0x29) {
          depth -= 1;
          if (depth === 0) {
            end = index + 1;
            break;
          }
        }
      }
      if (end < 0) {
        closed = false;
        break;
      }
      at = end;
      integers.length = 0;
      value();
      continue;
    }
    if (byte === 0x3c && data[at + 1] === 0x3c) {
      frames.push({ dict: true, wantsValue: false });
      at += 2;
      integers.length = 0;
      continue;
    }
    if (byte === 0x3c) { // a hexadecimal string
      let end = at + 1;
      while (end < length && data[end] !== 0x3e) end += 1;
      if (end >= length) {
        closed = false;
        break;
      }
      at = end + 1;
      integers.length = 0;
      value();
      continue;
    }
    if (byte === 0x3e) {
      const top = frames[frames.length - 1];
      // ">>" where a value should be is taken for the value by a lenient reader, which then reads on
      if (data[at + 1] !== 0x3e || !top || !top.dict || top.wantsValue) {
        closed = false;
        break;
      }
      frames.pop();
      at += 2;
      integers.length = 0;
      value();
      continue;
    }
    if (byte === 0x5b) {
      frames.push("array");
      at += 1;
      integers.length = 0;
      continue;
    }
    if (byte === 0x5d) {
      if (frames[frames.length - 1] !== "array") {
        closed = false;
        break;
      }
      frames.pop();
      at += 1;
      integers.length = 0;
      value();
      continue;
    }
    if (byte === 0x2f) { // a name: a key when the dictionary around it waits for one, a value otherwise
      at += 1;
      while (at < length && !isBlank(data[at]) && !isDelimiter(data[at])) at += 1;
      integers.length = 0;
      const top = frames[frames.length - 1];
      if (top && top.dict && !top.wantsValue) top.wantsValue = true;
      else value();
      continue;
    }
    if (isDelimiter(byte)) { // ) { } outside a string
      at += 1;
      integers.length = 0;
      continue;
    }
    // a number or a keyword
    const start = at;
    while (at < length && !isBlank(data[at]) && !isDelimiter(data[at])) at += 1;
    let plain = true;
    for (let index = start; index < at && plain; index += 1) plain = isDigit(data[index]);
    if (plain) {
      let number = 0;
      for (let index = start; index < at; index += 1) number = number * 10 + (data[index] - 0x30);
      integers.push({ start, value: number });
      if (integers.length > 2) integers.shift();
      value();
      continue;
    }
    if (at - start === 1 && data[start] === 0x52 && integers.length === 2) {
      refs.push({ start: integers[0].start, end: at, number: integers[0].value, generation: integers[1].value });
      integers.length = 0;
      continue;
    }
    integers.length = 0;
    if (frames.length === 0 && at - start === 6 && matches(data, start, "stream")) {
      streamAt = start;
      let end = length;
      while (end > at && isBlank(data[end - 1])) end -= 1;
      if (end - 9 < at || !matches(data, end - 9, "endstream")) closed = false;
      break;
    }
    const top = frames[frames.length - 1];
    // a keyword where a key should be is skipped by a lenient reader; anywhere else it is a value
    if (!(top && top.dict && !top.wantsValue)) value();
  }
  if (frames.length) closed = false;
  return { refs, closed, streamAt };
}

/**
 * @param {Uint8Array} data
 * @param {(number: number, generation: number) => string} map  the replacement text of a reference ("12 0 R", "null")
 * @returns {Uint8Array}
 */
export function rewriteRawObject(data, map) {
  const { refs } = scanRawObject(data);
  if (!refs.length) return data.slice();
  const parts = [];
  let from = 0;
  let size = 0;
  for (const ref of refs) {
    const text = map(ref.number, ref.generation);
    const replacement = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) replacement[index] = text.charCodeAt(index) & 0xff;
    parts.push(data.subarray(from, ref.start), replacement);
    size += ref.start - from + replacement.length;
    from = ref.end;
  }
  parts.push(data.subarray(from));
  size += data.length - from;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
