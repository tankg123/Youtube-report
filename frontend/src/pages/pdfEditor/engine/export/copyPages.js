// copyPagesSafe(): copy a SUBSET of the pages of a source document into the output document without
// dragging along anything that belongs to the pages that were left out.
//
// PDFDocument.copyPages() of the library follows every reference it meets. Measured: a link /Dest [page ...],
// a GoTo action, a form field whose /Kids live on another page, an article bead, a PDF 2.0 structure
// destination each pull whole foreign pages (content, images, form values) into the output; an annotation's
// /P re-imports its own page as a ghost copy; and a link between two kept pages ends on a ghost instead of
// the real output page. A viewer shows none of it; the bytes are in the file.
//
// The fix has four parts:
//   1. scrub the THROW-AWAY source (it is mutated; load it again for anything else),
//   2. copy all kept pages with ONE copier whose page map is seeded up front,
//   3. give every output page its own /Contents array, /Resources dictionary and annotation objects,
//   4. auditOutput(): a structural self-check of the result that is independent of the scrub rules.
//
// What the scrub guarantees about forms and actions (each point was a leak or a failed export once):
//   - a field of the form survives only when a widget of it is on a kept page; every other field node is
//     BLANKED in the source (not merely unlinked), with or without /AcroForm in the catalog, so that no route
//     (an action, a /Parent, a key nobody knows) can carry its name and value over;
//   - every action of every kept annotation and field (/A, /PA, each /AA entry, the /Next chains) is cleaned:
//     ResetForm / SubmitForm /Fields and Hide /T keep only fields and annotations that are still there (also
//     when they are given as NAMES), an action that loses all its targets goes, GoTo becomes an explicit
//     destination on a kept page or goes, Thread / GoToE / Launch / ImportData go;
//   - an annotation that is taken off a kept page (a link whose target is gone, a signed signature field, a
//     widget when forms are not kept, a pop-up without its note) is blanked too: a reply, an action or a
//     pop-up entry that named it then points at nothing instead of keeping it alive outside every /Annots.
//
// Private fields of the library touched here: PDFPage.of (wraps a copied page object).
import { pdfLib } from "../lib.js";
import { N, resolve, dictOf, arrayOf, nameOf, isString, decodeTextBytes, textOf } from "./pdfUtil.js";
import { isSignedSignature } from "./acroform.js";
import { createDestResolver, makeDestArray } from "./dests.js";
import { resolveUri } from "./docSettings.js";
import { escapeLiteral } from "./outline.js";
import { createGraphCopier } from "./graphCopier.js";
import { createResourcePruner } from "./pruneResources.js";

const { PDFPage, PDFPageLeaf, PDFPageTree, PDFCatalog, PDFDict, PDFArray, PDFRef, PDFName, PDFNull, PDFStream, PDFString, PDFInvalidObject } = pdfLib;

/** Page-level entries that are dropped from every kept page. */
export const DROPPED_PAGE_KEYS = Object.freeze([
  "Thumb", // stale after any edit
  "PieceInfo", // private application data (Illustrator / InDesign project data ...)
  "LastModified", // only meaningful with /PieceInfo
  "Metadata", // page-level XMP
  "AA", // page open / close scripts
  "B", // article beads: every bead links to the beads (and pages) of its thread
  "StructParents", // index into the structure tree, which is not carried over
  "Tabs", // /S (structure order) is meaningless without the structure tree
  "TemplateInstantiated",
  "PresSteps",
  "DPart", // PDF 2.0 document parts hierarchy (points back into the catalog)
  "AF", // associated files of the page
  "SeparationInfo" // lists the other pages of a colour separation
]);

/** Entries of the page tree that a leaf may inherit (same list as PDFPageLeaf.InheritableEntries). */
const INHERITABLE = ["Resources", "MediaBox", "CropBox", "Rotate"];

/** Resource categories whose dictionaries a page must own before anything is added to / changed in them. */
const RESOURCE_CATEGORIES = ["Font", "XObject", "ExtGState", "ColorSpace", "Pattern", "Shading", "Properties"];

/** Action types that are removed from link annotations (the annotation goes with them). */
export const DEFAULT_DROPPED_ACTIONS = new Set(["Thread", "JavaScript", "Launch", "ImportData", "GoToE", "Rendition", "Movie", "Sound", "Hide"]);

/**
 * Action types that are removed wherever they stand (on a widget, in /AA, in a /Next chain): a thread leads
 * to its beads and through them to every page of the article, the others to files and embedded documents.
 */
const ACTIONS_REMOVED_EVERYWHERE = new Set(["Thread", "GoToE", "Launch", "ImportData"]);

const STRUCT_TYPES = new Set(["StructTreeRoot", "StructElem", "OBJR", "MCR"]);
function isStructureObject(object) {
  if (object instanceof PDFArray) return true; // an indirect /K array
  if (!(object instanceof PDFDict) || object instanceof PDFPageLeaf || object instanceof PDFPageTree) return false;
  const type = object.get(N("Type"));
  if (type instanceof PDFName && STRUCT_TYPES.has(type.decodeText())) return true;
  if (type instanceof PDFName) return false; // /Annot, /XObject, /Font ...: not ours
  return object.has(N("S")) && object.has(N("P")) && !object.has(N("Rect")); // a struct element without /Type
}

function isWidget(context, dict) {
  return nameOf(context, dict.get(N("Subtype"))) === "Widget";
}

/** A dictionary that may be blanked as a field node: never a page, a tree node, the catalog or a stream. */
function isFieldNode(context, object, catalog) {
  if (!(object instanceof PDFDict) || object instanceof PDFPageLeaf || object instanceof PDFPageTree || object instanceof PDFCatalog || object === catalog) return false;
  return object.has(N("T")) || object.has(N("FT")) || object.has(N("Kids")) || isWidget(context, object);
}

/**
 * Step 1: mutate the source so that nothing reachable from a kept page leads to a page that is not kept.
 *
 * @param {object} srcDoc  PDFDocument, loaded for this export only
 * @param {number[]} keepIndices
 * @param {{ keepForms?: boolean, dropSignedSignatures?: boolean, droppedActions?: Set<string>, droppedPageKeys?: string[],
 *           resolver?: object, pruneResources?: boolean, resolveUriBase?: string }} [options]
 *        pruneResources (default true): see pruneResources.js; it only acts when pages are left out.
 *        resolveUriBase: the /URI base of this source, given when the output will NOT carry it (sources with
 *        different bases are combined): relative link addresses are then written out in full
 * @returns {{ report: object, survivingFieldRoots: any[], keptWidgetRefs: Set<any> }}
 */
export function scrubSourceForCopy(srcDoc, keepIndices, options = {}) {
  const {
    keepForms = true,
    dropSignedSignatures = true,
    droppedActions = DEFAULT_DROPPED_ACTIONS,
    droppedPageKeys = DROPPED_PAGE_KEYS,
    resolver = createDestResolver(srcDoc),
    pruneResources = true,
    resolveUriBase
  } = options;
  const { context, catalog } = srcDoc;
  const pages = srcDoc.getPages();
  const kept = new Set(keepIndices);
  const report = {
    linksRetargeted: 0, linksDropped: 0, actionsDropped: 0, actionTargetsDropped: 0, widgetsKept: 0, widgetsDropped: 0,
    signaturesDropped: 0, popupsDropped: 0, pageKeysDropped: {}, foreignAnnotsBlanked: 0, annotsBlanked: 0, pagesBlanked: 0,
    treeNodesBlanked: 0, structElemsBlanked: 0, fieldsPruned: 0, fieldsBlanked: 0, inheritedMaterialised: 0,
    resources: { pages: 0, forms: 0, removed: 0, unresolved: [] }
  };

  // -- 1a. kept pages: make inherited attributes their own, drop the baggage ----------------------
  for (const index of kept) {
    const node = pages[index].node;
    for (const key of INHERITABLE) {
      const name = N(key);
      if (!node.get(name)) {
        const value = node.getInheritableAttribute(name);
        if (value) {
          node.set(name, value);
          report.inheritedMaterialised += 1;
        }
      }
    }
    for (const key of droppedPageKeys) {
      if (node.has(N(key))) {
        node.delete(N(key));
        report.pageKeysDropped[key] = (report.pageKeysDropped[key] || 0) + 1;
      }
    }
  }

  // -- 1b. kept pages: which annotations stay -------------------------------------------------------
  const keptAnnotRefs = new Set();
  const keptWidgetRefs = new Set();
  /** Annotation objects that were taken off a kept page: blanked in 1f unless another kept page still lists them. */
  const droppedAnnotRefs = new Set();
  /** page index -> the annotation entries that stay, in their order */
  const lists = new Map();
  for (const index of kept) {
    const page = pages[index];
    const node = page.node;
    const annots = arrayOf(context, node.get(N("Annots")));
    if (!annots) {
      node.delete(N("Annots"));
      continue;
    }
    const survivors = [];
    for (const entry of annots.asArray()) {
      const dict = dictOf(context, entry);
      if (!dict) continue; // null / garbage entry
      const subtype = nameOf(context, dict.get(N("Subtype")));
      let stays = true;

      if (subtype === "Link") {
        const target = resolver.targetOf(dict);
        if (target && target.kind === "goto") {
          if (!target.dest || !kept.has(target.dest.pageIndex)) {
            report.linksDropped += 1;
            stays = false; // the target page is gone (or unresolvable): the link is useless
          } else {
            // an explicit destination on the SOURCE page ref; the seeded copier maps it to the output page
            const explicit = makeDestArray(context, target.dest.pageRef, target.dest.fit);
            if (target.via === "Dest") {
              dict.set(N("Dest"), explicit);
              dict.delete(N("A")); // not allowed next to /Dest, and it could name any page
            } else {
              const action = context.obj({ S: "GoTo" });
              action.set(N("D"), explicit); // a fresh action: no /SD (structure destination), no /Next chain
              dict.set(N("A"), action);
            }
            report.linksRetargeted += 1;
          }
        } else if (target && target.kind === "other" && droppedActions.has(target.type)) {
          report.actionsDropped += 1;
          stays = false;
        } else if (target && target.via === "A") {
          const action = dictOf(context, dict.get(N("A")));
          if (action) action.delete(N("Next")); // action chains could continue with anything
        }
      } else if (subtype === "Widget" || dict.has(N("FT"))) {
        if (!keepForms) {
          report.widgetsDropped += 1;
          stays = false;
        } else if (dropSignedSignatures && isSignedSignature(context, dict)) {
          report.signaturesDropped += 1;
          stays = false;
        } else {
          if (entry instanceof PDFRef) keptWidgetRefs.add(entry);
          report.widgetsKept += 1;
        }
      }
      if (!stays) {
        if (entry instanceof PDFRef) droppedAnnotRefs.add(entry);
        continue;
      }

      // references that leave the page or point into the structure tree
      dict.delete(N("StructParent"));
      if (dict.has(N("P"))) dict.set(N("P"), page.ref);
      survivors.push(entry);
      if (entry instanceof PDFRef) keptAnnotRefs.add(entry);
    }
    lists.set(index, survivors);
  }

  // -- 1c. the field tree: keep only branches that end in a widget of a kept page -----------------
  // Also without /AcroForm in the catalog: the widgets of such a file hang on their /Parent chains all the same.
  const survivingFieldRoots = [];
  const aliveFieldRoots = [];
  const aliveFieldRefs = new Set();
  const deadFieldRefs = new Set();
  const acroForm = dictOf(context, catalog.get(N("AcroForm")));
  {
    const visiting = new Set();
    const survives = (entry, depth = 0) => {
      const dict = dictOf(context, entry);
      if (!dict || visiting.has(dict) || depth > 64) return false;
      visiting.add(dict);
      const kids = arrayOf(context, dict.get(N("Kids")));
      let alive;
      if (kids) {
        const keptKids = kids.asArray().filter((kid) => survives(kid, depth + 1));
        report.fieldsPruned += kids.size() - keptKids.length;
        dict.set(N("Kids"), context.obj(keptKids));
        // a merged field/widget that ALSO has kids is not legal; a widget of a kept page keeps the node alive anyway
        alive = keptKids.length > 0 || (entry instanceof PDFRef && keptWidgetRefs.has(entry));
      } else {
        alive = entry instanceof PDFRef && keptWidgetRefs.has(entry);
      }
      visiting.delete(dict);
      if (entry instanceof PDFRef) (alive ? aliveFieldRefs : deadFieldRefs).add(entry);
      return alive;
    };
    const fields = acroForm ? arrayOf(context, acroForm.get(N("Fields"))) : undefined;
    const seenRoots = new Set();
    for (const entry of fields ? fields.asArray() : []) {
      if (survives(entry)) {
        survivingFieldRoots.push(entry);
        aliveFieldRoots.push(entry);
        seenRoots.add(entry);
      } else report.fieldsPruned += 1;
    }
    // widgets that are not reachable from /Fields (orphans): their /Parent chain decides
    for (const widgetRef of keptWidgetRefs) {
      let top = widgetRef;
      for (let step = 0; step < 32; step += 1) {
        const parent = dictOf(context, top)?.get(N("Parent"));
        if (!(parent instanceof PDFRef) || !dictOf(context, parent)) break;
        top = parent;
      }
      if (!seenRoots.has(top) && survives(top)) {
        // without /AcroForm the branches are pruned all the same, but no form is invented for the output
        if (acroForm) survivingFieldRoots.push(top);
        aliveFieldRoots.push(top);
        seenRoots.add(top);
      }
    }
    // field nodes above the widgets of pages that are NOT kept, also when no /Fields entry leads to them
    pages.forEach((page, index) => {
      if (kept.has(index)) return;
      const annots = arrayOf(context, page.node.get(N("Annots")));
      for (const entry of annots ? annots.asArray() : []) {
        let current = dictOf(context, entry);
        for (let step = 0; step < 32 && current; step += 1) {
          const parent = current.get(N("Parent"));
          if (!(parent instanceof PDFRef)) break;
          if (!aliveFieldRefs.has(parent)) deadFieldRefs.add(parent);
          current = dictOf(context, parent);
        }
      }
    });
  }
  /** The fully qualified names of the field nodes that survive: an action may name a field instead of referring to it. */
  const aliveFieldNames = new Set();
  {
    const seen = new Set();
    const collect = (entry, prefix, depth) => {
      const dict = dictOf(context, entry);
      if (!dict || seen.has(dict) || depth > 64) return;
      seen.add(dict);
      const part = textOf(context, dict.get(N("T")));
      const name = part === undefined ? prefix : (prefix ? `${prefix}.${part}` : part);
      if (name) aliveFieldNames.add(name);
      const kids = arrayOf(context, dict.get(N("Kids")));
      for (const kid of kids ? kids.asArray() : []) collect(kid, name, depth + 1);
    };
    for (const root of aliveFieldRoots) collect(root, "", 0);
  }

  // -- 1d. actions of kept annotations and fields ----------------------------------------------------
  /** May an action keep this target (a reference to a field or an annotation, or the name of a field)? */
  const keepsTarget = (entry) => {
    const value = resolve(context, entry);
    if (isString(value)) return aliveFieldNames.has(decodeTextBytes(value.asBytes()));
    return entry instanceof PDFRef && (aliveFieldRefs.has(entry) || keptAnnotRefs.has(entry));
  };
  const cleanedActions = new Set();
  /** Cleans one action and its /Next chain in place; false = the action itself must go. */
  const cleanAction = (value, depth = 0) => {
    const action = dictOf(context, value);
    if (!action || depth > 16) return false;
    if (cleanedActions.has(action)) return true;
    cleanedActions.add(action);
    const type = nameOf(context, action.get(N("S")));
    if (ACTIONS_REMOVED_EVERYWHERE.has(type)) return false;
    if (type === "URI" && resolveUriBase) {
      const address = textOf(context, action.get(N("URI")));
      const absolute = resolveUri(address, resolveUriBase);
      if (absolute !== address) action.set(N("URI"), PDFString.of(escapeLiteral(absolute)));
    }
    if (type === "GoTo") {
      // as for links: an explicit destination on a kept page, or no action (the NAME of a destination would
      // stay in the file and lead nowhere: named destinations are not carried over)
      const target = resolver.resolveAction(action);
      if (!target || !target.dest || !kept.has(target.dest.pageIndex)) return false;
      action.set(N("D"), makeDestArray(context, target.dest.pageRef, target.dest.fit));
      action.delete(N("SD"));
    }
    const key = type === "Hide" ? "T" : type === "ResetForm" || type === "SubmitForm" ? "Fields" : null;
    if (key && action.has(N(key))) {
      const given = action.get(N(key));
      const list = arrayOf(context, given);
      const targets = list ? list.asArray() : [given];
      const keptTargets = targets.filter(keepsTarget);
      report.actionTargetsDropped += targets.length - keptTargets.length;
      // Without the targets it was written for, the action would act on everything (or on nothing): it goes.
      if (targets.length && !keptTargets.length) return false;
      if (keptTargets.length !== targets.length) action.set(N(key), list ? context.obj(keptTargets) : keptTargets[0]);
    }
    const next = action.get(N("Next"));
    if (next !== undefined) {
      const chain = arrayOf(context, next);
      if (chain) {
        const keptNext = chain.asArray().filter((item) => cleanAction(item, depth + 1));
        if (keptNext.length) action.set(N("Next"), context.obj(keptNext));
        else action.delete(N("Next"));
      } else if (!cleanAction(next, depth + 1)) action.delete(N("Next"));
    }
    return true;
  };
  /** /A, /PA and every /AA entry of an annotation or a field; true when /A had to go. */
  const cleanActionsOf = (dict) => {
    let lostAction = false;
    for (const key of ["A", "PA"]) {
      if (dict.has(N(key)) && !cleanAction(dict.get(N(key)))) {
        dict.delete(N(key));
        report.actionsDropped += 1;
        if (key === "A") lostAction = true;
      }
    }
    const additional = dictOf(context, dict.get(N("AA")));
    if (additional) {
      for (const [key, value] of additional.entries()) {
        if (!cleanAction(value)) {
          additional.delete(key);
          report.actionsDropped += 1;
        }
      }
    }
    return lostAction;
  };
  // links first: a link that loses its action goes, and no other action may keep naming it
  for (const linksOnly of [true, false]) {
    for (const [index, survivors] of lists) {
      const staying = [];
      for (const entry of survivors) {
        const dict = dictOf(context, entry);
        const isLink = nameOf(context, dict.get(N("Subtype"))) === "Link";
        if (isLink === linksOnly && cleanActionsOf(dict) && isLink && !dict.has(N("Dest"))) {
          report.linksDropped += 1;
          if (entry instanceof PDFRef) {
            keptAnnotRefs.delete(entry);
            droppedAnnotRefs.add(entry);
          }
          continue;
        }
        staying.push(entry);
      }
      lists.set(index, staying);
    }
  }
  // the field nodes above the widgets carry actions too (calculation, validation ...)
  for (const ref of aliveFieldRefs) {
    const dict = dictOf(context, ref);
    if (dict && !keptAnnotRefs.has(ref)) cleanActionsOf(dict);
  }

  // -- 1e. kept pages: pop-ups and replies, then the final /Annots ------------------------------------
  for (const [index, survivors] of lists) {
    const node = pages[index].node;
    // A pop-up stays only with its markup annotation: either its /Parent survived, or (the /Parent entry
    // is optional) a surviving annotation of this page names it in /Popup.
    const survivorRefs = new Set(survivors.filter((entry) => entry instanceof PDFRef));
    const isPopup = (entry) => nameOf(context, dictOf(context, entry).get(N("Subtype"))) === "Popup";
    const namedPopups = new Set();
    for (const entry of survivors) {
      if (isPopup(entry)) continue;
      const popup = dictOf(context, entry).get(N("Popup"));
      if (popup instanceof PDFRef) namedPopups.add(popup);
    }
    const finalList = survivors.filter((entry) => {
      if (!isPopup(entry)) return true;
      const parent = dictOf(context, entry).get(N("Parent"));
      const ok = parent instanceof PDFRef
        ? survivorRefs.has(parent) && !isPopup(parent)
        : entry instanceof PDFRef && namedPopups.has(entry);
      if (!ok) {
        report.popupsDropped += 1;
        if (entry instanceof PDFRef) {
          keptAnnotRefs.delete(entry);
          droppedAnnotRefs.add(entry);
        }
      }
      return ok;
    });
    const finalRefs = new Set(finalList.filter((entry) => entry instanceof PDFRef));
    for (const entry of finalList) {
      const dict = dictOf(context, entry);
      const popup = dict.get(N("Popup"));
      if (popup instanceof PDFRef && !finalRefs.has(popup)) dict.delete(N("Popup"));
      // a reply to an annotation that is not (or no longer) on this page
      const repliesTo = dict.get(N("IRT"));
      if (repliesTo instanceof PDFRef && !finalRefs.has(repliesTo)) {
        dict.delete(N("IRT"));
        dict.delete(N("RT"));
      }
    }
    if (finalList.length) node.set(N("Annots"), context.obj(finalList));
    else node.delete(N("Annots"));
  }

  // -- 1f. the structure tree: nothing of it may be reached (PDF 2.0 /SD, outline /SE, OBJR ...) ---
  const structRoot = catalog.get(N("StructTreeRoot"));
  if (structRoot) {
    const seen = new Set();
    const stack = [structRoot];
    while (stack.length) {
      const entry = stack.pop();
      const object = resolve(context, entry);
      if (object instanceof PDFArray) {
        for (const item of object.asArray()) stack.push(item);
      } else if (object instanceof PDFDict && !seen.has(object)) {
        seen.add(object);
        if (object.has(N("K"))) stack.push(object.get(N("K")));
      }
      // Blank only what is recognisably part of the structure tree: a broken file whose /K points at an
      // annotation or a content stream must not lose that object.
      if (entry instanceof PDFRef && isStructureObject(object)) {
        context.assign(entry, PDFNull);
        report.structElemsBlanked += 1;
      }
    }
  }

  // -- 1g. resources shared with pages that are not kept (before those pages are blanked) ----------
  const pruner = pruneResources ? createResourcePruner(srcDoc, kept) : null;
  if (pruner) report.resources = pruner.prune();

  // -- 1h. what must not be reachable by ANY route: blanked, so that a reference to it is a reference to nothing
  for (const ref of droppedAnnotRefs) {
    if (keptAnnotRefs.has(ref)) continue; // another kept page lists the same object and keeps it
    context.assign(ref, PDFNull);
    report.annotsBlanked += 1;
  }
  // pages that are not kept: their annotation objects, then the leaves themselves
  pages.forEach((page, index) => {
    if (kept.has(index)) return;
    const annots = arrayOf(context, page.node.get(N("Annots")));
    for (const entry of annots ? annots.asArray() : []) {
      if (entry instanceof PDFRef && !keptAnnotRefs.has(entry) && context.lookup(entry) !== PDFNull) {
        context.assign(entry, PDFNull);
        report.foreignAnnotsBlanked += 1;
      }
    }
    context.assign(page.ref, PDFNull);
    report.pagesBlanked += 1;
  });
  // field nodes without a widget on a kept page (the widgets themselves went as annotations just above)
  for (const ref of deadFieldRefs) {
    if (aliveFieldRefs.has(ref) || keptAnnotRefs.has(ref)) continue;
    if (!isFieldNode(context, context.lookup(ref), catalog)) continue; // already blanked, or not a field at all
    context.assign(ref, PDFNull);
    report.fieldsBlanked += 1;
  }

  // -- 1i. the page tree nodes (inherited attributes were copied to the kept leaves in 1a) ---------
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFPageTree) {
      context.assign(ref, PDFNull);
      report.treeNodesBlanked += 1;
    }
  }

  // -- 1j. the proof for 1g, on the source as the copier will see it --------------------------------
  if (pruner) report.resources.unresolved = pruner.verify();

  return { report, survivingFieldRoots, keptWidgetRefs };
}

/**
 * Gives a page its own /Contents array and its own /Resources dictionary (with its own category
 * dictionaries). Fonts, images and content streams themselves stay shared: only the containers are private.
 * Without this, two pages that share an (indirect) /Contents array or /Resources dictionary, or the two
 * copies of a duplicated page, receive each other's drawings (the library pushes into the shared object).
 *
 * A resource dictionary that the parser could not read (it travels as raw bytes, see rawObjects.js) stays on
 * the page as it is: replacing it by an empty dictionary would take every font and picture away from the
 * page. PageCanvas makes such a page writable when something is drawn on it (content.js
 * ensureWritableResources).
 */
export function detachPageContainers(page) {
  const node = page.node;
  const { context } = node;
  const contentsValue = node.get(N("Contents"));
  const contents = resolve(context, contentsValue);
  let streams = [];
  // keep every entry that resolves to an object (a stream, or a PDFInvalidObject the parser could not read):
  // dropping an unreadable content stream here would silently lose page content
  const exists = (entry) => entry instanceof PDFRef && context.lookup(entry) !== undefined && context.lookup(entry) !== PDFNull;
  if (contents instanceof PDFArray) streams = contents.asArray().filter(exists);
  else if (exists(contentsValue)) streams = [contentsValue];
  node.set(N("Contents"), context.obj(streams));

  // the dictionary the page really uses: its own, or the one it inherits from the page tree (a page of a
  // loaded document; a freshly copied page already carries what it inherited)
  const inherited = node.getInheritableAttribute(N("Resources"));
  const resources = dictOf(context, inherited);
  if (!resources && inherited instanceof PDFRef && context.lookup(inherited) instanceof PDFInvalidObject) {
    node.set(N("Resources"), inherited);
    return page;
  }
  const own = context.obj({});
  if (resources) {
    for (const [key, value] of resources.entries()) {
      const sub = resolve(context, value);
      if (sub instanceof PDFDict && RESOURCE_CATEGORIES.includes(key.decodeText())) own.set(key, sub.clone(context));
      else own.set(key, value);
    }
  }
  node.set(N("Resources"), own);
  return page;
}

/** A copy of a dictionary or array with its DIRECT containers copied too; what a reference points at stays shared. */
function cloneDirect(context, value, depth = 0) {
  if (depth > 32 || value instanceof PDFStream) return value;
  if (value instanceof PDFDict) {
    const clone = value.clone(context);
    for (const [key, entry] of clone.entries()) clone.set(key, cloneDirect(context, entry, depth + 1));
    return clone;
  }
  if (value instanceof PDFArray) {
    const clone = value.clone(context);
    for (let index = 0; index < clone.size(); index += 1) clone.set(index, cloneDirect(context, clone.get(index), depth + 1));
    return clone;
  }
  return value;
}

/** An independent twin of an output page (the same source page placed twice). */
function duplicateOutputPage(outDoc, original) {
  const { context } = outDoc;
  const twinNode = original.node.clone(context); // shallow: containers are replaced below
  const twinRef = context.nextRef();
  for (const [key, value] of twinNode.entries()) {
    // boxes and other small direct values of the page: its own copies (/Contents, /Resources, /Annots follow)
    const name = key.decodeText();
    if (name !== "Contents" && name !== "Resources" && name !== "Annots") twinNode.set(key, cloneDirect(context, value));
  }
  // annotations: private copies (appearance streams and other indirect objects stay shared); form widgets are
  // not duplicated, one widget object cannot sit on two pages and a second widget would need the field tree
  // to be rebuilt. A link of the page to itself keeps pointing at the FIRST copy.
  const annots = arrayOf(context, original.node.get(N("Annots")));
  if (annots) {
    const map = new Map();
    const clones = [];
    for (const entry of annots.asArray()) {
      const dict = dictOf(context, entry);
      if (!dict || isWidget(context, dict) || dict.has(N("FT"))) continue;
      const clone = cloneDirect(context, dict);
      const ref = context.register(clone);
      if (entry instanceof PDFRef) map.set(entry, ref);
      clones.push({ ref, clone });
    }
    for (const { clone } of clones) {
      if (clone.has(N("P"))) clone.set(N("P"), twinRef);
      for (const key of ["Popup", "Parent", "IRT"]) {
        const target = clone.get(N(key));
        if (target instanceof PDFRef) {
          if (map.has(target)) clone.set(N(key), map.get(target));
          else clone.delete(N(key));
        }
      }
    }
    if (clones.length) twinNode.set(N("Annots"), context.obj(clones.map((item) => item.ref)));
    else twinNode.delete(N("Annots"));
  }
  context.assign(twinRef, twinNode);
  return detachPageContainers(PDFPage.of(twinNode, twinRef, outDoc));
}

/**
 * Copies the pages `keepIndices` (source page indices in output order; an index may appear several times)
 * of `srcDoc` into `outDoc`. The pages are returned, NOT yet added: call outDoc.addPage(page) /
 * insertPage() in the order the output needs (pages of several sources can be interleaved).
 *
 * `srcDoc` is consumed: load a fresh PDFDocument for every export. Read outline, named destinations, form
 * facts and labels BEFORE this call.
 *
 * @param {object} srcDoc  PDFDocument
 * @param {number[]} keepIndices
 * @param {object} outDoc  PDFDocument
 * @param {object} [options]  see scrubSourceForCopy(); createCopier?: (srcContext, destContext) => copier with a
 *        public `traversedObjects` map and copy() (default: graphCopier.js)
 * @returns {Promise<{ pages: any[], copier: any, mapRef: (srcRef: any) => any, firstCopyOf: Map<number, any>,
 *                     survivingFieldRoots: any[], report: object, resolver: object }>}
 */
export async function copyPagesSafe(srcDoc, keepIndices, outDoc, options = {}) {
  const srcPages = srcDoc.getPages();
  for (const index of keepIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= srcPages.length) throw new RangeError(`copyPagesSafe: no page ${index} in the source (${srcPages.length} pages)`);
  }
  await srcDoc.flush();
  const resolver = options.resolver || createDestResolver(srcDoc); // BEFORE the scrub
  const { report, survivingFieldRoots } = scrubSourceForCopy(srcDoc, keepIndices, { ...options, resolver });

  const copier = (options.createCopier || createGraphCopier)(srcDoc.context, outDoc.context);
  const map = copier.traversedObjects;
  if (!(map instanceof Map)) throw new Error("copyPagesSafe: the copier has no reference map");

  const distinct = [...new Set(keepIndices)];
  const destRefOf = new Map();
  for (const index of distinct) {
    const destRef = outDoc.context.nextRef();
    destRefOf.set(index, destRef);
    map.set(srcPages[index].ref, destRef); // seed: every reference to this source page becomes the output page
  }
  const firstCopyOf = new Map();
  for (const index of distinct) {
    const node = srcPages[index].node;
    if (!(node instanceof PDFPageLeaf)) throw new Error(`copyPagesSafe: page ${index} is not a page object`);
    const copied = copier.copy(node);
    const destRef = destRefOf.get(index);
    outDoc.context.assign(destRef, copied);
    firstCopyOf.set(index, detachPageContainers(PDFPage.of(copied, destRef, outDoc)));
  }

  const used = new Set();
  report.duplicates = 0;
  const pages = keepIndices.map((index) => {
    if (!used.has(index)) {
      used.add(index);
      return firstCopyOf.get(index);
    }
    report.duplicates += 1;
    return duplicateOutputPage(outDoc, firstCopyOf.get(index));
  });

  const mapRef = (srcRef) => map.get(srcRef);
  return { pages, copier, mapRef, firstCopyOf, survivingFieldRoots, report, resolver };
}

/**
 * Structural self-check of an output document, cheap enough to run on every export. Returns a list of
 * problems (empty = fine; English, for logs). It catches foreign page content arriving by ANY route, known
 * or not:
 *   - a /Type /Page object that is not in the page tree (a ghost page with its content),
 *   - a /Type /Pages or /Type /Catalog object besides the document's own,
 *   - structure tree objects,
 *   - an annotation object that no page lists in /Annots (a widget of a page that was left out ...),
 *   - a page of the tree whose /Contents or /Annots entry does not resolve.
 * Run it on what will be written: after the sweep, objects nothing refers to are gone and do not count.
 */
export function auditOutput(outDoc, { allowStructTree = false } = {}) {
  const { context, catalog } = outDoc;
  const problems = [];
  const pages = outDoc.getPages();
  const pageRefs = new Set(pages.map((page) => page.ref));
  const listedAnnots = new Set();
  const treeNodes = new Set();
  const collectTree = (ref, depth) => {
    const node = context.lookup(ref);
    if (node instanceof PDFPageTree && !treeNodes.has(ref) && depth < 64) {
      treeNodes.add(ref);
      for (const kid of node.Kids().asArray()) if (kid instanceof PDFRef) collectTree(kid, depth + 1);
    }
  };
  if (catalog.get(N("Pages")) instanceof PDFRef) collectTree(catalog.get(N("Pages")), 0);

  for (const page of pages) {
    const annots = arrayOf(context, page.node.get(N("Annots")));
    for (const entry of annots ? annots.asArray() : []) {
      if (entry instanceof PDFRef) {
        listedAnnots.add(entry);
        if (!dictOf(context, entry)) problems.push(`page ${page.ref}: /Annots entry ${entry} does not resolve to a dictionary`);
      }
    }
    const contents = resolve(context, page.node.get(N("Contents")));
    if (contents instanceof PDFArray) {
      for (const entry of contents.asArray()) {
        // an object the parser could not read is written back as it is: still the page's own content
        const target = context.lookup(entry);
        if (!(resolve(context, entry) instanceof PDFStream) && !(target instanceof PDFInvalidObject)) problems.push(`page ${page.ref}: /Contents entry ${entry} is not a stream`);
      }
    }
  }

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : null;
    if (!dict) continue;
    const type = dict.get(N("Type"));
    const subtype = dict.get(N("Subtype"));
    if (object instanceof PDFPageLeaf || type === PDFName.of("Page")) {
      if (!pageRefs.has(ref)) problems.push(`${ref}: a /Type /Page object that is not in the page tree (ghost page)`);
    } else if (object instanceof PDFPageTree || type === PDFName.of("Pages")) {
      if (!treeNodes.has(ref)) problems.push(`${ref}: a /Type /Pages node outside the page tree`);
    } else if (type === PDFName.of("Catalog")) {
      if (object !== catalog) problems.push(`${ref}: a second /Type /Catalog`);
    } else if (!allowStructTree && (type === PDFName.of("StructTreeRoot") || type === PDFName.of("StructElem") || type === PDFName.of("OBJR") || type === PDFName.of("MCR"))) {
      problems.push(`${ref}: structure tree object ${type}`);
    } else if (type === PDFName.of("Annot") || subtype === PDFName.of("Widget") || subtype === PDFName.of("Link") || subtype === PDFName.of("Popup")) {
      if (!(object instanceof PDFStream) && dict.has(N("Rect")) && !listedAnnots.has(ref)) {
        problems.push(`${ref}: annotation ${subtype} that no page lists in /Annots`);
      }
    }
  }
  return problems;
}

/** Private / structure baggage that Form and Image XObjects may carry. */
export const DROPPED_XOBJECT_KEYS = Object.freeze(["PieceInfo", "LastModified", "StructParents", "StructParent", "OPI"]);

/**
 * Removes application-private data and structure-tree indices from every XObject of the OUTPUT document
 * (Illustrator / InDesign store whole project files under /PieceInfo of a form XObject).
 * @returns {number} number of entries removed
 */
export function stripXObjectBaggage(outDoc, keys = DROPPED_XOBJECT_KEYS) {
  let removed = 0;
  for (const [, object] of outDoc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    const subtype = object.dict.get(N("Subtype"));
    if (subtype !== PDFName.of("Form") && subtype !== PDFName.of("Image")) continue;
    for (const key of keys) {
      if (object.dict.has(N(key))) {
        object.dict.delete(N(key));
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * Last step before the sweep: moves the bulky DIRECT entries of every page (its /Resources dictionary, its
 * /Annots array) into indirect objects of their own.
 *
 * Why: the library never puts page objects into object streams, so everything that is written inline in a
 * page dictionary stays uncompressed (a 400-page file grew by half). Each page keeps its PRIVATE containers;
 * they are merely stored next to the page. Do it after all drawing: the first draw call on a page inlines
 * /Resources again.
 * @returns {number} number of entries moved
 */
export function externalizePageDicts(outDoc) {
  const { context } = outDoc;
  let moved = 0;
  for (const page of outDoc.getPages()) {
    for (const key of ["Resources", "Annots"]) {
      const value = page.node.get(N(key));
      if (value instanceof PDFDict || value instanceof PDFArray) {
        if (value instanceof PDFArray && value.size() === 0) {
          page.node.delete(N(key)); // the library adds an empty /Annots to every page it touches
          continue;
        }
        page.node.set(N(key), context.register(value));
        moved += 1;
      }
    }
  }
  return moved;
}
