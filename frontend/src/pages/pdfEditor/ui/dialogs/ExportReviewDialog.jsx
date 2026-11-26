import { useId, useRef, useState } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import { useEditor } from "../editorHooks.js";
import { describeReview } from "../outputReport.js";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// The file was built, but something the user removed is still in it: a replaced text line that could only be
// covered, redacted text that is repeated in the bookmarks, the document properties or a form field, letter
// shapes left in a font, the bookmark of a removed page that was kept for the bookmarks under it, data of
// removed pages that may travel with the pages that stay. actions.buildOutput() asks BEFORE it hands the file out: the user can let the editor
// remove what it can (the file is then built again), take the file as it is, or cancel (nothing is handed out).
//
// Props: purpose, findings (ui/outputReport.js reviewFindings). onClose({ remedies: string[] }) = build again
// with these remedies; onClose({ deliver: true }) = hand the file out as it is; onClose(null) = cancel.
// Test hooks: pdfx-dialog-exportReview; pdfx-review-item (data-kind covered | elsewhere | font | bookmarks |
// removedPages, data-where, data-remedy), pdfx-review-remedy-<removeCovered | removeBookmarks | removeProperties |
// convertPages | removeOrphanBookmarks>, pdfx-action-review-cancel / -deliver / -apply.
export default function ExportReviewDialog({ purpose = "download", findings, onClose }) {
  const { t } = useI18n();
  const { messages } = useEditor();
  const texts = describeReview(findings, purpose, messages.describeWarning);
  const offered = [...new Set(findings.items.map((item) => item.remedy).filter(Boolean))];
  const [chosen, setChosen] = useState(offered);
  const cancelRef = useRef(null);
  const leadId = useId();
  const toggle = (remedy, on) => setChosen((list) => (on ? [...new Set([...list, remedy])] : list.filter((entry) => entry !== remedy)));

  return (
    <DialogFrame
      alert
      size="md"
      tone="warning"
      icon={ShieldAlert}
      title={texts.title}
      describedBy={leadId}
      initialFocusRef={cancelRef}
      onClose={() => onClose(null)}
      footer={
        <>
          <DialogButton ref={cancelRef} data-testid="pdfx-action-review-cancel" onClick={() => onClose(null)}>
            {t("Cancel")}
          </DialogButton>
          <DialogButton data-testid="pdfx-action-review-deliver" onClick={() => onClose({ deliver: true })}>
            {texts.deliverLabel}
          </DialogButton>
          {offered.length ? (
            <DialogButton variant="primary" disabled={!chosen.length} data-testid="pdfx-action-review-apply" onClick={() => onClose({ remedies: chosen })}>
              {texts.applyLabel}
            </DialogButton>
          ) : null}
        </>
      }
    >
      <p id={leadId} className="pdfx-dialog-text">
        {texts.lead}
      </p>
      <ul className="pdfx-review-list">
        {texts.items.map((item, index) => {
          const finding = findings.items[index];
          return (
            <li key={item.id} data-testid="pdfx-review-item" data-kind={finding.kind} data-where={finding.where || ""} data-remedy={item.remedy || ""}>
              <p className="pdfx-review-text">
                <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>{item.text}</span>
              </p>
              {item.choice ? (
                <label className="pdfx-check">
                  <input type="checkbox" checked={chosen.includes(item.remedy)} data-testid={`pdfx-review-remedy-${item.remedy}`} onChange={(event) => toggle(item.remedy, event.target.checked)} />
                  <span>{item.choice}</span>
                </label>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="pdfx-dialog-note">{texts.note}</p>
    </DialogFrame>
  );
}
