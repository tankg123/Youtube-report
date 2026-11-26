// The two places where text becomes a PICTURE instead of PDF text (browser only).
//
//  1. rasterizeTextBox: a text box that holds characters no bundled font can write as real text (CJK, Thai,
//     Arabic, emoji, a combining mark that survives NFC ...) is exported as a transparent PNG.
//       "svg"     every measured line is typeset again as SVG <text> at the baseline the DOM measured, with
//                 the box's own computed font properties and the bundled faces inside the SVG, and that SVG
//                 is drawn on a canvas: the browser's own shaping, bidi, font fallback and font-synthesis
//                 rules, so the picture is what the screen shows for any script. The normal path.
//       "canvas"  fillText at the positions the DOM measured: the fallback where a browser does not apply
//                 fonts inside an SVG image. A cluster of a script the bundled fonts write (Latin, Greek,
//                 Cyrillic, digits, punctuation, symbols, emoji) is drawn on its own at the place the DOM
//                 gave it: no kerning or ligature can form, and punctuation inside right-to-left text
//                 stays where the paragraph put it. Every contiguous sequence of any OTHER script, which
//                 the faces do not write, is drawn with ONE call at the left edge of the sequence, so
//                 that joining scripts stay shaped. Canvas text cannot switch font synthesis off: what
//                 comes from system fonts is therefore drawn upright also in an italic box, which is
//                 what the screen shows for the many system fonts without an italic face (a system font
//                 that HAS one, such as Arabic in Arial, is the remaining difference of this path).
//     Ink reaches outside the box (Be Vietnam Pro's stacked capitals go 1.2 em above the baseline): the
//     margin starts at one font size on every side and doubles until no ink touches the edge of the canvas;
//     the result is cropped to the ink, so x / y are usually negative.
//  2. renderTypedSignature: a name in a script font, drawn with full shaping (kerning and ligatures ON: that
//     is what makes a script font look like handwriting), cropped to the ink.
import { PdfEditorError, isPdfEditorError } from "../engine/errors.js";
import { fontKey } from "../model/schema.js";
import { facesNeeded, findFont, fontPlan, hasGlyph, isBlankText, isFormatCharacter, needsRunShaping, normalizeText } from "./fontSupport.js";
import { createMeasuringBox, createMeasuringRoot, readBox } from "./textDom.js";
import { LAYOUT_SCALE, TEXT_LANG, textBoxStyle } from "./textStyle.js";

const LINE_FEED = String.fromCharCode(0x0a);
const MAX_BLEED_ROUNDS = 3;
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_AREA = 16e6;
const DEFAULT_PIXELS_PER_POINT = 4;

function failed(reason, cause) {
  return new PdfEditorError("TEXT_RASTER_FAILED", { reason }, { cause });
}

function createCanvas(doc, width, height) {
  const canvas = doc.createElement("canvas");
  // canvas text takes localised glyph forms from the language of the canvas element
  canvas.lang = TEXT_LANG;
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw failed("canvas");
  return { canvas, ctx };
}

/** Bounding box of the non-transparent pixels: { x, y, w, h, touchesEdge } or null. Throws on a tainted canvas. */
function inkBounds(ctx, width, height) {
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4 + 3;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, touchesEdge: x0 === 0 || y0 === 0 || x1 === width - 1 || y1 === height - 1 };
}

function toPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(failed("encode"));
      else blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), (cause) => reject(failed("encode", cause)));
    }, "image/png");
  });
}

// ---------------------------------------------------------------------------------------------------------
// the SVG snapshot

const dataUrls = new WeakMap(); // Uint8Array of a face -> data: URL
function fontDataUrl(bytes) {
  let url = dataUrls.get(bytes);
  if (!url) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    url = `data:font/ttf;base64,${btoa(binary)}`;
    dataUrls.set(bytes, url);
  }
  return url;
}

const faceRule = (source) => `@font-face{font-family:"${source.fontFamily}";font-weight:${source.fontWeight};font-style:${source.fontStyle};src:url("${fontDataUrl(source.bytes)}") format("truetype")}`;

// The image is loaded from a data: URL: a blob: URL taints the canvas in Chrome, and an SVG image cannot
// fetch a font by reference.
async function svgImage(svg) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  return image;
}

// Does this browser apply a font from a data: URL inside an SVG image, and at once? The same words are drawn
// twice, with a monospace and with a serif font behind the bundled one: the two pictures are equal only when
// the bundled face drew them. One probe per face and session; without it a browser that ignores (or loads too
// late) the embedded font would export a picture in a wrong font, silently.
const svgFontProbes = new WeakMap(); // Uint8Array of a face -> Promise<boolean>
function svgAppliesFont(doc, source) {
  let probe = svgFontProbes.get(source.bytes);
  if (!probe) {
    probe = (async () => {
      const draw = async (generic) => {
        const image = await svgImage(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="96"><style><![CDATA[${faceRule(source)}text{font:${source.fontStyle} ${source.fontWeight} 48px "${source.fontFamily}", ${generic}}]]></style><text x="8" y="64">Hxgj Wmi 0123</text></svg>`);
        const { ctx } = createCanvas(doc, 640, 96);
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, 640, 96).data;
      };
      const a = await draw("monospace");
      const b = await draw("serif");
      let ink = 0;
      for (let index = 3; index < a.length; index += 4) {
        if (a[index] !== b[index]) return false;
        if (a[index]) ink += 1;
      }
      return ink > 0;
    })();
    probe.catch(() => svgFontProbes.delete(source.bytes)); // a failed attempt is not remembered
    svgFontProbes.set(source.bytes, probe);
  }
  return probe;
}

const xmlEscape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// XML 1.0 has no U+FFFE / U+FFFF (normalizeText already replaced half surrogate pairs)
const NONCHARACTERS = new RegExp(`[${String.fromCharCode(0xfffe)}${String.fromCharCode(0xffff)}]`, "g");
const xmlText = (value) => xmlEscape(value.replace(NONCHARACTERS, String.fromCharCode(0xfffd)));

// The properties that decide how a line of the box is shaped and drawn.
const SNAPSHOT_PROPERTIES = [
  "font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-kerning", "font-variant-ligatures",
  "font-variant-numeric", "font-variant-caps", "font-variant-position", "font-variant-alternates", "font-variant-east-asian",
  "font-variant-emoji", "font-variation-settings", "font-feature-settings", "font-synthesis", "font-optical-sizing",
  "font-size-adjust", "font-palette", "font-language-override", "letter-spacing", "word-spacing", "text-rendering",
  "text-spacing-trim", "text-autospace", "direction", "unicode-bidi"
];

/** Prepares the SVG route; resolves to draw(bleedPx, k, width, height) -> Promise<{ canvas, ctx }>. */
async function snapshot(scene, sources) {
  const { doc, element, lines, ascent, color } = scene;
  for (const source of sources) {
    if (!(await svgAppliesFont(doc, source))) throw new Error(`fonts inside an SVG image are not applied ("${source.fontFamily}")`);
  }
  const computed = doc.defaultView.getComputedStyle(element);
  const style = SNAPSHOT_PROPERTIES.map((name) => [name, computed.getPropertyValue(name)]).filter(([, value]) => value !== "").map(([name, value]) => `${name}:${value}`).join(";");
  const faces = sources.map(faceRule).join("");
  const body = lines.filter((line) => line.text.trim() !== "").map((line) => `<text x="${line.left}" y="${line.top + ascent}">${xmlText(line.text)}</text>`).join("");
  const rules = scene.underlines.map((rect) => `<rect x="${rect.x * LAYOUT_SCALE}" y="${rect.y * LAYOUT_SCALE}" width="${rect.w * LAYOUT_SCALE}" height="${rect.h * LAYOUT_SCALE}" fill="${color}"/>`).join("");
  return async (bleedPx, k, width, height) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${-bleedPx} ${-bleedPx} ${width / k} ${height / k}">`
      + `<style><![CDATA[${faces}text{${style};fill:${color};white-space:pre;text-anchor:start;dominant-baseline:alphabetic}]]></style>`
      + `<g lang="${TEXT_LANG}" xml:lang="${TEXT_LANG}" xml:space="preserve">${body}</g>${rules}</svg>`;
    const image = await svgImage(svg);
    const { canvas, ctx } = createCanvas(doc, width, height);
    ctx.drawImage(image, 0, 0);
    return { canvas, ctx };
  };
}

// ---------------------------------------------------------------------------------------------------------
// the canvas painter

// A mirrored character (bracket, guillemet ...) is drawn mirrored when it stands in right-to-left text. The
// DOM tells the direction through the positions of the neighbours on the line: the character before it lies
// to its right, or the character after it to its left.
const MIRRORED = /^\p{Bidi_Mirrored}$/u;
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const POP_DIRECTIONAL_FORMATTING = String.fromCharCode(0x202c);
function inRightToLeftText(items, at) {
  const item = items[at];
  const sameLine = (other) => Math.abs(other.top - item.top) < (item.bottom - item.top) / 2;
  for (let index = at - 1; index >= 0 && sameLine(items[index]); index -= 1) {
    if (items[index].text.trim() !== "") {
      if (items[index].left > item.left) return true;
      break;
    }
  }
  for (let index = at + 1; index < items.length && sameLine(items[index]); index += 1) {
    if (items[index].text.trim() !== "") {
      if (item.left > items[index].left) return true;
      break;
    }
  }
  return false;
}

/** Prepares the canvas route; returns draw(bleedPx, k, width, height) -> { canvas, ctx }. */
function painter(scene, plan) {
  const { doc, element, items, ascent, color } = scene;
  const computed = doc.defaultView.getComputedStyle(element);
  const font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
  const uprightFont = `normal ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
  // does a bundled face of the box draw every character of the cluster (a combining mark, say)? Then the
  // box's own slant applies; otherwise a system font draws it, and those are painted upright
  const bundled = (cluster) => {
    for (const char of cluster) {
      if (isFormatCharacter(char)) continue;
      const codePoint = char.codePointAt(0);
      if (!hasGlyph(plan.primary, codePoint) && !(plan.fallback && hasGlyph(plan.fallback, codePoint))) return false;
    }
    return true;
  };
  // the top of the line each cluster stands on (the first box of the line decides, as in the layout)
  const lineTop = new Map();
  let top = null;
  let bottom = null;
  for (const item of items) {
    if (top === null || item.top > top + (bottom - top) / 2) {
      top = item.top;
      bottom = item.bottom;
    }
    lineTop.set(item, top);
  }
  return (bleedPx, k, width, height) => {
    const { canvas, ctx } = createCanvas(doc, width, height);
    ctx.setTransform(k, 0, 0, k, bleedPx * k, bleedPx * k);
    ctx.fillStyle = color;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.direction = "ltr";
    if ("fontKerning" in ctx) ctx.fontKerning = "none";
    ctx.font = font;
    let run = null;
    const flush = () => {
      if (!run) return;
      ctx.font = uprightFont;
      ctx.fillText(run.text, run.left, run.baseline);
      ctx.font = font;
      run = null;
    };
    items.forEach((item, index) => {
      const baseline = lineTop.get(item) + ascent;
      if (!needsRunShaping(item.text)) {
        // a cluster of a script the bundled fonts write: alone, at the place the DOM gave it
        flush();
        if (item.text.trim() === "") return;
        const upright = !bundled(item.text);
        if (upright) ctx.font = uprightFont;
        ctx.fillText(MIRRORED.test(item.text) && inRightToLeftText(items, index) ? RIGHT_TO_LEFT_OVERRIDE + item.text + POP_DIRECTIONAL_FORMATTING : item.text, item.left, baseline);
        if (upright) ctx.font = font;
        return;
      }
      // any other script is collected: one fillText per contiguous sequence, so that the browser shapes it
      if (run && Math.abs(run.baseline - baseline) > 0.5) flush(); // the sequence goes on in the next line
      if (!run) run = { text: "", left: item.left, baseline };
      run.text += item.text;
      run.left = Math.min(run.left, item.left);
    });
    flush();
    for (const rect of scene.underlines) ctx.fillRect(rect.x * LAYOUT_SCALE, rect.y * LAYOUT_SCALE, rect.w * LAYOUT_SCALE, rect.h * LAYOUT_SCALE);
    return { canvas, ctx };
  };
}

// ---------------------------------------------------------------------------------------------------------

/** Clusters grouped into visual lines: [{ text (logical order, spaces included), left, top }]. */
function groupLines(items) {
  const lines = [];
  let current = null;
  for (const item of items) {
    if (current && item.top > current.top + (current.bottom - current.top) / 2) current = null;
    if (!current) {
      current = { text: "", left: item.left, top: item.top, bottom: item.bottom };
      lines.push(current);
    }
    current.text += item.text;
    current.left = Math.min(current.left, item.left);
  }
  return lines;
}

/**
 * The picture of a text box for the export.
 * @param {object} textObject  the text object (model/schema.js)
 * @param {object} layout      its TextLayout from the layout service (metrics and underlines are used)
 * @param {object} options
 * @param {object} options.fonts              the font registry (required)
 * @param {number} [options.pixelsPerPoint]   resolution, default 4 (288 dpi); lowered for very large boxes
 * @param {"auto"|"svg"|"canvas"} [options.method]  "auto": the SVG snapshot, the canvas painter if that fails
 * @param {Document} [options.document]
 * @returns {Promise<{ png: Uint8Array, x: number, y: number, w: number, h: number,
 *                     method: string, pixelsPerPoint: number, clipped: boolean, snapshotError: string | null }>}
 *   x / y / w / h in box-local points (origin top-left of the box, y down): where the picture goes. The
 *   picture holds the text in the object's colour at full opacity, and its underline; opacity is the
 *   exporter's business. A box without ink gives a 1 x 1 transparent picture.
 * Throws TEXT_FONT_NOT_LOADED when a face of the box is not loaded, TEXT_RASTER_FAILED { reason } when no
 * picture could be made ("svg": that method was demanded and failed, "canvas", "encode").
 */
export async function rasterizeTextBox(textObject, layout, { pixelsPerPoint = DEFAULT_PIXELS_PER_POINT, fonts, method = "auto", document: doc = globalThis.document } = {}) {
  if (!fonts) throw new TypeError("rasterizeTextBox needs the font registry");
  const key = fontKey(textObject);
  const manifest = fonts.manifest;
  if (!manifest) throw new PdfEditorError("TEXT_FONT_NOT_LOADED", { font: key });
  for (const face of facesNeeded(manifest, key, textObject.text)) {
    if (!fonts.isLoaded(face)) throw new PdfEditorError("TEXT_FONT_NOT_LOADED", { font: face });
  }
  const plan = fontPlan(manifest, key);
  const K = LAYOUT_SCALE;
  const wanted = Number.isFinite(pixelsPerPoint) && pixelsPerPoint > 0 ? pixelsPerPoint : DEFAULT_PIXELS_PER_POINT;
  const root = createMeasuringRoot(doc);
  try {
    const box = createMeasuringBox(doc, root);
    box.setStyle(textBoxStyle(textObject));
    box.setText(textObject.text);
    const measured = readBox(doc, box, textObject.text);
    const scene = {
      doc,
      element: box.element,
      items: measured.graphemes,
      lines: groupLines(measured.graphemes),
      ascent: layout.metrics.ascent * K,
      color: textObject.color,
      underlines: layout.underlines
    };
    const widthPt = measured.width / K;
    const heightPt = measured.height / K;

    // every bundled face of the box's font list that is registered travels inside the SVG
    const sources = [];
    for (const faceKey of [plan.primaryKey, plan.fallbackKey]) {
      if (!faceKey || !fonts.isLoaded(faceKey)) continue;
      const record = await fonts.ensureFont(faceKey);
      sources.push({ ...fonts.faceOf(faceKey), bytes: record.bytes });
    }

    let draw = null;
    let used = "svg";
    let snapshotError = null;
    const switchToPainter = (error) => {
      if (method === "svg") throw failed("svg", error);
      snapshotError = `${error?.name}: ${error?.message}`;
      draw = painter(scene, plan);
      used = "canvas";
    };
    if (method === "canvas") {
      draw = painter(scene, plan);
      used = "canvas";
    } else {
      try {
        draw = await snapshot(scene, sources);
      } catch (error) {
        switchToPainter(error);
      }
    }

    let bleedPt = Math.max(4, Math.ceil(textObject.size));
    let round = 1;
    for (;;) {
      const sidePt = Math.max(widthPt, heightPt) + 2 * bleedPt;
      const areaPt = (widthPt + 2 * bleedPt) * (heightPt + 2 * bleedPt);
      const scale = Math.min(wanted, MAX_CANVAS_SIDE / sidePt, Math.sqrt(MAX_CANVAS_AREA / areaPt));
      const width = Math.ceil((widthPt + 2 * bleedPt) * scale);
      const height = Math.ceil((heightPt + 2 * bleedPt) * scale);
      let picture;
      let ink;
      try {
        picture = await draw(bleedPt * K, scale / K, width, height);
        ink = inkBounds(picture.ctx, width, height); // a tainted canvas throws here
      } catch (error) {
        if (used === "canvas") throw isPdfEditorError(error) ? error : failed("canvas", error);
        switchToPainter(error); // the SVG route does not work in this browser after all
        continue;
      }
      if (ink && ink.touchesEdge && round < MAX_BLEED_ROUNDS) {
        bleedPt *= 2;
        round += 1;
        continue;
      }
      if (!ink) {
        const blank = createCanvas(doc, 1, 1);
        return { png: await toPng(blank.canvas), x: 0, y: 0, w: 1 / scale, h: 1 / scale, method: used, pixelsPerPoint: scale, clipped: false, snapshotError };
      }
      // crop to the ink with one pixel of air
      const left = Math.max(0, ink.x - 1);
      const upper = Math.max(0, ink.y - 1);
      const right = Math.min(width, ink.x + ink.w + 1);
      const lower = Math.min(height, ink.y + ink.h + 1);
      const out = createCanvas(doc, right - left, lower - upper);
      out.ctx.drawImage(picture.canvas, left, upper, right - left, lower - upper, 0, 0, right - left, lower - upper);
      return {
        png: await toPng(out.canvas),
        x: left / scale - bleedPt,
        y: upper / scale - bleedPt,
        w: (right - left) / scale,
        h: (lower - upper) / scale,
        method: used,
        pixelsPerPoint: scale,
        clipped: ink.touchesEdge,
        snapshotError
      };
    }
  } finally {
    root.remove();
  }
}

// ---------------------------------------------------------------------------------------------------------
// typed signatures

function drawSignature(doc, text, face, fontSizePx, color) {
  const font = `${face.fontStyle} ${face.fontWeight} ${fontSizePx}px "${face.fontFamily}"`;
  const probe = createCanvas(doc, 1, 1);
  probe.ctx.font = font;
  const metrics = probe.ctx.measureText(text);
  // script fonts overshoot their advance and their em box a lot: the canvas is sized from the ink box of
  // the shaped run with a generous margin (doubled as long as ink still touches the border), then cropped
  for (let safety = Math.ceil(fontSizePx * 0.5); ; safety *= 2) {
    const left = Math.ceil(Math.max(0, metrics.actualBoundingBoxLeft)) + safety;
    const right = Math.ceil(Math.max(metrics.width, metrics.actualBoundingBoxRight)) + safety;
    const ascent = Math.ceil(metrics.actualBoundingBoxAscent) + safety;
    const descent = Math.ceil(metrics.actualBoundingBoxDescent) + safety;
    const work = createCanvas(doc, left + right, ascent + descent);
    work.ctx.font = font;
    work.ctx.fillStyle = color;
    work.ctx.textBaseline = "alphabetic";
    work.ctx.textAlign = "left";
    work.ctx.direction = "ltr";
    work.ctx.fillText(text, left, ascent);
    const ink = inkBounds(work.ctx, work.canvas.width, work.canvas.height);
    if (!ink || !ink.touchesEdge || safety > fontSizePx * 2) return { canvas: work.canvas, ink, baseline: ascent };
  }
}

/**
 * A typed signature as a picture: the text in one of the manifest's script faces, cropped to the ink.
 * @param {object} options
 * @param {string} options.text        the name (normalised here; line breaks become spaces)
 * @param {string} options.font        a signature font: the manifest id ("great-vibes-regular") or the family
 *                                     id of model/schema.js SIGNATURE_FONTS ("great-vibes")
 * @param {string} [options.color]     "#rrggbb", default black
 * @param {number} [options.heightPx]  height of the picture in pixels, default 160: the ink is scaled to it,
 *                                     to within two pixels (its edge rows are partly covered); a text without
 *                                     tall letters is drawn at no more than four times that font size
 * @param {object} options.fonts       the font registry (the face is loaded here if need be)
 * @returns {Promise<{ png: Uint8Array, width: number, height: number, baseline: number } | null>}
 *   pixels; `baseline` = the baseline's distance from the top of the picture. null when the text has no ink.
 */
export async function renderTypedSignature({ text, font, color = "#000000", heightPx = 160, fonts, document: doc = globalThis.document } = {}) {
  if (!fonts) throw new TypeError("renderTypedSignature needs the font registry");
  const manifest = await fonts.loadManifest();
  const key = findFont(manifest, font) ? font : `${font}-regular`;
  if (!findFont(manifest, key)) throw new PdfEditorError("TEXT_FONT_UNKNOWN", { font: String(font) });
  await fonts.ensureFont(key);
  const value = normalizeText(text).replaceAll(LINE_FEED, " ").trim();
  if (isBlankText(value)) return null;
  const face = fonts.faceOf(key);
  const target = Math.max(8, Math.round(heightPx));
  let source = drawSignature(doc, value, face, target, color);
  if (!source.ink) return null;
  // again at the font size that makes the ink as tall as asked for (the fonts are unhinted: ink scales), and
  // once more when whole pixels left it off by more than one
  let size = target;
  for (let pass = 0; pass < 3 && Math.abs(source.ink.h - target) > 1; pass += 1) {
    const next = Math.min((size * target) / source.ink.h, target * 4, (size * MAX_CANVAS_SIDE * 0.8) / source.ink.w);
    if (Math.abs(next - size) < 0.01) break;
    const drawn = drawSignature(doc, value, face, next, color);
    if (!drawn.ink) break;
    source = drawn;
    size = next;
  }
  const ink = source.ink;
  const out = createCanvas(doc, ink.w, ink.h);
  out.ctx.drawImage(source.canvas, ink.x, ink.y, ink.w, ink.h, 0, 0, ink.w, ink.h);
  return { png: await toPng(out.canvas), width: ink.w, height: ink.h, baseline: source.baseline - ink.y };
}
