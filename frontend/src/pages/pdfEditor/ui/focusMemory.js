// Where the keyboard was before a dialog or a job took it. A chain such as Download -> question -> build ->
// report passes the focus from one layer to the next while the control that started it is covered or inert;
// each layer alone would hand the focus back to <body>. The layers share this one memory instead, so the last
// one to close can give the keyboard back to the control the user really pressed.
// No React, no text: used by ui/dialogs/DialogFrame.jsx and by the platform of ui/actions.js.

let remembered = null;

const LAYERS = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/** Remembers `element` as the place of the keyboard, unless it is part of a dialog or a menu itself. */
export function rememberFocus(element) {
  if (!element || typeof element.closest !== "function" || element.closest(LAYERS)) return;
  remembered = element;
}

/** The remembered element when it is still in the document, else null. */
export function recallFocus() {
  if (remembered && !remembered.isConnected) remembered = null;
  return remembered;
}

/** The keyboard is back where it belongs: the memory is used up (a later job must not find a stale element). */
export function forgetFocus() {
  remembered = null;
}

/** True when nothing useful has the keyboard (the focused control was removed: the browser answers with <body>). */
export function focusIsLost(doc = typeof document === "undefined" ? null : document) {
  if (!doc) return false;
  const active = doc.activeElement;
  return !active || active === doc.body || active === doc.documentElement || !active.isConnected;
}
