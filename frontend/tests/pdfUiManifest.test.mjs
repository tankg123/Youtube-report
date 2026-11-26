// The feature manifest of the PDF editor (src/pages/pdfEditor/ui/manifest.js) and the icon table the shell
// renders registry entries with (ui/icons.js).
import test from "node:test";
import assert from "node:assert/strict";
import { allIconNames } from "../src/pages/pdfEditor/tools/registry.js";
import { ICONS, iconByName } from "../src/pages/pdfEditor/ui/icons.js";
import { MANIFEST_MEMBERS, checkManifest, mergeManifests } from "../src/pages/pdfEditor/ui/manifest.js";

const A = () => null;
const B = () => null;
const C = () => null;
// what React.memo / forwardRef give: an object, not a function
const memoLike = { $$typeof: Symbol.for("react.memo"), type: A };

test("a well-formed manifest has no problems", () => {
  const manifest = {
    id: "overlay",
    pageOverlay: A,
    propertiesPanel: memoLike,
    selectionBar: B,
    contextMenu: C,
    panels: { pages: { labelKey: "Pages", icon: "LayoutGrid", component: A, order: 10 } },
    dialogs: { signature: memoLike },
    drawers: { certificate: A },
    fullScreenViews: { organiser: A },
    banners: [A],
    statusItems: [B],
    toolActivators: { image: () => {} },
    commands: { copy: () => true },
    effectExecutor: () => {},
    onDocumentOpened: () => {},
    onDocumentClosed: () => {}
  };
  assert.deepEqual(checkManifest(manifest, "overlay"), []);
  assert.deepEqual(Object.keys(manifest).sort(), Object.keys(MANIFEST_MEMBERS).sort(), "the example uses every member");
  assert.deepEqual(checkManifest({}, "empty"), []);
  assert.deepEqual(checkManifest({ pageOverlay: null, panels: undefined }, "holes"), [], "a missing member may be spelled out");
});

test("unknown members and wrong shapes are named", () => {
  assert.deepEqual(checkManifest(null, "x"), ["x: not an object"]);
  assert.deepEqual(checkManifest([], "x"), ["x: not an object"]);
  const problems = checkManifest(
    {
      id: 7,
      pageOverlays: A,
      pageOverlay: "PageOverlay",
      panels: { pages: { labelKey: "Pages" }, outline: A },
      dialogs: { signature: "SignatureDialog" },
      banners: [A, "banner"],
      statusItems: A,
      toolActivators: { image: true },
      commands: [],
      effectExecutor: {},
      onDocumentOpened: 1
    },
    "x"
  );
  assert.deepEqual(problems, [
    "x.id: not a string",
    "x.pageOverlays: unknown member",
    "x.pageOverlay: not a component",
    "x.banners: not a list of components",
    "x.statusItems: not a list of components",
    "x.commands: not an object",
    "x.effectExecutor: not a function",
    "x.onDocumentOpened: not a function",
    "x.panels.pages: needs { labelKey, icon, component, order }",
    "x.panels.outline: needs { labelKey, icon, component, order }",
    "x.dialogs.signature: not a component",
    "x.toolActivators.image: not a function"
  ]);
});

test("manifests merge in order: slots are collected, panels sorted, handlers of one id all kept", () => {
  const calls = [];
  const merged = mergeManifests([
    {
      id: "overlay",
      pageOverlay: A,
      propertiesPanel: A,
      selectionBar: A,
      contextMenu: A,
      toolActivators: { image: () => calls.push("overlay:image") },
      commands: { copy: () => calls.push("overlay:copy"), delete: () => true },
      effectExecutor: () => calls.push("overlay:effects")
    },
    {
      id: "pages",
      panels: { outline: { labelKey: "Outline", icon: "ListTree", component: B, order: 20 }, pages: { labelKey: "Pages", icon: "LayoutGrid", component: A, order: 10 } },
      fullScreenViews: { organiser: B },
      dialogs: { insertBlank: B },
      commands: { copy: () => calls.push("pages:copy") },
      onDocumentOpened: () => calls.push("pages:opened")
    },
    {
      id: "signing",
      pageOverlay: C,
      panels: { signatures: { labelKey: "Signatures", icon: "ShieldCheck", component: C, order: 30 }, extra: { labelKey: "Extra", component: C } },
      drawers: { certificate: C },
      dialogs: { signature: C },
      banners: [C],
      statusItems: [C],
      toolActivators: { signature: () => calls.push("signing:signature"), image: () => calls.push("signing:image") },
      onDocumentOpened: () => calls.push("signing:opened"),
      onDocumentClosed: () => calls.push("signing:closed")
    }
  ]);
  assert.deepEqual(merged.problems, []);
  assert.deepEqual(merged.pageOverlays, [A, C]);
  assert.equal(merged.propertiesPanel, A);
  assert.deepEqual(merged.selectionBars, [A]);
  assert.deepEqual(merged.contextMenus, [A]);
  assert.deepEqual(merged.panels.map((panel) => [panel.id, panel.order, panel.icon]), [["pages", 10, "LayoutGrid"], ["outline", 20, "ListTree"], ["signatures", 30, "ShieldCheck"], ["extra", 100, null]]);
  assert.deepEqual(Object.keys(merged.dialogs), ["insertBlank", "signature"]);
  assert.deepEqual(Object.keys(merged.drawers), ["certificate"]);
  assert.deepEqual(Object.keys(merged.fullScreenViews), ["organiser"]);
  assert.deepEqual(merged.banners, [C]);
  assert.deepEqual(merged.statusItems, [C]);

  merged.toolActivators.image.forEach((activate) => activate());
  merged.commands.copy.forEach((command) => command());
  merged.effectExecutors.forEach((execute) => execute());
  merged.onDocumentOpened.forEach((hook) => hook());
  merged.onDocumentClosed.forEach((hook) => hook());
  assert.deepEqual(calls, ["overlay:image", "signing:image", "overlay:copy", "pages:copy", "overlay:effects", "pages:opened", "signing:opened", "signing:closed"]);
  assert.equal(merged.commands.delete.length, 1);
  assert.equal(merged.toolActivators.signature.length, 1);
});

test("two features cannot take the same panel, dialog, drawer or view, nor both bring a properties panel", () => {
  const merged = mergeManifests([
    { id: "one", propertiesPanel: A, panels: { pages: { labelKey: "Pages", component: A } }, dialogs: { pick: A }, drawers: { side: A }, fullScreenViews: { organiser: A } },
    { id: "two", propertiesPanel: B, panels: { pages: { labelKey: "Pages", component: B } }, dialogs: { pick: B }, drawers: { side: B }, fullScreenViews: { organiser: B } }
  ]);
  assert.deepEqual(merged.problems, [
    "two.propertiesPanel: another feature already has one",
    "two.panels.pages: duplicate id",
    "two.dialogs.pick: duplicate id",
    "two.drawers.side: duplicate id",
    "two.fullScreenViews.organiser: duplicate id"
  ]);
  assert.equal(merged.propertiesPanel, A, "the first one stays");
  assert.equal(merged.panels[0].component, A);
  assert.equal(merged.dialogs.pick, A);
});

test("a broken manifest costs its own parts only", () => {
  const merged = mergeManifests([null, { pageOverlay: "nope", panels: { pages: { labelKey: "Pages", component: A } }, banners: [A, 3] }, undefined]);
  assert.deepEqual(merged.problems, ["manifest[0]: not an object", "manifest[1].pageOverlay: not a component", "manifest[1].banners: not a list of components", "manifest[2]: not an object"]);
  assert.deepEqual(merged.pageOverlays, []);
  assert.deepEqual(merged.panels.map((panel) => panel.id), ["pages"]);
  assert.deepEqual(merged.banners, [A]);
  assert.deepEqual(mergeManifests(undefined).problems, []);
});

test("every icon the tool and command registry names is in the shell's icon table", () => {
  const missing = allIconNames().filter((name) => !ICONS[name]);
  assert.deepEqual(missing, []);
  for (const name of ["LayoutGrid", "ListTree", "ShieldCheck"]) assert.ok(iconByName(name), `${name}: icon of a left panel`);
  assert.equal(iconByName("NoSuchIcon"), null);
  assert.equal(iconByName(undefined), null);
});
