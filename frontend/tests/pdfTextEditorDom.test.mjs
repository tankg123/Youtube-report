// The parts of the text editor that are plain logic over DOM-shaped data (text/caret.js): reading the text of
// an editable element in every shape browsers were seen to give it, and the map between a transformed box and
// the screen. The nodes here are stand-ins with the few properties the code reads.
import test from "node:test";
import assert from "node:assert/strict";
import { MARKER_SPAN, editableDomText, editableModelText, localMap, readEditableText } from "../src/pages/pdfEditor/text/caret.js";
import { fromCodePoints as s } from "./helpers/pdfTextKit.mjs";

const LF = s(0x0a);
const text = (data) => ({ nodeType: 3, nodeName: "#text", data, length: data.length });
const element = (nodeName, ...childNodes) => ({ nodeType: 1, nodeName, childNodes });
const root = (...childNodes) => element("DIV", ...childNodes);
const br = () => element("BR");
const div = (...childNodes) => element("DIV", ...childNodes);

test("the model text is everything the element shows, minus ONE trailing line break", () => {
  // shapes seen in Chrome and Edge 157 with contenteditable="plaintext-only"
  const cases = [
    [root(), "", "an empty box"],
    [root(text("ab")), "ab", "typed"],
    [root(text("ab"), text(LF), text(LF)), `ab${LF}`, "Enter at the end: the line feed plus a placeholder for the caret"],
    [root(text("ab"), text(LF), text("c")), `ab${LF}c`, "the placeholder is replaced by the next letter"],
    [root(text("ab"), text(LF), text("c"), text(LF), text(LF), text(LF)), `ab${LF}c${LF}${LF}`, "two empty lines at the end"],
    [root(text(LF)), "", "select all + Delete leaves one line feed"],
    [root(br()), "", "... or a <br>"],
    [root(text(`abc${LF}`)), "abc", "a text set by script with a line feed at the end shows one line"],
    [root(text(`một${LF}hai${LF}${LF}`)), `một${LF}hai${LF}`, "pasted text that ends with a line break"]
  ];
  for (const [node, expected, name] of cases) assert.equal(editableModelText(node), expected, name);
});

test("blocks and <br> from a rich-text field or from the browser's own paste read as lines", () => {
  // the browser's own paste of "ends with newline\n" into a plaintext-only element
  assert.equal(readEditableText(root(text(`ends with newline${LF}`), div(br()))), `ends with newline${LF}${LF}`);
  assert.equal(editableModelText(root(text(`ends with newline${LF}`), div(br()))), `ends with newline${LF}`);
  // execCommand("insertText") with line feeds makes <div> children
  assert.equal(editableModelText(root(text("start ONE"), div(text("TWO")), div(br()), div(text("FOUR end")))), `start ONE${LF}TWO${LF}${LF}FOUR end`);
  // contenteditable="true": Enter makes a <div>
  assert.equal(editableModelText(root(text("ab"), div(text("c")))), `ab${LF}c`);
  assert.equal(editableModelText(root(div(text("ab")), div(text("c")), div(br()))), `ab${LF}c${LF}`);
  assert.equal(editableModelText(root(text("x"), br())), "x");
  assert.equal(editableModelText(root(text("x"), br(), br())), `x${LF}`);
  assert.equal(editableModelText(root(text("a"), element("SPAN", text("b"), element("B", text("c"))), text("d"))), "abcd");
  assert.equal(editableModelText(root(element("P"), element("P", text("b")))), `${LF}b`);
});

test("what the element holds is normalised on the way out, never on the way in", () => {
  // typed by the Windows Vietnamese keyboard: a base letter and a combining mark; a pasted tab
  assert.equal(editableModelText(root(text(`Ti${s(0x65, 0x302, 0x301)}ng`), text(`${s(0x09)}Vi${s(0xea, 0x323)}t`))), "Tiếng    Việt");
  assert.equal(editableModelText(root(text(`a${s(0x200b)}b${s(0xad)}`))), "ab");
});

test("the text put into the element for a model text shows the same lines, and reads back the same", () => {
  assert.equal(editableDomText(""), "");
  assert.equal(editableDomText("ab"), "ab");
  assert.equal(editableDomText(`ab${LF}c`), `ab${LF}c`);
  assert.equal(editableDomText(`ab${LF}`), `ab${LF}${LF}`); // an empty last line needs its placeholder
  assert.equal(editableDomText(LF), `${LF}${LF}`);
  for (const model of ["", "a", `a${LF}`, `${LF}`, `${LF}${LF}a`, `a${LF}${LF}`, `Hợp đồng${LF}số 12`]) {
    const dom = editableDomText(model);
    assert.equal(editableModelText(dom === "" ? root() : root(text(dom))), model, JSON.stringify(model));
  }
});

// --- the map between the local coordinates of a transformed box and the screen ---

const marker = (left, top) => ({ getBoundingClientRect: () => ({ left, top }) });
/** Markers of an element whose local point (x, y) lands on screen at origin + x * ex + y * ey. */
const markers = (origin, ex, ey) => [marker(origin[0], origin[1]), marker(origin[0] + MARKER_SPAN * ex[0], origin[1] + MARKER_SPAN * ex[1]), marker(origin[0] + MARKER_SPAN * ey[0], origin[1] + MARKER_SPAN * ey[1])];
const close = (actual, expected, label) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${label}: ${actual} != ${expected}`));

test("localMap: a scaled box (the layout scale at 100 % zoom)", () => {
  const scale = (96 / 72) / 8;
  const map = localMap(...markers([40.5, 30.25], [scale, 0], [0, scale]));
  assert.ok(map.upright);
  assert.ok(Math.abs(map.scale - scale) < 1e-12);
  assert.ok(Math.abs(map.angle) < 1e-12);
  close(map.toClient(0, 0), [40.5, 30.25], "origin");
  close(map.toClient(600, 96), [40.5 + 100, 30.25 + 16], "a point");
  close(map.toLocal(140.5, 46.25), [600, 96], "and back");
});

test("localMap: turned boxes", () => {
  // a quarter turn clockwise on screen: local x points down, local y points left
  const quarter = localMap(...markers([200, 100], [0, 0.5], [-0.5, 0]));
  assert.equal(quarter.upright, false);
  assert.ok(Math.abs(quarter.scale - 0.5) < 1e-12);
  assert.ok(Math.abs(quarter.angle - Math.PI / 2) < 1e-12);
  close(quarter.toClient(100, 40), [200 - 20, 100 + 50], "to client");
  close(quarter.toLocal(180, 150), [100, 40], "to local");
  // 30 degrees: there and back for a handful of points
  const angle = (30 * Math.PI) / 180;
  const k = 0.25;
  const turned = localMap(...markers([300, 200], [k * Math.cos(angle), k * Math.sin(angle)], [-k * Math.sin(angle), k * Math.cos(angle)]));
  assert.equal(turned.upright, false);
  assert.ok(Math.abs(turned.angle - angle) < 1e-12);
  for (const point of [[0, 0], [123.5, 0], [0, 77], [512, 256], [-40, 900]]) close(turned.toLocal(...turned.toClient(...point)), point, `round trip ${point}`);
  // half a turn (an upright box on a page turned by 180 degrees is NOT this: its two turns cancel)
  const half = localMap(...markers([500, 400], [-1, 0], [0, -1]));
  assert.equal(half.upright, false);
  close(half.toLocal(490, 380), [10, 20], "half turn");
});

test("localMap: an element that is not laid out gives no map", () => {
  assert.equal(localMap(marker(0, 0), marker(0, 0), marker(0, 0)), null);
  assert.equal(localMap(marker(5, 5), marker(105, 5), marker(205, 5)), null); // both axes on one line
});
