import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../../context/I18nContext";
import { isMark } from "../model/schema.js";
import { canRotate } from "../model/transform.js";
import { commandById } from "../tools/registry.js";
import { BarButton } from "../ui/controls.jsx";
import { useDocument, useEditor, useInteraction, useViewer } from "../ui/editorHooks.js";
import { iconByName } from "../ui/icons.js";
import { MenuButton } from "../ui/Menu.jsx";
import { shortcutLabel } from "../ui/shortcutLabels.js";
import { ROTATE_OFFSET, selectionPixelBox, userRectToPixels } from "./geometry.js";
import { attachPointer } from "./pointer.js";
import { getRuntime } from "./runtime.js";
import "../styles/overlay.css";

// What floats over the pages and scrolls with them (the selectionBar slot of the manifest: an element at the
// origin of the scrolled content, so positions are offsets of page elements):
//   * the selection bar: Edit, Duplicate, Arrange, Delete, 8 px above the selection (below it when there is
//     no room), hidden while a gesture runs (UX specification 3.1)
//   * the popover over a native text selection: Copy, Highlight, Redact (UX specification 7.2 and 7.7)
// This component is mounted exactly while a document is open, so it also connects the pointer and the
// clipboard of the page area to the interaction reducer (overlay/pointer.js).
//
// Test hooks: pdfx-selection-bar (data-count, data-placed), pdfx-action-selection-edit / -duplicate /
// -arrange / -delete, pdfx-menu-arrange; pdfx-text-popover, pdfx-action-text-copy / -highlight / -redact.

const icon = (id) => iconByName(commandById(id)?.icon);
const keepFocus = (event) => event.preventDefault();
const BAR_GAP = 8;

const pageElement = (container, pageId) => container?.querySelector(`.pdfx-page[data-page-id="${CSS.escape(pageId)}"]`) || null;

/** Calls `onChange` whenever the room for the pages changes (their elements move sideways then). */
function watchLayout(container, onChange) {
  if (!container || typeof ResizeObserver !== "function") return () => {};
  const observer = new ResizeObserver(() => onChange());
  observer.observe(container);
  const pages = container.querySelector(".pdfx-pages");
  if (pages) observer.observe(pages);
  return () => observer.disconnect();
}

function SelectionBar({ runtime }) {
  const { t } = useI18n();
  const { actions } = runtime.editor;
  const interaction = useInteraction();
  const objects = useDocument((state) => state.objects);
  const pages = useDocument((state) => state.pages);
  const scale = useViewer((state) => state.scale);
  const ref = useRef(null);
  const selection = interaction.selection.map((id) => objects[id]).filter(Boolean);
  const visible = interaction.mode === "idle" && selection.length > 0;

  // The bar is placed by hand after every render and whenever the pages move: its position comes from the
  // offsets of a page element, which only the DOM knows.
  useLayoutEffect(() => {
    const bar = ref.current;
    const container = bar?.closest(".pdfx-viewer");
    if (!bar || !container) return undefined;
    const place = () => {
      const first = selection[0];
      const page = first ? pages.find((entry) => entry.id === first.pageId) : null;
      const element = first ? pageElement(container, first.pageId) : null;
      const box = page ? selectionPixelBox(selection.filter((object) => object.pageId === first.pageId), page, scale) : null;
      if (!page || !element || !box) {
        bar.setAttribute("data-placed", "false");
        bar.style.visibility = "hidden";
        return;
      }
      const height = bar.offsetHeight || 40;
      const width = bar.offsetWidth || 160;
      // the rotation handle stands above the box: the bar keeps clear of it
      const clearance = BAR_GAP + (selection.length === 1 && canRotate(first) ? ROTATE_OFFSET + 8 : 0);
      const above = element.offsetTop + box[1] - clearance - height;
      const below = element.offsetTop + box[3] + BAR_GAP;
      const centre = element.offsetLeft + (box[0] + box[2]) / 2;
      const left = Math.max(container.scrollLeft + 4, Math.min(centre - width / 2, container.scrollLeft + container.clientWidth - width - 4));
      bar.style.left = `${Math.round(left)}px`;
      bar.style.top = `${Math.round(above >= container.scrollTop + 4 ? above : below)}px`;
      bar.style.visibility = "visible";
      bar.setAttribute("data-placed", "true");
    };
    place();
    return watchLayout(container, place);
  });

  if (!visible) return null;
  const single = selection.length === 1 ? selection[0] : null;
  const arrangeable = selection.some((object) => !isMark(object));
  const arrange = (id, direction) => ({ id, label: t(commandById(id).label), icon: icon(id), shortcut: shortcutLabel(id), testId: `pdfx-action-${id}`, onSelect: () => runtime.arrangeSelection(direction) });
  return (
    <div ref={ref} className="pdfx-selection-bar" role="toolbar" aria-label={t("Selection")} data-testid="pdfx-selection-bar" data-count={selection.length} data-placed="false" style={{ visibility: "hidden" }} onMouseDown={keepFocus}>
      {single?.type === "text" ? <BarButton icon={icon("editObject")} label={t("Edit text")} shortcut={shortcutLabel("editObject")} tipSide="top" testId="pdfx-action-selection-edit" onClick={() => actions.runCommand("editObject")} /> : null}
      <BarButton icon={icon("duplicate")} label={t("Duplicate object")} shortcut={shortcutLabel("duplicate")} tipSide="top" testId="pdfx-action-selection-duplicate" onClick={() => runtime.duplicateSelection()} />
      {arrangeable ? (
        <MenuButton
          icon={icon("bringToFront")}
          label={t("Arrange")}
          tipSide="top"
          testId="pdfx-action-selection-arrange"
          menuTestId="pdfx-menu-arrange"
          items={[arrange("bringToFront", "front"), arrange("bringForward", "forward"), arrange("sendBackward", "backward"), arrange("sendToBack", "back")]}
        />
      ) : null}
      <BarButton icon={icon("delete")} label={t("Delete")} shortcut={shortcutLabel("delete")} tipSide="top" testId="pdfx-action-selection-delete" onClick={() => runtime.deleteSelection()} />
    </div>
  );
}

function TextPopover({ runtime }) {
  const { t } = useI18n();
  const { store, viewer } = runtime.editor;
  const interaction = useInteraction();
  const scale = useViewer((state) => state.scale);
  const [place, setPlace] = useState(null);
  const active = interaction.tool === "select" && interaction.mode === "idle" && interaction.selection.length === 0;

  useEffect(() => {
    if (!active) return undefined;
    const container = viewer.getContainer();
    if (!container) return undefined;
    let pressed = false;
    const update = () => {
      const [part] = viewer.getTextSelection();
      const page = part ? store.getState().pages.find((entry) => entry.id === part.pageId) : null;
      const element = part ? pageElement(container, part.pageId) : null;
      if (!part || !page || !element) {
        setPlace(null);
        return;
      }
      const box = userRectToPixels(page, part.rect, viewer.getScale());
      setPlace({ left: Math.round(element.offsetLeft + (box[0] + box[2]) / 2), top: Math.round(element.offsetTop + box[1] - BAR_GAP) });
    };
    const onDown = (event) => {
      if (event.target instanceof Element && event.target.closest(".pdfx-text-popover")) return;
      pressed = true;
      setPlace(null);
    };
    const onUp = () => {
      pressed = false;
      // the browser settles the selection after the release
      setTimeout(update, 0);
    };
    const onSelection = () => {
      if (!pressed) update();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("selectionchange", onSelection);
    const stopWatching = watchLayout(container, onSelection);
    const first = setTimeout(update, 0);
    return () => {
      clearTimeout(first);
      stopWatching();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [active, store, viewer, scale]);

  if (!active || !place) return null;
  const copy = () => {
    // the browser copies its own selection (the copy handler of the overlay only takes selected objects)
    try {
      document.execCommand("copy");
    } catch {
      // nothing to fall back to: Ctrl+C still works
    }
  };
  return (
    <div className="pdfx-selection-bar pdfx-text-popover" role="toolbar" aria-label={t("Selected text")} data-testid="pdfx-text-popover" style={{ left: `${place.left}px`, top: `${place.top}px` }} onMouseDown={keepFocus}>
      <BarButton icon={icon("copy")} label={t("Copy")} shortcut={shortcutLabel("copy")} tipSide="top" testId="pdfx-action-text-copy" onClick={copy} />
      <BarButton icon={icon("highlightSelection")} label={t("Highlight")} tipSide="top" testId="pdfx-action-text-highlight" onClick={() => runtime.markTextSelection("highlight")} />
      <BarButton icon={icon("redactSelection")} label={t("Redact")} tipSide="top" testId="pdfx-action-text-redact" onClick={() => runtime.markTextSelection("redact")} />
    </div>
  );
}

export default function OverlayFloats() {
  const editor = useEditor();
  const runtime = getRuntime(editor);

  useEffect(() => {
    // the scroll container is attached by the page area before effects run
    const container = editor.viewer.getContainer();
    return container ? attachPointer(editor, container) : undefined;
  }, [editor]);

  return (
    <>
      <SelectionBar runtime={runtime} />
      <TextPopover runtime={runtime} />
    </>
  );
}
