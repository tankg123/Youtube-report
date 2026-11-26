// The two block ciphers of legacy PKCS#12 files that WebCrypto does not have: Triple-DES and RC2 (CBC mode,
// PKCS#7 padding). They come from the node-forge SUBMODULES des.js and rc2.js (deep imports: the rest of the
// library, about 250 kB, stays out of the bundle; util.js is what those two modules load anyway and supplies
// the byte buffer their cipher objects read from). Everything else in the PKCS#12 reader / writer is WebCrypto.
//
// forge works on "binary strings". JS strings are immutable, so plaintext that passes through this module
// (the private key of a Triple-DES protected file) cannot be wiped afterwards; the caller copies the result
// into a Uint8Array that it does wipe. AES-protected files never come here.

import forgeDes from "node-forge/lib/des.js";
import forgeRc2 from "node-forge/lib/rc2.js";
import forgeUtil from "node-forge/lib/util.js";
import { binaryStringToBytes, bytesToBinaryString } from "./bytes.js";

function run(cipher, iv, data) {
  cipher.start(bytesToBinaryString(iv));
  cipher.update(forgeUtil.createBuffer(bytesToBinaryString(data)));
  if (!cipher.finish()) return null; // wrong padding = wrong key
  return binaryStringToBytes(cipher.output.getBytes());
}

/** DES-EDE3-CBC. key: 24 bytes, iv: 8 bytes. Returns null when the padding is wrong (decryption only). */
export function tripleDesCbc(decrypt, key, iv, data) {
  if (key.length !== 24 || iv.length !== 8) return null;
  const keyText = bytesToBinaryString(key);
  const cipher = decrypt ? forgeDes.createDecryptionCipher(keyText) : forgeDes.createEncryptionCipher(keyText);
  return run(cipher, iv, data);
}

/** RC2-CBC with the given effective key bits (40 or 128 in PKCS#12). Returns null on wrong padding. */
export function rc2Cbc(decrypt, key, effectiveBits, iv, data) {
  if (iv.length !== 8) return null;
  const keyText = bytesToBinaryString(key);
  const cipher = decrypt ? forgeRc2.createDecryptionCipher(keyText, effectiveBits) : forgeRc2.createEncryptionCipher(keyText, effectiveBits);
  return run(cipher, iv, data);
}
