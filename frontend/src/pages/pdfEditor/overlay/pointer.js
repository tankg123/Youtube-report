// The pointer and the keys of the page area, turned into events of the interaction reducer.
//
//   const detach = attachPointer(editor, container);     // container = the scroll container of the pages
//
// ONE set of native listeners on the scroll container serves every page and every pointer mode: with the
// Select tool the pages let the pointer through to the text layer (native text selection), so the overlay
// elements of a page would never hear a press on an empty spot (deselect, selection rectangle).
//
// What is under the pointer is decided by the MODEL, not by the DOM: selectors.objectsAtPoint with a tolerance
// of a few pixels (thin lines stay easy to hit at every zoom), the text lines of the viewer for the tools that
// work on document text. Only the handles of the selection are found through their elements ([data-handle]).
//
// Coordinates sent to the reducer are CSS pixels inside the element of the page a gesture began on, also
// when the pointer has left it; `over` names the page under the pointer for a move that ends on another page.
//
// Also here, because they need the same "what is under the pointer": the cursor (UX specification 4.1, the
// CSS variable --pdfx-cursor on the container), the hover outline of Edit text and of the eraser, Tab between
// objects, Enter with a creation tool (the default object in the middle of the page in view), copy / cut /
// paste events and pictures dropped on a page.
import { isMark } from "../model/schema.js";
import { objectsAtPoint } from "../model/selectors.js";
import { screenRotationOf } from "../model/transform.js";
import { AREA_TOOLS, ERASABLE_TYPES, PLACE_TOOLS, STROKE_TOOLS, cursorFor } from "../tools/interaction.js";
import { hitTolerance, pixelsToUser } from "./geometry.js";
import { getRuntime } from "./runtime.js";
import { pickLine } from "./textPick.js";

const GESTURES = new Set(["pressing", "moving", "resizing", "rotating", "marquee", "drawing", "erasing"]);
const LINE_TOLERANCE = 1.5; // points around a line of text that still count as that line
const ROTATE_CURSOR = "var(--pdfx-rotate-cursor, grab)";

export function attachPointer(editor, container) {
  const { store, ui, viewer } = editor;
  const runtime = getRuntime(editor);
  let blockMouse = false; // the press started a gesture of ours: the browser must not start a text selection
  let captured = null;
  let lastClient = null;

  const interaction = () => ui.getState().interaction;
  const pageById = (pageId) => store.getState().pages.find((page) => page.id === pageId) || null;
  const elementOf = (pageId) => container.querySelector(`.pdfx-page[data-page-id="${CSS.escape(pageId)}"]`);

  /** Pixel position of a client point inside a page element. */
  function inPage(pageId, clientX, clientY) {
    const element = elementOf(pageId);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  }

  const usesLines = (tool) => runtime.textTools.includes(tool);

  /** Everything the reducer wants to know about a pointer event: the page, the position in it, the target. */
  function locate(event) {
    const node = event.target instanceof Element ? event.target : null;
    const state = interaction();
    const handle = node?.closest("[data-handle]");
    const pageElement = node?.closest(".pdfx-page");
    const pageId = pageElement?.getAttribute("data-page-id") || null;
    const point = pageId ? inPage(pageId, event.clientX, event.clientY) : null;
    if (handle && point) {
      const id = handle.getAttribute("data-handle-of");
      const name = handle.getAttribute("data-handle");
      return { pageId, point, target: name === "rotate" ? { kind: "rotate", id } : { kind: "handle", id, handle: name } };
    }
    const page = pageId ? pageById(pageId) : null;
    if (!page || !point) return { pageId: null, point: { x: event.clientX, y: event.clientY }, target: { kind: "outside" } };
    const scale = runtime.scaleOf();
    const user = pixelsToUser(page, point, scale);
    const { tool } = state;
    if (tool === "select" || tool === "eraser") {
      const hits = objectsAtPoint(store.getState(), page, user, hitTolerance(scale));
      // the eraser looks through what it cannot erase (a picture over a pen stroke)
      const hit = tool === "eraser" ? hits.find((object) => ERASABLE_TYPES.includes(object.type)) : hits[0];
      if (hit) return { pageId, point, user, target: { kind: "object", id: hit.id, type: hit.type } };
      if (tool === "select" && node?.closest(".textLayer span, .textLayer br, .annotationLayer section")) return { pageId, point, user, target: { kind: "text" } };
      return { pageId, point, user, target: { kind: "page" } };
    }
    if (usesLines(tool)) {
      const found = pickLine(runtime.linesNow(pageId), user, LINE_TOLERANCE, { editableOnly: tool === "editText" });
      if (found) return { pageId, point, user, target: { kind: "textline", id: found.index } };
    }
    return { pageId, point, user, target: { kind: "page" } };
  }

  function setCursor(target) {
    const state = interaction();
    let rotation = 0;
    const id = state.mode === "resizing" ? state.gesture?.id : target?.kind === "handle" ? target.id : null;
    if (id) {
      const object = store.getState().objects[id];
      const page = object ? pageById(object.pageId) : null;
      // a mark is resized through a box that looks upright
      if (object && page && !isMark(object)) rotation = screenRotationOf(object, page);
    }
    let cursor = cursorFor(state, target || { kind: "outside" }, { screenRotation: rotation });
    if (cursor === "grab" && target?.kind === "rotate") cursor = ROTATE_CURSOR;
    if (state.mode === "rotating") cursor = ROTATE_CURSOR;
    if (container.style.getPropertyValue("--pdfx-cursor") !== cursor) container.style.setProperty("--pdfx-cursor", cursor);
  }

  function hover(found) {
    const state = interaction();
    if (state.mode !== "idle") {
      runtime.setHover(null);
      return;
    }
    if (state.tool === "editText" && found.target.kind === "textline") runtime.setHover({ pageId: found.pageId, kind: "line", index: found.target.id });
    else if (state.tool === "eraser" && found.target.kind === "object") runtime.setHover({ pageId: found.pageId, kind: "erase", id: found.target.id });
    else runtime.setHover(null);
  }

  /** The page under a client point and the position inside it (a move may end on another page). */
  function pageUnder(clientX, clientY) {
    const pageId = viewer.pageAtPoint(clientX, clientY);
    const point = pageId ? inPage(pageId, clientX, clientY) : null;
    return point ? { pageId, x: point.x, y: point.y } : null;
  }

  function release() {
    blockMouse = false;
    if (captured !== null) {
      try {
        container.releasePointerCapture(captured);
      } catch {
        // already gone
      }
      captured = null;
    }
  }

  const inChrome = (node) => Boolean(node?.closest?.(".pdfx-viewer-floats, .pdfx-text-editor, .pdfx-page-error"));

  function onPointerDown(event) {
    const node = event.target instanceof Element ? event.target : null;
    if (inChrome(node) || ui.getState().job) return;
    // the scroll bars of the container are not the pages
    if (node === container && (event.offsetX >= container.clientWidth || event.offsetY >= container.clientHeight)) return;
    const before = interaction();
    if (event.button !== 0 || before.tool === "hand" || before.spaceHeld) return; // the kernel pans; the reducer ignores other buttons
    const found = locate(event);
    const touchScroll = event.pointerType === "touch" && before.tool === "select" && before.mode === "idle" && found.target.kind !== "object" && found.target.kind !== "handle" && found.target.kind !== "rotate";
    if (touchScroll) return; // one finger scrolls the pages with the Select tool
    runtime.setOrigin({ pageId: found.pageId, onText: found.target.kind === "textline" });
    runtime.setHover(null);
    ui.runInteraction({
      type: "pointerdown",
      pageId: found.pageId,
      x: found.point.x,
      y: found.point.y,
      button: event.button,
      pointerType: event.pointerType,
      target: found.target,
      shift: event.shiftKey,
      alt: event.altKey,
      empty: runtime.editingEmpty()
    });
    const after = interaction();
    const pressed = GESTURES.has(after.mode) || (after.mode === "placing" && Boolean(after.gesture?.start));
    const ours = pressed || found.target.kind === "object" || found.target.kind === "handle" || found.target.kind === "rotate";
    if (pressed) {
      try {
        container.setPointerCapture(event.pointerId);
        captured = event.pointerId;
      } catch {
        captured = null;
      }
    }
    if (ours) {
      blockMouse = true;
      // The mouse press is swallowed below, so the browser neither moves the focus nor gives up a text
      // selection. Both are done here: the keys of the selection (Delete, arrows) must not go to the tool bar
      // button that was clicked last, and a press on the page ends a selection of its text as it always does.
      if (document.activeElement !== container) container.focus({ preventScroll: true });
      const selected = document.getSelection();
      if (selected && !selected.isCollapsed && selected.anchorNode && container.contains(selected.anchorNode)) selected.removeAllRanges();
    }
    setCursor(found.target);
  }

  function onMouseDown(event) {
    if (!blockMouse) return;
    event.preventDefault();
  }

  function moveTo(clientX, clientY, event) {
    const state = interaction();
    if (state.mode === "idle") return false;
    const gesture = state.gesture;
    const placingFree = state.mode === "placing" && !gesture?.start;
    if (placingFree) {
      // the ghost of the picture follows the pointer from page to page
      const under = pageUnder(clientX, clientY);
      ui.runInteraction({ type: "pointermove", x: under ? under.x : clientX, y: under ? under.y : clientY, shift: event.shiftKey, pageId: under ? under.pageId : null });
      setCursor(under ? { kind: "page" } : { kind: "outside" });
      return true;
    }
    const pageId = gesture?.pageId;
    const point = (pageId && inPage(pageId, clientX, clientY)) || { x: clientX, y: clientY };
    const move = { type: "pointermove", x: point.x, y: point.y, shift: event.shiftKey };
    if (state.mode === "moving" || state.mode === "pressing") move.over = pageUnder(clientX, clientY);
    if (state.mode === "erasing") {
      const under = pageUnder(clientX, clientY);
      const page = under ? pageById(under.pageId) : null;
      if (page) {
        const scale = runtime.scaleOf();
        const hit = objectsAtPoint(store.getState(), page, pixelsToUser(page, under, scale), hitTolerance(scale)).find((object) => ERASABLE_TYPES.includes(object.type));
        if (hit) move.target = { kind: "object", id: hit.id, type: hit.type };
      }
    }
    ui.runInteraction(move);
    return true;
  }

  function onPointerMove(event) {
    lastClient = { clientX: event.clientX, clientY: event.clientY };
    const state = interaction();
    if (state.mode !== "idle" && (captured === event.pointerId || state.mode === "placing")) {
      // a pen or a fast mouse reports several positions per frame: a stroke wants them all
      const samples = state.mode === "drawing" && state.gesture?.points && typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      if (samples.length > 1) for (const sample of samples) moveTo(sample.clientX, sample.clientY, event);
      else moveTo(event.clientX, event.clientY, event);
      if (state.mode !== "placing") setCursor(null);
      return;
    }
    if (event.buttons) return; // a drag that is not ours (text selection, the hand)
    const node = event.target instanceof Element ? event.target : null;
    if (inChrome(node)) return;
    const found = locate(event);
    setCursor(found.target);
    hover(found);
  }

  function onPointerUp(event) {
    const state = interaction();
    if (captured !== event.pointerId && !(state.mode === "placing" && state.gesture?.start)) {
      release();
      return;
    }
    const pageId = state.gesture?.pageId;
    const point = (pageId && inPage(pageId, event.clientX, event.clientY)) || { x: event.clientX, y: event.clientY };
    release();
    ui.runInteraction({ type: "pointerup", x: point.x, y: point.y, over: pageUnder(event.clientX, event.clientY) });
    runtime.setOrigin(null);
    refreshCursor(event.clientX, event.clientY);
  }

  /** The cursor for what lies under a client point now (after a gesture, a tool change by key ...). */
  function refreshCursor(clientX, clientY) {
    const node = document.elementFromPoint(clientX, clientY);
    if (!node || !container.contains(node) || inChrome(node)) return;
    setCursor(locate({ target: node, clientX, clientY }).target);
  }

  function onPointerCancel(event) {
    if (captured !== event.pointerId) return;
    release();
    ui.runInteraction({ type: "pointercancel" });
    runtime.setOrigin(null);
  }

  function onPointerLeave() {
    if (interaction().mode === "idle") runtime.setHover(null);
  }

  function onDoubleClick(event) {
    // the press captured the pointer, so the browser sends the double click to the scroll container: what was
    // double-clicked is what lies under the pointer
    const node = document.elementFromPoint(event.clientX, event.clientY);
    if (!node || !container.contains(node) || inChrome(node)) return;
    const found = locate({ target: node, clientX: event.clientX, clientY: event.clientY });
    if (found.target.kind !== "object") return;
    ui.runInteraction({ type: "dblclick", target: found.target });
  }

  function onContextMenu(event) {
    const node = event.target instanceof Element ? event.target : null;
    if (inChrome(node) || ui.getState().job) return;
    let found;
    let clientX = event.clientX;
    let clientY = event.clientY;
    const [selected] = interaction().selection;
    const fromKeyboard = event.button !== 2 && event.target === container;
    if (fromKeyboard && selected) {
      // the Menu key / Shift+F10 on the pages: the menu of the selection, at the selection
      const object = store.getState().objects[selected];
      const element = object ? container.querySelector(`[data-object-id="${CSS.escape(object.id)}"]`) : null;
      if (!object || !element) return;
      const box = element.getBoundingClientRect();
      clientX = box.left + box.width / 2;
      clientY = box.top + box.height / 2;
      found = { pageId: object.pageId, point: inPage(object.pageId, clientX, clientY), target: { kind: "object", id: object.id, type: object.type } };
    } else {
      found = locate(event);
      // with a creation tool the model was not asked what lies under the pointer: ask now
      if (found.pageId && found.target.kind !== "handle" && found.target.kind !== "rotate") {
        const page = pageById(found.pageId);
        const scale = runtime.scaleOf();
        const [hit] = page ? objectsAtPoint(store.getState(), page, pixelsToUser(page, found.point, scale), hitTolerance(scale)) : [];
        if (hit) found.target = { kind: "object", id: hit.id, type: hit.type };
        else if (found.target.kind === "text" && !viewer.getTextSelection().length) found.target = { kind: "page" };
      }
    }
    if (!found.pageId || found.target.kind === "outside") return; // the browser's own menu outside the pages
    event.preventDefault();
    runtime.setContextPoint({ clientX, clientY });
    ui.runInteraction({ type: "contextmenu", pageId: found.pageId, x: found.point.x, y: found.point.y, target: found.target });
  }

  function onClick(event) {
    // a press that selected an object over a link of the document must not follow the link
    const node = event.target instanceof Element ? event.target : null;
    if (!node?.closest(".annotationLayer")) return;
    const found = locate(event);
    if (found.target.kind === "object") event.preventDefault();
  }

  /** A synthetic click in the middle of the page in view: the keyboard way to use a creation tool. */
  function createAtCentre() {
    const state = interaction();
    const { tool } = state;
    if (state.mode !== "idle" || !(AREA_TOOLS.includes(tool) || tool === "text")) return false;
    if (tool === "certSign") return false;
    const page = runtime.currentPage();
    // the exact size of the page on screen (its element is rounded down to whole device pixels)
    const view = page ? viewer.getPageView(page.id) : null;
    if (!view?.element) return false;
    const x = view.width / 2;
    const y = view.height / 2;
    runtime.setOrigin({ pageId: page.id, onText: false });
    ui.runInteraction({ type: "pointerdown", pageId: page.id, x, y, button: 0, pointerType: "mouse", target: { kind: "page" }, shift: false, alt: false });
    ui.runInteraction({ type: "pointerup", x, y });
    runtime.setOrigin(null);
    return true;
  }

  function onKeyDown(event) {
    if (event.defaultPrevented || event.isComposing || event.target !== container || ui.getState().job) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const state = interaction();
    if (event.key === "Tab" && state.tool === "select" && state.mode === "idle") {
      // objects are reached in page order; past the last one the focus moves on as usual
      if (runtime.selectNeighbour(event.shiftKey ? -1 : 1)) event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !state.selection.length) {
      if (STROKE_TOOLS.includes(state.tool) || PLACE_TOOLS.includes(state.tool)) return;
      if (createAtCentre()) event.preventDefault();
    }
  }

  // --- the clipboard and dropped pictures (document level) ------------------------------------------------------

  const hasDocument = () => store.getState().pages.length > 0;
  const onCopy = (event) => {
    if (hasDocument()) runtime.clipboardEvent(event, false);
  };
  const onCut = (event) => {
    if (hasDocument()) runtime.clipboardEvent(event, true);
  };
  const onPaste = (event) => {
    if (hasDocument() && !ui.getState().job && ui.getState().dialogs.length === 0) runtime.pasteEvent(event);
  };
  // where a file drag was last seen: a picture that is dropped lands on that spot of that page
  const onDragOver = (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) runtime.setDragPoint({ clientX: event.clientX, clientY: event.clientY, time: Date.now() });
  };

  /** The text lines of the page in view and of its neighbours: asked for as soon as a tool needs them. */
  function wantLines() {
    const { pages } = store.getState();
    const index = pages.findIndex((page) => page.id === viewer.getSnapshot().currentPageId);
    for (const page of pages.slice(Math.max(0, index - 1), index + 2)) runtime.linesNow(page.id);
  }

  /** Space held for the hand, a tool change by key, text lines that arrive: the cursor follows without a pointer move. */
  let seen = interaction();
  let seenLines = runtime.bag().linesVersion;
  const offUi = ui.subscribe(() => {
    const state = interaction();
    const lines = runtime.bag().linesVersion;
    if (lines !== seenLines) {
      seenLines = lines;
      if (lastClient && state.mode === "idle" && usesLines(state.tool)) {
        const node = document.elementFromPoint(lastClient.clientX, lastClient.clientY);
        if (node && container.contains(node) && !inChrome(node)) {
          const found = locate({ target: node, clientX: lastClient.clientX, clientY: lastClient.clientY });
          setCursor(found.target);
          hover(found);
        }
      }
    }
    if (state === seen) return;
    const changed = state.tool !== seen.tool || state.mode !== seen.mode;
    const toolChanged = state.tool !== seen.tool;
    seen = state;
    if (!changed) return;
    if (toolChanged && usesLines(state.tool)) wantLines();
    if (state.mode === "idle" && captured !== null) release();
    if (lastClient && state.mode === "idle") refreshCursor(lastClient.clientX, lastClient.clientY);
    if (state.tool !== "editText" && state.tool !== "eraser") runtime.setHover(null);
  });

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("mousedown", onMouseDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerCancel);
  container.addEventListener("pointerleave", onPointerLeave);
  container.addEventListener("dblclick", onDoubleClick);
  container.addEventListener("contextmenu", onContextMenu);
  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeyDown);
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCut);
  document.addEventListener("paste", onPaste);
  document.addEventListener("dragover", onDragOver, true);

  return () => {
    offUi();
    release();
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("mousedown", onMouseDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("pointercancel", onPointerCancel);
    container.removeEventListener("pointerleave", onPointerLeave);
    container.removeEventListener("dblclick", onDoubleClick);
    container.removeEventListener("contextmenu", onContextMenu);
    container.removeEventListener("click", onClick);
    container.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("cut", onCut);
    document.removeEventListener("paste", onPaste);
    document.removeEventListener("dragover", onDragOver, true);
    container.style.removeProperty("--pdfx-cursor");
  };
}
