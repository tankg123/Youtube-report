// The rules that make a text box look the same on screen and in the exported PDF. Shared by the text
// layout service (browser side: CSS of every text box and measuring host) and by the export engine
// (PDF side: how fonts are embedded and text is written). Change both sides together or not at all.
//
// The PDF library writes one glyph per character with plain advances: no kerning, no ligatures, no
// contextual forms. The browser must therefore lay text out with exactly those features switched off,
// and fontkit must not substitute glyphs when the font is embedded.

/** OpenType features that are switched OFF on both sides. */
export const DISABLED_FONT_FEATURES = Object.freeze(["kern", "liga", "clig", "calt", "dlig", "frac", "numr", "dnom"]);

/**
 * The `features` object for pdfDoc.embedFont(bytes, { subset: true, features }).
 * A function, not a constant: fontkit MUTATES the object it is given, so every embedFont call needs its
 * own copy and the object must never be frozen or shared.
 */
export function pdfFontFeatures() {
  return Object.fromEntries(DISABLED_FONT_FEATURES.map((feature) => [feature, false]));
}

/** The matching CSS value for `font-feature-settings` of text boxes and measuring hosts. */
export const TEXT_FONT_FEATURE_SETTINGS = DISABLED_FONT_FEATURES.map((feature) => `"${feature}" 0`).join(", ");

/**
 * Font sizes are kept at two decimals of a point: the browser truncates a font size to 1/100 px before
 * shaping, so advances are linear in the size only for such values. The SAME value goes to the PDF.
 */
export const quantizeFontSize = (points) => Math.round(points * 100) / 100;

/** Text is stored and written in NFC (the PDF library draws decomposed Vietnamese with detached accents). */
export const normalizeTextForm = (text) => String(text ?? "").normalize("NFC");
