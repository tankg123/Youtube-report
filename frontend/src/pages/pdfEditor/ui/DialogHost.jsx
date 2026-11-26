import { KERNEL_DIALOGS } from "./dialogs/index.js";
import { useEditor, useUi } from "./editorHooks.js";

// Renders the dialog stack of the UI store, inside the editor root (no portal): every entry of
// ui.getState().dialogs is the component registered under its id (the kernel's dialogs, then the `dialogs` of
// the feature manifests) with the props of ui.openDialog(id, props) plus
//   onClose(result)   closes this dialog; ui.showDialog(id, props) resolves with `result`
// A dialog component draws its own frame (the shared Modal of pages/assetDelivery/shared.jsx is rendered in
// place and traps the focus). The slot around it carries data-testid="pdfx-dialog-<id>".
export default function DialogHost() {
  const { ui, features } = useEditor();
  const dialogs = useUi((state) => state.dialogs);
  return dialogs.map((dialog) => {
    const Dialog = KERNEL_DIALOGS[dialog.id] || features.dialogs[dialog.id];
    if (!Dialog) return null;
    return (
      <div key={dialog.key} className="pdfx-dialog-slot" data-dialog-id={dialog.id} data-testid={`pdfx-dialog-${dialog.id}`}>
        <Dialog {...dialog.props} onClose={(result) => ui.closeDialog(dialog.key, result)} />
      </div>
    );
  });
}
