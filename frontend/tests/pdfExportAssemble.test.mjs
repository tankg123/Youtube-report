// engine/export: assembling a NEW document from several sources. The invariants of the export pipeline
// (INV-1 to INV-11 of the writer research) on one realistic job: pages dropped, reordered, duplicated and
// rotated, a blank page, and something drawn on every page. Pixel checks are in pdfExportDraw.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleDocument } from "../src/pages/pdfEditor/engine/export/index.js";
import { exportDocument } from "../src/pages/pdfEditor/engine/export/export.js";
import { listFieldNames } from "../src/pages/pdfEditor/engine/export/acroform.js";
import { viewportToUser, visibleSize } from "../src/pages/pdfEditor/engine/geometry.js";
import { canRender, extractText, loadFont, makeTextPdf, pdfLib, squash, withPdf } from "./helpers/pdfTestKit.mjs";
import {
  GLOBAL_MARKERS, MARKERS, SHARED_MARKERS, buildGlobalResourcesFixture, buildLinkedFixture, buildSharedResourcesFixture, makeTextObject,
  noiseBytes, secretsOfPage
} from "./helpers/pdfExportFixtures.mjs";
import { fileFacts, findText, loadPlain, resourceNames, textLeaks } from "./helpers/pdfExportScan.mjs";
import { annotationCensus, differingPixels, linkTargets, outlineOf, renderAll } from "./helpers/pdfExportRender.mjs";

const { PDFDocument, PDFName, PDFArray, PDFRef } = pdfLib;
const NOW = new Date(Date.UTC(2026, 10, 16, 2, 0, 0));
const SEED = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const LABEL = "Đã duyệt — trang";
const BETA = ["BETA-P1 Bản nháp đã xoá 4471", "BETA-P2 Hợp đồng số 12", "BETA-P3 Phụ lục"];

const fixture = await buildLinkedFixture();
const beta = await makeTextPdf([{ lines: [BETA[0]] }, { lines: [BETA[1]] }, { lines: [BETA[2]], rotate: 90 }], { title: "Beta" });
const sources = { fx: fixture.bytes, beta };
const before = Object.fromEntries(Object.entries(sources).map(([id, bytes]) => [id, Buffer.from(bytes).toString("base64")]));

/** { view, rotate, userUnit } of every page of a file, as the viewer reports them. */
const geometriesOf = (bytes) => withPdf(bytes, async (doc) => {
  const out = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    out.push({ view: page.view.slice(), rotate: page.rotate, userUnit: page.userUnit });
  }
  return out;
});
const geometries = { fx: await geometriesOf(fixture.bytes), beta: await geometriesOf(beta) };
const sourceTexts = { fx: await extractText(fixture.bytes), beta: await extractText(beta) };

// the job: what the user did in the editor
const PAGES = [
  { source: "fx", index: 2, rotate: 0 }, // 0  hidden layer; link back to fixture page 1
  { source: "fx", index: 0, rotate: 0 }, // 1  links, form, pop-up, baggage
  { source: "beta", index: 1, rotate: 0 }, // 2
  { blank: [300, 200], rotate: 0 }, // 3
  { source: "fx", index: 0, rotate: 0 }, // 4  the same source page again
  { source: "beta", index: 2, rotate: 90 } // 5  /Rotate 90 + 90 by the user
];
const geometryOf = (entry) => (entry.blank ? { view: [0, 0, entry.blank[0], entry.blank[1]], rotate: 0, userUnit: 1 } : geometries[entry.source][entry.index]);
const labelOf = (index) => `${LABEL} ${index + 1}`;

/** A label in the middle of the visible page, upright for the reader. */
function labelObject(entry, index) {
  const geometry = geometryOf(entry);
  const [width, height] = visibleSize(geometry, entry.rotate);
  const [x, y] = viewportToUser(geometry, [width / 2, height / 2], 1, entry.rotate);
  return makeTextObject({ id: `label${index}`, lines: [labelOf(index)], font: "be-vietnam-pro", size: 10, color: "#7e22ce", x, y, rot: geometry.rotate + entry.rotate });
}

const job = () => ({
  sources: [{ id: "fx", bytes: sources.fx, expectedPages: 4 }, { id: "beta", bytes: sources.beta, expectedPages: 3 }],
  pages: PAGES,
  objects: PAGES.map((entry, index) => [labelObject(entry, index)]),
  marks: [],
  assets: {},
  info: {},
  fileName: "assembled"
});
const options = () => ({ fonts: loadFont, now: NOW, idSeed: SEED });

const { bytes, report } = await assembleDocument(job(), options());
const texts = await extractText(bytes);
const facts = await fileFacts(bytes);

// what must be gone: everything of fixture pages 2 and 4 and of beta page 1, and what no page carries
const DROPPED = [
  ...secretsOfPage(1), ...secretsOfPage(3), BETA[0],
  MARKERS.xfa, MARKERS.xmpTitle, MARKERS.attachment, MARKERS.thumb, MARKERS.pieceInfo, MARKERS.pageMetadata, MARKERS.pageAA
];

test("the scanner is not blind: every dropped string is found in its SOURCE, in whatever encoding it is stored", async () => {
  const inFixture = await findText(fixture.bytes, DROPPED.filter((needle) => needle !== BETA[0]));
  for (const [needle, hits] of Object.entries(inFixture)) assert.ok(hits.length > 0, `"${needle}" is not found in the fixture`);
  // glyph-id coded text of an embedded subset font: only the ToUnicode pass sees it
  const inBeta = await findText(beta, [BETA[0]]);
  assert.ok(inBeta[BETA[0]].some((hit) => hit.includes("ToUnicode")), JSON.stringify(inBeta));
  assert.ok(Buffer.from(fixture.bytes).includes(fixture.imageSignature), "the picture of fixture page 2");
});

test("INV-1 nothing of a page that is not in the output survives: text in any encoding, picture, form values, bookmarks, baggage", async () => {
  assert.deepEqual(await textLeaks(bytes, DROPPED), []);
  assert.ok(!Buffer.from(bytes).includes(fixture.imageSignature), "the picture of the dropped fixture page");
  assert.deepEqual(facts.orphans, [], "no unreachable object");
  assert.deepEqual(facts.redefined, [], "no object defined twice");
  // and what belongs to the kept pages is still there
  const kept = await findText(bytes, [MARKERS.page[0], MARKERS.page[2], MARKERS.formOnly1, MARKERS.formShared, MARKERS.popupText, BETA[1], BETA[2]]);
  for (const [needle, hits] of Object.entries(kept)) assert.ok(hits.length > 0, `"${needle}" belongs to a kept page`);
});

test("INV-2 structural self-check: no page object outside the page tree, no structure tree, no stray annotation", () => {
  assert.deepEqual(report.audit, []);
  assert.deepEqual(facts.audit, []);
  for (const key of ["StructTreeRoot", "MarkInfo", "Threads", "Dests", "Names", "OpenAction", "AA", "Perms", "DSS"]) {
    assert.ok(!facts.catalogKeys.includes(key), `/${key} is not carried over`);
  }
  for (const page of facts.doc.getPages()) {
    for (const key of ["Thumb", "PieceInfo", "Metadata", "AA", "B", "StructParents"]) assert.ok(!page.node.has(PDFName.of(key)), `/${key} on a page`);
  }
});

test("INV-3 the output is one plain revision with a trailer /ID and no signature artefact", () => {
  assert.equal(facts.header, "%PDF-1.7");
  assert.equal(facts.revisions, 1);
  assert.equal(facts.encrypted, false);
  assert.equal(facts.hasByteRange, false);
  assert.equal(facts.id, Buffer.from(SEED).toString("hex").toUpperCase());
  assert.equal(report.id, facts.id);
  assert.equal(facts.pages, PAGES.length);
  assert.equal(report.pageCount, PAGES.length);
  assert.equal(report.bytes, bytes.length);
});

test("INV-4 every page shows the text of its source page plus what was drawn on it, in the planned order", () => {
  PAGES.forEach((entry, index) => {
    const own = squash(labelOf(index));
    assert.ok(squash(texts[index]).includes(own), `page ${index + 1}: the label`);
    const rest = squash(texts[index]).replace(own, "");
    assert.equal(rest, entry.blank ? "" : squash(sourceTexts[entry.source][entry.index]), `page ${index + 1}: nothing but the source text besides the label`);
  });
});

test("INV-7 links: between kept pages they reach the right page after reordering; to dropped pages they are gone", async () => {
  const links = await linkTargets(bytes);
  // fixture page 3 linked to fixture page 1 = output index 1 (its FIRST copy)
  assert.deepEqual(links[0], [1]);
  // fixture page 1: action -> page 3 (now index 0), named string -> page 3, itself (structure destination), URL;
  // its links to pages 2 and 4 are gone
  assert.deepEqual(links[1], [0, 0, 1, "url"]);
  assert.deepEqual(links[4], [0, 0, 1, "url"], "the twin has its own copies of the links");
  assert.deepEqual([links[2], links[3], links[5]], [[], [], []]);
  assert.equal(report.sources.fx.copy.linksDropped, 3);
  assert.equal(report.sources.fx.copy.linksRetargeted, 4);
});

test("INV-8 the same source page twice: two pages that share no container, annotation or drawing", () => {
  const [first, twin] = [facts.doc.getPage(1), facts.doc.getPage(4)];
  assert.notEqual(first.ref, twin.ref);
  assert.ok(squash(texts[1]).includes(squash(labelOf(1))) && !squash(texts[1]).includes(squash(labelOf(4))));
  assert.ok(squash(texts[4]).includes(squash(labelOf(4))) && !squash(texts[4]).includes(squash(labelOf(1))));
  const refsOf = (page, key) => {
    const value = page.node.get(PDFName.of(key));
    const array = value instanceof PDFRef ? facts.doc.context.lookup(value) : value;
    return array instanceof PDFArray ? array.asArray().map(String) : [];
  };
  assert.notEqual(String(first.node.get(PDFName.of("Resources"))), String(twin.node.get(PDFName.of("Resources"))), "/Resources");
  assert.notEqual(String(first.node.get(PDFName.of("Annots"))), String(twin.node.get(PDFName.of("Annots"))), "/Annots");
  const shared = refsOf(first, "Annots").filter((ref) => refsOf(twin, "Annots").includes(ref));
  assert.deepEqual(shared, [], "no annotation object on both pages");
  for (const page of [first, twin]) {
    for (const ref of page.node.Annots().asArray()) {
      const owner = facts.doc.context.lookup(ref).get(PDFName.of("P"));
      if (owner) assert.equal(owner, page.ref, "an annotation names the page that lists it");
    }
  }
  // the content streams of the SOURCE page are shared (one copy in the file); what was drawn is not
  const [a, b] = [refsOf(first, "Contents"), refsOf(twin, "Contents")];
  assert.ok(a.some((ref) => b.includes(ref)), "the page content is stored once");
  assert.notDeepEqual(a, b);
  assert.equal(report.sources.fx.copy.duplicates, 1);
});

test("INV-9 outline, form fields, layers, page labels and metadata follow the pages", async () => {
  assert.deepEqual(await outlineOf(bytes), [
    ["Chapter 1 (PDFDocEncoding)", 1, 0],
    ["Section 1.2 (named string)", 0, 1],
    ["Website", "https://example.test/outline", 0],
    ["Đóng — closed parent", 0, 0],
    ["to page 3", 0, 1],
    ["to page 1", 1, 1]
  ]);
  // (no bookmark of the removed page 2 has a kept child here: nothing is retargeted)
  assert.deepEqual(report.sources.fx.outline, { items: 9, kept: 6, dropped: 3, retargeted: 0, truncated: false });
  assert.deepEqual(listFieldNames(facts.doc).sort(), ["group.child1", "only1", "shared"]);
  const census = await annotationCensus(bytes);
  assert.deepEqual(census[1], { Link: 4, Text: 1, Popup: 1, Widget: 3 });
  assert.deepEqual(census[4], { Link: 4, Text: 1, Popup: 1 }, "form widgets stay on the first copy");
  await withPdf(bytes, async (doc) => {
    const fields = await doc.getFieldObjects();
    const entries = fields instanceof Map ? Object.fromEntries(fields) : fields;
    assert.deepEqual(Object.keys(entries).sort(), ["group", "group.child1", "only1", "shared"]);
    assert.equal(entries.only1[0].value, MARKERS.formOnly1);
    assert.equal(entries.shared.filter((field) => field.type === "text").length, 1, "the two-page field keeps one widget");
    const config = await doc.getOptionalContentConfig();
    assert.deepEqual([...config].map(([, group]) => [group.name, group.visible]), [["Hidden layer", false]]);
    assert.deepEqual(await doc.getPageLabels(), ["A-1", "i", "3", "4", "i", "6"]);
    assert.equal(await doc.getPageLayout(), "TwoColumnLeft");
    assert.equal(await doc.getPageMode(), "UseOutlines");
    const { info, metadata } = await doc.getMetadata();
    assert.equal(info.Title, MARKERS.infoTitle);
    assert.equal(info.Author, MARKERS.infoAuthor);
    assert.equal(info.Producer, "ANS PDF Editor");
    assert.equal(info.CreationDate, "D:20260115030000Z", "the creation date of the first source");
    assert.equal(info.ModDate, "D:20261116020000Z");
    assert.equal(info.Language, "vi-VN");
    assert.equal(metadata.get("dc:title"), MARKERS.infoTitle, "the new XMP says what Info says");
    assert.equal(info.IsXFAPresent, false);
  });
  assert.deepEqual(report.optionalContent, { groups: 1, off: 1 });
  assert.equal(report.form.fields, 3);
});

test("INV-10 one resource name per font face on a page; drawn text is extractable", () => {
  facts.doc.getPages().forEach((page, index) => {
    const ours = resourceNames(page).Font.filter((name) => /^F\d+-\d+$/.test(name));
    assert.equal(ours.length, 1, `page ${index + 1}: ${ours}`);
  });
  assert.deepEqual(report.fontsEmbedded, ["be-vietnam-pro-regular"]);
  assert.equal(report.objectsDrawn, PAGES.length);
});

test("INV-11 the same job, clock and id seed give the same bytes; the sources are not touched", async () => {
  const again = await assembleDocument(job(), options());
  assert.equal(Buffer.compare(Buffer.from(again.bytes), Buffer.from(bytes)), 0);
  for (const [id, source] of Object.entries(sources)) assert.equal(Buffer.from(source).toString("base64"), before[id], `source ${id} was modified`);
  const later = await assembleDocument(job(), { ...options(), now: new Date(NOW.getTime() + 1000) });
  assert.notEqual(Buffer.compare(Buffer.from(later.bytes), Buffer.from(bytes)), 0, "the clock is part of the file");
  const random = await assembleDocument(job(), { fonts: loadFont, now: NOW });
  assert.match((await fileFacts(random.bytes)).id, /^[0-9A-F]{32}$/, "without a seed the /ID is random");
});

test("the report says what happened to each source", () => {
  assert.deepEqual(report.warnings.map((warning) => warning.code).sort(), ["EXPORT_ATTACHMENTS_DROPPED", "EXPORT_XFA_DROPPED"]);
  assert.deepEqual(report.warnings.find((warning) => warning.code === "EXPORT_ATTACHMENTS_DROPPED").params, { source: "fx", files: 1 });
  assert.equal(report.sources.fx.pages, 4);
  assert.equal(report.sources.fx.kept, 3);
  assert.equal(report.sources.beta.kept, 2);
  assert.equal(report.sources.fx.encrypted, false);
  assert.equal(report.sources.fx.info.title, MARKERS.infoTitle);
  assert.deepEqual([report.sources.fx.tagged, report.sources.beta.tagged], [true, false], "a tagged source is named: its structure tree does not come along");
  assert.deepEqual([report.sources.fx.invalidObjects, report.sources.fx.pageTreeRepaired], [0, 0]);
  assert.deepEqual([report.pageCount, report.bytes, report.marksIgnored], [PAGES.length, bytes.length, 0]);
  for (const key of ["load", "copy", "draw", "structure", "save", "total"]) assert.equal(typeof report.timings[key], "number", key);
});

test("marks are not this engine's work: they change nothing in the file and the report counts them", async () => {
  const marks = [{ pageIndex: 1, rect: [20, 20, 200, 60], mode: "redact", color: "#000000" }, { pageIndex: 2, rect: [20, 80, 200, 120], mode: "blur", strength: 2 }];
  const marked = await assembleDocument({ ...job(), marks }, options());
  assert.equal(marked.report.marksIgnored, 2);
  assert.equal(Buffer.compare(Buffer.from(marked.bytes), Buffer.from(bytes)), 0);
});

test("job.info overrides the document information; an empty value clears it; the source's own XMP never comes along", async () => {
  const title = "Hợp đồng (bản <nháp> & \"cuối\") \\ 2026";
  const custom = await assembleDocument({ ...job(), info: { title, author: "", keywords: "một, hai" } }, options());
  await withPdf(custom.bytes, async (doc) => {
    const { info, metadata } = await doc.getMetadata();
    assert.equal(info.Title, title);
    assert.equal(metadata.get("dc:title"), title);
    assert.equal(info.Author, undefined);
    assert.equal(info.Keywords, "một, hai");
    assert.equal(info.Subject, "cross-page reference fixture", "a key the job does not name comes from the first source");
  });
  assert.deepEqual(await textLeaks(custom.bytes, [MARKERS.xmpTitle, MARKERS.infoAuthor]), []);
});

test("extra rotation goes into /Rotate, on source pages and on blank pages", async () => {
  const rotated = await assembleDocument({
    ...job(),
    pages: [{ source: "beta", index: 2, rotate: 270 }, { source: "beta", index: 1, rotate: 180 }, { blank: [300, 200], rotate: 90 }, { source: "beta", index: 0, rotate: 0 }],
    objects: [[], [], [], []]
  }, options());
  await withPdf(rotated.bytes, async (doc) => {
    const rotations = [];
    for (let number = 1; number <= doc.numPages; number += 1) rotations.push((await doc.getPage(number)).rotate);
    assert.deepEqual(rotations, [0, 180, 90, 0], "90 + 270, 0 + 180, blank 90, untouched");
  });
});

test("keepOutline / keepForms / keepAttachments", async () => {
  const pages = [{ source: "fx", index: 0, rotate: 0 }, { source: "fx", index: 1, rotate: 0 }];
  const base = { ...job(), pages, objects: [[], []] };
  const bare = await assembleDocument(base, { ...options(), keepOutline: false, keepForms: false });
  const bareFacts = await fileFacts(bare.bytes);
  assert.ok(!bareFacts.catalogKeys.includes("Outlines") && !bareFacts.catalogKeys.includes("AcroForm"));
  assert.deepEqual(await outlineOf(bare.bytes), []);
  assert.deepEqual((await annotationCensus(bare.bytes)).map((census) => census.Widget || 0), [0, 0]);
  assert.deepEqual(await textLeaks(bare.bytes, [MARKERS.formOnly1, MARKERS.formShared, MARKERS.formSecret2, "Chapter 1"]), [], "form values and bookmark titles are gone with them");
  await withPdf(bare.bytes, async (doc) => assert.equal(await doc.getPageMode(), "UseNone", "/PageMode /UseOutlines makes no sense without an outline"));
  assert.deepEqual(bareFacts.audit, []);

  const withFiles = await assembleDocument(base, { ...options(), keepAttachments: true });
  assert.equal(withFiles.report.attachments, 1);
  assert.ok(!withFiles.report.warnings.some((warning) => warning.code === "EXPORT_ATTACHMENTS_DROPPED"));
  await withPdf(withFiles.bytes, async (doc) => {
    const attachments = await doc.getAttachments();
    const list = attachments instanceof Map ? [...attachments.values()] : Object.values(attachments || {});
    assert.deepEqual(list.map((entry) => entry.filename), ["ghi chú.txt"]);
  });
  assert.deepEqual(await textLeaks(bytes, [MARKERS.attachment]), [], "not carried over by default");
});

test("two sources with the same field names: the fields of the second go under a parent named after the source", async () => {
  const twice = await assembleDocument({
    sources: [{ id: "first", bytes: fixture.bytes, expectedPages: 4 }, { id: "second", bytes: fixture.bytes, expectedPages: 4 }],
    pages: [{ source: "first", index: 0, rotate: 0 }, { source: "second", index: 0, rotate: 0 }, { source: "second", index: 1, rotate: 0 }],
    objects: [[], [], []],
    marks: [], assets: {}, info: {}, fileName: "twice"
  }, options());
  const loaded = await loadPlain(twice.bytes);
  assert.deepEqual(listFieldNames(loaded).sort(), ["group.child1", "only1", "second.group.child1", "second.group.child2", "second.only1", "second.secret2", "second.shared", "shared"]);
  assert.equal(twice.report.form.wrappedSources, 1);
  assert.deepEqual((await fileFacts(twice.bytes)).audit, []);
});

test("a source whose pages are all dropped leaves nothing; an unused source is not even loaded", async () => {
  const only = await assembleDocument({
    sources: [{ id: "fx", bytes: fixture.bytes, expectedPages: 4 }, { id: "beta", bytes: beta, expectedPages: 3 }, { id: "unused", bytes: Uint8Array.of(1, 2, 3), expectedPages: 1 }],
    pages: [{ source: "beta", index: 1, rotate: 0 }],
    objects: [[]],
    marks: [], assets: {}, info: {}, fileName: "only"
  }, options());
  assert.deepEqual(Object.keys(only.report.sources), ["beta"]);
  assert.deepEqual(await textLeaks(only.bytes, [...MARKERS.page, MARKERS.header, MARKERS.infoTitle, BETA[0], BETA[2]]), []);
  assert.deepEqual(await extractText(only.bytes), [BETA[1]]);
});

// -----------------------------------------------------------------------------------------------------------
// resources shared between a kept page and a dropped page
// -----------------------------------------------------------------------------------------------------------

test("shared resources: the pictures and forms of a dropped page do not travel with the pages that share its dictionary", async (t) => {
  const shared = await buildSharedResourcesFixture();
  const keep = (indices, plan = {}) => exportDocument({
    sources: [{ id: "s", bytes: shared.bytes, expectedPages: 3 }],
    pages: indices.map((index) => ({ source: "s", index })),
    now: NOW,
    idSeed: SEED,
    ...plan
  });

  await t.test("the leak without pruning (control): the picture and the form text of dropped page 2 are in the file", async () => {
    const leaky = await keep([0, 2], { pruneResources: false });
    assert.ok(Buffer.from(leaky.bytes).includes(shared.signatures[1]));
    assert.deepEqual(await textLeaks(leaky.bytes, [SHARED_MARKERS.form[1], SHARED_MARKERS.nested]), [SHARED_MARKERS.form[1], SHARED_MARKERS.nested]);
    const shown = (await extractText(leaky.bytes)).join(" ");
    assert.ok(shown.includes(SHARED_MARKERS.form[0]) && shown.includes(SHARED_MARKERS.form[2]));
    assert.ok(!shown.includes(SHARED_MARKERS.form[1]) && !shown.includes(SHARED_MARKERS.nested), "no viewer shows it");
  });

  await t.test("with pruning: gone from the bytes, the kept pages look and read the same", async () => {
    const clean = await keep([0, 2]);
    const raw = Buffer.from(clean.bytes);
    assert.ok(!raw.includes(shared.signatures[1]), "the picture of page 2");
    assert.ok(raw.includes(shared.signatures[0]) && raw.includes(shared.signatures[2]), "the pictures of the kept pages");
    assert.deepEqual(await textLeaks(clean.bytes, [SHARED_MARKERS.page[1], SHARED_MARKERS.form[1], SHARED_MARKERS.nested]), []);
    const original = await extractText(shared.bytes);
    assert.deepEqual(await extractText(clean.bytes), [original[0], original[2]]);
    // 4 foreign entries on each of the two pages; page 3 draws the form Fm3, which carried the SHARED dictionary
    // as its own resources and uses none of its 6 XObjects: pruned as well
    assert.deepEqual(clean.report.sources.s.copy.resources, { pages: 2, forms: 1, removed: 14, unresolved: [] });
    const cleanFacts = await fileFacts(clean.bytes);
    assert.deepEqual(cleanFacts.orphans, []);
    assert.deepEqual(resourceNames(cleanFacts.doc.getPage(0)).XObject.sort(), ["Fm1", "Im1"]);
    assert.deepEqual(resourceNames(cleanFacts.doc.getPage(1)).XObject.sort(), ["Fm3", "Im3"]);
    if (canRender) {
      const [source, output] = [await renderAll(shared.bytes), await renderAll(clean.bytes)];
      assert.equal(differingPixels(source[0], output[0]), 0, "page 1");
      assert.equal(differingPixels(source[2], output[1]), 0, "page 3");
    }
  });

  await t.test("all pages kept: nothing is touched", async () => {
    const all = await keep([0, 1, 2]);
    assert.deepEqual(all.report.sources.s.copy.resources, { pages: 0, forms: 0, removed: 0, unresolved: [] });
    for (const signature of shared.signatures) assert.ok(Buffer.from(all.bytes).includes(signature));
  });

  await t.test("a page that cannot be analysed keeps what it had, and the report says so", async () => {
    const opaque = await buildSharedResourcesFixture({ unreadablePage: 0 });
    const result = await exportDocument({
      sources: [{ id: "s", bytes: opaque.bytes, expectedPages: 3 }],
      pages: [{ source: "s", index: 0 }, { source: "s", index: 2 }],
      now: NOW,
      idSeed: SEED
    });
    assert.deepEqual(result.report.sources.s.copy.resources.unresolved, [0]);
    assert.deepEqual(result.report.warnings.filter((warning) => warning.code === "EXPORT_RESOURCES_NOT_PRUNED"), [{ code: "EXPORT_RESOURCES_NOT_PRUNED", params: { source: "s", pages: 1 } }]);
    assert.ok(Buffer.from(result.bytes).includes(opaque.signatures[0]), "its own picture is not lost");
  });
});

test("one resource dictionary for everything (the FPDF layout): patterns, Type3 fonts, soft masks, appearances and nested forms", async (t) => {
  const keep = (bytes, indices, plan = {}) => exportDocument({
    sources: [{ id: "s", bytes, expectedPages: 3 }],
    pages: indices.map((index) => ({ source: "s", index })),
    now: NOW,
    idSeed: SEED,
    ...plan
  });
  const global = await buildGlobalResourcesFixture();
  const secrets = [GLOBAL_MARKERS.page[1], GLOBAL_MARKERS.formOfPage2];

  await t.test("the leak without pruning (control)", async () => {
    const leaky = await keep(global.bytes, [0, 2], { pruneResources: false });
    assert.ok(Buffer.from(leaky.bytes).includes(global.signatures[1]));
    assert.deepEqual(await textLeaks(leaky.bytes, secrets), [GLOBAL_MARKERS.formOfPage2]);
  });

  await t.test("with pruning: nothing of page 2 is left, the kept pages look and read the same", async () => {
    const clean = await keep(global.bytes, [0, 2]);
    const raw = Buffer.from(clean.bytes);
    assert.ok(!raw.includes(global.signatures[1]), "the picture of page 2");
    assert.ok(raw.includes(global.signatures[0]) && raw.includes(global.signatures[2]), "the pictures of the kept pages");
    assert.deepEqual(await textLeaks(clean.bytes, secrets), []);
    const original = await extractText(global.bytes);
    assert.deepEqual(await extractText(clean.bytes), [original[0], original[2]]);
    const kept = await findText(clean.bytes, [GLOBAL_MARKERS.formOfPage1, GLOBAL_MARKERS.appearance, GLOBAL_MARKERS.inner]);
    for (const [needle, hits] of Object.entries(kept)) assert.ok(hits.length > 0, `${needle} belongs to a kept page`);
    // The dictionary has 11 entries. Page 1 keeps 5 of them, page 3 keeps 4: 6 + 7 removed. Six content streams
    // with resources of their own got a private copy: the pattern P1 and the soft-mask group (they use nothing:
    // 11 + 11), the appearance of the stamp and the form inside W3 (they use the font: 10 + 10), the Type3 font
    // (11), and W3 itself, whose private dictionary page 2 could reach as well (nothing to remove).
    assert.deepEqual(clean.report.sources.s.copy.resources, { pages: 2, forms: 6, removed: 66, unresolved: [] });
    assert.deepEqual(clean.report.warnings, []);
    const cleanFacts = await fileFacts(clean.bytes);
    assert.deepEqual(cleanFacts.orphans, []);
    assert.deepEqual(resourceNames(cleanFacts.doc.getPage(0)), { Font: ["F1"], XObject: ["I1", "TP1"], Pattern: ["P1"], ExtGState: ["G1"] });
    assert.deepEqual(resourceNames(cleanFacts.doc.getPage(1)), { Font: ["F1", "T3"], XObject: ["I3", "W3"], Pattern: [], ExtGState: [] });
    if (canRender) {
      const [source, output] = [await renderAll(global.bytes), await renderAll(clean.bytes)];
      assert.equal(differingPixels(source[0], output[0]), 0, "page 1: picture, pattern, soft mask, form, stamp");
      assert.equal(differingPixels(source[2], output[1]), 0, "page 3: picture, Type3 glyph, nested form");
    }
  });

  await t.test("all pages kept: nothing is touched", async () => {
    const all = await keep(global.bytes, [0, 1, 2]);
    assert.deepEqual(all.report.sources.s.copy.resources, { pages: 0, forms: 0, removed: 0, unresolved: [] });
    assert.deepEqual(await extractText(all.bytes), await extractText(global.bytes));
  });

  await t.test("what cannot be proven is reported: a pattern whose content cannot be read keeps the shared dictionary", async () => {
    const opaque = await buildGlobalResourcesFixture({ opaquePattern: true });
    const result = await keep(opaque.bytes, [0, 2]);
    assert.deepEqual(result.report.sources.s.copy.resources.unresolved, [0], "page 1 paints with the pattern; page 3 is clean");
    assert.deepEqual(result.report.warnings, [{ code: "EXPORT_RESOURCES_NOT_PRUNED", params: { source: "s", pages: 1 } }]);
    assert.ok(Buffer.from(result.bytes).includes(opaque.signatures[1]), "the warning is true: the picture of page 2 came along");
    const alone = await keep(opaque.bytes, [2]);
    assert.deepEqual([alone.report.warnings, Buffer.from(alone.bytes).includes(opaque.signatures[1])], [[], false]);
  });

  await t.test("the default resources of the form (/DR) bring fonts, never pictures or forms", async () => {
    const withForm = await buildGlobalResourcesFixture({ defaultResources: true });
    for (const indices of [[0, 2], [0, 1, 2]]) {
      const result = await keep(withForm.bytes, indices);
      assert.equal(result.report.form.fields, 1);
      assert.deepEqual(await textLeaks(result.bytes, [GLOBAL_MARKERS.defaultResources]), [], "a form that only /DR names, drawn by no page");
      const acroForm = (await fileFacts(result.bytes)).doc.catalog.lookup(PDFName.of("AcroForm"));
      const defaults = acroForm.lookup(PDFName.of("DR"));
      assert.deepEqual(defaults.keys().map(String), ["/Font"]);
      assert.deepEqual(defaults.lookup(PDFName.of("Font")).keys().map(String), ["/Helv"], "the Type3 font is content, not a font to type with");
      assert.equal(Buffer.from(result.bytes).includes(withForm.signatures[1]), indices.includes(1), "the picture of page 2 only with page 2");
    }
  });
});

// -----------------------------------------------------------------------------------------------------------
// the same property on generated documents: exactly the pictures the kept pages draw survive
// -----------------------------------------------------------------------------------------------------------

/** A small deterministic generator (mulberry32): the same documents on every run. */
function seeded(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (limit) => Math.floor(next() * limit);
  const pick = (list) => list[int(list.length)];
  const some = (list, min, max) => {
    const pool = list.slice();
    const out = [];
    for (let count = min + int(max - min + 1); count > 0 && pool.length; count -= 1) out.push(pool.splice(int(pool.length), 1)[0]);
    return out;
  };
  return { int, pick, some };
}

/**
 * Four pages, six pictures and three forms that reach their resources in every way the format allows: a
 * dictionary shared by the whole document (named by the page, inherited from the page tree, or named by a
 * form), a private dictionary with the names used and sometimes a few that are not, or none at all (a form
 * that draws with the resources of its page). Forms draw pictures and other forms.
 * @returns {Promise<{ bytes: Uint8Array, signatures: Buffer[], draws: Array<Set<number>> }>}  draws[page] = the
 *          pictures the page shows, directly or through its forms
 */
async function buildRandomSharing(random) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const N = (name) => PDFName.of(name);
  const global = ctx.obj({});
  const globalRef = ctx.register(global);
  const xobjects = ctx.obj({});
  global.set(N("XObject"), xobjects);
  const signatures = [];
  const imageRefs = [];
  for (let index = 0; index < 6; index += 1) {
    const pixels = noiseBytes(8 * 6 * 3, 4000 + index + random.int(1000) * 10);
    signatures.push(Buffer.from(pixels.slice(40, 72)));
    imageRefs.push(ctx.register(ctx.stream(pixels, { Type: "XObject", Subtype: "Image", Width: 8, Height: 6, ColorSpace: "DeviceRGB", BitsPerComponent: 8 })));
    xobjects.set(N(`I${index}`), imageRefs[index]);
  }
  const place = (name) => `q 20 0 0 15 ${random.int(95)} ${random.int(70)} cm /${name} Do Q\n`;
  // forms: a later form may draw an earlier one
  const forms = [];
  for (let index = 0; index < 3; index += 1) {
    const inner = forms.filter((form) => form.mode !== "inherit");
    const mode = random.pick(["inherit", "global", "private"]);
    const images = random.some([0, 1, 2, 3, 4, 5], 1, 2);
    const nested = inner.length && random.int(2) ? [random.pick(inner)] : [];
    const dict = { Type: "XObject", Subtype: "Form", BBox: [0, 0, 120, 90] };
    if (mode === "global") dict.Resources = globalRef;
    if (mode === "private") {
      const own = ctx.obj({});
      for (const image of [...images, ...random.some([0, 1, 2, 3, 4, 5], 0, 2)]) own.set(N(`I${image}`), imageRefs[image]);
      for (const form of nested) own.set(N(form.name), form.ref);
      dict.Resources = ctx.obj({ XObject: own });
    }
    const body = images.map((image) => place(`I${image}`)).join("") + nested.map((form) => `/${form.name} Do\n`).join("");
    const draws = new Set(images);
    for (const form of nested) for (const image of form.draws) draws.add(image);
    const form = { name: `F${index}`, mode, draws, ref: ctx.register(ctx.stream(body, dict)) };
    forms.push(form);
    xobjects.set(N(form.name), form.ref);
  }
  const draws = [];
  const treeShares = random.int(2) === 1;
  if (treeShares) doc.catalog.Pages().set(N("Resources"), globalRef);
  for (let index = 0; index < 4; index += 1) {
    const page = doc.addPage([120, 90]);
    const mode = random.pick(treeShares ? ["tree", "global", "private"] : ["global", "private"]);
    const images = random.some([0, 1, 2, 3, 4, 5], 1, 3);
    // a form without resources draws with the page's: it needs a page that names everything
    const usable = forms.filter((form) => mode !== "private" || form.mode !== "inherit");
    const used = random.some(usable, 0, 2);
    page.node.delete(N("Resources"));
    if (mode === "global") page.node.set(N("Resources"), globalRef);
    if (mode === "private") {
      const own = ctx.obj({});
      for (const image of [...images, ...random.some([0, 1, 2, 3, 4, 5], 0, 2)]) own.set(N(`I${image}`), imageRefs[image]);
      for (const form of used) own.set(N(form.name), form.ref);
      page.node.set(N("Resources"), ctx.obj({ XObject: own }));
    }
    const body = `${0.5 + random.int(5) / 10} g 0 0 120 90 re f\n${images.map((image) => place(`I${image}`)).join("")}${used.map((form) => `/${form.name} Do\n`).join("")}`;
    page.node.set(N("Contents"), ctx.register(ctx.stream(body)));
    const shown = new Set(images);
    for (const form of used) for (const image of form.draws) shown.add(image);
    draws.push(shown);
  }
  return { bytes: await doc.save({ useObjectStreams: false }), signatures, draws };
}

test("generated documents: after any deletion exactly the pictures of the kept pages are in the file, and the pages look the same", async () => {
  let pruned = 0;
  let dropped = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const random = seeded(seed);
    const source = await buildRandomSharing(random);
    const kept = random.some([0, 1, 2, 3], 1, 3);
    const result = await exportDocument({
      sources: [{ id: "s", bytes: source.bytes, expectedPages: 4 }],
      pages: kept.map((index) => ({ source: "s", index })),
      now: NOW,
      idSeed: SEED
    });
    const label = `seed ${seed}, pages ${kept.join(" ")}`;
    assert.deepEqual([result.report.warnings, result.report.sources.s.copy.resources.unresolved], [[], []], label);
    const raw = Buffer.from(result.bytes);
    const expected = source.signatures.map((signature, image) => kept.some((page) => source.draws[page].has(image)));
    assert.deepEqual(source.signatures.map((signature) => raw.includes(signature)), expected, `${label}: which pictures are in the file`);
    assert.deepEqual((await fileFacts(result.bytes)).orphans, [], label);
    pruned += result.report.sources.s.copy.resources.removed > 0 ? 1 : 0;
    dropped += expected.filter((present) => !present).length;
    if (canRender) {
      const [before, after] = [await renderAll(source.bytes, { scale: 1 }), await renderAll(result.bytes, { scale: 1 })];
      kept.forEach((page, position) => assert.equal(differingPixels(before[page], after[position]), 0, `${label}: output page ${position + 1}`));
    }
  }
  // the generator really produces the cases that matter
  assert.ok(pruned >= 20 && dropped >= 40, `${pruned} documents needed pruning, ${dropped} pictures had to go`);
});
