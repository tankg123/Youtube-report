// Stage D of the pipeline: the certificate signature, always an incremental revision appended to finished
// bytes (the output of buildOutput(), or the ORIGINAL bytes of a source when the document is exactly that
// source: its earlier signatures then stay valid).
//
//   signOutput(bytes, signOptions)                               inspectPdf, then signPdf
//   verifySigned(bytes, { fieldName, trustedCertificates, now })  the new signature, read back
//
// Nothing here knows a key or a password: signOptions go to engine/sign as they are.
import { PdfEditorError, throwIfAborted } from "../errors.js";
import { inspectPdf, inspectSignatures, signPdf } from "../sign/index.js";

/** Warnings of the inspection and of the signer in order, each { code, params } once. */
function mergeWarnings(...lists) {
  const seen = new Set();
  const out = [];
  for (const entry of lists.flat()) {
    if (!entry || typeof entry.code !== "string") continue;
    const copy = { code: entry.code, params: { ...(entry.params || {}) } };
    const key = JSON.stringify([copy.code, copy.params]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(copy);
  }
  return out;
}

/**
 * Signs finished bytes with a certificate.
 *
 * @param {Uint8Array} bytes  the PDF to sign; never changed (the result starts with exactly these bytes)
 * @param {object} signOptions  the options of signPdf() of engine/sign: { signer, appearance, name, reason,
 *        location, contactInfo, fieldName, certify, subFilter, signingTime, signal, ... } (an unknown key is refused)
 * @returns {Promise<{ bytes: Uint8Array, report: object }>}  report = the report of signPdf(); its `warnings`
 *          also hold what inspectPdf() found (SIGN_CERTIFIED { level }, SIGN_HYBRID_XREF, SIGN_XFA ...), each once
 * @throws PdfEditorError  a blocker of inspectPdf() as its own code (SIGN_ENCRYPTED, SIGN_NOT_A_PDF,
 *         SIGN_DAMAGED_XREF, SIGN_NO_PAGES, SIGN_CERTIFIED_NO_CHANGES, SIGN_LEADING_BYTES, SIGN_NO_WEBCRYPTO),
 *         every code of signPdf(), CANCELLED. Nothing is returned then.
 */
export async function signOutput(bytes, signOptions = {}) {
  const signal = signOptions && typeof signOptions === "object" ? signOptions.signal : undefined;
  throwIfAborted(signal);
  const facts = await inspectPdf(bytes);
  const blocker = facts.findings.find((finding) => finding.blocking);
  if (blocker) throw new PdfEditorError(blocker.code, { ...(blocker.params || {}) }, { detail: "the file cannot be signed" });
  throwIfAborted(signal);
  const signed = await signPdf(bytes, signOptions);
  return {
    bytes: signed.bytes,
    report: { ...signed.report, warnings: mergeWarnings(facts.findings.filter((finding) => !finding.blocking), signed.report.warnings) }
  };
}

/**
 * Reads a signature back from signed bytes: the proof, made with the inspector, that what is about to be
 * downloaded is intact.
 *
 * @param {Uint8Array} bytes  the signed file
 * @param {{ fieldName?: string, trustedCertificates?: Uint8Array[], now?: Date, signal?: AbortSignal }} [options]
 *        fieldName: report.fieldName of signOutput(); without it the last signature of the file is taken
 * @returns {Promise<{ ok: boolean, signature: object | null, report: object }>}
 *          signature: the entry of that field in inspectSignatures().signatures (null: no such signature);
 *          ok: its digest matches, its signature value verifies, it covers the whole file and the inspector's
 *          verdict is "valid" or "valid-with-warnings". ok says nothing about WHO signed: that is
 *          signature.trust.status, "trusted" only against trustedCertificates.
 *          report: everything inspectSignatures() returned.
 */
export async function verifySigned(bytes, { fieldName, trustedCertificates, now, signal } = {}) {
  const options = {};
  if (trustedCertificates !== undefined && trustedCertificates !== null) options.trustedCertificates = trustedCertificates;
  if (now !== undefined && now !== null) options.now = now;
  if (signal) options.signal = signal;
  const report = await inspectSignatures(bytes, options);
  const wanted = fieldName === undefined || fieldName === null ? report.signatures : report.signatures.filter((entry) => entry.fieldName === fieldName);
  const signature = wanted.length ? wanted[wanted.length - 1] : null;
  const ok = Boolean(signature)
    && signature.digestMatches === true
    && signature.signatureValid === true
    && signature.coverage?.status === "whole-file"
    && (signature.verdict === "valid" || signature.verdict === "valid-with-warnings");
  return { ok, signature, report };
}
