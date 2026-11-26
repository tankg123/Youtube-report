// Canvas arithmetic of the PDF viewer: the HiDPI sizing of pdf.js, the canvas caps (checked against pdf.js' own
// OutputScale), which page bitmaps are released, and the size of thumbnails.
import test from "node:test";
import assert from "node:assert/strict";
import { pdfjs } from "./helpers/pdfTestKit.mjs";
import {
  approximateFraction,
  canvasLimitsFor,
  computeCanvasSize,
  floorToDivide,
  limitOutputScale,
  pickEvictions,
  scaleRoundFor,
  thumbnailSize
} from "../src/pages/pdfEditor/viewer/canvasSizing.js";

const A4 = { width: 595.28 * (96 / 72), height: 841.89 * (96 / 72) }; // the page at 100 %, in CSS pixels

test("approximateFraction: exact for the usual pixel ratios, denominators up to 8", () => {
  assert.deepEqual(approximateFraction(1), [1, 1]);
  assert.deepEqual(approximateFraction(2), [2, 1]);
  assert.deepEqual(approximateFraction(1.25), [5, 4]);
  assert.deepEqual(approximateFraction(1.5), [3, 2]);
  assert.deepEqual(approximateFraction(1.75), [7, 4]);
  assert.deepEqual(approximateFraction(0.5), [1, 2]);
  assert.deepEqual(approximateFraction(0.01), [1, 8]);
  for (const value of [1.1, 1.333, 2.625, 0.9, 3.3, 0.37]) {
    const [numerator, denominator] = approximateFraction(value);
    assert.ok(Number.isInteger(numerator) && Number.isInteger(denominator));
    assert.ok(Math.min(numerator, denominator) <= 8, `${value}: ${numerator}/${denominator}`);
    assert.ok(Math.abs(numerator / denominator - value) / value < 0.08, `${value} is not ${numerator}/${denominator}`);
  }
  assert.equal(scaleRoundFor(1.25), 4);
  assert.equal(scaleRoundFor(2), 1);
  assert.equal(floorToDivide(793.7, 4), 792);
  assert.equal(floorToDivide(10, 5), 10);
});

test("an unrestricted canvas has exactly ratio x page pixels, and its pixels fall on device pixels", () => {
  for (const pixelRatio of [1, 1.25, 1.5, 2, 3]) {
    const size = computeCanvasSize({ ...A4, pixelRatio });
    assert.equal(size.restricted, false);
    // canvas pixels per CSS pixel of the page box = the device pixel ratio, exactly
    assert.equal(size.sx, pixelRatio, `sx at ${pixelRatio}`);
    assert.equal(size.sy, pixelRatio, `sy at ${pixelRatio}`);
    assert.equal(size.canvasWidth, size.pageWidth * pixelRatio);
    assert.equal(size.canvasHeight, size.pageHeight * pixelRatio);
    // the page box is the viewport floored to the rounding step
    assert.ok(size.pageWidth <= A4.width && A4.width - size.pageWidth < size.roundX);
    assert.ok(size.pageHeight <= A4.height && A4.height - size.pageHeight < size.roundY);
    assert.equal(size.pageWidth % size.roundX, 0);
    assert.equal(size.roundX, approximateFraction(pixelRatio)[1]);
    assert.deepEqual(size.transform, pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0]);
  }
});

test("canvas caps: total pixels, one side, and the screen area", () => {
  const limits = canvasLimitsFor({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0 Safari/537.36" });
  assert.equal(limits.mobile, false);
  assert.equal(limits.maxCanvasPixels, 2 ** 25);
  assert.equal(limits.renderedBytes, 192 * 2 ** 20);
  const phone = canvasLimitsFor({ userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/157.0.0.0 Mobile Safari/537.36" });
  assert.equal(phone.mobile, true);
  assert.equal(phone.maxCanvasPixels, 5242880);
  assert.equal(phone.renderedBytes, 64 * 2 ** 20);
  assert.equal(canvasLimitsFor({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 }).mobile, true);
  assert.equal(canvasLimitsFor({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 0 }).mobile, false);

  // 800 % on a 2x display: far more than the 2^25 pixel cap allows
  const zoomed = computeCanvasSize({ width: A4.width * 8, height: A4.height * 8, pixelRatio: 2, limits: { maxCanvasPixels: 2 ** 25, maxCanvasDim: 32767, capCanvasAreaFactor: -1 } });
  assert.equal(zoomed.restricted, true);
  assert.ok(zoomed.canvasWidth * zoomed.canvasHeight <= 2 ** 25);
  assert.ok(zoomed.canvasWidth * zoomed.canvasHeight > 2 ** 25 * 0.9, "the budget is used");
  assert.ok(zoomed.sx < 2);

  // the screen-area cap of a 1920 x 1080 screen at ratio 1: at most three screens of pixels
  const screenArea = 1920 * 1080;
  const capped = computeCanvasSize({ width: A4.width * 4, height: A4.height * 4, pixelRatio: 1, limits, screenArea });
  assert.equal(capped.restricted, true);
  assert.ok(capped.canvasWidth * capped.canvasHeight <= screenArea * 3);
  const fine = computeCanvasSize({ width: A4.width * 2, height: A4.height * 2, pixelRatio: 1, limits, screenArea });
  assert.equal(fine.restricted, false);

  // one side
  const strip = computeCanvasSize({ width: 100, height: 100000, pixelRatio: 1, limits: { maxCanvasPixels: -1, maxCanvasDim: 32767, capCanvasAreaFactor: -1 } });
  assert.equal(strip.restricted, true);
  assert.ok(strip.canvasHeight <= 32767);

  // degenerate sizes never give an empty canvas
  const tiny = computeCanvasSize({ width: 0.2, height: 0.2, pixelRatio: 1 });
  assert.ok(tiny.canvasWidth >= 1 && tiny.canvasHeight >= 1 && tiny.pageWidth >= 1);
});

test("limitOutputScale equals pdf.js OutputScale.limitCanvas", () => {
  const saved = { window: globalThis.window, ratio: globalThis.devicePixelRatio };
  try {
    for (const pixelRatio of [1, 1.25, 1.5, 2, 3]) {
      for (const screen of [[1920, 1040], [1400, 860], [390, 760]]) {
        // what OutputScale reads from the browser
        globalThis.devicePixelRatio = pixelRatio;
        globalThis.window = { screen: { availWidth: screen[0], availHeight: screen[1] } };
        for (const zoom of [0.5, 1, 1.5, 3, 8]) {
          for (const [maxPixels, maxDimension, capAreaFactor] of [[2 ** 25, 32767, 200], [5242880, 32767, 200], [2 ** 25, 32767, -1], [-1, -1, -1], [-1, 4096, -1]]) {
            const width = A4.width * zoom;
            const height = A4.height * zoom;
            const reference = new pdfjs.OutputScale();
            const restricted = reference.limitCanvas(width, height, maxPixels, maxDimension, capAreaFactor);
            const own = limitOutputScale({ width, height, pixelRatio, maxPixels, maxDimension, capAreaFactor, screenArea: screen[0] * screen[1] });
            const label = `ratio ${pixelRatio}, screen ${screen}, zoom ${zoom}, caps ${maxPixels}/${maxDimension}/${capAreaFactor}`;
            assert.equal(own.restricted, restricted, label);
            assert.equal(own.sx, reference.sx, label);
            assert.equal(own.sy, reference.sy, label);
          }
        }
      }
    }
  } finally {
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
    if (saved.ratio === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = saved.ratio;
  }
});

test("single precision mirrors the browser's calc(): the page box is what CSS round() yields", () => {
  // pdf.js' own probe value: 1.6666666666666665 * 792 is 1319.9999999999998 in doubles and 1320 in floats
  const single = computeCanvasSize({ width: 1.6666666666666665 * 792, height: 100, pixelRatio: 1, singlePrecision: true });
  const double = computeCanvasSize({ width: 1.6666666666666665 * 792, height: 100, pixelRatio: 1, singlePrecision: false });
  assert.equal(single.pageWidth, 1320);
  assert.equal(double.pageWidth, 1319);
});

test("release: page count and bytes both bound what stays drawn; pages on screen are never released", () => {
  const megabyte = 2 ** 20;
  const drawn = (count, bytes, keep = []) => Array.from({ length: count }, (_, index) => ({ id: `p${index}`, bytes, keep: keep.includes(index) }));
  // under both budgets: nothing goes
  assert.deepEqual(pickEvictions(drawn(8, 4 * megabyte), { maxPages: 10, maxBytes: 192 * megabyte }), []);
  // too many pages: the least recently shown go first
  assert.deepEqual(pickEvictions(drawn(13, 4 * megabyte), { maxPages: 10, maxBytes: 192 * megabyte }), ["p0", "p1", "p2"]);
  // few pages but heavy bitmaps (a letter page at 150 % on a 2x display is 31 MB)
  assert.deepEqual(pickEvictions(drawn(8, 31 * megabyte), { maxPages: 10, maxBytes: 192 * megabyte }), ["p0", "p1"]);
  // protected pages are skipped, later ones are taken instead
  assert.deepEqual(pickEvictions(drawn(13, 4 * megabyte, [0, 2]), { maxPages: 10, maxBytes: 192 * megabyte }), ["p1", "p3", "p4"]);
  // everything protected: nothing can go, even over budget
  assert.deepEqual(pickEvictions(drawn(12, 40 * megabyte, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), { maxPages: 10, maxBytes: 192 * megabyte }), []);
});

test("thumbnail size: by width or by scale, device pixels capped", () => {
  const page = { width: 595.28, height: 841.89 };
  const byWidth = thumbnailSize(page, { width: 110, pixelRatio: 2 });
  assert.equal(byWidth.width, 220);
  assert.equal(byWidth.height, Math.round((110 * 841.89 * 2) / 595.28));
  assert.ok(Math.abs(byWidth.scale - 110 / 595.28) < 1e-12);
  assert.equal(byWidth.cssWidth, 110);
  const byScale = thumbnailSize(page, { scale: 0.5 });
  assert.equal(byScale.width, Math.round(595.28 / 2));
  assert.equal(byScale.ratio, 1);
  const huge = thumbnailSize(page, { scale: 20, pixelRatio: 2, maxPixels: 4e6 });
  assert.ok(huge.width * huge.height <= 4e6 * 1.01);
  assert.ok(huge.ratio < 2);
  // a rotated page is described by the size the reader sees
  const landscape = thumbnailSize({ width: 841.89, height: 595.28 }, { width: 110 });
  assert.ok(landscape.height < landscape.width);
});
