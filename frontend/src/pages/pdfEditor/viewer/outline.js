// Destinations and bookmarks of a pdf.js document, resolved to plain data. No DOM; pdf.js comes in as the
// opened document (PDFDocumentProxy), so the module also runs under `node --test`.
//
// A destination of a PDF is either a name (looked up in the document) or an explicit array
//   [pageRef | pageIndex, { name: "XYZ" | "Fit" | "FitH" | "FitV" | "FitR" | "FitB" | "FitBH" | "FitBV" }, ...numbers]

/**
 * @param {object} doc   PDFDocumentProxy
 * @param {string | Array<unknown>} dest  a named or an explicit destination
 * @returns {Promise<{ pageIndex: number, fit: string | null, args: unknown[] } | null>} pageIndex is 0-based
 *          in the source file; null when the destination does not lead to a page of the file
 */
export async function resolveDestination(doc, dest) {
  let explicit = dest;
  if (typeof dest === "string") {
    try {
      explicit = await doc.getDestination(dest);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const [ref, fit, ...args] = explicit;
  let pageIndex = null;
  if (ref && typeof ref === "object") {
    try {
      pageIndex = await doc.getPageIndex(ref);
    } catch {
      return null; // a reference to something that is not a page
    }
  } else if (Number.isInteger(ref)) {
    pageIndex = ref;
  }
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.numPages) return null;
  return { pageIndex, fit: fit && typeof fit === "object" && typeof fit.name === "string" ? fit.name : null, args };
}

const numberOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The spot a resolved destination points at, as a user-space rectangle for scrollToPage(pageId, { rect }):
 * a point [x, y, x, y] for XYZ / FitH / FitV, a real rectangle for FitR, null for "the whole page".
 * @param {{ fit: string | null, args: unknown[] }} destination
 * @param {number[]} view  the page's visible rectangle (missing coordinates default to its top-left corner)
 */
export function destinationRect(destination, view) {
  if (!destination || !Array.isArray(view)) return null;
  const { fit, args } = destination;
  const left = view[0];
  const top = view[3];
  if (fit === "XYZ") {
    const x = numberOrNull(args[0]);
    const y = numberOrNull(args[1]);
    if (x === null && y === null) return null;
    return [x ?? left, y ?? top, x ?? left, y ?? top];
  }
  if (fit === "FitH" || fit === "FitBH") {
    const y = numberOrNull(args[0]);
    return y === null ? null : [left, y, left, y];
  }
  if (fit === "FitV" || fit === "FitBV") {
    const x = numberOrNull(args[0]);
    return x === null ? null : [x, top, x, top];
  }
  if (fit === "FitR") {
    const numbers = args.slice(0, 4).map(numberOrNull);
    if (numbers.some((value) => value === null)) return null;
    return [Math.min(numbers[0], numbers[2]), Math.min(numbers[1], numbers[3]), Math.max(numbers[0], numbers[2]), Math.max(numbers[1], numbers[3])];
  }
  return null;
}

const MAX_OUTLINE_NODES = 20000;

/**
 * The bookmarks of a document as a tree of plain objects.
 * @param {object} doc  PDFDocumentProxy
 * @param {Array<{ view: number[] }>} pages  page facts of the source (index = page index)
 * @returns {Promise<Array<{ title: string, pageIndex: number | null, rect: number[] | null, children: Array<object> }>>}
 *          pageIndex = 0-based page of the SOURCE file, null for entries that lead nowhere in it (a web link,
 *          a missing page); rect as in destinationRect()
 */
export async function resolveOutline(doc, pages = []) {
  let outline;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  if (!Array.isArray(outline)) return [];
  let budget = MAX_OUTLINE_NODES;
  const pending = [];
  const build = (nodes) => {
    const out = [];
    for (const node of nodes) {
      if (budget <= 0) break;
      budget -= 1;
      const entry = { title: typeof node?.title === "string" ? node.title : "", pageIndex: null, rect: null, children: [] };
      if (node?.dest) {
        pending.push(
          resolveDestination(doc, node.dest).then((destination) => {
            if (!destination) return;
            entry.pageIndex = destination.pageIndex;
            entry.rect = destinationRect(destination, pages[destination.pageIndex]?.view);
          })
        );
      }
      if (Array.isArray(node?.items) && node.items.length) entry.children = build(node.items);
      out.push(entry);
    }
    return out;
  };
  const tree = build(outline);
  await Promise.all(pending);
  return tree;
}
