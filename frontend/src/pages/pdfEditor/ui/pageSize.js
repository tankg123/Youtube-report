// The size of a page as the status bar and the document summary show it: millimetres as the reader sees the
// page (rotation applied), and the name of the paper format when it is a common one.
// Pure: tests/pdfUiFileNames.test.mjs.
import { PAGE_SIZES } from "../engine/geometry.js";
import { visiblePageSize } from "../viewer/pageList.js";

export const MM_PER_POINT = 25.4 / 72;
/** How far (in points) a page may be from a format and still carry its name: scanners and printers round. */
const FORMAT_TOLERANCE = 1.5;
/** Paper formats are proper names: the same in both languages. */
const FORMAT_NAMES = Object.freeze({ A3: "A3", A4: "A4", A5: "A5", LETTER: "Letter", LEGAL: "Legal" });

const round = (value) => Math.round(value * 10) / 10;

/** The paper format of a size in points (either orientation), or null. */
export function paperFormat(width, height) {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  for (const [key, [w, h]] of Object.entries(PAGE_SIZES)) {
    if (Math.abs(short - w) <= FORMAT_TOLERANCE && Math.abs(long - h) <= FORMAT_TOLERANCE) return FORMAT_NAMES[key] || key;
  }
  return null;
}

/**
 * @param {object} page  a Page of model/schema.js
 * @returns {{ width: number, height: number, format: string | null, landscape: boolean }} millimetres with
 *          one decimal, as the page is seen (its /Rotate and the rotation the user added applied)
 */
export function describePageSize(page) {
  const { width, height } = visiblePageSize(page);
  return { width: round(width * MM_PER_POINT), height: round(height * MM_PER_POINT), format: paperFormat(width, height), landscape: width > height };
}
