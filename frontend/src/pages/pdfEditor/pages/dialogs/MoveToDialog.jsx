import { useId, useRef, useState } from "react";
import { ArrowUpDown } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import DialogFrame from "../../ui/dialogs/DialogFrame.jsx";
import { useDocument } from "../../ui/editorHooks.js";
import { orderedSelection, readPageNumber } from "../pageLogic.js";
import { DialogButtons, FormRow } from "./parts.jsx";

// "Move to position…" (UX specification 7.9): reordering without dragging. The pages are taken out and put
// back so that the first of them is page N; several pages stay together in their order.
// Props: pageIds. onClose(position) moves (a 1-based number); onClose() cancels.
//
// Test hooks: pdfx-move-position, pdfx-action-dialog-confirm / -cancel.

export default function MoveToDialog({ pageIds = [], onClose }) {
  const { t } = useI18n();
  const pages = useDocument((state) => state.pages);
  const id = useId();
  const inputRef = useRef(null);
  const moving = orderedSelection(
    pages.map((page) => page.id),
    pageIds
  );
  const firstNumber = pages.findIndex((page) => page.id === moving[0]) + 1;
  // the last place the first moved page can have
  const maximum = Math.max(1, pages.length - moving.length + 1);
  const [position, setPosition] = useState(String(Math.min(firstNumber || 1, maximum)));
  const [checked, setChecked] = useState(false);
  const value = readPageNumber(position, maximum);

  const confirm = () => {
    setChecked(true);
    if (value === null) return;
    onClose(value);
  };

  return (
    <DialogFrame title={t("Move to position")} icon={ArrowUpDown} initialFocusRef={inputRef} onClose={() => onClose()} footer={<DialogButtons confirmLabel={t("Move")} onCancel={() => onClose()} onConfirm={confirm} />}>
      <div className="pdfx-pform" data-testid="pdfx-pform-move">
        <p className="pdfx-dialog-text">{moving.length === 1 ? t("Page {page} becomes the page with this number.", { page: firstNumber }) : t("The {count} selected pages are placed together, starting at this page number.", { count: moving.length })}</p>
        <FormRow label={t("New position")} htmlFor={`${id}-position`} error={checked && value === null ? t("Type a number between 1 and {max}.", { max: maximum }) : null} errorId={`${id}-error`}>
          <input
            ref={inputRef}
            id={`${id}-position`}
            className="pdfx-input pdfx-pform-number"
            type="number"
            inputMode="numeric"
            min={1}
            max={maximum}
            step={1}
            value={position}
            aria-invalid={checked && value === null ? "true" : undefined}
            aria-describedby={`${id}-error`}
            data-testid="pdfx-move-position"
            onChange={(event) => setPosition(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              confirm();
            }}
          />
          <span className="pdfx-pform-unit">{t("of {count}", { count: maximum })}</span>
        </FormRow>
      </div>
    </DialogFrame>
  );
}
