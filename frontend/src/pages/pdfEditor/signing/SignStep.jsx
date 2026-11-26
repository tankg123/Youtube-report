import { useId } from "react";
import { CircleAlert, CircleCheck, Circle, LoaderCircle, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { useDocument, useEditor, useHistoryState } from "../ui/editorHooks.js";
import { FILE_EXTENSION } from "../ui/fileNames.js";
import { CertificateCard } from "./CertificateStep.jsx";
import { SIGN_STAGES, documentFacts, updateFlow } from "./certSignFlow.js";
import { FIELD_DEFAULT_SIZE, fieldScreenBox } from "./fieldGeometry.js";
import { useIdentity, useSignFlow, useStampPreview } from "./signingHooks.js";

// Step 4 of "Sign with certificate" (UX specification 7.11): the summary, "Lock document after signing", the
// file name, and while and after the job its three named stages: applying edits, signing, checking the
// signature. After a failure nothing was downloaded: the step shows the sentence and the stage it happened in.
//
// Test hooks: pdfx-sign-step-4 (data-original, data-run-stage, data-run-failed); pdfx-sign-summary-what
// (data-kind "original" | "edits" | "rewrite"); pdfx-sign-lock; pdfx-sign-filename; pdfx-sign-stages with
// pdfx-sign-stage (data-state "pending" | "running" | "done" | "failed"); pdfx-sign-run-error.
const STAGE_ICONS = { pending: Circle, running: LoaderCircle, done: CircleCheck, failed: CircleAlert };

export default function SignStep() {
  const { t } = useI18n();
  const editor = useEditor();
  const flow = useSignFlow();
  const identity = useIdentity();
  // the summary follows the document while the drawer is open (an undo, another edit)
  const pages = useDocument((state) => state.pages);
  useDocument((state) => state.objects);
  useHistoryState();
  const lockId = useId();
  const nameId = useId();
  const fieldPage = flow?.field ? pages.find((page) => page.id === flow.field.pageId) : null;
  const box = fieldPage ? fieldScreenBox(flow.field, fieldPage) : { width: FIELD_DEFAULT_SIZE[0], height: FIELD_DEFAULT_SIZE[1] };
  const preview = useStampPreview(box.width, box.height, Boolean(flow?.visible && fieldPage));
  if (!flow || !identity) return null;

  const facts = documentFacts(editor);
  const kind = facts.original ? "original" : flow.rebuildReason && facts.pristine ? "rewrite" : "edits";
  const canLock = !facts.original || flow.canCertify;
  const run = flow.run;
  const stageState = (number) => {
    if (!run || !run.stage) return "pending";
    if (number < run.stage) return "done";
    if (number > run.stage) return "pending";
    return run.failed ? "failed" : "running";
  };

  let what;
  if (kind === "original") {
    what = facts.signatures > 0 ? t("The file is signed as it is: your signature is added to it and the existing signatures stay valid.") : t("The file is signed as it is: nothing else in it changes.");
  } else if (kind === "rewrite") {
    what = t("A rewritten copy of the file is signed. Existing signatures and the password protection are not kept in that copy.");
  } else {
    const parts = [];
    if (facts.objects === 1) parts.push(t("1 object you added"));
    else if (facts.objects > 1) parts.push(t("{count} objects you added", { count: facts.objects }));
    if (facts.marks === 1) parts.push(t("1 redaction or blur mark"));
    else if (facts.marks > 1) parts.push(t("{count} redaction and blur marks", { count: facts.marks }));
    what = parts.length ? t("Your edits are applied to the document first: {items}, and your page changes.", { items: parts.join(", ") }) : t("Your edits are applied to the document first (pages added, removed, moved or turned).");
  }

  return (
    <div className="pdfx-sign-step" data-testid="pdfx-sign-step-4" data-original={facts.original ? "true" : "false"} data-run-stage={run?.stage || ""} data-run-failed={run?.failed ? "true" : "false"}>
      <section className="pdfx-sign-summary">
        <h3>{t("Certificate")}</h3>
        <CertificateCard identity={identity} compact />
      </section>

      <section className="pdfx-sign-summary">
        <h3>{t("Appearance")}</h3>
        {flow.visible ? (
          <>
            {preview && !preview.empty ? (
              <div className="pdfx-sign-preview pdfx-sign-preview-small" style={{ aspectRatio: `${Math.max(1, Math.round(box.width))} / ${Math.max(1, Math.round(box.height))}` }}>
                <img src={preview.url} alt={t("Preview of the stamp")} />
              </div>
            ) : null}
            <p>{fieldPage ? t("Visible signature on page {number}", { number: pages.indexOf(fieldPage) + 1 }) : t("Visible signature: the position is not chosen yet.")}</p>
          </>
        ) : (
          <p>{t("Invisible signature: no mark on the pages")}</p>
        )}
        {flow.reason.trim() ? <p>{t("Reason: {reason}", { reason: flow.reason.trim() })}</p> : null}
        {flow.location.trim() ? <p>{t("Location: {location}", { location: flow.location.trim() })}</p> : null}
      </section>

      <section className="pdfx-sign-summary">
        <h3>{t("Before signing")}</h3>
        <p data-kind={kind} data-testid="pdfx-sign-summary-what">
          {what}
        </p>
        {kind === "edits" && facts.signatures > 0 ? (
          <p className="pdfx-sign-warning">
            <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
            <span>{facts.signatures === 1 ? t("The existing signature is not kept in the signed copy.") : t("The {count} existing signatures are not kept in the signed copy.", { count: facts.signatures })}</span>
          </p>
        ) : null}
        {kind === "edits" && facts.marks > 0 ? (
          <p className="pdfx-sign-warning">
            <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
            <span>{t("Redaction permanently removes the marked content from the signed file.")}</span>
          </p>
        ) : null}
      </section>

      <div className="pdfx-sign-group">
        <label className="pdfx-sign-check" htmlFor={lockId}>
          <input id={lockId} type="checkbox" checked={Boolean(flow.lock) && canLock} disabled={!canLock} data-testid="pdfx-sign-lock" onChange={(event) => updateFlow(editor, { lock: event.target.checked })} />
          <span>{t("Lock document after signing")}</span>
        </label>
        <p className="pdfx-sign-hint">
          {canLock
            ? t("Nobody can change or sign the file afterwards without invalidating this signature. Leave it off when others still have to sign.")
            : t("Only the first signature of a document can lock it, and this document is already signed.")}
        </p>
      </div>

      <div className="pdfx-sign-group">
        <label className="pdfx-sign-label" htmlFor={nameId}>
          {t("Name of the signed file")}
        </label>
        <div className="pdfx-sign-filename">
          <input id={nameId} className="pdfx-input" maxLength={150} value={flow.fileName} data-testid="pdfx-sign-filename" onChange={(event) => updateFlow(editor, { fileName: event.target.value })} />
          <span aria-hidden="true">{FILE_EXTENSION}</span>
        </div>
        <p className="pdfx-sign-hint">{t("The signed file is downloaded and then reopened here, so that you can check the signature at once.")}</p>
      </div>

      <ol className="pdfx-sign-stages" aria-label={t("Steps of signing")} data-testid="pdfx-sign-stages">
        {SIGN_STAGES.map((label, index) => {
          const state = stageState(index + 1);
          const Icon = STAGE_ICONS[state];
          return (
            <li key={label} data-state={state} data-testid="pdfx-sign-stage">
              <Icon size={15} strokeWidth={2} aria-hidden="true" className={state === "running" ? "pdfx-spin" : undefined} />
              <span>{t(label)}</span>
            </li>
          );
        })}
      </ol>
      {run?.failed && run.message ? (
        <p className="pdfx-sign-error" role="alert" data-testid="pdfx-sign-run-error">
          {run.message}
        </p>
      ) : null}
    </div>
  );
}
