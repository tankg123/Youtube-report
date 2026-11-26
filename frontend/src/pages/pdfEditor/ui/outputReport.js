// What the editor asks before it builds an output, what it decides when the build comes back, and what it
// says afterwards (UX specification 7.7, 7.8 and 8). Pure functions over the document state and the report of
// the pipeline (engine/pipeline buildOutput): no DOM, no React. tests/pdfUiOutputReport.test.mjs.
//
//   before the build    planOutput(state, ...)        what will be redacted, blurred, replaced, turned into
//                                                     pictures; signatures that will not be kept
//                       describePlan(plan, purpose)   the sentences of the dialog (ui/dialogs/ExportDialog.jsx)
//                       buildChoices(...)             the choices of the dialog as options of the build
//   when it comes back  summarizeReport(report)       per page: what happened to its marks
//                       reviewFindings(summary, ...)  removed content that is STILL in the file, with the remedy
//                                                     the editor can offer for each finding: what marks did not
//                                                     reach (a covered line, text repeated elsewhere, letter
//                                                     shapes in a font) and what is left of REMOVED PAGES
//                                                     (bookmarks kept for their children, data that may travel
//                                                     with the pages that stay)
//                       describeReview(...)           the sentences of ui/dialogs/ExportReviewDialog.jsx
//                       applyRemedies(...)            the remedies the user chose, as options of the next build
//   after delivery      describeReport(...)           the sentences of ui/dialogs/ReportDialog.jsx
//   a failed build      describeFailure(...)          ui/dialogs/ExportFailedDialog.jsx
//
// Page indexes in a report are 0-based indexes of the OUTPUT; the user reads page numbers of the working
// document (for an extract: `pageNumbers`, the numbers of the extracted pages in output order).
import { t } from "../../../i18n/index.js";
import { pendingMarks, replacedTexts, sourcesInUse } from "../model/selectors.js";
import { normalizeFileName } from "../model/store.js";
import { outputBaseName } from "./fileNames.js";

/** A build that ends with one of these looked at its own result and refused it: nothing exists to hand out. */
export const VERIFICATION_CODES = Object.freeze(["REDACT_VERIFICATION_FAILED", "PIPELINE_SELF_CHECK_FAILED", "EXPORT_AUDIT_FAILED"]);
/** The remedies the editor can apply by building again. */
export const REMEDIES = Object.freeze(["removeCovered", "removeBookmarks", "removeProperties", "convertPages", "removeOrphanBookmarks"]);
/** Warnings of the export engine that say something of a REMOVED PAGE is still in the file. */
const ORPHAN_BOOKMARKS = "EXPORT_OUTLINE_RETARGETED";
const REMOVED_PAGE_DATA = "EXPORT_RESOURCES_NOT_PRUNED";
/** Where removed text can be repeated (REDACT_TEXT_ELSEWHERE `where`) -> the remedy that takes that place out of the file. */
const ELSEWHERE_REMEDY = Object.freeze({ outline: "removeBookmarks", metadata: "removeProperties" });
/** Warnings the rows of the report already tell. */
const TOLD_BY_ROWS = Object.freeze(["PIPELINE_PAGES_RASTERIZED", "PIPELINE_PAGES_RASTERIZED_ON_REQUEST"]);
const DOCUMENT_PROPERTIES = Object.freeze(["title", "author", "subject", "keywords"]);
const MAX_CHARACTERS = 12;

const isEntry = (entry) => Boolean(entry) && typeof entry.code === "string";
const listOf = (value) => (Array.isArray(value) ? value : []);
const unique = (values) => [...new Set(values)];
const ascending = (values) => unique(values).sort((first, second) => first - second);

// --- before the build -------------------------------------------------------------------------------------------

/**
 * What an output of this document will contain that the user should know about before it is built.
 * @param {object} state            the DocumentState of the store
 * @param {object} [options]
 * @param {string[] | null} [options.pageIds]   only these pages (an extract)
 * @param {(textObject: object) => ({ ok: boolean, unsupported?: Array<{ char: string }> } | null)} [options.checkText]
 *        textService.check: tells whether a text box can be written with the bundled fonts
 * @param {(sourceId: string) => number} [options.outlineOf]   how many bookmarks a source has (viewer facts)
 * @param {(sourceId: string) => boolean} [options.restrictedOf]   the file is protected: its author limited changes,
 *        or it is encrypted (viewer facts). The copy that is made carries neither.
 * @returns {{
 *   pageNumbers: number[] | null, redact: number, blur: number, marks: number, markPages: number,
 *   replaced: number, signatures: number, restricted: boolean, hasProperties: boolean, hasOutline: boolean,
 *   pictureText: Array<{ id: string, pageNumber: number, characters: string[] }>
 * }}
 */
export function planOutput(state, { pageIds = null, checkText = null, outlineOf = null, restrictedOf = null } = {}) {
  const wanted = Array.isArray(pageIds) ? new Set(pageIds) : null;
  const inScope = (row) => !wanted || wanted.has(row.pageId);
  const marks = pendingMarks(state).filter(inScope);
  const pages = wanted ? state.pages.filter((page) => wanted.has(page.id)) : state.pages;
  const sources = sourcesInUse({ ...state, pages });
  const pictureText = [];
  if (typeof checkText === "function") {
    state.pages.forEach((page, pageIndex) => {
      if (wanted && !wanted.has(page.id)) return;
      for (const id of page.objectIds) {
        const object = state.objects[id];
        if (object?.type !== "text") continue;
        let verdict;
        try {
          verdict = checkText(object);
        } catch {
          verdict = null; // the fonts are not known yet: the report of the build tells
        }
        if (!verdict || verdict.ok !== false) continue;
        pictureText.push({ id, pageNumber: pageIndex + 1, characters: unique(listOf(verdict.unsupported).map((entry) => String(entry?.char ?? "")).filter(Boolean)) });
      }
    });
  }
  return {
    pageNumbers: wanted ? state.pages.map((page, index) => (wanted.has(page.id) ? index + 1 : 0)).filter(Boolean) : null,
    redact: marks.filter((mark) => mark.type === "redact").length,
    blur: marks.filter((mark) => mark.type === "blur").length,
    marks: marks.length,
    markPages: new Set(marks.map((mark) => mark.pageId)).size,
    replaced: replacedTexts(state).filter(inScope).length,
    signatures: sources.reduce((sum, source) => sum + (source.signatureCount || 0), 0),
    restricted: typeof restrictedOf === "function" && sources.some((source) => Boolean(restrictedOf(source.id))),
    hasProperties: sources.length > 0 && DOCUMENT_PROPERTIES.some((key) => Boolean(sources[0].info?.[key])),
    hasOutline: typeof outlineOf === "function" && sources.some((source) => Number(outlineOf(source.id)) > 0),
    pictureText
  };
}

/** True when something has to be asked before the build: marks that will be applied, or text that becomes a picture. */
export const planNeedsQuestion = (plan) => plan.marks > 0 || plan.pictureText.length > 0;

/** The base name (no ".pdf") the output of a plan gets by default: "-redacted" only when marks will be applied. */
export function suggestedBaseName(fileName, purpose, plan) {
  return outputBaseName({ fileName, purpose, original: false, usedRedaction: plan.marks > 0, pageNumbers: plan.pageNumbers });
}

/** The characters of all text boxes that no bundled font writes, at most twelve of them, as one string. */
export function pictureCharacters(pictureText) {
  const all = unique(pictureText.flatMap((entry) => entry.characters));
  return all.slice(0, MAX_CHARACTERS).join(" ") + (all.length > MAX_CHARACTERS ? " …" : "");
}

const PURPOSE_TEXTS = {
  download: () => ({ redact: t("Apply redactions and download"), confirmRedact: t("Apply and download"), plain: t("Download options"), confirm: t("Download"), asItIs: t("Download as it is") }),
  print: () => ({ redact: t("Apply redactions and print"), confirmRedact: t("Apply and print"), plain: t("Print options"), confirm: t("Print"), asItIs: t("Print as it is") }),
  sign: () => ({ redact: t("Apply redactions and sign"), confirmRedact: t("Apply and continue"), plain: t("Before the document is signed"), confirm: t("Continue"), asItIs: t("Continue as it is") }),
  extract: () => ({ redact: t("Apply redactions and extract"), confirmRedact: t("Apply and extract"), plain: t("Extract options"), confirm: t("Extract"), asItIs: t("Use the file as it is") })
};
const purposeTexts = (purpose) => (PURPOSE_TEXTS[purpose] || PURPOSE_TEXTS.download)();

/**
 * The sentences of the dialog that guards an output (ui/dialogs/ExportDialog.jsx).
 * @returns {{ redaction: boolean, title: string, confirmLabel: string, warning: string | null, blurNote: string | null,
 *   facts: string[], pending: string | null, signatures: string | null, restricted: string | null, pictures: string | null }}
 */
export function describePlan(plan, purpose = "download") {
  const texts = purposeTexts(purpose);
  const redaction = plan.marks > 0;
  const facts = [];
  if (plan.redact) facts.push(t("Areas that will be redacted: {count}", { count: plan.redact }));
  if (plan.blur) facts.push(t("Areas that will be blurred: {count}", { count: plan.blur }));
  if (redaction) facts.push(t("Pages with marked areas: {count}", { count: plan.markPages }));
  if (plan.replaced) facts.push(t("Text lines you replaced: {count}", { count: plan.replaced }));
  let pictures = null;
  if (plan.pictureText.length) {
    const characters = pictureCharacters(plan.pictureText);
    pictures =
      plan.pictureText.length === 1
        ? t("1 text box contains characters that none of the editor's fonts can write ({characters}). It will be put into the file as a picture: its text cannot be selected or searched there.", { characters })
        : t("{count} text boxes contain characters that none of the editor's fonts can write ({characters}). They will be put into the file as pictures: their text cannot be selected or searched there.", { count: plan.pictureText.length, characters });
  }
  let signatures = null;
  if (plan.signatures === 1) signatures = t("The existing signature is not kept in the edited copy.");
  else if (plan.signatures > 1) signatures = t("The {count} existing signatures are not kept in the edited copy.", { count: plan.signatures });
  return {
    redaction,
    title: redaction ? texts.redact : plan.pictureText.length ? t("Text that will be exported as pictures") : texts.plain,
    confirmLabel: redaction ? texts.confirmRedact : texts.confirm,
    warning: !redaction
      ? null
      : purpose === "download"
        ? t("Redaction permanently removes the marked content from the downloaded file. It cannot be recovered from that file. Your original file is not changed.")
        : t("Redaction permanently removes the marked content from the file that is created. It cannot be recovered from that file. Your original file is not changed."),
    blurNote: plan.blur ? t("A blurred area is replaced by a blurred picture of it: the content under it is removed as well.") : null,
    facts,
    pending: redaction ? t("In the editor the marks stay pending, so you can still correct them and create the file again.") : null,
    signatures,
    restricted: plan.restricted ? t("The copy that is created is not protected: the restrictions and the password protection of the original are not in it.") : null,
    pictures
  };
}

/** True for an `info` override that removes every document property ({} or only empty values). */
export const stripsProperties = (info) => info !== undefined && (info === null || (typeof info === "object" && DOCUMENT_PROPERTIES.every((key) => !info[key])));

/**
 * The choices of the export dialog as options of the build.
 * @param {{ removeProperties?: boolean, removeBookmarks?: boolean }} choices
 * @param {{ info?: object | null, pipeline: object }} options   what the caller of buildOutput() asked for
 * @returns {{ info: object | null | undefined, pipeline: object }} a choice only ever removes MORE than the caller asked
 */
export function buildChoices(choices, { info, pipeline = {} } = {}) {
  const next = { info, pipeline: { ...pipeline } };
  if (choices?.removeProperties) next.info = {};
  if (choices?.removeBookmarks) next.pipeline.keepOutline = false;
  return next;
}

// --- when the build comes back ---------------------------------------------------------------------------------------

/** True when redact or blur marks were applied (replaced text lines alone do not make a file "redacted"). */
export function appliedStrictMarks(report) {
  const targets = report?.redaction?.targets;
  if (Array.isArray(targets)) return targets.some((target) => target?.mode !== "erase");
  return Boolean(report?.usedRedaction);
}

/**
 * The report of the pipeline, arranged for the user.
 * @param {object | null} report   report of engine/pipeline buildOutput()
 * @param {{ pageNumbers?: number[] | null }} [options]   page numbers of an extract, in output order
 * @returns {{
 *   usedMarks: boolean,
 *   rows: Array<{ pageIndex: number, pageNumber: number, areas: number, replacedLines: number, covered: number,
 *                 path: "precise" | "raster" | "untouched", onRequest: boolean, reasons: Array<{ code, params }> }>,
 *   covered: { count: number, pageNumbers: number[] },
 *   elsewhere: Array<{ where: string, count: number }>,
 *   fonts: Array<{ font: string, pageIndexes: number[], pageNumbers: number[], convertible: number[], convertibleNumbers: number[] }>,
 *   orphanBookmarks: number,      bookmarks of removed pages that are still in the file (kept for their children)
 *   removedPageData: Array<{ code, params }>,   kept pages that may still carry data of removed pages
 *   pictureText: number,
 *   warnings: Array<{ code, params }>
 * }}
 */
export function summarizeReport(report, { pageNumbers = null } = {}) {
  const numberOf = (pageIndex) => (Array.isArray(pageNumbers) && Number.isInteger(pageNumbers[pageIndex]) ? pageNumbers[pageIndex] : pageIndex + 1);
  const redaction = report?.redaction && typeof report.redaction === "object" ? report.redaction : null;
  const targets = listOf(redaction?.targets);
  const rows = [];
  for (const page of listOf(redaction?.pages)) {
    if (!page || !Number.isInteger(page.pageIndex)) continue;
    const own = targets.filter((target) => target?.pageIndex === page.pageIndex);
    const areas = Number.isInteger(page.areas) ? page.areas : own.filter((target) => target.mode !== "erase").length;
    const replacedLines = Number.isInteger(page.replacedLines) ? page.replacedLines : own.filter((target) => target.mode === "erase").length;
    // a page without marks is only worth a row when it became a picture (on request: options.rasterPages)
    if (!areas && !replacedLines && page.path !== "raster") continue;
    const reasons = listOf(page.reasons).filter(isEntry);
    rows.push({
      pageIndex: page.pageIndex,
      pageNumber: numberOf(page.pageIndex),
      areas,
      replacedLines,
      covered: own.filter((target) => target.outcome === "cover-needed").length,
      path: ["precise", "raster", "untouched"].includes(page.path) ? page.path : "untouched",
      onRequest: reasons.some((entry) => entry.code === "REDACT_RASTER_FORCED"),
      reasons: reasons.filter((entry) => entry.code !== "REDACT_RASTER_FORCED").map((entry) => ({ code: entry.code, params: entry.params || {} }))
    });
  }
  const coveredTargets = targets.filter((target) => target?.outcome === "cover-needed");
  // every page of the output can be turned into a picture (the redaction engine takes them as env.rasterPages,
  // with or without marks); one that was asked for and did not become one is not offered again
  const pageCount = Number.isInteger(report?.pageCount) && report.pageCount > 0 ? report.pageCount : Infinity;
  const refused = new Set(listOf(redaction?.rasterPagesNotApplied));
  const rasterized = new Set(rows.filter((row) => row.path === "raster").map((row) => row.pageIndex));
  const warnings = listOf(report?.warnings)
    .filter(isEntry)
    .map((entry) => ({ code: entry.code, params: entry.params || {} }));
  return {
    usedMarks: appliedStrictMarks(report),
    rows,
    covered: { count: coveredTargets.length, pageNumbers: ascending(coveredTargets.map((target) => numberOf(target.pageIndex))) },
    elsewhere: listOf(redaction?.elsewhere)
      .filter((entry) => entry && Number(entry.count) > 0)
      .map((entry) => ({ where: String(entry.where || "other"), count: Number(entry.count) })),
    fonts: listOf(redaction?.fontsNotCleaned)
      .filter((entry) => entry && Array.isArray(entry.pageIndexes))
      .map((entry) => {
        const convertible = ascending(entry.pageIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < pageCount && !refused.has(index) && !rasterized.has(index)));
        return {
          font: String(entry.font ?? ""),
          pageIndexes: ascending(entry.pageIndexes),
          pageNumbers: ascending(entry.pageIndexes.map(numberOf)),
          convertible,
          convertibleNumbers: convertible.map(numberOf)
        };
      }),
    orphanBookmarks: warnings.filter((entry) => entry.code === ORPHAN_BOOKMARKS).reduce((sum, entry) => sum + (Number.isFinite(entry.params.items) && entry.params.items > 0 ? entry.params.items : 1), 0),
    removedPageData: warnings.filter((entry) => entry.code === REMOVED_PAGE_DATA),
    pictureText: listOf(report?.rasterizedTextObjectIds).length,
    warnings
  };
}

/**
 * Removed content that is still in the file that was just built, each with the remedy the editor can offer.
 * @param {object} summary   summarizeReport()
 * @param {{ applied?: object }} [options]   applied: the remedies that were in force for THIS build
 *        ({ removeCovered, removeBookmarks, removeProperties, convertPages: number[] }): one that did not help
 *        is not offered a second time
 * @returns {{ needed: boolean, items: Array<{ id: string, kind: "covered" | "elsewhere" | "font" | "bookmarks" | "removedPages",
 *             remedy: string | null, count: number, where?: string, font?: string, pageNumbers?: number[],
 *             pageIndexes?: number[], convertNumbers?: number[], warning?: { code, params } }> }}
 *          (font: pageIndexes / convertNumbers = the pages a build can convert; removedPages: warning = what the
 *          export engine reported, for the sentence of messages.js)
 */
export function reviewFindings(summary, { applied = {} } = {}) {
  const items = [];
  if (summary.covered.count > 0) {
    items.push({ id: "covered", kind: "covered", remedy: applied.removeCovered ? null : "removeCovered", count: summary.covered.count, pageNumbers: summary.covered.pageNumbers });
  }
  for (const entry of summary.elsewhere) {
    const remedy = ELSEWHERE_REMEDY[entry.where] || null;
    items.push({ id: `elsewhere-${entry.where}`, kind: "elsewhere", where: entry.where, remedy: remedy && !applied[remedy] ? remedy : null, count: entry.count });
  }
  const tried = new Set(listOf(applied.convertPages));
  for (const entry of summary.fonts) {
    const pageIndexes = entry.convertible.filter((index) => !tried.has(index));
    const convertNumbers = entry.convertibleNumbers.filter((number, position) => !tried.has(entry.convertible[position]));
    items.push({ id: `font-${entry.font}`, kind: "font", font: entry.font, remedy: pageIndexes.length ? "convertPages" : null, count: entry.pageIndexes.length, pageNumbers: entry.pageNumbers, pageIndexes, convertNumbers });
  }
  // what is left of pages the user REMOVED: the titles of their bookmarks (the engine keeps such a bookmark when
  // bookmarks of kept pages hang under it), and data that may still travel with kept pages
  if (summary.orphanBookmarks > 0) {
    items.push({ id: "bookmarks", kind: "bookmarks", remedy: applied.removeOrphanBookmarks || applied.removeBookmarks ? null : "removeOrphanBookmarks", count: summary.orphanBookmarks });
  }
  listOf(summary.removedPageData).forEach((warning, index) => {
    items.push({ id: `removed-pages-${index}`, kind: "removedPages", remedy: null, count: Number.isFinite(warning.params?.pages) ? warning.params.pages : 0, warning });
  });
  return { needed: items.length > 0, items };
}

/**
 * The remedies the user chose, as the options of the next build.
 * @param {string[]} chosen                 remedies of REMEDIES
 * @param {object} findings                 reviewFindings()
 * @param {{ info, pipeline: object, applied: object }} current
 * @returns {{ info, pipeline: object, applied: object }}
 */
export function applyRemedies(chosen, findings, { info, pipeline = {}, applied = {} } = {}) {
  const next = { info, pipeline: { ...pipeline }, applied: { ...applied } };
  const wanted = new Set(listOf(chosen).filter((remedy) => findings.items.some((item) => item.remedy === remedy)));
  if (wanted.has("removeCovered")) {
    next.pipeline.eraseFallback = "redact";
    next.applied.removeCovered = true;
  }
  if (wanted.has("removeBookmarks")) {
    next.pipeline.keepOutline = false;
    next.applied.removeBookmarks = true;
  }
  if (wanted.has("removeProperties")) {
    next.info = {};
    next.applied.removeProperties = true;
  }
  if (wanted.has("convertPages")) {
    const pages = findings.items.filter((item) => item.remedy === "convertPages").flatMap((item) => item.pageIndexes);
    next.pipeline.rasterPages = ascending([...listOf(pipeline.rasterPages), ...pages]);
    next.applied.convertPages = ascending([...listOf(applied.convertPages), ...pages]);
  }
  if (wanted.has("removeOrphanBookmarks")) {
    next.pipeline.dropOrphanBookmarks = true;
    next.applied.removeOrphanBookmarks = true;
  }
  return next;
}

/** The remedies that are in force from the options alone (before any review). */
export function appliedFromOptions({ info, pipeline = {} } = {}) {
  return {
    removeCovered: pipeline.eraseFallback === "redact",
    removeBookmarks: pipeline.keepOutline === false,
    removeProperties: stripsProperties(info),
    convertPages: listOf(pipeline.rasterPages).slice(),
    removeOrphanBookmarks: pipeline.dropOrphanBookmarks === true
  };
}

const pageList = (numbers) => numbers.join(", ");

/**
 * The sentences of the question "removed content is still in this file" (ui/dialogs/ExportReviewDialog.jsx).
 * @param {object} findings   reviewFindings()
 * @param {string} purpose
 * @param {(warning: { code, params }) => string} describeWarning   messages.describeWarning
 * @returns {{ title: string, lead: string, items: Array<{ id, text: string, remedy: string | null, choice: string | null }>,
 *             deliverLabel: string, applyLabel: string, note: string }}
 */
export function describeReview(findings, purpose, describeWarning) {
  const items = findings.items.map((item) => {
    if (item.kind === "covered") {
      return {
        id: item.id,
        remedy: item.remedy,
        text:
          item.count === 1
            ? t("1 text line you replaced could only be covered (page {pages}): the old text is hidden under the new text, but it is still in the file.", { pages: pageList(item.pageNumbers) })
            : t("{count} text lines you replaced could only be covered (pages {pages}): the old text is hidden under the new text, but it is still in the file.", { count: item.count, pages: pageList(item.pageNumbers) }),
        choice: item.remedy ? t("Remove the old text for real (these pages may be converted to images)") : null
      };
    }
    if (item.kind === "font") {
      return {
        id: item.id,
        remedy: item.remedy,
        text: describeWarning({ code: "REDACT_FONT_GLYPHS_REMAIN", params: { font: item.font, pages: item.count } }),
        choice: item.remedy ? t("Convert these pages to images: {pages}", { pages: pageList(item.convertNumbers) }) : null
      };
    }
    if (item.kind === "bookmarks") {
      return {
        id: item.id,
        remedy: item.remedy,
        text:
          item.count === 1
            ? t("1 bookmark of a page you removed is still in the file, because bookmarks of the remaining pages are grouped under it. Its title can still be read there.")
            : t("{count} bookmarks of pages you removed are still in the file, because bookmarks of the remaining pages are grouped under them. Their titles can still be read there.", { count: item.count }),
        choice: item.remedy ? t("Remove these bookmarks (the bookmarks under them move up one level)") : null
      };
    }
    if (item.kind === "removedPages") return { id: item.id, remedy: null, text: describeWarning(item.warning), choice: null };
    if (item.where === "outline") {
      return { id: item.id, remedy: item.remedy, text: t("Text you redacted also appears in the bookmarks of the document (places: {count}).", { count: item.count }), choice: item.remedy ? t("Leave the bookmarks out of the file") : null };
    }
    if (item.where === "metadata") {
      return { id: item.id, remedy: item.remedy, text: t("Text you redacted also appears in the document properties, such as the title or the author (places: {count}).", { count: item.count }), choice: item.remedy ? t("Leave the document properties out of the file") : null };
    }
    return { id: item.id, remedy: null, text: describeWarning({ code: "REDACT_TEXT_ELSEWHERE", params: { where: item.where, count: item.count } }), choice: null };
  });
  const offers = items.some((item) => item.remedy);
  return {
    title: t("Removed content is still in the file"),
    lead: t("The file was created, but it has not been handed out yet. Something you removed can still be found in it:"),
    items,
    note: offers ? t("Choose what the editor should do about it. The file is then created again.") : t("The editor cannot remove this for you. Cancel to change the document first, or continue if this is acceptable."),
    deliverLabel: purposeTexts(purpose).asItIs,
    applyLabel: t("Apply and create the file again")
  };
}

// --- after delivery ------------------------------------------------------------------------------------------------

const areasLabel = (count) => (count === 1 ? t("1 area") : t("{count} areas", { count }));

/**
 * The sentences of the result report (ui/dialogs/ReportDialog.jsx).
 * @param {object} summary   summarizeReport()
 * @param {{ purpose?: string, fileName?: string | null, describeWarning: Function }} facts
 *        fileName: the name the file was handed out under (Download); null when the caller of buildOutput()
 *        delivers it itself
 * @returns {{ redacted: boolean, headline: string, rows: Array<{ pageNumber: number, label: string, areas: string, outcome: string,
 *             tone: "success" | "warning", details: string[] }>, notes: Array<{ code: string, text: string }>, review: string }}
 */
export function describeReport(summary, { purpose = "download", fileName = null, describeWarning }) {
  // replaced text lines alone are an edit: only redaction and blur marks make it a redaction
  const redacted = summary.usedMarks || summary.rows.some((row) => row.areas > 0);
  let headline;
  if (purpose === "download" && fileName) headline = redacted ? t("Redaction finished. {name} was downloaded.", { name: fileName }) : t("{name} was downloaded.", { name: fileName });
  else if (purpose === "print") headline = redacted ? t("Redaction finished. The document was sent to the print dialog.") : t("The document was sent to the print dialog.");
  else headline = redacted ? t("Redaction finished. The file was created.") : t("The file was created.");

  const consequence = t("Links and form fields of this page are gone and its text is no longer sharp when enlarged; the text that remains can still be searched.");
  const rows = summary.rows.map((row) => {
    const details = [];
    let outcome;
    let tone = "success";
    if (row.path === "raster") {
      tone = "warning";
      outcome = row.onRequest || (!row.areas && !row.replacedLines) ? t("Converted to an image, as chosen.") : t("Converted to an image, because the content under the marks could not be removed precisely.");
      details.push(consequence);
    } else if (row.areas > 0) {
      outcome = row.path === "precise" ? t("Removed precisely and verified.") : t("Nothing had to be removed under the marks of this page.");
    } else {
      outcome = row.covered < row.replacedLines ? t("The old text of the lines you replaced was removed.") : t("The lines you replaced were covered.");
    }
    if (row.covered > 0) {
      tone = "warning";
      details.push(row.covered === 1 ? t("1 replaced text line was only covered: its old text is still in the file.") : t("{count} replaced text lines were only covered: their old text is still in the file.", { count: row.covered }));
    } else if (row.replacedLines > 0 && row.areas > 0) {
      details.push(t("The old text of the lines you replaced was removed."));
    }
    for (const reason of row.reasons) details.push(describeWarning(reason));
    return { pageNumber: row.pageNumber, label: t("Page {page}", { page: row.pageNumber }), areas: row.areas ? areasLabel(row.areas) : "", outcome, tone, details: unique(details) };
  });

  const notes = summary.warnings.filter((warning) => !TOLD_BY_ROWS.includes(warning.code)).map((warning) => ({ code: warning.code, text: describeWarning(warning) }));
  if (summary.pictureText > 0) {
    notes.push({
      code: "TEXT_RASTERIZED",
      text: summary.pictureText === 1 ? t("1 text box was put into the file as a picture: its text cannot be selected or searched there.") : t("{count} text boxes were put into the file as pictures: their text cannot be selected or searched there.", { count: summary.pictureText })
    });
  }
  return { redacted, headline, rows, notes, review: t("Check the result before you share the file.") };
}

/** True when the report of a build has something to tell after the delivery (rows, warnings, text as pictures). */
export function reportIsWorthShowing(summary) {
  return summary.rows.length > 0 || summary.pictureText > 0 || summary.warnings.some((warning) => !TOLD_BY_ROWS.includes(warning.code));
}

// --- a build that failed --------------------------------------------------------------------------------------------

/**
 * What the failure dialog says besides the sentence of messages.js.
 * @param {string} code      the code of the PdfEditorError (or "" for something unexpected)
 * @param {{ purpose?: string, hadMarks?: boolean, redactPath?: string }} facts
 * @returns {{ verification: boolean, nothing: string, explanation: string | null, canConvert: boolean }}
 *          canConvert: building again with every marked page as a picture is worth offering
 */
export function describeFailure(code, { purpose = "download", hadMarks = false, redactPath = "hybrid" } = {}) {
  const verification = VERIFICATION_CODES.includes(code);
  const nothing = purpose === "download" ? t("No file was created: nothing was downloaded.") : purpose === "print" ? t("No file was created: nothing was printed.") : t("No file was created.");
  return {
    verification,
    nothing,
    explanation: verification ? t("The editor checks every file before it hands it out. This file did not pass the check, so it was discarded.") : null,
    canConvert: hadMarks && redactPath !== "raster" && ["REDACT_VERIFICATION_FAILED", "PIPELINE_SELF_CHECK_FAILED"].includes(code)
  };
}

/** The name a user typed for the output, cleaned like a document name; "" when nothing usable is left. */
export const cleanBaseName = (typed) => normalizeFileName(String(typed ?? ""));
