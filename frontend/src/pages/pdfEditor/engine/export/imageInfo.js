// What the export has to know about a picture before it embeds it: which format the bytes really are, and
// whether a JPEG asks to be turned when it is shown (EXIF orientation).
//
// Why the orientation matters: a browser shows a photo upright (image-orientation: from-image is the default),
// the PDF library embeds the stored pixels as they are, and a PDF viewer never looks at EXIF. A portrait
// photo from a phone would lie on its side in the exported file. The engine therefore draws the image with
// the matrix that turns it the way the browser shows it. Pure functions: no DOM, no PDF library.

/** "png" | "jpeg" | null from the first bytes of a file. */
export function sniffImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/**
 * The EXIF orientation of a JPEG: 1 (upright, also when there is no EXIF data) to 8.
 *   2 mirrored, 3 turned by 180 degrees, 4 flipped, 5 / 7 mirrored and turned, 6 shown turned 90 degrees
 *   clockwise (the usual portrait photo), 8 shown turned 90 degrees counter-clockwise.
 */
export function jpegOrientation(bytes) {
  if (sniffImage(bytes) !== "jpeg") return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { // fill byte
      offset += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return 1; // image data: no EXIF segment came before it
    const length = view.getUint16(offset + 2);
    if (length < 2) return 1;
    // APP1 "Exif\0\0" + TIFF header
    if (marker === 0xe1 && length >= 16 && bytes[offset + 4] === 0x45 && bytes[offset + 5] === 0x78 && bytes[offset + 6] === 0x69 && bytes[offset + 7] === 0x66 && bytes[offset + 8] === 0 && bytes[offset + 9] === 0) {
      const tiff = offset + 10;
      const end = Math.min(bytes.length, offset + 2 + length);
      if (tiff + 8 > end) return 1;
      const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
      if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1;
      const directory = tiff + view.getUint32(tiff + 4, little);
      if (directory + 2 > end) return 1;
      const count = view.getUint16(directory, little);
      for (let index = 0; index < count; index += 1) {
        const entry = directory + 2 + index * 12;
        if (entry + 12 > end) return 1;
        if (view.getUint16(entry, little) === 0x0112) {
          const value = view.getUint16(entry + 8, little);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

/**
 * The matrix [a b c d e f] that paints an image XObject (unit square, first stored row at the top) into the
 * box `width` x `height` (origin bottom-left, y up) the way a browser shows a picture with this EXIF
 * orientation. `width` and `height` are the size AS SHOWN.
 */
export function orientationMatrix(orientation, width, height) {
  switch (orientation) {
    case 2: return [-width, 0, 0, height, width, 0];
    case 3: return [-width, 0, 0, -height, width, height];
    case 4: return [width, 0, 0, -height, 0, height];
    case 5: return [0, -height, -width, 0, width, height];
    case 6: return [0, -height, width, 0, 0, height];
    case 7: return [0, height, width, 0, 0, 0];
    case 8: return [0, height, -width, 0, width, 0];
    default: return [width, 0, 0, height, 0, 0];
  }
}
