// The controlled page list, the zoom arithmetic and the bookmark resolution of the PDF viewer (pure modules).
import test from "node:test";
import assert from "node:assert/strict";
import { pdfjs } from "./helpers/pdfTestKit.mjs";
import { makePdf, openPdfDocument } from "./helpers/pdfViewerKit.mjs";
import { validateObject } from "../src/pages/pdfEditor/model/schema.js";
import { viewportTransform } from "../src/pages/pdfEditor/engine/geometry.js";
import { NEUTRAL_DISPLAY, checkPages, contentKey, diffPages, pagesFromFacts, slotMetrics, slotStyle, totalRotation, visiblePageSize } from "../src/pages/pdfEditor/viewer/pageList.js";
import { destinationRect, resolveDestination, resolveOutline } from "../src/pages/pdfEditor/viewer/outline.js";
import { CSS_UNITS, ZOOM_MAX, ZOOM_MIN, ZOOM_STOPS, clampZoom, fitZoom, nextZoomStop, previousZoomStop, scaleToZoom, zoomPercent, zoomToScale } from "../src/pages/pdfEditor/viewer/zoom.js";
import { CODES } from "../src/pages/pdfEditor/viewer/codes.js";
import { createGuard } from "../src/pages/pdfEditor/viewer/guard.js";

const page =(id, extra = {}) => ({ id, kind: "pdf", sourceId: "s1", sourceIndex: 0, view: [0, 0, 595.28, 841.89], baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [], ...extra });
const blank = (id, extra = {}) => ({ id, kind: "blank", sourceId: null, sourceIndex: null, view: [0, 0, 400, 300], baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [], ...extra });

test("diffPages: a page that only moved is not reported as changed", () => {
  const a = page("a");
  const b = page("b", { sourceIndex: 1 });
  const c = page("c", { sourceIndex: 2 });
  assert.deepEqual(diffPages([a, b, c], [a, b, c]), { added: [], removed: [], changed: [], rotated: [], moved: false });
  assert.deepEqual(diffPages([a, b, c], [c, a, b]), { added: [], removed: [], changed: [], rotated: [], moved: true });
  const d = blank("d");
  assert.deepEqual(diffPages([a, b, c], [a, d, c]), { added: ["d"], removed: ["b"], changed: [], rotated: [], moved: false });
  // rotation by the user: the same id, a new object
  assert.deepEqual(diffPages([a, b], [a, { ...b, rotation: 90 }]), { added: [], removed: [], changed: [], rotated: ["b"], moved: false });
  // a full turn is no change on screen
  assert.deepEqual(diffPages([a], [{ ...a, rotation: 360 }]).rotated, []);
  // the same id now shows another source page
  assert.deepEqual(diffPages([a, b], [a, { ...b, sourceIndex: 5 }]).changed, ["b"]);
  // objects on the page do not concern the viewer
  assert.deepEqual(diffPages([a], [{ ...a, objectIds: ["o1"] }]), { added: [], removed: [], changed: [], rotated: [], moved: false });
  assert.deepEqual(diffPages([], [a, b]).added, ["a", "b"]);
  assert.deepEqual(diffPages([a, b], []).removed, ["a", "b"]);
});

test("contentKey and totalRotation", () => {
  const a = page("a");
  assert.equal(contentKey(a), contentKey({ ...a, id: "copy", rotation: 90, objectIds: ["x"] }), "a duplicate shares the content");
  assert.notEqual(contentKey(a), contentKey({ ...a, sourceId: "s2" }));
  assert.notEqual(contentKey(a), contentKey({ ...a, baseRotation: 90 }));
  assert.notEqual(contentKey(blank("b")), contentKey(blank("b", { view: [0, 0, 300, 400] })));
  assert.equal(totalRotation({ baseRotation: 270, rotation: 180 }), 90);
  assert.equal(totalRotation({ baseRotation: 0, rotation: 0 }), 0);
  assert.deepEqual(visiblePageSize(page("a", { view: [0, 0, 200, 300], rotation: 90 })), { width: 300, height: 200, rotation: 90 });
  assert.deepEqual(visiblePageSize(page("a", { view: [10, 20, 110, 220], userUnit: 2 })), { width: 200, height: 400, rotation: 0 });
});

test("slotStyle writes the size expressions of pdf.js' layers and the rounding step of the canvas", () => {
  const upright = slotStyle(page("a", { view: [50, 60, 500, 700] }), 1.5);
  assert.deepEqual(upright, {
    width: "round(down, var(--total-scale-factor) * 450px, var(--scale-round-x))",
    height: "round(down, var(--total-scale-factor) * 640px, var(--scale-round-y))",
    "--scale-round-x": "1px",
    "--scale-round-y": "1px"
  });
  // a turned page swaps the two expressions (as setLayerDimensions does with mustFlip)
  const turned = slotStyle(page("a", { view: [50, 60, 500, 700], baseRotation: 90 }), 1.5);
  assert.equal(turned.width, upright.height);
  assert.equal(turned.height, upright.width);
  assert.equal(slotStyle(page("a", { baseRotation: 90, rotation: 90 }), 1).width, slotStyle(page("a"), 1).width, "180 degrees: not turned");
  assert.equal(slotStyle(page("a", { userUnit: 2.5 }), 1)["--user-unit"], "2.5");
  assert.equal("--user-unit" in upright, false);
  // a fractional pixel ratio needs a coarser step so that canvas pixels meet device pixels
  const display = { ...NEUTRAL_DISPLAY, pixelRatio: 1.25 };
  assert.equal(slotStyle(page("a"), 1.5, display)["--scale-round-x"], "4px");
  const metrics = slotMetrics(page("a"), 1.5, display);
  assert.equal(metrics.canvas.canvasWidth / metrics.canvas.pageWidth, 1.25);
  assert.equal(metrics.viewport.width, viewportTransform({ view: [0, 0, 595.28, 841.89], rotate: 0, userUnit: 1 }, 1.5, 0).width);
  assert.ok(metrics.canvas.pageWidth <= metrics.viewport.width && metrics.viewport.width - metrics.canvas.pageWidth < 4);
});

test("checkPages names what is wrong with a list", () => {
  assert.deepEqual(checkPages([page("a"), blank("b")]), []);
  assert.deepEqual(checkPages("nope"), ["not an array"]);
  assert.match(checkPages([page("a"), page("a")])[0], /duplicate id a/);
  assert.match(checkPages([{ ...page("a"), kind: "image" }])[0], /kind/);
  assert.match(checkPages([{ ...page("a"), view: [0, 0, 0, 10] }])[0], /view/);
  assert.match(checkPages([{ ...page("a"), sourceIndex: -1 }])[0], /source/);
  assert.match(checkPages([{ kind: "pdf" }])[0], /id/);
});

test("pagesFromFacts makes list entries in file order with fresh ids", () => {
  const facts = { pages: [{ view: [0, 0, 200, 300], rotate: 0, userUnit: 1 }, { view: [10, 20, 110, 220], rotate: 270, userUnit: 2 }] };
  let seed = 0;
  const pages = pagesFromFacts("s9", facts, { makeId: () => `id${(seed += 1)}` });
  assert.deepEqual(pages, [
    { id: "id1", kind: "pdf", sourceId: "s9", sourceIndex: 0, view: [0, 0, 200, 300], baseRotation: 0, userUnit: 1, rotation: 0, objectIds: [] },
    { id: "id2", kind: "pdf", sourceId: "s9", sourceIndex: 1, view: [10, 20, 110, 220], baseRotation: 270, userUnit: 2, rotation: 0, objectIds: [] }
  ]);
  assert.notEqual(pages[0].view, facts.pages[0].view, "the view is a copy");
  const generated = pagesFromFacts("s9", facts);
  assert.equal(new Set(generated.map((entry) => entry.id)).size, 2);
  assert.deepEqual(checkPages(generated), []);
  // an object of the model can live on such a page
  assert.deepEqual(validateObject({ id: "o1", type: "redact", pageId: generated[0].id, rect: [0, 0, 10, 10], color: "#000000" }), []);
});

test("zoom: factor and scale, stops, limits, fit modes", () => {
  assert.equal(zoomToScale(1), 96 / 72);
  assert.equal(scaleToZoom(zoomToScale(1.5)), 1.5);
  assert.equal(CSS_UNITS, 96 / 72);
  assert.equal(ZOOM_MIN, 0.1);
  assert.equal(ZOOM_MAX, 8);
  assert.equal(ZOOM_STOPS[0], ZOOM_MIN);
  assert.equal(ZOOM_STOPS[ZOOM_STOPS.length - 1], ZOOM_MAX);
  assert.ok(ZOOM_STOPS.every((stop, index) => index === 0 || stop > ZOOM_STOPS[index - 1]));
  assert.equal(clampZoom(0.01), 0.1);
  assert.equal(clampZoom(50), 8);
  assert.equal(clampZoom(1.37), 1.37);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(-2), 1);
  assert.equal(nextZoomStop(1), 1.1);
  assert.equal(nextZoomStop(1.05), 1.1);
  assert.equal(nextZoomStop(8), 8);
  assert.equal(previousZoomStop(1), 0.9);
  assert.equal(previousZoomStop(1.05), 1);
  assert.equal(previousZoomStop(0.1), 0.1);
  // walking up and down the stops visits each one
  let zoom = ZOOM_MIN;
  const visited = [zoom];
  while (zoom < ZOOM_MAX) visited.push((zoom = nextZoomStop(zoom)));
  assert.deepEqual(visited, [...ZOOM_STOPS]);
  while (zoom > ZOOM_MIN) zoom = previousZoomStop(zoom);
  assert.equal(zoom, ZOOM_MIN);
  assert.equal(zoomPercent(1.25), 125);
  assert.equal(zoomPercent(0.333), 33);

  const box = { pageWidth: 600, pageHeight: 800, availableWidth: 1200, availableHeight: 800 };
  assert.equal(fitZoom("actual", box), 1);
  assert.equal(fitZoom("fit-width", box), 1200 / (600 * CSS_UNITS));
  assert.equal(fitZoom("fit-page", box), 800 / (800 * CSS_UNITS), "the height is the tighter side");
  assert.equal(fitZoom("fit-page", { ...box, availableWidth: 300 }), 300 / (600 * CSS_UNITS));
  assert.equal(fitZoom("fit-width", { ...box, availableWidth: 100000 }), ZOOM_MAX);
  assert.equal(fitZoom("fit-width", { ...box, availableWidth: 1 }), ZOOM_MIN);
  assert.equal(fitZoom("fit-width", { ...box, availableWidth: 0 }), 1, "an unknown box changes nothing");
});

test("destinations: named and explicit, with the spot they point at", async () => {
  const bytes = await makePdf(
    [{ texts: [{ text: "Bìa", x: 50, y: 700 }] }, { size: [400, 300], texts: [{ text: "Chương 1", x: 40, y: 250 }] }, { texts: [{ text: "Chương 2", x: 50, y: 700 }] }],
    { outline: [{ title: "Bìa - Cover", page: 0 }, { title: "Chương 1: Điều khoản", page: 1, top: 260 }, { title: "Chương 2", page: 2, top: 720 }] }
  );
  const task = openPdfDocument({ data: new Uint8Array(bytes) });
  try {
    const doc = await task.promise;
    const facts = [];
    for (let number = 1; number <= doc.numPages; number += 1) facts.push({ view: (await doc.getPage(number)).view });
    const outline = await resolveOutline(doc, facts);
    assert.deepEqual(outline, [
      { title: "Bìa - Cover", pageIndex: 0, rect: null, children: [] },
      { title: "Chương 1: Điều khoản", pageIndex: 1, rect: [0, 260, 0, 260], children: [] },
      { title: "Chương 2", pageIndex: 2, rect: [0, 720, 0, 720], children: [] }
    ]);
    const raw = await doc.getOutline();
    assert.deepEqual(await resolveDestination(doc, raw[1].dest), { pageIndex: 1, fit: "XYZ", args: [null, 260, null] });
    assert.equal(await resolveDestination(doc, "no-such-name"), null);
    assert.equal(await resolveDestination(doc, [99, { name: "Fit" }]), null, "a page that does not exist");
    assert.deepEqual(await resolveDestination(doc, [2, { name: "Fit" }]), { pageIndex: 2, fit: "Fit", args: [] });
    assert.equal(await resolveDestination(doc, [{ num: 9999, gen: 0 }, { name: "Fit" }]), null, "a reference that is not a page");
    assert.equal(await resolveDestination(doc, null), null);
  } finally {
    await task.destroy();
  }
  const view = [10, 20, 310, 420];
  assert.deepEqual(destinationRect({ fit: "XYZ", args: [100, 300, 0] }, view), [100, 300, 100, 300]);
  assert.deepEqual(destinationRect({ fit: "XYZ", args: [null, 300, null] }, view), [10, 300, 10, 300]);
  assert.equal(destinationRect({ fit: "XYZ", args: [null, null, null] }, view), null);
  assert.deepEqual(destinationRect({ fit: "FitH", args: [250] }, view), [10, 250, 10, 250]);
  assert.deepEqual(destinationRect({ fit: "FitV", args: [80] }, view), [80, 420, 80, 420]);
  assert.deepEqual(destinationRect({ fit: "FitR", args: [200, 300, 100, 100] }, view), [100, 100, 200, 300]);
  assert.equal(destinationRect({ fit: "Fit", args: [] }, view), null);
  assert.equal(destinationRect(null, view), null);
});

test("codes: every code is a VIEW_ code with its parameter names, and pdf.js is the pinned version", () => {
  for (const [code, params] of Object.entries(CODES)) {
    assert.match(code, /^VIEW_[A-Z_]+$/);
    assert.ok(Array.isArray(params) && params.every((name) => typeof name === "string"));
  }
  assert.ok(Object.isFrozen(CODES));
  assert.equal(pdfjs.version, "6.5.438");
});

test("guard: a promise that never settles is left behind when the guard is cancelled", async () => {
  const guard = createGuard();
  assert.equal(guard.cancelled, false);
  // settles like the promise it wraps
  assert.equal(await guard.run(Promise.resolve(7)), 7);
  assert.equal(await guard.run(42), 42);
  await assert.rejects(guard.run(Promise.reject(new Error("boom"))), /boom/);
  // a promise that hangs for ever (pdf.js getOperatorList() after its document was destroyed)
  const stuck = guard.run(new Promise(() => {}));
  const slow = guard.run(new Promise((resolve) => setTimeout(() => resolve("late"), 30)));
  const reason = new Error("closed");
  guard.cancel(reason);
  guard.cancel(new Error("only the first reason counts"));
  await assert.rejects(stuck, (error) => error === reason);
  await assert.rejects(slow, (error) => error === reason);
  assert.equal(guard.cancelled, true);
  assert.equal(guard.reason, reason);
  // everything asked for afterwards is refused at once, and a late failure of the abandoned promise is swallowed
  await assert.rejects(guard.run(Promise.resolve(1)), (error) => error === reason);
  await assert.rejects(guard.run(Promise.reject(new Error("ignored"))), (error) => error === reason);
  await new Promise((resolve) => setTimeout(resolve, 50));
});
