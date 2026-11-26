// The `env` of redactPdf() for a browser (window or worker), made from what the editor already has:
//
//   import { pdfjs, openPdfDocument, onPdfWorkerError } from "../../pdfWorker.js";     (the caller's imports)
//   const env = createBrowserRedactEnv({ pdfjs, openPdfDocument, onPdfWorkerError, fonts, signal, onProgress });
//   const { bytes, report } = await redactPdf(pdfBytes, targets, env);
//
// Nothing here touches the DOM or imports pdf.js: canvases are OffscreenCanvas where the platform has them,
// otherwise the caller's createCanvas (for example
// (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }) in the page), and pdf.js
// documents come from the caller's openPdfDocument (pdfWorker.js is the only module that calls getDocument()).
import { PdfEditorError } from "../errors.js";

/** JPEG bytes of a canvas, or null when the platform cannot make them (the engine then stores lossless). */
async function encodeJpeg(canvas, quality) {
  let blob = null;
  if (typeof canvas.convertToBlob === "function") {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  } else if (typeof canvas.toBlob === "function") {
    blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
  }
  // a browser that cannot encode JPEG answers with image/png
  if (!blob || blob.type !== "image/jpeg") return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * @param {object} options
 * @param {{ OPS: object, AnnotationMode: object }} options.pdfjs  the pdf.js namespace that openPdfDocument uses
 * @param {(params: { data: Uint8Array, password?: string }) => object} options.openPdfDocument
 *        getDocument() of the editor (pdfWorker.js): takes the parameters of pdf.js and returns its loading task
 *        ({ promise, destroy() }). A function that returns the promise of the document itself works as well.
 *        pdf.js takes ownership of `data`: the engine always hands over a private copy.
 * @param {(listener: (error: Error) => void) => (() => void)} [options.onPdfWorkerError]
 *        of pdfWorker.js. A loading task never settles when the worker script cannot be started; with this the
 *        job ends with PdfEditorError("REDACT_ENV_INVALID", { missing: "worker" }) instead of waiting for ever.
 * @param {((fontKey: string) => Promise<Uint8Array>) | { getFontBytes(fontKey: string): Promise<Uint8Array> }} options.fonts
 *        the bytes of a bundled font by its manifest id: a function, or the font registry of text/fonts.js
 * @param {(width: number, height: number) => object} [options.createCanvas]  used where OffscreenCanvas is missing
 * Every other property (password, signal, onProgress, random, path, dpi ...) is passed through to the env.
 * @returns the env for redactPdf(pdfBytes, targets, env)
 */
export function createBrowserRedactEnv({ pdfjs, openPdfDocument, onPdfWorkerError, fonts, createCanvas, ...options } = {}) {
  if (!pdfjs?.OPS || !pdfjs?.AnnotationMode) throw new PdfEditorError("REDACT_ENV_INVALID", { missing: "pdfjs" });
  if (typeof openPdfDocument !== "function") throw new PdfEditorError("REDACT_ENV_INVALID", { missing: "openPdf" });
  const fontBytes = typeof fonts === "function" ? fonts : typeof fonts?.getFontBytes === "function" ? (fontKey) => fonts.getFontBytes(fontKey) : null;
  if (!fontBytes) throw new PdfEditorError("REDACT_ENV_INVALID", { missing: "fonts" });
  const offscreen = typeof globalThis.OffscreenCanvas === "function";
  if (!offscreen && typeof createCanvas !== "function") throw new PdfEditorError("REDACT_ENV_INVALID", { missing: "createCanvas" });

  const openPdf = (bytes, { password } = {}) => {
    const task = openPdfDocument(password === undefined ? { data: bytes } : { data: bytes, password });
    const opened = Promise.resolve(task?.promise ?? task);
    if (typeof onPdfWorkerError !== "function") return opened;
    return new Promise((resolve, reject) => {
      let off = null;
      const settle = (finish, value) => {
        off?.();
        finish(value);
      };
      off = onPdfWorkerError((error) => settle(reject, new PdfEditorError("REDACT_ENV_INVALID", { missing: "worker" }, { cause: error })));
      opened.then((doc) => settle(resolve, doc), (error) => settle(reject, error));
    });
  };

  return {
    pdfjs: { OPS: pdfjs.OPS, AnnotationMode: pdfjs.AnnotationMode },
    openPdf,
    closePdf: async (doc) => {
      // PDFDocumentProxy.destroy() ends its loading task (and the worker document with it)
      await (doc?.loadingTask?.destroy?.() ?? doc?.destroy?.());
    },
    createCanvas: (width, height) => (offscreen ? new globalThis.OffscreenCanvas(width, height) : createCanvas(width, height)),
    encodeJpeg,
    fonts: fontBytes,
    // (no `random`: the engine takes the CSPRNG of the platform itself)
    ...options
  };
}
