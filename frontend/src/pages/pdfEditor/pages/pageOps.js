// The page operations of the Pages panel, the page organiser and their dialogs (UX specification 7.9).
// Every function takes the editor context first, asks what has to be asked before the document changes
// (actions.beforeEdit(): a view-only file is refused, a signed one asks once), runs ONE store command or ONE
// transaction (= one undo step), and tells the user what happened: an announcement for screen readers, and a
// toast where the result may be out of sight (Delete with Undo, pages that were added, a file that was saved).
// A refusal of the store (the last page cannot be deleted) is shown as its sentence of messages.js.
// No DOM, no React: tests/pdfPagesOps.test.mjs runs these against the real store.
import { t } from "../../../i18n/index.js";
import { PdfEditorError } from "../engine/errors.js";
import { pdfFileName } from "../ui/fileNames.js";
import { imagePageLayout, keyboardMoveTarget, orderedSelection, positionMoveTarget } from "./pageLogic.js";
import { announce, getPagesState, revealPage, setSelection } from "./pagesState.js";

const idsOf = (editor) => editor.store.getState().pages.map((page) => page.id);
const numberOf = (editor, id) => idsOf(editor).indexOf(id) + 1;

/** The pages of `pageIds` that exist, in document order. */
const existing = (editor, pageIds) => orderedSelection(idsOf(editor), pageIds);

/** Before a change: no job may run, the document must be editable, a signed one asks once. */
async function mayEdit(editor) {
  if (editor.ui.getState().job) return false;
  return editor.actions.beforeEdit();
}

/** Runs a store command; a refusal becomes a toast with its sentence. @returns the result, or undefined */
function attempt(editor, command) {
  try {
    return command();
  } catch (error) {
    editor.actions.reportError(error);
    return undefined;
  }
}

/** Shows a page in the grids, and in the page area when the reader is there. */
function showPage(editor, id) {
  revealPage(editor.ui, id);
  if (!editor.ui.getState().view) editor.actions.goToPage(id);
}

/**
 * Rotates pages by a multiple of 90 degrees (clockwise is positive). The objects on a page turn with it.
 * @returns {Promise<string[] | null>} the rotated page ids
 */
export async function rotatePages(editor, pageIds, delta) {
  const ids = existing(editor, pageIds);
  if (!ids.length || !(await mayEdit(editor))) return null;
  const rotated = attempt(editor, () => editor.store.rotatePages(ids, delta));
  if (!rotated?.length) return null;
  const right = delta > 0;
  if (rotated.length === 1) {
    const page = numberOf(editor, rotated[0]);
    announce(editor.ui, right ? t("Page {page} rotated to the right", { page }) : t("Page {page} rotated to the left", { page }));
  } else {
    announce(editor.ui, right ? t("{count} pages rotated to the right", { count: rotated.length }) : t("{count} pages rotated to the left", { count: rotated.length }));
  }
  return rotated;
}

/**
 * Puts a copy after each page, with the objects on it. The copies become the selection.
 * @returns {Promise<string[] | null>} the ids of the copies
 */
export async function duplicatePages(editor, pageIds) {
  const ids = existing(editor, pageIds);
  if (!ids.length || !(await mayEdit(editor))) return null;
  const copies = attempt(editor, () => editor.store.duplicatePages(ids));
  if (!copies?.length) return null;
  setSelection(editor.ui, { selected: copies, anchor: copies[0], focus: copies[0] });
  revealPage(editor.ui, copies[0]);
  announce(editor.ui, copies.length === 1 ? t("Page {page} duplicated", { page: numberOf(editor, ids[0]) }) : t("{count} pages duplicated", { count: copies.length }));
  return copies;
}

/**
 * Deletes pages without a question; the toast offers Undo. The last page of a document cannot be deleted.
 * @returns {Promise<string[] | null>} the deleted ids
 */
export async function deletePages(editor, pageIds) {
  const ids = existing(editor, pageIds);
  if (!ids.length || !(await mayEdit(editor))) return null;
  const before = idsOf(editor);
  const firstIndex = before.indexOf(ids[0]);
  const deleted = attempt(editor, () => editor.store.deletePages(ids));
  if (!deleted?.length) return null;
  // the keyboard stays where the first deleted page was
  const after = idsOf(editor);
  const next = after[Math.min(firstIndex, after.length - 1)] ?? null;
  setSelection(editor.ui, { selected: [], anchor: next, focus: next });
  const depth = editor.store.getHistoryState().undoDepth;
  editor.actions.toast(deleted.length === 1 ? t("1 page deleted") : t("{count} pages deleted", { count: deleted.length }), {
    tone: "success",
    onUndo: () => {
      // only while the deletion is still the last change: Undo must never take back something else
      if (editor.store.getHistoryState().undoDepth === depth) editor.actions.undo();
      else editor.actions.hint("pages-undo-late", t("Other changes were made since. Use Undo (Ctrl+Z) to go back step by step."), "info");
    }
  });
  return deleted;
}

function announceMove(editor, ids, fromNumber, position) {
  announce(editor.ui, ids.length === 1 ? t("Page {page} moved to position {position}", { page: fromNumber, position }) : t("{count} pages moved to position {position}", { count: ids.length, position }));
}

/**
 * Moves pages to `toIndex` of the list WITHOUT them (store.movePages); they keep their order.
 * @returns {Promise<boolean>} true when the order changed
 */
export async function movePages(editor, pageIds, toIndex) {
  const ids = existing(editor, pageIds);
  if (!ids.length || !(await mayEdit(editor))) return false;
  const fromNumber = numberOf(editor, ids[0]);
  const moved = attempt(editor, () => editor.store.movePages(ids, toIndex));
  if (!moved) return false;
  announceMove(editor, ids, fromNumber, numberOf(editor, ids[0]));
  revealPage(editor.ui, ids[0]);
  return true;
}

/** Ctrl+Shift+Left / Right: one place earlier or later. @param {"earlier" | "later"} direction */
export async function movePagesByStep(editor, pageIds, direction) {
  const ids = existing(editor, pageIds);
  const target = keyboardMoveTarget(idsOf(editor), ids, direction);
  if (!target) {
    if (ids.length) announce(editor.ui, direction === "earlier" ? t("Already at the beginning") : t("Already at the end"));
    return false;
  }
  return movePages(editor, ids, target.toIndex);
}

/** "Move to position…": the pages start at that 1-based place. */
export async function movePagesToPosition(editor, pageIds, position) {
  const ids = existing(editor, pageIds);
  const target = positionMoveTarget(idsOf(editor), ids, position);
  if (!ids.length || !target.changes) return false;
  return movePages(editor, ids, target.toIndex);
}

/**
 * Inserts blank pages.
 * @param {{ size: [number, number], index: number, count?: number }} request  size in points
 * @returns {Promise<string[] | null>} the new page ids
 */
export async function insertBlankPages(editor, { size, index, count = 1 }) {
  if (!(await mayEdit(editor))) return null;
  const many = Math.min(500, Math.max(1, Math.trunc(Number(count)) || 1));
  const created = attempt(editor, () =>
    editor.store.transaction(() => {
      const ids = [];
      for (let step = 0; step < many; step += 1) ids.push(editor.store.insertBlankPage(index + step, size));
      return ids;
    })
  );
  if (!created?.length) return null;
  setSelection(editor.ui, { selected: created, anchor: created[0], focus: created[0] });
  showPage(editor, created[0]);
  const page = numberOf(editor, created[0]);
  announce(editor.ui, created.length === 1 ? t("Blank page inserted as page {page}", { page }) : t("{count} blank pages inserted from page {page}", { count: created.length, page }));
  return created;
}

/**
 * Inserts pages of a source that actions.loadSource() registered.
 * @param {{ sourceId: string, indices: number[], index: number, fileName?: string, facts?: object }} request
 *        indices: 0-based pages of that file, in the order they are inserted
 * @returns {Promise<string[] | null>} the new page ids; null = nothing was inserted (the source is forgotten)
 */
export async function insertSourcePages(editor, { sourceId, indices, index, fileName = "", facts = null }) {
  const { actions, store, ui } = editor;
  if (!(await mayEdit(editor))) {
    actions.discardSource(sourceId);
    return null;
  }
  const created = attempt(editor, () => store.insertPages(store.pagesOfSource(sourceId, indices), index));
  if (!created?.length) {
    actions.discardSource(sourceId);
    return null;
  }
  // the other features hear about every file that became part of the document (signatures, outline)
  for (const hook of editor.features?.onDocumentOpened || []) {
    try {
      hook(editor, { sourceId, facts, name: fileName });
    } catch (error) {
      actions.reportError(error);
    }
  }
  setSelection(ui, { selected: created, anchor: created[0], focus: created[0] });
  showPage(editor, created[0]);
  const depth = store.getHistoryState().undoDepth;
  actions.toast(created.length === 1 ? t("1 page added from {name}", { name: fileName }) : t("{count} pages added from {name}", { count: created.length, name: fileName }), {
    tone: "success",
    onUndo: () => {
      if (store.getHistoryState().undoDepth === depth) actions.undo();
    }
  });
  return created;
}

/**
 * Inserts one page per picture: a blank page with an image object on it.
 * @param {object} request
 * @param {Array<{ mime: "image/png" | "image/jpeg", width: number, height: number, bytes: Uint8Array }>} request.images
 * @param {"a4" | "image"} request.mode   pageLogic.js imagePageLayout
 * @param {number} request.index
 * @returns {Promise<string[] | null>} the new page ids
 */
export async function insertImagePages(editor, { images, mode, index }) {
  const { actions, store, ui } = editor;
  const list = (images || []).filter((image) => imagePageLayout(image, mode));
  if (!list.length || !(await mayEdit(editor))) return null;
  const created = attempt(editor, () =>
    store.transaction(() => {
      const ids = [];
      list.forEach((image, step) => {
        const layout = imagePageLayout(image, mode);
        const assetId = store.addAsset({ mime: image.mime, width: image.width, height: image.height }, image.bytes);
        const pageId = store.insertBlankPage(index + step, layout.size);
        store.addObjects([{ type: "image", pageId, frame: layout.frame, assetId, role: "image", opacity: 1 }]);
        ids.push(pageId);
      });
      return ids;
    })
  );
  if (!created?.length) return null;
  setSelection(ui, { selected: created, anchor: created[0], focus: created[0] });
  showPage(editor, created[0]);
  const depth = store.getHistoryState().undoDepth;
  actions.toast(created.length === 1 ? t("1 image added as a page") : t("{count} images added as pages", { count: created.length }), {
    tone: "success",
    onUndo: () => {
      if (store.getHistoryState().undoDepth === depth) actions.undo();
    }
  });
  return created;
}

/**
 * Extract: a new PDF of the given pages, downloaded as "<name>-pages-3-5.pdf"; optionally the pages are then
 * removed from this document (one undo step, with the Undo toast of Delete).
 * @param {{ pageIds: string[], remove?: boolean }} request
 * @returns {Promise<{ fileName: string, pageIds: string[], removed: boolean } | null>} null = nothing was saved
 */
export async function extractPages(editor, { pageIds, remove = false }) {
  const { actions, store } = editor;
  const ids = existing(editor, pageIds);
  if (!ids.length || editor.ui.getState().job) return null;
  if (remove) {
    // refuse before anything is built: a document cannot give away all of its pages
    if (ids.length >= store.getState().pages.length) {
      actions.reportError(new PdfEditorError("MODEL_LAST_PAGE"));
      return null;
    }
    if (!(await mayEdit(editor))) return null;
  }
  // report "defer": what the build has to say is shown once the file was handed out, naming the file
  const output = await actions.buildOutput({ purpose: "extract", pageIds: ids, report: "defer" });
  if (!output) return null;
  const fileName = pdfFileName(output.baseName);
  actions.saveBytes(output.bytes, fileName);
  if (!output.showReport?.({ fileName })) actions.toast(t("{name} was downloaded.", { name: fileName }), { tone: "success" });
  let removed = false;
  if (remove) removed = Boolean((await deletePages(editor, ids))?.length);
  return { fileName, pageIds: ids, removed };
}

/** The page ids of 1-based page numbers (unknown numbers are left out). */
export function pageIdsOfNumbers(editor, numbers) {
  const ids = idsOf(editor);
  return (numbers || []).map((number) => ids[number - 1]).filter(Boolean);
}

/** Clears a selection that names pages which no longer exist (after undo, redo, a new document). */
export function pruneSelection(editor) {
  const state = getPagesState(editor.ui);
  const ids = idsOf(editor);
  const selected = orderedSelection(ids, state.selected);
  const patch = {};
  if (selected.length !== state.selected.length) patch.selected = selected;
  if (state.anchor && !ids.includes(state.anchor)) patch.anchor = null;
  if (state.focus && !ids.includes(state.focus)) patch.focus = null;
  return Object.keys(patch).length ? setSelection(editor.ui, patch) : false;
}
