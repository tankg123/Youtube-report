import { Pin, PinOff, X } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { BarButton, SlotBoundary } from "./controls.jsx";
import DocumentSummary from "./DocumentSummary.jsx";
import { useDocument, useEditor, useUi } from "./editorHooks.js";
import SlotFailure from "./SlotFailure.jsx";

// The right side of the editor (UX specification 3.1 F): the properties panel of the overlay feature, or the
// drawer a feature opened in its place (ui.openDrawer(id, props): the certificate signing steps).
// From 1200 px it is a column of its own; below that it lies over the pages and can be pinned (it then stays
// open when the selection is cleared); below 900 px it is a sheet at the bottom (styles/shell.css).
// Where it lies over the stage it gives way to a full-screen view (the page organiser): the view has a bar of
// its own, and the panel covered the right end of that bar with its "Done" button. The panel is only not
// shown meanwhile; it is back, as it was, when the view closes.
//
// Test hooks: pdfx-inspector, pdfx-action-pin-inspector, pdfx-action-close-inspector, pdfx-drawer-<id>.
export default function RightSide() {
  const { t } = useI18n();
  const { features, reportSlotError, ui } = useEditor();
  const drawer = useUi((state) => state.drawer);
  const inspector = useUi((state) => state.inspector);
  const layout = useUi((state) => state.layout);
  const view = useUi((state) => state.view);
  const hasDocument = useDocument((state) => state.pages.length > 0);

  const Drawer = drawer ? features.drawers[drawer.id] : null;
  if (Drawer) {
    return (
      <aside className="pdfx-side pdfx-side-drawer" data-testid={`pdfx-drawer-${drawer.id}`} data-drawer-id={drawer.id}>
        <SlotBoundary key={drawer.id} onError={reportSlotError} fallback={(retry) => <SlotFailure onRetry={retry} />}>
          <Drawer {...drawer.props} onClose={() => ui.closeDrawer()} />
        </SlotBoundary>
      </aside>
    );
  }

  if (!inspector.open || !hasDocument) return null;
  if (view && layout !== "wide") return null;
  const Panel = features.propertiesPanel || DocumentSummary;
  return (
    <aside className="pdfx-side" aria-label={t("Properties")} data-testid="pdfx-inspector" data-pinned={inspector.pinned ? "true" : "false"}>
      <header className="pdfx-panel-head">
        <h2>{t("Properties")}</h2>
        {layout === "medium" ? (
          <BarButton
            icon={inspector.pinned ? PinOff : Pin}
            label={inspector.pinned ? t("Unpin the panel") : t("Keep the panel open")}
            pressed={inspector.pinned}
            tipAlign="end"
            testId="pdfx-action-pin-inspector"
            onClick={() => ui.setInspector({ pinned: !inspector.pinned })}
          />
        ) : null}
        <BarButton icon={X} label={t("Close panel")} tipAlign="end" testId="pdfx-action-close-inspector" onClick={() => ui.setInspector({ open: false })} />
      </header>
      <div className="pdfx-panel-body">
        <SlotBoundary onError={reportSlotError} fallback={(retry) => <SlotFailure onRetry={retry} />}>
          <Panel />
        </SlotBoundary>
      </div>
    </aside>
  );
}
