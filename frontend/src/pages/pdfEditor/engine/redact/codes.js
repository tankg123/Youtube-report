// The codes of the redaction engine: every error it throws, every reason it gives for leaving the precise
// path and every warning it collects, with the names of their parameters. The engine holds no sentence for
// the user: messages.js turns { code, params } into a translated one, and a test proves that every code
// listed here can really occur (tests/pdfRedactEngine.test.mjs, "every code of CODES ...").
//
// Parameters are made for the sentence: `page` is the 1-based page number (report.pages[].pageIndex and
// report.targets[].pageIndex are 0-based; page 0 = the document as a whole), counts are numbers, and names are
// names out of the file: a font, a resource, a form field (`field`, so that the user learns WHICH field was
// emptied). No parameter ever holds text of a page.
import { warning } from "../errors.js";

export const CODES = Object.freeze({
  // ---- thrown by redactPdf() as PdfEditorError (besides CANCELLED of ../errors.js when env.signal aborts)
  /**
   * env lacks something the engine needs. missing: "env" | "openPdf" | "createCanvas" | "fonts" | "path" (not one
   * of the three) | "rasterPages" (not a list of page indexes of the document) | "random" (no CSPRNG on the
   * platform and no env.random, or a mark carries a seed and the platform has no WebCrypto) | "pdfjs"
   * (createBrowserRedactEnv) | "worker" (createBrowserRedactEnv: the pdf.js worker could not be started; the
   * reason is the `cause`)
   */
  REDACT_ENV_INVALID: Object.freeze(["missing"]),
  /**
   * targets[index] is not usable. problem: "shape" | "pageIndex" | "rect" | "mode" | "color" | "strength" |
   * "seed" (not 32 hexadecimal digits) | "page-out-of-range"
   */
  REDACT_BAD_TARGET: Object.freeze(["index", "problem"]),
  /**
   * pdf.js cannot open the input, or cannot read a page of it that the job needs (a damaged file).
   * reason: "password" | "invalid" (the pdf.js error is the `cause`)
   */
  REDACT_INPUT_UNREADABLE: Object.freeze(["reason"]),
  /**
   * The bytes that were built did not pass the final verification, or (env.path "precise") a page cannot be
   * handled precisely: nothing is returned. error.report is the report. check: "G1-removal" | "G2-preservation"
   * (text away from the marks changed, on a page with marks or on any other page of the document, or a font no
   * longer loads) | "G3-strings" | "G4-blank" | "G4-painted" | "G4-obscured" | "page-count" |
   * "output-unreadable" | "not-repeatable" | "precise-only"
   */
  REDACT_VERIFICATION_FAILED: Object.freeze(["page", "check"]),

  // ---- why a page took the raster path or stayed untouched (report.pages[].reasons), and why an "erase"
  //      target needs a cover (report.targets[].reason)
  /** env.path was "raster", or the page is listed in env.rasterPages */
  REDACT_RASTER_FORCED: Object.freeze(["page"]),
  /**
   * the PDF library cannot load the file, counts other pages than pdf.js, or reads a page without marks
   * differently from pdf.js (a damaged or doctored file): every page becomes a picture
   */
  REDACT_DOCUMENT_NOT_EDITABLE: Object.freeze(["page"]),
  /**
   * the content of the page (or of a Form XObject it draws) is not understood. detail: "content-syntax" |
   * "operands" | "text-outside-bt" | "nested-bt" | "unknown-operator" | "form-unbalanced-q" | "form-recursion" |
   * "form-depth" | "contents" | "xobject"
   */
  REDACT_CONTENT_NOT_UNDERSTOOD: Object.freeze(["page", "detail"]),
  /** a content stream uses a filter or a predictor the library cannot decode */
  REDACT_STREAM_NOT_DECODABLE: Object.freeze(["page"]),
  /** text whose position cannot be computed (font without usable widths or encoding) may lie under a mark */
  REDACT_UNMEASURABLE_TEXT: Object.freeze(["page", "font"]),
  /**
   * text or pictures are drawn where neither the remover nor the verification reaches. where: "type3" (a glyph
   * procedure that shows text, directly or through a form) | "soft-mask" (a mask that shows text, or one that
   * draws pictures over a mark) | "pattern" (a tiling pattern that shows text or draws pictures or forms)
   */
  REDACT_TEXT_IN_SUBCONTENT: Object.freeze(["page", "where"]),
  /** a glyph under a mark is part of a clipping path (text rendering modes 4 to 7) */
  REDACT_TEXT_AS_CLIP: Object.freeze(["page"]),
  /** a picture reaches into a mark without lying completely inside it (a scan, a photo). name: resource name or "" (inline image) */
  REDACT_IMAGE_IN_TARGET: Object.freeze(["page", "name"]),
  /** curves, or more than 24 straight segments, of painted paths lie in a mark (possibly text drawn as outlines) */
  REDACT_VECTOR_IN_TARGET: Object.freeze(["page", "curves", "lines"]),
  /** verification: pdf.js still finds glyphs under a mark after the precise removal */
  REDACT_GLYPHS_REMAIN: Object.freeze(["page", "count"]),
  /** verification: glyphs away from every mark moved or vanished, or glyphs appeared */
  REDACT_TEXT_DISTURBED: Object.freeze(["page", "lost", "added"]),
  /** verification: a removed string still occurs in the text of the page */
  REDACT_STRING_REMAINS: Object.freeze(["page", "count"]),
  /** verification: the region under a mark is not blank after the text was removed (artwork, a picture of text) */
  REDACT_PIXELS_REMAIN: Object.freeze(["page", "outliers", "pixels"]),

  // ---- warnings (report.warnings)
  /** a form field had a widget under a mark and more widgets elsewhere: its value was deleted everywhere */
  REDACT_FIELD_VALUE_CLEARED: Object.freeze(["page", "field", "widgets"]),
  /** a form widget was removed and the form carried XFA data (a second copy of the field values): deleted */
  REDACT_XFA_REMOVED: Object.freeze([]),
  /** a page became a picture: its annotations (links, notes, form fields) are pixels now */
  REDACT_ANNOTATIONS_FLATTENED: Object.freeze(["page", "count"]),
  /** a page became a picture and some of its text could not be put into the invisible text layer */
  REDACT_TEXT_LAYER_INCOMPLETE: Object.freeze(["page", "glyphs"]),
  /** the font of the invisible text layer could not be loaded: rasterised pages have no text layer */
  REDACT_TEXT_LAYER_UNAVAILABLE: Object.freeze(["fontKey"]),
  /**
   * text that a strict mark removed from a page is repeated in a part of the document no mark reaches, `count`
   * times. where: "outline" (bookmark titles) | "metadata" (document properties, XMP) | "form" (names, tooltips
   * and values of form fields, XFA data) | "annotation" (texts of annotations that stay) | "attachment" (an
   * attached file that is plain text, or the name of an attached file) | "other" (any other string, a script).
   * The engine leaves those parts alone; the caller decides (drop the bookmarks, clear the properties ...).
   * ("structure", the words of the structure tree, is a place the engine cleans itself: it is only reported
   * should something be left there.)
   */
  REDACT_TEXT_ELSEWHERE: Object.freeze(["where", "count"]),
  /**
   * the document carries `count` attached files and a mark removed content. The engine does not open
   * attachments (a compressed or binary file cannot be searched for the removed text): an attachment that is
   * the source of the document, or its data (an e-invoice), still holds what the mark covers.
   */
  REDACT_ATTACHMENTS_NOT_CHECKED: Object.freeze(["count"]),
  /**
   * `count` "pixelate" / "blur" marks of the job carry no seed (targets[].seed): their mosaics were drawn with
   * fresh random noise and will look different in the next export of the same document. Someone who holds
   * several exports can average them and read more of the content than one mosaic shows (measured in blur.js:
   * 16 exports of a 4-digit number leave about 9 of 13.3 bits). The caller keeps a seed with every such mark
   * (model/schema.js createSeed()) and passes it with each export.
   */
  REDACT_MOSAIC_NOT_SEEDED: Object.freeze(["count"]),
  /**
   * the font `font` (its base font name) still holds glyphs, widths or character mappings that only the
   * removed text used, and the engine could not take them out: the font program is of a kind it does not edit
   * (Type 1), or it cannot tell everything that uses the font. `pages` pages show text with the font
   * (report.fontsNotCleaned lists them): turning those pages into pictures (env.rasterPages) frees the font,
   * which then leaves the file.
   */
  REDACT_FONT_GLYPHS_REMAIN: Object.freeze(["font", "pages"])
});

/** The stage codes handed to env.onProgress(fraction, stageCode), in order. */
export const PROGRESS_STAGES = Object.freeze(["REDACT_STAGE_READ", "REDACT_STAGE_REMOVE", "REDACT_STAGE_VERIFY", "REDACT_STAGE_BUILD", "REDACT_STAGE_FINAL_CHECK"]);

/** Internal reason token of textRemoval.js -> [public code, extra parameters]. */
const FALLBACK_REASONS = Object.freeze({
  "content-syntax": ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  operands: ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  "text-outside-bt": ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  "nested-bt": ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  "unknown-operator": ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  "form-unbalanced-q": ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  "form-recursion": ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  "form-depth": ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  contents: ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  xobject: ["REDACT_CONTENT_NOT_UNDERSTOOD"],
  "stream-decode": ["REDACT_STREAM_NOT_DECODABLE"],
  "unmeasurable-text": ["REDACT_UNMEASURABLE_TEXT"],
  "type3-glyph-text": ["REDACT_TEXT_IN_SUBCONTENT", { where: "type3" }],
  "smask-text": ["REDACT_TEXT_IN_SUBCONTENT", { where: "soft-mask" }],
  "smask-image": ["REDACT_TEXT_IN_SUBCONTENT", { where: "soft-mask" }],
  "pattern-text": ["REDACT_TEXT_IN_SUBCONTENT", { where: "pattern" }],
  "clip-text": ["REDACT_TEXT_AS_CLIP"],
  "image-in-target": ["REDACT_IMAGE_IN_TARGET"],
  "vector-in-target": ["REDACT_VECTOR_IN_TARGET"]
});

/** The internal tokens (for the test that proves the table complete). */
export const FALLBACK_TOKENS = Object.freeze(Object.keys(FALLBACK_REASONS));

const NUMERIC_PARAMS = new Set(["page", "index", "count", "curves", "lines", "lost", "added", "outliers", "pixels", "widgets", "glyphs", "pages"]);

/** { code, params } with exactly the parameters CODES lists for the code (missing ones become 0 or ""). */
export function reason(code, values = {}) {
  const names = CODES[code];
  if (!names) throw new TypeError(`unknown redaction code ${code}`);
  const params = {};
  for (const name of names) params[name] = values[name] ?? (NUMERIC_PARAMS.has(name) ? 0 : "");
  return warning(code, params);
}

/** The public reason for an "unsupported" report of the remover: reason { code, message, params }. */
export function fallbackReason(internal, pageIndex) {
  const [code, extra] = FALLBACK_REASONS[internal.code] || ["REDACT_CONTENT_NOT_UNDERSTOOD"];
  return reason(code, { ...(internal.params || {}), ...(extra || {}), page: pageIndex + 1, detail: internal.code });
}
