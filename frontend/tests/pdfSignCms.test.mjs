// engine/sign: the CMS builder and parser, RFC 3161 plumbing. What the builder writes is read back with the
// independent DER walker of the test kit and verified with node:crypto, and it is canonical DER as a whole:
// re-encoded from its tree (by the kit, and by the writer of the module) it gives the same bytes, which a
// container with one unsorted set or one long-form length does not.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decode, decodeExact, der, tlv, toDer } from "../src/pages/pdfEditor/engine/sign/asn1.js";
import { concatBytes, toHex } from "../src/pages/pdfEditor/engine/sign/bytes.js";
import {
  SUBFILTER_PADES, SUBFILTER_PKCS7, buildSignedAttributes, buildTimeStampRequest, createCms, describeSigner, estimateCmsSize,
  parseSignedData, parseTimeStampResponse, parseTimeStampToken, verifySignatureOverContent, verifySignerInfo, verifyTimestampToken
} from "../src/pages/pdfEditor/engine/sign/cms.js";
import { digest, signData } from "../src/pages/pdfEditor/engine/sign/sigverify.js";
import { parseCertificate } from "../src/pages/pdfEditor/engine/sign/x509.js";
import { createSelfSigned } from "../src/pages/pdfEditor/engine/sign/index.js";
import { CERTS, KEYS } from "./helpers/pdfSignFixtures.mjs";
import {
  OIDS, canonicalCms, derAt, derChildren, derContent, derOid, derRaw, fakeTsa, handMadeCms, importTestKey, parseCms, rejectsWithCode, sha256, toBer
} from "./helpers/pdfSignKit.mjs";

const signers = {};
test.before(async () => {
  signers.rsa = { certificate: CERTS.signer1, chain: [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa], privateKey: await importTestKey(KEYS.signer1, "rsa") };
  signers.ec = { certificate: CERTS.ecSigner, chain: [CERTS.rootCa, CERTS.intermediateCa], privateKey: await importTestKey(KEYS.ecSigner, "ec") };
});

const DIGEST = new Uint8Array(sha256(Buffer.from("the two byte ranges of a PDF")));
const ATTRIBUTE_NAMES = { [OIDS.contentType]: "contentType", [OIDS.messageDigest]: "messageDigest", [OIDS.signingTime]: "signingTime", [OIDS.signingCertificateV2]: "signingCertificateV2" };

/** node:crypto verification of a SignerInfo read by the independent walker. */
function nodeVerifies(parsed, certificateDer) {
  const publicKey = new crypto.X509Certificate(Buffer.from(certificateDer)).publicKey;
  const attributes = Buffer.from(parsed.signedAttrsImplicit);
  attributes[0] = 0x31;
  return crypto.verify("sha256", attributes, publicKey.asymmetricKeyType === "ec" ? { key: publicKey, dsaEncoding: "der" } : publicKey, parsed.signature);
}

test("cms: signed attributes (PAdES set and adbe.pkcs7 set), DER SET OF order, ESS certificate hash", async () => {
  const cert = parseCertificate(CERTS.signer1);
  for (const [subFilter, expected] of [
    [SUBFILTER_PADES, ["contentType", "messageDigest", "signingCertificateV2"]],
    [SUBFILTER_PKCS7, ["contentType", "messageDigest", "signingCertificateV2", "signingTime"]]
  ]) {
    const attributes = await buildSignedAttributes({ documentDigest: DIGEST, cert, subFilter, signingTime: new Date("2026-11-16T00:00:00Z") });
    assert.equal(attributes.setDer[0], 0x31);
    assert.equal(attributes.implicitDer[0], 0xa0);
    assert.deepEqual(attributes.setDer.subarray(1), attributes.implicitDer.subarray(1), "the same bytes under both tags");
    const buffer = Buffer.from(attributes.setDer);
    const items = derChildren(buffer, derAt(buffer, 0)).map((node) => Buffer.from(derRaw(buffer, node)));
    assert.deepEqual(items.map(toHex), [...items].sort(Buffer.compare).map(toHex), "the elements are in DER SET OF order");
    assert.deepEqual(items.map((item) => ATTRIBUTE_NAMES[derOid(item, derChildren(item, derAt(item, 0))[0])]).sort(), expected);
    assert.equal(attributes.count, expected.length);
    const hexText = toHex(attributes.setDer);
    assert.ok(hexText.includes(sha256(CERTS.signer1).toString("hex")), "ESS certHash is the SHA-256 of the signer certificate");
    assert.ok(hexText.includes(toHex(DIGEST)), "the message digest is in");
    assert.ok(!hexText.includes(toHex(der.oid(OIDS.sha256))), "the default hash algorithm of ESSCertIDv2 is omitted");
    assert.ok(hexText.includes(toHex(cert.issuer.der)) && hexText.includes(toHex(cert.serialNumberTlv)), "IssuerSerial copies issuer and serial verbatim");
    if (subFilter === SUBFILTER_PKCS7) assert.ok(hexText.includes(toHex(der.utcTime(new Date("2026-11-16T00:00:00Z")))));
  }
  await rejectsWithCode(buildSignedAttributes({ documentDigest: DIGEST, cert, subFilter: "adbe.x509.rsa_sha1" }), "SIGN_BAD_SUBFILTER");
  await rejectsWithCode(buildSignedAttributes({ documentDigest: DIGEST, cert, subFilter: SUBFILTER_PKCS7, signingTime: new Date(NaN) }), "SIGN_BAD_OPTIONS");
  await rejectsWithCode(buildSignedAttributes({ documentDigest: new Uint8Array(20), cert }), "SIGN_INTERNAL");
});

test("cms: createCms writes a detached DER SignedData that node:crypto verifies (RSA and ECDSA, both subfilters)", async () => {
  for (const key of ["rsa", "ec"]) {
    for (const subFilter of [SUBFILTER_PADES, SUBFILTER_PKCS7]) {
      const made = await createCms({ documentDigest: DIGEST, signer: signers[key], subFilter, signingTime: new Date("2026-11-16T01:00:00Z") });
      const parsed = parseCms(made.der);
      assert.equal(parsed.version, 1);
      assert.equal(parsed.signerInfoVersion, 1);
      assert.equal(parsed.digestAlgorithm, OIDS.sha256);
      assert.equal(parsed.signerDigestAlgorithm, OIDS.sha256);
      assert.equal(parsed.eContentType, OIDS.data);
      assert.equal(parsed.encapChildren, 1, "detached: no eContent");
      assert.equal(parsed.signatureAlgorithm, key === "rsa" ? OIDS.rsaEncryption : OIDS.ecdsaWithSha256);
      // rsaEncryption carries NULL parameters, ecdsa-with-SHA256 none (RFC 5754)
      assert.equal(parsed.signatureAlgorithmParameterCount, key === "rsa" ? 1 : 0);
      assert.equal(parsed.signatureAlgorithmHasNullParameters, key === "rsa");
      assert.deepEqual(parsed.unsignedAttributes, []);
      assert.equal(parsed.attributes.some((attribute) => attribute.oid === OIDS.signingTime), subFilter === SUBFILTER_PKCS7, "signing-time only with adbe.pkcs7.detached");
      // certificates: signer + chain without duplicates, as a DER SET OF (sorted encodings)
      assert.equal(parsed.certificates.length, 3);
      assert.deepEqual(parsed.certificates.map(toHex), [...parsed.certificates].sort(Buffer.compare).map(toHex), "CertificateSet in DER order");
      assert.ok(parsed.certificates.some((certificate) => certificate.equals(Buffer.from(signers[key].certificate))));
      // the SignerInfo names the signer certificate by issuer and serial number, copied verbatim
      const signer = parseCertificate(signers[key].certificate);
      assert.equal(toHex(parsed.sidIssuer), toHex(signer.issuer.der));
      assert.equal(parsed.sidSerialHex, toHex(signer.serialNumberBytes));
      const messageDigest = parsed.attributes.find((attribute) => attribute.oid === OIDS.messageDigest);
      assert.equal(toHex(derContent(parsed.cms, messageDigest.value)), toHex(DIGEST));
      assert.equal(nodeVerifies(parsed, signers[key].certificate), true, "node:crypto verifies the signature over the signed attributes");
      assert.equal(made.certificateCount, 3);
      assert.equal(made.mechanism, key === "rsa" ? "RSA 2048" : "ECDSA P-256");
    }
  }
});

test("cms: the certificate set is DER-ordered whatever was given first; estimateCmsSize is exact for RSA, a tight bound for ECDSA", async () => {
  // a signer whose certificate is LONGER than the other certificate in the set: sorted, it does not come first
  const self = await createSelfSigned({ commonName: "Người ký có chứng thư dài hơn chứng thư đi kèm", organization: "Thử nghiệm", email: "long@example.test", keyType: "RSA-3072" });
  const signer = { certificate: self.certificate, chain: [CERTS.ecSigner], privateKey: self.privateKey };
  const made = await createCms({ documentDigest: DIGEST, signer });
  const parsed = parseCms(made.der);
  assert.ok(self.certificate.length > CERTS.ecSigner.length);
  assert.deepEqual(parsed.certificates.map(toHex), [toHex(CERTS.ecSigner), toHex(self.certificate)]);
  assert.equal(parsed.sidSerialHex, toHex(parseCertificate(self.certificate).serialNumberBytes));
  assert.equal(nodeVerifies(parsed, self.certificate), true);

  for (const subFilter of [SUBFILTER_PADES, SUBFILTER_PKCS7]) {
    const signingTime = new Date();
    const rsa = await createCms({ documentDigest: DIGEST, signer: signers.rsa, subFilter, signingTime });
    assert.equal(await estimateCmsSize({ signer: signers.rsa, subFilter, signingTime }), rsa.der.length);
    for (let i = 0; i < 8; i++) {
      const ec = await createCms({ documentDigest: DIGEST, signer: signers.ec, subFilter, signingTime });
      const estimate = await estimateCmsSize({ signer: signers.ec, subFilter, signingTime });
      // r and s are usually 32 or 33 content bytes; 1 time in 128 one of them is shorter
      assert.ok(estimate >= ec.der.length && estimate - ec.der.length <= 6, `${estimate} vs ${ec.der.length}`);
    }
  }
  assert.equal(await estimateCmsSize({ signer: signers.rsa, timestampTokenBytes: 3000 }) - await estimateCmsSize({ signer: signers.rsa }) > 3000, true);
});

test("cms: the whole container is canonical DER (a re-encoding reproduces it; a non-canonical container is told apart)", async () => {
  const isCanonical = (bytes) => toHex(canonicalCms(bytes)) === toHex(bytes);
  const self = await createSelfSigned({ commonName: "Người ký có chứng thư dài hơn chứng thư đi kèm", organization: "Thử nghiệm", keyType: "RSA-3072" });
  const cases = [];
  for (const subFilter of [SUBFILTER_PADES, SUBFILTER_PKCS7]) {
    cases.push([`RSA ${subFilter}`, { signer: signers.rsa, subFilter }]);
    // ECDSA signature values change their length from one signature to the next
    for (let i = 0; i < 6; i++) cases.push([`ECDSA ${subFilter} #${i}`, { signer: signers.ec, subFilter }]);
    // the signer certificate is not the first of the sorted set; the chain is given in a jumbled order
    cases.push([`long signer ${subFilter}`, { signer: { certificate: self.certificate, chain: [CERTS.rootCa, CERTS.ecSigner, CERTS.intermediateCa], privateKey: self.privateKey }, subFilter }]);
  }
  let sample = null;
  for (const [label, options] of cases) {
    const made = await createCms({ documentDigest: DIGEST, signingTime: new Date("2026-11-16T01:00:00Z"), ...options });
    // 1. re-encoded by the kit (its own reader and writer; SET OF sorted again, lengths written again)
    assert.equal(toHex(canonicalCms(made.der)), toHex(made.der), `${label}: the independent re-encoding gives the same bytes`);
    // 2. read strictly and re-encoded by the writer of the module (universal SETs sorted again)
    assert.equal(toHex(toDer(decodeExact(made.der, { strict: true }), { sortSets: true })), toHex(made.der), `${label}: the module's own re-encoding gives the same bytes`);
    sample ||= made.der;
  }
  // with a time-stamp token as an unsigned attribute
  const stamped = await createCms({ documentDigest: DIGEST, signer: signers.rsa, timestamp: { request: fakeTsa({ certificate: CERTS.signer1, privateKeyPkcs8: KEYS.signer1 }).request, tokenBytes: 4096 } });
  assert.equal(isCanonical(stamped.der), true, "with a signature time-stamp");

  // --- the check can fail: containers that are NOT canonical DER, each for one reason
  const parsed = parseCms(sample);
  // a. the same container with indefinite lengths (BER): the re-encoding is the canonical original
  const ber = toBer(sample);
  assert.deepEqual([isCanonical(ber), toHex(canonicalCms(ber)) === toHex(sample)], [false, true]);
  // b. two signed attributes in the wrong order (same bytes otherwise)
  const swapped = Buffer.from(sample);
  const [first, second] = parsed.attributes;
  Buffer.concat([Buffer.from(second.raw), Buffer.from(first.raw)]).copy(swapped, swapped.indexOf(first.raw));
  assert.notEqual(toHex(swapped), toHex(sample));
  assert.deepEqual([isCanonical(swapped), toHex(canonicalCms(swapped)) === toHex(sample)], [false, true]);
  // c. a long-form length where the short form is due: the outer length with a leading zero octet
  const outer = derAt(Buffer.from(sample), 0);
  const padded = Buffer.concat([Buffer.from([0x30, 0x83, 0x00]), Buffer.from(sample).subarray(2, outer.contentStart), Buffer.from(sample).subarray(outer.contentStart)]);
  assert.equal(padded.length, sample.length + 1);
  assert.deepEqual([isCanonical(padded), toHex(canonicalCms(padded)) === toHex(sample)], [false, true]);
  assert.throws(() => decodeExact(new Uint8Array(padded), { strict: true }), (error) => error.code === "CERT_ASN1_MALFORMED");
  // d. the certificates in an order that is not the sorted one (what a hand-made container does)
  const sorted = [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa].map((bytes) => Buffer.from(bytes)).sort(Buffer.compare);
  const unsorted = handMadeCms(DIGEST, { certificate: CERTS.signer1, privateKeyPkcs8: KEYS.signer1, certificates: [...sorted].reverse() });
  const inOrder = handMadeCms(DIGEST, { certificate: CERTS.signer1, privateKeyPkcs8: KEYS.signer1, certificates: sorted });
  assert.deepEqual([isCanonical(unsorted), isCanonical(inOrder), toHex(canonicalCms(unsorted)) === toHex(inOrder)], [false, true, true]);
});

test("cms: signers that are refused, each with its code", async () => {
  const rsaKey = signers.rsa.privateKey;
  const ecKey = signers.ec.privateKey;
  const reason = (signer) => {
    try {
      describeSigner(signer);
    } catch (error) {
      return error.code === "SIGN_BAD_SIGNER" ? `${error.code}:${error.params.reason}` : error.code;
    }
    return "accepted";
  };
  assert.equal(reason(null), "SIGN_BAD_SIGNER:certificate");
  assert.equal(reason({ certificate: "text", privateKey: rsaKey }), "SIGN_BAD_SIGNER:certificate");
  assert.equal(reason({ certificate: Uint8Array.of(1, 2, 3), privateKey: rsaKey }), "SIGN_BAD_SIGNER:certificate");
  assert.equal(reason({ certificate: CERTS.signer1 }), "SIGN_BAD_SIGNER:private-key");
  assert.equal(reason({ certificate: CERTS.signer1, privateKey: { type: "public", usages: ["verify"], algorithm: {} } }), "SIGN_BAD_SIGNER:private-key");
  assert.equal(reason({ certificate: CERTS.signer1, chain: [Uint8Array.of(9, 9)], privateKey: rsaKey }), "SIGN_BAD_SIGNER:chain");
  assert.equal(reason({ certificate: CERTS.signer1, privateKey: ecKey }), "SIGN_BAD_SIGNER:key-algorithm");
  assert.equal(reason({ certificate: CERTS.ecSigner, privateKey: rsaKey }), "SIGN_BAD_SIGNER:key-algorithm");
  const sha384Key = await globalThis.crypto.subtle.importKey("pkcs8", KEYS.signer1, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, false, ["sign"]);
  assert.equal(reason({ certificate: CERTS.signer1, privateKey: sha384Key }), "SIGN_BAD_SIGNER:key-algorithm");
  assert.equal(reason({ certificate: CERTS.rsa1024, privateKey: rsaKey }), "SIGN_WEAK_KEY");
  assert.equal(reason({ certificate: CERTS.ed25519, privateKey: rsaKey }), "SIGN_UNSUPPORTED_KEY");
  assert.equal(reason({ certificate: CERTS.k256, privateKey: ecKey }), "SIGN_UNSUPPORTED_KEY");
  assert.equal(reason(signers.rsa), "accepted");
  // a key that does not belong to the certificate: caught by verifying the fresh signature with the certificate
  const other = await globalThis.crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, false, ["sign", "verify"]);
  await rejectsWithCode(createCms({ documentDigest: DIGEST, signer: { certificate: CERTS.signer1, privateKey: other.privateKey } }), "SIGN_KEY_MISMATCH");
  await rejectsWithCode(signData(sha384Key, "SHA-256", new Uint8Array(4)), "SIGN_BAD_SIGNER");
  await rejectsWithCode(signData({ algorithm: { name: "HMAC" } }, "SHA-256", new Uint8Array(4)), "SIGN_BAD_SIGNER");
});

test("cms: the parser keeps the two facts apart (digest matches / signature verifies) and reads BER", async () => {
  const content = new TextEncoder().encode("signed content");
  const made = await createCms({ documentDigest: await digest("SHA-256", content), signer: signers.rsa, subFilter: SUBFILTER_PKCS7, signingTime: new Date("2026-11-16T01:00:00Z") });
  const cms = parseSignedData(concatBytes(made.der, new Uint8Array(300))); // zero padding as in /Contents
  assert.equal(cms.length, made.der.length);
  assert.equal(cms.encoding, "DER");
  assert.equal(cms.eContent, null);
  assert.equal(cms.certificates.length, 3);
  assert.equal(cms.signerInfos.length, 1);
  const verdict = await verifySignerInfo(cms, cms.signerInfos[0], (hash) => digest(hash, content));
  assert.deepEqual([verdict.digestMatches, verdict.signatureValid, verdict.contentTypeOk], [true, true, true]);
  assert.equal(verdict.signerCertificate.subject.fields.CN[0], "Nguyễn Văn An");
  assert.equal(verdict.signerCertificateSource, "signer-identifier");
  assert.deepEqual(verdict.signedAttributeNames.sort(), ["contentType", "messageDigest", "signingCertificateV2", "signingTime"]);
  assert.deepEqual(verdict.essCertificate, { version: 2, hash: "SHA-256", matches: true });
  assert.equal(verdict.signingTime.toISOString(), "2026-11-16T01:00:00.000Z");
  assert.deepEqual(verdict.problems, []);
  // the same container over other content: the digest does not match, the signature over the attributes still does
  const other = await verifySignerInfo(cms, cms.signerInfos[0], (hash) => digest(hash, new Uint8Array(10)));
  assert.deepEqual([other.digestMatches, other.signatureValid], [false, true]);
  // one bit of the signature value changed: the digest matches, the signature does not verify
  const broken = Uint8Array.from(made.der);
  broken[broken.length - 5] ^= 0x01;
  const brokenCms = parseSignedData(broken);
  const bad = await verifySignerInfo(brokenCms, brokenCms.signerInfos[0], (hash) => digest(hash, content));
  assert.deepEqual([bad.digestMatches, bad.signatureValid], [true, false]);

  // BER: the outer ContentInfo and its [0] with indefinite lengths (what BouncyCastle-style encoders write)
  const outer = decode(made.der);
  const ber = concatBytes(Uint8Array.of(0x30, 0x80), outer.child(0).raw, Uint8Array.of(0xa0, 0x80), outer.child(1).child(0).raw, Uint8Array.of(0, 0, 0, 0));
  const berCms = parseSignedData(concatBytes(ber, new Uint8Array(64)));
  assert.equal(berCms.encoding, "BER");
  assert.equal(berCms.length, ber.length);
  const berVerdict = await verifySignerInfo(berCms, berCms.signerInfos[0], (hash) => digest(hash, content));
  assert.deepEqual([berVerdict.digestMatches, berVerdict.signatureValid], [true, true]);

  // attributes stored out of DER order (a BER writer): the signature is over their sorted DER form
  const parsed = parseCms(made.der);
  const first = parsed.attributes[0].raw;
  const second = parsed.attributes[1].raw;
  const shuffled = Buffer.from(made.der);
  const at = shuffled.indexOf(Buffer.concat([first, second]));
  assert.ok(at > 0);
  Buffer.concat([second, first]).copy(shuffled, at);
  const shuffledCms = parseSignedData(new Uint8Array(shuffled));
  const reordered = await verifySignerInfo(shuffledCms, shuffledCms.signerInfos[0], (hash) => digest(hash, content));
  assert.deepEqual([reordered.digestMatches, reordered.signatureValid, reordered.signedAttributesReencoded], [true, true, true]);

  // unreadable containers are a coded error
  for (const junk of [Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x00), new Uint8Array(0), der.seq(der.oid(OIDS.data), der.ctx(0, der.octets(new Uint8Array(3)))), made.der.subarray(0, 200)]) {
    assert.throws(() => parseSignedData(junk), (error) => error.code === "SIGN_CMS_UNREADABLE");
  }
});

test("cms: a SignerInfo without signed attributes is verified over the content itself", async () => {
  const content = new TextEncoder().encode("old producers sign the bytes directly");
  const cert = parseCertificate(CERTS.signer1);
  const key = crypto.createPrivateKey({ key: Buffer.from(KEYS.signer1), format: "der", type: "pkcs8" });
  const container = (signature) => der.seq(der.oid(OIDS.signedData), der.ctx(0, der.seq(
    der.int(1),
    der.set(der.seq(der.oid(OIDS.sha256), der.nul())),
    der.seq(der.oid(OIDS.data)),
    der.ctx(0, CERTS.signer1),
    der.set(der.seq(der.int(1), der.seq(cert.issuer.der, cert.serialNumberTlv), der.seq(der.oid(OIDS.sha256), der.nul()), der.seq(der.oid("1.2.840.113549.1.1.11"), der.nul()), der.octets(signature)))
  )));
  const cms = parseSignedData(container(crypto.sign("sha256", content, key)));
  const verdict = await verifySignerInfo(cms, cms.signerInfos[0], (hash) => digest(hash, content));
  assert.deepEqual([verdict.hasSignedAttributes, verdict.needsContentForSignature, verdict.signatureValid, verdict.essCertificate], [false, true, null, null]);
  await verifySignatureOverContent(verdict, cms.signerInfos[0], content);
  assert.deepEqual([verdict.digestMatches, verdict.signatureValid], [true, true]);
  const again = await verifySignerInfo(cms, cms.signerInfos[0], (hash) => digest(hash, content));
  await verifySignatureOverContent(again, cms.signerInfos[0], new TextEncoder().encode("other bytes"));
  assert.deepEqual([again.digestMatches, again.signatureValid], [false, false]);
  // the signer certificate is not in the container
  const lonely = parseSignedData(container(crypto.sign("sha256", content, key)).map((value) => value));
  lonely.certificates = [];
  const missing = await verifySignerInfo(lonely, lonely.signerInfos[0], (hash) => digest(hash, content));
  assert.deepEqual(missing.problems.map((entry) => [entry.code, entry.severity]), [["SIGN_SIGNER_CERTIFICATE_MISSING", "error"]]);
  assert.equal(missing.signatureValid, null);
});

test("cms: RFC 3161 request, answer and token (behind an injected request function only)", async () => {
  const signatureValue = new Uint8Array(crypto.randomBytes(256));
  const imprint = await digest("SHA-256", signatureValue);
  const nonce = Uint8Array.of(0x41, 2, 3, 4, 5, 6, 7, 8);
  const request = buildTimeStampRequest(imprint, { nonce, policyOid: "1.2.3.4" });
  const fields = decode(request).children;
  assert.equal(fields[0].integerNumber(), 1);
  assert.equal(fields[1].child(0).child(0).oid(), OIDS.sha256);
  assert.equal(toHex(fields[1].child(1).octets()), toHex(imprint));
  assert.equal(fields[2].oid(), "1.2.3.4");
  assert.equal(toHex(fields[3].integerBytes()), toHex(nonce));
  assert.equal(fields[4].boolean(), true, "certReq: the TSA certificate must be in the token");

  const tsa = fakeTsa({ certificate: CERTS.signer2, privateKeyPkcs8: KEYS.signer1, der, parseCertificate }); // (signs with a key that is not the certificate's)
  const honest = fakeTsa({ certificate: CERTS.signer1, privateKeyPkcs8: KEYS.signer1, der, parseCertificate });
  const answer = await honest.request(request);
  const { token, info } = parseTimeStampResponse(answer, { imprint, nonce });
  assert.equal(info.policy, "1.3.6.1.4.1.99999.2.1");
  assert.equal(info.genTime.toISOString(), "2026-11-16T02:00:00.000Z");
  assert.equal(toHex(info.imprint), toHex(imprint));
  assert.deepEqual(parseTimeStampToken(token).imprintAlgorithm, OIDS.sha256);
  // what the signer refuses
  const code = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.code === "SIGN_BAD_TIMESTAMP" ? `${error.code}:${error.params.reason}` : error.code;
    }
    return "accepted";
  };
  assert.equal(code(() => parseTimeStampResponse(answer, { imprint: new Uint8Array(32), nonce })), "SIGN_BAD_TIMESTAMP:imprint-mismatch");
  assert.equal(code(() => parseTimeStampResponse(answer, { imprint, nonce: Uint8Array.of(1, 2, 3) })), "SIGN_BAD_TIMESTAMP:nonce-mismatch");
  assert.equal(code(() => parseTimeStampResponse(Uint8Array.of(1, 2, 3))), "SIGN_BAD_TIMESTAMP:malformed");
  assert.equal(code(() => parseTimeStampResponse(der.seq(der.seq(der.int(0))))), "SIGN_BAD_TIMESTAMP:no-token");
  assert.equal(code(() => parseTimeStampResponse(der.seq(der.seq(der.int(0)), der.seq(der.oid(OIDS.data), der.ctx(0, der.nul()))))), "SIGN_BAD_TIMESTAMP:not-signed-data");
  assert.equal(code(() => parseTimeStampResponse(der.seq(der.seq(der.int(2))))), "SIGN_TIMESTAMP_REJECTED");

  // the token as the inspector judges it
  const sound = await verifyTimestampToken(token, (hash) => digest(hash, signatureValue));
  assert.deepEqual([sound.ok, sound.imprintMatches, sound.digestMatches, sound.signatureValid, sound.hashAlgorithm], [true, true, true, true, "SHA-256"]);
  assert.equal(sound.time.toISOString(), "2026-11-16T02:00:00.000Z");
  assert.equal(sound.tsaHasTimeStampingUsage, false);
  assert.deepEqual(sound.problems.map((entry) => [entry.code, entry.severity]), [["SIGN_TSA_CERTIFICATE_USAGE", "warning"]]);
  const elsewhere = await verifyTimestampToken(token, (hash) => digest(hash, new Uint8Array(5)));
  assert.deepEqual([elsewhere.ok, elsewhere.imprintMatches], [false, false]);
  assert.ok(elsewhere.problems.some((entry) => entry.code === "SIGN_TIMESTAMP_IMPRINT_MISMATCH" && entry.severity === "error"));
  // a token whose time cannot be read states no time: malformed, never "ok" with an empty time
  const timeless = Uint8Array.from(token);
  const stampedTime = Buffer.from(timeless).indexOf(Buffer.from("20261116020000Z"));
  assert.ok(stampedTime > 0);
  timeless[stampedTime + 4] = "X".charCodeAt(0);
  const unreadableTime = await verifyTimestampToken(timeless, (hash) => digest(hash, signatureValue));
  assert.deepEqual([unreadableTime.ok, unreadableTime.problems.map((entry) => [entry.code, entry.severity])], [false, [["SIGN_TIMESTAMP_MALFORMED", "error"]]]);
  // a token whose signature was not made with the key of its certificate
  const forged = parseTimeStampResponse(await tsa.request(request), { imprint, nonce }).token;
  const forgedVerdict = await verifyTimestampToken(forged, (hash) => digest(hash, signatureValue));
  assert.deepEqual([forgedVerdict.ok, forgedVerdict.imprintMatches, forgedVerdict.signatureValid], [false, true, false]);
  assert.ok(forgedVerdict.problems.some((entry) => entry.code === "SIGN_TIMESTAMP_SIGNATURE_INVALID"));
  // not a token at all / not TSTInfo / TSTInfo cut short
  assert.deepEqual((await verifyTimestampToken(Uint8Array.of(1, 2), async () => new Uint8Array(32))).problems.map((entry) => entry.code), ["SIGN_TIMESTAMP_UNREADABLE"]);
  const plain = await createCms({ documentDigest: imprint, signer: signers.rsa });
  assert.deepEqual((await verifyTimestampToken(plain.der, async () => new Uint8Array(32))).problems.map((entry) => entry.code), ["SIGN_TIMESTAMP_NOT_TSTINFO"]);
  const tokenNode = decode(token);
  const eContent = tokenNode.child(1).child(0).child(2).child(1).child(0);
  const cut = Uint8Array.from(token);
  cut.set(tlv(0x30, new Uint8Array(eContent.length - 2)), eContent.contentStart); // an empty-looking TSTInfo of the same size
  assert.ok((await verifyTimestampToken(cut, async () => new Uint8Array(32))).problems.some((entry) => entry.code === "SIGN_TIMESTAMP_MALFORMED"));
});
