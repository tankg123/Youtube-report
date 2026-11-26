import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { ImagePlus, Info, Keyboard, PenLine, Signature, Upload, X } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { SIGNATURE_FONTS } from "../model/schema.js";
import { fontsThatCover, normalizeText, renderTypedSignature } from "../text/index.js";
import DialogFrame, { DialogButton } from "../ui/dialogs/DialogFrame.jsx";
import { useEditor } from "../ui/editorHooks.js";
import { BACKGROUND_THRESHOLD } from "./imageOps.js";
import { INK_COLORS, canvasFromFile, pictureForStorage, pictureFromPng, pictureFromSaved, pictureFromUpload } from "./signatureImages.js";
import SignaturePad from "./SignaturePad.jsx";
import { useSavedSignatures } from "./signingHooks.js";
import { getSignatureShelf } from "./state.js";
import { MAX_SAVED_SIGNATURES } from "./storage.js";
import "../styles/signing.css";

// "Add signature" (Chữ ký), UX specification 7.10: a PICTURE of a handwritten signature.
//   Draw      a pad (SignaturePad.jsx)
//   Type it   a name in one of the four bundled script faces, shown as live previews (text/raster.js
//             renderTypedSignature); only the faces that can write the whole name are offered
//             (fontsThatCover), so a Vietnamese name keeps all its marks
//   Upload    a picture (a photo of a signature on paper): "Remove the white background" with a threshold
//             slider, trimmed to what is left, previewed on a checkerboard
// plus the saved signatures of this device (at most 10, in this browser only; a click uses one, each can be
// removed) and the explanation that a picture proves nothing about who signed.
//
// Props: purpose "place" (the picture is placed on a page) | "pick" (it becomes the picture of a certificate
// stamp); onClose({ picture }) with picture = { png, width, height, dataUrl }, or onClose() when cancelled.
//
// Test hooks: pdfx-dialog-signature; pdfx-sig-dialog (data-tab); pdfx-sig-tab-draw / -type / -upload;
// pdfx-sig-saved with pdfx-action-sig-use-saved and pdfx-action-sig-remove-saved (data-id); the pad:
// SignaturePad.jsx; pdfx-sig-name, pdfx-sig-face (data-font, aria-pressed, data-ready), pdfx-sig-no-face;
// pdfx-sig-upload-input, pdfx-action-sig-upload, pdfx-sig-remove-background, pdfx-sig-threshold,
// pdfx-sig-upload-preview (data-ready); pdfx-sig-save; pdfx-sig-error; pdfx-action-sig-add, pdfx-action-sig-cancel.

const TABS = ["draw", "type", "upload"];
const PREVIEW_HEIGHT = 96;
const TYPED_HEIGHT = 220;

/** "Type it": a name and the script faces that can write it. */
function TypeTab({ ref }) {
  const { t } = useI18n();
  const editor = useEditor();
  const [name, setName] = useState("");
  const [ink, setInk] = useState("black");
  const [manifest, setManifest] = useState(editor.fonts.manifest);
  const [chosen, setChosen] = useState(null);
  const [previews, setPreviews] = useState({}); // font key -> data URL
  const nameId = useId();
  const inkGroup = useId();
  const text = normalizeText(name).trim();

  useEffect(() => {
    if (manifest) return undefined;
    let live = true;
    editor.fonts
      .loadManifest()
      .then((loaded) => {
        if (live) setManifest(loaded);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [editor, manifest]);

  const faces = manifest && text ? fontsThatCover(manifest, text, "signature") : [];
  const facesKey = faces.join(",");
  const selected = faces.includes(chosen) ? chosen : faces[0] || null;

  useEffect(() => {
    if (!facesKey) return undefined;
    let live = true;
    // after a short pause: not one picture per key stroke
    const timer = setTimeout(async () => {
      const next = {};
      for (const font of facesKey.split(",")) {
        try {
          const picture = await renderTypedSignature({ text, font, color: INK_COLORS[ink], heightPx: PREVIEW_HEIGHT, fonts: editor.fonts });
          if (picture) next[font] = pictureFromPng(picture).dataUrl;
        } catch {
          // a face that could not be loaded is simply not previewed
        }
        if (!live) return;
      }
      setPreviews(next);
    }, 160);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [editor, facesKey, ink, text]);

  useImperativeHandle(ref, () => ({
    isEmpty: () => !text || !selected,
    async getPicture() {
      if (!text || !selected) return null;
      const picture = await renderTypedSignature({ text, font: selected, color: INK_COLORS[ink], heightPx: TYPED_HEIGHT, fonts: editor.fonts });
      return picture ? pictureFromPng(picture) : null;
    }
  }));

  const familyOf = (fontKey) => SIGNATURE_FONTS.find((font) => fontKey.startsWith(font.id))?.family || fontKey;
  return (
    <>
      <div className="pdfx-sig-field">
        <label className="pdfx-sign-label" htmlFor={nameId}>
          {t("Your name")}
        </label>
        <input id={nameId} className="pdfx-input" maxLength={60} autoComplete="off" spellCheck="false" value={name} data-testid="pdfx-sig-name" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="pdfx-sig-controls">
        <span>{t("Ink")}</span>
        <label>
          <input type="radio" name={inkGroup} checked={ink === "black"} onChange={() => setInk("black")} />
          <span className="pdfx-sig-swatch" style={{ background: INK_COLORS.black }} aria-hidden="true" />
          <span>{t("Black")}</span>
        </label>
        <label>
          <input type="radio" name={inkGroup} checked={ink === "blue"} onChange={() => setInk("blue")} />
          <span className="pdfx-sig-swatch" style={{ background: INK_COLORS.blue }} aria-hidden="true" />
          <span>{t("Blue")}</span>
        </label>
      </div>
      {text && manifest && !faces.length ? (
        <p className="pdfx-sig-error" role="alert" data-testid="pdfx-sig-no-face">
          {t("None of the signature fonts can write every character of this name. Remove unusual characters, or draw the signature instead.")}
        </p>
      ) : null}
      {faces.length ? (
        <div className="pdfx-sig-faces" role="group" aria-label={t("Signature style")}>
          {faces.map((font) => (
            <button key={font} type="button" className="pdfx-sig-face" aria-pressed={selected === font ? "true" : "false"} data-font={font} data-ready={previews[font] ? "true" : "false"} data-testid="pdfx-sig-face" onClick={() => setChosen(font)}>
              <span className="pdfx-sig-face-picture">{previews[font] ? <img src={previews[font]} alt={t("{name} written in {font}", { name: text, font: familyOf(font) })} /> : null}</span>
              <span>{familyOf(font)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="pdfx-sign-hint">{t("Type your name to see it in four handwriting styles.")}</p>
      )}
    </>
  );
}

/** "Upload": a picture, with or without its white background. */
function UploadTab({ ref }) {
  const { t } = useI18n();
  const [source, setSource] = useState(null); // { canvas, name }
  const [removeBackground, setRemoveBackground] = useState(true);
  const [threshold, setThreshold] = useState(BACKGROUND_THRESHOLD.default);
  const [picture, setPicture] = useState(null);
  const [state, setState] = useState("empty"); // empty | working | ready | nothing | unreadable
  const inputRef = useRef(null);
  const thresholdId = useId();

  useEffect(() => {
    if (!source) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const next = await pictureFromUpload(source.canvas, { removeBackground, threshold });
        if (!live) return;
        setPicture(next);
        setState(next ? "ready" : "nothing");
      } catch {
        if (live) setState("unreadable");
      }
    }, 80);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, removeBackground, threshold]);

  const choose = async (file) => {
    setState("working");
    setPicture(null);
    try {
      setSource({ canvas: await canvasFromFile(file), name: file.name });
    } catch {
      setSource(null);
      setState("unreadable");
    }
  };

  useImperativeHandle(ref, () => ({
    isEmpty: () => !picture,
    getPicture: async () => picture
  }));

  return (
    <>
      <div className="pdfx-sign-row pdfx-sign-row-wrap">
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-sig-upload" onClick={() => inputRef.current?.click()}>
          <ImagePlus size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="pdfx-btn-label">{source ? t("Choose another picture") : t("Choose a picture")}</span>
        </button>
        <span className="pdfx-sign-file">{source ? source.name : t("A photo or a scan of your signature on white paper works best.")}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          hidden
          tabIndex={-1}
          data-testid="pdfx-sig-upload-input"
          onChange={(event) => {
            const [file] = event.target.files;
            event.target.value = "";
            if (file) choose(file);
          }}
        />
      </div>
      <div className="pdfx-sig-controls">
        <label>
          <input type="checkbox" checked={removeBackground} data-testid="pdfx-sig-remove-background" onChange={(event) => setRemoveBackground(event.target.checked)} />
          <span>{t("Remove the white background")}</span>
        </label>
        {/* the slider runs from "little" to "much": a LOWER brightness limit removes more */}
        <label htmlFor={thresholdId}>
          <span>{t("How much counts as background")}</span>
          <input
            id={thresholdId}
            type="range"
            min={BACKGROUND_THRESHOLD.min}
            max={BACKGROUND_THRESHOLD.max}
            step={BACKGROUND_THRESHOLD.step}
            value={BACKGROUND_THRESHOLD.min + BACKGROUND_THRESHOLD.max - threshold}
            disabled={!removeBackground}
            data-testid="pdfx-sig-threshold"
            onChange={(event) => setThreshold(BACKGROUND_THRESHOLD.min + BACKGROUND_THRESHOLD.max - Number(event.target.value))}
          />
        </label>
      </div>
      <div className="pdfx-sig-checker" data-ready={state === "ready" ? "true" : "false"} data-state={state} data-testid="pdfx-sig-upload-preview">
        {state === "ready" && picture ? <img src={picture.dataUrl} alt={t("The picture as it will be placed")} /> : null}
        {state === "empty" ? <span>{t("No picture yet")}</span> : null}
        {state === "working" ? <span>{t("Reading the picture…")}</span> : null}
      </div>
      {state === "nothing" ? (
        <p className="pdfx-sig-error" role="alert">
          {t("Nothing is left of the picture with this setting. Move the slider to the left, or keep the background.")}
        </p>
      ) : null}
      {state === "unreadable" ? (
        <p className="pdfx-sig-error" role="alert">
          {t("This picture could not be read. Use a PNG or JPEG file.")}
        </p>
      ) : null}
    </>
  );
}

export default function SignatureDialog({ purpose = "place", onClose }) {
  const { t } = useI18n();
  const saved = useSavedSignatures();
  const [tab, setTab] = useState("draw");
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const source = useRef(null);
  const tabsId = useId();
  const full = saved.length >= MAX_SAVED_SIGNATURES;
  const labels = { draw: t("Draw"), type: t("Type it"), upload: t("Upload") };
  const icons = { draw: PenLine, type: Keyboard, upload: Upload };
  const cancel = () => onClose(undefined);

  const add = async () => {
    if (busy) return;
    setProblem("");
    setBusy(true);
    try {
      const picture = await source.current?.getPicture();
      if (!picture) {
        setProblem(tab === "draw" ? t("Draw your signature first.") : tab === "type" ? t("Type your name first.") : t("Choose a picture first."));
        return;
      }
      if (save && !full) {
        // a failure to save never stops the signature from being used
        const small = await pictureForStorage(picture).catch(() => null);
        if (small) getSignatureShelf().add({ dataUrl: small.dataUrl, width: small.width, height: small.height, kind: tab });
      }
      onClose({ picture });
    } catch {
      setProblem(t("The signature picture could not be created. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const onTabKey = (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
    setTab(next);
    setProblem("");
    queueMicrotask(() => document.getElementById(`${tabsId}-${next}`)?.focus());
  };

  return (
    <DialogFrame
      size="md"
      icon={Signature}
      title={purpose === "pick" ? t("Signature picture for the stamp") : t("Add signature")}
      onClose={cancel}
      footer={
        <>
          <DialogButton data-testid="pdfx-action-sig-cancel" onClick={cancel}>
            {t("Cancel")}
          </DialogButton>
          <DialogButton variant="primary" disabled={busy} data-testid="pdfx-action-sig-add" onClick={add}>
            {purpose === "pick" ? t("Use this signature") : t("Add")}
          </DialogButton>
        </>
      }
    >
      <div className="pdfx-sig-dialog" data-tab={tab} data-testid="pdfx-sig-dialog">
        {saved.length ? (
          <section aria-label={t("Saved signatures")}>
            <p className="pdfx-sign-sublabel">{t("Saved signatures")}</p>
            <ul className="pdfx-sig-saved" data-testid="pdfx-sig-saved">
              {saved.map((entry, index) => (
                <li key={entry.id} className="pdfx-sig-saved-item" data-id={entry.id}>
                  <button
                    type="button"
                    className="pdfx-sig-saved-use pdfx-sig-checker"
                    aria-label={t("Use saved signature {number}", { number: index + 1 })}
                    data-id={entry.id}
                    data-testid="pdfx-action-sig-use-saved"
                    onClick={() => {
                      const picture = pictureFromSaved(entry);
                      if (picture) onClose({ picture });
                    }}
                  >
                    <img src={entry.dataUrl} alt="" />
                  </button>
                  <button type="button" className="pdfx-sig-saved-remove" aria-label={t("Remove saved signature {number}", { number: index + 1 })} data-id={entry.id} data-testid="pdfx-action-sig-remove-saved" onClick={() => getSignatureShelf().remove(entry.id)}>
                    <X size={12} strokeWidth={2} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="pdfx-sig-tabs" role="tablist" aria-label={t("How to make the signature")} onKeyDown={onTabKey}>
          {TABS.map((id) => {
            const Icon = icons[id];
            return (
              <button
                key={id}
                id={`${tabsId}-${id}`}
                type="button"
                role="tab"
                className="pdfx-sig-tab"
                aria-selected={tab === id ? "true" : "false"}
                aria-controls={`${tabsId}-panel`}
                tabIndex={tab === id ? 0 : -1}
                data-testid={`pdfx-sig-tab-${id}`}
                onClick={() => {
                  setTab(id);
                  setProblem("");
                }}
              >
                <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
                {labels[id]}
              </button>
            );
          })}
        </div>
        <div id={`${tabsId}-panel`} className="pdfx-sig-panel" role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
          {tab === "draw" ? <SignaturePad ref={source} onChange={() => setProblem("")} /> : null}
          {tab === "type" ? <TypeTab ref={source} /> : null}
          {tab === "upload" ? <UploadTab ref={source} /> : null}
        </div>
        <p className="pdfx-sig-error" role="alert" data-testid={problem ? "pdfx-sig-error" : undefined}>
          {problem || null}
        </p>

        <label className="pdfx-sign-check">
          <input type="checkbox" checked={save && !full} disabled={full} data-testid="pdfx-sig-save" onChange={(event) => setSave(event.target.checked)} />
          <span>{t("Save signature on this device")}</span>
        </label>
        <p className="pdfx-sign-hint">
          {full
            ? t("{count} signatures are saved, which is the most this device keeps. Remove one to save another.", { count: MAX_SAVED_SIGNATURES })
            : t("Saved signatures are stored only in this browser on this device. On a shared computer, leave this off.")}
        </p>
        <p className="pdfx-sig-note">
          <Info size={15} strokeWidth={2} aria-hidden="true" />
          <span>{t("This places a picture of your signature. A picture does not prove who signed. For a signature that can be verified, use Sign with certificate.")}</span>
        </p>
      </div>
    </DialogFrame>
  );
}
