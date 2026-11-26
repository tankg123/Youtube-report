// The ONE CMS module (RFC 5652): building the detached SignedData of a PDF signature and reading /
// verifying the SignedData and RFC 3161 timestamp tokens found in a PDF. Browser + Node, WebCrypto only.
//
// Builder (PAdES baseline B-B, and adbe.pkcs7.detached for old readers):
//   ContentInfo { signedData, SignedData v1 { digestAlgorithms { sha256, NULL }, encapContentInfo { data } (detached),
//     certificates [0] (signer + chain, DER SET OF order), signerInfos { v1, issuerAndSerialNumber, sha256,
//     signedAttrs [0], signatureAlgorithm, signature, [unsignedAttrs [1] { signature-time-stamp }] } } }
//   Signed attributes, DER SET OF order: content-type = data, message-digest = SHA-256 of the byte ranges,
//   signing-certificate-v2 (SHA-256 of the certificate, issuerSerial present); adbe.pkcs7.detached adds
//   signing-time (PAdES forbids it: the claimed time is /M).
//   RSA: rsaEncryption with NULL parameters, PKCS#1 v1.5, 2048 bits or more. ECDSA: ecdsa-with-SHA256, r||s of
//   WebCrypto converted to DER (P-256, P-384, P-521). The value is verified with the certificate's public key
//   before anything is returned.
//   No node-forge: its pkcs7 knows three attributes, does not sort the SET OF and signs synchronously with its
//   own RSA key object, so neither signing-certificate-v2, nor ECDSA, nor a non-extractable CryptoKey fit.
//
// Reader: DER and BER (indefinite lengths, chunked octet strings). The bytes that were signed are always cut
// from the original encoding. Findings are codes (./codes.js), never sentences.

import { PdfEditorError, isPdfEditorError } from "../errors.js";
import { asn1Error, decode, der, hasIndefiniteLength, sortSetOf, TAG, tlv, toDer } from "./asn1.js";
import { concatBytes, equalBytes, randomBytes, stripLeadingZeros, toHex } from "./bytes.js";
import { problem } from "./codes.js";
import { CMS_ATTRIBUTE_NAMES, CURVES, DIGESTS, OID } from "./oids.js";
import { digest, ecdsaP1363ToDer, resolveSignatureAlgorithm, signData, verifySignature } from "./sigverify.js";
import { namesEqual, parseCertificate, parseName } from "./x509.js";

export const SUBFILTER_PADES = "ETSI.CAdES.detached";
export const SUBFILTER_PKCS7 = "adbe.pkcs7.detached";

const badSigner = (reason, detail, cause) => new PdfEditorError("SIGN_BAD_SIGNER", { reason }, { detail, cause });
const badTimestamp = (reason, detail, cause) => new PdfEditorError("SIGN_BAD_TIMESTAMP", { reason }, { detail, cause });

// =================================================================================================
// building
// =================================================================================================

// SHA-256 AlgorithmIdentifier with NULL parameters. RFC 5754 section 2 prefers absent parameters and obliges
// every implementation to accept both forms; NULL is what Acrobat, iText and pyHanko write (21 of 27
// real-world PDF signatures surveyed), so it is the form every PDF validator has seen.
const sha256AlgorithmIdentifier = () => der.seq(der.oid(OID.sha256), der.nul());

/**
 * Normalises and checks a signer description.
 * @param {{ certificate: Uint8Array, chain?: Uint8Array[], privateKey?: CryptoKey, sign?: Function }} signer
 * @returns {{ cert: object, chain: Uint8Array[], mechanism: object }} chain = the other certificates (DER,
 *          without the signer certificate and without duplicates)
 */
export function describeSigner(signer) {
  if (!signer || !(signer.certificate instanceof Uint8Array)) throw badSigner("certificate", "signer.certificate (DER, Uint8Array) is required");
  if (!signer.privateKey && typeof signer.sign !== "function") throw badSigner("private-key", "signer.privateKey (CryptoKey) is required");
  let cert;
  try {
    cert = parseCertificate(signer.certificate);
  } catch (error) {
    throw badSigner("certificate", "signer.certificate is not an X.509 certificate", error);
  }
  const chain = [];
  for (const entry of signer.chain || []) {
    let parsed;
    try {
      parsed = parseCertificate(entry);
    } catch (error) {
      throw badSigner("chain", "signer.chain holds something that is not an X.509 certificate", error);
    }
    if (equalBytes(parsed.der, cert.der) || chain.some((other) => equalBytes(other, parsed.der))) continue;
    chain.push(parsed.der);
  }
  const key = cert.publicKey;
  let mechanism;
  if (key.keyType === "RSA") {
    if (key.bits < 2048) throw new PdfEditorError("SIGN_WEAK_KEY", { bits: key.bits }, { detail: `RSA key of ${key.bits} bits is too short (2048 bits or more required)` });
    mechanism = {
      type: "RSA",
      // RFC 5754 3.2: rsaEncryption is the identifier every CMS implementation MUST accept for PKCS#1 v1.5
      // signatures; the parameters are NULL
      signatureAlgorithm: der.seq(der.oid(OID.rsaEncryption), der.nul()),
      maxSignatureBytes: stripLeadingZeros(key.rsaModulus).length,
      keyLabel: `RSA ${key.bits}`,
      verify: { oid: OID.rsaEncryption, name: "rsaEncryption with SHA-256", scheme: "rsa-pkcs1", hash: "SHA-256", weak: false }
    };
  } else if (key.keyType === "EC") {
    const curve = CURVES[key.curveOid];
    if (!curve || !curve.webCrypto) throw new PdfEditorError("SIGN_UNSUPPORTED_KEY", { keyType: "EC", curve: key.curve }, { detail: "EC curve outside P-256, P-384, P-521" });
    const size = curve.bytes;
    mechanism = {
      type: "ECDSA",
      // RFC 5754 3.3: ecdsa-with-SHA256, parameters ABSENT
      signatureAlgorithm: der.seq(der.oid(OID.ecdsaWithSHA256)),
      coordinateBytes: size,
      curve: curve.name,
      // SEQUENCE { INTEGER r, INTEGER s }, each INTEGER at most size + 1 content bytes
      maxSignatureBytes: tlv(0x30, new Uint8Array(2 * (2 + size + 1))).length,
      keyLabel: `ECDSA ${curve.name}`,
      verify: { oid: OID.ecdsaWithSHA256, name: "ecdsa-with-SHA256", scheme: "ecdsa", hash: "SHA-256", weak: false }
    };
  } else {
    throw new PdfEditorError("SIGN_UNSUPPORTED_KEY", { keyType: key.keyType, curve: null }, { detail: "RSA (PKCS#1 v1.5) and ECDSA P-256 / P-384 / P-521 only" });
  }
  if (signer.privateKey) {
    const handle = signer.privateKey;
    const algorithm = handle.algorithm || {};
    if (handle.type !== "private" || !Array.isArray(handle.usages) || !handle.usages.includes("sign")) {
      throw badSigner("private-key", "signer.privateKey must be a private CryptoKey with the \"sign\" usage");
    }
    if (mechanism.type === "RSA") {
      if (algorithm.name !== "RSASSA-PKCS1-v1_5" || !algorithm.hash || algorithm.hash.name !== "SHA-256") {
        throw badSigner("key-algorithm", "an RSA CryptoKey must be imported as RSASSA-PKCS1-v1_5 with SHA-256");
      }
    } else if (algorithm.name !== "ECDSA" || algorithm.namedCurve !== mechanism.curve) {
      throw badSigner("key-algorithm", `an EC CryptoKey must be ECDSA ${mechanism.curve}`);
    }
  }
  return { cert, chain, mechanism };
}

const attribute = (typeOid, ...values) => der.seq(der.oid(typeOid), der.set(...values));

/**
 * ESS signing-certificate-v2 (RFC 5035): SHA-256 hash of the signer certificate (the hashAlgorithm field is
 * omitted because SHA-256 is its DEFAULT, as DER requires) plus the IssuerSerial hint.
 */
export function signingCertificateV2(cert, certHash) {
  const issuerSerial = der.seq(
    der.seq(der.ctx(4, cert.issuer.der)), // GeneralNames { directoryName [4] EXPLICIT Name }
    cert.serialNumberTlv
  );
  const essCertIdV2 = der.seq(der.octets(certHash), issuerSerial);
  return der.seq(der.seq(essCertIdV2));
}

/**
 * The signed attributes as a DER SET OF (sorted). The bytes that get signed are `setDer` (tag 0x31); the
 * same content goes into the SignerInfo under [0] IMPLICIT (`implicitDer`, tag 0xA0).
 */
export async function buildSignedAttributes({ documentDigest, cert, subFilter = SUBFILTER_PADES, signingTime }) {
  if (!(documentDigest instanceof Uint8Array) || documentDigest.length !== 32) {
    throw new PdfEditorError("SIGN_INTERNAL", { check: "document-digest" }, { detail: "documentDigest must be the 32-byte SHA-256 of the signed byte ranges" });
  }
  const attributes = [
    attribute(OID.contentType, der.oid(OID.data)),
    attribute(OID.messageDigest, der.octets(documentDigest)),
    attribute(OID.signingCertificateV2, signingCertificateV2(cert, await digest("SHA-256", cert.der)))
  ];
  if (subFilter === SUBFILTER_PKCS7) {
    // PAdES forbids the signing-time attribute (the claimed time is /M); the legacy subfilter carries it
    if (!(signingTime instanceof Date) || Number.isNaN(signingTime.getTime())) {
      throw new PdfEditorError("SIGN_BAD_OPTIONS", { option: "signingTime" }, { detail: "signingTime (Date) is required for adbe.pkcs7.detached" });
    }
    attributes.push(attribute(OID.signingTime, der.time(signingTime)));
  } else if (subFilter !== SUBFILTER_PADES) {
    throw new PdfEditorError("SIGN_BAD_SUBFILTER", { subFilter: String(subFilter) });
  }
  const sorted = sortSetOf(attributes);
  return { setDer: tlv(0x31, sorted), implicitDer: tlv(0xa0, sorted), count: sorted.length };
}

export function assembleSignedData({ cert, chain, signedAttrsImplicit, mechanism, signatureValue, timestampToken }) {
  const signerInfo = [
    der.int(1), // version 1: sid is issuerAndSerialNumber
    der.seq(cert.issuer.der, cert.serialNumberTlv),
    sha256AlgorithmIdentifier(),
    signedAttrsImplicit,
    mechanism.signatureAlgorithm,
    der.octets(signatureValue)
  ];
  if (timestampToken) signerInfo.push(der.ctx(1, attribute(OID.signatureTimeStampToken, timestampToken)));
  const signedData = der.seq(
    der.int(1),
    der.set(sha256AlgorithmIdentifier()),
    der.seq(der.oid(OID.data)), // detached: no eContent
    // CertificateSet is a SET OF: DER orders it by encoding (as pyHanko, OpenSSL and iText write it). The
    // signer certificate is found through the SignerInfo, not through its position.
    der.ctx(0, sortSetOf([cert.der, ...chain])),
    der.set(der.seq(...signerInfo))
  );
  return der.seq(der.oid(OID.signedData), der.ctx(0, signedData));
}

/**
 * Exact upper bound of the CMS size for this signer: the real structure with a signature value of the
 * maximum length (RSA: modulus length, always exact; ECDSA: at most 6 bytes more than the real one).
 * `timestampTokenBytes` adds room for an RFC 3161 token of that size.
 */
export async function estimateCmsSize({ signer, subFilter = SUBFILTER_PADES, signingTime = new Date(), timestampTokenBytes = 0 }) {
  const { cert, chain, mechanism } = describeSigner(signer);
  const attributes = await buildSignedAttributes({ documentDigest: new Uint8Array(32), cert, subFilter, signingTime });
  // ECDSA: r and s with the sign octet, the longest DER form
  const dummySignature = mechanism.type === "ECDSA"
    ? ecdsaP1363ToDer(new Uint8Array(2 * mechanism.coordinateBytes).fill(0xff))
    : new Uint8Array(mechanism.maxSignatureBytes);
  const timestampToken = timestampTokenBytes > 0 ? tlv(0x30, new Uint8Array(Math.max(0, timestampTokenBytes - 4))) : null;
  return assembleSignedData({ cert, chain, signedAttrsImplicit: attributes.implicitDer, mechanism, signatureValue: dummySignature, timestampToken }).length;
}

async function rawSign(signer, mechanism, data) {
  if (typeof signer.sign !== "function") return signData(signer.privateKey, "SHA-256", data);
  // a custom signer (token, remote service): RSA = the PKCS#1 v1.5 block, ECDSA = r||s or DER
  const answer = await signer.sign(data, { hash: "SHA-256", mechanism: mechanism.type });
  const signature = answer instanceof Uint8Array ? answer : new Uint8Array(answer);
  if (mechanism.type !== "ECDSA") return signature;
  const looksDer = signature[0] === 0x30 && signature.length !== 2 * mechanism.coordinateBytes;
  return looksDer ? signature : ecdsaP1363ToDer(signature);
}

/**
 * Builds the detached CMS for a PDF signature.
 * @param {object} p
 * @param {Uint8Array} p.documentDigest  SHA-256 of the bytes selected by /ByteRange
 * @param {object} p.signer              { certificate, chain?, privateKey }
 * @param {string} [p.subFilter]         "ETSI.CAdES.detached" (default) or "adbe.pkcs7.detached"
 * @param {Date} [p.signingTime]         signing-time attribute (adbe.pkcs7.detached only)
 * @param {{ request: (tsq: Uint8Array) => Promise<Uint8Array> }} [p.timestamp]  RFC 3161 client hook
 * @returns {Promise<{ der, signatureValue, signedAttributes, timestampToken, timestampInfo, mechanism, certificateCount }>}
 * @throws SIGN_KEY_MISMATCH when the value does not verify with the certificate (wrong key for it)
 */
export async function createCms({ documentDigest, signer, subFilter = SUBFILTER_PADES, signingTime = new Date(), timestamp = null }) {
  const { cert, chain, mechanism } = describeSigner(signer);
  const attributes = await buildSignedAttributes({ documentDigest, cert, subFilter, signingTime });
  const signatureValue = await rawSign(signer, mechanism, attributes.setDer);
  if (!(signatureValue instanceof Uint8Array) || signatureValue.length === 0 || signatureValue.length > mechanism.maxSignatureBytes) {
    throw badSigner("signature", `a signature of ${signatureValue && signatureValue.length} bytes does not fit ${mechanism.keyLabel}`);
  }
  // verified with the public key of the certificate before anything is returned
  const check = await verifySignature(mechanism.verify, cert.spki, signatureValue, attributes.setDer);
  if (check.ok !== true) {
    throw new PdfEditorError("SIGN_KEY_MISMATCH", {}, { detail: "the private key does not belong to the signer certificate (the signature does not verify)" });
  }
  let timestampToken = null;
  let timestampInfo = null;
  if (timestamp) {
    const answer = await requestTimestamp(signatureValue, timestamp);
    timestampToken = answer.token;
    timestampInfo = answer.info;
  }
  const cms = assembleSignedData({ cert, chain, signedAttrsImplicit: attributes.implicitDer, mechanism, signatureValue, timestampToken });
  return { der: cms, signatureValue, signedAttributes: attributes.setDer, timestampToken, timestampInfo, mechanism: mechanism.keyLabel, certificateCount: 1 + chain.length };
}

// -------------------------------------------------------------------------------------------------
// RFC 3161 (only behind an injected timestamp.request: the editor itself makes no network request)
// -------------------------------------------------------------------------------------------------

/** TimeStampReq for a SHA-256 imprint, with a nonce and certReq TRUE (the TSA certificate must be in the token). */
export function buildTimeStampRequest(imprint, { nonce, policyOid } = {}) {
  return der.seq(
    der.int(1),
    der.seq(der.seq(der.oid(OID.sha256), der.nul()), der.octets(imprint)), // as "openssl ts -query -sha256" writes it
    policyOid ? der.oid(policyOid) : null,
    nonce ? der.intFromBytes(nonce) : null,
    der.bool(true)
  );
}

/** Reads what the signer has to check in a TimeStampToken (ContentInfo): imprint, nonce, genTime. */
export function parseTimeStampToken(token) {
  try {
    const contentInfo = decode(token);
    if (contentInfo.child(0).oid() !== OID.signedData) throw badTimestamp("not-signed-data", "the timestamp token is not CMS SignedData");
    const signedData = contentInfo.child(1).child(0);
    const encap = signedData.child(2);
    const eContentType = encap.child(0).oid();
    if (eContentType !== OID.tstInfo || !encap.children[1]) throw badTimestamp("not-tstinfo", `the timestamp token content type is ${eContentType}`);
    // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber, genTime, accuracy?, ordering?, nonce?, tsa [0]?, extensions [1]? }
    const tst = decode(encap.children[1].child(0).octets());
    const messageImprint = tst.child(2);
    let nonce = null;
    for (const field of tst.children.slice(5)) {
      if (field.isUniversal(TAG.INTEGER)) nonce = field.integerBytes();
    }
    const genTime = tst.child(4).time();
    return {
      policy: tst.child(1).oid(),
      imprintAlgorithm: messageImprint.child(0).child(0).oid(),
      imprint: messageImprint.child(1).octets(),
      serialNumberHex: tst.child(3).integerHex(),
      genTime: Number.isNaN(genTime.getTime()) ? null : genTime,
      nonce
    };
  } catch (error) {
    if (isPdfEditorError(error) && error.code === "SIGN_BAD_TIMESTAMP") throw error;
    throw badTimestamp("malformed", "the timestamp token cannot be read", error);
  }
}

/** Parses a TimeStampResp, returns the token (ContentInfo bytes, copied verbatim) after checking it. */
export function parseTimeStampResponse(response, { imprint, nonce } = {}) {
  let top;
  let status;
  try {
    top = decode(response);
    if (!top.isSequence) throw asn1Error("unexpected-type", 0, "not a TimeStampResp");
    status = top.child(0).child(0).integerNumber();
  } catch (error) {
    throw badTimestamp("malformed", "the TSA answer is not a TimeStampResp", error);
  }
  if (status !== 0 && status !== 1) throw new PdfEditorError("SIGN_TIMESTAMP_REJECTED", { status }, { detail: `the TSA rejected the request (PKIStatus ${status})` });
  const tokenNode = top.children[1];
  if (!tokenNode) throw badTimestamp("no-token", "the TSA answer has no timeStampToken");
  const token = Uint8Array.from(tokenNode.raw);
  const info = parseTimeStampToken(token);
  if (info.imprintAlgorithm !== OID.sha256) throw badTimestamp("imprint-algorithm", `the token imprint uses ${info.imprintAlgorithm}, SHA-256 expected`);
  if (imprint && !equalBytes(info.imprint, imprint)) throw badTimestamp("imprint-mismatch", "the token does not cover the signature value");
  if (nonce && (!info.nonce || !equalBytes(stripLeadingZeros(info.nonce), stripLeadingZeros(nonce)))) throw badTimestamp("nonce-mismatch", "the token does not carry the nonce of the request");
  return { token, info };
}

/**
 * Signature timestamp (RFC 3161 appendix A / PAdES B-T): the imprint is the SHA-256 of the signature VALUE
 * (content octets of SignerInfo.signature).
 */
export async function requestTimestamp(signatureValue, timestamp) {
  if (!timestamp || typeof timestamp.request !== "function") throw badTimestamp("no-request-function", "timestamp.request(tsq) must be an async function returning the TSA answer bytes");
  const imprint = await digest("SHA-256", signatureValue);
  const nonce = randomBytes(8);
  nonce[0] = (nonce[0] & 0x7f) | 0x40; // positive, 8 significant bytes
  const request = buildTimeStampRequest(imprint, { nonce, policyOid: timestamp.policyOid });
  const answer = await timestamp.request(request);
  if (!answer) throw badTimestamp("no-answer", "timestamp.request returned nothing");
  return parseTimeStampResponse(answer instanceof Uint8Array ? answer : new Uint8Array(answer), { imprint, nonce });
}

/** Size of a token from this TSA, measured with a throw-away request (it depends on the TSA's certificates). */
export async function measureTimestampTokenSize(timestamp) {
  const { token } = await requestTimestamp(randomBytes(32), timestamp);
  return token.length;
}

// =================================================================================================
// reading and verifying
// =================================================================================================

const cmsUnreadable = (detail, cause) => new PdfEditorError("SIGN_CMS_UNREADABLE", {}, { detail, cause });

function readAttributes(setNode) {
  const map = new Map();
  if (!setNode || !setNode.children) return map;
  for (const entry of setNode.children) {
    if (!entry.children || entry.children.length < 2) continue;
    const oid = entry.children[0].oid();
    const values = entry.children[1].children || [];
    if (!map.has(oid)) map.set(oid, []);
    map.get(oid).push(...values);
  }
  return map;
}

/**
 * Parses a ContentInfo that holds SignedData. Bytes after the value (zero padding of PDF /Contents) are
 * ignored; `length` tells where the value ends. Throws SIGN_CMS_UNREADABLE.
 */
export function parseSignedData(bytes) {
  try {
    const root = decode(bytes);
    if (!root.isSequence) throw asn1Error("unexpected-type", 0, "ContentInfo is not a SEQUENCE");
    const contentType = root.child(0, "contentType").oid();
    if (contentType !== OID.signedData) throw cmsUnreadable(`the container is not CMS SignedData (content type ${contentType})`);
    const signedData = root.child(1, "content").child(0, "SignedData");
    const fields = [...(signedData.children || [])];
    const version = fields.shift().integerNumber();
    const digestAlgorithms = (fields.shift().children || []).map((algorithm) => algorithm.child(0).oid());
    const encap = fields.shift();
    const eContentType = encap.child(0).oid();
    const eContentWrapper = encap.children[1] || null;
    const eContent = eContentWrapper ? eContentWrapper.child(0).octets() : null;
    const certificates = [];
    const otherCertificates = [];
    let hasCrls = false;
    while (fields.length && !fields[0].isSet) {
      const field = fields.shift();
      if (field.isContext(0)) {
        for (const choice of field.children || []) {
          if (choice.isSequence) certificates.push(choice.raw);
          else otherCertificates.push(choice.tag);
        }
      } else if (field.isContext(1)) {
        hasCrls = (field.children || []).length > 0;
      }
    }
    const signerInfosNode = fields.shift();
    if (!signerInfosNode || !signerInfosNode.isSet) throw asn1Error("missing-element", signedData.start, "signerInfos missing");
    const signerInfos = signerInfosNode.children.map((signerInfo) => {
      const parts = [...signerInfo.children];
      const signerInfoVersion = parts.shift().integerNumber();
      const sidNode = parts.shift();
      const sid = sidNode.isContext(0)
        ? { subjectKeyIdentifier: sidNode.content }
        : { issuer: parseName(sidNode.child(0)), serialNumber: sidNode.child(1).integerHex() };
      const digestAlgorithmNode = parts.shift();
      let signedAttrsNode = null;
      if (parts[0] && parts[0].isContext(0)) signedAttrsNode = parts.shift();
      const signatureAlgorithmNode = parts.shift();
      const signature = parts.shift().octets();
      const unsignedAttrsNode = parts[0] && parts[0].isContext(1) ? parts.shift() : null;
      return {
        version: signerInfoVersion,
        sid,
        digestAlgorithmOid: digestAlgorithmNode.child(0).oid(),
        signedAttrsNode,
        signedAttrs: readAttributes(signedAttrsNode),
        signatureAlgorithmNode,
        signature,
        unsignedAttrs: readAttributes(unsignedAttrsNode)
      };
    });
    return {
      length: root.end - root.start,
      encoding: hasIndefiniteLength(root) ? "BER" : "DER",
      version,
      digestAlgorithms,
      eContentType,
      eContent,
      certificates,
      otherCertificates,
      hasCrls,
      signerInfos
    };
  } catch (error) {
    if (isPdfEditorError(error) && error.code === "SIGN_CMS_UNREADABLE") throw error;
    throw cmsUnreadable("malformed CMS SignedData", error);
  }
}

/** The certificate that the SignerInfo names, among the parsed certificates of the container. */
export function findSignerCertificate(signerInfo, parsedCertificates) {
  const { sid } = signerInfo;
  if (sid.subjectKeyIdentifier) {
    return parsedCertificates.find((cert) => cert.ext.subjectKeyIdentifier && equalBytes(cert.ext.subjectKeyIdentifier, sid.subjectKeyIdentifier)) || null;
  }
  const serial = sid.serialNumber.replace(/^0+(?=.)/, "");
  return parsedCertificates.find((cert) => cert.serialNumber.replace(/^0+(?=.)/, "") === serial && namesEqual(cert.issuer, sid.issuer)) || null;
}

const digestName = (oid) => (DIGESTS[oid] ? DIGESTS[oid].name : oid);

/** ESS signing-certificate attribute (v1 = SHA-1, v2 = any hash): does it name the signer certificate? */
async function checkSigningCertificateAttribute(signerInfo, signerCertificate) {
  const v2 = signerInfo.signedAttrs.get(OID.signingCertificateV2);
  const v1 = signerInfo.signedAttrs.get(OID.signingCertificate);
  const value = (v2 && v2[0]) || (v1 && v1[0]);
  if (!value) return null;
  const version = v2 && v2[0] ? 2 : 1;
  try {
    const essCertId = value.child(0, "certs").child(0, "ESSCertID");
    let hash = version === 2 ? "SHA-256" : "SHA-1";
    let index = 0;
    if (version === 2 && essCertId.child(0).isSequence) {
      const entry = DIGESTS[essCertId.child(0).child(0).oid()];
      hash = entry && entry.webCrypto;
      index = 1;
    }
    const certHash = essCertId.child(index).octets();
    if (!hash) return { version, hash: "unsupported", matches: null };
    if (!signerCertificate) return { version, hash, matches: null };
    return { version, hash, matches: equalBytes(await digest(hash, signerCertificate.der), certHash) };
  } catch (error) {
    if (isPdfEditorError(error) && error.code === "SIGN_NO_WEBCRYPTO") throw error;
    return { version, hash: null, matches: null, malformed: true };
  }
}

/**
 * Verifies one SignerInfo.
 *
 * @param {object} signedData      parseSignedData() result
 * @param {object} signerInfo      one of signedData.signerInfos
 * @param {(hashName: string) => Promise<Uint8Array>} digestContent  digest of the signed content (for a PDF:
 *        the bytes of the byte ranges; for a timestamp token: eContent). Called once per needed hash.
 * @returns {Promise<object>} the two separate facts `digestMatches` (content digest = message-digest attribute)
 *          and `signatureValid` (signature over the DER SET of signed attributes), each true | false | null,
 *          plus what was read; `problems` = [{ code, severity, params }]. Nothing here judges trust.
 */
export async function verifySignerInfo(signedData, signerInfo, digestContent) {
  const problems = [];
  const parsedCertificates = [];
  for (const certDer of signedData.certificates) {
    try {
      parsedCertificates.push(parseCertificate(certDer));
    } catch {
      /* an unreadable certificate in the bag is ignored */
    }
  }
  let signerCertificate = findSignerCertificate(signerInfo, parsedCertificates);
  let signerCertificateSource = "signer-identifier";
  if (!signerCertificate && parsedCertificates.length) {
    // some producers write a wrong issuer / serial: fall back to the certificate named by the ESS attribute
    for (const candidate of parsedCertificates) {
      const ess = await checkSigningCertificateAttribute(signerInfo, candidate);
      if (ess && ess.matches) {
        signerCertificate = candidate;
        signerCertificateSource = "signing-certificate-attribute";
        break;
      }
    }
  }
  if (!signerCertificate) problems.push(problem("SIGN_SIGNER_CERTIFICATE_MISSING", "error"));

  const digestInfo = DIGESTS[signerInfo.digestAlgorithmOid];
  const digestAlgorithm = { oid: signerInfo.digestAlgorithmOid, name: digestName(signerInfo.digestAlgorithmOid), weak: Boolean(digestInfo && digestInfo.weak) };
  const signatureAlgorithm = resolveSignatureAlgorithm(signerInfo.signatureAlgorithmNode, signerInfo.digestAlgorithmOid);

  const out = {
    signerCertificate,
    signerCertificateSource,
    certificates: parsedCertificates,
    digestAlgorithm,
    signatureAlgorithm,
    hasSignedAttributes: Boolean(signerInfo.signedAttrsNode),
    signedAttributeNames: [...signerInfo.signedAttrs.keys()].map((oid) => CMS_ATTRIBUTE_NAMES[oid] || oid),
    unsignedAttributeNames: [...signerInfo.unsignedAttrs.keys()].map((oid) => CMS_ATTRIBUTE_NAMES[oid] || oid),
    digestMatches: null,
    signatureValid: null,
    unsupported: null, // { reason, name } when a check could not be made here
    computedDigest: null,
    messageDigest: null,
    contentTypeOk: null,
    signingTime: null,
    essCertificate: null,
    signatureTimestampTokens: (signerInfo.unsignedAttrs.get(OID.signatureTimeStampToken) || []).map((node) => node.raw),
    hasEmbeddedRevocationInfo: signerInfo.signedAttrs.has(OID.adbeRevocationInfoArchival),
    problems
  };

  // 1. the content digest against the message-digest attribute
  let contentDigest = null;
  if (digestInfo && digestInfo.webCrypto) {
    contentDigest = await digestContent(digestInfo.webCrypto);
    out.computedDigest = contentDigest;
  } else {
    out.unsupported = { reason: "digest", name: digestAlgorithm.name };
    // not evidence against the signature: this digest cannot be computed here (verdict "unknown", never "valid")
    problems.push(problem("SIGN_UNSUPPORTED_DIGEST", "warning", { algorithm: digestAlgorithm.name }));
  }

  if (signerInfo.signedAttrsNode) {
    const messageDigest = signerInfo.signedAttrs.get(OID.messageDigest);
    if (!messageDigest || !messageDigest[0] || !messageDigest[0].isUniversal(TAG.OCTET_STRING)) {
      out.digestMatches = false;
      problems.push(problem("SIGN_NO_MESSAGE_DIGEST", "error"));
    } else {
      out.messageDigest = messageDigest[0].octets();
      if (contentDigest) out.digestMatches = equalBytes(contentDigest, out.messageDigest);
    }
    const contentType = signerInfo.signedAttrs.get(OID.contentType);
    if (contentType && contentType[0] && contentType[0].isUniversal(TAG.OID)) {
      out.contentTypeOk = contentType[0].oid() === signedData.eContentType;
      if (!out.contentTypeOk) problems.push(problem("SIGN_CONTENT_TYPE_MISMATCH", "error"));
    } else {
      out.contentTypeOk = false;
      problems.push(problem("SIGN_NO_CONTENT_TYPE", "warning"));
    }
    const signingTime = signerInfo.signedAttrs.get(OID.signingTime);
    if (signingTime && signingTime[0]) {
      const when = signingTime[0].time();
      if (!Number.isNaN(when.getTime())) out.signingTime = when;
    }
    out.essCertificate = await checkSigningCertificateAttribute(signerInfo, signerCertificate);
    if (out.essCertificate && out.essCertificate.matches === false) problems.push(problem("SIGN_SIGNING_CERTIFICATE_MISMATCH", "error"));
  }

  // 2. the signature value
  if (signerCertificate) {
    if (signerInfo.signedAttrsNode) {
      // what was signed is the DER encoding of the attributes as a SET OF (tag 0x31), not the [0] as stored
      const raw = signerInfo.signedAttrsNode.raw;
      const asStored = concatBytes(Uint8Array.of(0x31), raw.subarray(1));
      let result = await verifySignature(signatureAlgorithm, signerCertificate.spki, signerInfo.signature, asStored);
      if (result.ok === false) {
        // BER-encoded attributes (indefinite lengths, or stored out of order): the signer hashed their DER
        // form, a SET OF with definite lengths and sorted elements (OpenSSL verifies the same way). Second
        // candidate: definite lengths in the stored order.
        const attributeNodes = signerInfo.signedAttrsNode.children || [];
        const candidates = [
          tlv(0x31, sortSetOf(attributeNodes.map((node) => toDer(node, { sortSets: true })))),
          tlv(0x31, attributeNodes.map((node) => toDer(node, { sortSets: false })))
        ];
        for (const candidate of candidates) {
          if (equalBytes(candidate, asStored)) continue;
          const again = await verifySignature(signatureAlgorithm, signerCertificate.spki, signerInfo.signature, candidate);
          if (again.ok === true) {
            result = again;
            out.signedAttributesReencoded = true;
            break;
          }
        }
      }
      out.signatureValid = result.ok;
      if (result.ok === null) out.unsupported = result.unsupported;
    } else {
      // no signed attributes: the signature is directly over the content. WebCrypto hashes internally, so
      // the caller's digest cannot be reused: verifySignatureOverContent() needs the content itself.
      out.signatureValid = null;
      out.needsContentForSignature = true;
    }
  }
  return out;
}

/**
 * Completes verifySignerInfo() for a SignerInfo WITHOUT signed attributes (rare: old adbe.pkcs7.detached
 * producers): the signature is computed over the content itself, so there is a single check.
 */
export async function verifySignatureOverContent(result, signerInfo, content) {
  if (!result.signerCertificate) return result;
  const verdict = await verifySignature(result.signatureAlgorithm, result.signerCertificate.spki, signerInfo.signature, content);
  result.signatureValid = verdict.ok;
  result.digestMatches = verdict.ok;
  if (verdict.ok === null) result.unsupported = verdict.unsupported;
  return result;
}

/**
 * RFC 3161 TimeStampToken: parse TSTInfo and verify the token's own signature.
 * `ok` is true only when the imprint matches, the digest of TSTInfo matches and the signature verifies (each
 * === true: a check that could not be made leaves ok false) and the time is readable. The certificate of the
 * authority is looked at (time-stamping usage, validity at the stated time: warnings) but its chain is NOT
 * evaluated here or anywhere: who made the token stays unverified, and a caller must not present the time as
 * more than "a time-stamp token covers this signature" (inspectSignatures: timestamp.identityVerified false).
 *
 * @param {Uint8Array} tokenBytes   ContentInfo (SignedData with eContentType id-ct-TSTInfo)
 * @param {(hashName: string) => Promise<Uint8Array>} digestStamped  digest of the data the token must cover
 *        (signature timestamp: the signature value; document timestamp: the PDF byte ranges)
 * @returns {Promise<object>} { time, tsaName, hashAlgorithm, imprintMatches, digestMatches, signatureValid, ok, problems, ... }
 */
export async function verifyTimestampToken(tokenBytes, digestStamped) {
  const problems = [];
  let signedData;
  try {
    signedData = parseSignedData(tokenBytes);
  } catch {
    return { present: true, readable: false, problems: [problem("SIGN_TIMESTAMP_UNREADABLE", "warning")] };
  }
  const out = {
    present: true,
    readable: true,
    time: null,
    policy: null,
    serialNumber: null,
    hashAlgorithm: null,
    imprintMatches: null,
    digestMatches: null,
    signatureValid: null,
    unsupported: null,
    tsaName: null,
    tsaCertificate: null,
    certificates: [],
    encoding: signedData.encoding,
    length: signedData.length,
    ok: false,
    problems
  };
  if (signedData.eContentType !== OID.tstInfo || !signedData.eContent) {
    problems.push(problem("SIGN_TIMESTAMP_NOT_TSTINFO", "error"));
    return out;
  }
  let imprintOid;
  let imprint;
  try {
    const tst = decode(signedData.eContent);
    out.policy = tst.child(1).oid();
    const messageImprint = tst.child(2);
    imprintOid = messageImprint.child(0).child(0).oid();
    imprint = messageImprint.child(1).octets();
    out.serialNumber = tst.child(3).integerHex();
    out.time = tst.child(4).time();
    // a token whose time cannot be read states nothing (comparisons with an invalid Date are all false)
    if (Number.isNaN(out.time.getTime())) throw asn1Error("bad-time", tst.start, "unreadable genTime");
    out.hashAlgorithm = digestName(imprintOid);
    const tsa = tst.context(0);
    if (tsa && tsa.children && tsa.children[0] && tsa.children[0].isContext(4) && tsa.children[0].children) out.tsaName = parseName(tsa.children[0].children[0]).text;
  } catch {
    problems.push(problem("SIGN_TIMESTAMP_MALFORMED", "error"));
    return out;
  }
  const imprintDigest = DIGESTS[imprintOid];
  if (imprintDigest && imprintDigest.webCrypto) {
    out.imprintMatches = equalBytes(await digestStamped(imprintDigest.webCrypto), imprint);
    if (!out.imprintMatches) problems.push(problem("SIGN_TIMESTAMP_IMPRINT_MISMATCH", "error"));
  } else {
    problems.push(problem("SIGN_TIMESTAMP_UNSUPPORTED_DIGEST", "warning", { algorithm: out.hashAlgorithm }));
  }
  const signerInfo = signedData.signerInfos[0];
  if (!signerInfo) {
    problems.push(problem("SIGN_TIMESTAMP_NO_SIGNER", "error"));
    return out;
  }
  const verdict = await verifySignerInfo(signedData, signerInfo, (hashName) => digest(hashName, signedData.eContent));
  out.digestMatches = verdict.digestMatches;
  out.signatureValid = verdict.signatureValid;
  out.unsupported = verdict.unsupported;
  out.tsaCertificate = verdict.signerCertificate;
  out.certificates = verdict.certificates;
  out.signatureAlgorithm = verdict.signatureAlgorithm;
  out.digestAlgorithm = verdict.digestAlgorithm;
  if (verdict.signerCertificate) {
    if (!out.tsaName) out.tsaName = verdict.signerCertificate.subject.text;
    const extendedKeyUsage = verdict.signerCertificate.ext.extKeyUsage;
    out.tsaHasTimeStampingUsage = Boolean(extendedKeyUsage && extendedKeyUsage.oids.includes(OID.timeStamping));
    if (!out.tsaHasTimeStampingUsage) problems.push(problem("SIGN_TSA_CERTIFICATE_USAGE", "warning"));
    if (out.time && (out.time < verdict.signerCertificate.notBefore || out.time > verdict.signerCertificate.notAfter)) {
      problems.push(problem("SIGN_TSA_CERTIFICATE_NOT_VALID_AT_TIME", "warning"));
    }
  }
  if (verdict.digestMatches === false || verdict.signatureValid === false) problems.push(problem("SIGN_TIMESTAMP_SIGNATURE_INVALID", "error"));
  if (verdict.problems.some((entry) => entry.code === "SIGN_SIGNER_CERTIFICATE_MISSING")) problems.push(problem("SIGN_TSA_CERTIFICATE_MISSING", "warning"));
  out.ok = out.imprintMatches === true && out.digestMatches === true && out.signatureValid === true;
  return out;
}

/** Hex of a digest for reports. */
export const digestHex = (bytes) => (bytes ? toHex(bytes) : null);
