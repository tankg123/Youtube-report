// The visible stamp of a certificate signature (UX specification 7.11, step 2): which lines it shows and where
// the picture and the lines go inside the rectangle. Pure (tests/pdfSigningAppearance.test.mjs): the text is
// measured by a function the caller supplies; appearanceRender.js paints the result on a canvas with a
// bundled font and hands ONE PNG to the signing engine.
//
// Units are points, origin top-left of the stamp, y down.
import { tk } from "../../../i18n/index.js";

export const APPEARANCE_LAYOUTS = Object.freeze(["imageAndDetails", "detailsOnly", "imageOnly"]);
export const APPEARANCE_LAYOUT_LABELS = Object.freeze({
  imageAndDetails: tk("Image and details"),
  detailsOnly: tk("Details only"),
  imageOnly: tk("Image only")
});
/** The details a stamp can show, in the order they are written. */
export const DETAIL_KEYS = Object.freeze(["name", "date", "reason", "location", "organisation"]);
export const DETAIL_CHOICES = Object.freeze({
  name: tk("Name"),
  date: tk("Date and time"),
  reason: tk("Reason"),
  location: tk("Location"),
  organisation: tk("Organisation")
});
/** What stands before a detail when "Show labels" is on. */
export const DETAIL_LABELS = Object.freeze({
  name: tk("Signed by:"),
  date: tk("Date:"),
  reason: tk("Reason:"),
  location: tk("Location:"),
  organisation: tk("Organisation:")
});
export const DEFAULT_SHOW = Object.freeze({ name: true, date: true, reason: false, location: false, organisation: false, labels: true });
/** The three reasons offered in the combo box; anything else can be typed. */
export const REASON_PRESETS = Object.freeze([tk("I approve this document"), tk("I am the author of this document"), tk("I have reviewed this document")]);

export const FONT_SIZE_LIMITS = Object.freeze({ max: 11, min: 3.5, step: 0.25 });
export const LINE_HEIGHT = 1.22;
/** Where the baseline sits inside a line, as a share of the font size from the top of the glyph box. */
const ASCENT = 0.8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * The lines of a stamp.
 * @param {object} options
 * @param {object} options.show     { name, date, reason, location, organisation, labels }: booleans
 * @param {object} options.values   { name, date, reason, location, organisation }: strings (date already formatted)
 * @param {(text: string) => string} options.t   the translator, for the labels
 * @returns {Array<{ key: string, label: string, value: string, text: string }>} empty values are left out
 */
export function detailLines({ show = DEFAULT_SHOW, values = {}, t = (text) => text } = {}) {
  const lines = [];
  for (const key of DETAIL_KEYS) {
    if (!show[key]) continue;
    const value = String(values[key] ?? "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    const label = show.labels ? t(DETAIL_LABELS[key]) : "";
    lines.push({ key, label, value, text: label ? `${label} ${value}` : value });
  }
  return lines;
}

/**
 * Breaks one line of text into rows no wider than `maxWidth`: at spaces, and inside a word only when the
 * word alone is too wide.
 * @param {(text: string) => number} measure   width of a text at the size in question
 */
export function wrapText(text, maxWidth, measure) {
  const words = String(text ?? "").split(" ").filter(Boolean);
  const rows = [];
  let row = "";
  const push = () => {
    if (row) rows.push(row);
    row = "";
  };
  for (const word of words) {
    const candidate = row ? `${row} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      row = candidate;
      continue;
    }
    push();
    if (measure(word) <= maxWidth) {
      row = word;
      continue;
    }
    // a word wider than the stamp: cut it by code points (never inside a surrogate pair)
    let piece = "";
    for (const char of Array.from(word)) {
      if (piece && measure(piece + char) > maxWidth) {
        rows.push(piece);
        piece = char;
      } else {
        piece += char;
      }
    }
    row = piece;
  }
  push();
  return rows;
}

function fitImage(area, size) {
  if (!size || !(size.width > 0) || !(size.height > 0) || !(area.w > 0) || !(area.h > 0)) return null;
  const scale = Math.min(area.w / size.width, area.h / size.height);
  const w = size.width * scale;
  const h = size.height * scale;
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}

function fitText(area, lines, measure, align) {
  if (!lines.length || !(area.w > 0) || !(area.h > 0)) return null;
  const sizes = [];
  for (let size = FONT_SIZE_LIMITS.max; size >= FONT_SIZE_LIMITS.min - 1e-9; size -= FONT_SIZE_LIMITS.step) sizes.push(Math.round(size * 100) / 100);
  let chosen = null;
  for (const size of sizes) {
    const rows = lines.flatMap((line) => wrapText(line.text, area.w, (text) => measure(text, size)));
    const fits = rows.length * size * LINE_HEIGHT <= area.h + 1e-6 && rows.every((row) => measure(row, size) <= area.w + 1e-6);
    chosen = { size, rows, fits };
    if (fits) break;
  }
  let { rows } = chosen;
  const { size } = chosen;
  const pitch = size * LINE_HEIGHT;
  const clipped = !chosen.fits;
  // at the smallest size the rows that do not fit are left out rather than drawn outside the stamp
  if (clipped) rows = rows.slice(0, Math.max(1, Math.floor((area.h + 1e-6) / pitch)));
  const top = area.y + Math.max(0, (area.h - rows.length * pitch) / 2);
  return {
    size,
    lineHeight: LINE_HEIGHT,
    clipped,
    rows: rows.map((text, index) => {
      const width = measure(text, size);
      const x = align === "center" ? area.x + Math.max(0, (area.w - width) / 2) : area.x;
      return { text, x, y: top + index * pitch + (pitch - size) / 2 + size * ASCENT, width };
    })
  };
}

/**
 * Where the picture and the lines of a stamp go.
 * @param {object} options
 * @param {number} options.width            size of the stamp in points
 * @param {number} options.height
 * @param {"imageAndDetails" | "detailsOnly" | "imageOnly"} options.layout
 * @param {{ width: number, height: number } | null} [options.image]   the picture's own size (any unit)
 * @param {Array<{ text: string }>} [options.lines]                    detailLines(...)
 * @param {(text: string, fontSize: number) => number} options.measure  width of `text` in points at `fontSize` points
 * @returns {{ width, height, image: { x, y, w, h } | null, text: { size, lineHeight, clipped, rows: [{ text, x, y, width }] } | null }}
 *          A layout that asks for something that is not there falls back to what there is (no picture: the
 *          lines alone; no lines: the picture alone); with neither, both are null.
 */
export function layoutAppearance({ width, height, layout = "imageAndDetails", image = null, lines = [], measure }) {
  const w = Math.max(1, Number(width) || 0);
  const h = Math.max(1, Number(height) || 0);
  const pad = clamp(Math.min(w, h) * 0.06, 1.5, 6);
  const inner = { x: pad, y: pad, w: w - 2 * pad, h: h - 2 * pad };
  const hasImage = Boolean(image && image.width > 0 && image.height > 0) && layout !== "detailsOnly";
  const hasText = lines.length > 0 && layout !== "imageOnly" && typeof measure === "function";
  if (hasImage && hasText) {
    const gap = clamp(Math.min(w, h) * 0.06, 2, 8);
    if (w / h >= 1.6) {
      const imageWidth = (inner.w - gap) * 0.4;
      return {
        width: w,
        height: h,
        image: fitImage({ x: inner.x, y: inner.y, w: imageWidth, h: inner.h }, image),
        text: fitText({ x: inner.x + imageWidth + gap, y: inner.y, w: inner.w - imageWidth - gap, h: inner.h }, lines, measure, "left")
      };
    }
    const imageHeight = (inner.h - gap) * 0.5;
    return {
      width: w,
      height: h,
      image: fitImage({ x: inner.x, y: inner.y, w: inner.w, h: imageHeight }, image),
      text: fitText({ x: inner.x, y: inner.y + imageHeight + gap, w: inner.w, h: inner.h - imageHeight - gap }, lines, measure, "center")
    };
  }
  return {
    width: w,
    height: h,
    image: hasImage ? fitImage(inner, image) : null,
    text: hasText ? fitText(inner, lines, measure, "left") : null
  };
}

/** True when a stamp with these settings would show nothing at all (the Next button then says what is missing). */
export function appearanceIsEmpty({ layout, hasImage, lines }) {
  if (layout === "imageOnly") return !hasImage;
  if (layout === "detailsOnly") return !lines.length;
  return !hasImage && !lines.length;
}
