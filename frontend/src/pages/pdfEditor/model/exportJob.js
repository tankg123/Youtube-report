// Builds the ExportJob (model/schema.js) that the export pipeline runs: one consistent snapshot of the
// document with the bytes it needs. No DOM, no PDF library, no user text.
//
//   const job = await buildExportJob(store, { layoutText });
//
//   sources   only the files that pages of the job come from, in the order of their first page, with their
//             bytes (the array the store holds: engines copy before they hand it to pdf.js), the password
//             and the page count the viewer saw (the writer refuses to run when it sees another number)
//   pages     in order; `rotate` is the rotation the USER added (clockwise), on top of the page's own /Rotate
//   objects   per page, bottom -> top, WITHOUT marks; every text object carries its TextLayout in `layout`
//             and a frame of exactly the laid-out size
//   marks     redact and blur objects (mode "redact" | "pixelate" | "blur"), then one "erase" mark for every
//             text box that replaces a line of the document; all with `objectId`
//   assets    the images that objects of the job use
//
// The job is built from ONE state snapshot: the store may change while layouts are awaited.
import { PdfEditorError, throwIfAborted } from "../engine/errors.js";
import { normalizeRect, resizeFrame } from "../engine/geometry.js";
import { TEXT_FONTS } from "./schema.js";
import { validateDocument } from "./selectors.js";

const DOCUMENT_KEYS = ["title", "author", "subject", "keywords"];
const INFO_KEYS = [...DOCUMENT_KEYS, "creator"];
const pickInfo = (info, keys) => Object.fromEntries(keys.filter((key) => typeof info?.[key] === "string" && info[key]).map((key) => [key, info[key]]));
const FONT_KEY = new RegExp(`^(?:${TEXT_FONTS.map((font) => font.id).join("|")})-(?:regular|bold|italic|bold-italic)$`);
const FRAME_TOLERANCE = 0.01; // points

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const fail = (code, params, detail) => new PdfEditorError(code, params, detail ? { detail } : undefined);

/** Problems of a TextLayout (empty = usable by the export engine). */
export function validateLayout(layout) {
  if (!layout || typeof layout !== "object") return ["not a layout"];
  const problems = [];
  if (!finite(layout.width) || layout.width < 0) problems.push("width");
  if (!finite(layout.height) || layout.height < 0) problems.push("height");
  if (!Array.isArray(layout.lines)) {
    problems.push("lines");
  } else {
    layout.lines.forEach((line, lineIndex) => {
      if (!line || !finite(line.baseline) || !finite(line.x) || !finite(line.width) || !Array.isArray(line.runs)) {
        problems.push(`lines[${lineIndex}]`);
        return;
      }
      line.runs.forEach((run, runIndex) => {
        if (!run || typeof run.text !== "string" || !finite(run.x) || typeof run.font !== "string" || !FONT_KEY.test(run.font)) problems.push(`lines[${lineIndex}].runs[${runIndex}]`);
      });
    });
  }
  if (layout.raster !== null && layout.raster !== undefined) {
    const { raster } = layout;
    if (typeof raster !== "object" || !(raster.png instanceof Uint8Array) || !raster.png.byteLength || ![raster.x, raster.y, raster.w, raster.h].every(finite)) problems.push("raster");
  }
  if (layout.problems !== undefined && (!Array.isArray(layout.problems) || !layout.problems.every((code) => typeof code === "string"))) problems.push("problems");
  // A box that must be exported as a picture has no runs; without the picture it would be exported EMPTY.
  // (The synchronous layout of the text service has no picture: the job needs its layoutForExport.)
  else if (layout.problems?.includes("TEXT_RASTERIZED") && (layout.raster === null || layout.raster === undefined)) problems.push("raster-missing");
  return problems;
}

/** The frame of a text object brought to the laid-out size, anchored the way the store does it. */
function frameForLayout(object, layout, userUnit) {
  const { frame } = object;
  const width = object.autoWidth ? layout.width : frame.w;
  if (Math.abs(width - frame.w) <= FRAME_TOLERANCE && Math.abs(layout.height - frame.h) <= FRAME_TOLERANCE) return frame;
  const anchor = object.align === "center" ? 0.5 : object.align === "right" ? 1 : 0;
  return resizeFrame(frame, width, layout.height, [anchor, 0], userUnit);
}

function toDate(value) {
  const resolved = typeof value === "function" ? value() : value;
  const date = resolved instanceof Date ? new Date(resolved.getTime()) : new Date(resolved);
  if (Number.isNaN(date.getTime())) throw fail("MODEL_INVALID_ARGUMENT", { command: "buildExportJob", argument: "now" });
  return date;
}

/**
 * @param {object} store                         the editor store (model/store.js)
 * @param {object} [options]
 * @param {(object: object) => object | Promise<object>} [options.layoutText]  the TextLayout of a text object
 *        (required as soon as the job has a text object)
 * @param {Date | number | (() => Date | number)} [options.now]  clock of the export; the job carries it as `now`
 * @param {string[]} [options.pageIds]           only these pages (in document order): "Extract"
 * @param {object | null} [options.info]         document properties instead of those of the first source: a complete
 *        set { title?, author?, subject?, keywords?, creator? }; a key that is not given is removed ({} or null
 *        = no properties at all: the job then carries "" for every key, which the export engine reads as "remove")
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} the ExportJob
 */
export async function buildExportJob(store, { layoutText, now, pageIds, info, signal } = {}) {
  const state = store.getState();
  const invariants = validateDocument(state);
  if (invariants.length) throw fail("MODEL_INVALID_STATE", { problems: invariants }, invariants.slice(0, 5).join("; "));
  if (pageIds !== undefined && !Array.isArray(pageIds)) throw fail("MODEL_INVALID_ARGUMENT", { command: "buildExportJob", argument: "pageIds" });
  const wanted = pageIds ? new Set(pageIds) : null;
  const pages = wanted ? state.pages.filter((page) => wanted.has(page.id)) : state.pages;
  if (!pages.length) throw fail("MODEL_EMPTY_DOCUMENT");

  const sources = [];
  const seen = new Set();
  for (const page of pages) {
    if (page.kind !== "pdf" || seen.has(page.sourceId)) continue;
    seen.add(page.sourceId);
    const source = state.sources[page.sourceId];
    const bytes = store.getSourceBytes(source.id);
    // a detached buffer (handed to a worker or to pdf.js) has length 0
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength !== source.byteLength) throw fail("MODEL_SOURCE_BYTES_MISSING", { sourceId: source.id });
    const entry = { id: source.id, bytes, expectedPages: source.pageCount };
    // An encrypted file that the viewer opened without asking (only an owner password is set) must still be
    // decrypted by the writer: with the empty user password. (Measured: the writer refuses such a file
    // when no password is passed at all.)
    const password = store.getSourcePassword(source.id);
    if (typeof password === "string") entry.password = password;
    else if (source.encrypted) entry.password = "";
    // The document properties as the VIEWER read them: the writer cannot read those of an encrypted file
    // with a cross-reference stream, and falls back to these.
    const viewerInfo = pickInfo(source.info, INFO_KEYS);
    if (Object.keys(viewerInfo).length) entry.info = viewerInfo;
    sources.push(entry);
  }

  const jobPages = [];
  const objects = [];
  const marks = [];
  const assets = {};
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    jobPages.push(page.kind === "pdf"
      ? { source: page.sourceId, index: page.sourceIndex, rotate: page.rotation }
      : { blank: [page.view[2] - page.view[0], page.view[3] - page.view[1]], rotate: page.rotation });
    const list = [];
    const erase = [];
    for (const id of page.objectIds) {
      const object = state.objects[id];
      if (object.type === "redact") {
        marks.push({ pageIndex, rect: normalizeRect(object.rect), mode: "redact", color: object.color, objectId: id });
        continue;
      }
      if (object.type === "blur") {
        marks.push({ pageIndex, rect: normalizeRect(object.rect), mode: object.style, strength: object.strength, seed: object.seed, objectId: id });
        continue;
      }
      if (object.type === "text") {
        if (typeof layoutText !== "function") throw fail("MODEL_LAYOUT_MISSING", { objectId: id });
        throwIfAborted(signal);
        const layout = await layoutText(object);
        const problems = validateLayout(layout);
        if (problems.length) throw fail("MODEL_INVALID_LAYOUT", { objectId: id, problems }, problems.join(", "));
        const complete = { ...layout, raster: layout.raster ?? null, problems: layout.problems ?? [] };
        list.push({ ...object, frame: frameForLayout(object, complete, page.userUnit || 1), layout: complete });
        if (object.replaces) erase.push({ pageIndex, rect: normalizeRect(object.replaces.rect), mode: "erase", cover: object.replaces.cover, objectId: id });
        continue;
      }
      if (object.type === "image" && !assets[object.assetId]) {
        const bytes = store.getAssetBytes(object.assetId);
        if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw fail("MODEL_ASSET_BYTES_MISSING", { assetId: object.assetId });
        assets[object.assetId] = { bytes, mime: state.assets[object.assetId].mime };
      }
      list.push(object);
    }
    objects.push(list);
    marks.push(...erase); // per page: the areas to redact or blur first, then the replaced lines
  }
  throwIfAborted(signal);

  // Without an override: the properties of the first source. An override is COMPLETE: every key it does not
  // give is removed from the output. The export engine reads "" as "remove this entry"; a key that is
  // missing from job.info would make it fall back to the properties of the source ({} must strip them).
  let documentInfo;
  if (info !== undefined) documentInfo = Object.fromEntries(INFO_KEYS.map((key) => [key, typeof info?.[key] === "string" ? info[key] : ""]));
  else documentInfo = sources.length ? pickInfo(state.sources[sources[0].id].info, DOCUMENT_KEYS) : {};

  const job = { sources, pages: jobPages, objects, marks, assets, info: documentInfo, fileName: state.fileName };
  if (now !== undefined) job.now = toDate(now);
  return job;
}

/** How many marks of each mode a job has: { redact, pixelate, blur, erase, pages } (pages = pages with a redact / pixelate / blur mark). */
export function countJobMarks(job) {
  const counts = { redact: 0, pixelate: 0, blur: 0, erase: 0, pages: 0 };
  const pages = new Set();
  for (const mark of job.marks) {
    counts[mark.mode] += 1;
    if (mark.mode !== "erase") pages.add(mark.pageIndex);
  }
  counts.pages = pages.size;
  return counts;
}
