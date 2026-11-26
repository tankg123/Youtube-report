// Background and text colour of a piece of a rendered page, read from its pixels. "Edit text" covers the
// original line with the background colour and starts the replacement in the text colour. Pure function on
// RGBA bytes (ImageData.data), so it runs under `node --test` (tests/pdfViewerColors.test.mjs).
//
// Rule: the background is the most frequent colour; the text is the frequent colour farthest from it (the
// solid core of the glyphs; the anti-aliased rim lies between the two and never wins).

const BITS = 4; // per channel: 4096 bins
const SHIFT = 8 - BITS;
const BINS = 1 << (BITS * 3);

const hex = (r, g, b) => `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;

/**
 * @param {Uint8ClampedArray | Uint8Array | number[]} data  RGBA bytes, 4 per pixel
 * @param {{ minShare?: number, minDistance?: number }} [options]
 *        minShare     smallest share of the pixels a colour needs to count as "frequent" (default 0.4 %)
 *        minDistance  smallest distance (0..441, Euclidean in RGB) between background and text (default 48)
 * @returns {{ background: string, text: string, found: boolean, pixels: number }}  colours as "#rrggbb";
 *          found = false when the piece shows one colour only: `text` is then black or white, whichever
 *          contrasts with the background
 */
export function sampleColorsFromPixels(data, { minShare = 0.004, minDistance = 48 } = {}) {
  const counts = new Uint32Array(BINS);
  const sums = new Float64Array(BINS * 3);
  let pixels = 0;
  for (let offset = 0; offset + 3 < data.length; offset += 4) {
    if (data[offset + 3] < 128) continue; // transparent: nothing was painted here
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const bin = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    counts[bin] += 1;
    sums[bin * 3] += r;
    sums[bin * 3 + 1] += g;
    sums[bin * 3 + 2] += b;
    pixels += 1;
  }
  if (pixels === 0) return { background: "#ffffff", text: "#000000", found: false, pixels: 0 };

  let backgroundBin = 0;
  for (let bin = 1; bin < BINS; bin += 1) if (counts[bin] > counts[backgroundBin]) backgroundBin = bin;
  const mean = (bin) => [sums[bin * 3] / counts[bin], sums[bin * 3 + 1] / counts[bin], sums[bin * 3 + 2] / counts[bin]];
  const background = mean(backgroundBin);

  // Thin text at a small scale has few solid pixels: lower the bar step by step before giving up.
  let textBin = -1;
  for (const floor of [Math.max(3, Math.ceil(pixels * minShare)), 3, 2]) {
    let farthest = minDistance;
    for (let bin = 0; bin < BINS; bin += 1) {
      if (counts[bin] < floor || bin === backgroundBin) continue;
      const colour = mean(bin);
      const distance = Math.hypot(colour[0] - background[0], colour[1] - background[1], colour[2] - background[2]);
      if (distance > farthest) {
        farthest = distance;
        textBin = bin;
      }
    }
    if (textBin >= 0) break;
  }

  const backgroundHex = hex(...background);
  if (textBin < 0) {
    const luminance = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
    return { background: backgroundHex, text: luminance < 128 ? "#ffffff" : "#000000", found: false, pixels };
  }
  return { background: backgroundHex, text: hex(...mean(textBin)), found: true, pixels };
}
