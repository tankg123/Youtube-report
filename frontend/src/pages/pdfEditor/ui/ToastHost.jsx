import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { useEditor, useUi } from "./editorHooks.js";

// The toasts of the UI store (actions.toast): results and failures of what the user just did, with an Undo
// button where the action can be taken back (deleting pages or objects). Two live regions that are always in
// the document: a polite one for results, an assertive one for errors.
const TONE_ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

function ToastItem({ toast }) {
  const { t } = useI18n();
  const { ui } = useEditor();
  const Icon = TONE_ICONS[toast.tone] || Info;
  return (
    <div className="pdfx-toast" data-tone={toast.tone} data-testid="pdfx-toast">
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      <span className="pdfx-toast-text">{toast.message}</span>
      {toast.undo ? (
        <button type="button" className="pdfx-toast-action" data-testid="pdfx-toast-undo" onClick={() => ui.undoToast(toast.id)}>
          {toast.actionLabel || t("Undo")}
        </button>
      ) : null}
      <button type="button" className="pdfx-toast-close" aria-label={t("Dismiss")} data-testid="pdfx-toast-dismiss" onClick={() => ui.dismissToast(toast.id)}>
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function ToastHost() {
  const toasts = useUi((state) => state.toasts);
  const errors = toasts.filter((toast) => toast.tone === "error");
  const others = toasts.filter((toast) => toast.tone !== "error");
  return (
    <div className="pdfx-toasts" data-testid="pdfx-toasts">
      <div role="status" aria-live="polite" className="pdfx-toast-region">
        {others.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="pdfx-toast-region">
        {errors.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </div>
  );
}
