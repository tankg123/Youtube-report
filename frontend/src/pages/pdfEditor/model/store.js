// The document store of the PDF editor: the working document (pages taken from source PDFs plus blank
// pages, and the objects the user put on them), its undo history and the bytes that belong to it.
// No DOM, no React, no user text: it runs under `node --test` and reports PdfEditorError codes (codes.js).
//
//   const store = createEditorStore({ measureText });
//   const state = useSyncExternalStore(store.subscribe, store.getState);      // a DocumentState (schema.js)
//
// The state is immutable and deeply frozen: a command builds the next state, sharing every page and object
// it did not touch, so `===` tells what changed and a history snapshot costs almost nothing.
//
// What is in the undo history, and what is not
//   document    { fileName, pages, objects }: every command that changes it is exactly ONE undo step
//               (transaction() groups several, a coalesceKey merges a slider drag into one).
//   registries  state.sources and state.assets: the files and images the document OR ITS HISTORY can still
//               need. addSource() / addAsset() only register (no undo step, not "dirty"); undo never removes
//               an entry; an entry disappears by itself once no page / object of the current document and of
//               no undo or redo step refers to it (an entry that was never used stays until it is used,
//               discarded with discardSource() / discardAsset(), or the store is reset).
//   side tables the bytes and the password of sources, the bytes of assets, the page facts of the viewer:
//               never in the state, never in a snapshot (getSourceBytes, getSourcePassword, getAssetBytes).
//
// Rules every object obeys once it is in the state
//   * it passes validateObject (schema.js); colours are "#rrggbb", text is in the canonical form of
//     text/fontSupport.js normalizeText() (NFC, "\n" line breaks, no tabs or idle invisible characters), font
//     sizes are quantised, the rectangle of a mark is normalised, frame.rot is in [0, 360)
//   * a text box has the size the text measurer reports: measureText(object) -> { w, h } in points. With
//     autoWidth the box takes w and h and keeps the point its alignment anchors (left: top-left corner,
//     center: top centre, right: top-right corner); a wrapping box keeps its width and takes h (top edge
//     fixed). Rotated boxes keep the anchor on the page (resizeFrame). Without a measurer frames are taken
//     as given. A measurer that throws (font not loaded yet) makes the command fail and changes nothing.
//   * at least 8 pt of it are on its page (clampObjectToPage): no command can lose an object off the page
//   * marks (redact, blur) are listed before every other object in page.objectIds: they stay at the bottom
//
// Commands that take a list of ids ignore ids that do not exist (a selection can be stale after an undo)
// and report what they did in their result; a command that changes nothing makes no undo step and does not
// notify. Selection is not document state: it lives in the interaction state (tools/interaction.js).
import { PdfEditorError } from "../engine/errors.js";
import { normalizeAngle, normalizeRect, normalizeRightAngle, resizeFrame } from "../engine/geometry.js";
import { quantizeFontSize } from "../engine/textRules.js";
import { normalizeText } from "../text/fontSupport.js";
import { createId, createSeed, isMark, normalizeColor, validateObject } from "./schema.js";
import { clampObjectToPage, isMovable, pristineSourceId, validatePage } from "./selectors.js";
import { deepEqual, deepFreeze, pageScreen, translatePatch } from "./shapes.js";
import { DUPLICATE_OFFSET, placeOnPage } from "./transform.js";

export const HISTORY_LIMIT = 200;
export const COALESCE_WINDOW_MS = 500;
/** Largest page edge a PDF viewer accepts (14 400 units = 200 inches). */
export const PAGE_SIZE_LIMITS = Object.freeze({ min: 1, max: 14400 });
export const ASSET_MIME_TYPES = Object.freeze(["image/png", "image/jpeg"]);
export const ARRANGE_DIRECTIONS = Object.freeze(["front", "forward", "backward", "back"]);

const INFO_KEYS = ["title", "author", "subject", "keywords", "creator", "producer"];
const TEXT_LAYOUT_KEYS = ["text", "font", "size", "bold", "italic", "lineHeight", "autoWidth"];
const COLOR_KEYS = ["color", "stroke", "fill"];
const FIXED_KEYS = ["id", "type", "pageId"];
// The properties that place each object type (model/schema.js); no object may carry another type's.
const ALL_GEOMETRY_KEYS = ["frame", "rect", "p1", "p2", "quads", "points"];
const GEOMETRY_KEYS = Object.freeze({
  text: ["frame"],
  image: ["frame"],
  rect: ["frame"],
  ellipse: ["frame"],
  line: ["p1", "p2"],
  pen: ["frame", "points"],
  "highlight:text": ["quads"],
  "highlight:stroke": ["frame", "points"],
  redact: ["rect"],
  blur: ["rect"]
});

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const isFiniteRect = (value) => Array.isArray(value) && value.length === 4 && value.every(finite);
const isNormalRect = (rect) => rect[0] <= rect[2] && rect[1] <= rect[3];
const defaultNow = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
const fail = (code, params, detail) => new PdfEditorError(code, params, detail ? { detail } : undefined);

/** A deep copy of plain data; keys whose value is undefined are left out. Typed arrays are kept as they are. */
function clonePlain(value) {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(clonePlain);
  const out = {};
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) out[key] = clonePlain(value[key]);
  }
  return out;
}

const uniqueStrings = (ids, command) => {
  if (!Array.isArray(ids)) throw fail("MODEL_INVALID_ARGUMENT", { command, argument: "ids" });
  return [...new Set(ids.filter((id) => typeof id === "string"))];
};

/**
 * The download name of the document, without extension: trimmed, NFC, ".pdf" removed, characters that no
 * file system accepts replaced by "-", at most 150 characters.
 */
export function normalizeFileName(name) {
  let text = String(name ?? "").normalize("NFC");
  text = Array.from(text, (char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("");
  text = text.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
  text = text.replace(/\.pdf$/i, "").trim();
  return text.slice(0, 150).trim();
}

const emptyState = () => deepFreeze({ fileName: "", sources: {}, pages: [], objects: {}, assets: {} });

/**
 * @param {object} [options]
 * @param {(object: object) => { w: number, h: number }} [options.measureText]  laid-out size of a text object in points
 * @param {() => number} [options.now]            clock in milliseconds (tests)
 * @param {number} [options.historyLimit]         undo steps kept (default 200)
 * @param {number} [options.coalesceWindow]       milliseconds within which updates with the same coalesceKey merge (default 500)
 */
export function createEditorStore({ measureText = null, now = defaultNow, historyLimit = HISTORY_LIMIT, coalesceWindow = COALESCE_WINDOW_MS } = {}) {
  let state = emptyState();
  let measure = typeof measureText === "function" ? measureText : null;
  let undoStack = []; // { doc } : the document BEFORE the step
  let redoStack = []; // { doc } : the document AFTER the undone step
  let savedDoc = docOf(state);
  let lastCoalesce = null; // { key, time } of the newest step when it may still absorb an update
  let open = null; // the running transaction (or the setup of reset): { base, depth }
  let historyState = null;
  const listeners = new Set();
  const sourceTable = new Map(); // id -> { bytes, password, pages: [{ view, rotate, userUnit }] }
  const assetTable = new Map(); // id -> bytes
  const unused = { sources: new Set(), assets: new Set() }; // registered, never referenced yet: not collected
  const sourceRefs = new WeakMap(); // pages array -> Set of source ids
  const assetRefs = new WeakMap(); // objects map -> Set of asset ids

  function docOf(value) {
    return { fileName: value.fileName, pages: value.pages, objects: value.objects };
  }

  const sameDoc = (a, b) => a.fileName === b.fileName && a.pages === b.pages && a.objects === b.objects;

  function seal(next) {
    Object.freeze(next.pages);
    Object.freeze(next.objects);
    Object.freeze(next.sources);
    Object.freeze(next.assets);
    return Object.freeze(next);
  }

  // --- notifications ---

  function emit() {
    let failure = null;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        failure = failure || error;
      }
    }
    if (failure) throw failure;
  }

  // --- resources that the document and its history still need ---

  function sourcesOfPages(pages) {
    let refs = sourceRefs.get(pages);
    if (!refs) {
      refs = new Set();
      for (const page of pages) if (page.kind === "pdf") refs.add(page.sourceId);
      sourceRefs.set(pages, refs);
    }
    return refs;
  }

  function assetsOfObjects(objects) {
    let refs = assetRefs.get(objects);
    if (!refs) {
      refs = new Set();
      for (const id of Object.keys(objects)) if (objects[id].type === "image") refs.add(objects[id].assetId);
      assetRefs.set(objects, refs);
    }
    return refs;
  }

  function neededResources() {
    const sources = new Set();
    const assets = new Set();
    const visit = (doc) => {
      for (const id of sourcesOfPages(doc.pages)) sources.add(id);
      for (const id of assetsOfObjects(doc.objects)) assets.add(id);
    };
    visit(state);
    for (const entry of undoStack) visit(entry.doc);
    for (const entry of redoStack) visit(entry.doc);
    return { sources, assets };
  }

  /** Drops the sources and assets that nothing can bring back; returns the state without them. */
  function collect(current) {
    const needed = neededResources();
    let sources = current.sources;
    let assets = current.assets;
    for (const id of Object.keys(current.sources)) {
      if (needed.sources.has(id) || unused.sources.has(id)) continue;
      if (sources === current.sources) sources = { ...current.sources };
      delete sources[id];
      sourceTable.delete(id);
    }
    for (const id of Object.keys(current.assets)) {
      if (needed.assets.has(id) || unused.assets.has(id)) continue;
      if (assets === current.assets) assets = { ...current.assets };
      delete assets[id];
      assetTable.delete(id);
    }
    return sources === current.sources && assets === current.assets ? current : seal({ ...current, sources, assets });
  }

  function markUsed(doc) {
    if (unused.sources.size) for (const id of sourcesOfPages(doc.pages)) unused.sources.delete(id);
    if (unused.assets.size) for (const id of assetsOfObjects(doc.objects)) unused.assets.delete(id);
  }

  /** After a rollback: forget the bytes of entries that are no longer registered. */
  function syncTables() {
    for (const id of [...sourceTable.keys()]) {
      if (!state.sources[id]) {
        sourceTable.delete(id);
        unused.sources.delete(id);
      }
    }
    for (const id of [...assetTable.keys()]) {
      if (!state.assets[id]) {
        assetTable.delete(id);
        unused.assets.delete(id);
      }
    }
  }

  // --- committing ---

  /** Makes `after` the state: one undo step when the document (not only a registry) changed. */
  function finish(before, after, { coalesceKey = null } = {}) {
    if (after === before) return;
    const changed = !sameDoc(before, after);
    let dropped = false;
    if (changed) {
      const time = now();
      const merge = coalesceKey !== null && coalesceKey !== undefined && lastCoalesce && lastCoalesce.key === coalesceKey && time - lastCoalesce.time <= coalesceWindow && undoStack.length > 0;
      if (!merge) {
        undoStack.push({ doc: docOf(before) });
        if (undoStack.length > historyLimit) {
          undoStack.splice(0, undoStack.length - historyLimit);
          dropped = true;
        }
      }
      if (redoStack.length) {
        redoStack = [];
        dropped = true;
      }
      lastCoalesce = coalesceKey !== null && coalesceKey !== undefined ? { key: coalesceKey, time } : null;
    }
    state = after;
    if (changed) markUsed(after);
    if (dropped) state = collect(state);
    emit();
  }

  /** Called by every command with the next state. */
  function commit(next, options) {
    const sealed = seal(next);
    if (open) {
      state = sealed;
      return;
    }
    finish(state, sealed, options);
  }

  const refuseInTransaction = (command) => {
    if (open) throw fail("MODEL_INVALID_CALL", { command, reason: "transaction" }, `${command}() cannot run inside a transaction`);
  };

  function transaction(fn, options = {}) {
    if (typeof fn !== "function") throw fail("MODEL_INVALID_ARGUMENT", { command: "transaction", argument: "fn" });
    if (open) {
      // nested: part of the outer step; a failure undoes only what the inner function did
      const savepoint = state;
      open.depth += 1;
      try {
        const result = fn(api);
        if (result && typeof result.then === "function") throw fail("MODEL_TRANSACTION_ASYNC");
        return result;
      } catch (error) {
        state = savepoint;
        syncTables();
        throw error;
      } finally {
        open.depth -= 1;
      }
    }
    const base = state;
    open = { base, depth: 1 };
    let result;
    try {
      result = fn(api);
      if (result && typeof result.then === "function") throw fail("MODEL_TRANSACTION_ASYNC");
    } catch (error) {
      state = base;
      open = null;
      syncTables();
      throw error;
    }
    open = null;
    const after = state;
    state = base;
    finish(base, after, { coalesceKey: options.coalesceKey ?? null });
    return result;
  }

  // --- objects: what enters the state ---

  const pageOf = (pageId) => state.pages.find((page) => page.id === pageId) || null;

  function measuredFrame(object, page) {
    const size = measure(Object.freeze({ ...object }));
    if (!size || !finite(size.w) || !finite(size.h) || size.w < 0 || size.h < 0) {
      throw fail("MODEL_INVALID_OBJECT", { id: object.id, type: object.type, problems: ["measure"] }, "measureText must return { w, h } in points");
    }
    const w = object.autoWidth ? size.w : object.frame.w;
    const h = size.h;
    if (w === object.frame.w && h === object.frame.h) return object.frame;
    const anchor = object.align === "center" ? 0.5 : object.align === "right" ? 1 : 0;
    return resizeFrame(object.frame, w, h, [anchor, 0], page.userUnit || 1);
  }

  function needsMeasure(object, previous) {
    if (!previous || previous.type !== "text") return true;
    if (TEXT_LAYOUT_KEYS.some((key) => object[key] !== previous[key])) return true;
    return object.frame.w !== previous.frame.w || object.frame.h !== previous.frame.h;
  }

  /**
   * Normalises, validates, measures and clamps one object. `candidate` is a private copy (its top level may be
   * changed here); `previous` is the object it replaces, if any. Returns the frozen object for the state.
   */
  function prepareObject(candidate, page, previous) {
    const object = candidate;
    for (const key of COLOR_KEYS) {
      if (typeof object[key] === "string") object[key] = normalizeColor(object[key]) ?? object[key];
    }
    // Values that are already in their normal form keep their identity: an untouched frame stays `===`.
    if (object.frame && typeof object.frame === "object" && finite(object.frame.rot)) {
      const rot = normalizeAngle(object.frame.rot);
      if (rot !== object.frame.rot) object.frame = { ...object.frame, rot };
    }
    if (isMark(object) && isFiniteRect(object.rect) && !isNormalRect(object.rect)) object.rect = normalizeRect(object.rect);
    // Every blur mark carries the seed of its mosaic from the moment it enters the document (undo and redo
    // keep it): repeated exports then show the same mosaic instead of fresh noise each time. A COPY of a mark
    // (duplicateObjects, a paste) comes here without a seed and gets its own: the same noise over other
    // content could be subtracted by whoever sees both pictures. Only a duplicated PAGE keeps the seeds of its
    // marks (duplicatePages): there the content under the mark is the same, so the same picture tells nothing
    // new, while a second seed would be a second sample of the same content.
    if (object.type === "blur" && object.seed === undefined) object.seed = createSeed();
    if (object.type === "text") {
      // The canonical form of text-box content (line breaks, tabs, invisible characters, NFC): the same
      // function the text editor applies, so text from any other producer (paste, "Edit text" of a line
      // of the document, code) stays real text in the export instead of becoming a picture. Idempotent.
      if (typeof object.text === "string") object.text = normalizeText(object.text);
      if (finite(object.size)) object.size = quantizeFontSize(object.size);
      const { replaces } = object;
      if (replaces && typeof replaces === "object") {
        const cover = typeof replaces.cover === "string" ? normalizeColor(replaces.cover) ?? replaces.cover : replaces.cover;
        const rect = isFiniteRect(replaces.rect) && !isNormalRect(replaces.rect) ? normalizeRect(replaces.rect) : replaces.rect;
        if (cover !== replaces.cover || rect !== replaces.rect) object.replaces = { ...replaces, cover, rect };
      }
    }
    const problems = validateObject(object);
    // A geometry property of another type (a `frame` patched onto a line, a `rect` on a rectangle shape)
    // would silently change how the object is placed, hit and exported.
    const own = GEOMETRY_KEYS[object.type === "highlight" ? `highlight:${object.mode}` : object.type];
    if (own) for (const key of ALL_GEOMETRY_KEYS) if (object[key] !== undefined && !own.includes(key)) problems.push(`unexpected ${key}`);
    if (problems.length) throw fail("MODEL_INVALID_OBJECT", { id: object.id, type: object.type, problems }, problems.join(", "));
    if (object.type === "image" && !state.assets[object.assetId]) throw fail("MODEL_UNKNOWN_ASSET", { assetId: object.assetId });
    if (object.type === "text" && measure && needsMeasure(object, previous)) object.frame = measuredFrame(object, page);
    return deepFreeze(clampObjectToPage(object, page));
  }

  /** Puts an id on a page's stack: a mark on top of the marks, anything else on top of everything. */
  function stackOnto(stack, object, objects) {
    if (!isMark(object)) {
      stack.push(object.id);
      return;
    }
    let index = 0;
    while (index < stack.length && isMark(objects[stack[index]])) index += 1;
    stack.splice(index, 0, object.id);
  }

  const withStacks = (pages, stacks) => (stacks.size ? pages.map((page) => (stacks.has(page.id) ? deepFreeze({ ...page, objectIds: stacks.get(page.id) }) : page)) : pages);

  function addObjects(inputs) {
    if (!Array.isArray(inputs)) throw fail("MODEL_INVALID_ARGUMENT", { command: "addObjects", argument: "objects" });
    if (!inputs.length) return [];
    const objects = { ...state.objects };
    const stacks = new Map();
    const ids = [];
    for (const input of inputs) {
      if (!input || typeof input !== "object") throw fail("MODEL_INVALID_OBJECT", { id: undefined, type: undefined, problems: ["not an object"] });
      const candidate = clonePlain(input);
      if (candidate.id === undefined) candidate.id = createId("o");
      if (typeof candidate.id === "string" && Object.hasOwn(objects, candidate.id)) throw fail("MODEL_DUPLICATE_ID", { id: candidate.id });
      const page = typeof candidate.pageId === "string" ? pageOf(candidate.pageId) : null;
      if (!page) throw fail("MODEL_UNKNOWN_PAGE", { pageId: candidate.pageId });
      const object = prepareObject(candidate, page, null);
      objects[object.id] = object;
      if (!stacks.has(page.id)) stacks.set(page.id, page.objectIds.slice());
      stackOnto(stacks.get(page.id), object, objects);
      ids.push(object.id);
    }
    commit({ ...state, pages: withStacks(state.pages, stacks), objects });
    return ids;
  }

  function updateObjects(updates, options = {}) {
    if (!Array.isArray(updates)) throw fail("MODEL_INVALID_ARGUMENT", { command: "updateObjects", argument: "updates" });
    let objects = null;
    const changed = [];
    for (const update of updates) {
      if (!update || typeof update.id !== "string" || !update.patch || typeof update.patch !== "object") {
        throw fail("MODEL_INVALID_ARGUMENT", { command: "updateObjects", argument: "updates" }, "every update is { id, patch }");
      }
      const current = (objects || state.objects)[update.id];
      if (!current) continue;
      for (const key of FIXED_KEYS) {
        if (update.patch[key] !== undefined && update.patch[key] !== current[key]) throw fail("MODEL_INVALID_PATCH", { id: current.id, field: key });
      }
      const candidate = { ...current };
      for (const key of Object.keys(update.patch)) {
        if (update.patch[key] === undefined) delete candidate[key];
        else candidate[key] = clonePlain(update.patch[key]);
      }
      const next = prepareObject(candidate, pageOf(current.pageId), current);
      if (deepEqual(next, current)) continue;
      objects = objects || { ...state.objects };
      objects[next.id] = next;
      if (!changed.includes(next.id)) changed.push(next.id);
    }
    if (!objects) return [];
    commit({ ...state, objects }, { coalesceKey: options.coalesceKey ?? null });
    return changed;
  }

  function deleteObjects(ids) {
    const remove = new Set(uniqueStrings(ids, "deleteObjects").filter((id) => state.objects[id]));
    if (!remove.size) return [];
    const objects = {};
    for (const id of Object.keys(state.objects)) if (!remove.has(id)) objects[id] = state.objects[id];
    const pages = state.pages.map((page) => (page.objectIds.some((id) => remove.has(id)) ? deepFreeze({ ...page, objectIds: page.objectIds.filter((id) => !remove.has(id)) }) : page));
    commit({ ...state, pages, objects });
    return [...remove];
  }

  /** The ids of `wanted` that exist, in page order and bottom -> top within a page. */
  function inStackOrder(wanted) {
    const set = new Set(wanted);
    const out = [];
    for (const page of state.pages) for (const id of page.objectIds) if (set.has(id)) out.push(id);
    return out;
  }

  function moveObjectsToPage(ids, pageId, place = "keep") {
    const target = pageOf(pageId);
    if (!target) throw fail("MODEL_UNKNOWN_PAGE", { pageId });
    const moving = inStackOrder(uniqueStrings(ids, "moveObjectsToPage")).filter((id) => state.objects[id].pageId !== target.id);
    if (!moving.length) return [];
    const placed = placeOnPage(moving.map((id) => ({ object: state.objects[id], fromPage: pageOf(state.objects[id].pageId) })), target, place);
    const objects = { ...state.objects };
    const stacks = new Map([[target.id, target.objectIds.slice()]]);
    const leaving = new Set(moving);
    for (const page of state.pages) {
      if (page.id !== target.id && page.objectIds.some((id) => leaving.has(id))) stacks.set(page.id, page.objectIds.filter((id) => !leaving.has(id)));
    }
    for (const moved of placed) {
      const candidate = { ...moved };
      delete candidate.replaces; // the line it replaced stays on the page it came from
      const object = prepareObject(candidate, target, state.objects[moved.id]);
      objects[object.id] = object;
      stackOnto(stacks.get(target.id), object, objects);
    }
    commit({ ...state, pages: withStacks(state.pages, stacks), objects });
    return moving;
  }

  function arrange(ids, direction) {
    if (!ARRANGE_DIRECTIONS.includes(direction)) throw fail("MODEL_INVALID_ARGUMENT", { command: "arrange", argument: "direction" });
    const wanted = new Set(uniqueStrings(ids, "arrange"));
    const selected = (id) => wanted.has(id);
    let changed = false;
    const pages = state.pages.map((page) => {
      if (!page.objectIds.some(selected)) return page;
      const marks = page.objectIds.filter((id) => isMark(state.objects[id]));
      const others = page.objectIds.filter((id) => !isMark(state.objects[id]));
      let next = others.slice();
      if (direction === "front") next = [...others.filter((id) => !selected(id)), ...others.filter(selected)];
      else if (direction === "back") next = [...others.filter(selected), ...others.filter((id) => !selected(id))];
      else if (direction === "forward") {
        for (let index = next.length - 2; index >= 0; index -= 1) {
          if (selected(next[index]) && !selected(next[index + 1])) [next[index], next[index + 1]] = [next[index + 1], next[index]];
        }
      } else {
        for (let index = 1; index < next.length; index += 1) {
          if (selected(next[index]) && !selected(next[index - 1])) [next[index], next[index - 1]] = [next[index - 1], next[index]];
        }
      }
      if (next.every((id, index) => id === others[index])) return page;
      changed = true;
      return deepFreeze({ ...page, objectIds: [...marks, ...next] });
    });
    if (!changed) return false;
    commit({ ...state, pages });
    return true;
  }

  function duplicateObjects(ids, offset = DUPLICATE_OFFSET) {
    if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(finite)) throw fail("MODEL_INVALID_ARGUMENT", { command: "duplicateObjects", argument: "offset" });
    const wanted = uniqueStrings(ids, "duplicateObjects").filter((id) => state.objects[id] && isMovable(state.objects[id]));
    if (!wanted.length) return [];
    const wantedSet = new Set(wanted);
    const objects = { ...state.objects };
    const stacks = new Map();
    const copyOf = new Map();
    for (const page of state.pages) {
      const originals = page.objectIds.filter((id) => wantedSet.has(id));
      if (!originals.length) continue;
      const [dx, dy] = pageScreen(page).deltaToUser(offset);
      const stack = page.objectIds.slice();
      for (const id of originals) {
        const original = state.objects[id];
        const candidate = { ...original, ...translatePatch(original, dx, dy), id: createId("o") };
        delete candidate.replaces; // a copy is an ordinary text box: only the original replaces the line
        delete candidate.seed; // a copied blur mark covers other content: it gets a seed of its own (prepareObject)
        const copy = prepareObject(candidate, page, original);
        objects[copy.id] = copy;
        stackOnto(stack, copy, objects);
        copyOf.set(id, copy.id);
      }
      stacks.set(page.id, stack);
    }
    commit({ ...state, pages: withStacks(state.pages, stacks), objects });
    return wanted.map((id) => copyOf.get(id));
  }

  // --- pages and sources ---

  function pageRecord(input) {
    const blank = input?.kind === "blank";
    const record = {
      id: input?.id === undefined ? createId("p") : input.id,
      kind: input?.kind,
      sourceId: blank ? null : input?.sourceId,
      sourceIndex: blank ? null : input?.sourceIndex,
      view: Array.isArray(input?.view) ? input.view.slice() : input?.view,
      baseRotation: input?.baseRotation ?? 0,
      userUnit: input?.userUnit ?? 1,
      rotation: input?.rotation ?? 0,
      objectIds: []
    };
    const problems = validatePage(record, state.sources);
    if (problems.includes("unknown source")) throw fail("MODEL_UNKNOWN_SOURCE", { sourceId: record.sourceId });
    if (problems.length) throw fail("MODEL_INVALID_PAGE", { problems }, problems.join(", "));
    return record;
  }

  const insertionIndex = (index, length) => (index === undefined || index === null ? length : Math.max(0, Math.min(length, Math.trunc(Number(index)) || 0)));

  function insertPages(pages, index) {
    if (!Array.isArray(pages)) throw fail("MODEL_INVALID_ARGUMENT", { command: "insertPages", argument: "pages" });
    if (!pages.length) return [];
    const taken = new Set(state.pages.map((page) => page.id));
    const records = pages.map((input) => {
      const record = pageRecord(input);
      if (taken.has(record.id)) throw fail("MODEL_DUPLICATE_ID", { id: record.id });
      taken.add(record.id);
      return deepFreeze(record);
    });
    const at = insertionIndex(index, state.pages.length);
    commit({ ...state, pages: [...state.pages.slice(0, at), ...records, ...state.pages.slice(at)] });
    return records.map((record) => record.id);
  }

  function insertBlankPage(index, size) {
    const width = Array.isArray(size) ? size[0] : NaN;
    const height = Array.isArray(size) ? size[1] : NaN;
    const valid = (value) => finite(value) && value >= PAGE_SIZE_LIMITS.min && value <= PAGE_SIZE_LIMITS.max;
    if (!valid(width) || !valid(height)) throw fail("MODEL_INVALID_PAGE_SIZE", { width, height });
    return insertPages([{ kind: "blank", view: [0, 0, width, height] }], index)[0];
  }

  function deletePages(pageIds) {
    const remove = new Set(uniqueStrings(pageIds, "deletePages").filter((id) => pageOf(id)));
    if (!remove.size) return [];
    if (remove.size >= state.pages.length) throw fail("MODEL_LAST_PAGE", {}, "a document needs at least one page");
    const gone = new Set();
    for (const page of state.pages) if (remove.has(page.id)) for (const id of page.objectIds) gone.add(id);
    let objects = state.objects;
    if (gone.size) {
      objects = {};
      for (const id of Object.keys(state.objects)) if (!gone.has(id)) objects[id] = state.objects[id];
    }
    const deleted = state.pages.filter((page) => remove.has(page.id)).map((page) => page.id);
    commit({ ...state, pages: state.pages.filter((page) => !remove.has(page.id)), objects });
    return deleted;
  }

  function movePages(pageIds, toIndex) {
    if (!finite(toIndex)) throw fail("MODEL_INVALID_ARGUMENT", { command: "movePages", argument: "toIndex" });
    const wanted = new Set(uniqueStrings(pageIds, "movePages"));
    const moving = state.pages.filter((page) => wanted.has(page.id));
    if (!moving.length) return false;
    const rest = state.pages.filter((page) => !wanted.has(page.id));
    const at = insertionIndex(toIndex, rest.length);
    const pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (pages.every((page, index) => page === state.pages[index])) return false;
    commit({ ...state, pages });
    return true;
  }

  function duplicatePages(pageIds) {
    const wanted = new Set(uniqueStrings(pageIds, "duplicatePages").filter((id) => pageOf(id)));
    if (!wanted.size) return [];
    const objects = { ...state.objects };
    const pages = [];
    const created = [];
    for (const page of state.pages) {
      pages.push(page);
      if (!wanted.has(page.id)) continue;
      const id = createId("p");
      const objectIds = page.objectIds.map((objectId) => {
        // the copy shows the same source page, so a replaced line is replaced on it as well, and a blur mark
        // keeps its seed: the same content under the same mark gives the same mosaic on both pages
        const copy = deepFreeze({ ...state.objects[objectId], id: createId("o"), pageId: id });
        objects[copy.id] = copy;
        return copy.id;
      });
      pages.push(deepFreeze({ ...page, id, objectIds }));
      created.push(id);
    }
    commit({ ...state, pages, objects });
    return created;
  }

  function rotatePages(pageIds, delta) {
    if (!finite(delta) || delta % 90 !== 0) throw fail("MODEL_INVALID_ROTATION", { delta });
    const turn = normalizeRightAngle(delta);
    const wanted = new Set(uniqueStrings(pageIds, "rotatePages").filter((id) => pageOf(id)));
    if (!wanted.size || turn === 0) return [];
    const pages = state.pages.map((page) => (wanted.has(page.id) ? deepFreeze({ ...page, rotation: normalizeRightAngle(page.rotation + turn) }) : page));
    commit({ ...state, pages });
    return state.pages.filter((page) => wanted.has(page.id)).map((page) => page.id);
  }

  function setFileName(name) {
    const fileName = normalizeFileName(name);
    if (fileName === state.fileName) return false;
    commit({ ...state, fileName });
    return true;
  }

  function addSource(facts, bytes, { password, name, id: wantedId } = {}) {
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    const problems = [];
    if (wantedId !== undefined && (typeof wantedId !== "string" || !wantedId)) problems.push("id");
    if (typeof wantedId === "string" && state.sources[wantedId]) throw fail("MODEL_DUPLICATE_ID", { id: wantedId });
    if (!(data instanceof Uint8Array) || data.byteLength === 0) problems.push("bytes");
    if (!facts || typeof facts !== "object") problems.push("facts");
    const pageCount = facts?.pageCount;
    if (!Number.isInteger(pageCount) || pageCount < 1) problems.push("pageCount");
    const pages = Array.isArray(facts?.pages) ? facts.pages : null;
    if (!pages || pages.length !== pageCount) problems.push("pages");
    const pageFacts = (pages || []).map((page, index) => {
      const view = page?.view;
      const userUnit = page?.userUnit === undefined || page?.userUnit === null ? 1 : page.userUnit;
      if (!isFiniteRect(view) || !(view[2] > view[0]) || !(view[3] > view[1])) problems.push(`pages[${index}].view`);
      if (!finite(userUnit) || !(userUnit > 0)) problems.push(`pages[${index}].userUnit`);
      return { view: isFiniteRect(view) ? view.slice() : view, rotate: normalizeRightAngle(page?.rotate), userUnit };
    });
    if (problems.length) throw fail("MODEL_INVALID_SOURCE", { problems }, problems.join(", "));
    const info = {};
    for (const key of INFO_KEYS) {
      const value = facts.info?.[key] ?? facts.info?.[key[0].toUpperCase() + key.slice(1)];
      if (typeof value === "string" && value) info[key] = value;
    }
    // signatures that exist (signed fields) when the viewer can tell them from empty signature fields
    const signatures = Number.isInteger(facts.signatureCount) ? facts.signatureCount : facts.signatureFieldCount;
    // the viewer opens a file under an id before its facts exist: the caller may bring that id along
    const id = wantedId || createId("s");
    const record = deepFreeze({
      id,
      name: String(name ?? facts.name ?? ""),
      byteLength: data.byteLength,
      pageCount,
      encrypted: Boolean(facts.encrypted),
      signatureCount: Number.isInteger(signatures) && signatures > 0 ? signatures : 0,
      info
    });
    sourceTable.set(id, { bytes: data, password: typeof password === "string" ? password : undefined, pages: deepFreeze(pageFacts) });
    unused.sources.add(id);
    commit({ ...state, sources: { ...state.sources, [id]: record } });
    return id;
  }

  function pagesOfSource(sourceId, indices) {
    const entry = sourceTable.get(sourceId);
    if (!entry || !state.sources[sourceId]) throw fail("MODEL_UNKNOWN_SOURCE", { sourceId });
    const list = indices === undefined ? entry.pages.map((_, index) => index) : indices;
    if (!Array.isArray(list)) throw fail("MODEL_INVALID_ARGUMENT", { command: "pagesOfSource", argument: "indices" });
    return list.map((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= entry.pages.length) throw fail("MODEL_INVALID_ARGUMENT", { command: "pagesOfSource", argument: "indices" });
      const facts = entry.pages[index];
      return { id: createId("p"), kind: "pdf", sourceId, sourceIndex: index, view: facts.view.slice(), baseRotation: facts.rotate, userUnit: facts.userUnit, rotation: 0, objectIds: [] };
    });
  }

  function discardSource(sourceId) {
    refuseInTransaction("discardSource");
    if (!state.sources[sourceId] || neededResources().sources.has(sourceId)) return false;
    unused.sources.delete(sourceId);
    sourceTable.delete(sourceId);
    const sources = { ...state.sources };
    delete sources[sourceId];
    finish(state, seal({ ...state, sources }));
    return true;
  }

  // --- assets ---

  function sameBytes(a, b) {
    if (a.byteLength !== b.byteLength) return false;
    for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
    return true;
  }

  function addAsset(meta, bytes) {
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    const problems = [];
    if (!(data instanceof Uint8Array) || data.byteLength === 0) problems.push("bytes");
    if (!ASSET_MIME_TYPES.includes(meta?.mime)) problems.push("mime");
    if (!Number.isInteger(meta?.width) || meta.width < 1) problems.push("width");
    if (!Number.isInteger(meta?.height) || meta.height < 1) problems.push("height");
    if (problems.length) throw fail("MODEL_INVALID_ASSET", { problems }, problems.join(", "));
    // the same picture placed again (a saved signature on every page) is stored and exported once
    for (const asset of Object.values(state.assets)) {
      if (asset.mime !== meta.mime || asset.width !== meta.width || asset.height !== meta.height || asset.byteLength !== data.byteLength) continue;
      const known = assetTable.get(asset.id);
      if (known && sameBytes(known, data)) {
        // it may be referenced by nothing but the history right now: keep it until the caller has used it
        unused.assets.add(asset.id);
        return asset.id;
      }
    }
    const id = createId("a");
    assetTable.set(id, data);
    unused.assets.add(id);
    commit({ ...state, assets: { ...state.assets, [id]: deepFreeze({ id, mime: meta.mime, width: meta.width, height: meta.height, byteLength: data.byteLength }) } });
    return id;
  }

  function discardAsset(assetId) {
    refuseInTransaction("discardAsset");
    if (!state.assets[assetId] || neededResources().assets.has(assetId)) return false;
    unused.assets.delete(assetId);
    assetTable.delete(assetId);
    const assets = { ...state.assets };
    delete assets[assetId];
    finish(state, seal({ ...state, assets }));
    return true;
  }

  // --- history ---

  function undo() {
    refuseInTransaction("undo");
    const entry = undoStack.pop();
    if (!entry) return false;
    redoStack.push({ doc: docOf(state) });
    state = seal({ ...state, ...entry.doc });
    lastCoalesce = null;
    emit();
    return true;
  }

  function redo() {
    refuseInTransaction("redo");
    const entry = redoStack.pop();
    if (!entry) return false;
    undoStack.push({ doc: docOf(state) });
    state = seal({ ...state, ...entry.doc });
    lastCoalesce = null;
    emit();
    return true;
  }

  function clearHistory() {
    refuseInTransaction("clearHistory");
    if (!undoStack.length && !redoStack.length) return;
    undoStack = [];
    redoStack = [];
    lastCoalesce = null;
    state = collect(state);
    emit();
  }

  function reset(setup) {
    refuseInTransaction("reset");
    const wipe = () => {
      state = emptyState();
      undoStack = [];
      redoStack = [];
      lastCoalesce = null;
      sourceTable.clear();
      assetTable.clear();
      unused.sources.clear();
      unused.assets.clear();
    };
    wipe();
    if (typeof setup === "function") {
      open = { base: state, depth: 1 };
      try {
        const result = setup(api);
        if (result && typeof result.then === "function") throw fail("MODEL_TRANSACTION_ASYNC");
      } catch (error) {
        open = null;
        wipe();
        savedDoc = docOf(state);
        emit();
        throw error;
      }
      open = null;
      markUsed(state);
    }
    savedDoc = docOf(state);
    emit();
  }

  function markSaved() {
    const dirty = isDirty();
    savedDoc = docOf(state);
    lastCoalesce = null;
    if (dirty) emit();
  }

  // only what would be lost counts: pages and objects (a new download name is not unsaved work)
  const isDirty = () => state.pages !== savedDoc.pages || state.objects !== savedDoc.objects;

  function getHistoryState() {
    const next = { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoDepth: undoStack.length, redoDepth: redoStack.length, dirty: isDirty() };
    if (!historyState || Object.keys(next).some((key) => next[key] !== historyState[key])) historyState = Object.freeze(next);
    return historyState;
  }

  const api = {
    // state
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // sources and pages
    addSource,
    discardSource,
    pagesOfSource,
    insertPages,
    insertBlankPage,
    deletePages,
    movePages,
    duplicatePages,
    rotatePages,
    setFileName,
    getSourceBytes: (sourceId) => sourceTable.get(sourceId)?.bytes ?? null,
    getSourcePassword: (sourceId) => sourceTable.get(sourceId)?.password,
    // objects
    addObjects,
    updateObjects,
    deleteObjects,
    moveObjectsToPage,
    arrange,
    duplicateObjects,
    // assets
    addAsset,
    discardAsset,
    getAssetBytes: (assetId) => assetTable.get(assetId) ?? null,
    // history
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    transaction,
    clearHistory,
    reset,
    getHistoryState,
    // saving
    markSaved,
    isDirty,
    isPristine: () => pristineSourceId(state) !== null,
    pristineSourceId: () => pristineSourceId(state),
    // text
    setMeasureText(fn) {
      measure = typeof fn === "function" ? fn : null;
    },
    hasMeasureText: () => Boolean(measure)
  };
  return api;
}
