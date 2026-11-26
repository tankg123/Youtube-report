// The bundled fonts as files (public/pdf-fonts against its manifest, and against what the PDF library embeds),
// and the font registry with a made-up fetch / FontFace: its checks, its errors and its bookkeeping.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { DISABLED_FONT_FEATURES, TEXT_FONT_FEATURE_SETTINGS, pdfFontFeatures, quantizeFontSize } from "../src/pages/pdfEditor/engine/textRules.js";
import { RETRY_AFTER_MS, createFontRegistry, sharedFontRegistry } from "../src/pages/pdfEditor/text/fonts.js";
import * as textModule from "../src/pages/pdfEditor/text/index.js";
import { hasGlyph } from "../src/pages/pdfEditor/text/fontSupport.js";
import { CSS_FAMILY_PREFIX, LAYOUT_SCALE, TEXT_BOX_ATTRIBUTES, TEXT_BOX_STYLE, TEXT_LANG, cssFaceOf, fontStack, layoutKey, layoutScaleTransform, textBoxStyle } from "../src/pages/pdfEditor/text/textStyle.js";
import { FONT_DIR, fontBytes, fontManifest, pdfLib, fontkit } from "./helpers/pdfTestKit.mjs";
import { VIETNAMESE_LETTERS, VIETNAMESE_PANGRAM, makeTextObject, parsedFont } from "./helpers/pdfTextKit.mjs";

const TEXT_FACES = fontManifest.fonts.filter((font) => font.role === "text");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// --- the files ---

test("the font directory holds exactly the files of the manifest", () => {
  const expected = new Set(["manifest.json", ...fontManifest.fonts.map((font) => font.file), ...fontManifest.licences.map((licence) => licence.file)]);
  assert.deepEqual(new Set(fs.readdirSync(FONT_DIR)), expected);
  for (const name of expected) assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*\.(ttf|txt|json)$/, name);
});

test("every font file matches its manifest entry: size, SHA-256, metrics and the exact character map", () => {
  for (const entry of fontManifest.fonts) {
    const bytes = fontBytes(entry.id);
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(sha256(bytes), entry.sha256, entry.file);
    const font = parsedFont(entry.id);
    assert.equal(font.unitsPerEm, entry.unitsPerEm, entry.file);
    assert.equal(font["OS/2"].typoAscender, entry.metrics.typoAscender, entry.file);
    assert.equal(font["OS/2"].typoDescender, entry.metrics.typoDescender, entry.file);
    assert.equal(font["OS/2"].winAscent, entry.metrics.winAscent, entry.file);
    assert.equal(font["OS/2"].winDescent, entry.metrics.winDescent, entry.file);
    assert.equal(font.hhea.ascent, entry.metrics.hheaAscender, entry.file);
    assert.equal(font.post.underlinePosition, entry.metrics.underlinePosition, entry.file);
    assert.equal(font.post.underlineThickness, entry.metrics.underlineThickness, entry.file);
    // the ranges reproduce the character map: nothing more, nothing less
    // (fontkit also lists U+FFFF, the end marker of a format 4 table, which maps to .notdef)
    const mapped = new Set(font.characterSet.filter((codePoint) => font.glyphForCodePoint(codePoint).id !== 0));
    let count = 0;
    for (const [first, last] of entry.codePointRanges) {
      for (let codePoint = first; codePoint <= last; codePoint += 1) {
        count += 1;
        assert.ok(mapped.has(codePoint), `${entry.file} U+${codePoint.toString(16)}`);
      }
    }
    assert.equal(count, mapped.size, entry.file);
    for (const codePoint of [0x41, 0x1ebf, 0x20ab, 0x4e2d, 0x1f600, 0x0e01, 0x2192, 0x416]) assert.equal(hasGlyph(entry, codePoint), font.hasGlyphForCodePoint(codePoint), `${entry.file} U+${codePoint.toString(16)}`);
  }
});

test("no Vietnamese letter is missing, empty or shared with another letter in any face", () => {
  for (const entry of fontManifest.fonts) {
    const font = parsedFont(entry.id);
    const glyphs = new Set();
    for (const codePoint of VIETNAMESE_LETTERS) {
      const glyph = font.glyphForCodePoint(codePoint);
      assert.ok(glyph.id > 0, `${entry.file} U+${codePoint.toString(16)} maps to .notdef`);
      assert.ok(glyph.advanceWidth > 0, `${entry.file} U+${codePoint.toString(16)} has no advance`);
      assert.ok(glyph.path.commands.length > 0, `${entry.file} U+${codePoint.toString(16)} is empty`);
      glyphs.add(glyph.id);
    }
    assert.equal(glyphs.size, 134, entry.file);
  }
});

test("glyph records have even length (the PDF library's subsetter corrupts fonts that have odd ones)", () => {
  for (const entry of fontManifest.fonts) {
    const offsets = parsedFont(entry.id).loca.offsets;
    for (let glyph = 0; glyph + 1 < offsets.length; glyph += 1) assert.equal((offsets[glyph + 1] - offsets[glyph]) % 2, 0, `${entry.file} glyph ${glyph}`);
  }
});

test("manifest: layout features cover every script and language system; no face has an English or Vietnamese one", () => {
  for (const entry of fontManifest.fonts) {
    const font = parsedFont(entry.id);
    const tags = new Set();
    for (const table of ["GSUB", "GPOS"]) {
      for (const record of font[table]?.featureList ?? []) tags.add(record.tag);
    }
    assert.deepEqual(entry.layoutFeatures, [...tags].sort(), entry.id);
    assert.ok(entry.localisedForms.every((key) => entry.languageSystems.includes(key)), entry.id);
    assert.equal(entry.layoutFeatures.includes("locl"), entry.localisedForms.length > 0, entry.id);
    // the pinned text box language (and Vietnamese) must select no language system of its own
    for (const key of entry.languageSystems) assert.ok(!/\/(ENG|VIT)$/.test(key), `${entry.id} has ${key}`);
  }
  assert.equal(TEXT_LANG, "en");
  const withLocalisedForms = [...new Set(fontManifest.fonts.filter((font) => font.localisedForms.length).map((font) => font.family))];
  assert.deepEqual(withLocalisedForms, ["Arimo", "Be Vietnam Pro", "Dancing Script", "Great Vibes", "Allura", "Charm"]);
});

test("licence texts are shipped for every family, are the OFL, and are byte-identical to the recorded hash", () => {
  const families = new Set(fontManifest.fonts.map((font) => font.family));
  assert.deepEqual(new Set(fontManifest.licences.map((licence) => licence.family)), families);
  for (const licence of fontManifest.licences) {
    const bytes = fs.readFileSync(path.join(FONT_DIR, licence.file));
    assert.equal(sha256(bytes), licence.sha256, licence.file);
    assert.match(bytes.toString("utf8"), /SIL Open Font License, Version 1\.1/, licence.file);
  }
  // the two upstream inconsistencies between licence text and font are recorded, not "fixed"
  assert.deepEqual(fontManifest.licences.filter((licence) => !licence.copyrightMatches).map((licence) => licence.family), ["Arimo", "Great Vibes"]);
  // a Reserved Font Name forbids shipping a modified file under the same name
  for (const font of fontManifest.fonts.filter((entry) => entry.reservedFontName)) assert.equal(font.sha256, font.sourceSha256, `${font.file} must be the unmodified upstream file`);
});

test("manifest: ink extents show which fonts overshoot their ascent (what a clipping container must allow for)", () => {
  const byId = Object.fromEntries(fontManifest.fonts.map((font) => [font.id, font]));
  const overshoot = (font) => (font.metrics.inkExtents.above - (font.metrics.useTypoMetrics ? font.metrics.typoAscender : font.metrics.winAscent)) / font.unitsPerEm;
  assert.ok(overshoot(byId["be-vietnam-pro-regular"]) > 0.15); // stacked capitals reach 1.2 em, the ascent is 1.0
  assert.ok(overshoot(byId["arimo-regular"]) <= 0);
});

// --- the rules both sides share ---

test("the PDF feature switches mirror the text box style: kerning, ligatures and fractions off on both sides", () => {
  const a = pdfFontFeatures();
  const b = pdfFontFeatures();
  assert.notEqual(a, b); // a fresh object per call: fontkit mutates it
  assert.deepEqual(Object.keys(a).sort(), [...DISABLED_FONT_FEATURES].sort());
  for (const tag of ["kern", "liga", "clig", "calt", "dlig", "frac", "numr", "dnom"]) {
    assert.equal(a[tag], false, tag);
    assert.ok(TEXT_BOX_STYLE.fontFeatureSettings.includes(`"${tag}" 0`), tag);
  }
  assert.equal(TEXT_BOX_STYLE.fontFeatureSettings, TEXT_FONT_FEATURE_SETTINGS);
  assert.equal(TEXT_BOX_STYLE.fontKerning, "none");
  assert.equal(TEXT_BOX_STYLE.fontVariantLigatures, "none");
  assert.equal(TEXT_BOX_STYLE.fontSynthesis, "none");
  assert.deepEqual(TEXT_BOX_ATTRIBUTES, { lang: "en", dir: "ltr", translate: "no" });
  assert.ok(Object.isFrozen(TEXT_BOX_STYLE));
});

test("with those switches fontkit writes one glyph per character with its plain advance, also around a fraction slash", () => {
  const slash = String.fromCodePoint(0x2044);
  const samples = [`1${slash}2`, `5${slash}`, `${slash}8`, `a${slash}2`, "office affluent fi fl ffi", "AVATAR To Ty WA", VIETNAMESE_PANGRAM, "fi fiyat iİıI Şş"];
  for (const entry of TEXT_FACES) {
    const font = parsedFont(entry.id);
    for (const text of samples) {
      if (![...text].every((char) => hasGlyph(entry, char.codePointAt(0)))) continue;
      const run = font.layout(text, pdfFontFeatures());
      const expected = [...text].map((char) => font.glyphForCodePoint(char.codePointAt(0)));
      assert.deepEqual(run.glyphs.map((glyph) => glyph.id), expected.map((glyph) => glyph.id), `${entry.id} ${JSON.stringify(text)}`);
      assert.deepEqual(run.positions.map((position) => position.xAdvance), expected.map((glyph) => glyph.advanceWidth), `${entry.id} ${JSON.stringify(text)}`);
    }
  }
});

test("subset: true embeds every glyph of every bundled font undamaged", async () => {
  // text extraction alone does not catch a corrupted subset: the font program is taken back out of the saved
  // PDF and every outline and advance is compared with the source font through the PDF's own ToUnicode map
  const { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = pdfLib;
  const lines = [VIETNAMESE_PANGRAM, VIETNAMESE_LETTERS.map((codePoint) => String.fromCodePoint(codePoint)).join(""), "The quick brown fox jumps over the lazy dog 0123456789 (.,;:!?) “” – — … •"];
  const wanted = new Set(lines.join("").replace(/\s/g, ""));
  for (const entry of fontManifest.fonts) {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const embedded = await doc.embedFont(fontBytes(entry.id), { subset: true, features: pdfFontFeatures() });
    const page = doc.addPage([900, 200]);
    lines.forEach((line, index) => page.drawText(line, { x: 10, y: 170 - index * 30, size: 6, font: embedded }));
    const saved = await PDFDocument.load(await doc.save());
    let program = null;
    let toUnicode = null;
    for (const [, object] of saved.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      const fontFile = object.get(PDFName.of("FontFile2"));
      if (fontFile) program = decodePDFRawStream(saved.context.lookup(fontFile, PDFRawStream)).decode();
      const map = object.get(PDFName.of("ToUnicode"));
      if (map) toUnicode = Buffer.from(decodePDFRawStream(saved.context.lookup(map, PDFRawStream)).decode()).toString("latin1");
    }
    assert.ok(program && toUnicode, `${entry.file}: font program and ToUnicode map found in the PDF`);
    const glyphToCodePoint = new Map();
    for (const section of toUnicode.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const match of section[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const units = match[2].match(/.{4}/g).map((hex) => parseInt(hex, 16));
        glyphToCodePoint.set(parseInt(match[1], 16), String.fromCharCode(...units).codePointAt(0));
      }
    }
    const source = parsedFont(entry.id);
    const subset = fontkit.create(Buffer.from(program));
    let checked = 0;
    const damaged = [];
    for (const [glyphId, codePoint] of glyphToCodePoint) {
      if (!wanted.has(String.fromCodePoint(codePoint))) continue;
      checked += 1;
      const original = source.glyphForCodePoint(codePoint);
      const copy = subset.getGlyph(glyphId);
      let same;
      try {
        same = original.path.toSVG() === copy.path.toSVG() && original.advanceWidth === copy.advanceWidth;
      } catch {
        same = false;
      }
      if (!same) damaged.push(codePoint);
    }
    assert.equal(checked, wanted.size, `${entry.file}: ${checked} of ${wanted.size} characters found in the PDF`);
    assert.deepEqual(damaged, [], `${entry.file}: damaged glyphs`);
  }
});

// --- text style ---

test("cssFaceOf names the face the manifest registers, for all 20 fonts", () => {
  for (const entry of fontManifest.fonts) {
    const face = cssFaceOf(entry.id);
    assert.ok(face, entry.id);
    assert.equal(face.fontFamily, entry.cssFamily, entry.id);
    assert.equal(face.fontWeight, entry.weight, entry.id);
    assert.equal(face.fontStyle, entry.italic ? "italic" : "normal", entry.id);
    assert.ok(entry.cssFamily.startsWith(CSS_FAMILY_PREFIX));
    if (entry.role === "text") assert.equal(face.category, entry.category, entry.id);
  }
  for (const unknown of ["arimo", "arial-regular", "", undefined, "arimo-black"]) assert.equal(cssFaceOf(unknown), null, String(unknown));
});

test("textBoxStyle: the layout scale, the font list with the fallback face, the width rule", () => {
  assert.equal(LAYOUT_SCALE, 8);
  const wrapped = makeTextObject({ font: "be-vietnam-pro", bold: true, italic: true, size: 10.555, lineHeight: 1.15, align: "right", color: "#1d4ed8", autoWidth: false, text: "abc", frame: { w: 123.5, h: 20 } });
  const style = textBoxStyle(wrapped);
  assert.equal(style.fontFamily, "\"PDF Be Vietnam Pro\", \"PDF Arimo\", sans-serif");
  assert.equal(style.fontWeight, 700);
  assert.equal(style.fontStyle, "italic");
  assert.equal(style.fontSize, `${quantizeFontSize(10.555) * 8}px`); // the same quantised size goes to the PDF
  assert.equal(parseFloat(style.lineHeight), quantizeFontSize(10.555) * 1.15 * 8);
  assert.equal(style.width, "988px");
  assert.equal(style.whiteSpace, "pre-wrap");
  assert.equal(style.textAlign, "right");
  assert.equal(style.color, "#1d4ed8");
  for (const [name, value] of Object.entries(TEXT_BOX_STYLE)) assert.equal(style[name], value, name);
  const auto = textBoxStyle({ ...wrapped, autoWidth: true });
  assert.equal(auto.width, "max-content");
  assert.equal(auto.whiteSpace, "pre");
  assert.equal(textBoxStyle({ ...wrapped, autoWidth: true }, { width: 50 }).width, "400px");
  assert.equal(fontStack({ font: "arimo", bold: false, italic: false }), "\"PDF Arimo\", sans-serif");
  assert.equal(fontStack({ font: "tinos", bold: false, italic: true }), "\"PDF Tinos\", \"PDF Arimo\", serif");
  assert.equal(fontStack({ font: "cousine", bold: true, italic: false }), "\"PDF Cousine\", \"PDF Arimo\", monospace");
});

test("layoutKey changes with every field that decides a layout and with nothing else", () => {
  const base = makeTextObject({ text: "Hợp đồng", autoWidth: false, frame: { x: 10, y: 20, w: 200, h: 30, rot: 0 } });
  const key = layoutKey(base);
  for (const patch of [{ text: "Hợp đồng " }, { font: "tinos" }, { bold: true }, { italic: true }, { size: 12.01 }, { lineHeight: 1.5 }, { align: "center" }, { autoWidth: true }, { underline: true }, { frame: { ...base.frame, w: 201 } }]) {
    assert.notEqual(layoutKey({ ...base, ...patch }), key, JSON.stringify(patch));
  }
  for (const patch of [{ color: "#ff0000" }, { opacity: 0.5 }, { id: "other" }, { pageId: "p9" }, { size: 12.001 }, { frame: { ...base.frame, x: 99, y: 1, h: 77, rot: 45 } }]) {
    assert.equal(layoutKey({ ...base, ...patch }), key, JSON.stringify(patch));
  }
  // the width of an autoWidth box follows the text: it is not an input
  assert.equal(layoutKey({ ...base, autoWidth: true }), layoutKey({ ...base, autoWidth: true, frame: { ...base.frame, w: 5 } }));
});

test("layoutScaleTransform keeps the translation and divides the linear part by the layout scale", () => {
  assert.equal(layoutScaleTransform([4, 0, 0, 4, 10.5, 20.25]), "matrix(0.5, 0, 0, 0.5, 10.5, 20.25)");
  assert.equal(layoutScaleTransform([0, 2, -2, 0, 7, 9]), "matrix(0, 0.25, -0.25, 0, 7, 9)");
});

// --- the registry ---

class FakeFontFace {
  constructor(family, source, descriptors) {
    this.family = family;
    this.source = source;
    this.descriptors = descriptors;
    this.status = "unloaded";
    FakeFontFace.created.push(this);
  }

  async load() {
    // what a browser does with bytes that are not a font
    if (new Uint8Array(this.source)[0] !== 0x00) {
      const error = new Error("Could not load font");
      error.name = "SyntaxError";
      throw error;
    }
    this.status = "loaded";
    return this;
  }
}
FakeFontFace.created = [];

function harness(overrides = {}) {
  FakeFontFace.created = [];
  const requests = [];
  const added = new Set();
  const responses = new Map();
  const clock = { time: 1000 };
  const fetchFn = async (url) => {
    requests.push(url);
    if (responses.has(url)) return responses.get(url)();
    const name = url.split("/").pop();
    const file = path.join(FONT_DIR, name);
    if (!url.startsWith("/app/pdf-fonts/") || !fs.existsSync(file)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = fs.readFileSync(file);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const registry = createFontRegistry({ baseUrl: "/app", fetch: fetchFn, FontFace: FakeFontFace, fontSet: { add: (face) => added.add(face), delete: (face) => added.delete(face) }, now: () => clock.time, ...overrides });
  // a failed download is not repeated at once: `later()` lets the waiting time pass
  const later = () => {
    clock.time += RETRY_AFTER_MS + 1;
  };
  return { registry, requests, added, responses, clock, later };
}

const rejectsWith = (promise, code, params) => assert.rejects(promise, (error) => {
  assert.ok(isPdfEditorError(error), String(error));
  assert.equal(error.code, code);
  if (params) assert.deepEqual(error.params, params);
  return true;
});

test("registry: a face is fetched once, checked, registered from the same bytes, and reported loaded", async () => {
  const { registry, requests, added } = harness();
  assert.equal(registry.manifest, null);
  assert.equal(registry.isLoaded("arimo-bold-italic"), false);
  assert.equal(registry.getVersion(), 0);
  const seen = [];
  const unsubscribe = registry.subscribe((key) => seen.push(key));
  const [first, second] = await Promise.all([registry.ensureFont("arimo-bold-italic"), registry.ensureFont("arimo-bold-italic")]);
  assert.equal(first, second);
  assert.deepEqual(requests, ["/app/pdf-fonts/manifest.json", "/app/pdf-fonts/arimo-bold-italic.ttf"]);
  assert.equal(first.fontKey, "arimo-bold-italic");
  assert.equal(first.cssFamily, "PDF Arimo");
  assert.deepEqual(Buffer.from(first.bytes), Buffer.from(fontBytes("arimo-bold-italic")));
  assert.equal(FakeFontFace.created.length, 1);
  const face = FakeFontFace.created[0];
  assert.equal(face.family, "PDF Arimo");
  assert.deepEqual(face.descriptors, { weight: "700", style: "italic" });
  assert.equal(face.source, first.bytes.buffer); // the screen and the PDF get the SAME bytes
  assert.ok(added.has(face));
  assert.equal(registry.isLoaded("arimo-bold-italic"), true);
  assert.equal(registry.isLoaded("arimo-regular"), false);
  assert.deepEqual(seen, ["arimo-bold-italic"]);
  assert.equal(registry.getVersion(), 1);
  assert.equal(registry.manifest.fonts.length, 20);
  // later calls use what is there
  assert.equal(await registry.ensureFont("arimo-bold-italic"), first);
  assert.equal(requests.length, 2);
  // the export engines get a private copy
  const copy = await registry.getFontBytes("arimo-bold-italic");
  assert.notEqual(copy, first.bytes);
  assert.notEqual(copy.buffer, first.bytes.buffer);
  assert.deepEqual(Buffer.from(copy), Buffer.from(first.bytes));
  unsubscribe();
  await registry.ensureFonts(["tinos-regular", "tinos-regular", "arimo-bold-italic"]);
  assert.deepEqual(seen, ["arimo-bold-italic"]);
  assert.equal(registry.getVersion(), 2);
  assert.equal(registry.isLoaded("tinos-regular"), true);
  registry.dispose();
  assert.equal(added.size, 0);
  assert.equal(registry.isLoaded("tinos-regular"), false);
});

test("registry: faceOf answers before anything is loaded and agrees with the manifest afterwards", async () => {
  const { registry } = harness();
  const before = fontManifest.fonts.map((font) => registry.faceOf(font.id));
  await registry.loadManifest();
  fontManifest.fonts.forEach((font, index) => {
    assert.deepEqual(registry.faceOf(font.id), before[index], font.id);
    assert.deepEqual(registry.faceOf(font.id), { fontFamily: font.cssFamily, fontWeight: font.weight, fontStyle: font.italic ? "italic" : "normal" });
  });
  assert.equal(registry.faceOf("no-such-font"), null);
});

test("registry: errors carry codes; a failed download is tried again, but not at once", async () => {
  const { registry, requests, responses, added, later } = harness();
  await rejectsWith(registry.ensureFont("arial-regular"), "TEXT_FONT_UNKNOWN", { font: "arial-regular" });
  // the server answers 503
  const url = "/app/pdf-fonts/cousine-regular.ttf";
  responses.set(url, () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }));
  await rejectsWith(registry.ensureFont("cousine-regular"), "TEXT_FONT_FETCH_FAILED", { font: "cousine-regular", status: 503 });
  assert.equal(registry.isLoaded("cousine-regular"), false);
  // a box that renders, or a field that is typed in, asks again and again: no request per keystroke
  for (let attempt = 0; attempt < 5; attempt += 1) await rejectsWith(registry.ensureFont("cousine-regular"), "TEXT_FONT_FETCH_FAILED", { font: "cousine-regular", status: 503 });
  await rejectsWith(registry.getFontBytes("cousine-regular"), "TEXT_FONT_FETCH_FAILED");
  assert.equal(requests.filter((request) => request === url).length, 1);
  // other faces are not held back
  assert.equal((await registry.ensureFont("cousine-bold")).fontKey, "cousine-bold");
  // no answer at all
  later();
  responses.set(url, () => {
    throw new TypeError("Failed to fetch");
  });
  await rejectsWith(registry.ensureFont("cousine-regular"), "TEXT_FONT_FETCH_FAILED", { font: "cousine-regular", status: 0 });
  // a truncated file
  later();
  const real = fontBytes("cousine-regular");
  responses.set(url, () => ({ ok: true, status: 200, arrayBuffer: async () => real.buffer.slice(0, 5000) }));
  await rejectsWith(registry.ensureFont("cousine-regular"), "TEXT_FONT_CORRUPT", { font: "cousine-regular" });
  // the right size with one byte flipped: only the hash sees it
  later();
  responses.set(url, () => {
    const copy = new Uint8Array(real);
    copy[copy.length - 100] ^= 0xff;
    return { ok: true, status: 200, arrayBuffer: async () => copy.buffer };
  });
  await rejectsWith(registry.ensureFont("cousine-regular"), "TEXT_FONT_CORRUPT", { font: "cousine-regular" });
  assert.equal(FakeFontFace.created.length, 1); // cousine-bold only
  assert.equal(added.size, 1);
  // and then the file is fine: the next call after the waiting time succeeds
  responses.delete(url);
  await rejectsWith(registry.ensureFont("cousine-regular"), "TEXT_FONT_CORRUPT");
  later();
  const record = await registry.ensureFont("cousine-regular");
  assert.equal(record.fontKey, "cousine-regular");
  assert.equal(registry.isLoaded("cousine-regular"), true);
  assert.equal(requests.filter((request) => request === url).length, 5);
});

test("registry: without WebCrypto the size is still checked, and bytes the browser refuses are reported as corrupt", async () => {
  const flipped = () => {
    const copy = new Uint8Array(fontBytes("charm-regular"));
    copy[0] = 0x4f; // not a TrueType header any more: the made-up FontFace refuses it, as a browser would
    return { ok: true, status: 200, arrayBuffer: async () => copy.buffer };
  };
  const { registry, responses, added, later } = harness({ subtle: null });
  responses.set("/app/pdf-fonts/charm-regular.ttf", flipped);
  await rejectsWith(registry.ensureFont("charm-regular"), "TEXT_FONT_CORRUPT", { font: "charm-regular" });
  assert.equal(added.size, 0);
  assert.equal(registry.isLoaded("charm-regular"), false);
  later();
  responses.set("/app/pdf-fonts/charm-regular.ttf", () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(12) }));
  await rejectsWith(registry.ensureFont("charm-regular"), "TEXT_FONT_CORRUPT");
});

test("registry: a missing or foreign manifest is an error of its own and can be retried", async () => {
  const { registry, responses, requests, later } = harness();
  const url = "/app/pdf-fonts/manifest.json";
  responses.set(url, () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
  await rejectsWith(registry.loadManifest(), "TEXT_FONT_MANIFEST_FAILED", { status: 404 });
  await rejectsWith(registry.ensureFont("arimo-regular"), "TEXT_FONT_MANIFEST_FAILED", { status: 404 });
  assert.equal(requests.length, 1); // not asked again at once
  later();
  // a single-page-app fallback answers 200 with the index page
  responses.set(url, () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("<!doctype html><html></html>").buffer }));
  await rejectsWith(registry.ensureFont("arimo-regular"), "TEXT_FONT_MANIFEST_FAILED", { status: 200 });
  later();
  responses.set(url, () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("{\"fonts\":[{\"id\":1}]}").buffer }));
  await rejectsWith(registry.loadManifest(), "TEXT_FONT_MANIFEST_FAILED", { status: 200 });
  assert.equal(registry.manifest, null);
  later();
  responses.delete(url);
  assert.equal((await registry.loadManifest()).fonts.length, 20);
  assert.equal(await registry.loadManifest(), registry.manifest);
  assert.equal(requests.filter((request) => request === url).length, 4);
});

test("registry: a listener that throws does not break loading, and the base URL may end with a slash", async () => {
  const { registry, requests } = harness({ baseUrl: "/app/" });
  const seen = [];
  registry.subscribe(() => {
    throw new Error("listener failure");
  });
  registry.subscribe((key) => seen.push(key));
  await registry.ensureFont("allura-regular");
  assert.deepEqual(seen, ["allura-regular"]);
  assert.deepEqual(requests, ["/app/pdf-fonts/manifest.json", "/app/pdf-fonts/allura-regular.ttf"]);
});

test("registry: the shared registry of a page is one object per base URL", () => {
  assert.equal(sharedFontRegistry("/shared-a/"), sharedFontRegistry("/shared-a/"));
  assert.notEqual(sharedFontRegistry("/shared-a/"), sharedFontRegistry("/shared-b/"));
  assert.equal(sharedFontRegistry("/shared-a/").isLoaded("arimo-regular"), false);
});

test("the entry of the module loads without a browser and exports its API", () => {
  // nothing in the module may touch the DOM at import time: other suites import it under node --test
  for (const name of ["CODES", "normalizeText", "isBlankText", "checkText", "splitRuns", "fontsThatCover", "hasGlyph", "createFontRegistry", "sharedFontRegistry", "createTextLayoutService", "buildTextLayout", "frameForLayout", "textAnchor", "withRaster", "rasterizeTextBox", "renderTypedSignature", "LAYOUT_SCALE", "textBoxStyle", "cssFaceOf", "layoutScaleTransform"]) {
    assert.ok(name in textModule, name);
  }
  assert.equal(typeof textModule.createTextLayoutService, "function");
  assert.throws(() => textModule.createTextLayoutService({}), TypeError);
});
