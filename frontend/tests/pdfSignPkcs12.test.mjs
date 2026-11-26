// engine/sign: PKCS#12 import (loadPkcs12) and export (createPkcs12). The containers are embedded test
// material written by OpenSSL and by Windows; node:crypto / node:tls (OpenSSL) and node-forge are the
// independent implementations the results are compared with.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import tls from "node:tls";
import forge from "node-forge";
import { decode, der } from "../src/pages/pdfEditor/engine/sign/asn1.js";
import { binaryStringToBytes, bytesToBinaryString, concatBytes, toHex, utf16beEncode } from "../src/pages/pdfEditor/engine/sign/bytes.js";
import { createPkcs12, describePkcs8, importSigningKey, pkcs12Kdf } from "../src/pages/pdfEditor/engine/sign/pkcs12.js";
import { loadPkcs12 } from "../src/pages/pdfEditor/engine/sign/index.js";
import { CANCELLED, isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { CERTS, KEYS, P12, PASSWORD, UNICODE_PASSWORD } from "./helpers/pdfSignFixtures.mjs";
import { rejectsWithCode } from "./helpers/pdfSignKit.mjs";

const subtle = globalThis.crypto.subtle;
const NOW = new Date("2026-11-16T00:00:00Z");
const commonNames = (subjects) => subjects.map((subject) => /CN=([^,]+)/.exec(subject)[1]);

/**
 * The returned key signs and the returned certificate verifies (checked with node:crypto, which shares no
 * code with the loader); the handle is non-extractable and sign-only.
 */
async function assertUsable(result) {
  const publicKey = new crypto.X509Certificate(result.certificate).publicKey;
  for (const [hash, key] of Object.entries(result.privateKeysByHash)) {
    const data = Buffer.from(`test ${hash}`);
    const isEc = key.algorithm.name === "ECDSA";
    const signature = Buffer.from(await subtle.sign(isEc ? { name: "ECDSA", hash } : { name: "RSASSA-PKCS1-v1_5" }, key, data));
    const verified = crypto.verify(hash.replace("-", "").toLowerCase(), data, isEc ? { key: publicKey, dsaEncoding: "ieee-p1363" } : publicKey, signature);
    assert.equal(verified, true, `${hash}: the certificate verifies what the key signs`);
    assert.equal(key.type, "private");
    assert.equal(key.extractable, false);
    assert.deepEqual(key.usages, ["sign"]);
    // browsers: InvalidAccessError; Node 24: a DOMException named InvalidAccessException
    await assert.rejects(subtle.exportKey("pkcs8", key), (error) => /^InvalidAccess(Error|Exception)$/.test(error.name));
    await assert.rejects(subtle.exportKey("jwk", key), (error) => /^InvalidAccess(Error|Exception)$/.test(error.name));
  }
  assert.equal(result.privateKey, Object.values(result.privateKeysByHash)[0]);
}

test("pkcs12: the matrix of containers opens (Windows Triple-DES, AES-256 PBES2, legacy RC2-40, EC, no password, Vietnamese password, PBMAC1)", async () => {
  const cases = [
    ["windows3des", "RSA 2048", 3, "HMAC-SHA-1 (PKCS#12 KDF, 2000 iterations)", "pbeWithSHAAnd3-KeyTripleDES-CBC (2000 iterations)"],
    ["aes256", "RSA 2048", 3, "HMAC-SHA-256 (PKCS#12 KDF, 2048 iterations)", "PBES2 (PBKDF2 HMAC-SHA-256, 2048 iterations, AES-256-CBC)"],
    ["legacyRc2", "RSA 2048", 3, "HMAC-SHA-1 (PKCS#12 KDF, 2048 iterations)", "pbeWithSHAAnd3-KeyTripleDES-CBC (2048 iterations)"],
    ["ecP256", "ECDSA P-256", 3, "HMAC-SHA-256 (PKCS#12 KDF, 2048 iterations)", "PBES2 (PBKDF2 HMAC-SHA-256, 2048 iterations, AES-256-CBC)"],
    ["noPassword", "RSA 2048", 3, "HMAC-SHA-256 (PKCS#12 KDF, 2048 iterations)", "PBES2 (PBKDF2 HMAC-SHA-256, 2048 iterations, AES-256-CBC)"],
    ["unicodePassword", "RSA 2048", 3, "HMAC-SHA-256 (PKCS#12 KDF, 2048 iterations)", "PBES2 (PBKDF2 HMAC-SHA-256, 2048 iterations, AES-256-CBC)"],
    ["pbmac1", "RSA 2048", 3, "PBMAC1 (PBKDF2 HMAC-SHA-256, 2048 iterations, HMAC-SHA-256)", "PBES2 (PBKDF2 HMAC-SHA-256, 2048 iterations, AES-256-CBC)"],
    ["signer2", "RSA 2048", 2, "HMAC-SHA-256 (PKCS#12 KDF, 2048 iterations)", "PBES2 (PBKDF2 HMAC-SHA-256, 2048 iterations, AES-256-CBC)"]
  ];
  for (const [name, key, chainLength, integrity, keyEncryption] of cases) {
    const result = await loadPkcs12(P12[name].bytes, P12[name].password, { now: NOW });
    assert.equal(result.keyAlgorithm.description, key, name);
    assert.equal(result.chain.length, chainLength, name);
    assert.equal(result.info.chainComplete, true, name);
    assert.ok(result.certificate instanceof Uint8Array);
    assert.deepEqual([...result.chain[0]], [...result.certificate], `${name}: the chain starts with the leaf`);
    assert.equal(result.info.integrity, integrity, name);
    assert.equal(result.info.keyEncryption, keyEncryption, name);
    assert.equal(result.info.passwordForm, "as-typed", name);
    assert.equal(result.info.matchedBy, "localKeyId", name);
    assert.equal(result.info.certificate.validity, "valid", name);
    await assertUsable(result);
  }
});

test("pkcs12: what the loader reports about a container", async () => {
  const modern = await loadPkcs12(P12.aes256.bytes, PASSWORD, { now: NOW });
  assert.equal(modern.info.friendlyName, "signer1");
  assert.equal(modern.info.certificate.subject.commonName, "Nguyễn Văn An");
  assert.deepEqual(commonNames(modern.info.chainSubjects), ["Nguyễn Văn An", "ANS Test Intermediate CA", "ANS Test Root CA"]);
  assert.deepEqual(modern.info.extraCertificates, []);
  assert.deepEqual(modern.info.warnings, []);
  assert.equal(modern.info.weakIntegrity, false);
  assert.deepEqual(modern.info.certificateEncryption, ["PBES2 (PBKDF2 HMAC-SHA-256, 2048 iterations, AES-256-CBC)"]);
  assert.deepEqual(modern.keyAlgorithm, { type: "RSA", name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, hashes: ["SHA-256"], description: "RSA 2048" });
  assert.deepEqual(modern.info.identities, [{
    index: 0, selected: true, keyType: "RSA 2048", supported: true, unsupportedReason: null, friendlyName: "signer1",
    subject: "C=VN, O=ANS Network Test, OU=Phòng Pháp chế, CN=Nguyễn Văn An, emailAddress=an@example.test", notAfter: "2031-01-01T00:00:00.000Z", matchedBy: "localKeyId"
  }]);
  // the exact certificates of the file, in chain order, as DER
  assert.deepEqual(modern.chain.map(toHex), [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa].map(toHex));

  const legacy = await loadPkcs12(P12.legacyRc2.bytes, PASSWORD);
  assert.equal(legacy.info.weakIntegrity, true);
  assert.deepEqual(legacy.info.warnings, [{ code: "CERT_PKCS12_WEAK_ENCRYPTION", params: {} }]);
  assert.deepEqual(legacy.info.certificateEncryption, ["pbeWithSHAAnd40BitRC2-CBC (2048 iterations)"]);

  const windows = await loadPkcs12(P12.windows3des.bytes, PASSWORD);
  assert.equal(windows.info.friendlyName, "signer1"); // Windows stores the name with a trailing NUL character
  assert.deepEqual(windows.info.warnings, []);

  const ec = await loadPkcs12(P12.ecP256.bytes, PASSWORD);
  assert.deepEqual(ec.keyAlgorithm, { type: "EC", name: "ECDSA", namedCurve: "P-256", hashes: ["SHA-256"], description: "ECDSA P-256", signatureBytes: 64 });
  assert.equal(toHex(ec.certificate), toHex(CERTS.ecSigner));
  assert.deepEqual(commonNames((await loadPkcs12(P12.signer2.bytes, PASSWORD)).info.chainSubjects), ["Trần Thị Bình", "ANS Test Root CA"]);
});

test("pkcs12: a wrong password is CERT_WRONG_PASSWORD for every profile, and nothing of it is in the error", async () => {
  for (const name of ["aes256", "windows3des", "legacyRc2", "pbmac1", "ecP256", "noPassword", "unicodePassword"]) {
    const error = await rejectsWithCode(loadPkcs12(P12[name].bytes, "wrong-PASSWORD-xyz"), "CERT_WRONG_PASSWORD");
    assert.ok(!JSON.stringify([error.message, error.params, String(error.cause || "")]).includes("wrong-PASSWORD-xyz"), `${name}: the password leaked into the error`);
  }
  await rejectsWithCode(loadPkcs12(P12.aes256.bytes, ""), "CERT_WRONG_PASSWORD");
  await rejectsWithCode(loadPkcs12(P12.aes256.bytes, "TEST1234"), "CERT_WRONG_PASSWORD");
  await rejectsWithCode(loadPkcs12(P12.aes256.bytes, "test1234 "), "CERT_WRONG_PASSWORD");
  await rejectsWithCode(loadPkcs12(P12.unicodePassword.bytes, "matkhau123"), "CERT_WRONG_PASSWORD");
});

test("pkcs12: empty password, null and undefined are the same request", async () => {
  for (const password of ["", null, undefined]) {
    const result = await loadPkcs12(P12.noPassword.bytes, password);
    assert.equal(result.keyAlgorithm.description, "RSA 2048");
    assert.equal(result.info.passwordForm, "as-typed");
  }
});

test("pkcs12: a Vietnamese password as typed and typed with decomposed accents", async () => {
  assert.equal(UNICODE_PASSWORD, "mậtkhẩu123".normalize("NFC"));
  assert.equal((await loadPkcs12(P12.unicodePassword.bytes, UNICODE_PASSWORD)).info.passwordForm, "as-typed");
  const decomposed = UNICODE_PASSWORD.normalize("NFD");
  assert.notEqual(decomposed, UNICODE_PASSWORD);
  const opened = await loadPkcs12(P12.unicodePassword.bytes, decomposed);
  assert.equal(opened.info.passwordForm, "nfc");
  await assertUsable(opened);
});

test("pkcs12: unsupported algorithms are named (RC4; PBMAC1 with a hash WebCrypto lacks), unsupported keys too", async () => {
  const rc4 = await rejectsWithCode(loadPkcs12(P12.rc4.bytes, PASSWORD), "CERT_UNSUPPORTED_ALGORITHM");
  assert.deepEqual(rc4.params, { algorithm: "pbeWithSHAAnd128BitRC4" });
  // PBMAC1 (RFC 9579) opens with the HMACs WebCrypto has (see the matrix); with another one it is refused by name
  const patched = Uint8Array.from(P12.pbmac1.bytes);
  const hmacSha256 = Buffer.from("06082a864886f70d0209", "hex");
  const at = Buffer.from(patched).lastIndexOf(hmacSha256);
  assert.ok(at > patched.length - 200, "the last hmacWithSHA256 is the message authentication scheme of PBMAC1");
  patched[at + hmacSha256.length - 1] = 0x08; // hmacWithSHA224
  const pbmac1 = await rejectsWithCode(loadPkcs12(patched, PASSWORD), "CERT_UNSUPPORTED_ALGORITHM");
  assert.deepEqual(pbmac1.params, { algorithm: "PBMAC1 with hmacWithSHA224" });
  // keys WebCrypto cannot sign with
  const container = (key) => createPkcs12({ privateKeyPkcs8: new Uint8Array(key.export({ type: "pkcs8", format: "der" })), certificates: [CERTS.signer1], password: "pw", iterations: 16 });
  const ed25519 = await rejectsWithCode(loadPkcs12(await container(crypto.generateKeyPairSync("ed25519").privateKey), "pw"), "CERT_UNSUPPORTED_KEY_TYPE");
  assert.deepEqual(ed25519.params, { keyType: "Ed25519", curve: null });
  const k256 = await rejectsWithCode(loadPkcs12(await container(crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey), "pw"), "CERT_UNSUPPORTED_KEY_TYPE");
  assert.deepEqual(k256.params, { keyType: "EC", curve: "secp256k1" });
  const pss = crypto.generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey;
  assert.equal(describePkcs8(new Uint8Array(pss.export({ type: "pkcs8", format: "der" }))).reason, "rsa-pss-only");
  assert.deepEqual((await rejectsWithCode(loadPkcs12(await container(pss), "pw"), "CERT_UNSUPPORTED_KEY_TYPE")).params, { keyType: "RSA-PSS", curve: null });
});

test("pkcs12: files that are not PKCS#12, truncated files and damaged files", async () => {
  const good = P12.aes256.bytes;
  const refused = async (bytes, password = PASSWORD) => {
    try {
      await loadPkcs12(bytes, password);
      return "opened";
    } catch (error) {
      assert.ok(isPdfEditorError(error), `a coded error is expected, got ${error && error.name}: ${error && error.message}`);
      return error.code === "CERT_NOT_PKCS12" ? `${error.code}:${error.params.hint}` : error.code;
    }
  };
  assert.equal(await refused(new Uint8Array(0)), "CERT_NOT_PKCS12:empty");
  assert.equal(await refused(new TextEncoder().encode("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")), "CERT_NOT_PKCS12:pem");
  assert.equal(await refused(CERTS.signer1), "CERT_NOT_PKCS12:certificate"); // a .cer holds no private key
  assert.equal(await refused(KEYS.signer1), "CERT_NOT_PKCS12:private-key"); // a bare PKCS#8 key
  assert.equal(await refused(new TextEncoder().encode("%PDF-1.7\n")), "CERT_NOT_PKCS12:pdf");
  assert.equal(await refused(Uint8Array.of(0xfe, 0xed, 0xfe, 0xed, 0, 0, 0, 2)), "CERT_NOT_PKCS12:jks");
  assert.equal(await refused(Uint8Array.of(0x50, 0x4b, 3, 4, 20, 0, 0, 0)), "CERT_NOT_PKCS12:zip");
  assert.equal(await refused(new Uint8Array(crypto.randomBytes(3000)).fill(0x41, 0, 1)), "CERT_NOT_PKCS12:null");
  // cut in the middle: the ASN.1 lengths run past the end
  assert.equal(await refused(good.subarray(0, 2500)), "CERT_CORRUPT");
  assert.equal(await refused(good.subarray(0, 40)), "CERT_CORRUPT");
  assert.equal(await refused(P12.windows3des.bytes.subarray(0, P12.windows3des.bytes.length - 1)), "CERT_CORRUPT");
  // one bit changed inside the encrypted part: the MAC no longer matches, which nobody can tell from a wrong password
  const flipped = Uint8Array.from(good);
  flipped[1500] ^= 0x01;
  assert.equal(await refused(flipped), "CERT_WRONG_PASSWORD");
  // the structure itself damaged (the version INTEGER turned into a string)
  const mangled = Uint8Array.from(good);
  mangled[4] = 0x0c;
  assert.equal(await refused(mangled), "CERT_NOT_PKCS12:null");
  // wrong argument types are a coded error as well
  for (const input of ["a string", null, 12, {}]) assert.deepEqual((await rejectsWithCode(loadPkcs12(input, "x"), "CERT_INVALID_OPTIONS")).params, { field: "bytes" });
  assert.deepEqual((await rejectsWithCode(loadPkcs12(good, 1234), "CERT_INVALID_OPTIONS")).params, { field: "password" });
  assert.deepEqual((await rejectsWithCode(loadPkcs12(good, PASSWORD, { hashes: ["MD5"] }), "CERT_INVALID_OPTIONS")).params, { field: "hashes" });
  // ArrayBuffer input is accepted
  const buffer = good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength);
  assert.equal((await loadPkcs12(buffer, PASSWORD)).keyAlgorithm.description, "RSA 2048");
});

test("pkcs12: no key, no certificate, a key that does not belong to the certificate", async () => {
  await rejectsWithCode(loadPkcs12(P12.certsOnly.bytes, P12.certsOnly.password), "CERT_NO_PRIVATE_KEY");
  await rejectsWithCode(loadPkcs12(P12.keyOnly.bytes, P12.keyOnly.password), "CERT_NO_CERTIFICATE");
  const mismatch = await createPkcs12({ privateKeyPkcs8: KEYS.signer1, certificates: [CERTS.signer2], password: "pw", iterations: 16 });
  await rejectsWithCode(loadPkcs12(mismatch, "pw"), "CERT_KEY_CERTIFICATE_MISMATCH");
  await rejectsWithCode(loadPkcs12(P12.aes256.bytes, PASSWORD, { identity: 7 }), "CERT_KEY_CERTIFICATE_MISMATCH");
});

test("pkcs12: MAC password and encryption password differ -> CERT_DECRYPT_FAILED, not CERT_WRONG_PASSWORD", async () => {
  // rebuild the MAC of the AES container with another password ("openssl pkcs12 -twopass")
  const root = decode(P12.aes256.bytes);
  const authSafe = root.child(1).child(1).child(0).octets();
  const salt = new Uint8Array(crypto.randomBytes(8));
  const macKey = await pkcs12Kdf("SHA-256", concatBytes(utf16beEncode("mac-only"), Uint8Array.of(0, 0)), salt, 3, 2048, 32);
  const mac = crypto.createHmac("sha256", macKey).update(authSafe).digest();
  const macData = der.seq(der.seq(der.seq(der.oid("2.16.840.1.101.3.4.2.1"), der.nul()), der.octets(mac)), der.octets(salt), der.int(2048));
  const twoPass = der.seq(root.child(0).raw, root.child(1).raw, macData);
  assert.deepEqual((await rejectsWithCode(loadPkcs12(twoPass, "mac-only"), "CERT_DECRYPT_FAILED")).params, { part: "certificates" });
  await rejectsWithCode(loadPkcs12(twoPass, PASSWORD), "CERT_WRONG_PASSWORD");
});

test("pkcs12: the PKCS#12 key derivation agrees with node-forge for every hash, length and purpose", async () => {
  const passwordBytes = concatBytes(utf16beEncode(UNICODE_PASSWORD), Uint8Array.of(0, 0));
  const digests = { "SHA-1": forge.md.sha1, "SHA-256": forge.md.sha256, "SHA-384": forge.md.sha384, "SHA-512": forge.md.sha512 };
  for (const hash of Object.keys(digests)) {
    for (const [id, length, iterations, saltLength] of [[1, 24, 1, 8], [2, 8, 7, 8], [3, 20, 2048, 8], [3, 64, 3, 20], [1, 200, 2, 16], [1, 40, 5, 0]]) {
      const salt = Uint8Array.from({ length: saltLength }, (value, index) => (index * 37 + 11) & 0xff);
      const ours = await pkcs12Kdf(hash, passwordBytes, salt, id, iterations, length);
      const theirs = forge.pkcs12.generateKey(UNICODE_PASSWORD, new forge.util.ByteBuffer(bytesToBinaryString(salt)), id, iterations, length, digests[hash].create());
      assert.equal(toHex(ours), toHex(binaryStringToBytes(theirs.getBytes())), `${hash} id ${id} n ${length} iter ${iterations} salt ${saltLength}`);
    }
  }
  await rejectsWithCode(pkcs12Kdf("SHA-256", passwordBytes, new Uint8Array(8), 1, 0, 24), "CERT_CORRUPT");
  await rejectsWithCode(pkcs12Kdf("SHA-256", passwordBytes, new Uint8Array(8), 1, 50_000_000, 24), "CERT_CORRUPT");
  await rejectsWithCode(pkcs12Kdf("MD5", passwordBytes, new Uint8Array(8), 1, 1, 24), "CERT_UNSUPPORTED_ALGORITHM");
});

test("pkcs12: createPkcs12 (both profiles, RSA and EC, Vietnamese / empty password) reopens here and in OpenSSL", async () => {
  const material = [
    ["RSA", KEYS.signer1, [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa], "RSA 2048"],
    ["EC", KEYS.ecSigner, [CERTS.ecSigner, CERTS.intermediateCa, CERTS.rootCa], "ECDSA P-256"]
  ];
  for (const [label, pkcs8, certificates, description] of material) {
    for (const profile of ["3des", "aes256"]) {
      for (const password of ["test1234", UNICODE_PASSWORD, ""]) {
        const keyBefore = toHex(pkcs8);
        // the default iteration counts once per profile (RSA, ASCII password); a small count elsewhere keeps
        // the suite fast (the derivation is a loop of awaited digests)
        const defaults = label === "RSA" && password === "test1234";
        const count = defaults ? (profile === "3des" ? 2048 : 10000) : 64;
        const bytes = await createPkcs12({ privateKeyPkcs8: pkcs8, certificates, password, friendlyName: "Chữ ký của An", profile, iterations: defaults ? null : count });
        assert.equal(toHex(pkcs8), keyBefore, "the caller's key bytes are not touched");
        const opened = await loadPkcs12(bytes, password);
        assert.equal(opened.keyAlgorithm.description, description, `${label} ${profile}`);
        assert.equal(opened.chain.length, 3);
        assert.equal(opened.info.friendlyName, "Chữ ký của An");
        assert.equal(opened.info.matchedBy, "localKeyId");
        assert.equal(opened.info.integrity, profile === "3des" ? `HMAC-SHA-1 (PKCS#12 KDF, ${count} iterations)` : `HMAC-SHA-256 (PKCS#12 KDF, ${count} iterations)`);
        assert.equal(opened.info.keyEncryption, profile === "3des" ? `pbeWithSHAAnd3-KeyTripleDES-CBC (${count} iterations)` : `PBES2 (PBKDF2 HMAC-SHA-256, ${count} iterations, AES-256-CBC)`);
        await assertUsable(opened);
        await rejectsWithCode(loadPkcs12(bytes, `${password}x`), "CERT_WRONG_PASSWORD");
        // OpenSSL (through node:tls) opens the container, checks its MAC and that the key fits the certificate
        assert.doesNotThrow(() => tls.createSecureContext({ pfx: Buffer.from(bytes), passphrase: password }), `OpenSSL refuses ${label} ${profile} ${JSON.stringify(password)}`);
        assert.throws(() => tls.createSecureContext({ pfx: Buffer.from(bytes), passphrase: `${password}x` }));
      }
    }
  }
  // node-forge reads the RSA key back bit for bit (it cannot read EC keys)
  const forgeBytes = await createPkcs12({ privateKeyPkcs8: KEYS.signer1, certificates: [CERTS.signer1], password: "test1234", profile: "3des" });
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytesToBinaryString(forgeBytes)), false, "test1234");
  const bag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag][0];
  const expected = crypto.createPrivateKey({ key: Buffer.from(KEYS.signer1), format: "der", type: "pkcs8" }).export({ format: "jwk" });
  assert.equal(BigInt(`0x${bag.key.n.toString(16)}`), BigInt(`0x${Buffer.from(expected.n, "base64url").toString("hex")}`));
  await rejectsWithCode(createPkcs12({ privateKeyPkcs8: KEYS.signer1, certificates: [], password: "x" }), "CERT_INVALID_OPTIONS");
  await rejectsWithCode(createPkcs12({ privateKeyPkcs8: KEYS.signer1, certificates: [CERTS.signer1], password: "x", profile: "rc2" }), "CERT_INVALID_OPTIONS");
});

test("pkcs12: an EC key stored without its public point and without localKeyId is still paired with its certificate", async () => {
  const strip = (pkcs8) => {
    const root = decode(pkcs8);
    const ecPrivateKey = decode(root.child(2).octets());
    return der.seq(root.child(0).raw, root.child(1).raw, der.octets(der.seq(...ecPrivateKey.children.filter((child) => !child.isContext(1)).map((child) => child.raw))));
  };
  const stripped = strip(KEYS.ecSigner);
  assert.ok(describePkcs8(KEYS.ecSigner).ecPublicPoint, "the OpenSSL key carries the public point");
  assert.equal(describePkcs8(stripped).ecPublicPoint, undefined);
  // certificates in a "wrong" order, an unrelated RSA certificate first
  const bytes = await createPkcs12({ privateKeyPkcs8: stripped, certificates: [CERTS.signer2, CERTS.rootCa, CERTS.ecSigner, CERTS.intermediateCa], password: "pw", localKeyId: false, iterations: 16 });
  const opened = await loadPkcs12(bytes, "pw");
  assert.equal(opened.info.matchedBy, "curve");
  assert.equal(opened.info.certificate.subject.commonName, "Lê Minh Châu (ECDSA P-256)");
  assert.deepEqual(commonNames(opened.info.chainSubjects), ["Lê Minh Châu (ECDSA P-256)", "ANS Test Intermediate CA", "ANS Test Root CA"]);
  assert.equal(opened.info.extraCertificates.length, 1);
  await assertUsable(opened);
  // a P-256 key next to a certificate of ANOTHER P-256 key: the test signature catches it
  const other = strip(new Uint8Array(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "der" })));
  const mismatched = await createPkcs12({ privateKeyPkcs8: other, certificates: [CERTS.ecSigner], password: "pw", localKeyId: false, iterations: 16 });
  await rejectsWithCode(loadPkcs12(mismatched, "pw"), "CERT_KEY_CERTIFICATE_MISMATCH");
  // without localKeyId an RSA key is paired by comparing the public key
  const byKey = await loadPkcs12(await createPkcs12({ privateKeyPkcs8: KEYS.signer1, certificates: [CERTS.rootCa, CERTS.signer1], password: "pw", localKeyId: false, iterations: 16 }), "pw");
  assert.equal(byKey.info.matchedBy, "publicKey");
});

test("pkcs12: RSA handles are bound to one digest each; one EC handle serves all; importSigningKey", async () => {
  const rsa = await loadPkcs12(P12.aes256.bytes, PASSWORD, { hashes: ["SHA-256", "SHA-384", "SHA-512"] });
  assert.deepEqual(Object.keys(rsa.privateKeysByHash), ["SHA-256", "SHA-384", "SHA-512"]);
  assert.equal(rsa.privateKeysByHash["SHA-384"].algorithm.hash.name, "SHA-384");
  assert.notEqual(rsa.privateKeysByHash["SHA-256"], rsa.privateKeysByHash["SHA-512"]);
  await assertUsable(rsa);
  const ec = await loadPkcs12(P12.ecP256.bytes, PASSWORD, { hashes: ["SHA-256", "SHA-384"] });
  assert.equal(ec.privateKeysByHash["SHA-256"], ec.privateKeysByHash["SHA-384"]);
  await assertUsable(ec);
  const facts = describePkcs8(KEYS.signer1);
  assert.deepEqual([facts.algorithmOid, facts.keyType, facts.bits, facts.supported, facts.reason], ["1.2.840.113549.1.1.1", "RSA", 2048, true, null]);
  const imported = await importSigningKey(KEYS.signer1, { hashes: ["SHA-512"] });
  assert.equal(imported.privateKey.algorithm.hash.name, "SHA-512");
  assert.equal(imported.privateKey.extractable, false);
  assert.throws(() => describePkcs8(Uint8Array.of(1, 2, 3)), (error) => error.code === "CERT_ASN1_MALFORMED");
});

test("pkcs12: containers written by hand (plain key bag, no MAC, foreign entries, the legacy byte form of a password)", async () => {
  const DATA = "1.2.840.113549.1.7.1";
  const bag = (type, value) => der.seq(der.oid(`1.2.840.113549.1.12.10.1.${type}`), der.ctx(0, value));
  const certBag = (content, kind = 1) => bag(3, der.seq(der.oid(`1.2.840.113549.1.9.22.${kind}`), der.ctx(0, der.octets(content))));
  const container = (bags, macData = null) => {
    const authSafe = der.seq(der.seq(der.oid(DATA), der.ctx(0, der.octets(der.seq(...bags)))));
    return { authSafe, bytes: der.seq(der.int(3), der.seq(der.oid(DATA), der.ctx(0, der.octets(authSafe))), macData) };
  };
  const codes = (opened) => opened.info.warnings.map((entry) => (entry.params.what ? `${entry.code}:${entry.params.what}` : entry.code));

  // 1. nothing is protected: every password "opens" it, and the report says so
  const plain = container([bag(1, KEYS.signer1), certBag(CERTS.signer1)]).bytes;
  for (const password of ["", null, "whatever"]) {
    const opened = await loadPkcs12(plain, password);
    assert.deepEqual(codes(opened), ["CERT_PKCS12_KEY_UNENCRYPTED", "CERT_PKCS12_NO_MAC"]);
    assert.deepEqual([opened.info.integrity, opened.info.keyEncryption, opened.info.passwordForm, opened.info.matchedBy], ["none", "none", "not-needed", "publicKey"]);
    assert.deepEqual(opened.info.certificateEncryption, ["none"]);
    await assertUsable(opened);
  }

  // 2. entries the loader has no use for are skipped and named
  const foreign = container([
    bag(1, KEYS.signer1),
    certBag(new TextEncoder().encode("(an SDSI certificate)"), 2),
    certBag(Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x05)), // typed X.509, but not a certificate
    certBag(CERTS.signer1),
    bag(5, der.seq(der.oid("1.2.3.4"), der.ctx(0, der.octets(new Uint8Array(4))))) // a secret bag
  ]).bytes;
  const skipped = await loadPkcs12(foreign, "");
  assert.deepEqual(codes(skipped), ["CERT_PKCS12_ENTRY_IGNORED:certificate-type", "CERT_PKCS12_ENTRY_IGNORED:unreadable-certificate", "CERT_PKCS12_KEY_UNENCRYPTED", "CERT_PKCS12_NO_MAC"]);
  assert.deepEqual([skipped.info.ignoredBags, skipped.info.certificateCount, skipped.info.keyCount], [["1.2.840.113549.1.12.10.1.5"], 1, 1]);
  await assertUsable(skipped);

  // 3. OpenSSL before 1.1.0 turned a non-ASCII password into "one 16-bit unit per UTF-8 byte"; such files
  //    still open with the password as typed, and the report names the form
  const legacyForm = (text) => {
    const utf8 = Buffer.from(text, "utf8");
    const out = new Uint8Array(utf8.length * 2 + 2);
    utf8.forEach((byte, index) => {
      out[index * 2 + 1] = byte;
    });
    return out;
  };
  const passwordBytes = legacyForm(UNICODE_PASSWORD);
  const salt = Uint8Array.from({ length: 8 }, (value, index) => index + 1);
  const cipher = crypto.createCipheriv("des-ede3-cbc", await pkcs12Kdf("SHA-1", passwordBytes, salt, 1, 64, 24), await pkcs12Kdf("SHA-1", passwordBytes, salt, 2, 64, 8));
  const encryptedKey = Buffer.concat([cipher.update(KEYS.signer1), cipher.final()]);
  const bags = [
    bag(2, der.seq(der.seq(der.oid("1.2.840.113549.1.12.1.3"), der.seq(der.octets(salt), der.int(64))), der.octets(encryptedKey))),
    certBag(CERTS.signer1),
    certBag(CERTS.intermediateCa)
  ];
  const macKey = await pkcs12Kdf("SHA-1", passwordBytes, salt, 3, 64, 20);
  const mac = crypto.createHmac("sha1", macKey).update(container(bags).authSafe).digest();
  const legacy = container(bags, der.seq(der.seq(der.seq(der.oid("1.3.14.3.2.26"), der.nul()), der.octets(mac)), der.octets(salt), der.int(64))).bytes;
  for (const typed of [UNICODE_PASSWORD, UNICODE_PASSWORD.normalize("NFD")]) {
    const opened = await loadPkcs12(legacy, typed);
    assert.deepEqual([opened.info.passwordForm, codes(opened)], ["legacy-bytewise", ["CERT_PKCS12_LEGACY_PASSWORD"]]);
    assert.deepEqual([opened.info.integrity, opened.info.keyEncryption], ["HMAC-SHA-1 (PKCS#12 KDF, 64 iterations)", "pbeWithSHAAnd3-KeyTripleDES-CBC (64 iterations)"]);
    assert.equal(opened.chain.length, 2);
    await assertUsable(opened);
  }
  await rejectsWithCode(loadPkcs12(legacy, PASSWORD), "CERT_WRONG_PASSWORD");
  await rejectsWithCode(loadPkcs12(legacy, ""), "CERT_WRONG_PASSWORD");
});

test("pkcs12: cancellation through an AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  await rejectsWithCode(loadPkcs12(P12.windows3des.bytes, PASSWORD, { signal: controller.signal }), CANCELLED);
  await rejectsWithCode(pkcs12Kdf("SHA-1", Uint8Array.of(0, 0), new Uint8Array(8), 1, 5000, 24, controller.signal), CANCELLED);
});

test("pkcs12: random bytes and mutated containers only ever produce a coded CERT_ error", async () => {
  const good = P12.aes256.bytes;
  let seed = 987654321;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const seen = {};
  for (let i = 0; i < 150; i++) {
    let bytes;
    if (i % 3 === 0) {
      bytes = Uint8Array.from({ length: 1 + Math.floor(random() * 400) }, () => Math.floor(random() * 256));
      if (i % 2) bytes[0] = 0x30;
    } else {
      bytes = Uint8Array.from(good);
      const span = i % 3 === 1 ? 120 : bytes.length; // half of the mutations hit the outer structure
      for (let k = 0; k < 1 + (i % 4); k++) bytes[Math.floor(random() * span)] = Math.floor(random() * 256);
    }
    try {
      await loadPkcs12(bytes, PASSWORD);
      seen.opened = (seen.opened || 0) + 1;
    } catch (error) {
      assert.ok(isPdfEditorError(error) && /^CERT_/.test(error.code), `mutation ${i}: ${error && error.name}: ${error && error.stack}`);
      seen[error.code] = (seen[error.code] || 0) + 1;
    }
  }
  assert.ok(seen.CERT_NOT_PKCS12 > 15 && seen.CERT_CORRUPT > 15 && seen.CERT_WRONG_PASSWORD > 15, JSON.stringify(seen));
});
