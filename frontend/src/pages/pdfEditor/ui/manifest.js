// The feature manifest: how overlay/, pages/ and signing/ plug into the kernel. Each feature entry module
// default-exports a plain object; this module checks the three objects and merges them into the tables the
// shell renders from (the manual with every member is the header of ui/EditorContext.jsx).
// Pure: tests/pdfUiManifest.test.mjs.

/** The members a feature manifest may have, and the shape of each. */
export const MANIFEST_MEMBERS = Object.freeze({
  id: "string",
  pageOverlay: "component",
  propertiesPanel: "component",
  selectionBar: "component",
  contextMenu: "component",
  panels: "map", // { id: { labelKey, icon, component, order } }
  dialogs: "map", // { id: component }
  drawers: "map", // { id: component }
  fullScreenViews: "map", // { id: component }
  banners: "list", // [component]
  statusItems: "list", // [component]
  toolActivators: "map", // { toolId: (editor) => void | Promise }
  commands: "map", // { commandId: (editor, event) => boolean }
  effectExecutor: "function", // (editor, effects, event) => void
  onDocumentOpened: "function", // (editor, { sourceId, facts, name }) => void
  onDocumentClosed: "function" // (editor) => void
});

const isComponent = (value) => typeof value === "function" || (Boolean(value) && typeof value === "object" && "$$typeof" in value);
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Problems of one feature manifest (empty = fine): unknown members and wrong shapes. */
export function checkManifest(manifest, label = "manifest") {
  if (!isPlainObject(manifest)) return [`${label}: not an object`];
  const problems = [];
  for (const [key, value] of Object.entries(manifest)) {
    const shape = MANIFEST_MEMBERS[key];
    if (!shape) {
      problems.push(`${label}.${key}: unknown member`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (shape === "string" && typeof value !== "string") problems.push(`${label}.${key}: not a string`);
    if (shape === "component" && !isComponent(value)) problems.push(`${label}.${key}: not a component`);
    if (shape === "function" && typeof value !== "function") problems.push(`${label}.${key}: not a function`);
    if (shape === "list" && !(Array.isArray(value) && value.every(isComponent))) problems.push(`${label}.${key}: not a list of components`);
    if (shape === "map" && !isPlainObject(value)) problems.push(`${label}.${key}: not an object`);
  }
  for (const [id, panel] of Object.entries(isPlainObject(manifest.panels) ? manifest.panels : {})) {
    if (!isPlainObject(panel) || typeof panel.labelKey !== "string" || !isComponent(panel.component)) problems.push(`${label}.panels.${id}: needs { labelKey, icon, component, order }`);
  }
  for (const key of ["dialogs", "drawers", "fullScreenViews"]) {
    for (const [id, component] of Object.entries(isPlainObject(manifest[key]) ? manifest[key] : {})) {
      if (!isComponent(component)) problems.push(`${label}.${key}.${id}: not a component`);
    }
  }
  for (const key of ["toolActivators", "commands"]) {
    for (const [id, handler] of Object.entries(isPlainObject(manifest[key]) ? manifest[key] : {})) {
      if (typeof handler !== "function") problems.push(`${label}.${key}.${id}: not a function`);
    }
  }
  return problems;
}

/**
 * Merges feature manifests, in the order given.
 * @param {object[]} manifests
 * @returns {{
 *   pageOverlays: Function[], propertiesPanel: Function | null, selectionBars: Function[], contextMenus: Function[],
 *   panels: Array<{ id, labelKey, icon, component, order }>, dialogs: object, drawers: object, fullScreenViews: object,
 *   banners: Function[], statusItems: Function[], toolActivators: { [toolId]: Function[] },
 *   commands: { [commandId]: Function[] }, effectExecutors: Function[], onDocumentOpened: Function[],
 *   onDocumentClosed: Function[], problems: string[]
 * }}
 *   One id for two panels, dialogs, drawers or views is a problem (the first one stays); tool activators and
 *   commands of the same id are all kept and asked in order.
 */
export function mergeManifests(manifests) {
  const merged = {
    pageOverlays: [],
    propertiesPanel: null,
    selectionBars: [],
    contextMenus: [],
    panels: [],
    dialogs: {},
    drawers: {},
    fullScreenViews: {},
    banners: [],
    statusItems: [],
    toolActivators: {},
    commands: {},
    effectExecutors: [],
    onDocumentOpened: [],
    onDocumentClosed: [],
    problems: []
  };
  const panelIds = new Set();
  (manifests || []).forEach((manifest, index) => {
    const label = typeof manifest?.id === "string" && manifest.id ? manifest.id : `manifest[${index}]`;
    const problems = checkManifest(manifest, label);
    merged.problems.push(...problems);
    if (!isPlainObject(manifest)) return;
    if (isComponent(manifest.pageOverlay)) merged.pageOverlays.push(manifest.pageOverlay);
    if (isComponent(manifest.propertiesPanel)) {
      if (merged.propertiesPanel) merged.problems.push(`${label}.propertiesPanel: another feature already has one`);
      else merged.propertiesPanel = manifest.propertiesPanel;
    }
    if (isComponent(manifest.selectionBar)) merged.selectionBars.push(manifest.selectionBar);
    if (isComponent(manifest.contextMenu)) merged.contextMenus.push(manifest.contextMenu);
    for (const [id, panel] of Object.entries(isPlainObject(manifest.panels) ? manifest.panels : {})) {
      if (!isPlainObject(panel) || !isComponent(panel.component) || typeof panel.labelKey !== "string") continue;
      if (panelIds.has(id)) {
        merged.problems.push(`${label}.panels.${id}: duplicate id`);
        continue;
      }
      panelIds.add(id);
      merged.panels.push({ id, labelKey: panel.labelKey, icon: panel.icon ?? null, component: panel.component, order: Number.isFinite(panel.order) ? panel.order : 100 });
    }
    for (const key of ["dialogs", "drawers", "fullScreenViews"]) {
      for (const [id, component] of Object.entries(isPlainObject(manifest[key]) ? manifest[key] : {})) {
        if (!isComponent(component)) continue;
        if (merged[key][id]) merged.problems.push(`${label}.${key}.${id}: duplicate id`);
        else merged[key][id] = component;
      }
    }
    for (const key of ["banners", "statusItems"]) {
      if (Array.isArray(manifest[key])) merged[key].push(...manifest[key].filter(isComponent));
    }
    for (const key of ["toolActivators", "commands"]) {
      for (const [id, handler] of Object.entries(isPlainObject(manifest[key]) ? manifest[key] : {})) {
        if (typeof handler !== "function") continue;
        (merged[key][id] ||= []).push(handler);
      }
    }
    if (typeof manifest.effectExecutor === "function") merged.effectExecutors.push(manifest.effectExecutor);
    if (typeof manifest.onDocumentOpened === "function") merged.onDocumentOpened.push(manifest.onDocumentOpened);
    if (typeof manifest.onDocumentClosed === "function") merged.onDocumentClosed.push(manifest.onDocumentClosed);
  });
  merged.panels.sort((a, b) => a.order - b.order);
  return merged;
}
