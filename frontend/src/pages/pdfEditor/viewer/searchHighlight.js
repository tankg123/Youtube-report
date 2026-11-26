// Paints search hits over the text layers. Two renderers:
//   "css"  the CSS Custom Highlight API (Chrome 105, Safari 17.2, Firefox 140): ranges are registered under two
//          names and styled with ::highlight(); the DOM is not touched
//   "dom"  fallback: the spans that contain a hit are rewritten with <span class="highlight"> pieces, the way
//          pdf.js' own TextHighlighter does, and restored before the next painting
// Browser module. The registry of highlights is one per document: the names carry the editor's prefix.

export const HIGHLIGHT_ALL = "pdfx-search";
export const HIGHLIGHT_CURRENT = "pdfx-search-current";

export const supportsCssHighlights = () =>
  typeof CSS !== "undefined" && Boolean(CSS.highlights) && typeof Highlight === "function" && typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in document;

// The two ::highlight() rules are not in styles/viewer.css: the CSS minifier of the build does not know the
// pseudo-element. A constructed style sheet needs no <style> element (it passes a strict Content-Security-Policy)
// and, like the stylesheet of the editor, it is scoped to .pdfx-root and stays in the document.
let highlightSheet = null;

function ensureHighlightStyles() {
  if (highlightSheet) return;
  const scope = ".pdfx-root .pdfx-page-host .textLayer";
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    `${scope} ::highlight(${HIGHLIGHT_ALL}) { background-color: var(--pdfx-viewer-hit, rgb(255 196 0 / 0.4)); color: transparent; }\n` +
      `${scope} ::highlight(${HIGHLIGHT_CURRENT}) { background-color: var(--pdfx-viewer-hit-current, rgb(255 96 0 / 0.55)); color: transparent; }`
  );
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  highlightSheet = sheet;
}

function paintCss(views, matchesByPage, current) {
  ensureHighlightStyles();
  const all = new Highlight();
  const now = new Highlight();
  for (const [pageId, matches] of matchesByPage) {
    const view = views.get(pageId);
    if (!view?.textReady) continue;
    for (const match of matches) {
      const range = view.rangeFor(match);
      if (range) (match === current ? now : all).add(range);
    }
  }
  CSS.highlights.set(HIGHLIGHT_ALL, all);
  CSS.highlights.set(HIGHLIGHT_CURRENT, now);
  return { all: all.size, current: now.size };
}

function restoreSpans(view) {
  if (!view.highlightedItems || !view.textLayer) return;
  const { textDivs, textContentItemsStr: strings } = view.textLayer;
  for (const item of view.highlightedItems) {
    if (textDivs[item]) textDivs[item].textContent = strings[item];
  }
  view.highlightedItems = null;
}

function paintDom(view, matches, current) {
  restoreSpans(view);
  if (!matches.length) return 0;
  const { textDivs, textContentItemsStr: strings } = view.textLayer;
  const perItem = new Map(); // item -> [{ from, to, current }]
  const add = (item, from, to, isCurrent) => {
    if (to <= from || !textDivs[item]) return;
    let list = perItem.get(item);
    if (!list) perItem.set(item, (list = []));
    list.push({ from, to, current: isCurrent });
  };
  for (const match of matches) {
    const isCurrent = match === current;
    if (match.begin.item === match.end_.item) {
      add(match.begin.item, match.begin.offset, match.end_.offset, isCurrent);
    } else {
      add(match.begin.item, match.begin.offset, strings[match.begin.item].length, isCurrent);
      for (let item = match.begin.item + 1; item < match.end_.item; item += 1) add(item, 0, strings[item].length, isCurrent);
      add(match.end_.item, 0, match.end_.offset, isCurrent);
    }
  }
  for (const [item, list] of perItem) {
    const span = textDivs[item];
    const text = strings[item];
    list.sort((left, right) => left.from - right.from);
    span.textContent = "";
    let position = 0;
    for (const piece of list) {
      if (piece.from > position) span.append(document.createTextNode(text.slice(position, piece.from)));
      const mark = document.createElement("span");
      mark.className = piece.current ? "highlight appended selected" : "highlight appended";
      mark.textContent = text.slice(Math.max(position, piece.from), piece.to);
      span.append(mark);
      position = Math.max(position, piece.to);
    }
    if (position < text.length) span.append(document.createTextNode(text.slice(position)));
  }
  view.highlightedItems = [...perItem.keys()];
  return matches.length;
}

/**
 * @param {"css" | "dom"} mode
 * @param {Map<string, object>} views           page id -> PageView
 * @param {Map<string, object[]>} matchesByPage page id -> matches of ./searchText.js
 * @param {object | null} current               the current match (one of the objects above)
 * @returns {{ all: number, current: number }} how many pieces are painted right now
 */
export function paintSearchHighlights(mode, views, matchesByPage, current) {
  if (mode === "css") {
    if (!supportsCssHighlights()) return { all: 0, current: 0 };
    return paintCss(views, matchesByPage, current);
  }
  let all = 0;
  let hasCurrent = 0;
  for (const view of views.values()) {
    if (!view.textReady || !view.textLayer) continue;
    const matches = matchesByPage.get(view.page.id) || [];
    all += paintDom(view, matches, current);
    if (current && matches.includes(current)) hasCurrent = 1;
  }
  return { all: all - hasCurrent, current: hasCurrent };
}

export function clearSearchHighlights(mode, views) {
  if (mode === "css") {
    if (supportsCssHighlights()) {
      CSS.highlights.delete(HIGHLIGHT_ALL);
      CSS.highlights.delete(HIGHLIGHT_CURRENT);
    }
    return;
  }
  for (const view of views.values()) restoreSpans(view);
}
