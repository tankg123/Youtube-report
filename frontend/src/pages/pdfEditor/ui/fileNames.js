// Names of the files the editor hands out (UX specification 7.1). Pure functions: tests/pdfUiFileNames.test.mjs.
//
//   an unchanged document          <name>.pdf            (the original bytes, under the original name)
//   Download / Print of edits      <name>-edited.pdf
//   ... when marks were applied    <name>-redacted.pdf
//   the signed document            <name>-signed.pdf
//   Extract                        <name>-pages-3-5.pdf  (page numbers of the working document)
// A suffix the name already ends with is not added a second time ("contract-edited" stays "contract-edited").
import { normalizeFileName } from "../model/store.js";

export const OUTPUT_PURPOSES = Object.freeze(["download", "print", "sign", "extract"]);
export const FILE_EXTENSION = ".pdf";
/** What a document without a name is called (a file name, not a text of the interface). */
export const FALLBACK_BASE_NAME = "document";
const MAX_RANGES = 6;

/**
 * Page numbers as the label of an extract: [3, 4, 5] -> "3-5", [1, 3, 4, 7] -> "1,3-4,7". Numbers are sorted
 * and repeated ones dropped; more than six ranges become "<first>-<last>" of the whole selection.
 */
export function pageRangeLabel(pageNumbers) {
  const numbers = [...new Set((Array.isArray(pageNumbers) ? pageNumbers : []).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  if (!numbers.length) return "";
  const ranges = [];
  let start = numbers[0];
  let end = start;
  for (const value of numbers.slice(1)) {
    if (value === end + 1) {
      end = value;
      continue;
    }
    ranges.push([start, end]);
    start = end = value;
  }
  ranges.push([start, end]);
  if (ranges.length > MAX_RANGES) return `${numbers[0]}-${numbers[numbers.length - 1]}`;
  return ranges.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(",");
}

const withSuffix = (base, suffix) => (base.toLowerCase().endsWith(suffix) ? base : `${base}${suffix}`);

/**
 * The name of an output file, without the extension.
 * @param {object} facts
 * @param {string} facts.fileName         the document name (state.fileName), with or without ".pdf"
 * @param {string} [facts.purpose]        one of OUTPUT_PURPOSES (default "download")
 * @param {boolean} [facts.original]      the output is the untouched source file
 * @param {boolean} [facts.usedRedaction] redaction or blur marks were applied (report.usedRedaction)
 * @param {number[]} [facts.pageNumbers]  1-based page numbers of an extract
 */
export function outputBaseName({ fileName, purpose = "download", original = false, usedRedaction = false, pageNumbers = null } = {}) {
  const base = normalizeFileName(fileName) || FALLBACK_BASE_NAME;
  if (purpose === "extract") {
    const label = pageRangeLabel(pageNumbers);
    return label ? `${base}-pages-${label}` : base;
  }
  if (purpose === "sign") return withSuffix(base, "-signed");
  if (original) return base;
  return withSuffix(base, usedRedaction ? "-redacted" : "-edited");
}

/** The complete file name of an output: outputBaseName() plus ".pdf". */
export const outputFileName = (facts) => `${outputBaseName(facts)}${FILE_EXTENSION}`;

/** "<base>.pdf" for a base name the user may have typed (cleaned like a document name). */
export const pdfFileName = (baseName) => `${normalizeFileName(baseName) || FALLBACK_BASE_NAME}${FILE_EXTENSION}`;

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|heif|tiff?)$/i;

/** True for a file that is a picture by its type or its name (handed to the page features, not to pdf.js). */
export function isImageFile(file) {
  const type = String(file?.type || "");
  return type.startsWith("image/") || (!type && IMAGE_FILE.test(String(file?.name || "")));
}

/** Splits picked or dropped files into PDFs (everything that is not clearly a picture) and pictures. */
export function splitFiles(files) {
  const pdfs = [];
  const images = [];
  for (const file of files || []) (isImageFile(file) ? images : pdfs).push(file);
  return { pdfs, images };
}
