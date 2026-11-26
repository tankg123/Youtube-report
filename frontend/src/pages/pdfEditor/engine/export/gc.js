// collectGarbage(pdfDoc): mark-and-sweep over the indirect objects of a document.
//
// Why: the library writes EVERY object registered in the context, reachable or not. Removing a page,
// replacing a content stream, dropping an annotation ... leave the old objects in the saved file, where any
// text extractor that scans objects (or `strings`) still finds them. pdf.js does not show them, which is why
// the leak goes unnoticed.
//
// What the sweep has to know about the library (each point has a test):
//   - fonts, images and embedded pages become objects only in flush(): flush first;
//   - the writer replaces an indirect /Length by a direct number while serialising, which would orphan the
//     number objects AFTER the sweep: drop the indirect lengths first;
//   - the parser keeps the /ObjStm and /XRef streams of the source in the context: unreachable by design;
//   - a PDFInvalidObject (bytes the parser could not read) is scanned textually for "N G R": everything that
//     looks like a reference keeps its target alive. (With `exact`, reachableRefs() follows only what a reader
//     would take for a reference, rawObjects.js: that is what "the document uses" means in robust.js.)
//   - the trailer /Size comes from context.largestObjectNumber: lowered only when nothing is created
//     afterwards (`final`), because a PDFFont / PDFImage whose object was swept still owns its old ref;
//   - the context caches the refs of the shared "q" / "Q" wrapper streams: forgotten when they were swept.
import { pdfLib } from "../lib.js";
import { latin1 } from "./pdfUtil.js";
import { scanRawObject } from "./rawObjects.js";

const { PDFDict, PDFArray, PDFStream, PDFRef, PDFName, PDFInvalidObject } = pdfLib;

/**
 * Calls visit(ref) for every PDFRef directly contained in `object` (not following the references).
 * Handles dictionaries, arrays, every stream class (their dictionary) and PDFInvalidObject.
 * @param {boolean} [exact]  for an object the parser could not read: only what a reader would take for a
 *        reference (rawObjects.js: outside strings, comments and stream data), which is also what the copier
 *        follows. The default is wider: everything that LOOKS like a reference, so that a sweep never removes
 *        too much.
 */
export function forEachDirectRef(object, visit, exact = false) {
  const stack = [object];
  while (stack.length) {
    const current = stack.pop();
    if (current instanceof PDFRef) {
      visit(current);
    } else if (current instanceof PDFDict) {
      const values = current.values();
      for (let index = 0; index < values.length; index += 1) stack.push(values[index]);
    } else if (current instanceof PDFArray) {
      for (let index = 0, size = current.size(); index < size; index += 1) stack.push(current.get(index));
    } else if (current instanceof PDFStream) {
      stack.push(current.dict);
    } else if (current instanceof PDFInvalidObject) {
      // Opaque bytes of an object the parser gave up on. Be conservative: whatever looks like a
      // reference in there keeps its target alive (also inside a string or behind a comment, where the
      // copier, which rewrites the references of such an object, does not see one).
      if (!exact) {
        const pattern = /(\d+)\s+(\d+)\s+R/g;
        const text = latin1(current.data);
        for (let match = pattern.exec(text); match; match = pattern.exec(text)) visit(PDFRef.of(Number(match[1]), Number(match[2])));
      }
      for (const ref of scanRawObject(current.data).refs) visit(PDFRef.of(ref.number, ref.generation));
    }
  }
}

/**
 * The set of PDFRef reachable from the given roots (objects or refs). Iterative: no recursion limit.
 * @param {{ exact?: boolean }} [options]  see forEachDirectRef()
 */
export function reachableRefs(context, roots, { exact = false } = {}) {
  const marked = new Set();
  const queue = [];
  const visit = (ref) => {
    if (!marked.has(ref)) {
      marked.add(ref);
      queue.push(ref);
    }
  };
  for (const root of roots) {
    if (root) forEachDirectRef(root, visit, exact);
  }
  while (queue.length) {
    const target = context.lookup(queue.pop());
    if (target) forEachDirectRef(target, visit, exact);
  }
  return marked;
}

/**
 * Removes every indirect /Length (see the header).
 * @returns {number} how many stream dictionaries were touched
 */
export function inlineStreamLengths(context) {
  const key = PDFName.of("Length");
  let touched = 0;
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream && object.dict.get(key) instanceof PDFRef) {
      object.dict.delete(key); // the writer sets the real value
      touched += 1;
    }
  }
  return touched;
}

/** The roots of a document: everything the writer puts into the trailer. */
export function trailerRoots(context) {
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  return [Root, Info, Encrypt, ID].filter(Boolean);
}

/**
 * Deletes every indirect object that cannot be reached from the trailer (Root, Info, Encrypt, ID).
 *
 * CONTRACT: it is the LAST step before save().
 *   flush: true  (default) flushes the document first. Pass false when the caller has just flushed.
 *   final: true  (default) also lowers context.largestObjectNumber so that the trailer /Size is exact. After
 *                that the document must only be saved.
 *   final: false keeps the numbering high-water mark (a swept font re-embeds itself when used again; a swept,
 *                never-drawn PDFImage does NOT). The editor never draws after a sweep: with the fork a subset
 *                font is written once, at the first flush.
 *
 * @param {object} pdfDoc  PDFDocument
 * @param {{ flush?: boolean, final?: boolean, extraRoots?: any[], dryRun?: boolean }} [options]
 * @returns {Promise<{ before: number, after: number, removed: number, removedRefs: string[] }>}
 */
export async function collectGarbage(pdfDoc, { flush = true, final = true, extraRoots = [], dryRun = false } = {}) {
  if (flush) await pdfDoc.flush();
  const { context } = pdfDoc;
  if (!dryRun) inlineStreamLengths(context);
  const marked = reachableRefs(context, [...trailerRoots(context), ...extraRoots]);
  const all = context.enumerateIndirectObjects();
  const removedRefs = [];
  let largest = 0;
  for (let index = 0; index < all.length; index += 1) {
    const ref = all[index][0];
    if (!marked.has(ref)) {
      removedRefs.push(ref.toString());
      if (!dryRun) context.delete(ref);
    } else if (ref.objectNumber > largest) {
      largest = ref.objectNumber;
    }
  }
  if (!dryRun) {
    for (const key of ["pushGraphicsStateContentStreamRef", "popGraphicsStateContentStreamRef"]) {
      if (context[key] && !marked.has(context[key])) context[key] = undefined;
    }
    // Keep the trailer /Size exact (the writers use largestObjectNumber + 1; qpdf warns when it is too large).
    if (final && largest > 0) context.largestObjectNumber = largest;
  }
  return { before: all.length, after: all.length - removedRefs.length, removed: removedRefs.length, removedRefs };
}

/**
 * True for the cross-reference streams and object streams of the file a document was PARSED from: the
 * library keeps them in the context, never references them, and writes every XRef stream except the last one
 * back into the output as a dead object. They are parser artefacts, not document content.
 */
export function isParserArtefact(object) {
  if (!(object instanceof PDFStream)) return false;
  const type = object.dict.get(PDFName.of("Type"));
  return type === PDFName.of("ObjStm") || type === PDFName.of("XRef");
}

/**
 * Objects that nothing reachable from the trailer points at: [[ref, object], ...].
 * @param {{ extraRoots?: any[], includeParserArtefacts?: boolean }} [options]
 */
export function findOrphans(pdfDoc, { extraRoots = [], includeParserArtefacts = false } = {}) {
  const { context } = pdfDoc;
  const marked = reachableRefs(context, [...trailerRoots(context), ...extraRoots]);
  return context.enumerateIndirectObjects().filter(([ref, object]) => !marked.has(ref) && (includeParserArtefacts || !isParserArtefact(object)));
}

/**
 * Optional last step: renumber the objects 1..N without gaps, so that the cross-reference section is a
 * single subsection starting at 0 as ISO 32000-1 7.5.4 asks of a file that was never updated.
 * After this call the PDFPage / PDFFont / PDFImage wrappers of the document hold stale refs: only save().
 * (The export does not use it: qpdf, pdf.js and the library accept gaps.)
 *
 * @returns {{ renumbered: number, size: number }}
 */
export function compactObjectNumbers(pdfDoc) {
  const { context } = pdfDoc;
  const entries = context.enumerateIndirectObjects();
  const map = new Map();
  let next = 1;
  let renumbered = 0;
  for (const [ref] of entries) {
    const target = PDFRef.of(next, 0);
    next += 1;
    map.set(ref, target);
    if (target !== ref) renumbered += 1;
  }
  if (!renumbered) return { renumbered: 0, size: next };
  const remap = (value) => (value instanceof PDFRef && map.has(value) ? map.get(value) : value);
  const seen = new Set();
  const rewrite = (root) => {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      if (current instanceof PDFDict) {
        seen.add(current);
        for (const [key, value] of current.entries()) {
          if (value instanceof PDFRef) current.set(key, remap(value));
          else stack.push(value);
        }
      } else if (current instanceof PDFArray) {
        seen.add(current);
        for (let index = 0, size = current.size(); index < size; index += 1) {
          const value = current.get(index);
          if (value instanceof PDFRef) current.set(index, remap(value));
          else stack.push(value);
        }
      } else if (current instanceof PDFStream) {
        seen.add(current);
        stack.push(current.dict);
      }
    }
  };
  // 1. rewrite the references inside every object, 2. move the objects to their new numbers.
  for (const [, object] of entries) rewrite(object);
  for (const [ref] of entries) context.delete(ref);
  context.largestObjectNumber = 0;
  for (const [ref, object] of entries) context.assign(map.get(ref), object);
  const info = context.trailerInfo;
  for (const key of ["Root", "Info", "Encrypt", "ID"]) {
    if (info[key] instanceof PDFRef) info[key] = remap(info[key]);
    else if (info[key]) rewrite(info[key]);
  }
  return { renumbered, size: next };
}
