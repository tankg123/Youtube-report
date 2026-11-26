// The export job builder (src/pages/pdfEditor/model/exportJob.js): what the pipeline receives.
import test from "node:test";
import assert from "node:assert/strict";
import { CANCELLED } from "../src/pages/pdfEditor/engine/errors.js";
import { localToUser } from "../src/pages/pdfEditor/engine/geometry.js";
import { CODES } from "../src/pages/pdfEditor/model/codes.js";
import { buildExportJob, countJobMarks, validateLayout } from "../src/pages/pdfEditor/model/exportJob.js";
import { MARK_TYPES, validateObject } from "../src/pages/pdfEditor/model/schema.js";
import { createEditorStore } from "../src/pages/pdfEditor/model/store.js";
import { A4, bytesOf, close, closeAll, fakeLayout, fakeMeasure, openStore, sample, sourceFacts } from "./helpers/pdfModelKit.mjs";

const rejects = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.ok(Object.hasOwn(CODES, code) || code === CANCELLED);
    if (code !== CANCELLED) assert.deepEqual(Object.keys(error.params).sort(), [...CODES[code]].sort());
    return true;
  });
};

/** Three pages of one source, a second source, a blank page, objects of every type, two unused resources. */
function richDocument() {
  const opened = openStore({ pages: [{}, { rotate: 90 }, { view: [0, 0, 300, 400], userUnit: 2 }], password: "mật khẩu" });
  const { store, pageIds } = opened;
  const [a, b, c] = pageIds;
  const second = store.addSource(sourceFacts([{}, {}], { info: { title: "Phụ lục" } }), bytesOf(80, 3), { name: "phu-luc.pdf" });
  const unusedSource = store.addSource(sourceFacts([{}]), bytesOf(60, 4), { name: "khong-dung.pdf" });
  const [extra] = store.insertPages(store.pagesOfSource(second, [1]), 3);
  const blank = store.insertBlankPage(4, [420, 595]);
  store.rotatePages([b, blank], 90);
  const usedAsset = store.addAsset({ mime: "image/png", width: 300, height: 100 }, bytesOf(50, 5));
  const otherAsset = store.addAsset({ mime: "image/jpeg", width: 100, height: 100 }, bytesOf(50, 6));
  const unusedAsset = store.addAsset({ mime: "image/png", width: 10, height: 10 }, bytesOf(50, 7));
  const ids = {};
  [ids.rect, ids.redactA, ids.text, ids.image, ids.blur, ids.highlight] = store.addObjects([
    sample.rect(a),
    sample.redact(a, { color: "#ffffff" }),
    sample.text(a, { text: "Hợp đồng số 12" }),
    sample.image(a, usedAsset),
    sample.blur(a, { style: "blur", strength: 3 }),
    sample.highlightText(a)
  ]);
  [ids.replacement, ids.line] = store.addObjects([
    sample.text(b, { text: "Nguyễn Văn An", frame: { x: 300, y: 400, w: 1, h: 1, rot: 90 }, replaces: { rect: [250, 395, 380, 410], cover: "#fefefe", sourceText: "Nguyễn Văn A" } }),
    sample.line(b)
  ]);
  [ids.pixelate, ids.secondImage, ids.sameImage] = store.addObjects([sample.blur(extra), sample.image(extra, otherAsset), sample.image(extra, usedAsset)]);
  [ids.pen] = store.addObjects([sample.pen(blank, { frame: { x: 200, y: 200, w: 100, h: 40, rot: 0 } })]);
  return { ...opened, second, unusedSource, usedAsset, otherAsset, unusedAsset, extra, blank, ids, a, b, c };
}

test("the job: sources with bytes, pages in order, objects without marks, marks apart, used assets only", async () => {
  const doc = richDocument();
  const { store, sourceId, second, ids } = doc;
  store.setFileName("hop-dong-2026");
  const before = store.getState();
  const job = await buildExportJob(store, { layoutText: fakeLayout });
  assert.equal(store.getState(), before, "building a job changes nothing");
  assert.deepEqual(Object.keys(job).sort(), ["assets", "fileName", "info", "marks", "objects", "pages", "sources"]);

  // sources: only what pages use, in the order of their first page
  assert.deepEqual(job.sources.map((source) => source.id), [sourceId, second]);
  assert.equal(job.sources[0].bytes, doc.bytes, "the bytes the store holds, not a copy");
  assert.equal(job.sources[0].password, "mật khẩu");
  assert.equal(job.sources[0].expectedPages, 3, "the page count the viewer saw");
  assert.ok(!("password" in job.sources[1]), "no password, no key");
  assert.equal(job.sources[1].expectedPages, 2);

  // pages: `rotate` is what the user added, not the page's own /Rotate
  assert.deepEqual(job.pages, [
    { source: sourceId, index: 0, rotate: 0 },
    { source: sourceId, index: 1, rotate: 90 },
    { source: sourceId, index: 2, rotate: 0 },
    { source: second, index: 1, rotate: 0 },
    { blank: [420, 595], rotate: 90 }
  ]);

  // objects per page, bottom -> top, without marks
  assert.equal(job.objects.length, job.pages.length);
  assert.deepEqual(job.objects.map((list) => list.map((object) => object.id)), [
    [ids.rect, ids.text, ids.image, ids.highlight],
    [ids.replacement, ids.line],
    [],
    [ids.secondImage, ids.sameImage],
    [ids.pen]
  ]);
  for (const list of job.objects) {
    for (const object of list) {
      assert.ok(!MARK_TYPES.includes(object.type));
      assert.deepEqual(validateObject(object), []);
      assert.equal(Boolean(object.layout), object.type === "text", "every text object, and only text, carries its layout");
    }
  }
  const text = job.objects[0][1];
  assert.deepEqual(text.layout, fakeLayout(store.getState().objects[ids.text]));
  assert.equal(text.layout.width, text.frame.w);
  assert.equal(text.layout.height, text.frame.h);
  assert.equal(job.objects[0][0], store.getState().objects[ids.rect], "other objects are the objects of the model");

  // marks: redact and blur objects, then the line that a text box replaces
  // (a blur mark brings the seed of its mosaic: the store gave it one, and a copy of the mark keeps it)
  const seedOf = (id) => store.getState().objects[id].seed;
  assert.match(seedOf(ids.blur), /^[0-9a-f]{32}$/);
  assert.notEqual(seedOf(ids.blur), seedOf(ids.pixelate), "every mark has a seed of its own");
  assert.deepEqual(job.marks, [
    { pageIndex: 0, rect: [60, 60, 180, 84], mode: "redact", color: "#ffffff", objectId: ids.redactA },
    { pageIndex: 0, rect: [300, 60, 420, 120], mode: "blur", strength: 3, seed: seedOf(ids.blur), objectId: ids.blur },
    { pageIndex: 1, rect: [250, 395, 380, 410], mode: "erase", cover: "#fefefe", objectId: ids.replacement },
    { pageIndex: 3, rect: [300, 60, 420, 120], mode: "pixelate", strength: 2, seed: seedOf(ids.pixelate), objectId: ids.pixelate }
  ]);
  assert.equal((await buildExportJob(store, { layoutText: fakeLayout })).marks[1].seed, seedOf(ids.blur), "the same seed in every job");
  assert.deepEqual(countJobMarks(job), { redact: 1, pixelate: 1, blur: 1, erase: 1, pages: 2 });

  // assets: the two that are used (one of them twice), not the third
  assert.deepEqual(Object.keys(job.assets).sort(), [doc.usedAsset, doc.otherAsset].sort());
  assert.deepEqual(job.assets[doc.usedAsset], { bytes: store.getAssetBytes(doc.usedAsset), mime: "image/png" });
  assert.equal(job.assets[doc.otherAsset].mime, "image/jpeg");

  assert.deepEqual(job.info, { title: "Hợp đồng dịch vụ", author: "ANS Network" }, "the properties of the first source");
  assert.equal(job.fileName, "hop-dong-2026");
});

test("options: now, info, pageIds (extract), and layouts that arrive asynchronously", async () => {
  const doc = richDocument();
  const { store, sourceId, second, extra, a, ids } = doc;
  const fixed = new Date("2026-11-16T08:00:00Z");
  const withClock = await buildExportJob(store, { layoutText: fakeLayout, now: fixed });
  assert.deepEqual(withClock.now, fixed);
  assert.notEqual(withClock.now, fixed, "a copy of the date");
  assert.deepEqual((await buildExportJob(store, { layoutText: fakeLayout, now: () => 86400000 })).now, new Date(86400000));
  await rejects(buildExportJob(store, { layoutText: fakeLayout, now: "yesterday" }), "MODEL_INVALID_ARGUMENT");

  // an override is complete: "" tells the export engine to REMOVE an entry (a missing key would bring the
  // property of the source back)
  const none = { title: "", author: "", subject: "", keywords: "", creator: "" };
  assert.deepEqual((await buildExportJob(store, { layoutText: fakeLayout, info: {} })).info, none, "hidden information removed");
  assert.deepEqual((await buildExportJob(store, { layoutText: fakeLayout, info: null })).info, none);
  assert.deepEqual((await buildExportJob(store, { layoutText: fakeLayout, info: { title: "Bản mới", creator: "x", author: 5 } })).info, { ...none, title: "Bản mới", creator: "x" });
  // every source brings the properties the viewer read (the writer cannot read those of some encrypted files)
  assert.deepEqual(withClock.sources[0].info, { title: "Hợp đồng dịch vụ", author: "ANS Network" });
  assert.deepEqual(withClock.sources[1].info, { title: "Phụ lục" });

  // extract two pages, given in any order: document order, only their sources, objects, marks and assets
  const part = await buildExportJob(store, { layoutText: async (object) => fakeLayout(object), pageIds: [extra, a, "ghost"] });
  assert.deepEqual(part.pages, [{ source: sourceId, index: 0, rotate: 0 }, { source: second, index: 1, rotate: 0 }]);
  assert.deepEqual(part.sources.map((source) => source.id), [sourceId, second]);
  assert.deepEqual(part.marks.map((mark) => [mark.pageIndex, mark.mode]), [[0, "redact"], [0, "blur"], [1, "pixelate"]], "page indices are those of the job");
  assert.equal(part.objects.length, 2);
  assert.ok(part.objects[0][1].layout, "asynchronous layouts are awaited");
  const single = await buildExportJob(store, { layoutText: fakeLayout, pageIds: [extra] });
  assert.deepEqual(single.sources.map((source) => source.id), [second], "a source without pages in the job is left out");
  assert.deepEqual(single.info, { title: "Phụ lục" });
  assert.deepEqual(Object.keys(single.assets).length, 2);
  await rejects(buildExportJob(store, { layoutText: fakeLayout, pageIds: ["ghost"] }), "MODEL_EMPTY_DOCUMENT");
  await rejects(buildExportJob(store, { layoutText: fakeLayout, pageIds: "all" }), "MODEL_INVALID_ARGUMENT");

  // the job is ONE snapshot: changes made while layouts are awaited do not leak in
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = buildExportJob(store, { layoutText: async (object) => {
    await gate;
    return fakeLayout(object);
  } });
  store.deleteObjects([ids.rect, ids.line]);
  store.setFileName("đổi tên");
  release();
  const snapshot = await pending;
  assert.deepEqual(snapshot.objects[0].map((object) => object.id), [ids.rect, ids.text, ids.image, ids.highlight]);
  assert.notEqual(snapshot.fileName, "đổi tên");
});

test("an encrypted source that opened without a password is decrypted with the empty user password", async () => {
  // only an owner password is set: the viewer never asks, but the writer refuses the file without a password
  const ownerOnly = openStore({ facts: { encrypted: true } });
  const job = await buildExportJob(ownerOnly.store);
  assert.equal(ownerOnly.store.getSourcePassword(ownerOnly.sourceId), undefined);
  assert.equal(job.sources[0].password, "");
  const withPassword = openStore({ facts: { encrypted: true }, password: "user123" });
  assert.equal((await buildExportJob(withPassword.store)).sources[0].password, "user123");
  const plain = openStore();
  assert.ok(!("password" in (await buildExportJob(plain.store)).sources[0]));
});

test("a blank document and a document without text need no layout function", async () => {
  const store = createEditorStore();
  await rejects(buildExportJob(store), "MODEL_EMPTY_DOCUMENT");
  const page = store.insertBlankPage(0, [595.28, 841.89]);
  store.addObjects([sample.rect(page)]);
  const job = await buildExportJob(store);
  assert.deepEqual(job.sources, []);
  assert.deepEqual(job.pages, [{ blank: [595.28, 841.89], rotate: 0 }]);
  assert.deepEqual(job.info, {});
  assert.deepEqual(job.marks, []);
  assert.deepEqual(job.assets, {});
  assert.equal(job.fileName, "");
  store.addObjects([sample.text(page)]);
  await rejects(buildExportJob(store), "MODEL_LAYOUT_MISSING");
});

test("what is wrong is refused with a MODEL_ code", async () => {
  const { store, pageIds, bytes } = openStore();
  const [text] = store.addObjects([sample.text(pageIds[0])]);
  const base = fakeLayout(store.getState().objects[text]);
  const broken = [
    null,
    { ...base, width: NaN },
    { ...base, height: -1 },
    { ...base, lines: "none" },
    { ...base, lines: [{ baseline: 10, x: 0, width: 5 }] },
    { ...base, lines: [{ ...base.lines[0], runs: [{ text: "a", x: 0, font: "comic-sans-regular" }] }] },
    { ...base, lines: [{ ...base.lines[0], runs: [{ text: 5, x: 0, font: "arimo-regular" }] }] },
    { ...base, raster: { png: [1, 2, 3], x: 0, y: 0, w: 1, h: 1 } },
    { ...base, raster: { png: new Uint8Array(0), x: 0, y: 0, w: 1, h: 1 } },
    { ...base, problems: "TEXT_RASTERIZED" },
    // flagged as a picture but without the picture: the box would be exported empty
    { ...base, lines: base.lines.map((line) => ({ ...line, runs: [] })), problems: ["TEXT_RASTERIZED"] },
    { ...base, lines: base.lines.map((line) => ({ ...line, runs: [] })), raster: null, problems: ["TEXT_RASTERIZED"] }
  ];
  for (const layout of broken) {
    assert.ok(validateLayout(layout).length > 0, JSON.stringify(layout));
    await rejects(buildExportJob(store, { layoutText: () => layout }), "MODEL_INVALID_LAYOUT");
  }
  assert.deepEqual(validateLayout(base), []);
  // a picture of the text, a fallback run and missing optional fields are fine
  const raster = { ...base, raster: { png: new Uint8Array([137, 80, 78, 71]), x: -1, y: -2, w: 80, h: 20 }, problems: ["TEXT_RASTERIZED"] };
  assert.deepEqual(validateLayout(raster), []);
  const lean = { width: base.width, height: base.height, lines: [{ ...base.lines[0], runs: [{ text: "Xin ", x: 0, font: "tinos-bold-italic" }, { text: "chào", x: 24, font: "be-vietnam-pro-regular" }] }] };
  const job = await buildExportJob(store, { layoutText: () => lean });
  assert.equal(job.objects[0][0].layout.raster, null, "raster and problems are always present in the job");
  assert.deepEqual(job.objects[0][0].layout.problems, []);
  assert.deepEqual((await buildExportJob(store, { layoutText: () => raster })).objects[0][0].layout.raster, raster.raster);

  // bytes that were handed to a worker (a detached buffer) are noticed before the engines start
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  assert.equal(bytes.byteLength, 0);
  await rejects(buildExportJob(store, { layoutText: fakeLayout }), "MODEL_SOURCE_BYTES_MISSING");

  const controller = new AbortController();
  controller.abort();
  const second = openStore();
  second.store.addObjects([sample.text(second.pageIds[0])]);
  await rejects(buildExportJob(second.store, { layoutText: fakeLayout, signal: controller.signal }), CANCELLED);
});

test("an image whose bytes are gone, and a state that breaks an invariant, are refused", async () => {
  const { store, pageIds } = openStore();
  const assetId = store.addAsset({ mime: "image/png", width: 3, height: 3 }, bytesOf(30, 2));
  store.addObjects([sample.image(pageIds[0], assetId)]);
  const facade = { ...store, getAssetBytes: () => null };
  await rejects(buildExportJob(facade), "MODEL_ASSET_BYTES_MISSING");
  const state = structuredClone(store.getState());
  state.pages[0].objectIds.push("ghost");
  await rejects(buildExportJob({ ...store, getState: () => state }), "MODEL_INVALID_STATE");
  assert.ok((await buildExportJob(store)).assets[assetId]);
});

test("the frame of an exported text box is the laid-out size, anchored like in the store", async () => {
  // a store without a measurer keeps the frames it was given: the job follows the layout instead
  const { store, pageIds } = openStore({ measure: null, pages: [{ view: [0, 0, 2000, 2000] }] });
  const [left, centre, right, wrapped] = store.addObjects([
    sample.text(pageIds[0], { text: "abcdef", align: "left", frame: { x: 500, y: 500, w: 10, h: 10, rot: 30 } }),
    sample.text(pageIds[0], { text: "abcdef", align: "center", frame: { x: 800, y: 500, w: 10, h: 10, rot: 90 } }),
    sample.text(pageIds[0], { text: "abcdef", align: "right", frame: { x: 1100, y: 500, w: 10, h: 10, rot: 0 } }),
    sample.text(pageIds[0], { text: "abcdefghij", autoWidth: false, frame: { x: 1400, y: 500, w: 30, h: 10, rot: 0 } })
  ]);
  const job = await buildExportJob(store, { layoutText: fakeLayout });
  const exported = Object.fromEntries(job.objects[0].map((object) => [object.id, object]));
  for (const [id, anchor] of [[left, 0], [centre, 0.5], [right, 1]]) {
    const original = store.getState().objects[id];
    const object = exported[id];
    close(object.frame.w, 36, 1e-9);
    close(object.frame.h, 14.4, 1e-9);
    assert.equal(object.frame.rot, original.frame.rot);
    closeAll(localToUser(object.frame, [anchor * object.frame.w, 0]), localToUser(original.frame, [anchor * original.frame.w, 0]), 1e-9, `${original.align}: the anchor of the alignment stays`);
    assert.deepEqual(original.frame.w, 10, "the document itself is not touched");
  }
  assert.equal(exported[wrapped].frame.w, 30, "a wrapping box keeps its width");
  close(exported[wrapped].frame.h, 28.8, 1e-9);

  // with the measurer of the same text service nothing has to be adjusted: the very same frame object
  const measured = openStore({ measure: fakeMeasure });
  const [id] = measured.store.addObjects([sample.text(measured.pageIds[0])]);
  const measuredJob = await buildExportJob(measured.store, { layoutText: fakeLayout });
  assert.equal(measuredJob.objects[0][0].frame, measured.store.getState().objects[id].frame);
  assert.deepEqual(A4.length, 4);
});
