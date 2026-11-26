// Signature panel backend: finds every signature / document timestamp of a PDF and checks what can be
// checked offline in the browser. Browser + Node.
//
//   inspectSignatures(pdfBytes, options) -> { signatures: [...], unsignedFields: [...], otherByteRanges, document }
//
// Enumeration is a HYBRID on purpose:
//   1. a raw byte scan for "/ByteRange" is the authority for everything that has to do with bytes (what is
//      signed, where the hex string is, where the signed range ends). It needs no xref table, sees signature
//      dictionaries that the current revision no longer references, and cannot be fooled by a parser that
//      resolves objects differently than the signer saw them;
//   2. the AcroForm walk with the PDF library adds what only the object graph knows: field names, the page
//      and rectangle of the widget, empty signature fields, /Perms.
//
// Three facts are kept apart for every signature and never merged into one "verified":
//   digestMatches    the digest of the signed byte ranges equals the message-digest attribute
//   signatureValid   the signature over the signed attributes verifies with the signer certificate
//   coverage         what the signed range covers: "whole-file" | "revision" (later revisions exist) | "partial"
// plus trust: "trusted" only against certificates the CALLER supplies, only when the signature value itself
// verified with the signer certificate, and only when EVERY link from that certificate up to a supplied one
// verified cryptographically and the path obeys the rules of its authorities (findTrustPath in ./x509.js).
// No network, no trust store, no revocation check. Every finding is a code of ./codes.js; this module holds
// no sentence for the user.
//
// "Could not be checked" (an algorithm, hash or curve the platform lacks) is its own answer everywhere and is
// never read as "checked":
//   - the signature value            -> signatureValid null, verdict "unknown", trust "not-checked"
//   - a link of the certificate chain -> chainLinks[].signatureOk null, chainComplete false, trust "untrusted"
//                                        with failures [{ reason: "link-not-verified", commonName }]
//   - the signer certificate's own signature -> signerCertificateCheck "unprotected", never "self-signed"
//   - a time-stamp token             -> timestamp.ok false, and the time stays a claim of the signer.
// What stays a CLAIM by design, and is reported as such: the signing time without a time-stamp
// (signingTime.proven false; the validity of the certificates is judged at that time, as PDF readers do by
// default), and the identity of a time-stamp authority (timestamp.identityVerified is always false: its
// chain is not evaluated, so a time-stamp proves a time only as far as one believes whoever made the token).

import { isPdfEditorError, throwIfAborted } from "../errors.js";
import { pdfLib } from "../lib.js";
import { berLength, decode, TAG } from "./asn1.js";
import { asBytes, concatBytes, equalBytes } from "./bytes.js";
import { parseSignedData, verifySignatureOverContent, verifySignerInfo, verifyTimestampToken } from "./cms.js";
import { problem } from "./codes.js";
import {
  asciiBytes, decodeTextString, enclosingObject, findObjectByScan, lastIndexOfBytes, looksEncrypted, parseObject, parsePdfDate,
  scanByteRanges, scanRevisions
} from "./pdfScan.js";
import { classifyChangesAfter, READ_ONLY_LOAD_OPTIONS } from "./revisionDiff.js";
import { digest, subtle, verifySignature } from "./sigverify.js";
import { certificateFacts, certificatesFromPemOrDer, commonNameOf, findTrustPath, orderChain, parseCertificate, validityAt } from "./x509.js";

/** More /ByteRange entries than this are not analysed (a hostile file must not keep the tab busy). */
const MAX_BYTE_RANGES = 512;
const P_TRAILER = asciiBytes("trailer");
const FORWARDED_CERTIFICATE_WARNINGS = ["CERT_KEY_USAGE_NO_SIGNING", "CERT_EKU_NOT_FOR_SIGNING", "CERT_WEAK_KEY", "CERT_WEAK_SIGNATURE_ALGORITHM"];

// ------------------------------------------------------------------------------------------------
// raw scan

function findOwnerDict(node, keyOffset) {
  // the innermost dictionary that has a /ByteRange value starting after keyOffset
  if (!node) return null;
  if (node.type === "dict") {
    for (const child of node.entries.values()) {
      if (keyOffset >= child.start && keyOffset < child.end) {
        const inner = findOwnerDict(child, keyOffset);
        if (inner) return inner;
      }
    }
    const byteRange = node.entries.get("ByteRange");
    if (byteRange && byteRange.start > keyOffset && byteRange.start - keyOffset < 64) return node;
    return null;
  }
  if (node.type === "array") {
    for (const item of node.items) {
      if (keyOffset >= item.start && keyOffset < item.end) return findOwnerDict(item, keyOffset);
    }
  }
  return null;
}

const nameOf = (node) => (node && node.type === "name" ? node.value : null);
const numberOf = (node) => (node && node.type === "number" ? node.value : null);

function resolveNode(bytes, node) {
  if (node && node.type === "ref") return findObjectByScan(bytes, node.num, node.gen);
  return node;
}

function textOf(bytes, node) {
  const resolved = resolveNode(bytes, node);
  if (!resolved || resolved.type !== "string") return null;
  return decodeTextString(resolved.bytes);
}

/** Every /ByteRange of the file with the dictionary that owns it. */
function collectRawEntries(bytes) {
  const entries = [];
  const hits = scanByteRanges(bytes);
  for (const hit of hits.slice(0, MAX_BYTE_RANGES)) {
    const entry = { hit, object: null, dict: null, kind: "unknown" };
    let root = null;
    try {
      const object = enclosingObject(bytes, hit.keyOffset);
      if (object) {
        root = parseObject(bytes, object.bodyOffset);
        entry.object = { num: object.num, gen: object.gen, offset: object.headerOffset };
      } else {
        // not inside an indirect object: a trailer dictionary (ISO 32004 MAC of an encrypted PDF 2.0 file)
        const trailer = lastIndexOfBytes(bytes, P_TRAILER, hit.keyOffset);
        if (trailer >= 0 && hit.keyOffset - trailer < 65536) root = parseObject(bytes, trailer + 7);
      }
    } catch {
      /* unparseable surroundings: stays "unknown" */
    }
    const owner = findOwnerDict(root, hit.keyOffset);
    if (owner) {
      entry.dict = owner;
      if (owner.entries.has("Contents")) entry.kind = "signature";
      else if (owner.entries.has("MAC")) entry.kind = "pdf-mac";
    }
    entries.push(entry);
  }
  return { entries, skipped: Math.max(0, hits.length - MAX_BYTE_RANGES) };
}

// ------------------------------------------------------------------------------------------------
// AcroForm walk

/** Loads the document with the PDF library. -> { doc, decrypted } (doc null when it cannot be parsed) */
async function loadWithParser(bytes, password) {
  if (typeof password === "string") {
    // the library decrypts when it is given the password, so that names and reasons can be read
    try {
      const doc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false, parseSpeed: Infinity, password });
      return { doc, decrypted: Boolean(doc.context.isDecrypted) };
    } catch {
      /* a wrong password: fall back to the structure only */
    }
  }
  try {
    return { doc: await pdfLib.PDFDocument.load(bytes, READ_ONLY_LOAD_OPTIONS), decrypted: false };
  } catch {
    return { doc: null, decrypted: false };
  }
}

function walkAcroForm(doc) {
  const out = { ok: false, fields: [], docMdpRef: null, hasDss: false, sigFlags: null };
  if (!doc) return out;
  try {
    const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } = pdfLib;
    const context = doc.context;
    const name = (text) => PDFName.of(text);
    const lookup = (object) => (object instanceof PDFRef ? context.lookup(object) : object);
    const text = (object) => {
      const value = lookup(object);
      if (!value) return null;
      try {
        if (typeof value.decodeText === "function") return value.decodeText();
      } catch {
        /* fall through */
      }
      return typeof value.asString === "function" ? value.asString() : null;
    };
    const catalog = doc.catalog;
    const pages = doc.getPages();
    const pageRefs = pages.map((page) => page.ref);
    const pageIndexOf = (widgetRef, widgetDict) => {
      const pageRef = widgetDict.get(name("P"));
      if (pageRef instanceof PDFRef) {
        const index = pageRefs.findIndex((ref) => ref.objectNumber === pageRef.objectNumber && ref.generationNumber === pageRef.generationNumber);
        if (index >= 0) return index;
      }
      if (widgetRef) {
        for (let i = 0; i < pages.length; i++) {
          const annots = lookup(pages[i].node.get(name("Annots")));
          if (annots instanceof PDFArray) {
            for (let k = 0; k < annots.size(); k++) {
              const annot = annots.get(k);
              if (annot instanceof PDFRef && annot.objectNumber === widgetRef.objectNumber) return i;
            }
          }
        }
      }
      return null;
    };
    const rectOf = (dict) => {
      const rect = lookup(dict.get(name("Rect")));
      if (!(rect instanceof PDFArray) || rect.size() !== 4) return null;
      const numbers = [];
      for (let i = 0; i < 4; i++) {
        const value = lookup(rect.get(i));
        numbers.push(value instanceof PDFNumber ? value.asNumber() : NaN);
      }
      return numbers.some(Number.isNaN) ? null : numbers;
    };

    const perms = lookup(catalog.get(name("Perms")));
    if (perms instanceof PDFDict) {
      const docMdp = perms.get(name("DocMDP"));
      if (docMdp instanceof PDFRef) out.docMdpRef = { num: docMdp.objectNumber, gen: docMdp.generationNumber };
    }
    out.hasDss = Boolean(catalog.get(name("DSS")));
    const acroForm = lookup(catalog.get(name("AcroForm")));
    if (acroForm instanceof PDFDict) {
      const flags = lookup(acroForm.get(name("SigFlags")));
      out.sigFlags = flags instanceof PDFNumber ? flags.asNumber() : null;
      const seen = new Set();
      const walk = (ref, parentName, inheritedType, depth) => {
        if (depth > 32) return;
        const dict = lookup(ref);
        if (!(dict instanceof PDFDict)) return;
        if (ref instanceof PDFRef) {
          const key = `${ref.objectNumber} ${ref.generationNumber}`;
          if (seen.has(key)) return;
          seen.add(key);
        }
        const partial = text(dict.get(name("T")));
        const fullName = partial == null ? parentName : (parentName ? `${parentName}.${partial}` : partial);
        const typeObject = lookup(dict.get(name("FT")));
        const fieldType = typeObject && typeof typeObject.decodeText === "function" ? typeObject.decodeText() : inheritedType;
        const kids = lookup(dict.get(name("Kids")));
        const widgets = [];
        let hasChildFields = false;
        if (kids instanceof PDFArray) {
          for (let i = 0; i < kids.size(); i++) {
            const kidRef = kids.get(i);
            const kid = lookup(kidRef);
            if (!(kid instanceof PDFDict)) continue;
            if (kid.get(name("T"))) {
              hasChildFields = true;
              walk(kidRef, fullName, fieldType, depth + 1);
            } else {
              widgets.push({ ref: kidRef instanceof PDFRef ? kidRef : null, dict: kid });
            }
          }
        }
        if (fieldType !== "Sig" || hasChildFields) return;
        if (!widgets.length && dict.get(name("Rect"))) widgets.push({ ref: ref instanceof PDFRef ? ref : null, dict });
        const value = dict.get(name("V"));
        const widget = widgets[0] || null;
        const rect = widget ? rectOf(widget.dict) : null;
        out.fields.push({
          name: fullName,
          valueRef: value instanceof PDFRef ? { num: value.objectNumber, gen: value.generationNumber } : null,
          hasValue: value != null,
          valueIsDirect: value != null && !(value instanceof PDFRef),
          pageIndex: widget ? pageIndexOf(widget.ref, widget.dict) : null,
          rect,
          visible: Boolean(rect && Math.abs(rect[2] - rect[0]) > 0 && Math.abs(rect[3] - rect[1]) > 0),
          hasLock: Boolean(dict.get(name("Lock")))
        });
      };
      const fields = lookup(acroForm.get(name("Fields")));
      if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) walk(fields.get(i), null, null, 0);
    }
    out.ok = true;
  } catch {
    out.ok = false; // a damaged object graph: the byte-level results stand on their own
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// one signature

function describeCoverage(byteRange, fileLength, revisions, contentsNode) {
  const [a, b, c, d] = byteRange;
  const signedEnd = c + d;
  const coverage = {
    status: "partial",
    startsAtZero: a === 0,
    gapMatchesContents: Boolean(contentsNode) && a + b === contentsNode.start && c === contentsNode.end,
    signedBytes: b + d,
    signedEnd,
    fileLength,
    bytesAfter: fileLength - signedEnd,
    revision: null,
    revisionCount: revisions.length,
    laterRevisions: revisions.filter((revision) => revision.eofOffset >= signedEnd).length,
    endsAtRevisionBoundary: false
  };
  const at = revisions.find((revision) => signedEnd >= revision.eofOffset + 5 && signedEnd <= revision.end);
  if (at) {
    coverage.revision = at.index;
    coverage.endsAtRevisionBoundary = true;
  }
  if (signedEnd === fileLength && coverage.startsAtZero && coverage.gapMatchesContents) coverage.status = "whole-file";
  else if (coverage.endsAtRevisionBoundary && coverage.startsAtZero && coverage.gapMatchesContents && signedEnd < fileLength) coverage.status = "revision";
  return coverage;
}

function certificateSummary(cert) {
  return {
    subject: cert.subject.text,
    commonName: (cert.subject.fields.CN || [null])[0],
    issuer: cert.issuer.text,
    issuerCommonName: (cert.issuer.fields.CN || [null])[0],
    serialNumber: cert.serialNumber.toUpperCase(),
    notBefore: cert.notBefore.toISOString(),
    notAfter: cert.notAfter.toISOString(),
    selfIssued: cert.selfIssued,
    isCa: Boolean(cert.ext.basicConstraints && cert.ext.basicConstraints.ca)
  };
}

/** Trust that was not evaluated: reason "not-evaluated" (the signature could not be read that far) or "no-signer-certificate". */
const trustNotChecked = (reason, when) => ({
  status: "not-checked", reason, selfSigned: false, issuedBy: null, chainComplete: false, revocationChecked: false,
  anchor: null, anchorCommonName: null, checkedAt: when.toISOString(), failures: []
});

/**
 * Trust against the certificates the caller supplies, at the reference time `when`.
 *
 * @param {object} signer            the parsed signer certificate
 * @param {object[]} certificates    every parsed certificate that travels with the signature
 * @param {object} ordered           orderChain(signer, certificates): only for the descriptive fields
 * @param {object[]} trustedParsed   the caller's certificates
 * @param {Date} when                the signing time when there is one (proven or claimed), else now
 * @param {boolean} signatureVerified  the signature value verified with the signer certificate
 * -> { status: "not-checked" | "trusted" | "untrusted",
 *      reason: "no-trusted-certificates"  the caller supplied none (status "not-checked")
 *            | "not-evaluated"   the signature value did not verify or could not be checked, so NOBODY is
 *                                shown to have signed and the chain says nothing (status "not-checked")
 *            | "anchored"        status "trusted": every link up to `anchor` verified, the path is valid
 *            | "no-path"         no path of verified links leads to a supplied certificate. When the names
 *                                lead to one but a link failed or could not be checked, failures holds
 *                                { reason: "link-not-verified", commonName: the certificate whose signature
 *                                was not verified }; anchor stays null (nothing connects the signer to it)
 *            | "path-not-valid"  every link verified up to `anchor`, but a rule of the path is broken
 *            (and see trustNotChecked),
 *      selfSigned (the signer certificate is its own issuer AND its signature verified), issuedBy,
 *      chainComplete, revocationChecked: false, anchor, anchorCommonName, checkedAt,
 *      failures: [{ reason, commonName }]  reasons as listed at findTrustPath (./x509.js) }
 */
async function evaluateTrust(signer, certificates, ordered, trustedParsed, when, signatureVerified) {
  const ownLink = ordered.links[0] || null;
  const base = {
    status: "not-checked",
    reason: "no-trusted-certificates",
    selfSigned: Boolean(ownLink && ownLink.selfSigned && ownLink.signatureOk === true),
    issuedBy: signer.selfIssued ? null : commonNameOf(signer.issuer),
    chainComplete: ordered.complete,
    revocationChecked: false,
    anchor: null,
    anchorCommonName: null,
    checkedAt: when.toISOString(),
    failures: []
  };
  if (!trustedParsed || !trustedParsed.length) return base;
  // a certificate chain names a signer only through a signature that verifies with it
  if (!signatureVerified) return { ...base, reason: "not-evaluated" };
  const found = await findTrustPath(signer, certificates, trustedParsed, when);
  if (found.trusted) return { ...base, status: "trusted", reason: "anchored", anchor: found.anchor.subject.text, anchorCommonName: commonNameOf(found.anchor.subject) };
  if (!found.anchor || found.failures.some((failure) => failure.reason === "link-not-verified")) {
    return { ...base, status: "untrusted", reason: "no-path", failures: found.failures };
  }
  return {
    ...base, status: "untrusted", reason: "path-not-valid", anchor: found.anchor.subject.text, anchorCommonName: commonNameOf(found.anchor.subject), failures: found.failures
  };
}

function readDocMdp(bytes, dict) {
  const out = { docMdp: null, fieldMdp: null };
  const reference = resolveNode(bytes, dict.entries.get("Reference"));
  if (!reference || reference.type !== "array") return out;
  for (const item of reference.items) {
    const sigRef = resolveNode(bytes, item);
    if (!sigRef || sigRef.type !== "dict") continue;
    const method = nameOf(sigRef.entries.get("TransformMethod"));
    const params = resolveNode(bytes, sigRef.entries.get("TransformParams"));
    if (method === "DocMDP") {
      const level = params && params.type === "dict" ? numberOf(params.entries.get("P")) : null;
      // default 2 (ISO 32000-1 table 254): 1 = no changes, 2 = form filling and signing, 3 = also annotations
      out.docMdp = { level: level === 1 || level === 2 || level === 3 ? level : 2, inCatalog: null };
    } else if (method === "FieldMDP") {
      out.fieldMdp = { action: params && params.type === "dict" ? nameOf(params.entries.get("Action")) : null };
    }
  }
  return out;
}

const triState = (a, b) => (a === true && b === true ? true : (a === false || b === false ? false : null));

async function inspectOne(bytes, entry, context) {
  const { revisions, now, encrypted } = context;
  const dict = entry.dict;
  const get = (key) => dict.entries.get(key);
  const problems = [];
  const subFilter = nameOf(get("SubFilter"));
  const type = nameOf(get("Type"));
  const isTimestamp = subFilter === "ETSI.RFC3161" || type === "DocTimeStamp";
  const contentsNode = get("Contents");
  const byteRange = entry.hit.values;
  const report = {
    kind: isTimestamp ? "document-timestamp" : "signature",
    fieldName: null,
    fieldNameSource: null,
    pageIndex: null,
    rect: null,
    visible: null,
    referencedByCurrentDocument: null,
    object: entry.object ? `${entry.object.num} ${entry.object.gen}` : null,
    type,
    filter: nameOf(get("Filter")),
    subFilter,
    signerName: null,
    nameEntry: null,
    reason: null,
    location: null,
    contactInfo: null,
    application: null,
    signingTime: null,
    byteRange,
    coverage: null,
    contents: null,
    digestAlgorithm: null,
    signatureAlgorithm: null,
    digestMatches: null,
    signatureValid: null,
    integrity: { digestMatches: null, signatureValid: null, ok: null, unsupported: null },
    signerCertificate: null,
    chain: [],
    chainComplete: false,
    certificateValidAtSigningTime: null,
    timestamp: null,
    docMdp: null,
    fieldMdp: null,
    isCertification: false,
    trust: trustNotChecked("not-evaluated", now),
    problems,
    verdict: "unknown"
  };

  // --- strings of the dictionary. In an encrypted document they are ciphertext in the file (only /Contents
  //     is exempt), so they come from the parser when it decrypted the document, or not at all.
  let mText = null;
  if (encrypted) {
    const decrypted = context.decryptedStrings && entry.object ? context.decryptedStrings(entry.object.num, entry.object.gen) : null;
    if (decrypted) {
      report.nameEntry = decrypted.Name;
      report.reason = decrypted.Reason;
      report.location = decrypted.Location;
      report.contactInfo = decrypted.ContactInfo;
      mText = decrypted.M;
    } else {
      report.encryptedStrings = true;
      problems.push(problem("SIGN_ENCRYPTED_STRINGS", "info"));
    }
  } else {
    report.nameEntry = textOf(bytes, get("Name"));
    report.reason = textOf(bytes, get("Reason"));
    report.location = textOf(bytes, get("Location"));
    report.contactInfo = textOf(bytes, get("ContactInfo"));
    const propBuild = resolveNode(bytes, get("Prop_Build"));
    if (propBuild && propBuild.type === "dict") {
      const app = resolveNode(bytes, propBuild.entries.get("App"));
      if (app && app.type === "dict") report.application = nameOf(app.entries.get("Name")) || textOf(bytes, app.entries.get("Name"));
    }
    mText = textOf(bytes, get("M"));
  }
  const mDate = mText ? parsePdfDate(mText) : { date: null };
  Object.assign(report, readDocMdp(bytes, dict));

  // --- byte-level checks
  if (byteRange.length !== 4) {
    problems.push(problem("SIGN_BYTE_RANGE_SHAPE", "error", { count: byteRange.length }));
    return report;
  }
  if (!contentsNode || contentsNode.type !== "string") {
    problems.push(problem("SIGN_NO_CONTENTS", "error"));
    return report;
  }
  const [a, b, c, d] = byteRange;
  const coverage = describeCoverage(byteRange, bytes.length, revisions, contentsNode);
  report.coverage = coverage;
  if (c + d > bytes.length || a + b > c) {
    problems.push(problem("SIGN_BYTE_RANGE_OUT_OF_FILE", "error"));
    return report;
  }
  if (!coverage.startsAtZero) problems.push(problem("SIGN_BYTE_RANGE_NOT_FROM_START", "error"));
  // other bytes than the signature value escape the signature
  if (!coverage.gapMatchesContents) problems.push(problem("SIGN_BYTE_RANGE_GAP_MISMATCH", "error"));
  if (coverage.status === "partial" && coverage.startsAtZero && coverage.gapMatchesContents) {
    problems.push(problem("SIGN_COVERAGE_NOT_A_REVISION", "error", { signedEnd: coverage.signedEnd }));
  } else if (coverage.status === "revision") {
    problems.push(problem("SIGN_CHANGED_AFTER_SIGNING", "warning", { bytesAfter: coverage.bytesAfter, laterRevisions: coverage.laterRevisions }));
  }

  // --- the signature value
  const raw = contentsNode.bytes;
  if (raw.every((value) => value === 0)) {
    report.contents = { bytes: raw.length, valueBytes: 0, paddingBytes: raw.length, paddingAllZero: true, hexString: Boolean(contentsNode.hex), encoding: null };
    // the field was prepared but never signed
    problems.push(problem("SIGN_UNSIGNED_PLACEHOLDER", "error"));
    return report;
  }
  if (contentsNode.hex) {
    // The hex string is the one part of the file the signature does not cover. Anything in it that is not a
    // hex digit could be read differently by different parsers: other characters are an error, white space
    // (legal PDF, but unusual and rejected by strict validators) a warning.
    let whiteSpace = 0;
    let foreign = 0;
    for (let i = contentsNode.start + 1; i < contentsNode.end - 1; i++) {
      const code = bytes[i];
      const isHex = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
      if (isHex) continue;
      if (code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32) whiteSpace++;
      else foreign++;
    }
    if (foreign) problems.push(problem("SIGN_CONTENTS_NOT_HEX", "error", { count: foreign }));
    else if (whiteSpace) problems.push(problem("SIGN_CONTENTS_NOT_PLAIN_HEX", "warning"));
  }
  const cmsLength = berLength(raw);
  const padding = cmsLength > 0 ? raw.subarray(cmsLength) : new Uint8Array(0);
  report.contents = {
    bytes: raw.length,
    valueBytes: cmsLength > 0 ? cmsLength : null,
    paddingBytes: padding.length,
    paddingAllZero: padding.every((value) => value === 0),
    hexString: Boolean(contentsNode.hex),
    encoding: null
  };
  if (cmsLength <= 0) {
    problems.push(problem("SIGN_CONTENTS_UNREADABLE", "error"));
    return report;
  }
  if (!report.contents.paddingAllZero) problems.push(problem("SIGN_CONTENTS_TRAILING_DATA", "warning"));
  const value = raw.subarray(0, cmsLength);

  const signedParts = [bytes.subarray(a, a + b), bytes.subarray(c, c + d)];
  const digestCache = new Map();
  const digestRanges = async (hashName) => {
    if (!digestCache.has(hashName)) digestCache.set(hashName, await digest(hashName, signedParts));
    return digestCache.get(hashName);
  };

  let signerCert = null;
  let allCerts = [];
  let cmsSigningTime = null;
  let timestampInfo = null;
  const integrity = report.integrity;

  if (subFilter === "adbe.x509.rsa_sha1") {
    // /Contents = DER OCTET STRING with a PKCS#1 v1.5 signature over the byte ranges; certificates in /Cert
    report.contents.encoding = "PKCS1";
    const certNode = resolveNode(bytes, get("Cert"));
    const certStrings = !certNode ? [] : certNode.type === "array" ? certNode.items.map((item) => resolveNode(bytes, item)) : [certNode];
    for (const item of certStrings) {
      if (item && item.type === "string") {
        try {
          allCerts.push(parseCertificate(item.bytes));
        } catch {
          /* an unreadable certificate is ignored */
        }
      }
    }
    signerCert = allCerts[0] || null;
    report.digestAlgorithm = "SHA-1";
    report.signatureAlgorithm = "RSA PKCS#1 v1.5 (adbe.x509.rsa_sha1)";
    problems.push(problem("SIGN_LEGACY_SUBFILTER", "warning", { subFilter }));
    if (!signerCert) {
      problems.push(problem("SIGN_SIGNER_CERTIFICATE_MISSING", "error"));
    } else {
      let signature = value;
      try {
        const wrapped = decode(value);
        if (wrapped.isUniversal(TAG.OCTET_STRING)) signature = wrapped.octets();
      } catch {
        /* a bare signature value */
      }
      const content = concatBytes(signedParts);
      let verdict = { ok: false };
      for (const hash of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
        verdict = await verifySignature({ scheme: "rsa-pkcs1", hash, name: `RSA ${hash}`, oid: "" }, signerCert.spki, signature, content);
        if (verdict.ok === true) {
          report.digestAlgorithm = hash;
          break;
        }
        if (verdict.ok === null) break;
      }
      // this format has a single check: the RSA signature is computed directly over the document bytes
      integrity.digestMatches = verdict.ok;
      integrity.signatureValid = verdict.ok;
      integrity.unsupported = verdict.unsupported || null;
      integrity.singleCheck = true;
    }
  } else if (isTimestamp) {
    const token = await verifyTimestampToken(value, digestRanges);
    report.contents.encoding = token.encoding || null;
    timestampInfo = token;
    signerCert = token.tsaCertificate || null;
    allCerts = token.certificates || [];
    report.digestAlgorithm = token.hashAlgorithm || null;
    report.signatureAlgorithm = token.signatureAlgorithm ? token.signatureAlgorithm.name : null;
    integrity.digestMatches = token.imprintMatches ?? null;
    integrity.signatureValid = token.readable ? triState(token.digestMatches, token.signatureValid) : null;
    integrity.unsupported = token.unsupported || null;
    for (const entryProblem of token.problems) problems.push(entryProblem);
  } else {
    let signedData;
    try {
      signedData = parseSignedData(value);
    } catch (error) {
      if (!isPdfEditorError(error)) throw error;
      problems.push(problem("SIGN_CMS_UNREADABLE", "error"));
      return report;
    }
    report.contents.encoding = signedData.encoding;
    if (!["adbe.pkcs7.detached", "ETSI.CAdES.detached", "adbe.pkcs7.sha1"].includes(subFilter)) {
      // read as a detached CMS signature
      problems.push(problem("SIGN_UNKNOWN_SUBFILTER", "warning", { subFilter }));
    }
    if (signedData.signerInfos.length !== 1) {
      // a PDF signature must have exactly one signer
      problems.push(problem("SIGN_SIGNER_COUNT", signedData.signerInfos.length ? "warning" : "error", { count: signedData.signerInfos.length }));
    }
    const signerInfo = signedData.signerInfos[0];
    if (signerInfo) {
      let verdict;
      if (subFilter === "adbe.pkcs7.sha1") {
        // the CMS signs a SHA-1 digest of the byte ranges, carried as its content
        problems.push(problem("SIGN_LEGACY_SUBFILTER", "warning", { subFilter }));
        const documentDigest = await digestRanges("SHA-1");
        const embedded = signedData.eContent;
        verdict = await verifySignerInfo(signedData, signerInfo, (hashName) => digest(hashName, embedded || new Uint8Array(0)));
        if (!signerInfo.signedAttrsNode && embedded) await verifySignatureOverContent(verdict, signerInfo, embedded);
        const documentMatches = Boolean(embedded) && equalBytes(embedded, documentDigest);
        verdict.digestMatches = verdict.digestMatches === true && documentMatches ? true : (verdict.digestMatches === null && documentMatches ? null : false);
      } else {
        // the container carries its own content although the format is "detached"
        if (signedData.eContent) problems.push(problem("SIGN_NOT_DETACHED", "warning"));
        verdict = await verifySignerInfo(signedData, signerInfo, digestRanges);
        if (verdict.needsContentForSignature) await verifySignatureOverContent(verdict, signerInfo, concatBytes(signedParts));
      }
      signerCert = verdict.signerCertificate;
      allCerts = verdict.certificates;
      cmsSigningTime = verdict.signingTime;
      report.digestAlgorithm = verdict.digestAlgorithm.name;
      report.signatureAlgorithm = verdict.signatureAlgorithm.name;
      report.signatureScheme = verdict.signatureAlgorithm.scheme;
      integrity.digestMatches = verdict.digestMatches;
      integrity.signatureValid = verdict.signatureValid;
      integrity.unsupported = verdict.unsupported;
      report.signedAttributes = verdict.signedAttributeNames;
      report.unsignedAttributes = verdict.unsignedAttributeNames;
      report.signingCertificateAttribute = verdict.essCertificate;
      report.hasEmbeddedRevocationInfo = verdict.hasEmbeddedRevocationInfo;
      for (const entryProblem of verdict.problems) problems.push(entryProblem);
      if (verdict.digestAlgorithm.weak) problems.push(problem("SIGN_WEAK_DIGEST", "warning", { algorithm: verdict.digestAlgorithm.name }));
      // a PAdES signature must carry the signing-certificate attribute
      if (subFilter === "ETSI.CAdES.detached" && !verdict.essCertificate) problems.push(problem("SIGN_PADES_NO_SIGNING_CERTIFICATE", "warning"));
      if (verdict.signatureTimestampTokens.length) {
        timestampInfo = await verifyTimestampToken(verdict.signatureTimestampTokens[0], (hashName) => digest(hashName, signerInfo.signature));
        for (const entryProblem of timestampInfo.problems) problems.push(entryProblem);
      }
    }
  }
  integrity.ok = triState(integrity.digestMatches, integrity.signatureValid);
  if (integrity.digestMatches === false) problems.push(problem("SIGN_DOCUMENT_MODIFIED", "error"));
  if (integrity.signatureValid === false) problems.push(problem("SIGN_SIGNATURE_INVALID", "error"));
  if (integrity.ok === null && integrity.unsupported) problems.push(problem("SIGN_CANNOT_VERIFY", "warning", { reason: integrity.unsupported.reason, name: integrity.unsupported.name }));

  // --- time
  if (timestampInfo) {
    const time = timestampInfo.time && !Number.isNaN(timestampInfo.time.getTime()) ? timestampInfo.time.toISOString() : null;
    report.timestamp = {
      present: true,
      kind: isTimestamp ? "document" : "signature",
      time,
      authority: timestampInfo.tsaCertificate ? commonNameOf(timestampInfo.tsaCertificate.subject) : (timestampInfo.tsaName || null),
      authoritySubject: timestampInfo.tsaCertificate ? timestampInfo.tsaCertificate.subject.text : (timestampInfo.tsaName || null),
      hashAlgorithm: timestampInfo.hashAlgorithm || null,
      imprintMatches: timestampInfo.imprintMatches ?? null,
      signatureValid: triState(timestampInfo.digestMatches, timestampInfo.signatureValid),
      ok: Boolean(timestampInfo.ok),
      identityVerified: false // a timestamp authority is never called verified here
    };
  } else {
    report.timestamp = { present: false };
  }
  const timestampTime = report.timestamp.present && report.timestamp.ok && report.timestamp.time ? new Date(report.timestamp.time) : null;
  let bestTime = null;
  if (timestampTime) bestTime = { value: timestampTime, source: isTimestamp ? "document-timestamp" : "signature-timestamp", proven: true };
  else if (cmsSigningTime) bestTime = { value: cmsSigningTime, source: "signing-time-attribute", proven: false };
  else if (mDate.date) bestTime = { value: mDate.date, source: "m-entry", proven: false };
  report.signingTime = {
    value: bestTime ? bestTime.value.toISOString() : null,
    source: bestTime ? bestTime.source : null,
    proven: bestTime ? bestTime.proven : false, // false = only claimed by the signer
    m: mDate.date ? mDate.date.toISOString() : null,
    mText: mText || null,
    signingTimeAttribute: cmsSigningTime ? cmsSigningTime.toISOString() : null,
    timestamp: report.timestamp.present ? report.timestamp.time : null
  };
  if (!bestTime) problems.push(problem("SIGN_NO_SIGNING_TIME", "info"));
  const claimedTime = cmsSigningTime || mDate.date;
  if (timestampTime && claimedTime && !isTimestamp && Math.abs(timestampTime.getTime() - claimedTime.getTime()) > 15 * 60 * 1000) {
    // the timestamp is the reliable one
    problems.push(problem("SIGN_TIME_MISMATCH", "info", { claimed: claimedTime.toISOString(), timestamp: timestampTime.toISOString() }));
  }

  // --- certificate facts and chain
  if (signerCert) {
    report.signerCertificate = await certificateFacts(signerCert, { now, role: isTimestamp ? "timestamp-authority" : "signer" });
    report.signerName = report.signerCertificate.displayName || report.nameEntry;
    const ordered = await orderChain(signerCert, allCerts);
    report.chain = ordered.chain.map(certificateSummary);
    report.chainComplete = ordered.complete;
    report.chainLinks = ordered.links;
    report.extraCertificates = ordered.extras.length;
    // Is the certificate that names the signer protected against alteration?
    //  - by the signature itself, through the signing-certificate attribute (PAdES / CAdES);
    //  - by its own signature when it is self-signed AND that signature verified;
    //  - by the issuer certificate that travels with it, when its signature on the certificate verified
    //    (weaker: that issuer is itself unverified here).
    // A first link that could not be checked (signatureOk null) protects nothing.
    const firstLink = ordered.links[0] || null;
    const boundByAttribute = Boolean(report.signingCertificateAttribute && report.signingCertificateAttribute.matches === true);
    if (firstLink && firstLink.signatureOk === false) {
      report.signerCertificateCheck = "failed";
      problems.push(problem("SIGN_SIGNER_CERTIFICATE_ALTERED", "error", { selfSigned: Boolean(firstLink.selfSigned) }));
    } else if (boundByAttribute) {
      report.signerCertificateCheck = "bound-by-signature";
    } else if (firstLink && firstLink.signatureOk === true) {
      report.signerCertificateCheck = firstLink.selfSigned ? "self-signed" : "signed-by-included-issuer";
    } else {
      // nothing in this signature protects the certificate that names the signer: the name is only a claim
      report.signerCertificateCheck = "unprotected";
      if (!isTimestamp) problems.push(problem("SIGN_SIGNER_NAME_UNPROTECTED", "warning"));
    }
    if (ordered.links.slice(1).some((link) => link.signatureOk === false)) problems.push(problem("SIGN_CHAIN_BROKEN", "warning"));
    const reference = bestTime ? bestTime.value : now;
    const status = validityAt(signerCert, reference);
    report.certificateValidAtSigningTime = bestTime ? status === "valid" : null;
    report.certificateValidNow = validityAt(signerCert, now) === "valid";
    if (bestTime && status === "expired") problems.push(problem("CERT_EXPIRED_AT_SIGNING", "error", { notAfter: signerCert.notAfter.toISOString() }));
    else if (bestTime && status === "notYetValid") problems.push(problem("CERT_NOT_YET_VALID_AT_SIGNING", "error", { notBefore: signerCert.notBefore.toISOString() }));
    else if (!report.certificateValidNow) problems.push(problem("CERT_EXPIRED_SINCE", "info", { notAfter: signerCert.notAfter.toISOString(), timeProven: Boolean(bestTime && bestTime.proven) }));
    if (!isTimestamp) {
      for (const entryWarning of report.signerCertificate.warnings) {
        if (FORWARDED_CERTIFICATE_WARNINGS.includes(entryWarning.code)) problems.push(problem(entryWarning.code, "warning", entryWarning.params));
      }
    }
    report.trust = await evaluateTrust(signerCert, allCerts, ordered, context.trusted, reference, integrity.signatureValid === true);
  } else {
    report.signerName = report.nameEntry;
    report.trust = trustNotChecked("no-signer-certificate", now);
  }
  if (isTimestamp) report.signerName = report.timestamp.authority || report.signerName;

  return report;
}

/**
 * The badge of one signature, computed last (the form walk and the revision comparison add problems).
 *   valid                 intact, covers the whole file (or only signatures / timestamps were added after it)
 *   valid-with-warnings   intact, but something deserves attention (weak algorithm, legacy format, ...)
 *   document-changed      intact for an EARLIER revision; the document was changed afterwards in other ways
 *   invalid               digest mismatch, signature value wrong, or a structural rule broken
 *   unknown               could not be verified here (unsupported algorithm, unreadable)
 * "valid" says nothing about WHO signed: that is `trust`.
 */
function decideVerdict(report) {
  const problems = report.problems;
  if (report.integrity.ok === false || problems.some((entry) => entry.severity === "error")) return "invalid";
  if (report.integrity.ok === null) return "unknown";
  if (problems.some((entry) => entry.code === "SIGN_CHANGED_AFTER_SIGNING")) return "document-changed";
  if (problems.some((entry) => entry.severity === "warning")) return "valid-with-warnings";
  return "valid";
}

// ------------------------------------------------------------------------------------------------
// public API

/**
 * @param {Uint8Array|ArrayBuffer} pdfInput
 * @param {object} [options]
 *   trustedCertificates: Uint8Array[] (DER or PEM) roots the caller trusts; without them trust is "not-checked"
 *   now: Date used for "valid today" statements
 *   password: the document password, so that the strings of an encrypted document can be read
 *   analyzeChanges: false to skip the comparison of revisions (it parses the signed prefix once more)
 *   signal: AbortSignal, looked at between the stages (the PDF parser itself cannot be interrupted)
 * @returns {Promise<{ signatures: object[], unsignedFields: object[], otherByteRanges: object[], document: object }>}
 *          It never throws for a property of the document (damaged or non-PDF input gives an empty report);
 *          only SIGN_NO_WEBCRYPTO when there is no crypto.subtle.
 */
export async function inspectSignatures(pdfInput, options = {}) {
  subtle();
  throwIfAborted(options.signal);
  const bytes = asBytes(pdfInput) || new Uint8Array(0);
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const revisions = scanRevisions(bytes);
  const encrypted = looksEncrypted(bytes);
  const { entries: rawEntries, skipped } = collectRawEntries(bytes);
  const loaded = await loadWithParser(bytes, options.password);
  throwIfAborted(options.signal);
  const form = walkAcroForm(loaded.doc);
  const trusted = [];
  for (const entry of options.trustedCertificates || []) {
    let list = [];
    try {
      list = certificatesFromPemOrDer(entry); // one DER certificate, or every certificate of a PEM bundle
    } catch {
      /* not bytes: ignored */
    }
    for (const der of list) {
      try {
        trusted.push(parseCertificate(der));
      } catch {
        /* an unreadable root is ignored */
      }
    }
  }
  const context = { revisions, now, encrypted, trusted, decryptedStrings: null };
  if (encrypted && loaded.doc && loaded.decrypted) {
    context.decryptedStrings = (num, gen) => {
      try {
        const dict = loaded.doc.context.lookup(pdfLib.PDFRef.of(num, gen));
        if (!dict || typeof dict.get !== "function") return null;
        const read = (key) => {
          const value = dict.get(pdfLib.PDFName.of(key));
          return value && typeof value.decodeText === "function" ? value.decodeText() : null;
        };
        return { Name: read("Name"), Reason: read("Reason"), Location: read("Location"), ContactInfo: read("ContactInfo"), M: read("M") };
      } catch {
        return null;
      }
    };
  }

  const signatures = [];
  const others = [];
  for (const entry of rawEntries) {
    if (entry.kind === "signature") {
      throwIfAborted(options.signal);
      let report;
      try {
        report = await inspectOne(bytes, entry, context);
      } catch (error) {
        if (isPdfEditorError(error) && error.code === "SIGN_NO_WEBCRYPTO") throw error;
        // not evidence against the signature: it could not be examined here (verdict "unknown")
        report = {
          kind: "signature", object: entry.object ? `${entry.object.num} ${entry.object.gen}` : null, byteRange: entry.hit.values,
          problems: [problem("SIGN_INSPECTION_FAILED", "warning")], digestMatches: null, signatureValid: null,
          integrity: { digestMatches: null, signatureValid: null, ok: null, unsupported: null }, coverage: null, fieldName: null, fieldNameSource: null,
          pageIndex: null, rect: null, visible: null, chain: [], signerName: null, signerCertificate: null, trust: trustNotChecked("not-evaluated", now),
          referencedByCurrentDocument: null, docMdp: null, isCertification: false, timestamp: { present: false }, verdict: "unknown"
        };
      }
      report.objectNumber = entry.object ? entry.object.num : null;
      report.objectOffset = entry.object ? entry.object.offset : entry.hit.keyOffset;
      signatures.push(report);
    } else {
      // "pdf-mac": the ISO/TS 32004 integrity MAC of an encrypted PDF 2.0 file; "unknown": a /ByteRange that
      // does not belong to a signature dictionary (text inside a stream, ...). Neither is a signature.
      others.push({ kind: entry.kind === "pdf-mac" ? "pdf-mac" : "unknown", byteRange: entry.hit.values, offset: entry.hit.keyOffset });
    }
  }

  // --- join with the form fields. An object number can be defined several times (incremental updates):
  //     the field value is the LAST definition in the file.
  const unsignedFields = [];
  if (form.ok) {
    for (const field of form.fields) {
      if (!field.hasValue) {
        unsignedFields.push({ name: field.name, pageIndex: field.pageIndex, rect: field.rect, visible: field.visible });
        continue;
      }
      const candidates = field.valueRef ? signatures.filter((signature) => signature.objectNumber === field.valueRef.num && signature.fieldName === null) : [];
      const match = candidates.sort((x, y) => y.objectOffset - x.objectOffset)[0] || null;
      if (match) {
        // in an encrypted document the field name is ciphertext unless the parser decrypted it
        const readable = !encrypted || loaded.decrypted;
        match.fieldName = readable ? field.name : null;
        match.fieldNameSource = readable ? "acroform" : "encrypted";
        match.pageIndex = field.pageIndex;
        match.rect = field.rect;
        match.visible = field.visible;
        match.referencedByCurrentDocument = true;
        match.fieldLocked = field.hasLock;
      } else if (!field.valueIsDirect) {
        // the field has a value that is not a readable signature dictionary
        unsignedFields.push({ name: field.name, pageIndex: field.pageIndex, rect: field.rect, visible: field.visible, unreadableValue: true });
      }
    }
    for (const signature of signatures) {
      if (signature.referencedByCurrentDocument === null) {
        // in the file, but no form field of the current document refers to it (removed or replaced signature)
        signature.referencedByCurrentDocument = false;
        signature.problems.push(problem("SIGN_NOT_REFERENCED", "warning"));
      }
      signature.isCertification = Boolean(form.docMdpRef && signature.objectNumber === form.docMdpRef.num);
      // false: the signature declares DocMDP permissions but the catalog (/Perms) does not point to it
      if (signature.docMdp) signature.docMdp.inCatalog = signature.isCertification;
    }
  } else {
    for (const signature of signatures) signature.isCertification = Boolean(signature.docMdp);
  }
  for (const signature of signatures) if (!signature.fieldName && !signature.fieldNameSource) signature.fieldNameSource = "none";

  // signing order = order of the signed ranges
  signatures.sort((x, y) => ((x.coverage ? x.coverage.signedEnd : 0) - (y.coverage ? y.coverage.signedEnd : 0)) || (x.objectOffset - y.objectOffset));
  signatures.forEach((signature, index) => {
    signature.index = index + 1;
  });

  // --- what happened after each signature that does not cover the whole file
  const certification = signatures.find((signature) => signature.isCertification && signature.docMdp) || null;
  const diffCache = new Map();
  // the comparison needs both revisions as stored: a decrypted document would differ in every string
  const comparisonDoc = loaded.decrypted ? null : loaded.doc;
  for (const signature of signatures) {
    if (!signature.coverage || signature.coverage.status !== "revision") continue;
    const later = signatures.filter((other) => other !== signature && other.coverage && other.coverage.signedEnd > signature.coverage.signedEnd);
    const changes = {
      classification: "unknown",
      reason: "not-compared",
      items: [],
      unchanged: false,
      onlyValidationData: false,
      laterSignatures: later.map((other) => ({ index: other.index, fieldName: other.fieldName, kind: other.kind }))
    };
    if (loaded.doc && options.analyzeChanges !== false) {
      const signedEnd = signature.coverage.signedEnd;
      if (!diffCache.has(signedEnd)) {
        throwIfAborted(options.signal);
        let comparison;
        try {
          comparison = await classifyChangesAfter(bytes, signedEnd, comparisonDoc);
        } catch (error) {
          if (isPdfEditorError(error) && error.code === "SIGN_NO_WEBCRYPTO") throw error;
          // a document the comparison stumbles over: what changed stays unknown, which is never "valid"
          comparison = { classification: "unknown", reason: "failed", items: [], unchanged: false, onlyValidationData: false };
        }
        diffCache.set(signedEnd, comparison);
      }
      Object.assign(changes, diffCache.get(signedEnd));
    }
    signature.changesAfterSigning = changes;
    const index = signature.problems.findIndex((entry) => entry.code === "SIGN_CHANGED_AFTER_SIGNING");
    if (changes.classification === "signatures-only") {
      // not a defect of this signature: the generic warning becomes information
      if (index >= 0) signature.problems[index] = problem("SIGN_LATER_REVISIONS", "info", signature.problems[index].params);
      const realSignatures = later.filter((other) => other.kind === "signature");
      if (certification && certification.docMdp.level === 1 && realSignatures.length && signature === certification) {
        // this certification allows no changes, but a signature was added afterwards
        signature.problems.push(problem("SIGN_DOCMDP_VIOLATION", "error"));
      }
    }
  }
  for (const signature of signatures) {
    signature.digestMatches = signature.integrity.digestMatches;
    signature.signatureValid = signature.integrity.signatureValid;
    signature.verdict = decideVerdict(signature);
  }

  return {
    signatures,
    unsignedFields,
    otherByteRanges: others,
    document: {
      size: bytes.length,
      revisions: revisions.length,
      encrypted,
      hasDss: form.ok ? form.hasDss : null,
      sigFlags: form.ok ? form.sigFlags : null,
      certification: certification ? { fieldName: certification.fieldName, level: certification.docMdp.level } : null,
      parser: { ok: form.ok, decryptedStrings: Boolean(context.decryptedStrings) },
      // "caller-roots": chains are compared with the supplied certificates (never revocation);
      // "none": signatures are checked mathematically only, signer identities are not verified
      trustModel: trusted.length ? "caller-roots" : "none",
      byteRangesSkipped: skipped
    }
  };
}

/**
 * The exact bytes that one signature covers = the document as it was when that signature was made
 * ("view signed version"). `signature` is an entry of inspectSignatures(...).signatures. Returns a VIEW of the
 * input (no copy), or null when the signature has no usable coverage.
 */
export function signedRevisionBytes(pdfInput, signature) {
  const bytes = asBytes(pdfInput);
  const signedEnd = signature && signature.coverage ? signature.coverage.signedEnd : null;
  if (!bytes || !Number.isInteger(signedEnd) || signedEnd <= 0 || signedEnd > bytes.length) return null;
  return bytes.subarray(0, signedEnd);
}
