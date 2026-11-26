// What a running gesture WOULD do, computed from the interaction state alone: the document changes once, on
// pointer-up (model/gestures.js runEffect), and until then the overlay draws this preview. It is built with
// the very functions the commit uses (model/transform.js), so what the user sees while dragging is what the
// document gets. Pure: no DOM, no store calls (tests/pdfOverlayPreview.test.mjs).
//
//   const preview = gesturePreview(state, interaction, { scale, styleOf, textFrame, textQuads });
//
//   preview.patched   Map(id -> object)        objects drawn with another geometry (move, resize, rotate)
//   preview.hidden    Set(id)                  objects not drawn on their page (they follow the pointer to another one)
//   preview.extras    Map(pageId -> object[])  objects drawn in addition: the copies of an Alt-drag, objects
//                                              arriving from another page, the object a creation tool is drawing,
//                                              the ghost of a picture that is being placed. Their ids start with "$".
//   preview.erased    Set(id)                  objects the eraser drag has crossed
//   preview.marquee   { pageId, rect: { x, y, width, height } } | null     the selection rectangle (pixels)
//   preview.textMark  { pageId, tool, quads } | null     the stretch of document text a Redact / Highlighter drag marks
//   preview.textArea  { pageId, frame } | null           the box a Text tool drag will wrap its text in
import { clampObjectToPage } from "../model/selectors.js";
import { createFromEffect, patchForResizeEffect, patchForRotateEffect, patchesForMoveEffect, placeForDrop, placeOnPage } from "../model/transform.js";

const EMPTY = Object.freeze({ patched: new Map(), hidden: new Set(), extras: new Map(), erased: new Set(), marquee: null, textMark: null, textArea: null });
export const NO_PREVIEW = EMPTY;
export const PREVIEW_ID = "$preview";
export const GHOST_ID = "$ghost";

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const boxOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
const pageOf = (state, pageId) => state.pages.find((page) => page.id === pageId) || null;

function push(extras, pageId, object) {
  if (!object) return;
  const list = extras.get(pageId) || [];
  list.push(object);
  extras.set(pageId, list);
}

/**
 * @param {object} state         DocumentState
 * @param {object} interaction   state of tools/interaction.js
 * @param {object} [context]
 * @param {number} [context.scale]          CSS pixels per point of the page elements
 * @param {(tool: string) => object} [context.styleOf]        the remembered style of a creation tool
 * @param {(object: object) => object} [context.textFrame]    the frame a text object takes for its text (the
 *        store asks the text measurer on commit; the preview of a resized text box asks here)
 * @param {(pageId: string, from: object, to: object) => number[][] | null} [context.textQuads]
 *        the quads a drag between two pixel points marks when it began on document text, else null
 */
export function gesturePreview(state, interaction, { scale = 1, styleOf = () => ({}), textFrame = (object) => object.frame, textQuads = () => null } = {}) {
  const gesture = interaction?.gesture;
  if (!gesture || !state) return EMPTY;
  const preview = { patched: new Map(), hidden: new Set(), extras: new Map(), erased: new Set(), marquee: null, textMark: null, textArea: null };
  const keep = (object) => {
    const page = pageOf(state, object.pageId);
    return page ? clampObjectToPage(object, page) : object;
  };

  switch (interaction.mode) {
    case "moving": {
      const ids = interaction.selection.filter((id) => state.objects[id]);
      const over = gesture.over;
      const drop = over && over.pageId && over.pageId !== gesture.pageId && pageOf(state, over.pageId) ? over : null;
      const effect = { ids, pageId: gesture.pageId, from: gesture.start, to: gesture.last, dx: gesture.last.x - gesture.start.x, dy: gesture.last.y - gesture.start.y, axisLock: Boolean(gesture.shift), drop };
      const leaving = drop ? ids.filter((id) => state.objects[id].pageId === gesture.pageId) : [];
      const staying = drop ? ids.filter((id) => state.objects[id].pageId !== gesture.pageId) : ids;
      for (const { id, patch } of patchesForMoveEffect(state, { ...effect, ids: staying, axisLock: drop ? false : effect.axisLock }, scale)) {
        const moved = keep({ ...state.objects[id], ...patch });
        // an Alt-drag moves copies: the originals stay where they are
        if (gesture.duplicate) push(preview.extras, moved.pageId, { ...moved, id: `$copy:${id}` });
        else preview.patched.set(id, moved);
      }
      if (drop && leaving.length) {
        const target = pageOf(state, drop.pageId);
        const fromPage = pageOf(state, gesture.pageId);
        const placed = placeOnPage(leaving.map((id) => ({ object: state.objects[id], fromPage })), target, placeForDrop(effect, scale, scale));
        for (const object of placed) {
          const arrived = clampObjectToPage(object, target);
          push(preview.extras, target.id, { ...arrived, id: `$drop:${object.id}`, replaces: undefined });
          if (!gesture.duplicate) preview.hidden.add(object.id);
        }
      }
      return preview;
    }
    case "resizing": {
      const update = patchForResizeEffect(state, { id: gesture.id, handle: gesture.handle, dx: gesture.last.x - gesture.start.x, dy: gesture.last.y - gesture.start.y, invertRatioLock: Boolean(gesture.shift) }, scale);
      if (update) {
        let resized = { ...state.objects[update.id], ...update.patch };
        if (resized.type === "text") resized = { ...resized, frame: textFrame(resized) };
        preview.patched.set(update.id, keep(resized));
      }
      return preview;
    }
    case "rotating": {
      const update = patchForRotateEffect(state, { id: gesture.id, from: gesture.start, to: gesture.last, snap: Boolean(gesture.shift) }, scale);
      if (update) preview.patched.set(update.id, { ...state.objects[update.id], ...update.patch });
      return preview;
    }
    case "marquee":
      preview.marquee = { pageId: gesture.pageId, rect: boxOf(gesture.start, gesture.last) };
      return preview;
    case "erasing":
      for (const id of gesture.erased || []) preview.erased.add(id);
      return preview;
    case "drawing": {
      const page = pageOf(state, gesture.pageId);
      if (!page) return preview;
      const tool = interaction.tool;
      const dragged = distance(gesture.start, gesture.last) >= (gesture.threshold || 4);
      if (gesture.points) {
        const quads = textQuads(page.id, gesture.start, gesture.last);
        if (quads) {
          preview.textMark = { pageId: page.id, tool, quads };
          return preview;
        }
        const stroke = createFromEffect({ tool, points: gesture.points }, page, scale, { style: styleOf(tool) });
        if (stroke) push(preview.extras, page.id, { ...stroke, id: PREVIEW_ID });
        return preview;
      }
      if (!dragged) return preview;
      const effect = { tool, from: gesture.start, to: gesture.last, constrain: Boolean(gesture.shift) };
      if (tool === "text") {
        const box = createFromEffect(effect, page, scale, { style: styleOf(tool) });
        if (box) preview.textArea = { pageId: page.id, frame: box.frame };
        return preview;
      }
      if (tool === "redact") {
        const quads = textQuads(page.id, gesture.start, gesture.last);
        if (quads) {
          preview.textMark = { pageId: page.id, tool, quads };
          return preview;
        }
      }
      // the certificate rectangle is drawn by the signing feature
      if (tool === "certSign") return preview;
      const made = createFromEffect(effect, page, scale, { style: styleOf(tool) });
      const object = Array.isArray(made) ? made[0] : made;
      if (object && object.type) push(preview.extras, page.id, { ...object, id: PREVIEW_ID });
      return preview;
    }
    case "placing": {
      const page = gesture.pageId ? pageOf(state, gesture.pageId) : null;
      const assetId = typeof gesture.payload === "string" ? gesture.payload : gesture.payload?.assetId;
      const asset = state.assets[assetId];
      if (!page || !asset || !gesture.at) return preview;
      const tool = interaction.tool;
      const pressed = Boolean(gesture.start);
      const dragged = pressed && distance(gesture.start, gesture.at) >= (gesture.threshold || 4);
      const effect = dragged ? { tool, from: gesture.start, to: gesture.at, keepRatio: !gesture.shift } : { tool, at: gesture.at };
      const ghost = createFromEffect(effect, page, scale, { style: styleOf(tool), asset });
      if (ghost) push(preview.extras, page.id, { ...ghost, id: GHOST_ID });
      return preview;
    }
    default:
      return EMPTY;
  }
}

/** The pages a preview draws something on (besides the pages of patched and hidden objects). */
export function previewTouches(preview, state, pageId) {
  if (!preview || preview === EMPTY) return false;
  if (preview.extras.has(pageId)) return true;
  if (preview.marquee?.pageId === pageId || preview.textMark?.pageId === pageId || preview.textArea?.pageId === pageId) return true;
  for (const id of preview.patched.keys()) if (state.objects[id]?.pageId === pageId) return true;
  for (const id of preview.hidden) if (state.objects[id]?.pageId === pageId) return true;
  for (const id of preview.erased) if (state.objects[id]?.pageId === pageId) return true;
  return false;
}
