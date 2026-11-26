import { useRef } from "react";
import { CircleCheck, ExternalLink, Info, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import { useEditor } from "../editorHooks.js";
import { describeReport, summarizeReport } from "../outputReport.js";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// What happened in a build (UX specification 7.7 "Result report"), shown after the file was handed out:
//   per page with marks   removed precisely and verified / converted to an image, with what that costs the page
//                         (links, form fields, sharp text) / replaced text that was only covered
//   every other warning   of the report, as a sentence of messages.js: never dropped
//   the review step       "Check the result before you share the file", with a button that opens the file that
//                         was handed out in a new tab
//
// Props: purpose ("download" | "print" | "sign" | "extract"), summary (ui/outputReport.js summarizeReport),
// fileName (the name of the download, or null), onOpen (opens the built file in a new tab; absent = no button).
// Older callers pass only { purpose, warnings }: actions.reportWarnings().
// Test hooks: pdfx-dialog-report; pdfx-report-headline, pdfx-report-rows with pdfx-report-row (data-page,
// data-path, data-areas, data-covered), pdfx-report-warnings (li[data-code]), pdfx-action-report-open,
// pdfx-action-report-close.
export default function ReportDialog({ purpose = "download", summary, warnings = [], fileName = null, onOpen, onClose }) {
  const { t } = useI18n();
  const { messages } = useEditor();
  const facts = summary || summarizeReport({ warnings });
  const texts = describeReport(facts, { purpose, fileName, describeWarning: messages.describeWarning });
  const closeRef = useRef(null);
  const careful = texts.notes.length > 0 || texts.rows.some((row) => row.tone === "warning");

  return (
    <DialogFrame
      size="md"
      scrollBody
      tone={careful ? "warning" : "success"}
      icon={careful ? Info : CircleCheck}
      title={texts.redacted ? t("Result of the redaction") : t("Notes about the created file")}
      initialFocusRef={closeRef}
      onClose={() => onClose()}
      footer={
        <>
          {typeof onOpen === "function" ? (
            <DialogButton icon={ExternalLink} data-testid="pdfx-action-report-open" onClick={() => onOpen()}>
              {purpose === "download" && fileName ? t("Open the downloaded file in a new tab") : t("Open the created file in a new tab")}
            </DialogButton>
          ) : null}
          <DialogButton ref={closeRef} variant="primary" data-testid="pdfx-action-report-close" onClick={() => onClose()}>
            {t("Close")}
          </DialogButton>
        </>
      }
    >
      <p className="pdfx-dialog-text" data-testid="pdfx-report-headline">
        {texts.headline}
      </p>
      {texts.rows.length ? (
        <ul className="pdfx-report-rows" data-testid="pdfx-report-rows">
          {texts.rows.map((row, index) => {
            const source = facts.rows[index];
            return (
              <li key={row.pageNumber} data-testid="pdfx-report-row" data-page={row.pageNumber} data-path={source.path} data-areas={source.areas} data-covered={source.covered} data-tone={row.tone}>
                <span className="pdfx-report-page">{row.label}</span>
                <span className="pdfx-report-areas">{row.areas}</span>
                <span className="pdfx-report-outcome">
                  <strong>
                    {row.tone === "warning" ? <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" /> : <CircleCheck size={14} strokeWidth={2} aria-hidden="true" />}
                    {row.outcome}
                  </strong>
                  {row.details.map((detail) => (
                    <span key={detail} className="pdfx-report-detail">
                      {detail}
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {texts.notes.length ? (
        <ul className="pdfx-report-list" data-testid="pdfx-report-warnings">
          {texts.notes.map((note, index) => (
            <li key={`${note.code}:${index}`} data-code={note.code}>
              <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{note.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="pdfx-callout" data-tone="info" data-testid="pdfx-report-review">
        <Info size={18} strokeWidth={1.75} aria-hidden="true" />
        <span>{texts.review}</span>
      </p>
    </DialogFrame>
  );
}
