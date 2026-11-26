import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FilePlus2, FolderOpen } from "lucide-react";
import { useAuth } from "../../../context/AuthContext";
import { useI18n } from "../../../context/I18nContext";
import { tk } from "../../../i18n/index.js";
import { comboFromEvent, overridesBrowser } from "../tools/keymap.js";
import { useHistoryGuard } from "../useHistoryGuard.js";
import Announcer from "./Announcer.jsx";
import AppBar from "./AppBar.jsx";
import { SlotBoundary } from "./controls.jsx";
import DialogHost from "./DialogHost.jsx";
import { useDocument, useEditor, useHistoryState, useUi } from "./editorHooks.js";
import JobCard from "./JobCard.jsx";
import { keyContext, resolveKey, runCommand } from "./keyCommands.js";
import LeftRail from "./LeftRail.jsx";
import Notices from "./Notices.jsx";
import PageArea from "./PageArea.jsx";
import RightSide from "./RightSide.jsx";
import { platformIsMac } from "./shortcutLabels.js";
import SlotFailure from "./SlotFailure.jsx";
import StatusBar from "./StatusBar.jsx";
import ToastHost from "./ToastHost.jsx";
import ToolBar from "./ToolBar.jsx";
import { layoutForWidth } from "./uiStore.js";
import "../styles/shell.css";

// The frame of the editor (UX specification 3): app bar, tool bar, banners, the left rail with its panel, the
// page area, the right side, the status bar, and over them the layers for toasts, the running job, dialogs
// and context menus, plus the live region that tells a screen reader about page and zoom changes. It also owns what belongs to the page as a whole:
//   * the ONE keyboard dispatcher (UX 12; the routing rules are in ui/keyCommands.js)
//   * the layout ("wide" / "medium" / "narrow" from the width of the window: CSS follows data-layout)
//   * dropping files on the window, and the two hidden file inputs behind Open and Add files
//   * the guards for work that was not downloaded: beforeunload, the back link, the browser's Back button
//   * the notices about the session and about a page that is not served over https
//
// Root element: div.pdfx-root[data-testid="pdfx-root"] with data-readonly-allow="true" (the application's
// read-only runtime leaves the editor alone), lang, and for tests data-busy (a job runs), data-layout,
// data-tool, data-tool-locked, data-has-document, data-editable, data-dirty, data-view, data-dragging.
// While a job runs everything except the job card, the dialogs and the toasts is inert.

const SESSION_NOTICE = "session-ended";
const INSECURE_NOTICE = "insecure-context";
const TEXT_FIELDS = 'input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="file"], [type="color"]), textarea, select';
const CONTROLS = 'button, a[href], summary, input, [role="button"], [role="tab"], [role="slider"], [role="checkbox"], [role="switch"], [role="option"], [role="treeitem"]';
const FILE_TYPES = "application/pdf,.pdf";

const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");

/** What the dispatcher needs to know about the element that has the keyboard (ui/keyCommands.js keyContext). */
function describeKeyTarget(root, target, state) {
  const modal = state.dialogs.length > 0 || Boolean(root.querySelector('[aria-modal="true"]'));
  if (!target) return { inDialog: modal };
  const textBox = Boolean(target.closest(".pdfx-text-editor"));
  const field = !textBox && (target.matches(TEXT_FIELDS) || target.isContentEditable);
  return {
    inDialog: modal || Boolean(target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')),
    scopeHint: target.closest("[data-pdfx-scope]")?.getAttribute("data-pdfx-scope") || null,
    textBox,
    field,
    control: !textBox && !field && !target.closest(".pdfx-viewer") && target.matches(CONTROLS)
  };
}

function DropTargets({ hasDocument, zone }) {
  const { t } = useI18n();
  return (
    <div className="pdfx-drop" data-testid="pdfx-drop">
      {hasDocument ? (
        <>
          <div className="pdfx-drop-zone pdfx-drop-zone-main" data-drop-zone="add" data-over={zone === "add" ? "true" : "false"} data-testid="pdfx-drop-add">
            <FilePlus2 size={28} strokeWidth={1.5} aria-hidden="true" />
            <span>{t("Add pages to this document")}</span>
          </div>
          <div className="pdfx-drop-zone" data-drop-zone="open" data-over={zone === "open" ? "true" : "false"} data-testid="pdfx-drop-open">
            <FolderOpen size={24} strokeWidth={1.5} aria-hidden="true" />
            <span>{t("Open instead of this document")}</span>
          </div>
        </>
      ) : (
        <div className="pdfx-drop-zone pdfx-drop-zone-main" data-drop-zone="open" data-over="true" data-testid="pdfx-drop-open">
          <FolderOpen size={28} strokeWidth={1.5} aria-hidden="true" />
          <span>{t("Drop the files to open them")}</span>
        </div>
      )}
    </div>
  );
}

export default function Shell() {
  const { language } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const editor = useEditor();
  const { actions, features, reportSlotError, ui } = editor;
  const hasDocument = useDocument((state) => state.pages.length > 0);
  const { dirty } = useHistoryState();
  const busy = useUi((state) => state.job !== null);
  const layout = useUi((state) => state.layout);
  const tool = useUi((state) => state.interaction.tool);
  const toolLocked = useUi((state) => state.interaction.toolLocked);
  const editable = useUi((state) => state.flags.editable);
  const view = useUi((state) => state.view);
  const leftPanel = useUi((state) => state.leftPanel);
  const [dropZone, setDropZone] = useState(null); // null = nothing is dragged over the window
  const rootRef = useRef(null);
  const openInputRef = useRef(null);
  const addInputRef = useRef(null);

  // --- DOM hooks of the actions -----------------------------------------------------------------------------
  useEffect(() => {
    const undo = [editor.registerElement("root", rootRef.current), editor.registerElement("openInput", openInputRef.current), editor.registerElement("addInput", addInputRef.current)];
    return () => undo.forEach((unregister) => unregister());
  }, [editor]);

  // --- layout: before the first paint, then with the window ---------------------------------------------------
  useLayoutEffect(() => {
    const apply = () => ui.setLayout(layoutForWidth(window.innerWidth));
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [ui]);

  // --- the keyboard --------------------------------------------------------------------------------------------
  useEffect(() => {
    const mac = platformIsMac();
    const releaseSpace = () => {
      if (ui.getState().interaction.spaceHeld) ui.runInteraction({ type: "shortcut", id: "tempHand", phase: "up" });
    };
    // On the document, after React's own listeners: a component that handled a key (a menu, the search field,
    // the text editor) stops it there and the dispatcher never sees it.
    const onKeyDown = (event) => {
      const root = rootRef.current;
      if (!root || event.defaultPrevented) return;
      const element = event.target instanceof Element ? event.target : null;
      const inside = Boolean(element && root.contains(element));
      // keys that belong to something else on the page (never the case on this route, but cheap to respect)
      if (element && !inside && element !== document.body && element !== document.documentElement) return;
      const state = ui.getState();
      const combo = comboFromEvent(event, { mac });
      const takenFromBrowser = Boolean(combo) && overridesBrowser(combo) && (event.ctrlKey || event.metaKey);
      if (state.job) {
        // a running job has the editor: Escape is its Cancel, nothing else gets through
        if (combo === "Escape" && actions.cancelJob()) event.preventDefault();
        else if (takenFromBrowser) event.preventDefault();
        return;
      }
      const target = describeKeyTarget(root, inside ? element : null, state);
      const context = keyContext(target, { selectionCount: state.interaction.selection.length, view: state.view });
      // Space is held for the hand: its auto-repeat must not scroll the pages
      if (combo === "Space" && state.interaction.spaceHeld && context && !target.field && !target.textBox) {
        event.preventDefault();
        return;
      }
      const resolved = resolveKey(event, context, { mac, singleKeys: state.preferences.singleKeys });
      if (!resolved) {
        // Ctrl+S in an open dialog must still not save the HTML page
        if (takenFromBrowser) event.preventDefault();
        return;
      }
      const handled = runCommand(editor, resolved.id, { scope: resolved.scope, keyEvent: event, phase: "down" });
      if (handled || resolved.preventDefault) event.preventDefault();
    };
    const onKeyUp = (event) => {
      if (event.key === " " || event.code === "Space") releaseSpace();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseSpace);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseSpace);
    };
  }, [actions, editor, ui]);

  // --- work that was not downloaded --------------------------------------------------------------------------
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = ""; // the browser shows its own question; the text cannot be chosen
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const leave = useCallback(() => {
    actions.requestLeave(() => navigate("/home", { replace: true }));
  }, [actions, navigate]);
  useHistoryGuard(dirty, leave);

  // --- notices about the page itself ---------------------------------------------------------------------------
  useEffect(() => {
    if (user) {
      ui.dismissNotice(SESSION_NOTICE);
      return;
    }
    ui.addNotice({
      id: SESSION_NOTICE,
      tone: "warning",
      text: tk("Your session has ended. The document is still open here: download your work first, then sign in again."),
      scope: "session",
      dismissible: false
    });
  }, [user, ui]);

  useEffect(() => {
    if (window.isSecureContext !== false) return;
    ui.addNotice({
      id: INSECURE_NOTICE,
      tone: "info",
      text: tk("This page is not opened over a secure connection (https), so signing with a certificate is not available. Everything else works."),
      scope: "session"
    });
  }, [ui]);

  // --- files ---------------------------------------------------------------------------------------------------
  const takeFiles = (event, open) => {
    const files = [...event.target.files];
    event.target.value = ""; // the same file can be chosen again
    if (!files.length) return;
    if (open) actions.openFiles(files);
    else actions.addFiles(files);
  };

  const dropAllowed = () => !ui.getState().job && ui.getState().dialogs.length === 0;
  const zoneOf = (event) => event.target.closest?.("[data-drop-zone]")?.getAttribute("data-drop-zone") || (hasDocument ? "add" : "open");

  const View = view ? features.fullScreenViews[view] : null;

  return (
    <div
      ref={rootRef}
      className="pdfx-root"
      lang={language}
      data-readonly-allow="true"
      data-testid="pdfx-root"
      data-busy={busy ? "true" : "false"}
      data-layout={layout}
      data-tool={tool}
      data-tool-locked={toolLocked ? "true" : "false"}
      data-has-document={hasDocument ? "true" : "false"}
      data-editable={editable}
      data-dirty={dirty ? "true" : "false"}
      data-view={View ? view : ""}
      data-left-panel={leftPanel || ""}
      data-dragging={dropZone ? "true" : "false"}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        if (dropAllowed()) setDropZone(zoneOf(event));
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        // always: a file dropped on a page that does not take it makes the browser LEAVE the editor
        event.preventDefault();
        const allowed = dropAllowed();
        event.dataTransfer.dropEffect = allowed ? "copy" : "none";
        setDropZone(allowed ? zoneOf(event) : null);
      }}
      onDragLeave={(event) => {
        // leaving the window, not moving from one child to the next
        if (!event.currentTarget.contains(event.relatedTarget)) setDropZone(null);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropZone(null);
        if (!dropAllowed()) return;
        const files = [...event.dataTransfer.files];
        if (!files.length) return;
        if (zoneOf(event) === "open") actions.openFiles(files);
        else actions.addFiles(files);
      }}
    >
      <div className="pdfx-chrome" inert={busy}>
        <AppBar onLeave={leave} />
        <ToolBar />
        <Notices />
        <div className="pdfx-body">
          <LeftRail />
          <main className="pdfx-stage">
            <div className="pdfx-stage-pages" inert={Boolean(View)}>
              <PageArea hidden={Boolean(View)} />
            </div>
            {View ? (
              <div className="pdfx-view" data-testid={`pdfx-view-${view}`}>
                <SlotBoundary key={view} onError={reportSlotError} fallback={(retry) => <SlotFailure onRetry={retry} />}>
                  <View onClose={() => ui.closeView()} />
                </SlotBoundary>
              </div>
            ) : null}
            {dropZone ? <DropTargets hasDocument={hasDocument} zone={dropZone} /> : null}
          </main>
          <RightSide />
        </div>
        <StatusBar />
        <input ref={openInputRef} type="file" accept={FILE_TYPES} multiple hidden tabIndex={-1} data-testid="pdfx-file-input" onChange={(event) => takeFiles(event, true)} />
        <input ref={addInputRef} type="file" accept={FILE_TYPES} multiple hidden tabIndex={-1} data-testid="pdfx-file-input-add" onChange={(event) => takeFiles(event, false)} />
      </div>
      <div className="pdfx-context-layer">
        {features.contextMenus.map((ContextMenu, index) => (
          <SlotBoundary key={index} onError={reportSlotError}>
            <ContextMenu />
          </SlotBoundary>
        ))}
      </div>
      <ToastHost />
      <Announcer />
      <JobCard />
      <DialogHost />
    </div>
  );
}
