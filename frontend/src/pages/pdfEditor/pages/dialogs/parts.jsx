import { useId } from "react";
import { useI18n } from "../../../../context/I18nContext";
import { cx } from "../../ui/classNames.js";
import { DialogButton } from "../../ui/dialogs/DialogFrame.jsx";

// The form parts the dialogs of the pages feature share (styles/pages.css, .pdfx-pform-*): a labelled row,
// a group of radio buttons, the "before / after page N" row, and the Cancel / confirm buttons of the footer.
// The frame is the editor's own ui/dialogs/DialogFrame.jsx. Enter in a field confirms the dialog (the fields
// pass onEnter to their inputs).

/** A row of a form: the label on the left, the control(s) on the right, a note and an error under them. */
export function FormRow({ label, htmlFor, labelId, note, error, errorId, children, testId }) {
  return (
    <div className="pdfx-pform-row" data-testid={testId}>
      {htmlFor ? (
        <label className="pdfx-pform-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="pdfx-pform-label" id={labelId}>
          {label}
        </span>
      )}
      <div className="pdfx-pform-control">
        <div className="pdfx-pform-inline">{children}</div>
        {note ? <p className="pdfx-pform-note">{note}</p> : null}
        <p className="pdfx-pform-error" id={errorId} role="alert">
          {error || null}
        </p>
      </div>
    </div>
  );
}

/** Radio buttons that look like a pair of choices. options: [{ value, caption, testId }]. */
export function Choice({ value, options, onChange, labelledBy }) {
  const group = useId();
  return (
    <div className="pdfx-pform-choice" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((option) => (
        <label key={option.value} className={cx("pdfx-pform-choice-item", value === option.value ? "pdfx-pform-choice-on" : null)}>
          <input type="radio" name={group} value={option.value} checked={value === option.value} data-testid={option.testId} onChange={() => onChange(option.value)} />
          <span>{option.caption}</span>
        </label>
      ))}
    </div>
  );
}

/** "Before / After" + "page [3] of 12": where new pages go. */
export function PlaceRow({ place, pageNumber, pageCount, onPlace, onPageNumber, error, onEnter }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <FormRow label={t("Insert")} htmlFor={`${id}-number`} error={error} errorId={`${id}-error`}>
      <select className="pdfx-input" aria-label={t("Before or after")} value={place} data-testid="pdfx-place-side" onChange={(event) => onPlace(event.target.value)}>
        <option value="before">{t("Before page")}</option>
        <option value="after">{t("After page")}</option>
      </select>
      <input
        id={`${id}-number`}
        className="pdfx-input pdfx-pform-number"
        type="number"
        inputMode="numeric"
        min={1}
        max={pageCount}
        step={1}
        value={pageNumber}
        aria-label={t("Page number")}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={`${id}-error`}
        data-testid="pdfx-place-page"
        onChange={(event) => onPageNumber(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onEnter?.(event);
        }}
      />
      <span className="pdfx-pform-unit">{t("of {count}", { count: pageCount })}</span>
    </FormRow>
  );
}

/** Cancel and the confirming button of a dialog footer. */
export function DialogButtons({ confirmLabel, onCancel, onConfirm }) {
  const { t } = useI18n();
  return (
    <>
      <DialogButton data-testid="pdfx-action-dialog-cancel" onClick={onCancel}>
        {t("Cancel")}
      </DialogButton>
      <DialogButton variant="primary" data-testid="pdfx-action-dialog-confirm" onClick={onConfirm}>
        {confirmLabel}
      </DialogButton>
    </>
  );
}
