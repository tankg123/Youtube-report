// Helpers of the pipeline suites (tests/pdfPipeline*.test.mjs): the Node env of buildOutput(), export jobs
// made of generated sources, editor objects of every type, and the checks the tests run on an output.
// Everything is generated here or in the kits this file builds on (pdfTestKit, pdfRedactKit, pdfTextKit).
import assert from "node:assert/strict";
import { assembleDocument, drawOnDocument } from "../../src/pages/pdfEditor/engine/export/index.js";
import { redactPdf } from "../../src/pages/pdfEditor/engine/redact/index.js";
import { isPdfEditorError } from "../../src/pages/pdfEditor/engine/errors.js";
import { extractText, makePng, squash } from "./pdfTestKit.mjs";
import { redactEnv, regionOf } from "./pdfRedactKit.mjs";
import { makeTextObject, nodeTextLayout } from "./pdfTextKit.mjs";

/** A fresh env for one job (its noise source is seeded: two jobs with their own env give the same bytes). */
export const pipelineEnv = (options) => redactEnv(options);

/** The clock and the trailer /ID of a reproducible run. */
export const fixedOptions = (extra = {}) => ({ now: new Date(Date.UTC(2026, 10, 20, 3, 0, 0)), idSeed: new Uint8Array(16).fill(7), ...extra });

/** An ExportJob (model/schema.js) from its parts; `objects` defaults to nothing on every page. */
export function makeJob({ sources, pages, objects, marks = [], assets = {}, info = {}, fileName = "pipeline-test" }) {
  return { sources, pages, objects: objects || pages.map(() => []), marks, assets, info, fileName };
}

export const sourceOf = (id, bytes, pages) => ({ id, bytes, expectedPages: pages });

/**
 * A text box as the store and the text service would hand it to an export: laid out, with its TextLayout.
 * `left` / `top`: the top-left corner of the box in user space of an upright page (y up).
 */
export function textBox({ id, text, left, top, ...rest }) {
  const draft = makeTextObject({ id, text: text.normalize("NFC"), ...rest, frame: { x: 0, y: 0, rot: 0 } });
  const object = { ...draft, frame: { ...draft.frame, x: left + draft.frame.w / 2, y: top - draft.frame.h / 2 } };
  object.layout = nodeTextLayout(object);
  return object;
}

export const SHAPE_COLORS = Object.freeze({ rect: "#2563eb", ellipse: "#16a34a", line: "#9333ea", pen: "#ea580c", highlight: "#facc15", image: "#dc2626" });

/**
 * One object of every type that is drawn (no marks), placed in the lower half of an A4 page, with the user-space
 * rectangle in which each of them must show its colour: { objects, assets, probes: [{ type, rect, color }] }.
 */
export function everyObjectType(pageId = "page-1") {
  const base = { pageId, opacity: 1 };
  const objects = [
    { id: "shape-rect", type: "rect", ...base, frame: { x: 100, y: 400, w: 80, h: 40, rot: 0 }, stroke: null, strokeWidth: 0, dash: "solid", fill: SHAPE_COLORS.rect },
    { id: "shape-ellipse", type: "ellipse", ...base, frame: { x: 250, y: 400, w: 80, h: 40, rot: 0 }, stroke: null, strokeWidth: 0, dash: "solid", fill: SHAPE_COLORS.ellipse },
    { id: "shape-line", type: "line", ...base, p1: [50, 300], p2: [250, 300], stroke: SHAPE_COLORS.line, strokeWidth: 8, dash: "solid", headStart: false, headEnd: true },
    { id: "shape-pen", type: "pen", ...base, frame: { x: 400, y: 300, w: 100, h: 40, rot: 0 }, points: [[0, 0.5], [0.25, 0.5], [0.5, 0.5], [0.75, 0.5], [1, 0.5]], color: SHAPE_COLORS.pen, width: 8 },
    { id: "mark-stroke", type: "highlight", pageId, mode: "stroke", frame: { x: 150, y: 200, w: 200, h: 20, rot: 0 }, points: [[0, 0.5], [0.5, 0.5], [1, 0.5]], thickness: 14, color: SHAPE_COLORS.highlight },
    { id: "mark-text", type: "highlight", pageId, mode: "text", quads: [[60, 160, 200, 160, 200, 140, 60, 140]], color: SHAPE_COLORS.highlight },
    { id: "picture", type: "image", ...base, frame: { x: 450, y: 150, w: 60, h: 60, rot: 0 }, assetId: "asset-red", role: "image" }
  ];
  const probes = [
    { type: "rect", rect: [70, 385, 130, 415], color: SHAPE_COLORS.rect },
    { type: "ellipse", rect: [240, 395, 260, 405], color: SHAPE_COLORS.ellipse },
    { type: "line", rect: [100, 298, 200, 302], color: SHAPE_COLORS.line },
    { type: "pen", rect: [380, 298, 420, 302], color: SHAPE_COLORS.pen },
    { type: "highlight (stroke)", rect: [100, 197, 200, 203], color: SHAPE_COLORS.highlight },
    { type: "highlight (text)", rect: [80, 145, 180, 155], color: SHAPE_COLORS.highlight },
    { type: "image", rect: [430, 130, 470, 170], color: SHAPE_COLORS.image }
  ];
  return { objects, assets: { "asset-red": { bytes: makePng(8, 8, [220, 38, 38, 255]), mime: "image/png" } }, probes };
}

const channels = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));

/** Asserts that a user-space rectangle of a rendered page is one flat colour (needs a canvas). */
export async function assertFlatColour(bytes, pageIndex, rect, color, label = "region", tolerance = 6) {
  const region = await regionOf(bytes, pageIndex, rect, { tolerance });
  assert.equal(region.uniform, true, `${label}: not one flat colour (range ${region.range})`);
  const [want, have] = [channels(color), channels(region.mean)];
  assert.ok(want.every((value, index) => Math.abs(value - have[index]) <= tolerance), `${label}: ${region.mean} instead of ${color}`);
}

/** The text of every page as pdf.js extracts it, without white space (NFC). */
export async function pageTexts(bytes) {
  return (await extractText(bytes)).map(squash);
}

/** A deep copy of a job with its byte arrays and dates (what the job looked like before a run). */
export const snapshotJob = (job) => structuredClone(job);

/** Freezes every plain object and array of a job (typed arrays cannot be frozen: compare them with a snapshot). */
export function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** The real engines, with every call recorded: { engines, calls: [{ name, args, result }] }. */
export function spyEngines(overrides = {}) {
  const calls = [];
  const real = { assembleDocument, redactPdf, drawOnDocument };
  const engines = {};
  for (const name of Object.keys(real)) {
    engines[name] = async (...args) => {
      const call = { name, args };
      calls.push(call);
      call.result = await (overrides[name] || real[name])(...args);
      return call.result;
    };
  }
  return { engines, calls, real };
}

/** Awaits a rejection with a PdfEditorError of that code and returns the error. */
export async function rejectsWith(promise, code, params) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected a rejection with ${code}, but the promise resolved`);
  assert.ok(isPdfEditorError(error), `expected PdfEditorError ${code}, got ${error?.stack || error}`);
  assert.equal(error.code, code, `${error.message}`);
  if (params) for (const [name, value] of Object.entries(params)) assert.deepEqual(error.params[name], value, `${code}.params.${name}`);
  return error;
}

/** Records onProgress calls and checks the promises of the contract afterwards. */
export function progressRecorder() {
  const seen = [];
  return {
    seen,
    onProgress: (fraction, stage) => seen.push([fraction, stage]),
    assertComplete(stages) {
      assert.ok(seen.length >= 2, "no progress was reported");
      assert.equal(seen[0][0], 0);
      assert.deepEqual(seen.at(-1), [1, stages.at(-1)]);
      seen.forEach(([fraction], index) => assert.ok(index === 0 || fraction >= seen[index - 1][0], `progress went back at call ${index}`));
      const order = seen.map(([, stage]) => stage).filter((stage, index, all) => index === 0 || stage !== all[index - 1]);
      assert.deepEqual(order, stages, "stages in order, each once");
    }
  };
}
