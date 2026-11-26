// A committed text object on a page. The element is the measuring host made visible: the same inline style
// (textStyle.js), the same text node, the same layout scale, painted through the frame's matrix. What the
// layout service measured and the exporter writes is therefore what stands here; the underline is drawn from
// the layout's rectangles, exactly as the exporter draws it.
//
// Props
//   object         the text object (model/schema.js)
//   geometry       { view, rotate, userUnit } of the page (schema.pageGeometry)
//   scale          CSS pixels per point of the page view (default 1)
//   extraRotation  the rotation the user added to the page: 0 / 90 / 180 / 270 (default 0)
//   layout         the object's TextLayout when the caller already has it (optional)
//   service        the text layout service; needed when `layout` is not given, and it loads the fonts
//   selected       adds data-selected="true" and a thin outline (optional)
//   onError(error) a font of the box could not be loaded: a PdfEditorError with a TEXT_FONT_ code (optional)
// Nothing is rendered until the faces of the text are loaded (with `layout` and no `service` the caller
// vouches for that). Place the component in the page element (position: relative): its root sits at
// left 0 / top 0 and carries the whole placement in its transform.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { frameToCssMatrix } from "../engine/geometry.js";
import { TEXT_RASTERIZED } from "./codes.js";
import { LAYOUT_SCALE, TEXT_BOX_ATTRIBUTES, boxDomText, layoutScaleTransform, textBoxStyle } from "./textStyle.js";
import "../styles/text.css";

const noSubscription = () => () => {};
const noVersion = () => 0;
const px = (points) => `${points * LAYOUT_SCALE}px`;

function resolveLayout(object, layout, service, fontsVersion) {
  void fontsVersion; // a face that finished loading makes a layout possible that was not before
  // a layout from the caller is shown at once when there is no service to ask; with a service, only when the
  // faces are loaded (a layout kept from an earlier page load must not put the text up in a system font)
  if (layout) return !service || service.isReady(object) ? layout : null;
  if (!service) return null;
  try {
    return service.layout(object);
  } catch {
    // TEXT_FONT_NOT_LOADED: the effect below loads the faces and the font subscription renders again
    return null;
  }
}

export default function TextBox({ object, geometry, scale = 1, extraRotation = 0, layout, service, selected = false, onError }) {
  const fonts = service?.fonts;
  const fontsVersion = useSyncExternalStore(fonts ? fonts.subscribe : noSubscription, fonts ? fonts.getVersion : noVersion);
  const resolved = useMemo(() => resolveLayout(object, layout, service, fontsVersion), [object, layout, service, fontsVersion]);

  const report = useRef(onError);
  useEffect(() => {
    report.current = onError;
  });
  // the faces depend on the font and the text alone: a box that is dragged or resized does not ask again
  const missing = !resolved;
  const { font, bold, italic, text } = object;
  useEffect(() => {
    if (!missing || !service) return undefined;
    let cancelled = false;
    service.ensureFonts({ font, bold, italic, text }).catch((error) => {
      if (!cancelled) report.current?.(error);
    });
    return () => {
      cancelled = true;
    };
  }, [missing, service, font, bold, italic, text]);

  if (!resolved) return null;
  const matrix = frameToCssMatrix(geometry, object.frame, scale, extraRotation);
  const rasterized = resolved.problems.includes(TEXT_RASTERIZED);
  return (
    <div
      className="pdfx-textbox"
      data-object-id={object.id}
      data-kind="text"
      data-selected={selected ? "true" : undefined}
      data-rasterized={rasterized ? "true" : undefined}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: px(object.frame.w),
        height: px(object.frame.h),
        transformOrigin: "0 0",
        transform: layoutScaleTransform(matrix),
        opacity: object.opacity,
        "--pdfx-text-unit": LAYOUT_SCALE / scale
      }}
    >
      <div className="pdfx-textbox-text" {...TEXT_BOX_ATTRIBUTES} style={textBoxStyle(object)}>
        {boxDomText(object.text)}
      </div>
      {resolved.underlines.map((rect, index) => (
        <div
          key={index}
          className="pdfx-textbox-rule"
          style={{ position: "absolute", left: px(rect.x), top: px(rect.y), width: px(rect.w), height: px(rect.h), backgroundColor: object.color, pointerEvents: "none" }}
        />
      ))}
    </div>
  );
}
