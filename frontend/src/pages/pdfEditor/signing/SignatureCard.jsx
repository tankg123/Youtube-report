import { useId, useState } from "react";
import { ChevronDown, ChevronUp, CircleCheck, CircleHelp, CircleX, Info, Lock, LocateFixed, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { Chip } from "../ui/controls.jsx";
import { useEditor } from "../ui/editorHooks.js";
import { goToSignature } from "./state.js";
import { LEVEL_LABELS, LEVEL_TONES, describeIntegrity, describeTrust, integrityOf, signingTimeOf, trustOf } from "./verdict.js";

// One signature in the Signatures panel (UX specification 7.12). What it says, each on its own line:
//   the level                Valid / Valid, signer not verified / Invalid / Cannot be verified (verdict.js)
//   who and when             the signer's name and organisation; the signing time, always as a statement that is
//                            NOT proven: "stated by the signer", or "of a timestamp whose service was not
//                            verified" (the engine never validates a time-stamp authority)
//   integrity in words       not modified since signing / covers an earlier version, added later: ... / modified
//   the three facts          the signed content, the signature value, what the signature covers: never merged
//   trust                    why the signer is (not) verified on this device; for a chain that was not accepted,
//                            one line per certificate and reason (verdict.js describeTrustFailures)
//   revocation               always "Revocation was not checked"
// and, on request, the certificate: issued to, issued by, serial number, validity, SHA-256 fingerprint, algorithms.
//
// Test hooks: pdfx-signature (data-level, data-index, data-kind, data-field, data-integrity, data-trust,
// data-content, data-value, data-coverage), pdfx-signature-level, pdfx-signature-integrity,
// pdfx-signature-trust, pdfx-signature-trust-details, pdfx-signature-revocation, pdfx-signature-time (data-source
// "timestamp" | "signer" | "", data-proven always "false"), pdfx-signature-lock,
// pdfx-action-signature-goto, pdfx-action-signature-details, pdfx-signature-details.

const LEVEL_ICON = { valid: CircleCheck, unverified: TriangleAlert, invalid: CircleX, unknown: CircleHelp };
// already said by the integrity line
const SILENT_PROBLEMS = new Set(["SIGN_CHANGED_AFTER_SIGNING", "SIGN_LATER_REVISIONS", "SIGN_DOCUMENT_MODIFIED"]);

function Fact({ state, good, bad, unknown, testId }) {
  const Icon = state === true ? CircleCheck : state === false ? CircleX : CircleHelp;
  return (
    <li data-state={state === true ? "ok" : state === false ? "bad" : "unknown"} data-testid={testId}>
      <Icon size={13} strokeWidth={2} aria-hidden="true" />
      <span>{state === true ? good : state === false ? bad : unknown}</span>
    </li>
  );
}

export default function SignatureCard({ sourceId, signature, level }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const editor = useEditor();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const stamp = signature.kind === "document-timestamp";
  const integrity = integrityOf(signature);
  const words = describeIntegrity(integrity, t, (change) => editor.messages.describeCode(change.code, change.params));
  const trust = trustOf(signature);
  const trustWords = describeTrust(trust, t);
  const time = signingTimeOf(signature);
  const certificate = signature.signerCertificate || null;
  const subject = certificate?.subject || {};
  const issuer = certificate?.issuer || {};
  const Icon = LEVEL_ICON[level];
  const label = stamp && level === "unverified" ? t("Valid, authority not verified") : t(LEVEL_LABELS[level]);
  const problems = [...new Map((signature.problems || []).filter((problem) => problem && !SILENT_PROBLEMS.has(problem.code)).map((problem) => [problem.code, problem])).values()];
  const canGo = Number.isInteger(signature.pageIndex);
  const locked = signature.isCertification && signature.docMdp?.level === 1;
  const certified = signature.isCertification && !locked;
  const coverageState = integrity.coverage === "whole-file" ? true : integrity.coverage === "partial" ? false : null;
  const IntegrityIcon = words.tone === "ok" ? CircleCheck : words.tone === "bad" ? CircleX : words.tone === "info" ? Info : CircleHelp;

  return (
    <li
      className="pdfx-signature"
      data-level={level}
      data-index={signature.index ?? ""}
      data-kind={signature.kind || "signature"}
      data-field={signature.fieldName || ""}
      data-integrity={integrity.state}
      data-trust={trust.state}
      data-content={String(integrity.content)}
      data-value={String(integrity.value)}
      data-coverage={integrity.coverage || ""}
      data-testid="pdfx-signature"
    >
      <div className="pdfx-signature-head" data-tone={LEVEL_TONES[level]}>
        <Icon size={18} strokeWidth={2} aria-hidden="true" />
        <strong data-testid="pdfx-signature-level">{label}</strong>
        {locked ? (
          <Chip tone="warning" icon={Lock} testId="pdfx-signature-lock">
            {t("Locked by the signer")}
          </Chip>
        ) : null}
        {certified ? (
          <Chip tone="info" icon={Lock} testId="pdfx-signature-lock">
            {t("Certified by the signer")}
          </Chip>
        ) : null}
      </div>

      <p className="pdfx-signature-who">
        {stamp ? t("Document timestamp") : signature.signerName || t("Unknown signer")}
        {!stamp && subject.organization ? <span className="pdfx-signature-org">{subject.organization}</span> : null}
      </p>
      {stamp && signature.signerName ? <p className="pdfx-signature-line">{t("Timestamp authority: {name}", { name: signature.signerName })}</p> : null}
      <p className="pdfx-signature-line" data-proven="false" data-source={time.source || ""} data-testid="pdfx-signature-time">
        {time.value === null
          ? t("The signing time is not stated.")
          : stamp
            ? t("Time of the timestamp: {time} (the timestamp service was not verified, so this time is not proven)", { time: formatDateTime(time.value) })
            : time.source === "timestamp"
              ? t("Signed {time} (time of a timestamp in the signature; the timestamp service was not verified, so this time is not proven)", { time: formatDateTime(time.value) })
              : t("Signed {time} (time stated by the signer; it is not proven)", { time: formatDateTime(time.value) })}
      </p>

      <p className="pdfx-signature-check" data-tone={words.tone} data-testid="pdfx-signature-integrity">
        <IntegrityIcon size={14} strokeWidth={2} aria-hidden="true" />
        <span>{words.text}</span>
      </p>
      {words.details.length ? (
        <ul className="pdfx-signature-changes">
          {words.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      <ul className="pdfx-signature-facts" aria-label={t("What was checked")}>
        <Fact state={integrity.content} good={t("Signed content unchanged")} bad={t("Signed content changed")} unknown={t("Content could not be checked")} testId="pdfx-signature-fact-content" />
        <Fact state={integrity.value} good={t("Signature matches the certificate")} bad={t("Signature does not match the certificate")} unknown={t("Signature could not be checked")} testId="pdfx-signature-fact-value" />
        <Fact
          state={coverageState}
          good={t("Covers the whole document")}
          bad={t("Covers only a part of the file")}
          unknown={integrity.coverage === "revision" ? t("Covers an earlier version") : t("Coverage unknown")}
          testId="pdfx-signature-fact-coverage"
        />
      </ul>

      <p className="pdfx-signature-check" data-tone={trustWords.tone === "ok" ? "ok" : "warn"} data-testid="pdfx-signature-trust">
        {trustWords.tone === "ok" ? <CircleCheck size={14} strokeWidth={2} aria-hidden="true" /> : <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />}
        <span>{trustWords.text}</span>
      </p>
      {trustWords.details.length ? (
        <ul className="pdfx-signature-changes" data-testid="pdfx-signature-trust-details">
          {trustWords.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {problems.map((problem) => (
        <p key={problem.code} className="pdfx-signature-check" data-tone={problem.severity === "error" ? "bad" : problem.severity === "warning" ? "warn" : "info"} data-code={problem.code} data-testid="pdfx-signature-problem">
          {problem.severity === "error" ? <CircleX size={14} strokeWidth={2} aria-hidden="true" /> : problem.severity === "warning" ? <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" /> : <Info size={14} strokeWidth={2} aria-hidden="true" />}
          <span>{editor.messages.describeCode(problem.code, problem.params || {})}</span>
        </p>
      ))}
      <p className="pdfx-signature-check" data-tone="info" data-testid="pdfx-signature-revocation">
        <Info size={14} strokeWidth={2} aria-hidden="true" />
        <span>{t("Revocation was not checked")}</span>
      </p>

      {signature.reason ? <p className="pdfx-signature-line">{t("Reason: {reason}", { reason: signature.reason })}</p> : null}
      {signature.location ? <p className="pdfx-signature-line">{t("Location: {location}", { location: signature.location })}</p> : null}
      {signature.visible === false ? <p className="pdfx-signature-line pdfx-signature-muted">{t("No visible mark on the page")}</p> : null}

      <div className="pdfx-signature-actions">
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" disabled={!canGo} data-testid="pdfx-action-signature-goto" onClick={() => goToSignature(editor, sourceId, signature)}>
          <LocateFixed size={15} strokeWidth={1.75} aria-hidden="true" />
          <span className="pdfx-btn-label">{signature.visible === false ? t("Go to its page") : t("Go to signature")}</span>
        </button>
        <button type="button" className="pdfx-btn pdfx-btn-text" aria-expanded={open ? "true" : "false"} aria-controls={detailsId} disabled={!certificate} data-testid="pdfx-action-signature-details" onClick={() => setOpen((now) => !now)}>
          <span className="pdfx-btn-label">{t("Certificate details")}</span>
          {open ? <ChevronUp size={15} strokeWidth={1.75} aria-hidden="true" /> : <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
      {open && certificate ? (
        <dl id={detailsId} className="pdfx-signature-details" data-testid="pdfx-signature-details">
          <div>
            <dt>{t("Issued to")}</dt>
            <dd>{subject.text || certificate.displayName || "-"}</dd>
          </div>
          <div>
            <dt>{t("Issued by")}</dt>
            <dd>{certificate.selfSigned ? t("The holder itself (self-signed)") : issuer.text || certificate.issuerDisplayName || "-"}</dd>
          </div>
          <div>
            <dt>{t("Serial number")}</dt>
            <dd className="pdfx-mono">{certificate.serialNumber || "-"}</dd>
          </div>
          <div>
            <dt>{t("Validity")}</dt>
            <dd>{t("{from} to {to}", { from: formatDate(certificate.notBefore), to: formatDate(certificate.notAfter) })}</dd>
          </div>
          <div>
            <dt>{t("SHA-256 fingerprint")}</dt>
            <dd className="pdfx-mono">{certificate.fingerprintSha256 || "-"}</dd>
          </div>
          <div>
            <dt>{t("Key")}</dt>
            <dd>{certificate.publicKey?.description || "-"}</dd>
          </div>
          <div>
            <dt>{t("Certificate signed with")}</dt>
            <dd>{certificate.signatureAlgorithm?.name || "-"}</dd>
          </div>
          <div>
            <dt>{t("Document signed with")}</dt>
            <dd>{[signature.signatureAlgorithm, signature.digestAlgorithm].filter(Boolean).join(", ") || "-"}</dd>
          </div>
          <div>
            <dt>{t("Signature format")}</dt>
            <dd className="pdfx-mono">{signature.subFilter || "-"}</dd>
          </div>
          {signature.fieldName ? (
            <div>
              <dt>{t("Signature field")}</dt>
              <dd>{signature.fieldName}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}
