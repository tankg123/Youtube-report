// The reading core of the PDF editor: pdf.js documents ("sources"), a CONTROLLED list of pages taken from
// several of them, zoom, virtualised rendering, text lines, search, links, thumbnails. No React and no text for
// the user in here: the interface subscribes to the store, hands over DOM elements and shows codes as sentences.
//
//   const controller = createViewerController({ pdfjs, openPdfDocument, onWorkerError });   // ../pdfWorker.js
//
// The dependencies are injected: nothing in this module imports pdf.js or touches the DOM before an element is
// attached, so tests/pdfViewerController.test.mjs drives the same code in Node with pdf.js' main-thread worker.
//
// Who owns what
//   * The document model owns the page list: setPages(pages) takes Page[] of ../model/schema.js and the viewer
//     shows exactly that. Pages are matched by id: a page that only moved keeps its canvas, a rotated page is
//     redrawn, a removed page is released.
//   * React owns the page elements (./ViewerPages.jsx); the controller owns the inside of the host element of
//     each page (./pageView.js) and the scroll position.
//   * The caller owns the bytes: pdf.js gets a copy (it detaches the buffer it is given).
//
// Units: `scale` is CSS pixels per PDF point, as in ../engine/geometry.js; `zoom` is what the user reads
// (1 = 100 %, scale = zoom x 96 / 72). Every coordinate helper below delegates to ../engine/geometry.js.
//
// Lifetime: creating a controller starts nothing (no worker, no observer). dispose() cancels all work, closes
// every source and empties the list; the instance stays usable, which is what React StrictMode needs
// (effect, cleanup, effect on the same instance).

import { CANCELLED, PdfEditorError, isPdfEditorError } from "../engine/errors.js";
import { userRectToViewport, userToViewport, viewportRectToUser, viewportToUser, viewportTransform } from "../engine/geometry.js";
import { pageGeometry } from "../model/schema.js";
import { canvasLimitsFor, pickEvictions, thumbnailSize } from "./canvasSizing.js";
import { createGuard } from "./guard.js";
import { sampleColorsFromPixels } from "./colorSampling.js";
import { destinationRect, resolveDestination, resolveOutline } from "./outline.js";
import { NEUTRAL_DISPLAY, checkPages, contentKey, diffPages, totalRotation, visiblePageSize } from "./pageList.js";
import { PageView, RENDER_STATE, isCancellation } from "./pageView.js";
import { canPrintPdfBytes, disposePrintFrame, printPdfBytes } from "./print.js";
import { clearSearchHighlights, paintSearchHighlights, supportsCssHighlights } from "./searchHighlight.js";
import { compactItems, findInPage, foldKey, indexPage } from "./searchText.js";
import { groupTextLines } from "./textLines.js";
import { ZOOM_MODES, clampZoom, fitZoom, nextZoomStop, previousZoomStop, scaleToZoom, zoomToScale } from "./zoom.js";

const ZOOM_REDRAW_DELAY_MS = 120; // canvases are redrawn once the user stops zooming
const PAGE_FACTS_BATCH = 50;
const TEXT_CONTENT_CACHE = 24; // pages per source whose full text items stay in memory
const SCROLL_MARGIN = 8; // CSS pixels kept above a page that is scrolled to
const DEFAULT_GUTTER = 16; // CSS pixels around the pages when the stylesheet does not say
const THUMBNAIL_MAX_RATIO = 2;
const EMPTY = Object.freeze([]);
const NO_SEARCH = Object.freeze({ query: "", options: Object.freeze({}), total: 0, current: -1, pageId: null, running: false });

const PERMISSION_NAMES = Object.freeze({
  print: "PRINT",
  modify: "MODIFY_CONTENTS",
  copy: "COPY",
  annotate: "MODIFY_ANNOTATIONS",
  fillForms: "FILL_INTERACTIVE_FORMS",
  copyForAccessibility: "COPY_FOR_ACCESSIBILITY",
  assemble: "ASSEMBLE",
  printHighQuality: "PRINT_HIGH_QUALITY"
});

const CONTAINER_KEY = Symbol("container");

const cancelled = () => new PdfEditorError(CANCELLED);
const text = (value) => (typeof value === "string" ? value.trim() : "");

/** A private copy of the caller's bytes (pdf.js transfers the buffer it gets to its worker). */
function copyBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  throw new TypeError("openSource: bytes must be a Uint8Array or an ArrayBuffer (for a File use new Uint8Array(await file.arrayBuffer()))");
}

class ViewerController {
  #pdfjs;
  #openPdfDocument;
  #offWorkerError = null;
  #highlightPreference;
  #limitOverrides;
  #generation = 0;

  // sources
  #sources = new Map(); // sourceId -> { id, doc, loadingTask, facts, password, strings, indexes, content, lines }
  #opening = new Map(); // sourceId -> { cancel(error), loadingTask }

  // page list
  #pages = EMPTY;
  #position = new Map(); // page id -> index in the list

  // DOM
  #leaving = new Map(); // what a ref cleanup asked to detach: key -> element (see #detachSoon)
  #container = null;
  #hosts = new Map(); // page id -> host element
  #hostPage = new WeakMap(); // host element -> page id
  #views = new Map(); // page id -> PageView
  #visibleObserver = null;
  #nearObserver = null;
  #resizeObserver = null;
  #stopPixelRatioWatch = null;
  #visible = new Map(); // page id -> intersection ratio (> 0 only)
  #near = new Set(); // page ids inside the pre-render zone
  #drawn = []; // page ids that hold a canvas, least recently shown first
  #display = NEUTRAL_DISPLAY;
  #limits = null;
  #singlePrecision = null;

  // zoom and position
  #zoom = 1;
  #scale = zoomToScale(1);
  #zoomMode = "actual";
  #zoomTimer = null;
  #currentPageId = null;
  #scrollFrame = 0;
  #settleFrame = 0;
  #settleTimer = null;
  #settling = false;

  // render queue: one piece of work at a time
  #active = null; // { kind: "page" | "raster" | "thumbnail", ... }
  #scheduled = false;
  #rasterJobs = [];
  #thumbnails = new Map(); // canvas element -> { canvas, pageId, width, drawnKey, visible, root }
  #thumbnailObservers = new Map(); // root element (or null) -> { observer, count }

  // store and events
  #listeners = new Set();
  #handlers = new Map();
  #snapshot = null;
  #snapshotStale = true;
  #notifyQueued = false;
  #busy = { opening: false, rendering: false, searching: false };

  // search
  #search = { query: "", options: {}, results: [], byPage: new Map(), current: -1, running: false };
  #searchToken = 0;
  #pendingReveal = null;
  #painted = { all: 0, current: 0 };

  #counters = { rendered: 0, cancelled: 0, evicted: 0, thumbnails: 0, rasters: 0, textLayers: 0 };

  constructor({ pdfjs, openPdfDocument, onWorkerError, highlightMode, limits } = {}) {
    if (!pdfjs || typeof openPdfDocument !== "function") throw new TypeError("createViewerController({ pdfjs, openPdfDocument }) needs both");
    this.#pdfjs = pdfjs;
    this.#openPdfDocument = openPdfDocument;
    this.#viewEnvironment.pdfjs = pdfjs;
    this.#highlightPreference = highlightMode === "css" || highlightMode === "dom" ? highlightMode : null;
    this.#limitOverrides = limits && typeof limits === "object" ? { ...limits } : {};
    if (typeof onWorkerError === "function") {
      // A worker handed to pdf.js as a port never reports that its script failed to load: the open would
      // wait for ever. The owner of the worker tells us, and every file that is opening gives up.
      this.#offWorkerError = onWorkerError((error) => {
        for (const entry of [...this.#opening.values()]) entry.cancel(new PdfEditorError("VIEW_WORKER_FAILED", {}, { cause: error, detail: String(error?.message || error) }));
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // store (useSyncExternalStore) and events
  // ---------------------------------------------------------------------------------------------------------

  /** store.subscribe: the listener is called (in a microtask) after anything a getter below returns changed. */
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * store.getSnapshot: { scale, zoom, zoomMode, currentPageId, currentPageNumber, pageCount,
   *   search: { query, options, total, current, pageId, running }, busy: { opening, rendering, searching, any } }.
   * The object is replaced only when one of its values changed.
   */
  getSnapshot = () => {
    if (this.#snapshotStale) this.#rebuildSnapshot();
    return this.#snapshot;
  };

  /** The list given to setPages() (same array until the next call): a snapshot getter of its own. */
  getPages = () => this.#pages;

  /** CSS pixels per point: a snapshot getter of its own (zoom changes re-render the overlays, scrolling does not). */
  getScale = () => this.#scale;

  /** { pixelRatio, limits, screenArea, singlePrecision } of the device; replaced when the pixel ratio changes. */
  getDisplay = () => this.#display;

  /** The Page with this id, or null. */
  getPage = (pageId) => {
    const index = this.#position.get(pageId);
    return index === undefined ? null : this.#pages[index];
  };

  /** "pending" | "rendering" | "ready" | "error" of a page (blank pages are always "ready"). */
  getRenderState = (pageId) => {
    const view = this.#views.get(pageId);
    if (view) return view.state;
    const page = this.getPage(pageId);
    return page && page.kind !== "pdf" ? RENDER_STATE.READY : RENDER_STATE.PENDING;
  };

  /**
   * Events: on(type, handler) returns the function that removes the handler.
   *   "pagerendered"  { pageId, pageNumber, scale, canvasWidth, canvasHeight, restricted, ms }  a bitmap is on screen
   *   "textlayer"     { pageId, ready }                 the selectable text of a page appeared or was released
   *   "pageerror"     { pageId, pageNumber, code, part: "canvas" | "text" | "links", error }
   *   "viewchanged"   { scale, zoom, zoomMode, currentPageId, currentPageNumber }   zoom or current page changed
   *   "link"          { pageId, sourceId, pageIndex, targetPageId, action }   an internal link was activated;
   *                   targetPageId is null when its page is not in the list (nothing is scrolled then)
   */
  on(type, handler) {
    let set = this.#handlers.get(type);
    if (!set) this.#handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  #emit(type, detail) {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(detail);
      } catch (error) {
        console.error(error);
      }
    }
  }

  #changed() {
    this.#snapshotStale = true;
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const listener of [...this.#listeners]) listener();
    });
  }

  #rebuildSnapshot() {
    this.#snapshotStale = false;
    const previous = this.#snapshot;
    const search = this.#search;
    const currentMatch = search.results[search.current] || null;
    const nextSearch = search.query
      ? { query: search.query, options: search.options, total: search.results.length, current: search.current, pageId: currentMatch ? currentMatch.pageId : null, running: search.running }
      : NO_SEARCH;
    const sameSearch =
      previous &&
      previous.search.query === nextSearch.query &&
      previous.search.options === nextSearch.options &&
      previous.search.total === nextSearch.total &&
      previous.search.current === nextSearch.current &&
      previous.search.pageId === nextSearch.pageId &&
      previous.search.running === nextSearch.running;
    const busy = this.#busy;
    const any = busy.opening || busy.rendering || busy.searching;
    const sameBusy = previous && previous.busy.opening === busy.opening && previous.busy.rendering === busy.rendering && previous.busy.searching === busy.searching;
    const currentIndex = this.#position.get(this.#currentPageId);
    const next = {
      scale: this.#scale,
      zoom: this.#zoom,
      zoomMode: this.#zoomMode,
      currentPageId: currentIndex === undefined ? null : this.#currentPageId,
      currentPageNumber: currentIndex === undefined ? 0 : currentIndex + 1,
      pageCount: this.#pages.length,
      search: sameSearch ? previous.search : Object.freeze(nextSearch),
      busy: sameBusy ? previous.busy : Object.freeze({ opening: busy.opening, rendering: busy.rendering, searching: busy.searching, any })
    };
    if (previous && Object.keys(next).every((key) => previous[key] === next[key])) return;
    this.#snapshot = Object.freeze(next);
  }

  #setBusy(key, value) {
    if (this.#busy[key] === value) return;
    this.#busy[key] = value;
    this.#changed();
  }

  /** True when nothing is opening, searching or waiting to be drawn for the current scroll position. */
  isIdle() {
    this.#refreshRendering();
    return !(this.#busy.opening || this.#busy.rendering || this.#busy.searching);
  }

  /** Resolves when isIdle() becomes true (at once when it already is). */
  whenIdle() {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        if (!this.isIdle()) return;
        off();
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // sources
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Opens a PDF and reads the facts the document model needs.
   * @param {string} sourceId  the model's id of the file
   * @param {Uint8Array | ArrayBuffer} bytes  the file; neither modified nor detached
   * @param {{ password?: string, onPassword?: (reason: "need" | "incorrect") => Promise<string | null> | string | null,
   *           signal?: AbortSignal }} [options]
   *        password    tried first. Never pass the password of another file: a file that opens without one
   *                    is refused when a wrong password comes with it.
   *        onPassword  called when the file needs a password ("need") and after every wrong one ("incorrect");
   *                    null or undefined = the user gave up -> VIEW_PASSWORD_CANCELLED
   * @returns {Promise<object>} facts = {
   *   pageCount, pages: [{ view: [x0, y0, x1, y1], rotate, userUnit }],
   *   info: { title, author, subject, keywords, creator, producer },        // "" where the file has none
   *   encrypted: boolean,
   *   permissions: null | { flags: number[], print, modify, copy, annotate, fillForms, copyForAccessibility,
   *                         assemble, printHighQuality },                    // null = no restriction recorded
   *   outline: [{ title, pageIndex | null, rect | null, children }],        // pageIndex in THIS file, 0-based
   *   signatureFieldCount, signatureCount,   // signature fields in the form / those that hold a signature
   *   fingerprint }
   * @throws PdfEditorError with a code of ./codes.js, or CANCELLED
   */
  async openSource(sourceId, bytes, options = {}) {
    if (typeof sourceId !== "string" || !sourceId) throw new TypeError("openSource: sourceId must be a non-empty string");
    if (this.#sources.has(sourceId) || this.#opening.has(sourceId)) throw new PdfEditorError("VIEW_SOURCE_EXISTS", { sourceId });
    const data = copyBytes(bytes);
    const byteLength = data.byteLength; // pdf.js empties `data` when it hands it to the worker
    if (byteLength === 0) throw new PdfEditorError("VIEW_FILE_EMPTY");
    if (options.signal?.aborted) throw cancelled();

    const opening = createGuard();
    const entry = { loadingTask: null, cancelError: null, passwordCancelled: false, password: typeof options.password === "string" ? options.password : null };
    entry.cancel = (error) => {
      if (entry.cancelError) return;
      entry.cancelError = error;
      opening.cancel(error);
      entry.loadingTask?.destroy().catch(() => {});
    };
    const guard = (promise) => opening.run(promise);
    const onAbort = () => entry.cancel(cancelled());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.#opening.set(sourceId, entry);
    this.#setBusy("opening", true);

    try {
      // fontExtraProperties: the real font names reach the main thread ("Edit text" picks a matching family)
      const loadingTask = this.#openPdfDocument({ data, password: entry.password ?? undefined, fontExtraProperties: true });
      entry.loadingTask = loadingTask;
      if (typeof options.onPassword === "function") {
        const responses = this.#pdfjs.PasswordResponses;
        loadingTask.onPassword = (updatePassword, reason) => {
          const why = reason === responses.INCORRECT_PASSWORD ? "incorrect" : "need";
          Promise.resolve()
            .then(() => options.onPassword(why))
            .then(
              (answer) => {
                if (entry.cancelError) return;
                if (answer === null || answer === undefined) {
                  // pdf.js then rejects with the pending PasswordException; the flag tells the two cases apart
                  entry.passwordCancelled = true;
                  updatePassword(new Error("password prompt cancelled"));
                } else {
                  entry.password = String(answer);
                  updatePassword(entry.password);
                }
              },
              (error) => entry.cancel(error instanceof Error ? error : new Error(String(error)))
            );
        };
      }
      const doc = await guard(loadingTask.promise);
      const facts = await this.#readFacts(doc, guard);
      if (entry.cancelError) throw entry.cancelError;
      this.#sources.set(sourceId, {
        id: sourceId,
        doc,
        loadingTask,
        // every promise of pdf.js for this source goes through it: closing the source rejects them all
        guard: createGuard(),
        facts,
        password: facts.encrypted ? entry.password : null,
        strings: new Map(), // page index -> [{ str, hasEOL }] (kept: search)
        indexes: new Map(), // "<page index>|<fold key>" -> folded page (kept: search)
        content: new Map(), // page index -> Promise<text content> (small LRU: text layer, lines)
        lines: new Map() // page index -> Promise<lines> (small LRU)
      });
      for (const view of this.#views.values()) if (view.page.sourceId === sourceId) view.sourceChanged();
      this.#schedule();
      if (this.#search.query) this.#runSearch(this.#search.query, this.#search.options, { keepPosition: true });
      return facts;
    } catch (error) {
      entry.loadingTask?.destroy().catch(() => {});
      throw this.#openError(error, entry, byteLength);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (this.#opening.get(sourceId) === entry) this.#opening.delete(sourceId);
      this.#setBusy("opening", this.#opening.size > 0);
    }
  }

  #openError(error, entry, byteLength) {
    if (entry.cancelError) return entry.cancelError;
    if (isPdfEditorError(error)) return error;
    const pdfjs = this.#pdfjs;
    const name = error?.name || "";
    const detail = String(error?.message || error);
    if (error instanceof pdfjs.PasswordException || name === "PasswordException") {
      if (entry.passwordCancelled) return new PdfEditorError("VIEW_PASSWORD_CANCELLED");
      const incorrect = error.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
      return new PdfEditorError(incorrect ? "VIEW_PASSWORD_INCORRECT" : "VIEW_PASSWORD_REQUIRED", {}, { cause: error });
    }
    if (error instanceof pdfjs.InvalidPDFException || name === "InvalidPDFException") {
      return new PdfEditorError(byteLength === 0 || /empty/i.test(detail) ? "VIEW_FILE_EMPTY" : "VIEW_INVALID_PDF", {}, { cause: error, detail });
    }
    if (isCancellation(error, pdfjs)) return cancelled();
    return new PdfEditorError("VIEW_OPEN_FAILED", { reason: name || "Error" }, { cause: error, detail });
  }

  async #readFacts(doc, guard) {
    const pageCount = doc.numPages;
    const pages = [];
    for (let start = 1; start <= pageCount; start += PAGE_FACTS_BATCH) {
      const end = Math.min(pageCount, start + PAGE_FACTS_BATCH - 1);
      const batch = await guard(Promise.all(Array.from({ length: end - start + 1 }, (_, offset) => doc.getPage(start + offset))));
      for (const page of batch) pages.push(Object.freeze({ view: Object.freeze(Array.from(page.view)), rotate: page.rotate, userUnit: page.userUnit || 1 }));
    }
    const optional = (promise, fallback) => guard(Promise.resolve(promise).catch(() => fallback));
    const [metadata, permissionFlags, outline, signatures, fields] = await Promise.all([
      optional(doc.getMetadata(), null),
      optional(doc.getPermissions(), null),
      optional(resolveOutline(doc, pages), []),
      optional(typeof doc.getSignatures === "function" ? doc.getSignatures() : null, null),
      optional(doc.getFieldObjects(), null)
    ]);
    const info = metadata?.info || {};
    let permissions = null;
    if (permissionFlags) {
      const flags = [...permissionFlags];
      permissions = { flags: Object.freeze(flags) };
      for (const [key, flagName] of Object.entries(PERMISSION_NAMES)) permissions[key] = flags.includes(this.#pdfjs.PermissionFlag[flagName]);
      Object.freeze(permissions);
    }
    let signatureFieldCount = 0;
    if (fields) {
      const lists = typeof fields.values === "function" ? [...fields.values()] : Object.values(fields);
      for (const list of lists) if (Array.isArray(list) && list.some((field) => field?.type === "signature")) signatureFieldCount += 1;
    }
    const signatureCount = Array.isArray(signatures) ? signatures.length : 0;
    return Object.freeze({
      pageCount,
      pages: Object.freeze(pages),
      info: Object.freeze({
        title: text(info.Title),
        author: text(info.Author),
        subject: text(info.Subject),
        keywords: text(info.Keywords),
        creator: text(info.Creator),
        producer: text(info.Producer)
      }),
      encrypted: Boolean(info.EncryptFilterName),
      permissions,
      outline,
      signatureFieldCount: Math.max(signatureFieldCount, signatureCount),
      signatureCount,
      fingerprint: doc.fingerprints?.[0] || null
    });
  }

  /** Closes a source (also one that is still opening: its openSource() rejects with CANCELLED). */
  async closeSource(sourceId) {
    const opening = this.#opening.get(sourceId);
    if (opening) {
      opening.cancel(cancelled());
      return;
    }
    const record = this.#sources.get(sourceId);
    if (!record) return;
    this.#sources.delete(sourceId);
    record.guard.cancel(cancelled());
    for (const view of this.#views.values()) {
      if (view.page.kind === "pdf" && view.page.sourceId === sourceId) {
        view.release();
        view.sourceChanged();
      }
    }
    this.#drawn = this.#drawn.filter((id) => this.#views.get(id)?.canvas);
    if (this.#search.query) this.#runSearch(this.#search.query, this.#search.options, { keepPosition: true });
    this.#schedule();
    try {
      await record.loadingTask.destroy();
    } catch {
      // already gone
    }
  }

  hasSource(sourceId) {
    return this.#sources.has(sourceId);
  }

  /** The facts openSource() resolved with, or null. */
  getSourceFacts(sourceId) {
    return this.#sources.get(sourceId)?.facts || null;
  }

  /** The password that opened an encrypted source (the export needs it), or null. Kept in memory only. */
  getSourcePassword(sourceId) {
    return this.#sources.get(sourceId)?.password ?? null;
  }

  /** The pdf.js document (PDFDocumentProxy) of a source for read-only use, or null. Never destroy it. */
  getPdfDocument(sourceId) {
    return this.#sources.get(sourceId)?.doc || null;
  }

  #pdfPage(page) {
    const record = page.kind === "pdf" ? this.#sources.get(page.sourceId) : null;
    if (!record) return Promise.resolve(null);
    return record.guard.run(record.doc.getPage(page.sourceIndex + 1));
  }

  /** Text items of a source page as pdf.js extracts them (shared by the text layer, the lines and the search). */
  #textContent(record, pageIndex) {
    let pending = record.content.get(pageIndex);
    if (pending) {
      record.content.delete(pageIndex);
      record.content.set(pageIndex, pending);
      return pending;
    }
    pending = record.guard
      .run(
        record.doc
          .getPage(pageIndex + 1)
          // disableNormalization: the strings are the ones the text layer shows, so search offsets fit its spans
          .then((page) => page.getTextContent({ disableNormalization: true }))
      )
      .then((content) => {
        if (!record.strings.has(pageIndex)) record.strings.set(pageIndex, compactItems(content.items));
        return content;
      });
    pending.catch(() => {
      if (record.content.get(pageIndex) === pending) record.content.delete(pageIndex);
    });
    record.content.set(pageIndex, pending);
    while (record.content.size > TEXT_CONTENT_CACHE) record.content.delete(record.content.keys().next().value);
    return pending;
  }

  async #pageStrings(record, pageIndex) {
    const known = record.strings.get(pageIndex);
    if (known) return known;
    await this.#textContent(record, pageIndex);
    return record.strings.get(pageIndex) || EMPTY;
  }

  /** pdf.js keeps decoded images and operator lists per page: drop them when no view of the page is drawn. */
  #releasePdfPage(page) {
    if (page.kind !== "pdf") return;
    const record = this.#sources.get(page.sourceId);
    if (!record) return;
    for (const view of this.#views.values()) {
      if (view.canvas && view.page.sourceId === page.sourceId && view.page.sourceIndex === page.sourceIndex) return;
    }
    record.doc.getPage(page.sourceIndex + 1).then(
      (pdfPage) => pdfPage.cleanup(),
      () => {}
    );
  }

  // ---------------------------------------------------------------------------------------------------------
  // page list
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Shows exactly this list (Page[] of ../model/schema.js: kind "pdf" and "blank"). Call it whenever the
   * model's list changes; the array itself is kept and must not be mutated afterwards.
   */
  setPages(pages) {
    const next = Array.isArray(pages) ? pages : EMPTY;
    if (next === this.#pages) return;
    const problems = checkPages(next);
    if (problems.length) throw new TypeError(`setPages: ${problems.slice(0, 3).join("; ")}`);
    const previous = this.#pages;
    const diff = diffPages(previous, next);
    this.#pages = next;
    this.#position = new Map(next.map((page, index) => [page.id, index]));

    const removed = new Set(diff.removed);
    for (const page of previous) {
      if (!removed.has(page.id)) continue;
      // React unmounts the slot right after; the bitmap goes now
      this.#views.get(page.id)?.release();
      this.#visible.delete(page.id);
      this.#near.delete(page.id);
    }
    for (const page of next) {
      const view = this.#views.get(page.id);
      if (view) view.setPage(page);
      else if (this.#hosts.has(page.id)) this.#views.set(page.id, new PageView({ page, host: this.#hosts.get(page.id), env: this.#viewEnvironment }));
    }
    this.#drawn = this.#drawn.filter((id) => this.#views.get(id)?.canvas);
    for (const page of previous) if (removed.has(page.id)) this.#releasePdfPage(page);
    for (const thumbnail of this.#thumbnails.values()) if (!this.#position.has(thumbnail.pageId)) this.#blankThumbnail(thumbnail);

    if (!this.#position.has(this.#currentPageId)) this.#currentPageId = next.length ? next[0].id : null;
    // a fit mode follows the page it fits: the first pages of a document, a rotated or replaced current page
    if (this.#container && (this.#zoomMode === "fit-width" || this.#zoomMode === "fit-page")) this.#applyZoom(this.#fitZoom(this.#zoomMode), this.#zoomMode);
    this.#changed();
    if (this.#search.query) this.#runSearch(this.#search.query, this.#search.options, { keepPosition: true });
    this.#settle();
    this.#schedule();
  }

  /**
   * The list entry that shows a page of a source (bookmarks and links name pages that way), or null when that
   * page is not in the list. Of several copies the one nearest to `near` (a page id) wins, else the first.
   */
  findPageId(sourceId, sourceIndex, { near = null } = {}) {
    const from = this.#position.get(near);
    let best = null;
    let bestDistance = Infinity;
    for (let index = 0; index < this.#pages.length; index += 1) {
      const page = this.#pages[index];
      if (page.kind !== "pdf" || page.sourceId !== sourceId || page.sourceIndex !== sourceIndex) continue;
      if (from === undefined) return page.id;
      const distance = Math.abs(index - from);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = page.id;
      }
    }
    return best;
  }

  #requirePage(pageId) {
    const page = this.getPage(pageId);
    if (!page) throw new PdfEditorError("VIEW_PAGE_UNKNOWN", { pageId });
    return page;
  }

  #requireSource(page) {
    const record = this.#sources.get(page.sourceId);
    if (!record) throw new PdfEditorError("VIEW_SOURCE_MISSING", { sourceId: page.sourceId });
    return record;
  }

  // ---------------------------------------------------------------------------------------------------------
  // DOM wiring (called by ./ViewerPages.jsx and ./PageThumbnail.jsx through ref callbacks)
  // ---------------------------------------------------------------------------------------------------------

  /**
   * React StrictMode (development) calls the cleanup of a ref and the ref again, back to back, for every
   * element it mounts AND for every element it moves inside a list. A detach therefore only takes effect in a
   * microtask, and not at all when the same element came back meanwhile: a page that only moved keeps its view
   * and its canvas in development as it does in production.
   */
  #detachSoon(key, element, drop) {
    this.#leaving.set(key, element);
    queueMicrotask(() => {
      if (this.#leaving.get(key) !== element) return;
      this.#leaving.delete(key);
      drop();
    });
  }

  #staying(key, element) {
    if (this.#leaving.get(key) === element) this.#leaving.delete(key);
  }

  /**
   * The scroll container of the page list. Usable as a React ref callback: returns its own cleanup.
   * The controller sets `--scale-factor` on it and listens to its scroll and size.
   */
  attachContainer = (element) => {
    const leave = (old) =>
      this.#detachSoon(CONTAINER_KEY, old, () => {
        if (this.#container === old) this.#dropContainer();
      });
    if (!element) {
      if (this.#container) leave(this.#container);
      return undefined;
    }
    this.#staying(CONTAINER_KEY, element);
    if (this.#container !== element) {
      this.#dropContainer();
      this.#container = element;
      this.#refreshDisplay();
      element.style.setProperty("--scale-factor", String(this.#scale));
      const thresholds = Array.from({ length: 11 }, (_, step) => step / 10);
      this.#visibleObserver = new IntersectionObserver((entries) => this.#onVisible(entries), { root: element, threshold: thresholds });
      // pre-render zone: two viewports above and below
      this.#nearObserver = new IntersectionObserver((entries) => this.#onNear(entries), { root: element, rootMargin: "200% 0px 200% 0px" });
      for (const host of this.#hosts.values()) {
        this.#visibleObserver.observe(host);
        this.#nearObserver.observe(host);
      }
      element.addEventListener("scroll", this.#onScroll, { passive: true });
      if (typeof ResizeObserver === "function") {
        this.#resizeObserver = new ResizeObserver(() => this.#onResize());
        this.#resizeObserver.observe(element);
      }
      this.#watchPixelRatio();
      if (this.#zoomMode === "fit-width" || this.#zoomMode === "fit-page") this.#applyZoom(this.#fitZoom(this.#zoomMode), this.#zoomMode);
      this.#settle();
    }
    return () => {
      if (this.#container === element) leave(element);
    };
  };

  #dropContainer() {
    const element = this.#container;
    if (!element) return;
    this.#visibleObserver?.disconnect();
    this.#nearObserver?.disconnect();
    this.#resizeObserver?.disconnect();
    this.#visibleObserver = this.#nearObserver = this.#resizeObserver = null;
    element.removeEventListener("scroll", this.#onScroll);
    this.#stopPixelRatioWatch?.();
    this.#stopPixelRatioWatch = null;
    this.#container = null;
    this.#visible.clear();
    this.#near.clear();
    this.#stopSettling();
    this.#refreshRendering();
  }

  /**
   * The host element of a page: an empty element whose parent is the page element (.pdfx-page). The controller
   * fills it with the canvas, the text layer and the link layer. Returns the cleanup for a ref callback.
   */
  attachPage = (pageId, host) => {
    const key = `page:${pageId}`;
    const leave = (old) =>
      this.#detachSoon(key, old, () => {
        if (this.#hosts.get(pageId) === old) this.#dropPage(pageId);
      });
    if (!host) {
      if (this.#hosts.has(pageId)) leave(this.#hosts.get(pageId));
      return undefined;
    }
    this.#staying(key, host);
    if (this.#hosts.get(pageId) !== host) {
      this.#dropPage(pageId);
      this.#hosts.set(pageId, host);
      this.#hostPage.set(host, pageId);
      // a host that arrives before its page is in the list gets its view in setPages()
      const page = this.getPage(pageId);
      if (page) this.#views.set(pageId, new PageView({ page, host, env: this.#viewEnvironment }));
      this.#visibleObserver?.observe(host);
      this.#nearObserver?.observe(host);
      this.#changed();
      this.#settle();
    }
    return () => {
      if (this.#hosts.get(pageId) === host) leave(host);
    };
  };

  #dropPage(pageId) {
    const host = this.#hosts.get(pageId);
    if (!host) return;
    this.#visibleObserver?.unobserve(host);
    this.#nearObserver?.unobserve(host);
    const view = this.#views.get(pageId);
    if (this.#active?.kind === "page" && this.#active.view === view) this.#active = null;
    const page = view?.page;
    view?.destroy();
    this.#views.delete(pageId);
    this.#hosts.delete(pageId);
    this.#hostPage.delete(host);
    this.#visible.delete(pageId);
    this.#near.delete(pageId);
    this.#drawn = this.#drawn.filter((id) => id !== pageId);
    if (page) this.#releasePdfPage(page);
    this.#schedule();
  }

  #viewEnvironment = {
    pdfjs: null, // set by the constructor
    scale: () => this.#scale,
    display: () => this.#display,
    pdfPage: (page) => this.#pdfPage(page),
    textContent: (page) => {
      const record = page.kind === "pdf" ? this.#sources.get(page.sourceId) : null;
      return record ? this.#textContent(record, page.sourceIndex) : Promise.resolve(null);
    },
    annotations: (page, pdfPage) => {
      const record = this.#sources.get(page.sourceId);
      return record ? record.guard.run(pdfPage.getAnnotations({ intent: "display" })) : Promise.resolve([]);
    },
    linkService: (page) => this.#linkService(page),
    onState: () => this.#changed(),
    onRendered: (view, info) => {
      this.#counters.rendered += 1;
      this.#emit("pagerendered", { pageId: view.page.id, pageNumber: (this.#position.get(view.page.id) ?? -1) + 1, scale: this.#scale, ...info });
    },
    onTextLayer: (view) => {
      if (view.textReady) this.#counters.textLayers += 1;
      if (this.#search.results.length) this.#paintSearch();
      if (view.textReady && this.#pendingReveal && this.#pendingReveal.pageId === view.page.id) this.#revealCurrentMatch();
      this.#emit("textlayer", { pageId: view.page.id, ready: view.textReady });
    },
    onLayerError: (view, part, error) => {
      const code = part === "canvas" ? "VIEW_RENDER_FAILED" : part === "text" ? "VIEW_TEXT_LAYER_FAILED" : "VIEW_LINK_LAYER_FAILED";
      this.#emit("pageerror", { pageId: view.page.id, pageNumber: (this.#position.get(view.page.id) ?? -1) + 1, code, part, error });
    }
  };

  #refreshDisplay() {
    if (typeof window === "undefined") return;
    if (!this.#limits) this.#limits = Object.freeze({ ...canvasLimitsFor(typeof navigator === "undefined" ? {} : navigator), ...this.#limitOverrides });
    if (this.#singlePrecision === null) {
      // pdf.js' own probe: browsers that know CSS round() compute calc() in single precision
      const probe = document.createElement("div");
      probe.style.width = "round(down, calc(1.6666666666666665 * 792px), 1px)";
      this.#singlePrecision = probe.style.width === "calc(1320px)";
    }
    const pixelRatio = window.devicePixelRatio || 1;
    const screenArea = (window.screen?.availWidth || 0) * (window.screen?.availHeight || 0);
    const display = this.#display;
    if (display.pixelRatio === pixelRatio && display.screenArea === screenArea && display.limits === this.#limits && display.singlePrecision === this.#singlePrecision) return;
    this.#display = Object.freeze({ pixelRatio, limits: this.#limits, screenArea, singlePrecision: this.#singlePrecision });
    for (const view of this.#views.values()) view.invalidate();
    this.#changed();
    this.#schedule();
  }

  /** Browser zoom and moving the window to another monitor change devicePixelRatio: bitmaps must follow. */
  #watchPixelRatio() {
    this.#stopPixelRatioWatch?.();
    this.#stopPixelRatioWatch = null;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => {
      this.#refreshDisplay();
      this.#watchPixelRatio();
    };
    query.addEventListener("change", onChange, { once: true });
    this.#stopPixelRatioWatch = () => query.removeEventListener("change", onChange);
  }

  #onResize() {
    this.#refreshDisplay();
    if (this.#zoomMode === "fit-width" || this.#zoomMode === "fit-page") this.#applyZoom(this.#fitZoom(this.#zoomMode), this.#zoomMode);
    this.#settle();
  }

  // The two observers say WHEN the set of pages on screen may have changed (also for causes that come without
  // a scroll event: the container is hidden or shown, the layout around it moves). WHICH pages are on screen is
  // then measured: a callback arrives a frame late and its ratios are only as fine as its thresholds.
  #onVisible(entries) {
    if (!this.#measureVisibility()) {
      // the container has no box (hidden): take the observer's word
      for (const entry of entries) {
        const pageId = this.#hostPage.get(entry.target);
        if (!pageId || this.#hosts.get(pageId) !== entry.target || !this.#position.has(pageId)) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0) this.#visible.set(pageId, entry.intersectionRatio);
        else this.#visible.delete(pageId);
      }
    }
    this.#visibilityChanged();
  }

  #onNear(entries) {
    if (!this.#measureVisibility()) {
      for (const entry of entries) {
        const pageId = this.#hostPage.get(entry.target);
        if (!pageId || this.#hosts.get(pageId) !== entry.target || !this.#position.has(pageId)) continue;
        if (entry.isIntersecting) this.#near.add(pageId);
        else this.#near.delete(pageId);
      }
    }
    this.#visibilityChanged();
  }

  #visibilityChanged() {
    // a page that is being drawn but was scrolled out of sight gives way to a visible one
    const active = this.#active;
    if (active?.kind === "page" && !this.#visible.has(active.view.page.id) && this.#firstVisibleNeedingRender()) {
      this.#counters.cancelled += 1;
      active.view.cancelRender();
    }
    this.#schedule();
  }

  #onScroll = () => {
    this.#settle();
    if (this.#scrollFrame) return;
    this.#scrollFrame = requestAnimationFrame(() => {
      this.#scrollFrame = 0;
      if (this.#measureVisibility()) this.#visibilityChanged();
    });
  };

  /**
   * IntersectionObserver reports a new scroll position one frame late: until then "nothing to draw" would be a
   * lie. After anything that moves pages the queue counts as busy for two frames.
   */
  #settle() {
    if (!this.#container || typeof requestAnimationFrame !== "function") return;
    this.#stopSettling();
    this.#settling = true;
    this.#refreshRendering();
    const finish = () => {
      this.#stopSettling();
      this.#measureVisibility();
      this.#visibilityChanged();
      this.#refreshRendering();
    };
    this.#settleFrame = requestAnimationFrame(() => {
      this.#settleFrame = requestAnimationFrame(finish);
    });
    // a tab in the background gets no frames
    this.#settleTimer = setTimeout(finish, 400);
  }

  #stopSettling() {
    if (this.#settleFrame) cancelAnimationFrame(this.#settleFrame);
    if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
    this.#settleFrame = 0;
    this.#settleTimer = null;
    this.#settling = false;
  }

  /**
   * Measures which pages are on screen (with the share of each that shows), which ones are in the pre-render
   * zone (two container heights above and below) and which page is the current one: the page that fills most
   * of the view, the earlier one on a tie. The pages follow each other downwards, so a binary search finds the
   * first one of the zone: the cost does not grow with the length of the document.
   * @returns {boolean} false when nothing can be measured (no container, or it has no box)
   */
  #measureVisibility() {
    const container = this.#container;
    const pages = this.#pages;
    if (!container) return false;
    const frame = container.getBoundingClientRect();
    if (!(frame.width > 0) || !(frame.height > 0)) return false;
    const visible = new Map();
    const near = new Set();
    let best = null;
    let bestArea = 0;
    if (pages.length && this.#hosts.size) {
      const boxOf = (index) => this.#hosts.get(pages[index].id)?.getBoundingClientRect() || null;
      const zoneTop = frame.top - 2 * frame.height;
      const zoneBottom = frame.bottom + 2 * frame.height;
      let low = 0;
      let high = pages.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        const box = boxOf(middle);
        if (box && box.bottom > zoneTop) high = middle;
        else low = middle + 1;
      }
      // a few pages of slack on both ends: pages laid out side by side need not end in order
      for (let index = Math.max(0, low - 3), beyond = 0; index < pages.length && beyond < 4; index += 1) {
        const box = boxOf(index);
        if (!box || !(box.width > 0) || !(box.height > 0)) continue;
        if (box.top >= zoneBottom) {
          beyond += 1;
          continue;
        }
        if (box.bottom <= zoneTop) continue;
        const pageId = pages[index].id;
        near.add(pageId);
        const width = Math.min(box.right, frame.right) - Math.max(box.left, frame.left);
        const height = Math.min(box.bottom, frame.bottom) - Math.max(box.top, frame.top);
        if (!(width > 0) || !(height > 0)) continue;
        const area = width * height;
        visible.set(pageId, area / (box.width * box.height));
        if (area > bestArea + 1) {
          best = pageId;
          bestArea = area;
        }
      }
    }
    this.#visible = visible;
    this.#near = near;
    if (best && best !== this.#currentPageId) {
      this.#currentPageId = best;
      this.#changed();
      this.#emitViewChanged();
    }
    return true;
  }

  #emitViewChanged() {
    const index = this.#position.get(this.#currentPageId);
    this.#emit("viewchanged", {
      scale: this.#scale,
      zoom: this.#zoom,
      zoomMode: this.#zoomMode,
      currentPageId: index === undefined ? null : this.#currentPageId,
      currentPageNumber: index === undefined ? 0 : index + 1
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // render queue
  // ---------------------------------------------------------------------------------------------------------

  #schedule() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#pump();
    });
  }

  #firstVisibleNeedingRender() {
    let best = null;
    let bestRatio = -1;
    for (const [pageId, ratio] of this.#visible) {
      const view = this.#views.get(pageId);
      if (view?.needsRender && ratio > bestRatio) {
        best = view;
        bestRatio = ratio;
      }
    }
    return best;
  }

  /** Visible pages first, then explicit requests, then visible thumbnails, then the pages around the screen. */
  #pickNext() {
    const visible = this.#firstVisibleNeedingRender();
    if (visible) return { kind: "page", view: visible };
    if (this.#rasterJobs.length) return { kind: "raster", job: this.#rasterJobs[0] };
    for (const thumbnail of this.#thumbnails.values()) {
      if (thumbnail.visible && thumbnail.drawnKey !== this.#thumbnailKey(thumbnail)) return { kind: "thumbnail", thumbnail };
    }
    if (this.#visible.size > 0 && this.#near.size > 0) {
      const shown = [...this.#visible.keys()].map((id) => this.#position.get(id)).filter((index) => index !== undefined);
      const low = Math.min(...shown);
      const high = Math.max(...shown);
      let best = null;
      let bestDistance = Infinity;
      for (const pageId of this.#near) {
        const view = this.#views.get(pageId);
        const index = this.#position.get(pageId);
        if (!view?.needsRender || index === undefined) continue;
        const distance = index < low ? low - index : index > high ? index - high : 0;
        if (distance < bestDistance) {
          best = view;
          bestDistance = distance;
        }
      }
      if (best) return { kind: "page", view: best };
    }
    return null;
  }

  #pump() {
    if (this.#active || this.#zoomTimer !== null) {
      this.#refreshRendering();
      return;
    }
    const next = this.#pickNext();
    if (!next) {
      this.#evict();
      this.#refreshRendering();
      return;
    }
    this.#active = next;
    let work;
    if (next.kind === "page") {
      work = next.view.draw().then(() => {
        this.#touch(next.view.page.id);
        this.#evict();
      });
    } else if (next.kind === "raster") {
      this.#rasterJobs.shift();
      work = this.#runRasterJob(next.job);
    } else {
      work = this.#drawThumbnail(next.thumbnail);
    }
    work
      .catch((error) => console.error(error))
      .finally(() => {
        if (this.#active === next) this.#active = null;
        this.#schedule();
      });
    this.#refreshRendering();
  }

  #refreshRendering() {
    const rendering = Boolean(this.#active || this.#scheduled || this.#zoomTimer !== null || this.#settling || this.#pickNext());
    this.#setBusy("rendering", rendering);
  }

  #touch(pageId) {
    this.#drawn = this.#drawn.filter((id) => id !== pageId);
    if (this.#views.get(pageId)?.canvas) this.#drawn.push(pageId);
  }

  /** Releases the bitmaps and layers of pages far from the screen (page count AND bytes, see ./canvasSizing.js). */
  #evict() {
    const limits = this.#display.limits;
    if (!limits || !limits.renderedPages) return;
    for (const pageId of this.#visible.keys()) this.#touch(pageId);
    const drawn = this.#drawn.map((id) => ({ id, bytes: this.#views.get(id)?.canvasBytes || 0, keep: this.#visible.has(id) || this.#near.has(id) }));
    const victims = pickEvictions(drawn, { maxPages: Math.max(limits.renderedPages, 2 * this.#visible.size + 3), maxBytes: limits.renderedBytes });
    if (!victims.length) return;
    const gone = new Set(victims);
    for (const pageId of victims) {
      const view = this.#views.get(pageId);
      if (!view) continue;
      const page = view.page;
      view.release();
      this.#releasePdfPage(page);
      this.#counters.evicted += 1;
    }
    this.#drawn = this.#drawn.filter((id) => !gone.has(id));
  }

  /** Tries a page again after its render state became "error". */
  retryPage(pageId) {
    this.#views.get(pageId)?.retry();
    this.#schedule();
  }

  // ---------------------------------------------------------------------------------------------------------
  // zoom
  // ---------------------------------------------------------------------------------------------------------

  #gutter() {
    const container = this.#container;
    if (!container || typeof getComputedStyle !== "function") return DEFAULT_GUTTER;
    const value = parseFloat(getComputedStyle(container).getPropertyValue("--pdfx-viewer-gutter"));
    return Number.isFinite(value) ? value : DEFAULT_GUTTER;
  }

  #fitZoom(mode) {
    const container = this.#container;
    const page = this.getPage(this.#currentPageId) || this.#pages[0];
    if (mode === "actual") return 1;
    if (!container || !page) return this.#zoom;
    const { width, height } = visiblePageSize(page);
    const gutter = this.#gutter();
    return fitZoom(mode, { pageWidth: width, pageHeight: height, availableWidth: container.clientWidth - 2 * gutter, availableHeight: container.clientHeight - 2 * gutter });
  }

  /**
   * @param {"fit-width" | "fit-page" | "actual" | number} value  a mode, or a zoom factor (1 = 100 %; kept
   *        within 0.1 and 8). The fit modes follow the size of the scroll container and of the current page.
   * @param {{ anchor?: { clientX: number, clientY: number } }} [options]  the point that stays where it is
   *        (Ctrl + wheel, pinch); default: the middle of the scroll container
   */
  setZoom = (value, options = {}) => {
    if (typeof value === "string") {
      if (!ZOOM_MODES.includes(value) || value === "custom") return;
      this.#applyZoom(this.#fitZoom(value), value, options.anchor);
    } else {
      this.#applyZoom(clampZoom(value), "custom", options.anchor);
    }
  };

  /** setZoom with CSS pixels per point instead of a zoom factor. */
  setScale = (scale, options) => this.setZoom(scaleToZoom(scale), options);

  /** The next stop of ZOOM_STOPS (./zoom.js). */
  zoomIn = (options) => this.setZoom(nextZoomStop(this.#zoom), options);

  zoomOut = (options) => this.setZoom(previousZoomStop(this.#zoom), options);

  #applyZoom(zoom, mode, anchor) {
    const scale = zoomToScale(zoom);
    const scaleChanged = Math.abs(scale - this.#scale) > 1e-9;
    if (!scaleChanged && mode === this.#zoomMode) return;
    this.#zoomMode = mode;
    if (scaleChanged) {
      const container = this.#container;
      const kept = container ? this.#captureAnchor(anchor) : null;
      this.#zoom = zoom;
      this.#scale = scale;
      if (container) {
        // CSS-only step: slots, the old bitmaps, text and link layers all follow this one variable
        container.style.setProperty("--scale-factor", String(scale));
        if (kept) this.#restoreAnchor(kept);
      }
      for (const view of this.#views.values()) view.invalidate();
      if (this.#active?.kind === "page") this.#active.view.cancelRender();
      if (this.#zoomTimer !== null) clearTimeout(this.#zoomTimer);
      this.#zoomTimer = setTimeout(() => {
        this.#zoomTimer = null;
        this.#schedule();
      }, ZOOM_REDRAW_DELAY_MS);
      this.#settle();
    }
    this.#changed();
    this.#refreshRendering();
    this.#emitViewChanged();
  }

  /** Which page, and which spot of it, sits at the anchor point right now. */
  #captureAnchor(anchor) {
    const container = this.#container;
    const frame = container.getBoundingClientRect();
    const x = anchor && Number.isFinite(anchor.clientX) ? anchor.clientX : frame.left + container.clientWidth / 2;
    const y = anchor && Number.isFinite(anchor.clientY) ? anchor.clientY : frame.top + container.clientHeight / 2;
    let best = null;
    let bestDistance = Infinity;
    const candidates = this.#visible.size ? [...this.#visible.keys()] : [...this.#hosts.keys()].slice(0, 50);
    for (const pageId of candidates) {
      const host = this.#hosts.get(pageId);
      if (!host) continue;
      const box = host.getBoundingClientRect();
      if (!(box.width > 0) || !(box.height > 0)) continue;
      const distance = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { host, x, y, fx: (x - box.left) / box.width, fy: (y - box.top) / box.height };
      }
    }
    return best;
  }

  #restoreAnchor({ host, x, y, fx, fy }) {
    const container = this.#container;
    if (!host.isConnected) return;
    const box = host.getBoundingClientRect(); // forces the layout at the new scale
    container.scrollLeft += box.left + fx * box.width - x;
    container.scrollTop += box.top + fy * box.height - y;
  }

  // ---------------------------------------------------------------------------------------------------------
  // geometry of a page on screen
  // ---------------------------------------------------------------------------------------------------------

  /**
   * What the overlay maths needs for one page, or null when the page is not in the list:
   * { pageId, pageNumber, element, overlayElement, scale, geometry, extraRotation, rotation, width, height }.
   *   element / overlayElement  the page element and its overlay slot (null while React has not mounted them)
   *   geometry, extraRotation   arguments of ../engine/geometry.js
   *   width / height            the exact viewport in CSS pixels at `scale`. The element's box is this size
   *                             floored to the device pixel grid (at most 8 pixels smaller); positions measured
   *                             from its top-left corner are exact.
   */
  getPageView(pageId) {
    const page = this.getPage(pageId);
    if (!page) return null;
    const geometry = pageGeometry(page);
    const viewport = viewportTransform(geometry, this.#scale, page.rotation);
    const host = this.#hosts.get(pageId) || null;
    const element = host?.parentElement || null;
    return {
      pageId,
      pageNumber: this.#position.get(pageId) + 1,
      element,
      overlayElement: element ? element.querySelector(":scope > .pdfx-page-overlay") : null,
      scale: this.#scale,
      geometry,
      extraRotation: page.rotation,
      rotation: viewport.rotation,
      width: viewport.width,
      height: viewport.height
    };
  }

  /** The scroll container that is attached right now, or null. */
  getContainer() {
    return this.#container;
  }

  #pageBox(pageId) {
    const page = this.getPage(pageId);
    const host = this.#hosts.get(pageId);
    if (!page || !host) return null;
    return { page, geometry: pageGeometry(page), box: host.getBoundingClientRect() };
  }

  /** A point of the browser viewport (event.clientX / clientY) -> user space of the page, or null. */
  clientToUser(pageId, clientX, clientY) {
    const found = this.#pageBox(pageId);
    if (!found) return null;
    return viewportToUser(found.geometry, [clientX - found.box.left, clientY - found.box.top], this.#scale, found.page.rotation);
  }

  /** A user-space point of the page -> [clientX, clientY], or null. */
  userToClient(pageId, point) {
    const found = this.#pageBox(pageId);
    if (!found) return null;
    const [x, y] = userToViewport(found.geometry, point, this.#scale, found.page.rotation);
    return [x + found.box.left, y + found.box.top];
  }

  /** A rectangle of the browser viewport [left, top, right, bottom] -> the user-space rectangle under it. */
  clientRectToUser(pageId, rect) {
    const found = this.#pageBox(pageId);
    if (!found) return null;
    const { left, top } = found.box;
    return viewportRectToUser(found.geometry, [rect[0] - left, rect[1] - top, rect[2] - left, rect[3] - top], this.#scale, found.page.rotation);
  }

  /** A user-space rectangle -> its bounding box in the browser viewport [left, top, right, bottom]. */
  userRectToClient(pageId, rect) {
    const found = this.#pageBox(pageId);
    if (!found) return null;
    const [left, top, right, bottom] = userRectToViewport(found.geometry, rect, this.#scale, found.page.rotation);
    return [left + found.box.left, top + found.box.top, right + found.box.left, bottom + found.box.top];
  }

  /** The id of the page under a point of the browser viewport, or null (pages near the screen only). */
  pageAtPoint(clientX, clientY) {
    const candidates = this.#visible.size ? this.#visible.keys() : this.#hosts.keys();
    for (const pageId of candidates) {
      const box = this.#hosts.get(pageId)?.getBoundingClientRect();
      if (box && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) return pageId;
    }
    return null;
  }

  /**
   * Scrolls a page into view.
   * @param {string} pageId
   * @param {{ rect?: number[], align?: "start" | "center" | "nearest" }} [options]
   *        rect   a user-space rectangle of the page to show instead of its top edge
   *        align  "start" (default): the target's top at the top of the view; "center"; "nearest": move only
   *               when the target is not fully visible
   * @returns {boolean} false when the page is not in the list or not mounted
   */
  scrollToPage(pageId, { rect = null, align = "start" } = {}) {
    const container = this.#container;
    const found = this.#pageBox(pageId);
    if (!container || !found) return false;
    const frame = container.getBoundingClientRect();
    // the target in client coordinates
    let left = found.box.left;
    let top = found.box.top;
    let right = found.box.right;
    let bottom = found.box.bottom;
    if (Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite)) {
      const inPage = userRectToViewport(found.geometry, rect, this.#scale, found.page.rotation);
      left = found.box.left + inPage[0];
      top = found.box.top + inPage[1];
      right = found.box.left + inPage[2];
      bottom = found.box.top + inPage[3];
    }
    const viewTop = frame.top + container.clientTop;
    const viewLeft = frame.left + container.clientLeft;
    const viewHeight = container.clientHeight;
    const viewWidth = container.clientWidth;
    let dy = 0;
    let dx = 0;
    if (align === "center") {
      dy = (top + bottom) / 2 - (viewTop + viewHeight / 2);
      dx = (left + right) / 2 - (viewLeft + viewWidth / 2);
    } else if (align === "nearest") {
      if (top < viewTop + SCROLL_MARGIN) dy = top - viewTop - SCROLL_MARGIN;
      else if (bottom > viewTop + viewHeight - SCROLL_MARGIN) dy = Math.min(top - viewTop - SCROLL_MARGIN, bottom - (viewTop + viewHeight - SCROLL_MARGIN));
      if (left < viewLeft + SCROLL_MARGIN) dx = left - viewLeft - SCROLL_MARGIN;
      else if (right > viewLeft + viewWidth - SCROLL_MARGIN) dx = Math.min(left - viewLeft - SCROLL_MARGIN, right - (viewLeft + viewWidth - SCROLL_MARGIN));
    } else {
      dy = top - viewTop - SCROLL_MARGIN;
      // sideways only when the target would otherwise stay outside
      if (left < viewLeft || right > viewLeft + viewWidth) dx = left - viewLeft - SCROLL_MARGIN;
    }
    if (dy !== 0) container.scrollTop += dy;
    if (dx !== 0) container.scrollLeft += dx;
    this.#settle();
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // links
  // ---------------------------------------------------------------------------------------------------------

  /** The object pdf.js' link elements talk to (what PDFLinkService is in pdf.js' own viewer). */
  #linkService(page) {
    const controller = this;
    const origin = { pageId: page.id, sourceId: page.sourceId };
    return {
      externalLinkEnabled: true,
      eventBus: null,
      addLinkAttributes(link, url) {
        // `url` passed pdf.js' createValidAbsoluteUrl: http, https, ftp, mailto, tel only
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer nofollow";
        link.title = url;
      },
      getDestinationHash: () => "#",
      getAnchorUrl: () => "#",
      goToDestination: (dest) => controller.#followLink(origin, { dest }),
      executeNamedAction: (action) => controller.#followLink(origin, { action }),
      executeSetOCGState() {},
      getAttachmentContent: () => null
    };
  }

  /**
   * An internal link scrolls to its target page when that page is in the list (the copy nearest to the page
   * that holds the link); otherwise nothing moves. The "link" event tells either way.
   */
  async #followLink(origin, { dest, action }) {
    const record = this.#sources.get(origin.sourceId);
    if (!record) return;
    const generation = this.#generation;
    const from = this.#position.get(origin.pageId) ?? 0;
    let pageIndex = null;
    let rect = null;
    let target = null;
    if (action) {
      // named actions of the PDF are relative to the list the reader sees
      const step = { NextPage: 1, PrevPage: -1 }[action];
      if (step) target = this.#pages[from + step] || null;
      else if (action === "FirstPage") target = this.#pages[0] || null;
      else if (action === "LastPage") target = this.#pages[this.#pages.length - 1] || null;
    } else {
      let destination;
      try {
        destination = await record.guard.run(resolveDestination(record.doc, dest));
      } catch {
        return; // the source was closed meanwhile
      }
      if (generation !== this.#generation) return;
      if (destination) {
        pageIndex = destination.pageIndex;
        rect = destinationRect(destination, record.facts.pages[pageIndex]?.view);
        target = this.getPage(this.findPageId(origin.sourceId, pageIndex, { near: origin.pageId }));
      }
    }
    if (target) this.scrollToPage(target.id, rect ? { rect } : {});
    this.#emit("link", { pageId: origin.pageId, sourceId: origin.sourceId, pageIndex, targetPageId: target ? target.id : null, action: action || null });
  }

  // ---------------------------------------------------------------------------------------------------------
  // text lines and colours (Edit text, Highlight, Redact)
  // ---------------------------------------------------------------------------------------------------------

  /**
   * The lines of text of a page, in user space: see ./textLines.js for the exact shape
   * ({ text, rect, quad, baseline, angle, fontSize, font: { name, serif, monospace, bold, italic }, vertical, items }).
   * A blank page has none. The result is cached and shared: do not modify it.
   */
  async getTextLines(pageId) {
    const page = this.#requirePage(pageId);
    if (page.kind !== "pdf") return EMPTY;
    const record = this.#requireSource(page);
    const pageIndex = page.sourceIndex;
    let pending = record.lines.get(pageIndex);
    if (pending) {
      record.lines.delete(pageIndex);
      record.lines.set(pageIndex, pending);
      return pending;
    }
    pending = record.guard.run(this.#buildTextLines(record, page));
    pending.catch(() => {
      if (record.lines.get(pageIndex) === pending) record.lines.delete(pageIndex);
    });
    record.lines.set(pageIndex, pending);
    while (record.lines.size > TEXT_CONTENT_CACHE) record.lines.delete(record.lines.keys().next().value);
    return pending;
  }

  async #buildTextLines(record, page) {
    const pdfjs = this.#pdfjs;
    try {
      const content = await this.#textContent(record, page.sourceIndex);
      const pdfPage = await record.doc.getPage(page.sourceIndex + 1);
      const names = new Set();
      for (const item of content.items) if (typeof item.str === "string" && item.str.trim() && item.fontName) names.add(item.fontName);
      const loaded = (name) => {
        try {
          return pdfPage.commonObjs.has(name);
        } catch {
          return false;
        }
      };
      if ([...names].some((name) => !loaded(name))) {
        // Font objects reach the main thread with the operator list; a page that was never drawn has none yet.
        try {
          await pdfPage.getOperatorList();
        } catch {
          // the lines are still right, only the font names stay unknown
        }
        this.#releasePdfPage(page);
      }
      const fonts = (name) => {
        try {
          return pdfPage.commonObjs.has(name) ? pdfPage.commonObjs.get(name) : null;
        } catch {
          return null;
        }
      };
      const normalize = (value) => pdfjs.normalizeUnicode(value).normalize("NFC");
      return Object.freeze(groupTextLines(content.items, content.styles, { userUnit: page.userUnit || 1, fonts, normalize }));
    } catch (error) {
      if (!this.#sources.has(record.id) || isCancellation(error, pdfjs)) throw cancelled();
      throw error;
    }
  }

  /**
   * What the user selected in the text of the pages (the browser's own selection over the text layers), page
   * by page in list order: [{ pageId, text, rect, quads }], [] when no page text is selected.
   *   quads  one per selected line: [x1, y1, ..., x4, y4] in user space, corners top-left, top-right,
   *          bottom-right, bottom-left (the shape of a "text" highlight of ../model/schema.js)
   *   rect   [x0, y0, x1, y1] around all quads of the page: what a redaction of the selection covers
   *   text   the selected text of the page, lines separated by "\n", NFC
   * The boxes are the glyph boxes the browser reports for the selected characters. Text that is itself
   * rotated on its page gets the upright box around each piece.
   */
  getTextSelection() {
    if (typeof document === "undefined") return EMPTY;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return EMPTY;
    const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
    const out = [];
    for (const page of this.#pages) {
      const view = this.#views.get(page.id);
      const layer = view?.textReady ? view.textLayerDiv : null;
      if (!layer || !ranges.some((range) => range.intersectsNode(layer))) continue;
      const found = this.#pageBox(page.id);
      if (!found) continue;
      const toUser = (box) => viewportRectToUser(found.geometry, [box.left - found.box.left, box.top - found.box.top, box.right - found.box.left, box.bottom - found.box.top], this.#scale, page.rotation);
      // the selected part of every text node, with the box of its glyphs
      const pieces = [];
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const range of ranges) {
          if (!range.intersectsNode(node)) continue;
          const part = document.createRange();
          part.selectNodeContents(node);
          if (range.startContainer === node) part.setStart(node, range.startOffset);
          if (range.endContainer === node) part.setEnd(node, range.endOffset);
          const value = part.toString();
          if (part.collapsed || value === "") continue;
          for (const box of part.getClientRects()) {
            if (box.width > 0.25 && box.height > 0.25) pieces.push({ value, rect: toUser(box) });
          }
        }
      }
      if (!pieces.length) continue;
      // pieces that share a line (and are not a column apart) become one quad
      const lines = [];
      for (const piece of pieces) {
        const [x0, y0, x1, y1] = piece.rect;
        const height = y1 - y0;
        const line = lines[lines.length - 1];
        if (line) {
          const overlap = Math.min(line.rect[3], y1) - Math.max(line.rect[1], y0);
          const least = Math.min(line.rect[3] - line.rect[1], height);
          const gap = x0 - line.rect[2];
          if (overlap > 0.5 * least && gap <= 1.5 * least && gap >= -Math.max(line.rect[2] - line.rect[0], 2 * least)) {
            if (gap > 0.2 * least && !/\s$/.test(line.text) && !/^\s/.test(piece.value)) line.text += " ";
            line.text += piece.value;
            line.rect = [Math.min(line.rect[0], x0), Math.min(line.rect[1], y0), Math.max(line.rect[2], x1), Math.max(line.rect[3], y1)];
            continue;
          }
        }
        lines.push({ text: piece.value, rect: [x0, y0, x1, y1] });
      }
      const round = (value) => Math.round(value * 1000) / 1000;
      const quads = lines.map(({ rect: [x0, y0, x1, y1] }) => [x0, y1, x1, y1, x1, y0, x0, y0].map(round));
      const rect = [Math.min(...lines.map((line) => line.rect[0])), Math.min(...lines.map((line) => line.rect[1])), Math.max(...lines.map((line) => line.rect[2])), Math.max(...lines.map((line) => line.rect[3]))].map(round);
      const joined = lines.map((line) => line.text.trim()).filter(Boolean).join("\n");
      out.push({ pageId: page.id, text: this.#pdfjs.normalizeUnicode(joined).normalize("NFC"), rect, quads });
    }
    return out;
  }

  /**
   * Background and text colour of a piece of a page, from its rendered pixels (the bitmap on screen when
   * there is one, otherwise a small rendering of the piece).
   * @param {string} pageId
   * @param {number[]} rect  [x0, y0, x1, y1] in user space, e.g. the rect of a text line
   * @returns {Promise<{ background: string, text: string, found: boolean }>} "#rrggbb" colours; found = false
   *          when the piece shows a single colour (text is then black or white, whichever contrasts)
   */
  async sampleColors(pageId, rect) {
    const page = this.#requirePage(pageId);
    if (page.kind !== "pdf") return { background: "#ffffff", text: "#000000", found: false };
    this.#requireSource(page);
    const view = this.#views.get(pageId);
    // the bitmap on screen serves when it has at least 1.5 pixels per point (not at tiny zooms, not when capped)
    if (view?.canvas && view.renderedKey === view.wantedKey() && view.outputScale && this.#scale * view.outputScale.sx >= 1.5) {
      const box = userRectToViewport(pageGeometry(page), rect, this.#scale, page.rotation);
      const { canvas, outputScale } = view;
      const left = Math.max(0, Math.min(canvas.width - 1, Math.floor(box[0] * outputScale.sx)));
      const top = Math.max(0, Math.min(canvas.height - 1, Math.floor(box[1] * outputScale.sy)));
      const right = Math.max(left + 1, Math.min(canvas.width, Math.ceil(box[2] * outputScale.sx)));
      const bottom = Math.max(top + 1, Math.min(canvas.height, Math.ceil(box[3] * outputScale.sy)));
      const context = canvas.getContext("2d");
      if (context) {
        const { background, text: textColor, found } = sampleColorsFromPixels(context.getImageData(left, top, right - left, bottom - top).data);
        return { background, text: textColor, found };
      }
    }
    const canvas = await this.renderToCanvas(pageId, { rect, scale: 3, pixelRatio: 1 });
    try {
      const context = canvas.getContext("2d");
      const { background, text: textColor, found } = sampleColorsFromPixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
      return { background, text: textColor, found };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // small renderings: thumbnails, organiser tiles, previews
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Renders a page (or a piece of it) into a NEW canvas that belongs to the caller: set its width and height
   * to 0 when it is no longer shown, that frees the bitmap at once.
   * @param {string} pageId
   * @param {{ width?: number, scale?: number, rect?: number[], annotations?: boolean, pixelRatio?: number,
   *           signal?: AbortSignal }} [options]
   *        width        CSS pixels of the result (of the whole page, or of `rect`), or
   *        scale        CSS pixels per point (default 1)
   *        rect         user-space rectangle to render instead of the whole page
   *        annotations  false leaves out annotations, form values and signature appearances (default true)
   *        pixelRatio   device pixels per CSS pixel (default: the device's, at most 2)
   * @returns {Promise<HTMLCanvasElement>} pixel size = CSS size x pixelRatio; the page is drawn as the reader
   *          sees it (rotation applied) on white paper
   * @throws PdfEditorError VIEW_PAGE_UNKNOWN, VIEW_SOURCE_MISSING, VIEW_RENDER_FAILED, CANCELLED
   */
  renderToCanvas(pageId, options = {}) {
    const page = this.#requirePage(pageId);
    if (page.kind === "pdf") this.#requireSource(page);
    if (options.signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const job = { pageId, options, resolve, reject, generation: this.#generation, renderTask: null, done: false };
      job.abort = () => {
        if (job.done) return;
        job.done = true;
        this.#rasterJobs = this.#rasterJobs.filter((entry) => entry !== job);
        job.renderTask?.cancel();
        reject(cancelled());
      };
      options.signal?.addEventListener("abort", job.abort, { once: true });
      this.#rasterJobs.push(job);
      this.#schedule();
    });
  }

  async #runRasterJob(job) {
    if (job.done) return;
    try {
      const page = this.getPage(job.pageId);
      if (!page || job.generation !== this.#generation) throw cancelled();
      const canvas = await this.#rasterize(page, job.options, job);
      if (job.done) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      job.done = true;
      this.#counters.rasters += 1;
      job.resolve(canvas);
    } catch (error) {
      if (job.done) return;
      job.done = true;
      if (isCancellation(error, this.#pdfjs)) job.reject(cancelled());
      else if (isPdfEditorError(error)) job.reject(error);
      else job.reject(new PdfEditorError("VIEW_RENDER_FAILED", { pageNumber: (this.#position.get(job.pageId) ?? -1) + 1 }, { cause: error, detail: String(error?.message || error) }));
    } finally {
      job.options.signal?.removeEventListener("abort", job.abort);
    }
  }

  /** One page, or a piece of it, into a fresh canvas. `holder.renderTask` is set while pdf.js draws. */
  async #rasterize(page, { width, scale, rect = null, annotations = true, pixelRatio } = {}, holder = {}) {
    const geometry = pageGeometry(page);
    const whole = visiblePageSize(page);
    // the piece to show, in points as the reader sees the page: [left, top, right, bottom]
    let piece = [0, 0, whole.width, whole.height];
    if (Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite)) {
      const box = userRectToViewport(geometry, rect, 1, page.rotation);
      piece = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(whole.width, box[2]), Math.min(whole.height, box[3])];
      if (!(piece[2] > piece[0])) piece[2] = Math.min(whole.width, piece[0] + 1);
      if (!(piece[3] > piece[1])) piece[3] = Math.min(whole.height, piece[1] + 1);
    }
    const ratio = pixelRatio > 0 ? pixelRatio : Math.min(THUMBNAIL_MAX_RATIO, this.#display.pixelRatio || 1);
    const size = thumbnailSize({ width: piece[2] - piece[0], height: piece[3] - piece[1] }, { width, scale, pixelRatio: ratio });
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const paper = () => {
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return context;
    };
    if (page.kind !== "pdf") {
      paper();
      return canvas;
    }
    const pixelsPerPoint = size.scale * size.ratio;
    const view = this.#views.get(page.id);
    if (annotations !== false && view?.canvas && view.outputScale && view.renderedKey === view.wantedKey() && this.#scale * view.outputScale.sx >= pixelsPerPoint) {
      // The bitmap on screen is at least as sharp: scaling it down is much cheaper than rendering again.
      const context = paper();
      context.imageSmoothingQuality = "high";
      const kx = this.#scale * view.outputScale.sx;
      const ky = this.#scale * view.outputScale.sy;
      context.drawImage(view.canvas, piece[0] * kx, piece[1] * ky, (piece[2] - piece[0]) * kx, (piece[3] - piece[1]) * ky, 0, 0, canvas.width, canvas.height);
      return canvas;
    }
    try {
      const pdfPage = await this.#pdfPage(page);
      if (!pdfPage) throw new PdfEditorError("VIEW_SOURCE_MISSING", { sourceId: page.sourceId });
      // `piece` is in points as the reader sees the page, so the offsets are plain output pixels
      const viewport = pdfPage.getViewport({ scale: pixelsPerPoint, rotation: totalRotation(page), offsetX: -piece[0] * pixelsPerPoint, offsetY: -piece[1] * pixelsPerPoint });
      const renderTask = pdfPage.render({
        canvas,
        viewport,
        annotationMode: annotations === false ? this.#pdfjs.AnnotationMode.DISABLE : this.#pdfjs.AnnotationMode.ENABLE
      });
      holder.renderTask = renderTask;
      const record = this.#sources.get(page.sourceId);
      await (record ? record.guard.run(renderTask.promise) : renderTask.promise);
      holder.renderTask = null;
      this.#releasePdfPage(page);
      return canvas;
    } catch (error) {
      canvas.width = 0;
      canvas.height = 0;
      throw error;
    }
  }

  /**
   * A canvas element (rendered by ./PageThumbnail.jsx) that shows a page as a thumbnail. The controller draws
   * it when it comes near the screen, redraws it when the page changes, and frees its bitmap when it scrolls
   * away. Returns the cleanup for a ref callback.
   * @param {HTMLCanvasElement} canvas
   * @param {{ pageId: string, width: number }} options  width in CSS pixels
   */
  attachThumbnail = (canvas, { pageId, width } = {}) => {
    if (!canvas) return undefined;
    const wanted = width > 0 ? width : 120;
    const known = this.#thumbnails.get(canvas);
    this.#staying(canvas, canvas);
    if (!known || known.pageId !== pageId || known.width !== wanted) {
      this.#dropThumbnail(canvas);
      const root = scrollParent(canvas);
      const thumbnail = { canvas, pageId, width: wanted, drawnKey: null, visible: false, root };
      this.#thumbnails.set(canvas, thumbnail);
      canvas.dataset.renderState = RENDER_STATE.PENDING;
      let entry = this.#thumbnailObservers.get(root);
      if (!entry) {
        const observer = new IntersectionObserver((entries) => this.#onThumbnails(entries), { root, rootMargin: "100% 0px 100% 0px" });
        this.#thumbnailObservers.set(root, (entry = { observer, count: 0 }));
      }
      entry.count += 1;
      entry.observer.observe(canvas);
    }
    return () => this.#detachSoon(canvas, canvas, () => this.#dropThumbnail(canvas));
  };

  #dropThumbnail(canvas) {
    const thumbnail = this.#thumbnails.get(canvas);
    if (!thumbnail) return;
    this.#thumbnails.delete(canvas);
    const entry = this.#thumbnailObservers.get(thumbnail.root);
    if (entry) {
      entry.observer.unobserve(canvas);
      entry.count -= 1;
      if (entry.count <= 0) {
        entry.observer.disconnect();
        this.#thumbnailObservers.delete(thumbnail.root);
      }
    }
    this.#blankThumbnail(thumbnail);
  }

  #blankThumbnail(thumbnail) {
    if (thumbnail.drawnKey !== null || thumbnail.canvas.width > 0) {
      thumbnail.canvas.width = 0;
      thumbnail.canvas.height = 0;
    }
    thumbnail.drawnKey = null;
    thumbnail.canvas.dataset.renderState = RENDER_STATE.PENDING;
  }

  #onThumbnails(entries) {
    for (const entry of entries) {
      const thumbnail = this.#thumbnails.get(entry.target);
      if (!thumbnail) continue;
      thumbnail.visible = entry.isIntersecting;
      // thumbnails that scrolled away give their bitmap back (0.1 to 0.3 MB each, times hundreds of pages)
      if (!entry.isIntersecting) this.#blankThumbnail(thumbnail);
    }
    this.#schedule();
  }

  #thumbnailKey(thumbnail) {
    const page = this.getPage(thumbnail.pageId);
    if (!page) return "none";
    const open = page.kind !== "pdf" || this.#sources.has(page.sourceId);
    return `${contentKey(page)}|${totalRotation(page)}|${thumbnail.width}|${this.#display.pixelRatio}|${open ? 1 : 0}`;
  }

  async #drawThumbnail(thumbnail) {
    const key = this.#thumbnailKey(thumbnail);
    const page = this.getPage(thumbnail.pageId);
    const target = thumbnail.canvas;
    const holder = {};
    if (!page || (page.kind === "pdf" && !this.#sources.has(page.sourceId))) {
      // nothing to show (the source is closed or still opening): no stale picture stays behind
      this.#blankThumbnail(thumbnail);
      thumbnail.drawnKey = key;
      return;
    }
    thumbnail.drawnKey = key; // set first: a failure must not be retried in a loop
    target.dataset.renderState = RENDER_STATE.RENDERING;
    let rendered = null;
    try {
      rendered = await this.#rasterize(page, { width: thumbnail.width }, holder);
      if (this.#thumbnails.get(target) !== thumbnail || !thumbnail.visible || thumbnail.drawnKey !== key) {
        // it scrolled away or changed while it was drawn: nothing is shown, it is drawn when it comes back
        if (this.#thumbnails.get(target) === thumbnail) {
          if (thumbnail.drawnKey === key) thumbnail.drawnKey = null;
          target.dataset.renderState = RENDER_STATE.PENDING;
        }
        return;
      }
      target.width = rendered.width;
      target.height = rendered.height;
      target.getContext("2d").drawImage(rendered, 0, 0);
      target.dataset.renderState = RENDER_STATE.READY;
      this.#counters.thumbnails += 1;
    } catch (error) {
      if (this.#thumbnails.get(target) === thumbnail) target.dataset.renderState = isCancellation(error, this.#pdfjs) ? RENDER_STATE.PENDING : RENDER_STATE.ERROR;
    } finally {
      if (rendered) {
        rendered.width = 0;
        rendered.height = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // search
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Finds `query` in the pages of the list (kind "pdf"), in list order, and highlights the hits.
   * @param {string} query  empty = clear the search
   * @param {{ matchCase?: boolean, wholeWord?: boolean, matchDiacritics?: boolean }} [options]  all false by
   *        default: "hop dong" finds the accented words, including the d with stroke
   * @returns {Promise<{ total: number, current: number, pageId: string | null }>} current = 0-based index of
   *          the current hit (-1 = none), pageId = its page. The same values live in getSnapshot().search.
   */
  search(query, options = {}) {
    const clean = { matchCase: Boolean(options.matchCase), wholeWord: Boolean(options.wholeWord), matchDiacritics: Boolean(options.matchDiacritics) };
    return this.#runSearch(String(query ?? ""), Object.freeze(clean), { keepPosition: false });
  }

  /** Makes the next hit the current one (wraps around) and scrolls to it. */
  searchNext = () => this.#stepSearch(1);

  searchPrevious = () => this.#stepSearch(-1);

  clearSearch = () => {
    this.#runSearch("", Object.freeze({}), { keepPosition: false });
  };

  /**
   * The hits of the current search for a result list, in list order:
   * [{ index, pageId, pageNumber, before, match, after, current }] where `match` is the text that was found and
   * before / after up to `context` characters around it (line breaks as spaces).
   * @param {{ offset?: number, limit?: number, context?: number }} [options]  a window of the results
   *        (default: the first 200) and the size of the context (default 40)
   */
  getSearchResults({ offset = 0, limit = 200, context = 40 } = {}) {
    const search = this.#search;
    const key = foldKey(search.options);
    const flat = (value) => value.replace(/\s+/g, " ");
    const out = [];
    for (let index = Math.max(0, offset); index < search.results.length && out.length < limit; index += 1) {
      const result = search.results[index];
      const page = this.getPage(result.pageId);
      const record = page ? this.#sources.get(page.sourceId) : null;
      const pageText = record?.indexes.get(`${page.sourceIndex}|${key}`)?.pageText.text ?? "";
      out.push({
        index,
        pageId: result.pageId,
        pageNumber: (this.#position.get(result.pageId) ?? -1) + 1,
        before: flat(pageText.slice(Math.max(0, result.start - context), result.start)),
        match: flat(pageText.slice(result.start, result.end)),
        after: flat(pageText.slice(result.end, result.end + context)),
        current: index === search.current
      });
    }
    return out;
  }

  /** Makes the hit with this index (see getSearchResults) the current one and scrolls to it. */
  showSearchResult(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#search.results.length) return this.#searchResult();
    this.#search = { ...this.#search, current: index };
    this.#paintSearch();
    this.#changed();
    this.#revealCurrentMatch();
    return this.#searchResult();
  }

  #searchResult() {
    const match = this.#search.results[this.#search.current] || null;
    return { total: this.#search.results.length, current: this.#search.current, pageId: match ? match.pageId : null };
  }

  async #runSearch(query, options, { keepPosition }) {
    const token = (this.#searchToken += 1);
    const before = keepPosition ? this.#search.results[this.#search.current] || null : null;
    const active = query.trim() !== "";
    this.#pendingReveal = null;
    if (!active) {
      this.#search = { query: "", options: {}, results: [], byPage: new Map(), current: -1, running: false };
      this.#paintSearch();
      this.#setBusy("searching", false);
      this.#changed();
      return this.#searchResult();
    }
    if (!keepPosition) {
      this.#search = { query, options, results: [], byPage: new Map(), current: -1, running: true };
      this.#paintSearch();
    } else {
      this.#search = { ...this.#search, query, options, running: true };
    }
    this.#setBusy("searching", true);
    this.#changed();

    const results = [];
    const byPage = new Map();
    const pages = this.#pages;
    const key = foldKey(options);
    let lastPause = Date.now();
    for (const page of pages) {
      if (page.kind !== "pdf") continue;
      const record = this.#sources.get(page.sourceId);
      if (!record) continue;
      let strings;
      try {
        strings = await this.#pageStrings(record, page.sourceIndex);
      } catch {
        strings = EMPTY; // a page whose text cannot be read simply has no hit
      }
      if (token !== this.#searchToken) return this.#searchResult();
      const indexKey = `${page.sourceIndex}|${key}`;
      let index = record.indexes.get(indexKey);
      if (!index) record.indexes.set(indexKey, (index = indexPage(strings, options)));
      const found = findInPage(index, query, options);
      if (found.length) {
        const list = found.map((match) => ({ pageId: page.id, start: match.start, end: match.end, begin: match.begin, end_: match.end_ }));
        byPage.set(page.id, list);
        for (const match of list) results.push(match);
      }
      if (Date.now() - lastPause > 40) {
        // let the interface breathe on long documents
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (token !== this.#searchToken) return this.#searchResult();
        lastPause = Date.now();
      }
    }

    let current = results.length ? 0 : -1;
    if (before) {
      const again = results.findIndex((match) => match.pageId === before.pageId && match.start === before.start);
      if (again >= 0) current = again;
      else if (results.length) {
        const from = this.#position.get(before.pageId) ?? 0;
        const next = results.findIndex((match) => (this.#position.get(match.pageId) ?? 0) >= from);
        current = next >= 0 ? next : results.length - 1;
      }
    } else if (results.length) {
      // start with the first hit at or after the page the reader is looking at
      const from = this.#position.get(this.#currentPageId) ?? 0;
      const next = results.findIndex((match) => (this.#position.get(match.pageId) ?? 0) >= from);
      if (next >= 0) current = next;
    }
    this.#search = { query, options, results, byPage, current, running: false };
    this.#paintSearch();
    this.#setBusy("searching", false);
    this.#changed();
    if (current >= 0 && !keepPosition) this.#revealCurrentMatch();
    return this.#searchResult();
  }

  #stepSearch(delta) {
    const count = this.#search.results.length;
    if (!count) return this.#searchResult();
    this.#search = { ...this.#search, current: (this.#search.current + delta + count) % count };
    this.#paintSearch();
    this.#changed();
    this.#revealCurrentMatch();
    return this.#searchResult();
  }

  #highlightMode() {
    return this.#highlightPreference === "dom" || !supportsCssHighlights() ? "dom" : "css";
  }

  #paintSearch() {
    if (typeof document === "undefined") return;
    const search = this.#search;
    if (!search.results.length) {
      clearSearchHighlights(this.#highlightMode(), this.#views);
      this.#painted = { all: 0, current: 0 };
      return;
    }
    this.#painted = paintSearchHighlights(this.#highlightMode(), this.#views, search.byPage, search.results[search.current] || null);
  }

  #revealCurrentMatch() {
    const match = this.#search.results[this.#search.current];
    const container = this.#container;
    if (!match || !container) return;
    const view = this.#views.get(match.pageId);
    const range = view ? view.rangeFor(match) : null;
    if (!range) {
      // the page is not drawn yet: go to it, refine when its text layer arrives
      this.#pendingReveal = match;
      this.scrollToPage(match.pageId);
      return;
    }
    this.#pendingReveal = null;
    const box = range.getBoundingClientRect();
    const frame = container.getBoundingClientRect();
    if (box.top < frame.top + 40 || box.bottom > frame.bottom - 40) container.scrollTop += box.top - frame.top - container.clientHeight / 3;
    if (box.left < frame.left + 16 || box.right > frame.right - 16) container.scrollLeft += box.left - frame.left - container.clientWidth / 3;
    this.#settle();
  }

  // ---------------------------------------------------------------------------------------------------------
  // printing, diagnostics, end of life
  // ---------------------------------------------------------------------------------------------------------

  /** True where printBytes() can work (the browser shows PDFs in a frame). */
  canPrint() {
    return canPrintPdfBytes();
  }

  /**
   * Opens the browser's print dialog for the bytes the caller gives (the exported document, never a source).
   * Resolves with { loaded, printCalled, reason? }: see ./print.js.
   */
  printBytes(bytes, options) {
    return printPdfBytes(bytes, options);
  }

  /** Numbers for tests and measurements (not part of the store). */
  stats() {
    let canvases = 0;
    let canvasBytes = 0;
    let textLayers = 0;
    let linkLayers = 0;
    for (const view of this.#views.values()) {
      if (view.canvas) {
        canvases += 1;
        canvasBytes += view.canvasBytes;
      }
      if (view.textReady) textLayers += 1;
      if (view.linkLayer) linkLayers += 1;
    }
    let thumbnailBytes = 0;
    let thumbnailsDrawn = 0;
    for (const thumbnail of this.#thumbnails.values()) {
      const bytes = thumbnail.canvas.width * thumbnail.canvas.height * 4;
      thumbnailBytes += bytes;
      if (bytes > 0) thumbnailsDrawn += 1;
    }
    return {
      sources: this.#sources.size,
      pages: this.#pages.length,
      views: this.#views.size,
      canvases,
      canvasBytes,
      textLayers,
      linkLayers,
      visible: [...this.#visible.keys()],
      near: this.#near.size,
      thumbnails: this.#thumbnails.size,
      thumbnailsDrawn,
      thumbnailBytes,
      highlightMode: typeof document === "undefined" ? null : this.#highlightMode(),
      highlights: { ...this.#painted },
      counters: { ...this.#counters }
    };
  }

  /**
   * Cancels everything that runs, closes every source, empties the list and frees every bitmap. The elements
   * stay attached (React detaches them itself) and the instance can be used again.
   */
  dispose() {
    this.#generation += 1;
    this.#searchToken += 1;
    for (const entry of [...this.#opening.values()]) entry.cancel(cancelled());
    for (const job of [...this.#rasterJobs]) job.abort();
    this.#rasterJobs = [];
    if (this.#active?.kind === "raster") this.#active.job.abort();
    if (this.#zoomTimer !== null) clearTimeout(this.#zoomTimer);
    this.#zoomTimer = null;
    if (this.#scrollFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = 0;
    this.#stopSettling();
    this.#pendingReveal = null;
    if (typeof document !== "undefined") {
      clearSearchHighlights(this.#highlightMode(), this.#views);
      disposePrintFrame();
    }
    this.#search = { query: "", options: {}, results: [], byPage: new Map(), current: -1, running: false };
    this.#painted = { all: 0, current: 0 };
    for (const view of this.#views.values()) view.release();
    for (const thumbnail of this.#thumbnails.values()) this.#blankThumbnail(thumbnail);
    this.#visible.clear();
    this.#near.clear();
    this.#drawn = [];
    this.#pages = EMPTY;
    this.#position = new Map();
    this.#currentPageId = null;
    const records = [...this.#sources.values()];
    this.#sources.clear();
    for (const record of records) {
      record.guard.cancel(cancelled());
      record.loadingTask.destroy().catch(() => {});
    }
    this.#busy = { opening: this.#opening.size > 0, rendering: false, searching: false };
    this.#changed();
  }

  /** dispose() and stop listening to the worker: for a controller that is thrown away for good. */
  destroy() {
    this.dispose();
    this.#offWorkerError?.();
    this.#offWorkerError = null;
  }
}

/** The nearest ancestor that scrolls (the root of a thumbnail's observer), or null for the browser viewport. */
function scrollParent(element) {
  if (typeof getComputedStyle !== "function") return null;
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const { overflowY, overflowX } = getComputedStyle(parent);
    if (/auto|scroll|overlay/.test(overflowY) || /auto|scroll|overlay/.test(overflowX)) return parent;
  }
  return null;
}

/**
 * @param {object} dependencies
 * @param {object} dependencies.pdfjs  the pdf.js namespace (legacy build)
 * @param {(params: object) => object} dependencies.openPdfDocument  getDocument with the editor's worker and
 *        asset URLs: returns a PDFDocumentLoadingTask (../pdfWorker.js; tests: tests/helpers/pdfViewerKit.mjs)
 * @param {(listener: (error: Error) => void) => () => void} [dependencies.onWorkerError]  tells when the pdf.js
 *        worker failed; files that are opening then reject with VIEW_WORKER_FAILED
 * @param {"css" | "dom"} [dependencies.highlightMode]  forces a search highlight renderer (default: the CSS
 *        Custom Highlight API where it exists)
 * @param {{ maxCanvasPixels?: number, maxCanvasDim?: number, capCanvasAreaFactor?: number, renderedPages?: number,
 *           renderedBytes?: number }} [dependencies.limits]  overrides of the canvas caps and of the release
 *        budgets (defaults: canvasLimitsFor() of ./canvasSizing.js, the values of pdf.js' own viewer)
 */
export function createViewerController(dependencies) {
  return new ViewerController(dependencies);
}

export { RENDER_STATE };
