// The keyboard of the page grids (UX specification 12, "Pages"): the commands the editor's key dispatcher
// (ui/Shell.jsx, ui/keyCommands.js) asks the pages feature for. They act while the keyboard is in a grid of
// page tiles (the Pages panel or the organiser: both carry data-pdfx-scope="organiser") or while the
// organiser is open and nothing else has the keyboard.
//
//   pageFocus      arrows             the focus moves to the next tile (the selection stays)
//   pageExtend     Shift + arrows     the selection grows from its anchor
//   pageToggle     Space              the focused page goes in or out of the selection
//   pageOpen       Enter              the organiser closes at that page; in the panel the reader goes there
//   pageEarlier / pageLater   Ctrl+Shift+Left / Right   the selected pages move one place
//   pageRotateCw / pageRotateCcw   R / Shift+R
//   selectAll (Ctrl+A), duplicate (Ctrl+D), delete (Delete), escape
//   openImages     pictures among dropped or opened files become pages ("Image as page")
// Every command returns true when it took the key; false leaves it to the kernel.
import { continueInsertImages, run } from "./pageFlows.js";
import { clickSelection, columnsOf, directionOfKey, extendSelection, gridNeighbour, toggleSelection } from "./pageLogic.js";
import { deletePages, duplicatePages, movePagesByStep, rotatePages } from "./pageOps.js";
import { getPagesState, selectedPageIds, setSelection, targetPageIds } from "./pagesState.js";
import { focusTile, tilesOf } from "./usePageGrid.js";

const GRID = "[data-pdfx-pages-grid]";

/** The grid a key belongs to: the one that has the keyboard, else the organiser's while that view is open. */
function gridFor(editor, event) {
  if (event.scope !== "organiser") return null;
  const target = event.keyEvent?.target;
  const own = typeof target?.closest === "function" ? target.closest(GRID) : null;
  if (own) return own;
  if (editor.ui.getState().view !== "organiser") return null;
  return editor.getElement?.("root")?.querySelector('[data-pdfx-pages-grid="organiser"]') || null;
}

const idsOf = (editor) => editor.store.getState().pages.map((page) => page.id);

/** The page the keyboard is on in a grid: the focused tile, else the remembered one, else the first page. */
function focusedId(editor, grid) {
  const active = grid.ownerDocument.activeElement;
  const fromDom = active && grid.contains(active) ? active.closest("[data-page-id]")?.getAttribute("data-page-id") : null;
  if (fromDom) return fromDom;
  const ids = idsOf(editor);
  const { focus } = getPagesState(editor.ui);
  return ids.includes(focus) ? focus : ids[0] || null;
}

function neighbour(editor, grid, event) {
  const direction = directionOfKey(event.keyEvent?.key);
  if (!direction) return null;
  const tiles = tilesOf(grid);
  const ids = tiles.map((tile) => tile.getAttribute("data-page-id"));
  const from = ids.indexOf(focusedId(editor, grid));
  const next = gridNeighbour(from, ids.length, columnsOf(tiles.map((tile) => tile.offsetTop)), direction);
  return next < 0 ? null : { ids, id: ids[next] };
}

function moveFocus(editor, event, extend) {
  const grid = gridFor(editor, event);
  if (!grid) return false;
  const found = neighbour(editor, grid, event);
  if (!found) return false;
  if (extend) setSelection(editor.ui, extendSelection(found.ids, { ...getPagesState(editor.ui), focus: focusedId(editor, grid) }, found.id));
  // a plain move also moves the anchor: the next Shift + arrow extends from where the keyboard is
  else setSelection(editor.ui, { focus: found.id, anchor: found.id });
  focusTile(grid, found.id);
  return true;
}

/** Leaves the organiser at a page (double click, Enter). */
export function openPage(editor, pageId) {
  const { actions, ui } = editor;
  ui.closeView();
  // the pages were hidden: scroll once they are laid out again
  const go = () => {
    actions.goToPage(pageId);
    editor.getElement?.("viewer")?.focus?.({ preventScroll: true });
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
  else go();
}

function withTargets(editor, event, operation) {
  if (!gridFor(editor, event)) return false;
  const ids = targetPageIds(editor);
  if (ids.length) run(editor, operation(ids));
  return true;
}

export const pageCommands = {
  pageFocus: (editor, event) => moveFocus(editor, event, false),
  pageExtend: (editor, event) => moveFocus(editor, event, true),

  pageToggle(editor, event) {
    const grid = gridFor(editor, event);
    if (!grid) return false;
    const id = focusedId(editor, grid);
    if (id) setSelection(editor.ui, toggleSelection(idsOf(editor), getPagesState(editor.ui), id));
    return true;
  },

  pageOpen(editor, event) {
    const grid = gridFor(editor, event);
    if (!grid) return false;
    const id = focusedId(editor, grid);
    if (!id) return true;
    if (grid.getAttribute("data-pdfx-pages-grid") === "organiser") {
      openPage(editor, id);
    } else {
      setSelection(editor.ui, clickSelection(idsOf(editor), getPagesState(editor.ui), id));
      editor.actions.goToPage(id);
    }
    return true;
  },

  pageEarlier: (editor, event) => withTargets(editor, event, (ids) => movePagesByStep(editor, ids, "earlier")),
  pageLater: (editor, event) => withTargets(editor, event, (ids) => movePagesByStep(editor, ids, "later")),
  pageRotateCw: (editor, event) => withTargets(editor, event, (ids) => rotatePages(editor, ids, 90)),
  pageRotateCcw: (editor, event) => withTargets(editor, event, (ids) => rotatePages(editor, ids, -90)),
  duplicate: (editor, event) => withTargets(editor, event, (ids) => duplicatePages(editor, ids)),
  delete: (editor, event) => withTargets(editor, event, (ids) => deletePages(editor, ids)),

  selectAll(editor, event) {
    if (!gridFor(editor, event)) return false;
    const ids = idsOf(editor);
    const state = getPagesState(editor.ui);
    setSelection(editor.ui, { selected: ids, anchor: ids.includes(state.anchor) ? state.anchor : ids[0] || null });
    return true;
  },

  /** In the panel: Escape first drops the selection, then does what Escape does elsewhere. */
  escape(editor, event) {
    if (event.scope !== "organiser" || editor.ui.getState().view) return false;
    if (!gridFor(editor, event)) return false;
    if (selectedPageIds(editor).length) {
      setSelection(editor.ui, { selected: [] });
      return true;
    }
    return editor.actions.shellEscape() === true;
  },

  /** Pictures among opened or dropped files: one page per picture, after the dialog of "Image as page". */
  openImages(editor, event) {
    const files = [...(event.files || [])];
    if (!files.length) return false;
    const { actions, store } = editor;
    const start = async () => {
      // pictures on an empty editor: they become a document of their own, on a first page that is then dropped
      const fresh = store.getState().pages.length === 0;
      if (fresh && !(await actions.newBlankDocument())) return;
      const placeholder = fresh ? store.getState().pages[0]?.id : null;
      const created = await continueInsertImages(editor, files, { index: fresh ? 0 : event.index });
      if (!placeholder) return;
      if (created?.length) {
        store.deletePages([placeholder]);
        store.clearHistory();
      } else {
        // nothing came of it: back to the empty editor
        await actions.closeDocument();
      }
    };
    run(editor, start());
    return true;
  }
};
