// What surrounds the page content (engine/redact/documentScrub.js, resourceUsage.js): annotations and form
// fields, the structure tree, shared resources, and the garbage collection that makes a save safe.
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectGarbage, detachPageFromStructTree, findTextElsewhere, listTextCarriers, reachableRefs, releaseOrphanedObjects, removeAnnotations, stripPageExtras,
  stripStructAttributes, stripStructureWords
} from "../src/pages/pdfEditor/engine/redact/documentScrub.js";
import * as scrubApi from "../src/pages/pdfEditor/engine/redact/documentScrub.js";
import { pageResources, pruneResources, usedResourceNames } from "../src/pages/pdfEditor/engine/redact/resourceUsage.js";
import { removeTextInRects } from "../src/pages/pdfEditor/engine/redact/textRemoval.js";
import { redactPdf } from "../src/pages/pdfEditor/engine/redact/index.js";
import { canRender, makeTextPdf, pdfLib } from "./helpers/pdfTestKit.mjs";
import { A, boxOf, bytesOf, findOrphans, formXObject, found, load, makePdf, pageTextOf, redactEnv, save } from "./helpers/pdfRedactKit.mjs";
import { annotatedFormPdf, taggedPdf } from "./helpers/pdfRedactFixtures.mjs";

const { PDFDocument, PDFName, PDFString, StandardFonts } = pdfLib;
const S = (s) => PDFString.of(s);
const needCanvas = { skip: !canRender && "no canvas binary on this platform" };

test("collectGarbage: the library writes unreferenced objects, the collector removes them", async () => {
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (ORPHAN-SECRET-1 on the page) Tj ET" }]);
  const doc = await load(bytes);
  // replace the content: the old stream is no longer referenced by anything
  const node = doc.getPage(0).node;
  node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(bytesOf("BT /F1 12 Tf 72 700 Td (new) Tj ET"))));
  const leaky = await save(doc);
  assert.equal(found(leaky, "ORPHAN-SECRET-1"), true, "save() is expected to keep the unreferenced stream");
  assert.equal((await findOrphans(leaky)).length, 1);
  const stats = await collectGarbage(doc);
  assert.equal(stats.deleted, 1);
  assert.equal(stats.kept, reachableRefs(doc).size);
  const clean = await save(doc);
  assert.equal(found(clean, "ORPHAN-SECRET-1"), false);
  assert.deepEqual(await findOrphans(clean), []);
  assert.equal(await pageTextOf(clean), "new");
});

test("collectGarbage: indirect stream lengths, the parser's own leftovers and the trailer size", async () => {
  // a stream with /Length 9 0 R, as pdfTeX, LibreOffice and Ghostscript write it: the writer inlines the number
  // while saving, which would leave the number object behind
  const { bytes: plain } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (indirect length) Tj ET" }]);
  const doc = await load(plain);
  const contents = doc.context.lookup(doc.getPage(0).node.get(PDFName.of("Contents")));
  const length = doc.context.register(pdfLib.PDFNumber.of(contents.getContentsSize()));
  contents.dict.set(PDFName.of("Length"), length);
  const before = await save(doc);
  assert.equal((await findOrphans(before)).length, 1, "fixture: the inlined /Length leaves its number object behind");
  await collectGarbage(doc);
  const after = await save(doc);
  assert.deepEqual(await findOrphans(after), []);
  assert.equal(await pageTextOf(after), "indirectlength");
  // a source with object streams: the library keeps the /ObjStm and /XRef streams it parsed in its context
  const packed = await makeTextPdf([{ lines: ["object streams"] }], { useObjectStreams: true });
  const loaded = await load(packed);
  const artefacts = loaded.context.enumerateIndirectObjects().filter(([, object]) => A.isStream(object) && ["ObjStm", "XRef"].includes(A.getName(object.dict, "Type")));
  assert.ok(artefacts.length >= 1, "fixture: the parser kept its container streams");
  const stats = await collectGarbage(loaded);
  assert.ok(stats.deleted >= artefacts.length);
  assert.equal(loaded.context.largestObjectNumber, Math.max(...loaded.context.enumerateIndirectObjects().map(([ref]) => ref.objectNumber)), "final: the high-water mark is exact");
  const resaved = await loaded.save({ useObjectStreams: false, addDefaultPage: false });
  assert.deepEqual(await findOrphans(resaved), []);
  assert.equal(await pageTextOf(resaved), "objectstreams");
});

test("annotations in a target go with their popups, replies and form fields; others stay", async () => {
  const { bytes } = await makePdf([{
    content: "BT /F1 12 Tf 72 700 Td (text) Tj ET",
    annots: [
      (ctx) => {
        // a note whose popup is not listed in /Annots (it is reachable through /Popup only)
        const note = ctx.nextRef();
        const popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [300, 600, 400, 650], Parent: note, Contents: S("POPUP-SECRET-E") }));
        ctx.assign(note, ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [100, 690, 120, 710], Contents: S("NOTE-SECRET-A"), Popup: popup }));
        return note;
      },
      { Type: "Annot", Subtype: "Link", Rect: [72, 695, 200, 712], A: { S: "URI", URI: S("mailto:secret-b@example.test") } },
      // geometry in /QuadPoints only: the /Rect is far away (as written by fpdf2)
      { Type: "Annot", Subtype: "Highlight", Rect: [676, 719, 854, 676], QuadPoints: [72, 712, 200, 712, 72, 696, 200, 696], Contents: S("HIGHLIGHT-SECRET-C") },
      { Type: "Annot", Subtype: "Link", Rect: [72, 300, 200, 320], A: { S: "URI", URI: S("https://kept.example.test/") } },
      { Type: "Annot", Subtype: "Ink", Rect: [0, 0, 1, 1], InkList: [[90, 700, 150, 705]], Contents: S("INK-SECRET-D") }
    ]
  }]);
  const doc = await load(bytes);
  const res = removeAnnotations(doc, 0, { rects: [[70, 694, 210, 714]] });
  assert.deepEqual(res.removed.map((r) => r.subtype).sort(), ["Highlight", "Ink", "Link", "Text"]);
  assert.equal(res.kept, 1); // the link further down the page
  await collectGarbage(doc);
  const out = await save(doc);
  for (const s of ["NOTE-SECRET-A", "mailto:secret-b@example.test", "HIGHLIGHT-SECRET-C", "INK-SECRET-D", "POPUP-SECRET-E"]) assert.equal(found(out, s), false, s);
  assert.equal(found(out, "https://kept.example.test/"), true);
  // no target, no "all": nothing happens
  const untouched = await load(bytes);
  assert.deepEqual(removeAnnotations(untouched, 0, { rects: [] }).removed, []);
  assert.equal(removeAnnotations(untouched, 0, {}).kept, 5);
});

test("a popup listed in /Annots goes with its parent, and so does a reply", async () => {
  const { bytes } = await makePdf([{
    content: "BT /F1 12 Tf 72 700 Td (text) Tj ET",
    annots: [(ctx) => ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [100, 690, 120, 710], Contents: S("PARENT-NOTE") }))]
  }]);
  const doc = await load(bytes);
  const node = doc.getPage(0).node;
  const annots = A.get(node, "Annots");
  const parentRef = annots.get(0);
  annots.push(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Popup", Rect: [300, 600, 400, 650], Parent: parentRef })));
  annots.push(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [500, 500, 520, 520], IRT: parentRef, Contents: S("REPLY-TEXT") })));
  const res = removeAnnotations(doc, 0, { rects: [[90, 680, 130, 720]] });
  assert.deepEqual(res.removed.map((r) => r.subtype).sort(), ["Popup", "Text", "Text"]);
  assert.equal(A.get(node, "Annots"), undefined);
});

test("form fields: the value goes with the last widget; a field with widgets elsewhere is emptied when the mark hit it", async () => {
  const { bytes } = await annotatedFormPdf({ xfa: true });
  const carriers = listTextCarriers(await load(bytes), 0);
  assert.ok(carriers.some((c) => c.field === "fullName" && c.value === "FIELD-VALUE-7731" && c.hasAppearance));
  // 1. the only widget of "fullName"
  let doc = await load(bytes);
  let res = removeAnnotations(doc, 0, { rects: [[70, 656, 310, 688]] });
  assert.deepEqual([res.fieldsRemoved, res.fieldsCleared, res.fieldsKept, res.xfaRemoved], [["fullName"], [], [], true]);
  await collectGarbage(doc);
  let out = await save(doc);
  assert.equal(found(out, "FIELD-VALUE-7731"), false);
  assert.equal(found(out, "XFA-COPY-OF-VALUES"), false, "the XFA packet repeats the values: it goes with the first widget");
  assert.deepEqual((await PDFDocument.load(out)).getForm().getFields().map((f) => f.getName()), ["keptField", "contractNo"]);
  // 2. one of the two widgets of "contractNo", under a mark: the value is deleted, the other widget stops showing it
  doc = await load(bytes);
  res = removeAnnotations(doc, 0, { rects: [[318, 656, 530, 688]] });
  assert.deepEqual([res.fieldsRemoved, res.fieldsCleared, res.fieldsKept], [[], [{ field: "contractNo", widgets: 1 }], []]);
  await collectGarbage(doc);
  out = await save(doc);
  assert.equal(found(out, "CONTRACT-VALUE-42"), false, "neither /V nor the appearance of the widget on page 2 may keep the value");
  const reloaded = await PDFDocument.load(out);
  const contract = reloaded.getForm().getTextField("contractNo");
  assert.equal(contract.getText(), undefined);
  assert.equal(contract.acroField.getWidgets().length, 1);
  assert.equal(contract.acroField.getWidgets()[0].dict.has(PDFName.of("AP")), false);
  assert.equal(A.bool(A.get(A.get(reloaded.catalog, "AcroForm"), "NeedAppearances")), true);
  assert.equal(found(out, "FIELD-VALUE-7731"), true, "the field that was not under the mark keeps its value");
  // 3. the whole page is flattened (raster path) and no mark touches the widgets: single-widget fields go
  //    with their page, a field with a widget elsewhere keeps its value
  doc = await load(bytes);
  res = removeAnnotations(doc, 0, { rects: [[70, 688, 400, 714]], all: true });
  assert.deepEqual([res.fieldsRemoved.sort(), res.fieldsCleared, res.fieldsKept], [["fullName", "keptField"], [], [{ field: "contractNo", widgets: 1 }]]);
  assert.equal(res.kept, 0);
  await collectGarbage(doc);
  out = await save(doc);
  assert.equal(found(out, "CONTRACT-VALUE-42"), true);
  assert.equal(found(out, "NOTE-SECRET-A1"), false);
});

test("a button field that keeps a widget is switched off when its other widget was under a mark", async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([300, 300]);
  const page2 = doc.addPage([300, 300]);
  page1.drawText("consent", { x: 20, y: 250, size: 10, font: helvetica });
  const box = doc.getForm().createCheckBox("consent");
  box.addToPage(page1, { x: 20, y: 200, width: 16, height: 16 });
  box.addToPage(page2, { x: 20, y: 200, width: 16, height: 16 });
  box.check();
  const loaded = await load(await doc.save({ useObjectStreams: false }));
  const res = removeAnnotations(loaded, 0, { rects: [[10, 190, 50, 230]] });
  assert.deepEqual(res.fieldsCleared, [{ field: "consent", widgets: 1 }]);
  const reloaded = await PDFDocument.load(await save(loaded));
  const field = reloaded.getForm().getCheckBox("consent");
  assert.equal(field.isChecked(), false);
  assert.equal(A.getName(field.acroField.getWidgets()[0].dict, "AS"), "Off");
  assert.equal(field.acroField.getWidgets()[0].dict.has(PDFName.of("AP")), true, "a check mark is not a value: the appearances stay");
});

test("page extras: thumbnail, private data and metadata of a redacted page are dropped", async () => {
  const { bytes } = await makePdf([{ content: "BT ET", extra: { Thumb: (ctx) => ctx.register(ctx.stream(bytesOf("THUMB-PIXELS-OF-THE-OLD-PAGE"))), PieceInfo: { App: { Private: S("PIECEINFO-COPY") } }, B: [] } }]);
  const doc = await load(bytes);
  assert.deepEqual(stripPageExtras(doc, 0), ["Thumb", "PieceInfo"]);
  assert.deepEqual(stripPageExtras(doc, 0, { raster: true }), ["B"]);
  await collectGarbage(doc);
  const out = await save(doc);
  assert.equal(found(out, "THUMB-PIXELS-OF-THE-OLD-PAGE"), false);
  assert.equal(found(out, "PIECEINFO-COPY"), false);
});

test("resource names used by a content stream", () => {
  const u = usedResourceNames(bytesOf("/GS1 gs /Cs1 cs /P1 scn BT /F1 9 Tf (x) Tj ET /Im3 Do /OC /MC7 BDC EMC /Tag /MC8 DP 0.5 /P2 SCN BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI"));
  assert.deepEqual([...u.XObject], ["Im3"]);
  assert.deepEqual([...u.Font], ["F1"]);
  assert.deepEqual([...u.ExtGState], ["GS1"]);
  assert.deepEqual([...u.Pattern].sort(), ["P1", "P2"]);
  assert.deepEqual([...u.Properties].sort(), ["MC7", "MC8"]);
});

/** Two pages that share ONE resource dictionary (inherited from /Pages), with a form only page 2 draws. */
async function sharedResourcesDoc() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const form = ctx.register(ctx.stream(bytesOf("BT /F1 12 Tf 10 10 Td (SHARED-FORM-SECRET-77) Tj ET"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 40], Resources: { Font: { F1: font } } }));
  const logo = ctx.register(ctx.stream(bytesOf("BT /F1 12 Tf 10 10 Td (LOGO-ON-BOTH-PAGES) Tj ET"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 40], Resources: { Font: { F1: font } } }));
  const shared = ctx.register(ctx.obj({ Font: { F1: font }, XObject: { Fm: form, Logo: logo } }));
  const contents = ["BT /F1 12 Tf 72 700 Td (page one) Tj ET q 1 0 0 1 72 600 cm /Logo Do Q", "BT /F1 12 Tf 72 700 Td (page two) Tj ET q 1 0 0 1 72 500 cm /Fm Do Q q 1 0 0 1 72 600 cm /Logo Do Q"];
  for (const c of contents) {
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(bytesOf(c))));
    page.node.delete(PDFName.of("Resources"));
  }
  doc.catalog.Pages().set(PDFName.of("Resources"), shared);
  return doc.save({ useObjectStreams: false });
}

test("pruneResources deletes only what no user of the dictionary refers to", async () => {
  const bytes = await sharedResourcesDoc();
  const doc = await load(bytes);
  // nothing changed: both entries are in use (Fm by page 2, Logo by both)
  assert.deepEqual(pruneResources(doc, [pageResources(doc, 0)]).deleted, []);
  // page 2 stops drawing the form: now nobody uses it
  doc.getPage(1).node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(bytesOf("BT /F1 12 Tf 72 700 Td (page two) Tj ET q 1 0 0 1 72 600 cm /Logo Do Q"))));
  assert.deepEqual(pruneResources(doc, [pageResources(doc, 1)]).deleted.map((d) => d.name), ["Fm"]);
  await collectGarbage(doc);
  const out = await save(doc);
  assert.equal(found(out, "SHARED-FORM-SECRET-77"), false);
  assert.equal(await pageTextOf(out, 0), "pageoneLOGO-ON-BOTH-PAGES");
  assert.equal(await pageTextOf(out, 1), "pagetwoLOGO-ON-BOTH-PAGES");
});

test("pruneResources refuses when a user cannot be analysed or the dictionary serves the form defaults", async () => {
  const bytes = await sharedResourcesDoc();
  // page 1 gets content that cannot be parsed
  let doc = await load(bytes);
  doc.getPage(0).node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(bytesOf("BT (unterminated"))));
  doc.getPage(1).node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(bytesOf("BT ET"))));
  let res = pruneResources(doc, [pageResources(doc, 1)]);
  assert.deepEqual(res.deleted, []);
  assert.ok(res.skipped.length >= 1);
  // the font dictionary is also /AcroForm /DR /Font
  doc = await load(bytes);
  const shared = pageResources(doc, 0);
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [], DR: { Font: A.get(shared, "Font") } }));
  for (const i of [0, 1]) doc.getPage(i).node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(bytesOf("q Q"))));
  res = pruneResources(doc, [shared]);
  assert.deepEqual(res.deleted.map((d) => `${d.category}/${d.name}`).sort(), ["XObject/Fm", "XObject/Logo"]); // the fonts stay
  assert.ok(A.get(A.get(shared, "Font"), "F1"));
});

test("a Form XObject without /Resources uses those of the page: its names count for the page", async () => {
  const { bytes } = await makePdf([{
    content: "BT /F1 12 Tf 72 700 Td (page) Tj ET /Bare Do",
    resources: (ctx, refs, fonts) => ({
      Font: fonts,
      XObject: {
        Bare: ctx.register(ctx.stream(bytesOf("BT /F2 9 Tf 10 10 Td (in the bare form) Tj ET /Inner Do"), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 40] })),
        Inner: formXObject("BT /F1 9 Tf 0 0 Td (inner) Tj ET")(ctx, refs, fonts),
        Unused: formXObject("BT /F1 9 Tf 0 0 Td (UNUSED-FORM-TEXT) Tj ET")(ctx, refs, fonts)
      }
    })
  }]);
  const doc = await load(bytes);
  const res = pruneResources(doc, [pageResources(doc, 0)]);
  assert.deepEqual(res.deleted.map((d) => `${d.category}/${d.name}`).sort(), ["Font/F3", "XObject/Unused"]); // F2 and Inner are used through the bare form
  await collectGarbage(doc);
  const out = await save(doc);
  assert.equal(await pageTextOf(out), "pageinthebareforminner");
  assert.equal(found(out, "UNUSED-FORM-TEXT"), false);
});

const STRUCT_STRINGS = ["STRUCT-ACTUAL-ZERO", "STRUCT-ALT-ZERO", "STRUCT-TITLE-ZERO", "SECTION-EXPANSION", "STRUCT-ACTUAL-ONE", "STRUCT-ACTUAL-FORM", "SECTION-TITLE-KEPT"];
const structFacts = async (doc) => {
  const out = await save(doc);
  return Object.fromEntries(STRUCT_STRINGS.map((s) => [s, found(out, s)]));
};

test("structure tree: the words of the elements that own redacted content are stripped, the others stay", async () => {
  const { bytes } = await taggedPdf();
  const doc = await load(bytes);
  const rep = removeTextInRects(doc, 0, [await boxOf(bytes, "TAG-SECRET-1", { pad: 0.5 })]);
  assert.deepEqual(rep.touchedMcids, ["page:0"]);
  // /ActualText, /Alt and /T of the element, /E of its ancestor (whose own title stays)
  assert.equal(stripStructAttributes(doc, 0, [0]), 4);
  assert.deepEqual(await structFacts(doc), {
    "STRUCT-ACTUAL-ZERO": false, "STRUCT-ALT-ZERO": false, "STRUCT-TITLE-ZERO": false, "SECTION-EXPANSION": false,
    "STRUCT-ACTUAL-ONE": true, "STRUCT-ACTUAL-FORM": true, "SECTION-TITLE-KEPT": true
  });
  // marked content inside a Form XObject belongs to the form's own entry of the parent tree
  const formRep = removeTextInRects(doc, 0, [await boxOf(bytes, "FORM-TAGGED-TEXT", { pad: 0.5 })]);
  assert.deepEqual(formRep.touchedMcids.sort(), ["form:1:0", "page:2"]);
  assert.equal(stripStructAttributes(doc, 0, [0], { structParents: 1 }), 1);
  assert.equal((await structFacts(doc))["STRUCT-ACTUAL-FORM"], false);
  assert.equal(stripStructAttributes(doc, 0, "all"), 1);
  assert.equal((await structFacts(doc))["STRUCT-ACTUAL-ONE"], false);
  // a page without /StructParents, or a document without a structure tree: nothing to do
  const { bytes: plain } = await makePdf([{ content: "BT ET" }]);
  assert.equal(stripStructAttributes(await load(plain), 0, "all"), 0);
});

test("a rasterised page leaves the structure tree: no kid refers to it any more", async () => {
  const { bytes } = await taggedPdf();
  const doc = await load(bytes);
  const pageRef = doc.getPage(0).ref;
  const root = A.get(doc.catalog, "StructTreeRoot");
  const res = detachPageFromStructTree(doc, 0);
  // the two paragraphs (one id each), the figure's own id and the /MCR of the element inside the form
  assert.deepEqual(res, { kidsRemoved: 4, attributesStripped: 6, parentTreeEntry: true });
  assert.equal(doc.getPage(0).node.has(PDFName.of("StructParents")), false);
  assert.deepEqual(A.numArray(A.get(A.get(root, "ParentTree"), "Nums").lookup(0)), undefined);
  assert.equal(A.num(A.get(A.get(root, "ParentTree"), "Nums").lookup(0)), 1, "only the entry of the form is left in the parent tree");
  // walk the whole tree: no marked-content id, /MCR or /OBJR of that page is left
  const refersToPage = [];
  const seen = new Set();
  const walk = (elem, pg) => {
    if (!A.isDict(elem) || seen.has(elem)) return;
    seen.add(elem);
    const page = A.getRaw(elem, "Pg") ?? pg;
    const k = A.get(elem, "K");
    for (const kid of A.isArray(k) ? k.asArray().map((raw) => A.resolve(doc.context, raw)) : k === undefined ? [] : [k]) {
      if (A.isNumber(kid) && page === pageRef) refersToPage.push("mcid");
      else if (A.isDict(kid) && ["MCR", "OBJR"].includes(A.getName(kid, "Type"))) refersToPage.push(A.getName(kid, "Type"));
      else walk(kid, page);
    }
  };
  walk(root, undefined);
  assert.deepEqual(refersToPage, []);
  const facts = await structFacts(doc);
  assert.deepEqual([facts["STRUCT-ACTUAL-ZERO"], facts["STRUCT-ACTUAL-ONE"], facts["STRUCT-ACTUAL-FORM"], facts["SECTION-EXPANSION"], facts["SECTION-TITLE-KEPT"]], [false, false, false, false, true]);
  // another page of the same tree is not touched
  const { bytes: two } = await makePdf([
    { content: "/P << /MCID 0 >> BDC BT /F1 12 Tf 72 700 Td (page one paragraph) Tj ET EMC", extra: { StructParents: 0 } },
    { content: "/P << /MCID 0 >> BDC BT /F1 12 Tf 72 700 Td (page two paragraph) Tj ET EMC", extra: { StructParents: 1 } }
  ], {
    setup: (d, refs) => {
      const ctx = d.context;
      const rootRef = ctx.nextRef();
      const a = ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: rootRef, Pg: refs.pages[0], K: 0, ActualText: S("PAGE-ONE-ACTUAL") }));
      const b = ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: rootRef, Pg: refs.pages[1], K: 0, ActualText: S("PAGE-TWO-ACTUAL") }));
      ctx.assign(rootRef, ctx.obj({ Type: "StructTreeRoot", K: [a, b], ParentTree: { Nums: [0, [a], 1, [b]] } }));
      d.catalog.set(PDFName.of("StructTreeRoot"), rootRef);
    }
  });
  const twoDoc = await load(two);
  assert.deepEqual(detachPageFromStructTree(twoDoc, 0), { kidsRemoved: 1, attributesStripped: 1, parentTreeEntry: true });
  const out = await save(twoDoc);
  assert.deepEqual([found(out, "PAGE-ONE-ACTUAL"), found(out, "PAGE-TWO-ACTUAL")], [false, true]);
  assert.equal(detachPageFromStructTree(twoDoc, 0).kidsRemoved, 0, "idempotent");
});

test("a Form XObject the structure tree points to does not survive as the original", async () => {
  const { bytes } = await taggedPdf();
  const doc = await load(bytes);
  const before = pageResources(doc, 0);
  const rep = removeTextInRects(doc, 0, [await boxOf(bytes, "FORM-TAGGED-TEXT 88", { pad: 0.5 })]);
  assert.equal(rep.formsCloned, 1);
  const pruned = pruneResources(doc, [before, pageResources(doc, 0)]);
  await collectGarbage(doc);
  assert.equal(found(await save(doc), "FORM-TAGGED-TEXT"), true, "the structure tree (/Stm) is expected to keep the original form alive");
  const replacements = new Map(rep.replacedForms.map((f) => [`${f.original.objectNumber} ${f.original.generationNumber}`, f.clone]));
  assert.equal(releaseOrphanedObjects(doc, pruned.deleted.map((d) => d.value), { replacements }), 1);
  await collectGarbage(doc);
  const out = await save(doc);
  assert.equal(found(out, "FORM-TAGGED-TEXT"), false);
  assert.deepEqual(await findOrphans(out), []);
  // an object that is still drawn somewhere is never overwritten
  const again = await load(bytes);
  const form = A.getRaw(A.get(pageResources(again, 0), "XObject"), "Fm");
  assert.equal(releaseOrphanedObjects(again, [form]), 0);
});

test("an annotation that the structure tree refers to is unlinked from it", async () => {
  const { bytes } = await makePdf([{
    content: "BT /F1 12 Tf 72 700 Td (linked text) Tj ET",
    annots: [{ Type: "Annot", Subtype: "Link", Rect: [72, 695, 200, 712], StructParent: 5, A: { S: "URI", URI: S("https://linked.example.test/") } }]
  }], {
    setup: (doc, refs) => {
      const ctx = doc.context;
      const annot = doc.getPage(0).node.Annots().get(0);
      const rootRef = ctx.nextRef();
      const link = ctx.register(ctx.obj({ Type: "StructElem", S: "Link", P: rootRef, Pg: refs.pages[0], K: [{ Type: "OBJR", Obj: annot }] }));
      ctx.assign(rootRef, ctx.obj({ Type: "StructTreeRoot", K: [link], ParentTree: { Nums: [5, link] } }));
      doc.catalog.set(PDFName.of("StructTreeRoot"), rootRef);
    }
  });
  const doc = await load(bytes);
  removeAnnotations(doc, 0, { rects: [[70, 690, 210, 715]] });
  const root = A.get(doc.catalog, "StructTreeRoot");
  assert.equal(A.get(A.get(root, "ParentTree"), "Nums").size(), 0);
  assert.equal(A.get(A.get(root, "K").lookup(0), "K").size(), 0);
  await collectGarbage(doc);
  assert.equal(found(await save(doc), "https://linked.example.test/"), false);
});

test("findTextElsewhere: where the document repeats removed text, by place, without quoting it", async () => {
  const secret = "Nguyen Van An 0912-345-678";
  const { bytes } = await makePdf([{
    content: "BT /F1 12 Tf 72 700 Td (page text) Tj ET",
    annots: [
      { Type: "Annot", Subtype: "Text", Rect: [300, 300, 320, 320], Contents: S(`note about ${secret}`) },
      { Type: "Annot", Subtype: "Widget", FT: "Tx", Rect: [72, 400, 272, 420], T: S("phone"), TU: S(secret), V: S("unrelated value"), DA: S("/Helv 12 Tf 0 g") }
    ]
  }], {
    setup: (doc, refs) => {
      const ctx = doc.context;
      doc.setTitle("A title that says nothing");
      doc.setAuthor("Nguyen Van An"); // a PART of the removed text
      doc.setSubject("0912"); // too short to mean anything
      const outlines = ctx.nextRef();
      const item = ctx.register(ctx.obj({ Title: pdfLib.PDFHexString.fromText(secret), Parent: outlines, Dest: [refs.pages[0], "Fit"] }));
      ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
      doc.catalog.set(PDFName.of("Outlines"), outlines);
      const element = ctx.register(ctx.obj({ Type: "StructElem", S: "P", Alt: S(secret), T: S("element title") }));
      doc.catalog.set(PDFName.of("StructTreeRoot"), ctx.register(ctx.obj({ Type: "StructTreeRoot", K: [element] })));
      // a property list of marked content (page resources): the words of a span, kept outside the content stream
      A.get(doc.getPage(0).node, "Resources").set(PDFName.of("Properties"), ctx.obj({ MC0: { ActualText: S("An 0912-345-678"), Lang: S("vi-VN") } }));
      doc.catalog.set(PDFName.of("Metadata"), ctx.register(ctx.stream(bytesOf(`<x:xmpmeta><dc:creator>Nguyen  Van An 0912-345-678</dc:creator></x:xmpmeta>`), { Type: "Metadata", Subtype: "XML" })));
      doc.catalog.set(PDFName.of("Custom"), ctx.obj({ Remark: S(`internal: ${secret}`) }));
    }
  });
  const doc = await load(bytes);
  const places = findTextElsewhere(doc, [secret, "short"]);
  assert.deepEqual(places, [
    { where: "annotation", count: 1 }, // /Contents of the note
    { where: "form", count: 1 }, // the tooltip of the field (its /DA and its unrelated value do not count)
    { where: "metadata", count: 2 }, // /Author (contained in the removed text) and the XMP packet (white space ignored)
    { where: "other", count: 1 },
    { where: "outline", count: 1 }, // a UTF-16 hex string
    { where: "structure", count: 2 } // /Alt of the element and /ActualText of the property list
  ]);
  assert.ok(!JSON.stringify(places).includes("Nguyen"));
  assert.deepEqual(findTextElsewhere(doc, ["something else entirely"]), []);
  assert.deepEqual(findTextElsewhere(doc, ["0912"]), [], "a removed string shorter than six characters is not looked for");
  assert.deepEqual(findTextElsewhere(doc, []), []);

  // the words of the structure tree are the engine's to delete (nobody can see or edit them in a viewer);
  // everything else is only reported
  assert.equal(stripStructureWords(doc, ["something else entirely"]), 0);
  assert.equal(stripStructureWords(doc, [secret]), 2);
  assert.deepEqual(findTextElsewhere(doc, [secret]).map((entry) => entry.where), ["annotation", "form", "metadata", "other", "outline"]);
  assert.equal(stripStructureWords(doc, [secret]), 0);
  const cleaned = await save(doc);
  assert.equal(found(cleaned, "element title"), true, "a title that repeats nothing stays");
  assert.equal(found(cleaned, "An 0912-345-678"), true, "the bookmark, the properties, the note and the field still hold it: they are reported");
  const reloaded = await load(cleaned);
  const element = A.get(A.get(reloaded.catalog, "StructTreeRoot"), "K").lookup(0);
  assert.deepEqual([element.has(PDFName.of("Alt")), element.has(PDFName.of("T"))], [false, true]);
  const properties = A.get(A.get(A.get(reloaded.getPage(0).node, "Resources"), "Properties"), "MC0");
  assert.deepEqual([properties.has(PDFName.of("ActualText")), properties.has(PDFName.of("Lang"))], [false, true]);
});

// ---------------------------------------------------------------------------------------------------------
// the defects of the independent review (8 to 11, and the sibling of 10 found while repairing it)

/**
 * One tagged page: the line with marked-content id 1 is the one a mark removes; `variant` says how the tree is
 * built and where it holds the word `secret` (the reviewer's matrix, a02-structure.mjs).
 *   ownKey / attribute     on the element that owns the line (a key, or /A << /Summary >>)
 *   parentKey, siblingKey  on the Document element, on the element of another line
 *   noParentTree, wrongParentTree (every id leads to the first element), noStructParents (the page has no key
 *   into the parent tree), mcr (the kids are /MCR dictionaries instead of numbers)
 *   shown                  the glyphs of the line (default: the secret itself)
 */
async function taggedVariant(variant, secret, shown = secret) {
  const line = (mcid, y, text) => `/P <</MCID ${mcid}>> BDC BT /F1 12 Tf 72 ${y} Td (${text}) Tj ET EMC`;
  const content = [line(0, 740, "Public line of the page"), line(1, 650, shown), line(2, 600, "Another public line")].join("\n");
  return (await makePdf([{ content, extra: variant.noStructParents ? {} : { StructParents: 0 } }], {
    setup: (doc, refs) => {
      const ctx = doc.context;
      const pageRef = refs.pages[0];
      const rootRef = ctx.nextRef();
      const docRef = ctx.nextRef();
      const element = (mcid, extra = {}) => ctx.register(ctx.obj({ Type: "StructElem", S: "P", P: docRef, Pg: pageRef, K: variant.mcr ? { Type: "MCR", Pg: pageRef, MCID: mcid } : mcid, ...extra }));
      const own = {};
      if (variant.ownKey) own[variant.ownKey] = S(secret);
      if (variant.attribute) own.A = { O: "Table", Summary: S(secret) };
      const elements = [element(0), element(1, own), element(2, variant.siblingKey ? { [variant.siblingKey]: S(secret) } : {})];
      ctx.assign(docRef, ctx.obj({ Type: "StructElem", S: "Document", P: rootRef, K: elements, T: S("TITLE-OF-THE-DOCUMENT"), ...(variant.parentKey ? { [variant.parentKey]: S(secret) } : {}) }));
      const root = { Type: "StructTreeRoot", K: docRef };
      if (!variant.noParentTree) root.ParentTree = { Nums: [0, variant.wrongParentTree ? [elements[0], elements[0], elements[0]] : elements] };
      ctx.assign(rootRef, ctx.obj(root));
      doc.catalog.set(PDFName.of("StructTreeRoot"), rootRef);
      doc.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
    }
  })).bytes;
}
/** Does a string object of the file (a word of the structure tree, a title, a value ...) hold `word`? Any length. */
async function said(bytes, word) {
  const doc = await load(bytes);
  const stack = doc.context.enumerateIndirectObjects().map(([, object]) => (object instanceof pdfLib.PDFStream ? object.dict : object));
  while (stack.length) {
    const value = stack.pop();
    if (A.isString(value)) {
      if (value.decodeText().includes(word)) return true;
    } else if (value instanceof pdfLib.PDFDict) stack.push(...value.values());
    else if (value instanceof pdfLib.PDFArray) stack.push(...value.asArray());
  }
  return false;
}
const LINE_MARK = [60, 640, 400, 665];

test("structure tree: the element that owns touched content is found with a parent tree that is missing, wrong or unreachable", async () => {
  const secret = "X9Z4"; // too short to be searched for in the tree afterwards: only the owner's own words can go
  const cases = [
    ["a usable parent tree", {}],
    ["no parent tree", { noParentTree: true }],
    ["no /StructParents on the page", { noStructParents: true }],
    ["a parent tree that leads to another element", { wrongParentTree: true }],
    ["kids that are /MCR dictionaries, no parent tree", { mcr: true, noParentTree: true }]
  ];
  for (const [label, variant] of cases) {
    for (const ownKey of ["ActualText", "Alt", "E", "T"]) {
      const doc = await load(await taggedVariant({ ...variant, ownKey }, secret));
      const stripped = stripStructAttributes(doc, 0, [1], { removedStrings: [secret] });
      assert.equal(stripped, 1, `${label}, /${ownKey}`);
      const out = await save(doc);
      assert.equal(await said(out, secret), false, `${label}: /${ownKey} of the owner is still in the tree`);
      assert.equal(found(out, "TITLE-OF-THE-DOCUMENT"), true, "a title that repeats nothing stays");
    }
  }
  // the strings of the owner's attribute objects are its words as well (a table summary, a placeholder ...)
  const withAttribute = await load(await taggedVariant({ attribute: true }, secret));
  assert.equal(stripStructAttributes(withAttribute, 0, [1], { removedStrings: [secret] }), 1);
  assert.equal(await said(await save(withAttribute), secret), false, "/A << /Summary >> of the owner");
  // an ANCESTOR loses its title when the title repeats what was removed, short or long ...
  for (const word of [secret, "Secret-Merger-Plan-Q4"]) {
    const doc = await load(await taggedVariant({ parentKey: "T" }, word));
    // (/T is set twice in the fixture: the secret wins over the harmless title)
    assert.equal(stripStructAttributes(doc, 0, [1], { removedStrings: [word] }), 1);
    assert.equal(await said(await save(doc), word), false, `the title of the ancestor still says "${word}"`);
  }
  // ... and keeps it when it does not
  const other = await load(await taggedVariant({ parentKey: "T" }, "UNRELATED-TITLE"));
  assert.equal(stripStructAttributes(other, 0, [1], { removedStrings: [secret] }), 0);
  assert.equal(found(await save(other), "UNRELATED-TITLE"), true);
  // an element that owns nothing of the mark is not touched here: the sweep of the tree takes a word that IS
  // the removed text, however short
  const sibling = await load(await taggedVariant({ siblingKey: "Alt" }, secret));
  assert.equal(stripStructAttributes(sibling, 0, [1], { removedStrings: [secret] }), 0);
  assert.equal(stripStructureWords(sibling, [secret]), 1);
  assert.equal(await said(await save(sibling), secret), false);
  const longer = await load(await taggedVariant({ siblingKey: "Alt" }, "see X9Z4"));
  assert.equal(stripStructureWords(longer, [secret]), 0, "a short word inside a longer text proves nothing");
});

test("a tagged page: no copy of the removed text survives in the tree, however the tree is built", needCanvas, async () => {
  const variants = [
    { ownKey: "ActualText" }, { ownKey: "Alt" }, { ownKey: "T" }, { ownKey: "E" },
    { ownKey: "ActualText", noParentTree: true }, { ownKey: "ActualText", noStructParents: true }, { ownKey: "ActualText", wrongParentTree: true },
    { ownKey: "ActualText", mcr: true, noParentTree: true }, { parentKey: "T" }, { siblingKey: "Alt" }, { attribute: true }
  ];
  for (const secret of ["Secret-Merger-Plan-Q4", "X9Z4"]) {
    for (const variant of variants) {
      const input = await taggedVariant(variant, secret);
      assert.equal(await said(input, secret), true, "fixture");
      for (const path of ["hybrid", "raster"]) {
        const { bytes, report } = await redactPdf(input, [{ pageIndex: 0, rect: LINE_MARK, mode: "redact" }], redactEnv({ path }));
        assert.equal(report.pages[0].path, path === "raster" ? "raster" : "precise");
        assert.equal(await said(bytes, secret), false, `"${secret}", ${JSON.stringify(variant)}, ${path}: the word is still in the file`);
        assert.ok(!(await pageTextOf(bytes, 0)).includes(secret.replace(/\s/g, "")), "the line is still on the page");
        assert.deepEqual(report.warnings, [], "nothing is left to report");
        assert.deepEqual(await findOrphans(bytes), []);
      }
    }
  }
  // the words of an element may differ from its glyphs (an abbreviation spelled out): they go with the glyphs,
  // also for an erased line and also without a parent tree
  for (const variant of [{ ownKey: "ActualText" }, { ownKey: "ActualText", noParentTree: true }, { ownKey: "Alt", noParentTree: true }]) {
    for (const mode of ["redact", "erase"]) {
      const input = await taggedVariant(variant, "SPELLED-OUT-SECRET-77", "abbr. shown instead");
      const { bytes, report } = await redactPdf(input, [{ pageIndex: 0, rect: LINE_MARK, mode }], redactEnv());
      assert.equal(report.pages[0].path, "precise");
      assert.equal(found(bytes, "SPELLED-OUT-SECRET-77"), false, `${JSON.stringify(variant)}, ${mode}`);
    }
  }
});

test("an annotation whose rectangle has no area is hit like a point; a missing /Rect is the origin", async () => {
  const page = { content: "BT /F1 12 Tf 72 652 Td (line under the mark) Tj ET", annots: [
    { Type: "Annot", Subtype: "Text", Rect: [150, 655, 150, 655], Contents: S("NOTE-IN-THE-MARK") },
    { Type: "Annot", Subtype: "Text", Rect: [150, 300, 150, 300], Contents: S("NOTE-AWAY") },
    { Type: "Annot", Subtype: "Text", Contents: S("NOTE-WITHOUT-RECT") }
  ] };
  const { bytes } = await makePdf([page]);
  const mark = [60, 640, 400, 668];
  // (the review: an annotation counted only when the intersection had an area, so a note icon written with a
  // point for a rectangle stayed, with its text)
  const doc = await load(bytes);
  const hit = removeAnnotations(doc, 0, { rects: [mark] });
  assert.deepEqual([hit.removed, hit.kept], [[{ subtype: "Text", rect: [150, 655, 150, 655] }], 2]);
  const out = await save(doc);
  assert.deepEqual([found(out, "NOTE-IN-THE-MARK"), found(out, "NOTE-AWAY"), found(out, "NOTE-WITHOUT-RECT")], [false, true, true]);
  // viewers put an annotation without /Rect at the origin: a mark there takes it
  const origin = await load(bytes);
  assert.deepEqual(removeAnnotations(origin, 0, { rects: [[-5, -5, 5, 5]] }).removed, [{ subtype: "Text", rect: null }]);
  assert.equal(found(await save(origin), "NOTE-WITHOUT-RECT"), false);
});

test("a popup under the mark takes its note with it", async () => {
  // (found while repairing: the note goes with its popup when the NOTE is hit; the other way round the popup
  // went alone and the text of the note stayed)
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 652 Td (line under the mark) Tj ET", annots: [
    (ctx, refs) => {
      refs.note = ctx.nextRef();
      refs.popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [100, 650, 200, 668], Parent: refs.note, Open: true }));
      ctx.assign(refs.note, ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [100, 300, 120, 320], Contents: S("POPUP-NOTE-SECRET"), Popup: refs.popup }));
      return refs.note;
    },
    (ctx, refs) => refs.popup,
    { Type: "Annot", Subtype: "Text", Rect: [300, 300, 320, 320], Contents: S("OTHER-NOTE-KEPT") }
  ] }]);
  const doc = await load(bytes);
  const result = removeAnnotations(doc, 0, { rects: [[60, 640, 400, 668]] });
  assert.deepEqual([result.removed.map((entry) => entry.subtype).sort(), result.kept], [["Popup", "Text"], 1]);
  const out = await save(doc);
  assert.deepEqual([found(out, "POPUP-NOTE-SECRET"), found(out, "OTHER-NOTE-KEPT")], [false, true]);
});

test("a value that a widget under the mark inherits from its parent field is deleted there", async () => {
  // (the review: the widget is a field of its own (/T), its value hangs on the parent: the widget went, the
  // value stayed, and the sibling widget kept showing it)
  const build = async () => (await makePdf([{ content: "BT /F1 12 Tf 72 652 Td (line under the mark) Tj ET", annots: [
    (ctx, refs) => {
      refs.parent = ctx.nextRef();
      refs.child = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: S("child"), Parent: refs.parent, Rect: [100, 650, 200, 668] }));
      refs.other = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: S("other"), Parent: refs.parent, Rect: [100, 300, 200, 318] }));
      ctx.assign(refs.parent, ctx.obj({ T: S("group"), V: S("INHERITED-SECRET-VALUE"), DV: S("INHERITED-SECRET-VALUE"), Kids: [refs.child, refs.other] }));
      return refs.child;
    },
    (ctx, refs) => refs.other
  ] }], { setup: (doc, refs) => doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [refs.parent] })) })).bytes;
  const doc = await load(await build());
  const result = removeAnnotations(doc, 0, { rects: [[60, 640, 400, 668]] });
  assert.deepEqual(result.fieldsRemoved, ["group.child"]);
  assert.deepEqual(result.fieldsCleared, [{ field: "group", widgets: 1 }], "the caller is told which field lost its value");
  assert.equal(result.kept, 1);
  await collectGarbage(doc);
  assert.equal(found(await save(doc), "INHERITED-SECRET-VALUE"), false);
  // a mark elsewhere changes nothing
  const untouched = await load(await build());
  assert.deepEqual(removeAnnotations(untouched, 0, { rects: [[400, 400, 450, 450]] }).fieldsCleared, []);
  assert.equal(found(await save(untouched), "INHERITED-SECRET-VALUE"), true);
});

test("decodeTextBytes: by the byte-order mark, by the zero bytes of UTF-16 without one, UTF-8 otherwise", () => {
  const text = "Kế hoạch sáp nhập: Secret-Merger-Plan-Q4 <x:xmpmeta/>";
  const utf16le = Buffer.from(text, "utf16le");
  const utf16be = Buffer.from(utf16le).swap16();
  const cases = [
    ["UTF-8", Buffer.from(text, "utf8")],
    ["UTF-8 with a mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])],
    ["UTF-16 BE with a mark", Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be])],
    ["UTF-16 LE with a mark", Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le])],
    ["UTF-16 BE without a mark", utf16be],
    ["UTF-16 LE without a mark", utf16le]
  ];
  for (const [label, bytes] of cases) assert.equal(scrubApi.decodeTextBytes(new Uint8Array(bytes)), text, label);
  // (the review: every packet was read as UTF-8, so an XMP packet in UTF-16 was never searched)
  assert.equal(scrubApi.decodeTextBytes(new Uint8Array(0)), "");
  assert.equal(scrubApi.decodeTextBytes(Uint8Array.of(0x41, 0x42, 0x43)), "ABC");
  // bytes that are no text at all decode to something, never throw
  assert.equal(typeof scrubApi.decodeTextBytes(Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff)), "string");
});

test("findTextElsewhere: attached files are searched where they are text, their names always; they are counted", async () => {
  const secret = "ELSEWHERE-SECRET-88";
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const { bytes } = await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (body) Tj ET" }], {
    setup: async (doc) => {
      const ctx = doc.context;
      await doc.attach(utf16(`customer;${secret};paid`), "data.csv", { mimeType: "text/csv" });
      await doc.attach(Buffer.from([0x50, 0x4b, 3, 4, 9, 9, 9, 9]), `${secret}.zip`, { mimeType: "application/zip" });
      await doc.attach(Buffer.from("nothing here"), "readme.txt", { mimeType: "text/plain" });
      // a script kept in a stream, and an XMP packet in UTF-16
      doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ S: "JavaScript", JS: ctx.register(ctx.flateStream(Buffer.from(`app.alert("${secret}");`))) }));
      doc.catalog.set(PDFName.of("Metadata"), ctx.register(ctx.stream(utf16(`<x:xmpmeta><rdf:li>${secret}</rdf:li></x:xmpmeta>`), { Type: "Metadata", Subtype: "XML" })));
    }
  });
  const doc = await load(bytes);
  assert.equal(scrubApi.countEmbeddedFiles(doc), 3);
  assert.deepEqual(findTextElsewhere(doc, [secret]), [
    // the text of data.csv; the name of the archive in /F and /UF of its file specification and in the name tree
    { where: "attachment", count: 4 },
    { where: "metadata", count: 1 },
    { where: "other", count: 1 }
  ]);
  assert.deepEqual(findTextElsewhere(doc, ["something else entirely"]), []);
  assert.equal(scrubApi.countEmbeddedFiles(await load((await makePdf([{ content: "BT /F1 12 Tf 72 700 Td (body) Tj ET" }])).bytes)), 0);
});
