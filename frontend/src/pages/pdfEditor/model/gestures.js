// From the effects of the interaction reducer (tools/interaction.js) to commands of the document store:
// the one place that knows how a finished gesture becomes exactly one undo step. No DOM, no user text.
//
//   const { state, effects } = step(ui, event, ctx);
//   for (const effect of effects) {
//     const done = runEffect(store, effect, { scaleOf, style, asset, ... });
//     if (done.created) dispatch({ type: "created", ids: done.ids });      // resolves NEW_ID in the selection
//   }
//
// runEffect handles the effects that change the document:
//   move          one step, also when Alt duplicates first and when the gesture ends over another page
//   resize, rotate, delete, commitErase
//   create        every tool except "text" (a new text box is a draft of the text editor until "commitEdit":
//                 add it then with createFromEffect / createTextBox) and "certSign" (the rectangle belongs to
//                 the signing flow)
// Everything else (pan, pickers, hints, text editing, context menu, marquee, erase previews) and every effect
// that names SIGNATURE_FIELD_ID is left to the caller: the result says { handled: false }.
import { isMovable } from "./selectors.js";
import { createFromEffect, patchForResizeEffect, patchForRotateEffect, patchesForMoveEffect, placeForDrop } from "./transform.js";

const UNHANDLED = Object.freeze({ handled: false, created: false, ids: Object.freeze([]) });
const handled = (ids = [], created = false) => ({ handled: true, created, ids });
const isPseudoId = (id) => typeof id === "string" && id.startsWith("$");

/**
 * @param {object} store    the editor store
 * @param {object} effect   an effect of tools/interaction.js step()
 * @param {object} [context]
 * @param {(pageId: string) => number} [context.scaleOf]  zoom of a page element in CSS pixels per point (default 1)
 * @param {object} [context.style]     the remembered defaults of the tool that creates (model/transform.js styleFor)
 * @param {object} [context.asset]     the Asset record for image / signature (default: looked up from
 *                                     effect.payload when that is an asset id or { assetId })
 * @param {number[]} [context.rect]    user-space box of the text line a Redact click hit (effect.lineId)
 * @param {number[][]} [context.boxes] line boxes of the native text selection (effect.textSelection)
 * @param {object} [context.resize]    options for resizeObject (minWidth, minHeight, lockRatio, snap)
 * @returns {{ handled: boolean, created: boolean, ids: string[] }}
 *          ids: the objects the effect made or changed; created: they are new (send a "created" event)
 */
export function runEffect(store, effect, context = {}) {
  if (!effect || typeof effect !== "object") return UNHANDLED;
  const scaleOf = typeof context.scaleOf === "function" ? context.scaleOf : () => 1;
  const state = store.getState();
  switch (effect.type) {
    case "move": {
      if (effect.ids.some(isPseudoId)) return UNHANDLED;
      const ids = effect.ids.filter((id) => state.objects[id] && isMovable(state.objects[id]));
      // nothing to move: an Alt-drag still reports "created" (with no ids) so that the placeholder leaves the selection
      if (!ids.length) return handled([], Boolean(effect.duplicate));
      const scale = scaleOf(effect.pageId);
      let moved = ids;
      store.transaction(() => {
        if (effect.duplicate) moved = store.duplicateObjects(ids, [0, 0]);
        if (!effect.drop) {
          store.updateObjects(patchesForMoveEffect(store.getState(), { ...effect, ids: moved }, scale));
          return;
        }
        // The objects of the page the gesture started on follow the pointer to the page it was released
        // over; objects of other pages (a selection can span pages) simply move along.
        const current = store.getState();
        const leaving = moved.filter((id) => current.objects[id].pageId === effect.pageId);
        const staying = moved.filter((id) => current.objects[id].pageId !== effect.pageId);
        store.moveObjectsToPage(leaving, effect.drop.pageId, placeForDrop(effect, scale, scaleOf(effect.drop.pageId)));
        store.updateObjects(patchesForMoveEffect(store.getState(), { ...effect, ids: staying, axisLock: false }, scale));
      });
      return handled(moved, Boolean(effect.duplicate));
    }
    case "resize": {
      if (isPseudoId(effect.id)) return UNHANDLED;
      const object = state.objects[effect.id];
      const update = patchForResizeEffect(state, effect, scaleOf(effect.pageId ?? object?.pageId), context.resize);
      return handled(update ? store.updateObjects([update]) : []);
    }
    case "rotate": {
      if (isPseudoId(effect.id)) return UNHANDLED;
      const object = state.objects[effect.id];
      const update = patchForRotateEffect(state, effect, scaleOf(effect.pageId ?? object?.pageId));
      return handled(update ? store.updateObjects([update]) : []);
    }
    case "delete":
    case "commitErase": {
      const ids = effect.ids.filter((id) => !isPseudoId(id));
      if (!ids.length && effect.ids.length) return UNHANDLED;
      return handled(store.deleteObjects(ids));
    }
    case "create": {
      if (effect.tool === "text" || effect.tool === "certSign") return UNHANDLED;
      const page = state.pages.find((candidate) => candidate.id === effect.pageId);
      if (!page) return handled([], true); // the page is gone: nothing was made, and the caller must hear it
      let { asset } = context;
      if (!asset && (effect.tool === "image" || effect.tool === "signature")) {
        const assetId = typeof effect.payload === "string" ? effect.payload : effect.payload?.assetId;
        asset = state.assets[assetId];
      }
      const made = createFromEffect(effect, page, scaleOf(effect.pageId), { ...context, asset });
      const objects = (Array.isArray(made) ? made : [made]).filter(Boolean);
      return handled(objects.length ? store.addObjects(objects) : [], true);
    }
    default:
      return UNHANDLED;
  }
}
