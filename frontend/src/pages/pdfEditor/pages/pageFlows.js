// From a button or a menu entry to a page operation: the steps in between (a file picker, a dialog) for
// Insert blank page, Pages from PDF, Image as page, Extract and "Move to position…".
// The dialogs are registered in pages/index.js (ids "pagesInsertBlank", "pagesInsertPdf", "pagesInsertImages",
// "pagesExtract", "pagesMoveTo"); the two hidden file inputs are rendered by pages/PagesHost.jsx and
// registered as "pagesPdfInput" and "pagesImageInput".
import { t, tk } from "../../../i18n/index.js";
import { isImageFile } from "../ui/fileNames.js";
import { readImageFile } from "./imageFiles.js";
import { extractPages, insertBlankPages, insertImagePages, insertSourcePages, movePagesToPosition } from "./pageOps.js";
import { selectedPageIds } from "./pagesState.js";

/** What the hidden file inputs wait for: editor -> { index } of the insert that opened the picker. */
const pending = new WeakMap();

const pageCountOf = (editor) => editor.store.getState().pages.length;

/** The index new pages get when the caller names none: after the page the reader is on. */
export function defaultInsertIndex(editor) {
  const { pages } = editor.store.getState();
  const selected = selectedPageIds(editor);
  const anchor = selected.length ? selected[selected.length - 1] : editor.viewer.getSnapshot?.().currentPageId;
  const at = pages.findIndex((page) => page.id === anchor);
  return at < 0 ? pages.length : at + 1;
}

const indexOr = (editor, index) => (Number.isInteger(index) ? Math.min(pageCountOf(editor), Math.max(0, index)) : defaultInsertIndex(editor));

const report = (editor) => (error) => editor.actions.reportError(error);

/** Insert > Blank page: the dialog with size, orientation, place and count. */
export async function startInsertBlank(editor, { index } = {}) {
  if (!editor.actions.canEdit()) return null;
  const choice = await editor.ui.showDialog("pagesInsertBlank", { index: indexOr(editor, index) });
  if (!choice) return null;
  return insertBlankPages(editor, choice);
}

/** Insert > Pages from PDF: opens the file picker; continueInsertPdf() goes on when a file was chosen. */
export function startInsertPdf(editor, { index } = {}) {
  if (!editor.actions.canEdit()) return false;
  pending.set(editor, { index: indexOr(editor, index) });
  const input = editor.getElement("pagesPdfInput");
  if (!input) return false;
  input.click();
  return true;
}

/** A PDF was chosen: it is opened as a source (password dialog included), then the dialog asks which pages go where. */
export async function continueInsertPdf(editor, file) {
  const { actions, ui } = editor;
  const index = pending.get(editor)?.index;
  pending.delete(editor);
  if (!file) return null;
  const loaded = await actions.loadSource(file);
  if (!loaded) return null;
  let choice = null;
  try {
    choice = await ui.showDialog("pagesInsertPdf", { fileName: loaded.name, pageCount: loaded.pageCount, index: indexOr(editor, index) });
  } finally {
    if (!choice) actions.discardSource(loaded.sourceId);
  }
  if (!choice) return null;
  return insertSourcePages(editor, { sourceId: loaded.sourceId, indices: choice.indices, index: choice.index, fileName: loaded.name, facts: loaded.facts });
}

/** Insert > Image as page: opens the picture picker; continueInsertImages() goes on with the files. */
export function startInsertImages(editor, { index } = {}) {
  if (!editor.actions.canEdit()) return false;
  pending.set(editor, { index: indexOr(editor, index) });
  const input = editor.getElement("pagesImageInput");
  if (!input) return false;
  input.click();
  return true;
}

/**
 * Pictures were chosen (or dropped on the editor): the dialog asks for the page size and the place, then every
 * picture is read and becomes a page.
 * @param {File[]} files
 * @param {{ index?: number }} [options]
 */
export async function continueInsertImages(editor, files, { index } = {}) {
  const { actions, ui } = editor;
  const wanted = Number.isInteger(index) ? index : pending.get(editor)?.index;
  pending.delete(editor);
  const pictures = [...(files || [])].filter(isImageFile);
  if (!pictures.length) {
    if (files?.length) actions.toast(t("This image type is not supported. Use PNG, JPEG, WebP, GIF, BMP or SVG."), { tone: "warning" });
    return null;
  }
  if (!actions.canEdit()) return null;
  const choice = await ui.showDialog("pagesInsertImages", { fileNames: pictures.map((file) => file.name), index: indexOr(editor, wanted) });
  if (!choice) return null;
  const images = [];
  const failed = [];
  try {
    await actions.runJob({ titleKey: tk("Reading the images…"), cancellable: true }, async ({ signal, progress, describe }) => {
      for (let step = 0; step < pictures.length; step += 1) {
        if (signal.aborted) break;
        progress(step / pictures.length);
        describe(pictures[step].name);
        try {
          images.push(await readImageFile(pictures[step]));
        } catch {
          failed.push(pictures[step].name);
        }
      }
      if (signal.aborted) images.length = 0;
    });
  } catch (error) {
    actions.reportError(error);
    return null;
  }
  for (const name of failed) actions.toast(t("{name} could not be read as an image. Use PNG, JPEG, WebP, GIF, BMP or SVG.", { name }), { tone: "error" });
  if (!images.length) return null;
  return insertImagePages(editor, { images, mode: choice.mode, index: choice.index });
}

/** Extract: the dialog with the pages and "also remove them", then the new file. */
export async function startExtract(editor, { pageIds } = {}) {
  const ids = pageIds?.length ? pageIds : selectedPageIds(editor);
  if (!ids.length) {
    editor.actions.hint("pages-extract-none", t("Select the pages to extract first."), "info");
    return null;
  }
  const choice = await editor.ui.showDialog("pagesExtract", { pageIds: ids });
  if (!choice) return null;
  return extractPages(editor, choice);
}

/** "Move to position…": asks for the place the pages should start at. */
export async function startMoveTo(editor, { pageIds } = {}) {
  const ids = pageIds?.length ? pageIds : selectedPageIds(editor);
  if (!ids.length || !editor.actions.canEdit()) return false;
  const position = await editor.ui.showDialog("pagesMoveTo", { pageIds: ids });
  if (!Number.isInteger(position)) return false;
  return movePagesToPosition(editor, ids, position);
}

/** Runs a flow from an event handler: a failure becomes a toast, never an unhandled rejection. */
export function run(editor, promise) {
  Promise.resolve(promise).catch(report(editor));
}
