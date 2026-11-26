import { useEffect, useRef } from "react";
import { ArrowUpDown, Check, Copy, FileInput, FileOutput, FilePlus2, ImagePlus, RotateCcw, RotateCw, SquareCheck, Trash2 } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { BarButton, BarSeparator } from "../ui/controls.jsx";
import { useDocument, useEditor, useFeatureState, useUi } from "../ui/editorHooks.js";
import { shortcutLabel } from "../ui/shortcutLabels.js";
import { openPage } from "./pageCommands.js";
import { defaultInsertIndex, run, startExtract, startInsertBlank, startInsertImages, startInsertPdf, startMoveTo } from "./pageFlows.js";
import { orderedSelection } from "./pageLogic.js";
import { deletePages, duplicatePages, rotatePages } from "./pageOps.js";
import PageGrid from "./PageGrid.jsx";
import { FEATURE_ID, THUMB_SIZES, setSelection, setThumbSize } from "./pagesState.js";
import { focusTile } from "./usePageGrid.js";
import "../styles/pages.css";

// The page organiser (UX specification 7.9): a full-screen view over the page area with every page as a tile.
//   select    click, Ctrl + click, Shift + click, a marquee on the empty part of the grid, Ctrl+A; with the
//             keyboard: arrows move the focus, Space toggles, Shift + arrows extend
//   reorder   drag one or several pages (a bar shows where they land, the grid scrolls near its edges);
//             without dragging: Ctrl+Shift+Left / Right, or "Move to position…"
//   rotate, duplicate, delete (no question: the toast offers Undo), extract, insert (blank page, pages of
//             another PDF, pictures as pages)
//   leave     Done, Escape, G; a double click or Enter on a page leaves at that page
// The bar is a toolbar with one tab stop (Left / Right, Home and End move between its buttons); the grid is
// pages/PageGrid.jsx.
//
// Test hooks: pdfx-organiser (data-pages, data-selected, data-size), pdfx-organiser-bar,
// pdfx-action-organiser-<id> for select-all, rotate-left, rotate-right, duplicate, delete, extract, move,
// insert-blank, insert-pdf, insert-image, done; pdfx-organiser-size-s / -m / -l; pdfx-organiser-count.

const TILE_WIDTHS = Object.freeze({ s: 104, m: 152, l: 220 });
const SIZE_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

export default function PageOrganizer({ onClose }) {
  const { t } = useI18n();
  const editor = useEditor();
  const { ui } = editor;
  const pages = useDocument((state) => state.pages);
  const viewOnly = useUi((state) => Boolean(state.flags.viewOnly));
  const [bag] = useFeatureState(FEATURE_ID);
  const rootRef = useRef(null);
  const size = THUMB_SIZES.includes(bag?.size) ? bag.size : "m";
  const ids = pages.map((page) => page.id);
  const selected = orderedSelection(ids, bag?.selected || []);
  const none = selected.length === 0;
  const all = selected.length === ids.length && ids.length > 0;
  const lockedHint = viewOnly ? t("This file can be viewed but not edited here.") : undefined;

  // the keyboard starts in the grid, on the page the reader came from
  useEffect(() => {
    // below 1200 px the left panel lies over the page area: it would cover the organiser
    if (ui.getState().layout !== "wide") ui.closeLeftPanel();
    const root = rootRef.current;
    const grid = root?.querySelector("[data-pdfx-pages-grid]");
    const state = ui.getFeatureState(FEATURE_ID);
    const list = editor.store.getState().pages.map((page) => page.id);
    const start = list.includes(state?.focus) ? state.focus : editor.viewer.getSnapshot().currentPageId || list[0];
    if (grid && start) {
      setSelection(ui, { focus: start });
      focusTile(grid, start);
    }
    return () => {
      // leaving: the keyboard goes back to the pages unless something else took it
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) editor.getElement("viewer")?.focus?.({ preventScroll: true });
      }, 0);
    };
  }, [editor, ui]);

  // Roving focus in the bar (the APG toolbar pattern): one tab stop, Left / Right / Home / End move between the
  // buttons. The size switch is a radio group with its own stop.
  const barRef = useRef(null);
  const barStop = useRef(null);
  const barButtons = () => [...(barRef.current?.querySelectorAll('button:not(:disabled):not([role="radio"])') || [])];
  useEffect(() => {
    const buttons = barButtons();
    if (!buttons.includes(barStop.current)) barStop.current = buttons[0] || null;
    for (const button of buttons) button.tabIndex = button === barStop.current ? 0 : -1;
  });
  const onBarFocus = (event) => {
    const button = event.target.closest?.('button:not([role="radio"])');
    if (!button || button === barStop.current) return;
    if (barStop.current) barStop.current.tabIndex = -1;
    barStop.current = button;
    button.tabIndex = 0;
  };
  const onBarKeyDown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || event.target.closest('[role="radiogroup"]')) return;
    const buttons = barButtons();
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    event.stopPropagation();
    buttons[next].focus();
  };

  const onSizeKeyDown = (event) => {
    if (!SIZE_KEYS.includes(event.key)) return;
    const index = THUMB_SIZES.indexOf(size);
    const next = event.key === "Home" ? 0 : event.key === "End" ? THUMB_SIZES.length - 1 : Math.min(THUMB_SIZES.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)));
    event.preventDefault();
    event.stopPropagation();
    setThumbSize(ui, THUMB_SIZES[next]);
    event.currentTarget.querySelector(`[data-size="${THUMB_SIZES[next]}"]`)?.focus();
  };

  const sizeNames = { s: t("Small thumbnails"), m: t("Medium thumbnails"), l: t("Large thumbnails") };
  const sizeLetters = { s: "S", m: "M", l: "L" };
  const needsSelection = none ? t("Select one or more pages first.") : undefined;
  const action = (operation) => () => {
    if (!none) run(editor, operation(selected));
  };

  return (
    <div ref={rootRef} className="pdfx-organiser" data-testid="pdfx-organiser" data-pages={pages.length} data-selected={selected.length} data-size={size}>
      <div ref={barRef} className="pdfx-organiser-bar" role="toolbar" aria-label={t("Organise pages")} data-testid="pdfx-organiser-bar" onKeyDown={onBarKeyDown} onFocus={onBarFocus}>
        <span className="pdfx-organiser-group">
          <BarButton
            icon={all ? Check : SquareCheck}
            label={all ? t("Deselect all") : t("Select all")}
            text={all ? t("Deselect all") : t("Select all")}
            shortcut={all ? undefined : shortcutLabel("selectAll")}
            tipAlign="start"
            testId="pdfx-action-organiser-select-all"
            onClick={() => setSelection(ui, { selected: all ? [] : ids, anchor: ids[0] || null })}
          />
          <span className="pdfx-organiser-count" data-testid="pdfx-organiser-count" data-count={selected.length}>
            {t("{count} selected", { count: selected.length })}
          </span>
        </span>
        <BarSeparator />
        <span className="pdfx-organiser-group" role="group" aria-label={t("Selected pages")}>
          <BarButton icon={RotateCcw} label={t("Rotate counterclockwise")} shortcut={shortcutLabel("pageRotateCcw")} hint={lockedHint || needsSelection} disabled={none || viewOnly} soft testId="pdfx-action-organiser-rotate-left" onClick={action((list) => rotatePages(editor, list, -90))} />
          <BarButton icon={RotateCw} label={t("Rotate clockwise")} shortcut={shortcutLabel("pageRotateCw")} hint={lockedHint || needsSelection} disabled={none || viewOnly} soft testId="pdfx-action-organiser-rotate-right" onClick={action((list) => rotatePages(editor, list, 90))} />
          <BarButton icon={Copy} label={t("Duplicate page")} shortcut={shortcutLabel("duplicate")} hint={lockedHint || needsSelection} disabled={none || viewOnly} soft testId="pdfx-action-organiser-duplicate" onClick={action((list) => duplicatePages(editor, list))} />
          <BarButton
            icon={ArrowUpDown}
            label={t("Move to position…")}
            hint={lockedHint || needsSelection || (all ? t("All pages are selected: there is nowhere to move them.") : undefined)}
            disabled={none || all || viewOnly}
            soft
            testId="pdfx-action-organiser-move"
            onClick={() => {
              if (!none && !all) run(editor, startMoveTo(editor, { pageIds: selected }));
            }}
          />
          <BarButton
            icon={Trash2}
            label={t("Delete")}
            hint={lockedHint || needsSelection || t("Delete the selected pages. Deleted pages are not in the downloaded file.")}
            disabled={none || viewOnly}
            soft
            testId="pdfx-action-organiser-delete"
            onClick={action((list) => deletePages(editor, list))}
          />
          <BarButton icon={FileOutput} label={t("Extract")} text={t("Extract")} hint={lockedHint || needsSelection || t("Save the selected pages as a new PDF file")} disabled={none || viewOnly} soft testId="pdfx-action-organiser-extract" onClick={action((list) => startExtract(editor, { pageIds: list }))} />
        </span>
        <BarSeparator />
        <span className="pdfx-organiser-group" role="group" aria-label={t("Insert")}>
          <span className="pdfx-organiser-label" aria-hidden="true">
            {t("Insert")}
          </span>
          <BarButton icon={FilePlus2} label={t("Blank page")} text={t("Blank page")} hint={lockedHint} disabled={viewOnly} soft testId="pdfx-action-organiser-insert-blank" onClick={() => run(editor, startInsertBlank(editor, { index: defaultInsertIndex(editor) }))} />
          <BarButton icon={FileInput} label={t("Pages from PDF")} text={t("Pages from PDF")} hint={lockedHint} disabled={viewOnly} soft testId="pdfx-action-organiser-insert-pdf" onClick={() => startInsertPdf(editor, { index: defaultInsertIndex(editor) })} />
          <BarButton icon={ImagePlus} label={t("Image as page")} text={t("Image as page")} hint={lockedHint} disabled={viewOnly} soft testId="pdfx-action-organiser-insert-image" onClick={() => startInsertImages(editor, { index: defaultInsertIndex(editor) })} />
        </span>
        <span className="pdfx-organiser-spacer" />
        <span className="pdfx-organiser-sizes" role="radiogroup" aria-label={t("Thumbnail size")} onKeyDown={onSizeKeyDown}>
          {THUMB_SIZES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={size === value ? "true" : "false"}
              aria-label={sizeNames[value]}
              tabIndex={size === value ? 0 : -1}
              className="pdfx-btn"
              data-size={value}
              data-tip={sizeNames[value]}
              data-tip-align="end"
              data-testid={`pdfx-organiser-size-${value}`}
              onClick={() => setThumbSize(ui, value)}
            >
              {sizeLetters[value]}
            </button>
          ))}
        </span>
        <BarButton label={t("Done")} text={t("Done")} primary tipAlign="end" hint={t("Back to the pages (Esc)")} testId="pdfx-action-organiser-done" onClick={() => onClose()} />
      </div>
      <p className="pdfx-organiser-hint" id="pdfx-organiser-hint">
        {t("Drag pages to reorder them, or select pages and use the buttons above. Double-click a page to open it.")}
      </p>
      <PageGrid variant="organiser" tileWidth={TILE_WIDTHS[size]} label={t("Pages of the document")} describedBy="pdfx-organiser-hint" onOpen={(pageId) => openPage(editor, pageId)} />
    </div>
  );
}
