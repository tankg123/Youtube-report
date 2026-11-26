// The commands of the PDF editor that the tool bar, the menus, the keyboard and the features share.
// One instance per editor (ui/EditorContext.jsx creates it); everything it needs comes in as an argument, so
// the same code runs under `node --test` with small stand-ins (tests/pdfUiActions.test.mjs).
// The manual for feature authors (which action to call when) is the header of ui/EditorContext.jsx.
//
// Rules the actions keep for everybody:
//   * A file is opened in the viewer under an id and registered in the store under the SAME id; the store's
//     byte arrays are never handed to pdf.js or to a worker (the viewer and the engines copy).
//   * Every output goes through buildOutput(): an unchanged document is delivered as the ORIGINAL bytes of
//     its source (signatures survive), everything else is built by the pipeline inside the job runner.
//     buildOutput() also asks what has to be asked (pending redaction and blur marks, text that becomes a
//     picture), refuses to hand out a file whose check failed, asks again when removed content is still in
//     the file that was built, and reports what happened (ui/outputReport.js holds the rules and sentences).
//   * Long work runs in runJob(): the shell shows the title, the progress and Cancel, and disables the controls.
//   * Nothing here throws at the user: failures become sentences through messages.js (reportError), a
//     cancellation shows nothing.
import { formatNumber, t, tk } from "../../../i18n/index.js";
import { CANCELLED, PdfEditorError, isPdfEditorError, throwIfAborted } from "../engine/errors.js";
import { PAGE_SIZES } from "../engine/geometry.js";
import { buildExportJob } from "../model/exportJob.js";
import { createId } from "../model/schema.js";
import { sourcesInUse } from "../model/selectors.js";
import { toolById, toolsOfMenu } from "../tools/registry.js";
import { nextZoomStop, previousZoomStop } from "../viewer/zoom.js";
import { restrictsChanges } from "./documentFacts.js";
import { outputBaseName, pdfFileName, splitFiles } from "./fileNames.js";
import { focusIsLost, forgetFocus, recallFocus } from "./focusMemory.js";
import { runCommand as runCommandById } from "./keyCommands.js";
import { appliedFromOptions, applyRemedies, buildChoices, planNeedsQuestion, planOutput, reportIsWorthShowing, reviewFindings, stripsProperties, suggestedBaseName, summarizeReport } from "./outputReport.js";

/** A file above one of these asks before it is opened (UX specification 10). */
export const LARGE_FILE_BYTES = 100 * 1024 * 1024;
export const LARGE_FILE_PAGES = 500;
/** The zoom range and the presets of the zoom menu (UX specification 7.2), as zoom factors (1 = 100 %). */
export const ZOOM_LIMITS = Object.freeze({ min: 0.25, max: 4 });
export const ZOOM_PRESETS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);
/** "Automatic" zoom: fit the width, but never above this. */
export const AUTO_ZOOM_MAX = 1.25;
/** One notch of Ctrl + wheel. */
export const WHEEL_ZOOM_STEP = 1.1;
const SHAPE_TOOLS = toolsOfMenu("shapes").map((tool) => tool.id);

const clampZoom = (zoom) => Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, zoom));
const cancelled = () => new PdfEditorError(CANCELLED);
/** For work whose result lives in a store: a rejection (a superseded search, a closed source) is not an event. */
const quiet = (promise) => Promise.resolve(promise).catch(() => null);
const codeOf = (error) => (isPdfEditorError(error) ? error.code : "VIEW_OPEN_FAILED");

/** The writer refused a file that was to be combined with others: `reason` is its PdfEditorError. */
class NotCombinableError extends Error {
  constructor(reason) {
    super("the file can be read but not combined");
    this.reason = reason;
  }
}
/** The left panel a first document opens with on a wide screen. */
const FIRST_PANEL = "pages";
/** The id of the notice that says why a document is view-only. */
export const VIEW_ONLY_NOTICE = "view-only";
const megabytes = (bytes) => `${formatNumber(bytes / (1024 * 1024), undefined, { maximumFractionDigits: 1 })} MB`;

/** What the actions need from the browser; tests pass their own. */
export function browserPlatform() {
  return {
    /** A File -> its bytes. */
    readFile: async (file) => new Uint8Array(await file.arrayBuffer()),
    /** Hands a file to the user: Blob URL + a[download], revoked a minute later. */
    saveBlob(blob, fileName, host) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.rel = "noopener";
      link.style.display = "none";
      // inside the editor root: the application's read-only runtime leaves that subtree alone
      (host || document.body).append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    /** Shows a file in a new tab of the browser (the review step after a download): a Blob URL of this page, nothing leaves the device. */
    openBlob(blob, host) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.style.display = "none";
      (host || document.body).append(link);
      link.click();
      link.remove();
      // the tab reads the file while it loads; ten minutes later the address stops working and frees the memory
      setTimeout(() => URL.revokeObjectURL(url), 600000);
      return true;
    },
    /** Lets the browser paint once: the job card must be on screen before work that keeps the main thread. */
    breathe: () => new Promise((resolve) => setTimeout(resolve, 0)),
    /** Runs something when the browser has time (the editability check, warming up the engines). */
    idle(callback) {
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => callback(), { timeout: 2000 });
      else setTimeout(callback, 200);
    },
    /** The control that has the keyboard (a busy editor is inert: it would lose it for good). */
    focusedElement: () => (typeof document === "undefined" || document.activeElement === document.body ? null : document.activeElement),
    /**
     * Gives the keyboard back once the editor is usable again, unless the user put it somewhere meanwhile.
     * A job that was started from a dialog (Download -> question -> build) finds its own starting point gone:
     * the control that opened the dialog is remembered in ui/focusMemory.js and gets the keyboard instead.
     */
    restoreFocus(element) {
      if (typeof document === "undefined") return;
      setTimeout(() => {
        if (!focusIsLost()) return;
        const target = element?.isConnected ? element : recallFocus();
        target?.focus?.({ preventScroll: true });
        if (!focusIsLost()) forgetFocus();
      }, 0);
    }
  };
}

/**
 * @param {object} deps
 * @param {object} deps.store          the document store (model/store.js)
 * @param {object} deps.viewer         the viewer controller (viewer/viewerController.js)
 * @param {object} deps.ui             the UI store (ui/uiStore.js)
 * @param {object} deps.textService    the text layout service (text/layout.js)
 * @param {object} deps.messages       { describeError, describeWarning, describeCode, describeStage, isSilent }
 * @param {object} deps.features       the merged feature manifest (ui/manifest.js)
 * @param {() => Promise<object>} deps.loadPipeline     the module engine/pipeline/index.js, loaded on first use
 * @param {() => Promise<object>} deps.getPipelineEnv   the browser environment of the pipeline
 * @param {(name: string) => any} [deps.getElement]     DOM hooks the shell registered ("root", "openInput", ...)
 * @param {(id: string) => boolean} [deps.hasDialog]    true when a dialog with this id exists (kernel or feature)
 * @param {object} [deps.platform]     browserPlatform() by default
 * @param {() => object} [deps.getEditor]  the editor context, handed to feature hooks and commands
 */
export function createActions({ store, viewer, ui, textService, messages, features, loadPipeline, getPipelineEnv, getElement = () => null, hasDialog = () => false, platform = browserPlatform(), getEditor = () => null }) {
  const jobs = []; // running jobs, the newest last: the shell shows the top one
  let jobSeed = 0;
  let checkToken = 0; // the "can it be edited?" check of the current document
  let editCheck = Promise.resolve(); // settles when that check has its answer
  let signedQuestion = null; // the open "This document is signed" dialog, shared by everybody who asks
  let restrictedQuestion = null; // the same for "The author restricted changes to this file"
  let leaveQuestion = null;
  let lastLeftPanel = null;
  const hints = new Map(); // hint id -> the toast that shows it

  const editor = () => getEditor() || { store, viewer, ui, textService, features, actions };
  // the panel that was open last, however it was closed (its tab, its X, F4, a narrower window)
  ui.subscribe(() => {
    const open = ui.getState().leftPanel;
    if (open) lastLeftPanel = open;
  });
  const hasDocument = () => store.getState().pages.length > 0;

  // --- messages -----------------------------------------------------------------------------------------------

  /** The sentence for anything that was thrown ("" for a cancellation). */
  function describeError(error) {
    if (!error || messages.isSilent(error)) return "";
    return messages.describeError(error);
  }

  /** Shows what went wrong as an error toast. Silent for cancellations. @returns {boolean} true when something was shown */
  function reportError(error) {
    const text = describeError(error);
    if (!text) return false;
    ui.addToast({ message: text, tone: "error" });
    return true;
  }

  function toast(message, { tone = "info", onUndo = null, duration } = {}) {
    return ui.addToast({ message, tone, onUndo, duration });
  }

  /** A yes / no question in a dialog. @returns {Promise<boolean>} */
  async function confirm({ title, message, confirmLabel, cancelLabel, tone = "primary", details = null } = {}) {
    return (await ui.showDialog("confirm", { title, message, confirmLabel, cancelLabel, tone, details })) === true;
  }

  // --- the job runner -------------------------------------------------------------------------------------------

  function publishJob() {
    const top = jobs[jobs.length - 1];
    ui.setJob(top ? { id: top.id, titleKey: top.titleKey, progress: top.progress, stage: top.stage, detail: top.detail, cancellable: top.cancellable } : null);
  }

  /**
   * Runs long work as the editor's job: the root is busy, the controls are disabled, the shell shows the
   * title, the progress and (when `cancellable`) a Cancel button that aborts `signal`.
   * @param {{ titleKey: string, cancellable?: boolean }} job   titleKey: a tk() text
   * @param {(context: { signal: AbortSignal, progress: (fraction: number | null, stage?: string | null) => void,
   *                     describe: (detail: string) => void }) => any} task
   *        progress: how far the work is (0..1, null = unknown) and, optionally, a stage code for
   *        messages.describeStage; describe: a line under the title that is no sentence of ours (a file name)
   * @returns {Promise<any>} what the task returns; it rejects with what the task throws, and with
   *          PdfEditorError("CANCELLED") when Cancel came before the task started. The task starts
   *          asynchronously, after the job card had a chance to appear.
   */
  async function runJob({ titleKey, cancellable = false }, task) {
    const controller = new AbortController();
    const job = { id: `job${(jobSeed += 1)}`, titleKey, cancellable: Boolean(cancellable), progress: null, stage: null, detail: "", controller };
    const focused = jobs.length ? null : platform.focusedElement?.();
    jobs.push(job);
    publishJob();
    const progress = (fraction, stage) => {
      job.progress = Number.isFinite(fraction) ? fraction : null;
      if (stage !== undefined) job.stage = stage;
      if (jobs[jobs.length - 1] === job) publishJob();
    };
    const describe = (detail) => {
      job.detail = String(detail ?? "");
      if (jobs[jobs.length - 1] === job) publishJob();
    };
    try {
      // the engines run on the main thread: what the user sees when they start is what stays until they yield
      await platform.breathe?.();
      // cancelled before it began: the task never runs (it could miss an abort that already happened)
      throwIfAborted(controller.signal);
      return await task({ signal: controller.signal, progress, describe });
    } finally {
      jobs.splice(jobs.indexOf(job), 1);
      publishJob();
      if (!jobs.length) platform.restoreFocus?.(focused);
    }
  }

  /** The Cancel button of the job card. */
  function cancelJob() {
    const top = jobs[jobs.length - 1];
    if (!top?.cancellable) return false;
    top.controller.abort();
    return true;
  }

  /** Unmount: everything that runs is told to stop. */
  function abortJobs() {
    for (const job of [...jobs]) job.controller.abort();
  }

  // --- feature hooks ----------------------------------------------------------------------------------------------

  function callHooks(name, payload) {
    for (const hook of features[name] || []) {
      try {
        hook(editor(), payload);
      } catch (error) {
        reportError(error);
      }
    }
  }

  // --- "can it be edited?" (BRIEF-UI section 3) ------------------------------------------------------------------

  /** Opens the bytes with the WRITER: resolves with its facts, rejects with the EXPORT_ code that an export would hit. */
  async function inspectForEdit(bytes, { sourceId, password, encrypted, expectedPages }) {
    const pipeline = await loadPipeline();
    // an encrypted file that needed no password is opened with the empty user password (as the export job does)
    const options = { source: sourceId, expectedPages };
    if (typeof password === "string") options.password = password;
    else if (encrypted) options.password = "";
    return pipeline.inspectSource(bytes, options);
  }

  /** What the writer noted about a file (signed, a dynamic form that is dropped, damaged streams): said once. */
  function noticeWarnings(warnings) {
    for (const warning of warnings || []) {
      // a feature that brings banners (the state of the signatures) tells about a signed file itself, and better
      if (warning.code === "EXPORT_SOURCE_SIGNED" && features.banners?.length) continue;
      ui.addNotice({ tone: "warning", code: warning.code, params: warning.params || {} });
    }
  }

  /** After a single file is on screen: ask the writer in idle time; a refusal makes the document view-only. */
  function scheduleEditCheck(sourceId) {
    const token = (checkToken += 1);
    ui.setFlags({ editable: "checking", viewOnly: null });
    const check = async () => {
      if (token !== checkToken) return;
      const source = store.getState().sources[sourceId];
      const bytes = store.getSourceBytes(sourceId);
      if (!source || !bytes) {
        ui.setFlags({ editable: "unknown" });
        return;
      }
      try {
        const facts = await inspectForEdit(bytes, { sourceId, password: store.getSourcePassword(sourceId), encrypted: source.encrypted, expectedPages: source.pageCount });
        if (token !== checkToken) return;
        noticeWarnings(facts?.warnings);
        ui.setFlags({ editable: "yes" });
      } catch (error) {
        if (token !== checkToken) return;
        if (isPdfEditorError(error) && !messages.isSilent(error)) {
          // readable, not editable: back to a tool that changes nothing
          ui.setFlags({ editable: "no", viewOnly: { code: error.code, params: error.params } });
          ui.addNotice({ id: VIEW_ONLY_NOTICE, tone: "warning", code: error.code, params: error.params || {}, dismissible: false });
          const { tool } = ui.getState().interaction;
          if (toolById(tool)?.edits) ui.runInteraction({ type: "tool", tool: "select" });
        } else {
          // the engines could not be loaded: nothing is known, an export will say what is wrong
          ui.setFlags({ editable: "unknown" });
        }
      }
    };
    editCheck = new Promise((resolve) => {
      platform.idle(() => check().finally(resolve));
    });
  }

  /**
   * Resolves once the "can it be edited?" check of the current document has its answer (at once when none is
   * running). Whatever is about to change the document waits for it: an edit made in the moment before a
   * file turns out to be view-only would be in the document and not in any download.
   */
  async function editCheckSettled() {
    while (ui.getState().flags.editable === "checking") {
      const running = editCheck;
      await running;
      if (running === editCheck && ui.getState().flags.editable === "checking") break; // the check gave up without an answer
    }
  }

  // --- opening files -------------------------------------------------------------------------------------------

  /** The password dialog of one file: the same dialog stays open while wrong passwords are tried. */
  function passwordPrompt(fileName) {
    let key = null;
    let settle = null;
    let attempt = 0;
    const answer = (value) => {
      const resolve = settle;
      settle = null;
      resolve?.(value);
    };
    return {
      ask(reason) {
        return new Promise((resolve) => {
          settle = resolve;
          attempt += 1;
          const props = {
            fileName,
            reason,
            attempt,
            checking: false,
            onSubmit: (value) => {
              if (key !== null) ui.updateDialog(key, { checking: true });
              answer(String(value ?? ""));
            },
            onCancel: () => answer(null)
          };
          if (key === null) key = ui.openDialog("password", props);
          else ui.updateDialog(key, props);
        });
      },
      close() {
        answer(null);
        if (key !== null) ui.closeDialog(key);
        key = null;
      }
    };
  }

  const itemName = (item) => String(item?.name ?? item?.file?.name ?? "");

  /**
   * Reads one file and opens it in the viewer (password dialog, large-file question, and for a file that is
   * combined with others the editability check). The store is not touched.
   * @returns {Promise<{ sourceId, name, bytes, facts, password }>} rejects with a PdfEditorError
   */
  async function openInViewer(item, { signal, precheck }) {
    const name = itemName(item);
    // a File is told by arrayBuffer(): current browsers also give every Blob a bytes() METHOD, which is not `bytes`
    const file = typeof item?.arrayBuffer === "function" ? item : item?.file || null;
    const given = !file && item?.bytes && typeof item.bytes !== "function" ? item.bytes : null;
    const size = given?.byteLength ?? file?.size ?? 0;
    if (size > LARGE_FILE_BYTES) {
      const go = await confirm({
        title: t("Large file"),
        message: t("This file is large ({size}). Opening it may be slow and use a lot of memory.", { size: megabytes(size) }),
        confirmLabel: t("Open anyway"),
        details: name
      });
      if (!go) throw cancelled();
    }
    throwIfAborted(signal);
    let bytes;
    if (given) bytes = given instanceof ArrayBuffer ? new Uint8Array(given) : given;
    else if (file) bytes = await platform.readFile(file);
    if (!(bytes instanceof Uint8Array)) throw new PdfEditorError("VIEW_INVALID_PDF");
    throwIfAborted(signal);

    const sourceId = createId("s");
    const prompt = passwordPrompt(name);
    let facts;
    try {
      const options = { onPassword: prompt.ask, signal };
      if (typeof item?.password === "string") options.password = item.password;
      facts = await viewer.openSource(sourceId, bytes, options);
    } finally {
      prompt.close();
    }
    try {
      if (facts.pageCount > LARGE_FILE_PAGES && size <= LARGE_FILE_BYTES) {
        const go = await confirm({
          title: t("Large file"),
          message: t("This file is large ({size}, {pages} pages). Editing may be slow and use a lot of memory.", { size: megabytes(bytes.byteLength), pages: facts.pageCount }),
          confirmLabel: t("Open anyway"),
          details: name
        });
        if (!go) throw cancelled();
      }
      throwIfAborted(signal);
      const password = viewer.getSourcePassword(sourceId) ?? undefined;
      let warnings = [];
      if (precheck) {
        try {
          const inspected = await inspectForEdit(bytes, { sourceId, password, encrypted: facts.encrypted, expectedPages: facts.pageCount });
          warnings = inspected?.warnings || [];
        } catch (error) {
          // a refusal of the writer is final for a file that is to be combined; a missing engine is not
          if (isPdfEditorError(error)) throw new NotCombinableError(error);
        }
        throwIfAborted(signal);
      }
      return { sourceId, name, bytes, facts, password, warnings };
    } catch (error) {
      viewer.closeSource(sourceId);
      throw error;
    }
  }

  /** The sentence for a file that could not be opened or added. */
  function describeOpenFailure({ name, error }) {
    if (error instanceof NotCombinableError) {
      return t("{name} can be viewed but not edited here, so it cannot be combined with other files. Open it on its own to read it.", { name });
    }
    return t("{name}: {problem}", { name, problem: describeError(error) });
  }

  const failureCode = (error) => codeOf(error instanceof NotCombinableError ? error.reason : error);
  const isQuiet = (error) => !(error instanceof NotCombinableError) && messages.isSilent(error);

  async function openAll(items, { signal, progress, describe, precheck }) {
    const loaded = [];
    const failed = [];
    for (let index = 0; index < items.length; index += 1) {
      progress(index / items.length);
      describe(itemName(items[index]));
      try {
        loaded.push(await openInViewer(items[index], { signal, precheck }));
      } catch (error) {
        if (signal.aborted) {
          for (const entry of loaded) viewer.closeSource(entry.sourceId);
          throw cancelled();
        }
        failed.push({ name: itemName(items[index]), error });
      }
    }
    progress(1);
    return { loaded, failed };
  }

  function reportOpenFailures(failed) {
    for (const failure of failed) {
      if (isQuiet(failure.error)) continue;
      ui.addToast({ message: describeOpenFailure(failure), tone: "error" });
    }
  }

  const registerSource = (target, entry) => target.addSource(entry.facts, entry.bytes, { id: entry.sourceId, name: entry.name, password: entry.password });

  /**
   * Makes the given files the working document (one document, pages in the order given).
   * @param {Array<File | { name: string, bytes: Uint8Array, password?: string }>} items
   * @param {{ resetHistory?: boolean }} [options]  true (default): a new document with an empty history;
   *        false: one undoable step that swaps the pages
   * @returns {Promise<{ opened: Array<{ sourceId, name, pageCount }>, failed: Array<{ name, code }> } | null>}
   *          null when nothing was opened (cancelled, or every file failed: the reasons were shown)
   */
  async function replaceDocument(items, { resetHistory = true } = {}) {
    const list = [...(items || [])];
    if (!list.length) return null;
    let outcome;
    try {
      outcome = await runJob({ titleKey: tk("Opening…"), cancellable: true }, ({ signal, progress, describe }) => openAll(list, { signal, progress, describe, precheck: list.length > 1 }));
    } catch (error) {
      reportError(error);
      return null;
    }
    const { loaded, failed } = outcome;
    const visibleFailures = failed.filter((failure) => !isQuiet(failure.error));
    if (!loaded.length) {
      if (!hasDocument() && visibleFailures.length) {
        // the empty editor shows the first failure as a card in the page area
        const [first] = visibleFailures;
        const reason = first.error instanceof NotCombinableError ? first.error.reason : first.error;
        ui.setOpenError({ fileName: first.name, code: codeOf(reason), params: isPdfEditorError(reason) ? reason.params : {} });
        reportOpenFailures(visibleFailures.slice(1));
      } else {
        reportOpenFailures(visibleFailures);
      }
      return null;
    }

    const hadDocument = hasDocument();
    try {
      if (resetHistory) {
        if (hadDocument) callHooks("onDocumentClosed");
        store.reset((target) => {
          for (const entry of loaded) {
            registerSource(target, entry);
            target.insertPages(target.pagesOfSource(entry.sourceId));
          }
          target.setFileName(loaded[0].name);
        });
        ui.resetForDocument();
      } else {
        for (const entry of loaded) registerSource(store, entry);
        store.transaction((target) => {
          const old = target.getState().pages.map((page) => page.id);
          for (const entry of loaded) target.insertPages(target.pagesOfSource(entry.sourceId));
          if (old.length) target.deletePages(old);
          target.setFileName(loaded[0].name);
        });
        // what was answered and said about the old pages does not hold for the new ones
        ui.setFlags({ signedEditConfirmed: false, restrictedEditConfirmed: false, savedAs: null });
        ui.dismissNotice(VIEW_ONLY_NOTICE);
      }
      syncRestricted();
    } catch (error) {
      for (const entry of loaded) if (!store.getState().sources[entry.sourceId]) viewer.closeSource(entry.sourceId);
      reportError(error);
      return null;
    }
    ui.setOpenError(null);
    checkToken += 1;
    if (loaded.length === 1) {
      scheduleEditCheck(loaded[0].sourceId);
    } else {
      // every file of a combined document passed the writer before it was added
      ui.setFlags({ editable: "yes", viewOnly: null });
      for (const entry of loaded) noticeWarnings(entry.warnings);
    }
    zoomAuto();
    // a new document starts at its first page, not where the last one was left (after the zoom: zooming keeps
    // the middle of the view in place, which would scroll the new pages)
    if (resetHistory) viewer.getContainer()?.scrollTo(0, 0);
    // a first document on a wide screen starts with its pages panel (UX specification 3.1)
    if (!hadDocument && ui.getState().layout === "wide" && !ui.getState().leftPanel) openLeftPanel(FIRST_PANEL);
    for (const entry of loaded) callHooks("onDocumentOpened", { sourceId: entry.sourceId, facts: entry.facts, name: entry.name });
    const pages = loaded.reduce((sum, entry) => sum + entry.facts.pageCount, 0);
    if (loaded.length > 1) toast(t("Opened {count} files as one document ({pages} pages)", { count: loaded.length, pages }), { tone: "success" });
    reportOpenFailures(visibleFailures);
    return {
      opened: loaded.map((entry) => ({ sourceId: entry.sourceId, name: entry.name, pageCount: entry.facts.pageCount })),
      failed: failed.map((failure) => ({ name: failure.name, code: failureCode(failure.error) }))
    };
  }

  /** Pictures among picked or dropped files belong to a feature ("Image as page", "Place on this page"). */
  function offerImages(images, intent, index) {
    if (!images.length) return false;
    const taken = runCommandById(editor(), "openImages", { scope: "viewer", keyEvent: null, files: images, intent, index });
    if (!taken) toast(t("Only PDF files can be opened here."), { tone: "warning" });
    return taken;
  }

  /**
   * Open (app bar, Ctrl+O, a drop on the empty editor): the files become ONE working document. Asks before
   * it replaces a document with changes that were not downloaded.
   */
  async function openFiles(files) {
    const { pdfs, images } = splitFiles([...(files || [])]);
    if (!pdfs.length) {
      offerImages(images, "open");
      return null;
    }
    if (hasDocument() && store.isDirty()) {
      const go = await confirm({
        title: t("Open another document?"),
        message: t("Changes that were not downloaded will be lost."),
        confirmLabel: t("Open"),
        tone: "warning"
      });
      if (!go) return null;
    }
    const result = await replaceDocument(pdfs, { resetHistory: true });
    if (result && images.length) offerImages(images, "add");
    return result;
  }

  /** True when the document may be changed right now; says why not otherwise. Does not ask anything. */
  function canEdit({ silent = false } = {}) {
    if (!hasDocument()) return false;
    const { viewOnly } = ui.getState().flags;
    if (!viewOnly) return true;
    if (!silent) toast(t("This file can be viewed but not edited here."), { tone: "warning" });
    return false;
  }

  /**
   * Call it before the first command of anything that changes the document (a tool, a page operation, a
   * paste): false when the document is view-only, when its author restricted changes and the user does not
   * say they may edit it, or when the user does not want to break its signatures. It waits for the "can it
   * be edited?" check of a file that was just opened.
   * @returns {Promise<boolean>}
   */
  async function beforeEdit() {
    await editCheckSettled();
    if (!canEdit()) return false;
    if (!(await confirmEditingRestricted())) return false;
    return confirmEditingSigned();
  }

  /**
   * Opens one more PDF as a source WITHOUT putting pages into the document ("Pages from PDF"): password
   * dialog, large-file question and editability check included. Insert with
   * store.insertPages(store.pagesOfSource(sourceId, indices), index); forget it with discardSource().
   * @param {File | { name: string, bytes: Uint8Array, password?: string }} item
   * @returns {Promise<{ sourceId, name, pageCount, facts } | null>} null when cancelled or refused (said to the user)
   */
  async function loadSource(item, { signal } = {}) {
    try {
      const run = ({ signal: jobSignal }) => openInViewer(item, { signal: jobSignal, precheck: true });
      const entry = signal ? await run({ signal }) : await runJob({ titleKey: tk("Opening…"), cancellable: true }, run);
      try {
        registerSource(store, entry);
      } catch (error) {
        viewer.closeSource(entry.sourceId);
        throw error;
      }
      noticeWarnings(entry.warnings);
      return { sourceId: entry.sourceId, name: entry.name, pageCount: entry.facts.pageCount, facts: entry.facts };
    } catch (error) {
      if (!isQuiet(error)) ui.addToast({ message: describeOpenFailure({ name: itemName(item), error }), tone: "error" });
      return null;
    }
  }

  /** Forgets a source that loadSource() registered and no page uses (the viewer closes its document). */
  const discardSource = (sourceId) => store.discardSource(sourceId);

  /**
   * Add files: appends the pages of more PDFs to the working document (at `index`, default: the end) as ONE
   * undo step.
   * @returns {Promise<{ opened: object[], failed: object[], pageIds: string[] } | null>}
   */
  async function addFiles(files, index) {
    const { pdfs, images } = splitFiles([...(files || [])]);
    if (!hasDocument()) return openFiles(files);
    if (!pdfs.length) {
      offerImages(images, "add", index);
      return null;
    }
    if (!(await beforeEdit())) return null;
    let outcome;
    try {
      outcome = await runJob({ titleKey: tk("Opening…"), cancellable: true }, ({ signal, progress, describe }) => openAll(pdfs, { signal, progress, describe, precheck: true }));
    } catch (error) {
      reportError(error);
      return null;
    }
    const { loaded, failed } = outcome;
    reportOpenFailures(failed);
    if (!loaded.length) return null;
    let pageIds = [];
    try {
      for (const entry of loaded) registerSource(store, entry);
      store.transaction((target) => {
        let at = Number.isInteger(index) ? index : target.getState().pages.length;
        for (const entry of loaded) {
          const ids = target.insertPages(target.pagesOfSource(entry.sourceId), at);
          pageIds = pageIds.concat(ids);
          at += ids.length;
        }
      });
    } catch (error) {
      for (const entry of loaded) if (!store.discardSource(entry.sourceId)) viewer.closeSource(entry.sourceId);
      reportError(error);
      return null;
    }
    for (const entry of loaded) {
      noticeWarnings(entry.warnings);
      callHooks("onDocumentOpened", { sourceId: entry.sourceId, facts: entry.facts, name: entry.name });
    }
    if (pageIds.length) viewer.scrollToPage(pageIds[0]);
    toast(t("Files added: {count}. Pages added: {pages}.", { count: loaded.length, pages: pageIds.length }), { tone: "success", onUndo: () => undo() });
    if (images.length) offerImages(images, "add", index);
    return {
      opened: loaded.map((entry) => ({ sourceId: entry.sourceId, name: entry.name, pageCount: entry.facts.pageCount })),
      failed: failed.map((failure) => ({ name: failure.name, code: failureCode(failure.error) })),
      pageIds
    };
  }

  /** A new document with one blank A4 page. */
  async function newBlankDocument() {
    if (hasDocument() && store.isDirty()) {
      const go = await confirm({ title: t("Open another document?"), message: t("Changes that were not downloaded will be lost."), confirmLabel: t("Open"), tone: "warning" });
      if (!go) return false;
    }
    if (hasDocument()) callHooks("onDocumentClosed");
    store.reset((target) => {
      target.insertBlankPage(0, [...PAGE_SIZES.A4]);
    });
    ui.resetForDocument();
    ui.setOpenError(null);
    checkToken += 1;
    ui.setFlags({ editable: "yes" });
    zoomAuto();
    viewer.getContainer()?.scrollTo(0, 0);
    return true;
  }

  /** Close document: back to the empty editor. Asks when there are changes that were not downloaded. */
  async function closeDocument() {
    if (!hasDocument()) return false;
    if (store.isDirty()) {
      const go = await confirm({ title: t("Close this document?"), message: t("Changes that were not downloaded will be lost."), confirmLabel: t("Close document"), tone: "warning" });
      if (!go) return false;
    }
    callHooks("onDocumentClosed");
    checkToken += 1;
    store.reset();
    ui.resetForDocument();
    ui.setOpenError(null);
    return true;
  }

  /** Clicks the hidden file input of the shell: "open" replaces the document, "add" appends to it. */
  function openFilePicker(mode = "open") {
    const input = getElement(mode === "add" ? "addInput" : "openInput");
    if (!input) return false;
    input.click();
    return true;
  }

  // --- output -------------------------------------------------------------------------------------------------

  /**
   * Tells the user what the engines noted about an output (never dropped): the report dialog with every
   * warning as a sentence. buildOutput() shows its own, richer report; this is for warnings from elsewhere.
   */
  function reportWarnings(warnings, { purpose = "download" } = {}) {
    if (!warnings?.length) return false;
    ui.openDialog("report", { purpose, warnings: warnings.map((warning) => ({ code: warning.code, params: warning.params || {} })) });
    return true;
  }

  /** What the viewer read from a file in use (bookmarks, permissions), or null. */
  const viewerFacts = (sourceId) => viewer.getSourceFacts?.(sourceId) || null;

  /**
   * THE way out of the editor: every file that leaves it (Download, Print, Extract, the document that gets
   * signed) is produced here, and everything that has to be asked or said about it is asked and said here:
   *
   *   1. BEFORE the build, when redaction or blur marks are pending, when a text box will be exported as a
   *      picture, or when the caller asks for the options (`ask`): the dialog "export" (what will be removed
   *      for good on how many pages, what the file may leave out, its name). Cancel = null, nothing is built.
   *   2. The build, in the job runner: named stages, progress, Cancel.
   *   3. A build that FAILS (above all: a file that did not pass its verification) hands out nothing: the dialog
   *      "exportFailed" says so and offers to try again.
   *   4. A build that worked but still holds something the user removed (a replaced text line that could only
   *      be covered, redacted text repeated in bookmarks, properties or form fields, letter shapes in a font,
   *      the bookmark of a removed page that was kept for the bookmarks under it, data of removed pages that
   *      may travel with kept pages): the dialog "exportReview" asks BEFORE the file is handed out. The user
   *      lets the editor remove what it can (the file is built again with eraseFallback "redact", without
   *      bookmarks, without properties, with pages as pictures, with dropOrphanBookmarks), takes the file as it
   *      is, or cancels (null).
   *   5. The result report (dialog "report"): per page what happened to its marks, every warning of the
   *      pipeline as a sentence, and the file itself in a new tab for the review.
   *
   * @param {object} [request]
   * @param {"download" | "print" | "sign" | "extract"} [request.purpose]
   * @param {string[]} [request.pageIds]   only these pages (an extract)
   * @param {object} [request.options]     options of the pipeline's buildOutput (keepOutline, keepForms,
   *        eraseFallback, redactPath, rasterPages ...), plus `info` (document properties override of
   *        buildExportJob) and `now`. With `signal` / `onProgress` the work runs inside the caller's own job
   *        (no second job card); the questions are still asked, over that job.
   * @param {boolean} [request.ask]        show the options also when nothing has to be asked ("Download options")
   * @param {"auto" | "defer"} [request.report]   "auto" (default): the result report opens when the build ends;
   *        "defer": the caller delivers the file first and then calls output.showReport({ fileName, purpose })
   * @returns {Promise<{ bytes: Uint8Array, report: object | null, baseName: string, original: boolean,
   *          showReport?: Function } | null>}
   *          original: true = the untouched bytes of the source (a document without any change, or a view-only
   *          one), as a private copy, report null. baseName has no ".pdf" (ui/fileNames.js pdfFileName adds it);
   *          it is the name the user typed in the dialog when they changed it.
   *          null = cancelled, or failed (the failure was shown): nothing is ever delivered then.
   */
  async function buildOutput({ purpose = "download", pageIds, options = {}, ask = false, report: reportMode = "auto" } = {}) {
    const state = store.getState();
    if (!state.pages.length) return null;
    const extract = Array.isArray(pageIds);
    const { viewOnly } = ui.getState().flags;
    const { info, now, signal: outerSignal, onProgress: outerProgress, ...pipelineOptions } = options;

    // nothing was changed (or nothing can be): the file itself, so that its signatures survive
    let originalId = null;
    if (!extract) {
      originalId = store.pristineSourceId();
      if (!originalId && viewOnly) {
        const used = sourcesInUse(state);
        originalId = used.length === 1 ? used[0].id : null;
      }
      // the browser's print frame cannot ask for a password: a protected file is printed as a rebuilt copy
      if (originalId && purpose === "print" && !viewOnly && state.sources[originalId]?.encrypted) originalId = null;
      if (originalId && !store.getSourceBytes(originalId)) originalId = null;
    }
    if (viewOnly && !originalId) {
      reportError(new PdfEditorError(viewOnly.code, viewOnly.params));
      return null;
    }

    // ---- 1. what has to be asked before anything is built
    const plan = planOutput(state, {
      pageIds: extract ? pageIds : null,
      checkText: typeof textService?.check === "function" ? (object) => textService.check(object) : null,
      outlineOf: (sourceId) => viewerFacts(sourceId)?.outline?.length || 0,
      // (also a file that is only protected by a password: the copy that is made does not have that password)
      restrictedOf: (sourceId) => restrictsChanges(viewerFacts(sourceId)?.permissions) || Boolean(viewerFacts(sourceId)?.encrypted || state.sources[sourceId]?.encrypted)
    });
    let nameOverride = null;
    let choices = { removeProperties: stripsProperties(info), removeBookmarks: pipelineOptions.keepOutline === false };
    if (!viewOnly && (planNeedsQuestion(plan) || ask)) {
      const suggestedName = originalId ? outputBaseName({ fileName: state.fileName, purpose, original: true }) : suggestedBaseName(state.fileName, purpose, plan);
      const answer = await ui.showDialog("export", { purpose, plan, suggestedName, defaults: { removeProperties: choices.removeProperties || undefined, removeBookmarks: choices.removeBookmarks } });
      if (!answer || outerSignal?.aborted) return null;
      choices = { removeProperties: Boolean(answer.removeProperties), removeBookmarks: Boolean(answer.removeBookmarks) };
      if (answer.baseName && answer.baseName !== suggestedName) nameOverride = answer.baseName;
      // leaving something out of an unchanged file makes it a new file
      if (originalId && !viewOnly && (choices.removeProperties || choices.removeBookmarks)) originalId = null;
    }
    if (originalId) {
      // a copy: whoever gets the output may hand it to pdf.js or a worker, which would empty the store's own array
      const bytes = store.getSourceBytes(originalId);
      return { bytes: bytes.slice(), report: null, baseName: nameOverride || outputBaseName({ fileName: state.fileName, purpose, original: true }), original: true };
    }

    const pageNumbers = plan.pageNumbers;
    let current = buildChoices(choices, { info, pipeline: pipelineOptions });
    current.applied = appliedFromOptions(current);

    // ---- 2. the build
    const build = async ({ signal, progress }) => {
      const pipeline = await loadPipeline();
      throwIfAborted(signal);
      const jobOptions = { layoutText: (object) => textService.layoutForExport(object), signal };
      if (extract) jobOptions.pageIds = pageIds;
      if (current.info !== undefined) jobOptions.info = current.info;
      if (now !== undefined) jobOptions.now = now;
      const job = await buildExportJob(store, jobOptions);
      const env = await getPipelineEnv();
      throwIfAborted(signal);
      return pipeline.buildOutput(job, env, { ...current.pipeline, signal, onProgress: (fraction, stage) => progress(fraction, stage) });
    };
    const inCallersJob = Boolean(outerSignal || outerProgress);
    let result;
    let summary;
    for (;;) {
      try {
        result = inCallersJob
          ? await build({ signal: outerSignal, progress: outerProgress || (() => {}) })
          : await runJob({ titleKey: purpose === "print" ? tk("Preparing document for printing…") : tk("Building the document…"), cancellable: true }, build);
      } catch (error) {
        if (messages.isSilent(error)) return null;
        // ---- 3. nothing is delivered after a failure; the working document is untouched
        const again = await ui.showDialog("exportFailed", {
          code: isPdfEditorError(error) ? error.code : "",
          message: describeError(error),
          purpose,
          hadMarks: plan.marks > 0,
          redactPath: current.pipeline.redactPath || "hybrid"
        });
        if (outerSignal?.aborted) return null;
        if (again === "convert") current = { ...current, pipeline: { ...current.pipeline, redactPath: "raster" } };
        else if (again !== "retry") return null;
        continue;
      }
      // ---- 4. removed content that is still in the file: asked before the file is handed out
      summary = summarizeReport(result.report, { pageNumbers });
      const findings = reviewFindings(summary, { applied: current.applied });
      if (!findings.needed) break;
      const decision = await ui.showDialog("exportReview", { purpose, findings });
      if (!decision || outerSignal?.aborted) return null;
      if (!Array.isArray(decision.remedies) || !decision.remedies.length) break; // the file as it is
      current = applyRemedies(decision.remedies, findings, current);
    }

    // ---- 5. the result
    const { bytes } = result;
    const output = {
      bytes,
      report: result.report ?? null,
      baseName: nameOverride || outputBaseName({ fileName: state.fileName, purpose, original: false, usedRedaction: summary.usedMarks, pageNumbers }),
      original: false
    };
    const showReport = ({ fileName = null, purpose: deliveredAs = purpose } = {}) => {
      if (!reportIsWorthShowing(summary)) return false;
      // the document that gets signed is not the file the user ends up with: no review of this one
      const canOpen = deliveredAs !== "sign" && typeof platform.openBlob === "function";
      const onOpen = canOpen ? () => bytes.byteLength > 0 && platform.openBlob(new Blob([bytes], { type: "application/pdf" }), getElement("root")) : undefined;
      ui.openDialog("report", { purpose: deliveredAs, summary, warnings: summary.warnings, fileName, onOpen });
      return true;
    };
    if (reportMode === "defer") output.showReport = showReport;
    else showReport();
    return output;
  }

  /** Hands bytes to the user as a file (Blob URL + a[download]). */
  function saveBytes(bytes, fileName) {
    platform.saveBlob(new Blob([bytes], { type: "application/pdf" }), fileName, getElement("root"));
    return true;
  }

  /**
   * Download (Ctrl+S): the built output as "<name>-edited.pdf" ("-redacted" when marks were applied), an
   * unchanged document under its own name. Everything buildOutput() asks is asked first.
   * @param {{ ask?: boolean, options?: object }} [request]   ask: show the download options first; options: as buildOutput()
   * @returns {Promise<{ fileName: string, original: boolean, report: object | null } | null>}
   */
  async function download(request) {
    if (!hasDocument() || jobs.length) return null;
    const output = await buildOutput({ purpose: "download", ask: request?.ask === true, options: request?.options || {}, report: "defer" });
    if (!output) return null;
    const fileName = pdfFileName(output.baseName);
    saveBytes(output.bytes, fileName);
    store.markSaved();
    ui.setFlags({ savedAs: "downloaded" });
    // the report says in its first line that the file was downloaded; without one a toast does
    if (!output.showReport?.({ fileName })) toast(t("{name} was downloaded.", { name: fileName }), { tone: "success" });
    return { fileName, original: output.original, report: output.report };
  }

  /** Print (Ctrl+P): prints what Download would produce, through the browser's own print dialog. */
  async function print() {
    if (!hasDocument() || jobs.length) return null;
    if (!viewer.canPrint()) {
      const go = await confirm({
        title: t("Printing is not available in this browser"),
        message: t("This browser cannot print PDF files from this page. Download the file and print it from your PDF viewer."),
        confirmLabel: t("Download")
      });
      return go ? download() : null;
    }
    const output = await buildOutput({ purpose: "print", report: "defer" });
    if (!output) return null;
    let result;
    try {
      result = await runJob({ titleKey: tk("Preparing document for printing…"), cancellable: false }, () => viewer.printBytes(output.bytes));
    } catch {
      result = { loaded: false, printCalled: false };
    }
    if (result?.printCalled) {
      output.showReport?.({});
      return result;
    }
    const go = await confirm({
      title: t("The print dialog could not be opened"),
      message: t("Download the file and print it from your PDF viewer."),
      confirmLabel: t("Download")
    });
    if (go) {
      const fileName = pdfFileName(output.baseName);
      saveBytes(output.bytes, fileName);
      if (!output.showReport?.({ fileName, purpose: "download" })) toast(t("{name} was downloaded.", { name: fileName }), { tone: "success" });
    }
    return result;
  }

  // --- history, tools ---------------------------------------------------------------------------------------------

  const undo = () => (jobs.length ? false : store.undo());
  const redo = () => (jobs.length ? false : store.redo());

  /**
   * UX specification 8: asks once per document before the first edit of a signed document.
   * @returns {Promise<boolean>} true at once when no source in use carries a signature or the user already agreed
   */
  function confirmEditingSigned() {
    const count = sourcesInUse(store.getState()).reduce((sum, source) => sum + (source.signatureCount || 0), 0);
    if (!count || ui.getState().flags.signedEditConfirmed) return Promise.resolve(true);
    if (!signedQuestion) {
      signedQuestion = confirm({
        title: t("This document is signed"),
        message:
          count === 1
            ? t("Editing it will invalidate the existing signature. The signed original file is not changed.")
            : t("Editing it will invalidate {count} existing signatures. The signed original file is not changed.", { count }),
        confirmLabel: t("Edit anyway"),
        tone: "warning"
      }).then((yes) => {
        signedQuestion = null;
        if (yes) ui.setFlags({ signedEditConfirmed: true });
        return yes;
      });
    }
    return signedQuestion;
  }

  /**
   * UX specification 10 "Editing restricted by the author": the file opens for reading; before the first edit
   * the user is asked once per document to say that they may change it, and told that the copy they download
   * is a new, unprotected file.
   * @returns {Promise<boolean>} true at once when no file in use restricts changes or the user already agreed
   */
  function confirmEditingRestricted() {
    const { restricted, restrictedEditConfirmed } = ui.getState().flags;
    if (!restricted || restrictedEditConfirmed) return Promise.resolve(true);
    if (!restrictedQuestion) {
      restrictedQuestion = confirm({
        title: t("The author restricted changes to this file"),
        message: t("Edit it here only if you are allowed to change this document."),
        details: t("The copy you download is a new file: it is not protected and does not carry the restrictions of the original. The original file is not changed."),
        confirmLabel: t("I am allowed to edit this file"),
        tone: "warning"
      }).then((yes) => {
        restrictedQuestion = null;
        if (yes) ui.setFlags({ restrictedEditConfirmed: true });
        return yes;
      });
    }
    return restrictedQuestion;
  }

  /** Keeps flags.restricted in step with the files the pages come from (the permission flags the viewer read). */
  function syncRestricted() {
    if (typeof viewer.getSourceFacts !== "function") return;
    ui.setFlags({ restricted: sourcesInUse(store.getState()).some((source) => restrictsChanges(viewer.getSourceFacts(source.id)?.permissions)) });
  }
  store.subscribe(syncRestricted);

  /**
   * Chooses a tool (tool bar, single keys). Tools that change the document are refused on a view-only
   * document, ask once on a document whose author restricted changes, and once on a signed one; then the
   * reducer gets its "tool" event and the features' tool activators run (file pickers, the signature menu).
   * A tool with `flow: "signing"` only runs its activators: the signing feature switches the tool itself for
   * its position step, asks its own questions, and is the one that refuses a view-only document (it explains
   * why such a file is not signed; flags.viewOnly is settled before the activator runs).
   * @returns {Promise<boolean>} true when the tool (or its flow) was started
   */
  async function setTool(id, { lock = false } = {}) {
    const tool = toolById(id);
    if (!tool || jobs.length) return false;
    if (tool.edits) {
      await editCheckSettled();
      if (jobs.length || !hasDocument()) return false;
      if (tool.flow !== "signing") {
        if (!canEdit()) return false;
        if (!(await confirmEditingRestricted())) return false;
        if (!(await confirmEditingSigned())) return false;
      }
    }
    if (SHAPE_TOOLS.includes(tool.id)) ui.setPreference("lastShape", tool.id);
    if (tool.flow !== "signing") ui.runInteraction({ type: "tool", tool: tool.id, lock: Boolean(lock) });
    for (const activate of features.toolActivators?.[tool.id] || []) {
      try {
        await activate(editor());
      } catch (error) {
        reportError(error);
      }
    }
    return true;
  }

  /** Loads the faces a text object needs before a store command adds or changes it. @returns {Promise<boolean>} */
  async function ensureFonts(textObject) {
    try {
      await textService.ensureFonts(textObject);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  // --- zoom and pages ----------------------------------------------------------------------------------------------

  /** A mode ("fit-width" | "fit-page" | "actual") or a zoom factor (1 = 100 %), kept within 25 % and 400 %. */
  function setZoom(value, options) {
    ui.setAutoZoom(false);
    if (typeof value === "string") {
      viewer.setZoom(value, options);
      const { zoom } = viewer.getSnapshot();
      if (zoom < ZOOM_LIMITS.min || zoom > ZOOM_LIMITS.max) viewer.setZoom(clampZoom(zoom), options);
    } else if (Number.isFinite(value)) {
      viewer.setZoom(clampZoom(value), options);
    }
    return true;
  }

  /** Automatic: fit the width of the page area, but never above 125 %. The shell applies it again on resize. */
  function zoomAuto() {
    ui.setAutoZoom(true);
    viewer.setZoom("fit-width");
    const { zoom } = viewer.getSnapshot();
    if (zoom > AUTO_ZOOM_MAX) viewer.setZoom(AUTO_ZOOM_MAX);
    else if (zoom < ZOOM_LIMITS.min) viewer.setZoom(ZOOM_LIMITS.min);
    return true;
  }

  const zoomIn = (options) => setZoom(nextZoomStop(viewer.getSnapshot().zoom), options);
  const zoomOut = (options) => setZoom(previousZoomStop(viewer.getSnapshot().zoom), options);
  /** Ctrl + wheel and pinch: multiplies the zoom, keeping the point under the pointer where it is. */
  const zoomBy = (factor, anchor) => setZoom(viewer.getSnapshot().zoom * factor, anchor ? { anchor } : undefined);

  /** Scrolls to a page: its 1-based number or its id. */
  function goToPage(target) {
    const { pages } = store.getState();
    const page = typeof target === "number" ? pages[Math.min(pages.length, Math.max(1, Math.round(target))) - 1] : pages.find((candidate) => candidate.id === target);
    if (!page) return false;
    viewer.scrollToPage(page.id);
    return true;
  }

  const nextPage = () => goToPage(Math.min(viewer.getSnapshot().pageCount, viewer.getSnapshot().currentPageNumber + 1));
  const previousPage = () => goToPage(Math.max(1, viewer.getSnapshot().currentPageNumber - 1));
  const firstPage = () => goToPage(1);
  const lastPage = () => goToPage(viewer.getSnapshot().pageCount);

  // --- search -------------------------------------------------------------------------------------------------

  /** Runs the search of the viewer with the options of the search box. An empty query clears it. */
  function search(query, options) {
    ui.setSearch({ query: String(query ?? ""), options });
    const state = ui.getState().search;
    return quiet(viewer.search(state.query, state.options));
  }

  /** Ctrl+F: shows the search field and puts the keyboard in it. */
  function openSearch() {
    ui.setSearch({ open: true, focus: true });
    return true;
  }

  function closeSearch() {
    ui.setSearch({ open: false, query: "" });
    viewer.clearSearch();
    return true;
  }

  function stepSearch(forward) {
    const current = viewer.getSnapshot().search;
    const { query, options } = ui.getState().search;
    if (!query.trim()) return openSearch();
    if (current.query === query && current.total > 0 && !current.running) {
      if (forward) viewer.searchNext();
      else viewer.searchPrevious();
    } else if (!current.running || current.query !== query) {
      quiet(viewer.search(query, options));
    }
    return true;
  }

  const findNext = () => stepSearch(true);
  const findPrevious = () => stepSearch(false);

  // --- panels, views, the shell ---------------------------------------------------------------------------------

  /** Without an id: closes the open left panel, or opens the one that was open last (F4). */
  function toggleLeftPanel(id) {
    const open = ui.getState().leftPanel;
    if (id) {
      ui.toggleLeftPanel(id);
    } else if (open) {
      ui.closeLeftPanel();
    } else {
      const wanted = features.panels?.some((panel) => panel.id === lastLeftPanel) ? lastLeftPanel : features.panels?.[0]?.id;
      if (!wanted) return false;
      ui.openLeftPanel(wanted);
    }
    return true;
  }

  function openLeftPanel(id) {
    if (!features.panels?.some((panel) => panel.id === id)) return false;
    ui.openLeftPanel(id);
    return true;
  }

  const toggleInspector = () => {
    ui.toggleInspector();
    return true;
  };

  /** Shows or leaves a full-screen view of a feature ("organiser"). False when no feature has that view. */
  function toggleView(id) {
    if (!features.fullScreenViews?.[id] || !hasDocument()) return false;
    if (ui.getState().view === id) ui.closeView();
    else ui.openView(id);
    return true;
  }

  /** Opens a dialog by id when one is registered (the kernel's or a feature's). */
  function openKernelDialog(id, props) {
    if (!hasDialog(id)) return false;
    ui.openDialog(id, props);
    return true;
  }

  /** Puts the keyboard on something the shell registered: "toolbar", "pageNumber", "searchInput", "viewer". */
  function focusElement(name) {
    const target = getElement(name);
    if (!target || typeof target.focus !== "function") return false;
    target.focus();
    target.select?.();
    return true;
  }

  /** Full screen (Ctrl+Alt+P): the whole editor, bars included. */
  function toggleFullScreen() {
    const root = getElement("root");
    const doc = root?.ownerDocument;
    if (!root || !doc) return false;
    if (doc.fullscreenElement) doc.exitFullscreen?.();
    else root.requestFullscreen?.()?.catch?.(() => {});
    return true;
  }

  /**
   * The back link and the Back button: asks when there are changes that were not downloaded.
   * @param {() => void} go   leaves the editor for real (navigate("/home", { replace: true }))
   * @returns {Promise<boolean>} true when the editor was left
   */
  function requestLeave(go) {
    if (!store.isDirty()) {
      go();
      return Promise.resolve(true);
    }
    if (!leaveQuestion) {
      leaveQuestion = ui.showDialog("leave", {}).then(async (choice) => {
        leaveQuestion = null;
        if (choice === "leave") {
          go();
          return true;
        }
        if (choice === "download" && (await download())) {
          go();
          return true;
        }
        return false;
      });
    }
    return leaveQuestion;
  }

  // --- what the interaction reducer leaves to the shell -----------------------------------------------------------

  /** Escape with nothing left to cancel on the pages: closes what lies over them, one thing per press. */
  function shellEscape() {
    const { layout, leftPanel, inspector, search } = ui.getState();
    if (layout === "wide") return false;
    if (search.open) return closeSearch();
    if (leftPanel) return ui.closeLeftPanel();
    if (inspector.open && !inspector.pinned) return ui.setInspector({ open: false });
    return false;
  }

  /** A short piece of advice (or a failure that repeats), shown as a toast; the same one is not stacked while it shows. */
  function hint(id, message, tone = "info") {
    const key = String(id ?? message);
    if (hints.has(key) && ui.getState().toasts.some((entry) => entry.id === hints.get(key))) return false;
    hints.set(key, ui.addToast({ message, tone }));
    return true;
  }

  /**
   * The effects of tools/interaction.js that belong to the shell. The kernel runs them AFTER the effect
   * executors of the features, which leave these three alone:
   *   unhandledEscape   closes the search field, a panel or the properties panel that lies over the pages
   *   pan               scrolls the page area by the way the pointer went
   *   hint              a toast with t(effect.message)
   */
  function runShellEffects(effects) {
    for (const effect of effects || []) {
      if (effect?.type === "unhandledEscape") shellEscape();
      else if (effect?.type === "pan") viewer.getContainer()?.scrollBy(-effect.dx, -effect.dy);
      else if (effect?.type === "hint" && effect.message) hint(effect.id, t(effect.message));
    }
  }

  /** The pending-marks counter of the status bar: a feature lists them, else the properties panel opens. */
  function showPendingMarks() {
    if (runCommandById(editor(), "showPendingMarks", { scope: "viewer", keyEvent: null })) return true;
    ui.setInspector({ open: true });
    return true;
  }

  /** "Try again" on a page that could not be displayed. */
  function retryPage(pageId) {
    viewer.retryPage(pageId);
    return true;
  }

  /** Runs a command by id as the keyboard would: features first, then the kernel, then the reducer. */
  function runCommand(id, event = {}) {
    const interaction = ui.getState().interaction;
    const scope = event.scope || (ui.getState().view === "organiser" ? "organiser" : interaction.selection.length ? "selection" : "viewer");
    return runCommandById(editor(), id, { ...event, scope });
  }

  const actions = {
    // files
    openFiles,
    addFiles,
    replaceDocument,
    loadSource,
    discardSource,
    newBlankDocument,
    closeDocument,
    openFilePicker,
    // output
    buildOutput,
    download,
    print,
    saveBytes,
    reportWarnings,
    // history and tools
    undo,
    redo,
    setTool,
    canEdit,
    beforeEdit,
    confirmEditingSigned,
    confirmEditingRestricted,
    ensureFonts,
    // zoom and pages
    setZoom,
    zoomAuto,
    zoomIn,
    zoomOut,
    zoomBy,
    goToPage,
    nextPage,
    previousPage,
    firstPage,
    lastPage,
    // search
    search,
    openSearch,
    closeSearch,
    findNext,
    findPrevious,
    // panels and shell
    toggleLeftPanel,
    openLeftPanel,
    toggleInspector,
    toggleView,
    openKernelDialog,
    focusElement,
    toggleFullScreen,
    requestLeave,
    runCommand,
    runShellEffects,
    shellEscape,
    hint,
    showPendingMarks,
    retryPage,
    // dialogs, toasts, jobs, errors
    confirm,
    toast,
    runJob,
    cancelJob,
    abortJobs,
    reportError,
    describeError
  };
  return actions;
}
