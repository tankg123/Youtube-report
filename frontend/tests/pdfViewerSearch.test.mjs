// Search of the PDF viewer: the pure fold / find module, and the same module on text that pdf.js extracts
// from generated PDFs (Vietnamese with and without diacritics, the d with stroke, NFD text, case, whole words,
// matches across items and lines).
import test from "node:test";
import assert from "node:assert/strict";
import { buildPageText, compactItems, findInPage, foldKey, foldText, indexPage, locate, matchText } from "../src/pages/pdfEditor/viewer/searchText.js";
import { makePdf, textContentOf } from "./helpers/pdfViewerKit.mjs";

const item = (str, hasEOL = false) => ({ str, hasEOL });
const texts = (items, matches) => {
  const { text } = buildPageText(items);
  return matches.map((match) => text.slice(match.start, match.end));
};
const chars = (...codePoints) => String.fromCodePoint(...codePoints);

test("fold: case and Vietnamese diacritics", () => {
  assert.equal(foldText("Tiếng Việt").folded, "tieng viet");
  assert.equal(foldText("ĐÀ NẴNG đường Điện Biên Phủ").folded, "da nang duong dien bien phu");
  assert.equal(foldText("Tiếng Việt", { matchCase: true }).folded, "Tieng Viet");
  assert.equal(foldText("Tiếng Việt", { matchDiacritics: true }).folded, "tiếng việt");
  assert.equal(foldText("Tiếng Việt", { matchDiacritics: true, matchCase: true }).folded, "Tiếng Việt");
});

test("fold: every Vietnamese letter with a mark folds to its base letter, both cases", () => {
  const marked = "àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ";
  const base = "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd";
  assert.equal(marked.length, base.length);
  assert.equal(foldText(marked).folded, base);
  assert.equal(foldText(marked.toUpperCase()).folded, base);
  assert.equal(foldText(marked.toUpperCase(), { matchCase: true }).folded, base.toUpperCase());
});

test("fold: decomposed (NFD) text equals composed text", () => {
  const composed = "Nguyễn Thị Hồng Nhung";
  const decomposed = composed.normalize("NFD");
  assert.notEqual(composed, decomposed);
  assert.equal(foldText(decomposed).folded, foldText(composed).folded);
  assert.equal(foldText(decomposed, { matchDiacritics: true }).folded, foldText(composed, { matchDiacritics: true }).folded);
  assert.equal(foldText(decomposed, { matchDiacritics: true }).folded, "nguyễn thị hồng nhung");
});

test("fold: white space runs, line breaks, typographic quotes and dashes, invisible characters", () => {
  assert.equal(foldText("  a \n\n b  c  ").folded, "a b c");
  assert.equal(foldText(`a${chars(0x00a0)}b${chars(0x2003)}c${chars(0x3000)}d`).folded, "a b c d");
  const quoted = `${chars(0x201c)}quoted${chars(0x201d)} ${chars(0x2013)} it${chars(0x2019)}s`;
  assert.equal(foldText(quoted).folded, "\"quoted\" - it's");
  // soft hyphen and zero-width space are not part of a word
  assert.equal(foldText(`so${chars(0x00ad)}ft${chars(0x200b)}hy${chars(0xfeff)}`).folded, "softhy");
});

test("fold: the map points back into the original string", () => {
  const source = "Số  tài\nkhoản";
  const { folded, map } = foldText(source);
  assert.equal(folded, "so tai khoan");
  assert.equal(map.length, folded.length + 1);
  assert.equal(source[map[0]], "S");
  assert.equal(source[map[folded.indexOf("t")]], "t");
  assert.equal(source[map[folded.indexOf("k")]], "k");
  assert.equal(map[folded.length], source.length);
});

test("search: with and without diacritics, any case", () => {
  const items = [item("Hợp đồng dịch vụ số 2026/HĐ-ANS", true), item("Người đại diện: Nguyễn Văn An")];
  const index = indexPage(items);
  assert.deepEqual(texts(items, findInPage(index, "hop dong")), ["Hợp đồng"]);
  assert.deepEqual(texts(items, findInPage(index, "HỢP ĐỒNG")), ["Hợp đồng"]);
  assert.deepEqual(texts(items, findInPage(index, "nguyen van an")), ["Nguyễn Văn An"]);
  assert.deepEqual(texts(items, findInPage(index, "hd-ans")), ["HĐ-ANS"]);
  assert.equal(matchText(index, findInPage(index, "dich vu")[0]), "dịch vụ");
});

test("search: the d with stroke is found from a plain d, and only told apart with matchDiacritics", () => {
  const items = [item("Đà Nẵng, đường Điện Biên Phủ, da dang")];
  assert.deepEqual(texts(items, findInPage(indexPage(items), "da")), ["Đà", "da", "da"]);
  assert.deepEqual(texts(items, findInPage(indexPage(items), "duong dien bien phu")), ["đường Điện Biên Phủ"]);
  const strict = { matchDiacritics: true };
  assert.deepEqual(texts(items, findInPage(indexPage(items, strict), "da", strict)), ["da", "da"]);
  assert.deepEqual(texts(items, findInPage(indexPage(items, strict), "đà", strict)), ["Đà"]);
  assert.deepEqual(findInPage(indexPage(items, strict), "duong", strict), []);
});

test("search: matchDiacritics distinguishes marks", () => {
  const items = [item("ma mà má mả mã mạ MA")];
  const strict = { matchDiacritics: true };
  const index = indexPage(items, strict);
  assert.deepEqual(texts(items, findInPage(index, "má", strict)), ["má"]);
  assert.deepEqual(texts(items, findInPage(index, "ma", strict)), ["ma", "MA"]);
  assert.equal(findInPage(indexPage(items), "ma").length, 7);
});

test("search: matchCase", () => {
  const items = [item("An an AN")];
  const strict = { matchCase: true };
  assert.deepEqual(texts(items, findInPage(indexPage(items, strict), "An", strict)), ["An"]);
  assert.equal(findInPage(indexPage(items), "An").length, 3);
});

test("search: whole word", () => {
  const items = [item("an Tan an. ban (an) An-ninh xan")];
  const whole = { wholeWord: true };
  const found = findInPage(indexPage(items, whole), "an", whole);
  assert.deepEqual(found.map((match) => match.start), [0, 7, 16, 20]);
  // a word boundary is judged on the folded letters: the accented neighbours count as letters
  const vietnamese = [item("hợp đồng, hợp, phù hợp. hợpđồng")];
  assert.deepEqual(findInPage(indexPage(vietnamese, whole), "hop", whole).map((match) => match.start), [0, 10, 19]);
});

test("search: a phrase that pdf.js split into several items and lines", () => {
  const items = [item("Số tài "), item("khoản:"), item("", true), item("0123456789 tại"), item(" Vietcombank")];
  const index = indexPage(items);
  const [match] = findInPage(index, "tai khoan: 0123456789 tai vietcombank");
  assert.ok(match);
  assert.deepEqual(match.begin, { item: 0, offset: 3 });
  assert.deepEqual(match.end_, { item: 4, offset: 12 });
});

test("search: a match in decomposed text covers the trailing combining marks", () => {
  const decomposed = "Tiếng Việt".normalize("NFD");
  const items = [item(decomposed)];
  const [match] = findInPage(indexPage(items), "tieng viet");
  assert.equal(match.start, 0);
  assert.equal(match.end, decomposed.length);
  const [partial] = findInPage(indexPage(items), "tie");
  assert.equal(decomposed.slice(partial.start, partial.end).normalize("NFC"), "Tiế");
  // typed composed, stored decomposed, compared strictly
  const strict = { matchDiacritics: true };
  assert.equal(findInPage(indexPage(items, strict), "Tiếng Việt", strict).length, 1);
  assert.equal(findInPage(indexPage(items, strict), "Tieng Viet", strict).length, 0);
});

test("search: match boundaries on item edges", () => {
  const items = [item("abc"), item("def", true), item("ghi")];
  const index = indexPage(items);
  const [inner] = findInPage(index, "cde");
  assert.deepEqual(inner.begin, { item: 0, offset: 2 });
  assert.deepEqual(inner.end_, { item: 1, offset: 2 });
  const [whole] = findInPage(index, "abc");
  assert.deepEqual(whole.end_, { item: 0, offset: 3 });
  const [across] = findInPage(index, "def ghi");
  assert.deepEqual(across.begin, { item: 1, offset: 0 });
  assert.deepEqual(across.end_, { item: 2, offset: 3 });
});

test("search: matches do not overlap and are reported left to right", () => {
  const items = [item("aaaa banana")];
  assert.deepEqual(findInPage(indexPage(items), "aa").map((match) => match.start), [0, 2]);
  assert.deepEqual(findInPage(indexPage(items), "ana").map((match) => match.start), [6]);
});

test("locate: empty items are skipped; an empty page does not throw", () => {
  const pageText = buildPageText([item("ab"), item("", true), item("cd")]);
  assert.equal(pageText.text, "ab\ncd");
  assert.deepEqual(locate(pageText, 3, false), { item: 2, offset: 0 });
  assert.deepEqual(locate(pageText, 2, true), { item: 0, offset: 2 });
  assert.deepEqual(findInPage(indexPage([]), "abc"), []);
  assert.deepEqual(locate(buildPageText([]), 0), { item: 0, offset: 0 });
});

test("search: empty and white-space queries find nothing", () => {
  const index = indexPage([item("abc")]);
  assert.deepEqual(findInPage(index, ""), []);
  assert.deepEqual(findInPage(index, "   "), []);
  assert.deepEqual(findInPage(index, null), []);
});

test("compactItems drops marked-content entries, so indexes equal the text layer's", () => {
  const items = [{ type: "beginMarkedContent" }, { str: "ab", hasEOL: false, transform: [] }, { type: "endMarkedContent" }, { str: "", hasEOL: true }, { str: "cd" }];
  assert.deepEqual(compactItems(items), [item("ab"), item("", true), item("cd")]);
  assert.equal(foldKey({}), "00");
  assert.equal(foldKey({ matchCase: true, wholeWord: true }), "10");
  assert.equal(foldKey({ matchDiacritics: true }), "01");
});

test("on text extracted by pdf.js: unaccented input finds the Vietnamese line, NFD text included", async () => {
  const stored = "Tiếng Việt dạng tổ hợp".normalize("NFD");
  const bytes = await makePdf([
    {
      texts: [
        { text: "Hợp đồng dịch vụ số 12/2026", x: 50, y: 780, size: 14 },
        { text: "Người đại diện: Nguyễn Văn An", x: 50, y: 750 },
        { text: "Đường Điện Biên Phủ, Đà Nẵng", x: 50, y: 720, fontKey: "tinos-regular" }
      ]
    }
  ]);
  const { items } = await textContentOf(bytes);
  const compact = compactItems(items);
  const index = indexPage(compact);
  assert.deepEqual(texts(compact, findInPage(index, "hop dong dich vu")), ["Hợp đồng dịch vụ"]);
  assert.deepEqual(texts(compact, findInPage(index, "NGUYEN VAN AN")), ["Nguyễn Văn An"]);
  assert.deepEqual(texts(compact, findInPage(index, "duong dien bien phu, da nang")), ["Đường Điện Biên Phủ, Đà Nẵng"]);
  // a match that runs over the end of one line into the next
  const [across] = findInPage(index, "12/2026 nguoi dai dien");
  assert.ok(across && across.begin.item !== across.end_.item);
  const strict = { matchDiacritics: true };
  assert.equal(findInPage(indexPage(compact, strict), "hop dong", strict).length, 0);
  assert.equal(findInPage(indexPage(compact, strict), "hợp đồng", strict).length, 1);
  // the same words stored decomposed are found the same way
  assert.equal(findInPage(indexPage([item(stored)]), "tieng viet dang to hop").length, 1);
  assert.equal(findInPage(indexPage([item(stored)], strict), "Tiếng Việt dạng tổ hợp", strict).length, 1);
});
