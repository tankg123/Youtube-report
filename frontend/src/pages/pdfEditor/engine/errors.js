// Errors and warnings of the PDF editor's engines.
//
// The engines (engine/, viewer/, model/, text/) never contain text for the user: they report a stable CODE
// plus parameters, and the user interface turns the code into a translated sentence (messages.js). The
// `message` of the error is an English sentence for developers and logs only.
//
//   throw new PdfEditorError("PDF_PASSWORD_REQUIRED");
//   throw new PdfEditorError("PAGE_COUNT_MISMATCH", { writer: 3, viewer: 4 }, { cause: error });
//
// Codes are UPPER_SNAKE_CASE and unique across the editor; each engine lists its codes in its own
// `codes.js` (or at the top of its entry module) so that messages.js can cover all of them.
//
// An error may carry more than its code: engine/redact attaches its report as `error.report` to
// REDACT_VERIFICATION_FAILED (what was checked, positions and counts only), and every wrapped failure keeps
// the original as `error.cause` (for logs: never shown to the user, it may quote the document).

export class PdfEditorError extends Error {
  /**
   * @param {string} code    stable machine-readable code
   * @param {Record<string, unknown>} [params]  values for the translated sentence ({name} placeholders)
   * @param {{ cause?: unknown, detail?: string }} [options]  `detail` = English text for logs
   */
  constructor(code, params = {}, options = {}) {
    super(options.detail ? `${code}: ${options.detail}` : code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PdfEditorError";
    this.code = code;
    this.params = params;
  }
}

/** True for a PdfEditorError (also one that crossed a worker or realm boundary as a plain object). */
export function isPdfEditorError(error) {
  return Boolean(error) && typeof error === "object" && error.name === "PdfEditorError" && typeof error.code === "string";
}

/** The code of any thrown value: the PdfEditorError code, or `fallback` for everything else. */
export function errorCode(error, fallback = "UNEXPECTED") {
  return isPdfEditorError(error) ? error.code : fallback;
}

/** A non-fatal finding of an engine: same shape as an error, collected in reports instead of thrown. */
export function warning(code, params = {}) {
  return { code, params };
}

/** Thrown into a running job when the user cancels it (AbortSignal); the interface shows nothing for it. */
export const CANCELLED = "CANCELLED";

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new PdfEditorError(CANCELLED);
}
