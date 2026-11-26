// Outline (bookmarks): read the source outline into plain data BEFORE the source is scrubbed, map it
// onto the pages that survive, write a fresh outline into the output document. A bookmark whose own page was
// removed but that has kept children is reported (and can be dropped, see mapOutline): its title stays in
// the file otherwise.
import { pdfLib } from "../lib.js";
import { N, dictOf, arrayOf, numberOf, textOf, textString } from "./pdfUtil.js";
import { createDestResolver, makeDestArray } from "./dests.js";

const { PDFNumber, PDFString } = pdfLib;

/**
 * @typedef {object} OutlineItem
 * @property {string} title
 * @property {{ kind: "goto", pageIndex: number, fit: any[] } | { kind: "uri", uri: string } | { kind: "named", name: string } | null} target
 * @property {number[] | null} color   [r, g, b] 0..1
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} open
 * @property {OutlineItem[]} children
 */

/**
 * Reads the outline of a document. Tolerates cycles in /Next, missing /Last and /Count, items without
 * a title, and a tree that is deeper or longer than any sane document (hard limits).
 *
 * @param {object} srcDoc  PDFDocument, pristine (not scrubbed)
 * @param {{ resolver?: object, maxItems?: number, maxDepth?: number }} [options]
 * @returns {{ items: OutlineItem[], count: number, truncated: boolean }}
 */
export function readOutline(srcDoc, { resolver = createDestResolver(srcDoc), maxItems = 20000, maxDepth = 64 } = {}) {
  const { context, catalog } = srcDoc;
  const root = dictOf(context, catalog.get(N("Outlines")));
  const state = { count: 0, truncated: false };
  if (!root) return { items: [], count: 0, truncated: false };
  const seen = new Set();

  const readLevel = (firstValue, depth) => {
    const out = [];
    let value = firstValue;
    while (value) {
      const dict = dictOf(context, value);
      if (!dict || seen.has(dict)) break; // end of chain, or a cycle
      if (state.count >= maxItems || depth > maxDepth) {
        state.truncated = true;
        break;
      }
      seen.add(dict);
      state.count += 1;
      const target = resolver.targetOf(dict);
      let mapped = null;
      if (target && target.kind === "goto" && target.dest) mapped = { kind: "goto", pageIndex: target.dest.pageIndex, fit: target.dest.fit };
      else if (target && target.kind === "uri") mapped = { kind: "uri", uri: target.uri };
      else if (target && target.kind === "named") mapped = { kind: "named", name: target.name };
      const colorArray = arrayOf(context, dict.get(N("C")));
      const color = colorArray && colorArray.size() === 3 ? colorArray.asArray().map((component) => numberOf(context, component) ?? 0) : null;
      const flags = numberOf(context, dict.get(N("F"))) ?? 0;
      const count = numberOf(context, dict.get(N("Count")));
      const item = {
        title: textOf(context, dict.get(N("Title"))) ?? "",
        target: mapped,
        color: color && color.some((component) => component !== 0) ? color : null,
        italic: (flags & 1) !== 0,
        bold: (flags & 2) !== 0,
        // /Count > 0: open. Negative, zero or missing (pdfkit writes none for a sub-item with children): closed.
        open: count !== undefined && count > 0,
        children: []
      };
      if (dict.get(N("First"))) item.children = readLevel(dict.get(N("First")), depth + 1);
      out.push(item);
      value = dict.get(N("Next"));
    }
    return out;
  };

  const items = readLevel(root.get(N("First")), 0);
  return { items, count: state.count, truncated: state.truncated };
}

/**
 * Keeps what still has somewhere to go.
 *  - an item whose page is gone and that has no surviving descendant is dropped;
 *  - an item whose OWN page is gone but with surviving descendants is an orphan. By default it stays as a
 *    heading and (retarget: true) takes the destination of its first surviving descendant; it is counted in
 *    `retargeted`, because its title is text about a page that is no longer there. With dropOrphans it is
 *    dropped and its children take its place, one level up;
 *  - an item that never had a destination (a plain heading) stays while it has descendants and is no orphan;
 *  - URI / named-action items always stay.
 *
 * @param {OutlineItem[]} items
 * @param {(sourcePageIndex: number) => any | undefined} outputPageRefOf  source page index -> PDFRef of the
 *        output page (the first copy when the page was placed several times), undefined when it was dropped
 * @param {{ retarget?: boolean, dropOrphans?: boolean }} [options]
 * @returns {{ items: object[], kept: number, dropped: number, retargeted: number }}
 */
export function mapOutline(items, outputPageRefOf, { retarget = true, dropOrphans = false } = {}) {
  const stats = { kept: 0, dropped: 0, retargeted: 0 };
  const firstDest = (node) => {
    if (node.dest) return node.dest;
    for (const child of node.children) {
      const dest = firstDest(child);
      if (dest) return dest;
    }
    return null;
  };
  const walk = (list) => {
    const out = [];
    for (const item of list) {
      const children = walk(item.children);
      let dest = null;
      let action = null;
      if (item.target && item.target.kind === "goto") {
        const pageRef = outputPageRefOf(item.target.pageIndex);
        if (pageRef) dest = { pageRef, fit: item.target.fit };
      } else if (item.target) {
        action = item.target;
      }
      const alive = dest || action || children.length > 0;
      if (!alive) {
        stats.dropped += 1;
        continue;
      }
      // its own page was removed; it is only alive through what is below it
      const orphan = !dest && !action && Boolean(item.target) && item.target.kind === "goto";
      if (orphan && dropOrphans) {
        stats.dropped += 1;
        out.push(...children);
        continue;
      }
      const node = { title: item.title, dest, action, color: item.color, bold: item.bold, italic: item.italic, open: item.open, children };
      if (!dest && !action && retarget) node.dest = firstDest(node);
      if (orphan) stats.retargeted += 1;
      stats.kept += 1;
      out.push(node);
    }
    return out;
  };
  return { items: walk(items), ...stats };
}

/** Escapes a JS string of 8-bit characters for use as the content of a PDF literal string. */
export function escapeLiteral(value) {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === "\\" || char === "(" || char === ")") out += `\\${char}`;
    else if (code < 32 || code > 126) {
      // URIs are 7-bit ASCII by definition; anything else is percent-encoded UTF-8
      for (const byte of new TextEncoder().encode(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    } else out += char;
  }
  return out;
}

/**
 * Writes an outline into the output document (replacing any existing one).
 * Titles are written as UTF-16BE text strings, destinations as explicit arrays on the output page refs.
 * @param {object} outDoc  PDFDocument
 * @param {object[]} items  result of mapOutline() (several sources: concatenate their item lists)
 * @returns {{ written: number }}
 */
export function writeOutline(outDoc, items) {
  const { context, catalog } = outDoc;
  if (!items.length) {
    catalog.delete(N("Outlines"));
    return { written: 0 };
  }
  let written = 0;
  const rootDict = context.obj({ Type: "Outlines" });
  const rootRef = context.register(rootDict);

  // recursion depth = nesting depth, which readOutline() bounds
  const build = (list, parentRef) => {
    const nodes = list.map((item) => {
      const dict = context.obj({});
      dict.set(N("Title"), textString(item.title));
      dict.set(N("Parent"), parentRef);
      if (item.dest) dict.set(N("Dest"), makeDestArray(context, item.dest.pageRef, item.dest.fit));
      else if (item.action && item.action.kind === "uri") {
        const action = context.obj({ S: "URI" });
        action.set(N("URI"), PDFString.of(escapeLiteral(item.action.uri)));
        dict.set(N("A"), action);
      } else if (item.action && item.action.kind === "named") {
        dict.set(N("A"), context.obj({ S: "Named", N: item.action.name }));
      }
      if (item.color) dict.set(N("C"), context.obj(item.color));
      const flags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
      if (flags) dict.set(N("F"), PDFNumber.of(flags));
      written += 1;
      return { item, dict, ref: context.register(dict) };
    });
    let visible = 0;
    nodes.forEach((node, index) => {
      if (index > 0) node.dict.set(N("Prev"), nodes[index - 1].ref);
      if (index < nodes.length - 1) node.dict.set(N("Next"), nodes[index + 1].ref);
      visible += 1;
      if (node.item.children.length) {
        const sub = build(node.item.children, node.ref);
        node.dict.set(N("First"), sub.first);
        node.dict.set(N("Last"), sub.last);
        node.dict.set(N("Count"), PDFNumber.of(node.item.open ? sub.visible : -sub.visible));
        if (node.item.open) visible += sub.visible;
      }
    });
    return { first: nodes[0].ref, last: nodes[nodes.length - 1].ref, visible };
  };

  const top = build(items, rootRef);
  rootDict.set(N("First"), top.first);
  rootDict.set(N("Last"), top.last);
  rootDict.set(N("Count"), PDFNumber.of(top.visible));
  catalog.set(N("Outlines"), rootRef);
  return { written };
}

/**
 * Convenience: map + write for one source.
 * @param {OutlineItem[]} sourceItems  readOutline(srcDoc).items, taken before copyPagesSafe()
 * @param {Map<number, any>} firstCopyOf  result.firstCopyOf of copyPagesSafe(): source index -> output PDFPage
 */
export function rebuildOutline(outDoc, sourceItems, firstCopyOf, options) {
  const mapped = mapOutline(sourceItems, (index) => {
    const page = firstCopyOf.get(index);
    return page ? page.ref : undefined;
  }, options);
  const { written } = writeOutline(outDoc, mapped.items);
  return { written, kept: mapped.kept, dropped: mapped.dropped, retargeted: mapped.retargeted, items: mapped.items };
}
