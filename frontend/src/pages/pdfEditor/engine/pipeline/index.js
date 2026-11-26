// engine/pipeline: the one way out of the PDF editor. It ties the engines together (BRIEF 5.1):
//
//   A  assemble   engine/export   sources + page list -> a NEW document
//   B  redact     engine/redact   what lies under the marks is removed for real, verified by the engine
//   C  draw       engine/export   the user's objects on top
//   D  sign       engine/sign     optional: an incremental revision appended to the finished bytes
//
// DOM-free, no text for the user (codes only: messages.js has the sentences), no state between calls.
// The module pulls in the PDF library: user-interface code loads it with import(), never statically.
//
// -----------------------------------------------------------------------------------------------------------
// buildOutput(job, env, options) -> Promise<{ bytes: Uint8Array, report }>
//
//   job      the ExportJob of model/exportJob.js buildExportJob() (model/schema.js). Only read: neither the job
//            nor one of its byte arrays is changed, detached or kept.
//   env      { fonts(fontKey) -> Promise<Uint8Array>, openPdf(bytes, { password }) -> pdf.js document,
//              closePdf(doc), createCanvas(width, height), encodeJpeg(canvas, quality), pdfjs: { OPS, AnnotationMode } }
//            In the browser: createBrowserPipelineEnv(). In Node tests: redactEnv() of tests/helpers/pdfRedactKit.mjs.
//            Further properties (dpi, imageFormat ... of the redaction engine) pass through to that engine.
//   options  signal            AbortSignal: the job ends with PdfEditorError("CANCELLED")
//            onProgress        (fraction, stageCode): one fraction rising from 0 to 1 over the stages of STAGES
//                              (a stage without work is skipped; (1, "PIPELINE_STAGE_CHECK") comes only on
//                              success; what the listener throws is ignored)
//            keepOutline       default true          keepForms   default true          keepAttachments   default false
//            dropOrphanBookmarks   handed to the export engine as it is: bookmarks whose own page was removed
//                              are taken out instead of kept for their children (the answer to the warning
//                              EXPORT_OUTLINE_RETARGETED)
//            eraseFallback     what happens to a replaced text line whose glyphs could not be erased precisely:
//                              "cover" (default): an opaque rectangle in the line's cover colour (white when the
//                              mark has none) is painted under the new text. THE OLD TEXT STAYS IN THE FILE; the
//                              line is listed in report.redaction.coveredObjectIds and the report carries the
//                              warning PIPELINE_ERASE_COVERED.
//                              "redact": such lines are removed like a redaction in their cover colour (the
//                              redaction runs once more from the assembled pages with those lines as "redact"
//                              targets). Nothing of the old text stays; their page may become a picture, which
//                              the page rows of the report then say.
//            redactPath        "hybrid" (default) | "raster" (every page with a redact / pixelate / blur mark
//                              becomes a picture)
//            rasterPages       number[] (default []): 0-based OUTPUT page indices that become pictures when the
//                              marks are applied, with or without marks of their own: the answer to
//                              report.redaction.fontsNotCleaned (every page that shows text with such a font
//                              has to become a picture before the font can leave the file). They go to the
//                              redaction engine as env.rasterPages; without any mark in the job nothing is
//                              redacted and the option does nothing. A listed page that is not a picture
//                              afterwards would be named in report.redaction.rasterPagesNotApplied.
//            producer, now, idSeed    the document information and the trailer /ID of the new file (now defaults
//                              to job.now, then to the clock); random: () => [0, 1), the noise of mosaics
//                              without a seed (a blur mark of the store carries its own: marks[].seed goes to
//                              the engine as targets[].seed). Same job, now, idSeed and random give the same bytes.
//            engines           FOR TESTS: { assembleDocument, redactPdf, drawOnDocument } replacements
//
//   report   { pageCount, byteLength,
//              usedRedaction: boolean,                 job.marks was not empty
//              redaction: null | {
//                pages:   [{ pageIndex, path: "precise" | "raster" | "untouched", reasons: [{ code, params }],
//                            areas, replacedLines }]   one row per page that has marks or is listed in
//                                                      rasterPages; areas = its redact / pixelate / blur
//                                                      marks, replacedLines = its erase marks (both 0 for a
//                                                      page that became a picture on request only)
//                targets: [{ index, pageIndex, mode, outcome: "precise" | "raster" | "cover-needed", objectId,
//                            reason?, fallback? }]      one row per entry of job.marks, in that order. mode and
//                                                      objectId are the mark's; fallback "redact" = a replaced
//                                                      line that was removed like a redaction (eraseFallback)
//                coveredObjectIds: string[],           text boxes whose original line is only covered
//                elsewhere: [{ where, count }],        removed text that is repeated outside page content (the
//                                                      REDACT_TEXT_ELSEWHERE warnings, one row per place)
//                fontsNotCleaned: [{ font, pageIndexes, reason }],   fonts that still hold letter shapes of
//                                                      removed text, as the redaction engine reports them ([]
//                                                      when its report has none; reason = its token such as
//                                                      "type1" or "form-font", or null): build again with
//                                                      rasterPages = the pages of pageIndexes
//                rasterPagesNotApplied: number[]       pages of options.rasterPages that are not pictures
//              },
//              rasterizedTextObjectIds: string[],      text boxes that were exported as pictures
//              warnings: [{ code, params }],           of every stage in order, each once; then the pipeline's
//                                                      own: PIPELINE_PAGES_RASTERIZED,
//                                                      PIPELINE_PAGES_RASTERIZED_ON_REQUEST, PIPELINE_ERASE_COVERED
//              sources: { [sourceId]: { signatures, encrypted, tagged } },
//              timings: { assemble, redact, draw, check, total } }    milliseconds; without marks `draw` is
//                                                      the part of the one pass that drew the objects
//            Plain data: codes, numbers, ids of editor objects and names out of the file (a font, a form
//            field). Never text of a page.
//
//   throws   PdfEditorError. The engines' codes pass through unchanged (EXPORT_*, REDACT_*, CANCELLED), plus
//            PIPELINE_JOB_INVALID { reason, page, source, objectId, problems }   before any work starts
//            PIPELINE_ENV_INVALID { missing }
//            PIPELINE_SELF_CHECK_FAILED { check, page }                         see selfCheck.js
//            Nothing is returned then: unverified bytes never leave the pipeline.
//
// Page indices of job.marks are OUTPUT page indices (the pages of job.pages), their rectangles are in the
// user space of that page. A mark acts on the original page content only: an object of the user that lies
// over a mark is drawn afterwards and stays as it is.
//
// -----------------------------------------------------------------------------------------------------------
// signOutput(bytes, signOptions) -> Promise<{ bytes, report }>          sign.js
// verifySigned(bytes, { fieldName, trustedCertificates, now }) -> Promise<{ ok, signature, report }>
// createBrowserPipelineEnv({ pdfjs, openPdfDocument, onPdfWorkerError, fonts, createCanvas }) -> env     browserEnv.js
// inspectSource(bytes, { password, source, expectedPages }), detectSignatures(bytes)     of engine/export: can
//                                                      the writer open this file ("can it be edited?")
// STAGES, CODES                                        codes.js (library-free)
export { buildOutput } from "./buildOutput.js";
export { signOutput, verifySigned } from "./sign.js";
export { createBrowserPipelineEnv } from "./browserEnv.js";
export { CODES, STAGES } from "./codes.js";
export { detectSignatures, inspectSource } from "../export/index.js";
