// The ONLY module of the PDF editor that imports pdf.js in the browser, creates its worker and calls
// getDocument(). Everything else receives `pdfjs` and `openPdfDocument` from here (the viewer controller takes
// them as arguments). Vite-only module (worker URL, import.meta.env): node:test files never import it, and
// neither does any module they import.
//
// Build: pdf.js' LEGACY build. The default build needs Chrome 147 / Firefox 144 / Safari 26.2; the legacy one
// runs from Chrome 125 / Firefox 124 / Safari 17.4 for 34 kB gzip more.
//
// Worker: `new Worker(new URL(...), { type: "module" })` makes Vite emit assets/pdf.worker.min-<hash>.js
// (worker.format "es" in vite.config.js). A ".js" file gets a JavaScript MIME type from every web server; the
// ".mjs" file that a "?url" import emits does not (stock nginx has no entry for it).
//
// Ownership: ONE PDFWorker owned by the editor and handed to every getDocument() call.
//   * A loading task that is given `worker` does not own it: task.destroy() closes that document only, so
//     documents come and go freely on one thread, also under React StrictMode (effect, cleanup, effect).
//   * GlobalWorkerOptions.workerPort / workerSrc are never set: with them every loading task shares a cached
//     PDFWorker, and opening a file while another one is still being destroyed throws
//     "PDFWorker.create - the worker is being destroyed".
//   * A Worker handed over as a port never tells pdf.js that its script failed to load: getDocument() would wait
//     for ever. The "error" listener below notices it and tells whoever asked through onPdfWorkerError().
//
// Assets: character maps, standard fonts, image decoders (wasm) and colour profiles are fetched by name from
// public/pdfjs/<version>/ (copied by frontend/pdfjs-assets.mjs before dev and build). All four URLs are given
// (leaving one out switches colour management off for everything), absolute (the worker fetches them and its
// base URL is not the page's) and with a trailing slash (pdf.js throws otherwise).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

let shared = null; // { worker: PDFWorker, port: Worker, alive: boolean }
const errorListeners = new Set();

/** The four asset options of getDocument(), plus `base`: the folder they live in. */
export function pdfAssetOptions() {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/${pdfjs.version}/`, document.baseURI).href;
  return {
    base,
    cMapUrl: `${base}cmaps/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`
  };
}

function discard(state) {
  if (shared === state) shared = null;
  try {
    state.worker?.destroy();
  } catch {
    // already destroyed
  }
  // PDFWorker.destroy() only terminates workers it created itself
  state.port.terminate();
}

function sharedWorker() {
  if (shared && !shared.worker.destroyed) return shared.worker;
  if (shared) discard(shared);
  const port = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
  const state = { port, worker: null, alive: false };
  // the worker says "ready" as soon as its script runs
  port.addEventListener(
    "message",
    () => {
      state.alive = true;
    },
    { once: true }
  );
  const onError = (event) => {
    if (state.alive) return; // a running worker reports its own failures through pdf.js
    // 404 after a deployment, wrong MIME type, Content-Security-Policy: the script never started
    discard(state);
    const error = new Error(`The pdf.js worker could not be started${event?.message ? `: ${event.message}` : ""}`);
    for (const listener of [...errorListeners]) listener(error);
  };
  port.addEventListener("error", onError);
  port.addEventListener("messageerror", onError);
  state.worker = new pdfjs.PDFWorker({ port });
  shared = state;
  return state.worker;
}

/**
 * getDocument() with the editor's worker and asset URLs. The worker is created on the first call.
 * @param {object} params  getDocument parameters: { data, password, fontExtraProperties, ... }.
 *        pdf.js TRANSFERS `data` to the worker (the array is empty afterwards): pass a copy when the bytes
 *        are needed again (the viewer controller copies, see viewer/viewerController.js).
 * @returns {object} PDFDocumentLoadingTask: { promise, onPassword, onProgress, destroy() }
 */
export function openPdfDocument(params = {}) {
  const { cMapUrl, standardFontDataUrl, wasmUrl, iccUrl } = pdfAssetOptions();
  return pdfjs.getDocument({
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    wasmUrl,
    iccUrl,
    enableXfa: false,
    ...params,
    // always the editor's own worker, never the global one
    worker: sharedWorker()
  });
}

/**
 * Tells when the worker could not be started; documents that are opening at that moment will never settle
 * on their own. The next openPdfDocument() tries with a fresh worker.
 * @param {(error: Error) => void} listener
 * @returns {() => void} removes the listener
 */
export function onPdfWorkerError(listener) {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

/**
 * Stops the worker thread (leaving the editor). Close every document first (controller.dispose()): a document
 * that is still open is dead afterwards. The next openPdfDocument() starts a new worker.
 */
export function terminatePdfWorker() {
  if (shared) discard(shared);
}

/**
 * Opens a PDF for an engine and resolves with the pdf.js document (same shape as tests/helpers/pdfTestKit.mjs:
 * engines get `openPdf` / `closePdf` through their `env`). The bytes are copied.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {{ password?: string }} [options]
 * @returns {Promise<object>} PDFDocumentProxy; rejects when the worker cannot be started
 */
export function openPdf(bytes, { password } = {}) {
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) : new Uint8Array(bytes);
  const task = openPdfDocument({ data, password });
  return new Promise((resolve, reject) => {
    const off = onPdfWorkerError((error) => {
      off();
      reject(error);
    });
    task.promise.then(
      (doc) => {
        off();
        resolve(doc);
      },
      (error) => {
        off();
        reject(error);
      }
    );
  });
}

/** Closes a document opened with openPdf(). Never throws. */
export async function closePdf(doc) {
  try {
    await doc?.loadingTask?.destroy();
  } catch {
    // already closed
  }
}

export { pdfjs };
