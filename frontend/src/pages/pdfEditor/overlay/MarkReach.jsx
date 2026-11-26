import { memo, useEffect, useState } from "react";
import { Info, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { polygonPath, quadToPixels } from "./geometry.js";

// What a pending mark takes beyond its own rectangle, shown BEFORE the file is made (overlay/markReach.js has
// the reasons):
//   MarkReach       on the page: an outline around every run of letters that goes although it reaches beyond
//                   the mark (a letter is removed as a whole)
//   MarkReachNote   in the properties panel of one selected mark: the same in words, or that the page of the
//                   mark cannot be changed precisely and will become a picture
// The answer comes from the redaction engine's own dry run, 200 ms after the mark came to rest; until then
// and where the engine has nothing to say (a blank page, a very large file) nothing is shown.
//
// Test hooks: pdfx-mark-reach (data-reach-of, data-count, data-glyphs), pdfx-mark-reach-note (data-state
// "outside" | "raster").

const REST_MS = 200;

/** The reach of a mark (overlay/markReach.js reachOf), or null while it is not known. */
function useMarkReach(runtime, mark, page) {
  const [answer, setAnswer] = useState(null); // { key, reach }: what was learnt, and for which geometry
  const [x0, y0, x1, y1] = mark.rect;
  const { type } = mark;
  const key = `${mark.id}:${type}:${x0}:${y0}:${x1}:${y1}:${page ? `${page.sourceId}:${page.sourceIndex}` : ""}`;
  useEffect(() => {
    if (!page) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      runtime.markReach(page, [x0, y0, x1, y1], type).then((reach) => {
        if (!cancelled) setAnswer({ key, reach });
      });
    }, REST_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runtime, page, type, x0, y0, x1, y1, key]);
  return answer && answer.key === key ? answer.reach : null;
}

/**
 * @param {object} props
 * @param {object} props.mark     a redact or blur object of the document (not a preview copy)
 * @param {object} props.page     its Page
 * @param {object} props.view     { scale, width, height } of that page
 * @param {object} props.runtime  overlay/runtime.js
 */
export const MarkReach = memo(function MarkReach({ mark, page, view, runtime }) {
  const reach = useMarkReach(runtime, mark, page);
  if (!reach || reach.path !== "precise" || !reach.outside.length) return null;
  return (
    <svg className="pdfx-ov-chrome pdfx-ov-reach" width={view.width} height={view.height} aria-hidden="true" data-reach-of={mark.id} data-count={reach.outside.length} data-glyphs={reach.glyphs} data-testid="pdfx-mark-reach">
      {reach.outside.map((box, index) => (
        <path key={index} className="pdfx-ov-reach-box" d={polygonPath(quadToPixels(page, box.quad, view.scale))} />
      ))}
    </svg>
  );
});

/** The sentence of the properties panel for ONE selected mark. */
export function MarkReachNote({ mark, runtime }) {
  const { t } = useI18n();
  const reach = useMarkReach(runtime, mark, runtime.pageOf(mark.pageId));
  if (!reach) return null;
  if (reach.path === "raster") {
    return (
      <p className="pdfx-prop-alert" data-tone="warning" role="status" data-testid="pdfx-mark-reach-note" data-state="raster">
        <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
        <span>{t("The content under this mark cannot be removed precisely on this page: the whole page will be converted to an image when the file is created.")}</span>
      </p>
    );
  }
  if (reach.path !== "precise" || !reach.outside.length) return null;
  return (
    <p className="pdfx-prop-alert" data-tone="info" role="status" data-testid="pdfx-mark-reach-note" data-state="outside">
      <Info size={14} strokeWidth={2} aria-hidden="true" />
      <span>{t("This mark also removes the letters outlined in red around it: a letter is always removed as a whole. Make the mark smaller if they must stay.")}</span>
    </p>
  );
}
