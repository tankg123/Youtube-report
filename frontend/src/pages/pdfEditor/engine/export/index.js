// engine/export: the new-document export of the PDF editor. Public API.
//
//   assembleDocument(job, options)                  sources + page list (+ objects) -> a NEW document
//   drawOnDocument(bytes, objectsPerPage, options)  objects on an already assembled document (after redaction)
//   inspectSource(bytes, options)                   can the writer open this file, and what should the user know
//   createPainter / drawObject / PageCanvas         the drawing layer, for callers that hold a PDFDocument
//   CODES, STAGES                                   every error / warning code and progress stage
//
// The engine holds no text for the user and touches no DOM: fonts, the clock and randomness come in through
// the options (the clock also through job.now). It never mutates the bytes it is given and keeps no state
// between calls.
//
// A source is only edited when the writer reads it the way the viewer shows it: assembleDocument() and
// inspectSource() throw EXPORT_SOURCE_INCONSISTENT for a file whose cross-reference information selects other
// objects than the writer's parser finds (robust.js): such a file is for viewing only.
//
// Annotations of a source page (comments, form fields, stamps, link borders) stay annotations. Every viewer
// paints them ABOVE the page content, and what the user adds is drawn INTO the page content (that is what
// makes added text real, searchable text and what makes a drawing permanent). An object placed over an
// annotation therefore ends up underneath it in the exported file: the report then carries the warning
// EXPORT_OBJECT_BELOW_ANNOTATION for that object.
import { PdfEditorError, isPdfEditorError, warning } from "../errors.js";
import { describeAcroForm, removeSignedSignatures } from "./acroform.js";
import { detachPageContainers } from "./copyPages.js";
import { listAttachments, readInfo } from "./docSettings.js";
import { createPacer, exportDocument, finishDocument, unexpected } from "./export.js";
import { readOutline } from "./outline.js";
import { createPainter } from "./painter.js";
import { N } from "./pdfUtil.js";
import { loadForEdit } from "./robust.js";

export { CODES, ERROR_CODES, WARNING_CODES, STAGES } from "./codes.js";
export { Canvas, PageCanvas, fontMetrics, missingCharacters } from "./draw.js";
export { checkObject, drawObject } from "./objects.js";
export { createPainter } from "./painter.js";
export { pageGeometry } from "./pageGeometry.js";
export { detectSignatures } from "./robust.js";

const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const invalidJob = (detail) => new PdfEditorError("EXPORT_JOB_INVALID", { reason: "shape", page: null, source: null }, { detail });

/** One list per page; a missing or empty entry means "nothing on this page". */
function perPage(lists, pageCount, what) {
  if (lists === undefined || lists === null) return Array.from({ length: pageCount }, () => []);
  if (!Array.isArray(lists) || lists.length > pageCount) throw invalidJob(`${what} must be an array with one entry per page`);
  return Array.from({ length: pageCount }, (_, index) => {
    const entry = lists[index];
    if (entry === undefined || entry === null) return [];
    if (!Array.isArray(entry)) throw invalidJob(`${what}[${index}] is not an array`);
    return entry;
  });
}

/**
 * Builds the new document of an export job.
 *
 * @param {object} job  ExportJob of model/schema.js: sources, pages, objects, assets, info (marks are not read
 *        here: redaction is another engine). A source may carry `info` (the document information the viewer
 *        read), used when the job's own `info` has no value for a key.
 * @param {object} [options]
 * @param {(fontKey: string) => Promise<Uint8Array>} [options.fonts]  the bytes of a bundled font face
 * @param {boolean} [options.draw]  default true: draw job.objects (and options.underlays). false: pages only
 * @param {Array<Array<{ rect: number[], color: string }>>} [options.underlays]  per output page: filled
 *        rectangles in user space painted BELOW the objects
 * @param {Date} [options.now]  the clock (dates of the file); when absent job.now, then the real clock
 * @param {Uint8Array} [options.idSeed]  the trailer /ID (16 bytes); random when absent
 * @param {string} [options.producer]
 * @param {boolean} [options.keepOutline]  default true
 * @param {boolean} [options.dropOrphanBookmarks]  default false. A bookmark whose own page was removed stays
 *        when bookmarks below it lead to kept pages (its title is then still in the file: the report counts
 *        it in sources[id].outline.retargeted and warns EXPORT_OUTLINE_RETARGETED). true drops such bookmarks
 *        and lifts their children one level
 * @param {boolean} [options.keepForms]  default true
 * @param {boolean} [options.keepAttachments]  default false
 * @param {AbortSignal} [options.signal]
 * @param {(fraction: number, stageCode: string) => void} [options.onProgress]
 * @returns {Promise<{ bytes: Uint8Array, report: object }>}
 */
export async function assembleDocument(job, options = {}) {
  if (!job || !Array.isArray(job.pages) || !Array.isArray(job.sources)) throw invalidJob("the job needs sources and pages");
  const draw = options.draw !== false;
  const pageCount = job.pages.length;
  if (draw && Array.isArray(job.objects) && job.objects.length !== pageCount) throw invalidJob("job.objects must have one entry per page");
  const objects = draw ? perPage(job.objects, pageCount, "job.objects") : [];
  const underlays = draw ? perPage(options.underlays, pageCount, "options.underlays") : [];
  const hasDrawing = objects.some((list) => list.length) || underlays.some((list) => list.length);
  const isDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());
  let painter = null;
  const { bytes, report } = await exportDocument({
    sources: job.sources.map((source) => ({ id: source?.id, bytes: source?.bytes, password: source?.password, expectedPages: source?.expectedPages, info: source?.info })),
    pages: job.pages,
    info: job.info,
    outline: options.keepOutline !== false,
    dropOrphanBookmarks: options.dropOrphanBookmarks === true,
    forms: options.keepForms !== false,
    attachments: options.keepAttachments === true,
    producer: options.producer,
    // the job carries its own clock (model/schema.js ExportJob.now): the same job gives the same file
    now: isDate(options.now) ? options.now : isDate(job.now) ? job.now : undefined,
    idSeed: options.idSeed,
    signal: options.signal,
    onProgress: options.onProgress,
    edit: hasDrawing ? async ({ outDoc, pages, report: running, tick }) => {
      painter = createPainter(outDoc, { fonts: options.fonts, assets: job.assets, warnings: running.warnings });
      await painter.prepare(objects);
      for (let index = 0; index < pages.length; index += 1) {
        await tick(index / pages.length);
        painter.drawPage(pages[index], index, objects[index], underlays[index]);
      }
    } : undefined
  });
  report.fontsEmbedded = painter ? painter.fontsEmbedded : [];
  report.imagesEmbedded = painter ? painter.imagesEmbedded : 0;
  report.objectsDrawn = painter ? painter.stats.objects : 0;
  // marks are the redaction engine's work: said out loud, so that a pipeline that forgot them can be noticed
  report.marksIgnored = Array.isArray(job.marks) ? job.marks.length : 0;
  return { bytes, report };
}

/**
 * Draws on a document that assembleDocument() built (and the redaction engine may have rewritten): first the
 * underlays of each page, then its objects from bottom to top. Everything else in the file keeps its meaning:
 * pages and their content, outline, forms, links, metadata, the trailer /ID. The result is again a
 * single-revision file without unreachable objects.
 *
 * One thing cannot keep its meaning: a signature. A signed input comes out with its signed signature fields,
 * /Perms and /DSS removed (as assembleDocument() does with a signed source) and the report says so:
 * report.signatures, and the warning EXPORT_SOURCE_SIGNED with source null.
 *
 * @param {Uint8Array} bytes  an unencrypted PDF
 * @param {object[][]} objectsPerPage  per page, bottom -> top (text objects with their TextLayout in `layout`)
 * @param {object} [options]
 * @param {(fontKey: string) => Promise<Uint8Array>} [options.fonts]
 * @param {Record<string, { bytes: Uint8Array, mime?: string }>} [options.assets]  the images the objects name
 * @param {Array<Array<{ rect: number[], color: string }>>} [options.underlays]
 * @param {AbortSignal} [options.signal]
 * @param {(fraction: number, stageCode: string) => void} [options.onProgress]
 * @returns {Promise<{ bytes: Uint8Array, report: object }>}
 */
export async function drawOnDocument(bytes, objectsPerPage, options = {}) {
  const started = clock();
  const report = { pageCount: 0, bytes: 0, warnings: [], timings: {}, fontsEmbedded: [], sources: {} };
  const tick = createPacer(options);
  let stage = "load";
  try {
    await tick(0, "load");
    let loaded;
    try {
      loaded = await loadForEdit(bytes, {});
    } catch (cause) {
      throw new PdfEditorError("EXPORT_DOCUMENT_UNREADABLE", {}, { cause, detail: "the document to draw on cannot be loaded" });
    }
    if (loaded.facts.encrypted) throw new PdfEditorError("EXPORT_DOCUMENT_UNREADABLE", {}, { detail: "the document to draw on is encrypted" });
    const doc = loaded.doc;
    const pages = doc.getPages();
    // the result is a rewritten file: no signature of the input survives it, and none may pretend to
    report.signatures = Math.max(loaded.facts.signatures.count, describeAcroForm(doc).signedFields);
    if (report.signatures) {
      removeSignedSignatures(doc);
      report.warnings.push(warning("EXPORT_SOURCE_SIGNED", { source: null, signatures: report.signatures }));
    }
    report.timings.load = Math.round(clock() - started);
    const objects = perPage(objectsPerPage, pages.length, "objectsPerPage");
    const underlays = perPage(options.underlays, pages.length, "options.underlays");

    stage = "draw";
    const drawStarted = clock();
    const painter = createPainter(doc, { fonts: options.fonts, assets: options.assets, warnings: report.warnings });
    await painter.prepare(objects);
    for (let index = 0; index < pages.length; index += 1) {
      if (!objects[index].length && !underlays[index].length) continue;
      await tick(0.2 + (0.5 * index) / pages.length, "draw");
      // a loaded page may share its /Contents array or /Resources dictionary with another page
      detachPageContainers(pages[index]);
      painter.drawPage(pages[index], index, objects[index], underlays[index]);
    }
    report.timings.draw = Math.round(clock() - drawStarted);

    stage = "save";
    await tick(0.75, "save");
    const saveStarted = clock();
    const finished = await finishDocument(doc, { allowStructTree: true });
    report.timings.save = Math.round(clock() - saveStarted);
    report.timings.total = Math.round(clock() - started);
    report.pageCount = pages.length;
    report.bytes = finished.bytes.length;
    report.audit = finished.audit;
    report.sweep = finished.sweep;
    report.fontsEmbedded = painter.fontsEmbedded;
    report.imagesEmbedded = painter.imagesEmbedded;
    report.objectsDrawn = painter.stats.objects;
    await tick(1, "save");
    return { bytes: finished.bytes, report };
  } catch (cause) {
    if (isPdfEditorError(cause)) throw cause;
    throw unexpected(cause, stage);
  }
}

/**
 * Opens a file with the WRITER and says what the user interface should know before editing starts. Throws
 * the same errors as an export would (EXPORT_PASSWORD_REQUIRED, EXPORT_PASSWORD_WRONG,
 * EXPORT_ENCRYPTION_UNSUPPORTED, EXPORT_SOURCE_DAMAGED, EXPORT_SOURCE_INCONSISTENT,
 * EXPORT_PAGE_COUNT_MISMATCH): a file the viewer shows but this function refuses can be read, not edited.
 *
 * @param {Uint8Array} bytes
 * @param {{ password?: string, source?: string, expectedPages?: number }} [options]
 * @returns {Promise<{ pages: number, encrypted: boolean, version: string, signatures: number, certified: boolean,
 *            hasSignatureField: boolean, tagged: boolean, form: object, attachments: number, outlineItems: number,
 *            info: object, warnings: Array<{ code: string, params: object }> }>}
 */
export async function inspectSource(bytes, { password, source = null, expectedPages } = {}) {
  const { doc, facts } = await loadForEdit(bytes, { password, source });
  if (expectedPages !== undefined && expectedPages !== facts.pages) {
    throw new PdfEditorError("EXPORT_PAGE_COUNT_MISMATCH", { source, writer: facts.pages, viewer: expectedPages });
  }
  const form = describeAcroForm(doc);
  const outline = readOutline(doc);
  const signatures = Math.max(facts.signatures.count, form.signedFields);
  const warnings = [];
  if (signatures) warnings.push(warning("EXPORT_SOURCE_SIGNED", { source, signatures }));
  if (form.hasXFA) warnings.push(warning("EXPORT_XFA_DROPPED", { source }));
  if (facts.repair.failed.length) warnings.push(warning("EXPORT_STREAMS_DAMAGED", { source, streams: facts.repair.failed.length }));
  if (facts.invalidObjects) warnings.push(warning("EXPORT_OBJECTS_UNPARSED", { source, objects: facts.invalidObjects }));
  return {
    pages: facts.pages,
    encrypted: facts.encrypted,
    version: facts.version,
    signatures,
    certified: facts.signatures.docMDP,
    hasSignatureField: facts.signatures.hasSigField || form.signatureFields > 0,
    tagged: doc.catalog.has(N("StructTreeRoot")), // the export does not carry the structure tree over
    form,
    attachments: listAttachments(doc).length,
    outlineItems: outline.count,
    info: readInfo(doc),
    warnings
  };
}
