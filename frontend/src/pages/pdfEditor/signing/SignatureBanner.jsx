import { CircleCheck, CircleHelp, CircleX, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { useEditor, useUi } from "../ui/editorHooks.js";
import { useSignatures } from "./signingHooks.js";
import { PANEL_ID } from "./state.js";
import { bannerOf } from "./verdict.js";
import "../styles/signing.css";

// The banner under the tool bar for a document with digital signatures (UX specification 7.12 and 8): one
// sentence for all signatures, the worst state wins ("Signed by 2 people. All signatures are valid." /
// "Signed, but 1 signer could not be verified." / "1 signature is invalid."). Never green unless every signer
// is verified against the trusted certificates of this device. After an edit it adds that the downloaded copy
// will not carry the signatures.
//
// Test hooks: pdfx-sign-banner (data-tone "success" | "warning" | "error" | "info", data-level, data-state,
// data-edited), pdfx-action-show-signatures.

const ICONS = { success: CircleCheck, warning: TriangleAlert, error: CircleX, info: Info };

export default function SignatureBanner() {
  const { t } = useI18n();
  const { actions } = useEditor();
  const panelOpen = useUi((state) => state.leftPanel === PANEL_ID);
  const { summary, edited } = useSignatures();
  const banner = bannerOf(summary);
  if (!banner) return null;
  const Icon = ICONS[banner.tone] || CircleHelp;
  return (
    <div className="pdfx-sign-banner" role="status" data-tone={banner.tone} data-level={banner.level || ""} data-state={summary.state} data-edited={edited ? "true" : "false"} data-testid="pdfx-sign-banner">
      {summary.state === "checking" ? <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" className="pdfx-spin" /> : <Icon size={16} strokeWidth={2} aria-hidden="true" />}
      <p>
        {t(banner.text, banner.params)}
        {edited ? <span className="pdfx-sign-banner-edited"> {t("You changed the document: the copy you download will not carry these signatures.")}</span> : null}
      </p>
      {panelOpen ? null : (
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline pdfx-sign-banner-button" data-testid="pdfx-action-show-signatures" onClick={() => actions.openLeftPanel(PANEL_ID)}>
          <span className="pdfx-btn-label">{t("Show signatures")}</span>
        </button>
      )}
    </div>
  );
}
