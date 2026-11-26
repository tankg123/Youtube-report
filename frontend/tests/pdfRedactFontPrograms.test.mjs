// fontPrograms.js and cffProgram.js: the font programs a redaction has to edit so that a subset font does not
// keep the glyphs of removed text (review defect 1). Every program here is generated (a subset cut from a
// bundled font, a box font drawn by the test kit); what the engine wrote is read back with decoders of the
// test kit that share no code with it, and with fontkit.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { FRONTEND_ROOT, fontBytes, fontkit, pdfLib } from "./helpers/pdfTestKit.mjs";
import {
  addSfntTable, boxOfChar, cffGlyphs, cmapFormat0, cmapFormat4, cmapFormat6, fontsOf, makeCffFont, makeOtfFont, readSfnt, subsetTrueType, trueTypeOutlines
} from "./helpers/pdfRedactFontKit.mjs";
import {
  FontProgramError, buildCmap, buildSfnt, glyphClosure, parseCmap, parseSfnt, postGlyphNames, readTrueType, renamePostGlyphs, rewriteTrueType
} from "../src/pages/pdfEditor/engine/redact/fontPrograms.js";
import { isEmptyCharstring, readCff, rewriteCff } from "../src/pages/pdfEditor/engine/redact/cffProgram.js";
import { CFF_STANDARD_STRINGS } from "../src/pages/pdfEditor/engine/redact/cffStrings.js";

const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const refused = (fn) => assert.throws(fn, (error) => error instanceof FontProgramError, "expected a FontProgramError");

/** The bytes of every glyph record of a TrueType program (independent of the engine): Map<glyph, hex>. */
function glyphRecords(bytes) {
  const { tables } = readSfnt(bytes);
  const long = u16(tables.get("head"), 50) === 1;
  const loca = tables.get("loca");
  const glyf = tables.get("glyf");
  const at = (i) => (long ? u32(loca, i * 4) : u16(loca, i * 2) * 2);
  const out = new Map();
  for (let glyph = 0; glyph < u16(tables.get("maxp"), 4); glyph++) out.set(glyph, hex(glyf.subarray(at(glyph), at(glyph + 1))));
  return out;
}
const advances = (bytes) => {
  const { tables } = readSfnt(bytes);
  const count = u16(tables.get("hhea"), 34);
  return Array.from({ length: u16(tables.get("maxp"), 4) }, (_, glyph) => u16(tables.get("hmtx"), Math.min(glyph, count - 1) * 4));
};
/** The sum of all 32-bit words of a font file: 0xB1B0AFBA when head.checkSumAdjustment is right. */
function fileChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + u32(bytes, i)) >>> 0;
  return sum;
}

test("the table of CFF standard strings is the one of the installed pdf.js", () => {
  // what Adobe Technical Note 5176 (Appendix A) says about a few identifiers, checked by hand ...
  assert.equal(CFF_STANDARD_STRINGS.length, 391);
  for (const [sid, name] of [[0, ".notdef"], [1, "space"], [14, "hyphen"], [17, "zero"], [26, "nine"], [27, "colon"], [34, "A"], [59, "Z"], [66, "a"], [91, "z"], [390, "Semibold"]]) assert.equal(CFF_STANDARD_STRINGS[sid], name, `SID ${sid}`);
  // ... and the whole table against the one pdf.js reads fonts with
  const root = path.dirname(createRequire(path.join(FRONTEND_ROOT, "package.json")).resolve("pdfjs-dist/package.json"));
  const worker = fs.readFileSync(path.join(root, "legacy/build/pdf.worker.mjs"), "utf8");
  const match = /const CFFStandardStrings = (\[[^\]]*\]);/.exec(worker);
  assert.ok(match, "this pdf.js build does not carry the table under the known name: compare cffStrings.js by hand");
  assert.deepEqual([...CFF_STANDARD_STRINGS], JSON.parse(match[1]));
});

test("sfnt: a program is written back with a valid directory and checksums; damaged containers are refused", () => {
  const subset = subsetTrueType("arimo-regular", "Redaction 0123");
  const font = parseSfnt(subset.bytes);
  assert.ok([0x00010000, 0x74727565].includes(font.version), "a TrueType program (version 1.0 or 'true')");
  for (const tag of ["glyf", "loca", "head", "hhea", "hmtx", "maxp"]) assert.ok(font.tables.has(tag), tag);
  const rebuilt = buildSfnt(font.version, font.tables);
  assert.equal(fileChecksum(rebuilt), 0xb1b0afba, "head.checkSumAdjustment");
  const again = readSfnt(rebuilt);
  assert.deepEqual([...again.tables.keys()].sort(), [...font.tables.keys()].sort());
  for (const [tag, data] of font.tables) if (tag !== "head") assert.equal(hex(again.tables.get(tag)), hex(data), tag);
  // the directory is sorted by tag and every offset is a multiple of four
  const tags = Array.from({ length: u16(rebuilt, 4) }, (_, i) => String.fromCharCode(...rebuilt.subarray(12 + i * 16, 16 + i * 16)));
  assert.deepEqual(tags, [...tags].sort());
  for (let i = 0; i < tags.length; i++) assert.equal(u32(rebuilt, 12 + i * 16 + 8) % 4, 0);
  assert.ok(fontkit.create(Buffer.from(rebuilt)).numGlyphs > 5, "fontkit reads the program");
  // nothing is guessed
  refused(() => parseSfnt(subset.bytes.subarray(0, 40)));
  refused(() => parseSfnt(Uint8Array.from([...be32(0x74746366), ...subset.bytes.subarray(4)]))); // a collection ("ttcf")
  const beyond = subset.bytes.slice();
  beyond.set(be32(subset.bytes.length), 12 + 12); // the length of the first table reaches out of the file
  refused(() => parseSfnt(beyond));
  const twice = subset.bytes.slice();
  twice.set(twice.subarray(12, 16), 28); // the second record gets the tag of the first
  refused(() => parseSfnt(twice));
  refused(() => parseSfnt("not bytes"));
});

test("TrueType: an emptied glyph leaves no byte behind, every other glyph is what it was", () => {
  const text = "Account 0947-315-268 Zurich";
  const subset = subsetTrueType("arimo-regular", text);
  const tt = readTrueType(subset.bytes);
  assert.equal(tt.numGlyphs, new Set(text).size + 1);
  const secret = [...new Set("0947315268")].filter((ch) => !"Account Zurich-".includes(ch));
  const blank = new Set(secret.map((ch) => subset.glyphOf.get(ch)));
  const before = glyphRecords(subset.bytes);
  const beforeOutlines = trueTypeOutlines(subset.bytes);
  for (const zeroAdvance of [false, true]) {
    const out = rewriteTrueType(tt, { blank, zeroAdvance });
    assert.equal(out.blanked, blank.size);
    const after = glyphRecords(out.bytes);
    const afterOutlines = trueTypeOutlines(out.bytes);
    assert.equal(afterOutlines.numGlyphs, beforeOutlines.numGlyphs, "glyph numbers must not move: the content streams address glyphs by number");
    for (const [glyph, record] of before) assert.equal(after.get(glyph), blank.has(glyph) ? "" : record, `glyph ${glyph}`);
    // the table shrank by exactly the records that went: a record of zeros would keep the LENGTH of the glyph
    const gone = [...blank].reduce((sum, glyph) => sum + beforeOutlines.outlines.get(glyph), 0);
    const glyfLength = (bytes) => [...trueTypeOutlines(bytes).outlines.values()].reduce((sum, length) => sum + length, 0);
    assert.equal(glyfLength(out.bytes), glyfLength(subset.bytes) - gone);
    assert.ok(readSfnt(out.bytes).tables.get("glyf").length <= readSfnt(subset.bytes).tables.get("glyf").length - gone + 3);
    // metrics: untouched without zeroAdvance, zero for the emptied glyphs with it
    advances(subset.bytes).forEach((advance, glyph) => assert.equal(advances(out.bytes)[glyph], zeroAdvance && blank.has(glyph) ? 0 : advance, `advance of glyph ${glyph}`));
    assert.equal(fileChecksum(out.bytes), 0xb1b0afba);
    // a second reader agrees: fontkit draws the kept glyphs as before and nothing for the emptied ones
    const was = fontkit.create(Buffer.from(subset.bytes));
    const now = fontkit.create(Buffer.from(out.bytes));
    for (let glyph = 1; glyph < tt.numGlyphs; glyph++) {
      const path = now.getGlyph(glyph).path.toSVG();
      if (blank.has(glyph)) assert.equal(path, "", `glyph ${glyph} still draws`);
      else assert.equal(path, was.getGlyph(glyph).path.toSVG(), `glyph ${glyph} changed`);
    }
  }
  // glyph 0 and glyphs that are empty already are not counted, numbers outside the font are ignored
  const space = subset.glyphOf.get(" ");
  assert.equal(tt.outlined(space), false);
  assert.equal(rewriteTrueType(tt, { blank: new Set([0, space, 9999]) }).blanked, 0);
  assert.equal(glyphRecords(rewriteTrueType(tt, { blank: new Set([0]) }).bytes).get(0), before.get(0));
  // a damaged program is refused: offsets of the glyph table that run backwards
  const { tables } = readSfnt(subset.bytes);
  const loca = tables.get("loca").slice();
  const long = u16(tables.get("head"), 50) === 1;
  if (long) loca.set(be32(u32(loca, 12) + 400), 8);
  else loca.set(be16(u16(loca, 6) + 200), 4);
  refused(() => readTrueType(addSfntTable(subset.bytes, "loca", loca)));
  refused(() => readTrueType(addSfntTable(subset.bytes, "maxp", Uint8Array.from([...be32(0x00010000), ...be16(999), ...new Array(26).fill(0)]))));
});

test("TrueType: a composite glyph names its components, and the closure of a glyph holds them", () => {
  const subset = subsetTrueType("arimo-regular", "Nguyễn Thị Hương ế ở");
  const tt = readTrueType(subset.bytes);
  const composites = [];
  for (let glyph = 1; glyph < tt.numGlyphs; glyph++) if (tt.componentsOf(glyph).length) composites.push(glyph);
  assert.ok(composites.length > 0, "fixture: the subset of accented letters holds composite glyphs");
  for (const glyph of composites) {
    const closure = glyphClosure(tt, [glyph]);
    assert.ok(closure.has(glyph));
    for (const component of tt.componentsOf(glyph)) {
      assert.ok(component > 0 && component < tt.numGlyphs && closure.has(component), `component ${component} of glyph ${glyph}`);
      assert.ok(tt.outlined(component) || tt.componentsOf(component).length === 0);
    }
  }
  // fontkit put the components behind the glyphs of the text: more glyphs than characters
  assert.ok(tt.numGlyphs > subset.glyphOf.size + 1);
  assert.deepEqual([...glyphClosure(tt, [0, -1, 1e6, 1.5])], [0], "numbers that are no glyphs of the font are ignored");
  // emptying a composite keeps the glyphs it was made of (they may be letters of their own)
  const composite = composites[0];
  const out = rewriteTrueType(tt, { blank: new Set([composite]) });
  const after = glyphRecords(out.bytes);
  assert.equal(after.get(composite), "");
  for (const component of tt.componentsOf(composite)) assert.equal(after.get(component), glyphRecords(subset.bytes).get(component));
});

test("TrueType: tables with data per glyph that no viewer needs are dropped, tables that cannot be judged refuse the rewrite", () => {
  const subset = subsetTrueType("arimo-regular", "Redaction 0123");
  const blank = new Set([subset.glyphOf.get("0")]);
  const withKern = addSfntTable(addSfntTable(subset.bytes, "kern", Uint8Array.from([0, 0, 0, 0, 1, 2, 3, 4])), "name", Uint8Array.from([0, 0, 0, 0, 0, 6]));
  const out = rewriteTrueType(readTrueType(withKern), { blank });
  assert.deepEqual(out.dropped, ["kern"]);
  const tables = readSfnt(out.bytes).tables;
  assert.equal(tables.has("kern"), false);
  assert.equal(hex(tables.get("name")), "000000000006", "a table without data per glyph is copied");
  // colour, bitmap, variation tables draw; an unknown table may do anything: nothing is changed then
  for (const tag of ["COLR", "sbix", "gvar", "zzzz"]) refused(() => rewriteTrueType(readTrueType(addSfntTable(subset.bytes, tag, Uint8Array.from([1, 2, 3, 4]))), { blank }));
  // an OpenType font with CFF outlines is not a TrueType program
  refused(() => readTrueType(makeOtfFont({ chars: "AB" })));
  // the cmap and post of the caller are written as given, or left out
  const cmap = cmapFormat4(new Map([[65, 1], [66, 2]]));
  const kept = rewriteTrueType(readTrueType(addSfntTable(subset.bytes, "cmap", cmap)), { blank, cmap: "keep" });
  assert.equal(hex(readSfnt(kept.bytes).tables.get("cmap")), hex(cmap));
  const dropped = rewriteTrueType(readTrueType(addSfntTable(subset.bytes, "cmap", cmap)), { blank, cmap: "drop" });
  assert.equal(readSfnt(dropped.bytes).tables.has("cmap"), false);
  const replaced = rewriteTrueType(readTrueType(addSfntTable(subset.bytes, "cmap", cmap)), { blank, cmap: cmapFormat4(new Map([[66, 2]])) });
  assert.deepEqual([...parseCmap(readSfnt(replaced.bytes).tables.get("cmap"))[0].map], [[66, 2]]);
});

test("cmap: formats 0, 4, 6 and 12 are read and written back; other formats are not guessed", () => {
  const map = new Map([[33, 1], [34, 2], [36, 7], [120, 3]]);
  const format12 = (groups) => Uint8Array.from([...be16(0), ...be16(1), ...be16(3), ...be16(10), ...be32(12), ...be16(12), ...be16(0), ...be32(16 + groups.length * 12), ...be32(0), ...be32(groups.length), ...groups.flatMap(([start, end, glyph]) => [...be32(start), ...be32(end), ...be32(glyph)])]);
  const cases = [
    [0, cmapFormat0(map), map, [1, 0]],
    [4, cmapFormat4(map), map, [3, 1]],
    [6, cmapFormat6(map), map, [1, 0]],
    [12, format12([[0x41, 0x43, 5], [0x1f600, 0x1f601, 9]]), new Map([[0x41, 5], [0x42, 6], [0x43, 7], [0x1f600, 9], [0x1f601, 10]]), [3, 10]]
  ];
  for (const [format, table, expected, [platform, encoding]] of cases) {
    const read = parseCmap(table);
    assert.deepEqual(read.map((sub) => [sub.platform, sub.encoding, sub.format]), [[platform, encoding, format]]);
    assert.deepEqual([...read[0].map].sort((a, b) => a[0] - b[0]), [...expected].sort((a, b) => a[0] - b[0]), `format ${format}`);
    // without one mapping, written and read again
    const [dropCode] = [...expected.keys()];
    const written = buildCmap(read.map((sub) => ({ ...sub, map: new Map([...sub.map].filter(([code]) => code !== dropCode)) })));
    const again = parseCmap(written);
    assert.deepEqual(again.map((sub) => [sub.platform, sub.encoding, sub.format]), [[platform, encoding, format]]);
    assert.deepEqual([...again[0].map].sort((a, b) => a[0] - b[0]), [...expected].filter(([code]) => code !== dropCode).sort((a, b) => a[0] - b[0]), `format ${format} rewritten`);
  }
  // two records that share a subtable share it again
  const shared = cmapFormat4(map);
  const two = Uint8Array.from([...be16(0), ...be16(2), ...be16(0), ...be16(3), ...be32(20), ...be16(3), ...be16(1), ...be32(20), ...shared.subarray(12)]);
  const read = parseCmap(two);
  assert.equal(read.length, 2);
  assert.equal(read[0].map, read[1].map);
  const rewritten = parseCmap(buildCmap(read));
  assert.deepEqual(rewritten.map((sub) => [sub.platform, sub.encoding]), [[0, 3], [3, 1]]);
  assert.equal(rewritten[0].offset, rewritten[1].offset);
  // a format this module does not read (14: variation sequences) has no map, and cannot be written
  const odd = Uint8Array.from([...be16(0), ...be16(1), ...be16(0), ...be16(5), ...be32(12), ...be16(14), ...be32(10), ...be32(0)]);
  assert.deepEqual(parseCmap(odd).map((sub) => [sub.format, sub.map]), [[14, null]]);
  refused(() => buildCmap(parseCmap(odd)));
  refused(() => parseCmap(Uint8Array.from([0, 0, 0, 9, 0, 0])));
  refused(() => parseCmap(cmapFormat4(map).subarray(0, 30)));
});

test("post: a format 2 table gives its names, and a renamed glyph leaves no name behind", () => {
  const pascal = (name) => [name.length, ...Buffer.from(name, "latin1")];
  const header = [...be32(0x00020000), ...new Array(28).fill(0)];
  const table = Uint8Array.from([...header, ...be16(4), ...be16(0), ...be16(258), ...be16(259), ...be16(36), ...pascal("secretglyph"), ...pascal("keptglyph")]);
  assert.deepEqual(postGlyphNames(table, 4), [0, "secretglyph", "keptglyph", 36]);
  const renamed = renamePostGlyphs(table, 4, new Set([1, 3]));
  assert.deepEqual(postGlyphNames(renamed, 4), [0, 0, "keptglyph", 0]);
  assert.ok(!Buffer.from(renamed).toString("latin1").includes("secretglyph"));
  // other formats carry no names
  assert.equal(postGlyphNames(Uint8Array.from([...be32(0x00030000), ...new Array(28).fill(0)]), 4), null);
  assert.equal(postGlyphNames(undefined, 4), null);
  refused(() => postGlyphNames(table, 5));
  refused(() => postGlyphNames(Uint8Array.from([...header, ...be16(1), ...be16(300)]), 1));
});

test("CFF: a removed glyph leaves nothing behind: charstring, name, code and the subroutines only it called", () => {
  const chars = "ABCDEFGH 0123";
  const program = makeCffFont({ chars });
  const cff = readCff(program);
  assert.equal(cff.nGlyphs, chars.length + 1);
  assert.equal(cff.isCID, false);
  [...chars].forEach((ch, index) => {
    const name = ch === " " ? "space" : /\d/.test(ch) ? ["zero", "one", "two", "three"][Number(ch)] : ch;
    assert.equal(cff.glyphOfName.get(name), index + 1, name);
    assert.equal(cff.nameOf(index + 1), name);
    assert.equal(cff.encoding.codes.get(ch.charCodeAt(0)), index + 1);
  });
  // the glyphs of the digits go
  const remove = new Set([..."0123"].map((ch) => chars.indexOf(ch) + 1));
  const out = rewriteCff(cff, { remove });
  assert.equal(out.removed, 4);
  const before = cffGlyphs(program);
  const after = cffGlyphs(out.bytes);
  assert.equal(after.count, before.count - 4);
  const keptGlyphs = Array.from({ length: before.count }, (_, glyph) => glyph).filter((glyph) => !remove.has(glyph));
  assert.deepEqual(after.charStrings.map(hex), keptGlyphs.map((glyph) => hex(before.charStrings[glyph])), "the charstrings that stay");
  assert.deepEqual(after.charset, keptGlyphs.map((glyph) => before.charset[glyph]), "the names that stay");
  for (const sid of [17, 18, 19, 20]) assert.ok(!after.charset.includes(sid), `the name of a digit (SID ${sid}) is still in the charset`);
  assert.deepEqual([...after.encoding].sort((a, b) => a[0] - b[0]), [..."ABCDEFGH "].map((ch) => [ch.charCodeAt(0), chars.indexOf(ch) + 1]).sort((a, b) => a[0] - b[0]), "codes of removed glyphs left the built-in encoding");
  // the kit draws every fourth glyph through a global subroutine, the other odd ones through a local one:
  // a subroutine only a removed glyph called is a single "return" now, the others are what they were
  const kindOf = (index) => (chars[index] === " " ? "empty" : index % 4 === 3 ? "global" : index % 2 === 1 ? "local" : "inline");
  const expectSubrs = (kind, was, now) => {
    const users = [...chars].map((_, index) => index).filter((index) => kindOf(index) === kind);
    assert.equal(was.length, users.length);
    users.forEach((index, subr) => {
      if (remove.has(index + 1)) assert.equal(hex(now[subr]), "0b", `${kind} subroutine ${subr} still holds the outline of "${chars[index]}"`);
      else assert.equal(hex(now[subr]), hex(was[subr]), `${kind} subroutine ${subr}`);
    });
    return users.filter((index) => remove.has(index + 1)).length;
  };
  const blanked = expectSubrs("global", before.gsubrs, after.gsubrs) + expectSubrs("local", before.lsubrs, after.lsubrs);
  assert.ok(blanked >= 2, "fixture: removed glyphs used subroutines");
  assert.equal(out.subrsBlanked, blanked);
  // the drawing of a removed glyph is nowhere in the program any more (each character has a box of its own size)
  for (const ch of "0123") {
    const { width, height } = boxOfChar(ch);
    const drawing = hex(Uint8Array.from([...numberBytes(width), 6, ...numberBytes(height), 7, ...numberBytes(-width), 6]));
    assert.ok(hex(program).includes(drawing), `fixture: the drawing of "${ch}"`);
    assert.ok(!hex(out.bytes).includes(drawing), `the drawing of "${ch}" is still in the program`);
  }
  // glyph 0 stays, numbers outside the font are ignored, and the result reads back
  assert.equal(rewriteCff(cff, { remove: new Set([0, 999]) }).removed, 0);
  const again = readCff(out.bytes);
  assert.equal(again.nGlyphs, cff.nGlyphs - 4);
  assert.equal(again.glyphOfName.has("zero"), false);
  assert.equal(again.glyphOfName.get("H"), chars.indexOf("H") + 1);
  assert.deepEqual([isEmptyCharstring(Uint8Array.of(14)), isEmptyCharstring(Uint8Array.of(248, 20, 14)), isEmptyCharstring(Uint8Array.of(139, 139, 21, 14)), isEmptyCharstring(new Uint8Array(0))], [true, true, false, true]);
});

/** A Type 2 charstring number (as the kit writes them). */
function numberBytes(v) {
  if (v >= -107 && v <= 107) return [v + 139];
  if (v >= 108 && v <= 1131) return [247 + ((v - 108) >> 8), (v - 108) & 0xff];
  if (v >= -1131 && v <= -108) return [251 + ((-v - 108) >> 8), (-v - 108) & 0xff];
  return [28, (v >> 8) & 0xff, v & 0xff];
}

test("CFF: a program that keeps its idle subroutines keeps all of them; what cannot be told is refused", () => {
  const chars = "ABCDEFGH 0123";
  const remove = new Set([..."0123"].map((ch) => chars.indexOf(ch) + 1));
  // a producer that does not subset the subroutines: more of them are idle than called. An emptied one would
  // be the odd one out (and say "this one belonged to removed text"), so none is emptied
  const spare = makeCffFont({ chars, spareSubrs: 8 });
  const out = rewriteCff(readCff(spare), { remove });
  assert.equal(out.subrsBlanked, 0);
  assert.deepEqual(cffGlyphs(out.bytes).gsubrs.map(hex), cffGlyphs(spare).gsubrs.map(hex));
  assert.deepEqual(cffGlyphs(out.bytes).lsubrs.map(hex), cffGlyphs(spare).lsubrs.map(hex));
  assert.equal(cffGlyphs(out.bytes).count, chars.length + 1 - 4);
  // one stray idle subroutine does not make a program of that kind: the outlines of the removed glyphs go
  const stray = makeCffFont({ chars, spareSubrs: 1 });
  const cleaned = rewriteCff(readCff(stray), { remove });
  assert.equal(cleaned.subrsBlanked, rewriteCff(readCff(makeCffFont({ chars })), { remove }).subrsBlanked);
  assert.ok(cleaned.subrsBlanked >= 2);
  // arithmetic on the stack: the number of the subroutine a glyph calls could be computed, so it is unknown
  const computed = makeCffFont({ chars, mutate: ({ charStrings }) => charStrings[2].splice(-1, 0, 139, 139, 12, 10, 12, 18) });
  refused(() => rewriteCff(readCff(computed), { remove: new Set([5]) }));
  // an operator nobody knows
  const unknown = makeCffFont({ chars, mutate: ({ charStrings }) => charStrings[2].splice(-1, 0, 2) });
  refused(() => rewriteCff(readCff(unknown), { remove: new Set([5]) }));
  // a call of a subroutine that does not exist
  const dangling = makeCffFont({ chars, mutate: ({ charStrings }) => charStrings[2].splice(-1, 0, ...numberBytes(60), 10) });
  refused(() => rewriteCff(readCff(dangling), { remove: new Set([5]) }));
  // another major version (CFF2), a truncated program, no program
  const program = makeCffFont({ chars });
  refused(() => readCff(Uint8Array.from([2, ...program.subarray(1)])));
  refused(() => readCff(program.subarray(0, 60)));
  refused(() => readCff(new Uint8Array(2)));
  refused(() => readCff("CFF"));
});

test("CFF: the CID-keyed subset that pdf-lib embeds loses the glyph together with its CID", async () => {
  const chars = "ABCDEFGH 0123";
  const doc = await pdfLib.PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(makeOtfFont({ chars }), { subset: true });
  doc.addPage([400, 200]).drawText("ABCDEFGH 0123", { x: 20, y: 100, size: 14, font });
  const [embedded] = (await fontsOf(await doc.save({ useObjectStreams: false }))).filter((entry) => entry.programKind === "cff");
  assert.equal(embedded.subtype, "Type0");
  const cff = readCff(embedded.program);
  assert.equal(cff.isCID, true);
  assert.equal(cff.encoding, null);
  const before = cffGlyphs(embedded.program);
  assert.equal(before.isCID, true);
  // the CID of "2" as the document uses it: the code its ToUnicode map gives to the character
  const cid = [...embedded.toUnicode].find(([, text]) => text === "2")[0];
  const glyph = cff.glyphOfCid.get(cid);
  assert.ok(glyph > 0, "fixture: the CID has a glyph");
  const out = rewriteCff(cff, { remove: new Set([glyph]) });
  const after = cffGlyphs(out.bytes);
  assert.equal(after.isCID, true);
  assert.equal(after.count, before.count - 1);
  assert.ok(!after.charset.includes(cid), "the CID of the removed glyph is still in the charset");
  assert.deepEqual(after.charset, before.charset.filter((_, index) => index !== glyph));
  assert.deepEqual(after.charStrings.map(hex), before.charStrings.filter((_, index) => index !== glyph).map(hex));
  const again = readCff(out.bytes);
  assert.equal(again.glyphOfCid.has(cid), false);
  for (const [otherCid, otherGlyph] of cff.glyphOfCid) if (otherCid !== cid) assert.equal(again.glyphOfCid.get(otherCid), otherGlyph > glyph ? otherGlyph - 1 : otherGlyph);
  // the bundled fonts are TrueType: a wrapped CFF font is the only OpenType program a test can make
  assert.ok(fontBytes("arimo-regular").length > 1000);
});
