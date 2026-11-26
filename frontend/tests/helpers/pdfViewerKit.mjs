// Helpers of the viewer suites (tests/pdfViewer*.test.mjs): the viewer controller wired to pdf.js in Node (its
// main-thread "fake worker", the package's own asset folders) and generated fixtures. Hermetic: every PDF is
// made here with the editor's own PDF library and the bundled fonts.
import path from "node:path";
import { createRequire } from "node:module";
import { FRONTEND_ROOT, fontBytes, fontkit, pdfLib, pdfjs } from "./pdfTestKit.mjs";
import { createViewerController } from "../../src/pages/pdfEditor/viewer/viewerController.js";

const require = createRequire(path.join(FRONTEND_ROOT, "package.json"));
const PDFJS_ROOT = path.dirname(require.resolve("pdfjs-dist/package.json"));
// pdf.js wants directory "URLs" with forward slashes and a trailing slash, also in Node.
const directoryUrl = (name) => `${path.join(PDFJS_ROOT, name).replace(/\\/g, "/")}/`;

/** What ../../src/pages/pdfEditor/pdfWorker.js is in the browser: getDocument with the asset folders. */
export function openPdfDocument(params) {
  return pdfjs.getDocument({
    cMapUrl: directoryUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: directoryUrl("standard_fonts"),
    wasmUrl: directoryUrl("wasm"),
    iccUrl: directoryUrl("iccs"),
    useSystemFonts: false,
    verbosity: 0,
    ...params
  });
}

/** A controller as the editor creates it, with pdf.js running in this process. Call dispose() when done. */
export function makeController(options = {}) {
  return createViewerController({ pdfjs, openPdfDocument, ...options });
}

/** Resolves after the store had the chance to notify (it does so in a microtask). */
export const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

const { PDFDocument, PDFName, PDFNumber, PDFNull, PDFHexString, PDFString, degrees, rgb } = pdfLib;

/**
 * A PDF drawn item by item.
 * @param {Array<{ size?: [number, number], rotate?: number, userUnit?: number, crop?: number[],
 *                 texts?: Array<{ text: string, x: number, y: number, size?: number, fontKey?: string,
 *                                 angle?: number, color?: number[] }>,
 *                 rects?: Array<{ x: number, y: number, w: number, h: number, color: number[] }> }>} pages
 * @param {{ title?: string, author?: string, subject?: string, keywords?: string[], useObjectStreams?: boolean,
 *           encrypt?: { userPassword?: string, ownerPassword?: string },
 *           outline?: Array<{ title: string, page: number, top?: number }>,
 *           links?: Array<{ page: number, rect: number[], toPage?: number, url?: string }> }} [options]
 *        outline / links name pages by their 0-based index
 * @returns {Promise<Uint8Array>}
 */
export async function makePdf(pages, options = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  if (options.title) doc.setTitle(options.title);
  if (options.author) doc.setAuthor(options.author);
  if (options.subject) doc.setSubject(options.subject);
  if (options.keywords) doc.setKeywords(options.keywords);
  const fonts = new Map();
  const fontFor = async (key) => {
    if (!fonts.has(key)) fonts.set(key, await doc.embedFont(fontBytes(key), { subset: true }));
    return fonts.get(key);
  };
  const made = [];
  for (const spec of pages) {
    const size = spec.size || [595.28, 841.89];
    const page = doc.addPage(size);
    for (const box of spec.rects || []) {
      page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: rgb(...box.color) });
    }
    for (const run of spec.texts || []) {
      page.drawText(run.text.normalize("NFC"), {
        x: run.x,
        y: run.y,
        size: run.size || 12,
        font: await fontFor(run.fontKey || "arimo-regular"),
        rotate: run.angle ? degrees(run.angle) : undefined,
        color: run.color ? rgb(...run.color) : undefined
      });
    }
    if (spec.crop) page.setCropBox(spec.crop[0], spec.crop[1], spec.crop[2] - spec.crop[0], spec.crop[3] - spec.crop[1]);
    if (spec.userUnit) page.node.set(PDFName.of("UserUnit"), PDFNumber.of(spec.userUnit));
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    made.push(page);
  }
  const { context } = doc;
  if (options.outline?.length) {
    const rootRef = context.nextRef();
    const refs = options.outline.map(() => context.nextRef());
    options.outline.forEach((entry, index) => {
      const target = made[entry.page];
      const item = context.obj({
        Title: PDFHexString.fromText(entry.title),
        Parent: rootRef,
        Dest: entry.top === undefined ? [target.ref, "Fit"] : [target.ref, "XYZ", PDFNull, PDFNumber.of(entry.top), PDFNull]
      });
      if (index > 0) item.set(PDFName.of("Prev"), refs[index - 1]);
      if (index < refs.length - 1) item.set(PDFName.of("Next"), refs[index + 1]);
      context.assign(refs[index], item);
    });
    context.assign(rootRef, context.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
    doc.catalog.set(PDFName.of("Outlines"), rootRef);
  }
  if (options.links?.length) {
    const byPage = new Map();
    for (const link of options.links) {
      const annotation = context.obj({ Type: "Annot", Subtype: "Link", Rect: link.rect, Border: [0, 0, 0] });
      if (link.url) annotation.set(PDFName.of("A"), context.obj({ Type: "Action", S: "URI", URI: PDFString.of(link.url) }));
      else annotation.set(PDFName.of("Dest"), context.obj([made[link.toPage].ref, "Fit"]));
      if (!byPage.has(link.page)) byPage.set(link.page, []);
      byPage.get(link.page).push(context.register(annotation));
    }
    for (const [pageIndex, refs] of byPage) made[pageIndex].node.set(PDFName.of("Annots"), context.obj(refs));
  }
  if (options.encrypt) doc.encrypt(options.encrypt);
  return doc.save({ useObjectStreams: options.useObjectStreams ?? true });
}

/** Text items of one page of a PDF, exactly as the viewer reads them: { items, styles }. */
export async function textContentOf(bytes, pageNumber = 1, { password } = {}) {
  const task = openPdfDocument({ data: new Uint8Array(bytes), password, fontExtraProperties: true });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent({ disableNormalization: true });
    await page.getOperatorList(); // loads the font objects (names) into page.commonObjs
    const fonts = new Map();
    for (const item of content.items) {
      if (item.fontName && !fonts.has(item.fontName) && page.commonObjs.has(item.fontName)) fonts.set(item.fontName, page.commonObjs.get(item.fontName));
    }
    return { items: content.items, styles: content.styles, fonts, view: page.view, rotate: page.rotate, userUnit: page.userUnit };
  } finally {
    await task.destroy();
  }
}
