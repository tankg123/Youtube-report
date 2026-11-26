// engine/sign: certificates and digital signatures of the PDF editor. Everything runs in the browser
// (WebCrypto); nothing here makes a network request, touches the DOM or holds a sentence for the user.
//
//   signingSupport()                          can this page sign at all (crypto.subtle needs https / localhost)
//   loadPkcs12(bytes, password, options)      .p12 / .pfx -> { privateKey (non-extractable), certificate, chain, info }
//   createSelfSigned(options)                 a new identity made in the page (+ optional .p12 backup)
//   certificateFacts(der, { now, role })      everything the interface shows about a certificate
//   inspectPdf(bytes)                         can this file be signed, with which warnings
//   signPdf(bytes, options)                   -> { bytes, report }: the input + ONE incremental revision
//   inspectSignatures(bytes, options)         the signature panel: one report per signature
//   signedRevisionBytes(bytes, signature)     the document as one signature saw it
//   CODES                                     every code with its parameter names (./codes.js)
//
// Errors are PdfEditorError(code, params) with SIGN_ / CERT_ codes; warnings are { code, params }.
// Private keys exist only as non-extractable CryptoKeys: keep the returned object in a module variable (not
// in React state or any store that is serialised) and NEVER in IndexedDB (browsers write such a key to disk
// in clear text). Only a still-encrypted .p12 may be persisted. Nothing of a key or a password is put into
// an error, a report or a log.
//
// Two rules of every answer this module gives:
//  - "could not be checked" is never "checked". A signature, a link of a certificate chain or a digest that
//    the platform cannot verify (unsupported hash, curve, algorithm) is reported as null / "unknown" /
//    "untrusted", never as valid or trusted. trust.status is "trusted" only when the signature value verified
//    and EVERY link up to a certificate supplied by the caller verified (./x509.js findTrustPath).
//  - a file cannot make the page work for long: the key derivation of a PKCS#12 file is bounded by a work
//    budget and can be cancelled (./pkcs12.js KDF_LIMITS); the path search and the cross-reference audit are
//    bounded too. What is not bounded is the PDF parser of the library: run inspectSignatures and signPdf on
//    untrusted files in a Web Worker that can be terminated.
//
// Modules: bytes, asn1 (the one BER / DER reader-writer), oids, sigverify (WebCrypto), x509 (certificates,
// chains, the path to a trusted certificate), pkcs12 + hashSync (synchronous SHA for the PKCS#12 key
// derivation) + legacyCiphers (node-forge des / rc2 only), selfSigned, cms (builder + parser), pdfRaw +
// incremental + pdfSign (the signer), pdfScan + revisionDiff + xrefAudit + inspectSignatures (the inspector),
// codes.

import { PdfEditorError, isPdfEditorError, throwIfAborted, warning } from "../errors.js";
import { asBytes } from "./bytes.js";
import { SUBFILTER_PADES, SUBFILTER_PKCS7 } from "./cms.js";
import { CODES } from "./codes.js";
import { inspectSignatures as inspectSignaturesImpl, signedRevisionBytes as signedRevisionBytesImpl } from "./inspectSignatures.js";
import { describePdf, signPdfDetailed } from "./pdfSign.js";
import { loadPkcs12 as loadPkcs12Impl } from "./pkcs12.js";
import { createSelfSigned as createSelfSignedImpl, SELF_SIGNED_KEY_TYPES } from "./selfSigned.js";
import { certificateFacts as certificateFactsImpl } from "./x509.js";

export { CODES, SUBFILTER_PADES, SUBFILTER_PKCS7 };

/** Key types createSelfSigned can generate. */
export const KEY_TYPES = Object.freeze(Object.keys(SELF_SIGNED_KEY_TYPES));
/** SubFilters signPdf can write; the first one is the default (PAdES baseline, ISO 32000-2). */
export const SUBFILTERS = Object.freeze([SUBFILTER_PADES, SUBFILTER_PKCS7]);

const hasSubtle = () => {
  const api = globalThis.crypto && globalThis.crypto.subtle;
  return Boolean(api && typeof api.sign === "function" && typeof api.importKey === "function" && typeof api.digest === "function");
};

/**
 * Can this page sign and verify? Read from globalThis at the time of the call.
 * @returns {{ secureContext: boolean | null, subtle: boolean }} secureContext: globalThis.isSecureContext (null
 *          where the runtime has no such notion, e.g. Node); subtle: crypto.subtle is usable. On a plain-http
 *          origin other than localhost a browser gives { secureContext: false, subtle: false }.
 */
export function signingSupport() {
  const secure = globalThis.isSecureContext;
  return { secureContext: typeof secure === "boolean" ? secure : null, subtle: hasSubtle() };
}

/** Anything unexpected becomes a coded error: an engine never lets a raw exception out. */
function coded(error, fallbackCode, fallbackParams) {
  if (isPdfEditorError(error)) return error;
  if (error instanceof RangeError) return new PdfEditorError("SIGN_TOO_LARGE", {}, { cause: error, detail: "the platform could not allocate the memory this file needs" });
  return new PdfEditorError(fallbackCode, fallbackParams, { cause: error, detail: (error && error.name) || "unexpected error" });
}

/**
 * Opens a PKCS#12 container (.p12 / .pfx).
 * @param {Uint8Array} bytes
 * @param {string} password        pass "" for a file without a password
 * @param {{ hashes?: string[], identity?: number, now?: Date, signal?: AbortSignal }} [options]
 *        signal: ALWAYS pass one. The key derivation lets the event loop run every few milliseconds and looks
 *        at the signal then; whatever the file asks for, it ends within the work budget (about 2.5 s on the
 *        development machine), a file beyond it is CERT_CORRUPT.
 * @returns {Promise<{ privateKey: CryptoKey, privateKeysByHash: Record<string, CryptoKey>, keyAlgorithm: object,
 *                     certificate: Uint8Array, chain: Uint8Array[], info: object }>}
 *          privateKey: extractable false, usages ["sign"]; chain: DER, leaf first, then its issuers (listed by
 *          name and key identifier; info.chainLinks says per link whether the signature verified: true, false,
 *          or null = could not be checked here; info.chainComplete is true only when every link verified up to
 *          a self-signed certificate)
 * @throws PdfEditorError CERT_NOT_PKCS12 | CERT_CORRUPT | CERT_WRONG_PASSWORD | CERT_DECRYPT_FAILED |
 *         CERT_UNSUPPORTED_ALGORITHM | CERT_UNSUPPORTED_KEY_TYPE | CERT_NO_PRIVATE_KEY | CERT_NO_CERTIFICATE |
 *         CERT_KEY_CERTIFICATE_MISMATCH | CERT_INVALID_OPTIONS | SIGN_NO_WEBCRYPTO | CANCELLED
 */
export async function loadPkcs12(bytes, password, options = {}) {
  try {
    return await loadPkcs12Impl(bytes, password, options);
  } catch (error) {
    throw coded(error, "CERT_CORRUPT", {});
  }
}

/**
 * Makes a self-signed signing identity in the page.
 * @param {{ commonName: string, organization?: string, organizationalUnit?: string, email?: string, country?: string,
 *           state?: string, locality?: string, years?: number, keyType?: "RSA-2048" | "RSA-3072" | "P-256",
 *           p12Password?: string, p12Profile?: "3des" | "aes256", friendlyName?: string, now?: Date }} options
 * @returns {Promise<object>} the shape of loadPkcs12 plus p12Bytes (Uint8Array, or null without p12Password)
 * @throws PdfEditorError CERT_INVALID_OPTIONS { field } | SIGN_NO_WEBCRYPTO
 */
export async function createSelfSigned(options) {
  try {
    return await createSelfSignedImpl(options);
  } catch (error) {
    throw coded(error, "CERT_INVALID_OPTIONS", { field: null });
  }
}

/**
 * Everything the interface shows about one certificate.
 * @param {Uint8Array} der                       DER (or PEM) bytes
 * @param {{ now?: Date, role?: "signer" | "ca" | "timestamp-authority" }} [options]
 * @throws PdfEditorError CERT_UNREADABLE | SIGN_NO_WEBCRYPTO
 */
export async function certificateFacts(der, options = {}) {
  try {
    return await certificateFactsImpl(der, options);
  } catch (error) {
    throw coded(error, "CERT_UNREADABLE", {});
  }
}

/**
 * Can this file be signed, and with which warnings? Never throws for a property of the file.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ signable: boolean, blockers: string[], warnings: string[], encrypted: boolean, hybrid: boolean,
 *   certified: 0 | 1 | 2 | 3, needAppearances: boolean, signatureCount: number,
 *   emptySignatureFields: { name: string, pageIndex: number | null, rect: number[] | null }[],
 *   pageCount: number, canCertify: boolean, xfa: boolean, linearized: boolean, xref: "table" | "stream" | null,
 *   fieldNames: string[], findings: { code: string, params: object, blocking: boolean }[] }>}
 *   blockers: the codes signPdf would throw for this file (SIGN_ENCRYPTED, SIGN_DAMAGED_XREF, SIGN_NOT_A_PDF,
 *   SIGN_LEADING_BYTES, SIGN_NO_PAGES, SIGN_CERTIFIED_NO_CHANGES, SIGN_NO_WEBCRYPTO); warnings: SIGN_HYBRID_XREF,
 *   SIGN_XREF_CHAIN_DAMAGED, SIGN_NEED_APPEARANCES, SIGN_CERTIFIED, SIGN_XFA; findings: the same with parameters
 */
export async function inspectPdf(bytes) {
  const input = asBytes(bytes);
  if (!input) throw new PdfEditorError("SIGN_BAD_OPTIONS", { option: "bytes" }, { detail: "inspectPdf needs the PDF as a Uint8Array" });
  let facts;
  try {
    facts = await describePdf(input);
  } catch (error) {
    throw coded(error, "SIGN_INTERNAL", { check: "inspect" });
  }
  const findings = [
    ...facts.blockers.map((entry) => ({ ...entry, blocking: true })),
    ...facts.warnings.map((entry) => ({ ...entry, blocking: false }))
  ];
  if (!hasSubtle()) findings.unshift({ ...warning("SIGN_NO_WEBCRYPTO"), blocking: true });
  const blockers = findings.filter((entry) => entry.blocking).map((entry) => entry.code);
  const level = facts.certification ? facts.certification.level : 0;
  return {
    signable: blockers.length === 0,
    blockers,
    warnings: findings.filter((entry) => !entry.blocking).map((entry) => entry.code),
    encrypted: Boolean(facts.encrypted),
    hybrid: Boolean(facts.hybrid),
    certified: level === 1 || level === 2 || level === 3 ? level : 0,
    needAppearances: Boolean(facts.acroForm.needAppearances),
    signatureCount: facts.signatures.length,
    emptySignatureFields: facts.emptySignatureFields.map((field) => ({ name: field.fieldName, pageIndex: field.pageIndex, rect: field.rect })),
    pageCount: facts.pageCount,
    canCertify: blockers.length === 0 && facts.signatures.length === 0,
    xfa: Boolean(facts.acroForm.hasXfa),
    linearized: Boolean(facts.linearized),
    xref: facts.lastXref ? facts.lastXref.type : null,
    fieldNames: facts.acroForm.fieldNames,
    findings
  };
}

const SIGN_OPTION_NAMES = new Set([
  "signer", "subFilter", "signingTime", "name", "reason", "location", "contactInfo", "fieldName", "certify", "appearance", "signal",
  // beyond the everyday set: how /M is written, the page of an invisible widget, a caller-supplied RFC 3161 client
  "timeZoneOffsetMinutes", "pageIndex", "timestamp", "appName"
]);

/**
 * Signs a PDF with a certificate: the result is the input, byte for byte, followed by ONE incremental
 * revision in the cross-reference style of the input (earlier signatures stay valid).
 *
 * @param {Uint8Array} bytes
 * @param {object} options
 *   signer: { certificate: Uint8Array (DER), chain?: Uint8Array[] (DER), privateKey: CryptoKey } as returned by
 *           loadPkcs12 / createSelfSigned (the key must be non-extractable)
 *   subFilter: "ETSI.CAdES.detached" (default) | "adbe.pkcs7.detached"
 *   signingTime: Date (default now; written to /M, and as signing-time attribute for adbe.pkcs7.detached)
 *   name, reason, location, contactInfo: strings (any Unicode) for the signature dictionary
 *   fieldName: default the first free "SignatureN"; the name of an EMPTY signature field signs that field
 *   certify: 0 (default) | 1 | 2 | 3 = certification signature with that DocMDP level (unsigned documents only)
 *   appearance: null (invisible) | { pageIndex, rect: [x0, y0, x1, y1] in the page's user space, png: Uint8Array }
 *           ONE picture, drawn upright for the reader also on pages with /Rotate
 *   signal: AbortSignal
 *   timeZoneOffsetMinutes: offset /M is written in (default: the local zone); pageIndex: page of the widget of
 *           an invisible signature (default 0); timestamp: { request(tsq) -> tsr } supplied by the caller
 * @returns {Promise<{ bytes: Uint8Array, report: { fieldName: string, byteRange: number[], contentsLength: number,
 *           subFilter: string, warnings: { code: string, params: object }[], pageIndex: number, rect: number[],
 *           visible: boolean, signingTime: string, certified: number, usedExistingField: boolean, cmsLength: number,
 *           xref: "table" | "stream", originalLength: number, rewrittenObjects: string[], newObjectNumbers: number[] } }>}
 *           contentsLength: bytes reserved in /Contents (the hex string has twice as many digits)
 * @throws PdfEditorError with a SIGN_ code (see CODES); nothing is returned on error and the input is untouched
 */
export async function signPdf(bytes, options = {}) {
  const input = asBytes(bytes);
  if (!input) throw new PdfEditorError("SIGN_BAD_OPTIONS", { option: "bytes" }, { detail: "signPdf needs the PDF as a Uint8Array" });
  if (!options || typeof options !== "object") throw new PdfEditorError("SIGN_BAD_OPTIONS", { option: "options" });
  for (const key of Object.keys(options)) {
    if (!SIGN_OPTION_NAMES.has(key)) throw new PdfEditorError("SIGN_BAD_OPTIONS", { option: key }, { detail: `unknown option ${key}` });
  }
  throwIfAborted(options.signal);
  if (!hasSubtle()) throw new PdfEditorError("SIGN_NO_WEBCRYPTO", {}, { detail: "crypto.subtle is not available: the page must be served over HTTPS or from localhost" });
  const signer = options.signer;
  if (!signer || typeof signer !== "object") throw new PdfEditorError("SIGN_BAD_SIGNER", { reason: "certificate" }, { detail: "options.signer is required" });
  // private keys only as non-extractable CryptoKeys: an extractable handle or a callback is not accepted here
  const key = signer.privateKey;
  if (!key || typeof key !== "object" || key.type !== "private") throw new PdfEditorError("SIGN_BAD_SIGNER", { reason: "private-key" }, { detail: "signer.privateKey must be a private CryptoKey" });
  if (key.extractable !== false) throw new PdfEditorError("SIGN_BAD_SIGNER", { reason: "extractable-key" }, { detail: "signer.privateKey must be non-extractable" });
  let result;
  try {
    result = await signPdfDetailed(input, { ...options, signer: { certificate: signer.certificate, chain: signer.chain || [], privateKey: key } });
  } catch (error) {
    throw coded(error, "SIGN_INTERNAL", { check: "unexpected" });
  }
  return {
    bytes: result.bytes,
    report: {
      fieldName: result.fieldName,
      byteRange: result.byteRange,
      contentsLength: result.contentsBytes,
      subFilter: result.subFilter,
      warnings: result.warnings,
      pageIndex: result.pageIndex,
      rect: result.rect,
      visible: result.visible,
      signingTime: result.signingTime.toISOString(),
      certified: result.certified,
      usedExistingField: result.usedExistingField,
      cmsLength: result.cmsBytes,
      xref: result.xrefType,
      originalLength: result.originalLength,
      rewrittenObjects: result.rewrittenObjects,
      newObjectNumbers: result.newObjectNumbers
    }
  };
}

const INSPECT_OPTION_NAMES = new Set(["trustedCertificates", "now", "password", "analyzeChanges", "signal"]);

/**
 * The signature panel: every signature and document timestamp of a PDF with what can be checked offline.
 * @param {Uint8Array} bytes
 * @param {{ trustedCertificates?: Uint8Array[], now?: Date, password?: string, analyzeChanges?: boolean, signal?: AbortSignal }} [options]
 *        trustedCertificates: DER certificates or PEM bundles; without them trust is "not-checked"; now: the instant of
 *        "valid today"; password: of an encrypted document (its strings are ciphertext otherwise); analyzeChanges:
 *        false skips the comparison of revisions; signal: looked at between the stages
 *        trust.status is "trusted" only when the signature value verified with the signer certificate AND every
 *        link from that certificate up to one of trustedCertificates verified cryptographically AND the path obeys
 *        its authorities (CA flag, certificate-signing usage, path length, no critical extension that is not
 *        understood, validity at the signing time). A link that failed or could not be checked gives "untrusted",
 *        reason "no-path", failures [{ reason: "link-not-verified", commonName }]; a signature value that did not
 *        verify gives "not-checked", reason "not-evaluated". A supplied certificate that is no authority (an
 *        end-entity or self-signed personal certificate) is trusted as a signer only, never as an issuer.
 * @returns {Promise<{ signatures: object[], unsignedFields: object[], otherByteRanges: object[], document: object }>}
 *          per signature: index, kind, fieldName, pageIndex, rect, visible, subFilter, signerName, reason, location,
 *          signingTime, byteRange, digestMatches, signatureValid, integrity, coverage, changesAfterSigning,
 *          signerCertificate (certificateFacts), chain, timestamp, docMdp, isCertification, trust, problems, verdict
 * @throws PdfEditorError SIGN_NO_WEBCRYPTO; SIGN_BAD_OPTIONS { option } for a mistake of the caller (an unknown
 *         option, trustedCertificates that is no array, now that is no valid Date, a password that is no string);
 *         SIGN_INSPECTION_FAILED / SIGN_TOO_LARGE when the platform fails; CANCELLED. Never for a property of the document:
 *         damaged or non-PDF input gives an empty or partial report.
 */
export async function inspectSignatures(bytes, options = {}) {
  const given = options === null || options === undefined ? {} : options;
  const bad = (option) => new PdfEditorError("SIGN_BAD_OPTIONS", { option }, { detail: `inspectSignatures: unusable option ${option}` });
  if (typeof given !== "object") throw bad("options");
  // a misspelt "trustedCertificates" must not silently turn the trust check off
  for (const key of Object.keys(given)) if (!INSPECT_OPTION_NAMES.has(key)) throw bad(key);
  if (given.trustedCertificates != null && !Array.isArray(given.trustedCertificates)) throw bad("trustedCertificates");
  if (given.now != null && (!(given.now instanceof Date) || Number.isNaN(given.now.getTime()))) throw bad("now");
  if (given.password != null && typeof given.password !== "string") throw bad("password");
  try {
    return await inspectSignaturesImpl(bytes, given);
  } catch (error) {
    throw coded(error, "SIGN_INSPECTION_FAILED", {});
  }
}

/**
 * The document as it was when `signature` (an entry of inspectSignatures(...).signatures) was made: the first
 * coverage.signedEnd bytes of the file, as a view (no copy). null when the signature has no usable coverage.
 */
export function signedRevisionBytes(bytes, signature) {
  return signedRevisionBytesImpl(bytes, signature);
}
