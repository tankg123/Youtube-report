// The overlay feature of the PDF editor: everything the user adds to a page (text boxes, pictures, shapes,
// pen strokes, highlights, redaction and blur marks) and how it is selected, changed and removed.
// The manual of the manifest is the header of ui/EditorContext.jsx.
//
//   pageOverlay      PageOverlay.jsx      the objects of one page, drawn where the export will draw them, the
//                                         preview of the running gesture, the selection frame with its handles
//   propertiesPanel  PropertiesPanel.jsx  style of the selection / the box being typed / the next object of a
//                                         tool; position, size and rotation as numbers; pending marks
//   selectionBar     OverlayFloats.jsx    the bar above the selection, the popover over selected document
//                                         text; it also connects the pointer of the page area (pointer.js)
//   contextMenu      OverlayLayer.jsx     the context menu of the pages, the file input of the Image tool
//   effectExecutor   runtime.js           the effects of tools/interaction.js as store commands
//   toolActivators   image                opens the file picker; the picture then follows the pointer
//   commands         the keys of the selection and of a text box (tools/keymap.js)
//
// For the other features (import from "../overlay/api.js"): placing a picture with the pointer, importing a
// picture file as an asset, the runtime.
import { NUDGE_BIG_STEP, NUDGE_STEP } from "../model/transform.js";
import { looksLikeImage } from "./imageRules.js";
import OverlayFloats from "./OverlayFloats.jsx";
import OverlayLayer from "./OverlayLayer.jsx";
import PageOverlay from "./PageOverlay.jsx";
import PropertiesPanel from "./PropertiesPanel.jsx";
import { getRuntime } from "./runtime.js";

/** A picture dropped on the pages lands where it was dropped when the drop is this fresh (milliseconds). */
const DROP_MEMORY = 3000;

/** A command of the page area: the organiser and the search field have keys of their own. */
const onPages = (run) => (editor, event) => {
  if (event.scope === "organiser" || event.scope === "search" || !editor.store.getState().pages.length) return false;
  return run(getRuntime(editor), event, editor) === true;
};

/**
 * Pictures among dropped files: with a document open they are placed on the page under the drop. While a
 * full-screen view (the page organiser) covers the pages there is no "page under the drop": the command is
 * left to the pages feature, which makes new pages of the pictures.
 */
function openImages(editor, event) {
  if (event.intent !== "add" || !editor.store.getState().pages.length) return false;
  if (editor.ui.getState().view) return false;
  const pictures = [...(event.files || [])].filter(looksLikeImage);
  if (!pictures.length) return false;
  const runtime = getRuntime(editor);
  const drag = runtime.dragPoint();
  let target = {};
  if (drag && Date.now() - drag.time < DROP_MEMORY) {
    const pageId = editor.viewer.pageAtPoint(drag.clientX, drag.clientY);
    const at = pageId ? editor.viewer.clientToUser(pageId, drag.clientX, drag.clientY) : null;
    if (pageId && at) target = { pageId, at };
  }
  runtime.setDragPoint(null);
  runtime.addImageFiles(pictures, target);
  return true;
}

/** The counter of pending marks in the status bar: the list in the properties panel, and the first mark in view. */
function showPendingMarks(editor) {
  const runtime = getRuntime(editor);
  const [first] = runtime.pendingMarks();
  runtime.setBag({ showMarks: true });
  editor.ui.setInspector({ open: true });
  if (first) {
    editor.viewer.scrollToPage(first.pageId, { rect: first.rect, align: "center" });
    runtime.select([first.id], { keepTool: true });
  }
  return true;
}

export default {
  id: "overlay",
  pageOverlay: PageOverlay,
  propertiesPanel: PropertiesPanel,
  selectionBar: OverlayFloats,
  contextMenu: OverlayLayer,
  effectExecutor: (editor, effects) => getRuntime(editor).execute(effects),
  toolActivators: {
    image: (editor) => {
      getRuntime(editor).openImagePicker(null);
    }
  },
  commands: {
    // With a key the browser fires its own copy / cut / paste event next: the clipboard handlers of the page
    // area (pointer.js) take it there, where the system clipboard can be read and marked. Without a key
    // (a menu) the command does the work itself.
    copy: onPages((runtime, event) => (event.keyEvent ? false : runtime.copySelection(false))),
    cut: onPages((runtime, event) => (event.keyEvent ? false : runtime.copySelection(true))),
    paste: onPages((runtime, event) => {
      if (event.keyEvent) return false;
      runtime.pasteObjects();
      return true;
    }),
    duplicate: onPages((runtime) => runtime.duplicateSelection()),
    selectAll: onPages((runtime) => runtime.selectAll()),
    nudge: onPages((runtime, event) => runtime.nudgeSelection(event.keyEvent?.key || event.direction, NUDGE_STEP)),
    nudgeBig: onPages((runtime, event) => runtime.nudgeSelection(event.keyEvent?.key || event.direction, NUDGE_BIG_STEP)),
    bringForward: onPages((runtime) => runtime.arrangeSelection("forward")),
    sendBackward: onPages((runtime) => runtime.arrangeSelection("backward")),
    bringToFront: onPages((runtime) => runtime.arrangeSelection("front")),
    sendToBack: onPages((runtime) => runtime.arrangeSelection("back")),
    bold: onPages((runtime) => runtime.toggleTextStyle("bold")),
    italic: onPages((runtime) => runtime.toggleTextStyle("italic")),
    underline: onPages((runtime) => runtime.toggleTextStyle("underline")),
    biggerText: onPages((runtime) => runtime.stepTextSize(1)),
    smallerText: onPages((runtime) => runtime.stepTextSize(-1)),
    commitText: onPages((runtime) => runtime.commitText()),
    openImages,
    showPendingMarks
  },
  onDocumentClosed: (editor) => getRuntime(editor).reset()
};
