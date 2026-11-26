import { useId, useRef, useState } from "react";
import { FileInput } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import DialogFrame from "../../ui/dialogs/DialogFrame.jsx";
import { useDocument } from "../../ui/editorHooks.js";
import { insertionIndex, parsePageRange, placeOfIndex, readPageNumber } from "../pageLogic.js";
import { DialogButtons, FormRow, PlaceRow } from "./parts.jsx";

// Insert > Pages from PDF, after the file was chosen and opened (UX specification 7.9): which of its pages
// ("All", or numbers and ranges such as "1-3, 7") go before or after which page of the document.
// Props: fileName, pageCount (of the chosen file), index (default place). onClose({ indices, index }) inserts
// (indices: 0-based pages of the file, in the order typed); onClose() cancels and the file is forgotten.
//
// Test hooks: pdfx-pdf-range (aria-invalid), pdfx-pdf-range-error, pdfx-pdf-count (data-count),
// pdfx-place-side, pdfx-place-page, pdfx-action-dialog-confirm / -cancel.

export default function InsertPdfDialog({ fileName, pageCount, index = 0, onClose }) {
  const { t } = useI18n();
  const pages = useDocument((state) => state.pages);
  const id = useId();
  const rangeRef = useRef(null);
  const allWord = t("All");
  const [range, setRange] = useState(allWord);
  const [where, setWhere] = useState(() => placeOfIndex(index, pages.length));
  const [checked, setChecked] = useState(false);

  const parsed = parsePageRange(range, pageCount, { allWords: [allWord] });
  const pageNumber = readPageNumber(where.pageNumber, pages.length);
  let problem = null;
  if (!parsed.ok) {
    if (parsed.problem === "empty") problem = t("Type the pages to insert.");
    else if (parsed.problem === "bounds") problem = pageCount === 1 ? t("{token} is not a page of this file: it has 1 page.", { token: parsed.token }) : t("{token} is not a page of this file: it has {count} pages.", { token: parsed.token, count: pageCount });
    else problem = t("{token} is not a page number or a range.", { token: parsed.token });
  }

  const confirm = () => {
    setChecked(true);
    if (!parsed.ok || !pageNumber) return;
    onClose({ indices: parsed.indices, index: insertionIndex(pages.length, pageNumber, where.place) });
  };
  const onEnter = (event) => {
    event.preventDefault();
    confirm();
  };

  return (
    <DialogFrame
      title={t("Insert pages from a PDF")}
      icon={FileInput}
      subtitle={pageCount === 1 ? t("{name} (1 page)", { name: fileName }) : t("{name} ({count} pages)", { name: fileName, count: pageCount })}
      initialFocusRef={rangeRef}
      onClose={() => onClose()}
      footer={<DialogButtons confirmLabel={t("Insert")} onCancel={() => onClose()} onConfirm={confirm} />}
    >
      <div className="pdfx-pform" data-testid="pdfx-pform-pdf">
        <FormRow
          label={t("Pages")}
          htmlFor={`${id}-range`}
          note={
            <span data-testid="pdfx-pdf-count" data-count={parsed.ok ? parsed.indices.length : 0}>
              {parsed.ok ? (parsed.indices.length === 1 ? t("1 page will be inserted.") : t("{count} pages will be inserted.", { count: parsed.indices.length })) : t("Numbers and ranges, for example 1-3, 7. {all} takes every page.", { all: allWord })}
            </span>
          }
          error={checked && problem ? <span data-testid="pdfx-pdf-range-error">{problem}</span> : null}
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
            data-testid="pdfx-pdf-range"
            onChange={(event) => setRange(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") onEnter(event);
            }}
          />
        </FormRow>
        <PlaceRow
          place={where.place}
          pageNumber={where.pageNumber}
          pageCount={pages.length}
          error={checked && !pageNumber ? t("Type a page number between 1 and {count}.", { count: pages.length }) : null}
          onPlace={(place) => setWhere((current) => ({ ...current, place }))}
          onPageNumber={(value) => setWhere((current) => ({ ...current, pageNumber: value }))}
          onEnter={onEnter}
        />
      </div>
    </DialogFrame>
  );
}
