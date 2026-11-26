// Pixelation and blur of a region of an RGBA bitmap (ImageData-like: { data, width, height }).
// Pure functions, no DOM: the same code runs on canvas ImageData in the browser and on a Node canvas.
//
// SECURITY. A mosaic or a blur of TEXT is not a redaction: each block of a mosaic is the mean of known pixels,
// so an attacker who can render candidate strings in the same font recovers the text by comparing pictures,
// and a redacted PDF tells him font, size and position. The engine removes the text under the region from the
// page content in any case; what is decided HERE is how much the picture that is shown in its place gives back.
// All figures below come from that attack, run end to end on the picture the product stores (150 px per
// inch): a 4-digit number in Arimo, all 10 000 candidates scored with the exact likelihood of the observed
// block levels on every grid the picture allows. 13.3 bits = nothing learnt; "bits left" = log2 of the median
// rank of the true number; the grid search is thinned in the attacker's favour, so the figures are lower bounds.
//
//   plain mosaic, block 0.1 .. 0.5 x height of the mark        number read in 75 .. 100 % of the cases
//   plain blur, sigma 0.1 .. 0.75 x height                      number read in 100 %
//   first rule of this module (8 levels, noise 24, random grid, block = max(12 pt, 0.5 x height)), as the
//   independent review measured it (20 to 30 secrets) and as a rerun with 1 000 secrets confirmed:
//     one export                 12 pt  10.7 .. 11.3 bits left      36 pt  8.9 .. 9.6      72 pt  8.4 .. 8.6
//     16 exports of one mark     12 pt   7.3 bits left              36 pt  2.0 after 8 exports (5 of 20 numbers
//                                read exactly): every export drew new noise, so their mean was the picture
//   THE RULE NOW (BLUR_DEFAULTS), 400 secrets per setting, strengths 1 / 2 / 3:
//     the line box of the number plus 1 pt                      12 pt  12.2 / 12.2 / 12.2 bits left
//                                                               36 pt  11.6 / 12.0 / 12.1
//                                                               72 pt  11.7 / 11.8 / 12.0
//     the line box exactly (strength 1)                         12 / 36 / 72 pt   11.7 / 11.7 / 11.9
//     a stripe of 0.2 em through the middle of the digits       12 pt  11.9 / 12.0 / 12.0      36 pt  11.8 / 12.0 / 12.0
//     1 number of the 7 200 was the top candidate (chance)
//     16 exports of a mark WITH a seed                          the same picture 600 times of 600: what one export gives
//     16 exports of a mark without a seed                       12 pt  8.8 bits left           36 pt  9.3
//
// What the rule is made of:
//   blocks      block edge = the largest of 12 pt, TWICE the height of the area the mosaic is made of and 2.25 x
//               the largest font size under the mark, times the strength (1, 2 or 3; a strength below 1 is
//               raised to 1: nothing weaker is offered). A block then spans about four digits of the text it
//               hides, at any font size (the first rule kept 12 pt for large text: one digit per block)
//   levels      8 levels per channel, uniform noise of +-24 levels on every block before the quantisation, and a
//               random grid offset
//   the area    the mosaic is made of the mark TOGETHER WITH the glyphs it takes (a glyph goes as a whole) and
//               shown inside the mark: the callers pass that area and crop (redactPdf.js under(),
//               rasterizePage.js burnRegions `source`). The mosaic of a thin mark alone would be the mean over
//               the densest part of the glyphs: measured 10.7 bits left where the whole glyphs leave 11.9
//   the seed    a mark carries a seed (targets[].seed). Noise and grid offset then come from a key stream of
//               the seed (mosaicKeyStream: AES-128 in counter mode through WebCrypto, computed BEFORE the pixel
//               work) and from nothing else: not from env.random, not from the other marks, not from the
//               pixels (a stream derived from the content would make the mosaic a fingerprint candidates can
//               be checked against). Every export of the mark shows the same picture, so several exports are
//               worth one. A mark without a seed gets fresh noise each time: redactPdf() warns
//               (REDACT_MOSAIC_NOT_SEEDED), because the mean of many exports converges on the plain mosaic
//   blur        the SAME mosaic, smoothed afterwards: a function of the mosaic alone (the acceptance run
//               rebuilds the stored "blur" picture from the "pixelate" picture of the same seed, byte for
//               byte), so it adds no information. A true blur of the original pixels exists as blurRegion()
//               for the tests only
// The price: the mosaic of one line of text is a few light-grey blocks, often a single flat colour (a third of
// the pictures at strength 1). It shows THAT something is covered, not the shape of what it was.
//
// "Height" means the extent ACROSS the line of text. On a page with /Rotate 90 or 270 that is the width of the
// region in the user space of the page, so the caller passes `sideways` there: a line of text gets the same
// mosaic on a rotated page as on an upright one. A region that is tall for another reason (a paragraph, a
// picture) gets coarse blocks: twice its height, that is one or two blocks in all. That is the safe side, and
// the price of one rule for everything.

import { PdfEditorError } from "../errors.js";

export const BLUR_DEFAULTS = Object.freeze({
  /**
   * block edge = the largest of: height of the area the mosaic is made of * blockRatio, the largest font size
   * under the mark * emRatio, minBlockPt points (then multiplied by the strength). Measured: see the header
   */
  blockRatio: 2,
  emRatio: 2.25,
  minBlockPt: 12,
  /** grey levels per channel that survive */
  levels: 8,
  /** uniform noise added to every block mean before quantisation, in levels (0..255) */
  noise: 24,
  /** style "blur": standard deviation of the smoothing = block * smoothRatio */
  smoothRatio: 0.5,
  /** the strengths a mark may ask for: the factor on the block edge (1 = the measured default) */
  strengths: Object.freeze([1, 2, 3])
});

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Random source for the noise: the platform's CSPRNG (browser, worker and Node have globalThis.crypto). */
export function cryptoRandom() {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new PdfEditorError("REDACT_ENV_INVALID", { missing: "random" }, { detail: "no cryptographic random source: pass env.random" });
  const buf = new Uint32Array(64);
  let i = buf.length;
  return () => {
    if (i >= buf.length) {
      c.getRandomValues(buf);
      i = 0;
    }
    return buf[i++] / 4294967296;
  };
}

/** 16 bytes from 32 hexadecimal digits (the seed of a mark), or null. */
function seedBytes(seed) {
  if (typeof seed !== "string" || !/^[0-9a-f]{32}$/i.test(seed)) return null;
  return Uint8Array.from({ length: 16 }, (_, index) => parseInt(seed.slice(index * 2, index * 2 + 2), 16));
}

/** Is the value usable as the seed of a mark (32 hexadecimal digits)? */
export const isSeed = (seed) => seedBytes(seed) !== null;

/**
 * The key stream of ONE mosaic that must come out the same in every export: `draws` numbers (4 bytes each)
 * from AES-128 in counter mode, keyed with the seed of the mark, starting at a counter that is a hash of
 * `context` (what the mosaic is made for: its rectangle and strength). Computed through WebCrypto BEFORE the
 * pixel work, which is synchronous.
 *   - Nothing of it comes from the pixels: a stream derived from the content would make the mosaic a
 *     fingerprint that candidates could be checked against.
 *   - Another rectangle or strength gives an unrelated stream: the same noise on another grid would let an
 *     observer of both pictures subtract it.
 *   - The style is not part of it: "blur" is a function of the "pixelate" mosaic and must stay one.
 * Returns the bytes (hand them to keyStreamReader() for every use: a second build of the same job must read
 * the stream from its start again).
 */
export async function mosaicKeyStream(seed, context, draws) {
  const key = seedBytes(seed);
  const subtle = globalThis.crypto?.subtle;
  if (!key) throw new TypeError("not a seed");
  if (!subtle) throw new PdfEditorError("REDACT_ENV_INVALID", { missing: "random" }, { detail: "no WebCrypto: a mark with a seed cannot be obscured" });
  const label = new TextEncoder().encode(`pdf-editor/redact/mosaic/1|${context}`);
  const counter = new Uint8Array(await subtle.digest("SHA-256", label)).slice(0, 16);
  const cipher = await subtle.importKey("raw", key, { name: "AES-CTR" }, false, ["encrypt"]);
  const count = Math.max(8, Math.min(1 << 22, Math.ceil(draws)));
  return new Uint8Array(await subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, cipher, new Uint8Array(count * 4)));
}

/** () => number in [0, 1) that reads a key stream of mosaicKeyStream() from its start. */
export function keyStreamReader(stream) {
  let at = 0;
  return () => {
    // (the stream is sized for the largest grid the rectangle can get: running out of it is a bug, not a state)
    if (at + 4 > stream.length) throw new RangeError("the key stream of a mosaic is exhausted");
    const value = ((stream[at] << 24) | (stream[at + 1] << 16) | (stream[at + 2] << 8) | stream[at + 3]) >>> 0;
    at += 4;
    return value / 4294967296;
  };
}

/** The numbers a mosaic of a rectangle of `widthPt` x `heightPt` points can draw at most (two for the grid, one per block). */
export function mosaicDraws(widthPt, heightPt) {
  const across = Math.ceil(Math.max(0, widthPt) / BLUR_DEFAULTS.minBlockPt) + 2;
  const down = Math.ceil(Math.max(0, heightPt) / BLUR_DEFAULTS.minBlockPt) + 2;
  return 2 + across * down;
}

/**
 * The block edge of a mosaic in pixels (the rule of BLUR_DEFAULTS).
 *   boxHeightPx   the extent of the region across the line of text, in pixels
 *   pxPerPt       resolution of the picture
 *   strength      1 | 2 | 3
 *   emPt          the largest font size of the text under the mark, in points (0: not known, e.g. a scan)
 */
export function mosaicBlock({ boxHeightPx, pxPerPt, strength = 1, emPt = 0 }) {
  const factor = Number.isFinite(strength) ? Math.max(1, strength) : 1;
  const em = Number.isFinite(emPt) && emPt > 0 ? emPt : 0;
  return Math.max(1, Math.round(Math.max(BLUR_DEFAULTS.minBlockPt * pxPerPt, boxHeightPx * BLUR_DEFAULTS.blockRatio, em * pxPerPt * BLUR_DEFAULTS.emRatio) * factor));
}

/**
 * Mosaic of the pixel rectangle [x, y, x + w, y + h) in place.
 *   block    block edge in pixels
 *   levels   quantisation levels per channel (2..256)
 *   noise    amplitude of the uniform noise added to each block mean
 *   random   () => number in [0, 1); null: no noise and no grid offset (a plain, REVERSIBLE mosaic)
 *   gridOffset  false: keep the grid at the corner of the region even when `random` is given
 */
export function pixelateRegion(image, x, y, w, h, { block, levels = 256, noise = 0, random = null, gridOffset = true } = {}) {
  const { data, width, height } = image;
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  w = Math.min(width - x, Math.ceil(w));
  h = Math.min(height - y, Math.ceil(h));
  if (w <= 0 || h <= 0) return { blocks: 0 };
  const b = Math.max(1, Math.round(block));
  const offX = random && gridOffset ? Math.floor(random() * b) : 0;
  const offY = random && gridOffset ? Math.floor(random() * b) : 0;
  const step = levels >= 256 ? 1 : 255 / (levels - 1);
  let blocks = 0;
  for (let by = y - offY; by < y + h; by += b) {
    for (let bx = x - offX; bx < x + w; bx += b) {
      const x0 = Math.max(x, bx);
      const y0 = Math.max(y, by);
      const x1 = Math.min(x + w, bx + b);
      const y1 = Math.min(y + h, by + b);
      if (x1 <= x0 || y1 <= y0) continue;
      let r = 0;
      let g = 0;
      let bl = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) {
          r += data[p];
          g += data[p + 1];
          bl += data[p + 2];
          n++;
        }
      }
      // the same noise on the three channels keeps a grey block grey
      const jitter = random && noise ? (random() * 2 - 1) * noise : 0;
      const q = (v) => clampByte(Math.round(clampByte(v / n + jitter) / step) * step);
      const cr = q(r);
      const cg = q(g);
      const cb = q(bl);
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) {
          data[p] = cr;
          data[p + 1] = cg;
          data[p + 2] = cb;
          data[p + 3] = 255;
        }
      }
      blocks++;
    }
  }
  return { blocks, block: b };
}

function boxBlurPass(src, dst, w, h, r, horizontal) {
  // one pass of a box blur of radius r over an RGB float buffer (edges clamped)
  const win = 2 * r + 1;
  const lineCount = horizontal ? h : w;
  const lineLen = horizontal ? w : h;
  const stride = horizontal ? 3 : w * 3;
  for (let line = 0; line < lineCount; line++) {
    const base = horizontal ? line * w * 3 : line * 3;
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      const at = (i) => src[base + Math.min(lineLen - 1, Math.max(0, i)) * stride + c];
      for (let i = -r; i <= r; i++) acc += at(i);
      for (let i = 0; i < lineLen; i++) {
        dst[base + i * stride + c] = acc / win;
        acc += at(i + r + 1) - at(i - r);
      }
    }
  }
}

/**
 * Gaussian-like blur (three box blurs) of the pixel rectangle in place. Only pixels of the region are used.
 * On its own this is NOT safe for text (the attack of the header reads a 4-digit number back at every sigma).
 *   sigma   standard deviation in pixels
 *   levels / noise / random   as in pixelateRegion (applied per pixel after the blur)
 */
export function blurRegion(image, x, y, w, h, { sigma, levels = 256, noise = 0, random = null } = {}) {
  const { data, width, height } = image;
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  w = Math.min(width - x, Math.ceil(w));
  h = Math.min(height - y, Math.ceil(h));
  if (w <= 0 || h <= 0) return { radius: 0 };
  // three box blurs of radius r approximate a Gaussian with sigma^2 = r (r + 1)
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const a = new Float32Array(w * h * 3);
  const b = new Float32Array(w * h * 3);
  for (let yy = 0; yy < h; yy++) {
    let p = ((y + yy) * width + x) * 4;
    let q = yy * w * 3;
    for (let xx = 0; xx < w; xx++, p += 4, q += 3) {
      a[q] = data[p];
      a[q + 1] = data[p + 1];
      a[q + 2] = data[p + 2];
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(a, b, w, h, r, true);
    boxBlurPass(b, a, w, h, r, false);
  }
  const step = levels >= 256 ? 1 : 255 / (levels - 1);
  for (let yy = 0; yy < h; yy++) {
    let p = ((y + yy) * width + x) * 4;
    let q = yy * w * 3;
    for (let xx = 0; xx < w; xx++, p += 4, q += 3) {
      const jitter = random && noise ? (random() * 2 - 1) * noise : 0;
      data[p] = clampByte(Math.round(clampByte(a[q] + jitter) / step) * step);
      data[p + 1] = clampByte(Math.round(clampByte(a[q + 1] + jitter) / step) * step);
      data[p + 2] = clampByte(Math.round(clampByte(a[q + 2] + jitter) / step) * step);
      data[p + 3] = 255;
    }
  }
  return { radius: r };
}

/** Copies a pixel rectangle out of an image: { data, width, height }. */
export function cropRegion(image, x, y, w, h) {
  const { data, width } = image;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) out.set(data.subarray(((y + yy) * width + x) * 4, ((y + yy) * width + x + w) * 4), yy * w * 4);
  return { data: out, width: w, height: h };
}

/**
 * Applies the obscuring style of a region to the pixels [x, y, w, h] of an image (see the header).
 *   style     "pixelate" | "blur"
 *   pxPerPt   resolution of the image (pixels per point), used for the minimum block size
 *   strength  multiplies the block size (1 = default; values below 1 are raised to 1: weaker is not offered)
 *   random    () => [0, 1); default: the platform CSPRNG. There is no way to switch the noise off here.
 *   sideways  true when the reader's "up" is the x axis of the image (a page with /Rotate 90 or 270 rendered
 *             in the orientation of its user space): the "region height" of the rule is then the width, so
 *             that a line of text gets the same mosaic on a rotated page as on an upright one
 *   emPt      the largest font size of the text under the region, in points (see mosaicBlock)
 * The region is what the mosaic is MADE of: for a mark over text the caller passes the mark grown to the glyphs
 * it takes and crops the result to the mark (see "the area" in the header).
 */
export function obscureRegion(image, x, y, w, h, { style = "pixelate", pxPerPt = 2, strength = 1, random, sideways = false, emPt = 0 } = {}) {
  const defaults = BLUR_DEFAULTS;
  const rnd = typeof random === "function" ? random : cryptoRandom();
  const block = mosaicBlock({ boxHeightPx: Math.max(1, sideways ? w : h), pxPerPt, strength, emPt });
  const info = pixelateRegion(image, x, y, w, h, { block, levels: defaults.levels, noise: defaults.noise, random: rnd });
  if (style !== "blur") return { style: "pixelate", ...info };
  // smoothing the mosaic gives the look of a blur; it is a function of the mosaic alone
  const sigma = info.block * defaults.smoothRatio;
  return { style: "blur", sigma, ...info, ...blurRegion(image, x, y, w, h, { sigma }) };
}
