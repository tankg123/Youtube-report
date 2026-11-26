import { useRef, useState } from "react";
import { ChevronDown, ChevronLeft, EllipsisVertical, Eye, FileText, Lock, Maximize, Minimize, PenLine, Settings2, TriangleAlert, X } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { sourcesInUse } from "../model/selectors.js";
import { commandById } from "../tools/registry.js";
import { BarButton, Chip } from "./controls.jsx";
import { useDocument, useEditor, useHistoryState, useUi } from "./editorHooks.js";
import { FILE_EXTENSION } from "./fileNames.js";
import { iconByName } from "./icons.js";
import { MenuButton } from "./Menu.jsx";
import { shortcutLabel } from "./shortcutLabels.js";
import { useFullScreen } from "./useFullScreen.js";

// The app bar (UX specification 3.1 A): back link, the editable name of the download, the state chip, Open,
// Add files, Print, the overflow menu, the language of the application, and Download as the one primary button.
// Next to Download a small menu holds "Download options" (what the file leaves out, its name) and the document
// properties. Below 900 px Open, Add files, Print, the panels and the download options move into the overflow menu.
//
// Test hooks: pdfx-action-back, pdfx-file-name, pdfx-state-chip (data-state), pdfx-signed-edit-chip,
// pdfx-restricted-chip (data-confirmed), pdfx-protected-chip, pdfx-action-open, pdfx-action-add, pdfx-action-print, pdfx-action-more
// (menu items pdfx-action-<id>), pdfx-action-language-en / -vi, pdfx-action-download, pdfx-action-download-menu
// (menu pdfx-menu-download: pdfx-action-download-options, pdfx-action-download-properties).

const LANGUAGES = [
  { id: "en", caption: "EN" },
  { id: "vi", caption: "VI" }
];

/** The download name: a text field that looks like a title. Enter or leaving the field applies, Escape gives up. */
function FileName() {
  const { t } = useI18n();
  const { store } = useEditor();
  const fileName = useDocument((state) => state.fileName);
  const [draft, setDraft] = useState(null); // null = not being edited
  const giveUp = useRef(false);
  const value = draft === null ? fileName : draft;
  return (
    <span className="pdfx-filename" data-tip={t("The name of the downloaded file")} data-tip-align="start">
      {/* the field is as wide as its text: the hidden copy of the text in ::after sizes the grid cell both share */}
      <span className="pdfx-filename-sizer" data-value={value || t("Untitled")}>
        <input
          type="text"
          className="pdfx-filename-input"
          aria-label={t("File name")}
          placeholder={t("Untitled")}
          data-testid="pdfx-file-name"
          spellCheck="false"
          autoComplete="off"
          size={1}
          value={value}
          onFocus={() => setDraft(fileName)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (!giveUp.current && draft !== null) store.setFileName(draft);
            giveUp.current = false;
            setDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            giveUp.current = event.key === "Escape";
            event.currentTarget.blur();
          }}
        />
      </span>
      <span className="pdfx-filename-extension" aria-hidden="true">
        {FILE_EXTENSION}
      </span>
    </span>
  );
}

/**
 * Edited / Downloaded / Signed / View only, the reminder that edits break the signatures of the file, the
 * restrictions of its author, and that a file opened with a password loses that protection in an edited copy.
 */
function StateChips() {
  const { t } = useI18n();
  const { messages, store } = useEditor();
  const flags = useUi((state) => state.flags);
  const { dirty } = useHistoryState();
  const sources = useDocument((state) => state.sources);
  const pages = useDocument((state) => state.pages);
  const inUse = sourcesInUse({ sources, pages });
  const signatureCount = inUse.reduce((sum, source) => sum + (source.signatureCount || 0), 0);
  // (the password a file was opened with never changes while the file is open)
  const openedWithPassword = inUse.some((source) => source.encrypted && Boolean(store.getSourcePassword(source.id)));
  const chips = [];
  if (flags.viewOnly) {
    chips.push(
      <Chip key="view" tone="warning" icon={Eye} hint={messages.describeCode(flags.viewOnly.code, flags.viewOnly.params)} testId="pdfx-state-chip" data-state="view-only">
        {t("View only")}
      </Chip>
    );
  } else if (dirty) {
    chips.push(
      <Chip key="state" tone="info" icon={PenLine} hint={t("There are changes that were not downloaded.")} testId="pdfx-state-chip" data-state="edited">
        {t("Edited")}
      </Chip>
    );
  } else if (flags.savedAs === "signed") {
    chips.push(
      <Chip key="state" tone="success" testId="pdfx-state-chip" data-state="signed">
        {t("Signed")}
      </Chip>
    );
  } else if (flags.savedAs === "downloaded") {
    chips.push(
      <Chip key="state" tone="success" testId="pdfx-state-chip" data-state="downloaded">
        {t("Downloaded")}
      </Chip>
    );
  }
  if (flags.signedEditConfirmed && signatureCount > 0) {
    chips.push(
      <Chip key="signed" tone="warning" icon={TriangleAlert} testId="pdfx-signed-edit-chip">
        {signatureCount === 1 ? t("Edits will invalidate 1 signature") : t("Edits will invalidate {count} signatures", { count: signatureCount })}
      </Chip>
    );
  }
  if (flags.restricted && !flags.viewOnly) {
    chips.push(
      <Chip
        key="restricted"
        tone="warning"
        icon={Lock}
        hint={flags.restrictedEditConfirmed ? t("The author restricted changes to this file. The copy you download is a new file that is not protected.") : t("The author restricted changes to this file. You can read it; before the first edit you are asked whether you may change it.")}
        testId="pdfx-restricted-chip"
        data-confirmed={flags.restrictedEditConfirmed ? "true" : "false"}
      >
        {t("Changes restricted by the author")}
      </Chip>
    );
  } else if (openedWithPassword && !flags.viewOnly) {
    // the export writes a new, unencrypted file: said here, because nothing asks before a plain edit is downloaded
    chips.push(
      <Chip
        key="protected"
        icon={Lock}
        hint={t("This file opens with a password. A copy you download after changing it is a new file that is not protected by a password. Downloaded without changes, it is the file itself.")}
        testId="pdfx-protected-chip"
      >
        {t("Password-protected")}
      </Chip>
    );
  }
  return chips.length ? <span className="pdfx-chips">{chips}</span> : null;
}

export default function AppBar({ onLeave }) {
  const { t, language, setLanguage } = useI18n();
  const editor = useEditor();
  const { actions, features } = editor;
  const layout = useUi((state) => state.layout);
  const viewOnly = useUi((state) => state.flags.viewOnly);
  const restricted = useUi((state) => state.flags.restricted);
  const savedAs = useUi((state) => state.flags.savedAs);
  const leftPanel = useUi((state) => state.leftPanel);
  const hasDocument = useDocument((state) => state.pages.length > 0);
  const { dirty } = useHistoryState();
  const fullScreen = useFullScreen();
  const narrow = layout === "narrow";

  const open = commandById("open");
  const add = commandById("addFiles");
  const print = commandById("print");
  const download = commandById("download");
  const more = commandById("moreActions");
  const properties = commandById("properties");
  const shortcuts = commandById("shortcuts");
  const closeDocument = commandById("closeDocument");
  const addHint = !hasDocument ? undefined : viewOnly ? t("This file can be viewed but not edited here.") : undefined;

  const downloadItems = [
    { id: "options", label: t("Download options…"), icon: Settings2, disabled: !hasDocument || Boolean(viewOnly), hint: viewOnly ? t("This file can be viewed but not edited here.") : undefined, testId: "pdfx-action-download-options", onSelect: () => actions.download({ ask: true }) },
    { id: "properties", label: t(properties.label), icon: iconByName(properties.icon), disabled: !hasDocument, testId: "pdfx-action-download-properties", onSelect: () => actions.openKernelDialog("properties") }
  ];

  const menu = [];
  if (narrow) {
    // the state chips do not fit a narrow bar: the menu says in words what they would show
    const states = [];
    if (viewOnly) states.push(t("View only"));
    else if (dirty) states.push(t("Edited"));
    else if (savedAs === "signed") states.push(t("Signed"));
    else if (savedAs === "downloaded") states.push(t("Downloaded"));
    if (restricted && !viewOnly) states.push(t("Changes restricted by the author"));
    if (hasDocument && states.length) menu.push({ id: "state", kind: "heading", label: states.join(", ") });
    menu.push(
      { id: "open", label: t(open.label), icon: iconByName(open.icon), shortcut: shortcutLabel("open"), testId: "pdfx-action-open", onSelect: () => actions.openFilePicker("open") },
      { id: "add", label: t(add.label), icon: iconByName(add.icon), disabled: !hasDocument || Boolean(viewOnly), testId: "pdfx-action-add", onSelect: () => actions.openFilePicker("add") },
      { id: "print", label: t(print.label), icon: iconByName(print.icon), shortcut: shortcutLabel("print"), disabled: !hasDocument, testId: "pdfx-action-print", onSelect: () => actions.print() },
      { ...downloadItems[0], id: "download-options" },
      { id: "sep-panels", kind: "separator" }
    );
    for (const panel of features.panels) {
      menu.push({ id: `panel-${panel.id}`, kind: "check", label: t(panel.labelKey), icon: iconByName(panel.icon), checked: leftPanel === panel.id, disabled: !hasDocument, testId: `pdfx-action-panel-${panel.id}`, onSelect: () => actions.toggleLeftPanel(panel.id) });
    }
    menu.push({ id: "sep-file", kind: "separator" });
  }
  if (editor.hasDialog("properties")) {
    menu.push({ id: "properties", label: t(properties.label), icon: iconByName(properties.icon), disabled: !hasDocument, testId: "pdfx-action-properties", onSelect: () => actions.openKernelDialog("properties") });
  }
  if (editor.hasDialog("shortcuts")) {
    menu.push({ id: "shortcuts", label: t(shortcuts.label), icon: iconByName(shortcuts.icon), shortcut: "?", testId: "pdfx-action-shortcuts", onSelect: () => actions.openKernelDialog("shortcuts") });
  }
  menu.push(
    {
      id: "fullScreen",
      label: fullScreen ? t("Exit full screen") : t("Full screen"),
      icon: fullScreen ? Minimize : Maximize,
      shortcut: shortcutLabel("fullScreen"),
      testId: "pdfx-action-fullScreen",
      onSelect: () => actions.toggleFullScreen()
    },
    { id: "sep-close", kind: "separator" },
    { id: "closeDocument", label: t(closeDocument.label), icon: X, disabled: !hasDocument, testId: "pdfx-action-closeDocument", onSelect: () => actions.closeDocument() }
  );

  return (
    <header className="pdfx-appbar" data-testid="pdfx-appbar">
      <a
        href="/home"
        className="pdfx-btn pdfx-back"
        aria-label={t("Back to home")}
        data-tip={t("Back to home")}
        data-tip-align="start"
        data-testid="pdfx-action-back"
        onClick={(event) => {
          event.preventDefault();
          onLeave();
        }}
      >
        <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
      </a>
      <div className="pdfx-appbar-title">
        {hasDocument ? (
          <>
            <FileName />
            <StateChips />
          </>
        ) : (
          <h1 className="pdfx-title">
            <FileText size={18} strokeWidth={1.75} aria-hidden="true" />
            {t("PDF editor")}
          </h1>
        )}
      </div>
      <div className="pdfx-appbar-actions">
        {narrow ? null : (
          <>
            <BarButton icon={iconByName(open.icon)} label={t(open.label)} text={t(open.label)} shortcut={shortcutLabel("open")} testId="pdfx-action-open" onClick={() => actions.openFilePicker("open")} />
            <BarButton icon={iconByName(add.icon)} label={t(add.label)} text={t(add.label)} hint={addHint} disabled={!hasDocument || Boolean(viewOnly)} testId="pdfx-action-add" onClick={() => actions.openFilePicker("add")} />
            <BarButton icon={iconByName(print.icon)} label={t(print.label)} shortcut={shortcutLabel("print")} disabled={!hasDocument} testId="pdfx-action-print" onClick={() => actions.print()} />
          </>
        )}
        <MenuButton icon={EllipsisVertical} label={t(more.label)} testId="pdfx-action-more" menuTestId="pdfx-menu-more" align="end" tipAlign="end" items={menu} />
      </div>
      <div className="pdfx-language" role="group" aria-label={t("Language")}>
        {LANGUAGES.map((item) => (
          <button
            key={item.id}
            type="button"
            className="pdfx-language-option"
            aria-pressed={language === item.id ? "true" : "false"}
            aria-label={item.id === "vi" ? t("Vietnamese") : t("English")}
            lang={item.id}
            data-testid={`pdfx-action-language-${item.id}`}
            onClick={() => setLanguage(item.id)}
          >
            {item.caption}
          </button>
        ))}
      </div>
      <span className="pdfx-split pdfx-download">
        <BarButton primary icon={iconByName(download.icon)} label={t(download.label)} text={t(download.label)} shortcut={shortcutLabel("download")} disabled={!hasDocument} testId="pdfx-action-download" tipAlign="end" onClick={() => actions.download()} />
        {narrow ? null : (
          <MenuButton primary icon={ChevronDown} iconSize={14} label={t("More ways to download")} className="pdfx-download-more" disabled={!hasDocument} testId="pdfx-action-download-menu" menuTestId="pdfx-menu-download" align="end" tipAlign="end" items={downloadItems} />
        )}
      </span>
    </header>
  );
}
