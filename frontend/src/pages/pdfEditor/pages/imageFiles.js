// Pictures chosen for "Image as page", turned into what the document stores: PNG or JPEG bytes with their
// size in pixels (model/store.js addAsset). Browser only (canvas, createImageBitmap).
//
// A PNG, and a JPEG without an EXIF rotation, are kept byte for byte. Everything else (WebP, GIF, BMP, SVG,
// a JPEG that a camera marked as turned) is drawn once and stored as that drawing, so that the page in the
// downloaded file looks like the picture did in the browser: a PDF does not read EXIF.
import { jpegOrientation, storedImageKind } from "./pageLogic.js";

/** A picture is drawn no larger than this (pixels per side, and in total): a phone photo fits, a poster scan is scaled. */
const MAX_SIDE = 8192;
const MAX_AREA = 40_000_000;
const JPEG_QUALITY = 0.92;
/** What a vector picture without a size of its own is drawn at. */
const FALLBACK_SIZE = Object.freeze([1200, 900]);

async function decode(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
    } catch {
      // some vector pictures only decode as an <img>
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const width = image.naturalWidth || FALLBACK_SIZE[0];
    const height = image.naturalHeight || FALLBACK_SIZE[1];
    return { source: image, width, height, release: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the picture could not be encoded"))), type, quality);
  });

/**
 * Reads one picture file.
 * @param {File | Blob} file
 * @returns {Promise<{ mime: "image/png" | "image/jpeg", width: number, height: number, bytes: Uint8Array }>}
 *          rejects when the browser cannot decode the file
 */
export async function readImageFile(file) {
  const original = new Uint8Array(await file.arrayBuffer());
  const kind = storedImageKind(original);
  const keep = kind === "png" || (kind === "jpeg" && jpegOrientation(original) === 1);
  // the type comes from the bytes, not from the name: a renamed file still decodes
  const blob = kind ? new Blob([original], { type: kind === "png" ? "image/png" : "image/jpeg" }) : file;
  const decoded = await decode(blob);
  try {
    if (!(decoded.width > 0) || !(decoded.height > 0)) throw new Error("the picture has no size");
    if (keep) return { mime: kind === "png" ? "image/png" : "image/jpeg", width: decoded.width, height: decoded.height, bytes: original };
    const shrink = Math.min(1, MAX_SIDE / Math.max(decoded.width, decoded.height), Math.sqrt(MAX_AREA / (decoded.width * decoded.height)));
    const width = Math.max(1, Math.round(decoded.width * shrink));
    const height = Math.max(1, Math.round(decoded.height * shrink));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const jpeg = kind === "jpeg";
    if (jpeg) {
      // JPEG has no transparency: nothing shines through, but a white ground is the honest default
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(decoded.source, 0, 0, width, height);
    const encoded = await toBlob(canvas, jpeg ? "image/jpeg" : "image/png", jpeg ? JPEG_QUALITY : undefined);
    canvas.width = 0;
    canvas.height = 0;
    return { mime: jpeg ? "image/jpeg" : "image/png", width, height, bytes: new Uint8Array(await encoded.arrayBuffer()) };
  } finally {
    decoded.release();
  }
}
