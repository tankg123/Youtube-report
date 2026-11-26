// The env of the pipeline for a browser, made from what the editor already has:
//
//   import { pdfjs, openPdfDocument, onPdfWorkerError } from "../../pdfWorker.js";      (the caller's imports)
//   const env = createBrowserPipelineEnv({ pdfjs, openPdfDocument, onPdfWorkerError, fonts: fontRegistry });
//   const { bytes, report } = await buildOutput(job, env, { signal, onProgress });
//
// It is the env of the redaction engine (engine/redact createBrowserRedactEnv), which is also everything the
// export engine and the self-check need: fonts, pdf.js documents, canvases, JPEG encoding. Nothing here
// touches the DOM or imports pdf.js. The env holds no state and nothing of a job: build it once and use it
// for every job (what belongs to one job, such as signal and onProgress, goes into the options of buildOutput).
import { createBrowserRedactEnv } from "../redact/index.js";

/**
 * @param {object} parts
 * @param {{ OPS: object, AnnotationMode: object }} parts.pdfjs  the pdf.js namespace of pdfWorker.js
 * @param {(params: { data: Uint8Array, password?: string }) => object} parts.openPdfDocument  of pdfWorker.js
 * @param {(listener: (error: Error) => void) => (() => void)} [parts.onPdfWorkerError]  of pdfWorker.js. Pass it:
 *        without it a pdf.js worker that cannot start makes a job wait for ever; with it the job ends with
 *        PdfEditorError("REDACT_ENV_INVALID", { missing: "worker" }).
 * @param {((fontKey: string) => Promise<Uint8Array>) | { getFontBytes(fontKey: string): Promise<Uint8Array> }} parts.fonts
 *        the bytes of a bundled font face: a function, or the font registry of text/fonts.js (the SAME registry
 *        the text service uses, so that the file embeds the very bytes the screen shows)
 * @param {(width: number, height: number) => object} [parts.createCanvas]  only used where OffscreenCanvas is missing
 * @returns {{ pdfjs: object, fonts: Function, openPdf: Function, closePdf: Function, createCanvas: Function, encodeJpeg: Function }}
 *          openPdf(bytes, { password }) hands `bytes` to pdf.js, which TAKES the buffer: callers pass a copy
 *          (the engines and the pipeline do).
 * @throws PdfEditorError REDACT_ENV_INVALID { missing: "pdfjs" | "openPdf" | "fonts" | "createCanvas" }
 */
export function createBrowserPipelineEnv({ pdfjs, openPdfDocument, onPdfWorkerError, fonts, createCanvas } = {}) {
  return createBrowserRedactEnv({ pdfjs, openPdfDocument, onPdfWorkerError, fonts, createCanvas });
}
