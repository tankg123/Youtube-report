// The ONE X.509 module: certificate parsing (for display, for chain building and for the CMS builder, which
// copies issuer / serial / SPKI bytes verbatim), signature checks between certificates, chain ordering, the
// search for a certification path to a trusted certificate and the facts the interface shows. Browser + Node.
// No node-forge on purpose: forge reads RSA certificates only.
//
// A check has THREE outcomes everywhere in this module: true (verified), false (verified to be wrong) and null
// (could not be checked here: a hash, curve or algorithm the platform lacks). null is never counted as true:
//   orderChain      lists issuers by name and key identifier (for display and for the certificate set of a
//                   signature) and says per link what the signature check gave; `complete` needs every link,
//                   the root's own signature included, to be verified;
//   findTrustPath   decides trust: a path counts only when every link up to the trusted certificate verified
//                   and the path obeys the constraints of its authorities;
//   certificateFacts  calls a certificate self-signed only when its own signature verified.

import { PdfEditorError, isPdfEditorError, warning } from "../errors.js";
import { asn1Error, decode, TAG } from "./asn1.js";
import { asBytes, equalBytes, fromPem, latin1Decode, toHex } from "./bytes.js";
import { EXTENDED_KEY_USAGES, EXTENSION_NAMES, KEY_USAGE_BITS, NAME_ATTRIBUTES, OID } from "./oids.js";
import { digest, parseSpki, resolveSignatureAlgorithm, verifySignature } from "./sigverify.js";

const unreadable = (detail, cause) => new PdfEditorError("CERT_UNREADABLE", {}, { detail, cause });

const looksLikePem = (bytes) => bytes.length > 10 && bytes[0] === 0x2d && bytes[1] === 0x2d;

/** DER or PEM ("-----BEGIN CERTIFICATE-----") bytes -> DER bytes of the first certificate. */
export function certificateToDer(input) {
  const bytes = asBytes(input);
  if (!bytes) throw unreadable("a certificate must be given as bytes (DER or PEM)");
  if (looksLikePem(bytes)) {
    const blocks = fromPem(latin1Decode(bytes)).filter((block) => /CERTIFICATE/.test(block.label));
    if (!blocks.length) throw unreadable("no certificate found in the PEM text");
    return blocks[0].der;
  }
  return bytes;
}

/** Every certificate of a PEM bundle (or the single DER certificate). */
export function certificatesFromPemOrDer(input) {
  const bytes = asBytes(input);
  if (!bytes) throw unreadable("certificates must be given as bytes (DER or PEM)");
  if (looksLikePem(bytes)) {
    return fromPem(latin1Decode(bytes)).filter((block) => /CERTIFICATE/.test(block.label)).map((block) => block.der);
  }
  return [bytes];
}

// ------------------------------------------------------------------------------------------------
// names

/**
 * Name (RDNSequence) -> {
 *   der,                       raw bytes (issuer / subject comparison is done on these first)
 *   attributes: [{ oid, type, value, stringType, rdn }]   in encoding order (usually C ... CN)
 *   fields: { CN: ["..."], O: [...], ... }                 every attribute by short label
 *   text                       "C=VN, O=..., CN=..." in encoding order (as OpenSSL prints it)
 * }
 */
export function parseName(node) {
  const attributes = [];
  if (!node.isSequence) throw asn1Error("unexpected-type", node.start, "Name is not a SEQUENCE");
  node.children.forEach((rdn, rdnIndex) => {
    for (const atv of rdn.children || []) {
      const oid = atv.child(0).oid();
      const valueNode = atv.child(1);
      const stringType = valueNode.stringType();
      const value = stringType ? valueNode.string() : `#${toHex(valueNode.raw)}`;
      attributes.push({ oid, type: NAME_ATTRIBUTES[oid] || oid, value, stringType: stringType || "other", rdn: rdnIndex });
    }
  });
  const fields = {};
  for (const attribute of attributes) (fields[attribute.type] ||= []).push(attribute.value);
  const text = attributes.map((attribute) => `${attribute.type}=${escapeNameValue(attribute.value)}`).join(", ");
  return { der: node.raw, attributes, fields, text };
}

function escapeNameValue(value) {
  return /[,+"\\<>;=]|^\s|\s$/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

// U+0001 as a separator that cannot occur in a printable attribute value (built from its code: the source
// holds no control character)
const NAME_KEY_SEPARATOR = String.fromCharCode(1);

function normalizedNameKey(name) {
  // RFC 5280 7.1 in spirit: case-insensitive, internal white space collapsed, string type ignored
  return name.attributes.map((attribute) => `${attribute.oid}=${attribute.value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()}`).join(NAME_KEY_SEPARATOR);
}

/** True when two parsed names denote the same DN (byte-equal, or equal after normalisation). */
export function namesEqual(a, b) {
  if (equalBytes(a.der, b.der)) return true;
  return normalizedNameKey(a) === normalizedNameKey(b);
}

/**
 * Identifiers that Vietnamese CAs put into the subject, mostly in UID (0.9.2342.19200300.100.1.1) as
 * "<KIND>:<value>": MST = tax code, CMND / CCCD = citizen identity card, HC = passport, MNS = budget
 * relation code, BHXH = social insurance code, QD = establishment decision.
 * -> [{ kind, value, attribute }]
 */
export function vietnameseIdentifiers(name) {
  const out = [];
  for (const attribute of name.attributes) {
    if (!["UID", "serialNumber", "x500UniqueIdentifier", "organizationIdentifier"].includes(attribute.type)) continue;
    for (const part of attribute.value.split(/[,;]\s*/)) {
      const match = /^\s*(MST|CMND|CCCD|CMT|HC|PP|MNS|BHXH|QD|MDV|DDCN|CCCDCC|TIN|VATVN)\s*[:-]\s*(.+?)\s*$/i.exec(part);
      if (match) out.push({ kind: match[1].toUpperCase(), value: match[2], attribute: attribute.type });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// certificate

/**
 * Parses one certificate (DER or PEM bytes). Throws CERT_UNREADABLE.
 * The result keeps byte views into the input: `der`, `tbs` (the signed part), `spki`, `signature`,
 * `issuer.der`, `subject.der` and `serialNumberTlv` (the INTEGER as encoded): CMS copies them verbatim.
 */
export function parseCertificate(input) {
  const derBytes = certificateToDer(input);
  try {
    const root = decode(derBytes);
    if (!root.isSequence || root.children.length < 3) throw asn1Error("unexpected-type", root.start, "Certificate is not SEQUENCE { tbs, algorithm, signature }");
    const tbs = root.children[0];
    if (!tbs.isSequence) throw asn1Error("unexpected-type", tbs.start, "TBSCertificate is not a SEQUENCE");
    const fields = [...tbs.children];
    let version = 1;
    if (fields[0] && fields[0].isContext(0)) {
      version = fields[0].child(0).integerNumber() + 1;
      fields.shift();
    }
    const [serialNode, sigAlgNode, issuerNode, validityNode, subjectNode, spkiNode, ...rest] = fields;
    if (!spkiNode) throw asn1Error("missing-element", tbs.start, "TBSCertificate is incomplete");
    const signatureBits = root.children[2].bitString();
    const cert = {
      der: root.raw,
      tbs: tbs.raw,
      version,
      serialNumber: serialNode.integerHex(),
      serialNumberNegative: serialNode.integerIsNegative(),
      serialNumberBytes: serialNode.integerBytes(),
      serialNumberTlv: serialNode.raw,
      tbsSignatureAlgorithmOid: sigAlgNode.child(0).oid(),
      issuer: parseName(issuerNode),
      subject: parseName(subjectNode),
      notBefore: validityNode.child(0).time(),
      notAfter: validityNode.child(1).time(),
      spki: spkiNode.raw,
      publicKey: parseSpki(spkiNode.raw),
      signatureAlgorithm: resolveSignatureAlgorithm(root.children[1]),
      signatureAlgorithmDer: root.children[1].raw,
      signature: signatureBits.bytes,
      signatureUnusedBits: signatureBits.unusedBits,
      extensions: [],
      ext: {}
    };
    // an unreadable validity must not pass as "valid" (comparisons with an invalid Date are all false)
    if (Number.isNaN(cert.notBefore.getTime()) || Number.isNaN(cert.notAfter.getTime())) throw asn1Error("bad-time", validityNode.start, "unreadable validity dates");
    const extensionsWrapper = rest.find((node) => node.isContext(3));
    if (extensionsWrapper) parseExtensions(extensionsWrapper.child(0), cert);
    cert.selfIssued = namesEqual(cert.subject, cert.issuer);
    return cert;
  } catch (error) {
    if (isPdfEditorError(error) && error.code === "CERT_UNREADABLE") throw error;
    throw unreadable(`not a readable X.509 certificate: ${error && error.message}`, error);
  }
}

function parseExtensions(sequence, cert) {
  for (const extension of sequence.children || []) {
    const oid = extension.child(0).oid();
    let critical = false;
    let valueNode = extension.child(1);
    if (valueNode.isUniversal(TAG.BOOLEAN)) {
      critical = valueNode.boolean();
      valueNode = extension.child(2);
    }
    const value = valueNode.octets();
    const entry = { oid, name: EXTENSION_NAMES[oid] || oid, critical, value };
    cert.extensions.push(entry);
    try {
      decodeExtension(entry, cert);
    } catch {
      entry.unreadable = true; // an unreadable extension must not make the certificate unreadable
    }
  }
}

function generalNames(node) {
  const out = { emails: [], dns: [], uris: [], directoryNames: [], ips: [], otherNames: [] };
  for (const name of node.children || []) {
    if (name.isContext(1)) out.emails.push(latin1Decode(name.content));
    else if (name.isContext(2)) out.dns.push(latin1Decode(name.content));
    else if (name.isContext(6)) out.uris.push(latin1Decode(name.content));
    else if (name.isContext(4) && name.children && name.children[0]) out.directoryNames.push(parseName(name.children[0]).text);
    else if (name.isContext(7)) out.ips.push(Array.from(name.content).join("."));
    else if (name.isContext(0) && name.children) {
      const oid = name.children[0].oid();
      const inner = name.children[1] && name.children[1].children ? name.children[1].children[0] : null;
      out.otherNames.push({ oid, value: inner && inner.stringType() ? inner.string() : null });
    }
  }
  return out;
}

function decodeExtension(entry, cert) {
  const node = decode(entry.value);
  switch (entry.oid) {
    case OID.basicConstraints: {
      const constraints = { ca: false, pathLen: null, critical: entry.critical };
      for (const child of node.children || []) {
        if (child.isUniversal(TAG.BOOLEAN)) constraints.ca = child.boolean();
        else if (child.isUniversal(TAG.INTEGER)) constraints.pathLen = child.integerNumber();
      }
      cert.ext.basicConstraints = constraints;
      break;
    }
    case OID.keyUsage: {
      const { bytes, unusedBits } = node.bitString();
      const usages = [];
      const totalBits = bytes.length * 8 - unusedBits;
      KEY_USAGE_BITS.forEach((name, bit) => {
        if (bit < totalBits && bytes[bit >> 3] & (0x80 >> (bit & 7))) usages.push(name);
      });
      cert.ext.keyUsage = { usages, critical: entry.critical };
      break;
    }
    case OID.extKeyUsage:
      cert.ext.extKeyUsage = {
        usages: node.children.map((child) => EXTENDED_KEY_USAGES[child.oid()] || child.oid()),
        oids: node.children.map((child) => child.oid()),
        critical: entry.critical
      };
      break;
    case OID.subjectKeyIdentifier:
      cert.ext.subjectKeyIdentifier = node.octets();
      break;
    case OID.authorityKeyIdentifier: {
      const identifier = { keyIdentifier: null, serialNumber: null };
      for (const child of node.children || []) {
        if (child.isContext(0)) identifier.keyIdentifier = child.content;
        else if (child.isContext(2)) identifier.serialNumber = toHex(child.content);
      }
      cert.ext.authorityKeyIdentifier = identifier;
      break;
    }
    case OID.subjectAltName:
      cert.ext.subjectAltName = generalNames(node);
      break;
    case OID.crlDistributionPoints: {
      const urls = [];
      const walk = (item) => {
        if (item.isContext(6) && !item.constructed) urls.push(latin1Decode(item.content));
        for (const child of item.children || []) walk(child);
      };
      walk(node);
      cert.ext.crlUrls = urls;
      break;
    }
    case OID.authorityInfoAccess: {
      const access = { ocsp: [], caIssuers: [] };
      for (const description of node.children || []) {
        const method = description.child(0).oid();
        const location = description.child(1);
        if (!location.isContext(6)) continue;
        if (method === OID.ocsp) access.ocsp.push(latin1Decode(location.content));
        else if (method === OID.caIssuers) access.caIssuers.push(latin1Decode(location.content));
      }
      cert.ext.authorityInfoAccess = access;
      break;
    }
    case OID.certificatePolicies:
      cert.ext.certificatePolicies = (node.children || []).map((policy) => policy.child(0).oid());
      break;
    case OID.qcStatements:
      cert.ext.qcStatements = (node.children || []).map((statement) => statement.child(0).oid());
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------------------------------------
// verification and chains

/** Does `issuerCert`'s key verify the signature on `cert`? -> { ok: true | false | null, reason?, unsupported? } */
export async function verifyCertificateSignature(cert, issuerCert) {
  // a signature is a whole number of octets, and the algorithm named inside the signed part must be the one
  // named outside of it (RFC 5280 4.1.1.2)
  if (cert.signatureUnusedBits) return { ok: false, reason: "unused-bits" };
  if (cert.tbsSignatureAlgorithmOid !== cert.signatureAlgorithm.oid) return { ok: false, reason: "algorithm-mismatch" };
  return verifySignature(cert.signatureAlgorithm, issuerCert.spki, cert.signature, cert.tbs);
}

/** Could `candidate` be the issuer of `cert`, judging by names and key identifiers (no cryptography)? */
export function looksLikeIssuer(cert, candidate) {
  if (!namesEqual(cert.issuer, candidate.subject)) return false;
  const authority = cert.ext.authorityKeyIdentifier;
  const subjectKey = candidate.ext.subjectKeyIdentifier;
  if (authority && authority.keyIdentifier && subjectKey && !equalBytes(authority.keyIdentifier, subjectKey)) return false;
  return true;
}

/**
 * Orders certificates leaf -> root starting from `leaf`, using issuer / subject names and key identifiers
 * and checking every link with the signature (file order is ignored). This is the chain for DISPLAY and for
 * the certificate set of a signature, not a statement of trust (that is findTrustPath):
 *  - an issuer whose signature on the certificate verifies is preferred;
 *  - an issuer that only LOOKS right (name and key identifier) while the signature cannot be checked here
 *    (unsupported hash, curve or algorithm) is still listed, with signatureOk null on its link;
 *  - when the names match but the signature is wrong, the link is reported with signatureOk false and the
 *    chain stops.
 * -> { chain: parsedCert[], extras: parsedCert[],
 *      links: [{ subject, issuer, signatureOk: true | false | null, selfSigned? }]
 *              selfSigned marks the link of a certificate to itself (issuer = subject); whether that
 *              signature verified is signatureOk, as for every other link,
 *      complete: boolean  the chain ends with a self-issued certificate AND every link, that last one
 *              included, was verified (signatureOk true). One link that could not be checked makes it false. }
 */
export async function orderChain(leaf, others) {
  const pool = others.filter((cert) => !equalBytes(cert.der, leaf.der));
  const chain = [leaf];
  const links = [];
  let current = leaf;
  let endsAtRoot = false;
  for (let guard = 0; guard < 32; guard++) {
    let brokenSelfSignature = false;
    if (current.selfIssued) {
      const self = await verifyCertificateSignature(current, current);
      if (self.ok !== false) {
        links.push({ subject: current.subject.text, issuer: current.subject.text, signatureOk: self.ok, selfSigned: true });
        endsAtRoot = true;
        break;
      }
      brokenSelfSignature = true; // issuer == subject but its own key does not verify it: look for another issuer
    }
    const candidates = pool.filter((cert) => !chain.includes(cert) && looksLikeIssuer(current, cert));
    if (!candidates.length) {
      if (brokenSelfSignature) links.push({ subject: current.subject.text, issuer: current.subject.text, signatureOk: false, selfSigned: true });
      break;
    }
    let chosen = null;
    let verdict = null;
    for (const candidate of candidates) {
      const result = await verifyCertificateSignature(current, candidate);
      if (result.ok === true) {
        chosen = candidate;
        verdict = true;
        break;
      }
      if (result.ok === null && !chosen) {
        chosen = candidate;
        verdict = null;
      }
    }
    if (!chosen) {
      // names match but no candidate's key verifies the signature: report the broken link and stop
      links.push({ subject: current.subject.text, issuer: candidates[0].subject.text, signatureOk: false });
      break;
    }
    links.push({ subject: current.subject.text, issuer: chosen.subject.text, signatureOk: verdict });
    chain.push(chosen);
    current = chosen;
  }
  const extras = pool.filter((cert) => !chain.includes(cert));
  // "could not be checked" is not "checked": a chain with such a link is not complete
  const complete = endsAtRoot && links.every((link) => link.signatureOk === true);
  return { chain, complete, extras, links };
}

// ------------------------------------------------------------------------------------------------
// certification path to a trusted certificate

/** The label reports use for a certificate: first common name, else organisation, else the whole name. */
export const commonNameOf = (name) => (name.fields.CN || name.fields.O || [name.text])[0];

// Bounds of the path search: a hostile container may hold hundreds of certificates that all name each other.
const MAX_PATH_CERTIFICATES = 12; // the signer and its issuers below the trusted certificate
const MAX_PATH_SIGNATURE_CHECKS = 64;
const MAX_PATH_STEPS = 256;

// Extensions that the path check evaluates itself (basic constraints, key usage) or that restrict nothing in
// it. Any OTHER extension marked critical makes a path fail (RFC 5280 4.2): name constraints (2.5.29.30),
// policy constraints (.36), policy mappings (.33) and inhibit-any-policy (.54) are left out on purpose,
// because nothing here evaluates them. Certificate policies count as understood: every policy is accepted,
// which is what a validator without a required policy does as long as no policy constraint is in force.
const UNDERSTOOD_EXTENSIONS = new Set([
  "2.5.29.9", // subjectDirectoryAttributes
  OID.subjectKeyIdentifier,
  OID.keyUsage,
  OID.subjectAltName,
  "2.5.29.18", // issuerAltName
  OID.basicConstraints,
  OID.crlDistributionPoints,
  OID.certificatePolicies,
  OID.authorityKeyIdentifier,
  OID.extKeyUsage,
  "2.5.29.46", // freshestCRL
  OID.authorityInfoAccess,
  OID.qcStatements,
  "1.3.6.1.5.5.7.1.11" // subjectInfoAccess
]);

const hasCriticalExtensionNotUnderstood = (cert) => cert.extensions.some((extension) => extension.critical && (extension.unreadable || !UNDERSTOOD_EXTENSIONS.has(extension.oid)));

/**
 * Why `issuer` may not have issued a certificate that has `authoritiesBelow` authority certificates (not
 * counting self-issued ones) between itself and the signer: a list of reasons, empty when it may.
 * A trusted certificate of X.509 version 1 or 2 cannot carry the CA flag and is taken as an authority (old
 * roots); every other issuer needs basicConstraints CA.
 */
function issuerFailures(issuer, authoritiesBelow, isAnchor) {
  const reasons = [];
  const constraints = issuer.ext.basicConstraints;
  const isAuthority = Boolean(constraints && constraints.ca === true) || (isAnchor && issuer.version < 3);
  if (!isAuthority) reasons.push(isAnchor ? "anchor-not-a-ca" : "not-a-ca");
  if (issuer.ext.keyUsage && !issuer.ext.keyUsage.usages.includes("keyCertSign")) reasons.push("no-certificate-signing-usage");
  if (constraints && constraints.pathLen !== null && authoritiesBelow > constraints.pathLen) reasons.push("path-length-exceeded");
  return reasons;
}

/** One candidate path (signer first, the anchor not included) judged at `when`. -> { anchor, path, failures } */
function judgePath(path, anchor, unverifiedLinks, when) {
  const failures = [...unverifiedLinks];
  const note = (reason, cert) => failures.push({ reason, commonName: commonNameOf(cert.subject) });
  let authoritiesBelow = 0;
  path.forEach((cert, index) => {
    if (validityAt(cert, when) !== "valid") note("not-valid-at-time", cert);
    if (hasCriticalExtensionNotUnderstood(cert)) note("unsupported-critical-extension", cert);
    if (index > 0) {
      for (const reason of issuerFailures(cert, authoritiesBelow, false)) note(reason, cert);
      if (!cert.selfIssued) authoritiesBelow++;
    }
  });
  if (validityAt(anchor, when) !== "valid") note("anchor-not-valid-at-time", anchor);
  if (path.length) {
    // the trusted certificate acts as an issuer here (when it IS the signer certificate it issues nothing)
    if (hasCriticalExtensionNotUnderstood(anchor)) note("unsupported-critical-extension", anchor);
    for (const reason of issuerFailures(anchor, authoritiesBelow, true)) note(reason, anchor);
  }
  return { anchor, path, failures };
}

const hasUnverifiedLink = (candidate) => candidate.failures.some((failure) => failure.reason === "link-not-verified");
const candidateRank = (candidate) => (hasUnverifiedLink(candidate) ? 1000 : 0) + candidate.failures.length;

/**
 * Looks for a certification path from `signer` to one of `trustedCertificates`, through `others` (the
 * certificates that travel with the signature, in any order), valid at the instant `when`.
 *
 * A path is accepted only when
 *  - EVERY link, from the signer certificate up to the trusted one, verified cryptographically
 *    (verifyCertificateSignature gave ok === true). A link that fails, or that cannot be checked here because
 *    the platform lacks the hash, curve or algorithm, is never part of an accepted path: a certificate that
 *    merely NAMES a trusted authority as its issuer proves nothing;
 *  - every certificate of it was valid at `when` and carries no critical extension this module does not
 *    understand;
 *  - every certificate that acts as an issuer is an authority (basicConstraints CA; a trusted version 1 / 2
 *    certificate is taken as one), may sign certificates (keyUsage, when present, has keyCertSign) and its
 *    path length constraint holds.
 * A signer certificate that IS one of the trusted certificates (the same bytes) is accepted as it is.
 * Revocation is not checked; name and policy constraints are not evaluated (critical ones fail the path).
 *
 * Several issuers can match one certificate (a renewed authority has two certificates with one name and
 * key): the search tries them all, verified links first, within fixed bounds.
 *
 * @returns {Promise<{ trusted: boolean, anchor: object | null, path: object[] | null,
 *                     failures: { reason: string, commonName: string }[] }>}
 *   trusted true:  anchor = the trusted certificate, path = signer ... the certificate the anchor issued
 *                  (empty when the signer certificate itself is trusted), failures = [].
 *   trusted false: the best rejected candidate, or anchor null / path null / failures [] when not even the
 *                  names lead to a trusted certificate. failures[].reason: "link-not-verified" (commonName =
 *                  the certificate whose signature was not verified) | "not-valid-at-time" | "not-a-ca" |
 *                  "anchor-not-a-ca" | "no-certificate-signing-usage" | "path-length-exceeded" |
 *                  "unsupported-critical-extension" | "anchor-not-valid-at-time".
 */
export async function findTrustPath(signer, others, trustedCertificates, when) {
  const nothing = { trusted: false, anchor: null, path: null, failures: [] };
  if (!trustedCertificates || !trustedCertificates.length) return nothing;
  const same = (a, b) => a === b || equalBytes(a.der, b.der);
  const pool = (others || []).filter((cert) => !same(cert, signer));
  const verdicts = new Map();
  let checks = 0;
  let steps = 0;
  /** true | false | null (also null when the budget of signature checks is used up: not verified) */
  const linkVerified = async (cert, issuer) => {
    let known = verdicts.get(cert);
    if (!known) {
      known = new Map();
      verdicts.set(cert, known);
    }
    if (!known.has(issuer)) {
      if (checks >= MAX_PATH_SIGNATURE_CHECKS) return null;
      checks++;
      known.set(issuer, (await verifyCertificateSignature(cert, issuer)).ok);
    }
    return known.get(issuer);
  };
  let rejected = null;
  const reject = (candidate) => {
    if (!rejected || candidateRank(candidate) < candidateRank(rejected)) rejected = candidate;
  };

  // depth first. `path` = signer ... current; `unverifiedLinks` = the links crossed although their signature
  // was not verified: such a walk can only end in a REJECTED candidate, it is followed for the report alone
  // (second pass below), so that it can never use up the bounds an honest path needs.
  const walk = async (path, unverifiedLinks, followUnverified) => {
    if (++steps > MAX_PATH_STEPS) return null;
    const current = path[path.length - 1];
    const itself = trustedCertificates.find((trusted) => same(trusted, current));
    if (itself) {
      const candidate = judgePath(path.slice(0, -1), itself, unverifiedLinks, when);
      if (!candidate.failures.length) return candidate;
      reject(candidate);
    }
    const issuers = [];
    for (const trusted of trustedCertificates) {
      if (!same(trusted, current) && looksLikeIssuer(current, trusted)) issuers.push({ certificate: trusted, isAnchor: true });
    }
    if (path.length < MAX_PATH_CERTIFICATES) {
      for (const cert of pool) {
        if (!path.some((member) => same(member, cert)) && looksLikeIssuer(current, cert)) issuers.push({ certificate: cert, isAnchor: false });
      }
    }
    for (const issuer of issuers) issuer.verified = (await linkVerified(current, issuer.certificate)) === true;
    for (const wanted of followUnverified ? [true, false] : [true]) {
      for (const issuer of issuers) {
        if (issuer.verified !== wanted) continue;
        const crossed = issuer.verified ? unverifiedLinks : [...unverifiedLinks, { reason: "link-not-verified", commonName: commonNameOf(current.subject) }];
        if (issuer.isAnchor) {
          const candidate = judgePath(path, issuer.certificate, crossed, when);
          if (!candidate.failures.length) return candidate;
          reject(candidate);
        } else {
          const found = await walk([...path, issuer.certificate], crossed, followUnverified);
          if (found) return found;
        }
      }
    }
    return null;
  };

  // 1. verified links only: the one pass that can find a trusted path
  let found = await walk([signer], [], false);
  if (!found && !(rejected && !hasUnverifiedLink(rejected))) {
    // 2. for the report: where do the NAMES lead, across links that failed or could not be checked? Whatever
    //    this pass reaches carries a "link-not-verified" failure and is therefore never accepted.
    steps = 0;
    found = await walk([signer], [], true);
  }
  if (found) return { trusted: true, anchor: found.anchor, path: found.path, failures: [] };
  if (rejected) return { trusted: false, anchor: rejected.anchor, path: rejected.path, failures: rejected.failures };
  return nothing;
}

// ------------------------------------------------------------------------------------------------
// facts for the interface

function pick(name, label) {
  const values = name.fields[label];
  return values && values.length ? values.join(" / ") : null;
}

function nameFacts(name) {
  return {
    commonName: pick(name, "CN"),
    organization: pick(name, "O"),
    organizationalUnit: pick(name, "OU"),
    country: pick(name, "C"),
    locality: pick(name, "L"),
    state: pick(name, "ST"),
    email: pick(name, "emailAddress") || pick(name, "mail"),
    serialNumber: pick(name, "serialNumber"),
    uid: pick(name, "UID"),
    title: pick(name, "title"),
    text: name.text,
    attributes: name.attributes.map(({ oid, type, value, stringType }) => ({ oid, type, value, stringType })),
    identifiers: vietnameseIdentifiers(name)
  };
}

const colonHex = (bytes) => toHex(bytes).toUpperCase().replace(/(..)(?=.)/g, "$1:");

/** Validity of a certificate at an instant: "valid" | "expired" | "notYetValid". */
export function validityAt(cert, when) {
  const time = when.getTime();
  if (time < cert.notBefore.getTime()) return "notYetValid";
  if (time > cert.notAfter.getTime()) return "expired";
  return "valid";
}

const DOCUMENT_SIGNING_EKUS = ["emailProtection", "codeSigning", "anyExtendedKeyUsage", "documentSigning", "msDocumentSigning", "adobeAuthenticDocumentsTrust"];
const isoOrNull = (date) => (Number.isNaN(date.getTime()) ? null : date.toISOString());

/**
 * Everything the interface shows about one certificate.
 * @param {Uint8Array|object} input   DER / PEM bytes, or a parseCertificate() result
 * @param {{ now?: Date, role?: "signer" | "ca" | "timestamp-authority" }} [options]
 *        now: the instant of the validity status; role: suitability for signing documents is judged for
 *        "signer" only (default: "ca" for a CA certificate, "signer" otherwise)
 * @returns facts; `warnings` = [{ code, params }] with the CERT_ codes of ./codes.js
 */
export async function certificateFacts(input, options = {}) {
  const cert = input && input.tbs && input.subject ? input : parseCertificate(input);
  const now = options.now || new Date();
  const status = validityAt(cert, now);
  const key = cert.publicKey;
  const keyUsage = cert.ext.keyUsage ? cert.ext.keyUsage.usages : null;
  const extKeyUsage = cert.ext.extKeyUsage ? cert.ext.extKeyUsage.usages : null;
  // selfIssued: issuer = subject. selfSigned: its own key ALSO verifies its signature; a signature that could
  // not be checked here (selfSignatureCheck null) does not make a certificate self-signed.
  let selfSigned = false;
  let selfSignatureCheck = null;
  if (cert.selfIssued) {
    const result = await verifyCertificateSignature(cert, cert);
    selfSignatureCheck = result.ok;
    selfSigned = result.ok === true;
  }
  const warnings = [];
  if (status === "expired") warnings.push(warning("CERT_EXPIRED", { notAfter: isoOrNull(cert.notAfter) }));
  if (status === "notYetValid") warnings.push(warning("CERT_NOT_YET_VALID", { notBefore: isoOrNull(cert.notBefore) }));
  const isCa = Boolean(cert.ext.basicConstraints && cert.ext.basicConstraints.ca);
  const role = options.role || (isCa ? "ca" : "signer");
  if (role === "signer") {
    if (keyUsage && !keyUsage.includes("digitalSignature") && !keyUsage.includes("nonRepudiation")) {
      warnings.push(warning("CERT_KEY_USAGE_NO_SIGNING"));
    } else if (keyUsage && !keyUsage.includes("nonRepudiation")) {
      warnings.push(warning("CERT_KEY_USAGE_NO_NON_REPUDIATION"));
    }
    if (extKeyUsage && !extKeyUsage.some((usage) => DOCUMENT_SIGNING_EKUS.includes(usage))) warnings.push(warning("CERT_EKU_NOT_FOR_SIGNING"));
    if (isCa && !cert.selfIssued) warnings.push(warning("CERT_IS_CA"));
  }
  if (key.keyType === "RSA" && key.bits < 2048) warnings.push(warning("CERT_WEAK_KEY", { bits: key.bits }));
  if (cert.signatureAlgorithm.weak) warnings.push(warning("CERT_WEAK_SIGNATURE_ALGORITHM", { algorithm: cert.signatureAlgorithm.name }));
  const sha256 = await digest("SHA-256", cert.der);
  const sha1 = await digest("SHA-1", cert.der);
  let keyDescription = `${key.keyType} ${key.bits}`;
  if (key.keyType === "EC") keyDescription = `ECDSA ${key.curve}`;
  if (key.keyType === "Ed25519" || key.keyType === "Ed448") keyDescription = key.keyType;
  return {
    subject: nameFacts(cert.subject),
    issuer: nameFacts(cert.issuer),
    displayName: pick(cert.subject, "CN") || pick(cert.subject, "O") || pick(cert.subject, "emailAddress") || cert.subject.text,
    issuerDisplayName: pick(cert.issuer, "CN") || pick(cert.issuer, "O") || cert.issuer.text,
    serialNumber: cert.serialNumber.toUpperCase(),
    serialNumberDecimal: BigInt(`0x${cert.serialNumber || "0"}`).toString(10),
    version: cert.version,
    notBefore: isoOrNull(cert.notBefore),
    notAfter: isoOrNull(cert.notAfter),
    validity: status,
    daysRemaining: Math.floor((cert.notAfter.getTime() - now.getTime()) / 86400000),
    publicKey: { type: key.keyType, bits: key.bits, curve: key.curve, description: keyDescription, usableInWebCrypto: key.webCrypto },
    signatureAlgorithm: { name: cert.signatureAlgorithm.name, oid: cert.signatureAlgorithm.oid, hash: cert.signatureAlgorithm.hash, weak: cert.signatureAlgorithm.weak },
    keyUsage,
    keyUsageCritical: cert.ext.keyUsage ? cert.ext.keyUsage.critical : null,
    extendedKeyUsage: extKeyUsage,
    basicConstraints: cert.ext.basicConstraints || null,
    isCa,
    selfIssued: cert.selfIssued,
    selfSigned,
    selfSignatureCheck,
    subjectKeyIdentifier: cert.ext.subjectKeyIdentifier ? toHex(cert.ext.subjectKeyIdentifier) : null,
    authorityKeyIdentifier: cert.ext.authorityKeyIdentifier && cert.ext.authorityKeyIdentifier.keyIdentifier ? toHex(cert.ext.authorityKeyIdentifier.keyIdentifier) : null,
    subjectAltNames: cert.ext.subjectAltName || null,
    crlUrls: cert.ext.crlUrls || [],
    ocspUrls: cert.ext.authorityInfoAccess ? cert.ext.authorityInfoAccess.ocsp : [],
    caIssuerUrls: cert.ext.authorityInfoAccess ? cert.ext.authorityInfoAccess.caIssuers : [],
    certificatePolicies: cert.ext.certificatePolicies || [],
    hasQcStatements: Boolean(cert.ext.qcStatements),
    fingerprintSha256: colonHex(sha256),
    fingerprintSha1: colonHex(sha1),
    canSignDocuments: !keyUsage || keyUsage.includes("digitalSignature") || keyUsage.includes("nonRepudiation"),
    warnings
  };
}
