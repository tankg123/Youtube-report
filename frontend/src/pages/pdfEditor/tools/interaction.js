// Pointer and keyboard interaction of the page overlay as a pure reducer:
//
//   const { state, effects } = step(state, event, ctx);
//
// `state` holds only interaction state: the active tool, the mode, the SELECTION (ids of selected objects:
// selection is not document state), the gesture in progress and the text box being edited. It is the truth
// for what the overlay shows; nothing in it is a command.
// `effects` are the commands for everything outside: the document store, the viewer (pan), pickers, hints.
// A gesture emits its document command ONCE, on pointer-up, so one gesture is exactly one undo step; while
// it runs the overlay draws a preview from `state.gesture`. Escape, pointercancel or a second finger end it
// with "cancelGesture" and nothing changes.
//
// Coordinates in events and effects are CSS pixels inside the element of ONE page (event.pageId, taken
// from data-page-id): the page the gesture started on, also when the pointer leaves it. The overlay turns
// effects into store calls with model/transform.js (createFromEffect, patchesForMoveEffect,
// patchForResizeEffect, patchForRotateEffect, rectFromPixels, placeForDrop), which know /Rotate, the zoom and
// the rotation the user added.
//
// Events
//   { type: "tool", tool, lock?, empty? }            choose a tool (lock: a double-click keeps a one-shot tool)
//   { type: "placeReady", payload }                  the picker of Image / Signature returned something to place
//   { type: "pointerdown", pageId, x, y, button?, pointerType?, target, shift?, alt?, empty? }
//   { type: "pointermove", x, y, shift?, target?, pageId?, over? }
//   { type: "pointerup", x, y, over? }               over: { pageId, x, y } = the page under the pointer and the
//                                                    position inside IT (a move may end on another page)
//   { type: "pointercancel" } | { type: "multitouch" }
//   { type: "dblclick", target }
//   { type: "contextmenu", pageId, x, y, target }
//   { type: "key", key, phase?: "down" | "up", empty? }     key: "Escape" | "Delete" | "Enter" | "F2" | "Space"
//   { type: "shortcut", id, phase?, empty? }         an id of keymap.js matchShortcut(): the reducer handles
//                                                    REDUCER_SHORTCUTS and "tool:<id>", ignores the others
//   { type: "editorBlur", empty? }                   the text editor lost the focus: commit
//   { type: "textSelection", pageId, lineId? }       a native text selection was finished while a tool that
//                                                    marks text (Highlighter, Redact) is active
//   { type: "created", ids }                         the store created what the last effect asked for:
//                                                    replaces NEW_ID in the selection / the edited id
//   { type: "setSelection", ids, additive? }         select all, the result of a marquee, pasted objects ...
//   { type: "documentChanged" }                      after undo / redo / any outside change: drops ids for
//                                                    which ctx.objectExists(id) is false
// `target` is what lies under the pointer, supplied by the overlay:
//   { kind: "page" }                          empty area of a page
//   { kind: "text" }                          document text (native browser text selection)
//   { kind: "textline", id }                  a line of document text (Edit text; Redact on a click)
//   { kind: "object", id, type }              an added object; type = its type in model/schema.js
//   { kind: "handle", id, handle }            a handle of a selected object: nw n ne e se s sw w, or p1 / p2 of a line
//   { kind: "rotate", id }                    the rotation handle
//   { kind: "outside" }                       the backdrop between pages
// `empty` on an event that ends text editing says that the editor holds no text (the box is then discarded).
// ctx: { objectType?: (id) => string, objectExists?: (id) => boolean }
//
// Effects
//   { type: "create", tool, objectType, pageId, ... }   objectType: schema type, or "signatureField" (certSign)
//        at: { x, y }                                    a click: default size at the point
//        from, to (+ rect: { x, y, width, height })      a drag; constrain: Shift (square, 45 degree line)
//        points: [{ x, y }]                              pen / highlighter stroke
//        payload, keepRatio                              image / signature placement
//        autoWidth                                       text: true for a click, false for a dragged width
//        lineId                                          Redact clicked on a text line
//        textSelection: true                             mark the current native text selection
//   { type: "move", ids, pageId, from, to, dx, dy, axisLock, duplicate, drop }
//        duplicate: Alt-drag: duplicate first and move the copies, in one transaction
//        drop: null, or { pageId, x, y } when the gesture ended over another page
//   { type: "resize", id, pageId, handle, dx, dy, invertRatioLock }
//   { type: "rotate", id, pageId, from, to, snap }
//   { type: "marqueeSelect", pageId, rect, additive }    answer with a "setSelection" event
//   { type: "erase", id }                                preview only: hide the object while the eraser drags on
//   { type: "commitErase", ids }                         delete them: one undo step
//   { type: "delete", ids }
//   { type: "openPicker", tool }                         answer with "placeReady", or choose Select on cancel
//   { type: "replaceTextLine", pageId, lineId }          Edit text: open an editor on that line (draft id NEW_ID)
//   { type: "beginEdit", id } | { type: "commitEdit", id } | { type: "discardEdit", id } | { type: "cancelEdit", id }
//        A text editing session is ONE undo step: keep the text of a new box as a draft and add the object to
//        the store on "commitEdit" (id NEW_ID), then send "created"; an existing box is updated once.
//   { type: "pan", dx, dy }
//   { type: "contextMenu", menu: "object" | "page" | "text", pageId, x, y, target, ids }
//   { type: "hint", id, message }                        message: a tk() text for t()
//   { type: "cancelGesture" }                            drop the preview (and the erase previews)
//   { type: "unhandledEscape" }                          nothing left to cancel here: the shell closes a panel
import { tk } from "../../../i18n/index.js";
import { resizeCursor } from "../model/transform.js";
import { toolById } from "./registry.js";

/** CSS pixels before a press becomes a drag. */
export const DRAG_THRESHOLD = Object.freeze({ mouse: 4, pen: 6, touch: 10 });
/** Placeholder id of the object the last "create" effect makes, until a "created" event names it. */
export const NEW_ID = "$new";
/** Id of the rectangle of a visible certificate signature: it lives in the signing flow, not in the document. */
export const SIGNATURE_FIELD_ID = "$signatureField";
export const SIGNATURE_FIELD_TYPE = "signatureField";

export const AREA_TOOLS = Object.freeze(["rect", "ellipse", "line", "arrow", "redact", "blur", "certSign"]);
export const STROKE_TOOLS = Object.freeze(["pen", "highlighter"]);
export const PLACE_TOOLS = Object.freeze(["image", "signature"]);
/** Tools that mark document text when they are used on it. */
export const TEXT_MARK_TOOLS = Object.freeze(["highlighter", "redact"]);
/** What the eraser removes. Text boxes, images, signatures and marks need Delete. */
export const ERASABLE_TYPES = Object.freeze(["pen", "highlight", "rect", "ellipse", "line"]);
/** The shortcut ids of keymap.js that this reducer consumes as { type: "shortcut", id } (besides "tool:<id>"). */
export const REDUCER_SHORTCUTS = Object.freeze(["escape", "delete", "editObject", "tempHand"]);

export const HINTS = Object.freeze({
  editTextNoLine: tk("Click a line of text to edit it. This page may be a scan without editable text.")
});

const GESTURE_MODES = new Set(["pressing", "moving", "resizing", "rotating", "marquee", "drawing", "erasing", "panning"]);

export function initialState() {
  return {
    tool: "select",
    toolLocked: false, // a one-shot tool chosen with a double-click stays active
    mode: "idle", // idle | pressing | moving | resizing | rotating | marquee | drawing | erasing | placing | editingText | panning
    selection: [], // ids of selected objects (NEW_ID until a "created" event resolves it)
    gesture: null,
    editingId: null,
    spaceHeld: false
  };
}

const done = (state, ...effects) => ({ state, effects });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
const idle = (state, patch = {}) => ({ ...state, mode: "idle", gesture: null, ...patch });
const staysActive = (state) => {
  const tool = toolById(state.tool);
  return !(tool?.mode === "one-shot" && !state.toolLocked);
};

/** After an object was created: select it and, for an unlocked one-shot tool, go back to Select. */
function afterCreate(state) {
  const selection = state.tool === "certSign" ? [SIGNATURE_FIELD_ID] : [NEW_ID];
  return idle(state, { tool: staysActive(state) ? state.tool : "select", selection });
}

export function step(state, event, ctx = {}) {
  switch (event?.type) {
    case "tool":
      return onTool(state, event);
    case "placeReady":
      if (!PLACE_TOOLS.includes(state.tool)) return done(state);
      return done({ ...idle(state), mode: "placing", gesture: { payload: event.payload, at: null }, selection: [] });
    case "pointerdown":
      return onPointerDown(state, event);
    case "pointermove":
      return onPointerMove(state, event);
    case "pointerup":
      return onPointerUp(state, event);
    case "pointercancel":
    case "multitouch": // a second finger landed: hand the gesture over to pinch-zoom / two-finger pan
      return cancelGesture(state);
    case "dblclick":
      return onDoubleClick(state, event);
    case "contextmenu":
      return onContextMenu(state, event);
    case "key":
      return onKey(state, event, ctx);
    case "shortcut":
      return onShortcut(state, event, ctx);
    case "editorBlur":
      return state.mode === "editingText" ? commitText(state, event.empty) : done(state);
    case "textSelection":
      return onTextSelection(state, event);
    case "created":
      return onCreated(state, event);
    case "setSelection":
      return onSetSelection(state, event);
    case "documentChanged":
      return onDocumentChanged(state, ctx);
    default:
      return done(state);
  }
}

function onTool(state, event) {
  const tool = toolById(event.tool);
  if (!tool) return done(state);
  const effects = [];
  let next = state;
  if (state.mode === "editingText") {
    const committed = commitText(state, event.empty);
    next = committed.state;
    effects.push(...committed.effects);
  } else if (GESTURE_MODES.has(state.mode) || state.mode === "placing") {
    effects.push({ type: "cancelGesture" });
  }
  // Leaving Select clears the selection: creation tools never act on existing objects.
  const selection = tool.id === "select" ? next.selection : [];
  if (tool.picker) effects.push({ type: "openPicker", tool: tool.id });
  return done(idle(next, { tool: tool.id, toolLocked: Boolean(event.lock), selection, editingId: null }), ...effects);
}

function onPointerDown(state, event) {
  if (event.button !== undefined && event.button !== 0) return done(state); // context menu / middle button
  if (state.mode === "editingText") {
    // A press outside the editor commits it; the same press then acts normally.
    const committed = commitText(state, event.empty);
    const after = onPointerDown(committed.state, event);
    return done(after.state, ...committed.effects, ...after.effects);
  }
  if (GESTURE_MODES.has(state.mode)) {
    // The release of the previous gesture never arrived: drop it and start again.
    const after = onPointerDown(idle(state), event);
    return done(after.state, { type: "cancelGesture" }, ...after.effects);
  }
  const point = { x: event.x, y: event.y };
  const target = event.target ?? { kind: "outside" };
  const threshold = DRAG_THRESHOLD[event.pointerType] ?? DRAG_THRESHOLD.mouse;
  const press = { pageId: event.pageId ?? null, start: point, last: point, target, shift: Boolean(event.shift), alt: Boolean(event.alt), threshold };

  if (state.mode === "placing") {
    if (target.kind === "outside") return done(state); // a picture needs a page
    return done({ ...state, gesture: { ...state.gesture, ...press } });
  }
  if (state.tool === "hand" || state.spaceHeld) return done({ ...state, mode: "panning", gesture: press });

  // Handles belong to the selection, whatever the tool is: a redaction that was just drawn can be adjusted at once.
  if ((target.kind === "handle" || target.kind === "rotate") && (state.tool === "select" || state.selection.includes(target.id))) {
    if (target.kind === "handle") return done({ ...state, mode: "resizing", gesture: { ...press, id: target.id, handle: target.handle } });
    return done({ ...state, mode: "rotating", gesture: { ...press, id: target.id } });
  }

  if (state.tool === "select") {
    if (target.kind === "text" || target.kind === "textline") {
      // native text selection; the handles of a selected object would only be in the way
      return done(press.shift || !state.selection.length ? state : { ...state, selection: [] });
    }
    if (target.kind === "object") {
      if (press.shift) {
        const selection = state.selection.includes(target.id) ? state.selection.filter((id) => id !== target.id) : [...state.selection, target.id];
        return done({ ...state, selection });
      }
      const already = state.selection.includes(target.id);
      return done({ ...state, mode: "pressing", selection: already ? state.selection : [target.id], gesture: { ...press, wasSelected: already } });
    }
    return done({ ...state, mode: "pressing", gesture: press }); // page or backdrop: a click deselects, a drag on a page is a marquee
  }

  if (state.tool === "eraser") {
    const erased = target.kind === "object" && ERASABLE_TYPES.includes(target.type) ? [target.id] : [];
    return done({ ...state, mode: "erasing", selection: [], gesture: { ...press, erased } }, ...erased.map((id) => ({ type: "erase", id })));
  }
  if (target.kind === "outside") return done(state); // creation tools only work on a page
  if (state.tool === "editText") {
    if (target.kind !== "textline") return done(state, { type: "hint", id: "editTextNoLine", message: HINTS.editTextNoLine });
    return done({ ...idle(state), mode: "editingText", editingId: NEW_ID, selection: [] }, { type: "replaceTextLine", pageId: press.pageId, lineId: target.id });
  }
  // Highlighter and Redact over document text: the browser selects the text and the overlay reports it ("textSelection").
  if (TEXT_MARK_TOOLS.includes(state.tool) && target.kind === "text") return done(state.selection.length ? { ...state, selection: [] } : state);
  if (STROKE_TOOLS.includes(state.tool)) return done({ ...state, mode: "drawing", selection: [], gesture: { ...press, points: [point] } });
  if (AREA_TOOLS.includes(state.tool) || state.tool === "text") return done({ ...state, mode: "drawing", selection: [], gesture: press });
  return done(state);
}

function onPointerMove(state, event) {
  const point = { x: event.x, y: event.y };
  const gesture = state.gesture;
  switch (state.mode) {
    case "pressing": {
      if (dist(gesture.start, point) < gesture.threshold) return done(state);
      const shift = Boolean(event.shift ?? gesture.shift);
      if (gesture.target.kind === "object") {
        // Alt-drag moves copies: the store duplicates and moves them in ONE step when the gesture ends.
        return done({ ...state, mode: "moving", gesture: { ...gesture, last: point, shift, duplicate: gesture.alt, over: event.over ?? null } });
      }
      if (gesture.pageId === null || gesture.target.kind === "outside") return done(state); // no marquee without a page
      return done({ ...state, mode: "marquee", gesture: { ...gesture, last: point, shift } });
    }
    case "moving":
      return done({ ...state, gesture: { ...gesture, last: point, shift: Boolean(event.shift ?? gesture.shift), over: event.over ?? gesture.over ?? null } });
    case "resizing":
    case "rotating":
    case "marquee":
      return done({ ...state, gesture: { ...gesture, last: point, shift: Boolean(event.shift ?? gesture.shift) } });
    case "drawing":
      if (gesture.points) return done({ ...state, gesture: { ...gesture, last: point, points: [...gesture.points, point] } });
      return done({ ...state, gesture: { ...gesture, last: point, shift: Boolean(event.shift ?? gesture.shift) } });
    case "erasing": {
      const target = event.target;
      if (target?.kind === "object" && ERASABLE_TYPES.includes(target.type) && !gesture.erased.includes(target.id)) {
        return done({ ...state, gesture: { ...gesture, last: point, erased: [...gesture.erased, target.id] } }, { type: "erase", id: target.id });
      }
      return done(state);
    }
    case "placing":
      // before the press the ghost follows the pointer over whatever page it is on; after it, it stretches
      if (gesture.start) return done({ ...state, gesture: { ...gesture, at: point, last: point, shift: Boolean(event.shift ?? gesture.shift) } });
      return done({ ...state, gesture: { ...gesture, at: point, pageId: event.pageId ?? null } });
    case "panning": {
      const effect = { type: "pan", dx: point.x - gesture.last.x, dy: point.y - gesture.last.y };
      return done({ ...state, gesture: { ...gesture, last: point } }, effect);
    }
    default:
      return done(state);
  }
}

function onPointerUp(state, event) {
  const point = { x: event.x, y: event.y };
  const gesture = state.gesture;
  switch (state.mode) {
    case "pressing": {
      if (gesture.target.kind === "object") {
        // A plain click on one member of a multi-selection reduces the selection to that object.
        if (gesture.wasSelected && state.selection.length > 1) return done(idle(state, { selection: [gesture.target.id] }));
        return done(idle(state));
      }
      return done(idle(state, { selection: [] }));
    }
    case "moving": {
      const over = event.over ?? gesture.over;
      const drop = over && over.pageId && over.pageId !== gesture.pageId ? { pageId: over.pageId, x: over.x, y: over.y } : null;
      const effect = {
        type: "move",
        ids: state.selection,
        pageId: gesture.pageId,
        from: gesture.start,
        to: point,
        dx: point.x - gesture.start.x,
        dy: point.y - gesture.start.y,
        axisLock: gesture.shift,
        duplicate: Boolean(gesture.duplicate),
        drop
      };
      return done(idle(state, gesture.duplicate ? { selection: [NEW_ID] } : {}), effect);
    }
    case "resizing": {
      const effect = { type: "resize", id: gesture.id, pageId: gesture.pageId, handle: gesture.handle, dx: point.x - gesture.start.x, dy: point.y - gesture.start.y, invertRatioLock: gesture.shift };
      return done(idle(state), effect);
    }
    case "rotating":
      return done(idle(state), { type: "rotate", id: gesture.id, pageId: gesture.pageId, from: gesture.start, to: point, snap: gesture.shift });
    case "marquee":
      return done(idle(state), { type: "marqueeSelect", pageId: gesture.pageId, rect: rectOf(gesture.start, point), additive: gesture.shift });
    case "erasing":
      return done(idle(state), ...(gesture.erased.length ? [{ type: "commitErase", ids: gesture.erased }] : []));
    case "panning":
      return done(idle(state));
    case "placing": {
      if (!gesture.start) return done(state); // pointer-up without a press of ours
      const base = { type: "create", tool: state.tool, objectType: toolById(state.tool)?.creates ?? null, pageId: gesture.pageId, payload: gesture.payload };
      const dragged = dist(gesture.start, point) >= gesture.threshold;
      // Pictures keep their aspect ratio; Shift releases it.
      const effect = dragged ? { ...base, from: gesture.start, to: point, rect: rectOf(gesture.start, point), keepRatio: !gesture.shift } : { ...base, at: point };
      const next = afterCreate(state);
      // A locked tool places the same picture again and again.
      if (next.tool === state.tool) return done({ ...next, mode: "placing", gesture: { payload: gesture.payload, at: null } }, effect);
      return done(next, effect);
    }
    case "drawing": {
      const base = { type: "create", tool: state.tool, objectType: toolById(state.tool)?.creates ?? null, pageId: gesture.pageId };
      const dragged = dist(gesture.start, point) >= gesture.threshold;
      if (gesture.points) {
        // A tap with the pen is a dot; strokes never select themselves and the tool stays active.
        return done(idle(state), { ...base, points: [...gesture.points, point] });
      }
      if (state.tool === "text") {
        const effect = dragged ? { ...base, from: gesture.start, to: point, rect: rectOf(gesture.start, point), autoWidth: false } : { ...base, at: point, autoWidth: true };
        return done({ ...idle(state), mode: "editingText", editingId: NEW_ID, selection: [] }, effect);
      }
      if (dragged) {
        const shape = state.tool === "line" || state.tool === "arrow" ? { from: gesture.start, to: point } : { from: gesture.start, to: point, rect: rectOf(gesture.start, point) };
        return done(afterCreate(state), { ...base, ...shape, constrain: gesture.shift });
      }
      // A click without a drag creates a default-size object at the point (WCAG 2.5.7: every drag has a
      // single-pointer alternative). With Redact, a click on a line of document text marks that whole line.
      const line = state.tool === "redact" && gesture.target.kind === "textline" ? { lineId: gesture.target.id } : {};
      return done(afterCreate(state), { ...base, at: point, ...line });
    }
    default:
      return done(state);
  }
}

function onDoubleClick(state, event) {
  const target = event.target ?? {};
  if (state.tool === "select" && state.mode === "idle" && target.kind === "object" && target.type === "text") {
    return done({ ...idle(state), mode: "editingText", editingId: target.id, selection: [target.id] }, { type: "beginEdit", id: target.id });
  }
  return done(state);
}

function onContextMenu(state, event) {
  const target = event.target ?? { kind: "outside" };
  // Outside the pages the browser's own menu is left alone; while a gesture or the text editor runs, too.
  if (state.mode !== "idle" || target.kind === "outside") return done(state);
  let selection = state.selection;
  let menu = "page";
  if (target.kind === "object" || target.kind === "handle" || target.kind === "rotate") {
    menu = "object";
    if (!selection.includes(target.id)) selection = [target.id];
  } else if (target.kind === "text" || target.kind === "textline") {
    menu = "text";
  } else {
    selection = [];
  }
  const next = selection === state.selection ? state : { ...state, selection };
  return done(next, { type: "contextMenu", menu, pageId: event.pageId ?? null, x: event.x, y: event.y, target, ids: selection });
}

function commitText(state, empty) {
  const id = state.editingId;
  // An empty text box is discarded instead of leaving an invisible object behind.
  const effect = empty ? { type: "discardEdit", id } : { type: "commitEdit", id };
  const next = idle(state, { editingId: null, selection: empty ? [] : [id], tool: staysActive(state) ? state.tool : "select" });
  return done(next, effect);
}

function cancelGesture(state) {
  if (GESTURE_MODES.has(state.mode)) return done(idle(state), { type: "cancelGesture" });
  // a press while placing is given up, the picture stays on the pointer
  if (state.mode === "placing" && state.gesture?.start) return done({ ...state, gesture: { payload: state.gesture.payload, at: null } }, { type: "cancelGesture" });
  return done(state);
}

function onKey(state, event, ctx) {
  if (event.key === "Space" || event.key === " ") {
    if (state.mode === "editingText") return done(state);
    const held = event.phase !== "up";
    return done(held === state.spaceHeld ? state : { ...state, spaceHeld: held });
  }
  if (event.phase === "up") return done(state);

  if (event.key === "Escape") {
    // The cascade: each press undoes exactly one level.
    if (GESTURE_MODES.has(state.mode)) return cancelGesture(state);
    if (state.mode === "placing") return done(idle(state, { tool: "select", toolLocked: false }), { type: "cancelGesture" });
    if (state.mode === "editingText") return commitText(state, event.empty);
    if (state.selection.length) return done({ ...state, selection: [] });
    if (state.tool !== "select") return done({ ...state, tool: "select", toolLocked: false });
    return done(state, { type: "unhandledEscape" }); // lets the shell close a panel or leave full screen
  }
  if (state.mode !== "idle") return done(state);

  // "Delete" only: Backspace is not a delete key on Windows and Linux (Telex input methods send it to
  // rewrite a letter). On macOS keymap.js maps Backspace to the "delete" shortcut.
  if (event.key === "Delete" && state.selection.length) {
    return done({ ...state, selection: [] }, { type: "delete", ids: state.selection });
  }
  if ((event.key === "Enter" || event.key === "F2") && state.selection.length === 1) {
    const id = state.selection[0];
    if (ctx.objectType?.(id) === "text") return done({ ...state, mode: "editingText", editingId: id }, { type: "beginEdit", id });
  }
  return done(state);
}

function onShortcut(state, event, ctx) {
  const id = event.id;
  if (typeof id !== "string") return done(state);
  if (id.startsWith("tool:")) return event.phase === "up" ? done(state) : onTool(state, { type: "tool", tool: id.slice(5), empty: event.empty });
  switch (id) {
    case "escape":
      return onKey(state, { key: "Escape", phase: event.phase, empty: event.empty }, ctx);
    case "delete":
      return onKey(state, { key: "Delete", phase: event.phase }, ctx);
    case "editObject":
      return onKey(state, { key: "Enter", phase: event.phase }, ctx);
    case "tempHand":
      return onKey(state, { key: "Space", phase: event.phase }, ctx);
    default:
      return done(state);
  }
}

function onTextSelection(state, event) {
  if (state.mode !== "idle" || !TEXT_MARK_TOOLS.includes(state.tool)) return done(state);
  const effect = { type: "create", tool: state.tool, objectType: toolById(state.tool).creates, pageId: event.pageId ?? null, textSelection: true };
  if (event.lineId !== undefined) effect.lineId = event.lineId;
  // a redaction is selected so that Delete removes a slip at once; highlights never select themselves
  return done(state.tool === "redact" ? { ...state, selection: [NEW_ID] } : state, effect);
}

function onCreated(state, event) {
  const ids = Array.isArray(event.ids) ? event.ids.filter((id) => typeof id === "string" && id) : [];
  let next = state;
  if (state.selection.includes(NEW_ID)) next = { ...next, selection: [...state.selection.filter((id) => id !== NEW_ID), ...ids] };
  if (state.editingId === NEW_ID) next = ids.length ? { ...next, editingId: ids[0] } : idle(next, { editingId: null });
  return done(next);
}

function onSetSelection(state, event) {
  if (state.mode === "editingText") return done(state);
  const ids = [...new Set((Array.isArray(event.ids) ? event.ids : []).filter((id) => typeof id === "string" && id))];
  const selection = event.additive ? [...state.selection, ...ids.filter((id) => !state.selection.includes(id))] : ids;
  return done({ ...state, selection });
}

function onDocumentChanged(state, ctx) {
  if (typeof ctx.objectExists !== "function") return done(state);
  const exists = (id) => id === NEW_ID || Boolean(ctx.objectExists(id));
  const selection = state.selection.filter(exists);
  let next = selection.length === state.selection.length ? state : { ...state, selection };
  if (state.mode === "editingText" && state.editingId && !exists(state.editingId)) {
    return done(idle(next, { editingId: null }), { type: "cancelEdit", id: state.editingId });
  }
  if ((state.mode === "resizing" || state.mode === "rotating") && !exists(state.gesture.id)) next = idle(next);
  else if (state.mode === "moving" && !selection.length) next = idle(next);
  return next.mode !== state.mode ? done(next, { type: "cancelGesture" }) : done(next);
}

/**
 * The CSS cursor over a page (UX specification, section 4.1).
 * @param {object} state    interaction state
 * @param {object} [target] what is under the pointer (same shape as in events)
 * @param {{ busy?: boolean, screenRotation?: number }} [options]
 *        busy: a job runs; screenRotation: clockwise rotation on screen of the box whose handle is under the
 *        pointer (model/transform.js screenRotationOf), so that resize arrows point the right way
 */
export function cursorFor(state, target = { kind: "outside" }, { busy = false, screenRotation = 0 } = {}) {
  if (busy) return "progress";
  if (state.mode === "panning") return "grabbing";
  if (state.tool === "hand" || state.spaceHeld) return "grab";
  if (state.mode === "placing") return target.kind === "outside" ? "not-allowed" : "copy";
  if (state.mode === "moving") return "move";
  if (state.mode === "rotating") return "grabbing";
  if (state.mode === "resizing") return resizeCursor(state.gesture.handle, screenRotation);
  if ((target.kind === "handle" || target.kind === "rotate") && (state.tool === "select" || state.selection.includes(target.id))) {
    return target.kind === "rotate" ? "grab" : resizeCursor(target.handle, screenRotation);
  }
  if (state.tool === "select") {
    if (target.kind === "object") return "move";
    return target.kind === "text" || target.kind === "textline" ? "text" : "default";
  }
  if (state.tool === "eraser") return "cell";
  if (target.kind === "outside") return "not-allowed";
  if (TEXT_MARK_TOOLS.includes(state.tool) && (target.kind === "text" || target.kind === "textline")) return "text";
  return toolById(state.tool)?.cursor ?? "default";
}
