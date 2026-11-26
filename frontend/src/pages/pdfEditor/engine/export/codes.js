// Every code the export engine reports, with the names of its parameters. messages.js turns a code into a
// translated sentence; the engine itself holds no text for the user (the `detail` of an error is English, for
// logs only).
//
//   errors    thrown as PdfEditorError(code, params)
//   warnings  collected in report.warnings as { code, params }
//
// `source` is the id of an entry of job.sources (null when the caller gave none: inspectSource() without a
// `source` option, drawOnDocument()), `page` a 0-based index of the OUTPUT document, `objectId` the id of an
// editor object. A job that the user cancels ends with the shared code CANCELLED (../errors.js), which is not
// listed here.
import { PdfEditorError } from "../errors.js";

export const ERROR_CODES = Object.freeze({
  /** The job itself is wrong (a programming error of the caller). reason: "no-pages" | "unknown-source" |
   *  "duplicate-source" | "page-index" | "blank-size" | "rotation" | "shape" */
  EXPORT_JOB_INVALID: ["reason", "page", "source"],
  /** An object fails validateObject() of model/schema.js, or is a mark (redact / blur) that this engine never draws. */
  EXPORT_OBJECT_INVALID: ["objectId", "type", "problems"],
  /** The source is encrypted and no password (or an empty one) does not open it. */
  EXPORT_PASSWORD_REQUIRED: ["source"],
  EXPORT_PASSWORD_WRONG: ["source"],
  /** Encrypted with something the writer cannot undo (certificate security, an unknown handler). */
  EXPORT_ENCRYPTION_UNSUPPORTED: ["source"],
  /** The writer cannot read the file: no catalog, no page tree, a parser failure, a page (or a node of the page
   *  tree) with broken syntax, which the writer would pass over while a viewer may show it, or an object it needs
   *  that is written with broken syntax in a way that cannot be carried over (a string or a dictionary that is
   *  never closed: a viewer reads on behind such an object, so it means something else in every other file). */
  EXPORT_SOURCE_DAMAGED: ["source"],
  /** The writer would not read the file the way the viewer shows it. A viewer finds an object through the
   *  cross-reference sections of the file, the writer takes the last definition it meets: when the two select
   *  different definitions of an object the document uses (or when the cross-reference information is too
   *  damaged to tell), the export would hold other content than was shown. The file can be viewed, not edited.
   *  Thrown by assembleDocument() and inspectSource(). */
  EXPORT_SOURCE_INCONSISTENT: ["source"],
  /** The writer and the viewer disagree about the number of pages: every page index would be wrong. */
  EXPORT_PAGE_COUNT_MISMATCH: ["source", "writer", "viewer"],
  /** A text object without its TextLayout in `layout`. */
  EXPORT_TEXT_LAYOUT_MISSING: ["objectId"],
  /** A run asks for a character its font has no glyph for (the engine never writes .notdef). */
  EXPORT_TEXT_MISSING_GLYPH: ["objectId", "fontKey", "characters"],
  /** options.fonts is missing, failed, or returned something that is not a font. */
  EXPORT_FONT_UNAVAILABLE: ["fontKey"],
  /** An image object names an asset that is not in job.assets. */
  EXPORT_ASSET_MISSING: ["objectId", "assetId"],
  /** The bytes of an asset (or of a rasterised text, assetId null) are not a PNG / JPEG the writer can embed. */
  EXPORT_IMAGE_INVALID: ["objectId", "assetId"],
  /** The structural self-check of the output found something that must not be there; nothing was saved. */
  EXPORT_AUDIT_FAILED: ["count", "problems"],
  /** drawOnDocument() was given bytes that are not a readable, unencrypted PDF. */
  EXPORT_DOCUMENT_UNREADABLE: [],
  /** Anything unexpected; `stage` is one of STAGES. The cause is attached to the error. */
  EXPORT_FAILED: ["stage"]
});

export const WARNING_CODES = Object.freeze({
  /** The source carries digital signatures: the export is a new, unsigned document. Also from
   *  drawOnDocument() (source null) when the document it draws on is signed: the signed signature fields are
   *  taken out, because no signature survives a rewritten file. */
  EXPORT_SOURCE_SIGNED: ["source", "signatures"],
  /** An XFA form description was not carried over (the AcroForm fields were). */
  EXPORT_XFA_DROPPED: ["source"],
  /** The outline is larger than the engine reads: only the first `items` entries were considered. */
  EXPORT_OUTLINE_TRUNCATED: ["source", "items"],
  /** `items` bookmarks whose own page was removed are still in the output, because bookmarks below them lead
   *  to pages that were kept: their TITLES are in the file and they now open the page of their first kept
   *  descendant. options.dropOrphanBookmarks removes them and lifts their children one level. */
  EXPORT_OUTLINE_RETARGETED: ["source", "items"],
  /** Streams the parser had read with the wrong length were re-read from the file. */
  EXPORT_STREAMS_REPAIRED: ["source", "streams"],
  /** Streams whose length is wrong and that could not be repaired: content may be incomplete. */
  EXPORT_STREAMS_DAMAGED: ["source", "streams"],
  /** Page dictionaries without /Type were restored (the writer would have skipped them). */
  EXPORT_PAGE_TREE_REPAIRED: ["source", "pages"],
  /** `objects` objects the document uses are written with syntax the writer cannot read (a viewer usually
   *  can). They are self-contained and were copied byte for byte, with the references in them renumbered:
   *  resources, fonts and content written that way look as in the source. The writer could not look INTO
   *  them: an annotation, a form field or a bookmark written that way is left out (with a bookmark also the
   *  ones behind it on its level, which are reached only through it), and when pages were removed
   *  EXPORT_RESOURCES_NOT_PRUNED says which kept pages reach such an object. (A source with such an object
   *  that is not self-contained, or with a page or page tree node written that way, is refused:
   *  EXPORT_SOURCE_DAMAGED.) */
  EXPORT_OBJECTS_UNPARSED: ["source", "objects"],
  /** Document-level attachments exist and were not carried over (keepAttachments is off). */
  EXPORT_ATTACHMENTS_DROPPED: ["source", "files"],
  /** Pages of this source were removed, and for `pages` kept pages it could not be PROVEN that nothing of a
   *  removed page travels with them: such a page still reaches a resource dictionary of a removed page, or its
   *  content cannot be read while its own dictionary names an object that a removed page names too, or it
   *  reaches an object the writer cannot parse. Pictures or text of removed pages may remain in the file. */
  EXPORT_RESOURCES_NOT_PRUNED: ["source", "pages"],
  /** The content of a page cannot be read: what is drawn on it may land in the wrong place. */
  EXPORT_PAGE_CONTENT_UNREADABLE: ["page"],
  /** An object lies under an annotation of the source page (a comment, a form field, a stamp ...), which every
   *  viewer paints above the page content. */
  EXPORT_OBJECT_BELOW_ANNOTATION: ["page", "objectId", "subtype"]
});

/** All codes of the engine: { CODE: [parameter names] }. */
export const CODES = Object.freeze({ ...ERROR_CODES, ...WARNING_CODES });

/** Stage codes passed to onProgress(fraction, stageCode), in the order they run. */
export const STAGES = Object.freeze(["load", "copy", "draw", "structure", "save"]);

/** Throws a PdfEditorError of this engine. `detail` is English text for logs. */
export function fail(code, params = {}, detail, cause) {
  throw new PdfEditorError(code, params, { detail, cause });
}
