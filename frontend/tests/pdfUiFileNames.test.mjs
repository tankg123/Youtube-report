// Names of the files the PDF editor hands out and the page size it shows
// (src/pages/pdfEditor/ui/fileNames.js, ui/pageSize.js).
import test from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_BASE_NAME, OUTPUT_PURPOSES, isImageFile, outputBaseName, outputFileName, pageRangeLabel, pdfFileName, splitFiles } from "../src/pages/pdfEditor/ui/fileNames.js";
import { describePageSize, paperFormat } from "../src/pages/pdfEditor/ui/pageSize.js";

test("Download and Print: -edited, or the name itself for the untouched original", () => {
  assert.equal(outputBaseName({ fileName: "hop-dong-2026.pdf" }), "hop-dong-2026-edited");
  assert.equal(outputBaseName({ fileName: "hop-dong-2026", purpose: "print" }), "hop-dong-2026-edited");
  assert.equal(outputBaseName({ fileName: "hop-dong-2026.pdf", original: true }), "hop-dong-2026");
  assert.equal(outputFileName({ fileName: "hop-dong-2026.pdf", original: true }), "hop-dong-2026.pdf");
  assert.equal(outputFileName({ fileName: "Hợp đồng số 12.PDF" }), "Hợp đồng số 12-edited.pdf", "Vietnamese names and an upper-case extension");
});

test("applied redactions name the file -redacted", () => {
  assert.equal(outputBaseName({ fileName: "report", usedRedaction: true }), "report-redacted");
  assert.equal(outputBaseName({ fileName: "report", usedRedaction: true, original: true }), "report", "an original is never renamed");
});

test("the signed document is -signed, also when nothing else changed", () => {
  assert.equal(outputBaseName({ fileName: "contract.pdf", purpose: "sign" }), "contract-signed");
  assert.equal(outputBaseName({ fileName: "contract.pdf", purpose: "sign", original: true }), "contract-signed");
});

test("a suffix the name already ends with is not added twice", () => {
  assert.equal(outputBaseName({ fileName: "contract-edited.pdf" }), "contract-edited");
  assert.equal(outputBaseName({ fileName: "contract-EDITED" }), "contract-EDITED");
  assert.equal(outputBaseName({ fileName: "contract-signed", purpose: "sign" }), "contract-signed");
  assert.equal(outputBaseName({ fileName: "contract-redacted", usedRedaction: true }), "contract-redacted");
  assert.equal(outputBaseName({ fileName: "contract-edited", usedRedaction: true }), "contract-edited-redacted", "another suffix is another fact");
});

test("extracts carry their page numbers", () => {
  assert.equal(outputBaseName({ fileName: "book.pdf", purpose: "extract", pageNumbers: [3, 4, 5] }), "book-pages-3-5");
  assert.equal(outputBaseName({ fileName: "book.pdf", purpose: "extract", pageNumbers: [7] }), "book-pages-7");
  assert.equal(outputBaseName({ fileName: "book.pdf", purpose: "extract", pageNumbers: [] }), "book");
  assert.equal(pageRangeLabel([5, 3, 4, 4, 1, 9]), "1,3-5,9");
  assert.equal(pageRangeLabel([1, 3, 5, 7, 9, 11, 13]), "1-13", "more than six ranges: first to last");
  assert.equal(pageRangeLabel([0, -2, 1.5, "4", null]), "", "only whole page numbers count");
  assert.equal(pageRangeLabel(undefined), "");
});

test("a document without a usable name still gets a file name", () => {
  assert.equal(outputBaseName({ fileName: "" }), `${FALLBACK_BASE_NAME}-edited`);
  assert.equal(outputBaseName({}), `${FALLBACK_BASE_NAME}-edited`);
  assert.equal(outputBaseName(), `${FALLBACK_BASE_NAME}-edited`);
  assert.equal(pdfFileName("  "), `${FALLBACK_BASE_NAME}.pdf`);
  assert.equal(pdfFileName("a/b:c?.pdf"), "a-b-c-.pdf", "characters no file system takes become dashes");
  assert.equal(pdfFileName("report-edited"), "report-edited.pdf");
  assert.deepEqual(OUTPUT_PURPOSES, ["download", "print", "sign", "extract"]);
});

test("picked files are split into PDFs and pictures", () => {
  const pdf = { name: "a.pdf", type: "application/pdf" };
  const png = { name: "scan.png", type: "image/png" };
  const namedOnly = { name: "photo.JPEG", type: "" };
  const unknown = { name: "notes.txt", type: "text/plain" };
  const untyped = { name: "contract", type: "" };
  assert.equal(isImageFile(png), true);
  assert.equal(isImageFile(namedOnly), true);
  assert.equal(isImageFile(pdf), false);
  assert.equal(isImageFile({ name: "looks-like.png", type: "application/pdf" }), false, "the type wins over the name");
  assert.equal(isImageFile(null), false);
  // what is not clearly a picture goes to the viewer, which says what is wrong with it
  assert.deepEqual(splitFiles([pdf, png, namedOnly, unknown, untyped]), { pdfs: [pdf, unknown, untyped], images: [png, namedOnly] });
  assert.deepEqual(splitFiles(null), { pdfs: [], images: [] });
});

const pageOf = (view, extra = {}) => ({ id: "p1", kind: "pdf", sourceId: "s1", sourceIndex: 0, view, baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [], ...extra });

test("the size of a page is shown in millimetres, as the reader sees the page", () => {
  assert.deepEqual(describePageSize(pageOf([0, 0, 595.28, 841.89])), { width: 210, height: 297, format: "A4", landscape: false });
  assert.deepEqual(describePageSize(pageOf([0, 0, 595.28, 841.89], { baseRotation: 90 })), { width: 297, height: 210, format: "A4", landscape: true }, "/Rotate 90");
  assert.deepEqual(describePageSize(pageOf([0, 0, 595.28, 841.89], { baseRotation: 90, rotation: 90 })), { width: 210, height: 297, format: "A4", landscape: false }, "turned once more by the user");
  assert.deepEqual(describePageSize(pageOf([0, 0, 612, 792])), { width: 215.9, height: 279.4, format: "Letter", landscape: false });
  assert.deepEqual(describePageSize(pageOf([20, 30, 320, 430])), { width: 105.8, height: 141.1, format: null, landscape: false }, "a cropped box counts with its visible size");
  assert.deepEqual(describePageSize(pageOf([0, 0, 300, 400], { userUnit: 2 })), { width: 211.7, height: 282.2, format: null, landscape: false }, "/UserUnit scales the page");
});

test("paper formats are recognised in both orientations, within a point and a half", () => {
  assert.equal(paperFormat(595, 842), "A4");
  assert.equal(paperFormat(842, 595), "A4");
  assert.equal(paperFormat(596.5, 843), "A4");
  assert.equal(paperFormat(598, 842), null);
  assert.equal(paperFormat(841.89, 1190.55), "A3");
  assert.equal(paperFormat(419.53, 595.28), "A5");
  assert.equal(paperFormat(612, 1008), "Legal");
  assert.equal(paperFormat(500, 500), null);
});
