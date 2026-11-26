import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ClipboardPaste, FilePlus2, Image, RotateCw, Trash2 } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { isMark } from "../model/schema.js";
import { pageScreen } from "../model/shapes.js";
import { commandById } from "../tools/registry.js";
import { useDocument, useEditor, useFeatureState } from "../ui/editorHooks.js";
import { iconByName } from "../ui/icons.js";
import { MenuPopup } from "../ui/Menu.jsx";
import { shortcutLabel } from "../ui/shortcutLabels.js";
import { FEATURE_ID, getRuntime } from "./runtime.js";
import "../styles/overlay.css";

// The layer of the overlay feature over the whole editor (the contextMenu slot of the manifest):
//   * the context menu of the pages (UX specification 5.2): on an object, on an empty spot of a page, on a
//     text selection. It opens where the pointer was (position: fixed) and is moved back inside the window.
//   * the hidden file input of the Image tool and of "Replace image" (pdfx-image-input)
//
// Test hooks: pdfx-context-menu (data-menu = "object" | "page" | "text"), items pdfx-context-<id>.

const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml,image/avif,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.avif";
const icon = (id) => iconByName(commandById(id)?.icon);

function ContextMenu({ runtime, menu }) {
  const { t } = useI18n();
  const { actions, store, viewer } = runtime.editor;
  const objects = useDocument((state) => state.objects);
  const anchor = useRef(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });

  // keep the menu inside the window: measured where the list really is (it hangs a few pixels below and beside
  // its anchor), and taken back by the shift that is already applied, so that a second run changes nothing
  useLayoutEffect(() => {
    const list = anchor.current?.querySelector('[role="menu"]');
    if (!list) return;
    const box = list.getBoundingClientRect();
    const x = Math.min(0, window.innerWidth - 8 - (box.right - shift.x));
    const y = Math.min(0, window.innerHeight - 8 - (box.bottom - shift.y));
    if (x !== shift.x || y !== shift.y) setShift({ x, y });
  }, [menu, shift]);

  const selected = menu.ids.map((id) => objects[id]).filter(Boolean);
  const command = (id, onSelect, extra = {}) => ({ id, label: t(commandById(id).label), icon: icon(id), shortcut: shortcutLabel(id), testId: `pdfx-context-${id}`, onSelect, ...extra });
  let items;
  if (menu.menu === "object") {
    const single = selected.length === 1 ? selected[0] : null;
    const arrangeable = selected.some((object) => !isMark(object));
    items = [
      ...(single?.type === "text" ? [command("editObject", () => actions.runCommand("editObject")), { id: "s0", kind: "separator" }] : []),
      command("cut", () => runtime.copySelection(true)),
      command("copy", () => runtime.copySelection(false)),
      command("duplicate", () => runtime.duplicateSelection()),
      ...(arrangeable
        ? [
            { id: "s1", kind: "separator" },
            command("bringToFront", () => runtime.arrangeSelection("front")),
            command("bringForward", () => runtime.arrangeSelection("forward")),
            command("sendBackward", () => runtime.arrangeSelection("backward")),
            command("sendToBack", () => runtime.arrangeSelection("back"))
          ]
        : []),
      { id: "s2", kind: "separator" },
      command("delete", () => runtime.deleteSelection())
    ];
  } else if (menu.menu === "text") {
    items = [
      command("copy", () => {
        try {
          document.execCommand("copy");
        } catch {
          // Ctrl+C still works
        }
      }),
      command("highlightSelection", () => runtime.markTextSelection("highlight"), { shortcut: "" }),
      command("redactSelection", () => runtime.markTextSelection("redact"), { shortcut: "" })
    ];
  } else {
    const page = runtime.pageOf(menu.pageId);
    const pageOperation = async (run) => {
      if (!(await actions.beforeEdit())) return;
      try {
        run();
      } catch (error) {
        actions.reportError(error);
      }
    };
    items = [
      { id: "pasteHere", label: t("Paste here"), icon: ClipboardPaste, testId: "pdfx-context-pasteHere", onSelect: () => runtime.pasteAt(menu.pageId, menu.at) },
      command("selectAll", () => runtime.select(page ? page.objectIds.slice() : [])),
      { id: "insertImage", label: t("Insert image"), icon: Image, testId: "pdfx-context-insertImage", onSelect: () => actions.setTool("image") },
      { id: "s1", kind: "separator" },
      { id: "rotatePage", label: t("Rotate page"), icon: RotateCw, testId: "pdfx-context-rotatePage", onSelect: () => pageOperation(() => store.rotatePages([menu.pageId], 90)) },
      {
        id: "insertBlankAfter",
        label: t("Insert a blank page after this page"),
        icon: FilePlus2,
        testId: "pdfx-context-insertBlankAfter",
        onSelect: () =>
          pageOperation(() => {
            if (!page) return;
            const screen = pageScreen(page);
            const index = store.getState().pages.findIndex((entry) => entry.id === page.id);
            const id = store.insertBlankPage(index + 1, [screen.width, screen.height]);
            viewer.scrollToPage(id);
          })
      },
      {
        id: "deletePage",
        label: t("Delete page"),
        icon: Trash2,
        testId: "pdfx-context-deletePage",
        disabled: store.getState().pages.length < 2,
        hint: t("A document needs at least one page."),
        onSelect: () =>
          pageOperation(() => {
            if (store.deletePages([menu.pageId]).length) actions.toast(t("Page deleted"), { onUndo: () => actions.undo() });
          })
      }
    ];
  }

  return (
    <div ref={anchor} className="pdfx-menu-anchor pdfx-context-menu" style={{ left: `${menu.clientX + shift.x}px`, top: `${menu.clientY + shift.y}px` }}>
      <MenuPopup
        open
        items={items}
        label={t("Context menu")}
        testId="pdfx-context-menu"
        onClose={({ focus } = {}) => {
          runtime.closeContextMenu();
          if (focus) viewer.getContainer()?.focus({ preventScroll: true });
        }}
      />
    </div>
  );
}

export default function OverlayLayer() {
  const editor = useEditor();
  const runtime = getRuntime(editor);
  const [bag] = useFeatureState(FEATURE_ID);
  const inputRef = useRef(null);
  const menu = bag?.menu || null;

  useEffect(() => {
    const input = inputRef.current;
    runtime.setImageInput(input);
    // Chrome tells when the file dialog was closed without a file
    const onCancel = () => runtime.imagePickCancelled();
    input?.addEventListener("cancel", onCancel);
    return () => {
      input?.removeEventListener("cancel", onCancel);
      runtime.setImageInput(null);
    };
  }, [runtime]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_TYPES}
        hidden
        tabIndex={-1}
        data-testid="pdfx-image-input"
        onChange={(event) => {
          const files = [...event.target.files];
          event.target.value = "";
          runtime.imagePicked(files);
        }}
      />
      {menu ? <ContextMenu key={`${menu.clientX}:${menu.clientY}:${menu.menu}`} runtime={runtime} menu={menu} /> : null}
    </>
  );
}
