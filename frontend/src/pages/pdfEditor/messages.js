// Code -> sentence for everything the non-visual modules of the PDF editor report: errors (PdfEditorError),
// warnings and reasons ({ code, params } in reports), findings of the signature inspection and progress stages.
// The modules hold no text for the user; this file holds all of it, in English (the keys) with the Vietnamese
// entries in src/i18n/vi/pdfEditorMessages.js.
//
//   describeError(error, context?)        a thrown value -> sentence (anything that is not a PdfEditorError
//                                         gets the generic sentence: never the text of a raw exception)
//   describeWarning({ code, params }, context?)
//   describeCode(code, params?, context?) any code of any module; an unknown code -> the generic sentence
//   describeStage(stageCode)              "Building the document…", "Removing redacted content…", ...
//   isSilent(errorOrCode)                 CANCELLED, VIEW_PASSWORD_CANCELLED: the user did it, show nothing
//   sentencesOf(code), KNOWN_CODES, KNOWN_STAGES, WORDS    the catalogue itself, for tests
//
// A file is named by its id in the parameters of the engines (`source`). A sentence says "The file report ..."
// when it knows the name and "This file ..." when it does not. The name is known when
//   - the caller already put it in the place of the id (params.source is then anything but an id of
//     model/schema.js createId(), which looks like "s_k3x9a1"), or
//   - context = { sources: { [sourceId]: fileName } | (sourceId) => fileName } maps the id to it.
//
// Rules of the catalogue (tests/pdfMessages.test.mjs proves them):
//   * ONE entry per code of every codes.js (engine/export, engine/redact, engine/sign, engine/pipeline, model,
//     text, viewer). Codes that only a programming error can produce share the generic sentence.
//   * A {placeholder} is always a declared parameter of its code, and only one that means something to a
//     user: a page number, a file name, a font, a count, a date. Enumerated parameters (reason, check, where,
//     part, subtype ...) choose the sentence or become words through a small table; they are never printed.
//   * Page parameters that the engines count from 0 are shown from 1.
//   * A sentence says what happened and what the user can do. No identifiers, no blame.
//
// This module imports no engine entry module (only errors.js), so the editor shell can import it statically
// without pulling in the PDF library.
import { formatDate, formatDateTime, placeholdersOf, t, tk } from "../../i18n/index.js";
import { CANCELLED, isPdfEditorError } from "./engine/errors.js";

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => Boolean(value) && typeof value === "object";

// ---------------------------------------------------------------------------------------------------------
// values for placeholders
// ---------------------------------------------------------------------------------------------------------

const MISSING = "?";
const ELLIPSIS = String.fromCharCode(0x2026);

/** A name out of a file (a font, a form field, a file name) can be any length: sentences stay readable. */
function clip(value, limit = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}${ELLIPSIS}` : text;
}

/** What a placeholder shows for a raw parameter value: text and numbers as they are, lists joined. */
function display(value) {
  if (value === undefined || value === null || value === "") return MISSING;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : MISSING;
  if (Array.isArray(value)) {
    const entries = value.filter((entry) => (typeof entry === "number" && Number.isFinite(entry)) || (typeof entry === "string" && entry.trim()));
    const shown = entries.slice(0, 12).map((entry) => clip(entry, 24)).join(", ");
    return entries.length > 12 ? `${shown}, ${ELLIPSIS}` : shown || MISSING;
  }
  if (typeof value === "string" || typeof value === "boolean") return clip(value);
  return MISSING;
}

const plainValues = (params) => Object.fromEntries(Object.entries(params).map(([name, value]) => [name, display(value)]));
/** A 0-based page index of an engine as the page number a reader counts. */
const pageNumber = (index) => (Number.isInteger(index) && index >= 0 ? String(index + 1) : MISSING);
const day = (value) => formatDate(value) || MISSING;
const moment = (value) => formatDateTime(value) || MISSING;

/** "be-vietnam-pro-bold-italic" -> "Be Vietnam Pro Bold Italic", "arimo-regular" -> "Arimo". */
function fontName(fontKey) {
  if (typeof fontKey !== "string" || !fontKey) return MISSING;
  const parts = fontKey.split("-").filter((part) => part && part !== "regular");
  return clip(parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || fontKey);
}

/** A font name out of a file without the tag of a subset ("ABCDEF+Arimo" -> "Arimo"). */
function fileFontName(name) {
  if (typeof name !== "string" || !name.trim()) return MISSING;
  return clip(name.replace(/^[A-Z]{6}[+]/, "")) || MISSING;
}

/** An id of model/schema.js createId(): never shown to a user. */
const INTERNAL_ID = /^[a-z]_[a-z0-9]{3,}$/;

/** The file name behind the `source` parameter of a code, "" when it is not known (see the head of this file). */
function fileName(source, context) {
  if (typeof source !== "string" || !source) return "";
  if (isObject(context)) {
    const { sources } = context;
    let name = null;
    if (typeof sources === "function") name = sources(source);
    else if (isObject(sources) && hasOwn(sources, source)) name = sources[source];
    if (typeof name === "string" && name.trim()) return clip(name);
  }
  return INTERNAL_ID.test(source) ? "" : clip(source);
}

// ---------------------------------------------------------------------------------------------------------
// the shapes of an entry: { all: every sentence it can give, pick(params, context), fill(params, context) }
// ---------------------------------------------------------------------------------------------------------

/** One sentence. `fill` turns the parameters into the values of its placeholders. */
const fixed = (sentence, fill) => ({ all: [sentence], pick: () => sentence, fill });

/** One sentence per value of an enumerated parameter, and one for every other value. */
const byValue = (parameter, cases, otherwise, fill) => ({
  all: [...Object.values(cases), otherwise],
  pick: (params) => (hasOwn(cases, String(params[parameter])) ? cases[String(params[parameter])] : otherwise),
  fill
});

/** A sentence that names the file ({source}) when its name is known, and one that does not. */
const withFile = (named, unnamed, fill) => ({
  all: [named, unnamed],
  pick: (params, context) => (fileName(params.source, context) ? named : unnamed),
  fill: (params, context) => ({ ...(fill ? fill(params, context) : plainValues(params)), source: fileName(params.source, context) || MISSING })
});

/** A sentence for a page ({page} counted from 1) and one for the document as a whole (page 0 or absent). */
const onPage = (paged, whole, fill) => ({
  all: [paged, whole],
  pick: (params) => (Number.isInteger(params.page) && params.page > 0 ? paged : whole),
  fill
});

/** Words for the values of an enumerated parameter (looked up when the sentence is built). */
const WORD_LISTS = [];
function words(table, otherwise) {
  WORD_LISTS.push(...Object.values(table), otherwise);
  return (value) => t(hasOwn(table, String(value)) ? table[String(value)] : otherwise);
}

// ---------------------------------------------------------------------------------------------------------
// shared sentences and word tables
// ---------------------------------------------------------------------------------------------------------

// codes that only a programming error can produce, unknown codes, raw exceptions
const GENERIC = tk("Something went wrong inside the editor, so this action was not completed. Your work is still open. Try again.");
const NOT_CREATED = tk("The file could not be created. Your work is still open. Try again.");
const CERTIFICATE_FILE_DAMAGED = tk("The certificate file is damaged or incomplete and cannot be opened. Export it again from where it is kept, then choose the new file.");
const WORKING = tk("Working…");

const annotationWords = words({
  Widget: tk("a form field"),
  Stamp: tk("a stamp"),
  FreeText: tk("a text note"),
  Text: tk("a note"),
  Highlight: tk("a text marking"),
  Underline: tk("a text marking"),
  Squiggly: tk("a text marking"),
  StrikeOut: tk("a text marking"),
  Ink: tk("a drawing"),
  Line: tk("a shape"),
  Square: tk("a shape"),
  Circle: tk("a shape"),
  Polygon: tk("a shape"),
  PolyLine: tk("a shape"),
  FileAttachment: tk("an attachment icon")
}, tk("an annotation"));

const elsewhereWords = words({
  outline: tk("the outline (bookmarks)"),
  metadata: tk("the document properties"),
  form: tk("form fields (names, hints or values)"),
  annotation: tk("comments and notes"),
  attachment: tk("attached files"),
  structure: tk("the accessibility tags")
}, tk("other hidden parts of the file"));

const subcontentWords = words({
  type3: tk("a custom-drawn font"),
  "soft-mask": tk("a transparency mask"),
  pattern: tk("a fill pattern")
}, tk("a part of the page the editor cannot reach"));

const containerPartWords = words({
  "private-key": tk("the private key"),
  certificates: tk("the certificates")
}, tk("a part"));

const ignoredEntryWords = words({
  "certificate-type": tk("a certificate of an unknown kind"),
  "unreadable-certificate": tk("a certificate that cannot be read")
}, tk("an entry that cannot be used"));

// ---------------------------------------------------------------------------------------------------------
// the catalogue
// ---------------------------------------------------------------------------------------------------------

const ENTRIES = {
  // ---- shared (engine/errors.js)
  [CANCELLED]: fixed(tk("The action was cancelled.")),

  // ---- engine/export: errors
  EXPORT_JOB_INVALID: fixed(GENERIC),
  EXPORT_OBJECT_INVALID: fixed(GENERIC),
  EXPORT_PASSWORD_REQUIRED: withFile(
    tk("The file {source} is protected by a password, and the editor needs that password to change it. Open the file again and enter its password."),
    tk("This file is protected by a password, and the editor needs that password to change it. Open the file again and enter its password.")
  ),
  EXPORT_PASSWORD_WRONG: withFile(
    tk("The password does not open the file {source} for editing. Open the file again and enter the correct password."),
    tk("The password does not open this file for editing. Open the file again and enter the correct password.")
  ),
  EXPORT_ENCRYPTION_UNSUPPORTED: withFile(
    tk("The file {source} is protected in a way this editor cannot unlock (for example with a certificate). It can be read here, but not changed."),
    tk("This file is protected in a way this editor cannot unlock (for example with a certificate). It can be read here, but not changed.")
  ),
  EXPORT_SOURCE_DAMAGED: withFile(
    tk("The file {source} is damaged or built in an unusual way, and the editor cannot work with it. It can be read here, but not changed or included in a download."),
    tk("This file is damaged or built in an unusual way, and the editor cannot work with it. It can be read here, but not changed or included in a download.")
  ),
  EXPORT_SOURCE_INCONSISTENT: withFile(
    tk("The file {source} contains parts that PDF programs read in different ways, so what would be saved may differ from what is shown here. It can be read here, but not changed."),
    tk("This file contains parts that PDF programs read in different ways, so what would be saved may differ from what is shown here. It can be read here, but not changed.")
  ),
  EXPORT_PAGE_COUNT_MISMATCH: withFile(
    tk("The file {source} is damaged: {viewer} pages are shown on screen, but the editor finds {writer} pages in it. It can be read here, but not changed."),
    tk("This file is damaged: {viewer} pages are shown on screen, but the editor finds {writer} pages in it. It can be read here, but not changed.")
  ),
  EXPORT_TEXT_LAYOUT_MISSING: fixed(GENERIC),
  EXPORT_TEXT_MISSING_GLYPH: fixed(
    tk("The font {fontKey} cannot write these characters: {characters}. Choose another font for that text box or remove the characters, then try again."),
    (params) => ({ fontKey: fontName(params.fontKey), characters: clip(params.characters, 40) || MISSING })
  ),
  EXPORT_FONT_UNAVAILABLE: fixed(
    tk("The font {fontKey} could not be loaded, so the file was not created. Check your connection, then try again."),
    (params) => ({ fontKey: fontName(params.fontKey) })
  ),
  EXPORT_ASSET_MISSING: fixed(GENERIC),
  EXPORT_IMAGE_INVALID: fixed(tk("One of the pictures you added cannot be stored in a PDF. Remove that picture or add it again as PNG or JPEG, then try again.")),
  EXPORT_AUDIT_FAILED: fixed(tk("The editor checked the file it had built and found a fault in it, so nothing was saved. Your work is still open. Try again.")),
  EXPORT_DOCUMENT_UNREADABLE: fixed(NOT_CREATED),
  EXPORT_FAILED: fixed(NOT_CREATED),

  // ---- engine/export: warnings
  EXPORT_SOURCE_SIGNED: withFile(
    tk("The file {source} carries digital signatures ({signatures}). A file you download after editing is a new document: these signatures are not in it."),
    tk("This document carries digital signatures ({signatures}). A file you download after editing is a new document: these signatures are not in it.")
  ),
  EXPORT_XFA_DROPPED: withFile(
    tk("The file {source} contains a dynamic form (XFA), which this editor cannot keep. Its ordinary form fields are kept; the dynamic layout is not in the downloaded file."),
    tk("This document contains a dynamic form (XFA), which this editor cannot keep. Its ordinary form fields are kept; the dynamic layout is not in the downloaded file.")
  ),
  EXPORT_OUTLINE_TRUNCATED: withFile(
    tk("The outline of the file {source} is very long. Only its first {items} entries are in the downloaded file."),
    tk("The outline of this document is very long. Only its first {items} entries are in the downloaded file.")
  ),
  EXPORT_OUTLINE_RETARGETED: withFile(
    tk("Bookmarks that belong to pages you removed were kept in the file {source} ({items}), because bookmarks of the remaining pages are grouped under them. Their titles are still in the downloaded file and they now open the first remaining page below them: check the outline before you share the file."),
    tk("Bookmarks that belong to pages you removed were kept ({items}), because bookmarks of the remaining pages are grouped under them. Their titles are still in the downloaded file and they now open the first remaining page below them: check the outline before you share the file.")
  ),
  EXPORT_STREAMS_REPAIRED: withFile(
    tk("Damaged parts of the file {source} were repaired while it was read ({streams}). Check the pages before you share the downloaded file."),
    tk("Damaged parts of this document were repaired while it was read ({streams}). Check the pages before you share the downloaded file.")
  ),
  EXPORT_STREAMS_DAMAGED: withFile(
    tk("Parts of the file {source} are damaged and could not be repaired ({streams}). Some content may be missing from its pages: check them before you share the downloaded file."),
    tk("Parts of this document are damaged and could not be repaired ({streams}). Some content may be missing from its pages: check them before you share the downloaded file.")
  ),
  EXPORT_PAGE_TREE_REPAIRED: withFile(
    tk("The page list of the file {source} was damaged and has been repaired ({pages} entries). Check that all its pages are there."),
    tk("The page list of this document was damaged and has been repaired ({pages} entries). Check that all its pages are there.")
  ),
  EXPORT_OBJECTS_UNPARSED: withFile(
    tk("Parts of the file {source} are written in a way the editor cannot read ({objects}). They were copied as they are, so the pages look the same; a comment, a form field or a bookmark written that way is left out of the downloaded file."),
    tk("Parts of this document are written in a way the editor cannot read ({objects}). They were copied as they are, so the pages look the same; a comment, a form field or a bookmark written that way is left out of the downloaded file.")
  ),
  EXPORT_ATTACHMENTS_DROPPED: withFile(
    tk("The file {source} has attached files ({files}). They are not in the downloaded file."),
    tk("This document has attached files ({files}). They are not in the downloaded file.")
  ),
  EXPORT_RESOURCES_NOT_PRUNED: withFile(
    tk("Data of pages you removed may still be inside the downloaded file. For {pages} of the pages kept from the file {source}, the editor could not make sure that nothing of a removed page comes along with them. The removed pages are not shown, but their pictures or text might be recovered from the file. Do not share it if the removed pages are confidential."),
    tk("Data of pages you removed may still be inside the downloaded file. For {pages} of the pages you kept, the editor could not make sure that nothing of a removed page comes along with them. The removed pages are not shown, but their pictures or text might be recovered from the file. Do not share it if the removed pages are confidential.")
  ),
  EXPORT_PAGE_CONTENT_UNREADABLE: fixed(
    tk("The content of page {page} could not be read. What you added to that page may sit in a different place in the downloaded file: check that page."),
    (params) => ({ page: pageNumber(params.page) })
  ),
  EXPORT_OBJECT_BELOW_ANNOTATION: fixed(
    tk("On page {page}, something you added lies over {subtype} of the original document. In the downloaded file it appears underneath. Move it if it must stay visible."),
    (params) => ({ page: pageNumber(params.page), subtype: annotationWords(params.subtype) })
  ),

  // ---- engine/redact: thrown
  REDACT_ENV_INVALID: byValue("missing", {
    worker: tk("The part of the editor that reads PDF files could not start, so nothing was changed. Reload the page and try again.")
  }, GENERIC),
  REDACT_BAD_TARGET: fixed(GENERIC),
  REDACT_INPUT_UNREADABLE: fixed(NOT_CREATED),
  REDACT_VERIFICATION_FAILED: onPage(
    tk("The editor could not confirm that the content under the marks on page {page} was removed, so nothing was saved: a file that might still show hidden content is never created. Your work is still open. Try again."),
    tk("The editor could not confirm that the content under the marks was removed, so nothing was saved: a file that might still show hidden content is never created. Your work is still open. Try again.")
  ),

  // ---- engine/redact: why a page became a picture, or why a replaced line could not be erased
  REDACT_RASTER_FORCED: fixed(tk("Page {page} was converted to an image, as chosen for this download.")),
  REDACT_DOCUMENT_NOT_EDITABLE: onPage(
    tk("This file is built in a way that cannot be changed precisely (page {page})."),
    tk("This file is built in a way that cannot be changed precisely.")
  ),
  REDACT_CONTENT_NOT_UNDERSTOOD: fixed(tk("Page {page} is built in a way the editor cannot change precisely.")),
  REDACT_STREAM_NOT_DECODABLE: fixed(tk("The content of page {page} is stored in a format the editor cannot rewrite.")),
  REDACT_UNMEASURABLE_TEXT: fixed(
    tk("Page {page} uses the font {font}, in which the editor cannot work out where each character sits. Text in that font cannot be removed precisely."),
    (params) => ({ page: display(params.page), font: fileFontName(params.font) })
  ),
  REDACT_TEXT_IN_SUBCONTENT: fixed(
    tk("Text on page {page} is drawn inside {where}, where it cannot be removed precisely."),
    (params) => ({ page: display(params.page), where: subcontentWords(params.where) })
  ),
  REDACT_TEXT_AS_CLIP: fixed(tk("Text under a mark on page {page} is used as a cut-out shape and cannot be removed precisely.")),
  REDACT_IMAGE_IN_TARGET: fixed(tk("A picture on page {page} (for example a scan) reaches into a marked area. A part of a picture cannot be cut out precisely.")),
  REDACT_VECTOR_IN_TARGET: fixed(tk("Drawings under a mark on page {page} (possibly text drawn as outlines) cannot be removed precisely.")),
  REDACT_GLYPHS_REMAIN: fixed(tk("After the precise removal on page {page}, characters were still found under a mark ({count}).")),
  REDACT_TEXT_DISTURBED: fixed(tk("The precise removal on page {page} would have changed text outside the marked areas.")),
  REDACT_STRING_REMAINS: fixed(tk("After the precise removal on page {page}, the removed text could still be found on the page.")),
  REDACT_PIXELS_REMAIN: fixed(tk("After the text on page {page} was removed, something was still visible under a mark (for example a line, or a picture of text).")),

  // ---- engine/redact: warnings
  REDACT_FIELD_VALUE_CLEARED: fixed(tk("The form field {field} appears in several places, and one of them was under a mark on page {page}. Its value was deleted in the other places too ({widgets}), because they showed the same hidden value.")),
  REDACT_XFA_REMOVED: fixed(tk("This document kept a second, hidden copy of its form values (XFA). That copy was deleted, so that removed values cannot be read from it.")),
  REDACT_ANNOTATIONS_FLATTENED: fixed(tk("Page {page} became an image: its links, notes and form fields ({count}) are part of the picture now and no longer work.")),
  REDACT_TEXT_LAYER_INCOMPLETE: fixed(tk("Page {page} became an image. Some of its characters ({glyphs}) could not be kept as searchable text: they are visible, but cannot be found by search or copied.")),
  REDACT_TEXT_LAYER_UNAVAILABLE: fixed(tk("The font for searchable text could not be loaded, so pages that became images have no searchable text. If you need it, reload the page and download again.")),
  REDACT_TEXT_ELSEWHERE: fixed(
    tk("Text you redacted is repeated in {where}, where no mark reaches (occurrences: {count}). It is still in the downloaded file there. Remove or change it there, then download again."),
    (params) => ({ where: elsewhereWords(params.where), count: display(params.count) })
  ),
  REDACT_ATTACHMENTS_NOT_CHECKED: fixed(tk("This document has attached files ({count}), and the editor does not look inside attached files. If one of them holds the content you redacted (for example the original of this document), it can still be read there. Remove the attachments before you share the file.")),
  REDACT_MOSAIC_NOT_SEEDED: byValue("count", {
    1: tk("1 blurred area gets a new random pattern in every download. Someone who compares several downloads of this document could make out more of the hidden content than one file shows. Share only one of them.")
  }, tk("{count} blurred areas get a new random pattern in every download. Someone who compares several downloads of this document could make out more of the hidden content than one file shows. Share only one of them.")),
  REDACT_FONT_GLYPHS_REMAIN: byValue("pages", {
    1: tk("The shapes of letters you removed are still stored in the font {font}, which 1 page uses and which could not be cleaned. The removed text can no longer be read or searched, but its letter shapes could be recovered from the file. To remove them, convert that page to an image and download again.")
  }, tk("The shapes of letters you removed are still stored in the font {font}, which {pages} pages use and which could not be cleaned. The removed text can no longer be read or searched, but its letter shapes could be recovered from the file. To remove them, convert those pages to images and download again."), (params) => ({ font: fileFontName(params.font), pages: display(params.pages) })),

  // ---- engine/pipeline
  PIPELINE_JOB_INVALID: fixed(GENERIC),
  PIPELINE_ENV_INVALID: fixed(GENERIC),
  PIPELINE_SELF_CHECK_FAILED: {
    all: [
      tk("A final check found that content under the marks on page {page} might not be fully removed, so nothing was saved. Your work is still open. Try again."),
      tk("A final check found that content under the marks might not be fully removed, so nothing was saved. Your work is still open. Try again."),
      tk("The finished file did not pass the final check, so nothing was saved. Your work is still open. Try again.")
    ],
    pick(params) {
      if (!String(params.check).startsWith("redaction")) return this.all[2];
      return Number.isInteger(params.page) && params.page > 0 ? this.all[0] : this.all[1];
    }
  },
  PIPELINE_PAGES_RASTERIZED: byValue("count", {
    1: tk("1 page could not be redacted precisely and was converted to an image (page {pages}). Its remaining text stays searchable; links and form fields on that page were removed.")
  }, tk("{count} pages could not be redacted precisely and were converted to images (pages {pages}). Their remaining text stays searchable; links and form fields on those pages were removed.")),
  PIPELINE_PAGES_RASTERIZED_ON_REQUEST: byValue("count", {
    1: tk("1 page was converted to an image, as you chose (page {pages}). Its remaining text stays searchable; links and form fields on that page were removed.")
  }, tk("{count} pages were converted to images, as you chose (pages {pages}). Their remaining text stays searchable; links and form fields on those pages were removed.")),
  PIPELINE_ERASE_COVERED: byValue("count", {
    1: tk("1 text replacement was covered, not removed: the old text is hidden but still in the file. To remove it for good, download again and choose to remove the old text securely (its page may be converted to an image).")
  }, tk("{count} text replacements were covered, not removed: the old text is hidden but still in the file. To remove it for good, download again and choose to remove the old text securely (those pages may be converted to images).")),

  // ---- model
  MODEL_INVALID_OBJECT: fixed(GENERIC),
  MODEL_INVALID_PATCH: fixed(GENERIC),
  MODEL_DUPLICATE_ID: fixed(GENERIC),
  MODEL_UNKNOWN_PAGE: fixed(GENERIC),
  MODEL_UNKNOWN_ASSET: fixed(GENERIC),
  MODEL_INVALID_PAGE: fixed(GENERIC),
  MODEL_INVALID_PAGE_SIZE: fixed(tk("A page cannot have this size. Choose a width and a height between 1 and 14400 points (about 5 metres).")),
  MODEL_INVALID_ROTATION: fixed(GENERIC),
  MODEL_INVALID_SOURCE: fixed(GENERIC),
  MODEL_UNKNOWN_SOURCE: fixed(GENERIC),
  MODEL_LAST_PAGE: fixed(tk("A document needs at least one page, so the last page cannot be deleted.")),
  MODEL_INVALID_ASSET: fixed(tk("This picture could not be added. Use PNG, JPEG, WebP, GIF, BMP or SVG.")),
  MODEL_INVALID_ARGUMENT: fixed(GENERIC),
  MODEL_INVALID_CALL: fixed(GENERIC),
  MODEL_TRANSACTION_ASYNC: fixed(GENERIC),
  MODEL_EMPTY_DOCUMENT: fixed(tk("There is nothing to download: the document has no pages.")),
  MODEL_INVALID_STATE: fixed(GENERIC),
  MODEL_SOURCE_BYTES_MISSING: fixed(tk("The editor no longer holds the data of one of the opened files. Open that file again.")),
  MODEL_ASSET_BYTES_MISSING: fixed(tk("The editor no longer holds the data of one of the pictures. Add that picture again.")),
  MODEL_LAYOUT_MISSING: fixed(GENERIC),
  MODEL_INVALID_LAYOUT: fixed(GENERIC),

  // ---- text
  TEXT_FONT_MANIFEST_FAILED: fixed(tk("The fonts of the editor could not be loaded. Check your connection and reload the page.")),
  TEXT_FONT_UNKNOWN: fixed(GENERIC),
  TEXT_FONT_FETCH_FAILED: fixed(tk("The font {font} could not be loaded. Check your connection and try again."), (params) => ({ font: fontName(params.font) })),
  TEXT_FONT_CORRUPT: fixed(tk("The font {font} arrived damaged and was not used. Reload the page and try again."), (params) => ({ font: fontName(params.font) })),
  TEXT_FONT_NOT_LOADED: fixed(tk("The font {font} is still loading. Try again in a moment."), (params) => ({ font: fontName(params.font) })),
  TEXT_OBJECT_INVALID: fixed(GENERIC),
  TEXT_RASTERIZED: fixed(tk("This text contains characters that the fonts of the editor cannot write as text. The whole box is exported as a picture: it looks the same, but cannot be found by search or copied.")),
  TEXT_BASELINE_UNCERTAIN: fixed(tk("This browser reports the position of text lines in an unusual way. Text you add may sit slightly higher or lower in the downloaded file: check the result, or use a current version of Chrome, Edge or Firefox.")),
  TEXT_RASTER_FAILED: fixed(tk("The picture of a text box could not be made, so the file was not created. Remove the characters that the fonts of the editor cannot write (for example emoji), then try again.")),

  // ---- viewer
  VIEW_SOURCE_EXISTS: fixed(GENERIC),
  VIEW_SOURCE_MISSING: fixed(GENERIC),
  VIEW_PAGE_UNKNOWN: fixed(GENERIC),
  VIEW_FILE_EMPTY: fixed(tk("This file is empty. Choose another file.")),
  VIEW_INVALID_PDF: fixed(tk("This file is not a valid PDF or it is damaged.")),
  VIEW_PASSWORD_REQUIRED: fixed(tk("This PDF is protected. Enter the password to open it.")),
  VIEW_PASSWORD_INCORRECT: fixed(tk("Incorrect password. Try again.")),
  VIEW_PASSWORD_CANCELLED: fixed(tk("The file was not opened because no password was entered.")),
  VIEW_WORKER_FAILED: fixed(tk("The part of the editor that shows PDF files could not start. Reload the page and try again.")),
  VIEW_OPEN_FAILED: fixed(tk("This file could not be opened. It may be damaged, or it uses something the viewer does not support.")),
  VIEW_RENDER_FAILED: fixed(tk("Page {pageNumber} could not be displayed. Try again.")),
  VIEW_TEXT_LAYER_FAILED: fixed(tk("The text of page {pageNumber} could not be read: it cannot be selected or searched on screen. The page itself is shown correctly.")),
  VIEW_LINK_LAYER_FAILED: fixed(tk("The links on page {pageNumber} could not be read and cannot be clicked. The page itself is shown correctly.")),

  // ---- engine/sign: environment
  SIGN_NO_WEBCRYPTO: fixed(tk("Signing with a certificate needs a secure connection. Open this site with an address that starts with https, then try again.")),

  // ---- engine/sign: certificate files
  CERT_NOT_PKCS12: byValue("hint", {
    empty: tk("This file is empty. Choose your certificate file (.p12 or .pfx)."),
    pem: tk("This file holds a certificate as text (PEM). Signing needs a .p12 or .pfx file, which holds the certificate together with its private key."),
    jks: tk("This is a Java keystore. Convert it to a .p12 or .pfx file first, then choose that file."),
    pdf: tk("This is a PDF document, not a certificate file. Choose a .p12 or .pfx file."),
    zip: tk("This is a compressed archive, not a certificate file. Unpack it and choose the .p12 or .pfx file inside."),
    certificate: tk("This file holds only a certificate, without its private key. Signing needs the .p12 or .pfx file that holds both."),
    "private-key": tk("This file holds only a private key, without its certificate. Signing needs the .p12 or .pfx file that holds both.")
  }, tk("This is not a certificate file the editor can open. Choose a .p12 or .pfx file.")),
  CERT_CORRUPT: fixed(CERTIFICATE_FILE_DAMAGED),
  CERT_WRONG_PASSWORD: fixed(tk("Could not open the certificate file. Check the password.")),
  CERT_DECRYPT_FAILED: fixed(
    tk("The password opens the certificate file, but not {part} inside it. The file was probably made with two different passwords, which this editor cannot handle. Export it again with a single password."),
    (params) => ({ part: containerPartWords(params.part) })
  ),
  CERT_UNSUPPORTED_ALGORITHM: fixed(tk("This certificate file is protected with a method the browser cannot open ({algorithm}). Export it again with standard settings, then choose the new file.")),
  CERT_UNSUPPORTED_KEY_TYPE: fixed(tk("The key in this certificate file is of a kind the browser cannot sign with ({keyType}). Use a certificate with an RSA key or an elliptic-curve key (P-256, P-384 or P-521).")),
  CERT_NO_PRIVATE_KEY: fixed(tk("This certificate file contains no private key, so it cannot be used to sign. Choose the .p12 or .pfx file that holds your certificate together with its key.")),
  CERT_NO_CERTIFICATE: fixed(tk("This file contains a private key but no certificate, so it cannot be used to sign. Choose the .p12 or .pfx file that holds both.")),
  CERT_KEY_CERTIFICATE_MISMATCH: fixed(tk("The private key in this file does not belong to its certificate. The file was put together wrongly: export it again.")),
  CERT_UNREADABLE: fixed(tk("This is not a certificate the editor can read. Choose a certificate file (.cer, .crt or .pem).")),
  CERT_ASN1_MALFORMED: fixed(CERTIFICATE_FILE_DAMAGED),
  CERT_INVALID_OPTIONS: byValue("field", {
    commonName: tk("Enter a name for the certificate (at most 64 characters)."),
    country: tk("The country must be a code of two letters, for example VN."),
    email: tk("The e-mail address may only contain letters without accents, digits and the usual symbols."),
    years: tk("The validity must be between 1 and 30 years.")
  }, GENERIC),

  // ---- engine/sign: certificate warnings
  CERT_EXPIRED: fixed(tk("This certificate expired on {notAfter}. Signatures made with it after that date are not accepted as valid."), (params) => ({ notAfter: day(params.notAfter) })),
  CERT_NOT_YET_VALID: fixed(tk("This certificate is not valid before {notBefore}. Signatures made with it before that date are not accepted as valid."), (params) => ({ notBefore: day(params.notBefore) })),
  CERT_KEY_USAGE_NO_SIGNING: fixed(tk("This certificate was not issued for signing. Other programs may reject signatures made with it.")),
  CERT_KEY_USAGE_NO_NON_REPUDIATION: fixed(tk("This certificate is not marked for signing documents. Strict programs may show a warning for signatures made with it.")),
  CERT_EKU_NOT_FOR_SIGNING: fixed(tk("The permitted uses of this certificate do not include signing documents. Some programs may reject signatures made with it.")),
  CERT_IS_CA: fixed(tk("This is the certificate of a certificate authority, not of a person or organisation that signs documents. Use your own signing certificate.")),
  CERT_WEAK_KEY: fixed(tk("The key of this certificate is short ({bits} bits) and is no longer considered safe.")),
  CERT_WEAK_SIGNATURE_ALGORITHM: fixed(tk("This certificate was issued with an outdated method ({algorithm}) that is no longer considered safe.")),
  CERT_PKCS12_WEAK_ENCRYPTION: fixed(tk("This certificate file is protected with an old, weak encryption. Keep it in a safe place, or export it again with current settings.")),
  CERT_PKCS12_KEY_UNENCRYPTED: fixed(tk("The private key in this certificate file is not encrypted: anyone who gets the file can sign in your name. Export it again with a password.")),
  CERT_PKCS12_NO_MAC: fixed(tk("This certificate file has no protection against changes: a change to it would go unnoticed. Export it again with a password.")),
  CERT_PKCS12_LEGACY_PASSWORD: fixed(tk("The password of this certificate file is stored in an old form that some programs cannot read. The file was opened; consider exporting it again with a current program.")),
  CERT_PKCS12_ENTRY_IGNORED: fixed(
    tk("The certificate file contains {what}. It was skipped."),
    (params) => ({ what: ignoredEntryWords(params.what) })
  ),

  // ---- engine/sign: refusals
  SIGN_NOT_A_PDF: fixed(tk("This is not a PDF file, so it cannot be signed.")),
  SIGN_LEADING_BYTES: fixed(tk("This file has extra data before the start of the PDF ({count} bytes), so it cannot be signed as it is. Download a copy with this editor first, then sign that copy.")),
  SIGN_DAMAGED_XREF: fixed(tk("The internal index of this PDF is damaged, so a signature cannot be added to it safely. Download a copy with this editor first, then sign that copy.")),
  SIGN_ENCRYPTED: fixed(tk("This PDF is protected with a password, and a protected file cannot be signed here. Download an unprotected copy with this editor first, then sign that copy.")),
  SIGN_NO_PAGES: fixed(tk("This PDF has no pages, so there is nothing to sign.")),
  SIGN_CERTIFIED_NO_CHANGES: fixed(tk("This document was locked by its signer: no further signature is allowed. Signing or editing it would make that signature invalid.")),
  SIGN_CERTIFY_NOT_FIRST: fixed(tk("Only the first signature can lock a document. This document is already signed: sign it without locking.")),
  SIGN_BAD_OPTIONS: fixed(GENERIC),
  SIGN_BAD_SUBFILTER: fixed(GENERIC),
  SIGN_BAD_PAGE: fixed(
    tk("The signature cannot be placed on page {pageIndex}: the document has {pageCount} pages."),
    (params) => ({ pageIndex: pageNumber(params.pageIndex), pageCount: display(params.pageCount) })
  ),
  SIGN_BAD_RECT: fixed(tk("The position of the signature cannot be used. Draw the signature area again inside the page.")),
  SIGN_BAD_IMAGE: fixed(tk("The picture of the signature could not be used. Create the signature appearance again.")),
  SIGN_BAD_FIELD_NAME: fixed(GENERIC),
  SIGN_FIELD_NAME_TAKEN: fixed(tk("A signature field named {fieldName} already exists in this document and is in use. Choose another field.")),
  SIGN_UNSUPPORTED_FIELD: fixed(tk("The field {fieldName} cannot be signed by this editor. Place the signature somewhere else on the page.")),
  SIGN_BAD_SIGNER: fixed(tk("This certificate and its key cannot be used to sign. Load the certificate file again.")),
  SIGN_KEY_MISMATCH: fixed(tk("The private key does not belong to this certificate, so nothing was signed. Load the certificate file again.")),
  SIGN_WEAK_KEY: fixed(tk("The key of this certificate is too short to sign with ({bits} bits; at least 2048 are needed). Use a certificate with a stronger key.")),
  SIGN_UNSUPPORTED_KEY: fixed(tk("This kind of key ({keyType}) cannot be used to sign here. Use a certificate with an RSA key or an elliptic-curve key (P-256, P-384 or P-521).")),
  SIGN_PLACEHOLDER_TOO_SMALL: fixed(tk("The signature turned out larger than the space kept for it, so nothing was saved. Try again.")),
  SIGN_TOO_LARGE: fixed(tk("This file is too large to be signed in the browser, or the browser ran out of memory. Close other tabs and try again.")),
  SIGN_BAD_TIMESTAMP: fixed(tk("The answer of the timestamp service could not be used, so nothing was signed. Try again, or sign without a timestamp.")),
  SIGN_TIMESTAMP_REJECTED: fixed(tk("The timestamp service refused the request, so nothing was signed. Try again, or sign without a timestamp.")),
  SIGN_INTERNAL: fixed(tk("Something went wrong while signing, so nothing was saved. Your document is unchanged. Try again.")),
  SIGN_PDF_SYNTAX: fixed(GENERIC),

  // ---- engine/sign: warnings of signing
  SIGN_HYBRID_XREF: fixed(tk("This file uses an old, mixed form of its internal index. The signature was added correctly, but a few programs may have trouble checking it.")),
  SIGN_XREF_CHAIN_DAMAGED: fixed(tk("An older part of the internal index of this file is damaged. The signature was added, but strict programs may not be able to check the earlier versions of the document.")),
  SIGN_NEED_APPEARANCES: fixed(tk("This document contains a form that asks viewers to redraw its fields. Some programs may then redraw or hide a visible signature; the signature itself stays valid.")),
  SIGN_CERTIFIED: byValue("level", {
    2: tk("This document was certified by its author: only filling in forms and signing are allowed. A new signature keeps the certification valid; other changes would not."),
    3: tk("This document was certified by its author: only filling in forms, signing and commenting are allowed. A new signature keeps the certification valid; other changes would not.")
  }, tk("This document was certified by its author. Changes to it may make that certification invalid.")),
  SIGN_CERTIFIED_VISIBLE: fixed(tk("This document is certified, and a new visible signature was added to it. Strict programs may treat that as a change the certification does not allow. To be safe, sign invisibly or use a signature field the document already has.")),
  SIGN_XFA: fixed(tk("This document contains a dynamic form (XFA). Programs that show such forms may not display the signature.")),
  SIGN_FIELD_NOT_VISIBLE: fixed(tk("The signature field {fieldName} is hidden or has no size, so the signature is not visible on the page.")),
  SIGN_FIELD_NOT_ON_A_PAGE: fixed(tk("The signature field {fieldName} is not placed on any page, so the signature is not visible.")),
  SIGN_FIELD_LOCK: fixed(tk("Signing the field {fieldName} locks other form fields of this document, as its author specified.")),

  // ---- engine/sign: findings of the signature inspection
  SIGN_BYTE_RANGE_SHAPE: fixed(tk("The signature does not say correctly which part of the file it covers, so it cannot be checked.")),
  SIGN_NO_CONTENTS: fixed(tk("The signature field contains no signature data.")),
  SIGN_BYTE_RANGE_OUT_OF_FILE: fixed(tk("The signature claims to cover data beyond the end of the file. The file is damaged or was cut off.")),
  SIGN_BYTE_RANGE_NOT_FROM_START: fixed(tk("The signature does not cover the file from its beginning, so content before the signed part could have been changed.")),
  SIGN_BYTE_RANGE_GAP_MISMATCH: fixed(tk("The part of the file that the signature leaves out is not exactly the signature itself, so unsigned content could be hidden there.")),
  SIGN_COVERAGE_NOT_A_REVISION: fixed(tk("The signed part of the file does not end where a saved version of the document ends, so what the signature covers cannot be shown reliably.")),
  SIGN_CHANGED_AFTER_SIGNING: fixed(tk("The document was changed after this signature was made (later versions: {laterRevisions}). The signature is valid only for the earlier version.")),
  SIGN_LATER_REVISIONS: fixed(tk("Something was added to the file after this signature, for example another signature (later versions: {laterRevisions}). The signed version itself is unchanged.")),
  SIGN_UNSIGNED_PLACEHOLDER: fixed(tk("This signature field was prepared but never signed: it holds no signature.")),
  SIGN_CONTENTS_NOT_HEX: fixed(tk("The signature data is damaged: it contains characters that do not belong there. The signature cannot be checked.")),
  SIGN_CONTENTS_NOT_PLAIN_HEX: fixed(tk("The signature data is stored in an unusual way. It could be read, but strict programs may reject it.")),
  SIGN_CONTENTS_UNREADABLE: fixed(tk("The signature data cannot be read, so the signature cannot be checked.")),
  SIGN_CONTENTS_TRAILING_DATA: fixed(tk("Extra data follows the signature inside the space kept for it. The signature could be read, but this is unusual.")),
  SIGN_LEGACY_SUBFILTER: fixed(tk("This signature uses an outdated format that relies on methods no longer considered safe.")),
  SIGN_UNKNOWN_SUBFILTER: fixed(tk("This signature uses a format the editor does not know. It was read as a standard signature, so the result may be incomplete.")),
  SIGN_CMS_UNREADABLE: fixed(tk("The signature data is damaged or is not a standard signature. It cannot be checked.")),
  SIGN_SIGNER_COUNT: byValue("count", {
    0: tk("This signature does not name a signer, so there is nothing to check.")
  }, tk("This signature names {count} signers, although a signature in a PDF must have exactly one. Only the first was checked.")),
  SIGN_NOT_DETACHED: fixed(tk("This signature carries a copy of its own content, which is unusual in a PDF. It was checked against the document all the same.")),
  SIGN_SIGNER_CERTIFICATE_MISSING: fixed(tk("The signature does not contain the certificate of its signer, so the signer cannot be identified and the signature cannot be checked.")),
  SIGN_UNSUPPORTED_DIGEST: fixed(tk("This signature uses a checksum method the browser cannot compute ({algorithm}), so it could not be checked here. That says nothing against the signature: check it in another program.")),
  SIGN_NO_MESSAGE_DIGEST: fixed(tk("The signature does not contain the checksum of the document, so it cannot prove that the document is unchanged.")),
  SIGN_CONTENT_TYPE_MISMATCH: fixed(tk("The signature data contradicts itself about what was signed. The signature is not valid.")),
  SIGN_NO_CONTENT_TYPE: fixed(tk("The signature data lacks a standard entry that says what was signed. Strict programs may reject it.")),
  SIGN_SIGNING_CERTIFICATE_MISMATCH: fixed(tk("The signature says it was made with another certificate than the one it contains. The signer shown may not be the real signer.")),
  SIGN_PADES_NO_SIGNING_CERTIFICATE: fixed(tk("This signature does not protect the certificate of its signer the way the standard requires. Strict programs may reject it.")),
  SIGN_WEAK_DIGEST: fixed(tk("This signature uses an outdated checksum method ({algorithm}) that is no longer considered safe.")),
  SIGN_DOCUMENT_MODIFIED: fixed(tk("The document was changed after it was signed: its content no longer matches the signature.")),
  SIGN_SIGNATURE_INVALID: fixed(tk("The signature does not match the certificate of its signer. It was not made with that certificate, or it was damaged.")),
  SIGN_CANNOT_VERIFY: {
    all: [
      tk("This signature uses a method the browser cannot check ({name}), so it could not be verified here. That says nothing against the signature: check it in another program."),
      tk("This signature uses a method the browser cannot check, so it could not be verified here. That says nothing against the signature: check it in another program.")
    ],
    pick(params) {
      return typeof params.name === "string" && params.name ? this.all[0] : this.all[1];
    }
  },
  SIGN_NO_SIGNING_TIME: fixed(tk("The signature does not say when it was made.")),
  SIGN_TIME_MISMATCH: fixed(
    tk("The signing time stated by the signer ({claimed}) differs from the time of the timestamp in the signature ({timestamp}). The timestamp service was not verified here, so neither time is proven."),
    (params) => ({ claimed: moment(params.claimed), timestamp: moment(params.timestamp) })
  ),
  SIGN_SIGNER_CERTIFICATE_ALTERED: fixed(tk("The certificate of the signer was altered: its own signature does not verify. The name of the signer cannot be relied on.")),
  SIGN_SIGNER_NAME_UNPROTECTED: fixed(tk("Nothing in this signature protects the certificate that names the signer: the name shown is only a claim.")),
  SIGN_CHAIN_BROKEN: fixed(tk("One of the issuer certificates that come with the signature does not verify, so the chain to the issuing authority is broken.")),
  SIGN_ENCRYPTED_STRINGS: fixed(tk("The reason, name and date of this signature are encrypted together with the document. Enter the password of the document to read them.")),
  SIGN_NOT_REFERENCED: fixed(tk("This signature is still in the file, but the current version of the document no longer refers to it: it was removed or replaced.")),
  SIGN_DOCMDP_VIOLATION: fixed(tk("This signature locked the document against every change, but another signature was added later. That breaks the lock.")),
  SIGN_INSPECTION_FAILED: fixed(tk("This signature could not be examined here. That says nothing against the signature: check it in another program.")),
  CERT_EXPIRED_AT_SIGNING: fixed(tk("The certificate of the signer had already expired on {notAfter}, before the document was signed."), (params) => ({ notAfter: day(params.notAfter) })),
  CERT_NOT_YET_VALID_AT_SIGNING: fixed(tk("The certificate of the signer was not valid yet when the document was signed (valid from {notBefore})."), (params) => ({ notBefore: day(params.notBefore) })),
  CERT_EXPIRED_SINCE: byValue("timeProven", {
    true: tk("The certificate of the signer expired on {notAfter}. A timestamp in the signature says that it was made before that date, but the timestamp service was not verified here, so that time is not proven.")
  }, tk("The certificate of the signer expired on {notAfter}. The signature says it was made before that date, but no timestamp proves it."), (params) => ({ notAfter: day(params.notAfter) })),
  SIGN_TIMESTAMP_UNREADABLE: fixed(tk("The timestamp of this signature cannot be read, so the signing time is not proven.")),
  SIGN_TIMESTAMP_NOT_TSTINFO: fixed(tk("The timestamp of this signature is not a real timestamp, so the signing time is not proven.")),
  SIGN_TIMESTAMP_MALFORMED: fixed(tk("The timestamp of this signature is damaged, so the signing time is not proven.")),
  SIGN_TIMESTAMP_IMPRINT_MISMATCH: fixed(tk("The timestamp belongs to other data than this signature, so the signing time is not proven.")),
  SIGN_TIMESTAMP_UNSUPPORTED_DIGEST: fixed(tk("The timestamp uses a checksum method the browser cannot compute ({algorithm}), so it could not be checked here.")),
  SIGN_TIMESTAMP_NO_SIGNER: fixed(tk("The timestamp is not signed by anyone, so the signing time is not proven.")),
  SIGN_TIMESTAMP_SIGNATURE_INVALID: fixed(tk("The signature of the timestamp service does not verify, so the signing time is not proven.")),
  SIGN_TSA_CERTIFICATE_USAGE: fixed(tk("The certificate of the timestamp service was not issued for making timestamps. Strict programs may reject the timestamp.")),
  SIGN_TSA_CERTIFICATE_NOT_VALID_AT_TIME: fixed(tk("The certificate of the timestamp service was not valid at the time of the timestamp. Strict programs may reject the timestamp.")),
  SIGN_TSA_CERTIFICATE_MISSING: fixed(tk("The timestamp does not contain the certificate of its service, so it could not be checked.")),

  // ---- engine/sign: what a later version changed (allowed)
  SIGN_CHANGE_SIGNATURE_FIELD_ADDED: fixed(tk("A signature field was added.")),
  SIGN_CHANGE_SIGNATURE_WIDGET_ADDED: fixed(tk("A signature was placed on page {page}.")),
  SIGN_CHANGE_SIGNATURE_FIELD_FILLED: fixed(tk("A signature field that already existed was signed.")),
  SIGN_CHANGE_METADATA: fixed(tk("The document properties were updated.")),
  SIGN_CHANGE_VALIDATION_DATA: fixed(tk("Information for checking signatures later was added (certificates and their revocation status).")),
  SIGN_CHANGE_CATALOG_ENTRY: fixed(tk("A document setting that signing may update was changed.")),
  // ---- engine/sign: what a later version changed (not allowed)
  SIGN_CHANGE_CATALOG_REPLACED: fixed(tk("The root of the document was replaced: everything in it may be different.")),
  SIGN_CHANGE_CATALOG_OTHER_ENTRY: fixed(tk("A setting of the whole document was changed.")),
  SIGN_CHANGE_PAGE_COUNT: fixed(tk("The number of pages changed from {before} to {after}.")),
  SIGN_CHANGE_PAGE_REPLACED: fixed(tk("Page {page} was replaced.")),
  SIGN_CHANGE_PAGE_CONTENT: fixed(tk("The content of page {page} was changed.")),
  SIGN_CHANGE_PAGE_ENTRY: fixed(tk("A property of page {page} was changed (for example its size, its rotation or what it draws with).")),
  SIGN_CHANGE_ANNOTATION_REMOVED: fixed(tk("A comment, a link or a form field was removed from page {page}.")),
  SIGN_CHANGE_ANNOTATION_ADDED: fixed(tk("A comment, a link or a form field was added to page {page}.")),
  SIGN_CHANGE_FORM_ENTRY: fixed(tk("A setting of the form was changed.")),
  SIGN_CHANGE_FORM_REPLACED: fixed(tk("The form of the document was replaced.")),
  SIGN_CHANGE_FIELD_REMOVED: fixed(tk("A form field was removed.")),
  SIGN_CHANGE_FIELD_ADDED: fixed(tk("A form field was added.")),
  SIGN_CHANGE_SIGNATURE_FIELD_ALTERED: fixed(tk("A signature field that already existed was altered.")),
  SIGN_CHANGE_OBJECT: fixed(tk("Something inside the document was changed that is neither a page nor a form field.")),
  SIGN_CHANGE_OBJECT_REMOVED: fixed(tk("A part of the signed document was deleted afterwards: a viewer may now show something else than what was signed.")),
  SIGN_CHANGE_DANGLING_REFERENCE: fixed(tk("The signed document pointed at a part that did not exist yet. It was supplied later, so a viewer may show something else than what was signed.")),
  SIGN_CHANGE_XREF: byValue("reason", {
    chain: tk("The part of the file added after the signature no longer leads back to the signed version: parts of that version are lost or point elsewhere."),
    redirected: tk("A part of the signed document was pointed at other data afterwards: a viewer may show something else than what was signed."),
    ambiguous: tk("A part of the document is defined in two ways, so different programs may show different content."),
    encryption: tk("The protection settings of the document were changed after it was signed."),
    unreadable: tk("The index that was added after the signature cannot be read, so later changes could not be examined.")
  }, tk("The internal index of the document was changed after it was signed, in a way that can alter what a viewer shows."))
};

const STAGE_SENTENCES = {
  // engine/pipeline (what the user interface sees)
  PIPELINE_STAGE_ASSEMBLE: tk("Building the document…"),
  PIPELINE_STAGE_REDACT: tk("Removing redacted content…"),
  PIPELINE_STAGE_DRAW: tk("Adding your changes…"),
  PIPELINE_STAGE_CHECK: tk("Checking the result…"),
  // engine/export
  load: tk("Reading the files…"),
  copy: tk("Copying the pages…"),
  draw: tk("Adding your changes…"),
  structure: tk("Rebuilding the outline and forms…"),
  save: tk("Writing the file…"),
  // engine/redact
  REDACT_STAGE_READ: tk("Reading the pages…"),
  REDACT_STAGE_REMOVE: tk("Removing the marked content…"),
  REDACT_STAGE_VERIFY: tk("Checking the removal…"),
  REDACT_STAGE_BUILD: tk("Building the redacted pages…"),
  REDACT_STAGE_FINAL_CHECK: tk("Verifying the result…")
};

const SILENT_CODES = new Set([CANCELLED, "VIEW_PASSWORD_CANCELLED"]);

// ---------------------------------------------------------------------------------------------------------
// public functions
// ---------------------------------------------------------------------------------------------------------

/**
 * The sentence for a code of any module, in the current language.
 * @param {string} code
 * @param {Record<string, unknown>} [params]  the parameters the module reported with the code
 * @param {{ sources?: Record<string, string> | ((sourceId: string) => string) }} [context]  file names by source id
 * @returns {string} never empty; the generic sentence for a code this file does not know
 */
export function describeCode(code, params, context) {
  try {
    const entry = typeof code === "string" && hasOwn(ENTRIES, code) ? ENTRIES[code] : null;
    if (!entry) return t(GENERIC);
    const given = isObject(params) ? params : {};
    const sentence = entry.pick(given, context);
    const values = { ...(entry.fill ? entry.fill(given, context) : plainValues(given)) };
    // a parameter the module did not send leaves a question mark, never a "{placeholder}"
    for (const name of placeholdersOf(sentence)) if (!hasOwn(values, name) || values[name] === "") values[name] = MISSING;
    const text = t(sentence, values);
    return typeof text === "string" && text ? text : t(GENERIC);
  } catch {
    // a sentence must never be the reason an error cannot be shown
    return t(GENERIC);
  }
}

/**
 * The sentence for anything that was thrown. A PdfEditorError is described by its code and parameters; every
 * other value (a TypeError of a bug, a rejected fetch ...) gets the generic sentence: the text of a raw
 * exception may hold internals or content of the document and is never shown.
 */
export function describeError(error, context) {
  if (isPdfEditorError(error)) return describeCode(error.code, error.params, context);
  return t(GENERIC);
}

/** The sentence for a warning, a reason or a finding of a report: { code, params }. */
export function describeWarning(entry, context) {
  return describeCode(entry?.code, entry?.params, context);
}

/** The line of a progress display for a stage code of the pipeline or of an engine. */
export function describeStage(stageCode) {
  return t(typeof stageCode === "string" && hasOwn(STAGE_SENTENCES, stageCode) ? STAGE_SENTENCES[stageCode] : WORKING);
}

/** True for what the user did on purpose (a cancelled job, a closed password prompt): nothing is shown for it. */
export function isSilent(errorOrCode) {
  const code = typeof errorOrCode === "string" ? errorOrCode : isPdfEditorError(errorOrCode) ? errorOrCode.code : null;
  return code !== null && SILENT_CODES.has(code);
}

// ---------------------------------------------------------------------------------------------------------
// the catalogue itself, for tests
// ---------------------------------------------------------------------------------------------------------

/** Every code this file has an entry for. */
export const KNOWN_CODES = Object.freeze(Object.keys(ENTRIES));
/** Every stage code this file has a line for. */
export const KNOWN_STAGES = Object.freeze(Object.keys(STAGE_SENTENCES));
/** The English sentences (= dictionary keys) a code can give; [] for a code without an entry. */
export const sentencesOf = (code) => (typeof code === "string" && hasOwn(ENTRIES, code) ? [...new Set(ENTRIES[code].all)] : []);
/** The English line of a stage code, or null. */
export const stageSentenceOf = (stageCode) => (typeof stageCode === "string" && hasOwn(STAGE_SENTENCES, stageCode) ? STAGE_SENTENCES[stageCode] : null);
/** The words that stand in for enumerated parameter values (English = dictionary keys). */
export const WORDS = Object.freeze([...new Set(WORD_LISTS)]);
/** The sentence shared by codes of programming errors, unknown codes and raw exceptions (English). */
export const GENERIC_SENTENCE = GENERIC;
