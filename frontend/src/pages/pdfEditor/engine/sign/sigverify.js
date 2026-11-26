// WebCrypto glue: the one accessor of crypto.subtle, digests, SubjectPublicKeyInfo facts, signature
// verification (RSA PKCS#1 v1.5, RSASSA-PSS, ECDSA, Ed25519), signing with a CryptoKey, and the ECDSA
// signature format conversion that CMS / X.509 need. Browser + Node.

import { PdfEditorError } from "../errors.js";
import { asn1Error, decode, der, TAG } from "./asn1.js";
import { bitLength, concatBytes } from "./bytes.js";
import { CURVES, DIGESTS, OID, SIGNATURE_ALGORITHMS } from "./oids.js";

/** crypto.subtle, or SIGN_NO_WEBCRYPTO: it exists only in a secure context (https or localhost). */
export function subtle() {
  const api = globalThis.crypto && globalThis.crypto.subtle;
  if (!api) throw new PdfEditorError("SIGN_NO_WEBCRYPTO", {}, { detail: "crypto.subtle is not available: the page must be served over HTTPS or from localhost" });
  return api;
}

/**
 * Digest with WebCrypto. `hashName` is a WebCrypto name ("SHA-256"). Several chunks (or an array of chunks)
 * are hashed as one message; WebCrypto has no incremental hashing, so they are joined first.
 */
export async function digest(hashName, ...chunks) {
  const data = chunks.length === 1 && chunks[0] instanceof Uint8Array ? chunks[0] : concatBytes(chunks);
  return new Uint8Array(await subtle().digest(hashName, data));
}

/** DER ECDSA-Sig-Value (SEQUENCE { r INTEGER, s INTEGER }) -> IEEE P1363 r||s, each `size` bytes (WebCrypto form). */
export function ecdsaDerToP1363(derSignature, size) {
  const sequence = decode(derSignature);
  if (!sequence.isSequence || sequence.children.length !== 2) throw asn1Error("ecdsa-signature", sequence.start, "ECDSA signature is not SEQUENCE { r, s }");
  const out = new Uint8Array(size * 2);
  sequence.children.forEach((child, index) => {
    let value = child.integerBytes();
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw asn1Error("ecdsa-signature", child.start, "ECDSA signature value larger than the curve order");
    out.set(value, size * (index + 1) - value.length);
  });
  return out;
}

/** IEEE P1363 r||s (what crypto.subtle.sign returns for ECDSA) -> DER ECDSA-Sig-Value (what CMS and X.509 carry). */
export function ecdsaP1363ToDer(raw) {
  if (raw.length === 0 || raw.length % 2) throw asn1Error("ecdsa-signature", null, "ECDSA r||s signature must have an even length");
  const half = raw.length / 2;
  return der.seq(der.intFromBytes(raw.subarray(0, half)), der.intFromBytes(raw.subarray(half)));
}

/**
 * Facts about a SubjectPublicKeyInfo.
 * -> { algorithmOid, keyType: "RSA" | "RSA-PSS" | "EC" | "Ed25519" | "Ed448" | "DSA" | "unknown", bits,
 *      curveOid, curve, rsaModulus, rsaExponent, ecPoint, publicKeyBytes, webCrypto: boolean }
 */
export function parseSpki(spkiDer) {
  const spki = decode(spkiDer);
  const algorithm = spki.child(0, "SubjectPublicKeyInfo.algorithm");
  const algorithmOid = algorithm.child(0).oid();
  const parameters = (algorithm.children && algorithm.children[1]) || null;
  const publicKeyBytes = spki.child(1, "subjectPublicKey").bitString().bytes;
  const info = { algorithmOid, keyType: "unknown", bits: 0, curveOid: null, curve: null, publicKeyBytes, webCrypto: false };
  if (algorithmOid === OID.rsaEncryption || algorithmOid === OID.rsassaPss) {
    const rsa = decode(publicKeyBytes);
    info.keyType = algorithmOid === OID.rsassaPss ? "RSA-PSS" : "RSA";
    info.rsaModulus = rsa.child(0).integerBytes();
    info.rsaExponent = rsa.child(1).integerBytes();
    info.bits = bitLength(info.rsaModulus);
    info.webCrypto = true; // an RSA-PSS-only key is verified through a rewritten SPKI (see verifySignature)
  } else if (algorithmOid === OID.ecPublicKey) {
    info.keyType = "EC";
    info.ecPoint = publicKeyBytes;
    if (parameters && parameters.isUniversal(TAG.OID)) {
      info.curveOid = parameters.oid();
      const curve = CURVES[info.curveOid];
      info.curve = curve ? curve.name : info.curveOid;
      info.bits = curve ? curve.bits : Math.floor((publicKeyBytes.length - 1) / 2) * 8;
      info.webCrypto = Boolean(curve && curve.webCrypto);
    } else {
      info.curve = "explicit parameters";
      info.bits = Math.floor((publicKeyBytes.length - 1) / 2) * 8;
    }
  } else if (algorithmOid === OID.ed25519) {
    info.keyType = "Ed25519";
    info.bits = 255;
    info.webCrypto = true; // where the runtime implements it (probed at use)
  } else if (algorithmOid === OID.ed448) {
    info.keyType = "Ed448";
    info.bits = 448;
  } else if (algorithmOid === OID.dsa) {
    info.keyType = "DSA";
    try {
      info.bits = bitLength(parameters.child(0).integerBytes());
    } catch {
      /* parameters may be absent (inherited) */
    }
  }
  return info;
}

/** RSASSA-PSS-params (RFC 4055) -> { hash, mgfHash, saltLength }. Missing fields take the ASN.1 defaults. */
export function parsePssParameters(node) {
  const out = { hash: "SHA-1", mgfHash: "SHA-1", saltLength: 20, trailerField: 1 };
  if (!node || !node.isSequence) return out;
  for (const field of node.children) {
    if (field.isContext(0)) {
      const oid = field.child(0).child(0).oid();
      out.hash = DIGESTS[oid] ? DIGESTS[oid].name : oid;
    } else if (field.isContext(1)) {
      const inner = field.child(0).children ? field.child(0).children[1] : null;
      const entry = inner && inner.isSequence ? DIGESTS[inner.child(0).oid()] : null;
      out.mgfHash = entry ? entry.name : "unknown";
    } else if (field.isContext(2)) {
      out.saltLength = field.child(0).integerNumber();
    } else if (field.isContext(3)) {
      out.trailerField = field.child(0).integerNumber();
    }
  }
  return out;
}

/**
 * AlgorithmIdentifier of a signature -> { oid, name, scheme, hash, weak, pss }.
 * `digestOid` is the digest algorithm announced next to it (CMS SignerInfo.digestAlgorithm); it decides the
 * hash when the signature OID does not (rsaEncryption, id-ecPublicKey). `name` is a technical label.
 */
export function resolveSignatureAlgorithm(algorithmIdentifier, digestOid = null) {
  const oid = algorithmIdentifier.child(0).oid();
  const known = SIGNATURE_ALGORITHMS[oid];
  const digestInfo = digestOid ? DIGESTS[digestOid] : null;
  if (!known) return { oid, name: oid, scheme: "unknown", hash: digestInfo ? digestInfo.name : null, weak: false };
  const out = { oid, name: known.name, scheme: known.scheme, hash: known.hash, weak: Boolean(known.weak) };
  if (known.scheme === "rsa-pss") {
    out.pss = parsePssParameters(algorithmIdentifier.children[1]);
    out.hash = out.pss.hash;
    out.name = `RSASSA-PSS (${out.pss.hash}, MGF1 ${out.pss.mgfHash}, salt ${out.pss.saltLength})`;
  } else if (!out.hash && known.scheme !== "eddsa") {
    out.hash = digestInfo ? digestInfo.name : null;
    if (digestInfo) out.name = `${known.name} with ${digestInfo.name}`;
  }
  if (out.hash === "SHA-1" || out.hash === "MD5" || out.hash === "MD2") out.weak = true;
  return out;
}

const WEBCRYPTO_HASHES = new Set(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]);
const HASH_BYTES = { "SHA-1": 20, "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 };

/** SPKI of an RSA-PSS-only key rewritten as rsaEncryption so that WebCrypto imports it. */
function rsaSpkiAsRsaEncryption(spkiDer) {
  const spki = decode(spkiDer);
  return der.seq(der.seq(der.oid(OID.rsaEncryption), der.nul()), spki.child(1).raw);
}

const cannot = (reason, name = null) => ({ ok: null, unsupported: { reason, name } });

/**
 * Verifies `signature` over `data` with the public key in `spkiDer`.
 * algorithm: result of resolveSignatureAlgorithm().
 * -> { ok: true } | { ok: false, reason? } | { ok: null, unsupported: { reason, name } }
 *    unsupported.reason: "key" | "hash" | "pss-mgf" | "curve" | "algorithm" | "webcrypto". Never throws for
 *    cryptographic reasons (only SIGN_NO_WEBCRYPTO when there is no crypto.subtle at all).
 */
export async function verifySignature(algorithm, spkiDer, signature, data) {
  let key;
  try {
    key = parseSpki(spkiDer);
  } catch {
    return cannot("key");
  }
  const api = subtle();
  const { scheme, hash } = algorithm;
  try {
    if (scheme === "rsa-pkcs1" || scheme === "rsa-pss") {
      if (key.keyType !== "RSA" && key.keyType !== "RSA-PSS") return { ok: false, reason: "key-type" };
      if (!WEBCRYPTO_HASHES.has(hash)) return cannot("hash", hash || "unknown");
      const spki = key.keyType === "RSA-PSS" ? rsaSpkiAsRsaEncryption(spkiDer) : spkiDer;
      if (scheme === "rsa-pkcs1") {
        const publicKey = await api.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
        return { ok: await api.verify({ name: "RSASSA-PKCS1-v1_5" }, publicKey, signature, data) };
      }
      const pss = algorithm.pss || { mgfHash: hash, saltLength: 20 };
      if (pss.mgfHash !== hash) return cannot("pss-mgf", pss.mgfHash);
      const publicKey = await api.importKey("spki", spki, { name: "RSA-PSS", hash }, false, ["verify"]);
      return { ok: await api.verify({ name: "RSA-PSS", saltLength: pss.saltLength }, publicKey, signature, data) };
    }
    if (scheme === "ecdsa") {
      if (key.keyType !== "EC") return { ok: false, reason: "key-type" };
      const curve = CURVES[key.curveOid];
      if (!curve || !curve.webCrypto) return cannot("curve", key.curve);
      if (!WEBCRYPTO_HASHES.has(hash)) return cannot("hash", hash || "unknown");
      let raw;
      try {
        raw = ecdsaDerToP1363(signature, curve.bytes);
      } catch {
        return { ok: false, reason: "malformed" };
      }
      const publicKey = await api.importKey("spki", spkiDer, { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
      return { ok: await api.verify({ name: "ECDSA", hash }, publicKey, raw, data) };
    }
    if (scheme === "eddsa" && key.keyType === "Ed25519") {
      const publicKey = await api.importKey("spki", spkiDer, { name: "Ed25519" }, false, ["verify"]);
      return { ok: await api.verify({ name: "Ed25519" }, publicKey, signature, data) };
    }
    return cannot("algorithm", algorithm.name);
  } catch (error) {
    return cannot("webcrypto", (error && error.name) || "Error");
  }
}

/**
 * Signs `data` with a WebCrypto private key and returns the signature in the form CMS / X.509 carry:
 * RSA: the PKCS#1 v1.5 signature as it is; ECDSA: DER ECDSA-Sig-Value (WebCrypto returns r||s).
 * An RSA handle is bound to ONE hash at import: asking for another one is SIGN_BAD_SIGNER.
 */
export async function signData(privateKey, hashName, data) {
  const algorithm = (privateKey && privateKey.algorithm) || {};
  const name = algorithm.name;
  if (name === "RSASSA-PKCS1-v1_5") {
    if (!algorithm.hash || algorithm.hash.name !== hashName) {
      throw new PdfEditorError("SIGN_BAD_SIGNER", { reason: "hash-binding" }, { detail: `this RSA key handle is bound to ${algorithm.hash && algorithm.hash.name}, not ${hashName} (WebCrypto fixes the hash at import)` });
    }
    return new Uint8Array(await subtle().sign({ name }, privateKey, data));
  }
  if (name === "ECDSA") {
    if (!HASH_BYTES[hashName]) throw new PdfEditorError("SIGN_BAD_SIGNER", { reason: "hash-binding" }, { detail: `unsupported hash ${hashName}` });
    const raw = new Uint8Array(await subtle().sign({ name, hash: hashName }, privateKey, data));
    return ecdsaP1363ToDer(raw);
  }
  throw new PdfEditorError("SIGN_BAD_SIGNER", { reason: "key-algorithm" }, { detail: `unsupported key algorithm for signing: ${name}` });
}

const RSA_SIGNATURE_OIDS = { "SHA-1": "1.2.840.113549.1.1.5", "SHA-256": "1.2.840.113549.1.1.11", "SHA-384": "1.2.840.113549.1.1.12", "SHA-512": "1.2.840.113549.1.1.13" };
const ECDSA_SIGNATURE_OIDS = { "SHA-1": "1.2.840.10045.4.1", "SHA-256": "1.2.840.10045.4.3.2", "SHA-384": "1.2.840.10045.4.3.3", "SHA-512": "1.2.840.10045.4.3.4" };

/** Signature AlgorithmIdentifier (DER) that matches signData() for the given key and hash (X.509 form). */
export function signatureAlgorithmIdentifier(privateKey, hashName) {
  const name = privateKey && privateKey.algorithm && privateKey.algorithm.name;
  if (name === "RSASSA-PKCS1-v1_5" && RSA_SIGNATURE_OIDS[hashName]) return der.seq(der.oid(RSA_SIGNATURE_OIDS[hashName]), der.nul());
  // parameters MUST be absent for ecdsa-with-SHA2 (RFC 5758)
  if (name === "ECDSA" && ECDSA_SIGNATURE_OIDS[hashName]) return der.seq(der.oid(ECDSA_SIGNATURE_OIDS[hashName]));
  throw new PdfEditorError("SIGN_BAD_SIGNER", { reason: "key-algorithm" }, { detail: `unsupported key algorithm: ${name} with ${hashName}` });
}
