// "Sign with certificate" (Ký số), UX specification 7.11: everything the four-step drawer does that is not
// drawing a control.
//
//   startCertSign(editor)    the tool activator: the checks BEFORE the drawer (secure context, a view-only
//                            document, a signed document with pending edits, a file that cannot take one more
//                            signature as it is, a document locked by its signer), then the drawer
//   setStep / closeFlow      the steps; step 3 (position) switches the interaction reducer to the certSign tool
//   runSigningEffects        the effect executor: the reducer's create / move / resize / delete of the
//                            signature rectangle (pseudo object SIGNATURE_FIELD_ID) become the field of the flow
//   signNow(editor)          the job: applying edits (actions.buildOutput) -> signing (pipeline.signOutput) ->
//                            checking the signature (pipeline.verifySigned). Only a signature that comes back
//                            intact, valid and covering the whole file is delivered: downloaded AND reopened
//                            as the working document. After a failure nothing is downloaded and the document
//                            with its edits is untouched.
//
// What is signed: a document without any change is signed on its ORIGINAL bytes (existing signatures stay
// valid); everything else is the built output of the pipeline. When the original cannot take a signature as
// it is (protected with a password, a damaged index, locked by its signer) the user is told that a rewritten
// copy is signed instead, without the existing signatures, and the build is forced.
//
// A VIEW-ONLY document is never signed: the writer refused the file (damaged, or built so that PDF programs
// read it in different ways: EXPORT_SOURCE_DAMAGED, EXPORT_SOURCE_INCONSISTENT ...), so neither a rewritten
// copy can be made nor is it certain that every reader shows what is on screen here. A signature on such a
// file would vouch for content nobody can pin down; the dialog says so and nothing is offered.
//
// The flow state is plain data in the feature bag (state.js); the private key (identity.js) and the picture of
// the stamp (below) stay in module variables.
import { formatDateTime, getLanguage, localeOf, t, tk } from "../../../i18n/index.js";
import { isPdfEditorError, throwIfAborted } from "../engine/errors.js";
import { countPendingMarks, sourcesInUse } from "../model/selectors.js";
import { SIGNATURE_FIELD_ID, SIGNATURE_FIELD_TYPE } from "../tools/interaction.js";
import { outputBaseName, pdfFileName } from "../ui/fileNames.js";
import { DEFAULT_SHOW, appearanceIsEmpty, detailLines } from "./appearanceLayout.js";
import { renderAppearance } from "./appearanceRender.js";
import { FIELD_DEFAULT_SIZE, fieldAfterMove, fieldAfterResize, fieldForEngine, fieldFromBox, fieldFromCreateEffect, fieldScreenBox, fieldWithMillimetres, presetField } from "./fieldGeometry.js";
import { getIdentity, getSigner } from "./identity.js";
import { DRAWER_ID, PANEL_ID, SIGN_CHOICE_DIALOG, getTrustList, patchBag, readBag, seedReport } from "./state.js";

export const STEPS = Object.freeze([
  Object.freeze({ id: 1, label: tk("Certificate") }),
  Object.freeze({ id: 2, label: tk("Appearance") }),
  Object.freeze({ id: 3, label: tk("Placement") }),
  Object.freeze({ id: 4, label: tk("Sign") })
]);
/** The three named stages of the signing job. */
export const SIGN_STAGES = Object.freeze([tk("Applying edits…"), tk("Signing…"), tk("Checking the signature…")]);

let stampPicture = null; // { png, width, height, dataUrl }: the picture of the stamp of the open flow
let remembered = null; // the appearance choices of the last flow of this tab
const pseudoObjects = new WeakMap(); // editor -> unregister function of the signature rectangle

const flowOf = (editor) => readBag(editor.ui).flow;
const patchFlow = (editor, patch) => {
  const flow = flowOf(editor);
  if (flow) patchBag(editor.ui, { flow: { ...flow, ...patch } });
};
const scaleOf = (editor) => (pageId) => editor.viewer.getPageView(pageId)?.scale || editor.viewer.getScale?.() || 1;
const hasWebCrypto = () => Boolean(globalThis.crypto?.subtle) && globalThis.isSecureContext !== false;

/** The picture the stamp shows (a signature picture, a seal), or null. Not part of any store. */
export const getStampPicture = () => stampPicture;

export function setStampPicture(editor, picture) {
  stampPicture = picture || null;
  patchFlow(editor, { pictureVersion: (flowOf(editor)?.pictureVersion || 0) + 1, run: null });
}

/** What the document looks like right now, for the summary of step 4 and for the decision what gets signed. */
export function documentFacts(editor) {
  const { store, ui } = editor;
  const state = store.getState();
  const used = sourcesInUse(state);
  const marks = countPendingMarks(state);
  const flow = flowOf(editor);
  const pristine = Boolean(store.pristineSourceId());
  return {
    pristine,
    // the file itself gets one more signature; false: a rewritten copy is signed
    original: pristine && !flow?.rebuildReason,
    signatures: used.reduce((sum, source) => sum + (source.signatureCount || 0), 0),
    objects: Object.keys(state.objects).length - marks.total,
    marks: marks.total,
    changes: store.getHistoryState().undoDepth,
    pageCount: state.pages.length,
    viewOnly: Boolean(ui.getState().flags.viewOnly)
  };
}

// --- before the drawer ----------------------------------------------------------------------------------------------

/**
 * The tool activator of "Sign with certificate": asks what has to be asked, then opens the drawer.
 * @returns {Promise<boolean>} true when the drawer is open
 */
export async function startCertSign(editor) {
  const { actions, store, ui } = editor;
  if (!store.getState().pages.length) return false;
  if (ui.getState().drawer?.id === DRAWER_ID && flowOf(editor)) {
    // the tool was chosen again while the drawer is open: in the position step that means "draw the rectangle"
    if (flowOf(editor).positioning) ui.runInteraction({ type: "tool", tool: "certSign" });
    return true;
  }
  if (!hasWebCrypto()) {
    await ui.showDialog(SIGN_CHOICE_DIALOG, { kind: "insecure" });
    return false;
  }
  // a file the editor can only show is never signed, as it is or as a copy (see the head of this file)
  const { viewOnly } = ui.getState().flags;
  if (viewOnly) {
    await ui.showDialog(SIGN_CHOICE_DIALOG, { kind: "cannotSign", code: viewOnly.code, params: viewOnly.params || {} });
    return false;
  }

  // 1. a signed document with edits that are not in any file yet
  let mode = store.pristineSourceId() ? "original" : "rebuild";
  const before = store.getState();
  const used = sourcesInUse(before);
  const signatureCount = used.reduce((sum, source) => sum + (source.signatureCount || 0), 0);
  if (mode === "rebuild" && signatureCount > 0) {
    const canKeep = used.length === 1 && Boolean(store.getSourceBytes(used[0].id));
    const choice = await ui.showDialog(SIGN_CHOICE_DIALOG, { kind: "signedWithEdits", signatureCount, changes: store.getHistoryState().undoDepth, canKeep });
    if (choice === "keep" && canKeep) {
      // "Add my signature only": the file as it was opened, without the edits
      const [source] = used;
      const item = { name: source.name || before.fileName, bytes: store.getSourceBytes(source.id).slice() };
      const password = store.getSourcePassword(source.id);
      if (typeof password === "string") item.password = password;
      const opened = await actions.replaceDocument([item], { resetHistory: true });
      if (!opened || !store.pristineSourceId()) return false;
      mode = "original";
    } else if (choice !== "apply") {
      return false;
    }
  }

  // 2. the file itself gets the signature: can it?
  let rebuildReason = null;
  let notes = [];
  let canCertify = true;
  let existingSignatures = 0;
  const pristineId = mode === "original" ? store.pristineSourceId() : null;
  if (pristineId) {
    let facts;
    try {
      facts = await actions.runJob({ titleKey: tk("Checking the document…") }, async () => (await editor.loadSigning()).inspectPdf(store.getSourceBytes(pristineId)));
    } catch (error) {
      actions.reportError(error);
      return false;
    }
    if (facts.blockers.includes("SIGN_NO_WEBCRYPTO")) {
      await ui.showDialog(SIGN_CHOICE_DIALOG, { kind: "insecure" });
      return false;
    }
    const blocker = facts.findings.find((finding) => finding.blocking);
    if (blocker) {
      const kind = blocker.code === "SIGN_CERTIFIED_NO_CHANGES" ? "locked" : "rewrite";
      const go = await ui.showDialog(SIGN_CHOICE_DIALOG, { kind, code: blocker.code, params: blocker.params || {}, signatureCount });
      if (go !== "rewrite") return false;
      mode = "rebuild";
      rebuildReason = { code: blocker.code, params: blocker.params || {} };
    } else {
      notes = facts.findings.filter((finding) => !finding.blocking).map((finding) => ({ code: finding.code, params: finding.params || {} }));
      canCertify = Boolean(facts.canCertify);
      existingSignatures = facts.signatureCount || 0;
    }
  }

  // 3. the drawer
  const state = store.getState();
  if (!state.pages.length) return false;
  stampPicture = remembered?.picture || null;
  patchBag(ui, {
    flow: {
      step: 1,
      mode, // "original": the file as it is gets one more signature | "rebuild": a rewritten copy is signed
      rebuildReason, // { code, params }: why the original cannot be signed as it is
      notes, // what inspectPdf() noted about the file: [{ code, params }]
      canCertify,
      existingSignatures,
      visible: remembered?.visible ?? true,
      layout: remembered?.layout || "imageAndDetails",
      show: { ...DEFAULT_SHOW, ...(remembered?.show || {}) },
      reason: remembered?.reason || "",
      location: remembered?.location || "",
      pictureVersion: 0,
      field: null, // { pageId, rect } in user space
      positioning: false,
      lock: false,
      fileName: outputBaseName({ fileName: state.fileName, purpose: "sign" }),
      run: null // { stage: 1 | 2 | 3, failed, message }: the last signing attempt
    }
  });
  ui.openDrawer(DRAWER_ID, {});
  return true;
}

// --- steps ------------------------------------------------------------------------------------------------------------

function enterPositioning(editor) {
  const { ui } = editor;
  if (!pseudoObjects.has(editor)) pseudoObjects.set(editor, ui.registerPseudoObject(SIGNATURE_FIELD_ID, SIGNATURE_FIELD_TYPE));
  if (flowOf(editor)?.field) {
    ui.runInteraction({ type: "tool", tool: "select" });
    ui.runInteraction({ type: "setSelection", ids: [SIGNATURE_FIELD_ID] });
  } else {
    ui.runInteraction({ type: "tool", tool: "certSign" });
  }
}

function leavePositioning(editor) {
  const { ui } = editor;
  const { tool, selection } = ui.getState().interaction;
  if (tool === "certSign") ui.runInteraction({ type: "tool", tool: "select" });
  else if (selection.includes(SIGNATURE_FIELD_ID)) ui.runInteraction({ type: "setSelection", ids: selection.filter((id) => id !== SIGNATURE_FIELD_ID) });
  pseudoObjects.get(editor)?.();
  pseudoObjects.delete(editor);
}

/** Goes to a step. An invisible signature has no position step. */
export function setStep(editor, wanted) {
  const flow = flowOf(editor);
  if (!flow) return;
  let step = Math.min(4, Math.max(1, wanted));
  if (step === 3 && !flow.visible) step = wanted > flow.step ? 4 : 2;
  if (step === 3) enterPositioning(editor);
  else if (flow.positioning) leavePositioning(editor);
  patchFlow(editor, { step, positioning: step === 3, run: null });
}

/** Changes settings of the flow (appearance, reason, lock, file name ...) and remembers the appearance for the next signature. */
export function updateFlow(editor, patch) {
  const flow = flowOf(editor);
  if (!flow) return;
  patchFlow(editor, { ...patch, run: null });
  const next = flowOf(editor);
  remembered = { visible: next.visible, layout: next.layout, show: next.show, reason: next.reason, location: next.location, picture: stampPicture };
}

/** Cancel (or the document went away): nothing of the flow stays. The identity stays until it is forgotten. */
export function closeFlow(editor) {
  const flow = flowOf(editor);
  if (flow?.positioning || pseudoObjects.has(editor)) leavePositioning(editor);
  remembered = flow ? { visible: flow.visible, layout: flow.layout, show: flow.show, reason: flow.reason, location: flow.location, picture: stampPicture } : remembered;
  stampPicture = null;
  if (flow) patchBag(editor.ui, { flow: null });
  if (editor.ui.getState().drawer?.id === DRAWER_ID) editor.ui.closeDrawer();
}

/** "Forget this certificate" also forgets what the last stamp looked like. */
export function forgetAppearance() {
  remembered = null;
}

// --- the signature rectangle ------------------------------------------------------------------------------------------

function setField(editor, field) {
  patchFlow(editor, { field, run: null });
  if (!field) return;
  const { ui } = editor;
  // the rectangle exists: back to Select with it selected, so that it can be moved and resized at once
  if (ui.getState().interaction.tool === "certSign") ui.runInteraction({ type: "tool", tool: "select" });
  if (!ui.getState().interaction.selection.includes(SIGNATURE_FIELD_ID)) ui.runInteraction({ type: "setSelection", ids: [SIGNATURE_FIELD_ID] });
}

/**
 * The effect executor of the signing feature: the effects of the interaction reducer that concern the
 * signature rectangle. Everything else is left to the overlay and the kernel.
 */
export function runSigningEffects(editor, effects) {
  const flow = flowOf(editor);
  if (!flow?.positioning) return;
  const pages = editor.store.getState().pages;
  const scale = scaleOf(editor);
  for (const effect of effects || []) {
    const current = flowOf(editor);
    if (!current) return;
    if (effect.type === "create" && effect.tool === "certSign") {
      const page = pages.find((candidate) => candidate.id === effect.pageId);
      const field = page ? fieldFromCreateEffect(effect, page, scale(page.id)) : null;
      if (field) patchFlow(editor, { field, run: null });
    } else if (effect.type === "move" && effect.ids?.includes(SIGNATURE_FIELD_ID) && current.field) {
      patchFlow(editor, { field: fieldAfterMove(current.field, effect, { pages, scaleOf: scale }), run: null });
    } else if (effect.type === "resize" && effect.id === SIGNATURE_FIELD_ID && current.field) {
      const page = pages.find((candidate) => candidate.id === current.field.pageId);
      patchFlow(editor, { field: fieldAfterResize(current.field, effect, page, page ? scale(page.id) : 1), run: null });
    } else if (effect.type === "delete" && effect.ids?.includes(SIGNATURE_FIELD_ID)) {
      patchFlow(editor, { field: null, run: null });
      editor.ui.runInteraction({ type: "tool", tool: "certSign" });
    }
  }
}

/** Removes the rectangle: in the position step the next drag draws a new one. */
export function clearField(editor) {
  const flow = flowOf(editor);
  if (!flow) return;
  patchFlow(editor, { field: null, run: null });
  if (flow.positioning) editor.ui.runInteraction({ type: "tool", tool: "certSign" });
}

/** A preset position on a page: "bottomRight" | "bottomLeft" | "topRight". The size of an existing rectangle is kept. */
export function applyPreset(editor, pageId, preset) {
  const flow = flowOf(editor);
  const pages = editor.store.getState().pages;
  const page = pages.find((candidate) => candidate.id === pageId);
  if (!flow || !page) return false;
  const old = flow.field ? pages.find((candidate) => candidate.id === flow.field.pageId) : null;
  const box = old ? fieldScreenBox(flow.field, old) : null;
  setField(editor, presetField(page, preset, box ? [box.width, box.height] : FIELD_DEFAULT_SIZE));
  editor.viewer.scrollToPage(page.id, { rect: flowOf(editor).field.rect, align: "center" });
  return true;
}

/** The numbers of the position form (millimetres from the top-left corner of the visible page). */
export function setFieldMillimetres(editor, patch) {
  const flow = flowOf(editor);
  const page = flow?.field ? editor.store.getState().pages.find((candidate) => candidate.id === flow.field.pageId) : null;
  if (!page) return false;
  setField(editor, fieldWithMillimetres(flow.field, page, patch));
  return true;
}

/** Arrow keys on the selected rectangle: moves it by `distance` points as seen on screen. */
export function nudgeField(editor, key, distance) {
  const flow = flowOf(editor);
  const page = flow?.field ? editor.store.getState().pages.find((candidate) => candidate.id === flow.field.pageId) : null;
  const unit = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
  if (!page || !unit || !flow.positioning) return false;
  const box = fieldScreenBox(flow.field, page);
  patchFlow(editor, { field: fieldFromBox(page, { ...box, left: box.left + unit[0] * distance, top: box.top + unit[1] * distance }), run: null });
  return true;
}

// --- the stamp ----------------------------------------------------------------------------------------------------------

/**
 * The moment of a signature as the stamp writes it: the date first (dd/mm/yyyy in Vietnamese, the order of
 * the locale in English), then the time with seconds and the offset from UTC: "20/11/2026 14:03:05 GMT+7".
 */
export function formatSigningTime(date, language = getLanguage()) {
  try {
    const locale = localeOf(language);
    const day = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    const parts = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "shortOffset" }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
    const hour = part("hour") === "24" ? "00" : part("hour");
    return `${day} ${hour}:${part("minute")}:${part("second")} ${part("timeZoneName")}`.trim();
  } catch {
    return formatDateTime(date, language);
  }
}

/** The values of the details of a stamp for an identity and a flow. */
export function stampValues(identity, flow, signingTime = new Date()) {
  const subject = identity?.facts?.subject || {};
  return {
    name: subject.commonName || identity?.facts?.displayName || "",
    date: formatSigningTime(signingTime),
    reason: String(flow.reason || "").trim(),
    location: String(flow.location || "").trim(),
    organisation: subject.organization || ""
  };
}

/** The lines the stamp of this flow shows. */
export function stampLines(identity, flow, signingTime) {
  return detailLines({ show: flow.show, values: stampValues(identity, flow, signingTime), t });
}

/** Why step 2 cannot go on with a visible signature: "empty" (the stamp would show nothing) or null. */
export function stampProblem(identity, flow) {
  if (!flow.visible) return null;
  return appearanceIsEmpty({ layout: flow.layout, hasImage: Boolean(stampPicture), lines: stampLines(identity, flow) }) ? "empty" : null;
}

/**
 * Paints the stamp of the flow for a rectangle of `width` x `height` points.
 * @returns {Promise<{ png, dataUrl, width, height, empty, clipped }>}
 */
export function renderStamp(editor, { width, height, signingTime } = {}) {
  const flow = flowOf(editor);
  return renderAppearance({
    fonts: editor.fonts,
    width: width || FIELD_DEFAULT_SIZE[0],
    height: height || FIELD_DEFAULT_SIZE[1],
    layout: flow.layout,
    picture: flow.layout === "detailsOnly" ? null : stampPicture,
    lines: flow.layout === "imageOnly" ? [] : stampLines(getIdentity(), flow, signingTime)
  });
}

// --- signing ------------------------------------------------------------------------------------------------------------

const FAILED_CHECK = tk("The new signature did not pass the check, so nothing was downloaded. Your document is unchanged.");
const FAILED_BUILD = tk("The document could not be prepared, so nothing was signed. Your document is unchanged.");
const POSITION_LOST = tk("The page of the signature position is no longer in the document. Choose the position again.");

class FlowStop extends Error {
  constructor(text) {
    super("the signing flow stopped");
    this.text = text;
  }
}

/**
 * Step 4, "Sign and download".
 * @returns {Promise<boolean>} true when the signed file was downloaded and reopened
 */
export async function signNow(editor) {
  const { actions, store, ui, messages } = editor;
  const flow = flowOf(editor);
  const signer = getSigner();
  const identity = getIdentity();
  // (a document that became view-only while the drawer was open, e.g. another file was opened, is not signed)
  if (!flow || !signer || !identity || identity.block || ui.getState().job || ui.getState().flags.viewOnly) return false;

  let place = null;
  if (flow.visible) {
    place = fieldForEngine(flow.field, store.getState().pages);
    if (!place) {
      patchFlow(editor, { field: null });
      setStep(editor, 3);
      patchFlow(editor, { run: { stage: 0, failed: true, message: t(POSITION_LOST) } });
      return false;
    }
  }
  const fileName = pdfFileName(flow.fileName || outputBaseName({ fileName: store.getState().fileName, purpose: "sign" }));
  let stage = 1;
  let aborted = () => false;
  const enter = (number, describe) => {
    stage = number;
    patchFlow(editor, { run: { stage: number, failed: false, message: "" } });
    describe(t(SIGN_STAGES[number - 1]));
  };

  let result;
  try {
    result = await actions.runJob({ titleKey: tk("Signing the document…"), cancellable: true }, async ({ signal, progress, describe }) => {
      aborted = () => signal.aborted;
      // --- 1. applying edits (or taking the file as it is)
      enter(1, describe);
      const request = { purpose: "sign", report: "defer", options: { signal, onProgress: (fraction, code) => progress(fraction * 0.6, code) } };
      // the original cannot take a signature as it is: a rewritten copy of all pages is built
      if (flow.rebuildReason && store.pristineSourceId()) request.pageIds = store.getState().pages.map((page) => page.id);
      const output = await actions.buildOutput(request);
      if (!output) throw new FlowStop(signal.aborted ? "" : t(FAILED_BUILD));
      throwIfAborted(signal);

      // --- 2. signing
      enter(2, describe);
      progress(0.65, null);
      const signingTime = new Date();
      const options = { signer, signingTime, signal };
      const name = identity.facts?.subject?.commonName || identity.facts?.displayName || "";
      if (name) options.name = name;
      if (flow.reason.trim()) options.reason = flow.reason.trim();
      if (flow.location.trim()) options.location = flow.location.trim();
      // "Lock document after signing": a certification that allows no changes; only a document without signatures can be certified
      if (flow.lock && (!output.original || flow.canCertify)) options.certify = 1;
      if (place) {
        // the stamp is painted for the rectangle as the reader sees it (the engine turns it upright on a turned page)
        const box = fieldScreenBox(flow.field, store.getState().pages[place.pageIndex]);
        const stamp = await renderStamp(editor, { width: box.width, height: box.height, signingTime });
        options.appearance = { pageIndex: place.pageIndex, rect: place.rect, png: stamp.png };
      }
      const pipeline = await editor.loadPipeline();
      throwIfAborted(signal);
      const signed = await pipeline.signOutput(output.bytes, options);
      throwIfAborted(signal);

      // --- 3. checking the signature: what is about to be downloaded is read back
      enter(3, describe);
      progress(0.85, null);
      const check = await pipeline.verifySigned(signed.bytes, { fieldName: signed.report.fieldName, trustedCertificates: getTrustList().certificates(), signal });
      if (!check.ok) throw new FlowStop(t(FAILED_CHECK));
      progress(1, null);
      return { output, signed, check };
    });
  } catch (error) {
    if (aborted() || messages.isSilent(error)) {
      patchFlow(editor, { run: null });
      return false;
    }
    const message = error instanceof FlowStop ? error.text : isPdfEditorError(error) ? messages.describeError(error) : messages.describeCode("SIGN_INTERNAL", { check: "unexpected" });
    patchFlow(editor, { run: message ? { stage, failed: true, message } : null });
    return false;
  }

  // --- delivered: the download, then the signed file as the working document
  const { output, signed, check } = result;
  actions.saveBytes(signed.bytes, fileName);
  const opened = await actions.replaceDocument([{ name: fileName, bytes: signed.bytes }], { resetHistory: true });
  closeFlow(editor);
  const sourceId = opened?.opened?.[0]?.sourceId;
  if (!sourceId) {
    actions.toast(t("Signed. The signed file was downloaded, but it could not be reopened here."), { tone: "warning", duration: 9000 });
    return true;
  }
  seedReport(editor, sourceId, check.report);
  ui.setFlags({ savedAs: "signed" });
  actions.openLeftPanel(PANEL_ID);
  actions.toast(t("Signed. The signed file was downloaded and reopened. Any further edit will invalidate the signature."), { tone: "success", duration: 9000 });
  const shown = output.showReport?.({ fileName, purpose: "sign" });
  // what the signer noted (a form that redraws its fields, a certified document ...) is never dropped
  const warnings = signed.report?.warnings || [];
  if (warnings.length && !shown) actions.reportWarnings(warnings, { purpose: "sign" });
  else for (const warning of warnings) ui.addNotice({ tone: "warning", code: warning.code, params: warning.params || {} });
  return true;
}
