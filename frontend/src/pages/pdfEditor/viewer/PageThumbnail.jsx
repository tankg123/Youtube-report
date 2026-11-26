import { useCallback, useSyncExternalStore } from "react";
import { visiblePageSize } from "./pageList.js";
import "../styles/viewer.css";

// A small picture of one page of the controller's list: thumbnails of the pages panel, tiles of the page
// organiser, the position preview of a signature.
//
//   <PageThumbnail controller={controller} pageId={page.id} width={120} />
//
// React renders a <canvas> with the right box (the page's proportions, rotation included); the controller
// draws it when it comes near the screen (its nearest scrolling ancestor is the reference), redraws it when the
// page changes and frees the bitmap when it scrolls away. The canvas carries data-thumbnail-for and
// data-render-state ("pending" | "rendering" | "ready" | "error"). It is decorative: the control around it
// names the page.
export default function PageThumbnail({ controller, pageId, width = 120, className, ...rest }) {
  const page = useSyncExternalStore(controller.subscribe, () => controller.getPage(pageId));
  const canvasRef = useCallback((canvas) => controller.attachThumbnail(canvas, { pageId, width }), [controller, pageId, width]);
  if (!page) return null;
  const size = visiblePageSize(page);
  const height = Math.max(1, Math.round((width * size.height) / size.width));
  return (
    <canvas
      {...rest}
      ref={canvasRef}
      className={className ? `pdfx-thumbnail ${className}` : "pdfx-thumbnail"}
      style={{ width, height }}
      data-thumbnail-for={pageId}
      aria-hidden="true"
    />
  );
}
