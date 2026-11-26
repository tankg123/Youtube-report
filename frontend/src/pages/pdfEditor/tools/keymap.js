// Keyboard map of the PDF editor: the complete shortcut table, the browser keys it must never take and the
// ones it takes over on purpose, a conflict finder and the matcher for key events. Pure data and pure
// functions (no DOM): it runs under `node --test`.
//
// Combos are written for Windows / Linux: "Ctrl+Shift+Z". On macOS "Ctrl" means the Command key.
// Scopes (where the keyboard focus is):
//   viewer     page area focused, no object selected
//   selection  one or more added objects selected
//   text       caret inside a text box (typing)
//   organiser  page organiser grid or thumbnail list focused
//   search     search field focused
// `single: true` marks single-key shortcuts: no Ctrl / Alt, never active while typing, never on auto-repeat,
// and switched off as a group by the "Single-key shortcuts" preference (WCAG 2.1.4).
//
// Vietnamese input methods (Unikey / EVKey in Telex mode) shape two rules that tests enforce:
//   * no single key is W, [ or ] (Telex turns them into letters on their own)
//   * Backspace never deletes on Windows and Linux (Telex sends Backspace to rewrite the previous letter);
//     only macOS, where the Delete key IS Backspace, accepts it.
//
// Labels are canonical English texts marked with tk(): render them with t(shortcut.label).
import { tk } from "../../../i18n/index.js";
import { TOOLS } from "./registry.js";

export const SCOPES = Object.freeze(["viewer", "selection", "text", "organiser", "search"]);
const NOT_TYPING = ["viewer", "selection", "organiser"];
const EVERYWHERE = [...SCOPES];
const CANVAS = ["viewer", "selection"];

/** What the keyboard help calls each scope. */
export const SCOPE_LABELS = Object.freeze({
  viewer: tk("Page area"),
  selection: tk("Selected objects"),
  text: tk("While typing"),
  organiser: tk("Page organiser"),
  search: tk("Search field")
});

/** The groups of the keyboard help, in display order. */
export const SHORTCUT_SECTIONS = Object.freeze([
  Object.freeze({ id: "file", label: tk("Document") }),
  Object.freeze({ id: "edit", label: tk("Editing") }),
  Object.freeze({ id: "objects", label: tk("Objects") }),
  Object.freeze({ id: "text", label: tk("Text") }),
  Object.freeze({ id: "tools", label: tk("Tools") }),
  Object.freeze({ id: "view", label: tk("View") }),
  Object.freeze({ id: "pages", label: tk("Pages") })
]);

const shortcut = (id, label, keys, scopes, extra = {}) => Object.freeze({ id, label, keys: Object.freeze(keys), scopes: Object.freeze(scopes), single: false, hold: false, ...extra });

export const SHORTCUTS = Object.freeze([
  // --- document
  shortcut("open", tk("Open"), ["Ctrl+O"], EVERYWHERE, { section: "file" }),
  shortcut("download", tk("Download"), ["Ctrl+S"], EVERYWHERE, { section: "file" }),
  shortcut("print", tk("Print"), ["Ctrl+P"], EVERYWHERE, { section: "file" }),

  // --- editing
  shortcut("undo", tk("Undo"), ["Ctrl+Z"], NOT_TYPING, { section: "edit" }),
  shortcut("redo", tk("Redo"), ["Ctrl+Y", "Ctrl+Shift+Z"], NOT_TYPING, { section: "edit" }),
  shortcut("copy", tk("Copy"), ["Ctrl+C"], NOT_TYPING, { section: "edit" }),
  shortcut("cut", tk("Cut"), ["Ctrl+X"], ["selection", "organiser"], { section: "edit" }),
  shortcut("paste", tk("Paste"), ["Ctrl+V"], NOT_TYPING, { section: "edit" }),
  shortcut("duplicate", tk("Duplicate the selection"), ["Ctrl+D"], ["selection", "organiser"], { section: "edit" }),
  shortcut("selectAll", tk("Select all"), ["Ctrl+A"], NOT_TYPING, { section: "edit" }),
  shortcut("delete", tk("Delete"), ["Delete"], ["selection", "organiser"], { section: "edit", macAlso: Object.freeze(["Backspace"]) }),
  shortcut("escape", tk("Cancel / deselect / back to Select"), ["Escape"], EVERYWHERE, { section: "edit" }),

  // --- selected objects
  shortcut("editObject", tk("Edit the text of the selected box"), ["Enter", "F2"], ["selection"], { section: "objects" }),
  shortcut("nudge", tk("Move by 1 pt"), ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], ["selection"], { section: "objects" }),
  shortcut("nudgeBig", tk("Move by 10 pt"), ["Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"], ["selection"], { section: "objects" }),
  shortcut("bringForward", tk("Bring forward"), ["Ctrl+ArrowUp"], ["selection"], { section: "objects" }),
  shortcut("sendBackward", tk("Send backward"), ["Ctrl+ArrowDown"], ["selection"], { section: "objects" }),
  shortcut("bringToFront", tk("Bring to front"), ["Ctrl+Shift+ArrowUp"], ["selection"], { section: "objects" }),
  shortcut("sendToBack", tk("Send to back"), ["Ctrl+Shift+ArrowDown"], ["selection"], { section: "objects" }),

  // --- text editing
  shortcut("bold", tk("Bold"), ["Ctrl+B"], ["text"], { section: "text" }),
  shortcut("italic", tk("Italic"), ["Ctrl+I"], ["text"], { section: "text" }),
  shortcut("underline", tk("Underline"), ["Ctrl+U"], ["text"], { section: "text" }),
  shortcut("biggerText", tk("Increase font size"), ["Ctrl+Shift+."], ["text"], { section: "text" }),
  shortcut("smallerText", tk("Decrease font size"), ["Ctrl+Shift+,"], ["text"], { section: "text" }),
  shortcut("commitText", tk("Finish editing"), ["Ctrl+Enter"], ["text"], { section: "text" }),

  // --- tools (single keys), generated from the tool registry
  ...TOOLS.map((tool) => shortcut(`tool:${tool.id}`, tool.label, [tool.key], CANVAS, { section: "tools", single: true })),
  shortcut("tempHand", tk("Pan while held"), ["Space"], CANVAS, { section: "tools", single: true, hold: true }),

  // --- view
  shortcut("search", tk("Search"), ["Ctrl+F"], EVERYWHERE, { section: "view" }),
  shortcut("findNext", tk("Next result"), ["Ctrl+G", "F3"], EVERYWHERE, { section: "view" }),
  shortcut("findPrevious", tk("Previous result"), ["Ctrl+Shift+G", "Shift+F3"], EVERYWHERE, { section: "view" }),
  shortcut("findNextInField", tk("Next result"), ["Enter"], ["search"], { section: "view" }),
  shortcut("findPreviousInField", tk("Previous result"), ["Shift+Enter"], ["search"], { section: "view" }),
  shortcut("zoomIn", tk("Zoom in"), ["Ctrl+=", "Ctrl++"], EVERYWHERE, { section: "view" }),
  shortcut("zoomOut", tk("Zoom out"), ["Ctrl+-"], EVERYWHERE, { section: "view" }),
  shortcut("zoomAuto", tk("Automatic zoom"), ["Ctrl+0"], EVERYWHERE, { section: "view" }),
  shortcut("actualSize", tk("Actual size"), ["1"], CANVAS, { section: "view", single: true }),
  shortcut("fitWidth", tk("Fit width"), ["2"], CANVAS, { section: "view", single: true }),
  shortcut("fitPage", tk("Fit page"), ["3"], CANVAS, { section: "view", single: true }),
  shortcut("previousPage", tk("Previous page"), ["ArrowLeft"], ["viewer"], { section: "view" }),
  shortcut("nextPage", tk("Next page"), ["ArrowRight"], ["viewer"], { section: "view" }),
  shortcut("firstPage", tk("First page"), ["Home"], ["viewer"], { section: "view" }),
  shortcut("lastPage", tk("Last page"), ["End"], ["viewer"], { section: "view" }),
  shortcut("goToPage", tk("Go to page"), ["Ctrl+Alt+G"], EVERYWHERE, { section: "view" }),
  shortcut("rotateView", tk("Rotate view"), ["Shift+R"], CANVAS, { section: "view", single: true }),
  shortcut("toggleLeftPanel", tk("Toggle side panel"), ["F4"], EVERYWHERE, { section: "view" }),
  shortcut("fullScreen", tk("Full screen"), ["Ctrl+Alt+P"], EVERYWHERE, { section: "view" }),
  shortcut("organise", tk("Organise pages"), ["G"], NOT_TYPING, { section: "view", single: true }),
  shortcut("shortcuts", tk("Keyboard shortcuts"), ["Shift+/"], NOT_TYPING, { section: "view", single: true }),
  shortcut("focusToolbar", tk("Move focus to the tool bar"), ["Alt+F10"], EVERYWHERE, { section: "view" }),

  // --- page organiser
  shortcut("pageToggle", tk("Select / deselect the focused page"), ["Space"], ["organiser"], { section: "pages" }),
  shortcut("pageExtend", tk("Extend the selection"), ["Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"], ["organiser"], { section: "pages" }),
  shortcut("pageFocus", tk("Move focus between pages"), ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], ["organiser"], { section: "pages" }),
  shortcut("pageEarlier", tk("Move selected pages earlier"), ["Ctrl+Shift+ArrowLeft"], ["organiser"], { section: "pages" }),
  shortcut("pageLater", tk("Move selected pages later"), ["Ctrl+Shift+ArrowRight"], ["organiser"], { section: "pages" }),
  shortcut("pageRotateCw", tk("Rotate clockwise"), ["R"], ["organiser"], { section: "pages", single: true }),
  shortcut("pageRotateCcw", tk("Rotate counterclockwise"), ["Shift+R"], ["organiser"], { section: "pages", single: true }),
  shortcut("pageOpen", tk("Open the focused page"), ["Enter"], ["organiser"], { section: "pages" })
]);

// Browser shortcuts that a page must never rely on: several cannot be intercepted at all and the rest are
// too deeply learned to take away. Source: Chrome help, "Chrome keyboard shortcuts"
// (https://support.google.com/chrome/answer/157179, read 2026-11-15), plus the DevTools keys.
export const RESERVED_BROWSER = Object.freeze([
  "Ctrl+N", "Ctrl+Shift+N", "Ctrl+T", "Ctrl+Shift+T", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+PageDown", "Ctrl+PageUp",
  "Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6", "Ctrl+7", "Ctrl+8", "Ctrl+9",
  "Alt+Home", "Alt+ArrowLeft", "Alt+ArrowRight", "Ctrl+W", "Ctrl+F4", "Ctrl+Shift+W", "Alt+F4",
  "Ctrl+Shift+PageUp", "Ctrl+Shift+PageDown", "F11", "Alt+F", "Alt+E", "Ctrl+Shift+B", "Ctrl+Shift+O",
  "Ctrl+H", "Ctrl+J", "Shift+Escape", "Alt+Shift+T", "F10", "F6", "Ctrl+Shift+J", "Ctrl+Shift+I", "F12",
  "Ctrl+Shift+Delete", "F1", "Ctrl+Shift+M", "Alt+Shift+I", "F7", "Ctrl+F6", "Alt+Shift+A", "Alt+Shift+N",
  "Ctrl+L", "Alt+D", "Ctrl+K", "Ctrl+E", "Ctrl+F5", "F5", "Ctrl+R", "Shift+F5", "Ctrl+Shift+R", "Ctrl+Shift+D"
]);

// Browser shortcuts the editor deliberately takes over (the same choice pdf.js and Apryse WebViewer make):
// combo -> why (English, for developers). The key handler calls preventDefault() for exactly these when a
// shortcut matched. A test fails for an override that is not listed here.
export const OVERRIDDEN_BROWSER = Object.freeze({
  "Ctrl+O": "open a PDF in the editor, not navigate the tab to a file",
  "Ctrl+S": "download the edited PDF, not save the HTML page",
  "Ctrl+P": "print the document, not the application chrome",
  "Ctrl+F": "search the document text; the browser find bar cannot see unrendered pages",
  "F3": "next search result (pairs with Ctrl+F)",
  "Shift+F3": "previous search result",
  "Ctrl+G": "next search result",
  "Ctrl+Shift+G": "previous search result",
  "Ctrl+D": "duplicate the selection (only while an object or page is selected)",
  "Ctrl+U": "underline (only while typing in a text box)",
  "Ctrl+=": "zoom the document, not the application chrome",
  "Ctrl++": "zoom the document, not the application chrome",
  "Ctrl+-": "zoom the document, not the application chrome",
  "Ctrl+0": "reset the document zoom",
  "Space": "pan while held / toggle a page (only while the page area or organiser has focus)",
  "Home": "first page (only while the page area has focus)",
  "End": "last page (only while the page area has focus)"
});

// Keys that produce a character on their own with the Telex input method (Unikey, EVKey, the built-in
// Windows Vietnamese Telex keyboard): w, [ and ] become letters with a horn. Never use them as single keys.
export const TELEX_STANDALONE_KEYS = Object.freeze(["W", "[", "]"]);

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift"];
const SHIFTED_SYMBOLS = Object.freeze({ "?": "/", ">": ".", "<": ",", "_": "-", "{": "[", "}": "]", ":": ";" });

/** { mods, key } of a combo; "Ctrl++" is Ctrl with the plus key. */
function splitCombo(combo) {
  const parts = combo === "+" ? ["+"] : String(combo).replace(/\+\+$/, "+Plus").split("+").map((part) => (part === "Plus" ? "+" : part));
  const key = parts.pop();
  return { mods: parts, key };
}

/** Canonical spelling of a combo: modifiers in the order Ctrl, Alt, Shift and a single-letter key in upper case. */
export function normaliseCombo(combo) {
  const { mods, key } = splitCombo(combo);
  const unknown = mods.filter((part) => !MODIFIER_ORDER.includes(part));
  if (unknown.length) throw new Error(`Unknown modifier in "${combo}": ${unknown.join(", ")}`);
  const normalKey = key.length === 1 ? key.toUpperCase() : key;
  return [...MODIFIER_ORDER.filter((mod) => mods.includes(mod)), normalKey].join("+");
}

/** Pairs of shortcuts that share a combo in at least one common scope (must be empty). */
export function findConflicts(shortcuts = SHORTCUTS) {
  const seen = new Map();
  const conflicts = [];
  for (const entry of shortcuts) {
    for (const combo of [...entry.keys, ...(entry.macAlso || [])].map(normaliseCombo)) {
      for (const scope of entry.scopes) {
        const slot = `${scope}|${combo}`;
        const other = seen.get(slot);
        if (other && other !== entry.id) conflicts.push({ combo, scope, a: other, b: entry.id });
        else seen.set(slot, entry.id);
      }
    }
  }
  return conflicts;
}

/**
 * Turns a KeyboardEvent (or an object like one) into a normalised combo, or null when it must be ignored:
 * a modifier on its own, a key typed through an input method (isComposing, keyCode 229, "Process", "Dead")
 * or with AltGr (that is how many layouts type characters).
 */
export function comboFromEvent(event, { mac = false } = {}) {
  if (!event || event.isComposing || event.keyCode === 229 || event.key === "Process" || event.key === "Dead") return null;
  let key = event.key === " " ? "Space" : event.key;
  if (typeof key !== "string" || !key) return null;
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(key)) return null;
  if (typeof event.getModifierState === "function" && event.getModifierState("AltGraph")) return null;
  // The other platform's modifier is never part of a shortcut: Control on macOS (Ctrl+S must not read as the
  // single key S), the Windows key elsewhere.
  if (mac ? event.ctrlKey : event.metaKey) return null;
  const ctrl = Boolean(mac ? event.metaKey : event.ctrlKey);
  const alt = Boolean(event.altKey);
  // A layout without Latin letters (Cyrillic, Greek ...) still has Ctrl+Z where Z is printed: take the
  // physical key for Ctrl / Cmd / Alt combinations. Never for a single key: there the character counts,
  // and an input method may have produced it.
  if (key.length === 1 && key.charCodeAt(0) > 127 && (ctrl || alt) && typeof event.code === "string") {
    const physical = /^Key([A-Z])$/.exec(event.code) || /^Digit([0-9])$/.exec(event.code);
    if (physical) key = physical[1];
  }
  const mods = [];
  if (ctrl) mods.push("Ctrl");
  if (alt) mods.push("Alt");
  // Symbols typed with Shift report the shifted character in event.key (">" for Shift+"."): map them back
  // to the base key so that "Ctrl+Shift+." and "Shift+/" match on a US layout. "+" stays its own key without
  // Shift so that the main-row plus and the numpad plus both match.
  let base = key;
  let shift = Boolean(event.shiftKey);
  if (key === "+") shift = false;
  else if (shift && SHIFTED_SYMBOLS[key]) base = SHIFTED_SYMBOLS[key];
  if (shift) mods.push("Shift");
  return normaliseCombo([...mods, base === "+" ? "Plus" : base].join("+").replace(/\+Plus$/, "++").replace(/^Plus$/, "+"));
}

const NORMALISED = new Map(SHORTCUTS.map((entry) => [entry.id, { keys: entry.keys.map(normaliseCombo), macKeys: [...entry.keys, ...(entry.macAlso || [])].map(normaliseCombo) }]));

/**
 * Resolves a key event to a shortcut id, or null.
 * @param {object} event   KeyboardEvent-like: { key, code?, ctrlKey, metaKey, altKey, shiftKey, repeat?, isComposing?, keyCode? }
 * @param {string} scope   one of SCOPES (see scopeFor)
 * @param {{ mac?: boolean, singleKeys?: boolean }} [options]  singleKeys: the user's "Single-key shortcuts" preference
 */
export function matchShortcut(event, scope, { mac = false, singleKeys = true } = {}) {
  const combo = comboFromEvent(event, { mac });
  if (!combo) return null;
  for (const entry of SHORTCUTS) {
    if (!entry.scopes.includes(scope)) continue;
    if (entry.single && (!singleKeys || event.repeat)) continue;
    const { keys, macKeys } = NORMALISED.get(entry.id);
    if ((mac ? macKeys : keys).includes(combo)) return entry.id;
  }
  return null;
}

/** True when the editor must call preventDefault() for this combo (it replaces something the browser does). */
export function overridesBrowser(combo) {
  return Object.prototype.hasOwnProperty.call(OVERRIDDEN_BROWSER, combo);
}

const SHORTCUTS_BY_ID = new Map(SHORTCUTS.map((entry) => [entry.id, entry]));
export const shortcutById = (id) => SHORTCUTS_BY_ID.get(id) ?? null;
export const shortcutsOfSection = (sectionId) => SHORTCUTS.filter((entry) => entry.section === sectionId);

/**
 * The scope of the keyboard focus from what the shell knows. Priority: search field, typing in a text box,
 * page organiser, a selection, the plain page area.
 * The shell does not ask at all while the focus is in a dialog, an input, a textarea, a select or another
 * editable element that is not the editor's own text box.
 */
export function scopeFor({ search = false, typing = false, organiser = false, selectionCount = 0 } = {}) {
  if (search) return "search";
  if (typing) return "text";
  if (organiser) return "organiser";
  return selectionCount > 0 ? "selection" : "viewer";
}

/** True for macOS / iOS platform strings (navigator.userAgentData?.platform || navigator.platform). */
export const isMacPlatform = (platform) => /mac|iphone|ipad|ipod/i.test(String(platform || ""));

// Key caps as they are printed: arrows as arrows (built from code points: no exotic character in this file).
const ARROWS = Object.freeze({ ArrowLeft: String.fromCharCode(0x2190), ArrowUp: String.fromCharCode(0x2191), ArrowRight: String.fromCharCode(0x2192), ArrowDown: String.fromCharCode(0x2193) });
const KEY_CAPS = Object.freeze({ ...ARROWS, Escape: "Esc" });
const MAC_MODIFIERS = Object.freeze({ Ctrl: String.fromCharCode(0x2318), Alt: String.fromCharCode(0x2325), Shift: String.fromCharCode(0x21e7) });

/** The key caps of a combo for display, e.g. ["Ctrl", "Shift", "Z"]; on macOS the modifier symbols. */
export function comboKeyCaps(combo, { mac = false } = {}) {
  const { mods, key } = splitCombo(normaliseCombo(combo));
  return [...mods.map((mod) => (mac ? MAC_MODIFIERS[mod] : mod)), KEY_CAPS[key] || key];
}

/** A combo as one string for a tooltip: "Ctrl+Shift+Z" (macOS: the symbols without separators). */
export function formatCombo(combo, { mac = false } = {}) {
  const caps = comboKeyCaps(combo, { mac });
  return mac ? caps.join("") : caps.join("+");
}

/** The combos of a shortcut for the platform (macOS adds its extra keys, e.g. Backspace for Delete). */
export function keysOfShortcut(id, { mac = false } = {}) {
  const entry = SHORTCUTS_BY_ID.get(id);
  if (!entry) return [];
  return mac ? [...entry.keys, ...(entry.macAlso || [])] : [...entry.keys];
}
