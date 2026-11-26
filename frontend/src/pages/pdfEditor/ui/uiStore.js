// The UI store of the PDF editor: everything the interface remembers that is NOT part of the undoable
// document (model/store.js). No DOM, no React: it runs under `node --test` (tests/pdfUiStore.test.mjs).
//
//   const ui = createUiStore({ getContext });
//   const state = useSyncExternalStore(ui.subscribe, ui.getState);
//
// State (immutable: a change replaces the state object and the slices it touched, everything else keeps its
// identity, so `===` tells what changed):
//   layout        "wide" (1200 px and more) | "medium" (900 to 1199) | "narrow": set by the shell from the window.
//                 Leaving "wide" closes the left panel and an unpinned properties panel (below 1200 px they lie
//                 over the pages); coming back to "wide" opens the properties panel again.
//   interaction   the state of tools/interaction.js: { tool, toolLocked, mode, selection, gesture, editingId,
//                 spaceHeld }. Changed ONLY through runInteraction(event).
//   pointerMode   null (the kernel decides from the interaction state: pointerModeFor) | "text" | "overlay" | "none"
//   leftPanel     id of the open left panel (a key of the manifests' `panels`), or null
//   inspector     { open, pinned }: the properties panel
//   view          id of the full-screen view that replaces the page area ("organiser" ...), or null
//   dialogs       the dialog stack: [{ key, id, props }], the last one is on top
//   drawer        null | { id, props }: shown in place of the properties panel
//   toasts        [{ id, message, tone, undo: boolean, actionLabel }]
//   notices       [{ id, tone, code, params, text, textParams, scope, dismissible }]: banners under the tool bar
//   job           null | { id, titleKey, progress (0..1 | null), stage (code | null), detail, cancellable }
//   toolDefaults  { [creation kind]: style }: what the properties panel set for the next object of a tool
//   preferences   { singleKeys, lastShape }: kept in localStorage
//   flags         per document: { editable, viewOnly, signedEditConfirmed, restricted (the author of a file in
//                 use limited changes), restrictedEditConfirmed, savedAs }
//   search        { open, query, options: { matchCase, wholeWord, matchDiacritics }, focusToken }
//   autoZoom      true while the zoom follows "Automatic" (fit width, at most 125 %)
//   openError     null | { fileName, code, params }: why the last file could not be opened (the empty page
//                 area shows it)
//   features      a free bag per feature: { [featureId]: anything }
//
// Functions kept in the state (toast undo callbacks, dialog props) never reach localStorage.
import { CREATION_KINDS, objectTypeOfKind, sanitizeStyle, styleFor } from "../model/transform.js";
import { initialState as initialInteraction, step } from "../tools/interaction.js";
import { toolsOfMenu } from "../tools/registry.js";

export const TOOL_DEFAULTS_KEY = "pdfx.toolDefaults.v1";
export const PREFERENCES_KEY = "pdfx.preferences.v1";
export const POINTER_MODES = Object.freeze(["text", "overlay", "none"]);
export const LAYOUTS = Object.freeze(["wide", "medium", "narrow"]);
/** The layout of a window width in CSS pixels (UX specification 3.1 to 3.3). */
export const layoutForWidth = (width) => (width >= 1200 ? "wide" : width >= 900 ? "medium" : "narrow");
export const TOAST_TONES = Object.freeze(["info", "success", "warning", "error"]);
export const NOTICE_TONES = Object.freeze(["info", "warning", "error"]);
/** How long a toast stays (milliseconds): with an Undo action, plain, an error. */
export const TOAST_DURATIONS = Object.freeze({ undo: 6000, plain: 4000, error: 8000 });
export const MAX_TOASTS = 4;

/** Interaction modes in which an object of the overlay is being dragged: the overlay then owns the pointer. */
const OVERLAY_GESTURES = Object.freeze(["moving", "resizing", "rotating", "marquee", "drawing", "erasing", "placing", "editingText"]);

/**
 * Who gets the pointer on a page (the `pointer` prop of viewer/ViewerPages.jsx) for an interaction state:
 *   "none"     Hand, or Space held: the pointer drags the page area
 *   "text"     Select while nothing is being dragged: document text can be selected, links work, and the
 *              overlay still gets the pointer on its own objects (elements with data-object-id)
 *   "overlay"  every other tool, and Select while a gesture runs
 * A feature that knows better (Highlighter over document text) overrides it with ui.setPointerMode().
 */
export function pointerModeFor(interaction) {
  if (!interaction) return "text";
  if (interaction.mode === "panning" || interaction.spaceHeld || interaction.tool === "hand") return "none";
  if (interaction.tool === "select") return OVERLAY_GESTURES.includes(interaction.mode) ? "overlay" : "text";
  return "overlay";
}

const SHAPE_TOOLS = toolsOfMenu("shapes").map((tool) => tool.id);
const DEFAULT_PREFERENCES = Object.freeze({ singleKeys: true, lastShape: SHAPE_TOOLS[0] || "rect" });
const DEFAULT_FLAGS = Object.freeze({ editable: "unknown", viewOnly: null, signedEditConfirmed: false, restricted: false, restrictedEditConfirmed: false, savedAs: null });
const DEFAULT_SEARCH = Object.freeze({ open: false, query: "", options: Object.freeze({ matchCase: false, wholeWord: false, matchDiacritics: false }), focusToken: 0 });
const EDITABLE_STATES = ["unknown", "checking", "yes", "no"];
const SAVED_STATES = [null, "downloaded", "signed"];

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // storage switched off (private mode, a sandboxed frame)
  }
}

function readJson(storage, key) {
  try {
    const raw = storage?.getItem(key);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota or no storage: the value lasts for this page only
  }
}

/** The tool defaults that survive the checks of model/transform.js: what localStorage holds is never trusted. */
export function readToolDefaults(storage) {
  const raw = readJson(storage, TOOL_DEFAULTS_KEY);
  const out = {};
  for (const kind of CREATION_KINDS) {
    const clean = sanitizeStyle(objectTypeOfKind(kind), raw[kind]);
    if (Object.keys(clean).length) out[kind] = Object.freeze(clean);
  }
  return Object.freeze(out);
}

export function readPreferences(storage) {
  const raw = readJson(storage, PREFERENCES_KEY);
  return Object.freeze({
    singleKeys: typeof raw.singleKeys === "boolean" ? raw.singleKeys : DEFAULT_PREFERENCES.singleKeys,
    lastShape: SHAPE_TOOLS.includes(raw.lastShape) ? raw.lastShape : DEFAULT_PREFERENCES.lastShape
  });
}

/**
 * @param {object} [options]
 * @param {Storage | null} [options.storage]   where tool defaults and preferences are kept (default: localStorage)
 * @param {() => { objectType?: Function, objectExists?: Function }} [options.getContext]  the `ctx` of the
 *        interaction reducer, read from the document store at every event
 * @param {(error: unknown) => void} [options.onError]  an effect executor threw
 * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]  for tests
 */
export function createUiStore({ storage = defaultStorage(), getContext = () => ({}), onError = null, timers = globalThis } = {}) {
  let state = Object.freeze({
    layout: "wide",
    interaction: initialInteraction(),
    pointerMode: null,
    leftPanel: null,
    inspector: Object.freeze({ open: true, pinned: false }),
    view: null,
    dialogs: Object.freeze([]),
    drawer: null,
    toasts: Object.freeze([]),
    notices: Object.freeze([]),
    job: null,
    toolDefaults: readToolDefaults(storage),
    preferences: readPreferences(storage),
    flags: DEFAULT_FLAGS,
    search: DEFAULT_SEARCH,
    autoZoom: true,
    openError: null,
    features: Object.freeze({})
  });
  const listeners = new Set();
  const dialogResolvers = new Map(); // dialog key -> resolve of showDialog()
  const toastExtras = new Map(); // toast id -> { onUndo, timer }
  const pseudoObjects = new Map(); // "$id" -> type: things the reducer selects that are not in the document
  const queue = [];
  let draining = false;
  let executor = null;
  let seed = 0;
  const nextId = (prefix) => `${prefix}${(seed += 1)}`;

  function set(patch) {
    let changed = false;
    for (const key of Object.keys(patch)) if (patch[key] !== state[key]) changed = true;
    if (!changed) return false;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
    return true;
  }

  // --- interaction ------------------------------------------------------------------------------------------

  function context() {
    const base = getContext() || {};
    return {
      objectType: (id) => (pseudoObjects.has(id) ? pseudoObjects.get(id) : base.objectType?.(id)),
      objectExists: (id) => pseudoObjects.has(id) || Boolean(base.objectExists?.(id))
    };
  }

  /**
   * Runs one event through the reducer of tools/interaction.js and hands the effects to the effect executor.
   * Events sent while another one is being worked on (a store command inside an executor notifies
   * "documentChanged", an executor answers "created") are queued and run in order right after it.
   * @returns {{ state: object, effects: object[] } | null} what the reducer answered for THIS event; null when
   *          the event was queued behind a running one
   */
  function runInteraction(event) {
    queue.push(event);
    if (draining) return null;
    draining = true;
    let first = null;
    try {
      while (queue.length) {
        const next = queue.shift();
        const result = step(state.interaction, next, context());
        if (first === null) first = result;
        set({ interaction: result.state });
        if (result.effects.length && executor) {
          try {
            executor(result.effects, next);
          } catch (error) {
            // one failed command must not leave later events stuck in the queue
            if (onError) onError(error);
            else throw error;
          }
        }
      }
    } finally {
      draining = false;
      queue.length = 0;
    }
    return first;
  }

  /** The one function that receives the effects of the reducer: (effects, event) => void. */
  function setEffectExecutor(fn) {
    executor = typeof fn === "function" ? fn : null;
  }

  /**
   * Something the reducer may select or edit that is not an object of the document (the rectangle of a visible
   * certificate signature: "$signatureField"). While registered, `documentChanged` keeps it in the selection.
   * @returns {() => void} unregisters it
   */
  function registerPseudoObject(id, type) {
    pseudoObjects.set(id, type);
    return () => {
      if (pseudoObjects.get(id) === type) pseudoObjects.delete(id);
    };
  }

  /** Overrides who gets the pointer on a page; null gives the decision back to pointerModeFor(). */
  function setPointerMode(mode) {
    return set({ pointerMode: POINTER_MODES.includes(mode) ? mode : null });
  }

  /** The pointer mode in force: the override of a feature, else what the interaction state asks for. */
  const getPointerMode = () => state.pointerMode || pointerModeFor(state.interaction);

  // --- panels, views, drawer -----------------------------------------------------------------------------------

  function setLayout(layout) {
    if (!LAYOUTS.includes(layout) || layout === state.layout) return false;
    const patch = { layout };
    if (layout === "wide") {
      if (!state.inspector.open) patch.inspector = Object.freeze({ ...state.inspector, open: true });
    } else if (state.layout === "wide") {
      // below 1200 px the panels lie over the pages: they do not stay open by themselves
      patch.leftPanel = null;
      if (state.inspector.open && !state.inspector.pinned) patch.inspector = Object.freeze({ ...state.inspector, open: false });
    }
    return set(patch);
  }

  const openLeftPanel = (id) => set({ leftPanel: typeof id === "string" && id ? id : null });
  const closeLeftPanel = () => set({ leftPanel: null });
  /** A click on a rail tab: opens that panel, or closes it when it is the open one. */
  const toggleLeftPanel = (id) => set({ leftPanel: state.leftPanel === id || !id ? null : id });

  const setInspector = (patch) => {
    const next = { open: typeof patch?.open === "boolean" ? patch.open : state.inspector.open, pinned: typeof patch?.pinned === "boolean" ? patch.pinned : state.inspector.pinned };
    if (next.open === state.inspector.open && next.pinned === state.inspector.pinned) return false;
    return set({ inspector: Object.freeze(next) });
  };
  const toggleInspector = () => setInspector({ open: !state.inspector.open });

  const openView = (id) => set({ view: typeof id === "string" && id ? id : null });
  const closeView = () => set({ view: null });

  const openDrawer = (id, props = {}) => set({ drawer: Object.freeze({ id, props }) });
  const closeDrawer = () => set({ drawer: null });

  // --- dialogs -------------------------------------------------------------------------------------------------

  /** Puts a dialog on top of the stack. @returns {string} its key, for updateDialog / closeDialog */
  function openDialog(id, props = {}) {
    const key = nextId("d");
    set({ dialogs: Object.freeze([...state.dialogs, Object.freeze({ key, id, props })]) });
    return key;
  }

  /** openDialog that resolves with what the dialog hands to its onClose (undefined when it is just closed). */
  function showDialog(id, props = {}) {
    return new Promise((resolve) => {
      const key = openDialog(id, props);
      dialogResolvers.set(key, resolve);
    });
  }

  /** Merges new props into an open dialog (a wrong password keeps the same dialog open). */
  function updateDialog(key, patch) {
    if (!state.dialogs.some((dialog) => dialog.key === key)) return false;
    return set({ dialogs: Object.freeze(state.dialogs.map((dialog) => (dialog.key === key ? Object.freeze({ ...dialog, props: { ...dialog.props, ...patch } }) : dialog))) });
  }

  /** Closes the dialog with this key (or the top one with this id). */
  function closeDialog(keyOrId, result) {
    const index = state.dialogs.findLastIndex((dialog) => dialog.key === keyOrId || dialog.id === keyOrId);
    if (index < 0) return false;
    const { key } = state.dialogs[index];
    set({ dialogs: Object.freeze(state.dialogs.filter((dialog) => dialog.key !== key)) });
    const resolve = dialogResolvers.get(key);
    dialogResolvers.delete(key);
    resolve?.(result);
    return true;
  }

  function closeAllDialogs() {
    for (const dialog of [...state.dialogs].reverse()) closeDialog(dialog.key);
  }

  // --- toasts ------------------------------------------------------------------------------------------------

  function dismissToast(id) {
    const extra = toastExtras.get(id);
    if (extra) timers.clearTimeout(extra.timer);
    toastExtras.delete(id);
    return set({ toasts: Object.freeze(state.toasts.filter((toast) => toast.id !== id)) });
  }

  /**
   * @param {{ message: string, tone?: string, onUndo?: () => void, actionLabel?: string, duration?: number }} toast
   *        message: the sentence, already translated. onUndo: shows an Undo button that calls it once.
   * @returns {string} the toast id
   */
  function addToast({ message, tone = "info", onUndo = null, actionLabel = null, duration } = {}) {
    const id = nextId("t");
    const kind = TOAST_TONES.includes(tone) ? tone : "info";
    const stay = Number.isFinite(duration) ? duration : typeof onUndo === "function" ? TOAST_DURATIONS.undo : kind === "error" ? TOAST_DURATIONS.error : TOAST_DURATIONS.plain;
    const entry = Object.freeze({ id, message: String(message ?? ""), tone: kind, undo: typeof onUndo === "function", actionLabel });
    let toasts = [...state.toasts, entry];
    while (toasts.length > MAX_TOASTS) {
      const [oldest] = toasts;
      const extra = toastExtras.get(oldest.id);
      if (extra) timers.clearTimeout(extra.timer);
      toastExtras.delete(oldest.id);
      toasts = toasts.slice(1);
    }
    toastExtras.set(id, { onUndo: typeof onUndo === "function" ? onUndo : null, timer: stay > 0 ? timers.setTimeout(() => dismissToast(id), stay) : null });
    set({ toasts: Object.freeze(toasts) });
    return id;
  }

  /** The Undo button of a toast: runs its callback once and removes the toast. */
  function undoToast(id) {
    const extra = toastExtras.get(id);
    dismissToast(id);
    if (!extra?.onUndo) return false;
    extra.onUndo();
    return true;
  }

  // --- notices (banners) -----------------------------------------------------------------------------------

  /**
   * @param {{ tone?: string, code?: string, params?: object, text?: string, textParams?: object, scope?: string,
   *           dismissible?: boolean, id?: string }} notice
   *        code + params: rendered through messages.js; text (a tk() key) + textParams: rendered with t().
   *        scope "document" (default) notices go away with the document, "session" ones stay.
   *        A notice with the id of an existing one replaces it.
   */
  function addNotice({ id = nextId("n"), tone = "info", code = null, params = null, text = null, textParams = null, scope = "document", dismissible = true } = {}) {
    const entry = Object.freeze({ id, tone: NOTICE_TONES.includes(tone) ? tone : "info", code, params, text, textParams, scope, dismissible });
    const same = (other) => other.code === entry.code && other.text === entry.text && JSON.stringify(other.params) === JSON.stringify(entry.params) && JSON.stringify(other.textParams) === JSON.stringify(entry.textParams);
    if (state.notices.some((other) => other.id !== id && same(other))) return id; // said once
    set({ notices: Object.freeze([...state.notices.filter((other) => other.id !== id), entry]) });
    return id;
  }

  const dismissNotice = (id) => set({ notices: Object.freeze(state.notices.filter((notice) => notice.id !== id)) });
  const clearNotices = (scope = "document") => set({ notices: Object.freeze(state.notices.filter((notice) => notice.scope !== scope)) });

  // --- the running job ---------------------------------------------------------------------------------------

  function setJob(job) {
    if (!job) return set({ job: null });
    return set({
      job: Object.freeze({
        id: job.id,
        titleKey: job.titleKey,
        progress: Number.isFinite(job.progress) ? Math.min(1, Math.max(0, job.progress)) : null,
        stage: job.stage ?? null,
        detail: String(job.detail ?? ""),
        cancellable: Boolean(job.cancellable)
      })
    });
  }

  // --- tool defaults and preferences --------------------------------------------------------------------------

  /** The remembered style of a tool (a creation kind of model/transform.js), possibly {}. */
  const getToolDefaults = (kind) => state.toolDefaults[kind] || {};

  /** The complete style of the next object a tool creates: OBJECT_DEFAULTS, the kind's own, then the defaults. */
  const getToolStyle = (kind) => styleFor(kind, state.toolDefaults[kind]);

  /**
   * Remembers style properties for the next object of a tool. Values pass sanitizeStyle of
   * model/transform.js: an unknown key or an invalid value is dropped and the old value stays.
   * @returns {boolean} true when something changed
   */
  function setToolDefaults(kind, patch) {
    if (!CREATION_KINDS.includes(kind)) return false;
    const clean = sanitizeStyle(objectTypeOfKind(kind), patch);
    const current = state.toolDefaults[kind] || {};
    if (!Object.keys(clean).some((key) => clean[key] !== current[key])) return false;
    const toolDefaults = Object.freeze({ ...state.toolDefaults, [kind]: Object.freeze({ ...current, ...clean }) });
    set({ toolDefaults });
    writeJson(storage, TOOL_DEFAULTS_KEY, toolDefaults);
    return true;
  }

  /** Forgets the defaults of one tool, or of all tools. */
  function resetToolDefaults(kind) {
    const toolDefaults = { ...state.toolDefaults };
    if (kind === undefined) for (const key of Object.keys(toolDefaults)) delete toolDefaults[key];
    else delete toolDefaults[kind];
    const changed = set({ toolDefaults: Object.freeze(toolDefaults) });
    if (changed) writeJson(storage, TOOL_DEFAULTS_KEY, toolDefaults);
    return changed;
  }

  function setPreference(key, value) {
    if (key === "singleKeys" && typeof value !== "boolean") return false;
    if (key === "lastShape" && !SHAPE_TOOLS.includes(value)) return false;
    if (!Object.hasOwn(DEFAULT_PREFERENCES, key) || state.preferences[key] === value) return false;
    const preferences = Object.freeze({ ...state.preferences, [key]: value });
    set({ preferences });
    writeJson(storage, PREFERENCES_KEY, preferences);
    return true;
  }

  // --- flags of the document, search, feature bags -------------------------------------------------------------

  function setFlags(patch) {
    const next = { ...state.flags };
    if (patch.editable !== undefined && EDITABLE_STATES.includes(patch.editable)) next.editable = patch.editable;
    if (patch.viewOnly !== undefined) next.viewOnly = patch.viewOnly ? Object.freeze({ code: String(patch.viewOnly.code), params: patch.viewOnly.params || {} }) : null;
    if (patch.signedEditConfirmed !== undefined) next.signedEditConfirmed = Boolean(patch.signedEditConfirmed);
    if (patch.restricted !== undefined) next.restricted = Boolean(patch.restricted);
    if (patch.restrictedEditConfirmed !== undefined) next.restrictedEditConfirmed = Boolean(patch.restrictedEditConfirmed);
    if (patch.savedAs !== undefined && SAVED_STATES.includes(patch.savedAs)) next.savedAs = patch.savedAs;
    if (Object.keys(next).every((key) => next[key] === state.flags[key])) return false;
    return set({ flags: Object.freeze(next) });
  }

  function setSearch(patch) {
    const options = patch.options ? Object.freeze({ ...state.search.options, ...Object.fromEntries(Object.entries(patch.options).filter(([key]) => key in DEFAULT_SEARCH.options).map(([key, value]) => [key, Boolean(value)])) }) : state.search.options;
    const sameOptions = Object.keys(options).every((key) => options[key] === state.search.options[key]);
    const next = {
      open: typeof patch.open === "boolean" ? patch.open : state.search.open,
      query: typeof patch.query === "string" ? patch.query : state.search.query,
      options: sameOptions ? state.search.options : options,
      // `focus: true` asks the search field to take the keyboard (Ctrl+F), also when it is open already
      focusToken: patch.focus ? state.search.focusToken + 1 : state.search.focusToken
    };
    if (next.open === state.search.open && next.query === state.search.query && sameOptions && next.focusToken === state.search.focusToken) return false;
    return set({ search: Object.freeze(next) });
  }

  const setAutoZoom = (value) => set({ autoZoom: Boolean(value) });

  /** Why the last file could not be opened: { fileName, code, params }, or null to forget it. */
  const setOpenError = (error) => set({ openError: error ? Object.freeze({ fileName: String(error.fileName ?? ""), code: String(error.code), params: error.params || {} }) : null });

  const getFeatureState = (featureId) => state.features[featureId];

  /** Replaces the bag of a feature: a value, or (previous) => next. The kernel never looks inside. */
  function setFeatureState(featureId, value) {
    const previous = state.features[featureId];
    const next = typeof value === "function" ? value(previous) : value;
    if (next === previous) return false;
    return set({ features: Object.freeze({ ...state.features, [featureId]: next }) });
  }

  /**
   * A new document replaced the old one (or it was closed): back to the Select tool with nothing selected,
   * no drawer, no full-screen view, the per-document flags and notices gone. Dialogs, toasts, panels, tool
   * defaults, preferences and the feature bags stay.
   */
  function resetForDocument() {
    queue.length = 0;
    set({ interaction: initialInteraction(), pointerMode: null, view: null, drawer: null, flags: DEFAULT_FLAGS, notices: Object.freeze(state.notices.filter((notice) => notice.scope !== "document")) });
  }

  /** Stops the timers (unmount). The store stays usable. */
  function dispose() {
    for (const extra of toastExtras.values()) if (extra.timer !== null) timers.clearTimeout(extra.timer);
    toastExtras.clear();
    set({ toasts: Object.freeze([]) });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // interaction
    runInteraction,
    setEffectExecutor,
    registerPseudoObject,
    setPointerMode,
    getPointerMode,
    // panels, views, drawer
    setLayout,
    openLeftPanel,
    closeLeftPanel,
    toggleLeftPanel,
    setInspector,
    toggleInspector,
    openView,
    closeView,
    openDrawer,
    closeDrawer,
    // dialogs
    openDialog,
    showDialog,
    updateDialog,
    closeDialog,
    closeAllDialogs,
    // toasts and notices
    addToast,
    dismissToast,
    undoToast,
    addNotice,
    dismissNotice,
    clearNotices,
    // job
    setJob,
    // tool defaults and preferences
    getToolDefaults,
    getToolStyle,
    setToolDefaults,
    resetToolDefaults,
    setPreference,
    // flags, search, feature bags
    setFlags,
    setSearch,
    setAutoZoom,
    setOpenError,
    getFeatureState,
    setFeatureState,
    resetForDocument,
    dispose
  };
}
