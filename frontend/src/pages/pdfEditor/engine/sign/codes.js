// Every code the signing engine reports, with the names of its parameters. messages.js turns a code into a
// translated sentence; the engine itself holds no sentence for the user.
//
// Where a code appears:
//   thrown      new PdfEditorError(CODE, params) from loadPkcs12 / createSelfSigned / certificateFacts / signPdf
//   blocker     inspectPdf(...).blockers            (the same codes signPdf would throw for that file)
//   warning     { code, params } in inspectPdf(...).findings, signPdf(...).report.warnings,
//               certificateFacts(...).warnings and loadPkcs12(...).info.warnings
//   problem     { code, severity: "error" | "warning" | "info", params } in inspectSignatures(...).signatures[].problems
//   change      { code, params, allowed } in inspectSignatures(...).signatures[].changesAfterSigning.items
// Parameter values are data (numbers, names of algorithms, ISO dates), never key material or passwords.

export const CODES = Object.freeze({
  // ---- environment -------------------------------------------------------------------------------------
  SIGN_NO_WEBCRYPTO: [], // thrown, blocker: crypto.subtle is missing (the page is not served over https / localhost)

  // ---- certificate files (thrown) ----------------------------------------------------------------------
  CERT_NOT_PKCS12: ["hint"], // hint: "empty" | "pem" | "jks" | "pdf" | "zip" | "certificate" | "private-key" | null
  CERT_CORRUPT: [], // a PKCS#12 structure that is cut off or damaged
  CERT_WRONG_PASSWORD: [],
  CERT_DECRYPT_FAILED: ["part"], // the password opens the file but not its "private-key" | "certificates"
  CERT_UNSUPPORTED_ALGORITHM: ["algorithm"], // RC4, scrypt, AES-GCM, PBMAC1 / PBKDF2 with a PRF WebCrypto lacks, ...
  CERT_UNSUPPORTED_KEY_TYPE: ["keyType", "curve"], // RSA-PSS-only, DSA, EdDSA, curves outside P-256 / P-384 / P-521
  CERT_NO_PRIVATE_KEY: [],
  CERT_NO_CERTIFICATE: [],
  CERT_KEY_CERTIFICATE_MISMATCH: [],
  CERT_UNREADABLE: [], // not an X.509 certificate
  CERT_ASN1_MALFORMED: ["reason", "offset"], // the ASN.1 reader itself (callers wrap it into the codes above)
  CERT_INVALID_OPTIONS: ["field"], // createSelfSigned / loadPkcs12 called with an unusable value

  // ---- certificate warnings ----------------------------------------------------------------------------
  CERT_EXPIRED: ["notAfter"],
  CERT_NOT_YET_VALID: ["notBefore"],
  CERT_KEY_USAGE_NO_SIGNING: [], // neither digitalSignature nor nonRepudiation
  CERT_KEY_USAGE_NO_NON_REPUDIATION: [], // strict validators (pyHanko) require the bit
  CERT_EKU_NOT_FOR_SIGNING: [],
  CERT_IS_CA: [],
  CERT_WEAK_KEY: ["bits"],
  CERT_WEAK_SIGNATURE_ALGORITHM: ["algorithm"],
  CERT_PKCS12_WEAK_ENCRYPTION: [], // 40-bit RC2
  CERT_PKCS12_KEY_UNENCRYPTED: [],
  CERT_PKCS12_NO_MAC: [],
  CERT_PKCS12_LEGACY_PASSWORD: [], // matched in the byte-wise form of OpenSSL < 1.1.0
  CERT_PKCS12_ENTRY_IGNORED: ["what"], // "certificate-type" | "unreadable-certificate"

  // ---- signing: refusals (thrown by signPdf; the document-related ones are blockers of inspectPdf) -----
  SIGN_NOT_A_PDF: [],
  SIGN_LEADING_BYTES: ["count"], // bytes before %PDF-
  SIGN_DAMAGED_XREF: ["reason"], // "no-startxref" | "bad-startxref" | "bad-xref" | "bad-catalog"
  SIGN_ENCRYPTED: [],
  SIGN_NO_PAGES: [],
  SIGN_CERTIFIED_NO_CHANGES: [], // DocMDP level 1
  SIGN_CERTIFY_NOT_FIRST: [],
  SIGN_BAD_OPTIONS: ["option"], // signPdf, inspectPdf and inspectSignatures: a missing, unknown or unusable option
  SIGN_BAD_SUBFILTER: ["subFilter"],
  SIGN_BAD_PAGE: ["pageIndex", "pageCount"],
  SIGN_BAD_RECT: [],
  SIGN_BAD_IMAGE: ["reason"], // "missing" | "format" | "decode"
  SIGN_BAD_FIELD_NAME: [],
  SIGN_FIELD_NAME_TAKEN: ["fieldName"],
  SIGN_UNSUPPORTED_FIELD: ["fieldName"],
  SIGN_BAD_SIGNER: ["reason"], // "certificate" | "private-key" | "extractable-key" | "key-algorithm" | "hash-binding" | "signature"
  SIGN_KEY_MISMATCH: [],
  SIGN_WEAK_KEY: ["bits"], // RSA below 2048 bits
  SIGN_UNSUPPORTED_KEY: ["keyType", "curve"],
  SIGN_PLACEHOLDER_TOO_SMALL: ["needed", "available"],
  SIGN_TOO_LARGE: [], // offsets beyond a cross-reference table or the /ByteRange slot; the platform ran out of memory
  SIGN_BAD_TIMESTAMP: ["reason"], // only with an injected timestamp.request
  SIGN_TIMESTAMP_REJECTED: ["status"],
  SIGN_INTERNAL: ["check"], // an invariant of the writer failed: nothing is returned
  SIGN_PDF_SYNTAX: ["reason", "offset"], // the raw-byte tokenizer (internal to the inspection, never surfaces)

  // ---- signing: warnings -------------------------------------------------------------------------------
  SIGN_HYBRID_XREF: [],
  SIGN_XREF_CHAIN_DAMAGED: ["problems"], // an OLDER section: "prev-loop" | "too-many-sections" | "unreadable-section"
  SIGN_NEED_APPEARANCES: [],
  SIGN_CERTIFIED: ["level"], // inspectPdf: certified with level 2 or 3
  SIGN_CERTIFIED_VISIBLE: [], // signPdf: a NEW visible field on a certified document
  SIGN_XFA: [],
  SIGN_FIELD_NOT_VISIBLE: ["fieldName"],
  SIGN_FIELD_NOT_ON_A_PAGE: ["fieldName"],
  SIGN_FIELD_LOCK: ["fieldName"],

  // ---- signature inspection: problems ------------------------------------------------------------------
  SIGN_BYTE_RANGE_SHAPE: ["count"],
  SIGN_NO_CONTENTS: [],
  SIGN_BYTE_RANGE_OUT_OF_FILE: [],
  SIGN_BYTE_RANGE_NOT_FROM_START: [],
  SIGN_BYTE_RANGE_GAP_MISMATCH: [],
  SIGN_COVERAGE_NOT_A_REVISION: ["signedEnd"],
  SIGN_CHANGED_AFTER_SIGNING: ["bytesAfter", "laterRevisions"],
  SIGN_LATER_REVISIONS: ["bytesAfter", "laterRevisions"],
  SIGN_UNSIGNED_PLACEHOLDER: [],
  SIGN_CONTENTS_NOT_HEX: ["count"],
  SIGN_CONTENTS_NOT_PLAIN_HEX: [],
  SIGN_CONTENTS_UNREADABLE: [],
  SIGN_CONTENTS_TRAILING_DATA: [],
  SIGN_LEGACY_SUBFILTER: ["subFilter"],
  SIGN_UNKNOWN_SUBFILTER: ["subFilter"],
  SIGN_CMS_UNREADABLE: [],
  SIGN_SIGNER_COUNT: ["count"],
  SIGN_NOT_DETACHED: [],
  SIGN_SIGNER_CERTIFICATE_MISSING: [],
  SIGN_UNSUPPORTED_DIGEST: ["algorithm"],
  SIGN_NO_MESSAGE_DIGEST: [],
  SIGN_CONTENT_TYPE_MISMATCH: [],
  SIGN_NO_CONTENT_TYPE: [],
  SIGN_SIGNING_CERTIFICATE_MISMATCH: [],
  SIGN_PADES_NO_SIGNING_CERTIFICATE: [],
  SIGN_WEAK_DIGEST: ["algorithm"],
  SIGN_DOCUMENT_MODIFIED: [],
  SIGN_SIGNATURE_INVALID: [],
  SIGN_CANNOT_VERIFY: ["reason", "name"], // reason: "hash" | "curve" | "algorithm" | "pss-mgf" | "key" | "webcrypto" | "digest"
  SIGN_NO_SIGNING_TIME: [],
  SIGN_TIME_MISMATCH: ["claimed", "timestamp"],
  SIGN_SIGNER_CERTIFICATE_ALTERED: ["selfSigned"],
  SIGN_SIGNER_NAME_UNPROTECTED: [],
  SIGN_CHAIN_BROKEN: [],
  SIGN_ENCRYPTED_STRINGS: [], // info: reason, name and date of the signature need the document password
  SIGN_NOT_REFERENCED: [],
  SIGN_DOCMDP_VIOLATION: [],
  // the platform failed while a signature was examined: a warning on that signature (verdict "unknown"), or
  // thrown by inspectSignatures when nothing could be examined
  SIGN_INSPECTION_FAILED: [],
  CERT_EXPIRED_AT_SIGNING: ["notAfter"],
  CERT_NOT_YET_VALID_AT_SIGNING: ["notBefore"],
  CERT_EXPIRED_SINCE: ["notAfter", "timeProven"],
  SIGN_TIMESTAMP_UNREADABLE: [],
  SIGN_TIMESTAMP_NOT_TSTINFO: [],
  SIGN_TIMESTAMP_MALFORMED: [],
  SIGN_TIMESTAMP_IMPRINT_MISMATCH: [],
  SIGN_TIMESTAMP_UNSUPPORTED_DIGEST: ["algorithm"],
  SIGN_TIMESTAMP_NO_SIGNER: [],
  SIGN_TIMESTAMP_SIGNATURE_INVALID: [],
  SIGN_TSA_CERTIFICATE_USAGE: [],
  SIGN_TSA_CERTIFICATE_NOT_VALID_AT_TIME: [],
  SIGN_TSA_CERTIFICATE_MISSING: [],

  // ---- signature inspection: what a later revision changed ---------------------------------------------
  // allowed (signature maintenance)
  SIGN_CHANGE_SIGNATURE_FIELD_ADDED: ["object"],
  SIGN_CHANGE_SIGNATURE_WIDGET_ADDED: ["page", "object"],
  SIGN_CHANGE_SIGNATURE_FIELD_FILLED: ["object"],
  SIGN_CHANGE_METADATA: ["what"], // "info" | "xmp"
  SIGN_CHANGE_VALIDATION_DATA: ["object"],
  SIGN_CHANGE_CATALOG_ENTRY: ["key"], // an entry signing may touch: DSS, Perms, Extensions, Version, Metadata
  // not allowed (the document itself changed)
  SIGN_CHANGE_CATALOG_REPLACED: [],
  SIGN_CHANGE_CATALOG_OTHER_ENTRY: ["key"],
  SIGN_CHANGE_PAGE_COUNT: ["before", "after"],
  SIGN_CHANGE_PAGE_REPLACED: ["page"],
  SIGN_CHANGE_PAGE_CONTENT: ["page"],
  SIGN_CHANGE_PAGE_ENTRY: ["page", "key"],
  SIGN_CHANGE_ANNOTATION_REMOVED: ["page"],
  SIGN_CHANGE_ANNOTATION_ADDED: ["page"],
  SIGN_CHANGE_FORM_ENTRY: ["key"],
  SIGN_CHANGE_FORM_REPLACED: [],
  SIGN_CHANGE_FIELD_REMOVED: [],
  SIGN_CHANGE_FIELD_ADDED: [],
  SIGN_CHANGE_SIGNATURE_FIELD_ALTERED: ["keys"],
  SIGN_CHANGE_OBJECT: ["object", "objectType"],
  SIGN_CHANGE_OBJECT_REMOVED: ["object"], // a later cross-reference section frees an object of the signed document
  SIGN_CHANGE_DANGLING_REFERENCE: ["object"], // the signed document pointed at a missing object; it was supplied later
  // cross-reference data after the signature that changes what a viewer resolves without changing an object.
  // reason: "chain" (the later sections no longer lead to the signed revision and objects of it are lost or
  // re-pointed) | "redirected" (an object number points at other bytes of the signed part) | "ambiguous" (an
  // object is defined in two ways and viewers may pick either) | "encryption" (the trailer's /Encrypt changed)
  // | "unreadable" (the data cannot be read, or asks for more work than is reasonable); object: "12 0" or null
  SIGN_CHANGE_XREF: ["reason", "object"]
});

/** A finding of the signature inspection: a code with its weight and parameters. */
export function problem(code, severity, params = {}) {
  return { code, severity, params };
}
