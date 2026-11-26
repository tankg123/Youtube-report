// engine/redact: secure removal of original page content under marks (redaction, blur / pixelate, erasing
// the original line of a replaced text). Stage B of the export pipeline: it takes the bytes of a document and
// returns new bytes in which the content under the marks does not exist any more: not on screen, not for a
// text extractor, not in any byte or unreachable object of the file, and not in the fonts.
//
//   const { bytes, report } = await redactPdf(pdfBytes, targets, env);
//   const preview = await previewRemoval(source, marks, options);           (what the marks will take: see below)
//
// targets   [{ pageIndex, rect: [x0, y0, x1, y1], mode, color?, strength?, seed? }]
//             pageIndex  0-based page of pdfBytes
//             rect       in the page's PDF user space (y up, not shifted to a box, not rotated by /Rotate)
//             mode       "redact"    everything under the box goes; a box in `color` ("#rrggbb", default black)
//                                    is painted
//                        "pixelate"  the content goes; an unreadable mosaic of what was there is put in its place
//                        "blur"      the same mosaic, smoothed (a plain blur of text can be read back: blur.js)
//                        "erase"     the original line of a replaced text: only the glyphs go, nothing is
//                                    painted, the paper under them (rules, backgrounds, pictures) stays
//             color      "redact": the colour of the box. "erase": the cover colour, used only when the page
//                        becomes a picture (default there: the dominant colour of the region)
//             strength   1 | 2 | 3 for "pixelate" / "blur": the factor on the block size (1 = BLUR_DEFAULTS,
//                        the weakest setting that the attack measurement in blur.js shows to be safe)
//             seed       32 hexadecimal digits (model/schema.js createSeed(), job.marks[].seed) for "pixelate" /
//                        "blur": the noise and the grid of the mosaic then come from the seed alone (with the
//                        rectangle and the strength), not from env.random and not from the other targets: the
//                        same content under the same mark gives the SAME mosaic in every export. Without it
//                        every export draws new noise, several exports of one mark can be averaged to read
//                        more of the content, and the report carries REDACT_MOSAIC_NOT_SEEDED. Anything that
//                        is not such a string is refused (in every mode).
//
// env       { openPdf(bytes, { password }) -> pdf.js document     REQUIRED (the engine passes a private copy)
//             closePdf(doc)                                        default: doc.destroy()
//             createCanvas(width, height) -> canvas with getContext("2d")          REQUIRED
//             encodeJpeg(canvas, quality) -> Promise<Uint8Array | null>            without it pictures are lossless
//             fonts: async (fontKey) => Uint8Array                 REQUIRED (unless textLayer: false); asked for
//                                                                  LAYER_FONT_KEY ("arimo-regular") when a page
//                                                                  is rasterised
//             pdfjs: { OPS, AnnotationMode }                       of the pdf.js build behind openPdf (default:
//                                                                  the constants of the pinned pdfjs-dist 6.5.438)
//             random: () => number in [0, 1)                       noise of the mosaics WITHOUT a seed (default:
//                                                                  the CSPRNG)
//             signal: AbortSignal                                  -> PdfEditorError("CANCELLED")
//             onProgress(fraction, stageCode)                      stageCode: one of PROGRESS_STAGES
//             password                                             of an encrypted input
//             path: "hybrid" | "raster" | "precise"                "raster": every page with a strict target becomes
//                                                                  a picture; "precise": never rasterise, throw
//             rasterPages: [pageIndex, ...]                        pages that become pictures whatever their marks
//                                                                  say, also pages without marks (how the caller
//                                                                  frees a font of report.fontsNotCleaned)
//             paint: false                                         leave the regions blank (no box, no mosaic)
//             textLayer: false                                     rasterised pages get no text layer
//             fontCleanup: false                                   leave the fonts alone (they are reported)
//             verifyOtherPages: false                              skip the comparison of the pages without marks
//                                                                  (step 6). Only for an input the caller made
//                                                                  itself: a damaged or doctored file may then
//                                                                  show other content on such a page afterwards
//             thresholds, verify, dpi (200), maxPixels, imageFormat ("auto" | "jpeg" | "flate"), jpegQuality (0.85),
//             patchDpi (150), saveOptions                          tuning; the defaults are the measured ones }
//
// report    { pages:    [{ pageIndex, path: "precise" | "raster" | "untouched", reasons: [{ code, params }],
//                          targets, ok, stats, verification }]   one entry per page that has targets or is
//                                                                listed in env.rasterPages (every page when the
//                                                                whole document was rasterised)
//             targets:  [{ index, pageIndex, mode, outcome: "precise" | "raster" | "cover-needed", reason? }]
//             warnings: [{ code, params }],
//             fontsCleaned:    [{ font, codes, widths, glyphs }]  fonts that lost what only the removed text used
//                                                                (ToUnicode mappings, width entries, outlines)
//             fontsNotCleaned: [{ font, pageIndexes, reason }]  fonts that STILL hold glyphs of the removed text
//                                                                (one REDACT_FONT_GLYPHS_REMAIN warning each);
//                                                                pageIndexes: the pages that show text with the
//                                                                font. Pass them as env.rasterPages to free it.
//                                                                reason: why, as a token ("type1", "form-font",
//                                                                "usage-unknown" ...: listed in fontCleanup.js)
//             timings:  { read, precise, verify, build, verifyFinal, total } (ms),
//             inputBytes, outputBytes, precisePages, rasterPages, structureWordsStripped, streamsRepaired, garbage }
//           The report holds codes, numbers and names (fonts, resources, form fields), never text of a page.
//
// Outcomes:
//   "precise"       the content under the mark was removed from the page content; the page stays vector
//   "raster"        the page became a picture with the region burned in and an invisible text layer for the
//                   rest of its text. An "erase" target on such a page is satisfied by the picture: its
//                   pixels are painted over with the cover colour, its glyphs are not in the text layer
//   "cover-needed"  only for "erase": the line could not be removed precisely and the page was NOT
//                   rasterised for it (an erase target never causes that). The glyphs are still in the file:
//                   the caller paints a cover and must not promise that the old text is gone
//
// What happens to a page (the "strict" modes are redact, pixelate and blur):
//   1. precise path   the glyphs under the marks are cut out of the content streams (the text that stays keeps
//                     its place: checked in 2 to 0.05 pt). A Form XObject that is edited gets a private copy
//                     with private resources, so other pages that draw it keep theirs and what the copy no
//                     longer draws leaves the file. Under a strict mark also go: pictures and vector drawings
//                     that lie completely inside it, annotations and form widgets that touch it (a field that
//                     keeps widgets elsewhere loses its value: REDACT_FIELD_VALUE_CLEARED, and XFA data goes
//                     with the first widget: REDACT_XFA_REMOVED), the /ActualText of a span that loses a
//                     glyph, the words of the structure tree for it, the page thumbnail.
//   2. fonts          what the fonts still hold of the removed text goes (fontCleanup.js): a font nothing
//                     shows any more leaves the file; from a subset that other text still uses, the glyphs,
//                     widths and ToUnicode mappings that only the removed text needed are taken out. A font
//                     this cannot be done for is reported (REDACT_FONT_GLYPHS_REMAIN, report.fontsNotCleaned).
//   3. verification   pdf.js reads the unpainted candidate: no glyph under a mark (G1), every other glyph where
//                     it was and its font still loading (G2), no removed string left in the text of the page
//                     (G3), blank pixels under every strict mark (G4).
//   4. raster path    a page that fails 1 or 3 for a strict mark (a scan, a picture or a drawing that reaches
//                     into the mark, text the engine cannot measure, text or pictures inside a pattern, a soft
//                     mask or a glyph procedure ...: report.pages[].reasons) becomes one picture with the marks
//                     burned into the pixels. The solid marks are drawn once more as vector rectangles over
//                     the picture (exactly flat boxes also in a JPEG), the text outside the marks comes back
//                     as an invisible layer in the bundled Arimo, annotations become pixels
//                     (REDACT_ANNOTATIONS_FLATTENED) and the page leaves the structure tree.
//   5. paint          boxes and mosaics over the pages of the precise path. A mosaic is made from a render of
//                     the ORIGINAL page, of the mark together with the glyphs it takes, in blocks at least
//                     twice as high as that area: it shows that something is covered, not what (a short mark
//                     is often one flat colour; the measurements are in blur.js).
//   6. sweep, save, final verification of the bytes that are returned: the checks of 3 on every page with a
//      target (plus: a box is one flat colour, a mosaic holds no detail of the original), and on EVERY OTHER
//      page the comparison of what pdf.js draws from the output with what it drew from the input. A page
//      without marks that comes out differently means that the PDF library read the file in another way than
//      a viewer does (a damaged or doctored file): the document is then built from pictures only (or, with
//      only "erase" targets, not changed at all: they end "cover-needed").
//
// TAGGED PDF. The structure tree is kept and stays consistent: the marked-content ids of a precise page stay
// valid, the elements that own a span that lost a glyph (found through the parent tree AND by walking the
// tree) lose /ActualText, /Alt, /E, /T and the strings of their attributes, their ancestors lose /ActualText,
// /Alt, /E and a title that repeats the removed text, and a rasterised page is taken out of the tree (its
// kids, its entry of the parent tree, /StructParents). Words that are left anywhere in the tree and repeat
// the text a strict mark removed are deleted as well (report.structureWordsStripped): nobody could see or
// edit them in a viewer. The output of a tagged input is therefore still tagged, but a rasterised page is not
// accessible any more.
//
// What a mark does NOT reach: copies of the text elsewhere in the document (a bookmark title, the document
// properties, the name of a form field, a note on another page, an attached file). The engine reports them,
// without quoting them, as REDACT_TEXT_ELSEWHERE { where, count } and leaves the decision to the caller.
// Attached files are not opened at all: REDACT_ATTACHMENTS_NOT_CHECKED { count } says so whenever a document
// with attachments gets a strict mark.
//
// It never returns bytes that did not pass its final verification: it throws
// PdfEditorError("REDACT_VERIFICATION_FAILED", { page, check }) with error.report instead. Everything else it
// throws is a PdfEditorError too (REDACT_ENV_INVALID, REDACT_BAD_TARGET, REDACT_INPUT_UNREADABLE: also for a
// page of a damaged input that pdf.js cannot read; CANCELLED). With no target the input is returned as it is
// (the same Uint8Array). The input bytes are never modified. With the same input, targets (seeds included)
// and env.random (and the same canvas behind env.createCanvas) the output is the same, byte for byte; when
// every mosaic carries a seed, env.random does not matter either.
//
// previewRemoval(source, marks, options) -> Promise of [{ index, pageIndex, path, reason?, glyphs, boxes }]
//   What the marks will take, BEFORE an export (preview.js): a dry run of the precise path, so the answer is
//   what redactPdf() removes there, glyph for glyph. A glyph goes as a whole when a mark touches its core or
//   a quarter of its box (GLYPH_RULE): a mark with padding takes characters of the neighbouring lines, and the
//   box painted afterwards does not cover them. The interface shows the boxes while a mark is drawn or moved.
//     source    the document redactPdf() will get: its bytes (Uint8Array) or the pdf.js document opened from
//               them (PDFDocumentProxy; for the marks of one pdf.js page pass its document and pageIndex =
//               page.pageNumber - 1). The parsed document is remembered for as long as the caller keeps
//               this array or pdf.js document: calling again while a mark moves costs the dry run only
//     marks     [{ pageIndex, rect, mode? }] as targets ("redact" when the mode is missing)
//     options   { password, thresholds } (as env.password and env.thresholds of the export)
//     result    one entry per mark: path "precise" (boxes: [{ rect: [x0, y0, x1, y1], quad, glyphs, inside }] in
//               user space, one per run of glyphs on a line; `inside: false` = the run reaches beyond the
//               mark) | "raster" (the page will become a picture: nothing outside the rectangle goes; `reason`
//               is the code the report will carry) | "cover-needed" (an "erase" mark that cannot be served) |
//               "none" (not a usable mark). Counts and boxes only, never text; nothing is changed or thrown.
//   Not known before the export: a page that fails the verification there becomes a picture after all.
//
// The modules: redactPdf.js (orchestration), textRemoval.js (precise path), contentStream.js (tokenizer),
// fonts.js + stdFontData.js (glyph advances), pdfAccess.js (object helpers, the removal rule), documentScrub.js
// (annotations, forms, structure tree, copies elsewhere, garbage collection), resourceUsage.js (unused
// resources), fontCleanup.js + fontPrograms.js + cffProgram.js + cffStrings.js (what fonts hold of removed
// text), pdfjsGlyphs.js + verifyRedaction.js (the independent verification), rasterizePage.js (raster path),
// blur.js (mosaic), preview.js (what a mark will take), codes.js (CODES), browserEnv.js (env for the browser).
export { redactPdf, LAYER_FONT_KEY } from "./redactPdf.js";
export { previewRemoval } from "./preview.js";
export { createBrowserRedactEnv } from "./browserEnv.js";
export { BLUR_DEFAULTS } from "./blur.js";
export { CODES, PROGRESS_STAGES } from "./codes.js";
export { GLYPH_RULE } from "./pdfAccess.js";
export { RASTER_DEFAULTS } from "./rasterizePage.js";
export { VERIFY_DEFAULTS } from "./verifyRedaction.js";
export { PDFJS_CONSTANTS } from "./pdfjsGlyphs.js";
