// Stand-ins for the kernel suites (tests/pdfUi*.test.mjs): the UI store and the actions of the PDF editor run
// in Node against the real document store, with a storage, a viewer, a pipeline and a platform made here.
import { PdfEditorError, isPdfEditorError } from "../../src/pages/pdfEditor/engine/errors.js";
import { createEditorStore } from "../../src/pages/pdfEditor/model/store.js";
import { createActions } from "../../src/pages/pdfEditor/ui/actions.js";
import { mergeManifests } from "../../src/pages/pdfEditor/ui/manifest.js";
import { createUiStore } from "../../src/pages/pdfEditor/ui/uiStore.js";
import { bytesOf, fakeLayout, fakeMeasure, sourceFacts } from "./pdfModelKit.mjs";

/** The ids of ui/dialogs/index.js (the dialog components themselves are JSX: not loaded under node --test). */
const KERNEL_DIALOG_IDS = ["confirm", "password", "leave", "export", "exportReview", "exportFailed", "report", "properties", "shortcuts"];

/** A Storage that lives in memory. `failing: true` throws on every call, like a browser with storage switched off. */
export function memoryStorage(initial = {}, { failing = false } = {}) {
  const data = new Map(Object.entries(initial));
  const guard = () => {
    if (failing) throw new Error("storage is not available");
  };
  return {
    getItem(key) {
      guard();
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      guard();
      data.set(key, String(value));
    },
    removeItem(key) {
      guard();
      data.delete(key);
    },
    dump: () => Object.fromEntries(data)
  };
}

/** Timers that run only when the test says so. */
export function manualTimers() {
  let seed = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      seed += 1;
      pending.set(seed, { callback, delay });
      return seed;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pending: () => [...pending.values()].map((entry) => entry.delay),
    runAll() {
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.callback();
      }
    }
  };
}

/** The sentences of messages.js reduced to their codes, so that a test reads what was said. */
export const fakeMessages = Object.freeze({
  describeCode: (code) => `<${code}>`,
  describeError: (error) => `<${isPdfEditorError(error) ? error.code : "UNEXPECTED"}>`,
  describeWarning: (warning) => `<${warning?.code}>`,
  describeStage: (stage) => `<${stage}>`,
  isSilent: (errorOrCode) => ["CANCELLED", "VIEW_PASSWORD_CANCELLED"].includes(typeof errorOrCode === "string" ? errorOrCode : errorOrCode?.code)
});

/**
 * A viewer that opens "files" described by the test:
 *   files: { [first byte of the file]: { pages?, password?, facts?, fail?: code, outline?, permissions? } }
 * A file is recognised by its first byte (bytesOf(length, seed) differs per seed).
 */
export function fakeViewer(files = {}) {
  const open = new Map();
  const calls = [];
  let zoom = 1;
  let zoomMode = "actual";
  let fitWidth = 1;
  let currentPageNumber = 1;
  let pageCount = 0;
  const viewer = {
    calls,
    open,
    setFitWidth(value) {
      fitWidth = value;
    },
    async openSource(sourceId, bytes, options = {}) {
      calls.push(["openSource", sourceId]);
      const spec = files[bytes[0]] || {};
      if (spec.fail) throw new PdfEditorError(spec.fail);
      let used = null;
      if (spec.password !== undefined) {
        let reason = "need";
        let given = options.password;
        for (;;) {
          if (given === undefined) given = await options.onPassword?.(reason);
          if (given === null || given === undefined) throw new PdfEditorError("VIEW_PASSWORD_CANCELLED");
          if (given === spec.password) break;
          reason = "incorrect";
          given = undefined;
        }
        used = given;
      }
      if (options.signal?.aborted) throw new PdfEditorError("CANCELLED");
      const facts = sourceFacts(spec.pages || [{}], { encrypted: spec.password !== undefined, signatureCount: 0, ...(spec.facts || {}) });
      open.set(sourceId, { facts, password: used, outline: spec.outline || [], permissions: spec.permissions ?? null });
      return facts;
    },
    async closeSource(sourceId) {
      calls.push(["closeSource", sourceId]);
      open.delete(sourceId);
    },
    getSourcePassword: (sourceId) => open.get(sourceId)?.password ?? null,
    // what the real viewer adds to the facts of the model: bookmarks and the permission flags of the author
    getSourceFacts: (sourceId) => {
      const entry = open.get(sourceId);
      return entry ? { ...entry.facts, outline: entry.outline, permissions: entry.permissions } : null;
    },
    setPages(pages) {
      pageCount = pages.length;
    },
    getSnapshot: () => ({ zoom, zoomMode, currentPageNumber, pageCount, search: { query: "", total: 0, current: -1, running: false } }),
    setZoom(value) {
      calls.push(["setZoom", value]);
      if (typeof value === "string") {
        zoomMode = value;
        zoom = value === "actual" ? 1 : fitWidth;
      } else {
        zoomMode = "custom";
        zoom = value;
      }
    },
    scrollToPage(pageId) {
      calls.push(["scrollToPage", pageId]);
      return true;
    },
    setCurrentPage(number) {
      currentPageNumber = number;
    },
    search: async (query) => {
      calls.push(["search", query]);
      return { total: 0, current: -1, pageId: null };
    },
    searchNext: () => calls.push(["searchNext"]),
    searchPrevious: () => calls.push(["searchPrevious"]),
    clearSearch: () => calls.push(["clearSearch"]),
    retryPage: (pageId) => calls.push(["retryPage", pageId]),
    getContainer: () => null,
    canPrint: () => true,
    printBytes: async (bytes) => {
      calls.push(["printBytes", bytes.byteLength]);
      return { loaded: true, printCalled: true };
    }
  };
  return viewer;
}

/**
 * A pipeline that "builds" by naming what it was asked: bytes [80, 68, 70, pages...] and a report from `plan`:
 *   plan.failures     errors thrown by the next builds, one each
 *   plan.usedRedaction, plan.warnings   fields of every report
 *   plan.report       (job, options) => fields merged into the report (redaction, rasterizedTextObjectIds ...)
 */
export function fakePipeline(plan = {}) {
  const calls = [];
  const pipeline = {
    calls,
    createBrowserPipelineEnv: () => ({ env: true }),
    async inspectSource(bytes, options) {
      calls.push(["inspectSource", options]);
      const refusal = plan.refuse?.[bytes[0]];
      if (refusal) throw new PdfEditorError(refusal, { source: options.source });
      return { pages: options.expectedPages, warnings: plan.inspectWarnings?.[bytes[0]] || [] };
    },
    async buildOutput(job, env, options) {
      calls.push(["buildOutput", { job, options }]);
      options.onProgress?.(0.5, "PIPELINE_STAGE_ASSEMBLE");
      if (options.signal?.aborted) throw new PdfEditorError("CANCELLED");
      if (plan.failures?.length) throw plan.failures.shift();
      const bytes = Uint8Array.from([80, 68, 70, job.pages.length]);
      const report = { pageCount: job.pages.length, byteLength: bytes.byteLength, usedRedaction: Boolean(plan.usedRedaction), redaction: null, rasterizedTextObjectIds: [], warnings: plan.warnings || [], sources: {}, timings: {} };
      return { bytes, report: { ...report, ...(typeof plan.report === "function" ? plan.report(job, options) : {}) } };
    }
  };
  return pipeline;
}

/**
 * The kernel without React: the real document store and UI store, the real actions, and stand-ins around them.
 * @param {{ files?, plan?, manifests?, storage?, idleDelay?: number, checkText?: Function }} [options]  files: what
 *        the stand-in viewer opens; plan: what the stand-in pipeline answers; idleDelay: milliseconds before idle
 *        work runs; checkText: the `check` of the text service (which text boxes become pictures)
 * @returns {{ store, ui, viewer, pipeline, actions, saved, openedTabs, features, storage, answer }}
 *   saved    what saveBytes handed to the user: [{ fileName, blob }]; openedTabs: the files shown in a new tab
 *   answer   answers dialogs as they open: answer({ confirm: true, leave: "stay", password: "secret" | null })
 *            (a function gets the props of the dialog); asked: the dialogs that were opened, in order
 */
export function makeKernel({ files = {}, plan = {}, manifests = [], storage = memoryStorage(), idleDelay = null, checkText = null } = {}) {
  const store = createEditorStore({ measureText: fakeMeasure });
  const viewer = fakeViewer(files);
  const pipeline = fakePipeline(plan);
  const features = mergeManifests(manifests);
  const ui = createUiStore({
    storage,
    timers: manualTimers(),
    getContext: () => {
      const { objects } = store.getState();
      return { objectType: (id) => objects[id]?.type, objectExists: (id) => Boolean(objects[id]) };
    }
  });
  const saved = [];
  const openedTabs = [];
  const platform = {
    openBlob: (blob) => openedTabs.push(blob),
    readFile: async (file) => new Uint8Array(await file.arrayBuffer()),
    saveBlob: (blob, fileName) => saved.push({ fileName, blob }),
    // idleDelay: the browser is busy for that many milliseconds before the idle work runs
    idle: (callback) => (idleDelay === null ? queueMicrotask(callback) : setTimeout(callback, idleDelay)),
    focusedElement: () => null,
    restoreFocus: () => {}
  };
  const elements = new Map();
  const editor = {};
  const actions = createActions({
    store,
    viewer,
    ui,
    textService: { ensureFonts: async () => [], layoutForExport: async (object) => fakeLayout(object), check: checkText || (() => ({ ok: true, fallback: [], unsupported: [] })) },
    messages: fakeMessages,
    features,
    loadPipeline: async () => pipeline,
    getPipelineEnv: async () => pipeline.createBrowserPipelineEnv(),
    getElement: (name) => elements.get(name) ?? null,
    hasDialog: (id) => KERNEL_DIALOG_IDS.includes(id) || Boolean(features.dialogs[id]),
    platform,
    getEditor: () => editor
  });
  Object.assign(editor, { store, viewer, ui, actions, features });
  // what ui/EditorContext.jsx does while mounted
  store.subscribe(() => {
    viewer.setPages(store.getState().pages);
    ui.runInteraction({ type: "documentChanged" });
  });
  ui.setEffectExecutor((effects, event) => {
    for (const execute of features.effectExecutors) execute(editor, effects, event);
    actions.runShellEffects(effects);
  });

  const asked = [];
  let answers = {};
  const seen = new Set();
  ui.subscribe(() => {
    for (const dialog of ui.getState().dialogs) {
      const token = `${dialog.key}:${dialog.props.attempt ?? 0}`;
      if (seen.has(token)) continue;
      seen.add(token);
      asked.push({ id: dialog.id, props: dialog.props });
      if (!Object.hasOwn(answers, dialog.id)) continue;
      const wanted = answers[dialog.id];
      const value = typeof wanted === "function" ? wanted(dialog.props) : wanted;
      queueMicrotask(() => {
        if (dialog.id === "password") {
          if (value === null) dialog.props.onCancel();
          else dialog.props.onSubmit(value);
        } else {
          ui.closeDialog(dialog.key, value);
        }
      });
    }
  });

  return {
    store,
    ui,
    viewer,
    pipeline,
    actions,
    saved,
    openedTabs,
    features,
    storage,
    elements,
    editor,
    asked,
    answer(next) {
      answers = { ...answers, ...next };
    }
  };
}

/** A file as the picker gives it: { name, bytes } is what the actions accept besides a File. */
export const fileItem = (name, seed = 1, length = 64) => ({ name, bytes: bytesOf(length, seed) });

/** Lets queued microtasks and immediate timers run (the actions answer dialogs and idle work asynchronously). */
export const flush = async (rounds = 5) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
};
