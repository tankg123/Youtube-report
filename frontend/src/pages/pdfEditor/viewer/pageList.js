// The controlled page list of the viewer: pure helpers on Page objects of ../model/schema.js
// (tests/pdfViewerPages.test.mjs). The document model owns the list; the viewer only reads it.

import { normalizeRightAngle, viewportTransform } from "../engine/geometry.js";
import { createId, pageGeometry } from "../model/schema.js";
import { computeCanvasSize } from "./canvasSizing.js";

/** Display facts of a device that never change the layout: used where no browser is around (tests). */
export const NEUTRAL_DISPLAY = Object.freeze({ pixelRatio: 1, limits: Object.freeze({}), screenArea: 0, singlePrecision: true });

/** Rotation the reader sees: the page's own /Rotate plus what the user added (0 / 90 / 180 / 270). */
export const totalRotation = (page) => normalizeRightAngle(normalizeRightAngle(page.baseRotation) + normalizeRightAngle(page.rotation));

/**
 * What a page shows, apart from the rotation the user added. Two list entries with the same content key
 * (a page and its duplicate) share text, lines and search results; an entry whose key changes is redrawn.
 */
export function contentKey(page) {
  const view = Array.isArray(page.view) ? page.view.join(",") : "";
  if (page.kind === "blank") return `blank|${view}`;
  return `pdf|${page.sourceId}|${page.sourceIndex}|${view}|${normalizeRightAngle(page.baseRotation)}|${page.userUnit || 1}`;
}

/** Size of the page as the reader sees it, in points: { width, height, rotation }. */
export function visiblePageSize(page) {
  const { width, height, rotation } = viewportTransform(pageGeometry(page), 1, page.rotation);
  return { width, height, rotation };
}

/**
 * Everything the layout of one page slot needs at `scale` (CSS pixels per point) on a given display:
 * the exact viewport and the canvas arithmetic of pdf.js (./canvasSizing.js).
 */
export function slotMetrics(page, scale, display = NEUTRAL_DISPLAY) {
  const viewport = viewportTransform(pageGeometry(page), scale, page.rotation);
  const canvas = computeCanvasSize({
    width: viewport.width,
    height: viewport.height,
    pixelRatio: display.pixelRatio || 1,
    limits: display.limits || {},
    screenArea: display.screenArea || 0,
    singlePrecision: display.singlePrecision !== false
  });
  return { viewport, canvas };
}

/**
 * The inline style of a page slot. Width and height are the very expressions pdf.js writes on its layers
 * (setLayerDimensions), so the slot, the canvas, the text layer and the link layer always agree, and a zoom
 * step only has to change `--scale-factor` on the scroll container: no element is resized by script.
 * The slot also carries the rounding step of its canvas, so its box never shifts when the page is drawn.
 */
export function slotStyle(page, scale, display = NEUTRAL_DISPLAY) {
  const { viewport, canvas } = slotMetrics(page, scale, display);
  const [x0, y0, x1, y1] = page.view;
  const across = `round(down, var(--total-scale-factor) * ${x1 - x0}px, var(--scale-round-x))`;
  const along = `round(down, var(--total-scale-factor) * ${y1 - y0}px, var(--scale-round-y))`;
  const style = viewport.rotation % 180 === 0 ? { width: across, height: along } : { width: along, height: across };
  style["--scale-round-x"] = `${canvas.roundX}px`;
  style["--scale-round-y"] = `${canvas.roundY}px`;
  if (page.userUnit && page.userUnit !== 1) style["--user-unit"] = String(page.userUnit);
  return style;
}

/**
 * What changed between two versions of the list, by page id.
 * @returns {{ added: string[], removed: string[], changed: string[], rotated: string[], moved: boolean }}
 *          changed = another content under the same id; rotated = only the visible rotation differs;
 *          moved = the pages that stayed are in another order (their canvases are kept: React moves the nodes)
 */
export function diffPages(previous, next) {
  const before = new Map(previous.map((page) => [page.id, page]));
  const added = [];
  const changed = [];
  const rotated = [];
  const keptOrder = [];
  for (const page of next) {
    const old = before.get(page.id);
    if (!old) {
      added.push(page.id);
      continue;
    }
    keptOrder.push(page.id);
    if (old === page) continue;
    if (contentKey(old) !== contentKey(page)) changed.push(page.id);
    else if (totalRotation(old) !== totalRotation(page)) rotated.push(page.id);
  }
  const after = new Set(next.map((page) => page.id));
  const removed = [];
  const oldOrder = [];
  for (const page of previous) {
    if (after.has(page.id)) oldOrder.push(page.id);
    else removed.push(page.id);
  }
  const moved = oldOrder.some((id, index) => id !== keptOrder[index]);
  return { added, removed, changed, rotated, moved };
}

/** Structural problems of a list given to setPages() (empty = fine). */
export function checkPages(pages) {
  if (!Array.isArray(pages)) return ["not an array"];
  const problems = [];
  const ids = new Set();
  pages.forEach((page, index) => {
    const where = `pages[${index}]`;
    if (!page || typeof page.id !== "string" || !page.id) {
      problems.push(`${where}: id`);
      return;
    }
    if (ids.has(page.id)) problems.push(`${where}: duplicate id ${page.id}`);
    ids.add(page.id);
    if (page.kind !== "pdf" && page.kind !== "blank") problems.push(`${where}: kind`);
    if (!Array.isArray(page.view) || page.view.length !== 4 || !page.view.every(Number.isFinite) || !(page.view[2] > page.view[0]) || !(page.view[3] > page.view[1])) problems.push(`${where}: view`);
    if (page.kind === "pdf" && (typeof page.sourceId !== "string" || !Number.isInteger(page.sourceIndex) || page.sourceIndex < 0)) problems.push(`${where}: source`);
  });
  return problems;
}

/**
 * The pages of a freshly opened source as list entries (Page of ../model/schema.js), in file order.
 * @param {string} sourceId
 * @param {{ pages: Array<{ view: number[], rotate: number, userUnit: number }> }} facts  result of openSource()
 * @param {{ makeId?: () => string }} [options]
 */
export function pagesFromFacts(sourceId, facts, { makeId = () => createId("p") } = {}) {
  return facts.pages.map((info, sourceIndex) => ({
    id: makeId(),
    kind: "pdf",
    sourceId,
    sourceIndex,
    view: info.view.slice(),
    baseRotation: normalizeRightAngle(info.rotate),
    userUnit: info.userUnit || 1,
    rotation: 0,
    objectIds: []
  }));
}
