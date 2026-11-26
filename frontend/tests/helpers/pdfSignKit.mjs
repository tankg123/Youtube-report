// Helpers of the engine/sign test suites (tests/pdfSign*.test.mjs).
//
// The heart of it is an INDEPENDENT look at a signed PDF: /ByteRange and /Contents are taken from the raw
// bytes with a regular expression, the CMS is read with the tiny DER walker below (it shares no code with
// src/pages/pdfEditor/engine/sign), the two byte ranges are hashed with node:crypto, and the signature over
// the DER of the signed attributes is verified with the public key of the embedded certificate through
// node:crypto. If the product's reader and writer were wrong in the same way, these checks would still fail.
//
// canonicalCms() re-encodes a container from its tree with a reader and writer of its own: what the signer
// writes must come out byte for byte (verifyIndependently asserts it for every signature it looks at).
//
// The second half builds test INPUTS: generated PDFs, unsigned revisions appended to a signed file, signatures
// with hand-made CMS containers (signed with node:crypto), certificates no honest tool issues (issueCertificate:
// any issuer name, signing key, hash and extension; renameSignatureAlgorithm), PKCS#12 containers that only ask
// for key derivation work (workHungryPkcs12) and a time-stamp authority in memory.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fontBytes, fontkit, makeTextPdf, pdfLib } from "./pdfTestKit.mjs";
import { der } from "../../src/pages/pdfEditor/engine/sign/asn1.js";
import { buildIncrementalUpdate } from "../../src/pages/pdfEditor/engine/sign/incremental.js";
import { readLastXrefSection } from "../../src/pages/pdfEditor/engine/sign/pdfRaw.js";
import { prepareSignature } from "../../src/pages/pdfEditor/engine/sign/pdfSign.js";
import { parseCertificate } from "../../src/pages/pdfEditor/engine/sign/x509.js";

export const latin1 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("latin1");
export const fromLatin1 = (text) => new Uint8Array(Buffer.from(text, "latin1"));
export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest();
export const hex = (bytes) => Buffer.from(bytes).toString("hex");
export const countOf = (bytes, needle) => latin1(bytes).split(needle).length - 1;
export const sameBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

export const OIDS = Object.freeze({
  signedData: "1.2.840.113549.1.7.2",
  data: "1.2.840.113549.1.7.1",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  sha1: "1.3.14.3.2.26",
  sha224: "2.16.840.1.101.3.4.2.4",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha1WithRsa: "1.2.840.113549.1.1.5",
  sha224WithRsa: "1.2.840.113549.1.1.14",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signatureTimeStampToken: "1.2.840.113549.1.9.16.2.14"
});

// ---------------------------------------------------------------------------------------------
// a DER walker of its own (definite lengths only: what the signer writes must be DER)
// ---------------------------------------------------------------------------------------------

export function derAt(buffer, offset = 0, limit = buffer.length) {
  assert.ok(offset + 2 <= limit, `DER: truncated element at ${offset}`);
  const tag = buffer[offset];
  assert.notEqual(tag & 0x1f, 0x1f, "DER: high tag numbers are not expected");
  let p = offset + 1;
  const first = buffer[p++];
  let length = first;
  if (first >= 0x80) {
    const count = first & 0x7f;
    assert.ok(count >= 1 && count <= 4, "DER: indefinite or oversized length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buffer[p++];
    assert.ok(length >= 0x80 && buffer[p - count] !== 0, "DER: length is not in its minimal form");
  }
  assert.ok(p + length <= limit, `DER: element at ${offset} runs past the end`);
  return { tag, start: offset, contentStart: p, contentEnd: p + length, end: p + length };
}

export function derChildren(buffer, node) {
  const out = [];
  let p = node.contentStart;
  while (p < node.contentEnd) {
    const child = derAt(buffer, p, node.contentEnd);
    out.push(child);
    p = child.end;
  }
  return out;
}

export const derRaw = (buffer, node) => buffer.subarray(node.start, node.end);
export const derContent = (buffer, node) => buffer.subarray(node.contentStart, node.contentEnd);

export function derOid(buffer, node) {
  assert.equal(node.tag, 0x06, "OBJECT IDENTIFIER expected");
  const content = derContent(buffer, node);
  const arcs = [];
  let value = 0n;
  for (const octet of content) {
    value = (value << 7n) | BigInt(octet & 0x7f);
    if (!(octet & 0x80)) {
      if (!arcs.length) {
        const first = value < 40n ? 0n : value < 80n ? 1n : 2n;
        arcs.push(first, value - first * 40n);
      } else arcs.push(value);
      value = 0n;
    }
  }
  return arcs.join(".");
}

/** Detached CMS SignedData as the signer must write it -> its parts (asserts the DER structure on the way). */
export function parseCms(cmsBytes) {
  const cms = Buffer.from(cmsBytes);
  const contentInfo = derAt(cms, 0);
  assert.equal(contentInfo.end, cms.length, "nothing follows the ContentInfo");
  const [typeNode, wrapper] = derChildren(cms, contentInfo);
  assert.equal(derOid(cms, typeNode), OIDS.signedData);
  assert.equal(wrapper.tag, 0xa0);
  const [signedData] = derChildren(cms, wrapper);
  const [version, digestAlgorithms, encap, certificates, signerInfos] = derChildren(cms, signedData);
  assert.equal(certificates.tag, 0xa0, "certificates [0]");
  assert.equal(signerInfos.tag, 0x31, "signerInfos SET");
  const infos = derChildren(cms, signerInfos);
  assert.equal(infos.length, 1, "exactly one SignerInfo");
  const parts = derChildren(cms, infos[0]);
  const [sidIssuer, sidSerial] = derChildren(cms, parts[1]);
  assert.equal(parts[3].tag, 0xa0, "signedAttrs [0]");
  const attributes = derChildren(cms, parts[3]).map((node) => {
    const [type, values] = derChildren(cms, node);
    return { oid: derOid(cms, type), raw: derRaw(cms, node), value: derChildren(cms, values)[0] };
  });
  const algorithm = derChildren(cms, parts[4]);
  return {
    cms,
    version: cms[version.contentStart],
    digestAlgorithm: derOid(cms, derChildren(cms, derChildren(cms, digestAlgorithms)[0])[0]),
    eContentType: derOid(cms, derChildren(cms, encap)[0]),
    encapChildren: derChildren(cms, encap).length,
    certificates: derChildren(cms, certificates).map((node) => Buffer.from(derRaw(cms, node))),
    signerInfoVersion: cms[parts[0].contentStart],
    sidIssuer: Buffer.from(derRaw(cms, sidIssuer)),
    sidSerialHex: hex(derContent(cms, sidSerial)),
    signerDigestAlgorithm: derOid(cms, derChildren(cms, parts[2])[0]),
    signedAttrsImplicit: Buffer.from(derRaw(cms, parts[3])),
    attributes,
    signatureAlgorithm: derOid(cms, algorithm[0]),
    signatureAlgorithmHasNullParameters: algorithm.length === 2 && algorithm[1].tag === 0x05,
    signatureAlgorithmParameterCount: algorithm.length - 1,
    signature: Buffer.from(derContent(cms, parts[5])),
    unsignedAttributes: parts[6] ? derChildren(cms, parts[6]).map((node) => derOid(cms, derChildren(cms, node)[0])) : []
  };
}

// ---------------------------------------------------------------------------------------------
// canonical DER, by re-encoding (shares nothing with the writer of the engine)
// ---------------------------------------------------------------------------------------------

/** A TOLERANT reader (indefinite and non-minimal lengths are read, not refused): -> { tag, content | children, end }. */
function berAt(buffer, offset) {
  const tag = buffer[offset];
  assert.notEqual(tag & 0x1f, 0x1f, "high tag numbers are not expected");
  let p = offset + 1;
  const first = buffer[p++];
  const readChildren = (until) => {
    const children = [];
    while (until === null ? !(buffer[p] === 0 && buffer[p + 1] === 0) : p < until) {
      assert.ok(p < buffer.length, "BER: a value runs past the end");
      const child = berAt(buffer, p);
      children.push(child);
      p = child.end;
    }
    return children;
  };
  if (first === 0x80) {
    const children = readChildren(null);
    return { tag, children, end: p + 2 };
  }
  let length = first;
  if (first > 0x80) {
    length = 0;
    for (let i = 0; i < (first & 0x7f); i++) length = length * 256 + buffer[p++];
  }
  const end = p + length;
  assert.ok(end <= buffer.length, "BER: a value runs past the end");
  if (tag & 0x20) return { tag, children: readChildren(end), end };
  return { tag, content: buffer.subarray(p, end), end };
}

function derTlv(tag, content) {
  const octets = [];
  for (let value = content.length; value > 0; value = Math.floor(value / 256)) octets.unshift(value % 256);
  const length = content.length < 0x80 ? [content.length] : [0x80 | octets.length, ...octets];
  return Buffer.concat([Buffer.from([tag, ...length]), content]);
}

/** One value written again as DER: minimal definite lengths, minimal INTEGERs, BOOLEAN FF / 00, SET OF sorted. */
function canonicalNode(node, isSetOf = false) {
  if (!node.children) {
    let content = Buffer.from(node.content);
    if (node.tag === 0x02) {
      while (content.length > 1 && ((content[0] === 0x00 && !(content[1] & 0x80)) || (content[0] === 0xff && content[1] & 0x80))) content = content.subarray(1);
    }
    if (node.tag === 0x01) content = Buffer.from([content[0] ? 0xff : 0x00]);
    return derTlv(node.tag, content);
  }
  // a string written in chunks (BER) is one primitive string in DER
  if (node.tag === 0x24) return derTlv(0x04, Buffer.concat(node.children.map((chunk) => Buffer.from(chunk.content))));
  const parts = node.children.map((child) => canonicalNode(child));
  if (isSetOf || node.tag === 0x31) parts.sort(Buffer.compare);
  return derTlv(node.tag, Buffer.concat(parts));
}

/**
 * The canonical DER encoding of a CMS SignedData container, RE-ENCODED from its tree: every length is written
 * again in its minimal definite form and every SET OF is sorted again (the universal SETs, and the IMPLICIT
 * [0] / [1] sets of RFC 5652: certificates and crls of SignedData, signed and unsigned attributes of a
 * SignerInfo). A container is canonical DER exactly when the result equals its own bytes; for any other
 * container (BER, unsorted sets, long-form lengths) the result is what it should have been.
 */
export function canonicalCms(cmsBytes) {
  const buffer = Buffer.from(cmsBytes);
  const root = berAt(buffer, 0);
  const [type, wrapper] = root.children;
  const signedData = wrapper.children[0];
  const fields = signedData.children.map((field, index) => {
    if (field.tag === 0xa0 || field.tag === 0xa1) return canonicalNode(field, true);
    if (field.tag === 0x31 && index === signedData.children.length - 1) {
      const signerInfos = field.children.map((info) => derTlv(0x30, Buffer.concat(info.children.map((part) => canonicalNode(part, part.tag === 0xa0 || part.tag === 0xa1)))));
      return derTlv(0x31, Buffer.concat(signerInfos.sort(Buffer.compare)));
    }
    return canonicalNode(field);
  });
  return new Uint8Array(derTlv(0x30, Buffer.concat([canonicalNode(type), derTlv(0xa0, derTlv(0x30, Buffer.concat(fields)))])));
}

// ---------------------------------------------------------------------------------------------
// a signed PDF, read from its bytes
// ---------------------------------------------------------------------------------------------

/** Every "/ByteRange [a b c d]" of the file with the /Contents value in its gap. */
export function readSignatures(pdf) {
  const text = latin1(pdf);
  return [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].map((match) => {
    const byteRange = match.slice(1).map(Number);
    const [a, b, c, d] = byteRange;
    const gap = text.slice(a + b, c);
    assert.match(gap, /^<[0-9a-fA-F]+>$/, "the gap of /ByteRange is exactly the /Contents hex string");
    const raw = Buffer.from(gap.slice(1, -1), "hex");
    const cmsLength = derAt(raw, 0).end;
    assert.ok(raw.subarray(cmsLength).every((value) => value === 0), "the padding after the CMS is zero");
    return {
      byteRange,
      capacity: raw.length,
      cms: raw.subarray(0, cmsLength),
      signed: Buffer.concat([Buffer.from(pdf.subarray(a, a + b)), Buffer.from(pdf.subarray(c, c + d))])
    };
  });
}

/**
 * Full cryptographic verification of one signature of a PDF with node:crypto.
 * -> { byteRange, capacity, digestOk, signatureOk, signerCertificate: X509Certificate, ...parseCms() }
 */
export function verifyIndependently(pdf, index = -1) {
  const signature = readSignatures(pdf).at(index);
  assert.ok(signature, "the file has a /ByteRange");
  // what the signer writes is canonical DER as a whole: an independent re-encoding gives the same bytes
  assert.equal(hex(canonicalCms(signature.cms)), hex(signature.cms), "the container is canonical DER");
  const parsed = parseCms(signature.cms);
  // the signer certificate = the one the SignerInfo names by serial number
  const certificates = parsed.certificates.map((certificate) => new crypto.X509Certificate(certificate));
  const signer = certificates.find((certificate) => BigInt(`0x${certificate.serialNumber}`) === BigInt(`0x${parsed.sidSerialHex}`));
  assert.ok(signer, "the certificate named by the SignerInfo is in the container");
  const signedAttributes = Buffer.from(parsed.signedAttrsImplicit);
  signedAttributes[0] = 0x31; // the signature is over the SET OF encoding, not over the [0] as stored
  const isEc = signer.publicKey.asymmetricKeyType === "ec";
  const signatureOk = crypto.verify("sha256", signedAttributes, isEc ? { key: signer.publicKey, dsaEncoding: "der" } : signer.publicKey, parsed.signature);
  const messageDigest = parsed.attributes.find((attribute) => attribute.oid === OIDS.messageDigest);
  assert.ok(messageDigest, "the signed attributes carry a message digest");
  const digestOk = Buffer.compare(Buffer.from(derContent(parsed.cms, messageDigest.value)), sha256(signature.signed)) === 0;
  return { ...parsed, byteRange: signature.byteRange, capacity: signature.capacity, signed: signature.signed, digestOk, signatureOk, signerCertificate: signer, isEc };
}

// ---------------------------------------------------------------------------------------------
// generated documents and pictures
// ---------------------------------------------------------------------------------------------

export const SAMPLE_LINES = ["Hợp đồng dịch vụ số 12/2026", "Bên A: Công ty TNHH Ánh Dương", "Amount: 1000 USD"];

/**
 * A generated PDF for the signing tests.
 * @param {{ objectStreams?: boolean, rotations?: number[] }} [options]  objectStreams: false = classic
 *        cross-reference table, true = object streams + a cross-reference stream; one page per rotation
 */
export function makeSignablePdf({ objectStreams = false, rotations = [0, 90] } = {}) {
  return makeTextPdf(rotations.map((rotate, index) => ({ lines: [...SAMPLE_LINES, `Page ${index + 1}`], rotate })), { title: "pdfSign test", useObjectStreams: objectStreams });
}

/**
 * A one-page PDF with an interactive form made of raw objects (no library form helper touches it):
 * @param {{ fields?: object[], needAppearances?: boolean, xfa?: boolean, objectStreams?: boolean }} options
 *        fields: [{ name, type?: "Sig" | "Tx", rect?, onPage?: boolean, lock?: boolean, directWidget?: boolean }]
 */
export async function makeFormPdf({ fields = [], needAppearances = false, xfa = false, objectStreams = false } = {}) {
  const { PDFDocument, PDFName, PDFString, PDFBool } = pdfLib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(fontBytes("arimo-regular"), { subset: true });
  page.drawText("Biểu mẫu", { x: 50, y: 780, size: 14, font });
  const context = doc.context;
  const fieldRefs = [];
  const annotRefs = [];
  for (const field of fields) {
    const widget = { Type: "Annot", Subtype: "Widget", F: 4, Rect: field.rect || [50, 600, 250, 660] };
    if (field.onPage !== false) widget.P = page.ref;
    let ref;
    if (field.directWidget) {
      // the field is one object and its widget a DIRECT dictionary in /Kids
      ref = context.register(context.obj({ FT: field.type || "Sig", T: PDFString.of(field.name), Kids: [context.obj(widget)] }));
    } else {
      const dict = context.obj({ ...widget, FT: field.type || "Sig", T: PDFString.of(field.name) });
      if (field.lock) dict.set(PDFName.of("Lock"), context.obj({ Type: "SigFieldLock", Action: "All" }));
      if (field.value) dict.set(PDFName.of("V"), PDFString.of(field.value));
      ref = context.register(dict);
      if (field.onPage !== false) annotRefs.push(ref);
    }
    fieldRefs.push(ref);
  }
  if (annotRefs.length) page.node.set(PDFName.of("Annots"), context.obj(annotRefs));
  const acroForm = context.obj({ Fields: fieldRefs });
  if (needAppearances) acroForm.set(PDFName.of("NeedAppearances"), PDFBool.True);
  if (xfa) acroForm.set(PDFName.of("XFA"), context.obj([PDFString.of("template"), context.register(context.stream("<template/>"))]));
  doc.catalog.set(PDFName.of("AcroForm"), context.register(acroForm));
  return doc.save({ useObjectStreams: objectStreams, updateFieldAppearances: false });
}

const QUADRANT_COLORS = Object.freeze({ topLeft: [220, 30, 30], topRight: [30, 170, 60], bottomLeft: [30, 60, 220], bottomRight: [240, 200, 20] });
export { QUADRANT_COLORS };

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
  return out;
}

/** A PNG of four coloured quadrants (red, green / blue, yellow), written without any image library. */
export function quadrantPng(width = 60, height = 20) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const key = `${y < height / 2 ? "top" : "bottom"}${x < width / 2 ? "Left" : "Right"}`;
      const [r, g, b] = QUADRANT_COLORS[key];
      raw.set([r, g, b, 255], row + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]));
}

/** PKCS#8 DER -> non-extractable WebCrypto signing key (RSASSA-PKCS1-v1_5 / SHA-256, or ECDSA P-256). */
export async function importTestKey(pkcs8, kind) {
  const algorithm = kind === "ec" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return globalThis.crypto.subtle.importKey("pkcs8", pkcs8, algorithm, false, ["sign"]);
}

// ---------------------------------------------------------------------------------------------
// revisions appended WITHOUT a signature (negative controls)
// ---------------------------------------------------------------------------------------------

const objectBody = (object) => {
  const body = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(body, 0);
  return body;
};

/**
 * Appends one UNSIGNED incremental revision to a PDF (classic tables and cross-reference streams).
 * `edit({ context, catalog, catalogRef, pages, name, ref, allocate })` changes library objects in place and
 * returns { rewrite: PDFRef[] (existing objects to write again), add: [{ ref, body: string | PDFObject }],
 * root?: PDFRef }. pages = [{ ref, dict }] in document order.
 */
export async function appendRevision(pdfBytes, edit) {
  const { PDFName, PDFRef, PDFDict, PDFArray } = pdfLib;
  const raw = readLastXrefSection(pdfBytes);
  const context = await pdfLib.PDFParser.forBytesWithOptions(pdfBytes, Infinity, false).parseDocument();
  const catalog = context.lookup(raw.root);
  const pages = [];
  const walk = (nodeRef, depth) => {
    const node = context.lookup(nodeRef);
    if (depth > 32 || !(node instanceof PDFDict)) return;
    const kids = context.lookup(node.get(PDFName.of("Kids")));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
    else pages.push({ ref: nodeRef, dict: node });
  };
  walk(catalog.get(PDFName.of("Pages")), 0);
  let largest = raw.size - 1;
  for (const [objectRef] of context.enumerateIndirectObjects()) largest = Math.max(largest, objectRef.objectNumber);
  const allocate = () => PDFRef.of(++largest, 0);
  const result = await edit({ context, catalog, catalogRef: raw.root, infoRef: raw.info, pages, name: (text) => PDFName.of(text), ref: (number, generation = 0) => PDFRef.of(number, generation), allocate });
  const objects = [];
  for (const objectRef of result.rewrite || []) {
    objects.push({ objectNumber: objectRef.objectNumber, generationNumber: objectRef.generationNumber, body: objectBody(context.lookup(objectRef)) });
  }
  for (const entry of result.add || []) {
    objects.push({ objectNumber: entry.ref.objectNumber, generationNumber: 0, body: typeof entry.body === "string" ? fromLatin1(entry.body) : objectBody(entry.body) });
  }
  return buildIncrementalUpdate({
    original: pdfBytes,
    objects,
    xrefType: raw.type,
    prevXrefOffset: raw.startxref.xrefOffset,
    size: largest + 1,
    root: result.root || raw.root,
    info: raw.info,
    id: raw.id
  }).bytes;
}

/** An unsigned revision that replaces the content of the first page ("the document was changed after signing"). */
export function appendContentRevision(pdfBytes, text = "APPENDED AFTER SIGNING") {
  return appendRevision(pdfBytes, ({ pages, name, allocate }) => {
    const stream = allocate();
    const content = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
    pages[0].dict.set(name("Contents"), stream);
    return { rewrite: [pages[0].ref], add: [{ ref: stream, body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream` }] };
  });
}

// ---------------------------------------------------------------------------------------------
// cross-reference data typed by hand (what an attacker appends, not what a writer produces)
// ---------------------------------------------------------------------------------------------

/**
 * Appends raw text to a PDF: `build(start, facts)` returns everything that follows the file as a latin1 string;
 * start = the offset of its first byte, facts = readLastXrefSection(pdf) (type, offset, size, root, info).
 */
export function appendRaw(pdfBytes, build) {
  const text = build(pdfBytes.length, readLastXrefSection(pdfBytes));
  return new Uint8Array(Buffer.concat([Buffer.from(pdfBytes), Buffer.from(text, "latin1")]));
}

/** One 20-byte entry of a classic cross-reference table; kind: "n" | "f". */
export const xrefEntry = (offset, generation, kind) => `${String(offset).padStart(10, "0")} ${String(generation).padStart(5, "0")} ${kind} \n`;

/**
 * A classic cross-reference section + trailer + startxref for the given entries.
 * entries: [[number, offset, generation, "n" | "f"]]; prev: null leaves /Prev out; root: another catalog
 * ("12 0 R"); extra: more trailer entries as text; startxref: false leaves the "startxref ... %%EOF" lines out.
 */
export function xrefTable(start, facts, entries, { prev = facts.offset, size = facts.size, root = null, extra = "", startxref = true } = {}) {
  const rows = [[0, 0, 65535, "f"], ...entries].sort((x, y) => x[0] - y[0]);
  const body = rows.map(([number, offset, generation, kind]) => `${number} 1\n${xrefEntry(offset, generation, kind)}`).join("");
  const info = facts.info ? ` /Info ${facts.info.objectNumber} ${facts.info.generationNumber} R` : "";
  const trailer = `<< /Size ${size} /Root ${root || `${facts.root.objectNumber} ${facts.root.generationNumber} R`}${info}${prev === null ? "" : ` /Prev ${prev}`}${extra} >>`;
  return `xref\n${body}trailer\n${trailer}\n${startxref ? `startxref\n${start}\n%%EOF\n` : ""}`;
}

/**
 * A cross-reference STREAM + startxref for the given rows; it lists itself as object `facts.size`.
 * rows: [[number, type, a, b]] (type 0 free, 1 in use: a = offset, b = generation, 2 compressed);
 * compress: true writes it as Acrobat does (/FlateDecode with the PNG "up" predictor); number: its own object
 * number when the revision defines other new objects before it.
 */
export function xrefStream(start, facts, rows, { compress = false, number = facts.size } = {}) {
  const all = [...rows, [number, 1, start, 0]].sort((x, y) => x[0] - y[0]);
  const plain = Buffer.concat(all.map(([, type, a, b]) => {
    const row = Buffer.alloc(7);
    row.writeUInt8(type, 0);
    row.writeUInt32BE(a, 1);
    row.writeUInt16BE(b, 5);
    return row;
  }));
  let data = plain;
  let filter = "";
  if (compress) {
    const predicted = Buffer.alloc(all.length * 8);
    for (let row = 0; row < all.length; row++) {
      predicted[row * 8] = 2; // PNG filter "up"
      for (let i = 0; i < 7; i++) predicted[row * 8 + 1 + i] = (plain[row * 7 + i] - (row ? plain[(row - 1) * 7 + i] : 0)) & 255;
    }
    data = zlib.deflateSync(predicted);
    filter = " /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >>";
  }
  const info = facts.info ? ` /Info ${facts.info.objectNumber} ${facts.info.generationNumber} R` : "";
  const dict = `<< /Type /XRef /Size ${number + 1} /Root ${facts.root.objectNumber} ${facts.root.generationNumber} R${info} /Prev ${facts.offset} /W [1 4 2] /Index [${all.map(([n]) => `${n} 1`).join(" ")}]${filter} /Length ${data.length} >>`;
  return `${number} 0 obj\n${dict}\nstream\n${data.toString("latin1")}\nendstream\nendobj\nstartxref\n${start}\n%%EOF\n`;
}

/** An object stream "number 0 obj" that holds the given objects: [[objectNumber, text of the object]]. */
export function objectStream(number, objects) {
  let header = "";
  let body = "";
  for (const [objectNumber, text] of objects) {
    header += `${objectNumber} ${body.length} `;
    body += `${text}\n`;
  }
  const data = header + body;
  return `${number} 0 obj\n<< /Type /ObjStm /N ${objects.length} /First ${header.length} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
}

// ---------------------------------------------------------------------------------------------
// signatures with a hand-made container (inputs for the inspector)
// ---------------------------------------------------------------------------------------------

const DIGEST_OIDS = { sha1: OIDS.sha1, sha224: OIDS.sha224, sha256: OIDS.sha256 };
const RSA_SIGNATURE_OIDS = { sha1: OIDS.sha1WithRsa, sha224: OIDS.sha224WithRsa, sha256: OIDS.sha256WithRsa };
const nodeKey = (pkcs8) => crypto.createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" });

/**
 * A CMS SignedData built by hand and signed with node:crypto (RSA PKCS#1 v1.5), in the shapes other products
 * write. `content` = the bytes the signature is about (the two byte ranges of the PDF).
 * options:
 *   certificate (DER, the signer), certificates (what goes into the container, default [certificate]),
 *   privateKeyPkcs8, hash: "sha256" | "sha1" | "sha224" (digest and signature hash), signatureHash (override),
 *   attributes: "default" (content-type + message-digest) | "none" (signature over the content itself) |
 *               (list) => list   a function that receives [{ oid, value }] and returns the list to sign
 *   embedContent: Uint8Array | true (put content into the container), signerCount: 0 | 1 | 2
 */
export function handMadeCms(content, { certificate, certificates, privateKeyPkcs8, hash = "sha256", signatureHash, attributes = "default", embedContent = null, signerCount = 1, messageDigest = null }) {
  const signer = parseCertificate(certificate);
  const key = nodeKey(privateKeyPkcs8);
  const digestAlgorithm = der.seq(der.oid(DIGEST_OIDS[hash]), der.nul());
  const eContent = embedContent === true ? content : embedContent;
  const signerInfo = () => {
    let attributeList = null;
    if (attributes !== "none") {
      attributeList = [
        { oid: OIDS.contentType, value: der.oid(OIDS.data) },
        { oid: OIDS.messageDigest, value: der.octets(messageDigest || crypto.createHash(hash).update(content).digest()) }
      ];
      if (typeof attributes === "function") attributeList = attributes(attributeList);
    }
    const usedHash = signatureHash || hash;
    let implicit = null;
    let toBeSigned = Buffer.from(content);
    if (attributeList) {
      const encoded = attributeList.map((entry) => Buffer.from(der.seq(der.oid(entry.oid), der.set(entry.value)))).sort(Buffer.compare);
      const set = Buffer.from(der.set(...encoded));
      toBeSigned = set;
      implicit = Buffer.from(set);
      implicit[0] = 0xa0;
    }
    return der.seq(
      der.int(1),
      der.seq(signer.issuer.der, signer.serialNumberTlv),
      digestAlgorithm,
      implicit,
      der.seq(der.oid(RSA_SIGNATURE_OIDS[usedHash]), der.nul()),
      der.octets(crypto.sign(usedHash, toBeSigned, key))
    );
  };
  const infos = Array.from({ length: signerCount }, signerInfo);
  const certificateList = certificates || [certificate];
  const signedData = der.seq(
    der.int(1),
    der.set(digestAlgorithm),
    der.seq(der.oid(OIDS.data), eContent ? der.ctx(0, der.octets(eContent)) : null),
    certificateList.length ? der.ctx(0, ...certificateList) : null,
    der.set(...infos)
  );
  return der.seq(der.oid(OIDS.signedData), der.ctx(0, signedData));
}

/** The same container with indefinite lengths on the outer ContentInfo and its [0] (BER, as BouncyCastle writes). */
export function toBer(cmsDer) {
  const cms = Buffer.from(cmsDer);
  const [type, wrapper] = derChildren(cms, derAt(cms, 0));
  return new Uint8Array(Buffer.concat([Buffer.from([0x30, 0x80]), derRaw(cms, type), Buffer.from([0xa0, 0x80]), derContent(cms, wrapper), Buffer.from([0, 0, 0, 0])]));
}

/**
 * A self-signed RSA certificate made by hand (node:crypto signs it), for signer certificates the test PKI does
 * not have: short keys, odd key usages, weak signature algorithms.
 * -> { certificate: Uint8Array (DER), privateKeyPkcs8: Uint8Array }
 */
export function makeTestCertificate({ commonName, modulusLength = 2048, hash = "sha256", keyUsage = [0xc0, 6], extendedKeyUsage = null, notBefore = new Date("2026-01-01T00:00:00Z"), notAfter = new Date("2031-01-01T00:00:00Z") }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength });
  const algorithm = der.seq(der.oid(RSA_SIGNATURE_OIDS[hash]), der.nul());
  const name = der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8(commonName))));
  const extension = (oid, critical, value) => der.seq(der.oid(oid), critical ? der.bool(true) : null, der.octets(value));
  const extensions = [extension("2.5.29.19", true, der.seq())];
  if (keyUsage) extensions.push(extension("2.5.29.15", true, der.bitString(Uint8Array.of(keyUsage[0]), keyUsage[1])));
  if (extendedKeyUsage) extensions.push(extension("2.5.29.37", false, der.seq(...extendedKeyUsage.map((oid) => der.oid(oid)))));
  const tbs = der.seq(
    der.ctx(0, der.int(2)),
    der.intFromBytes(crypto.randomBytes(8).fill(0x55, 0, 1)),
    algorithm,
    name,
    der.seq(der.time(notBefore), der.time(notAfter)),
    name,
    new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    der.ctx(3, der.seq(...extensions))
  );
  return {
    certificate: der.seq(tbs, algorithm, der.bitString(crypto.sign(hash, tbs, privateKey))),
    privateKeyPkcs8: new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }))
  };
}

const CERTIFICATE_SIGNATURE_OIDS = Object.freeze({
  rsa: {
    md5: "1.2.840.113549.1.1.4", sha1: OIDS.sha1WithRsa, sha224: OIDS.sha224WithRsa, sha256: OIDS.sha256WithRsa,
    sha384: "1.2.840.113549.1.1.12", sha512: "1.2.840.113549.1.1.13", "sha3-256": "2.16.840.1.101.3.4.3.14"
  },
  ec: { sha224: "1.2.840.10045.4.3.1", sha256: OIDS.ecdsaWithSha256, sha384: "1.2.840.10045.4.3.3" }
});
const KEY_PAIRS = Object.freeze({
  rsa: () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }),
  ec: () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
  secp256k1: () => crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" })
});

/**
 * A certificate made by hand and signed with node:crypto, for the chains no honest tool issues: any issuer name
 * and key identifier, any signing key, any signature hash (also the ones WebCrypto lacks), any extension.
 *   commonName   the subject (a name of one attribute)
 *   issuer       null = self-signed, or { name (DER), key (private KeyObject), keyIdentifier } = the `asIssuer`
 *                of another certificate made here. Mixing them forges a certificate: the name and key identifier
 *                of a real CA with the key of somebody else.
 *   key          "rsa" (2048 bits) | "ec" (P-256) | "secp256k1" | { privateKey, publicKey } to reuse a pair
 *   hash         digest of the certificate signature: "sha256" | "sha224" | "sha3-256" | "md5" | ...
 *   ca, pathLen  basicConstraints (critical); basicConstraints: false leaves the extension out
 *   keyUsage     [byte, unusedBits] | null; default digitalSignature + nonRepudiation, for a CA keyCertSign + cRLSign
 *   extensions   more extensions: [{ oid, critical, value (DER) }]
 *   version      3, or 1 for a certificate without extensions (old roots)
 * -> { certificate (DER), privateKey (KeyObject), privateKeyPkcs8, asIssuer: { name, key, keyIdentifier } }
 */
export function issueCertificate({
  commonName, issuer = null, key = "rsa", hash = "sha256", ca = false, pathLen = null, basicConstraints = true, keyUsage, extensions = [],
  notBefore = new Date("2026-01-01T00:00:00Z"), notAfter = new Date("2031-01-01T00:00:00Z"), version = 3
}) {
  const { privateKey, publicKey } = typeof key === "string" ? KEY_PAIRS[key]() : key;
  const spki = publicKey.export({ type: "spki", format: "der" });
  // subjectKeyIdentifier = SHA-1 of the subjectPublicKey bits (RFC 5280 4.2.1.2 method 1)
  const keyBits = derContent(spki, derChildren(spki, derAt(spki, 0))[1]).subarray(1);
  const keyIdentifier = new Uint8Array(crypto.createHash("sha1").update(keyBits).digest());
  const name = der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8(commonName))));
  const signedBy = issuer || { name, key: privateKey, keyIdentifier };
  const family = signedBy.key.asymmetricKeyType === "ec" ? "ec" : "rsa";
  const oid = CERTIFICATE_SIGNATURE_OIDS[family][hash];
  assert.ok(oid, `no signature algorithm for ${family} with ${hash}`);
  const algorithm = family === "ec" ? der.seq(der.oid(oid)) : der.seq(der.oid(oid), der.nul());
  const extension = (extensionOid, critical, value) => der.seq(der.oid(extensionOid), critical ? der.bool(true) : null, der.octets(value));
  const list = [];
  if (basicConstraints) list.push(extension("2.5.29.19", true, der.seq(ca ? der.bool(true) : null, ca && pathLen !== null ? der.int(pathLen) : null)));
  const usage = keyUsage === undefined ? (ca ? [0x06, 1] : [0xc0, 6]) : keyUsage;
  if (usage) list.push(extension("2.5.29.15", true, der.bitString(Uint8Array.of(usage[0]), usage[1])));
  list.push(extension("2.5.29.14", false, der.octets(keyIdentifier)));
  if (signedBy.keyIdentifier) list.push(extension("2.5.29.35", false, der.seq(der.ctxPrimitive(0, signedBy.keyIdentifier))));
  for (const entry of extensions) list.push(extension(entry.oid, entry.critical, entry.value));
  const tbs = der.seq(
    version === 1 ? null : der.ctx(0, der.int(version - 1)),
    der.intFromBytes(crypto.randomBytes(8).fill(0x55, 0, 1)),
    algorithm,
    signedBy.name,
    der.seq(der.time(notBefore), der.time(notAfter)),
    name,
    new Uint8Array(spki),
    version === 1 ? null : der.ctx(3, der.seq(...list))
  );
  const signature = crypto.sign(hash, tbs, family === "ec" ? { key: signedBy.key, dsaEncoding: "der" } : signedBy.key);
  return {
    certificate: der.seq(tbs, algorithm, der.bitString(signature)),
    privateKey,
    privateKeyPkcs8: new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" })),
    asIssuer: { name, key: privateKey, keyIdentifier }
  };
}

/**
 * The same certificate with its signature algorithm renamed IN PLACE: sha256WithRSAEncryption becomes
 * sha224WithRSAEncryption in both identifiers (inside and outside the signed part). The two object identifiers
 * have the same length, so no other byte moves. WebCrypto has no SHA-224: the signature of the result can no
 * longer be checked by the engine (and would not verify: the signed bytes changed).
 */
export function renameSignatureAlgorithm(certificate) {
  const out = Uint8Array.from(certificate);
  const from = Buffer.from(der.oid(OIDS.sha256WithRsa));
  const to = Buffer.from(der.oid(OIDS.sha224WithRsa));
  assert.equal(from.length, to.length);
  let count = 0;
  for (let at = Buffer.from(out).indexOf(from); at >= 0; at = Buffer.from(out).indexOf(from, at + 1)) {
    out.set(to, at);
    count++;
  }
  assert.equal(count, 2, "a certificate names its signature algorithm twice");
  return out;
}

/**
 * A signed PDF whose signature dictionary and container are under the test's control:
 *   1. the product's prepareSignature() writes the revision with an empty /Contents (options.prepare);
 *   2. `patch(prepared, text)` may change bytes of the revision IN PLACE (same length), e.g. the /SubFilter
 *      name, or return a new byte range [a, b, c, d] that is then written into the /ByteRange slot;
 *   3. `container(signedBytes, prepared)` returns the bytes for /Contents (any length up to the placeholder);
 *   4. `afterEmbed(bytes, prepared)` may change the hex string of /Contents itself.
 */
export async function craftSignedPdf(pdfBytes, { prepare = {}, patch = null, container, afterEmbed = null }) {
  const prepared = await prepareSignature(pdfBytes, { contentsBytes: 8192, signingTime: new Date("2026-11-16T01:00:00Z"), timeZoneOffsetMinutes: 420, ...prepare });
  const bytes = prepared.bytes;
  let byteRange = prepared.byteRange;
  if (patch) {
    const changed = await patch(prepared, latin1(bytes));
    if (Array.isArray(changed)) {
      byteRange = changed;
      const text = latin1(bytes);
      const at = text.lastIndexOf("/ByteRange [");
      const end = text.indexOf("]", at);
      const slot = `/ByteRange [${byteRange.join(" ")}`.padEnd(end - at, " ");
      assert.equal(slot.length, end - at, "the new byte range fits the slot");
      bytes.set(fromLatin1(slot), at);
    }
  }
  const [a, b, c, d] = byteRange;
  const signed = Buffer.concat([Buffer.from(bytes.subarray(a, a + b)), Buffer.from(bytes.subarray(c, c + d))]);
  const value = await container(new Uint8Array(signed), prepared);
  assert.ok(value.length <= prepared.contentsBytes, `the container (${value.length} bytes) fits the placeholder`);
  bytes.set(fromLatin1(hex(value)), prepared.contentsStart + 1);
  if (afterEmbed) await afterEmbed(bytes, prepared);
  return bytes;
}

/**
 * A signed PDF that is ENCRYPTED (standard security handler of the PDF library). The signature dictionary is
 * part of the document before it is saved; its strings (/Reason, /M) and the field name are encrypted with
 * the object key as the specification demands, /Contents is not. `container(signedBytes)` returns the CMS.
 */
export async function makeEncryptedSignedPdf({ userPassword, reason, container, contentsBytes = 8192 }) {
  const { PDFDocument, PDFName, PDFHexString } = pdfLib;
  const doc = await PDFDocument.load(await makeSignablePdf(), { updateMetadata: false });
  doc.encrypt({ userPassword, ownerPassword: `${userPassword}-owner` });
  const context = doc.context;
  const page = doc.getPages()[0];
  const sealed = (ref, bytes) => PDFHexString.of(hex(context.security.getEncryptFn(ref.objectNumber, ref.generationNumber)(new Uint8Array(bytes))));
  const textString = (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
  const sigRef = context.nextRef();
  const fieldRef = context.nextRef();
  context.assign(sigRef, context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "adbe.pkcs7.detached",
    ByteRange: [0, 1000000000, 1000000000, 1000000000],
    Contents: PDFHexString.of("0".repeat(contentsBytes * 2)),
    Reason: sealed(sigRef, textString(reason)),
    M: sealed(sigRef, Buffer.from("D:20261116080000+07'00'", "latin1"))
  }));
  context.assign(fieldRef, context.obj({
    Type: "Annot", Subtype: "Widget", FT: "Sig", T: sealed(fieldRef, Buffer.from("Signature1", "latin1")), V: sigRef, Rect: [0, 0, 0, 0], F: 132, P: page.ref
  }));
  page.node.set(PDFName.of("Annots"), context.obj([fieldRef]));
  doc.catalog.set(PDFName.of("AcroForm"), context.obj({ Fields: [fieldRef], SigFlags: 3 }));
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  const text = latin1(bytes);
  const range = /\/ByteRange\s*\[[^\]]*\]/.exec(text);
  const contents = /\/Contents\s*<0+>/.exec(text);
  assert.ok(range && contents, "the saved file holds the two placeholders");
  const contentsStart = contents.index + contents[0].indexOf("<");
  const contentsEnd = contents.index + contents[0].length;
  const byteRange = [0, contentsStart, contentsEnd, bytes.length - contentsEnd];
  bytes.set(fromLatin1(`/ByteRange [${byteRange.join(" ")}`.padEnd(range[0].length - 1, " ")), range.index);
  const signed = Buffer.concat([Buffer.from(bytes.subarray(0, contentsStart)), Buffer.from(bytes.subarray(contentsEnd))]);
  const value = await container(new Uint8Array(signed));
  assert.ok(value.length <= contentsBytes);
  bytes.set(fromLatin1(hex(value)), contentsStart + 1);
  return bytes;
}

/** Replaces `from` by `to` (padded with spaces to the same length) at its last occurrence in `bytes`, in place. */
export function replaceInPlace(bytes, from, to) {
  assert.ok(to.length <= from.length, `"${to}" must not be longer than "${from}"`);
  const at = latin1(bytes).lastIndexOf(from);
  assert.ok(at >= 0, `"${from}" not found`);
  bytes.set(fromLatin1(to.padEnd(from.length, " ")), at);
  return at;
}

// ---------------------------------------------------------------------------------------------
// a time-stamp authority in memory
// ---------------------------------------------------------------------------------------------

/**
 * RFC 3161 in memory, for the injected `timestamp.request` of the signer: it answers a TimeStampReq with a
 * token signed by `privateKeyPkcs8` / `certificate` through node:crypto. The editor itself never talks to a
 * TSA; this only exercises the code behind the injection point.
 * options: status (PKIStatus, default 0), wrongImprint, dropNonce, padding (extra bytes inside the token, to
 * make it larger than announced), time (Date), omitCertificate, noSigner, imprintHash: "sha224"
 */
export function fakeTsa({ certificate, privateKeyPkcs8 }, options = {}) {
  const key = nodeKey(privateKeyPkcs8);
  const tsa = parseCertificate(certificate);
  const calls = [];
  const request = async (tsq) => {
    const bytes = Buffer.from(tsq);
    calls.push(bytes);
    const fields = derChildren(bytes, derAt(bytes, 0));
    const [algorithm, hashed] = derChildren(bytes, fields[1]);
    assert.equal(derOid(bytes, derChildren(bytes, algorithm)[0]), OIDS.sha256, "the request carries a SHA-256 imprint");
    const nonceNode = fields.slice(2).find((node) => node.tag === 0x02);
    if (options.status) return der.seq(der.seq(der.int(options.status)));
    const imprint = options.wrongImprint ? crypto.randomBytes(32) : derContent(bytes, hashed);
    const tstInfo = der.seq(
      der.int(1),
      der.oid("1.3.6.1.4.1.99999.2.1"),
      der.seq(der.seq(der.oid(options.imprintHash === "sha224" ? OIDS.sha224 : OIDS.sha256), der.nul()), der.octets(imprint)),
      der.int(calls.length + 1000),
      der.generalizedTime(options.time || new Date("2026-11-16T02:00:00Z")),
      nonceNode && !options.dropNonce ? derRaw(bytes, nonceNode) : null
    );
    const attributes = [
      der.seq(der.oid(OIDS.contentType), der.set(der.oid(OIDS.tstInfo))),
      der.seq(der.oid(OIDS.messageDigest), der.set(der.octets(sha256(tstInfo))))
    ].map((entry) => Buffer.from(entry)).sort(Buffer.compare);
    const signedAttributes = Buffer.from(der.set(...attributes));
    const implicit = Buffer.from(signedAttributes);
    implicit[0] = 0xa0;
    const signerInfo = der.seq(
      der.int(1),
      der.seq(tsa.issuer.der, tsa.serialNumberTlv),
      der.seq(der.oid(OIDS.sha256), der.nul()),
      implicit,
      der.seq(der.oid(OIDS.sha256WithRsa), der.nul()),
      der.octets(crypto.sign("sha256", signedAttributes, key)),
      options.padding ? der.ctx(1, der.seq(der.oid("1.2.3.4.5"), der.set(der.octets(new Uint8Array(options.padding))))) : null
    );
    const signedData = der.seq(
      der.int(3),
      der.set(der.seq(der.oid(OIDS.sha256), der.nul())),
      der.seq(der.oid(OIDS.tstInfo), der.ctx(0, der.octets(tstInfo))),
      options.omitCertificate ? null : der.ctx(0, tsa.der),
      der.set(options.noSigner ? null : signerInfo)
    );
    return der.seq(der.seq(der.int(0)), der.seq(der.oid(OIDS.signedData), der.ctx(0, signedData)));
  };
  return { request, calls };
}

// ---------------------------------------------------------------------------------------------

/** Awaits a promise (or calls a function), expects a PdfEditorError with the given code and returns it. */
export async function rejectsWithCode(promiseOrFn, code) {
  let error = null;
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${code}, but nothing was thrown`);
  assert.equal(error.name, "PdfEditorError", `expected ${code}, got ${error.name}: ${error.message}`);
  assert.equal(error.code, code, error.message);
  return error;
}

/**
 * Runs `fn` while crypto.subtle.digest fails with `error`: a failure of the platform that nothing in the engine
 * expects (every other method keeps working). The property is restored afterwards.
 */
export async function withFailingDigest(error, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const real = globalThis.crypto;
  const subtle = new Proxy(real.subtle, {
    get(target, key) {
      if (key === "digest") return () => Promise.reject(error);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  Object.defineProperty(globalThis, "crypto", { configurable: true, enumerable: true, writable: true, value: { getRandomValues: (array) => real.getRandomValues(array), subtle } });
  try {
    return await fn();
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
}

/**
 * Runs `fn` while every call of crypto.subtle[method] is counted: `fn(calls)` receives the list of argument
 * lists, filled while it runs. The calls themselves go through unchanged; the property is restored afterwards.
 */
export async function withCountedSubtle(method, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const real = globalThis.crypto;
  const calls = [];
  const subtle = new Proxy(real.subtle, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== method) return value.bind(target);
      return (...args) => {
        calls.push(args);
        return value.apply(target, args);
      };
    }
  });
  Object.defineProperty(globalThis, "crypto", { configurable: true, enumerable: true, writable: true, value: { getRandomValues: (array) => real.getRandomValues(array), subtle } });
  try {
    return await fn(calls);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
}

const PKCS12_OIDS = Object.freeze({
  data: "1.2.840.113549.1.7.1",
  encryptedData: "1.2.840.113549.1.7.6",
  pbeSha13Des: "1.2.840.113549.1.12.1.3",
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12",
  pbmac1: "1.2.840.113549.1.5.14",
  aes256Cbc: "2.16.840.1.101.3.4.1.42",
  hmac: { sha1: "1.2.840.113549.2.7", sha256: "1.2.840.113549.2.9", sha512: "1.2.840.113549.2.11" },
  digest: { sha1: OIDS.sha1, sha256: OIDS.sha256, sha512: "2.16.840.1.101.3.4.2.3" }
});

/**
 * A PKCS#12 container written by hand that holds NOTHING but requests for key derivation work: the structure
 * is correct, the "encrypted" data is noise and the MAC value is wrong. What a hostile file looks like to the
 * loader until it has spent the work the file asks for.
 *   mac    null (no MAC) | { hash: "sha1" | "sha256" | "sha512", iterations }      the legacy PKCS#12 derivation
 *               | { pbmac1: { prf, iterations, keyLength } }                        PBKDF2 (RFC 9579)
 *   parts  [{ scheme: "3des", iterations } | { scheme: "pbes2", prf, iterations }]  one encrypted SafeContents each
 *   salt   (index) => Uint8Array   default: 8 bytes that differ per part
 */
export function workHungryPkcs12({ mac = null, parts = [], salt = (index) => Uint8Array.of(0x5a, 1, 2, 3, 4, 5, 6, index & 0xff) }) {
  const pbkdf2 = (prf, iterations, keyLength, saltBytes) => der.seq(
    der.oid(PKCS12_OIDS.pbkdf2),
    der.seq(der.octets(saltBytes), der.int(iterations), keyLength ? der.int(keyLength) : null, der.seq(der.oid(PKCS12_OIDS.hmac[prf]), der.nul()))
  );
  const contents = parts.map((part, index) => {
    const algorithm = part.scheme === "pbes2"
      ? der.seq(der.oid(PKCS12_OIDS.pbes2), der.seq(pbkdf2(part.prf || "sha256", part.iterations, 32, salt(index)), der.seq(der.oid(PKCS12_OIDS.aes256Cbc), der.octets(new Uint8Array(16).fill(7)))))
      : der.seq(der.oid(PKCS12_OIDS.pbeSha13Des), der.seq(der.octets(salt(index)), der.int(part.iterations)));
    const noise = Uint8Array.from({ length: 64 }, (value, at) => (at * 73 + index * 19 + 5) & 0xff);
    return der.seq(der.oid(PKCS12_OIDS.encryptedData), der.ctx(0, der.seq(der.int(0), der.seq(der.oid(PKCS12_OIDS.data), algorithm, der.ctxPrimitive(0, noise)))));
  });
  const authSafe = der.seq(...contents);
  let macData = null;
  if (mac && mac.pbmac1) {
    const { prf = "sha256", iterations, keyLength = 32 } = mac.pbmac1;
    const algorithm = der.seq(der.oid(PKCS12_OIDS.pbmac1), der.seq(pbkdf2(prf, iterations, keyLength, salt(250)), der.seq(der.oid(PKCS12_OIDS.hmac.sha256), der.nul())));
    macData = der.seq(der.seq(algorithm, der.octets(new Uint8Array(32).fill(9))), der.octets(salt(251)), der.int(1));
  } else if (mac) {
    const size = { sha1: 20, sha256: 32, sha512: 64 }[mac.hash];
    macData = der.seq(der.seq(der.seq(der.oid(PKCS12_OIDS.digest[mac.hash]), der.nul()), der.octets(new Uint8Array(size).fill(9))), der.octets(salt(252)), der.int(mac.iterations));
  }
  return der.seq(der.int(3), der.seq(der.oid(PKCS12_OIDS.data), der.ctx(0, der.octets(authSafe))), macData);
}

/** Runs `fn` while crypto.subtle is hidden (a page on plain http): the property is restored afterwards. */
export async function withoutWebCrypto(fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, enumerable: true, writable: true, value: { getRandomValues: (array) => real.getRandomValues(array) } });
  try {
    return await fn();
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
}
