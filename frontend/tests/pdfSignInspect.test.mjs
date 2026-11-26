// engine/sign: inspectSignatures on inputs the signer itself never writes: structural attacks, containers
// in the shapes of other products (built by hand, signed with node:crypto), unsigned revisions appended after
// a signature, legacy formats, altered certificates. Three facts stay apart everywhere: the digest matches,
// the signature verifies, what the signature covers; and "trusted" exists only against supplied roots.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { der } from "../src/pages/pdfEditor/engine/sign/asn1.js";
import { buildTimeStampRequest, createCms } from "../src/pages/pdfEditor/engine/sign/cms.js";
import { SUBFILTER_PADES, SUBFILTER_PKCS7, createSelfSigned, inspectPdf, inspectSignatures, loadPkcs12, signPdf, signedRevisionBytes } from "../src/pages/pdfEditor/engine/sign/index.js";
import { readLastXrefSection } from "../src/pages/pdfEditor/engine/sign/pdfRaw.js";
import { pageText, pdfLib, withPdf } from "./helpers/pdfTestKit.mjs";
import { CERTS, KEYS, P12, PASSWORD } from "./helpers/pdfSignFixtures.mjs";
import {
  OIDS, appendContentRevision, appendRaw, appendRevision, craftSignedPdf, derAt, derChildren, derRaw, fakeTsa, fromLatin1, handMadeCms, hex, latin1,
  makeEncryptedSignedPdf, makeFormPdf, makeSignablePdf, makeTestCertificate, objectStream, readSignatures, replaceInPlace, sameBytes, sha256, toBer,
  verifyIndependently, xrefStream, xrefTable
} from "./helpers/pdfSignKit.mjs";

const SIGNED_AT = new Date("2026-11-16T01:00:00Z");
const NOW = new Date("2026-11-16T03:00:00Z");
const SIGNER1 = { certificate: CERTS.signer1, privateKeyPkcs8: KEYS.signer1 };
const CHAIN = [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa];

const signers = {};
const base = {};
test.before(async () => {
  signers.rsa = await loadPkcs12(P12.aes256.bytes, PASSWORD);
  signers.rsa2 = await loadPkcs12(P12.signer2.bytes, PASSWORD);
  base.classic = await makeSignablePdf({ objectStreams: false });
  base.stream = await makeSignablePdf({ objectStreams: true });
  base.signed = (await signPdf(base.classic, { signer: signers.rsa, signingTime: SIGNED_AT, timeZoneOffsetMinutes: 420, reason: "Đồng ý" })).bytes;
  base.signedStream = (await signPdf(base.stream, { signer: signers.rsa, signingTime: SIGNED_AT })).bytes;
});

const inspect = (bytes, options = {}) => inspectSignatures(bytes, { trustedCertificates: [CERTS.rootCa], now: NOW, ...options });
const first = async (bytes, options) => (await inspect(bytes, options)).signatures[0];
const codes = (signature) => signature.problems.map((entry) => `${entry.code}:${entry.severity}`);
const facts = (signature) => [signature.digestMatches, signature.signatureValid, signature.coverage ? signature.coverage.status : null, signature.verdict];
const changeCodes = (signature) => signature.changesAfterSigning.items.map((item) => `${item.allowed ? "+" : "-"}${item.code}`);
/** A signature revision with a container made by hand (adbe.pkcs7.detached unless told otherwise). */
const crafted = (options = {}, craft = {}) => craftSignedPdf(craft.input || base.classic, {
  prepare: { subFilter: SUBFILTER_PKCS7, ...craft.prepare },
  patch: craft.patch,
  afterEmbed: craft.afterEmbed,
  container: craft.container || ((signed) => handMadeCms(signed, { ...SIGNER1, certificates: CHAIN, ...options }))
});

test("inspect: unsigned documents, input that is not a PDF, damaged PDFs: a report, never an exception", async () => {
  for (const bytes of [base.classic, base.stream]) {
    const result = await inspect(bytes);
    assert.deepEqual([result.signatures, result.unsignedFields, result.otherByteRanges], [[], [], []]);
    assert.deepEqual([result.document.revisions, result.document.encrypted, result.document.parser.ok, result.document.trustModel], [1, false, true, "caller-roots"]);
    assert.equal(result.document.size, bytes.length);
  }
  assert.equal((await inspectSignatures(base.classic)).document.trustModel, "none");
  for (const bytes of [new Uint8Array(0), new TextEncoder().encode("hello"), new Uint8Array(crypto.randomBytes(5000)), base.signed.subarray(0, 6000), base.signed.subarray(3000), "not bytes", null]) {
    const result = await inspect(bytes);
    assert.ok(Array.isArray(result.signatures));
    for (const signature of result.signatures) assert.notEqual(signature.verdict, "valid");
  }
  // an ArrayBuffer is accepted
  const whole = await inspect(base.signed.buffer.slice(base.signed.byteOffset, base.signed.byteOffset + base.signed.byteLength));
  assert.equal(whole.signatures[0].verdict, "valid");
  // an encrypted document without signatures
  const doc = await pdfLib.PDFDocument.load(base.classic);
  doc.encrypt({ userPassword: "userpw", ownerPassword: "ownerpw" });
  const encrypted = await inspect(await doc.save({ useObjectStreams: false }), { password: "userpw" });
  assert.deepEqual([encrypted.signatures.length, encrypted.document.encrypted], [0, true]);
  // signedRevisionBytes needs a usable coverage
  assert.equal(signedRevisionBytes(base.signed, { coverage: null }), null);
  assert.equal(signedRevisionBytes(base.signed, { coverage: { signedEnd: base.signed.length + 1 } }), null);
  assert.equal(signedRevisionBytes("text", whole.signatures[0]), null);
});

test("inspect: trust exists only against the certificates the caller supplies", async () => {
  const trust = async (bytes, roots) => (await inspectSignatures(bytes, { trustedCertificates: roots, now: NOW })).signatures[0].trust;
  const none = await trust(base.signed, undefined);
  assert.deepEqual([none.status, none.reason, none.selfSigned, none.issuedBy, none.chainComplete, none.revocationChecked], ["not-checked", "no-trusted-certificates", false, "ANS Test Intermediate CA", true, false]);
  assert.equal((await trust(base.signed, [])).status, "not-checked");
  const rooted = await trust(base.signed, [CERTS.rootCa]);
  assert.deepEqual([rooted.status, rooted.reason, rooted.anchorCommonName, rooted.revocationChecked, rooted.failures], ["trusted", "anchored", "ANS Test Root CA", false, []]);
  assert.equal(rooted.checkedAt, SIGNED_AT.toISOString(), "validity is judged at the signing time");
  // the intermediate alone as an anchor is enough; an unrelated certificate is not; junk is ignored
  assert.equal((await trust(base.signed, [CERTS.intermediateCa])).anchorCommonName, "ANS Test Intermediate CA");
  assert.deepEqual([(await trust(base.signed, [CERTS.ecCa, Uint8Array.of(1, 2, 3)])).status, (await trust(base.signed, [CERTS.ecCa])).reason], ["untrusted", "no-path"]);
  // the roots may come as one PEM bundle (a file with several certificates)
  const pem = (der) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  const bundle = new TextEncoder().encode(pem(CERTS.ecCa) + pem(CERTS.rootCa));
  assert.deepEqual([(await trust(base.signed, [bundle])).status, (await trust(base.signed, [bundle])).anchorCommonName], ["trusted", "ANS Test Root CA"]);
  // a self-signed signer is trusted only when exactly that certificate is supplied
  const self = await createSelfSigned({ commonName: "Người Tự Ký", organization: "Thử nghiệm", keyType: "P-256", now: new Date("2026-06-01T00:00:00Z") });
  const selfSigned = (await signPdf(base.classic, { signer: self, signingTime: SIGNED_AT })).bytes;
  const own = await trust(selfSigned, [self.certificate]);
  assert.deepEqual([own.status, own.selfSigned, own.issuedBy], ["trusted", true, null]);
  assert.deepEqual([(await trust(selfSigned, [CERTS.rootCa])).status, (await trust(selfSigned, undefined)).selfSigned], ["untrusted", true]);
  const signature = await first(selfSigned, { trustedCertificates: [] });
  assert.deepEqual([signature.signerName, signature.signerCertificateCheck, signature.verdict], ["Người Tự Ký", "bound-by-signature", "valid"]);
  assert.deepEqual(codes(signature), [], "mathematically valid; who signed is a question for trust, not for the verdict");
});

test("inspect: byte ranges that do not cover the file as they must are errors although the mathematics holds", async () => {
  // the last 20 bytes of the file are outside the signed range
  const shortTail = await crafted({}, { patch: (prepared) => [0, prepared.byteRange[1], prepared.byteRange[2], prepared.byteRange[3] - 20] });
  const independent = readSignatures(shortTail)[0];
  assert.notEqual(independent.byteRange[2] + independent.byteRange[3], shortTail.length, "the independent reader sees that the range stops short");
  let signature = await first(shortTail);
  assert.deepEqual(facts(signature), [true, true, "partial", "invalid"]);
  assert.deepEqual(codes(signature), ["SIGN_COVERAGE_NOT_A_REVISION:error"]);
  assert.deepEqual([signature.coverage.startsAtZero, signature.coverage.gapMatchesContents, signature.coverage.bytesAfter], [true, true, 20]);
  // the unsigned gap is larger than /Contents: text hides in it
  const gap = await crafted({}, { patch: (prepared) => [0, prepared.byteRange[1] - 12, prepared.byteRange[2], prepared.byteRange[3]] });
  signature = await first(gap);
  assert.deepEqual(facts(signature), [true, true, "partial", "invalid"]);
  assert.deepEqual([signature.coverage.gapMatchesContents, codes(signature)], [false, ["SIGN_BYTE_RANGE_GAP_MISMATCH:error"]]);
  // the signed range does not start at byte 0
  const late = await crafted({}, { patch: (prepared) => [9, prepared.byteRange[1] - 9, prepared.byteRange[2], prepared.byteRange[3]] });
  signature = await first(late);
  assert.deepEqual([signature.digestMatches, signature.signatureValid, signature.coverage.startsAtZero, signature.verdict], [true, true, false, "invalid"]);
  assert.deepEqual(codes(signature), ["SIGN_BYTE_RANGE_NOT_FROM_START:error"]);
  // the control: the same construction with the honest range is fine
  assert.deepEqual(facts(await first(await crafted())), [true, true, "whole-file", "valid"]);
});

test("inspect: the /Contents value (placeholder, white space, foreign characters, trailing data, not ASN.1, not CMS)", async () => {
  let signature = await first(await crafted({}, { container: () => new Uint8Array(0) }));
  assert.deepEqual([codes(signature), signature.verdict, signature.trust.reason], [["SIGN_UNSIGNED_PLACEHOLDER:error"], "invalid", "not-evaluated"]);
  const paddingAt = (prepared) => prepared.contentsEnd - 9; // inside the zero padding, before ">"
  signature = await first(await crafted({}, { afterEmbed: (bytes, prepared) => bytes.set(fromLatin1("    "), paddingAt(prepared)) }));
  assert.deepEqual([facts(signature), codes(signature)], [[true, true, "whole-file", "valid-with-warnings"], ["SIGN_CONTENTS_NOT_PLAIN_HEX:warning"]]);
  signature = await first(await crafted({}, { afterEmbed: (bytes, prepared) => bytes.set(fromLatin1("zz"), paddingAt(prepared)) }));
  assert.deepEqual([signature.verdict, signature.problems[0]], ["invalid", { code: "SIGN_CONTENTS_NOT_HEX", severity: "error", params: { count: 2 } }]);
  signature = await first(await crafted({}, { afterEmbed: (bytes, prepared) => bytes.set(fromLatin1("ff"), paddingAt(prepared) - 1) }));
  assert.deepEqual([facts(signature), codes(signature), signature.contents.paddingAllZero], [[true, true, "whole-file", "valid-with-warnings"], ["SIGN_CONTENTS_TRAILING_DATA:warning"], false]);
  // a value that announces more bytes than /Contents holds
  signature = await first(await crafted({}, { container: () => Uint8Array.of(0x30, 0x84, 0x7f, 0xff, 0xff, 0xff) }));
  assert.deepEqual([codes(signature), signature.verdict], [["SIGN_CONTENTS_UNREADABLE:error"], "invalid"]);
  signature = await first(await crafted({}, { container: () => der.seq(der.oid(OIDS.data), der.ctx(0, der.octets(new Uint8Array(8)))) }));
  assert.deepEqual([codes(signature), signature.verdict, signature.contents.valueBytes], [["SIGN_CMS_UNREADABLE:error"], "invalid", 25]);
  // signature dictionaries that are not even shaped right (the scanner needs no valid PDF around them)
  const snippet = (dictionary) => new TextEncoder().encode(`%PDF-1.7\n1 0 obj\n${dictionary}\nendobj\n`);
  assert.deepEqual((await first(snippet("<< /Type /Sig /ByteRange [0 1 2 3 4 5] /Contents <00> >>"))).problems, [{ code: "SIGN_BYTE_RANGE_SHAPE", severity: "error", params: { count: 6 } }]);
  assert.deepEqual(codes(await first(snippet("<< /Type /Sig /ByteRange [0 10 20 30] /Contents 5 >>"))), ["SIGN_NO_CONTENTS:error"]);
  assert.deepEqual(codes(await first(snippet("<< /Type /Sig /ByteRange [0 10 20 9000] /Contents <3000> >>"))), ["SIGN_BYTE_RANGE_OUT_OF_FILE:error"]);
  // text that only looks like a byte range is listed apart, never as a signature
  const decoy = await inspect(new Uint8Array([...base.classic, ...fromLatin1("\n% /ByteRange [0 100 200 300]\n")]));
  assert.deepEqual([decoy.signatures.length, decoy.otherByteRanges.map((entry) => [entry.kind, entry.byteRange])], [0, [["unknown", [0, 100, 200, 300]]]]);
  // a hostile file with hundreds of byte ranges is cut off instead of keeping the page busy
  const many = await inspect(new TextEncoder().encode(`%PDF-1.7\n${"/ByteRange [0 1 2 3]\n".repeat(600)}`));
  assert.deepEqual([many.signatures.length, many.otherByteRanges.length, many.document.byteRangesSkipped], [0, 512, 88]);
});

test("inspect: containers as other products write them (no attributes, BER, embedded content, several signers)", async () => {
  // no signed attributes, leaf certificate only: valid, but nothing protects the certificate that names the signer
  const leafOnly = await crafted({ attributes: "none", certificates: [CERTS.signer1] });
  let signature = await first(leafOnly);
  assert.deepEqual(facts(signature), [true, true, "whole-file", "valid-with-warnings"]);
  assert.deepEqual([signature.signerCertificateCheck, codes(signature), signature.signedAttributes], ["unprotected", ["SIGN_SIGNER_NAME_UNPROTECTED:warning"], []]);
  assert.deepEqual([signature.trust.status, signature.signingTime.source, signature.contents.encoding], ["untrusted", "m-entry", "DER"]);
  assert.equal((await first(leafOnly, { trustedCertificates: [CERTS.intermediateCa] })).trust.status, "trusted");
  // with its issuer in the container the certificate is at least consistent
  signature = await first(await crafted({ attributes: "none" }));
  assert.deepEqual([facts(signature), signature.signerCertificateCheck, codes(signature), signature.trust.status], [[true, true, "whole-file", "valid"], "signed-by-included-issuer", [], "trusted"]);
  assert.deepEqual(signature.chain.map((certificate) => certificate.commonName), ["Nguyễn Văn An", "ANS Test Intermediate CA", "ANS Test Root CA"]);
  // BER with indefinite lengths
  signature = await first(await crafted({}, { container: (signed) => toBer(handMadeCms(signed, { ...SIGNER1, certificates: CHAIN })) }));
  assert.deepEqual([facts(signature), signature.contents.encoding, signature.contents.paddingAllZero], [[true, true, "whole-file", "valid"], "BER", true]);
  // "detached" in name only: the content travels in the container
  signature = await first(await crafted({ embedContent: true }, { prepare: { contentsBytes: 16384 } }));
  assert.deepEqual([facts(signature), codes(signature)], [[true, true, "whole-file", "valid-with-warnings"], ["SIGN_NOT_DETACHED:warning"]]);
  // a PDF signature has exactly one signer
  signature = await first(await crafted({ signerCount: 2 }));
  assert.deepEqual([facts(signature), signature.problems[0]], [[true, true, "whole-file", "valid-with-warnings"], { code: "SIGN_SIGNER_COUNT", severity: "warning", params: { count: 2 } }]);
  signature = await first(await crafted({ signerCount: 0 }));
  assert.deepEqual([facts(signature), codes(signature), signature.trust.reason], [[null, null, "whole-file", "invalid"], ["SIGN_SIGNER_COUNT:error"], "no-signer-certificate"]);
  // the signer certificate is not in the container
  signature = await first(await crafted({ certificates: [] }));
  assert.deepEqual([facts(signature), codes(signature)], [[true, null, "whole-file", "invalid"], ["SIGN_SIGNER_CERTIFICATE_MISSING:error"]]);
  // a PAdES signature without the signing-certificate attribute
  signature = await first(await crafted({}, { prepare: { subFilter: SUBFILTER_PADES } }));
  assert.deepEqual([facts(signature), codes(signature)], [[true, true, "whole-file", "valid-with-warnings"], ["SIGN_PADES_NO_SIGNING_CERTIFICATE:warning"]]);
});

test("inspect: signed attributes and algorithms (missing digest, content type, weak and unsupported hashes)", async () => {
  const without = (oid) => (list) => list.filter((entry) => entry.oid !== oid);
  let signature = await first(await crafted({ attributes: without(OIDS.messageDigest) }));
  assert.deepEqual([facts(signature), codes(signature)], [[false, true, "whole-file", "invalid"], ["SIGN_NO_MESSAGE_DIGEST:error", "SIGN_DOCUMENT_MODIFIED:error"]]);
  signature = await first(await crafted({ attributes: without(OIDS.contentType) }));
  assert.deepEqual([facts(signature), codes(signature)], [[true, true, "whole-file", "valid-with-warnings"], ["SIGN_NO_CONTENT_TYPE:warning"]]);
  signature = await first(await crafted({ attributes: (list) => list.map((entry) => (entry.oid === OIDS.contentType ? { ...entry, value: der.oid(OIDS.tstInfo) } : entry)) }));
  assert.deepEqual([signature.verdict, codes(signature)], ["invalid", ["SIGN_CONTENT_TYPE_MISMATCH:error"]]);
  // a digest over other bytes: the signature over the attributes verifies, the document does not match
  signature = await first(await crafted({ messageDigest: sha256(Buffer.from("another document")) }));
  assert.deepEqual([facts(signature), codes(signature)], [[false, true, "whole-file", "invalid"], ["SIGN_DOCUMENT_MODIFIED:error"]]);
  // SHA-1 (as most Vietnamese government documents use): verified, flagged as weak
  signature = await first(await crafted({ hash: "sha1" }));
  assert.deepEqual([facts(signature), signature.digestAlgorithm, signature.signatureAlgorithm], [[true, true, "whole-file", "valid-with-warnings"], "SHA-1", "sha1WithRSAEncryption"]);
  assert.deepEqual(signature.problems, [{ code: "SIGN_WEAK_DIGEST", severity: "warning", params: { algorithm: "SHA-1" } }]);
  // SHA-224: WebCrypto has no such hash, so nothing can be said about the digest
  signature = await first(await crafted({ hash: "sha224" }));
  assert.deepEqual([facts(signature), codes(signature)], [[null, null, "whole-file", "unknown"], ["SIGN_UNSUPPORTED_DIGEST:warning", "SIGN_CANNOT_VERIFY:warning"]]);
  // the digest is fine but the signature algorithm cannot be checked here: "unknown", never "valid"
  signature = await first(await crafted({ signatureHash: "sha224" }));
  assert.deepEqual(facts(signature), [true, null, "whole-file", "unknown"]);
  assert.deepEqual(signature.problems, [{ code: "SIGN_CANNOT_VERIFY", severity: "warning", params: { reason: "hash", name: "SHA-224" } }]);
  assert.deepEqual(signature.integrity, { digestMatches: true, signatureValid: null, ok: null, unsupported: { reason: "hash", name: "SHA-224" } });
});

test("inspect: an altered signer certificate: what can and what cannot be detected without a trust list", async () => {
  const nameHex = hex(new TextEncoder().encode("Nguyễn Văn An"));
  const forge = (bytes) => {
    const out = Uint8Array.from(bytes);
    const [, b, c] = readSignatures(bytes).at(-1).byteRange;
    const at = latin1(out).indexOf(nameHex, b);
    assert.ok(at > b && at < c, "the subject name sits in the certificate inside /Contents");
    out[at + nameHex.length - 1] = "d".charCodeAt(0); // "An" -> "Am": one letter of the name, the key untouched
    return out;
  };
  // 1. no attribute, leaf only: NOTHING in the file exposes the forged name; only a trust anchor settles it
  const forged = forge(await crafted({ attributes: "none", certificates: [CERTS.signer1] }));
  let signature = await first(forged);
  assert.equal(signature.signerName, "Nguyễn Văn Am");
  assert.deepEqual([facts(signature), codes(signature)], [[true, true, "whole-file", "valid-with-warnings"], ["SIGN_SIGNER_NAME_UNPROTECTED:warning"]]);
  assert.equal((await first(forged, { trustedCertificates: [] })).trust.status, "not-checked");
  assert.equal((await first(forged, { trustedCertificates: [CERTS.intermediateCa] })).trust.status, "untrusted");
  // 2. the issuer certificate is in the container: its signature exposes the change
  signature = await first(forge(await crafted({ attributes: "none" })));
  assert.deepEqual([signature.signerName, facts(signature), signature.signerCertificateCheck], ["Nguyễn Văn Am", [true, true, "whole-file", "invalid"], "failed"]);
  assert.deepEqual(signature.problems, [{ code: "SIGN_SIGNER_CERTIFICATE_ALTERED", severity: "error", params: { selfSigned: false } }]);
  // 3. the signing-certificate attribute (PAdES) binds the certificate to the signature
  signature = await first(forge(base.signed));
  assert.deepEqual([signature.signerName, signature.signingCertificateAttribute.matches, signature.verdict], ["Nguyễn Văn Am", false, "invalid"]);
  assert.ok(codes(signature).includes("SIGN_SIGNING_CERTIFICATE_MISMATCH:error"));
  // a CA certificate of the included chain altered (its validity): the link above it no longer verifies
  const chainBroken = Uint8Array.from(base.signed);
  const validity = hex(Buffer.from("360101000000Z")); // notAfter of the intermediate CA
  const at = latin1(chainBroken).indexOf(validity, readSignatures(base.signed)[0].byteRange[1]);
  assert.ok(at > 0);
  chainBroken[at + 3] = "5".charCodeAt(0); // "36" -> "35"
  signature = await first(chainBroken);
  assert.deepEqual([facts(signature), codes(signature), signature.trust.status], [[true, true, "whole-file", "valid-with-warnings"], ["SIGN_CHAIN_BROKEN:warning"], "untrusted"]);
});

test("inspect: legacy formats (adbe.pkcs7.sha1, adbe.x509.rsa_sha1), unknown subfilter, no signing time", async () => {
  const key = crypto.createPrivateKey({ key: Buffer.from(KEYS.signer1), format: "der", type: "pkcs8" });
  // adbe.pkcs7.sha1: the container signs the SHA-1 digest of the byte ranges, carried as its content
  const pkcs7Sha1 = await crafted({}, {
    prepare: { subFilter: SUBFILTER_PADES },
    patch: (prepared) => void replaceInPlace(prepared.bytes, "/SubFilter /ETSI.CAdES.detached", "/SubFilter /adbe.pkcs7.sha1"),
    container: (signed) => handMadeCms(crypto.createHash("sha1").update(signed).digest(), { ...SIGNER1, certificates: CHAIN, hash: "sha1", attributes: "none", embedContent: true })
  });
  let signature = await first(pkcs7Sha1);
  assert.deepEqual([signature.subFilter, facts(signature)], ["adbe.pkcs7.sha1", [true, true, "whole-file", "valid-with-warnings"]]);
  assert.deepEqual(codes(signature), ["SIGN_LEGACY_SUBFILTER:warning", "SIGN_WEAK_DIGEST:warning"]);
  const tamperedSha1 = Uint8Array.from(pkcs7Sha1);
  tamperedSha1[30] ^= 1;
  assert.deepEqual(facts(await first(tamperedSha1)), [false, true, "whole-file", "invalid"]);
  // adbe.x509.rsa_sha1: /Contents = OCTET STRING { PKCS#1 signature over the byte ranges }, certificate in /Cert
  const placeholder = "R".repeat(2 * CERTS.signer1.length);
  const x509 = await crafted({}, {
    prepare: { subFilter: SUBFILTER_PADES, reason: placeholder },
    patch: (prepared) => {
      replaceInPlace(prepared.bytes, "/SubFilter /ETSI.CAdES.detached", "/SubFilter /adbe.x509.rsa_sha1");
      replaceInPlace(prepared.bytes, `/Reason (${placeholder})`, `/Cert <${hex(CERTS.signer1)}>`);
    },
    container: (signed) => der.octets(crypto.sign("sha1", signed, key))
  });
  signature = await first(x509);
  assert.deepEqual([signature.subFilter, facts(signature), signature.signerName], ["adbe.x509.rsa_sha1", [true, true, "whole-file", "valid-with-warnings"], "Nguyễn Văn An"]);
  assert.deepEqual([codes(signature), signature.contents.encoding, signature.integrity.singleCheck], [["SIGN_LEGACY_SUBFILTER:warning", "SIGN_SIGNER_NAME_UNPROTECTED:warning"], "PKCS1", true]);
  const tamperedX509 = Uint8Array.from(x509);
  tamperedX509[30] ^= 1;
  assert.deepEqual(facts(await first(tamperedX509)), [false, false, "whole-file", "invalid"]);
  // an unknown subfilter is read as a detached CMS signature, with a warning
  signature = await first(await crafted({}, { prepare: { subFilter: SUBFILTER_PADES }, patch: (prepared) => void replaceInPlace(prepared.bytes, "/ETSI.CAdES.detached", "/ETSI.CAdES.detachex") }));
  assert.deepEqual([facts(signature), signature.problems[0]], [[true, true, "whole-file", "valid-with-warnings"], { code: "SIGN_UNKNOWN_SUBFILTER", severity: "warning", params: { subFilter: "ETSI.CAdES.detachex" } }]);
  // neither /M nor a signing-time attribute
  signature = await first(await crafted({}, { patch: (prepared, text) => void replaceInPlace(prepared.bytes, /\/M \(D:[^)]*\)/.exec(text.slice(prepared.originalLength))[0], "") }));
  assert.deepEqual([facts(signature), codes(signature), signature.signingTime.value, signature.certificateValidAtSigningTime], [[true, true, "whole-file", "valid"], ["SIGN_NO_SIGNING_TIME:info"], null, null]);
});

test("inspect: document timestamps (ETSI.RFC3161)", async () => {
  const stamp = (options) => crafted({}, {
    prepare: { subFilter: SUBFILTER_PADES },
    patch: (prepared) => void replaceInPlace(prepared.bytes, "/SubFilter /ETSI.CAdES.detached", "/SubFilter /ETSI.RFC3161"),
    container: async (signed) => {
      const imprint = new Uint8Array(sha256(signed));
      // the token is cut out of the response by hand: the product's reader of responses would refuse the odd ones
      const response = Buffer.from(await fakeTsa(SIGNER1, options).request(buildTimeStampRequest(imprint)));
      return new Uint8Array(derRaw(response, derChildren(response, derAt(response, 0))[1]));
    }
  });
  const stamped = await stamp();
  let signature = await first(stamped);
  assert.deepEqual([signature.kind, signature.subFilter, facts(signature)], ["document-timestamp", "ETSI.RFC3161", [true, true, "whole-file", "valid-with-warnings"]]);
  assert.deepEqual(codes(signature), ["SIGN_TSA_CERTIFICATE_USAGE:warning"]);
  assert.deepEqual([signature.timestamp.kind, signature.timestamp.ok, signature.timestamp.identityVerified, signature.signingTime.source, signature.signingTime.proven], ["document", true, false, "document-timestamp", true]);
  assert.deepEqual([signature.signingTime.value, signature.signerName], ["2026-11-16T02:00:00.000Z", "Nguyễn Văn An"]);
  // the document changed after the timestamp
  const tampered = Uint8Array.from(stamped);
  tampered[60] ^= 1;
  signature = await first(tampered);
  assert.deepEqual([signature.digestMatches, signature.verdict], [false, "invalid"]);
  assert.ok(codes(signature).includes("SIGN_TIMESTAMP_IMPRINT_MISMATCH:error") && codes(signature).includes("SIGN_DOCUMENT_MODIFIED:error"));
  // an imprint algorithm that cannot be computed here: not verified, never "valid"
  signature = await first(await stamp({ imprintHash: "sha224" }));
  assert.deepEqual([signature.digestMatches, signature.verdict], [null, "unknown"]);
  assert.ok(codes(signature).includes("SIGN_TIMESTAMP_UNSUPPORTED_DIGEST:warning"));
});

test("inspect: an unsigned revision after the signature: what changed decides the verdict", async () => {
  const { PDFNumber, PDFString, PDFBool } = pdfLib;
  const after = async (edit, input = base.signed) => first(await appendRevision(input, edit));
  // page content replaced
  const changed = await appendContentRevision(base.signed);
  let signature = await first(changed);
  assert.deepEqual(facts(signature), [true, true, "revision", "document-changed"]);
  assert.deepEqual(signature.problems, [{ code: "SIGN_CHANGED_AFTER_SIGNING", severity: "warning", params: { bytesAfter: changed.length - base.signed.length, laterRevisions: 1 } }]);
  assert.deepEqual([signature.changesAfterSigning.classification, changeCodes(signature)], ["other", ["-SIGN_CHANGE_PAGE_CONTENT"]]);
  assert.deepEqual(signature.changesAfterSigning.items[0].params, { page: 1 });
  assert.deepEqual([verifyIndependently(changed, 0).digestOk, verifyIndependently(changed, 0).signatureOk], [true, true]);
  assert.ok(sameBytes(signedRevisionBytes(changed, signature), base.signed), "the signed version can still be shown");
  // without the comparison the revisions cannot be told apart: still flagged, never called valid
  const blind = await first(changed, { analyzeChanges: false });
  assert.deepEqual([blind.changesAfterSigning.classification, blind.changesAfterSigning.reason, blind.verdict], ["unknown", "not-compared", "document-changed"]);
  // the same on a file with cross-reference streams
  assert.deepEqual(facts(await first(await appendContentRevision(base.signedStream))), [true, true, "revision", "document-changed"]);

  // other changes of the document itself
  signature = await after(({ context, pages, name, allocate }) => {
    const annot = allocate();
    context.lookup(pages[0].dict.get(name("Annots"))).push(annot);
    return { rewrite: [pages[0].ref], add: [{ ref: annot, body: "<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (note) >>" }] };
  });
  assert.deepEqual([signature.verdict, changeCodes(signature)], ["document-changed", ["-SIGN_CHANGE_ANNOTATION_ADDED"]]);
  signature = await after(({ pages, name }) => {
    pages[1].dict.set(name("Rotate"), PDFNumber.of(180));
    return { rewrite: [pages[1].ref] };
  });
  assert.deepEqual([changeCodes(signature), signature.changesAfterSigning.items[0].params], [["-SIGN_CHANGE_PAGE_ENTRY"], { page: 2, key: "Rotate" }]);
  signature = await after(({ context, catalog, catalogRef, pages, name }) => {
    catalog.set(name("OpenAction"), context.obj([pages[0].ref, "Fit"]));
    return { rewrite: [catalogRef] };
  });
  assert.deepEqual([signature.verdict, changeCodes(signature), signature.changesAfterSigning.items[0].params], ["document-changed", ["-SIGN_CHANGE_CATALOG_OTHER_ENTRY"], { key: "OpenAction" }]);
  signature = await after(({ context, catalog, name, allocate }) => {
    const pagesRef = catalog.get(name("Pages"));
    const tree = context.lookup(pagesRef);
    const page = allocate();
    context.lookup(tree.get(name("Kids"))).push(page);
    tree.set(name("Count"), PDFNumber.of(3));
    return { rewrite: [pagesRef], add: [{ ref: page, body: `<< /Type /Page /Parent ${pagesRef} /MediaBox [0 0 100 100] >>` }] };
  });
  assert.deepEqual([signature.verdict, changeCodes(signature)], ["document-changed", ["-SIGN_CHANGE_PAGE_COUNT", "-SIGN_CHANGE_OBJECT"]]);
  assert.deepEqual([signature.changesAfterSigning.items[0].params, signature.changesAfterSigning.items[1].params.objectType], [{ before: 2, after: 3 }, "Pages"]);
  signature = await after(({ context, catalog, name, allocate, pages }) => {
    const pagesRef = catalog.get(name("Pages"));
    const replacement = allocate();
    context.lookup(context.lookup(pagesRef).get(name("Kids"))).set(0, replacement);
    return { rewrite: [pagesRef], add: [{ ref: replacement, body: pages[0].dict }] };
  });
  assert.ok(changeCodes(signature).includes("-SIGN_CHANGE_PAGE_REPLACED"));
  signature = await after(({ catalog, allocate }) => {
    const replacement = allocate();
    return { root: replacement, add: [{ ref: replacement, body: catalog }] };
  });
  assert.deepEqual([signature.verdict, changeCodes(signature)], ["document-changed", ["-SIGN_CHANGE_CATALOG_REPLACED"]]);

  // the form
  const formRef = ({ catalog, name }) => catalog.get(name("AcroForm"));
  signature = await after((tools) => {
    const { context, name, allocate } = tools;
    const field = allocate();
    context.lookup(context.lookup(formRef(tools)).get(name("Fields"))).push(field);
    return { rewrite: [formRef(tools)], add: [{ ref: field, body: "<< /FT /Tx /T (Comment) /V (added later) >>" }] };
  });
  assert.deepEqual([signature.verdict, changeCodes(signature)], ["document-changed", ["-SIGN_CHANGE_FIELD_ADDED"]]);
  signature = await after((tools) => {
    tools.context.lookup(formRef(tools)).set(tools.name("NeedAppearances"), PDFBool.True);
    return { rewrite: [formRef(tools)] };
  });
  assert.deepEqual([changeCodes(signature), signature.changesAfterSigning.items[0].params], [["-SIGN_CHANGE_FORM_ENTRY"], { key: "NeedAppearances" }]);
  signature = await after(({ catalog, catalogRef, name }) => {
    catalog.delete(name("AcroForm"));
    return { rewrite: [catalogRef] };
  });
  assert.deepEqual([changeCodes(signature), signature.referencedByCurrentDocument], [["-SIGN_CHANGE_FORM_REPLACED"], false]);
  // the signature taken out of the form and off the page: found by the byte scan, invisible to a field walk
  signature = await after((tools) => {
    const { context, pages, name } = tools;
    context.lookup(formRef(tools)).set(name("Fields"), context.obj([]));
    pages[0].dict.set(name("Annots"), context.obj([]));
    return { rewrite: [formRef(tools), pages[0].ref] };
  });
  assert.deepEqual([signature.fieldName, signature.fieldNameSource, signature.referencedByCurrentDocument, facts(signature)], [null, "none", false, [true, true, "revision", "document-changed"]]);
  assert.deepEqual(codes(signature), ["SIGN_CHANGED_AFTER_SIGNING:warning", "SIGN_NOT_REFERENCED:warning"]);
  assert.deepEqual(changeCodes(signature).sort(), ["-SIGN_CHANGE_ANNOTATION_REMOVED", "-SIGN_CHANGE_FIELD_REMOVED"]);

  // changes that signing itself may make: the signature stays valid
  signature = await after(({ catalog, catalogRef, name }) => {
    catalog.set(name("Version"), name("1.7"));
    return { rewrite: [catalogRef] };
  });
  assert.deepEqual([facts(signature), changeCodes(signature), codes(signature)], [[true, true, "revision", "valid"], ["+SIGN_CHANGE_CATALOG_ENTRY"], ["SIGN_LATER_REVISIONS:info"]]);
  signature = await after(({ context, infoRef, name }) => {
    context.lookup(infoRef).set(name("Title"), PDFString.of("changed"));
    return { rewrite: [infoRef] };
  });
  assert.deepEqual([signature.verdict, changeCodes(signature), signature.changesAfterSigning.items[0].params], ["valid", ["+SIGN_CHANGE_METADATA"], { what: "info" }]);
  signature = await after(({ catalog, catalogRef, name, allocate }) => {
    const dss = allocate();
    catalog.set(name("DSS"), dss);
    return { rewrite: [catalogRef], add: [{ ref: dss, body: "<< /Type /DSS /Certs [] >>" }] };
  });
  assert.deepEqual([signature.verdict, changeCodes(signature), signature.changesAfterSigning.onlyValidationData], ["valid", ["+SIGN_CHANGE_VALIDATION_DATA"], true]);
});

test("inspect: cross-reference data after the signature that changes the document without changing an object", async () => {
  const { PDFName, PDFArray } = pdfLib;
  const numbersOf = async (bytes) => {
    const doc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
    const page = doc.getPages()[0];
    const contents = page.node.get(PDFName.of("Contents"));
    return { page: page.ref.objectNumber, content: (contents instanceof PDFArray ? contents.get(0) : contents).objectNumber };
  };
  /** What pdf.js (a viewer that follows the cross-reference data) makes of page 1. */
  const shown = (bytes) => withPdf(bytes, async (doc) => {
    const page = await doc.getPage(1);
    return { text: await pageText(page), operators: (await page.getOperatorList()).fnArray.length };
  });
  const expectChanged = async (bytes, items, label) => {
    const signature = await first(bytes);
    assert.deepEqual(facts(signature), [true, true, "revision", "document-changed"], label);
    assert.deepEqual(signature.changesAfterSigning.items, items, label);
    assert.deepEqual([verifyIndependently(bytes, 0).digestOk, verifyIndependently(bytes, 0).signatureOk], [true, true], "the signed bytes themselves are untouched");
    assert.ok(sameBytes(signedRevisionBytes(bytes, signature), bytes.subarray(0, signature.coverage.signedEnd)));
  };
  const xrefItem = (reason, object = null) => [{ code: "SIGN_CHANGE_XREF", params: { reason, object }, allowed: false }];
  const removedItem = (object) => [{ code: "SIGN_CHANGE_OBJECT_REMOVED", params: { object }, allowed: false }];
  assert.ok((await shown(base.signed)).text.includes("Amount: 1000 USD"));

  // 1. an entry marks the content stream of page 1 as free: no object is added or changed, the page is empty
  const classic = await numbersOf(base.signed);
  const freed = appendRaw(base.signed, (start, facts) => xrefTable(start, facts, [[classic.content, 0, 1, "f"]]));
  assert.equal((await shown(freed)).text, "", "pdf.js shows an empty first page");
  await expectChanged(freed, removedItem(`${classic.content} 0`), "free entry in a table");
  // the same in a cross-reference stream: type 0, and a type the format does not define (= the null object)
  const stream = await numbersOf(base.signedStream);
  const freedInStream = appendRaw(base.signedStream, (start, facts) => xrefStream(start, facts, [[stream.content, 0, 0, 1]]));
  assert.equal((await shown(freedInStream)).text, "");
  await expectChanged(freedInStream, removedItem(`${stream.content} 0`), "free entry in a stream");
  await expectChanged(appendRaw(base.signedStream, (start, facts) => xrefStream(start, facts, [[stream.content, 3, 0, 0]], { compress: true })), removedItem(`${stream.content} 0`), "undefined entry type");

  // control: a revision that only rewrites the document information, with its cross-reference stream written
  // as Acrobat does (deflated, PNG predictor), is still signature-neutral ...
  const harmless = appendRaw(base.signedStream, (start, facts) => {
    const info = `${facts.info.objectNumber} 0 obj\n<< /Title (changed) >>\nendobj\n`;
    return info + xrefStream(start + info.length, facts, [[facts.info.objectNumber, 1, start, 0]], { compress: true });
  });
  let signature = await first(harmless);
  assert.deepEqual([facts(signature), changeCodes(signature), codes(signature)], [[true, true, "revision", "valid"], ["+SIGN_CHANGE_METADATA"], ["SIGN_LATER_REVISIONS:info"]]);
  // the same change written the way xref-stream documents are usually extended: the object sits in a new
  // object stream and its entry is of the compressed kind
  const viaObjectStream = appendRaw(base.signedStream, (start, facts) => {
    const container = objectStream(facts.size, [[facts.info.objectNumber, "<< /Title (changed) >>"]]);
    return container + xrefStream(start + container.length, facts, [[facts.info.objectNumber, 2, facts.size, 0], [facts.size, 1, start, 0]], { number: facts.size + 1, compress: true });
  });
  signature = await first(viaObjectStream);
  assert.deepEqual([facts(signature), changeCodes(signature)], [[true, true, "revision", "valid"], ["+SIGN_CHANGE_METADATA"]]);
  // a compressed entry for the page object whose new definition (no /Contents) hides in an object stream, while
  // a copy of the signed page object follows it as an ordinary object: a parser in file order keeps the copy
  const streamText = latin1(base.signedStream);
  const pageAt = streamText.lastIndexOf(`\n${stream.page} 0 obj\n`) + 1;
  const pageObject = streamText.slice(pageAt, streamText.indexOf("endobj", pageAt) + 7);
  const pageDict = pageObject.slice(pageObject.indexOf("\n") + 1, pageObject.lastIndexOf("\nendobj"));
  assert.ok(pageDict.includes("/Contents"));
  const hiddenPage = appendRaw(base.signedStream, (start, facts) => {
    const container = objectStream(facts.size, [[stream.page, pageDict.replace("/Contents", "/Contentz")]]);
    const body = container + pageObject;
    return body + xrefStream(start + body.length, facts, [[stream.page, 2, facts.size, 0], [facts.size, 1, start, 0]], { number: facts.size + 1 });
  });
  assert.equal((await shown(hiddenPage)).text, "", "pdf.js takes the page from the object stream");
  await expectChanged(hiddenPage, xrefItem("ambiguous", `${stream.page} 0`), "definition inside a new object stream");
  // a compressed entry that points an object at another place of an object stream of the signed part
  await expectChanged(
    appendRaw(base.signedStream, (start, facts) => xrefStream(start, facts, [[facts.info.objectNumber, 2, 1, 0]])),
    xrefItem("redirected", `${readLastXrefSection(base.signedStream).info.objectNumber} 0`),
    "compressed entry into the signed part"
  );
  // ... and a section that cannot be read is not waved through
  const garbled = appendRaw(base.signedStream, (start, facts) => xrefStream(start, facts, []).replace("/W [1 4 2]", "/W [1 9 2]"));
  await expectChanged(garbled, xrefItem("unreadable"), "unreadable section");

  // 2. an entry points the page object back at its definition in an OLDER revision of the signed part
  const twoRevisions = await appendContentRevision(base.classic, "SIGNED TEXT");
  const signedTwo = (await signPdf(twoRevisions, { signer: signers.rsa, signingTime: SIGNED_AT })).bytes;
  const oldPage = latin1(base.classic).indexOf(`\n${classic.page} 0 obj`) + 1;
  const rolledBack = appendRaw(signedTwo, (start, facts) => xrefTable(start, facts, [[classic.page, oldPage, 0, "n"]]));
  assert.deepEqual([(await shown(signedTwo)).text.includes("Amount: 1000 USD"), (await shown(rolledBack)).text.includes("Amount: 1000 USD")], [false, true], "pdf.js shows the replaced text again");
  await expectChanged(rolledBack, xrefItem("redirected", `${classic.page} 0`), "entry into the signed part");
  // a repeated entry that says what the signed revision said changes nothing
  const samePage = latin1(signedTwo).lastIndexOf(`\n${classic.page} 0 obj`) + 1;
  signature = await first(appendRaw(signedTwo, (start, facts) => xrefTable(start, facts, [[classic.page, samePage, 0, "n"]])));
  assert.deepEqual([facts(signature), signature.changesAfterSigning.items], [[true, true, "revision", "valid"], []]);

  // 3. two definitions after the signature: the cross-reference entry names the first, a parser that reads the
  //    file in order keeps the second (a copy of the signed one)
  const text = latin1(base.signed);
  const at = text.indexOf(`\n${classic.content} 0 obj`) + 1;
  const copy = text.slice(at, text.indexOf("endobj", at) + 7);
  const paint = "1 0 0 rg 100 100 300 300 re f";
  const other = `${classic.content} 0 obj\n<< /Length ${paint.length} >>\nstream\n${paint}\nendstream\nendobj\n`;
  const twice = appendRaw(base.signed, (start, facts) => `${other}${copy}${xrefTable(start + other.length + copy.length, facts, [[classic.content, start, 0, "n"]])}`);
  assert.equal((await shown(twice)).text, "", "pdf.js follows the entry to the first definition");
  await expectChanged(twice, xrefItem("ambiguous", `${classic.content} 0`), "two definitions");

  // 4. the chain: a last startxref that points back at the unsigned first revision, a section without /Prev
  const pointsBack = appendRaw(signedTwo, () => `startxref\n${readLastXrefSection(base.classic).offset}\n%%EOF\n`);
  assert.ok((await shown(pointsBack)).text.includes("Amount: 1000 USD"), "pdf.js shows the first revision");
  await expectChanged(pointsBack, xrefItem("chain"), "startxref into an older revision");
  await expectChanged(appendRaw(base.signed, (start, facts) => xrefTable(start, facts, [], { prev: null })), xrefItem("chain"), "no /Prev");
  // some writers repeat the WHOLE table in an update and end the chain with "/Prev 0" (seen in real files):
  // nothing is lost as long as every entry says what the signed revision said
  const wholeTable = (alter) => appendRaw(base.signed, (start, facts) => {
    const info = `${facts.info.objectNumber} 0 obj\n<< /Title (changed) >>\nendobj\n`;
    const offsets = new Map();
    for (const match of latin1(base.signed).matchAll(/(?:^|\n)(\d+) 0 obj\n/g)) offsets.set(Number(match[1]), match.index + (match[0].startsWith("\n") ? 1 : 0));
    offsets.set(facts.info.objectNumber, start);
    alter(offsets);
    return info + xrefTable(start + info.length, facts, [...offsets].map(([number, offset]) => [number, offset, 0, "n"]), { prev: 0 });
  });
  signature = await first(wholeTable(() => {}));
  assert.deepEqual([facts(signature), changeCodes(signature)], [[true, true, "revision", "valid"], ["+SIGN_CHANGE_METADATA"]]);
  const metadataItem = { code: "SIGN_CHANGE_METADATA", params: { what: "info" }, allowed: true };
  await expectChanged(wholeTable((offsets) => offsets.delete(classic.content)), [metadataItem, ...xrefItem("chain")], "whole table without the content stream");
  await expectChanged(wholeTable((offsets) => offsets.set(classic.page, latin1(base.signed).indexOf(`\n${classic.page} 0 obj`) + 1)), [metadataItem, ...xrefItem("chain")], "whole table with an older page");
  // a last startxref that repeats the signed one is only noise
  signature = await first(appendRaw(base.signed, (start, facts) => `startxref\n${facts.offset}\n%%EOF\n`));
  assert.deepEqual([signature.verdict, signature.changesAfterSigning.items], ["valid", []]);

  // 5. the trailer: another catalog (hidden from a parser by a second trailer after it), encryption switched on
  const catalogs = appendRaw(base.signed, (start, facts) => {
    const catalog = `${facts.size} 0 obj\n<< /Type /Catalog /Pages 999 0 R >>\nendobj\n`;
    const used = xrefTable(start + catalog.length, facts, [[facts.size, start, 0, "n"]], { size: facts.size + 1, root: `${facts.size} 0 R`, startxref: false });
    const decoy = xrefTable(0, facts, [], { size: facts.size + 1, startxref: false });
    return `${catalog}${used}${decoy}startxref\n${start + catalog.length}\n%%EOF\n`;
  });
  signature = await first(catalogs);
  assert.deepEqual([signature.verdict, changeCodes(signature)], ["document-changed", ["-SIGN_CHANGE_CATALOG_REPLACED"]]);
  const encrypting = appendRaw(base.signed, (start, facts) => xrefTable(start, facts, [], { extra: " /Encrypt << /Filter /Standard /V 1 /R 2 /O (o) /U (u) /P -4 >>" }));
  signature = await first(encrypting);
  assert.deepEqual([signature.verdict, signature.changesAfterSigning.items], ["document-changed", xrefItem("encryption")]);

  // 6. the signed page refers to an object that does not exist; a later revision supplies it
  const doc = await pdfLib.PDFDocument.load(base.classic, { updateMetadata: false });
  doc.getPages()[0].node.get(PDFName.of("Contents")).push(pdfLib.PDFRef.of(50, 0));
  const dangling = await signPdf(await doc.save({ useObjectStreams: false }), { signer: signers.rsa, signingTime: SIGNED_AT });
  assert.ok(dangling.report.newObjectNumbers.every((number) => number > 50), "the signer stays clear of numbers the document already refers to");
  assert.equal((await first(dangling.bytes)).verdict, "valid");
  const supplied = await appendRevision(dangling.bytes, ({ ref }) => ({ add: [{ ref: ref(50), body: `<< /Length ${paint.length} >>\nstream\n${paint}\nendstream` }] }));
  assert.ok((await shown(supplied)).operators > (await shown(dangling.bytes)).operators, "pdf.js now paints the supplied content");
  await expectChanged(supplied, [{ code: "SIGN_CHANGE_DANGLING_REFERENCE", params: { object: "50 0" }, allowed: false }], "dangling reference");

  // 7. a hostile revision: many entries, each pointing at the start of a stream (hidden inside the data of
  //    one real stream) whose end would have to be searched for in megabytes of filler. The comparison gives up
  //    within its budget instead of keeping the page busy.
  const hostile = appendRaw(base.signed, (start, facts) => {
    const fakes = Array.from({ length: 48 }, (unused, i) => `${facts.size + 1 + i} 0 obj\n<< >>\nstream\n`);
    const data = `${fakes.join("")}${"x".repeat(2 * 1024 * 1024)}`;
    const head = `${facts.size} 0 obj\n<< /Length ${data.length} >>\nstream\n`;
    const entries = [[facts.size, start, 0, "n"]];
    let at = start + head.length;
    for (const [i, fake] of fakes.entries()) {
      entries.push([facts.size + 1 + i, at, 0, "n"]);
      at += fake.length;
    }
    const body = `${head}${data}\nendstream\nendobj\n`;
    return body + xrefTable(start + body.length, facts, entries, { size: facts.size + 49 });
  });
  const startedAt = performance.now();
  signature = await first(hostile);
  assert.ok(performance.now() - startedAt < 10000, "bounded work");
  assert.deepEqual([facts(signature), signature.changesAfterSigning.items.at(-1)], [[true, true, "revision", "document-changed"], xrefItem("unreadable")[0]]);
  assert.ok(signature.changesAfterSigning.items.length < 48, "the audit stopped before the last entry");
});

test("inspect: a signed document that is encrypted: the mathematics needs no password, the strings do", async () => {
  const encrypted = await makeEncryptedSignedPdf({ userPassword: "userpw", reason: "Đồng ý", container: (signed) => handMadeCms(signed, { ...SIGNER1, certificates: CHAIN }) });
  assert.ok(!latin1(encrypted).includes("Signature1"), "the field name is ciphertext in the file");
  for (const password of [undefined, "wrong password"]) {
    const result = await inspect(encrypted, { password });
    const [signature] = result.signatures;
    assert.deepEqual([result.document.encrypted, result.document.parser.decryptedStrings, result.signatures.length], [true, false, 1]);
    assert.deepEqual(facts(signature), [true, true, "whole-file", "valid"]);
    assert.deepEqual(codes(signature), ["SIGN_ENCRYPTED_STRINGS:info", "SIGN_NO_SIGNING_TIME:info"]);
    assert.deepEqual([signature.encryptedStrings, signature.reason, signature.fieldName, signature.fieldNameSource, signature.signerName], [true, null, null, "encrypted", "Nguyễn Văn An"]);
    assert.equal(signature.trust.status, "trusted");
  }
  const opened = await inspect(encrypted, { password: "userpw" });
  const [signature] = opened.signatures;
  assert.deepEqual([opened.document.encrypted, opened.document.parser.decryptedStrings], [true, true]);
  assert.deepEqual(facts(signature), [true, true, "whole-file", "valid"]);
  assert.deepEqual([signature.reason, signature.fieldName, signature.fieldNameSource, codes(signature)], ["Đồng ý", "Signature1", "acroform", []]);
  assert.deepEqual([signature.signingTime.source, signature.signingTime.value], ["m-entry", "2026-11-16T01:00:00.000Z"]);
  // the signer refuses such a document instead of writing an update it cannot encrypt
  assert.deepEqual((await inspectPdf(encrypted)).blockers, ["SIGN_ENCRYPTED"]);
});

test("inspect: an empty signature field signed later, and a field altered while being signed", async () => {
  const form = await makeFormPdf({ fields: [{ name: "Approval", rect: [300, 500, 450, 550] }] });
  const one = (await signPdf(form, { signer: signers.rsa, signingTime: SIGNED_AT })).bytes;
  const two = (await signPdf(one, { signer: signers.rsa2, signingTime: SIGNED_AT, fieldName: "Approval" })).bytes;
  const result = await inspect(two);
  assert.deepEqual(result.signatures.map((signature) => [signature.fieldName, signature.verdict]), [["Signature1", "valid"], ["Approval", "valid"]]);
  assert.deepEqual(changeCodes(result.signatures[0]), ["+SIGN_CHANGE_SIGNATURE_FIELD_FILLED"]);
  assert.deepEqual(result.unsignedFields, []);
  assert.deepEqual((await inspect(one)).unsignedFields, [{ name: "Approval", pageIndex: 0, rect: [300, 500, 450, 550], visible: true }]);
  // a revision that gives the field a value AND renames it: not signature maintenance
  const altered = await appendRevision(one, ({ context, catalog, name, allocate }) => {
    const fields = context.lookup(context.lookup(catalog.get(name("AcroForm"))).get(name("Fields")));
    const value = allocate();
    const field = context.lookup(fields.get(0));
    field.set(name("V"), value);
    field.set(name("T"), pdfLib.PDFString.of("Renamed"));
    return { rewrite: [fields.get(0)], add: [{ ref: value, body: "<< /Type /Sig /Filter /Adobe.PPKLite >>" }] };
  });
  const signature = await first(altered);
  assert.deepEqual([signature.verdict, changeCodes(signature), signature.changesAfterSigning.items[0].params], ["document-changed", ["-SIGN_CHANGE_SIGNATURE_FIELD_ALTERED"], { keys: ["T"] }]);
});

test("inspect: a certification with \"no changes allowed\" followed by another signature is a violation", async () => {
  const certified = (await signPdf(base.classic, { signer: signers.rsa, signingTime: SIGNED_AT, certify: 1 })).bytes;
  // the signer refuses to extend such a document, so the second revision is built on a copy that claims level
  // 2 and the original byte is put back before the second signature is computed
  const level = latin1(certified).lastIndexOf("/P 1 /V /1.2") + 3;
  const pretending = Uint8Array.from(certified);
  pretending[level] = "2".charCodeAt(0);
  const second = { certificate: signers.rsa2.certificate, chain: signers.rsa2.chain, privateKey: signers.rsa2.privateKey };
  const violated = await craftSignedPdf(pretending, {
    prepare: { subFilter: SUBFILTER_PADES, signingTime: new Date("2026-11-16T02:00:00Z") },
    patch: (prepared) => void (prepared.bytes[level] = "1".charCodeAt(0)),
    container: async (signed) => (await createCms({ documentDigest: new Uint8Array(sha256(signed)), signer: second })).der
  });
  assert.ok(sameBytes(violated.subarray(0, certified.length), certified));
  const result = await inspect(violated);
  const [one, two] = result.signatures;
  assert.deepEqual([one.isCertification, one.docMdp.level, facts(one)], [true, 1, [true, true, "revision", "invalid"]]);
  assert.deepEqual(codes(one), ["SIGN_LATER_REVISIONS:info", "SIGN_DOCMDP_VIOLATION:error"]);
  assert.deepEqual(facts(two), [true, true, "whole-file", "valid"]);
  assert.deepEqual(result.document.certification, { fieldName: "Signature1", level: 1 });
  assert.deepEqual((await inspectPdf(violated)).blockers, ["SIGN_CERTIFIED_NO_CHANGES"]);
});

test("inspect: the certificate at the signing time, and what its own content says about signing", async () => {
  const sign = async (signer, signingTime) => first((await signPdf(base.classic, { signer, signingTime })).bytes, { trustedCertificates: [] });
  // a certificate that had expired years before the (claimed) signing time
  const old = await createSelfSigned({ commonName: "Đỗ Hết Hạn", keyType: "P-256", years: 1, now: new Date("2020-01-01T00:00:00Z") });
  let signature = await sign(old, SIGNED_AT);
  assert.deepEqual([facts(signature), signature.certificateValidAtSigningTime], [[true, true, "whole-file", "invalid"], false]);
  assert.deepEqual(signature.problems, [{ code: "CERT_EXPIRED_AT_SIGNING", severity: "error", params: { notAfter: "2020-12-31T23:55:00.000Z" } }]);
  // signed while it was valid, expired since: information, and the time is only the signer's claim
  signature = await sign(old, new Date("2020-06-01T00:00:00Z"));
  assert.deepEqual([facts(signature), signature.certificateValidAtSigningTime, signature.certificateValidNow], [[true, true, "whole-file", "valid"], true, false]);
  assert.deepEqual(signature.problems, [{ code: "CERT_EXPIRED_SINCE", severity: "info", params: { notAfter: "2020-12-31T23:55:00.000Z", timeProven: false } }]);
  const notYet = await createSelfSigned({ commonName: "Chưa có hiệu lực", keyType: "P-256", now: new Date("2030-01-01T00:00:00Z") });
  signature = await sign(notYet, SIGNED_AT);
  assert.deepEqual([signature.verdict, codes(signature)], ["invalid", ["CERT_NOT_YET_VALID_AT_SIGNING:error"]]);
  // certificates other tools issue: a short key, a weak certificate signature, usages that exclude signing
  const withCertificate = async (options) => {
    const made = makeTestCertificate(options);
    return first(await crafted({ certificate: made.certificate, privateKeyPkcs8: made.privateKeyPkcs8, certificates: [made.certificate] }), { trustedCertificates: [] });
  };
  signature = await withCertificate({ commonName: "Short key", modulusLength: 1024 });
  assert.deepEqual([facts(signature), signature.signerCertificateCheck], [[true, true, "whole-file", "valid-with-warnings"], "self-signed"]);
  assert.deepEqual(signature.problems, [{ code: "CERT_WEAK_KEY", severity: "warning", params: { bits: 1024 } }]);
  signature = await withCertificate({ commonName: "Weak certificate signature", hash: "sha1" });
  assert.deepEqual(signature.problems, [{ code: "CERT_WEAK_SIGNATURE_ALGORITHM", severity: "warning", params: { algorithm: "sha1WithRSAEncryption" } }]);
  signature = await withCertificate({ commonName: "Encryption only", keyUsage: [0x20, 5] });
  assert.deepEqual(codes(signature), ["CERT_KEY_USAGE_NO_SIGNING:warning"]);
  signature = await withCertificate({ commonName: "Server", extendedKeyUsage: ["1.3.6.1.5.5.7.3.1"] });
  assert.deepEqual([codes(signature), signature.signerCertificate.extendedKeyUsage], [["CERT_EKU_NOT_FOR_SIGNING:warning"], ["serverAuth"]]);
  // a self-signed certificate whose own signature does not verify (its content was altered)
  const made = makeTestCertificate({ commonName: "Altered self-signed" });
  const alteredCertificate = Uint8Array.from(made.certificate);
  alteredCertificate[alteredCertificate.length - 20] ^= 1;
  signature = await first(await crafted({ certificate: made.certificate, privateKeyPkcs8: made.privateKeyPkcs8, certificates: [alteredCertificate] }), { trustedCertificates: [] });
  assert.deepEqual([signature.verdict, signature.problems[0]], ["invalid", { code: "SIGN_SIGNER_CERTIFICATE_ALTERED", severity: "error", params: { selfSigned: true } }]);
});

test("inspect: safety property: no single-byte change inside the signed range leaves a valid signature", async () => {
  const original = base.signed;
  const [a, b, c, d] = readSignatures(original)[0].byteRange;
  const reference = await first(original);
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let insideGap = 0;
  for (let i = 0; i < 160; i++) {
    // 110 positions in the signed bytes (before and after the signature value), 50 inside /Contents
    let offset;
    if (i < 110) {
      const k = Math.floor(random() * (b + d));
      offset = k < b ? a + k : c + (k - b);
    } else {
      offset = a + b + Math.floor(random() * (c - a - b));
    }
    const mutated = Uint8Array.from(original);
    mutated[offset] ^= 1 << Math.floor(random() * 8);
    const result = await inspect(mutated); // must not throw
    const signedRange = offset < a + b || (offset >= c && offset < c + d);
    for (const signature of result.signatures) {
      if (signedRange) {
        const acceptable = signature.verdict === "invalid" || signature.verdict === "unknown" || signature.digestMatches !== true;
        assert.ok(acceptable, `byte ${offset} changed, signature still ${signature.verdict} (digest ${signature.digestMatches})`);
      } else {
        // Inside the signature value itself (the one part no signature covers). Most changes break the
        // container; some cannot matter (the case of a hex digit, the zero padding, the CA certificates). What
        // must hold: a signature that still verifies is by the same certificate, over the same document.
        insideGap++;
        if (signature.verdict !== "valid" && signature.verdict !== "valid-with-warnings") continue;
        assert.equal(signature.signerCertificate.fingerprintSha256, reference.signerCertificate.fingerprintSha256, `byte ${offset}: another signer certificate`);
        assert.deepEqual(signature.byteRange, reference.byteRange);
        assert.equal(signature.signingCertificateAttribute.matches, true);
      }
    }
  }
  assert.ok(insideGap >= 40);
});
