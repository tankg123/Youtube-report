// What the signing feature keeps on the device (signing/storage.js), with an injected storage: the saved
// signature pictures (at most 10, small) and the trusted certificates (public certificates only). What comes
// back from storage is never trusted.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { certificateFacts, createSelfSigned, inspectSignatures, loadPkcs12, signPdf } from "../src/pages/pdfEditor/engine/sign/index.js";
import {
  MAX_SAVED_SIGNATURES, MAX_SIGNATURE_CHARS, MAX_TRUSTED_CERTIFICATES, SAVED_SIGNATURES_KEY, TRUSTED_CERTIFICATES_KEY, base64ToBytes, bytesToBase64, certificatesOfFile,
  createSignatureShelf, createTrustList, pngBytesOfDataUrl, pngDataUrl, trustedEntry
} from "../src/pages/pdfEditor/signing/storage.js";
import { levelOf } from "../src/pages/pdfEditor/signing/verdict.js";
import { CERTS, KEYS, P12, PASSWORD } from "./helpers/pdfSignFixtures.mjs";
import { makeSignablePdf } from "./helpers/pdfSignKit.mjs";
import { makePng } from "./helpers/pdfTestKit.mjs";

/** A Storage that lives in a Map; `quota`: characters it holds before setItem throws. */
function memoryStorage({ quota = Infinity } = {}) {
  const map = new Map();
  return {
    map,
    writes: 0,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (String(value).length > quota) throw new DOMException("full", "QuotaExceededError");
      this.writes += 1;
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key)
  };
}
const png = (seed = 0) => pngDataUrl(makePng(4 + (seed % 5), 4, [seed % 256, 30, 30, 255]));
const picture = (seed, kind = "draw") => ({ dataUrl: png(seed), width: 4 + (seed % 5), height: 4, kind });
const pem = (der, label = "CERTIFICATE") => `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
const bytesOf = (text) => new Uint8Array(Buffer.from(text, "latin1"));

test("storage: base64 and PNG data URLs", () => {
  const bytes = crypto.randomBytes(70000);
  assert.deepEqual(Buffer.from(base64ToBytes(bytesToBase64(new Uint8Array(bytes)))), bytes);
  assert.equal(bytesToBase64(new Uint8Array(bytes)), bytes.toString("base64"));
  assert.equal(base64ToBytes("not base64 !!"), null);
  const image = makePng(3, 2);
  assert.deepEqual([...pngBytesOfDataUrl(pngDataUrl(image))], [...image]);
  assert.equal(pngBytesOfDataUrl("data:image/jpeg;base64,AAAA"), null);
  assert.equal(pngBytesOfDataUrl(`data:image/png;base64,${Buffer.from("this is not a png at all").toString("base64")}`), null);
  assert.equal(pngBytesOfDataUrl(undefined), null);
});

test("storage: saved signatures: newest first, the same picture once, removal, the same array while nothing changes", () => {
  const storage = memoryStorage();
  let clock = 1000;
  let ids = 0;
  const shelf = createSignatureShelf(storage, { now: () => (clock += 1), makeId: () => `sig-${(ids += 1)}` });
  assert.deepEqual(shelf.list(), []);
  let notified = 0;
  const off = shelf.subscribe(() => (notified += 1));
  const first = shelf.add(picture(1, "draw"));
  const second = shelf.add(picture(2, "type"));
  assert.deepEqual([first, second], [{ ok: true, id: "sig-1", stored: true }, { ok: true, id: "sig-2", stored: true }]);
  assert.deepEqual(shelf.list().map((entry) => [entry.id, entry.kind]), [["sig-2", "type"], ["sig-1", "draw"]]);
  assert.equal(shelf.list(), shelf.list(), "a stable snapshot for useSyncExternalStore");
  assert.equal(notified, 2);
  // the same picture again is the saved one
  assert.deepEqual(shelf.add(picture(1, "upload")), { ok: true, id: "sig-1", stored: true });
  assert.equal(shelf.list().length, 2);
  assert.equal(shelf.remove("sig-1"), true);
  assert.equal(shelf.remove("sig-1"), false);
  assert.deepEqual(shelf.list().map((entry) => entry.id), ["sig-2"]);
  off();
  // it is in the storage, and a new shelf reads it back
  const raw = JSON.parse(storage.getItem(SAVED_SIGNATURES_KEY));
  assert.equal(raw.length, 1);
  assert.deepEqual(Object.keys(raw[0]).sort(), ["dataUrl", "height", "id", "kind", "savedAt", "width"]);
  assert.deepEqual(createSignatureShelf(storage).list().map((entry) => entry.id), ["sig-2"]);
});

test("storage: at most 10 saved signatures, each small enough that localStorage is enough", () => {
  const storage = memoryStorage({ quota: 5_000_000 }); // characters a browser gives one origin
  const shelf = createSignatureShelf(storage);
  for (let index = 0; index < MAX_SAVED_SIGNATURES; index += 1) assert.equal(shelf.add(picture(index + 1)).ok, true);
  assert.equal(shelf.isFull(), true);
  assert.deepEqual(shelf.add(picture(99)), { ok: false, reason: "full" });
  assert.equal(shelf.list().length, MAX_SAVED_SIGNATURES);
  // a picture above the limit is refused before anything is written
  const large = `data:image/png;base64,${"A".repeat(MAX_SIGNATURE_CHARS)}`;
  assert.deepEqual(createSignatureShelf(memoryStorage()).add({ dataUrl: large, width: 10, height: 10, kind: "upload" }), { ok: false, reason: "too-large" });
  // ten pictures of the largest size the shelf accepts stay far below the quota of an origin
  assert.ok(MAX_SAVED_SIGNATURES * (MAX_SIGNATURE_CHARS + 200) < 2_000_000);
  // things that are no signature picture
  for (const bad of [null, {}, { dataUrl: "data:text/plain;base64,AAAA", width: 1, height: 1 }, { dataUrl: png(1), width: 0, height: 4 }, { dataUrl: png(1), width: 4, height: Number.NaN }]) {
    assert.equal(createSignatureShelf(memoryStorage()).add(bad).ok, false);
  }
});

test("storage: a storage that is missing, full or holds garbage never breaks the lists", () => {
  // no storage at all (private mode): the picture lasts for the page
  const none = createSignatureShelf(null);
  assert.deepEqual(none.add(picture(1)), { ok: true, id: none.list()[0].id, stored: false });
  assert.equal(none.list().length, 1);
  // a full storage
  const full = createSignatureShelf(memoryStorage({ quota: 10 }));
  assert.equal(full.add(picture(1)).stored, false);
  assert.equal(full.list().length, 1);
  // a storage that throws on reading
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.deepEqual(createSignatureShelf(broken).list(), []);
  assert.deepEqual(createTrustList(broken).list(), []);
  // garbage and half-right entries are dropped, good ones kept
  const storage = memoryStorage();
  storage.setItem(SAVED_SIGNATURES_KEY, JSON.stringify([
    { id: "ok", dataUrl: png(3), width: 7, height: 4, kind: "draw", savedAt: 5 },
    { id: "", dataUrl: png(4), width: 4, height: 4 },
    { id: "no-png", dataUrl: "javascript:alert(1)", width: 4, height: 4 },
    { id: "huge", dataUrl: `data:image/png;base64,${"A".repeat(MAX_SIGNATURE_CHARS + 1)}`, width: 4, height: 4 },
    { id: "odd-kind", dataUrl: png(5), width: 4, height: 4, kind: "<script>" },
    "text",
    null
  ]));
  assert.deepEqual(createSignatureShelf(storage).list().map((entry) => [entry.id, entry.kind]), [["ok", "draw"], ["odd-kind", "draw"]]);
  storage.setItem(SAVED_SIGNATURES_KEY, "{ not json");
  assert.deepEqual(createSignatureShelf(storage).list(), []);
  storage.setItem(SAVED_SIGNATURES_KEY, JSON.stringify({ not: "a list" }));
  assert.deepEqual(createSignatureShelf(storage).list(), []);
  // more than the limit in the storage (another version wrote it): only ten are used
  storage.setItem(SAVED_SIGNATURES_KEY, JSON.stringify(Array.from({ length: 25 }, (unused, index) => ({ id: `s${index}`, dataUrl: png(index), width: 4 + (index % 5), height: 4 }))));
  assert.equal(createSignatureShelf(storage).list().length, MAX_SAVED_SIGNATURES);
});

test("storage: certificate files: only CERTIFICATE blocks are read, a private key is noticed and never taken", () => {
  const der = certificatesOfFile(CERTS.rootCa);
  assert.deepEqual([der.kind, der.certificates.length, der.hasPrivateKey], ["der", 1, false]);
  const text = certificatesOfFile(bytesOf(pem(CERTS.rootCa)));
  assert.deepEqual([text.kind, text.certificates.length, text.hasPrivateKey], ["pem", 1, false]);
  assert.deepEqual([...text.certificates[0]], [...CERTS.rootCa]);
  // a bundle with a key in it: the certificates, and the fact that a key travels with them
  const bundle = certificatesOfFile(bytesOf(`${pem(CERTS.signer1)}${pem(KEYS.signer1, "PRIVATE KEY")}${pem(CERTS.intermediateCa)}`));
  assert.deepEqual([bundle.certificates.length, bundle.hasPrivateKey], [2, true]);
  assert.deepEqual([...bundle.certificates[1]], [...CERTS.intermediateCa]);
  // a key alone, a PKCS#12 container, a PKCS#8 key in DER, a PDF, nothing
  assert.deepEqual(certificatesOfFile(bytesOf(pem(KEYS.signer1, "PRIVATE KEY"))), { certificates: [], hasPrivateKey: true, kind: "pem" });
  assert.deepEqual(certificatesOfFile(P12.aes256.bytes), { certificates: [], hasPrivateKey: true, kind: "pkcs12" });
  assert.equal(certificatesOfFile(KEYS.signer1).certificates.length, 0);
  assert.equal(certificatesOfFile(KEYS.signer1).hasPrivateKey, true);
  assert.deepEqual(certificatesOfFile(bytesOf("%PDF-1.7\n")), { certificates: [], hasPrivateKey: false, kind: "unknown" });
  assert.deepEqual(certificatesOfFile(new Uint8Array(0)), { certificates: [], hasPrivateKey: false, kind: "unknown" });
  assert.deepEqual(certificatesOfFile("text"), { certificates: [], hasPrivateKey: false, kind: "unknown" });
});

test("storage: the trust list keeps public certificates only and makes a chain to one of them read Valid", async () => {
  const storage = memoryStorage();
  const list = createTrustList(storage);
  const facts = await certificateFacts(CERTS.rootCa);
  const entry = trustedEntry(CERTS.rootCa, facts, 42);
  assert.match(entry.id, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(entry.subject, "ANS Test Root CA");
  assert.deepEqual([entry.isCa, entry.selfSigned, entry.addedAt], [true, true, 42]);
  assert.deepEqual(list.add(entry), { ok: true, id: entry.id, added: true, stored: true });
  assert.deepEqual(list.add(entry), { ok: true, id: entry.id, added: false, stored: true }, "the same certificate once");
  assert.equal(list.list().length, 1);
  // what is stored: the certificate and what is shown about it, nothing else
  const stored = storage.getItem(TRUSTED_CERTIFICATES_KEY);
  assert.deepEqual(Object.keys(JSON.parse(stored)[0]).sort(), ["addedAt", "der", "id", "isCa", "issuer", "notAfter", "notBefore", "selfSigned", "subject"]);
  assert.deepEqual([...list.certificates()[0]], [...CERTS.rootCa]);

  // handed to the engine: a signature of the test PKI is "valid" with the list and "signer not verified" without
  const signer = await loadPkcs12(P12.aes256.bytes, PASSWORD);
  const signed = (await signPdf(await makeSignablePdf(), { signer })).bytes;
  assert.equal(levelOf((await inspectSignatures(signed, { trustedCertificates: list.certificates() })).signatures[0]), "valid");
  assert.equal(list.remove(entry.id), true);
  assert.equal(levelOf((await inspectSignatures(signed, { trustedCertificates: list.certificates() })).signatures[0]), "unverified");
  assert.equal(storage.getItem(TRUSTED_CERTIFICATES_KEY), "[]");

  // a signer's own (self-signed) certificate can be trusted as well
  const self = await createSelfSigned({ commonName: "Trần Thị Bình", keyType: "P-256" });
  const own = trustedEntry(self.certificate, await certificateFacts(self.certificate));
  assert.equal(list.add(own).added, true);
  const selfSigned = (await signPdf(await makeSignablePdf(), { signer: self })).bytes;
  assert.equal(levelOf((await inspectSignatures(selfSigned, { trustedCertificates: list.certificates() })).signatures[0]), "valid");
});

test("storage: the trust list refuses what is no certificate and never reads a key back from storage", async () => {
  const list = createTrustList(memoryStorage());
  const facts = await certificateFacts(CERTS.rootCa);
  const good = trustedEntry(CERTS.rootCa, facts);
  for (const bad of [
    null,
    { ...good, id: "not-a-fingerprint" },
    { ...good, der: "@@@" },
    { ...good, der: bytesToBase64(bytesOf("%PDF-1.7 this is not a certificate, it is long enough to pass a length check though ............")) },
    { ...good, der: bytesToBase64(new Uint8Array(70000).fill(0x30)) },
    { ...good, der: bytesToBase64(CERTS.rootCa.subarray(0, 20)) }
  ]) {
    assert.deepEqual(list.add(bad), { ok: false, reason: "invalid" });
  }
  assert.equal(list.list().length, 0);
  // the list is bounded
  const bounded = createTrustList(memoryStorage());
  for (let index = 0; index < MAX_TRUSTED_CERTIFICATES; index += 1) {
    const id = Array.from({ length: 32 }, (unused, byte) => ((index * 7 + byte) % 256).toString(16).padStart(2, "0").toUpperCase()).join(":");
    assert.equal(bounded.add({ ...good, id }).ok, true);
  }
  assert.deepEqual(bounded.add(good), { ok: false, reason: "full" });
  // what somebody wrote into the storage by hand is checked like any foreign input
  const storage = memoryStorage();
  storage.setItem(TRUSTED_CERTIFICATES_KEY, JSON.stringify([good, { ...good, id: "x" }, { id: good.id.replace(/^../, "00"), der: bytesToBase64(KEYS.signer1.subarray(0, 40)), subject: "a key" }, 7]));
  const read = createTrustList(storage).list();
  assert.deepEqual(read.map((entry) => entry.subject), ["ANS Test Root CA"]);
  // text of an entry is cut to a sane length and typed
  storage.setItem(TRUSTED_CERTIFICATES_KEY, JSON.stringify([{ ...good, subject: "x".repeat(5000), issuer: 12, isCa: "yes" }]));
  const [entry] = createTrustList(storage).list();
  assert.deepEqual([entry.subject.length, entry.issuer, entry.isCa], [300, "", true]);
});
