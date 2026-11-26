// The UI store of the PDF editor (src/pages/pdfEditor/ui/uiStore.js): everything the interface remembers
// that is not part of the undoable document.
import test from "node:test";
import assert from "node:assert/strict";
import { OBJECT_DEFAULTS } from "../src/pages/pdfEditor/model/schema.js";
import { NEW_ID, SIGNATURE_FIELD_ID, SIGNATURE_FIELD_TYPE } from "../src/pages/pdfEditor/tools/interaction.js";
import { MAX_TOASTS, PREFERENCES_KEY, TOAST_DURATIONS, TOOL_DEFAULTS_KEY, createUiStore, layoutForWidth, pointerModeFor, readPreferences, readToolDefaults } from "../src/pages/pdfEditor/ui/uiStore.js";
import { manualTimers, memoryStorage } from "./helpers/pdfUiKit.mjs";

const make = (options = {}) => createUiStore({ storage: memoryStorage(), timers: manualTimers(), ...options });

test("the initial state: Select tool, nothing open, nothing running", () => {
  const ui = make();
  const state = ui.getState();
  assert.equal(state.interaction.tool, "select");
  assert.deepEqual(state.interaction.selection, []);
  assert.equal(state.layout, "wide");
  assert.equal(state.leftPanel, null);
  assert.deepEqual(state.inspector, { open: true, pinned: false });
  assert.deepEqual(state.dialogs, []);
  assert.equal(state.drawer, null);
  assert.equal(state.job, null);
  assert.equal(state.view, null);
  assert.deepEqual(state.flags, { editable: "unknown", viewOnly: null, signedEditConfirmed: false, restricted: false, restrictedEditConfirmed: false, savedAs: null });
  assert.deepEqual(state.search.options, { matchCase: false, wholeWord: false, matchDiacritics: false }, "Match diacritics is off by default");
  assert.equal(state.autoZoom, true);
  assert.ok(Object.isFrozen(state));
});

test("a change replaces the state and only the slices it touched; listeners hear real changes only", () => {
  const ui = make();
  let calls = 0;
  const off = ui.subscribe(() => {
    calls += 1;
  });
  const before = ui.getState();
  assert.equal(ui.openLeftPanel("pages"), true);
  const after = ui.getState();
  assert.notEqual(after, before);
  assert.equal(after.interaction, before.interaction);
  assert.equal(after.inspector, before.inspector);
  assert.equal(calls, 1);
  assert.equal(ui.openLeftPanel("pages"), false, "the same value changes nothing");
  assert.equal(calls, 1);
  off();
  ui.closeLeftPanel();
  assert.equal(calls, 1);
});

test("layoutForWidth follows the breakpoints of the specification", () => {
  assert.equal(layoutForWidth(1440), "wide");
  assert.equal(layoutForWidth(1200), "wide");
  assert.equal(layoutForWidth(1199), "medium");
  assert.equal(layoutForWidth(900), "medium");
  assert.equal(layoutForWidth(899), "narrow");
});

test("leaving the wide layout closes the panels that would lie over the pages; a pinned inspector stays", () => {
  const ui = make();
  ui.openLeftPanel("pages");
  assert.equal(ui.setLayout("medium"), true);
  assert.equal(ui.getState().leftPanel, null);
  assert.equal(ui.getState().inspector.open, false);
  assert.equal(ui.setLayout("wide"), true);
  assert.equal(ui.getState().inspector.open, true, "the properties panel is a column again");

  ui.setInspector({ pinned: true });
  ui.setLayout("medium");
  assert.deepEqual(ui.getState().inspector, { open: true, pinned: true });
  ui.setLayout("narrow");
  assert.deepEqual(ui.getState().inspector, { open: true, pinned: true }, "medium to narrow changes nothing by itself");
  assert.equal(ui.setLayout("huge"), false);
  assert.equal(ui.setLayout("narrow"), false);
});

test("panels: the tab of the open panel closes it; inspector, view and drawer", () => {
  const ui = make();
  ui.toggleLeftPanel("pages");
  assert.equal(ui.getState().leftPanel, "pages");
  ui.toggleLeftPanel("outline");
  assert.equal(ui.getState().leftPanel, "outline");
  ui.toggleLeftPanel("outline");
  assert.equal(ui.getState().leftPanel, null);

  ui.toggleInspector();
  assert.equal(ui.getState().inspector.open, false);
  assert.equal(ui.setInspector({ open: false }), false);

  ui.openView("organiser");
  assert.equal(ui.getState().view, "organiser");
  ui.closeView();
  assert.equal(ui.getState().view, null);

  ui.openDrawer("certificate", { step: 2 });
  assert.deepEqual(ui.getState().drawer, { id: "certificate", props: { step: 2 } });
  ui.closeDrawer();
  assert.equal(ui.getState().drawer, null);
});

test("runInteraction runs the reducer and hands the effects to the registered executor", () => {
  const ui = make();
  const seen = [];
  ui.setEffectExecutor((effects, event) => seen.push({ event: event.type, effects: effects.map((effect) => effect.type) }));
  const result = ui.runInteraction({ type: "tool", tool: "pen" });
  assert.equal(result.state.tool, "pen");
  assert.equal(ui.getState().interaction.tool, "pen");
  assert.deepEqual(seen, [], "no effects, no call");

  ui.runInteraction({ type: "tool", tool: "image" });
  assert.deepEqual(seen, [{ event: "tool", effects: ["openPicker"] }]);

  // nothing left to cancel: the shell hears about the Escape
  ui.runInteraction({ type: "tool", tool: "select" });
  seen.length = 0;
  ui.runInteraction({ type: "shortcut", id: "escape" });
  assert.deepEqual(seen, [{ event: "shortcut", effects: ["unhandledEscape"] }]);
});

test("events sent from inside an executor are queued and run in order after the current one", () => {
  const ui = make({ getContext: () => ({ objectExists: () => true, objectType: () => "rect" }) });
  const order = [];
  ui.setEffectExecutor((effects, event) => {
    order.push(`run:${event.type}`);
    if (event.type === "shortcut") {
      // a store command inside the executor notifies "documentChanged"; the executor then names what it made
      assert.equal(ui.runInteraction({ type: "documentChanged" }), null, "queued behind the running event");
      ui.runInteraction({ type: "setSelection", ids: ["a", "b"] });
      order.push("executor-done");
    }
  });
  ui.runInteraction({ type: "setSelection", ids: ["x"] });
  ui.runInteraction({ type: "shortcut", id: "delete" });
  assert.deepEqual(order, ["run:shortcut", "executor-done"]);
  assert.deepEqual(ui.getState().interaction.selection, ["a", "b"], "the queued events ran, in order");
});

test("an executor that throws tells onError and does not block later events", () => {
  const errors = [];
  const ui = make({ onError: (error) => errors.push(error.message) });
  ui.setEffectExecutor(() => {
    throw new Error("boom");
  });
  ui.runInteraction({ type: "tool", tool: "image" });
  assert.deepEqual(errors, ["boom"]);
  ui.setEffectExecutor(null);
  assert.equal(ui.runInteraction({ type: "tool", tool: "pen" }).state.tool, "pen");
});

test("documentChanged drops what no longer exists, keeps the new-object placeholder and registered pseudo objects", () => {
  const existing = new Set(["a", "b"]);
  const ui = make({ getContext: () => ({ objectExists: (id) => existing.has(id), objectType: () => "rect" }) });
  const unregister = ui.registerPseudoObject(SIGNATURE_FIELD_ID, SIGNATURE_FIELD_TYPE);
  ui.runInteraction({ type: "setSelection", ids: ["a", "b", NEW_ID, SIGNATURE_FIELD_ID] });
  existing.delete("b");
  ui.runInteraction({ type: "documentChanged" });
  assert.deepEqual(ui.getState().interaction.selection, ["a", NEW_ID, SIGNATURE_FIELD_ID]);
  unregister();
  ui.runInteraction({ type: "documentChanged" });
  assert.deepEqual(ui.getState().interaction.selection, ["a", NEW_ID]);
});

test("pointer mode: Select reads text, Hand and Space pan, drawing tools and running gestures own the overlay", () => {
  const base = { tool: "select", mode: "idle", spaceHeld: false };
  assert.equal(pointerModeFor(base), "text");
  assert.equal(pointerModeFor({ ...base, mode: "pressing" }), "text", "a press that may still become a text selection");
  assert.equal(pointerModeFor({ ...base, mode: "moving" }), "overlay");
  assert.equal(pointerModeFor({ ...base, mode: "editingText" }), "overlay");
  assert.equal(pointerModeFor({ ...base, tool: "hand" }), "none");
  assert.equal(pointerModeFor({ ...base, tool: "pen", spaceHeld: true }), "none");
  for (const tool of ["text", "editText", "rect", "pen", "highlighter", "eraser", "redact", "blur", "signature", "certSign"]) {
    assert.equal(pointerModeFor({ ...base, tool }), "overlay", tool);
  }
  assert.equal(pointerModeFor(null), "text");

  const ui = make();
  assert.equal(ui.getPointerMode(), "text");
  ui.runInteraction({ type: "tool", tool: "redact" });
  assert.equal(ui.getPointerMode(), "overlay");
  ui.setPointerMode("text"); // a feature knows better: Redact over document text marks the text itself
  assert.equal(ui.getPointerMode(), "text");
  ui.setPointerMode("sideways");
  assert.equal(ui.getState().pointerMode, null, "an unknown mode gives the decision back");
  assert.equal(ui.getPointerMode(), "overlay");
});

test("dialogs form a stack; showDialog resolves with what the dialog hands to onClose", async () => {
  const ui = make();
  const first = ui.openDialog("confirm", { title: "one" });
  const answer = ui.showDialog("password", { fileName: "a.pdf", reason: "need" });
  assert.deepEqual(ui.getState().dialogs.map((dialog) => dialog.id), ["confirm", "password"]);
  const { key } = ui.getState().dialogs[1];

  assert.equal(ui.updateDialog(key, { reason: "incorrect" }), true);
  assert.deepEqual(ui.getState().dialogs[1].props, { fileName: "a.pdf", reason: "incorrect" });
  assert.equal(ui.updateDialog("nope", {}), false);

  assert.equal(ui.closeDialog("password", "secret"), true, "by id: the top dialog with that id");
  assert.equal(await answer, "secret");
  assert.equal(ui.closeDialog(first), true);
  assert.equal(ui.closeDialog(first), false);

  const pending = ui.showDialog("confirm", {});
  ui.closeAllDialogs();
  assert.equal(await pending, undefined, "closed without an answer");
  assert.deepEqual(ui.getState().dialogs, []);
});

test("toasts: tones, Undo runs once, the oldest goes when there are too many, timers dismiss", () => {
  const timers = manualTimers();
  const ui = make({ timers });
  let undone = 0;
  const id = ui.addToast({ message: "3 pages deleted", tone: "success", onUndo: () => (undone += 1) });
  const plain = ui.addToast({ message: "Saved" });
  ui.addToast({ message: "Failed", tone: "error" });
  ui.addToast({ message: "odd", tone: "purple" });
  assert.deepEqual(ui.getState().toasts.map((toast) => [toast.message, toast.tone, toast.undo]), [
    ["3 pages deleted", "success", true],
    ["Saved", "info", false],
    ["Failed", "error", false],
    ["odd", "info", false]
  ]);
  assert.deepEqual(timers.pending(), [TOAST_DURATIONS.undo, TOAST_DURATIONS.plain, TOAST_DURATIONS.error, TOAST_DURATIONS.plain]);

  assert.equal(ui.undoToast(id), true);
  assert.equal(ui.undoToast(id), false, "the callback is gone with the toast");
  assert.equal(undone, 1);
  assert.equal(ui.undoToast(plain), false, "a toast without Undo is only dismissed");
  assert.equal(ui.getState().toasts.length, 2);

  for (let index = 0; index < MAX_TOASTS + 2; index += 1) ui.addToast({ message: `m${index}` });
  assert.equal(ui.getState().toasts.length, MAX_TOASTS);
  assert.equal(ui.getState().toasts.at(-1).message, `m${MAX_TOASTS + 1}`);

  timers.runAll();
  assert.deepEqual(ui.getState().toasts, []);
});

test("notices are said once, replaced by id, and leave with their document unless they belong to the session", () => {
  const ui = make();
  const first = ui.addNotice({ tone: "warning", code: "EXPORT_SOURCE_SIGNED", params: { source: "s1", signatures: 2 } });
  const again = ui.addNotice({ tone: "warning", code: "EXPORT_SOURCE_SIGNED", params: { source: "s1", signatures: 2 } });
  assert.equal(ui.getState().notices.length, 1);
  assert.notEqual(first, again);
  ui.addNotice({ tone: "warning", code: "EXPORT_SOURCE_SIGNED", params: { source: "s2", signatures: 1 } });
  assert.equal(ui.getState().notices.length, 2, "another file is another notice");

  ui.addNotice({ id: "session", tone: "loud", text: "Your session has ended.", scope: "session", dismissible: false });
  ui.addNotice({ id: "session", tone: "warning", text: "Your session has ended. Sign in again.", scope: "session", dismissible: false });
  const session = ui.getState().notices.filter((notice) => notice.id === "session");
  assert.equal(session.length, 1);
  assert.equal(session[0].text, "Your session has ended. Sign in again.");
  assert.equal(session[0].dismissible, false);

  ui.resetForDocument();
  assert.deepEqual(ui.getState().notices.map((notice) => notice.id), ["session"]);
  ui.dismissNotice("session");
  assert.deepEqual(ui.getState().notices, []);
});

test("the running job keeps its progress between 0 and 1 and says when it is unknown", () => {
  const ui = make();
  ui.setJob({ id: "job1", titleKey: "Opening…", progress: 1.7, stage: "PIPELINE_STAGE_DRAW", detail: "a.pdf", cancellable: 1 });
  assert.deepEqual(ui.getState().job, { id: "job1", titleKey: "Opening…", progress: 1, stage: "PIPELINE_STAGE_DRAW", detail: "a.pdf", cancellable: true });
  ui.setJob({ id: "job1", titleKey: "Opening…", progress: undefined });
  assert.equal(ui.getState().job.progress, null);
  assert.equal(ui.getState().job.stage, null);
  ui.setJob(null);
  assert.equal(ui.getState().job, null);
});

test("tool defaults are sanitised, kept per tool and persisted in the injected storage", () => {
  const storage = memoryStorage();
  const ui = make({ storage });
  assert.deepEqual(ui.getToolDefaults("rect"), {});
  assert.equal(ui.setToolDefaults("rect", { stroke: "#FF0000", strokeWidth: 3, nonsense: 1 }), true);
  assert.deepEqual(ui.getToolDefaults("rect"), { stroke: "#ff0000", strokeWidth: 3 }, "normalised colour, unknown key dropped");
  assert.equal(ui.setToolDefaults("rect", { stroke: "#ff0000" }), false, "nothing new");
  assert.equal(ui.setToolDefaults("rect", { strokeWidth: "thick" }), false, "an invalid value keeps the old one");
  assert.equal(ui.getToolDefaults("rect").strokeWidth, 3);
  assert.equal(ui.setToolDefaults("laser", { stroke: "#000000" }), false, "not a creation kind");

  // arrow and line are two tools with one object type: their defaults do not mix
  ui.setToolDefaults("arrow", { strokeWidth: 5 });
  assert.equal(ui.getToolStyle("arrow").strokeWidth, 5);
  assert.equal(ui.getToolStyle("line").strokeWidth, OBJECT_DEFAULTS.line.strokeWidth);
  assert.equal(ui.getToolStyle("arrow").headEnd, true);
  assert.equal(ui.getToolStyle("rect").stroke, "#ff0000");
  assert.equal(ui.getToolStyle("rect").opacity, OBJECT_DEFAULTS.rect.opacity, "everything else is the default of the type");

  const stored = JSON.parse(storage.dump()[TOOL_DEFAULTS_KEY]);
  assert.deepEqual(stored, { rect: { stroke: "#ff0000", strokeWidth: 3 }, arrow: { strokeWidth: 5 } });

  // the next visit starts with them
  const later = make({ storage });
  assert.deepEqual(later.getToolDefaults("rect"), { stroke: "#ff0000", strokeWidth: 3 });
  assert.equal(later.resetToolDefaults("rect"), true);
  assert.deepEqual(JSON.parse(storage.dump()[TOOL_DEFAULTS_KEY]), { arrow: { strokeWidth: 5 } });
  assert.equal(later.resetToolDefaults(), true);
  assert.deepEqual(JSON.parse(storage.dump()[TOOL_DEFAULTS_KEY]), {});
});

test("what the storage holds is never trusted", () => {
  const dirty = memoryStorage({
    [TOOL_DEFAULTS_KEY]: JSON.stringify({ rect: { stroke: "red; background: url(x)", strokeWidth: -4, fill: "#00FF00", onclick: "alert(1)" }, text: "big", laser: { stroke: "#000000" }, pen: { width: 2, strokeWidth: 9 } }),
    [PREFERENCES_KEY]: JSON.stringify({ singleKeys: "no", lastShape: "triangle" })
  });
  // an impossible colour is dropped, a number is brought into its limits, keys of other types and unknown tools go
  assert.deepEqual(readToolDefaults(dirty), { rect: { strokeWidth: 0.25, fill: "#00ff00" }, pen: { width: 2 } });
  assert.deepEqual(readPreferences(dirty), { singleKeys: true, lastShape: "rect" });

  for (const broken of [memoryStorage({ [TOOL_DEFAULTS_KEY]: "{not json", [PREFERENCES_KEY]: "[1,2]" }), memoryStorage({}, { failing: true }), null]) {
    assert.deepEqual(readToolDefaults(broken), {});
    assert.deepEqual(readPreferences(broken), { singleKeys: true, lastShape: "rect" });
  }
});

test("a storage that refuses to write costs nothing but the memory of the next visit", () => {
  const ui = make({ storage: memoryStorage({}, { failing: true }) });
  assert.equal(ui.setToolDefaults("pen", { width: 4 }), true);
  assert.equal(ui.getToolDefaults("pen").width, 4);
  assert.equal(ui.setPreference("singleKeys", false), true);
  assert.equal(ui.getState().preferences.singleKeys, false);
});

test("preferences: the single-key switch and the shape used last", () => {
  const storage = memoryStorage();
  const ui = make({ storage });
  assert.equal(ui.setPreference("lastShape", "arrow"), true);
  assert.equal(ui.setPreference("lastShape", "pen"), false, "not a shape");
  assert.equal(ui.setPreference("singleKeys", "yes"), false);
  assert.equal(ui.setPreference("theme", "dark"), false, "not a preference of the editor");
  assert.equal(ui.setPreference("singleKeys", false), true);
  assert.deepEqual(JSON.parse(storage.dump()[PREFERENCES_KEY]), { singleKeys: false, lastShape: "arrow" });
  assert.deepEqual(make({ storage }).getState().preferences, { singleKeys: false, lastShape: "arrow" });
});

test("flags of the document are validated and go back to their defaults with a new document", () => {
  const ui = make();
  assert.equal(ui.setFlags({ editable: "checking" }), true);
  assert.equal(ui.setFlags({ editable: "perhaps" }), false);
  ui.setFlags({ editable: "no", viewOnly: { code: "EXPORT_SOURCE_DAMAGED", params: { source: "s1" } }, signedEditConfirmed: 1, restricted: 1, restrictedEditConfirmed: "yes", savedAs: "downloaded" });
  assert.deepEqual(ui.getState().flags, { editable: "no", viewOnly: { code: "EXPORT_SOURCE_DAMAGED", params: { source: "s1" } }, signedEditConfirmed: true, restricted: true, restrictedEditConfirmed: true, savedAs: "downloaded" });
  assert.equal(ui.setFlags({ savedAs: "printed" }), false);

  ui.runInteraction({ type: "tool", tool: "pen" });
  ui.openView("organiser");
  ui.openDrawer("certificate");
  ui.setPointerMode("none");
  ui.openLeftPanel("pages");
  ui.resetForDocument();
  const state = ui.getState();
  assert.deepEqual(state.flags, { editable: "unknown", viewOnly: null, signedEditConfirmed: false, restricted: false, restrictedEditConfirmed: false, savedAs: null });
  assert.equal(state.interaction.tool, "select");
  assert.equal(state.view, null);
  assert.equal(state.drawer, null);
  assert.equal(state.pointerMode, null);
  assert.equal(state.leftPanel, "pages", "panels stay as the user arranged them");
});

test("search state: options are booleans of the three known kinds; focus asks the field again", () => {
  const ui = make();
  ui.setSearch({ open: true, query: "hop dong", options: { matchCase: 1, colour: true } });
  assert.deepEqual(ui.getState().search, { open: true, query: "hop dong", options: { matchCase: true, wholeWord: false, matchDiacritics: false }, focusToken: 0 });
  assert.equal(ui.setSearch({ query: "hop dong" }), false);
  ui.setSearch({ focus: true });
  ui.setSearch({ focus: true });
  assert.equal(ui.getState().search.focusToken, 2);
});

test("every feature has a free bag of its own", () => {
  const ui = make();
  assert.equal(ui.getFeatureState("signing"), undefined);
  ui.setFeatureState("signing", { step: 1 });
  ui.setFeatureState("signing", (previous) => ({ ...previous, step: previous.step + 1 }));
  ui.setFeatureState("pages", ["p1"]);
  assert.deepEqual(ui.getFeatureState("signing"), { step: 2 });
  assert.deepEqual(ui.getFeatureState("pages"), ["p1"]);
  const same = ui.getFeatureState("pages");
  assert.equal(ui.setFeatureState("pages", () => same), false);
});

test("openError and autoZoom", () => {
  const ui = make();
  ui.setOpenError({ fileName: "broken.pdf", code: "VIEW_INVALID_PDF" });
  assert.deepEqual(ui.getState().openError, { fileName: "broken.pdf", code: "VIEW_INVALID_PDF", params: {} });
  ui.setOpenError(null);
  assert.equal(ui.getState().openError, null);
  ui.setAutoZoom(0);
  assert.equal(ui.getState().autoZoom, false);
});
