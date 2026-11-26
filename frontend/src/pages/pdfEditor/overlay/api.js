// What the other features of the editor may use of the overlay (the signing feature places signature
// pictures with it; the page panels add pictures to pages):
//
//   import { importPicture, startPlacing, placePictureAt, getRuntime } from "../overlay/api.js";
//
//   const assetId = await importPicture(editor, blob);      // null: not a usable picture (the user was told)
//   startPlacing(editor, assetId, "signature");             // the picture follows the pointer; a click or a
//                                                           // drag on a page puts it there (role from the tool)
//   placePictureAt(editor, assetId, pageId, [x, y]);        // at once, without the pointer
//
// Everything else the overlay offers goes through the manifest (commands, the effect executor) and through the
// interaction reducer: ui.runInteraction({ type: "setSelection", ids }) selects objects, for example.
import { PLACE_TOOLS } from "../tools/interaction.js";
import { getRuntime } from "./runtime.js";

export { getRuntime };

/**
 * Makes a picture file an asset of the document: PNG and JPEG as they are, other formats the browser decodes
 * as PNG, the long edge capped at 4000 px (overlay/imageRules.js).
 * @param {object} editor  the editor context (useEditor())
 * @param {Blob} blob      a File from a picker, a drop or the clipboard, or a Blob made in the page
 * @returns {Promise<string | null>} the asset id, or null when the picture cannot be used
 */
export function importPicture(editor, blob) {
  return getRuntime(editor).importImage(blob);
}

/**
 * Starts placing a picture with the pointer: chooses the tool ("image" or "signature") when it is not the
 * active one and hands the asset to the interaction reducer. The object is created by the overlay when the
 * user clicks or drags on a page; Escape gives up.
 * @returns {boolean} false when the asset is not in the document or the tool cannot place pictures
 */
export function startPlacing(editor, assetId, tool = "image") {
  if (!PLACE_TOOLS.includes(tool) || !editor.store.getState().assets[assetId]) return false;
  if (editor.ui.getState().interaction.tool !== tool) editor.ui.runInteraction({ type: "tool", tool });
  editor.ui.runInteraction({ type: "placeReady", payload: assetId });
  return true;
}

/**
 * Puts a picture on a page at once (default size, centred on `at`; the middle of the page without it) and
 * selects it. `at` is a point in the user space of the page.
 * @returns {string[]} the ids of the new objects
 */
export function placePictureAt(editor, assetId, pageId, at = null) {
  return getRuntime(editor).placeImage(assetId, pageId, at);
}
