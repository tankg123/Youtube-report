// The rectangle of a visible certificate signature ("Vị trí ký"): { pageId, rect } with rect = [x0, y0, x1, y1]
// in the user space of the page, exactly what engine/sign wants as appearance.rect (the unrotated page: the
// engine draws the stamp upright for the reader on pages that are turned).
//
// It is not an object of the document: the signing flow keeps it. The interaction reducer treats it as the
// pseudo object SIGNATURE_FIELD_ID; this module turns the reducer's effects ("create" of the certSign tool,
// "move", "resize") and its running gesture into rectangles, with the gesture maths of model/transform.js
// (a field moves and resizes like a mark). Pure: tests/pdfSigningField.test.mjs.
import { MM_PER_POINT, normalizeRect } from "../engine/geometry.js";
import { pageScreen } from "../model/shapes.js";
import { DEFAULT_SIZES, SIGNATURE_FIELD_MIN_SIZE, constrainToAxis, createFromEffect, resizeObject, screenDeltaFromPixels, screenDeltaToUser } from "../model/transform.js";
import { SIGNATURE_FIELD_ID } from "../tools/interaction.js";

export const FIELD_MIN_SIZE = SIGNATURE_FIELD_MIN_SIZE;
export const FIELD_DEFAULT_SIZE = DEFAULT_SIZES.signatureField;
/** Distance of a preset position from the edges of the page (points). */
export const PRESET_MARGIN = 36;
export const FIELD_PRESETS = Object.freeze(["bottomRight", "bottomLeft", "topRight"]);
export const FIELD_HANDLES = Object.freeze(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);

const pageOf = (pages, pageId) => (pages || []).find((page) => page.id === pageId) || null;
const round = (value) => Math.round(value * 1000) / 1000;

/** The field as the reader sees it: { left, top, width, height } in points from the top-left of the visible page. */
export function fieldScreenBox(field, page) {
  const [left, top, right, bottom] = pageScreen(page).rectToScreen(field.rect);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Brings a box onto the page: never smaller than the minimum (72 x 36 pt) unless the page itself is, never
 * larger than the page, never outside it.
 */
export function clampBoxToPage(box, page) {
  const screen = pageScreen(page);
  const width = Math.min(screen.width, Math.max(FIELD_MIN_SIZE[0], box.width));
  const height = Math.min(screen.height, Math.max(FIELD_MIN_SIZE[1], box.height));
  const left = Math.min(Math.max(0, box.left), screen.width - width);
  const top = Math.min(Math.max(0, box.top), screen.height - height);
  return { left, top, width, height };
}

/** A box on screen (points) -> the field on that page, clamped to the page. */
export function fieldFromBox(page, box) {
  const fitted = clampBoxToPage(box, page);
  const rect = pageScreen(page).rectToUser([fitted.left, fitted.top, fitted.left + fitted.width, fitted.top + fitted.height]);
  return { pageId: page.id, rect: rect.map(round) };
}

/** What the reducer's "create" effect of the certSign tool makes (a drag: that area; a click: the default size). */
export function fieldFromCreateEffect(effect, page, scale = 1) {
  const made = createFromEffect({ ...effect, tool: "certSign" }, page, scale);
  return made ? fieldFromBox(page, fieldScreenBox(made, page)) : null;
}

/**
 * The field after the reducer's "move" effect. It follows the pointer onto another page when the gesture
 * ended there (effect.drop).
 * @param {{ pageId, rect }} field
 * @param {object} effect   { from: { x, y }, dx, dy, axisLock?, drop?: { pageId, x, y } } in CSS pixels
 * @param {{ pages: object[], scaleOf: (pageId: string) => number }} context
 */
export function fieldAfterMove(field, effect, { pages, scaleOf }) {
  const page = pageOf(pages, field.pageId);
  if (!page) return field;
  const scale = scaleOf(page.id) || 1;
  const box = fieldScreenBox(field, page);
  const target = effect.drop && effect.drop.pageId !== field.pageId ? pageOf(pages, effect.drop.pageId) : null;
  if (target && effect.from) {
    // the field keeps its distance to the pointer
    const dropScale = scaleOf(target.id) || 1;
    return fieldFromBox(target, {
      ...box,
      left: effect.drop.x / dropScale - (effect.from.x / scale - box.left),
      top: effect.drop.y / dropScale - (effect.from.y / scale - box.top)
    });
  }
  let delta = screenDeltaFromPixels({ dx: effect.dx || 0, dy: effect.dy || 0 }, scale);
  if (effect.axisLock) delta = constrainToAxis(delta);
  return fieldFromBox(page, { ...box, left: box.left + delta[0], top: box.top + delta[1] });
}

/** The field after the reducer's "resize" effect ({ handle, dx, dy } in CSS pixels): free ratio, at least 72 x 36 pt. */
export function fieldAfterResize(field, effect, page, scale = 1) {
  if (!page) return field;
  const delta = screenDeltaToUser(page, screenDeltaFromPixels({ dx: effect.dx || 0, dy: effect.dy || 0 }, scale));
  const patch = resizeObject({ type: "redact", pageId: field.pageId, rect: field.rect }, effect.handle, delta, page, {
    lockRatio: false,
    minWidth: FIELD_MIN_SIZE[0],
    minHeight: FIELD_MIN_SIZE[1]
  });
  if (!patch?.rect) return field;
  // a handle dragged over the edge of the page stops at the edge (the opposite edge stays where it is)
  const screen = pageScreen(page);
  const [left, top, right, bottom] = screen.rectToScreen(patch.rect);
  const clipped = { left: Math.max(0, left), top: Math.max(0, top), right: Math.min(screen.width, right), bottom: Math.min(screen.height, bottom) };
  return fieldFromBox(page, { left: clipped.left, top: clipped.top, width: clipped.right - clipped.left, height: clipped.bottom - clipped.top });
}

/**
 * The field as it would be if the gesture that is running ended now (the live preview while the user drags).
 * @param {{ pageId, rect } | null} field   the field that exists (null before the first rectangle)
 * @param {object} interaction             the state of tools/interaction.js
 * @param {{ pages: object[], scaleOf: (pageId: string) => number }} context
 * @returns {{ pageId, rect } | null}
 */
export function liveField(field, interaction, { pages, scaleOf }) {
  const gesture = interaction?.gesture;
  if (!gesture?.start || !gesture.last) return field;
  const dx = gesture.last.x - gesture.start.x;
  const dy = gesture.last.y - gesture.start.y;
  if (interaction.mode === "drawing" && interaction.tool === "certSign") {
    const page = pageOf(pages, gesture.pageId);
    if (!page || Math.hypot(dx, dy) < (gesture.threshold ?? 4)) return field;
    return fieldFromCreateEffect({ from: gesture.start, to: gesture.last }, page, scaleOf(page.id) || 1) || field;
  }
  if (!field) return null;
  if (interaction.mode === "moving" && interaction.selection?.includes(SIGNATURE_FIELD_ID)) {
    const drop = gesture.over && gesture.over.pageId && gesture.over.pageId !== gesture.pageId ? gesture.over : null;
    return fieldAfterMove(field, { from: gesture.start, dx, dy, axisLock: gesture.shift, drop }, { pages, scaleOf });
  }
  if (interaction.mode === "resizing" && gesture.id === SIGNATURE_FIELD_ID) {
    const page = pageOf(pages, field.pageId);
    return fieldAfterResize(field, { handle: gesture.handle, dx, dy }, page, page ? scaleOf(page.id) || 1 : 1);
  }
  return field;
}

/**
 * A field at a preset place of a page, as the reader sees the page.
 * @param {object} page
 * @param {"bottomRight" | "bottomLeft" | "topRight"} preset
 * @param {[number, number]} [size]   points; default 180 x 60
 */
export function presetField(page, preset, size = FIELD_DEFAULT_SIZE) {
  const screen = pageScreen(page);
  const width = Math.min(size[0], Math.max(FIELD_MIN_SIZE[0], screen.width - 2 * PRESET_MARGIN));
  const height = Math.min(size[1], Math.max(FIELD_MIN_SIZE[1], screen.height - 2 * PRESET_MARGIN));
  const left = preset === "bottomLeft" ? PRESET_MARGIN : screen.width - PRESET_MARGIN - width;
  const top = preset === "topRight" ? PRESET_MARGIN : screen.height - PRESET_MARGIN - height;
  return fieldFromBox(page, { left, top, width, height });
}

/** The numbers of the position form: millimetres from the top-left corner of the visible page, one decimal. */
export function fieldMillimetres(field, page) {
  const box = fieldScreenBox(field, page);
  const mm = (points) => Math.round(points * MM_PER_POINT * 10) / 10;
  return { left: mm(box.left), top: mm(box.top), width: mm(box.width), height: mm(box.height) };
}

/** The field with one number of the position form changed (millimetres); the other three stay. */
export function fieldWithMillimetres(field, page, patch) {
  const box = fieldScreenBox(field, page);
  const next = { ...box };
  for (const key of ["left", "top", "width", "height"]) {
    const value = Number(patch?.[key]);
    if (Number.isFinite(value)) next[key] = value / MM_PER_POINT;
  }
  return fieldFromBox(page, next);
}

/**
 * What goes to signPdf: the index of the page in the document that is signed and the rectangle in its user
 * space. null when the page is no longer in the document.
 */
export function fieldForEngine(field, pages) {
  if (!field) return null;
  const pageIndex = (pages || []).findIndex((page) => page.id === field.pageId);
  if (pageIndex < 0) return null;
  return { pageIndex, rect: normalizeRect(field.rect) };
}
