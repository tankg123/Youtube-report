// Pixel helpers of the export engine's tests (they need a canvas: guard the tests with `canRender`), and
// what pdf.js reports about links, outline and text positions (no canvas needed).
import { openPdf, closePdf, renderPage, withPdf } from "./pdfTestKit.mjs";
import { multiplyMatrix } from "../../src/pages/pdfEditor/engine/geometry.js";

/**
 * Renders one page (1-based number). Returns { data, width, height, viewport } with RGBA pixels.
 * annotations: false renders the page content only.
 */
export async function renderToPixels(doc, pageNumber, { scale = 2, annotations = true, rotation } = {}) {
  const page = await doc.getPage(pageNumber);
  const { ctx, viewport, width, height } = await renderPage(page, { scale, annotations, rotation });
  return { data: ctx.getImageData(0, 0, width, height).data, width, height, viewport };
}

/** Renders every page of a file. */
export function renderAll(bytes, options) {
  return withPdf(bytes, async (doc) => {
    const out = [];
    for (let number = 1; number <= doc.numPages; number += 1) out.push(await renderToPixels(doc, number, options));
    return out;
  });
}

/** [r, g, b] of the pixel nearest to (x, y). */
export function pixelAt(image, x, y) {
  const px = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const offset = (py * image.width + px) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

export const colorNear = (actual, expected, tolerance) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

/**
 * Bounding box (pixels) of all pixels within `tolerance` of `color`, optionally only inside `area`
 * { x, y, w, h }. null when there is none. cx / cy = centre of the box.
 */
export function findColorBox(image, color, tolerance = 40, area) {
  const ax0 = area ? Math.max(0, Math.floor(area.x)) : 0;
  const ay0 = area ? Math.max(0, Math.floor(area.y)) : 0;
  const ax1 = area ? Math.min(image.width, Math.ceil(area.x + area.w)) : image.width;
  const ay1 = area ? Math.min(image.height, Math.ceil(area.y + area.h)) : image.height;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = ay0; y < ay1; y += 1) {
    for (let x = ax0; x < ax1; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (Math.abs(image.data[offset] - color[0]) <= tolerance && Math.abs(image.data[offset + 1] - color[1]) <= tolerance && Math.abs(image.data[offset + 2] - color[2]) <= tolerance) {
        count += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!count) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, count, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
}

const differsAt = (a, b, offset, tolerance) => Math.abs(a.data[offset] - b.data[offset]) > tolerance
  || Math.abs(a.data[offset + 1] - b.data[offset + 1]) > tolerance
  || Math.abs(a.data[offset + 2] - b.data[offset + 2]) > tolerance;

/**
 * Number of pixels that differ (by more than `tolerance` levels in a channel) between two renderings of the
 * same size, outside the given rectangles [{ x, y, w, h }] (pixels). -1 when the sizes differ.
 */
export function differingPixels(a, b, exclude = [], tolerance = 0) {
  if (a.width !== b.width || a.height !== b.height) return -1;
  let changed = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (exclude.some((box) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h)) continue;
      if (differsAt(a, b, (y * a.width + x) * 4, tolerance)) changed += 1;
    }
  }
  return changed;
}

/** The first pixel (row by row) that differs outside the excluded rectangles, as text for a failure message. */
export function firstDifference(a, b, exclude = [], tolerance = 0) {
  if (a.width !== b.width || a.height !== b.height) return `sizes differ: ${a.width} x ${a.height} and ${b.width} x ${b.height}`;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (exclude.some((box) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h)) continue;
      const offset = (y * a.width + x) * 4;
      if (differsAt(a, b, offset, tolerance)) {
        return `pixel (${x}, ${y}): rgb(${a.data[offset]},${a.data[offset + 1]},${a.data[offset + 2]}) became rgb(${b.data[offset]},${b.data[offset + 1]},${b.data[offset + 2]})`;
      }
    }
  }
  return "no difference";
}

/** Where every link of every page goes: per page a sorted list of target page indices, "url" or "dead". */
export function linkTargets(bytes) {
  return withPdf(bytes, async (doc) => {
    const out = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const list = [];
      for (const annotation of await (await doc.getPage(number)).getAnnotations()) {
        if (annotation.subtype !== "Link") continue;
        if (annotation.url) {
          list.push("url");
          continue;
        }
        const dest = typeof annotation.dest === "string" ? await doc.getDestination(annotation.dest) : annotation.dest;
        list.push(dest ? await doc.getPageIndex(dest[0]).catch(() => "dead") : "dead");
      }
      out.push(list.sort());
    }
    return out;
  });
}

/** Annotation subtypes per page: [{ Link: 2, Widget: 3 }, ...]. */
export function annotationCensus(bytes) {
  return withPdf(bytes, async (doc) => {
    const out = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const census = {};
      for (const annotation of await (await doc.getPage(number)).getAnnotations()) census[annotation.subtype] = (census[annotation.subtype] || 0) + 1;
      out.push(census);
    }
    return out;
  });
}

/** The outline as pdf.js reads it, flat: [[title, page index | url | null, depth], ...]. */
export function outlineOf(bytes) {
  return withPdf(bytes, async (doc) => {
    const flat = [];
    const walk = async (items, depth) => {
      for (const item of items || []) {
        const dest = item.dest ? (typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest) : null;
        flat.push([item.title, dest ? await doc.getPageIndex(dest[0]) : item.url || null, depth]);
        await walk(item.items, depth + 1);
      }
    };
    await walk(await doc.getOutline(), 0);
    return flat;
  });
}

/**
 * Text items of a page with their matrix ON SCREEN (viewport pixels at `scale`): [{ str, matrix, x, y, height }]
 * where (x, y) is the start of the baseline and `height` the font size, both in pixels. An upright item has
 * matrix[1] = matrix[2] = 0, matrix[0] > 0 and matrix[3] < 0.
 */
export async function screenTextItems(doc, pageNumber, scale = 1) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent();
  const out = [];
  for (const item of content.items) {
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    const matrix = multiplyMatrix(viewport.transform, item.transform);
    out.push({ str: item.str, matrix, x: matrix[4], y: matrix[5], height: Math.hypot(matrix[2], matrix[3]) });
  }
  return out;
}

export { openPdf, closePdf };
