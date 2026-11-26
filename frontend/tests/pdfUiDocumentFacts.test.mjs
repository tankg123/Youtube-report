// Facts about the open document (src/pages/pdfEditor/ui/documentFacts.js) and the keyboard help generated from
// the shortcut table (src/pages/pdfEditor/ui/shortcutHelp.js).
import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../src/i18n/index.js";
import { SHORTCUTS, SHORTCUT_SECTIONS } from "../src/pages/pdfEditor/tools/keymap.js";
import { byteSize, parsePdfDate, restrictedChanges, restrictsChanges } from "../src/pages/pdfEditor/ui/documentFacts.js";
import { filterShortcutHelp, shortcutHelp } from "../src/pages/pdfEditor/ui/shortcutHelp.js";

const ALL = { print: true, modify: true, copy: true, annotate: true, fillForms: true, copyForAccessibility: true, assemble: true, printHighQuality: true };

test("a file restricts changes when its author took away modify, annotate, assemble or form filling", () => {
  assert.equal(restrictsChanges(null), false, "no permission flags: no restrictions");
  assert.equal(restrictsChanges(undefined), false);
  assert.equal(restrictsChanges(ALL), false, "encrypted with everything allowed");
  assert.equal(restrictsChanges({ ...ALL, print: false, copy: false, printHighQuality: false }), false, "print and copy limits are not about editing");
  for (const key of ["modify", "annotate", "assemble", "fillForms"]) {
    assert.equal(restrictsChanges({ ...ALL, [key]: false }), true, key);
    assert.deepEqual(restrictedChanges({ ...ALL, [key]: false }), [key]);
  }
  assert.deepEqual(restrictedChanges({ ...ALL, modify: false, assemble: false, print: false }), ["modify", "assemble"]);
  assert.deepEqual(restrictedChanges(null), []);
  assert.equal(restrictsChanges({ flags: [] }), false, "a flag that is missing is not a restriction");
});

test("dates of the document properties: every form the PDF format allows, and nothing for anything else", () => {
  const iso = (text) => parsePdfDate(text)?.toISOString() ?? null;
  assert.equal(iso("D:20261120093000+07'00'"), "2026-11-20T02:30:00.000Z");
  assert.equal(iso("D:20261120093000-05'30'"), "2026-11-20T15:00:00.000Z");
  assert.equal(iso("D:20261120093000Z"), "2026-11-20T09:30:00.000Z");
  assert.equal(iso("D:20261120093000Z00'00'"), "2026-11-20T09:30:00.000Z");
  assert.equal(iso("D:20261120093000"), "2026-11-20T09:30:00.000Z", "no zone: read as UTC");
  assert.equal(iso("20261120"), "2026-11-20T00:00:00.000Z", "the prefix is optional");
  assert.equal(iso("D:2026"), "2026-01-01T00:00:00.000Z");
  assert.equal(iso("D:20261120093000+07"), "2026-11-20T02:30:00.000Z");
  assert.equal(iso("  D:20260115100000+07'00  "), "2026-01-15T03:00:00.000Z");
  for (const bad of ["", "yesterday", "D:20261320", "D:20261132", "D:20261120250000", null, undefined, 20261120, {}]) assert.equal(parsePdfDate(bad), null, String(bad));
  const date = new Date("2026-11-20T00:00:00Z");
  assert.equal(parsePdfDate(date), date);
  assert.equal(parsePdfDate(new Date("nothing")), null);
});

test("byte sizes are written for people", () => {
  const format = (value, options) => new Intl.NumberFormat("en", options).format(value);
  assert.equal(byteSize(512, format), "512 B");
  assert.equal(byteSize(7578, format), "7.4 kB");
  assert.equal(byteSize(1024 * 1024 * 1.25, format), "1.25 MB");
  assert.equal(byteSize(1024 * 1024 * 46.52, format), "46.5 MB");
  assert.equal(byteSize(-1), "");
  assert.equal(byteSize("x"), "");
  assert.equal(byteSize(0), "0 B");
});

test("the keyboard help holds every shortcut of the table once, by section, with key caps", () => {
  const sections = shortcutHelp({ hasCommand: () => true });
  assert.deepEqual(sections.map((section) => section.id), SHORTCUT_SECTIONS.map((section) => section.id));
  const rows = sections.flatMap((section) => section.rows);
  assert.deepEqual(rows.map((row) => row.id).sort(), SHORTCUTS.map((entry) => entry.id).sort());
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.redo.combos, [["Ctrl", "Y"], ["Ctrl", "Shift", "Z"]]);
  assert.deepEqual([byId.download.everywhere, byId.undo.everywhere], [true, false]);
  assert.deepEqual(byId.undo.scopes, ["Page area", "Selected objects", "Page organiser"]);
  assert.deepEqual([byId["tool:redact"].single, byId["tool:redact"].combos, byId.tempHand.hold], [true, [["X"]], true]);
  assert.equal(byId.download.single, false);
  assert.deepEqual(byId.delete.combos, [["Delete"]]);
  const mac = Object.fromEntries(shortcutHelp({ mac: true, hasCommand: () => true }).flatMap((section) => section.rows).map((row) => [row.id, row]));
  assert.equal(mac.delete.combos.length, 2, "macOS also deletes with Backspace");
  assert.notDeepEqual(mac.download.combos, byId.download.combos, "macOS prints the Command symbol");
});

test("a key that does nothing is not in the help: Rotate view without a feature behind it, G without an organiser", () => {
  const ids = (options) => shortcutHelp(options).flatMap((section) => section.rows).map((row) => row.id);
  assert.equal(ids({}).includes("rotateView"), false);
  assert.equal(ids({ hasCommand: (id) => id === "rotateView" }).includes("rotateView"), true);
  assert.equal(ids({ hasOrganiser: false }).includes("organise"), false);
  assert.equal(ids({}).includes("organise"), true);
  assert.equal(ids({}).includes("shortcuts"), true);
});

test("the search of the help reads labels, keys and places, in the language of the interface, without diacritics", () => {
  const sections = shortcutHelp({});
  const found = (query) => filterShortcutHelp(sections, query).flatMap((section) => section.rows).map((row) => row.id);
  assert.equal(filterShortcutHelp(sections, "   "), sections, "nothing typed: everything");
  assert.deepEqual(found("ctrl+s"), ["download"]);
  assert.deepEqual(found("Ctrl S"), ["download"]);
  assert.deepEqual(found("zoom in"), ["zoomIn"]);
  assert.ok(found("search field").includes("findNextInField"));
  assert.deepEqual(found("no such shortcut"), []);
  assert.deepEqual(filterShortcutHelp(sections, "zoom").map((section) => section.id), ["view"], "sections without a hit are left out");
  setLanguage("vi");
  try {
    assert.deepEqual(found("phong to"), ["zoomIn"], "Vietnamese labels, typed without diacritics");
    assert.deepEqual(found("Phóng to"), ["zoomIn"]);
    assert.deepEqual(found("che du lieu"), ["tool:redact"], "d with stroke is found by a plain d");
    assert.deepEqual(found("zoom in"), [], "the English label is not searched in Vietnamese");
  } finally {
    setLanguage("en");
  }
});

test("a browser that lacks what the editor needs is told what, by name; this runtime lacks nothing it can have", async () => {
  const { REQUIRED_BROWSER_FEATURES, missingBrowserFeatures } = await import("../src/pages/pdfEditor/ui/browserSupport.js");
  class Element {}
  Element.prototype.inert = false;
  const modern = { Intl, structuredClone, ResizeObserver: class {}, Worker: class {}, AbortController, Blob, Array, Object, HTMLElement: Element };
  assert.deepEqual(missingBrowserFeatures(modern), []);
  assert.deepEqual(missingBrowserFeatures({ ...modern, Intl: {}, ResizeObserver: undefined }), ["Intl.Segmenter", "ResizeObserver"]);
  assert.deepEqual(missingBrowserFeatures({ ...modern, HTMLElement: class {} }), ["inert"]);
  assert.deepEqual(missingBrowserFeatures({}), REQUIRED_BROWSER_FEATURES.filter((name) => name !== "inert"), "an empty world lacks everything (and has no elements to make inert)");
  const throwing = new Proxy({}, { get: () => { throw new Error("no"); } });
  assert.equal(missingBrowserFeatures(throwing).length, REQUIRED_BROWSER_FEATURES.length, "a check that throws counts as missing");
  // node has no DOM: only what belongs to a page may be missing here
  assert.deepEqual(missingBrowserFeatures().filter((name) => !["ResizeObserver", "Web Workers"].includes(name)), []);
});
