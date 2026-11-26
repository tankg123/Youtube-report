import test from "node:test";
import assert from "node:assert/strict";
import {
  VIETNAMESE_SAMPLE,
  canRender,
  extractText,
  fontBytes,
  fontManifest,
  makePng,
  makeTextPdf,
  pageItems,
  rectToPixels,
  regionStats,
  renderPage,
  squash,
  withPdf
} from "./helpers/pdfTestKit.mjs";
import { rawScan } from "./helpers/pdfRawScan.mjs";
import { SIGNATURE_FONTS, TEXT_FONTS, fontKeyOf } from "../src/pages/pdfEditor/model/schema.js";

test("the bundled fonts match the schema's font list and the manifest", () => {
  const ids = new Set(fontManifest.fonts.map((font) => font.id));
  for (const font of TEXT_FONTS) {
    for (const [bold, italic] of [[false, false], [true, false], [false, true], [true, true]]) {
      const key = fontKeyOf(font.id, bold, italic);
      assert.ok(ids.has(key), key);
      assert.ok(fontBytes(key).length > 10000, key);
    }
  }
  for (const font of SIGNATURE_FONTS) assert.ok(ids.has(fontKeyOf(font.id)), font.id);
  assert.equal(ids.size, TEXT_FONTS.length * 4 + SIGNATURE_FONTS.length);
});

test("a generated Vietnamese PDF round-trips through pdf.js text extraction", async () => {
  const bytes = await makeTextPdf([{ lines: [VIETNAMESE_SAMPLE, "Second line"] }, { lines: ["Trang hai"], rotate: 90 }]);
  const pages = await extractText(bytes);
  assert.equal(pages.length, 2);
  assert.ok(squash(pages[0]).includes(squash(VIETNAMESE_SAMPLE)));
  assert.ok(squash(pages[1]).includes(squash("Trang hai")));
  await withPdf(bytes, async (doc) => {
    const items = await pageItems(await doc.getPage(1));
    assert.ok(items.length >= 2);
    assert.ok(items[0].box[2] > items[0].box[0] && items[0].box[3] > items[0].box[1]);
  });
});

test("rendering shows ink where the text is and paper elsewhere", { skip: !canRender && "no canvas binary on this platform" }, async () => {
  const bytes = await makeTextPdf([{ lines: [VIETNAMESE_SAMPLE] }]);
  await withPdf(bytes, async (doc) => {
    const page = await doc.getPage(1);
    const [item] = await pageItems(page);
    const { ctx, canvas, viewport } = await renderPage(page, { scale: 2 });
    const inked = regionStats(ctx, rectToPixels(viewport, item.box, canvas));
    assert.ok(inked.dark > 50, `dark pixels in the text box: ${inked.dark}`);
    const blank = regionStats(ctx, rectToPixels(viewport, [50, 100, 300, 300], canvas));
    assert.equal(blank.uniform, true);
    assert.equal(blank.mean, "#ffffff");
  });
});

test("the raw scan finds text stored as a readable string and a PNG helper makes a valid picture", async () => {
  const bytes = await makeTextPdf([{ lines: ["plain"] }], { title: "Secret title 123" });
  const scan = rawScan(bytes, ["Secret title 123", "not in this file"]);
  assert.ok(JSON.stringify(scan).includes("Secret title 123"));
  const png = makePng(8, 8);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
