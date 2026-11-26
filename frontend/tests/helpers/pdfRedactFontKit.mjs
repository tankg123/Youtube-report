// Fonts for the redaction suites (tests/pdfRedactFont*.test.mjs): generated font programs and PDF fonts of
// every kind the clean-up handles, and an INDEPENDENT reading of the fonts of an output file (the decoders
// here share no code with engine/redact: a test must not ask the engine whether the engine was right).
//
//   makeCffFont({ chars })                 a name-keyed CFF program (FontFile3 /Type1C): one box per character,
//                                          drawn through local and global subroutines
//   makeOtfFont({ chars })                 the same program wrapped as an OpenType font (for embedFont)
//   subsetTrueType(fontKey, text)          a TrueType subset of a bundled font, glyphs in order of first use
//   addSfntTable / readSfnt / writeSfnt    just enough of the container to add a cmap to such a subset
//   cmapFormat0 / cmapFormat4 / cmapFormat6, readCmapTable
//   toUnicodeStream(pairs)                 a ToUnicode CMap
//   fontsOf(bytes)                         [{ name, subtype, toUnicode, widths, glyphs ... }] of a PDF
// Nothing is copied from anywhere: the box font is drawn here, the subsets are cut from the bundled fonts.
import { closePdf, fontBytes, fontkit, openPdf, pdfLib, renderPage } from "./pdfTestKit.mjs";
import { bytesOf as latinBytes, makePdf } from "./pdfRedactKit.mjs";

const { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFStream, PDFRawStream, PDFNumber, decodePDFRawStream } = pdfLib;

const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const bytesOf = (...parts) => Uint8Array.from(parts.flat(Infinity));
const ascii = (text) => Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

// ---------------------------------------------------------------- sfnt container
/** { version, tables: Map<tag, Uint8Array> } of an sfnt font file. */
export function readSfnt(bytes) {
  const tables = new Map();
  const count = u16(bytes, 4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    tables.set(tag, bytes.slice(u32(bytes, at + 8), u32(bytes, at + 8) + u32(bytes, at + 12)));
  }
  return { version: u32(bytes, 0), tables };
}

/** An sfnt font file from { version, tables } (checksums are left at zero: no PDF viewer looks at them). */
export function writeSfnt({ version, tables }) {
  const tags = [...tables.keys()].sort();
  let offset = 12 + tags.length * 16;
  const place = new Map();
  for (const tag of tags) {
    place.set(tag, offset);
    offset += (tables.get(tag).length + 3) & ~3;
  }
  const out = new Uint8Array(offset);
  out.set(be32(version), 0);
  out.set(be16(tags.length), 4);
  const power = 2 ** Math.floor(Math.log2(tags.length));
  out.set([...be16(power * 16), ...be16(Math.log2(power)), ...be16(tags.length * 16 - power * 16)], 6);
  tags.forEach((tag, index) => {
    out.set([...ascii(tag), 0, 0, 0, 0, ...be32(place.get(tag)), ...be32(tables.get(tag).length)], 12 + index * 16);
    out.set(tables.get(tag), place.get(tag));
  });
  return out;
}

/** The font file again with one more (or a replaced) table. */
export function addSfntTable(bytes, tag, data) {
  const font = readSfnt(bytes);
  font.tables.set(tag, data);
  return writeSfnt(font);
}

/** cmap table with one format 0 subtable (byte code -> glyph), platform 1 encoding 0 by default. */
export function cmapFormat0(map, platform = 1, encoding = 0) {
  const body = new Uint8Array(262);
  body.set([...be16(0), ...be16(262), ...be16(0)]);
  for (const [code, glyph] of map) body[6 + code] = glyph;
  return bytesOf(be16(0), be16(1), be16(platform), be16(encoding), be32(12), [...body]);
}

/** cmap table with one format 6 subtable (a dense range of codes -> glyphs). */
export function cmapFormat6(map, platform = 1, encoding = 0) {
  const codes = [...map.keys()].sort((a, b) => a - b);
  const first = codes[0];
  const count = codes[codes.length - 1] - first + 1;
  const glyphs = Array.from({ length: count }, (_, k) => be16(map.get(first + k) || 0));
  return bytesOf(be16(0), be16(1), be16(platform), be16(encoding), be32(12), be16(6), be16(10 + count * 2), be16(0), be16(first), be16(count), glyphs);
}

/** cmap table with one format 4 subtable (one segment per code, glyphs through the glyph array), platform 3 encoding 1 by default. */
export function cmapFormat4(map, platform = 3, encoding = 1) {
  const codes = [...map.keys()].sort((a, b) => a - b);
  const n = codes.length + 1;
  const ends = [...codes, 0xffff];
  const starts = [...codes, 0xffff];
  const deltas = [...codes.map(() => 0), 1];
  // every real segment points into the glyph array (the form subsetters write most often)
  const rangeOffsets = codes.map((_, i) => (n - i) * 2 + i * 2);
  rangeOffsets.push(0);
  const glyphs = codes.map((code) => map.get(code));
  const power = 2 ** Math.floor(Math.log2(n));
  const length = 16 + n * 8 + glyphs.length * 2;
  const sub = bytesOf(be16(4), be16(length), be16(0), be16(n * 2), be16(power * 2), be16(Math.log2(power)), be16(n * 2 - power * 2),
    ends.map(be16), be16(0), starts.map(be16), deltas.map(be16), rangeOffsets.map(be16), glyphs.map(be16));
  return bytesOf(be16(0), be16(1), be16(platform), be16(encoding), be32(12), [...sub]);
}

/**
 * Reads the subtables of a cmap table in the formats 0, 4 and 6 (independent of the engine):
 * [{ platform, encoding, format, map: Map<code, glyph> }] (codes that map to glyph 0 are left out).
 */
export function readCmapTable(table) {
  const out = [];
  for (let i = 0; i < u16(table, 2); i++) {
    const platform = u16(table, 4 + i * 8);
    const encoding = u16(table, 6 + i * 8);
    const o = u32(table, 8 + i * 8);
    const format = u16(table, o);
    const map = new Map();
    if (format === 0) {
      for (let code = 0; code < 256; code++) if (table[o + 6 + code]) map.set(code, table[o + 6 + code]);
    } else if (format === 6) {
      const first = u16(table, o + 6);
      for (let k = 0; k < u16(table, o + 8); k++) if (u16(table, o + 10 + k * 2)) map.set(first + k, u16(table, o + 10 + k * 2));
    } else if (format === 4) {
      const n = u16(table, o + 6) / 2;
      const ends = o + 14;
      const starts = ends + n * 2 + 2;
      const deltas = starts + n * 2;
      const offsets = deltas + n * 2;
      for (let s = 0; s < n; s++) {
        const start = u16(table, starts + s * 2);
        const end = u16(table, ends + s * 2);
        const rangeOffset = u16(table, offsets + s * 2);
        for (let code = start; code <= end && code < 0xffff; code++) {
          let glyph;
          if (rangeOffset === 0) glyph = (code + u16(table, deltas + s * 2)) & 0xffff;
          else {
            glyph = u16(table, offsets + s * 2 + rangeOffset + (code - start) * 2);
            if (glyph) glyph = (glyph + u16(table, deltas + s * 2)) & 0xffff;
          }
          if (glyph) map.set(code, glyph);
        }
      }
    }
    out.push({ platform, encoding, format, map });
  }
  return out;
}

// ---------------------------------------------------------------- a TrueType subset of a bundled font
/**
 * A TrueType subset (glyf outlines) of a bundled font holding the glyphs of `text`, numbered in the order of
 * first use from 1 (glyph 0 is .notdef), as fontkit writes it for a PDF: no cmap, no post, no name table.
 * Returns { bytes, glyphOf: Map<character, glyph>, advanceOf: Map<character, 1/1000 em>, metrics }.
 */
export function subsetTrueType(fontKey, text) {
  const font = fontkit.create(fontBytes(fontKey));
  const subset = font.createSubset();
  const glyphOf = new Map();
  const advanceOf = new Map();
  for (const ch of text) {
    if (glyphOf.has(ch)) continue;
    const glyph = font.glyphForCodePoint(ch.codePointAt(0));
    glyphOf.set(ch, subset.includeGlyph(glyph));
    advanceOf.set(ch, Math.round((glyph.advanceWidth * 1000) / font.unitsPerEm));
  }
  const scale = 1000 / font.unitsPerEm;
  const metrics = { ascent: Math.round(font.ascent * scale), descent: Math.round(font.descent * scale), capHeight: Math.round((font.capHeight || font.ascent) * scale), bbox: [font.bbox.minX, font.bbox.minY, font.bbox.maxX, font.bbox.maxY].map((v) => Math.round(v * scale)) };
  return { bytes: new Uint8Array(subset.encode()), glyphOf, advanceOf, metrics };
}

// ---------------------------------------------------------------- a hand-made CFF font
/** The glyph names of the Latin-1 characters the box font knows (CFF standard strings; the test font needs no others). */
const NAMES = Object.freeze({
  " ": "space", "-": "hyphen", ".": "period", ":": "colon", "/": "slash", ",": "comma",
  0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine"
});
/** Standard string identifiers of those names (Adobe TN 5176 Appendix A): space 1, comma 13 .. slash 16, digits 17 .. 26, colon 27, A 34, a 66. */
const sidOf = (ch) => {
  if (ch >= "A" && ch <= "Z") return 34 + ch.charCodeAt(0) - 65;
  if (ch >= "a" && ch <= "z") return 66 + ch.charCodeAt(0) - 97;
  if (ch >= "0" && ch <= "9") return 17 + Number(ch);
  return { " ": 1, ",": 13, "-": 14, ".": 15, "/": 16, ":": 27 }[ch];
};
export const glyphNameOf = (ch) => (/[A-Za-z]/.test(ch) ? ch : NAMES[ch]);

/** The box a character is drawn as (1/1000 em): every character has its own width and height. */
export function boxOfChar(ch) {
  const code = ch.codePointAt(0);
  return { width: 240 + (code % 11) * 40, height: 320 + (code % 7) * 70, advance: 340 + (code % 11) * 40 + 60 };
}

/** A number as an operand of a CFF DICT or of a Type 2 charstring (integers only). */
function cffInt(v) {
  if (v >= -107 && v <= 107) return [v + 139];
  if (v >= 108 && v <= 1131) return [247 + ((v - 108) >> 8), (v - 108) & 0xff];
  if (v >= -1131 && v <= -108) return [251 + ((-v - 108) >> 8), (-v - 108) & 0xff];
  return [28, (v >> 8) & 0xff, v & 0xff];
}
const cffOffset = (v) => [29, ...be32(v)];

function cffIndex(items) {
  if (!items.length) return [0, 0];
  const out = [...be16(items.length), 2];
  let offset = 1;
  out.push(...be16(offset));
  for (const item of items) {
    offset += item.length;
    out.push(...be16(offset));
  }
  for (const item of items) out.push(...item);
  return out;
}

/**
 * A name-keyed CFF font program with a box-shaped glyph for every character of `chars` (letters, digits and
 * a few signs), in that order. Odd glyphs draw their box through a LOCAL subroutine, every fourth glyph
 * through a GLOBAL one, the others in the charstring itself; the space is empty. With `spareSubrs`, each
 * subroutine table also holds that many subroutines nothing calls.
 * The built-in encoding gives each glyph the character code of its character.
 *   mutate   ({ charStrings, globalSubrs, localSubrs }) => void: a last touch on the byte lists before the
 *            program is assembled (for the tests of what a reader must refuse)
 */
export function makeCffFont({ chars, fontName = "RedactBoxes", spareSubrs = 0, mutate = null } = {}) {
  const list = [...new Set([...chars])];
  const globalSubrs = [];
  const localSubrs = [];
  const drawOps = (box) => [...cffInt(box.width), 6, ...cffInt(box.height), 7, ...cffInt(-box.width), 6]; // hlineto vlineto hlineto
  const plans = list.map((ch, index) => {
    const box = boxOfChar(ch);
    const kind = ch === " " ? "empty" : index % 4 === 3 ? "global" : index % 2 === 1 ? "local" : "inline";
    if (kind === "global") globalSubrs.push([...drawOps(box), 11]);
    if (kind === "local") localSubrs.push([...drawOps(box), 11]);
    return { ch, box, kind, subr: kind === "global" ? globalSubrs.length - 1 : kind === "local" ? localSubrs.length - 1 : -1 };
  });
  for (let k = 0; k < spareSubrs; k++) {
    globalSubrs.push([...cffInt(500 + k), 6, 11]);
    localSubrs.push([...cffInt(600 + k), 6, 11]);
  }
  const charStrings = [[14]]; // .notdef: endchar
  for (const plan of plans) {
    const start = [...cffInt(plan.box.advance), ...cffInt(50), ...cffInt(0), 21]; // width dx dy rmoveto
    if (plan.kind === "empty") charStrings.push([...cffInt(plan.box.advance), 14]);
    else if (plan.kind === "inline") charStrings.push([...start, ...drawOps(plan.box), 14]);
    else charStrings.push([...start, ...cffInt(plan.subr - 107), plan.kind === "global" ? 29 : 10, 14]);
  }
  if (mutate) mutate({ charStrings, globalSubrs, localSubrs });
  const strings = [ascii(fontName)];
  const header = [1, 0, 4, 2];
  const names = cffIndex([ascii(fontName)]);
  const stringIndex = cffIndex(strings);
  const gsubrs = cffIndex(globalSubrs);
  const charset = [0, ...list.flatMap((ch) => be16(sidOf(ch)))];
  const encoding = [0, list.length, ...list.map((ch) => ch.charCodeAt(0))];
  const charStringIndex = cffIndex(charStrings);
  const lsubrs = cffIndex(localSubrs);
  const privateFor = (subrsAt) => [...cffInt(500), 20, ...cffInt(0), 21, ...cffOffset(subrsAt), 19]; // defaultWidthX nominalWidthX Subrs
  const privateSize = privateFor(0).length;
  const top = (o) => [
    ...cffInt(391), 2, // FullName: the first custom string
    ...cffInt(0), ...cffInt(-250), ...cffInt(1000), ...cffInt(900), 5, // FontBBox
    ...cffOffset(o.charset), 15, ...cffOffset(o.encoding), 16, ...cffOffset(o.charStrings), 17, ...cffInt(privateSize), ...cffOffset(o.private), 18
  ];
  const topIndexSize = cffIndex([top({ charset: 0, encoding: 0, charStrings: 0, private: 0 })]).length;
  const o = {};
  o.charset = header.length + names.length + topIndexSize + stringIndex.length + gsubrs.length;
  o.encoding = o.charset + charset.length;
  o.charStrings = o.encoding + encoding.length;
  o.private = o.charStrings + charStringIndex.length;
  return bytesOf(header, names, cffIndex([top(o)]), stringIndex, gsubrs, charset, encoding, charStringIndex, privateFor(privateSize), lsubrs);
}

/** The box font as an OpenType font file (CFF outlines), with a Unicode cmap: what embedFont() takes. */
export function makeOtfFont({ chars, fontName = "RedactBoxes" } = {}) {
  const list = [...new Set([...chars])];
  const cff = makeCffFont({ chars, fontName });
  const numGlyphs = list.length + 1;
  const advances = [500, ...list.map((ch) => boxOfChar(ch).advance)];
  const s16 = (v) => be16(v & 0xffff);
  const head = bytesOf(be32(0x00010000), be32(0x00010000), be32(0), be32(0x5f0f3cf5), be16(0x000b), be16(1000), new Array(16).fill(0), s16(0), s16(-250), s16(1000), s16(900), be16(0), be16(8), s16(2), s16(0), s16(0));
  const hhea = bytesOf(be32(0x00010000), s16(800), s16(-200), s16(0), be16(Math.max(...advances)), s16(0), s16(0), s16(1000), s16(1), s16(0), s16(0), s16(0), s16(0), s16(0), s16(0), s16(0), be16(numGlyphs));
  const maxp = bytesOf(be32(0x00005000), be16(numGlyphs));
  const hmtx = bytesOf(advances.map((advance) => [...be16(advance), ...s16(50)]));
  const cmap = cmapFormat4(new Map(list.map((ch, index) => [ch.charCodeAt(0), index + 1])));
  const utf16 = (text) => Array.from(text, (ch) => be16(ch.charCodeAt(0))).flat();
  const nameStrings = [[1, fontName], [2, "Regular"], [4, fontName], [6, fontName]];
  const records = [];
  const storage = [];
  for (const [id, text] of nameStrings) {
    const data = utf16(text);
    records.push([...be16(3), ...be16(1), ...be16(0x0409), ...be16(id), ...be16(data.length), ...be16(storage.length)]);
    storage.push(...data);
  }
  const name = bytesOf(be16(0), be16(records.length), be16(6 + records.length * 12), records, storage);
  const os2 = bytesOf(be16(4), s16(500), be16(400), be16(5), be16(0), new Array(20).fill(0), s16(0), new Array(10).fill(0), be32(1), be32(0), be32(0), be32(0), ascii("NONE"), be16(0x0040),
    be16(32), be16(122), s16(800), s16(-200), s16(0), be16(900), be16(250), be32(1), be32(0), s16(500), s16(700), be16(0), be16(32), be16(0));
  const post = bytesOf(be32(0x00030000), be32(0), s16(-100), s16(50), be32(0), be32(0), be32(0), be32(0), be32(0));
  return writeSfnt({ version: 0x4f54544f, tables: new Map([["CFF ", cff], ["OS/2", os2], ["cmap", cmap], ["head", head], ["hhea", hhea], ["hmtx", hmtx], ["maxp", maxp], ["name", name], ["post", post]]) });
}

// ---------------------------------------------------------------- PDF pieces
/** A ToUnicode CMap stream body for [[code, text], ...] with codes of `bytes` bytes. */
export function toUnicodeCMap(pairs, bytes = 1) {
  const hex = (v, width) => v.toString(16).toUpperCase().padStart(width, "0");
  const dst = (text) => Array.from(text, (ch) => hex(ch.charCodeAt(0), 4)).join("");
  const lines = pairs.map(([code, text]) => `<${hex(code, bytes * 2)}> <${dst(text)}>`);
  return [
    "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap", "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def", "1 begincodespacerange", `<${hex(0, bytes * 2)}> <${"FF".repeat(bytes)}>`, "endcodespacerange",
    `${lines.length} beginbfchar`, ...lines, "endbfchar", "endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"
  ].join("\n");
}

// ---------------------------------------------------------------- reading the fonts of a PDF (independent of the engine)
function streamData(stream) {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  return stream.getUnencodedContents();
}

/** Decodes a ToUnicode CMap: Map<code, text> (bfchar, bfrange with a start value or an array). */
export function decodeToUnicode(text) {
  const out = new Map();
  const str = (hexDigits) => {
    let s = "";
    for (let i = 0; i + 4 <= hexDigits.length; i += 4) s += String.fromCharCode(parseInt(hexDigits.slice(i, i + 4), 16));
    return s;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) out.set(parseInt(pair[1], 16), str(pair[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(range[1], 16);
      const hi = parseInt(range[2], 16);
      if (range[3] !== undefined) {
        const base = str(range[3]);
        for (let code = lo; code <= hi; code++) out.set(code, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + code - lo));
      } else {
        const items = [...range[4].matchAll(/<([0-9A-Fa-f]*)>/g)].map((m) => str(m[1]));
        items.forEach((item, k) => out.set(lo + k, item));
      }
    }
  }
  return out;
}

/** Glyph numbers of a TrueType program that have an outline, and their record lengths: Map<glyph, length>. */
export function trueTypeOutlines(bytes) {
  const { tables } = readSfnt(bytes);
  const numGlyphs = u16(tables.get("maxp"), 4);
  const long = u16(tables.get("head"), 50) === 1;
  const loca = tables.get("loca");
  const at = (i) => (long ? u32(loca, i * 4) : u16(loca, i * 2) * 2);
  const out = new Map();
  for (let glyph = 0; glyph < numGlyphs; glyph++) if (at(glyph + 1) > at(glyph)) out.set(glyph, at(glyph + 1) - at(glyph));
  return { numGlyphs, outlines: out, tables };
}

/**
 * The charstrings of a CFF program and what names them: { count, charStrings, charset (CID or SID per glyph),
 * gsubrs, lsubrs, isCID, strings, encoding: Map<code, glyph> of a built-in encoding (formats 0 and 1) or null }.
 */
export function cffGlyphs(bytes) {
  const index = (at) => {
    const count = u16(bytes, at);
    if (!count) return { items: [], end: at + 2 };
    const size = bytes[at + 2];
    const off = (i) => {
      let v = 0;
      for (let k = 0; k < size; k++) v = v * 256 + bytes[at + 3 + i * size + k];
      return v;
    };
    const data = at + 3 + (count + 1) * size - 1;
    const items = [];
    for (let i = 0; i < count; i++) items.push(bytes.slice(data + off(i), data + off(i + 1)));
    return { items, end: data + off(count) };
  };
  const dict = (b) => {
    const entries = new Map();
    let values = [];
    for (let p = 0; p < b.length; ) {
      const b0 = b[p];
      if (b0 <= 21) {
        const op = b0 === 12 ? 1200 + b[p + 1] : b0;
        p += b0 === 12 ? 2 : 1;
        entries.set(op, values);
        values = [];
      } else if (b0 === 28) {
        values.push(((u16(b, p + 1) ^ 0x8000) - 0x8000));
        p += 3;
      } else if (b0 === 29) {
        values.push((b[p + 1] << 24) | (b[p + 2] << 16) | (b[p + 3] << 8) | b[p + 4]);
        p += 5;
      } else if (b0 === 30) {
        p += 1;
        while ((b[p] & 0x0f) !== 0x0f && (b[p] >> 4) !== 0x0f) p++;
        p++;
        values.push(NaN);
      } else if (b0 <= 246) {
        values.push(b0 - 139);
        p += 1;
      } else {
        values.push(b0 <= 250 ? (b0 - 247) * 256 + b[p + 1] + 108 : -(b0 - 251) * 256 - b[p + 1] - 108);
        p += 2;
      }
    }
    return entries;
  };
  const names = index(bytes[2]);
  const tops = index(names.end);
  const top = dict(tops.items[0]);
  const strings = index(tops.end);
  const gsubrs = index(strings.end).items;
  const charStrings = index(top.get(17)[0]).items;
  const charsetAt = top.get(15)?.[0] ?? 0;
  const charset = [0];
  if (charsetAt > 2) {
    const format = bytes[charsetAt];
    let p = charsetAt + 1;
    while (charset.length < charStrings.length) {
      if (format === 0) {
        charset.push(u16(bytes, p));
        p += 2;
      } else {
        const first = u16(bytes, p);
        const left = format === 1 ? bytes[p + 2] : u16(bytes, p + 2);
        p += format === 1 ? 3 : 4;
        for (let k = 0; k <= left && charset.length < charStrings.length; k++) charset.push(first + k);
      }
    }
  } else for (let gid = 1; gid < charStrings.length; gid++) charset.push(gid);
  const lsubrs = [];
  const privates = [];
  if (top.has(18)) privates.push(top.get(18));
  if (top.has(1236)) for (const item of index(top.get(1236)[0]).items) if (dict(item).has(18)) privates.push(dict(item).get(18));
  for (const [size, at] of privates) {
    const priv = dict(bytes.subarray(at, at + size));
    if (priv.has(19)) lsubrs.push(...index(at + priv.get(19)[0]).items);
  }
  let encoding = null;
  const encodingAt = top.get(16)?.[0] ?? 0;
  if (encodingAt > 1) {
    encoding = new Map();
    const format = bytes[encodingAt] & 0x7f;
    if (format === 0) for (let k = 0; k < bytes[encodingAt + 1]; k++) encoding.set(bytes[encodingAt + 2 + k], k + 1);
    else {
      let glyph = 1;
      for (let k = 0; k < bytes[encodingAt + 1]; k++) for (let n = 0; n <= bytes[encodingAt + 3 + k * 2]; n++) encoding.set(bytes[encodingAt + 2 + k * 2] + n, glyph++);
    }
  }
  return { count: charStrings.length, charStrings, charset, gsubrs, lsubrs, isCID: top.has(1230), strings: strings.items.map((item) => String.fromCharCode(...item)), encoding };
}

/**
 * The fonts of a PDF file as they are stored: [{ ref, name, subtype, toUnicode: Map<code, text> | null,
 * widths: Map<code or CID, width>, programKind: "truetype" | "cff" | "type1" | null, program: Uint8Array | null,
 * charProcs: string[] | null }], one entry per font dictionary a resource dictionary can reach (a Type0 font
 * with its descendant).
 */
export async function fontsOf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const get = (dict, key) => (dict instanceof PDFDict ? dict.lookup(PDFName.of(key)) : undefined);
  const nameOf = (value) => (value instanceof PDFName ? value.decodeText() : undefined);
  const numberOf = (value) => (value instanceof PDFNumber ? value.asNumber() : undefined);
  const fonts = [];
  for (const [ref, object] of ctx.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || nameOf(get(object, "Type")) !== "Font") continue;
    const subtype = nameOf(get(object, "Subtype"));
    if (subtype === "CIDFontType0" || subtype === "CIDFontType2") continue;
    const cidFont = subtype === "Type0" ? get(object, "DescendantFonts")?.lookup(0) : null;
    const descriptor = get(cidFont || object, "FontDescriptor");
    const entry = { ref: `${ref.objectNumber} ${ref.generationNumber}`, name: nameOf(get(object, "BaseFont")) || nameOf(get(object, "Name")) || "", subtype, toUnicode: null, widths: new Map(), programKind: null, program: null, charProcs: null };
    const tu = get(object, "ToUnicode");
    if (tu instanceof PDFStream) entry.toUnicode = decodeToUnicode(Buffer.from(streamData(tu)).toString("latin1"));
    if (cidFont) {
      const w = get(cidFont, "W");
      if (w instanceof PDFArray) {
        for (let i = 0; i < w.size(); ) {
          const first = numberOf(w.lookup(i));
          const second = w.lookup(i + 1);
          if (second instanceof PDFArray) {
            for (let k = 0; k < second.size(); k++) entry.widths.set(first + k, numberOf(second.lookup(k)));
            i += 2;
          } else {
            for (let cid = first; cid <= numberOf(second); cid++) entry.widths.set(cid, numberOf(w.lookup(i + 2)));
            i += 3;
          }
        }
      }
    } else {
      const widths = get(object, "Widths");
      const first = numberOf(get(object, "FirstChar")) ?? 0;
      if (widths instanceof PDFArray) for (let k = 0; k < widths.size(); k++) entry.widths.set(first + k, numberOf(widths.lookup(k)));
    }
    for (const [key, kind] of [["FontFile2", "truetype"], ["FontFile3", "cff"], ["FontFile", "type1"]]) {
      const file = get(descriptor, key);
      if (file instanceof PDFStream) {
        entry.programKind = kind;
        entry.program = streamData(file);
      }
    }
    const procs = get(object, "CharProcs");
    if (procs instanceof PDFDict) entry.charProcs = procs.keys().map((key) => key.decodeText());
    const encoding = get(object, "Encoding");
    const differences = get(encoding, "Differences");
    if (differences instanceof PDFArray) {
      entry.differences = new Map();
      let code = 0;
      for (let i = 0; i < differences.size(); i++) {
        const item = differences.lookup(i);
        if (item instanceof PDFNumber) code = item.asNumber();
        else entry.differences.set(code++, nameOf(item));
      }
    }
    fonts.push(entry);
  }
  return fonts;
}

/** Is any reference of the file still pointing at an object (independent reachability, as in pdfRedactKit.findOrphans)? */
export function referencesTo(doc, target) {
  let count = 0;
  const walk = (value) => {
    if (value instanceof PDFRef) {
      if (value === target) count++;
    } else if (value instanceof PDFDict) for (const child of value.values()) walk(child);
    else if (value instanceof PDFArray) for (const child of value.asArray()) walk(child);
    else if (value instanceof PDFStream) walk(value.dict);
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) walk(object);
  return count;
}

// ---------------------------------------------------------------- PDFs with hand-built fonts
const hexCodes = (codes) => `<${codes.map((code) => code.toString(16).toUpperCase().padStart(2, "0")).join("")}>`;
/** Content that shows each line with the font /TF: lines 24 pt apart from y = 720, x = 60. */
const linesContent = (lines, encode, size) => lines.map((line, index) => `BT /TF ${size} Tf 60 ${720 - index * 24} Td ${hexCodes([...line].map(encode))} Tj ET`).join("\n");

/**
 * A page (or several: `pages` is a list of lists of lines) set in a SIMPLE TrueType font built by hand around a
 * subset of a bundled font, the way producers that are not this editor write them:
 *   style "symbolic"   codes in the order of first use from 33, a (1,0) cmap in format 0 (format 6 with
 *                      `cmap: 6`), no /Encoding, a ToUnicode map (LibreOffice)
 *   style "winansi"    the Windows codes of the characters, /Encoding /WinAnsiEncoding, a Unicode (3,1) cmap in
 *                      format 4, no ToUnicode map (Word)
 * Returns { bytes, codeOf: Map<character, code>, glyphOf: Map<character, glyph>, fontName }.
 */
export async function simpleTrueTypePdf({ pages, style = "symbolic", fontKey = "arimo-regular", size = 14, cmap = 0 }) {
  const text = pages.flat().join("");
  const subset = subsetTrueType(fontKey, text);
  const chars = [...subset.glyphOf.keys()];
  const symbolic = style === "symbolic";
  const codeOf = new Map(chars.map((ch, index) => [ch, symbolic ? 33 + index : ch.charCodeAt(0)]));
  const byCode = new Map(chars.map((ch) => [codeOf.get(ch), subset.glyphOf.get(ch)]));
  const cmapTable = symbolic ? (cmap === 6 ? cmapFormat6(byCode) : cmapFormat0(byCode)) : cmapFormat4(byCode);
  const program = addSfntTable(subset.bytes, "cmap", cmapTable);
  const codes = [...codeOf.values()];
  const first = Math.min(...codes);
  const last = Math.max(...codes);
  const widths = Array.from({ length: last - first + 1 }, (_, k) => {
    const ch = chars.find((c) => codeOf.get(c) === first + k);
    return ch ? subset.advanceOf.get(ch) : 0;
  });
  const fontName = "REDACT+HandBuiltTrueType";
  const { bytes } = await makePdf(pages.map((lines) => ({
    content: linesContent(lines, (ch) => codeOf.get(ch), size),
    resources: (ctx, refs) => ({ Font: { TF: refs.font } })
  })), {
    objects: {
      font: (ctx) => {
        const file = ctx.register(ctx.flateStream(program, { Length1: program.length }));
        const descriptor = ctx.register(ctx.obj({
          Type: "FontDescriptor", FontName: fontName, Flags: symbolic ? 4 : 32, FontBBox: subset.metrics.bbox, ItalicAngle: 0, Ascent: subset.metrics.ascent,
          Descent: subset.metrics.descent, CapHeight: subset.metrics.capHeight, StemV: 80, FontFile2: file
        }));
        const dict = { Type: "Font", Subtype: "TrueType", BaseFont: fontName, FirstChar: first, LastChar: last, Widths: widths, FontDescriptor: descriptor };
        if (symbolic) dict.ToUnicode = ctx.register(ctx.flateStream(Buffer.from(toUnicodeCMap(chars.map((ch) => [codeOf.get(ch), ch])), "latin1")));
        else dict.Encoding = "WinAnsiEncoding";
        return ctx.register(ctx.obj(dict));
      }
    }
  });
  return { bytes, codeOf, glyphOf: subset.glyphOf, fontName };
}

/**
 * Pages set in a simple font with the hand-made CFF program (FontFile3 /Type1C), /Encoding /WinAnsiEncoding
 * (the glyphs are found by their names). Returns { bytes, chars: the characters of the font in glyph order, fontName }.
 */
export async function simpleCffPdf({ pages, size = 14, spareSubrs = 0, encoding = "WinAnsiEncoding" }) {
  const chars = [...new Set([...pages.flat().join("")])];
  const program = makeCffFont({ chars: chars.join(""), spareSubrs });
  const codes = chars.map((ch) => ch.charCodeAt(0));
  const first = Math.min(...codes);
  const last = Math.max(...codes);
  const widths = Array.from({ length: last - first + 1 }, (_, k) => (codes.includes(first + k) ? boxOfChar(String.fromCharCode(first + k)).advance : 0));
  const fontName = "REDACT+RedactBoxes";
  const { bytes } = await makePdf(pages.map((lines) => ({
    content: linesContent(lines, (ch) => ch.charCodeAt(0), size),
    resources: (ctx, refs) => ({ Font: { TF: refs.font } })
  })), {
    objects: {
      font: (ctx) => {
        const file = ctx.register(ctx.flateStream(program, { Subtype: "Type1C" }));
        const descriptor = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: fontName, Flags: 32, FontBBox: [0, -250, 1000, 900], ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80, FontFile3: file }));
        const dict = { Type: "Font", Subtype: "Type1", BaseFont: fontName, FirstChar: first, LastChar: last, Widths: widths, FontDescriptor: descriptor };
        if (encoding) dict.Encoding = encoding;
        return ctx.register(ctx.obj(dict));
      }
    }
  });
  return { bytes, chars, fontName };
}

/**
 * Pages set in a Type3 font: a box per character, drawn by a glyph procedure named g<code>; the glyph of the
 * characters in `pictures` paints an image XObject of the font's own resources instead (a bitmap glyph).
 */
export async function type3Pdf({ pages, size = 14, pictures = "" }) {
  const chars = [...new Set([...pages.flat().join("")])];
  const codes = chars.map((ch) => ch.charCodeAt(0));
  const first = Math.min(...codes);
  const last = Math.max(...codes);
  const { bytes } = await makePdf(pages.map((lines) => ({
    content: linesContent(lines, (ch) => ch.charCodeAt(0), size),
    resources: (ctx, refs) => ({ Font: { TF: refs.font } })
  })), {
    objects: {
      font: (ctx) => {
        const procs = {};
        const images = {};
        for (const ch of chars) {
          const box = boxOfChar(ch);
          const name = `g${ch.charCodeAt(0)}`;
          if (pictures.includes(ch)) {
            images[`Im${ch.charCodeAt(0)}`] = ctx.register(ctx.stream(Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + ch.charCodeAt(0)) & 0xff), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
            procs[name] = ctx.register(ctx.stream(latinBytes(`${box.advance} 0 d0 q ${box.width} 0 0 ${box.height} 50 0 cm /Im${ch.charCodeAt(0)} Do Q`)));
          } else procs[name] = ctx.register(ctx.stream(latinBytes(`${box.advance} 0 50 0 ${50 + box.width} ${box.height} d1 50 0 ${box.width} ${box.height} re f`)));
        }
        const differences = [];
        for (const ch of chars) differences.push(ch.charCodeAt(0), `g${ch.charCodeAt(0)}`);
        return ctx.register(ctx.obj({
          Type: "Font", Subtype: "Type3", Name: "RedactType3", FontBBox: [0, 0, 1000, 900], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: procs, Resources: { XObject: images },
          Encoding: { Type: "Encoding", Differences: differences }, FirstChar: first, LastChar: last,
          Widths: Array.from({ length: last - first + 1 }, (_, k) => (codes.includes(first + k) ? boxOfChar(String.fromCharCode(first + k)).advance : 0)),
          ToUnicode: ctx.register(ctx.flateStream(Buffer.from(toUnicodeCMap(chars.map((ch) => [ch.charCodeAt(0), ch])), "latin1")))
        }));
      }
    }
  });
  return { bytes, chars };
}

/**
 * Pages set in a simple Type1 font whose embedded program (/FontFile) is not a font this engine can edit: the
 * bytes only look like a Type 1 program. pdf.js draws the text with a replacement font and reads it through
 * /WinAnsiEncoding; the dictionary carries the widths of a subset (zero for every code that is not used).
 */
export async function type1Pdf({ pages, size = 14 }) {
  const chars = [...new Set([...pages.flat().join("")])];
  const codes = chars.map((ch) => ch.charCodeAt(0));
  const first = Math.min(...codes);
  const last = Math.max(...codes);
  const program = latinBytes(`%!PS-AdobeFont-1.0: RedactType1 001.000\n/FontName /RedactType1 def\ncurrentfile eexec\n${"0123456789abcdef".repeat(40)}\ncleartomark\n`);
  const fontName = "REDACT+RedactType1";
  const { bytes } = await makePdf(pages.map((lines) => ({
    content: linesContent(lines, (ch) => ch.charCodeAt(0), size),
    resources: (ctx, refs) => ({ Font: { TF: refs.font } })
  })), {
    objects: {
      font: (ctx) => {
        const file = ctx.register(ctx.stream(program, { Length1: 80, Length2: 640, Length3: 12 }));
        const descriptor = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: fontName, Flags: 32, FontBBox: [0, -250, 1000, 900], ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80, FontFile: file }));
        return ctx.register(ctx.obj({
          Type: "Font", Subtype: "Type1", BaseFont: fontName, Encoding: "WinAnsiEncoding", FirstChar: first, LastChar: last, FontDescriptor: descriptor,
          Widths: Array.from({ length: last - first + 1 }, (_, k) => (codes.includes(first + k) ? 520 : 0))
        }));
      }
    }
  });
  return { bytes, fontName };
}

// ---------------------------------------------------------------- pixels
/** The pixels of a rendered page (rotation 0): { data, width, height, viewport }. Needs a canvas. */
export async function pagePixels(bytes, pageIndex = 0, scale = 2) {
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(pageIndex + 1);
    const { ctx, canvas, viewport } = await renderPage(page, { scale, rotation: 0 });
    return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height, viewport };
  } finally {
    await closePdf(doc);
  }
}

/**
 * The largest difference of a colour channel between two renders of the same size, outside the given
 * user-space rectangles (each grown by `margin` pixels). 255 when the sizes differ.
 */
export function pixelDifference(a, b, except = [], margin = 3) {
  if (a.width !== b.width || a.height !== b.height) return 255;
  const skip = except.map((rect) => {
    const [x0, y0] = a.viewport.convertToViewportPoint(rect[0], rect[1]);
    const [x1, y1] = a.viewport.convertToViewportPoint(rect[2], rect[3]);
    return [Math.floor(Math.min(x0, x1)) - margin, Math.floor(Math.min(y0, y1)) - margin, Math.ceil(Math.max(x0, x1)) + margin, Math.ceil(Math.max(y0, y1)) + margin];
  });
  let max = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (skip.some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3])) continue;
      const p = (y * a.width + x) * 4;
      const d = Math.max(Math.abs(a.data[p] - b.data[p]), Math.abs(a.data[p + 1] - b.data[p + 1]), Math.abs(a.data[p + 2] - b.data[p + 2]));
      if (d > max) max = d;
    }
  }
  return max;
}

/** Number of pixels of a render that are not paper white (to prove that a page shows ink at all). */
export function inkPixels(image) {
  let count = 0;
  for (let p = 0; p < image.data.length; p += 4) if (image.data[p] < 200 || image.data[p + 1] < 200 || image.data[p + 2] < 200) count++;
  return count;
}
