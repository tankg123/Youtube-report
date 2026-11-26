// engine/sign: X.509 parsing, certificate facts, chain ordering. node:crypto (OpenSSL) is the reference reader.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { der } from "../src/pages/pdfEditor/engine/sign/asn1.js";
import { concatBytes, toHex, toPem } from "../src/pages/pdfEditor/engine/sign/bytes.js";
import {
  certificateFacts, certificatesFromPemOrDer, namesEqual, orderChain, parseCertificate, validityAt, verifyCertificateSignature, vietnameseIdentifiers
} from "../src/pages/pdfEditor/engine/sign/x509.js";
import * as api from "../src/pages/pdfEditor/engine/sign/index.js";
import { CERTS } from "./helpers/pdfSignFixtures.mjs";
import { rejectsWithCode } from "./helpers/pdfSignKit.mjs";

const NOW = new Date("2026-11-16T00:00:00Z");
const codes = async (bytes, options = {}) => (await certificateFacts(bytes, { now: NOW, ...options })).warnings.map((entry) => entry.code);
const plainName = (name) => name.attributes.map((attribute) => `${attribute.type}=${attribute.value}`).join("\n");

test("x509: every fixture certificate reads as node:crypto (OpenSSL) reads it", async () => {
  for (const [name, bytes] of Object.entries(CERTS)) {
    const reference = new crypto.X509Certificate(bytes);
    const cert = parseCertificate(bytes);
    const facts = await certificateFacts(cert, { now: NOW });
    assert.equal(facts.serialNumber.replace(/^0+(?=.)/, ""), reference.serialNumber.replace(/^0+(?=.)/, ""), `${name} serial`);
    assert.equal(facts.notBefore, new Date(reference.validFrom).toISOString(), `${name} notBefore`);
    assert.equal(facts.notAfter, new Date(reference.validTo).toISOString(), `${name} notAfter`);
    assert.equal(facts.fingerprintSha256, reference.fingerprint256, `${name} SHA-256 fingerprint`);
    assert.equal(facts.fingerprintSha1, reference.fingerprint, `${name} SHA-1 fingerprint`);
    assert.equal(plainName(cert.subject), reference.subject, `${name} subject`);
    assert.equal(plainName(cert.issuer), reference.issuer, `${name} issuer`);
    assert.equal(facts.isCa, reference.ca, `${name} CA flag`);
    assert.equal(toHex(cert.der), toHex(bytes), `${name}: the certificate bytes are kept as they are`);
    // the pieces CMS copies verbatim are exact slices of the certificate
    for (const piece of [cert.tbs, cert.spki, cert.issuer.der, cert.subject.der, cert.serialNumberTlv]) {
      assert.ok(Buffer.from(bytes).includes(Buffer.from(piece)), `${name}: a raw piece is not a slice of the certificate`);
    }
    assert.equal(toHex(cert.spki), toHex(reference.publicKey.export({ type: "spki", format: "der" })), `${name} SPKI`);
  }
});

test("x509: Vietnamese subject of the test PKI, every displayed fact", async () => {
  const facts = await api.certificateFacts(CERTS.signer1, { now: NOW });
  assert.equal(facts.subject.commonName, "Nguyễn Văn An");
  assert.equal(facts.subject.organization, "ANS Network Test");
  assert.equal(facts.subject.organizationalUnit, "Phòng Pháp chế");
  assert.equal(facts.subject.country, "VN");
  assert.equal(facts.subject.email, "an@example.test");
  assert.equal(facts.subject.text, "C=VN, O=ANS Network Test, OU=Phòng Pháp chế, CN=Nguyễn Văn An, emailAddress=an@example.test");
  assert.equal(facts.issuer.commonName, "ANS Test Intermediate CA");
  assert.equal(facts.displayName, "Nguyễn Văn An");
  assert.equal(facts.issuerDisplayName, "ANS Test Intermediate CA");
  assert.deepEqual(facts.subject.attributes.map((attribute) => attribute.stringType), ["PrintableString", "UTF8String", "UTF8String", "UTF8String", "IA5String"]);
  assert.equal(facts.version, 3);
  assert.equal(facts.validity, "valid");
  assert.equal(facts.daysRemaining, Math.floor((Date.parse(facts.notAfter) - NOW.getTime()) / 86400000));
  assert.deepEqual(facts.publicKey, { type: "RSA", bits: 2048, curve: null, description: "RSA 2048", usableInWebCrypto: true });
  assert.deepEqual(facts.signatureAlgorithm, { name: "sha256WithRSAEncryption", oid: "1.2.840.113549.1.1.11", hash: "SHA-256", weak: false });
  assert.deepEqual(facts.keyUsage, ["digitalSignature", "nonRepudiation"]);
  assert.equal(facts.keyUsageCritical, true);
  assert.equal(facts.extendedKeyUsage, null);
  assert.deepEqual(facts.basicConstraints, { ca: false, pathLen: null, critical: true });
  assert.equal(facts.isCa, false);
  assert.equal(facts.selfSigned, false);
  assert.equal(facts.canSignDocuments, true);
  assert.deepEqual(facts.subjectAltNames.emails, ["an@example.test"]);
  assert.match(facts.subjectKeyIdentifier, /^[0-9a-f]{40}$/);
  assert.equal(facts.authorityKeyIdentifier, (await certificateFacts(CERTS.intermediateCa, { now: NOW })).subjectKeyIdentifier);
  assert.deepEqual(facts.warnings, []);
  assert.match(facts.fingerprintSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.match(facts.fingerprintSha1, /^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
  assert.equal(BigInt(facts.serialNumberDecimal), BigInt(`0x${facts.serialNumber}`));
  const root = await certificateFacts(CERTS.rootCa, { now: NOW });
  assert.deepEqual([root.selfSigned, root.selfIssued, root.selfSignatureCheck, root.isCa, root.publicKey.bits], [true, true, true, true, 3072]);
  assert.equal((await certificateFacts(CERTS.signer2, { now: NOW })).subject.commonName, "Trần Thị Bình");
});

test("x509: name string types (BMPString, TeletexString, UTF-8 inside 7-bit types, UniversalString)", () => {
  const types = (bytes) => [...new Set(parseCertificate(bytes).subject.attributes.filter((attribute) => attribute.type !== "C").map((attribute) => attribute.stringType))];
  assert.deepEqual(types(CERTS.bmp), ["BMPString"]);
  assert.deepEqual(types(CERTS.t61), ["TeletexString"]);
  assert.equal(parseCertificate(CERTS.bmp).subject.fields.CN[0], "Nguyễn Thị Hồng Nhung");
  assert.equal(parseCertificate(CERTS.bmp).subject.fields.O[0], "Công ty TNHH Phần mềm Ánh Dương");
  assert.equal(parseCertificate(CERTS.t61).subject.fields.O[0], "Công ty Tân Phát");
  assert.equal(parseCertificate(CERTS.t61).subject.fields.CN[0], "Lê Thành Tâm");
  // certificate shells with mislabelled names (the signature is junk: only parsing is tested)
  const real = parseCertificate(CERTS.signer1);
  const algorithm = der.seq(der.oid("1.2.840.113549.1.1.11"), der.nul());
  const shell = (name, serial) => der.seq(
    der.seq(der.ctx(0, der.int(2)), der.int(serial), algorithm, name, der.seq(der.utcTime(new Date("2026-01-01T00:00:00Z")), der.utcTime(new Date("2027-01-01T00:00:00Z"))), name, real.spki),
    algorithm,
    der.bitString(new Uint8Array(256))
  );
  const utf8 = (text) => new TextEncoder().encode(text);
  const mislabelled = der.seq(
    der.set(der.seq(der.oid("2.5.4.6"), der.printable("VN"))),
    der.set(der.seq(der.oid("2.5.4.10"), concatBytes(Uint8Array.of(0x13, utf8("Công ty Cổ phần Đại Việt").length), utf8("Công ty Cổ phần Đại Việt")))),
    der.set(der.seq(der.oid("2.5.4.3"), concatBytes(Uint8Array.of(0x14, utf8("Nguyễn Văn An").length), utf8("Nguyễn Văn An"))))
  );
  const cert = parseCertificate(shell(mislabelled, 1));
  assert.equal(cert.subject.fields.O[0], "Công ty Cổ phần Đại Việt");
  assert.equal(cert.subject.fields.CN[0], "Nguyễn Văn An");
  assert.equal(cert.subject.attributes[2].stringType, "TeletexString");
  assert.equal(cert.selfIssued, true);
  const text = "Trương Vĩnh Ký";
  const utf32 = new Uint8Array(text.length * 4);
  [...text].forEach((char, index) => new DataView(utf32.buffer).setUint32(index * 4, char.codePointAt(0)));
  const universal = parseCertificate(shell(der.seq(der.set(der.seq(der.oid("2.5.4.3"), concatBytes(Uint8Array.of(0x1c, utf32.length), utf32)))), 7));
  assert.equal(universal.subject.fields.CN[0], text);
  assert.equal(universal.subject.attributes[0].stringType, "UniversalString");
  // a name value that needs quoting in the text form
  const comma = parseCertificate(shell(der.seq(der.set(der.seq(der.oid("2.5.4.10"), der.utf8("Ánh Dương, JSC")))), 9));
  assert.equal(comma.subject.text, "O=\"Ánh Dương, JSC\"");
});

test("x509: identifiers that Vietnamese CAs put into UID", async () => {
  const organisation = await certificateFacts(CERTS.vnOrg, { now: NOW });
  assert.equal(organisation.subject.uid, "MST:0101234567");
  assert.deepEqual(organisation.subject.identifiers, [{ kind: "MST", value: "0101234567", attribute: "UID" }]);
  assert.equal(organisation.subject.commonName, "CÔNG TY CỔ PHẦN ÁNH DƯƠNG");
  assert.equal(organisation.subject.state, "HÀ NỘI");
  assert.equal(organisation.subject.locality, "Quận Cầu Giấy");
  // a UID without a known prefix is left alone; several identifiers in one value
  assert.deepEqual(vietnameseIdentifiers({ attributes: [{ type: "UID", value: "jdoe" }] }), []);
  assert.deepEqual(vietnameseIdentifiers({ attributes: [{ type: "UID", value: "MST:0312345678,CMND:012345678" }] }).map((entry) => entry.kind), ["MST", "CMND"]);
  assert.deepEqual(vietnameseIdentifiers({ attributes: [{ type: "serialNumber", value: "cccd-001199012345" }, { type: "CN", value: "MST:1" }] }), [{ kind: "CCCD", value: "001199012345", attribute: "serialNumber" }]);
});

test("x509: key types, sizes and signature algorithms", async () => {
  const describe = async (bytes) => {
    const facts = await certificateFacts(bytes, { now: NOW });
    return `${facts.publicKey.description} / ${facts.signatureAlgorithm.name}`;
  };
  assert.equal(await describe(CERTS.ecSigner), "ECDSA P-256 / sha256WithRSAEncryption");
  assert.equal(await describe(CERTS.k256), "ECDSA secp256k1 / sha256WithRSAEncryption");
  assert.equal(await describe(CERTS.ed25519), "Ed25519 / sha256WithRSAEncryption");
  assert.equal(await describe(CERTS.rsa1024), "RSA 1024 / sha256WithRSAEncryption");
  assert.equal(await describe(CERTS.ecLeaf), "ECDSA P-256 / ecdsa-with-SHA384");
  assert.match(await describe(CERTS.pssSigned), /^RSA 2048 \/ RSASSA-PSS \(SHA-256, MGF1 SHA-256, salt 32\)$/);
  assert.equal((await certificateFacts(CERTS.k256, { now: NOW })).publicKey.usableInWebCrypto, false);
  assert.equal((await certificateFacts(CERTS.ecSigner, { now: NOW })).publicKey.usableInWebCrypto, true);
});

test("x509: validity, usage and strength warnings are codes with parameters", async () => {
  const expired = await certificateFacts(CERTS.expiredSigner, { now: NOW });
  assert.equal(expired.validity, "expired");
  assert.deepEqual(expired.warnings, [{ code: "CERT_EXPIRED", params: { notAfter: "2021-01-01T00:00:00.000Z" } }]);
  assert.ok(expired.daysRemaining < 0);
  assert.equal((await certificateFacts(CERTS.expiredSigner, { now: new Date("2020-07-01T00:00:00Z") })).validity, "valid");
  const future = await certificateFacts(CERTS.future, { now: NOW });
  assert.equal(future.validity, "notYetValid");
  assert.deepEqual(future.warnings.map((entry) => [entry.code, Object.keys(entry.params)]), [["CERT_NOT_YET_VALID", ["notBefore"]]]);
  assert.deepEqual(await codes(CERTS.kuEnc), ["CERT_KEY_USAGE_NO_SIGNING"]);
  assert.equal((await certificateFacts(CERTS.kuEnc, { now: NOW })).canSignDocuments, false);
  assert.deepEqual(await codes(CERTS.ekuServer), ["CERT_KEY_USAGE_NO_NON_REPUDIATION", "CERT_EKU_NOT_FOR_SIGNING"]);
  assert.deepEqual((await certificateFacts(CERTS.rsa1024, { now: NOW })).warnings, [{ code: "CERT_WEAK_KEY", params: { bits: 1024 } }]);
  assert.deepEqual((await certificateFacts(CERTS.sha1, { now: NOW })).warnings, [{ code: "CERT_WEAK_SIGNATURE_ALGORITHM", params: { algorithm: "sha1WithRSAEncryption" } }]);
  // a CA certificate is only a problem when it is used as the signer
  assert.deepEqual(await codes(CERTS.intermediateCa), []);
  assert.deepEqual(await codes(CERTS.intermediateCa, { role: "signer" }), ["CERT_KEY_USAGE_NO_SIGNING", "CERT_IS_CA"]);
  assert.equal(validityAt(parseCertificate(CERTS.signer1), new Date("2031-06-01T00:00:00Z")), "expired");
});

test("x509: revocation pointers and policies are listed (never fetched)", async () => {
  const facts = await certificateFacts(CERTS.aia, { now: NOW });
  assert.deepEqual(facts.crlUrls, ["http://crl.example.test/ca.crl"]);
  assert.deepEqual(facts.ocspUrls, ["http://ocsp.example.test"]);
  assert.deepEqual(facts.caIssuerUrls, ["http://pub.example.test/ca.cer"]);
  assert.deepEqual(facts.certificatePolicies, ["1.3.6.1.4.1.99999.1.1"]);
  assert.deepEqual(facts.extendedKeyUsage, ["clientAuth", "emailProtection"]);
  assert.deepEqual(facts.keyUsage, ["digitalSignature", "nonRepudiation", "keyEncipherment"]);
});

test("x509: chain ordering ignores the input order and verifies every link", async () => {
  const leaf = parseCertificate(CERTS.signer1);
  const pool = [CERTS.rootCa, CERTS.signer2, CERTS.signer1, CERTS.intermediateCa].map((bytes) => parseCertificate(bytes));
  const ordered = await orderChain(leaf, pool);
  assert.deepEqual(ordered.chain.map((cert) => cert.subject.fields.CN[0]), ["Nguyễn Văn An", "ANS Test Intermediate CA", "ANS Test Root CA"]);
  assert.equal(ordered.complete, true);
  assert.deepEqual(ordered.extras.map((cert) => cert.subject.fields.CN[0]), ["Trần Thị Bình"]);
  assert.deepEqual(ordered.links.map((link) => link.signatureOk), [true, true, true]);
  const alone = await orderChain(leaf, []);
  assert.deepEqual([alone.chain.length, alone.complete], [1, false]);
  const two = await orderChain(parseCertificate(CERTS.signer2), pool); // issued by the root directly
  assert.deepEqual(two.chain.map((cert) => cert.subject.fields.CN[0]), ["Trần Thị Bình", "ANS Test Root CA"]);
  const ecChain = await orderChain(parseCertificate(CERTS.ecLeaf), [parseCertificate(CERTS.ecCa), parseCertificate(CERTS.rootCa)]);
  assert.deepEqual([ecChain.complete, ecChain.chain.length], [true, 2]);
});

test("x509: certificate signatures (RSA PKCS#1 v1.5, RSASSA-PSS, ECDSA P-384) and wrong issuers", async () => {
  const intermediate = parseCertificate(CERTS.intermediateCa);
  const root = parseCertificate(CERTS.rootCa);
  const ecCa = parseCertificate(CERTS.ecCa);
  assert.deepEqual(await verifyCertificateSignature(parseCertificate(CERTS.signer1), intermediate), { ok: true });
  assert.deepEqual(await verifyCertificateSignature(intermediate, root), { ok: true });
  assert.deepEqual(await verifyCertificateSignature(root, root), { ok: true });
  assert.deepEqual(await verifyCertificateSignature(parseCertificate(CERTS.pssSigned), intermediate), { ok: true });
  assert.deepEqual(await verifyCertificateSignature(parseCertificate(CERTS.sha1), intermediate), { ok: true });
  assert.deepEqual(await verifyCertificateSignature(ecCa, ecCa), { ok: true });
  assert.deepEqual(await verifyCertificateSignature(parseCertificate(CERTS.ecLeaf), ecCa), { ok: true });
  assert.equal((await verifyCertificateSignature(parseCertificate(CERTS.signer1), root)).ok, false); // not its issuer
  assert.deepEqual(await verifyCertificateSignature(parseCertificate(CERTS.ecLeaf), intermediate), { ok: false, reason: "key-type" }); // ECDSA signature, RSA key
  // every verdict agrees with node:crypto
  for (const [subject, issuer] of [[CERTS.signer1, CERTS.intermediateCa], [CERTS.pssSigned, CERTS.intermediateCa], [CERTS.ecLeaf, CERTS.ecCa], [CERTS.signer1, CERTS.rootCa], [CERTS.signer2, CERTS.intermediateCa]]) {
    const expected = new crypto.X509Certificate(subject).verify(new crypto.X509Certificate(issuer).publicKey);
    assert.equal((await verifyCertificateSignature(parseCertificate(subject), parseCertificate(issuer))).ok, expected);
  }
  // one flipped bit in the signed part: the issuer no longer verifies it
  const altered = Uint8Array.from(CERTS.signer1);
  altered[parseCertificate(CERTS.signer1).tbs.byteOffset - CERTS.signer1.byteOffset + 40] ^= 0x01;
  let verdict = false;
  try {
    verdict = (await verifyCertificateSignature(parseCertificate(altered), intermediate)).ok;
  } catch (error) {
    assert.equal(error.code, "CERT_UNREADABLE");
  }
  assert.equal(verdict, false);
});

test("x509: name comparison tolerates a different string type and case", () => {
  const issuer = parseCertificate(CERTS.signer1).issuer;
  const subject = parseCertificate(CERTS.intermediateCa).subject;
  assert.equal(namesEqual(issuer, subject), true);
  const altered = { der: Uint8Array.of(1), attributes: subject.attributes.map((attribute) => ({ ...attribute, value: attribute.value.toUpperCase(), stringType: "PrintableString" })) };
  assert.equal(namesEqual(issuer, altered), true);
  assert.equal(namesEqual(issuer, parseCertificate(CERTS.rootCa).subject), false);
});

test("x509: PEM input, and everything that is not a certificate is CERT_UNREADABLE", async () => {
  const pem = new TextEncoder().encode(toPem(CERTS.signer1, "CERTIFICATE") + toPem(CERTS.intermediateCa, "CERTIFICATE"));
  assert.equal(parseCertificate(pem).subject.fields.CN[0], "Nguyễn Văn An");
  assert.equal(certificatesFromPemOrDer(pem).length, 2);
  assert.equal((await api.certificateFacts(pem, { now: NOW })).displayName, "Nguyễn Văn An");
  const junk = [
    Uint8Array.of(1, 2, 3),
    new Uint8Array(0),
    new TextEncoder().encode("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"),
    CERTS.signer1.subarray(0, 400),
    der.seq(der.int(1), der.int(2), der.int(3)),
    crypto.randomBytes(900)
  ];
  for (const bytes of junk) await rejectsWithCode(api.certificateFacts(bytes), "CERT_UNREADABLE");
  for (const notBytes of ["a string", null, 42, {}]) await rejectsWithCode(api.certificateFacts(notBytes), "CERT_UNREADABLE");
  // unreadable validity dates must not pass as "valid"
  const real = parseCertificate(CERTS.signer1);
  const algorithm = der.seq(der.oid("1.2.840.113549.1.1.11"), der.nul());
  const name = der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8("x"))));
  const badDates = der.seq(
    der.seq(der.ctx(0, der.int(2)), der.int(1), algorithm, name, der.seq(der.utf8("yesterday"), der.utf8("tomorrow")), name, real.spki),
    algorithm,
    der.bitString(new Uint8Array(256))
  );
  await rejectsWithCode(api.certificateFacts(badDates), "CERT_UNREADABLE");
  // mutated certificates: facts or CERT_UNREADABLE, never anything else
  let seed = 4711;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 300; i++) {
    const bytes = Uint8Array.from(i % 2 ? CERTS.signer1 : CERTS.ecSigner);
    for (let k = 0; k < 1 + (i % 4); k++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
    try {
      const facts = await api.certificateFacts(bytes, { now: NOW });
      assert.equal(typeof facts.fingerprintSha256, "string");
    } catch (error) {
      assert.equal(error.code, "CERT_UNREADABLE", `mutation ${i}: ${error && error.stack}`);
    }
  }
});
