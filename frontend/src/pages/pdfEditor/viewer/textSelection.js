// Selection behaviour of pdf.js text layers, ported from web/text_layer_builder.js of pdfjs-dist 6.5.438
// (TextLayerBuilder.#bindMouse / #enableGlobalSelectionListener, Apache-2.0). That class only works inside
// pdf.js' own page view, but without this logic a drag that passes over the empty space between two lines
// makes the selection jump to the end of the page in Chromium < 148 and in Safari.
//
// How it works: every text layer ends with an ".endOfContent" element. While a selection touches a layer the
// layer has the class "selecting" (the stylesheet then stretches .endOfContent over the whole layer) and, in
// the engines that need it, .endOfContent is moved next to the focus of the selection so that the browser
// always has a selectable node under the pointer.
//
// Browser module (document listeners): registered while at least one text layer exists, removed with the last.

const layers = new Map(); // text layer element -> its .endOfContent element
let abortController = null;

export function registerTextLayer(textLayerDiv, endOfContent) {
  layers.set(textLayerDiv, endOfContent);
  enable();
}

export function unregisterTextLayer(textLayerDiv) {
  layers.delete(textLayerDiv);
  if (layers.size === 0) {
    abortController?.abort();
    abortController = null;
  }
}

function reset(end, textLayer) {
  textLayer.append(end);
  end.style.width = "";
  end.style.height = "";
  textLayer.classList.remove("selecting");
}

function enable() {
  if (abortController) return;
  abortController = new AbortController();
  const { signal } = abortController;
  let isPointerDown = false;
  let isFirefoxOrModernChromium;
  let previousRange = null;

  document.addEventListener("pointerdown", () => {
    isPointerDown = true;
  }, { signal });
  document.addEventListener("pointerup", () => {
    isPointerDown = false;
    layers.forEach(reset);
  }, { signal });
  window.addEventListener("blur", () => {
    isPointerDown = false;
    layers.forEach(reset);
  }, { signal });
  document.addEventListener("keyup", () => {
    if (!isPointerDown) layers.forEach(reset);
  }, { signal });

  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
      layers.forEach(reset);
      return;
    }
    const active = new Set();
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      if (range.collapsed && !isPointerDown) continue;
      for (const layer of layers.keys()) {
        if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
      }
    }
    for (const [layer, end] of layers) {
      if (active.has(layer)) layer.classList.add("selecting");
      else reset(end, layer);
    }
    if (isFirefoxOrModernChromium === undefined) {
      const first = layers.values().next().value;
      isFirefoxOrModernChromium = Boolean(first) && getComputedStyle(first).getPropertyValue("-moz-user-select") === "none";
      if (!isFirefoxOrModernChromium) {
        const version = navigator.userAgentData
          ? navigator.userAgentData.brands.find(({ brand }) => brand === "Chromium")?.version
          : /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
        isFirefoxOrModernChromium = Boolean(version) && parseInt(version, 10) >= 148;
      }
    }
    if (isFirefoxOrModernChromium) return;

    // Chromium < 148 and Safari: keep .endOfContent right after the node the selection ends in
    const range = selection.getRangeAt(0);
    const modifyStart =
      previousRange &&
      (range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0);
    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (anchor.classList?.contains("highlight")) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0) {
      try {
        do {
          while (!anchor.previousSibling) anchor = anchor.parentNode;
          anchor = anchor.previousSibling;
        } while (!anchor.childNodes.length);
      } catch {
        return; // the selection ends outside any text layer
      }
    }
    const parentTextLayer = anchor.parentElement?.closest(".textLayer");
    const end = layers.get(parentTextLayer);
    if (end) {
      end.style.width = parentTextLayer.style.width;
      end.style.height = parentTextLayer.style.height;
      end.style.userSelect = "text";
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    previousRange = range.cloneRange();
  }, { signal });
}
