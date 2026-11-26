// Pixel work for signature pictures (signing/imageOps.js) on plain RGBA arrays: white-background removal,
// trimming to the ink, fitting, and the smooth path of a drawn stroke.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_THRESHOLD, INK_ALPHA, STROKE_MIN_DISTANCE, addStrokePoint, brightness, fitWithin, inkBounds, removeWhiteBackground, strokePath, strokesBounds, trimToInk
} from "../src/pages/pdfEditor/signing/imageOps.js";

/** A width x height picture filled with one colour; set(x, y, rgba) changes a pixel. */
function picture(width, height, fill = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(fill, offset);
  return {
    data,
    width,
    height,
    set(x, y, rgba) {
      data.set(rgba, (y * width + x) * 4);
      return this;
    },
    rect(x0, y0, x1, y1, rgba) {
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) this.set(x, y, rgba);
      return this;
    }
  };
}
const pixel = (data, width, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test("image: white paper becomes transparent, ink stays opaque in its own colour", () => {
  const scan = picture(6, 4).set(1, 1, [20, 30, 160, 255]).set(4, 2, [0, 0, 0, 255]).set(2, 2, [250, 250, 250, 255]);
  const out = removeWhiteBackground(scan.data, 6, 4);
  assert.equal(out.length, scan.data.length);
  assert.notEqual(out, scan.data, "a new array");
  assert.deepEqual(pixel(out, 6, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(out, 6, 2, 2), [0, 0, 0, 0], "almost white is paper");
  assert.deepEqual(pixel(out, 6, 4, 2), [0, 0, 0, 255]);
  assert.deepEqual(pixel(out, 6, 1, 1), [20, 30, 160, 255]);
  // the input is untouched
  assert.deepEqual(pixel(scan.data, 6, 0, 0), [255, 255, 255, 255]);
});

test("image: an anti-aliased edge fades out without a grey halo, and the threshold decides what is paper", () => {
  // black ink blended half over white = mid grey
  const edge = picture(3, 1).set(0, 0, [0, 0, 0, 255]).set(1, 0, [200, 200, 200, 255]).set(2, 0, [255, 255, 255, 255]);
  const out = removeWhiteBackground(edge.data, 3, 1, { threshold: 0.9, softness: 0.3 });
  const [r, g, b, a] = pixel(out, 3, 1, 0);
  assert.ok(a > 0 && a < 255, `half transparent: ${a}`);
  assert.ok(r < 200 && r === g && g === b, `darker than the scanned pixel, which was ink mixed with paper: ${[r, g, b]}`);
  // on white paper the edge looks exactly as it was scanned (no halo, no change of weight)
  const onWhite = Math.round((r * a + 255 * (255 - a)) / 255);
  assert.ok(Math.abs(onWhite - 200) <= 2, `over white it is the scanned grey again: ${onWhite}`);
  // on a coloured page it is darker than the scanned pixel would have been: no white fringe
  const onBlue = Math.round((r * a + 60 * (255 - a)) / 255);
  assert.ok(onBlue < 150, `no light fringe on a dark page: ${onBlue}`);
  // what is paper at a low threshold is ink at a high one
  const grey = picture(1, 1, [180, 180, 180, 255]);
  assert.equal(pixel(removeWhiteBackground(grey.data, 1, 1, { threshold: 0.6 }), 1, 0, 0)[3], 0);
  assert.ok(pixel(removeWhiteBackground(grey.data, 1, 1, { threshold: 0.98 }), 1, 0, 0)[3] > 200);
  // a coloured (blue) pen on off-white, slightly yellow paper
  const blue = picture(2, 1, [252, 250, 240, 255]).set(0, 0, [30, 60, 200, 255]);
  const cleaned = removeWhiteBackground(blue.data, 2, 1);
  assert.equal(pixel(cleaned, 2, 1, 0)[3], 0);
  const ink = pixel(cleaned, 2, 0, 0);
  assert.ok(ink[3] === 255 && ink[2] > ink[0] && ink[2] > ink[1], `still blue: ${ink}`);
  // pixels that were transparent stay transparent
  assert.equal(pixel(removeWhiteBackground(picture(1, 1, [0, 0, 0, 0]).data, 1, 1), 1, 0, 0)[3], 0);
  assert.ok(BACKGROUND_THRESHOLD.min < BACKGROUND_THRESHOLD.default && BACKGROUND_THRESHOLD.default < BACKGROUND_THRESHOLD.max);
  assert.ok(Math.abs(brightness(255, 255, 255) - 1) < 1e-9 && brightness(0, 0, 0) === 0);
});

test("image: the ink box, and a picture cut down to it", () => {
  const drawn = picture(10, 8, [0, 0, 0, 0]).rect(3, 2, 6, 4, [0, 0, 0, 255]).set(8, 6, [0, 0, 0, INK_ALPHA - 1]);
  assert.deepEqual(inkBounds(drawn.data, 10, 8), { x: 3, y: 2, width: 4, height: 3 }, "a pixel below the alpha limit is not ink");
  assert.deepEqual(inkBounds(drawn.data, 10, 8, { alpha: 1 }), { x: 3, y: 2, width: 6, height: 5 });
  assert.equal(inkBounds(picture(4, 4, [0, 0, 0, 0]).data, 4, 4), null);

  const trimmed = trimToInk(drawn.data, 10, 8);
  assert.deepEqual([trimmed.width, trimmed.height, trimmed.x, trimmed.y], [4, 3, 3, 2]);
  assert.equal(trimmed.data.length, 4 * 3 * 4);
  assert.ok(trimmed.data.every((value, index) => (index % 4 === 3 ? value === 255 : value === 0)), "only ink is left");
  // padding stays inside the picture
  const padded = trimToInk(drawn.data, 10, 8, { padding: 2 });
  assert.deepEqual([padded.width, padded.height, padded.x, padded.y], [8, 7, 1, 0]);
  assert.deepEqual(pixel(padded.data, padded.width, 2, 2), [0, 0, 0, 255]);
  assert.deepEqual(pixel(padded.data, padded.width, 0, 0), [0, 0, 0, 0]);
  assert.equal(trimToInk(picture(4, 4, [0, 0, 0, 0]).data, 4, 4), null);
  // a photographed signature: background removed, then trimmed
  const photo = picture(12, 6).rect(5, 2, 9, 3, [10, 10, 10, 255]);
  const cut = trimToInk(removeWhiteBackground(photo.data, 12, 6), 12, 6);
  assert.deepEqual([cut.width, cut.height, cut.x, cut.y], [5, 2, 5, 2]);
  // plain arrays work as well as typed ones
  assert.deepEqual(trimToInk([...drawn.data], 10, 8).width, 4);
});

test("image: fitting into a box never enlarges", () => {
  assert.deepEqual(fitWithin(2400, 600, 1200, 600), { width: 1200, height: 300, scale: 0.5 });
  assert.deepEqual(fitWithin(300, 900, 1200, 600), { width: 200, height: 600, scale: 600 / 900 });
  assert.deepEqual(fitWithin(100, 50, 1200, 600), { width: 100, height: 50, scale: 1 });
  assert.deepEqual(fitWithin(1, 5000, 100, 100), { width: 1, height: 100, scale: 0.02 });
});

test("image: strokes: samples that do not move are dropped, the path is smooth, a tap is a dot", () => {
  const points = [];
  addStrokePoint(points, { x: 10, y: 10 });
  addStrokePoint(points, { x: 10.5, y: 10.2 });
  addStrokePoint(points, { x: 10 + STROKE_MIN_DISTANCE, y: 10 });
  addStrokePoint(points, { x: 20, y: 18 });
  assert.deepEqual(points, [{ x: 10, y: 10 }, { x: 10 + STROKE_MIN_DISTANCE, y: 10 }, { x: 20, y: 18 }]);

  assert.deepEqual(strokePath([]), []);
  assert.deepEqual(strokePath([{ x: 5, y: 6 }]), [["M", 5, 6], ["L", 5, 6]]);
  assert.deepEqual(strokePath([{ x: 0, y: 0 }, { x: 4, y: 4 }]), [["M", 0, 0], ["L", 4, 4]]);
  const path = strokePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }]);
  assert.deepEqual(path, [["M", 0, 0], ["Q", 10, 0, 10, 5], ["Q", 10, 10, 15, 10], ["L", 20, 10]]);
  // every sample is a control point: the curve passes the midpoints, never a corner at a sample
  assert.equal(path.filter(([command]) => command === "Q").length, 2);

  assert.equal(strokesBounds([]), null);
  assert.deepEqual(strokesBounds([{ points: [{ x: 10, y: 20 }, { x: 30, y: 25 }] }, { points: [{ x: 5, y: 40 }] }], 4), { x: 3, y: 18, width: 29, height: 24 });
});
