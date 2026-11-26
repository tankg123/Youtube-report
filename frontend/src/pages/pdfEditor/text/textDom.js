// DOM helpers shared by the layout service and the picture maker (browser only): the hidden host in which
// text is laid out at the layout scale, and the reading of glyph boxes from it.
//
// Everything is read through Range client rects of an element that is NOT transformed, so the numbers are
// layout pixels as they are. Three facts about them, measured in Chrome and Edge 157 (Windows):
//   * the box of a glyph is built from the ascent and descent of the element's PRIMARY font, whichever font
//     draws the glyph (a bundled fallback face or a system font)
//   * its top does not depend on the line height, so top + (ascent offset of the primary face) = baseline
//   * a zero-size probe inside a line stretches the line when the line height is far below the font size:
//     the ascent offset is therefore measured in a separate element with a normal line height
import { graphemes } from "./fontSupport.js";
import { TEXT_BOX_ATTRIBUTES, TEXT_BOX_STYLE, boxDomText } from "./textStyle.js";

const LINE_FEED = String.fromCharCode(0x0a);
const ROOT_STYLE = "position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;overflow:visible;visibility:hidden;pointer-events:none;contain:layout style;z-index:-1";

/** A hidden, inert element at the top-left corner of the viewport that measuring boxes are put into. */
export function createMeasuringRoot(doc) {
  const root = doc.createElement("div");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("data-pdfx-text-host", "");
  root.style.cssText = ROOT_STYLE;
  (doc.body || doc.documentElement).appendChild(root);
  return root;
}

/** Sets the pinned attributes (language, direction) and an inline style object on a text element. */
export function applyTextBox(element, style) {
  for (const [name, value] of Object.entries(TEXT_BOX_ATTRIBUTES)) element.setAttribute(name, value);
  Object.assign(element.style, style);
  return element;
}

/**
 * A measuring box inside `root`: { element, node, setStyle(style), setText(text), remove() }. The box holds
 * ONE text node with exactly the characters the committed box and the editor hold (textStyle.boxDomText).
 */
export function createMeasuringBox(doc, root) {
  const element = doc.createElement("div");
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = "0";
  const node = doc.createTextNode("");
  element.appendChild(node);
  root.appendChild(element);
  return {
    element,
    node,
    setStyle(style) {
      applyTextBox(element, style);
    },
    setText(text) {
      node.data = boxDomText(text);
    },
    remove() {
      element.remove();
    }
  };
}

/**
 * The boxes of the grapheme clusters of a measuring box: [{ text, index, left, right, top, bottom }] in
 * layout pixels from the element's top-left corner (line feeds and clusters without a box are left out),
 * plus the size of the element.
 */
export function readBox(doc, box, text) {
  const origin = box.element.getBoundingClientRect();
  const range = doc.createRange();
  const out = [];
  for (const { segment, index } of graphemes(text)) {
    if (segment === LINE_FEED) continue;
    range.setStart(box.node, index);
    range.setEnd(box.node, index + segment.length);
    const rects = range.getClientRects();
    // no box: a space swallowed at a soft wrap, or a character the browser does not draw
    if (rects.length === 0) continue;
    const rect = rects[rects.length - 1];
    out.push({ text: segment, index, left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, bottom: rect.bottom - origin.top });
  }
  range.detach?.();
  return { width: origin.width, height: origin.height, graphemes: out };
}

const PROBE_STYLE = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";

/**
 * Metrics of one face at one size, as this browser uses them: { ascent, textHeight } in layout pixels, where
 * `ascent` is the distance from the top of a text box to its baseline and `textHeight` the height of that
 * box. No assumption about which font table the browser reads or how it rounds: the baseline comes from a
 * zero-size inline-block probe. `face` = { fontFamily, fontWeight, fontStyle } with ONE family name.
 */
export function measureFace(doc, root, face, fontSizePx) {
  const host = doc.createElement("div");
  applyTextBox(host, {
    ...TEXT_BOX_STYLE,
    position: "absolute",
    left: "0",
    top: "0",
    whiteSpace: "pre",
    lineHeight: "normal",
    fontFamily: `"${face.fontFamily}"`,
    fontWeight: String(face.fontWeight),
    fontStyle: face.fontStyle,
    fontSize: `${fontSizePx}px`
  });
  const probe = doc.createElement("span");
  probe.style.cssText = PROBE_STYLE;
  const text = doc.createTextNode("Hx");
  host.append(probe, text);
  root.appendChild(host);
  const range = doc.createRange();
  range.selectNodeContents(text);
  const rect = range.getBoundingClientRect();
  const baseline = probe.getBoundingClientRect().bottom;
  host.remove();
  return { ascent: baseline - rect.top, textHeight: rect.height };
}

/** Device pixels per CSS pixel of the window a document lives in. */
export const pixelRatioOf = (doc) => doc.defaultView?.devicePixelRatio || 1;
