// Fixtures of the document-model suites (tests/pdfModel*.test.mjs, tests/pdfTools*.test.mjs): viewer facts,
// a deterministic text measurer and layout, sample objects of every type, numeric comparisons.
// Nothing here opens a PDF: the model only ever sees the facts the viewer reports.
import assert from "node:assert/strict";
import { createEditorStore } from "../../src/pages/pdfEditor/model/store.js";
import { OBJECT_DEFAULTS, fontKey } from "../../src/pages/pdfEditor/model/schema.js";

export const A4 = Object.freeze([0, 0, 595.28, 841.89]);

/** Page geometries that change every mapping: /Rotate, a shifted and cropped box, /UserUnit. */
export const PAGE_VARIANTS = Object.freeze([
  { name: "plain", view: [0, 0, 600, 800], rotate: 0, userUnit: 1 },
  { name: "/Rotate 90", view: [0, 0, 600, 800], rotate: 90, userUnit: 1 },
  { name: "/Rotate 180, shifted box", view: [-40, 100, 560, 900], rotate: 180, userUnit: 1 },
  { name: "/Rotate 270, cropped, user unit 2", view: [50, 10, 350, 410], rotate: 270, userUnit: 2 }
]);
export const EXTRA_ROTATIONS = Object.freeze([0, 90, 180, 270]);

export const close = (actual, expected, tolerance = 1e-6, label = "") => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);
};
export const closeAll = (actual, expected, tolerance = 1e-6, label = "") => {
  assert.equal(actual.length, expected.length, `${label} length`);
  actual.forEach((value, index) => close(value, expected[index], tolerance, `${label}[${index}]`));
};

/** The facts a viewer reports for a source: one entry per page ({ view, rotate, userUnit }, all optional). */
export function sourceFacts(pages = [{}], extra = {}) {
  return {
    pageCount: pages.length,
    pages: pages.map((page) => ({ view: (page.view || A4).slice(), rotate: page.rotate || 0, userUnit: page.userUnit || 1 })),
    info: { title: "Hợp đồng dịch vụ", author: "ANS Network" },
    encrypted: false,
    signatureFieldCount: 0,
    ...extra
  };
}

/** `length` bytes that differ per seed (a stand-in for a PDF or an image). */
export function bytesOf(length = 64, seed = 1) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed * 17) % 251;
  return bytes;
}

// A text measurer with simple, exact rules: every character is half an em wide, lines are size x lineHeight
// high, a wrapping box breaks after as many characters as fit its width.
const ADVANCE = 0.5;
function linesOf(object) {
  const perLine = object.autoWidth ? Infinity : Math.max(1, Math.floor(object.frame.w / (object.size * ADVANCE) + 1e-9));
  const lines = [];
  for (const paragraph of object.text.split("\n")) {
    const chars = Array.from(paragraph);
    if (!chars.length) lines.push("");
    for (let index = 0; index < chars.length; index += perLine) lines.push(chars.slice(index, index + perLine).join(""));
  }
  return lines;
}

export function fakeMeasure(object) {
  const lines = linesOf(object);
  const longest = Math.max(0, ...lines.map((line) => Array.from(line).length));
  return { w: object.autoWidth ? longest * object.size * ADVANCE : object.frame.w, h: lines.length * object.size * object.lineHeight };
}

/** The TextLayout that belongs to fakeMeasure (one run per line in the box's own font). */
export function fakeLayout(object) {
  const lines = linesOf(object);
  const { w, h } = fakeMeasure(object);
  const lineHeight = object.size * object.lineHeight;
  return {
    width: w,
    height: h,
    lines: lines.map((text, index) => {
      const width = Array.from(text).length * object.size * ADVANCE;
      const x = object.align === "center" ? (w - width) / 2 : object.align === "right" ? w - width : 0;
      return { baseline: index * lineHeight + object.size * 0.9, x, width, runs: [{ text, x, font: fontKey(object) }] };
    }),
    raster: null,
    problems: []
  };
}

/**
 * A store with one opened source (history empty, not dirty).
 * @param {{ pages?: object[], measure?: Function | null, facts?: object, password?: string, name?: string, storeOptions?: object }} [options]
 *        pages: one entry per page ({ view, rotate, userUnit }, all optional); measure: the text measurer (null = none);
 *        facts: merged into the viewer facts; storeOptions: passed to createEditorStore (now, historyLimit, ...)
 * @returns {{ store, sourceId, pageIds: string[], bytes: Uint8Array }}
 */
export function openStore({ pages = [{}, {}, {}], measure = fakeMeasure, facts = {}, password, name = "hop-dong.pdf", storeOptions = {} } = {}) {
  const store = createEditorStore({ measureText: measure || undefined, ...storeOptions });
  const bytes = bytesOf(96, 7);
  let sourceId;
  store.reset(() => {
    sourceId = store.addSource(sourceFacts(pages, facts), bytes, { password, name });
    store.insertPages(store.pagesOfSource(sourceId), 0);
    store.setFileName(name);
  });
  return { store, sourceId, pageIds: store.getState().pages.map((page) => page.id), bytes };
}

/** Sample objects (without id) of every type for the page `pageId`; overrides are merged in. */
export const sample = {
  text: (pageId, extra = {}) => ({ type: "text", pageId, frame: { x: 200, y: 600, w: 60, h: 14.4, rot: 0 }, text: "Xin chào", ...OBJECT_DEFAULTS.text, ...extra }),
  image: (pageId, assetId, extra = {}) => ({ type: "image", pageId, frame: { x: 300, y: 400, w: 120, h: 60, rot: 0 }, assetId, ...OBJECT_DEFAULTS.image, ...extra }),
  rect: (pageId, extra = {}) => ({ type: "rect", pageId, frame: { x: 150, y: 500, w: 120, h: 80, rot: 0 }, ...OBJECT_DEFAULTS.rect, ...extra }),
  ellipse: (pageId, extra = {}) => ({ type: "ellipse", pageId, frame: { x: 400, y: 300, w: 100, h: 60, rot: 0 }, ...OBJECT_DEFAULTS.ellipse, ...extra }),
  line: (pageId, extra = {}) => ({ type: "line", pageId, p1: [100, 100], p2: [220, 100], ...OBJECT_DEFAULTS.line, ...extra }),
  pen: (pageId, extra = {}) => ({ type: "pen", pageId, frame: { x: 300, y: 200, w: 100, h: 40, rot: 0 }, points: [[0, 0], [0.5, 1], [1, 0]], ...OBJECT_DEFAULTS.pen, ...extra }),
  highlightText: (pageId, extra = {}) => ({ type: "highlight", mode: "text", pageId, quads: [[50, 720, 250, 720, 250, 700, 50, 700]], color: OBJECT_DEFAULTS.highlight.color, ...extra }),
  highlightStroke: (pageId, extra = {}) => ({ type: "highlight", mode: "stroke", pageId, frame: { x: 300, y: 650, w: 200, h: 20, rot: 0 }, points: [[0, 0.5], [1, 0.5]], ...OBJECT_DEFAULTS.highlight, ...extra }),
  redact: (pageId, extra = {}) => ({ type: "redact", pageId, rect: [60, 60, 180, 84], ...OBJECT_DEFAULTS.redact, ...extra }),
  blur: (pageId, extra = {}) => ({ type: "blur", pageId, rect: [300, 60, 420, 120], ...OBJECT_DEFAULTS.blur, ...extra })
};

/** Every id of a state (pages, objects, sources, assets). */
export function allIds(state) {
  return [...state.pages.map((page) => page.id), ...Object.keys(state.objects), ...Object.keys(state.sources), ...Object.keys(state.assets)];
}

/** Does plain data hold a typed array or an ArrayBuffer anywhere? (snapshots must never hold bytes) */
export function holdsBytes(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  seen.add(value);
  return Object.values(value).some((child) => holdsBytes(child, seen));
}

/** A Page record for pure tests that need no store. */
export function makePage(variant = PAGE_VARIANTS[0], rotation = 0, id = "page_1") {
  return { id, kind: "pdf", sourceId: "source_1", sourceIndex: 0, view: variant.view.slice(), baseRotation: variant.rotate, userUnit: variant.userUnit, rotation, objectIds: [] };
}
