// Glyph boxes of a page as pdf.js sees them: the eyes of the verifier and the source of the invisible text
// layer of a rasterised page.
//
// The verifier must not rely on the bookkeeping of the code that did the removal. This module therefore takes
// everything from pdf.js: the operator list of the page (pdf.js parsed the content stream, decoded the strings
// into glyphs and looked the widths up in ITS font objects) and replays only the text-positioning arithmetic
// of pdf.js' canvas backend (showText, showType3Text, moveText, setTextMatrix ... of pdfjs-dist 6.5.438).
//
//   pageGlyphs(page, pdfjs, { annotations, styles, compact })
//     -> { glyphs: [{ quad, core, origin, axisX, axisY, unicode, fontName, fontMissing, space, zeroWidth, invisible,
//                     clip, vertical, inAnnotation, size }], styles, operatorCount, signature, packed }
//   compact: true = the page is only COMPARED with another reading of it (a page without marks, hundreds of
//   them in a long document): no object per glyph, `glyphs` stays empty and `packed` holds
//   { count, numbers: Float64Array of origin x, origin y, advance x, advance y per glyph, unicode: string[],
//     fontMissing: Uint8Array }
//   fontMissing = pdf.js could not use the font program of the glyph (a damaged or missing program: it draws
//   the text with a replacement font); signature = a hash of the sequence of drawing operators of the page
//   ("dependency" entries left out: they list what pdf.js has to load, e.g. the pictures of every glyph of a
//   Type3 font, also of glyphs the page does not show)
//   quad = [x0,y0, x1,y1, x2,y2, x3,y3] in PDF user space (the space of the content stream); core = the core
//   box of the removal rule (GLYPH_RULE in pdfAccess.js); origin = pen position on the baseline.
//   Horizontal glyph box: advance width x [descent, ascent]; vertical: glyph width x advance.
//   ascent / descent come from pdf.js (textContent.styles), 0.8 / -0.2 when pdf.js has none.
//
// `pdfjs` is { OPS, AnnotationMode } of the pdf.js build that produced the page. The engine receives pdf.js
// documents through its env and never imports pdf.js itself, so the constants come from env.pdfjs; when a
// caller does not pass them, PDFJS_CONSTANTS (the numbers of the pinned pdfjs-dist 6.5.438, guarded by a
// test against the installed package) is used. Only the base font properties of pdf.js are read (bbox,
// fontMatrix, isType3Font, vertical): `fontExtraProperties` need not be set when the document is opened.
import { mul, apply, IDENTITY, GLYPH_RULE } from "./pdfAccess.js";

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;

/** OPS and AnnotationMode of pdfjs-dist 6.5.438, restricted to what this engine reads. */
export const PDFJS_CONSTANTS = Object.freeze({
  OPS: Object.freeze({
    dependency: 1, setGState: 9, save: 10, restore: 11, transform: 12, beginText: 31, setCharSpacing: 33, setWordSpacing: 34, setHScale: 35, setLeading: 36,
    setFont: 37, setTextRenderingMode: 38, setTextRise: 39, moveText: 40, setLeadingMoveText: 41, setTextMatrix: 42, nextLine: 43, showText: 44,
    showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76,
    endGroup: 77, beginAnnotation: 80, endAnnotation: 81
  }),
  AnnotationMode: Object.freeze({ DISABLE: 0, ENABLE: 1 })
});

/** { OPS, AnnotationMode } to use: those of env.pdfjs when it has them, the pinned constants otherwise. */
export function resolvePdfjs(pdfjs) {
  if (pdfjs && pdfjs.OPS && pdfjs.AnnotationMode && Number.isInteger(pdfjs.OPS.showText) && Number.isInteger(pdfjs.AnnotationMode.ENABLE)) return pdfjs;
  return PDFJS_CONSTANTS;
}

function freshState(ctm) {
  return {
    ctm, textMatrix: null, x: 0, y: 0, lineX: 0, lineY: 0, leading: 0, charSpacing: 0, wordSpacing: 0, textHScale: 1, textRise: 0,
    fontSize: 0, fontDirection: 1, fontMatrix: [0.001, 0, 0, 0.001, 0, 0], font: null, fontName: null, mode: 0
  };
}

function metricsFor(fontName, font, styles) {
  const st = styles?.[fontName];
  let ascent = st?.ascent;
  let descent = st?.descent;
  if (font?.isType3Font) {
    const bbox = font.bbox;
    const fm = font.fontMatrix;
    if (bbox && fm && bbox[3] > bbox[1]) {
      const y0 = bbox[1] * fm[3];
      const y1 = bbox[3] * fm[3];
      const a = Math.max(y0, y1);
      const d = Math.min(y0, y1);
      if (a > 0.05 && a <= 3 && d <= 0 && d >= -2) return [a, d];
    }
    return [DEFAULT_ASCENT, DEFAULT_DESCENT];
  }
  if (!Number.isFinite(ascent) || !ascent) ascent = Number.isFinite(descent) && descent ? 1 + descent : DEFAULT_ASCENT;
  if (!Number.isFinite(descent) || !descent) descent = ascent - 1;
  if (descent > 0) descent = -descent;
  return [ascent, descent];
}

/** Glyphs without an object each: what a comparison of two readings of a page needs (see the header). */
function packedGlyphs() {
  let numbers = new Float64Array(4 * 2048);
  let fontMissing = new Uint8Array(2048);
  const unicode = [];
  let count = 0;
  return {
    add(originX, originY, advanceX, advanceY, text, missing) {
      if (count === fontMissing.length) {
        const moreNumbers = new Float64Array(numbers.length * 2);
        moreNumbers.set(numbers);
        numbers = moreNumbers;
        const moreFlags = new Uint8Array(fontMissing.length * 2);
        moreFlags.set(fontMissing);
        fontMissing = moreFlags;
      }
      numbers[count * 4] = originX;
      numbers[count * 4 + 1] = originY;
      numbers[count * 4 + 2] = advanceX;
      numbers[count * 4 + 3] = advanceY;
      fontMissing[count] = missing ? 1 : 0;
      unicode.push(text);
      count++;
    },
    done: () => ({ count, numbers: numbers.subarray(0, count * 4), unicode, fontMissing: fontMissing.subarray(0, count) })
  };
}

/**
 * @param page   PDFPageProxy
 * @param pdfjs  the pdf.js namespace (needs OPS and AnnotationMode)
 * @param opts   { annotations: true -> include the appearance streams of annotations, styles: textContent.styles,
 *                 compact: true -> no glyph objects, only the packed record of the header }
 */
export async function pageGlyphs(page, pdfjs, { annotations = true, styles, compact = false } = {}) {
  const { OPS, AnnotationMode } = pdfjs;
  if (!styles) styles = compact ? {} : (await page.getTextContent()).styles;
  const opList = await page.getOperatorList({ annotationMode: annotations ? AnnotationMode.ENABLE : AnnotationMode.DISABLE });
  const { fnArray, argsArray } = opList;
  const glyphs = [];
  const packed = compact ? packedGlyphs() : null;
  const stack = [];
  let cur = freshState(IDENTITY);
  let annotationDepth = 0;
  const fontCache = new Map();
  const getFont = (name) => {
    if (!fontCache.has(name)) {
      let f;
      try {
        f = page.commonObjs.get(name);
      } catch {
        f = null;
      }
      fontCache.set(name, f);
    }
    return fontCache.get(name);
  };
  const setFont = (name, size) => {
    const font = getFont(name);
    cur.font = font;
    cur.fontName = name;
    cur.fontMatrix = font?.fontMatrix || [0.001, 0, 0, 0.001, 0, 0];
    if (size < 0) {
      cur.fontSize = -size;
      cur.fontDirection = -1;
    } else {
      cur.fontSize = size;
      cur.fontDirection = 1;
    }
  };
  const save = () => stack.push({ ...cur });
  const restore = () => {
    if (stack.length) cur = stack.pop();
  };

  const showText = (items) => {
    const font = cur.font;
    const fontSize = cur.fontSize;
    if (!font || fontSize === 0 || !Array.isArray(items)) return;
    const M = mul(cur.textMatrix || IDENTITY, cur.ctm);
    const dir = cur.fontDirection;
    const hScale = cur.textHScale * dir;
    const vertical = !!font.vertical;
    const [ascent, descent] = metricsFor(cur.fontName, font, styles);
    const yBase = cur.y + cur.textRise;
    // axes of one em in user space: along the writing line and "up" (used to rebuild a text layer)
    const emScale = font.isType3Font ? Math.max(ascent - descent, 0.05) : 1;
    const axisX = [M[0] * fontSize * hScale, M[1] * fontSize * hScale];
    const axisY = [M[2] * fontSize * dir * emScale, M[3] * fontSize * dir * emScale];
    // the core band of the removal rule (GLYPH_RULE): fixed fractions of the em above the baseline, or of the
    // glyph box for Type3 fonts; for vertical writing the middle half of the cell across the column
    const coreLo = font.isType3Font ? descent + GLYPH_RULE.type3CoreLow * (ascent - descent) : GLYPH_RULE.coreLow;
    const coreHi = font.isType3Font ? descent + GLYPH_RULE.type3CoreHigh * (ascent - descent) : GLYPH_RULE.coreHigh;
    const push = (x0, y0, x1, y1, g, zeroWidth, ox, oy) => {
      if (packed) {
        // the origin, and the vector from the start to the end of the box along the line (quad[2..3] - quad[0..1])
        packed.add(M[0] * ox + M[2] * oy + M[4], M[1] * ox + M[3] * oy + M[5], M[0] * (x1 - x0), M[1] * (x1 - x0), typeof g.unicode === "string" ? g.unicode : "", font.missingFile === true);
        return;
      }
      let core;
      if (vertical) {
        const half = GLYPH_RULE.verticalCoreHalfWidth * fontSize * hScale;
        core = [...apply(M, ox - half, y0), ...apply(M, ox + half, y0), ...apply(M, ox + half, y1), ...apply(M, ox - half, y1)];
      } else {
        const c0 = oy + coreLo * fontSize * dir;
        const c1 = oy + coreHi * fontSize * dir;
        core = [...apply(M, x0, c0), ...apply(M, x1, c0), ...apply(M, x1, c1), ...apply(M, x0, c1)];
      }
      glyphs.push({
        quad: [...apply(M, x0, y0), ...apply(M, x1, y0), ...apply(M, x1, y1), ...apply(M, x0, y1)],
        core,
        origin: apply(M, ox, oy),
        axisX,
        axisY,
        unicode: typeof g.unicode === "string" ? g.unicode : "",
        fontName: cur.fontName,
        fontMissing: font.missingFile === true,
        space: !!g.isSpace,
        zeroWidth,
        invisible: cur.mode === 3,
        clip: cur.mode >= 4,
        vertical,
        inAnnotation: annotationDepth > 0,
        size: fontSize
      });
    };
    if (font.isType3Font) {
      const fm0 = cur.fontMatrix[0];
      let x = cur.x;
      for (const g of items) {
        if (typeof g === "number") {
          x += ((-1 * g * fontSize) / 1000) * hScale;
          continue;
        }
        const spacing = (g.isSpace ? cur.wordSpacing : 0) + cur.charSpacing;
        const w = g.width * fm0 * fontSize;
        push(x, yBase + descent * fontSize * dir, x + w * hScale, yBase + ascent * fontSize * dir, g, w === 0, x, yBase);
        x += (w + spacing * dir) * hScale;
      }
      cur.x = x;
      return;
    }
    const scale = fontSize * cur.fontMatrix[0];
    let x = 0;
    for (const g of items) {
      if (typeof g === "number") {
        x += ((vertical ? 1 : -1) * g * fontSize) / 1000;
        continue;
      }
      const spacing = (g.isSpace ? cur.wordSpacing : 0) + cur.charSpacing;
      if (vertical) {
        const vm = g.vmetric || [-1000, g.width / 2, 880];
        const w1 = vm[0] * scale; // negative: downwards
        const vx = vm[1] * scale;
        const w0 = g.width * scale;
        const yTop = yBase - x;
        push(cur.x - vx * hScale, yTop + w1, cur.x + (w0 - vx) * hScale, yTop, g, w1 === 0, cur.x, yTop);
        x += -vm[0] * scale - spacing * dir;
      } else {
        const w = g.width * scale;
        const xs = cur.x + x * hScale;
        push(xs, yBase + descent * fontSize * dir, xs + w * hScale, yBase + ascent * fontSize * dir, g, w === 0, xs, yBase);
        x += w + spacing * dir;
      }
    }
    if (vertical) cur.y -= x;
    else cur.x += x * hScale;
  };

  for (let i = 0; i < fnArray.length; i++) {
    const a = argsArray[i];
    switch (fnArray[i]) {
      case OPS.save:
        save();
        break;
      case OPS.restore:
        restore();
        break;
      case OPS.transform:
        cur.ctm = mul([a[0], a[1], a[2], a[3], a[4], a[5]], cur.ctm);
        break;
      case OPS.beginText:
        cur.textMatrix = null;
        cur.x = cur.lineX = 0;
        cur.y = cur.lineY = 0;
        break;
      case OPS.setCharSpacing:
        cur.charSpacing = a[0];
        break;
      case OPS.setWordSpacing:
        cur.wordSpacing = a[0];
        break;
      case OPS.setHScale:
        cur.textHScale = a[0] / 100;
        break;
      case OPS.setLeading:
        cur.leading = -a[0];
        break;
      case OPS.setFont:
        setFont(a[0], a[1]);
        break;
      case OPS.setTextRenderingMode:
        cur.mode = a[0];
        break;
      case OPS.setTextRise:
        cur.textRise = a[0];
        break;
      case OPS.moveText:
        cur.x = cur.lineX += a[0];
        cur.y = cur.lineY += a[1];
        break;
      case OPS.setLeadingMoveText:
        cur.leading = a[1];
        cur.x = cur.lineX += a[0];
        cur.y = cur.lineY += a[1];
        break;
      case OPS.setTextMatrix: {
        const m = a.length === 1 ? a[0] : a;
        cur.textMatrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
        cur.x = cur.lineX = 0;
        cur.y = cur.lineY = 0;
        break;
      }
      case OPS.nextLine:
        cur.x = cur.lineX += 0;
        cur.y = cur.lineY += cur.leading;
        break;
      case OPS.showText:
        showText(a[0]);
        break;
      case OPS.showSpacedText:
        showText(a[0]);
        break;
      case OPS.nextLineShowText:
        cur.y = cur.lineY += cur.leading;
        cur.x = cur.lineX;
        showText(a[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        cur.wordSpacing = a[0];
        cur.charSpacing = a[1];
        cur.y = cur.lineY += cur.leading;
        cur.x = cur.lineX;
        showText(a[2]);
        break;
      case OPS.setGState:
        for (const [key, value] of a[0]) if (key === "Font") setFont(value[0], value[1]);
        break;
      case OPS.paintFormXObjectBegin:
        save();
        if (a[0]) cur.ctm = mul([a[0][0], a[0][1], a[0][2], a[0][3], a[0][4], a[0][5]], cur.ctm);
        break;
      case OPS.paintFormXObjectEnd:
        restore();
        break;
      case OPS.beginGroup: {
        save();
        const m = a[0]?.matrix;
        if (m) cur.ctm = mul([m[0], m[1], m[2], m[3], m[4], m[5]], cur.ctm);
        break;
      }
      case OPS.endGroup:
        restore();
        break;
      case OPS.beginAnnotation: {
        // (id, rect, transform, matrix, hasOwnCanvas): the appearance is drawn with matrix x transform on the
        // page's base transform, from a fresh graphics state
        save();
        annotationDepth++;
        const t = a[2] || IDENTITY;
        const m = a[3] || IDENTITY;
        cur = freshState(mul([m[0], m[1], m[2], m[3], m[4], m[5]], [t[0], t[1], t[2], t[3], t[4], t[5]]));
        break;
      }
      case OPS.endAnnotation:
        annotationDepth = Math.max(0, annotationDepth - 1);
        restore();
        break;
      default:
    }
  }
  // FNV-1a over the operator numbers: two pages with the same content have the same sequence
  let signature = 0x811c9dc5;
  for (let i = 0; i < fnArray.length; i++) if (fnArray[i] !== OPS.dependency) signature = Math.imul(signature ^ (fnArray[i] & 0xff), 0x01000193);
  return { glyphs, styles, operatorCount: fnArray.length, signature: signature >>> 0, packed: packed ? packed.done() : null };
}
