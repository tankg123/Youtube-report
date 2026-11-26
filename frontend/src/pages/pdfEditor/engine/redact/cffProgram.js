// CFF font programs (FontFile3 with /Subtype /Type1C or /CIDFontType0C) as bytes: reading what the clean-up
// of fonts needs, and writing a program back from which some glyphs are GONE.
//
//   readCff(bytes)                -> { nGlyphs, isCID, charset, charStrings, encoding, fonts ..., glyphOfCid, glyphOfName }
//   rewriteCff(cff, { remove })   -> { bytes, removed, subrsBlanked }
//
// A CFF program names its glyphs through its charset: a CID per glyph in a CID-keyed font (a Type0 font of a
// PDF shows the glyph whose CID the character code maps to), a name per glyph otherwise (a simple font shows
// the glyph whose name its encoding gives to the code). Nothing in a PDF addresses a glyph of a CFF program
// by its NUMBER, so a glyph can be taken out completely: its charstring, its entry of the charset (the CID or
// the name would tell what it was), its entry of the FDSelect table and of the built-in encoding, its name in
// the string table. The glyphs behind it move up; viewers find them through the charset as before.
// Subroutines that only the removed glyphs called are emptied (to a single "return", as subsetters write a
// subroutine nothing uses): a subroutine holds a part of an outline.
//
// The whole program is written again (the offsets in its dictionaries are absolute): header, names, top
// dictionary, strings, global subroutines, then charset, encoding, FDSelect, charstrings, font dictionaries,
// private dictionaries and local subroutines. Operands that are not offsets are copied byte for byte.
//
// RULES (as in fontPrograms.js): everything is validated while reading, and what is not understood throws
// FontProgramError (the caller then leaves the font alone and reports it): a font set with several fonts,
// CFF2, Type 1 charstrings, a synthetic font, the predefined Expert charsets and encoding (their tables are
// not carried here), a charstring with arithmetic or unknown operators (the subroutine a glyph calls could
// not be told with certainty). What was written is read back and compared with the input: every glyph that
// stays has the same charstring, the same CID or name, the same font dictionary and private dictionary.
import { CFF_STANDARD_STRINGS } from "./cffStrings.js";
import { FontProgramError } from "./fontPrograms.js";

const fail = (message) => {
  throw new FontProgramError(message);
};
const u16 = (b, o) => (b[o] << 8) | b[o + 1];

// ---------------------------------------------------------------- INDEX and DICT
/** Reads an INDEX at `at`: { items: Uint8Array[], end }. */
function readIndex(b, at) {
  if (at + 2 > b.length) fail("CFF INDEX outside the program");
  const count = u16(b, at);
  if (count === 0) return { items: [], end: at + 2 };
  const offSize = b[at + 2];
  if (offSize < 1 || offSize > 4) fail("CFF INDEX with a bad offset size");
  const offsets = at + 3;
  const data = offsets + (count + 1) * offSize - 1; // offsets are counted from the byte before the data
  if (data + 1 > b.length) fail("CFF INDEX offsets outside the program");
  const offsetAt = (i) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = v * 256 + b[offsets + i * offSize + k];
    return v;
  };
  const items = [];
  let previous = offsetAt(0);
  if (previous !== 1) fail("CFF INDEX does not start at 1");
  for (let i = 1; i <= count; i++) {
    const next = offsetAt(i);
    if (next < previous || data + next > b.length) fail("CFF INDEX offsets out of order");
    items.push(b.subarray(data + previous, data + next));
    previous = next;
  }
  return { items, end: data + previous };
}

function writeIndex(items) {
  if (!items.length) return Uint8Array.of(0, 0);
  if (items.length > 0xffff) fail("CFF INDEX with too many entries");
  let dataSize = 0;
  for (const item of items) dataSize += item.length;
  const offSize = dataSize + 1 < 0x100 ? 1 : dataSize + 1 < 0x10000 ? 2 : dataSize + 1 < 0x1000000 ? 3 : 4;
  const out = new Uint8Array(3 + (items.length + 1) * offSize + dataSize);
  out[0] = items.length >> 8;
  out[1] = items.length & 0xff;
  out[2] = offSize;
  let offset = 1;
  let p = 3;
  const putOffset = (v) => {
    for (let k = offSize - 1; k >= 0; k--) out[p++] = (v >>> (8 * k)) & 0xff;
  };
  putOffset(offset);
  for (const item of items) {
    offset += item.length;
    putOffset(offset);
  }
  for (const item of items) {
    out.set(item, p);
    p += item.length;
  }
  return out;
}

/** Operators of two bytes (12 x) are numbered 1200 + x. */
const OP = Object.freeze({ charset: 15, Encoding: 16, CharStrings: 17, Private: 18, Subrs: 19, CharstringType: 1206, SyntheticBase: 1220, ROS: 1230, FDArray: 1236, FDSelect: 1237 });
/** Operators whose operands are string identifiers (the string must stay when the dictionary stays). */
const SID_OPERATORS = new Set([0, 1, 2, 3, 4, 1200, 1221, 1222, 1230, 1238]);

/** Reads a DICT: [{ op, values: number[], raw: Uint8Array (operands and operator, as stored) }]. */
function readDict(b) {
  const entries = [];
  let values = [];
  let start = 0;
  let p = 0;
  while (p < b.length) {
    const b0 = b[p];
    if (b0 <= 21) {
      let op = b0;
      p += 1;
      if (b0 === 12) {
        if (p >= b.length) fail("CFF DICT ends inside an operator");
        op = 1200 + b[p];
        p += 1;
      }
      entries.push({ op, values, raw: b.subarray(start, p) });
      values = [];
      start = p;
    } else if (b0 === 28) {
      if (p + 3 > b.length) fail("CFF DICT ends inside a number");
      values.push(((u16(b, p + 1) ^ 0x8000) - 0x8000));
      p += 3;
    } else if (b0 === 29) {
      if (p + 5 > b.length) fail("CFF DICT ends inside a number");
      values.push((b[p + 1] << 24) | (b[p + 2] << 16) | (b[p + 3] << 8) | b[p + 4]);
      p += 5;
    } else if (b0 === 30) {
      // a real number: nibbles up to the end marker 0xf (its value is never an offset: NaN stands for it)
      p += 1;
      for (;;) {
        if (p >= b.length) fail("CFF DICT ends inside a real number");
        const byte = b[p++];
        if ((byte & 0x0f) === 0x0f || (byte >> 4) === 0x0f) break;
      }
      values.push(NaN);
    } else if (b0 >= 32 && b0 <= 246) {
      values.push(b0 - 139);
      p += 1;
    } else if (b0 >= 247 && b0 <= 254) {
      if (p + 2 > b.length) fail("CFF DICT ends inside a number");
      values.push(b0 <= 250 ? (b0 - 247) * 256 + b[p + 1] + 108 : -(b0 - 251) * 256 - b[p + 1] - 108);
      p += 2;
    } else fail("CFF DICT with a reserved byte");
  }
  if (values.length) fail("CFF DICT ends with operands and no operator");
  return entries;
}

const int32Operand = (v) => Uint8Array.of(29, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

/** A DICT again; `replace`: Map<op, number[]> of operands written as 32-bit integers (their size never depends on their value). */
function writeDict(entries, replace) {
  const parts = [];
  for (const entry of entries) {
    if (!replace.has(entry.op)) {
      parts.push(entry.raw);
      continue;
    }
    for (const v of replace.get(entry.op)) parts.push(int32Operand(v));
    parts.push(entry.op >= 1200 ? Uint8Array.of(12, entry.op - 1200) : Uint8Array.of(entry.op));
  }
  return concat(parts);
}

function concat(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const entryOf = (entries, op) => entries.find((entry) => entry.op === op);
const offsetOf = (entries, op, index = 0) => {
  const entry = entryOf(entries, op);
  if (!entry) return undefined;
  const v = entry.values[index];
  if (!Number.isInteger(v) || v < 0) fail("CFF DICT with an offset that is not a number");
  return v;
};

// ---------------------------------------------------------------- charset, encoding, FDSelect
function readCharset(b, at, nGlyphs) {
  const charset = new Uint16Array(nGlyphs);
  if (at === 0) {
    // ISOAdobe: glyph n is the string n (228 names)
    if (nGlyphs > 229) fail("CFF predefined charset shorter than the glyph count");
    for (let gid = 0; gid < nGlyphs; gid++) charset[gid] = gid;
    return charset;
  }
  if (at === 1 || at === 2) fail("CFF predefined Expert charset");
  if (at >= b.length) fail("CFF charset outside the program");
  const format = b[at];
  let p = at + 1;
  let gid = 1;
  if (format === 0) {
    if (p + (nGlyphs - 1) * 2 > b.length) fail("CFF charset runs out of the program");
    for (; gid < nGlyphs; gid++, p += 2) charset[gid] = u16(b, p);
  } else if (format === 1 || format === 2) {
    while (gid < nGlyphs) {
      if (p + format + 2 > b.length) fail("CFF charset runs out of the program");
      const first = u16(b, p);
      const left = format === 1 ? b[p + 2] : u16(b, p + 2);
      p += format + 2;
      for (let k = 0; k <= left && gid < nGlyphs; k++, gid++) charset[gid] = (first + k) & 0xffff;
    }
  } else fail("CFF charset of an unknown format");
  return charset;
}

/** [count of consecutive runs] of the values of a charset / FDSelect from index `from`. */
function runsOf(values, from) {
  const runs = [];
  for (let i = from; i < values.length; i++) {
    const last = runs[runs.length - 1];
    if (last && values[i] === last.first + (i - last.start)) last.count++;
    else runs.push({ start: i, first: values[i], count: 1 });
  }
  return runs;
}

function writeCharset(charset) {
  const n = charset.length;
  const runs = runsOf(charset, 1);
  if (runs.length * 4 < (n - 1) * 2) {
    const out = new Uint8Array(1 + runs.length * 4);
    out[0] = 2;
    runs.forEach((run, index) => {
      out[1 + index * 4] = run.first >> 8;
      out[2 + index * 4] = run.first & 0xff;
      out[3 + index * 4] = (run.count - 1) >> 8;
      out[4 + index * 4] = (run.count - 1) & 0xff;
    });
    return out;
  }
  const out = new Uint8Array(1 + (n - 1) * 2);
  for (let gid = 1; gid < n; gid++) {
    out[1 + (gid - 1) * 2] = charset[gid] >> 8;
    out[2 + (gid - 1) * 2] = charset[gid] & 0xff;
  }
  return out;
}

/** The built-in encoding of a name-keyed font: { codes: Map<code, gid>, supplements: [[code, sid]] }; "standard" for the predefined one. */
function readEncoding(b, at, nGlyphs) {
  if (at === 0) return "standard";
  if (at === 1) fail("CFF predefined Expert encoding");
  if (at + 2 > b.length) fail("CFF encoding outside the program");
  const format = b[at] & 0x7f;
  const codes = new Map();
  let p = at + 2;
  if (format === 0) {
    const count = b[at + 1];
    if (p + count > b.length || count >= nGlyphs) fail("CFF encoding runs out of the program or the glyphs");
    for (let k = 0; k < count; k++) codes.set(b[p + k], k + 1);
    p += count;
  } else if (format === 1) {
    const ranges = b[at + 1];
    let gid = 1;
    for (let r = 0; r < ranges; r++, p += 2) {
      if (p + 2 > b.length) fail("CFF encoding runs out of the program");
      for (let k = 0; k <= b[p + 1]; k++, gid++) {
        if (gid >= nGlyphs) fail("CFF encoding names more glyphs than the font has");
        codes.set((b[p] + k) & 0xff, gid);
      }
    }
  } else fail("CFF encoding of an unknown format");
  const supplements = [];
  if (b[at] & 0x80) {
    if (p >= b.length) fail("CFF encoding supplement outside the program");
    const count = b[p++];
    if (p + count * 3 > b.length) fail("CFF encoding supplement runs out of the program");
    for (let k = 0; k < count; k++, p += 3) supplements.push([b[p], u16(b, p + 1)]);
  }
  return { codes, supplements };
}

function writeEncoding(codesByGid, supplements) {
  // format 0: the codes of the glyphs 1 .. n, in the order of the glyphs
  const out = new Uint8Array(2 + codesByGid.length + (supplements.length ? 1 + supplements.length * 3 : 0));
  out[0] = supplements.length ? 0x80 : 0;
  out[1] = codesByGid.length;
  out.set(codesByGid, 2);
  if (supplements.length) {
    let p = 2 + codesByGid.length;
    out[p++] = supplements.length;
    for (const [code, sid] of supplements) {
      out[p++] = code;
      out[p++] = sid >> 8;
      out[p++] = sid & 0xff;
    }
  }
  return out;
}

function readFdSelect(b, at, nGlyphs, fontCount) {
  if (at >= b.length) fail("CFF FDSelect outside the program");
  const select = new Uint8Array(nGlyphs);
  const format = b[at];
  if (format === 0) {
    if (at + 1 + nGlyphs > b.length) fail("CFF FDSelect runs out of the program");
    select.set(b.subarray(at + 1, at + 1 + nGlyphs));
  } else if (format === 3) {
    const ranges = u16(b, at + 1);
    if (at + 5 + ranges * 3 > b.length || ranges === 0) fail("CFF FDSelect runs out of the program");
    for (let r = 0; r < ranges; r++) {
      const first = u16(b, at + 3 + r * 3);
      const next = u16(b, at + 6 + r * 3);
      if (next < first || next > nGlyphs || (r === 0 && first !== 0)) fail("CFF FDSelect ranges out of order");
      select.fill(b[at + 5 + r * 3], first, next);
    }
    if (u16(b, at + 3 + ranges * 3) !== nGlyphs) fail("CFF FDSelect does not cover the glyphs");
  } else fail("CFF FDSelect of an unknown format");
  for (const fd of select) if (fd >= fontCount) fail("CFF FDSelect names a font dictionary the program does not have");
  return select;
}

function writeFdSelect(select) {
  const runs = [];
  for (let gid = 0; gid < select.length; gid++) if (!runs.length || runs[runs.length - 1].fd !== select[gid]) runs.push({ first: gid, fd: select[gid] });
  if (5 + runs.length * 3 < 1 + select.length) {
    const out = new Uint8Array(5 + runs.length * 3);
    out[0] = 3;
    out[1] = runs.length >> 8;
    out[2] = runs.length & 0xff;
    runs.forEach((run, index) => {
      out[3 + index * 3] = run.first >> 8;
      out[4 + index * 3] = run.first & 0xff;
      out[5 + index * 3] = run.fd;
    });
    out[3 + runs.length * 3] = select.length >> 8;
    out[4 + runs.length * 3] = select.length & 0xff;
    return out;
  }
  const out = new Uint8Array(1 + select.length);
  out.set(select, 1);
  return out;
}

// ---------------------------------------------------------------- reading
function readPrivate(b, entries) {
  const size = offsetOf(entries, OP.Private, 0);
  const at = offsetOf(entries, OP.Private, 1);
  if (size === undefined || at === undefined) return { entries: [], subrs: null };
  if (at + size > b.length) fail("CFF private dictionary outside the program");
  const privateEntries = readDict(b.subarray(at, at + size));
  const subrsAt = offsetOf(privateEntries, OP.Subrs);
  return { entries: privateEntries, subrs: subrsAt === undefined ? null : readIndex(b, at + subrsAt).items };
}

/**
 * Reads a CFF program.
 * Returns { bytes, headerSize, nameIndex, top, strings, gsubrs, charStrings, nGlyphs, isCID, charset (Uint16Array:
 *   the CID or the string identifier of the name of every glyph), encoding ("standard" | { codes, supplements } |
 *   null for a CID-keyed font), fdSelect (or null), fonts: [{ dict (entries; [] for a name-keyed font), private
 *   (entries), subrs (Uint8Array[] or null) }], nameOf(gid), glyphOfCid: Map, glyphOfName: Map }.
 */
export function readCff(bytes) {
  const b = bytes;
  if (!(b instanceof Uint8Array) || b.length < 4) fail("not a CFF font program");
  if (b[0] !== 1) fail("CFF of an unknown major version");
  const headerSize = b[2];
  if (headerSize < 4 || headerSize > b.length) fail("CFF header size");
  const names = readIndex(b, headerSize);
  if (names.items.length !== 1) fail("CFF font set with several fonts");
  const tops = readIndex(b, names.end);
  if (tops.items.length !== 1) fail("CFF top dictionary count");
  const top = readDict(tops.items[0]);
  const stringIndex = readIndex(b, tops.end);
  const gsubrIndex = readIndex(b, stringIndex.end);
  if ((entryOf(top, OP.CharstringType)?.values[0] ?? 2) !== 2) fail("CFF with Type 1 charstrings");
  if (entryOf(top, OP.SyntheticBase)) fail("CFF synthetic font");
  const charStringsAt = offsetOf(top, OP.CharStrings);
  if (charStringsAt === undefined) fail("CFF without charstrings");
  const charStrings = readIndex(b, charStringsAt).items;
  const nGlyphs = charStrings.length;
  if (nGlyphs === 0) fail("CFF without glyphs");
  const isCID = !!entryOf(top, OP.ROS);
  const charset = readCharset(b, offsetOf(top, OP.charset) ?? 0, nGlyphs);
  let encoding = null;
  let fdSelect = null;
  const fonts = [];
  if (isCID) {
    const fdArrayAt = offsetOf(top, OP.FDArray);
    const fdSelectAt = offsetOf(top, OP.FDSelect);
    if (fdArrayAt === undefined || fdSelectAt === undefined) fail("CID-keyed CFF without FDArray or FDSelect");
    for (const item of readIndex(b, fdArrayAt).items) {
      const dict = readDict(item);
      const priv = readPrivate(b, dict);
      fonts.push({ dict, private: priv.entries, subrs: priv.subrs });
    }
    if (!fonts.length || fonts.length > 255) fail("CID-keyed CFF with a bad number of font dictionaries");
    fdSelect = readFdSelect(b, fdSelectAt, nGlyphs, fonts.length);
  } else {
    encoding = readEncoding(b, offsetOf(top, OP.Encoding) ?? 0, nGlyphs);
    const priv = readPrivate(b, top);
    fonts.push({ dict: [], private: priv.entries, subrs: priv.subrs });
  }
  const strings = stringIndex.items;
  const stringOf = (sid) => {
    if (sid < CFF_STANDARD_STRINGS.length) return CFF_STANDARD_STRINGS[sid];
    const custom = strings[sid - CFF_STANDARD_STRINGS.length];
    if (!custom) fail("CFF string identifier without a string");
    let text = "";
    for (const byte of custom) text += String.fromCharCode(byte);
    return text;
  };
  const glyphOfCid = new Map();
  const glyphOfName = new Map();
  for (let gid = nGlyphs - 1; gid >= 0; gid--) {
    // (the first glyph of a CID or a name wins, as in a viewer that searches the charset from the start)
    if (isCID) glyphOfCid.set(gid === 0 ? 0 : charset[gid], gid);
    else glyphOfName.set(stringOf(charset[gid]), gid);
  }
  return {
    bytes: b, headerSize, nameIndex: b.subarray(headerSize, names.end), top, strings, gsubrs: gsubrIndex.items, charStrings, nGlyphs, isCID, charset,
    encoding, fdSelect, fonts, nameOf: (gid) => (isCID ? null : stringOf(charset[gid])), glyphOfCid, glyphOfName
  };
}

// ---------------------------------------------------------------- subroutines a charstring calls
const subrBias = (count) => (count < 1240 ? 107 : count < 33900 ? 1131 : 32768);
const MAX_SUBR_DEPTH = 10;
const MAX_STACK = 96;

/**
 * Marks the subroutines a Type 2 charstring calls (to any depth) in `usedGlobal` / `usedLocal`. Only the
 * operand stack and the number of stem hints are followed (a hint mask is as long as the hints are many).
 * A charstring with arithmetic, storage or unknown operators throws: its calls cannot be told with certainty.
 */
function markSubrs(code, gsubrs, lsubrs, usedGlobal, usedLocal, state = { stack: [], stems: 0, depth: 0, done: false }) {
  let p = 0;
  const { stack } = state;
  const push = (v) => {
    if (stack.length >= MAX_STACK) fail("charstring with too many operands");
    stack.push(v);
  };
  while (p < code.length && !state.done) {
    const b0 = code[p];
    if (b0 >= 32 || b0 === 28) {
      if (b0 === 28) {
        if (p + 3 > code.length) fail("charstring ends inside a number");
        push((u16(code, p + 1) ^ 0x8000) - 0x8000);
        p += 3;
      } else if (b0 <= 246) {
        push(b0 - 139);
        p += 1;
      } else if (b0 <= 254) {
        if (p + 2 > code.length) fail("charstring ends inside a number");
        push(b0 <= 250 ? (b0 - 247) * 256 + code[p + 1] + 108 : -(b0 - 251) * 256 - code[p + 1] - 108);
        p += 2;
      } else {
        if (p + 5 > code.length) fail("charstring ends inside a number");
        push(NaN); // a 16.16 fixed number is never a subroutine number
        p += 5;
      }
      continue;
    }
    p += 1;
    switch (b0) {
      case 1: case 3: case 18: case 23: // hstem vstem hstemhm vstemhm
        state.stems += stack.length >> 1;
        stack.length = 0;
        break;
      case 19: case 20: // hintmask cntrmask (the operands in front of the first one are vertical stems)
        state.stems += stack.length >> 1;
        stack.length = 0;
        p += (state.stems + 7) >> 3;
        if (p > code.length) fail("charstring ends inside a hint mask");
        break;
      case 10: case 29: { // callsubr callgsubr
        const subrs = b0 === 10 ? lsubrs : gsubrs;
        const number = stack.pop();
        if (!Number.isInteger(number) || !subrs) fail("charstring calls a subroutine it cannot name");
        const index = number + subrBias(subrs.length);
        if (index < 0 || index >= subrs.length) fail("charstring calls a subroutine the font does not have");
        (b0 === 10 ? usedLocal : usedGlobal).add(index);
        if (state.depth >= MAX_SUBR_DEPTH) fail("charstring subroutines nested too deeply");
        state.depth++;
        markSubrs(subrs[index], gsubrs, lsubrs, usedGlobal, usedLocal, state);
        state.depth--;
        break;
      }
      case 11: // return
        return;
      case 14: // endchar
        state.done = true;
        return;
      case 4: case 5: case 6: case 7: case 8: case 21: case 22: case 24: case 25: case 26: case 27: case 30: case 31: // moves, lines, curves
        stack.length = 0;
        break;
      case 12: {
        if (p >= code.length) fail("charstring ends inside an operator");
        const b1 = code[p++];
        // 34 .. 37: hflex flex hflex1 flex1; 0: dotsection (a hint of Type 1 fonts that means nothing here)
        if (b1 !== 0 && (b1 < 34 || b1 > 37)) fail("charstring with an arithmetic or storage operator");
        stack.length = 0;
        break;
      }
      default:
        fail("charstring with a reserved operator");
    }
  }
}

/** { global: Set, local: Set[] (per font dictionary) } of the subroutines the given glyphs call. */
function subrsUsedBy(cff, gids) {
  const global = new Set();
  const local = cff.fonts.map(() => new Set());
  for (const gid of gids) {
    const fd = cff.fdSelect ? cff.fdSelect[gid] : 0;
    markSubrs(cff.charStrings[gid], cff.gsubrs, cff.fonts[fd].subrs, global, local[fd]);
  }
  return { global, local };
}

const RETURN_ONLY = Uint8Array.of(11);
const isBlankSubr = (subr) => subr.length <= 1;

// ---------------------------------------------------------------- writing
/**
 * The program again, without the glyphs of `remove`.
 *   remove   Set of glyph numbers (glyph 0, the .notdef glyph, always stays)
 * Returns { bytes, removed: number of glyphs taken out, subrsBlanked }.
 * The subroutines that only removed glyphs called are emptied, unless the program keeps subroutines that no
 * glyph calls anyway (then an unused subroutine says nothing, and emptying some would mark them).
 */
export function rewriteCff(cff, { remove }) {
  const keep = [];
  for (let gid = 0; gid < cff.nGlyphs; gid++) if (gid === 0 || !remove.has(gid)) keep.push(gid);
  const removed = cff.nGlyphs - keep.length;
  const all = Array.from({ length: cff.nGlyphs }, (_, gid) => gid);
  const usedBefore = subrsUsedBy(cff, all);
  const usedAfter = subrsUsedBy(cff, keep);
  let subrsBlanked = 0;
  const blankUnused = (subrs, before, after) => {
    if (!subrs) return null;
    let idle = 0;
    subrs.forEach((subr, index) => {
      if (!before.has(index) && !isBlankSubr(subr)) idle++;
    });
    if (idle > before.size) return subrs; // the producer keeps subroutines nothing calls: leave them all alone
    return subrs.map((subr, index) => {
      if (after.has(index) || !before.has(index) || isBlankSubr(subr)) return subr;
      subrsBlanked++;
      return RETURN_ONLY;
    });
  };
  const gsubrs = blankUnused(cff.gsubrs, usedBefore.global, usedAfter.global);
  const lsubrs = cff.fonts.map((font, fd) => blankUnused(font.subrs, usedBefore.local[fd], usedAfter.local[fd]));

  // ---- the tables per glyph
  const charStrings = keep.map((gid) => cff.charStrings[gid]);
  const charset = Uint16Array.from(keep, (gid) => cff.charset[gid]);
  const fdSelect = cff.fdSelect ? Uint8Array.from(keep, (gid) => cff.fdSelect[gid]) : null;
  const newGid = new Map(keep.map((gid, index) => [gid, index]));
  let encodingBytes = null;
  let strings = cff.strings;
  if (!cff.isCID) {
    // the names of the removed glyphs leave the string table (their identifiers stay, as empty strings), unless
    // a glyph that stays, an encoding supplement or a dictionary uses the same string
    const needed = new Set(charset);
    for (const entry of [...cff.top, ...cff.fonts.flatMap((font) => font.dict)]) if (SID_OPERATORS.has(entry.op)) for (const v of entry.values) needed.add(v);
    const supplements = cff.encoding === "standard" ? [] : cff.encoding.supplements.filter(([, sid]) => needed.has(sid));
    for (const [, sid] of supplements) needed.add(sid);
    const first = CFF_STANDARD_STRINGS.length;
    strings = cff.strings.map((text, index) => {
      const sid = first + index;
      const wasGlyphName = [...remove].some((gid) => gid > 0 && gid < cff.nGlyphs && cff.charset[gid] === sid);
      return wasGlyphName && !needed.has(sid) ? new Uint8Array(0) : text;
    });
    if (cff.encoding !== "standard") {
      const byGid = new Map();
      for (const [code, gid] of cff.encoding.codes) if (newGid.has(gid)) byGid.set(newGid.get(gid), code);
      // the glyphs that carry a code are the first ones, before and after (their order does not change)
      const codes = [];
      for (let gid = 1; byGid.has(gid); gid++) codes.push(byGid.get(gid));
      if (codes.length !== byGid.size) fail("CFF encoding: the glyphs with a code are not the first glyphs");
      encodingBytes = writeEncoding(Uint8Array.from(codes), supplements);
    }
  }

  // ---- layout: every offset is written as a 32-bit operand, so the sizes are known before the offsets are
  const head = cff.bytes.subarray(0, cff.headerSize);
  const charsetBytes = writeCharset(charset);
  const fdSelectBytes = fdSelect ? writeFdSelect(fdSelect) : null;
  const charStringsBytes = writeIndex(charStrings);
  const stringBytes = writeIndex(strings);
  const gsubrBytes = writeIndex(gsubrs);
  const privates = cff.fonts.map((font, fd) => {
    if (!font.private.length && !entryOf(font.dict.length ? font.dict : cff.top, OP.Private)) return null;
    const subrBytes = lsubrs[fd] ? writeIndex(lsubrs[fd]) : null;
    const sized = writeDict(font.private, new Map(subrBytes ? [[OP.Subrs, [0]]] : []));
    const dict = writeDict(font.private, new Map(subrBytes ? [[OP.Subrs, [sized.length]]] : []));
    return { dict, subrBytes };
  });
  const topReplace = (values) => {
    const replace = new Map([[OP.CharStrings, [values.charStrings]], [OP.charset, [values.charset]]]);
    if (cff.isCID) {
      replace.set(OP.FDArray, [values.fdArray]);
      replace.set(OP.FDSelect, [values.fdSelect]);
    } else {
      if (encodingBytes) replace.set(OP.Encoding, [values.encoding]);
      if (privates[0]) replace.set(OP.Private, [privates[0].dict.length, values.privates[0]]);
    }
    return replace;
  };
  const zeroOffsets = { charStrings: 0, charset: 0, fdArray: 0, fdSelect: 0, encoding: 0, privates: privates.map(() => 0) };
  // a font that used the predefined charset has no charset operator: it gets one (the default would be read)
  const top = entryOf(cff.top, OP.charset) ? cff.top : [...cff.top, { op: OP.charset, values: [0], raw: new Uint8Array(0) }];
  const topSize = writeDict(top, topReplace(zeroOffsets)).length;
  const fontDictSize = (font, fd) => writeDict(font.dict, new Map(privates[fd] ? [[OP.Private, [0, 0]]] : [])).length;
  const topIndexSize = writeIndex([new Uint8Array(topSize)]).length;
  let at = head.length + cff.nameIndex.length + topIndexSize + stringBytes.length + gsubrBytes.length;
  const offsets = { ...zeroOffsets, privates: [] };
  offsets.charset = at;
  at += charsetBytes.length;
  if (encodingBytes) {
    offsets.encoding = at;
    at += encodingBytes.length;
  }
  if (fdSelectBytes) {
    offsets.fdSelect = at;
    at += fdSelectBytes.length;
  }
  offsets.charStrings = at;
  at += charStringsBytes.length;
  let fdArrayBytes = null;
  if (cff.isCID) {
    offsets.fdArray = at;
    at += writeIndex(cff.fonts.map((font, fd) => new Uint8Array(fontDictSize(font, fd)))).length;
  }
  for (const priv of privates) {
    offsets.privates.push(at);
    if (priv) at += priv.dict.length + (priv.subrBytes ? priv.subrBytes.length : 0);
  }
  if (cff.isCID) fdArrayBytes = writeIndex(cff.fonts.map((font, fd) => writeDict(font.dict, new Map(privates[fd] ? [[OP.Private, [privates[fd].dict.length, offsets.privates[fd]]]] : []))));
  const parts = [head, cff.nameIndex, writeIndex([writeDict(top, topReplace(offsets))]), stringBytes, gsubrBytes, charsetBytes];
  if (encodingBytes) parts.push(encodingBytes);
  if (fdSelectBytes) parts.push(fdSelectBytes);
  parts.push(charStringsBytes);
  if (fdArrayBytes) parts.push(fdArrayBytes);
  for (const priv of privates) if (priv) parts.push(priv.dict, ...(priv.subrBytes ? [priv.subrBytes] : []));
  const bytes = concat(parts);
  if (bytes.length !== at) fail("self-check: the layout of the CFF program does not add up");

  // ---- what was written is read back and compared
  const check = readCff(bytes);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (check.nGlyphs !== keep.length || check.isCID !== cff.isCID || check.fonts.length !== cff.fonts.length) fail("self-check: the CFF program changed its shape");
  keep.forEach((gid, index) => {
    if (!same(check.charStrings[index], cff.charStrings[gid])) fail(`self-check: the charstring of glyph ${gid} changed`);
    if (check.charset[index] !== cff.charset[gid]) fail(`self-check: the charset entry of glyph ${gid} changed`);
    if (cff.fdSelect && check.fdSelect[index] !== cff.fdSelect[gid]) fail(`self-check: the font dictionary of glyph ${gid} changed`);
    if (!cff.isCID && check.nameOf(index) !== cff.nameOf(gid)) fail(`self-check: the name of glyph ${gid} changed`);
  });
  cff.fonts.forEach((font, fd) => {
    const written = check.fonts[fd];
    if ((written.subrs?.length ?? -1) !== (font.subrs?.length ?? -1)) fail("self-check: the local subroutines changed their count");
    const plain = (entries) => entries.filter((entry) => entry.op !== OP.Subrs && entry.op !== OP.Private);
    if (!same(concat(plain(written.private).map((entry) => entry.raw)), concat(plain(font.private).map((entry) => entry.raw)))) fail("self-check: a private dictionary changed");
    if (!same(concat(plain(written.dict).map((entry) => entry.raw)), concat(plain(font.dict).map((entry) => entry.raw)))) fail("self-check: a font dictionary changed");
  });
  if (check.gsubrs.length !== cff.gsubrs.length) fail("self-check: the global subroutines changed their count");
  // every subroutine a glyph that stays calls is what it was
  const still = subrsUsedBy(check, check.charStrings.map((_, gid) => gid));
  for (const index of still.global) if (!same(check.gsubrs[index], cff.gsubrs[index])) fail("self-check: a global subroutine in use changed");
  still.local.forEach((used, fd) => {
    for (const index of used) if (!same(check.fonts[fd].subrs[index], cff.fonts[fd].subrs[index])) fail("self-check: a local subroutine in use changed");
  });
  if (!cff.isCID && cff.encoding !== "standard") {
    for (const [code, gid] of cff.encoding.codes) {
      const expected = newGid.has(gid) ? newGid.get(gid) : undefined;
      if (check.encoding.codes.get(code) !== expected) fail("self-check: the built-in encoding changed");
    }
  }
  return { bytes, removed, subrsBlanked };
}

/** Glyphs whose charstring draws nothing (an "endchar", with or without a width in front of it). */
export function isEmptyCharstring(code) {
  if (code.length === 0) return true;
  if (code[code.length - 1] !== 14) return false;
  // only numbers may stand in front of the endchar
  let p = 0;
  while (p < code.length - 1) {
    const b0 = code[p];
    if (b0 === 28) p += 3;
    else if (b0 >= 32 && b0 <= 246) p += 1;
    else if (b0 >= 247 && b0 <= 254) p += 2;
    else if (b0 === 255) p += 5;
    else return false;
  }
  return p === code.length - 1;
}
