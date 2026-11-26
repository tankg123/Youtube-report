// What the page panels remember besides the document: which pages are selected, which one has the keyboard,
// the size of the organiser's thumbnails, the open page menu, the last announcement for screen readers.
// It lives in the feature bag "pages" of the UI store (ui.getFeatureState / ui.setFeatureState), so that the
// Pages panel, the organiser, the dialogs and the keyboard commands all see the same selection.
// No DOM, no React: tests/pdfPagesOps.test.mjs.
//
//   selected      page ids (any order; readers take orderedSelection(ids, selected))
//   anchor        where a Shift + click range starts
//   focus         the page with the keyboard focus in a grid
//   size          "s" | "m" | "l": thumbnails of the organiser (kept in localStorage)
//   menu          null | { kind: "page" | "add", x, y, pageIds?, index?, origin }: the open menu
//   announcement  { text, token }: said by the live region of pages/PagesHost.jsx
//   reveal        { id, token }: the grids scroll this page into view when the token changes
import { orderedSelection } from "./pageLogic.js";

export const FEATURE_ID = "pages";
export const THUMB_SIZES = Object.freeze(["s", "m", "l"]);
const SIZE_KEY = "pdfx.pages.thumbSize.v1";

function storedSize() {
  try {
    const value = globalThis.localStorage?.getItem(SIZE_KEY);
    return THUMB_SIZES.includes(value) ? value : "m";
  } catch {
    return "m"; // storage switched off
  }
}

let defaults = null;
const initial = () => {
  if (!defaults) defaults = Object.freeze({ selected: Object.freeze([]), anchor: null, focus: null, size: storedSize(), menu: null, announcement: Object.freeze({ text: "", token: 0 }), reveal: Object.freeze({ id: null, token: 0 }) });
  return defaults;
};

/** The bag of the pages feature (never undefined). */
export const getPagesState = (ui) => ui.getFeatureState(FEATURE_ID) || initial();

/** Merges a patch into the bag. @returns {boolean} true when something changed */
export function patchPagesState(ui, patch) {
  return ui.setFeatureState(FEATURE_ID, (previous) => {
    const base = previous || initial();
    const changed = Object.keys(patch).some((key) => patch[key] !== base[key]);
    return changed ? Object.freeze({ ...base, ...patch }) : previous;
  });
}

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Replaces the selection (and optionally anchor and focus). Keeps the same array when nothing changed. */
export function setSelection(ui, { selected, anchor, focus }) {
  const state = getPagesState(ui);
  const patch = {};
  if (selected !== undefined && !sameList(selected, state.selected)) patch.selected = Object.freeze([...selected]);
  if (anchor !== undefined) patch.anchor = anchor;
  if (focus !== undefined) patch.focus = focus;
  return patchPagesState(ui, patch);
}

/** The selected pages that still exist, in document order. */
export function selectedPageIds(editor) {
  const ids = editor.store.getState().pages.map((page) => page.id);
  return orderedSelection(ids, getPagesState(editor.ui).selected);
}

/**
 * The pages a command acts on when it names none: the selection, else the page with the keyboard focus,
 * else the page the reader is on.
 */
export function targetPageIds(editor) {
  const selected = selectedPageIds(editor);
  if (selected.length) return selected;
  const { pages } = editor.store.getState();
  const { focus } = getPagesState(editor.ui);
  if (focus && pages.some((page) => page.id === focus)) return [focus];
  const current = editor.viewer.getSnapshot?.().currentPageId;
  return current && pages.some((page) => page.id === current) ? [current] : [];
}

/** Says something to screen readers (a polite live region; the token makes a repeated sentence new). */
export function announce(ui, text) {
  const { announcement } = getPagesState(ui);
  return patchPagesState(ui, { announcement: Object.freeze({ text: String(text ?? ""), token: announcement.token + 1 }) });
}

/** Asks the grids to scroll a page into view. */
export function revealPage(ui, id) {
  const { reveal } = getPagesState(ui);
  return patchPagesState(ui, { reveal: Object.freeze({ id, token: reveal.token + 1 }) });
}

export function setThumbSize(ui, size) {
  if (!THUMB_SIZES.includes(size)) return false;
  try {
    globalThis.localStorage?.setItem(SIZE_KEY, size);
  } catch {
    // the choice lasts for this page only
  }
  return patchPagesState(ui, { size });
}

/** Opens the page menu or the Add menu at a point of the window. `origin`: the element that gets the focus back. */
export function openMenu(ui, menu) {
  return patchPagesState(ui, { menu: Object.freeze({ ...menu }) });
}

export const closeMenu = (ui) => patchPagesState(ui, { menu: null });

/** A new document: nothing is selected, no menu is open. */
export function resetPagesState(ui) {
  return patchPagesState(ui, { selected: Object.freeze([]), anchor: null, focus: null, menu: null });
}
