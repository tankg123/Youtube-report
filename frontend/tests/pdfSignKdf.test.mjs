// engine/sign: the key derivation of PKCS#12 files as a matter of TIME. A file chooses its own iteration
// counts, so a hostile one can ask for any amount of work: the loader must answer every container, hostile or
// not, with its result or a code within a few seconds, stay cancellable while it works, and still open the
// honest files with high counts (Java and Firefox write 100 000 and more).
//
// The synchronous digests behind the legacy derivation (hashSync.js) are compared with the platform (WebCrypto
// and node:crypto); the derivation itself with a reference written here from RFC 7292 appendix B.2.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { digestSync, hasSyncDigest, rehashSync } from "../src/pages/pdfEditor/engine/sign/hashSync.js";
import { loadPkcs12 } from "../src/pages/pdfEditor/engine/sign/index.js";
import { KDF_LIMITS, createPkcs12, pkcs12Kdf } from "../src/pages/pdfEditor/engine/sign/pkcs12.js";
import { CANCELLED } from "../src/pages/pdfEditor/engine/errors.js";
import { CERTS, KEYS, UNICODE_PASSWORD } from "./helpers/pdfSignFixtures.mjs";
import { rejectsWithCode, withCountedSubtle, workHungryPkcs12 } from "./helpers/pdfSignKit.mjs";

const HASHES = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };
const hexOf = (bytes) => Buffer.from(bytes).toString("hex");
// Generous on purpose (other work runs on this machine while the tests do): the target is about 3 seconds, the
// module before the repair needed 17 s to 100 s for the same inputs.
const TIME_LIMIT_MS = 8000;

/** Runs `fn`, returns [its result or the code it was refused with, elapsed milliseconds]. */
async function timed(fn) {
  const started = performance.now();
  let outcome;
  try {
    outcome = await fn();
  } catch (error) {
    assert.equal(error.name, "PdfEditorError", `a coded error is expected, got ${error && error.stack}`);
    outcome = error.code;
  }
  return [outcome, performance.now() - started];
}

/** PKCS#12 key derivation written from RFC 7292 B.2 with node:crypto: shares nothing with the module. */
function referenceKdf(node, u, v, password, salt, id, iterations, length) {
  const fill = (source) => Buffer.from(Array.from({ length: v * Math.ceil(source.length / v) }, (value, index) => source[index % source.length]));
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(password)]);
  const blocks = [];
  for (let produced = 0; produced < length; produced += u) {
    let A = crypto.createHash(node).update(D).update(I).digest();
    for (let round = 1; round < iterations; round++) A = crypto.createHash(node).update(A).digest();
    blocks.push(A);
    const B = BigInt(`0x${fill(A).subarray(0, v).toString("hex")}`) + 1n;
    for (let j = 0; j < I.length; j += v) {
      const sum = (BigInt(`0x${I.subarray(j, j + v).toString("hex")}`) + B) % (1n << BigInt(8 * v));
      Buffer.from(sum.toString(16).padStart(2 * v, "0"), "hex").copy(I, j);
    }
  }
  return Buffer.concat(blocks).subarray(0, length);
}

test("kdf: the synchronous digests equal the platform's (WebCrypto and node:crypto) on random inputs", async () => {
  // every length around the padding boundaries of both block sizes, and a few long ones
  const lengths = [...Array.from({ length: 260 }, (value, index) => index), 1000, 4095, 4096, 4097, 70000];
  for (const [name, node] of Object.entries(HASHES)) {
    assert.equal(hasSyncDigest(name), true);
    for (const length of lengths) {
      const data = new Uint8Array(crypto.randomBytes(length));
      const ours = hexOf(digestSync(name, data));
      assert.equal(ours, crypto.createHash(node).update(data).digest("hex"), `${name}, ${length} bytes (node:crypto)`);
      if (length % 16 === 0) assert.equal(ours, hexOf(new Uint8Array(await globalThis.crypto.subtle.digest(name, data))), `${name}, ${length} bytes (WebCrypto)`);
    }
    // the loop of the key derivation: a digest hashed again and again
    const start = new Uint8Array(crypto.createHash(node).update("seed").digest());
    for (const rounds of [0, 1, 2, 500]) {
      let reference = Buffer.from(start);
      for (let i = 0; i < rounds; i++) reference = Buffer.from(await globalThis.crypto.subtle.digest(name, reference));
      assert.equal(hexOf(rehashSync(name, start, rounds)), reference.toString("hex"), `${name}: ${rounds} rounds`);
    }
    assert.equal(hexOf(start), crypto.createHash(node).update("seed").digest("hex"), "the input is not changed");
    assert.throws(() => rehashSync(name, start.subarray(1), 1), RangeError);
  }
  // known answers (FIPS 180 examples)
  assert.equal(hexOf(digestSync("SHA-1", new TextEncoder().encode("abc"))), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(hexOf(digestSync("SHA-256", new Uint8Array(0))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hexOf(digestSync("SHA-512", new TextEncoder().encode("abc"))).slice(0, 32), "ddaf35a193617abacc417349ae204131");
  assert.equal(hasSyncDigest("MD5"), false);
  assert.throws(() => digestSync("MD5", new Uint8Array(1)), RangeError);
});

test("kdf: the PKCS#12 derivation equals a reference written from the RFC, also across the points where it pauses", async () => {
  const password = Buffer.concat([Buffer.from(UNICODE_PASSWORD, "utf16le").swap16(), Buffer.from([0, 0])]);
  const sizes = { "SHA-1": [20, 64], "SHA-256": [32, 64], "SHA-384": [48, 128], "SHA-512": [64, 128] };
  for (const [name, node] of Object.entries(HASHES)) {
    const [u, v] = sizes[name];
    // 1, 2 and the counts around one slice of the loop (4096 rounds for the short digests, 1024 for the long)
    for (const [id, length, iterations, saltLength] of [[1, 24, 1, 8], [2, 8, 2, 8], [3, u, 1023, 8], [1, 2 * u + 5, 1025, 20], [3, u, 4096, 8], [1, 24, 4097, 16], [2, 8, 9000, 8], [1, 32, 3, 0]]) {
      const salt = new Uint8Array(crypto.randomBytes(saltLength));
      const ours = await pkcs12Kdf(name, new Uint8Array(password), salt, id, iterations, length);
      assert.equal(hexOf(ours), referenceKdf(node, u, v, password, salt, id, iterations, length).toString("hex"), `${name} id ${id} length ${length} iterations ${iterations} salt ${saltLength}`);
    }
  }
  // "no password" (zero bytes) is its own input
  const none = await pkcs12Kdf("SHA-1", new Uint8Array(0), Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), 3, 10, 20);
  assert.equal(hexOf(none), referenceKdf("sha1", 20, 64, Buffer.alloc(0), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), 3, 10, 20).toString("hex"));
});

test("kdf: a container with 100 000 iterations of the legacy derivation opens, quickly", async () => {
  const container = await createPkcs12({ privateKeyPkcs8: KEYS.signer1, certificates: [CERTS.signer1, CERTS.intermediateCa, CERTS.rootCa], password: UNICODE_PASSWORD, profile: "3des", iterations: 100000 });
  const [opened, elapsed] = await timed(() => loadPkcs12(container, UNICODE_PASSWORD));
  assert.equal(typeof opened, "object", `expected the identity, got ${opened}`);
  assert.deepEqual([opened.info.integrity, opened.info.keyEncryption, opened.chain.length], ["HMAC-SHA-1 (PKCS#12 KDF, 100000 iterations)", "pbeWithSHAAnd3-KeyTripleDES-CBC (100000 iterations)", 3]);
  assert.ok(elapsed < TIME_LIMIT_MS, `opened in ${Math.round(elapsed)} ms`);
  // the same file with a wrong password: one derivation per form the password can have, then the code
  const [refused, refusedIn] = await timed(() => loadPkcs12(container, `${UNICODE_PASSWORD}4`));
  assert.equal(refused, "CERT_WRONG_PASSWORD");
  assert.ok(refusedIn < TIME_LIMIT_MS, `refused in ${Math.round(refusedIn)} ms`);
});

test("kdf: hostile containers end with a code in bounded time (iteration counts at the cap, everywhere)", async () => {
  const cap = KDF_LIMITS.maxLegacyIterations;
  assert.equal(cap, 1_000_000);
  const cases = [
    // the reviewer's case: MAC and both parts at the cap, a password with four byte forms
    ["legacy MAC + two parts at the cap", workHungryPkcs12({ mac: { hash: "sha1", iterations: cap }, parts: [{ scheme: "3des", iterations: cap }, { scheme: "3des", iterations: cap }] }), UNICODE_PASSWORD, ["CERT_WRONG_PASSWORD"]],
    ["SHA-512 MAC at the cap", workHungryPkcs12({ mac: { hash: "sha512", iterations: cap }, parts: [{ scheme: "3des", iterations: cap }] }), "wrong", ["CERT_WRONG_PASSWORD", "CERT_CORRUPT"]],
    // no MAC: every form of the password is tried on the encrypted part itself
    ["no MAC, a legacy part at the cap", workHungryPkcs12({ parts: [{ scheme: "3des", iterations: cap }] }), UNICODE_PASSWORD, ["CERT_WRONG_PASSWORD", "CERT_CORRUPT"]],
    // PBKDF2 runs natively and cannot be interrupted: its work is refused BEFORE it starts
    ["PBMAC1 asking for a 1024-byte key at ten million iterations", workHungryPkcs12({ mac: { pbmac1: { prf: "sha1", iterations: 10_000_000, keyLength: 1024 } }, parts: [] }), "wrong", ["CERT_CORRUPT"]],
    ["no MAC, PBES2 parts at ten million iterations of HMAC-SHA-512", workHungryPkcs12({ parts: [{ scheme: "pbes2", prf: "sha512", iterations: 10_000_000 }] }), UNICODE_PASSWORD, ["CERT_CORRUPT"]],
    ["counts above the caps", workHungryPkcs12({ mac: { hash: "sha256", iterations: cap + 1 }, parts: [] }), "wrong", ["CERT_CORRUPT"]],
    ["PBKDF2 above its cap", workHungryPkcs12({ mac: { pbmac1: { iterations: KDF_LIMITS.maxPbkdf2Iterations + 1 } }, parts: [] }), "wrong", ["CERT_CORRUPT"]]
  ];
  for (const [label, container, password, codes] of cases) {
    const [outcome, elapsed] = await timed(() => loadPkcs12(container, password));
    assert.ok(codes.includes(outcome), `${label}: ${outcome}`);
    assert.ok(elapsed < TIME_LIMIT_MS, `${label}: ${outcome} after ${Math.round(elapsed)} ms`);
  }
  // work that is refused before it starts costs no time at all
  const [, immediate] = await timed(() => loadPkcs12(cases[3][1], "wrong"));
  assert.ok(immediate < 500, `refused after ${Math.round(immediate)} ms`);
});

test("kdf: the budget is a number of hash rounds per file, the same on every machine", async () => {
  assert.deepEqual(Object.keys(KDF_LIMITS).sort(), ["maxLegacyIterations", "maxPbkdf2Iterations", "workBudget"]);
  assert.ok(Object.isFrozen(KDF_LIMITS));
  // an honest file with extreme counts stays inside it: MAC + key + certificates at 600 000 (what NSS writes)
  const legacyCost = 600_000 * (1 + 2 * 3);
  assert.ok(legacyCost < KDF_LIMITS.workBudget);
  // many parts with small counts are not refused for their number
  const many = workHungryPkcs12({ parts: Array.from({ length: 30 }, () => ({ scheme: "3des", iterations: 2048 })) });
  assert.equal((await timed(() => loadPkcs12(many, "pw")))[0], "CERT_WRONG_PASSWORD");
  // the legacy derivation direct: its own cap, and the request for a hash it does not have
  await rejectsWithCode(pkcs12Kdf("SHA-1", new Uint8Array(2), new Uint8Array(8), 1, KDF_LIMITS.maxLegacyIterations + 1, 24), "CERT_CORRUPT");
  await rejectsWithCode(pkcs12Kdf("SHA-224", new Uint8Array(2), new Uint8Array(8), 1, 1, 24), "CERT_UNSUPPORTED_ALGORITHM");
});

test("kdf: the work can be cancelled at short intervals, with or without the signal the event loop keeps running", async () => {
  const container = workHungryPkcs12({ mac: { hash: "sha512", iterations: KDF_LIMITS.maxLegacyIterations }, parts: [] });
  const controller = new AbortController();
  let abortedAt = 0;
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks++;
  }, 5);
  setTimeout(() => {
    abortedAt = performance.now();
    controller.abort();
  }, 60);
  try {
    const error = await rejectsWithCode(loadPkcs12(container, "wrong", { signal: controller.signal }), CANCELLED);
    const latency = performance.now() - abortedAt;
    assert.ok(abortedAt > 0, "the derivation was still running when the signal fired");
    assert.ok(latency < 1000, `cancelled ${Math.round(latency)} ms after the signal`);
    assert.deepEqual(error.params, {});
    // the timer of this test ran while the derivation did: the thread was not blocked
    assert.ok(ticks >= 2, `the event loop ran ${ticks} times during the derivation`);
  } finally {
    clearInterval(ticker);
  }
  // the bare derivation takes the signal too
  const second = new AbortController();
  setTimeout(() => second.abort(), 20);
  const started = performance.now();
  await rejectsWithCode(pkcs12Kdf("SHA-512", new Uint8Array(4), new Uint8Array(8), 3, 1_000_000, 64, second.signal), CANCELLED);
  assert.ok(performance.now() - started < 1000);
});

test("kdf: one derivation per distinct input, not one per form of the password", async () => {
  // "" has two forms for the legacy derivation (two zero bytes / nothing) but ONE for PBKDF2 (no bytes): a file
  // without MAC whose part does not decrypt tries both forms, and derives once
  const container = workHungryPkcs12({ parts: [{ scheme: "pbes2", iterations: 1000 }] });
  await withCountedSubtle("deriveBits", async (calls) => {
    await rejectsWithCode(loadPkcs12(container, ""), "CERT_WRONG_PASSWORD");
    assert.equal(calls.length, 1, "one PBKDF2 run for the two forms of the empty password");
  });
  // a Vietnamese password: as typed (NFC), decomposed (NFD), and the byte-wise legacy form of each, which
  // shares its UTF-8 bytes with the form it comes from: two runs, not four
  await withCountedSubtle("deriveBits", async (calls) => {
    await rejectsWithCode(loadPkcs12(container, UNICODE_PASSWORD), "CERT_WRONG_PASSWORD");
    assert.equal(calls.length, 2, "one PBKDF2 run per distinct UTF-8 form");
  });
  // PBMAC1: the same rule
  const mac = workHungryPkcs12({ mac: { pbmac1: { iterations: 1000 } }, parts: [] });
  await withCountedSubtle("deriveBits", async (calls) => {
    await rejectsWithCode(loadPkcs12(mac, UNICODE_PASSWORD), "CERT_WRONG_PASSWORD");
    assert.equal(calls.length, 2);
  });
});
