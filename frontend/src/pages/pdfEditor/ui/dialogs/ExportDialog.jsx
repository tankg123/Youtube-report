import { useId, useRef, useState } from "react";
import { EyeOff, Info, Settings2, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import { FILE_EXTENSION } from "../fileNames.js";
import { cleanBaseName, describePlan } from "../outputReport.js";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// The question before an output is built (UX specification 7.7 "Applying", 7.8, 8): opened by
// actions.buildOutput() for Download, Print, Extract and the document that gets signed, whenever marks are
// pending, a text box will become a picture, or the user asked for the options.
//
//   with pending marks   an alert dialog: what will be removed on how many pages, that this cannot be undone in
//                        the file, that the original file and the marks in the editor stay as they are; the
//                        keyboard starts on Cancel and the confirm button is red
//   always               what the file may leave out ("Remove hidden information"), that signatures of the
//                        source are not kept, and for a download the name of the file
//
// Props: purpose, plan (ui/outputReport.js planOutput), suggestedName (base name without ".pdf"),
// defaults { removeProperties, removeBookmarks }. onClose({ baseName, removeProperties, removeBookmarks }) =
// go on; onClose(null), Escape or the X = nothing is built.
// Test hooks: pdfx-dialog-export; pdfx-export-warning, pdfx-export-facts (data-redact, data-blur, data-pages,
// data-replaced), pdfx-export-pictures (data-count), pdfx-export-signatures, pdfx-export-option-properties /
// -bookmarks, pdfx-export-name, pdfx-action-export-cancel / -confirm.
export default function ExportDialog({ purpose = "download", plan, suggestedName = "", defaults = {}, onClose }) {
  const { t } = useI18n();
  const texts = describePlan(plan, purpose);
  const [removeProperties, setRemoveProperties] = useState(Boolean(defaults.removeProperties ?? (texts.redaction && plan.hasProperties)));
  const [removeBookmarks, setRemoveBookmarks] = useState(Boolean(defaults.removeBookmarks));
  const [name, setName] = useState(suggestedName);
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const warningId = useId();
  const nameId = useId();
  const careful = texts.redaction || Boolean(texts.pictures);
  const withName = purpose === "download";

  const confirm = () => onClose({ baseName: withName ? cleanBaseName(name) || suggestedName : null, removeProperties, removeBookmarks });

  return (
    <DialogFrame
      alert={careful}
      size="md"
      tone={texts.redaction ? "danger" : texts.pictures ? "warning" : "default"}
      icon={texts.redaction ? EyeOff : texts.pictures ? TriangleAlert : Settings2}
      title={texts.title}
      describedBy={careful ? warningId : undefined}
      initialFocusRef={careful ? cancelRef : undefined}
      onClose={() => onClose(null)}
      footer={
        <>
          <DialogButton ref={cancelRef} data-testid="pdfx-action-export-cancel" onClick={() => onClose(null)}>
            {texts.redaction ? t("Cancel") : texts.pictures ? t("Go back") : t("Cancel")}
          </DialogButton>
          <DialogButton ref={confirmRef} variant={texts.redaction ? "danger" : "primary"} data-testid="pdfx-action-export-confirm" onClick={confirm}>
            {texts.confirmLabel}
          </DialogButton>
        </>
      }
    >
      <div id={warningId}>
        {texts.warning ? (
          <p className="pdfx-callout" data-tone="danger" data-testid="pdfx-export-warning">
            <TriangleAlert size={18} strokeWidth={1.75} aria-hidden="true" />
            <span>{texts.warning}</span>
          </p>
        ) : null}
        {texts.facts.length ? (
          <ul className="pdfx-dialog-facts" data-testid="pdfx-export-facts" data-redact={plan.redact} data-blur={plan.blur} data-pages={plan.markPages} data-replaced={plan.replaced}>
            {texts.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        ) : null}
        {texts.blurNote ? <p className="pdfx-dialog-note">{texts.blurNote}</p> : null}
        {texts.pending ? <p className="pdfx-dialog-note">{texts.pending}</p> : null}
        {texts.pictures ? (
          <p className="pdfx-callout" data-tone="warning" data-testid="pdfx-export-pictures" data-count={plan.pictureText.length}>
            <TriangleAlert size={18} strokeWidth={1.75} aria-hidden="true" />
            <span>{texts.pictures}</span>
          </p>
        ) : null}
      </div>
      {texts.signatures || texts.restricted ? (
        <p className="pdfx-callout" data-tone="info" data-testid="pdfx-export-signatures">
          <Info size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{[texts.signatures, texts.restricted].filter(Boolean).join(" ")}</span>
        </p>
      ) : null}

      <fieldset className="pdfx-fieldset">
        <legend>{t("Remove hidden information")}</legend>
        <label className="pdfx-check">
          <input type="checkbox" checked={removeProperties} disabled={!plan.hasProperties && !removeProperties} data-testid="pdfx-export-option-properties" onChange={(event) => setRemoveProperties(event.target.checked)} />
          <span>
            {t("Document properties (title, author, subject, keywords)")}
            {plan.hasProperties ? null : <em> {t("(this document has none)")}</em>}
          </span>
        </label>
        <label className="pdfx-check">
          <input type="checkbox" checked={removeBookmarks} disabled={!plan.hasOutline && !removeBookmarks} data-testid="pdfx-export-option-bookmarks" onChange={(event) => setRemoveBookmarks(event.target.checked)} />
          <span>
            {t("Bookmarks (the outline of the document)")}
            {plan.hasOutline ? null : <em> {t("(this document has none)")}</em>}
          </span>
        </label>
        <p className="pdfx-fieldset-note">{t("Attached files are never copied into the file that is created.")}</p>
      </fieldset>

      {withName ? (
        <div className="pdfx-form-row">
          <label htmlFor={nameId}>{t("Download as")}</label>
          <span className="pdfx-name-field">
            <input
              id={nameId}
              type="text"
              className="pdfx-input"
              spellCheck="false"
              autoComplete="off"
              data-testid="pdfx-export-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                // Enter in the name must not apply a redaction by accident: it finishes the name and puts the
                // keyboard on the button, where a second, deliberate Enter applies
                if (careful) confirmRef.current?.focus();
                else confirm();
              }}
            />
            <span aria-hidden="true">{FILE_EXTENSION}</span>
          </span>
        </div>
      ) : null}
    </DialogFrame>
  );
}
