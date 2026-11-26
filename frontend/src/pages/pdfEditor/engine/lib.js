// The ONE place of the PDF editor that names the PDF writing library and its font engine. Every engine
// module imports them from here (or receives them as an argument), so the pairing can never be mixed:
// @cantoo/pdf-lib works only with @cantoo/fontkit (subsetting crashes with any other fontkit).
// Both are pinned to exact versions in package.json: the engines rely on a few private fields.
import * as pdfLibModule from "@cantoo/pdf-lib";
import fontkitModule from "@cantoo/fontkit";

/** The library namespace: PDFDocument, PDFName, PDFDict, operators, ... */
export const pdfLib = pdfLibModule;

/** The object to hand to pdfDoc.registerFontkit(). */
export const fontkit = fontkitModule?.default && typeof fontkitModule.default.create === "function" ? fontkitModule.default : fontkitModule;

export const PDF_LIB_NAME = "@cantoo/pdf-lib";
