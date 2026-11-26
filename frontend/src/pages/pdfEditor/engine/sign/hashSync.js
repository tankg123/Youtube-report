// Synchronous SHA-1 / SHA-256 / SHA-384 / SHA-512 for ONE purpose: the key derivation of PKCS#12 files
// (RFC 7292 appendix B.2), which hashes its own output thousands to a million times.
// crypto.subtle.digest is asynchronous: awaited in a loop it costs 14 to 27 microseconds per call, about a
// hundred times the hashing itself (100 000 iterations took 2.6 s, and a file asks for several derivations).
// Measured here (Node 24, the V8 of Chrome): SHA-1 and SHA-256 0.2 microseconds per round, SHA-384 and SHA-512
// 1.2 (64-bit words out of 32-bit halves). Everything else in the engine hashes through WebCrypto
// (./sigverify.js). Browser + Node, no dependency. tests/pdfSignKdf.test.mjs compares both functions with
// WebCrypto and node:crypto on random inputs.
//
//   digestSync(hashName, bytes)                  -> Uint8Array
//   rehashSync(hashName, digest, rounds)         -> H(H(...H(digest))) applied `rounds` times
//   hasSyncDigest(hashName)                      -> boolean
//
// rehashSync is the inner loop of the derivation: every message is one digest long, so it fits one block
// with constant padding and the words of a result go straight into the next block. Both functions run to
// their end without yielding: the caller cuts the work into slices (./pkcs12.js). What they hash is key
// material, so the scratch space is zeroed before they return.

const K256 = Int32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
);

// the 80 round constants of SHA-512 as (high word, low word) pairs
const K512 = Int32Array.of(
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817
);

// scratch space of the compression functions (each call runs to its end before another one can start);
// digestSync and rehashSync zero it when they are done
const W32 = new Int32Array(80);
const W64 = new Int32Array(160);

function wipeScratch() {
  W32.fill(0);
  W64.fill(0);
}

/** SHA-1 compression of the 16 words at block[offset...] into state (5 words). */
function compressSha1(state, block, offset) {
  const w = W32;
  for (let t = 0; t < 16; t++) w[t] = block[offset + t];
  for (let t = 16; t < 80; t++) {
    const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
    w[t] = (x << 1) | (x >>> 31);
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  for (let t = 0; t < 80; t++) {
    let f;
    if (t < 20) f = ((b & c) | (~b & d)) + 0x5a827999;
    else if (t < 40) f = (b ^ c ^ d) + 0x6ed9eba1;
    else if (t < 60) f = ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc;
    else f = (b ^ c ^ d) + 0xca62c1d6;
    const next = (((a << 5) | (a >>> 27)) + f + e + w[t]) | 0;
    e = d;
    d = c;
    c = (b << 30) | (b >>> 2);
    b = a;
    a = next;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
}

/** SHA-256 compression of the 16 words at block[offset...] into state (8 words). */
function compressSha256(state, block, offset) {
  const w = W32;
  for (let t = 0; t < 16; t++) w[t] = block[offset + t];
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15];
    const y = w[t - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let t = 0; t < 64; t++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K256[t] + w[t]) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
  state[5] = (state[5] + f) | 0;
  state[6] = (state[6] + g) | 0;
  state[7] = (state[7] + h) | 0;
}

const TWO_32 = 4294967296;

/**
 * SHA-512 compression of the 16 64-bit words (32 halves, high word first) at block[offset...] into state
 * (8 words as 16 halves). A 64-bit sum is made of two 32-bit sums: the low halves are added as unsigned
 * numbers (at most five of them, exact in a double) and the overflow is carried into the high halves.
 */
function compressSha512(state, block, offset) {
  const w = W64;
  for (let t = 0; t < 32; t++) w[t] = block[offset + t];
  for (let t = 16; t < 80; t++) {
    const xh = w[2 * (t - 15)];
    const xl = w[2 * (t - 15) + 1];
    const yh = w[2 * (t - 2)];
    const yl = w[2 * (t - 2) + 1];
    // s0 = rotr(x, 1) ^ rotr(x, 8) ^ shr(x, 7);  s1 = rotr(y, 19) ^ rotr(y, 61) ^ shr(y, 6)
    const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
    const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
    const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
    const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
    const low = (w[2 * (t - 16) + 1] >>> 0) + (s0l >>> 0) + (w[2 * (t - 7) + 1] >>> 0) + (s1l >>> 0);
    w[2 * t + 1] = low | 0;
    w[2 * t] = (w[2 * (t - 16)] + s0h + w[2 * (t - 7)] + s1h + Math.floor(low / TWO_32)) | 0;
  }
  let ah = state[0];
  let al = state[1];
  let bh = state[2];
  let bl = state[3];
  let ch = state[4];
  let cl = state[5];
  let dh = state[6];
  let dl = state[7];
  let eh = state[8];
  let el = state[9];
  let fh = state[10];
  let fl = state[11];
  let gh = state[12];
  let gl = state[13];
  let hh = state[14];
  let hl = state[15];
  for (let t = 0; t < 80; t++) {
    // S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41);  ch = (e & f) ^ (~e & g)
    const s1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const s1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh);
    const chl = (el & fl) ^ (~el & gl);
    const t1low = (hl >>> 0) + (s1l >>> 0) + (chl >>> 0) + (K512[2 * t + 1] >>> 0) + (w[2 * t + 1] >>> 0);
    const t1l = t1low | 0;
    const t1h = (hh + s1h + chh + K512[2 * t] + w[2 * t] + Math.floor(t1low / TWO_32)) | 0;
    // S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39);  maj = (a & b) ^ (a & c) ^ (b & c)
    const s0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const s0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
    const majl = (al & bl) ^ (al & cl) ^ (bl & cl);
    const t2low = (s0l >>> 0) + (majl >>> 0);
    const t2l = t2low | 0;
    const t2h = (s0h + majh + Math.floor(t2low / TWO_32)) | 0;
    hh = gh;
    hl = gl;
    gh = fh;
    gl = fl;
    fh = eh;
    fl = el;
    const elow = (dl >>> 0) + (t1l >>> 0);
    el = elow | 0;
    eh = (dh + t1h + Math.floor(elow / TWO_32)) | 0;
    dh = ch;
    dl = cl;
    ch = bh;
    cl = bl;
    bh = ah;
    bl = al;
    const alow = (t1l >>> 0) + (t2l >>> 0);
    al = alow | 0;
    ah = (t1h + t2h + Math.floor(alow / TWO_32)) | 0;
  }
  addInto(state, 0, ah, al);
  addInto(state, 2, bh, bl);
  addInto(state, 4, ch, cl);
  addInto(state, 6, dh, dl);
  addInto(state, 8, eh, el);
  addInto(state, 10, fh, fl);
  addInto(state, 12, gh, gl);
  addInto(state, 14, hh, hl);
}

/** state[i], state[i + 1] (one 64-bit word) += (high, low). */
function addInto(state, i, high, low) {
  const sum = (state[i + 1] >>> 0) + (low >>> 0);
  state[i + 1] = sum | 0;
  state[i] = (state[i] + high + Math.floor(sum / TWO_32)) | 0;
}

// blockWords / digestWords count 32-bit words; lengthWords = size of the message length field of the padding
const ALGORITHMS = Object.freeze({
  "SHA-1": {
    blockWords: 16, digestWords: 5, lengthWords: 2, compress: compressSha1,
    initial: Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0)
  },
  "SHA-256": {
    blockWords: 16, digestWords: 8, lengthWords: 2, compress: compressSha256,
    initial: Int32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19)
  },
  "SHA-384": {
    blockWords: 32, digestWords: 12, lengthWords: 4, compress: compressSha512,
    initial: Int32Array.of(
      0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
      0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4
    )
  },
  "SHA-512": {
    blockWords: 32, digestWords: 16, lengthWords: 4, compress: compressSha512,
    initial: Int32Array.of(
      0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
      0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179
    )
  }
});

/** True for the hash names this module computes. */
export const hasSyncDigest = (hashName) => Object.hasOwn(ALGORITHMS, hashName);

function algorithmOf(hashName) {
  if (!hasSyncDigest(hashName)) throw new RangeError(`hashSync: unsupported hash ${hashName}`);
  return ALGORITHMS[hashName];
}

function wordsToBytes(words, count) {
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const word = words[i];
    out[4 * i] = word >>> 24;
    out[4 * i + 1] = (word >>> 16) & 0xff;
    out[4 * i + 2] = (word >>> 8) & 0xff;
    out[4 * i + 3] = word & 0xff;
  }
  return out;
}

/** Digest of `bytes` (Uint8Array). */
export function digestSync(hashName, bytes) {
  const algorithm = algorithmOf(hashName);
  const blockBytes = algorithm.blockWords * 4;
  // message, 0x80, zeros, then the message length in bits (big endian) at the end of the last block
  const total = Math.ceil((bytes.length + 1 + algorithm.lengthWords * 4) / blockBytes) * blockBytes;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(total - 4, (bytes.length * 8) >>> 0);
  const words = new Int32Array(total / 4);
  for (let i = 0; i < words.length; i++) words[i] = view.getInt32(4 * i);
  const state = Int32Array.from(algorithm.initial);
  for (let offset = 0; offset < words.length; offset += algorithm.blockWords) algorithm.compress(state, words, offset);
  const out = wordsToBytes(state, algorithm.digestWords);
  padded.fill(0);
  words.fill(0);
  state.fill(0);
  wipeScratch();
  return out;
}

/**
 * Hashes a digest `rounds` times: digest = H(digest), again and again. `digest` must be a digest of the same
 * hash (its length is checked). -> a new Uint8Array; the input is not changed.
 */
export function rehashSync(hashName, digest, rounds) {
  const algorithm = algorithmOf(hashName);
  const { blockWords, digestWords, compress, initial } = algorithm;
  if (!(digest instanceof Uint8Array) || digest.length !== digestWords * 4) throw new RangeError(`hashSync: a ${hashName} digest of ${digestWords * 4} bytes is expected`);
  if (!Number.isInteger(rounds) || rounds < 0) throw new RangeError("hashSync: rounds must be a non-negative integer");
  const block = new Int32Array(blockWords);
  const state = new Int32Array(initial.length);
  for (let i = 0; i < digestWords; i++) {
    block[i] = (digest[4 * i] << 24) | (digest[4 * i + 1] << 16) | (digest[4 * i + 2] << 8) | digest[4 * i + 3];
  }
  // the padding of a message that is one digest long never changes
  block[digestWords] = 0x80000000 | 0;
  block[blockWords - 1] = digestWords * 32;
  for (let round = 0; round < rounds; round++) {
    state.set(initial);
    compress(state, block, 0);
    for (let i = 0; i < digestWords; i++) block[i] = state[i];
  }
  const out = wordsToBytes(block, digestWords);
  block.fill(0);
  state.fill(0);
  wipeScratch();
  return out;
}
