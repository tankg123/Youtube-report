// The kernel of the PDF editor: one EditorProvider per page creates and owns everything the features share.
// THIS HEADER IS THE MANUAL FOR FEATURE AUTHORS (overlay/, pages/, signing/): read it before plugging in.
//
// ---------------------------------------------------------------------------------------------------------------
// 1. THE EDITOR CONTEXT
// ---------------------------------------------------------------------------------------------------------------
//   import { useEditor, useDocument, useUi, useInteraction, useViewer, useHistoryState, useFeatureState } from "../ui/editorHooks.js";
//   const editor = useEditor();      // the same object for the life of the page: safe as an effect dependency
//
//   editor.store          the document store (model/store.js): pages, objects, sources, assets, undo history.
//                         Its text measurer is the text layout service: await actions.ensureFonts(textObject)
//                         BEFORE every command that adds a text box or changes its font / bold / italic / text.
//   editor.viewer         the viewer controller (viewer/viewerController.js): geometry on screen, text lines,
//                         colour sampling, thumbnails, search, scrolling. The kernel keeps it in step with the
//                         store: never call viewer.setPages / openSource / closeSource yourself (a pdf.js
//                         document is open exactly while its id is in state.sources).
//   editor.ui             the UI store (ui/uiStore.js): tool and selection (the interaction state), panels,
//                         dialogs, drawer, toasts, notices, the running job, tool defaults, flags, feature bags.
//   editor.actions        the commands everybody shares (ui/actions.js), see section 3.
//   editor.textService    text/layout.js (ensureFonts, layout, measure, check, layoutForExport)
//   editor.fonts          the shared font registry of text/fonts.js (the same one the pipeline embeds from)
//   editor.messages       { describeError, describeWarning, describeCode, describeStage, isSilent } of
//                         messages.js, already bound to the file names of the open sources
//   editor.features       the three manifests merged (ui/manifest.js mergeManifests)
//   editor.loadPipeline() Promise of the module engine/pipeline/index.js (buildOutput, signOutput, verifySigned,
//                         inspectSource, detectSignatures ...). Loaded on first use, the promise is cached.
//   editor.loadSigning()  Promise of the module engine/sign/index.js. NEVER import an engine entry module
//                         statically from user-interface code: they pull in the PDF library.
//   editor.getPipelineEnv()   Promise of the browser `env` for pipeline.buildOutput (pdf.js, fonts, canvases)
//   editor.registerElement(name, element) -> unregister;  editor.getElement(name)
//                         DOM hooks of the shell: "root", "viewer" (the scroll container of the pages),
//                         "toolbar", "pageNumber", "openInput", "addInput". A value may also be { focus() }.
//   editor.hasDialog(id)  true when a dialog with this id is registered (kernel or feature)
//   editor.reportSlotError(error)   what the error boundaries around feature slots call
//
// Hooks (ui/editorHooks.js; `select` must return a slice that stays === while it did not change):
//   useDocument(select?)        the DocumentState of the store        useHistoryState()   { canUndo, canRedo, dirty ... }
//   useUi(select?)              the UI state                          useInteraction()    { tool, toolLocked, mode, selection, gesture, editingId, spaceHeld }
//   useViewer(select?)          the viewer snapshot (scale, zoom, currentPageId, pageCount, search, busy)
//   useFeatureState(featureId)  [value, set]: a free bag per feature in the UI store (not undoable, not persisted)
//
// In development builds the editor is also window.__pdfxEditor (browser tests reach the store through it).
//
// ---------------------------------------------------------------------------------------------------------------
// 2. THE FEATURE MANIFEST
// ---------------------------------------------------------------------------------------------------------------
// The kernel imports exactly three modules: overlay/index.js, pages/index.js, signing/index.js. Each
// default-exports a plain object; every member is optional (ui/manifest.js checks the shapes):
//
//   id               "overlay" | "pages" | "signing": only used in messages about a malformed manifest
//   pageOverlay      component, rendered inside EVERY page (viewer/ViewerPages.jsx renderOverlay) with props
//                    { page, view }: page = the Page of the model, view = { pageId, pageNumber, scale, geometry,
//                    extraRotation, rotation, width, height, renderState }. Its parent is div.pdfx-page-overlay
//                    (position absolute, the size of the page). Who gets the pointer: section 4.
//   propertiesPanel  component (no props) for the right panel. Only one feature may have it. Without one the
//                    kernel shows ui/DocumentSummary.jsx (which a real panel can render when nothing is selected).
//   selectionBar     component (no props), rendered inside the scroll container of the pages, in an element
//                    at the origin of the scrolled content: position it with `position: absolute` in content
//                    coordinates (page element offsets) and it scrolls with the pages.
//   contextMenu      component (no props), rendered in a layer over the whole editor: use `position: fixed`
//                    with client coordinates. Keys inside role="menu" never reach the key dispatcher.
//   panels           { id: { labelKey, icon, component, order } }: tabs of the left rail. labelKey = a tk() text,
//                    icon = a lucide-react name that ui/icons.js lists, order = position in the rail.
//                    Final ids: "pages" (10), "outline" (20), "signatures" (30).
//   dialogs          { id: component }: opened with ui.openDialog(id, props) or `await ui.showDialog(id, props)`,
//                    rendered by ui/DialogHost.jsx with those props plus onClose(result) (showDialog resolves
//                    with `result`). The component draws its own frame: use Modal of
//                    pages/assetDelivery/shared.jsx (rendered in place, traps the focus), or the editor's own
//                    frame ui/dialogs/DialogFrame.jsx (role alertdialog for warnings, the tokens of the editor,
//                    the focus goes back to the opener through a chain of dialogs and jobs). Kernel ids that
//                    are taken: "confirm", "password", "leave", "export", "exportReview", "exportFailed",
//                    "report", "properties", "shortcuts".
//   drawers          { id: component }: ui.openDrawer(id, props) shows it IN PLACE OF the properties panel, with
//                    those props plus onClose(); ui.closeDrawer() removes it.
//   banners          [component]: rendered under the tool bar, above the kernel's own notices
//   statusItems      [component]: rendered in the status bar, after the zoom controls
//   fullScreenViews  { id: component }: actions.toggleView(id) / ui.openView(id) shows it over the page area
//                    (the pages stay mounted underneath, hidden and inert); ui.closeView() leaves it. While a
//                    view is open the keyboard scope is "organiser". Final id: "organiser".
//   toolActivators   { toolId: (editor) => void | Promise }: called after actions.setTool(toolId) accepted the
//                    tool (file picker of Image, the signature menu, the certificate drawer). For a tool with
//                    flow "signing" (certSign) ONLY the activators run: the feature dispatches
//                    ui.runInteraction({ type: "tool", tool: "certSign" }) itself for its position step.
//   commands         { commandId: (editor, event) => boolean }: asked BEFORE the kernel for every shortcut id of
//                    tools/keymap.js and for everything run with actions.runCommand(id, details). Return true
//                    when handled. event = { id, scope, keyEvent, phase: "down" | "up", ...details }.
//                    Ids nobody but a feature implements: copy, cut, paste, duplicate, selectAll, nudge,
//                    nudgeBig, bringForward / sendBackward / bringToFront / sendToBack, bold, italic, underline,
//                    biggerText, smallerText, commitText, the page* ids of the organiser, rotateView, and
//                    "openImages" ({ files, intent: "open" | "add", index }: pictures among opened or dropped
//                    files) and "showPendingMarks" (the counter of the status bar was clicked).
//   effectExecutor   (editor, effects, event) => void: receives the effects of EVERY ui.runInteraction(event)
//                    (tools/interaction.js). model/gestures.js runEffect(store, effect, { scaleOf, style ... })
//                    does the document part; after a "create" send ui.runInteraction({ type: "created", ids }).
//                    The kernel itself runs afterwards: unhandledEscape, pan and hint (leave these three alone).
//   onDocumentOpened (editor, { sourceId, facts, name }): once per file that became part of the document
//                    (facts = the viewer's facts: outline, signatureCount, permissions ...)
//   onDocumentClosed (editor): the document is about to be replaced or closed
//
// A slot that throws while rendering is caught by an error boundary of its own: the rest of the editor stays.
//
// ---------------------------------------------------------------------------------------------------------------
// 3. ACTIONS (ui/actions.js; each one is documented there)
// ---------------------------------------------------------------------------------------------------------------
//   files    openFiles(files)  addFiles(files, index?)  replaceDocument(items, { resetHistory })  openFilePicker("open" | "add")
//            loadSource(file) -> { sourceId, name, pageCount, facts } | null   one more PDF as a source WITHOUT
//            pages (password dialog and editability check included); discardSource(sourceId); newBlankDocument();
//            closeDocument()
//   output   buildOutput({ purpose: "download" | "print" | "sign" | "extract", pageIds?, options?, ask?, report? })
//              -> { bytes, report, baseName, original, showReport? } | null    THE one way out: never call the
//              pipeline for a document output yourself. It asks what has to be asked BEFORE the build (pending
//              redaction / blur marks, text boxes that become pictures: dialog "export"), hands out nothing
//              after a failed build (dialog "exportFailed"), asks again when the built file still holds
//              something the user removed (dialog "exportReview": build again without it, take it as it is,
//              or cancel), and reports per page what happened (dialog "report"). null = cancelled or failed:
//              deliver nothing. report: "defer" = you deliver the file first and then call
//              output.showReport({ fileName, purpose }) (false = nothing to report: say it yourself).
//              baseName is the name the user typed in the dialog when they changed it.
//              saveBytes(bytes, fileName), download({ ask?, options? }), print(), reportWarnings(warnings)
//   editing  setTool(id, { lock }), undo(), redo(), ensureFonts(textObject) -> boolean,
//            beforeEdit() -> Promise<boolean>   call it before the first command of anything that changes the
//            document outside a tool (a page operation, a paste): false = view-only, or the user keeps the
//            signatures. It waits for the "can it be edited?" check of a file that was just opened (the root
//            says data-editable="checking" meanwhile), asks once per document when the author of a file
//            restricted changes (confirmEditingRestricted(): flags.restricted / restrictedEditConfirmed) and
//            once when it is signed (confirmEditingSigned()); canEdit({ silent }) tells without asking
//            whether the document is view-only.
//   view     setZoom(mode | factor), zoomAuto(), zoomIn(), zoomOut(), zoomBy(factor, anchor), goToPage(number | id),
//            nextPage() ... search(query, options), openSearch(), closeSearch(), findNext(), findPrevious(),
//            toggleLeftPanel(id?), openLeftPanel(id), toggleInspector(), toggleView(id), toggleFullScreen()
//   talking  confirm({ title, message, details, confirmLabel, cancelLabel, tone }) -> Promise<boolean>,
//            toast(message, { tone, onUndo }), hint(id, message, tone) (a toast that is not stacked while it
//            shows), reportError(error) (a toast with the sentence of messages.js; silent for cancellations),
//            runJob({ titleKey, cancellable }, async ({ signal, progress, describe }) => ...): the root is busy,
//            the chrome inert, the job card shows title, stage (progress(fraction, stageCode)), a detail line
//            (describe(text)) and Cancel, which aborts `signal`. Escape cancels a cancellable job as well.
//            The engines run on the main thread: a job is only as cancellable as its task yields.
//   keys     runCommand(id, details) runs a command as the keyboard would (features, kernel, reducer).
//   leaving  requestLeave(go) asks when there is work that was not downloaded (the back link, the Back button).
//
// Text for the user: t() / tk() with the Vietnamese entry in the dictionary of YOUR area. Counts: write the
// sentence for 1 separately where English needs it (the i18n layer has no plural rules).
//
// ---------------------------------------------------------------------------------------------------------------
// 4. HOW TO ADD ...
// ---------------------------------------------------------------------------------------------------------------
//   a dialog          manifest.dialogs.myDialog = Component;  const result = await ui.showDialog("myDialog", props)
//   a left panel      manifest.panels.myPanel = { labelKey: <a tk() text>, icon: "ListTree", component, order }
//   a drawer          manifest.drawers.myDrawer = Component;  ui.openDrawer("myDrawer", props)
//   a tool behaviour  pointer events of the page overlay -> ui.runInteraction({ type: "pointerdown", ... }) ->
//                     your effectExecutor turns the effects into store commands. The kernel sets the pointer
//                     mode of the pages from the interaction state (uiStore.js pointerModeFor: Hand / Space =
//                     "none" and the kernel pans; Select = "text"; every other tool and every running gesture =
//                     "overlay"); override it with ui.setPointerMode("text" | "overlay" | "none"), give it back
//                     with ui.setPointerMode(null). Defaults of a tool: ui.getToolStyle(kind) /
//                     ui.setToolDefaults(kind, patch) (kept in localStorage through sanitizeStyle).
//                     The kernel sends { type: "documentChanged" } after every change of the store.
//   a keyboard command   manifest.commands.copy = (editor, event) => { ...; return true; }. The dispatcher
//                     (ui/Shell.jsx) ignores input-method composition, open dialogs and menus, and text fields
//                     (there only the shortcuts that work everywhere apply). A region that wants a scope of its
//                     own carries data-pdfx-scope="organiser" | "search" | "text" | "none" ("none" = no shortcuts).
//   long work         await actions.runJob({ titleKey: <a tk() text>, cancellable: true }, async ({ signal, progress }) => ...)
//   a sentence for a code   editor.messages.describeError(error) / describeWarning({ code, params })
//
// Test hooks of the shell (BRIEF.md 5.5): the root is [data-testid="pdfx-root"] with data-busy, data-layout,
// data-tool, data-has-document, data-editable ("unknown" | "checking" | "yes" | "no"), data-dirty, data-view;
// tools are pdfx-tool-<id>, actions pdfx-action-<id>; the files go into [data-testid="pdfx-file-input"]
// (open) and "pdfx-file-input-add" (add).
import { useEffect, useState } from "react";
import { t } from "../../../i18n/index.js";
import * as catalogue from "../messages.js";
import { createEditorStore } from "../model/store.js";
import overlayFeature from "../overlay/index.js";
import pagesFeature from "../pages/index.js";
import { onPdfWorkerError, openPdfDocument, pdfjs, terminatePdfWorker } from "../pdfWorker.js";
import signingFeature from "../signing/index.js";
import { createTextLayoutService, sharedFontRegistry } from "../text/index.js";
import { createViewerController } from "../viewer/viewerController.js";
import { createActions } from "./actions.js";
import { KERNEL_DIALOGS } from "./dialogs/index.js";
import { EditorReactContext } from "./editorHooks.js";
import { mergeManifests } from "./manifest.js";
import { createUiStore } from "./uiStore.js";

/** Builds the editor: objects only, nothing starts before mount() (safe in a useState initialiser). */
function createEditor() {
  const fonts = sharedFontRegistry(import.meta.env.BASE_URL);
  const textService = createTextLayoutService({ fonts });
  const store = createEditorStore({ measureText: (object) => textService.measure(object) });

  // The controller listens for a worker that could not start; the listener is connected to pdfWorker.js only
  // while the page is mounted (mount / unmount below), so a page that was left holds on to nothing.
  const workerListeners = new Set();
  const viewer = createViewerController({
    pdfjs,
    openPdfDocument,
    onWorkerError: (listener) => {
      workerListeners.add(listener);
      return () => workerListeners.delete(listener);
    }
  });

  const features = mergeManifests([overlayFeature, pagesFeature, signingFeature]);
  const elements = new Map();
  const editor = {};

  const ui = createUiStore({
    getContext: () => {
      const { objects } = store.getState();
      return { objectType: (id) => objects[id]?.type, objectExists: (id) => Boolean(objects[id]) };
    },
    onError: (error) => editor.actions.reportError(error)
  });

  // sentences name a file by its name: the engines only know the id of a source
  const sources = (sourceId) => store.getState().sources[sourceId]?.name || "";
  const messages = Object.freeze({
    describeCode: (code, params) => catalogue.describeCode(code, params, { sources }),
    describeError: (error) => catalogue.describeError(error, { sources }),
    describeWarning: (warning) => catalogue.describeWarning(warning, { sources }),
    describeStage: (stageCode) => catalogue.describeStage(stageCode),
    isSilent: (errorOrCode) => catalogue.isSilent(errorOrCode)
  });

  // The engines are loaded on first use; a failed download of the chunk can be tried again.
  const lazy = (load) => {
    let promise = null;
    return () => {
      if (!promise) {
        promise = load().catch((error) => {
          promise = null;
          throw error;
        });
      }
      return promise;
    };
  };
  const loadPipeline = lazy(() => import("../engine/pipeline/index.js"));
  const loadSigning = lazy(() => import("../engine/sign/index.js"));
  const getPipelineEnv = lazy(async () => {
    const pipeline = await loadPipeline();
    return pipeline.createBrowserPipelineEnv({ pdfjs, openPdfDocument, onPdfWorkerError, fonts });
  });

  const getElement = (name) => elements.get(name) ?? null;
  const registerElement = (name, element) => {
    if (!element) return () => {};
    elements.set(name, element);
    return () => {
      if (elements.get(name) === element) elements.delete(name);
    };
  };
  const hasDialog = (id) => Boolean(KERNEL_DIALOGS[id] || features.dialogs[id]);

  const actions = createActions({ store, viewer, ui, textService, messages, features, loadPipeline, getPipelineEnv, getElement, hasDialog, getEditor: () => editor });

  Object.assign(editor, {
    store,
    viewer,
    ui,
    actions,
    textService,
    fonts,
    messages,
    features,
    loadPipeline,
    loadSigning,
    getPipelineEnv,
    getElement,
    registerElement,
    hasDialog,
    reportSlotError: () => actions.hint("slot-failure", t("A part of the editor could not be displayed. Your document is not affected."), "error")
  });

  /** Connects the parts while the page is mounted. Returns the cleanup; both survive StrictMode (run, undo, run). */
  editor.mount = () => {
    const offWorker = onPdfWorkerError((error) => {
      for (const listener of [...workerListeners]) listener(error);
    });

    // The viewer shows exactly the pages of the store, and a pdf.js document stays open exactly while the
    // store (the document or its undo history) still knows its source.
    const registered = new Set();
    const follow = () => {
      const state = store.getState();
      try {
        viewer.setPages(state.pages);
      } catch (error) {
        actions.reportError(error);
      }
      for (const id of Object.keys(state.sources)) registered.add(id);
      for (const id of [...registered]) {
        if (state.sources[id]) continue;
        registered.delete(id);
        viewer.closeSource(id);
      }
    };
    follow();
    const offStore = store.subscribe(() => {
      follow();
      // undo, redo or any command may have removed what was selected or is being edited
      ui.runInteraction({ type: "documentChanged" });
    });

    ui.setEffectExecutor((effects, event) => {
      for (const execute of features.effectExecutors) execute(editor, effects, event);
      actions.runShellEffects(effects);
    });

    if (import.meta.env.DEV) window.__pdfxEditor = editor;
    for (const problem of features.problems) console.warn(`pdf editor manifest: ${problem}`);

    return () => {
      offStore();
      offWorker();
      ui.setEffectExecutor(null);
      actions.abortJobs();
      ui.dispose();
      viewer.dispose();
      textService.dispose();
      terminatePdfWorker();
      if (import.meta.env.DEV && window.__pdfxEditor === editor) delete window.__pdfxEditor;
    };
  };

  return editor;
}

/** Creates the editor for the life of the page and hands it to everything below (useEditor()). */
export function EditorProvider({ children }) {
  const [editor] = useState(createEditor);
  useEffect(() => editor.mount(), [editor]);
  return <EditorReactContext.Provider value={editor}>{children}</EditorReactContext.Provider>;
}
