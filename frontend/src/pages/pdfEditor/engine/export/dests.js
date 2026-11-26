// Destinations: explicit arrays, named destinations (catalog /Dests dictionary and /Names /Dests name
// tree) and actions, resolved against the PRISTINE source document into plain data.
import { pdfLib } from "../lib.js";
import { N, resolve, dictOf, nameOf, readNameTree, bytesKey, isString, textOf } from "./pdfUtil.js";

const { PDFRef, PDFName, PDFNumber, PDFNull, PDFArray } = pdfLib;

/**
 * @typedef {{ pageIndex: number, pageRef: any, fit: Array<{ name: string } | number | null> }} ResolvedDest
 *   fit = what follows the page in the destination array: [{ name: "XYZ" }, left, top, zoom] ...
 */

/**
 * Must be created BEFORE the source is scrubbed (it captures page refs and the two name tables).
 * @param {object} srcDoc  PDFDocument
 */
export function createDestResolver(srcDoc) {
  const { context, catalog } = srcDoc;
  const pages = srcDoc.getPages();
  const pageIndexOfRef = new Map(pages.map((page, index) => [page.ref, index]));
  const destsDict = dictOf(context, catalog.get(N("Dests")));
  const namesDict = dictOf(context, catalog.get(N("Names")));
  const nameTree = namesDict && namesDict.get(N("Dests")) ? readNameTree(context, namesDict.get(N("Dests"))) : new Map();

  /** @returns {ResolvedDest | null} */
  function fromArray(array) {
    if (!(array instanceof PDFArray) || array.size() === 0) return null;
    const first = array.get(0);
    let pageIndex;
    let pageRef;
    if (first instanceof PDFRef) {
      pageRef = first;
      pageIndex = pageIndexOfRef.get(first);
    } else if (first instanceof PDFNumber) {
      // not legal for a local destination, but written by some producers: a 0-based page number
      pageIndex = first.asNumber();
      pageRef = pages[pageIndex] ? pages[pageIndex].ref : undefined;
    }
    if (pageIndex === undefined || pageRef === undefined || !pages[pageIndex]) return null;
    const fit = [];
    for (let index = 1; index < array.size(); index += 1) {
      const item = resolve(context, array.get(index));
      if (item instanceof PDFName) fit.push({ name: item.decodeText() });
      else if (item instanceof PDFNumber) fit.push(item.asNumber());
      else fit.push(null);
    }
    if (!fit.length) fit.push({ name: "Fit" });
    return { pageIndex, pageRef, fit };
  }

  /** @returns {ResolvedDest | null} */
  function resolveDest(dest, depth = 0) {
    if (depth > 8) return null;
    const value = resolve(context, dest);
    if (!value || value === PDFNull) return null;
    if (value instanceof PDFArray) return fromArray(value);
    if (value instanceof PDFName) {
      return destsDict ? resolveDest(destsDict.get(value), depth + 1) : null;
    }
    if (isString(value)) {
      const hit = nameTree.get(bytesKey(value));
      return hit ? resolveDest(hit, depth + 1) : null;
    }
    const dict = dictOf(context, value);
    if (dict) return resolveDest(dict.get(N("D")), depth + 1); // << /D [...] >> wrapper of a named destination
    return null;
  }

  /**
   * @returns {{ kind: "goto", dest: ResolvedDest | null } | { kind: "uri", uri: string }
   *          | { kind: "named", name: string } | { kind: "other", type: string } | null}
   */
  function resolveAction(action) {
    const dict = dictOf(context, action);
    if (!dict) return null;
    const type = nameOf(context, dict.get(N("S")));
    if (type === "GoTo") return { kind: "goto", dest: resolveDest(dict.get(N("D"))) };
    if (type === "URI") {
      const uri = textOf(context, dict.get(N("URI")));
      return { kind: "uri", uri: uri ?? "" };
    }
    if (type === "Named") return { kind: "named", name: nameOf(context, dict.get(N("N"))) ?? "" };
    return { kind: "other", type: type ?? "?" };
  }

  /** Target of something that has /Dest or /A (a link annotation, an outline item). */
  function targetOf(dict) {
    if (dict.has(N("Dest"))) return { kind: "goto", dest: resolveDest(dict.get(N("Dest"))), via: "Dest" };
    if (dict.has(N("A"))) {
      const target = resolveAction(dict.get(N("A")));
      return target ? { ...target, via: "A" } : null;
    }
    return null;
  }

  return { pageIndexOfRef, resolveDest, resolveAction, targetOf, namedCount: nameTree.size + (destsDict ? destsDict.keys().length : 0) };
}

/** Builds a destination array object [pageRef /XYZ left top zoom] in `context` from resolved data. */
export function makeDestArray(context, pageRef, fit) {
  const array = context.obj([]);
  array.push(pageRef);
  for (const item of fit) {
    if (item === null || item === undefined) array.push(PDFNull);
    else if (typeof item === "number") array.push(PDFNumber.of(item));
    else array.push(PDFName.of(item.name));
  }
  return array;
}
