// The signing identity of this tab: the certificate and the handle of its private key.
//
// It lives in the variables of THIS MODULE and nowhere else: not in React state, not in a store, not in
// localStorage or IndexedDB (engine/sign: the private key is a non-extractable CryptoKey; a browser would
// write such a key to disk in clear text if it were put into IndexedDB). The interface only ever sees the
// summary below, which holds facts about the certificate and no key. The identity stays until "Forget this
// certificate" or until the tab is closed, so that several documents can be signed in a row.
//
// A self-signed certificate that was just created also keeps its password-protected .p12 here until the
// user forgets the certificate (only a still-encrypted .p12 may ever be kept; it is offered for download).

let signer = null; // { certificate: Uint8Array, chain: Uint8Array[], privateKey: CryptoKey }
let backup = null; // { bytes: Uint8Array, fileName: string } of a certificate created in this tab
let summary = null;
const listeners = new Set();

const publish = () => {
  for (const listener of [...listeners]) listener();
};

const plain = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
};

/** Why this certificate cannot sign: "expired" | "notYetValid" | null. */
function blockOf(facts) {
  if (facts?.validity === "expired") return "expired";
  if (facts?.validity === "notYetValid") return "notYetValid";
  return null;
}

/**
 * Keeps what loadPkcs12() or createSelfSigned() of engine/sign returned.
 * @param {object} identity    { privateKey, certificate, chain, keyAlgorithm, info, p12Bytes? }
 * @param {{ origin: "file" | "created", fileName?: string }} details
 * @returns {object} the summary (see getIdentity)
 */
export function setIdentity(identity, { origin, fileName = "" }) {
  const facts = plain(identity.info?.certificate) || {};
  signer = { certificate: identity.certificate, chain: identity.chain || [identity.certificate], privateKey: identity.privateKey };
  backup = origin === "created" && identity.p12Bytes instanceof Uint8Array ? { bytes: identity.p12Bytes, fileName } : null;
  summary = Object.freeze({
    origin,
    fileName,
    facts,
    key: String(identity.keyAlgorithm?.description || facts.publicKey?.description || ""),
    // what the container said (weak encryption, no password ...) and what the certificate itself says
    warnings: [...(plain(identity.info?.warnings) || []), ...(facts.warnings || [])].filter((entry) => entry && typeof entry.code === "string"),
    chainComplete: identity.info?.chainComplete ?? null,
    chainLength: (identity.chain || []).length || 1,
    block: blockOf(facts),
    // "none": opened from a file | "pending": created here, not downloaded yet | "declined": the user went on
    // without downloading (asked once) | "downloaded"
    backup: backup ? "pending" : "none"
  });
  publish();
  return summary;
}

/**
 * What the interface may know: { origin, fileName, facts (certificateFacts), key, warnings, chainComplete,
 * chainLength, block, backup } or null. The same object until something changes (useSyncExternalStore).
 */
export const getIdentity = () => summary;

/** The `signer` option of signPdf: { certificate, chain, privateKey }, or null. Hand it to the engine and nowhere else. */
export const getSigner = () => signer;

/** The .p12 of a certificate created in this tab: { bytes, fileName } until it was forgotten, else null. */
export const getBackup = () => backup;

function setBackupState(state) {
  if (!summary || summary.backup === "none" || summary.backup === state) return;
  summary = Object.freeze({ ...summary, backup: state });
  publish();
}

/** The user downloaded the .p12 (it stays available: a second download is harmless). */
export const markBackupDownloaded = () => setBackupState("downloaded");

/** The user was asked once and goes on without the .p12. */
export const markBackupDeclined = () => {
  if (summary?.backup === "pending") setBackupState("declined");
};

/** "Forget this certificate": nothing of the identity stays in this tab. */
export function forgetIdentity() {
  if (backup) backup.bytes.fill(0);
  signer = null;
  backup = null;
  summary = null;
  publish();
}

export function subscribeIdentity(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
