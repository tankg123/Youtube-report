// Geometry of the page overlay (src/pages/pdfEditor/overlay/geometry.js): pointer pixels <-> user space around
// every rotation of a page, where the outline and the handles of a selected object stand on screen, the matrix
// of a line's local frame, a line as numbers (length, angle).
import test from "node:test";
import assert from "node:assert/strict";
import { applyMatrix, frameFromScreen, viewportTransform } from "../src/pages/pdfEditor/engine/geometry.js";
import { pageGeometry } from "../src/pages/pdfEditor/model/schema.js";
import { objectScreenBox } from "../src/pages/pdfEditor/model/shapes.js";
import {
  HANDLE_SIZE,
  HIT_TOLERANCE_PX,
  ROTATE_OFFSET,
  boxOfPolygons,
  hitTolerance,
  lineCssMatrix,
  lineEndFor,
  lineOnScreen,
  objectPixelBox,
  outlineOf,
  pixelsToUser,
  polygonPath,
  quadToPixels,
  selectionLayout,
  selectionPixelBox,
  uprightFrameOf,
  userRectToPixels,
  userToPixels
} from "../src/pages/pdfEditor/overlay/geometry.js";
import { EXTRA_ROTATIONS, PAGE_VARIANTS, close, closeAll, makePage, sample } from "./helpers/pdfModelKit.mjs";

const SCALES = [0.5, 1, 4 / 3, 2.5];
/** Every page geometry of the kit with every rotation a user can add. */
const everyPage = () => PAGE_VARIANTS.flatMap((variant) => EXTRA_ROTATIONS.map((rotation) => ({ label: `${variant.name} + ${rotation}`, page: makePage(variant, rotation) })));
/** A frame that looks upright on the page: left / top / width / height in points as seen. */
const uprightFrame = (page, left, top, width, height, rotation = 0) => frameFromScreen(pageGeometry(page), { cx: left + width / 2, cy: top + height / 2, w: width, h: height, rotation }, 1, page.rotation);

test("pixels and user space convert into each other on every page geometry, rotation and zoom", () => {
  for (const { label, page } of everyPage()) {
    for (const scale of SCALES) {
      const viewport = viewportTransform(pageGeometry(page), scale, page.rotation);
      for (const pixel of [[0, 0], [viewport.width, viewport.height], [37.5, 411.25]]) {
        const user = pixelsToUser(page, pixel, scale);
        closeAll(userToPixels(page, user, scale), pixel, 1e-7, `${label} @${scale} round trip`);
        // the same point the pdf.js viewport formula gives
        closeAll(applyMatrix(viewport.transform, user), pixel, 1e-7, `${label} @${scale} viewport`);
      }
      // the corners of the visible page are the corners of its element
      const [x0, y0, x1, y1] = page.view;
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((corner) => userToPixels(page, corner, scale));
      close(Math.min(...corners.map((corner) => corner[0])), 0, 1e-7, `${label} left`);
      close(Math.max(...corners.map((corner) => corner[0])), viewport.width, 1e-7, `${label} right`);
      close(Math.max(...corners.map((corner) => corner[1])), viewport.height, 1e-7, `${label} bottom`);
    }
  }
  // both spellings of a point
  const page = makePage(PAGE_VARIANTS[1], 90);
  assert.deepEqual(pixelsToUser(page, { x: 10, y: 20 }, 2), pixelsToUser(page, [10, 20], 2));
});

test("a user-space rectangle becomes its box on screen: left < right and top < bottom whatever the page is turned by", () => {
  for (const { label, page } of everyPage()) {
    const [x0, y0] = page.view;
    const rect = [x0 + 30, y0 + 40, x0 + 130, y0 + 64];
    const k = page.userUnit;
    const [left, top, right, bottom] = userRectToPixels(page, rect, 2);
    assert.ok(left < right && top < bottom, label);
    const turned = (page.baseRotation + page.rotation) % 180 !== 0;
    close(right - left, (turned ? 24 : 100) * k * 2, 1e-7, `${label} width`);
    close(bottom - top, (turned ? 100 : 24) * k * 2, 1e-7, `${label} height`);
    // an unsorted rectangle gives the same box
    closeAll(userRectToPixels(page, [rect[2], rect[3], rect[0], rect[1]], 2), [left, top, right, bottom], 1e-9, label);
    // and it is what the model calls the screen box of a mark, times the zoom
    closeAll(objectPixelBox({ type: "redact", rect }, page, 2), objectScreenBox({ type: "redact", rect }, page).map((value) => value * 2), 1e-7, label);
  }
});

test("hit tolerance is a fixed number of pixels at every zoom", () => {
  close(hitTolerance(1), HIT_TOLERANCE_PX);
  close(hitTolerance(2) * 2, HIT_TOLERANCE_PX);
  close(hitTolerance(0.25) * 0.25, HIT_TOLERANCE_PX);
  assert.ok(Number.isFinite(hitTolerance(0)));
});

test("the local frame of a line: its origin is p1, its x axis ends in p2, one unit is one point", () => {
  for (const { label, page } of everyPage()) {
    const [x0, y0] = page.view;
    const line = { type: "line", p1: [x0 + 40, y0 + 60], p2: [x0 + 100, y0 + 140] };
    for (const scale of [1, 1.5]) {
      const { matrix, length } = lineCssMatrix(page, line, scale);
      close(length, Math.hypot(60, 80) * page.userUnit, 1e-7, `${label} length in points`);
      closeAll(applyMatrix(matrix, [0, 0]), userToPixels(page, line.p1, scale), 1e-6, `${label} start`);
      closeAll(applyMatrix(matrix, [length, 0]), userToPixels(page, line.p2, scale), 1e-6, `${label} end`);
      // one point across the line is `scale` pixels on screen
      const across = applyMatrix(matrix, [0, 1]);
      const start = applyMatrix(matrix, [0, 0]);
      close(Math.hypot(across[0] - start[0], across[1] - start[1]), scale, 1e-7, `${label} unit`);
    }
  }
  const dot = lineCssMatrix(makePage(), { p1: [10, 10], p2: [10, 10] }, 1);
  assert.equal(dot.length, 0);
  assert.ok(dot.matrix.every(Number.isFinite), "a line without length still has a matrix");
});

test("the selection frame of an upright box: outline, eight handles with their cursors, the rotation handle above the top edge", () => {
  for (const { label, page } of everyPage()) {
    const scale = 2;
    const object = { ...sample.rect(page.id), frame: uprightFrame(page, 100, 50, 80, 40) };
    const layout = selectionLayout(object, page, scale);
    closeAll(layout.box, [200, 100, 360, 180], 1e-6, `${label} box`);
    assert.equal(layout.polygons.length, 1);
    const handles = Object.fromEntries(layout.handles.map((handle) => [handle.id, handle]));
    assert.deepEqual(Object.keys(handles).sort(), ["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
    closeAll([handles.nw.x, handles.nw.y], [200, 100], 1e-6, `${label} nw`);
    closeAll([handles.se.x, handles.se.y], [360, 180], 1e-6, `${label} se`);
    closeAll([handles.n.x, handles.n.y], [280, 100], 1e-6, `${label} n`);
    closeAll([handles.w.x, handles.w.y], [200, 140], 1e-6, `${label} w`);
    assert.equal(handles.nw.cursor, "nwse-resize", label);
    assert.equal(handles.ne.cursor, "nesw-resize", label);
    assert.equal(handles.n.cursor, "ns-resize", label);
    assert.equal(handles.e.cursor, "ew-resize", label);
    closeAll([layout.rotate.anchorX, layout.rotate.anchorY], [280, 100], 1e-6, `${label} anchor`);
    closeAll([layout.rotate.x, layout.rotate.y], [280, 100 - ROTATE_OFFSET], 1e-6, `${label} rotation handle`);
  }
  assert.ok(HANDLE_SIZE > 0);
});

test("a turned box: the handles turn with it and the cursors follow the way a handle moves on screen", () => {
  const page = makePage(PAGE_VARIANTS[1], 0); // /Rotate 90
  const object = { ...sample.rect(page.id), frame: uprightFrame(page, 100, 100, 80, 40, 90) }; // a quarter turn clockwise as seen
  const layout = selectionLayout(object, page, 1);
  const handles = Object.fromEntries(layout.handles.map((handle) => [handle.id, handle]));
  // the box's own top edge now faces right: its middle is the rightmost point of the outline
  closeAll([handles.n.x, handles.n.y], [160, 120], 1e-6, "n");
  assert.equal(handles.n.cursor, "ew-resize");
  assert.equal(handles.e.cursor, "ns-resize");
  assert.equal(handles.nw.cursor, "nesw-resize");
  closeAll([layout.rotate.x, layout.rotate.y], [160 + ROTATE_OFFSET, 120], 1e-6, "the rotation handle stands outside the top edge of the box");
  closeAll(layout.box, [120, 80, 160, 160], 1e-6, "box around the turned outline");
});

test("which handles each kind of object has", () => {
  const page = makePage(PAGE_VARIANTS[3], 180);
  const [x0, y0] = page.view;
  const ids = (object) => selectionLayout(object, page, 1.5).handles.map((handle) => handle.id);
  assert.deepEqual(ids({ ...sample.text(page.id), frame: uprightFrame(page, 20, 20, 60, 15) }), ["w", "e"], "a text box sets its width only");
  assert.deepEqual(ids({ ...sample.image(page.id, "a1"), frame: uprightFrame(page, 20, 20, 60, 15) }), ["nw", "ne", "se", "sw"], "a picture has its corners");
  const line = { ...sample.line(page.id), p1: [x0 + 10, y0 + 10], p2: [x0 + 60, y0 + 40] };
  const lineLayout = selectionLayout(line, page, 1.5);
  assert.deepEqual(lineLayout.handles.map((handle) => [handle.id, handle.cursor]), [["p1", "move"], ["p2", "move"]]);
  assert.equal(lineLayout.rotate, null);
  assert.equal(lineLayout.polygons[0].length, 2, "the outline of a line is its segment");
  closeAll([lineLayout.handles[0].x, lineLayout.handles[0].y], userToPixels(page, line.p1, 1.5), 1e-9);
  const mark = { ...sample.redact(page.id), rect: [x0 + 10, y0 + 10, x0 + 90, y0 + 30] };
  const markLayout = selectionLayout(mark, page, 1.5);
  assert.equal(markLayout.handles.length, 8);
  assert.equal(markLayout.rotate, null, "a mark never rotates");
  const markHandles = Object.fromEntries(markLayout.handles.map((handle) => [handle.id, handle]));
  // the handles of a mark are named as the reader sees them, whatever the page is turned by
  closeAll([markHandles.nw.x, markHandles.nw.y], [markLayout.box[0], markLayout.box[1]], 1e-6, "nw is the top-left corner on screen");
  assert.equal(markHandles.nw.cursor, "nwse-resize");
  const highlight = { ...sample.highlightText(page.id), quads: [[x0 + 10, y0 + 30, x0 + 90, y0 + 30, x0 + 90, y0 + 20, x0 + 10, y0 + 20], [x0 + 10, y0 + 18, x0 + 50, y0 + 18, x0 + 50, y0 + 8, x0 + 10, y0 + 8]] };
  const highlightLayout = selectionLayout(highlight, page, 1.5);
  assert.deepEqual(highlightLayout.handles, [], "marked text has no handles");
  assert.equal(highlightLayout.polygons.length, 2, "one outline per line box");
  assert.deepEqual(selectionLayout({ type: "nothing" }, page, 1), { polygons: [], handles: [], rotate: null, box: null });
});

test("outlines, boxes and quads in pixels", () => {
  const page = makePage(PAGE_VARIANTS[0], 0); // 600 x 800, not rotated: y flips
  const quad = [100, 700, 300, 700, 300, 680, 100, 680];
  assert.deepEqual(quadToPixels(page, quad, 1), [[100, 100], [300, 100], [300, 120], [100, 120]]);
  assert.deepEqual(boxOfPolygons([[[5, 9], [1, 2]], [[7, 3]]]), [1, 2, 7, 9]);
  assert.equal(boxOfPolygons([]), null);
  const rect = { ...sample.rect(page.id), frame: uprightFrame(page, 10, 10, 30, 20) };
  const ellipse = { ...sample.ellipse(page.id), frame: uprightFrame(page, 100, 50, 30, 20) };
  closeAll(selectionPixelBox([rect, ellipse], page, 2), [20, 20, 260, 140], 1e-6);
  assert.equal(selectionPixelBox([], page, 2), null);
  assert.deepEqual(outlineOf(rect, page, 1)[0].map((corner) => corner.map(Math.round)), [[10, 10], [40, 10], [40, 30], [10, 30]]);
  assert.equal(polygonPath([[0, 0], [10.004, 0], [10, 5.5]]), "M0 0 L10 0 L10 5.5 Z");
  assert.equal(polygonPath([[1, 2], [3, 4]], false), "M1 2 L3 4");
  assert.equal(polygonPath([]), "");
});

test("the upright frame of a mark has the width and height the reader sees", () => {
  for (const { label, page } of everyPage()) {
    const [x0, y0] = page.view;
    const mark = { type: "blur", rect: [x0 + 20, y0 + 30, x0 + 120, y0 + 60] };
    const frame = uprightFrameOf(mark, page);
    const [left, top, right, bottom] = userRectToPixels(page, mark.rect, 1);
    close(frame.w, right - left, 1e-7, `${label} width`);
    close(frame.h, bottom - top, 1e-7, `${label} height`);
  }
  const framed = sample.rect("p");
  assert.equal(uprightFrameOf(framed, makePage()), framed.frame);
  assert.equal(uprightFrameOf(sample.line("p"), makePage()), null);
});

test("a line as numbers: length and angle on screen, and back to its end point", () => {
  for (const { label, page } of everyPage()) {
    const start = pixelsToUser(page, [50, 60], 1);
    const end = pixelsToUser(page, [50 + 30, 60 + 40], 1);
    const line = { type: "line", p1: start, p2: end };
    const seen = lineOnScreen(line, page);
    close(seen.length, 50, 1e-7, `${label} length`);
    close(seen.angle, (Math.atan2(40, 30) * 180) / Math.PI, 1e-7, `${label} angle (clockwise from pointing right)`);
    // the same numbers give the same end
    closeAll(lineEndFor(line, page, seen), end, 1e-7, `${label} same line`);
    // twice as long, same direction
    closeAll(userToPixels(page, lineEndFor(line, page, { length: 100 }), 1), [110, 140], 1e-7, `${label} longer`);
    // pointing straight down on screen
    closeAll(userToPixels(page, lineEndFor(line, page, { angle: 90 }), 1), [50, 110], 1e-7, `${label} turned`);
    // pointing left
    closeAll(userToPixels(page, lineEndFor(line, page, { angle: 180, length: 20 }), 1), [30, 60], 1e-7, `${label} left`);
  }
});
