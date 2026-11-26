// An iterative replacement for the library's PDFObjectCopier.
//
// Same result (it was checked against the library's copier on a corpus), but:
//   - no recursion: PDFObjectCopier follows one JS call chain per nested object and dies with
//     "Maximum call stack size exceeded" at about 2 900 nested indirect objects (a long /IRT comment thread);
//   - the reference map is a public part of the interface (copyPagesSafe() has to seed it; with the
//     library's copier that means writing into its private field `traversedObjects`);
//   - a policy hook decides, per reference, whether the target may be copied at all;
//   - the bytes of a parsed stream are shared with the source instead of copied. The source document of an
//     export is loaded for that export only and thrown away, and nobody writes into `contents` in place, so
//     this saves one copy of the file in memory;
//   - an object the parser could not read (PDFInvalidObject: raw bytes) is copied with the references in it
//     followed and rewritten. They are text with the SOURCE's object numbers: copied as they are, "31 0 R"
//     would point at whatever has number 31 in the output, and the object it meant would not be copied at
//     all (a page whose resource dictionary is written with odd syntax lost every font and picture).
import { pdfLib } from "../lib.js";
import { rewriteRawObject } from "./rawObjects.js";

const { PDFDict, PDFArray, PDFStream, PDFRawStream, PDFRef, PDFNull, PDFName, PDFPageLeaf, PDFPageTree, PDFCatalog, PDFInvalidObject } = pdfLib;

/** Never reachable through a reference: a page can only arrive as an explicit root, the catalog never. */
const defaultAllowRef = (ref, target) => !(target instanceof PDFPageLeaf) && !(target instanceof PDFPageTree) && !(target instanceof PDFCatalog);

/**
 * @param {any} src   source PDFContext
 * @param {any} dest  destination PDFContext
 * @param {{ allowRef?: (ref: any, target: any) => boolean, shareStreamBytes?: boolean }} [options]
 *        allowRef returning false makes the reference resolve to null in the copy.
 * @returns {{ traversedObjects: Map<any, any>, copy: (object: any) => any, refused: number }}
 */
export function createGraphCopier(src, dest, options = {}) {
  const traversedObjects = new Map();
  const allowRef = options.allowRef || defaultAllowRef;
  const shareStreamBytes = options.shareStreamBytes !== false;
  const state = { refused: 0 };

  const isContainer = (object) => object instanceof PDFDict || object instanceof PDFArray || object instanceof PDFStream;
  // dictionaries / arrays: same values in a new container; streams: a new dictionary around the same bytes
  const shallow = (object) => {
    if (shareStreamBytes && object instanceof PDFRawStream && object.constructor === PDFRawStream) {
      return PDFRawStream.of(object.dict.clone(dest), object.contents);
    }
    return object.clone(dest);
  };
  const plain = (value) => (value && value.clone ? value.clone() : value);

  /** Rewrites the entries of freshly cloned containers until nothing is left to do. */
  function run(pending) {
    const mapValue = (value) => {
      if (value instanceof PDFRef) {
        let mapped = traversedObjects.get(value);
        if (mapped === undefined) {
          const target = src.lookup(value);
          if (target === undefined || target === PDFNull) {
            // a reference to nothing (an object the scrub blanked, or one the file never had) IS null: written as
            // a direct null, not as a new object that holds null
            traversedObjects.set(value, PDFNull);
            return PDFNull;
          }
          if (!allowRef(value, target)) {
            state.refused += 1;
            traversedObjects.set(value, PDFNull);
            return PDFNull;
          }
          mapped = dest.nextRef();
          traversedObjects.set(value, mapped);
          if (isContainer(target)) {
            const clone = shallow(target);
            dest.assign(mapped, clone);
            pending.push(clone);
          } else if (target instanceof PDFInvalidObject) {
            // (its place in the map is taken already: the object may refer to itself)
            dest.assign(mapped, PDFInvalidObject.of(rewriteRawObject(target.data, (number, generation) => {
              const copied = mapValue(PDFRef.of(number, generation));
              return copied instanceof PDFRef ? `${copied.objectNumber} ${copied.generationNumber} R` : "null";
            })));
          } else {
            dest.assign(mapped, plain(target));
          }
        }
        return mapped;
      }
      if (isContainer(value)) {
        let clone = traversedObjects.get(value);
        if (clone === undefined) {
          clone = shallow(value);
          traversedObjects.set(value, clone);
          pending.push(clone);
        }
        return clone;
      }
      return plain(value);
    };
    while (pending.length) {
      const current = pending.pop();
      if (current instanceof PDFArray) {
        for (let index = 0, size = current.size(); index < size; index += 1) current.set(index, mapValue(current.get(index)));
      } else {
        const dict = current instanceof PDFStream ? current.dict : current;
        for (const [key, value] of dict.entries()) {
          const mapped = mapValue(value);
          // an entry whose value is null is the same as no entry (ISO 32000-1 7.3.7): what pointed at a
          // refused or blanked object simply goes
          if (mapped === PDFNull && value !== PDFNull) dict.delete(key);
          else dict.set(key, mapped);
        }
      }
    }
  }

  /**
   * Copies `object` (a reference, a dictionary, an array, a stream or a simple value) and everything it
   * refers to. A PDFPageLeaf given as the root is copied as the page itself (without /Parent).
   */
  function copy(object) {
    if (object instanceof PDFRef) {
      const holder = dest.obj([object]);
      run([holder]);
      return holder.get(0);
    }
    if (!isContainer(object)) return plain(object);
    const clone = shallow(object);
    if (object instanceof PDFPageLeaf) {
      // what the page inherits from the page tree becomes its own, and the link to the tree is cut
      // (otherwise the whole tree, i.e. every page, would follow)
      for (const key of PDFPageLeaf.InheritableEntries) {
        const name = PDFName.of(key);
        if (!clone.get(name)) {
          const inherited = object.getInheritableAttribute(name);
          if (inherited) clone.set(name, inherited);
        }
      }
      clone.delete(PDFName.of("Parent"));
    } else {
      traversedObjects.set(object, clone);
    }
    run([clone]);
    return clone;
  }

  return {
    traversedObjects,
    copy,
    get refused() {
      return state.refused;
    }
  };
}
