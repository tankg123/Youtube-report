// What a FONT still tells of text that was removed, and how it is taken out.
//
// A subset font holds exactly what was shown with it: an outline, an advance width and a ToUnicode mapping
// per character, with most producers in the order of first use. A mark removes character codes from the
// content of a page; the font object, shared with every other page that uses the face, keeps the glyphs that
// only the removed text needed. Read in code order they spell the removed text (minus the characters that
// occur elsewhere). No text extractor shows this and no scan of the page finds it.
//
//   usedBy(pdfDoc, pageIndexes)              -> Map<font id, codes>   what the given pages show (taken BEFORE the job)
//   cleanFonts(pdfDoc, { before, skipPages, enabled }) -> { cleaned, notCleaned, released }   (AFTER the pages were edited)
//   fontInventory(pdfDoc)                    -> what every font holds beyond what the document shows (tests, diagnostics)
//
// HOW IT IS DECIDED. For every font the edited pages used, the codes they showed before the job are compared
// with the codes ANY content of the document shows now: page content, the Form XObjects it draws (with the
// font they inherit), annotation appearances, tiling patterns, soft-mask groups and Type3 glyph procedures.
// A code that was shown and is shown by nothing any more is "freed". For the freed codes of a font:
//   - their ToUnicode mappings are deleted;
//   - their widths go: the /W entries of a CID font are deleted, the /Widths entries of a simple font are set to 0
//     (unless the array holds a width for every code of its range anyway: see "a COMPLETE font" below);
//   - their outlines go from the font program:
//       TrueType (FontFile2)        the glyph record is taken out of "glyf" (fontPrograms.js), with the glyphs it
//                                   was composed of when nothing else needs them; cmap, post names and advances
//                                   of the glyph go as well
//       CFF (FontFile3)             the glyph leaves the program: charstring, charset entry, name (cffProgram.js)
//       Type3                       the glyph procedure is deleted from /CharProcs
//   - /Differences entries of the code, the bits of /CIDSet and the names in /CharSet follow.
// The glyph of a code is found exactly as a viewer finds it: Type0 with Identity or an embedded CMap through
// /CIDToGIDMap (TrueType) or the charset (CFF); a simple TrueType font through its encoding and the cmap
// subtables (every way a viewer may take must lead to the same glyph); a simple CFF font through its encoding
// and the glyph names; a Type3 font through /Differences.
//
// WHAT IS NEVER DONE
//   - Nothing is changed for a code that something still shows. A font object shared with pages that have no
//     mark is edited in place for that reason: those pages show exactly what they showed
//     (tests/pdfRedactFontCleanup.test.mjs compares their pixels).
//   - A font whose use cannot be told completely is left alone: content that cannot be parsed or decoded, a
//     font the form fields of the document may write with (/AcroForm /DR), a reference to the font from a
//     place that is not a resource dictionary of drawn content, a CMap that is not understood.
//   - A font program this engine cannot edit with certainty is left alone: Type1 (its glyphs are encrypted),
//     OpenType wrappers, programs with colour, bitmap or variation tables, a glyph mapping that is ambiguous,
//     damaged tables (fontPrograms.js / cffProgram.js throw FontProgramError).
//   Both cases are REPORTED (notCleaned: [{ font, pageIndexes, reason }]) when the font holds something of
//   the freed codes: the caller warns (REDACT_FONT_GLYPHS_REMAIN) and can turn the pages that use the font
//   into pictures (env.rasterPages); a font nothing shows any more is released from the resource dictionaries
//   and leaves the file with the garbage collection.
//   - A COMPLETE font is left alone, silently: when a table holds data for many more codes than the document
//     ever showed (a font embedded as a whole, a /Widths array written for the whole encoding), an entry
//     proves nothing, and emptying the entries of the removed text would mark exactly those characters. The
//     rule is the same for every table: the entry of a freed code is made to look like the entries of the
//     codes nothing ever showed. See `complete()` (glyph tables, CID fonts) and `keepsIdle()` (the small
//     tables of a simple font).
//
// What stays visible after a clean-up: that the font HAD glyphs nothing shows now (empty slots between the
// glyphs of a subset that numbers its glyphs in the order of first use). Their number is the number of
// different characters only the removed text used; nothing says which characters they were.
import { pdfLib } from "../lib.js";
import { createTokenReader, parseContentStream } from "./contentStream.js";
import { A } from "./pdfAccess.js";
import { loadFont } from "./fonts.js";
import { ENCODINGS } from "./stdFontData.js";
import { FontProgramError, buildCmap, glyphClosure, parseCmap, postGlyphNames, readTrueType, renamePostGlyphs, rewriteTrueType } from "./fontPrograms.js";
import { isEmptyCharstring, readCff, rewriteCff } from "./cffProgram.js";
import { pruneResources } from "./resourceUsage.js";
import { reachableRefs } from "./documentScrub.js";

const { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream } = pdfLib;

const MAX_DEPTH = 32;
/** Content streams read for one page before the scan gives up (forms that draw forms that draw forms ...). */
const MAX_STREAMS_PER_PAGE = 20000;
const keyOfCode = (glyph) => `${glyph.length}:${glyph.code}`;

/** Internal: a root (a page, an annotation appearance) whose content cannot be read. */
class ScanFailure extends Error {}

const refuse = (reason) => {
  throw new FontProgramError(reason);
};

// ---------------------------------------------------------------- which codes does the document show?
/**
 * Walks the content of a document and notes, per font object, the character codes that are shown.
 *   resources(options)   registers every font the resource dictionaries of the pages can reach (no content is read)
 *   content(options)     reads the content of the pages and of their annotation appearances
 * A font entry: { key, id ("num gen", null for a font written directly into a resource dictionary), dict,
 *   codes: Map<"length:code", { length, code, cid }>, unknown (some text shown with it could not be split into
 *   codes, or a root that can reach it could not be read), pages: Set of page indexes that show text with it,
 *   holders: Set of the dictionaries / arrays that refer to it, referencedBy: Set of page indexes }.
 */
function createScanner(pdfDoc) {
  const context = pdfDoc.context;
  const fonts = new Map();
  const reach = new Map(); // resource dictionary -> Set of font entries it can reach
  const fontDictOwners = new Map(); // /Font category dictionary -> Set of resource dictionaries
  const scanned = new Set();
  let budget = 0;

  const fontOf = (raw, dict) => {
    if (!A.isDict(dict)) return null;
    const key = A.isRef(raw) ? A.idOf(raw) : dict;
    let entry = fonts.get(key);
    if (!entry) {
      entry = { key, id: typeof key === "string" ? key : null, ref: A.isRef(raw) ? raw : null, dict, info: null, codes: new Map(), unknown: false, pages: new Set(), holders: new Set(), referencedBy: new Set() };
      fonts.set(key, entry);
    }
    return entry;
  };
  const infoOf = (entry) => (entry.info ||= loadFont(entry.dict));

  /** Every font a resource dictionary can reach: its own, and those of the forms, patterns, masks and Type3 fonts it names. */
  const fontsIn = (resources) => {
    if (!A.isDict(resources)) return new Set();
    if (reach.has(resources)) return reach.get(resources);
    const found = new Set();
    const seen = new Set();
    const visit = (res, depth) => {
      if (!A.isDict(res) || seen.has(res) || depth > MAX_DEPTH) return;
      seen.add(res);
      const fontDict = A.get(res, "Font");
      if (A.isDict(fontDict)) {
        if (!fontDictOwners.has(fontDict)) fontDictOwners.set(fontDict, new Set());
        fontDictOwners.get(fontDict).add(res);
        for (const [, raw] of fontDict.entries()) {
          const entry = fontOf(raw, A.resolve(context, raw));
          if (!entry) continue;
          entry.holders.add(fontDict);
          found.add(entry);
          if (A.getName(entry.dict, "Subtype") === "Type3") visit(A.get(entry.dict, "Resources"), depth + 1);
        }
      }
      const states = A.get(res, "ExtGState");
      if (A.isDict(states)) {
        for (const [, raw] of states.entries()) {
          const state = A.resolve(context, raw);
          if (!A.isDict(state)) continue;
          const font = A.get(state, "Font");
          if (A.isArray(font) && font.size() >= 1) {
            const entry = fontOf(font.get(0), font.lookup(0));
            if (entry) {
              entry.holders.add(font);
              found.add(entry);
            }
          }
          const mask = A.get(state, "SMask");
          const group = A.isDict(mask) ? A.get(mask, "G") : undefined;
          if (A.isStream(group)) visit(A.get(group.dict, "Resources"), depth + 1);
        }
      }
      for (const category of ["XObject", "Pattern"]) {
        const dict = A.get(res, category);
        if (!A.isDict(dict)) continue;
        for (const [, raw] of dict.entries()) {
          const object = A.resolve(context, raw);
          if (A.isStream(object)) visit(A.get(object.dict, "Resources"), depth + 1);
        }
      }
    };
    visit(resources, 0);
    reach.set(resources, found);
    return found;
  };

  const streamBytes = (stream) => {
    try {
      return A.streamBytes(stream);
    } catch {
      throw new ScanFailure();
    }
  };

  /** Reads one content stream: `inherited` is the font in effect where it starts (a form shows text with the font of its caller). */
  const scan = (bytes, resources, inherited, depth, pageIndex) => {
    if (depth > MAX_DEPTH || ++budget > MAX_STREAMS_PER_PAGE) throw new ScanFailure();
    let ops;
    try {
      ({ ops } = parseContentStream(bytes));
    } catch {
      throw new ScanFailure();
    }
    const lookup = (category, token) => {
      const dict = token?.type === "name" ? A.get(resources, category) : undefined;
      const raw = A.isDict(dict) ? dict.get(A.N(token.value)) : undefined;
      return [raw, A.resolve(context, raw)];
    };
    const form = (raw, stream, font) => {
      const own = A.get(stream.dict, "Resources");
      const id = A.idOf(raw ?? stream);
      // the same form with the same inherited font shows the same codes: read once per page. (A form without
      // resources of its own reads the names of whoever draws it, a font written into a dictionary has no
      // id: those are read every time.)
      if (A.isDict(own) && typeof id === "string" && (!font || font.id !== null)) {
        const key = `${pageIndex}|${id}|${font ? font.id : ""}`;
        if (scanned.has(key)) return;
        scanned.add(key);
      }
      scan(streamBytes(stream), A.isDict(own) ? own : resources, font, depth + 1, pageIndex);
    };
    const show = (font, elements) => {
      if (!font) return; // text without a font shows nothing
      font.pages.add(pageIndex);
      const info = infoOf(font);
      if (info.kind === "type3") {
        const procs = A.get(font.dict, "CharProcs");
        const key = `${pageIndex}|type3|${String(font.id ?? "direct")}`;
        if (A.isDict(procs) && !scanned.has(key)) {
          scanned.add(key);
          const own = A.get(font.dict, "Resources");
          for (const [, raw] of procs.entries()) {
            const proc = A.resolve(context, raw);
            if (A.isStream(proc)) scan(streamBytes(proc), A.isDict(own) ? own : resources, null, depth + 1, pageIndex);
          }
        }
      }
      // (a predefined CMap this engine does not carry: the codes can be split, but not turned into CIDs)
      if (!info.codeLengths || info.predefined) {
        font.unknown = true;
        return;
      }
      try {
        for (const element of elements) {
          if (element.type !== "str" && element.type !== "hex") continue;
          for (const glyph of info.decode(element.value)) font.codes.set(keyOfCode(glyph), { length: glyph.length, code: glyph.code, cid: glyph.cid });
        }
      } catch {
        font.unknown = true;
      }
    };
    let font = inherited;
    const stack = [];
    for (const op of ops) {
      switch (op.op) {
        case "q":
          stack.push(font);
          break;
        case "Q":
          if (stack.length) font = stack.pop();
          break;
        case "Tf": {
          const [raw, dict] = lookup("Font", op.args[0]);
          font = fontOf(raw, dict);
          break;
        }
        case "gs": {
          const [, state] = lookup("ExtGState", op.args[0]);
          if (!A.isDict(state)) break;
          const viaState = A.get(state, "Font");
          if (A.isArray(viaState) && viaState.size() >= 1) font = fontOf(viaState.get(0), viaState.lookup(0));
          const mask = A.get(state, "SMask");
          const group = A.isDict(mask) ? A.get(mask, "G") : undefined;
          if (A.isStream(group)) form(A.getRaw(mask, "G"), group, font);
          break;
        }
        case "Tj": case "'":
          show(font, op.args);
          break;
        case "\"":
          show(font, op.args.slice(2));
          break;
        case "TJ":
          if (op.args[0]?.type === "arr") show(font, op.args[0].items);
          break;
        case "Do": {
          const [raw, object] = lookup("XObject", op.args[0]);
          if (A.isStream(object) && A.getName(object.dict, "Subtype") === "Form") form(raw, object, font);
          break;
        }
        case "scn": case "SCN": {
          const [raw, pattern] = lookup("Pattern", op.args[op.args.length - 1]);
          if (A.isStream(pattern)) form(raw, pattern, null);
          break;
        }
        default:
      }
    }
  };

  const pageNodes = pdfDoc.getPages().map((page) => page.node);
  const inheritedResources = (node) => {
    for (let guard = 0; A.isDict(node) && guard < 64; guard++) {
      const resources = A.get(node, "Resources");
      if (A.isDict(resources)) return resources;
      node = A.resolve(context, A.getRaw(node, "Parent"));
    }
    return undefined;
  };
  /** The appearance streams of the annotations of a page: [raw reference, stream]. */
  const appearances = (pageNode) => {
    const out = [];
    const annots = A.get(pageNode, "Annots");
    if (!A.isArray(annots)) return out;
    for (let i = 0; i < annots.size(); i++) {
      const ap = A.get(annots.lookup(i), "AP");
      if (!A.isDict(ap)) continue;
      for (const [, raw] of ap.entries()) {
        const value = A.resolve(context, raw);
        if (A.isStream(value)) out.push([raw, value]);
        else if (A.isDict(value)) for (const [, stateRaw] of value.entries()) if (A.isStream(A.resolve(context, stateRaw))) out.push([stateRaw, A.resolve(context, stateRaw)]);
      }
    }
    return out;
  };
  /** The roots of a page: [content bytes (a function: read late), resources, raw, stream]. */
  const rootsOf = (pageNode) => {
    const roots = [{ resources: inheritedResources(pageNode), page: pageNode }];
    for (const [raw, stream] of appearances(pageNode)) roots.push({ resources: A.get(stream.dict, "Resources"), raw, stream });
    return roots;
  };
  const pageContent = (pageNode) => {
    const contents = A.get(pageNode, "Contents");
    const streams = A.isStream(contents) ? [contents] : A.isArray(contents) ? contents.asArray().map((item) => A.resolve(context, item)) : [];
    const chunks = [];
    let size = 0;
    for (const stream of streams) {
      if (!A.isStream(stream)) continue;
      const bytes = streamBytes(stream);
      chunks.push(bytes);
      size += bytes.length + 1;
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
      all[at++] = 0x0a;
    }
    return all;
  };

  return {
    fonts,
    fontDictOwners,
    /** The fonts the form fields of the document may write with later (/AcroForm /DR): their use is open-ended. */
    formFonts() {
      const found = new Set();
      const dr = A.get(A.get(pdfDoc.catalog, "AcroForm"), "DR");
      const fontDict = A.get(dr, "Font");
      if (A.isDict(fontDict)) for (const [, raw] of fontDict.entries()) if (fontOf(raw, A.resolve(context, raw))) found.add(fontOf(raw, A.resolve(context, raw)));
      return found;
    },
    /** Registers the fonts every page can reach. skipPages: pages whose fonts are registered but not counted as referencing. */
    resources({ skipPages = new Set() } = {}) {
      pageNodes.forEach((node, pageIndex) => {
        for (const root of rootsOf(node)) for (const entry of fontsIn(root.resources)) if (!skipPages.has(pageIndex)) entry.referencedBy.add(pageIndex);
      });
    },
    /**
     * Reads the content. pages: the page indexes to read (default all); skipPages: pages left out; only: a Set of
     * font entries: content that cannot reach one of them is not read; appearancesEverywhere: the annotation
     * appearances of ALL pages are read, whatever `pages` says (a job can take the appearance of a form field
     * on a page it does not touch otherwise).
     */
    content({ pages = null, skipPages = new Set(), only = null, appearancesEverywhere = false } = {}) {
      const wholePage = new Set(pages ?? pageNodes.map((_, index) => index));
      for (let pageIndex = 0; pageIndex < pageNodes.length; pageIndex++) {
        const node = pageNodes[pageIndex];
        if (skipPages.has(pageIndex) || (!wholePage.has(pageIndex) && !appearancesEverywhere)) continue;
        budget = 0;
        for (const root of rootsOf(node)) {
          if (root.page && !wholePage.has(pageIndex)) continue;
          const reachable = fontsIn(root.resources);
          if (only && ![...reachable].some((entry) => only.has(entry))) continue;
          try {
            if (root.page) scan(pageContent(root.page), root.resources, null, 0, pageIndex);
            else scan(streamBytes(root.stream), root.resources, null, 0, pageIndex);
          } catch (error) {
            if (!(error instanceof ScanFailure)) throw error;
            // what this content shows is not known: every font it can reach may be in use
            for (const entry of reachable) {
              entry.unknown = true;
              entry.pages.add(pageIndex);
            }
          }
        }
      }
    }
  };
}

/**
 * The codes the given pages show, per font object: Map<"num gen", { codes: Map<"length:code", { length, code, cid }>, unknown }>.
 * Taken from the document as it was loaded, BEFORE a page is edited; cleanFonts() compares it with what is
 * shown afterwards. (Fonts written directly into a resource dictionary have no id and are not listed.)
 */
export function usedBy(pdfDoc, pageIndexes) {
  const scanner = createScanner(pdfDoc);
  scanner.content({ pages: pageIndexes, appearancesEverywhere: true });
  const out = new Map();
  for (const entry of scanner.fonts.values()) if (entry.id !== null && (entry.codes.size || entry.unknown)) out.set(entry.id, { codes: entry.codes, unknown: entry.unknown });
  return out;
}

// ---------------------------------------------------------------- when an entry proves nothing
// Taking the data of a freed code out of a font only helps where the data SAID something. A subset holds data
// for exactly what was shown: there an outline or a width is evidence, and it goes. A font embedded as a
// whole, or a /Widths array written for the whole encoding, holds data for everything: there an entry proves
// nothing, and EMPTYING the entries of the removed text would mark exactly those characters (in such a font
// the glyph number or the code names the character). The rule is the same everywhere: an entry of a freed
// code is made to look like the entries of the codes that nothing ever showed ("idle" codes).
const LARGE_TABLE = 150;
/**
 * Large tables (glyphs of a font program, the codes of a CID font): is this the table of a whole font?
 *   unused   idle entries that hold data (outlines of glyphs nothing ever showed, mappings of such codes)
 *   used     entries of what was shown, before or after
 *   empty    idle slots that hold nothing (a subset that keeps the glyph numbers of its source leaves the
 *            glyphs it does not need empty: an emptied glyph then looks like every glyph that was never used)
 * A subset of a document that lost pages before this job also has idle entries with data (what only the
 * dropped pages showed), but few against what is used: only a table with many of them, and more than twice
 * what is used, counts as complete and is left alone.
 */
const complete = (unused, used, empty = 0) => unused > empty && unused >= LARGE_TABLE && unused >= 2 * used;
/**
 * Small tables of a simple font (at most 256 codes: /Widths, /Differences, glyph procedures, its ToUnicode
 * map): the entry of a freed code stays when the idle codes of the table keep theirs in their majority.
 *   named    false: the codes of the font are numbers of its own (a symbolic font without /Encoding, glyphs
 *            numbered in the order of first use): a code says nothing, so its data always goes
 */
const keepsIdle = (named, idleWithData, idleEmpty) => named && idleWithData > idleEmpty;

// ---------------------------------------------------------------- ToUnicode
const hexOf = (bytes) => {
  let text = "";
  for (const byte of bytes) text += (byte < 16 ? "0" : "") + byte.toString(16).toUpperCase();
  return text;
};
const intOf = (bytes) => {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
};
const bytesOfInt = (value, length) => {
  const out = new Uint8Array(length);
  for (let k = length - 1; k >= 0; k--) {
    out[k] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
};
/** The destination of the code `steps` after the first one of a bfrange: the last two bytes count up (as viewers do it). */
function advanceDestination(dst, steps) {
  if (steps === 0 || dst.length === 0) return dst;
  const out = dst.slice();
  if (out.length === 1) out[0] = (out[0] + steps) & 0xff;
  else {
    const last = out.length - 2;
    const value = (((out[last] << 8) | out[last + 1]) + steps) & 0xffff;
    out[last] = value >> 8;
    out[last + 1] = value & 0xff;
  }
  return out;
}

/**
 * Reads the mappings of a ToUnicode CMap: { ranges: [{ length, lo, hi, dst | list }], sections: [[start, end]] }.
 * Anything but codespace ranges, bfchar and bfrange sections (a usecmap, CID ranges) is refused.
 */
function readToUnicode(bytes) {
  const next = createTokenReader(bytes);
  const ranges = [];
  const sections = [];
  let previous = null;
  const hex = (token) => {
    if (!token || token.type !== "hex") refuse("to-unicode");
    return token.value;
  };
  const endOf = (name) => (token) => token && token.type === "op" && token.value === name;
  try {
    for (;;) {
      const token = next();
      if (token === null) break;
      if (token.type === "op") {
        const start = previous && previous.type === "num" ? previous.start : token.start;
        if (token.value === "beginbfchar") {
          const done = endOf("endbfchar");
          for (;;) {
            const a = next();
            if (done(a)) {
              sections.push([start, a.end]);
              break;
            }
            const src = hex(a);
            ranges.push({ length: src.length, lo: intOf(src), hi: intOf(src), dst: hex(next()) });
          }
        } else if (token.value === "beginbfrange") {
          const done = endOf("endbfrange");
          for (;;) {
            const a = next();
            if (done(a)) {
              sections.push([start, a.end]);
              break;
            }
            const lo = hex(a);
            const hi = hex(next());
            const target = next();
            if (lo.length !== hi.length || intOf(hi) < intOf(lo) || intOf(hi) - intOf(lo) > 0xffff) refuse("to-unicode");
            if (target?.type === "arr") {
              if (target.items.length !== intOf(hi) - intOf(lo) + 1) refuse("to-unicode");
              ranges.push({ length: lo.length, lo: intOf(lo), hi: intOf(hi), list: target.items.map(hex) });
            } else ranges.push({ length: lo.length, lo: intOf(lo), hi: intOf(hi), dst: hex(target) });
          }
        } else if (["usecmap", "begincidrange", "begincidchar", "beginnotdefrange", "beginnotdefchar"].includes(token.value)) refuse("to-unicode");
      }
      previous = token;
    }
  } catch (error) {
    if (error instanceof FontProgramError) throw error;
    refuse("to-unicode"); // not the token language this reader knows
  }
  return { ranges, sections };
}

/**
 * A ToUnicode CMap without the mappings of `drop` (a Set of "length:code" keys).
 *   leave   ({ total: number of codes the map has, isMapped(key) }) => true when the map is to be left alone
 *           (the map of a complete font: see `complete` and `keepsIdle`)
 * Returns { bytes, dropped } or null when nothing is to be done.
 */
function editToUnicode(bytes, drop, leave) {
  const { ranges, sections } = readToUnicode(bytes);
  if (!sections.length) return null;
  let total = 0;
  for (const range of ranges) total += range.hi - range.lo + 1;
  const isMapped = (key) => {
    const [length, code] = key.split(":").map(Number);
    return ranges.some((range) => range.length === length && code >= range.lo && code <= range.hi);
  };
  if (leave({ total, isMapped })) return null;
  let dropped = 0;
  let list = ranges;
  for (const key of drop) {
    const [length, code] = key.split(":").map(Number);
    const nextList = [];
    for (const range of list) {
      if (range.length !== length || code < range.lo || code > range.hi) {
        nextList.push(range);
        continue;
      }
      dropped++;
      const part = (lo, hi) => {
        if (hi < lo) return;
        if (range.list) nextList.push({ length, lo, hi, list: range.list.slice(lo - range.lo, hi - range.lo + 1) });
        else nextList.push({ length, lo, hi, dst: advanceDestination(range.dst, lo - range.lo) });
      };
      part(range.lo, code - 1);
      part(code + 1, range.hi);
    }
    list = nextList;
  }
  if (!dropped) return null;
  const src = (value, length) => `<${hexOf(bytesOfInt(value, length))}>`;
  const singles = list.filter((range) => range.lo === range.hi);
  const spans = list.filter((range) => range.lo !== range.hi);
  const lines = [];
  for (let i = 0; i < singles.length; i += 100) {
    const chunk = singles.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`, ...chunk.map((range) => `${src(range.lo, range.length)} <${hexOf(range.list ? range.list[0] : range.dst)}>`), "endbfchar");
  }
  for (let i = 0; i < spans.length; i += 100) {
    const chunk = spans.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfrange`, ...chunk.map((range) => `${src(range.lo, range.length)} ${src(range.hi, range.length)} ${range.list ? `[${range.list.map((item) => `<${hexOf(item)}>`).join(" ")}]` : `<${hexOf(range.dst)}>`}`), "endbfrange");
  }
  // the sections of the original go; the new ones stand where the first one stood
  const parts = [];
  let at = 0;
  sections.sort((a, b) => a[0] - b[0]).forEach(([start, end], index) => {
    parts.push(bytes.subarray(at, start));
    if (index === 0) parts.push(Uint8Array.from(lines.join("\n"), (ch) => ch.charCodeAt(0)));
    at = end;
  });
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return { bytes: out, dropped };
}

// ---------------------------------------------------------------- widths of a CID font
/** /W (or /W2 with `step` 3) -> Map<cid, number or number[]>; refuses what it cannot read. */
function readCidWidths(array, step = 1) {
  const map = new Map();
  if (!A.isArray(array)) return map;
  const n = array.size();
  for (let i = 0; i < n; ) {
    const first = A.num(array.lookup(i));
    const second = array.lookup(i + 1);
    if (!Number.isInteger(first)) refuse("widths");
    if (A.isArray(second)) {
      if (second.size() % step !== 0) refuse("widths");
      for (let k = 0; k < second.size(); k += step) {
        const values = Array.from({ length: step }, (_, s) => A.num(second.lookup(k + s)));
        if (values.some((v) => v === undefined)) refuse("widths");
        map.set(first + k / step, step === 1 ? values[0] : values);
      }
      i += 2;
    } else {
      const last = A.num(second);
      const values = Array.from({ length: step }, (_, s) => A.num(array.lookup(i + 2 + s)));
      if (!Number.isInteger(last) || last < first || last - first > 70000 || values.some((v) => v === undefined)) refuse("widths");
      for (let cid = first; cid <= last; cid++) map.set(cid, step === 1 ? values[0] : values);
      i += 2 + step;
    }
  }
  return map;
}

function writeCidWidths(map, context) {
  const out = context.obj([]);
  const cids = [...map.keys()].sort((a, b) => a - b);
  for (let i = 0; i < cids.length; ) {
    let j = i;
    while (j + 1 < cids.length && cids[j + 1] === cids[j] + 1) j++;
    out.push(PDFNumber.of(cids[i]));
    out.push(context.obj(cids.slice(i, j + 1).flatMap((cid) => map.get(cid))));
    i = j + 1;
  }
  return out;
}

// ---------------------------------------------------------------- glyph names and encodings
let nameToUnicode = null;
/** Unicode of a glyph name of the Latin encodings (and uniXXXX / uXXXX names); undefined when this engine does not know it. */
function unicodeOfGlyphName(name) {
  if (!nameToUnicode) {
    nameToUnicode = new Map();
    const fill = (table, label) => {
      let decoder;
      try {
        decoder = new TextDecoder(label);
      } catch {
        return; // the platform does not carry this encoding: the names it alone knows stay unknown
      }
      table.forEach((glyph, code) => {
        if (!glyph || nameToUnicode.has(glyph)) return;
        const cp = decoder.decode(Uint8Array.of(code)).codePointAt(0);
        // (codes the encoding leaves undefined decode to control characters: not the character of the name)
        if (cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f) && cp !== 0xfffd) nameToUnicode.set(glyph, cp);
      });
    };
    fill(ENCODINGS.WinAnsiEncoding, "windows-1252");
    fill(ENCODINGS.MacRomanEncoding, "macintosh");
  }
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name) || /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return parseInt(uni[1], 16);
  return nameToUnicode.get(name);
}

/** The /Encoding of a simple font: { base: table name or null, differences: Map<code, glyph name>, has: an /Encoding entry exists }. */
function simpleEncoding(dict) {
  const encoding = A.get(dict, "Encoding");
  const differences = new Map();
  let base = null;
  if (A.isName(encoding)) base = A.nameOf(encoding);
  else if (A.isDict(encoding)) {
    base = A.getName(encoding, "BaseEncoding") ?? null;
    const list = A.get(encoding, "Differences");
    if (A.isArray(list)) {
      let code = 0;
      for (let i = 0; i < list.size(); i++) {
        const item = list.lookup(i);
        if (A.isNumber(item)) code = item.asNumber();
        else if (A.isName(item)) differences.set(code++, A.nameOf(item));
        else refuse("encoding");
      }
    }
  }
  if (base !== null && !ENCODINGS[base]) refuse("encoding");
  return { base, differences, has: encoding !== undefined, dict: A.isDict(encoding) ? encoding : null };
}

// ---------------------------------------------------------------- the shape of a font
const BASE_NAME = (dict) => A.getName(dict, "BaseFont") ?? A.getName(dict, "Name") ?? "";

/**
 * What a font dictionary is made of: { kind, name, dict, cidFont, descriptor, program (PDFStream), programKey,
 * toUnicode (PDFStream), shared: the objects another font dictionary could share with it }.
 * kind: "type0-truetype" | "type0-cff" | "type0-bare" | "simple-truetype" | "simple-cff" | "simple-bare" |
 *       "type3" | "type1" (a Type 1 program: not editable) | "other" (not editable)
 */
function shapeOf(dict) {
  const subtype = A.getName(dict, "Subtype");
  const shape = { kind: "other", name: BASE_NAME(dict), dict, cidFont: null, descriptor: null, program: null, programKey: null, toUnicode: null, shared: new Set() };
  const toUnicode = A.get(dict, "ToUnicode");
  if (toUnicode instanceof PDFStream) shape.toUnicode = toUnicode;
  const programOf = (descriptor) => {
    const found = [];
    for (const key of ["FontFile", "FontFile2", "FontFile3"]) if (A.get(descriptor, key) instanceof PDFStream) found.push(key);
    return found;
  };
  if (subtype === "Type0") {
    const descendants = A.get(dict, "DescendantFonts");
    const cidFont = A.isArray(descendants) ? descendants.lookup(0) : undefined;
    if (!A.isDict(cidFont)) return shape;
    shape.cidFont = cidFont;
    shape.descriptor = A.get(cidFont, "FontDescriptor") ?? null;
    const files = programOf(shape.descriptor);
    const cidSubtype = A.getName(cidFont, "Subtype");
    if (!files.length) shape.kind = "type0-bare";
    else if (files.length === 1 && files[0] === "FontFile2" && cidSubtype === "CIDFontType2") shape.kind = "type0-truetype";
    else if (files.length === 1 && files[0] === "FontFile3" && cidSubtype === "CIDFontType0" && A.getName(A.get(shape.descriptor, "FontFile3").dict, "Subtype") === "CIDFontType0C") shape.kind = "type0-cff";
    if (files.length === 1) shape.programKey = files[0];
  } else if (subtype === "Type1" || subtype === "MMType1" || subtype === "TrueType") {
    shape.descriptor = A.get(dict, "FontDescriptor") ?? null;
    const files = programOf(shape.descriptor);
    if (!files.length) shape.kind = "simple-bare";
    else if (files.length === 1 && files[0] === "FontFile2" && subtype === "TrueType") shape.kind = "simple-truetype";
    else if (files.length === 1 && files[0] === "FontFile3" && subtype === "Type1" && A.getName(A.get(shape.descriptor, "FontFile3").dict, "Subtype") === "Type1C") shape.kind = "simple-cff";
    else if (files.length === 1 && files[0] === "FontFile") shape.kind = "type1";
    if (files.length === 1) shape.programKey = files[0];
  } else if (subtype === "Type3") shape.kind = "type3";
  if (shape.programKey) shape.program = A.get(shape.descriptor, shape.programKey);
  for (const object of [shape.toUnicode, shape.program, shape.descriptor, shape.cidFont, A.get(dict, "Encoding"), A.get(dict, "CharProcs"), A.get(dict, "Widths"), A.get(shape.cidFont, "W"), A.get(shape.cidFont, "W2"),
    A.get(shape.cidFont, "CIDToGIDMap"), A.get(shape.descriptor, "CIDSet")]) {
    if (object instanceof PDFDict || object instanceof PDFArray || object instanceof PDFStream) shape.shared.add(object);
  }
  return shape;
}

// ---------------------------------------------------------------- code -> glyph, per kind of font
/** code -> glyph number of a Type0 font with TrueType outlines: through /CIDToGIDMap. */
function cidToGlyph(shape) {
  const map = A.get(shape.cidFont, "CIDToGIDMap");
  if (map === undefined || (A.isName(map) && A.nameOf(map) === "Identity")) return (cid) => cid;
  if (!(map instanceof PDFStream)) refuse("cid-to-gid");
  let bytes;
  try {
    bytes = A.streamBytes(map);
  } catch {
    return refuse("cid-to-gid");
  }
  return (cid) => (cid * 2 + 1 < bytes.length ? (bytes[cid * 2] << 8) | bytes[cid * 2 + 1] : 0);
}

/**
 * code -> glyph number of a simple TrueType font (ISO 32000-1 9.6.6.4), or 0 when the code shows no glyph.
 * A font with an encoding that names glyphs is looked up by name: the Unicode cmap, the Macintosh cmap, the
 * glyph names of the font. A symbolic font is looked up by code: the (3,0) cmap (also at F000 + code), the
 * (1,0) cmap. Viewers differ in which of these they try first, so every way the font offers must lead to the
 * same glyph; a code for which they differ makes the font "ambiguous": refused.
 */
function simpleTrueTypeGlyphs(shape, tt) {
  const flags = A.getNum(shape.descriptor, "Flags") ?? 0;
  const symbolic = (flags & 4) !== 0;
  const nonsymbolic = (flags & 32) !== 0;
  const encoding = simpleEncoding(shape.dict);
  const cmapTable = tt.sfnt.tables.get("cmap");
  const subtables = cmapTable ? parseCmap(cmapTable) : [];
  const mapOf = (test) => subtables.filter((sub) => test(sub));
  const unicodeMaps = mapOf((sub) => (sub.platform === 3 && (sub.encoding === 1 || sub.encoding === 10)) || sub.platform === 0);
  const symbolMaps = mapOf((sub) => sub.platform === 3 && sub.encoding === 0);
  const macMaps = mapOf((sub) => sub.platform === 1 && sub.encoding === 0);
  for (const sub of [...unicodeMaps, ...symbolMaps, ...macMaps]) if (!sub.map) refuse("cmap-format");
  const names = postGlyphNames(tt.sfnt.tables.get("post"), tt.numGlyphs);
  const glyphOfName = new Map();
  if (names) names.forEach((name, glyph) => typeof name === "string" && !glyphOfName.has(name) && glyphOfName.set(name, glyph));
  const byName = encoding.has || (nonsymbolic && !symbolic);
  const byCode = !encoding.has || symbolic || !nonsymbolic;
  const baseTable = encoding.base ? ENCODINGS[encoding.base] : ENCODINGS.StandardEncoding;
  const macCodeOf = new Map();
  ENCODINGS.MacRomanEncoding.forEach((name, code) => name && !macCodeOf.has(name) && macCodeOf.set(name, code));
  return (code) => {
    const found = new Set();
    const add = (glyph) => {
      if (glyph) found.add(glyph);
    };
    if (byName) {
      const name = encoding.differences.get(code) ?? baseTable[code];
      if (name && name !== ".notdef") {
        const unicode = unicodeOfGlyphName(name);
        const mac = macCodeOf.get(name);
        const named = glyphOfName.get(name);
        // a name none of the ways can resolve: what a viewer shows for it is its own invention
        if (unicode === undefined && mac === undefined && named === undefined) refuse("glyph-name");
        if (unicode !== undefined) for (const sub of unicodeMaps) add(sub.map.get(unicode));
        if (mac !== undefined) for (const sub of macMaps) add(sub.map.get(mac));
        add(named);
      }
    }
    if (byCode) {
      for (const sub of symbolMaps) for (const high of [0, 0xf000, 0xf100, 0xf200]) add(sub.map.get(high | code));
      for (const sub of macMaps) add(sub.map.get(code));
    }
    if (found.size > 1) refuse("ambiguous-encoding");
    const [glyph] = found;
    return glyph !== undefined && glyph < tt.numGlyphs ? glyph : 0;
  };
}

/** code -> glyph number of a simple font with a name-keyed CFF program, or 0. */
function simpleCffGlyphs(shape, cff) {
  const encoding = simpleEncoding(shape.dict);
  const builtIn = cff.encoding;
  const supplements = new Map();
  if (builtIn !== "standard") {
    for (const [code, sid] of builtIn.supplements) {
      // (the name of the supplement is the name of a glyph: found through the charset)
      for (let glyph = 1; glyph < cff.nGlyphs; glyph++) if (cff.charset[glyph] === sid) supplements.set(code, glyph);
    }
  }
  const viaBuiltIn = (code) => (builtIn === "standard" ? cff.glyphOfName.get(ENCODINGS.StandardEncoding[code]) : builtIn.codes.get(code) ?? supplements.get(code));
  return (code) => {
    const found = new Set();
    const add = (glyph) => {
      if (glyph) found.add(glyph);
    };
    const different = encoding.differences.get(code);
    if (different !== undefined) add(cff.glyphOfName.get(different));
    else if (encoding.base) add(cff.glyphOfName.get(ENCODINGS[encoding.base][code]));
    else {
      // no base encoding: the built-in one of the program (some viewers take the standard encoding for a font
      // that is not symbolic: both must agree)
      add(viaBuiltIn(code));
      if (((A.getNum(shape.descriptor, "Flags") ?? 0) & 4) === 0) add(cff.glyphOfName.get(ENCODINGS.StandardEncoding[code]));
    }
    if (found.size > 1) refuse("ambiguous-encoding");
    const [glyph] = found;
    return glyph ?? 0;
  };
}

// ---------------------------------------------------------------- planning the edits of a group of fonts
const keysOf = (...maps) => {
  const out = new Set();
  for (const map of maps) for (const key of map.keys()) out.add(key);
  return out;
};
const byteCodes = (codes) => {
  const out = new Set();
  for (const item of codes.values()) if (item.length === 1) out.add(item.code);
  return out;
};
const cidsOf = (codes) => {
  const out = new Set();
  for (const item of codes.values()) out.add(item.cid);
  return out;
};
const without = (set, other) => new Set([...set].filter((item) => !other.has(item)));
const union = (sets) => {
  const out = new Set();
  for (const set of sets) for (const item of set) out.add(item);
  return out;
};

/** A new stream with the entries of the old one (but its length and filter), holding `bytes`. */
function replaceStream(context, holder, key, old, bytes, extra = {}) {
  const fresh = context.flateStream(bytes, extra);
  for (const [name, value] of old.dict.entries()) {
    const text = name.decodeText();
    if (["Length", "Filter", "DecodeParms", "DL", "Length1", "Metadata"].includes(text) || fresh.dict.has(name)) continue;
    fresh.dict.set(name, value);
  }
  const raw = A.getRaw(holder, key);
  if (raw instanceof PDFRef) context.assign(raw, fresh);
  else holder.set(A.N(key), context.register(fresh));
}

/** The codes FirstChar .. LastChar of a simple font (the codes its /Widths array speaks of). */
function codeRange(dict) {
  const widths = A.get(dict, "Widths");
  const first = A.getNum(dict, "FirstChar") ?? 0;
  const count = A.isArray(widths) ? widths.size() : Math.max(0, (A.getNum(dict, "LastChar") ?? first - 1) - first + 1);
  return Array.from({ length: Math.min(256, count) }, (_, k) => first + k);
}

/**
 * Plans what is taken out of the fonts of one group (font dictionaries that share an object: mostly one font).
 *   members   [{ entry, shape, shown: Map, freed: Map, ever: Map }]
 * Returns { edits: functions to run, codes, widths, glyphs } (nothing is changed before all of it is planned),
 * or throws FontProgramError with a reason token.
 */
function planGroup(members, pdfDoc) {
  const context = pdfDoc.context;
  const edits = [];
  const counts = { codes: 0, widths: 0, glyphs: 0 };
  const sharing = (object) => members.filter((member) => member.shape.shared.has(object));
  const kinds = new Set(members.map((member) => member.shape.kind));
  if (kinds.has("other")) refuse("font-type");
  if (kinds.has("type1")) refuse("type1");
  const simple = (member) => !member.shape.cidFont;
  // a simple font NAMES the glyphs of its codes when it has an /Encoding (or is a Type3 font); otherwise its
  // codes are numbers of its own
  const named = (member) => member.shape.kind === "type3" || simpleEncoding(member.shape.dict).has;

  // ---- ToUnicode: per stream, for the fonts that use it
  for (const stream of new Set(members.map((member) => member.shape.toUnicode).filter(Boolean))) {
    const users = sharing(stream);
    const shown = keysOf(...users.map((user) => user.shown));
    const drop = without(keysOf(...users.map((user) => user.freed)), shown);
    if (!drop.size) continue;
    let bytes;
    try {
      bytes = A.streamBytes(stream);
    } catch {
      return refuse("to-unicode");
    }
    const ever = keysOf(...users.map((user) => user.ever));
    const edited = editToUnicode(bytes, drop, ({ total, isMapped }) => {
      let mappedEver = 0;
      for (const key of ever) if (isMapped(key)) mappedEver++;
      if (!users.every(simple)) return complete(total - mappedEver, mappedEver);
      // a simple font: among the idle codes of its range, how many are mapped?
      let idleEmpty = 0;
      for (const code of union(users.map((user) => new Set(codeRange(user.shape.dict))))) if (!ever.has(`1:${code}`) && !isMapped(`1:${code}`)) idleEmpty++;
      return keepsIdle(users.some(named), total - mappedEver, idleEmpty);
    });
    if (!edited) continue;
    counts.codes += edited.dropped;
    const holder = users[0].shape.dict;
    edits.push(() => replaceStream(context, holder, "ToUnicode", stream, edited.bytes));
  }

  // ---- widths and differences of simple fonts (codes of one byte)
  for (const member of members.filter(simple)) {
    const dict = member.shape.dict;
    const widths = A.get(dict, "Widths");
    const first = A.getNum(dict, "FirstChar") ?? 0;
    const widthUsers = A.isArray(widths) ? sharing(widths) : [member];
    const everCodes = union(widthUsers.map((user) => byteCodes(user.ever)));
    const freedCodes = without(byteCodes(member.freed), union(widthUsers.map((user) => byteCodes(user.shown))));
    if (A.isArray(widths) && freedCodes.size) {
      let idleWithWidth = 0;
      let idleZero = 0;
      for (let i = 0; i < widths.size(); i++) {
        if (everCodes.has(first + i)) continue;
        if (A.num(widths.lookup(i))) idleWithWidth++;
        else idleZero++;
      }
      const doomed = [...freedCodes].filter((code) => code >= first && code - first < widths.size() && A.num(widths.lookup(code - first)));
      if (doomed.length && !keepsIdle(named(member), idleWithWidth, idleZero)) {
        counts.widths += doomed.length;
        edits.push(() => doomed.forEach((code) => widths.set(code - first, PDFNumber.of(0))));
      }
    }
    const encoding = simpleEncoding(dict);
    const list = encoding.dict ? A.get(encoding.dict, "Differences") : undefined;
    if (A.isArray(list) && freedCodes.size) {
      const users = sharing(encoding.dict).length ? sharing(encoding.dict) : [member];
      const ever = union(users.map((user) => byteCodes(user.ever)));
      const keep = union(users.map((user) => byteCodes(user.shown)));
      const doomed = [...freedCodes].filter((code) => encoding.differences.has(code) && !keep.has(code));
      const idleNamed = [...encoding.differences.keys()].filter((code) => !ever.has(code)).length;
      const idleBare = codeRange(dict).filter((code) => !ever.has(code) && !encoding.differences.has(code)).length;
      if (doomed.length && !keepsIdle(true, idleNamed, idleBare)) {
        edits.push(() => {
          const rebuilt = context.obj([]);
          let previous = -2;
          for (const code of [...encoding.differences.keys()].sort((a, b) => a - b)) {
            if (doomed.includes(code)) continue;
            if (code !== previous + 1) rebuilt.push(PDFNumber.of(code));
            rebuilt.push(A.N(encoding.differences.get(code)));
            previous = code;
          }
          const raw = A.getRaw(encoding.dict, "Differences");
          if (raw instanceof PDFRef) context.assign(raw, rebuilt);
          else encoding.dict.set(A.N("Differences"), rebuilt);
        });
      }
    }
  }

  // ---- Type3: the glyph procedures
  for (const procs of new Set(members.filter((member) => member.shape.kind === "type3").map((member) => A.get(member.shape.dict, "CharProcs")).filter((value) => value instanceof PDFDict))) {
    const users = members.filter((member) => member.shape.kind === "type3" && A.get(member.shape.dict, "CharProcs") === procs);
    const namesOf = (user, codeSet) => {
      const encoding = simpleEncoding(user.shape.dict);
      const base = encoding.base ? ENCODINGS[encoding.base] : null;
      const out = new Set();
      for (const code of codeSet) {
        const name = encoding.differences.get(code) ?? (base ? base[code] : undefined);
        if (name) out.add(name);
      }
      return out;
    };
    const needed = union(users.map((user) => namesOf(user, byteCodes(user.shown))));
    const ever = union(users.map((user) => namesOf(user, byteCodes(user.ever))));
    const doomed = [...without(union(users.map((user) => namesOf(user, byteCodes(user.freed)))), needed)].filter((name) => procs.has(A.N(name)));
    // idle codes of the fonts: those with a glyph procedure against those without
    const idleNames = union(users.map((user) => namesOf(user, new Set(codeRange(user.shape.dict).filter((code) => !byteCodes(user.ever).has(code))))));
    const idleWithProc = procs.keys().filter((key) => !ever.has(key.decodeText())).length;
    const idleWithout = [...idleNames].filter((name) => !ever.has(name) && !procs.has(A.N(name))).length + union(users.map((user) => new Set(codeRange(user.shape.dict).filter((code) => !byteCodes(user.ever).has(code) && !namesOf(user, new Set([code])).size)))).size;
    if (!doomed.length || keepsIdle(true, idleWithProc, idleWithout)) continue;
    counts.glyphs += doomed.length;
    edits.push(() => {
      doomed.forEach((name) => procs.delete(A.N(name)));
      // what only the deleted procedures drew (the picture of a bitmap glyph) leaves the resources of the font
      pruneResources(pdfDoc, users.map((user) => A.get(user.shape.dict, "Resources")));
    });
  }

  // ---- widths of CID fonts, per CIDFont dictionary
  for (const cidFont of new Set(members.map((member) => member.shape.cidFont).filter(Boolean))) {
    const users = sharing(cidFont);
    const shownCids = union(users.map((user) => cidsOf(user.shown)));
    const everCids = union(users.map((user) => cidsOf(user.ever)));
    const freedCids = without(union(users.map((user) => cidsOf(user.freed))), shownCids);
    for (const [key, step] of [["W", 1], ["W2", 3]]) {
      const array = A.get(cidFont, key);
      if (!A.isArray(array) || !freedCids.size) continue;
      const map = readCidWidths(array, step);
      const doomed = [...freedCids].filter((cid) => map.has(cid));
      const unused = [...map.keys()].filter((cid) => !everCids.has(cid)).length;
      if (!doomed.length || complete(unused, map.size - unused)) continue;
      counts.widths += doomed.length;
      edits.push(() => {
        for (const cid of doomed) map.delete(cid);
        const rebuilt = writeCidWidths(map, context);
        const raw = A.getRaw(cidFont, key);
        if (raw instanceof PDFRef) context.assign(raw, rebuilt);
        else cidFont.set(A.N(key), rebuilt);
      });
    }
  }

  // ---- the font programs
  for (const program of new Set(members.map((member) => member.shape.program).filter(Boolean))) {
    const users = sharing(program);
    const family = (user) => (user.shape.kind.endsWith("truetype") ? "truetype" : user.shape.kind.endsWith("cff") ? "cff" : "other");
    // (Word writes one TrueType program for two fonts: a Type0 font and a simple one for the plain characters)
    if (users.some((user) => family(user) !== family(users[0]) || family(user) === "other")) refuse("shared-program");
    let bytes;
    try {
      bytes = A.streamBytes(program);
    } catch {
      return refuse("program-stream");
    }
    if (family(users[0]) === "truetype") {
      const tt = readTrueType(bytes);
      const anySimple = users.some(simple);
      const glyphsOf = users.map((user) => {
        if (simple(user)) {
          const glyphOf = simpleTrueTypeGlyphs(user.shape, tt);
          return (codeMap) => [...byteCodes(codeMap)].map(glyphOf);
        }
        const glyphOf = cidToGlyph(user.shape);
        return (codeMap) => [...cidsOf(codeMap)].map(glyphOf);
      });
      const collect = (pick) => users.flatMap((user, index) => glyphsOf[index](pick(user)));
      const needed = glyphClosure(tt, [0, ...collect((user) => user.shown)]);
      const ever = glyphClosure(tt, [0, ...collect((user) => user.ever)]);
      const doomed = [...glyphClosure(tt, collect((user) => user.freed))].filter((glyph) => !needed.has(glyph) && glyph !== 0 && tt.outlined(glyph));
      if (!doomed.length) continue;
      let unusedOutlined = 0;
      let unusedEmpty = 0;
      let unusedEmptyWithAdvance = 0;
      let usedOutlined = 0;
      for (let glyph = 1; glyph < tt.numGlyphs; glyph++) {
        if (ever.has(glyph)) {
          if (tt.outlined(glyph)) usedOutlined++;
        } else if (tt.outlined(glyph)) unusedOutlined++;
        else {
          unusedEmpty++;
          if (tt.advanceOf(glyph)) unusedEmptyWithAdvance++;
        }
      }
      if (complete(unusedOutlined, usedOutlined, unusedEmpty)) continue;
      const blank = new Set(doomed);
      // the cmap: mappings to an emptied glyph name the character it was (unless the table maps the whole font)
      let cmap = "keep";
      const cmapTable = tt.sfnt.tables.get("cmap");
      if (cmapTable) {
        const subtables = parseCmap(cmapTable);
        const readable = subtables.filter((sub) => sub.map);
        const pointsAtBlank = readable.some((sub) => [...sub.map.values()].some((glyph) => blank.has(glyph)));
        const mappedUnused = new Set(readable.flatMap((sub) => [...sub.map.values()]).filter((glyph) => !ever.has(glyph))).size;
        const wholeFont = complete(mappedUnused, usedOutlined);
        const stripped = () => buildCmap(readable.map((sub) => ({ ...sub, map: new Map([...sub.map].filter(([, glyph]) => !blank.has(glyph))) })));
        if (!anySimple) {
          // (a font that is addressed by glyph number needs no cmap: a table that cannot be judged goes)
          if (readable.length !== subtables.length) cmap = "drop";
          else if (pointsAtBlank && !wholeFont) cmap = stripped();
        } else if (pointsAtBlank && !wholeFont) {
          // only the subtables this module reads are written again (those a viewer of a simple font uses were read)
          cmap = stripped();
        }
      }
      // glyph names
      let post = "keep";
      const postTable = tt.sfnt.tables.get("post");
      const names = postGlyphNames(postTable, tt.numGlyphs);
      if (names) {
        const namedUnused = names.filter((name, glyph) => glyph > 0 && !ever.has(glyph) && name !== 0).length;
        if (!complete(namedUnused, usedOutlined)) post = anySimple ? renamePostGlyphs(postTable, tt.numGlyphs, blank) : "strip";
      }
      // an advance is kept where the font keeps the advances of glyphs it does not have (an emptied glyph then looks like them)
      const rewritten = rewriteTrueType(tt, { blank, zeroAdvance: unusedEmptyWithAdvance === 0, cmap, post });
      counts.glyphs += rewritten.blanked;
      for (const descriptor of new Set(users.map((user) => user.shape.descriptor))) {
        edits.push(() => replaceStream(context, descriptor, "FontFile2", program, rewritten.bytes, { Length1: rewritten.bytes.length }));
        const cidSet = A.get(descriptor, "CIDSet");
        if (!(cidSet instanceof PDFStream)) continue;
        // the bits of the CIDs whose glyph went (a CID is looked up as a viewer does: through the map of each font)
        const cidsGone = new Set();
        for (const user of users.filter((item) => item.shape.descriptor === descriptor && !simple(item))) {
          const glyphOf = cidToGlyph(user.shape);
          for (const cid of cidsOf(user.freed)) if (blank.has(glyphOf(cid))) cidsGone.add(cid);
        }
        let bits = null;
        try {
          bits = A.streamBytes(cidSet).slice();
        } catch {
          bits = null;
        }
        if (bits) {
          for (const cid of cidsGone) if ((cid >> 3) < bits.length) bits[cid >> 3] &= ~(0x80 >> (cid & 7));
          edits.push(() => replaceStream(context, descriptor, "CIDSet", cidSet, bits));
        } else edits.push(() => descriptor.delete(A.N("CIDSet")));
      }
    } else {
      const kind = users[0].shape.kind;
      if (users.some((user) => user.shape.kind !== kind)) refuse("shared-program");
      const cff = readCff(bytes);
      if ((kind === "type0-cff") !== cff.isCID) refuse("cff-keying");
      const glyphsOf = users.map((user) => {
        if (kind === "simple-cff") {
          const glyphOf = simpleCffGlyphs(user.shape, cff);
          return (codeMap) => [...byteCodes(codeMap)].map(glyphOf);
        }
        return (codeMap) => [...cidsOf(codeMap)].map((cid) => cff.glyphOfCid.get(cid) ?? 0);
      });
      const collect = (pick) => new Set(users.flatMap((user, index) => glyphsOf[index](pick(user))));
      const needed = collect((user) => user.shown);
      const ever = collect((user) => user.ever);
      const remove = new Set([...collect((user) => user.freed)].filter((glyph) => glyph > 0 && !needed.has(glyph)));
      if (!remove.size) continue;
      let unused = 0;
      let used = 0;
      for (let glyph = 1; glyph < cff.nGlyphs; glyph++) {
        if (ever.has(glyph)) used++;
        else if (!isEmptyCharstring(cff.charStrings[glyph])) unused++;
      }
      if (complete(unused, used)) continue;
      const rewritten = rewriteCff(cff, { remove });
      counts.glyphs += rewritten.removed;
      for (const descriptor of new Set(users.map((user) => user.shape.descriptor))) {
        edits.push(() => replaceStream(context, descriptor, "FontFile3", program, rewritten.bytes));
        // (/CharSet and /CIDSet list what a subset holds: optional, and wrong once a glyph is gone)
        for (const key of ["CharSet", "CIDSet"]) if (A.get(descriptor, key) !== undefined) edits.push(() => descriptor.delete(A.N(key)));
      }
    }
  }
  return { edits, ...counts };
}

/**
 * The fonts of a document and how much they hold beyond what the document shows (diagnostics and tests):
 * [{ id, font, kind, pages, shown (codes), unknown, toUnicode: { mapped, unused } | null,
 *    program: { glyphs, used, unusedOutlined, unusedEmpty } | null, complete: would the program count as a whole font? }].
 */
export function fontInventory(pdfDoc) {
  const scanner = createScanner(pdfDoc);
  scanner.resources();
  scanner.content();
  const out = [];
  for (const entry of scanner.fonts.values()) {
    const shape = shapeOf(entry.dict);
    const row = { id: entry.id, font: shape.name, kind: shape.kind, pages: [...entry.pages].sort((a, b) => a - b), shown: entry.codes.size, unknown: entry.unknown, toUnicode: null, program: null, complete: false };
    try {
      if (shape.toUnicode) {
        const { ranges } = readToUnicode(A.streamBytes(shape.toUnicode));
        const mapped = ranges.reduce((sum, range) => sum + range.hi - range.lo + 1, 0);
        const used = [...entry.codes.values()].filter((item) => ranges.some((range) => range.length === item.length && item.code >= range.lo && item.code <= range.hi)).length;
        row.toUnicode = { mapped, unused: mapped - used };
      }
      if (shape.program && (shape.kind === "type0-truetype" || shape.kind === "simple-truetype")) {
        const tt = readTrueType(A.streamBytes(shape.program));
        const glyphOf = shape.kind === "simple-truetype" ? simpleTrueTypeGlyphs(shape, tt) : cidToGlyph(shape);
        const codes = shape.kind === "simple-truetype" ? [...byteCodes(entry.codes)] : [...cidsOf(entry.codes)];
        const ever = glyphClosure(tt, [0, ...codes.map(glyphOf)]);
        const program = { glyphs: tt.numGlyphs, used: 0, unusedOutlined: 0, unusedEmpty: 0 };
        for (let glyph = 1; glyph < tt.numGlyphs; glyph++) {
          if (ever.has(glyph)) program.used += tt.outlined(glyph) ? 1 : 0;
          else if (tt.outlined(glyph)) program.unusedOutlined++;
          else program.unusedEmpty++;
        }
        row.program = program;
        row.complete = complete(program.unusedOutlined, program.used, program.unusedEmpty);
      } else if (shape.program && (shape.kind === "type0-cff" || shape.kind === "simple-cff")) {
        const cff = readCff(A.streamBytes(shape.program));
        const glyphOf = shape.kind === "simple-cff" ? simpleCffGlyphs(shape, cff) : (cid) => cff.glyphOfCid.get(cid) ?? 0;
        const codes = shape.kind === "simple-cff" ? [...byteCodes(entry.codes)] : [...cidsOf(entry.codes)];
        const ever = new Set(codes.map(glyphOf));
        const program = { glyphs: cff.nGlyphs, used: 0, unusedOutlined: 0, unusedEmpty: 0 };
        for (let glyph = 1; glyph < cff.nGlyphs; glyph++) {
          if (ever.has(glyph)) program.used++;
          else if (isEmptyCharstring(cff.charStrings[glyph])) program.unusedEmpty++;
          else program.unusedOutlined++;
        }
        row.program = program;
        row.complete = complete(program.unusedOutlined, program.used);
      }
    } catch (error) {
      if (!(error instanceof FontProgramError)) throw error;
      row.refused = error.message;
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- the clean-up
/** Does the font hold anything that belongs to single codes: a program, widths, a ToUnicode map, glyph procedures? */
function holdsCodeData(shape) {
  return Boolean(shape.program || shape.toUnicode || A.isArray(A.get(shape.dict, "Widths")) || A.isArray(A.get(shape.cidFont, "W")) || A.get(shape.dict, "CharProcs") instanceof PDFDict);
}

/**
 * The base font names of the fonts that the pages and the form of `pdfDoc` can still reach. redactPdf() asks
 * after the pages that become pictures were replaced: a font of notCleaned that is not among them left the
 * file with those pages and holds nothing any more.
 */
export function fontNamesIn(pdfDoc) {
  const scanner = createScanner(pdfDoc);
  scanner.resources();
  scanner.formFonts();
  return new Set([...scanner.fonts.values()].map((entry) => BASE_NAME(entry.dict)));
}

/**
 * Takes out of the fonts of `pdfDoc` what belongs to codes that were shown before the job and that nothing
 * shows any more. Call it after the pages were edited (and after the pages that become pictures were replaced,
 * or with their indexes in `skipPages`).
 *   before      usedBy() of the pages the job changes, from the document as it was loaded
 *   skipPages   Set of page indexes whose content does not count any more (they are being replaced by pictures)
 *   enabled     false: nothing is edited; every font that would have been is reported in notCleaned
 * Returns {
 *   cleaned:     [{ font, codes, widths, glyphs }]    fonts that were edited (codes: ToUnicode mappings deleted,
 *                                                     widths: width entries emptied, glyphs: outlines or
 *                                                     glyph procedures taken out)
 *   notCleaned:  [{ font, pageIndexes, reason }]      fonts that still hold glyphs of freed codes. pageIndexes:
 *                                                     the pages that show text with the font (all pages that
 *                                                     can reach it when its use is not known); reason: a token
 *                                                     (for logs and tests; the interface shows one sentence
 *                                                     for all of them):
 *       "type1"                 a Type 1 program (its glyphs are encrypted)      "font-type"   a kind of font this module does not know
 *       "form-font"             the form fields may write with it (/AcroForm /DR)
 *       "referenced-elsewhere"  something that is no resource dictionary of drawn content points at the font
 *       "usage-unknown"         content that can reach the font could not be read
 *       "disabled"              the caller switched the clean-up off
 *       "shared-program"        fonts of different kinds share one font program
 *       "to-unicode" | "widths" | "encoding" | "cid-to-gid" | "cmap-format" | "glyph-name" | "ambiguous-encoding" |
 *       "cff-keying" | "program-stream"   that part of the font is not what this module can edit with certainty
 *       "font-program"          the font program itself is (damaged tables, tables that draw, an OpenType wrapper)
 *   released:    number of fonts nothing shows any more whose resource entries were deleted
 * }
 * `font` is the base font name; nothing in the result is text of a page.
 */
export function cleanFonts(pdfDoc, { before, skipPages = new Set(), enabled = true } = {}) {
  const result = { cleaned: [], notCleaned: [], released: 0 };
  if (!before || !before.size) return result;
  const context = pdfDoc.context;
  const scanner = createScanner(pdfDoc);
  scanner.resources({ skipPages });
  // ---- the fonts the job touched that are still referenced, and the fonts that share an object with them
  const candidates = [...scanner.fonts.values()].filter((entry) => entry.id !== null && before.has(entry.id));
  if (!candidates.length) return result;
  const shapes = new Map();
  for (const entry of scanner.fonts.values()) shapes.set(entry, shapeOf(entry.dict));
  const owner = new Map(); // shared object -> first font entry that uses it
  const parent = new Map();
  const find = (entry) => {
    while (parent.get(entry) !== entry) entry = parent.get(entry);
    return entry;
  };
  for (const entry of scanner.fonts.values()) parent.set(entry, entry);
  for (const [entry, shape] of shapes) {
    for (const object of shape.shared) {
      if (owner.has(object)) parent.set(find(entry), find(owner.get(object)));
      else owner.set(object, entry);
    }
  }
  const groups = new Map();
  for (const entry of scanner.fonts.values()) {
    const root = find(entry);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  }
  const wantedGroups = [...groups.values()].filter((group) => group.some((entry) => candidates.includes(entry)));
  const wanted = new Set(wantedGroups.flat());
  scanner.content({ skipPages, only: wanted });
  const open = scanner.formFonts();
  // ---- references to a wanted font from anywhere but the resource dictionaries of drawn content
  const ids = new Map([...wanted].filter((entry) => entry.id !== null).map((entry) => [entry.id, entry]));
  const stray = new Set();
  for (const ref of reachableRefs(pdfDoc)) {
    const object = context.lookup(ref);
    const stack = [object instanceof PDFStream ? object.dict : object];
    while (stack.length) {
      const holder = stack.pop();
      const children = holder instanceof PDFDict ? holder.values() : holder instanceof PDFArray ? holder.asArray() : [];
      for (const child of children) {
        if (child instanceof PDFRef) {
          const entry = ids.get(A.idOf(child));
          if (entry && !entry.holders.has(holder)) stray.add(entry);
        } else if (child instanceof PDFDict || child instanceof PDFArray) stack.push(child);
      }
    }
  }

  const pagesOf = (entry) => [...(entry.unknown || open.has(entry) || stray.has(entry) ? new Set([...entry.pages, ...entry.referencedBy]) : entry.pages)].sort((a, b) => a - b);
  for (const group of wantedGroups) {
    const members = group.map((entry) => {
      const was = entry.id !== null ? before.get(entry.id) : undefined;
      const shown = entry.codes;
      const freed = new Map();
      if (was) for (const [key, value] of was.codes) if (!shown.has(key)) freed.set(key, value);
      const ever = new Map(shown);
      if (was) for (const [key, value] of was.codes) ever.set(key, value);
      return { entry, shape: shapes.get(entry), shown, freed, ever, was };
    });
    const touched = members.filter((member) => member.freed.size > 0 || member.was?.unknown);
    if (!touched.length) continue;
    const report = (reason) => {
      for (const member of touched) if (holdsCodeData(member.shape)) result.notCleaned.push({ font: member.shape.name, pageIndexes: pagesOf(member.entry), reason });
    };
    // ---- a font nothing shows any more: its resource entries are released (it leaves the file with the garbage)
    for (const member of touched) {
      const { entry } = member;
      if (entry.codes.size || entry.unknown || entry.pages.size || open.has(entry) || stray.has(entry)) continue;
      const owners = [...entry.holders].flatMap((holder) => [...(scanner.fontDictOwners.get(holder) || [])]);
      if (!owners.length) continue;
      pruneResources(pdfDoc, owners, { categories: ["Font"] });
      for (const holder of [...entry.holders]) {
        const still = holder instanceof PDFDict ? holder.values().some((value) => value === entry.ref) : true;
        if (!still) entry.holders.delete(holder);
      }
      if (!entry.holders.size) {
        member.released = true;
        result.released++;
      }
    }
    if (touched.every((member) => member.released)) continue;
    // ---- can the use of every font of the group be told?
    const blocked = members.find((member) => member.entry.unknown || member.was?.unknown || open.has(member.entry) || stray.has(member.entry));
    if (blocked) {
      report(open.has(blocked.entry) ? "form-font" : stray.has(blocked.entry) ? "referenced-elsewhere" : "usage-unknown");
      continue;
    }
    if (!enabled) {
      report("disabled");
      continue;
    }
    let plan;
    try {
      plan = planGroup(members, pdfDoc);
    } catch (error) {
      if (!(error instanceof FontProgramError)) throw error;
      report(error.message.length <= 24 && /^[a-z0-9-]+$/.test(error.message) ? error.message : "font-program");
      continue;
    }
    if (!plan.edits.length) continue;
    for (const edit of plan.edits) edit();
    for (const member of touched) result.cleaned.push({ font: member.shape.name, codes: plan.codes, widths: plan.widths, glyphs: plan.glyphs });
  }
  return result;
}

