// DOM helpers of the text editor (browser): reading the text of the editable element, inserting plain text,
// and finding where the caret stands.
//
// What a contenteditable="plaintext-only" element really holds (Chrome and Edge 157): text nodes with line
// feeds, split into several nodes after Enter, and one extra line feed (or a <br>) at the end while the
// caret stands on an empty last line. Whatever the shape, the model text is "everything, minus ONE trailing
// line break": a text of n line feeds shows n + 1 lines, and so does the committed box.
//
// The editable element is laid out at the layout scale and painted through a transform, which shrinks the
// browser's own caret to a fraction of a device pixel. The editor hides it and draws one itself, from the
// box the browser reports for the collapsed selection. That box is in client pixels; three zero-size marker
// elements with known local positions give the exact map back into the element's own coordinates, whatever
// transforms (zoom, page rotation, a rotated frame) lie in between.
import { normalizeText } from "./fontSupport.js";
import { boxDomText } from "./textStyle.js";

const LINE_FEED = String.fromCharCode(0x0a);
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const BLOCKS = new Set(["DIV", "P", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE"]);
/** Local distance between the marker elements (layout pixels). */
export const MARKER_SPAN = 1024;

/** The text an editable element shows, line breaks as line feeds, INCLUDING the browser's trailing placeholder. */
export function readEditableText(root) {
  let out = "";
  const walk = (parent) => {
    for (const node of parent.childNodes) {
      if (node.nodeType === TEXT_NODE) {
        out += node.data;
      } else if (node.nodeType === ELEMENT_NODE) {
        if (node.nodeName === "BR") {
          out += LINE_FEED;
          continue;
        }
        const block = BLOCKS.has(node.nodeName);
        // a block starts on a line of its own ...
        if (block && out !== "" && !out.endsWith(LINE_FEED)) out += LINE_FEED;
        const before = out.length;
        walk(node);
        // ... and ends its line (an empty block is an empty line)
        if (block && (out.length === before || !out.endsWith(LINE_FEED))) out += LINE_FEED;
      }
    }
  };
  walk(root);
  return out;
}

/** The model text of an editable element: its text without the trailing placeholder, normalised. */
export function editableModelText(root) {
  const raw = readEditableText(root);
  return normalizeText(raw.endsWith(LINE_FEED) ? raw.slice(0, -1) : raw);
}

/** The text to put into the editable element for a model text (an empty last line needs its placeholder). */
export const editableDomText = boxDomText;

/** Does this browser know contenteditable="plaintext-only"? (Firefox before 136 does not.) */
export function supportsPlaintextOnly(doc) {
  try {
    const probe = doc.createElement("div");
    probe.setAttribute("contenteditable", "plaintext-only");
    return probe.contentEditable === "plaintext-only";
  } catch {
    return false;
  }
}

/**
 * Inserts plain text at the selection of the focused editable element, as the user's own typing would: the
 * selection is replaced, the browser's undo history learns about it (one step for the whole text), and no
 * element is created (execCommand("insertText") with a line feed in it makes <div> children, the browser's
 * own paste of a text that ends with a line break too). Never call it during an IME composition.
 */
export function insertPlainText(doc, text) {
  text.split(LINE_FEED).forEach((line, index) => {
    if (index > 0) doc.execCommand("insertLineBreak");
    if (line) doc.execCommand("insertText", false, line);
  });
}

// The DOM position of a UTF-16 offset in the text of the element's text nodes (clamped): [node, offset].
function positionOf(doc, root, offset) {
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let remaining = Math.max(0, offset);
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    last = node;
    if (remaining <= node.length) return [node, remaining];
    remaining -= node.length;
  }
  return last ? [last, last.length] : [root, 0];
}

/** Puts a collapsed selection at a UTF-16 offset of the editable element's text (clamped). */
export function setCaretOffset(doc, root, offset) {
  const range = doc.createRange();
  range.setStart(...positionOf(doc, root, offset));
  range.collapse(true);
  const selection = doc.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The UTF-16 offset, in the text of the element's text nodes, of a DOM position inside the element. */
export function textOffsetOf(doc, root, container, offset) {
  const range = doc.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

/** A Range over the UTF-16 offsets [start, end) of the text of the element's text nodes. */
export function rangeOfText(doc, root, start, end) {
  const range = doc.createRange();
  range.setStart(...positionOf(doc, root, start));
  range.setEnd(...positionOf(doc, root, end));
  return range;
}

/** Selects everything in the editable element. */
export function selectAllText(doc, root) {
  const range = doc.createRange();
  range.selectNodeContents(root);
  const selection = doc.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// The first thing after a DOM position inside `root` that can be asked for a box: { node, offset } for a
// character, { element } for a <br>, or null at the end of the content.
function leafAfter(root, container, offset) {
  let node;
  if (container.nodeType === TEXT_NODE) {
    if (offset < container.length) return { node: container, offset };
    node = container;
  } else if (offset < container.childNodes.length) {
    node = container.childNodes[offset];
    const first = firstLeaf(node);
    if (first) return first;
  } else {
    node = container;
  }
  // walk on in document order
  for (;;) {
    while (node && node !== root && !node.nextSibling) node = node.parentNode;
    if (!node || node === root) return null;
    node = node.nextSibling;
    const first = firstLeaf(node);
    if (first) return first;
  }
}

function firstLeaf(node) {
  if (node.nodeType === TEXT_NODE) return node.length > 0 ? { node, offset: 0 } : null;
  if (node.nodeType !== ELEMENT_NODE) return null;
  if (node.nodeName === "BR") return { element: node };
  for (const child of node.childNodes) {
    const found = firstLeaf(child);
    if (found) return found;
  }
  return null;
}

/**
 * The caret of a collapsed selection inside `root`:
 *   null                       no caret to draw (no selection, a range selected, or the selection is elsewhere)
 *   { x, y }                   CLIENT pixels of the middle of the caret line
 *   { unknown: true }          the caret is in the box but the browser reports no box for it (an empty box,
 *                              or the end of the content behind a line break): the caller places it on the
 *                              last line from the layout's metrics
 * A collapsed range has no box at the start of an empty line; the line break that ends that line has one.
 */
export function caretPoint(doc, root) {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  let rect = range.getClientRects()[0] || null;
  if (!rect) {
    const leaf = leafAfter(root, range.startContainer, range.startOffset);
    if (leaf?.element) {
      rect = leaf.element.getClientRects()[0] || null;
    } else if (leaf && leaf.node.data[leaf.offset] === LINE_FEED) {
      const probe = doc.createRange();
      probe.setStart(leaf.node, leaf.offset);
      probe.setEnd(leaf.node, leaf.offset + 1);
      rect = probe.getClientRects()[0] || null;
    }
  }
  if (!rect) return { unknown: true };
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * The map between the local coordinates of a transformed element and client pixels, from three zero-size
 * markers that stand at local (0, 0), (MARKER_SPAN, 0) and (0, MARKER_SPAN):
 *   { toLocal(x, y) -> [lx, ly], toClient(lx, ly) -> [x, y], scale, angle, upright }
 * `scale` = client pixels per local pixel along the element's x axis, `angle` = the direction of that axis
 * on screen (radians, clockwise), `upright` = no rotation or skew.
 * null when the element is not laid out (display: none) or the transform is degenerate.
 */
export function localMap(origin, alongX, alongY) {
  const o = origin.getBoundingClientRect();
  const x = alongX.getBoundingClientRect();
  const y = alongY.getBoundingClientRect();
  const ax = (x.left - o.left) / MARKER_SPAN;
  const ay = (x.top - o.top) / MARKER_SPAN;
  const bx = (y.left - o.left) / MARKER_SPAN;
  const by = (y.top - o.top) / MARKER_SPAN;
  const det = ax * by - ay * bx;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    toLocal: (clientX, clientY) => {
      const dx = clientX - o.left;
      const dy = clientY - o.top;
      return [(dx * by - dy * bx) / det, (dy * ax - dx * ay) / det];
    },
    toClient: (localX, localY) => [o.left + localX * ax + localY * bx, o.top + localX * ay + localY * by],
    scale: Math.hypot(ax, ay),
    angle: Math.atan2(ay, ax),
    upright: Math.abs(ay) < 1e-6 && Math.abs(bx) < 1e-6 && ax > 0 && by > 0
  };
}
