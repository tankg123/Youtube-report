// "Signature" (Chữ ký), UX specification 7.10: a PICTURE of a handwritten signature on a page. It proves
// nothing about who signed; the certificate signature is the other tool.
//
//   startSignature(editor)      the tool activator: the dialog (saved signatures, Draw, Type it, Upload), then
//                               the picture is handed to the overlay's placing flow
//   placeSignature(editor, p)   registers the picture as an asset of the document and starts the overlay's
//                               placing flow (overlay/api.js startPlacing: the reducer's "placeReady" with the
//                               Signature tool). From there on it is placed like an image with role
//                               "signature": a click puts it 160 pt wide, a drag sizes it, ratio kept
//   addDateStamp(editor)        "Add date": an ordinary text box with today's date under the selected signature
import { formatDate, t } from "../../../i18n/index.js";
import { objectScreenBox, pageScreen } from "../model/shapes.js";
import { createTextBox } from "../model/transform.js";
import { startPlacing } from "../overlay/api.js";
import { SIGNATURE_DIALOG } from "./state.js";

/** Puts a signature picture on the pointer: the next click or drag on a page places it. */
export function placeSignature(editor, picture) {
  const { actions, store } = editor;
  let assetId;
  try {
    assetId = store.addAsset({ mime: "image/png", width: picture.width, height: picture.height }, picture.png);
  } catch (error) {
    actions.reportError(error);
    return false;
  }
  if (!startPlacing(editor, assetId, "signature")) return false;
  actions.hint("signature-place", t("Click on a page to place the signature, or drag to choose its size."));
  return true;
}

/** The tool activator of "Signature": opens the dialog; without a picture the editor goes back to Select. */
export async function startSignature(editor) {
  const { ui } = editor;
  if (ui.getState().dialogs.some((dialog) => dialog.id === SIGNATURE_DIALOG)) return false;
  const answer = await ui.showDialog(SIGNATURE_DIALOG, { purpose: "place" });
  if (answer?.picture) return placeSignature(editor, answer.picture);
  const { tool, mode } = ui.getState().interaction;
  if (tool === "signature" && mode !== "placing") ui.runInteraction({ type: "tool", tool: "select" });
  return false;
}

/** The signature picture "Add date" belongs to: the one selected object, when it is a signature. */
export function selectedSignature(editor) {
  const { selection } = editor.ui.getState().interaction;
  if (selection.length !== 1) return null;
  const object = editor.store.getState().objects[selection[0]];
  return object && object.type === "image" && object.role === "signature" ? object : null;
}

/** Today's date as the date stamp writes it: 20/11/2026 in Vietnamese, the short date of the locale in English. */
export const dateStampText = (date = new Date(), language) => formatDate(date, language);

/**
 * "Add date": a normal text box with today's date under the selected signature picture. It can be edited,
 * restyled, moved or deleted like any other text box.
 * @returns {Promise<boolean>} true when the box was added
 */
export async function addDateStamp(editor) {
  const { actions, store, ui } = editor;
  const signature = selectedSignature(editor);
  if (!signature) {
    actions.hint("signature-date", t("Select a signature on the page first, then add the date."));
    return false;
  }
  const page = store.getState().pages.find((candidate) => candidate.id === signature.pageId);
  if (!page || !(await actions.beforeEdit())) return false;
  const screen = pageScreen(page);
  const [left, , , bottom] = objectScreenBox(signature, page);
  const defaults = { ...ui.getToolDefaults("text"), size: 10, align: "left", bold: false, italic: false, underline: false };
  // like a click of the text tool: the first line is centred on the point, which is the left edge of the box
  const at = screen.toUser([Math.max(0, left), Math.min(screen.height - 8, bottom + 10)]);
  const box = createTextBox(page, { at }, defaults, dateStampText());
  if (!box || !(await actions.ensureFonts(box))) return false;
  try {
    const ids = store.addObjects([box]);
    ui.runInteraction({ type: "setSelection", ids });
    return true;
  } catch (error) {
    actions.reportError(error);
    return false;
  }
}
