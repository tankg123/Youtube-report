// The data model of the PDF editor: THE contract between the document store, the page overlay, the text
// layout service and the export engine. Pure data and pure helpers: no DOM, no PDF library, no user texts.
//
// Units and coordinates are defined in ../engine/geometry.js: positions in the page's PDF user space,
// sizes in points, a `frame` { x, y, w, h, rot } for every box-shaped object.
//
// -----------------------------------------------------------------------------------------------------------
// Document
//
//   DocumentState = {
//     fileName: string,                       // download name without the extension
//     sources:  { [sourceId]: Source },       // the PDF files that pages come from (bytes live outside the state)
//     pages:    Page[],                       // the working document, in order
//     objects:  { [objectId]: EditorObject }, // everything the user added, by id
//     assets:   { [assetId]: Asset }          // images used by objects (bytes live outside the state)
//   }
//
//   Source = { id, name, byteLength, pageCount, encrypted: boolean, signatureCount: number,
//              info: { title?, author?, subject?, keywords?, creator?, producer? } }
//     The bytes and the password of a source are kept by the store in a side table (never in history snapshots).
//     signatureCount = signatures that EXIST in the file (the viewer's facts.signatureCount; when the viewer
//     cannot tell, the number of signature fields).
//
//   Page = {
//     id: string,
//     kind: "pdf" | "blank",
//     sourceId: string | null,                // kind "pdf": the source file ...
//     sourceIndex: number | null,             // ... and the 0-based page index in it
//     view: [x0, y0, x1, y1],                 // visible rectangle in user space (pdf.js page.view); blank: [0, 0, w, h]
//     baseRotation: 0 | 90 | 180 | 270,       // the page's own /Rotate (blank: 0)
//     userUnit: number,                       // /UserUnit (blank: 1)
//     rotation: 0 | 90 | 180 | 270,           // rotation added by the user, clockwise
//     objectIds: string[]                     // objects on this page, bottom -> top (marks are listed here too)
//   }
//
//   Asset = { id, mime: "image/png" | "image/jpeg", width, height, byteLength }   // pixels; bytes in the side table
//
// -----------------------------------------------------------------------------------------------------------
// Objects (EditorObject). Every object has { id, type, pageId }. Colours are "#rrggbb" (lower case).
//
//   text        { frame, text, font, size, bold, italic, underline, color, align, lineHeight, opacity, autoWidth,
//                 replaces? }
//                 text        lines separated by "\n" (one style per box), in the canonical form of
//                             text/fontSupport.js normalizeText(): NFC, no tabs (four spaces), no control or idle
//                             invisible characters. The store applies it to every text that enters the state.
//                 font        family id of TEXT_FONTS ("arimo", ...); fontKey(object) names the face
//                 size        font size in points; lineHeight = multiple of the size
//                 autoWidth   true: the box is as wide as its longest line (no wrapping); false: text wraps at frame.w
//                 frame.w / frame.h always equal the laid-out size (kept in sync by the store through the text
//                 measurer); with autoWidth the anchor follows `align` (left: top-left, center: top-centre, ...)
//                 replaces    only for a line of the document that was replaced ("Edit text"):
//                             { rect: [x0, y0, x1, y1] (user space, the original line), cover: "#rrggbb" | null,
//                               sourceText: string }
//                             On export the original glyphs inside `rect` are erased; `cover` is the background
//                             colour painted over them on screen and, when erasing fails, in the file.
//   image       { frame, assetId, role: "image" | "signature", opacity }
//   rect        { frame, stroke, strokeWidth, dash, fill, opacity }            stroke / fill: colour or null
//   ellipse     { frame, stroke, strokeWidth, dash, fill, opacity }
//   line        { p1: [x, y], p2: [x, y], stroke, strokeWidth, dash, headStart, headEnd, opacity }
//                 end points in user space; an "arrow" is a line with headEnd = true
//   pen         { frame, points: [[u, v], ...], color, width, opacity }
//                 freehand stroke; points are fractions (0..1) of the frame box, v downwards; width in points.
//                 Screen and export draw a Catmull-Rom spline THROUGH the points (engine/export/shapes.js
//                 smoothPath): producers keep the samples about 1 pt apart (model/transform.js STROKE_SPACING)
//                 and never thin a stroke down to its corners (the spline would swing off the drawn path).
//                 The same holds for the points of a "stroke" highlight.
//   highlight   { mode: "text", quads: [[x1, y1, x2, y2, x3, y3, x4, y4], ...], color }
//                 marked document text: one quad per line box, corners top-left, top-right, bottom-right,
//                 bottom-left as read, in user space
//               { mode: "stroke", frame, points: [[u, v], ...], thickness, color }
//                 freehand highlighter; thickness in points
//               Highlights are painted with the Multiply blend mode (HIGHLIGHT_OPACITY is the screen fallback).
//   redact      { rect: [x0, y0, x1, y1], color }
//                 everything of the ORIGINAL page under the rectangle is removed on export, then the box is
//                 painted in `color`
//   blur        { rect: [x0, y0, x1, y1], style: "pixelate" | "blur", strength: 1 | 2 | 3, seed }
//                 the original text under the rectangle is removed and an unreadable mosaic is put there.
//                 seed: 32 hex digits (createSeed()), given by the store to every blur mark that enters the
//                 document without one and kept through undo and redo. It fixes the noise and the grid of
//                 the mosaic, so that every export of this mark shows the same mosaic. A copy of a mark
//                 (duplicate, paste) gets a seed of its own, because the same noise over other content can
//                 be subtracted; only the marks of a duplicated page keep theirs (same content, same
//                 picture). It lives in the document model only (never in a file).
//
// Marks (redact, blur) act on the original page content only: they are drawn BELOW every other object,
// never rotate and are not part of the arrange (z-order) commands.

import { frameBounds, normalizeRect, unionRects } from "../engine/geometry.js";

export const OBJECT_TYPES = Object.freeze(["text", "image", "rect", "ellipse", "line", "pen", "highlight", "redact", "blur"]);
export const MARK_TYPES = Object.freeze(["redact", "blur"]);
export const DASH_STYLES = Object.freeze(["solid", "dashed", "dotted"]);
export const TEXT_ALIGNMENTS = Object.freeze(["left", "center", "right"]);
export const BLUR_STYLES = Object.freeze(["pixelate", "blur"]);

/** Font families for text boxes: ids of public/pdf-fonts/manifest.json without the style suffix. */
export const TEXT_FONTS = Object.freeze([
  Object.freeze({ id: "arimo", family: "Arimo", category: "sans-serif" }),
  Object.freeze({ id: "tinos", family: "Tinos", category: "serif" }),
  Object.freeze({ id: "cousine", family: "Cousine", category: "monospace" }),
  Object.freeze({ id: "be-vietnam-pro", family: "Be Vietnam Pro", category: "sans-serif" })
]);

/** Script fonts for typed signatures (always rasterised to a picture, never embedded as text). */
export const SIGNATURE_FONTS = Object.freeze([
  Object.freeze({ id: "dancing-script", family: "Dancing Script" }),
  Object.freeze({ id: "great-vibes", family: "Great Vibes" }),
  Object.freeze({ id: "allura", family: "Allura" }),
  Object.freeze({ id: "charm", family: "Charm" })
]);

export const DEFAULT_TEXT_FONT = "arimo";
/** The family that supplies glyphs a text box's own font lacks (Greek, Cyrillic, arrows, ...). */
export const FALLBACK_TEXT_FONT = "arimo";

/** The manifest id of a font face: "<family>-regular|bold|italic|bold-italic". */
export function fontKeyOf(font, bold = false, italic = false) {
  const style = bold && italic ? "bold-italic" : bold ? "bold" : italic ? "italic" : "regular";
  return `${font}-${style}`;
}

export const fontKey = (textObject) => fontKeyOf(textObject.font, textObject.bold, textObject.italic);

export const FONT_SIZE_LIMITS = Object.freeze({ min: 4, max: 400 });
export const MIN_OBJECT_SIZE = 8; // points: smallest edge of a box the user can create or resize to
export const HIGHLIGHT_OPACITY = 0.35;
export const STROKE_WIDTH_LIMITS = Object.freeze({ min: 0.25, max: 48 });

/** Defaults of new objects per type (the tool defaults start from these). Colours as "#rrggbb". */
export const OBJECT_DEFAULTS = Object.freeze({
  text: Object.freeze({ font: DEFAULT_TEXT_FONT, size: 12, bold: false, italic: false, underline: false, color: "#000000", align: "left", lineHeight: 1.2, opacity: 1, autoWidth: true }),
  image: Object.freeze({ role: "image", opacity: 1 }),
  rect: Object.freeze({ stroke: "#dc2626", strokeWidth: 2, dash: "solid", fill: null, opacity: 1 }),
  ellipse: Object.freeze({ stroke: "#dc2626", strokeWidth: 2, dash: "solid", fill: null, opacity: 1 }),
  line: Object.freeze({ stroke: "#dc2626", strokeWidth: 2, dash: "solid", headStart: false, headEnd: false, opacity: 1 }),
  pen: Object.freeze({ color: "#dc2626", width: 2, opacity: 1 }),
  highlight: Object.freeze({ color: "#facc15", thickness: 12 }),
  redact: Object.freeze({ color: "#000000" }),
  blur: Object.freeze({ style: "pixelate", strength: 2 })
});

export const isMark = (object) => MARK_TYPES.includes(object?.type);
/** Objects placed by a frame (they can be moved, resized and, except marks, rotated through the frame). */
export const hasFrame = (object) => Boolean(object?.frame);

const HEX_COLOR = /^#[0-9a-f]{6}$/;
export const isColor = (value) => typeof value === "string" && HEX_COLOR.test(value);

/** "#RGB" / "#RRGGBB" in any case -> "#rrggbb"; anything else -> null. */
export function normalizeColor(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  return HEX_COLOR.test(text) ? text : null;
}

/** "#rrggbb" -> [r, g, b] with components 0..1 (PDF colour operands). */
export function colorToRgb(color) {
  const value = normalizeColor(color) || "#000000";
  return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
}

let idCounter = 0;
/** A new id, unique within the tab: "<prefix>_<random><counter>". */
export function createId(prefix = "o") {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${random}${idCounter.toString(36)}`;
}

/** The shape of the `seed` of a blur mark: 32 lower-case hexadecimal digits (128 random bits). */
export const SEED_PATTERN = /^[0-9a-f]{32}$/;

/**
 * A fresh seed for a blur mark, from the platform's cryptographic random source. The seed decides the noise
 * and the grid of the mosaic that replaces the content, so that every export of the same mark gives the SAME
 * mosaic (different mosaics of one content could be averaged to read it back). It stays in the document
 * model and is never written into a file.
 */
export function createSeed() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The geometry { view, rotate, userUnit } of a Page for ../engine/geometry.js. */
export const pageGeometry = (page) => ({ view: page.view, rotate: page.baseRotation, userUnit: page.userUnit || 1 });

/** Bounding box of any object in user space: [x0, y0, x1, y1]. */
export function objectBounds(object, userUnit = 1) {
  if (object.rect) return normalizeRect(object.rect);
  if (object.frame) return frameBounds(object.frame, userUnit);
  if (object.type === "line") {
    const pad = ((object.strokeWidth || 0) / 2) / userUnit;
    const [x0, y0, x1, y1] = normalizeRect([object.p1[0], object.p1[1], object.p2[0], object.p2[1]]);
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  if (object.quads?.length) {
    return unionRects(object.quads.map((quad) => [
      Math.min(quad[0], quad[2], quad[4], quad[6]),
      Math.min(quad[1], quad[3], quad[5], quad[7]),
      Math.max(quad[0], quad[2], quad[4], quad[6]),
      Math.max(quad[1], quad[3], quad[5], quad[7])
    ]));
  }
  return [0, 0, 0, 0];
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const isPoint = (value) => Array.isArray(value) && value.length === 2 && value.every(finite);
const isRect = (value) => Array.isArray(value) && value.length === 4 && value.every(finite);
const isFrame = (frame) => Boolean(frame) && [frame.x, frame.y, frame.w, frame.h, frame.rot].every(finite) && frame.w >= 0 && frame.h >= 0;
const isOpacity = (value) => finite(value) && value >= 0 && value <= 1;
const isPaint = (value) => value === null || isColor(value);
const isPoints = (value) => Array.isArray(value) && value.length > 0 && value.every(isPoint);

/**
 * Structural check of one object. Returns a list of problems (empty = valid); used by the store before
 * anything enters the document and by the tests of every producer of objects.
 */
export function validateObject(object) {
  const problems = [];
  const need = (condition, problem) => {
    if (!condition) problems.push(problem);
  };
  if (!object || typeof object !== "object") return ["not an object"];
  need(typeof object.id === "string" && object.id, "id");
  need(typeof object.pageId === "string" && object.pageId, "pageId");
  need(OBJECT_TYPES.includes(object.type), "type");
  switch (object.type) {
    case "text":
      need(isFrame(object.frame), "frame");
      need(typeof object.text === "string" && object.text === object.text.normalize("NFC"), "text");
      need(TEXT_FONTS.some((font) => font.id === object.font), "font");
      need(finite(object.size) && object.size >= FONT_SIZE_LIMITS.min && object.size <= FONT_SIZE_LIMITS.max, "size");
      need([object.bold, object.italic, object.underline, object.autoWidth].every((flag) => typeof flag === "boolean"), "flags");
      need(isColor(object.color), "color");
      need(TEXT_ALIGNMENTS.includes(object.align), "align");
      need(finite(object.lineHeight) && object.lineHeight >= 0.5 && object.lineHeight <= 5, "lineHeight");
      need(isOpacity(object.opacity), "opacity");
      if (object.replaces !== undefined) {
        need(Boolean(object.replaces) && isRect(object.replaces.rect), "replaces.rect");
        need(Boolean(object.replaces) && isPaint(object.replaces.cover), "replaces.cover");
        need(Boolean(object.replaces) && typeof object.replaces.sourceText === "string", "replaces.sourceText");
      }
      break;
    case "image":
      need(isFrame(object.frame), "frame");
      need(typeof object.assetId === "string" && object.assetId, "assetId");
      need(object.role === "image" || object.role === "signature", "role");
      need(isOpacity(object.opacity), "opacity");
      break;
    case "rect":
    case "ellipse":
      need(isFrame(object.frame), "frame");
      need(isPaint(object.stroke), "stroke");
      need(isPaint(object.fill), "fill");
      need(finite(object.strokeWidth) && object.strokeWidth >= 0, "strokeWidth");
      need(DASH_STYLES.includes(object.dash), "dash");
      need(isOpacity(object.opacity), "opacity");
      break;
    case "line":
      need(isPoint(object.p1) && isPoint(object.p2), "points");
      need(isColor(object.stroke), "stroke");
      need(finite(object.strokeWidth) && object.strokeWidth > 0, "strokeWidth");
      need(DASH_STYLES.includes(object.dash), "dash");
      need(typeof object.headStart === "boolean" && typeof object.headEnd === "boolean", "heads");
      need(isOpacity(object.opacity), "opacity");
      break;
    case "pen":
      need(isFrame(object.frame), "frame");
      need(isPoints(object.points), "points");
      need(isColor(object.color), "color");
      need(finite(object.width) && object.width > 0, "width");
      need(isOpacity(object.opacity), "opacity");
      break;
    case "highlight":
      need(isColor(object.color), "color");
      if (object.mode === "text") {
        need(Array.isArray(object.quads) && object.quads.length > 0 && object.quads.every((quad) => Array.isArray(quad) && quad.length === 8 && quad.every(finite)), "quads");
      } else if (object.mode === "stroke") {
        need(isFrame(object.frame), "frame");
        need(isPoints(object.points), "points");
        need(finite(object.thickness) && object.thickness > 0, "thickness");
      } else {
        problems.push("mode");
      }
      break;
    case "redact":
      need(isRect(object.rect), "rect");
      need(isColor(object.color), "color");
      break;
    case "blur":
      need(isRect(object.rect), "rect");
      need(BLUR_STYLES.includes(object.style), "style");
      need([1, 2, 3].includes(object.strength), "strength");
      need(object.seed === undefined || (typeof object.seed === "string" && SEED_PATTERN.test(object.seed)), "seed");
      break;
    default:
      break;
  }
  return problems;
}

// -----------------------------------------------------------------------------------------------------------
// Text layout (produced by text/, consumed by the store for frame sizes and by the export engine for drawing)
//
//   TextLayout = {
//     width: number, height: number,          // points: the laid-out box (= the frame's w / h)
//     lines: [{                               // EVERY visual line (soft wraps included; an empty line has runs []
//                                             // and width 0)
//       baseline: number,                     // points from the TOP of the box to the baseline
//       x: number, width: number,             // points: start and advance of the line (underline, alignment);
//                                             // spaces hanging at the end of a line are in neither width nor runs
//       runs: [{ text: string, x: number, font: FontKey }],  // real text; a run = one font face. Write every run
//                                             // at (run.x, line.baseline): never chain runs by their advances
//       text?: string, start?: number, end?: number          // the visible text of the line and its UTF-16 offsets
//     }],
//     raster: null | { png: Uint8Array, x, y, w, h },         // the picture of the whole box INCLUDING its underline,
//                                                             // in local points (may exceed the box), for a text
//                                                             // that cannot be written as real text (glyphs no
//                                                             // bundled font has)
//     problems: string[],                     // codes: "TEXT_RASTERIZED", "TEXT_BASELINE_UNCERTAIN"
//     underline?: null | { offset, thickness },   // points: from a baseline DOWN to the top edge of the bar, and
//                                             // the bar's height (the bar the browser drew; the export uses it)
//     underlines?: [{ x, y, w, h }],          // the same bars as rectangles in box-local points (screen)
//     fonts?: FontKey[],                      // the faces the runs use
//     metrics?: { ascent, textHeight, lineHeight }
//   }
//   Layouts are frozen (copy with text/layoutCore.js withRaster). A box flagged "TEXT_RASTERIZED" has runs []
//   in every line. The synchronous service.layout() of text/ returns such a box with raster NULL (enough for
//   the screen and for frame sizes); only service.layoutForExport() fills `raster`. An export job must be
//   built with layoutForExport: model/exportJob.js refuses a rasterised layout without its picture.
//
// Export job (built by model/exportJob.js from the store, consumed by engine/pipeline). Objects are the model
// objects above; every text object carries its TextLayout in `layout`.
//
//   ExportJob = {
//     sources: [{ id, bytes: Uint8Array, password?: string, expectedPages: number,
//                 info?: { title?, author?, subject?, keywords?, creator?, creationDate?: Date } }],
//                                             // password: "" for an encrypted file the viewer opened without
//                                             // asking (the writer needs the empty user password);
//                                             // info: the document properties as the VIEWER read them (the
//                                             // writer cannot read those of some encrypted files)
//     pages:   [{ source: sourceId, index: number, rotate: 0|90|180|270 } | { blank: [w, h], rotate }],
//                                             // rotate = the rotation the USER added (on top of /Rotate)
//     objects: EditorObject[][],              // per output page, bottom -> top, WITHOUT marks
//     marks:   [{ pageIndex, rect: [x0, y0, x1, y1], mode: "redact" | "pixelate" | "blur" | "erase",
//                 color?: "#rrggbb", strength?: 1 | 2 | 3, seed?: string, cover?: "#rrggbb" | null,
//                 objectId: string }],        // seed: of a blur mark (pixelate / blur), see the blur object
//                                             // "erase" = the original line of a replaced text (object.replaces);
//                                             // per page: redact / blur marks first, then the erase marks
//     assets:  { [assetId]: { bytes: Uint8Array, mime } },
//     info:    { title?, author?, subject?, keywords?, creator? },   // a string wins over the source ("" removes)
//     fileName: string,
//     now?: Date                              // the clock of the export when the caller fixed one
//   }
