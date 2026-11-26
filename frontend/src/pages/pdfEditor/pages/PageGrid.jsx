import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Files } from "lucide-react";
import { useDocument, useEditor, useFeatureState, useViewer } from "../ui/editorHooks.js";
import { pendingMarkCounts, sourceColors } from "./pageLogic.js";
import { FEATURE_ID } from "./pagesState.js";
import PageTile from "./PageTile.jsx";
import { focusTile, usePageGrid } from "./usePageGrid.js";

// The pages of the document as a grid of tiles: the list of the Pages panel (two columns) and the grid of
// the organiser are the same component with another tile width.
//
// Accessibility: a listbox with aria-multiselectable; every page is an option named "Page 3, rotated 90
// degrees, 2 redaction or blur marks waiting"; one tab stop (the page that had the keyboard last, else the
// page the reader is on). The keys are those of the organiser scope of tools/keymap.js (arrows, Space, Shift
// + arrows, Enter, Ctrl+Shift+arrows, R, Delete, Ctrl+A, Ctrl+D): the grid carries data-pdfx-scope="organiser"
// and pages/pageCommands.js answers them; Home, End and the menu key are handled here.
//
// Test hooks: [data-testid="pdfx-pagegrid-<variant>"] (data-pdfx-pages-grid, data-page-count, data-selected-count,
// during a drag data-dragging and data-drop-gap); tiles are pdfx-pagetile (see PageTile.jsx);
// pdfx-pagegrid-bar, pdfx-pagegrid-ghost, pdfx-pagegrid-marquee.

const EMPTY = Object.freeze([]);

/**
 * @param {object} props
 * @param {"panel" | "organiser"} props.variant
 * @param {number} props.tileWidth     width of a thumbnail box in CSS pixels
 * @param {string} props.label         the accessible name of the list (translated)
 * @param {string} [props.describedBy] id of an element that explains the list (the hint of the organiser)
 * @param {(pageId: string) => void} [props.onOpen]  double click on a page
 * @param {boolean} [props.followCurrent]  keep the page the reader is on in view (the panel)
 */
export default function PageGrid({ variant, tileWidth, label, describedBy, onOpen, followCurrent = false }) {
  const { viewer } = useEditor();
  const pages = useDocument((state) => state.pages);
  const objects = useDocument((state) => state.objects);
  const sources = useDocument((state) => state.sources);
  const assets = useDocument((state) => state.assets);
  const currentPageId = useViewer((state) => state.currentPageId);
  const [bag] = useFeatureState(FEATURE_ID);
  const selected = bag?.selected || EMPTY;
  const focus = bag?.focus || null;
  const reveal = bag?.reveal || null;

  const scrollRef = useRef(null);
  const wrapRef = useRef(null);
  const gridRef = useRef(null);
  const barRef = useRef(null);
  const ghostRef = useRef(null);
  const marqueeRef = useRef(null);
  const handlers = usePageGrid({ variant, scrollRef, wrapRef, gridRef, barRef, ghostRef, marqueeRef, onOpen });

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const colors = useMemo(() => sourceColors(pages), [pages]);
  const marks = useMemo(() => pendingMarkCounts(pages, objects), [pages, objects]);
  // the pictures on each page, for the thumbnails (pages without pictures are not in the table)
  const pictures = useMemo(() => {
    const table = new Map();
    for (const page of pages) {
      if (!page.objectIds.length) continue;
      const list = [];
      for (const id of page.objectIds) {
        const object = objects[id];
        if (object?.type !== "image" || !assets[object.assetId]) continue;
        list.push({ id, assetId: object.assetId, mime: assets[object.assetId].mime, frame: object.frame, opacity: object.opacity });
      }
      if (list.length) table.set(page.id, list);
    }
    return table;
  }, [pages, objects, assets]);
  const known = (id) => Boolean(id) && pages.some((page) => page.id === id);
  const tabbable = known(focus) ? focus : known(currentPageId) ? currentPageId : pages[0]?.id;

  // The keyboard stays in the list when the tile that had it goes away or is put somewhere else (a page was
  // deleted, moved, an operation was undone): the page that is the tab stop now takes it.
  const ownsFocus = useRef(false);
  useLayoutEffect(() => {
    if (!ownsFocus.current || !tabbable) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    focusTile(gridRef.current, tabbable);
  }, [pages, tabbable]);

  // a page that an operation asks to show (a new page, the copy of a page, pages that were moved)
  const revealToken = reveal?.token || 0;
  const revealId = reveal?.id || null;
  useEffect(() => {
    if (!revealToken || !revealId) return;
    gridRef.current?.querySelector(`[data-page-id="${CSS.escape(revealId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [revealToken, revealId]);

  // the panel follows the reader, unless the pointer is busy inside it
  useEffect(() => {
    if (!followCurrent || !currentPageId) return;
    const scroller = scrollRef.current;
    if (!scroller || scroller.matches(":hover") || scroller.contains(document.activeElement)) return;
    gridRef.current?.querySelector(`[data-page-id="${CSS.escape(currentPageId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [followCurrent, currentPageId]);

  return (
    <div
      ref={scrollRef}
      className="pdfx-pagegrid-scroll"
      data-variant={variant}
      onPointerDown={handlers.onPointerDown}
      onClick={handlers.onClick}
      onDoubleClick={handlers.onDoubleClick}
      onContextMenu={handlers.onContextMenu}
      onFocus={() => {
        ownsFocus.current = true;
      }}
      onBlur={(event) => {
        // the focus went to another control; a tile that was removed gives no such target
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) ownsFocus.current = false;
      }}
    >
      <div ref={wrapRef} className="pdfx-pagegrid-wrap">
        <div
          ref={gridRef}
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          aria-describedby={describedBy}
          className="pdfx-pagegrid"
          style={{ "--pdfx-tile-width": `${tileWidth}px` }}
          data-pdfx-pages-grid={variant}
          data-pdfx-scope="organiser"
          data-page-count={pages.length}
          data-selected-count={selected.length}
          data-testid={`pdfx-pagegrid-${variant}`}
          onKeyDown={handlers.onKeyDown}
        >
          {pages.map((page, index) => (
            <PageTile
              key={page.id}
              controller={viewer}
              page={page}
              number={index + 1}
              width={tileWidth}
              selected={selectedSet.has(page.id)}
              tabbable={page.id === tabbable}
              current={page.id === currentPageId}
              marks={marks.get(page.id) || 0}
              sourceColor={page.sourceId ? colors.get(page.sourceId) || null : null}
              sourceName={page.sourceId && colors.size ? sources[page.sourceId]?.name || "" : ""}
              images={pictures.get(page.id) || null}
              checkable={variant === "organiser"}
            />
          ))}
        </div>
        <div ref={barRef} className="pdfx-pagegrid-bar" hidden aria-hidden="true" data-testid="pdfx-pagegrid-bar" />
        <div ref={marqueeRef} className="pdfx-pagegrid-marquee" hidden aria-hidden="true" data-testid="pdfx-pagegrid-marquee" />
      </div>
      <div ref={ghostRef} className="pdfx-pagegrid-ghost" hidden aria-hidden="true" data-testid="pdfx-pagegrid-ghost">
        <Files size={16} strokeWidth={1.75} />
        <span data-ghost-count="true" />
      </div>
    </div>
  );
}
