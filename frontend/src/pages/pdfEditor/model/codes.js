// Codes of the document model (store, selectors, export job, clipboard): every PdfEditorError thrown by
// model/ carries one of these, with the listed parameters. messages.js turns the ones a user can run into
// into sentences; the others are programming errors of a caller and only need a generic sentence.
//
//   user-facing     MODEL_LAST_PAGE, MODEL_EMPTY_DOCUMENT, MODEL_SOURCE_BYTES_MISSING, MODEL_ASSET_BYTES_MISSING
//   caller errors   everything else (a wrong argument, an object that fails validateObject, an unknown id)
export const CODES = Object.freeze({
  // objects
  MODEL_INVALID_OBJECT: Object.freeze(["id", "type", "problems"]), // validateObject (or the text measurer) refused it; problems = string[]
  MODEL_INVALID_PATCH: Object.freeze(["id", "field"]), // a patch tried to change id / type / pageId
  MODEL_DUPLICATE_ID: Object.freeze(["id"]), // an object or a page with this id is already in the document
  MODEL_UNKNOWN_PAGE: Object.freeze(["pageId"]),
  MODEL_UNKNOWN_ASSET: Object.freeze(["assetId"]),
  // pages and sources
  MODEL_INVALID_PAGE: Object.freeze(["problems"]),
  MODEL_INVALID_PAGE_SIZE: Object.freeze(["width", "height"]),
  MODEL_INVALID_ROTATION: Object.freeze(["delta"]), // not a multiple of 90
  MODEL_INVALID_SOURCE: Object.freeze(["problems"]),
  MODEL_UNKNOWN_SOURCE: Object.freeze(["sourceId"]),
  MODEL_LAST_PAGE: Object.freeze([]), // a document needs at least one page: the deletion was refused
  // assets
  MODEL_INVALID_ASSET: Object.freeze(["problems"]),
  // commands
  MODEL_INVALID_ARGUMENT: Object.freeze(["command", "argument"]),
  MODEL_INVALID_CALL: Object.freeze(["command", "reason"]), // undo / redo / reset inside a transaction, ...
  MODEL_TRANSACTION_ASYNC: Object.freeze([]), // transaction(fn): fn returned a promise (it must be synchronous)
  // export job
  MODEL_EMPTY_DOCUMENT: Object.freeze([]), // nothing to export: the document has no page
  MODEL_INVALID_STATE: Object.freeze(["problems"]), // the document breaks an invariant (validateDocument)
  MODEL_SOURCE_BYTES_MISSING: Object.freeze(["sourceId"]), // bytes gone or detached (handed to a worker / pdf.js)
  MODEL_ASSET_BYTES_MISSING: Object.freeze(["assetId"]),
  MODEL_LAYOUT_MISSING: Object.freeze(["objectId"]), // text objects exist but no layoutText was given
  MODEL_INVALID_LAYOUT: Object.freeze(["objectId", "problems"]) // layoutText returned something that is not a TextLayout
});

/** The codes a user can cause (the interface needs a real sentence for these). */
export const USER_FACING_CODES = Object.freeze(["MODEL_LAST_PAGE", "MODEL_EMPTY_DOCUMENT", "MODEL_SOURCE_BYTES_MISSING", "MODEL_ASSET_BYTES_MISSING"]);
