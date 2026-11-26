// From a key to a command (src/pages/pdfEditor/ui/keyCommands.js): where the keyboard focus lets a shortcut
// through, and who runs it: a feature, the kernel's actions, the tool switch or the interaction reducer.
import test from "node:test";
import assert from "node:assert/strict";
import { REDUCER_SHORTCUTS } from "../src/pages/pdfEditor/tools/interaction.js";
import { SHORTCUTS, shortcutById } from "../src/pages/pdfEditor/tools/keymap.js";
import { TOOLS } from "../src/pages/pdfEditor/tools/registry.js";
import { KERNEL_COMMANDS, isControlCombo, keyContext, resolveKey, routeOf, runCommand } from "../src/pages/pdfEditor/ui/keyCommands.js";

const key = (name, mods = {}) => ({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const ctrl = (name, mods = {}) => key(name, { ctrlKey: true, ...mods });

/** An editor that records what was asked of it. */
function recorder({ commands = {}, view = null } = {}) {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get: (_, name) => (...args) => {
        calls.push([name, ...args]);
        return true;
      }
    }
  );
  let currentView = view;
  const ui = {
    getState: () => ({ view: currentView }),
    closeView: () => {
      calls.push(["ui.closeView"]);
      currentView = null;
      return true;
    },
    runInteraction: (event) => calls.push(["ui.runInteraction", event])
  };
  return { calls, editor: { actions, ui, features: { commands } } };
}

test("every shortcut of the keymap has exactly one home", () => {
  const routes = { kernel: [], tool: [], interaction: [], feature: [] };
  for (const shortcut of SHORTCUTS) routes[routeOf(shortcut.id).kind].push(shortcut.id);
  assert.deepEqual(routes.tool.sort(), TOOLS.map((tool) => `tool:${tool.id}`).sort());
  assert.deepEqual(routes.interaction.sort(), [...REDUCER_SHORTCUTS].sort());
  assert.deepEqual(routes.kernel.sort(), Object.keys(KERNEL_COMMANDS).sort(), "no kernel command without a shortcut, no shortcut the kernel forgot");
  // what only a feature can do: without one the key does nothing
  assert.deepEqual(routes.feature.sort(), [
    "biggerText", "bold", "bringForward", "bringToFront", "commitText", "copy", "cut", "duplicate", "italic", "nudge", "nudgeBig",
    "pageEarlier", "pageExtend", "pageFocus", "pageLater", "pageOpen", "pageRotateCcw", "pageRotateCw", "pageToggle", "paste", "rotateView",
    "selectAll", "sendBackward", "sendToBack", "smallerText", "underline"
  ]);
  assert.deepEqual(routeOf("tool:laser"), { kind: "feature" }, "not a tool of the registry");
  assert.deepEqual(routeOf(undefined), { kind: "feature" });
});

test("the kernel's shortcuts call the actions they are named after", () => {
  const expected = {
    open: ["openFilePicker", "open"],
    download: ["download"],
    print: ["print"],
    undo: ["undo"],
    redo: ["redo"],
    search: ["openSearch"],
    findNext: ["findNext"],
    findPrevious: ["findPrevious"],
    findNextInField: ["findNext"],
    findPreviousInField: ["findPrevious"],
    zoomIn: ["zoomIn"],
    zoomOut: ["zoomOut"],
    zoomAuto: ["zoomAuto"],
    actualSize: ["setZoom", "actual"],
    fitWidth: ["setZoom", "fit-width"],
    fitPage: ["setZoom", "fit-page"],
    previousPage: ["previousPage"],
    nextPage: ["nextPage"],
    firstPage: ["firstPage"],
    lastPage: ["lastPage"],
    goToPage: ["focusElement", "pageNumber"],
    toggleLeftPanel: ["toggleLeftPanel"],
    fullScreen: ["toggleFullScreen"],
    focusToolbar: ["focusElement", "toolbar"],
    organise: ["toggleView", "organiser"],
    shortcuts: ["openKernelDialog", "shortcuts"]
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(KERNEL_COMMANDS).sort());
  for (const [id, call] of Object.entries(expected)) {
    const { calls, editor } = recorder();
    assert.equal(runCommand(editor, id), true, id);
    assert.deepEqual(calls, [call], id);
    assert.ok(shortcutById(id), `${id} is a shortcut of the keymap`);
  }
});

test("a kernel command that could not act says so (the key then stays with the browser unless it is taken over)", () => {
  const editor = { actions: { toggleView: () => false, openFilePicker: () => false }, ui: { getState: () => ({ view: null }) }, features: { commands: {} } };
  assert.equal(runCommand(editor, "organise"), false, "no feature brought an organiser");
  assert.equal(runCommand(editor, "open"), false);
});

test("features are asked first; the first one that returns true wins", () => {
  const seen = [];
  const { calls, editor } = recorder({
    commands: {
      undo: [
        (given, event) => {
          seen.push(["first", event.id, event.scope, event.phase, given === editor]);
          return false;
        },
        () => {
          seen.push(["second"]);
          return true;
        },
        () => seen.push(["never"])
      ],
      copy: [() => true],
      paste: [() => undefined]
    }
  });
  assert.equal(runCommand(editor, "undo", { scope: "organiser" }), true);
  assert.deepEqual(seen, [["first", "undo", "organiser", "down", true], ["second"]]);
  assert.deepEqual(calls, [], "the kernel's undo did not run");
  assert.equal(runCommand(editor, "copy"), true);
  assert.equal(runCommand(editor, "paste"), false, "only an explicit true counts as handled");
  assert.equal(runCommand(editor, "nudge"), false, "nobody implements it");
});

test("details of a command reach the feature as part of its event", () => {
  let received = null;
  const { editor } = recorder({ commands: { openImages: [(_, event) => ((received = event), true)] } });
  const files = [{ name: "scan.png" }];
  assert.equal(runCommand(editor, "openImages", { files, intent: "add", index: 2 }), true);
  assert.deepEqual(received, { scope: "viewer", keyEvent: null, phase: "down", files, intent: "add", index: 2, id: "openImages" });
});

test("tool keys choose the tool; reducer keys go to the reducer while the pages have the keyboard", () => {
  const { calls, editor } = recorder();
  assert.equal(runCommand(editor, "tool:pen"), true);
  assert.equal(runCommand(editor, "escape", { scope: "selection" }), true);
  assert.equal(runCommand(editor, "delete", { scope: "selection" }), true);
  assert.equal(runCommand(editor, "tempHand", { scope: "viewer", phase: "up" }), true, "the release of Space reaches the reducer");
  assert.equal(runCommand(editor, "tool:pen", { phase: "up" }), false);
  assert.equal(runCommand(editor, "undo", { phase: "up" }), false);
  assert.deepEqual(calls, [
    ["setTool", "pen"],
    ["ui.runInteraction", { type: "shortcut", id: "escape", phase: "down" }],
    ["ui.runInteraction", { type: "shortcut", id: "delete", phase: "down" }],
    ["ui.runInteraction", { type: "shortcut", id: "tempHand", phase: "up" }]
  ]);
});

test("in a full-screen view Escape leaves the view and the other reducer keys do nothing", () => {
  const { calls, editor } = recorder({ view: "organiser" });
  assert.equal(runCommand(editor, "delete", { scope: "organiser" }), false);
  assert.equal(runCommand(editor, "escape", { scope: "organiser" }), true);
  assert.equal(runCommand(editor, "escape", { scope: "organiser" }), false, "no view is open any more");
  assert.deepEqual(calls, [["ui.closeView"]]);
  // a feature that owns Escape in its view (a selection in the organiser) is still asked first
  const owned = recorder({ view: "organiser", commands: { escape: [() => true] } });
  assert.equal(runCommand(owned.editor, "escape", { scope: "organiser" }), true);
  assert.deepEqual(owned.calls, []);
});

test("keyContext: where the focus is decides the scope", () => {
  assert.equal(keyContext({ inDialog: true }), null, "dialogs and menus have their own keys");
  assert.equal(keyContext({ scopeHint: "none" }), null);
  assert.deepEqual(keyContext({}), { scope: "viewer", control: false });
  assert.deepEqual(keyContext({}, { selectionCount: 2 }), { scope: "selection", control: false });
  assert.deepEqual(keyContext({ textBox: true }, { selectionCount: 1 }), { scope: "text", control: false });
  assert.deepEqual(keyContext({ scopeHint: "search", field: true }), { scope: "search", control: false });
  assert.deepEqual(keyContext({ field: true }, { selectionCount: 1 }), { scope: "field", control: false });
  assert.deepEqual(keyContext({ control: true }), { scope: "viewer", control: true });
  assert.deepEqual(keyContext({ control: true }, { view: "organiser" }), { scope: "organiser", control: true });
  assert.deepEqual(keyContext({ scopeHint: "organiser", control: true }), { scope: "organiser", control: false }, "a region that names its scope gets all of its keys");
});

test("resolveKey: page area and selection", () => {
  const viewer = keyContext({});
  assert.deepEqual(resolveKey(key("v"), viewer), { id: "tool:select", scope: "viewer", combo: "V", preventDefault: false });
  assert.deepEqual(resolveKey(key("E", { shiftKey: true }), viewer), { id: "tool:eraser", scope: "viewer", combo: "Shift+E", preventDefault: false });
  assert.deepEqual(resolveKey(ctrl("s"), viewer), { id: "download", scope: "viewer", combo: "Ctrl+S", preventDefault: true });
  assert.deepEqual(resolveKey(ctrl("o"), viewer), { id: "open", scope: "viewer", combo: "Ctrl+O", preventDefault: true });
  assert.equal(resolveKey(key("ArrowRight"), viewer).id, "nextPage");
  assert.equal(resolveKey(key(" "), viewer).id, "tempHand");
  assert.equal(resolveKey(key(" "), viewer).preventDefault, true, "Space must not scroll the pages while it means the hand");
  assert.equal(resolveKey(key("Delete"), viewer), null, "nothing is selected");
  assert.equal(resolveKey(key("Backspace"), keyContext({}, { selectionCount: 1 })), null, "Backspace never deletes on Windows");
  assert.equal(resolveKey(key("Backspace"), keyContext({}, { selectionCount: 1 }), { mac: true }).id, "delete");

  const selection = keyContext({}, { selectionCount: 1 });
  assert.equal(resolveKey(key("Delete"), selection).id, "delete");
  assert.equal(resolveKey(key("ArrowRight"), selection).id, "nudge");
  assert.equal(resolveKey(key("Escape"), selection).id, "escape");
  assert.equal(resolveKey(ctrl("z"), selection).id, "undo");
  assert.equal(resolveKey(ctrl("z", { shiftKey: true }), selection).id, "redo");
  assert.equal(resolveKey(key("z", { metaKey: true }), selection, { mac: true }).id, "undo");
});

test("resolveKey: nothing while an input method composes, on auto-repeat of single keys, or with single keys off", () => {
  const viewer = keyContext({});
  assert.equal(resolveKey({ ...key("v"), isComposing: true }, viewer), null);
  assert.equal(resolveKey({ ...key("Process"), keyCode: 229 }, viewer), null);
  assert.equal(resolveKey({ ...key("v"), repeat: true }, viewer), null);
  assert.equal(resolveKey(key("v"), viewer, { singleKeys: false }), null);
  assert.equal(resolveKey(ctrl("s"), viewer, { singleKeys: false }).id, "download", "the switch only concerns single keys");
  assert.equal(resolveKey(key("v"), null), null);
});

test("resolveKey: text fields keep their keys, except the shortcuts that work everywhere", () => {
  const field = keyContext({ field: true });
  assert.equal(resolveKey(key("v"), field), null);
  assert.equal(resolveKey(key("Delete"), field), null);
  assert.equal(resolveKey(ctrl("z"), field), null, "the field undoes its own typing");
  assert.equal(resolveKey(key("Escape"), field), null, "Escape belongs to the field");
  assert.equal(resolveKey(key("Enter"), field), null, "Enter is only 'next result' in the search field");
  assert.equal(resolveKey(ctrl("s"), field).id, "download");
  assert.equal(resolveKey(ctrl("f"), field).id, "search");
  assert.equal(resolveKey(key("F4"), field).id, "toggleLeftPanel");

  const search = keyContext({ scopeHint: "search", field: true });
  assert.equal(resolveKey(key("Enter"), search).id, "findNextInField");
  assert.equal(resolveKey(key("Enter", { shiftKey: true }), search).id, "findPreviousInField");
  assert.equal(resolveKey(key("h"), search), null, "letters are typed");

  const typing = keyContext({ textBox: true });
  assert.equal(resolveKey(ctrl("b"), typing).id, "bold");
  assert.equal(resolveKey(ctrl("u"), typing).preventDefault, true);
  assert.equal(resolveKey(key("b"), typing), null);
  assert.equal(resolveKey(ctrl("z"), typing), null);
});

test("resolveKey: a focused button keeps the keys it needs itself", () => {
  const button = keyContext({ control: true });
  for (const name of [" ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
    assert.equal(resolveKey(key(name), button), null, name);
  }
  assert.equal(resolveKey(key("ArrowLeft", { shiftKey: true }), keyContext({ control: true }, { selectionCount: 1 })), null);
  assert.equal(resolveKey(key("t"), button).id, "tool:text", "tool keys work right after a click on the tool bar");
  assert.equal(resolveKey(key("Escape"), button).id, "escape");
  assert.equal(resolveKey(ctrl("p"), button).id, "print");
  assert.equal(isControlCombo("Space"), true);
  assert.equal(isControlCombo("Shift+End"), true);
  assert.equal(isControlCombo("Ctrl+ArrowUp"), false);
  assert.equal(isControlCombo(null), false);
});

test("resolveKey: the organiser scope", () => {
  const organiser = keyContext({ scopeHint: "organiser" });
  assert.equal(resolveKey(key("r"), organiser).id, "pageRotateCw");
  assert.equal(resolveKey(key(" "), organiser).id, "pageToggle");
  assert.equal(resolveKey(key("Enter"), organiser).id, "pageOpen");
  assert.equal(resolveKey(key("Delete"), organiser).id, "delete");
  assert.equal(resolveKey(key("g"), organiser).id, "organise");
  assert.equal(resolveKey(key("v"), organiser), null, "tools belong to the page area");
});
