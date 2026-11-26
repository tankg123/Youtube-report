// The arithmetic of the page panels and the page organiser (src/pages/pdfEditor/pages/pageLogic.js): page
// ranges, selection, the grid, drop positions, keyboard moves, blank page sizes, pictures as pages, the EXIF
// orientation of a JPEG, and the outline of the sources mapped to the working document.
import test from "node:test";
import assert from "node:assert/strict";
import { PAGE_SIZES } from "../src/pages/pdfEditor/engine/geometry.js";
import { moveIndexForDrop } from "../src/pages/pdfEditor/model/selectors.js";
import {
  BLANK_FORMATS,
  CUSTOM_SIZE_MM,
  POINTS_PER_MM,
  SOURCE_COLORS,
  blankPageSize,
  buildOutlineTree,
  clickSelection,
  columnsOf,
  countOutline,
  currentOutlineKey,
  directionOfKey,
  dropGapAt,
  dropTarget,
  edgeScrollSpeed,
  expandableKeys,
  extendSelection,
  extractFileName,
  formatPageRange,
  gridNeighbour,
  imagePageLayout,
  insertionIndex,
  jpegOrientation,
  keyboardMoveTarget,
  mapOutline,
  orderAfterDrop,
  orderedSelection,
  outlineKeyAction,
  outlinePathTo,
  parseDecimal,
  parsePageRange,
  pendingMarkCounts,
  placeOfIndex,
  positionMoveTarget,
  rangeBetween,
  readPageNumber,
  sourceColors,
  storedImageKind,
  tilesInBox,
  toggleSelection,
  visibleOutlineRows
} from "../src/pages/pdfEditor/pages/pageLogic.js";

const EN_DASH = String.fromCharCode(0x2013);
const ids = (count) => Array.from({ length: count }, (_, index) => `p${index + 1}`);

// --- page ranges ----------------------------------------------------------------------------------------------

test("a page range is read as people type it", () => {
  const read = (text, count = 10, options) => parsePageRange(text, count, options);
  assert.deepEqual(read("all", 4), { ok: true, indices: [0, 1, 2, 3] });
  assert.deepEqual(read(" ALL ", 2), { ok: true, indices: [0, 1] });
  assert.deepEqual(read("*", 2), { ok: true, indices: [0, 1] });
  assert.deepEqual(read("Tất cả", 3, { allWords: ["tất cả"] }), { ok: true, indices: [0, 1, 2] });
  assert.deepEqual(read("1-3, 7"), { ok: true, indices: [0, 1, 2, 6] });
  assert.deepEqual(read("1-3;7"), { ok: true, indices: [0, 1, 2, 6] });
  assert.deepEqual(read("1 - 3  7"), { ok: true, indices: [0, 1, 2, 6] });
  assert.deepEqual(read(`2${EN_DASH}4`), { ok: true, indices: [1, 2, 3] }, "an en dash is a dash");
  assert.deepEqual(read("5"), { ok: true, indices: [4] });
  assert.deepEqual(read("8-"), { ok: true, indices: [7, 8, 9] }, "an open end runs to the last page");
  assert.deepEqual(read("-3"), { ok: true, indices: [0, 1, 2] }, "an open start runs from the first page");
  assert.deepEqual(read("7-5"), { ok: true, indices: [6, 5, 4] }, "a range written backwards keeps that order");
  assert.deepEqual(read("3, 1-4, 3"), { ok: true, indices: [2, 0, 1, 3] }, "a page named twice is taken once, where it came first");
  assert.deepEqual(read("10"), { ok: true, indices: [9] });
});

test("a page range that cannot be read says what is wrong, and with which part", () => {
  const read = (text, count = 10) => parsePageRange(text, count);
  assert.deepEqual(read(""), { ok: false, problem: "empty", token: "" });
  assert.deepEqual(read("   "), { ok: false, problem: "empty", token: "" });
  assert.deepEqual(read(", ;"), { ok: false, problem: "empty", token: "" });
  assert.deepEqual(read("abc"), { ok: false, problem: "syntax", token: "abc" });
  assert.deepEqual(read("1-2-3"), { ok: false, problem: "syntax", token: "1-2-3" });
  assert.deepEqual(read("1, -"), { ok: false, problem: "syntax", token: "-" });
  assert.deepEqual(read("1.5"), { ok: false, problem: "syntax", token: "1.5" });
  assert.deepEqual(read("0"), { ok: false, problem: "bounds", token: "0" });
  assert.deepEqual(read("11"), { ok: false, problem: "bounds", token: "11" });
  assert.deepEqual(read("3-12"), { ok: false, problem: "bounds", token: "3-12" });
  assert.deepEqual(read("1, 99999999999999999999"), { ok: false, problem: "syntax", token: "99999999999999999999" });
  assert.deepEqual(parsePageRange("1", 0), { ok: false, problem: "empty", token: "" }, "a file without pages has no range");
  assert.deepEqual(parsePageRange(null, 3), { ok: false, problem: "empty", token: "" });
});

test("page numbers are written back as a range, and an extract is named after them", () => {
  assert.equal(formatPageRange([3, 4, 5]), "3-5");
  assert.equal(formatPageRange([5, 1, 3, 4, 9, 9]), "1, 3-5, 9");
  assert.equal(formatPageRange([]), "");
  // what the field shows can be read back
  assert.deepEqual(parsePageRange(formatPageRange([2, 3, 4, 8]), 10).indices, [1, 2, 3, 7]);
  assert.equal(extractFileName("hop-dong", [3, 4, 5]), "hop-dong-pages-3-5.pdf");
  assert.equal(extractFileName("hop-dong.pdf", [1, 3, 4, 7]), "hop-dong-pages-1,3-4,7.pdf");
  assert.equal(extractFileName("hop-dong", [2]), "hop-dong-pages-2.pdf");
  assert.equal(extractFileName("", [2, 3]), "document-pages-2-3.pdf");
  assert.equal(extractFileName("a", [1, 3, 5, 7, 9, 11, 13]), "a-pages-1-13.pdf", "too many separate pages are named by the first and the last");
});

// --- selection ------------------------------------------------------------------------------------------------

test("click, Ctrl + click and Shift + click select pages as a file manager does", () => {
  const list = ids(6);
  let state = { selected: [], anchor: null };
  state = clickSelection(list, state, "p2");
  assert.deepEqual(state, { selected: ["p2"], anchor: "p2", focus: "p2" });
  state = clickSelection(list, state, "p5", { shift: true });
  assert.deepEqual(state, { selected: ["p2", "p3", "p4", "p5"], anchor: "p2", focus: "p5" }, "Shift takes the range from the anchor");
  state = clickSelection(list, state, "p1", { shift: true });
  assert.deepEqual(state.selected, ["p1", "p2"], "the range turns around the same anchor");
  state = clickSelection(list, state, "p4", { ctrl: true });
  assert.deepEqual(state, { selected: ["p1", "p2", "p4"], anchor: "p4", focus: "p4" }, "Ctrl adds a page; it is the new anchor");
  state = clickSelection(list, state, "p2", { ctrl: true });
  assert.deepEqual(state.selected, ["p1", "p4"], "Ctrl on a selected page takes it out");
  state = clickSelection(list, state, "p6", { ctrl: true, shift: true });
  assert.deepEqual(state.selected, ["p1", "p2", "p3", "p4", "p5", "p6"], "Ctrl + Shift adds the range to what is selected");
  state = clickSelection(list, state, "p3");
  assert.deepEqual(state.selected, ["p3"], "a plain click selects only that page");
  assert.deepEqual(clickSelection(list, { selected: ["p1"], anchor: "gone" }, "p3", { shift: true }).selected, ["p3"], "Shift without a living anchor is a plain click");
  assert.deepEqual(clickSelection(list, { selected: ["p1", "ghost"], anchor: "p1" }, "nobody").selected, ["p1"], "an unknown page changes nothing, stale ids are dropped");
});

test("Shift + arrows extend from the anchor; Space toggles the focused page", () => {
  const list = ids(6);
  let state = { selected: ["p3"], anchor: "p3", focus: "p3" };
  state = extendSelection(list, state, "p4");
  state = extendSelection(list, state, "p5");
  assert.deepEqual(state, { selected: ["p3", "p4", "p5"], anchor: "p3", focus: "p5" });
  state = extendSelection(list, state, "p2");
  assert.deepEqual(state.selected, ["p2", "p3"]);
  assert.deepEqual(extendSelection(list, { selected: [], anchor: null, focus: "p2" }, "p4").selected, ["p2", "p3", "p4"], "without an anchor the focused page starts the range");
  assert.deepEqual(toggleSelection(list, { selected: ["p1"], anchor: "p1" }, "p4").selected, ["p1", "p4"]);
  assert.deepEqual(toggleSelection(list, { selected: ["p1", "p4"], anchor: "p1" }, "p4").selected, ["p1"]);
  assert.deepEqual(orderedSelection(list, ["p5", "zz", "p2"]), ["p2", "p5"]);
  assert.deepEqual(rangeBetween(list, "p5", "p3"), ["p3", "p4", "p5"]);
});

// --- the grid --------------------------------------------------------------------------------------------------

test("arrow keys walk a wrapped grid", () => {
  assert.equal(columnsOf([0, 0, 0, 120, 120]), 3);
  assert.equal(columnsOf([0, 150, 300]), 1);
  assert.equal(columnsOf([]), 1);
  // 8 tiles in 3 columns:  0 1 2 / 3 4 5 / 6 7
  assert.equal(gridNeighbour(4, 8, 3, "left"), 3);
  assert.equal(gridNeighbour(2, 8, 3, "right"), 3, "right wraps to the next row");
  assert.equal(gridNeighbour(0, 8, 3, "left"), 0, "the first page stays");
  assert.equal(gridNeighbour(7, 8, 3, "right"), 7, "the last page stays");
  assert.equal(gridNeighbour(4, 8, 3, "up"), 1);
  assert.equal(gridNeighbour(1, 8, 3, "up"), 1);
  assert.equal(gridNeighbour(4, 8, 3, "down"), 7);
  assert.equal(gridNeighbour(5, 8, 3, "down"), 7, "below the last column of a short row is the last page");
  assert.equal(gridNeighbour(7, 8, 3, "down"), 7);
  assert.equal(gridNeighbour(3, 8, 3, "home"), 0);
  assert.equal(gridNeighbour(3, 8, 3, "end"), 7);
  assert.equal(gridNeighbour(0, 0, 3, "right"), -1);
  assert.equal(directionOfKey("ArrowUp"), "up");
  assert.equal(directionOfKey("End"), "end");
  assert.equal(directionOfKey("a"), null);
});

// --- dragging ---------------------------------------------------------------------------------------------------

/** A grid of `count` tiles, `columns` wide: tiles of 100 x 140 with 20 between them, starting at (10, 10). */
const grid = (count, columns) => Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, left: 10 + (index % columns) * 120, top: 10 + Math.floor(index / columns) * 160, width: 100, height: 140 }));

test("the drop position follows the pointer: the nearer half of a tile decides", () => {
  const tiles = grid(8, 3);
  assert.deepEqual(dropGapAt(tiles, 20, 50), { gap: 0, bar: { x: 0, top: 10, height: 140 } }, "left half of the first tile: before it");
  assert.equal(dropGapAt(tiles, 70, 50).gap, 1, "right half of the first tile: after it");
  assert.deepEqual(dropGapAt(tiles, 70, 50).bar, { x: 120, top: 10, height: 140 }, "the bar sits in the middle of the space between two tiles");
  assert.equal(dropGapAt(tiles, 500, 50).gap, 3, "right of the row: after its last tile");
  assert.equal(dropGapAt(tiles, 500, 50).bar.x, 360);
  assert.equal(dropGapAt(tiles, 20, 200).gap, 3, "the same gap seen from the next row");
  assert.equal(dropGapAt(tiles, 20, 200).bar.top, 170, "... with the bar in that row");
  assert.equal(dropGapAt(tiles, 400, 400).gap, 8, "after the last page");
  assert.equal(dropGapAt(tiles, 20, -500).gap, 0, "above the grid: the first row");
  assert.equal(dropGapAt(tiles, 150, 5000).gap, 7, "below the grid: the last row");
  assert.equal(dropGapAt(tiles, 20, 154).gap, 0, "between two rows the nearer one wins");
  assert.equal(dropGapAt(tiles, 20, 166).gap, 3);
  assert.equal(dropGapAt([], 0, 0), null);
  // a single column (a narrow panel): gaps follow the rows
  const column = grid(3, 1);
  assert.equal(dropGapAt(column, 20, 50).gap, 0);
  assert.equal(dropGapAt(column, 90, 50).gap, 1);
  assert.equal(dropGapAt(column, 20, 200).gap, 1);
});

test("a drop becomes the index store.movePages wants, and tells when nothing would change", () => {
  const list = ids(6);
  assert.deepEqual(orderAfterDrop(list, ["p2"], 5), ["p1", "p3", "p4", "p5", "p2", "p6"]);
  assert.deepEqual(orderAfterDrop(list, ["p5", "p2"], 0), ["p2", "p5", "p1", "p3", "p4", "p6"], "several pages keep their document order");
  assert.deepEqual(dropTarget(list, ["p2"], 5), { toIndex: 4, changes: true, position: 5 });
  assert.deepEqual(dropTarget(list, ["p2"], 1), { toIndex: 1, changes: false, position: 2 }, "dropped just before itself");
  assert.deepEqual(dropTarget(list, ["p2"], 2), { toIndex: 1, changes: false, position: 2 }, "dropped just after itself");
  assert.deepEqual(dropTarget(list, ["p2", "p3"], 3), { toIndex: 1, changes: false, position: 2 });
  assert.deepEqual(dropTarget(list, ["p2", "p4"], 3), { toIndex: 2, changes: true, position: 3 }, "pages that were apart are brought together");
  assert.deepEqual(dropTarget(list, ["p6"], 0), { toIndex: 0, changes: true, position: 1 });
  // the same arithmetic as the selector the store documents
  const pages = list.map((id) => ({ id }));
  for (let gap = 0; gap <= list.length; gap += 1) assert.equal(dropTarget(list, ["p3", "p4"], gap).toIndex, moveIndexForDrop(pages, ["p3", "p4"], gap));
});

test("Ctrl+Shift+arrows move the selection one place; Move to position puts it at a number", () => {
  const list = ids(5);
  const apply = (moving, target) => {
    const rest = list.filter((id) => !moving.includes(id));
    return [...rest.slice(0, target.toIndex), ...moving, ...rest.slice(target.toIndex)];
  };
  assert.deepEqual(apply(["p3"], keyboardMoveTarget(list, ["p3"], "earlier")), ["p1", "p3", "p2", "p4", "p5"]);
  assert.deepEqual(apply(["p3"], keyboardMoveTarget(list, ["p3"], "later")), ["p1", "p2", "p4", "p3", "p5"]);
  assert.equal(keyboardMoveTarget(list, ["p1"], "earlier"), null, "the first page cannot go earlier");
  assert.equal(keyboardMoveTarget(list, ["p5"], "later"), null);
  assert.deepEqual(apply(["p2", "p3"], keyboardMoveTarget(list, ["p2", "p3"], "later")), ["p1", "p4", "p2", "p3", "p5"], "a block moves as one");
  assert.deepEqual(apply(["p2", "p4"], keyboardMoveTarget(list, ["p4", "p2"], "earlier")), ["p2", "p4", "p1", "p3", "p5"], "pages that were apart gather at the new place");
  assert.deepEqual(apply(["p1", "p3"], keyboardMoveTarget(list, ["p1", "p3"], "earlier")), ["p1", "p3", "p2", "p4", "p5"], "at the edge the pages still gather");
  assert.equal(keyboardMoveTarget(list, ["p1", "p2"], "earlier"), null);
  assert.equal(keyboardMoveTarget(list, list, "later"), null, "all pages selected: nothing to move past");
  assert.equal(keyboardMoveTarget(list, [], "later"), null);
  assert.deepEqual(keyboardMoveTarget(list, ["p3"], "later"), { toIndex: 3, position: 4 });

  assert.deepEqual(positionMoveTarget(list, ["p4"], 1), { toIndex: 0, position: 1, changes: true });
  assert.deepEqual(positionMoveTarget(list, ["p1"], 5), { toIndex: 4, position: 5, changes: true });
  assert.deepEqual(positionMoveTarget(list, ["p1", "p2"], 99), { toIndex: 3, position: 4, changes: true }, "a number past the end is the end");
  assert.deepEqual(positionMoveTarget(list, ["p2"], 2), { toIndex: 1, position: 2, changes: false });
  assert.deepEqual(positionMoveTarget(list, ["p2"], "x"), { toIndex: 0, position: 1, changes: true }, "no number is the first place");
});

test("a marquee selects the tiles it touches; a list scrolls faster the nearer the pointer is to its edge", () => {
  const tiles = grid(6, 3);
  assert.deepEqual(tilesInBox(tiles, 0, 0, 5, 5), []);
  assert.deepEqual(tilesInBox(tiles, 50, 50, 150, 60), ["p1", "p2"]);
  assert.deepEqual(tilesInBox(tiles, 150, 200, 50, 50), ["p1", "p2", "p4", "p5"], "the corners may come in any order");
  assert.deepEqual(tilesInBox(tiles, 111, 0, 129, 500), [], "the space between two columns touches nothing");

  assert.equal(edgeScrollSpeed(300, 600), 0);
  assert.ok(edgeScrollSpeed(10, 600) < 0);
  assert.ok(edgeScrollSpeed(590, 600) > 0);
  assert.ok(Math.abs(edgeScrollSpeed(-40, 600)) >= Math.abs(edgeScrollSpeed(30, 600)), "outside the list it is fastest");
  assert.ok(edgeScrollSpeed(0, 600) < edgeScrollSpeed(40, 600));
  assert.equal(edgeScrollSpeed(10, 0), 0);
});

// --- blank pages -------------------------------------------------------------------------------------------------

test("the size of a blank page: named formats in both orientations, a typed size, the size of a page", () => {
  assert.deepEqual(BLANK_FORMATS, ["current", "A4", "A3", "A5", "LETTER", "LEGAL", "custom"]);
  assert.deepEqual(blankPageSize({ format: "A4" }), { ok: true, size: [595.28, 841.89] });
  assert.deepEqual(blankPageSize({ format: "A4", orientation: "landscape" }), { ok: true, size: [841.89, 595.28] });
  assert.deepEqual(blankPageSize({ format: "A3" }).size, [...PAGE_SIZES.A3]);
  assert.deepEqual(blankPageSize({ format: "A5", orientation: "landscape" }).size, [595.28, 419.53]);
  assert.deepEqual(blankPageSize({ format: "LETTER" }).size, [612, 792]);
  assert.deepEqual(blankPageSize({ format: "LEGAL", orientation: "landscape" }).size, [1008, 612]);
  assert.deepEqual(blankPageSize({ format: "B5" }), { ok: false, problem: "format" });
  assert.deepEqual(blankPageSize({ format: "constructor" }), { ok: false, problem: "format" });

  const custom = blankPageSize({ format: "custom", widthMm: 210, heightMm: 297 });
  assert.equal(custom.ok, true);
  assert.ok(Math.abs(custom.size[0] - 595.28) < 0.01 && Math.abs(custom.size[1] - 841.89) < 0.01, "210 x 297 mm is A4");
  assert.deepEqual(blankPageSize({ format: "custom", widthMm: 100, heightMm: 50 }).size, [283.46, 141.73], "a typed size is taken as typed, lying or upright");
  assert.deepEqual(blankPageSize({ format: "custom", widthMm: 5, heightMm: 100 }), { ok: false, problem: "width" });
  assert.deepEqual(blankPageSize({ format: "custom", widthMm: 100, heightMm: 6000 }), { ok: false, problem: "height" });
  assert.deepEqual(blankPageSize({ format: "custom", widthMm: NaN, heightMm: 100 }), { ok: false, problem: "width" });
  assert.ok(CUSTOM_SIZE_MM.max * POINTS_PER_MM <= 14400, "the largest typed size is one the store accepts");

  const page = { id: "p", kind: "pdf", sourceId: "s", sourceIndex: 0, view: [0, 0, 400, 300], baseRotation: 90, userUnit: 1, rotation: 0, objectIds: [] };
  assert.deepEqual(blankPageSize({ format: "current", page }), { ok: true, size: [300, 400] }, "as the page is seen: its own /Rotate applied");
  assert.deepEqual(blankPageSize({ format: "current", page: { ...page, rotation: 90 } }).size, [400, 300], "... and the rotation the user added");
  assert.deepEqual(blankPageSize({ format: "current", page: { ...page, baseRotation: 0, view: [10, 20, 110, 220] } }).size, [100, 200], "the visible box, not its origin");
  assert.deepEqual(blankPageSize({ format: "current" }), { ok: false, problem: "page" });

  assert.equal(parseDecimal("210"), 210);
  assert.equal(parseDecimal(" 215,9 "), 215.9);
  assert.equal(parseDecimal("215.9"), 215.9);
  assert.ok(Number.isNaN(parseDecimal("")));
  assert.ok(Number.isNaN(parseDecimal("12 mm")));
  assert.ok(Number.isNaN(parseDecimal("-5")));

  assert.equal(insertionIndex(5, 3, "before"), 2);
  assert.equal(insertionIndex(5, 3, "after"), 3);
  assert.equal(insertionIndex(5, 5, "after"), 5);
  assert.equal(insertionIndex(5, 99, "after"), 5, "a number past the end is the last page");
  assert.equal(insertionIndex(5, 0, "before"), 0);
  assert.equal(insertionIndex(5, "x", "after"), 1);

  // what a dialog shows for an insertion index, and what it reads back
  assert.deepEqual(placeOfIndex(0, 5), { place: "before", pageNumber: "1" });
  assert.deepEqual(placeOfIndex(3, 5), { place: "after", pageNumber: "3" });
  assert.deepEqual(placeOfIndex(5, 5), { place: "after", pageNumber: "5" });
  assert.deepEqual(placeOfIndex(99, 5), { place: "after", pageNumber: "5" });
  for (let index = 0; index <= 5; index += 1) {
    const shown = placeOfIndex(index, 5);
    assert.equal(insertionIndex(5, readPageNumber(shown.pageNumber, 5), shown.place), index, "the fields describe the index they were made from");
  }
  assert.equal(readPageNumber(" 4 ", 5), 4);
  assert.equal(readPageNumber("0", 5), null);
  assert.equal(readPageNumber("6", 5), null);
  assert.equal(readPageNumber("2.5", 5), null);
  assert.equal(readPageNumber("", 5), null);
  assert.equal(readPageNumber("1e0", 5), null);
});

// --- pictures as pages ----------------------------------------------------------------------------------------

test("a picture becomes a page: fitted on A4, or a page of its own size", () => {
  const upright = imagePageLayout({ width: 1000, height: 2000 }, "a4");
  assert.deepEqual(upright.size, [595.28, 841.89]);
  assert.deepEqual(upright.frame, { x: 297.64, y: 420.945, w: 420.95, h: 841.89, rot: 0 }, "as large as the page allows, centred, its ratio kept");
  const lying = imagePageLayout({ width: 2000, height: 1000 }, "a4");
  assert.deepEqual(lying.size, [841.89, 595.28], "a lying picture gets a lying page");
  assert.ok(Math.abs(lying.frame.w / lying.frame.h - 2) < 0.001);
  assert.ok(lying.frame.w <= 841.89 && lying.frame.h <= 595.28);
  const small = imagePageLayout({ width: 100, height: 100 }, "a4");
  assert.deepEqual([small.frame.w, small.frame.h], [595.28, 595.28], "a small picture is enlarged to the page");

  const own = imagePageLayout({ width: 800, height: 600 }, "image");
  assert.deepEqual(own.size, [600, 450], "96 pixels per inch");
  assert.deepEqual(own.frame, { x: 300, y: 225, w: 600, h: 450, rot: 0 }, "the picture covers its page");
  const huge = imagePageLayout({ width: 40000, height: 20000 }, "image");
  assert.deepEqual(huge.size, [14400, 7200], "never larger than a page may be");
  const tiny = imagePageLayout({ width: 4, height: 8 }, "image");
  assert.deepEqual(tiny.size, [36, 72], "never so small that it cannot be seen");
  assert.equal(imagePageLayout({ width: 0, height: 10 }, "a4"), null);
  assert.equal(imagePageLayout(null, "image"), null);
});

/** A JPEG header with an EXIF block that carries the orientation tag. */
function jpegWithOrientation(value, { little = true, padding = 0 } = {}) {
  const tiff = new DataView(new ArrayBuffer(8 + 2 + 12 * 2 + 4));
  tiff.setUint16(0, little ? 0x4949 : 0x4d4d);
  tiff.setUint16(2, 42, little);
  tiff.setUint32(4, 8, little);
  tiff.setUint16(8, 2, little);
  // first entry: another tag; second: the orientation
  tiff.setUint16(10, 0x010f, little);
  tiff.setUint16(22, 0x0112, little);
  tiff.setUint16(24, 3, little);
  tiff.setUint32(26, 1, little);
  tiff.setUint16(30, value, little);
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...new Uint8Array(tiff.buffer)];
  const app0 = padding ? [0xff, 0xe0, 0, padding + 2, ...new Array(padding).fill(7)] : [];
  const length = exif.length + 2;
  return Uint8Array.from([0xff, 0xd8, ...app0, 0xff, 0xe1, length >> 8, length & 255, ...exif, 0xff, 0xda, 0, 2, 1, 2, 3, 4, 5, 6, 7, 8]);
}

test("the EXIF orientation of a JPEG is found (a PDF would ignore it)", () => {
  assert.equal(jpegOrientation(jpegWithOrientation(6)), 6);
  assert.equal(jpegOrientation(jpegWithOrientation(3, { little: false })), 3);
  assert.equal(jpegOrientation(jpegWithOrientation(8, { padding: 14 })), 8, "after another block");
  assert.equal(jpegOrientation(jpegWithOrientation(1)), 1);
  assert.equal(jpegOrientation(jpegWithOrientation(77)), 1, "a value that means nothing");
  assert.equal(jpegOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0])), 1, "no EXIF block");
  assert.equal(jpegOrientation(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0])), 1, "not a JPEG");
  assert.equal(jpegOrientation(jpegWithOrientation(6).subarray(0, 20)), 1, "a file that ends inside the block");
  assert.equal(storedImageKind(jpegWithOrientation(6)), "jpeg");
  assert.equal(storedImageKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0])), "png");
  assert.equal(storedImageKind(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), null, "WebP is drawn again before it is stored");
  assert.equal(storedImageKind(new Uint8Array(4)), null);
});

// --- sources and marks ---------------------------------------------------------------------------------------

test("source files get a colour only when there are several; marks are counted per page", () => {
  const page = (id, sourceId, objectIds = []) => ({ id, kind: sourceId ? "pdf" : "blank", sourceId: sourceId || null, sourceIndex: sourceId ? 0 : null, objectIds });
  assert.equal(sourceColors([page("a", "s1"), page("b", "s1"), page("c", null)]).size, 0, "one file and blank pages: no bars");
  const colors = sourceColors([page("a", "s2"), page("b", "s1"), page("c", "s2"), page("d", null)]);
  assert.deepEqual([...colors], [["s2", SOURCE_COLORS[0]], ["s1", SOURCE_COLORS[1]]], "in the order of their first page");
  const many = sourceColors(Array.from({ length: 10 }, (_, index) => page(`p${index}`, `s${index}`)));
  assert.equal(many.get("s8"), SOURCE_COLORS[0], "more files than colours: the colours repeat");

  const objects = { r1: { type: "redact" }, b1: { type: "blur" }, t1: { type: "text" }, r2: { type: "redact" } };
  const counts = pendingMarkCounts([page("a", "s1", ["r1", "t1", "b1"]), page("b", "s1", ["t1"]), page("c", "s1", ["r2", "gone"])], objects);
  assert.deepEqual([...counts], [["a", 2], ["c", 1]]);
});

// --- outline ---------------------------------------------------------------------------------------------------

const OUTLINE = [
  { title: "Chapter 1", pageIndex: 0, rect: [0, 700, 0, 700], children: [{ title: "1.1", pageIndex: 1, rect: null, children: [] }, { title: "1.2", pageIndex: 2, rect: null, children: [] }] },
  { title: "Chapter 2", pageIndex: 3, rect: null, children: [{ title: "2.1", pageIndex: 4, rect: null, children: [{ title: "2.1.1", pageIndex: 4, rect: null, children: [] }] }] },
  { title: "External link", pageIndex: null, rect: null, children: [] }
];
const sourcePages = (sourceId, indices) => indices.map((sourceIndex, position) => ({ id: `${sourceId}-${sourceIndex}-${position}`, kind: "pdf", sourceId, sourceIndex, objectIds: [] }));
const flat = (nodes, depth = 0) => nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.title}@${node.pageNumber ?? "-"}`, ...flat(node.children, depth + 1)]);

test("outline entries point at the pages of the working document", () => {
  const pages = sourcePages("s1", [0, 1, 2, 3, 4]);
  const nodes = mapOutline(OUTLINE, pages, "s1");
  assert.deepEqual(flat(nodes), ["Chapter 1@1", "  1.1@2", "  1.2@3", "Chapter 2@4", "  2.1@5", "    2.1.1@5"], "an entry without a page of this file is left out");
  assert.equal(nodes[0].pageId, "s1-0-0");
  assert.deepEqual(nodes[0].rect, [0, 700, 0, 700]);
  assert.equal(countOutline(nodes), 6);
  assert.equal(new Set(flat(nodes).map((_, index) => index)).size, 6);
  const keys = [];
  const collect = (list) => list.forEach((node) => (keys.push(node.key), collect(node.children)));
  collect(nodes);
  assert.equal(new Set(keys).size, keys.length, "every entry has its own key");
});

test("outline entries follow reordered pages and disappear with deleted ones", () => {
  // the pages in another order, with a blank page between them
  const reordered = [...sourcePages("s1", [4, 3]), { id: "blank", kind: "blank", sourceId: null, sourceIndex: null, objectIds: [] }, ...sourcePages("s1", [0, 1, 2])];
  assert.deepEqual(flat(mapOutline(OUTLINE, reordered, "s1")), ["Chapter 1@4", "  1.1@5", "  1.2@6", "Chapter 2@2", "  2.1@1", "    2.1.1@1"]);

  // page 2 of the file deleted: its entry goes, its siblings stay
  assert.deepEqual(flat(mapOutline(OUTLINE, sourcePages("s1", [0, 2, 3, 4]), "s1")), ["Chapter 1@1", "  1.2@2", "Chapter 2@3", "  2.1@4", "    2.1.1@4"]);

  // the page of a chapter deleted while a section under it lives: the chapter stays as a heading without a page
  const headless = mapOutline(OUTLINE, sourcePages("s1", [1, 4]), "s1");
  assert.deepEqual(flat(headless), ["Chapter 1@-", "  1.1@1", "Chapter 2@-", "  2.1@2", "    2.1.1@2"]);
  assert.equal(headless[0].pageId, null);

  // a whole chapter deleted
  assert.deepEqual(flat(mapOutline(OUTLINE, sourcePages("s1", [0, 1, 2]), "s1")), ["Chapter 1@1", "  1.1@2", "  1.2@3"]);
  // nothing of this file left
  assert.deepEqual(mapOutline(OUTLINE, sourcePages("other", [0, 1]), "s1"), []);
  // a duplicated page: the entry points at the first copy
  assert.equal(mapOutline(OUTLINE, sourcePages("s1", [3, 0, 0]), "s1")[0].pageNumber, 2);
});

test("a damaged outline does not break the panel", () => {
  const loop = { title: "Loop", pageIndex: 0, rect: null, children: [] };
  loop.children.push(loop);
  assert.deepEqual(flat(mapOutline([loop, null, "text", { title: null, pageIndex: 0 }], sourcePages("s1", [0]), "s1")), ["Loop@1", "@1"]);
  assert.deepEqual(mapOutline(undefined, [], "s1"), []);
  assert.deepEqual(mapOutline([{ title: "Far", pageIndex: 99, children: [] }, { title: "Odd", pageIndex: 1.5, children: [] }], sourcePages("s1", [0]), "s1"), []);
});

test("several source files: each outline hangs under its file name", () => {
  const pages = [...sourcePages("s1", [0, 1]), ...sourcePages("s2", [0])];
  const sources = [
    { id: "s1", name: "hop-dong.pdf", outline: OUTLINE },
    { id: "s2", name: "phu-luc.pdf", outline: [{ title: "Appendix", pageIndex: 0, rect: null, children: [] }] },
    { id: "s3", name: "no-outline.pdf", outline: [] }
  ];
  const tree = buildOutlineTree(sources, pages);
  assert.deepEqual(flat(tree), ["hop-dong.pdf@-", "  Chapter 1@1", "    1.1@2", "phu-luc.pdf@-", "  Appendix@3"], "a file without entries has no node");
  assert.equal(tree[0].file, true);
  assert.equal(countOutline(tree), 3, "file names are not entries");
  assert.deepEqual(flat(buildOutlineTree([sources[0]], sourcePages("s1", [0, 1, 2, 3, 4]))).slice(0, 2), ["Chapter 1@1", "  1.1@2"], "one file: no file node");
  assert.deepEqual(buildOutlineTree([], []), []);
  assert.deepEqual(buildOutlineTree([sources[2]], sourcePages("s3", [0])), []);
});

test("the tree shows the rows whose ancestors are open, and its keys follow the tree view pattern", () => {
  const nodes = mapOutline(OUTLINE, sourcePages("s1", [0, 1, 2, 3, 4]), "s1");
  const [chapter1, chapter2] = nodes;
  assert.deepEqual(expandableKeys(nodes), [chapter1.key, chapter2.key, chapter2.children[0].key]);
  assert.deepEqual(expandableKeys(nodes, 1), [chapter1.key, chapter2.key]);
  assert.deepEqual(expandableKeys(nodes, 0), []);

  const closed = visibleOutlineRows(nodes, new Set());
  assert.deepEqual(closed.map((row) => [row.node.title, row.level, row.expandable, row.expanded, row.posInSet, row.setSize]), [["Chapter 1", 1, true, false, 1, 2], ["Chapter 2", 1, true, false, 2, 2]]);
  const open = visibleOutlineRows(nodes, new Set([chapter1.key]));
  assert.deepEqual(open.map((row) => `${row.level}:${row.node.title}`), ["1:Chapter 1", "2:1.1", "2:1.2", "1:Chapter 2"]);
  assert.equal(open[1].parentKey, chapter1.key);

  assert.deepEqual(outlineKeyAction(open, chapter1.key, "ArrowDown"), { focus: open[1].key });
  assert.deepEqual(outlineKeyAction(open, open[3].key, "ArrowDown"), {}, "the last row stays");
  assert.deepEqual(outlineKeyAction(open, open[1].key, "ArrowUp"), { focus: chapter1.key });
  assert.deepEqual(outlineKeyAction(open, open[2].key, "Home"), { focus: chapter1.key });
  assert.deepEqual(outlineKeyAction(open, chapter1.key, "End"), { focus: chapter2.key });
  assert.deepEqual(outlineKeyAction(open, chapter2.key, "ArrowRight"), { expand: chapter2.key }, "Right opens a closed node");
  assert.deepEqual(outlineKeyAction(open, chapter1.key, "ArrowRight"), { focus: open[1].key }, "Right on an open node goes to its first child");
  assert.deepEqual(outlineKeyAction(open, open[1].key, "ArrowRight"), {}, "Right on a leaf does nothing");
  assert.deepEqual(outlineKeyAction(open, chapter1.key, "ArrowLeft"), { collapse: chapter1.key }, "Left closes an open node");
  assert.deepEqual(outlineKeyAction(open, open[2].key, "ArrowLeft"), { focus: chapter1.key }, "Left on a child goes to its parent");
  assert.deepEqual(outlineKeyAction(open, chapter2.key, "ArrowLeft"), {});
  assert.deepEqual(outlineKeyAction(open, open[1].key, "Enter"), { activate: open[1].key });
  assert.deepEqual(outlineKeyAction(open, open[1].key, " "), { activate: open[1].key });
  assert.deepEqual(outlineKeyAction(open, chapter1.key, "*"), { expandSiblings: [chapter1.key, chapter2.key] });
  assert.equal(outlineKeyAction(open, chapter1.key, "a"), null, "other keys are not the tree's");
  assert.equal(outlineKeyAction([], null, "ArrowDown"), null);
  assert.deepEqual(outlineKeyAction(open, "unknown", "ArrowDown"), { focus: open[1].key }, "a lost focus starts at the first row");

  // a heading without a page: Enter opens and closes it
  const headless = mapOutline(OUTLINE, sourcePages("s1", [1, 4]), "s1");
  const rows = visibleOutlineRows(headless, new Set());
  assert.deepEqual(outlineKeyAction(rows, rows[0].key, "Enter"), { expand: rows[0].key });
});

test("the entry the reader is in, and the way to an entry", () => {
  const nodes = mapOutline(OUTLINE, sourcePages("s1", [0, 1, 2, 3, 4]), "s1");
  const title = (key) => {
    let found = null;
    const walk = (list) => list.forEach((node) => (node.key === key ? (found = node.title) : walk(node.children)));
    walk(nodes);
    return found;
  };
  assert.equal(title(currentOutlineKey(nodes, 1)), "Chapter 1");
  assert.equal(title(currentOutlineKey(nodes, 3)), "1.2");
  assert.equal(title(currentOutlineKey(nodes, 4)), "Chapter 2");
  assert.equal(title(currentOutlineKey(nodes, 5)), "2.1.1", "of several entries on one page the deepest, last one");
  assert.equal(title(currentOutlineKey(nodes, 99)), "2.1.1");
  assert.equal(currentOutlineKey(mapOutline(OUTLINE, sourcePages("s1", [2, 3]), "s1"), 0), null);
  const deep = nodes[1].children[0].children[0];
  assert.deepEqual(outlinePathTo(nodes, deep.key), [nodes[1].key, nodes[1].children[0].key]);
  assert.deepEqual(outlinePathTo(nodes, nodes[0].key), []);
  assert.equal(outlinePathTo(nodes, "nowhere"), null);
});
