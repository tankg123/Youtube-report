// PKCS#12 (.p12 / .pfx) import and export. Browser + Node.
//
//   loadPkcs12(bytes, password, options) -> { privateKey (non-extractable CryptoKey), privateKeysByHash,
//                                              keyAlgorithm, certificate (DER), chain (DER[] leaf -> root), info }
//   createPkcs12({ privateKeyPkcs8, certificates, password, ... }) -> Uint8Array
//
// Why not forge.pkcs12.pkcs12FromAsn1 (node-forge 1.4.3)? It hands the same JS string to the PKCS#12 KDF
// (needs UTF-16BE) and to PBKDF2 (needs UTF-8), so a non-ASCII password never opens an AES-protected file; it
// has no PBMAC1; it returns key == null for EC keys; and it turns the private key into immutable strings and
// a forge RSA object, while the PKCS#8 bytes must go straight into WebCrypto as a NON-EXTRACTABLE key.
// This reader does the container logic itself: ASN.1 with ./asn1.js, PBKDF2 / AES / HMAC / SHA with
// WebCrypto, and only Triple-DES and RC2 (legacy files) through forge's des + rc2 modules.
//
// Key handling: decrypted PKCS#8 bytes, derived keys and the byte forms of the password are zeroed as soon
// as WebCrypto holds the key (also on every error path). No error, warning or info field ever carries key
// material or the password: errors are a code plus algorithm names.
//
// TIME. The file chooses its iteration counts, so a hostile one can ask for any amount of key derivation.
// Every container ends with its result or a code in bounded time, through four measures:
//  1. the legacy PKCS#12 derivation hashes synchronously (./hashSync.js) instead of awaiting one WebCrypto
//     digest per round: 0.2 microseconds per round of SHA-1 / SHA-256 and 1.2 of SHA-384 / SHA-512, against 27
//     before (measured on the development machine, Node 24);
//  2. it works in slices, lets the event loop run every few milliseconds and looks at the AbortSignal then,
//     so that the page stays alive and the work can be cancelled at once;
//  3. one WORK BUDGET per loadPkcs12 call, counted in hash rounds, covers every derivation the file asks for,
//     the legacy one and PBKDF2 (which runs natively and cannot be interrupted: its work is refused BEFORE it
//     starts). Beyond the budget the file is CERT_CORRUPT. See KDF_LIMITS for the numbers and their reasons;
//  4. a derivation runs once per distinct input (hash, password bytes, salt, count, length), not once per
//     form the password can have and not again for a part that repeats the parameters of another one.
// info.chainLinks / info.chainComplete follow orderChain (./x509.js): a link whose signature could not be
// checked is listed with signatureOk null, and the chain is then not complete.

import { PdfEditorError, isPdfEditorError, throwIfAborted, warning } from "../errors.js";
import { decode, der, isAsn1Error, TAG } from "./asn1.js";
import { asBytes, concatBytes, equalBytes, latin1Decode, randomBytes, toHex, utf16beDecode, utf16beEncode, utf8Encode, wipe } from "./bytes.js";
import { digestSync, rehashSync } from "./hashSync.js";
import { rc2Cbc, tripleDesCbc } from "./legacyCiphers.js";
import { CURVES, DIGESTS, HMAC_PRFS, OID, PKCS12_ALGORITHM_NAMES } from "./oids.js";
import { resolveSignatureAlgorithm, signatureAlgorithmIdentifier, signData, subtle, verifySignature } from "./sigverify.js";
import { certificateFacts, orderChain, parseCertificate } from "./x509.js";

const fail = (code, params, detail, cause) => new PdfEditorError(code, params || {}, { detail, cause });

/**
 * Limits of the key derivation a file may ask for.
 *
 * maxLegacyIterations / maxPbkdf2Iterations: one derivation with a higher count is refused (CERT_CORRUPT).
 *   What real files hold: OpenSSL and Windows 2 000 - 2 048, Java 10 000 - 100 000, NSS / Firefox 600 000.
 *
 * workBudget: the sum over all derivations of ONE loadPkcs12 call, in units of one synchronous SHA-1 round
 *   (0.2 microseconds on the development machine):
 *     legacy derivation   iterations x blocks x 1 (SHA-1, SHA-256) or 6 (SHA-384, SHA-512)
 *     PBKDF2 (native)     iterations x blocks x 0.5 (HMAC-SHA-1, HMAC-SHA-256) or 1.5 (HMAC-SHA-384 / 512)
 *   (blocks = key length / digest length, rounded up). Measured: 1 000 000 rounds take 0.20 s (SHA-1), 0.20 s
 *   (SHA-256), 1.17 s (SHA-384), 1.18 s (SHA-512); PBKDF2 with 1 000 000 iterations and one block 0.08 s
 *   (HMAC-SHA-1), 0.09 s (HMAC-SHA-256), 0.26 s (HMAC-SHA-384 / 512). 12 000 000 units are therefore about
 *   2.4 s of derivation at most, whatever the file says, and the same decision on every machine (a clock would
 *   refuse honest files on slow devices). An honest file with extreme counts stays far inside: MAC, key and
 *   certificates at 600 000 legacy iterations each cost 4 200 000; a wrong password adds one MAC derivation
 *   per form the password can have (at most four).
 */
export const KDF_LIMITS = Object.freeze({ maxLegacyIterations: 1_000_000, maxPbkdf2Iterations: 10_000_000, workBudget: 12_000_000 });

const LEGACY_ROUND_COST = { "SHA-1": 1, "SHA-256": 1, "SHA-384": 6, "SHA-512": 6 };
const PBKDF2_ROUND_COST = { "SHA-1": 0.5, "SHA-256": 0.5, "SHA-384": 1.5, "SHA-512": 1.5 };
// what any derivation costs besides its rounds (set-up, the first digest over salt and password)
const DERIVATION_BASE_COST = 64;
// rounds hashed between two looks at the clock: about one millisecond of work
const SLICE_ROUNDS = { "SHA-1": 4096, "SHA-256": 4096, "SHA-384": 1024, "SHA-512": 1024 };
// the event loop runs (and the AbortSignal is looked at) after this much uninterrupted work
const PAUSE_AFTER_MS = 8;
// derived keys kept for reuse within one call (a hostile file must not fill the memory with them)
const MAX_CACHED_DERIVATIONS = 64;
const MAX_CACHED_SALT_BYTES = 64;

// ------------------------------------------------------------------------------------------------
// password handling

/**
 * The byte forms a password can have inside a PKCS#12 file.
 *  - PKCS#12 KDF (MAC key, legacy 3DES / RC2 encryption): UTF-16BE + two zero bytes (RFC 7292 B.1);
 *    "no password" (zero-length) is a DIFFERENT input than the empty string.
 *  - PBKDF2 (PBES2 = AES files, PBMAC1): the UTF-8 bytes.
 * Extra candidates: the Unicode NFC / NFD forms of what was typed (Vietnamese input methods produce either),
 * and the byte-wise widening of the UTF-8 form that OpenSSL < 1.1.0 used for non-ASCII passwords.
 * form: "as-typed" | "nfc" | "nfd" | "empty" | "legacy-bytewise"
 */
function passwordCandidates(password) {
  const typed = password == null ? "" : String(password);
  const texts = [];
  for (const [text, form] of [[typed, "as-typed"], [typed.normalize("NFC"), "nfc"], [typed.normalize("NFD"), "nfd"]]) {
    if (!texts.some((entry) => entry.text === text)) texts.push({ text, form });
  }
  const out = [];
  for (const { text, form } of texts) {
    const utf8 = utf8Encode(text);
    out.push({ form, kdf: concatBytes(utf16beEncode(text), Uint8Array.of(0, 0)), utf8 });
    if (text === "") out.push({ form: "empty", kdf: new Uint8Array(0), utf8: new Uint8Array(0) });
    if (utf8.length !== text.length) {
      // legacy OpenSSL: each UTF-8 byte widened to 16 bits
      const widened = new Uint8Array(utf8.length * 2 + 2);
      utf8.forEach((byte, index) => {
        widened[index * 2 + 1] = byte;
      });
      out.push({ form: "legacy-bytewise", kdf: widened, utf8: Uint8Array.from(utf8), legacy: true });
    }
  }
  // Equal byte forms share an id (the index of the first candidate with these bytes): a key is derived once per
  // distinct input, and no string that holds password bytes is ever built to find that out.
  for (const candidate of out) {
    candidate.kdfId = out.findIndex((other) => equalBytes(other.kdf, candidate.kdf));
    candidate.utf8Id = out.findIndex((other) => equalBytes(other.utf8, candidate.utf8));
  }
  return out;
}

function wipeCandidates(candidates) {
  for (const candidate of candidates) {
    wipe(candidate.kdf);
    wipe(candidate.utf8);
  }
}

// ------------------------------------------------------------------------------------------------
// key derivation and ciphers

const HASH_BLOCK = { "SHA-1": 64, "SHA-256": 64, "SHA-384": 128, "SHA-512": 128 };
const HASH_OUTPUT = { "SHA-1": 20, "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 };

/** Lets the event loop run once: timers, messages, input, the abort() of another task. */
function nextTask() {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "function") {
      // not a timer: browsers stretch nested zero timers to 4 ms each
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Pacing of synchronous work that may be cancelled. pause() is called between two slices of work: it returns
 * null while less than PAUSE_AFTER_MS passed since the event loop last ran, else a promise that resolves after
 * the event loop ran once and rejects with CANCELLED when the signal fired meanwhile. One pacer serves all
 * derivations of a loadPkcs12 call, so that many short ones pause as one long one does.
 */
function createPacer(signal) {
  let last = performance.now();
  return {
    signal: signal || null,
    pause() {
      if (performance.now() - last < PAUSE_AFTER_MS) return null;
      return nextTask().then(() => {
        last = performance.now();
        throwIfAborted(signal);
      });
    }
  };
}

function checkLegacyRequest(hashName, iterations) {
  if (!HASH_OUTPUT[hashName]) throw fail("CERT_UNSUPPORTED_ALGORITHM", { algorithm: `PKCS#12 KDF with ${hashName}` }, `PKCS#12 key derivation with ${hashName} is not supported`);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > KDF_LIMITS.maxLegacyIterations) throw fail("CERT_CORRUPT", {}, `unreasonable iteration count ${iterations}`);
}

function checkPbkdf2Request(hashName, iterations, length) {
  if (!PBKDF2_ROUND_COST[hashName]) throw fail("CERT_UNSUPPORTED_ALGORITHM", { algorithm: `PBKDF2 with ${hashName}` }, `PBKDF2 with ${hashName} is not supported`);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > KDF_LIMITS.maxPbkdf2Iterations) throw fail("CERT_CORRUPT", {}, `unreasonable iteration count ${iterations}`);
  if (!Number.isInteger(length) || length < 1 || length > 1024) throw fail("CERT_CORRUPT", {}, `unreasonable key length ${length}`);
}

/** The PKCS#12 derivation itself (the request was checked by the caller): synchronous hashing in slices. */
async function legacyKdf(hashName, passwordBytes, salt, id, iterations, length, pacer) {
  const u = HASH_OUTPUT[hashName];
  const v = HASH_BLOCK[hashName];
  throwIfAborted(pacer.signal);
  const fill = (source) => {
    const out = new Uint8Array(v * Math.ceil(source.length / v));
    for (let i = 0; i < out.length; i++) out[i] = source[i % source.length];
    return out;
  };
  const D = new Uint8Array(v).fill(id);
  const I = concatBytes(fill(salt), fill(passwordBytes));
  const blocks = Math.ceil(length / u);
  const result = new Uint8Array(blocks * u);
  const slice = SLICE_ROUNDS[hashName];
  let A = null;
  try {
    for (let i = 0; i < blocks; i++) {
      const first = concatBytes(D, I);
      A = digestSync(hashName, first);
      wipe(first);
      for (let left = iterations - 1; left > 0;) {
        const rounds = Math.min(left, slice);
        const next = rehashSync(hashName, A, rounds);
        wipe(A);
        A = next;
        left -= rounds;
        const paused = pacer.pause();
        if (paused) await paused;
      }
      result.set(A, i * u);
      if (i + 1 < blocks) {
        const B = new Uint8Array(v);
        for (let j = 0; j < v; j++) B[j] = A[j % u];
        for (let j = 0; j < I.length; j += v) {
          let carry = 1;
          for (let k = v - 1; k >= 0; k--) {
            carry += I[j + k] + B[k];
            I[j + k] = carry & 0xff;
            carry >>= 8;
          }
        }
        wipe(B);
      }
      wipe(A);
    }
    return Uint8Array.from(result.subarray(0, length));
  } finally {
    wipe(A);
    wipe(I);
    wipe(result);
  }
}

/**
 * PKCS#12 key derivation (RFC 7292 appendix B.2). id: 1 = key, 2 = IV, 3 = MAC key.
 * Hashes synchronously in slices and lets the event loop run every few milliseconds; the signal is looked at
 * then (CANCELLED). No budget applies here (that belongs to loadPkcs12), only the cap of one derivation.
 */
export async function pkcs12Kdf(hashName, passwordBytes, salt, id, iterations, length, signal) {
  checkLegacyRequest(hashName, iterations);
  return legacyKdf(hashName, passwordBytes, salt, id, iterations, length, createPacer(signal));
}

async function pbkdf2(hashName, passwordBytes, salt, iterations, length) {
  checkPbkdf2Request(hashName, iterations, length);
  const key = await subtle().importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: hashName, salt, iterations }, key, length * 8));
}

// --- the derivations of ONE loadPkcs12 call: a budget, a pacer and the keys already derived

function createKdfWork(signal) {
  return { pacer: createPacer(signal), remaining: KDF_LIMITS.workBudget, derived: new Map() };
}

function wipeKdfWork(work) {
  for (const bytes of work.derived.values()) wipe(bytes);
  work.derived.clear();
}

/** Takes the cost of one derivation from the budget BEFORE it runs, or refuses the file. */
function spend(work, cost) {
  const total = Math.ceil(cost) + DERIVATION_BASE_COST;
  if (!(total <= work.remaining)) throw fail("CERT_CORRUPT", {}, "the file asks for more key derivation work than a certificate file needs");
  work.remaining -= total;
}

/** The key of a derivation among the kept ones: no password bytes in it, only the id of their form. */
const derivationKey = (kind, hashName, formId, salt, ...numbers) => (salt.length <= MAX_CACHED_SALT_BYTES ? [kind, hashName, formId, toHex(salt), ...numbers].join("|") : null);

/** A copy of the kept result for `key`, or the result of derive(), whose cost is taken from the budget first. */
async function derivedOnce(work, key, cost, derive) {
  const kept = key ? work.derived.get(key) : null;
  if (kept) return Uint8Array.from(kept);
  spend(work, cost);
  const bytes = await derive();
  if (key && work.derived.size < MAX_CACHED_DERIVATIONS) work.derived.set(key, Uint8Array.from(bytes));
  return bytes;
}

/** PKCS#12 derivation with the password form `candidate.kdf`, inside the budget of `work`. The caller wipes the result. */
function deriveLegacy(work, hashName, candidate, salt, id, iterations, length) {
  checkLegacyRequest(hashName, iterations);
  const cost = iterations * Math.ceil(length / HASH_OUTPUT[hashName]) * LEGACY_ROUND_COST[hashName];
  return derivedOnce(work, derivationKey("pkcs12", hashName, candidate.kdfId, salt, id, iterations, length), cost,
    () => legacyKdf(hashName, candidate.kdf, salt, id, iterations, length, work.pacer));
}

/** PBKDF2 with the password form `candidate.utf8`, inside the budget of `work`. The caller wipes the result. */
function derivePbkdf2(work, hashName, candidate, salt, iterations, length) {
  checkPbkdf2Request(hashName, iterations, length);
  const cost = iterations * Math.ceil(length / HASH_OUTPUT[hashName]) * PBKDF2_ROUND_COST[hashName];
  return derivedOnce(work, derivationKey("pbkdf2", hashName, candidate.utf8Id, salt, iterations, length), cost, async () => {
    // native and not interruptible: the signal is looked at before and after
    throwIfAborted(work.pacer.signal);
    const key = await pbkdf2(hashName, candidate.utf8, salt, iterations, length);
    if (work.pacer.signal && work.pacer.signal.aborted) {
      wipe(key);
      throwIfAborted(work.pacer.signal);
    }
    return key;
  });
}

async function hmac(hashName, keyBytes, data) {
  const key = await subtle().importKey("raw", keyBytes, { name: "HMAC", hash: hashName }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", key, data));
}

/** AES-CBC with PKCS#7 padding; null when WebCrypto rejects the operation (wrong padding = wrong key). */
async function aesCbc(decrypt, keyBytes, iv, data) {
  try {
    const key = await subtle().importKey("raw", keyBytes, { name: "AES-CBC" }, false, [decrypt ? "decrypt" : "encrypt"]);
    const out = decrypt ? await subtle().decrypt({ name: "AES-CBC", iv }, key, data) : await subtle().encrypt({ name: "AES-CBC", iv }, key, data);
    return new Uint8Array(out);
  } catch (error) {
    if (isPdfEditorError(error)) throw error; // no WebCrypto at all
    return null;
  }
}

const algorithmName = (oid) => PKCS12_ALGORITHM_NAMES[oid] || oid;
const unsupported = (algorithm, detail) => fail("CERT_UNSUPPORTED_ALGORITHM", { algorithm }, detail || `${algorithm} is not supported`);

/** PBKDF2-params -> { salt, iterations, keyLength, hash, prfOid } */
function readPbkdf2Params(kdf) {
  const kdfOid = kdf.child(0).oid();
  if (kdfOid !== OID.pbkdf2) throw unsupported(algorithmName(kdfOid), `the file uses the key derivation function ${algorithmName(kdfOid)}; only PBKDF2 is supported`);
  const params = kdf.child(1, "PBKDF2 parameters");
  const saltNode = params.child(0);
  if (!saltNode.isUniversal(TAG.OCTET_STRING)) throw unsupported("PBKDF2 salt source", "PBKDF2 with a salt source other than an octet string is not supported");
  const out = { salt: saltNode.octets(), iterations: params.child(1).integerNumber(), keyLength: null, hash: "SHA-1", prfOid: OID.hmacWithSHA1 };
  for (const extra of params.children.slice(2)) {
    if (extra.isUniversal(TAG.INTEGER)) out.keyLength = extra.integerNumber();
    else if (extra.isSequence) {
      out.prfOid = extra.child(0).oid();
      out.hash = HMAC_PRFS[out.prfOid];
      if (!out.hash) throw unsupported(`PBKDF2 with ${algorithmName(out.prfOid)}`, `PBKDF2 with ${algorithmName(out.prfOid)} is not supported (WebCrypto offers HMAC with SHA-1, SHA-256, SHA-384 and SHA-512)`);
    }
  }
  return out;
}

/**
 * Describes and prepares a password-based encryption AlgorithmIdentifier.
 * -> { label, weak, form: "utf8" | "kdf" (which byte form of the password it derives from),
 *      decrypt(candidate, data, work) -> Uint8Array | null   work = createKdfWork(): budget, pacer, kept keys }
 */
function readPbeAlgorithm(algorithm) {
  const oid = algorithm.child(0).oid();
  const params = algorithm.child(1, "encryption parameters");
  if (oid === OID.pbes2) {
    const kdf = readPbkdf2Params(params.child(0));
    const scheme = params.child(1);
    const schemeOid = scheme.child(0).oid();
    const keyLengths = { [OID.aes128Cbc]: 16, [OID.aes192Cbc]: 24, [OID.aes256Cbc]: 32, [OID.desEde3Cbc]: 24 };
    const keyLength = keyLengths[schemeOid];
    if (!keyLength) throw unsupported(algorithmName(schemeOid), `the file is encrypted with ${algorithmName(schemeOid)} (supported: AES-128/192/256-CBC, Triple-DES)`);
    if (kdf.keyLength !== null && kdf.keyLength !== keyLength) throw fail("CERT_CORRUPT", {}, "the PBKDF2 key length does not fit the cipher");
    const iv = scheme.child(1).octets();
    return {
      label: `PBES2 (PBKDF2 HMAC-${kdf.hash}, ${kdf.iterations} iterations, ${algorithmName(schemeOid)})`,
      weak: false,
      form: "utf8",
      async decrypt(candidate, data, work) {
        const key = await derivePbkdf2(work, kdf.hash, candidate, kdf.salt, kdf.iterations, keyLength);
        try {
          if (schemeOid === OID.desEde3Cbc) return tripleDesCbc(true, key, iv, data);
          return await aesCbc(true, key, iv, data);
        } finally {
          wipe(key);
        }
      }
    };
  }
  const legacy = {
    [OID.pbeSha13Des]: { keyLength: 24, weak: false },
    [OID.pbeSha12Des]: { keyLength: 16, weak: false },
    [OID.pbeSha1Rc2128]: { keyLength: 16, rc2Bits: 128, weak: false },
    [OID.pbeSha1Rc240]: { keyLength: 5, rc2Bits: 40, weak: true }
  }[oid];
  if (!legacy) throw unsupported(algorithmName(oid), `the file is encrypted with ${algorithmName(oid)}`);
  const salt = params.child(0).octets();
  const iterations = params.child(1).integerNumber();
  return {
    label: `${algorithmName(oid)} (${iterations} iterations)`,
    weak: legacy.weak,
    form: "kdf",
    async decrypt(candidate, data, work) {
      let key = await deriveLegacy(work, "SHA-1", candidate, salt, 1, iterations, legacy.keyLength);
      let iv = null;
      try {
        iv = await deriveLegacy(work, "SHA-1", candidate, salt, 2, iterations, 8);
        if (legacy.rc2Bits) return rc2Cbc(true, key, legacy.rc2Bits, iv, data);
        if (key.length === 16) {
          const twoKey = key;
          key = concatBytes(twoKey, twoKey.subarray(0, 8)); // two-key 3DES = K1 K2 K1
          wipe(twoKey);
        }
        return tripleDesCbc(true, key, iv, data);
      } finally {
        wipe(key);
        wipe(iv);
      }
    }
  };
}

// ------------------------------------------------------------------------------------------------
// container parsing

const ZIP_MAGIC = `PK${String.fromCharCode(3, 4)}`;

/** What a file that is not a PKCS#12 container looks like, for the message: a keyword or null. */
function sniffNotPkcs12(bytes) {
  if (bytes.length === 0) return "empty";
  const head = latin1Decode(bytes.subarray(0, 40));
  if (head.startsWith("-----BEGIN")) return "pem";
  if (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfe && bytes[3] === 0xed) return "jks";
  if (head.startsWith("%PDF")) return "pdf";
  if (head.startsWith(ZIP_MAGIC)) return "zip";
  return null;
}

function parsePfx(bytes) {
  const hint = sniffNotPkcs12(bytes);
  if (hint) throw fail("CERT_NOT_PKCS12", { hint }, `not a PKCS#12 container (${hint})`);
  let root;
  try {
    root = decode(bytes);
  } catch (error) {
    // a DER SEQUENCE whose lengths run past the end is a cut-off container; anything else is another format
    if (bytes[0] === 0x30) throw fail("CERT_CORRUPT", {}, "the file is damaged or incomplete", error);
    throw fail("CERT_NOT_PKCS12", { hint: null }, "not a PKCS#12 container", error);
  }
  try {
    // PFX = SEQUENCE { version INTEGER, authSafe ContentInfo { contentType OID (pkcs7-...), ... }, macData }
    const first = root.isSequence && root.children.length >= 2 ? root.children[0] : null;
    const second = first ? root.children[1] : null;
    const contentTypeNode = second && second.isSequence && second.children && second.children[0];
    const looksLikePfx = Boolean(first) && first.isUniversal(TAG.INTEGER) && Boolean(contentTypeNode) && contentTypeNode.isUniversal(TAG.OID) && contentTypeNode.oid().startsWith("1.2.840.113549.1.7.");
    if (!looksLikePfx) {
      // a certificate or a bare key is also a DER SEQUENCE: say what it is
      const isBareKey = Boolean(first) && first.isUniversal(TAG.INTEGER) && Boolean(second) && second.isSequence;
      const isCertificate = root.isSequence && root.children.length === 3 && root.children[0].isSequence && root.children[2].isUniversal(TAG.BIT_STRING);
      throw fail("CERT_NOT_PKCS12", { hint: isBareKey ? "private-key" : isCertificate ? "certificate" : null }, "a DER file that is not a PKCS#12 container");
    }
    const version = root.children[0].integerNumber();
    if (version !== 3) throw unsupported(`PKCS#12 version ${version}`);
    const authSafe = root.children[1];
    const contentType = authSafe.child(0).oid();
    if (contentType === OID.signedData) throw unsupported("PKCS#12 public-key integrity mode", "the file is protected with a public key (signed-data integrity mode), not with a password");
    if (contentType !== OID.data) throw fail("CERT_CORRUPT", {}, `unexpected PKCS#12 content type ${contentType}`);
    const authSafeBytes = authSafe.child(1, "authSafe content").child(0).octets();
    return { root, authSafeBytes, macData: root.children[2] || null };
  } catch (error) {
    if (isPdfEditorError(error) && !isAsn1Error(error)) throw error;
    throw fail("CERT_CORRUPT", {}, "the PKCS#12 structure is damaged", error);
  }
}

/** Finds the password form that reproduces the MAC. -> { candidate, label, weak } | throws CERT_WRONG_PASSWORD */
async function verifyMac(macData, authSafeBytes, candidates, work) {
  const digestInfo = macData.child(0);
  const macAlgorithm = digestInfo.child(0);
  const macOid = macAlgorithm.child(0).oid();
  const expected = digestInfo.child(1).octets();
  const salt = macData.child(1).octets();
  const iterations = macData.children[2] ? macData.children[2].integerNumber() : 1;
  if (macOid === OID.pbmac1) {
    const params = macAlgorithm.child(1, "PBMAC1 parameters");
    const kdf = readPbkdf2Params(params.child(0));
    const schemeOid = params.child(1).child(0).oid();
    const hash = HMAC_PRFS[schemeOid];
    if (!hash) throw unsupported(`PBMAC1 with ${algorithmName(schemeOid)}`);
    const label = `PBMAC1 (PBKDF2 HMAC-${kdf.hash}, ${kdf.iterations} iterations, HMAC-${hash})`;
    const seen = new Set();
    for (const candidate of candidates) {
      if (seen.has(candidate.utf8Id)) continue; // the same bytes as an earlier form
      seen.add(candidate.utf8Id);
      const key = await derivePbkdf2(work, kdf.hash, candidate, kdf.salt, kdf.iterations, kdf.keyLength || HASH_OUTPUT[hash]);
      const matches = equalBytes(await hmac(hash, key, authSafeBytes), expected);
      wipe(key);
      if (matches) return { candidate, label, weak: false };
    }
    throw fail("CERT_WRONG_PASSWORD", {}, "the integrity check of the file fails with this password");
  }
  const digestEntry = DIGESTS[macOid];
  const hash = digestEntry && digestEntry.webCrypto;
  if (!hash) throw unsupported(`MAC with ${digestEntry ? digestEntry.name : macOid}`);
  const label = `HMAC-${hash} (PKCS#12 KDF, ${iterations} iterations)`;
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.kdfId)) continue; // the same bytes as an earlier form
    seen.add(candidate.kdfId);
    const key = await deriveLegacy(work, hash, candidate, salt, 3, iterations, HASH_OUTPUT[hash]);
    const matches = equalBytes(await hmac(hash, key, authSafeBytes), expected);
    wipe(key);
    if (matches) return { candidate, label, weak: hash === "SHA-1" };
  }
  throw fail("CERT_WRONG_PASSWORD", {}, "the integrity check of the file fails with this password");
}

// Windows appends NUL characters to the friendly name it stores
const TRAILING_NULS = new RegExp(`${String.fromCharCode(0)}+$`);

function readBagAttributes(bag) {
  const attributes = { friendlyName: null, localKeyId: null };
  const set = bag.children[2];
  if (!set || !set.children) return attributes;
  for (const attribute of set.children) {
    const oid = attribute.child(0).oid();
    const values = attribute.child(1).children;
    const value = values && values[0];
    if (!value) continue;
    if (oid === OID.friendlyName) {
      attributes.friendlyName = (value.isUniversal(TAG.BMPString) ? utf16beDecode(value.content) : value.string()).replace(TRAILING_NULS, "");
    } else if (oid === OID.localKeyId) {
      attributes.localKeyId = Uint8Array.from(value.content);
    }
  }
  return attributes;
}

/**
 * Decrypts with the candidate that passed the MAC, or (file without MAC) with the first candidate whose
 * result is well-formed ASN.1. `part`: "private-key" | "certificates".
 */
async function decryptWith(pbe, data, state, part) {
  const tryList = state.candidate ? [state.candidate] : state.candidates;
  const tried = new Set();
  for (const candidate of tryList) {
    // forms of the password that give this scheme the same bytes give the same key: one attempt
    const formId = pbe.form === "utf8" ? candidate.utf8Id : candidate.kdfId;
    if (tried.has(formId)) continue;
    tried.add(formId);
    let plain;
    try {
      plain = await pbe.decrypt(candidate, data, state.work);
    } catch (error) {
      if (isPdfEditorError(error)) throw error;
      plain = null; // a cipher that rejects its input = wrong key
    }
    if (plain && plain.length > 1 && plain[0] === 0x30) {
      try {
        decode(plain);
        if (!state.candidate) state.candidate = candidate; // no MAC: the first working form is kept
        return plain;
      } catch {
        /* garbage that happened to have valid padding */
      }
    }
    wipe(plain);
  }
  if (state.macVerified) throw fail("CERT_DECRYPT_FAILED", { part }, `the password opens the file but not the ${part} inside it (a separate encryption password)`);
  throw fail("CERT_WRONG_PASSWORD", {}, "the content cannot be decrypted with this password");
}

async function readSafeContents(bytes, state, encryptedOuter, depth = 0) {
  if (depth > 8) throw fail("CERT_CORRUPT", {}, "SafeContents nested too deeply");
  const sequence = decode(bytes);
  for (const bag of sequence.children || []) {
    const bagId = bag.child(0).oid();
    const value = bag.child(1, "bag value").child(0);
    const attributes = readBagAttributes(bag);
    if (bagId === OID.certBag) {
      const certId = value.child(0).oid();
      if (certId !== OID.x509Certificate) {
        state.warnings.push(warning("CERT_PKCS12_ENTRY_IGNORED", { what: "certificate-type" }));
        continue;
      }
      // a copy: the decrypted SafeContents these bytes sit in is wiped after reading
      state.certificates.push({ der: Uint8Array.from(value.child(1).child(0).octets()), ...attributes });
      state.certEncryption.add(encryptedOuter ? encryptedOuter.label : "none");
      if (encryptedOuter && encryptedOuter.weak) state.weakEncryption = true;
    } else if (bagId === OID.keyBag) {
      state.keys.push({ pkcs8: Uint8Array.from(value.raw), ...attributes, encryption: "none", weak: false });
    } else if (bagId === OID.pkcs8ShroudedKeyBag) {
      const pbe = readPbeAlgorithm(value.child(0));
      const plain = await decryptWith(pbe, value.child(1).octets(), state, "private-key");
      state.keys.push({ pkcs8: plain, ...attributes, encryption: pbe.label, weak: pbe.weak });
    } else if (bagId === OID.safeContentsBag) {
      await readSafeContents(value.raw, state, encryptedOuter, depth + 1);
    } else {
      state.ignoredBags.push(bagId); // CRL bag, secret bag, vendor bags
    }
  }
}

async function readAuthenticatedSafe(authSafeBytes, state) {
  const safe = decode(authSafeBytes);
  for (const contentInfo of safe.children || []) {
    const type = contentInfo.child(0).oid();
    const content = contentInfo.child(1, "content").child(0);
    if (type === OID.data) {
      await readSafeContents(content.octets(), state, null);
    } else if (type === OID.encryptedData) {
      const encryptedContentInfo = content.child(1, "EncryptedContentInfo");
      const pbe = readPbeAlgorithm(encryptedContentInfo.child(1));
      const encrypted = encryptedContentInfo.children[2];
      if (!encrypted) continue;
      const plain = await decryptWith(pbe, encrypted.content, state, "certificates");
      try {
        await readSafeContents(plain, state, pbe);
      } finally {
        wipe(plain); // an encrypted SafeContents may hold key bags
      }
    } else if (type === OID.envelopedData) {
      throw unsupported("PKCS#12 public-key privacy mode", "part of the file is encrypted for a public key (enveloped-data privacy mode)");
    } else {
      throw fail("CERT_CORRUPT", {}, `unexpected content type ${type} inside the PKCS#12 file`);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// private key -> WebCrypto

/**
 * Facts about a PKCS#8 PrivateKeyInfo without importing it.
 * -> { algorithmOid, keyType, curveOid, curve, bits, rsaModulus, rsaExponent, ecPublicPoint, supported,
 *      reason: null | "rsa-pss-only" | "curve" | "explicit-curve" | "eddsa" | "dsa" | "unknown" }
 */
export function describePkcs8(pkcs8) {
  const root = decode(pkcs8);
  const algorithm = root.child(1, "privateKeyAlgorithm");
  const algorithmOid = algorithm.child(0).oid();
  const parameters = (algorithm.children && algorithm.children[1]) || null;
  const info = { algorithmOid, keyType: "unknown", curveOid: null, curve: null, bits: 0, supported: false, reason: null };
  if (algorithmOid === OID.rsaEncryption) {
    const rsa = decode(root.child(2).octets());
    info.keyType = "RSA";
    info.rsaModulus = Uint8Array.from(rsa.child(1).integerBytes());
    info.rsaExponent = Uint8Array.from(rsa.child(2).integerBytes());
    let modulus = info.rsaModulus;
    while (modulus.length > 1 && modulus[0] === 0) modulus = modulus.subarray(1);
    info.bits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]));
    info.supported = true;
  } else if (algorithmOid === OID.rsassaPss) {
    // WebCrypto only imports RSA keys marked rsaEncryption (measured: DataError in Chrome, Edge and Node)
    info.keyType = "RSA-PSS";
    info.reason = "rsa-pss-only";
  } else if (algorithmOid === OID.ecPublicKey) {
    info.keyType = "EC";
    if (parameters && parameters.isUniversal(TAG.OID)) {
      info.curveOid = parameters.oid();
      const curve = CURVES[info.curveOid];
      info.curve = curve ? curve.name : info.curveOid;
      info.bits = curve ? curve.bits : 0;
      info.supported = Boolean(curve && curve.webCrypto);
      if (!info.supported) info.reason = "curve";
    } else {
      info.curve = "explicit parameters";
      info.reason = "explicit-curve";
    }
    try {
      const ecPrivateKey = decode(root.child(2).octets());
      const publicKey = ecPrivateKey.context(1);
      if (publicKey) info.ecPublicPoint = Uint8Array.from(publicKey.child(0).bitString().bytes);
    } catch {
      /* the public point is optional */
    }
  } else if (algorithmOid === OID.ed25519 || algorithmOid === OID.ed448) {
    // imported by some browsers, but PDF readers do not validate EdDSA signatures
    info.keyType = algorithmOid === OID.ed25519 ? "Ed25519" : "Ed448";
    info.reason = "eddsa";
  } else if (algorithmOid === OID.dsa) {
    info.keyType = "DSA";
    info.reason = "dsa";
  } else {
    info.reason = "unknown";
  }
  return info;
}

const unsupportedKey = (facts, detail) => fail("CERT_UNSUPPORTED_KEY_TYPE", { keyType: facts.keyType, curve: facts.curve }, detail || `private key not usable in the browser (${facts.reason})`);

/**
 * Imports PKCS#8 bytes as a WebCrypto signing key.
 * RSA: RSASSA-PKCS1-v1_5; WebCrypto binds the hash to the key handle, so one handle per requested hash.
 * EC: ECDSA; one handle serves every hash.
 * -> { privateKey, privateKeysByHash, keyAlgorithm, facts }
 */
export async function importSigningKey(pkcs8, { hashes = ["SHA-256"], extractable = false } = {}) {
  const facts = describePkcs8(pkcs8);
  if (!facts.supported) throw unsupportedKey(facts);
  const privateKeysByHash = {};
  try {
    if (facts.keyType === "RSA") {
      for (const hash of hashes) {
        privateKeysByHash[hash] = await subtle().importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash }, extractable, ["sign"]);
      }
    } else {
      const key = await subtle().importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: facts.curve }, extractable, ["sign"]);
      for (const hash of hashes) privateKeysByHash[hash] = key;
    }
  } catch (error) {
    if (isPdfEditorError(error)) throw error;
    // the error name only: a WebCrypto message could describe the key
    throw unsupportedKey(facts, `the browser refused the private key (${(error && error.name) || "error"})`);
  }
  const privateKey = privateKeysByHash[hashes[0]];
  const keyAlgorithm = facts.keyType === "RSA"
    ? { type: "RSA", name: "RSASSA-PKCS1-v1_5", modulusLength: facts.bits, hashes: [...hashes], description: `RSA ${facts.bits}` }
    : { type: "EC", name: "ECDSA", namedCurve: facts.curve, hashes: [...hashes], description: `ECDSA ${facts.curve}`, signatureBytes: CURVES[facts.curveOid].bytes * 2 };
  return { privateKey, privateKeysByHash, keyAlgorithm, facts };
}

function unsignedEqual(a, b) {
  let x = a;
  let y = b;
  while (x.length > 1 && x[0] === 0) x = x.subarray(1);
  while (y.length > 1 && y[0] === 0) y = y.subarray(1);
  return equalBytes(x, y);
}

/** Does the certificate carry the public half of this private key? true | false | null (cannot tell without signing) */
function publicKeyMatches(keyFacts, cert) {
  const pub = cert.publicKey;
  if (keyFacts.keyType === "RSA") {
    if (pub.keyType !== "RSA" && pub.keyType !== "RSA-PSS") return false;
    return unsignedEqual(keyFacts.rsaModulus, pub.rsaModulus) && unsignedEqual(keyFacts.rsaExponent, pub.rsaExponent);
  }
  if (keyFacts.keyType === "EC") {
    if (pub.keyType !== "EC" || pub.curveOid !== keyFacts.curveOid) return false;
    if (!keyFacts.ecPublicPoint) return null;
    return equalBytes(keyFacts.ecPublicPoint, pub.ecPoint);
  }
  return null;
}

/** Signs a random challenge and verifies it with the certificate: proof that key and certificate belong together. */
async function proveKeyMatchesCertificate(imported, cert) {
  const hash = imported.keyAlgorithm.hashes[0];
  const challenge = randomBytes(32);
  const signature = await signData(imported.privateKey, hash, challenge);
  const algorithm = resolveSignatureAlgorithm(decode(signatureAlgorithmIdentifier(imported.privateKey, hash)));
  const result = await verifySignature(algorithm, cert.spki, signature, challenge);
  return result.ok === true;
}

// ------------------------------------------------------------------------------------------------
// public API: import

const describeIdentityKey = (facts) => (facts ? `${facts.keyType}${facts.bits ? ` ${facts.bits}` : ""}${facts.curve ? ` ${facts.curve}` : ""}` : "unreadable");

/**
 * Opens a PKCS#12 container.
 *
 * @param {Uint8Array} bytes               the .p12 / .pfx bytes
 * @param {string|null} password           "" (or null / undefined) when the file has no password
 * @param {object} [options]
 *   hashes: WebCrypto hash names the signing key must serve (default ["SHA-256"]); RSA handles are bound to
 *           one hash each
 *   identity: index into info.identities when the file holds several private keys (default: the first key
 *           whose certificate is currently valid, else the first key with a certificate)
 *   now: Date for the validity status
 *   signal: AbortSignal. The key derivation looks at it every few milliseconds (legacy containers) or before
 *           and after each run (PBKDF2, which is native); ALWAYS pass one from the interface.
 * Whatever the file asks for, the key derivation of one call is limited by KDF_LIMITS.workBudget (about 2.4 s
 * on the development machine); a file beyond it is CERT_CORRUPT.
 * @returns {Promise<{ privateKey: CryptoKey, privateKeysByHash: Record<string, CryptoKey>, keyAlgorithm: object,
 *                     certificate: Uint8Array, chain: Uint8Array[], info: object }>}
 * @throws PdfEditorError with a CERT_ code (see ./codes.js)
 */
export async function loadPkcs12(input, password, options = {}) {
  const bytes = asBytes(input);
  if (!bytes) throw fail("CERT_INVALID_OPTIONS", { field: "bytes" }, "loadPkcs12 needs the file as a Uint8Array");
  if (password != null && typeof password !== "string") throw fail("CERT_INVALID_OPTIONS", { field: "password" }, "the password must be a string");
  const hashes = options.hashes || ["SHA-256"];
  if (!Array.isArray(hashes) || !hashes.length || hashes.some((hash) => !HASH_OUTPUT[hash])) throw fail("CERT_INVALID_OPTIONS", { field: "hashes" });
  throwIfAborted(options.signal);
  const { authSafeBytes, macData } = parsePfx(bytes);
  subtle(); // SIGN_NO_WEBCRYPTO before any work
  const candidates = passwordCandidates(password);
  const state = {
    candidates, candidate: null, macVerified: false, keys: [], certificates: [], ignoredBags: [], warnings: [],
    certEncryption: new Set(), weakEncryption: false, work: createKdfWork(options.signal || null)
  };
  try {
    return await openContainer(authSafeBytes, macData, state, { ...options, hashes });
  } catch (error) {
    // whatever a damaged container makes the reader stumble over is reported as "damaged", never as a crash
    if (isPdfEditorError(error) && !isAsn1Error(error)) throw error;
    throw fail("CERT_CORRUPT", {}, "the PKCS#12 structure is damaged", isAsn1Error(error) ? error : undefined);
  } finally {
    // the decrypted PKCS#8 bytes and the password bytes are not needed once WebCrypto holds the key
    for (const key of state.keys) wipe(key.pkcs8);
    wipeKdfWork(state.work);
    wipeCandidates(candidates);
  }
}

async function openContainer(authSafeBytes, macData, state, options) {
  const { candidates } = state;
  const { hashes } = options;
  let integrity = "none";
  let weakIntegrity = false;
  if (macData) {
    const mac = await verifyMac(macData, authSafeBytes, candidates, state.work);
    state.candidate = mac.candidate;
    state.macVerified = true;
    integrity = mac.label;
    weakIntegrity = mac.weak;
  }
  await readAuthenticatedSafe(authSafeBytes, state);

  if (!state.keys.length) throw fail("CERT_NO_PRIVATE_KEY", {}, state.certificates.length ? "certificates but no private key" : "neither a private key nor a certificate");
  if (!state.certificates.length) throw fail("CERT_NO_CERTIFICATE", {}, "a private key but no certificate");

  const parsedCertificates = [];
  for (const entry of state.certificates) {
    try {
      parsedCertificates.push({ ...entry, parsed: parseCertificate(entry.der) });
    } catch {
      state.warnings.push(warning("CERT_PKCS12_ENTRY_IGNORED", { what: "unreadable-certificate" }));
    }
  }
  if (!parsedCertificates.length) throw fail("CERT_NO_CERTIFICATE", {}, "no readable certificate");

  // pair every key with its certificate: localKeyId first, public key comparison second
  const now = options.now || new Date();
  const identities = [];
  for (const key of state.keys) {
    let facts;
    try {
      facts = describePkcs8(key.pkcs8);
    } catch {
      identities.push({ key, facts: null, certificate: null, matchedBy: null });
      continue;
    }
    let match = null;
    let matchedBy = null;
    if (key.localKeyId) {
      const byId = parsedCertificates.filter((cert) => cert.localKeyId && equalBytes(cert.localKeyId, key.localKeyId));
      match = byId.find((cert) => publicKeyMatches(facts, cert.parsed) !== false) || null;
      if (match) matchedBy = "localKeyId";
    }
    if (!match) {
      match = parsedCertificates.find((cert) => publicKeyMatches(facts, cert.parsed) === true) || null;
      if (match) matchedBy = "publicKey";
    }
    if (!match && facts.keyType === "EC" && !facts.ecPublicPoint && state.keys.length === 1) {
      // EC key stored without its public point and without localKeyId: candidates = certificates on the
      // same curve; the test signature below confirms the pair
      match = parsedCertificates.find((cert) => publicKeyMatches(facts, cert.parsed) === null) || null;
      if (match) matchedBy = "curve";
    }
    identities.push({ key, facts, certificate: match, matchedBy });
  }

  const usable = identities.filter((identity) => identity.certificate);
  if (!usable.length) {
    const first = identities[0];
    if (first.facts && !first.facts.supported) throw unsupportedKey(first.facts);
    throw fail("CERT_KEY_CERTIFICATE_MISMATCH", {}, "none of the certificates in the file belongs to the private key");
  }
  let chosen;
  if (options.identity != null) {
    chosen = identities[options.identity];
    if (!chosen || !chosen.certificate) throw fail("CERT_KEY_CERTIFICATE_MISMATCH", {}, `identity ${options.identity} has no certificate in this file`);
  } else {
    const valid = (identity) => now >= identity.certificate.parsed.notBefore && now <= identity.certificate.parsed.notAfter;
    chosen = usable.find((identity) => identity.facts.supported && valid(identity)) || usable.find((identity) => identity.facts.supported) || usable[0];
  }
  if (!chosen.facts.supported) throw unsupportedKey(chosen.facts);

  const imported = await importSigningKey(chosen.key.pkcs8, { hashes, extractable: false });
  if (!(await proveKeyMatchesCertificate(imported, chosen.certificate.parsed))) {
    throw fail("CERT_KEY_CERTIFICATE_MISMATCH", {}, "the private key does not match the certificate stored with it (a test signature does not verify)");
  }

  const leaf = chosen.certificate.parsed;
  const ordered = await orderChain(leaf, parsedCertificates.map((cert) => cert.parsed));
  const facts = await certificateFacts(leaf, { now, role: "signer" });
  const warnings = [...state.warnings];
  if (chosen.key.weak || state.weakEncryption) warnings.push(warning("CERT_PKCS12_WEAK_ENCRYPTION"));
  if (chosen.key.encryption === "none") warnings.push(warning("CERT_PKCS12_KEY_UNENCRYPTED"));
  if (!macData) warnings.push(warning("CERT_PKCS12_NO_MAC"));
  if (state.candidate && state.candidate.legacy) warnings.push(warning("CERT_PKCS12_LEGACY_PASSWORD"));

  return {
    privateKey: imported.privateKey,
    privateKeysByHash: imported.privateKeysByHash,
    keyAlgorithm: imported.keyAlgorithm,
    certificate: Uint8Array.from(leaf.der),
    chain: ordered.chain.map((cert) => Uint8Array.from(cert.der)),
    info: {
      friendlyName: chosen.key.friendlyName || chosen.certificate.friendlyName || null,
      certificate: facts,
      chainComplete: ordered.complete,
      chainLinks: ordered.links,
      chainSubjects: ordered.chain.map((cert) => cert.subject.text),
      extraCertificates: ordered.extras.map((cert) => cert.subject.text),
      certificateCount: parsedCertificates.length,
      keyCount: state.keys.length,
      identities: identities.map((identity, index) => ({
        index,
        selected: identity === chosen,
        keyType: describeIdentityKey(identity.facts),
        supported: Boolean(identity.facts && identity.facts.supported),
        unsupportedReason: identity.facts ? identity.facts.reason : "unreadable",
        friendlyName: identity.key.friendlyName || (identity.certificate && identity.certificate.friendlyName) || null,
        subject: identity.certificate ? identity.certificate.parsed.subject.text : null,
        notAfter: identity.certificate ? identity.certificate.parsed.notAfter.toISOString() : null,
        matchedBy: identity.matchedBy || null
      })),
      matchedBy: chosen.matchedBy,
      integrity,
      weakIntegrity,
      keyEncryption: chosen.key.encryption,
      certificateEncryption: [...state.certEncryption],
      passwordForm: state.candidate ? state.candidate.form : "not-needed",
      ignoredBags: state.ignoredBags,
      warnings
    }
  };
}

// ------------------------------------------------------------------------------------------------
// public API: export

function bagAttributes(friendlyName, localKeyId) {
  const attributes = [];
  if (friendlyName) attributes.push(der.seq(der.oid(OID.friendlyName), der.set(der.bmp(friendlyName))));
  if (localKeyId) attributes.push(der.seq(der.oid(OID.localKeyId), der.set(der.octets(localKeyId))));
  return attributes.length ? der.setOf(attributes) : null;
}

async function encryptPbe(profile, candidate, plain, iterations) {
  if (profile === "aes256") {
    const salt = randomBytes(16);
    const iv = randomBytes(16);
    const key = await pbkdf2("SHA-256", candidate.utf8, salt, iterations, 32);
    const encrypted = await aesCbc(false, key, iv, plain);
    wipe(key);
    if (!encrypted) throw fail("SIGN_INTERNAL", { check: "pkcs12-encrypt" }, "AES encryption failed");
    const algorithm = der.seq(
      der.oid(OID.pbes2),
      der.seq(
        der.seq(der.oid(OID.pbkdf2), der.seq(der.octets(salt), der.int(iterations), der.int(32), der.seq(der.oid(OID.hmacWithSHA256), der.nul()))),
        der.seq(der.oid(OID.aes256Cbc), der.octets(iv))
      )
    );
    return { algorithm, encrypted };
  }
  const salt = randomBytes(8);
  const key = await pkcs12Kdf("SHA-1", candidate.kdf, salt, 1, iterations, 24);
  const iv = await pkcs12Kdf("SHA-1", candidate.kdf, salt, 2, iterations, 8);
  const encrypted = tripleDesCbc(false, key, iv, plain);
  wipe(key);
  if (!encrypted) throw fail("SIGN_INTERNAL", { check: "pkcs12-encrypt" }, "Triple-DES encryption failed");
  const algorithm = der.seq(der.oid(OID.pbeSha13Des), der.seq(der.octets(salt), der.int(iterations)));
  return { algorithm, encrypted };
}

/**
 * Builds a PKCS#12 container.
 *
 * @param {object} p
 *   privateKeyPkcs8: Uint8Array  PKCS#8 PrivateKeyInfo (RSA or EC), e.g. from crypto.subtle.exportKey("pkcs8")
 *   certificates: Uint8Array[]   DER, the certificate of the key FIRST, then its chain
 *   password: string             may be "" (still encrypted, with the empty password)
 *   friendlyName: string
 *   profile: "3des" | "aes256"
 *       "3des"   pbeWithSHAAnd3-KeyTripleDES-CBC for key and certificates, HMAC-SHA1 MAC. What Windows writes
 *                by default and what every reader understands.
 *       "aes256" PBES2 (PBKDF2 HMAC-SHA256 + AES-256-CBC), HMAC-SHA256 MAC. The OpenSSL 3 default profile.
 *   iterations: number (default 2048 for "3des", 10000 for "aes256")
 */
export async function createPkcs12({ privateKeyPkcs8, certificates, password = "", friendlyName = null, profile = "3des", iterations = null, localKeyId: withLocalKeyId = true }) {
  if (profile !== "3des" && profile !== "aes256") throw fail("CERT_INVALID_OPTIONS", { field: "p12Profile" }, `unknown PKCS#12 profile "${profile}"`);
  if (!Array.isArray(certificates) || !certificates.length) throw fail("CERT_INVALID_OPTIONS", { field: "certificates" }, "createPkcs12 needs at least the certificate of the key");
  if (!(privateKeyPkcs8 instanceof Uint8Array)) throw fail("CERT_INVALID_OPTIONS", { field: "privateKeyPkcs8" });
  const count = iterations || (profile === "aes256" ? 10000 : 2048);
  // the password is stored in NFC, the form Windows and macOS keyboards produce for Vietnamese
  const text = String(password == null ? "" : password).normalize("NFC");
  const candidate = { kdf: concatBytes(utf16beEncode(text), Uint8Array.of(0, 0)), utf8: utf8Encode(text) };
  try {
    // localKeyId ties the key bag to its certificate bag (SHA-1 of the certificate, as OpenSSL does)
    const localKeyId = withLocalKeyId ? new Uint8Array(await subtle().digest("SHA-1", certificates[0])) : null;

    // certificates: one encrypted SafeContents
    const certBags = certificates.map((certificate, index) => der.seq(
      der.oid(OID.certBag),
      der.ctx(0, der.seq(der.oid(OID.x509Certificate), der.ctx(0, der.octets(certificate)))),
      index === 0 ? bagAttributes(friendlyName, localKeyId) : null
    ));
    const certSafe = await encryptPbe(profile, candidate, der.seq(...certBags), count);
    const certContentInfo = der.seq(
      der.oid(OID.encryptedData),
      der.ctx(0, der.seq(der.int(0), der.seq(der.oid(OID.data), certSafe.algorithm, der.ctxPrimitive(0, certSafe.encrypted))))
    );

    // key: one shrouded key bag in a plain SafeContents
    const shrouded = await encryptPbe(profile, candidate, privateKeyPkcs8, count);
    const keyBag = der.seq(
      der.oid(OID.pkcs8ShroudedKeyBag),
      der.ctx(0, der.seq(shrouded.algorithm, der.octets(shrouded.encrypted))),
      bagAttributes(friendlyName, localKeyId)
    );
    const keyContentInfo = der.seq(der.oid(OID.data), der.ctx(0, der.octets(der.seq(keyBag))));

    const authSafe = der.seq(certContentInfo, keyContentInfo);
    const macHash = profile === "aes256" ? "SHA-256" : "SHA-1";
    const macSalt = randomBytes(profile === "aes256" ? 16 : 8);
    const macKey = await pkcs12Kdf(macHash, candidate.kdf, macSalt, 3, count, HASH_OUTPUT[macHash]);
    const mac = await hmac(macHash, macKey, authSafe);
    wipe(macKey);
    const macData = der.seq(
      der.seq(der.seq(der.oid(macHash === "SHA-256" ? OID.sha256 : OID.sha1), der.nul()), der.octets(mac)),
      der.octets(macSalt),
      der.int(count)
    );
    return der.seq(der.int(3), der.seq(der.oid(OID.data), der.ctx(0, der.octets(authSafe))), macData);
  } finally {
    wipeCandidates([candidate]);
  }
}
