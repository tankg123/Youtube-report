// Everything the pipeline checks BEFORE an engine runs: the job (model/schema.js ExportJob), the options and
// the env. A job that fails here is a programming error of the caller (the store never builds one), so all
// of it ends in one code, PIPELINE_JOB_INVALID, with a reason and the place.
//
// The checks are the engines' own wherever they have one (checkPlan and checkObject of engine/export), so
// that the pipeline can never accept what an engine refuses later, after minutes of work.
// Nothing here changes the job: the plan that comes back holds new arrays and the job's own objects.
import { PdfEditorError, isPdfEditorError } from "../errors.js";
import { normalizeRect } from "../geometry.js";
import { checkPlan } from "../export/export.js";
import { checkObject } from "../export/index.js";
import { SEED_PATTERN, normalizeColor } from "../../model/schema.js";

export const MARK_MODES = Object.freeze(["redact", "pixelate", "blur", "erase"]);
export const ERASE_FALLBACKS = Object.freeze(["cover", "redact"]);
export const REDACT_PATHS = Object.freeze(["hybrid", "raster"]);
const STRENGTHS = Object.freeze([1, 2, 3]);

const invalid = (reason, extra = {}, detail, cause) =>
  new PdfEditorError("PIPELINE_JOB_INVALID", { reason, page: null, source: null, objectId: null, problems: null, ...extra }, { detail, cause });

const isObject = (value) => Boolean(value) && typeof value === "object";
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const hasBytes = (value) => (value instanceof Uint8Array || value instanceof ArrayBuffer) && value.byteLength > 0;
const absent = (value) => value === undefined || value === null;

/** The options of buildOutput() with their defaults. Throws PIPELINE_JOB_INVALID { reason: "option" }. */
export function validateOptions(options) {
  if (!absent(options) && !isObject(options)) throw invalid("option", { problems: ["options"] }, "options is not an object");
  const given = options || {};
  const eraseFallback = given.eraseFallback ?? "cover";
  if (!ERASE_FALLBACKS.includes(eraseFallback)) throw invalid("option", { problems: ["eraseFallback"] });
  const redactPath = given.redactPath ?? "hybrid";
  if (!REDACT_PATHS.includes(redactPath)) throw invalid("option", { problems: ["redactPath"] });
  for (const name of ["onProgress", "random"]) {
    if (!absent(given[name]) && typeof given[name] !== "function") throw invalid("option", { problems: [name] });
  }
  const rasterPages = given.rasterPages ?? [];
  if (!Array.isArray(rasterPages) || !rasterPages.every((index) => Number.isInteger(index) && index >= 0)) throw invalid("option", { problems: ["rasterPages"] });
  if (!absent(given.now) && !(given.now instanceof Date && !Number.isNaN(given.now.getTime()))) throw invalid("option", { problems: ["now"] });
  if (!absent(given.engines) && !isObject(given.engines)) throw invalid("option", { problems: ["engines"] });
  for (const [name, engine] of Object.entries(given.engines || {})) {
    if (typeof engine !== "function") throw invalid("option", { problems: [`engines.${name}`] });
  }
  return {
    signal: given.signal ?? undefined,
    onProgress: given.onProgress ?? null,
    keepOutline: given.keepOutline,
    keepForms: given.keepForms,
    keepAttachments: given.keepAttachments,
    dropOrphanBookmarks: given.dropOrphanBookmarks,
    eraseFallback,
    redactPath,
    rasterPages: [...new Set(rasterPages)].sort((first, second) => first - second),
    producer: given.producer,
    now: given.now ?? undefined,
    idSeed: given.idSeed,
    random: given.random ?? null,
    engines: given.engines || {}
  };
}

/** What every job needs from the env (the engines check the rest when they need it). Throws PIPELINE_ENV_INVALID. */
export function validateEnv(env) {
  if (!isObject(env)) throw new PdfEditorError("PIPELINE_ENV_INVALID", { missing: "env" });
  // the self-check of every output opens it with pdf.js
  if (typeof env.openPdf !== "function") throw new PdfEditorError("PIPELINE_ENV_INVALID", { missing: "openPdf" });
}

function readMark(mark, index, pageCount) {
  const bad = (field) => invalid("mark", {
    page: Number.isInteger(mark?.pageIndex) ? mark.pageIndex : null,
    objectId: typeof mark?.objectId === "string" ? mark.objectId : null,
    problems: [field]
  }, `job.marks[${index}]: ${field}`);
  if (!isObject(mark)) throw bad("shape");
  if (!Number.isInteger(mark.pageIndex) || mark.pageIndex < 0 || mark.pageIndex >= pageCount) throw bad("pageIndex");
  if (!Array.isArray(mark.rect) || mark.rect.length !== 4 || !mark.rect.every(Number.isFinite)) throw bad("rect");
  const rect = normalizeRect(mark.rect);
  if (!(rect[2] > rect[0]) || !(rect[3] > rect[1])) throw bad("rect");
  if (!MARK_MODES.includes(mark.mode)) throw bad("mode");
  const mosaic = mark.mode === "pixelate" || mark.mode === "blur";
  let color = null;
  let cover = null;
  let strength = null;
  let seed = null;
  if (mark.mode === "redact" && !absent(mark.color)) {
    color = normalizeColor(mark.color);
    if (!color) throw bad("color");
  }
  if (mark.mode === "erase" && !absent(mark.cover)) {
    cover = normalizeColor(mark.cover);
    if (!cover) throw bad("cover");
  }
  if (mosaic && !absent(mark.strength)) {
    if (!STRENGTHS.includes(mark.strength)) throw bad("strength");
    strength = mark.strength;
  }
  if (mosaic && !absent(mark.seed)) {
    // the seed decides the mosaic: a malformed one must not silently become "random each time"
    if (typeof mark.seed !== "string" || !SEED_PATTERN.test(mark.seed)) throw bad("seed");
    seed = mark.seed;
  }
  if (!absent(mark.objectId) && (typeof mark.objectId !== "string" || !mark.objectId)) throw bad("objectId");
  return { index, pageIndex: mark.pageIndex, rect, mode: mark.mode, color, cover, strength, seed, objectId: mark.objectId ?? null };
}

/**
 * Checks an ExportJob and returns what the pipeline works with:
 *   { pageCount,
 *     objects: object[][]           one list per output page (the job's own lists; [] where the job has none)
 *     marks: [{ index, pageIndex, rect (normalised copy), mode, color, cover, strength, seed, objectId }]
 *     hasObjects: boolean,
 *     rasterizedTextObjectIds: string[]   text objects whose layout carries a picture }
 * Throws PIPELINE_JOB_INVALID (see codes.js for the reasons).
 */
export function validateJob(job) {
  if (!isObject(job)) throw invalid("shape", {}, "the job is not an object");

  // sources and pages: the export engine's own structural check
  let used;
  try {
    used = checkPlan({ sources: job.sources, pages: job.pages });
  } catch (error) {
    if (isPdfEditorError(error) && error.code === "EXPORT_JOB_INVALID") {
      throw invalid(error.params.reason, { page: error.params.page ?? null, source: error.params.source ?? null }, "sources / pages", error);
    }
    throw error;
  }
  for (const source of job.sources) {
    // (a buffer that was transferred to a worker or to pdf.js has length 0)
    if (used.has(source.id) && !(source.bytes instanceof Uint8Array && source.bytes.byteLength > 0)) throw invalid("source-bytes", { source: source.id });
  }
  const pageCount = job.pages.length;
  if (!absent(job.now) && !(job.now instanceof Date && !Number.isNaN(job.now.getTime()))) throw invalid("shape", {}, "job.now is not a date");

  // objects: one list per page, every object through the checks of the engine that will draw it
  if (!absent(job.objects) && (!Array.isArray(job.objects) || job.objects.length !== pageCount)) throw invalid("shape", {}, "job.objects needs one entry per page");
  if (!absent(job.assets) && !isObject(job.assets)) throw invalid("shape", {}, "job.assets is not an object");
  const assets = job.assets || {};
  const objects = [];
  const rasterizedTextObjectIds = [];
  let hasObjects = false;
  for (let page = 0; page < pageCount; page += 1) {
    const list = absent(job.objects) ? null : job.objects[page];
    if (absent(list)) {
      objects.push([]);
      continue;
    }
    if (!Array.isArray(list)) throw invalid("shape", { page }, "the objects of a page are not an array");
    for (const object of list) {
      try {
        checkObject(object);
      } catch (error) {
        if (!isPdfEditorError(error)) throw error;
        const objectId = typeof error.params?.objectId === "string" ? error.params.objectId : null;
        if (error.code === "EXPORT_TEXT_LAYOUT_MISSING") throw invalid("layout", { page, objectId }, "a text object without a usable layout", error);
        if (error.code === "EXPORT_OBJECT_INVALID") {
          throw invalid("object", { page, objectId, problems: Array.isArray(error.params.problems) ? error.params.problems.map(String) : null }, "an object fails checkObject()", error);
        }
        throw error;
      }
      if (object.type === "image" && !(hasOwn(assets, object.assetId) && hasBytes(assets[object.assetId]?.bytes))) {
        throw invalid("asset", { page, objectId: object.id, problems: [String(object.assetId)] }, "an image without its asset");
      }
      if (object.type === "text" && object.layout.raster) rasterizedTextObjectIds.push(object.id);
      hasObjects = true;
    }
    objects.push(list);
  }

  // marks
  if (!absent(job.marks) && !Array.isArray(job.marks)) throw invalid("shape", {}, "job.marks is not an array");
  const marks = (job.marks || []).map((mark, index) => readMark(mark, index, pageCount));

  return { pageCount, objects, marks, hasObjects, rasterizedTextObjectIds };
}

/** options.rasterPages against the pages of the job. Throws PIPELINE_JOB_INVALID { reason: "option" }. */
export function validateRasterPages(rasterPages, pageCount) {
  const outside = rasterPages.find((index) => index >= pageCount);
  if (outside !== undefined) throw invalid("option", { page: outside, problems: ["rasterPages"] }, "rasterPages names a page the job does not have");
}
