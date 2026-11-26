// Codes and stages of the export pipeline (engine/pipeline). Library-free: the user interface and messages.js
// may import this file statically.
//
// The pipeline adds only a few codes of its own: everything the engines throw or report (EXPORT_*, REDACT_*,
// SIGN_*, CERT_*, TEXT_*, CANCELLED) passes through unchanged.
//
//   thrown    new PdfEditorError(code, params) by buildOutput(): nothing is returned then
//   warning   { code, params } at the END of report.warnings (after the warnings of the engines)

export const CODES = Object.freeze({
  // ---- thrown
  /**
   * The job (or an option) is not usable: a programming error of the caller, found before any work starts.
   *   reason    "shape" (job, objects, marks or assets are not what model/schema.js describes) | "no-pages" |
   *             "unknown-source" | "duplicate-source" | "page-index" | "blank-size" | "rotation" (the same words
   *             as EXPORT_JOB_INVALID) | "source-bytes" (a source in use has no bytes, or its buffer is detached)
   *             | "object" (an object fails the checks of the export engine) | "layout" (a text object without
   *             a usable TextLayout) | "asset" (an image names an asset that is not in job.assets) | "mark" (an
   *             entry of job.marks) | "option" (eraseFallback, redactPath, rasterPages ...)
   *   page      0-based index of the output page, null when the problem is not on a page
   *   source    id of the source, or null
   *   objectId  id of the object (for a mark: of the object it comes from), or null
   *   problems  string[]: the fields at fault (for "object": what checkObject() of the export engine found;
   *             for "asset": the asset id; for "mark": the field of the mark; for "option": the name of the
   *             option), or null
   */
  PIPELINE_JOB_INVALID: Object.freeze(["reason", "page", "source", "objectId", "problems"]),
  /** env lacks something every job needs. missing: "env" | "openPdf" */
  PIPELINE_ENV_INVALID: Object.freeze(["missing"]),
  /**
   * The pipeline looked at bytes it was about to hand on and refused them: nothing is returned.
   *   check   "redaction-result" (the redaction engine did not answer with bytes and one row per mark)
   *           | "redaction-unreadable" (pdf.js cannot open the redacted document)
   *           | "redaction-page-count" (it has another number of pages than the job)
   *           | "redaction-text" (text is still under a redact / pixelate / blur mark of that page)
   *           | "output-unreadable" (pdf.js cannot open the finished file)
   *           | "output-page-count" (the finished file has another number of pages than the job)
   *   page    1-based number of the page the check failed on ("redaction-text", or a page of the redacted
   *           document that pdf.js cannot read); 0 = the document as a whole
   */
  PIPELINE_SELF_CHECK_FAILED: Object.freeze(["check", "page"]),

  // ---- warnings
  /**
   * `count` pages could not be redacted precisely and are pictures now (report.redaction.pages[].path "raster"
   * says which, reasons[] why). pages: their 1-based page numbers, ascending (number[]).
   */
  PIPELINE_PAGES_RASTERIZED: Object.freeze(["count", "pages"]),
  /**
   * `count` pages are pictures now because the caller asked for it (options.rasterPages, or redactPath
   * "raster"): the reason of their page row is REDACT_RASTER_FORCED. pages: 1-based page numbers, ascending.
   */
  PIPELINE_PAGES_RASTERIZED_ON_REQUEST: Object.freeze(["count", "pages"]),
  /**
   * `count` replaced text lines could not be erased: an opaque rectangle hides each of them under the new text,
   * but the OLD TEXT IS STILL IN THE FILE (report.redaction.coveredObjectIds). Building again with
   * eraseFallback "redact" removes it for real.
   */
  PIPELINE_ERASE_COVERED: Object.freeze(["count"])
});

/** Stage codes given to onProgress(fraction, stageCode), in the order they run. */
export const STAGES = Object.freeze(["PIPELINE_STAGE_ASSEMBLE", "PIPELINE_STAGE_REDACT", "PIPELINE_STAGE_DRAW", "PIPELINE_STAGE_CHECK"]);

/** The `check` values of PIPELINE_SELF_CHECK_FAILED. */
export const SELF_CHECKS = Object.freeze(["redaction-result", "redaction-unreadable", "redaction-page-count", "redaction-text", "output-unreadable", "output-page-count"]);

/** The `reason` values of PIPELINE_JOB_INVALID. */
export const JOB_PROBLEMS = Object.freeze([
  "shape", "no-pages", "unknown-source", "duplicate-source", "page-index", "blank-size", "rotation", "source-bytes", "object", "layout", "asset",
  "mark", "option"
]);
