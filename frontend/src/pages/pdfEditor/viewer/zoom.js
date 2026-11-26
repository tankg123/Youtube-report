// Zoom arithmetic of the viewer. Pure functions (tests/pdfViewerPages.test.mjs).
//
// Two numbers describe the magnification and they must not be mixed up:
//   zoom   what the user reads: 1 = 100 % = "actual size" (one PDF point is 1/72 inch, one CSS pixel 1/96 inch)
//   scale  CSS pixels per PDF point = zoom x 96 / 72. This is the `scale` of every function of
//          ../engine/geometry.js, of pdf.js' page.getViewport() and the `data-scale` attribute of a page.

export const CSS_UNITS = 96 / 72;
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const ZOOM_MODES = Object.freeze(["custom", "fit-width", "fit-page", "actual"]);
/** The stops of zoomIn() / zoomOut(), as zoom factors. */
export const ZOOM_STOPS = Object.freeze([0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8]);

const EPSILON = 1e-6;

export const zoomToScale = (zoom) => zoom * CSS_UNITS;
export const scaleToZoom = (scale) => scale / CSS_UNITS;

export function clampZoom(zoom) {
  const value = Number(zoom);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/** The next larger stop (the maximum when there is none). */
export function nextZoomStop(zoom) {
  return ZOOM_STOPS.find((stop) => stop > zoom + EPSILON) ?? ZOOM_MAX;
}

/** The next smaller stop (the minimum when there is none). */
export function previousZoomStop(zoom) {
  for (let index = ZOOM_STOPS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_STOPS[index] < zoom - EPSILON) return ZOOM_STOPS[index];
  }
  return ZOOM_MIN;
}

/**
 * The zoom factor of a mode.
 * @param {"fit-width" | "fit-page" | "actual"} mode
 * @param {{ pageWidth: number, pageHeight: number, availableWidth: number, availableHeight: number }} box
 *        pageWidth / pageHeight: size of the page as the reader sees it, in points (rotation applied);
 *        availableWidth / availableHeight: room for one page in CSS pixels (the scroll area without padding)
 * @returns {number} zoom factor within [ZOOM_MIN, ZOOM_MAX]; 1 when the box is unknown
 */
export function fitZoom(mode, { pageWidth, pageHeight, availableWidth, availableHeight }) {
  if (mode === "actual") return 1;
  if (!(pageWidth > 0) || !(pageHeight > 0) || !(availableWidth > 0)) return 1;
  const byWidth = availableWidth / (pageWidth * CSS_UNITS);
  if (mode === "fit-width" || !(availableHeight > 0)) return clampZoom(byWidth);
  return clampZoom(Math.min(byWidth, availableHeight / (pageHeight * CSS_UNITS)));
}

/** The whole percentage shown to the user: 1.25 -> 125. */
export const zoomPercent = (zoom) => Math.round(zoom * 100);
