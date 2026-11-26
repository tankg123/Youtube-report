import { MonitorX } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import "../styles/shell.css";

// The page a browser gets that cannot run the editor (UX specification 10): what is missing, by name, and
// which browsers work. Nothing of the editor itself is loaded behind it.
// Test hooks: pdfx-unsupported (data-missing), pdfx-action-unsupported-home.
export default function UnsupportedBrowser({ missing }) {
  const { t, language } = useI18n();
  return (
    <div className="pdfx-root pdfx-crash" lang={language} data-readonly-allow="true" data-testid="pdfx-unsupported" data-missing={missing.join(",")} role="alert">
      <div className="pdfx-empty-card">
        <MonitorX size={36} strokeWidth={1.5} aria-hidden="true" className="pdfx-empty-icon pdfx-empty-icon-error" />
        <p className="pdfx-empty-lead">{t("This browser cannot run the PDF editor.")}</p>
        <p className="pdfx-empty-note">{t("It is missing: {features}.", { features: missing.join(", ") })}</p>
        <p className="pdfx-empty-note">{t("Use a current version of Chrome, Edge, Firefox or Safari.")}</p>
        <div className="pdfx-empty-actions">
          <a href="/home" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-unsupported-home">
            <span className="pdfx-btn-label">{t("Back to home")}</span>
          </a>
        </div>
      </div>
    </div>
  );
}
