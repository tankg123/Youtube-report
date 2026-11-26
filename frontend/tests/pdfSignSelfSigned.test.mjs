// engine/sign: createSelfSigned. The certificate is parsed back with node:crypto (OpenSSL) and the .p12
// backup is opened by OpenSSL (node:tls) and by the product's own reader.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import tls from "node:tls";
import { decode } from "../src/pages/pdfEditor/engine/sign/asn1.js";
import { toHex } from "../src/pages/pdfEditor/engine/sign/bytes.js";
import { buildName, SELF_SIGNED_KEY_TYPES } from "../src/pages/pdfEditor/engine/sign/selfSigned.js";
import { parseCertificate, verifyCertificateSignature } from "../src/pages/pdfEditor/engine/sign/x509.js";
import { KEY_TYPES, createSelfSigned, loadPkcs12 } from "../src/pages/pdfEditor/engine/sign/index.js";
import { UNICODE_PASSWORD } from "./helpers/pdfSignFixtures.mjs";
import { rejectsWithCode } from "./helpers/pdfSignKit.mjs";

const subtle = globalThis.crypto.subtle;
const SUBJECT = { commonName: "Nguyễn Văn An (tự ký)", organization: "Công ty TNHH Ánh Dương", organizationalUnit: "Phòng Kế toán", email: "an@example.test", country: "vn", years: 2 };
const NOW = new Date("2026-11-16T03:04:05.678Z");

/** The key signs, and node:crypto verifies with the certificate's public key. */
async function assertKeyBelongsTo(privateKey, certificateDer) {
  const publicKey = new crypto.X509Certificate(certificateDer).publicKey;
  const data = Buffer.from("xin chào");
  const isEc = privateKey.algorithm.name === "ECDSA";
  const signature = Buffer.from(await subtle.sign(isEc ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" }, privateKey, data));
  assert.equal(crypto.verify("sha256", data, isEc ? { key: publicKey, dsaEncoding: "ieee-p1363" } : publicKey, signature), true);
}

test("selfSigned: the key types on offer", () => {
  assert.deepEqual(KEY_TYPES, ["RSA-2048", "RSA-3072", "P-256"]);
  assert.deepEqual(Object.keys(SELF_SIGNED_KEY_TYPES), KEY_TYPES);
});

for (const keyType of ["RSA-2048", "P-256"]) {
  test(`selfSigned ${keyType}: a correct X.509 v3 certificate, as node:crypto reads it`, async () => {
    const made = await createSelfSigned({ ...SUBJECT, keyType, now: NOW });
    const reference = new crypto.X509Certificate(made.certificate);
    // OpenSSL: names, validity, self-signature, not a CA
    assert.equal(reference.subject, "C=VN\nO=Công ty TNHH Ánh Dương\nOU=Phòng Kế toán\nCN=Nguyễn Văn An (tự ký)\nemailAddress=an@example.test");
    assert.equal(reference.issuer, reference.subject);
    assert.equal(new Date(reference.validFrom).toISOString(), "2026-11-16T02:59:05.000Z"); // 5 minutes back for clock skew, whole seconds
    assert.equal(new Date(reference.validTo).toISOString(), "2028-11-16T02:59:05.000Z"); // the same calendar day two years later
    assert.equal(reference.verify(reference.publicKey), true, "the certificate verifies with its own key");
    // an END-ENTITY certificate (CA:FALSE, no keyCertSign): it is its own trust anchor, not an issuer of others
    assert.equal(reference.ca, false);
    assert.equal(reference.subjectAltName, "email:an@example.test");
    assert.equal(reference.publicKey.asymmetricKeyType, keyType === "P-256" ? "ec" : "rsa");
    if (keyType === "P-256") assert.equal(reference.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");
    else assert.equal(reference.publicKey.asymmetricKeyDetails.modulusLength, 2048);
    assert.equal(reference.serialNumber.length, 32, "16 octets");
    assert.ok(parseInt(reference.serialNumber.slice(0, 2), 16) >= 0x40 && parseInt(reference.serialNumber.slice(0, 2), 16) <= 0x7f, "positive, first octet not zero");
    assert.match(reference.toString(), /BEGIN CERTIFICATE/);

    // the profile in detail (the product's own parser, checked against node:crypto in pdfSignX509.test.mjs)
    const cert = parseCertificate(made.certificate);
    assert.equal(cert.version, 3);
    assert.equal(toHex(cert.subject.der), toHex(cert.issuer.der));
    assert.deepEqual(cert.subject.attributes.map((attribute) => [attribute.type, attribute.value, attribute.stringType]), [
      ["C", "VN", "PrintableString"],
      ["O", "Công ty TNHH Ánh Dương", "UTF8String"],
      ["OU", "Phòng Kế toán", "UTF8String"],
      ["CN", "Nguyễn Văn An (tự ký)", "UTF8String"],
      ["emailAddress", "an@example.test", "IA5String"]
    ]);
    assert.deepEqual(cert.extensions.map((extension) => [extension.name, extension.critical]), [["basicConstraints", true], ["keyUsage", true], ["subjectKeyIdentifier", false], ["subjectAltName", false]]);
    assert.deepEqual(cert.ext.basicConstraints, { ca: false, pathLen: null, critical: true });
    assert.deepEqual(cert.ext.keyUsage, { usages: ["digitalSignature", "nonRepudiation"], critical: true });
    assert.equal(cert.ext.extKeyUsage, undefined, "no extended key usage: absent = unrestricted");
    assert.equal(toHex(cert.ext.subjectKeyIdentifier), crypto.createHash("sha1").update(cert.publicKey.publicKeyBytes).digest("hex"));
    assert.equal(cert.signatureAlgorithm.name, keyType === "P-256" ? "ecdsa-with-SHA256" : "sha256WithRSAEncryption");
    assert.equal(cert.tbsSignatureAlgorithmOid, cert.signatureAlgorithm.oid);
    assert.deepEqual(await verifyCertificateSignature(cert, cert), { ok: true });

    // the returned identity has the shape of loadPkcs12
    assert.deepEqual(made.chain, [made.certificate]);
    assert.equal(made.info.certificate.selfSigned, true);
    assert.equal(made.info.certificate.publicKey.description, keyType === "P-256" ? "ECDSA P-256" : "RSA 2048");
    assert.equal(made.info.certificate.validity, "valid");
    assert.deepEqual(made.info.certificate.warnings, []);
    assert.equal(made.keyAlgorithm.description, keyType === "P-256" ? "ECDSA P-256" : "RSA 2048");
    assert.equal(typeof made.info.keyGenerationMs, "number");
    // no backup requested: no .p12, and the key never was extractable
    assert.equal(made.p12Bytes, null);
    assert.equal(made.info.p12Profile, null);
    assert.equal(made.privateKey.extractable, false);
    assert.deepEqual(made.privateKey.usages, ["sign"]);
    await assert.rejects(subtle.exportKey("pkcs8", made.privateKey));
    await assertKeyBelongsTo(made.privateKey, made.certificate);
  });

  test(`selfSigned ${keyType}: the .p12 backup reopens (both profiles), the returned key stays non-extractable`, async () => {
    for (const [profile, password] of [["3des", "test1234"], ["aes256", UNICODE_PASSWORD], [undefined, ""]]) {
      const made = await createSelfSigned({ ...SUBJECT, keyType, p12Password: password, p12Profile: profile });
      assert.ok(made.p12Bytes instanceof Uint8Array);
      assert.equal(made.info.p12Profile, profile || "3des");
      assert.equal(made.privateKey.extractable, false);
      await assert.rejects(subtle.exportKey("pkcs8", made.privateKey));
      // OpenSSL opens it and accepts that the key belongs to the certificate
      assert.doesNotThrow(() => tls.createSecureContext({ pfx: Buffer.from(made.p12Bytes), passphrase: password }));
      const opened = await loadPkcs12(made.p12Bytes, password);
      assert.equal(toHex(opened.certificate), toHex(made.certificate));
      assert.equal(opened.info.friendlyName, "Nguyễn Văn An (tự ký)");
      assert.equal(opened.info.certificate.selfSigned, true);
      assert.equal(opened.info.chainComplete, true);
      assert.equal(opened.keyAlgorithm.description, made.keyAlgorithm.description);
      assert.equal(opened.info.keyEncryption.startsWith(profile === "aes256" ? "PBES2 (PBKDF2 HMAC-SHA-256, 10000 iterations, AES-256-CBC)" : "pbeWithSHAAnd3-KeyTripleDES-CBC"), true);
      await rejectsWithCode(loadPkcs12(made.p12Bytes, "something else"), "CERT_WRONG_PASSWORD");
      // the reopened key and the returned key are the same key
      await assertKeyBelongsTo(opened.privateKey, made.certificate);
      await assertKeyBelongsTo(made.privateKey, opened.certificate);
    }
  });
}

test("selfSigned: RSA-3072, several digests with a backup, serial numbers are random", async () => {
  const big = await createSelfSigned({ commonName: "RSA 3072", keyType: "RSA-3072", p12Password: "pw", hashes: ["SHA-256", "SHA-384"] });
  assert.equal(new crypto.X509Certificate(big.certificate).publicKey.asymmetricKeyDetails.modulusLength, 3072);
  assert.deepEqual(Object.keys(big.privateKeysByHash), ["SHA-256", "SHA-384"]);
  assert.equal(big.privateKeysByHash["SHA-384"].algorithm.hash.name, "SHA-384");
  assert.equal(big.keyAlgorithm.description, "RSA 3072");
  const serials = new Set();
  for (let i = 0; i < 25; i++) {
    const made = await createSelfSigned({ commonName: `test ${i}`, keyType: "P-256" });
    const cert = parseCertificate(made.certificate);
    assert.equal(cert.serialNumberBytes.length, 16);
    assert.ok(cert.serialNumberBytes[0] >= 0x40 && cert.serialNumberBytes[0] <= 0x7f);
    serials.add(cert.serialNumber);
  }
  assert.equal(serials.size, 25);
});

test("selfSigned: input validation gives CERT_INVALID_OPTIONS with the field; minimal subject; NFC", async () => {
  const field = async (options) => (await rejectsWithCode(createSelfSigned(options), "CERT_INVALID_OPTIONS")).params.field;
  assert.equal(await field({ organization: "x" }), "commonName");
  assert.equal(await field({ commonName: "   " }), "commonName");
  assert.equal(await field({ commonName: "x".repeat(65) }), "commonName");
  assert.equal(await field({ commonName: "a", country: "Vietnam" }), "country");
  assert.equal(await field({ commonName: "a", email: "tên@ví-dụ.vn" }), "email");
  assert.equal(await field({ commonName: "a", keyType: "RSA-1024" }), "keyType");
  assert.equal(await field({ commonName: "a", years: 0 }), "years");
  assert.equal(await field({ commonName: "a", years: 31 }), "years");
  assert.equal(await field({ commonName: "a", keyType: "RSA-2048", hashes: ["SHA-512"] }), "hashes");
  assert.equal(await field({ commonName: "a", p12Password: "x", p12Profile: "rc2" }), "p12Profile");
  assert.equal(await field({ commonName: "a", p12Password: 1234 }), "p12Password");
  assert.equal(await field(undefined), "commonName");
  // minimal subject: only CN; decomposed input is stored precomposed (NFC); fractional years
  const made = await createSelfSigned({ commonName: "Nguyễn".normalize("NFD"), keyType: "P-256", years: 0.5, now: NOW });
  const cert = parseCertificate(made.certificate);
  assert.deepEqual(cert.subject.attributes.map((attribute) => attribute.type), ["CN"]);
  assert.equal(cert.subject.fields.CN[0], "Nguyễn".normalize("NFC"));
  assert.deepEqual(cert.extensions.map((extension) => extension.name), ["basicConstraints", "keyUsage", "subjectKeyIdentifier"]);
  assert.equal(Math.round((cert.notAfter - cert.notBefore) / 86400000), 183);
  assert.equal(new crypto.X509Certificate(made.certificate).subject, `CN=${"Nguyễn".normalize("NFC")}`);
  assert.equal(decode(buildName({ commonName: "a", state: "Hà Nội", locality: "Cầu Giấy" })).children.length, 3);
});
