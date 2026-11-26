// Picking lines of document text for Edit text, Redact and the Highlighter
// (src/pages/pdfEditor/overlay/textPick.js): which line is under a point, what a drag across text marks, the
// style of a replacement box and where its baseline goes.
import test from "node:test";
import assert from "node:assert/strict";
import { localToUser } from "../src/pages/pdfEditor/engine/geometry.js";
import { frameOnBaseline, isAxisAligned, isEditableLine, pickLine, quadBounds, replacementStyle, textDragQuads } from "../src/pages/pdfEditor/overlay/textPick.js";
import { closeAll } from "./helpers/pdfModelKit.mjs";

/** A horizontal line of text: baseline from (x, y) to (x + width, y), 12 pt tall with a 3 pt descent. */
function line(text, x, y, width, extra = {}) {
  const top = y + 9;
  const bottom = y - 3;
  return { text, rect: [x, bottom, x + width, top], quad: [x, top, x + width, top, x + width, bottom, x, bottom], baseline: [x, y, x + width, y], angle: 0, fontSize: 12, font: { name: "Helvetica", serif: false, monospace: false, bold: false, italic: false }, vertical: false, ...extra };
}
/** A line that reads upwards (90 degrees counter-clockwise in user space), as on a page with /Rotate 90. */
function upward(text, x, y, length) {
  const left = x - 9;
  const right = x + 3;
  return { text, rect: [left, y, right, y + length], quad: [left, y, left, y + length, right, y + length, right, y], baseline: [x, y, x, y + length], angle: 90, fontSize: 12, font: { name: null, serif: true, monospace: false, bold: true, italic: false }, vertical: false };
}

const PAGE = [line("First line of the page", 50, 700, 200), line("Second line, a little longer", 50, 680, 260), line("Third", 50, 660, 60), line("Column on the right", 400, 700, 120)];

test("a line is offered to Edit text when it reads along an axis of the page and holds text", () => {
  assert.equal(isAxisAligned(line("a", 0, 0, 10)), true);
  assert.equal(isAxisAligned(upward("a", 0, 0, 10)), true);
  assert.equal(isAxisAligned({ angle: -90 }), true);
  assert.equal(isAxisAligned({ angle: 180.6 }), true);
  assert.equal(isAxisAligned({ angle: 30 }), false);
  assert.equal(isAxisAligned({ angle: 88 }), false);
  assert.equal(isEditableLine(line("text", 0, 0, 10)), true);
  assert.equal(isEditableLine(line("   ", 0, 0, 10)), false, "nothing to read");
  assert.equal(isEditableLine(line("text", 0, 0, 10, { angle: 30 })), false, "slanted");
  assert.equal(isEditableLine(line("text", 0, 0, 10, { vertical: true })), false, "vertical writing");
  assert.equal(isEditableLine(null), false);
});

test("the line under a point: its index in the list of the page is the id the reducer carries", () => {
  assert.deepEqual(pickLine(PAGE, [60, 683], 0), { index: 1, line: PAGE[1] });
  assert.equal(pickLine(PAGE, [60, 670.2], 0), null, "between two lines");
  assert.equal(pickLine(PAGE, [60, 670.2], 1.5).index, 2, "with a tolerance the nearer line counts");
  assert.equal(pickLine(PAGE, [60, 673], 1.5), null, "but only that near");
  assert.equal(pickLine(PAGE, [350, 700], 0), null, "the gap between two columns");
  assert.equal(pickLine(PAGE, [450, 700], 0).index, 3);
  assert.equal(pickLine([], [0, 0], 5), null);
  assert.equal(pickLine(null, [0, 0], 5), null, "lines that have not arrived yet");
  const slanted = [line("slanted", 50, 700, 200, { angle: 30 }), PAGE[1]];
  assert.equal(pickLine(slanted, [60, 703], 0).index, 0);
  assert.equal(pickLine(slanted, [60, 703], 0, { editableOnly: true }), null, "Edit text does not offer it");
  assert.equal(pickLine(slanted, [60, 683], 0, { editableOnly: true }).index, 1, "the index is the position in the whole list");
});

test("a drag inside one line marks the stretch between the two points, with the height of the line box", () => {
  const [quad] = textDragQuads(PAGE, [100, 702], [180, 699]);
  assert.deepEqual(quad, [100, 709, 180, 709, 180, 697, 100, 697]);
  // backwards gives the same stretch
  assert.deepEqual(textDragQuads(PAGE, [180, 699], [100, 702]), [quad]);
  // beyond the ends of the line it stops at the line
  assert.deepEqual(textDragQuads(PAGE, [20, 700], [300, 700])[0], PAGE[0].quad);
  assert.deepEqual(quadBounds(quad), [100, 697, 180, 709]);
});

test("a drag across lines marks like a text selection: from the start point to the end of its line, whole lines between, the last line up to the end point", () => {
  const quads = textDragQuads(PAGE, [150, 700], [90, 661]);
  assert.equal(quads.length, 3);
  assert.deepEqual(quadBounds(quads[0]), [150, 697, 250, 709], "first line from the press to its end");
  assert.deepEqual(quadBounds(quads[1]), [50, 677, 310, 689], "the line between as a whole");
  assert.deepEqual(quadBounds(quads[2]), [50, 657, 90, 669], "last line from its start to the release");
  // dragging upwards marks the same text
  assert.deepEqual(textDragQuads(PAGE, [90, 661], [150, 700]).map(quadBounds), quads.map(quadBounds));
  // a line in another column is only marked when the drag reaches it
  assert.equal(textDragQuads(PAGE, [150, 700], [90, 661]).some((quad) => quadBounds(quad)[0] >= 400), false);
  const across = textDragQuads(PAGE, [150, 702], [450, 699]);
  assert.deepEqual(across.map(quadBounds), [[150, 697, 250, 709], [400, 697, 450, 709]], "two lines on one height: reading order decides");
});

test("a drag that barely moves marks the whole line; one that touches no text marks nothing", () => {
  assert.deepEqual(textDragQuads(PAGE, [100, 700], [100.4, 700]), [PAGE[0].quad]);
  assert.deepEqual(textDragQuads(PAGE, [300, 500], [350, 520]), []);
  assert.deepEqual(textDragQuads([], [0, 0], [10, 10]), []);
  assert.deepEqual(textDragQuads(null, [0, 0], [10, 10]), []);
  // lines without anything to read are left out
  assert.deepEqual(textDragQuads([line("  ", 50, 700, 200)], [60, 700], [100, 700]), []);
});

test("lines that read upwards (a page with /Rotate 90) are cut along their own direction; slanted lines are taken whole", () => {
  const up = [upward("Reads upwards in user space", 100, 60, 220)];
  const [quad] = textDragQuads(up, [98, 100], [101, 180]);
  assert.deepEqual(quadBounds(quad), [91, 100, 103, 180]);
  // corner order stays "as read": top-left, top-right, bottom-right, bottom-left
  assert.deepEqual(quad, [91, 100, 91, 180, 103, 180, 103, 100]);
  const slanted = [line("slanted", 50, 700, 200, { angle: 30 })];
  assert.deepEqual(textDragQuads(slanted, [60, 700], [120, 702]), [slanted[0].quad]);
});

test("the replacement of a line takes the nearest bundled family, the size, weight and slant of the line, and its colour", () => {
  assert.deepEqual(replacementStyle(line("a", 0, 0, 10)), { font: "arimo", size: 12, bold: false, italic: false, underline: false, align: "left", lineHeight: 1.2, opacity: 1 });
  assert.equal(replacementStyle(line("a", 0, 0, 10, { font: { serif: true, monospace: false, bold: true, italic: true } })).font, "tinos");
  const mono = replacementStyle(line("a", 0, 0, 10, { fontSize: 9.504, font: { serif: true, monospace: true, bold: false, italic: true } }), { text: "#1d4ed8", background: "#ffffff" });
  assert.equal(mono.font, "cousine", "monospace wins over serif");
  assert.equal(mono.size, 9.5, "sizes are kept at two decimals");
  assert.equal(mono.italic, true);
  assert.equal(mono.color, "#1d4ed8");
  assert.equal(replacementStyle(line("a", 0, 0, 10, { fontSize: 900 })).size, 400, "within the limits of the model");
  assert.equal(replacementStyle(line("a", 0, 0, 10, { fontSize: 1 })).size, 4);
  assert.equal(replacementStyle({ text: "a" }).size, 12, "a line without facts still gets a usable style");
});

test("the new baseline starts where the old one started, for upright and for turned boxes", () => {
  const first = { x: 0, baseline: 10.8 };
  for (const rot of [0, 90, 180, 270]) {
    for (const userUnit of [1, 2]) {
      const frame = { x: 7, y: 9, w: 120, h: 14.4, rot };
      const moved = frameOnBaseline(frame, [200, 300], first, userUnit);
      assert.equal(moved.w, 120);
      assert.equal(moved.h, 14.4);
      assert.equal(moved.rot, rot);
      closeAll(localToUser(moved, [first.x, first.baseline], userUnit), [200, 300], 1e-9, `rot ${rot}, user unit ${userUnit}`);
    }
  }
  // a centred first line starts inside the box
  const centred = frameOnBaseline({ x: 0, y: 0, w: 100, h: 20, rot: 0 }, [50, 50], { x: 25, baseline: 15 }, 1);
  closeAll([centred.x, centred.y], [75, 55], 1e-9);
});
