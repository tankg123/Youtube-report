// Can this text be written as real PDF text with the bundled fonts? Pure functions over the entries of
// public/pdf-fonts/manifest.json: no DOM, no font parsing; runs under `node --test`.
//
// The policy (brief 5.4):
//   * a character the box font has                       -> real text in the box font
//   * a character only the fallback family (Arimo) has   -> real text in a fallback run, same weight / slant
//   * anything else (CJK, Thai, emoji, a combining mark that survives NFC, a glyph the font classifies as a
//     mark, a joiner or selector inside an emoji or complex-script sequence, a letter the browser builds
//     from parts of the box font)                        -> the WHOLE box is exported as a picture
// The decision is made per grapheme cluster and mirrors what the browser does with
// font-family: "<box face>", "<fallback face>". That is NOT simply "the first family that has the glyph":
// before a browser (HarfBuzz) gives a character to the next family it tries, with the font at hand,
//   1. to build the letter from its canonical parts: Be Vietnam Pro has no U+0108 (C with circumflex) but it
//      has C and the combining circumflex, so it draws the letter itself, and the fallback face never sees it
//   2. to draw a missing space character (en space, figure space, thin space ...) with its own space glyph
//      and a computed advance
//   3. to draw a missing no-break hyphen U+2011 with its hyphen U+2010.
// Measured in Chrome and Edge 157 for every code point of the 16 text faces in their font lists: 19,944 that
// go to the box face, 4,584 to the fallback face, 772 built from parts (all in Be Vietnam Pro: Esperanto,
// Latvian, Romanian, pinyin letters ...), 88 missing spaces; the browser's advance agreed with every decision.
//
// Character classes are built from numbers so that this source never holds an invisible or line-terminating
// character (a backslash-u escape written through an editing tool can end up as the literal character).
import { PdfEditorError } from "../engine/errors.js";
import { FALLBACK_TEXT_FONT, fontKeyOf } from "../model/schema.js";

const escapeCodePoint = (codePoint) => `\\u{${codePoint.toString(16)}}`;
const classBody = (ranges) => ranges.map(([first, last]) => (first === last ? escapeCodePoint(first) : `${escapeCodePoint(first)}-${escapeCodePoint(last)}`)).join("");
const charClass = (ranges, flags = "gu") => new RegExp(`[${classBody(ranges)}]`, flags);

const CARRIAGE_RETURN = String.fromCharCode(0x0d);
const LINE_FEED = String.fromCharCode(0x0a);
const TAB = String.fromCharCode(0x09);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
/** A tab becomes this many spaces (a PDF has no tab stops). */
export const TAB_SPACES = 4;

const CRLF = new RegExp(`${CARRIAGE_RETURN}${LINE_FEED}?`, "g");
/** Vertical tab, form feed, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR: all become a line feed. */
const LINE_SEPARATORS = charClass([[0x0b, 0x0c], [0x85, 0x85], [0x2028, 0x2029]]);
/** C0 and C1 controls other than the line feed (tab and carriage return are handled before). */
const CONTROLS = charClass([[0x00, 0x09], [0x0e, 0x1f], [0x7f, 0x9f]]);

/** Half a surrogate pair cannot be written to a PDF or to XML: it becomes U+FFFD, as browsers show it. */
function wellFormed(value) {
  if (typeof value.toWellFormed === "function") return value.toWellFormed();
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += REPLACEMENT_CHARACTER;
      }
    } else {
      out += unit >= 0xdc00 && unit <= 0xdfff ? REPLACEMENT_CHARACTER : value[index];
    }
  }
  return out;
}

/**
 * Invisible characters that change nothing a text box shows (hyphenation and ligatures are off) but that a
 * PDF writer would write as a glyph with an advance: removed everywhere. Soft hyphen, Mongolian vowel
 * separator, zero-width space, word joiner and invisible operators, deprecated format characters, BOM,
 * language tag.
 */
const ALWAYS_REMOVED = charClass([[0xad, 0xad], [0x180e, 0x180e], [0x200b, 0x200b], [0x2060, 0x2064], [0x206a, 0x206f], [0xfeff, 0xfeff], [0xe0001, 0xe0001]]);

// Format characters that DO change what is shown, but only next to characters no bundled font can write
// (emoji, Arabic, Indic scripts ...). They are kept there and removed everywhere else.
const JOINERS = [[0x200c, 0x200d]]; // ZWNJ, ZWJ: Persian word forms, Indic conjuncts, emoji ZWJ sequences
const BIDI_CONTROLS = [[0x61c, 0x61c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]];
const VARIATION_SELECTORS = [[0x180b, 0x180d], [0x180f, 0x180f], [0xfe00, 0xfe0f], [0xe0100, 0xe01ef]];
const TAGS = [[0xe0020, 0xe007f]]; // emoji tag sequences (subdivision flags)
const isJoiner = charClass(JOINERS, "u");
const isBidiControl = charClass(BIDI_CONTROLS, "u");
const isVariationSelector = charClass(VARIATION_SELECTORS, "u");
const isTag = charClass(TAGS, "u");
const FORMAT = charClass([...JOINERS, ...BIDI_CONTROLS, ...VARIATION_SELECTORS, ...TAGS], "u");

/** Scripts the bundled fonts can write (plus punctuation, digits, symbols and combining marks). */
const PLAIN_SCRIPT = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]$/u;
/** Pictographs, skin tones, flags, the keycap mark: shaped as sequences by an emoji font. */
const PICTOGRAPH = new RegExp(`^[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}${escapeCodePoint(0x20e3)}]$`, "u");
/** Characters with an emoji form (digits, # and * too: they are keycap bases). */
const EMOJI_CAPABLE = /^\p{Emoji}$/u;
/** Right-to-left scripts in modern use. */
const RTL = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;
const MARK = /\p{M}/u;

/** A character whose appearance can depend on a neighbouring joiner: a complex script or a pictograph. */
const isComplex = (char) => char !== undefined && char !== LINE_FEED && (!PLAIN_SCRIPT.test(char) || PICTOGRAPH.test(char));

/** True when the text holds a right-to-left character (such text is never exported as real text). */
export function hasRtl(text) {
  return RTL.test(text);
}

/** True for a format character that survived normalizeText (it belongs to an emoji or complex-script sequence). */
export function isFormatCharacter(char) {
  return FORMAT.test(char);
}

/**
 * True when a grapheme has to be shaped together with its neighbours (Arabic joining, Indic conjuncts, ...):
 * any character outside the scripts the bundled fonts write. The canvas rasteriser draws such sequences with
 * one call and everything else grapheme by grapheme.
 */
export function needsRunShaping(grapheme) {
  for (const char of grapheme) {
    if (!PLAIN_SCRIPT.test(char)) return true;
  }
  return false;
}

/**
 * Removes the joiners, bidi controls, variation selectors and tags that have no effect where they stand and
 * keeps the ones that are part of an emoji or complex-script sequence:
 *   - ZWJ / ZWNJ stay when the nearest real character on either side is complex
 *   - a variation selector stays when its base is complex or has an emoji form (Chrome switches to the colour
 *     emoji font for U+00A9 U+FE0F although the box font has U+00A9)
 *   - an emoji tag stays after a pictograph (or another kept tag)
 *   - bidi controls stay on a line that has right-to-left text
 * Every decision depends on real characters only, so the function is idempotent.
 */
function dropIdleFormatCharacters(text) {
  const chars = Array.from(text);
  const count = chars.length;
  const format = chars.map((char) => FORMAT.test(char));
  // nearest real (non-format) character before / after each position, not crossing a line break
  const previousReal = new Array(count);
  const nextReal = new Array(count);
  let last;
  for (let index = 0; index < count; index += 1) {
    previousReal[index] = last;
    if (chars[index] === LINE_FEED) last = undefined;
    else if (!format[index]) last = chars[index];
  }
  last = undefined;
  for (let index = count - 1; index >= 0; index -= 1) {
    nextReal[index] = last;
    if (chars[index] === LINE_FEED) last = undefined;
    else if (!format[index]) last = chars[index];
  }
  // does the line of each position hold right-to-left text?
  const rtlLine = new Array(count).fill(false);
  for (let start = 0; start <= count;) {
    let end = start;
    let rtl = false;
    while (end < count && chars[end] !== LINE_FEED) {
      if (!rtl && RTL.test(chars[end])) rtl = true;
      end += 1;
    }
    if (rtl) rtlLine.fill(true, start, end);
    start = end + 1;
  }
  let out = "";
  let tagBaseOk = false; // the previous kept character is a pictograph or a kept tag
  for (let index = 0; index < count; index += 1) {
    const char = chars[index];
    let keep = true;
    if (format[index]) {
      if (isJoiner.test(char)) keep = isComplex(previousReal[index]) || isComplex(nextReal[index]);
      else if (isBidiControl.test(char)) keep = rtlLine[index];
      else if (isVariationSelector.test(char)) keep = previousReal[index] !== undefined && (isComplex(previousReal[index]) || EMOJI_CAPABLE.test(previousReal[index]));
      else if (isTag.test(char)) keep = tagBaseOk;
    }
    if (!keep) continue;
    out += char;
    if (isTag.test(char)) tagBaseOk = true;
    else if (!isVariationSelector.test(char) && !isJoiner.test(char)) tagBaseOk = PICTOGRAPH.test(char);
  }
  return out;
}

/**
 * The canonical form of text-box content. Apply it to everything the user types or pastes BEFORE the text is
 * stored, measured or exported (it is idempotent, and the result is what model/schema.js calls an NFC string):
 *   - line separators (CR LF, CR, VT, FF, NEL, U+2028, U+2029) become "\n"; a tab becomes TAB_SPACES spaces
 *   - controls and invisible characters that never matter are removed; half a surrogate pair becomes U+FFFD
 *   - joiners, bidi controls, variation selectors and emoji tags are removed where they have no effect and
 *     KEPT inside emoji and complex-script sequences: such text is drawn as a picture anyway and must look
 *     the way the user pasted it (checkText reports the kept characters with the reason "format")
 *   - NFC last: the PDF writer maps one code point to one glyph and does not position combining marks
 */
export function normalizeText(text) {
  let value = wellFormed(String(text ?? ""))
    .replace(CRLF, LINE_FEED)
    .replace(LINE_SEPARATORS, LINE_FEED)
    .replaceAll(TAB, " ".repeat(TAB_SPACES))
    .replace(ALWAYS_REMOVED, "")
    .replace(CONTROLS, "");
  if (FORMAT.test(value)) value = dropIdleFormatCharacters(value);
  return value.normalize("NFC");
}

/** True when a text has nothing to show (empty, or spaces and line breaks only): such a box is discarded. */
export function isBlankText(text) {
  return String(text ?? "").trim() === "";
}

// --- graphemes ---

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
// Without Intl.Segmenter (Firefox before 125): a base character with the marks, joined characters, selectors
// and tags that follow it. Coarser than UAX 29 for scripts the bundled fonts do not write anyway.
const EXTENDER = new RegExp(`^(?:\\p{M}|[${classBody([...JOINERS, ...VARIATION_SELECTORS, ...TAGS])}]|\\p{Emoji_Modifier})$`, "u");
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);

/**
 * The grapheme clusters of a text: [{ segment, index }] with `index` = UTF-16 offset.
 * A line feed is always a cluster of its own.
 */
export function graphemes(text) {
  const value = String(text ?? "");
  if (segmenter) {
    const out = [];
    for (const { segment, index } of segmenter.segment(value)) out.push({ segment, index });
    return out;
  }
  const out = [];
  let index = 0;
  let joined = false;
  for (const char of value) {
    const previous = out[out.length - 1];
    if (previous && char !== LINE_FEED && previous.segment !== LINE_FEED && (joined || EXTENDER.test(char))) previous.segment += char;
    else out.push({ segment: char, index });
    joined = char === ZERO_WIDTH_JOINER;
    index += char.length;
  }
  return out;
}

// --- the manifest ---

/** Binary search in the manifest's inclusive [first, last] code point ranges of one font entry. */
export function hasGlyph(font, codePoint) {
  const ranges = font.codePointRanges;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (codePoint < ranges[middle][0]) high = middle - 1;
    else if (codePoint > ranges[middle][1]) low = middle + 1;
    else return true;
  }
  return false;
}

const indexes = new WeakMap();
function indexOf(manifest) {
  let index = indexes.get(manifest);
  if (!index) {
    index = { byKey: new Map(manifest.fonts.map((font) => [font.id, font])), plans: new Map() };
    indexes.set(manifest, index);
  }
  return index;
}

/** The manifest entry of a font face, or null. */
export function findFont(manifest, fontKey) {
  return indexOf(manifest).byKey.get(fontKey) || null;
}

function requireFont(manifest, fontKey) {
  const font = findFont(manifest, fontKey);
  if (!font) throw new PdfEditorError("TEXT_FONT_UNKNOWN", { font: String(fontKey) });
  return font;
}

/**
 * The face that writes what a text face lacks: the fallback family of model/schema.js in the same weight and
 * slant. null for a face of the fallback family itself and for faces that are never embedded as text
 * (signature fonts).
 */
export function fallbackKeyFor(manifest, fontKey) {
  const font = findFont(manifest, fontKey);
  if (!font || font.role !== "text") return null;
  const key = fontKeyOf(FALLBACK_TEXT_FONT, font.weight >= 600, Boolean(font.italic));
  return key !== font.id && findFont(manifest, key) ? key : null;
}

/** Space characters a browser draws with the font's own space glyph when the font has no glyph for them. */
const SYNTHETIC_SPACES = new Set([0xa0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]);
const SPACE = 0x20;
const HYPHEN = 0x2010;
const NO_BREAK_HYPHEN = 0x2011;

/**
 * Does a browser build this character, which the font has no glyph for, from parts the font does have? It
 * splits the character into (the rest, its last mark) as long as it has to, and succeeds when the font has
 * every mark on the way and the letter that is left.
 */
function composedFromParts(font, codePoint) {
  let current = codePoint;
  for (let depth = 0; depth < 8; depth += 1) {
    const parts = Array.from(String.fromCodePoint(current).normalize("NFD"), (char) => char.codePointAt(0));
    if (parts.length === 1) {
      if (parts[0] === current) return false; // nothing to split
      current = parts[0]; // a singleton mapping
    } else {
      if (!hasGlyph(font, parts[parts.length - 1])) return false;
      const rest = Array.from(String.fromCodePoint(...parts.slice(0, -1)).normalize("NFC"));
      if (rest.length !== 1) return false;
      current = rest[0].codePointAt(0);
    }
    if (hasGlyph(font, current)) return true;
  }
  return false;
}

/**
 * Why one font cannot write a grapheme cluster as real text (every code point is checked), or null:
 *   "format"   a joiner, bidi control, variation selector or tag that normalizeText kept: part of an emoji or
 *              complex-script sequence, which is never plain text
 *   "missing"  the font has no glyph (the browser shows another font, the PDF would show .notdef)
 *   "mark"     a combining mark survived NFC: the browser positions it with GPOS, the PDF writer does not
 *   "unsafe"   the font classifies the glyph as a mark, so the browser gives it no advance (manifest list)
 */
export function exportProblem(font, grapheme) {
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0);
    if (codePoint === 0x0a) continue;
    if (FORMAT.test(char)) return "format";
    if (!hasGlyph(font, codePoint)) return "missing";
    if (MARK.test(char)) return "mark";
    if (font.unsafeCodePoints && font.unsafeCodePoints.includes(codePoint)) return "unsafe";
  }
  return null;
}

/**
 * The font decisions of one box font, cached per manifest:
 *   { primaryKey, fallbackKey, primary, fallback, classify(grapheme) }
 * classify() answers { font, reason, alone }:
 *   font    the face that writes the cluster as real text, or null
 *   reason  why not, when font is null: what exportProblem says about the box font, or
 *             "composed"     the box font has no glyph but the browser builds the letter from the font's own
 *                            base letter and combining marks (the PDF library cannot)
 *             "substituted"  the browser draws the box font's hyphen for a missing no-break hyphen
 *   alone   true for a space the browser draws with the box font's space glyph and a computed advance while
 *           the PDF gets the fallback face's glyph: the cluster must be a run of its own, so that whatever
 *           follows it is placed from the measured position and not from that glyph's advance
 */
export function fontPlan(manifest, fontKey) {
  const index = indexOf(manifest);
  let plan = index.plans.get(fontKey);
  if (plan) return plan;
  const primary = requireFont(manifest, fontKey);
  const fallbackKey = fallbackKeyFor(manifest, fontKey);
  const fallback = fallbackKey ? findFont(manifest, fallbackKey) : null;
  const known = new Map();
  const viaPrimary = Object.freeze({ font: primary.id, reason: null, alone: false });
  const viaFallback = Object.freeze({ font: fallbackKey, reason: null, alone: false });
  const viaFallbackAlone = Object.freeze({ font: fallbackKey, reason: null, alone: true });
  const refused = (reason) => Object.freeze({ font: null, reason, alone: false });
  const classify = (grapheme) => {
    let result = known.get(grapheme);
    if (result) return result;
    const reason = exportProblem(primary, grapheme);
    const codePoint = grapheme.codePointAt(0);
    const single = grapheme.length === String.fromCodePoint(codePoint).length;
    const writable = Boolean(fallback) && !exportProblem(fallback, grapheme);
    if (!reason) result = viaPrimary;
    // A glyph the box font HAS but cannot write as text (a mark-class glyph, a surviving combining mark) is
    // still drawn by the box font on screen: only a missing glyph can go to the fallback face.
    else if (reason !== "missing") result = refused(reason);
    // ... and of the missing ones, not those the browser makes up from the box font itself:
    else if (single && composedFromParts(primary, codePoint)) result = refused("composed");
    else if (single && SYNTHETIC_SPACES.has(codePoint) && hasGlyph(primary, SPACE)) result = writable ? viaFallbackAlone : refused("missing");
    else if (single && codePoint === NO_BREAK_HYPHEN && hasGlyph(primary, HYPHEN)) result = refused("substituted");
    else result = writable ? viaFallback : refused("missing");
    // bounded: a box holds few distinct clusters, a pasted novel must not grow the table for ever
    if (known.size < 4096) known.set(grapheme, result);
    return result;
  };
  plan = Object.freeze({ primaryKey: primary.id, fallbackKey, primary, fallback, classify });
  index.plans.set(fontKey, plan);
  return plan;
}

/**
 * The tofu check of one text in one box font. `text` must be normalizeText() output.
 * @returns {{ ok: boolean,
 *             fallback: Array<{ char: string, index: number, codePoint: number, font: string }>,
 *             unsupported: Array<{ char: string, index: number, codePoint: number, reason: string }> }}
 *   ok           nothing is unsupported: the text stays real, searchable text
 *   fallback     clusters the box font lacks and the fallback face writes (`font` = that face)
 *   unsupported  clusters that cannot be real text: the whole box becomes a picture on export. `reason`:
 *                "missing" | "mark" | "unsafe" | "format" (exportProblem) | "composed" | "substituted" (fontPlan)
 *   `char` = the cluster, `index` = its UTF-16 offset, `codePoint` = its first code point.
 */
export function checkText(manifest, fontKey, text) {
  const plan = fontPlan(manifest, fontKey);
  const fallback = [];
  const unsupported = [];
  for (const { segment, index } of graphemes(text)) {
    if (segment === LINE_FEED) continue;
    const { font, reason } = plan.classify(segment);
    if (font === plan.primaryKey) continue;
    const entry = { char: segment, index, codePoint: segment.codePointAt(0) };
    if (font) fallback.push({ ...entry, font });
    else unsupported.push({ ...entry, reason });
  }
  return { ok: unsupported.length === 0, fallback, unsupported };
}

/**
 * The text as runs of one face each: [{ text, font: FontKey }], in order; joined, the runs give the text back
 * (a line break stays in the run it follows). null when the text must become a picture.
 * Spaces and punctuation between two fallback words belong to the box font, exactly as the browser draws them.
 * A space the fallback face writes for the box font is a run of its own (see fontPlan: `alone`), so two
 * neighbouring runs can name the same face.
 */
export function splitRuns(manifest, fontKey, text) {
  const plan = fontPlan(manifest, fontKey);
  const runs = [];
  let current = null;
  let closed = false; // the run ends with a cluster that has to stand alone
  for (const { segment } of graphemes(text)) {
    if (segment === LINE_FEED) {
      if (!current) {
        current = { text: "", font: plan.primaryKey };
        runs.push(current);
      }
      current.text += segment;
      continue;
    }
    const { font, alone } = plan.classify(segment);
    if (!font) return null;
    if (!current || current.font !== font || alone || closed) {
      // a run that holds nothing but line breaks so far takes the face of the first real character
      if (current && current.text.replaceAll(LINE_FEED, "") === "") current.font = font;
      else {
        current = { text: "", font };
        runs.push(current);
      }
    }
    current.text += segment;
    closed = alone;
  }
  return runs;
}

/**
 * The faces a text needs before it can be laid out: the box face, and the fallback face as soon as ONE
 * cluster is not written by the box face. That includes clusters no bundled font writes: the browser tries
 * the fallback face before any system font (a combining mark, say), so without it the measurement would
 * depend on which faces other boxes happened to load.
 */
export function facesNeeded(manifest, fontKey, text) {
  const plan = fontPlan(manifest, fontKey);
  if (!plan.fallbackKey) return [plan.primaryKey];
  for (const { segment } of graphemes(text)) {
    if (segment !== LINE_FEED && plan.classify(segment).font !== plan.primaryKey) return [plan.primaryKey, plan.fallbackKey];
  }
  return [plan.primaryKey];
}

/** The faces of one role ("text" or "signature") that write the whole text on their own: FontKey[]. */
export function fontsThatCover(manifest, text, role = "text") {
  const clusters = graphemes(text).filter(({ segment }) => segment !== LINE_FEED);
  return manifest.fonts
    .filter((font) => font.role === role && clusters.every(({ segment }) => !exportProblem(font, segment)))
    .map((font) => font.id);
}
