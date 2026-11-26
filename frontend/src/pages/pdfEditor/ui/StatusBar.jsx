import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, EyeOff, Maximize, Minimize } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { countPendingMarks } from "../model/selectors.js";
import { commandById } from "../tools/registry.js";
import { zoomPercent } from "../viewer/zoom.js";
import { ZOOM_LIMITS, ZOOM_PRESETS } from "./actions.js";
import { BarButton, BarSeparator, SlotBoundary } from "./controls.jsx";
import { useDocument, useEditor, useUi, useViewer } from "./editorHooks.js";
import { iconByName } from "./icons.js";
import { MenuButton } from "./Menu.jsx";
import { describePageSize } from "./pageSize.js";
import { shortcutLabel } from "./shortcutLabels.js";
import { useFullScreen } from "./useFullScreen.js";

// The status bar (UX specification 3.1 G): the page navigator with an editable page number, the zoom controls
// with their menu (Automatic, Fit width, Fit page, Actual size and the presets), full screen, the status items
// of the features, the counter of pending redaction and blur marks, the size of the current page in
// millimetres and the switch of the properties panel.
//
// Test hooks: pdfx-action-previousPage / -nextPage, pdfx-page-number (the field), pdfx-page-count,
// pdfx-action-zoomOut / -zoomIn, pdfx-zoom-menu (data-zoom = percent, data-zoom-mode = "auto" | "fit-width" |
// "fit-page" | "actual" | "custom"; items pdfx-zoom-auto, pdfx-zoom-fit-width, pdfx-zoom-fit-page,
// pdfx-zoom-actual, pdfx-zoom-<percent>), pdfx-action-fullScreen-bar, pdfx-pending-marks (data-count),
// pdfx-page-size, pdfx-action-toggleInspector.

/** The page number: type a number and press Enter (or leave the field); Escape gives the old number back. */
function PageNumber({ current, total, disabled }) {
  const { t } = useI18n();
  const editor = useEditor();
  const { actions } = editor;
  const [draft, setDraft] = useState(null); // null = not being edited
  const giveUp = useRef(false);
  const inputRef = useRef(null);

  // Ctrl+Alt+G puts the keyboard here
  useEffect(() => editor.registerElement("pageNumber", inputRef.current), [editor]);

  const apply = () => {
    const wanted = Number.parseInt(draft, 10);
    if (Number.isFinite(wanted)) actions.goToPage(Math.min(total, Math.max(1, wanted)));
  };

  return (
    <span className="pdfx-pagenumber">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className="pdfx-input pdfx-pagenumber-input"
        aria-label={t("Page number")}
        autoComplete="off"
        disabled={disabled}
        data-testid="pdfx-page-number"
        value={draft === null ? (total ? String(current) : "") : draft}
        onFocus={(event) => {
          setDraft(String(current || ""));
          event.target.select();
        }}
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
        onBlur={() => {
          if (!giveUp.current && draft !== null) apply();
          giveUp.current = false;
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          giveUp.current = event.key === "Escape";
          if (event.key === "Enter") {
            apply();
            giveUp.current = true; // applied already: leaving the field must not apply it again
          }
          editor.getElement("viewer")?.focus({ preventScroll: true });
        }}
      />
      <span className="pdfx-pagenumber-total" aria-hidden="true">
        /
      </span>
      <span className="pdfx-pagenumber-total" data-testid="pdfx-page-count" aria-label={t("Number of pages: {count}", { count: total })}>
        {total}
      </span>
    </span>
  );
}

export default function StatusBar() {
  const { t, formatNumber } = useI18n();
  const { actions, features, reportSlotError } = useEditor();
  const pages = useDocument((state) => state.pages);
  const objects = useDocument((state) => state.objects);
  const currentPageId = useViewer((state) => state.currentPageId);
  const currentPageNumber = useViewer((state) => state.currentPageNumber);
  const zoom = useViewer((state) => state.zoom);
  const zoomMode = useViewer((state) => state.zoomMode);
  const autoZoom = useUi((state) => state.autoZoom);
  const inspectorOpen = useUi((state) => state.inspector.open);
  const layout = useUi((state) => state.layout);
  const fullScreen = useFullScreen();
  const hasDocument = pages.length > 0;
  const page = pages.find((entry) => entry.id === currentPageId) || null;
  const marks = useMemo(() => (pages.length ? countPendingMarks({ pages, objects }) : null), [pages, objects]);
  const percent = zoomPercent(zoom);
  const mode = autoZoom ? "auto" : zoomMode;

  const previous = commandById("previousPage");
  const next = commandById("nextPage");
  const zoomIn = commandById("zoomIn");
  const zoomOut = commandById("zoomOut");
  const inspector = commandById("toggleInspector");

  const zoomItems = [
    { id: "auto", kind: "radio", label: t("Automatic zoom"), shortcut: shortcutLabel("zoomAuto"), checked: mode === "auto", testId: "pdfx-zoom-auto", onSelect: () => actions.zoomAuto() },
    { id: "fit-width", kind: "radio", label: t("Fit width"), shortcut: shortcutLabel("fitWidth"), checked: mode === "fit-width", testId: "pdfx-zoom-fit-width", onSelect: () => actions.setZoom("fit-width") },
    { id: "fit-page", kind: "radio", label: t("Fit page"), shortcut: shortcutLabel("fitPage"), checked: mode === "fit-page", testId: "pdfx-zoom-fit-page", onSelect: () => actions.setZoom("fit-page") },
    { id: "actual", kind: "radio", label: t("Actual size"), shortcut: shortcutLabel("actualSize"), checked: mode === "actual", testId: "pdfx-zoom-actual", onSelect: () => actions.setZoom("actual") },
    { id: "sep", kind: "separator" },
    ...ZOOM_PRESETS.map((preset) => ({
      id: `preset-${preset}`,
      kind: "radio",
      label: `${zoomPercent(preset)}%`,
      checked: mode === "custom" && Math.abs(zoom - preset) < 0.005,
      testId: `pdfx-zoom-${zoomPercent(preset)}`,
      onSelect: () => actions.setZoom(preset)
    }))
  ];

  const size = page ? describePageSize(page) : null;
  const millimetres = (value) => formatNumber(value, { maximumFractionDigits: value % 1 ? 1 : 0 });

  return (
    <footer className="pdfx-statusbar" data-testid="pdfx-statusbar">
      <div className="pdfx-status-group" role="group" aria-label={t("Page navigation")}>
        <BarButton icon={iconByName(previous.icon)} label={t(previous.label)} disabled={!hasDocument || currentPageNumber <= 1} tipSide="top" tipAlign="start" testId="pdfx-action-previousPage" onClick={() => actions.previousPage()} />
        <PageNumber current={currentPageNumber} total={pages.length} disabled={!hasDocument} />
        <BarButton icon={iconByName(next.icon)} label={t(next.label)} disabled={!hasDocument || currentPageNumber >= pages.length} tipSide="top" testId="pdfx-action-nextPage" onClick={() => actions.nextPage()} />
      </div>
      <BarSeparator />
      <div className="pdfx-status-group" role="group" aria-label={t("Zoom")}>
        <BarButton icon={iconByName(zoomOut.icon)} label={t(zoomOut.label)} shortcut={shortcutLabel("zoomOut")} disabled={!hasDocument || zoom <= ZOOM_LIMITS.min + 0.001} tipSide="top" testId="pdfx-action-zoomOut" onClick={() => actions.zoomOut()} />
        <MenuButton
          icon={ChevronDown}
          iconSize={12}
          label={t("Zoom: {percent}%", { percent })}
          text={`${percent}%`}
          className="pdfx-zoom-button"
          disabled={!hasDocument}
          tipSide="top"
          side="top"
          testId="pdfx-zoom-menu"
          menuTestId="pdfx-menu-zoom"
          data-zoom={percent}
          data-zoom-mode={mode}
          items={zoomItems}
        />
        <BarButton icon={iconByName(zoomIn.icon)} label={t(zoomIn.label)} shortcut={shortcutLabel("zoomIn")} disabled={!hasDocument || zoom >= ZOOM_LIMITS.max - 0.001} tipSide="top" testId="pdfx-action-zoomIn" onClick={() => actions.zoomIn()} />
      </div>
      <BarSeparator />
      <BarButton
        icon={fullScreen ? Minimize : Maximize}
        label={fullScreen ? t("Exit full screen") : t("Full screen")}
        shortcut={shortcutLabel("fullScreen")}
        pressed={fullScreen}
        tipSide="top"
        testId="pdfx-action-fullScreen-bar"
        onClick={() => actions.toggleFullScreen()}
      />
      {features.statusItems.map((Item, index) => (
        <SlotBoundary key={index} onError={reportSlotError}>
          <Item />
        </SlotBoundary>
      ))}
      <span className="pdfx-status-spacer" />
      {marks?.total ? (
        <button type="button" className="pdfx-status-marks" data-testid="pdfx-pending-marks" data-count={marks.total} data-tip={t("Marked areas are removed for real when you download.")} data-tip-side="top" data-tip-align="end" onClick={() => actions.showPendingMarks()}>
          <EyeOff size={14} strokeWidth={2} aria-hidden="true" />
          <span>{marks.total === 1 ? t("1 mark pending") : t("{count} marks pending", { count: marks.total })}</span>
        </button>
      ) : null}
      {size && layout !== "narrow" ? (
        <span className="pdfx-status-size" data-testid="pdfx-page-size" data-width-mm={size.width} data-height-mm={size.height}>
          {size.format ? <strong>{size.format}</strong> : null}
          <span>{t("{width} × {height} mm", { width: millimetres(size.width), height: millimetres(size.height) })}</span>
        </span>
      ) : null}
      <BarButton icon={iconByName(inspector.icon)} label={t(inspector.label)} pressed={inspectorOpen} disabled={!hasDocument} tipSide="top" tipAlign="end" testId="pdfx-action-toggleInspector" onClick={() => actions.toggleInspector()} />
    </footer>
  );
}
