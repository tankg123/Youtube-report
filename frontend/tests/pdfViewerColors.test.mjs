// Background and text colour of a piece of a rendered page (viewer/colorSampling.js): on hand-made pixels and
// on pages rendered by pdf.js.
import test from "node:test";
import assert from "node:assert/strict";
import { canRender, rectToPixels, renderPage, withPdf } from "./helpers/pdfTestKit.mjs";
import { makePdf, textContentOf } from "./helpers/pdfViewerKit.mjs";
import { sampleColorsFromPixels } from "../src/pages/pdfEditor/viewer/colorSampling.js";
import { groupTextLines } from "../src/pages/pdfEditor/viewer/textLines.js";

/** RGBA bytes of `width` x `height` pixels: `paint(x, y)` returns [r, g, b] or [r, g, b, a]. */
function pixels(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return data;
}

const channels = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
const closeTo = (hex, expected, tolerance, label) => {
  channels(hex).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `${label}: ${hex} is not near ${expected}`));
};

test("two colours: the frequent one is the background, the other the text", () => {
  const data = pixels(40, 10, (x) => (x % 5 === 0 ? [200, 0, 0] : [255, 255, 0]));
  assert.deepEqual(sampleColorsFromPixels(data), { background: "#ffff00", text: "#c80000", found: true, pixels: 400 });
});

test("the anti-aliased rim between text and paper never wins", () => {
  // a dark stroke with a soft edge on white: most stroke pixels are blends
  const data = pixels(60, 12, (x) => {
    const phase = x % 6;
    if (phase === 0) return [17, 34, 51];
    if (phase === 1 || phase === 5) return [136, 144, 153];
    return [255, 255, 255];
  });
  const result = sampleColorsFromPixels(data);
  assert.equal(result.background, "#ffffff");
  assert.equal(result.text, "#112233");
});

test("one colour only: no text found, and a text colour that contrasts", () => {
  assert.deepEqual(sampleColorsFromPixels(pixels(8, 8, () => [250, 250, 250])), { background: "#fafafa", text: "#000000", found: false, pixels: 64 });
  assert.deepEqual(sampleColorsFromPixels(pixels(8, 8, () => [20, 30, 40])), { background: "#141e28", text: "#ffffff", found: false, pixels: 64 });
  // noise near the background is not text
  const noisy = pixels(20, 20, (x, y) => ((x + y) % 7 === 0 ? [236, 236, 236] : [255, 255, 255]));
  assert.equal(sampleColorsFromPixels(noisy).found, false);
});

test("few solid pixels (thin text at a small scale) are still found; transparent pixels do not count", () => {
  const data = pixels(50, 20, (x, y) => (y === 10 && x > 20 && x < 24 ? [0, 0, 160] : [240, 240, 240]));
  const result = sampleColorsFromPixels(data);
  assert.equal(result.found, true);
  assert.equal(result.text, "#0000a0");
  assert.equal(sampleColorsFromPixels(pixels(4, 4, () => [0, 0, 0, 0])).pixels, 0);
  assert.equal(sampleColorsFromPixels(new Uint8ClampedArray(0)).found, false);
  const half = sampleColorsFromPixels(pixels(10, 10, (x) => (x < 5 ? [0, 0, 0, 0] : [10, 200, 10])));
  assert.equal(half.pixels, 50);
  assert.equal(half.background, "#0ac80a");
});

test("on a rendered page: black on white, and coloured text on a coloured band", { skip: !canRender && "no canvas binary on this platform" }, async () => {
  const bytes = await makePdf([
    {
      rects: [{ x: 40, y: 590, w: 400, h: 40, color: [1, 0.92, 0.23] }],
      texts: [
        { text: "Chữ đen trên giấy trắng", x: 50, y: 700, size: 16 },
        { text: "Chữ đỏ trên nền vàng", x: 50, y: 604, size: 16, color: [0.8, 0.1, 0.1] },
        { text: "Chữ xanh đậm", x: 50, y: 500, size: 16, color: [0.1, 0.3, 0.6], fontKey: "arimo-bold" }
      ]
    }
  ]);
  const content = await textContentOf(bytes);
  const lines = groupTextLines(content.items, content.styles);
  assert.equal(lines.length, 3);
  await withPdf(bytes, async (doc) => {
    const page = await doc.getPage(1);
    const { ctx, canvas, viewport } = await renderPage(page, { scale: 2 });
    const sample = (line) => {
      const [left, top, right, bottom] = rectToPixels(viewport, line.rect, canvas);
      return sampleColorsFromPixels(ctx.getImageData(left, top, right - left, bottom - top).data);
    };
    const black = sample(lines[0]);
    assert.equal(black.found, true);
    assert.equal(black.background, "#ffffff");
    closeTo(black.text, [0, 0, 0], 40, "black text");
    const red = sample(lines[1]);
    closeTo(red.background, [255, 235, 59], 6, "yellow band");
    closeTo(red.text, [204, 26, 26], 40, "red text");
    const blue = sample(lines[2]);
    assert.equal(blue.background, "#ffffff");
    closeTo(blue.text, [26, 77, 153], 40, "blue text");
    // an empty piece of the page
    const [left, top, right, bottom] = rectToPixels(viewport, [50, 100, 300, 200], canvas);
    assert.deepEqual(sampleColorsFromPixels(ctx.getImageData(left, top, right - left, bottom - top).data), { background: "#ffffff", text: "#000000", found: false, pixels: (right - left) * (bottom - top) });
  });
});
