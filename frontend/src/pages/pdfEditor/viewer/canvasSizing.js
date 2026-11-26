// How many pixels a page canvas gets, and which page canvases may stay in memory. Pure arithmetic (no DOM, no
// pdf.js import): everything that depends on the device comes in as an argument, so the module runs under
// `node --test` (tests/pdfViewerCanvas.test.mjs checks it against pdf.js' own OutputScale).
//
// The sizing is the one of pdf.js' page view (web/pdf_page_view.js and web/ui_utils.js of pdfjs-dist 6.5.438,
// Apache-2.0; approximateFraction / floorToDivide are not exported by the package):
//   * with a fractional pixel ratio (1.25, 1.5, browser zoom 110 %) a canvas of `css width x ratio` pixels would
//     be resampled by the browser and look soft. pdf.js approximates the ratio by a fraction n/d (d <= 8), makes
//     the canvas width a multiple of n and the CSS width a multiple of d (`--scale-round-x: <d>px` feeds the
//     round() of every layer), so canvas pixels and device pixels coincide;
//   * one page canvas never exceeds `maxCanvasPixels`, `maxCanvasDim` per side, nor (capCanvasAreaFactor) three
//     times the screen area in device pixels: above that the bitmap is rendered smaller and stretched by CSS.

/** A fraction [numerator, denominator] close to x with a denominator of at most 8 (pdf.js approximateFraction). */
export function approximateFraction(x) {
  if (Math.floor(x) === x) return [x, 1];
  const inverse = 1 / x;
  const limit = 8;
  if (inverse > limit) return [1, limit];
  if (Math.floor(inverse) === inverse) return [1, inverse];
  const value = x > 1 ? inverse : x;
  // Farey sequence between 0/1 and 1/1
  let a = 0;
  let b = 1;
  let c = 1;
  let d = 1;
  for (;;) {
    const p = a + c;
    const q = b + d;
    if (q > limit) break;
    if (value <= p / q) {
      c = p;
      d = q;
    } else {
      a = p;
      b = q;
    }
  }
  if (value - a / b < c / d - value) return value === x ? [a, b] : [b, a];
  return value === x ? [c, d] : [d, c];
}

/** The largest multiple of `divisor` that is not above x. */
export function floorToDivide(x, divisor) {
  return x - (x % divisor);
}

/**
 * The limits pdf.js' own viewer uses (web/app_options.js): phones and tablets get a much smaller budget.
 * @param {{ userAgent?: string, platform?: string, maxTouchPoints?: number }} [device] fields of `navigator`
 */
export function canvasLimitsFor({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) {
  const isAndroid = /Android/.test(userAgent);
  const isIOS = /\b(?:iPad|iPhone|iPod)(?=;)/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  const mobile = isAndroid || isIOS;
  return {
    mobile,
    maxCanvasPixels: mobile ? 5242880 : 2 ** 25, // pixels of one page canvas
    maxCanvasDim: 32767, // pixels of one side
    capCanvasAreaFactor: 200, // canvas <= screen area in device pixels x (1 + 200 %)
    renderedPages: 10, // page canvases kept alive (pdf.js DEFAULT_CACHE_SIZE)
    renderedBytes: (mobile ? 64 : 192) * 2 ** 20 // ... and their bitmaps together (4 bytes per pixel)
  };
}

/**
 * pdf.js OutputScale.limitCanvas + capPixels as a pure function.
 * @param {{ width: number, height: number, pixelRatio: number, maxPixels?: number, maxDimension?: number,
 *           capAreaFactor?: number, screenArea?: number }} input  width / height in CSS pixels; screenArea =
 *        screen.availWidth x screen.availHeight in CSS pixels (needed when capAreaFactor >= 0)
 * @returns {{ sx: number, sy: number, restricted: boolean }} device pixels per CSS pixel to render with
 */
export function limitOutputScale({ width, height, pixelRatio, maxPixels = -1, maxDimension = -1, capAreaFactor = -1, screenArea = 0 }) {
  let pixelBudget = maxPixels;
  if (capAreaFactor >= 0) {
    const screenPixels = Math.ceil(screenArea * pixelRatio ** 2 * (1 + capAreaFactor / 100));
    pixelBudget = maxPixels > 0 ? Math.min(maxPixels, screenPixels) : screenPixels;
  }
  let maxScale = Infinity;
  if (pixelBudget > 0) maxScale = Math.sqrt(pixelBudget / (width * height));
  if (maxDimension !== -1) maxScale = Math.min(maxScale, maxDimension / width, maxDimension / height);
  if (pixelRatio > maxScale) return { sx: maxScale, sy: maxScale, restricted: true };
  return { sx: pixelRatio, sy: pixelRatio, restricted: false };
}

/**
 * The canvas of a page whose viewport is `width` x `height` CSS pixels.
 * @param {{ width: number, height: number, pixelRatio?: number, limits?: object, screenArea?: number,
 *           singlePrecision?: boolean }} input
 *        limits           { maxCanvasPixels, maxCanvasDim, capCanvasAreaFactor } (canvasLimitsFor)
 *        singlePrecision  true where CSS round() exists: the browser computes calc() in single precision, and
 *                         the sizes written by pdf.js' setLayerDimensions must be mirrored exactly
 * @returns {{ canvasWidth: number, canvasHeight: number, pageWidth: number, pageHeight: number, roundX: number,
 *            roundY: number, sx: number, sy: number, transform: number[] | null, restricted: boolean }}
 *          canvasWidth / canvasHeight  pixels of the bitmap
 *          pageWidth / pageHeight      CSS pixels of the page box (what round(down, ..., roundX px) yields)
 *          roundX / roundY             values for --scale-round-x / --scale-round-y, in CSS pixels
 *          transform                   the `transform` option of page.render() (null when the scale is 1)
 */
export function computeCanvasSize({ width, height, pixelRatio = 1, limits = {}, screenArea = 0, singlePrecision = true }) {
  const round = singlePrecision ? Math.fround : (value) => value;
  const { sx: outputX, sy: outputY, restricted } = limitOutputScale({
    width,
    height,
    pixelRatio,
    maxPixels: limits.maxCanvasPixels ?? -1,
    maxDimension: limits.maxCanvasDim ?? -1,
    capAreaFactor: limits.capCanvasAreaFactor ?? -1,
    screenArea
  });
  const fractionX = approximateFraction(outputX);
  const fractionY = approximateFraction(outputY);
  const canvasWidth = Math.max(1, floorToDivide(round(width * outputX), fractionX[0]));
  const canvasHeight = Math.max(1, floorToDivide(round(height * outputY), fractionY[0]));
  const pageWidth = Math.max(1, floorToDivide(round(width), fractionX[1]));
  const pageHeight = Math.max(1, floorToDivide(round(height), fractionY[1]));
  const sx = canvasWidth / pageWidth;
  const sy = canvasHeight / pageHeight;
  return {
    canvasWidth,
    canvasHeight,
    pageWidth,
    pageHeight,
    roundX: fractionX[1],
    roundY: fractionY[1],
    sx,
    sy,
    transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : null,
    restricted
  };
}

/** The `--scale-round-x / -y` value (CSS pixels) of pages that are not limited by a canvas cap. */
export const scaleRoundFor = (pixelRatio) => approximateFraction(pixelRatio || 1)[1];

/**
 * Which drawn pages to release, oldest first. A page count alone is not a memory bound (one letter page at
 * 150 % on a 2x display is 31 MB), so both budgets apply; protected pages (on screen or about to be) stay.
 * @param {Array<{ id: string, bytes: number, keep: boolean }>} drawn  least recently shown first
 * @param {{ maxPages: number, maxBytes: number }} budget
 * @returns {string[]} ids to release
 */
export function pickEvictions(drawn, { maxPages, maxBytes }) {
  let count = drawn.length;
  let bytes = 0;
  for (const entry of drawn) bytes += entry.bytes;
  const out = [];
  for (const entry of drawn) {
    if (count <= maxPages && bytes <= maxBytes) break;
    if (entry.keep) continue;
    out.push(entry.id);
    count -= 1;
    bytes -= entry.bytes;
  }
  return out;
}

/**
 * Pixel size of a small rendering (thumbnail, organiser tile, preview).
 * @param {{ width: number, height: number }} pageSize  size of the page as the reader sees it, in points
 * @param {{ width?: number, scale?: number, pixelRatio?: number, maxPixels?: number }} request
 *        width = CSS pixels of the result, or scale = CSS pixels per point
 * @returns {{ scale: number, cssWidth: number, cssHeight: number, width: number, height: number, ratio: number }}
 *          scale = CSS pixels per point; width / height = pixels of the bitmap
 */
export function thumbnailSize(pageSize, { width, scale, pixelRatio = 1, maxPixels = 2 ** 24 } = {}) {
  const cssScale = width > 0 ? width / pageSize.width : scale > 0 ? scale : 1;
  const cssWidth = pageSize.width * cssScale;
  const cssHeight = pageSize.height * cssScale;
  let ratio = pixelRatio > 0 ? pixelRatio : 1;
  if (cssWidth * cssHeight * ratio * ratio > maxPixels) ratio = Math.sqrt(maxPixels / (cssWidth * cssHeight));
  return {
    scale: cssScale,
    cssWidth,
    cssHeight,
    width: Math.max(1, Math.round(cssWidth * ratio)),
    height: Math.max(1, Math.round(cssHeight * ratio)),
    ratio
  };
}
