import { useId, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// Leaving the editor with changes that were not downloaded (the back link, the browser's Back button):
// UX specification 9. onClose("stay" | "leave" | "download"); closing it any other way means "stay".
export default function LeaveDialog({ onClose }) {
  const { t } = useI18n();
  const stayRef = useRef(null);
  const textId = useId();
  return (
    <DialogFrame
      alert
      tone="warning"
      icon={TriangleAlert}
      title={t("Leave the editor?")}
      describedBy={textId}
      initialFocusRef={stayRef}
      onClose={() => onClose("stay")}
      footer={
        <>
          <DialogButton ref={stayRef} data-testid="pdfx-action-leave-stay" onClick={() => onClose("stay")}>
            {t("Stay")}
          </DialogButton>
          <DialogButton variant="danger" data-testid="pdfx-action-leave-discard" onClick={() => onClose("leave")}>
            {t("Leave without downloading")}
          </DialogButton>
          <DialogButton variant="primary" data-testid="pdfx-action-leave-download" onClick={() => onClose("download")}>
            {t("Download and leave")}
          </DialogButton>
        </>
      }
    >
      <p id={textId} className="pdfx-dialog-text">
        {t("You have changes that were not downloaded. Leave anyway?")}
      </p>
    </DialogFrame>
  );
}
