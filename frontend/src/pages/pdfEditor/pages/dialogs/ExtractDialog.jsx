import { useId, useRef, useState } from "react";
import { FileOutput } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import DialogFrame from "../../ui/dialogs/DialogFrame.jsx";
import { useDocument } from "../../ui/editorHooks.js";
import { extractFileName, formatPageRange, parsePageRange } from "../pageLogic.js";
import { DialogButtons, FormRow } from "./parts.jsx";

// Extract (UX specification 7.9): a new PDF of some pages of the document, downloaded as
// "<name>-pages-3-5.pdf". The field starts with the selected pages and can be changed ("1-3, 7"); the pages
// keep the order they have in the document. "Also remove these pages from this document" is off by default
// and cannot be chosen when every page would go.
// Props: pageIds. onClose({ pageIds, remove }) extracts; onClose() cancels.
//
// Test hooks: pdfx-extract-range, pdfx-extract-range-error, pdfx-extract-name, pdfx-extract-remove,
// pdfx-action-dialog-confirm / -cancel.

export default function ExtractDialog({ pageIds = [], onClose }) {
  const { t } = useI18n();
  const pages = useDocument((state) => state.pages);
  const fileName = useDocument((state) => state.fileName);
  const id = useId();
  const rangeRef = useRef(null);
  const [range, setRange] = useState(() => formatPageRange(pageIds.map((pageId) => pages.findIndex((page) => page.id === pageId) + 1)));
  const [remove, setRemove] = useState(false);
  const [checked, setChecked] = useState(false);

  const parsed = parsePageRange(range, pages.length, { allWords: [t("All")] });
  // an extract keeps the order of the document, whatever order the numbers were typed in
  const numbers = parsed.ok ? [...parsed.indices].sort((a, b) => a - b).map((position) => position + 1) : [];
  const everything = numbers.length >= pages.length;
  let problem = null;
  if (!parsed.ok) {
    if (parsed.problem === "empty") problem = t("Type the pages to extract.");
    else if (parsed.problem === "bounds") problem = pages.length === 1 ? t("{token} is not a page of this document: it has 1 page.", { token: parsed.token }) : t("{token} is not a page of this document: it has {count} pages.", { token: parsed.token, count: pages.length });
    else problem = t("{token} is not a page number or a range.", { token: parsed.token });
  }

  const confirm = () => {
    setChecked(true);
    if (!parsed.ok) return;
    onClose({ pageIds: numbers.map((number) => pages[number - 1].id), remove: remove && !everything });
  };

  return (
    <DialogFrame title={t("Extract pages")} icon={FileOutput} initialFocusRef={rangeRef} onClose={() => onClose()} footer={<DialogButtons confirmLabel={t("Extract")} onCancel={() => onClose()} onConfirm={confirm} />}>
      <div className="pdfx-pform" data-testid="pdfx-pform-extract">
        <p className="pdfx-dialog-text">{t("The pages are saved as a new PDF file. This document stays open.")}</p>
        <FormRow
          label={t("Pages")}
          htmlFor={`${id}-range`}
          note={
            parsed.ok ? (
              <span data-testid="pdfx-extract-name" data-count={numbers.length}>
                {numbers.length === 1 ? t("1 page, saved as {name}", { name: extractFileName(fileName, numbers) }) : t("{count} pages, saved as {name}", { count: numbers.length, name: extractFileName(fileName, numbers) })}
              </span>
            ) : (
              t("Numbers and ranges, for example 1-3, 7.")
            )
          }
          error={checked && problem ? <span data-testid="pdfx-extract-range-error">{problem}</span> : null}
          errorId={`${id}-range-error`}
        >
          <input
            ref={rangeRef}
            id={`${id}-range`}
            className="pdfx-input pdfx-pform-grow"
            value={range}
            spellCheck="false"
            autoComplete="off"
            aria-invalid={checked && problem ? "true" : undefined}
            aria-describedby={`${id}-range-error`}
            data-testid="pdfx-extract-range"
            onChange={(event) => setRange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              confirm();
            }}
          />
        </FormRow>
        <label className="pdfx-pform-check" data-disabled={everything ? "true" : "false"}>
          <input type="checkbox" checked={remove && !everything} disabled={everything} data-testid="pdfx-extract-remove" onChange={(event) => setRemove(event.target.checked)} />
          <span>{t("Also remove these pages from this document")}</span>
        </label>
        {everything ? <p className="pdfx-pform-note">{t("A document needs at least one page, so all pages cannot be removed.")}</p> : null}
      </div>
    </DialogFrame>
  );
}
