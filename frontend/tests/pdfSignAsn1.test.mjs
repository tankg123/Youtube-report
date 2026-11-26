// engine/sign: the ASN.1 / DER reader-writer and the byte helpers under it.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ASN1_MALFORMED, TAG, berLength, decode, decodeExact, der, hasIndefiniteLength, isAsn1Error, oidFromBytes, oidToBytes, sortSetOf, tlv, toDer } from "../src/pages/pdfEditor/engine/sign/asn1.js";
import {
  asBytes, bitLength, compareBytes, concatBytes, equalBytes, fromBase64, fromHex, fromPem, latin1Encode, stripLeadingZeros, toBase64, toHex,
  toPem, utf16beEncode, wipe
} from "../src/pages/pdfEditor/engine/sign/bytes.js";
import { ecdsaDerToP1363, ecdsaP1363ToDer } from "../src/pages/pdfEditor/engine/sign/sigverify.js";
import { isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { CERTS } from "./helpers/pdfSignFixtures.mjs";

const malformed = (fn, reason) => assert.throws(fn, (error) => {
  assert.ok(isPdfEditorError(error), `a PdfEditorError is expected, got ${error && error.name}: ${error && error.message}`);
  assert.equal(error.code, ASN1_MALFORMED);
  assert.equal(isAsn1Error(error), true);
  if (reason) assert.equal(error.params.reason, reason);
  return true;
});

test("asn1: a real certificate is decoded with exact byte offsets and re-encodes to itself", () => {
  const certificate = CERTS.signer1;
  const root = decodeExact(certificate, { strict: true });
  assert.equal(root.isSequence, true);
  assert.equal(root.children.length, 3);
  assert.equal(root.end, certificate.length);
  assert.ok(equalBytes(root.raw, certificate));
  const tbs = root.children[0];
  assert.ok(equalBytes(tbs.raw, certificate.subarray(tbs.start, tbs.end)));
  assert.equal(root.children[1].child(0).oid(), "1.2.840.113549.1.1.11");
  assert.equal(hasIndefiniteLength(root), false);
  // toDer of DER is the identity (nothing is reordered when sets are left alone)
  for (const der of [CERTS.rootCa, CERTS.ecSigner, CERTS.vnOrg]) assert.ok(equalBytes(toDer(decode(der), { sortSets: false }), der));
});

test("asn1: OID encoding round trip, including large arcs", () => {
  for (const oid of ["1.2.840.113549.1.1.11", "2.5.4.3", "0.9.2342.19200300.100.1.1", "2.16.840.1.101.3.4.2.1", "1.3.6.1.4.1.311.10.3.12", "2.999.18446744073709551616"]) {
    assert.equal(oidFromBytes(oidToBytes(oid)), oid);
  }
  assert.equal(toHex(oidToBytes("1.2.840.113549")), "2a864886f70d");
  assert.equal(toHex(der.oid("1.2.840.113549.1.7.2")), "06092a864886f70d010702");
  assert.equal(toHex(der.oid("2.16.840.1.101.3.4.2.1")), "0609608648016503040201");
  malformed(() => oidToBytes("1"), "bad-oid");
  malformed(() => oidToBytes("1.2.x"), "bad-oid");
});

test("asn1: the DER writer (lengths, integers, booleans, times, SET OF order)", () => {
  assert.equal(toHex(der.octets(new Uint8Array(127))).slice(0, 4), "047f");
  assert.equal(toHex(der.octets(new Uint8Array(128))).slice(0, 6), "048180");
  assert.equal(toHex(der.octets(new Uint8Array(300))).slice(0, 8), "0482012c");
  assert.equal(toHex(der.octets(new Uint8Array(65536))).slice(0, 10), "0483010000");
  assert.equal(toHex(der.int(0)), "020100");
  assert.equal(toHex(der.int(127)), "02017f");
  assert.equal(toHex(der.int(128)), "02020080");
  assert.equal(toHex(der.int(65537)), "0203010001");
  assert.equal(toHex(der.intFromBytes(fromHex("0000ff"))), "020200ff");
  assert.equal(toHex(der.intFromBytes(Uint8Array.of(0, 0, 0))), "020100");
  assert.equal(toHex(der.bool(true)), "0101ff");
  assert.equal(toHex(der.nul()), "0500");
  assert.equal(toHex(der.setOf(der.int(2), der.int(1))), "3106020101020102");
  // SET OF ordering: by encoding, the shorter one first when it is a prefix of the other
  assert.deepEqual(sortSetOf([Uint8Array.of(4, 2, 1, 1), Uint8Array.of(4, 1, 9), Uint8Array.of(4, 2, 1, 0)]).map(toHex), ["040109", "04020100", "04020101"]);
  assert.ok(compareBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0)) < 0);
  assert.equal(toHex(der.utcTime(new Date(Date.UTC(2026, 10, 16, 1, 2, 3)))), toHex(tlv(0x17, new TextEncoder().encode("261116010203Z"))));
  assert.equal(toHex(der.time(new Date(Date.UTC(2050, 0, 1)))).slice(0, 2), "18"); // GeneralizedTime from 2050 on
  assert.equal(toHex(der.time(new Date(Date.UTC(2049, 11, 31)))).slice(0, 2), "17");
  assert.equal(new TextDecoder().decode(der.time(new Date("2050-01-01T00:00:00Z")).subarray(2)), "20500101000000Z");
  assert.equal(toHex(der.ctx(0, der.int(2))), "a003020102");
  assert.equal(toHex(der.ctxPrimitive(1, Uint8Array.of(0x61))), "810161");
  // null and nested parts are skipped / flattened
  assert.equal(toHex(der.seq(der.int(1), null, [der.int(2), [der.int(3)]])), "3009020101020102020103");
  malformed(() => der.int(-1), "negative-integer");
});

test("asn1: typed readers", () => {
  const node = decode(der.seq(der.int(255), der.bool(false), der.utf8("Nguyễn"), der.bmp("Văn"), der.bitString(Uint8Array.of(0xc0), 6), der.oid("2.5.4.3"), der.printable("VN"), der.ia5("a@b.c")));
  assert.equal(node.child(0).integerNumber(), 255);
  assert.equal(node.child(0).integerHex(), "ff");
  assert.equal(node.child(1).boolean(), false);
  assert.equal(node.child(2).string(), "Nguyễn");
  assert.equal(node.child(2).stringType(), "UTF8String");
  assert.equal(node.child(3).string(), "Văn");
  assert.deepEqual(node.child(4).bitString(), { unusedBits: 6, bytes: Uint8Array.of(0xc0) });
  assert.equal(node.child(5).oid(), "2.5.4.3");
  assert.equal(node.child(6).stringType(), "PrintableString");
  assert.equal(node.child(7).string(), "a@b.c");
  malformed(() => node.child(0).oid(), "unexpected-type");
  malformed(() => node.child(2).octets(), "unexpected-type");
  malformed(() => node.child(99), "missing-element");
  assert.equal(node.context(0), null);
  // negative INTEGER (two's complement), and one that does not fit a number
  assert.equal(decode(fromHex("0201ff")).integerBigInt(), -1n);
  assert.equal(decode(fromHex("0201ff")).integerIsNegative(), true);
  malformed(() => decode(tlv(0x02, new Uint8Array(9).fill(0x7f))).integerNumber(), "integer-too-large");
  assert.equal(TAG.SEQUENCE, 16);
});

test("asn1: string types (BMP, Universal, Teletex as Latin-1, UTF-8 bytes in a 7-bit type) and times", () => {
  assert.equal(decode(tlv(0x1e, utf16beEncode("Hồng Nhung"))).string(), "Hồng Nhung");
  const utf32 = new Uint8Array(8);
  new DataView(utf32.buffer).setUint32(0, 0x1ed3);
  new DataView(utf32.buffer).setUint32(4, 0x1f600);
  assert.equal(decode(tlv(0x1c, utf32)).string(), String.fromCodePoint(0x1ed3, 0x1f600));
  assert.equal(decode(tlv(0x14, Uint8Array.of(0x43, 0xf4, 0x6e, 0x67))).string(), "Công"); // T61 read as Latin-1
  assert.equal(decode(tlv(0x13, new TextEncoder().encode("Nguyễn Văn An"))).string(), "Nguyễn Văn An"); // UTF-8 in a PrintableString
  assert.equal(decode(tlv(0x14, new TextEncoder().encode("Trần Thị Bình"))).string(), "Trần Thị Bình");
  const utc = (text) => decode(tlv(0x17, new TextEncoder().encode(text))).time().toISOString();
  const generalized = (text) => decode(tlv(0x18, new TextEncoder().encode(text))).time().toISOString();
  assert.equal(utc("261115235618Z"), "2026-11-15T23:56:18.000Z");
  assert.equal(utc("491231235959Z"), "2049-12-31T23:59:59.000Z");
  assert.equal(utc("500101000000Z"), "1950-01-01T00:00:00.000Z");
  assert.equal(utc("2611152356Z"), "2026-11-15T23:56:00.000Z");
  assert.equal(utc("261115235618+0700"), "2026-11-15T16:56:18.000Z");
  assert.equal(generalized("20500101000000Z"), "2050-01-01T00:00:00.000Z");
  assert.equal(generalized("20261115165619.250Z"), "2026-11-15T16:56:19.250Z");
  assert.ok(Number.isNaN(decode(tlv(0x17, new TextEncoder().encode("garbage"))).time().getTime()));
});

test("asn1: BER (indefinite lengths, chunked OCTET STRING) is read, measured exactly, and re-encoded as DER", () => {
  const inner = der.seq(der.oid("1.2.840.113549.1.7.1"), der.int(5));
  // SEQUENCE (indefinite) { OID, [0] (indefinite) { OCTET STRING (constructed, indefinite) { "ab" "cd" } }, SEQUENCE }
  const chunked = concatBytes(Uint8Array.of(0x24, 0x80), der.octets(Uint8Array.of(0x61, 0x62)), der.octets(Uint8Array.of(0x63, 0x64)), Uint8Array.of(0, 0));
  const ber = concatBytes(Uint8Array.of(0x30, 0x80), der.oid("1.2.3"), Uint8Array.of(0xa0, 0x80), chunked, Uint8Array.of(0, 0), inner, Uint8Array.of(0, 0));
  const node = decode(ber);
  assert.equal(node.indefinite, true);
  assert.equal(hasIndefiniteLength(node), true);
  assert.equal(node.end, ber.length);
  assert.deepEqual([...node.child(1).child(0).octets()], [0x61, 0x62, 0x63, 0x64]);
  // PDF /Contents: the value followed by zero padding. Stripping zeros would cut the end-of-contents octets.
  assert.equal(berLength(concatBytes(ber, new Uint8Array(500))), ber.length);
  assert.equal(berLength(concatBytes(inner, new Uint8Array(100))), inner.length);
  assert.equal(berLength(new Uint8Array(0)), -1);
  assert.equal(berLength(Uint8Array.of(0x30, 0x82, 0xff, 0xff, 0x00)), -1);
  // strict = DER: indefinite lengths and non-minimal length octets are refused
  malformed(() => decode(ber, { strict: true }), "not-der");
  malformed(() => decode(Uint8Array.of(0x04, 0x81, 0x01, 0x00), { strict: true }), "not-der");
  assert.doesNotThrow(() => decode(Uint8Array.of(0x04, 0x81, 0x01, 0x00)));
  const asDer = toDer(node);
  assert.equal(toHex(asDer), toHex(der.seq(der.oid("1.2.3"), der.ctx(0, der.octets(Uint8Array.of(0x61, 0x62, 0x63, 0x64))), inner)));
  assert.doesNotThrow(() => decodeExact(asDer, { strict: true }));
  // high tag numbers
  const high = decode(Uint8Array.of(0x9f, 0x81, 0x00, 0x01, 0x07));
  assert.deepEqual([high.tagClass, high.tag, [...high.content]], [2, 128, [7]]);
});

test("asn1: malformed input gives CERT_ASN1_MALFORMED with a reason: no crash, no hang", () => {
  const certificate = CERTS.signer1;
  malformed(() => decode(new Uint8Array(0)), "truncated");
  malformed(() => decode(Uint8Array.of(0x30)), "truncated");
  malformed(() => decode(Uint8Array.of(0x30, 0x84, 0xff, 0xff, 0xff, 0xff)), "truncated");
  malformed(() => decode(certificate.subarray(0, 100)), "truncated");
  malformed(() => decode(Uint8Array.of(0x04, 0x80, 0x00, 0x00)), "indefinite-primitive");
  malformed(() => decode(Uint8Array.of(0x30, 0x80, 0x02, 0x01)), "truncated");
  malformed(() => decode(Uint8Array.of(0x30, 0x87, 1, 1, 1, 1, 1, 1, 1)), "length-too-large");
  malformed(() => decode(Uint8Array.of(0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01)), "tag-too-large");
  malformed(() => decode("not bytes"), "not-bytes");
  malformed(() => decodeExact(concatBytes(der.nul(), Uint8Array.of(0))), "trailing-bytes");
  // deep nesting hits the depth limit instead of the JS stack
  let nested = der.nul();
  for (let i = 0; i < 200; i++) nested = der.seq(nested);
  malformed(() => decode(nested), "too-deep");
  // a bomb of indefinite-length openers hits the same limit, a wide structure the node limit
  malformed(() => decode(new Uint8Array(100000).fill(0x30).map((value, index) => (index % 2 ? 0x80 : 0x30))), "too-deep");
  malformed(() => decode(tlv(0x30, new Uint8Array(4000).map((value, index) => (index % 2 ? 0x00 : 0x05))), { maxNodes: 1000 }), "too-large");
  // random bytes and mutated certificates: only this error or a parsed node, quickly
  let seed = 20261116;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const started = performance.now();
  for (let i = 0; i < 2000; i++) {
    let bytes;
    if (i % 2) {
      bytes = Uint8Array.from({ length: 1 + Math.floor(random() * 300) }, () => Math.floor(random() * 256));
    } else {
      bytes = Uint8Array.from(certificate);
      for (let k = 0; k < 1 + (i % 5); k++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
    }
    try {
      const node = decode(bytes);
      assert.ok(node.end <= bytes.length);
    } catch (error) {
      assert.equal(error.code, ASN1_MALFORMED, `input ${i}: ${error && error.stack}`);
    }
  }
  assert.ok(performance.now() - started < 5000, "2000 hostile inputs in well under five seconds");
});

test("asn1: ECDSA signature conversion DER <-> r||s", () => {
  const raw = new Uint8Array(64);
  raw[0] = 0x80; // r with the high bit set needs a 00 sign octet in DER
  raw[31] = 1;
  raw[63] = 5; // s = 5: DER strips the leading zeros
  const derSignature = ecdsaP1363ToDer(raw);
  assert.equal(toHex(derSignature).slice(0, 12), "302602210080");
  assert.ok(equalBytes(ecdsaDerToP1363(derSignature, 32), raw));
  assert.equal(ecdsaDerToP1363(derSignature, 66).length, 132); // P-521 width
  malformed(() => ecdsaDerToP1363(derSignature, 16), "ecdsa-signature");
  malformed(() => ecdsaDerToP1363(der.seq(der.int(1)), 32), "ecdsa-signature");
  malformed(() => ecdsaP1363ToDer(new Uint8Array(63)), "ecdsa-signature");
  // node:crypto agrees: a signature it makes in DER converts to the r||s it makes in P1363
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const data = Buffer.from("xin chào");
  const p1363 = crypto.sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const asDer = ecdsaP1363ToDer(new Uint8Array(p1363));
  assert.equal(crypto.verify("sha256", data, { key: publicKey, dsaEncoding: "der" }, asDer), true);
  assert.ok(equalBytes(ecdsaDerToP1363(asDer, 32), p1363));
});

test("bytes: hex, base64, PEM, comparison, wiping", () => {
  const bytes = Uint8Array.from({ length: 300 }, (value, index) => (index * 7) & 0xff);
  assert.ok(equalBytes(fromHex(toHex(bytes)), bytes));
  assert.ok(equalBytes(fromHex("0A 0b\n0C"), Uint8Array.of(10, 11, 12)));
  assert.ok(equalBytes(fromHex("abc"), Uint8Array.of(0xab, 0xc0))); // odd length: padded like a PDF hex string
  assert.ok(equalBytes(fromBase64(toBase64(bytes)), bytes));
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
  const pem = toPem(bytes, "CERTIFICATE");
  assert.match(pem, /^-----BEGIN CERTIFICATE-----\n/);
  assert.ok(equalBytes(fromPem(pem)[0].der, bytes));
  assert.deepEqual(fromPem("-----BEGIN X-----\n!!!\n-----END X-----"), []);
  assert.equal(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2)), false);
  assert.equal(equalBytes(null, Uint8Array.of(1)), false);
  assert.equal(bitLength(Uint8Array.of(0, 0x01, 0x00)), 9);
  assert.equal(bitLength(Uint8Array.of(0, 0)), 0);
  assert.deepEqual([...stripLeadingZeros(Uint8Array.of(0, 0, 5, 0))], [5, 0]);
  assert.deepEqual([...stripLeadingZeros(Uint8Array.of(0, 0))], [0]);
  assert.throws(() => latin1Encode(String.fromCharCode(0x100)), RangeError);
  assert.equal(asBytes("text"), null);
  assert.equal(asBytes(bytes), bytes);
  assert.equal(asBytes(bytes.buffer).length, 300);
  assert.equal(asBytes(new DataView(bytes.buffer, 10, 20)).length, 20);
  const secret = Uint8Array.of(1, 2, 3);
  wipe(secret);
  assert.deepEqual([...secret], [0, 0, 0]);
  assert.doesNotThrow(() => wipe(null));
});
