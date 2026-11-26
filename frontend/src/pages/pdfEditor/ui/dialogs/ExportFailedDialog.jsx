import { useId, useRef } from "react";
import { ShieldX, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import { describeFailure } from "../outputReport.js";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// A build that failed (UX specification 7.7 and 10): NOTHING is handed out, and the dialog says so in plain
// words. After a failed verification it also says why a file that might still show removed content is never
// created, and offers the one thing that can still help: every marked page as a picture.
//
// Props: code (of the error), message (its sentence from messages.js), purpose, hadMarks, redactPath.
// onClose("retry") = build again; onClose("convert") = build again with the marked pages as pictures;
// anything else = close. Test hooks: pdfx-dialog-exportFailed with pdfx-export-failed (data-code,
// data-verification), pdfx-export-nothing, pdfx-action-failed-close / -convert / -retry.
export default function ExportFailedDialog({ code = "", message, purpose = "download", hadMarks = false, redactPath = "hybrid", onClose }) {
  const { t } = useI18n();
  const texts = describeFailure(code, { purpose, hadMarks, redactPath });
  const closeRef = useRef(null);
  const leadId = useId();
  return (
    <DialogFrame
      alert
      tone="danger"
      icon={texts.verification ? ShieldX : TriangleAlert}
      title={t("The file could not be created")}
      describedBy={leadId}
      initialFocusRef={closeRef}
      onClose={() => onClose(null)}
      footer={
        <>
          <DialogButton ref={closeRef} data-testid="pdfx-action-failed-close" onClick={() => onClose(null)}>
            {t("Close")}
          </DialogButton>
          {texts.canConvert ? (
            <DialogButton data-testid="pdfx-action-failed-convert" onClick={() => onClose("convert")}>
              {t("Try with the marked pages as images")}
            </DialogButton>
          ) : null}
          <DialogButton variant="primary" data-testid="pdfx-action-failed-retry" onClick={() => onClose("retry")}>
            {t("Try again")}
          </DialogButton>
        </>
      }
    >
      <div id={leadId} data-testid="pdfx-export-failed" data-code={code} data-verification={texts.verification ? "true" : "false"}>
        <p className="pdfx-dialog-text">{message}</p>
        <p className="pdfx-callout" data-tone="danger" data-testid="pdfx-export-nothing">
          <TriangleAlert size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{texts.nothing}</span>
        </p>
        {texts.explanation ? <p className="pdfx-dialog-note">{texts.explanation}</p> : null}
        <p className="pdfx-dialog-note">{t("Your work is still open.")}</p>
      </div>
    </DialogFrame>
  );
}
