// TrueType font programs (FontFile2, and the sfnt wrapper of an OpenType font) as bytes: reading the tables
// the clean-up of fonts needs, and writing a program back in which some glyphs are EMPTY.
//
// WHY. A subset font holds exactly the glyphs that were shown. When a mark removes text, the content streams
// lose the character codes, but the font would keep the outlines (in the order of first use, with most
// producers): the removed text could be read out of the font. fontCleanup.js decides WHICH glyphs nothing in
// the document shows any more; this module makes them empty.
//
//   parseSfnt(bytes)                 -> { version, tables: Map<tag, Uint8Array> }
//   buildSfnt(version, tables)       -> bytes (directory, padding, checksums, head.checkSumAdjustment)
//   readTrueType(bytes)              -> { sfnt, numGlyphs, loca, glyf, hmtx ..., componentsOf(gid), outlined(gid) }
//   glyphClosure(tt, gids)           -> Set of the glyphs and of every glyph they are composed of
//   rewriteTrueType(tt, options)     -> bytes: the listed glyphs have no outline (and no advance, name, cmap entry)
//   parseCmap(table) / buildCmap(subtables)       formats 0, 4, 6 and 12
//   postGlyphNames(table, numGlyphs) -> names of a format 2 "post" table (null for the other formats)
//
// RULES
//   - A glyph is made empty by giving it no bytes at all: the "glyf" table is written again without the record
//     and "loca" is recomputed. Overwriting the record with zeros would keep its LENGTH, and the length of a
//     glyph record names the glyph almost as well as its outline.
//   - A table that can hold data per glyph and that no PDF viewer needs to draw text (device metrics, kerning,
//     layout, the glyph names of a font that is addressed by glyph number) is dropped; a table that draws
//     (colour, bitmap and variation tables) or that is unknown makes the program "not handled": the caller
//     then changes nothing in the font and reports it.
//   - Everything is validated while reading. A table that is too short, offsets that run backwards or outside
//     their table, a count that does not fit: FontProgramError. Nothing here guesses.
//   - The output is checked against the input before it is returned: every glyph that was to stay has the
//     same bytes and the same metrics as before (rewriteTrueType re-reads what it wrote).
// Pure functions on Uint8Array; no library, no DOM.

/** A font program this module does not handle with certainty. The caller reports the font; it never reaches a user as an error. */
export class FontProgramError extends Error {
  constructor(message) {
    super(message);
    this.name = "FontProgramError";
  }
}

const fail = (message) => {
  throw new FontProgramError(message);
};
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const i16 = (b, o) => ((u16(b, o) ^ 0x8000) - 0x8000);
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put16 = (b, o, v) => {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
};
const put32 = (b, o, v) => {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
};
const tagAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565; // "true"
const SFNT_OPENTYPE = 0x4f54544f; // "OTTO"

// ---------------------------------------------------------------- the container
/** The tables of an sfnt file: { version, tables: Map<tag, Uint8Array> } (views into `bytes`, in file order). */
export function parseSfnt(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) fail("not an sfnt font program");
  const version = u32(bytes, 0);
  if (version !== SFNT_TRUETYPE && version !== SFNT_TRUE && version !== SFNT_OPENTYPE) fail("unknown sfnt version (a collection, or not a font)");
  const count = u16(bytes, 4);
  if (count === 0 || count > 256 || 12 + count * 16 > bytes.length) fail("sfnt table directory does not fit");
  const records = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = tagAt(bytes, at);
    const offset = u32(bytes, at + 8);
    const length = u32(bytes, at + 12);
    if (offset + length > bytes.length) fail(`table ${tag.trim()} reaches beyond the font program`);
    records.push({ tag, offset, length });
  }
  records.sort((a, b) => a.offset - b.offset);
  const tables = new Map();
  for (const record of records) {
    if (tables.has(record.tag)) fail(`table ${record.tag.trim()} is listed twice`);
    tables.set(record.tag, bytes.subarray(record.offset, record.offset + record.length));
  }
  return { version, tables };
}

function tableChecksum(data) {
  let sum = 0;
  const whole = data.length & ~3;
  for (let i = 0; i < whole; i += 4) sum = (sum + u32(data, i)) >>> 0;
  if (whole < data.length) {
    let last = 0;
    for (let i = whole; i < data.length; i++) last |= data[i] << (24 - 8 * (i - whole));
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum;
}

/** Writes an sfnt file: directory sorted by tag, tables in the given order padded to four bytes, all checksums. */
export function buildSfnt(version, tables) {
  const tags = [...tables.keys()];
  const count = tags.length;
  const head = tables.get("head");
  let cleanHead = null;
  if (head) {
    if (head.length < 12) fail("head table too short");
    cleanHead = head.slice();
    put32(cleanHead, 8, 0); // checkSumAdjustment is computed over the file with this field at zero
  }
  let offset = 12 + count * 16;
  const placed = new Map();
  for (const tag of tags) {
    const data = tag === "head" ? cleanHead : tables.get(tag);
    placed.set(tag, { offset, data });
    offset += (data.length + 3) & ~3;
  }
  const out = new Uint8Array(offset);
  put32(out, 0, version);
  put16(out, 4, count);
  const power = 2 ** Math.floor(Math.log2(count));
  put16(out, 6, power * 16);
  put16(out, 8, Math.log2(power));
  put16(out, 10, count * 16 - power * 16);
  [...tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).forEach((tag, index) => {
    const { offset: at, data } = placed.get(tag);
    const record = 12 + index * 16;
    for (let k = 0; k < 4; k++) out[record + k] = tag.charCodeAt(k);
    put32(out, record + 4, tableChecksum(data));
    put32(out, record + 8, at);
    put32(out, record + 12, data.length);
    out.set(data, at);
  });
  if (head) put32(out, placed.get("head").offset + 8, (0xb1b0afba - tableChecksum(out)) >>> 0);
  return out;
}

// ---------------------------------------------------------------- TrueType outlines
const ARG_WORDS = 0x0001;
const HAS_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAS_XY_SCALE = 0x0040;
const HAS_TWO_BY_TWO = 0x0080;

/** Tables that are copied as they are: nothing in them belongs to one glyph. */
const PASS_THROUGH = new Set(["cvt ", "fpgm", "prep", "gasp", "name", "OS/2", "VDMX", "STAT", "meta", "PCLT", "FFTM"]);
/**
 * Tables with data per glyph that no PDF viewer needs to draw the glyphs of a font program (advances and
 * positions come from the font dictionary): cached device metrics, kerning, layout, baselines, signatures.
 * They go when a glyph is emptied (a table that was subset with the font would still list the glyph).
 */
const DROPPED = new Set(["hdmx", "LTSH", "kern", "GDEF", "GPOS", "GSUB", "JSTF", "BASE", "MATH", "DSIG", "morx", "mort", "feat", "trak", "prop", "opbd", "lcar", "just", "bsln", "Zapf"]);

/**
 * Reads the tables of a TrueType program that describe its glyphs.
 * Returns { sfnt, numGlyphs, longLoca, loca (Uint32Array of numGlyphs + 1 byte offsets), glyf, numberOfHMetrics,
 *           hmtx (or null), outlined(gid), componentsOf(gid), advanceOf(gid) }.
 */
export function readTrueType(bytes) {
  const sfnt = parseSfnt(bytes);
  if (sfnt.version === SFNT_OPENTYPE) fail("OpenType font with CFF outlines");
  const { tables } = sfnt;
  for (const tag of ["head", "maxp", "loca", "glyf", "hhea"]) if (!tables.has(tag)) fail(`table ${tag} is missing`);
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  const hhea = tables.get("hhea");
  if (head.length < 54 || maxp.length < 6 || hhea.length < 36) fail("head, maxp or hhea too short");
  const numGlyphs = u16(maxp, 4);
  if (numGlyphs === 0) fail("font without glyphs");
  const locaFormat = i16(head, 50);
  if (locaFormat !== 0 && locaFormat !== 1) fail("unknown indexToLocFormat");
  const longLoca = locaFormat === 1;
  const locaTable = tables.get("loca");
  const glyf = tables.get("glyf");
  if (locaTable.length < (numGlyphs + 1) * (longLoca ? 4 : 2)) fail("loca table shorter than the glyph count");
  const loca = new Uint32Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    loca[i] = longLoca ? u32(locaTable, i * 4) : u16(locaTable, i * 2) * 2;
    if (i > 0 && loca[i] < loca[i - 1]) fail("loca offsets run backwards");
  }
  if (loca[numGlyphs] > glyf.length) fail("loca points beyond the glyf table");
  const numberOfHMetrics = u16(hhea, 34);
  let hmtx = tables.get("hmtx") ?? null;
  if (hmtx && (numberOfHMetrics === 0 || numberOfHMetrics > numGlyphs || hmtx.length < numberOfHMetrics * 4 + (numGlyphs - numberOfHMetrics) * 2)) hmtx = null;
  const outlined = (gid) => gid >= 0 && gid < numGlyphs && loca[gid + 1] > loca[gid];
  const componentsOf = (gid) => {
    const out = [];
    if (!outlined(gid)) return out;
    const start = loca[gid];
    const end = loca[gid + 1];
    // (a record shorter than its header draws nothing in any viewer: it has no components either)
    if (end - start < 10 || i16(glyf, start) >= 0) return out; // a simple glyph
    let p = start + 10;
    for (let guard = 0; guard < 4096; guard++) {
      if (p + 4 > end) fail(`composite glyph ${gid} runs out of its record`);
      const flags = u16(glyf, p);
      const component = u16(glyf, p + 2);
      if (component >= numGlyphs) fail(`composite glyph ${gid} refers to a glyph the font does not have`);
      out.push(component);
      p += 4 + (flags & ARG_WORDS ? 4 : 2);
      if (flags & HAS_SCALE) p += 2;
      else if (flags & HAS_XY_SCALE) p += 4;
      else if (flags & HAS_TWO_BY_TWO) p += 8;
      if (!(flags & MORE_COMPONENTS)) return out;
    }
    return fail(`composite glyph ${gid} has no end`);
  };
  const advanceOf = (gid) => (hmtx ? u16(hmtx, Math.min(gid, numberOfHMetrics - 1) * 4) : null);
  return { sfnt, numGlyphs, longLoca, loca, glyf, numberOfHMetrics, hmtx, outlined, componentsOf, advanceOf };
}

/** The glyphs and every glyph they are composed of (composite glyphs refer to other glyphs by number). */
export function glyphClosure(tt, gids) {
  const seen = new Set();
  const stack = [];
  for (const gid of gids) if (Number.isInteger(gid) && gid >= 0 && gid < tt.numGlyphs) stack.push(gid);
  while (stack.length) {
    const gid = stack.pop();
    if (seen.has(gid)) continue;
    seen.add(gid);
    for (const component of tt.componentsOf(gid)) if (!seen.has(component)) stack.push(component);
    if (seen.size > tt.numGlyphs) fail("composite glyphs refer to each other without end");
  }
  return seen;
}

/**
 * The program again, with the glyphs of `blank` empty.
 *   blank         Set of glyph numbers (glyph 0 is never emptied; a glyph that is empty already is skipped)
 *   zeroAdvance   also set the advance width and side bearing of those glyphs to zero in hmtx (and vmtx)
 *   cmap          "keep" | "drop" | Uint8Array: the cmap table as it is, none (a font addressed by glyph number
 *                 needs none), or a rebuilt one (buildCmap)
 *   post          "keep" | "strip" (a format 3 table: no glyph names) | Uint8Array (a rebuilt table)
 * Returns { bytes, blanked: number of glyphs that were emptied, dropped: tags of the tables left out }.
 * Throws FontProgramError when the program holds a table this module does not know how to treat.
 */
export function rewriteTrueType(tt, { blank, zeroAdvance = false, cmap = "keep", post = "keep" }) {
  const { sfnt, numGlyphs, loca, glyf, longLoca } = tt;
  const doomed = [];
  for (const gid of blank) if (gid > 0 && tt.outlined(gid)) doomed.push(gid);
  const isDoomed = new Uint8Array(numGlyphs);
  for (const gid of doomed) isDoomed[gid] = 1;
  // ---- glyf and loca
  let size = 0;
  for (let gid = 0; gid < numGlyphs; gid++) if (!isDoomed[gid]) size += loca[gid + 1] - loca[gid];
  const newGlyf = new Uint8Array((size + 3) & ~3);
  const newLoca = new Uint32Array(numGlyphs + 1);
  let at = 0;
  for (let gid = 0; gid < numGlyphs; gid++) {
    newLoca[gid] = at;
    if (isDoomed[gid]) continue;
    const length = loca[gid + 1] - loca[gid];
    newGlyf.set(glyf.subarray(loca[gid], loca[gid + 1]), at);
    at += length;
  }
  newLoca[numGlyphs] = at;
  const locaBytes = new Uint8Array((numGlyphs + 1) * (longLoca ? 4 : 2));
  for (let i = 0; i <= numGlyphs; i++) {
    if (longLoca) put32(locaBytes, i * 4, newLoca[i]);
    else {
      if (newLoca[i] % 2 !== 0) fail("a glyph record of odd length in a font with short offsets");
      put16(locaBytes, i * 2, newLoca[i] / 2);
    }
  }
  // ---- metrics
  const metrics = (tag, countTag, countOffset) => {
    const table = sfnt.tables.get(tag);
    const header = sfnt.tables.get(countTag);
    if (!table || !zeroAdvance || !header || header.length < countOffset + 2) return table;
    const long = u16(header, countOffset);
    if (long === 0 || long > numGlyphs || table.length < long * 4 + (numGlyphs - long) * 2) return table;
    const copy = table.slice();
    for (const gid of doomed) {
      // the advance of the last long record is also the advance of every glyph after it: it stays unless
      // the record is the last glyph of the font. The side bearing is the glyph's own.
      if (gid < long - 1 || (gid === long - 1 && long === numGlyphs)) put32(copy, gid * 4, 0);
      else if (gid === long - 1) put16(copy, gid * 4 + 2, 0);
      else put16(copy, long * 4 + (gid - long) * 2, 0);
    }
    return copy;
  };
  // ---- the tables of the output
  const out = new Map();
  const dropped = [];
  for (const [tag, data] of sfnt.tables) {
    if (tag === "glyf") out.set(tag, newGlyf.subarray(0, at));
    else if (tag === "loca") out.set(tag, locaBytes);
    else if (tag === "head" || tag === "hhea" || tag === "maxp" || tag === "vhea") out.set(tag, data);
    else if (tag === "hmtx") out.set(tag, metrics("hmtx", "hhea", 34));
    else if (tag === "vmtx") out.set(tag, metrics("vmtx", "vhea", 34));
    else if (tag === "cmap") {
      if (cmap === "keep") out.set(tag, data);
      else if (cmap === "drop") dropped.push(tag);
      else out.set(tag, cmap);
    } else if (tag === "post") {
      if (post === "keep") out.set(tag, data);
      else if (post === "strip") out.set(tag, stripPostNames(data));
      else out.set(tag, post);
    } else if (PASS_THROUGH.has(tag)) out.set(tag, data);
    else if (DROPPED.has(tag)) dropped.push(tag);
    else fail(`table ${tag.trim()} is not known: it may hold data of the glyphs`);
  }
  const bytes = buildSfnt(sfnt.version, out);
  // ---- what was written is read back: every glyph that stays is byte for byte what it was
  const check = readTrueType(bytes);
  if (check.numGlyphs !== numGlyphs) fail("self-check: glyph count changed");
  for (let gid = 0; gid < numGlyphs; gid++) {
    const before = isDoomed[gid] ? 0 : loca[gid + 1] - loca[gid];
    const after = check.loca[gid + 1] - check.loca[gid];
    if (before !== after) fail(`self-check: glyph ${gid} changed its length`);
    for (let k = 0; k < before; k++) if (glyf[loca[gid] + k] !== check.glyf[check.loca[gid] + k]) fail(`self-check: glyph ${gid} changed`);
    if (!isDoomed[gid] && tt.hmtx && check.advanceOf(gid) !== tt.advanceOf(gid)) fail(`self-check: the advance of glyph ${gid} changed`);
  }
  return { bytes, blanked: doomed.length, dropped };
}

// ---------------------------------------------------------------- post: glyph names
const POST_STANDARD_NAMES = 258;

/**
 * The glyph names of a format 2 "post" table: an array of numGlyphs entries, each a string (a name the table
 * spells out) or a number (the index of one of the 258 standard Macintosh names). null for every other format.
 */
export function postGlyphNames(table, numGlyphs) {
  if (!table || table.length < 34 || u32(table, 0) !== 0x00020000) return null;
  const count = u16(table, 32);
  if (count !== numGlyphs || table.length < 34 + count * 2) fail("post table does not fit the glyph count");
  const strings = [];
  for (let p = 34 + count * 2; p < table.length; ) {
    const length = table[p];
    if (p + 1 + length > table.length) fail("post table: a glyph name runs out of the table");
    let name = "";
    for (let k = 0; k < length; k++) name += String.fromCharCode(table[p + 1 + k]);
    strings.push(name);
    p += 1 + length;
  }
  const names = new Array(count);
  for (let gid = 0; gid < count; gid++) {
    const index = u16(table, 34 + gid * 2);
    if (index < POST_STANDARD_NAMES) names[gid] = index;
    else if (index - POST_STANDARD_NAMES < strings.length) names[gid] = strings[index - POST_STANDARD_NAMES];
    else fail("post table: a glyph name index points nowhere");
  }
  return names;
}

/** A format 2 "post" table again in which the glyphs of `blank` are called ".notdef" (and their names are gone). */
export function renamePostGlyphs(table, numGlyphs, blank) {
  const names = postGlyphNames(table, numGlyphs);
  if (!names) return table;
  const strings = [];
  const indexOf = new Map();
  const indexes = names.map((name, gid) => {
    if (blank.has(gid)) return 0;
    if (typeof name === "number") return name;
    if (!indexOf.has(name)) {
      indexOf.set(name, POST_STANDARD_NAMES + strings.length);
      strings.push(name);
    }
    return indexOf.get(name);
  });
  const size = 34 + numGlyphs * 2 + strings.reduce((sum, name) => sum + 1 + name.length, 0);
  const out = new Uint8Array(size);
  out.set(table.subarray(0, 34));
  let p = 34;
  for (const index of indexes) {
    put16(out, p, index);
    p += 2;
  }
  for (const name of strings) {
    out[p++] = name.length;
    for (let k = 0; k < name.length; k++) out[p++] = name.charCodeAt(k) & 0xff;
  }
  return out;
}

/** The header of a "post" table as format 3: the font keeps its italic angle and underline, and has no glyph names. */
function stripPostNames(table) {
  if (table.length < 32) return table;
  const out = table.slice(0, 32);
  put32(out, 0, 0x00030000);
  return out;
}

// ---------------------------------------------------------------- cmap
const MAX_CMAP_MAPPINGS = 400000;

/**
 * Reads a cmap table: [{ platform, encoding, format, language, offset, map }] with map = Map<code, glyph> for
 * the formats 0, 4, 6 and 12 (codes that map to glyph 0 are left out) and map = null for every other format.
 * Two records that point at the same subtable share one `map` object and one `offset`.
 */
export function parseCmap(table) {
  if (!table || table.length < 4) fail("cmap table too short");
  const count = u16(table, 2);
  if (4 + count * 8 > table.length) fail("cmap directory does not fit");
  const byOffset = new Map();
  const subtables = [];
  for (let i = 0; i < count; i++) {
    const record = 4 + i * 8;
    const offset = u32(table, record + 4);
    if (offset + 4 > table.length) fail("cmap subtable outside the table");
    if (!byOffset.has(offset)) byOffset.set(offset, readCmapSubtable(table, offset));
    subtables.push({ platform: u16(table, record), encoding: u16(table, record + 2), offset, ...byOffset.get(offset) });
  }
  return subtables;
}

function readCmapSubtable(t, o) {
  const format = u16(t, o);
  const map = new Map();
  const add = (code, glyph) => {
    if (glyph === 0) return;
    if (map.size >= MAX_CMAP_MAPPINGS) fail("cmap subtable with too many mappings");
    map.set(code, glyph);
  };
  if (format === 0) {
    if (o + 262 > t.length) fail("cmap format 0 too short");
    for (let code = 0; code < 256; code++) add(code, t[o + 6 + code]);
    return { format, language: u16(t, o + 4), map };
  }
  if (format === 6) {
    if (o + 10 > t.length) fail("cmap format 6 too short");
    const first = u16(t, o + 6);
    const entries = u16(t, o + 8);
    if (o + 10 + entries * 2 > t.length) fail("cmap format 6 runs out of the table");
    for (let k = 0; k < entries; k++) add(first + k, u16(t, o + 10 + k * 2));
    return { format, language: u16(t, o + 4), map };
  }
  if (format === 4) {
    if (o + 14 > t.length) fail("cmap format 4 too short");
    const length = u16(t, o + 2);
    const segments = u16(t, o + 6) / 2;
    if (!Number.isInteger(segments) || segments === 0) fail("cmap format 4 with an odd segment count");
    const ends = o + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    // (the glyph array may run past the stated length in fonts whose length field overflowed 16 bits)
    const limit = Math.min(t.length, Math.max(o + length, ranges + segments * 2));
    if (ranges + segments * 2 > t.length) fail("cmap format 4 arrays run out of the table");
    for (let s = 0; s < segments; s++) {
      const end = u16(t, ends + s * 2);
      const start = u16(t, starts + s * 2);
      const delta = u16(t, deltas + s * 2);
      const rangeOffset = u16(t, ranges + s * 2);
      if (start > end) continue;
      for (let code = start; code <= end; code++) {
        if (code === 0xffff && rangeOffset === 0 && ((code + delta) & 0xffff) === 0) continue;
        let glyph;
        if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
        else {
          const at = ranges + s * 2 + rangeOffset + (code - start) * 2;
          if (at + 2 > limit) continue; // a segment that points outside its table maps to nothing
          glyph = u16(t, at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        add(code, glyph);
      }
    }
    return { format, language: u16(t, o + 4), map };
  }
  if (format === 12) {
    if (o + 16 > t.length) fail("cmap format 12 too short");
    const groups = u32(t, o + 12);
    if (o + 16 + groups * 12 > t.length) fail("cmap format 12 groups run out of the table");
    for (let g = 0; g < groups; g++) {
      const at = o + 16 + g * 12;
      const start = u32(t, at);
      const end = u32(t, at + 4);
      const glyph = u32(t, at + 8);
      if (end < start || end > 0x10ffff) fail("cmap format 12 group out of order");
      for (let code = start; code <= end; code++) add(code, glyph + (code - start));
    }
    return { format, language: u32(t, o + 8), map };
  }
  return { format, language: 0, map: null };
}

function writeCmapSubtable({ format, language, map }) {
  const codes = [...map.keys()].filter((code) => map.get(code) !== 0).sort((a, b) => a - b);
  if (format === 0) {
    const out = new Uint8Array(262);
    put16(out, 0, 0);
    put16(out, 2, 262);
    put16(out, 4, language);
    for (const code of codes) {
      if (code > 255 || map.get(code) > 255) fail("cmap format 0 cannot hold this mapping");
      out[6 + code] = map.get(code);
    }
    return out;
  }
  if (format === 6) {
    const first = codes.length ? codes[0] : 0;
    const entries = codes.length ? codes[codes.length - 1] - first + 1 : 0;
    if (entries > 0xffff || first > 0xffff) fail("cmap format 6 cannot hold this mapping");
    const out = new Uint8Array(10 + entries * 2);
    put16(out, 0, 6);
    put16(out, 2, out.length);
    put16(out, 4, language);
    put16(out, 6, first);
    put16(out, 8, entries);
    for (const code of codes) put16(out, 10 + (code - first) * 2, map.get(code));
    return out;
  }
  // runs of consecutive codes that map to consecutive glyphs
  const runs = [];
  for (const code of codes) {
    const glyph = map.get(code);
    const last = runs[runs.length - 1];
    if (last && code === last.end + 1 && glyph === last.glyph + (code - last.start)) last.end = code;
    else runs.push({ start: code, end: code, glyph });
  }
  if (format === 12) {
    const out = new Uint8Array(16 + runs.length * 12);
    put16(out, 0, 12);
    put32(out, 4, out.length);
    put32(out, 8, language);
    put32(out, 12, runs.length);
    runs.forEach((run, index) => {
      put32(out, 16 + index * 12, run.start);
      put32(out, 20 + index * 12, run.end);
      put32(out, 24 + index * 12, run.glyph);
    });
    return out;
  }
  if (format === 4) {
    if (codes.length && codes[codes.length - 1] > 0xffff) fail("cmap format 4 cannot hold codes above 0xFFFF");
    // the table ends with a segment for 0xFFFF; when the font maps that code itself, its own segment is the end
    const segments = runs.map((run) => ({ start: run.start, end: run.end, delta: (run.glyph - run.start) & 0xffff }));
    if (!segments.length || segments[segments.length - 1].end !== 0xffff) segments.push({ start: 0xffff, end: 0xffff, delta: 1 });
    const n = segments.length;
    const length = 16 + n * 8;
    if (length > 0xffff) fail("cmap format 4 would be too long");
    const out = new Uint8Array(length);
    const power = 2 ** Math.floor(Math.log2(n));
    put16(out, 0, 4);
    put16(out, 2, length);
    put16(out, 4, language);
    put16(out, 6, n * 2);
    put16(out, 8, power * 2);
    put16(out, 10, Math.log2(power));
    put16(out, 12, n * 2 - power * 2);
    segments.forEach((segment, index) => {
      put16(out, 14 + index * 2, segment.end);
      put16(out, 16 + n * 2 + index * 2, segment.start);
      put16(out, 16 + n * 4 + index * 2, segment.delta);
      // (idRangeOffset stays zero: every segment maps by its delta)
    });
    return out;
  }
  return fail(`cmap format ${format} cannot be written`);
}

/**
 * Writes a cmap table from subtables as parseCmap() returns them (every one needs a `map` and one of the
 * formats 0, 4, 6, 12). Records that shared a subtable (same `offset`) share it again.
 */
export function buildCmap(subtables) {
  const records = [...subtables].sort((a, b) => a.platform - b.platform || a.encoding - b.encoding);
  const bodies = new Map(); // original offset -> bytes
  for (const sub of records) {
    if (!sub.map) fail(`cmap format ${sub.format} cannot be written`);
    if (!bodies.has(sub.offset)) bodies.set(sub.offset, writeCmapSubtable(sub));
  }
  let size = 4 + records.length * 8;
  const place = new Map();
  for (const [offset, body] of bodies) {
    place.set(offset, size);
    size += (body.length + 1) & ~1;
  }
  const out = new Uint8Array(size);
  put16(out, 2, records.length);
  records.forEach((sub, index) => {
    put16(out, 4 + index * 8, sub.platform);
    put16(out, 6 + index * 8, sub.encoding);
    put32(out, 8 + index * 8, place.get(sub.offset));
  });
  for (const [offset, body] of bodies) out.set(body, place.get(offset));
  return out;
}
