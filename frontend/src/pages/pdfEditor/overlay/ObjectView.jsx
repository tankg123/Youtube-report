import { memo, useEffect, useRef } from "react";
import { useI18n } from "../../../context/I18nContext";
import { dashPattern, ellipsePath, lineParts, pathToSvg, quadCorners, rectPath, smoothPath, strokePointsLocal } from "../engine/export/shapes.js";
import { frameToCssMatrix } from "../engine/geometry.js";
import { cropRegion, keyStreamReader, mosaicDraws, mosaicKeyStream, obscureRegion } from "../engine/redact/blur.js";
import { pageGeometry } from "../model/schema.js";
import TextBox from "../text/TextBox.jsx";
import { lineCssMatrix, userRectToPixels, userToPixels } from "./geometry.js";
import { EXPORT_PX_PER_PT, LIVE_MAX_PIXELS, mosaicPixels } from "./markReach.js";

// One object of the document, drawn over its page EXACTLY as the export engine will draw it into the file
// (engine/export/objects.js). The shapes come from the same pure rules (engine/export/shapes.js): outline
// paths, dash patterns, arrow heads, the spline through pen points. What the two sides share:
//   * a box-shaped object is drawn in the local frame of its box (points, origin top-left, y down) and put on
//     the page with ONE matrix (geometry.js frameToCssMatrix): zoom, /Rotate, the rotation the user added to
//     the page and the rotation of the box are all in it
//   * opacity belongs to the whole object (CSS opacity on its element = the transparency group of the export)
//   * highlights are multiplied with what lies under them (mix-blend-mode: multiply = the PDF blend mode)
//   * a picture fills its frame; a JPEG is turned as its EXIF orientation says, a PNG never is
//   * text is text/TextBox.jsx: the element the text service measured
// Every object element carries data-object-id and data-kind (BRIEF 5.5). What is under the pointer is decided
// by the model (overlay/pointer.js), so the elements only have to be there for the cursor.

const matrixStyle = (matrix) => `matrix(${matrix.map((value) => Math.round(value * 1e6) / 1e6).join(",")})`;
/** A thin stroke is easier to hit than to see: its invisible hit area is this wide (pixels). */
const HIT_WIDTH_PX = 12;

function hooks(object, flag) {
  return { "data-object-id": object.id, "data-kind": object.type, "data-preview": flag || undefined };
}

function BoxShape({ object, view, flag }) {
  const { w, h } = object.frame;
  const outline = pathToSvg(object.type === "ellipse" ? ellipsePath(w / 2, h / 2, w / 2, h / 2) : rectPath(w, h));
  const stroked = Boolean(object.stroke) && object.strokeWidth > 0;
  const dash = stroked ? dashPattern(object.dash, object.strokeWidth) : null;
  const hitWidth = Math.max(stroked ? object.strokeWidth : 0, HIT_WIDTH_PX / view.scale);
  return (
    <svg
      className="pdfx-ov-object"
      {...hooks(object, flag)}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ transform: matrixStyle(frameToCssMatrix(view.geometry, object.frame, view.scale, view.extraRotation)), opacity: object.opacity }}
    >
      <path
        d={outline}
        fill={object.fill || "none"}
        stroke={stroked ? object.stroke : "none"}
        strokeWidth={object.strokeWidth}
        strokeDasharray={dash ? dash.join(" ") : undefined}
        strokeLinecap={dash ? "round" : "butt"}
        strokeLinejoin="miter"
        strokeMiterlimit={10}
      />
      {/* an unfilled shape is picked up at its outline; what lies inside it stays reachable */}
      <path d={outline} fill="none" stroke="transparent" strokeWidth={hitWidth} pointerEvents="stroke" />
    </svg>
  );
}

function LineShape({ object, page, view, flag }) {
  const { matrix, length } = lineCssMatrix(page, object, view.scale);
  const width = object.strokeWidth;
  const parts = lineParts({ length, strokeWidth: width, headStart: object.headStart, headEnd: object.headEnd });
  const dash = dashPattern(object.dash, width);
  return (
    <svg className="pdfx-ov-object" {...hooks(object, flag)} width={1} height={1} style={{ transform: matrixStyle(matrix), opacity: object.opacity }}>
      {length < 1e-6 ? (
        <circle cx={0} cy={0} r={width / 2} fill={object.stroke} />
      ) : (
        <>
          {parts.shaft ? <line x1={parts.shaft[0]} y1={0} x2={parts.shaft[1]} y2={0} stroke={object.stroke} strokeWidth={width} strokeLinecap="round" strokeDasharray={dash ? dash.join(" ") : undefined} /> : null}
          {parts.heads.map((head, index) => (
            <polygon key={index} points={head.map((corner) => corner.join(",")).join(" ")} fill={object.stroke} />
          ))}
        </>
      )}
      <line x1={0} y1={0} x2={length} y2={0} stroke="transparent" strokeWidth={Math.max(width, HIT_WIDTH_PX / view.scale)} strokeLinecap="round" pointerEvents="stroke" />
    </svg>
  );
}

/** A pen stroke, or a freehand highlight (then `blend` multiplies it with the page). */
function Stroke({ object, view, flag, color, width, blend }) {
  const { w, h } = object.frame;
  const points = strokePointsLocal(object.frame, object.points);
  return (
    <svg
      className="pdfx-ov-object"
      {...hooks(object, flag)}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ transform: matrixStyle(frameToCssMatrix(view.geometry, object.frame, view.scale, view.extraRotation)), opacity: blend ? undefined : object.opacity, mixBlendMode: blend ? "multiply" : undefined }}
    >
      {points.length === 1 ? (
        <circle cx={points[0][0]} cy={points[0][1]} r={width / 2} fill={color} />
      ) : (
        <path d={pathToSvg(smoothPath(points))} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {points.length > 1 ? <path d={pathToSvg(smoothPath(points))} fill="none" stroke="transparent" strokeWidth={Math.max(width, HIT_WIDTH_PX / view.scale)} strokeLinecap="round" strokeLinejoin="round" pointerEvents="stroke" /> : null}
    </svg>
  );
}

/** Marked document text: all quads as ONE path, so that overlapping line boxes are multiplied once. */
function TextHighlight({ object, page, view, flag }) {
  const round = (value) => Math.round(value * 100) / 100;
  const outline = object.quads
    .map((quad) => {
      const corners = quadCorners(quad).map((corner) => userToPixels(page, corner, view.scale));
      return `${corners.map(([x, y], index) => `${index ? "L" : "M"}${round(x)} ${round(y)}`).join(" ")} Z`;
    })
    .join(" ");
  return (
    <svg className="pdfx-ov-object" {...hooks(object, flag)} data-mode="text" width={view.width} height={view.height} style={{ mixBlendMode: "multiply" }}>
      <path d={outline} fill={object.color} fillRule="nonzero" />
    </svg>
  );
}

function Picture({ object, view, runtime, flag }) {
  const url = runtime.assetUrl(object.assetId);
  const asset = runtime.editor.store.getState().assets[object.assetId];
  if (!url || !asset) return null;
  return (
    <img
      className="pdfx-ov-object pdfx-ov-picture"
      {...hooks(object, flag)}
      data-role={object.role}
      src={url}
      alt=""
      draggable={false}
      style={{
        width: `${object.frame.w}px`,
        height: `${object.frame.h}px`,
        transform: matrixStyle(frameToCssMatrix(view.geometry, object.frame, view.scale, view.extraRotation)),
        opacity: object.opacity,
        // the export turns a JPEG as its EXIF data says and never a PNG
        imageOrientation: asset.mime === "image/png" ? "none" : "from-image"
      }}
    />
  );
}

/**
 * @param {object} props
 * @param {object} props.object   an object of model/schema.js that is not a mark (a preview copy has an id that starts with "$")
 * @param {object} props.page     the Page it is drawn on
 * @param {object} props.view     { scale, geometry, extraRotation, width, height } of that page (viewer/ViewerPages.jsx)
 * @param {object} props.runtime  overlay/runtime.js
 * @param {string} [props.flag]   "preview" | "ghost" | "erased": how a transient copy is marked (data-preview)
 */
export const ObjectView = memo(function ObjectView({ object, page, view, runtime, flag }) {
  const { actions, messages, textService } = runtime.editor;
  switch (object.type) {
    case "text":
      return (
        <TextBox
          object={object}
          geometry={view.geometry}
          scale={view.scale}
          extraRotation={view.extraRotation}
          service={textService}
          onError={(error) => actions.hint("textFont", messages.describeError(error), "error")}
        />
      );
    case "image":
      return <Picture object={object} view={view} runtime={runtime} flag={flag} />;
    case "rect":
    case "ellipse":
      return <BoxShape object={object} view={view} flag={flag} />;
    case "line":
      return <LineShape object={object} page={page} view={view} flag={flag} />;
    case "pen":
      return <Stroke object={object} view={view} flag={flag} color={object.color} width={object.width} blend={false} />;
    case "highlight":
      if (object.mode === "text") return <TextHighlight object={object} page={page} view={view} flag={flag} />;
      return <Stroke object={object} view={view} flag={flag} color={object.color} width={object.thickness} blend />;
    default:
      return null;
  }
});

/**
 * A small generator of numbers in [0, 1) from the seed of a blur mark: the stand-in where the platform cannot
 * compute the key stream of the export (no WebCrypto on a page that is not served over https).
 */
function seededRandom(seed) {
  let state = parseInt(String(seed || "").slice(0, 8), 16) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The noise source of a mark, as the export derives it (engine/redact/redactPdf.js): a key stream of the seed,
 * started by the rectangle and the strength of the mark. The same mark then shows the same grid and the same
 * noise on screen as in every file that is made of it.
 */
async function noiseOf(seed, rect, strength, extent, userUnit) {
  try {
    const context = `${rect.map((value) => value.toFixed(3)).join(" ")}|${strength}`;
    return keyStreamReader(await mosaicKeyStream(seed, context, mosaicDraws((extent[2] - extent[0]) * userUnit, (extent[3] - extent[1]) * userUnit)));
  } catch {
    return seededRandom(seed);
  }
}

/** A canvas turned clockwise by a multiple of 90 degrees: a new canvas, or the same one for no turn. */
function turnedCanvas(source, degrees) {
  const quarters = ((Math.round(degrees / 90) % 4) + 4) % 4;
  if (!quarters) return source;
  const canvas = document.createElement("canvas");
  canvas.width = quarters % 2 ? source.height : source.width;
  canvas.height = quarters % 2 ? source.width : source.height;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((quarters * Math.PI) / 2);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

const release = (...canvases) => {
  for (const canvas of canvases) {
    canvas.width = 0;
    canvas.height = 0;
  }
};

/**
 * The live effect of a blur mark: the piece of the rendered page under it, turned into the mosaic the export
 * will put there, by the engine's own rule (engine/redact/blur.js obscureRegion):
 *   - the mosaic is made of the mark TOGETHER WITH the letters it takes (a letter goes as a whole) and shown
 *     inside the mark; the block follows the height of that area and the font size of those letters. Both come
 *     from the engine's dry run (runtime.markReach); without an answer the mark alone is the area;
 *   - grid and noise come from the seed of the mark (noiseOf);
 *   - the export works on the page as it is STORED. A page that is shown turned (by the file or by the user) is
 *     therefore turned back first, the mosaic is laid and cropped there (with the engine's "sideways" rule for a
 *     quarter turn), and the result is turned again for the screen.
 * The picture is made at the resolution of the export and of the very pixels the export uses (mosaicPixels), so
 * it does not change with the zoom. What can still differ from the file, by a block that comes out one level
 * lighter or darker (a mean on the border between two levels) or by the size of the blocks:
 *   - at a high zoom or on a dense screen the viewer hands out a scaled copy of the page it shows instead of a
 *     fresh render (viewer renderToCanvas), and a turned page is drawn turned: single pixels differ;
 *   - for text in a standard font that is not embedded the area differs by a fraction of the font size (the
 *     remover and pdf.js measure such glyphs differently: engine/redact/preview.js);
 *   - a page that becomes a picture in the export although the dry run could not know it (a mark over a filled
 *     shape: the verification of the export decides) is burned at the resolution of page pictures.
 * Until the picture is there the mark shows a frosted stand-in (styles/overlay.css); it stays when the picture
 * cannot be made.
 */
function BlurPicture({ mark, page, view, runtime }) {
  const ref = useRef(null);
  const { viewer } = runtime.editor;
  const [x0, y0, x1, y1] = mark.rect;
  const ready = page.kind !== "pdf" || view.renderState === "ready";
  const { style, strength, seed } = mark;
  const pageId = page.id;
  const rotation = view.rotation || 0;
  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    // a mark that is being dragged changes with every move: wait until it rests
    const timer = setTimeout(async () => {
      const rect = [x0, y0, x1, y1];
      const reach = await runtime.markReach(page, rect, "blur").catch(() => null);
      if (cancelled) return;
      const precise = reach?.path === "precise";
      const extent = precise ? reach.extent : rect;
      const unit = page.userUnit || 1;
      const geometry = pageGeometry(page);
      let pixels = mosaicPixels(geometry, extent, rect, reach?.path === "raster" ? EXPORT_PX_PER_PT.raster : EXPORT_PX_PER_PT.precise);
      // (a mark over a whole large page: computed more coarsely than the export does it)
      if (pixels.area[2] * pixels.area[3] > LIVE_MAX_PIXELS) pixels = mosaicPixels(geometry, extent, rect, pixels.scale * Math.sqrt(LIVE_MAX_PIXELS / (pixels.area[2] * pixels.area[3])));
      if (!pixels.area[2] || !pixels.area[3] || !pixels.mark[2] || !pixels.mark[3]) return;
      const { scale } = pixels;
      const random = await noiseOf(seed, rect, strength, extent, unit);
      if (cancelled) return;
      let request;
      try {
        request = viewer.renderToCanvas(pageId, { rect: pixels.userRect, scale, pixelRatio: 1, signal: controller.signal });
      } catch {
        return;
      }
      request.then(
        (source) => {
          const target = ref.current;
          const scratch = [source];
          try {
            if (cancelled || !target || !(source.width > 0 && source.height > 0)) return;
            // the piece as the page is stored
            const stored = turnedCanvas(source, -rotation);
            if (stored !== source) scratch.push(stored);
            const picture = stored.getContext("2d").getImageData(0, 0, stored.width, stored.height);
            obscureRegion(picture, 0, 0, stored.width, stored.height, { style, pxPerPt: scale, strength, random, sideways: rotation % 180 !== 0, emPt: precise ? reach.emPt : 0 });
            // the part of the mosaic that lies inside the mark (the area can be larger than the mark): the pixels
            // of the mark inside the pixels of the area, as the export crops it
            const left = Math.max(0, Math.min(stored.width - 1, pixels.mark[0] - pixels.area[0]));
            const top = Math.max(0, Math.min(stored.height - 1, pixels.mark[1] - pixels.area[1]));
            const width = Math.max(1, Math.min(stored.width - left, pixels.mark[2]));
            const height = Math.max(1, Math.min(stored.height - top, pixels.mark[3]));
            const shown = left || top || width !== stored.width || height !== stored.height ? cropRegion(picture, left, top, width, height) : picture;
            const flat = document.createElement("canvas");
            scratch.push(flat);
            flat.width = shown.width;
            flat.height = shown.height;
            flat.getContext("2d").putImageData(new ImageData(shown.data, shown.width, shown.height), 0, 0);
            // and as the screen shows the page
            const seen = turnedCanvas(flat, rotation);
            if (seen !== flat) scratch.push(seen);
            target.width = seen.width;
            target.height = seen.height;
            target.getContext("2d").drawImage(seen, 0, 0);
            target.setAttribute("data-ready", "true");
            target.setAttribute("data-area", extent.map((value) => Math.round(value * 100) / 100).join(","));
          } catch {
            // the stand-in stays
          } finally {
            release(...scratch);
          }
        },
        () => {}
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [runtime, viewer, page, pageId, x0, y0, x1, y1, style, strength, seed, ready, rotation]);
  return <canvas ref={ref} className="pdfx-ov-blur" aria-hidden="true" />;
}

/**
 * A pending redaction or blur mark: a rectangle on the ORIGINAL page content, below everything the user
 * added. Redaction: red outline and hatch; hovering or selecting it shows the colour the export will paint.
 * Blur: the live mosaic. From 60 px width a small "Pending" label says that nothing was removed yet.
 */
export const MarkView = memo(function MarkView({ mark, page, view, runtime, selected, flag }) {
  const { t } = useI18n();
  const [left, top, right, bottom] = userRectToPixels(page, mark.rect, view.scale);
  const width = right - left;
  const height = bottom - top;
  return (
    <div
      className="pdfx-ov-mark"
      data-object-id={mark.id}
      data-kind={mark.type}
      data-selected={selected ? "true" : undefined}
      data-preview={flag || undefined}
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, "--pdfx-mark-fill": mark.type === "redact" ? mark.color : undefined }}
    >
      {mark.type === "blur" && !flag ? <BlurPicture mark={mark} page={page} view={view} runtime={runtime} /> : null}
      {width >= 60 && height >= 12 ? <span className="pdfx-ov-mark-label">{t("Pending")}</span> : null}
    </div>
  );
});
