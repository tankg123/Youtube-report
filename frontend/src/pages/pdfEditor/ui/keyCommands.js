// From a keyboard event to a command: the one dispatcher of the editor (UX specification 12). Pure functions
// over tools/keymap.js; the shell feeds them with what it reads from the DOM (tests/pdfUiKeyCommands.test.mjs).
//
// Who runs a shortcut, in this order (the first one that handles it wins):
//   1. the features: manifest.commands[id](editor, { id, scope, keyEvent, phase }) returning true
//   2. the kernel: KERNEL_COMMANDS[id] (file, history, view, panels) and the tool keys (actions.setTool)
//   3. the interaction reducer: the ids of REDUCER_SHORTCUTS (Escape cascade, Delete, Enter / F2, Space held),
//      only while the keyboard belongs to the pages (scopes viewer, selection, text)
// Everything else (nudging, arranging, clipboard, text formatting, the organiser keys) exists only as a
// feature command: without a feature that answers it the key does nothing.
//
// Where the keyboard focus is decides what a key may do (keyContext):
//   an open dialog or menu          nothing: they have their own keys
//   the editor's own text box       scope "text"
//   the search field                scope "search"
//   another text field or select    only the shortcuts that work everywhere (Ctrl+S, Ctrl+F, zoom ...), not Escape
//   a button, tab, slider ...       everything except the keys such a control needs itself (Space, Enter,
//                                   arrows, Home, End)
//   the pages, or nothing at all    scope "viewer" / "selection" (or "organiser" while that view is open)
import { REDUCER_SHORTCUTS } from "../tools/interaction.js";
import { SCOPES, comboFromEvent, matchShortcut, overridesBrowser, scopeFor, shortcutById } from "../tools/keymap.js";
import { toolById } from "../tools/registry.js";

/** Scopes in which the reducer of tools/interaction.js gets keys. */
const REDUCER_SCOPES = Object.freeze(["viewer", "selection", "text"]);
const TOOL_PREFIX = "tool:";
const CONTROL_KEYS = new Set(["Space", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/** The shortcuts the kernel runs itself: id -> (editor, event) => handled. */
export const KERNEL_COMMANDS = Object.freeze({
  // document
  open: ({ actions }) => actions.openFilePicker("open"),
  download: ({ actions }) => {
    actions.download();
    return true;
  },
  print: ({ actions }) => {
    actions.print();
    return true;
  },
  // history
  undo: ({ actions }) => {
    actions.undo();
    return true;
  },
  redo: ({ actions }) => {
    actions.redo();
    return true;
  },
  // search
  search: ({ actions }) => actions.openSearch(),
  findNext: ({ actions }) => actions.findNext(),
  findPrevious: ({ actions }) => actions.findPrevious(),
  findNextInField: ({ actions }) => actions.findNext(),
  findPreviousInField: ({ actions }) => actions.findPrevious(),
  // zoom
  zoomIn: ({ actions }) => actions.zoomIn(),
  zoomOut: ({ actions }) => actions.zoomOut(),
  zoomAuto: ({ actions }) => actions.zoomAuto(),
  actualSize: ({ actions }) => actions.setZoom("actual"),
  fitWidth: ({ actions }) => actions.setZoom("fit-width"),
  fitPage: ({ actions }) => actions.setZoom("fit-page"),
  // pages
  previousPage: ({ actions }) => actions.previousPage(),
  nextPage: ({ actions }) => actions.nextPage(),
  firstPage: ({ actions }) => actions.firstPage(),
  lastPage: ({ actions }) => actions.lastPage(),
  goToPage: ({ actions }) => actions.focusElement("pageNumber"),
  // shell
  toggleLeftPanel: ({ actions }) => actions.toggleLeftPanel(),
  fullScreen: ({ actions }) => actions.toggleFullScreen(),
  focusToolbar: ({ actions }) => actions.focusElement("toolbar"),
  organise: ({ actions }) => actions.toggleView("organiser"),
  shortcuts: ({ actions }) => actions.openKernelDialog("shortcuts")
});

/**
 * Where a shortcut id goes when no feature takes it.
 * @returns {{ kind: "kernel" } | { kind: "tool", tool: string } | { kind: "interaction" } | { kind: "feature" }}
 */
export function routeOf(id) {
  if (typeof id !== "string") return { kind: "feature" };
  if (id.startsWith(TOOL_PREFIX)) return toolById(id.slice(TOOL_PREFIX.length)) ? { kind: "tool", tool: id.slice(TOOL_PREFIX.length) } : { kind: "feature" };
  if (Object.hasOwn(KERNEL_COMMANDS, id)) return { kind: "kernel" };
  if (REDUCER_SHORTCUTS.includes(id)) return { kind: "interaction" };
  return { kind: "feature" };
}

/**
 * Runs a command by its id: from a key (the dispatcher), a menu or a button.
 * @param {object} editor   the editor context: { actions, ui, features }
 * @param {string} id       a shortcut id of tools/keymap.js (or any command id a feature registered)
 * @param {{ scope?: string, keyEvent?: object | null, phase?: "down" | "up" }} [details]  anything else in it
 *        (the files of "openImages", a page id ...) reaches the feature commands as part of their `event`
 * @returns {boolean} true when somebody handled it
 */
export function runCommand(editor, id, details = {}) {
  const event = { scope: "viewer", keyEvent: null, phase: "down", ...details, id };
  const { scope, phase } = event;
  if (phase !== "up") {
    for (const command of editor.features?.commands?.[id] || []) {
      if (command(editor, event) === true) return true;
    }
  }
  const route = routeOf(id);
  if (route.kind === "tool") {
    if (phase === "up") return false;
    editor.actions.setTool(route.tool);
    return true;
  }
  if (route.kind === "kernel") {
    if (phase === "up") return false;
    return KERNEL_COMMANDS[id](editor, event) !== false;
  }
  if (route.kind === "interaction") {
    if (!REDUCER_SCOPES.includes(scope)) {
      // a full-screen view (the organiser) has the keyboard: Escape leaves it, the rest is not ours
      if (id === "escape" && phase !== "up" && editor.ui.getState().view) return editor.ui.closeView();
      return false;
    }
    editor.ui.runInteraction({ type: "shortcut", id, phase });
    return true;
  }
  return false;
}

/**
 * What a key may do for an event target, or null when the dispatcher must not look at the key at all.
 * @param {object} target  what the shell read from the DOM:
 *        inDialog   inside an open dialog or menu, or a modal dialog is open
 *        scopeHint  the nearest data-pdfx-scope: "search" | "organiser" | "text" | "none" | null
 *        textBox    inside the editor's own text box (text/TextEditor.jsx)
 *        field      another input, textarea, select or editable element
 *        control    a focused control of the chrome (button, tab, slider ...) outside the page area
 * @param {{ selectionCount?: number, view?: string | null }} [facts]
 * @returns {{ scope: "viewer" | "selection" | "text" | "organiser" | "search" | "field", control: boolean } | null}
 *          scope "field" = a text field that is not ours; control = the keys of isControlCombo() stay with the target
 */
export function keyContext({ inDialog = false, scopeHint = null, textBox = false, field = false, control = false } = {}, { selectionCount = 0, view = null } = {}) {
  if (inDialog || scopeHint === "none") return null;
  if (scopeHint === "search") return { scope: "search", control: false };
  if (textBox || scopeHint === "text") return { scope: "text", control: false };
  if (field) return { scope: "field", control: false };
  const scope = scopeFor({ organiser: scopeHint === "organiser" || view === "organiser", selectionCount });
  // a region that asked for a scope by name gets all of its keys
  return { scope, control: Boolean(control) && !scopeHint };
}

/** True for a combo a focused button, tab, slider or check box needs itself: Space, Enter, arrows, Home, End (also with Shift). */
export function isControlCombo(combo) {
  return CONTROL_KEYS.has(String(combo ?? "").replace(/^Shift\+/, ""));
}

const isEverywhere = (id) => shortcutById(id)?.scopes.length === SCOPES.length;

/**
 * Resolves a key event to a shortcut.
 * @param {object} keyEvent   a KeyboardEvent (or an object like one)
 * @param {{ scope: string, control?: boolean } | null} context   result of keyContext()
 * @param {{ mac?: boolean, singleKeys?: boolean }} [options]
 * @returns {{ id: string, scope: string, combo: string, preventDefault: boolean } | null}
 *          preventDefault: the combo replaces something the browser does (keymap.js OVERRIDDEN_BROWSER)
 */
export function resolveKey(keyEvent, context, { mac = false, singleKeys = true } = {}) {
  if (!context?.scope) return null;
  const { scope, control = false } = context;
  // In a text field of the chrome only the shortcuts that work everywhere apply; Escape stays with the field.
  const id = matchShortcut(keyEvent, scope === "field" ? "search" : scope, { mac, singleKeys });
  if (!id) return null;
  if (scope === "field" && (!isEverywhere(id) || id === "escape")) return null;
  const combo = comboFromEvent(keyEvent, { mac });
  if (control && isControlCombo(combo)) return null;
  return { id, scope, combo, preventDefault: overridesBrowser(combo) };
}
