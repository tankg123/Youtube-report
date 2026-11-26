import { useId, useState } from "react";
import { ImagePlus } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import DialogFrame from "../../ui/dialogs/DialogFrame.jsx";
import { useDocument } from "../../ui/editorHooks.js";
import { insertionIndex, placeOfIndex, readPageNumber } from "../pageLogic.js";
import { Choice, DialogButtons, FormRow, PlaceRow } from "./parts.jsx";

// Insert > Image as page, after the pictures were chosen (UX specification 7.9): one page per picture, as an
// A4 page with the picture fitted on it (default) or as a page of the picture's own size, before or after
// which page. Props: fileNames, index. onClose({ mode: "a4" | "image", index }) inserts; onClose() cancels.
//
// Test hooks: pdfx-image-files (data-count), pdfx-image-mode-a4 / -image, pdfx-place-side, pdfx-place-page,
// pdfx-action-dialog-confirm / -cancel.

const SHOWN_NAMES = 4;

export default function InsertImagesDialog({ fileNames = [], index = 0, onClose }) {
  const { t } = useI18n();
  const pages = useDocument((state) => state.pages);
  const id = useId();
  const [mode, setMode] = useState("a4");
  const [where, setWhere] = useState(() => placeOfIndex(index, pages.length));
  const [checked, setChecked] = useState(false);
  const pageNumber = readPageNumber(where.pageNumber, pages.length);

  const confirm = () => {
    setChecked(true);
    if (!pageNumber) return;
    onClose({ mode, index: insertionIndex(pages.length, pageNumber, where.place) });
  };
  const onEnter = (event) => {
    event.preventDefault();
    confirm();
  };
  const hiddenNames = fileNames.length - SHOWN_NAMES;

  return (
    <DialogFrame
      title={t("Image as page")}
      icon={ImagePlus}
      subtitle={fileNames.length === 1 ? t("1 image becomes 1 page.") : t("{count} images become {count} pages, in this order.", { count: fileNames.length })}
      onClose={() => onClose()}
      footer={<DialogButtons confirmLabel={t("Insert")} onCancel={() => onClose()} onConfirm={confirm} />}
    >
      <div className="pdfx-pform" data-testid="pdfx-pform-image">
        <ul className="pdfx-pform-files" data-testid="pdfx-image-files" data-count={fileNames.length}>
          {fileNames.slice(0, SHOWN_NAMES).map((name, position) => (
            <li key={`${position}:${name}`}>{name}</li>
          ))}
          {hiddenNames > 0 ? <li className="pdfx-pform-files-more">{t("and {count} more", { count: hiddenNames })}</li> : null}
        </ul>
        <FormRow label={t("Page size")} labelId={`${id}-mode`} note={mode === "a4" ? t("The image is made as large as an A4 page allows; a wide image gets a page that lies on its side.") : t("The page is exactly as large as the image (96 pixels per inch).")}>
          <Choice
            value={mode}
            labelledBy={`${id}-mode`}
            onChange={setMode}
            options={[
              { value: "a4", caption: t("A4, image fitted"), testId: "pdfx-image-mode-a4" },
              { value: "image", caption: t("Same as the image"), testId: "pdfx-image-mode-image" }
            ]}
          />
        </FormRow>
        <PlaceRow
          place={where.place}
          pageNumber={where.pageNumber}
          pageCount={pages.length}
          error={checked && !pageNumber ? t("Type a page number between 1 and {count}.", { count: pages.length }) : null}
          onPlace={(place) => setWhere((current) => ({ ...current, place }))}
          onPageNumber={(value) => setWhere((current) => ({ ...current, pageNumber: value }))}
          onEnter={onEnter}
        />
      </div>
    </DialogFrame>
  );
}
