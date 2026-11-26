import { X } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { BarButton, SlotBoundary } from "./controls.jsx";
import { useEditor, useUi } from "./editorHooks.js";
import { iconByName } from "./icons.js";
import SlotFailure from "./SlotFailure.jsx";

// The panel rail and the open left panel (UX specification 3.1 C and D). The panels come from the feature
// manifests (`panels`: { id: { labelKey, icon, component, order } }); a click on the tab of the open panel
// closes it. From 1200 px the panel is a column of its own, below that it lies over the page area, below
// 900 px it is a full-height sheet that the overflow menu opens (styles/shell.css).
//
// Accessibility: the rail is a vertical tablist (Up / Down move between the tabs), the panel a tabpanel.
// Test hooks: pdfx-panel-tab-<id> (aria-selected), pdfx-panel-<id>, pdfx-action-close-panel.

const TAB_KEYS = ["ArrowUp", "ArrowDown", "Home", "End"];

export default function LeftRail() {
  const { t } = useI18n();
  const { actions, features, ui, reportSlotError } = useEditor();
  const open = useUi((state) => state.leftPanel);
  if (!features.panels.length) return null;
  const active = features.panels.find((panel) => panel.id === open) || null;
  const Panel = active?.component;
  const focusable = active ? active.id : features.panels[0].id;

  const onKeyDown = (event) => {
    if (!TAB_KEYS.includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else next = tabs.length - 1;
    event.preventDefault();
    tabs[next].focus();
  };

  return (
    <>
      <nav className="pdfx-rail" aria-label={t("Side panels")}>
        <div role="tablist" aria-orientation="vertical" className="pdfx-rail-tabs" onKeyDown={onKeyDown}>
          {features.panels.map((panel) => (
            <BarButton
              key={panel.id}
              role="tab"
              icon={iconByName(panel.icon)}
              label={t(panel.labelKey)}
              aria-selected={open === panel.id ? "true" : "false"}
              aria-controls={open === panel.id ? `pdfx-panel-${panel.id}` : undefined}
              tabIndex={focusable === panel.id ? 0 : -1}
              tipSide="right"
              testId={`pdfx-panel-tab-${panel.id}`}
              onClick={() => actions.toggleLeftPanel(panel.id)}
            />
          ))}
        </div>
      </nav>
      {active ? (
        <aside className="pdfx-panel" role="tabpanel" id={`pdfx-panel-${active.id}`} aria-label={t(active.labelKey)} data-testid={`pdfx-panel-${active.id}`}>
          <header className="pdfx-panel-head">
            <h2>{t(active.labelKey)}</h2>
            <BarButton icon={X} label={t("Close panel")} tipAlign="end" testId="pdfx-action-close-panel" onClick={() => ui.closeLeftPanel()} />
          </header>
          <div className="pdfx-panel-body">
            <SlotBoundary key={active.id} onError={reportSlotError} fallback={(retry) => <SlotFailure onRetry={retry} />}>
              <Panel />
            </SlotBoundary>
          </div>
        </aside>
      ) : null}
    </>
  );
}
