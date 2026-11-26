// The rules for pictures the user puts on a page, as pure functions (tests/pdfOverlayImages.test.mjs):
// which format a file really is, how large the picture is AS SHOWN, and what happens to it before it becomes
// an asset of the document (UX specification 7.5):
//   PNG and JPEG are kept as they are (the export embeds exactly these bytes)
//   every other format the browser can decode is drawn and stored as PNG
//   a picture whose long edge exceeds 4000 px is scaled down to that
//   what the browser cannot decode is refused
// The decoding itself needs a browser and lives in imageImport.js.
import { jpegOrientation } from "../engine/export/imageInfo.js";

/** The long edge of a stored picture never exceeds this (pixels). */
export const MAX_IMAGE_EDGE = 4000;
/** Quality of a JPEG that had to be scaled down. */
export const JPEG_QUALITY = 0.92;

const ascii = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));

/**
 * The format of a picture file from its first bytes:
 * "png" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "heic" | "tiff" | "svg" | null.
 */
export function sniffImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (ascii(bytes, 0, 2) === "BM") return "bmp";
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a)) return "tiff";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
    return null;
  }
  // an SVG is text: look for its root element near the start (after a declaration, comments, a byte order mark)
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  if (/<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** Stored size of a PNG from its IHDR chunk: { width, height } or null. */
export function pngSize(bytes) {
  if (sniffImageType(bytes) !== "png" || bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Stored size of a JPEG from its frame header (SOF marker): { width, height } or null. */
export function jpegSize(bytes) {
  if (sniffImageType(bytes) !== "jpeg") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2; // markers without a length
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    // SOF0 .. SOF15, except DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data before any frame header
    offset += 2 + length;
  }
  return null;
}

/**
 * What can be read from the bytes of a PNG or JPEG without decoding it:
 * { type, mime, width, height, orientation }, with the size AS SHOWN: a JPEG whose EXIF orientation is 5 to 8
 * is shown turned by a quarter, so its width and height swap (the export engine turns it the same way).
 * null for every other format (and for a PNG / JPEG whose header cannot be read).
 */
export function imageFacts(bytes) {
  const type = sniffImageType(bytes);
  if (type === "png") {
    const size = pngSize(bytes);
    return size ? { type, mime: "image/png", width: size.width, height: size.height, orientation: 1 } : null;
  }
  if (type === "jpeg") {
    const size = jpegSize(bytes);
    if (!size) return null;
    const orientation = jpegOrientation(bytes);
    const turned = orientation >= 5;
    return { type, mime: "image/jpeg", width: turned ? size.height : size.width, height: turned ? size.width : size.height, orientation };
  }
  return null;
}

/** The size of a picture brought down to a long edge of at most `maxEdge`: { width, height, scaled }. */
export function fitWithin(width, height, maxEdge = MAX_IMAGE_EDGE) {
  const long = Math.max(width, height);
  if (!(long > maxEdge)) return { width, height, scaled: false };
  const factor = maxEdge / long;
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)), scaled: true };
}

/**
 * What to do with a picture of a known format and size (as shown):
 *   keep     true: store the bytes as they are
 *   mime     the format of the stored asset ("image/png" | "image/jpeg")
 *   width, height   size of the stored picture in pixels
 *   scaled   true: it was brought down to MAX_IMAGE_EDGE
 * A JPEG that has to be scaled stays a JPEG (a photo as PNG would be many times larger); everything else that
 * has to be drawn again becomes a PNG, which keeps transparency.
 */
export function importPlan({ type, width, height }, maxEdge = MAX_IMAGE_EDGE) {
  const fitted = fitWithin(width, height, maxEdge);
  const native = type === "png" || type === "jpeg";
  return {
    keep: native && !fitted.scaled,
    mime: type === "jpeg" ? "image/jpeg" : "image/png",
    width: fitted.width,
    height: fitted.height,
    scaled: fitted.scaled
  };
}

/** True for a File / Blob that says it is a picture (by its type or its name). */
export function looksLikeImage(file) {
  const type = String(file?.type || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i.test(String(file?.name || ""));
}
