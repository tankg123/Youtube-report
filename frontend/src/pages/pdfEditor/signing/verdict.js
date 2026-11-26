// What the signatures panel and the banner say about a signature: pure functions over the report of
// engine/sign inspectSignatures(). No DOM, no engine import: tests/pdfSigningVerdict.test.mjs.
//
// The four honest levels (UX specification 7.12):
//   valid        the signed bytes are intact, the signature verifies, AND the signer's certificate chains to a
//                certificate the user trusts on this device (trust.status "trusted")
//   unverified   intact and verifies, but nothing vouches for WHO signed: self-signed, unknown issuer, a chain
//                that could not be checked, or a certificate outside its validity period
//   invalid      the signed bytes were changed, the signature value does not verify, a structural rule is
//                broken, or the document was changed after signing in a way that is not just "more signatures"
//   unknown      it could not be verified here (unsupported algorithm, unreadable data, revisions that could
//                not be compared)
// A level is never "valid" without trust.status === "trusted": a self-signed or untrusted certificate is
// never shown in green. The three facts of a validation stay apart (integrityOf): the bytes, the signature
// value, what the signature covers.
import { tk } from "../../../i18n/index.js";

export const LEVELS = Object.freeze(["valid", "unverified", "invalid", "unknown"]);
/** How bad a level is for the banner: the worst state wins. */
export const LEVEL_RANK = Object.freeze({ valid: 0, unverified: 1, unknown: 2, invalid: 3 });
export const LEVEL_LABELS = Object.freeze({
  valid: tk("Valid"),
  unverified: tk("Valid, signer not verified"),
  invalid: tk("Invalid"),
  unknown: tk("Cannot be verified")
});
/** lucide-react names (ui/icons.js lists them). */
export const LEVEL_ICONS = Object.freeze({ valid: "CircleCheck", unverified: "TriangleAlert", invalid: "CircleX", unknown: "CircleHelp" });
export const LEVEL_TONES = Object.freeze({ valid: "success", unverified: "warning", invalid: "danger", unknown: "neutral" });

// The engine calls a certificate that was outside its validity period at the signing time an error. The
// bytes are intact and the signature verifies all the same: that is "signer not verified", not "invalid".
const VALIDITY_CODES = Object.freeze(["CERT_EXPIRED_AT_SIGNING", "CERT_NOT_YET_VALID_AT_SIGNING"]);

const list = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === "object";

/** The level of one entry of inspectSignatures(...).signatures. Anything that is not a report is "unknown". */
export function levelOf(signature) {
  if (!isObject(signature)) return "unknown";
  const errors = list(signature.problems).filter((problem) => problem?.severity === "error");
  const hard = errors.filter((problem) => !VALIDITY_CODES.includes(problem.code));
  if (signature.digestMatches === false || signature.signatureValid === false || signature.integrity?.ok === false || hard.length) return "invalid";
  if (signature.digestMatches !== true || signature.signatureValid !== true || signature.verdict === "unknown") return "unknown";
  const coverage = signature.coverage?.status;
  if (coverage === "revision") {
    const kind = signature.changesAfterSigning?.classification;
    if (kind === "other") return "invalid";
    if (kind !== "signatures-only") return "unknown";
  } else if (coverage !== "whole-file") {
    return "invalid"; // a signature over a part of the file vouches for nothing a reader sees
  }
  // what this function does not know about must never look better than the engine says
  if (signature.verdict === "document-changed") return "invalid";
  if (signature.verdict === "invalid" && !errors.length) return "invalid";
  if (errors.length) return "unverified";
  return signature.trust?.status === "trusted" ? "valid" : "unverified";
}

/**
 * The three facts, each on its own, and what happened after the signature.
 * @returns {{
 *   content: boolean | null,        the signed bytes are the ones in the file
 *   value: boolean | null,          the signature value verifies with the certificate in the signature
 *   coverage: "whole-file" | "revision" | "partial" | null,
 *   state: "intact" | "earlier" | "changed-later" | "earlier-unknown" | "modified" | "partial" | "unknown",
 *   laterSignatures: number, laterTimestamps: number, onlyValidationData: boolean,
 *   changes: Array<{ code: string, params: object }>     what was changed afterwards and is not allowed
 * }}
 */
export function integrityOf(signature) {
  const safe = isObject(signature) ? signature : {};
  const content = safe.digestMatches === true ? true : safe.digestMatches === false ? false : null;
  const value = safe.signatureValid === true ? true : safe.signatureValid === false ? false : null;
  const status = safe.coverage?.status;
  const coverage = status === "whole-file" || status === "revision" || status === "partial" ? status : null;
  const after = isObject(safe.changesAfterSigning) ? safe.changesAfterSigning : null;
  const later = list(after?.laterSignatures);
  const changes = list(after?.items)
    .filter((item) => item && item.allowed === false && typeof item.code === "string")
    .map((item) => ({ code: item.code, params: { ...(item.params || {}) } }));
  let state = "unknown";
  if (content === false) state = "modified";
  else if (content !== true) state = "unknown";
  else if (coverage === "whole-file") state = "intact";
  else if (coverage === "revision") state = after?.classification === "signatures-only" ? "earlier" : after?.classification === "other" ? "changed-later" : "earlier-unknown";
  else if (coverage === "partial") state = "partial";
  return {
    content,
    value,
    coverage,
    state,
    laterSignatures: later.filter((entry) => entry?.kind !== "document-timestamp").length,
    laterTimestamps: later.filter((entry) => entry?.kind === "document-timestamp").length,
    onlyValidationData: Boolean(after?.onlyValidationData),
    changes
  };
}

/** "1 signature, 1 timestamp": what was added after a signature that covers an earlier version. */
export function describeAdditions(integrity, t) {
  const parts = [];
  if (integrity.laterSignatures === 1) parts.push(t("1 signature"));
  else if (integrity.laterSignatures > 1) parts.push(t("{count} signatures", { count: integrity.laterSignatures }));
  if (integrity.laterTimestamps === 1) parts.push(t("1 timestamp"));
  else if (integrity.laterTimestamps > 1) parts.push(t("{count} timestamps", { count: integrity.laterTimestamps }));
  if (!parts.length) parts.push(t("data for checking signatures"));
  return parts.join(", ");
}

/**
 * Integrity in words (the line of the signature card).
 * @param {object} integrity  integrityOf(signature)
 * @param {(text: string, params?: object) => string} t
 * @param {(change: { code: string, params: object }) => string} [describeChange]  sentence for one change
 * @returns {{ tone: "ok" | "info" | "bad" | "unknown", text: string, details: string[] }}
 */
export function describeIntegrity(integrity, t, describeChange) {
  switch (integrity.state) {
    case "intact":
      return { tone: "ok", text: t("Not modified since signing"), details: [] };
    case "earlier":
      return { tone: "info", text: t("This signature covers an earlier version of the document. Added later: {items}.", { items: describeAdditions(integrity, t) }), details: [] };
    case "changed-later":
      return {
        tone: "bad",
        text: t("This signature covers an earlier version of the document. The document was changed after it was signed."),
        details: describeChange ? [...new Set(integrity.changes.map((change) => describeChange(change)).filter(Boolean))] : []
      };
    case "earlier-unknown":
      return { tone: "unknown", text: t("This signature covers an earlier version of the document. What was changed afterwards could not be determined."), details: [] };
    case "modified":
      return { tone: "bad", text: t("Modified after signing"), details: [] };
    case "partial":
      return { tone: "bad", text: t("This signature covers only a part of the file."), details: [] };
    default:
      return { tone: "unknown", text: t("Whether the document was changed could not be checked."), details: [] };
  }
}

/**
 * Why a chain of certificates was not accepted (trust.failures[].reason of the engine) -> the sentence about
 * the certificate concerned. The engine only ever calls a signer trusted when EVERY link from the signer's
 * certificate up to a certificate of the user's list verified and the chain keeps the rules of its authorities.
 */
const FAILURE_SENTENCES = Object.freeze({
  "link-not-verified": tk("This certificate could not be checked against the certificate that issued it: the check failed, or it was signed with a method that is not supported here."),
  "not-valid-at-time": tk("This certificate was not valid at the signing time (expired, or not valid yet)."),
  "anchor-not-valid-at-time": tk("This certificate from your trusted list was not valid at the signing time (expired, or not valid yet)."),
  "not-a-ca": tk("This certificate issued another certificate of the chain, but it is not the certificate of an issuing authority."),
  "anchor-not-a-ca": tk("This certificate from your trusted list is not the certificate of an issuing authority, so it cannot vouch for other certificates."),
  "no-certificate-signing-usage": tk("This certificate is not allowed to issue certificates."),
  "path-length-exceeded": tk("This certificate allows fewer certificates below it than the chain has."),
  "unsupported-critical-extension": tk("This certificate carries a mandatory rule that the editor cannot evaluate, so the chain is not accepted.")
});
const FAILURE_OTHER = tk("This certificate does not meet the rules for a chain of certificates.");

/**
 * Who signed, as far as this device can tell. The interface goes by trust.status alone: "trusted" is the only
 * value that ever reads as a verified signer.
 * @returns {{ state: "trusted" | "self-signed" | "unknown-issuer" | "chain-unverified" | "chain-invalid" |
 *            "no-certificate" | "not-evaluated", anchor: string,
 *            failures: Array<{ reason: string, name: string }>,     why a chain was not accepted, per certificate
 *            mismatch: boolean }}     "not-evaluated": the signature value does not verify (false: it could not be checked)
 */
export function trustOf(signature) {
  const trust = isObject(signature?.trust) ? signature.trust : {};
  const anchor = String(trust.anchorCommonName || "");
  const failures = list(trust.failures)
    .filter((failure) => isObject(failure) && typeof failure.reason === "string" && failure.reason)
    .map((failure) => ({ reason: failure.reason, name: typeof failure.commonName === "string" ? failure.commonName : "" }));
  const answer = (state, extra = {}) => ({ state, anchor: "", failures: [], mismatch: false, ...extra });
  if (trust.status === "trusted") return answer("trusted", { anchor });
  if (trust.reason === "no-signer-certificate") return answer("no-certificate");
  // (also with a list of trusted certificates: a chain names a signer only through a signature value that verifies)
  if (trust.reason === "not-evaluated") return answer("not-evaluated", { mismatch: signature?.signatureValid === false });
  if (trust.reason === "path-not-valid") return answer("chain-invalid", { anchor, failures });
  if (failures.some((failure) => failure.reason === "link-not-verified")) return answer("chain-unverified", { failures });
  if (trust.selfSigned) return answer("self-signed");
  return answer("unknown-issuer");
}

/** One sentence per reason a chain was not accepted, each naming its certificate where the engine names it. */
export function describeTrustFailures(failures, t) {
  const sentences = list(failures).map((failure) => {
    const sentence = t(Object.prototype.hasOwnProperty.call(FAILURE_SENTENCES, failure?.reason) ? FAILURE_SENTENCES[failure.reason] : FAILURE_OTHER);
    return failure?.name ? t("{name}: {problem}", { name: failure.name, problem: sentence }) : sentence;
  });
  return [...new Set(sentences)];
}

/** The sentence for trustOf(): { tone: "ok" | "warn", text, details: string[] } (details: why a chain was not accepted). */
export function describeTrust(trust, t) {
  const details = describeTrustFailures(trust.failures, t);
  switch (trust.state) {
    case "trusted":
      return {
        tone: "ok",
        text: trust.anchor
          ? t("The signer's certificate leads to {name}, which is in your list of trusted certificates.", { name: trust.anchor })
          : t("The signer's certificate is in your list of trusted certificates."),
        details: []
      };
    case "self-signed":
      return { tone: "warn", text: t("Self-signed certificate: the signer's identity is not confirmed"), details: [] };
    case "chain-unverified":
      return { tone: "warn", text: t("A certificate between the signer and its issuer could not be checked here, so the signer's identity is not confirmed."), details };
    case "chain-invalid":
      return {
        tone: "warn",
        text: trust.anchor
          ? t("The certificates lead to {name} in your list of trusted certificates, but the chain breaks a rule, so the signer's identity is not confirmed.", { name: trust.anchor })
          : t("The chain of certificates breaks a rule, so the signer's identity is not confirmed."),
        details
      };
    case "no-certificate":
      return { tone: "warn", text: t("The signature does not contain the signer's certificate."), details: [] };
    case "not-evaluated":
      return {
        tone: "warn",
        text: trust.mismatch
          ? t("The signer's identity was not checked because the signature does not match the certificate.")
          : t("The signer's identity was not checked because the signature itself could not be verified."),
        details: []
      };
    default:
      return { tone: "warn", text: t("The issuer is not in your list of trusted certificates on this device."), details: [] };
  }
}

/** Signatures newest first (the engine lists them in signing order), each with its level. */
export function listSignatures(report) {
  return list(report?.signatures)
    .map((signature, position) => ({ signature, level: levelOf(signature), position }))
    .sort((a, b) => (b.signature?.index ?? b.position + 1) - (a.signature?.index ?? a.position + 1));
}

/**
 * The state of the signatures of the working document, from the inspection of every source in use.
 * @param {Array<{ sourceId: string, name?: string, status: string, report?: object, code?: string }>} entries
 *        status: "pending" | "running" | "done" | "failed" | "unavailable" | "skipped"
 * @returns {{
 *   state: "none" | "checking" | "unavailable" | "failed" | "skipped" | "ready",
 *   items: Array<{ sourceId, name, signature, level }>,     newest first within a file
 *   counts: { valid, unverified, invalid, unknown }, total: number, signers: number, timestamps: number,
 *   worst: "valid" | "unverified" | "invalid" | "unknown" | null,
 *   locked: boolean        a certification that allows no changes
 * }}
 */
export function summarize(entries) {
  const items = [];
  const counts = { valid: 0, unverified: 0, invalid: 0, unknown: 0 };
  let checking = false;
  let unavailable = false;
  let failed = false;
  let skipped = false;
  let done = 0;
  let locked = false;
  for (const entry of list(entries)) {
    if (entry.status === "pending" || entry.status === "running") checking = true;
    else if (entry.status === "unavailable") unavailable = true;
    else if (entry.status === "failed") failed = true;
    else if (entry.status === "skipped") skipped = true;
    if (entry.status !== "done" || !isObject(entry.report)) continue;
    done += 1;
    if (entry.report.document?.certification?.level === 1) locked = true;
    for (const { signature, level } of listSignatures(entry.report)) items.push({ sourceId: entry.sourceId, name: entry.name || "", signature, level });
  }
  // the banner counts people: a document timestamp matters only when it is broken
  let signers = 0;
  let timestamps = 0;
  let worst = null;
  for (const item of items) {
    const stamp = item.signature?.kind === "document-timestamp";
    if (stamp) timestamps += 1;
    else signers += 1;
    if (stamp && item.level !== "invalid") continue;
    counts[item.level] += 1;
    if (worst === null || LEVEL_RANK[item.level] > LEVEL_RANK[worst]) worst = item.level;
  }
  let state = "none";
  if (items.length) state = "ready";
  else if (checking) state = "checking";
  else if (unavailable) state = "unavailable";
  else if (failed) state = "failed";
  else if (skipped) state = "skipped";
  else if (done) state = "none";
  return { state, items, counts, total: items.length, signers, timestamps, worst, locked, checking };
}

/**
 * The sentence of the banner under the tool bar: the worst state wins.
 * @param {object} summary  summarize(...)
 * @returns {{ tone: "success" | "warning" | "error" | "info", level: string | null, text: string, params: object } | null}
 *          text is a tk() text for t(text, params); null = no banner
 */
export function bannerOf(summary) {
  if (!summary) return null;
  if (summary.state === "checking") return { tone: "info", level: null, text: tk("Checking the signatures of this document…"), params: {} };
  if (summary.state === "unavailable") return { tone: "warning", level: null, text: tk("This document is signed, but signatures cannot be checked here because the page is not opened over a secure connection (https)."), params: {} };
  if (summary.state === "failed") return { tone: "warning", level: null, text: tk("This document is signed, but its signatures could not be checked."), params: {} };
  if (summary.state === "skipped") return { tone: "info", level: null, text: tk("This document is signed. The file is large, so its signatures are checked only when you ask for it in the Signatures panel."), params: {} };
  if (summary.state !== "ready" || !summary.worst) return null;
  const { counts, signers } = summary;
  if (summary.worst === "invalid") {
    return counts.invalid === 1
      ? { tone: "error", level: "invalid", text: tk("1 signature is invalid."), params: {} }
      : { tone: "error", level: "invalid", text: tk("{count} signatures are invalid."), params: { count: counts.invalid } };
  }
  if (summary.worst === "unknown") {
    return counts.unknown === 1
      ? { tone: "warning", level: "unknown", text: tk("1 signature could not be verified."), params: {} }
      : { tone: "warning", level: "unknown", text: tk("{count} signatures could not be verified."), params: { count: counts.unknown } };
  }
  if (summary.worst === "unverified") {
    return counts.unverified === 1
      ? { tone: "warning", level: "unverified", text: tk("Signed, but 1 signer could not be verified."), params: {} }
      : { tone: "warning", level: "unverified", text: tk("Signed, but {count} signers could not be verified."), params: { count: counts.unverified } };
  }
  return signers === 1
    ? { tone: "success", level: "valid", text: tk("Signed by 1 person. The signature is valid."), params: {} }
    : { tone: "success", level: "valid", text: tk("Signed by {count} people. All signatures are valid."), params: { count: signers } };
}

/**
 * The time of a signature and who states it: { value: ISO string | null, source: "timestamp" | "signer" | null }.
 * NO time is ever proven here. The engine's `signingTime.proven` only says that a time-stamp token covers the
 * signature mathematically; the authority that issued the token is never validated (whoever forges a token
 * also chooses its certificate), so the interface presents every time as a statement: of the signer, or of a
 * timestamp whose service was not verified.
 */
export function signingTimeOf(signature) {
  const time = isObject(signature?.signingTime) ? signature.signingTime : {};
  const value = typeof time.value === "string" && time.value ? time.value : null;
  const stamped = time.proven === true || time.source === "signature-timestamp" || time.source === "document-timestamp";
  return { value, source: value === null ? null : stamped ? "timestamp" : "signer" };
}
