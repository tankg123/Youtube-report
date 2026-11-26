// Paints the visible stamp of a certificate signature on a canvas and returns it as ONE PNG: the only thing
// about the appearance the signing engine gets (engine/sign holds no text for the user: name, date, reason
// and their labels are drawn here, in the language of the interface).
//
// The text is set in the bundled Arimo (full Vietnamese coverage), loaded through the font registry of text/
// so that the face is really there before it is measured (document.fonts.check() cannot be trusted).
// The layout is appearanceLayout.js (pure); this module only measures and paints.
import { layoutAppearance } from "./appearanceLayout.js";
import { canvasToPng, loadImage } from "./signatureImages.js";
import { pngDataUrl } from "./storage.js";

export const STAMP_FONT = "arimo-regular";
export const STAMP_INK = "#111827";
/** Canvas pixels per point of the stamp; lowered for very large rectangles. */
export const STAMP_PIXELS_PER_POINT = 4;
const MAX_SIDE = 2400;
const MEASURE_SIZE = 100;

/**
 * @param {object} options
 * @param {object} options.fonts          the font registry (editor.fonts)
 * @param {number} options.width          size of the rectangle in points
 * @param {number} options.height
 * @param {"imageAndDetails" | "detailsOnly" | "imageOnly"} options.layout
 * @param {{ dataUrl: string, width: number, height: number } | null} [options.picture]
 * @param {Array<{ text: string }>} [options.lines]    detailLines(...) of appearanceLayout.js
 * @returns {Promise<{ png: Uint8Array, dataUrl: string, width: number, height: number, pixelWidth: number,
 *                     pixelHeight: number, empty: boolean, clipped: boolean }>}
 *          empty: nothing was painted (no picture and no line); clipped: not every line fits the rectangle
 */
export async function renderAppearance({ fonts, width, height, layout, picture = null, lines = [] }) {
  const record = await fonts.ensureFont(STAMP_FONT);
  const face = fonts.faceOf(STAMP_FONT) || { fontFamily: record.cssFamily, fontWeight: 400, fontStyle: "normal" };
  const fontOf = (size) => `${face.fontStyle} ${face.fontWeight} ${size}px "${face.fontFamily}"`;

  const probe = document.createElement("canvas").getContext("2d");
  probe.font = fontOf(MEASURE_SIZE);
  const widths = new Map();
  const measure = (text, size) => {
    if (!widths.has(text)) widths.set(text, probe.measureText(text).width / MEASURE_SIZE);
    return widths.get(text) * size;
  };

  const plan = layoutAppearance({ width, height, layout, image: picture ? { width: picture.width, height: picture.height } : null, lines, measure });
  const scale = Math.max(1, Math.min(STAMP_PIXELS_PER_POINT, MAX_SIDE / Math.max(plan.width, plan.height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(plan.width * scale));
  canvas.height = Math.max(1, Math.round(plan.height * scale));
  const context = canvas.getContext("2d");
  context.scale(scale, scale);

  if (plan.image && picture) {
    const image = await loadImage(picture.dataUrl);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, plan.image.x, plan.image.y, plan.image.w, plan.image.h);
  }
  if (plan.text) {
    context.font = fontOf(plan.text.size);
    context.fillStyle = STAMP_INK;
    context.textBaseline = "alphabetic";
    context.textAlign = "left";
    context.direction = "ltr";
    for (const row of plan.text.rows) context.fillText(row.text, row.x, row.y);
  }
  const png = await canvasToPng(canvas);
  return {
    png,
    dataUrl: pngDataUrl(png),
    width: plan.width,
    height: plan.height,
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    empty: !plan.image && !plan.text,
    clipped: Boolean(plan.text?.clipped)
  };
}
