import { CircleCheck, CircleHelp, CircleX, FileBadge, Info, LoaderCircle, RotateCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { useDocument, useEditor } from "../ui/editorHooks.js";
import SignatureCard from "./SignatureCard.jsx";
import { useSignatures } from "./signingHooks.js";
import { inspectSource } from "./state.js";
import TrustedCertificates from "./TrustedCertificates.jsx";
import { bannerOf } from "./verdict.js";
import "../styles/signing.css";

// The Signatures panel of the left rail (UX specification 7.12 and 8): every digital signature of the working
// document, newest first, with its level, its integrity in words and its certificate; the overall result on
// top (the worst state wins); the empty state with "Sign with certificate"; and the trusted certificates of
// this device. After any edit of a signed document it says that the downloaded copy will not carry the old
// signatures.
//
// Test hooks: pdfx-signatures-panel (data-state "none" | "checking" | "unavailable" | "failed" | "skipped" |
// "ready", data-total, data-worst, data-edited), pdfx-signatures-summary (data-level), pdfx-signatures-edited,
// pdfx-signatures-empty, pdfx-action-sign-with-certificate, pdfx-action-signatures-check,
// pdfx-signatures-list, pdfx-signatures-file; the cards are documented in SignatureCard.jsx.

const SUMMARY_ICON = { success: CircleCheck, warning: TriangleAlert, error: CircleX, info: Info };

export default function SignaturesPanel() {
  const { t } = useI18n();
  const editor = useEditor();
  const hasDocument = useDocument((state) => state.pages.length > 0);
  const { entries, summary, edited } = useSignatures();
  const banner = bannerOf(summary);
  const SummaryIcon = banner ? SUMMARY_ICON[banner.tone] || CircleHelp : null;
  const files = [...new Set(summary.items.map((item) => item.sourceId))];
  const retry = entries.filter((entry) => entry.status === "failed" || entry.status === "skipped");
  const sign = () => editor.actions.setTool("certSign");

  return (
    <div className="pdfx-signatures" data-state={summary.state} data-total={summary.total} data-worst={summary.worst || ""} data-edited={edited ? "true" : "false"} data-testid="pdfx-signatures-panel">
      {banner ? (
        <p className="pdfx-signatures-summary" data-tone={banner.tone} data-level={banner.level || ""} role="status" data-testid="pdfx-signatures-summary">
          {summary.state === "checking" ? <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" className="pdfx-spin" /> : <SummaryIcon size={16} strokeWidth={2} aria-hidden="true" />}
          <span>{t(banner.text, banner.params)}</span>
        </p>
      ) : null}
      {edited ? (
        <p className="pdfx-signatures-edited" data-testid="pdfx-signatures-edited">
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
          <span>{t("You changed this document. The copy you download or sign will not carry the signatures listed here; the signed original file is not changed.")}</span>
        </p>
      ) : null}
      {retry.length ? (
        <div className="pdfx-signatures-actions">
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-signatures-check" onClick={() => retry.forEach((entry) => inspectSource(editor, entry.sourceId))}>
            <RotateCw size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Check the signatures now")}</span>
          </button>
        </div>
      ) : null}

      {summary.total ? (
        <div data-testid="pdfx-signatures-list">
          {files.map((sourceId) => {
            const items = summary.items.filter((item) => item.sourceId === sourceId);
            return (
              <section key={sourceId} className="pdfx-signatures-file" data-testid="pdfx-signatures-file">
                {files.length > 1 ? <h3>{items[0].name || t("Untitled")}</h3> : null}
                <ul className="pdfx-signatures-list">
                  {items.map((item) => (
                    <SignatureCard key={`${sourceId}-${item.signature.index ?? item.signature.objectOffset}`} sourceId={sourceId} signature={item.signature} level={item.level} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}

      {summary.state === "none" ? (
        <div className="pdfx-signatures-empty" data-testid="pdfx-signatures-empty">
          <ShieldCheck size={24} strokeWidth={1.5} aria-hidden="true" />
          <p>{hasDocument ? t("This document has no digital signatures.") : t("Open a document to see its digital signatures.")}</p>
        </div>
      ) : null}

      {hasDocument ? (
        <div className="pdfx-signatures-actions">
          <button type="button" className={summary.total ? "pdfx-btn pdfx-btn-text pdfx-btn-outline" : "pdfx-btn pdfx-btn-text pdfx-btn-primary"} data-testid="pdfx-action-sign-with-certificate" onClick={sign}>
            <FileBadge size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Sign with certificate")}</span>
          </button>
        </div>
      ) : null}
      {summary.total ? <p className="pdfx-sign-hint pdfx-signatures-note">{t("A digital signature is checked with the certificate inside it. A picture of a signature on a page proves nothing and is not listed here.")}</p> : null}

      <TrustedCertificates />
    </div>
  );
}
