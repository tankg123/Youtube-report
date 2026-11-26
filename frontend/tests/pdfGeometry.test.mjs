import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFNumber, degrees } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  applyMatrix,
  frameBounds,
  frameCorners,
  frameFromScreen,
  frameFromUserRect,
  frameMatrixDown,
  frameMatrixUp,
  frameOnScreen,
  frameScreenRotation,
  frameToCssMatrix,
  invertMatrix,
  localToUser,
  multiplyMatrix,
  normalizeAngle,
  normalizeRightAngle,
  pointInFrame,
  resizeFrame,
  userRectToViewport,
  userToLocal,
  userToViewport,
  viewportDeltaToUser,
  viewportRectToUser,
  viewportToUser,
  viewportTransform,
  visibleSize
} from "../src/pages/pdfEditor/engine/geometry.js";

const close = (actual, expected, tolerance = 1e-6, label = "") => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);
};
const closeAll = (actual, expected, tolerance = 1e-6, label = "") => {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((value, index) => close(value, expected[index], tolerance, `${label}[${index}]`));
};

// Pages with every combination that changes the mapping: /Rotate, a CropBox, a shifted MediaBox, /UserUnit.
const VARIANTS = [
  { name: "plain", media: [0, 0, 300, 400] },
  { name: "cropbox", media: [0, 0, 300, 400], crop: [30, 50, 250, 380] },
  { name: "shifted mediabox", media: [-40, 100, 260, 520] },
  { name: "crop + shift + user unit 2", media: [20, -30, 320, 390], crop: [50, 10, 300, 350], userUnit: 2 }
];
const ROTATIONS = [0, 90, 180, 270];

async function buildSample() {
  const doc = await PDFDocument.create();
  const geometries = [];
  for (const variant of VARIANTS) {
    for (const rotate of ROTATIONS) {
      const page = doc.addPage([variant.media[2] - variant.media[0], variant.media[3] - variant.media[1]]);
      page.setMediaBox(variant.media[0], variant.media[1], variant.media[2] - variant.media[0], variant.media[3] - variant.media[1]);
      if (variant.crop) page.setCropBox(variant.crop[0], variant.crop[1], variant.crop[2] - variant.crop[0], variant.crop[3] - variant.crop[1]);
      if (variant.userUnit) page.node.set(PDFName.of("UserUnit"), PDFNumber.of(variant.userUnit));
      page.setRotation(degrees(rotate));
      geometries.push({ name: `${variant.name} /Rotate ${rotate}`, view: variant.crop || variant.media, rotate, userUnit: variant.userUnit || 1 });
    }
  }
  return { bytes: await doc.save(), geometries };
}

test("viewportTransform equals pdf.js PageViewport for every /Rotate, box and UserUnit combination", async () => {
  const { bytes, geometries } = await buildSample();
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 });
  const pdf = await task.promise;
  try {
    assert.equal(pdf.numPages, geometries.length);
    for (let index = 0; index < geometries.length; index += 1) {
      const geometry = geometries[index];
      const page = await pdf.getPage(index + 1);
      closeAll(page.view, geometry.view, 1e-9, `${geometry.name} view`);
      assert.equal(page.rotate, geometry.rotate, geometry.name);
      assert.equal(page.userUnit, geometry.userUnit, geometry.name);
      for (const extra of ROTATIONS) {
        for (const scale of [1, 1.5, 0.37]) {
          const theirs = page.getViewport({ scale, rotation: page.rotate + extra });
          const ours = viewportTransform(geometry, scale, extra);
          const label = `${geometry.name} extra ${extra} scale ${scale}`;
          closeAll(ours.transform, theirs.transform, 1e-9, `${label} transform`);
          close(ours.width, theirs.width, 1e-9, `${label} width`);
          close(ours.height, theirs.height, 1e-9, `${label} height`);
          const pixel = [12.5, 77.25];
          closeAll(viewportToUser(geometry, pixel, scale, extra), theirs.convertToPdfPoint(pixel[0], pixel[1]), 1e-9, `${label} to user`);
          const user = [geometry.view[0] + 10, geometry.view[1] + 20];
          closeAll(userToViewport(geometry, user, scale, extra), theirs.convertToViewportPoint(user[0], user[1]), 1e-9, `${label} to viewport`);
        }
      }
    }
  } finally {
    await task.destroy();
  }
});

test("angles and matrices: helpers behave like the PDF and CSS conventions", () => {
  assert.equal(normalizeRightAngle(-90), 270);
  assert.equal(normalizeRightAngle(450), 90);
  assert.equal(normalizeRightAngle(45), 0);
  assert.equal(normalizeAngle(-30), 330);
  const m = [2, 0.5, -1, 3, 10, -4];
  closeAll(multiplyMatrix(m, invertMatrix(m)), [1, 0, 0, 1, 0, 0], 1e-12);
  closeAll(applyMatrix(multiplyMatrix(m, [1, 0, 0, 1, 5, 7]), [1, 1]), applyMatrix(m, [6, 8]), 1e-12);
});

test("a frame that looks upright on screen has rot = page rotation, on every page orientation", () => {
  for (const variant of VARIANTS) {
    for (const rotate of ROTATIONS) {
      for (const extra of ROTATIONS) {
        const geometry = { view: variant.crop || variant.media, rotate, userUnit: variant.userUnit || 1 };
        const scale = 1.25;
        const box = { cx: 120, cy: 90, w: 80 * scale, h: 30 * scale, rotation: 0 };
        const frame = frameFromScreen(geometry, box, scale, extra);
        const label = `${variant.name} /Rotate ${rotate} extra ${extra}`;
        assert.equal(frame.rot, normalizeRightAngle(rotate + extra), label);
        close(frame.w, 80, 1e-9, label);
        close(frame.h, 30, 1e-9, label);
        assert.equal(frameScreenRotation(geometry, frame, extra), 0, label);

        // The four corners land where an upright 80 x 30 pt box around (120, 90) px must be.
        const corners = frameCorners(frame, geometry.userUnit).map((corner) => userToViewport(geometry, corner, scale, extra));
        closeAll(corners[0], [120 - 50, 90 - 18.75], 1e-6, `${label} top-left`);
        closeAll(corners[1], [120 + 50, 90 - 18.75], 1e-6, `${label} top-right`);
        closeAll(corners[2], [120 + 50, 90 + 18.75], 1e-6, `${label} bottom-right`);
        closeAll(corners[3], [120 - 50, 90 + 18.75], 1e-6, `${label} bottom-left`);

        // The CSS matrix maps the element's own box (w x h px, origin top-left) onto the same corners.
        const css = frameToCssMatrix(geometry, frame, scale, extra);
        closeAll(applyMatrix(css, [0, 0]), corners[0], 1e-6, `${label} css origin`);
        closeAll(applyMatrix(css, [frame.w, frame.h]), corners[2], 1e-6, `${label} css far corner`);
        closeAll([css[0], css[1], css[2], css[3]], [scale, 0, 0, scale], 1e-9, `${label} css is a pure zoom`);

        // Round trip.
        const seen = frameOnScreen(geometry, frame, scale, extra);
        closeAll([seen.cx, seen.cy, seen.w, seen.h, seen.rotation], [box.cx, box.cy, box.w, box.h, 0], 1e-6, `${label} round trip`);

        // Turning the PAGE turns the object with it: the stored frame does not change, its screen rotation does.
        assert.equal(frameScreenRotation(geometry, frame, extra + 90), 90, label);
      }
    }
  }
});

test("rotated frames: local space, PDF writer matrix and hit test agree", () => {
  const geometry = { view: [0, 0, 600, 800], rotate: 90, userUnit: 1 };
  const frame = frameFromScreen(geometry, { cx: 300, cy: 200, w: 100, h: 40, rotation: 30 }, 1, 0);
  close(frame.rot, 60, 1e-9);
  assert.equal(frameScreenRotation(geometry, frame, 0), 30);

  // local (0, 0) is the top-left corner, (w, h) the bottom-right one
  const corners = frameCorners(frame);
  closeAll(localToUser(frame, [0, 0]), corners[0], 1e-9);
  closeAll(localToUser(frame, [frame.w, frame.h]), corners[2], 1e-9);
  closeAll(userToLocal(frame, corners[1]), [frame.w, 0], 1e-9);
  // the writer's matrix starts at the bottom-left corner with y up
  const up = frameMatrixUp(frame);
  closeAll(applyMatrix(up, [0, 0]), corners[3], 1e-9);
  closeAll(applyMatrix(up, [frame.w, frame.h]), corners[1], 1e-9);
  closeAll(applyMatrix(up, [10, frame.h - 5]), applyMatrix(frameMatrixDown(frame), [10, 5]), 1e-9);
  // both matrices are rotations (no mirror): determinant +1 for "up", -1 for "down"
  close(up[0] * up[3] - up[1] * up[2], 1, 1e-9);
  const down = frameMatrixDown(frame);
  close(down[0] * down[3] - down[1] * down[2], -1, 1e-9);

  assert.equal(pointInFrame(frame, [frame.x, frame.y]), true);
  assert.equal(pointInFrame(frame, localToUser(frame, [-1, 5])), false);
  assert.equal(pointInFrame(frame, localToUser(frame, [-1, 5]), 1, 2), true);
  const bounds = frameBounds(frame);
  assert.ok(bounds[0] < frame.x && bounds[2] > frame.x && bounds[1] < frame.y && bounds[3] > frame.y);
});

test("UserUnit: sizes stay in points while positions are in user units", () => {
  const geometry = { view: [0, 0, 300, 400], rotate: 0, userUnit: 2 };
  // the page is 600 x 800 pt for the reader
  closeAll(visibleSize(geometry), [600, 800], 1e-9);
  const frame = frameFromScreen(geometry, { cx: 300, cy: 400, w: 144, h: 72, rotation: 0 }, 1, 0);
  closeAll([frame.x, frame.y, frame.w, frame.h], [150, 200, 144, 72], 1e-9);
  const bounds = frameBounds(frame, geometry.userUnit);
  closeAll(bounds, [150 - 36, 200 - 18, 150 + 36, 200 + 18], 1e-9);
  const css = frameToCssMatrix(geometry, frame, 1.5, 0);
  closeAll([css[0], css[3]], [1.5, 1.5], 1e-9);
});

test("resizeFrame keeps the anchored point in place, also on rotated frames", () => {
  const frame = { x: 200, y: 300, w: 100, h: 40, rot: 35 };
  const topLeft = frameCorners(frame)[0];
  const grown = resizeFrame(frame, 160, 90, [0, 0]);
  closeAll(frameCorners(grown)[0], topLeft, 1e-9);
  assert.equal(grown.w, 160);
  assert.equal(grown.h, 90);
  const topCentre = localToUser(frame, [50, 0]);
  const centred = resizeFrame(frame, 30, 70, [0.5, 0]);
  closeAll(localToUser(centred, [15, 0]), topCentre, 1e-9);
  const bottomRight = frameCorners(frame)[2];
  closeAll(frameCorners(resizeFrame(frame, 10, 10, [1, 1]))[2], bottomRight, 1e-9);
});

test("rectangles and drags convert between the screen and user space", () => {
  for (const rotate of ROTATIONS) {
    const geometry = { view: [10, 20, 310, 420], rotate, userUnit: 1 };
    const scale = 2;
    const rect = [50, 60, 120, 90];
    const onScreen = userRectToViewport(geometry, rect, scale, 0);
    assert.ok(onScreen[0] < onScreen[2] && onScreen[1] < onScreen[3]);
    closeAll(viewportRectToUser(geometry, onScreen, scale, 0), rect, 1e-9, `/Rotate ${rotate}`);

    const frame = frameFromUserRect(geometry, rect, 0);
    closeAll(frameBounds(frame), rect, 1e-9, `/Rotate ${rotate} frame bounds`);
    assert.equal(frameScreenRotation(geometry, frame, 0), 0);

    // a drag of 10 px to the right moves the frame 10 px to the right on screen
    const [dx, dy] = viewportDeltaToUser(geometry, [10, 0], scale, 0);
    const before = userToViewport(geometry, [frame.x, frame.y], scale, 0);
    const after = userToViewport(geometry, [frame.x + dx, frame.y + dy], scale, 0);
    closeAll([after[0] - before[0], after[1] - before[1]], [10, 0], 1e-9, `/Rotate ${rotate} drag`);
  }
});
