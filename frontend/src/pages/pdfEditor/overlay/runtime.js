// The working memory of the overlay feature for ONE editor: everything between the pure pieces (the interaction
// reducer, the gesture maths, the store) and the components.
//
//   const runtime = getRuntime(editor);      // created on first use, kept for the life of the editor
//
// What lives here
//   * the effect executor: every effect of tools/interaction.js becomes a store command (model/gestures.js
//     runEffect), a text editing session, a picker, a menu
//   * text editing: ONE session at a time. A new box (or the box that replaces a line of the document) is a
//     DRAFT kept in the feature bag until its first commit; an existing box is updated once when its session
//     ends. The session ends through the reducer ("commitEdit" / "discardEdit"): the editor component reports
//     Escape, Ctrl+Enter, Tab and blur with endEditing(), a press elsewhere reaches the reducer directly.
//   * pictures: file picker, drop, paste; blob URLs for the assets on screen
//   * the clipboard: objects through model/clipboard.js, marked on the system clipboard so that a later copy
//     made elsewhere wins
//   * caches of what the viewer knows about a page: its text lines, the rectangles of its annotations
//   * the slice of the UI state one page overlay renders from (pageSlice): a gesture on one page never
//     re-renders the overlays of the others
//
// The feature bag (ui.getState().features.overlay, read with useFeatureState("overlay")):
//   draft         null | the text object that is being typed for the first time (id NEW_ID)
//   liveText      null | the text in the open editor (what the properties panel checks against the fonts)
//   hover         null | { pageId, kind: "line", index } | { pageId, kind: "erase", id }
//   menu          null | { menu: "object" | "page" | "text", clientX, clientY, pageId, at: [x, y], ids }
//   recentColors  the colours used last, newest first (at most five)
//   keepRatio     the "keep aspect ratio" switch of the size fields
//   unit          "mm" | "pt": the unit of the position and size fields
//   showMarks     true while the list of pending marks is asked for (the counter of the status bar)
//   linesVersion, annotationsVersion   grow when text lines / annotations of a page arrive
import { t } from "../../../i18n/index.js";
import { rectsIntersect, resizeFrame } from "../engine/geometry.js";
import { clipboard } from "../model/clipboard.js";
import { runEffect } from "../model/gestures.js";
import { createId, isMark, normalizeColor, objectBounds } from "../model/schema.js";
import { alignObjects, createObjectsOfPageSelector, objectsInRect, pendingMarks } from "../model/selectors.js";
import { pageScreen } from "../model/shapes.js";
import { createFromEffect, createImage, createMark, createReplacementText, createTextBox, createTextHighlight, nudgeObjects, objectTypeOfKind, rectFromPixels, sanitizeStyle, styleKeysOf, styleUpdates } from "../model/transform.js";
import { frameForLayout, isBlankText, normalizeText } from "../text/index.js";
import { NEW_ID } from "../tools/interaction.js";
import { pixelsToUser } from "./geometry.js";
import { IMAGE_UNSUPPORTED, prepareImage } from "./imageImport.js";
import { looksLikeImage } from "./imageRules.js";
import { createMarkReach } from "./markReach.js";
import { NO_PREVIEW, gesturePreview, previewTouches } from "./preview.js";
import { frameOnBaseline, quadBounds, replacementStyle, textDragQuads } from "./textPick.js";

export const FEATURE_ID = "overlay";
export const MAX_RECENT_COLORS = 5;
const RECENT_COLORS_KEY = "pdfx.recentColors.v1";
/** The format of the mark an object copy leaves on the system clipboard. */
const CLIPBOARD_MARK = "application/x-pdfx-objects";
/** What a tool edits in the properties panel while nothing is selected: tool id -> creation kind. */
const TOOL_KINDS = Object.freeze({ text: "text", rect: "rect", ellipse: "ellipse", line: "line", arrow: "arrow", pen: "pen", highlighter: "highlighter", redact: "redact", blur: "blur" });
const TEXT_TOOLS = Object.freeze(["editText", "redact", "highlighter"]);
const FONT_KEYS = Object.freeze(["font", "bold", "italic"]);
/** A press on the properties panel explains a text box losing the focus within this time (milliseconds). */
const PANEL_PRESS_MEMORY = 800;

const EMPTY_BAG = Object.freeze({ draft: null, liveText: null, hover: null, menu: null, recentColors: Object.freeze([]), keepRatio: true, unit: "mm", showMarks: false, linesVersion: 0, annotationsVersion: 0 });
const EMPTY_LIST = Object.freeze([]);

const runtimes = new WeakMap();

/** The creation kind whose defaults a tool edits, or null for a tool without settings. */
export const toolKindOf = (tool) => TOOL_KINDS[tool] || null;

/** The runtime of an editor (created on first use). */
export function getRuntime(editor) {
  let runtime = runtimes.get(editor);
  if (!runtime) {
    runtime = createRuntime(editor);
    runtimes.set(editor, runtime);
  }
  return runtime;
}

function readRecentColors() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(RECENT_COLORS_KEY) || "[]");
    return Array.isArray(raw) ? raw.map(normalizeColor).filter(Boolean).slice(0, MAX_RECENT_COLORS) : [];
  } catch {
    return [];
  }
}

const sameList = (a, b) => a === b || (a.length === b.length && a.every((value, index) => value === b[index]));

function createRuntime(editor) {
  const { store, ui, viewer, actions, textService } = editor;
  const lines = new Map(); // pageId -> { ready, lines }
  const annotations = new Map(); // "sourceId:index" -> { ready, list: [{ subtype, rect }] }
  const urls = new Map(); // assetId -> blob URL
  const assetNotes = new Map(); // assetId -> { scaled }
  const slices = new Map(); // pageId -> the slice its overlay rendered from
  let session = null; // { id, pageId, base, isNew, text, done }
  let editorHandle = null; // the ref of the mounted TextEditor
  let origin = null; // where the running gesture began: { pageId, onText }
  let imageInput = null;
  let imagePurpose = null; // null = place a new picture | { replace: objectId }
  let contextPoint = null; // client position of the last context-menu request
  let dragPoint = null; // client position of the last file drag over the pages
  let clipboardToken = null;
  let clipboardLocal = false; // the last object copy could not mark the system clipboard
  let pendingCopy = null;
  let previewKey = null;
  let previewValue = NO_PREVIEW;
  let limitsShown = false;
  let panelPressedAt = 0;
  let waitingAsset = null; // the picture of the Image tool between its picker and its place on a page

  const scaleOf = () => viewer.getScale() || 1;
  const selectObjects = createObjectsOfPageSelector();
  // What a pending mark will take from its page (the redaction engine's own dry run). The engine brings the PDF
  // library with it, so it is loaded when the first mark asks; it reads the store's own byte array and keeps
  // nothing but the parsed document of that array.
  const markReach = createMarkReach({
    loadEngine: () => import("../engine/redact/index.js"),
    bytesOf: (sourceId) => store.getSourceBytes(sourceId),
    passwordOf: (sourceId) => store.getSourcePassword(sourceId)
  });
  const bag = () => ui.getState().features[FEATURE_ID] || EMPTY_BAG;
  const pageOf = (pageId) => store.getState().pages.find((page) => page.id === pageId) || null;
  const interaction = () => ui.getState().interaction;

  function setBag(patch) {
    ui.setFeatureState(FEATURE_ID, (previous) => {
      const base = previous || EMPTY_BAG;
      const change = typeof patch === "function" ? patch(base) : patch;
      for (const key of Object.keys(change)) {
        if (change[key] !== base[key]) return Object.freeze({ ...base, ...change });
      }
      return previous;
    });
  }

  // the colours of an earlier visit
  const remembered = readRecentColors();
  if (remembered.length) setBag({ recentColors: Object.freeze(remembered) });

  // --- selection --------------------------------------------------------------------------------------------

  const selectedIds = () => interaction().selection.filter((id) => store.getState().objects[id]);

  /** Selects objects (and goes back to the Select tool when another one is active and `keepTool` is not set). */
  function select(ids, { keepTool = false } = {}) {
    if (!keepTool && interaction().tool !== "select") ui.runInteraction({ type: "tool", tool: "select" });
    ui.runInteraction({ type: "setSelection", ids });
  }

  function currentPage() {
    const { pages } = store.getState();
    const { currentPageId } = viewer.getSnapshot();
    return pages.find((page) => page.id === currentPageId) || pages[0] || null;
  }

  const pageCentre = (page) => {
    const screen = pageScreen(page);
    return screen.toUser([screen.width / 2, screen.height / 2]);
  };

  // --- text lines and annotations of the pages ----------------------------------------------------------------

  /** The text lines of a page when they are known; otherwise null (they are being fetched). */
  function linesNow(pageId) {
    const entry = lines.get(pageId);
    if (entry) return entry.ready ? entry.lines : null;
    const record = { ready: false, lines: EMPTY_LIST };
    lines.set(pageId, record);
    let request;
    try {
      request = viewer.getTextLines(pageId);
    } catch {
      record.ready = true; // a page the viewer does not know has no text
      return record.lines;
    }
    request.then(
      (found) => {
        record.lines = found;
        record.ready = true;
        if (lines.get(pageId) === record) setBag((current) => ({ linesVersion: current.linesVersion + 1 }));
      },
      () => {
        record.ready = true;
      }
    );
    return null;
  }

  /** The rectangles of the annotations a viewer paints over a source page (not links, not hidden ones). */
  function annotationsNow(page) {
    if (!page || page.kind !== "pdf") return EMPTY_LIST;
    const key = `${page.sourceId}:${page.sourceIndex}`;
    const entry = annotations.get(key);
    if (entry) return entry.ready ? entry.list : null;
    const record = { ready: false, list: EMPTY_LIST };
    annotations.set(key, record);
    const done = (list) => {
      record.list = list;
      record.ready = true;
      if (annotations.get(key) === record && list.length) setBag((current) => ({ annotationsVersion: current.annotationsVersion + 1 }));
    };
    const pdf = viewer.getPdfDocument(page.sourceId);
    if (!pdf) {
      annotations.delete(key); // the source is not open yet: ask again later
      return null;
    }
    pdf
      .getPage(page.sourceIndex + 1)
      .then((pdfPage) => pdfPage.getAnnotations())
      .then(
        (found) =>
          done(
            (found || [])
              .filter((annotation) => annotation && annotation.subtype !== "Link" && annotation.subtype !== "Popup" && !(annotation.annotationFlags & 0x22) && Array.isArray(annotation.rect) && annotation.rect.length === 4)
              .map((annotation) => ({ subtype: String(annotation.subtype || ""), rect: [Math.min(annotation.rect[0], annotation.rect[2]), Math.min(annotation.rect[1], annotation.rect[3]), Math.max(annotation.rect[0], annotation.rect[2]), Math.max(annotation.rect[1], annotation.rect[3])] }))
          ),
        () => done(EMPTY_LIST)
      );
    return null;
  }

  /**
   * The annotation of the source page an object lies over, or null. The export draws the object INTO the page
   * content, where every viewer paints annotations above it: on screen it is the other way round.
   */
  function annotationUnder(object, page) {
    const list = annotationsNow(page);
    if (!list || !list.length || isMark(object)) return null;
    const bounds = objectBounds(object, page.userUnit || 1);
    return list.find((annotation) => rectsIntersect(bounds, annotation.rect)) || null;
  }

  // --- pictures ---------------------------------------------------------------------------------------------

  /** A blob URL for an asset on screen (made once per asset, revoked when the asset leaves the document). */
  function assetUrl(assetId) {
    const known = urls.get(assetId);
    if (known) return known;
    const bytes = store.getAssetBytes(assetId);
    const asset = store.getState().assets[assetId];
    if (!bytes || !asset) return null;
    const url = URL.createObjectURL(new Blob([bytes], { type: asset.mime }));
    urls.set(assetId, url);
    return url;
  }

  function releaseUrls(all = false) {
    const { assets } = store.getState();
    for (const [assetId, url] of urls) {
      if (!all && assets[assetId]) continue;
      URL.revokeObjectURL(url);
      urls.delete(assetId);
      assetNotes.delete(assetId);
    }
  }

  /**
   * Makes a picture file an asset of the document.
   * @returns {Promise<string | null>} the asset id; null when the picture cannot be used (the user was told)
   */
  async function importImage(blob) {
    try {
      const picture = await prepareImage(blob);
      const assetId = store.addAsset({ mime: picture.mime, width: picture.width, height: picture.height }, picture.bytes);
      if (picture.scaled) assetNotes.set(assetId, { scaled: true });
      return assetId;
    } catch (error) {
      if (error?.code === IMAGE_UNSUPPORTED) actions.hint("unsupportedImage", t("This image type is not supported. Use PNG, JPEG, WebP, GIF, BMP or SVG."), "error");
      else actions.reportError(error);
      return null;
    }
  }

  /** Puts a picture on a page at once (a drop, a paste): `at` in the user space of the page, default its middle. */
  function placeImage(assetId, pageId, at = null) {
    const page = pageOf(pageId);
    const asset = store.getState().assets[assetId];
    if (!page || !asset) return [];
    const object = createImage(page, asset, { at: at || pageCentre(page) }, { role: "image", style: ui.getToolStyle("image") });
    if (!object) return [];
    const ids = store.addObjects([object]);
    select(ids);
    return ids;
  }

  /** Imports picture files and puts the first usable one on a page. @returns {Promise<boolean>} */
  async function addImageFiles(files, { pageId = null, at = null } = {}) {
    const pictures = [...(files || [])].filter(looksLikeImage);
    if (!pictures.length) return false;
    if (!(await actions.beforeEdit())) return false;
    let placed = false;
    let offset = 0;
    for (const file of pictures) {
      const assetId = await importImage(file);
      if (!assetId) continue;
      const page = pageOf(pageId) || currentPage();
      if (!page) break;
      const point = at || pageCentre(page);
      // several pictures at once: each a little further down-right, so that none hides another
      const shifted = pageScreen(page).deltaToUser([offset, offset]);
      placeImage(assetId, page.id, [point[0] + shifted[0], point[1] + shifted[1]]);
      offset += 12;
      placed = true;
    }
    return placed;
  }

  function setImageInput(element) {
    imageInput = element || null;
  }

  /** Opens the file picker of the Image tool (or of "Replace image"). */
  function openImagePicker(purpose = null) {
    if (!imageInput) return false;
    imagePurpose = purpose;
    imageInput.value = "";
    imageInput.click();
    return true;
  }

  /** The file picker answered: a picture to place with the pointer, or the new picture of an object. */
  async function imagePicked(files) {
    const purpose = imagePurpose;
    imagePurpose = null;
    const [file] = [...(files || [])];
    if (!file) {
      imagePickCancelled(purpose);
      return;
    }
    const assetId = await importImage(file);
    if (purpose?.replace) {
      const object = store.getState().objects[purpose.replace];
      const asset = store.getState().assets[assetId];
      if (!assetId || !object || object.type !== "image" || !asset) return;
      // the box keeps its width and its top-left corner and takes the proportions of the new picture
      const height = (object.frame.w * asset.height) / asset.width;
      const page = pageOf(object.pageId);
      const frame = frameForSize(object.frame, object.frame.w, height, page?.userUnit || 1);
      store.updateObjects([{ id: object.id, patch: { assetId, frame } }]);
      return;
    }
    if (!assetId) {
      imagePickCancelled(purpose);
      return;
    }
    const now = interaction();
    if (now.tool === "image" || now.tool === "signature") {
      waitingAsset = assetId;
      ui.runInteraction({ type: "placeReady", payload: assetId });
    } else {
      store.discardAsset(assetId);
    }
  }

  function imagePickCancelled(purpose) {
    if (purpose?.replace) return;
    const now = interaction();
    // nothing to place: the tool has nothing to do
    if (now.tool === "image" && now.mode === "idle") ui.runInteraction({ type: "tool", tool: "select" });
  }

  /** A frame of another size whose top-left corner (as the box sees itself) stays in place. */
  const frameForSize = (frame, w, h, userUnit) => resizeFrame(frame, w, h, [0, 0], userUnit);

  const assetNote = (assetId) => assetNotes.get(assetId) || null;

  // --- text editing -----------------------------------------------------------------------------------------

  function withFonts(textObject, command, otherwise) {
    const run = () => {
      try {
        command();
      } catch (error) {
        actions.reportError(error);
        otherwise?.();
      }
    };
    let ready;
    try {
      ready = textService.isReady(textObject);
    } catch {
      ready = false;
    }
    if (ready) {
      run();
      return;
    }
    actions.ensureFonts(textObject).then((ok) => {
      if (ok) run();
      else otherwise?.();
    });
  }

  const answerCreated = (ids) => ui.runInteraction({ type: "created", ids });

  /**
   * "created" for a text box that left its draft state. When the next draft is open already (Edit text: a
   * press on another line commits this box and opens that line in the same event; or the fonts of this box
   * arrived late) the answer must not reach the reducer: it would take these ids for the box that is being
   * typed now. Nothing waits for the answer then: opening a draft cleared the selection.
   */
  const answerTextCreated = (ids) => {
    if (interaction().editingId !== NEW_ID) answerCreated(ids);
  };

  function startSession(next) {
    session = { ...next, text: next.base.text, done: false };
    editorHandle = null;
  }

  function endSession() {
    session = null;
    editorHandle = null;
    setBag({ draft: null, liveText: null });
    // the editor element is gone: give the keyboard back to the pages unless the user put it elsewhere
    setTimeout(() => {
      if (typeof document === "undefined") return;
      const active = document.activeElement;
      if (!active || active === document.body) viewer.getContainer()?.focus({ preventScroll: true });
    }, 0);
  }

  /** The text in the open editor (the last text it reported when its element is gone). */
  function currentText() {
    if (!session) return "";
    if (editorHandle?.element) return normalizeText(editorHandle.getText());
    return session.text;
  }

  /**
   * The `empty` flag of an event that ends text editing: the box holds nothing worth keeping. That is a blank
   * text, and a line of the document that was opened with Edit text and left exactly as it was.
   */
  function editingEmpty() {
    if (!session || session.done) return false;
    const text = currentText();
    if (isBlankText(text)) return true;
    return Boolean(session.isNew && session.base.replaces && text === session.base.replaces.sourceText);
  }

  /** The Text tool was used on a page: a draft box opens for typing. */
  function beginNewText(effect) {
    const page = pageOf(effect.pageId);
    const draft = page ? createFromEffect(effect, page, scaleOf(), { style: ui.getToolStyle("text"), content: "" }) : null;
    if (!draft) {
      answerCreated([]);
      return;
    }
    startSession({ id: NEW_ID, pageId: page.id, base: draft, isNew: true });
    setBag({ draft: Object.freeze({ ...draft, id: NEW_ID }), liveText: "" });
  }

  /** Edit text: a line of the document becomes a draft box with the same words, the nearest bundled font and its colours. */
  function beginReplaceLine(effect) {
    const page = pageOf(effect.pageId);
    const line = (linesNow(effect.pageId) || [])[effect.lineId];
    if (!page || !line) {
      answerCreated([]);
      return;
    }
    const text = normalizeText(line.text);
    // the session exists at once (the reducer is in editing mode already); its box appears when the colours
    // of the line and the fonts are there
    startSession({ id: NEW_ID, pageId: page.id, base: { text, replaces: { rect: line.rect, cover: null, sourceText: text } }, isNew: true, pending: true });
    const mine = session;
    const build = (colours) => {
      if (session !== mine) return;
      const style = replacementStyle(line, colours?.found ? colours : null);
      const draft = createReplacementText(page, { rect: line.rect, text, angle: line.angle, cover: colours?.background ?? null }, style);
      const show = () => {
        if (session !== mine) return;
        let placed = draft;
        try {
          const layout = textService.layout(draft);
          const sized = { ...draft, frame: { ...draft.frame, w: layout.width, h: layout.height } };
          placed = { ...sized, frame: frameOnBaseline(sized.frame, [line.baseline[0], line.baseline[1]], layout.lines[0], page.userUnit || 1) };
        } catch {
          // without a layout the box starts at the corner of the line: close enough to type in
        }
        mine.base = placed;
        mine.pending = false;
        setBag({ draft: Object.freeze({ ...placed, id: NEW_ID }), liveText: text });
      };
      actions.ensureFonts(draft).then(show);
    };
    viewer.sampleColors(page.id, line.rect).then(build, () => build(null));
    if (!limitsShown) {
      limitsShown = true;
      actions.hint("editTextLimits", t("Edit text replaces one line at a time. The text after it does not move, and the replacement uses the bundled font nearest to the original."));
    }
  }

  function beginEdit(id) {
    const object = store.getState().objects[id];
    if (object?.type !== "text") return;
    startSession({ id, pageId: object.pageId, base: object, isNew: false });
    setBag({ liveText: object.text });
  }

  function commitEdit(id) {
    const current = session;
    if (!current || current.id !== id || current.done) {
      // nothing is being typed under this id (its page went, the session ended twice): the reducer must not wait
      if (id === NEW_ID && !editingSession()) answerCreated([]);
      return;
    }
    current.done = true;
    const text = normalizeText(currentText());
    if (current.isNew) {
      const draft = bag().draft;
      endSession();
      const unchangedLine = current.base.replaces && text === current.base.replaces.sourceText;
      if (!draft || isBlankText(text) || unchangedLine) {
        answerTextCreated([]);
        return;
      }
      const object = { ...draft, text };
      delete object.id;
      withFonts(
        object,
        () => answerTextCreated(store.addObjects([object])),
        () => answerTextCreated([])
      );
      return;
    }
    endSession();
    const object = store.getState().objects[id];
    if (!object) return;
    if (isBlankText(text)) {
      store.deleteObjects([id]);
      return;
    }
    if (text === object.text) return;
    withFonts({ ...object, text }, () => store.updateObjects([{ id, patch: { text } }]));
  }

  function discardEdit(id) {
    const current = session;
    if (!current || current.id !== id) return;
    current.done = true;
    endSession();
    // an existing box that was emptied goes; a draft was never in the document
    if (!current.isNew && store.getState().objects[id]) store.deleteObjects([id]);
  }

  function cancelEdit(id) {
    if (!session || session.id !== id) return;
    session.done = true;
    endSession();
  }

  /** The editor component: its imperative handle (ref of text/TextEditor.jsx). */
  function setEditorHandle(handle) {
    editorHandle = handle || null;
  }

  function editorChanged(text, { composing } = {}) {
    if (!session || session.done) return;
    session.text = text;
    session.held = false; // typing: the box has the keyboard again
    if (!composing) setBag({ liveText: text });
  }

  /**
   * The editor ended its session itself (Escape, Ctrl+Enter, Tab, it lost the focus): tell the reducer.
   * One exception: the focus went into the properties panel (a font menu, the size field). The box is then
   * still being typed: the session is HELD until the focus leaves the panel for anything but the box
   * (releaseHeldText), a press on a page or a tool change ends it through the reducer.
   */
  function endEditing(reason) {
    if (!session || session.done) return;
    // while the box loses the focus nothing has it yet: the press on the panel that took it came just before
    if (reason === "blur" && Date.now() - panelPressedAt < PANEL_PRESS_MEMORY) {
      session.held = true;
      return;
    }
    session.held = false;
    ui.runInteraction({ type: "editorBlur", empty: editingEmpty() });
  }

  /** The properties panel was pressed (it may take the focus from the box that is being typed). */
  const panelPressed = () => {
    panelPressedAt = Date.now();
  };

  /** The focus left the properties panel: a held text session ends now, unless the focus is back in its box. */
  function releaseHeldText(backInBox = false) {
    if (!session || session.done || !session.held) return false;
    session.held = false;
    if (backInBox) return false;
    ui.runInteraction({ type: "editorBlur", empty: editingEmpty() });
    return true;
  }

  /** Puts the caret back into the box that is being typed (after a menu of the properties panel was used). */
  function focusText() {
    if (!session || session.done || !editorHandle?.element) return false;
    editorHandle.focus();
    return true;
  }

  /** Ends the open session from outside (a command, a menu) before something else needs the keyboard. */
  function commitText() {
    if (!session || session.done) return false;
    endEditing("api");
    return true;
  }

  const editingSession = () => (session && !session.done ? session : null);

  // --- styles -----------------------------------------------------------------------------------------------

  let colorTimer = null;
  /** Remembers a colour that was used. A colour picker reports every colour it passes: only where it rests counts. */
  function rememberColor(value) {
    const color = normalizeColor(value);
    if (!color) return;
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => {
      const next = [color, ...bag().recentColors.filter((entry) => entry !== color)].slice(0, MAX_RECENT_COLORS);
      if (sameList(next, bag().recentColors)) return;
      setBag({ recentColors: Object.freeze(next) });
      try {
        globalThis.localStorage?.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
      } catch {
        // no storage: the colours last for this page
      }
    }, 600);
  }

  async function updateStyle(ids, patch) {
    const state = store.getState();
    const updates = styleUpdates(state, ids, patch);
    if (!updates.length) return false;
    for (const update of updates) {
      const object = state.objects[update.id];
      if (object.type !== "text" || !FONT_KEYS.some((key) => key in update.patch)) continue;
      if (!(await actions.ensureFonts({ ...object, ...update.patch }))) return false;
    }
    try {
      // consecutive changes of one property of one selection are one undo step
      store.updateObjects(updates, { coalesceKey: `style:${Object.keys(patch).sort().join(",")}:${ids.join(",")}` });
      return true;
    } catch (error) {
      actions.reportError(error);
      return false;
    }
  }

  /**
   * Changes style properties of what the properties panel shows: the box that is being typed, else the
   * selection, else the defaults of the active tool.
   */
  async function applyStyle(patch) {
    for (const key of ["color", "stroke", "fill"]) if (typeof patch[key] === "string") rememberColor(patch[key]);
    const current = editingSession();
    if (current?.isNew) {
      const draft = bag().draft;
      if (!draft) return false;
      const clean = sanitizeStyle("text", patch);
      if (!Object.keys(clean).length) return false;
      setBag({ draft: Object.freeze({ ...draft, ...clean }) });
      // a box of the Text tool sets the style of the next one; a replaced line keeps to itself
      if (!draft.replaces) ui.setToolDefaults("text", clean);
      return true;
    }
    if (current) return updateStyle([current.id], patch);
    const ids = selectedIds();
    if (ids.length) return updateStyle(ids, patch);
    const kind = toolKindOf(interaction().tool);
    return kind ? ui.setToolDefaults(kind, patch) : false;
  }

  /** The object types the properties panel shows: [{ object }] of the draft / the selection, or the tool's kind. */
  function styleTarget() {
    const current = editingSession();
    const state = store.getState();
    if (current?.isNew) return bag().draft ? { source: "draft", objects: [bag().draft], kind: null } : { source: "none", objects: [], kind: null };
    if (current) return state.objects[current.id] ? { source: "editing", objects: [state.objects[current.id]], kind: null } : { source: "none", objects: [], kind: null };
    const ids = selectedIds();
    if (ids.length) return { source: "selection", objects: ids.map((id) => state.objects[id]), kind: null };
    const kind = toolKindOf(interaction().tool);
    return kind ? { source: "tool", objects: [], kind } : { source: "none", objects: [], kind: null };
  }

  /** Toggles a flag of the text style (Ctrl+B / I / U) or steps the font size. */
  function toggleTextStyle(key) {
    const target = styleTarget();
    const texts = target.source === "tool" ? [ui.getToolStyle("text")] : target.objects.filter((object) => object.type === "text");
    if (!texts.length || (target.source === "tool" && target.kind !== "text")) return false;
    applyStyle({ [key]: !texts.every((object) => object[key]) });
    return true;
  }

  function stepTextSize(direction) {
    const target = styleTarget();
    const texts = target.source === "tool" ? [ui.getToolStyle("text")] : target.objects.filter((object) => object.type === "text");
    if (!texts.length || (target.source === "tool" && target.kind !== "text")) return false;
    const size = texts[0].size;
    const step = size >= 36 ? 4 : size >= 18 ? 2 : 1;
    applyStyle({ size: Math.max(4, size + direction * step) });
    return true;
  }

  // --- commands on the selection ------------------------------------------------------------------------------

  function guarded(command) {
    try {
      return command();
    } catch (error) {
      actions.reportError(error);
      return null;
    }
  }

  function deleteSelection() {
    const ids = selectedIds();
    if (!ids.length) return false;
    deleteObjects(ids);
    return true;
  }

  function deleteObjects(ids) {
    const deleted = guarded(() => store.deleteObjects(ids)) || [];
    if (deleted.length) announceDeleted(deleted.length);
    return deleted;
  }

  function announceDeleted(count) {
    actions.toast(count === 1 ? t("Object deleted") : t("Objects deleted: {count}", { count }), { onUndo: () => actions.undo() });
  }

  function duplicateSelection() {
    const ids = selectedIds();
    if (!ids.length) return false;
    const copies = guarded(() => store.duplicateObjects(ids)) || [];
    if (copies.length) select(copies, { keepTool: true });
    return true;
  }

  function arrangeSelection(direction) {
    const ids = selectedIds();
    if (!ids.length) return false;
    guarded(() => store.arrange(ids, direction));
    return true;
  }

  function alignSelection(mode) {
    const ids = selectedIds();
    if (!ids.length) return false;
    const updates = alignObjects(store.getState(), ids, mode);
    if (updates.length) guarded(() => store.updateObjects(updates));
    return true;
  }

  function nudgeSelection(direction, distance) {
    const ids = selectedIds();
    if (!ids.length) return false;
    const updates = nudgeObjects(store.getState(), ids, direction, distance);
    if (updates.length) guarded(() => store.updateObjects(updates, { coalesceKey: `nudge:${ids.join(",")}` }));
    return true;
  }

  function selectAll() {
    const page = currentPage();
    if (!page) return false;
    select(page.objectIds.slice());
    return true;
  }

  /** Tab / Shift+Tab on the pages: the next (previous) object in page order. @returns {boolean} false at the end */
  function selectNeighbour(step) {
    const state = store.getState();
    const order = state.pages.flatMap((page) => page.objectIds);
    if (!order.length) return false;
    const [current] = interaction().selection.slice(-1);
    const index = order.indexOf(current);
    let next = index + step;
    if (index < 0) {
      // nothing selected: forwards starts with the first object on the page in view (or after it),
      // backwards with the last object before that page
      const page = currentPage();
      const from = page ? state.pages.findIndex((entry) => entry.id === page.id) : 0;
      const ahead = state.pages.slice(from).flatMap((entry) => entry.objectIds);
      const start = ahead.length ? order.indexOf(ahead[0]) : order.length;
      next = step > 0 ? (start < order.length ? start : 0) : start - 1;
    }
    if (next < 0 || next >= order.length) {
      select([]);
      return false;
    }
    const object = state.objects[order[next]];
    select([object.id]);
    const page = state.pages.find((entry) => entry.id === object.pageId);
    viewer.scrollToPage(object.pageId, { rect: objectBounds(object, page?.userUnit || 1), align: "nearest" });
    return true;
  }

  // --- the clipboard --------------------------------------------------------------------------------------------

  const isTyping = (target) => Boolean(target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));

  /** The "copy" / "cut" event of the document: objects go to the editor's clipboard, a mark to the system's. */
  function clipboardEvent(event, cut) {
    const forced = pendingCopy;
    pendingCopy = null;
    if (!forced && isTyping(event.target)) return false;
    const ids = selectedIds();
    if (!ids.length) return false;
    const state = store.getState();
    const texts = ids.map((id) => state.objects[id]).filter((object) => object.type === "text").map((object) => object.text);
    const copied = guarded(() => (cut ? clipboard.cut(store, ids) : clipboard.copy(store, ids))) || [];
    if (!copied.length) return false;
    clipboardToken = createId("c");
    clipboardLocal = false;
    try {
      event.clipboardData.setData(CLIPBOARD_MARK, clipboardToken);
      event.clipboardData.setData("text/plain", texts.join("\n"));
      event.preventDefault();
    } catch {
      clipboardLocal = true;
    }
    if (cut) announceDeleted(copied.length);
    return true;
  }

  /** Copy / Cut from a menu or a button: through the document's own copy event when the browser allows it. */
  function copySelection(cut = false) {
    const ids = selectedIds();
    if (!ids.length) return false;
    pendingCopy = { cut };
    let fired;
    try {
      fired = document.execCommand("copy") && pendingCopy === null;
    } catch {
      fired = false;
    }
    if (fired) {
      // the copy event stored the objects; a cut also removes them
      if (cut) deleteObjects(ids);
      return true;
    }
    pendingCopy = null;
    const copied = guarded(() => (cut ? clipboard.cut(store, ids) : clipboard.copy(store, ids))) || [];
    if (copied.length) {
      clipboardLocal = true;
      if (cut) announceDeleted(copied.length);
    }
    return true;
  }

  async function pasteObjects(at = null, pageId = null) {
    if (clipboard.isEmpty() || !(await actions.beforeEdit())) return false;
    const page = pageOf(pageId) || currentPage();
    if (!page) return false;
    const ids = guarded(() => clipboard.paste(store, at ? { pageId: page.id, at } : { pageId: page.id })) || [];
    if (ids.length) select(ids);
    return ids.length > 0;
  }

  async function pasteText(text, at = null, pageId = null) {
    const content = normalizeText(text).replace(/\n+$/, "");
    if (isBlankText(content) || !(await actions.beforeEdit())) return false;
    const page = pageOf(pageId) || currentPage();
    if (!page) return false;
    const object = createTextBox(page, { at: at || pageCentre(page) }, ui.getToolStyle("text"), content);
    if (!object || !(await actions.ensureFonts(object))) return false;
    const ids = guarded(() => store.addObjects([object])) || [];
    if (ids.length) select(ids);
    return ids.length > 0;
  }

  /** The "paste" event of the document. @returns {boolean} true when the editor took it */
  function pasteEvent(event) {
    if (isTyping(event.target)) return false;
    const data = event.clipboardData;
    if (!data || !store.getState().pages.length) return false;
    const pictures = [...(data.files || [])].filter(looksLikeImage);
    const mark = data.getData(CLIPBOARD_MARK);
    const ownCopy = !clipboard.isEmpty() && ((mark && mark === clipboardToken) || (clipboardLocal && !pictures.length));
    if (ownCopy) {
      event.preventDefault();
      pasteObjects();
      return true;
    }
    if (pictures.length) {
      event.preventDefault();
      addImageFiles(pictures);
      return true;
    }
    const text = data.getData("text/plain");
    if (text && text.trim()) {
      event.preventDefault();
      pasteText(text);
      return true;
    }
    if (!clipboard.isEmpty()) {
      event.preventDefault();
      pasteObjects();
      return true;
    }
    return false;
  }

  /** "Paste here" of the context menu: the editor's clipboard, else what the system clipboard lets a page read. */
  async function pasteAt(pageId, at) {
    if (!clipboard.isEmpty()) return pasteObjects(at, pageId);
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((entry) => entry.startsWith("image/"));
        if (type) return addImageFiles([new File([await item.getType(type)], "clipboard", { type })], { pageId, at });
      }
      for (const item of items) {
        if (item.types.includes("text/plain")) return pasteText(await (await item.getType("text/plain")).text(), at, pageId);
      }
    } catch {
      // no permission, or nothing a page may read
    }
    actions.hint("pasteKeys", t("Nothing to paste here. To paste from another program, press Ctrl+V."));
    return false;
  }

  // --- document text: highlight and redact a selection --------------------------------------------------------

  /** Marks the native text selection: "highlight" or "redact". One undo step for all pages. */
  async function markTextSelection(kind) {
    const selection = viewer.getTextSelection();
    if (!selection.length || !(await actions.beforeEdit())) return false;
    const made = guarded(() =>
      store.transaction(() => {
        const ids = [];
        for (const part of selection) {
          const page = pageOf(part.pageId);
          if (!page) continue;
          if (kind === "redact") {
            const marks = part.quads.map((quad) => createMark("redact", page, { rect: quadBounds(quad) }, ui.getToolStyle("redact"))).filter(Boolean);
            if (marks.length) ids.push(...store.addObjects(marks));
          } else {
            const highlight = createTextHighlight(page, part.quads, ui.getToolStyle("highlighter"));
            if (highlight) ids.push(...store.addObjects([highlight]));
          }
        }
        return ids;
      })
    );
    if (!made?.length) return false;
    document.getSelection()?.removeAllRanges();
    if (kind === "redact") select(made);
    return true;
  }

  // --- the effects of the interaction reducer -------------------------------------------------------------------

  /** Where a gesture began: the pointer code tells before it dispatches the press. */
  function setOrigin(next) {
    origin = next;
  }

  const setContextPoint = (point) => {
    contextPoint = point;
  };

  const setDragPoint = (point) => {
    dragPoint = point;
  };

  /** The quads a drag between two pixel points of a page marks, when it began on a line of document text. */
  function textQuadsOf(pageId, from, to) {
    if (!origin?.onText || origin.pageId !== pageId) return null;
    const page = pageOf(pageId);
    const known = linesNow(pageId);
    if (!page || !known) return null;
    const scale = scaleOf();
    const quads = textDragQuads(known, pixelsToUser(page, from, scale), pixelsToUser(page, to, scale));
    return quads.length ? quads : null;
  }

  function create(effect) {
    if (effect.tool === "certSign") return; // the rectangle of a certificate signature belongs to the signing feature
    if (effect.tool === "text") {
      beginNewText(effect);
      return;
    }
    const context = { scaleOf, style: ui.getToolStyle(effect.tool) };
    if (effect.tool === "redact" || effect.tool === "highlighter") {
      const known = linesNow(effect.pageId) || EMPTY_LIST;
      if (effect.lineId !== undefined && known[effect.lineId]) {
        context.rect = known[effect.lineId].rect;
      } else if (origin?.onText && origin.pageId === effect.pageId) {
        const from = effect.from || effect.points?.[0] || effect.at;
        const to = effect.to || effect.points?.[effect.points.length - 1] || effect.at;
        const quads = from && to ? textQuadsOf(effect.pageId, from, to) : null;
        if (quads) context.boxes = quads;
      }
    }
    const result = runEffect(store, effect, context);
    if (result.created) answerCreated(result.ids);
  }

  function marquee(effect) {
    const state = store.getState();
    const page = pageOf(effect.pageId);
    if (!page) return;
    const rect = rectFromPixels(page, effect.rect, scaleOf());
    ui.runInteraction({ type: "setSelection", ids: objectsInRect(state, page, rect).map((object) => object.id), additive: Boolean(effect.additive) });
  }

  function openContextMenu(effect) {
    const page = pageOf(effect.pageId);
    if (!page || !contextPoint) return;
    setBag({ menu: Object.freeze({ menu: effect.menu, clientX: contextPoint.clientX, clientY: contextPoint.clientY, pageId: page.id, at: pixelsToUser(page, [effect.x, effect.y], scaleOf()), ids: effect.ids || EMPTY_LIST }) });
  }

  const closeContextMenu = () => setBag({ menu: null });

  /** The effect executor of the manifest: runs after every ui.runInteraction(event). */
  function execute(effects) {
    for (const effect of effects) {
      switch (effect?.type) {
        case "create":
          create(effect);
          break;
        case "move":
        case "resize":
        case "rotate":
        case "commitErase": {
          const result = runEffect(store, effect, { scaleOf });
          if (result.created) answerCreated(result.ids);
          break;
        }
        case "delete": {
          const result = runEffect(store, effect, { scaleOf });
          if (result.handled && result.ids.length) announceDeleted(result.ids.length);
          break;
        }
        case "marqueeSelect":
          marquee(effect);
          break;
        case "replaceTextLine":
          beginReplaceLine(effect);
          break;
        case "beginEdit":
          beginEdit(effect.id);
          break;
        case "commitEdit":
          commitEdit(effect.id);
          break;
        case "discardEdit":
          discardEdit(effect.id);
          break;
        case "cancelEdit":
          cancelEdit(effect.id);
          break;
        case "contextMenu":
          openContextMenu(effect);
          break;
        case "cancelGesture":
          origin = null;
          break;
        default:
          // erase: the preview reads the gesture; openPicker: the tool activators of the manifest (the file
          // picker of Image here, the dialog of the signing feature for Signature); pan, hint,
          // unhandledEscape: the kernel
          break;
      }
    }
  }

  // --- what a page overlay renders from -----------------------------------------------------------------------

  /** The preview of the running gesture (computed once per change of the interaction state). */
  function preview() {
    const state = store.getState();
    const current = interaction();
    if (!current.gesture) return NO_PREVIEW;
    const scale = scaleOf();
    const version = bag().linesVersion;
    if (previewKey && previewKey.state === state && previewKey.interaction === current && previewKey.scale === scale && previewKey.version === version) return previewValue;
    previewKey = { state, interaction: current, scale, version };
    previewValue = gesturePreview(state, current, {
      scale,
      styleOf: (tool) => ui.getToolStyle(tool),
      textFrame: (object) => {
        try {
          const page = pageOf(object.pageId);
          return frameForLayout(object, textService.layout(object), page?.userUnit || 1);
        } catch {
          return object.frame;
        }
      },
      textQuads: textQuadsOf
    });
    return previewValue;
  }

  /**
   * The part of the UI state the overlay of ONE page renders from. The same object comes back while nothing
   * that this page shows has changed (a snapshot for useSyncExternalStore).
   */
  function pageSlice(pageId) {
    const state = store.getState();
    const current = interaction();
    const now = bag();
    const onPage = (id) => state.objects[id]?.pageId === pageId;
    const selection = current.selection.filter(onPage);
    const gesture = preview();
    const touched = previewTouches(gesture, state, pageId);
    const editingHere = current.editingId && (current.editingId === NEW_ID ? now.draft?.pageId === pageId : onPage(current.editingId));
    const hover = now.hover?.pageId === pageId ? now.hover : null;
    const next = {
      selection,
      single: current.selection.length === 1,
      mode: selection.length || touched || editingHere ? current.mode : "idle",
      editingId: editingHere ? current.editingId : null,
      draft: now.draft?.pageId === pageId ? now.draft : null,
      hover,
      preview: touched ? gesture : null,
      linesVersion: hover || touched ? now.linesVersion : 0,
      annotationsVersion: selection.length ? now.annotationsVersion : 0
    };
    const previous = slices.get(pageId);
    if (
      previous &&
      sameList(previous.selection, next.selection) &&
      previous.single === next.single &&
      previous.mode === next.mode &&
      previous.editingId === next.editingId &&
      previous.draft === next.draft &&
      previous.hover === next.hover &&
      previous.preview === next.preview &&
      previous.linesVersion === next.linesVersion &&
      previous.annotationsVersion === next.annotationsVersion
    ) {
      return previous;
    }
    slices.set(pageId, next);
    return next;
  }

  function setHover(next) {
    const current = bag().hover;
    if (!next) {
      if (current) setBag({ hover: null });
      return;
    }
    if (current && current.pageId === next.pageId && current.kind === next.kind && current.index === next.index && current.id === next.id) return;
    setBag({ hover: Object.freeze(next) });
  }

  // --- the life of a document --------------------------------------------------------------------------------

  /** The document was closed or replaced: nothing of it stays here. */
  function reset() {
    session = null;
    editorHandle = null;
    origin = null;
    lines.clear();
    annotations.clear();
    slices.clear();
    markReach.clear();
    releaseUrls(true);
    previewKey = null;
    previewValue = NO_PREVIEW;
    setBag({ draft: null, liveText: null, hover: null, menu: null, showMarks: false });
  }

  store.subscribe(() => {
    const state = store.getState();
    // pictures and pages that left the document (and its undo history) give their memory back
    releaseUrls(false);
    for (const pageId of lines.keys()) if (!state.pages.some((page) => page.id === pageId)) lines.delete(pageId);
    for (const pageId of slices.keys()) if (!state.pages.some((page) => page.id === pageId)) slices.delete(pageId);
    // the page of the box that is being typed for the first time is gone: so is the box
    if (session?.isNew && !state.pages.some((page) => page.id === session.pageId)) {
      session.done = true;
      endSession();
      ui.runInteraction({ type: "editorBlur", empty: true });
    }
    // a picture that was chosen and never placed
    if (waitingAsset && interaction().mode !== "placing") {
      const assetId = waitingAsset;
      waitingAsset = null;
      if (state.assets[assetId]) store.discardAsset(assetId);
    }
  });

  // Below 1200 px the properties panel lies over the pages: it comes when there is something to set and goes
  // when the selection is cleared (UX specification 3.2), unless it is pinned.
  let seen = { count: 0, tool: "select" };
  ui.subscribe(() => {
    const state = ui.getState();
    const count = state.interaction.selection.length;
    const { tool } = state.interaction;
    const before = seen;
    seen = { count, tool };
    if (state.layout !== "medium") return;
    const wantsOpen = (count > 0 && before.count === 0) || (tool !== before.tool && Boolean(toolKindOf(tool)));
    const wantsClosed = count === 0 && before.count > 0 && !toolKindOf(tool);
    if (wantsOpen && !state.inspector.open) queueMicrotask(() => ui.setInspector({ open: true }));
    else if (wantsClosed && state.inspector.open && !state.inspector.pinned) queueMicrotask(() => ui.setInspector({ open: false }));
  });

  return {
    editor,
    scaleOf,
    bag,
    setBag,
    pageOf,
    currentPage,
    pageCentre,
    // selection and commands
    select,
    selectedIds,
    selectAll,
    selectNeighbour,
    deleteSelection,
    deleteObjects,
    duplicateSelection,
    arrangeSelection,
    alignSelection,
    nudgeSelection,
    // text
    setEditorHandle,
    editorChanged,
    endEditing,
    panelPressed,
    releaseHeldText,
    focusText,
    commitText,
    editingEmpty,
    editingSession,
    toggleTextStyle,
    stepTextSize,
    // styles
    applyStyle,
    styleTarget,
    rememberColor,
    // pictures
    assetUrl,
    assetNote,
    importImage,
    placeImage,
    addImageFiles,
    setImageInput,
    openImagePicker,
    imagePicked,
    imagePickCancelled: () => {
      const purpose = imagePurpose;
      imagePurpose = null;
      imagePickCancelled(purpose);
    },
    // clipboard
    clipboardEvent,
    copySelection,
    pasteEvent,
    pasteObjects,
    pasteAt,
    hasClipboard: () => !clipboard.isEmpty(),
    // document text
    linesNow,
    annotationsNow,
    annotationUnder,
    markTextSelection,
    /** (page, rect, type) => Promise<reach | null>: what a mark takes beyond its rectangle (overlay/markReach.js). */
    markReach,
    // pointer and reducer
    setOrigin,
    setContextPoint,
    setDragPoint,
    dragPoint: () => dragPoint,
    execute,
    closeContextMenu,
    setHover,
    // rendering
    /** { marks, objects } of a page, bottom to top: the same arrays while nothing on that page changed. */
    objectsOfPage: (pageId) => selectObjects(store.getState(), pageId),
    preview,
    pageSlice,
    reset,
    // facts for the panel
    pendingMarks: () => pendingMarks(store.getState()),
    styleKeysOfKind: (kind) => styleKeysOf(objectTypeOfKind(kind) || kind),
    textTools: TEXT_TOOLS
  };
}
