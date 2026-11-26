// engine/sign: WHO signed. trust.status is "trusted" only when every link from the signer certificate up to a
// certificate the caller supplies was verified cryptographically and the path obeys the rules a certificate
// authority sets (CA flag, certificate-signing usage, path length, critical extensions, validity). What could
// not be checked is never counted as checked: an unverifiable link, an unverifiable signature, a self-signed
// certificate whose own signature cannot be verified.
//
// Every chain here is made in the test: certificates signed with node:crypto (the forged ones carry the name
// and key identifier of a real authority and the signature of somebody else), containers built by hand.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { der } from "../src/pages/pdfEditor/engine/sign/asn1.js";
import { SUBFILTER_PKCS7, certificateFacts, inspectSignatures, loadPkcs12 } from "../src/pages/pdfEditor/engine/sign/index.js";
import { createPkcs12 } from "../src/pages/pdfEditor/engine/sign/pkcs12.js";
import { findTrustPath, orderChain, parseCertificate, verifyCertificateSignature } from "../src/pages/pdfEditor/engine/sign/x509.js";
import { CERTS, KEYS } from "./helpers/pdfSignFixtures.mjs";
import { craftSignedPdf, handMadeCms, issueCertificate, makeSignablePdf, renameSignatureAlgorithm } from "./helpers/pdfSignKit.mjs";

const NOW = new Date("2026-11-16T03:00:00Z");
const SIGNER1 = { certificate: CERTS.signer1, privateKeyPkcs8: KEYS.signer1 };
const UNVERIFIABLE_HASHES = ["sha224", "sha3-256", "md5"]; // WebCrypto has none of them

const made = {};
test.before(async () => {
  made.pdf = await makeSignablePdf({ objectStreams: false, rotations: [0] });
  // RSA pairs are slow to make: one for every leaf (the containers are signed with RSA), one for the attacker
  made.leafKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  made.attackerKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  made.intermediate = parseCertificate(CERTS.intermediateCa);
  made.root = parseCertificate(CERTS.rootCa);
  // an authority of its own for the path rules (ECDSA P-256: quick to make, verified through WebCrypto)
  made.ca = issueCertificate({ commonName: "Path Test Root CA", key: "ec", ca: true });
});

const leaf = (options) => issueCertificate({ key: made.leafKey, ...options });
const asIssuer = (parsed, key) => ({ name: parsed.subject.der, keyIdentifier: parsed.ext.subjectKeyIdentifier, key });

/** Signs the test document with `signer` (a hand-made container holding `certificates`) and inspects it. */
async function inspected(signer, certificates, trustedCertificates, cms = {}) {
  const bytes = await craftSignedPdf(made.pdf, {
    prepare: { subFilter: SUBFILTER_PKCS7, contentsBytes: 32768 },
    container: (signed) => handMadeCms(signed, { certificate: signer.certificate, privateKeyPkcs8: signer.privateKeyPkcs8, certificates, ...cms })
  });
  const report = await inspectSignatures(bytes, { trustedCertificates, now: NOW });
  assert.equal(report.signatures.length, 1);
  return report.signatures[0];
}
const trustOf = (signature) => [signature.trust.status, signature.trust.reason, signature.trust.anchorCommonName, signature.trust.failures];
const facts = (signature) => [signature.digestMatches, signature.signatureValid, signature.verdict];
const notVerified = (commonName) => ["untrusted", "no-path", null, [{ reason: "link-not-verified", commonName }]];

test("trust: honest chains are trusted (three certificates, two, the leaf alone, an ECDSA authority, a version 1 root, a renewed authority)", async () => {
  const chain = [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa];
  let signature = await inspected(SIGNER1, chain, [CERTS.rootCa]);
  assert.deepEqual([facts(signature), trustOf(signature)], [[true, true, "valid"], ["trusted", "anchored", "ANS Test Root CA", []]]);
  assert.deepEqual([signature.chainComplete, signature.trust.chainComplete, signature.chainLinks.map((link) => link.signatureOk)], [true, true, [true, true, true]]);
  // the order of the certificates in the container means nothing
  assert.deepEqual(trustOf(await inspected(SIGNER1, [CERTS.rootCa, CERTS.intermediateCa, CERTS.signer1], [CERTS.rootCa])), ["trusted", "anchored", "ANS Test Root CA", []]);
  // the anchor may be any certificate of the chain, in the container or not
  assert.deepEqual(trustOf(await inspected(SIGNER1, chain, [CERTS.intermediateCa])), ["trusted", "anchored", "ANS Test Intermediate CA", []]);
  assert.deepEqual(trustOf(await inspected(SIGNER1, [CERTS.signer1], [CERTS.intermediateCa])), ["trusted", "anchored", "ANS Test Intermediate CA", []]);
  assert.deepEqual(trustOf(await inspected(SIGNER1, [CERTS.signer1, CERTS.intermediateCa], [CERTS.rootCa])), ["trusted", "anchored", "ANS Test Root CA", []]);
  assert.deepEqual(trustOf(await inspected(SIGNER1, chain, [CERTS.signer1])), ["trusted", "anchored", "Nguyễn Văn An", []]);
  // two certificates, the link signed with ECDSA
  const direct = leaf({ commonName: "Leaf of the path root", issuer: made.ca.asIssuer });
  signature = await inspected(direct, [direct.certificate, made.ca.certificate], [made.ca.certificate]);
  assert.deepEqual([facts(signature), trustOf(signature), signature.chainComplete], [[true, true, "valid"], ["trusted", "anchored", "Path Test Root CA", []], true]);
  // root > authority (path length 0) > leaf
  const limited = issueCertificate({ commonName: "Authority with path length 0", key: "ec", ca: true, pathLen: 0, issuer: made.ca.asIssuer });
  const below = leaf({ commonName: "Leaf below the limited authority", issuer: limited.asIssuer });
  assert.deepEqual(trustOf(await inspected(below, [below.certificate, limited.certificate, made.ca.certificate], [made.ca.certificate])), ["trusted", "anchored", "Path Test Root CA", []]);
  // an old root: X.509 version 1, no extensions at all
  const v1Root = issueCertificate({ commonName: "Version 1 Root", key: "ec", version: 1 });
  const v1Leaf = leaf({ commonName: "Leaf below a version 1 root", issuer: { ...v1Root.asIssuer, keyIdentifier: null } });
  assert.deepEqual(trustOf(await inspected(v1Leaf, [v1Leaf.certificate, v1Root.certificate], [v1Root.certificate])), ["trusted", "anchored", "Version 1 Root", []]);
  // a renewed authority: the same name and key in an expired and in a current certificate, in either order
  const caKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const expired = issueCertificate({ commonName: "Renewed Authority", key: caKey, ca: true, issuer: made.ca.asIssuer, notBefore: new Date("2019-01-01T00:00:00Z"), notAfter: new Date("2024-01-01T00:00:00Z") });
  const current = issueCertificate({ commonName: "Renewed Authority", key: caKey, ca: true, issuer: made.ca.asIssuer });
  const renewedLeaf = leaf({ commonName: "Leaf below a renewed authority", issuer: current.asIssuer });
  for (const pair of [[expired.certificate, current.certificate], [current.certificate, expired.certificate]]) {
    assert.deepEqual(trustOf(await inspected(renewedLeaf, [renewedLeaf.certificate, ...pair, made.ca.certificate], [made.ca.certificate])), ["trusted", "anchored", "Path Test Root CA", []]);
  }
  // with the expired certificate alone there is no valid path
  assert.deepEqual(trustOf(await inspected(renewedLeaf, [renewedLeaf.certificate, expired.certificate, made.ca.certificate], [made.ca.certificate])),
    ["untrusted", "path-not-valid", "Path Test Root CA", [{ reason: "not-valid-at-time", commonName: "Renewed Authority" }]]);
});

test("trust: a forged leaf (name and key identifier of a trusted authority, signature of another key, an algorithm that cannot be verified here) is not trusted", async () => {
  for (const hash of UNVERIFIABLE_HASHES) {
    const name = `Forged Director (${hash})`;
    // three certificates: forged leaf <- real intermediate <- real root
    const forged = leaf({ commonName: name, hash, issuer: asIssuer(made.intermediate, made.attackerKey.privateKey) });
    assert.deepEqual(await verifyCertificateSignature(parseCertificate(forged.certificate), made.intermediate).then((result) => result.ok), null, `${hash}: the link cannot be checked`);
    let signature = await inspected(forged, [forged.certificate, CERTS.intermediateCa, CERTS.rootCa], [CERTS.rootCa]);
    assert.deepEqual([signature.digestMatches, signature.signatureValid], [true, true], "the mathematics of the signature itself holds");
    assert.deepEqual(trustOf(signature), notVerified(name), `${hash}: three certificates`);
    assert.deepEqual(signature.chainLinks.map((link) => link.signatureOk), [null, true, true], "the link that was not verified is visible as such");
    assert.deepEqual([signature.chainComplete, signature.trust.chainComplete, signature.signerCertificateCheck], [false, false, "unprotected"]);
    assert.ok(signature.problems.some((entry) => entry.code === "SIGN_SIGNER_NAME_UNPROTECTED"));
    // the intermediate itself as the anchor, in the container and outside of it
    assert.deepEqual(trustOf(await inspected(forged, [forged.certificate, CERTS.intermediateCa], [CERTS.intermediateCa])), notVerified(name));
    assert.deepEqual(trustOf(await inspected(forged, [forged.certificate], [CERTS.intermediateCa])), notVerified(name));
    assert.deepEqual(trustOf(await inspected(forged, [forged.certificate], [CERTS.rootCa, CERTS.intermediateCa])), notVerified(name));
    // two certificates: forged leaf <- real root
    const direct = leaf({ commonName: name, hash, issuer: asIssuer(made.root, made.attackerKey.privateKey) });
    signature = await inspected(direct, [direct.certificate, CERTS.rootCa], [CERTS.rootCa]);
    assert.deepEqual([signature.digestMatches, signature.signatureValid, trustOf(signature)], [true, true, notVerified(name)], `${hash}: two certificates`);
    assert.deepEqual([signature.chainLinks.map((link) => link.signatureOk), signature.chainComplete], [[null, true], false]);
    assert.deepEqual(trustOf(await inspected(direct, [direct.certificate], [CERTS.rootCa])), notVerified(name));
  }
  // the control: the same forgery with SHA-256 can be checked, and fails
  const checked = leaf({ commonName: "Forged Director (sha256)", issuer: asIssuer(made.intermediate, made.attackerKey.privateKey) });
  const signature = await inspected(checked, [checked.certificate, CERTS.intermediateCa, CERTS.rootCa], [CERTS.rootCa]);
  assert.deepEqual(trustOf(signature), notVerified("Forged Director (sha256)"));
  assert.deepEqual([signature.signerCertificateCheck, signature.verdict, signature.chainComplete], ["failed", "invalid", false]);
});

test("trust: the bytes of an honest certificate with its algorithm renamed in place (sha256 -> sha224) lose their trust", async () => {
  // three certificates: signer1 of the test PKI, both algorithm identifiers renamed (same length)
  const renamed = renameSignatureAlgorithm(CERTS.signer1);
  assert.equal(renamed.length, CERTS.signer1.length);
  assert.equal(parseCertificate(renamed).signatureAlgorithm.name, "sha224WithRSAEncryption");
  let signature = await inspected({ certificate: renamed, privateKeyPkcs8: KEYS.signer1 }, [renamed, CERTS.intermediateCa, CERTS.rootCa], [CERTS.rootCa]);
  assert.deepEqual([facts(signature), trustOf(signature)], [[true, true, "valid-with-warnings"], notVerified("Nguyễn Văn An")]);
  assert.deepEqual([signature.chainLinks.map((link) => link.signatureOk), signature.chainComplete], [[null, true, true], false]);
  // two certificates: a generated root and its leaf
  const root = issueCertificate({ commonName: "Renaming Root CA", key: made.attackerKey, ca: true });
  const honest = leaf({ commonName: "Leaf of the renaming root", issuer: root.asIssuer });
  assert.deepEqual(trustOf(await inspected(honest, [honest.certificate, root.certificate], [root.certificate])), ["trusted", "anchored", "Renaming Root CA", []]);
  const renamedLeaf = { certificate: renameSignatureAlgorithm(honest.certificate), privateKeyPkcs8: honest.privateKeyPkcs8 };
  signature = await inspected(renamedLeaf, [renamedLeaf.certificate, root.certificate], [root.certificate]);
  assert.deepEqual([signature.signatureValid, trustOf(signature), signature.chainComplete], [true, notVerified("Leaf of the renaming root"), false]);
  // the renamed certificate itself as the caller's choice is a different matter: exactly these bytes are trusted
  assert.deepEqual(trustOf(await inspected(renamedLeaf, [renamedLeaf.certificate], [renamedLeaf.certificate])).slice(0, 2), ["trusted", "anchored"]);
});

test("trust: an authority whose key the platform cannot use (secp256k1) cannot vouch for anybody, honest or not", async () => {
  const root = issueCertificate({ commonName: "K1 Root CA", key: "secp256k1", ca: true });
  const honest = leaf({ commonName: "Leaf of a secp256k1 authority", issuer: root.asIssuer });
  const impostor = leaf({ commonName: "Impostor below a secp256k1 authority", issuer: { ...root.asIssuer, key: crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey } });
  for (const [signer, name] of [[honest, "Leaf of a secp256k1 authority"], [impostor, "Impostor below a secp256k1 authority"]]) {
    const signature = await inspected(signer, [signer.certificate, root.certificate], [root.certificate]);
    assert.deepEqual([signature.signatureValid, trustOf(signature)], [true, notVerified(name)]);
    assert.deepEqual([signature.chainLinks.map((link) => link.signatureOk), signature.chainComplete], [[null, null], false]);
    assert.deepEqual(trustOf(await inspected(signer, [signer.certificate], [root.certificate])), notVerified(name));
  }
});

test("trust: the rules of a path (CA flag, certificate-signing usage, path length, critical extensions, validity)", async () => {
  const pathNotValid = (...failures) => ["untrusted", "path-not-valid", "Path Test Root CA", failures.map(([reason, commonName]) => ({ reason, commonName }))];
  const root = made.ca;
  // a certificate the caller trusts as a PERSON is no authority: what it "issues" is not trusted
  const person = issueCertificate({ commonName: "Trusted Colleague", key: made.attackerKey });
  const minted = leaf({ commonName: "Board of Directors", issuer: person.asIssuer });
  assert.deepEqual(trustOf(await inspected(person, [person.certificate], [person.certificate])), ["trusted", "anchored", "Trusted Colleague", []]);
  for (const certificates of [[minted.certificate, person.certificate], [minted.certificate]]) {
    assert.deepEqual(trustOf(await inspected(minted, certificates, [person.certificate])),
      ["untrusted", "path-not-valid", "Trusted Colleague", [{ reason: "anchor-not-a-ca", commonName: "Trusted Colleague" }, { reason: "no-certificate-signing-usage", commonName: "Trusted Colleague" }]]);
  }
  // an end-entity certificate inside the path
  const endEntity = issueCertificate({ commonName: "End Entity", key: made.attackerKey, issuer: root.asIssuer });
  const underEndEntity = leaf({ commonName: "Issued by an end entity", issuer: endEntity.asIssuer });
  assert.deepEqual(trustOf(await inspected(underEndEntity, [underEndEntity.certificate, endEntity.certificate, root.certificate], [root.certificate])),
    pathNotValid(["not-a-ca", "End Entity"], ["no-certificate-signing-usage", "End Entity"]));
  // an authority without the certificate-signing usage
  const noSign = issueCertificate({ commonName: "Authority without keyCertSign", key: "ec", ca: true, keyUsage: [0x80, 7], issuer: root.asIssuer });
  const underNoSign = leaf({ commonName: "Leaf below it", issuer: noSign.asIssuer });
  assert.deepEqual(trustOf(await inspected(underNoSign, [underNoSign.certificate, noSign.certificate, root.certificate], [root.certificate])),
    pathNotValid(["no-certificate-signing-usage", "Authority without keyCertSign"]));
  // path length 0 does not allow another authority below
  const limited = issueCertificate({ commonName: "Authority with path length 0", key: "ec", ca: true, pathLen: 0, issuer: root.asIssuer });
  const sub = issueCertificate({ commonName: "Sub Authority", key: "ec", ca: true, issuer: limited.asIssuer });
  const deep = leaf({ commonName: "Leaf below the sub authority", issuer: sub.asIssuer });
  assert.deepEqual(trustOf(await inspected(deep, [deep.certificate, sub.certificate, limited.certificate, root.certificate], [root.certificate])),
    pathNotValid(["path-length-exceeded", "Authority with path length 0"]));
  // a critical extension nobody here evaluates: an unknown one, and name constraints
  const odd = leaf({ commonName: "Leaf with an unknown critical extension", issuer: root.asIssuer, extensions: [{ oid: "1.3.6.1.4.1.99999.7.7", critical: true, value: der.nul() }] });
  assert.deepEqual(trustOf(await inspected(odd, [odd.certificate, root.certificate], [root.certificate])), pathNotValid(["unsupported-critical-extension", "Leaf with an unknown critical extension"]));
  const harmless = leaf({ commonName: "Leaf with an unknown extension", issuer: root.asIssuer, extensions: [{ oid: "1.3.6.1.4.1.99999.7.7", critical: false, value: der.nul() }] });
  assert.equal((await inspected(harmless, [harmless.certificate, root.certificate], [root.certificate])).trust.status, "trusted");
  const permitted = der.seq(der.ctx(0, der.seq(der.ctxPrimitive(2, new TextEncoder().encode("example.test")))));
  const constrained = issueCertificate({ commonName: "Authority with name constraints", key: "ec", ca: true, issuer: root.asIssuer, extensions: [{ oid: "2.5.29.30", critical: true, value: permitted }] });
  const outside = leaf({ commonName: "Leaf outside the constraints", issuer: constrained.asIssuer });
  assert.deepEqual(trustOf(await inspected(outside, [outside.certificate, constrained.certificate, root.certificate], [root.certificate])),
    pathNotValid(["unsupported-critical-extension", "Authority with name constraints"]));
  // validity is judged at the signing time (craftSignedPdf signs at 2026-11-16)
  const early = leaf({ commonName: "Leaf of next year", issuer: root.asIssuer, notBefore: new Date("2027-01-01T00:00:00Z") });
  assert.deepEqual(trustOf(await inspected(early, [early.certificate, root.certificate], [root.certificate])), pathNotValid(["not-valid-at-time", "Leaf of next year"]));
  const oldRoot = issueCertificate({ commonName: "Expired Root CA", key: "ec", ca: true, notBefore: new Date("2015-01-01T00:00:00Z"), notAfter: new Date("2020-01-01T00:00:00Z") });
  const lateLeaf = leaf({ commonName: "Leaf of an expired root", issuer: oldRoot.asIssuer });
  assert.deepEqual(trustOf(await inspected(lateLeaf, [lateLeaf.certificate, oldRoot.certificate], [oldRoot.certificate])),
    ["untrusted", "path-not-valid", "Expired Root CA", [{ reason: "anchor-not-valid-at-time", commonName: "Expired Root CA" }]]);
});

test("trust: a signature that could not be verified, or does not verify, never has a trusted signer", async () => {
  const chain = [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa];
  // the chain is honest, but the signature value uses a hash the platform lacks: nobody is shown to have signed
  let signature = await inspected(SIGNER1, chain, [CERTS.rootCa], { signatureHash: "sha224" });
  assert.deepEqual(facts(signature), [true, null, "unknown"]);
  assert.deepEqual([signature.trust.status, signature.trust.reason, signature.trust.anchor, signature.trust.failures], ["not-checked", "not-evaluated", null, []]);
  // a signature made with ANOTHER key under the honest certificate
  const stranger = new Uint8Array(made.attackerKey.privateKey.export({ type: "pkcs8", format: "der" }));
  signature = await inspected({ certificate: CERTS.signer1, privateKeyPkcs8: stranger }, chain, [CERTS.rootCa]);
  assert.deepEqual(facts(signature), [true, false, "invalid"]);
  assert.deepEqual([signature.trust.status, signature.trust.reason, signature.trust.anchor], ["not-checked", "not-evaluated", null]);
  // without a trust list the answer stays "no trusted certificates"
  signature = await inspected(SIGNER1, chain, [], { signatureHash: "sha224" });
  assert.deepEqual([signature.trust.status, signature.trust.reason], ["not-checked", "no-trusted-certificates"]);
  // the document changed, but the signer did sign something: the two facts stay apart
  signature = await inspected(SIGNER1, chain, [CERTS.rootCa], { messageDigest: crypto.createHash("sha256").update("another document").digest() });
  assert.deepEqual([facts(signature), signature.trust.status], [[false, true, "invalid"], "trusted"]);
});

test("trust: a self-signed certificate whose own signature cannot be verified is not called self-signed", async () => {
  const honest = issueCertificate({ commonName: "Self-signed (sha256)", key: made.leafKey });
  const odd = issueCertificate({ commonName: "Self-signed (sha224)", key: made.leafKey, hash: "sha224" });
  const facts256 = await certificateFacts(honest.certificate, { now: NOW });
  assert.deepEqual([facts256.selfIssued, facts256.selfSigned, facts256.selfSignatureCheck], [true, true, true]);
  const facts224 = await certificateFacts(odd.certificate, { now: NOW });
  assert.deepEqual([facts224.selfIssued, facts224.selfSigned, facts224.selfSignatureCheck], [true, false, null]);
  let signature = await inspected(honest, [honest.certificate], []);
  assert.deepEqual([signature.signerCertificateCheck, signature.chainComplete, signature.trust.selfSigned, signature.chainLinks], ["self-signed", true, true, [{ subject: "CN=Self-signed (sha256)", issuer: "CN=Self-signed (sha256)", signatureOk: true, selfSigned: true }]]);
  signature = await inspected(odd, [odd.certificate], []);
  assert.deepEqual([signature.signerCertificateCheck, signature.chainComplete, signature.trust.selfSigned, signature.chainLinks[0].signatureOk], ["unprotected", false, false, null]);
  assert.ok(signature.problems.some((entry) => entry.code === "SIGN_SIGNER_NAME_UNPROTECTED" && entry.severity === "warning"));
  // exactly these bytes, supplied by the caller, are still an anchor; any other certificate is not
  assert.equal((await inspected(odd, [odd.certificate], [odd.certificate])).trust.status, "trusted");
  assert.deepEqual(trustOf(await inspected(odd, [odd.certificate], [honest.certificate])), ["untrusted", "no-path", null, []]);
});

test("trust: orderChain and findTrustPath (what is listed for display is not what is verified)", async () => {
  const forged = parseCertificate(leaf({ commonName: "Forged (sha224)", hash: "sha224", issuer: asIssuer(made.intermediate, made.attackerKey.privateKey) }).certificate);
  const ordered = await orderChain(forged, [made.root, made.intermediate]);
  // the issuers are still listed (names and key identifiers match), the link says that it was not verified
  assert.deepEqual(ordered.chain.map((cert) => cert.subject.fields.CN[0]), ["Forged (sha224)", "ANS Test Intermediate CA", "ANS Test Root CA"]);
  assert.deepEqual([ordered.links.map((link) => link.signatureOk), ordered.complete], [[null, true, true], false]);
  const honest = await orderChain(parseCertificate(CERTS.signer1), [made.root, made.intermediate]);
  assert.deepEqual([honest.links.map((link) => link.signatureOk), honest.complete], [[true, true, true], true]);
  const selfSigned = await orderChain(parseCertificate(issueCertificate({ commonName: "Self (sha224)", key: "ec", hash: "sha224" }).certificate), []);
  assert.deepEqual([selfSigned.links, selfSigned.complete], [[{ subject: "CN=Self (sha224)", issuer: "CN=Self (sha224)", signatureOk: null, selfSigned: true }], false]);

  const when = new Date("2026-11-16T01:00:00Z");
  let path = await findTrustPath(parseCertificate(CERTS.signer1), [made.intermediate, made.root], [made.root], when);
  assert.deepEqual([path.trusted, path.anchor.subject.fields.CN[0], path.path.map((cert) => cert.subject.fields.CN[0]), path.failures], [true, "ANS Test Root CA", ["Nguyễn Văn An", "ANS Test Intermediate CA"], []]);
  path = await findTrustPath(forged, [made.intermediate, made.root], [made.root], when);
  assert.deepEqual([path.trusted, path.failures], [false, [{ reason: "link-not-verified", commonName: "Forged (sha224)" }]]);
  path = await findTrustPath(parseCertificate(CERTS.signer1), [made.intermediate, made.root], [parseCertificate(CERTS.ecCa)], when);
  assert.deepEqual([path.trusted, path.anchor, path.failures], [false, null, []]);
  path = await findTrustPath(parseCertificate(CERTS.signer1), [made.intermediate, made.root], [], when);
  assert.deepEqual([path.trusted, path.anchor], [false, null]);

  // a hostile container: dozens of certificates that all claim to be the issuer of the next one. The search is
  // bounded and ends without a path.
  const crowd = [];
  let previous = issueCertificate({ commonName: "Crowd", key: "ec", ca: true });
  for (let i = 0; i < 40; i++) {
    const next = issueCertificate({ commonName: "Crowd", key: "ec", ca: true, issuer: { ...previous.asIssuer, keyIdentifier: null }, basicConstraints: true });
    crowd.push(parseCertificate(next.certificate));
    previous = next;
  }
  const lost = parseCertificate(leaf({ commonName: "Leaf in a crowd", issuer: { ...previous.asIssuer, keyIdentifier: null } }).certificate);
  const started = performance.now();
  path = await findTrustPath(lost, crowd, [made.root], when);
  assert.deepEqual([path.trusted, path.anchor], [false, null]);
  assert.ok(performance.now() - started < 5000, "the search is bounded");
});

test("trust: loadPkcs12 does not call a chain complete when a link of it was not verified", async () => {
  const renamed = renameSignatureAlgorithm(CERTS.signer1);
  const container = await createPkcs12({ privateKeyPkcs8: KEYS.signer1, certificates: [renamed, CERTS.intermediateCa, CERTS.rootCa], password: "pw", iterations: 16 });
  const opened = await loadPkcs12(container, "pw", { now: NOW });
  // the key is the user's own and the issuers are listed for the signature, but the first link is not verified
  assert.equal(opened.chain.length, 3);
  assert.deepEqual([opened.info.chainLinks.map((link) => link.signatureOk), opened.info.chainComplete], [[null, true, true], false]);
  assert.deepEqual(opened.info.certificate.warnings.map((entry) => entry.code), []);
  const honest = await loadPkcs12(await createPkcs12({ privateKeyPkcs8: KEYS.signer1, certificates: [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa], password: "pw", iterations: 16 }), "pw", { now: NOW });
  assert.deepEqual([honest.info.chainLinks.map((link) => link.signatureOk), honest.info.chainComplete], [[true, true, true], true]);
});
