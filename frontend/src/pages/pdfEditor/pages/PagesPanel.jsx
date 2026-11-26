import { EllipsisVertical, LayoutGrid, Plus } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { BarButton } from "../ui/controls.jsx";
import { useDocument, useEditor, useFeatureState, useUi } from "../ui/editorHooks.js";
import { shortcutLabel } from "../ui/shortcutLabels.js";
import { defaultInsertIndex } from "./pageFlows.js";
import { orderedSelection } from "./pageLogic.js";
import PageGrid from "./PageGrid.jsx";
import { FEATURE_ID, openMenu, targetPageIds } from "./pagesState.js";
import "../styles/pages.css";

// The Pages panel (UX specification 7.2): the thumbnails of the document in two columns with their position
// numbers; the page the reader is on is ringed. A click goes to a page; Ctrl and Shift select several;
// pages are reordered by dragging them (or with Ctrl+Shift+Left / Right, or "Move to position…"); the page
// menu (right click, the "..." of a thumbnail, the menu key, "Page actions") rotates, duplicates, inserts,
// extracts and deletes. Heavy work happens in the organiser ("Organise pages").
//
// Test hooks: pdfx-pages-panel (data-pages, data-selected), pdfx-pages-count, pdfx-action-page-actions,
// pdfx-action-add-pages, pdfx-action-organise; the list is pdfx-pagegrid-panel (pages/PageGrid.jsx).

/** Width of a thumbnail box: two of them fit the 240 px panel with its paddings and a scroll bar. */
const TILE_WIDTH = 88;

export default function PagesPanel() {
  const { t } = useI18n();
  const editor = useEditor();
  const { actions, ui } = editor;
  const pages = useDocument((state) => state.pages);
  const [bag] = useFeatureState(FEATURE_ID);
  const view = useUi((state) => state.view);
  const viewOnly = useUi((state) => Boolean(state.flags.viewOnly));
  if (!pages.length) return <p className="pdfx-pages-empty">{t("Open a PDF file to see its pages here.")}</p>;

  const selected = orderedSelection(
    pages.map((page) => page.id),
    bag?.selected || []
  );
  const lockedHint = viewOnly ? t("This file can be viewed but not edited here.") : undefined;

  const menuAt = (event, menu, above = false) => {
    const box = event.currentTarget.getBoundingClientRect();
    openMenu(ui, { ...menu, x: box.left, y: above ? box.top - 4 : box.bottom + 2, above, origin: event.currentTarget, token: Date.now() });
  };

  return (
    <div className="pdfx-pagespanel" data-testid="pdfx-pages-panel" data-pages={pages.length} data-selected={selected.length}>
      <div className="pdfx-pagespanel-bar">
        <span className="pdfx-pagespanel-count" data-testid="pdfx-pages-count">
          {selected.length > 1 ? t("{count} selected", { count: selected.length }) : pages.length === 1 ? t("1 page") : t("{count} pages", { count: pages.length })}
        </span>
        <BarButton
          icon={EllipsisVertical}
          label={t("Page actions")}
          hint={lockedHint}
          disabled={viewOnly}
          soft
          tipAlign="end"
          aria-haspopup="menu"
          testId="pdfx-action-page-actions"
          onClick={(event) => {
            const ids = targetPageIds(editor);
            if (ids.length) menuAt(event, { kind: "page", pageIds: ids });
          }}
        />
      </div>
      <PageGrid variant="panel" tileWidth={TILE_WIDTH} label={t("Pages")} followCurrent />
      <div className="pdfx-pagespanel-foot">
        <BarButton
          icon={Plus}
          label={t("Add pages")}
          text={t("Add")}
          hint={lockedHint}
          disabled={viewOnly}
          soft
          className="pdfx-btn-outline"
          tipSide="top"
          tipAlign="start"
          aria-haspopup="menu"
          testId="pdfx-action-add-pages"
          onClick={(event) => menuAt(event, { kind: "add", index: defaultInsertIndex(editor) }, true)}
        />
        <BarButton
          icon={LayoutGrid}
          label={t("Organise pages")}
          text={t("Organise pages")}
          shortcut={shortcutLabel("organise")}
          pressed={view === "organiser"}
          className="pdfx-btn-outline pdfx-pagespanel-organise"
          tipSide="top"
          tipAlign="end"
          testId="pdfx-action-organise"
          onClick={() => actions.toggleView("organiser")}
        />
      </div>
    </div>
  );
}
