// The state of the signing feature and the inspection of signed documents.
//
// What the interface shows lives in the feature bag of the UI store (ui.getFeatureState("signing")): plain
// data, not undoable, not persisted:
//   reports   { [sourceId]: { status, report?, code?, params? } }: what inspectSignatures() said about every
//             signed source file. status: "pending" (waits for idle time) | "running" | "done" | "failed" |
//             "unavailable" (no WebCrypto: the page is not opened over https) | "skipped" (a large file: only
//             on request)
//   flow      the certificate signing drawer (certSignFlow.js), or null
//   flash     { pageId, rect, token }: the rectangle "Go to signature" outlines for two seconds
// What must never be in a store lives in module variables: the signing identity (identity.js) and the picture
// of the stamp (certSignFlow.js).
//
// Two small lists are kept on this device in localStorage (storage.js): the saved signature pictures and the
// certificates the user trusts. The trust list is handed to inspectSignatures() as trustedCertificates, so
// that a chain that leads to one of them reads "Valid".
import { isPdfEditorError } from "../engine/errors.js";
import { sourcesInUse } from "../model/selectors.js";
import { createSignatureShelf, createTrustList } from "./storage.js";

export const FEATURE_ID = "signing";
export const PANEL_ID = "signatures";
export const DRAWER_ID = "certSign";
export const SIGNATURE_DIALOG = "signature";
export const SIGN_CHOICE_DIALOG = "signChoice";
/** Files above this size are inspected only when the user asks: the inspection runs on the main thread. */
export const AUTO_INSPECT_BYTES = 48 * 1024 * 1024;
export const FLASH_MS = 2000;

const EMPTY_BAG = Object.freeze({ reports: Object.freeze({}), flow: null, flash: null });

export const readBag = (ui) => ui.getFeatureState(FEATURE_ID) || EMPTY_BAG;
export const patchBag = (ui, patch) => ui.setFeatureState(FEATURE_ID, (previous) => ({ ...(previous || EMPTY_BAG), ...patch }));

// --- the two lists of this device ------------------------------------------------------------------------------

let signatureShelf = null;
let trustList = null;
/** The saved signature pictures (created on first use: nothing touches localStorage at import time). */
export const getSignatureShelf = () => (signatureShelf ||= createSignatureShelf());
/** The certificates the user trusts on this device. */
export const getTrustList = () => (trustList ||= createTrustList());

// --- inspection of signed sources -------------------------------------------------------------------------------

const running = new WeakMap(); // editor -> Map<sourceId, AbortController>
const controllersOf = (editor) => {
  if (!running.has(editor)) running.set(editor, new Map());
  return running.get(editor);
};

const idle = (callback) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => callback(), { timeout: 3000 });
  else setTimeout(callback, 300);
};

const hasWebCrypto = () => Boolean(globalThis.crypto?.subtle) && globalThis.isSecureContext !== false;

function setReport(editor, sourceId, entry) {
  const { reports } = readBag(editor.ui);
  patchBag(editor.ui, { reports: { ...reports, [sourceId]: entry } });
}

/**
 * Inspects the signatures of one source now.
 * @returns {Promise<object | null>} the report of inspectSignatures(), or null (failed, cancelled, gone)
 */
export async function inspectSource(editor, sourceId) {
  const { store } = editor;
  const source = store.getState().sources[sourceId];
  const bytes = store.getSourceBytes(sourceId);
  if (!source || !bytes) return null;
  const controllers = controllersOf(editor);
  controllers.get(sourceId)?.abort();
  if (!hasWebCrypto()) {
    setReport(editor, sourceId, { status: "unavailable" });
    return null;
  }
  const controller = new AbortController();
  controllers.set(sourceId, controller);
  setReport(editor, sourceId, { status: "running" });
  const current = () => controllers.get(sourceId) === controller && !controller.signal.aborted && Boolean(store.getState().sources[sourceId]);
  try {
    const signing = await editor.loadSigning();
    if (!current()) return null;
    const options = { trustedCertificates: getTrustList().certificates(), signal: controller.signal };
    const password = store.getSourcePassword(sourceId);
    if (typeof password === "string" && password) options.password = password;
    // the engine only reads the bytes (it never hands them to a worker), so the store's own array is safe here
    const report = await signing.inspectSignatures(bytes, options);
    if (!current()) return null;
    setReport(editor, sourceId, { status: "done", report });
    return report;
  } catch (error) {
    if (!current()) return null;
    const code = isPdfEditorError(error) ? error.code : "SIGN_INSPECTION_FAILED";
    if (code === "SIGN_NO_WEBCRYPTO") setReport(editor, sourceId, { status: "unavailable" });
    else if (code !== "CANCELLED") setReport(editor, sourceId, { status: "failed", code, params: isPdfEditorError(error) ? error.params || {} : {} });
    return null;
  } finally {
    if (controllers.get(sourceId) === controller) controllers.delete(sourceId);
  }
}

/** A file with signatures became part of the document: inspect it when the browser has time. */
export function scheduleInspection(editor, sourceId) {
  const { store } = editor;
  const source = store.getState().sources[sourceId];
  if (!source) return;
  const existing = readBag(editor.ui).reports[sourceId];
  if (existing && existing.status !== "failed") return; // seeded by the signing flow, or already on its way
  if ((source.byteLength || 0) > AUTO_INSPECT_BYTES) {
    setReport(editor, sourceId, { status: "skipped" });
    return;
  }
  setReport(editor, sourceId, { status: "pending" });
  idle(() => {
    if (readBag(editor.ui).reports[sourceId]?.status === "pending") inspectSource(editor, sourceId);
  });
}

/** The report of a file that was just signed here is known already (verifySigned read it back). */
export function seedReport(editor, sourceId, report) {
  controllersOf(editor).get(sourceId)?.abort();
  setReport(editor, sourceId, { status: "done", report });
}

/** The trust list changed: every signed source in use is inspected again. */
export function reinspectAll(editor) {
  const { reports } = readBag(editor.ui);
  for (const source of sourcesInUse(editor.store.getState())) {
    if (reports[source.id] && reports[source.id].status !== "skipped") inspectSource(editor, source.id);
  }
}

/** The document is closed or replaced: nothing of it stays. */
export function dropReports(editor) {
  for (const controller of controllersOf(editor).values()) controller.abort();
  controllersOf(editor).clear();
  patchBag(editor.ui, { reports: {}, flash: null });
}

/**
 * The sources in use with what is known about their signatures, for summarize() of verdict.js:
 * [{ sourceId, name, signatureCount, status, report, code, params }] (only sources that have signatures or a report).
 */
export function signedEntries(documentState, reports) {
  const entries = [];
  for (const source of sourcesInUse(documentState)) {
    const known = reports?.[source.id];
    if (!known && !(source.signatureCount > 0)) continue;
    entries.push({ sourceId: source.id, name: source.name || "", signatureCount: source.signatureCount || 0, status: known?.status || "pending", report: known?.report, code: known?.code, params: known?.params });
  }
  return entries;
}

/** "Go to signature": scrolls to the page of a signature and outlines its rectangle for two seconds. */
export function goToSignature(editor, sourceId, signature) {
  const { viewer, ui } = editor;
  if (!Number.isInteger(signature?.pageIndex)) return false;
  const pageId = viewer.findPageId(sourceId, signature.pageIndex, { near: viewer.getSnapshot().currentPageId });
  if (!pageId) return false;
  const rect = Array.isArray(signature.rect) && signature.rect.length === 4 && signature.visible ? signature.rect : null;
  viewer.scrollToPage(pageId, rect ? { rect, align: "center" } : { align: "start" });
  if (!rect) return true;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  patchBag(ui, { flash: { pageId, rect, token } });
  setTimeout(() => {
    if (readBag(ui).flash?.token === token) patchBag(ui, { flash: null });
  }, FLASH_MS);
  return true;
}
