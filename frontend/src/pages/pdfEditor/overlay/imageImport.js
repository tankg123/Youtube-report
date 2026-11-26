// From a picture file to the bytes the document keeps (browser only: it decodes with the browser).
// The rules are in imageRules.js; this module applies them:
//   PNG and JPEG that are small enough are stored as they are, once the browser has shown it can decode them
//   everything else the browser decodes is drawn on a canvas and stored as PNG (a JPEG that must be scaled
//   down stays a JPEG); the long edge of what is stored never exceeds MAX_IMAGE_EDGE
//   what the browser cannot decode is refused: prepareImage rejects with IMAGE_UNSUPPORTED
// Nothing leaves the page: the picture is read from the File, and an SVG is drawn through an <img>, where a
// browser loads nothing an SVG refers to.
import { JPEG_QUALITY, MAX_IMAGE_EDGE, fitWithin, imageFacts, importPlan, sniffImageType } from "./imageRules.js";

/** The one reason prepareImage rejects with: the picture cannot be used. */
export const IMAGE_UNSUPPORTED = "IMAGE_UNSUPPORTED";

const unsupported = (cause) => Object.assign(new Error(IMAGE_UNSUPPORTED), { code: IMAGE_UNSUPPORTED, cause });

/** An SVG without a size of its own is drawn this large on its long edge (pixels). */
const SVG_LONG_EDGE = 1600;

const MIME_OF = Object.freeze({ png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml" });

async function decodeBitmap(blob) {
  const bitmap = await createImageBitmap(blob);
  return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
}

function decodeElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const element = new Image();
    element.decoding = "async";
    element.onload = () => resolve({ source: element, width: element.naturalWidth, height: element.naturalHeight, release: () => URL.revokeObjectURL(url) });
    element.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("the picture could not be decoded"));
    };
    element.src = url;
  });
}

function canvasBytes(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("the canvas could not be encoded"));
        else blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      },
      mime,
      quality
    );
  });
}

/**
 * @param {Blob} blob   a picture file (from a file picker, a drop or the clipboard)
 * @returns {Promise<{ bytes: Uint8Array, mime: "image/png" | "image/jpeg", width: number, height: number, scaled: boolean }>}
 *          width / height = the picture as shown (EXIF orientation applied); scaled: it was brought down to
 *          MAX_IMAGE_EDGE. Rejects with an Error whose code is IMAGE_UNSUPPORTED.
 */
export async function prepareImage(blob) {
  let original;
  try {
    original = new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    throw unsupported(error);
  }
  const type = sniffImageType(original);
  if (!type) throw unsupported();
  // the browser decodes by content type: give it the one the bytes really have
  const typed = new Blob([original], { type: MIME_OF[type] || blob.type || "application/octet-stream" });
  let decoded;
  try {
    decoded = type === "svg" ? await decodeElement(typed) : await decodeBitmap(typed).catch(() => decodeElement(typed));
  } catch (error) {
    throw unsupported(error);
  }
  try {
    let { width, height } = decoded;
    if (type === "svg") {
      // an SVG has no pixels: draw it large enough to stay sharp on a page
      if (!(width > 0) || !(height > 0)) {
        width = 300;
        height = 150;
      }
      const grow = Math.max(1, SVG_LONG_EDGE / Math.max(width, height));
      width = Math.round(width * grow);
      height = Math.round(height * grow);
    }
    if (!(width > 0) || !(height > 0)) throw unsupported();
    const facts = imageFacts(original);
    const plan = importPlan({ type: facts ? type : "other", width: facts ? facts.width : width, height: facts ? facts.height : height });
    if (plan.keep) return { bytes: original, mime: plan.mime, width: plan.width, height: plan.height, scaled: false };
    const target = type === "svg" ? fitWithin(width, height, MAX_IMAGE_EDGE) : plan;
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw unsupported();
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, target.width, target.height);
    const bytes = await canvasBytes(canvas, plan.mime, plan.mime === "image/jpeg" ? JPEG_QUALITY : undefined);
    canvas.width = 0;
    canvas.height = 0;
    return { bytes, mime: plan.mime, width: target.width, height: target.height, scaled: plan.scaled };
  } catch (error) {
    if (error?.code === IMAGE_UNSUPPORTED) throw error;
    throw unsupported(error);
  } finally {
    decoded.release();
  }
}
