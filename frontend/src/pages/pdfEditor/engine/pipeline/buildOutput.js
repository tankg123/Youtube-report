// buildOutput(): one export job through the engines.
//
//   without marks   A  assembleDocument(job)                       pages AND objects in one pass
//   with marks      A  assembleDocument(job, { draw: false })      the pages, nothing drawn yet
//                   B  redactPdf(bytes of A, targets)              the marks of job.marks; verified by the engine
//                      (options.rasterPages goes along as env.rasterPages: those pages become pictures, with
//                      or without marks; and everything runs once more from the bytes of A when eraseFallback
//                      is "redact" and a replaced line could not be erased: that line then runs as a
//                      redaction in its cover colour)
//                      re-assertion: no text under a redact / pixelate / blur mark (selfCheck.js)
//                   C  drawOnDocument(bytes of B, ALL objects)     one call (a font subset is written once), with
//                      an underlay in the cover colour for every replaced line that is still in the file
//   always          the finished bytes open with pdf.js and have the pages of the job (selfCheck.js)
//
// A mark acts on the ORIGINAL page content only: that is why the objects are drawn after the redaction, and
// why a text box of the user that lies over a mark is still real, searchable text in the output.
//
// No state survives a call (every variable below lives in the call), the job is only read, and the byte arrays
// of the job are never handed to pdf.js (it would detach them): the engines and the self-check copy first.
import { throwIfAborted, warning } from "../errors.js";
import { assembleDocument, drawOnDocument } from "../export/index.js";
import { redactPdf } from "../redact/index.js";
import { STAGES } from "./codes.js";
import { checkOutput, checkRedacted, checkRedactionResult } from "./selfCheck.js";
import { validateEnv, validateJob, validateOptions, validateRasterPages } from "./validateJob.js";

const [STAGE_ASSEMBLE, STAGE_REDACT, STAGE_DRAW, STAGE_CHECK] = STAGES;
const ENGINES = Object.freeze({ assembleDocument, redactPdf, drawOnDocument });

/** Where each stage lies on the 0..1 scale of onProgress. */
const SPANS_PLAIN = Object.freeze({ assemble: [0, 0.92], check: [0.92, 1] });
const SPANS_MARKS = Object.freeze({ assemble: [0, 0.2], redact: [0.2, 0.72], draw: [0.72, 0.92], check: [0.92, 1] });
/** Shares of the redact span: the first round, a possible further one, the re-assertion at the end. */
const REDACT_RECHECK_FROM = 0.92;
const REDACT_SECOND_ROUND_FROM = 0.55;
/**
 * Redaction rounds at most. Every further round turns the replaced lines that still need a cover into
 * redactions, and a redaction never needs a cover: two rounds are all that is ever needed, the limit only
 * guards against an engine that does not keep that promise.
 */
const MAX_REDACT_ROUNDS = 4;
const WHITE = "#ffffff";
const PATH_RANK = Object.freeze({ untouched: 0, precise: 1, raster: 2 });

const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const listOf = (value) => (Array.isArray(value) ? value : []);
const reportOf = (result) => (result && typeof result === "object" && result.report && typeof result.report === "object" ? result.report : {});
const plain = ({ code, params }) => warning(code, { ...(params || {}) });
const isEntry = (entry) => Boolean(entry) && typeof entry.code === "string";

/**
 * One rising fraction for the listener. A listener that throws is ignored: a progress bar must never break
 * an export.
 */
function createProgress(listener) {
  let last = 0;
  let lastStage = null;
  const emit = (fraction, stage) => {
    if (typeof listener !== "function") return;
    const value = Math.min(1, Math.max(last, Number.isFinite(fraction) ? fraction : last));
    if (value === last && stage === lastStage) return;
    last = value;
    lastStage = stage;
    try {
      listener(Math.round(value * 1000) / 1000, stage);
    } catch {
      // not the job's problem
    }
  };
  /** A listener for an engine: its 0..1 becomes [from, to] of the whole job, under one stage code. */
  const within = (stage, [from, to]) => (fraction) => emit(from + (to - from) * Math.min(1, Math.max(0, Number(fraction) || 0)), stage);
  return { emit, within };
}

const part = ([from, to], [start, end]) => [from + (to - from) * start, from + (to - from) * end];

/** The target of redactPdf() for a mark; `asRedaction`: a replaced line that is removed like a redaction. */
function targetOf(mark, asRedaction) {
  const target = { pageIndex: mark.pageIndex, rect: mark.rect.slice(), mode: mark.mode };
  if (mark.mode === "erase") {
    if (asRedaction) {
      target.mode = "redact";
      target.color = mark.cover || WHITE;
    } else if (mark.cover) {
      // only used where the page becomes a picture for another mark; without it the engine samples the paper
      target.color = mark.cover;
    }
  } else if (mark.mode === "redact") {
    if (mark.color) target.color = mark.color;
  } else {
    if (mark.strength) target.strength = mark.strength;
    // the same mosaic in every export of this mark (different mosaics of one content could be averaged)
    if (mark.seed) target.seed = mark.seed;
  }
  return target;
}

/** Entries { code, params } of several lists in order, each once. */
function mergeEntries(...lists) {
  const seen = new Set();
  const out = [];
  for (const entry of lists.flat()) {
    if (!isEntry(entry)) continue;
    const copy = plain(entry);
    const key = JSON.stringify([copy.code, copy.params]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(copy);
  }
  return out;
}

/**
 * One round of stage B: every mark through the redaction engine, on the bytes of stage A, in ONE call.
 *
 * The pages of options.rasterPages go to the engine as env.rasterPages: it turns them into pictures whatever
 * their marks say, also pages without any mark (that is how a font of report.redaction.fontsNotCleaned is
 * freed: every page that shows text with it has to become a picture, not only the ones that carry a mark).
 *
 * @returns {{ bytes: Uint8Array, targets: object[], rows: object[], pages: object[], warnings: object[], fontsNotCleaned: object[] }}
 *          targets / rows: one per mark, in the order of job.marks (rows[i].index === i);
 *          fontsNotCleaned: [{ font, pageIndexes, reason }]
 */
async function redactRound({ engines, bytes, marks, asRedaction, rasterPages, redactEnv, redactPath, signal, onProgress }) {
  const targets = marks.map((mark) => targetOf(mark, asRedaction.has(mark.index)));
  throwIfAborted(signal);
  const callEnv = { ...redactEnv, path: redactPath, onProgress: (fraction) => onProgress(Math.min(1, Math.max(0, Number(fraction) || 0))) };
  // (with path "raster" every page with a strict mark is a picture already; the listed pages are added to them)
  if (rasterPages.length > 0) callEnv.rasterPages = rasterPages.slice();
  const result = await engines.redactPdf(bytes, targets, callEnv);
  const checked = checkRedactionResult(result, targets);
  const pages = new Map();
  for (const page of checked.pages) {
    const known = pages.get(page.pageIndex);
    const reasons = mergeEntries(known ? known.reasons : [], listOf(page.reasons));
    const path = known && PATH_RANK[known.path] > PATH_RANK[page.path] ? known.path : page.path;
    pages.set(page.pageIndex, { pageIndex: page.pageIndex, path, reasons });
  }
  // one row per font (an engine that lists a font twice gets its pages put together; the first reason counts)
  const fonts = new Map();
  for (const entry of checked.fontsNotCleaned) {
    if (!fonts.has(entry.font)) fonts.set(entry.font, { pages: new Set(), reason: entry.reason });
    const known = fonts.get(entry.font);
    if (known.reason === null) known.reason = entry.reason;
    for (const index of entry.pageIndexes) known.pages.add(index);
  }
  throwIfAborted(signal);
  return {
    bytes: checked.bytes,
    targets,
    rows: checked.rows.map((row, index) => ({ ...row, index })),
    pages: [...pages.values()].sort((first, second) => first.pageIndex - second.pageIndex),
    warnings: checked.warnings.slice(),
    fontsNotCleaned: [...fonts].map(([font, known]) => ({ font, pageIndexes: [...known.pages].sort((first, second) => first - second), reason: known.reason }))
  };
}

/** The redaction part of the report, from the last round of stage B and the marks of the job. */
function redactionReport(marks, asRedaction, round, rasterPages) {
  const targets = round.rows.map((row, index) => {
    const mark = marks[index];
    const entry = { index, pageIndex: mark.pageIndex, mode: mark.mode, outcome: row.outcome, objectId: mark.objectId };
    if (isEntry(row.reason)) entry.reason = plain(row.reason);
    // a replaced line that was removed like a redaction (eraseFallback "redact"): a box in its cover colour
    if (asRedaction.has(index)) entry.fallback = "redact";
    return entry;
  });
  const pages = round.pages.map((page) => ({
    pageIndex: page.pageIndex,
    path: page.path,
    reasons: page.reasons,
    areas: marks.filter((mark) => mark.pageIndex === page.pageIndex && mark.mode !== "erase").length,
    replacedLines: marks.filter((mark) => mark.pageIndex === page.pageIndex && mark.mode === "erase").length
  }));
  const coveredObjectIds = [];
  for (const entry of targets) {
    if (entry.outcome === "cover-needed" && entry.objectId !== null && !coveredObjectIds.includes(entry.objectId)) coveredObjectIds.push(entry.objectId);
  }
  // removed text that is repeated outside page content: one row per place (an engine that reports a place
  // twice gets its counts added up)
  const elsewhere = [];
  for (const entry of round.warnings) {
    if (!isEntry(entry) || entry.code !== "REDACT_TEXT_ELSEWHERE") continue;
    const where = typeof entry.params?.where === "string" && entry.params.where ? entry.params.where : "other";
    const count = Number.isFinite(entry.params?.count) ? entry.params.count : 0;
    const known = elsewhere.find((row) => row.where === where);
    if (known) known.count += count;
    else elsewhere.push({ where, count });
  }
  const rasterized = new Set(pages.filter((page) => page.path === "raster").map((page) => page.pageIndex));
  return {
    pages,
    targets,
    coveredObjectIds,
    elsewhere,
    fontsNotCleaned: round.fontsNotCleaned,
    // pages the caller wanted as pictures that are not (the engine turns every listed page into a picture, so
    // this stays empty unless an engine did not keep that promise: the interface then does not offer it again)
    rasterPagesNotApplied: rasterPages.filter((index) => !rasterized.has(index))
  };
}

/**
 * Runs an export job. See index.js for the contract (job, env, options, report, errors).
 * @returns {Promise<{ bytes: Uint8Array, report: object }>}
 */
export async function buildOutput(job, env, options) {
  const started = clock();
  const settings = validateOptions(options);
  validateEnv(env);
  const plan = validateJob(job);
  validateRasterPages(settings.rasterPages, plan.pageCount);
  const engines = { ...ENGINES, ...settings.engines };
  const { signal } = settings;
  const progress = createProgress(settings.onProgress);
  const hasMarks = plan.marks.length > 0;
  const spans = hasMarks ? SPANS_MARKS : SPANS_PLAIN;
  const timings = { assemble: 0, redact: 0, draw: 0, check: 0, total: 0 };
  const fonts = typeof env.fonts === "function" ? env.fonts : undefined;

  // ---- A: the new document (with the objects when there is nothing to redact)
  throwIfAborted(signal);
  progress.emit(0, STAGE_ASSEMBLE);
  let mark = clock();
  const assembled = await engines.assembleDocument(job, {
    fonts,
    draw: !hasMarks,
    now: settings.now ?? job.now ?? undefined,
    idSeed: settings.idSeed,
    producer: settings.producer,
    keepOutline: settings.keepOutline,
    keepForms: settings.keepForms,
    keepAttachments: settings.keepAttachments,
    dropOrphanBookmarks: settings.dropOrphanBookmarks,
    signal,
    onProgress: progress.within(STAGE_ASSEMBLE, spans.assemble)
  });
  const assembleReport = reportOf(assembled);
  timings.assemble = Math.round(clock() - mark);
  if (!hasMarks) {
    // one pass: the part of it that drew the objects is the draw stage
    timings.draw = Math.min(timings.assemble, Math.max(0, Math.round(assembleReport.timings?.draw || 0)));
    timings.assemble -= timings.draw;
  }
  let bytes = assembled?.bytes;
  let redaction = null;
  let redactWarnings = [];
  let drawWarnings = [];

  if (hasMarks) {
    // ---- B: the marks, on the pages as they came from the sources
    throwIfAborted(signal);
    mark = clock();
    const canRepeat = settings.eraseFallback === "redact" && plan.marks.some((entry) => entry.mode === "erase");
    const redactEnv = { ...env, password: undefined, signal };
    if (settings.random) redactEnv.random = settings.random;
    const asRedaction = new Set();
    let round;
    for (let number = 1; ; number += 1) {
      const share = number === 1 ? [0, canRepeat ? REDACT_SECOND_ROUND_FROM : REDACT_RECHECK_FROM] : [REDACT_SECOND_ROUND_FROM, REDACT_RECHECK_FROM];
      round = await redactRound({
        engines,
        bytes: assembled?.bytes,
        marks: plan.marks,
        asRedaction,
        rasterPages: settings.rasterPages,
        redactEnv,
        redactPath: settings.redactPath,
        signal,
        onProgress: progress.within(STAGE_REDACT, part(spans.redact, share))
      });
      const stillThere = round.rows.filter((row) => plan.marks[row.index].mode === "erase" && row.outcome === "cover-needed").map((row) => row.index);
      if (settings.eraseFallback !== "redact" || stillThere.length === 0 || number >= MAX_REDACT_ROUNDS) break;
      for (const index of stillThere) asRedaction.add(index);
    }
    timings.redact = Math.round(clock() - mark);

    // the pipeline's own look at what came back, before the user's objects (which may lie over a mark) are drawn
    mark = clock();
    await checkRedacted(round.bytes, round.targets, plan.pageCount, env, signal, progress.within(STAGE_REDACT, part(spans.redact, [REDACT_RECHECK_FROM, 1])));
    timings.check += Math.round(clock() - mark);
    bytes = round.bytes;
    redaction = redactionReport(plan.marks, asRedaction, round, settings.rasterPages);
    redactWarnings = round.warnings;

    // ---- C: everything the user added, in one call; under it the covers of replaced lines that are still there
    const underlays = Array.from({ length: plan.pageCount }, () => []);
    let covers = 0;
    for (const entry of redaction.targets) {
      if (entry.outcome !== "cover-needed") continue;
      const source = plan.marks[entry.index];
      underlays[source.pageIndex].push({ rect: source.rect.slice(), color: source.cover || WHITE });
      covers += 1;
    }
    if (plan.hasObjects || covers > 0) {
      throwIfAborted(signal);
      progress.emit(spans.draw[0], STAGE_DRAW);
      mark = clock();
      const drawn = await engines.drawOnDocument(bytes, plan.objects, {
        fonts,
        assets: job.assets || {},
        underlays,
        signal,
        onProgress: progress.within(STAGE_DRAW, spans.draw)
      });
      timings.draw = Math.round(clock() - mark);
      bytes = drawn?.bytes;
      drawWarnings = listOf(reportOf(drawn).warnings);
    }
  }

  // ---- the finished file
  throwIfAborted(signal);
  progress.emit(spans.check[0], STAGE_CHECK);
  mark = clock();
  await checkOutput(bytes, plan.pageCount, env, signal);
  timings.check += Math.round(clock() - mark);

  const warnings = mergeEntries(listOf(assembleReport.warnings), redactWarnings, drawWarnings);
  if (redaction) {
    const onRequest = (page) => page.reasons.some((reason) => reason.code === "REDACT_RASTER_FORCED");
    const numbers = (pages) => pages.map((page) => page.pageIndex + 1);
    const rasterized = redaction.pages.filter((page) => page.path === "raster");
    const unavoidable = numbers(rasterized.filter((page) => !onRequest(page)));
    const requested = numbers(rasterized.filter(onRequest));
    if (unavoidable.length) warnings.push(warning("PIPELINE_PAGES_RASTERIZED", { count: unavoidable.length, pages: unavoidable }));
    if (requested.length) warnings.push(warning("PIPELINE_PAGES_RASTERIZED_ON_REQUEST", { count: requested.length, pages: requested }));
    const covered = redaction.targets.filter((entry) => entry.outcome === "cover-needed").length;
    if (covered) warnings.push(warning("PIPELINE_ERASE_COVERED", { count: covered }));
  }
  const sources = {};
  for (const [id, facts] of Object.entries(assembleReport.sources || {})) {
    sources[id] = { signatures: facts?.signatures ?? 0, encrypted: Boolean(facts?.encrypted), tagged: Boolean(facts?.tagged) };
  }
  timings.total = Math.round(clock() - started);
  progress.emit(1, STAGE_CHECK);
  return {
    bytes,
    report: {
      pageCount: plan.pageCount,
      byteLength: bytes.length,
      usedRedaction: hasMarks,
      redaction,
      rasterizedTextObjectIds: plan.rasterizedTextObjectIds.slice(),
      warnings,
      sources,
      timings
    }
  };
}
