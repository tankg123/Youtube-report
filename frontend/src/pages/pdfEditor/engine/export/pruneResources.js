// Resource dictionaries: when pages are removed, a kept page carries only what it draws.
//
// A resource dictionary keeps everything it names reachable, whether the content uses the name or not. Some
// producers write ONE dictionary for the whole document (the FPDF family: "/Resources 2 0 R" on every page,
// template, tiling pattern and annotation appearance) or hang one on the page tree, and list the images,
// forms and fonts of ALL pages in it; an editor may leave the entries of a page it replaced behind. Copying
// one page of such a file copies the pictures and the text-bearing forms of other pages with it: nothing
// shows them, every extractor finds them. Deleting a page would not delete its content.
//
// The pruner runs on the throw-away SOURCE before the copy, and only when at least one page is left out:
//
//   prune()   Every kept page, and every content stream with resources of its own that a kept page can
//             reach (form XObjects, tiling patterns, Type3 fonts, soft-mask groups, annotation appearances
//             and icons, at any depth), gets a private copy of its resource dictionary that holds only the
//             names it uses. A name is dropped only when that can be PROVEN: the content is tokenized
//             completely, together with everything that draws with the same dictionary (old-style forms,
//             patterns and glyph procedures without resources of their own). What cannot be read keeps the
//             dictionary it had. A dictionary that names exactly what is used, and that no removed page
//             shares, is left as it is.
//             "Uses" is read widely: EVERY name that stands among the operands of the content counts, for
//             every category. Which operand an operator takes is the viewer's business (pdf.js takes the last
//             ones and hands left-over operands to the next operator: "/F2 /GS1 gs 20 Tf" selects font F2);
//             a name that is nowhere in the content cannot be used by it, and that is all the proof needs.
//   verify()  The check for the case that matters most, independent of the rules above: the kept pages for
//             which it could NOT be proven that nothing of a removed page travels with them (`unresolved`:
//             the export then carries the warning EXPORT_RESOURCES_NOT_PRUNED). A kept page is one of them
//             when
//               - a walk over everything the copier will follow from it meets a category dictionary through
//                 which a page that is NOT kept reaches its resources (a "tainted" dictionary), or
//               - something that draws on it could not be read (so its dictionary was kept whole) and that
//                 dictionary names an object which a removed page names too: the dictionary may be the
//                 page's own and still list the picture of another page, or
//               - the walk meets a content stream or an annotation appearance of a removed page that no
//                 kept page shows (an annotation of the kept page may refer to it through a key of its
//                 own, for instance), or
//               - the walk meets an object the parser could not read (raw bytes: nobody knows what it
//                 keeps alive).
//
// Limits: /ColorSpace is left alone (colour definitions, and DefaultGray / DefaultRGB / DefaultCMYK are used
// without being named). Keys of a resource dictionary that are no resource category are not looked at.
import { pdfLib } from "../lib.js";
import { N, resolve, dictOf, arrayOf, nameOf, isString } from "./pdfUtil.js";
import { decodeStreamBytes, getPageContentBytes, pageContentEntries, pageContentRefs } from "./content.js";
import { tokenizeContent } from "./contentTokens.js";

const { PDFDict, PDFStream, PDFArray, PDFRef, PDFPageLeaf, PDFPageTree, PDFCatalog, PDFInvalidObject } = pdfLib;

/** Categories that are pruned. */
export const PRUNED_CATEGORIES = Object.freeze(["XObject", "Font", "Pattern", "Shading", "Properties", "ExtGState"]);

/** Categories whose entries can be (or lead to) content streams with resources of their own. */
const CARRIER_CATEGORIES = ["XObject", "Pattern", "Font", "ExtGState"];

const emptyUsage = () => Object.fromEntries(PRUNED_CATEGORIES.map((category) => [category, new Set()]));

/**
 * Resource names a content stream can refer to, by category: every name among the operands of any operator
 * counts for every category (see the header). The same set of names is therefore returned under each key.
 * @returns {Record<string, Set<string>> | null} null when the stream is not understood
 */
export function usedResourceNames(bytes) {
  const { operations, problems } = tokenizeContent(bytes);
  if (problems.length) return null;
  const used = emptyUsage();
  for (const { operands } of operations) {
    for (const operand of operands) {
      if (operand.type === "name") for (const category of PRUNED_CATEGORIES) used[category].add(operand.value);
    }
  }
  return used;
}

/**
 * The names of a category dictionary of the SOURCE: Map<decoded name, key>. Made once per dictionary (the one
 * dictionary of an FPDF-style file lists thousands of pictures, and every page is pruned against it); the
 * source dictionaries are never changed by the pruner, only replaced.
 */
function createNameIndex() {
  const indexes = new Map();
  return (entries) => {
    let index = indexes.get(entries);
    if (!index) {
      index = new Map(entries.keys().map((key) => [key.decodeText(), key]));
      indexes.set(entries, index);
    }
    return index;
  };
}

/** The pruned category dictionaries of a resource dictionary that hold at least one entry (resolved objects). */
function categoryDictionaries(context, resources, namesOf) {
  const out = [];
  if (!(resources instanceof PDFDict)) return out;
  for (const category of PRUNED_CATEGORIES) {
    const entries = dictOf(context, resources.get(N(category)));
    if (entries && namesOf(entries).size) out.push(entries);
  }
  return out;
}

const ownResources = (context, object) => dictOf(context, (object instanceof PDFStream ? object.dict : object).get(N("Resources")));
const isForm = (context, object) => object instanceof PDFStream && nameOf(context, object.dict.get(N("Subtype"))) === "Form";

/**
 * What can hold content with resources of its own, found under `category` of a resource dictionary: a form
 * XObject, a tiling pattern, a Type3 font (its glyph procedures) or the group of a soft mask in a graphics
 * state. `holder` is the dictionary that has the /Resources entry, `streams` draw with it.
 * @returns {{ key: object, holder: object, streams: object[] } | null}
 */
function carrierOf(context, category, target) {
  if (category === "XObject") return isForm(context, target) ? { key: target, holder: target.dict, streams: [target] } : null;
  if (category === "Pattern") return target instanceof PDFStream ? { key: target, holder: target.dict, streams: [target], pattern: true } : null;
  if (category === "Font") {
    if (!(target instanceof PDFDict) || nameOf(context, target.get(N("Subtype"))) !== "Type3") return null;
    const procedures = dictOf(context, target.get(N("CharProcs")));
    const streams = (procedures ? procedures.values() : []).map((value) => resolve(context, value)).filter((value) => value instanceof PDFStream);
    return { key: target, holder: target, streams };
  }
  if (category === "ExtGState") {
    const mask = target instanceof PDFDict ? dictOf(context, target.get(N("SMask"))) : undefined;
    const group = mask ? resolve(context, mask.get(N("G"))) : undefined;
    return isForm(context, group) ? { key: group, holder: group.dict, streams: [group] } : null;
  }
  return null;
}

/**
 * Visits every carrier that can be reached through a resource dictionary: ALL entries, a superset of what is
 * drawn. `each(carrier, own)` gets the carrier and its own resource dictionary (undefined when it draws with
 * its caller's) and returns the dictionary to continue in, or nothing.
 */
function walkCarriers(context, start, each, walked) {
  const stack = [start];
  while (stack.length) {
    const resources = stack.pop();
    if (!(resources instanceof PDFDict) || walked.has(resources)) continue;
    walked.add(resources);
    for (const category of CARRIER_CATEGORIES) {
      const entries = dictOf(context, resources.get(N(category)));
      for (const value of entries ? entries.values() : []) {
        const carrier = carrierOf(context, category, resolve(context, value));
        if (!carrier) continue;
        const next = each(carrier, ownResources(context, carrier.holder));
        if (next) stack.push(next);
      }
    }
  }
}

/**
 * The streams a viewer paints for the annotations of a page: appearances (/AP, all states) and icons (/MK),
 * each with the annotation it belongs to.
 * @returns {Array<{ stream: object, annotation: object, ref: object | undefined }>}  ref: the reference that led to the stream
 */
function annotationStreams(context, node) {
  const out = [];
  const annots = arrayOf(context, node.get(N("Annots")));
  for (const entry of annots ? annots.asArray() : []) {
    const annotation = resolve(context, entry);
    if (!(annotation instanceof PDFDict)) continue;
    const add = (value) => {
      const target = resolve(context, value);
      if (target instanceof PDFStream) out.push({ stream: target, annotation, ref: value instanceof PDFRef ? value : undefined });
      else if (target instanceof PDFDict) { // the states of a check box: /N << /On ... /Off ... >>
        for (const state of target.values()) {
          const stream = resolve(context, state);
          if (stream instanceof PDFStream) out.push({ stream, annotation, ref: state instanceof PDFRef ? state : undefined });
        }
      }
    };
    const appearance = resolve(context, annotation.get(N("AP")));
    if (appearance instanceof PDFDict) for (const value of appearance.values()) add(value);
    const characteristics = resolve(context, annotation.get(N("MK")));
    if (characteristics instanceof PDFDict) {
      for (const key of ["I", "RI", "IX"]) {
        const icon = resolve(context, characteristics.get(N(key)));
        if (icon instanceof PDFStream) out.push({ stream: icon, annotation, ref: characteristics.get(N(key)) instanceof PDFRef ? characteristics.get(N(key)) : undefined });
      }
    }
  }
  return out;
}

/** Font names that a default appearance string (/DA) selects: a viewer that redraws a field looks them up. */
function defaultAppearanceFonts(context, dict, into) {
  let current = dict;
  for (let step = 0; step < 32 && current instanceof PDFDict; step += 1) {
    const appearance = resolve(context, current.get(N("DA")));
    if (isString(appearance)) {
      const used = usedResourceNames(appearance.asBytes());
      if (used) for (const name of used.Font) into.add(name);
    }
    current = dictOf(context, current.get(N("Parent")));
  }
  return into;
}

/**
 * Everything drawn through `resources` starting from the given content: the names used, by category.
 * Streams that have no /Resources of their own (old-style forms, patterns, Type3 glyph procedures, soft
 * masks) draw with the same dictionary and are followed. A tiling pattern WITH resources of its own still
 * finds a whole category it lacks in the dictionary of whoever paints with it (viewers merge the two): the
 * names it uses from such a category count here as well.
 * @param {Array<Record<string, Set<string>> | null>} contents  usedResourceNames() of each content the holder draws
 * @param {(stream: object) => Record<string, Set<string>>} read  the same for a stream; throws when it is not understood
 * @returns {Record<string, Set<string>> | null} null when something could not be read
 */
function usageThrough(context, resources, contents, read) {
  const used = emptyUsage();
  const seen = new Set();
  const lookup = (category, name) => {
    const dict = dictOf(context, resources.get(N(category)));
    return dict ? resolve(context, dict.get(N(name))) : undefined;
  };
  const scan = (local, depth) => {
    if (depth > 16) throw new Error("streams nested too deeply");
    for (const category of PRUNED_CATEGORIES) for (const name of local[category]) used[category].add(name);
    for (const category of CARRIER_CATEGORIES) {
      for (const name of local[category]) {
        const carrier = carrierOf(context, category, lookup(category, name));
        if (!carrier || seen.has(carrier.key)) continue;
        seen.add(carrier.key);
        const own = ownResources(context, carrier.holder);
        if (!own) {
          for (const stream of carrier.streams) scan(read(stream), depth + 1);
        } else if (carrier.pattern) {
          const borrowed = emptyUsage();
          const inside = read(carrier.streams[0]);
          for (const missing of PRUNED_CATEGORIES) if (!own.has(N(missing))) borrowed[missing] = inside[missing];
          scan(borrowed, depth + 1);
        }
      }
    }
  };
  try {
    for (const local of contents) {
      if (!local) return null;
      scan(local, 0);
    }
  } catch {
    return null;
  }
  return used;
}

/** A copy of `resources` whose pruned categories hold only the used names (in the order of their first use). */
function prunedCopy(context, resources, used, counter, namesOf) {
  const copy = resources.clone(context);
  for (const category of PRUNED_CATEGORIES) {
    const entries = dictOf(context, resources.get(N(category)));
    if (!entries) continue;
    const names = namesOf(entries);
    const kept = context.obj({});
    let count = 0;
    for (const name of used[category]) {
      const key = names.get(name);
      if (!key) continue; // named in the content, missing in the dictionary: nothing to keep
      kept.set(key, entries.get(key));
      count += 1;
    }
    counter.removed += names.size - count;
    copy.set(N(category), kept);
  }
  return copy;
}

/** Does `resources` name something in a pruned category that `used` does not contain? */
function hasUnused(context, resources, used, namesOf) {
  for (const category of PRUNED_CATEGORIES) {
    const entries = dictOf(context, resources.get(N(category)));
    if (!entries) continue;
    for (const name of namesOf(entries).keys()) if (!used[category].has(name)) return true;
  }
  return false;
}

/** Every reference inside a value, through its DIRECT dictionaries and arrays (what a reference points at is not opened). */
function directRefs(value, into, depth = 0) {
  if (value instanceof PDFRef) into.add(value);
  else if (depth > 8) return into;
  else if (value instanceof PDFDict) for (const entry of value.values()) directRefs(entry, into, depth + 1);
  else if (value instanceof PDFArray) for (const entry of value.asArray()) directRefs(entry, into, depth + 1);
  return into;
}

/**
 * Can one of `targets` be reached from `root` the way the copier walks: through every dictionary, array and
 * stream dictionary, but never into another page, the page tree or the catalog? With `unparsed`, an object
 * the parser could not read counts as a target too. `clean` collects the objects of finished walks that reach
 * none (they are not walked again for the next page).
 */
function reachesAny(context, root, targets, clean, unparsed = false) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    let object = stack.pop();
    if (object instanceof PDFRef) object = context.lookup(object);
    if (unparsed && object instanceof PDFInvalidObject) return true;
    if (object instanceof PDFStream) object = object.dict;
    const isDict = object instanceof PDFDict;
    if (!(isDict || object instanceof PDFArray) || seen.has(object) || clean.has(object)) continue;
    if (object !== root && (object instanceof PDFPageLeaf || object instanceof PDFPageTree || object instanceof PDFCatalog)) continue;
    if (isDict && targets.has(object)) return true;
    seen.add(object);
    if (isDict) {
      for (const [key, value] of object.entries()) if (!(object === root && key === N("Parent"))) stack.push(value);
    } else {
      for (const value of object.asArray()) stack.push(value);
    }
  }
  for (const object of seen) clean.add(object);
  return false;
}

/**
 * @param {object} srcDoc  PDFDocument: the throw-away source, BEFORE its pages are blanked
 * @param {Iterable<number>} keptIndices  page indices that are copied
 * @returns {{ prune: () => { pages: number, forms: number, removed: number, unresolved: number[] }, verify: () => number[] }}
 *          prune() gives the kept pages and what they draw their private dictionaries; verify() returns the
 *          kept page indices for which it is not proven that nothing of a removed page travels with them
 *          (see the header). Call verify() when the source is in the state the copier will see.
 */
export function createResourcePruner(srcDoc, keptIndices) {
  const { context } = srcDoc;
  const pages = srcDoc.getPages();
  const kept = new Set(keptIndices);
  const tainted = new Set();
  // What removed pages name (the objects, not the dictionaries), and the holders whose usage could not be
  // PROVEN. An unproven holder keeps every entry of its dictionary: when one of them is an object that a
  // removed page names too, content of that page may stay in the file although the dictionary is private.
  const removedTargets = new Set();
  const unproven = [];
  let currentPage = null;
  // The dictionaries of the streams that ARE the removed pages: their content streams and the appearances of
  // their annotations, unless a kept page shows the same stream. Nothing a kept page keeps may lead to one.
  const removedOwn = new Set();
  const namesOf = createNameIndex();
  // usedResourceNames() of a stream, read once however many pages draw it (null = not understood)
  const parsed = new Map();
  const read = (stream) => {
    let local = parsed.get(stream);
    if (local === undefined) {
      try {
        local = usedResourceNames(decodeStreamBytes(context, stream));
      } catch {
        local = null;
      }
      parsed.set(stream, local);
    }
    if (!local) throw new Error("a content stream is not understood");
    return local;
  };
  const pageResources = (page) => dictOf(context, page.node.getInheritableAttribute(N("Resources")));
  const hasTainted = (resources) => categoryDictionaries(context, resources, namesOf).some((entries) => tainted.has(entries));

  function prune() {
    const result = { pages: 0, forms: 0, removed: 0, unresolved: [] };
    if (kept.size >= pages.length) return result; // nothing is removed: nothing is touched

    // every category dictionary through which a page that is NOT kept reaches its resources, at any depth
    const taintWalked = new Set();
    const mark = (entries) => {
      tainted.add(entries);
      for (const value of entries.values()) directRefs(value, removedTargets);
    };
    const taint = (resources) => {
      if (!resources) return;
      for (const entries of categoryDictionaries(context, resources, namesOf)) mark(entries);
      walkCarriers(context, resources, (carrier, own) => {
        for (const entries of categoryDictionaries(context, own, namesOf)) mark(entries);
        return own;
      }, taintWalked);
    };
    pages.forEach((page, index) => {
      if (kept.has(index)) return;
      taint(pageResources(page));
      for (const entry of pageContentEntries(page)) {
        removedTargets.add(entry);
        const stream = context.lookup(entry);
        if (stream instanceof PDFStream) removedOwn.add(stream.dict);
      }
      for (const { stream, ref } of annotationStreams(context, page.node)) {
        if (ref) removedTargets.add(ref);
        removedOwn.add(stream.dict);
        taint(ownResources(context, stream));
      }
    });
    for (const index of kept) {
      if (!pages[index]) continue;
      for (const entry of pageContentEntries(pages[index])) {
        const stream = context.lookup(entry);
        if (stream instanceof PDFStream) removedOwn.delete(stream.dict);
      }
      for (const { stream } of annotationStreams(context, pages[index].node)) removedOwn.delete(stream.dict);
    }

    // Fonts that a default appearance (/DA) of the form or of an annotation of a kept page selects: they stay
    // in the resources of EVERY annotation appearance that names them (appearance streams are shared between
    // fields, and a viewer that redraws a field looks its font up there).
    const formFonts = defaultAppearanceFonts(context, dictOf(context, srcDoc.catalog.get(N("AcroForm"))), new Set());
    for (const index of kept) {
      if (pages[index]) for (const { annotation } of annotationStreams(context, pages[index].node)) defaultAppearanceFonts(context, annotation, formFonts);
    }

    /**
     * Gives `holder` a private dictionary with only the used names; returns the dictionary it has afterwards.
     * Without proof (`used` is null) it keeps what it had; a dictionary that is exact and shared with no
     * removed page is not copied.
     */
    const minimise = (holder, resources, used, counter) => {
      if (!used || (!hasUnused(context, resources, used, namesOf) && !hasTainted(resources))) return resources;
      const pruned = prunedCopy(context, resources, used, result, namesOf);
      holder.set(N("Resources"), pruned);
      result[counter] += 1;
      return pruned;
    };
    const done = new Set();
    const walked = new Set();
    /** A carrier with resources of its own; returns where to look further. */
    const visit = (carrier, own, extraFonts) => {
      if (!own || done.has(carrier.key)) return undefined; // without its own it draws with its caller's
      done.add(carrier.key);
      if (!categoryDictionaries(context, own, namesOf).length) return own; // nothing that could be removed
      let used;
      try {
        used = usageThrough(context, own, carrier.streams.map(read), read);
      } catch {
        used = null;
      }
      if (used && extraFonts) for (const name of extraFonts) used.Font.add(name);
      if (!used && currentPage !== null) unproven.push({ index: currentPage, resources: own });
      return minimise(carrier.holder, own, used, "forms");
    };
    /** The names a page uses through its resources; null when that cannot be proven. */
    const pageUsage = (page, resources, streams) => {
      try {
        // an unreadable content entry (kept as raw bytes) may use any name
        if (pageContentEntries(page).length !== pageContentRefs(page).length) return null;
        const inheriting = streams.filter(({ stream }) => !ownResources(context, stream));
        return usageThrough(context, resources, [usedResourceNames(getPageContentBytes(page)), ...inheriting.map(({ stream }) => read(stream))], read);
      } catch {
        return null;
      }
    };

    for (const index of kept) {
      const page = pages[index];
      if (!page) continue;
      const streams = annotationStreams(context, page.node);
      let resources = pageResources(page);
      currentPage = index;
      if (resources) {
        // a dictionary without any entry that could be removed needs no proof
        if (categoryDictionaries(context, resources, namesOf).length) {
          const usage = pageUsage(page, resources, streams);
          if (!usage) unproven.push({ index, resources });
          resources = minimise(page.node, resources, usage, "pages");
        }
        walkCarriers(context, resources, visit, walked);
      }
      for (const { stream } of streams) {
        const next = visit({ key: stream, holder: stream.dict, streams: [stream] }, ownResources(context, stream), formFonts);
        if (next) walkCarriers(context, next, visit, walked);
      }
    }
    return result;
  }

  function verify() {
    const unresolved = new Set();
    if (kept.size >= pages.length) return []; // nothing is removed: nothing can stay behind
    // a holder without proof whose dictionary (it may be its own) names an object of a removed page
    for (const { index, resources } of unproven) {
      if (unresolved.has(index)) continue;
      const named = new Set();
      for (const entries of categoryDictionaries(context, resources, namesOf)) for (const value of entries.values()) directRefs(value, named);
      for (const ref of named) {
        if (removedTargets.has(ref)) {
          unresolved.add(index);
          break;
        }
      }
    }
    const unparsed = context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFInvalidObject);
    if (tainted.size || removedOwn.size || unparsed) {
      const targets = removedOwn.size ? new Set([...tainted, ...removedOwn]) : tainted;
      const clean = new Set();
      for (const index of kept) {
        const page = pages[index];
        if (page && !unresolved.has(index) && reachesAny(context, page.node, targets, clean, unparsed)) unresolved.add(index);
      }
    }
    return [...unresolved].sort((a, b) => a - b);
  }

  return { prune, verify };
}

/**
 * prune() and verify() in one call (see createResourcePruner).
 * @returns {{ pages: number, forms: number, removed: number, unresolved: number[] }}
 *          pages = kept pages that got a private dictionary; forms = content streams with resources of their own
 *          (forms, patterns, Type3 fonts, soft-mask groups, appearances) that did; removed = entries dropped;
 *          unresolved = kept page indices that may still carry something of a page that is not kept
 */
export function pruneSharedResources(srcDoc, keptIndices) {
  const pruner = createResourcePruner(srcDoc, keptIndices);
  const result = pruner.prune();
  result.unresolved = pruner.verify();
  return result;
}
