// The precise path (engine/redact/textRemoval.js): what the interpreter removes, what it writes instead,
// what it refuses. Every result is read back with pdf.js and judged by the verifier.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_LINE_SEGMENTS_IN_TARGETS, removeTextInRects } from "../src/pages/pdfEditor/engine/redact/textRemoval.js";
import { verifyPageText } from "../src/pages/pdfEditor/engine/redact/verifyRedaction.js";
import { pageResources, pruneResources } from "../src/pages/pdfEditor/engine/redact/resourceUsage.js";
import { collectGarbage } from "../src/pages/pdfEditor/engine/redact/documentScrub.js";
import { parseContentStream } from "../src/pages/pdfEditor/engine/redact/contentStream.js";
import { FALLBACK_TOKENS } from "../src/pages/pdfEditor/engine/redact/codes.js";
import { pdfLib } from "./helpers/pdfTestKit.mjs";
import { A, boxOf, bytesOf, formXObject, found, grayImage, latin1, load, makePdf, originOf, pageContent, pageTextOf, save, snap } from "./helpers/pdfRedactKit.mjs";
import { dirtyCtmPdf, formUsesPdf, textOpsPdf } from "./helpers/pdfRedactFixtures.mjs";

const { PDFName, PDFString } = pdfLib;

/** Runs the remover on a page and returns { report, bytes, doc, before, after, verdict }. */
async function run(bytes, rects, options = {}) {
  const page = options.page ?? 0;
  const doc = await load(bytes);
  const report = removeTextInRects(doc, page, rects, options);
  const out = await save(doc);
  const before = await snap(bytes, page);
  const after = await snap(out, page);
  return { report, bytes: out, doc, before, after, verdict: verifyPageText(before, after, [...rects, ...(options.eraseRects || [])]) };
}

test("Tj: glyphs in the target are replaced by an adjustment of the same width", async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (Hello secret world) Tj ET" }]);
  const rect = await boxOf(bytes, "secret");
  const r = await run(bytes, [rect]);
  assert.equal(r.report.status, "ok");
  assert.equal(r.report.glyphsRemoved, 6);
  // s e c r e t in Helvetica: 500 + 556 + 500 + 333 + 556 + 278 = 2723 thousandths of the font size
  assert.match(pageContent(r.doc), /\[\(Hello \) -2723 \( world\)\] TJ/);
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
  assert.deepEqual(originOf(r.after, "world"), originOf(r.before, "world"));
  assert.ok(!(await pageTextOf(r.bytes)).includes("secret"));
});

test("character spacing, word spacing and horizontal scaling are part of the compensation", async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 10 Tf 2 Tc 5 Tw 150 Tz 72 600 Td (aa bb cc) Tj ET" }]);
  const rect = await boxOf(bytes, "bb ");
  const r = await run(bytes, [rect]);
  assert.equal(r.report.glyphsRemoved, 3);
  // b = 556: -(556 + 2 * 1000 / 10) twice, the space: -(278 + (2 + 5) * 1000 / 10); Tz cancels out
  assert.match(pageContent(r.doc), /\[\(aa \) -2490 \(cc\)\] TJ/);
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
  const d = originOf(r.after, "cc")[0] - originOf(r.before, "cc")[0];
  assert.ok(Math.abs(d) < 1e-3, `cc moved by ${d}`);
});

test("quote operators are expanded: T* stays, and so do the spacings the double quote sets", async () => {
  const content = "BT /F1 12 Tf 14 TL 72 500 Td (first) Tj (second line) ' 3 1 (third line) \" (fourth one) ' ET";
  const { bytes } = await makePdf([{ content }]);
  // part of the single-quote line
  let r = await run(bytes, [await boxOf(bytes, "second")]);
  assert.match(pageContent(r.doc), /T\* \[-\d+ \( line\)\] TJ/);
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
  // the whole double-quote line: its state changes and its line feed remain, the pure advance is dropped
  r = await run(bytes, [await boxOf(bytes, "third line")]);
  const c = pageContent(r.doc);
  assert.match(c, /3 Tw 1 Tc T\*\s+\(fourth one\) '/);
  assert.ok(!/third/.test(c));
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
  for (const word of ["fourth", "one"]) assert.deepEqual(originOf(r.after, word), originOf(r.before, word));
});

test("TJ: existing adjustments are kept and merged with the compensation", async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td [(AB) -200 (CD) 30 (EF)] TJ ET" }]);
  const r = await run(bytes, [await boxOf(bytes, "CD")]);
  // C and D are 722 wide: -200 - 722 - 722 + 30
  assert.match(pageContent(r.doc), /\[\(AB\) -1614 \(EF\)\] TJ/);
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
});

test("hex strings stay hex strings; untouched operations and operands are byte-identical", async () => {
  const content = "BT /F1 12 Tf 1 0 0 1 72.50 700.250 Tm <48656C6C6F20> Tj <736563726574> Tj <20776F726C64> Tj 0.5 g ET\n0.9 0.1 0.1 RG 2 w 50 50 100 20 re S % frame";
  const { bytes } = await makePdf([{ content }]);
  const r = await run(bytes, [await boxOf(bytes, "secret")]);
  const c = pageContent(r.doc);
  assert.ok(c.includes("1 0 0 1 72.50 700.250 Tm <48656C6C6F20> Tj"), c);
  assert.ok(c.includes("<20776F726C64> Tj 0.5 g ET\n0.9 0.1 0.1 RG 2 w 50 50 100 20 re S"), c);
  assert.ok(!c.includes("736563726574") && !c.includes("frame")); // the text is gone, and so is the comment
  assert.match(c, /\[-2723\] TJ/); // the advance is needed by the Tj that follows
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
});

test("an advance nobody needs is dropped: no trace of the width of a removed line", async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 400 Td (gone completely) Tj 0 -20 Td (stays) Tj ET BT /F1 12 Tf 72 300 Td (also gone) Tj 0.2 g ET" }]);
  const r = await run(bytes, [await boxOf(bytes, "gone completely"), await boxOf(bytes, "also gone")]);
  const c = pageContent(r.doc);
  assert.ok(!/TJ/.test(c), c);
  assert.match(c, /BT \/F1 12 Tf 72 400 Td\s+0 -20 Td \(stays\) Tj ET BT \/F1 12 Tf 72 300 Td\s+0\.2 g ET/);
  assert.equal(r.verdict.ok, true);
});

test("the end of a line: the advance of its removed last glyphs is dropped unless text follows on the pen", async () => {
  const content = [
    "BT /F1 12 Tf 14 TL 72 700 Td (kept words TAIL-ONE-11) Tj ET", // nothing follows: ET
    "BT /F1 12 Tf 14 TL 72 660 Td (again kept TAIL-TWO-22) Tj 0 -14 Td (next line by Td) Tj ET", // Td starts from the line, not the pen
    "BT /F1 12 Tf 14 TL 72 620 Td (kept three TAIL-TRI-33) Tj 0.4 g /F1 12 Tf (quote line) ' ET", // only state changes, then a line feed
    "BT /F1 12 Tf 14 TL 72 580 Td (kept four TAIL-FOR-44) Tj ( follows on the pen) Tj ET", // the next Tj starts where this one ends
    "BT /F1 12 Tf 14 TL 72 540 Td [(kept five ) -120 (TAIL-FIV-55) 250] TJ ET" // a number of the original at the end goes with it
  ].join("\n");
  const { bytes } = await makePdf([{ content }]);
  const words = ["TAIL-ONE-11", "TAIL-TWO-22", "TAIL-TRI-33", "TAIL-FOR-44", "TAIL-FIV-55"];
  const rects = [];
  for (const word of words) rects.push(await boxOf(bytes, word));
  const r = await run(bytes, rects);
  assert.equal(r.report.status, "ok");
  assert.equal(r.report.glyphsRemoved, words.join("").length);
  const c = pageContent(r.doc);
  assert.ok(c.includes("[(kept words )] TJ ET"), c);
  assert.ok(c.includes("[(again kept )] TJ 0 -14 Td (next line by Td) Tj ET"), c);
  assert.ok(c.includes("[(kept three )] TJ 0.4 g /F1 12 Tf (quote line) ' ET"), c);
  assert.match(c, /\[\(kept four \) -\d+(\.\d+)?\] TJ \( follows on the pen\) Tj ET/);
  assert.ok(c.includes("[(kept five )] TJ ET"), c);
  // nothing that stayed has moved, and the removed words are gone for pdf.js
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
  for (const word of ["next", "quote", "follows", "pen"]) {
    const [was, now] = [originOf(r.before, word), originOf(r.after, word)];
    assert.ok(Math.hypot(now[0] - was[0], now[1] - was[1]) < 1e-3, `"${word}" moved from ${was} to ${now}`);
  }
  const text = await pageTextOf(r.bytes);
  for (const word of words) assert.ok(!text.includes(word), word);
  // the width of a removed word is in the stream only where the next text needs it
  assert.equal((c.match(/-\d{4}/g) || []).length, 1, c);
});

test("the rule: what touches the core of a glyph takes it, a grazed neighbour stays", async () => {
  // two lines with leading 1.0 (12 pt on 12 pt), and a strike-through shaped target
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 12 TL 72 700 Td (upper line gjpqy) Tj T* (target line) Tj T* (lower line ABC) Tj 0 -40 Td (struck out) Tj 0 -40 Td (iiiii) Tj ET" }]);
  const before = await snap(bytes);
  const item = before.items.find((it) => it.str === "target line");
  // the box a text layer gives for the middle line, padded by half a point: it reaches into both neighbours
  const rect = [item.box[0] - 0.5, item.box[1] - 0.5, item.box[2] + 0.5, item.box[3] + 0.5];
  let r = await run(bytes, [rect]);
  assert.equal(r.report.glyphsRemoved, "target line".length);
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
  const text = await pageTextOf(r.bytes);
  assert.ok(text.includes("upperlinegjpqy") && text.includes("lowerlineABC") && !text.includes("target"));
  // a thin box through the middle of the letters covers little of their boxes, but their core
  const struck = before.items.find((it) => it.str === "struck out");
  const mid = struck.transform[5] + 12 * 0.25;
  r = await run(bytes, [[struck.box[0], mid - 1, struck.box[2], mid + 1]]);
  assert.equal(r.report.glyphsRemoved, "struck out".length);
  // 0.5 pt of padding on a neighbouring narrow glyph (an "i" is 2.66 pt wide): it stays
  const iiiii = before.items.find((it) => it.str === "iiiii");
  const w = iiiii.width / 5;
  r = await run(bytes, [[iiiii.box[0] + w - 0.5, iiiii.box[1], iiiii.box[0] + 3 * w + 0.5, iiiii.box[3]]]);
  assert.equal(r.report.glyphsRemoved, 2);
  // ... but a third of it is too much
  r = await run(bytes, [[iiiii.box[0] + w - 0.9, iiiii.box[1], iiiii.box[0] + 3 * w + 0.9, iiiii.box[3]]]);
  assert.equal(r.report.glyphsRemoved, 4);
  // thresholds are options
  r = await run(bytes, [[iiiii.box[0] + w - 0.5, iiiii.box[1], iiiii.box[0] + 3 * w + 0.5, iiiii.box[3]]], { thresholds: { core: 0.05, full: 0.05 } });
  assert.equal(r.report.glyphsRemoved, 4);
});

test("a glyph without advance (combining mark) goes with the glyph before it", async () => {
  const mark = { Type: "Font", Subtype: "TrueType", BaseFont: "Marks", FirstChar: 65, LastChar: 68, Widths: [600, 0, 600, 600], FontDescriptor: { Type: "FontDescriptor", FontName: "Marks", Flags: 32, Ascent: 800, Descent: -200 } };
  const { bytes } = await makePdf([{ content: "BT /M 20 Tf 100 700 Td (CABDC) Tj ET", resources: (ctx) => ({ Font: { M: ctx.register(ctx.obj(mark)) } }) }]);
  // B has no width; the target covers A only (and ends exactly where A ends)
  const r = await run(bytes, [[112, 696, 124, 716]], { collectGlyphs: true });
  assert.deepEqual(r.report.glyphs.map((g) => g.remove), [false, true, true, false, false]);
  assert.match(pageContent(r.doc), /\[\(C\) -600 \(DC\)\] TJ/);
});

test("Form XObject used twice: only the targeted use changes (copy-on-write)", async () => {
  const { bytes, shared } = await formUsesPdf();
  const rect = await boxOf(bytes, shared, { pad: 0.5 }); // the first use on page 1
  const doc = await load(bytes);
  const fm1Before = latin1(A.streamBytes(A.get(A.get(pageResources(doc, 0), "XObject"), "Fm1")));
  const rep = removeTextInRects(doc, 0, [rect]);
  assert.equal(rep.status, "ok");
  assert.equal(rep.formsCloned, 1);
  assert.equal(rep.replacedForms.length, 1);
  const content = pageContent(doc);
  assert.match(content, /\/Fm1_r0 Do/);
  assert.match(content, /\/Fm1 Do/); // the other use still draws the original
  const xo = A.get(pageResources(doc, 0), "XObject");
  assert.equal(latin1(A.streamBytes(A.get(xo, "Fm1"))), fm1Before); // the original object is untouched
  assert.ok(!latin1(A.streamBytes(A.get(xo, "Fm1_r0"))).includes("XOBJ-SHARED-TEXT"));
  assert.deepEqual(A.numArray(A.get(A.get(xo, "Fm1_r0").dict, "Matrix"), 6), [1, 0, 0, 1, 10, 5], "the copy keeps the dictionary of the form");
  const out = await save(doc);
  const count = (s, n) => s.split(n).length - 1;
  const squashed = shared.replace(/\s+/g, "");
  assert.equal(count(await pageTextOf(out, 0), squashed), 1);
  assert.equal(count(await pageTextOf(out, 1), squashed), 1); // page 2 uses the same form: unchanged
  assert.equal(count(await pageTextOf(out, 2), squashed), 1);
  assert.equal(verifyPageText(await snap(bytes, 0), await snap(out, 0), [rect]).ok, true);
});

test("nested Form XObjects: the copy of the outer form refers to the copy of the inner one", async () => {
  const { bytes, shared } = await formUsesPdf();
  const rect = await boxOf(bytes, shared, { page: 2, pad: 0.5 });
  const doc = await load(bytes);
  const before = pageResources(doc, 2);
  const rep = removeTextInRects(doc, 2, [rect]);
  assert.equal(rep.formsCloned, 2);
  pruneResources(doc, [before, pageResources(doc, 2)]);
  const xo = A.get(pageResources(doc, 2), "XObject");
  assert.deepEqual(xo.keys().map((k) => k.decodeText()), ["Fm2_r0"]); // Fm1 and Fm2 are no longer used by this page
  const inner = A.get(A.get(A.get(xo, "Fm2_r0").dict, "Resources"), "XObject");
  assert.deepEqual(inner.keys().map((k) => k.decodeText()).sort(), ["Inner", "Inner_r0"]);
  const out = await save(doc);
  assert.ok(!(await pageTextOf(out, 2)).includes("XOBJ-SHARED-TEXT"));
  assert.ok((await pageTextOf(out, 2)).includes("XOBJ-NESTED-OUTERwrapper9925"));
  assert.ok((await pageTextOf(out, 0)).includes("XOBJ-SHARED-TEXT")); // pages 1 and 2 still show it
});

test("/ActualText, /Alt and /E of marked content around removed glyphs are stripped (inline and /Properties)", async () => {
  const content = [
    "/Span << /ActualText (SECRET-ACTUAL-1) /MCID 0 >> BDC BT /F1 12 Tf 72 700 Td (shown glyphs one) Tj ET EMC",
    "/Span /MC0 BDC BT /F1 12 Tf 72 680 Td (shown glyphs two) Tj ET EMC",
    "/Span << /ActualText (KEPT-ACTUAL-3) /Alt (kept alt) >> BDC BT /F1 12 Tf 72 660 Td (untouched three) Tj ET EMC",
    "/Span /MC1 BDC BT /F1 12 Tf 72 640 Td (untouched four) Tj ET EMC"
  ].join("\n");
  const { bytes } = await makePdf([{
    content,
    resources: { Properties: { MC0: { ActualText: PDFString.of("SECRET-ACTUAL-2"), E: PDFString.of("expansion"), Lang: PDFString.of("en") }, MC1: { ActualText: PDFString.of("KEPT-ACTUAL-4") } } }
  }]);
  const doc = await load(bytes);
  const before = pageResources(doc, 0);
  const rep = removeTextInRects(doc, 0, [await boxOf(bytes, "glyphs one"), await boxOf(bytes, "two")]);
  assert.equal(rep.markedContentStripped, 2);
  assert.deepEqual(rep.touchedMcids, ["page:0"]);
  pruneResources(doc, [before, pageResources(doc, 0)]);
  await collectGarbage(doc);
  // the raw scan looks at the bytes and at every decoded stream of the saved file
  const out = await save(doc);
  const hits = ["SECRET-ACTUAL-1", "SECRET-ACTUAL-2", "expansion", "KEPT-ACTUAL-3", "kept alt", "KEPT-ACTUAL-4"].map((s) => [s, found(out, s)]);
  assert.deepEqual(hits, [["SECRET-ACTUAL-1", false], ["SECRET-ACTUAL-2", false], ["expansion", false], ["KEPT-ACTUAL-3", true], ["kept alt", true], ["KEPT-ACTUAL-4", true]]);
  const c = pageContent(doc);
  assert.match(c, /\/Span <<\/MCID 0>> BDC/);
  assert.match(c, /\/Span \/MC0_r0 BDC/);
  const props = A.get(pageResources(doc, 0), "Properties");
  assert.deepEqual(props.keys().map((k) => k.decodeText()).sort(), ["MC0_r0", "MC1"]);
  assert.equal(A.get(A.get(props, "MC0_r0"), "Lang").decodeText(), "en");
});

test("stray Q and unclosed q: the rewritten page content is isolated and balanced", async () => {
  const { bytes } = await dirtyCtmPdf();
  const doc = await load(bytes);
  const p3 = removeTextInRects(doc, 2, [], { normalize: true });
  assert.equal(p3.strayQ, 1);
  assert.equal(p3.changed, true);
  const p2 = removeTextInRects(doc, 1, [], { normalize: true });
  assert.equal(p2.unclosedQ, 1);
  const p1 = removeTextInRects(doc, 0, [], { normalize: true });
  assert.deepEqual([p1.strayQ, p1.unclosedQ], [0, 0]);
  for (const [page, opens] of [[2, 1], [1, 2], [0, 1]]) {
    const c = pageContent(doc, page).trim();
    assert.ok(c.startsWith("q\n"));
    const names = parseContentStream(bytesOf(c)).ops.map((o) => o.op);
    const q = names.filter((n) => n === "q").length;
    const Q = names.filter((n) => n === "Q").length;
    assert.equal(q, Q, `page ${page + 1}: ${q} q and ${Q} Q`);
    assert.equal(q, opens);
    // the depth never drops below zero: no Q can close the wrapper early
    let depth = 0;
    for (const n of names) {
      if (n === "q") depth++;
      if (n === "Q") depth--;
      assert.ok(depth >= 0);
    }
  }
  // nothing moved, on any of the three pages
  const out = await save(doc);
  for (const page of [0, 1, 2]) assert.equal(verifyPageText(await snap(bytes, page), await snap(out, page), []).ok, true, `page ${page + 1}`);
  // and glyphs are found where the dirty matrices put them
  for (const [page, word] of [[0, "DIRTY-ONE"], [1, "DIRTY-TWO"], [2, "DIRTY-THREE"]]) {
    const r = await run(bytes, [await boxOf(bytes, word, { page, pad: 0.3 })], { page });
    // on the rotated page the upright box around the tilted word also catches the space next to it
    assert.ok(r.report.glyphsRemoved >= word.length && r.report.glyphsRemoved <= word.length + 1, `${word}: ${r.report.glyphsRemoved} glyphs`);
    assert.equal(r.verdict.ok, true, `${word}: ${JSON.stringify(r.verdict.failures)}`);
    assert.ok(!(await pageTextOf(r.bytes, page)).includes(word));
  }
});

test("content that ends inside a text object, marked content or a compatibility section is closed before the wrapper", async () => {
  const { bytes } = await makePdf([{ content: "/Span BMC BX BT /F1 12 Tf 72 700 Td (open ended content) Tj" }]);
  const doc = await load(bytes);
  const rep = removeTextInRects(doc, 0, [], { normalize: true });
  assert.equal(rep.status, "ok");
  const names = parseContentStream(bytesOf(pageContent(doc))).ops.map((o) => o.op);
  assert.deepEqual(names, ["q", "BMC", "BX", "BT", "Tf", "Td", "Tj", "ET", "EMC", "EX", "Q"]);
  assert.equal(await pageTextOf(await save(doc)), "openendedcontent");
});

test("what is not understood is reported as unsupported, and the document is left alone", async () => {
  const sjis = { Type: "Font", Subtype: "Type0", BaseFont: "MS-Gothic", Encoding: "90ms-RKSJ-H", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType2", BaseFont: "MS-Gothic", DW: 1000, W: [231, 389, 500], CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 2 } }] };
  const text = "BT /F1 12 Tf 72 700 Td (target text) Tj ET";
  const target = [70, 695, 140, 712];
  const form = (content, dict) => (ctx, refs, fonts) => formXObject(content, dict)(ctx, refs, fonts);
  const type3 = (ctx, refs, fonts) => ctx.register(ctx.obj({
    Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FirstChar: 97, LastChar: 97, Widths: [600],
    Encoding: { Type: "Encoding", Differences: [97, "a"] }, Resources: { Font: fonts },
    CharProcs: { a: ctx.register(ctx.stream(bytesOf("600 0 d0 BT /F1 500 Tf 0 0 Td (x) Tj ET"))) }
  }));
  const softMask = (ctx, refs, fonts) => ({ GS1: { Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: formXObject("BT /F1 9 Tf 0 0 Td (mask text) Tj ET", { Group: { S: "Transparency" } })(ctx, refs, fonts) } } });
  const pattern = (ctx, refs, fonts) => ({ P1: ctx.register(ctx.stream(bytesOf("BT /F1 8 Tf 0 0 Td (pattern text) Tj ET"), { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 50, 20], XStep: 50, YStep: 20, Resources: { Font: fonts } })) });
  // (the review) the same one level deeper: a form inside the pattern, the glyph procedure or the mask shows the
  // text; a pattern or a mask that draws a picture
  const textForm = (ctx, refs, fonts) => formXObject("1 g BT /F1 8 Tf 0 0 Td (white text in a form) Tj ET")(ctx, refs, fonts);
  const tiling = (content, resources) => (ctx, refs, fonts) => ({ P1: ctx.register(ctx.stream(bytesOf(content), { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 50, 20], XStep: 50, YStep: 20, Resources: resources(ctx, refs, fonts) })) });
  const type3Form = (ctx, refs, fonts) => ctx.register(ctx.obj({
    Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FirstChar: 97, LastChar: 97, Widths: [600],
    Encoding: { Type: "Encoding", Differences: [97, "a"] }, Resources: { XObject: { Tx: textForm(ctx, refs, fonts) } },
    CharProcs: { a: ctx.register(ctx.stream(bytesOf("600 0 d0 /Tx Do"))) }
  }));
  const softMaskOf = (content, resources) => (ctx, refs, fonts) => ({ GS1: { Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: ctx.register(ctx.stream(bytesOf(content), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 612, 792], Group: { S: "Transparency" }, Resources: resources(ctx, refs, fonts) })) } } });
  const loop = (ctx) => {
    const ref = ctx.nextRef();
    ctx.assign(ref, ctx.stream(bytesOf("/Self Do"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Resources: { XObject: { Self: ref } } }));
    return { Loop: ref };
  };
  const deep = (ctx, refs, fonts) => {
    let inner = formXObject("BT /F1 9 Tf 0 0 Td (x) Tj ET")(ctx, refs, fonts);
    for (let level = 0; level < 30; level++) inner = ctx.register(ctx.stream(bytesOf("/In Do"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Resources: { XObject: { In: inner } } }));
    return { Deep: inner };
  };
  const cases = [
    ["unknown-operator", `${text} 1 2 frobnicate`, {}],
    ["text-outside-bt", `/F1 12 Tf (stray) Tj ${text}`, {}],
    ["nested-bt", `BT BT ET ET ${text}`, {}],
    ["content-syntax", `${text} (unterminated`, {}],
    ["operands", `1 2 3 cm ${text}`, {}],
    ["clip-text", "BT /F1 12 Tf 7 Tr 72 700 Td (target text) Tj ET", {}],
    ["image-in-target", `${text} q 100 0 0 100 100 650 cm /Im1 Do Q`, { XObject: (ctx) => ({ Im1: grayImage()(ctx) }) }],
    ["image-in-target", `${text} q 100 0 0 100 100 650 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q`, {}],
    ["vector-in-target", `${text} 60 690 m 100 730 200 600 300 705 c S`, {}],
    ["vector-in-target", `${text} ${Array.from({ length: MAX_LINE_SEGMENTS_IN_TARGETS + 1 }, (_, i) => `${72 + i * 2} 690 m ${72 + i * 2} 720 l S`).join(" ")}`, {}],
    // one straight line would be left to the pixel check, but not inside a layer: it may be hidden in every render
    ["vector-in-target", `${text} /OC /L1 BDC 60 705 m 300 705 l S EMC`, { Properties: () => ({ L1: { Type: "OCG", Name: PDFString.of("layer") } }) }],
    ["vector-in-target", `${text} /Lay Do`, { XObject: (ctx, refs, fonts) => ({ Lay: form("60 705 m 300 705 l S", { OC: { Type: "OCG", Name: PDFString.of("layer") } })(ctx, refs, fonts) }) }],
    ["unmeasurable-text", "BT /J 12 Tf 72 700 Td <82A082A2> Tj ET", { Font: (ctx, refs, fonts) => ({ ...fonts, J: ctx.register(ctx.obj(sjis)) }) }],
    ["type3-glyph-text", `${text} BT /T3 12 Tf 300 300 Td (a) Tj ET`, { Font: (ctx, refs, fonts) => ({ ...fonts, T3: type3(ctx, refs, fonts) }) }],
    ["smask-text", `/GS1 gs ${text}`, { ExtGState: softMask }],
    ["pattern-text", `${text} /Pattern cs /P1 scn 300 300 100 100 re f`, { Pattern: pattern }],
    ["pattern-text", `${text} /Pattern cs /P1 scn 300 300 100 100 re f`, { Pattern: tiling("/Tx Do", (ctx, refs, fonts) => ({ XObject: { Tx: textForm(ctx, refs, fonts) } })) }],
    ["pattern-text", `${text} /Pattern cs /P1 scn 300 300 100 100 re f`, { Pattern: tiling("q 50 0 0 20 0 0 cm /Im Do Q", (ctx) => ({ XObject: { Im: grayImage()(ctx) } })) }],
    ["type3-glyph-text", `${text} BT /T3 12 Tf 300 300 Td (a) Tj ET`, { Font: (ctx, refs, fonts) => ({ ...fonts, T3: type3Form(ctx, refs, fonts) }) }],
    ["smask-text", `/GS1 gs ${text}`, { ExtGState: softMaskOf("/Tx Do", (ctx, refs, fonts) => ({ XObject: { Tx: textForm(ctx, refs, fonts) } })) }],
    ["smask-image", `/GS1 gs ${text}`, { ExtGState: softMaskOf("q 200 0 0 30 60 690 cm /Im Do Q", (ctx) => ({ XObject: { Im: grayImage()(ctx) } })) }],
    ["form-unbalanced-q", `${text} /Fm Do`, { XObject: (ctx, refs, fonts) => ({ Fm: form("Q BT /F1 9 Tf 0 0 Td (x) Tj ET")(ctx, refs, fonts) }) }],
    ["form-recursion", `${text} /Loop Do`, { XObject: loop }],
    ["form-depth", `${text} /Deep Do`, { XObject: deep }],
    ["xobject", `${text} /Odd Do`, { XObject: (ctx) => ({ Odd: ctx.register(ctx.stream(bytesOf("x"), { Type: "XObject", Subtype: "Strange" })) }) }],
    ["stream-decode", `${text} /Fm Do`, { XObject: (ctx) => ({ Fm: ctx.register(pdfLib.PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Filter: "JBIG2Decode" }), bytesOf("xx"))) }) }]
  ];
  const seen = new Set();
  for (const [code, content, res] of cases) {
    const { bytes } = await makePdf([{ content: bytesOf(content), resources: (ctx, refs, fonts) => Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v(ctx, refs, fonts)])) }]);
    const doc = await load(bytes);
    const contentsBefore = doc.getPage(0).node.get(PDFName.of("Contents"));
    const resourcesBefore = doc.getPage(0).node.get(PDFName.of("Resources"));
    const objectsBefore = doc.context.enumerateIndirectObjects().length;
    const rep = removeTextInRects(doc, 0, [target]);
    assert.equal(rep.status, "unsupported", `${code}: ${JSON.stringify(rep.reason)}`);
    assert.equal(rep.reason.code, code, rep.reason.message);
    assert.equal(typeof rep.reason.params, "object");
    assert.equal(doc.getPage(0).node.get(PDFName.of("Contents")), contentsBefore, `${code}: the page was modified`);
    assert.equal(doc.getPage(0).node.get(PDFName.of("Resources")), resourcesBefore, `${code}: the resources were modified`);
    assert.equal(doc.context.enumerateIndirectObjects().length, objectsBefore, `${code}: objects were added`);
    seen.add(code);
  }
  // a /Contents entry that is not a stream
  const { bytes: odd } = await makePdf([{ content: text }], { setup: (doc) => doc.getPage(0).node.set(PDFName.of("Contents"), doc.context.obj([doc.context.obj({ Not: "AStream" })])) });
  const oddRep = removeTextInRects(await load(odd), 0, [target]);
  assert.equal(oddRep.reason?.code, "contents");
  seen.add("contents");
  // every token codes.js maps to a public code can really be produced
  assert.deepEqual([...FALLBACK_TOKENS].sort(), [...seen].sort());
});

// ---------------------------------------------------------------------------------------------------------
// the review, defects 2 and 3: what a removed picture, form or line leaves behind

test("a Form XObject that loses a picture gets private resources: its copy does not reach the picture any more", async () => {
  // (the review: the copy of the form drew nothing of the picture, but its resources still listed it, so
  // the picture stayed in the file in full)
  const image = (ctx) => ctx.register(ctx.stream(new Uint8Array(16).fill(90), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
  const resources = (ctx, refs, fonts) => ({ Font: fonts, XObject: { Fm: refs.Outer } });
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 740 Td (heading stays) Tj ET q 1 0 0 1 60 520 cm /Fm Do Q", resources }, { content: "q 1 0 0 1 60 520 cm /Fm Do Q", resources }], {
    objects: {
      Im: image,
      // the resource dictionary is an object of its own, shared by both forms (as producers write it)
      Shared: (ctx, refs, fonts) => ctx.register(ctx.obj({ Font: fonts, XObject: { Im: refs.Im } })),
      Inner: (ctx, refs) => ctx.register(ctx.stream(bytesOf("q 240 0 0 150 0 0 cm /Im Do Q BT /F1 9 Tf 0 160 Td (caption kept) Tj ET"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 240, 200], Resources: refs.Shared })),
      Outer: (ctx, refs) => ctx.register(ctx.stream(bytesOf("/Inner Do"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 240, 200], Resources: { XObject: { Inner: refs.Inner } } }))
    }
  });
  const doc = await load(bytes);
  const before = pageResources(doc, 0);
  const report = removeTextInRects(doc, 0, [[55, 515, 305, 675]]);
  assert.equal(report.status, "ok");
  assert.deepEqual([report.imagesRemoved, report.formsCloned, report.glyphsRemoved], [1, 2, 0]);
  assert.equal(report.clonedResources.length, 2, "each copy of a form has a resource dictionary of its own");
  // the caller prunes what the copies no longer draw (redactPdf does this for every precise page)
  pruneResources(doc, [before, pageResources(doc, 0), ...report.clonedResources]);
  // the form a piece of content draws (the copies have names of their own; the old entries were pruned)
  const drawn = (resources, content) => {
    const xobjects = A.get(resources, "XObject");
    assert.equal(xobjects.keys().length, 1, `one form is drawn and one is listed (${xobjects.keys().map((key) => key.decodeText())})`);
    return xobjects.lookup(PDFName.of(/\/(\w+) Do/.exec(content)[1]));
  };
  const formOf = (pageIndex) => drawn(pageResources(doc, pageIndex), pageContent(doc, pageIndex));
  const innerOf = (outer) => drawn(A.get(outer.dict, "Resources"), latin1(A.streamBytes(outer)));
  const copy = innerOf(formOf(0));
  const listed = A.get(A.get(copy.dict, "Resources"), "XObject");
  assert.ok(!listed || listed.keys().length === 0, "the copy of the inner form still lists the picture");
  assert.ok(A.isDict(A.get(A.get(copy.dict, "Resources"), "Font")), "... and keeps the font its caption needs");
  assert.ok(latin1(A.streamBytes(copy)).includes("caption kept") && !latin1(A.streamBytes(copy)).includes("/Im Do"));
  // page 2 draws the original forms, which reach the picture through the shared dictionary as before
  const original = innerOf(formOf(1));
  assert.notEqual(original, copy);
  assert.ok(A.get(A.get(original.dict, "Resources"), "XObject").has(PDFName.of("Im")));
  assert.ok(latin1(A.streamBytes(original)).includes("/Im Do"));
  // after the sweep the picture is still an object of the file (page 2 needs it), reachable from page 2 only
  await collectGarbage(doc);
  const saved = await load(await save(doc));
  assert.equal(saved.context.enumerateIndirectObjects().filter(([, object]) => object.dict && A.getName(object.dict, "Subtype") === "Image").length, 1);
});

test("what is left without anything to paint goes with it: the graphics state around a removed picture or path", async () => {
  // (the review: "q 0.9 g /GS7 gs 240 0 0 150 60 520 cm Q" stayed behind: the place and the size of the
  // picture, and the reference to its graphics state)
  const content = [
    "BT /F1 12 Tf 72 740 Td (heading stays) Tj ET",
    "q 0.9 g /GS7 gs 240 0 0 150 60 520 cm /Im Do Q", // a picture under the mark, in a group of its own
    "q 0.5 w 1 0 0 RG 70 600 m 200 600 l S Q", // a rule under the mark
    "q 1 0 0 1 0 -400 cm 0.2 g 70 600 m 200 600 l S /Im Do Q", // away from the mark (the picture is 1 x 1 pt there)
    "q 0 0 1 rg BT /F1 12 Tf 72 300 Td (text in a group stays) Tj ET Q"
  ].join("\n");
  const { bytes } = await makePdf([{ content, resources: (ctx, refs, fonts) => ({ Font: fonts, XObject: { Im: grayImage()(ctx) }, ExtGState: { GS7: { Type: "ExtGState", CA: 0.5 } } }) }]);
  const r = await run(bytes, [[55, 515, 305, 675]]);
  assert.equal(r.report.status, "ok");
  assert.deepEqual([r.report.imagesRemoved, r.report.pathsRemoved, r.report.groupsDropped], [1, 1, 2]);
  const text = pageContent(r.doc);
  assert.ok(!text.includes("/GS7 gs") && !text.includes("240 0 0 150 60 520 cm") && !text.includes("0.5 w"), `the state of the removed picture and rule is still in the content:\n${text}`);
  // groups that still paint are what they were
  assert.ok(text.includes("q 1 0 0 1 0 -400 cm 0.2 g 70 600 m 200 600 l S /Im Do Q") && text.includes("q 0 0 1 rg BT /F1 12 Tf 72 300 Td (text in a group stays) Tj ET Q"), text);
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
  // nothing refers to the graphics state any more: the caller's pruning takes it out of the resources
  const pruned = pruneResources(r.doc, [pageResources(r.doc, 0)]);
  assert.ok(pruned.deleted.some((entry) => entry.category === "ExtGState" && entry.name === "GS7"), JSON.stringify(pruned.deleted.map((entry) => [entry.category, entry.name])));
  // a text-only target takes glyphs and leaves every group alone
  const erased = await run(bytes, [], { eraseRects: [[55, 515, 305, 675]] });
  assert.equal(erased.report.groupsDropped, 0);
  assert.ok(pageContent(erased.doc).includes("/GS7 gs"));
});

test("a font that shows nothing any more is released from the page: its entry points at a stand-in", async () => {
  // (the review, defect 1: the subset font of a removed line stayed in the resources of the page, and with
  // it every glyph of the line)
  const subset = (ctx) => ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "SECRET+OnlyForTheSecret", Encoding: "WinAnsiEncoding", FirstChar: 32, LastChar: 126, Widths: new Array(95).fill(500) }));
  const content = "BT /F1 12 Tf 72 700 Td (kept line) Tj /S1 12 Tf 0 -30 Td (SECRET 4711) Tj /S2 12 Tf 0 -30 Td (SECRET 0815 and a tail) Tj ET";
  const { bytes } = await makePdf([{ content, resources: (ctx, refs, fonts) => ({ Font: { ...fonts, S1: subset(ctx), S2: subset(ctx) } }) }]);
  const lineOne = await boxOf(bytes, "SECRET 4711", { pad: 0.5 });
  const partOfTwo = await boxOf(bytes, "SECRET 0815", { pad: 0.5 });
  const r = await run(bytes, [lineOne, partOfTwo]);
  assert.equal(r.report.status, "ok");
  assert.equal(r.report.fontsReleased, 1, "S1 showed the removed line only; S2 still shows the tail");
  const fonts = A.get(A.get(r.doc.getPage(0).node, "Resources"), "Font");
  const name = (key) => A.getName(fonts.lookup(PDFName.of(key)), "BaseFont");
  assert.deepEqual([name("F1"), name("S1"), name("S2")], ["Helvetica", "Helvetica", "SECRET+OnlyForTheSecret"]);
  assert.deepEqual(fonts.lookup(PDFName.of("S1")).keys().map((key) => key.decodeText()).sort(), ["BaseFont", "Encoding", "Subtype", "Type"], "the stand-in is a bare standard font: no widths, no descriptor, no program");
  // the operators that select the font stay (the text state of what follows must not change)
  assert.ok(pageContent(r.doc).includes("/S1 12 Tf"));
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures));
  // a dry run releases nothing
  const doc = await load(bytes);
  const fontsBefore = A.get(A.get(doc.getPage(0).node, "Resources"), "Font");
  assert.equal(removeTextInRects(doc, 0, [lineOne], { dryRun: true }).status, "ok");
  assert.equal(A.get(A.get(doc.getPage(0).node, "Resources"), "Font"), fontsBefore);
});

test("a soft mask that draws pictures: refused where it reaches a strict target, left alone elsewhere", async () => {
  const text = "BT /F1 12 Tf 72 700 Td (target text) Tj ET";
  const target = [70, 695, 140, 712];
  const mask = (box, matrix) => (ctx) => ({ GS1: { Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: ctx.register(ctx.stream(bytesOf(`q ${box[2] - box[0]} 0 0 ${box[3] - box[1]} ${box[0]} ${box[1]} cm /Im Do Q`), {
    Type: "XObject", Subtype: "Form", BBox: box, ...(matrix ? { Matrix: matrix } : {}), Group: { S: "Transparency", CS: "DeviceGray" }, Resources: { XObject: { Im: grayImage()(ctx) } }
  })) } } });
  const status = async (content, extGState, options) => {
    const { bytes } = await makePdf([{ content, resources: (ctx, refs, fonts) => ({ Font: fonts, ExtGState: extGState(ctx) }) }]);
    const report = removeTextInRects(await load(bytes), 0, options?.erase ? [] : [target], options?.erase ? { eraseRects: [target] } : {});
    return report.status === "ok" ? "ok" : report.reason.code;
  };
  // the box of the mask, in the coordinates that are current where the state is set, decides
  assert.equal(await status(`/GS1 gs ${text}`, mask([60, 690, 260, 720])), "smask-image");
  assert.equal(await status(`/GS1 gs ${text}`, mask([60, 300, 260, 330])), "ok");
  assert.equal(await status(`q 1 0 0 1 0 390 cm /GS1 gs Q ${text}`, mask([60, 300, 260, 330])), "smask-image", "moved over the target by the matrix of the page");
  assert.equal(await status(`/GS1 gs ${text}`, mask([60, 300, 260, 330], [1, 0, 0, 1, 0, 390])), "smask-image", "moved over the target by the matrix of the group");
  assert.equal(await status(`/GS1 gs ${text}`, mask([60, 690, 260, 720]), { erase: true }), "ok", "a text-only target looks at glyphs only");
});

test("text that cannot be measured is harmless when no target is on its baseline", async () => {
  const sjis = { Type: "Font", Subtype: "Type0", BaseFont: "MS-Gothic", Encoding: "90ms-RKSJ-H", DescendantFonts: [{ Type: "Font", Subtype: "CIDFontType2", BaseFont: "MS-Gothic", DW: 1000, W: [231, 389, 500] }] };
  const content = "BT /J 12 Tf 72 700 Td <82A082A2> Tj /F1 12 Tf (same line, position unknown) Tj 0 -100 Td (target text) Tj ET";
  const { bytes } = await makePdf([{ content, resources: (ctx, refs, fonts) => ({ Font: { ...fonts, J: ctx.register(ctx.obj(sjis)) } }) }]);
  const doc = await load(bytes);
  let rep = removeTextInRects(doc, 0, [[70, 595, 140, 612]]);
  assert.equal(rep.status, "ok");
  assert.equal(rep.glyphsRemoved, "target text".length);
  assert.equal(rep.unmeasurableOps, 2); // the SJIS string, and the Helvetica string that continues its line
  assert.ok(pageContent(doc).includes("<82A082A2> Tj /F1 12 Tf (same line, position unknown) Tj"));
  // a target anywhere on the baseline of the unmeasurable text is refused, even far to the right
  rep = removeTextInRects(await load(bytes), 0, [[400, 698, 500, 708]]);
  assert.equal(rep.reason?.code, "unmeasurable-text");
  assert.deepEqual(rep.reason.params, { font: "MS-Gothic" });
  // ... also when the target only takes text (the erase of a replaced line)
  rep = removeTextInRects(await load(bytes), 0, [], { eraseRects: [[400, 698, 500, 708]] });
  assert.equal(rep.reason?.code, "unmeasurable-text");
});

test("pictures and paths completely under a strict target are removed; a text-only target ignores them", async () => {
  const content = "BT /F1 12 Tf 72 700 Td (underlined target) Tj ET\n72 698 96 0.6 re f\nq 20 0 0 8 80 701 cm /Sig Do Q\n0 0 1 RG 300 300 m 320 380 360 380 400 300 c S\nq 50 0 0 50 300 100 cm /Sig Do Q";
  const { bytes } = await makePdf([{ content, resources: (ctx) => ({ XObject: { Sig: grayImage()(ctx) } }) }]);
  const rect = [70, 696, 172, 713];
  const r = await run(bytes, [rect]);
  assert.equal(r.report.status, "ok");
  assert.equal(r.report.pathsRemoved, 1);
  assert.equal(r.report.imagesRemoved, 1);
  const c = pageContent(r.doc);
  assert.ok(!c.includes("72 698 96 0.6 re") && c.includes("300 300 m 320 380 360 380 400 300 c S") && c.includes("q 50 0 0 50 300 100 cm /Sig Do Q"), c);
  assert.equal((c.match(/\/Sig Do/g) || []).length, 1);
  // text-only (mode): the glyphs go, the underline and the picture stay, nothing is refused
  let t = await run(bytes, [rect], { mode: "text-only" });
  assert.equal(t.report.status, "ok");
  assert.equal(t.report.pathsRemoved, 0);
  assert.equal((pageContent(t.doc).match(/\/Sig Do/g) || []).length, 2);
  // text-only (per rectangle): the same through eraseRects, next to a strict target elsewhere on the page
  t = await run(bytes, [[290, 90, 360, 160]], { eraseRects: [rect] });
  assert.equal(t.report.status, "ok");
  assert.equal(t.report.glyphsRemoved, "underlined target".length);
  assert.deepEqual([t.report.pathsRemoved, t.report.imagesRemoved], [0, 1]); // only the picture under the STRICT target went
  const mixed = pageContent(t.doc);
  assert.ok(mixed.includes("72 698 96 0.6 re f") && mixed.includes("q 20 0 0 8 80 701 cm /Sig Do Q") && !mixed.includes("q 50 0 0 50 300 100 cm /Sig Do Q"), mixed);
  // a picture that only reaches into an erase rectangle refuses nothing either
  t = await run(bytes, [], { eraseRects: [[70, 696, 90, 713]] });
  assert.equal(t.report.status, "ok");
  assert.equal(t.verdict.ok, true, JSON.stringify(t.verdict.failures));
});

test("font set through an ExtGState; dryRun changes nothing and reports the boxes", async () => {
  const { bytes } = await makePdf([{ content: "/GS1 gs BT 72 700 Td (via gs font) Tj ET", resources: (ctx, refs, fonts) => ({ ExtGState: { GS1: { Type: "ExtGState", Font: [fonts.F1, 14] } } }) }]);
  const doc = await load(bytes);
  const rect = await boxOf(bytes, "gs");
  const contents = doc.getPage(0).node.get(PDFName.of("Contents"));
  const dry = removeTextInRects(doc, 0, [rect], { dryRun: true, collectQuads: true });
  assert.equal(dry.glyphsRemoved, 2);
  assert.equal(dry.removedQuads.length, 2);
  assert.equal(doc.getPage(0).node.get(PDFName.of("Contents")), contents);
  const real = removeTextInRects(doc, 0, [rect]);
  assert.equal(real.glyphsRemoved, 2);
  assert.notEqual(doc.getPage(0).node.get(PDFName.of("Contents")), contents);
  // no target hit, no normalisation asked: the page is not rewritten
  const doc2 = await load(bytes);
  const c2 = doc2.getPage(0).node.get(PDFName.of("Contents"));
  assert.equal(removeTextInRects(doc2, 0, [[400, 100, 450, 120]]).changed, false);
  assert.equal(doc2.getPage(0).node.get(PDFName.of("Contents")), c2);
});

test("every text operator, with a word cut out of each line", async () => {
  const { bytes } = await textOpsPdf();
  const before = await snap(bytes, 0);
  // one word out of every text item that has at least three words
  const rects = [];
  for (const it of before.items) {
    const words = it.str.split(" ");
    if (words.length < 3 || Math.abs(it.angle) > 0.01) continue;
    const start = it.str.indexOf(words[1]);
    const share = (n) => it.box[0] + (it.width * n) / it.str.length;
    rects.push([share(start) + 0.5, it.box[1], share(start + words[1].length) - 0.5, it.box[3]]);
  }
  assert.ok(rects.length >= 15, `${rects.length} targets`);
  const r = await run(bytes, [], { eraseRects: rects });
  assert.equal(r.report.status, "ok");
  assert.ok(r.report.glyphsRemoved > 60, `${r.report.glyphsRemoved} glyphs removed`);
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.failures.slice(0, 3)));
  assert.equal(r.verdict.stats.lost, 0);
  assert.equal(r.verdict.stats.added, 0);
  // the rotated line as a whole (its box is a tilted quad: a target around its glyphs takes it and nothing else)
  const rotated = await run(bytes, [await boxOf(bytes, "thirty")]);
  assert.equal(rotated.report.status, "ok");
  assert.ok(rotated.report.glyphsRemoved >= "thirty".length);
  assert.equal(rotated.verdict.ok, true, JSON.stringify(rotated.verdict.failures));
});
