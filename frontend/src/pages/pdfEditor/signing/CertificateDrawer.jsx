import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, FileBadge, Info, X } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { BarButton } from "../ui/controls.jsx";
import { useEditor, useUi } from "../ui/editorHooks.js";
import AppearanceStep from "./AppearanceStep.jsx";
import CertificateStep from "./CertificateStep.jsx";
import { STEPS, closeFlow, setStep, signNow, stampProblem } from "./certSignFlow.js";
import { markBackupDeclined } from "./identity.js";
import PositionStep from "./PositionStep.jsx";
import SignStep from "./SignStep.jsx";
import { useIdentity, useSignFlow } from "./signingHooks.js";
import "../styles/signing.css";

// "Sign with certificate" (Ký số): the drawer that takes the place of the properties panel while a
// certificate signature is prepared (UX specification 7.11). Four steps with an indicator: 1 Certificate,
// 2 Appearance, 3 Position on page (skipped for an invisible signature), 4 Sign. Back and Cancel are always
// there; Cancel leaves no trace of the flow (the certificate stays in memory until it is forgotten).
// What the steps do is certSignFlow.js; this file is the frame, the indicator and the buttons.
//
// Test hooks: the kernel's slot is pdfx-drawer-certSign; pdfx-sign-drawer (data-step, data-visible);
// pdfx-sign-step-indicator with pdfx-sign-step-tab (data-step, aria-current); pdfx-sign-note (data-code);
// pdfx-action-sign-back, pdfx-action-sign-next, pdfx-action-sign-now, pdfx-action-sign-close.
export default function CertificateDrawer() {
  const { t } = useI18n();
  const editor = useEditor();
  const flow = useSignFlow();
  const identity = useIdentity();
  const busy = useUi((state) => state.job !== null);
  const bodyRef = useRef(null);
  const step = flow?.step || 0;

  // a new step starts at its top, with the keyboard on its heading
  const headingRef = useRef(null);
  useEffect(() => {
    if (!step) return;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  if (!flow) return null;
  const cancel = () => closeFlow(editor);
  const current = STEPS.find((entry) => entry.id === flow.step) || STEPS[0];
  const problem = identity ? stampProblem(identity, flow) : null;

  let nextBlocked = "";
  if (flow.step === 1) {
    if (!identity) nextBlocked = t("Open or create a certificate first.");
    else if (identity.block) nextBlocked = t("This certificate cannot be used to sign.");
  } else if (flow.step === 2 && problem) {
    nextBlocked = t("The stamp would show nothing: choose a picture or a detail.");
  } else if (flow.step === 3 && !flow.field) {
    nextBlocked = t("Draw the rectangle of the signature on a page, or choose a place.");
  } else if (flow.step === 4 && (!identity || identity.block)) {
    nextBlocked = t("This certificate cannot be used to sign.");
  } else if (flow.step === 4 && flow.visible && !flow.field) {
    nextBlocked = t("Choose the position of the signature first.");
  }

  const next = async () => {
    if (nextBlocked) return;
    if (flow.step === 1 && identity?.backup === "pending") {
      // a certificate made in this page exists nowhere else: asked once before moving on without the file
      const go = await editor.actions.confirm({
        title: t("The certificate file was not downloaded"),
        message: t("Download the certificate file now. It is not stored and is lost when you close this page."),
        details: t("Without the file you cannot sign with this certificate again later."),
        confirmLabel: t("Continue without the file"),
        cancelLabel: t("Go back"),
        tone: "warning"
      });
      if (!go) return;
      markBackupDeclined();
    }
    setStep(editor, flow.step + 1);
  };

  return (
    <section className="pdfx-sign-drawer" aria-label={t("Sign with certificate")} data-step={flow.step} data-visible={flow.visible ? "true" : "false"} data-testid="pdfx-sign-drawer">
      <header className="pdfx-panel-head">
        <FileBadge size={16} strokeWidth={1.75} aria-hidden="true" />
        <h2>{t("Sign with certificate")}</h2>
        <BarButton icon={X} label={t("Cancel signing")} tipAlign="end" testId="pdfx-action-sign-close" onClick={cancel} />
      </header>
      <ol className="pdfx-sign-steps" aria-label={t("Steps")} data-testid="pdfx-sign-step-indicator">
        {STEPS.map((entry) => {
          const skipped = entry.id === 3 && !flow.visible;
          const state = entry.id === flow.step ? "current" : entry.id < flow.step ? "done" : "todo";
          return (
            <li key={entry.id} data-state={skipped ? "skipped" : state} data-step={entry.id} aria-current={entry.id === flow.step ? "step" : undefined} data-testid="pdfx-sign-step-tab">
              <span className="pdfx-sign-step-number" aria-hidden="true">
                {entry.id}
              </span>
              <span className="pdfx-sign-step-name">{t(entry.label)}</span>
            </li>
          );
        })}
      </ol>
      <div ref={bodyRef} className="pdfx-panel-body pdfx-sign-body">
        <h3 ref={headingRef} tabIndex={-1} className="pdfx-sign-heading">
          {t("Step {number} of {total}: {name}", { number: flow.step, total: STEPS.length, name: t(current.label) })}
        </h3>
        {flow.step === 1 && flow.rebuildReason ? (
          <p className="pdfx-sign-note" data-code={flow.rebuildReason.code} data-testid="pdfx-sign-note">
            <Info size={14} strokeWidth={2} aria-hidden="true" />
            <span>{t("A rewritten copy of this file will be signed. Existing signatures and the password protection are not kept in that copy.")}</span>
          </p>
        ) : null}
        {flow.step === 1
          ? flow.notes.map((note) => (
              <p key={note.code} className="pdfx-sign-note" data-code={note.code} data-testid="pdfx-sign-note">
                <Info size={14} strokeWidth={2} aria-hidden="true" />
                <span>{editor.messages.describeWarning(note)}</span>
              </p>
            ))
          : null}
        {flow.step === 1 ? <CertificateStep /> : null}
        {flow.step === 2 ? <AppearanceStep /> : null}
        {flow.step === 3 ? <PositionStep /> : null}
        {flow.step === 4 ? <SignStep /> : null}
      </div>
      <footer className="pdfx-sign-foot">
        {nextBlocked ? (
          <p className="pdfx-sign-foot-hint" data-testid="pdfx-sign-blocked">
            {nextBlocked}
          </p>
        ) : null}
        <div className="pdfx-sign-foot-buttons">
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" disabled={flow.step === 1 || busy} data-testid="pdfx-action-sign-back" onClick={() => setStep(editor, flow.step - 1)}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Back")}</span>
          </button>
          <button type="button" className="pdfx-btn pdfx-btn-text" disabled={busy} data-testid="pdfx-action-sign-cancel-flow" onClick={cancel}>
            <span className="pdfx-btn-label">{t("Cancel")}</span>
          </button>
          {flow.step < 4 ? (
            <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-primary" aria-disabled={nextBlocked ? "true" : undefined} data-testid="pdfx-action-sign-next" onClick={next}>
              <span className="pdfx-btn-label">{flow.step === 3 ? t("Use this position") : t("Next")}</span>
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-primary" aria-disabled={nextBlocked ? "true" : undefined} disabled={busy} data-testid="pdfx-action-sign-now" onClick={() => (nextBlocked ? undefined : signNow(editor))}>
              <FileBadge size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="pdfx-btn-label">{t("Sign and download")}</span>
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
