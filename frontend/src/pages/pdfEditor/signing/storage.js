// What the signing feature keeps on this device, in localStorage (tests/pdfSigningStorage.test.mjs run it
// with an injected storage):
//
//   saved signature pictures   at most 10 small transparent PNGs (data URLs). localStorage is enough: a
//                              picture is scaled down before it is saved (signatureImages.js) and refused above
//                              MAX_SIGNATURE_CHARS, so the ten of them stay below 2 million characters
//   trusted certificates       PUBLIC certificates only (DER, base64) that the user decided to trust: an
//                              authority or a signer. Passed to inspectSignatures as trustedCertificates
//
// Never here: a private key, a .p12 file, a password. What comes back from storage is checked like any
// foreign input (the shapes, the size, that a certificate really starts like one); a broken entry is dropped.

export const SAVED_SIGNATURES_KEY = "pdfx.signatures.v1";
export const TRUSTED_CERTIFICATES_KEY = "pdfx.trustedCertificates.v1";
export const MAX_SAVED_SIGNATURES = 10;
/** Longest data URL of a saved signature (characters): about 135 kB of PNG. */
export const MAX_SIGNATURE_CHARS = 180000;
export const MAX_TRUSTED_CERTIFICATES = 50;
/** No real certificate is larger than this (bytes); storage is not a place for anything else. */
export const MAX_CERTIFICATE_BYTES = 16384;
const PNG_PREFIX = "data:image/png;base64,";
export const SIGNATURE_KINDS = Object.freeze(["draw", "type", "upload"]);

export function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // storage switched off (private mode, a sandboxed frame)
  }
}

function readList(storage, key) {
  try {
    const raw = storage?.getItem(key);
    const value = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeList(storage, key, list) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false; // quota, or storage that refuses to write
  }
}

// --- base64 (no Buffer in src/) --------------------------------------------------------------------------------

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

/** @returns {Uint8Array | null} null for text that is not base64 */
export function base64ToBytes(text) {
  try {
    const binary = atob(String(text).replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export const pngDataUrl = (bytes) => `${PNG_PREFIX}${bytesToBase64(bytes)}`;

/** The bytes of a PNG data URL, or null when it is not one. */
export function pngBytesOfDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_PREFIX)) return null;
  const bytes = base64ToBytes(dataUrl.slice(PNG_PREFIX.length));
  // 137 80 78 71: the PNG signature
  return bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? bytes : null;
}

function createShelf(storage, key, { read, limit }) {
  const listeners = new Set();
  let cache = null;
  const load = () => {
    if (!cache) cache = Object.freeze(readList(storage, key).map(read).filter(Boolean).slice(0, limit));
    return cache;
  };
  const save = (next) => {
    const stored = writeList(storage, key, next);
    // without storage (or with a full one) the list still lasts for this page
    cache = Object.freeze(next);
    for (const listener of [...listeners]) listener();
    return stored;
  };
  return {
    load,
    save,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Reads the storage again (another tab may have changed it). */
    refresh() {
      cache = null;
      for (const listener of [...listeners]) listener();
    }
  };
}

// --- saved signature pictures -----------------------------------------------------------------------------------

function readSignature(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { id, dataUrl, width, height, kind, savedAt } = entry;
  if (typeof id !== "string" || !id || typeof dataUrl !== "string" || dataUrl.length > MAX_SIGNATURE_CHARS) return null;
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return null;
  if (!pngBytesOfDataUrl(dataUrl)) return null;
  return Object.freeze({ id, dataUrl, width, height, kind: SIGNATURE_KINDS.includes(kind) ? kind : "draw", savedAt: Number.isFinite(savedAt) ? savedAt : 0 });
}

/**
 * The saved signature pictures of this device.
 * @param {Storage | null} [storage]   default: localStorage
 * @param {{ now?: () => number, makeId?: () => string }} [options]
 * @returns {{
 *   list(): ReadonlyArray<{ id, dataUrl, width, height, kind, savedAt }>,      newest first; the same array while nothing changed
 *   add(picture: { dataUrl, width, height, kind }): { ok: true, id, stored: boolean } | { ok: false, reason: "invalid" | "too-large" | "full" },
 *   remove(id: string): boolean,
 *   isFull(): boolean,
 *   subscribe(listener): () => void
 * }}
 *   stored: false = the picture is listed for this page only (storage is switched off or full).
 */
export function createSignatureShelf(storage = browserStorage(), { now = () => Date.now(), makeId = () => `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` } = {}) {
  const shelf = createShelf(storage, SAVED_SIGNATURES_KEY, { read: readSignature, limit: MAX_SAVED_SIGNATURES });
  return {
    list: shelf.load,
    isFull: () => shelf.load().length >= MAX_SAVED_SIGNATURES,
    add(picture) {
      if (typeof picture?.dataUrl === "string" && picture.dataUrl.length > MAX_SIGNATURE_CHARS) return { ok: false, reason: "too-large" };
      const entry = readSignature({ ...picture, id: makeId(), savedAt: now() });
      if (!entry) return { ok: false, reason: "invalid" };
      const current = shelf.load();
      const same = current.find((other) => other.dataUrl === entry.dataUrl);
      if (same) return { ok: true, id: same.id, stored: true };
      if (current.length >= MAX_SAVED_SIGNATURES) return { ok: false, reason: "full" };
      const stored = shelf.save([entry, ...current]);
      return { ok: true, id: entry.id, stored };
    },
    remove(id) {
      const current = shelf.load();
      if (!current.some((entry) => entry.id === id)) return false;
      shelf.save(current.filter((entry) => entry.id !== id));
      return true;
    },
    subscribe: shelf.subscribe,
    refresh: shelf.refresh
  };
}

// --- trusted certificates ---------------------------------------------------------------------------------------

function readTrusted(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { id, der, subject, issuer, notBefore, notAfter, isCa, selfSigned, addedAt } = entry;
  if (typeof id !== "string" || !/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(id) || typeof der !== "string") return null;
  const bytes = base64ToBytes(der);
  // a certificate is a DER SEQUENCE; anything else has no business in this list
  if (!bytes || bytes.length < 64 || bytes.length > MAX_CERTIFICATE_BYTES || bytes[0] !== 0x30) return null;
  const text = (value) => (typeof value === "string" ? value.slice(0, 300) : "");
  return Object.freeze({
    id,
    der,
    subject: text(subject),
    issuer: text(issuer),
    notBefore: text(notBefore),
    notAfter: text(notAfter),
    isCa: Boolean(isCa),
    selfSigned: Boolean(selfSigned),
    addedAt: Number.isFinite(addedAt) ? addedAt : 0
  });
}

/**
 * One entry of the trust list from what engine/sign certificateFacts() says about a certificate.
 * @param {Uint8Array} der      the certificate (DER)
 * @param {object} facts        certificateFacts(der)
 */
export function trustedEntry(der, facts, addedAt = Date.now()) {
  return {
    id: String(facts?.fingerprintSha256 || "").toUpperCase(),
    der: bytesToBase64(der),
    subject: String(facts?.displayName || facts?.subject?.text || ""),
    issuer: String(facts?.issuerDisplayName || facts?.issuer?.text || ""),
    notBefore: String(facts?.notBefore || ""),
    notAfter: String(facts?.notAfter || ""),
    isCa: Boolean(facts?.isCa),
    selfSigned: Boolean(facts?.selfSigned),
    addedAt
  };
}

/**
 * The certificates the user trusts on this device.
 * @returns {{
 *   list(): ReadonlyArray<{ id (SHA-256 fingerprint "AA:BB:..."), der (base64), subject, issuer, notBefore, notAfter, isCa, selfSigned, addedAt }>,
 *   add(entry): { ok: true, id, added: boolean, stored: boolean } | { ok: false, reason: "invalid" | "full" },   added: false = it was there already
 *   remove(id): boolean,
 *   certificates(): Uint8Array[],      DER, for inspectSignatures({ trustedCertificates })
 *   subscribe(listener): () => void
 * }}
 */
export function createTrustList(storage = browserStorage()) {
  const shelf = createShelf(storage, TRUSTED_CERTIFICATES_KEY, { read: readTrusted, limit: MAX_TRUSTED_CERTIFICATES });
  return {
    list: shelf.load,
    add(candidate) {
      const entry = readTrusted(candidate);
      if (!entry) return { ok: false, reason: "invalid" };
      const current = shelf.load();
      if (current.some((other) => other.id === entry.id)) return { ok: true, id: entry.id, added: false, stored: true };
      if (current.length >= MAX_TRUSTED_CERTIFICATES) return { ok: false, reason: "full" };
      const stored = shelf.save([...current, entry]);
      return { ok: true, id: entry.id, added: true, stored };
    },
    remove(id) {
      const current = shelf.load();
      if (!current.some((entry) => entry.id === id)) return false;
      shelf.save(current.filter((entry) => entry.id !== id));
      return true;
    },
    certificates: () => shelf.load().map((entry) => base64ToBytes(entry.der)).filter(Boolean),
    subscribe: shelf.subscribe,
    refresh: shelf.refresh
  };
}

// --- reading certificate files -----------------------------------------------------------------------------------

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([A-Za-z0-9+/=\s]+)-----END \1-----/g;

/**
 * The certificates of a .cer / .crt / .pem file as DER arrays. Only blocks labelled CERTIFICATE are taken
 * from a PEM file: a private key that travels in the same file is never read, let alone stored.
 * @param {Uint8Array} bytes
 * @returns {{ certificates: Uint8Array[], hasPrivateKey: boolean, kind: "pem" | "der" | "pkcs12" | "unknown" }}
 */
export function certificatesOfFile(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return { certificates: [], hasPrivateKey: false, kind: "unknown" };
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (head.includes("-----BEGIN ")) {
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    const certificates = [];
    let hasPrivateKey = false;
    for (const match of text.matchAll(PEM_BLOCK)) {
      if (match[1].includes("PRIVATE KEY")) hasPrivateKey = true;
      if (match[1] !== "CERTIFICATE" && match[1] !== "X509 CERTIFICATE" && match[1] !== "TRUSTED CERTIFICATE") continue;
      const der = base64ToBytes(match[2]);
      if (der && der[0] === 0x30) certificates.push(der);
    }
    return { certificates, hasPrivateKey, kind: "pem" };
  }
  if (bytes[0] !== 0x30) return { certificates: [], hasPrivateKey: false, kind: "unknown" };
  // DER. A PKCS#12 container and a private key start SEQUENCE { INTEGER ... }; a certificate starts SEQUENCE { SEQUENCE ...
  const lengthBytes = bytes[1] & 0x80 ? bytes[1] & 0x7f : 0;
  const first = bytes[2 + lengthBytes];
  if (first === 0x02) return { certificates: [], hasPrivateKey: true, kind: "pkcs12" };
  if (first !== 0x30) return { certificates: [], hasPrivateKey: false, kind: "unknown" };
  return { certificates: [bytes], hasPrivateKey: false, kind: "der" };
}
