import { useId, useRef, useState } from "react";
import { FilePlus2 } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import DialogFrame from "../../ui/dialogs/DialogFrame.jsx";
import { useDocument } from "../../ui/editorHooks.js";
import { MM_PER_POINT } from "../../ui/pageSize.js";
import { BLANK_FORMATS, CUSTOM_SIZE_MM, blankPageSize, insertionIndex, parseDecimal, placeOfIndex, readPageNumber } from "../pageLogic.js";
import { Choice, DialogButtons, FormRow, PlaceRow } from "./parts.jsx";

// Insert > Blank page (UX specification 7.9): the size (like the page next to it, a paper format, or typed
// in millimetres), the orientation of a paper format, before or after which page, and how many.
// Props: index (where the pages go by default: 0 ... page count). onClose({ size: [w, h] in points, index,
// count }) inserts; onClose() cancels.
//
// Test hooks: pdfx-blank-format, pdfx-blank-orientation-portrait / -landscape, pdfx-blank-width,
// pdfx-blank-height, pdfx-place-side, pdfx-place-page, pdfx-blank-count, pdfx-blank-size (data-width,
// data-height in points), pdfx-action-dialog-confirm / -cancel.

/** Paper formats are proper names: the same in both languages. */
const FORMAT_NAMES = Object.freeze({ A4: "A4", A3: "A3", A5: "A5", LETTER: "Letter", LEGAL: "Legal" });
const MAX_COUNT = 100;
/** The unit sign is the same in both languages. */
const MILLIMETRES = "mm";

export default function InsertBlankDialog({ index = 0, onClose }) {
  const { t, formatNumber } = useI18n();
  const pages = useDocument((state) => state.pages);
  const id = useId();
  const formatRef = useRef(null);
  const [format, setFormat] = useState("current");
  const [orientation, setOrientation] = useState("portrait");
  const [width, setWidth] = useState("210");
  const [height, setHeight] = useState("297");
  const [where, setWhere] = useState(() => placeOfIndex(index, pages.length));
  const [count, setCount] = useState("1");
  const [checked, setChecked] = useState(false);

  const pageNumber = readPageNumber(where.pageNumber, pages.length);
  const reference = pageNumber ? pages[pageNumber - 1] : null;
  const size = blankPageSize({ format, orientation, widthMm: parseDecimal(width), heightMm: parseDecimal(height), page: reference });
  const amount = Number(count);
  const countValid = /^\d+$/.test(count.trim()) && amount >= 1 && amount <= MAX_COUNT;
  const millimetres = (points) => formatNumber(Math.round(points * MM_PER_POINT * 10) / 10, { maximumFractionDigits: 1 });
  const describe = (points) => t("{width} × {height} mm", { width: millimetres(points[0]), height: millimetres(points[1]) });
  const sizeLimits = t("Type a size between {min} and {max} mm.", { min: CUSTOM_SIZE_MM.min, max: CUSTOM_SIZE_MM.max });

  const confirm = () => {
    setChecked(true);
    if (!size.ok || !pageNumber || !countValid) return;
    onClose({ size: size.size, index: insertionIndex(pages.length, pageNumber, where.place), count: amount });
  };
  const onEnter = (event) => {
    event.preventDefault();
    confirm();
  };
  const enterKey = (event) => {
    if (event.key === "Enter") onEnter(event);
  };

  const optionLabel = (value) => {
    if (value === "current") return pageNumber ? t("Same as page {page}", { page: pageNumber }) : t("Same as the page next to it");
    if (value === "custom") return t("Custom size");
    return FORMAT_NAMES[value];
  };

  return (
    <DialogFrame title={t("Insert blank page")} icon={FilePlus2} initialFocusRef={formatRef} onClose={() => onClose()} footer={<DialogButtons confirmLabel={t("Insert")} onCancel={() => onClose()} onConfirm={confirm} />}>
      <div className="pdfx-pform" data-testid="pdfx-pform-blank">
        <FormRow label={t("Page size")} htmlFor={`${id}-format`} note={size.ok ? describe(size.size) : null}>
          <select ref={formatRef} id={`${id}-format`} className="pdfx-input pdfx-pform-grow" value={format} data-testid="pdfx-blank-format" onChange={(event) => setFormat(event.target.value)} onKeyDown={enterKey}>
            {BLANK_FORMATS.map((value) => (
              <option key={value} value={value}>
                {optionLabel(value)}
              </option>
            ))}
          </select>
          <span className="pdfx-visually-hidden" data-testid="pdfx-blank-size" data-width={size.ok ? size.size[0] : ""} data-height={size.ok ? size.size[1] : ""} />
        </FormRow>
        {format === "custom" ? (
          <FormRow label={t("Width × height")} htmlFor={`${id}-width`} error={checked && !size.ok ? sizeLimits : null} errorId={`${id}-size-error`}>
            <input
              id={`${id}-width`}
              className="pdfx-input pdfx-pform-number"
              inputMode="decimal"
              value={width}
              aria-label={t("Width in millimetres")}
              aria-invalid={checked && !size.ok && size.problem === "width" ? "true" : undefined}
              aria-describedby={`${id}-size-error`}
              data-testid="pdfx-blank-width"
              onChange={(event) => setWidth(event.target.value)}
              onKeyDown={enterKey}
            />
            <span className="pdfx-pform-unit" aria-hidden="true">
              ×
            </span>
            <input
              className="pdfx-input pdfx-pform-number"
              inputMode="decimal"
              value={height}
              aria-label={t("Height in millimetres")}
              aria-invalid={checked && !size.ok && size.problem === "height" ? "true" : undefined}
              aria-describedby={`${id}-size-error`}
              data-testid="pdfx-blank-height"
              onChange={(event) => setHeight(event.target.value)}
              onKeyDown={enterKey}
            />
            <span className="pdfx-pform-unit">{MILLIMETRES}</span>
          </FormRow>
        ) : null}
        {format !== "custom" && format !== "current" ? (
          <FormRow label={t("Orientation")} labelId={`${id}-orientation`}>
            <Choice
              value={orientation}
              labelledBy={`${id}-orientation`}
              onChange={setOrientation}
              options={[
                { value: "portrait", caption: t("Portrait"), testId: "pdfx-blank-orientation-portrait" },
                { value: "landscape", caption: t("Landscape"), testId: "pdfx-blank-orientation-landscape" }
              ]}
            />
          </FormRow>
        ) : null}
        <PlaceRow
          place={where.place}
          pageNumber={where.pageNumber}
          pageCount={pages.length}
          error={checked && !pageNumber ? t("Type a page number between 1 and {count}.", { count: pages.length }) : null}
          onPlace={(place) => setWhere((current) => ({ ...current, place }))}
          onPageNumber={(value) => setWhere((current) => ({ ...current, pageNumber: value }))}
          onEnter={onEnter}
        />
        <FormRow label={t("How many")} htmlFor={`${id}-count`} error={checked && !countValid ? t("Type a number between 1 and {max}.", { max: MAX_COUNT }) : null} errorId={`${id}-count-error`}>
          <input
            id={`${id}-count`}
            className="pdfx-input pdfx-pform-number"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_COUNT}
            step={1}
            value={count}
            aria-invalid={checked && !countValid ? "true" : undefined}
            aria-describedby={`${id}-count-error`}
            data-testid="pdfx-blank-count"
            onChange={(event) => setCount(event.target.value)}
            onKeyDown={enterKey}
          />
        </FormRow>
      </div>
    </DialogFrame>
  );
}
