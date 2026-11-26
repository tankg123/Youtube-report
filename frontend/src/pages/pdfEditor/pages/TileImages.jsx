import { useCallback } from "react";
import { frameOnScreen } from "../engine/geometry.js";
import { pageGeometry } from "../model/schema.js";
import { useEditor } from "../ui/editorHooks.js";
import { visiblePageSize } from "../viewer/pageList.js";

// The pictures the user put on a page, shown over its thumbnail (the thumbnail itself is the page of the
// source file only). Without this a page made from a picture ("Image as page") would look blank in the
// Pages panel and in the organiser. Other objects (text, shapes, marks) are not drawn on thumbnails.
//
// Each picture is an <img> placed by the frame of its object, in percent of the page as it is seen. Its
// address is a Blob URL of the stored bytes, shared by every tile that shows the same picture and revoked
// when the last one goes away; the browser loads it only when the tile comes near the screen.

const urls = new WeakMap(); // store -> Map(assetId -> { url, users })

function acquire(store, assetId, mime) {
  let table = urls.get(store);
  if (!table) urls.set(store, (table = new Map()));
  let entry = table.get(assetId);
  if (!entry) {
    const bytes = store.getAssetBytes(assetId);
    if (!bytes) return null;
    entry = { url: URL.createObjectURL(new Blob([bytes], { type: mime })), users: 0 };
    table.set(assetId, entry);
  }
  entry.users += 1;
  return entry.url;
}

function release(store, assetId) {
  const table = urls.get(store);
  const entry = table?.get(assetId);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  table.delete(assetId);
  URL.revokeObjectURL(entry.url);
}

function TileImage({ assetId, mime, style }) {
  const { store } = useEditor();
  // a ref callback with a cleanup: the address exists exactly while the element does
  const attach = useCallback(
    (element) => {
      if (!element) return undefined;
      const url = acquire(store, assetId, mime);
      if (url) element.src = url;
      return () => {
        element.removeAttribute("src");
        if (url) release(store, assetId);
      };
    },
    [store, assetId, mime]
  );
  return <img ref={attach} className="pdfx-pagetile-image" style={style} alt="" loading="lazy" decoding="async" draggable="false" />;
}

/**
 * @param {object} props
 * @param {object} props.page     the Page of the model
 * @param {Array<{ id: string, assetId: string, mime: string, frame: object, opacity: number }>} props.images
 *        the image objects of the page, bottom to top
 */
export default function TileImages({ page, images }) {
  const size = visiblePageSize(page);
  const geometry = pageGeometry(page);
  return images.map((image) => {
    const box = frameOnScreen(geometry, image.frame, 1, page.rotation);
    const style = {
      left: `${(box.cx / size.width) * 100}%`,
      top: `${(box.cy / size.height) * 100}%`,
      width: `${(box.w / size.width) * 100}%`,
      height: `${(box.h / size.height) * 100}%`,
      transform: `translate(-50%, -50%) rotate(${box.rotation}deg)`,
      opacity: image.opacity
    };
    return <TileImage key={image.id} assetId={image.assetId} mime={image.mime} style={style} />;
  });
}
