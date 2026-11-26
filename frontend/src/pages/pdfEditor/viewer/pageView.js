// One page of the working document on screen, drawn with the core API of pdf.js:
//   canvas (page.render, annotations painted in)  +  selectable text layer (TextLayer)  +  link layer
// (AnnotationLayer, links only). Browser module: it creates DOM nodes.
//
// Ownership: React renders the page element and, inside it, an EMPTY host element; this class only manages
// the children of that host. One instance lives as long as the host element: it survives zoom, rotation and
// reordering of the list, and gives its canvas up when the controller evicts it.
//
//   host (.pdfx-page-host)
//     div.pdfx-canvas       > canvas     kept (stretched by CSS) until the next bitmap is complete
//     div.textLayer         > span ...   laid out by pdf.js in page units; size and rotation come from CSS
//     div.annotationLayer   > section.linkAnnotation > a

import { computeCanvasSize } from "./canvasSizing.js";
import { createGuard } from "./guard.js";
import { contentKey, totalRotation } from "./pageList.js";
import { registerTextLayer, unregisterTextLayer } from "./textSelection.js";

export const RENDER_STATE = Object.freeze({ PENDING: "pending", RENDERING: "rendering", READY: "ready", ERROR: "error" });

const DRAW_CANCELLED = Object.freeze({ name: "AbortError", message: "drawing cancelled" });

const zeroCanvas = (canvas) => {
  // frees the backing store at once instead of waiting for the garbage collector
  canvas.width = 0;
  canvas.height = 0;
};

/**
 * True for what is thrown when work was cancelled on purpose: pdf.js' exceptions for a cancelled render, text
 * layer or document load, the editor's own CANCELLED error, and an AbortError.
 */
export function isCancellation(error, pdfjs) {
  if (!error) return false;
  if (pdfjs && (error instanceof pdfjs.RenderingCancelledException || error instanceof pdfjs.AbortException)) return true;
  const name = error.name || "";
  if (name === "RenderingCancelledException" || name === "AbortException" || name === "AbortError") return true;
  if (name === "PdfEditorError" && error.code === "CANCELLED") return true;
  const message = String(error.message || "");
  return message === "Loading aborted" || message === "Worker was destroyed" || message.startsWith("Transport destroyed");
}

export class PageView {
  /**
   * @param {object} options
   * @param {object} options.page   Page of ../model/schema.js
   * @param {HTMLElement} options.host  the empty host element inside the page element
   * @param {object} options.env    what the controller lends to its page views:
   *        pdfjs                      the pdf.js namespace
   *        scale()                    CSS pixels per point
   *        display()                  { pixelRatio, limits, screenArea, singlePrecision }
   *        pdfPage(page)              Promise<PDFPageProxy | null> (null: the source is not open)
   *        textContent(page)          Promise<{ items, styles, lang } | null>
   *        annotations(page, pdfPage) Promise<annotation data of the page>
   *        linkService(page)          the object pdf.js' link elements call
   *        onState(view)              the render state changed
   *        onRendered(view, info)     a canvas was swapped in
   *        onTextLayer(view)          the text layer appeared or went away
   *        onLayerError(view, part, error)   part = "canvas" | "text" | "links"
   */
  constructor({ page, host, env }) {
    this.page = page;
    this.host = host;
    this.env = env;
    this.state = page.kind === "pdf" ? RENDER_STATE.PENDING : RENDER_STATE.READY;
    this.error = null;
    this.destroyed = false;
    this.waitingForSource = false;
    this.renderedKey = null; // key of the bitmap on screen
    this.canvas = null;
    this.outputScale = null; // { sx, sy }: bitmap pixels per CSS pixel of the page box
    this.restricted = false; // the bitmap is smaller than the device could show (canvas cap)
    this.renderTask = null;
    this.drawGuard = null; // lets a drawing that waits for pdf.js go at once when it is cancelled
    this.drawToken = 0; // a drawing that finds another token was superseded
    this.layerToken = 0; // the same for the text and link layers: bumped when the view is released
    this.textLayer = null;
    this.textLayerDiv = null;
    this.textLayerPromise = null;
    this.textReady = false;
    this.endOfContent = null;
    this.highlightedItems = null; // items rewritten by the fallback highlighter
    this.linkLayer = null; // AnnotationLayer, or false when the page has no link
    this.linkLayerDiv = null;
    this.linkLayerPromise = null;
    this.onSelectStart = null;
    this.onCopy = null;

    this.canvasWrapper = document.createElement("div");
    this.canvasWrapper.className = "pdfx-canvas";
    host.append(this.canvasWrapper);
  }

  get rotation() {
    return totalRotation(this.page);
  }

  get canvasBytes() {
    return this.canvas ? this.canvas.width * this.canvas.height * 4 : 0;
  }

  /** What the bitmap on screen must have been drawn for. */
  wantedKey() {
    const display = this.env.display();
    return `${this.env.scale()}|${display.pixelRatio}|${this.rotation}|${contentKey(this.page)}`;
  }

  get needsRender() {
    return this.page.kind === "pdf" && !this.destroyed && !this.waitingForSource && this.state !== RENDER_STATE.ERROR && this.renderedKey !== this.wantedKey();
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.env.onState(this);
  }

  /** The list changed: the same id may have moved (nothing to do), been rotated or point at other content. */
  setPage(page) {
    const previous = this.page;
    this.page = page;
    if (previous === page) return;
    if (contentKey(previous) !== contentKey(page)) {
      this.release();
      return;
    }
    if (totalRotation(previous) !== totalRotation(page)) {
      // The old bitmap has the wrong orientation: drop it instead of stretching it. The layers only turn.
      this.cancelRender();
      this.dropCanvas();
      const viewport = { scale: this.env.scale(), rotation: this.rotation };
      if (this.textLayer) this.textLayer.update({ viewport });
      if (this.linkLayer) this.linkLayer.update({ viewport });
      this.error = null;
      this.setState(RENDER_STATE.PENDING);
    }
  }

  /** The zoom or the device pixel ratio changed: the bitmap is stale, an error deserves another attempt. */
  invalidate() {
    if (this.page.kind !== "pdf" || this.destroyed) return;
    if (this.state === RENDER_STATE.ERROR) {
      this.error = null;
      this.setState(RENDER_STATE.PENDING);
    } else if (this.state === RENDER_STATE.READY && this.renderedKey !== this.wantedKey()) {
      this.setState(RENDER_STATE.PENDING);
    }
  }

  /** A source was opened or closed. */
  sourceChanged() {
    this.waitingForSource = false;
    if (this.state === RENDER_STATE.ERROR) {
      this.error = null;
      this.setState(RENDER_STATE.PENDING);
    }
  }

  retry() {
    if (this.destroyed || this.page.kind !== "pdf") return;
    this.error = null;
    this.waitingForSource = false;
    this.renderedKey = null;
    this.setState(RENDER_STATE.PENDING);
  }

  dropCanvas() {
    if (this.canvas) {
      zeroCanvas(this.canvas);
      this.canvas = null;
    }
    this.canvasWrapper.replaceChildren();
    this.renderedKey = null;
    this.outputScale = null;
  }

  /** Draws the page at the current scale. Never rejects: failures end in the state "error". */
  async draw() {
    if (this.page.kind !== "pdf" || this.destroyed) return;
    const key = this.wantedKey();
    if (this.renderedKey === key && this.state === RENDER_STATE.READY) return;
    this.cancelRender();
    const token = (this.drawToken += 1);
    const stale = () => token !== this.drawToken || this.destroyed;
    const guard = (this.drawGuard = createGuard());
    this.setState(RENDER_STATE.RENDERING);
    const { pdfjs } = this.env;
    const started = performance.now();
    let canvas = null;
    try {
      const pdfPage = await guard.run(this.env.pdfPage(this.page));
      if (stale()) return;
      if (!pdfPage) {
        // the source of this page is not open (yet): wait for the controller to tell
        this.waitingForSource = true;
        this.setState(RENDER_STATE.PENDING);
        return;
      }
      const viewport = pdfPage.getViewport({ scale: this.env.scale(), rotation: this.rotation });
      const size = computeCanvasSize({ width: viewport.width, height: viewport.height, ...this.env.display() });
      canvas = document.createElement("canvas");
      canvas.width = size.canvasWidth;
      canvas.height = size.canvasHeight;
      canvas.setAttribute("role", "presentation");
      const renderTask = pdfPage.render({
        canvas,
        viewport,
        transform: size.transform,
        // ENABLE: form values and signature appearances are painted into the canvas (ENABLE_FORMS, the
        // default of pdf.js' own viewer, leaves text fields to an HTML layer that this viewer does not have)
        annotationMode: pdfjs.AnnotationMode.ENABLE
      });
      this.renderTask = renderTask;
      await guard.run(renderTask.promise);
      if (this.renderTask === renderTask) this.renderTask = null;
      if (stale()) {
        zeroCanvas(canvas);
        return;
      }
      // swap: the previous bitmap (stretched by CSS while this one was drawn) goes away now
      const old = this.canvas;
      this.canvas = canvas;
      this.canvasWrapper.replaceChildren(canvas);
      if (old) zeroCanvas(old);
      canvas = null;
      this.renderedKey = key;
      this.outputScale = { sx: size.sx, sy: size.sy };
      this.restricted = size.restricted;
      this.env.onRendered(this, { ms: performance.now() - started, canvasWidth: size.canvasWidth, canvasHeight: size.canvasHeight, restricted: size.restricted });

      await guard.run(this.ensureTextLayer(viewport));
      if (stale()) return;
      await guard.run(this.ensureLinkLayer(pdfPage, viewport));
      if (stale()) return;
      this.setState(this.renderedKey === this.wantedKey() ? RENDER_STATE.READY : RENDER_STATE.PENDING);
    } catch (error) {
      if (canvas) zeroCanvas(canvas);
      if (stale()) return;
      if (isCancellation(error, pdfjs)) {
        this.setState(this.canvas && this.renderedKey === this.wantedKey() ? RENDER_STATE.READY : RENDER_STATE.PENDING);
        return;
      }
      this.error = error;
      this.setState(RENDER_STATE.ERROR);
      this.env.onLayerError(this, "canvas", error);
    }
  }

  /** Builds the text layer once; later calls only tell it the rotation. The promise never rejects. */
  ensureTextLayer(viewport) {
    if (this.destroyed) return Promise.resolve();
    if (this.textReady && this.textLayer) {
      // The layer is laid out in page units and sized by CSS variables: zoom needs nothing at all.
      this.textLayer.update({ viewport });
      return Promise.resolve();
    }
    if (this.textLayerPromise) return this.textLayerPromise;
    const { pdfjs } = this.env;
    const page = this.page;
    const token = this.layerToken;
    const gone = () => this.destroyed || token !== this.layerToken;
    const build = async () => {
      const content = await this.env.textContent(page);
      if (gone() || !content) return;
      const div = document.createElement("div");
      div.className = "textLayer";
      const textLayer = new pdfjs.TextLayer({ textContentSource: content, container: div, viewport });
      this.textLayer = textLayer;
      this.textLayerDiv = div;
      try {
        await textLayer.render();
      } catch (error) {
        if (this.textLayer === textLayer) {
          this.textLayer = null;
          this.textLayerDiv = null;
        }
        throw error;
      }
      if (gone() || this.textLayer !== textLayer) return;
      // the rotation may have changed while the spans were laid out
      textLayer.update({ viewport: { scale: this.env.scale(), rotation: this.rotation } });
      const end = document.createElement("div");
      end.className = "endOfContent";
      div.append(end);
      this.endOfContent = end;
      this.onSelectStart = () => div.classList.add("selecting");
      div.addEventListener("mousedown", this.onSelectStart);
      this.onCopy = (event) => {
        // what pdf.js does: the clipboard gets the selection with ligatures and compatibility forms resolved
        const selection = document.getSelection();
        if (!selection || !event.clipboardData) return;
        event.clipboardData.setData("text/plain", pdfjs.normalizeUnicode(selection.toString()).replaceAll(String.fromCharCode(0), ""));
        event.preventDefault();
        event.stopPropagation();
      };
      div.addEventListener("copy", this.onCopy);
      registerTextLayer(div, end);
      this.canvasWrapper.after(div);
      this.textReady = true;
      this.env.onTextLayer(this);
    };
    const promise = build()
      .catch((error) => {
        if (!isCancellation(error, pdfjs) && !gone()) this.env.onLayerError(this, "text", error);
      })
      .finally(() => {
        // a layer that did not come to life may be tried again with the next drawing
        if (this.textLayerPromise === promise && !this.textReady) this.textLayerPromise = null;
      });
    this.textLayerPromise = promise;
    return promise;
  }

  /** Builds the link layer once (pages without links get none). The promise never rejects. */
  ensureLinkLayer(pdfPage, viewport) {
    if (this.destroyed) return Promise.resolve();
    const linkViewport = viewport.clone({ dontFlip: true });
    if (this.linkLayer) {
      this.linkLayer.update({ viewport: linkViewport });
      return Promise.resolve();
    }
    if (this.linkLayer === false) return Promise.resolve();
    if (this.linkLayerPromise) return this.linkLayerPromise;
    const { pdfjs } = this.env;
    const page = this.page;
    const token = this.layerToken;
    const gone = () => this.destroyed || token !== this.layerToken;
    const build = async () => {
      const annotations = await this.env.annotations(page, pdfPage);
      if (gone()) return;
      const links = annotations.filter((annotation) => annotation.annotationType === pdfjs.AnnotationType.LINK);
      if (links.length === 0) {
        this.linkLayer = false;
        return;
      }
      const div = document.createElement("div");
      div.className = "annotationLayer";
      const linkService = this.env.linkService(page);
      const layer = new pdfjs.AnnotationLayer({
        div,
        page: pdfPage,
        viewport: linkViewport,
        linkService,
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        structTreeLayer: null,
        commentManager: null,
        annotationStorage: null
      });
      await layer.render({
        viewport: linkViewport,
        div,
        annotations: links,
        page: pdfPage,
        linkService,
        renderForms: false,
        enableScripting: false,
        hasJSActions: false,
        fieldObjects: null,
        imageResourcesPath: "",
        annotationStorage: null
      });
      if (gone()) {
        layer.destroy();
        return;
      }
      layer.update({ viewport: pdfPage.getViewport({ scale: this.env.scale(), rotation: this.rotation }).clone({ dontFlip: true }) });
      this.linkLayer = layer;
      this.linkLayerDiv = div;
      (this.textLayerDiv?.isConnected ? this.textLayerDiv : this.canvasWrapper).after(div);
    };
    const promise = build()
      .catch((error) => {
        if (!isCancellation(error, pdfjs) && !gone()) this.env.onLayerError(this, "links", error);
      })
      .finally(() => {
        if (this.linkLayerPromise === promise) this.linkLayerPromise = null;
      });
    this.linkLayerPromise = promise;
    return promise;
  }

  /** Stops the drawing in progress, if any; a bitmap that is already on screen stays. */
  cancelRender() {
    this.drawToken += 1;
    if (this.drawGuard) {
      this.drawGuard.cancel(DRAW_CANCELLED);
      this.drawGuard = null;
    }
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
    if (this.state === RENDER_STATE.RENDERING) {
      this.setState(this.canvas && this.renderedKey === this.wantedKey() ? RENDER_STATE.READY : RENDER_STATE.PENDING);
    }
  }

  /** Frees everything that costs memory. The page element keeps its size: it becomes a placeholder. */
  release() {
    this.cancelRender();
    this.layerToken += 1;
    this.dropCanvas();
    const hadText = this.textReady;
    if (this.textLayer) {
      this.textLayer.cancel();
      this.textLayer = null;
    }
    if (this.textLayerDiv) {
      unregisterTextLayer(this.textLayerDiv);
      if (this.onSelectStart) this.textLayerDiv.removeEventListener("mousedown", this.onSelectStart);
      if (this.onCopy) this.textLayerDiv.removeEventListener("copy", this.onCopy);
      this.textLayerDiv.remove();
      this.textLayerDiv = null;
    }
    this.textLayerPromise = null;
    this.textReady = false;
    this.endOfContent = null;
    this.highlightedItems = null;
    if (this.linkLayer) this.linkLayer.destroy();
    this.linkLayerDiv?.remove();
    this.linkLayer = null;
    this.linkLayerDiv = null;
    this.error = null;
    this.waitingForSource = false;
    if (hadText) this.env.onTextLayer(this);
    this.setState(this.page.kind === "pdf" ? RENDER_STATE.PENDING : RENDER_STATE.READY);
  }

  destroy() {
    if (this.destroyed) return;
    this.release();
    this.destroyed = true;
    this.canvasWrapper.remove();
  }

  // --- text layer access for search ---

  /** The Text node and the offset in it for { item, offset } of the page text (see ./searchText.js). */
  domPoint({ item, offset }) {
    const span = this.textLayer?.textDivs[item];
    if (!span) return null;
    // a span holds one Text node unless the fallback highlighter has split it
    let remaining = offset;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let last = null;
    while (node) {
      if (remaining <= node.length) return { node, offset: remaining };
      remaining -= node.length;
      last = node;
      node = walker.nextNode();
    }
    if (last) return { node: last, offset: last.length };
    return { node: span, offset: 0 }; // an empty item (a line end) has no Text node
  }

  /** A DOM Range over a search match, or null while the text layer is not there. */
  rangeFor(match) {
    if (!this.textReady) return null;
    const start = this.domPoint(match.begin);
    const end = this.domPoint(match.end_);
    if (!start || !end) return null;
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      return null;
    }
    return range;
  }
}
