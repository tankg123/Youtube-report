// The ONE description of how a text box is styled. The hidden measuring host (layout.js), the picture maker
// (raster.js), the committed box (TextBox.jsx) and the editor (TextEditor.jsx) all take their inline style from
// here, so the four can never drift apart: what is measured is what is shown and what is exported.
// Pure data and pure functions (no DOM): runs under `node --test`.
//
// A text box is laid out by the browser at a fixed LAYOUT SCALE: one PDF point = LAYOUT_SCALE CSS pixels
// inside the box, and the box is painted through a CSS transform that carries the zoom. Transforms take no
// part in layout, so line breaks and glyph positions are the same at every zoom level and the CSS font size
// never comes near a browser's minimum font size.
import { TEXT_FONT_FEATURE_SETTINGS, quantizeFontSize } from "../engine/textRules.js";
import { SIGNATURE_FONTS, TEXT_FONTS, fontKey, fontKeyOf, FALLBACK_TEXT_FONT } from "../model/schema.js";

/** CSS pixels per PDF point inside a text box and inside the measuring host. */
export const LAYOUT_SCALE = 8;

/**
 * The language of every text box is PINNED. The bundled fonts have localised glyph forms (locl) for Turkish,
 * Azerbaijani, Kazakh, Tatar, Crimean Tatar, Serbian, Marshallese ...: a browser applies them from the
 * element's language (or, without one, from its own UI language) and the PDF writer never does. "en" selects
 * no localised form in any bundled font. Never take a language from pasted content or from the page.
 */
export const TEXT_LANG = "en";

/** Every bundled family is registered under this prefix, so that an installed font can never win. */
export const CSS_FAMILY_PREFIX = "PDF ";

const FAMILIES = new Map([...TEXT_FONTS, ...SIGNATURE_FONTS].map((font) => [font.id, font]));
const STYLE_SUFFIX = /-(regular|bold|italic|bold-italic)$/;

/**
 * The CSS face of a bundled font: { fontFamily, fontWeight, fontStyle, category }, or null for an unknown key.
 * `fontFamily` is the bare family name ("PDF Arimo"). The values equal the manifest's cssFamily / weight /
 * italic (a test proves it), so a module that has no manifest at hand can still name the face.
 */
export function cssFaceOf(key) {
  const match = STYLE_SUFFIX.exec(String(key));
  if (!match) return null;
  const family = FAMILIES.get(String(key).slice(0, match.index));
  if (!family) return null;
  return {
    fontFamily: `${CSS_FAMILY_PREFIX}${family.family}`,
    fontWeight: match[1].startsWith("bold") ? 700 : 400,
    fontStyle: match[1].endsWith("italic") ? "italic" : "normal",
    category: family.category || "cursive"
  };
}

/** The face that writes what the box face lacks (same weight and slant), or null when there is none. */
export function fallbackFaceKey(textObject) {
  const key = fontKeyOf(FALLBACK_TEXT_FONT, Boolean(textObject.bold), Boolean(textObject.italic));
  return key === fontKey(textObject) ? null : key;
}

const quote = (family) => `"${family}"`;

/**
 * The font-family list of a text box: the box face, the fallback face, then the generic family of the box
 * font. Characters no bundled face has are drawn by whatever the system offers behind the generic family
 * (and the box is then exported as a picture).
 */
export function fontStack(textObject) {
  const primary = cssFaceOf(fontKey(textObject));
  if (!primary) return "sans-serif";
  const fallbackKey = fallbackFaceKey(textObject);
  const fallback = fallbackKey ? cssFaceOf(fallbackKey) : null;
  const families = [quote(primary.fontFamily)];
  if (fallback && fallback.fontFamily !== primary.fontFamily) families.push(quote(fallback.fontFamily));
  families.push(primary.category);
  return families.join(", ");
}

/**
 * What makes the browser lay text out the way the PDF library writes it (one glyph per character with its
 * plain advance), with every inherited text property pinned so that the page around a box cannot change its
 * layout. Keys are React style names; the object also works with Object.assign(element.style, ...).
 */
export const TEXT_BOX_STYLE = Object.freeze({
  display: "block",
  boxSizing: "content-box",
  margin: "0px",
  padding: "0px",
  border: "0px none",
  minWidth: "0px",
  maxWidth: "none",
  // off on both sides: kerning, ligatures, contextual forms, fractions (engine/textRules.js)
  fontKerning: "none",
  fontVariantLigatures: "none",
  fontFeatureSettings: TEXT_FONT_FEATURE_SETTINGS,
  fontSynthesis: "none",
  fontOpticalSizing: "none",
  fontSizeAdjust: "none",
  fontVariantNumeric: "normal",
  fontVariantCaps: "normal",
  fontVariantPosition: "normal",
  fontVariantAlternates: "normal",
  fontVariantEastAsian: "normal",
  fontVariantEmoji: "normal",
  fontVariationSettings: "normal",
  fontLanguageOverride: "normal",
  fontPalette: "normal",
  fontStretch: "normal",
  letterSpacing: "0px",
  wordSpacing: "0px",
  textIndent: "0px",
  textTransform: "none",
  textDecoration: "none",
  textShadow: "none",
  textEmphasisStyle: "none",
  textRendering: "geometricPrecision",
  textSizeAdjust: "none",
  WebkitTextSizeAdjust: "none",
  hyphens: "none",
  overflowWrap: "break-word",
  wordBreak: "normal",
  lineBreak: "auto",
  textWrapStyle: "auto",
  textAlignLast: "auto",
  textJustify: "auto",
  textAutospace: "no-autospace",
  hangingPunctuation: "none",
  tabSize: "4",
  direction: "ltr",
  unicodeBidi: "normal",
  writingMode: "horizontal-tb",
  textOrientation: "mixed",
  textCombineUpright: "none",
  verticalAlign: "baseline"
});

/** Attributes every text box element carries (the pinned language and direction). */
export const TEXT_BOX_ATTRIBUTES = Object.freeze({ lang: TEXT_LANG, dir: "ltr", translate: "no" });

const px = (points) => `${points * LAYOUT_SCALE}px`;
const LINE_FEED = String.fromCharCode(0x0a);

/**
 * The characters an element holds to show a text: the text itself, plus one line feed when the text ends
 * with one (a browser gives the last line feed of a block no line of its own: the empty last line needs a
 * second one). This is also what a contenteditable element holds while the caret stands on an empty last
 * line, so the measuring host, the committed box and the editor hold the same characters.
 */
export function boxDomText(text) {
  return text.endsWith(LINE_FEED) ? text + LINE_FEED : text;
}

/**
 * The complete inline style of the element that holds the text of `textObject`, at the layout scale:
 * TEXT_BOX_STYLE plus the face, the size, the explicit line height, the alignment and the width rule
 * (autoWidth: as wide as the longest line and never wrapping; otherwise wrapping at frame.w), and one line
 * as the least height (a box without text still has its line).
 * `width` overrides the width in points.
 */
export function textBoxStyle(textObject, { width } = {}) {
  const face = cssFaceOf(fontKey(textObject));
  const size = quantizeFontSize(textObject.size);
  const auto = Boolean(textObject.autoWidth);
  const fixedWidth = width ?? (auto ? null : textObject.frame?.w ?? 0);
  return {
    ...TEXT_BOX_STYLE,
    fontFamily: fontStack(textObject),
    fontWeight: face ? face.fontWeight : 400,
    fontStyle: face ? face.fontStyle : "normal",
    fontSize: px(size),
    lineHeight: px(size * textObject.lineHeight),
    textAlign: textObject.align,
    whiteSpace: auto ? "pre" : "pre-wrap",
    width: fixedWidth === null ? "max-content" : px(fixedWidth),
    minHeight: px(size * textObject.lineHeight),
    color: textObject.color
  };
}

/** The fields that decide a layout, as one string: the cache key of the layout service and of React memos. */
export function layoutKey(textObject) {
  return JSON.stringify([
    textObject.text,
    fontKey(textObject),
    quantizeFontSize(textObject.size),
    textObject.lineHeight,
    textObject.align,
    Boolean(textObject.autoWidth),
    textObject.autoWidth ? 0 : textObject.frame?.w ?? 0,
    Boolean(textObject.underline)
  ]);
}

/**
 * CSS matrix(...) for an element laid out at the layout scale, from the matrix that geometry.frameToCssMatrix
 * returns for an element of frame.w x frame.h CSS pixels. The translation stays inside the transform:
 * Chrome snaps the left / top of a transformed element to whole pixels.
 */
export function layoutScaleTransform(cssMatrix) {
  const [a, b, c, d, e, f] = cssMatrix;
  return `matrix(${a / LAYOUT_SCALE}, ${b / LAYOUT_SCALE}, ${c / LAYOUT_SCALE}, ${d / LAYOUT_SCALE}, ${e}, ${f})`;
}
