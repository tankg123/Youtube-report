// engine/pipeline: stage D (signOutput, verifySigned) and the browser env (createBrowserPipelineEnv, driven
// here by the Node twin of pdfWorker.js). Hermetic: the identity is a self-signed one made in the test.
import test from "node:test";
import assert from "node:assert/strict";
import { buildOutput, createBrowserPipelineEnv, signOutput, verifySigned } from "../src/pages/pdfEditor/engine/pipeline/index.js";
import { createSelfSigned } from "../src/pages/pdfEditor/engine/sign/index.js";
import { canRender, canvasLib, loadFont, makePng, makeTextPdf, pdfjs, squash } from "./helpers/pdfTestKit.mjs";
import { boxOf, openPdfDocument } from "./helpers/pdfRedactKit.mjs";
import { plainTextPdf } from "./helpers/pdfRedactFixtures.mjs";
import { buildEncryptedFixture } from "./helpers/pdfExportFixtures.mjs";
import { makeFormPdf } from "./helpers/pdfSignKit.mjs";
import { fixedOptions, makeJob, pageTexts, pipelineEnv, rejectsWith, sourceOf, textBox } from "./helpers/pdfPipelineKit.mjs";

const NOW = new Date(Date.UTC(2026, 10, 20, 3, 0, 0));
let identityPromise = null;
/** One self-signed identity for the suite (the private key never leaves WebCrypto). */
const identity = () => (identityPromise ||= createSelfSigned({ commonName: "Nguyễn Văn An", organization: "Công ty TNHH Ánh Dương", country: "VN", keyType: "P-256", years: 2, now: NOW }));
const startsWith = (bytes, prefix) => bytes.length > prefix.length && Buffer.compare(Buffer.from(bytes.buffer, bytes.byteOffset, prefix.length), Buffer.from(prefix)) === 0;

/** The output of buildOutput() for a job with a redaction and a text box. */
async function builtDocument() {
  const plain = await plainTextPdf();
  const rect = await boxOf(plain.bytes, plain.secret, { pad: 0.5 });
  const job = makeJob({
    sources: [sourceOf("plain", plain.bytes, 1)],
    pages: [{ source: "plain", index: 0, rotate: 0 }, { blank: [300, 200], rotate: 0 }],
    objects: [[textBox({ id: "note", pageId: "p0", text: "Đã duyệt ngày 20/11/2026", left: 72, top: 400 })], []],
    marks: [{ pageIndex: 0, rect, mode: "redact", color: "#000000", objectId: "m" }]
  });
  const { bytes } = await buildOutput(job, pipelineEnv(), fixedOptions());
  return { bytes, plain };
}

test("signOutput + verifySigned on the output of buildOutput, with a self-signed identity", async () => {
  const { bytes: unsigned, plain } = await builtDocument();
  const before = unsigned.slice();
  const signer = await identity();
  const signed = await signOutput(unsigned, { signer, name: "Nguyễn Văn An", reason: "Phê duyệt", location: "Hà Nội", signingTime: NOW });

  assert.deepEqual(unsigned, before, "the input bytes were changed");
  assert.ok(startsWith(signed.bytes, unsigned), "the signed file does not start with the unsigned bytes");
  assert.equal(signed.report.visible, false);
  assert.equal(signed.report.originalLength, unsigned.length);
  assert.ok(typeof signed.report.fieldName === "string" && signed.report.fieldName);
  assert.ok(Array.isArray(signed.report.warnings));

  const checked = await verifySigned(signed.bytes, { fieldName: signed.report.fieldName, now: NOW });
  assert.equal(checked.ok, true, JSON.stringify(checked.signature?.problems));
  assert.equal(checked.signature.fieldName, signed.report.fieldName);
  assert.equal(checked.signature.digestMatches, true);
  assert.equal(checked.signature.signatureValid, true);
  assert.equal(checked.signature.coverage.status, "whole-file");
  assert.equal(checked.report.signatures.length, 1);
  // "ok" says the file is intact, not who signed it
  assert.notEqual(checked.signature.trust.status, "trusted");
  const anchored = await verifySigned(signed.bytes, { fieldName: signed.report.fieldName, trustedCertificates: [signer.certificate], now: NOW });
  assert.equal(anchored.ok, true);
  assert.equal(anchored.signature.trust.status, "trusted");

  // the signed file is still the document that was built
  const texts = await pageTexts(signed.bytes);
  assert.equal(texts.length, 2);
  assert.ok(texts[0].includes(squash("Đã duyệt ngày 20/11/2026")) && !texts[0].includes(squash(plain.secret)));

  // one changed byte of the signed part is noticed
  const tampered = signed.bytes.slice();
  const at = Buffer.from(tampered).indexOf("%PDF-") + 20;
  tampered[at] ^= 0x01;
  const broken = await verifySigned(tampered, { fieldName: signed.report.fieldName, now: NOW });
  assert.equal(broken.ok, false);
  // a field that is not there, a file without signatures
  assert.deepEqual(await verifySigned(signed.bytes, { fieldName: "NoSuchField", now: NOW }).then((result) => [result.ok, result.signature]), [false, null]);
  const none = await verifySigned(unsigned, { now: NOW });
  assert.deepEqual([none.ok, none.signature, none.report.signatures.length], [false, null, 0]);
});

test("a visible signature on the built document: the picture goes on the page, the result verifies", { skip: !canRender && "no canvas" }, async () => {
  const { bytes: unsigned } = await builtDocument();
  const signer = await identity();
  const signed = await signOutput(unsigned, { signer, signingTime: NOW, appearance: { pageIndex: 1, rect: [40, 40, 200, 100], png: makePng(60, 20, [30, 60, 220, 255]) } });
  assert.equal(signed.report.visible, true);
  assert.equal(signed.report.pageIndex, 1);
  const checked = await verifySigned(signed.bytes, { now: NOW });
  assert.equal(checked.ok, true);
  assert.equal(checked.signature.fieldName, signed.report.fieldName);
  assert.equal(checked.signature.visible, true);
});

test("signing the untouched bytes of a source leaves them as the exact prefix; a second signature keeps the first intact", async () => {
  const source = await makeTextPdf([{ lines: ["Hợp đồng gốc không chỉnh sửa", "Trang 1"] }, { lines: ["Trang 2"] }], { useObjectStreams: false });
  const before = source.slice();
  const signer = await identity();
  const first = await signOutput(source, { signer, signingTime: NOW });
  assert.deepEqual(source, before);
  assert.equal(first.bytes.length > source.length, true);
  assert.ok(startsWith(first.bytes, source), "the source bytes are not the exact prefix of the signed file");
  assert.equal((await verifySigned(first.bytes, { now: NOW })).ok, true);

  const second = await signOutput(first.bytes, { signer, signingTime: new Date(NOW.getTime() + 60000) });
  assert.ok(startsWith(second.bytes, first.bytes));
  assert.notEqual(second.report.fieldName, first.report.fieldName);
  // without a field name: the newest signature, which covers the whole file
  const newest = await verifySigned(second.bytes, { now: NOW });
  assert.equal(newest.ok, true);
  assert.equal(newest.signature.fieldName, second.report.fieldName);
  // the first one is still valid, but it no longer covers the whole file: ok is false, the verdict says why
  const earlier = await verifySigned(second.bytes, { fieldName: first.report.fieldName, now: NOW });
  assert.equal(earlier.ok, false);
  assert.equal(earlier.signature.digestMatches, true);
  assert.equal(earlier.signature.signatureValid, true);
  assert.equal(earlier.signature.coverage.status, "revision");
  assert.equal(earlier.signature.verdict, "valid");
});

test("signOutput: a blocker of the file is thrown as its code, findings of the inspection travel as warnings", async () => {
  const signer = await identity();
  await rejectsWith(signOutput(new TextEncoder().encode("plain text, not a PDF"), { signer }), "SIGN_NOT_A_PDF");
  await rejectsWith(signOutput(await buildEncryptedFixture({ userPassword: "secret" }), { signer }), "SIGN_ENCRYPTED");
  await rejectsWith(signOutput("not bytes", { signer }), "SIGN_BAD_OPTIONS", { option: "bytes" });
  // the file is looked at FIRST: what is wrong with it is said before anything about the options
  await rejectsWith(signOutput(new TextEncoder().encode("plain text, not a PDF"), { signer, colour: "blue" }), "SIGN_NOT_A_PDF");
  // an option the signer refuses
  const source = await makeTextPdf([{ lines: ["Một trang"] }]);
  await rejectsWith(signOutput(source, { signer, colour: "blue" }), "SIGN_BAD_OPTIONS", { option: "colour" });
  await rejectsWith(signOutput(source, { signer: { ...signer, privateKey: null } }), "SIGN_BAD_SIGNER");
  await rejectsWith(signOutput(source, { signer, appearance: { pageIndex: 7, rect: [10, 10, 100, 60], png: makePng(8, 8) } }), "SIGN_BAD_PAGE", { pageIndex: 7, pageCount: 1 });
  // cancelled before anything was done
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(signOutput(source, { signer, signal: controller.signal }), "CANCELLED");

  // a form that asks viewers to redraw its fields: said by the inspection and by the signer, reported once
  const form = await makeFormPdf({ fields: [{ name: "Ghi chú", type: "Tx" }], needAppearances: true });
  const signed = await signOutput(form, { signer, signingTime: NOW, appearance: { pageIndex: 0, rect: [300, 100, 460, 160], png: makePng(60, 20) } });
  const codes = signed.report.warnings.map((entry) => entry.code);
  assert.equal(codes.filter((code) => code === "SIGN_NEED_APPEARANCES").length, 1, codes.join(", "));
  assert.ok(signed.report.warnings.every((entry) => entry && typeof entry.code === "string" && entry.params && typeof entry.params === "object" && !("blocking" in entry)));
  assert.equal((await verifySigned(signed.bytes, { now: NOW })).ok, true);
  // an invisible signature on that form: only the inspection has something to say, and it is not lost
  const invisible = await signOutput(form, { signer, signingTime: NOW });
  assert.deepEqual(invisible.report.warnings.map((entry) => entry.code).filter((code) => code === "SIGN_NEED_APPEARANCES"), ["SIGN_NEED_APPEARANCES"]);
  assert.equal(invisible.report.visible, false);
});

// ---------------------------------------------------------------------------------------------------------
// the browser env
// ---------------------------------------------------------------------------------------------------------

const htmlCanvas = (width, height) => canvasLib.createCanvas(width, height);

test("createBrowserPipelineEnv: the env of a job from the exports of pdfWorker.js and the font registry", { skip: !canRender && "no canvas" }, async () => {
  const registry = { getFontBytes: loadFont };
  const env = createBrowserPipelineEnv({ pdfjs, openPdfDocument, onPdfWorkerError: () => () => {}, fonts: registry, createCanvas: htmlCanvas });
  assert.deepEqual(Object.keys(env).sort(), ["closePdf", "createCanvas", "encodeJpeg", "fonts", "openPdf", "pdfjs"]);
  assert.ok((await env.fonts("arimo-regular")).length > 1000);

  const plain = await plainTextPdf();
  const rect = await boxOf(plain.bytes, plain.secret, { pad: 0.5 });
  const job = makeJob({
    sources: [sourceOf("plain", plain.bytes, 1)],
    pages: [{ source: "plain", index: 0, rotate: 0 }],
    objects: [[textBox({ id: "note", pageId: "p0", text: "Ghi chú của người dùng", left: 72, top: 400 })]],
    marks: [{ pageIndex: 0, rect, mode: "redact", color: "#000000", objectId: "m" }]
  });
  // (a function for the fonts works as well as the registry)
  for (const fonts of [registry, loadFont]) {
    const { bytes, report } = await buildOutput(job, createBrowserPipelineEnv({ pdfjs, openPdfDocument, fonts, createCanvas: htmlCanvas }), fixedOptions({ random: () => 0.5 }));
    const [text] = await pageTexts(bytes);
    assert.ok(text.includes(squash("Ghi chú của người dùng")) && !text.includes(squash(plain.secret)));
    assert.equal(report.redaction.targets[0].outcome, "precise");
  }

  for (const [missing, parts] of [["pdfjs", { pdfjs: {} }], ["openPdf", { openPdfDocument: null }], ["fonts", { fonts: null }]]) {
    assert.throws(() => createBrowserPipelineEnv({ pdfjs, openPdfDocument, fonts: registry, createCanvas: htmlCanvas, ...parts }), (error) => error.code === "REDACT_ENV_INVALID" && error.params.missing === missing);
  }
});

test("a pdf.js worker that cannot start ends the job with an error instead of waiting for ever", { timeout: 20000 }, async () => {
  // a loading task that never settles, and the worker error that pdfWorker.js reports for it
  const listeners = new Set();
  const stuck = () => {
    setTimeout(() => listeners.forEach((listener) => listener(new Error("Setting up fake worker failed"))), 5);
    return { promise: new Promise(() => {}) };
  };
  const onPdfWorkerError = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const env = createBrowserPipelineEnv({ pdfjs, openPdfDocument: stuck, onPdfWorkerError, fonts: loadFont, createCanvas: htmlCanvas });
  const source = await makeTextPdf([{ lines: ["Một trang"] }]);
  const plain = makeJob({ sources: [sourceOf("s", source, 1)], pages: [{ source: "s", index: 0, rotate: 0 }] });
  const error = await rejectsWith(buildOutput(plain, env, {}), "REDACT_ENV_INVALID", { missing: "worker" });
  assert.match(String(error.cause?.message), /fake worker/);
  assert.equal(listeners.size, 0, "the listener was not removed");
  const marked = { ...plain, marks: [{ pageIndex: 0, rect: [40, 760, 200, 800], mode: "redact", color: "#000000", objectId: "m" }] };
  await rejectsWith(buildOutput(marked, env, {}), "REDACT_ENV_INVALID", { missing: "worker" });
});
