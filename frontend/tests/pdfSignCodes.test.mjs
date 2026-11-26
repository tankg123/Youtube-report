// engine/sign: the catalogue of codes (codes.js) is complete and honest.
//   - every code the sources use is declared, every declared code is used by a source;
//   - every code is exercised by a test of this suite (it appears there as a string that is compared with what
//     the engine returned), or it is listed in EXPLAINED with the reason why no hermetic test reaches it;
//   - whatever the engine reports carries only the parameter names the catalogue declares, and no parameter is
//     key material or a password.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { CODES, certificateFacts, createSelfSigned, inspectPdf, inspectSignatures, loadPkcs12, signPdf } from "../src/pages/pdfEditor/engine/sign/index.js";
import { CERTS, KEYS, P12, PASSWORD } from "./helpers/pdfSignFixtures.mjs";
import { appendContentRevision, appendRaw, craftSignedPdf, handMadeCms, hex, makeFormPdf, makeSignablePdf, xrefTable } from "./helpers/pdfSignKit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = path.resolve(HERE, "../src/pages/pdfEditor/engine/sign");
const CODE = /\b(?:SIGN|CERT)_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g;

/**
 * Codes that no test of this suite can reach, each with the reason. A code that IS reached must not be listed
 * (the test below fails then), so the list cannot grow stale.
 */
const EXPLAINED = Object.freeze({});

test("codes: the catalogue is frozen, well-formed and matches the sources in both directions", () => {
  assert.ok(Object.isFrozen(CODES));
  for (const [code, parameters] of Object.entries(CODES)) {
    assert.match(code, /^(?:SIGN|CERT)_[A-Z0-9]+(?:_[A-Z0-9]+)*$/);
    assert.ok(Array.isArray(parameters) && parameters.every((name) => /^[a-zA-Z]+$/.test(name)), `${code}: parameter names`);
    assert.equal(new Set(parameters).size, parameters.length, `${code}: a parameter is listed twice`);
  }
  const usedBy = new Map();
  for (const file of fs.readdirSync(SOURCES).filter((name) => name.endsWith(".js") && name !== "codes.js")) {
    // codes are written as double-quoted strings in the sources (comments mention them without quotes)
    for (const match of fs.readFileSync(path.join(SOURCES, file), "utf8").matchAll(/"((?:SIGN|CERT)_[A-Z0-9_]+)"/g)) {
      if (!usedBy.has(match[1])) usedBy.set(match[1], new Set());
      usedBy.get(match[1]).add(file);
    }
  }
  assert.deepEqual([...usedBy.keys()].filter((code) => !(code in CODES)), [], "codes used in the sources but not declared");
  assert.deepEqual(Object.keys(CODES).filter((code) => !usedBy.has(code)), [], "declared codes that no source uses");
  assert.ok(Object.keys(CODES).length >= 130);
});

test("codes: every code is exercised by a test of this suite, or explained", () => {
  const exercised = new Set();
  for (const file of fs.readdirSync(HERE).filter((name) => /^pdfSign.*\.test\.mjs$/.test(name) && name !== path.basename(fileURLToPath(import.meta.url)))) {
    const text = fs.readFileSync(path.join(HERE, file), "utf8");
    // inside a string that is compared with a result: "CODE", "CODE:severity", "+CODE" / "-CODE" (changes)
    for (const match of text.matchAll(/["'`+-]((?:SIGN|CERT)_[A-Z0-9_]+)["'`:]/g)) exercised.add(match[1]);
  }
  const declared = Object.keys(CODES);
  assert.deepEqual([...exercised].filter((code) => !(code in CODES)), [], "tests expect codes that do not exist");
  assert.deepEqual(declared.filter((code) => !exercised.has(code) && !(code in EXPLAINED)), [], "codes without a test and without an explanation");
  assert.deepEqual(Object.keys(EXPLAINED).filter((code) => exercised.has(code) || !(code in CODES)), [], "explanations that are no longer needed");
  for (const reason of Object.values(EXPLAINED)) assert.ok(typeof reason === "string" && reason.length > 20);
});

/** Every { code, params } found anywhere inside a result (warnings, problems, changes, findings). */
function collectCoded(value, found = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 12 || ArrayBuffer.isView(value) || value instanceof Date) return found;
  if (typeof value.code === "string" && CODE.test(value.code)) found.push(value);
  CODE.lastIndex = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value)) collectCoded(child, found, depth + 1);
  return found;
}

test("codes: what the engine reports carries declared parameters only, and never key material or a password", async () => {
  const seen = [];
  const note = (result) => {
    seen.push(...collectCoded(result));
    return result;
  };
  const thrown = async (promise) => {
    try {
      await promise;
    } catch (error) {
      assert.ok(isPdfEditorError(error), `a raw ${error && error.name} escaped: ${error && error.message}`);
      seen.push({ code: error.code, params: error.params, message: error.message });
      return error;
    }
    return assert.fail("expected an error");
  };
  const now = new Date("2026-11-16T03:00:00Z");
  const signedAt = new Date("2026-11-16T01:00:00Z");

  // certificates and containers
  for (const der of Object.values(CERTS)) note(await certificateFacts(der, { now, role: "signer" }).catch(() => null));
  const signer = note(await loadPkcs12(P12.aes256.bytes, PASSWORD));
  note(await loadPkcs12(P12.legacyRc2.bytes, P12.legacyRc2.password));
  const own = note(await createSelfSigned({ commonName: "Mã lỗi", keyType: "P-256", p12Password: "một mật khẩu", now: new Date("2020-01-01T00:00:00Z"), years: 1 }));
  await thrown(loadPkcs12(P12.aes256.bytes, "not the password"));
  await thrown(loadPkcs12(P12.rc4.bytes, P12.rc4.password));
  await thrown(loadPkcs12(new TextEncoder().encode("-----BEGIN CERTIFICATE-----"), ""));
  await thrown(loadPkcs12(P12.aes256.bytes.subarray(0, 500), PASSWORD));
  await thrown(createSelfSigned({ commonName: "" }));
  await thrown(certificateFacts(Uint8Array.of(1, 2, 3)));

  // signing
  const pdf = await makeSignablePdf();
  const form = await makeFormPdf({ fields: [{ name: "Approval" }], needAppearances: true, xfa: true });
  note(await inspectPdf(form));
  const once = note(await signPdf(pdf, { signer, signingTime: signedAt, certify: 2 }));
  note(await inspectPdf(once.bytes));
  const twice = note(await signPdf(once.bytes, { signer: own, signingTime: signedAt }));
  note(await signPdf(form, { signer, signingTime: signedAt, fieldName: "Approval" }));
  await thrown(signPdf(pdf, { signer, appearance: { pageIndex: 9, rect: [0, 0, 10, 10], png: new Uint8Array(8) } }));
  await thrown(signPdf(pdf.subarray(0, pdf.length - 40), { signer }));
  await thrown(signPdf(pdf, { signer, colour: "blue" }));
  await thrown(signPdf(once.bytes, { signer, certify: 1 }));

  // inspection: valid, changed, attacked and broken signatures
  const roots = { trustedCertificates: [CERTS.rootCa], now };
  note(await inspectSignatures(twice.bytes, roots));
  note(await inspectSignatures(await appendContentRevision(twice.bytes), roots));
  note(await inspectSignatures(appendRaw(once.bytes, (start, facts) => xrefTable(start, facts, [[3, 0, 1, "f"]], { prev: null })), roots));
  const weak = await craftSignedPdf(pdf, { prepare: { subFilter: "adbe.pkcs7.detached" }, container: (signed) => handMadeCms(signed, { certificate: CERTS.signer1, privateKeyPkcs8: KEYS.signer1, hash: "sha1", attributes: "none" }) });
  note(await inspectSignatures(weak, roots));
  const broken = Uint8Array.from(twice.bytes);
  broken[100] ^= 1;
  note(await inspectSignatures(broken, roots));

  assert.ok(seen.length > 40, `${seen.length} coded findings were looked at`);
  const secrets = [PASSWORD, "một mật khẩu", "not the password", hex(KEYS.signer1).slice(200, 264), Buffer.from(KEYS.signer1).toString("base64").slice(100, 164)];
  for (const entry of seen) {
    assert.ok(entry.code in CODES, `undeclared code ${entry.code}`);
    const names = Object.keys(entry.params || {});
    assert.deepEqual(names.filter((name) => !CODES[entry.code].includes(name)), [], `${entry.code}: undeclared parameter`);
    const text = JSON.stringify(entry.params || {}) + (entry.message || "");
    for (const secret of secrets) assert.ok(!text.includes(secret), `${entry.code} carries secret material`);
    for (const value of Object.values(entry.params || {})) {
      assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value), `${entry.code}: parameter of type ${typeof value}`);
    }
  }
  // a broad sample: the three kinds (thrown, warning, problem / change) are all in it
  const codes = new Set(seen.map((entry) => entry.code));
  for (const expected of ["CERT_WRONG_PASSWORD", "CERT_EXPIRED", "SIGN_BAD_PAGE", "SIGN_CERTIFIED", "SIGN_DOCUMENT_MODIFIED", "SIGN_CHANGE_PAGE_CONTENT", "SIGN_CHANGE_XREF"]) {
    assert.ok(codes.has(expected), `${expected} was not produced by the sample`);
  }
});
