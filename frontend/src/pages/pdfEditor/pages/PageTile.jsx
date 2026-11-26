import { memo } from "react";
import { Check, EllipsisVertical, EyeOff, FilePlus2, RotateCw } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { cx } from "../ui/classNames.js";
import { visiblePageSize } from "../viewer/pageList.js";
import PageThumbnail from "../viewer/PageThumbnail.jsx";
import TileImages from "./TileImages.jsx";

// One page in the Pages panel or in the organiser: its thumbnail, its position number and what there is to
// know about it at a glance (rotated by the user, redaction or blur marks waiting, a blank page, the source
// file when the document has several). It is an option of the listbox around it (pages/PageGrid.jsx), which
// handles every pointer and key event: the tile itself has no handlers, so it only re-renders when one of its
// own facts changes (hundreds of pages stay cheap).
//
// DOM: div.pdfx-pagetile[role=option] with data-page-id, data-page-number, data-selected, data-current,
// data-rotation (what the user added), data-marks, data-kind; the thumbnail is the canvas of
// viewer/PageThumbnail.jsx (drawn near the screen only, released when it scrolls away).

/** The box a thumbnail is fitted into is this much taller than wide (a little more than A4 upright). */
export const FRAME_RATIO = 1.42;

function PageTile({ controller, page, number, width, selected, tabbable, current, marks, sourceColor, sourceName, images, checkable }) {
  const { t } = useI18n();
  const frameHeight = Math.round(width * FRAME_RATIO);
  const size = visiblePageSize(page);
  // as large as the box allows, whatever the shape of the page
  const thumbWidth = Math.max(8, Math.round(Math.min(width, (frameHeight * size.width) / size.height)));
  const thumbHeight = Math.max(1, Math.round((thumbWidth * size.height) / size.width));
  const blank = page.kind === "blank";

  const facts = [t("Page {page}", { page: number })];
  if (page.rotation) facts.push(t("Rotated {degrees} degrees", { degrees: page.rotation }));
  if (marks === 1) facts.push(t("1 redaction or blur mark waiting"));
  else if (marks > 1) facts.push(t("{count} redaction or blur marks waiting", { count: marks }));
  if (blank) facts.push(t("Blank page"));
  if (sourceName) facts.push(t("From {name}", { name: sourceName }));

  return (
    <div
      role="option"
      id={`pdfx-pagetile-${page.id}`}
      className={cx("pdfx-pagetile", checkable ? "pdfx-pagetile-checkable" : null)}
      aria-selected={selected ? "true" : "false"}
      aria-current={current ? "page" : undefined}
      aria-label={facts.join(", ")}
      tabIndex={tabbable ? 0 : -1}
      data-page-id={page.id}
      data-page-number={number}
      data-selected={selected ? "true" : "false"}
      data-current={current ? "true" : "false"}
      data-rotation={page.rotation}
      data-marks={marks || 0}
      data-kind={page.kind}
      data-source-id={page.sourceId || ""}
      data-testid="pdfx-pagetile"
      draggable="false"
    >
      <span className="pdfx-pagetile-frame" style={{ width, height: frameHeight }}>
        <span className="pdfx-pagetile-sheet" style={{ width: thumbWidth, height: thumbHeight }}>
          <PageThumbnail controller={controller} pageId={page.id} width={thumbWidth} />
          {images ? <TileImages page={page} images={images} /> : null}
          <span className="pdfx-pagetile-badges">
            {page.rotation ? (
              <span className="pdfx-pagetile-badge" title={t("Rotated {degrees} degrees", { degrees: page.rotation })} data-badge="rotated">
                <RotateCw size={12} strokeWidth={2.25} aria-hidden="true" />
              </span>
            ) : null}
            {marks ? (
              <span className="pdfx-pagetile-badge pdfx-pagetile-badge-marks" title={marks === 1 ? t("1 redaction or blur mark waiting") : t("{count} redaction or blur marks waiting", { count: marks })} data-badge="marks">
                <EyeOff size={12} strokeWidth={2.25} aria-hidden="true" />
                <span>{marks}</span>
              </span>
            ) : null}
            {blank ? (
              <span className="pdfx-pagetile-badge" title={t("Blank page")} data-badge="blank">
                <FilePlus2 size={12} strokeWidth={2.25} aria-hidden="true" />
              </span>
            ) : null}
          </span>
          {checkable ? (
            <span className="pdfx-pagetile-check" aria-hidden="true" data-pdfx-page-check="true">
              {selected ? <Check size={13} strokeWidth={3} /> : null}
            </span>
          ) : null}
          <button type="button" className="pdfx-pagetile-more" tabIndex={-1} aria-label={t("Page actions")} title={t("Page actions")} data-pdfx-page-menu="true" data-testid="pdfx-pagetile-menu">
            <EllipsisVertical size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </span>
        {sourceColor ? <span className="pdfx-pagetile-source" style={{ backgroundColor: sourceColor }} title={sourceName} data-testid="pdfx-pagetile-source" /> : null}
      </span>
      <span className="pdfx-pagetile-number">{number}</span>
    </div>
  );
}

export default memo(PageTile);
