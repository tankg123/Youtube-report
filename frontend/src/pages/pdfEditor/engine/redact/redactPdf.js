// The orchestration of a redaction:
//
//   read the original with pdf.js  ->  precise removal per page  ->  what the fonts still hold of the removed
//   text  ->  verification of the unpainted candidate  ->  raster fallback for the pages that failed  ->  boxes
//   and mosaics  ->  FINAL VERIFICATION of the bytes, of EVERY page of the document
//
//   const { bytes, report } = await redactPdf(pdfBytes, targets, env)
//
// It never returns bytes that did not pass the final verification: it throws
// PdfEditorError("REDACT_VERIFICATION_FAILED") with the report attached (error.report) instead.
//
// How a page is decided (a "plan" per page that has targets, or that env.rasterPages names):
//   1. Dry runs of the remover (textRemoval.js) tell whether the page can be edited at all. A page with a
//      strict target ("redact" / "pixelate" / "blur") that cannot becomes a picture. An "erase" target never
//      sends a page to the raster path: when it is the erase target that stands in the way, it is dropped
//      from the plan (outcome "cover-needed") and the rest of the page is handled without it.
//   2. The precise edits are applied, the fonts are cleaned (fontCleanup.js: glyphs, widths and ToUnicode
//      mappings that only the removed text used), and the UNPAINTED candidate is saved and read back with
//      pdf.js: no glyph may be left under a mark, no glyph elsewhere may have moved or lost its font, and the
//      region under a strict mark must be blank paper (G4). A strict page that fails becomes a picture; erase
//      targets that fail are dropped and the candidate is built again (at most a few rounds: every round only
//      removes erase targets or sends pages to the raster path).
//   3. The final document is built from the plans (from a fresh load of the original whenever a plan
//      changed after its edits had been applied), boxes and mosaics are painted, the words of the structure
//      tree that repeat the removed text are deleted, unreachable objects are swept, and the bytes that will
//      be returned are verified once more as a whole: the pages with marks by their checks, EVERY OTHER PAGE
//      by comparing what pdf.js draws from the output with what it drew from the input.
//   4. Copies of the removed text that no mark reaches (bookmarks, document properties, field names,
//      attachments ...) are counted and reported as REDACT_TEXT_ELSEWHERE warnings.
//
// Two things can send the whole job back to step 1 (each at most once):
//   - a font that pdf.js could use before does not load after the clean-up: the job is built again without
//     touching the fonts, and every font that would have been cleaned is reported (REDACT_FONT_GLYPHS_REMAIN);
//   - a page without marks comes out differently from how it went in: the PDF library and pdf.js read this
//     file in different ways (a damaged or doctored file). The library's reading cannot be trusted, so the
//     document is treated like one it cannot load: every page becomes a picture (strict targets), or nothing
//     is changed at all (only erase targets: they all end "cover-needed").
//
// MOSAICS ("pixelate", "blur") are made of a render of the ORIGINAL page: of the mark together with the glyphs
// it takes (under(): a glyph goes as a whole), shown inside the mark. The noise and the grid offset come from
// the seed of the mark (targets[].seed: a key stream computed before any pixel is touched), so every export
// shows the same picture. A mark without a seed gets the random source of the job, and the report says so
// (REDACT_MOSAIC_NOT_SEEDED): several exports of such a mark can be averaged. The measurements are in blur.js.
//
// WHAT THE LIBRARY READS. It ignores an indirect /Length and looks for "endstream" itself, which drops a data
// byte 0x0D in front of the end of a stream and runs on over the word "stream" inside the data. After every
// load the streams with an indirect length are compared with the file and given their declared bytes again
// (repairStreamLengths). An encrypted file cannot be repaired here (the bytes in the file are ciphertext):
// when one of its streams was read with another length, the document counts as not editable.
//
// Everything of the platform comes in through `env` (index.js documents it); the module is DOM-free.
import { fontkit, pdfLib } from "../lib.js";
import { PdfEditorError, isPdfEditorError, throwIfAborted } from "../errors.js";
import { removeTextInRects } from "./textRemoval.js";
import {
  collectGarbage, countEmbeddedFiles, detachPageFromStructTree, findTextElsewhere, releaseOrphanedObjects, removeAnnotations, stripPageExtras,
  stripStructAttributes, stripStructureWords
} from "./documentScrub.js";
import { pageResources, pruneResources } from "./resourceUsage.js";
import { VERIFY_DEFAULTS, checkRegions, compareUntouchedPage, removedText, renderForCheck, snapshotPage, verifyPageText, verifyRasterPage } from "./verifyRedaction.js";
import {
  RASTER_DEFAULTS, buildTextLayer, burnRegions, imageXObjectFromCanvas, imageXObjectFromRgba, makeTtfLayerFont, rectToPixels, renderPageBitmap,
  replacePageWithPicture, solidMarksContent
} from "./rasterizePage.js";
import { BLUR_DEFAULTS, cropRegion, cryptoRandom, isSeed, keyStreamReader, mosaicDraws, mosaicKeyStream, obscureRegion } from "./blur.js";
import { cleanFonts, fontNamesIn, usedBy } from "./fontCleanup.js";
import { formatNumber } from "./contentStream.js";
import { A, GLYPH_RULE, glyphInTargets, normRect } from "./pdfAccess.js";
import { pageGlyphs, resolvePdfjs } from "./pdfjsGlyphs.js";
import { PROGRESS_STAGES, fallbackReason, reason } from "./codes.js";

const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, ParseSpeeds, degrees } = pdfLib;

const MODES = Object.freeze(["redact", "pixelate", "blur", "erase"]);
const PATHS = Object.freeze(["hybrid", "precise", "raster"]);
/** The bundled face of the invisible text layer of a rasterised page (public/pdf-fonts/manifest.json). */
export const LAYER_FONT_KEY = "arimo-regular";
/**
 * Candidate rounds. Three are ever needed for a page (1: everything; 2: without the erase targets the leftover
 * glyphs pointed at; 3: without any erase target), because every round only drops erase targets or sends
 * pages to the raster path. The limit is a guard against a remover that is not deterministic.
 */
const MAX_ROUNDS = 5;
/** Whole builds of a job: the first, one without the clean-up of fonts, one from pictures only. */
const MAX_ATTEMPTS = 3;
const SAVE_OPTIONS = Object.freeze({ addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: Number.MAX_SAFE_INTEGER });
/** Where each stage of PROGRESS_STAGES starts on the 0..1 scale of env.onProgress (the last value is the end). */
const STAGE_BOUNDS = Object.freeze([0, 0.15, 0.35, 0.55, 0.8, 1]);

const num = (v) => formatNumber(v, 3);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const isStrict = (entry) => entry.mode !== "erase";
const isMosaic = (entry) => entry.mode === "pixelate" || entry.mode === "blur";
const rectsOf = (entries) => entries.map((entry) => entry.rect);

function fail(code, params, options) {
  throw new PdfEditorError(code, params, options);
}

/** "#rrggbb" or "#rgb" in any case -> [r, g, b] (0..255), null when it is not a colour. */
function parseColor(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const long = /^#[0-9a-f]{3}$/.test(text) ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}` : text;
  if (!/^#[0-9a-f]{6}$/.test(long)) return null;
  return [1, 3, 5].map((offset) => parseInt(long.slice(offset, offset + 2), 16));
}

function configure(env) {
  if (!env || typeof env !== "object") fail("REDACT_ENV_INVALID", { missing: "env" });
  for (const key of ["openPdf", "createCanvas"]) if (typeof env[key] !== "function") fail("REDACT_ENV_INVALID", { missing: key });
  const textLayer = env.textLayer !== false;
  if (textLayer && typeof env.fonts !== "function") fail("REDACT_ENV_INVALID", { missing: "fonts" });
  const path = env.path ?? "hybrid";
  if (!PATHS.includes(path)) fail("REDACT_ENV_INVALID", { missing: "path" });
  const rasterPages = env.rasterPages ?? [];
  if (!Array.isArray(rasterPages) || !rasterPages.every((p) => Number.isInteger(p) && p >= 0)) fail("REDACT_ENV_INVALID", { missing: "rasterPages" });
  let random = typeof env.random === "function" ? env.random : null;
  return {
    env,
    pdfjs: resolvePdfjs(env.pdfjs),
    path,
    rasterPages: [...new Set(rasterPages)].sort((a, b) => a - b),
    paint: env.paint !== false,
    thresholds: env.thresholds,
    dpi: env.dpi ?? RASTER_DEFAULTS.dpi,
    maxPixels: env.maxPixels ?? RASTER_DEFAULTS.maxPixels,
    imageFormat: env.imageFormat ?? RASTER_DEFAULTS.format,
    jpegQuality: env.jpegQuality ?? RASTER_DEFAULTS.jpegQuality,
    patchDpi: env.patchDpi ?? 150,
    verify: { ...VERIFY_DEFAULTS, ...(env.verify || {}) },
    textLayer,
    fontCleanup: env.fontCleanup !== false,
    verifyOtherPages: env.verifyOtherPages !== false,
    password: env.password,
    saveOptions: { ...SAVE_OPTIONS, ...(env.saveOptions || {}) },
    signal: env.signal,
    createCanvas: env.createCanvas,
    encodeJpeg: typeof env.encodeJpeg === "function" ? env.encodeJpeg : null,
    closePdf: typeof env.closePdf === "function" ? env.closePdf : async (doc) => {
      await doc?.destroy?.();
    },
    /** the noise source of the mosaics without a seed: made on first use, so that a job without one needs no CSPRNG */
    random: () => {
      random ||= cryptoRandom();
      return random();
    },
    progress: (stageIndex, share) => {
      if (typeof env.onProgress !== "function") return;
      const fraction = STAGE_BOUNDS[stageIndex] + (STAGE_BOUNDS[stageIndex + 1] - STAGE_BOUNDS[stageIndex]) * Math.min(1, Math.max(0, share));
      env.onProgress(Math.round(fraction * 1000) / 1000, PROGRESS_STAGES[stageIndex]);
    },
    fontCache: new Map()
  };
}

/** Validates the targets and returns them as entries: { index, pageIndex, rect, mode, color, strength, seed }. */
function readTargets(targets) {
  if (!Array.isArray(targets)) fail("REDACT_BAD_TARGET", { index: -1, problem: "shape" });
  return targets.map((target, index) => {
    const bad = (problem) => fail("REDACT_BAD_TARGET", { index, problem });
    if (!target || typeof target !== "object") bad("shape");
    if (!Number.isInteger(target.pageIndex) || target.pageIndex < 0) bad("pageIndex");
    if (!Array.isArray(target.rect) || target.rect.length !== 4 || !target.rect.every(Number.isFinite)) bad("rect");
    const rect = normRect(target.rect);
    if (!(rect[2] > rect[0]) || !(rect[3] > rect[1])) bad("rect");
    const mode = target.mode ?? "redact";
    if (!MODES.includes(mode)) bad("mode");
    // redact: the colour of the box; erase: the cover colour, used only where the page becomes a picture
    let color = mode === "redact" ? RASTER_DEFAULTS.fill.slice() : null;
    if (target.color !== undefined && target.color !== null) {
      color = parseColor(target.color);
      if (!color) bad("color");
    }
    const strength = target.strength ?? 1;
    if (!BLUR_DEFAULTS.strengths.includes(strength)) bad("strength");
    // the seed of a blur / pixelate mark (refused in every mode when it is not one; used by the mosaics only)
    let seed = null;
    if (target.seed !== undefined && target.seed !== null) {
      if (!isSeed(target.seed)) bad("seed");
      seed = target.seed.toLowerCase();
    }
    return { index, pageIndex: target.pageIndex, rect, mode, color: mode === "redact" || mode === "erase" ? color : null, strength, seed };
  });
}

const newPlan = (pageIndex) => ({ pageIndex, strict: [], erase: [], allErase: [], dropped: [], mode: "precise", forced: false, reasons: [], precise: null, raster: null, fills: new Map() });

function makePlans(entries) {
  const plans = new Map();
  for (const entry of entries) {
    if (!plans.has(entry.pageIndex)) plans.set(entry.pageIndex, newPlan(entry.pageIndex));
    const plan = plans.get(entry.pageIndex);
    if (isStrict(entry)) plan.strict.push(entry);
    else {
      plan.erase.push(entry);
      plan.allErase.push(entry);
    }
  }
  return plans;
}

/** The page becomes a picture: every erase target of the page is then satisfied by the picture. */
function toRaster(plan, why) {
  plan.mode = "raster";
  plan.reasons = [why];
  plan.erase = plan.allErase.slice();
  plan.dropped = [];
  plan.precise = null;
}

function dropErase(plan, entries, why) {
  for (const entry of entries) plan.dropped.push({ entry, reason: why });
  plan.erase = plan.erase.filter((entry) => !entries.includes(entry));
  if (!plan.strict.length && !plan.erase.length) {
    plan.mode = "untouched";
    const seen = new Set();
    plan.reasons = plan.dropped.map((d) => d.reason).filter((r) => !seen.has(r.code) && seen.add(r.code));
  }
}

function attempt(doc, plan, strict, erase, cfg, dryRun) {
  return removeTextInRects(doc, plan.pageIndex, rectsOf(strict), {
    eraseRects: rectsOf(erase),
    thresholds: cfg.thresholds,
    // content that will be drawn over is wrapped in q ... Q first
    normalize: cfg.paint && strict.length > 0,
    fontCache: cfg.fontCache,
    dryRun
  });
}

/**
 * The precise path for one page of `doc`, in place: glyphs, then everything around them. The dry run in
 * settlePrecise() said that it works; the remover is deterministic, so it works here as well.
 */
function applyPrecise(doc, plan, cfg) {
  const p = plan.pageIndex;
  const resourcesBefore = pageResources(doc, p);
  const rep = attempt(doc, plan, plan.strict, plan.erase, cfg, false);
  // (the reason token only: its message may quote a token of the content stream, which is document content)
  if (rep.status !== "ok") fail("REDACT_VERIFICATION_FAILED", { page: p + 1, check: "not-repeatable" }, { detail: rep.reason.code });
  const strictRects = rectsOf(plan.strict);
  rep.annotations = strictRects.length ? removeAnnotations(doc, p, { rects: strictRects }) : { removed: [], fieldsRemoved: [], fieldsCleared: [], fieldsKept: [], xfaRemoved: false };
  rep.pageExtrasRemoved = stripPageExtras(doc, p);
  // the words the structure tree holds for marked content that lost a glyph. An id belongs to the page content
  // ("page:<mcid>") or to a Form XObject, named by its /StructParents ("form:<key>:<mcid>") or, without one, by
  // its object ("form <num gen>:<mcid>")
  const removedStrings = cfg.removedBy(plan);
  const pageMcids = [];
  const formsByKey = new Map();
  const formsById = new Map();
  const add = (map, key, mcid) => map.set(key, [...(map.get(key) || []), mcid]);
  for (const key of rep.touchedMcids) {
    const at = key.lastIndexOf(":");
    const owner = key.slice(0, at);
    const mcid = Number(key.slice(at + 1));
    if (owner === "page") pageMcids.push(mcid);
    else if (owner.startsWith("form:")) add(formsByKey, Number(owner.slice(5)), mcid);
    else if (owner.startsWith("form ")) add(formsById, owner.slice(5), mcid);
  }
  rep.structAttributesStripped = pageMcids.length ? stripStructAttributes(doc, p, pageMcids, { removedStrings }) : 0;
  for (const [structParents, mcids] of formsByKey) rep.structAttributesStripped += stripStructAttributes(doc, p, mcids, { structParents, removedStrings });
  for (const [stm, mcids] of formsById) rep.structAttributesStripped += stripStructAttributes(doc, p, mcids, { stm, removedStrings });
  // what the page no longer draws must not stay reachable through its (possibly shared) resources, nor
  // through the private resources of the forms that were rewritten for it ...
  const pruned = rep.changed ? pruneResources(doc, [resourcesBefore, pageResources(doc, p), ...rep.clonedResources]) : { deleted: [], skipped: [] };
  // ... nor through the structure tree
  const replacements = new Map();
  for (const form of rep.replacedForms) if (form.original?.objectNumber !== undefined) replacements.set(`${form.original.objectNumber} ${form.original.generationNumber}`, form.clone);
  rep.orphansReleased = releaseOrphanedObjects(doc, pruned.deleted.map((d) => d.value), { replacements });
  rep.resourcesPruned = pruned.deleted.length;
  plan.precise = rep;
}

/**
 * Decides with dry runs what the precise path can do for the page, then does it. A strict target that cannot
 * be handled sends the page to the raster path; an erase target that cannot is dropped ("cover-needed").
 */
function settlePrecise(doc, plan, cfg) {
  const p = plan.pageIndex;
  let rep = attempt(doc, plan, plan.strict, plan.erase, cfg, true);
  if (rep.status !== "ok") {
    if (plan.strict.length) {
      const alone = plan.erase.length ? attempt(doc, plan, plan.strict, [], cfg, true) : rep;
      if (alone.status !== "ok") return toRaster(plan, fallbackReason(alone.reason, p));
    }
    for (const entry of plan.erase.slice()) {
      const one = attempt(doc, plan, plan.strict, [entry], cfg, true);
      if (one.status !== "ok") dropErase(plan, [entry], fallbackReason(one.reason, p));
    }
    if (plan.mode !== "precise") return undefined;
    rep = attempt(doc, plan, plan.strict, plan.erase, cfg, true);
    // each of them passed alone: together they pass too. Should that ever not hold, they all need a cover
    if (rep.status !== "ok") dropErase(plan, plan.erase.slice(), fallbackReason(rep.reason, p));
    if (plan.mode !== "precise") return undefined;
  }
  applyPrecise(doc, plan, cfg);
  return undefined;
}

/** Page resources as a private copy on the page (never edit a dictionary other pages may share). */
function ownResources(pdfDoc, pageNode) {
  const context = pdfDoc.context;
  let node = pageNode;
  let res;
  for (let guard = 0; node && guard < 64; guard++) {
    res = A.get(node, "Resources");
    if (A.isDict(res)) break;
    node = A.resolve(context, A.getRaw(node, "Parent"));
    if (!A.isDict(node)) break;
  }
  const copy = A.isDict(res) ? res.clone(context) : context.obj({});
  pageNode.set(A.N("Resources"), copy);
  return copy;
}

/** Appends a content stream to a page whose content is already isolated in q ... Q. */
function appendContent(pdfDoc, pageNode, text) {
  const context = pdfDoc.context;
  const ref = context.register(context.flateStream(text));
  const contents = A.getRaw(pageNode, "Contents");
  const resolved = A.resolve(context, contents);
  const arr = context.obj([]);
  if (A.isArray(resolved)) for (let i = 0; i < resolved.size(); i++) arr.push(resolved.get(i));
  else if (contents !== undefined) arr.push(contents);
  arr.push(ref);
  pageNode.set(A.N("Contents"), arr);
}

/** Draws the boxes / mosaics over a page that went through the precise path. Returns the number of marks painted. */
async function paintPage(doc, plan, cfg, originals) {
  const pageNode = doc.getPage(plan.pageIndex).node;
  const ops = [];
  let resources = null;
  let patchCount = 0;
  // mosaics first, solid boxes on top of them: where a box and a mosaic overlap the box wins
  const ordered = [...plan.strict.filter((e) => e.mode !== "redact"), ...plan.strict.filter((e) => e.mode === "redact")];
  for (const entry of ordered) {
    const [x0, y0, x1, y1] = entry.rect;
    if (entry.mode === "redact") {
      const c = entry.color.map((v) => num(v / 255));
      ops.push(`q ${c[0]} ${c[1]} ${c[2]} rg ${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re f Q`);
      continue;
    }
    const render = await originals.patchRender(plan.pageIndex);
    const [px, py, pw, ph] = rectToPixels(render.viewport, entry.rect, render.width, render.height, 0);
    if (!pw || !ph) continue;
    // the mosaic is made of the mark together with the text it takes (originals.under) and shown inside the mark
    const under = originals.under(entry);
    const [sx, sy, sw, sh] = rectToPixels(render.viewport, under.extent, render.width, render.height, 0);
    const source = render.ctx.getImageData(sx, sy, sw, sh);
    obscureRegion(source, 0, 0, sw, sh, {
      style: entry.mode, pxPerPt: render.dpi / 72, strength: entry.strength, random: originals.noiseOf(entry), sideways: originals.sideways(plan.pageIndex), emPt: under.emPt
    });
    const image = cropRegion(source, px - sx, py - sy, pw, ph);
    const { ref } = imageXObjectFromRgba(doc, image);
    resources ??= ownResources(doc, pageNode);
    const old = A.get(resources, "XObject");
    const xobjects = A.isDict(old) ? old.clone(doc.context) : doc.context.obj({});
    let name;
    do {
      name = `RPatch${patchCount++}`;
    } while (xobjects.has(A.N(name)));
    xobjects.set(A.N(name), ref);
    resources.set(A.N("XObject"), xobjects);
    ops.push(`q ${num(x1 - x0)} 0 0 ${num(y1 - y0)} ${num(x0)} ${num(y0)} cm /${name} Do Q`);
  }
  if (ops.length) appendContent(doc, pageNode, `${ops.join("\n")}\n`);
  return ops.length;
}

/** The raster path for one page of `doc` (in place). */
async function rasterPage(doc, plan, entries, pagePjs, before, cfg, layerFont, originals) {
  const p = plan.pageIndex;
  const render = await originals.fromInput(() => renderPageBitmap(pagePjs, cfg.pdfjs, cfg.createCanvas, { dpi: cfg.dpi, maxPixels: cfg.maxPixels, annotations: true }));
  // (a mark with a seed brings its own noise; the text a mosaic takes sets its block and the area it is made of)
  const regions = entries.map((entry) => (isMosaic(entry) ? { ...entry, rect: entry.rect, random: originals.noiseOf(entry), emPt: originals.under(entry).emPt, source: originals.under(entry).extent } : entry));
  const burned = burnRegions(render, regions, { random: cfg.random, sideways: pagePjs.rotate % 180 !== 0 });
  for (const done of burned) {
    if (done.mode !== "erase") continue;
    const entry = entries.find((e) => e.mode === "erase" && e.rect === done.rect);
    if (entry) plan.fills.set(entry, done.color);
  }
  const image = await imageXObjectFromCanvas(doc, render.canvas, { format: cfg.imageFormat, quality: cfg.jpegQuality, encodeJpeg: cfg.encodeJpeg });
  let layer = { content: "", stats: null };
  if (layerFont) layer = buildTextLayer(before.glyphs, rectsOf(entries), layerFont, { thresholds: cfg.thresholds });
  const annotations = removeAnnotations(doc, p, { rects: rectsOf(entries.filter(isStrict)), all: true });
  const structure = detachPageFromStructTree(doc, p, { removedStrings: cfg.removedBy(plan) });
  const resourcesBefore = pageResources(doc, p);
  replacePageWithPicture(doc, p, { imageRef: image.ref, view: pagePjs.view, marks: solidMarksContent(burned), layer: layer.content, layerFont });
  const pageExtrasRemoved = stripPageExtras(doc, p, { raster: true });
  // the old resources may be shared with other pages: entries that only this page used are released
  const pruned = pruneResources(doc, [resourcesBefore]);
  const orphansReleased = releaseOrphanedObjects(doc, pruned.deleted.map((d) => d.value));
  plan.raster = {
    dpi: Math.round(render.dpi), pixels: [render.width, render.height], imageBytes: image.byteLength, imageFormat: image.format, burned: burned.length,
    layer: layer.stats, annotations, structure, pageExtrasRemoved, resourcesPruned: pruned.deleted.length, orphansReleased
  };
}

/**
 * What the pixels of each target region must look like, in the order the marks are painted (a mark painted
 * later may cover a part of an earlier one: those parts are ignored for the earlier one).
 */
function regionExpectations(plan, cfg, stage) {
  const raster = plan.mode === "raster";
  const painted = stage === "final" && (raster || cfg.paint);
  const mosaics = plan.strict.filter((e) => e.mode !== "redact");
  const boxes = plan.strict.filter((e) => e.mode === "redact");
  // erase paints only on a picture, between the mosaics and the boxes
  const order = [...mosaics, ...(raster ? plan.erase : []), ...boxes];
  const laterThan = (entry) => rectsOf(order.slice(order.indexOf(entry) + 1));
  const regions = [];
  for (const entry of [...plan.strict, ...plan.erase]) {
    if (entry.mode === "erase") {
      if (raster && painted) regions.push({ entry, rect: entry.rect, expect: "painted", color: plan.fills.get(entry) ?? entry.color ?? undefined, ignore: laterThan(entry) });
      else regions.push({ entry, rect: entry.rect, expect: "any" });
    } else if (!painted) regions.push({ entry, rect: entry.rect, expect: "blank" });
    else if (entry.mode === "redact") regions.push({ entry, rect: entry.rect, expect: "painted", color: entry.color, ignore: laterThan(entry) });
    else regions.push({ entry, rect: entry.rect, expect: "obscured", ignore: laterThan(entry) });
  }
  return regions;
}

const CHECK_OF_EXPECTATION = Object.freeze({ blank: "G4-blank", painted: "G4-painted", obscured: "G4-obscured" });

/** The public reason for a failed text check of the verifier (candidate stage). */
function verifyReason(v, pageIndex) {
  const first = v.failures[0];
  const page = pageIndex + 1;
  if (first.check === "G1-removal") return reason("REDACT_GLYPHS_REMAIN", { page, count: v.stats.remainingInTargets });
  if (first.check === "G2-preservation") return reason("REDACT_TEXT_DISTURBED", { page, lost: v.stats.lost ?? 0, added: v.stats.added ?? 0 });
  return reason("REDACT_STRING_REMAINS", { page, count: first.count ?? 1 });
}

function summarizeRegions(result) {
  return result.regions.map(({ rect, expect, ok, pixels, outliers, dominant, range, detail, originalDetail, limit, note }) => ({ rect, expect, ok, pixels, outliers, dominant, range, detail, originalDetail, limit, note }));
}

// ---------------------------------------------------------------- what the library read of the streams
const latin1 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return text;
};

/** Where the library's own search for the end of a stream stops (PDFObjectParser.findEndOfStreamFallback of the pinned version). */
function libraryStreamEnd(text, start) {
  let nesting = 1;
  let at = start;
  while (at < text.length) {
    const here = at;
    if (text.startsWith("stream", at)) {
      nesting += 1;
      at += 6;
    } else if (text.startsWith("\r\nendstream", at)) {
      nesting -= 1;
      at += 11;
    } else if (text.startsWith("\rendstream", at) || text.startsWith("\nendstream", at)) {
      nesting -= 1;
      at += 10;
    } else if (text.startsWith("endstream", at)) {
      nesting -= 1;
      at += 9;
    } else at += 1;
    if (nesting === 0) return here;
  }
  return -1;
}

/**
 * The library ignores an indirect /Length and looks for "endstream" itself. Where it read another number of
 * bytes than the file declares, the declared bytes are taken from the input again: the object is found by its
 * header, "endstream" must follow the declared bytes, and what the library read must be their beginning.
 * Returns { repaired, unresolved }: unresolved counts streams of an ENCRYPTED input that were read with
 * another length (their bytes in the file are ciphertext: nothing can be given back to the library).
 */
function repairStreamLengths(loaded, original) {
  const context = loaded.context;
  const encrypted = context.isDecrypted === true;
  const lengthKey = PDFName.of("Length");
  let text = null;
  let repaired = 0;
  let unresolved = 0;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const raw = object.dict.get(lengthKey);
    if (!(raw instanceof PDFRef)) continue;
    const declared = context.lookup(raw);
    const wanted = declared instanceof PDFNumber ? declared.asNumber() : NaN;
    if (!Number.isInteger(wanted) || wanted < 0) continue;
    const have = object.contents.length;
    if (!encrypted && wanted === have) continue;
    text ??= latin1(original);
    const header = new RegExp(`(?:^|[^0-9])${ref.objectNumber}\\s+${ref.generationNumber}\\s+obj`, "g");
    for (let m = header.exec(text); m; m = header.exec(text)) {
      const keyword = text.indexOf("stream", m.index);
      if (keyword < 0 || keyword - m.index > 65536) continue;
      // the data starts where the library starts it: after "stream" and one end-of-line
      let start = keyword + 6;
      if (text.startsWith(" \r\n", start)) start += 3;
      else if (text.startsWith("\r\n", start)) start += 2;
      else if (text[start] === "\r" || text[start] === "\n") start += 1;
      if (start + wanted > original.length) continue;
      // (the declared length is only believed when the stream really ends there)
      if (!/^[\r\n]{0,2}endstream/.test(text.substr(start + wanted, 12))) continue;
      if (encrypted) {
        if (libraryStreamEnd(text, start) - start !== wanted) unresolved++;
        break;
      }
      let same = true;
      for (let i = Math.min(have, wanted) - 1; i >= 0 && same; i--) same = original[start + i] === object.contents[i];
      if (!same) continue; // another definition of the object than the one the library kept
      context.assign(ref, PDFRawStream.of(object.dict, original.slice(start, start + wanted)));
      repaired++;
      break;
    }
  }
  return { repaired, unresolved };
}

/**
 * Removes what lies under the targets from a PDF and returns the new bytes with a report.
 * See index.js for the full description of targets, env and the report.
 */
export async function redactPdf(pdfBytes, targets, env) {
  const cfg = configure(env);
  if (!(pdfBytes instanceof Uint8Array) && !(pdfBytes instanceof ArrayBuffer)) fail("REDACT_INPUT_UNREADABLE", { reason: "invalid" });
  const original = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const entries = readTargets(targets);
  const report = { pages: [], targets: [], warnings: [], fontsCleaned: [], fontsNotCleaned: [], timings: {}, inputBytes: original.length, outputBytes: original.length };
  const t0 = now();
  if (!entries.length && !cfg.rasterPages.length) {
    report.timings.total = 0;
    return { bytes: original, report };
  }
  let plans = makePlans(entries);
  const { pdfjs } = cfg;
  const open = [];
  // pdf.js takes ownership of the buffer it is given: it always gets a private copy
  // (new Uint8Array(view) copies; view.slice() would not, for a Node Buffer)
  const openPdf = async (bytes, options) => {
    const doc = await cfg.env.openPdf(new Uint8Array(bytes), options);
    open.push(doc);
    return doc;
  };
  const closePdf = async (doc) => {
    const at = open.indexOf(doc);
    if (at >= 0) open.splice(at, 1);
    try {
      await cfg.closePdf(doc);
    } catch {
      /* already closed */
    }
  };
  /** What pdf.js cannot read of the INPUT is an unreadable input, never an error of pdf.js for the caller. */
  const fromInput = async (work) => {
    try {
      return await work();
    } catch (error) {
      if (isPdfEditorError(error)) throw error;
      throw new PdfEditorError("REDACT_INPUT_UNREADABLE", { reason: "invalid" }, { cause: error });
    }
  };

  try {
    // ---- 1. the original, as pdf.js sees it
    throwIfAborted(cfg.signal);
    cfg.progress(0, 0);
    let pjsIn;
    try {
      pjsIn = await openPdf(original, { password: cfg.password });
    } catch (error) {
      if (isPdfEditorError(error)) throw error;
      fail("REDACT_INPUT_UNREADABLE", { reason: error?.name === "PasswordException" ? "password" : "invalid" }, { cause: error });
    }
    const pageCount = pjsIn.numPages;
    for (const entry of entries) if (entry.pageIndex >= pageCount) fail("REDACT_BAD_TARGET", { index: entry.index, problem: "page-out-of-range" });
    // pages the caller wants as pictures whatever their marks say (to get rid of a font that could not be cleaned)
    for (const p of cfg.rasterPages) {
      if (p >= pageCount) fail("REDACT_ENV_INVALID", { missing: "rasterPages" });
      if (!plans.has(p)) plans.set(p, newPlan(p));
      toRaster(plans.get(p), reason("REDACT_RASTER_FORCED", { page: p + 1 }));
      plans.get(p).forced = true;
    }
    plans = new Map([...plans].sort((a, b) => a[0] - b[0]));
    const pagesIn = new Map();
    const before = new Map();
    const readPage = (p) => fromInput(async () => {
      if (!pagesIn.has(p)) pagesIn.set(p, await pjsIn.getPage(p + 1));
      if (!before.has(p)) before.set(p, await snapshotPage(pagesIn.get(p), pdfjs));
      return pagesIn.get(p);
    });
    let read = 0;
    for (const p of plans.keys()) {
      throwIfAborted(cfg.signal);
      await readPage(p);
      cfg.progress(0, ++read / plans.size);
    }
    const removeRule = { ...GLYPH_RULE.remove, ...(cfg.thresholds || {}) };
    /**
     * The text a mosaic mark takes, as pdf.js reads the page: { emPt: its largest font size in points (0: no
     * text, a scan or a picture), extent: the rectangle of the mark grown to the boxes of the glyphs it takes }.
     * A glyph goes as a whole, so the mosaic is made of the whole glyphs as well and SHOWN inside the mark: a
     * thin mark through a line then shows a part of the mosaic of the line. The mosaic of the stripe alone
     * would be an average over the densest part of the glyphs and tell more of them (measured: blur.js).
     */
    const under = (entry) => {
      if (!entry.under) {
        const snapshot = before.get(entry.pageIndex);
        const extent = [...entry.rect];
        let em = 0;
        for (const g of snapshot.glyphs) {
          if (!g.quad.every(Number.isFinite) || !glyphInTargets(g.quad, g.core, [entry.rect], removeRule).hit) continue;
          em = Math.max(em, Math.hypot(g.axisY[0], g.axisY[1]));
          for (let k = 0; k < 8; k += 2) {
            extent[0] = Math.min(extent[0], g.quad[k]);
            extent[1] = Math.min(extent[1], g.quad[k + 1]);
            extent[2] = Math.max(extent[2], g.quad[k]);
            extent[3] = Math.max(extent[3], g.quad[k + 1]);
          }
        }
        entry.under = { emPt: em * (snapshot.userUnit || 1), extent };
      }
      return entry.under;
    };
    // a mark with a seed gets its own noise: a key stream that depends on the seed, the rectangle and the
    // strength only, so that every export of the mark shows the same mosaic (blur.js: mosaicKeyStream). The
    // stream is as long as the largest grid the extent can get; its content does not depend on the length
    for (const entry of entries) {
      if (!entry.seed || !isMosaic(entry)) continue;
      const unit = before.get(entry.pageIndex).userUnit || 1;
      const [x0, y0, x1, y1] = entry.rect;
      const [e0, e1, e2, e3] = under(entry).extent;
      entry.keyStream = await mosaicKeyStream(entry.seed, `${[x0, y0, x1, y1].map((v) => v.toFixed(3)).join(" ")}|${entry.strength}`, mosaicDraws((e2 - e0) * unit, (e3 - e1) * unit));
    }
    // renders of the ORIGINAL pages: the pixels of a mosaic (precise path) and the reference of its check
    const patchRenders = new Map();
    const referenceRenders = new Map();
    const originals = {
      fromInput,
      sideways: (p) => pagesIn.get(p).rotate % 180 !== 0,
      /** the noise source of a mosaic: the key stream of its seed from the start, or the source of the job */
      noiseOf: (entry) => (entry.keyStream ? keyStreamReader(entry.keyStream) : cfg.random),
      under,
      patchRender: async (p) => {
        if (!patchRenders.has(p)) patchRenders.set(p, await fromInput(() => renderPageBitmap(pagesIn.get(p), pdfjs, cfg.createCanvas, { dpi: cfg.patchDpi, maxPixels: cfg.maxPixels, annotations: true })));
        return patchRenders.get(p);
      },
      reference: async (p) => {
        if (!referenceRenders.has(p)) referenceRenders.set(p, await fromInput(() => renderForCheck(pagesIn.get(p), pdfjs, cfg.createCanvas, { scale: cfg.verify.renderScale })));
        return referenceRenders.get(p);
      }
    };
    // the text that the strict marks of a page take, as pdf.js reads it: to find its copies elsewhere in the
    // document. It is document text: it stays in this call and never reaches the report
    cfg.removedBy = (plan) => {
      if (!plan.strict.length || !before.has(plan.pageIndex)) return [];
      plan.removedStrings ??= removedText(before.get(plan.pageIndex), rectsOf(plan.strict), { thresholds: removeRule, includeAnnotations: true });
      return plan.removedStrings;
    };
    report.timings.read = Math.round(now() - t0);

    // ---- 2. loading with the PDF library
    const load = async () => {
      const options = { updateMetadata: false, parseSpeed: ParseSpeeds.Fastest };
      let loaded;
      try {
        loaded = await PDFDocument.load(original, cfg.password === undefined ? options : { ...options, password: cfg.password });
      } catch (error) {
        // a file that pdf.js opened without a password has an empty user password: the library wants it spelled out
        if (cfg.password !== undefined) throw error;
        loaded = await PDFDocument.load(original, { ...options, password: "" });
      }
      // the library does not throw for a file without a usable catalog, and silently skips a page it cannot type
      if (!loaded.catalog || loaded.getPageCount() !== pageCount) throw new Error("the page tree is not usable");
      const lengths = repairStreamLengths(loaded, original);
      if (lengths.unresolved) throw new Error("streams of an encrypted file were read with another length than declared");
      report.streamsRepaired = lengths.repaired;
      cfg.fontCache = new Map();
      return loaded;
    };
    const hasStrict = entries.some(isStrict) || cfg.rasterPages.length > 0;
    const timings = { precise: 0, verify: 0, build: 0, verifyFinal: 0 };
    /** state of the job that a failed build changes: see the header ("Two things can send the whole job back") */
    const job = { editable: true, fontCleanup: cfg.fontCleanup };

    /**
     * Steps 2 to 4: loads the document, settles the plans, builds the bytes. Returns { retry: "fonts" } when a
     * candidate shows a font that no longer loads, otherwise { bytes, out, garbage, allPagesRaster, structureWords, fonts }.
     */
    const build = async () => {
      let doc = null;
      if (job.editable) {
        try {
          doc = await load();
        } catch {
          doc = null;
        }
      }
      if (!doc) {
        for (const plan of plans.values()) {
          const why = reason("REDACT_DOCUMENT_NOT_EDITABLE", { page: plan.pageIndex + 1 });
          if (hasStrict) toRaster(plan, why);
          else if (plan.erase.length) dropErase(plan, plan.erase.slice(), why);
        }
      } else if (cfg.path === "raster") {
        for (const plan of plans.values()) if (plan.strict.length && plan.mode !== "raster") toRaster(plan, reason("REDACT_RASTER_FORCED", { page: plan.pageIndex + 1 }));
      }
      // what the pages of the job show with each font, before anything is edited (fontCleanup.js). A page that
      // only becomes a picture because the caller asked for it (env.rasterPages, no target on it) loses no text
      // to a mark: what it shows is not "removed text", so a font it shares with other pages is not judged by it
      const carriesTargets = (plan) => plan.strict.length > 0 || plan.erase.length > 0;
      const fontsBefore = doc ? usedBy(doc, [...plans.values()].filter((plan) => plan.mode !== "untouched" && carriesTargets(plan)).map((plan) => plan.pageIndex)) : null;
      const rasterPagesNow = () => new Set([...plans.values()].filter((plan) => plan.mode === "raster").map((plan) => plan.pageIndex));
      let fonts = { cleaned: [], notCleaned: [], released: 0 };
      const mergeFonts = (next) => {
        const names = new Set(next.cleaned.map((entry) => entry.font));
        fonts = { cleaned: [...fonts.cleaned.filter((entry) => !names.has(entry.font)), ...next.cleaned], notCleaned: next.notCleaned, released: fonts.released + next.released };
      };

      // ---- 3. precise pass and the verification of the unpainted candidate, until the plans are stable
      const t1 = now();
      let candidate = null;
      let docMatchesPlans = true; // false: `doc` carries edits of a page whose plan changed afterwards
      let cleanedFor = null; // the pages that were pictures-to-be when the fonts of `doc` were cleaned
      let verifyMs = 0;
      for (let round = 1; doc; round++) {
        throwIfAborted(cfg.signal);
        if (round > 1) doc = await load();
        let settled = 0;
        const todo = [...plans.values()].filter((plan) => plan.mode === "precise");
        for (const plan of todo) {
          throwIfAborted(cfg.signal);
          if (round === 1) settlePrecise(doc, plan, cfg);
          else applyPrecise(doc, plan, cfg);
          cfg.progress(1, ++settled / todo.length);
        }
        const precise = todo.filter((plan) => plan.mode === "precise");
        candidate = null;
        docMatchesPlans = true;
        cleanedFor = null;
        fonts = { cleaned: [], notCleaned: [], released: 0 };
        if (!precise.length) break;
        const skip = rasterPagesNow();
        mergeFonts(cleanFonts(doc, { before: fontsBefore, skipPages: skip, enabled: job.fontCleanup }));
        cleanedFor = [...skip].join(",");
        const tv = now();
        await collectGarbage(doc);
        candidate = await doc.save(cfg.saveOptions);
        let pjsCandidate;
        try {
          pjsCandidate = await openPdf(candidate, {});
        } catch (error) {
          // what the library wrote cannot be read back: nothing built from it can be verified
          if (isPdfEditorError(error)) throw error;
          fail("REDACT_VERIFICATION_FAILED", { page: 0, check: "output-unreadable" }, { cause: error });
        }
        let again = false;
        let checked = 0;
        for (const plan of precise) {
          throwIfAborted(cfg.signal);
          const p = plan.pageIndex;
          const page = await pjsCandidate.getPage(p + 1);
          const after = await snapshotPage(page, pdfjs);
          const strictRects = rectsOf(plan.strict);
          const v = verifyPageText(before.get(p), after, [...strictRects, ...rectsOf(plan.erase)], { ...cfg.verify, annotationRects: strictRects });
          if (v.stats.fontsLost > 0 && job.fontCleanup && fonts.cleaned.length) {
            // a font that was edited no longer loads: the job starts again and leaves the fonts alone
            await closePdf(pjsCandidate);
            return { retry: "fonts" };
          }
          if (!v.ok) {
            docMatchesPlans = false;
            if (cfg.path === "precise") fail("REDACT_VERIFICATION_FAILED", { page: p + 1, check: "precise-only" }, { detail: v.failures[0].message });
            if (plan.erase.length) {
              // the erase targets go before the page is given up: first those the leftover glyphs point at
              // (first round, nothing else wrong), then all of them
              let culprits = plan.erase.slice();
              const offenders = v.failures.filter((f) => f.check === "G1-removal");
              if (round === 1 && offenders.length === v.failures.length && offenders.length === v.stats.remainingInTargets) {
                const thresholds = cfg.verify.thresholds || GLYPH_RULE.verify;
                const inStrict = offenders.some((f) => !f.inAnnotation && strictRects.length && glyphInTargets(f.quad, f.core, strictRects, thresholds).hit);
                const pointed = plan.erase.filter((entry) => offenders.some((f) => glyphInTargets(f.quad, f.core, [entry.rect], thresholds).hit));
                if (!inStrict && pointed.length) culprits = pointed;
              }
              dropErase(plan, culprits, verifyReason(v, p));
              if (plan.mode === "precise") again = true;
            } else {
              toRaster(plan, verifyReason(v, p));
            }
          } else if (plan.strict.length) {
            const regions = await checkRegions(page, pdfjs, cfg.createCanvas, regionExpectations(plan, cfg, "candidate"), { ...cfg.verify, keptGlyphs: after.glyphs });
            if (!regions.ok) {
              docMatchesPlans = false;
              const bad = regions.regions.find((r) => !r.ok);
              if (cfg.path === "precise") fail("REDACT_VERIFICATION_FAILED", { page: p + 1, check: "precise-only" }, { detail: "the region under a mark is not blank" });
              toRaster(plan, reason("REDACT_PIXELS_REMAIN", { page: p + 1, outliers: bad.outliers ?? 0, pixels: bad.pixels ?? 0 }));
            }
          }
          page.cleanup();
          cfg.progress(2, ++checked / precise.length);
        }
        await closePdf(pjsCandidate);
        verifyMs += now() - tv;
        if (!again) break;
        if (round >= MAX_ROUNDS) fail("REDACT_VERIFICATION_FAILED", { page: 0, check: "not-repeatable" });
      }
      if (cfg.path === "precise") {
        const lost = [...plans.values()].find((plan) => plan.mode === "raster" && !plan.forced);
        if (lost) fail("REDACT_VERIFICATION_FAILED", { page: lost.pageIndex + 1, check: "precise-only" }, { detail: lost.reasons[0]?.code });
      }
      timings.precise += now() - t1 - verifyMs;
      timings.verify += verifyMs;

      // ---- 4. final build
      const t3 = now();
      throwIfAborted(cfg.signal);
      cfg.progress(3, 0);
      const preciseOnes = [...plans.values()].filter((plan) => plan.mode === "precise");
      const rasterOnes = [...plans.values()].filter((plan) => plan.mode === "raster");
      let bytes = original;
      let garbage = null;
      let allPagesRaster = false;
      let structureWords = 0;
      let out = null; // the document the returned bytes are saved from
      if (preciseOnes.length || rasterOnes.length) {
        const rasterJobs = []; // the plans of the pages that become pictures
        if (!doc) {
          // nothing can be copied: every page becomes a picture in a new document
          allPagesRaster = true;
          out = await PDFDocument.create({ updateMetadata: false });
          for (let p = 0; p < pageCount; p++) {
            const page = await readPage(p);
            const [x0, y0, x1, y1] = page.view;
            const fresh = out.addPage([x1 - x0, y1 - y0]);
            fresh.setMediaBox(x0, y0, x1 - x0, y1 - y0);
            if (page.rotate) fresh.setRotation(degrees(page.rotate));
            if (page.userUnit && page.userUnit !== 1) fresh.node.set(PDFName.of("UserUnit"), PDFNumber.of(page.userUnit));
            if (!plans.has(p)) {
              const plan = newPlan(p);
              plan.mode = "raster";
              plan.reasons = [reason("REDACT_DOCUMENT_NOT_EDITABLE", { page: p + 1 })];
              plans.set(p, plan);
            }
          }
          plans = new Map([...plans].sort((a, b) => a[0] - b[0]));
          rasterJobs.push(...plans.values());
        } else {
          out = doc;
          if (!docMatchesPlans) {
            // start again from the original: the edits of pages that passed are repeated, the others start clean
            out = await load();
            cleanedFor = null;
            fonts = { cleaned: [], notCleaned: [], released: 0 };
            for (const plan of preciseOnes) applyPrecise(out, plan, cfg);
          }
          rasterJobs.push(...rasterOnes);
        }
        let layerFont = null;
        if (rasterJobs.length && cfg.textLayer) {
          try {
            const fontBytes = await cfg.env.fonts(LAYER_FONT_KEY);
            const usable = fontBytes instanceof ArrayBuffer ? new Uint8Array(fontBytes) : fontBytes;
            if (!(usable instanceof Uint8Array) || !usable.length) throw new TypeError("env.fonts returned no bytes");
            out.registerFontkit(fontkit);
            layerFont = await makeTtfLayerFont(out, usable);
          } catch (error) {
            if (isPdfEditorError(error)) throw error;
            if (!report.warnings.some((w) => w.code === "REDACT_TEXT_LAYER_UNAVAILABLE")) report.warnings.push(reason("REDACT_TEXT_LAYER_UNAVAILABLE", { fontKey: LAYER_FONT_KEY }));
          }
        }
        let built = 0;
        for (const plan of rasterJobs) {
          throwIfAborted(cfg.signal);
          const page = await readPage(plan.pageIndex);
          await rasterPage(out, plan, [...plan.strict, ...plan.erase], page, before.get(plan.pageIndex), cfg, layerFont, originals);
          cfg.progress(3, ++built / (rasterJobs.length + 1));
        }
        let painted = 0;
        if (cfg.paint && !allPagesRaster) {
          for (const plan of preciseOnes) {
            throwIfAborted(cfg.signal);
            if (plan.strict.length) painted += await paintPage(out, plan, cfg, originals);
            // one page bitmap at a time: a document with mosaics on many pages must not hold them all
            patchRenders.delete(plan.pageIndex);
          }
        }
        patchRenders.clear();
        // the fonts once more when the pages they are judged by changed since they were cleaned (pages that are
        // pictures now show nothing with them; a fresh load was not cleaned at all)
        let fontsChanged = false;
        if (!allPagesRaster && cleanedFor !== [...rasterPagesNow()].join(",")) {
          const next = cleanFonts(out, { before: fontsBefore, skipPages: new Set(), enabled: job.fontCleanup });
          fontsChanged = next.cleaned.length > 0 || next.released > 0;
          mergeFonts(next);
        }
        // the words that are left anywhere in the structure tree and repeat what the strict marks removed (one
        // walk over the document for all pages)
        const removed = [];
        for (const plan of plans.values()) if (plan.mode !== "untouched") removed.push(...cfg.removedBy(plan));
        structureWords = removed.length ? stripStructureWords(out, removed) : 0;
        if (out === doc && !rasterJobs.length && !painted && !structureWords && !fontsChanged && candidate) bytes = candidate;
        else {
          garbage = await collectGarbage(out);
          bytes = await out.save(cfg.saveOptions);
        }
        // a font that could not be cleaned and that no page reaches any more (its pages became pictures) left
        // the file with them: only a font that is still in the document is reported
        if (fonts.notCleaned.length && rasterJobs.length) {
          const left = fontNamesIn(out);
          fonts = { ...fonts, notCleaned: fonts.notCleaned.filter((entry) => left.has(entry.font)) };
        }
      }
      timings.build += now() - t3;
      return { bytes, out, garbage, allPagesRaster, structureWords, fonts };
    };

    /**
     * Step 5: the final verification on the bytes that will be returned. Returns { retry } when the job has to
     * be built again, otherwise { firstFailure, pageReports }.
     */
    const verify = async (built) => {
      const t4 = now();
      throwIfAborted(cfg.signal);
      cfg.progress(4, 0);
      const { bytes } = built;
      let firstFailure = null;
      const pageReports = [];
      const changed = bytes !== original;
      let pjsOut = null;
      if (changed) {
        try {
          pjsOut = await openPdf(bytes, {});
        } catch (error) {
          if (isPdfEditorError(error)) throw error;
          const failure = new PdfEditorError("REDACT_VERIFICATION_FAILED", { page: 0, check: "output-unreadable" }, { cause: error });
          failure.report = report;
          throw failure;
        }
        if (pjsOut.numPages !== pageCount) firstFailure = { page: 0, check: "page-count" };
      }
      // with another page count the page numbers mean nothing: no page is compared then
      const comparable = pjsOut && !firstFailure;
      const ordered = [...plans.values()].sort((a, b) => a.pageIndex - b.pageIndex);
      const others = [];
      if (comparable && cfg.verifyOtherPages && !built.allPagesRaster) for (let p = 0; p < pageCount; p++) if (!plans.has(p)) others.push(p);
      const fontsEdited = job.fontCleanup && built.fonts.cleaned.length > 0;
      const total = ordered.length + others.length;
      let verified = 0;
      let retry = null;
      for (const plan of ordered) {
        throwIfAborted(cfg.signal);
        const p = plan.pageIndex;
        const pageReport = { pageIndex: p, path: plan.mode, reasons: plan.reasons, targets: plan.strict.length + plan.allErase.length, ok: true };
        if (comparable) {
          try {
            const page = await pjsOut.getPage(p + 1);
            const after = await snapshotPage(page, pdfjs);
            const strictRects = rectsOf(plan.strict);
            const rects = [...strictRects, ...rectsOf(plan.erase)];
            let v;
            if (plan.mode === "raster") v = verifyRasterPage(before.get(p), after, rects, cfg.verify);
            else if (plan.mode === "precise") v = verifyPageText(before.get(p), after, rects, { ...cfg.verify, annotationRects: strictRects });
            else v = verifyPageText(before.get(p), after, [], cfg.verify);
            if (v.stats.fontsLost > 0 && fontsEdited) retry = "fonts";
            const expectations = plan.mode === "untouched" ? [] : regionExpectations(plan, cfg, "final");
            const reference = expectations.some((r) => r.expect === "obscured") ? await originals.reference(p) : undefined;
            const regions = await checkRegions(page, pdfjs, cfg.createCanvas, expectations, { ...cfg.verify, keptGlyphs: after.glyphs, reference });
            referenceRenders.delete(p);
            pageReport.ok = v.ok && regions.ok;
            pageReport.verification = { failures: v.failures, warnings: v.warnings, stats: v.stats, regions: summarizeRegions(regions) };
            if (!pageReport.ok) {
              const badRegion = regions.regions.find((r) => !r.ok);
              firstFailure ||= { page: p + 1, check: v.ok ? CHECK_OF_EXPECTATION[badRegion.expect] : v.failures[0].check };
            }
            page.cleanup();
          } catch (error) {
            // a page of the output that cannot be read or rendered is a page that was not verified
            if (isPdfEditorError(error)) throw error;
            pageReport.ok = false;
            pageReport.verification = { failures: [{ check: "output-unreadable", message: String(error?.message || error).slice(0, 200) }], warnings: [], stats: {}, regions: [] };
            firstFailure ||= { page: p + 1, check: "output-unreadable" };
          }
        }
        if (plan.mode === "precise" && plan.precise) {
          const pre = plan.precise;
          pageReport.stats = {
            glyphsRemoved: pre.glyphsRemoved, annotationsRemoved: pre.annotations.removed.length, fieldsRemoved: pre.annotations.fieldsRemoved.length,
            fieldsCleared: pre.annotations.fieldsCleared.length, imagesRemoved: pre.imagesRemoved, pathsRemoved: pre.pathsRemoved, formsCloned: pre.formsCloned,
            markedContentStripped: pre.markedContentStripped, structAttributesStripped: pre.structAttributesStripped, resourcesPruned: pre.resourcesPruned,
            orphansReleased: pre.orphansReleased
          };
        } else if (plan.mode === "raster" && plan.raster) {
          const ras = plan.raster;
          pageReport.stats = {
            dpi: ras.dpi, pixels: ras.pixels, imageFormat: ras.imageFormat, imageBytes: ras.imageBytes, annotationsRemoved: ras.annotations.removed.length,
            fieldsRemoved: ras.annotations.fieldsRemoved.length, fieldsCleared: ras.annotations.fieldsCleared.length, structureKidsRemoved: ras.structure.kidsRemoved,
            layer: ras.layer
          };
        }
        pageReports.push(pageReport);
        cfg.progress(4, ++verified / total);
      }
      // ---- the pages without marks: what pdf.js draws from the output is what it drew from the input
      let strayPage = null;
      for (const p of others) {
        if (retry || strayPage !== null) break;
        throwIfAborted(cfg.signal);
        const drawing = async (document) => {
          let page = null;
          try {
            page = await document.getPage(p + 1);
            return await pageGlyphs(page, pdfjs, { annotations: false, compact: true });
          } catch (error) {
            if (isPdfEditorError(error)) throw error;
            return null; // pdf.js cannot read the page
          } finally {
            page?.cleanup();
          }
        };
        const was = await drawing(pjsIn);
        const is = await drawing(pjsOut);
        // (a page nobody could read before must not have become readable; one that was readable must still be)
        const same = was && is ? compareUntouchedPage(was, is, cfg.verify) : { ok: was === is, reason: "operators" };
        if (!same.ok) {
          if (same.reason === "fonts" && fontsEdited) retry = "fonts";
          else strayPage = p;
        }
        cfg.progress(4, ++verified / total);
      }
      if (pjsOut) await closePdf(pjsOut);
      timings.verifyFinal += now() - t4;
      if (retry) return { retry };
      if (strayPage !== null) {
        if (job.editable) return { retry: "pages" };
        firstFailure ||= { page: strayPage + 1, check: "G2-preservation" };
      }
      return { firstFailure, pageReports };
    };

    // ---- 2 to 5, again when the result says that the fonts or the library's reading cannot be trusted
    let built = null;
    let verdict = null;
    for (let round = 1; ; round++) {
      built = await build();
      verdict = built.retry ? built : await verify(built);
      if (!verdict.retry || round >= MAX_ATTEMPTS) break;
      if (verdict.retry === "fonts") job.fontCleanup = false;
      else job.editable = false;
      // the plans keep what was decided (pictures, dropped erase targets); their edits are made again
      for (const plan of plans.values()) {
        plan.precise = null;
        plan.raster = null;
        plan.fills = new Map();
      }
    }
    if (verdict.retry) fail("REDACT_VERIFICATION_FAILED", { page: 0, check: "not-repeatable" }, { detail: `the job could not settle (${verdict.retry})` });
    const { bytes } = built;
    const { firstFailure, pageReports } = verdict;

    // ---- the report
    for (const plan of [...plans.values()].sort((a, b) => a.pageIndex - b.pageIndex)) {
      const p = plan.pageIndex;
      const done = plan.mode === "precise" ? plan.precise?.annotations : plan.mode === "raster" ? plan.raster?.annotations : null;
      if (!done) continue;
      for (const cleared of done.fieldsCleared) report.warnings.push(reason("REDACT_FIELD_VALUE_CLEARED", { page: p + 1, field: cleared.field, widgets: cleared.widgets }));
      if (done.xfaRemoved && !report.warnings.some((w) => w.code === "REDACT_XFA_REMOVED")) report.warnings.push(reason("REDACT_XFA_REMOVED"));
      if (plan.mode !== "raster") continue;
      if (done.removed.length) report.warnings.push(reason("REDACT_ANNOTATIONS_FLATTENED", { page: p + 1, count: done.removed.length }));
      const missing = plan.raster.layer ? plan.raster.layer.unencodable + plan.raster.layer.vertical : 0;
      if (missing) report.warnings.push(reason("REDACT_TEXT_LAYER_INCOMPLETE", { page: p + 1, glyphs: missing }));
    }
    report.pages = pageReports;
    for (const entry of entries) {
      const plan = plans.get(entry.pageIndex);
      const dropped = plan.dropped.find((d) => d.entry === entry);
      const row = { index: entry.index, pageIndex: entry.pageIndex, mode: entry.mode, outcome: dropped ? "cover-needed" : plan.mode === "raster" ? "raster" : "precise" };
      if (dropped) row.reason = dropped.reason;
      report.targets.push(row);
    }
    for (const [name, ms] of Object.entries(timings)) report.timings[name] = Math.round(ms);
    report.timings.total = Math.round(now() - t0);
    report.outputBytes = bytes.length;
    report.precisePages = pageReports.filter((page) => page.path === "precise").length;
    report.rasterPages = pageReports.filter((page) => page.path === "raster").length;
    report.garbage = built.garbage;
    report.structureWordsStripped = built.structureWords;
    // fonts: what was taken out of them, and which still hold glyphs that only the removed text used
    report.fontsCleaned = built.fonts.cleaned;
    report.fontsNotCleaned = built.fonts.notCleaned;
    for (const font of built.fonts.notCleaned) report.warnings.push(reason("REDACT_FONT_GLYPHS_REMAIN", { font: font.font, pages: font.pageIndexes.length }));
    if (firstFailure) {
      const failure = new PdfEditorError("REDACT_VERIFICATION_FAILED", firstFailure, { detail: `final verification failed (${firstFailure.check})` });
      failure.report = report;
      throw failure;
    }
    // ---- 6. what the marks removed may be repeated where no mark reaches: bookmarks, document properties,
    //         field names, attachments ... The caller is told (the engine does not rewrite those parts)
    if (built.out) {
      const removed = [];
      for (const plan of plans.values()) if (plan.mode !== "untouched") removed.push(...cfg.removedBy(plan));
      for (const repeat of findTextElsewhere(built.out, removed)) report.warnings.push(reason("REDACT_TEXT_ELSEWHERE", repeat));
      // files attached to the document travel with it unread: most formats cannot be searched for the text
      const attached = entries.some(isStrict) ? countEmbeddedFiles(built.out) : 0;
      if (attached) report.warnings.push(reason("REDACT_ATTACHMENTS_NOT_CHECKED", { count: attached }));
    }
    // a mosaic without a seed is drawn with new noise in every export: the caller is told, because several
    // exports of one mark can be averaged (blur.js) and only the caller can keep a seed with the mark
    const unseeded = entries.filter((entry) => isMosaic(entry) && !entry.seed && (cfg.paint || plans.get(entry.pageIndex)?.mode === "raster")).length;
    if (unseeded) report.warnings.push(reason("REDACT_MOSAIC_NOT_SEEDED", { count: unseeded }));
    cfg.progress(4, 1);
    return { bytes, report };
  } catch (error) {
    if (isPdfEditorError(error) && error.code === "REDACT_VERIFICATION_FAILED" && !error.report) error.report = report;
    throw error;
  } finally {
    for (const doc of open.splice(0)) {
      try {
        await cfg.closePdf(doc);
      } catch {
        /* ignore */
      }
    }
  }
}
