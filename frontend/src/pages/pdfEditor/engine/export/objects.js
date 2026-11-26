// drawObject(): one editor object (model/schema.js) drawn on a canvas of draw.js.
//
// Coordinates (../geometry.js): positions are in the user space of the page, sizes in points whatever the
// page's /UserUnit is. A box-shaped object is drawn inside `q M cm ... Q` with M = frameMatrixUp(frame,
// userUnit): origin at the bottom-left corner of its box, y up, one unit = one point. A line gets the same
// kind of frame along its own direction; the quads of a text highlight are user-space positions and are
// painted as they are.
//
// What each type looks like (the page overlay must draw the same; the pure rules are in shapes.js):
//   rect / ellipse  the outline is the frame itself, the stroke is centred on it (half inside, half outside)
//   line            round caps; a head is a filled triangle whose tip is exactly the end point
//   pen             a smooth curve through the points, round caps and joins; one point is a dot
//   highlight       painted with the Multiply blend mode at full strength (text mode: the quads; stroke
//                   mode: a round stroke of `thickness`)
//   dash            "dashed" / "dotted" patterns grow with the stroke width (shapes.js dashPattern), round caps
//   opacity         the WHOLE object is painted through one transparency group: where a stroke overlaps its
//                   fill, or a line its arrow head, nothing gets darker. On screen that is CSS `opacity` on
//                   the element of the object, not on its parts.
//   text            every run of its TextLayout at run.x / line.baseline, in the face run.font at object.size;
//                   an underline is a filled bar per line; with layout.raster the picture is drawn instead
//   image           the asset in the frame; a JPEG is turned as its EXIF orientation asks (imageInfo.js)
import { PdfEditorError } from "../errors.js";
import { frameMatrixUp } from "../geometry.js";
import { colorToRgb, fontKey, isMark, validateObject } from "../../model/schema.js";
import { orientationMatrix } from "./imageInfo.js";
import { dashPattern, ellipsePath, flipPath, lineParts, quadCorners, rectPath, strokePointsLocal } from "./shapes.js";

const invalid = (object, problems) => new PdfEditorError("EXPORT_OBJECT_INVALID", { objectId: object?.id ?? null, type: object?.type ?? null, problems });

/** Runs `draw(canvas)` directly, or through a transparency group when the object is translucent. */
function withOpacity(canvas, opacity, bbox, draw) {
  if (!(opacity < 1)) draw(canvas);
  else canvas.group({ bbox, opacity }, draw);
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The TextLayout of a text object, checked: throws EXPORT_TEXT_LAYOUT_MISSING when it is absent or malformed.
 * A layout with `raster` needs no lines.
 */
export function textLayoutOf(object) {
  const layout = object.layout;
  const fail = () => {
    throw new PdfEditorError("EXPORT_TEXT_LAYOUT_MISSING", { objectId: object.id });
  };
  if (!layout || typeof layout !== "object") fail();
  if (layout.raster) {
    const { png, x, y, w, h } = layout.raster;
    if (!(png instanceof Uint8Array) || ![x, y, w, h].every(isNumber) || !(w > 0) || !(h > 0)) fail();
    return layout;
  }
  if (!Array.isArray(layout.lines)) fail();
  for (const line of layout.lines) {
    if (!line || !isNumber(line.baseline) || !isNumber(line.x) || !isNumber(line.width) || !Array.isArray(line.runs)) fail();
    for (const run of line.runs) {
      if (!run || typeof run.text !== "string" || !isNumber(run.x) || typeof run.font !== "string" || !run.font) fail();
    }
  }
  return layout;
}

/**
 * Structural check of an object before anything is drawn: validateObject() of the schema, no marks, and a
 * usable TextLayout on text. Throws EXPORT_OBJECT_INVALID / EXPORT_TEXT_LAYOUT_MISSING.
 */
export function checkObject(object) {
  if (!object || typeof object !== "object") throw invalid(object, ["not an object"]);
  // redact / blur are applied to the ORIGINAL page by the redaction engine, never painted here: drawing a box
  // where content should have been removed would look like a redaction and protect nothing
  if (isMark(object)) throw invalid(object, ["mark"]);
  const problems = validateObject(object);
  if (problems.length) throw invalid(object, problems);
  if (object.type === "text") textLayoutOf(object);
  return object;
}

function shapeStyle(object) {
  const hasStroke = Boolean(object.stroke) && object.strokeWidth > 0;
  const style = {};
  if (object.fill) style.fill = colorToRgb(object.fill);
  if (hasStroke) {
    style.stroke = colorToRgb(object.stroke);
    style.lineWidth = object.strokeWidth;
    const dash = dashPattern(object.dash, object.strokeWidth);
    if (dash) {
      style.dash = dash;
      style.lineCap = "round";
    }
  }
  return style.fill || style.stroke ? style : null;
}

function drawBoxShape(canvas, object, env) {
  const style = shapeStyle(object);
  if (!style) return;
  const { w, h } = object.frame;
  const pad = (style.stroke ? object.strokeWidth / 2 : 0) + 1;
  // the outline as shapes.js defines it in the box's local frame (it starts and runs like the SVG element of
  // the overlay, so a dash pattern begins at the same corner), mirrored into the writer's y-up frame
  const outline = flipPath(object.type === "ellipse" ? ellipsePath(w / 2, h / 2, w / 2, h / 2) : rectPath(w, h), h);
  canvas.frame(frameMatrixUp(object.frame, env.userUnit), (framed) => {
    withOpacity(framed, object.opacity, [-pad, -pad, w + pad, h + pad], (target) => {
      target.path(style, (path) => path.trace(outline));
    });
  });
}

function drawLine(canvas, object, env) {
  const [x1, y1] = object.p1;
  const [x2, y2] = object.p2;
  const scale = 1 / env.userUnit; // one point in user-space units
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const ux = distance > 0 ? (x2 - x1) / distance : 1;
  const uy = distance > 0 ? (y2 - y1) / distance : 0;
  const length = distance / scale; // points
  const width = object.strokeWidth;
  const color = colorToRgb(object.stroke);
  const parts = lineParts({ length, strokeWidth: width, headStart: object.headStart, headEnd: object.headEnd });
  const reach = Math.max(width, parts.heads.length ? parts.headWidth : 0) / 2 + 1;
  // a frame along the line: origin = p1, x towards p2, one unit = one point
  canvas.frame([scale * ux, scale * uy, -scale * uy, scale * ux, x1, y1], (framed) => {
    withOpacity(framed, object.opacity, [-width / 2 - 1, -reach, length + width / 2 + 1, reach], (target) => {
      if (length < 1e-6) {
        target.ellipse(0, 0, width / 2, width / 2, { fill: color }); // both ends on one point: a dot
        return;
      }
      if (parts.shaft) {
        const dash = dashPattern(object.dash, width);
        target.line(parts.shaft[0], 0, parts.shaft[1], 0, { stroke: color, lineWidth: width, lineCap: "round", ...(dash ? { dash } : {}) });
      }
      for (const head of parts.heads) target.polygon(head, { fill: color });
    });
  });
}

/** Points of a stroke in the frame of frameMatrixUp(): y up. */
const strokePointsUp = (frame, points) => strokePointsLocal(frame, points).map(([x, y]) => [x, frame.h - y]);

function drawPen(canvas, object, env) {
  const { w, h } = object.frame;
  const points = strokePointsUp(object.frame, object.points);
  // a smooth curve through the samples can swing outside their bounding box
  const pad = object.width / 2 + 1 + Math.hypot(w, h) / 6;
  canvas.frame(frameMatrixUp(object.frame, env.userUnit), (framed) => {
    withOpacity(framed, object.opacity, [-pad, -pad, w + pad, h + pad], (target) => {
      target.ink(points, { stroke: colorToRgb(object.color), lineWidth: object.width });
    });
  });
}

function drawHighlight(canvas, object, env) {
  const color = colorToRgb(object.color);
  if (object.mode === "text") {
    // ONE path for all quads: where the boxes of two lines overlap the colour is multiplied once, not twice
    canvas.path({ fill: color, blendMode: "Multiply" }, (target) => {
      for (const quad of object.quads) {
        const corners = quadCorners(quad);
        target.trace([["M", ...corners[0]], ["L", ...corners[1]], ["L", ...corners[2]], ["L", ...corners[3]], ["Z"]]);
      }
    });
    return;
  }
  canvas.frame(frameMatrixUp(object.frame, env.userUnit), (framed) => {
    framed.ink(strokePointsUp(object.frame, object.points), { stroke: color, strokeOpacity: 1, lineWidth: object.thickness, blendMode: "Multiply" });
  });
}

function drawImage(canvas, object, env) {
  const { w, h } = object.frame;
  const { image, orientation } = env.image(object);
  canvas.frame(frameMatrixUp(object.frame, env.userUnit), (framed) => {
    framed.image(image, 0, 0, w, h, { opacity: object.opacity < 1 ? object.opacity : undefined, matrix: orientationMatrix(orientation, w, h) });
  });
}

function drawText(canvas, object, env) {
  const layout = textLayoutOf(object);
  const { w, h } = object.frame;
  const matrix = frameMatrixUp(object.frame, env.userUnit);
  if (layout.raster) {
    // the text could not be written with the bundled fonts: its picture, where the layout says (local, y down)
    const { x, y, w: width, h: height } = layout.raster;
    canvas.frame(matrix, (framed) => {
      framed.image(env.raster(object), x, h - y - height, width, height, { opacity: object.opacity < 1 ? object.opacity : undefined });
    });
    return;
  }
  const size = object.size;
  const color = colorToRgb(object.color);
  const bar = object.underline ? env.underline(object) : null;
  // glyphs reach beyond the box: stacked Vietnamese marks above the first line, descenders, italic overhang
  const bbox = [-size, -size, Math.max(w, layout.width || 0) + size, h + size];
  canvas.frame(matrix, (framed) => {
    withOpacity(framed, object.opacity, bbox, (target) => {
      for (const line of layout.lines) {
        const baseline = h - line.baseline;
        for (const run of line.runs) {
          if (!run.text) continue;
          target.text(run.text, { font: env.font(run.font), size, x: run.x, y: baseline, color, objectId: object.id, fontKey: run.font });
        }
        if (bar && line.width > 0) target.rect(line.x, baseline - bar.offset - bar.thickness, line.width, bar.thickness, { fill: color });
      }
    });
  });
}

/**
 * Draws one object of model/schema.js.
 *
 * @param {object} canvas  a Canvas / PageCanvas of draw.js
 * @param {object} object  EditorObject; a text object carries its TextLayout in `layout`
 * @param {{ userUnit: number, font: (fontKey: string) => any, image: (object: object) => { image: any, orientation: number },
 *           raster: (object: object) => any, underline: (object: object) => { offset: number, thickness: number } }} env
 *        what the object needs from the document: embedded fonts and images (painter.js supplies it)
 */
export function drawObject(canvas, object, env) {
  switch (object.type) {
    case "text": drawText(canvas, object, env); break;
    case "image": drawImage(canvas, object, env); break;
    case "rect":
    case "ellipse": drawBoxShape(canvas, object, env); break;
    case "line": drawLine(canvas, object, env); break;
    case "pen": drawPen(canvas, object, env); break;
    case "highlight": drawHighlight(canvas, object, env); break;
    default: throw invalid(object, ["type"]);
  }
}

/** The face that sets the metrics of a text box (its own font; fallback runs do not move the underline). */
export const primaryFontKey = (object) => fontKey(object);
