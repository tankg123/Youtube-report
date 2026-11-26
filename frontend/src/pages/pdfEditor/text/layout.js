// The text layout service (browser): the browser lays a text box out at the layout scale in a hidden host,
// and what it did is read back as a TextLayout (model/schema.js). That layout is the single truth for the
// size of the box (frame.w / frame.h), for the committed text on screen and for the PDF.
//
// Rules the service enforces:
//   * nothing is measured before every face the text needs is loaded (TEXT_FONT_NOT_LOADED): a measurement
//     with a fallback face would look plausible and be wrong
//   * results are cached by the fields that decide a layout and by the device pixel ratio (browsers round
//     font metrics to device pixels); every cache is emptied when a face finishes loading
//   * the host is styled by textStyle.js alone, exactly as TextBox.jsx and TextEditor.jsx style what they show
import { PdfEditorError } from "../engine/errors.js";
import { TEXT_ALIGNMENTS, fontKey } from "../model/schema.js";
import { TEXT_RASTERIZED } from "./codes.js";
import { checkText, facesNeeded, fontPlan } from "./fontSupport.js";
import { buildTextLayout, withRaster } from "./layoutCore.js";
import { rasterizeTextBox } from "./raster.js";
import { createMeasuringBox, createMeasuringRoot, measureFace, pixelRatioOf, readBox } from "./textDom.js";
import { LAYOUT_SCALE, cssFaceOf, layoutKey, textBoxStyle } from "./textStyle.js";
import { quantizeFontSize } from "../engine/textRules.js";

const CACHE_LIMIT = 600;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function invalid(problem) {
  return new PdfEditorError("TEXT_OBJECT_INVALID", { problem });
}

/** Throws TEXT_OBJECT_INVALID / TEXT_FONT_UNKNOWN for something the layout cannot work with. */
function checkObject(textObject) {
  if (!textObject || typeof textObject !== "object") throw invalid("object");
  if (typeof textObject.text !== "string") throw invalid("text");
  if (!cssFaceOf(fontKey(textObject))) throw new PdfEditorError("TEXT_FONT_UNKNOWN", { font: fontKey(textObject) });
  if (!finite(textObject.size) || textObject.size <= 0) throw invalid("size");
  if (!finite(textObject.lineHeight) || textObject.lineHeight <= 0) throw invalid("lineHeight");
  if (!TEXT_ALIGNMENTS.includes(textObject.align)) throw invalid("align");
  if (!textObject.autoWidth && !(finite(textObject.frame?.w) && textObject.frame.w >= 0)) throw invalid("frame");
}

/**
 * @param {object} options
 * @param {object} options.fonts     the font registry (fonts.js)
 * @param {Document} [options.document]
 * @returns {{
 *   fonts: object,
 *   ensureFonts(textObject: object, options?: { fallback?: boolean }): Promise<string[]>,
 *   isReady(textObject: object): boolean,
 *   layout(textObject: object): object,
 *   measure(textObject: object): { w: number, h: number },
 *   check(textObject: object): object | null,
 *   layoutForExport(textObject: object, options?: { pixelsPerPoint?: number }): Promise<object>,
 *   dispose(): void
 * }}
 */
export function createTextLayoutService({ fonts, document: doc = globalThis.document } = {}) {
  if (!fonts) throw new TypeError("createTextLayoutService needs the font registry");
  let root = null;
  let box = null;
  const layouts = new Map(); // key -> TextLayout, in order of use
  const faceMetrics = new Map(); // "<fontKey>|<px>|<ratio>" -> { ascent, textHeight }
  const firstTops = new Map(); // style key -> top of the text box on the first line
  let unsubscribe = null;
  const forget = () => {
    layouts.clear();
    faceMetrics.clear();
    firstTops.clear();
  };

  function host() {
    // listening starts with the first measurement, and again when a disposed service is used once more (an
    // effect that React.StrictMode ran twice): nothing is ever cached without a listener that empties it
    if (!unsubscribe) unsubscribe = fonts.subscribe(forget);
    if (!root || !root.isConnected) {
      root = createMeasuringRoot(doc);
      box = createMeasuringBox(doc, root);
    }
    return box;
  }

  /** The manifest, or TEXT_FONT_NOT_LOADED when a face this text needs is not registered yet. */
  function requireFaces(textObject) {
    const key = fontKey(textObject);
    const manifest = fonts.manifest;
    if (!manifest) throw new PdfEditorError("TEXT_FONT_NOT_LOADED", { font: key });
    for (const face of facesNeeded(manifest, key, textObject.text)) {
      if (!fonts.isLoaded(face)) throw new PdfEditorError("TEXT_FONT_NOT_LOADED", { font: face });
    }
    return manifest;
  }

  function metricsOf(textObject, ratio) {
    const key = fontKey(textObject);
    const fontSizePx = quantizeFontSize(textObject.size) * LAYOUT_SCALE;
    const id = `${key}|${fontSizePx}|${ratio}`;
    let metrics = faceMetrics.get(id);
    if (!metrics) {
      host();
      metrics = measureFace(doc, root, fonts.faceOf(key), fontSizePx);
      faceMetrics.set(id, metrics);
    }
    return metrics;
  }

  function measureText(textObject, ratio) {
    const target = host();
    const style = textBoxStyle(textObject);
    target.setStyle(style);
    target.setText(textObject.text);
    const measured = readBox(doc, target, textObject.text);
    const { ascent, textHeight } = metricsOf(textObject, ratio);
    let firstTop = measured.graphemes.length > 0 ? measured.graphemes[0].top : null;
    if (firstTop === null) {
      // no cluster has a box (an empty text, or line feeds only): read where a first line would stand
      const id = `${fontKey(textObject)}|${style.fontSize}|${style.lineHeight}|${ratio}`;
      firstTop = firstTops.get(id);
      if (firstTop === undefined) {
        target.setText("Hx");
        firstTop = readBox(doc, target, "Hx").graphemes[0]?.top ?? 0;
        target.setText(textObject.text);
        firstTops.set(id, firstTop);
      }
    }
    return { ...measured, ascent, textHeight, firstTop };
  }

  /**
   * The TextLayout of a text object (synchronous, cached, frozen). Throws TEXT_FONT_NOT_LOADED when a face
   * the text needs is not loaded: await ensureFonts(textObject) first, or try again after fonts.subscribe()
   * reports a load. `textObject.text` must be normalizeText() output.
   */
  function layout(textObject) {
    checkObject(textObject);
    const manifest = requireFaces(textObject);
    const ratio = pixelRatioOf(doc);
    const key = `${ratio}|${layoutKey(textObject)}`;
    const cached = layouts.get(key);
    if (cached) {
      layouts.delete(key);
      layouts.set(key, cached);
      return cached;
    }
    const result = buildTextLayout(textObject, measureText(textObject, ratio), manifest);
    layouts.set(key, result);
    if (layouts.size > CACHE_LIMIT) layouts.delete(layouts.keys().next().value);
    return result;
  }

  /**
   * Loads what the text needs: the manifest, the box face, and the fallback face when a character asks for
   * it (`fallback: true` loads it in any case, e.g. when editing starts). Resolves to the face keys. Only
   * `font`, `bold`, `italic` and `text` of the object are looked at. Rejects with the registry's error
   * (TEXT_FONT_FETCH_FAILED, TEXT_FONT_CORRUPT, TEXT_FONT_MANIFEST_FAILED) when a download fails.
   */
  async function ensureFonts(textObject, { fallback = false } = {}) {
    if (!textObject || typeof textObject.text !== "string") throw invalid("text");
    if (!cssFaceOf(fontKey(textObject))) throw new PdfEditorError("TEXT_FONT_UNKNOWN", { font: fontKey(textObject) });
    const manifest = await fonts.loadManifest();
    const key = fontKey(textObject);
    const keys = new Set(facesNeeded(manifest, key, textObject.text));
    if (fallback) {
      const fallbackKey = fontPlan(manifest, key).fallbackKey;
      if (fallbackKey) keys.add(fallbackKey);
    }
    await fonts.ensureFonts([...keys]);
    return [...keys];
  }

  /** True when layout(textObject) would not have to wait for a font. */
  function isReady(textObject) {
    const manifest = fonts.manifest;
    if (!manifest || !textObject || typeof textObject.text !== "string" || !cssFaceOf(fontKey(textObject))) return false;
    return facesNeeded(manifest, fontKey(textObject), textObject.text).every((face) => fonts.isLoaded(face));
  }

  return {
    fonts,
    ensureFonts,
    isReady,
    layout,
    /** The laid-out size in points: what frame.w / frame.h of the object have to be. */
    measure(textObject) {
      const { width, height } = layout(textObject);
      return { w: width, h: height };
    },
    /** fontSupport.checkText for the object ({ ok, fallback, unsupported }), or null before the manifest is loaded. */
    check(textObject) {
      return fonts.manifest ? checkText(fonts.manifest, fontKey(textObject), textObject.text) : null;
    },
    /**
     * The layout for an export job: loads the fonts, lays the text out and, when the box must become a picture
     * (TEXT_RASTERIZED), makes that picture and returns a layout whose `raster` is { png, x, y, w, h }.
     */
    async layoutForExport(textObject, { pixelsPerPoint } = {}) {
      await ensureFonts(textObject);
      const result = layout(textObject);
      if (!result.problems.includes(TEXT_RASTERIZED)) return result;
      const raster = await rasterizeTextBox(textObject, result, { pixelsPerPoint, fonts, document: doc });
      return withRaster(result, { png: raster.png, x: raster.x, y: raster.y, w: raster.w, h: raster.h });
    },
    /**
     * Removes the hidden host, stops listening to the registry and forgets every cached measurement. The
     * service stays usable: the next layout() builds a new host.
     */
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      forget();
      root?.remove();
      root = null;
      box = null;
    }
  };
}
