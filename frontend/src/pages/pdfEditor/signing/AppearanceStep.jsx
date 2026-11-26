import { useId, useRef, useState } from "react";
import { ImagePlus, PenLine, Trash2 } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { useEditor } from "../ui/editorHooks.js";
import { APPEARANCE_LAYOUTS, APPEARANCE_LAYOUT_LABELS, DETAIL_CHOICES, DETAIL_KEYS, REASON_PRESETS } from "./appearanceLayout.js";
import { getStampPicture, setStampPicture, stampProblem, updateFlow } from "./certSignFlow.js";
import { FIELD_DEFAULT_SIZE, fieldScreenBox } from "./fieldGeometry.js";
import { canvasFromFile, pictureFromCanvas, pictureFromSaved } from "./signatureImages.js";
import { useIdentity, useSavedSignatures, useSignFlow, useStampPreview } from "./signingHooks.js";
import { SIGNATURE_DIALOG } from "./state.js";

// Step 2 of "Sign with certificate" (UX specification 7.11): what the signature looks like.
//   Visible or Invisible; for a visible one "Image and details", "Details only" or "Image only"; the image is
//   a saved signature picture, a new one from the signature dialog, or an uploaded picture (a company seal);
//   the details are check boxes; a live preview shows the stamp exactly as it will be painted.
// Reason and location are written into the signature itself, also when the signature is invisible.
//
// Test hooks: pdfx-sign-step-2; pdfx-sign-visible / -invisible (radio); pdfx-sign-layout-<id> (radio);
// pdfx-sign-picture (data-has-picture), pdfx-action-sign-picture-new, pdfx-sign-picture-input,
// pdfx-action-sign-picture-saved (data-id), pdfx-action-sign-picture-remove; pdfx-sign-show-<key> (check box);
// pdfx-sign-reason, pdfx-sign-location; pdfx-sign-preview (data-ready, data-clipped, data-empty), pdfx-sign-problem.
export default function AppearanceStep() {
  const { t } = useI18n();
  const editor = useEditor();
  const flow = useSignFlow();
  const identity = useIdentity();
  const saved = useSavedSignatures();
  const [uploadError, setUploadError] = useState("");
  const uploadRef = useRef(null);
  const visibilityName = useId();
  const layoutName = useId();
  const reasonId = useId();
  const reasonsId = useId();
  const locationId = useId();
  const state = editor.store.getState();
  const fieldPage = flow?.field ? state.pages.find((page) => page.id === flow.field.pageId) : null;
  const box = fieldPage ? fieldScreenBox(flow.field, fieldPage) : { width: FIELD_DEFAULT_SIZE[0], height: FIELD_DEFAULT_SIZE[1] };
  const preview = useStampPreview(box.width, box.height, Boolean(flow?.visible));
  if (!flow) return null;

  const picture = getStampPicture();
  const usesPicture = flow.visible && flow.layout !== "detailsOnly";
  const usesDetails = flow.visible && flow.layout !== "imageOnly";
  const problem = identity ? stampProblem(identity, flow) : null;
  const set = (patch) => updateFlow(editor, patch);

  const newPicture = async () => {
    const answer = await editor.ui.showDialog(SIGNATURE_DIALOG, { purpose: "pick" });
    if (answer?.picture) setStampPicture(editor, answer.picture);
  };
  const upload = async (file) => {
    setUploadError("");
    try {
      setStampPicture(editor, await pictureFromCanvas(await canvasFromFile(file)));
    } catch {
      setUploadError(t("This picture could not be read. Use a PNG or JPEG file."));
    }
  };

  return (
    <div className="pdfx-sign-step" data-testid="pdfx-sign-step-2">
      <fieldset className="pdfx-sign-group">
        <legend>{t("Signature on the page")}</legend>
        <div className="pdfx-sign-segments">
          <label className="pdfx-sign-segment" data-checked={flow.visible ? "true" : "false"}>
            <input type="radio" name={visibilityName} checked={flow.visible} data-testid="pdfx-sign-visible" onChange={() => set({ visible: true })} />
            <span>{t("Visible")}</span>
          </label>
          <label className="pdfx-sign-segment" data-checked={flow.visible ? "false" : "true"}>
            <input type="radio" name={visibilityName} checked={!flow.visible} data-testid="pdfx-sign-invisible" onChange={() => set({ visible: false })} />
            <span>{t("Invisible")}</span>
          </label>
        </div>
        {flow.visible ? null : <p className="pdfx-sign-hint">{t("An invisible signature leaves no mark on the pages. It is listed in the Signatures panel here and in other PDF programs.")}</p>}
      </fieldset>

      {flow.visible ? (
        <fieldset className="pdfx-sign-group">
          <legend>{t("Signature appearance")}</legend>
          <div className="pdfx-sign-choices">
            {APPEARANCE_LAYOUTS.map((id) => (
              <label key={id} className="pdfx-sign-check">
                <input type="radio" name={layoutName} checked={flow.layout === id} data-testid={`pdfx-sign-layout-${id}`} onChange={() => set({ layout: id })} />
                <span>{t(APPEARANCE_LAYOUT_LABELS[id])}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {usesPicture ? (
        <fieldset className="pdfx-sign-group">
          <legend>{t("Image")}</legend>
          <div className="pdfx-sign-picture" data-has-picture={picture ? "true" : "false"} data-testid="pdfx-sign-picture">
            {picture ? <img src={picture.dataUrl} alt={t("The picture of the stamp")} /> : <span>{t("No picture yet")}</span>}
          </div>
          <div className="pdfx-sign-row pdfx-sign-row-wrap">
            <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-sign-picture-new" onClick={newPicture}>
              <PenLine size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="pdfx-btn-label">{t("New signature")}</span>
            </button>
            <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" onClick={() => uploadRef.current?.click()}>
              <ImagePlus size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="pdfx-btn-label">{t("Upload a picture")}</span>
            </button>
            {picture ? (
              <button type="button" className="pdfx-btn" aria-label={t("Remove the picture")} data-tip={t("Remove the picture")} data-tip-align="end" data-testid="pdfx-action-sign-picture-remove" onClick={() => setStampPicture(editor, null)}>
                <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            ) : null}
            <input
              ref={uploadRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              hidden
              tabIndex={-1}
              data-testid="pdfx-sign-picture-input"
              onChange={(event) => {
                const [file] = event.target.files;
                event.target.value = "";
                if (file) upload(file);
              }}
            />
          </div>
          {uploadError ? (
            <p className="pdfx-sign-error" role="alert">
              {uploadError}
            </p>
          ) : null}
          {saved.length ? (
            <>
              <p className="pdfx-sign-sublabel">{t("Saved signatures")}</p>
              <div className="pdfx-sign-saved">
                {saved.map((entry, index) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="pdfx-sign-saved-item"
                    aria-label={t("Use saved signature {number}", { number: index + 1 })}
                    aria-pressed={picture?.dataUrl === entry.dataUrl ? "true" : "false"}
                    data-id={entry.id}
                    data-testid="pdfx-action-sign-picture-saved"
                    onClick={() => {
                      const chosen = pictureFromSaved(entry);
                      if (chosen) setStampPicture(editor, chosen);
                    }}
                  >
                    <img src={entry.dataUrl} alt="" />
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </fieldset>
      ) : null}

      {usesDetails ? (
        <fieldset className="pdfx-sign-group">
          <legend>{t("Details shown in the stamp")}</legend>
          <div className="pdfx-sign-choices pdfx-sign-choices-two">
            {DETAIL_KEYS.map((key) => (
              <label key={key} className="pdfx-sign-check">
                <input type="checkbox" checked={Boolean(flow.show[key])} data-testid={`pdfx-sign-show-${key}`} onChange={(event) => set({ show: { ...flow.show, [key]: event.target.checked } })} />
                <span>{t(DETAIL_CHOICES[key])}</span>
              </label>
            ))}
            <label className="pdfx-sign-check">
              <input type="checkbox" checked={Boolean(flow.show.labels)} data-testid="pdfx-sign-show-labels" onChange={(event) => set({ show: { ...flow.show, labels: event.target.checked } })} />
              <span>{t("Show labels")}</span>
            </label>
          </div>
        </fieldset>
      ) : null}

      <fieldset className="pdfx-sign-group">
        <legend>{t("Written into the signature")}</legend>
        <label className="pdfx-sign-label" htmlFor={reasonId}>
          {t("Reason")}
        </label>
        <input id={reasonId} className="pdfx-input" list={reasonsId} maxLength={200} value={flow.reason} placeholder={t("Choose a reason or type your own")} data-testid="pdfx-sign-reason" onChange={(event) => set({ reason: event.target.value })} />
        <datalist id={reasonsId}>
          {REASON_PRESETS.map((preset) => (
            <option key={preset} value={t(preset)} />
          ))}
        </datalist>
        <label className="pdfx-sign-label" htmlFor={locationId}>
          {t("Location")}
        </label>
        <input id={locationId} className="pdfx-input" maxLength={120} value={flow.location} data-testid="pdfx-sign-location" onChange={(event) => set({ location: event.target.value })} />
        <p className="pdfx-sign-hint">{t("Reason and location are stored in the signature itself and shown by PDF programs, also for an invisible signature.")}</p>
      </fieldset>

      {flow.visible ? (
        <div className="pdfx-sign-group">
          <p className="pdfx-sign-sublabel">{t("Preview of the stamp")}</p>
          <div className="pdfx-sign-preview" style={{ aspectRatio: `${Math.max(1, Math.round(box.width))} / ${Math.max(1, Math.round(box.height))}` }} data-ready={preview ? "true" : "false"} data-clipped={preview?.clipped ? "true" : "false"} data-empty={preview?.empty ? "true" : "false"} data-testid="pdfx-sign-preview">
            {preview && !preview.empty ? <img src={preview.url} alt={t("Preview of the stamp")} /> : null}
          </div>
          {problem === "empty" ? (
            <p className="pdfx-sign-error" role="alert" data-testid="pdfx-sign-problem">
              {flow.layout === "imageOnly" ? t("Choose a picture for the stamp, or another layout.") : t("The stamp would be empty. Tick at least one detail or choose a picture.")}
            </p>
          ) : null}
          {preview?.clipped ? <p className="pdfx-sign-hint">{t("Not every line fits into the rectangle at a readable size. Make the rectangle larger in the next step, or show fewer details.")}</p> : null}
          <p className="pdfx-sign-hint">{t("The date and time are taken from the clock of this computer at the moment you sign.")}</p>
        </div>
      ) : null}
    </div>
  );
}
