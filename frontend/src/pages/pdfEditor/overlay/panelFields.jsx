import { useId, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { normalizeColor } from "../model/schema.js";
import { cx } from "../ui/classNames.js";
import { SWATCHES } from "./palettes.js";

// The small controls of the properties panel (UX specification 6): a number field with steppers (the keyboard
// alternative to every drag), the colour control (swatches, the colours used last, a hex field and the
// browser's colour picker), groups of toggle buttons, a slider with its number. Styles: styles/overlay.css.
//
// A control shows a value the selected objects do not agree on as empty ("mixed"); changing it gives all of
// them the new value.

/** What a colour code looks like (shown in the empty hex field; not a text to translate). */
const HEX_PATTERN = "#rrggbb";

export function Section({ heading, testId, children }) {
  return (
    <section className="pdfx-prop-section" data-testid={testId}>
      {heading ? <h3 className="pdfx-prop-heading">{heading}</h3> : null}
      {children}
    </section>
  );
}

export function Row({ caption, htmlFor, children }) {
  return (
    <div className="pdfx-prop-row">
      {htmlFor ? (
        <label className="pdfx-prop-caption" htmlFor={htmlFor}>
          {caption}
        </label>
      ) : (
        <span className="pdfx-prop-caption">{caption}</span>
      )}
      <div className="pdfx-prop-control">{children}</div>
    </div>
  );
}

const trim = (value, digits) => {
  const rounded = Number(value.toFixed(digits));
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

/** "12,5" and "12.5" both mean twelve and a half. */
const parseNumber = (text) => Number(String(text).trim().replace(",", "."));

/**
 * A number with steppers. The value is committed on Enter, on blur and with every step (arrow keys in the
 * field: one step, with Shift ten).
 *   value      the number shown (null with `mixed`)
 *   presets    values offered in a small menu next to the field
 *   onCommit(number)
 */
export function NumberField({ value, mixed = false, min = -Infinity, max = Infinity, step = 1, digits = 1, unit, caption, presets, testId, disabled = false, onCommit }) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(null);
  const known = !mixed && Number.isFinite(value);
  const shown = draft ?? (known ? trim(value, digits) : "");
  const clamp = (number) => Math.min(max, Math.max(min, number));
  const commit = (text) => {
    setDraft(null);
    const number = parseNumber(text);
    if (text.trim() === "" || !Number.isFinite(number)) return;
    const next = clamp(number);
    if (!known || Math.abs(next - value) > 1e-9) onCommit(next);
  };
  const stepBy = (count) => {
    const base = draft !== null && Number.isFinite(parseNumber(draft)) ? parseNumber(draft) : known ? value : 0;
    setDraft(null);
    onCommit(clamp(Number((base + count * step).toFixed(6))));
  };
  return (
    <span className="pdfx-number" data-mixed={mixed ? "true" : undefined}>
      <input
        id={id}
        className="pdfx-input pdfx-number-input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={caption}
        value={shown}
        placeholder={mixed ? "—" : undefined}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null) commit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (draft !== null) commit(draft);
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            stepBy((event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1));
          } else if (event.key === "Escape" && draft !== null) {
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
      {unit ? <span className="pdfx-number-unit">{unit}</span> : null}
      <span className="pdfx-number-steps">
        <button type="button" tabIndex={-1} disabled={disabled} aria-label={t("Increase: {name}", { name: caption })} data-testid={testId ? `${testId}-up` : undefined} onClick={() => stepBy(1)}>
          <ChevronUp size={12} strokeWidth={2.25} aria-hidden="true" />
        </button>
        <button type="button" tabIndex={-1} disabled={disabled} aria-label={t("Decrease: {name}", { name: caption })} data-testid={testId ? `${testId}-down` : undefined} onClick={() => stepBy(-1)}>
          <ChevronDown size={12} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </span>
      {presets ? (
        <select
          className="pdfx-input pdfx-number-presets"
          aria-label={t("Common values: {name}", { name: caption })}
          value=""
          disabled={disabled}
          data-testid={testId ? `${testId}-presets` : undefined}
          onChange={(event) => {
            const number = Number(event.target.value);
            if (Number.isFinite(number)) onCommit(clamp(number));
          }}
        >
          <option value="" />
          {presets.map((preset) => (
            <option key={preset} value={preset}>
              {trim(preset, digits)}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}

function Swatch({ entry, current, onPick }) {
  const { t } = useI18n();
  const caption = entry.label ? t(entry.label) : entry.value;
  return (
    <button
      type="button"
      className="pdfx-swatch"
      aria-label={caption}
      aria-pressed={current === entry.value ? "true" : "false"}
      data-tip={caption}
      data-color={entry.value}
      style={{ backgroundColor: entry.value }}
      onClick={() => onPick(entry.value)}
    />
  );
}

/**
 * The colour control: swatches, the colours used last, a hex field and the browser's colour picker.
 *   value      "#rrggbb" | null (no colour; only offered with allowNone)
 *   palette    the swatches (default: the eight of UX specification 6)
 *   recent     the colours used last
 *   onChange(colour | null)
 */
export function ColorField({ value, mixed = false, allowNone = false, palette = SWATCHES, recent = [], caption, testId, onChange }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(null);
  const current = mixed ? undefined : value;
  const commitHex = (text) => {
    setDraft(null);
    const colour = normalizeColor(text.trim().startsWith("#") ? text : `#${text.trim()}`);
    if (colour && colour !== current) onChange(colour);
  };
  const others = recent.filter((colour) => !palette.some((entry) => entry.value === colour));
  return (
    <div className="pdfx-color" role="group" aria-label={caption} data-testid={testId} data-value={mixed ? "mixed" : value === null ? "none" : value}>
      <div className="pdfx-color-swatches">
        {allowNone ? (
          <button type="button" className="pdfx-swatch pdfx-swatch-none" aria-label={t("No colour")} aria-pressed={current === null ? "true" : "false"} data-tip={t("No colour")} data-color="none" onClick={() => onChange(null)} />
        ) : null}
        {palette.map((entry) => (
          <Swatch key={entry.value} entry={entry} current={current} onPick={onChange} />
        ))}
      </div>
      {others.length ? (
        <div className="pdfx-color-swatches" role="group" aria-label={t("Colours used last")}>
          {others.map((colour) => (
            <Swatch key={colour} entry={{ value: colour }} current={current} onPick={onChange} />
          ))}
        </div>
      ) : null}
      <div className="pdfx-color-custom">
        <input
          className="pdfx-input pdfx-color-hex"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={7}
          aria-label={t("Colour code: {name}", { name: caption })}
          placeholder={mixed ? "—" : HEX_PATTERN}
          value={draft ?? (current || "")}
          data-testid={testId ? `${testId}-hex` : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== null) commitHex(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (draft !== null) commitHex(draft);
            } else if (event.key === "Escape" && draft !== null) {
              event.stopPropagation();
              setDraft(null);
            }
          }}
        />
        <input className="pdfx-color-native" type="color" aria-label={t("Choose a colour: {name}", { name: caption })} value={current || "#000000"} onChange={(event) => onChange(normalizeColor(event.target.value))} />
      </div>
    </div>
  );
}

/**
 * A row of buttons of which one is pressed (alignment, line style) or, with `multiple`, each on its own
 * (bold, italic, underline: `value` is then the list of pressed ids).
 * options: [{ id, caption, icon?, text? }]
 */
export function ToggleGroup({ caption, options, value, multiple = false, testId, onChange }) {
  return (
    <div className="pdfx-toggle-group" role="group" aria-label={caption} data-testid={testId}>
      {options.map((option) => {
        const Icon = option.icon;
        const pressed = multiple ? Array.isArray(value) && value.includes(option.id) : value === option.id;
        return (
          <button
            key={String(option.id)}
            type="button"
            className={cx("pdfx-btn", option.text ? "pdfx-btn-text" : null)}
            aria-label={option.caption}
            aria-pressed={pressed ? "true" : "false"}
            data-tip={option.text ? undefined : option.caption}
            data-option={String(option.id)}
            onClick={() => onChange(option.id, !pressed)}
          >
            {Icon ? <Icon size={16} strokeWidth={1.75} aria-hidden="true" /> : null}
            {option.text ? <span className="pdfx-btn-label">{option.text}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A slider from 0 to 100 % with its number (opacity). */
export function PercentField({ value, mixed = false, caption, testId, onChange }) {
  const percent = mixed || !Number.isFinite(value) ? null : Math.round(value * 100);
  return (
    <span className="pdfx-percent">
      <input className="pdfx-percent-range" type="range" min={0} max={100} step={1} aria-label={caption} value={percent ?? 100} data-testid={testId ? `${testId}-range` : undefined} onChange={(event) => onChange(Number(event.target.value) / 100)} />
      <NumberField value={percent} mixed={percent === null} min={0} max={100} step={5} digits={0} unit="%" caption={caption} testId={testId} onCommit={(number) => onChange(number / 100)} />
    </span>
  );
}

export function SelectField({ value, mixed = false, options, caption, testId, onChange }) {
  return (
    <select className="pdfx-input pdfx-select" aria-label={caption} value={mixed ? "" : String(value)} data-testid={testId} onChange={(event) => onChange(event.target.value)}>
      {mixed ? <option value="" /> : null}
      {options.map((option) => (
        <option key={String(option.id)} value={String(option.id)}>
          {option.caption}
        </option>
      ))}
    </select>
  );
}
