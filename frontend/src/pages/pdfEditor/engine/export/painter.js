// The painter of one output document: it owns what the objects of ALL pages share (each font face embedded
// once, each image asset embedded once), draws the objects of a page onto its canvas and collects the
// warnings of drawing.
//
//   const painter = createPainter(pdfDoc, { fonts, assets });
//   await painter.prepare(objectsPerPage);          // checks every object, loads fonts and images (async)
//   painter.drawPage(page, index, objects, underlays);   // synchronous; underlays first, then bottom -> top
//
// Fonts are embedded as subsets with the features of ../textRules.js switched off (one glyph per character,
// plain advances: what the text layout measured in the browser). The library writes a subset ONCE, at the
// first flush of the document: everything must be drawn before that, which is why the export pipeline
// flushes a single time, at the very end. Characters that share a glyph in a face extract as the LOWEST of
// the code points that were drawn with that face in the document (one glyph has one /ToUnicode entry).
import { fontkit, pdfLib } from "../lib.js";
import { PdfEditorError, warning } from "../errors.js";
import { pdfFontFeatures, normalizeTextForm } from "../textRules.js";
import { normalizeRect, rectsIntersect } from "../geometry.js";
import { colorToRgb, isColor, objectBounds } from "../../model/schema.js";
import { N, arrayOf, dictOf, nameOf, numberOf } from "./pdfUtil.js";
import { PageCanvas, missingCharacters } from "./draw.js";
import { jpegOrientation, sniffImage } from "./imageInfo.js";
import { checkObject, drawObject, primaryFontKey, textLayoutOf } from "./objects.js";
import { pageGeometry } from "./pageGeometry.js";
import { underlineBar } from "./shapes.js";

const { PDFArray } = pdfLib;

/** Six capital letters from the face and the characters drawn with it: the tag of a subset font name. */
function subsetTag(fontKey, codePoints) {
  let hash = 0x811c9dc5;
  const mix = (value) => {
    for (let shift = 0; shift < 24; shift += 8) {
      hash ^= (value >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const char of fontKey) mix(char.charCodeAt(0));
  for (const codePoint of [...codePoints].sort((a, b) => a - b)) mix(codePoint);
  let tag = "";
  for (let index = 0; index < 6; index += 1) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26);
  }
  return tag;
}

const asBytes = (value) => (value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null);

/** Annotations of a page that a viewer paints: [{ rect, subtype }] (links and pop-ups have nothing to show). */
function paintedAnnotations(page) {
  const { context } = page.node;
  const out = [];
  const annots = arrayOf(context, page.node.get(N("Annots")));
  for (const entry of annots ? annots.asArray() : []) {
    const dict = dictOf(context, entry);
    if (!dict) continue;
    const subtype = nameOf(context, dict.get(N("Subtype"))) ?? "";
    if (subtype === "Link" || subtype === "Popup") continue;
    const flags = numberOf(context, dict.get(N("F"))) ?? 0;
    if (flags & 2 || flags & 32) continue; // Hidden, NoView
    const rect = arrayOf(context, dict.get(N("Rect")));
    if (!(rect instanceof PDFArray) || rect.size() !== 4) continue;
    const numbers = rect.asArray().map((value) => numberOf(context, value));
    if (numbers.some((value) => !Number.isFinite(value))) continue;
    const box = normalizeRect(numbers);
    if (box[2] - box[0] > 0 && box[3] - box[1] > 0) out.push({ rect: box, subtype });
  }
  return out;
}

/**
 * @param {object} pdfDoc  the output PDFDocument (nothing of it may have been flushed yet)
 * @param {{ fonts?: (fontKey: string) => Promise<Uint8Array>, assets?: Record<string, { bytes: Uint8Array, mime?: string }>,
 *           warnings?: object[] }} [options]  warnings: the list that receives { code, params }
 */
export function createPainter(pdfDoc, { fonts: loadFont, assets = {}, warnings = [] } = {}) {
  pdfDoc.registerFontkit(fontkit);
  const embedded = new Map(); // fontKey -> PDFFont
  const metrics = new Map(); // fontKey -> { unitsPerEm, underlinePosition, underlineThickness }
  const images = new Map(); // assetId -> { image, orientation }
  const rasters = new Map(); // PNG bytes of a rasterised text -> PDFImage
  const canvases = new Map(); // PDFPage -> PageCanvas
  const stats = { objects: 0, underlays: 0 };

  async function fontBytes(fontKey) {
    let bytes;
    try {
      bytes = asBytes(typeof loadFont === "function" ? await loadFont(fontKey) : null);
    } catch (cause) {
      throw new PdfEditorError("EXPORT_FONT_UNAVAILABLE", { fontKey }, { cause, detail: "the font loader failed" });
    }
    if (!bytes || bytes.length === 0) throw new PdfEditorError("EXPORT_FONT_UNAVAILABLE", { fontKey }, { detail: "the font loader returned no bytes" });
    return bytes;
  }

  const metricsOf = (font) => ({ unitsPerEm: font.unitsPerEm, underlinePosition: font.underlinePosition, underlineThickness: font.underlineThickness });

  async function embedFont(fontKey, codePoints) {
    if (embedded.has(fontKey)) return;
    const bytes = await fontBytes(fontKey);
    try {
      const probe = await fontkit.create(bytes);
      const customName = `${subsetTag(fontKey, codePoints)}+${probe.postscriptName || "Font"}`;
      // a fresh features object per call: fontkit writes into it
      const font = await pdfDoc.embedFont(bytes, { subset: true, features: pdfFontFeatures(), customName });
      // Two characters may share ONE glyph of a face (U+002D and U+00AD in Arimo, Tinos and Cousine, U+0020
      // and U+00A0 in Tinos and Cousine). The font engine remembers the character that asked for a glyph
      // FIRST, and /ToUnicode is written from that: after a soft hyphen every hyphen of the face would be
      // lost for search and copy. The characters are asked for in a fixed order, lowest code point first, so
      // that a hyphen stays a hyphen and a space a space whatever was typed before them.
      for (const codePoint of [...codePoints].sort((a, b) => a - b)) font.embedder.font.glyphForCodePoint(codePoint);
      embedded.set(fontKey, font);
      metrics.set(fontKey, metricsOf(font.embedder.font));
    } catch (cause) {
      throw new PdfEditorError("EXPORT_FONT_UNAVAILABLE", { fontKey }, { cause, detail: "the bytes are not a font the library can embed" });
    }
  }

  async function measureFont(fontKey) {
    if (metrics.has(fontKey)) return;
    const bytes = await fontBytes(fontKey);
    try {
      metrics.set(fontKey, metricsOf(await fontkit.create(bytes)));
    } catch (cause) {
      throw new PdfEditorError("EXPORT_FONT_UNAVAILABLE", { fontKey }, { cause, detail: "the bytes are not a font" });
    }
  }

  async function embedPicture(bytes, mime, params) {
    const kind = sniffImage(bytes) || (mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpeg" : null);
    if (!kind) throw new PdfEditorError("EXPORT_IMAGE_INVALID", params, { detail: "neither a PNG nor a JPEG" });
    try {
      const image = kind === "png" ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      return { image, orientation: kind === "jpeg" ? jpegOrientation(bytes) : 1 };
    } catch (cause) {
      throw new PdfEditorError("EXPORT_IMAGE_INVALID", params, { cause, detail: `the ${kind} cannot be embedded` });
    }
  }

  /**
   * Checks every object and loads what they need. Call it once, with the objects of all pages, before the
   * first drawPage(). Throws the EXPORT_ codes of codes.js.
   * @param {object[][]} objectsPerPage
   */
  async function prepare(objectsPerPage) {
    const faces = new Map(); // fontKey -> Set of code points drawn with it
    const measured = new Set();
    for (const objects of objectsPerPage) {
      for (const object of objects || []) {
        checkObject(object);
        if (object.type === "text") {
          const layout = textLayoutOf(object);
          if (layout.raster) continue;
          for (const line of layout.lines) {
            for (const run of line.runs) {
              if (!faces.has(run.font)) faces.set(run.font, new Set());
              for (const char of normalizeTextForm(run.text)) faces.get(run.font).add(char.codePointAt(0));
            }
          }
          if (object.underline && !layout.underline) measured.add(primaryFontKey(object));
        }
      }
    }
    for (const [fontKey, codePoints] of faces) await embedFont(fontKey, codePoints);
    for (const fontKey of measured) await measureFont(fontKey);
    for (const objects of objectsPerPage) {
      for (const object of objects || []) {
        if (object.type === "text" && !object.layout.raster) {
          // every character must have a glyph in the face of its run, checked before anything is drawn
          for (const line of object.layout.lines) {
            for (const run of line.runs) {
              const missing = missingCharacters(embedded.get(run.font), run.text, { ignoreLineBreaks: false });
              if (missing.length) throw new PdfEditorError("EXPORT_TEXT_MISSING_GLYPH", { objectId: object.id, fontKey: run.font, characters: missing.join("") });
            }
          }
        }
        if (object.type === "image" && !images.has(object.assetId)) {
          const asset = assets ? assets[object.assetId] : undefined;
          const bytes = asset ? asBytes(asset.bytes) : null;
          if (!bytes) throw new PdfEditorError("EXPORT_ASSET_MISSING", { objectId: object.id, assetId: object.assetId });
          images.set(object.assetId, await embedPicture(bytes, asset.mime, { objectId: object.id, assetId: object.assetId }));
        } else if (object.type === "text" && object.layout.raster && !rasters.has(object.layout.raster.png)) {
          const picture = await embedPicture(object.layout.raster.png, "image/png", { objectId: object.id, assetId: null });
          rasters.set(object.layout.raster.png, picture.image);
        }
      }
    }
  }

  const envFor = (userUnit) => ({
    userUnit,
    font: (fontKey) => {
      const font = embedded.get(fontKey);
      if (!font) throw new PdfEditorError("EXPORT_FONT_UNAVAILABLE", { fontKey }, { detail: "the font was not prepared" });
      return font;
    },
    image: (object) => {
      const picture = images.get(object.assetId);
      if (!picture) throw new PdfEditorError("EXPORT_ASSET_MISSING", { objectId: object.id, assetId: object.assetId });
      return picture;
    },
    raster: (object) => {
      const image = rasters.get(object.layout.raster.png);
      if (!image) throw new PdfEditorError("EXPORT_IMAGE_INVALID", { objectId: object.id, assetId: null }, { detail: "the picture of the text was not prepared" });
      return image;
    },
    underline: (object) => {
      // the text layout may say where the browser put the line; otherwise the font's own metrics decide
      const given = object.layout.underline;
      if (given && Number.isFinite(given.offset) && given.thickness > 0) return { offset: given.offset, thickness: given.thickness };
      const fontMetrics = metrics.get(primaryFontKey(object));
      if (!fontMetrics) throw new PdfEditorError("EXPORT_FONT_UNAVAILABLE", { fontKey: primaryFontKey(object) }, { detail: "the font was not prepared" });
      return underlineBar(fontMetrics, object.size);
    }
  });

  /** The canvas of a page (one per page: its resource names are kept, its content isolated once). */
  function canvasFor(page, pageIndex) {
    let canvas = canvases.get(page);
    if (!canvas) {
      canvas = new PageCanvas(page);
      canvases.set(page, canvas);
      if (canvas.isolation && canvas.isolation.unreadable) warnings.push(warning("EXPORT_PAGE_CONTENT_UNREADABLE", { page: pageIndex }));
    }
    return canvas;
  }

  /**
   * Draws on one page: first the underlays (plain filled rectangles in user space: the covers of replaced
   * text lines), then the objects from bottom to top.
   * @param {object} page  PDFPage of the document
   * @param {number} pageIndex  0-based index in the output (for warnings)
   * @param {object[]} [objects]
   * @param {Array<{ rect: number[], color: string }>} [underlays]
   */
  function drawPage(page, pageIndex, objects = [], underlays = []) {
    if (!objects.length && !underlays.length) return;
    for (const underlay of underlays) {
      const rect = underlay && underlay.rect;
      if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite) || !isColor(underlay.color)) {
        throw new PdfEditorError("EXPORT_JOB_INVALID", { reason: "shape", page: pageIndex, source: null }, { detail: "an underlay needs rect [x0, y0, x1, y1] and color #rrggbb" });
      }
    }
    const canvas = canvasFor(page, pageIndex);
    const geometry = pageGeometry(page);
    for (const underlay of underlays) {
      const [x0, y0, x1, y1] = normalizeRect(underlay.rect);
      canvas.rect(x0, y0, x1 - x0, y1 - y0, { fill: colorToRgb(underlay.color) });
      stats.underlays += 1;
    }
    const env = envFor(geometry.userUnit);
    const annotations = objects.length ? paintedAnnotations(page) : [];
    for (const object of objects) {
      drawObject(canvas, object, env);
      stats.objects += 1;
      if (annotations.length) {
        const bounds = objectBounds(object, geometry.userUnit);
        const above = annotations.find((annotation) => rectsIntersect(bounds, annotation.rect));
        if (above) warnings.push(warning("EXPORT_OBJECT_BELOW_ANNOTATION", { page: pageIndex, objectId: object.id, subtype: above.subtype }));
      }
    }
    canvas.flush();
  }

  return {
    prepare,
    drawPage,
    canvasFor,
    warnings,
    /** FontKeys embedded so far, in the order of first use. */
    get fontsEmbedded() {
      return [...embedded.keys()];
    },
    get imagesEmbedded() {
      return images.size + rasters.size;
    },
    get stats() {
      return { ...stats };
    }
  };
}
