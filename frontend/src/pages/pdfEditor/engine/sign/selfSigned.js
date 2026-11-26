// Self-signed signing certificate made in the browser: WebCrypto key pair + X.509 v3 certificate built with
// the DER writer of ./asn1.js + optional PKCS#12 backup. Browser + Node.
//
// createSelfSigned({ commonName, organization, organizationalUnit, email, country, years, keyType, ... })
//   -> { privateKey (non-extractable CryptoKey), privateKeysByHash, keyAlgorithm, certificate (DER),
//        chain: [certificate], p12Bytes (when p12Password is given, else null), info }
//
// Profile (validated against OpenSSL -x509_strict, Python cryptography, Windows and pyHanko --strict): v3,
// serial = 16 random octets forced positive, issuer = subject in the order C, ST, L, O, OU, CN, emailAddress,
// UTF8String text attributes, notBefore = now - 5 min, basicConstraints critical CA:FALSE, keyUsage critical
// digitalSignature + nonRepudiation (pyHanko requires the second), subjectKeyIdentifier, SAN e-mail, and NO
// extended key usage (absent = unrestricted; a present EKU can only exclude readers).

import { PdfEditorError } from "../errors.js";
import { der } from "./asn1.js";
import { randomBytes, utf8Encode, wipe } from "./bytes.js";
import { OID } from "./oids.js";
import { createPkcs12, importSigningKey } from "./pkcs12.js";
import { parseSpki, signatureAlgorithmIdentifier, signData, subtle } from "./sigverify.js";
import { certificateFacts } from "./x509.js";

export const SELF_SIGNED_KEY_TYPES = Object.freeze({
  "RSA-2048": { algorithm: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" } },
  "RSA-3072": { algorithm: { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" } },
  "P-256": { algorithm: { name: "ECDSA", namedCurve: "P-256" } }
});

const NAME_OIDS = { C: "2.5.4.6", ST: "2.5.4.8", L: "2.5.4.7", O: "2.5.4.10", OU: "2.5.4.11", CN: "2.5.4.3", emailAddress: "1.2.840.113549.1.9.1" };

const invalid = (field, detail) => new PdfEditorError("CERT_INVALID_OPTIONS", { field }, { detail });
const trimmed = (value) => String(value).trim().normalize("NFC");

/**
 * Name with one attribute per RDN in the usual order C, ST, L, O, OU, CN, emailAddress.
 * Text attributes are UTF8String (Vietnamese names need it); C is PrintableString and emailAddress IA5String,
 * as RFC 5280 requires. Throws CERT_INVALID_OPTIONS { field }.
 */
export function buildName({ country, state, locality, organization, organizationalUnit, commonName, email }) {
  const rdns = [];
  const add = (oid, encoded) => rdns.push(der.set(der.seq(der.oid(oid), encoded)));
  if (country) {
    const code = String(country).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) throw invalid("country", "country must be a two-letter ISO 3166 code such as VN");
    add(NAME_OIDS.C, der.printable(code));
  }
  if (state) add(NAME_OIDS.ST, der.utf8(trimmed(state)));
  if (locality) add(NAME_OIDS.L, der.utf8(trimmed(locality)));
  if (organization) add(NAME_OIDS.O, der.utf8(trimmed(organization)));
  if (organizationalUnit) add(NAME_OIDS.OU, der.utf8(trimmed(organizationalUnit)));
  if (!commonName || !String(commonName).trim()) throw invalid("commonName", "commonName is required");
  const name = trimmed(commonName);
  if (name.length > 64) throw invalid("commonName", "commonName is limited to 64 characters (X.520 upper bound that validators enforce)");
  add(NAME_OIDS.CN, der.utf8(name));
  if (email) {
    const address = String(email).trim();
    if (!/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(address)) throw invalid("email", "email must be an ASCII address");
    add(NAME_OIDS.emailAddress, der.ia5(address));
  }
  return der.seq(...rdns);
}

const extension = (oid, critical, value) => der.seq(der.oid(oid), critical ? der.bool(true) : null, der.octets(value));

/**
 * @param {object} p
 *   commonName (required), organization, organizationalUnit, email, country ("VN"), state, locality
 *   years: validity in years (default 3; fractions allowed, at most 30)
 *   keyType: "RSA-2048" (default) | "RSA-3072" | "P-256"
 *   p12Password: when given (may be ""), p12Bytes is returned; without it the key can never leave this tab
 *   p12Profile: "3des" (default, opens everywhere) | "aes256"
 *   hashes: digests the returned key must serve (default ["SHA-256"])
 *   friendlyName: name stored in the .p12 (default: the common name)
 *   now: Date (tests)
 * @throws PdfEditorError CERT_INVALID_OPTIONS { field } | SIGN_NO_WEBCRYPTO
 */
export async function createSelfSigned(p = {}) {
  const keyType = p.keyType || "RSA-2048";
  const spec = SELF_SIGNED_KEY_TYPES[keyType];
  if (!spec) throw invalid("keyType", `keyType must be one of ${Object.keys(SELF_SIGNED_KEY_TYPES).join(", ")}`);
  const years = p.years == null ? 3 : Number(p.years);
  if (!(years > 0) || years > 30) throw invalid("years", "years must be above 0 and at most 30");
  const name = buildName(p);
  const wantP12 = p.p12Password != null;
  if (wantP12 && typeof p.p12Password !== "string") throw invalid("p12Password", "the password must be a string");
  const p12Profile = p.p12Profile || "3des";
  if (p12Profile !== "3des" && p12Profile !== "aes256") throw invalid("p12Profile", "p12Profile must be 3des or aes256");
  const hashes = p.hashes || ["SHA-256"];
  // a non-extractable RSA handle is bound to SHA-256; other digests would need the PKCS#8 bytes
  if (!wantP12 && spec.algorithm.name === "RSASSA-PKCS1-v1_5" && hashes.some((hash) => hash !== "SHA-256")) {
    throw invalid("hashes", "without p12Password the RSA key is generated non-extractable and serves SHA-256 only");
  }
  const api = subtle();

  const t0 = performance.now();
  // The pair is generated extractable only when a backup file is wanted: exporting PKCS#8 is the single
  // moment the private key is visible to script. Afterwards it is re-imported as non-extractable.
  const pair = await api.generateKey(spec.algorithm, wantP12, ["sign", "verify"]);
  const keyGenerationMs = performance.now() - t0;
  const spki = new Uint8Array(await api.exportKey("spki", pair.publicKey));

  // serial: 16 random octets, forced positive and non-zero in the first octet (always 16 octets long)
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;

  const now = p.now || new Date();
  const notBefore = new Date(Math.floor(now.getTime() / 1000) * 1000 - 5 * 60 * 1000); // 5 minutes of clock skew
  let notAfter;
  if (Number.isInteger(years)) {
    notAfter = new Date(notBefore.getTime());
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years); // same calendar day, `years` later
  } else {
    notAfter = new Date(notBefore.getTime() + Math.round(years * 365 * 86400) * 1000);
  }

  // subjectKeyIdentifier: SHA-1 of the subjectPublicKey bits (RFC 5280 4.2.1.2 method 1)
  const keyIdentifier = new Uint8Array(await api.digest("SHA-1", parseSpki(spki).publicKeyBytes));

  const extensions = [
    extension(OID.basicConstraints, true, der.seq()), // cA FALSE (DEFAULT, so the SEQUENCE is empty)
    extension(OID.keyUsage, true, der.bitString(Uint8Array.of(0xc0), 6)), // digitalSignature + nonRepudiation
    extension(OID.subjectKeyIdentifier, false, der.octets(keyIdentifier))
  ];
  if (p.email) extensions.push(extension(OID.subjectAltName, false, der.seq(der.ctxPrimitive(1, utf8Encode(String(p.email).trim())))));

  const signatureAlgorithm = signatureAlgorithmIdentifier(pair.privateKey, "SHA-256");
  const tbs = der.seq(
    der.ctx(0, der.int(2)),
    der.intFromBytes(serial),
    signatureAlgorithm,
    name,
    der.seq(der.time(notBefore), der.time(notAfter)),
    name,
    spki,
    der.ctx(3, der.seq(...extensions))
  );
  const signature = await signData(pair.privateKey, "SHA-256", tbs);
  const certificate = der.seq(tbs, signatureAlgorithm, der.bitString(signature));

  let privateKey = pair.privateKey;
  let privateKeysByHash = Object.fromEntries(hashes.map((hash) => [hash, pair.privateKey]));
  let keyAlgorithm;
  let p12Bytes = null;
  if (wantP12) {
    const pkcs8 = new Uint8Array(await api.exportKey("pkcs8", pair.privateKey));
    try {
      p12Bytes = await createPkcs12({
        privateKeyPkcs8: pkcs8,
        certificates: [certificate],
        password: p.p12Password,
        friendlyName: p.friendlyName || trimmed(p.commonName),
        profile: p12Profile
      });
      const imported = await importSigningKey(pkcs8, { hashes, extractable: false });
      privateKey = imported.privateKey;
      privateKeysByHash = imported.privateKeysByHash;
      keyAlgorithm = imported.keyAlgorithm;
    } finally {
      wipe(pkcs8);
    }
  } else if (spec.algorithm.name === "RSASSA-PKCS1-v1_5") {
    keyAlgorithm = { type: "RSA", name: "RSASSA-PKCS1-v1_5", modulusLength: spec.algorithm.modulusLength, hashes: ["SHA-256"], description: `RSA ${spec.algorithm.modulusLength}` };
  } else {
    keyAlgorithm = { type: "EC", name: "ECDSA", namedCurve: "P-256", hashes: [...hashes], description: "ECDSA P-256", signatureBytes: 64 };
  }

  return {
    privateKey,
    privateKeysByHash,
    keyAlgorithm,
    certificate,
    chain: [certificate],
    p12Bytes,
    info: {
      certificate: await certificateFacts(certificate, { now }),
      keyGenerationMs: Math.round(keyGenerationMs),
      totalMs: Math.round(performance.now() - t0),
      p12Profile: wantP12 ? p12Profile : null
    }
  };
}
