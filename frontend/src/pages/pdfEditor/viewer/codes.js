// Every code the viewer reports, with the names of its parameters (see ../engine/errors.js). The viewer never
// holds a sentence for the user: messages.js turns these codes into translated text.
//
// Thrown as PdfEditorError by the controller's promises:
//   openSource       VIEW_SOURCE_EXISTS, VIEW_FILE_EMPTY, VIEW_INVALID_PDF, VIEW_PASSWORD_REQUIRED,
//                    VIEW_PASSWORD_INCORRECT, VIEW_PASSWORD_CANCELLED, VIEW_WORKER_FAILED, VIEW_OPEN_FAILED,
//                    and CANCELLED (closeSource / dispose / AbortSignal while the file was opening)
//   getTextLines, renderToCanvas, sampleColors
//                    VIEW_PAGE_UNKNOWN, VIEW_SOURCE_MISSING, VIEW_RENDER_FAILED, CANCELLED
// Reported through the "pageerror" event and the render state "error" of a page (never thrown):
//                    VIEW_RENDER_FAILED, VIEW_TEXT_LAYER_FAILED, VIEW_LINK_LAYER_FAILED
export const CODES = Object.freeze({
  // openSource(sourceId, ...) was called with an id that is already open or opening
  VIEW_SOURCE_EXISTS: Object.freeze(["sourceId"]),
  // a page of the list names a source that is not open (the page stays "pending" on screen)
  VIEW_SOURCE_MISSING: Object.freeze(["sourceId"]),
  // the page id is not in the list given to setPages()
  VIEW_PAGE_UNKNOWN: Object.freeze(["pageId"]),
  // zero bytes
  VIEW_FILE_EMPTY: Object.freeze([]),
  // not a PDF, truncated, or damaged beyond what pdf.js repairs
  VIEW_INVALID_PDF: Object.freeze([]),
  // the file is encrypted and neither a password nor an onPassword callback was given
  VIEW_PASSWORD_REQUIRED: Object.freeze([]),
  // the password given in the options is wrong and there is no onPassword callback to ask again
  VIEW_PASSWORD_INCORRECT: Object.freeze([]),
  // onPassword answered null: the user closed the password prompt
  VIEW_PASSWORD_CANCELLED: Object.freeze([]),
  // the pdf.js worker could not be started or crashed while the file was opening
  VIEW_WORKER_FAILED: Object.freeze([]),
  // pdf.js refused the file for another reason; `reason` is the name of its exception (for logs)
  VIEW_OPEN_FAILED: Object.freeze(["reason"]),
  // a page could not be drawn; `pageNumber` is the 1-based position in the list
  VIEW_RENDER_FAILED: Object.freeze(["pageNumber"]),
  // the page is drawn but its text cannot be selected or searched on screen
  VIEW_TEXT_LAYER_FAILED: Object.freeze(["pageNumber"]),
  // the page is drawn but its links are not clickable
  VIEW_LINK_LAYER_FAILED: Object.freeze(["pageNumber"])
});
