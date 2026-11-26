// What the Signatures panel and the banner say (signing/verdict.js), from REAL reports of engine/sign
// inspectSignatures() for the cases that matter (self-signed, a chain to a trusted certificate, a forged byte,
// a second signature, content appended after signing) and from hand-made reports for the partial cases.
// The rule that must never break: nothing is "valid" (green) without trust.status "trusted" AND intact bytes
// AND a verified signature value AND a coverage that still stands for the document.
import test from "node:test";
import assert from "node:assert/strict";
import { createSelfSigned, inspectSignatures, loadPkcs12, signPdf } from "../src/pages/pdfEditor/engine/sign/index.js";
import {
  LEVELS, LEVEL_LABELS, bannerOf, describeAdditions, describeIntegrity, describeTrust, describeTrustFailures, integrityOf, levelOf, listSignatures, signingTimeOf, summarize, trustOf
} from "../src/pages/pdfEditor/signing/verdict.js";
import { CERTS, P12, PASSWORD } from "./helpers/pdfSignFixtures.mjs";
import { appendContentRevision, makeSignablePdf } from "./helpers/pdfSignKit.mjs";

const SIGNED_AT = new Date("2026-11-16T01:00:00Z");
const NOW = new Date("2026-11-16T03:00:00Z");
/** The translator of the tests: the English text with its {placeholders} filled in. */
const t = (text, params = {}) => String(text).replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
const entry = (report, patch = {}) => ({ sourceId: "s1", name: "contract.pdf", status: "done", report, ...patch });
const bannerText = (summary) => {
  const banner = bannerOf(summary);
  return banner ? t(banner.text, banner.params) : null;
};

const made = {};
test.before(async () => {
  made.pdf = await makeSignablePdf({ objectStreams: false });
  made.self = await createSelfSigned({ commonName: "Nguyễn Văn An", organization: "ANS Network", keyType: "P-256", now: new Date("2026-06-01T00:00:00Z") });
  made.signer1 = await loadPkcs12(P12.aes256.bytes, PASSWORD);
  made.signer2 = await loadPkcs12(P12.signer2.bytes, PASSWORD);
  made.selfSigned = (await signPdf(made.pdf, { signer: made.self, signingTime: SIGNED_AT })).bytes;
  made.chained = (await signPdf(made.pdf, { signer: made.signer1, signingTime: SIGNED_AT, reason: "Đồng ý" })).bytes;
  made.twice = (await signPdf(made.chained, { signer: made.signer2, signingTime: new Date(SIGNED_AT.getTime() + 60000) })).bytes;
});

const inspect = (bytes, trusted = []) => inspectSignatures(bytes, { trustedCertificates: trusted, now: NOW });
/** One byte changed inside the signed range: in the data of the first content stream. */
function forge(bytes) {
  const forged = bytes.slice();
  const at = Buffer.from(forged).indexOf("stream") + 12;
  assert.ok(at > 12 && at < forged.length / 2, "a stream early in the file");
  forged[at] ^= 0x01;
  return forged;
}

test("verdict: a self-signed signature is intact but never green; trusting that very certificate is the user's own decision", async () => {
  const report = await inspect(made.selfSigned);
  const [signature] = report.signatures;
  assert.equal(levelOf(signature), "unverified");
  assert.equal(trustOf(signature).state, "self-signed");
  assert.deepEqual({ ...integrityOf(signature), changes: undefined }, { content: true, value: true, coverage: "whole-file", state: "intact", laterSignatures: 0, laterTimestamps: 0, onlyValidationData: false, changes: undefined });
  assert.equal(describeIntegrity(integrityOf(signature), t).text, "Not modified since signing");
  assert.equal(describeTrust(trustOf(signature), t).text, "Self-signed certificate: the signer's identity is not confirmed");
  const summary = summarize([entry(report)]);
  assert.equal(summary.state, "ready");
  assert.equal(summary.worst, "unverified");
  assert.deepEqual(bannerOf(summary), { tone: "warning", level: "unverified", text: "Signed, but 1 signer could not be verified.", params: {} });

  const trusted = await inspect(made.selfSigned, [made.self.certificate]);
  assert.equal(levelOf(trusted.signatures[0]), "valid");
  assert.equal(trustOf(trusted.signatures[0]).state, "trusted");
  assert.equal(bannerText(summarize([entry(trusted)])), "Signed by 1 person. The signature is valid.");
  // another self-signed certificate in the list changes nothing
  const other = await createSelfSigned({ commonName: "Nguyễn Văn An", keyType: "P-256" });
  assert.equal(levelOf((await inspect(made.selfSigned, [other.certificate])).signatures[0]), "unverified");
});

test("verdict: a chain to a certificate of the trust list reads Valid; without the list the issuer is unknown", async () => {
  const plain = await inspect(made.chained);
  assert.equal(levelOf(plain.signatures[0]), "unverified");
  assert.equal(trustOf(plain.signatures[0]).state, "unknown-issuer");
  assert.equal(describeTrust(trustOf(plain.signatures[0]), t).text, "The issuer is not in your list of trusted certificates on this device.");

  const trusted = await inspect(made.chained, [CERTS.rootCa]);
  const [signature] = trusted.signatures;
  assert.equal(levelOf(signature), "valid");
  assert.deepEqual(trustOf(signature), { state: "trusted", anchor: "ANS Test Root CA", failures: [], mismatch: false });
  assert.match(describeTrust(trustOf(signature), t).text, /leads to ANS Test Root CA/);
  assert.deepEqual(signingTimeOf(signature), { value: "2026-11-16T01:00:00.000Z", source: "signer" });
  const banner = bannerOf(summarize([entry(trusted)]));
  assert.equal(banner.tone, "success");
  assert.equal(banner.level, "valid");
});

test("verdict: a forged byte inside the signed range is Invalid, whoever the signer is", async () => {
  const forged = forge(made.chained);
  for (const trust of [[], [CERTS.rootCa]]) {
    const report = await inspect(forged, trust);
    const [signature] = report.signatures;
    assert.equal(signature.digestMatches, false);
    assert.equal(levelOf(signature), "invalid");
    const integrity = integrityOf(signature);
    assert.equal(integrity.state, "modified");
    assert.equal(integrity.content, false);
    assert.equal(describeIntegrity(integrity, t).text, "Modified after signing");
    const banner = bannerOf(summarize([entry(report)]));
    assert.deepEqual([banner.tone, banner.level, banner.text], ["error", "invalid", "1 signature is invalid."]);
  }
  // the certificate chain of a forged file may still be perfectly fine: trust and integrity are separate facts
  assert.equal(trustOf((await inspect(forged, [CERTS.rootCa])).signatures[0]).state, "trusted");
});

test("verdict: a second signature: the first covers an earlier version (harmless), newest first, the worst state wins", async () => {
  const report = await inspect(made.twice, [CERTS.rootCa]);
  const listed = listSignatures(report);
  assert.deepEqual(listed.map((item) => item.signature.index), [2, 1]);
  assert.deepEqual(listed.map((item) => item.level), ["valid", "valid"]);
  const earlier = integrityOf(listed[1].signature);
  assert.equal(earlier.state, "earlier");
  assert.equal(earlier.coverage, "revision");
  assert.equal(earlier.laterSignatures, 1);
  assert.equal(describeIntegrity(earlier, t).text, "This signature covers an earlier version of the document. Added later: 1 signature.");
  assert.equal(describeIntegrity(integrityOf(listed[0].signature), t).text, "Not modified since signing");
  assert.equal(bannerText(summarize([entry(report)])), "Signed by 2 people. All signatures are valid.");

  // without the trust list both are "signer not verified"
  const untrusted = summarize([entry(await inspect(made.twice))]);
  assert.equal(bannerText(untrusted), "Signed, but 2 signers could not be verified.");
  // one valid, one invalid: the invalid one decides
  const mixed = summarize([entry(report), entry(await inspect(forge(made.chained), [CERTS.rootCa]), { sourceId: "s2" })]);
  assert.equal(mixed.total, 3);
  assert.deepEqual(mixed.counts, { valid: 2, unverified: 0, invalid: 1, unknown: 0 });
  assert.equal(mixed.worst, "invalid");
  assert.equal(bannerOf(mixed).tone, "error");
});

test("verdict: content appended after the signature: the signature covers an earlier version and no longer stands for the document", async () => {
  const appended = await appendContentRevision(made.chained, "APPENDED AFTER SIGNING: amount is 9999 USD");
  const report = await inspect(appended, [CERTS.rootCa]);
  const [signature] = report.signatures;
  // the engine's three facts: the signed bytes are intact, the value verifies, but only an earlier revision is covered
  assert.deepEqual([signature.digestMatches, signature.signatureValid, signature.coverage.status, signature.verdict], [true, true, "revision", "document-changed"]);
  assert.equal(levelOf(signature), "invalid", "a trusted signer does not make a changed document valid");
  const integrity = integrityOf(signature);
  assert.equal(integrity.state, "changed-later");
  assert.ok(integrity.changes.some((change) => change.code === "SIGN_CHANGE_PAGE_CONTENT"), JSON.stringify(integrity.changes));
  const words = describeIntegrity(integrity, t, (change) => `changed: ${change.code} page ${change.params.page ?? ""}`.trim());
  assert.equal(words.tone, "bad");
  assert.match(words.text, /covers an earlier version of the document/);
  assert.ok(words.details.some((detail) => detail.startsWith("changed: SIGN_CHANGE_PAGE_CONTENT page 1")), JSON.stringify(words.details));
  assert.equal(bannerText(summarize([entry(report)])), "1 signature is invalid.");
});

// ---- hand-made reports: the partial cases ------------------------------------------------------------------

const report = (patch = {}) => ({
  index: 1,
  kind: "signature",
  digestMatches: true,
  signatureValid: true,
  integrity: { digestMatches: true, signatureValid: true, ok: true },
  coverage: { status: "whole-file" },
  trust: { status: "trusted", reason: "anchored", anchorCommonName: "Root" },
  problems: [],
  verdict: "valid",
  ...patch
});

test("verdict: the level table (nothing unknown is ever shown as valid)", () => {
  const cases = [
    ["everything holds", report(), "valid"],
    ["warnings do not take the green away", report({ verdict: "valid-with-warnings", problems: [{ code: "SIGN_PADES_NO_SIGNING_CERTIFICATE", severity: "warning" }] }), "valid"],
    ["trust was not checked", report({ trust: { status: "not-checked", reason: "no-trusted-certificates" } }), "unverified"],
    ["untrusted", report({ trust: { status: "untrusted", reason: "no-path" } }), "unverified"],
    ["no trust object at all", report({ trust: undefined }), "unverified"],
    ["the certificate had expired when the document was signed", report({ verdict: "invalid", trust: { status: "untrusted", reason: "path-not-valid" }, problems: [{ code: "CERT_EXPIRED_AT_SIGNING", severity: "error" }] }), "unverified"],
    ["expired at signing is never valid, whatever the trust says", report({ verdict: "invalid", problems: [{ code: "CERT_NOT_YET_VALID_AT_SIGNING", severity: "error" }] }), "unverified"],
    ["the digest does not match", report({ digestMatches: false, integrity: { ok: false }, verdict: "invalid" }), "invalid"],
    ["the signature value does not verify", report({ signatureValid: false, verdict: "invalid" }), "invalid"],
    ["a structural error (byte range not from the start)", report({ verdict: "invalid", problems: [{ code: "SIGN_BYTE_RANGE_NOT_FROM_START", severity: "error" }] }), "invalid"],
    ["an altered signer certificate", report({ verdict: "invalid", problems: [{ code: "SIGN_SIGNER_CERTIFICATE_ALTERED", severity: "error" }] }), "invalid"],
    ["a certification that allowed no changes was signed over", report({ verdict: "invalid", problems: [{ code: "SIGN_DOCMDP_VIOLATION", severity: "error" }] }), "invalid"],
    ["the engine says invalid without an error this code knows", report({ verdict: "invalid" }), "invalid"],
    ["the digest could not be checked (unsupported algorithm)", report({ digestMatches: null, signatureValid: null, integrity: { ok: null }, verdict: "unknown" }), "unknown"],
    ["the value could not be checked", report({ signatureValid: null, verdict: "unknown" }), "unknown"],
    ["verdict unknown", report({ verdict: "unknown" }), "unknown"],
    ["covers a part of the file", report({ coverage: { status: "partial" } }), "invalid"],
    ["no coverage", report({ coverage: null }), "invalid"],
    ["an earlier version, only signatures added", report({ coverage: { status: "revision" }, changesAfterSigning: { classification: "signatures-only", items: [], laterSignatures: [{ index: 2, kind: "signature" }] } }), "valid"],
    ["an earlier version, something else changed", report({ coverage: { status: "revision" }, verdict: "document-changed", changesAfterSigning: { classification: "other", items: [] } }), "invalid"],
    ["an earlier version, the revisions could not be compared", report({ coverage: { status: "revision" }, changesAfterSigning: { classification: "unknown", reason: "load-failed", items: [] } }), "unknown"],
    ["an earlier version without a comparison", report({ coverage: { status: "revision" } }), "unknown"],
    ["document-changed is never valid", report({ verdict: "document-changed" }), "invalid"],
    ["not a report", null, "unknown"],
    ["an empty object", {}, "unknown"]
  ];
  for (const [name, input, expected] of cases) assert.equal(levelOf(input), expected, name);
  assert.deepEqual(Object.keys(LEVEL_LABELS), [...LEVELS]);
});

test("verdict: integrity and trust in words for every state", () => {
  const sentence = (patch) => describeIntegrity(integrityOf(report(patch)), t);
  assert.deepEqual(sentence({}), { tone: "ok", text: "Not modified since signing", details: [] });
  assert.equal(sentence({ digestMatches: false }).text, "Modified after signing");
  assert.equal(sentence({ digestMatches: null }).tone, "unknown");
  assert.equal(sentence({ coverage: { status: "partial" } }).text, "This signature covers only a part of the file.");
  assert.match(sentence({ coverage: { status: "revision" }, changesAfterSigning: { classification: "unknown" } }).text, /could not be determined/);
  const later = (laterSignatures, extra = {}) => integrityOf(report({ coverage: { status: "revision" }, changesAfterSigning: { classification: "signatures-only", laterSignatures, ...extra } }));
  assert.equal(describeAdditions(later([{ kind: "signature" }, { kind: "signature" }, { kind: "document-timestamp" }]), t), "2 signatures, 1 timestamp");
  assert.equal(describeAdditions(later([{ kind: "document-timestamp" }, { kind: "document-timestamp" }]), t), "2 timestamps");
  assert.equal(describeAdditions(later([], { onlyValidationData: true }), t), "data for checking signatures");
  // changes that are allowed are not listed as what broke the signature
  const changed = integrityOf(report({ coverage: { status: "revision" }, changesAfterSigning: { classification: "other", items: [{ code: "SIGN_CHANGE_METADATA", params: { what: "info" }, allowed: true }, { code: "SIGN_CHANGE_PAGE_CONTENT", params: { page: 1 }, allowed: false }, { code: "SIGN_CHANGE_PAGE_CONTENT", params: { page: 1 }, allowed: false }] } }));
  assert.deepEqual(changed.changes.map((change) => change.code), ["SIGN_CHANGE_PAGE_CONTENT", "SIGN_CHANGE_PAGE_CONTENT"]);
  assert.deepEqual(describeIntegrity(changed, t, (change) => `page ${change.params.page}`).details, ["page 1"], "the same sentence is said once");

  const trust = (value) => trustOf({ trust: value }).state;
  assert.equal(trust({ status: "trusted", anchorCommonName: "A" }), "trusted");
  assert.equal(trust({ status: "not-checked", reason: "no-trusted-certificates", selfSigned: true }), "self-signed");
  assert.equal(trust({ status: "untrusted", reason: "no-path", selfSigned: false }), "unknown-issuer");
  assert.equal(trust({ status: "untrusted", reason: "no-path", failures: [{ reason: "link-not-verified", commonName: "CA" }] }), "chain-unverified");
  assert.equal(trust({ status: "untrusted", reason: "path-not-valid" }), "chain-invalid");
  assert.equal(trust({ status: "not-checked", reason: "no-signer-certificate" }), "no-certificate");
  assert.equal(trust({ status: "not-checked", reason: "not-evaluated" }), "not-evaluated");
  assert.equal(trust(undefined), "unknown-issuer");
  for (const state of ["trusted", "self-signed", "unknown-issuer", "chain-unverified", "chain-invalid", "no-certificate", "not-evaluated"]) {
    const words = describeTrust({ state, anchor: "", failures: [], mismatch: false }, t);
    assert.ok(words.text.length > 20 && (state === "trusted") === (words.tone === "ok"), state);
    assert.deepEqual(words.details, []);
  }
});

test("verdict: why a chain was not accepted is said per certificate, and a signer is never verified by anything but trust.status", () => {
  const reasons = ["link-not-verified", "not-valid-at-time", "not-a-ca", "anchor-not-valid-at-time", "anchor-not-a-ca", "no-certificate-signing-usage", "path-length-exceeded", "unsupported-critical-extension"];
  // every reason the engine can give has a sentence of its own; an unknown one gets the general sentence
  const sentences = describeTrustFailures(reasons.map((reason) => ({ reason, name: "" })), t);
  assert.equal(new Set(sentences).size, reasons.length);
  for (const sentence of sentences) assert.ok(sentence.length > 30 && !/[{}]/.test(sentence) && !reasons.some((reason) => sentence.includes(reason)), sentence);
  assert.deepEqual(describeTrustFailures([{ reason: "something-new", name: "" }], t), ["This certificate does not meet the rules for a chain of certificates."]);
  assert.deepEqual(describeTrustFailures([{ reason: "not-a-ca", name: "Leaf Ltd" }, { reason: "not-a-ca", name: "Leaf Ltd" }], t), ["Leaf Ltd: This certificate issued another certificate of the chain, but it is not the certificate of an issuing authority."], "said once, with the name of the certificate");

  // a link that could not be checked: the names lead to a trusted certificate, the signer is NOT verified
  const forged = { signatureValid: true, trust: { status: "untrusted", reason: "no-path", anchorCommonName: null, failures: [{ reason: "link-not-verified", commonName: "Forged Director" }] } };
  assert.deepEqual(trustOf(forged), { state: "chain-unverified", anchor: "", failures: [{ reason: "link-not-verified", name: "Forged Director" }], mismatch: false });
  const forgedWords = describeTrust(trustOf(forged), t);
  assert.equal(forgedWords.tone, "warn");
  assert.match(forgedWords.details[0], /^Forged Director: This certificate could not be checked against the certificate that issued it/);
  assert.equal(levelOf(report({ trust: forged.trust })), "unverified");

  // a chain that reaches the user's list but breaks a rule: the anchor is named, every broken rule is listed
  const broken = { signatureValid: true, trust: { status: "untrusted", reason: "path-not-valid", anchorCommonName: "Test Root", failures: [{ reason: "path-length-exceeded", commonName: "Test Root" }, { reason: "no-certificate-signing-usage", commonName: "Sub CA" }, { reason: 7 }, null] } };
  const brokenWords = describeTrust(trustOf(broken), t);
  assert.match(brokenWords.text, /lead to Test Root in your list of trusted certificates, but the chain breaks a rule/);
  assert.deepEqual(brokenWords.details, ["Test Root: This certificate allows fewer certificates below it than the chain has.", "Sub CA: This certificate is not allowed to issue certificates."]);
  assert.match(describeTrust(trustOf({ trust: { status: "untrusted", reason: "path-not-valid" } }), t).text, /^The chain of certificates breaks a rule/);
  assert.equal(levelOf(report({ trust: broken.trust })), "unverified");

  // "not-evaluated" also comes WITH a list of trusted certificates: the signature value decides the sentence
  const unchecked = trustOf({ signatureValid: null, trust: { status: "not-checked", reason: "not-evaluated" } });
  assert.deepEqual([unchecked.state, unchecked.mismatch], ["not-evaluated", false]);
  assert.match(describeTrust(unchecked, t).text, /could not be verified/);
  const wrongKey = trustOf({ signatureValid: false, trust: { status: "not-checked", reason: "not-evaluated" } });
  assert.deepEqual([wrongKey.state, wrongKey.mismatch], ["not-evaluated", true]);
  assert.match(describeTrust(wrongKey, t).text, /does not match the certificate/);
  // whatever else a report says (a complete chain, a self-signed flag, an anchor name), only the status counts
  for (const trust of [{ status: "untrusted", reason: "no-path", chainComplete: true, anchorCommonName: "Root" }, { status: "not-checked", reason: "not-evaluated", chainComplete: true, selfSigned: true }, { status: "weird", reason: "anchored", anchorCommonName: "Root" }]) {
    assert.notEqual(trustOf({ trust }).state, "trusted");
    assert.notEqual(levelOf(report({ trust })), "valid");
  }
});

test("verdict: no signing time is presented as proven: it is the signer's statement, or a timestamp whose service nobody verified", () => {
  const time = (signingTime) => signingTimeOf({ signingTime });
  assert.deepEqual(time({ value: "2026-01-02T03:04:05.000Z", source: "signing-time-attribute", proven: false }), { value: "2026-01-02T03:04:05.000Z", source: "signer" });
  assert.deepEqual(time({ value: "2026-01-02T03:04:05.000Z", source: "m-entry", proven: false }), { value: "2026-01-02T03:04:05.000Z", source: "signer" });
  // the engine says "proven" for a token that covers the signature; the authority behind it is never validated
  assert.deepEqual(time({ value: "2026-01-02T03:04:05.000Z", source: "signature-timestamp", proven: true }), { value: "2026-01-02T03:04:05.000Z", source: "timestamp" });
  assert.deepEqual(time({ value: "2026-01-02T03:04:05.000Z", source: "document-timestamp", proven: true }), { value: "2026-01-02T03:04:05.000Z", source: "timestamp" });
  assert.deepEqual(time({ value: null, source: null, proven: false }), { value: null, source: null });
  assert.deepEqual(time(undefined), { value: null, source: null });
  for (const answer of [time({ value: "2026-01-02T03:04:05.000Z", proven: true }), time({ value: "x", proven: false })]) assert.ok(!("proven" in answer), "the interface has no word for a proven time");
});

test("verdict: the banner: the worst state wins, people are counted, a timestamp only matters when it is broken", () => {
  const signatures = (...levels) => ({ signatures: levels.map((level, index) => {
    const base = { index: index + 1 };
    if (level === "valid") return report(base);
    if (level === "unverified") return report({ ...base, trust: { status: "not-checked" } });
    if (level === "invalid") return report({ ...base, digestMatches: false });
    if (level === "stamp") return report({ ...base, kind: "document-timestamp", trust: { status: "untrusted", reason: "no-path" } });
    if (level === "bad-stamp") return report({ ...base, kind: "document-timestamp", digestMatches: false });
    return report({ ...base, verdict: "unknown" });
  }) });
  const text = (...levels) => bannerText(summarize([entry(signatures(...levels))]));
  assert.equal(text("valid"), "Signed by 1 person. The signature is valid.");
  assert.equal(text("valid", "valid", "valid"), "Signed by 3 people. All signatures are valid.");
  assert.equal(text("valid", "unverified"), "Signed, but 1 signer could not be verified.");
  assert.equal(text("unverified", "unverified", "valid"), "Signed, but 2 signers could not be verified.");
  assert.equal(text("valid", "unknown", "unverified"), "1 signature could not be verified.");
  assert.equal(text("unknown", "unknown"), "2 signatures could not be verified.");
  assert.equal(text("valid", "unverified", "unknown", "invalid"), "1 signature is invalid.");
  assert.equal(text("invalid", "invalid"), "2 signatures are invalid.");
  // a document timestamp of an authority nobody trusts does not make a valid signature amber
  assert.equal(text("valid", "stamp"), "Signed by 1 person. The signature is valid.");
  assert.equal(text("valid", "bad-stamp"), "1 signature is invalid.");
  const withStamp = summarize([entry(signatures("valid", "stamp"))]);
  assert.deepEqual([withStamp.signers, withStamp.timestamps, withStamp.total], [1, 1, 2]);

  // nothing to say, and the states before there is a report
  assert.equal(bannerOf(summarize([])), null);
  assert.equal(bannerOf(summarize([entry({ signatures: [] })])), null);
  assert.equal(summarize([entry({ signatures: [] })]).state, "none");
  assert.equal(bannerOf(summarize([{ sourceId: "s", status: "pending" }])).text, "Checking the signatures of this document…");
  assert.equal(bannerOf(summarize([{ sourceId: "s", status: "running" }])).tone, "info");
  assert.match(bannerOf(summarize([{ sourceId: "s", status: "unavailable" }])).text, /https/);
  assert.equal(bannerOf(summarize([{ sourceId: "s", status: "failed", code: "SIGN_INSPECTION_FAILED" }])).tone, "warning");
  assert.equal(summarize([{ sourceId: "s", status: "skipped" }]).state, "skipped");
  // a report that is there counts also while another file is still being checked
  const partial = summarize([entry(signatures("valid")), { sourceId: "s2", status: "running" }]);
  assert.equal(partial.state, "ready");
  assert.equal(partial.checking, true);
  // a certification that allows no changes locks the document
  assert.equal(summarize([entry({ signatures: [report()], document: { certification: { fieldName: "Signature1", level: 1 } } })]).locked, true);
  assert.equal(summarize([entry({ signatures: [report()], document: { certification: { fieldName: "Signature1", level: 2 } } })]).locked, false);
  // every sentence of the banner is a key with its parameters (never a built string)
  for (const levels of [["valid"], ["valid", "valid"], ["unverified"], ["unverified", "unverified"], ["unknown"], ["unknown", "unknown"], ["invalid"], ["invalid", "invalid"]]) {
    const banner = bannerOf(summarize([entry(signatures(...levels))]));
    assert.ok(!/\d{2,}/.test(banner.text) && (levels.length === 1 || banner.params.count === levels.length), banner.text);
  }
});
