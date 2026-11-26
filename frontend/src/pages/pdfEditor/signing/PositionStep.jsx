import { useId, useState } from "react";
import { Trash2 } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { MM_PER_POINT } from "../engine/geometry.js";
import { useDocument, useEditor, useViewer } from "../ui/editorHooks.js";
import { applyPreset, clearField, setFieldMillimetres } from "./certSignFlow.js";
import { FIELD_MIN_SIZE, FIELD_PRESETS, fieldMillimetres } from "./fieldGeometry.js";
import { useSignFlow } from "./signingHooks.js";

// Step 3 of "Sign with certificate" (UX specification 7.11): where the visible signature goes ("Vị trí ký").
// The user drags a rectangle on any page (the certSign tool of the interaction reducer; SignFieldLayer.jsx
// draws it with the real stamp inside and lets it be moved and resized). Without dragging: a preset place on a
// chosen page, and the four numbers in millimetres. The rectangle is never smaller than 72 x 36 pt.
//
// Test hooks: pdfx-sign-step-3 (data-has-field, data-field-page); pdfx-sign-preset-page,
// pdfx-action-sign-preset-<bottomRight | bottomLeft | topRight>; pdfx-sign-field-left / -top / -width / -height
// (millimetres), pdfx-action-sign-field-clear.

const NUMBER_KEYS = ["left", "top", "width", "height"];

function NumberField({ label, value, min, testId, onCommit }) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft === null) return;
    const number = Number(String(draft).replace(",", "."));
    setDraft(null);
    if (Number.isFinite(number)) onCommit(number);
  };
  return (
    <div className="pdfx-sign-number">
      <label className="pdfx-sign-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="pdfx-input"
        type="number"
        inputMode="decimal"
        step="1"
        min={min}
        value={draft === null ? value : draft}
        data-testid={testId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
        }}
      />
    </div>
  );
}

export default function PositionStep() {
  const { t, formatNumber } = useI18n();
  const editor = useEditor();
  const flow = useSignFlow();
  const pages = useDocument((state) => state.pages);
  const currentPageNumber = useViewer((state) => state.currentPageNumber);
  const [chosenPage, setChosenPage] = useState(null); // a page id once the user chose one
  const pageSelectId = useId();
  if (!flow) return null;

  const field = flow.field;
  const fieldIndex = field ? pages.findIndex((page) => page.id === field.pageId) : -1;
  const fieldPage = fieldIndex >= 0 ? pages[fieldIndex] : null;
  const fallbackPage = pages[Math.max(0, Math.min(pages.length, currentPageNumber || 1) - 1)];
  const presetPage = pages.find((page) => page.id === chosenPage) || fallbackPage;
  const numbers = fieldPage ? fieldMillimetres(field, fieldPage) : null;
  const labels = { left: t("From the left (mm)"), top: t("From the top (mm)"), width: t("Width (mm)"), height: t("Height (mm)") };
  const mm = (points) => formatNumber(points * MM_PER_POINT, { maximumFractionDigits: 1 });
  const place = (preset) => {
    if (!presetPage || !applyPreset(editor, presetPage.id, preset)) return;
    // the rectangle takes the keyboard, so that the arrow keys adjust it at once
    requestAnimationFrame(() => editor.getElement("viewer")?.querySelector("[data-sign-field]")?.focus({ preventScroll: true }));
  };

  return (
    <div className="pdfx-sign-step" data-testid="pdfx-sign-step-3" data-has-field={fieldPage ? "true" : "false"} data-field-page={fieldIndex >= 0 ? fieldIndex + 1 : ""}>
      <p className="pdfx-sign-lead">{fieldPage ? t("Drag the rectangle to move it, or drag its handles to resize it. Drag somewhere else to draw a new one.") : t("Drag a rectangle on a page where the signature should appear.")}</p>
      <p className="pdfx-sign-hint">{t("With the keyboard: choose a place below. The rectangle then has the keyboard: the arrow keys move it, with Shift in larger steps.")}</p>

      <fieldset className="pdfx-sign-group">
        <legend>{t("Place it without dragging")}</legend>
        <label className="pdfx-sign-label" htmlFor={pageSelectId}>
          {t("Page")}
        </label>
        <select id={pageSelectId} className="pdfx-input" value={presetPage?.id || ""} data-testid="pdfx-sign-preset-page" onChange={(event) => setChosenPage(event.target.value)}>
          {pages.map((page, index) => (
            <option key={page.id} value={page.id}>
              {t("Page {number}", { number: index + 1 })}
            </option>
          ))}
        </select>
        <div className="pdfx-sign-row pdfx-sign-row-wrap">
          {FIELD_PRESETS.map((preset) => (
            <button key={preset} type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid={`pdfx-action-sign-preset-${preset}`} onClick={() => place(preset)}>
              <span className="pdfx-btn-label">{preset === "bottomRight" ? t("Bottom right") : preset === "bottomLeft" ? t("Bottom left") : t("Top right")}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {numbers ? (
        <fieldset className="pdfx-sign-group">
          <legend>{t("Signature position on page {number}", { number: fieldIndex + 1 })}</legend>
          <div className="pdfx-sign-numbers">
            {NUMBER_KEYS.map((key) => (
              <NumberField key={key} label={labels[key]} value={numbers[key]} min={0} testId={`pdfx-sign-field-${key}`} onCommit={(value) => setFieldMillimetres(editor, { [key]: value })} />
            ))}
          </div>
          <p className="pdfx-sign-hint">{t("Measured from the top-left corner of the page as you see it. The smallest size is {width} × {height} mm.", { width: mm(FIELD_MIN_SIZE[0]), height: mm(FIELD_MIN_SIZE[1]) })}</p>
          <div className="pdfx-sign-actions pdfx-sign-actions-start">
            <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-sign-field-clear" onClick={() => clearField(editor)}>
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="pdfx-btn-label">{t("Remove this position")}</span>
            </button>
          </div>
        </fieldset>
      ) : null}
      {flow.run?.failed && flow.run.message ? (
        <p className="pdfx-sign-error" role="alert" data-testid="pdfx-sign-run-error">
          {flow.run.message}
        </p>
      ) : null}
    </div>
  );
}
