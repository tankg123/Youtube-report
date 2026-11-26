import { useSyncExternalStore } from "react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDown,
  ArrowUp,
  Bold,
  BringToFront,
  Copy,
  Info,
  Italic,
  LocateFixed,
  SendToBack,
  Trash2,
  TriangleAlert,
  Underline,
  Undo2
} from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { mmToPoints, pointsToMm } from "../engine/geometry.js";
import { TEXT_FONTS, isMark } from "../model/schema.js";
import { objectScreenBox } from "../model/shapes.js";
import { MIXED, canRotate, objectTypeOfKind, screenRotationOf, setObjectScreenPosition, setObjectSize, setScreenRotation, sharedStyle } from "../model/transform.js";
import { toolById } from "../tools/registry.js";
import { BarButton, Chip } from "../ui/controls.jsx";
import DocumentSummary from "../ui/DocumentSummary.jsx";
import { useDocument, useEditor, useFeatureState, useInteraction, useUi } from "../ui/editorHooks.js";
import { lineEndFor, lineOnScreen, uprightFrameOf } from "./geometry.js";
import { MarkReachNote } from "./MarkReach.jsx";
import { FONT_SIZE_PRESETS, FONT_SIZE_RANGE, HIGHLIGHT_SWATCHES, HIGHLIGHT_THICKNESS_PRESETS, LINE_HEIGHT_PRESETS, PEN_WIDTH_PRESETS, REDACTION_SWATCHES, STROKE_WIDTH_PRESETS, SWATCHES } from "./palettes.js";
import { ColorField, NumberField, PercentField, Row, Section, SelectField, ToggleGroup } from "./panelFields.jsx";
import { FEATURE_ID, getRuntime } from "./runtime.js";
import "../styles/overlay.css";

// The properties panel (UX specification 6): what it edits is, in this order,
//   the text box that is being typed in          its text style
//   the selection                                the style the selected objects share, position, size and
//                                                rotation as numbers (the keyboard alternative to every drag),
//                                                the order in the stack, Duplicate and Delete; several objects
//                                                can be aligned with each other
//   the active tool, when it has settings        the style of the next object it makes (remembered per tool)
//   otherwise                                    the summary of the document
// Consecutive changes of one property are ONE undo step (runtime.applyStyle and the coalesce keys below carry
// the selection in them).
//
// Test hooks: pdfx-properties (data-source = "draft" | "editing" | "selection" | "tool" | "none", data-kind =
// the object type(s) or the tool's kind, data-count), pdfx-prop-<key> for the style controls (colour controls
// carry data-value), pdfx-prop-x / -y / -w / -h / -rotation / -length / -angle, pdfx-prop-unit,
// pdfx-action-prop-<command>, pdfx-marks (data-count) with pdfx-mark-row (data-mark-id) and
// pdfx-action-marks-clear, pdfx-text-export-note (data-state = "picture" | "fallback"), pdfx-replaces.

const mixedOr = (value) => (value === MIXED ? undefined : value);
const isMixed = (value) => value === MIXED;
const FAMILY_NAMES = Object.fromEntries(TEXT_FONTS.map((font) => [font.id, font.family]));
const MAX_LISTED_CHARACTERS = 12;
/** The abbreviation of the typographic point: the same in both languages. */
const POINTS = "pt";

/** The style controls of one object type (or of the properties several types share). */
function StyleControls({ style, type, mode, recent, onChange }) {
  const { t } = useI18n();
  const has = (key) => Object.prototype.hasOwnProperty.call(style, key);
  const colourCaption = type === "text" ? t("Text colour") : type === "redact" ? t("Fill colour") : t("Colour");
  const palette = type === "highlight" ? HIGHLIGHT_SWATCHES : type === "redact" ? REDACTION_SWATCHES : SWATCHES;
  const flags = ["bold", "italic", "underline"].filter((key) => style[key] === true);
  return (
    <>
      {has("font") ? (
        <Row caption={t("Font")}>
          <SelectField caption={t("Font")} testId="pdfx-prop-font" value={mixedOr(style.font)} mixed={isMixed(style.font)} options={TEXT_FONTS.map((font) => ({ id: font.id, caption: font.family }))} onChange={(font) => onChange({ font })} />
        </Row>
      ) : null}
      {has("size") ? (
        <Row caption={t("Font size")}>
          <NumberField caption={t("Font size")} testId="pdfx-prop-size" value={mixedOr(style.size)} mixed={isMixed(style.size)} min={FONT_SIZE_RANGE.min} max={FONT_SIZE_RANGE.max} step={1} digits={2} unit={POINTS} presets={FONT_SIZE_PRESETS} onCommit={(size) => onChange({ size })} />
        </Row>
      ) : null}
      {has("bold") ? (
        <Row caption={t("Text style")}>
          <ToggleGroup
            caption={t("Text style")}
            testId="pdfx-prop-flags"
            multiple
            value={flags}
            options={[
              { id: "bold", caption: t("Bold"), icon: Bold },
              { id: "italic", caption: t("Italic"), icon: Italic },
              { id: "underline", caption: t("Underline"), icon: Underline }
            ]}
            onChange={(key, pressed) => onChange({ [key]: pressed })}
          />
        </Row>
      ) : null}
      {has("align") ? (
        <Row caption={t("Alignment")}>
          <ToggleGroup
            caption={t("Alignment")}
            testId="pdfx-prop-align"
            value={mixedOr(style.align)}
            options={[
              { id: "left", caption: t("Align left"), icon: AlignLeft },
              { id: "center", caption: t("Align center"), icon: AlignCenter },
              { id: "right", caption: t("Align right"), icon: AlignRight }
            ]}
            onChange={(align) => onChange({ align })}
          />
        </Row>
      ) : null}
      {has("lineHeight") ? (
        <Row caption={t("Line height")}>
          <NumberField caption={t("Line height")} testId="pdfx-prop-lineHeight" value={mixedOr(style.lineHeight)} mixed={isMixed(style.lineHeight)} min={0.8} max={3} step={0.05} digits={2} presets={LINE_HEIGHT_PRESETS} onCommit={(lineHeight) => onChange({ lineHeight })} />
        </Row>
      ) : null}
      {has("color") ? (
        <Row caption={colourCaption}>
          <ColorField caption={colourCaption} testId="pdfx-prop-color" value={mixedOr(style.color)} mixed={isMixed(style.color)} palette={palette} recent={recent} onChange={(color) => onChange({ color })} />
        </Row>
      ) : null}
      {has("stroke") ? (
        <Row caption={t("Stroke colour")}>
          <ColorField caption={t("Stroke colour")} testId="pdfx-prop-stroke" value={mixedOr(style.stroke)} mixed={isMixed(style.stroke)} allowNone={type !== "line"} recent={recent} onChange={(stroke) => onChange({ stroke })} />
        </Row>
      ) : null}
      {has("strokeWidth") ? (
        <Row caption={t("Stroke width")}>
          <NumberField caption={t("Stroke width")} testId="pdfx-prop-strokeWidth" value={mixedOr(style.strokeWidth)} mixed={isMixed(style.strokeWidth)} min={0.25} max={48} step={0.5} digits={2} unit={POINTS} presets={STROKE_WIDTH_PRESETS} onCommit={(strokeWidth) => onChange({ strokeWidth })} />
        </Row>
      ) : null}
      {has("dash") ? (
        <Row caption={t("Line style")}>
          <ToggleGroup
            caption={t("Line style")}
            testId="pdfx-prop-dash"
            value={mixedOr(style.dash)}
            options={[
              { id: "solid", caption: t("Solid"), text: t("Solid") },
              { id: "dashed", caption: t("Dashed"), text: t("Dashed") },
              { id: "dotted", caption: t("Dotted"), text: t("Dotted") }
            ]}
            onChange={(dash) => onChange({ dash })}
          />
        </Row>
      ) : null}
      {has("fill") ? (
        <Row caption={t("Fill colour")}>
          <ColorField caption={t("Fill colour")} testId="pdfx-prop-fill" value={mixedOr(style.fill)} mixed={isMixed(style.fill)} allowNone recent={recent} onChange={(fill) => onChange({ fill })} />
        </Row>
      ) : null}
      {has("headStart") ? (
        <Row caption={t("Arrow heads")}>
          <ToggleGroup
            caption={t("Arrow heads")}
            testId="pdfx-prop-heads"
            multiple
            value={["headStart", "headEnd"].filter((key) => style[key] === true)}
            options={[
              { id: "headStart", caption: t("Arrow head at the start"), text: t("At the start") },
              { id: "headEnd", caption: t("Arrow head at the end"), text: t("At the end") }
            ]}
            onChange={(key, pressed) => onChange({ [key]: pressed })}
          />
        </Row>
      ) : null}
      {has("width") ? (
        <Row caption={t("Thickness")}>
          <NumberField caption={t("Thickness")} testId="pdfx-prop-width" value={mixedOr(style.width)} mixed={isMixed(style.width)} min={0.25} max={48} step={1} digits={2} unit={POINTS} presets={PEN_WIDTH_PRESETS} onCommit={(width) => onChange({ width })} />
        </Row>
      ) : null}
      {has("thickness") && mode !== "text" ? (
        <Row caption={t("Thickness")}>
          <NumberField caption={t("Thickness")} testId="pdfx-prop-thickness" value={mixedOr(style.thickness)} mixed={isMixed(style.thickness)} min={1} max={48} step={2} digits={1} unit={POINTS} presets={HIGHLIGHT_THICKNESS_PRESETS} onCommit={(thickness) => onChange({ thickness })} />
        </Row>
      ) : null}
      {has("style") ? (
        <Row caption={t("Effect")}>
          <ToggleGroup
            caption={t("Effect")}
            testId="pdfx-prop-blurStyle"
            value={mixedOr(style.style)}
            options={[
              { id: "pixelate", caption: t("Pixelate"), text: t("Pixelate") },
              { id: "blur", caption: t("Blur"), text: t("Blur") }
            ]}
            onChange={(next) => onChange({ style: next })}
          />
        </Row>
      ) : null}
      {has("strength") ? (
        <Row caption={t("Strength")}>
          <ToggleGroup
            caption={t("Strength")}
            testId="pdfx-prop-strength"
            value={mixedOr(style.strength)}
            options={[
              { id: 1, caption: t("Low"), text: t("Low") },
              { id: 2, caption: t("Medium"), text: t("Medium") },
              { id: 3, caption: t("High"), text: t("High") }
            ]}
            onChange={(strength) => onChange({ strength })}
          />
        </Row>
      ) : null}
      {has("opacity") ? (
        <Row caption={t("Opacity")}>
          <PercentField caption={t("Opacity")} testId="pdfx-prop-opacity" value={mixedOr(style.opacity)} mixed={isMixed(style.opacity)} onChange={(opacity) => onChange({ opacity })} />
        </Row>
      ) : null}
    </>
  );
}

/** Position, size and rotation of ONE object as numbers. */
function GeometryFields({ object, page, runtime, unit, keepRatio }) {
  const { t } = useI18n();
  const { store, actions } = runtime.editor;
  const toUnit = unit === "pt" ? (points) => points : pointsToMm;
  const fromUnit = unit === "pt" ? (value) => value : mmToPoints;
  const step = unit === "pt" ? 1 : 0.5;
  const update = (field, patch) => {
    if (!patch) return;
    try {
      store.updateObjects([{ id: object.id, patch }], { coalesceKey: `geometry:${field}:${object.id}` });
    } catch (error) {
      actions.reportError(error);
    }
  };
  const fresh = () => store.getState().objects[object.id] || object;
  const movable = !(object.type === "highlight" && object.mode === "text");
  const box = objectScreenBox(object, page);
  const frame = uprightFrameOf(object, page);
  const line = object.type === "line" ? lineOnScreen(object, page) : null;
  const picture = object.type === "image";
  if (!movable) return <p className="pdfx-prop-note">{t("A highlight of document text follows that text: it has no position of its own.")}</p>;
  return (
    <>
      <Row caption={t("Position on page")}>
        <span className="pdfx-prop-pair">
          <NumberField caption={t("Distance from the left edge")} testId="pdfx-prop-x" value={toUnit(box[0])} step={step} digits={1} unit={unit} onCommit={(value) => update("x", setObjectScreenPosition(fresh(), page, { left: fromUnit(value) }))} />
          <NumberField caption={t("Distance from the top edge")} testId="pdfx-prop-y" value={toUnit(box[1])} step={step} digits={1} unit={unit} onCommit={(value) => update("y", setObjectScreenPosition(fresh(), page, { top: fromUnit(value) }))} />
        </span>
      </Row>
      {frame ? (
        <Row caption={t("Size")}>
          <span className="pdfx-prop-pair">
            <NumberField caption={t("Width")} testId="pdfx-prop-w" value={toUnit(frame.w)} min={toUnit(8)} step={step} digits={1} unit={unit} onCommit={(value) => update("w", setObjectSize(fresh(), page, { width: fromUnit(value) }, { lockRatio: picture && keepRatio }))} />
            <NumberField
              caption={t("Height")}
              testId="pdfx-prop-h"
              value={toUnit(frame.h)}
              min={toUnit(8)}
              step={step}
              digits={1}
              unit={unit}
              disabled={object.type === "text"}
              onCommit={(value) => update("h", setObjectSize(fresh(), page, { height: fromUnit(value) }, { lockRatio: picture && keepRatio }))}
            />
          </span>
        </Row>
      ) : null}
      {line ? (
        <Row caption={t("Line")}>
          <span className="pdfx-prop-pair">
            <NumberField caption={t("Length")} testId="pdfx-prop-length" value={toUnit(line.length)} min={toUnit(8)} step={step} digits={1} unit={unit} onCommit={(value) => update("length", { p2: lineEndFor(fresh(), page, { length: fromUnit(value) }) })} />
            <NumberField caption={t("Angle")} testId="pdfx-prop-angle" value={line.angle} step={15} digits={1} unit="°" onCommit={(value) => update("angle", { p2: lineEndFor(fresh(), page, { angle: value }) })} />
          </span>
        </Row>
      ) : null}
      {canRotate(object) ? (
        <Row caption={t("Rotation")}>
          <NumberField caption={t("Rotation")} testId="pdfx-prop-rotation" value={screenRotationOf(object, page)} step={15} digits={1} unit="°" onCommit={(value) => update("rotation", setScreenRotation(fresh(), page, ((value % 360) + 360) % 360))} />
        </Row>
      ) : null}
      {picture ? (
        <label className="pdfx-prop-check">
          <input type="checkbox" checked={keepRatio} data-testid="pdfx-prop-keepRatio" onChange={(event) => runtime.setBag({ keepRatio: event.target.checked })} />
          <span>{t("Keep aspect ratio")}</span>
        </label>
      ) : null}
    </>
  );
}

/** What the text of a box means for the export: real text, a fallback font, or a picture. Nothing is dropped silently. */
function TextExportNote({ object, text, runtime }) {
  const { t } = useI18n();
  const { fonts, textService } = runtime.editor;
  // a font that finishes loading can change the answer
  useSyncExternalStore(fonts.subscribe, fonts.getVersion);
  let check;
  try {
    check = textService.check(text === null || text === undefined ? object : { ...object, text });
  } catch {
    check = null;
  }
  if (!check) return null;
  const list = (entries) => {
    const characters = [...new Set(entries.map((entry) => entry.char))];
    return `${characters.slice(0, MAX_LISTED_CHARACTERS).join(" ")}${characters.length > MAX_LISTED_CHARACTERS ? " …" : ""}`;
  };
  if (check.unsupported.length) {
    return (
      <p className="pdfx-prop-alert" data-tone="warning" role="status" data-testid="pdfx-text-export-note" data-state="picture">
        <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
        <span>{t("This text box will be exported as a picture, because the bundled fonts cannot write: {characters}. Its text will not be searchable in the file.", { characters: list(check.unsupported) })}</span>
      </p>
    );
  }
  if (check.fallback.length) {
    return (
      <p className="pdfx-prop-alert" data-tone="info" role="status" data-testid="pdfx-text-export-note" data-state="fallback">
        <Info size={14} strokeWidth={2} aria-hidden="true" />
        <span>{t("The font {font} cannot display: {characters}. These characters will use {fallback}.", { font: FAMILY_NAMES[object.font] || object.font, characters: list(check.fallback), fallback: FAMILY_NAMES.arimo })}</span>
      </p>
    );
  }
  return null;
}

function ReplacesNote({ object, runtime, committed }) {
  const { t } = useI18n();
  return (
    <div className="pdfx-prop-replaces" data-testid="pdfx-replaces">
      <Chip tone="info">{t("Replaces original text")}</Chip>
      <p className="pdfx-prop-note">{t("The original font is not available. The replacement text uses {font}.", { font: FAMILY_NAMES[object.font] || object.font })}</p>
      <p className="pdfx-prop-note">{t("One line is replaced at a time; the text after it does not move. On download the original line is removed from the file.")}</p>
      {committed ? (
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-restore-original" onClick={() => runtime.deleteObjects([object.id])}>
          <Undo2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="pdfx-btn-label">{t("Restore original")}</span>
        </button>
      ) : null}
    </div>
  );
}

/** The pending redaction and blur marks of the document, by page: jump to one, delete one, clear all. */
function PendingMarks({ runtime, selection }) {
  const { t } = useI18n();
  const { viewer } = runtime.editor;
  // re-read on every change of the document (the panel renders from the objects)
  const marks = runtime.pendingMarks();
  if (!marks.length) {
    return (
      <Section heading={t("Marked for redaction")} testId="pdfx-marks">
        <p className="pdfx-prop-note">{t("Nothing is marked yet. Drag on a page to mark an area, or click a line of text.")}</p>
      </Section>
    );
  }
  const jump = (mark) => {
    viewer.scrollToPage(mark.pageId, { rect: mark.rect, align: "center" });
    runtime.select([mark.id], { keepTool: true });
  };
  return (
    <Section heading={t("Marked for redaction")} testId="pdfx-marks">
      <ul className="pdfx-marks" data-count={marks.length}>
        {marks.map((mark) => (
          <li key={mark.id} className="pdfx-mark-row" data-testid="pdfx-mark-row" data-mark-id={mark.id} data-kind={mark.type} data-selected={selection.includes(mark.id) ? "true" : undefined}>
            <span className="pdfx-mark-swatch" data-kind={mark.type} style={mark.type === "redact" ? { backgroundColor: mark.object.color } : undefined} aria-hidden="true" />
            <span className="pdfx-mark-text">{mark.type === "redact" ? t("Page {page}: redaction", { page: mark.pageNumber }) : t("Page {page}: blur", { page: mark.pageNumber })}</span>
            <BarButton icon={LocateFixed} label={t("Show on the page")} tipAlign="end" testId="pdfx-action-mark-show" onClick={() => jump(mark)} />
            <BarButton icon={Trash2} label={t("Remove this mark")} tipAlign="end" testId="pdfx-action-mark-delete" onClick={() => runtime.deleteObjects([mark.id])} />
          </li>
        ))}
      </ul>
      <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-marks-clear" onClick={() => runtime.deleteObjects(marks.map((mark) => mark.id))}>
        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="pdfx-btn-label">{t("Clear all")}</span>
      </button>
      <p className="pdfx-prop-note">{t("Marks are applied when you download, print or sign: the content under them is then removed from the file, not just hidden. The same words elsewhere in the document are not found automatically: use Search.")}</p>
    </Section>
  );
}

function MarkNotes({ kind, objects, runtime }) {
  const { t } = useI18n();
  const { store, actions } = runtime.editor;
  const redactions = objects.filter((object) => object.type === "redact");
  const all = runtime.pendingMarks().filter((mark) => mark.type === "redact");
  const colour = redactions[0]?.color;
  const sameColour = all.every((mark) => mark.object.color === colour);
  return (
    <>
      {/* one selected mark: what it takes beyond its own rectangle, or that its page will become a picture */}
      {objects.length === 1 ? <MarkReachNote key={objects[0].id} mark={objects[0]} runtime={runtime} /> : null}
      {redactions.length && all.length > 1 && !sameColour ? (
        <button
          type="button"
          className="pdfx-btn pdfx-btn-text pdfx-btn-outline"
          data-testid="pdfx-action-redact-colour-all"
          onClick={() => {
            try {
              store.updateObjects(all.map((mark) => ({ id: mark.id, patch: { color: colour } })));
            } catch (error) {
              actions.reportError(error);
            }
          }}
        >
          <span className="pdfx-btn-label">{t("Use this colour for all pending redactions")}</span>
        </button>
      ) : null}
      {kind === "blur" ? (
        <>
          <p className="pdfx-prop-alert" data-tone="info" data-testid="pdfx-blur-note">
            <Info size={14} strokeWidth={2} aria-hidden="true" />
            <span>{t("A light blur can sometimes be reversed. For content that must stay secret, use Redact.")}</span>
          </p>
          <p className="pdfx-prop-note">{t("On download the content under a blur area is removed from the file and a mosaic is put in its place: it is removed, not merely hidden.")}</p>
        </>
      ) : null}
    </>
  );
}

function SelectionActions({ runtime, objects }) {
  const { t } = useI18n();
  const arrangeable = objects.some((object) => !isMark(object));
  const several = objects.length > 1;
  const align = (mode, caption, icon) => <BarButton key={mode} icon={icon} label={caption} tipSide="top" testId={`pdfx-action-prop-align-${mode}`} onClick={() => runtime.alignSelection(mode)} />;
  return (
    <>
      {several ? (
        <Section heading={t("Align")}>
          <div className="pdfx-prop-buttons" role="group" aria-label={t("Align")}>
            {align("left", t("Align left edges"), AlignStartVertical)}
            {align("center", t("Align centres horizontally"), AlignCenterVertical)}
            {align("right", t("Align right edges"), AlignEndVertical)}
            {align("top", t("Align top edges"), AlignStartHorizontal)}
            {align("middle", t("Align centres vertically"), AlignCenterHorizontal)}
            {align("bottom", t("Align bottom edges"), AlignEndHorizontal)}
          </div>
        </Section>
      ) : null}
      {arrangeable ? (
        <Section heading={t("Arrange")}>
          <div className="pdfx-prop-buttons" role="group" aria-label={t("Arrange")}>
            <BarButton icon={BringToFront} label={t("Bring to front")} tipSide="top" testId="pdfx-action-prop-front" onClick={() => runtime.arrangeSelection("front")} />
            <BarButton icon={ArrowUp} label={t("Bring forward")} tipSide="top" testId="pdfx-action-prop-forward" onClick={() => runtime.arrangeSelection("forward")} />
            <BarButton icon={ArrowDown} label={t("Send backward")} tipSide="top" testId="pdfx-action-prop-backward" onClick={() => runtime.arrangeSelection("backward")} />
            <BarButton icon={SendToBack} label={t("Send to back")} tipSide="top" testId="pdfx-action-prop-back" onClick={() => runtime.arrangeSelection("back")} />
          </div>
        </Section>
      ) : null}
      <div className="pdfx-prop-buttons pdfx-prop-final">
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-prop-duplicate" onClick={() => runtime.duplicateSelection()}>
          <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="pdfx-btn-label">{t("Duplicate object")}</span>
        </button>
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline pdfx-prop-delete" data-testid="pdfx-action-prop-delete" onClick={() => runtime.deleteSelection()}>
          <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="pdfx-btn-label">{t("Delete")}</span>
        </button>
      </div>
    </>
  );
}

const TYPE_CAPTIONS = {
  text: (t) => t("Text box"),
  image: (t) => t("Image"),
  rect: (t) => t("Rectangle"),
  ellipse: (t) => t("Ellipse"),
  line: (t) => t("Line"),
  pen: (t) => t("Pen stroke"),
  highlight: (t) => t("Highlight"),
  redact: (t) => t("Redaction"),
  blur: (t) => t("Blur area")
};

export default function PropertiesPanel() {
  const { t } = useI18n();
  const editor = useEditor();
  const runtime = getRuntime(editor);
  const { ui } = editor;
  const interaction = useInteraction();
  // the panel renders from these: the hooks make it follow them
  const objects = useDocument((state) => state.objects);
  const pages = useDocument((state) => state.pages);
  const toolDefaults = useUi((state) => state.toolDefaults);
  const [bag] = useFeatureState(FEATURE_ID);
  void objects;
  void toolDefaults;

  const target = runtime.styleTarget();
  const recent = bag?.recentColors || [];
  const unit = bag?.unit === "pt" ? "pt" : "mm";
  const keepRatio = bag?.keepRatio !== false;
  const editing = target.source === "draft" || target.source === "editing";
  const tool = toolById(interaction.tool);
  // a control that takes no text keeps the keyboard in the box that is being typed in
  const keepTyping = (event) => {
    if (!editing) return;
    if (event.target.closest("input, select, textarea")) runtime.panelPressed();
    else event.preventDefault();
  };
  // a font menu or a number field of this panel may take the keyboard without ending the typing (the session
  // is held, overlay/runtime.js endEditing); it ends when the focus leaves the panel for something else
  const focusLeft = (event) => {
    const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    if (next && event.currentTarget.contains(next)) return;
    runtime.releaseHeldText(Boolean(next?.closest(".pdfx-text-editor")));
  };
  // after a choice from a menu, or Enter in a field, the caret goes back into the box (an empty box is too
  // narrow to click into)
  const menuUsed = (event) => {
    if (editing && event.target instanceof HTMLSelectElement) setTimeout(() => runtime.focusText(), 0);
  };
  const fieldDone = (event) => {
    if (editing && event.key === "Enter" && event.target instanceof HTMLInputElement) setTimeout(() => runtime.focusText(), 0);
  };
  const frame = (content, kind, count = 0) => (
    <div className="pdfx-props" data-testid="pdfx-properties" data-source={target.source} data-kind={kind || ""} data-count={count} onMouseDown={keepTyping} onBlur={focusLeft} onChange={menuUsed} onKeyDown={fieldDone}>
      {content}
    </div>
  );
  const marksWanted = interaction.tool === "redact" || interaction.tool === "blur" || Boolean(bag?.showMarks);

  if (target.source === "none") {
    return frame(
      <>
        {interaction.tool === "editText" ? (
          <Section heading={t("Edit text")}>
            <p className="pdfx-prop-note">{t("Click a line of text on a page to replace it.")}</p>
            <p className="pdfx-prop-note">{t("One line is replaced at a time; the text after it does not move. On download the original line is removed from the file.")}</p>
            <p className="pdfx-prop-note">{t("The original font is usually not available, so the replacement uses the bundled font nearest to it.")}</p>
          </Section>
        ) : null}
        {interaction.tool === "eraser" ? (
          <Section heading={t("Eraser")}>
            <p className="pdfx-prop-note">{t("The eraser removes whole pen strokes, highlights and shapes you added. It cannot change the original document: for that there is Redact.")}</p>
          </Section>
        ) : null}
        {interaction.tool === "image" ? (
          <Section heading={t("Image")}>
            <p className="pdfx-prop-note">{t("Choose a picture, then click a page to place it, or drag to give it a size.")}</p>
          </Section>
        ) : null}
        {marksWanted ? <PendingMarks runtime={runtime} selection={interaction.selection} /> : null}
        <DocumentSummary />
      </>,
      ""
    );
  }

  if (target.source === "tool") {
    const type = objectTypeOfKind(target.kind);
    const style = ui.getToolStyle(target.kind);
    const shown = Object.fromEntries(runtime.styleKeysOfKind(target.kind).map((key) => [key, style[key]]));
    return frame(
      <>
        <Section heading={t("Settings for the next object: {tool}", { tool: t(tool.label) })} testId="pdfx-prop-style">
          <StyleControls style={shown} type={type} mode={null} recent={recent} onChange={(patch) => runtime.applyStyle(patch)} />
          {type === "redact" || type === "blur" ? <MarkNotes kind={type} objects={[]} runtime={runtime} /> : null}
        </Section>
        {marksWanted ? <PendingMarks runtime={runtime} selection={interaction.selection} /> : null}
      </>,
      target.kind
    );
  }

  const list = target.objects;
  const types = [...new Set(list.map((object) => object.type))];
  const single = list.length === 1 ? list[0] : null;
  const type = types.length === 1 ? types[0] : null;
  const style = sharedStyle(list);
  const page = single ? pages.find((entry) => entry.id === single.pageId) : null;
  const heading = single ? TYPE_CAPTIONS[single.type](t) : t("Objects selected: {count}", { count: list.length });
  const hasMark = list.some(isMark);
  const annotated = target.source === "selection" ? list.filter((object) => runtime.annotationUnder(object, pages.find((entry) => entry.id === object.pageId))) : [];

  return frame(
    <>
      <Section heading={heading} testId="pdfx-prop-style">
        {single?.type === "text" && single.replaces ? <ReplacesNote object={single} runtime={runtime} committed={target.source !== "draft"} /> : null}
        {Object.keys(style).length ? (
          <StyleControls style={style} type={type} mode={single?.type === "highlight" ? single.mode : null} recent={recent} onChange={(patch) => runtime.applyStyle(patch)} />
        ) : (
          <p className="pdfx-prop-note">{t("These objects have no property in common.")}</p>
        )}
        {single?.type === "text" ? <TextExportNote object={single} text={editing ? bag?.liveText : null} runtime={runtime} /> : null}
        {single?.type === "image" ? (
          <>
            {runtime.assetNote(single.assetId)?.scaled ? <p className="pdfx-prop-note" data-testid="pdfx-image-scaled">{t("Scaled down to 4000 px.")}</p> : null}
            <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-replace-image" onClick={() => runtime.openImagePicker({ replace: single.id })}>
              <span className="pdfx-btn-label">{t("Replace image…")}</span>
            </button>
          </>
        ) : null}
        {hasMark ? <MarkNotes kind={type} objects={list} runtime={runtime} /> : null}
        {annotated.length ? (
          <p className="pdfx-prop-alert" data-tone="warning" role="status" data-testid="pdfx-annotation-note">
            <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
            <span>{t("In the downloaded file this object lies under a form field, stamp or comment of the original page.")}</span>
          </p>
        ) : null}
      </Section>
      {target.source === "selection" ? (
        <>
          {single && page ? (
            <Section heading={t("Position and size")} testId="pdfx-prop-geometry">
              <GeometryFields object={single} page={page} runtime={runtime} unit={unit} keepRatio={keepRatio} />
              <Row caption={t("Units")}>
                <ToggleGroup
                  caption={t("Units")}
                  testId="pdfx-prop-unit"
                  value={unit}
                  options={[
                    { id: "mm", caption: t("Millimetres"), text: "mm" },
                    { id: "pt", caption: t("Points"), text: "pt" }
                  ]}
                  onChange={(next) => runtime.setBag({ unit: next })}
                />
              </Row>
            </Section>
          ) : null}
          <SelectionActions runtime={runtime} objects={list} />
          {hasMark || marksWanted ? <PendingMarks runtime={runtime} selection={interaction.selection} /> : null}
        </>
      ) : null}
    </>,
    types.join(" "),
    list.length
  );
}
