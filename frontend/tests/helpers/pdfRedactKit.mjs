// Helpers of the redaction suites (tests/pdfRedact*.test.mjs): the Node env of redactPdf(), small PDFs built
// from hand-written content streams (makePdf) or written byte for byte (rawPdf: files a PDF library would not
// write), and the independent checks the tests use on an output (text through pdf.js, raw bytes, reachability
// of every object, pixels of a region, the stored pictures of the mosaics and their blocks).
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { FRONTEND_ROOT, canRender, canvasLib, closePdf, loadFont, openPdf, pdfLib, pdfjs, rectToPixels, regionStats, renderPage } from "./pdfTestKit.mjs";
import { rawScan } from "./pdfRawScan.mjs";
import { A } from "../../src/pages/pdfEditor/engine/redact/pdfAccess.js";
import { snapshotPage } from "../../src/pages/pdfEditor/engine/redact/verifyRedaction.js";

export { A };
const { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFStream, PDFInvalidObject } = pdfLib;

export const latin1 = (u8) => Buffer.from(u8).toString("latin1");
export const bytesOf = (s) => new Uint8Array(Buffer.from(s, "latin1"));

/** A deterministic random source (mulberry32) for the noise of the mosaics. */
export function seededRandom(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PDFJS_ROOT = path.dirname(createRequire(path.join(FRONTEND_ROOT, "package.json")).resolve("pdfjs-dist/package.json")).replace(/\\/g, "/");

/**
 * The Node twin of openPdfDocument() of src/pages/pdfEditor/pdfWorker.js (which only Vite can load): the
 * parameters of getDocument() in, the LOADING TASK of pdf.js out. createBrowserRedactEnv() is made for exactly
 * this shape, so its test uses the real thing and not a function invented for the test.
 */
export function openPdfDocument(params = {}) {
  return pdfjs.getDocument({
    cMapUrl: `${PDFJS_ROOT}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`,
    wasmUrl: `${PDFJS_ROOT}/wasm/`,
    iccUrl: `${PDFJS_ROOT}/iccs/`,
    enableXfa: false,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
    ...params
  });
}

/** The env of redactPdf() in Node: pdf.js and the fonts of the test kit, @napi-rs/canvas for pixels. */
export function redactEnv(options = {}) {
  return {
    pdfjs,
    openPdf,
    closePdf,
    createCanvas: (width, height) => {
      if (!canvasLib) throw new Error("this test needs a canvas (skip it with canRender)");
      return canvasLib.createCanvas(width, height);
    },
    encodeJpeg: async (canvas, quality) => new Uint8Array(canvas.toBuffer("image/jpeg", Math.round(quality * 100))),
    fonts: loadFont,
    random: seededRandom(7),
    ...options
  };
}

/**
 * Builds a small PDF from raw content streams.
 *   pages: [{ content: string | Uint8Array | (string | Uint8Array)[], resources?: object | fn, size?: [w, h],
 *             annots?: (object | fn)[], extra?: object }]
 *   options.objects: { key: literal | (ctx, refs, fonts) => ref } registered once, available as refs[key]
 *   options.catalog: entries for the catalog, options.setup(doc, refs, fonts): last touch before saving
 * Resources are literals of the PDF library; the standard fonts F1 (Helvetica), F2 (Times-Roman), F3 (Courier)
 * are added to every page that does not bring its own /Font.
 * Returns { bytes, refs } with refs.pages (page references) and refs.contents (content stream references per page).
 */
export async function makePdf(pages, options = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const std = (name) => ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: name, Encoding: "WinAnsiEncoding" }));
  const fonts = { F1: std("Helvetica"), F2: std("Times-Roman"), F3: std("Courier") };
  const refs = {};
  for (const [k, v] of Object.entries(options.objects || {})) refs[k] = typeof v === "function" ? v(ctx, refs, fonts) : ctx.register(ctx.obj(v));
  refs.pages = [];
  refs.contents = [];
  for (const p of pages) {
    const page = doc.addPage(p.size || [612, 792]);
    refs.pages.push(page.ref);
    const parts = Array.isArray(p.content) ? p.content : [p.content];
    const streamRefs = parts.map((c) => ctx.register(ctx.stream(typeof c === "string" ? bytesOf(c) : c)));
    refs.contents.push(streamRefs);
    page.node.set(PDFName.of("Contents"), streamRefs.length === 1 ? streamRefs[0] : ctx.obj(streamRefs));
    const res = typeof p.resources === "function" ? p.resources(ctx, refs, fonts) : p.resources || {};
    const resDict = ctx.obj(res);
    if (!resDict.has(PDFName.of("Font"))) resDict.set(PDFName.of("Font"), ctx.obj(fonts));
    page.node.set(PDFName.of("Resources"), resDict);
    if (p.annots) page.node.set(PDFName.of("Annots"), ctx.obj(p.annots.map((a) => (typeof a === "function" ? a(ctx, refs, page.ref) : ctx.register(ctx.obj(a))))));
    for (const [k, v] of Object.entries(p.extra || {})) page.node.set(PDFName.of(k), typeof v === "function" ? v(ctx, refs, page.ref) : ctx.obj(v));
  }
  if (options.catalog) for (const [k, v] of Object.entries(options.catalog)) doc.catalog.set(PDFName.of(k), typeof v === "function" ? v(ctx, refs, fonts) : ctx.obj(v));
  if (options.setup) await options.setup(doc, refs, fonts);
  const bytes = await doc.save({ useObjectStreams: options.useObjectStreams ?? false, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, refs };
}

/** Form XObject stream helper for makePdf({ objects }) and resources. */
export const formXObject = (content, dict = {}) => (ctx, refs, fonts) =>
  ctx.register(ctx.stream(bytesOf(content), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 612, 792], Resources: { Font: fonts }, ...(typeof dict === "function" ? dict(ctx, refs, fonts) : dict) }));

/** A w x h grey image XObject (one byte per pixel), for makePdf resources: (ctx) => ref. */
export const grayImage = (w = 1, h = 1, value = 128) => (ctx) =>
  ctx.register(ctx.stream(new Uint8Array(w * h).fill(value), { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));

export async function load(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

export async function save(doc) {
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/** snapshotPage() of one page of a PDF given as bytes (0-based page index). */
export async function snap(bytes, pageIndex = 0, options) {
  const doc = await openPdf(bytes, options);
  try {
    const page = await doc.getPage(pageIndex + 1);
    return await snapshotPage(page, pdfjs);
  } finally {
    await closePdf(doc);
  }
}

/** Page text (pdf.js) without white space, NFC. */
export async function pageTextOf(bytes, pageIndex = 0) {
  return (await snap(bytes, pageIndex)).text.normalize("NFC").replace(/\s+/g, "");
}

/** Decoded content of a page as a Latin-1 string (all streams joined). */
export function pageContent(doc, pageIndex = 0) {
  const node = doc.getPage(pageIndex).node;
  const contents = A.get(node, "Contents");
  const streams = A.isArray(contents) ? contents.asArray().map((r) => A.resolve(doc.context, r)) : [contents];
  return streams.map((s) => latin1(A.streamBytes(s))).join("\n");
}

/** Origin of the first glyph of `text` in a snapshot (content order), or null. */
export function originOf(snapshot, text) {
  const all = snapshot.glyphs.map((g) => g.unicode).join("");
  const at = all.indexOf(text);
  if (at < 0) return null;
  // glyph.unicode can be longer than one character: walk
  let pos = 0;
  for (const g of snapshot.glyphs) {
    if (pos === at) return g.origin;
    pos += g.unicode.length;
  }
  return null;
}

/** Box around the glyphs of `text` (first occurrence in content order) of a page, in user space. */
export async function boxOf(bytes, text, { page = 0, pad = 0, snapshot } = {}) {
  const s = snapshot || (await snap(bytes, page));
  const all = s.glyphs.map((g) => g.unicode).join("");
  const at = all.indexOf(text);
  if (at < 0) throw new Error(`"${text}" not found on page ${page + 1}`);
  // one glyph per UTF-16 unit in these fixtures
  const glyphs = s.glyphs.slice(at, at + text.length);
  const xs = glyphs.flatMap((g) => [g.quad[0], g.quad[2], g.quad[4], g.quad[6]]);
  const ys = glyphs.flatMap((g) => [g.quad[1], g.quad[3], g.quad[5], g.quad[7]]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

/** Is the string anywhere in the bytes of the file (any stream, reachable or not, any encoding the scan knows)? */
export const found = (bytes, text) => rawScan(bytes, [text])[text].length > 0;

/**
 * Objects of a saved file that nothing reachable from the trailer points at, as "num gen" strings.
 * An independent walk (not the engine's collector); the parser's own leftovers do not count.
 */
export async function findOrphans(bytes) {
  const doc = await load(bytes);
  const context = doc.context;
  const marked = new Set();
  const queue = [];
  const visit = (value) => {
    const stack = [value];
    while (stack.length) {
      const current = stack.pop();
      if (current instanceof PDFRef) {
        if (!marked.has(current)) {
          marked.add(current);
          queue.push(current);
        }
      } else if (current instanceof PDFDict) stack.push(...current.values());
      else if (current instanceof PDFArray) stack.push(...current.asArray());
      else if (current instanceof PDFStream) stack.push(current.dict);
    }
  };
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  for (const root of [Root, Info, Encrypt, ID]) if (root) visit(root);
  while (queue.length) visit(context.lookup(queue.pop()));
  const orphans = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (marked.has(ref)) continue;
    if (object instanceof PDFInvalidObject) {
      orphans.push(`${ref.objectNumber} ${ref.generationNumber} (invalid)`);
      continue;
    }
    const type = object instanceof PDFStream ? object.dict.get(PDFName.of("Type")) : undefined;
    if (type === PDFName.of("ObjStm") || type === PDFName.of("XRef")) continue;
    orphans.push(`${ref.objectNumber} ${ref.generationNumber}`);
  }
  return orphans;
}

/**
 * What a reader sees inside a user-space rectangle of a rendered page (rotation 0, 2 px inset). Needs canRender.
 * Returns the regionStats() of the test kit plus
 *   colours   Set of the distinct colours (0xrrggbb)
 *   edges     number of horizontally neighbouring pixels whose brightness differs by more than 48 levels:
 *             text has thousands of them (two per stem and row), a mosaic only where two blocks meet
 *   data      the RGBA bytes, width, height (for comparing two renders)
 */
export async function regionOf(bytes, pageIndex, rect, { scale = 2, inset = 2, tolerance = 6 } = {}) {
  if (!canRender) throw new Error("regionOf needs a canvas");
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(pageIndex + 1);
    const { ctx, canvas, viewport } = await renderPage(page, { scale, rotation: 0 });
    const [left, top, right, bottom] = rectToPixels(viewport, rect, canvas);
    const box = [left + inset, top + inset, right - inset, bottom - inset];
    const stats = regionStats(ctx, box, tolerance);
    const colours = new Set();
    let edges = 0;
    let data = null;
    const width = box[2] - box[0];
    const height = box[3] - box[1];
    if (!stats.empty) {
      ({ data } = ctx.getImageData(box[0], box[1], width, height));
      const light = (i) => (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      for (let i = 0; i < data.length; i += 4) {
        colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if ((i / 4) % width !== width - 1 && Math.abs(light(i) - light(i + 4)) > 48) edges += 1;
      }
    }
    return { ...stats, colours, edges, data, width, height };
  } finally {
    await closePdf(doc);
  }
}

/** Largest difference of any colour channel between two regionOf() results of the same size. */
export function regionDifference(a, b) {
  if (!a.data || !b.data || a.data.length !== b.data.length) return 255;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    max = Math.max(max, Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
  }
  return max;
}

/**
 * A PDF file written by hand: `objects` are the bodies of the objects 1, 2, ... (object 1 is the catalog), with a
 * classic cross-reference table. `after` is put between the last object and the table: what stands there is
 * in the file, but the table does not point at it (a leftover, a second definition of an object).
 */
export function rawPdf(objects, { after = "" } = {}) {
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  pdf += after;
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytesOf(pdf);
}

/**
 * The pictures the engine stored for the mosaics of a page of the precise path (the image XObjects RPatch0,
 * RPatch1 ... of the page, lossless): [{ name, width, height, rgb: Uint8Array of width * height * 3 }], in the
 * order they were painted. Decoded here (Flate, PNG "Up" predictor), not by the engine.
 */
export async function patchImages(bytes, pageIndex = 0) {
  const doc = await load(bytes);
  const xobjects = A.get(A.get(doc.getPage(pageIndex).node, "Resources"), "XObject");
  const out = [];
  if (!A.isDict(xobjects)) return out;
  for (const [key, ref] of xobjects.entries()) {
    const name = key.decodeText();
    if (!/^RPatch\d+$/.test(name)) continue;
    const stream = doc.context.lookup(ref);
    const width = A.getNum(stream.dict, "Width");
    const height = A.getNum(stream.dict, "Height");
    const raw = zlib.inflateSync(Buffer.from(stream.contents));
    const stride = width * 3;
    const rgb = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      for (let i = 0; i < stride; i++) {
        const value = raw[y * (stride + 1) + 1 + i];
        rgb[y * stride + i] = filter === 2 && y > 0 ? (value + rgb[(y - 1) * stride + i]) & 0xff : value;
      }
    }
    out.push({ name, width, height, rgb });
  }
  return out.sort((a, b) => Number(a.name.slice(6)) - Number(b.name.slice(6)));
}

/**
 * The blocks of a mosaic picture of patchImages(): { columns, rows } = the lengths of the runs of equal
 * columns from left to right and of equal rows from top to bottom (their sums are the width and the height).
 */
export function blockRuns({ width, height, rgb }) {
  const sameColumn = (a, b) => {
    for (let y = 0; y < height; y++) for (let c = 0; c < 3; c++) if (rgb[(y * width + a) * 3 + c] !== rgb[(y * width + b) * 3 + c]) return false;
    return true;
  };
  const sameRow = (a, b) => {
    for (let i = 0; i < width * 3; i++) if (rgb[a * width * 3 + i] !== rgb[b * width * 3 + i]) return false;
    return true;
  };
  const runs = (count, same) => {
    const out = [1];
    for (let i = 1; i < count; i++) {
      if (same(i - 1, i)) out[out.length - 1]++;
      else out.push(1);
    }
    return out;
  };
  return { columns: runs(width, sameColumn), rows: runs(height, sameRow) };
}

/** Geometry of every page as pdf.js reports it: [{ view, rotate, userUnit }]. */
export async function pageGeometries(bytes) {
  const doc = await openPdf(bytes);
  try {
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      out.push({ view: page.view.map((v) => Math.round(v * 100) / 100), rotate: page.rotate, userUnit: page.userUnit });
    }
    return out;
  } finally {
    await closePdf(doc);
  }
}
