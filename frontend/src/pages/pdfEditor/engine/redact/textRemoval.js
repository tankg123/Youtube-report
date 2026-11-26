// The precise path: removes the glyphs that lie under target rectangles from the content of a page, leaving
// every other glyph exactly where it was. The page stays vector.
//
//   removeTextInRects(pdfDoc, pageIndex, rects, options)  -> report   (mutates pdfDoc on success only)
//
// The interpreter executes the content stream of the page (and, recursively, of the Form XObjects it draws):
// graphics-state stack (q Q cm), text objects and text state (BT ET Tf Tc Tw Tz TL Ts Tr Td TD Tm T* Tj TJ ' "),
// glyph advances from the font dictionaries (fonts.js). Which glyphs a target takes is decided by the rule
// in pdfAccess.js (GLYPH_RULE: the core of the glyph is touched, or a quarter of its box is covered). The
// text-showing operation is rewritten as a TJ array in which every removed glyph is replaced by the adjustment
// that produces the same displacement, so the remaining glyphs and everything after them keep their positions.
// An advance that nothing depends on (an operation that lost all its glyphs, or the end of one that lost its
// last glyphs, when no text follows on the pen position) is dropped, so that not even the width of the removed
// text stays behind.
//
// Two kinds of targets:
//   strict     (modes "redact", "pixelate", "blur") everything under the box must go. Besides the glyphs: a
//              picture or a painted path that lies completely inside one target is no longer drawn; a picture
//              that only reaches into a target, curves, or many straight segments in a target make the page
//              unsupported (it could be a scan, or text drawn as outlines)
//   text-only  (mode "erase", the original line of a replaced text) only the glyphs go; pictures, rules and
//              backgrounds under the box are not looked at and stay as they are
//
// WHAT MUST NOT STAY BEHIND. Removing the operator that paints something does not remove what it named:
//   - a q ... Q group that paints nothing any more after the removal (only state operators are left: a font, a
//     colour, a pattern, a soft mask, a clipping path) is dropped as a whole, so that pruneResources() can
//     release what those operators named;
//   - a /Font entry that showed glyphs and shows none any more is pointed at a stand-in without font program,
//     widths or ToUnicode map (a Tf left at the top level still needs a font, but the subset of the removed
//     text must not stay reachable through it). Glyphs a font still holds for text that is shown elsewhere
//     are the business of fontCleanup.js;
//   - a Form XObject that changes gets a private copy for the use that is redacted (other pages and other
//     uses keep the original). The copy has PRIVATE resource dictionaries (report.clonedResources), so that
//     the caller can prune from them what the rewritten content no longer names: a picture, the original
//     inner form, a property list with /ActualText;
//   - /ActualText, /Alt and /E of marked-content sequences that lose a glyph are dropped (they would spell the
//     removed text out), and comments are stripped from a rewritten stream.
//
// SAFETY RULE: whatever is not fully understood makes the page "unsupported": syntax errors, unknown
// operators, undecodable streams, text whose position cannot be computed and that may lie in a target, text
// used as a clipping path, pictures or vector artwork in a strict target, and content the verifier cannot
// see because pdf.js reports neither its text nor its pictures: a tiling pattern that shows text or draws
// XObjects / inline images, a Type3 glyph procedure or a soft mask whose content shows text (directly or
// through the forms it draws), a soft mask that draws pictures over a strict target. Nothing is written to
// the document in that case; redactPdf.js then rasterises the page, or reports an "erase" target as
// "cover-needed". The reasons are short tokens (report.reason.code); codes.js maps them to the public
// REDACT_ codes.
import {
  parseContentStream, serializeOperations, concatBytes, formatNumber, formatLiteralString, formatHexString, formatName,
  tokenSource, ContentParseError
} from "./contentStream.js";
import { A, mul, apply, invert, IDENTITY, normRect, glyphInTargets, GLYPH_RULE, UnsupportedPdfError } from "./pdfAccess.js";
import { loadFont, FontDecodeError } from "./fonts.js";

/** Default thresholds of the removal rule: { core: 0.25, full: 0.25 } (see GLYPH_RULE in pdfAccess.js). */
export const DEFAULT_THRESHOLDS = GLYPH_RULE.remove;
/**
 * More straight path segments than this inside the strict targets of a page count as hidden artwork. Up to
 * this number they are left to the pixel check of the verifier (a rule or a frame that crosses a mark is
 * visible there and sends the page to the raster path; one that only touches the edge of the mark is not).
 */
export const MAX_LINE_SEGMENTS_IN_TARGETS = 24;
const MAX_FORM_DEPTH = 24;

/** Internal: the page cannot be handled precisely. Caught in removeTextInRects(), never thrown to callers. */
export class RedactionUnsupported extends Error {
  /**
   * @param {string} code     machine-readable reason (a key of FALLBACK_REASONS in codes.js)
   * @param {string} message  English, for logs only
   * @param {object} [params] values for the public code (never document text)
   */
  constructor(code, message, params = {}) {
    super(message);
    this.name = "RedactionUnsupported";
    this.code = code;
    this.params = params;
  }
}

const TEXT_SHOW = new Set(["Tj", "TJ", "'", "\""]);
// operators that neither show text nor depend on the current text position (used to drop pure advances)
const POSITION_NEUTRAL = new Set([
  "Tf", "Tc", "Tw", "Tz", "TL", "Tr", "Ts", "g", "G", "rg", "RG", "k", "K", "cs", "CS", "sc", "SC", "scn", "SCN", "gs", "w", "J", "j", "M", "d", "ri",
  "i", "BMC", "BDC", "EMC", "MP", "DP"
]);
const POSITION_RESET = new Set(["Td", "TD", "Tm", "T*", "ET", "'", "\""]);
/**
 * Operators that paint nothing and whose effect ends with the Q of the group they stand in: the graphics and
 * text state, path construction and clipping. A q ... Q group that holds nothing else after a removal is
 * dropped (marked content, compatibility sections and everything unknown keep a group alive).
 */
const STATE_ONLY = new Set([
  "q", "Q", "cm", "w", "J", "j", "M", "d", "ri", "i", "gs", "g", "G", "rg", "RG", "k", "K", "cs", "CS", "sc", "SC", "scn", "SCN",
  "BT", "ET", "Tf", "Tc", "Tw", "Tz", "TL", "Tr", "Ts", "Td", "TD", "Tm", "T*", "m", "l", "c", "v", "y", "h", "re", "W", "W*", "n"
]);
/** Entries of a marked-content property list that repeat the text of the sequence in words. */
const STRIP_KEYS = new Set(["ActualText", "Alt", "E"]);
/** Resource categories of a cloned form that become private copies (the ones pruneResources() prunes). */
const ISOLATED_CATEGORIES = ["XObject", "Properties", "Pattern", "Font", "ExtGState"];
/** Entries of a Form XObject that can hold a copy of its content as it was: never carried over to a rewritten copy. */
const FORM_COPY_SKIP = new Set(["Filter", "DecodeParms", "Length", "DL", "PieceInfo", "Metadata", "LastModified", "OPI", "Ref"]);

function containsTextOperators(bytes) {
  try {
    return parseContentStream(bytes).ops.some((o) => TEXT_SHOW.has(o.op));
  } catch {
    return true; // not understood: assume the worst
  }
}

// ---------------------------------------------------------------- resources
class ResourceScope {
  constructor(dict, env) {
    this.dict = dict; // PDFDict | undefined (already resolved)
    this.env = env;
    this.fonts = new Map();
    this.newXObjects = new Map(); // new name -> pending form
    this.newProperties = new Map(); // new name -> PDFDict
    this.counter = 0;
    /** font resource name -> { kept, removed, open }: the glyphs shown through this entry of the dictionary */
    this.fontUse = new Map();
  }

  category(name) {
    const c = A.get(this.dict, name);
    return A.isDict(c) ? c : undefined;
  }

  entry(categoryName, name) {
    const cat = this.category(categoryName);
    if (!cat) return { raw: undefined, obj: undefined };
    const raw = cat.get(A.N(name));
    return { raw, obj: A.resolve(this.env.context, raw) };
  }

  font(name) {
    if (this.fonts.has(name)) return this.fonts.get(name);
    const { raw, obj } = this.entry("Font", name);
    const info = this.env.fontFor(raw, obj);
    this.fonts.set(name, info);
    return info;
  }

  useOfFont(name) {
    if (!this.fontUse.has(name)) this.fontUse.set(name, { kept: 0, removed: 0, open: false });
    return this.fontUse.get(name);
  }

  /**
   * /Font entries that lost every glyph they showed through this dictionary. Their font program, widths and
   * ToUnicode map would spell the removed text out (a subset holds exactly the glyphs that were used).
   * `open`: text was shown through the entry that was not measured, so the font may still show something.
   */
  emptiedFonts() {
    const out = [];
    for (const [name, use] of this.fontUse) if (use.removed > 0 && use.kept === 0 && !use.open) out.push(name);
    return out;
  }

  uniqueName(categoryName, base) {
    const cat = this.category(categoryName);
    const taken = (n) => (cat && cat.has(A.N(n))) || this.newXObjects.has(n) || this.newProperties.has(n);
    let n;
    do {
      n = `${base}_r${this.counter++}`;
    } while (taken(n));
    return n;
  }

  hasEdits() {
    return this.newXObjects.size > 0 || this.newProperties.size > 0 || this.emptiedFonts().length > 0;
  }
}

// ---------------------------------------------------------------- the interpreter
function cloneGs(gs) {
  return { ...gs };
}

const initialGs = () => ({ ctm: IDENTITY, tc: 0, tw: 0, th: 1, tl: 0, font: null, fontUse: null, tfs: 0, tr: 0, ts: 0 });

/**
 * Executes one content stream. Returns { changed, bytes, removed, kept }.
 *   bytes      the new content (only meaningful when changed)
 *   isPage     page level: stray Q operators are dropped and missing ones added, so that the result can be
 *              wrapped in q ... Q and drawn over safely
 */
function processStream(bytes, scope, gsInit, env, isPage, owner) {
  const { rects, strictRects, thresholds } = env;
  let parsed;
  try {
    parsed = parseContentStream(bytes);
  } catch (err) {
    if (err instanceof ContentParseError) throw new RedactionUnsupported("content-syntax", `content stream not understood: ${err.message}`);
    throw err;
  }
  const { ops, source } = parsed;
  const out = ops.slice();
  const meta = new Array(ops.length); // per replaced op: { pureAdvance, prefix, trimmed }
  let gs = cloneGs(gsInit);
  const stack = [];
  let inText = false;
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let uncertain = false; // the current text position is only known up to a shift along the baseline
  let prevGlyphRemoved = false;
  const mcStack = []; // { index, oc } for BDC (oc: an optional-content sequence), { index: -1 } for BMC
  const mcTouched = new Set(); // op indices of BDC operations that wrap removed glyphs
  let compat = 0;
  let removed = 0;
  let kept = 0;
  let changed = false;
  let strayQ = 0;
  // q ... Q groups of this stream, and where something was taken out (for "a group that paints nothing any more")
  const qStack = []; // { index, inText }
  const groups = []; // [index of q, index of Q, a text object was open at the q]
  const lost = new Uint8Array(ops.length); // 1: the operation lost what it painted (glyphs, a picture, a path)
  // current path (for the "artwork in a target" rules)
  let cur = null;
  let subStart = null;
  let pathLines = 0;
  let pathCurves = 0;
  let pathOps = []; // indices of the operations that build the current path
  let pathBox = null; // bounding box of its points, in user space
  let pathClips = false; // W / W* seen: the path also becomes the clipping path
  const resetPath = () => {
    cur = null;
    subStart = null;
    pathLines = 0;
    pathCurves = 0;
    pathOps = [];
    pathBox = null;
    pathClips = false;
  };
  const pathPoint = (i, p) => {
    if (pathOps[pathOps.length - 1] !== i) pathOps.push(i);
    if (!pathBox) pathBox = [p[0], p[1], p[0], p[1]];
    else {
      if (p[0] < pathBox[0]) pathBox[0] = p[0];
      if (p[0] > pathBox[2]) pathBox[2] = p[0];
      if (p[1] < pathBox[1]) pathBox[1] = p[1];
      if (p[1] > pathBox[3]) pathBox[3] = p[1];
    }
    return p;
  };
  /** Is the box inside ONE strict target (a quarter of a point of slack)? Then the object can simply be dropped. */
  const insideOneTarget = (box) => {
    const e = 0.25;
    for (const r of strictRects) if (box[0] >= r[0] - e && box[2] <= r[2] + e && box[1] >= r[1] - e && box[3] <= r[3] + e) return true;
    return false;
  };

  const fail = (code, message, params) => {
    throw new RedactionUnsupported(code, message, params);
  };
  const nums = (op, n) => {
    if (op.args.length !== n) fail("operands", `operator ${op.op} with ${op.args.length} operand(s), expected ${n}`);
    return op.args.map((a) => {
      if (a.type !== "num") fail("operands", `operator ${op.op} with a non-numeric operand`);
      return a.value;
    });
  };
  const needText = (op) => {
    if (!inText) fail("text-outside-bt", `operator ${op.op} outside a text object`);
  };
  const touchMarkedContent = () => {
    for (const mc of mcStack) if (mc.index >= 0) mcTouched.add(mc.index);
  };

  /** Does the bounding box of the points reach into a strict target? */
  const bboxHitsTarget = (pts) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    for (const r of strictRects) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return true;
    return false;
  };

  /** Could text drawn somewhere on the current baseline (position along it unknown) touch a target? */
  const baselineBandHitsTarget = (font) => {
    const inv = invert(mul(tm, gs.ctm));
    if (!inv) return true;
    const size = Math.abs(gs.tfs) || 1;
    const vertical = !!font?.vertical;
    // generous extent across the writing direction, in text space
    const lo = vertical ? -1.25 * size * Math.abs(gs.th || 1) : gs.ts - 1.25 * size;
    const hi = vertical ? 1.25 * size * Math.abs(gs.th || 1) : gs.ts + 1.5 * size;
    for (const r of rects) {
      let mn = Infinity;
      let mx = -Infinity;
      for (const [x, y] of [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]) {
        const p = apply(inv, x, y);
        const cross = vertical ? p[0] : p[1];
        if (cross < mn) mn = cross;
        if (cross > mx) mx = cross;
      }
      if (mn <= hi && mx >= lo) return true;
    }
    return false;
  };

  const unmeasurable = (font, reason) => {
    env.report.unmeasurableOps++;
    if (baselineBandHitsTarget(font)) fail("unmeasurable-text", `text whose position cannot be computed may lie in a target: ${reason}`, { font: font?.name || "" });
    if (!env.report.notes.includes(reason)) env.report.notes.push(reason);
    uncertain = true;
    return false;
  };

  /**
   * Shows text. `elements` are the string / number tokens, `prefix` the operators a quote operator expands to
   * (already executed by the caller). Returns true when every glyph was measured, false when the text was
   * left alone because its position cannot be computed (and it cannot lie in a target).
   */
  const showGlyphs = (i, elements, prefix) => {
    const font = gs.font;
    const tfs = gs.tfs;
    if (!font) return unmeasurable(null, "text shown without a font");
    if (font.kind === "type3" && env.type3HasText(font)) fail("type3-glyph-text", `Type3 font ${font.name} has glyph procedures that show text`);
    if (!font.measurable) return unmeasurable(font, font.reason);
    if (uncertain) return unmeasurable(font, "text follows unmeasurable text on the same line");
    if (tfs === 0 || gs.th === 0) return unmeasurable(font, "text with font size 0 or horizontal scaling 0");

    const pieces = [];
    try {
      for (const el of elements) {
        if (el.type === "num") pieces.push({ num: el.value });
        else if (el.type === "str" || el.type === "hex") pieces.push({ token: el, glyphs: font.decode(el.value) });
        else fail("operands", `unexpected ${el.type} in a text-showing operation`);
      }
    } catch (err) {
      if (err instanceof FontDecodeError) return unmeasurable(font, err.message);
      throw err;
    }

    const M = mul(tm, gs.ctm);
    const { tc, tw, th, ts } = gs;
    const vertical = font.vertical;
    const yLo = font.descent * tfs + ts;
    const yHi = font.ascent * tfs + ts;
    // the core band (GLYPH_RULE): fixed fractions of the em, or of the glyph box for Type3 fonts
    const isType3 = font.kind === "type3";
    const boxHeight = font.ascent - font.descent;
    const cLo = (isType3 ? font.descent + GLYPH_RULE.type3CoreLow * boxHeight : GLYPH_RULE.coreLow) * tfs + ts;
    const cHi = (isType3 ? font.descent + GLYPH_RULE.type3CoreHigh * boxHeight : GLYPH_RULE.coreHigh) * tfs + ts;
    let pen = 0;
    let anyRemoved = false;
    for (const piece of pieces) {
      if (piece.token === undefined) {
        pen -= (piece.num / 1000) * tfs * (vertical ? 1 : th);
        continue;
      }
      for (const g of piece.glyphs) {
        let quad;
        let core;
        let zero;
        let origin;
        const spacing = tc + (g.space ? tw : 0);
        if (!vertical) {
          const x0 = pen;
          const x1 = pen + g.w0 * tfs * th;
          quad = [...apply(M, x0, yLo), ...apply(M, x1, yLo), ...apply(M, x1, yHi), ...apply(M, x0, yHi)];
          core = [...apply(M, x0, cLo), ...apply(M, x1, cLo), ...apply(M, x1, cHi), ...apply(M, x0, cHi)];
          if (env.collectAll) origin = apply(M, x0, ts);
          zero = g.w0 === 0;
          pen += (g.w0 * tfs + spacing) * th;
        } else {
          const x0 = -g.vx * tfs * th;
          const x1 = (g.w0 - g.vx) * tfs * th;
          const yTop = pen + ts;
          const yBot = pen + g.w1 * tfs + ts;
          const half = GLYPH_RULE.verticalCoreHalfWidth * tfs * th;
          quad = [...apply(M, x0, yBot), ...apply(M, x1, yBot), ...apply(M, x1, yTop), ...apply(M, x0, yTop)];
          core = [...apply(M, -half, yBot), ...apply(M, half, yBot), ...apply(M, half, yTop), ...apply(M, -half, yTop)];
          if (env.collectAll) origin = apply(M, 0, yTop);
          zero = g.w1 === 0;
          pen += g.w1 * tfs + spacing;
        }
        const cov = glyphInTargets(quad, core, rects, thresholds);
        // a glyph without advance (combining mark) shares the fate of the glyph it sits on
        const remove = cov.hit || (zero && prevGlyphRemoved);
        g.remove = remove;
        prevGlyphRemoved = remove;
        if (remove) {
          anyRemoved = true;
          removed++;
          if (gs.tr >= 4) fail("clip-text", "a glyph in a target is part of a clipping path (text rendering mode 4-7)");
          if (env.collect) env.report.removedQuads.push(quad);
        } else kept++;
        if (env.collectAll) env.report.glyphs.push({ quad, core, origin, remove, code: g.code, coverage: cov });
      }
    }
    tm = vertical ? mul([1, 0, 0, 1, 0, pen], tm) : mul([1, 0, 0, 1, pen, 0], tm);
    if (!anyRemoved) return true;

    // ---- rewrite as a TJ array: removed glyphs become adjustments of the same displacement
    const parts = [];
    let acc = null;
    let keptAny = false;
    let removedAfterLastKept = false;
    const flush = () => {
      if (acc !== null && Math.abs(acc) > 5e-6) parts.push(formatNumber(acc, 4));
      acc = null;
    };
    for (const piece of pieces) {
      if (piece.token === undefined) {
        acc = (acc ?? 0) + piece.num;
        continue;
      }
      const data = piece.token.value;
      const fmt = piece.token.type === "hex" ? formatHexString : formatLiteralString;
      let runStart = -1;
      const emit = (end) => {
        if (runStart < 0) return;
        flush();
        parts.push(fmt(data.subarray(runStart, end)));
        keptAny = true;
        removedAfterLastKept = false;
        runStart = -1;
      };
      for (const g of piece.glyphs) {
        if (g.remove) {
          emit(g.start);
          const w = vertical ? g.w1 : g.w0;
          acc = (acc ?? 0) - (w * 1000 + ((tc + (g.space ? tw : 0)) * 1000) / tfs);
          removedAfterLastKept = true;
        } else if (runStart < 0) runStart = g.start;
      }
      emit(data.length);
    }
    const keptParts = parts.length;
    flush();
    const body = parts.length ? `[${parts.join(" ")}] TJ` : "";
    out[i] = { raw: [prefix, body].filter(Boolean).join(" ") };
    // the operation ends with the advance of removed glyphs: the same operation without it, for the case that
    // nothing after it depends on the pen position (decided below, like a pure advance)
    const tail = keptAny && removedAfterLastKept && parts.length > keptParts;
    meta[i] = { pureAdvance: !keptAny, prefix, trimmed: tail ? [prefix, `[${parts.slice(0, keptParts).join(" ")}] TJ`].filter(Boolean).join(" ") : null };
    lost[i] = 1;
    changed = true;
    touchMarkedContent();
    return true;
  };

  /** Shows text and keeps the books of the /Font entry it was shown through (see ResourceScope.emptiedFonts). */
  const showText = (i, elements, prefix) => {
    const use = gs.fontUse;
    const keptBefore = kept;
    const removedBefore = removed;
    const measured = showGlyphs(i, elements, prefix);
    if (!use) return;
    use.kept += kept - keptBefore;
    use.removed += removed - removedBefore;
    // text that was not measured is text the font still shows. A vertical font is never replaced either: the
    // adjustments that stand for its removed glyphs move the pen along the column only while it is selected
    if (!measured || gs.font?.vertical) use.open = true;
  };

  const moveLine = (tx, ty) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    uncertain = false;
    prevGlyphRemoved = false;
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    switch (op.op) {
      // ---------------- graphics state
      case "q":
        stack.push(cloneGs(gs));
        qStack.push({ index: i, inText });
        break;
      case "Q":
        if (stack.length) {
          gs = stack.pop();
          const open = qStack.pop();
          groups.push([open.index, i, open.inText || inText]);
        } else if (isPage) {
          // a Q without a matching q does nothing at page level; it is dropped so that it cannot close the
          // q ... Q wrapper put around the rewritten content
          strayQ++;
          out[i] = null;
        } else {
          // inside a form the effect of an unmatched Q depends on the viewer (it may pop the state the viewer
          // saved for the form itself)
          fail("form-unbalanced-q", "a Form XObject has a Q without a matching q");
        }
        break;
      case "cm": {
        const m = nums(op, 6);
        gs.ctm = mul(m, gs.ctm);
        break;
      }
      case "gs": {
        if (op.args.length !== 1 || op.args[0].type !== "name") fail("operands", "gs without a name");
        const { obj } = scope.entry("ExtGState", op.args[0].value);
        if (A.isDict(obj)) {
          const f = A.get(obj, "Font");
          if (A.isArray(f) && f.size() === 2) {
            gs.font = env.fontFor(f.get(0), f.lookup(0));
            gs.fontUse = null; // a font of a graphics state dictionary is not a /Font resource entry
            gs.tfs = A.num(f.lookup(1)) ?? 0;
          }
          const smask = A.get(obj, "SMask");
          if (A.isDict(smask) && env.strict) {
            const g = A.get(smask, "G");
            if (A.isStream(g)) {
              // pdf.js paints a mask group outside the text and operator lists the verifier reads
              const inside = env.inspectContent(A.getRaw(smask, "G"), g);
              if (inside.text) fail("smask-text", "a soft mask contains text");
              if (inside.draws) {
                // the pictures a mask group draws are positioned by its /Matrix and the CTM of this operator
                const box = A.numArray(A.get(g.dict, "BBox"), 4);
                const m = mul(A.numArray(A.get(g.dict, "Matrix"), 6) ?? IDENTITY, gs.ctm);
                const reaches = !box || bboxHitsTarget([apply(m, box[0], box[1]), apply(m, box[2], box[1]), apply(m, box[2], box[3]), apply(m, box[0], box[3])]);
                if (reaches) fail("smask-image", "a soft mask that draws pictures or forms lies over a target");
              }
            }
          }
        }
        break;
      }
      // ---------------- text objects and state
      case "BT":
        if (inText) fail("nested-bt", "BT inside a text object");
        inText = true;
        tm = IDENTITY;
        tlm = IDENTITY;
        uncertain = false;
        prevGlyphRemoved = false;
        break;
      case "ET":
        inText = false;
        break;
      case "Tc":
        [gs.tc] = nums(op, 1);
        break;
      case "Tw":
        [gs.tw] = nums(op, 1);
        break;
      case "Tz":
        gs.th = nums(op, 1)[0] / 100;
        break;
      case "TL":
        [gs.tl] = nums(op, 1);
        break;
      case "Ts":
        [gs.ts] = nums(op, 1);
        break;
      case "Tr":
        [gs.tr] = nums(op, 1);
        break;
      case "Tf": {
        if (op.args.length !== 2 || op.args[0].type !== "name" || op.args[1].type !== "num") fail("operands", "Tf with wrong operands");
        gs.font = scope.font(op.args[0].value);
        gs.fontUse = scope.useOfFont(op.args[0].value);
        gs.tfs = op.args[1].value;
        break;
      }
      case "Td": {
        needText(op);
        const [tx, ty] = nums(op, 2);
        moveLine(tx, ty);
        break;
      }
      case "TD": {
        needText(op);
        const [tx, ty] = nums(op, 2);
        gs.tl = -ty;
        moveLine(tx, ty);
        break;
      }
      case "Tm": {
        needText(op);
        tlm = nums(op, 6);
        tm = tlm;
        uncertain = false;
        prevGlyphRemoved = false;
        break;
      }
      case "T*":
        needText(op);
        if (op.args.length) fail("operands", "T* with operands");
        moveLine(0, -gs.tl);
        break;
      case "Tj": {
        needText(op);
        if (op.args.length !== 1 || (op.args[0].type !== "str" && op.args[0].type !== "hex")) fail("operands", "Tj without a string");
        showText(i, op.args, "");
        break;
      }
      case "TJ": {
        needText(op);
        if (op.args.length !== 1 || op.args[0].type !== "arr") fail("operands", "TJ without an array");
        showText(i, op.args[0].items, "");
        break;
      }
      case "'": {
        needText(op);
        if (op.args.length !== 1 || (op.args[0].type !== "str" && op.args[0].type !== "hex")) fail("operands", "' without a string");
        moveLine(0, -gs.tl);
        showText(i, op.args, "T*");
        break;
      }
      case "\"": {
        needText(op);
        if (op.args.length !== 3 || op.args[0].type !== "num" || op.args[1].type !== "num" || (op.args[2].type !== "str" && op.args[2].type !== "hex")) {
          fail("operands", "\" with wrong operands");
        }
        gs.tw = op.args[0].value;
        gs.tc = op.args[1].value;
        moveLine(0, -gs.tl);
        const src = (t) => String.fromCharCode(...tokenSource(source, t));
        showText(i, [op.args[2]], `${src(op.args[0])} Tw ${src(op.args[1])} Tc T*`);
        break;
      }
      // ---------------- XObjects
      case "Do": {
        if (op.args.length !== 1 || op.args[0].type !== "name") fail("operands", "Do without a name");
        const name = op.args[0].value;
        const { raw, obj } = scope.entry("XObject", name);
        if (!A.isStream(obj)) break; // missing resource: nothing is drawn
        const subtype = A.getName(obj.dict, "Subtype");
        if (subtype === "Image") {
          env.report.images++;
          const corners = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
          if (env.strict && bboxHitsTarget(corners)) {
            const xs = corners.map((c) => c[0]);
            const ys = corners.map((c) => c[1]);
            if (!insideOneTarget([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])) {
              fail("image-in-target", `image ${name} lies partly in a target`, { name });
            }
            // the whole picture is under the box: it is not drawn any more (pruneResources releases the object)
            out[i] = null;
            lost[i] = 1;
            changed = true;
            env.report.imagesRemoved++;
            touchMarkedContent();
          }
        } else if (subtype === "Form") {
          const res = runForm(raw, obj, scope, gs, env);
          removed += res.removed;
          kept += res.kept;
          if (res.changed) {
            // this USE of the form gets its own modified copy under a new resource name
            const key = `${String(A.idOf(raw))}|${res.signature}`;
            let newName = scope.formDedupe?.get(key);
            if (!newName) {
              newName = scope.uniqueName("XObject", name);
              scope.newXObjects.set(newName, res.pending);
              (scope.formDedupe ??= new Map()).set(key, newName);
            }
            out[i] = { raw: `${formatName(newName)} Do` };
            changed = true;
            touchMarkedContent();
          }
        } else if (subtype !== "PS") {
          fail("xobject", `XObject ${name} has the unknown subtype ${subtype}`);
        }
        break;
      }
      case "BI": {
        env.report.images++;
        const corners = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
        if (env.strict && bboxHitsTarget(corners)) {
          const xs = corners.map((c) => c[0]);
          const ys = corners.map((c) => c[1]);
          if (!insideOneTarget([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])) {
            fail("image-in-target", "an inline image lies partly in a target", { name: "" });
          }
          out[i] = null;
          lost[i] = 1;
          changed = true;
          env.report.imagesRemoved++;
          touchMarkedContent();
        }
        break;
      }
      // ---------------- marked content
      case "BMC":
        mcStack.push({ index: -1 });
        break;
      case "BDC": {
        if (op.args.length !== 2 || op.args[0].type !== "name") fail("operands", "BDC with wrong operands");
        // /OC: optional content (a layer). What it draws may be hidden in every render: the pixel check
        // of the verifier cannot vouch for it (see the painting operators below)
        const oc = op.args[0].value === "OC";
        if (oc) env.ocDepth++;
        mcStack.push({ index: i, oc });
        break;
      }
      case "EMC": {
        const closed = mcStack.pop();
        if (closed?.oc) env.ocDepth--;
        break;
      }
      case "BX":
        compat++;
        break;
      case "EX":
        compat = Math.max(0, compat - 1);
        break;
      // ---------------- colour: patterns can hide text and pictures
      case "scn":
      case "SCN": {
        const last = op.args[op.args.length - 1];
        if (env.strict && last && last.type === "name") {
          const { raw, obj } = scope.entry("Pattern", last.value);
          if (A.isStream(obj)) {
            // a pattern is painted by pdf.js outside the text and operator lists the verifier reads: text in it
            // (also through the forms it draws) cannot be verified, and a picture in it would survive the path
            // that was filled with it
            const inside = env.inspectContent(raw, obj);
            if (inside.text || inside.draws) fail("pattern-text", `tiling pattern ${last.value} shows text or draws pictures or forms`);
          }
        }
        break;
      }
      // ---------------- paths: artwork in a target
      // A painted path that lies completely inside one target is dropped (underlines, strike-through lines,
      // backgrounds, outlined text). A path that only reaches into a target stays and is counted: curves, or
      // many straight segments, make the page unsupported (it could be outlined text hidden under something);
      // a few straight segments (table rules) are left to the pixel check, except inside optional content,
      // which that check may not see at all.
      case "m": {
        if (!env.strict) break;
        const [x, y] = nums(op, 2);
        cur = pathPoint(i, apply(gs.ctm, x, y));
        subStart = cur;
        break;
      }
      case "l": {
        if (!env.strict) break;
        const [x, y] = nums(op, 2);
        const p = pathPoint(i, apply(gs.ctm, x, y));
        if (cur && bboxHitsTarget([cur, p])) pathLines++;
        cur = p;
        break;
      }
      case "c": {
        if (!env.strict) break;
        const v = nums(op, 6);
        const p1 = pathPoint(i, apply(gs.ctm, v[0], v[1]));
        const p2 = pathPoint(i, apply(gs.ctm, v[2], v[3]));
        const p3 = pathPoint(i, apply(gs.ctm, v[4], v[5]));
        if (bboxHitsTarget(cur ? [cur, p1, p2, p3] : [p1, p2, p3])) pathCurves++;
        cur = p3;
        break;
      }
      case "v":
      case "y": {
        if (!env.strict) break;
        const v = nums(op, 4);
        const p1 = pathPoint(i, apply(gs.ctm, v[0], v[1]));
        const p3 = pathPoint(i, apply(gs.ctm, v[2], v[3]));
        if (bboxHitsTarget(cur ? [cur, p1, p3] : [p1, p3])) pathCurves++;
        cur = p3;
        break;
      }
      case "h":
        if (!env.strict) break;
        if (pathOps.length) pathOps.push(i);
        if (cur && subStart && bboxHitsTarget([cur, subStart])) pathLines++;
        cur = subStart;
        break;
      case "re": {
        if (!env.strict) break;
        const [x, y, w, h] = nums(op, 4);
        const c = [apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x + w, y + h), apply(gs.ctm, x, y + h)];
        for (let k = 0; k < 4; k++) {
          pathPoint(i, c[k]);
          if (bboxHitsTarget([c[k], c[(k + 1) % 4]])) pathLines++;
        }
        cur = c[0];
        subStart = c[0];
        break;
      }
      case "W":
      case "W*":
        if (pathOps.length) pathClips = true;
        break;
      case "S": case "s": case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*":
        if (env.strict && pathOps.length && pathBox) {
          if (!pathClips && insideOneTarget(pathBox)) {
            // nothing of this path shows outside the box: remove the path and its painting operator
            for (const k of pathOps) out[k] = null;
            out[i] = null;
            lost[i] = 1;
            changed = true;
            env.report.pathsRemoved++;
            touchMarkedContent();
          } else {
            if (env.ocDepth > 0 && pathCurves + pathLines > 0) {
              fail("vector-in-target", "a painted path of an optional-content layer reaches into a target", { curves: pathCurves, lines: pathLines });
            }
            env.report.vectorCurvesInTargets += pathCurves;
            env.report.vectorLinesInTargets += pathLines;
          }
        }
        resetPath();
        break;
      case "n":
        resetPath();
        break;
      default:
        if (!op.known && compat === 0) fail("unknown-operator", `unknown operator "${op.op.slice(0, 20)}"`);
    }
  }

  // ---- an advance that nothing depends on is dropped (no trace of the width of the removed text): an operation
  //      that lost all its glyphs ("pure advance"), or the end of one that lost its last glyphs ("trimmed")
  for (let i = 0; i < ops.length; i++) {
    if (!meta[i]?.pureAdvance && !meta[i]?.trimmed) continue;
    let needed = false;
    for (let j = i + 1; j < ops.length; j++) {
      if (out[j] === null) continue;
      if (meta[j]?.pureAdvance) {
        if (meta[j].prefix) break; // an emptied quote operator starts with T*: the position is reset
        continue; // another pure advance shows nothing
      }
      const name = ops[j].op;
      if (POSITION_RESET.has(name)) break;
      if (POSITION_NEUTRAL.has(name)) continue;
      needed = true;
      break;
    }
    if (needed) continue;
    if (meta[i].pureAdvance) out[i] = meta[i].prefix ? { raw: meta[i].prefix } : null;
    else out[i] = { raw: meta[i].trimmed };
  }

  // ---- /ActualText, /Alt, /E of marked-content sequences that wrap removed glyphs (or pictures, paths, forms)
  for (const i of mcTouched) {
    const op = ops[i];
    const props = op.args[1];
    const tag = formatName(op.args[0].value);
    if (props.type === "dict") {
      const mcid = props.entries.find(([k, v]) => k.value === "MCID" && v.type === "num");
      if (mcid) env.touchedMcids.add(`${owner}:${mcid[1].value}`);
      if (!props.entries.some(([k]) => STRIP_KEYS.has(k.value))) continue;
      const keptEntries = props.entries.filter(([k]) => !STRIP_KEYS.has(k.value));
      const body = keptEntries.map(([k, v]) => `${formatName(k.value)} ${String.fromCharCode(...tokenSource(source, v))}`).join(" ");
      out[i] = { raw: `${tag} <<${body}>> BDC` };
      env.report.markedContentStripped++;
      changed = true;
    } else if (props.type === "name") {
      const { obj } = scope.entry("Properties", props.value);
      if (!A.isDict(obj)) continue;
      const mcid = A.getNum(obj, "MCID");
      if (mcid !== undefined) env.touchedMcids.add(`${owner}:${mcid}`);
      if (![...STRIP_KEYS].some((k) => obj.has(A.N(k)))) continue;
      const clone = obj.clone(env.context);
      for (const k of STRIP_KEYS) clone.delete(A.N(k));
      const newName = scope.uniqueName("Properties", props.value);
      scope.newProperties.set(newName, clone);
      out[i] = { raw: `${tag} ${formatName(newName)} BDC` };
      env.report.markedContentStripped++;
      changed = true;
    }
  }

  // ---- a q ... Q group that lost what it painted and holds nothing but state operators now goes as a whole:
  //      the font, the pattern, the soft mask or the clipping path it set up for the removed content would
  //      otherwise keep the objects they name in the file
  if (groups.length && lost.some(Boolean)) {
    // 1: still paints (or is marked content, or unknown); counted per prefix, like the losses and BT - ET
    const paints = new Int32Array(ops.length + 1);
    const losses = new Int32Array(ops.length + 1);
    const texts = new Int32Array(ops.length + 1);
    for (let k = 0; k < ops.length; k++) {
      let paint = 0;
      let text = 0;
      if (out[k] !== null) {
        const stateOnly = out[k] === ops[k] ? STATE_ONLY.has(ops[k].op) : meta[k]?.pureAdvance === true;
        paint = stateOnly ? 0 : 1;
        if (out[k] === ops[k]) text = ops[k].op === "BT" ? 1 : ops[k].op === "ET" ? -1 : 0;
      }
      paints[k + 1] = paints[k] + paint;
      losses[k + 1] = losses[k] + lost[k];
      texts[k + 1] = texts[k] + text;
    }
    for (const [open, close, inTextObject] of groups) {
      if (out[open] === null || inTextObject) continue; // already gone with an outer group / part of a text object
      if (paints[close + 1] - paints[open] !== 0 || losses[close + 1] - losses[open] === 0 || texts[close + 1] - texts[open] !== 0) continue;
      for (let k = open; k <= close; k++) out[k] = null;
      env.report.groupsDropped++;
    }
  }

  // optional-content sequences this stream left open do not reach into the stream that drew it
  for (const mc of mcStack) if (mc.oc) env.ocDepth--;

  let result = null;
  if (isPage && env.normalize) changed = true;
  if (changed) {
    // comments are dropped from a rewritten stream: they can repeat the removed text
    result = serializeOperations(source, out, parsed.tailStart, { stripComments: parsed.comments });
    if (isPage) {
      // isolate the old content: q <content> Q, plus whatever the content left open (a text object, marked
      // content, a compatibility section, saved graphics states), so that what is appended starts clean
      const closers = `${inText ? "ET\n" : ""}${"EMC\n".repeat(mcStack.length)}${"EX\n".repeat(compat)}${"Q\n".repeat(stack.length + 1)}`;
      result = concatBytes(["q\n", result, "\n", closers]);
    }
  }
  return { changed, bytes: result, removed, kept, strayQ, unclosedQ: stack.length };
}

function runForm(raw, stream, parentScope, gs, env) {
  const id = A.idOf(raw);
  if (env.formStack.includes(id)) throw new RedactionUnsupported("form-recursion", "a Form XObject draws itself");
  if (env.formStack.length >= MAX_FORM_DEPTH) throw new RedactionUnsupported("form-depth", "Form XObjects nested too deeply");
  let bytes;
  try {
    bytes = A.streamBytes(stream);
  } catch (err) {
    if (err instanceof UnsupportedPdfError) throw new RedactionUnsupported("stream-decode", `Form XObject: ${err.message}`);
    throw err;
  }
  const matrix = A.numArray(A.get(stream.dict, "Matrix"), 6) ?? IDENTITY;
  const ownResources = A.get(stream.dict, "Resources");
  // a form without /Resources uses those of the content that draws it (legacy rule; pdf.js does the same)
  const scope = A.isDict(ownResources) ? new ResourceScope(ownResources, env) : parentScope;
  const ownScope = scope !== parentScope;
  const childGs = cloneGs(gs);
  childGs.ctm = mul(matrix, gs.ctm);
  // marked-content ids inside a form belong to the form's own /StructParents entry of the parent tree
  const structParents = A.getNum(stream.dict, "StructParents");
  const owner = structParents === undefined ? `form ${String(id)}` : `form:${structParents}`;
  // a form that is itself optional content (a layer) may be hidden in every render
  const layered = A.getRaw(stream.dict, "OC") !== undefined;
  env.formStack.push(id);
  env.report.formUses++;
  if (layered) env.ocDepth++;
  let res;
  try {
    res = processStream(bytes, scope, childGs, env, false, owner);
  } finally {
    env.formStack.pop();
    if (layered) env.ocDepth--;
  }
  if (!res.changed) return { changed: false, removed: res.removed, kept: res.kept };
  let signature = "";
  for (let k = 0; k < res.bytes.length; k++) signature += String.fromCharCode(res.bytes[k]);
  return {
    changed: true,
    removed: res.removed,
    kept: res.kept,
    signature,
    pending: { original: stream, originalRaw: raw, bytes: res.bytes, scope: ownScope ? scope : null }
  };
}

// ---------------------------------------------------------------- committing the changes
/**
 * The resource dictionary a rewritten content stream uses: a copy of the old one with the new entries.
 *   isolate   (the resources of a cloned form) every category that is pruned becomes a private copy and the
 *             dictionary is listed in report.clonedResources, so that pruneResources() can delete what the
 *             rewritten content no longer names without touching the form it was copied from
 */
function materializeResources(scope, env, isolate = false) {
  const { context } = env;
  const dict = scope.dict ? scope.dict.clone(context) : context.obj({});
  /** a private copy of one category (the original dictionary may be shared with other content) */
  const own = (category, create) => {
    const old = scope.category(category);
    if (!old && !create) return null;
    const copy = old ? old.clone(context) : context.obj({});
    dict.set(A.N(category), copy);
    return copy;
  };
  const emptied = scope.emptiedFonts();
  const copies = new Map();
  for (const category of ISOLATED_CATEGORIES) {
    const edited = (category === "XObject" && scope.newXObjects.size > 0) || (category === "Properties" && scope.newProperties.size > 0);
    if (isolate || edited || (category === "Font" && emptied.length > 0)) copies.set(category, own(category, edited));
  }
  for (const [name, pending] of scope.newXObjects) copies.get("XObject").set(A.N(name), materializeForm(pending, env));
  for (const [name, d] of scope.newProperties) copies.get("Properties").set(A.N(name), d);
  // the operators that select an emptied font may stay (an adjustment in a TJ needs a font size, not a font):
  // the entry is pointed at a stand-in that carries no program, no widths and no ToUnicode map
  const fonts = copies.get("Font");
  if (fonts) {
    for (const name of emptied) {
      if (!fonts.has(A.N(name))) continue;
      fonts.set(A.N(name), env.standInFont());
      env.report.fontsReleased++;
    }
  }
  if (isolate) env.report.clonedResources.push(dict);
  return dict;
}

function materializeForm(pending, env) {
  const { context } = env;
  const fresh = context.flateStream(pending.bytes);
  for (const [k, v] of pending.original.dict.entries()) {
    // (private application data, metadata and the like can hold the form as it was: the copy starts without)
    if (FORM_COPY_SKIP.has(k.decodeText())) continue;
    fresh.dict.set(k, v);
  }
  if (pending.scope) fresh.dict.set(A.N("Resources"), materializeResources(pending.scope, env, true));
  env.report.formsCloned++;
  const ref = context.register(fresh);
  env.report.replacedForms.push({ original: pending.originalRaw, clone: ref });
  return ref;
}

function pageContentBytes(pageNode, env) {
  const { context } = env;
  const contents = A.get(pageNode, "Contents");
  const streams = [];
  if (A.isStream(contents)) streams.push(contents);
  else if (A.isArray(contents)) {
    for (let i = 0; i < contents.size(); i++) {
      const s = A.resolve(context, contents.get(i));
      if (A.isStream(s)) streams.push(s);
      else if (s !== undefined) throw new RedactionUnsupported("contents", "an entry of /Contents is not a stream");
    }
  } else if (contents !== undefined) throw new RedactionUnsupported("contents", "/Contents is neither a stream nor an array");
  const chunks = [];
  for (const s of streams) {
    try {
      chunks.push(A.streamBytes(s), "\n");
    } catch (err) {
      if (err instanceof UnsupportedPdfError) throw new RedactionUnsupported("stream-decode", `page content: ${err.message}`);
      throw err;
    }
  }
  return concatBytes(chunks);
}

function inheritedResources(pageNode, env) {
  const { context } = env;
  let node = pageNode;
  for (let guard = 0; node && guard < 64; guard++) {
    const r = A.get(node, "Resources");
    if (A.isDict(r)) return r;
    node = A.resolve(context, A.getRaw(node, "Parent"));
    if (!A.isDict(node)) break;
  }
  return undefined;
}

/** Key of the stand-in font in a font cache shared between the pages of a document (never a font id). */
const STAND_IN_KEY = "stand-in font";

function makeEnv(pdfDoc, rects, options) {
  const context = pdfDoc.context;
  const fontCache = options.fontCache ?? new Map();
  const inspected = new Map();
  const given = rects.map(normRect);
  const erase = (options.eraseRects || []).map(normRect);
  // mode "text-only": every rectangle only takes glyphs
  const strictRects = options.mode === "text-only" ? [] : given;
  const env = {
    context,
    /** every rectangle that takes glyphs */
    rects: [...given, ...erase],
    /** the rectangles under which pictures and artwork must go too */
    strictRects,
    thresholds: { ...GLYPH_RULE.remove, ...(options.thresholds || {}) },
    strict: strictRects.length > 0,
    normalize: !!options.normalize,
    collect: !!options.collectQuads,
    collectAll: !!options.collectGlyphs,
    formStack: [],
    /** > 0 while the interpreter is inside optional content (a BDC /OC sequence or a form with /OC) */
    ocDepth: 0,
    touchedMcids: new Set(),
    report: {
      glyphsRemoved: 0, glyphsKept: 0, unmeasurableOps: 0, formUses: 0, formsCloned: 0, images: 0, imagesRemoved: 0, pathsRemoved: 0,
      vectorCurvesInTargets: 0, vectorLinesInTargets: 0, markedContentStripped: 0, groupsDropped: 0, fontsReleased: 0, notes: [], removedQuads: [],
      glyphs: [], replacedForms: [], clonedResources: []
    },
    fontFor(raw, obj) {
      const key = A.idOf(raw ?? obj);
      if (key === undefined) return loadFont(undefined);
      if (!fontCache.has(key)) fontCache.set(key, { info: loadFont(obj), dict: obj });
      return fontCache.get(key).info;
    },
    /** One font without program, widths or ToUnicode map per document: what an emptied /Font entry points at. */
    standInFont() {
      if (!fontCache.has(STAND_IN_KEY)) {
        fontCache.set(STAND_IN_KEY, { info: null, dict: null, ref: context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" })) });
      }
      return fontCache.get(STAND_IN_KEY).ref;
    },
    /**
     * { text, draws }: does the content of the stream, or of a Form XObject it draws (to any depth), show text /
     * paint XObjects or inline images? `resources`: the dictionary its names are looked up in when the stream
     * has none of its own (a glyph procedure). What cannot be read or found counts as both.
     */
    inspectContent(raw, stream, depth = 0, resources = undefined) {
      const key = A.idOf(raw ?? stream);
      if (inspected.has(key)) return inspected.get(key);
      const result = { text: false, draws: false };
      inspected.set(key, result); // (also ends a cycle)
      try {
        if (depth > MAX_FORM_DEPTH) throw new RangeError("forms nested too deeply");
        const { ops } = parseContentStream(A.streamBytes(stream));
        const xobjects = A.get(A.get(stream.dict, "Resources") ?? resources, "XObject");
        for (const o of ops) {
          if (TEXT_SHOW.has(o.op)) result.text = true;
          else if (o.op === "BI") result.draws = true;
          else if (o.op === "Do") {
            result.draws = true;
            const name = o.args[0]?.type === "name" ? o.args[0].value : null;
            const rawChild = name !== null && A.isDict(xobjects) ? xobjects.get(A.N(name)) : undefined;
            const child = A.resolve(context, rawChild);
            // a form that cannot be found (it would use resources this inspection does not know): the worst
            if (!A.isStream(child)) result.text = true;
            else if (A.getName(child.dict, "Subtype") === "Form" && env.inspectContent(rawChild, child, depth + 1).text) result.text = true;
          }
        }
      } catch {
        result.text = true;
        result.draws = true;
      }
      return result;
    },
    type3HasText(info) {
      if (info.charProcsHaveText !== undefined) return info.charProcsHaveText;
      let dict = null;
      for (const v of fontCache.values()) if (v.info === info) dict = v.dict;
      let has = false;
      const cps = dict ? A.get(dict, "CharProcs") : undefined;
      if (A.isDict(cps)) {
        const resources = A.get(dict, "Resources") ?? null;
        for (const [, v] of cps.entries()) {
          const s = A.resolve(context, v);
          if (!A.isStream(s)) continue;
          let b;
          try {
            b = A.streamBytes(s);
          } catch {
            has = true;
            break;
          }
          // (a glyph procedure can also show text through a Form XObject it draws)
          if (containsTextOperators(b) || env.inspectContent(v, s, 0, resources).text) {
            has = true;
            break;
          }
        }
      }
      info.charProcsHaveText = has;
      return has;
    }
  };
  return env;
}

/**
 * Removes the glyphs under `rects` from page `pageIndex` of `pdfDoc` (a PDFDocument of the library).
 *
 *   rects           [[x0, y0, x1, y1], ...] in user space: the STRICT targets (see the header)
 * options
 *   eraseRects      more rectangles, text-only: their glyphs go, nothing else under them is looked at
 *   mode            "redact" (default) | "text-only": treat `rects` as text-only too
 *   thresholds      { core, full }: shares of the core box / the full box of a glyph that must be covered for
 *                   the glyph to be removed (default GLYPH_RULE.remove = { core: 0.25, full: 0.25 })
 *   normalize       true: rewrite the page content even when no glyph is removed, so that it is wrapped in
 *                   q ... Q with balanced operators (safe to draw over afterwards)
 *   dryRun          true: interpret only, change nothing (the orchestration asks "would this work?" with it;
 *                   with collectQuads it is a preview of what goes)
 *   collectQuads    report.removedQuads = boxes of the glyphs that are (would be) removed
 *   collectGlyphs   report.glyphs = every glyph { quad, core, origin, remove, code, coverage } (tests, debugging)
 *   fontCache       a Map shared between calls on the same document
 *
 * Returns a report: { pageIndex, status: "ok" | "unsupported", reason?: { code, message, params }, changed,
 *   glyphsRemoved, glyphsKept, unmeasurableOps, formUses, formsCloned, images, imagesRemoved, pathsRemoved,
 *   vectorCurvesInTargets, vectorLinesInTargets, markedContentStripped, groupsDropped, fontsReleased,
 *   touchedMcids, replacedForms, clonedResources, strayQ, unclosedQ, notes, removedQuads, glyphs }.
 *   touchedMcids    marked-content ids whose sequence lost something: "page:<mcid>" for the page content,
 *                   "form:<StructParents>:<mcid>" for a Form XObject that has a /StructParents entry
 *   replacedForms   [{ original: PDFRef | PDFStream, clone: PDFRef }] the private copies that were made
 *   clonedResources the resource dictionaries of those copies (PDFDict): the caller prunes them together with
 *                   the dictionaries of the page (resourceUsage.pruneResources)
 *   groupsDropped   q ... Q groups that were left without anything to paint and went as a whole
 *   fontsReleased   /Font entries that showed nothing any more and point at the stand-in font now
 * With status "unsupported" the document has not been modified.
 */
export function removeTextInRects(pdfDoc, pageIndex, rects, options = {}) {
  const env = makeEnv(pdfDoc, rects, options);
  const { context, report } = env;
  const pageNode = pdfDoc.getPage(pageIndex).node;
  const base = { pageIndex, status: "ok", changed: false };
  let res;
  let scope;
  try {
    const bytes = pageContentBytes(pageNode, env);
    scope = new ResourceScope(inheritedResources(pageNode, env), env);
    res = processStream(bytes, scope, initialGs(), env, true, "page");
    if (env.strict) {
      const params = { curves: report.vectorCurvesInTargets, lines: report.vectorLinesInTargets };
      if (report.vectorCurvesInTargets > 0) {
        throw new RedactionUnsupported("vector-in-target", `${report.vectorCurvesInTargets} curve segment(s) of painted paths lie in a target (possibly outlined text)`, params);
      }
      if (report.vectorLinesInTargets > MAX_LINE_SEGMENTS_IN_TARGETS) {
        throw new RedactionUnsupported("vector-in-target", `${report.vectorLinesInTargets} line segments of painted paths lie in a target`, params);
      }
    }
  } catch (err) {
    if (err instanceof RedactionUnsupported) {
      return { ...base, ...report, status: "unsupported", reason: { code: err.code, message: err.message, params: err.params }, touchedMcids: [], clonedResources: [] };
    }
    throw err;
  }
  report.glyphsRemoved = res.removed;
  report.glyphsKept = res.kept;
  if (!options.dryRun && res.changed) {
    // ---- commit: one new content stream, copy-on-write resources (this fills report.formsCloned / replacedForms)
    const fresh = context.register(context.flateStream(res.bytes));
    pageNode.set(A.N("Contents"), fresh);
    if (scope.hasEdits()) pageNode.set(A.N("Resources"), materializeResources(scope, env));
  }
  return { ...base, ...report, changed: res.changed, strayQ: res.strayQ, unclosedQ: res.unclosedQ, touchedMcids: [...env.touchedMcids] };
}
