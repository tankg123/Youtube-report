// messages.js: one sentence, in English and in Vietnamese, for every code of every module of the PDF editor.
// The codes are read from the codes.js files AT RUN TIME: a code that an engine adds later fails this suite
// until messages.js and the Vietnamese dictionary know it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NAMESPACES, getLanguage, hasTranslation, placeholdersOf, setLanguage, t } from "../src/i18n/index.js";
import { CANCELLED, PdfEditorError } from "../src/pages/pdfEditor/engine/errors.js";
import * as exportCodes from "../src/pages/pdfEditor/engine/export/codes.js";
import * as redactCodes from "../src/pages/pdfEditor/engine/redact/codes.js";
import * as signCodes from "../src/pages/pdfEditor/engine/sign/codes.js";
import * as pipelineCodes from "../src/pages/pdfEditor/engine/pipeline/codes.js";
import * as modelCodes from "../src/pages/pdfEditor/model/codes.js";
import * as textCodes from "../src/pages/pdfEditor/text/codes.js";
import * as viewerCodes from "../src/pages/pdfEditor/viewer/codes.js";
import {
  GENERIC_SENTENCE, KNOWN_CODES, KNOWN_STAGES, WORDS, describeCode, describeError, describeStage, describeWarning, isSilent, sentencesOf, stageSentenceOf
} from "../src/pages/pdfEditor/messages.js";
import { FRONTEND_ROOT, extractKeys } from "./helpers/i18nSource.mjs";

const MODULES = { "engine/export": exportCodes.CODES, "engine/redact": redactCodes.CODES, "engine/sign": signCodes.CODES, "engine/pipeline": pipelineCodes.CODES, model: modelCodes.CODES, text: textCodes.CODES, viewer: viewerCodes.CODES };
const STAGES = [...exportCodes.STAGES, ...redactCodes.PROGRESS_STAGES, ...pipelineCodes.STAGES];
// Codes that the engine repairs announced before they reached a codes.js (BRIEF-UI section 1), with the
// parameters they were announced with. Once an engine lists a code, its own list is what counts.
const ANNOUNCED = { EXPORT_SOURCE_INCONSISTENT: ["source"], EXPORT_OUTLINE_RETARGETED: ["source", "items"], REDACT_FONT_GLYPHS_REMAIN: ["font", "pages"] };
const DECLARED = new Map([[CANCELLED, []], ...Object.entries(ANNOUNCED)]);
for (const codes of Object.values(MODULES)) for (const [code, params] of Object.entries(codes)) DECLARED.set(code, [...params]);

const MESSAGES_SOURCE = fs.readFileSync(path.join(FRONTEND_ROOT, "src/pages/pdfEditor/messages.js"), "utf8");
const DICTIONARY = NAMESPACES.find((namespace) => namespace.name === "pdfEditorMessages").entries;
const UPPER_SNAKE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const CAMEL_CASE = /\b[a-z]+[A-Z][A-Za-z]*\b/;
const LEFTOVER = /[{}]|undefined|\bnull\b|NaN|\[object/;
const SENTINEL = "zqxenumvalue";

/** Parameters that are enumerations or internal references: never printed, whatever their value. */
const INTERNAL_NAMES = new Set([
  "reason", "check", "problem", "problems", "detail", "part", "option", "missing", "hint", "what", "where", "subtype", "stage", "objectType", "key", "keys", "command",
  "argument", "object", "objectId", "assetId", "sourceId", "pageId", "id", "type", "index", "offset", "delta", "curve", "subFilter", "status", "needed", "available"
]);
const INTERNAL_PAIRS = new Set(["CERT_INVALID_OPTIONS.field", "REDACT_IMAGE_IN_TARGET.name"]);
const isInternal = (code, name) => INTERNAL_NAMES.has(name) || INTERNAL_PAIRS.has(`${code}.${name}`);

/** A plausible value for every parameter of a code; enumerations get a sentinel that must never be shown. */
function sampleParams(code, overrides = {}) {
  const params = {};
  for (const name of DECLARED.get(code) || []) {
    if (isInternal(code, name)) params[name] = SENTINEL;
    else if (["notAfter", "notBefore", "claimed", "timestamp"].includes(name)) params[name] = "2028-03-05T12:00:00.000Z";
    else if (name === "source") params[name] = "s_k3x9a1";
    else if (name === "font") params[name] = code.startsWith("TEXT_") ? "tinos-bold-italic" : "ABCDEF+TimesNewRoman";
    else if (name === "fontKey") params[name] = "be-vietnam-pro-bold";
    else if (name === "characters") params[name] = String.fromCodePoint(0x1f600, 0x2603);
    else if (name === "field" || name === "fieldName") params[name] = "Signature1";
    else if (name === "algorithm" || name === "name") params[name] = "SHA-1";
    else if (name === "keyType") params[name] = "DSA";
    else if (name === "pages" && code.startsWith("PIPELINE_")) params[name] = [2, 5];
    else if (name === "selfSigned" || name === "timeProven") params[name] = true;
    else params[name] = name === "page" || name === "pageIndex" || name === "pageNumber" ? 3 : 2;
  }
  return { ...params, ...overrides };
}

async function inLanguage(language, work) {
  const before = getLanguage();
  setLanguage(language);
  try {
    return await work();
  } finally {
    setLanguage(before);
  }
}

// ---------------------------------------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------------------------------------

test("every code of every codes.js has a sentence, and no entry is left without a code", () => {
  const missing = [];
  for (const [module, codes] of Object.entries(MODULES)) {
    assert.ok(Object.keys(codes).length > 0, `${module}/codes.js lists no code`);
    for (const code of Object.keys(codes)) if (sentencesOf(code).length === 0) missing.push(`${module}: ${code}`);
  }
  assert.deepEqual(missing, [], "messages.js needs an entry (and the Vietnamese dictionary a text) for these codes");
  assert.ok(sentencesOf(CANCELLED).length === 1);
  const stale = KNOWN_CODES.filter((code) => !DECLARED.has(code));
  assert.deepEqual(stale, [], "entries of messages.js for codes that no module lists");
  // the sizes the modules had when this suite was written: a module that lost its list would pass everything above
  const atLeast = { "engine/export": 26, "engine/redact": 23, "engine/sign": 134, "engine/pipeline": 6, model: 21, text: 9, viewer: 13 };
  for (const [module, count] of Object.entries(atLeast)) assert.ok(Object.keys(MODULES[module]).length >= count, `${module}: ${Object.keys(MODULES[module]).length} codes`);
  // the announced codes are covered already
  for (const code of Object.keys(ANNOUNCED)) assert.ok(sentencesOf(code).length > 0, code);
});

test("every stage of every engine has a line", () => {
  assert.ok(STAGES.length >= 14);
  for (const stage of STAGES) {
    const sentence = stageSentenceOf(stage);
    assert.ok(typeof sentence === "string" && sentence, `no line for the stage ${stage}`);
    assert.ok(hasTranslation(sentence, "vi"), `no Vietnamese line for the stage ${stage}`);
    assert.equal(describeStage(stage), sentence);
  }
  assert.deepEqual(KNOWN_STAGES.filter((stage) => !STAGES.includes(stage)), [], "lines for stages that no engine has");
  assert.equal(describeStage("NO_SUCH_STAGE"), "Working…");
  assert.equal(describeStage(undefined), "Working…");
});

test("every sentence has a Vietnamese entry with the same placeholders, all of them parameters of its code", () => {
  const problems = [];
  for (const code of KNOWN_CODES) {
    const declared = DECLARED.get(code) || [];
    for (const sentence of sentencesOf(code)) {
      if (!Object.prototype.hasOwnProperty.call(DICTIONARY, sentence)) {
        problems.push(`${code}: no entry in pdfEditorMessages.js for ${JSON.stringify(sentence)}`);
        continue;
      }
      const english = [...new Set(placeholdersOf(sentence))].sort();
      const vietnamese = [...new Set(placeholdersOf(DICTIONARY[sentence]))].sort();
      if (english.join() !== vietnamese.join()) problems.push(`${code}: {${english}} in English, {${vietnamese}} in Vietnamese`);
      for (const name of english) if (!declared.includes(name)) problems.push(`${code}: {${name}} is not a parameter of the code (${declared.join(", ") || "none"})`);
    }
  }
  for (const word of [...WORDS, ...KNOWN_STAGES.map(stageSentenceOf), GENERIC_SENTENCE]) {
    if (!Object.prototype.hasOwnProperty.call(DICTIONARY, word)) problems.push(`no Vietnamese entry for ${JSON.stringify(word)}`);
    if (placeholdersOf(word).length) problems.push(`a word or stage line with a placeholder: ${JSON.stringify(word)}`);
  }
  assert.deepEqual(problems, []);
});

test("the dictionary and messages.js hold exactly the same keys", () => {
  const used = new Set(extractKeys(MESSAGES_SOURCE).map((entry) => entry.key));
  const listed = new Set(Object.keys(DICTIONARY));
  assert.deepEqual([...used].filter((key) => !listed.has(key)), [], "keys of messages.js without a Vietnamese entry");
  assert.deepEqual([...listed].filter((key) => !used.has(key)), [], "Vietnamese entries that messages.js does not use");
  // every key is reachable through the catalogue (nothing is rendered behind its back)
  const catalogue = new Set([...KNOWN_CODES.flatMap(sentencesOf), ...WORDS, ...KNOWN_STAGES.map(stageSentenceOf), GENERIC_SENTENCE, "Working…"]);
  assert.deepEqual([...used].filter((key) => !catalogue.has(key)), []);
});

// ---------------------------------------------------------------------------------------------------------
// what a sentence looks like
// ---------------------------------------------------------------------------------------------------------

test("no sentence holds an identifier, in either language", () => {
  const problems = [];
  for (const [english, vietnamese] of Object.entries(DICTIONARY)) {
    for (const [language, text] of [["en", english], ["vi", vietnamese]]) {
      const bare = text.replace(/\{[A-Za-z0-9_]+\}/g, "");
      if (UPPER_SNAKE.test(bare)) problems.push(`${language}: UPPER_SNAKE in ${JSON.stringify(text)}`);
      if (CAMEL_CASE.test(bare)) problems.push(`${language}: camelCase in ${JSON.stringify(text)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("rendered sentences: no placeholder left, no enumeration value, no identifier, in both languages", async () => {
  for (const language of ["en", "vi"]) {
    await inLanguage(language, () => {
      const problems = [];
      for (const code of KNOWN_CODES) {
        const variants = [sampleParams(code), sampleParams(code, { source: "hop-dong-2026" }), sampleParams(code, { page: 0, count: 1, pages: code.startsWith("PIPELINE_") ? [7] : 1, level: 2, timeProven: false }), {}, undefined];
        for (const params of variants) {
          const text = describeCode(code, params);
          if (typeof text !== "string" || text.trim().length < 12) problems.push(`${language} ${code}: ${JSON.stringify(text)}`);
          else if (params && LEFTOVER.test(text)) problems.push(`${language} ${code}: leftover in ${JSON.stringify(text)}`);
          else if (text.includes(SENTINEL)) problems.push(`${language} ${code}: an enumeration value is printed: ${JSON.stringify(text)}`);
          else if (UPPER_SNAKE.test(text) || text.includes("s_k3x9a1")) problems.push(`${language} ${code}: an identifier is printed: ${JSON.stringify(text)}`);
          else if (CAMEL_CASE.test(text.replace("TimesNewRoman", ""))) problems.push(`${language} ${code}: camelCase in ${JSON.stringify(text)}`);
        }
      }
      assert.deepEqual(problems, []);
    });
  }
});

test("enumerated parameters choose words or sentences", () => {
  const where = (value) => describeCode("REDACT_TEXT_ELSEWHERE", { where: value, count: 3 });
  const places = ["outline", "metadata", "form", "annotation", "attachment", "structure", "other"].map(where);
  assert.equal(new Set(places).size, places.length, "every place has its own words");
  assert.match(where("outline"), /bookmarks/);
  assert.match(where("attachment"), /attached files/);
  assert.equal(where("something-new"), where("other"));
  assert.match(where("outline"), /occurrences: 3/);

  const hints = ["empty", "pem", "jks", "pdf", "zip", "certificate", "private-key", null].map((hint) => describeCode("CERT_NOT_PKCS12", { hint }));
  assert.equal(new Set(hints).size, hints.length);
  assert.match(describeCode("EXPORT_OBJECT_BELOW_ANNOTATION", { page: 0, objectId: "o_1", subtype: "Widget" }), /^On page 1, .*a form field/);
  assert.match(describeCode("EXPORT_OBJECT_BELOW_ANNOTATION", { page: 4, objectId: "o_1", subtype: "Screen" }), /^On page 5, .*an annotation/);
  assert.notEqual(describeCode("REDACT_ENV_INVALID", { missing: "worker" }), describeCode("REDACT_ENV_INVALID", { missing: "fonts" }));
  assert.equal(describeCode("REDACT_ENV_INVALID", { missing: "fonts" }), GENERIC_SENTENCE);
  assert.notEqual(describeCode("SIGN_CERTIFIED", { level: 2 }), describeCode("SIGN_CERTIFIED", { level: 3 }));
  assert.notEqual(describeCode("CERT_EXPIRED_SINCE", { notAfter: "2026-01-01T00:00:00Z", timeProven: true }), describeCode("CERT_EXPIRED_SINCE", { notAfter: "2026-01-01T00:00:00Z", timeProven: false }));
  assert.notEqual(describeCode("PIPELINE_SELF_CHECK_FAILED", { check: "redaction-text", page: 2 }), describeCode("PIPELINE_SELF_CHECK_FAILED", { check: "output-unreadable", page: 0 }));
  assert.match(describeCode("PIPELINE_SELF_CHECK_FAILED", { check: "redaction-text", page: 2 }), /page 2.*nothing was saved/);
  const reasons = ["chain", "redirected", "ambiguous", "encryption", "unreadable", "new"].map((reason) => describeCode("SIGN_CHANGE_XREF", { reason, object: "12 0" }));
  assert.equal(new Set(reasons).size, reasons.length);
  assert.ok(reasons.every((text) => !text.includes("12 0")));
});

test("page numbers: 0-based parameters are shown from 1, 1-based ones as they are", () => {
  assert.match(describeCode("EXPORT_PAGE_CONTENT_UNREADABLE", { page: 0 }), /page 1 /);
  assert.match(describeCode("SIGN_BAD_PAGE", { pageIndex: 0, pageCount: 3 }), /on page 1: the document has 3 pages/);
  assert.match(describeCode("REDACT_ANNOTATIONS_FLATTENED", { page: 1, count: 4 }), /^Page 1 became an image/);
  assert.match(describeCode("REDACT_VERIFICATION_FAILED", { page: 2, check: "G1-removal" }), /on page 2 /);
  assert.doesNotMatch(describeCode("REDACT_VERIFICATION_FAILED", { page: 0, check: "page-count" }), /page 0/);
  assert.match(describeCode("VIEW_RENDER_FAILED", { pageNumber: 7 }), /^Page 7 /);
  assert.match(describeCode("SIGN_CHANGE_PAGE_CONTENT", { page: 2 }), /page 2 /);
  assert.match(describeCode("PIPELINE_PAGES_RASTERIZED", { count: 1, pages: [4] }), /^1 page .*\(page 4\)/);
  assert.match(describeCode("PIPELINE_PAGES_RASTERIZED", { count: 3, pages: [1, 4, 9] }), /^3 pages .*\(pages 1, 4, 9\)/);
  assert.match(describeCode("PIPELINE_PAGES_RASTERIZED_ON_REQUEST", { count: 2, pages: [2, 3] }), /^2 pages .*as you chose \(pages 2, 3\)/);
});

test("names: a file by its name when it is known, fonts readable, long names clipped", () => {
  const signed = (source, context) => describeCode("EXPORT_SOURCE_SIGNED", { source, signatures: 2 }, context);
  assert.match(signed("s_k3x9a1"), /^This document carries digital signatures \(2\)/);
  assert.match(signed(null), /^This document /);
  assert.match(signed("hop-dong-2026"), /^The file hop-dong-2026 carries digital signatures \(2\)/);
  assert.match(signed("s_k3x9a1", { sources: { s_k3x9a1: "Báo cáo quý 3" } }), /^The file Báo cáo quý 3 carries/);
  assert.match(signed("s_k3x9a1", { sources: (id) => (id === "s_k3x9a1" ? "report" : "") }), /^The file report carries/);
  assert.match(signed("s_k3x9a1", { sources: {} }), /^This document /);
  assert.match(describeWarning({ code: "EXPORT_ATTACHMENTS_DROPPED", params: { source: "invoice", files: 3 } }), /^The file invoice has attached files \(3\)/);

  assert.match(describeCode("EXPORT_FONT_UNAVAILABLE", { fontKey: "be-vietnam-pro-bold-italic" }), /The font Be Vietnam Pro Bold Italic /);
  assert.match(describeCode("TEXT_FONT_FETCH_FAILED", { font: "arimo-regular", status: 404 }), /^The font Arimo could not be loaded/);
  assert.match(describeCode("REDACT_UNMEASURABLE_TEXT", { page: 2, font: "ABCDEF+MS-Gothic" }), /^Page 2 uses the font MS-Gothic,/);
  assert.match(describeCode("REDACT_FONT_GLYPHS_REMAIN", { font: "XYZABC+Arimo", pages: 1 }), /font Arimo, which 1 page uses .*convert that page to an image/);
  assert.match(describeCode("REDACT_FONT_GLYPHS_REMAIN", { font: "Arimo", pages: 4 }), /which 4 pages use .*convert those pages to images/);
  const long = describeCode("REDACT_FIELD_VALUE_CLEARED", { page: 1, field: `Field ${"x".repeat(500)}`, widgets: 2 });
  assert.ok(long.length < 400, `a 500-character name was printed in full (${long.length})`);
  assert.match(describeCode("EXPORT_TEXT_MISSING_GLYPH", { objectId: "o_1", fontKey: "tinos-regular", characters: "☃☄" }), /The font Tinos cannot write these characters: ☃☄\./);
});

test("dates follow the language", async () => {
  const params = { notAfter: "2028-03-05T12:00:00.000Z" };
  assert.match(describeCode("CERT_EXPIRED", params), /expired on 03\/05\/2028\./);
  await inLanguage("vi", () => assert.match(describeCode("CERT_EXPIRED", params), /hết hạn ngày 05\/03\/2028\./));
  assert.doesNotMatch(describeCode("CERT_EXPIRED", { notAfter: "not a date" }), /Invalid|NaN|not a date/);
});

test("the sentences that must not be softened say it plainly, in both languages", async () => {
  const pruned = describeCode("EXPORT_RESOURCES_NOT_PRUNED", { source: "s_k3x9a1", pages: 2 });
  assert.match(pruned, /^Data of pages you removed may still be inside the downloaded file\./);
  assert.match(pruned, /might be recovered/);
  assert.match(describeCode("REDACT_VERIFICATION_FAILED", { page: 1, check: "G1-removal" }), /nothing was saved/);
  assert.match(describeCode("EXPORT_AUDIT_FAILED", { count: 1, problems: ["object 12 is unreachable"] }), /nothing was saved/);
  assert.doesNotMatch(describeCode("EXPORT_AUDIT_FAILED", { count: 1, problems: ["object 12 is unreachable"] }), /object 12/);
  assert.match(describeCode("PIPELINE_ERASE_COVERED", { count: 1 }), /covered, not removed: the old text is hidden but still in the file/);
  assert.match(describeCode("PIPELINE_ERASE_COVERED", { count: 3 }), /^3 text replacements were covered, not removed: the old text is hidden but still in the file/);
  assert.match(describeCode("REDACT_TEXT_ELSEWHERE", { where: "metadata", count: 1 }), /still in the downloaded file/);
  assert.match(describeCode("EXPORT_SOURCE_SIGNED", { source: null, signatures: 1 }), /these signatures are not in it/);
  assert.match(describeCode("EXPORT_OUTLINE_RETARGETED", { source: null, items: 2 }), /titles are still in the downloaded file/);
  await inLanguage("vi", () => {
    assert.match(describeCode("EXPORT_RESOURCES_NOT_PRUNED", { source: null, pages: 2 }), /^Dữ liệu của các trang bạn đã xóa có thể vẫn còn trong tệp tải xuống\./);
    assert.match(describeCode("REDACT_VERIFICATION_FAILED", { page: 1, check: "G1-removal" }), /không lưu gì cả/);
    assert.match(describeCode("PIPELINE_ERASE_COVERED", { count: 2 }), /vẫn còn trong tệp/);
  });
});

test("Vietnamese entries: full diacritics and the glossary of the editor", () => {
  const problems = [];
  const letters = /[À-ỹ]/;
  const banned = [/chứng chỉ/i, /chữ ký điện tử/i, /tập tin/i, /\bfile\b/i, /xoá/i, /huỷ/i, /bôi đen/i];
  for (const [english, vietnamese] of Object.entries(DICTIONARY)) {
    if (!letters.test(vietnamese)) problems.push(`no Vietnamese letter in ${JSON.stringify(vietnamese)}`);
    for (const pattern of banned) if (pattern.test(vietnamese)) problems.push(`${pattern} in ${JSON.stringify(vietnamese)}`);
    if (/digital signature/i.test(english) && !/chữ ký số/i.test(vietnamese)) problems.push(`"digital signature" is not "chữ ký số": ${JSON.stringify(vietnamese)}`);
    if (/\bcertificate file\b/i.test(english) && !/tệp chứng thư số/i.test(vietnamese)) problems.push(`"certificate file" is not "tệp chứng thư số": ${JSON.stringify(vietnamese)}`);
    if (/\bthe file\b|\bthis file\b/i.test(english) && !/tệp/i.test(vietnamese)) problems.push(`"file" is not "tệp": ${JSON.stringify(vietnamese)}`);
    if (/\bredact/i.test(english) && !/che/i.test(vietnamese)) problems.push(`"redact" is not "che": ${JSON.stringify(vietnamese)}`);
    if (vietnamese !== vietnamese.normalize("NFC")) problems.push(`not NFC: ${JSON.stringify(vietnamese)}`);
    if (/[.!?…]$/.test(english) !== /[.!?…]$/.test(vietnamese)) problems.push(`end punctuation differs: ${JSON.stringify(english)}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(Object.keys(DICTIONARY).length >= 280);
});

test("the language switch reaches every function", async () => {
  const error = new PdfEditorError("MODEL_LAST_PAGE");
  assert.equal(describeError(error), "A document needs at least one page, so the last page cannot be deleted.");
  await inLanguage("vi", () => {
    assert.equal(describeError(error), DICTIONARY["A document needs at least one page, so the last page cannot be deleted."]);
    assert.equal(describeStage("PIPELINE_STAGE_REDACT"), DICTIONARY["Removing redacted content…"]);
    assert.equal(describeWarning({ code: "REDACT_XFA_REMOVED", params: {} }), t("This document kept a second, hidden copy of its form values (XFA). That copy was deleted, so that removed values cannot be read from it."));
    assert.notEqual(describeCode("NO_SUCH_CODE"), GENERIC_SENTENCE);
    assert.equal(describeCode("NO_SUCH_CODE"), DICTIONARY[GENERIC_SENTENCE]);
  });
  assert.equal(describeStage("PIPELINE_STAGE_ASSEMBLE"), "Building the document…");
  assert.equal(describeStage("PIPELINE_STAGE_CHECK"), "Checking the result…");
});

// ---------------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------------

test("describeError: a PdfEditorError by its code, anything else the generic sentence, never the raw text", () => {
  const coded = new PdfEditorError("VIEW_INVALID_PDF", {}, { detail: "parser failed at offset 4711 in /secret/path.pdf", cause: new Error("InvalidPDFException: boom") });
  assert.equal(describeError(coded), "This file is not a valid PDF or it is damaged.");
  // an error that crossed a worker boundary is a plain object
  assert.equal(describeError({ name: "PdfEditorError", code: "MODEL_EMPTY_DOCUMENT", params: {}, message: "MODEL_EMPTY_DOCUMENT" }), "There is nothing to download: the document has no pages.");
  assert.equal(describeError(new PdfEditorError("CODE_FROM_THE_FUTURE", { secret: "s3cr3t" })), GENERIC_SENTENCE);
  assert.equal(describeError(new PdfEditorError("EXPORT_FAILED", { stage: "save" }, { cause: new TypeError("Cannot read properties of undefined (reading 'catalog')") })), "The file could not be created. Your work is still open. Try again.");

  const raw = [
    new TypeError("Cannot read properties of undefined (reading 'catalog')"),
    new Error("Hợp đồng số 12/2026 của Nguyễn Văn An"),
    new RangeError("Array buffer allocation failed"),
    Object.assign(new Error("fetch failed: https://internal.example/api?token=abc"), { code: "ECONNRESET" }),
    { message: "plain object with a message", code: 42 },
    "a string was thrown",
    404,
    null,
    undefined,
    Symbol("thrown"),
    () => "a function"
  ];
  for (const thrown of raw) {
    const text = describeError(thrown);
    assert.equal(text, GENERIC_SENTENCE, String(thrown?.message ?? typeof thrown));
  }
  for (const value of [GENERIC_SENTENCE, describeError(coded)]) {
    for (const leak of ["catalog", "Nguyễn", "4711", "boom", "token", "undefined", "TypeError"]) assert.ok(!value.includes(leak));
  }
  assert.match(GENERIC_SENTENCE, /^Something went wrong inside the editor/);
});

test("describeCode and describeWarning never throw and never answer with nothing", () => {
  const odd = [undefined, null, 7, "", {}, [], "NO_SUCH_CODE", "constructor", "toString", "__proto__", "hasOwnProperty"];
  for (const code of odd) {
    assert.equal(describeCode(code), GENERIC_SENTENCE, String(code));
    assert.equal(describeWarning({ code }), GENERIC_SENTENCE);
  }
  for (const warning of [undefined, null, "REDACT_XFA_REMOVED", 3, {}]) assert.equal(describeWarning(warning), GENERIC_SENTENCE);
  const cyclic = {};
  cyclic.self = cyclic;
  const hostile = [null, "text", 5, [], { page: {}, count: [], source: cyclic, font: () => 1, pages: { length: 3 }, notAfter: {}, where: Symbol("x") }, Object.create(null)];
  for (const code of KNOWN_CODES) {
    for (const params of hostile) {
      const text = describeCode(code, params, { sources: () => {
        throw new Error("no names today");
      } });
      assert.ok(typeof text === "string" && text.length >= 12, `${code}: ${JSON.stringify(text)}`);
      assert.ok(!text.includes("[object") && !text.includes("no names today"), `${code}: ${text}`);
    }
  }
});

test("isSilent: what the user did on purpose shows nothing", () => {
  assert.equal(isSilent(CANCELLED), true);
  assert.equal(isSilent("VIEW_PASSWORD_CANCELLED"), true);
  assert.equal(isSilent(new PdfEditorError(CANCELLED)), true);
  assert.equal(isSilent(new PdfEditorError("VIEW_PASSWORD_CANCELLED")), true);
  assert.equal(isSilent({ name: "PdfEditorError", code: CANCELLED, params: {} }), true);
  for (const loud of ["VIEW_PASSWORD_REQUIRED", new PdfEditorError("EXPORT_FAILED", { stage: "save" }), new Error(CANCELLED), { code: CANCELLED }, null, undefined, 0, ""]) assert.equal(isSilent(loud), false);
  // the silent codes still have a sentence, for a caller that wants one
  assert.ok(describeCode(CANCELLED).length > 10 && describeCode("VIEW_PASSWORD_CANCELLED").length > 10);
});

test("messages.js imports no engine entry module, so the shell can load it without the PDF library", () => {
  const specifiers = [...MESSAGES_SOURCE.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(specifiers.sort(), ["../../i18n/index.js", "./engine/errors.js"]);
  assert.doesNotMatch(MESSAGES_SOURCE, /\bimport\s*\(/);
  const errorsSource = fs.readFileSync(path.join(FRONTEND_ROOT, "src/pages/pdfEditor/engine/errors.js"), "utf8");
  assert.doesNotMatch(errorsSource, /^\s*import\s/m, "engine/errors.js started to import something");
});
