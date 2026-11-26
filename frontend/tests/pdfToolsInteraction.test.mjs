// The pointer / keyboard state machine of the page overlay (src/pages/pdfEditor/tools/interaction.js).
// The first twenty tests are the behavioural tests of the UX prototype, adapted to the product reducer
// (effects carry the tool, the schema object type and the page; selection lives in the state only).
import test from "node:test";
import assert from "node:assert/strict";
import { deepFreeze } from "../src/pages/pdfEditor/model/shapes.js";
import {
  AREA_TOOLS,
  DRAG_THRESHOLD,
  ERASABLE_TYPES,
  HINTS,
  NEW_ID,
  PLACE_TOOLS,
  REDUCER_SHORTCUTS,
  SIGNATURE_FIELD_ID,
  SIGNATURE_FIELD_TYPE,
  STROKE_TOOLS,
  TEXT_MARK_TOOLS,
  cursorFor,
  initialState,
  step
} from "../src/pages/pdfEditor/tools/interaction.js";
import { matchShortcut } from "../src/pages/pdfEditor/tools/keymap.js";
import { TOOLS, toolById } from "../src/pages/pdfEditor/tools/registry.js";

/** Runs a list of events; every state is frozen first, so a reducer that mutates its input fails. */
function run(events, start = initialState(), ctx = {}) {
  let state = start;
  const effects = [];
  for (const event of events) {
    const result = step(deepFreeze(state), event, ctx);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects, types: effects.map((effect) => effect.type) };
}
const PAGE = "page_1";
const down = (x, y, target, extra = {}) => ({ type: "pointerdown", pageId: PAGE, x, y, button: 0, pointerType: "mouse", target, ...extra });
const move = (x, y, extra = {}) => ({ type: "pointermove", x, y, ...extra });
const up = (x, y, extra = {}) => ({ type: "pointerup", x, y, ...extra });
const key = (name, extra = {}) => ({ type: "key", key: name, phase: "down", ...extra });
const tool = (id, extra = {}) => ({ type: "tool", tool: id, ...extra });
const page = { kind: "page" };
const obj = (id, type = "rect") => ({ kind: "object", id, type });
const moveEffect = (ids, from, to, extra = {}) => ({ type: "move", ids, pageId: PAGE, from, to, dx: to.x - from.x, dy: to.y - from.y, axisLock: false, duplicate: false, drop: null, ...extra });

// --- the twenty tests of the prototype ---

test("select: click selects, click on empty page deselects, shift-click toggles", () => {
  let r = run([down(10, 10, obj("a")), up(10, 10)]);
  assert.deepEqual(r.state.selection, ["a"]);
  assert.equal(r.state.mode, "idle");
  r = run([down(50, 50, obj("b"), { shift: true })], r.state);
  assert.deepEqual(r.state.selection, ["a", "b"]);
  r = run([down(50, 50, obj("b"), { shift: true })], r.state);
  assert.deepEqual(r.state.selection, ["a"]);
  r = run([down(300, 300, page), up(300, 300)], r.state);
  assert.deepEqual(r.state.selection, []);
  assert.deepEqual(r.effects, [], "selecting is interaction state: no command leaves the reducer");
});

test("select: a press becomes a move only past the drag threshold, and commits once", () => {
  const small = run([down(10, 10, obj("a")), move(12, 11), up(12, 11)]);
  assert.deepEqual(small.types, [], "a 2 px wobble is a click, not a move");
  assert.deepEqual(small.state.selection, ["a"]);
  const moved = run([down(10, 10, obj("a")), move(20, 10), move(40, 30), up(40, 30)]);
  assert.deepEqual(moved.types, ["move"]);
  assert.deepEqual(moved.effects[0], moveEffect(["a"], { x: 10, y: 10 }, { x: 40, y: 30 }));
  assert.deepEqual([moved.effects[0].dx, moved.effects[0].dy], [30, 20]);
  // touch needs a longer travel
  const touch = run([down(10, 10, obj("a"), { pointerType: "touch" }), move(10 + DRAG_THRESHOLD.touch - 1, 10), up(18, 10)]);
  assert.deepEqual(touch.types, []);
  assert.deepEqual(DRAG_THRESHOLD, { mouse: 4, pen: 6, touch: 10 });
});

test("select: dragging one member moves the whole multi-selection; a plain click reduces it", () => {
  const start = { ...initialState(), selection: ["a", "b"] };
  const dragged = run([down(10, 10, obj("a")), move(30, 10), up(30, 10)], start);
  assert.deepEqual(dragged.effects, [moveEffect(["a", "b"], { x: 10, y: 10 }, { x: 30, y: 10 })]);
  assert.deepEqual(dragged.state.selection, ["a", "b"]);
  const clicked = run([down(10, 10, obj("a")), up(10, 10)], start);
  assert.deepEqual(clicked.state.selection, ["a"]);
});

test("select: handles resize and rotate without a threshold; marquee on empty page; alt-drag duplicates", () => {
  const start = { ...initialState(), selection: ["a"] };
  const resized = run([down(100, 100, { kind: "handle", id: "a", handle: "se" }), move(101, 101), up(120, 130)], start);
  assert.deepEqual(resized.effects, [{ type: "resize", id: "a", pageId: PAGE, handle: "se", dx: 20, dy: 30, invertRatioLock: false }]);
  const rotated = run([down(50, 0, { kind: "rotate", id: "a" }), move(80, 20, { shift: true }), up(80, 20)], start);
  assert.deepEqual(rotated.effects, [{ type: "rotate", id: "a", pageId: PAGE, from: { x: 50, y: 0 }, to: { x: 80, y: 20 }, snap: true }]);
  const marquee = run([down(10, 10, page), move(100, 80), up(100, 80)], start);
  assert.deepEqual(marquee.effects, [{ type: "marqueeSelect", pageId: PAGE, rect: { x: 10, y: 10, width: 90, height: 70 }, additive: false }]);
  assert.deepEqual(marquee.state.selection, ["a"], "the selection changes when the overlay answers with setSelection");
  // Alt-drag: ONE effect at the end (the store duplicates and moves in one transaction), nothing before it
  const copy = run([down(10, 10, obj("a"), { alt: true }), move(40, 10), up(40, 10)], start);
  assert.deepEqual(copy.effects, [moveEffect(["a"], { x: 10, y: 10 }, { x: 40, y: 10 }, { duplicate: true })]);
  assert.deepEqual(copy.state.selection, [NEW_ID], "the copies become the selection");
  const cancelled = run([down(10, 10, obj("a"), { alt: true }), move(40, 10), key("Escape")], start);
  assert.deepEqual(cancelled.types, ["cancelGesture"], "a cancelled Alt-drag never touched the document");
});

test("select: document text is left to native selection", () => {
  const r = run([down(10, 10, { kind: "text" }), move(80, 10), up(80, 10)]);
  assert.deepEqual(r.effects, []);
  assert.equal(r.state.mode, "idle");
  const withSelection = run([down(10, 10, { kind: "text" })], { ...initialState(), selection: ["a"] });
  assert.deepEqual(withSelection.state.selection, [], "the handles of a selected object get out of the way");
});

test("shape tool is one-shot: drag creates, selects the new object and returns to Select", () => {
  const r = run([tool("rect"), down(10, 10, page), move(110, 60), up(110, 60)]);
  assert.deepEqual(r.effects, [{ type: "create", tool: "rect", objectType: "rect", pageId: PAGE, from: { x: 10, y: 10 }, to: { x: 110, y: 60 }, rect: { x: 10, y: 10, width: 100, height: 50 }, constrain: false }]);
  assert.equal(r.state.tool, "select");
  assert.deepEqual(r.state.selection, [NEW_ID]);
  const click = run([tool("ellipse"), down(10, 10, page), up(10, 10)]);
  assert.deepEqual(click.effects, [{ type: "create", tool: "ellipse", objectType: "ellipse", pageId: PAGE, at: { x: 10, y: 10 } }]);
  const arrow = run([tool("arrow"), down(0, 0, page), move(50, 50, { shift: true }), up(50, 50)]);
  assert.deepEqual(arrow.effects[0], { type: "create", tool: "arrow", objectType: "line", pageId: PAGE, from: { x: 0, y: 0 }, to: { x: 50, y: 50 }, constrain: true }, "an arrow is a line in the data model");
});

test("a locked one-shot tool stays active", () => {
  const r = run([tool("rect", { lock: true }), down(10, 10, page), move(60, 60), up(60, 60)]);
  assert.equal(r.state.tool, "rect");
  assert.equal(r.state.toolLocked, true);
  assert.equal(run([key("Escape"), key("Escape")], r.state).state.toolLocked, false, "Escape releases the lock with the tool");
});

test("redact is sticky; a click (no drag) marks the text line or a default-size area", () => {
  const r = run([tool("redact"), down(10, 10, page), move(200, 40), up(200, 40)]);
  assert.equal(r.effects[0].type, "create");
  assert.equal(r.effects[0].objectType, "redact");
  assert.equal(r.state.tool, "redact", "stays in Redact to mark the next area");
  assert.deepEqual(r.state.selection, [NEW_ID], "the new mark is selected so that Delete removes a slip at once");
  const click = run([tool("redact"), down(10, 10, page), up(11, 10)]);
  assert.deepEqual(click.effects, [{ type: "create", tool: "redact", objectType: "redact", pageId: PAGE, at: { x: 11, y: 10 } }]);
  const line = run([tool("redact"), down(10, 10, { kind: "textline", id: "p1-l4" }), up(10, 10)]);
  assert.deepEqual(line.effects, [{ type: "create", tool: "redact", objectType: "redact", pageId: PAGE, at: { x: 10, y: 10 }, lineId: "p1-l4" }]);
  assert.equal(line.state.tool, "redact");
  assert.equal(run([tool("blur"), down(10, 10, page), up(10, 10)]).effects[0].objectType, "blur");
});

test("pen is sticky: every stroke is one create, nothing gets selected, a tap is a dot", () => {
  const r = run([tool("pen"), down(0, 0, page), move(5, 5), move(9, 9), up(10, 10), down(20, 20, page), up(20, 20)]);
  assert.deepEqual(r.types, ["create", "create"]);
  assert.equal(r.effects[0].points.length, 4);
  assert.equal(r.effects[1].points.length, 2);
  assert.deepEqual([r.effects[0].tool, r.effects[0].objectType], ["pen", "pen"]);
  assert.equal(r.state.tool, "pen");
  assert.deepEqual(r.state.selection, []);
  const marker = run([tool("highlighter"), down(0, 0, page), move(30, 0), up(60, 0)]);
  assert.deepEqual([marker.effects[0].tool, marker.effects[0].objectType], ["highlighter", "highlight"]);
});

test("text tool: click creates an auto-width box and starts editing; Escape commits and returns to Select", () => {
  let r = run([tool("text"), down(40, 40, page), up(40, 40)]);
  assert.deepEqual(r.effects, [{ type: "create", tool: "text", objectType: "text", pageId: PAGE, at: { x: 40, y: 40 }, autoWidth: true }]);
  assert.equal(r.state.mode, "editingText");
  assert.equal(r.state.editingId, NEW_ID);
  r = run([key("Escape")], r.state);
  assert.deepEqual(r.effects, [{ type: "commitEdit", id: NEW_ID }]);
  assert.equal(r.state.tool, "select");
  assert.deepEqual(r.state.selection, [NEW_ID]);
  const dragged = run([tool("text"), down(40, 40, page), move(240, 60), up(240, 60)]);
  assert.deepEqual(dragged.effects[0], { type: "create", tool: "text", objectType: "text", pageId: PAGE, from: { x: 40, y: 40 }, to: { x: 240, y: 60 }, rect: { x: 40, y: 40, width: 200, height: 20 }, autoWidth: false });
});

test("text tool: an empty box is discarded; a press outside commits and then acts", () => {
  let r = run([tool("text"), down(40, 40, page), up(40, 40), key("Escape", { empty: true })]);
  assert.deepEqual(r.effects.at(-1), { type: "discardEdit", id: NEW_ID });
  assert.deepEqual(r.state.selection, []);
  r = run([tool("text"), down(40, 40, page), up(40, 40), down(300, 300, obj("z")), up(300, 300)]);
  assert.deepEqual(r.types, ["create", "commitEdit"]);
  assert.deepEqual(r.state.selection, ["z"]);
  const blurred = run([tool("text"), down(40, 40, page), up(40, 40), { type: "editorBlur", empty: false }]);
  assert.deepEqual(blurred.types, ["create", "commitEdit"]);
  assert.equal(blurred.state.mode, "idle");
  assert.deepEqual(run([{ type: "editorBlur" }]).effects, [], "a blur without an editor is nothing");
});

test("double-click or Enter on a text object starts editing; Enter does nothing for a shape", () => {
  const dbl = run([{ type: "dblclick", target: obj("t", "text") }]);
  assert.equal(dbl.state.mode, "editingText");
  assert.equal(dbl.state.editingId, "t");
  assert.deepEqual(dbl.effects, [{ type: "beginEdit", id: "t" }]);
  const ctx = { objectType: (id) => (id === "t" ? "text" : "rect") };
  const enter = run([key("Enter")], { ...initialState(), selection: ["t"] }, ctx);
  assert.deepEqual(enter.effects, [{ type: "beginEdit", id: "t" }]);
  assert.deepEqual(run([key("F2")], { ...initialState(), selection: ["t"] }, ctx).effects, [{ type: "beginEdit", id: "t" }]);
  const shape = run([key("Enter")], { ...initialState(), selection: ["r"] }, ctx);
  assert.deepEqual(shape.effects, []);
  assert.deepEqual(run([{ type: "dblclick", target: obj("r", "rect") }]).effects, []);
  // an existing box that is committed stays selected, with the Select tool
  const committed = run([key("Escape")], dbl.state);
  assert.deepEqual(committed.effects, [{ type: "commitEdit", id: "t" }]);
  assert.deepEqual([committed.state.tool, committed.state.selection, committed.state.editingId], ["select", ["t"], null]);
});

test("edit text tool: clicking a document line replaces it; clicking elsewhere hints", () => {
  const r = run([tool("editText"), down(10, 10, { kind: "textline", id: "p3-l12" })]);
  assert.deepEqual(r.effects, [{ type: "replaceTextLine", pageId: PAGE, lineId: "p3-l12" }]);
  assert.equal(r.state.mode, "editingText");
  const committed = run([key("Escape")], r.state);
  assert.equal(committed.state.tool, "editText", "sticky: the next line can be clicked right away");
  const miss = run([tool("editText"), down(10, 10, page)]);
  assert.deepEqual(miss.effects, [{ type: "hint", id: "editTextNoLine", message: HINTS.editTextNoLine }]);
  assert.match(HINTS.editTextNoLine, /^Click a line of text/);
});

test("image / signature: picker, ghost placement by click or drag, Escape cancels", () => {
  let r = run([tool("image")]);
  assert.deepEqual(r.effects, [{ type: "openPicker", tool: "image" }]);
  r = run([{ type: "placeReady", payload: "img1" }, move(50, 50, { pageId: "page_2" })], r.state);
  assert.equal(r.state.mode, "placing");
  assert.deepEqual(r.state.gesture.at, { x: 50, y: 50 });
  assert.equal(r.state.gesture.pageId, "page_2", "the ghost knows the page it is over");
  const placed = run([down(50, 50, page), up(50, 50)], r.state);
  assert.deepEqual(placed.effects, [{ type: "create", tool: "image", objectType: "image", pageId: PAGE, payload: "img1", at: { x: 50, y: 50 } }]);
  assert.equal(placed.state.tool, "select");
  assert.deepEqual(placed.state.selection, [NEW_ID]);
  const sized = run([down(50, 50, page), move(150, 120), up(150, 120)], r.state);
  assert.equal(sized.effects[0].keepRatio, true);
  assert.deepEqual(sized.effects[0].rect, { x: 50, y: 50, width: 100, height: 70 });
  assert.deepEqual([sized.effects[0].from, sized.effects[0].to], [{ x: 50, y: 50 }, { x: 150, y: 120 }]);
  const cancelled = run([key("Escape")], r.state);
  assert.equal(cancelled.state.tool, "select");
  assert.deepEqual(cancelled.types, ["cancelGesture"]);
  const signature = run([tool("signature"), { type: "placeReady", payload: { assetId: "a1" } }, down(5, 5, page), up(5, 5)]);
  assert.deepEqual(signature.effects.at(-1), { type: "create", tool: "signature", objectType: "image", pageId: PAGE, payload: { assetId: "a1" }, at: { x: 5, y: 5 } });
});

test("eraser removes each object once per drag and commits one undo step", () => {
  const r = run([
    tool("eraser"),
    down(0, 0, obj("s1", "pen")),
    move(5, 5, { target: obj("s1", "pen") }),
    move(9, 9, { target: obj("s2", "highlight") }),
    up(9, 9)
  ]);
  assert.deepEqual(r.types, ["erase", "erase", "commitErase"]);
  assert.deepEqual(r.effects.at(-1).ids, ["s1", "s2"]);
  assert.equal(r.state.tool, "eraser");
});

test("hand tool and held Space pan without touching the document", () => {
  const hand = run([tool("hand"), down(10, 10, obj("a")), move(30, 25), up(30, 25)]);
  assert.deepEqual(hand.effects, [{ type: "pan", dx: 20, dy: 15 }]);
  assert.deepEqual(hand.state.selection, []);
  const space = run([key("Space"), down(10, 10, obj("a")), move(15, 10), up(15, 10), { type: "key", key: "Space", phase: "up" }]);
  assert.deepEqual(space.types, ["pan"]);
  assert.equal(space.state.spaceHeld, false);
  assert.deepEqual(space.state.selection, []);
});

test("Escape cascade: gesture, then selection, then tool, then the shell", () => {
  let r = run([tool("redact"), down(10, 10, page), move(90, 90), key("Escape")]);
  assert.deepEqual(r.types, ["cancelGesture"]);
  assert.equal(r.state.tool, "redact");
  assert.equal(r.state.mode, "idle");
  r = run([key("Escape")], r.state);
  assert.equal(r.state.tool, "select");
  r = run([down(10, 10, obj("a")), up(10, 10), key("Escape")], r.state);
  assert.deepEqual(r.state.selection, []);
  r = run([key("Escape")], r.state);
  assert.deepEqual(r.types, ["unhandledEscape"]);
});

test("a move interrupted by Escape, pointercancel or a second finger changes nothing", () => {
  for (const interrupt of [key("Escape"), { type: "pointercancel" }, { type: "multitouch" }]) {
    const r = run([down(10, 10, obj("a")), move(60, 60), interrupt, up(60, 60)]);
    assert.deepEqual(r.types, ["cancelGesture"], interrupt.type);
    assert.equal(r.state.mode, "idle");
    assert.equal(r.state.gesture, null);
  }
});

test("Delete removes the selection; right button and presses outside a page are ignored by creation tools", () => {
  const del = run([key("Delete")], { ...initialState(), selection: ["a", "b"] });
  assert.deepEqual(del.effects, [{ type: "delete", ids: ["a", "b"] }]);
  assert.deepEqual(del.state.selection, []);
  const right = run([down(10, 10, obj("a"), { button: 2 })]);
  assert.deepEqual(right.state.selection, []);
  const outside = run([tool("rect"), down(10, 10, { kind: "outside" }), move(90, 90), up(90, 90)]);
  assert.deepEqual(outside.effects, []);
  assert.equal(outside.state.tool, "rect");
});

test("switching tool while typing commits the text; switching away from Select clears the selection", () => {
  const typing = run([tool("text"), down(40, 40, page), up(40, 40), tool("pen")]);
  assert.deepEqual(typing.types, ["create", "commitEdit"]);
  assert.equal(typing.state.tool, "pen");
  assert.deepEqual(typing.state.selection, []);
  assert.equal(typing.state.editingId, null);
  const kept = run([tool("select")], { ...initialState(), selection: ["a"] });
  assert.deepEqual(kept.state.selection, ["a"]);
  assert.deepEqual(run([tool("laser")], { ...initialState(), selection: ["a"] }).state.selection, ["a"], "an unknown tool is ignored");
});

// --- what the product reducer adds ---

test("Backspace never deletes; the keymap turns the platform's delete key into the shortcut the reducer takes", () => {
  const start = { ...initialState(), selection: ["a"] };
  assert.deepEqual(run([key("Backspace")], start).effects, [], "Telex input methods send Backspace to rewrite a letter");
  const event = { key: "Backspace", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(matchShortcut(event, "selection"), null, "Windows and Linux");
  const id = matchShortcut(event, "selection", { mac: true });
  assert.deepEqual(run([{ type: "shortcut", id }], start).effects, [{ type: "delete", ids: ["a"] }], "macOS: the Delete key is Backspace");
});

test("shortcut events: tools, Escape, Delete, Enter and the held Space; everything else is the shell's", () => {
  assert.deepEqual(REDUCER_SHORTCUTS, ["escape", "delete", "editObject", "tempHand"]);
  for (const entry of TOOLS) {
    const r = run([{ type: "shortcut", id: `tool:${entry.id}` }]);
    assert.equal(r.state.tool, entry.id);
    assert.deepEqual(r.types, entry.picker ? ["openPicker"] : []);
  }
  assert.equal(run([{ type: "shortcut", id: "tool:rect", phase: "up" }]).state.tool, "select");
  const start = { ...initialState(), selection: ["t"] };
  const ctx = { objectType: () => "text" };
  assert.deepEqual(run([{ type: "shortcut", id: "editObject" }], start, ctx).effects, [{ type: "beginEdit", id: "t" }]);
  assert.deepEqual(run([{ type: "shortcut", id: "escape" }], start).state.selection, []);
  assert.deepEqual(run([{ type: "shortcut", id: "escape", empty: true }], { ...start, mode: "editingText", editingId: "t" }).effects, [{ type: "discardEdit", id: "t" }]);
  const held = run([{ type: "shortcut", id: "tempHand" }]);
  assert.equal(held.state.spaceHeld, true);
  assert.equal(run([{ type: "shortcut", id: "tempHand", phase: "up" }], held.state).state.spaceHeld, false);
  for (const id of ["undo", "copy", "nudge", "zoomIn", 7, undefined]) {
    const r = run([{ type: "shortcut", id }], start);
    assert.deepEqual([r.state, r.effects], [start, []], `${id} is not the reducer's business`);
  }
  // Space while typing belongs to the text; Delete and Enter do nothing during a gesture
  const typing = { ...initialState(), mode: "editingText", editingId: "t" };
  assert.equal(run([key("Space")], typing).state.spaceHeld, false);
  assert.deepEqual(run([down(10, 10, obj("a")), move(50, 50), key("Delete")]).types, []);
  assert.equal(run([{ type: "nonsense" }]).state.mode, "idle");
  assert.deepEqual(step(start, null).effects, [], "an event that is none changes nothing");
  assert.equal(step(start, undefined).state, start);
});

test("handles belong to the selection: a mark that was just drawn can be adjusted without leaving the tool", () => {
  let r = run([tool("redact"), down(10, 10, page), move(110, 40), up(110, 40), { type: "created", ids: ["m1"] }]);
  assert.deepEqual(r.state.selection, ["m1"]);
  assert.equal(r.state.tool, "redact");
  const resized = run([down(110, 40, { kind: "handle", id: "m1", handle: "se" }), move(130, 60), up(130, 60)], r.state);
  assert.deepEqual(resized.effects, [{ type: "resize", id: "m1", pageId: PAGE, handle: "se", dx: 20, dy: 20, invertRatioLock: false }]);
  assert.deepEqual(resized.state.selection, ["m1"]);
  assert.equal(resized.state.tool, "redact");
  // a press on the body of the selected mark (or on a handle of something else) draws the next mark
  const next = run([down(50, 20, obj("m1", "redact")), move(90, 90), up(90, 90)], r.state);
  assert.equal(next.effects[0].type, "create");
  const other = run([down(50, 20, { kind: "handle", id: "x", handle: "se" }), move(90, 90), up(90, 90)], r.state);
  assert.equal(other.effects[0].type, "create");
  r = run([key("Delete")], r.state);
  assert.deepEqual(r.effects, [{ type: "delete", ids: ["m1"] }]);
});

test("created resolves the placeholder id in the selection and in the editor", () => {
  let r = run([tool("rect"), down(10, 10, page), up(10, 10)]);
  assert.deepEqual(r.state.selection, [NEW_ID]);
  r = run([{ type: "created", ids: ["o_1"] }], r.state);
  assert.deepEqual(r.state.selection, ["o_1"]);
  assert.deepEqual(r.effects, []);
  assert.deepEqual(run([{ type: "created", ids: [] }], { ...initialState(), selection: [NEW_ID, "a"] }).state.selection, ["a"], "nothing was created");
  assert.deepEqual(run([{ type: "created", ids: ["m1", "m2"] }], { ...initialState(), selection: [NEW_ID] }).state.selection, ["m1", "m2"], "one redaction per text line");
  assert.deepEqual(run([{ type: "created", ids: ["x"] }], { ...initialState(), selection: ["a"] }).state.selection, ["a"], "no placeholder, no change");
  // a new text box: the editor works on a draft; after commitEdit the store adds the object
  let text = run([tool("text"), down(40, 40, page), up(40, 40), key("Escape")]);
  text = run([{ type: "created", ids: ["t_9"] }], text.state);
  assert.deepEqual([text.state.selection, text.state.editingId, text.state.mode], [["t_9"], null, "idle"]);
  const failed = run([{ type: "created", ids: [] }], { ...initialState(), mode: "editingText", editingId: NEW_ID });
  assert.deepEqual([failed.state.mode, failed.state.editingId], ["idle", null]);
  assert.equal(run([{ type: "created", ids: ["t_1"] }], { ...initialState(), mode: "editingText", editingId: NEW_ID }).state.editingId, "t_1");
});

test("setSelection and documentChanged keep the selection in step with the document", () => {
  const start = { ...initialState(), selection: ["a"] };
  assert.deepEqual(run([{ type: "setSelection", ids: ["b", "c", "b", 5] }], start).state.selection, ["b", "c"]);
  assert.deepEqual(run([{ type: "setSelection", ids: ["b", "a"], additive: true }], start).state.selection, ["a", "b"]);
  assert.deepEqual(run([{ type: "setSelection" }], start).state.selection, []);
  const typing = { ...start, mode: "editingText", editingId: "a" };
  assert.deepEqual(run([{ type: "setSelection", ids: [] }], typing).state.selection, ["a"], "not while typing");

  const exists = (ids) => ({ objectExists: (id) => ids.includes(id) });
  const many = { ...initialState(), selection: ["a", "b", NEW_ID, SIGNATURE_FIELD_ID] };
  const pruned = run([{ type: "documentChanged" }], many, exists(["b", SIGNATURE_FIELD_ID]));
  assert.deepEqual(pruned.state.selection, ["b", NEW_ID, SIGNATURE_FIELD_ID], "the overlay answers for the certificate rectangle too");
  assert.deepEqual(pruned.effects, []);
  assert.equal(run([{ type: "documentChanged" }], many, exists(["a", "b", SIGNATURE_FIELD_ID])).state, many, "nothing vanished: the same state");
  assert.equal(run([{ type: "documentChanged" }], many).state, many, "without objectExists nothing can be decided");
  // undo removed the box that is being edited, or the object of a running gesture
  const editing = run([{ type: "documentChanged" }], typing, exists([]));
  assert.deepEqual(editing.effects, [{ type: "cancelEdit", id: "a" }]);
  assert.deepEqual([editing.state.mode, editing.state.editingId, editing.state.selection], ["idle", null, []]);
  const resizing = run([down(5, 5, { kind: "handle", id: "a", handle: "e" })], start);
  assert.deepEqual(run([{ type: "documentChanged" }], resizing.state, exists([])).types, ["cancelGesture"]);
  const moving = run([down(5, 5, obj("a")), move(50, 50)], start);
  const stopped = run([{ type: "documentChanged" }], moving.state, exists([]));
  assert.deepEqual([stopped.types, stopped.state.mode], [["cancelGesture"], "idle"]);
  assert.equal(run([{ type: "documentChanged" }], moving.state, exists(["a"])).state.mode, "moving");
});

test("Highlighter and Redact over document text mark the native text selection", () => {
  const press = run([tool("highlighter"), down(10, 10, { kind: "text" }), move(90, 10), up(90, 10)]);
  assert.deepEqual(press.effects, [], "the browser selects the text");
  assert.equal(press.state.mode, "idle");
  const highlight = run([{ type: "textSelection", pageId: PAGE }], press.state);
  assert.deepEqual(highlight.effects, [{ type: "create", tool: "highlighter", objectType: "highlight", pageId: PAGE, textSelection: true }]);
  assert.deepEqual(highlight.state.selection, [], "highlights never select themselves");
  const redact = run([tool("redact"), { type: "textSelection", pageId: PAGE, lineId: "l3" }]);
  assert.deepEqual(redact.effects, [{ type: "create", tool: "redact", objectType: "redact", pageId: PAGE, textSelection: true, lineId: "l3" }]);
  assert.deepEqual(redact.state.selection, [NEW_ID]);
  assert.deepEqual(run([{ type: "textSelection", pageId: PAGE }]).effects, [], "with Select the popover offers Copy / Highlight / Redact instead");
  assert.deepEqual(run([tool("pen"), { type: "textSelection", pageId: PAGE }]).effects, []);
  assert.deepEqual(TEXT_MARK_TOOLS, ["highlighter", "redact"]);
});

test("context menu: the object under the pointer becomes the selection; outside the pages the browser keeps its menu", () => {
  const start = { ...initialState(), selection: ["a", "b"] };
  const onMember = run([{ type: "contextmenu", pageId: PAGE, x: 5, y: 6, target: obj("a") }], start);
  assert.deepEqual(onMember.state.selection, ["a", "b"], "a member of the selection keeps the selection");
  assert.deepEqual(onMember.effects, [{ type: "contextMenu", menu: "object", pageId: PAGE, x: 5, y: 6, target: obj("a"), ids: ["a", "b"] }]);
  const onOther = run([{ type: "contextmenu", pageId: PAGE, x: 5, y: 6, target: obj("z", "text") }], start);
  assert.deepEqual(onOther.state.selection, ["z"]);
  assert.deepEqual(onOther.effects[0].ids, ["z"]);
  const onPage = run([{ type: "contextmenu", pageId: PAGE, x: 5, y: 6, target: page }], start);
  assert.deepEqual([onPage.effects[0].menu, onPage.state.selection], ["page", []]);
  assert.equal(run([{ type: "contextmenu", pageId: PAGE, x: 5, y: 6, target: { kind: "text" } }], start).effects[0].menu, "text");
  assert.deepEqual(run([{ type: "contextmenu", x: 5, y: 6, target: { kind: "outside" } }], start).effects, []);
  assert.deepEqual(run([{ type: "contextmenu", x: 5, y: 6 }], start).effects, []);
  const typing = { ...initialState(), mode: "editingText", editingId: "t" };
  assert.deepEqual(run([{ type: "contextmenu", pageId: PAGE, x: 1, y: 1, target: page }], typing).effects, [], "the text editor keeps the native menu");
});

test("placing: a locked tool places again, Shift releases the ratio, the backdrop is no place, a cancelled press keeps the picture", () => {
  const ready = run([tool("signature", { lock: true }), { type: "placeReady", payload: "sig" }]);
  const first = run([down(50, 50, page), up(50, 50)], ready.state);
  assert.deepEqual([first.state.tool, first.state.mode, first.state.gesture], ["signature", "placing", { payload: "sig", at: null }], "ready for the next page");
  assert.deepEqual(first.state.selection, [NEW_ID]);
  const second = run([down(80, 80, page), up(80, 80)], first.state);
  assert.deepEqual(second.types, ["create"]);
  const free = run([down(50, 50, page, { shift: true }), move(150, 60), up(150, 60)], ready.state);
  assert.equal(free.effects[0].keepRatio, false);
  const late = run([down(50, 50, page), move(150, 60, { shift: true }), up(150, 60)], ready.state);
  assert.equal(late.effects[0].keepRatio, false, "Shift pressed during the drag counts");
  const backdrop = run([down(50, 50, { kind: "outside" }), up(50, 50)], ready.state);
  assert.deepEqual(backdrop.effects, []);
  assert.equal(backdrop.state.mode, "placing");
  const cancelled = run([down(50, 50, page), move(90, 90), { type: "multitouch" }], ready.state);
  assert.deepEqual(cancelled.types, ["cancelGesture"]);
  assert.deepEqual([cancelled.state.mode, cancelled.state.gesture], ["placing", { payload: "sig", at: null }]);
  assert.deepEqual(run([{ type: "pointercancel" }], ready.state).effects, [], "nothing was pressed");
  // the picker answers after the user went on to another tool: ignored
  assert.equal(run([tool("image"), tool("pen"), { type: "placeReady", payload: "x" }]).state.mode, "idle");
  assert.deepEqual(PLACE_TOOLS, ["image", "signature"]);
});

test("a move that ends over another page says where; within the page there is no drop", () => {
  const start = { ...initialState(), selection: ["a"] };
  const dropped = run([down(10, 10, obj("a")), move(60, 300, { over: { pageId: "page_2", x: 60, y: 20 } }), up(60, 320, { over: { pageId: "page_2", x: 60, y: 40 } })], start);
  assert.deepEqual(dropped.effects, [moveEffect(["a"], { x: 10, y: 10 }, { x: 60, y: 320 }, { drop: { pageId: "page_2", x: 60, y: 40 } })]);
  const same = run([down(10, 10, obj("a")), move(60, 60), up(60, 60, { over: { pageId: PAGE, x: 60, y: 60 } })], start);
  assert.equal(same.effects[0].drop, null);
  const remembered = run([down(10, 10, obj("a")), move(60, 300, { over: { pageId: "page_2", x: 60, y: 20 } }), up(60, 300)], start);
  assert.deepEqual(remembered.effects[0].drop, { pageId: "page_2", x: 60, y: 20 }, "the last known page under the pointer");
  const locked = run([down(10, 10, obj("a")), move(60, 20, { shift: true }), up(60, 20)], start);
  assert.equal(locked.effects[0].axisLock, true);
});

test("the certificate position tool draws the rectangle of the signature, which the signing flow keeps", () => {
  assert.equal(toolById("certSign").creates, SIGNATURE_FIELD_TYPE);
  const drawn = run([tool("certSign"), down(10, 10, page), move(210, 90), up(210, 90)]);
  assert.deepEqual(drawn.effects, [{ type: "create", tool: "certSign", objectType: "signatureField", pageId: PAGE, from: { x: 10, y: 10 }, to: { x: 210, y: 90 }, rect: { x: 10, y: 10, width: 200, height: 80 }, constrain: false }]);
  assert.equal(drawn.state.tool, "select", "one rectangle, then it can be moved and resized");
  assert.deepEqual(drawn.state.selection, [SIGNATURE_FIELD_ID]);
  const moved = run([down(50, 50, obj(SIGNATURE_FIELD_ID, SIGNATURE_FIELD_TYPE)), move(90, 90), up(90, 90)], drawn.state);
  assert.deepEqual(moved.effects[0].ids, [SIGNATURE_FIELD_ID], "the overlay routes this id to the signing flow, not to the store");
  const resized = run([down(210, 90, { kind: "handle", id: SIGNATURE_FIELD_ID, handle: "se" }), up(230, 100)], drawn.state);
  assert.equal(resized.effects[0].id, SIGNATURE_FIELD_ID);
  assert.deepEqual(run([key("Delete")], drawn.state).effects, [{ type: "delete", ids: [SIGNATURE_FIELD_ID] }]);
  assert.deepEqual(run([tool("certSign"), down(10, 10, page), up(10, 10)]).effects[0].at, { x: 10, y: 10 }, "a click gives the default rectangle");
  assert.ok(AREA_TOOLS.includes("certSign") && STROKE_TOOLS.length === 2);
});

test("the eraser only takes pen strokes, highlights and shapes; a lost release does not leave a gesture hanging", () => {
  assert.deepEqual(ERASABLE_TYPES, ["pen", "highlight", "rect", "ellipse", "line"]);
  for (const type of ["text", "image", "redact", "blur"]) {
    const r = run([tool("eraser"), down(0, 0, obj("x", type)), move(5, 5, { target: obj("x", type) }), up(5, 5)]);
    assert.deepEqual(r.effects, [], `${type} needs Delete`);
  }
  const cancelled = run([tool("eraser"), down(0, 0, obj("s1", "line")), move(5, 5, { target: obj("s2", "rect") }), key("Escape")]);
  assert.deepEqual(cancelled.types, ["erase", "erase", "cancelGesture"], "the previews are dropped, nothing is deleted");
  // the pointer was released outside the window: the next press starts cleanly
  const stuck = run([down(10, 10, obj("a")), move(60, 60)]);
  assert.equal(stuck.state.mode, "moving");
  const again = run([down(200, 200, obj("b")), up(200, 200)], stuck.state);
  assert.deepEqual(again.types, ["cancelGesture"]);
  assert.deepEqual([again.state.mode, again.state.selection], ["idle", ["b"]]);
  // no marquee from the backdrop; a click there still deselects
  const backdrop = run([down(10, 10, { kind: "outside" }, { pageId: null }), move(90, 90), up(90, 90)], { ...initialState(), selection: ["a"] });
  assert.deepEqual([backdrop.effects, backdrop.state.selection, backdrop.state.mode], [[], [], "idle"]);
  // a second finger while drawing gives the gesture to pinch-zoom
  assert.deepEqual(run([tool("pen"), down(0, 0, page), move(9, 9), { type: "multitouch" }, up(9, 9)]).types, ["cancelGesture"]);
});

test("cursors follow the tool, the mode and what is under the pointer", () => {
  const select = initialState();
  assert.equal(cursorFor(select, obj("a")), "move");
  assert.equal(cursorFor(select, { kind: "text" }), "text");
  assert.equal(cursorFor(select, page), "default");
  assert.equal(cursorFor(select), "default");
  assert.equal(cursorFor(select, { kind: "handle", id: "a", handle: "se" }), "nwse-resize");
  assert.equal(cursorFor(select, { kind: "handle", id: "a", handle: "se" }, { screenRotation: 90 }), "nesw-resize", "a turned box turns its arrows");
  assert.equal(cursorFor(select, { kind: "handle", id: "a", handle: "p1" }), "move");
  assert.equal(cursorFor(select, { kind: "rotate", id: "a" }), "grab");
  assert.equal(cursorFor(select, page, { busy: true }), "progress");
  for (const entry of TOOLS) {
    const state = { ...initialState(), tool: entry.id };
    if (entry.id === "select") continue;
    assert.equal(cursorFor(state, page), entry.cursor, entry.id);
    if (entry.id !== "hand" && entry.id !== "eraser") assert.equal(cursorFor(state, { kind: "outside" }), "not-allowed", `${entry.id} needs a page`);
  }
  assert.equal(cursorFor({ ...select, tool: "highlighter" }, { kind: "text" }), "text");
  assert.equal(cursorFor({ ...select, tool: "redact" }, { kind: "textline", id: "l" }), "text");
  assert.equal(cursorFor({ ...select, tool: "pen" }, { kind: "text" }), "crosshair");
  assert.equal(cursorFor({ ...select, tool: "redact", selection: ["m"] }, { kind: "handle", id: "m", handle: "n" }), "ns-resize");
  assert.equal(cursorFor({ ...select, tool: "redact" }, { kind: "handle", id: "m", handle: "n" }), "crosshair");
  assert.equal(cursorFor({ ...select, spaceHeld: true }, obj("a")), "grab");
  assert.equal(cursorFor({ ...select, tool: "hand", mode: "panning" }, page), "grabbing");
  assert.equal(cursorFor({ ...select, tool: "image", mode: "placing", gesture: { payload: 1, at: null } }, page), "copy");
  assert.equal(cursorFor({ ...select, tool: "image", mode: "placing", gesture: { payload: 1, at: null } }, { kind: "outside" }), "not-allowed");
  assert.equal(cursorFor({ ...select, mode: "moving", gesture: {} }, page), "move");
  assert.equal(cursorFor({ ...select, mode: "rotating", gesture: {} }, page), "grabbing");
  assert.equal(cursorFor({ ...select, mode: "resizing", gesture: { handle: "e" } }, page), "ew-resize");
});
