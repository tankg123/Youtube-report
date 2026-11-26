// The arithmetic of the page panels and the page organiser (UX specification 7.2 and 7.9). Pure functions:
// no DOM, no React, no text for the user (tests/pdfPagesLogic.test.mjs).
//
//   parsePageRange        "all", "1-3, 7", "5-" -> 0-based page indices, or what is wrong with the text
//   selection             click / Ctrl / Shift on a list of page ids, Shift + arrows, the marquee
//   grid                  the neighbour of a tile for the arrow keys, the columns of a wrapped grid
//   drop                  where a dragged page would land (the gap under the pointer and the bar that shows it)
//   move                  the target index of Ctrl+Shift+arrows and of "Move to position…"
//   blank pages           the size of a blank page from the choices of the Insert dialog
//   image pages           the page and the frame of a picture that becomes a page; the EXIF orientation of a JPEG
//   outline               the bookmarks of the sources mapped to the pages of the working document
import { PAGE_SIZES } from "../engine/geometry.js";
import { moveIndexForDrop } from "../model/selectors.js";
import { outputBaseName, pdfFileName } from "../ui/fileNames.js";
import { visiblePageSize } from "../viewer/pageList.js";

export const POINTS_PER_MM = 72 / 25.4;
/** The page sizes the store accepts, in points (model/store.js PAGE_SIZE_LIMITS). */
const SIZE_LIMITS = Object.freeze({ min: 1, max: 14400 });

// ---------------------------------------------------------------------------------------------------------------
// page ranges
// ---------------------------------------------------------------------------------------------------------------

const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const DASHES = new RegExp(`[${EN_DASH}${EM_DASH}]`, "g");
const MAX_RANGE_PAGES = 100000;

/**
 * Reads a page range as people type it.
 *   "all" (or a word of `allWords`, or "*")      every page
 *   "1-3, 7"  "1-3;7"  "1-3 7"                   pages 1, 2, 3 and 7
 *   "5-"  "-3"                                   from page 5 to the end; from the first page to page 3
 *   "7-5"                                        pages 7, 6, 5 (the order given is kept)
 * A page that is named twice is taken once (the first time).
 * @param {string} text
 * @param {number} pageCount   how many pages the document (or the file) has
 * @param {{ allWords?: string[] }} [options]  more words that mean "all" (the translated one)
 * @returns {{ ok: true, indices: number[] } | { ok: false, problem: "empty" | "syntax" | "bounds", token: string }}
 *          indices are 0-based; token = the part that could not be read
 */
export function parsePageRange(text, pageCount, { allWords = [] } = {}) {
  const count = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 0;
  const clean = String(text ?? "")
    .normalize("NFC")
    .replace(DASHES, "-")
    .trim()
    .toLowerCase();
  if (!clean || !count) return { ok: false, problem: "empty", token: "" };
  const everything = ["all", "*", ...allWords.map((word) => String(word).normalize("NFC").trim().toLowerCase())];
  if (everything.includes(clean)) return { ok: true, indices: Array.from({ length: count }, (_, index) => index) };
  // "1 - 3" is one range: the spaces around a dash do not separate
  const tokens = clean
    .replace(/\s*-\s*/g, "-")
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (!tokens.length) return { ok: false, problem: "empty", token: "" };
  const seen = new Set();
  const indices = [];
  for (const token of tokens) {
    const match = /^(\d*)(-?)(\d*)$/.exec(token);
    if (!match || (!match[1] && !match[3])) return { ok: false, problem: "syntax", token };
    const single = !match[2];
    const from = match[1] ? Number(match[1]) : 1;
    const to = single ? from : match[3] ? Number(match[3]) : count;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return { ok: false, problem: "syntax", token };
    if (from < 1 || to < 1 || from > count || to > count) return { ok: false, problem: "bounds", token };
    const step = from <= to ? 1 : -1;
    for (let number = from; number !== to + step && indices.length <= MAX_RANGE_PAGES; number += step) {
      if (seen.has(number)) continue;
      seen.add(number);
      indices.push(number - 1);
    }
  }
  return { ok: true, indices };
}

/** 1-based page numbers as a range text: [3, 4, 5, 9] -> "3-5, 9" (sorted, repeats dropped). */
export function formatPageRange(pageNumbers) {
  const numbers = [...new Set((pageNumbers || []).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  const parts = [];
  for (let index = 0; index < numbers.length; index += 1) {
    let end = index;
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end += 1;
    parts.push(end === index ? String(numbers[index]) : `${numbers[index]}-${numbers[end]}`);
    index = end;
  }
  return parts.join(", ");
}

/** The file an extract of these pages is downloaded as: "<name>-pages-3-5.pdf". */
export function extractFileName(fileName, pageNumbers) {
  return pdfFileName(outputBaseName({ fileName, purpose: "extract", pageNumbers }));
}

// ---------------------------------------------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------------------------------------------

/** The ids of `selected` that still exist, in the order of the document. */
export function orderedSelection(ids, selected) {
  const wanted = new Set(selected || []);
  return ids.filter((id) => wanted.has(id));
}

/** The ids between two pages, both included, in document order. Unknown ids give just the one that exists. */
export function rangeBetween(ids, fromId, toId) {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (to < 0) return from < 0 ? [] : [fromId];
  if (from < 0) return [toId];
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * A click on a page of a list.
 *   plain   only this page                    ctrl    this page is added or taken out
 *   shift   everything from the anchor to it  ctrl + shift   that range is added to what was selected
 * @param {string[]} ids                the pages in document order
 * @param {{ selected: string[], anchor: string | null }} current
 * @param {string} id                   the page that was clicked
 * @param {{ ctrl?: boolean, shift?: boolean }} [keys]
 * @returns {{ selected: string[], anchor: string | null, focus: string }}
 */
export function clickSelection(ids, current, id, { ctrl = false, shift = false } = {}) {
  const selected = orderedSelection(ids, current?.selected);
  if (!ids.includes(id)) return { selected, anchor: current?.anchor ?? null, focus: current?.focus ?? null };
  const anchor = ids.includes(current?.anchor) ? current.anchor : null;
  if (shift && anchor) {
    const range = rangeBetween(ids, anchor, id);
    return { selected: orderedSelection(ids, ctrl ? [...selected, ...range] : range), anchor, focus: id };
  }
  if (ctrl) {
    const next = selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id];
    return { selected: orderedSelection(ids, next), anchor: id, focus: id };
  }
  return { selected: [id], anchor: id, focus: id };
}

/** Shift + arrow: the selection becomes the range from the anchor (or the page that had the focus) to `toId`. */
export function extendSelection(ids, current, toId) {
  if (!ids.includes(toId)) return { selected: orderedSelection(ids, current?.selected), anchor: current?.anchor ?? null, focus: current?.focus ?? null };
  const anchor = ids.includes(current?.anchor) ? current.anchor : ids.includes(current?.focus) ? current.focus : toId;
  return { selected: rangeBetween(ids, anchor, toId), anchor, focus: toId };
}

/** Space on the focused page: in or out of the selection. */
export function toggleSelection(ids, current, id) {
  return clickSelection(ids, current, id, { ctrl: true });
}

// ---------------------------------------------------------------------------------------------------------------
// the grid of tiles
// ---------------------------------------------------------------------------------------------------------------

/** How many tiles the first row of a wrapped grid holds: `tops` = the top edge of every tile, in order. */
export function columnsOf(tops) {
  if (!tops?.length) return 1;
  let columns = 1;
  while (columns < tops.length && Math.abs(tops[columns] - tops[0]) < 1) columns += 1;
  return columns;
}

/**
 * The tile an arrow key moves to. Left / right walk through the pages in reading order (and wrap to the next
 * row), up / down stay in the column; Home / End are the first and the last page.
 * @returns {number} the new index (the same one at an edge)
 */
export function gridNeighbour(index, count, columns, direction) {
  if (count <= 0) return -1;
  const from = Math.min(count - 1, Math.max(0, index));
  const cols = Math.max(1, columns);
  let next = from;
  if (direction === "left") next = from - 1;
  else if (direction === "right") next = from + 1;
  else if (direction === "up") next = from - cols;
  else if (direction === "down") next = from + cols >= count && Math.floor(from / cols) < Math.floor((count - 1) / cols) ? count - 1 : from + cols;
  else if (direction === "home") next = 0;
  else if (direction === "end") next = count - 1;
  return next < 0 || next >= count ? from : next;
}

/** The direction of an arrow key ("ArrowLeft" ...), "home" / "end" for those keys, or null. */
export function directionOfKey(key) {
  const table = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Home: "home", End: "end" };
  return table[key] || null;
}

// ---------------------------------------------------------------------------------------------------------------
// dragging pages to another place
// ---------------------------------------------------------------------------------------------------------------

/** Tiles of a wrapped grid grouped into rows: [{ top, bottom, first, last }] (indices into `tiles`). */
function rowsOf(tiles) {
  const rows = [];
  tiles.forEach((tile, index) => {
    const row = rows[rows.length - 1];
    if (row && Math.abs(tile.top - tiles[row.first].top) < Math.max(1, tile.height / 2)) {
      row.last = index;
      row.top = Math.min(row.top, tile.top);
      row.bottom = Math.max(row.bottom, tile.top + tile.height);
    } else {
      rows.push({ first: index, last: index, top: tile.top, bottom: tile.top + tile.height });
    }
  });
  return rows;
}

/**
 * Where a dragged page would land.
 * @param {Array<{ left: number, top: number, width: number, height: number }>} tiles  the boxes of ALL tiles in
 *        document order, in one coordinate system (the scrolled content of the grid)
 * @param {number} x  the pointer in the same coordinates
 * @param {number} y
 * @returns {{ gap: number, bar: { x: number, top: number, height: number } } | null}
 *          gap: 0 = before the first page ... tiles.length = after the last one (selectors.moveIndexForDrop takes
 *          it); bar: the vertical line that marks the place, centred on x
 */
export function dropGapAt(tiles, x, y) {
  if (!tiles?.length) return null;
  const rows = rowsOf(tiles);
  // the row under the pointer: the bands meet half way between two rows
  let row = rows[rows.length - 1];
  for (let index = 0; index < rows.length; index += 1) {
    const next = rows[index + 1];
    const limit = next ? (rows[index].bottom + next.top) / 2 : Infinity;
    if (y < limit) {
      row = rows[index];
      break;
    }
  }
  const spacing = row.last > row.first ? Math.max(0, tiles[row.first + 1].left - (tiles[row.first].left + tiles[row.first].width)) : 12;
  const bar = (barX) => ({ x: barX, top: row.top, height: row.bottom - row.top });
  for (let index = row.first; index <= row.last; index += 1) {
    const tile = tiles[index];
    if (x < tile.left + tile.width / 2) return { gap: index, bar: bar(tile.left - spacing / 2) };
  }
  const last = tiles[row.last];
  return { gap: row.last + 1, bar: bar(last.left + last.width + spacing / 2) };
}

/** The ids in the order they have after `moving` was dropped into `gap` (0 ... ids.length). */
export function orderAfterDrop(ids, moving, gap) {
  const wanted = new Set(moving);
  const moved = ids.filter((id) => wanted.has(id));
  const rest = ids.filter((id) => !wanted.has(id));
  const at = moveIndexForDrop(
    ids.map((id) => ({ id })),
    moved,
    gap
  );
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

/**
 * What a drop means for store.movePages.
 * @returns {{ toIndex: number, changes: boolean, position: number }} toIndex: the index in the list WITHOUT the
 *          moved pages; changes: false when the pages would stay where they are; position: the 1-based place
 *          of the first moved page afterwards
 */
export function dropTarget(ids, moving, gap) {
  const wanted = new Set(moving);
  const toIndex = moveIndexForDrop(
    ids.map((id) => ({ id })),
    ids.filter((id) => wanted.has(id)),
    gap
  );
  const after = orderAfterDrop(ids, moving, gap);
  return { toIndex, changes: after.some((id, index) => id !== ids[index]), position: toIndex + 1 };
}

/**
 * Ctrl+Shift+Left / Right: the selected pages move one place earlier or later, together (pages that were
 * apart end up next to each other).
 * @param {"earlier" | "later"} direction
 * @returns {{ toIndex: number, position: number } | null} null when they are already at that end, side by side
 */
export function keyboardMoveTarget(ids, moving, direction) {
  const wanted = new Set(moving);
  const moved = ids.filter((id) => wanted.has(id));
  if (!moved.length || moved.length === ids.length) return null;
  const first = ids.indexOf(moved[0]);
  const last = ids.indexOf(moved[moved.length - 1]);
  const restBeforeFirst = ids.slice(0, first).filter((id) => !wanted.has(id)).length;
  const restBeforeLast = ids.slice(0, last).filter((id) => !wanted.has(id)).length;
  const restCount = ids.length - moved.length;
  const toIndex = direction === "earlier" ? Math.max(0, restBeforeFirst - 1) : Math.min(restCount, restBeforeLast + 1);
  const rest = ids.filter((id) => !wanted.has(id));
  const after = [...rest.slice(0, toIndex), ...moved, ...rest.slice(toIndex)];
  if (!after.some((id, index) => id !== ids[index])) return null;
  return { toIndex, position: toIndex + 1 };
}

/**
 * "Move to position…": the moved pages start at that 1-based place of the document.
 * @returns {{ toIndex: number, position: number, changes: boolean }}
 */
export function positionMoveTarget(ids, moving, position) {
  const wanted = new Set(moving);
  const moved = ids.filter((id) => wanted.has(id));
  const rest = ids.filter((id) => !wanted.has(id));
  const toIndex = Math.min(rest.length, Math.max(0, Math.trunc(Number(position)) - 1 || 0));
  const after = [...rest.slice(0, toIndex), ...moved, ...rest.slice(toIndex)];
  return { toIndex, position: toIndex + 1, changes: after.some((id, index) => id !== ids[index]) };
}

/** True when two boxes [left, top, right, bottom] overlap (the marquee and a tile). */
export function boxesTouch(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/** The ids of the tiles a marquee touches. tiles: [{ id, left, top, width, height }]; box: two corners in any order. */
export function tilesInBox(tiles, x0, y0, x1, y1) {
  const box = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  return tiles.filter((tile) => boxesTouch(box, [tile.left, tile.top, tile.left + tile.width, tile.top + tile.height])).map((tile) => tile.id);
}

/**
 * How fast a list scrolls while something is dragged near its top or bottom edge.
 * @param {number} pointer  the pointer along the scrolling axis, measured from the start of the visible list
 * @param {number} extent   the visible length of the list
 * @returns {number} pixels per frame: negative towards the start, 0 away from the edges
 */
export function edgeScrollSpeed(pointer, extent, { zone = 56, max = 22 } = {}) {
  if (!(extent > 0)) return 0;
  const band = Math.min(zone, extent / 3);
  if (pointer < band) return -Math.ceil((Math.min(band, band - pointer) / band) * max);
  if (pointer > extent - band) return Math.ceil((Math.min(band, pointer - (extent - band)) / band) * max);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// blank pages
// ---------------------------------------------------------------------------------------------------------------

/** The sizes the Insert dialog offers: "current" = like the page it is inserted next to, "custom" = typed in mm. */
export const BLANK_FORMATS = Object.freeze(["current", "A4", "A3", "A5", "LETTER", "LEGAL", "custom"]);
/** What a typed size may be, in millimetres (the store takes 1 to 14400 points). */
export const CUSTOM_SIZE_MM = Object.freeze({ min: 10, max: 5000 });

const roundSize = (value) => Math.round(value * 100) / 100;

/**
 * The size of a blank page in points.
 * @param {object} choice
 * @param {string} choice.format                   one of BLANK_FORMATS
 * @param {"portrait" | "landscape"} [choice.orientation]  for the named formats
 * @param {number} [choice.widthMm]                for "custom"
 * @param {number} [choice.heightMm]
 * @param {object} [choice.page]                   for "current": the page (model/schema.js) whose size is taken,
 *                                                 as it is seen (its rotation applied)
 * @returns {{ ok: true, size: [number, number] } | { ok: false, problem: "format" | "width" | "height" | "page" }}
 */
export function blankPageSize({ format, orientation = "portrait", widthMm, heightMm, page } = {}) {
  if (format === "current") {
    if (!page) return { ok: false, problem: "page" };
    const { width, height } = visiblePageSize(page);
    const clamp = (value) => Math.min(SIZE_LIMITS.max, Math.max(SIZE_LIMITS.min, value));
    return { ok: true, size: [roundSize(clamp(width)), roundSize(clamp(height))] };
  }
  if (format === "custom") {
    const valid = (value) => Number.isFinite(value) && value >= CUSTOM_SIZE_MM.min && value <= CUSTOM_SIZE_MM.max;
    if (!valid(widthMm)) return { ok: false, problem: "width" };
    if (!valid(heightMm)) return { ok: false, problem: "height" };
    return { ok: true, size: [roundSize(widthMm * POINTS_PER_MM), roundSize(heightMm * POINTS_PER_MM)] };
  }
  const named = Object.hasOwn(PAGE_SIZES, format) ? PAGE_SIZES[format] : null;
  if (!named) return { ok: false, problem: "format" };
  const [short, long] = named;
  return { ok: true, size: orientation === "landscape" ? [long, short] : [short, long] };
}

/** A number typed with a comma or a point as the decimal sign ("210", "215,9"); NaN when it is not one. */
export function parseDecimal(text) {
  const clean = String(text ?? "")
    .trim()
    .replace(",", ".");
  return /^\d+(\.\d+)?$/.test(clean) ? Number(clean) : NaN;
}

/**
 * The index at which pages are inserted: before or after a page given by its 1-based number.
 * @returns {number} 0 ... pageCount
 */
export function insertionIndex(pageCount, pageNumber, place) {
  const number = Math.min(Math.max(1, Math.trunc(Number(pageNumber)) || 1), Math.max(1, pageCount));
  return place === "before" ? number - 1 : Math.min(pageCount, number);
}

/** The place fields of a dialog as text, for an insertion index (0 ... pageCount): { place, pageNumber }. */
export function placeOfIndex(index, pageCount) {
  if (!(index > 0)) return { place: "before", pageNumber: "1" };
  return { place: "after", pageNumber: String(Math.min(Math.trunc(index), Math.max(1, pageCount))) };
}

/** The page number a field holds, or null when it is not a page of the document. */
export function readPageNumber(text, pageCount) {
  const clean = String(text ?? "").trim();
  const value = /^\d+$/.test(clean) ? Number(clean) : NaN;
  return Number.isInteger(value) && value >= 1 && value <= pageCount ? value : null;
}

// ---------------------------------------------------------------------------------------------------------------
// a picture as a page
// ---------------------------------------------------------------------------------------------------------------

/** One CSS pixel of a picture in points (96 pixels per inch), as model/transform.js places pictures. */
export const POINTS_PER_PIXEL = 0.75;
export const IMAGE_PAGE_MODES = Object.freeze(["a4", "image"]);
const SMALLEST_IMAGE_PAGE = 36;

/**
 * The page a picture becomes, and where the picture lies on it.
 * @param {{ width: number, height: number }} image   pixels
 * @param {"a4" | "image"} mode   "a4": an A4 page (upright or lying, like the picture) with the picture fitted
 *        inside it, centred; "image": a page of the picture's own size (96 pixels per inch)
 * @returns {{ size: [number, number], frame: { x, y, w, h, rot: 0 } } | null} the frame of the image object in
 *          the user space of a blank page [0, 0, w, h]; null for a picture without a size
 */
export function imagePageLayout(image, mode = "a4") {
  const pixelWidth = Number(image?.width);
  const pixelHeight = Number(image?.height);
  if (!(pixelWidth > 0) || !(pixelHeight > 0)) return null;
  if (mode === "image") {
    let width = pixelWidth * POINTS_PER_PIXEL;
    let height = pixelHeight * POINTS_PER_PIXEL;
    const grow = Math.max(1, SMALLEST_IMAGE_PAGE / Math.min(width, height));
    width *= grow;
    height *= grow;
    const shrink = Math.min(1, SIZE_LIMITS.max / Math.max(width, height));
    width = roundSize(Math.max(SIZE_LIMITS.min, width * shrink));
    height = roundSize(Math.max(SIZE_LIMITS.min, height * shrink));
    return { size: [width, height], frame: { x: width / 2, y: height / 2, w: width, h: height, rot: 0 } };
  }
  const [short, long] = PAGE_SIZES.A4;
  const size = pixelWidth > pixelHeight ? [long, short] : [short, long];
  const scale = Math.min(size[0] / pixelWidth, size[1] / pixelHeight);
  return { size, frame: { x: size[0] / 2, y: size[1] / 2, w: roundSize(pixelWidth * scale), h: roundSize(pixelHeight * scale), rot: 0 } };
}

/** "png" | "jpeg" for bytes that start like one of the two picture types the document stores, else null. */
export function storedImageKind(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/**
 * The EXIF orientation of a JPEG (1 = as stored ... 8), 1 when the file says nothing. A browser shows a JPEG
 * turned by this tag, a PDF does not: a picture with another value than 1 is drawn again before it is stored.
 */
export function jpegOrientation(bytes) {
  if (storedImageKind(bytes) !== "jpeg") return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return 1;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xda || marker === 0xd9) return 1; // the picture data starts: no EXIF block before it
    const length = view.getUint16(offset + 2);
    if (length < 2) return 1;
    if (marker === 0xe1 && offset + 4 + 6 <= view.byteLength && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
      const tiff = offset + 10;
      const end = Math.min(view.byteLength, offset + 2 + length);
      if (tiff + 8 > end) return 1;
      const little = view.getUint16(tiff) === 0x4949;
      if (!little && view.getUint16(tiff) !== 0x4d4d) return 1;
      const directory = tiff + view.getUint32(tiff + 4, little);
      if (directory + 2 > end) return 1;
      const entries = view.getUint16(directory, little);
      for (let index = 0; index < entries; index += 1) {
        const entry = directory + 2 + index * 12;
        if (entry + 12 > end) return 1;
        if (view.getUint16(entry, little) !== 0x0112) continue;
        const value = view.getUint16(entry + 8, little);
        return value >= 1 && value <= 8 ? value : 1;
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

// ---------------------------------------------------------------------------------------------------------------
// source files and their colours
// ---------------------------------------------------------------------------------------------------------------

/** The bar colours of the source files (told apart also by people who do not see every colour). */
export const SOURCE_COLORS = Object.freeze(["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#65a30d", "#dc2626"]);

/** sourceId -> its colour, for the sources the pages use, in the order of their first page. Empty for one source. */
export function sourceColors(pages) {
  const order = [];
  for (const page of pages || []) if (page.kind === "pdf" && page.sourceId && !order.includes(page.sourceId)) order.push(page.sourceId);
  const colors = new Map();
  if (order.length < 2) return colors;
  order.forEach((sourceId, index) => colors.set(sourceId, SOURCE_COLORS[index % SOURCE_COLORS.length]));
  return colors;
}

/** pageId -> how many redaction and blur marks wait on it. */
export function pendingMarkCounts(pages, objects) {
  const counts = new Map();
  for (const page of pages || []) {
    let count = 0;
    for (const id of page.objectIds) {
      const type = objects?.[id]?.type;
      if (type === "redact" || type === "blur") count += 1;
    }
    if (count) counts.set(page.id, count);
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------------------------------------------

/**
 * The bookmarks of ONE source mapped to the working document.
 * @param {Array<{ title: string, pageIndex: number | null, rect: number[] | null, children: any[] }>} outline
 *        the outline facts of the viewer (pageIndex: 0-based in the source file)
 * @param {object[]} pages       the pages of the working document (model/schema.js)
 * @param {string} sourceId
 * @param {string} [keyPrefix]
 * @returns {Array<{ key, title, pageId: string | null, pageNumber: number | null, rect, children }>}
 *          An entry points at the FIRST page of the document that shows its source page (it follows the page
 *          when pages are reordered). An entry whose page is gone disappears, unless entries under it are
 *          still there: then it stays as a heading without a page.
 */
export function mapOutline(outline, pages, sourceId, keyPrefix = sourceId) {
  const firstPlace = new Map(); // source page index -> { pageId, pageNumber }
  (pages || []).forEach((page, index) => {
    if (page.kind !== "pdf" || page.sourceId !== sourceId || firstPlace.has(page.sourceIndex)) return;
    firstPlace.set(page.sourceIndex, { pageId: page.id, pageNumber: index + 1 });
  });
  const walk = (items, prefix, trail) => {
    const out = [];
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      if (!item || typeof item !== "object" || trail.has(item)) return;
      const key = `${prefix}/${index}`;
      trail.add(item);
      const children = walk(item.children, key, trail);
      trail.delete(item);
      const place = Number.isInteger(item.pageIndex) ? firstPlace.get(item.pageIndex) : null;
      if (!place && !children.length) return;
      out.push({
        key,
        title: String(item.title ?? "").trim(),
        pageId: place ? place.pageId : null,
        pageNumber: place ? place.pageNumber : null,
        rect: place && Array.isArray(item.rect) ? item.rect : null,
        children
      });
    });
    return out;
  };
  return walk(outline, keyPrefix, new Set());
}

/**
 * The outline tree of the working document.
 * @param {Array<{ id: string, name: string, outline: any[] }>} sources  the sources IN USE, in document order
 * @param {object[]} pages
 * @returns {Array<object>} one source in use: its entries. Several: a node per file that has entries
 *          ({ key, title: the file name, file: true, pageId: null, pageNumber: null, rect: null, children }).
 */
export function buildOutlineTree(sources, pages) {
  const list = Array.isArray(sources) ? sources : [];
  const mapped = list.map((source) => ({ source, nodes: mapOutline(source.outline, pages, source.id) }));
  if (list.length <= 1) return mapped[0]?.nodes || [];
  return mapped
    .filter((entry) => entry.nodes.length)
    .map((entry) => ({ key: `file:${entry.source.id}`, title: String(entry.source.name ?? ""), file: true, pageId: null, pageNumber: null, rect: null, children: entry.nodes }));
}

/** How many entries a tree has (headings of files not counted). */
export function countOutline(nodes) {
  let count = 0;
  for (const node of nodes || []) count += (node.file ? 0 : 1) + countOutline(node.children);
  return count;
}

/** The keys of every node that has children, down to `depth` levels (1 = the top level only; Infinity = all). */
export function expandableKeys(nodes, depth = Infinity, level = 1) {
  const keys = [];
  for (const node of nodes || []) {
    if (!node.children.length) continue;
    if (level <= depth || node.file) keys.push(node.key);
    keys.push(...expandableKeys(node.children, depth, level + (node.file ? 0 : 1)));
  }
  return keys;
}

/**
 * The rows a tree shows: every node whose ancestors are all expanded.
 * @param {object[]} nodes
 * @param {Set<string>} expanded   keys of the open nodes
 * @returns {Array<{ node, key, level, parentKey: string | null, expandable: boolean, expanded: boolean, setSize, posInSet }>}
 */
export function visibleOutlineRows(nodes, expanded, level = 1, parentKey = null) {
  const rows = [];
  (nodes || []).forEach((node, index) => {
    const expandable = node.children.length > 0;
    const open = expandable && expanded.has(node.key);
    rows.push({ node, key: node.key, level, parentKey, expandable, expanded: open, setSize: nodes.length, posInSet: index + 1 });
    if (open) rows.push(...visibleOutlineRows(node.children, expanded, level + 1, node.key));
  });
  return rows;
}

/**
 * What a key does in the tree (the APG tree view pattern).
 * @param {ReturnType<typeof visibleOutlineRows>} rows
 * @param {string | null} focusKey
 * @param {string} key   KeyboardEvent.key
 * @returns {{ focus?: string, expand?: string, collapse?: string, activate?: string, expandSiblings?: string[] } | null}
 */
export function outlineKeyAction(rows, focusKey, key) {
  if (!rows.length) return null;
  const index = Math.max(0, rows.findIndex((row) => row.key === focusKey));
  const row = rows[index];
  if (key === "ArrowDown") return index + 1 < rows.length ? { focus: rows[index + 1].key } : {};
  if (key === "ArrowUp") return index > 0 ? { focus: rows[index - 1].key } : {};
  if (key === "Home") return { focus: rows[0].key };
  if (key === "End") return { focus: rows[rows.length - 1].key };
  if (key === "ArrowRight") {
    if (!row.expandable) return {};
    if (!row.expanded) return { expand: row.key };
    return { focus: rows[index + 1].key };
  }
  if (key === "ArrowLeft") {
    if (row.expanded) return { collapse: row.key };
    return row.parentKey ? { focus: row.parentKey } : {};
  }
  if (key === "Enter" || key === " ") {
    if (row.node.pageId) return { activate: row.key };
    if (row.expandable) return row.expanded ? { collapse: row.key } : { expand: row.key };
    return {};
  }
  if (key === "*") return { expandSiblings: rows.filter((other) => other.parentKey === row.parentKey && other.expandable).map((other) => other.key) };
  return null;
}

/** The key of the entry a reader is in: the last entry (in tree order) whose page is not after `pageNumber`. */
export function currentOutlineKey(nodes, pageNumber) {
  let best = null;
  let bestPage = 0;
  const walk = (list) => {
    for (const node of list || []) {
      if (node.pageNumber && node.pageNumber <= pageNumber && node.pageNumber >= bestPage) {
        best = node.key;
        bestPage = node.pageNumber;
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return best;
}

/** The keys of the ancestors of a node (to open the way to it), or null when it is not in the tree. */
export function outlinePathTo(nodes, key, trail = []) {
  for (const node of nodes || []) {
    if (node.key === key) return trail;
    const found = outlinePathTo(node.children, key, [...trail, node.key]);
    if (found) return found;
  }
  return null;
}
