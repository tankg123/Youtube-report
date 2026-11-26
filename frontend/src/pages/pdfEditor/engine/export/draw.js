// PageCanvas: the drawing layer of the export. Everything the editor's objects need, emitted as
// content-stream operators through page.pushOperators().
//
// Why not page.drawText() / drawImage() / drawRectangle() of the library? Each call registers a NEW resource
// name on the page (20 drawText calls = 20 /Font entries, 20 translucent shapes = 20 /ExtGState
// dictionaries), there is no arbitrary matrix, no line join, no polygon, no group opacity. A canvas that
// keeps ONE resource name per font / image / graphics state and works in a local frame does all of it.
//
// Rules the canvas enforces:
//   - the existing content of the page is isolated first (content.js isolatePageContent), so a drawing starts
//     from the default graphics state whatever the page did before; a page whose resource dictionary is
//     unparsed raw bytes is made writable before that (content.js ensureWritableResources);
//   - text is NFC and every character must have a glyph in its font: the canvas throws
//     EXPORT_TEXT_MISSING_GLYPH instead of writing .notdef (an embedded font would draw an empty box, a
//     standard font a "?", both silently);
//   - numbers are written with at most five decimals.
// Nothing may be drawn after the document was flushed or saved once: the library writes the subset of a font
// a single time (see ../textRules.js).
import { pdfLib } from "../lib.js";
import { PdfEditorError } from "../errors.js";
import { normalizeTextForm } from "../textRules.js";
import { ensureWritableResources, isolatePageContent } from "./content.js";
import { KAPPA, ellipsePath, smoothPath } from "./shapes.js";

const { PDFOperator, PDFOperatorNames: Ops, PDFNumber, PDFName } = pdfLib;

const num = (value) => PDFNumber.of(Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : 0);
const fine = (value) => PDFNumber.of(Number.isFinite(value) ? Math.round(value * 1e8) / 1e8 : 0); // matrix entries
const op = (name, args = []) => PDFOperator.of(name, args);

const pushState = () => op(Ops.PushGraphicsState);
const popState = () => op(Ops.PopGraphicsState);
const concat = (matrix) => op(Ops.ConcatTransformationMatrix, [fine(matrix[0]), fine(matrix[1]), fine(matrix[2]), fine(matrix[3]), num(matrix[4]), num(matrix[5])]);
const moveTo = (x, y) => op(Ops.MoveTo, [num(x), num(y)]);
const lineTo = (x, y) => op(Ops.LineTo, [num(x), num(y)]);
const curveTo = (x1, y1, x2, y2, x, y) => op(Ops.AppendBezierCurve, [num(x1), num(y1), num(x2), num(y2), num(x), num(y)]);
const closePath = () => op(Ops.ClosePath);
const rectangle = (x, y, width, height) => op(Ops.AppendRectangle, [num(x), num(y), num(width), num(height)]);
const rgbFill = ([r, g, b]) => op(Ops.NonStrokingColorRgb, [num(r), num(g), num(b)]);
const rgbStroke = ([r, g, b]) => op(Ops.StrokingColorRgb, [num(r), num(g), num(b)]);
const applyState = (name) => op(Ops.SetGraphicsStateParams, [name]);
const paintXObject = (name) => op(Ops.DrawObject, [name]);

const CAPS = { butt: 0, round: 1, square: 2 };
const JOINS = { miter: 0, round: 1, bevel: 2 };
const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * @typedef {object} Style
 * @property {number[]} [fill]          [r, g, b] 0..1
 * @property {number[]} [stroke]        [r, g, b] 0..1
 * @property {number} [lineWidth]       default 1
 * @property {"butt"|"round"|"square"} [lineCap]
 * @property {"miter"|"round"|"bevel"} [lineJoin]
 * @property {number[]} [dash]          dash pattern, e.g. [6, 3]
 * @property {number} [dashPhase]
 * @property {number} [fillOpacity]     0..1
 * @property {number} [strokeOpacity]   0..1
 * @property {string} [blendMode]       "Multiply", "Darken", ... (PDF blend mode name)
 * @property {boolean} [evenOdd]        fill rule
 */

/** Where a canvas writes: a page, or the Form XObject of a transparency group. */
function pageTarget(page) {
  return {
    push: (operators) => page.pushOperators(...operators),
    font: (tag, ref) => page.node.newFontDictionary(tag, ref),
    xobject: (tag, ref) => page.node.newXObject(tag, ref),
    state: (tag, dict) => page.node.newExtGState(tag, dict)
  };
}

function formTarget(context) {
  const operators = [];
  const categories = { Font: null, XObject: null, ExtGState: null };
  // the tags of a canvas are unique (F1, F2, Im1 ...) and the dictionaries are new: the tag is the name
  const add = (category, tag, value) => {
    if (!categories[category]) categories[category] = context.obj({});
    const name = PDFName.of(tag);
    categories[category].set(name, value);
    return name;
  };
  return {
    operators,
    push: (list) => {
      for (const operator of list) operators.push(operator);
    },
    font: (tag, ref) => add("Font", tag, ref),
    xobject: (tag, ref) => add("XObject", tag, ref),
    state: (tag, dict) => add("ExtGState", tag, dict),
    resources: () => {
      const dict = context.obj({});
      for (const [category, entries] of Object.entries(categories)) if (entries) dict.set(PDFName.of(category), entries);
      return dict;
    }
  };
}

/** The drawing operations, independent of where they are written. */
export class Canvas {
  constructor(context, target) {
    this.context = context;
    this.target = target;
    this.fontNames = new Map();
    this.imageNames = new Map();
    this.stateNames = new Map();
    this.groups = 0;
    this.pending = [];
  }

  /** Writes the buffered operators into the target. */
  flush() {
    if (this.pending.length) {
      const operators = this.pending;
      this.pending = [];
      this.target.push(operators);
    }
    return this;
  }

  push(...operators) {
    for (const operator of operators) this.pending.push(operator);
    if (this.pending.length > 4096) this.flush();
    return this;
  }

  // ---- resources: ONE name per font / image / graphics state on this target --------------------------
  fontName(font) {
    let name = this.fontNames.get(font);
    if (!name) {
      name = this.target.font(`F${this.fontNames.size + 1}`, font.ref);
      this.fontNames.set(font, name);
    }
    return name;
  }

  imageName(image) {
    let name = this.imageNames.get(image);
    if (!name) {
      name = this.target.xobject(`Im${this.imageNames.size + 1}`, image.ref);
      this.imageNames.set(image, name);
    }
    return name;
  }

  /** ExtGState for opacity / blend mode; undefined when nothing has to change. */
  stateName({ fillOpacity, strokeOpacity, blendMode }) {
    const ca = fillOpacity === undefined ? 1 : clamp01(fillOpacity);
    const CA = strokeOpacity === undefined ? 1 : clamp01(strokeOpacity);
    const bm = blendMode || "Normal";
    if (ca === 1 && CA === 1 && bm === "Normal") return undefined;
    const key = `${ca}|${CA}|${bm}`;
    let name = this.stateNames.get(key);
    if (!name) {
      name = this.target.state(`GS${this.stateNames.size + 1}`, this.context.obj({ Type: "ExtGState", ca, CA, BM: bm }));
      this.stateNames.set(key, name);
    }
    return name;
  }

  // ---- frames and groups -----------------------------------------------------------------------------
  /**
   * Runs `draw` inside `q <matrix> cm ... Q`. `matrix` = [a b c d e f] maps the local frame to user space
   * (../geometry.js frameMatrixUp() gives the frame "points, origin bottom-left, y up" of an editor object).
   */
  frame(matrix, draw) {
    this.push(pushState());
    if (matrix) this.push(concat(matrix));
    draw(this);
    this.push(popState());
    return this;
  }

  /** Rotation about a point of the current frame (degrees, COUNTER-clockwise in the y-up frame). */
  rotated(degreesCcw, cx, cy, draw) {
    const angle = (degreesCcw * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return this.frame([cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy], draw);
  }

  /**
   * Draws `draw(canvas)` as ONE unit: a transparency group (an isolated Form XObject) painted with `opacity`
   * and `blendMode`. Parts that overlap inside the group (a stroke over its fill, a line under its arrow
   * head, an underline under a descender) do not darken each other, exactly like CSS `opacity` on an element.
   * @param {{ bbox: number[], opacity?: number, blendMode?: string }} options  bbox = [x0, y0, x1, y1] in the
   *        current frame; everything outside it is clipped
   */
  group({ bbox, opacity = 1, blendMode }, draw) {
    const target = formTarget(this.context);
    const inner = new Canvas(this.context, target);
    draw(inner);
    inner.flush();
    if (!target.operators.length) return this;
    const form = this.context.formXObject(target.operators, {
      BBox: this.context.obj(bbox.map((value) => Math.round(value * 1e3) / 1e3)),
      Resources: target.resources(),
      Group: this.context.obj({ S: "Transparency", CS: "DeviceRGB", I: true })
    });
    this.groups += 1;
    const name = this.target.xobject(`Fm${this.groups}`, this.context.register(form));
    this.push(pushState());
    const state = this.stateName({ fillOpacity: opacity, strokeOpacity: opacity, blendMode });
    if (state) this.push(applyState(state));
    this.push(paintXObject(name), popState());
    return this;
  }

  // ---- paths -----------------------------------------------------------------------------------------
  applyStyle(style) {
    const state = this.stateName(style);
    if (state) this.push(applyState(state));
    if (style.fill) this.push(rgbFill(style.fill));
    if (style.stroke) {
      this.push(rgbStroke(style.stroke), op(Ops.SetLineWidth, [num(style.lineWidth ?? 1)]));
      if (style.lineCap) this.push(op(Ops.SetLineCapStyle, [num(CAPS[style.lineCap])]));
      if (style.lineJoin) this.push(op(Ops.SetLineJoinStyle, [num(JOINS[style.lineJoin])]));
      if (style.dash && style.dash.length) {
        this.push(op(Ops.SetLineDashPattern, [`[${style.dash.map((value) => num(value).toString()).join(" ")}]`, num(style.dashPhase ?? 0)]));
      }
    }
  }

  paint(style) {
    const hasFill = Boolean(style.fill);
    const hasStroke = Boolean(style.stroke) && (style.lineWidth ?? 1) > 0;
    if (hasFill && hasStroke) this.push(op(style.evenOdd ? Ops.FillEvenOddAndStroke : Ops.FillNonZeroAndStroke));
    else if (hasFill) this.push(op(style.evenOdd ? Ops.FillEvenOdd : Ops.FillNonZero));
    else if (hasStroke) this.push(op(Ops.StrokePath));
    else this.push(op(Ops.EndPath));
  }

  /** A styled path: `build` receives the canvas and calls the path construction helpers below. */
  path(style, build) {
    this.push(pushState());
    this.applyStyle(style);
    build(this);
    this.paint(style);
    this.push(popState());
    return this;
  }

  /** Path construction from a command list of shapes.js: ["M", x, y] | ["L", x, y] | ["C", ...] | ["Z"]. */
  trace(commands) {
    for (const command of commands) {
      if (command[0] === "M") this.push(moveTo(command[1], command[2]));
      else if (command[0] === "L") this.push(lineTo(command[1], command[2]));
      else if (command[0] === "C") this.push(curveTo(command[1], command[2], command[3], command[4], command[5], command[6]));
      else if (command[0] === "Z") this.push(closePath());
    }
    return this;
  }

  rect(x, y, width, height, style) {
    return this.path(style, (canvas) => canvas.push(rectangle(x, y, width, height)));
  }

  /** Rectangle with rounded corners (radius clamped to half of the shorter side). */
  roundRect(x, y, width, height, radius, style) {
    const r = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
    if (r === 0) return this.rect(x, y, width, height, style);
    const k = r * KAPPA;
    const x1 = x + width;
    const y1 = y + height;
    return this.path(style, (canvas) => canvas.push(
      moveTo(x + r, y),
      lineTo(x1 - r, y), curveTo(x1 - r + k, y, x1, y + r - k, x1, y + r),
      lineTo(x1, y1 - r), curveTo(x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1),
      lineTo(x + r, y1), curveTo(x + r - k, y1, x, y1 - r + k, x, y1 - r),
      lineTo(x, y + r), curveTo(x, y + r - k, x + r - k, y, x + r, y),
      closePath()
    ));
  }

  ellipse(cx, cy, rx, ry, style) {
    return this.path(style, (canvas) => canvas.trace(ellipsePath(cx, cy, rx, ry)));
  }

  line(x1, y1, x2, y2, style) {
    return this.path({ ...style, fill: undefined }, (canvas) => canvas.push(moveTo(x1, y1), lineTo(x2, y2)));
  }

  polyline(points, style) {
    if (points.length < 2) return this;
    return this.path({ ...style, fill: undefined }, (canvas) => {
      canvas.push(moveTo(points[0][0], points[0][1]));
      for (let index = 1; index < points.length; index += 1) canvas.push(lineTo(points[index][0], points[index][1]));
    });
  }

  polygon(points, style) {
    if (points.length < 3) return this;
    return this.path(style, (canvas) => {
      canvas.push(moveTo(points[0][0], points[0][1]));
      for (let index = 1; index < points.length; index += 1) canvas.push(lineTo(points[index][0], points[index][1]));
      canvas.push(closePath());
    });
  }

  /**
   * Arrow: a butt-ended shaft that stops at the base of the head (so that a thick line does not stick out of
   * the tip) and a filled triangular head. headLength / headWidth default to multiples of the line width.
   * (The editor's line object is drawn by objects.js with the rules of shapes.js; this is the plain primitive.)
   */
  arrow(x1, y1, x2, y2, style, { headLength, headWidth, both = false } = {}) {
    const width = style.lineWidth ?? 1;
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length === 0) return this;
    const hl = Math.min(headLength ?? Math.max(8, width * 4), both ? length / 2 : length);
    const hw = headWidth ?? Math.max(6, width * 3);
    const ux = (x2 - x1) / length;
    const uy = (y2 - y1) / length;
    const head = (tipX, tipY, dx, dy) => {
      const bx = tipX - dx * hl;
      const by = tipY - dy * hl;
      return [[tipX, tipY], [bx - (dy * hw) / 2, by + (dx * hw) / 2], [bx + (dy * hw) / 2, by - (dx * hw) / 2]];
    };
    const sx = both ? x1 + ux * hl : x1;
    const sy = both ? y1 + uy * hl : y1;
    const color = style.stroke || style.fill || [0, 0, 0];
    this.line(sx, sy, x2 - ux * hl, y2 - uy * hl, { ...style, stroke: color, lineCap: "butt" });
    const headStyle = { fill: color, fillOpacity: style.strokeOpacity ?? style.fillOpacity, blendMode: style.blendMode };
    this.polygon(head(x2, y2, ux, uy), headStyle);
    if (both) this.polygon(head(x1, y1, -ux, -uy), headStyle);
    return this;
  }

  /**
   * Freehand ink: a smooth curve through the sampled points (shapes.js smoothPath), round caps and joins.
   * One point draws a dot.
   */
  ink(points, style) {
    if (points.length === 0) return this;
    if (points.length === 1) {
      const radius = (style.lineWidth ?? 1) / 2;
      return this.ellipse(points[0][0], points[0][1], radius, radius, { fill: style.stroke, fillOpacity: style.strokeOpacity, blendMode: style.blendMode });
    }
    return this.path({ lineCap: "round", lineJoin: "round", ...style, fill: undefined }, (canvas) => canvas.trace(smoothPath(points)));
  }

  // ---- images ----------------------------------------------------------------------------------------
  /**
   * Image in the box (x, y, width, height) of the current frame (y = bottom edge).
   * `matrix` replaces the box: the matrix that maps the unit square of the image into the frame (used for
   * pictures whose stored pixels are turned, see imageInfo.js).
   */
  image(image, x, y, width, height, { opacity, blendMode, matrix } = {}) {
    this.push(pushState());
    const state = this.stateName({ fillOpacity: opacity, strokeOpacity: opacity, blendMode });
    if (state) this.push(applyState(state));
    this.push(concat(matrix || [width, 0, 0, height, x, y]), paintXObject(this.imageName(image)), popState());
    return this;
  }

  // ---- text ------------------------------------------------------------------------------------------
  /**
   * One run of text with its baseline starting at (x, y) of the current frame.
   *
   * @param {string} text  normalised to NFC here (the library maps code points to glyphs one by one and ignores
   *        mark positioning: decomposed Vietnamese would get its marks at the glyphs' default positions)
   * @param {object} o
   * @param {object} o.font                 PDFFont (embedded; a standard font only for ASCII labels of tools)
   * @param {number} o.size
   * @param {number} [o.x] @param {number} [o.y]
   * @param {number[]} [o.color]            fill colour, default black
   * @param {number} [o.opacity]
   * @param {number} [o.characterSpacing]   Tc, in frame units
   * @param {number} [o.wordSpacing]        Tw (only acts on single-byte fonts: useless with embedded TTF)
   * @param {number} [o.horizontalScale]    Tz, percent (100 = normal)
   * @param {number} [o.fitWidth]           computes Tz so that the text spans exactly this width
   * @param {boolean} [o.invisible]         rendering mode 3: selectable, searchable, not painted
   * @param {boolean} [o.underline] @param {boolean} [o.strike]   drawn lines (a PDF font has no such attribute)
   * @param {number[]} [o.stroke] @param {number} [o.strokeWidth]   outlined text (rendering mode 1 / 2)
   * @param {string} [o.objectId] @param {string} [o.fontKey]       only for the parameters of an error
   * @returns {{ width: number, glyphs: number, horizontalScale: number }}
   */
  text(text, o) {
    const value = normalizeTextForm(text);
    const { font, size } = o;
    const x = o.x ?? 0;
    const y = o.y ?? 0;
    const missing = missingCharacters(font, value, { ignoreLineBreaks: false });
    if (missing.length) {
      throw new PdfEditorError("EXPORT_TEXT_MISSING_GLYPH", { objectId: o.objectId ?? null, fontKey: o.fontKey ?? font.name, characters: missing.join("") });
    }
    const encoded = font.encodeText(value);
    const glyphs = font.glyphCountOfText(value);
    const spacing = o.characterSpacing ?? 0;
    const natural = font.widthOfTextAtSize(value, size) + spacing * glyphs;
    let scale = o.horizontalScale ?? 100;
    if (o.fitWidth !== undefined && natural > 0) scale = (o.fitWidth / natural) * 100;
    const width = natural * (scale / 100);

    this.push(pushState());
    const state = this.stateName({ fillOpacity: o.opacity, strokeOpacity: o.opacity });
    if (state) this.push(applyState(state));
    const color = o.color ?? [0, 0, 0];
    this.push(rgbFill(color));
    let mode = 0;
    if (o.invisible) mode = 3;
    else if (o.stroke) {
      mode = o.color === null ? 1 : 2;
      this.push(rgbStroke(o.stroke), op(Ops.SetLineWidth, [num(o.strokeWidth ?? 1)]));
    }
    this.push(op(Ops.BeginText), op(Ops.SetFontAndSize, [this.fontName(font), num(size)]));
    if (mode !== 0) this.push(op(Ops.SetTextRenderingMode, [num(mode)]));
    if (spacing) this.push(op(Ops.SetCharacterSpacing, [num(spacing)]));
    if (o.wordSpacing) this.push(op(Ops.SetWordSpacing, [num(o.wordSpacing)]));
    if (scale !== 100) this.push(op(Ops.SetTextHorizontalScaling, [num(scale)]));
    this.push(op(Ops.SetTextMatrix, [num(1), num(0), num(0), num(1), num(x), num(y)]), op(Ops.ShowText, [encoded]), op(Ops.EndText));
    this.push(popState());

    if ((o.underline || o.strike) && !o.invisible) {
      const metrics = fontMetrics(font);
      const lineStyle = (thickness) => ({ stroke: color, lineWidth: thickness, strokeOpacity: o.opacity, lineCap: "butt" });
      if (o.underline) {
        const lineY = y + metrics.underlinePosition * size;
        this.line(x, lineY, x + width, lineY, lineStyle(Math.max(0.5, metrics.underlineThickness * size)));
      }
      if (o.strike) {
        const lineY = y + metrics.strikePosition * size;
        this.line(x, lineY, x + width, lineY, lineStyle(Math.max(0.5, metrics.underlineThickness * size)));
      }
    }
    return { width, glyphs, horizontalScale: scale };
  }
}

/** A canvas over a page of the output document. */
export class PageCanvas extends Canvas {
  /**
   * @param {object} page  PDFPage
   * @param {{ isolate?: boolean }} [options]  isolate (default true): wrap the existing content first, so that
   *        the drawing starts from the default graphics state whatever the page content did
   */
  constructor(page, { isolate = true } = {}) {
    super(page.doc.context, pageTarget(page));
    this.page = page;
    // a resource dictionary the parser could not read cannot take a font or a picture: see content.js
    const writable = ensureWritableResources(page);
    this.isolation = isolate ? isolatePageContent(page) : null;
    if (this.isolation && writable.unreadable) this.isolation = { ...this.isolation, unreadable: true };
  }
}

/**
 * Metrics of an embedded font in em units (multiply by the font size):
 * ascent, descent (negative), lineGap, capHeight, xHeight, unitsPerEm, underlinePosition (negative),
 * underlineThickness, strikePosition. Standard (non-embedded) fonts get conventional values.
 */
export function fontMetrics(pdfFont) {
  const font = pdfFont.embedder && pdfFont.embedder.font;
  if (font && font.unitsPerEm) {
    const units = font.unitsPerEm;
    const os2 = font["OS/2"];
    return {
      unitsPerEm: units,
      ascent: font.ascent / units,
      descent: font.descent / units,
      lineGap: (font.lineGap || 0) / units,
      capHeight: (font.capHeight || font.ascent) / units,
      xHeight: (font.xHeight || 0) / units,
      underlinePosition: (font.underlinePosition || -0.1 * units) / units,
      underlineThickness: (font.underlineThickness || 0.05 * units) / units,
      strikePosition: os2 && os2.yStrikeoutPosition ? os2.yStrikeoutPosition / units : (font.xHeight ? font.xHeight / units / 2 : 0.25)
    };
  }
  return { unitsPerEm: 1000, ascent: 0.8, descent: -0.2, lineGap: 0, capHeight: 0.7, xHeight: 0.5, underlinePosition: -0.1, underlineThickness: 0.05, strikePosition: 0.25 };
}

/**
 * Characters of `text` (after NFC) that the font cannot draw. Check before drawing: the library does not
 * throw, it silently draws the font's .notdef box (or "?" with a standard font).
 * Line feeds, carriage returns and tabs are skipped by default (the text of a whole box); a single run that
 * is about to be written must not contain them: pass { ignoreLineBreaks: false }.
 * @returns {string[]} distinct missing characters
 */
export function missingCharacters(pdfFont, text, { ignoreLineBreaks = true } = {}) {
  const font = pdfFont.embedder && pdfFont.embedder.font;
  const fromFile = font && typeof font.hasGlyphForCodePoint === "function";
  const standard = fromFile ? null : new Set(pdfFont.getCharacterSet());
  const missing = new Set();
  for (const char of normalizeTextForm(text)) {
    const codePoint = char.codePointAt(0);
    if (ignoreLineBreaks && (codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x09)) continue;
    if (!(fromFile ? font.hasGlyphForCodePoint(codePoint) : standard.has(codePoint))) missing.add(char);
  }
  return [...missing];
}
