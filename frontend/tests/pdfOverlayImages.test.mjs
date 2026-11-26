// The rules for pictures the user puts on a page (src/pages/pdfEditor/overlay/imageRules.js): the format of
// a file from its bytes, the size AS SHOWN, and what happens to a picture before it becomes an asset.
import test from "node:test";
import assert from "node:assert/strict";
import { JPEG_QUALITY, MAX_IMAGE_EDGE, fitWithin, imageFacts, importPlan, jpegSize, looksLikeImage, pngSize, sniffImageType } from "../src/pages/pdfEditor/overlay/imageRules.js";

const bytesOf = (...parts) => {
  const all = parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : Array.from(part)));
  return Uint8Array.from(all);
};
const be16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

/** The first bytes of a PNG of this size. */
const pngHead = (width, height) => bytesOf([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(width), be32(height), [8, 6, 0, 0, 0], be32(0));

/** A JPEG skeleton: optional EXIF orientation, a quantisation table segment, the frame header, start of scan. */
function jpegHead(width, height, { orientation = null, littleEndian = false, sof = 0xc0 } = {}) {
  const parts = [[0xff, 0xd8]];
  if (orientation !== null) {
    const u16 = (value) => (littleEndian ? [value & 0xff, value >> 8] : be16(value));
    const u32 = (value) => (littleEndian ? [value & 0xff, (value >> 8) & 0xff, 0, 0] : be32(value));
    const tiff = [...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
    const body = [..."Exif"].map((char) => char.charCodeAt(0)).concat([0, 0], tiff);
    parts.push([0xff, 0xe1], be16(body.length + 2), body);
  }
  parts.push([0xff, 0xdb], be16(4), [0, 0]);
  parts.push([0xff, sof], be16(11), [8], be16(height), be16(width), [1, 1, 0x11, 0]);
  parts.push([0xff, 0xda], be16(2));
  return bytesOf(...parts);
}

test("the format of a picture is read from its bytes, not from its name", () => {
  assert.equal(sniffImageType(pngHead(4, 3)), "png");
  assert.equal(sniffImageType(jpegHead(4, 3)), "jpeg");
  assert.equal(sniffImageType(bytesOf("GIF89a", new Array(10).fill(0))), "gif");
  assert.equal(sniffImageType(bytesOf("RIFF", be32(100), "WEBPVP8 ")), "webp");
  assert.equal(sniffImageType(bytesOf("BM", new Array(20).fill(0))), "bmp");
  assert.equal(sniffImageType(bytesOf(be32(28), "ftypavif", new Array(8).fill(0))), "avif");
  assert.equal(sniffImageType(bytesOf(be32(28), "ftypheic", new Array(8).fill(0))), "heic");
  assert.equal(sniffImageType(bytesOf(be32(28), "ftypmif1", new Array(8).fill(0))), "heic");
  assert.equal(sniffImageType(bytesOf("II", [0x2a, 0], new Array(12).fill(0))), "tiff");
  assert.equal(sniffImageType(bytesOf("MM", [0, 0x2a], new Array(12).fill(0))), "tiff");
  assert.equal(sniffImageType(bytesOf('<?xml version="1.0"?>\n<!-- drawing -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), "svg");
  assert.equal(sniffImageType(bytesOf("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")), null);
  assert.equal(sniffImageType(bytesOf(be32(28), "ftypisom", new Array(8).fill(0))), null, "a video container is not a picture");
  assert.equal(sniffImageType(bytesOf("PNG")), null, "too short");
  assert.equal(sniffImageType("not bytes"), null);
  assert.equal(sniffImageType(null), null);
});

test("stored size of a PNG and of a JPEG from their headers", () => {
  assert.deepEqual(pngSize(pngHead(640, 480)), { width: 640, height: 480 });
  assert.equal(pngSize(pngHead(0, 480)), null);
  assert.equal(pngSize(jpegHead(4, 3)), null);
  assert.equal(pngSize(pngHead(640, 480).subarray(0, 20)), null, "a cut header");
  assert.deepEqual(jpegSize(jpegHead(4000, 3000)), { width: 4000, height: 3000 });
  assert.deepEqual(jpegSize(jpegHead(320, 200, { sof: 0xc2 })), { width: 320, height: 200 }, "a progressive JPEG");
  assert.deepEqual(jpegSize(jpegHead(320, 200, { orientation: 6 })), { width: 320, height: 200 }, "the stored size, whatever the orientation says");
  assert.equal(jpegSize(pngHead(4, 3)), null);
  assert.equal(jpegSize(bytesOf([0xff, 0xd8, 0xff, 0xda], be16(2), new Array(8).fill(0))), null, "image data before a frame header");
  assert.equal(jpegSize(bytesOf([0xff, 0xd8, 0xff, 0xe0], be16(1), new Array(8).fill(0))), null, "a segment with an impossible length");
});

test("the size AS SHOWN: a JPEG that EXIF turns by a quarter swaps width and height, as the export draws it", () => {
  assert.deepEqual(imageFacts(pngHead(640, 480)), { type: "png", mime: "image/png", width: 640, height: 480, orientation: 1 });
  assert.deepEqual(imageFacts(jpegHead(4000, 3000)), { type: "jpeg", mime: "image/jpeg", width: 4000, height: 3000, orientation: 1 });
  for (const orientation of [2, 3, 4]) assert.deepEqual(imageFacts(jpegHead(4000, 3000, { orientation })), { type: "jpeg", mime: "image/jpeg", width: 4000, height: 3000, orientation });
  for (const orientation of [5, 6, 7, 8]) {
    for (const littleEndian of [false, true]) {
      assert.deepEqual(imageFacts(jpegHead(4000, 3000, { orientation, littleEndian })), { type: "jpeg", mime: "image/jpeg", width: 3000, height: 4000, orientation });
    }
  }
  assert.equal(imageFacts(bytesOf("GIF89a", new Array(10).fill(0))), null, "other formats are measured by decoding them");
  assert.equal(imageFacts(bytesOf([0xff, 0xd8, 0xff, 0xd9], new Array(10).fill(0))), null, "a JPEG without a frame header");
});

test("a long edge above 4000 px is brought down to 4000 px, proportions kept", () => {
  assert.equal(MAX_IMAGE_EDGE, 4000);
  assert.deepEqual(fitWithin(4000, 3000), { width: 4000, height: 3000, scaled: false });
  assert.deepEqual(fitWithin(8000, 6000), { width: 4000, height: 3000, scaled: true });
  assert.deepEqual(fitWithin(3000, 6000), { width: 2000, height: 4000, scaled: true });
  assert.deepEqual(fitWithin(10000, 3), { width: 4000, height: 1, scaled: true }, "never a side of zero pixels");
  assert.deepEqual(fitWithin(100, 50, 40), { width: 40, height: 20, scaled: true });
});

test("what happens to a picture: PNG and JPEG are kept as they are, the rest becomes PNG, large ones are scaled", () => {
  assert.deepEqual(importPlan({ type: "png", width: 800, height: 600 }), { keep: true, mime: "image/png", width: 800, height: 600, scaled: false });
  assert.deepEqual(importPlan({ type: "jpeg", width: 4000, height: 3000 }), { keep: true, mime: "image/jpeg", width: 4000, height: 3000, scaled: false });
  assert.deepEqual(importPlan({ type: "jpeg", width: 6000, height: 4000 }), { keep: false, mime: "image/jpeg", width: 4000, height: 2667, scaled: true }, "a large photo stays a JPEG");
  assert.deepEqual(importPlan({ type: "png", width: 5000, height: 5000 }), { keep: false, mime: "image/png", width: 4000, height: 4000, scaled: true });
  for (const type of ["webp", "gif", "bmp", "avif", "svg", "other"]) {
    assert.deepEqual(importPlan({ type, width: 300, height: 200 }), { keep: false, mime: "image/png", width: 300, height: 200, scaled: false }, type);
  }
  assert.deepEqual(importPlan({ type: "webp", width: 9000, height: 300 }), { keep: false, mime: "image/png", width: 4000, height: 133, scaled: true });
  assert.ok(JPEG_QUALITY > 0.8 && JPEG_QUALITY <= 1);
});

test("which dropped or pasted files count as pictures", () => {
  assert.equal(looksLikeImage({ type: "image/png", name: "x" }), true);
  assert.equal(looksLikeImage({ type: "", name: "scan.JPG" }), true);
  assert.equal(looksLikeImage({ type: "", name: "photo.heic" }), true, "offered, then refused with a message when the browser cannot decode it");
  assert.equal(looksLikeImage({ type: "application/pdf", name: "a.pdf" }), false);
  assert.equal(looksLikeImage({ type: "", name: "notes.txt" }), false);
  assert.equal(looksLikeImage(null), false);
});
