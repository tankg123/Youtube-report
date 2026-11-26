// Object identifier tables of the certificate / PKCS#12 / CMS modules. Data only.

/** X.501 attribute types -> short label (RFC 4514 names where they exist, OpenSSL names otherwise). */
export const NAME_ATTRIBUTES = Object.freeze({
  "2.5.4.3": "CN",
  "2.5.4.4": "SN", // surname
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.9": "street",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.12": "title",
  "2.5.4.13": "description",
  "2.5.4.15": "businessCategory",
  "2.5.4.16": "postalAddress",
  "2.5.4.17": "postalCode",
  "2.5.4.20": "telephoneNumber",
  "2.5.4.41": "name",
  "2.5.4.42": "GN", // givenName
  "2.5.4.43": "initials",
  "2.5.4.44": "generationQualifier",
  "2.5.4.45": "x500UniqueIdentifier",
  "2.5.4.46": "dnQualifier",
  "2.5.4.65": "pseudonym",
  "2.5.4.97": "organizationIdentifier",
  "0.9.2342.19200300.100.1.1": "UID",
  "0.9.2342.19200300.100.1.3": "mail",
  "0.9.2342.19200300.100.1.25": "DC",
  "1.2.840.113549.1.9.1": "emailAddress",
  "1.2.840.113549.1.9.2": "unstructuredName",
  "1.2.840.113549.1.9.8": "unstructuredAddress",
  "1.3.6.1.4.1.311.60.2.1.1": "jurisdictionL",
  "1.3.6.1.4.1.311.60.2.1.2": "jurisdictionST",
  "1.3.6.1.4.1.311.60.2.1.3": "jurisdictionC"
});

export const OID = Object.freeze({
  // public key types
  rsaEncryption: "1.2.840.113549.1.1.1",
  rsassaPss: "1.2.840.113549.1.1.10",
  mgf1: "1.2.840.113549.1.1.8",
  ecPublicKey: "1.2.840.10045.2.1",
  dsa: "1.2.840.10040.4.1",
  dh: "1.2.840.113549.1.3.1",
  ed25519: "1.3.101.112",
  ed448: "1.3.101.113",
  x25519: "1.3.101.110",
  // signature algorithms the signer writes
  sha256WithRSAEncryption: "1.2.840.113549.1.1.11",
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
  // curves
  secp256r1: "1.2.840.10045.3.1.7",
  secp384r1: "1.3.132.0.34",
  secp521r1: "1.3.132.0.35",
  secp256k1: "1.3.132.0.10",
  // digests
  md5: "1.2.840.113549.2.5",
  sha1: "1.3.14.3.2.26",
  sha224: "2.16.840.1.101.3.4.2.4",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  // PKCS#7 / CMS content types
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  envelopedData: "1.2.840.113549.1.7.3",
  encryptedData: "1.2.840.113549.1.7.6",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  // CMS attributes
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  counterSignature: "1.2.840.113549.1.9.6",
  cmsAlgorithmProtection: "1.2.840.113549.1.9.52",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signatureTimeStampToken: "1.2.840.113549.1.9.16.2.14",
  signaturePolicyIdentifier: "1.2.840.113549.1.9.16.2.15",
  commitmentTypeIndication: "1.2.840.113549.1.9.16.2.16",
  contentTimeStamp: "1.2.840.113549.1.9.16.2.20",
  adbeRevocationInfoArchival: "1.2.840.113583.1.1.8",
  // PKCS#12
  keyBag: "1.2.840.113549.1.12.10.1.1",
  pkcs8ShroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
  certBag: "1.2.840.113549.1.12.10.1.3",
  crlBag: "1.2.840.113549.1.12.10.1.4",
  secretBag: "1.2.840.113549.1.12.10.1.5",
  safeContentsBag: "1.2.840.113549.1.12.10.1.6",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  friendlyName: "1.2.840.113549.1.9.20",
  localKeyId: "1.2.840.113549.1.9.21",
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12",
  pbmac1: "1.2.840.113549.1.5.14",
  scrypt: "1.3.6.1.4.1.11591.4.11",
  hmacWithSHA1: "1.2.840.113549.2.7",
  hmacWithSHA224: "1.2.840.113549.2.8",
  hmacWithSHA256: "1.2.840.113549.2.9",
  hmacWithSHA384: "1.2.840.113549.2.10",
  hmacWithSHA512: "1.2.840.113549.2.11",
  aes128Cbc: "2.16.840.1.101.3.4.1.2",
  aes192Cbc: "2.16.840.1.101.3.4.1.22",
  aes256Cbc: "2.16.840.1.101.3.4.1.42",
  aes128Gcm: "2.16.840.1.101.3.4.1.6",
  aes256Gcm: "2.16.840.1.101.3.4.1.46",
  desEde3Cbc: "1.2.840.113549.3.7",
  desCbc: "1.3.14.3.2.7",
  pbeSha1Rc4128: "1.2.840.113549.1.12.1.1",
  pbeSha1Rc440: "1.2.840.113549.1.12.1.2",
  pbeSha13Des: "1.2.840.113549.1.12.1.3",
  pbeSha12Des: "1.2.840.113549.1.12.1.4",
  pbeSha1Rc2128: "1.2.840.113549.1.12.1.5",
  pbeSha1Rc240: "1.2.840.113549.1.12.1.6",
  // X.509 extensions
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  crlDistributionPoints: "2.5.29.31",
  certificatePolicies: "2.5.29.32",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  authorityInfoAccess: "1.3.6.1.5.5.7.1.1",
  qcStatements: "1.3.6.1.5.5.7.1.3",
  ocsp: "1.3.6.1.5.5.7.48.1",
  caIssuers: "1.3.6.1.5.5.7.48.2",
  // extended key usages
  anyExtendedKeyUsage: "2.5.29.37.0",
  timeStamping: "1.3.6.1.5.5.7.3.8"
});

export const DIGESTS = Object.freeze({
  [OID.md5]: { name: "MD5", webCrypto: null, bytes: 16, weak: true },
  [OID.sha1]: { name: "SHA-1", webCrypto: "SHA-1", bytes: 20, weak: true },
  [OID.sha224]: { name: "SHA-224", webCrypto: null, bytes: 28, weak: false },
  [OID.sha256]: { name: "SHA-256", webCrypto: "SHA-256", bytes: 32, weak: false },
  [OID.sha384]: { name: "SHA-384", webCrypto: "SHA-384", bytes: 48, weak: false },
  [OID.sha512]: { name: "SHA-512", webCrypto: "SHA-512", bytes: 64, weak: false },
  "2.16.840.1.101.3.4.2.8": { name: "SHA3-256", webCrypto: null, bytes: 32, weak: false },
  "2.16.840.1.101.3.4.2.9": { name: "SHA3-384", webCrypto: null, bytes: 48, weak: false },
  "2.16.840.1.101.3.4.2.10": { name: "SHA3-512", webCrypto: null, bytes: 64, weak: false },
  "1.3.36.3.2.1": { name: "RIPEMD-160", webCrypto: null, bytes: 20, weak: true }
});

/**
 * Signature algorithm identifiers -> { name, scheme, hash }.
 * scheme: "rsa-pkcs1" | "rsa-pss" | "ecdsa" | "eddsa" | "dsa". hash: WebCrypto name, or null = "taken from the
 * digest algorithm next to it" (rsaEncryption / id-ecPublicKey used as a signature algorithm in CMS).
 */
export const SIGNATURE_ALGORITHMS = Object.freeze({
  "1.2.840.113549.1.1.1": { name: "rsaEncryption", scheme: "rsa-pkcs1", hash: null },
  "1.2.840.113549.1.1.2": { name: "md2WithRSAEncryption", scheme: "rsa-pkcs1", hash: "MD2", weak: true },
  "1.2.840.113549.1.1.4": { name: "md5WithRSAEncryption", scheme: "rsa-pkcs1", hash: "MD5", weak: true },
  "1.2.840.113549.1.1.5": { name: "sha1WithRSAEncryption", scheme: "rsa-pkcs1", hash: "SHA-1", weak: true },
  "1.3.14.3.2.29": { name: "sha1WithRSASignature", scheme: "rsa-pkcs1", hash: "SHA-1", weak: true },
  "1.2.840.113549.1.1.14": { name: "sha224WithRSAEncryption", scheme: "rsa-pkcs1", hash: "SHA-224" },
  "1.2.840.113549.1.1.11": { name: "sha256WithRSAEncryption", scheme: "rsa-pkcs1", hash: "SHA-256" },
  "1.2.840.113549.1.1.12": { name: "sha384WithRSAEncryption", scheme: "rsa-pkcs1", hash: "SHA-384" },
  "1.2.840.113549.1.1.13": { name: "sha512WithRSAEncryption", scheme: "rsa-pkcs1", hash: "SHA-512" },
  "1.2.840.113549.1.1.10": { name: "RSASSA-PSS", scheme: "rsa-pss", hash: null },
  "1.2.840.10045.2.1": { name: "id-ecPublicKey", scheme: "ecdsa", hash: null },
  "1.2.840.10045.4.1": { name: "ecdsa-with-SHA1", scheme: "ecdsa", hash: "SHA-1", weak: true },
  "1.2.840.10045.4.3.1": { name: "ecdsa-with-SHA224", scheme: "ecdsa", hash: "SHA-224" },
  "1.2.840.10045.4.3.2": { name: "ecdsa-with-SHA256", scheme: "ecdsa", hash: "SHA-256" },
  "1.2.840.10045.4.3.3": { name: "ecdsa-with-SHA384", scheme: "ecdsa", hash: "SHA-384" },
  "1.2.840.10045.4.3.4": { name: "ecdsa-with-SHA512", scheme: "ecdsa", hash: "SHA-512" },
  "1.3.101.112": { name: "Ed25519", scheme: "eddsa", hash: null },
  "1.3.101.113": { name: "Ed448", scheme: "eddsa", hash: null },
  "1.2.840.10040.4.3": { name: "dsa-with-SHA1", scheme: "dsa", hash: "SHA-1", weak: true },
  "2.16.840.1.101.3.4.3.2": { name: "dsa-with-SHA256", scheme: "dsa", hash: "SHA-256" }
});

/** Named curves -> { name (WebCrypto / NIST), bits, bytes (size of one coordinate), webCrypto }. */
export const CURVES = Object.freeze({
  "1.2.840.10045.3.1.7": { name: "P-256", alias: "secp256r1 / prime256v1", bits: 256, bytes: 32, webCrypto: true },
  "1.3.132.0.34": { name: "P-384", alias: "secp384r1", bits: 384, bytes: 48, webCrypto: true },
  "1.3.132.0.35": { name: "P-521", alias: "secp521r1", bits: 521, bytes: 66, webCrypto: true },
  "1.3.132.0.10": { name: "secp256k1", alias: "secp256k1", bits: 256, bytes: 32, webCrypto: false },
  "1.3.132.0.33": { name: "P-224", alias: "secp224r1", bits: 224, bytes: 28, webCrypto: false },
  "1.2.840.10045.3.1.1": { name: "P-192", alias: "secp192r1", bits: 192, bytes: 24, webCrypto: false },
  "1.3.36.3.3.2.8.1.1.7": { name: "brainpoolP256r1", alias: "brainpoolP256r1", bits: 256, bytes: 32, webCrypto: false },
  "1.3.36.3.3.2.8.1.1.11": { name: "brainpoolP384r1", alias: "brainpoolP384r1", bits: 384, bytes: 48, webCrypto: false },
  "1.3.36.3.3.2.8.1.1.13": { name: "brainpoolP512r1", alias: "brainpoolP512r1", bits: 512, bytes: 64, webCrypto: false }
});

export const KEY_USAGE_BITS = Object.freeze([
  "digitalSignature", "nonRepudiation", "keyEncipherment", "dataEncipherment", "keyAgreement",
  "keyCertSign", "cRLSign", "encipherOnly", "decipherOnly"
]);

export const EXTENDED_KEY_USAGES = Object.freeze({
  "2.5.29.37.0": "anyExtendedKeyUsage",
  "1.3.6.1.5.5.7.3.1": "serverAuth",
  "1.3.6.1.5.5.7.3.2": "clientAuth",
  "1.3.6.1.5.5.7.3.3": "codeSigning",
  "1.3.6.1.5.5.7.3.4": "emailProtection",
  "1.3.6.1.5.5.7.3.8": "timeStamping",
  "1.3.6.1.5.5.7.3.9": "OCSPSigning",
  "1.3.6.1.5.5.7.3.36": "documentSigning",
  "1.3.6.1.4.1.311.10.3.12": "msDocumentSigning",
  "1.3.6.1.4.1.311.20.2.2": "msSmartcardLogon",
  "1.2.840.113583.1.1.5": "adobeAuthenticDocumentsTrust"
});

export const EXTENSION_NAMES = Object.freeze({
  "2.5.29.14": "subjectKeyIdentifier",
  "2.5.29.15": "keyUsage",
  "2.5.29.17": "subjectAltName",
  "2.5.29.18": "issuerAltName",
  "2.5.29.19": "basicConstraints",
  "2.5.29.30": "nameConstraints",
  "2.5.29.31": "cRLDistributionPoints",
  "2.5.29.32": "certificatePolicies",
  "2.5.29.35": "authorityKeyIdentifier",
  "2.5.29.36": "policyConstraints",
  "2.5.29.37": "extKeyUsage",
  "1.3.6.1.5.5.7.1.1": "authorityInfoAccess",
  "1.3.6.1.5.5.7.1.3": "qcStatements",
  "1.3.6.1.4.1.11129.2.4.2": "signedCertificateTimestampList",
  "2.16.840.1.113730.1.1": "netscapeCertType",
  "1.2.840.113583.1.1.9.1": "adobeTimeStamp",
  "1.2.840.113583.1.1.9.2": "adobeArchiveRevInfo"
});

export const CMS_ATTRIBUTE_NAMES = Object.freeze({
  "1.2.840.113549.1.9.3": "contentType",
  "1.2.840.113549.1.9.4": "messageDigest",
  "1.2.840.113549.1.9.5": "signingTime",
  "1.2.840.113549.1.9.6": "counterSignature",
  "1.2.840.113549.1.9.15": "smimeCapabilities",
  "1.2.840.113549.1.9.52": "cmsAlgorithmProtection",
  "1.2.840.113549.1.9.16.2.12": "signingCertificate",
  "1.2.840.113549.1.9.16.2.47": "signingCertificateV2",
  "1.2.840.113549.1.9.16.2.14": "signatureTimeStampToken",
  "1.2.840.113549.1.9.16.2.15": "signaturePolicyIdentifier",
  "1.2.840.113549.1.9.16.2.16": "commitmentTypeIndication",
  "1.2.840.113549.1.9.16.2.17": "signerLocation",
  "1.2.840.113549.1.9.16.2.18": "signerAttributes",
  "1.2.840.113549.1.9.16.2.20": "contentTimeStamp",
  "1.2.840.113583.1.1.8": "adbeRevocationInfoArchival",
  "1.3.6.1.4.1.311.2.4.1": "msNestedSignature"
});

/** Technical name of an encryption / MAC / KDF OID found in a PKCS#12 file (shown as is, never translated). */
export const PKCS12_ALGORITHM_NAMES = Object.freeze({
  [OID.pbes2]: "PBES2",
  [OID.pbkdf2]: "PBKDF2",
  [OID.pbmac1]: "PBMAC1",
  [OID.scrypt]: "scrypt",
  [OID.aes128Cbc]: "AES-128-CBC",
  [OID.aes192Cbc]: "AES-192-CBC",
  [OID.aes256Cbc]: "AES-256-CBC",
  [OID.aes128Gcm]: "AES-128-GCM",
  [OID.aes256Gcm]: "AES-256-GCM",
  [OID.desEde3Cbc]: "DES-EDE3-CBC",
  [OID.desCbc]: "DES-CBC",
  [OID.pbeSha1Rc4128]: "pbeWithSHAAnd128BitRC4",
  [OID.pbeSha1Rc440]: "pbeWithSHAAnd40BitRC4",
  [OID.pbeSha13Des]: "pbeWithSHAAnd3-KeyTripleDES-CBC",
  [OID.pbeSha12Des]: "pbeWithSHAAnd2-KeyTripleDES-CBC",
  [OID.pbeSha1Rc2128]: "pbeWithSHAAnd128BitRC2-CBC",
  [OID.pbeSha1Rc240]: "pbeWithSHAAnd40BitRC2-CBC",
  [OID.hmacWithSHA1]: "hmacWithSHA1",
  [OID.hmacWithSHA224]: "hmacWithSHA224",
  [OID.hmacWithSHA256]: "hmacWithSHA256",
  [OID.hmacWithSHA384]: "hmacWithSHA384",
  [OID.hmacWithSHA512]: "hmacWithSHA512",
  "1.2.840.113549.1.5.3": "pbeWithMD5AndDES-CBC",
  "1.2.840.113549.1.5.10": "pbeWithSHA1AndDES-CBC"
});

/** HMAC pseudo-random functions that WebCrypto offers (PBKDF2, PBMAC1). */
export const HMAC_PRFS = Object.freeze({
  [OID.hmacWithSHA1]: "SHA-1",
  [OID.hmacWithSHA256]: "SHA-256",
  [OID.hmacWithSHA384]: "SHA-384",
  [OID.hmacWithSHA512]: "SHA-512"
});
