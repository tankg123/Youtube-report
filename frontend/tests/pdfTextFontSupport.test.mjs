// The pure part of the text module: normalising input, glyph coverage from the real manifest, the decision
// between real text, a fallback run and a picture.
import test from "node:test";
import assert from "node:assert/strict";
import { CODES } from "../src/pages/pdfEditor/text/codes.js";
import {
  TAB_SPACES,
  checkText,
  exportProblem,
  facesNeeded,
  fallbackKeyFor,
  findFont,
  fontPlan,
  fontsThatCover,
  graphemes,
  hasGlyph,
  hasRtl,
  isBlankText,
  isFormatCharacter,
  needsRunShaping,
  normalizeText,
  splitRuns
} from "../src/pages/pdfEditor/text/fontSupport.js";
import { FALLBACK_TEXT_FONT, SIGNATURE_FONTS, TEXT_FONTS, fontKeyOf, validateObject } from "../src/pages/pdfEditor/model/schema.js";
import { isPdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import { fontManifest } from "./helpers/pdfTestKit.mjs";
import { VIETNAMESE_LETTERS, VIETNAMESE_PANGRAM, fromCodePoints as s, makeTextObject } from "./helpers/pdfTextKit.mjs";

const TEXT_FACES = fontManifest.fonts.filter((font) => font.role === "text");
const SIGNATURE_FACES = fontManifest.fonts.filter((font) => font.role === "signature");
const LF = s(0x0a);
const CR = s(0x0d);

const SEQUENCES = {
  family: s(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
  heart: s(0x2764, 0xfe0f),
  keycap: `1${s(0xfe0f, 0x20e3)}`,
  flag: s(0x1f1fb, 0x1f1f3),
  skinTone: s(0x1f44d, 0x1f3fd),
  subdivisionFlag: s(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f),
  copyrightEmoji: s(0xa9, 0xfe0f),
  persian: s(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645),
  hindiConjunct: s(0x915, 0x94d, 0x200d, 0x937),
  sinhalaConjunct: s(0xdc1, 0xdca, 0x200d, 0xdbb, 0xdd3),
  arabicWithMark: `${s(0x627, 0x200e)}b`
};

test("the manifest lists four faces for each text family and one for each signature family", () => {
  assert.equal(fontManifest.fonts.length, 20);
  for (const family of TEXT_FONTS) {
    for (const bold of [false, true]) {
      for (const italic of [false, true]) {
        const entry = findFont(fontManifest, fontKeyOf(family.id, bold, italic));
        assert.ok(entry, fontKeyOf(family.id, bold, italic));
        assert.equal(entry.role, "text");
        assert.equal(entry.family, family.family);
        assert.equal(entry.weight, bold ? 700 : 400);
        assert.equal(entry.italic, italic);
      }
    }
  }
  for (const family of SIGNATURE_FONTS) {
    const entry = findFont(fontManifest, `${family.id}-regular`);
    assert.ok(entry, family.id);
    assert.equal(entry.role, "signature");
  }
  assert.equal(findFont(fontManifest, "comic-sans-regular"), null);
});

test("all 134 Vietnamese letters are covered by every bundled face, and every text face writes Vietnamese on its own", () => {
  assert.equal(VIETNAMESE_LETTERS.length, 134);
  assert.equal(new Set(VIETNAMESE_LETTERS).size, 134);
  const letters = VIETNAMESE_LETTERS.map((codePoint) => String.fromCodePoint(codePoint)).join("");
  assert.equal(letters, letters.normalize("NFC"));
  for (const font of fontManifest.fonts) {
    for (const codePoint of VIETNAMESE_LETTERS) assert.ok(hasGlyph(font, codePoint), `${font.id} lacks U+${codePoint.toString(16)}`);
    assert.ok(hasGlyph(font, 0x20ab), `${font.id} lacks the dong sign`);
    for (let codePoint = 0x20; codePoint <= 0x7e; codePoint += 1) assert.ok(hasGlyph(font, codePoint), `${font.id} lacks U+${codePoint.toString(16)}`);
  }
  for (const font of TEXT_FACES) {
    for (const text of [letters, normalizeText(VIETNAMESE_PANGRAM), normalizeText(VIETNAMESE_PANGRAM.normalize("NFD")), "“Hợp đồng” – ‘số’ 12… • —"]) {
      assert.deepEqual(checkText(fontManifest, font.id, text), { ok: true, fallback: [], unsupported: [] }, font.id);
      assert.deepEqual(splitRuns(fontManifest, font.id, text), [{ text, font: font.id }], font.id);
      assert.deepEqual(facesNeeded(fontManifest, font.id, text), [font.id]);
    }
  }
  assert.deepEqual(fontsThatCover(fontManifest, letters).sort(), TEXT_FACES.map((font) => font.id).sort());
  assert.deepEqual(fontsThatCover(fontManifest, letters, "signature").sort(), SIGNATURE_FACES.map((font) => font.id).sort());
});

test("hasGlyph searches the manifest ranges exactly", () => {
  for (const font of fontManifest.fonts) {
    let count = 0;
    let previous = -1;
    for (const [first, last] of font.codePointRanges) {
      assert.ok(first > previous + 1 || previous === -1, `${font.id}: ranges are sorted and not adjacent`);
      assert.ok(hasGlyph(font, first) && hasGlyph(font, last));
      assert.ok(!hasGlyph(font, first - 1), `${font.id} U+${(first - 1).toString(16)}`);
      assert.ok(!hasGlyph(font, last + 1), `${font.id} U+${(last + 1).toString(16)}`);
      count += last - first + 1;
      previous = last;
    }
    assert.equal(count, font.codePoints, font.id);
    for (const codePoint of [0x4e2d, 0x1f600, 0x0e01, 0x05d0, 0x0627, 0x2713, 0x2611]) assert.equal(hasGlyph(font, codePoint), false, `${font.id} U+${codePoint.toString(16)}`);
  }
});

test("the fallback face is Arimo in the weight and slant of the box", () => {
  assert.equal(FALLBACK_TEXT_FONT, "arimo");
  assert.equal(fallbackKeyFor(fontManifest, "be-vietnam-pro-regular"), "arimo-regular");
  assert.equal(fallbackKeyFor(fontManifest, "be-vietnam-pro-bold-italic"), "arimo-bold-italic");
  assert.equal(fallbackKeyFor(fontManifest, "tinos-italic"), "arimo-italic");
  assert.equal(fallbackKeyFor(fontManifest, "cousine-bold"), "arimo-bold");
  for (const style of ["regular", "bold", "italic", "bold-italic"]) assert.equal(fallbackKeyFor(fontManifest, `arimo-${style}`), null);
  for (const font of SIGNATURE_FACES) assert.equal(fallbackKeyFor(fontManifest, font.id), null, font.id);
  assert.equal(fallbackKeyFor(fontManifest, "no-such-font"), null);
});

test("Cyrillic, Greek and arrows in Be Vietnam Pro become fallback runs; spaces and punctuation stay in the box font", () => {
  const key = "be-vietnam-pro-regular";
  const text = "Giá: 100 ₫ → Привет, мир! αβγ";
  const check = checkText(fontManifest, key, text);
  assert.equal(check.ok, true);
  assert.deepEqual(check.unsupported, []);
  assert.equal(check.fallback.map((item) => item.char).join(""), "→Приветмирαβγ");
  assert.ok(check.fallback.every((item) => item.font === "arimo-regular"));
  assert.deepEqual(check.fallback[0], { char: "→", index: 11, codePoint: 0x2192, font: "arimo-regular" });
  assert.deepEqual(splitRuns(fontManifest, key, text), [
    { text: "Giá: 100 ₫ ", font: key },
    { text: "→", font: "arimo-regular" },
    { text: " ", font: key },
    { text: "Привет", font: "arimo-regular" },
    { text: ", ", font: key },
    { text: "мир", font: "arimo-regular" },
    { text: "! ", font: key },
    { text: "αβγ", font: "arimo-regular" }
  ]);
  assert.deepEqual(facesNeeded(fontManifest, key, text), [key, "arimo-regular"]);
  // the bold italic box falls back to the bold italic face
  assert.deepEqual(splitRuns(fontManifest, "be-vietnam-pro-bold-italic", "a→b").map((run) => run.font), ["be-vietnam-pro-bold-italic", "arimo-bold-italic", "be-vietnam-pro-bold-italic"]);
  // the three metric-compatible families write Cyrillic and Greek themselves
  for (const family of ["arimo", "tinos", "cousine"]) {
    assert.deepEqual(checkText(fontManifest, `${family}-regular`, "Привет αβγ"), { ok: true, fallback: [], unsupported: [] }, family);
  }
  assert.deepEqual([...new Set(fontsThatCover(fontManifest, "Привет αβγ").map((id) => findFont(fontManifest, id).family))], ["Arimo", "Tinos", "Cousine"]);
  // Cousine lacks the hyphens U+2010 / U+2011 and the degree Celsius sign: Arimo writes them
  const cousine = checkText(fontManifest, "cousine-regular", `20${s(0x2103)} a${s(0x2010)}b`);
  assert.equal(cousine.ok, true);
  assert.deepEqual(cousine.fallback.map((item) => item.codePoint), [0x2103, 0x2010]);
});

test("runs give the text back, line breaks stay in the run they follow", () => {
  const key = "be-vietnam-pro-regular";
  for (const text of ["", LF, `a${LF}b`, `${LF}Привет`, `Привет${LF}${LF}→${LF}`, `abc${LF}Привет мир${LF}αβγ`]) {
    const runs = splitRuns(fontManifest, key, text);
    assert.equal(runs.map((run) => run.text).join(""), text, JSON.stringify(text));
    for (let index = 1; index < runs.length; index += 1) assert.notEqual(runs[index].font, runs[index - 1].font, JSON.stringify(text));
    for (const run of runs) assert.ok(run.text.length > 0);
  }
  assert.deepEqual(splitRuns(fontManifest, key, ""), []);
  assert.deepEqual(splitRuns(fontManifest, key, `${LF}Привет`), [{ text: `${LF}Привет`, font: "arimo-regular" }]);
  assert.deepEqual(splitRuns(fontManifest, key, `ab${LF}Привет`), [{ text: `ab${LF}`, font: key }, { text: "Привет", font: "arimo-regular" }]);
});

test("CJK, Thai, Arabic, Hebrew, check marks and emoji turn the box into a picture", () => {
  for (const font of TEXT_FACES) {
    for (const [name, sample] of Object.entries({ cjk: "合同", thai: "ไทย", korean: "한국", arabic: "مرحبا", hebrew: "שלום", check: s(0x2713), ballot: s(0x2611), emoji: s(0x1f600), astral: s(0x20000) })) {
      const text = `Hợp đồng ${sample}`;
      const check = checkText(fontManifest, font.id, text);
      assert.equal(check.ok, false, `${font.id} ${name}`);
      assert.ok(check.unsupported.length > 0 && check.unsupported.every((item) => item.reason === "missing"), `${font.id} ${name}`);
      assert.equal(check.unsupported[0].index, 9);
      assert.equal(splitRuns(fontManifest, font.id, text), null, `${font.id} ${name}`);
    }
  }
  const check = checkText(fontManifest, "arimo-regular", `Hợp đồng 合同 ${s(0x1f600)}!`);
  assert.deepEqual(check.unsupported.map((item) => [item.char, item.index, item.reason]), [["合", 9, "missing"], ["同", 10, "missing"], [s(0x1f600), 12, "missing"]]);
  assert.deepEqual(fontsThatCover(fontManifest, "合同"), []);
  // a picture needs the fallback face too: the browser tries it before any system font
  assert.deepEqual(facesNeeded(fontManifest, "tinos-bold", "合"), ["tinos-bold", "arimo-bold"]);
  assert.deepEqual(facesNeeded(fontManifest, "arimo-bold", "合"), ["arimo-bold"]);
});

test("a combining mark that survives NFC, and a glyph the font treats as a mark, are not real text", () => {
  const tilde = `q${s(0x303)}`;
  assert.equal(normalizeText(tilde), tilde); // there is no precomposed q with tilde
  for (const font of TEXT_FACES) {
    const check = checkText(fontManifest, font.id, `a${tilde}b`);
    assert.equal(check.ok, false, font.id);
    assert.deepEqual(check.unsupported.map((item) => [item.char, item.index, item.reason]), [[tilde, 1, "mark"]], font.id);
    assert.equal(splitRuns(fontManifest, font.id, `a${tilde}b`), null);
  }
  // U+02DE is a mark-class glyph in Tinos: the browser gives it no advance, the PDF writer would
  const hook = s(0x2de);
  for (const style of ["regular", "bold", "italic", "bold-italic"]) {
    assert.deepEqual(findFont(fontManifest, `tinos-${style}`).unsafeCodePoints, [0x2de]);
    assert.equal(exportProblem(findFont(fontManifest, `tinos-${style}`), hook), "unsafe");
    // Arimo has an ordinary glyph for it, but the browser draws the character with the box font, which has
    // one too: no fallback run, the box becomes a picture
    const check = checkText(fontManifest, `tinos-${style}`, `a${hook}`);
    assert.equal(check.ok, false);
    assert.deepEqual(check.fallback, []);
    assert.deepEqual(check.unsupported.map((item) => [item.codePoint, item.reason]), [[0x2de, "unsafe"]]);
    assert.equal(splitRuns(fontManifest, `tinos-${style}`, `a${hook}`), null);
  }
  assert.equal(exportProblem(findFont(fontManifest, "arimo-regular"), hook), null);
  // a signature face is never embedded as text; its unsafe glyph is reported
  assert.deepEqual(checkText(fontManifest, "dancing-script-regular", `a${s(0xb7)}b`).unsupported.map((item) => item.reason), ["unsafe"]);
});

test("a letter the box font lacks but the browser builds from the font's own parts is not given to the fallback face", () => {
  // Be Vietnam Pro has no C with circumflex, but it has C and the combining circumflex: the browser (HarfBuzz)
  // draws the letter with Be Vietnam Pro, so a fallback run in Arimo would show another letter shape and move
  // the text. Such letters make the box a picture. (Measured for every code point: acceptance SCAN.)
  const bvp = "be-vietnam-pro-regular";
  for (const [name, text] of Object.entries({ esperanto: "Ĉĉ Ĝĝ Ĥĥ Ĵĵ Ŝŝ Ŭŭ", latvian: "Ģģ Ķķ Ļļ Ņņ", romanian: "Șș Țț", pinyin: "ǎ ǐ ǒ ǔ ǖ ǘ ǚ ǜ", dialytikaTonos: s(0x385) })) {
    const check = checkText(fontManifest, bvp, text);
    assert.equal(check.ok, false, name);
    assert.deepEqual(check.fallback, [], name);
    assert.ok(check.unsupported.length > 0 && check.unsupported.every((item) => item.reason === "composed"), name);
    assert.equal(splitRuns(fontManifest, bvp, text), null, name);
    // the three metric-compatible families have these letters ready-made
    for (const family of ["arimo", "tinos", "cousine"]) assert.equal(checkText(fontManifest, `${family}-regular`, text).ok, true, `${family} ${name}`);
  }
  assert.deepEqual(fontPlan(fontManifest, bvp).classify("Ĉ"), { font: null, reason: "composed", alone: false });
  // what Be Vietnam Pro can not build either still goes to Arimo
  for (const char of ["Ж", "Ω", "→", "№", "ŋ"]) assert.deepEqual(fontPlan(fontManifest, bvp).classify(char), { font: "arimo-regular", reason: null, alone: false }, char);
  // what the font has itself is its own, however it could be built
  assert.deepEqual(fontPlan(fontManifest, bvp).classify("ế"), { font: bvp, reason: null, alone: false });
});

test("a space character the box font lacks is written by the fallback face in a run of its own", () => {
  // the browser draws a missing figure space, thin space ... with the box font's own space glyph and a computed
  // advance; the fallback face's glyph has another advance, so nothing may be placed by it
  const figure = s(0x2007);
  const thin = s(0x2009);
  const narrow = s(0x202f);
  for (const key of ["cousine-regular", "be-vietnam-pro-bold"]) {
    const plan = fontPlan(fontManifest, key);
    for (const space of [figure, thin, narrow, s(0x2004), s(0x2008), s(0x200a)]) {
      assert.deepEqual(plan.classify(space), { font: plan.fallbackKey, reason: null, alone: true }, `${key} U+${space.codePointAt(0).toString(16)}`);
    }
    assert.deepEqual(plan.classify(" "), { font: key, reason: null, alone: false });
    assert.deepEqual(plan.classify(s(0xa0)), { font: key, reason: null, alone: false });
  }
  // Arimo has these spaces itself
  assert.deepEqual(fontPlan(fontManifest, "arimo-regular").classify(figure), { font: "arimo-regular", reason: null, alone: false });
  const celsius = s(0x2103); // Cousine has no degree Celsius sign either
  const text = `1${figure}000${thin}₫ ${celsius}${figure}${celsius}`;
  const check = checkText(fontManifest, "cousine-regular", text);
  assert.equal(check.ok, true);
  assert.deepEqual(check.fallback.map((item) => item.codePoint), [0x2007, 0x2009, 0x2103, 0x2007, 0x2103]);
  assert.deepEqual(splitRuns(fontManifest, "cousine-regular", text), [
    { text: "1", font: "cousine-regular" },
    { text: figure, font: "arimo-regular" },
    { text: "000", font: "cousine-regular" },
    { text: thin, font: "arimo-regular" },
    { text: "₫ ", font: "cousine-regular" },
    { text: celsius, font: "arimo-regular" },
    { text: figure, font: "arimo-regular" }, // its own run although its neighbours are fallback runs too
    { text: celsius, font: "arimo-regular" }
  ]);
  // no bundled text face has a hyphen without the no-break hyphen (the browser would then draw the hyphen for it)
  for (const font of TEXT_FACES) assert.equal(hasGlyph(font, 0x2010), hasGlyph(font, 0x2011), font.id);
});

test("unknown font keys are an error with a code", () => {
  for (const call of [() => checkText(fontManifest, "arial-regular", "a"), () => splitRuns(fontManifest, "arimo", "a"), () => fontPlan(fontManifest, undefined)]) {
    assert.throws(call, (error) => isPdfEditorError(error) && error.code === "TEXT_FONT_UNKNOWN" && typeof error.params.font === "string");
  }
  assert.ok("TEXT_FONT_UNKNOWN" in CODES);
});

test("normalizeText: NFC, line separators, tabs, controls, invisible characters", () => {
  const decomposed = VIETNAMESE_PANGRAM.normalize("NFD");
  assert.notEqual(decomposed, VIETNAMESE_PANGRAM);
  assert.equal(normalizeText(decomposed), VIETNAMESE_PANGRAM);
  // the Windows Vietnamese keyboard: a precomposed circumflex plus a combining tone mark
  assert.equal(normalizeText(`Ti${s(0xea, 0x301)}ng Vi${s(0xea, 0x323)}t`), `Ti${s(0x1ebf)}ng Vi${s(0x1ec7)}t`);
  assert.equal(normalizeText(["a", CR, LF, "b", CR, "c", s(0x2028), "d", s(0x2029), "e", s(0x85), "f", s(0x0b), "g", s(0x0c), "h"].join("")), ["a", "b", "c", "d", "e", "f", "g", "h"].join(LF));
  assert.equal(TAB_SPACES, 4);
  assert.equal(normalizeText(`a${s(0x09)}b`), "a    b");
  assert.equal(normalizeText(`so${s(0xad)}ft${s(0x200b)} zero${s(0xfeff)} ${s(0x200e)}join${s(0x2060)}`), "soft zero join");
  assert.equal(normalizeText(`x${s(0x00)}y${s(0x1f)}z${s(0x9f)}${s(0x7f)}`), "xyz");
  assert.equal(normalizeText(`no-break${s(0xa0)}space`), `no-break${s(0xa0)}space`); // a real character: it stays
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
  assert.equal(normalizeText(42), "42");
  // half a surrogate pair becomes the replacement character, a whole pair stays
  assert.equal(normalizeText(`a${String.fromCharCode(0xd83d)}b`), `a${s(0xfffd)}b`);
  assert.equal(normalizeText(`a${String.fromCharCode(0xde00)}`), `a${s(0xfffd)}`);
  assert.equal(normalizeText(s(0x1f600)), s(0x1f600));
});

test("normalizeText keeps the joiners, selectors and tags of emoji and complex-script sequences", () => {
  for (const [name, text] of Object.entries(SEQUENCES)) assert.equal(normalizeText(text), text, name);
  const sentence = `Gia đình ${SEQUENCES.family} tim ${SEQUENCES.heart}.`;
  assert.equal(normalizeText(sentence), sentence);
});

test("normalizeText removes the same characters where they have no effect", () => {
  assert.equal(normalizeText(`a${s(0x200d)}b`), "ab"); // ZWJ between Latin letters
  assert.equal(normalizeText(`a${s(0x200c)}b`), "ab"); // ZWNJ between Latin letters
  assert.equal(normalizeText(`a${s(0xfe0f)}b`), "ab"); // a selector after a letter without an emoji form
  assert.equal(normalizeText(`${s(0xfe0f)}abc`), "abc"); // a selector without a base
  assert.equal(normalizeText(`a${s(0x200e)}b${s(0x200f)}`), "ab"); // bidi marks without right-to-left text
  assert.equal(normalizeText(`${s(0x202e)}abc${s(0x202c)}`), "abc"); // an override would reverse plain text
  assert.equal(normalizeText(`a${s(0xe0067)}b`), "ab"); // a stray tag character
  assert.equal(normalizeText(`e${s(0x200d, 0x301)}`), s(0xe9)); // removal first, then NFC
  // line by line: a bidi mark stays only on the line that has right-to-left text
  assert.equal(normalizeText(`a${s(0x200e)}b${LF}${s(0x5d0, 0x200e)}c`), `ab${LF}${s(0x5d0, 0x200e)}c`);
  // a joiner does not reach across a line break
  assert.equal(normalizeText(`a${s(0x200d)}${LF}${s(0x1f600)}`), `a${LF}${s(0x1f600)}`);
});

test("normalizeText is idempotent and its result is what the model calls an NFC text", () => {
  const corpus = [
    ...Object.values(SEQUENCES), VIETNAMESE_PANGRAM, VIETNAMESE_PANGRAM.normalize("NFD"), `a${s(0x200d)}b`, `${s(0x202e)}abc`, `q${s(0x303, 0x303)}`,
    `x${s(0x200d, 0xfe0f, 0x200c, 0x1f600, 0xfe0f, 0x200d)}y`, `${s(0x5d0, 0x200f, 0x202b)}abc${s(0x202c)}${LF}${s(0x200e)}abc`, `1${s(0xfe0f)}2${s(0x20e3)}`,
    `${s(0x1f3f4, 0xe0067)}a${s(0xe0062)}`, `tab${s(0x09)}here${CR}${LF}next${s(0x2028)}line`, `${s(0xfeff)}bom${s(0xad)}soft${s(0x200b)}zw`, `a${String.fromCharCode(0xd83d)}`
  ];
  for (const text of corpus) {
    const once = normalizeText(text);
    assert.equal(normalizeText(once), once, JSON.stringify(text));
    assert.equal(once, once.normalize("NFC"));
    assert.deepEqual(validateObject(makeTextObject({ text: once, frame: { w: 10, h: 10 } })), [], JSON.stringify(text));
  }
});

test("a format character that survives normalisation makes the box a picture, so real text never holds one", () => {
  const arimo = findFont(fontManifest, "arimo-regular");
  assert.equal(exportProblem(arimo, s(0x200d)), "format");
  assert.equal(exportProblem(arimo, SEQUENCES.copyrightEmoji), "format"); // the base U+00A9 is in Arimo, the sequence is an emoji
  assert.equal(exportProblem(arimo, s(0xa9)), null);
  assert.deepEqual(checkText(fontManifest, "arimo-regular", normalizeText(`${s(0xa9)} 2026 ${SEQUENCES.copyrightEmoji}`)).unsupported.map((item) => [item.char, item.reason]), [[SEQUENCES.copyrightEmoji, "format"]]);
  for (const [name, text] of Object.entries(SEQUENCES)) {
    assert.equal(checkText(fontManifest, "arimo-regular", normalizeText(`Việt ${text}`)).ok, false, name);
    assert.equal(splitRuns(fontManifest, "be-vietnam-pro-regular", normalizeText(`Việt ${text}`)), null, name);
  }
  // every code point of a cluster is looked at, not only the first
  assert.equal(exportProblem(arimo, `a${s(0x303)}`), "mark");
  assert.equal(exportProblem(arimo, `1${s(0xfe0f, 0x20e3)}`), "format");
  // over a corpus x every text face: text that passes has no invisible or format character left
  const invisible = [0xad, 0x61c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfe00, 0xfe0e, 0xfe0f, 0xfeff, 0xe0067, 0xe0100];
  const bases = ["a", "Việt", "1", s(0xa9), s(0x2194), " ", ".", s(0x416), s(0x3b1)];
  let passed = 0;
  for (const font of TEXT_FACES) {
    for (const before of bases) {
      for (const codePoint of invisible) {
        for (const after of bases) {
          const text = normalizeText(before + s(codePoint) + after);
          if (!checkText(fontManifest, font.id, text).ok) continue;
          passed += 1;
          for (const char of text) assert.ok(!isFormatCharacter(char) && !invisible.includes(char.codePointAt(0)), `${font.id}: U+${char.codePointAt(0).toString(16)} left in ${JSON.stringify(before + s(codePoint) + after)}`);
        }
      }
    }
  }
  assert.ok(passed > 10000, `only ${passed} combinations passed`);
});

test("graphemes: clusters with their UTF-16 offsets, a line feed always alone", () => {
  assert.deepEqual(graphemes(""), []);
  assert.deepEqual(graphemes(`a${LF}b`), [{ segment: "a", index: 0 }, { segment: LF, index: 1 }, { segment: "b", index: 2 }]);
  assert.deepEqual(graphemes(`q${s(0x303)}x`).map((item) => item.segment), [`q${s(0x303)}`, "x"]);
  assert.deepEqual(graphemes(`${SEQUENCES.family}!${s(0x1f600)}`), [{ segment: SEQUENCES.family, index: 0 }, { segment: "!", index: 8 }, { segment: s(0x1f600), index: 9 }]);
  assert.deepEqual(graphemes(SEQUENCES.flag + SEQUENCES.keycap).map((item) => item.segment), [SEQUENCES.flag, SEQUENCES.keycap]);
  assert.equal(graphemes("Việt Nam").map((item) => item.segment).join(""), "Việt Nam");
});

test("script helpers of the picture path, and blank texts", () => {
  assert.equal(hasRtl(`Việt ${s(0x5e9)}`), true);
  assert.equal(hasRtl("Việt Привет αβγ 合同"), false);
  assert.equal(needsRunShaping(s(0x645)), true); // Arabic
  assert.equal(needsRunShaping(s(0x1781, 0x17d2)), true); // Khmer
  assert.equal(needsRunShaping(s(0x5408)), true); // Han
  for (const plain of ["a", "ệ", "Ж", "β", "(", "1", " ", SEQUENCES.family, s(0x2713)]) assert.equal(needsRunShaping(plain), false, plain);
  for (const blank of ["", " ", `  ${LF} ${LF}`, null, undefined]) assert.equal(isBlankText(blank), true);
  for (const inked of ["a", ` ${LF}.`, s(0x1f600)]) assert.equal(isBlankText(inked), false);
});

test("the module lists its codes with their parameters", () => {
  assert.ok(Object.isFrozen(CODES));
  for (const [code, params] of Object.entries(CODES)) {
    assert.match(code, /^TEXT_[A-Z0-9_]+$/);
    assert.ok(Array.isArray(params) && params.every((name) => /^[a-z][A-Za-z]*$/.test(name)), code);
  }
  for (const code of ["TEXT_FONT_NOT_LOADED", "TEXT_FONT_CORRUPT", "TEXT_FONT_FETCH_FAILED", "TEXT_RASTERIZED"]) assert.ok(code in CODES, code);
  assert.deepEqual(CODES.TEXT_FONT_FETCH_FAILED, ["font", "status"]);
});
