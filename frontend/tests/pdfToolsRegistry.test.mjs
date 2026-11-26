// Tool registry and keyboard map of the PDF editor (src/pages/pdfEditor/tools/registry.js, keymap.js) and
// their Vietnamese dictionary (src/i18n/vi/pdfEditorTools.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as lucide from "lucide-react";
import { NAMESPACES, hasTranslation, placeholdersOf, translate } from "../src/i18n/index.js";
import dictionary from "../src/i18n/vi/pdfEditorTools.js";
import { OBJECT_TYPES } from "../src/pages/pdfEditor/model/schema.js";
import { objectTypeOfKind } from "../src/pages/pdfEditor/model/transform.js";
import { HINTS } from "../src/pages/pdfEditor/tools/interaction.js";
import {
  OVERRIDDEN_BROWSER,
  RESERVED_BROWSER,
  SCOPES,
  SCOPE_LABELS,
  SHORTCUTS,
  SHORTCUT_SECTIONS,
  TELEX_STANDALONE_KEYS,
  comboFromEvent,
  comboKeyCaps,
  findConflicts,
  formatCombo,
  isMacPlatform,
  keysOfShortcut,
  matchShortcut,
  normaliseCombo,
  overridesBrowser,
  scopeFor,
  shortcutById,
  shortcutsOfSection
} from "../src/pages/pdfEditor/tools/keymap.js";
import { COMMANDS, TOOLS, TOOL_GROUPS, TOOL_MENUS, allIconNames, commandById, toolById, toolsOfGroup, toolsOfMenu } from "../src/pages/pdfEditor/tools/registry.js";
import { FRONTEND_ROOT, extractKeys, listBilingualFiles } from "./helpers/i18nSource.mjs";

const key = (name, mods = {}) => ({ key: name, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("every icon name is a real lucide-react export", () => {
  const names = allIconNames();
  assert.ok(names.length >= 80);
  assert.deepEqual(names.filter((name) => !(name in lucide)), []);
});

test("tool ids, command ids and tool keys are unique; every tool belongs to a known group", () => {
  const ids = [...TOOLS, ...COMMANDS].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  const keys = TOOLS.map((tool) => normaliseCombo(tool.key));
  assert.equal(new Set(keys).size, keys.length);
  const groups = new Set(TOOL_GROUPS.map((group) => group.id));
  for (const tool of TOOLS) assert.ok(groups.has(tool.group), tool.id);
  for (const tool of TOOLS) assert.ok(["sticky", "one-shot"].includes(tool.mode), tool.id);
  for (const tool of TOOLS.filter((entry) => entry.menu)) assert.ok(TOOL_MENUS.some((menu) => menu.id === tool.menu));
  assert.equal(toolById("redact").mode, "sticky");
  assert.equal(toolById("nope"), null);
  assert.equal(commandById("download").icon, "Download");
  assert.equal(commandById("nope"), null);
  assert.deepEqual(TOOL_GROUPS.map((group) => group.id), ["navigate", "insert", "draw", "protect", "sign"]);
  assert.deepEqual(toolsOfGroup("protect").map((tool) => tool.id), ["redact", "blur"]);
  assert.deepEqual(toolsOfMenu("shapes").map((tool) => tool.id), ["rect", "ellipse", "line", "arrow"]);
  assert.ok(Object.isFrozen(TOOLS) && Object.isFrozen(TOOLS[0]) && Object.isFrozen(COMMANDS[0]));
});

test("the tools follow the specification: modes, cursors, what they create in terms of the data model", () => {
  const table = Object.fromEntries(TOOLS.map((tool) => [tool.id, [tool.key, tool.mode, tool.cursor, tool.creates]]));
  assert.deepEqual(table, {
    select: ["V", "sticky", "default", null],
    hand: ["H", "sticky", "grab", null],
    text: ["T", "one-shot", "text", "text"],
    editText: ["E", "sticky", "text", "text"],
    image: ["I", "one-shot", "copy", "image"],
    rect: ["R", "one-shot", "crosshair", "rect"],
    ellipse: ["O", "one-shot", "crosshair", "ellipse"],
    line: ["L", "one-shot", "crosshair", "line"],
    arrow: ["A", "one-shot", "crosshair", "line"],
    pen: ["P", "sticky", "crosshair", "pen"],
    highlighter: ["M", "sticky", "crosshair", "highlight"],
    eraser: ["Shift+E", "sticky", "cell", null],
    redact: ["X", "sticky", "crosshair", "redact"],
    blur: ["B", "sticky", "crosshair", "blur"],
    signature: ["S", "one-shot", "copy", "image"],
    certSign: ["C", "one-shot", "crosshair", "signatureField"]
  });
  for (const tool of TOOLS) {
    if (tool.creates !== null && tool.creates !== "signatureField") assert.ok(OBJECT_TYPES.includes(tool.creates), tool.id);
    // the creation kinds of model/transform.js are the tool ids
    if (tool.creates && tool.id !== "editText" && tool.id !== "certSign") assert.equal(objectTypeOfKind(tool.id), tool.creates, tool.id);
  }
  assert.deepEqual(TOOLS.filter((tool) => tool.picker).map((tool) => tool.id), ["image", "signature"]);
  assert.deepEqual(TOOLS.filter((tool) => tool.flow).map((tool) => [tool.id, tool.flow]), [["certSign", "signing"]]);
  assert.deepEqual(TOOLS.filter((tool) => !tool.edits).map((tool) => tool.id), ["select", "hand"], "the tools that stay enabled on a read-only document");
  // the two different things called "signature" are two tools with two names
  assert.notEqual(toolById("signature").label, toolById("certSign").label);
});

test("no two shortcuts share a key in the same scope", () => {
  assert.deepEqual(findConflicts(), []);
  for (const shortcut of SHORTCUTS) for (const scope of shortcut.scopes) assert.ok(SCOPES.includes(scope), shortcut.id);
  const ids = SHORTCUTS.map((shortcut) => shortcut.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(findConflicts([{ id: "a", keys: ["Ctrl+Z"], scopes: ["viewer"] }, { id: "b", keys: ["Ctrl+z"], scopes: ["viewer", "text"] }]), [{ combo: "Ctrl+Z", scope: "viewer", a: "a", b: "b" }], "the finder finds a planted conflict");
  assert.deepEqual(findConflicts([{ id: "a", keys: ["Delete"], scopes: ["selection"] }, { id: "b", keys: ["X"], macAlso: ["Delete"], scopes: ["selection"] }]).length, 1, "macOS extras count");
  for (const tool of TOOLS) assert.deepEqual(shortcutById(`tool:${tool.id}`).keys, [tool.key], "every tool has its single-key shortcut");
});

test("no shortcut uses a reserved browser key; every browser override is declared with a reason", () => {
  const reserved = new Set(RESERVED_BROWSER.map(normaliseCombo));
  const overridden = new Set(Object.keys(OVERRIDDEN_BROWSER).map(normaliseCombo));
  // Chrome's own page-level shortcuts that we would shadow if we bound them.
  const browserPageKeys = new Set(["Ctrl+O", "Ctrl+S", "Ctrl+P", "Ctrl+F", "F3", "Shift+F3", "Ctrl+G", "Ctrl+Shift+G", "Ctrl+D", "Ctrl+U", "Ctrl+=", "Ctrl++", "Ctrl+-", "Ctrl+0", "Space", "Home", "End"].map(normaliseCombo));
  for (const shortcut of SHORTCUTS) {
    for (const combo of [...shortcut.keys, ...(shortcut.macAlso ?? [])].map(normaliseCombo)) {
      assert.ok(!reserved.has(combo), `${shortcut.id} uses reserved ${combo}`);
      if (browserPageKeys.has(combo)) assert.ok(overridden.has(combo), `${shortcut.id} overrides ${combo} without a declared reason`);
    }
  }
  for (const combo of overridden) assert.ok(!reserved.has(combo), combo);
  for (const [combo, reason] of Object.entries(OVERRIDDEN_BROWSER)) {
    assert.ok(reason.length > 10, combo);
    assert.ok(SHORTCUTS.some((shortcut) => shortcut.keys.map(normaliseCombo).includes(normaliseCombo(combo))), `${combo} is declared but bound to nothing`);
  }
  assert.equal(overridesBrowser("Ctrl+S"), true);
  assert.equal(overridesBrowser("Ctrl+Z"), false);
});

test("single-key shortcuts never use Ctrl/Alt, never work while typing, and avoid Telex stand-alone keys", () => {
  const singles = SHORTCUTS.filter((entry) => entry.single);
  assert.ok(singles.length >= TOOLS.length);
  for (const shortcut of singles) {
    for (const combo of shortcut.keys.map(normaliseCombo)) {
      assert.ok(!/Ctrl\+|Alt\+/.test(combo), `${shortcut.id}: ${combo}`);
      const keyName = combo.split("+").pop();
      assert.ok(!TELEX_STANDALONE_KEYS.includes(keyName), `${shortcut.id} uses Telex key ${keyName}`);
    }
    assert.ok(!shortcut.scopes.includes("text"), shortcut.id);
    assert.ok(!shortcut.scopes.includes("search"), shortcut.id);
  }
  // Backspace is not a delete shortcut on Windows / Linux (Telex input methods send it to rewrite a letter).
  const del = SHORTCUTS.find((entry) => entry.id === "delete");
  assert.deepEqual(del.keys, ["Delete"]);
  assert.deepEqual(del.macAlso, ["Backspace"]);
  for (const shortcut of SHORTCUTS) assert.ok(!shortcut.keys.map(normaliseCombo).includes("Backspace"), shortcut.id);
  assert.deepEqual(keysOfShortcut("delete"), ["Delete"]);
  assert.deepEqual(keysOfShortcut("delete", { mac: true }), ["Delete", "Backspace"]);
  assert.deepEqual(keysOfShortcut("nope"), []);
});

test("matchShortcut resolves events per scope and ignores IME composition", () => {
  assert.equal(matchShortcut(key("r"), "viewer"), "tool:rect");
  assert.equal(matchShortcut(key("r"), "organiser"), "pageRotateCw");
  assert.equal(matchShortcut(key("r"), "text"), null);
  assert.equal(matchShortcut(key("R", { shiftKey: true }), "viewer"), "rotateView");
  assert.equal(matchShortcut(key("E", { shiftKey: true }), "selection"), "tool:eraser");
  assert.equal(matchShortcut(key("e"), "selection"), "tool:editText");
  assert.equal(matchShortcut(key("z", { ctrlKey: true }), "selection"), "undo");
  assert.equal(matchShortcut(key("z", { ctrlKey: true }), "text"), null, "typing keeps the native text undo");
  assert.equal(matchShortcut(key("Z", { ctrlKey: true, shiftKey: true }), "viewer"), "redo");
  assert.equal(matchShortcut(key("s", { ctrlKey: true }), "text"), "download");
  assert.equal(matchShortcut(key("b", { ctrlKey: true }), "text"), "bold");
  assert.equal(matchShortcut(key("b", { ctrlKey: true }), "viewer"), null);
  assert.equal(matchShortcut(key("b"), "viewer"), "tool:blur");
  assert.equal(matchShortcut(key("?", { shiftKey: true }), "viewer"), "shortcuts");
  assert.equal(matchShortcut(key(">", { ctrlKey: true, shiftKey: true }), "text"), "biggerText");
  assert.equal(matchShortcut(key("+", { ctrlKey: true, shiftKey: true }), "viewer"), "zoomIn");
  assert.equal(matchShortcut(key("=", { ctrlKey: true }), "viewer"), "zoomIn");
  assert.equal(matchShortcut(key(" "), "viewer"), "tempHand");
  assert.equal(matchShortcut(key(" "), "organiser"), "pageToggle");
  assert.equal(matchShortcut(key("ArrowLeft"), "viewer"), "previousPage");
  assert.equal(matchShortcut(key("ArrowLeft"), "selection"), "nudge");
  assert.equal(matchShortcut(key("ArrowLeft", { shiftKey: true }), "selection"), "nudgeBig");
  assert.equal(matchShortcut(key("ArrowUp", { ctrlKey: true, shiftKey: true }), "selection"), "bringToFront");
  assert.equal(matchShortcut(key("d", { ctrlKey: true }), "selection"), "duplicate");
  assert.equal(matchShortcut(key("d", { ctrlKey: true }), "viewer"), null, "nothing to duplicate: the browser keeps Ctrl+D");
  assert.equal(matchShortcut(key("Delete"), "selection"), "delete");
  assert.equal(matchShortcut(key("Backspace"), "selection"), null);
  assert.equal(matchShortcut(key("Backspace"), "selection", { mac: true }), "delete");
  assert.equal(matchShortcut(key("z", { metaKey: true }), "viewer", { mac: true }), "undo");
  assert.equal(matchShortcut(key("z", { ctrlKey: true }), "viewer", { mac: true }), null, "on macOS the Command key is the modifier");
  assert.equal(matchShortcut(key("s", { ctrlKey: true }), "viewer", { mac: true }), null, "Control+S on macOS is not the single key S");
  assert.equal(matchShortcut(key("s", { metaKey: true }), "viewer"), null, "nor is the Windows key + S");
  assert.equal(matchShortcut(key("s"), "viewer", { mac: true }), "tool:signature");
  assert.equal(matchShortcut(key("Escape"), "search"), "escape");
  assert.equal(matchShortcut(key("Enter"), "search"), "findNextInField");
  assert.equal(matchShortcut(key("Enter"), "selection"), "editObject");
  assert.equal(matchShortcut(key("g", { ctrlKey: true, altKey: true }), "text"), "goToPage");
  // preference off: single keys are dead, Ctrl shortcuts still work
  assert.equal(matchShortcut(key("r"), "viewer", { singleKeys: false }), null);
  assert.equal(matchShortcut(key("o", { ctrlKey: true }), "viewer", { singleKeys: false }), "open");
  // IME composition and auto-repeat
  assert.equal(comboFromEvent({ key: "s", isComposing: true }), null);
  assert.equal(comboFromEvent({ key: "Process", keyCode: 229 }), null);
  assert.equal(comboFromEvent({ key: "Dead" }), null);
  assert.equal(comboFromEvent({ key: "Shift", shiftKey: true }), null);
  assert.equal(comboFromEvent(null), null);
  assert.equal(matchShortcut({ ...key("r"), repeat: true }, "viewer"), null);
  assert.equal(matchShortcut({ ...key("z", { ctrlKey: true }), repeat: true }, "viewer"), "undo", "holding Ctrl+Z keeps undoing");
});

test("letters an input method produced are never tool keys; other layouts keep their Ctrl shortcuts; AltGr types characters", () => {
  // Telex: "w" arrives as the letter u with a horn, "aa" as a with a circumflex: not a shortcut
  const hornU = String.fromCharCode(0x1b0);
  assert.equal(matchShortcut(key(hornU), "viewer"), null);
  assert.equal(matchShortcut({ ...key(String.fromCharCode(0xe2)), code: "KeyA" }, "viewer"), null, "the physical key does not count for single keys");
  // a Cyrillic layout: Ctrl + the key where Z is printed
  const cyrillic = String.fromCharCode(0x44f);
  assert.equal(matchShortcut({ ...key(cyrillic, { ctrlKey: true }), code: "KeyZ" }, "viewer"), "undo");
  assert.equal(matchShortcut({ ...key(cyrillic, { ctrlKey: true }), code: "Digit0" }, "viewer"), "zoomAuto");
  assert.equal(matchShortcut(key(cyrillic, { ctrlKey: true }), "viewer"), null, "without a physical key code nothing is guessed");
  // AltGr is reported as Ctrl+Alt: it types characters and never triggers Ctrl+Alt+G / Ctrl+Alt+P
  const altGr = { ...key("g", { ctrlKey: true, altKey: true }), getModifierState: (name) => name === "AltGraph" };
  assert.equal(matchShortcut(altGr, "viewer"), null);
  assert.equal(matchShortcut({ ...altGr, getModifierState: () => false }, "viewer"), "goToPage");
  assert.equal(normaliseCombo("Shift+Ctrl+z"), "Ctrl+Shift+Z");
  assert.equal(normaliseCombo("Ctrl++"), "Ctrl++");
  assert.equal(normaliseCombo("+"), "+");
  assert.throws(() => normaliseCombo("Hyper+X"), /Unknown modifier/);
});

test("scopes, sections and key caps for the keyboard help", () => {
  assert.equal(scopeFor(), "viewer");
  assert.equal(scopeFor({ selectionCount: 2 }), "selection");
  assert.equal(scopeFor({ organiser: true, selectionCount: 2 }), "organiser");
  assert.equal(scopeFor({ typing: true, organiser: true }), "text");
  assert.equal(scopeFor({ search: true, typing: true }), "search");
  assert.deepEqual(Object.keys(SCOPE_LABELS), [...SCOPES]);
  assert.deepEqual(SHORTCUT_SECTIONS.map((section) => section.id), ["file", "edit", "objects", "text", "tools", "view", "pages"]);
  for (const shortcut of SHORTCUTS) assert.ok(SHORTCUT_SECTIONS.some((section) => section.id === shortcut.section), shortcut.id);
  for (const section of SHORTCUT_SECTIONS) assert.ok(shortcutsOfSection(section.id).length > 0, section.id);
  assert.equal(shortcutsOfSection("tools").length, TOOLS.length + 1);
  assert.equal(shortcutById("nope"), null);

  assert.deepEqual(comboKeyCaps("Ctrl+Shift+Z"), ["Ctrl", "Shift", "Z"]);
  assert.equal(formatCombo("Ctrl+Shift+Z"), "Ctrl+Shift+Z");
  assert.equal(formatCombo("Ctrl++"), "Ctrl++");
  assert.equal(formatCombo("Escape"), "Esc");
  assert.equal(formatCombo("Shift+ArrowLeft"), `Shift+${String.fromCharCode(0x2190)}`);
  assert.deepEqual(comboKeyCaps("Ctrl+ArrowUp", { mac: true }), [String.fromCharCode(0x2318), String.fromCharCode(0x2191)]);
  assert.equal(formatCombo("Ctrl+Alt+P", { mac: true }), `${String.fromCharCode(0x2318)}${String.fromCharCode(0x2325)}P`);
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("iPhone"), true);
  assert.equal(isMacPlatform("Win32"), false);
  assert.equal(isMacPlatform(undefined), false);
});

test("every label used by tools, commands and shortcuts has a Vietnamese entry", () => {
  const labels = [...TOOL_GROUPS, ...TOOLS, ...TOOL_MENUS, ...COMMANDS, ...SHORTCUTS, ...SHORTCUT_SECTIONS].map((entry) => entry.label);
  labels.push(...Object.values(SCOPE_LABELS), ...Object.values(HINTS));
  assert.ok(labels.every((label) => typeof label === "string" && label));
  const missing = [...new Set(labels)].filter((label) => !hasTranslation(label, "vi"));
  assert.deepEqual(missing, []);
  assert.equal(translate("Redact", null, "vi"), "Che dữ liệu");
  assert.equal(translate("Redact", null, "en"), "Redact");
  assert.equal(translate(toolById("certSign").label, null, "vi"), "Ký số");
  assert.equal(translate(toolById("signature").label, null, "vi"), "Chữ ký");
  assert.equal(translate(shortcutById("tool:blur").label, null, "vi"), "Làm mờ");
});

test("Vietnamese wording follows the application's conventions and stays consistent", () => {
  for (const [en, text] of Object.entries(dictionary)) {
    assert.ok(text && text.trim() === text, en);
    assert.ok(!/Xoá|xoá/.test(text), `"${en}": use "Xóa"`);
    assert.ok(!/Huỷ|huỷ/.test(text), `"${en}": use "Hủy"`);
    assert.ok(!/tập tin/i.test(text), `"${en}": use "tệp"`);
    assert.ok(!/chứng chỉ/i.test(text), `"${en}": use "chứng thư số"`);
    assert.ok(!/chữ ký điện tử/i.test(text), `"${en}": certificate signatures are "chữ ký số"`);
    assert.deepEqual(placeholdersOf(text).sort(), placeholdersOf(en).sort(), `placeholders differ in "${en}"`);
    assert.ok(text.normalize("NFC") === text, `"${en}" is not NFC-normalised`);
    assert.ok(en.normalize("NFC") === en && en.trim() === en, en);
    assert.ok(/^[A-Z]/.test(en), `"${en}": English keys start with a capital (lower-case keys are legacy short keys)`);
  }
  assert.equal(dictionary["Redact"], "Che dữ liệu");
  assert.equal(dictionary["Blur"], "Làm mờ");
  assert.equal(dictionary["Highlight"], "Tô sáng");
  assert.equal(dictionary["Sign with certificate"], "Ký số");
  assert.equal(dictionary["Certificate file"], "Tệp chứng thư số");
  assert.equal(dictionary["Create a self-signed certificate"], "Tạo chứng thư số tự ký");
  assert.equal(dictionary["Delete"], "Xóa");
  assert.equal(dictionary["Add files"], "Thêm tệp");
  // "Duplicate" already means "Trùng lặp" (a duplicate record) elsewhere in the application
  assert.ok(!("Duplicate" in dictionary));
  assert.equal(dictionary["Duplicate object"], "Nhân bản đối tượng");
  assert.equal(dictionary["Duplicate page"], "Nhân bản trang");
  // a key that another dictionary has carries the same text here
  const conflicts = [];
  for (const namespace of NAMESPACES) {
    if (namespace.entries === dictionary) continue;
    for (const [en, text] of Object.entries(dictionary)) {
      if (Object.hasOwn(namespace.entries, en) && namespace.entries[en] !== text) conflicts.push(`${en}: ${namespace.name} says ${namespace.entries[en]}`);
    }
  }
  assert.deepEqual(conflicts, []);
});

test("the dictionary has exactly the texts the editor uses: none missing, none left over", () => {
  const files = listBilingualFiles().filter((file) => file.startsWith("src/pages/pdfEditor/"));
  const toolFiles = files.filter((file) => file.startsWith("src/pages/pdfEditor/tools/"));
  for (const name of ["interaction.js", "keymap.js", "registry.js"]) assert.ok(toolFiles.includes(`src/pages/pdfEditor/tools/${name}`), `${name} is checked by the i18n lint rule`);
  const usedByTools = new Set();
  const usedByEditor = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(FRONTEND_ROOT, file), "utf8");
    for (const { key: text } of extractKeys(source)) {
      usedByEditor.add(text);
      if (toolFiles.includes(file)) usedByTools.add(text);
    }
  }
  assert.deepEqual([...usedByTools].filter((text) => !hasTranslation(text, "vi")), [], "every tk() text of the tool modules is translated");
  assert.deepEqual(Object.keys(dictionary).filter((text) => !usedByEditor.has(text)), [], "an entry that no source file uses");
});
