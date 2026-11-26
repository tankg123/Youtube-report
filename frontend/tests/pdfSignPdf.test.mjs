// engine/sign: signPdf and inspectPdf on generated PDFs. Every signed output is verified INSIDE the test with
// independent code (tests/helpers/pdfSignKit.mjs: raw /ByteRange + /Contents, its own DER walker, node:crypto)
// and then also with the product's inspectSignatures.
import test from "node:test";
import assert from "node:assert/strict";
import { CANCELLED } from "../src/pages/pdfEditor/engine/errors.js";
import { readLastXrefSection } from "../src/pages/pdfEditor/engine/sign/pdfRaw.js";
import { embedSignature, prepareSignature, signPdfDetailed } from "../src/pages/pdfEditor/engine/sign/pdfSign.js";
import {
  SUBFILTERS, SUBFILTER_PADES, SUBFILTER_PKCS7, createSelfSigned, inspectPdf, inspectSignatures, loadPkcs12, signPdf, signedRevisionBytes, signingSupport
} from "../src/pages/pdfEditor/engine/sign/index.js";
import { canRender, extractText, makeTextPdf, pdfLib, rectToPixels, renderPage, withPdf } from "./helpers/pdfTestKit.mjs";
import { CERTS, KEYS, P12, PASSWORD } from "./helpers/pdfSignFixtures.mjs";
import {
  OIDS, QUADRANT_COLORS, countOf, fakeTsa, fromLatin1, importTestKey, latin1, makeFormPdf, makeSignablePdf, quadrantPng, rejectsWithCode,
  sameBytes, verifyIndependently, withFailingDigest, withoutWebCrypto
} from "./helpers/pdfSignKit.mjs";

const SIGNED_AT = new Date("2026-11-16T01:00:00Z");
const NOW = new Date("2026-11-16T03:00:00Z");
const REASON = "Tôi đồng ý với nội dung tài liệu";
const STAMP = quadrantPng(60, 20);
// one stamp per page rotation: 150 x 50 as the reader sees it
const RECTS = { 0: [100, 300, 250, 350], 90: [100, 300, 150, 450] };

const signers = {};
const inputs = {};
test.before(async () => {
  signers.rsa = await loadPkcs12(P12.aes256.bytes, PASSWORD);
  signers.rsa2 = await loadPkcs12(P12.signer2.bytes, PASSWORD);
  signers.ec = await loadPkcs12(P12.ecP256.bytes, PASSWORD);
  signers.windows = await loadPkcs12(P12.windows3des.bytes, PASSWORD);
  inputs.classic = await makeSignablePdf({ objectStreams: false });
  inputs.stream = await makeSignablePdf({ objectStreams: true });
});

const inspect = (bytes, options = {}) => inspectSignatures(bytes, { trustedCertificates: [CERTS.rootCa], now: NOW, ...options });
const definedObjects = (bytes, from) => [...latin1(bytes.subarray(from)).matchAll(/(?:^|\n)(\d+) (\d+) obj\n/g)].map((match) => Number(match[1])).sort((a, b) => a - b);
const near = (actual, expected, tolerance = 24) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

/** The four quadrant colours of the stamp as the READER sees them on the displayed page (pdf.js render). */
async function stampOnScreen(bytes, pageIndex, rect) {
  return withPdf(bytes, async (doc) => {
    const page = await doc.getPage(pageIndex + 1);
    const { ctx, canvas, viewport } = await renderPage(page, { scale: 2 });
    const [left, top, right, bottom] = rectToPixels(viewport, rect, canvas);
    const sample = (u, v) => [...ctx.getImageData(Math.round(left + (right - left) * u), Math.round(top + (bottom - top) * v), 1, 1).data].slice(0, 3);
    return {
      size: [right - left, bottom - top],
      topLeft: sample(0.25, 0.25), topRight: sample(0.75, 0.25), bottomLeft: sample(0.25, 0.75), bottomRight: sample(0.75, 0.75),
      outside: sample(-0.2, 0.5)
    };
  });
}

test("sign: the environment and the subfilters on offer", () => {
  assert.deepEqual(signingSupport(), { secureContext: null, subtle: true }); // Node has no isSecureContext
  assert.deepEqual(SUBFILTERS, ["ETSI.CAdES.detached", "adbe.pkcs7.detached"]);
});

for (const [inputName, xref] of [["classic", "table"], ["stream", "stream"]]) {
  for (const subFilter of [SUBFILTER_PADES, SUBFILTER_PKCS7]) {
    for (const [key, pageIndex] of [["rsa", 0], ["ec", 1]]) {
      const rotation = pageIndex === 0 ? 0 : 90;
      test(`sign: ${inputName} cross-reference ${xref}, ${subFilter}, ${key}, visible on a /Rotate ${rotation} page: incremental, intact, verifiable`, async () => {
        const input = inputs[inputName];
        const copy = Uint8Array.from(input);
        const before = readLastXrefSection(input);
        const { bytes: out, report } = await signPdf(input, {
          signer: signers[key], subFilter, signingTime: SIGNED_AT, timeZoneOffsetMinutes: 420, name: "Nguyễn Văn An", reason: REASON, location: "Hà Nội",
          contactInfo: "an@example.test", appearance: { pageIndex, rect: RECTS[rotation], png: STAMP }
        });
        // 1. the input is the exact prefix of the output and was not touched
        assert.ok(sameBytes(input, copy), "the input buffer is unchanged");
        assert.ok(sameBytes(out.subarray(0, input.length), input), "the original bytes are the prefix");
        // 2. exactly one more revision, same cross-reference style, /Prev chained, /Root kept
        assert.equal(countOf(out, "startxref"), countOf(input, "startxref") + 1);
        const after = readLastXrefSection(out);
        assert.equal(after.type, xref);
        assert.equal(after.prev, before.offset);
        assert.equal(after.root.tag, before.root.tag);
        assert.ok(after.size > before.size);
        assert.ok(latin1(out).endsWith("%%EOF\n"));
        // 3. the report
        assert.equal(report.fieldName, "Signature1");
        assert.equal(report.subFilter, subFilter);
        assert.equal(report.xref, xref);
        assert.deepEqual(report.warnings, []);
        assert.deepEqual([report.pageIndex, report.rect, report.visible, report.usedExistingField, report.certified], [pageIndex, RECTS[rotation], true, false, 0]);
        assert.equal(report.signingTime, SIGNED_AT.toISOString());
        assert.equal(report.originalLength, input.length);
        // 4. independent verification: byte range, digest, CMS structure, signature (node:crypto)
        const verified = verifyIndependently(out);
        assert.deepEqual(verified.byteRange, report.byteRange);
        assert.equal(verified.byteRange[0], 0);
        assert.equal(verified.byteRange[2] + verified.byteRange[3], out.length, "the byte range ends at the end of the file");
        assert.equal(verified.capacity, report.contentsLength);
        assert.equal(verified.cms.length, report.cmsLength);
        assert.ok(report.cmsLength <= report.contentsLength);
        assert.equal(verified.digestOk, true, "message-digest = SHA-256 of the two byte ranges");
        assert.equal(verified.signatureOk, true, "node:crypto verifies the signature over the signed attributes");
        assert.equal(verified.version, 1);
        assert.equal(verified.digestAlgorithm, OIDS.sha256);
        assert.equal(verified.encapChildren, 1, "detached: no eContent");
        assert.equal(verified.certificates.length, 3);
        assert.ok(verified.certificates.some((certificate) => sameBytes(certificate, signers[key].certificate)));
        assert.equal(verified.signerCertificate.fingerprint256, signers[key].info.certificate.fingerprintSha256);
        assert.equal(verified.signatureAlgorithm, key === "rsa" ? OIDS.rsaEncryption : OIDS.ecdsaWithSha256);
        assert.deepEqual(verified.unsignedAttributes, []);
        const expectedAttributes = [OIDS.contentType, OIDS.messageDigest, OIDS.signingCertificateV2, ...(subFilter === SUBFILTER_PKCS7 ? [OIDS.signingTime] : [])];
        assert.deepEqual(verified.attributes.map((attribute) => attribute.oid).sort(), expectedAttributes.sort());
        // 5. objects: only the announced ones are defined in the update, new numbers start at the old /Size
        const defined = definedObjects(out, input.length);
        const announced = [...report.rewrittenObjects.map((tag) => Number(tag.split(" ")[0])), ...report.newObjectNumbers].sort((a, b) => a - b);
        assert.ok(report.newObjectNumbers.every((number) => number >= before.size));
        assert.equal(report.rewrittenObjects.length, 2, "the page and the catalog (there was no AcroForm)");
        assert.ok(report.rewrittenObjects.includes(before.root.tag));
        if (xref === "table") assert.deepEqual(defined, announced);
        else assert.deepEqual(defined, [...announced, after.xrefStreamRef.objectNumber].sort((a, b) => a - b));
        // 6. the product's own inspector says the same, with the three facts apart
        const result = await inspect(out);
        assert.equal(result.signatures.length, 1);
        const signature = result.signatures[0];
        assert.deepEqual([signature.digestMatches, signature.signatureValid, signature.coverage.status, signature.verdict], [true, true, "whole-file", "valid"]);
        assert.deepEqual(signature.problems, []);
        assert.deepEqual([signature.fieldName, signature.subFilter, signature.pageIndex, signature.visible], ["Signature1", subFilter, pageIndex, true]);
        assert.deepEqual(signature.rect, RECTS[rotation]);
        assert.deepEqual([signature.nameEntry, signature.reason, signature.location, signature.contactInfo], ["Nguyễn Văn An", REASON, "Hà Nội", "an@example.test"]);
        assert.equal(signature.signerName, key === "rsa" ? "Nguyễn Văn An" : "Lê Minh Châu (ECDSA P-256)");
        assert.equal(signature.signingTime.m, SIGNED_AT.toISOString());
        assert.equal(signature.signingTime.mText, "D:20261116080000+07'00'");
        assert.equal(signature.signingTime.source, subFilter === SUBFILTER_PKCS7 ? "signing-time-attribute" : "m-entry");
        assert.equal(signature.signingTime.proven, false);
        assert.deepEqual([signature.trust.status, signature.trust.reason, signature.trust.anchorCommonName], ["trusted", "anchored", "ANS Test Root CA"]);
        assert.equal(signature.signerCertificateCheck, "bound-by-signature");
        assert.deepEqual(signature.byteRange, report.byteRange);
        // 7. what a viewer shows: the same text on every page as before
        assert.deepEqual(await extractText(out), await extractText(input));
        const facts = await inspectPdf(out);
        assert.deepEqual([facts.signable, facts.signatureCount, facts.pageCount, facts.xref], [true, 1, 2, xref]);
      });
    }
  }
}

test("sign: the stamp is one picture, upright for the reader on pages with /Rotate 0 and 90", async () => {
  const classic = inputs.classic;
  for (const [pageIndex, rotation] of [[0, 0], [1, 90]]) {
    const { bytes: out } = await signPdf(classic, { signer: signers.rsa, signingTime: SIGNED_AT, appearance: { pageIndex, rect: RECTS[rotation], png: STAMP } });
    const appended = latin1(out.subarray(classic.length));
    // ONE form XObject holding ONE image; its box is the stamp as the reader sees it (150 x 50)
    assert.equal(countOf(out.subarray(classic.length), "/Subtype /Form"), 1);
    assert.equal(countOf(out.subarray(classic.length), "/Subtype /Image"), 1);
    assert.match(appended, /\/BBox \[ 0 0 150 50 \]/);
    assert.match(appended, /\/F 132\b/);
    const formObject = appended.split("endobj").find((object) => object.includes("/Subtype /Form"));
    assert.ok(!formObject.includes("/Font"), "the appearance holds no text of its own");
    assert.match(formObject, /\/Resources <<\s*\/XObject <<\s*\/Img \d+ 0 R\s*>>\s*>>/);
    if (rotation === 90) {
      assert.match(appended, /\/Matrix \[ 0 1 -1 0 50 0 \]/);
      assert.match(appended, /\/MK <<\s*\/R 90\s*>>/);
    } else {
      assert.ok(!appended.includes("/Matrix") && !appended.includes("/MK"));
    }
    assert.equal(verifyIndependently(out).signatureOk, true);
    if (canRender) {
      const seen = await stampOnScreen(out, pageIndex, RECTS[rotation]);
      // 150 x 50 points on screen at scale 2, whatever the page rotation (a pixel of rounding at the edges)
      assert.ok(Math.abs(seen.size[0] - 300) <= 1 && Math.abs(seen.size[1] - 100) <= 1, `stamp of ${seen.size} pixels`);
      for (const corner of ["topLeft", "topRight", "bottomLeft", "bottomRight"]) {
        assert.ok(near(seen[corner], QUADRANT_COLORS[corner]), `/Rotate ${rotation}: ${corner} is rgb(${seen[corner]}), expected rgb(${QUADRANT_COLORS[corner]})`);
      }
      assert.ok(near(seen.outside, [255, 255, 255]), "nothing is drawn outside the rectangle");
    }
  }
  // a picture with another aspect ratio is letterboxed, never stretched
  const square = await signPdf(classic, { signer: signers.rsa, signingTime: SIGNED_AT, appearance: { pageIndex: 0, rect: RECTS[0], png: quadrantPng(20, 20) } });
  assert.match(latin1(square.bytes.subarray(classic.length)), /q\n50 0 0 50 50 0 cm\n\/Img Do\nQ/);
});

test("sign: invisible signature = zero rectangle, no appearance, flags Print + Locked, three new objects", async () => {
  const classic = inputs.classic;
  const { bytes: out, report } = await signPdf(classic, { signer: signers.rsa, signingTime: SIGNED_AT, pageIndex: 1 });
  const appended = latin1(out.subarray(classic.length));
  assert.deepEqual([report.rect, report.visible, report.pageIndex], [[0, 0, 0, 0], false, 1]);
  assert.match(appended, /\/Rect \[ 0 0 0 0 \]/);
  assert.match(appended, /\/F 132\b/);
  assert.ok(!appended.includes("/AP") && !appended.includes("/Subtype /Form") && !appended.includes("/Subtype /Image"));
  assert.equal(report.newObjectNumbers.length, 3, "signature dictionary, field + widget, AcroForm");
  assert.match(appended, /\/SigFlags 3\b/);
  assert.match(appended, /\/Extensions <<\s*\/ESIC <<\s*\/Type \/DeveloperExtensions\s*\/BaseVersion \/1\.7\s*\/ExtensionLevel 1\s*>>\s*>>/);
  const signature = (await inspect(out)).signatures[0];
  assert.deepEqual([signature.visible, signature.pageIndex, signature.rect, signature.verdict], [false, 1, [0, 0, 0, 0], "valid"]);
  assert.deepEqual([verifyIndependently(out).digestOk, verifyIndependently(out).signatureOk], [true, true]);
  // an identity straight from a Windows-exported Triple-DES container signs the same way
  const windows = await signPdf(inputs.stream, { signer: signers.windows, signingTime: SIGNED_AT });
  assert.equal(verifyIndependently(windows.bytes).signatureOk, true);
  assert.equal((await inspect(windows.bytes)).signatures[0].verdict, "valid");
});

test("sign: two signatures in a row: the first stays byte-identical, covers its own revision and stays valid", async () => {
  for (const inputName of ["classic", "stream"]) {
    const input = inputs[inputName];
    const first = await signPdf(input, { signer: signers.rsa, signingTime: SIGNED_AT, name: "An", reason: "Người ký thứ nhất" });
    const second = await signPdf(first.bytes, { signer: signers.rsa2, subFilter: SUBFILTER_PKCS7, signingTime: new Date("2026-11-16T02:00:00Z"), reason: "Người ký thứ hai", appearance: { pageIndex: 0, rect: RECTS[0], png: STAMP } });
    assert.ok(sameBytes(second.bytes.subarray(0, first.bytes.length), first.bytes), "the first signed file is the prefix of the second");
    assert.equal(second.report.fieldName, "Signature2");
    const a = verifyIndependently(second.bytes, 0);
    const b = verifyIndependently(second.bytes, 1);
    assert.deepEqual([a.digestOk, a.signatureOk, b.digestOk, b.signatureOk], [true, true, true, true]);
    assert.equal(a.byteRange[2] + a.byteRange[3], first.bytes.length, "the first signature covers exactly the first signed file");
    assert.equal(b.byteRange[2] + b.byteRange[3], second.bytes.length);
    // the second update rewrites the page and the AcroForm object, not the catalog
    assert.equal(second.report.rewrittenObjects.length, 2);
    assert.ok(!second.report.rewrittenObjects.includes(readLastXrefSection(input).root.tag));
    const result = await inspect(second.bytes);
    assert.equal(result.document.revisions, 3);
    const [one, two] = result.signatures;
    assert.deepEqual([one.fieldName, one.digestMatches, one.signatureValid, one.coverage.status, one.verdict], ["Signature1", true, true, "revision", "valid"]);
    assert.deepEqual([two.fieldName, two.digestMatches, two.signatureValid, two.coverage.status, two.verdict], ["Signature2", true, true, "whole-file", "valid"]);
    assert.deepEqual([one.coverage.revision, one.coverage.laterRevisions, one.coverage.bytesAfter], [2, 1, second.bytes.length - first.bytes.length]);
    assert.equal(one.changesAfterSigning.classification, "signatures-only");
    assert.deepEqual(one.changesAfterSigning.laterSignatures, [{ index: 2, fieldName: "Signature2", kind: "signature" }]);
    assert.ok(one.changesAfterSigning.items.every((item) => item.allowed));
    assert.ok(one.changesAfterSigning.items.some((item) => item.code === "SIGN_CHANGE_SIGNATURE_WIDGET_ADDED" && item.params.page === 1));
    assert.ok(one.changesAfterSigning.items.some((item) => item.code === "SIGN_CHANGE_SIGNATURE_FIELD_ADDED"));
    assert.deepEqual(one.problems.map((entry) => [entry.code, entry.severity]), [["SIGN_LATER_REVISIONS", "info"]]);
    assert.deepEqual([one.reason, two.reason, two.signerName], ["Người ký thứ nhất", "Người ký thứ hai", "Trần Thị Bình"]);
    assert.deepEqual(two.chain.map((certificate) => certificate.commonName), ["Trần Thị Bình", "ANS Test Root CA"]);
    // "view signed version": the document as the first signer saw it
    const asSigned = signedRevisionBytes(second.bytes, one);
    assert.ok(sameBytes(asSigned, first.bytes));
    const earlier = await inspect(asSigned);
    assert.deepEqual([earlier.signatures.length, earlier.signatures[0].coverage.status, earlier.signatures[0].verdict], [1, "whole-file", "valid"]);
    assert.equal((await inspectPdf(second.bytes)).signatureCount, 2);
    assert.deepEqual(await extractText(second.bytes), await extractText(input));
  }
});

test("sign: certification (DocMDP): /Reference and catalog /Perms; later signatures; what is refused", async () => {
  const { bytes: certified, report } = await signPdf(inputs.stream, { signer: signers.rsa, signingTime: SIGNED_AT, certify: 2 });
  const appended = latin1(certified.subarray(inputs.stream.length));
  assert.match(appended, /\/Reference \[ << \/Type \/SigRef \/TransformMethod \/DocMDP \/TransformParams << \/Type \/TransformParams \/P 2 \/V \/1\.2 >> >> \]/);
  assert.match(appended, /\/Perms <<\s*\/DocMDP \d+ 0 R\s*>>/);
  assert.equal(report.certified, 2);
  assert.equal(verifyIndependently(certified).signatureOk, true);
  const facts = await inspectPdf(certified);
  assert.deepEqual([facts.signable, facts.certified, facts.canCertify, facts.warnings], [true, 2, false, ["SIGN_CERTIFIED"]]);
  assert.deepEqual(facts.findings, [{ code: "SIGN_CERTIFIED", params: { level: 2 }, blocking: false }]);
  const first = (await inspect(certified)).signatures[0];
  assert.deepEqual([first.isCertification, first.docMdp, first.verdict], [true, { level: 2, inCatalog: true }, "valid"]);
  assert.deepEqual((await inspect(certified)).document.certification, { fieldName: "Signature1", level: 2 });
  // an invisible signature on top is fine; a NEW visible field comes with a warning (strict validators object)
  const invisible = await signPdf(certified, { signer: signers.rsa2, signingTime: SIGNED_AT });
  assert.deepEqual(invisible.report.warnings, []);
  assert.deepEqual((await inspect(invisible.bytes)).signatures.map((signature) => signature.verdict), ["valid", "valid"]);
  const visible = await signPdf(certified, { signer: signers.rsa2, signingTime: SIGNED_AT, appearance: { pageIndex: 0, rect: RECTS[0], png: STAMP } });
  assert.deepEqual(visible.report.warnings, [{ code: "SIGN_CERTIFIED_VISIBLE", params: {} }]);
  // a certification must be the first signature; level 1 allows nothing afterwards
  await rejectsWithCode(signPdf(certified, { signer: signers.rsa2, certify: 1 }), "SIGN_CERTIFY_NOT_FIRST");
  const locked = (await signPdf(inputs.classic, { signer: signers.rsa, signingTime: SIGNED_AT, certify: 1 })).bytes;
  await rejectsWithCode(signPdf(locked, { signer: signers.rsa2 }), "SIGN_CERTIFIED_NO_CHANGES");
  const lockedFacts = await inspectPdf(locked);
  assert.deepEqual([lockedFacts.signable, lockedFacts.blockers, lockedFacts.certified, lockedFacts.warnings], [false, ["SIGN_CERTIFIED_NO_CHANGES"], 1, []]);
  assert.equal((await signPdf(inputs.classic, { signer: signers.rsa, certify: 3 })).report.certified, 3);
  assert.equal((await signPdf(inputs.classic, { signer: signers.rsa, certify: 0 })).report.certified, 0);
});

test("sign: negative controls (a flipped byte in the signed range, a flipped signature digit, appended content)", async () => {
  const input = inputs.classic;
  const { bytes: signed, report } = await signPdf(input, { signer: signers.rsa, subFilter: SUBFILTER_PKCS7, signingTime: SIGNED_AT, reason: REASON });
  const [, b, c] = report.byteRange;
  // one byte changed BEFORE the signature value (in the original part) and one AFTER it
  for (const offset of [input.length - 30, 40, c + 20, signed.length - 12]) {
    const tampered = Uint8Array.from(signed);
    tampered[offset] ^= 0x01;
    const independent = verifyIndependently(tampered);
    assert.deepEqual([independent.digestOk, independent.signatureOk], [false, true], `byte ${offset}: the digest no longer matches, the signature value still verifies`);
    const result = await inspect(tampered);
    assert.equal(result.signatures.length, 1);
    const signature = result.signatures[0];
    assert.deepEqual([signature.digestMatches, signature.signatureValid, signature.verdict], [false, true, "invalid"], `byte ${offset}`);
    assert.ok(signature.problems.some((entry) => entry.code === "SIGN_DOCUMENT_MODIFIED" && entry.severity === "error"));
  }
  // one hex digit of the signature VALUE changed: the document digest still matches, the signature does not verify
  const signatureHex = verifyIndependently(signed).signature.toString("hex");
  const at = latin1(signed).indexOf(signatureHex.slice(0, 40));
  assert.ok(at > b && at < c);
  const forged = Uint8Array.from(signed);
  forged[at + 10] = forged[at + 10] === 0x30 ? 0x31 : 0x30;
  assert.deepEqual([verifyIndependently(forged).digestOk, verifyIndependently(forged).signatureOk], [true, false]);
  const bad = (await inspect(forged)).signatures[0];
  assert.deepEqual([bad.digestMatches, bad.signatureValid, bad.verdict], [true, false, "invalid"]);
  assert.ok(bad.problems.some((entry) => entry.code === "SIGN_SIGNATURE_INVALID"));
  // bytes appended after the signature that are not a revision: nothing of the document changed
  const trailing = new Uint8Array([...signed, ...fromLatin1("\n% a trailing comment\n")]);
  const afterJunk = (await inspect(trailing)).signatures[0];
  assert.deepEqual([afterJunk.digestMatches, afterJunk.signatureValid, afterJunk.coverage.status, afterJunk.coverage.laterRevisions, afterJunk.changesAfterSigning.unchanged, afterJunk.verdict], [true, true, "revision", 0, true, "valid"]);
  assert.deepEqual(afterJunk.problems.map((entry) => entry.code), ["SIGN_LATER_REVISIONS"]);
  assert.notEqual(verifyIndependently(trailing).byteRange[2] + verifyIndependently(trailing).byteRange[3], trailing.length);
});

test("sign: refusals, each with its code (encrypted input, damaged last cross-reference section, wrong options)", async () => {
  const classic = inputs.classic;
  const signer = signers.rsa;
  // encrypted input: the new objects would have to be encrypted with the file key
  const doc = await pdfLib.PDFDocument.load(classic);
  doc.encrypt({ userPassword: "userpw", ownerPassword: "ownerpw" });
  const encrypted = await doc.save({ useObjectStreams: false });
  await rejectsWithCode(signPdf(encrypted, { signer }), "SIGN_ENCRYPTED");
  const encryptedFacts = await inspectPdf(encrypted);
  assert.deepEqual([encryptedFacts.signable, encryptedFacts.blockers, encryptedFacts.encrypted], [false, ["SIGN_ENCRYPTED"], true]);
  // damaged last cross-reference section: an update appended to a guess is not safe
  const text = latin1(classic);
  const at = text.lastIndexOf("startxref");
  const damaged = {
    "no-startxref": classic.subarray(0, at),
    "bad-startxref": fromLatin1(`${text.slice(0, at)}startxref\n17\n%%EOF\n`),
    "bad-xref": fromLatin1(text.replace("trailer", "tralier"))
  };
  for (const [reason, bytes] of Object.entries(damaged)) {
    assert.deepEqual((await rejectsWithCode(signPdf(bytes, { signer }), "SIGN_DAMAGED_XREF")).params, { reason });
    const facts = await inspectPdf(bytes);
    assert.deepEqual([facts.signable, facts.blockers], [false, ["SIGN_DAMAGED_XREF"]]);
    assert.deepEqual(facts.findings, [{ code: "SIGN_DAMAGED_XREF", params: { reason }, blocking: true }]);
  }
  const noCatalog = fromLatin1(text.replace("/Type /Catalog", "/Type /Katalog").replace("/Pages ", "/Sages "));
  assert.deepEqual((await rejectsWithCode(signPdf(noCatalog, { signer }), "SIGN_DAMAGED_XREF")).params, { reason: "bad-catalog" });
  await rejectsWithCode(signPdf(new TextEncoder().encode("not a pdf"), { signer }), "SIGN_NOT_A_PDF");
  assert.deepEqual((await inspectPdf(new TextEncoder().encode("not a pdf"))).blockers, ["SIGN_NOT_A_PDF"]);
  assert.deepEqual((await rejectsWithCode(signPdf(new Uint8Array([...fromLatin1("junk\n"), ...classic]), { signer }), "SIGN_LEADING_BYTES")).params, { count: 5 });
  const empty = await (await pdfLib.PDFDocument.create()).save({ addDefaultPage: false, useObjectStreams: false });
  await rejectsWithCode(signPdf(empty, { signer }), "SIGN_NO_PAGES");
  assert.deepEqual((await inspectPdf(empty)).blockers, ["SIGN_NO_PAGES"]);
  // options
  const option = async (options) => (await rejectsWithCode(signPdf(classic, { signer, ...options }), "SIGN_BAD_OPTIONS")).params.option;
  assert.equal(await option({ certify: 5 }), "certify");
  assert.equal(await option({ signingTime: new Date(NaN) }), "signingTime");
  assert.equal(await option({ signingTime: "2026-11-16" }), "signingTime");
  assert.equal(await option({ reason: 42 }), "reason");
  assert.equal(await option({ appearance: "stamp.png" }), "appearance");
  assert.equal(await option({ image: STAMP }), "image");
  assert.equal(await option({ timeZoneOffsetMinutes: 99999 }), "timeZoneOffsetMinutes");
  assert.deepEqual((await rejectsWithCode(signPdf("a string", { signer }), "SIGN_BAD_OPTIONS")).params, { option: "bytes" });
  assert.deepEqual((await rejectsWithCode(inspectPdf(null), "SIGN_BAD_OPTIONS")).params, { option: "bytes" });
  assert.deepEqual((await rejectsWithCode(signPdf(classic, { signer, subFilter: "adbe.x509.rsa_sha1" }), "SIGN_BAD_SUBFILTER")).params, { subFilter: "adbe.x509.rsa_sha1" });
  assert.deepEqual((await rejectsWithCode(signPdf(classic, { signer, pageIndex: 99 }), "SIGN_BAD_PAGE")).params, { pageIndex: 99, pageCount: 2 });
  await rejectsWithCode(signPdf(classic, { signer, appearance: { pageIndex: 2, rect: RECTS[0], png: STAMP } }), "SIGN_BAD_PAGE");
  await rejectsWithCode(signPdf(classic, { signer, appearance: { pageIndex: 0, rect: [1, 2, 3], png: STAMP } }), "SIGN_BAD_RECT");
  await rejectsWithCode(signPdf(classic, { signer, appearance: { pageIndex: 0, rect: [10, 10, 10, 60], png: STAMP } }), "SIGN_BAD_RECT");
  const image = async (png) => (await rejectsWithCode(signPdf(classic, { signer, appearance: { pageIndex: 0, rect: RECTS[0], png } }), "SIGN_BAD_IMAGE")).params.reason;
  assert.equal(await image(undefined), "missing");
  assert.equal(await image(new Uint8Array(64).fill(7)), "format");
  assert.equal(await image(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])), "decode");
  await rejectsWithCode(signPdf(classic, { signer, fieldName: "a.b" }), "SIGN_BAD_FIELD_NAME");
  await rejectsWithCode(signPdf(classic, { signer, fieldName: "" }), "SIGN_BAD_FIELD_NAME");
  const named = await signPdf(classic, { signer, fieldName: "Chữ ký của An", signingTime: SIGNED_AT });
  assert.equal((await inspect(named.bytes)).signatures[0].fieldName, "Chữ ký của An");
  assert.deepEqual((await rejectsWithCode(signPdf(named.bytes, { signer, fieldName: "Chữ ký của An" }), "SIGN_FIELD_NAME_TAKEN")).params, { fieldName: "Chữ ký của An" });
});

test("sign: signers that are refused; private keys only as non-extractable CryptoKeys", async () => {
  const classic = inputs.classic;
  const reason = async (signer) => (await rejectsWithCode(signPdf(classic, { signer }), "SIGN_BAD_SIGNER")).params.reason;
  assert.equal(await reason(undefined), "certificate");
  assert.equal(await reason({ certificate: signers.rsa.certificate }), "private-key");
  assert.equal(await reason({ certificate: Uint8Array.of(1, 2, 3), privateKey: signers.rsa.privateKey }), "certificate");
  assert.equal(await reason({ certificate: signers.rsa.certificate, sign: async () => new Uint8Array(256) }), "private-key");
  const extractable = await globalThis.crypto.subtle.importKey("pkcs8", KEYS.signer1, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
  assert.equal(await reason({ certificate: CERTS.signer1, privateKey: extractable }), "extractable-key");
  assert.equal(await reason({ certificate: CERTS.signer1, privateKey: signers.ec.privateKey }), "key-algorithm");
  await rejectsWithCode(signPdf(classic, { signer: { certificate: signers.rsa.certificate, privateKey: signers.rsa2.privateKey } }), "SIGN_KEY_MISMATCH");
  assert.deepEqual((await rejectsWithCode(signPdf(classic, { signer: { certificate: CERTS.rsa1024, privateKey: signers.rsa.privateKey } }), "SIGN_WEAK_KEY")).params, { bits: 1024 });
  assert.deepEqual((await rejectsWithCode(signPdf(classic, { signer: { certificate: CERTS.ed25519, privateKey: signers.rsa.privateKey } }), "SIGN_UNSUPPORTED_KEY")).params, { keyType: "Ed25519", curve: null });
  // a key imported by hand is fine as long as it is non-extractable
  const byHand = { certificate: CERTS.ecSigner, chain: [CERTS.intermediateCa], privateKey: await importTestKey(KEYS.ecSigner, "ec") };
  assert.equal(verifyIndependently((await signPdf(classic, { signer: byHand })).bytes).certificates.length, 2);
  // cancellation
  const controller = new AbortController();
  controller.abort();
  await rejectsWithCode(signPdf(classic, { signer: signers.rsa, signal: controller.signal }), CANCELLED);
});

test("sign: without crypto.subtle (plain http) everything says SIGN_NO_WEBCRYPTO", async () => {
  await withoutWebCrypto(async () => {
    assert.deepEqual(signingSupport(), { secureContext: null, subtle: false });
    await rejectsWithCode(signPdf(inputs.classic, { signer: signers.rsa }), "SIGN_NO_WEBCRYPTO");
    await rejectsWithCode(inspectSignatures(inputs.classic), "SIGN_NO_WEBCRYPTO");
    await rejectsWithCode(loadPkcs12(P12.aes256.bytes, PASSWORD), "SIGN_NO_WEBCRYPTO");
    await rejectsWithCode(createSelfSigned({ commonName: "x" }), "SIGN_NO_WEBCRYPTO");
    const facts = await inspectPdf(inputs.classic);
    assert.deepEqual([facts.signable, facts.blockers], [false, ["SIGN_NO_WEBCRYPTO"]]);
  });
  assert.equal(signingSupport().subtle, true);
  // a browser on a plain-http origin reports isSecureContext false
  globalThis.isSecureContext = false;
  try {
    assert.equal(signingSupport().secureContext, false);
  } finally {
    delete globalThis.isSecureContext;
  }
});

test("sign / inspect: a failure of the platform becomes a coded error or a coded finding, never a raw exception", async () => {
  const signed = (await signPdf(inputs.classic, { signer: signers.rsa, signingTime: SIGNED_AT })).bytes;
  const secret = "a platform message that could describe anything";
  // crypto.subtle.digest fails in a way nothing expects
  let error = await rejectsWithCode(withFailingDigest(new TypeError(secret), () => signPdf(inputs.classic, { signer: signers.rsa })), "SIGN_INTERNAL");
  assert.deepEqual([error.params, error.message.includes(secret), error.cause instanceof TypeError], [{ check: "unexpected" }, false, true]);
  // the platform cannot allocate what the file needs
  error = await rejectsWithCode(withFailingDigest(new RangeError("Array buffer allocation failed"), () => signPdf(inputs.classic, { signer: signers.rsa })), "SIGN_TOO_LARGE");
  assert.deepEqual(error.params, {});
  await rejectsWithCode(withFailingDigest(new TypeError(secret), () => loadPkcs12(P12.aes256.bytes, PASSWORD)), "CERT_CORRUPT");
  // the inspection goes on: the signature that could not be examined says so and is never called valid
  const report = await withFailingDigest(new TypeError(secret), () => inspect(signed));
  assert.deepEqual(report.signatures.map((signature) => [signature.verdict, signature.problems, signature.trust.reason]), [
    ["unknown", [{ code: "SIGN_INSPECTION_FAILED", severity: "warning", params: {} }], "not-evaluated"]
  ]);
  assert.equal((await inspect(signed)).signatures[0].verdict, "valid", "the platform is whole again after the test");
  // mistakes of the caller are named, also for the inspection (a misspelt option must not switch trust off)
  for (const [options, option] of [[{ trustedCertificate: [CERTS.rootCa] }, "trustedCertificate"], [{ trustedCertificates: CERTS.rootCa }, "trustedCertificates"], [{ now: "2026-11-16" }, "now"], [{ now: new Date(NaN) }, "now"], [{ password: 42 }, "password"], ["fast", "options"]]) {
    assert.deepEqual((await rejectsWithCode(inspectSignatures(signed, options), "SIGN_BAD_OPTIONS")).params, { option });
  }
  assert.equal((await inspectSignatures(signed, null)).signatures.length, 1);
  // the inspection can be cancelled (the signal is looked at between its stages)
  const controller = new AbortController();
  controller.abort();
  await rejectsWithCode(inspectSignatures(signed, { signal: controller.signal }), CANCELLED);
});

test("sign: forms (existing empty signature field, /NeedAppearances, XFA, locked and odd fields)", async () => {
  const form = await makeFormPdf({
    needAppearances: true,
    xfa: true,
    fields: [
      { name: "Approval", rect: [300, 500, 450, 550] },
      { name: "Hidden", rect: [0, 0, 0, 0] },
      { name: "Floating", onPage: false },
      { name: "Locked", rect: [300, 400, 450, 450], lock: true },
      { name: "Direct", directWidget: true },
      { name: "FullName", type: "Tx", value: "Nguyen Van An" }
    ]
  });
  const facts = await inspectPdf(form);
  assert.deepEqual([facts.signable, facts.blockers, facts.needAppearances, facts.xfa, facts.signatureCount], [true, [], true, true, 0]);
  assert.deepEqual(facts.warnings, ["SIGN_NEED_APPEARANCES", "SIGN_XFA"]);
  assert.deepEqual(facts.emptySignatureFields, [
    { name: "Approval", pageIndex: 0, rect: [300, 500, 450, 550] },
    { name: "Hidden", pageIndex: 0, rect: [0, 0, 0, 0] },
    { name: "Floating", pageIndex: null, rect: [50, 600, 250, 660] },
    { name: "Locked", pageIndex: 0, rect: [300, 400, 450, 450] },
    { name: "Direct", pageIndex: 0, rect: [50, 600, 250, 660] }
  ]);
  assert.deepEqual(facts.fieldNames, ["Approval", "Hidden", "Floating", "Locked", "Direct", "FullName"]);
  const options = { signer: signers.rsa, signingTime: SIGNED_AT, appearance: { pageIndex: 0, rect: [10, 10, 60, 30], png: STAMP } };
  const codes = (report) => report.warnings.map((entry) => entry.code);
  // signing the EXISTING field: its own rectangle is used; the field object (which is its own widget) and the
  // AcroForm object (for /SigFlags 3) are rewritten, neither the page nor the catalog
  const approval = await signPdf(form, { ...options, fieldName: "Approval" });
  assert.deepEqual([approval.report.usedExistingField, approval.report.fieldName, approval.report.rect, approval.report.visible], [true, "Approval", [300, 500, 450, 550], true]);
  assert.equal(approval.report.rewrittenObjects.length, 2);
  assert.ok(!approval.report.rewrittenObjects.includes(readLastXrefSection(form).root.tag));
  assert.equal(approval.report.newObjectNumbers.length, 3, "signature dictionary, picture, appearance");
  assert.deepEqual(codes(approval.report), ["SIGN_XFA", "SIGN_NEED_APPEARANCES"]);
  assert.deepEqual([verifyIndependently(approval.bytes).digestOk, verifyIndependently(approval.bytes).signatureOk], [true, true]);
  const inspected = await inspect(approval.bytes);
  assert.deepEqual([inspected.signatures[0].fieldName, inspected.signatures[0].verdict, inspected.signatures[0].visible], ["Approval", "valid", true]);
  assert.deepEqual(inspected.unsignedFields.map((field) => field.name), ["Hidden", "Floating", "Locked", "Direct"]);
  assert.deepEqual((await inspectPdf(approval.bytes)).emptySignatureFields.map((field) => field.name), ["Hidden", "Floating", "Locked", "Direct"]);
  // fields that cannot show a stamp, a lock that is not honoured, a widget that is not an object of its own
  const hidden = await signPdf(form, { ...options, fieldName: "Hidden" });
  assert.deepEqual([hidden.report.visible, codes(hidden.report)], [false, ["SIGN_FIELD_NOT_VISIBLE", "SIGN_XFA"]]);
  const floating = await signPdf(form, { ...options, fieldName: "Floating" });
  assert.deepEqual([floating.report.visible, codes(floating.report)], [false, ["SIGN_FIELD_NOT_ON_A_PAGE", "SIGN_XFA"]]);
  const locked = await signPdf(form, { ...options, fieldName: "Locked" });
  assert.deepEqual(locked.report.warnings.find((entry) => entry.code === "SIGN_FIELD_LOCK"), { code: "SIGN_FIELD_LOCK", params: { fieldName: "Locked" } });
  assert.deepEqual((await rejectsWithCode(signPdf(form, { ...options, fieldName: "Direct" }), "SIGN_UNSUPPORTED_FIELD")).params, { fieldName: "Direct" });
  await rejectsWithCode(signPdf(form, { ...options, fieldName: "FullName" }), "SIGN_FIELD_NAME_TAKEN");
  // a NEW field next to the form: /NeedAppearances stays (other fields depend on it); an invisible one is quiet
  const fresh = await signPdf(form, options);
  assert.deepEqual([fresh.report.fieldName, fresh.report.usedExistingField, codes(fresh.report)], ["Signature1", false, ["SIGN_XFA", "SIGN_NEED_APPEARANCES"]]);
  assert.deepEqual(codes((await signPdf(form, { signer: signers.rsa, signingTime: SIGNED_AT })).report), ["SIGN_XFA"]);
  // a form WITHOUT fields: the flag is removed with the update, so the stamp shows
  const bare = await makeFormPdf({ needAppearances: true });
  const cleared = await signPdf(bare, options);
  assert.deepEqual(codes(cleared.report), []);
  assert.equal((await inspectPdf(cleared.bytes)).needAppearances, false);
});

test("sign: hybrid cross-reference files and damaged OLDER sections are signed with a warning", async () => {
  const classic = inputs.classic;
  const text = latin1(classic);
  const raw = readLastXrefSection(classic);
  const section = (extra) => fromLatin1(`${text}\nxref\n0 0\ntrailer\n<< /Size ${raw.size} /Root ${raw.root} ${extra} >>\nstartxref\n${text.length + 1}\n%%EOF\n`);
  const hybrid = section(`/Prev ${raw.offset} /XRefStm ${raw.offset}`);
  assert.deepEqual([(await inspectPdf(hybrid)).hybrid, (await inspectPdf(hybrid)).warnings], [true, ["SIGN_HYBRID_XREF"]]);
  const signedHybrid = await signPdf(hybrid, { signer: signers.rsa, signingTime: SIGNED_AT });
  assert.deepEqual(signedHybrid.report.warnings, [{ code: "SIGN_HYBRID_XREF", params: {} }]);
  assert.ok(!latin1(signedHybrid.bytes.subarray(hybrid.length)).includes("/XRefStm"), "/XRefStm is never copied into the new trailer");
  assert.deepEqual([verifyIndependently(signedHybrid.bytes).digestOk, verifyIndependently(signedHybrid.bytes).signatureOk], [true, true]);
  const broken = section("/Prev 12");
  assert.deepEqual((await inspectPdf(broken)).findings, [{ code: "SIGN_XREF_CHAIN_DAMAGED", params: { problems: ["unreadable-section"] }, blocking: false }]);
  const signedBroken = await signPdf(broken, { signer: signers.rsa, signingTime: SIGNED_AT });
  assert.deepEqual(signedBroken.report.warnings.map((entry) => entry.code), ["SIGN_XREF_CHAIN_DAMAGED"]);
  assert.equal((await inspect(signedBroken.bytes)).signatures[0].verdict, "valid");
});

test("sign: certificate warnings travel in the report (expired, not yet valid)", async () => {
  const expired = await createSelfSigned({ commonName: "Chứng thư đã hết hạn", keyType: "P-256", years: 1, now: new Date("2020-01-01T00:00:00Z") });
  const late = await signPdf(inputs.classic, { signer: expired, signingTime: SIGNED_AT });
  assert.deepEqual(late.report.warnings, [{ code: "CERT_EXPIRED", params: { notAfter: "2020-12-31T23:55:00.000Z" } }]);
  assert.equal(verifyIndependently(late.bytes).signatureOk, true);
  const future = await createSelfSigned({ commonName: "Chưa có hiệu lực", keyType: "P-256", now: new Date("2030-01-01T00:00:00Z") });
  assert.deepEqual((await signPdf(inputs.classic, { signer: future, signingTime: SIGNED_AT })).report.warnings.map((entry) => entry.code), ["CERT_NOT_YET_VALID"]);
});

test("sign: deterministic with RSA when the time and the document id are fixed; the two-phase form", async () => {
  const signer = { certificate: signers.rsa.certificate, chain: signers.rsa.chain, privateKey: signers.rsa.privateKey };
  const options = { signer, signingTime: SIGNED_AT, timeZoneOffsetMinutes: 420, newDocumentId: new Uint8Array(16).fill(1), reason: "x" };
  const one = await signPdfDetailed(inputs.classic, options);
  const two = await signPdfDetailed(inputs.classic, options);
  assert.ok(sameBytes(one.bytes, two.bytes));
  assert.ok(latin1(one.bytes).includes("/M (D:20261116080000+07'00')"));
  assert.equal(one.cmsBytes, one.cmsEstimate, "the RSA size estimate is exact");
  assert.equal(one.contentsBytes, one.cmsEstimate + 512);
  // phase 1 alone leaves a placeholder; a container that does not fit is refused
  const prepared = await prepareSignature(inputs.classic, { contentsBytes: 300 });
  assert.equal(prepared.bytes.subarray(prepared.contentsStart + 1, prepared.contentsEnd - 1).every((value) => value === 0x30), true);
  assert.deepEqual((() => {
    try {
      embedSignature(prepared, new Uint8Array(301));
    } catch (error) {
      return [error.code, error.params];
    }
    return null;
  })(), ["SIGN_PLACEHOLDER_TOO_SMALL", { needed: 301, available: 300 }]);
  await rejectsWithCode(prepareSignature(inputs.classic, { contentsBytes: 10 }), "SIGN_BAD_OPTIONS");
});

test("sign: a signature timestamp through an injected request function (never used by default)", async () => {
  const classic = inputs.classic;
  const authority = { certificate: CERTS.signer2, privateKeyPkcs8: KEYS.signer1 };
  const honest = { certificate: CERTS.signer1, privateKeyPkcs8: KEYS.signer1 };
  // the size of the token is announced: one request
  const tsa = fakeTsa(honest);
  const stamped = await signPdf(classic, { signer: signers.ec, signingTime: SIGNED_AT, timestamp: { request: tsa.request, tokenBytes: 1600 } });
  assert.equal(tsa.calls.length, 1);
  const independent = verifyIndependently(stamped.bytes);
  assert.deepEqual([independent.digestOk, independent.signatureOk, independent.unsignedAttributes], [true, true, [OIDS.signatureTimeStampToken]]);
  const signature = (await inspect(stamped.bytes)).signatures[0];
  assert.deepEqual([signature.timestamp.present, signature.timestamp.kind, signature.timestamp.ok, signature.timestamp.imprintMatches, signature.timestamp.identityVerified], [true, "signature", true, true, false]);
  assert.deepEqual([signature.signingTime.source, signature.signingTime.proven, signature.signingTime.value], ["signature-timestamp", true, "2026-11-16T02:00:00.000Z"]);
  assert.deepEqual(signature.problems.map((entry) => [entry.code, entry.severity]), [["SIGN_TSA_CERTIFICATE_USAGE", "warning"], ["SIGN_TIME_MISMATCH", "info"]]);
  assert.equal(signature.verdict, "valid-with-warnings");
  // not announced: one probe request measures it; announced too small: the signature is redone once
  const measured = fakeTsa(honest);
  await signPdf(classic, { signer: signers.rsa, signingTime: SIGNED_AT, timestamp: { request: measured.request } });
  assert.equal(measured.calls.length, 2);
  const large = fakeTsa(honest, { padding: 3000 });
  const retried = await signPdf(classic, { signer: signers.rsa, signingTime: SIGNED_AT, timestamp: { request: large.request, tokenBytes: 100 } });
  assert.equal(large.calls.length, 2);
  assert.equal(verifyIndependently(retried.bytes).signatureOk, true);
  // what a bad authority gets
  const refused = async (options, code) => rejectsWithCode(signPdf(classic, { signer: signers.rsa, timestamp: { request: fakeTsa(honest, options).request, tokenBytes: 1600 } }), code);
  assert.deepEqual((await refused({ status: 2 }, "SIGN_TIMESTAMP_REJECTED")).params, { status: 2 });
  assert.deepEqual((await refused({ wrongImprint: true }, "SIGN_BAD_TIMESTAMP")).params, { reason: "imprint-mismatch" });
  assert.deepEqual((await refused({ dropNonce: true }, "SIGN_BAD_TIMESTAMP")).params, { reason: "nonce-mismatch" });
  assert.deepEqual((await rejectsWithCode(signPdf(classic, { signer: signers.rsa, timestamp: {} }), "SIGN_BAD_TIMESTAMP")).params, { reason: "no-request-function" });
  // the inspector on tokens that are not sound
  const problemsWith = async (who, options) => {
    const out = await signPdf(classic, { signer: signers.rsa, signingTime: SIGNED_AT, timestamp: { request: fakeTsa(who, options).request, tokenBytes: 1600 } });
    const found = (await inspect(out.bytes)).signatures[0];
    return [found.timestamp.ok, found.signingTime.source, found.problems.map((entry) => entry.code)];
  };
  assert.deepEqual(await problemsWith(authority), [false, "m-entry", ["SIGN_TSA_CERTIFICATE_USAGE", "SIGN_TIMESTAMP_SIGNATURE_INVALID"]]);
  assert.deepEqual(await problemsWith(honest, { omitCertificate: true }), [false, "m-entry", ["SIGN_TSA_CERTIFICATE_MISSING"]]);
  assert.deepEqual(await problemsWith(honest, { noSigner: true }), [false, "m-entry", ["SIGN_TIMESTAMP_NO_SIGNER"]]);
  assert.deepEqual(await problemsWith(honest, { time: new Date("2040-01-01T00:00:00Z") }), [true, "signature-timestamp", ["SIGN_TSA_CERTIFICATE_USAGE", "SIGN_TSA_CERTIFICATE_NOT_VALID_AT_TIME", "SIGN_TIME_MISMATCH", "CERT_EXPIRED_AT_SIGNING"]]);
});

test("sign: larger documents (40 pages, object streams) and pages of other sizes", async () => {
  const pages = Array.from({ length: 40 }, (value, index) => ({ lines: [`Trang ${index + 1}`, "Nội dung hợp đồng"], size: index % 2 ? [419.53, 595.28] : [595.28, 841.89], rotate: [0, 90, 180, 270][index % 4] }));
  const big = await makeTextPdf(pages, { useObjectStreams: true });
  const { bytes: out, report } = await signPdf(big, { signer: signers.ec, signingTime: SIGNED_AT, appearance: { pageIndex: 38, rect: [50, 60, 200, 110], png: STAMP } });
  assert.ok(sameBytes(out.subarray(0, big.length), big));
  assert.deepEqual([verifyIndependently(out).digestOk, verifyIndependently(out).signatureOk], [true, true]);
  assert.match(latin1(out.subarray(big.length)), /\/Matrix \[ -1 0 0 -1 150 50 \]/); // page 39 has /Rotate 180
  assert.match(latin1(out.subarray(big.length)), /\/MK <<\s*\/R 180\s*>>/);
  const signature = (await inspect(out)).signatures[0];
  assert.deepEqual([signature.pageIndex, signature.verdict], [38, "valid"]);
  assert.equal(report.pageIndex, 38);
  assert.deepEqual(await extractText(out), await extractText(big));
});
