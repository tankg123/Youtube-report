import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FilePlus2, FileText, FileWarning, FolderOpen, RotateCw } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import ViewerPages from "../viewer/ViewerPages.jsx";
import { WHEEL_ZOOM_STEP } from "./actions.js";
import { SlotBoundary } from "./controls.jsx";
import { useDocument, useEditor, useUi } from "./editorHooks.js";

// The page area (UX specification 3.1 E, 7.2 and 10): the continuous scroll of pages of viewer/ViewerPages.jsx
// with, inside every page, the overlays of the features and the "could not be displayed" notice; around the
// pages the empty state, the card of a file that could not be opened and the selection bars of the features.
//
// What the kernel does here itself:
//   * Ctrl + wheel (and pinch on a touch pad) zooms around the pointer
//   * "Automatic" zoom follows the width of the area
//   * Hand tool / Space held (pointer mode "none"): a drag scrolls the pages
// Everything else on a page belongs to the overlay feature (pointer modes: ui/uiStore.js pointerModeFor).
//
// Test hooks: the scroll container is [data-testid="pdfx-viewer"] (ViewerPages puts data-page-* and
// data-render-state on every page); pdfx-empty, pdfx-action-open-empty, pdfx-action-blank-document;
// pdfx-open-error (data-code), pdfx-action-open-other; pdfx-page-error with pdfx-action-retry-page.

/** Pinch on a touch pad arrives as Ctrl + wheel with small deltas; a mouse wheel notch is 100 or more. */
const WHEEL_NOTCH = 50;
const PINCH_SENSITIVITY = 0.01;

/** One page: the overlays of the features, and the notice of a page that could not be drawn. */
function PageLayer({ page, view }) {
  const { t } = useI18n();
  const { actions, features, reportSlotError } = useEditor();
  return (
    <>
      {features.pageOverlays.map((Overlay, index) => (
        <SlotBoundary key={index} onError={reportSlotError}>
          <Overlay page={page} view={view} />
        </SlotBoundary>
      ))}
      {view.renderState === "error" ? (
        <div className="pdfx-page-error" role="alert" data-testid="pdfx-page-error">
          <FileWarning size={22} strokeWidth={1.75} aria-hidden="true" />
          <p>{t("This page could not be displayed.")}</p>
          <button type="button" className="pdfx-page-error-retry" data-testid="pdfx-action-retry-page" onClick={() => actions.retryPage(page.id)}>
            <RotateCw size={14} strokeWidth={2} aria-hidden="true" />
            {t("Try again")}
          </button>
        </div>
      ) : null}
    </>
  );
}

function EmptyState() {
  const { t } = useI18n();
  const { actions } = useEditor();
  return (
    <div className="pdfx-empty" data-testid="pdfx-empty">
      <div className="pdfx-empty-card">
        <FileText size={36} strokeWidth={1.5} aria-hidden="true" className="pdfx-empty-icon" />
        <p className="pdfx-empty-lead">{t("Drop PDF files here or choose files.")}</p>
        <div className="pdfx-empty-actions">
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-primary" data-testid="pdfx-action-open-empty" onClick={() => actions.openFilePicker("open")}>
            <FolderOpen size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Choose files")}</span>
          </button>
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-blank-document" onClick={() => actions.newBlankDocument()}>
            <FilePlus2 size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Blank document (A4)")}</span>
          </button>
        </div>
        <p className="pdfx-empty-note">{t("Files are processed in your browser and are never uploaded.")}</p>
        <p className="pdfx-empty-note">{t("Several files open as one document, in the order you choose them.")}</p>
      </div>
    </div>
  );
}

/** The file that was asked for could not be opened (not a PDF, damaged, the viewer failed). */
function OpenError({ failure }) {
  const { t } = useI18n();
  const { actions, messages } = useEditor();
  return (
    <div className="pdfx-empty" data-testid="pdfx-open-error" data-code={failure.code}>
      <div className="pdfx-empty-card" role="alert">
        <FileWarning size={36} strokeWidth={1.5} aria-hidden="true" className="pdfx-empty-icon pdfx-empty-icon-error" />
        <p className="pdfx-empty-lead">{t("Could not open this file")}</p>
        {failure.fileName ? <p className="pdfx-empty-file">{failure.fileName}</p> : null}
        <p className="pdfx-empty-note">{messages.describeCode(failure.code, failure.params)}</p>
        <div className="pdfx-empty-actions">
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-primary" data-testid="pdfx-action-open-other" onClick={() => actions.openFilePicker("open")}>
            <FolderOpen size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Choose another file")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PageArea({ hidden = false }) {
  const { t } = useI18n();
  const editor = useEditor();
  const { actions, features, reportSlotError, store, ui, viewer } = editor;
  const pointer = useSyncExternalStore(ui.subscribe, ui.getPointerMode);
  const hasDocument = useDocument((state) => state.pages.length > 0);
  const openError = useUi((state) => state.openError);
  const busy = useUi((state) => state.job !== null);
  const [panning, setPanning] = useState(false);
  const drag = useRef(null); // { pointerId, x, y } while the hand drags the pages

  const renderOverlay = useCallback((page, view) => <PageLayer page={page} view={view} />, []);
  // every page is a group with a name a screen reader can say (UX specification 13)
  const pageLabel = useCallback((page, index, total) => t("Page {page} of {count}", { page: index + 1, count: total }), [t]);

  useEffect(() => {
    const container = viewer.getContainer();
    if (!container) return undefined;
    const unregister = editor.registerElement("viewer", container);

    // React's wheel listeners are passive: only a native one can keep the browser from zooming the whole tab
    const onWheel = (event) => {
      if (!(event.ctrlKey || event.metaKey) || !store.getState().pages.length) return;
      event.preventDefault();
      const delta = event.deltaMode === 0 ? event.deltaY : event.deltaY * 100;
      if (!delta) return;
      const factor = Math.abs(delta) >= WHEEL_NOTCH ? (delta < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP) : Math.exp(-delta * PINCH_SENSITIVITY);
      actions.zoomBy(factor, { clientX: event.clientX, clientY: event.clientY });
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    // "Automatic" zoom keeps fitting the width (at most 125 %) when the room for the pages changes
    let width = container.clientWidth;
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (container.clientWidth === width) return;
            width = container.clientWidth;
            if (ui.getState().autoZoom && store.getState().pages.length) actions.zoomAuto();
          })
        : null;
    observer?.observe(container);

    return () => {
      container.removeEventListener("wheel", onWheel);
      observer?.disconnect();
      unregister();
    };
  }, [actions, editor, store, ui, viewer]);

  const stopPan = (event) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <ViewerPages
      controller={viewer}
      renderOverlay={renderOverlay}
      pointer={pointer}
      className="pdfx-page-area"
      pageLabel={pageLabel}
      tabIndex={hidden ? -1 : 0}
      role="region"
      aria-label={t("Document pages")}
      aria-busy={busy ? "true" : undefined}
      data-testid="pdfx-viewer"
      data-panning={panning ? "true" : "false"}
      data-hidden={hidden ? "true" : "false"}
      onPointerDown={(event) => {
        // the hand: a drag on the pages scrolls them (pointer mode "none" leaves the pointer to this element)
        if (pointer !== "none" || event.button !== 0 || !hasDocument) return;
        if (event.target.closest?.("a, button, input, [data-object-id]")) return;
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setPanning(true);
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || state.pointerId !== event.pointerId) return;
        event.currentTarget.scrollBy(state.x - event.clientX, state.y - event.clientY);
        state.x = event.clientX;
        state.y = event.clientY;
      }}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
    >
      {hasDocument ? (
        <div className="pdfx-viewer-floats">
          {features.selectionBars.map((Bar, index) => (
            <SlotBoundary key={index} onError={reportSlotError}>
              <Bar />
            </SlotBoundary>
          ))}
        </div>
      ) : openError ? (
        <OpenError failure={openError} />
      ) : (
        <EmptyState />
      )}
    </ViewerPages>
  );
}
