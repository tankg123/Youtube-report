// Text search over pdf.js text content. Pure functions: no DOM, no pdf.js import, so the module runs unchanged
// under `node --test` (tests/pdfViewerSearch.test.mjs).
//
// pdf.js' own find controller is bound to one document and does not find "hop dong" in "Hợp đồng": the letter
// đ has no Unicode decomposition, so stripping combining marks is not enough for Vietnamese.
//
// Model
//   page text    the `str` of every text item joined, with "\n" after an item that hasEOL
//   folded text  the page text made comparable (case, diacritics, white space), with a map from every folded
//                UTF-16 unit back to the unit of the page text it came from
//   match        [start, end) in page-text units -> { begin: { item, offset }, end: { item, offset } }
//
// Item indexes count the items that have a `str` (marked-content entries are skipped), which is exactly the
// index of pdf.js TextLayer.textDivs / textContentItemsStr: a match becomes a DOM Range without any lookup.
//
// The query goes through the same fold, so "tieng viet" finds "tiếng việt", "TIẾNG VIỆT", text stored
// decomposed (NFD) and text that pdf.js split into several items or lines.
// Not handled: words hyphenated across lines, word boundaries in scripts written without spaces.

const COMBINING_MARK = /\p{M}/u;
const COMBINING_MARKS = /\p{M}+/gu;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITE_SPACE = /\s/u;

// Built from code points: the source file holds no invisible or look-alike characters.
const fromPairs = (pairs) => new Map(pairs.map(([codePoint, replacement]) => [String.fromCodePoint(codePoint), replacement]));

// Letters that NFD does not decompose but that people type without the mark. The d with stroke is the one
// that matters for Vietnamese: "da nang" must find "Đà Nẵng".
const BASE_LETTER = fromPairs([
  [0x0111, "d"], // d with stroke (Vietnamese)
  [0x0110, "D"],
  [0x00f0, "d"], // eth
  [0x00d0, "D"],
  [0x0142, "l"], // l with stroke
  [0x0141, "L"],
  [0x00f8, "o"], // o with stroke
  [0x00d8, "O"],
  [0x0131, "i"], // dotless i
  [0x00df, "ss"], // sharp s
  [0x00e6, "ae"],
  [0x00c6, "AE"],
  [0x0153, "oe"],
  [0x0152, "OE"]
]);

// Typographic variants that people type as ASCII.
const PUNCTUATION = fromPairs([
  [0x2018, "'"], [0x2019, "'"], [0x201a, "'"], [0x201b, "'"], // single quotation marks
  [0x201c, "\""], [0x201d, "\""], [0x201e, "\""], [0x201f, "\""], // double quotation marks
  [0x2010, "-"], [0x2011, "-"], [0x2012, "-"], [0x2013, "-"], [0x2014, "-"], [0x2212, "-"] // hyphens, dashes, minus
]);

// Soft hyphen, zero-width space / non-joiner / joiner, word joiner, byte order mark: never part of a word.
const ZERO_WIDTH = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((codePoint) => String.fromCodePoint(codePoint)));

/**
 * Folds a string and records where every folded unit came from.
 * @param {string} text
 * @param {{ matchCase?: boolean, matchDiacritics?: boolean }} [options]
 *        matchDiacritics false (default): "a" finds every accented a and "d" finds the d with stroke;
 *        true: letters are compared in their composed (NFC) form
 * @returns {{ folded: string, map: Uint32Array }} map[i] = index in `text` of the unit that produced
 *          folded[i]; map[folded.length] = text.length (so that an end offset can be mapped too)
 */
export function foldText(text, { matchCase = false, matchDiacritics = false } = {}) {
  const out = [];
  const map = [];
  let pendingSpace = -1; // index of the first white-space unit of the current run
  let index = 0;
  const push = (piece, origin) => {
    for (let unit = 0; unit < piece.length; unit += 1) {
      out.push(piece[unit]);
      map.push(origin);
    }
  };
  while (index < text.length) {
    const char = String.fromCodePoint(text.codePointAt(index));
    const start = index;
    index += char.length;
    if (ZERO_WIDTH.has(char)) continue;
    let piece = PUNCTUATION.get(char) ?? char;
    if (WHITE_SPACE.test(piece)) {
      // a run of white space (line breaks between items included) is one space
      if (pendingSpace < 0) pendingSpace = start;
      continue;
    }
    if (pendingSpace >= 0) {
      if (out.length > 0) push(" ", pendingSpace);
      pendingSpace = -1;
    }
    if (matchDiacritics) {
      // Compare composed forms. A combining mark of decomposed text is composed with the folded character
      // before it, so that NFD "e + circumflex + tilde" equals the single NFC letter.
      if (COMBINING_MARK.test(piece) && out.length > 0) {
        const composed = (out[out.length - 1] + piece).normalize("NFC");
        if (composed.length === 1) {
          const lower = composed.toLowerCase();
          out[out.length - 1] = matchCase || lower.length !== 1 ? composed : lower;
          continue;
        }
      }
      piece = piece.normalize("NFC");
    } else {
      piece = BASE_LETTER.get(piece) ?? piece;
      piece = piece.normalize("NFD").replace(COMBINING_MARKS, "");
      if (piece === "") continue; // a lone combining mark (decomposed text): dropped
      piece = BASE_LETTER.get(piece) ?? piece;
    }
    if (!matchCase) piece = piece.toLowerCase();
    push(piece, start);
  }
  map.push(text.length);
  return { folded: out.join(""), map: Uint32Array.from(map) };
}

/**
 * The part of pdf.js text items that searching needs: [{ str, hasEOL }]. Marked-content entries (no `str`)
 * are dropped, so the indexes of the result are the indexes of TextLayer.textDivs.
 */
export function compactItems(items) {
  const out = [];
  for (const item of items) {
    if (typeof item.str === "string") out.push({ str: item.str, hasEOL: Boolean(item.hasEOL) });
  }
  return out;
}

/**
 * Joins the items of one page into the page text and remembers where each item starts.
 * @returns {{ text: string, itemStarts: Uint32Array, itemLengths: Uint32Array }}
 */
export function buildPageText(items) {
  const parts = [];
  const starts = [];
  const lengths = [];
  let position = 0;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    starts.push(position);
    lengths.push(item.str.length);
    parts.push(item.str);
    position += item.str.length;
    if (item.hasEOL) {
      parts.push("\n");
      position += 1;
    }
  }
  return { text: parts.join(""), itemStarts: Uint32Array.from(starts), itemLengths: Uint32Array.from(lengths) };
}

/**
 * Converts an offset of the page text into { item, offset }. With `isEnd` an offset that sits exactly on an
 * item boundary stays inside the EARLIER item (offset = its length).
 */
export function locate(pageText, position, isEnd = false) {
  const { itemStarts, itemLengths } = pageText;
  if (itemStarts.length === 0) return { item: 0, offset: 0 };
  let low = 0;
  let high = itemStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (itemStarts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  let item = low;
  let offset = position - itemStarts[item];
  if (isEnd) {
    // step back over empty items and over the "\n" that follows an item
    while (item > 0 && offset === 0) {
      item -= 1;
      offset = itemLengths[item];
    }
  } else {
    // a start that falls on the "\n" after an item, or past an empty item, moves forward
    while (item < itemStarts.length - 1 && offset >= itemLengths[item]) {
      item += 1;
      offset = Math.max(0, position - itemStarts[item]);
    }
  }
  return { item, offset: Math.min(offset, itemLengths[item]) };
}

/**
 * Prepares one page for searching. Do it once per page and per fold options (matchCase, matchDiacritics) and
 * keep the result: the next query on the same page is a plain indexOf.
 */
export function indexPage(items, options = {}) {
  const pageText = buildPageText(items);
  const { folded, map } = foldText(pageText.text, options);
  return { pageText, folded, map };
}

/** The key under which an index of `indexPage` can be cached: only two options change the folded text. */
export const foldKey = (options = {}) => `${options.matchCase ? 1 : 0}${options.matchDiacritics ? 1 : 0}`;

/**
 * Finds every occurrence of `query` in an indexed page (left to right, not overlapping).
 * @param {{ matchCase?: boolean, matchDiacritics?: boolean, wholeWord?: boolean }} [options] matchCase and
 *        matchDiacritics must be the ones the index was built with
 * @returns {Array<{ start: number, end: number, begin: { item: number, offset: number }, end_: { item: number, offset: number } }>}
 *          start / end are offsets in the page text; begin / end_ address the text items
 */
export function findInPage(index, query, options = {}) {
  const needle = foldText(String(query ?? ""), options).folded;
  if (!needle) return [];
  const { folded, map, pageText } = index;
  const { text } = pageText;
  const matches = [];
  let from = 0;
  for (;;) {
    const at = folded.indexOf(needle, from);
    if (at < 0) break;
    const endAt = at + needle.length;
    from = at + 1;
    if (options.wholeWord) {
      const before = at > 0 ? folded[at - 1] : "";
      const after = endAt < folded.length ? folded[endAt] : "";
      const startsInWord = before !== "" && WORD_CHAR.test(before) && WORD_CHAR.test(needle[0]);
      const endsInWord = after !== "" && WORD_CHAR.test(after) && WORD_CHAR.test(needle[needle.length - 1]);
      if (startsInWord || endsInWord) continue;
    }
    const start = map[at];
    // end = just after the last original character of the match, extended over the combining marks that
    // follow it (a letter stored decomposed is highlighted whole)
    const lastUnit = map[endAt - 1];
    let end = lastUnit + String.fromCodePoint(text.codePointAt(lastUnit)).length;
    while (end < text.length) {
      const next = String.fromCodePoint(text.codePointAt(end));
      if (!COMBINING_MARK.test(next)) break;
      end += next.length;
    }
    matches.push({ start, end, begin: locate(pageText, start, false), end_: locate(pageText, end, true) });
    from = endAt;
  }
  return matches;
}

/** The original text of a match (for result lists and tests). */
export function matchText(index, match) {
  return index.pageText.text.slice(match.start, match.end);
}
