// Printing. The editor prints what Download would produce, never the raw page: the caller builds the exported
// bytes first and hands them over. They go into a hidden <iframe> as a blob and the browser's own PDF viewer
// prints them (vector output, fonts intact, exactly the bytes of the download).
// Browser module. Needs `frame-src blob:` when the host sends a Content-Security-Policy.
//
// Verified in headless Chrome only as far as "the blob loads as application/pdf and print() can be called";
// what leaves the printer, and browsers without an embeddable PDF viewer (phones), are not covered: there
// `canPrintPdfBytes()` is false and the interface should offer the download instead.

const FRAME_ATTRIBUTE = "data-pdfx-print-frame";
let activeFrame = null; // { iframe, url, timer }

/** True where the browser can show a PDF in a frame (navigator.pdfViewerEnabled; unknown counts as yes). */
export function canPrintPdfBytes() {
  return typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;
}

/** Removes the hidden frame of the last print job (also called before every new job). */
export function disposePrintFrame() {
  if (!activeFrame) return;
  clearTimeout(activeFrame.timer);
  activeFrame.iframe.remove();
  URL.revokeObjectURL(activeFrame.url);
  activeFrame = null;
}

/**
 * Opens the browser's print dialog for a PDF.
 * @param {Uint8Array | ArrayBuffer | Blob} bytes  the document to print (not modified)
 * @param {{ timeoutMs?: number, keepMs?: number }} [options]
 *        timeoutMs  how long the frame may take to load the PDF (default 15 s)
 *        keepMs     how long the frame stays after print() returned: the dialog reads from it (default 5 min)
 * @returns {Promise<{ loaded: boolean, printCalled: boolean, reason?: string }>} resolves when print() has
 *          been called; `printCalled: false` with a `reason` when the frame did not load or refused
 */
export function printPdfBytes(bytes, { timeoutMs = 15000, keepMs = 300000 } = {}) {
  disposePrintFrame();
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement("iframe");
  // not display: none: several browsers neither load nor print a PDF in a frame that has no box
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("tabindex", "-1");
  iframe.setAttribute(FRAME_ATTRIBUTE, "");
  const job = { iframe, url, timer: 0 };
  activeFrame = job;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimer);
      if (activeFrame === job) {
        if (result.printCalled) job.timer = setTimeout(() => activeFrame === job && disposePrintFrame(), keepMs);
        else disposePrintFrame();
      }
      resolve(result);
    };
    const loadTimer = setTimeout(() => finish({ loaded: false, printCalled: false, reason: "timeout" }), timeoutMs);
    iframe.addEventListener("load", () => {
      if (activeFrame !== job) {
        finish({ loaded: true, printCalled: false, reason: "superseded" });
        return;
      }
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        finish({ loaded: true, printCalled: true });
      } catch (error) {
        finish({ loaded: true, printCalled: false, reason: error?.name || "error" });
      }
    });
    iframe.src = url;
    document.body.append(iframe);
  });
}
