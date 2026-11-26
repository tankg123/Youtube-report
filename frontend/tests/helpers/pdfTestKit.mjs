// Shared helpers of the PDF editor's node:test suites (tests/pdf*.test.mjs): pdf.js (legacy build) in Node
// for text extraction and rendering, the bundled fonts, and small generated fixtures. Tests are hermetic:
// every PDF they use is generated here or in the test itself (no downloaded or third-party files).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as pdfjsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import { fontkit, pdfLib } from "../../src/pages/pdfEditor/engine/lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_ROOT = path.resolve(HERE, "../..");
const require = createRequire(path.join(FRONTEND_ROOT, "package.json"));
const PDFJS_ROOT = path.dirname(require.resolve("pdfjs-dist/package.json"));
// pdf.js wants directory "URLs" with forward slashes and a trailing slash, also in Node.
const directoryUrl = (name) => `${path.join(PDFJS_ROOT, name).replace(/\\/g, "/")}/`;

export const pdfjs = pdfjsModule;
export { fontkit, pdfLib };

/** @napi-rs/canvas (an optional dependency of pdfjs-dist): null where no binary exists for the platform. */
export const canvasLib = (() => {
  try {
    return require("@napi-rs/canvas");
  } catch {
    return null;
  }
})();
/** Use as `test("...", { skip: !canRender && "no canvas" }, ...)` for tests that look at pixels. */
export const canRender = Boolean(canvasLib);

/** Opens a PDF with pdf.js. The bytes are copied: pdf.js takes ownership of the buffer it is given. */
export async function openPdf(bytes, { password } = {}) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    cMapUrl: directoryUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: directoryUrl("standard_fonts"),
    wasmUrl: directoryUrl("wasm"),
    iccUrl: directoryUrl("iccs"),
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0
  });
  const doc = await task.promise;
  doc.__task = task;
  return doc;
}

export async function closePdf(doc) {
  try {
    await doc?.__task?.destroy();
  } catch {
    /* already closed */
  }
}

/** Runs `fn(doc)` on an opened PDF and always closes it. */
export async function withPdf(bytes, fn, options) {
  const doc = await openPdf(bytes, options);
  try {
    return await fn(doc);
  } finally {
    await closePdf(doc);
  }
}

/** Page text as pdf.js extracts it: item strings joined, "\n" after items flagged hasEOL. */
export async function pageText(page) {
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text;
}

/** The text of every page: string[] (index = page index). */
export function extractText(bytes, options) {
  return withPdf(bytes, async (doc) => {
    const pages = [];
    for (let number = 1; number <= doc.numPages; number += 1) pages.push(await pageText(await doc.getPage(number)));
    return pages;
  }, options);
}

/** Comparison form for extracted text: NFC, all white space removed. */
// White space of every kind, built from code points (no-break space, zero-width space, BOM) so that the
// source holds no invisible characters.
const WHITE_SPACE = new RegExp(`[\\s${String.fromCharCode(0xa0, 0x200b, 0xfeff)}]+`, "g");
export const squash = (text) => String(text).normalize("NFC").replace(WHITE_SPACE, "");

/**
 * Text items of a page with their boxes in PDF user space:
 * [{ str, box: [x0, y0, x1, y1], angle, fontName, transform, width, height }].
 */
export async function pageItems(page) {
  const content = await page.getTextContent();
  const items = [];
  for (const item of content.items) {
    if (typeof item.str !== "string" || item.str.replace(/\s+/g, "") === "") continue;
    const [a, b, c, d, e, f] = item.transform;
    const lengthU = Math.hypot(a, b);
    const lengthV = Math.hypot(c, d);
    if (!(lengthU > 0) || !(lengthV > 0)) continue;
    const style = content.styles[item.fontName] || {};
    let ascent = Number.isFinite(style.ascent) && style.ascent ? style.ascent : 0.8;
    let descent = Number.isFinite(style.descent) && style.descent ? style.descent : ascent - 1;
    if (descent > 0) descent = -descent;
    const at = (t, s) => [e + (a / lengthU) * t + (c / lengthV) * s, f + (b / lengthU) * t + (d / lengthV) * s];
    const quad = [at(0, descent * lengthV), at(item.width, descent * lengthV), at(item.width, ascent * lengthV), at(0, ascent * lengthV)];
    const xs = quad.map((point) => point[0]);
    const ys = quad.map((point) => point[1]);
    items.push({
      str: item.str,
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      angle: (Math.atan2(b, a) * 180) / Math.PI,
      fontName: item.fontName,
      transform: item.transform,
      width: item.width,
      height: item.height
    });
  }
  return items;
}

/**
 * Renders a page (needs `canRender`). `rotation` defaults to the page's own /Rotate.
 * Returns { canvas, ctx, viewport, width, height }.
 */
export async function renderPage(page, { scale = 2, rotation, background = "white", annotations = true } = {}) {
  if (!canvasLib) throw new Error("renderPage needs @napi-rs/canvas (skip the test with canRender)");
  const viewport = page.getViewport(rotation === undefined ? { scale } : { scale, rotation });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = canvasLib.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  await page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    background,
    annotationMode: annotations ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE
  }).promise;
  return { canvas, ctx, viewport, width, height };
}

/** Pixel rectangle [left, top, right, bottom] (integers, clamped) of a user-space rectangle in a viewport. */
export function rectToPixels(viewport, rect, canvas) {
  const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
  const clampX = (value) => Math.min(canvas.width, Math.max(0, value));
  const clampY = (value) => Math.min(canvas.height, Math.max(0, value));
  return [clampX(Math.floor(Math.min(ax, bx))), clampY(Math.floor(Math.min(ay, by))), clampX(Math.ceil(Math.max(ax, bx))), clampY(Math.ceil(Math.max(ay, by)))];
}

/**
 * Colour statistics of a pixel rectangle: { uniform, range, mean: "#rrggbb", pixels, dark } where `dark`
 * counts pixels darker than mid grey and `uniform` means every channel varies by at most `tolerance` levels.
 */
export function regionStats(ctx, [left, top, right, bottom], tolerance = 6) {
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return { empty: true, uniform: null, pixels: 0, dark: 0 };
  const { data } = ctx.getImageData(left, top, width, height);
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  const sum = [0, 0, 0];
  let dark = 0;
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = data[index + channel];
      if (value < min[channel]) min[channel] = value;
      if (value > max[channel]) max[channel] = value;
      sum[channel] += value;
    }
    if (data[index] + data[index + 1] + data[index + 2] < 384) dark += 1;
  }
  const pixels = width * height;
  const range = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const mean = `#${sum.map((value) => Math.round(value / pixels).toString(16).padStart(2, "0")).join("")}`;
  return { empty: false, uniform: range <= tolerance, range, mean, pixels, dark };
}

// --- bundled fonts (public/pdf-fonts) ---

export const FONT_DIR = path.join(FRONTEND_ROOT, "public", "pdf-fonts");
export const fontManifest = JSON.parse(fs.readFileSync(path.join(FONT_DIR, "manifest.json"), "utf8"));

/** Bytes of a bundled font by its manifest id, e.g. "arimo-regular", "tinos-bold-italic". */
export function fontBytes(fontKey) {
  const entry = fontManifest.fonts.find((font) => font.id === fontKey);
  if (!entry) throw new Error(`unknown bundled font "${fontKey}"`);
  return new Uint8Array(fs.readFileSync(path.join(FONT_DIR, entry.file)));
}

/** The `fonts` callback the engines expect: async (fontKey) => Uint8Array. */
export const loadFont = async (fontKey) => fontBytes(fontKey);

// --- generated fixtures ---

export const VIETNAMESE_SAMPLE = "Hợp đồng dịch vụ số 12/2026: Nguyễn Văn An đã ký ngày 16 tháng 11";

/**
 * A small PDF made with the editor's own PDF library and a bundled (redistributable) font.
 * @param {Array<{ lines?: string[], size?: [number, number], rotate?: number, fontKey?: string, fontSize?: number }>} pages
 * @param {{ title?: string, useObjectStreams?: boolean }} [options]
 * @returns {Promise<Uint8Array>} Each line is drawn at x = 50 from the top margin down, 24 pt apart.
 */
export async function makeTextPdf(pages = [{ lines: [VIETNAMESE_SAMPLE] }], options = {}) {
  const { PDFDocument, degrees } = pdfLib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  if (options.title) doc.setTitle(options.title);
  const fonts = new Map();
  for (const spec of pages) {
    const size = spec.size || [595.28, 841.89];
    const page = doc.addPage(size);
    const key = spec.fontKey || "arimo-regular";
    if (!fonts.has(key)) fonts.set(key, await doc.embedFont(fontBytes(key), { subset: true }));
    const fontSize = spec.fontSize || 14;
    (spec.lines || []).forEach((line, index) => {
      page.drawText(line.normalize("NFC"), { x: 50, y: size[1] - 60 - index * 24, size: fontSize, font: fonts.get(key) });
    });
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
  }
  return doc.save({ useObjectStreams: options.useObjectStreams ?? true });
}

/** A tiny valid PNG (w x h pixels of one colour) for image tests, built without any image library. */
export function makePng(width = 4, height = 4, rgba = [220, 38, 38, 255]) {
  if (!canvasLib) {
    // 1 x 1 red pixel, pre-encoded: enough where no canvas exists
    return Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
  }
  const canvas = canvasLib.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3] / 255})`;
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/png"));
}
