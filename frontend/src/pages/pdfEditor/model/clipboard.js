// The editor's own clipboard for objects: copy, cut and paste within a page, between pages and between
// documents opened one after the other in the same tab. It lives in memory only (nothing reaches the system
// clipboard) and keeps the bytes of copied pictures itself, so a paste still works after the document they
// came from was closed. No DOM, no user text.
//
//   import { clipboard } from "../model/clipboard.js";         // the clipboard of the tab
//   clipboard.copy(store, selection);
//   const ids = clipboard.paste(store, { pageId });            // one undo step; select `ids`
//
// Where a paste lands
//   on the page the objects were copied from   12 pt right and down of the original as seen on screen, and
//                                              12 pt further with every repeated paste
//   on another page                            the same place as seen on screen (distance from the top-left
//                                              corner of the visible page); a second paste on that page is
//                                              again 12 pt further
//   { at: [x, y] } ("Paste here")              the middle of the pasted group at that user-space point
// In every case the group is moved onto the page when it would stick out and fits (model/transform.js
// placeOnPage). Pasted objects get new ids, go on top of the page (marks: on top of the marks) and are
// ordinary objects: a text box that replaced a line of the document is pasted as a plain text box, and a
// pasted blur mark gets a new seed (model/store.js prepareObject says why).
import { PdfEditorError } from "../engine/errors.js";
import { DUPLICATE_OFFSET, placeOnPage } from "./transform.js";

export function createClipboard() {
  let content = null; // { items: [{ object, fromPage }], assets: Map(assetId -> { meta, bytes }), pastes: Map(pageId -> count) }

  function copy(store, ids) {
    const state = store.getState();
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    const items = [];
    const assets = new Map();
    for (const page of state.pages) {
      for (const id of page.objectIds) {
        if (!wanted.has(id)) continue;
        const object = state.objects[id];
        if (object.type === "image" && !assets.has(object.assetId)) {
          const bytes = store.getAssetBytes(object.assetId);
          const meta = state.assets[object.assetId];
          if (!bytes || !meta) continue; // a picture without bytes cannot be pasted
          assets.set(object.assetId, { meta: { mime: meta.mime, width: meta.width, height: meta.height }, bytes });
        }
        // objects and pages of the state are immutable: holding them is a snapshot
        items.push({ object, fromPage: page });
      }
    }
    if (!items.length) return [];
    content = { items, assets, pastes: new Map() };
    return items.map((item) => item.object.id);
  }

  function cut(store, ids) {
    const copied = copy(store, ids);
    return copied.length ? store.deleteObjects(copied) : [];
  }

  /**
   * @param {object} store
   * @param {{ pageId: string, at?: [number, number] }} target   the page to paste on; `at` in its user space
   * @returns {string[]} ids of the new objects (empty when the clipboard is empty)
   */
  function paste(store, { pageId, at } = {}) {
    if (!content) return [];
    const page = store.getState().pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new PdfEditorError("MODEL_UNKNOWN_PAGE", { pageId });
    const { items, assets, pastes } = content;
    const before = pastes.get(page.id) || 0;
    let place;
    if (at) {
      place = { at };
    } else {
      // every object that sits on this very page starts one step away from itself
      const steps = before + (items.every((item) => item.fromPage.id === page.id) ? 1 : 0);
      place = steps ? { offset: [DUPLICATE_OFFSET[0] * steps, DUPLICATE_OFFSET[1] * steps] } : "keep";
    }
    const ids = store.transaction(() => {
      const assetIds = new Map();
      for (const [oldId, asset] of assets) assetIds.set(oldId, store.addAsset(asset.meta, asset.bytes));
      const placed = placeOnPage(items, page, place).map((object) => {
        const copyOfObject = { ...object };
        delete copyOfObject.id;
        delete copyOfObject.replaces;
        delete copyOfObject.seed; // a pasted blur mark covers other content: the store gives it a seed of its own
        if (copyOfObject.type === "image") copyOfObject.assetId = assetIds.get(object.assetId);
        return copyOfObject;
      });
      return store.addObjects(placed);
    });
    if (!at) pastes.set(page.id, before + 1);
    return ids;
  }

  return {
    copy,
    cut,
    paste,
    isEmpty: () => !content,
    /** Number of objects on the clipboard. */
    count: () => (content ? content.items.length : 0),
    /** The object types on the clipboard, e.g. to label a "Paste" command. */
    types: () => (content ? [...new Set(content.items.map((item) => item.object.type))] : []),
    clear() {
      content = null;
    }
  };
}

/** The clipboard of this tab: it outlives a document (store.reset()), so objects can go from one file to the next. */
export const clipboard = createClipboard();
