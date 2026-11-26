// What the editor needs from the browser before anything is loaded (UX specification 10, "Unsupported
// browser"). Every entry names a platform feature the code really uses; the names are those a developer or a
// help desk would search for, so they are not translated. Pure: tests/pdfUiDocumentFacts.test.mjs.
const CHECKS = Object.freeze([
  // text/fontSupport.js splits text into the clusters a reader sees (Vietnamese letters with two marks)
  ["Intl.Segmenter", (scope) => typeof scope.Intl?.Segmenter === "function"],
  // the document model copies its state
  ["structuredClone", (scope) => typeof scope.structuredClone === "function"],
  // zoom modes follow the size of the page area
  ["ResizeObserver", (scope) => typeof scope.ResizeObserver === "function"],
  // pdf.js reads the files in a worker
  ["Web Workers", (scope) => typeof scope.Worker === "function"],
  // long work can be cancelled
  ["AbortController", (scope) => typeof scope.AbortController === "function"],
  // files are read and handed out as Blobs
  ["Blob.arrayBuffer", (scope) => typeof scope.Blob === "function" && typeof scope.Blob.prototype.arrayBuffer === "function"],
  ["Array.prototype.findLastIndex", (scope) => typeof scope.Array?.prototype?.findLastIndex === "function"],
  ["Object.hasOwn", (scope) => typeof scope.Object?.hasOwn === "function"],
  // a running job and a dialog switch the rest of the editor off
  ["inert", (scope) => !scope.HTMLElement || "inert" in scope.HTMLElement.prototype]
]);

/**
 * The features of CHECKS this browser lacks (empty = the editor can run).
 * @param {object} [scope]  the global object (tests pass their own)
 * @returns {string[]}
 */
export function missingBrowserFeatures(scope = globalThis) {
  const missing = [];
  for (const [name, present] of CHECKS) {
    let ok;
    try {
      ok = present(scope);
    } catch {
      ok = false;
    }
    if (!ok) missing.push(name);
  }
  return missing;
}

/** The names of everything that is checked (for tests). */
export const REQUIRED_BROWSER_FEATURES = Object.freeze(CHECKS.map(([name]) => name));
