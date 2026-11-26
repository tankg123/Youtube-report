import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { TOOL_GROUPS, TOOL_MENUS, TOOLS, commandById, toolById, toolsOfMenu } from "../tools/registry.js";
import { BarButton, BarSeparator } from "./controls.jsx";
import { useDocument, useEditor, useHistoryState, useUi } from "./editorHooks.js";
import { iconByName } from "./icons.js";
import { MenuPopup } from "./Menu.jsx";
import SearchBox from "./SearchBox.jsx";
import { shortcutLabel } from "./shortcutLabels.js";

// The tool bar (UX specification 3.1 B and 4), rendered from tools/registry.js: Undo, Redo, the five tool
// groups, the Shapes menu, and the search field on the right.
//
// Accessibility (APG toolbar pattern): role="toolbar" with ONE tab stop; Left / Right move between its
// controls, Home / End jump to the first / last, and the control that had the focus last gets it back.
// A tool that cannot be used (no document, a view-only document) stays focusable and says aria-disabled, with
// a tooltip that tells why. Tools are toggle buttons (aria-pressed); a double click locks a one-shot tool
// (data-locked="true").
//
// Test hooks: data-testid="pdfx-tool-<tool id>" on every tool button; the Shapes button is
// "pdfx-tool-shapes" (data-tool = the shape it starts), its menu opens with "pdfx-tool-shapes-menu" and holds
// "pdfx-tool-rect" / "-ellipse" / "-line" / "-arrow"; "pdfx-action-undo" / "pdfx-action-redo".

const SHAPE_TOOLS = toolsOfMenu("shapes");
const SHAPES_MENU = TOOL_MENUS.find((menu) => menu.id === "shapes");
const FIRST_ROVING = "undo";
const LONG_PRESS_MS = 500;
const MOVE_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

export default function ToolBar() {
  const { t } = useI18n();
  const editor = useEditor();
  const { actions } = editor;
  const tool = useUi((state) => state.interaction.tool);
  const locked = useUi((state) => state.interaction.toolLocked);
  const lastShape = useUi((state) => state.preferences.lastShape);
  const layout = useUi((state) => state.layout);
  const viewOnly = useUi((state) => state.flags.viewOnly);
  const hasDocument = useDocument((state) => state.pages.length > 0);
  const history = useHistoryState();
  const [roving, setRoving] = useState(FIRST_ROVING);
  const [shapesOpen, setShapesOpen] = useState(false);
  const barRef = useRef(null);
  const shapesArrowRef = useRef(null);
  const press = useRef({ timer: 0, fired: false });

  // Alt+F10 puts the keyboard on the control of the bar that had it last
  useEffect(() => {
    const bar = barRef.current;
    return editor.registerElement("toolbar", {
      focus: () => {
        const target = bar?.querySelector('[data-roving][tabindex="0"]') || bar?.querySelector("[data-roving]");
        if (!target) return;
        // A key with Alt does not count as "using the keyboard" for :focus-visible in every browser: the ring
        // and the tooltip of the control that receives the focus are asked for by name.
        target.setAttribute("data-keyboard-focus", "true");
        target.addEventListener("blur", () => target.removeAttribute("data-keyboard-focus"), { once: true });
        target.focus({ focusVisible: true });
      }
    });
  }, [editor]);

  const rovingProps = (id) => ({
    "data-roving": id,
    tabIndex: roving === id ? 0 : -1,
    onFocus: () => setRoving(id)
  });

  const onKeyDown = (event) => {
    if (!MOVE_KEYS.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = [...event.currentTarget.querySelectorAll("[data-roving]")];
    const index = items.indexOf(document.activeElement);
    if (index < 0) return;
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else next = items.length - 1;
    event.preventDefault();
    items[next].focus();
  };

  const blockedReason = (entry) => {
    if (!hasDocument) return t("Open a PDF to use the tools.");
    if (viewOnly && entry.edits) return t("This file can be viewed but not edited here.");
    return null;
  };

  const toolButton = (entry, extra = {}) => {
    const reason = blockedReason(entry);
    const active = tool === entry.id;
    return (
      <BarButton
        key={entry.id}
        soft
        icon={iconByName(entry.icon)}
        label={t(entry.label)}
        shortcut={entry.key}
        hint={reason || undefined}
        pressed={active}
        disabled={Boolean(reason)}
        testId={`pdfx-tool-${entry.id}`}
        data-tool={entry.id}
        data-locked={active && locked ? "true" : undefined}
        onClick={() => actions.setTool(entry.id)}
        onDoubleClick={() => {
          if (!reason && entry.mode === "one-shot") actions.setTool(entry.id, { lock: true });
        }}
        {...rovingProps(entry.id)}
        {...extra}
      />
    );
  };

  const shape = toolById(lastShape) || SHAPE_TOOLS[0];
  const shapeReason = blockedReason(shape);
  const shapeActive = SHAPE_TOOLS.some((entry) => entry.id === tool);
  const shapesMenu = t(SHAPES_MENU.label);
  const closeShapes = ({ focus } = {}) => {
    setShapesOpen(false);
    if (focus) shapesArrowRef.current?.focus({ preventScroll: true });
  };
  const stopLongPress = () => {
    clearTimeout(press.current.timer);
    press.current.timer = 0;
  };

  const shapesControl = (
    <span key="shapes" className="pdfx-split pdfx-menu-anchor">
      <BarButton
        soft
        icon={iconByName(shape.icon)}
        label={t(shape.label)}
        shortcut={shape.key}
        hint={shapeReason || undefined}
        pressed={shapeActive}
        disabled={Boolean(shapeReason)}
        testId="pdfx-tool-shapes"
        data-tool={shape.id}
        data-locked={shapeActive && locked ? "true" : undefined}
        aria-haspopup="menu"
        onPointerDown={() => {
          // a long press opens the menu (touch has no chevron-sized target)
          press.current.fired = false;
          if (shapeReason) return;
          press.current.timer = setTimeout(() => {
            press.current.fired = true;
            setShapesOpen(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={stopLongPress}
        onPointerLeave={stopLongPress}
        onPointerCancel={stopLongPress}
        onClick={() => {
          if (press.current.fired) {
            press.current.fired = false;
            return;
          }
          actions.setTool(shape.id);
        }}
        onDoubleClick={() => {
          if (!shapeReason) actions.setTool(shape.id, { lock: true });
        }}
        {...rovingProps("shapes")}
      />
      <BarButton
        ref={shapesArrowRef}
        soft
        icon={ChevronDown}
        iconSize={12}
        label={shapesMenu}
        hint={shapeReason || undefined}
        disabled={Boolean(shapeReason)}
        className="pdfx-split-arrow"
        testId="pdfx-tool-shapes-menu"
        aria-haspopup="menu"
        aria-expanded={shapesOpen ? "true" : "false"}
        onClick={() => setShapesOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || shapesOpen || shapeReason) return;
          event.preventDefault();
          event.stopPropagation();
          setShapesOpen(true);
        }}
        {...rovingProps("shapes-menu")}
      />
      <MenuPopup
        open={shapesOpen}
        onClose={closeShapes}
        label={shapesMenu}
        testId="pdfx-menu-shapes"
        items={SHAPE_TOOLS.map((entry) => ({
          id: entry.id,
          kind: "radio",
          label: t(entry.label),
          icon: iconByName(entry.icon),
          shortcut: entry.key,
          checked: tool === entry.id,
          testId: `pdfx-tool-${entry.id}`,
          onSelect: () => actions.setTool(entry.id)
        }))}
      />
    </span>
  );

  const undo = commandById("undo");
  const redo = commandById("redo");

  return (
    <div className="pdfx-toolrow" data-testid="pdfx-toolrow">
      <div ref={barRef} className="pdfx-toolbar" role="toolbar" aria-label={t("Editing tools")} aria-orientation="horizontal" data-testid="pdfx-toolbar" onKeyDown={onKeyDown}>
        <div className="pdfx-tool-group pdfx-tool-history" role="group" aria-label={t("Undo and redo")}>
          <BarButton soft icon={iconByName(undo.icon)} label={t(undo.label)} shortcut={shortcutLabel("undo")} disabled={!history.canUndo} testId="pdfx-action-undo" onClick={() => actions.undo()} {...rovingProps("undo")} />
          <BarButton soft icon={iconByName(redo.icon)} label={t(redo.label)} shortcut={shortcutLabel("redo")} disabled={!history.canRedo} testId="pdfx-action-redo" onClick={() => actions.redo()} {...rovingProps("redo")} />
        </div>
        <div className="pdfx-tool-scroll">
          {TOOL_GROUPS.map((group) => {
            const entries = TOOLS.filter((entry) => entry.group === group.id);
            const controls = [];
            let shapesPlaced = false;
            for (const entry of entries) {
              // the bottom strip of the narrow layout scrolls sideways (a menu would be cut off): every shape is a button there
              if (entry.menu === "shapes" && layout !== "narrow") {
                if (!shapesPlaced) controls.push(shapesControl);
                shapesPlaced = true;
              } else {
                controls.push(toolButton(entry));
              }
            }
            return (
              <div key={group.id} className="pdfx-tool-group-wrap">
                <BarSeparator />
                <div className="pdfx-tool-group" role="group" aria-label={t(group.label)} data-group={group.id}>
                  {controls}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <SearchBox />
    </div>
  );
}
