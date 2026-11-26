import { useId, useRef } from "react";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// The yes / no question of actions.confirm(): { title, message, details, confirmLabel, cancelLabel, tone }.
// tone "primary" (default) | "warning" | "danger": a warning or a destructive question is an alert dialog that
// starts with the keyboard on Cancel. onClose(true) = confirmed; false, or closing the dialog any other way = not.
export default function ConfirmDialog({ title, message, details, confirmLabel, cancelLabel, tone = "primary", onClose }) {
  const { t } = useI18n();
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const textId = useId();
  const careful = tone === "warning" || tone === "danger";
  return (
    <DialogFrame
      alert={careful}
      tone={careful ? tone : "default"}
      icon={careful ? TriangleAlert : CircleHelp}
      title={title === undefined ? t("Are you sure?") : title}
      describedBy={textId}
      initialFocusRef={careful ? cancelRef : confirmRef}
      onClose={() => onClose(false)}
      footer={
        <>
          <DialogButton ref={cancelRef} data-testid="pdfx-action-dialog-cancel" onClick={() => onClose(false)}>
            {cancelLabel === undefined || cancelLabel === null ? t("Cancel") : cancelLabel}
          </DialogButton>
          <DialogButton ref={confirmRef} variant={tone === "danger" ? "danger" : "primary"} data-testid="pdfx-action-dialog-confirm" onClick={() => onClose(true)}>
            {confirmLabel === undefined || confirmLabel === null ? t("Confirm") : confirmLabel}
          </DialogButton>
        </>
      }
    >
      <div id={textId}>
        {message ? <p className="pdfx-dialog-text">{message}</p> : null}
        {details ? <p className="pdfx-dialog-note">{details}</p> : null}
      </div>
    </DialogFrame>
  );
}
