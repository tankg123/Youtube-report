import { useLayoutEffect, useRef } from "react";
import { ArrowUpDown, Copy, FileInput, FileOutput, FilePlus2, Files, ImagePlus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { useDocument, useEditor, useFeatureState, useUi } from "../ui/editorHooks.js";
import { MenuPopup } from "../ui/Menu.jsx";
import { shortcutLabel } from "../ui/shortcutLabels.js";
import { run, startExtract, startInsertBlank, startInsertImages, startInsertPdf, startMoveTo } from "./pageFlows.js";
import { blankPageSize } from "./pageLogic.js";
import { deletePages, duplicatePages, insertBlankPages, rotatePages } from "./pageOps.js";
import { FEATURE_ID, closeMenu } from "./pagesState.js";

// The menus of the page panels, rendered in the context layer of the editor (position: fixed, so that a
// narrow panel or a scrolling grid never cuts them off):
//   kind "page"  the page menu (right click on a thumbnail, its "..." button, the menu key, "Page actions"):
//                rotate, duplicate, insert a blank page before / after, move to position, extract, delete
//   kind "add"   the Add menu of the Pages panel: blank page, pages from a PDF, a picture as a page, more files
// Opened with pagesState.openMenu(ui, { kind, x, y, above?, pageIds?, index?, origin, token }); `origin` gets the
// keyboard back when the menu closes with Escape or after a choice.
//
// Test hooks: pdfx-menu-page, pdfx-menu-add; items pdfx-action-page-<id> and pdfx-action-add-<id>.

const MARGIN = 8;

export default function PageMenus() {
  const { t } = useI18n();
  const editor = useEditor();
  const { actions, ui } = editor;
  const [bag] = useFeatureState(FEATURE_ID);
  const pages = useDocument((state) => state.pages);
  const viewOnly = useUi((state) => Boolean(state.flags.viewOnly));
  const anchorRef = useRef(null);
  const menu = bag?.menu || null;

  // keep the menu inside the window: it opens at the pointer, or under the button that opened it
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const list = anchor?.querySelector('[role="menu"]');
    if (!menu || !anchor || !list) return;
    const box = list.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(menu.x, window.innerWidth - box.width - MARGIN));
    // `above`: the menu of a button at the bottom edge opens upwards, its lower edge at menu.y
    const wanted = menu.above ? menu.y - box.height : menu.y;
    const top = Math.max(MARGIN, Math.min(wanted, window.innerHeight - box.height - MARGIN));
    anchor.style.left = `${Math.round(left)}px`;
    anchor.style.top = `${Math.round(top)}px`;
    anchor.style.visibility = "visible";
  }, [menu]);

  if (!menu) return null;

  const close = ({ focus } = {}) => {
    const origin = menu.origin;
    closeMenu(ui);
    if (focus && origin?.isConnected) origin.focus({ preventScroll: true });
  };

  let items;
  if (menu.kind === "add") {
    const index = menu.index;
    items = [
      { id: "blank", label: t("Blank page"), icon: FilePlus2, testId: "pdfx-action-add-blank", onSelect: () => run(editor, startInsertBlank(editor, { index })) },
      { id: "pdf", label: t("Pages from PDF"), icon: FileInput, testId: "pdfx-action-add-pdf", onSelect: () => startInsertPdf(editor, { index }) },
      { id: "image", label: t("Image as page"), icon: ImagePlus, testId: "pdfx-action-add-image", onSelect: () => startInsertImages(editor, { index }) },
      { id: "separator", kind: "separator" },
      { id: "files", label: t("Add files"), icon: Files, testId: "pdfx-action-add-files", onSelect: () => actions.openFilePicker("add") }
    ];
  } else {
    const ids = (menu.pageIds || []).filter((id) => pages.some((page) => page.id === id));
    if (!ids.length) return null;
    const first = pages.findIndex((page) => page.id === ids[0]);
    const last = pages.findIndex((page) => page.id === ids[ids.length - 1]);
    const insertBlank = (reference, index) => {
      const size = blankPageSize({ format: "current", page: pages[reference] });
      if (size.ok) run(editor, insertBlankPages(editor, { size: size.size, index }));
    };
    items = [
      { id: "heading", kind: "heading", label: ids.length === 1 ? t("Page {page}", { page: first + 1 }) : t("{count} pages selected", { count: ids.length }) },
      { id: "rotateLeft", label: t("Rotate counterclockwise"), icon: RotateCcw, shortcut: shortcutLabel("pageRotateCcw"), testId: "pdfx-action-page-rotate-left", onSelect: () => run(editor, rotatePages(editor, ids, -90)) },
      { id: "rotateRight", label: t("Rotate clockwise"), icon: RotateCw, shortcut: shortcutLabel("pageRotateCw"), testId: "pdfx-action-page-rotate-right", onSelect: () => run(editor, rotatePages(editor, ids, 90)) },
      { id: "duplicate", label: t("Duplicate page"), icon: Copy, shortcut: shortcutLabel("duplicate"), testId: "pdfx-action-page-duplicate", onSelect: () => run(editor, duplicatePages(editor, ids)) },
      { id: "separator-1", kind: "separator" },
      { id: "blankBefore", label: t("Insert blank page before"), icon: FilePlus2, testId: "pdfx-action-page-blank-before", onSelect: () => insertBlank(first, first) },
      { id: "blankAfter", label: t("Insert blank page after"), icon: FilePlus2, testId: "pdfx-action-page-blank-after", onSelect: () => insertBlank(last, last + 1) },
      { id: "separator-2", kind: "separator" },
      { id: "move", label: t("Move to position…"), icon: ArrowUpDown, disabled: ids.length >= pages.length, testId: "pdfx-action-page-move", onSelect: () => run(editor, startMoveTo(editor, { pageIds: ids })) },
      { id: "extract", label: t("Extract pages…"), icon: FileOutput, testId: "pdfx-action-page-extract", onSelect: () => run(editor, startExtract(editor, { pageIds: ids })) },
      { id: "separator-3", kind: "separator" },
      { id: "delete", label: ids.length === 1 ? t("Delete page") : t("Delete {count} pages", { count: ids.length }), icon: Trash2, shortcut: shortcutLabel("delete"), testId: "pdfx-action-page-delete", onSelect: () => run(editor, deletePages(editor, ids)) }
    ];
  }

  // a file that can only be read: the entries stay visible and say why they do nothing
  if (viewOnly) {
    const hint = t("This file can be viewed but not edited here.");
    items = items.map((item) => (item.kind ? item : { ...item, disabled: true, hint }));
  }

  return (
    <div ref={anchorRef} className="pdfx-menu-anchor pdfx-pages-menu" style={{ left: menu.x, top: menu.y, visibility: "hidden" }}>
      <MenuPopup key={menu.token} open onClose={close} items={items} label={menu.kind === "add" ? t("Add pages") : t("Page actions")} testId={menu.kind === "add" ? "pdfx-menu-add" : "pdfx-menu-page"} />
    </div>
  );
}
