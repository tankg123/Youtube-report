// The geometry of a page of the PDF library exactly as pdf.js sees it: the bridge between a PDFPage and the
// pure coordinate maths of ../geometry.js (viewportTransform, frameMatrixUp, ...).
//
// No page-box getter of the library is involved in mapping coordinates: user space is user space. The boxes
// only say which rectangle is visible. (page.getWidth() / getHeight() are the MediaBox, unrotated: NOT the
// visible size. getX() / getY() are the text cursor.)
import { N, numberOf, arrayOf } from "./pdfUtil.js";
import { normalizeRightAngle } from "../geometry.js";

const LETTER = [0, 0, 612, 792];

function normaliseRect(context, value) {
  const array = arrayOf(context, value);
  if (!array || array.size() !== 4) return null;
  const numbers = array.asArray().map((item) => numberOf(context, item));
  if (numbers.some((item) => item === undefined || !Number.isFinite(item))) return null;
  const rect = [Math.min(numbers[0], numbers[2]), Math.min(numbers[1], numbers[3]), Math.max(numbers[0], numbers[2]), Math.max(numbers[1], numbers[3])];
  return rect[2] - rect[0] > 0 && rect[3] - rect[1] > 0 ? rect : null;
}

/**
 * { view, rotate, userUnit } of a page with the fallbacks of pdf.js: a missing or empty MediaBox is US
 * Letter, a CropBox that does not intersect the MediaBox is ignored, /Rotate is reduced to 0 / 90 / 180 / 270
 * (anything else is 0), /UserUnit must be positive. `view` equals pdf.js page.view.
 * @param {object} page  PDFPage
 * @returns {{ view: number[], rotate: number, userUnit: number, mediaBox: number[], cropBox: number[] | null }}
 */
export function pageGeometry(page) {
  const node = page.node;
  const { context } = node;
  const mediaBox = normaliseRect(context, node.getInheritableAttribute(N("MediaBox"))) || LETTER.slice();
  const cropBox = normaliseRect(context, node.getInheritableAttribute(N("CropBox")));
  let view = mediaBox;
  if (cropBox) {
    const x0 = Math.max(mediaBox[0], cropBox[0]);
    const y0 = Math.max(mediaBox[1], cropBox[1]);
    const x1 = Math.min(mediaBox[2], cropBox[2]);
    const y1 = Math.min(mediaBox[3], cropBox[3]);
    if (x1 - x0 > 0 && y1 - y0 > 0) view = [x0, y0, x1, y1];
  }
  const rotate = normalizeRightAngle(numberOf(context, node.getInheritableAttribute(N("Rotate"))) ?? 0);
  let userUnit = numberOf(context, node.get(N("UserUnit"))) ?? 1;
  if (!(userUnit > 0)) userUnit = 1;
  return { view, rotate, userUnit, mediaBox, cropBox };
}
