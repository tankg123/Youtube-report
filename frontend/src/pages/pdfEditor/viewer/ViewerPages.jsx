import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { viewportTransform } from "../engine/geometry.js";
import { pageGeometry } from "../model/schema.js";
import { slotStyle } from "./pageList.js";
import "../styles/viewer.css";

// The page list of the viewer. React owns one slot per page of the controller's list; the controller owns the
// inside of each slot's host element (canvas, text layer, link layer) and the scroll position.
//
//   <ViewerPages controller={controller} renderOverlay={(page, view) => <PageOverlay ... />} pointer="text" />
//
//   div.pdfx-viewer            the scroll container: data-busy, data-page-count, data-pdfx-pointer
//     div.pdfx-pages
//       div.pdfx-page          data-page-id, data-page-index, data-page-kind, data-scale, data-rotation,
//                              data-extra-rotation, data-page-width / -height (points), data-render-state;
//                              with pageLabel: role="group" and its accessible name
//         div.pdfx-page-host     filled by the controller
//         div.pdfx-page-overlay  renderOverlay(page, view)
//
// renderOverlay(page, view): `page` is the Page of the model, `view` = { pageId, pageNumber, scale, geometry,
// extraRotation, rotation, width, height, renderState }: the arguments of engine/geometry.js for this page
// (width / height = its viewport in CSS pixels at `scale`). It is called again when the page object, the
// scale, the render state or the function itself changes; scrolling never re-renders an overlay.
//
// pointer: "text" (default) | "overlay" | "none": who gets the pointer on a page, see styles/viewer.css. The
// same attribute (data-pdfx-pointer) on .pdfx-root works as well.
//
// pageLabel(page, index, total) -> string: the accessible name of a page ("Page 3 of 12"). The viewer holds no
// text for the user: whoever renders it supplies the words in the current language.
//
// Other props (className, tabIndex, event handlers, aria-*) go to the scroll container; children are rendered
// after the pages (inside the scroll container).

const PageSlot = memo(function PageSlot({ controller, page, index, scale, display, renderOverlay, label }) {
  const renderState = useSyncExternalStore(controller.subscribe, () => controller.getRenderState(page.id));
  // the controller creates its page view when the host element arrives and destroys it with the cleanup
  const hostRef = useCallback((element) => controller.attachPage(page.id, element), [controller, page.id]);
  const style = useMemo(() => slotStyle(page, scale, display), [page, scale, display]);
  const view = useMemo(() => {
    const geometry = pageGeometry(page);
    const viewport = viewportTransform(geometry, scale, page.rotation);
    return {
      pageId: page.id,
      pageNumber: index + 1,
      scale,
      geometry,
      extraRotation: page.rotation,
      rotation: viewport.rotation,
      width: viewport.width,
      height: viewport.height,
      renderState
    };
  }, [page, index, scale, renderState]);

  return (
    <div
      className="pdfx-page"
      role={label ? "group" : undefined}
      aria-label={label || undefined}
      style={style}
      data-page-id={page.id}
      data-page-index={index}
      data-page-kind={page.kind}
      data-scale={scale}
      data-rotation={view.rotation}
      data-extra-rotation={page.rotation}
      data-page-width={view.width / scale}
      data-page-height={view.height / scale}
      data-render-state={renderState}
    >
      <div className="pdfx-page-host" ref={hostRef} />
      <div className="pdfx-page-overlay">{renderOverlay ? renderOverlay(page, view) : null}</div>
    </div>
  );
});

export default function ViewerPages({ controller, renderOverlay, className, pointer, pageLabel, children, ...rest }) {
  const pages = useSyncExternalStore(controller.subscribe, controller.getPages);
  const scale = useSyncExternalStore(controller.subscribe, controller.getScale);
  const display = useSyncExternalStore(controller.subscribe, controller.getDisplay);
  const busy = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().busy.any);
  // the controller sets --scale-factor on the scroll container and listens to its scroll and size
  const containerRef = useCallback((element) => controller.attachContainer(element), [controller]);

  return (
    <div
      {...rest}
      className={className ? `pdfx-viewer ${className}` : "pdfx-viewer"}
      ref={containerRef}
      data-busy={busy ? "true" : "false"}
      data-page-count={pages.length}
      data-pdfx-pointer={pointer || rest["data-pdfx-pointer"] || "text"}
    >
      <div className="pdfx-pages">
        {pages.map((page, index) => (
          <PageSlot key={page.id} controller={controller} page={page} index={index} scale={scale} display={display} renderOverlay={renderOverlay} label={typeof pageLabel === "function" ? pageLabel(page, index, pages.length) : undefined} />
        ))}
      </div>
      {children}
    </div>
  );
}
