import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../context/I18nContext";
import { zoomPercent } from "../viewer/zoom.js";
import { useDocument, useUi, useViewer } from "./editorHooks.js";

// What a screen reader hears when the view changes without anything being said on screen (UX specification
// 13, "Announcements"): the page that is current after a jump or a scroll ("Page 3 of 12") and the zoom the
// user chose ("Zoom 125 %"). One polite live region that is always in the document; it speaks a moment after
// the last change, so that scrolling through twenty pages says one page number, not twenty.
// Not announced: a document that opens or closes (what appears on screen says it), and the zoom while it
// follows the width of the window by itself ("Automatic").
// Results of actions (a file was downloaded, pages were deleted) are toasts, which are live regions of their own.
// Test hook: pdfx-announcer.
const SETTLE_MS = 700;

export default function Announcer() {
  const { t } = useI18n();
  const pageNumber = useViewer((state) => state.currentPageNumber);
  const zoom = useViewer((state) => state.zoom);
  const pageCount = useDocument((state) => state.pages.length);
  const autoZoom = useUi((state) => state.autoZoom);
  const [message, setMessage] = useState("");
  const known = useRef({ pageNumber, percent: zoomPercent(zoom), pageCount });

  useEffect(() => {
    const percent = zoomPercent(zoom);
    const before = known.current;
    if (!pageCount || !before.pageCount || before.pageCount !== pageCount) {
      known.current = { pageNumber, percent, pageCount };
      return undefined;
    }
    if (autoZoom) known.current = { ...before, percent };
    if (known.current.pageNumber === pageNumber && known.current.percent === percent) return undefined;
    const timer = setTimeout(() => {
      const parts = [];
      if (known.current.pageNumber !== pageNumber && pageNumber > 0) parts.push(t("Page {page} of {count}", { page: pageNumber, count: pageCount }));
      if (known.current.percent !== percent) parts.push(t("Zoom {percent}%", { percent }));
      known.current = { pageNumber, percent, pageCount };
      if (parts.length) setMessage(parts.join(". "));
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [pageNumber, zoom, pageCount, autoZoom, t]);

  return (
    <div className="pdfx-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="pdfx-announcer">
      {message}
    </div>
  );
}
