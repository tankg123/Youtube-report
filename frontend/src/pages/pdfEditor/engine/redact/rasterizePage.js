// The raster path (the fallback): a page becomes a picture of itself with the target regions burned in, plus
// an invisible text layer for the text that is not in a target. Whatever the precise path could not prove
// (a scan, outlined text, content it does not understand) is simply not in the output any more: only pixels
// are, and the pixels under a mark are the box or the mosaic.
//
//   renderPageBitmap(page, pdfjs, createCanvas, { dpi, maxPixels, annotations })   -> { canvas, ctx, viewport, dpi }
//   burnRegions(render, regions, { random, sideways })                               paints / pixelates / blurs (a mosaic is
//                                                                                    made of region.source, shown in region.rect)
//   imageXObjectFromCanvas(pdfDoc, canvas, { format, quality, encodeJpeg })          -> { ref, format, byteLength }
//   imageXObjectFromRgba(pdfDoc, imageData)                                          -> lossless image XObject
//   makeTtfLayerFont(pdfDoc, ttfBytes)                                               -> layer font from a TrueType file
//   buildTextLayer(glyphs, rects, layerFont, options)                                -> { content, stats }
//   solidMarksContent(burned)                                                        the boxes again, as vectors
//   replacePageWithPicture(pdfDoc, pageIndex, { imageRef, view, marks, layer, layerFont })
//
// Geometry: the page object is KEPT (links that point to it stay valid) and so are /MediaBox, /CropBox,
// /Rotate and /UserUnit. The picture is a render of the visible box (pdf.js `page.view`: the CropBox clipped
// to the MediaBox) at rotation 0, i.e. in the orientation of user space, and it is drawn into exactly that box:
//     q (x1-x0) 0 0 (y1-y0) x0 y0 cm /RPage Do Q
// so the page looks the same in every viewer, and coordinates in user space (the targets, the text layer, the
// objects the editor draws afterwards) mean the same as before. Content outside the CropBox is dropped.
//
// What a rasterised page loses: its annotations (links, notes, form widgets are in the picture, they are no
// longer objects), its place in the structure tree, text the layer font cannot encode, and sharpness beyond
// the chosen resolution (200 dpi by default; the text layer keeps search and copy working).
import { pdfLib } from "../lib.js";
import { pdfFontFeatures } from "../textRules.js";
import { normRect, glyphInTargets, GLYPH_RULE } from "./pdfAccess.js";
import { formatNumber, concatBytes } from "./contentStream.js";
import { cropRegion, obscureRegion } from "./blur.js";
import { regionFlatness } from "./verifyRedaction.js";

const { PDFName, PDFNumber, PDFRawStream } = pdfLib;
const N = (s) => PDFName.of(s);

export const RASTER_DEFAULTS = Object.freeze({
  dpi: 200,
  /** canvas area limit: 16.7 million pixels is what the most restrictive browsers (iOS Safari) allow */
  maxPixels: 16_000_000,
  /** "auto": lossless when that costs at most autoRatio times the JPEG (text pages), JPEG otherwise (photos) */
  format: "auto",
  autoRatio: 1.5,
  jpegQuality: 0.85,
  fill: Object.freeze([0, 0, 0])
});

/**
 * Renders a page for the fallback. rotation 0 = orientation of user space. The dpi is physical: pdf.js
 * multiplies the scale by /UserUnit, so a UserUnit 2 page gets twice the pixels per unit.
 * The dpi is lowered when the picture would exceed maxPixels.
 */
export async function renderPageBitmap(page, pdfjs, createCanvas, { dpi = RASTER_DEFAULTS.dpi, maxPixels = RASTER_DEFAULTS.maxPixels, annotations = true, background = "#ffffff" } = {}) {
  let scale = dpi / 72;
  let viewport = page.getViewport({ scale, rotation: 0 });
  if (viewport.width * viewport.height > maxPixels) {
    scale *= Math.sqrt(maxPixels / (viewport.width * viewport.height));
    viewport = page.getViewport({ scale, rotation: 0 });
  }
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  await page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    background,
    annotationMode: annotations ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE
  }).promise;
  return { canvas, ctx, viewport, dpi: scale * 72, width, height };
}

/** Pixel rectangle [x, y, w, h] of a user-space rect, grown to whole pixels. */
export function rectToPixels(viewport, rect, width, height, grow = 0) {
  const r = normRect(rect);
  const [ax, ay] = viewport.convertToViewportPoint(r[0], r[1]);
  const [bx, by] = viewport.convertToViewportPoint(r[2], r[3]);
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx)) - grow);
  const y0 = Math.max(0, Math.floor(Math.min(ay, by)) - grow);
  const x1 = Math.min(width, Math.ceil(Math.max(ax, bx)) + grow);
  const y1 = Math.min(height, Math.ceil(Math.max(ay, by)) + grow);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

/**
 * Burns the regions into the bitmap.
 *   regions  [{ rect, mode: "redact" | "pixelate" | "blur" | "erase", color: [r, g, b] | null, strength,
 *               random?: the noise source of this region alone (a mark with a seed), emPt?: the largest font
 *               size of the text under it, in points, source?: the rectangle a mosaic is MADE of (the mark
 *               grown to the glyphs it takes; default: rect). Only the pixels of rect are changed }]
 *   options  { random, sideways } as for obscureRegion() in blur.js
 * Order: the colours of the "erase" regions are sampled from the untouched picture, then the mosaics are
 * made (they read pixels), then the erase regions are filled, then the solid boxes are painted: where
 * regions overlap, the box wins.
 *   erase    the line of a replaced text on a page that became a picture: its pixels are painted over with
 *            `color` (the cover colour the editor shows) or, without one, with the dominant colour of the
 *            region, i.e. the paper around the glyphs
 *   redact   boxes are grown by one pixel so that no anti-aliased rim of the covered content is left
 * Returns one entry per region that was burned: { rect, mode, pixels: [x, y, w, h], color? }.
 */
export function burnRegions(render, regions, { random, sideways = false } = {}) {
  const { ctx, viewport, width, height } = render;
  const done = [];
  const eraseFills = new Map();
  for (const region of regions) {
    if (region.mode !== "erase") continue;
    const [x, y, w, h] = rectToPixels(viewport, region.rect, width, height, 0);
    if (!w || !h) continue;
    let color = region.color;
    if (!color) color = regionFlatness(ctx.getImageData(x, y, w, h).data, w, h, 0).dominant ?? [255, 255, 255];
    eraseFills.set(region, { pixels: [x, y, w, h], color });
  }
  for (const region of regions) {
    if (region.mode !== "pixelate" && region.mode !== "blur") continue;
    const [x, y, w, h] = rectToPixels(viewport, region.rect, width, height, 0);
    if (!w || !h) continue;
    let [sx, sy, sw, sh] = region.source ? rectToPixels(viewport, region.source, width, height, 0) : [x, y, w, h];
    if (x < sx || y < sy || x + w > sx + sw || y + h > sy + sh) [sx, sy, sw, sh] = [x, y, w, h];
    const img = ctx.getImageData(sx, sy, sw, sh);
    const info = obscureRegion(img, 0, 0, sw, sh, { style: region.mode, pxPerPt: render.dpi / 72, strength: region.strength ?? 1, random: region.random ?? random, sideways, emPt: region.emPt ?? 0 });
    const part = ctx.getImageData(x, y, w, h);
    part.data.set(cropRegion(img, x - sx, y - sy, w, h).data);
    ctx.putImageData(part, x, y);
    done.push({ rect: region.rect, mode: region.mode, pixels: [x, y, w, h], ...info });
  }
  for (const [region, fill] of eraseFills) {
    const [x, y, w, h] = fill.pixels;
    ctx.fillStyle = `rgb(${fill.color[0]},${fill.color[1]},${fill.color[2]})`;
    ctx.fillRect(x, y, w, h);
    done.push({ rect: region.rect, mode: "erase", pixels: fill.pixels, color: fill.color });
  }
  for (const region of regions) {
    if (region.mode !== "redact") continue;
    const [x, y, w, h] = rectToPixels(viewport, region.rect, width, height, 1);
    if (!w || !h) continue;
    const c = region.color ?? RASTER_DEFAULTS.fill;
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(x, y, w, h);
    done.push({ rect: region.rect, mode: "redact", pixels: [x, y, w, h], color: c });
  }
  return done;
}

/**
 * RGB samples with the PNG "Up" predictor (filter type 2 on every row): /FlateDecode with
 * /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns w >> decodes them. Lossless.
 */
export function predictRgbRows(rgba, width, height) {
  const stride = width * 3;
  const out = new Uint8Array((stride + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    out[o++] = 2; // Up
    let p = y * width * 4;
    let up = (y - 1) * width * 4;
    for (let x = 0; x < width; x++, p += 4, up += 4) {
      if (y === 0) {
        out[o++] = rgba[p];
        out[o++] = rgba[p + 1];
        out[o++] = rgba[p + 2];
      } else {
        out[o++] = (rgba[p] - rgba[up]) & 0xff;
        out[o++] = (rgba[p + 1] - rgba[up + 1]) & 0xff;
        out[o++] = (rgba[p + 2] - rgba[up + 2]) & 0xff;
      }
    }
  }
  return out;
}

function imageDict(context, width, height) {
  const dict = context.obj({});
  dict.set(N("Type"), N("XObject"));
  dict.set(N("Subtype"), N("Image"));
  dict.set(N("Width"), PDFNumber.of(width));
  dict.set(N("Height"), PDFNumber.of(height));
  dict.set(N("BitsPerComponent"), PDFNumber.of(8));
  dict.set(N("ColorSpace"), N("DeviceRGB"));
  return dict;
}

/** Unregistered lossless image stream (FlateDecode + PNG Up predictor) from RGBA pixels. */
function flateImageStream(context, image) {
  const { data, width: w, height: h } = image;
  const stream = context.flateStream(predictRgbRows(data, w, h));
  for (const [key, value] of imageDict(context, w, h).entries()) stream.dict.set(key, value);
  const parms = context.obj({});
  parms.set(N("Predictor"), PDFNumber.of(15));
  parms.set(N("Colors"), PDFNumber.of(3));
  parms.set(N("BitsPerComponent"), PDFNumber.of(8));
  parms.set(N("Columns"), PDFNumber.of(w));
  stream.dict.set(N("DecodeParms"), parms);
  return stream;
}

/** Unregistered JPEG image stream, or null when the platform gave no JPEG bytes. */
async function jpegImageStream(context, canvas, quality, encodeJpeg) {
  const encoded = await encodeJpeg(canvas, quality);
  if (!encoded || !encoded.length) return null;
  const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
  // SOI marker: anything else is not a JPEG (a canvas that cannot encode one answers with a PNG)
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const dict = imageDict(context, canvas.width, canvas.height);
  dict.set(N("Filter"), N("DCTDecode"));
  return PDFRawStream.of(dict, bytes);
}

/**
 * Turns a canvas into an image XObject of pdfDoc and returns its reference.
 *   format   "jpeg":  DCTDecode, bytes from encodeJpeg(canvas, quality) -> Uint8Array | Promise<Uint8Array>
 *                     (browser: convertToBlob / toBlob; Node: canvas.toBuffer("image/jpeg", q))
 *            "flate": lossless RGB, FlateDecode with the PNG Up predictor (no encoder needed)
 *            "auto":  both are encoded; the lossless one is kept when it is at most `autoRatio` times as large
 *                     as the JPEG (measured: 1.2-1.4 x on text pages, 4-7 x on photo pages), else the JPEG
 * Without encodeJpeg, or when it returns nothing usable, the picture is stored lossless.
 * Returns { ref, width, height, format: "jpeg" | "flate", byteLength, alternativeBytes? }.
 */
export async function imageXObjectFromCanvas(pdfDoc, canvas, { format = RASTER_DEFAULTS.format, quality = RASTER_DEFAULTS.jpegQuality, autoRatio = RASTER_DEFAULTS.autoRatio, encodeJpeg } = {}) {
  if (format !== "auto" && format !== "jpeg" && format !== "flate") throw new RangeError(`unknown image format ${format}`);
  const context = pdfDoc.context;
  const { width, height } = canvas;
  const jpeg = format !== "flate" && typeof encodeJpeg === "function" ? await jpegImageStream(context, canvas, quality, encodeJpeg) : null;
  const flate = format !== "jpeg" || !jpeg ? flateImageStream(context, canvas.getContext("2d").getImageData(0, 0, width, height)) : null;
  let keep = jpeg || flate;
  if (jpeg && flate) keep = flate.getContentsSize() <= autoRatio * jpeg.getContentsSize() ? flate : jpeg;
  const result = { ref: context.register(keep), width, height, format: keep === jpeg ? "jpeg" : "flate", byteLength: keep.getContentsSize() };
  if (jpeg && flate) result.alternativeBytes = (keep === jpeg ? flate : jpeg).getContentsSize();
  return result;
}

/** Lossless image XObject (FlateDecode + PNG Up predictor) from RGBA pixels { data, width, height }. */
export function imageXObjectFromRgba(pdfDoc, image) {
  const stream = flateImageStream(pdfDoc.context, image);
  return { ref: pdfDoc.context.register(stream), width: image.width, height: image.height, format: "flate", byteLength: stream.getContentsSize() };
}

// ---------------------------------------------------------------- text layer
/**
 * Layer font from a TrueType file, embedded (as a subset) with the document's library.
 * The document needs a registered fontkit: pdfDoc.registerFontkit(fontkit).
 * A layer font is { ref, canEncode(ch), encode(text) -> "<hex>", width(text) -> advance in em }.
 * It must be made before the document is flushed for the last time, and nothing may be encoded with it
 * afterwards (the library writes a subset once).
 */
export async function makeTtfLayerFont(pdfDoc, ttfBytes) {
  const font = await pdfDoc.embedFont(ttfBytes, { subset: true, features: pdfFontFeatures() });
  const charset = new Set(font.getCharacterSet());
  return {
    ref: font.ref,
    name: font.name,
    canEncode: (ch) => charset.has(ch.codePointAt(0)),
    encode: (text) => font.encodeText(text).toString(),
    width: (text) => font.widthOfTextAtSize(text, 1)
  };
}

const num = (v) => formatNumber(v, 4);

/**
 * Builds the invisible text layer from the glyphs of the ORIGINAL page (pdfjsGlyphs.pageGlyphs).
 *
 * Glyphs in a target are left out. The others are grouped into fragments: consecutive glyphs of one font
 * and size on one baseline without a gap; a fragment ends after a space (the space is its last character),
 * so words keep their exact place.
 * Each fragment is written with its own text matrix at the origin of its first glyph and stretched (Tz) to
 * the measured width, in rendering mode 3 (neither filled nor stroked: invisible, but selectable / searchable).
 * Characters the layer font cannot encode end a fragment and are counted in stats.unencodable.
 *
 * options: { thresholds (GLYPH_RULE.remove), includeAnnotationText (false), fontKey ("RLayer"),
 *            forceItemBreaks (true): alternate the font size by 0.01 % between
 *            fragments that came from different fonts, so that pdf.js splits its text items where it did before }
 * stats: { glyphs, dropped (in a target), unencodable (the layer font has no glyph), vertical (vertical writing
 *          is not rebuilt), annotationGlyphs, fragments, characters }
 */
export function buildTextLayer(glyphs, rects, layerFont, options = {}) {
  const thresholds = { ...GLYPH_RULE.remove, ...(options.thresholds || {}) };
  const fontKey = options.fontKey ?? "RLayer";
  const forceItemBreaks = options.forceItemBreaks !== false;
  const targets = rects.map(normRect);
  const stats = { glyphs: glyphs.length, dropped: 0, unencodable: 0, vertical: 0, annotationGlyphs: 0, fragments: 0, characters: 0 };
  const fragments = [];
  let cur = null;
  let prevDropped = false;
  const close = () => {
    if (cur && cur.text.trim()) fragments.push(cur);
    cur = null;
  };
  for (const g of glyphs) {
    if (g.inAnnotation && !options.includeAnnotationText) {
      // text of annotation appearances (form field values, free-text notes) is in the picture, but it was not
      // page text before; by default it does not become page text now
      stats.annotationGlyphs++;
      close();
      continue;
    }
    const inTarget = (targets.length > 0 && glyphInTargets(g.quad, g.core, targets, thresholds).hit) || (g.zeroWidth && prevDropped);
    prevDropped = inTarget;
    if (inTarget) {
      stats.dropped++;
      close();
      continue;
    }
    if (g.vertical) {
      stats.vertical++;
      close();
      continue;
    }
    const text = g.unicode;
    if (!text) {
      close();
      continue;
    }
    if (/^\s+$/u.test(text)) {
      // a space glyph ends the word. It is written as one space at the end of the fragment (when the layer font
      // has one and the glyph follows the word directly): pdf.js treats a space glyph and a bare gap of the
      // same width differently when it cuts a line into items, and the layer should cut like the original.
      if (cur && layerFont.canEncode(" ")) {
        const gap = Math.hypot(g.origin[0] - cur.end[0], g.origin[1] - cur.end[1]);
        const sizeY = Math.hypot(cur.axisY[0], cur.axisY[1]);
        if (g.fontName === cur.fontName && gap <= 0.12 * sizeY) {
          cur.text += " ";
          cur.end = [g.origin[0] + (g.quad[2] - g.quad[0]), g.origin[1] + (g.quad[3] - g.quad[1])];
        }
      }
      close();
      continue;
    }
    if ([...text].some((ch) => ch.codePointAt(0) < 0x20 || !layerFont.canEncode(ch))) {
      stats.unencodable++;
      close();
      continue;
    }
    const sizeY = Math.hypot(g.axisY[0], g.axisY[1]);
    const sizeX = Math.hypot(g.axisX[0], g.axisX[1]);
    if (!(sizeY > 0.01) || !(sizeX > 0.001)) {
      close();
      continue;
    }
    const end = [g.origin[0] + (g.quad[2] - g.quad[0]), g.origin[1] + (g.quad[3] - g.quad[1])];
    if (cur) {
      // same font, same axes, and this glyph starts where the previous one ended?
      const gap = Math.hypot(g.origin[0] - cur.end[0], g.origin[1] - cur.end[1]);
      const sameAxes = Math.abs(g.axisX[0] - cur.axisX[0]) + Math.abs(g.axisX[1] - cur.axisX[1]) + Math.abs(g.axisY[0] - cur.axisY[0]) + Math.abs(g.axisY[1] - cur.axisY[1]) < 1e-3 * sizeY;
      if (g.fontName !== cur.fontName || !sameAxes || gap > 0.12 * sizeY) close();
    }
    if (!cur) cur = { text: "", origin: g.origin, axisX: g.axisX, axisY: g.axisY, fontName: g.fontName, end };
    cur.text += text;
    cur.end = end;
  }
  close();

  const lines = ["q", "3 Tr"];
  let flip = false;
  let lastFont = null;
  for (const f of fragments) {
    const text = f.text;
    const sizeY = Math.hypot(f.axisY[0], f.axisY[1]);
    const sizeX = Math.hypot(f.axisX[0], f.axisX[1]);
    // width of the fragment along the baseline, in user space
    const dx = f.end[0] - f.origin[0];
    const dy = f.end[1] - f.origin[1];
    const width = (dx * f.axisX[0] + dy * f.axisX[1]) / sizeX;
    const natural = layerFont.width(text) * sizeX;
    if (!(natural > 0) || !(width > 0)) continue;
    const tz = Math.min(1000, Math.max(1, (width / natural) * 100));
    if (forceItemBreaks && lastFont !== null && lastFont !== f.fontName) flip = !flip;
    lastFont = f.fontName;
    const size = sizeY * (flip ? 1.0001 : 1);
    lines.push(
      `BT /${fontKey} ${num(size)} Tf ${num(tz)} Tz ${num(f.axisX[0] / sizeY)} ${num(f.axisX[1] / sizeY)} ${num(f.axisY[0] / sizeY)} ${num(f.axisY[1] / sizeY)} ${num(f.origin[0])} ${num(f.origin[1])} Tm ${layerFont.encode(text)} Tj ET`
    );
    stats.fragments++;
    stats.characters += [...text].length;
  }
  lines.push("Q");
  return { content: stats.fragments ? `${lines.join("\n")}\n` : "", stats };
}

/**
 * The solid marks of a rasterised page once more, as vector rectangles over the picture: the covers of erased
 * lines, then the redaction boxes (the order of burnRegions). The picture already holds them, so nothing is
 * hidden by this; it makes the boxes exactly flat. A JPEG rings for a few pixels on both sides of a hard edge,
 * also INSIDE a box where two marks meet, and a box that is not one colour is neither what the user asked
 * for nor something the final verification could tell from a failed burn.
 *   burned   the result of burnRegions()
 */
export function solidMarksContent(burned) {
  const lines = [];
  for (const mode of ["erase", "redact"]) {
    for (const mark of burned) {
      if (mark.mode !== mode || !mark.color) continue;
      const [x0, y0, x1, y1] = normRect(mark.rect);
      const c = mark.color.map((v) => formatNumber(v / 255, 3));
      lines.push(`q ${c[0]} ${c[1]} ${c[2]} rg ${formatNumber(x0, 3)} ${formatNumber(y0, 3)} ${formatNumber(x1 - x0, 3)} ${formatNumber(y1 - y0, 3)} re f Q`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * Replaces the content of a page by a picture (+ solid marks + text layer). The page dictionary stays the
 * same object.
 *   imageRef   reference of the image XObject
 *   view       [x0, y0, x1, y1]: the box the picture was rendered from (pdf.js page.view)
 *   marks      content drawn over the picture, in user space (solidMarksContent())
 *   layer      content of the text layer ("" for none), layerFont: the font it uses
 * The caller removes the annotations, the page extras and the page's place in the structure tree
 * (documentScrub.js) and runs collectGarbage afterwards.
 */
export function replacePageWithPicture(pdfDoc, pageIndex, { imageRef, view, marks = "", layer = "", layerFont = null, fontKey = "RLayer" }) {
  const context = pdfDoc.context;
  const pageNode = pdfDoc.getPage(pageIndex).node;
  const [x0, y0, x1, y1] = view;
  const head = `q ${num(x1 - x0)} 0 0 ${num(y1 - y0)} ${num(x0)} ${num(y0)} cm /RPage Do Q\n`;
  const content = context.flateStream(concatBytes([head, marks, layer]));
  const resources = context.obj({});
  const xobjects = context.obj({});
  xobjects.set(N("RPage"), imageRef);
  resources.set(N("XObject"), xobjects);
  if (layer && layerFont) {
    const fonts = context.obj({});
    fonts.set(N(fontKey), layerFont.ref);
    resources.set(N("Font"), fonts);
  }
  pageNode.set(N("Contents"), context.register(content));
  pageNode.set(N("Resources"), resources);
  return { contentBytes: head.length + marks.length + layer.length };
}
