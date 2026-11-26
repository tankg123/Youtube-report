// The dialogs the kernel brings itself, by the id that ui.openDialog(id, props) takes. A feature adds its own
// through the `dialogs` member of its manifest; an id that exists here cannot be taken by a feature.
//
//   confirm        a yes / no question (actions.confirm)
//   password       the password of a protected file
//   leave          leaving with work that was not downloaded
//   export         before an output is built: pending marks, text as pictures, what the file leaves out
//   exportReview   the built file still holds something the user removed: remove it, take it as it is, or cancel
//   exportFailed   a build failed: nothing was handed out
//   report         what happened in a build, after the file was handed out
//   properties     document properties
//   shortcuts      keyboard shortcuts and the switch for single keys
import ConfirmDialog from "./ConfirmDialog.jsx";
import ExportDialog from "./ExportDialog.jsx";
import ExportFailedDialog from "./ExportFailedDialog.jsx";
import ExportReviewDialog from "./ExportReviewDialog.jsx";
import LeaveDialog from "./LeaveDialog.jsx";
import PasswordDialog from "./PasswordDialog.jsx";
import PropertiesDialog from "./PropertiesDialog.jsx";
import ReportDialog from "./ReportDialog.jsx";
import ShortcutsDialog from "./ShortcutsDialog.jsx";

export const KERNEL_DIALOGS = Object.freeze({
  confirm: ConfirmDialog,
  password: PasswordDialog,
  leave: LeaveDialog,
  export: ExportDialog,
  exportReview: ExportReviewDialog,
  exportFailed: ExportFailedDialog,
  report: ReportDialog,
  properties: PropertiesDialog,
  shortcuts: ShortcutsDialog
});
