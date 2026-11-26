// Everything AROUND the page content that can still carry what a mark removed, and the garbage collection
// that makes a save() of the PDF library safe.
//
//   removeAnnotations(pdfDoc, pageIndex, { rects, all })        annotations, form widgets and field values
//   stripPageExtras(pdfDoc, pageIndex, { raster })              /Thumb /PieceInfo /Metadata ...
//   stripStructAttributes(pdfDoc, pageIndex, mcids, { structParents, stm, removedStrings })
//                                                               the words of the elements that own touched content
//   detachPageFromStructTree(pdfDoc, pageIndex, { removedStrings })   a rasterised page leaves the structure tree
//   releaseOrphanedObjects(pdfDoc, candidates, { replacements }) objects only the structure tree still holds
//   listTextCarriers(pdfDoc, pageIndex)                         what is left on a page besides content (tests)
//   stripStructureWords(pdfDoc, removedStrings)                 words anywhere in the tree that repeat removed text
//   findTextElsewhere(pdfDoc, removedStrings)                   bookmarks, properties, attachments ... that repeat it
//   countEmbeddedFiles(pdfDoc)                                  attached files (the engine cannot look into most)
//   decodeTextBytes(bytes)                                      the text of a stream in UTF-8 or UTF-16
//   collectGarbage(pdfDoc, { final })                           deletes objects the trailer cannot reach
//
// All functions work on a PDFDocument of the library and mutate it in place.
//
// ANNOTATIONS AND FORM FIELDS under a strict mark go as a whole. What "under" means and what goes with them:
//   - the rectangle of the annotation (and its /QuadPoints) touches the mark. A rectangle without area is hit
//     like a point (a note icon written as a point), a missing /Rect counts as the origin, as viewers place it;
//   - a note goes with its popup and its replies, and a popup that is hit takes its note along (the text of
//     the note is what the popup shows);
//   - a field loses its value when its last widget goes; a field that keeps widgets elsewhere is emptied
//     everywhere (reported as fieldsCleared). The value may hang on an ANCESTOR of the widget (a widget that
//     is a field of its own, with /T, under a parent that carries /V): it is deleted where it hangs.
//
// TAGGED PDF (a document with a /StructTreeRoot). The structure tree refers to page content by marked-content
// ids, to Form XObjects by /Stm and to annotations by /OBJR, and its elements can repeat text in words
// (/ActualText, /Alt, /E, /T). The rule of the engine: the tree never keeps a reference to something that was
// removed, and never keeps words for content that lost a glyph.
//   precise path   the marked-content sequences stay where they are (with fewer glyphs), so their ids stay
//                  valid. stripStructAttributes() drops the words of the elements that own a touched id:
//                  /ActualText, /Alt, /E, /T and every string of their attribute objects (/A). The owners are
//                  found through the parent tree AND by walking the tree for kids that name the id (a parent
//                  tree may be missing, lead elsewhere, or not be reachable from the page). Their ancestors
//                  lose /ActualText, /Alt, /E, and a title or attribute string that repeats the removed text,
//                  however short. removeAnnotations() takes the /OBJR of a removed annotation out of its
//                  element; releaseOrphanedObjects() overwrites a Form XObject that only the tree still
//                  points to (/Stm) with the redacted copy the page draws now.
//   raster path    nothing of the page content survives, so detachPageFromStructTree() removes every kid of a
//                  structure element that refers to the page (marked-content ids, /MCR, /OBJR), drops the
//                  page's entry of the parent tree and strips the words of the elements that lost kids.
//   both           stripStructureWords() then deletes every word left anywhere in the tree that repeats the
//                  removed text (the title of the chapter whose heading was redacted, for example); a word
//                  that IS the removed text goes even when it is shorter than the six characters the search
//                  for copies otherwise needs.
//
// COPIES ELSEWHERE (findTextElsewhere). Reported, never deleted: bookmark titles, document properties and XMP
// packets (decoded by their byte-order mark; UTF-16 without one is recognised by its zero bytes), names and
// values of form fields, texts of annotations that stay, scripts, and attached files: their names always,
// their content when it is text. An attachment that is compressed or binary cannot be searched, so the
// caller is also told HOW MANY files are attached (countEmbeddedFiles -> REDACT_ATTACHMENTS_NOT_CHECKED).
import { pdfLib } from "../lib.js";
import { A, normRect, rectsIntersect } from "./pdfAccess.js";

const { PDFBool, PDFDict, PDFArray, PDFStream, PDFRef, PDFInvalidObject } = pdfLib;

/** Entries of a structure element that spell its content out in words. */
const ELEMENT_TEXT_KEYS = ["ActualText", "Alt", "E"];
/** ... and the title of the element itself (not of its ancestors: a document title says nothing of one line). */
const ELEMENT_OWN_KEYS = [...ELEMENT_TEXT_KEYS, "T"];

function acroForm(pdfDoc) {
  return A.get(pdfDoc.catalog, "AcroForm");
}

function removeRefFromArray(arr, target) {
  if (!A.isArray(arr)) return false;
  let removed = false;
  for (let i = arr.size() - 1; i >= 0; i--) {
    if (A.sameRef(arr.get(i), target)) {
      arr.remove(i);
      removed = true;
    }
  }
  return removed;
}

function fieldName(dict, context) {
  const parts = [];
  let node = dict;
  for (let guard = 0; node && guard < 32; guard++) {
    const t = A.get(node, "T");
    if (A.isString(t)) parts.unshift(t.decodeText());
    node = A.resolve(context, A.getRaw(node, "Parent"));
    if (!A.isDict(node)) break;
  }
  return parts.join(".");
}

/** An inheritable field entry (/FT, /Ff ...): the nearest value on the way up the field tree. */
function inheritedEntry(dict, key, context) {
  let node = dict;
  for (let guard = 0; A.isDict(node) && guard < 32; guard++) {
    const value = A.get(node, key);
    if (value !== undefined) return value;
    node = A.resolve(context, A.getRaw(node, "Parent"));
  }
  return undefined;
}

const VALUE_KEYS = ["V", "DV", "RV"];
const hasValue = (dict) => VALUE_KEYS.some((key) => dict.has(A.N(key)));

/** The field dictionary, from `dict` upwards, that holds the value `dict` shows (its own, or an inherited one). */
function valueHolder(dict, context) {
  let node = dict;
  for (let guard = 0; A.isDict(node) && guard < 32; guard++) {
    if (hasValue(node)) return node;
    node = A.resolve(context, A.getRaw(node, "Parent"));
  }
  return null;
}

/**
 * Empties a field that keeps widgets elsewhere after one of its widgets was redacted: the value (/V, /DV, /RV,
 * also where it is inherited from) is deleted and the widgets that showed it stop showing it (a button is
 * switched off, every other widget loses its appearance stream, which is a picture of the value). The widgets
 * are looked for in the whole subtree of the field: a value can be inherited through several levels of /Kids
 * (a child field that has a value of its own keeps it, and its widgets).
 * Returns the number of widgets that were emptied.
 */
function clearFieldValue(pdfDoc, field) {
  const context = pdfDoc.context;
  let node = field;
  for (let guard = 0; A.isDict(node) && guard < 32; guard++) {
    for (const key of VALUE_KEYS) node.delete(A.N(key));
    node = A.resolve(context, A.getRaw(node, "Parent"));
  }
  let widgets = 0;
  const seen = new Set();
  const stack = [field];
  while (stack.length) {
    const current = stack.pop();
    if (!A.isDict(current) || seen.has(current) || seen.size > 4096) continue;
    seen.add(current);
    const kids = A.get(current, "Kids");
    if (A.isArray(kids) && kids.size() > 0) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = kids.lookup(i);
        if (!A.isDict(kid)) continue;
        // a child FIELD (it has a name) with a value of its own shows that value, not the one that was cleared
        if (hasValue(kid) && kid.has(A.N("T"))) continue;
        for (const key of VALUE_KEYS) kid.delete(A.N(key));
        stack.push(kid);
      }
      continue;
    }
    if (current === field) continue; // the field has no kids: it is its own widget and keeps nothing to show
    widgets++;
    if (A.nameOf(inheritedEntry(current, "FT", context)) === "Btn") {
      if (current.has(A.N("AS")) || current.has(A.N("AP"))) current.set(A.N("AS"), A.N("Off"));
    } else {
      current.delete(A.N("AP"));
      current.delete(A.N("AS"));
    }
  }
  // viewers build the (now empty) appearances themselves
  const form = acroForm(pdfDoc);
  if (A.isDict(form)) form.set(A.N("NeedAppearances"), PDFBool.True);
  return widgets;
}

/**
 * Detaches a widget from the form: removes it from its parent's /Kids (or from /Fields when the widget is the
 * field itself) and removes ancestors that are left without kids.
 * Returns { field, fieldRemoved, remainingWidgets, fieldDict, inheritedFrom }
 *   fieldDict       the field that keeps other widgets
 *   inheritedFrom   a field + widget that showed a value it does not hold itself: the ancestor that holds it
 *                   (it survives the widget when it has other kids, and its value with it)
 */
function detachWidget(pdfDoc, widgetRaw, widget) {
  const context = pdfDoc.context;
  const form = acroForm(pdfDoc);
  const name = fieldName(widget, context);
  // a widget dictionary with /T is the field itself (merged field + widget): its value goes with it.
  // a pure widget is one of the /Kids of the field that holds the value.
  const merged = A.getRaw(widget, "T") !== undefined;
  const holder = merged ? valueHolder(widget, context) : null;
  const inheritedFrom = holder && holder !== widget ? holder : null;
  let fieldRemoved = merged;
  let remainingWidgets = 0;
  let fieldDict = null;
  let childRaw = widgetRaw;
  let child = widget;
  const emptied = [];
  for (let guard = 0; guard < 32; guard++) {
    const parentRaw = A.getRaw(child, "Parent");
    const parent = A.resolve(context, parentRaw);
    if (A.isDict(parent) && A.isArray(A.get(parent, "Kids"))) {
      const kids = A.get(parent, "Kids");
      removeRefFromArray(kids, childRaw);
      if (kids.size() > 0) {
        if (!merged && child === widget) {
          remainingWidgets = kids.size();
          fieldDict = parent;
        }
        break;
      }
      // the parent has no kids left (a field without widgets, or an empty group): it goes too
      if (!merged && child === widget) fieldRemoved = true;
      emptied.push(parent);
      childRaw = parentRaw;
      child = parent;
      continue;
    }
    // top level: `child` is listed in /Fields
    if (A.isDict(form)) {
      removeRefFromArray(A.get(form, "Fields"), childRaw);
      removeRefFromArray(A.get(form, "CO"), childRaw);
    }
    break;
  }
  // removed field dictionaries are emptied, so that a stray reference to them carries nothing
  for (const d of emptied) for (const k of d.keys()) d.delete(k);
  return { field: name, fieldRemoved, remainingWidgets, fieldDict, inheritedFrom: inheritedFrom && !emptied.includes(inheritedFrom) ? inheritedFrom : null };
}

function numberTreeGet(node, key, context, depth = 0) {
  if (!A.isDict(node) || depth > 32) return undefined;
  const nums = A.get(node, "Nums");
  if (A.isArray(nums)) {
    for (let i = 0; i + 1 < nums.size(); i += 2) if (A.num(nums.lookup(i)) === key) return nums.lookup(i + 1);
  }
  const kids = A.get(node, "Kids");
  if (A.isArray(kids)) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i);
      const limits = A.numArray(A.get(kid, "Limits"), 2);
      if (limits && (key < limits[0] || key > limits[1])) continue;
      const v = numberTreeGet(kid, key, context, depth + 1);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** Removes one key of a number tree. Returns true when it was there. (/Limits are left: they stay valid bounds.) */
function numberTreeDelete(node, key, depth = 0) {
  if (!A.isDict(node) || depth > 32) return false;
  const nums = A.get(node, "Nums");
  if (A.isArray(nums)) {
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      if (A.num(nums.lookup(i)) === key) {
        nums.remove(i + 1);
        nums.remove(i);
        return true;
      }
    }
  }
  const kids = A.get(node, "Kids");
  if (A.isArray(kids)) {
    for (let i = 0; i < kids.size(); i++) if (numberTreeDelete(kids.lookup(i), key, depth + 1)) return true;
  }
  return false;
}

/** Removes the object reference (OBJR) a structure element holds on an annotation that is being removed. */
function unlinkFromStructTree(pdfDoc, annotRaw, annot) {
  const context = pdfDoc.context;
  const root = A.get(pdfDoc.catalog, "StructTreeRoot");
  const key = A.getNum(annot, "StructParent");
  if (!A.isDict(root) || key === undefined) return;
  const elem = numberTreeGet(A.get(root, "ParentTree"), key, context);
  numberTreeDelete(A.get(root, "ParentTree"), key);
  if (!A.isDict(elem)) return;
  const isObjr = (o) => {
    const d = A.resolve(context, o);
    if (!A.isDict(d) || A.getName(d, "Type") !== "OBJR") return false;
    return A.sameRef(A.getRaw(d, "Obj"), annotRaw);
  };
  const k = A.getRaw(elem, "K");
  const kResolved = A.resolve(context, k);
  if (A.isArray(kResolved)) {
    for (let i = kResolved.size() - 1; i >= 0; i--) if (isObjr(kResolved.get(i))) kResolved.remove(i);
  } else if (isObjr(k)) elem.delete(A.N("K"));
}

/**
 * Where an annotation can paint: its /Rect, and the geometry some subtypes carry besides it. Viewers draw a
 * highlight from /QuadPoints and an ink stroke from /InkList even when /Rect is wrong (seen in the wild: a
 * Highlight written by fpdf2 whose /Rect lies outside the page).
 */
function annotationBoxes(dict) {
  const boxes = [];
  // a /Rect without area (a note icon placed at a point; seen as [x y x y]) still sits somewhere: it gets the
  // half point the lines below get. A missing /Rect reads as [0 0 0 0], as in pdf.js
  const rect = normRect(A.numArray(A.get(dict, "Rect"), 4) ?? [0, 0, 0, 0]);
  if (!(rect[2] > rect[0])) {
    rect[0] -= 0.5;
    rect[2] += 0.5;
  }
  if (!(rect[3] > rect[1])) {
    rect[1] -= 0.5;
    rect[3] += 0.5;
  }
  boxes.push(rect);
  const flat = (arr) => {
    const out = [];
    if (!A.isArray(arr)) return out;
    for (let i = 0; i < arr.size(); i++) {
      const v = arr.lookup(i);
      if (A.isNumber(v)) out.push(v.asNumber());
      else if (A.isArray(v)) out.push(...flat(v));
    }
    return out;
  };
  const bbox = (nums) => {
    if (nums.length < 4) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      x0 = Math.min(x0, nums[i]);
      x1 = Math.max(x1, nums[i]);
      y0 = Math.min(y0, nums[i + 1]);
      y1 = Math.max(y1, nums[i + 1]);
    }
    // a line has no area: give it the width of a stroke
    return [x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5];
  };
  const quads = flat(A.get(dict, "QuadPoints"));
  for (let i = 0; i + 7 < quads.length; i += 8) boxes.push(bbox(quads.slice(i, i + 8)));
  for (const key of ["InkList", "Vertices", "L", "CL"]) {
    const b = bbox(flat(A.get(dict, key)));
    if (b) boxes.push(b);
  }
  return boxes;
}

/**
 * Removes annotations of a page together with their popups and replies.
 *   rects   targets in user space: every annotation whose /Rect (or /QuadPoints, /InkList, /Vertices, /L, /CL)
 *           intersects one is removed
 *   all     true: every annotation of the page is removed (a rasterised page: they are in the picture)
 * Form widgets are detached from the AcroForm. A field that loses its last widget is removed with its value.
 * A field that keeps widgets elsewhere:
 *   - is emptied when the removed widget lay in a target (its value was under the mark; the other widgets
 *     stop showing it): reported in `fieldsCleared`;
 *   - keeps its value when the widget only went because the whole page was flattened: `fieldsKept`.
 * When a widget is removed and the form has /XFA, /XFA is deleted (it duplicates the field values).
 * Returns { removed: [{ subtype, rect, field? }], fieldsRemoved: [name], fieldsCleared: [{ field, widgets }],
 *           fieldsKept: [{ field, widgets }], xfaRemoved, kept }.
 */
export function removeAnnotations(pdfDoc, pageIndex, { rects = null, all = false } = {}) {
  const context = pdfDoc.context;
  const pageNode = pdfDoc.getPage(pageIndex).node;
  const result = { removed: [], fieldsRemoved: [], fieldsCleared: [], fieldsKept: [], xfaRemoved: false, kept: 0 };
  const annots = A.get(pageNode, "Annots");
  if (!A.isArray(annots)) return result;
  const targets = (rects || []).map(normRect);
  const entries = [];
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = A.resolve(context, raw);
    if (!A.isDict(dict)) continue;
    const rect = A.numArray(A.get(dict, "Rect"), 4);
    const boxes = annotationBoxes(dict);
    const hit = targets.length > 0 && boxes.some((b) => targets.some((t) => rectsIntersect(b, t)));
    entries.push({ raw, dict, rect: rect ? normRect(rect) : null, hit, subtype: A.getName(dict, "Subtype") ?? "?" });
  }
  const doomed = new Set();
  for (const e of entries) if (all || e.hit) doomed.add(e);
  // closure: popups of removed annotations, replies to them, the popup a removed annotation points to, and the
  // annotation whose popup is removed (the popup window shows the text of its parent: a mark over the open
  // window means that text)
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of entries) {
      if (doomed.has(e)) continue;
      const parent = A.getRaw(e.dict, "Parent");
      const irt = A.getRaw(e.dict, "IRT");
      const popup = A.getRaw(e.dict, "Popup");
      const linked = [...doomed].some((d) =>
        (e.subtype === "Popup" && parent && A.sameRef(parent, d.raw))
        || (irt && A.sameRef(irt, d.raw))
        || A.sameRef(A.getRaw(d.dict, "Popup"), e.raw)
        || (d.subtype === "Popup" && ((popup && A.sameRef(popup, d.raw)) || A.sameRef(A.getRaw(d.dict, "Parent"), e.raw))));
      if (linked) {
        doomed.add(e);
        changed = true;
      }
    }
  }
  if (!doomed.size) {
    result.kept = entries.length;
    return result;
  }
  let widgetRemoved = false;
  for (const e of doomed) {
    const info = { subtype: e.subtype, rect: e.rect };
    if (e.subtype === "Widget" || A.getRaw(e.dict, "FT") !== undefined) {
      widgetRemoved = true;
      const d = detachWidget(pdfDoc, e.raw, e.dict);
      info.field = d.field;
      if (d.fieldRemoved) result.fieldsRemoved.push(d.field);
      else if (d.remainingWidgets > 0 && e.hit) result.fieldsCleared.push({ field: d.field, widgets: clearFieldValue(pdfDoc, d.fieldDict) });
      else if (d.remainingWidgets > 0) result.fieldsKept.push({ field: d.field, widgets: d.remainingWidgets });
      // the widget was a field of its own that showed the value of a PARENT field: that value is still there for
      // the other children of the parent (they inherit it, and a viewer draws it into their widgets)
      if (d.inheritedFrom && e.hit) {
        const holderName = fieldName(d.inheritedFrom, context);
        result.fieldsCleared.push({ field: holderName, widgets: clearFieldValue(pdfDoc, d.inheritedFrom) });
      }
    }
    result.removed.push(info);
  }
  const keep = context.obj([]);
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    if (![...doomed].some((d) => A.sameRef(d.raw, raw))) keep.push(raw);
  }
  result.kept = keep.size();
  if (keep.size()) pageNode.set(A.N("Annots"), keep);
  else pageNode.delete(A.N("Annots"));
  // unlink from the structure tree and empty the removed dictionaries: whatever still points at them
  // (a /Dest, another annotation, a script) then points at nothing
  for (const e of doomed) {
    unlinkFromStructTree(pdfDoc, e.raw, e.dict);
    for (const k of e.dict.keys()) e.dict.delete(k);
  }
  if (widgetRemoved) {
    const form = acroForm(pdfDoc);
    if (A.isDict(form) && form.has(A.N("XFA"))) {
      form.delete(A.N("XFA"));
      result.xfaRemoved = true;
    }
  }
  return result;
}

/** Deletes page entries that can hold a copy of the page as it was: thumbnail, private application data ... */
export function stripPageExtras(pdfDoc, pageIndex, { raster = false } = {}) {
  const pageNode = pdfDoc.getPage(pageIndex).node;
  const removed = [];
  const keys = ["Thumb", "PieceInfo", "Metadata"];
  if (raster) keys.push("B", "AA", "Group", "SeparationInfo", "VP", "PresSteps", "BoxColorInfo");
  for (const k of keys) {
    if (pageNode.has(A.N(k))) {
      pageNode.delete(A.N(k));
      removed.push(k);
    }
  }
  return removed;
}

/**
 * A test "does this text repeat removed text?" for the words that hang on the ANCESTORS of an element that
 * lost content: any removed run of two or more characters counts (contained in the text, or containing it).
 * No length limit of six characters here, as the document-wide search has it: the title of the section a
 * redacted line stands in is close enough to the line to be read as its copy. null when nothing was removed.
 */
function removedMatcher(removedStrings) {
  const needles = [...new Set((removedStrings || []).map(squashText).filter((text) => [...text].length >= 2))];
  if (!needles.length) return null;
  return (raw) => {
    const text = squashText(raw);
    return [...text].length >= 2 && needles.some((needle) => text.includes(needle) || needle.includes(text));
  };
}

const decodeString = (value) => {
  try {
    return value.decodeText();
  } catch {
    return "";
  }
};

/**
 * Deletes strings from the attribute objects (/A: a dictionary, a stream, or an array of them with revision
 * numbers) of a structure element: /Summary of a table, /Desc of a form field, the values of user
 * properties ... `matches`: only the strings it accepts (null: every string). Returns the number deleted.
 */
function stripAttributeStrings(elem, context, matches = null) {
  let stripped = 0;
  const seen = new Set();
  const doomed = (value) => A.isString(value) && (!matches || matches(decodeString(value)));
  const walk = (holder, depth) => {
    if (depth > 8 || seen.has(holder)) return;
    seen.add(holder);
    if (holder instanceof PDFDict) {
      for (const [name, raw] of holder.entries()) {
        const value = A.resolve(context, raw);
        if (doomed(value)) {
          holder.delete(name);
          stripped++;
        } else if (value instanceof PDFDict || value instanceof PDFArray) walk(value, depth + 1);
        else if (value instanceof PDFStream) walk(value.dict, depth + 1);
      }
    } else {
      for (let i = holder.size() - 1; i >= 0; i--) {
        const value = A.resolve(context, holder.get(i));
        if (doomed(value)) {
          holder.remove(i);
          stripped++;
        } else if (value instanceof PDFDict || value instanceof PDFArray) walk(value, depth + 1);
        else if (value instanceof PDFStream) walk(value.dict, depth + 1);
      }
    }
  };
  const attributes = A.get(elem, "A");
  if (attributes instanceof PDFDict || attributes instanceof PDFArray) walk(attributes, 0);
  else if (attributes instanceof PDFStream) walk(attributes.dict, 0);
  return stripped;
}

/**
 * Strips the words of a structure element and of its ancestors.
 *   the element   /ActualText /Alt /E /T and every string of its attribute objects (/A)
 *   ancestors     /ActualText /Alt /E; with `removed` (removedMatcher) also a /T and attribute strings that
 *                 repeat what was removed (a document title says nothing of one line, unless it IS the line)
 */
function stripElementText(elem, seen, { context, removed = null } = {}) {
  let stripped = 0;
  let own = true;
  for (let guard = 0; A.isDict(elem) && guard < 64; guard++) {
    if (A.getName(elem, "Type") === "StructTreeRoot") break;
    for (const k of own ? ELEMENT_OWN_KEYS : ELEMENT_TEXT_KEYS) {
      if (elem.has(A.N(k))) {
        elem.delete(A.N(k));
        stripped++;
      }
    }
    if (own) stripped += stripAttributeStrings(elem, context);
    else if (removed) {
      const title = A.get(elem, "T");
      if (A.isString(title) && removed(decodeString(title))) {
        elem.delete(A.N("T"));
        stripped++;
      }
      stripped += stripAttributeStrings(elem, context, removed);
    }
    // `seen`: elements whose chain of ancestors has been walked already
    if (!own && seen.has(elem)) break;
    seen.add(elem);
    own = false;
    elem = A.get(elem, "P");
  }
  return stripped;
}

/**
 * The structure elements that own marked content of a page, found by walking the tree itself (the parent
 * tree is a shortcut a file may lack or have wrong; viewers do not need it to read the words of an element).
 *   mcids   array of ids, or "all"
 *   form    { structParents } or { stm: "num gen" }: ids of the content of that Form XObject (marked-content
 *           references with /Stm) instead of the page content
 */
function structOwners(pdfDoc, page, mcids, { structParents, stm } = {}) {
  const context = pdfDoc.context;
  const root = A.get(pdfDoc.catalog, "StructTreeRoot");
  const owners = [];
  if (!A.isDict(root)) return owners;
  const wanted = mcids === "all" ? null : new Set(mcids);
  const inForm = structParents !== undefined || stm !== undefined;
  const isPage = (raw) => raw !== undefined && (A.sameRef(raw, page.ref) || A.resolve(context, raw) === page.node);
  const isForm = (raw) => {
    if (raw === undefined) return false;
    if (stm !== undefined && A.idOf(raw) === stm) return true;
    const stream = A.resolve(context, raw);
    return structParents !== undefined && A.isStream(stream) && A.getNum(stream.dict, "StructParents") === structParents;
  };
  const seen = new Set();
  const stack = [[root, undefined]];
  while (stack.length) {
    const [elem, inheritedPg] = stack.pop();
    if (!A.isDict(elem) || seen.has(elem)) continue;
    seen.add(elem);
    const pg = A.getRaw(elem, "Pg") ?? inheritedPg;
    let owns = false;
    const visit = (kidRaw) => {
      const kid = A.resolve(context, kidRaw);
      if (A.isNumber(kid)) {
        if (!inForm && isPage(pg) && (!wanted || wanted.has(kid.asNumber()))) owns = true;
        return;
      }
      if (!A.isDict(kid)) return;
      const type = A.getName(kid, "Type");
      if (type === "OBJR") return;
      if (type === "MCR") {
        const kidStm = A.getRaw(kid, "Stm");
        const here = inForm ? isForm(kidStm) : kidStm === undefined && isPage(A.getRaw(kid, "Pg") ?? pg);
        if (here && (!wanted || wanted.has(A.getNum(kid, "MCID")))) owns = true;
        return;
      }
      stack.push([kid, pg]);
    };
    const kRaw = A.getRaw(elem, "K");
    const k = A.resolve(context, kRaw);
    if (A.isArray(k)) for (let i = 0; i < k.size(); i++) visit(k.get(i));
    else if (kRaw !== undefined) visit(kRaw);
    if (owns && elem !== root) owners.push(elem);
  }
  return owners;
}

/**
 * Strips the words of the structure elements that own the given marked-content ids (/ActualText, /Alt, /E, /T
 * and the strings of their attribute objects) and /ActualText, /Alt, /E of their ancestors. The owners are
 * taken from the parent tree AND from a walk of the tree: a missing or wrong parent tree must not keep the
 * words of a redacted line in the file.
 *   mcids            array of numbers, or "all" for every element that owns content of the page / the form
 *   structParents    key of the parent tree to use instead of the page's /StructParents (a Form XObject)
 *   stm              "num gen" of a Form XObject without /StructParents whose ids are meant
 *   removedStrings   the text the marks removed (verifyRedaction.removedText): titles and attribute strings of
 *                    the ANCESTORS that repeat it go too
 * Returns the number of entries removed.
 */
export function stripStructAttributes(pdfDoc, pageIndex, mcids, { structParents, stm, removedStrings } = {}) {
  const context = pdfDoc.context;
  const root = A.get(pdfDoc.catalog, "StructTreeRoot");
  if (!A.isDict(root)) return 0;
  const page = pdfDoc.getPage(pageIndex);
  const owners = new Set();
  const key = structParents ?? (stm === undefined ? A.getNum(page.node, "StructParents") : undefined);
  const entry = key === undefined ? undefined : numberTreeGet(A.get(root, "ParentTree"), key, context);
  if (A.isArray(entry)) {
    const ids = mcids === "all" ? [...Array(entry.size()).keys()] : mcids;
    for (const id of ids) {
      const owner = id >= 0 && id < entry.size() ? entry.lookup(id) : undefined;
      if (A.isDict(owner)) owners.add(owner);
    }
  }
  for (const owner of structOwners(pdfDoc, page, mcids, { structParents, stm })) owners.add(owner);
  let stripped = 0;
  const seen = new Set();
  const options = { context, removed: removedMatcher(removedStrings) };
  for (const owner of owners) stripped += stripElementText(owner, seen, options);
  return stripped;
}

/**
 * Takes a page out of the structure tree (the page became a picture: none of its marked content exists any
 * more). Every kid of a structure element that refers to the page goes: a marked-content id of an element
 * whose /Pg is the page, a marked-content reference (/MCR) or an object reference (/OBJR) with that page.
 * The elements that lose kids, and their ancestors, lose their words; the page's entry of the parent tree
 * and its /StructParents key are deleted.
 *   removedStrings   the text the marks removed: titles and attribute strings of ancestors that repeat it go too
 * Returns { kidsRemoved, attributesStripped, parentTreeEntry }.
 */
export function detachPageFromStructTree(pdfDoc, pageIndex, { removedStrings } = {}) {
  const context = pdfDoc.context;
  const stripOptions = { context, removed: removedMatcher(removedStrings) };
  const result = { kidsRemoved: 0, attributesStripped: 0, parentTreeEntry: false };
  const root = A.get(pdfDoc.catalog, "StructTreeRoot");
  const page = pdfDoc.getPage(pageIndex);
  const pageNode = page.node;
  const key = A.getNum(pageNode, "StructParents");
  pageNode.delete(A.N("StructParents"));
  if (!A.isDict(root)) return result;
  if (key !== undefined) result.parentTreeEntry = numberTreeDelete(A.get(root, "ParentTree"), key);
  const isPage = (raw) => raw !== undefined && (A.sameRef(raw, page.ref) || A.resolve(context, raw) === pageNode);
  const seen = new Set();
  const stripSeen = new Set();
  // iterative walk: [element, page inherited from the parent element]
  const stack = [[root, undefined]];
  while (stack.length) {
    const [elem, inheritedPg] = stack.pop();
    if (!A.isDict(elem) || seen.has(elem)) continue;
    seen.add(elem);
    const pg = A.getRaw(elem, "Pg") ?? inheritedPg;
    /** "remove": the kid refers to content of the page; "child": a structure element to walk; "keep" */
    const classify = (kidRaw) => {
      const kid = A.resolve(context, kidRaw);
      if (A.isNumber(kid)) return isPage(pg) ? "remove" : "keep";
      if (!A.isDict(kid)) return "keep";
      const type = A.getName(kid, "Type");
      if (type === "MCR" || type === "OBJR") return isPage(A.getRaw(kid, "Pg") ?? pg) ? "remove" : "keep";
      return "child";
    };
    const kRaw = A.getRaw(elem, "K");
    const k = A.resolve(context, kRaw);
    let lost = 0;
    if (A.isArray(k)) {
      for (let i = k.size() - 1; i >= 0; i--) {
        const verdict = classify(k.get(i));
        if (verdict === "child") stack.push([A.resolve(context, k.get(i)), pg]);
        else if (verdict === "remove") {
          k.remove(i);
          lost++;
        }
      }
    } else if (kRaw !== undefined) {
      const verdict = classify(kRaw);
      if (verdict === "child") stack.push([k, pg]);
      else if (verdict === "remove") {
        elem.delete(A.N("K"));
        lost++;
      }
    }
    if (lost && elem !== root) {
      result.kidsRemoved += lost;
      result.attributesStripped += stripElementText(elem, stripSeen, stripOptions);
    }
  }
  return result;
}

/** What, besides the content stream, still carries text on a page (for tests and diagnostics). */
export function listTextCarriers(pdfDoc, pageIndex) {
  const context = pdfDoc.context;
  const pageNode = pdfDoc.getPage(pageIndex).node;
  const out = [];
  const text = (o) => (A.isString(o) ? o.decodeText() : undefined);
  const annots = A.get(pageNode, "Annots");
  if (A.isArray(annots)) {
    for (let i = 0; i < annots.size(); i++) {
      const d = annots.lookup(i);
      if (!A.isDict(d)) continue;
      const subtype = A.getName(d, "Subtype") ?? "?";
      const item = { kind: "annotation", subtype, rect: A.numArray(A.get(d, "Rect"), 4) };
      const contents = text(A.get(d, "Contents"));
      if (contents) item.contents = contents;
      const action = A.get(d, "A");
      const uri = A.isDict(action) ? text(A.get(action, "URI")) : undefined;
      if (uri) item.uri = uri;
      if (subtype === "Widget") {
        item.field = fieldName(d, context);
        const v = inheritedEntry(d, "V", context);
        if (v !== undefined) item.value = text(v) ?? A.nameOf(v) ?? "(other)";
      }
      if (d.has(A.N("AP"))) item.hasAppearance = true;
      out.push(item);
    }
  }
  for (const k of ["Thumb", "PieceInfo", "Metadata"]) if (pageNode.has(A.N(k))) out.push({ kind: "page-entry", key: k });
  if (A.getNum(pageNode, "StructParents") !== undefined && A.isDict(A.get(pdfDoc.catalog, "StructTreeRoot"))) out.push({ kind: "structure-tree" });
  return out;
}

/**
 * Objects that are no longer drawn but are still referenced from the structure tree.
 *
 * A tagged PDF refers to a Form XObject from its structure tree (marked-content references with /Stm, object
 * references with /Obj). Such a reference keeps the ORIGINAL stream in the file after the page stopped
 * drawing it. For every candidate reference this function looks at who still refers to it: when only
 * structure-tree dictionaries (/Type /MCR or /OBJR) are left, the object is overwritten: with the redacted
 * copy when there is one (`replacements`: Map "num gen" -> PDFRef of the copy), with an empty stream otherwise.
 * Returns the number of objects overwritten.
 */
export function releaseOrphanedObjects(pdfDoc, candidates, { replacements = new Map() } = {}) {
  const context = pdfDoc.context;
  const tag = (r) => `${r.objectNumber} ${r.generationNumber}`;
  const wanted = new Map();
  for (const c of candidates) if (A.isRef(c)) wanted.set(tag(c), { ref: c, structural: 0, other: 0 });
  if (!wanted.size) return 0;
  const walk = (o, depth) => {
    if (depth > 64 || !o) return;
    if (A.isStream(o)) {
      walk(o.dict, depth + 1);
    } else if (A.isDict(o)) {
      const type = A.getName(o, "Type");
      const structural = type === "MCR" || type === "OBJR";
      for (const v of o.values()) {
        if (A.isRef(v)) {
          const w = wanted.get(tag(v));
          if (w) w[structural ? "structural" : "other"]++;
        } else walk(v, depth + 1);
      }
    } else if (A.isArray(o)) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i);
        if (A.isRef(v)) {
          const w = wanted.get(tag(v));
          if (w) w.other++;
        } else walk(v, depth + 1);
      }
    }
  };
  for (const [, obj] of context.enumerateIndirectObjects()) walk(obj, 0);
  let overwritten = 0;
  for (const [t, w] of wanted) {
    if (w.other > 0 || w.structural === 0) continue; // still used for real, or unreferenced (the garbage collector takes it)
    const copy = replacements.get(t);
    const replacement = copy ? context.lookup(copy) : undefined;
    context.assign(w.ref, A.isStream(replacement) ? replacement : context.stream(new Uint8Array(0)));
    overwritten++;
  }
  return overwritten;
}

// ---------------------------------------------------------------- copies of the removed text elsewhere
const WHITE_SPACE = new RegExp(`[\\s${String.fromCharCode(0xa0, 0x200b, 0xfeff)}]+`, "g");
const squashText = (text) => text.normalize("NFC").replace(WHITE_SPACE, "");
const OUTLINE_KEYS = ["Dest", "A", "First", "Next", "Prev", "Count"];
/** Strings that are machinery, not text a reader meets: character collections, appearance programs, dates, ids. */
const TECHNICAL_STRING_KEYS = new Set(["Registry", "Ordering", "DA", "DS", "CreationDate", "ModDate", "M", "NM", "ID"]);

/** Which part of the document a string value belongs to, by the dictionary and the key that hold it. */
function placeOfString(dict, key, infoDict) {
  if (dict === infoDict) return "metadata";
  const type = A.getName(dict, "Type");
  if (type === "StructElem" || type === "StructTreeRoot") return "structure";
  if (type === "Filespec" || dict.has(A.N("EF"))) return "attachment";
  if (key === "Title" && dict.has(A.N("Parent")) && OUTLINE_KEYS.some((name) => dict.has(A.N(name)))) return "outline";
  if (["TU", "TM", "V", "DV", "RV", "Opt"].includes(key)) return "form";
  if (key === "T" && (dict.has(A.N("FT")) || dict.has(A.N("Kids")) || A.getName(dict, "Subtype") === "Widget")) return "form";
  if (["Contents", "RC", "Subj", "T"].includes(key) && (type === "Annot" || dict.has(A.N("Rect")))) return "annotation";
  if (["ActualText", "Alt", "E"].includes(key)) return "structure";
  return "other";
}

/**
 * The dictionaries that belong to the structure tree without saying so: structure elements written without
 * /Type, their attribute objects (/A) and the attribute classes of the root (/ClassMap). A string in one of
 * them is a word of the tree, whatever its key.
 */
function structureDictionaries(pdfDoc) {
  const found = new Set();
  const root = A.get(pdfDoc.catalog, "StructTreeRoot");
  if (!A.isDict(root)) return found;
  const addAttributes = (value, depth = 0) => {
    if (depth > 4) return;
    if (value instanceof PDFStream) found.add(value.dict);
    else if (value instanceof PDFDict) found.add(value);
    else if (value instanceof PDFArray) for (let i = 0; i < value.size(); i++) addAttributes(value.lookup(i), depth + 1);
  };
  const classMap = A.get(root, "ClassMap");
  if (classMap instanceof PDFDict) for (const key of classMap.keys()) addAttributes(classMap.lookup(key));
  const stack = [root];
  while (stack.length) {
    const elem = stack.pop();
    if (!A.isDict(elem) || found.has(elem)) continue;
    found.add(elem);
    addAttributes(A.get(elem, "A"));
    const kids = A.get(elem, "K");
    const visit = (kid) => {
      const type = A.isDict(kid) ? A.getName(kid, "Type") : null;
      if (A.isDict(kid) && type !== "MCR" && type !== "OBJR") stack.push(kid);
    };
    if (A.isArray(kids)) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i));
    else visit(kids);
  }
  return found;
}

/** The nodes of the name tree of the attached files (/Names /EmbeddedFiles of the catalog): their keys are file names. */
function embeddedFileNameNodes(pdfDoc) {
  const nodes = new Set();
  const stack = [A.get(A.get(pdfDoc.catalog, "Names"), "EmbeddedFiles")];
  while (stack.length && nodes.size < 10000) {
    const node = stack.pop();
    if (!A.isDict(node) || nodes.has(node)) continue;
    nodes.add(node);
    const kids = A.get(node, "Kids");
    if (A.isArray(kids)) for (let i = 0; i < kids.size(); i++) stack.push(kids.lookup(i));
  }
  return nodes;
}

/** More than this is not decoded for the search (a text of this size is not a text). */
const MAX_SEARCHED_STREAM = 16 * 1024 * 1024;

/**
 * The text of a stream that may hold text in some Unicode encoding: an XMP packet, an attached file, a script.
 * The encoding is taken from the byte-order mark; without one, from the zero bytes a UTF-16 text of mostly
 * Latin characters has (an XMP packet may be written without the mark); UTF-8 otherwise.
 */
export function decodeTextBytes(bytes) {
  const b = bytes;
  const from = (label, skip) => new TextDecoder(label).decode(b.subarray(skip));
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return from("utf-8", 3);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return from("utf-16be", 2);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return from("utf-16le", 2);
  if (b.length >= 4 && b.length % 2 === 0) {
    const sample = Math.min(b.length, 512) & ~1;
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < sample; i += 2) {
      if (b[i] === 0) evenZero++;
      if (b[i + 1] === 0) oddZero++;
    }
    if (evenZero > sample / 5 && oddZero < sample / 50) return from("utf-16be", 0);
    if (oddZero > sample / 5 && evenZero < sample / 50) return from("utf-16le", 0);
  }
  return from("utf-8", 0);
}

/**
 * The streams of a document that are text for a reader or a program, with the place they belong to:
 * Map<PDFStream, "metadata" | "attachment" | "form" | "other">.
 *   metadata     XMP packets (/Type /Metadata, /Subtype /XML)
 *   attachment   embedded files (/Type /EmbeddedFile, or listed in the /EF dictionary of a file specification)
 *   form         XFA packets
 *   other        scripts held as streams (/JS)
 */
function textStreams(pdfDoc) {
  const context = pdfDoc.context;
  const roles = new Map();
  const give = (raw, role) => {
    const stream = A.resolve(context, raw);
    if (stream instanceof PDFStream && !roles.has(stream)) roles.set(stream, role);
  };
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream) {
      const type = A.getName(object.dict, "Type");
      if (type === "EmbeddedFile") give(object, "attachment");
      else if (type === "Metadata" || A.getName(object.dict, "Subtype") === "XML") give(object, "metadata");
    }
    const stack = [object instanceof PDFStream ? object.dict : object];
    while (stack.length) {
      const value = stack.pop();
      if (value instanceof PDFDict) {
        for (const [name, child] of value.entries()) {
          const key = name.decodeText();
          if (key === "JS") give(child, "other");
          else if (key === "XFA") {
            const xfa = A.resolve(context, child);
            if (xfa instanceof PDFArray) for (let i = 0; i < xfa.size(); i++) give(xfa.get(i), "form");
            else give(child, "form");
          } else if (key === "EF") {
            const files = A.resolve(context, child);
            if (files instanceof PDFDict) for (const entry of files.values()) give(entry, "attachment");
          }
          if (child instanceof PDFDict || child instanceof PDFArray) stack.push(child);
        }
      } else if (value instanceof PDFArray) {
        for (let i = 0; i < value.size(); i++) {
          const child = value.get(i);
          if (child instanceof PDFDict || child instanceof PDFArray) stack.push(child);
        }
      }
    }
  }
  return roles;
}

/** The number of files attached to the document (embedded file streams). The engine cannot look into most of them. */
export function countEmbeddedFiles(pdfDoc) {
  let count = 0;
  for (const role of textStreams(pdfDoc).values()) if (role === "attachment") count++;
  return count;
}

/**
 * The places of a document that repeat text which a mark removed from a page: [{ where, owner, key }] for a
 * string value (the dictionary and the key it hangs on) and [{ where }] for a stream that is text (an XMP
 * packet, an attached file, a script, an XFA packet: textStreams()).
 *   removedStrings   the text of the runs of glyphs that were removed (verifyRedaction.removedText())
 *   minLength        shorter strings are not looked for (a removed "of" proves nothing about a title)
 * A string of the document counts when it contains a removed string or is contained in one (white space and
 * the composition of accents do not matter). In the STRUCTURE TREE a shorter removed string (two characters
 * or more) counts as well when a word of the tree is exactly that string: nobody can see or edit those words,
 * and the alternative text of a figure that IS the removed number must not survive because it is short.
 */
function repeatedText(pdfDoc, removedStrings, minLength) {
  const context = pdfDoc.context;
  const lengthOf = (text) => [...text].length;
  const squashed = [...new Set(removedStrings.map(squashText))];
  const needles = squashed.filter((text) => lengthOf(text) >= minLength).sort((a, b) => b.length - a.length).slice(0, 400);
  const shortNeedles = new Set(squashed.filter((text) => lengthOf(text) >= 2 && lengthOf(text) < minLength));
  const places = [];
  if (!needles.length && !shortNeedles.size) return places;
  const repeats = (text) => lengthOf(text) >= minLength && needles.some((needle) => text.includes(needle) || needle.includes(text));
  const infoDict = A.resolve(context, context.trailerInfo.Info);
  const structure = shortNeedles.size || needles.length ? structureDictionaries(pdfDoc) : new Set();
  const fileNames = embeddedFileNameNodes(pdfDoc);
  for (const [, object] of context.enumerateIndirectObjects()) {
    // every string of the object, with the dictionary and the key it hangs on ([value, owner, key, in the tree])
    const top = object instanceof PDFStream ? object.dict : object;
    const stack = [[top, null, null, structure.has(top)]];
    while (stack.length) {
      const [value, owner, key, inTree] = stack.pop();
      if (A.isString(value)) {
        if (!owner || TECHNICAL_STRING_KEYS.has(key)) continue;
        const text = squashText(decodeString(value));
        const where = inTree ? "structure" : fileNames.has(owner) && key === "Names" ? "attachment" : placeOfString(owner, key, infoDict);
        if (repeats(text) || (where === "structure" && shortNeedles.has(text))) places.push({ where, owner, key });
      } else if (value instanceof PDFDict) {
        const within = inTree || structure.has(value);
        for (const [name, child] of value.entries()) stack.push([child, value, name.decodeText(), within]);
      } else if (value instanceof PDFArray) {
        for (let i = 0; i < value.size(); i++) stack.push([value.get(i), owner, key, inTree]);
      }
    }
  }
  if (needles.length) {
    for (const [stream, where] of textStreams(pdfDoc)) {
      try {
        const bytes = A.streamBytes(stream);
        if (bytes.length > MAX_SEARCHED_STREAM) continue;
        const text = squashText(decodeTextBytes(bytes));
        if (needles.some((needle) => text.includes(needle))) places.push({ where });
      } catch {
        /* a stream that cannot be decoded repeats nothing this search could find (attachments are reported apart) */
      }
    }
  }
  return places;
}

/**
 * Deletes the words of the structure tree that repeat text a mark removed: /T, /ActualText, /Alt and /E of
 * ANY structure element, strings of attribute objects, and /ActualText, /Alt, /E of property lists.
 * stripStructAttributes() already took the words of the elements that own the content; this takes the copies
 * that hang elsewhere in the tree (seen in the wild: a "Chapter" element whose /T is the heading of the
 * chapter, word for word). Nobody can see or edit these entries in a viewer, so the engine cannot leave them
 * to the user as it leaves bookmarks.
 * Returns the number of entries deleted.
 */
export function stripStructureWords(pdfDoc, removedStrings, { minLength = 6 } = {}) {
  let stripped = 0;
  for (const place of repeatedText(pdfDoc, removedStrings, minLength)) {
    if (place.where !== "structure" || !place.owner || !place.owner.has(A.N(place.key))) continue;
    place.owner.delete(A.N(place.key));
    stripped++;
  }
  return stripped;
}

/**
 * Where else the document repeats text that a mark removed from a page: bookmark titles ("outline"), the
 * document properties in the Info dictionary and in XMP packets of any Unicode encoding ("metadata"), names,
 * tooltips and values of form fields and XFA packets ("form"), texts of annotations ("annotation"), attached
 * files and their names ("attachment": only files that are plain text can be searched), words of the
 * structure tree ("structure": none after stripStructureWords()) and any other string object or script
 * ("other"). The engine does not delete these (they are not under a mark, and the document's bookmarks and
 * properties are not its to rewrite): it reports them, so that the caller can.
 *   removedStrings, minLength   as for repeatedText()
 * Returns [{ where, count }], sorted by `where`; never the text itself.
 */
export function findTextElsewhere(pdfDoc, removedStrings, { minLength = 6 } = {}) {
  const counts = new Map();
  for (const place of repeatedText(pdfDoc, removedStrings, minLength)) counts.set(place.where, (counts.get(place.where) || 0) + 1);
  return [...counts].map(([where, n]) => ({ where, count: n })).sort((a, b) => a.where.localeCompare(b.where));
}

// ---------------------------------------------------------------- garbage collection
/** Calls visit(ref) for every reference directly contained in `object` (references are not followed). */
function forEachDirectRef(object, visit) {
  const stack = [object];
  while (stack.length) {
    const current = stack.pop();
    if (current instanceof PDFRef) {
      visit(current);
    } else if (current instanceof PDFDict) {
      const values = current.values();
      for (let i = 0; i < values.length; i++) stack.push(values[i]);
    } else if (current instanceof PDFArray) {
      for (let i = 0, n = current.size(); i < n; i++) stack.push(current.get(i));
    } else if (current instanceof PDFStream) {
      stack.push(current.dict);
    } else if (current instanceof PDFInvalidObject) {
      // opaque bytes of an object the parser gave up on: whatever looks like a reference in there keeps
      // its target alive
      let text = "";
      for (let i = 0; i < current.data.length; i += 0x8000) text += String.fromCharCode.apply(null, current.data.subarray(i, i + 0x8000));
      const pattern = /(\d+)\s+(\d+)\s+R/g;
      for (let m = pattern.exec(text); m; m = pattern.exec(text)) visit(PDFRef.of(Number(m[1]), Number(m[2])));
    }
  }
}

/** The references reachable from the trailer (Root, Info, Encrypt, ID): a Set of PDFRef. */
export function reachableRefs(pdfDoc) {
  const context = pdfDoc.context;
  const marked = new Set();
  const queue = [];
  const visit = (ref) => {
    if (!marked.has(ref)) {
      marked.add(ref);
      queue.push(ref);
    }
  };
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  for (const root of [Root, Info, Encrypt, ID]) if (root) forEachDirectRef(root, visit);
  while (queue.length) {
    const target = context.lookup(queue.pop());
    if (target) forEachDirectRef(target, visit);
  }
  return marked;
}

/**
 * Deletes every indirect object that cannot be reached from the trailer (Root, Info, Encrypt, ID).
 *
 * The library writes ALL objects of its context on save(), referenced or not: without this step the original
 * content streams, replaced Form XObjects, removed annotations and field values stay in the file (found by a
 * raw scan, invisible to every text extractor). It is the last step before save():
 *   1. flush: fonts and images become objects only now (an embedded but unused font would otherwise be
 *      written after the sweep);
 *   2. indirect /Length entries are dropped: the writer replaces them by direct numbers while serialising,
 *      which would orphan the number objects AFTER the sweep;
 *   3. mark from the trailer, delete the rest. The parser's own leftovers (/ObjStm and /XRef streams of the
 *      source, which the library keeps in the context) are unreachable and go as well;
 *   4. the context's cached "q" / "Q" wrapper streams are forgotten when they were swept, and (final: true)
 *      the object-number high-water mark is lowered so that the trailer /Size is exact.
 * Returns { deleted, kept }.
 */
export async function collectGarbage(pdfDoc, { final = true } = {}) {
  await pdfDoc.flush();
  const context = pdfDoc.context;
  const lengthKey = A.N("Length");
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFStream && object.dict.get(lengthKey) instanceof PDFRef) object.dict.delete(lengthKey);
  }
  const marked = reachableRefs(pdfDoc);
  let deleted = 0;
  let kept = 0;
  let largest = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (marked.has(ref)) {
      kept++;
      if (ref.objectNumber > largest) largest = ref.objectNumber;
    } else {
      context.delete(ref);
      deleted++;
    }
  }
  for (const key of ["pushGraphicsStateContentStreamRef", "popGraphicsStateContentStreamRef"]) {
    if (context[key] && !marked.has(context[key])) context[key] = undefined;
  }
  if (final && largest > 0) context.largestObjectNumber = largest;
  return { deleted, kept };
}
