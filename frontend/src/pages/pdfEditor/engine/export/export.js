// exportDocument(): the ordered export pipeline. It always writes a NEW document; the sources are loaded
// for this export only, scrubbed, and thrown away. Nothing of a page that is not in the plan may be in the
// bytes that come out.
//
//   1. load        every source that the plan uses, fresh (robust.js loadForEdit: the writer must read the
//                  objects a viewer reads, catalog check, page tree and stream repairs, signatures); the
//                  writer's page count must equal the viewer's
//   2. read        document-level structure from the PRISTINE sources: destinations, outline, Info, catalog
//                  settings, page labels, form facts, attachments
//   3. copy        copyPagesSafe() per source into the new document, pages in output order
//   4. place       addPage in plan order (blank pages in between), extra rotation into /Rotate
//   5. edit        plan.edit({ outDoc, pages, sources, report }): everything that draws (the product: painter.js)
//   6. structure   outline, AcroForm, layers, page labels, attachments (on request), catalog settings, Info,
//                  XMP, trailer /ID
//   7. finish      strip baggage, page dictionaries out of line, ONE flush, sweep, audit, save
//
// The order matters: structure is read before the scrub, nothing is drawn after the flush (the library writes
// a font subset once), the sweep runs on what the flush produced, the audit judges what will be written.
// Same plan, same clock (`now`) and same `idSeed` give the same bytes.
import { pdfLib } from "../lib.js";
import { PdfEditorError, isPdfEditorError, throwIfAborted, warning } from "../errors.js";
import { normalizeRightAngle } from "../geometry.js";
import { rebuildAcroForm, describeAcroForm } from "./acroform.js";
import { STAGES } from "./codes.js";
import { copyPagesSafe, auditOutput, stripXObjectBaggage, externalizePageDicts } from "./copyPages.js";
import { createDestResolver } from "./dests.js";
import {
  DEFAULT_PRODUCER, readInfo, writeInfo, writeXmp, setDocumentId, readCatalogSettings, writeCatalogSettings, readPageLabels,
  writePageLabels, rebuildOptionalContent, copyAttachments, listAttachments, resolveUri
} from "./docSettings.js";
import { collectGarbage, compactObjectNumbers } from "./gc.js";
import { readOutline, mapOutline, writeOutline } from "./outline.js";
import { pageGeometry } from "./pageGeometry.js";
import { N } from "./pdfUtil.js";
import { loadForEdit } from "./robust.js";

const { PDFDocument, PDFNumber } = pdfLib;

const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

/**
 * Progress and cancellation of a long job. tick() reports and, when more than `budget` ms passed since the
 * last pause, gives the event loop a turn (so that an abort or a repaint can happen) and checks the signal.
 */
export function createPacer({ signal, onProgress, budget = 40 } = {}) {
  let last = clock();
  let reported = -1;
  return async function tick(fraction, stage) {
    throwIfAborted(signal);
    if (typeof onProgress === "function" && fraction !== undefined) {
      const value = Math.min(1, Math.max(reported, fraction));
      if (value !== reported) {
        reported = value;
        onProgress(value, stage);
      }
    }
    if (clock() - last >= budget) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      last = clock();
      throwIfAborted(signal);
    }
  };
}

const invalidJob = (reason, extra = {}, detail) => new PdfEditorError("EXPORT_JOB_INVALID", { reason, page: null, source: null, ...extra }, { detail });

/** Structural check of a plan: throws EXPORT_JOB_INVALID. Returns the ids of the sources that pages use. */
export function checkPlan(plan) {
  if (!plan || !Array.isArray(plan.sources) || !Array.isArray(plan.pages)) throw invalidJob("shape", {}, "sources and pages must be arrays");
  if (plan.pages.length === 0) throw invalidJob("no-pages");
  const ids = new Set();
  for (const source of plan.sources) {
    if (!source || typeof source.id !== "string" || !source.id) throw invalidJob("shape", {}, "a source needs an id");
    if (ids.has(source.id)) throw invalidJob("duplicate-source", { source: source.id });
    ids.add(source.id);
  }
  const used = new Set();
  plan.pages.forEach((entry, page) => {
    if (!entry || typeof entry !== "object") throw invalidJob("shape", { page });
    const rotate = entry.rotate ?? 0;
    if (!Number.isFinite(rotate) || rotate % 90 !== 0) throw invalidJob("rotation", { page });
    if (entry.blank !== undefined) {
      const size = entry.blank;
      // 3 .. 14400 units: the limits of ISO 32000-1 Annex C for a page
      if (!Array.isArray(size) || size.length !== 2 || !size.every((value) => Number.isFinite(value) && value >= 3 && value <= 14400)) throw invalidJob("blank-size", { page });
      return;
    }
    if (!ids.has(entry.source)) throw invalidJob("unknown-source", { page, source: entry.source ?? null });
    if (!Number.isInteger(entry.index) || entry.index < 0) throw invalidJob("page-index", { page, source: entry.source });
    used.add(entry.source);
  });
  return used;
}

/**
 * The last steps of every document this engine writes: strip baggage, move page dictionaries out of line,
 * flush ONCE, sweep, audit, save.
 *
 * @param {object} outDoc  PDFDocument; nothing may be drawn on it afterwards
 * @param {{ audit?: boolean, allowStructTree?: boolean, externalize?: boolean, compact?: boolean,
 *           save?: { useObjectStreams?: boolean, objectsPerTick?: number } }} [options]
 * @returns {Promise<{ bytes: Uint8Array, audit: string[], sweep: { before: number, after: number, removed: number },
 *                     xobjectKeysDropped: number, pageDictsExternalized: number }>}
 */
export async function finishDocument(outDoc, options = {}) {
  const xobjectKeysDropped = stripXObjectBaggage(outDoc);
  const pageDictsExternalized = options.externalize === false ? 0 : externalizePageDicts(outDoc);
  await outDoc.flush(); // the ONE flush: fonts and images become objects here; nothing is drawn after it
  const swept = await collectGarbage(outDoc, { flush: false });
  const audit = auditOutput(outDoc, { allowStructTree: options.allowStructTree === true });
  if (audit.length && options.audit !== false) {
    throw new PdfEditorError("EXPORT_AUDIT_FAILED", { count: audit.length, problems: audit.slice(0, 10) }, { detail: audit.slice(0, 3).join("; ") });
  }
  if (options.compact) compactObjectNumbers(outDoc);
  const bytes = await outDoc.save({
    useObjectStreams: options.save?.useObjectStreams ?? true,
    objectsPerTick: options.save?.objectsPerTick ?? Number.MAX_SAFE_INTEGER, // no timers inside the writer
    addDefaultPage: false,
    updateFieldAppearances: false // never let save() re-render fields: it would create objects after the sweep
  });
  return { bytes, audit, sweep: { before: swept.before, after: swept.after, removed: swept.removed }, xobjectKeysDropped, pageDictsExternalized };
}

/** Warnings and facts of one loaded source. */
function describeSource(source, report) {
  const { id, facts } = source;
  const warn = (code, params) => report.warnings.push(warning(code, { source: id, ...params }));
  if (facts.repair.repaired) warn("EXPORT_STREAMS_REPAIRED", { streams: facts.repair.repaired });
  if (facts.repair.failed.length) warn("EXPORT_STREAMS_DAMAGED", { streams: facts.repair.failed.length });
  if (facts.pageTree.leavesFixed || facts.pageTree.nodesFixed) warn("EXPORT_PAGE_TREE_REPAIRED", { pages: facts.pageTree.leavesFixed + facts.pageTree.nodesFixed });
  if (facts.invalidObjects) warn("EXPORT_OBJECTS_UNPARSED", { objects: facts.invalidObjects });
  const signatures = Math.max(facts.signatures.count, source.form.signedFields);
  if (signatures) warn("EXPORT_SOURCE_SIGNED", { signatures });
  if (source.outline.truncated) warn("EXPORT_OUTLINE_TRUNCATED", { items: source.outline.count });
  if (source.form.hasXFA) warn("EXPORT_XFA_DROPPED", {});
  return {
    pages: facts.pages,
    kept: 0,
    encrypted: facts.encrypted,
    version: facts.version,
    signatures,
    certified: facts.signatures.docMDP,
    repair: { problems: facts.repair.problems, repaired: facts.repair.repaired, failed: facts.repair.failed.length },
    pageTreeRepaired: facts.pageTree.leavesFixed + facts.pageTree.nodesFixed,
    invalidObjects: facts.invalidObjects,
    xref: facts.xref, // "sections", or "scan": the file has no usable cross-reference section
    tagged: source.tagged, // the structure tree is not carried over: the output is untagged
    form: source.form,
    attachments: source.attachments.length,
    outline: { items: source.outline.count, kept: 0, dropped: 0, retargeted: 0, truncated: source.outline.truncated },
    info: { ...source.info }
  };
}

const INFO_KEYS = ["title", "author", "subject", "keywords", "creator"];

/** The web addresses of mapped outline items, written out in full against the base of their source. */
function absoluteAddresses(items, base) {
  for (const item of items) {
    if (item.action && item.action.kind === "uri") item.action = { ...item.action, uri: resolveUri(item.action.uri, base) };
    absoluteAddresses(item.children, base);
  }
}

/**
 * The document information of the output. For each key: what the plan says (an empty string clears it), else
 * what the viewer read from the first source that contributes pages (`source.info`), else what the writer
 * read. The second step exists because the library loses /Info of an encrypted file with a cross-reference
 * stream, while pdf.js reads it.
 */
function resolveInfo(plan, primary) {
  const info = {};
  const viewer = (primary && primary.given.info) || {};
  const writer = (primary && primary.info) || {};
  for (const key of INFO_KEYS) {
    const chosen = [plan.info ? plan.info[key] : undefined, viewer[key], writer[key]].find((value) => typeof value === "string");
    if (chosen) info[key] = chosen;
  }
  const created = [viewer.creationDate, writer.creationDate].find((value) => value instanceof Date && !Number.isNaN(value.getTime()));
  if (created) info.creationDate = created;
  return info;
}

/**
 * @typedef {object} ExportPlan
 * @property {Array<{ id: string, bytes: Uint8Array, password?: string, expectedPages?: number, info?: object }>} sources
 *           expectedPages = the page count the VIEWER (pdf.js) shows; info = the document information the viewer read
 * @property {Array<{ source: string, index: number, rotate?: number } | { blank: [number, number], rotate?: number }>} pages
 *           the output pages in order; `rotate` = EXTRA clockwise rotation (0 / 90 / 180 / 270), added to /Rotate
 * @property {{ title?: string, author?: string, subject?: string, keywords?: string, creator?: string }} [info]
 * @property {boolean} [outline]      rebuild bookmarks (default true)
 * @property {boolean} [dropOrphanBookmarks]  drop a bookmark whose own page was removed although bookmarks
 *           below it are kept, and lift those one level (default false: it stays, and the report names it)
 * @property {boolean} [forms]        keep form fields (default true)
 * @property {boolean} [attachments]  carry the document-level attachments over (default false)
 * @property {boolean} [pageLabels]   default true
 * @property {boolean} [pruneResources]  default true (pruneResources.js)
 * @property {string}  [producer]
 * @property {Date}    [now]          the clock (default: new Date())
 * @property {Uint8Array} [idSeed]    deterministic trailer /ID (default: random)
 * @property {(context: { outDoc: any, pages: any[], sources: Map<string, object>, report: object }) => Promise<void> | void} [edit]
 *           runs when all pages are in place and before the structure is rebuilt: everything that draws
 * @property {{ useObjectStreams?: boolean, objectsPerTick?: number }} [save]
 * @property {boolean} [compact]      renumber objects 1..N at the end (default false)
 * @property {boolean} [audit]        throw when the structural self-check finds something (default true)
 * @property {{ outlineItems?: number }} [limits]
 * @property {AbortSignal} [signal]
 * @property {(fraction: number, stage: string) => void} [onProgress]
 */

/**
 * @param {ExportPlan} plan
 * @returns {Promise<{ bytes: Uint8Array, report: object }>}
 */
export async function exportDocument(plan) {
  const started = clock();
  const usedIds = checkPlan(plan);
  const now = plan.now instanceof Date ? plan.now : new Date();
  const report = { pageCount: 0, bytes: 0, warnings: [], timings: {}, fontsEmbedded: [], sources: {} };
  const tick = createPacer(plan);
  let stage = STAGES[0];
  const timed = async (name, work) => {
    stage = name;
    const from = clock();
    try {
      return await work();
    } finally {
      report.timings[name] = (report.timings[name] || 0) + Math.round(clock() - from);
    }
  };
  /** Anything unexpected while a source is read is that source's damage. */
  const withSource = async (id, work) => {
    try {
      return await work();
    } catch (cause) {
      if (isPdfEditorError(cause)) throw cause;
      throw new PdfEditorError("EXPORT_SOURCE_DAMAGED", { source: id }, { cause, detail: "the source could not be processed" });
    }
  };

  try {
    // 1 + 2. load every used source for THIS export and read its document-level structure while it is pristine
    const sources = new Map();
    const usedSources = plan.sources.filter((source) => usedIds.has(source.id));
    await timed("load", async () => {
      let done = 0;
      for (const given of usedSources) {
        await tick((0.35 * done) / usedSources.length, "load");
        const source = await withSource(given.id, async () => {
          const { doc, facts } = await loadForEdit(given.bytes, { password: given.password, source: given.id });
          if (given.expectedPages !== undefined && given.expectedPages !== facts.pages) {
            // the viewer and the writer disagree about the pages: every index would be wrong
            throw new PdfEditorError("EXPORT_PAGE_COUNT_MISMATCH", { source: given.id, writer: facts.pages, viewer: given.expectedPages });
          }
          const resolver = createDestResolver(doc);
          return {
            id: given.id,
            given,
            doc,
            facts,
            resolver,
            outline: plan.outline === false ? { items: [], count: 0, truncated: false } : readOutline(doc, { resolver, maxItems: plan.limits?.outlineItems }),
            info: readInfo(doc),
            settings: readCatalogSettings(doc),
            labels: plan.pageLabels === false ? null : readPageLabels(doc),
            form: describeAcroForm(doc),
            attachments: listAttachments(doc),
            tagged: doc.catalog.has(N("StructTreeRoot")),
            copy: null,
            cursor: 0
          };
        });
        sources.set(given.id, source);
        report.sources[given.id] = describeSource(source, report);
        done += 1;
      }
    });
    plan.pages.forEach((entry, page) => {
      if (entry.blank === undefined && entry.index >= sources.get(entry.source).facts.pages) throw invalidJob("page-index", { page, source: entry.source });
    });

    // Relative link addresses are resolved against the /URI base of their document. The output can carry ONE
    // base: when the sources do not all have the same, it carries none and the addresses are written out.
    const sameBase = new Set([...sources.values()].map((source) => source.settings.uriBase)).size <= 1;

    // 3. copy the kept pages of each source with ONE copier per source
    const outDoc = await PDFDocument.create({ updateMetadata: false });
    await timed("copy", async () => {
      let done = 0;
      for (const source of sources.values()) {
        await tick(0.35 + (0.2 * done) / sources.size, "copy");
        const indices = plan.pages.filter((entry) => entry.source === source.id).map((entry) => entry.index);
        source.copy = await withSource(source.id, () => copyPagesSafe(source.doc, indices, outDoc, {
          resolver: source.resolver,
          keepForms: plan.forms !== false,
          pruneResources: plan.pruneResources !== false,
          resolveUriBase: sameBase ? undefined : source.settings.uriBase
        }));
        const facts = report.sources[source.id];
        facts.kept = indices.length;
        facts.copy = source.copy.report;
        const unresolved = source.copy.report.resources.unresolved.length;
        if (unresolved) report.warnings.push(warning("EXPORT_RESOURCES_NOT_PRUNED", { source: source.id, pages: unresolved }));
        if (plan.attachments !== true && source.attachments.length) {
          report.warnings.push(warning("EXPORT_ATTACHMENTS_DROPPED", { source: source.id, files: source.attachments.length }));
        }
        done += 1;
      }
    });

    // 4. the output page sequence
    const pages = [];
    const labels = [];
    for (const entry of plan.pages) {
      let page;
      if (entry.blank !== undefined) {
        page = outDoc.addPage([entry.blank[0], entry.blank[1]]);
        labels.push(null);
      } else {
        const source = sources.get(entry.source);
        page = outDoc.addPage(source.copy.pages[source.cursor]);
        source.cursor += 1;
        labels.push(source.labels ? source.labels[entry.index] : null);
      }
      if (entry.rotate) {
        // the user's rotation goes into /Rotate; objects are stored in user space and turn with the page
        page.node.set(N("Rotate"), PDFNumber.of(normalizeRightAngle(pageGeometry(page).rotate + entry.rotate)));
      }
      pages.push(page);
    }

    // 5. everything that draws
    if (plan.edit) {
      await timed("draw", async () => {
        await tick(0.55, "draw");
        await plan.edit({ outDoc, pages, sources, report, tick: (fraction) => tick(0.55 + 0.2 * Math.min(1, Math.max(0, fraction)), "draw") });
      });
    }

    // 6. document-level structure
    const copied = [...sources.values()];
    await timed("structure", async () => {
      await tick(0.75, "structure");
      if (plan.outline !== false) {
        const items = [];
        for (const source of copied) {
          const mapped = mapOutline(source.outline.items, (index) => source.copy.firstCopyOf.get(index)?.ref, { dropOrphans: plan.dropOrphanBookmarks === true });
          if (!sameBase && source.settings.uriBase) absoluteAddresses(mapped.items, source.settings.uriBase);
          items.push(...mapped.items);
          Object.assign(report.sources[source.id].outline, { kept: mapped.kept, dropped: mapped.dropped, retargeted: mapped.retargeted });
          // the title of such a bookmark is text about a page that was removed: the interface should say so
          if (mapped.retargeted) report.warnings.push(warning("EXPORT_OUTLINE_RETARGETED", { source: source.id, items: mapped.retargeted }));
        }
        report.outline = writeOutline(outDoc, items);
      }
      if (plan.forms !== false) {
        report.form = rebuildAcroForm(outDoc, copied.map((source) => ({ srcDoc: source.doc, copier: source.copy.copier, survivingFieldRoots: source.copy.survivingFieldRoots, label: source.id })));
      }
      report.optionalContent = rebuildOptionalContent(outDoc, copied.map((source) => ({ srcDoc: source.doc, copier: source.copy.copier })));
      if (plan.pageLabels !== false) report.pageLabelRanges = writePageLabels(outDoc, labels);
      if (plan.attachments === true) {
        report.attachments = copyAttachments(outDoc, copied.map((source) => ({ srcDoc: source.doc, copier: source.copy.copier })));
      }
      // the first source in plan.sources that contributes a page lends its settings and its information
      const primary = copied[0];
      const info = resolveInfo(plan, primary);
      const producer = plan.producer || DEFAULT_PRODUCER;
      const settings = primary ? { ...primary.settings, uriBase: sameBase ? primary.settings.uriBase : undefined } : {};
      writeCatalogSettings(outDoc, settings, { hasOutline: outDoc.catalog.has(N("Outlines")) });
      writeInfo(outDoc, info, { producer, now });
      writeXmp(outDoc, info, { producer, now });
      report.id = setDocumentId(outDoc, plan.idSeed);
    });

    // 7. clean up, flush once, sweep, check, save
    const finished = await timed("save", async () => {
      await tick(0.8, "save");
      return finishDocument(outDoc, { audit: plan.audit, compact: plan.compact, externalize: plan.externalizePageDicts, save: plan.save });
    });
    report.audit = finished.audit;
    report.sweep = finished.sweep;
    report.xobjectKeysDropped = finished.xobjectKeysDropped;
    report.pageDictsExternalized = finished.pageDictsExternalized;
    report.pageCount = pages.length;
    report.bytes = finished.bytes.length;
    report.timings.total = Math.round(clock() - started);
    await tick(1, "save");
    return { bytes: finished.bytes, report };
  } catch (cause) {
    if (isPdfEditorError(cause)) throw cause;
    throw unexpected(cause, stage);
  }
}

/**
 * EXPORT_FAILED for anything that is not one of the engine's own errors. The message of the original error
 * may quote bytes or names of the document: it stays in `cause` and never becomes part of this message.
 */
export function unexpected(cause, stage) {
  const kind = cause instanceof Error ? cause.name : typeof cause;
  return new PdfEditorError("EXPORT_FAILED", { stage }, { cause, detail: `unexpected ${kind} in stage "${stage}"` });
}
