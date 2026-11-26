// Writes ONE incremental update after the untouched bytes of a PDF:
//   <original bytes> [EOL] objects... cross-reference section (table or stream) startxref %%EOF
// Pure byte work, no PDF library: the caller passes every object already serialised. Browser + Node.
//
// Rules (each one measured against pyHanko's strict reader, OpenSSL, pdf.js, Xpdf and MuPDF):
//  * the section has the style the caller names (it must be the style of the LAST section of the input);
//  * /Prev = the value of the last startxref of the input;
//  * the trailer is built from an allow-list (/Size /Root /Info /ID /Prev): /XRefStm, /DocChecksum, /W,
//    /Index, /Filter ... of the previous section are never copied;
//  * table entries are exactly 20 bytes, one subsection per run of consecutive numbers, plus "0 1" with
//    "0000000000 65535 f"; a cross-reference stream is uncompressed, lists itself and uses 4-byte offsets
//    (more when the file exceeds 4 GB).

import { PdfEditorError } from "../errors.js";
import { latin1Encode, toHex } from "./bytes.js";

const internal = (check, detail) => new PdfEditorError("SIGN_INTERNAL", { check }, { detail });

function bytesNeeded(value) {
  let count = 1;
  let rest = Math.floor(value / 256);
  while (rest > 0) {
    count++;
    rest = Math.floor(rest / 256);
  }
  return count;
}

function writeUIntBE(target, at, value, width) {
  let rest = value;
  for (let i = width - 1; i >= 0; i--) {
    target[at + i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
}

/** Runs of consecutive object numbers: [[first, count], ...] (entries must be sorted). */
function subsections(entries) {
  const runs = [];
  for (const entry of entries) {
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === entry.objectNumber) last[1]++;
    else runs.push([entry.objectNumber, 1]);
  }
  return runs;
}

const refText = (ref) => `${ref.objectNumber} ${ref.generationNumber} R`;

function trailerEntries({ size, root, info, id, prev }) {
  const parts = [`/Size ${size}`, `/Root ${refText(root)}`];
  if (info) parts.push(`/Info ${refText(info)}`);
  if (id) parts.push(`/ID [<${toHex(id[0])}> <${toHex(id[1])}>]`);
  parts.push(`/Prev ${prev}`);
  return parts;
}

/**
 * @param {object} p
 * @param {Uint8Array} p.original          the file as it is; copied verbatim to the front of the result
 * @param {{ objectNumber: number, generationNumber: number, body: Uint8Array }[]} p.objects
 *        objects to write (new ones and replacements), body = what goes between "obj" and "endobj"
 * @param {"table" | "stream"} p.xrefType  must be the type of the last section of `original`
 * @param {number} p.prevXrefOffset        value of the last startxref of `original`
 * @param {number} p.size                  /Size of the new section when xrefType is "table"; for "stream" the
 *                                         cross-reference stream gets object number `size` and /Size is size + 1
 * @param {{ objectNumber: number, generationNumber: number }} p.root
 * @param {{ objectNumber: number, generationNumber: number } | null} p.info
 * @param {[Uint8Array, Uint8Array] | null} p.id
 * @returns {{ bytes: Uint8Array, originalLength: number, updateStart: number, startxref: number, size: number,
 *            offsets: Map<number, { offset: number, bodyOffset: number, bodyLength: number }>, xrefStreamObjectNumber: number | null }}
 */
export function buildIncrementalUpdate({ original, objects, xrefType, prevXrefOffset, size, root, info = null, id = null }) {
  if (!(original instanceof Uint8Array)) throw internal("update-input", "original must be a Uint8Array");
  if (xrefType !== "table" && xrefType !== "stream") throw internal("update-input", `unknown xrefType ${xrefType}`);
  const sorted = [...objects].sort((a, b) => a.objectNumber - b.objectNumber);
  for (let i = 0; i < sorted.length; i++) {
    const object = sorted[i];
    if (!Number.isInteger(object.objectNumber) || object.objectNumber <= 0) throw internal("update-object-number", `invalid object number ${object.objectNumber}`);
    if (object.objectNumber >= size) throw internal("update-object-number", `object ${object.objectNumber} is outside /Size ${size}`);
    if (i > 0 && sorted[i - 1].objectNumber === object.objectNumber) throw internal("update-object-number", `object ${object.objectNumber} is written twice`);
  }

  const chunks = [];
  let length = original.length;
  const push = (bytes) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const pushText = (text) => push(latin1Encode(text));

  // The update starts on a new line. A file that already ends with an EOL gets nothing extra.
  const lastByte = original.length ? original[original.length - 1] : 0x0a;
  if (lastByte !== 0x0a && lastByte !== 0x0d) pushText("\n");
  const updateStart = length;

  const offsets = new Map();
  const entries = [{ objectNumber: 0, generationNumber: 65535, free: true, offset: 0 }];
  for (const object of sorted) {
    const offset = length;
    pushText(`${object.objectNumber} ${object.generationNumber} obj\n`);
    const bodyOffset = length;
    push(object.body);
    pushText("\nendobj\n");
    offsets.set(object.objectNumber, { offset, bodyOffset, bodyLength: object.body.length });
    entries.push({ objectNumber: object.objectNumber, generationNumber: object.generationNumber, free: false, offset });
  }

  let startxref;
  let finalSize = size;
  let xrefStreamObjectNumber = null;
  if (xrefType === "table") {
    startxref = length;
    const byNumber = new Map(entries.map((entry) => [entry.objectNumber, entry]));
    let text = "xref\n";
    for (const [first, count] of subsections(entries)) {
      text += `${first} ${count}\n`;
      for (let number = first; number < first + count; number++) {
        const entry = byNumber.get(number);
        // every entry is exactly 20 bytes: 10-digit offset, space, 5-digit generation, space, n | f, SP LF
        if (entry.offset > 9999999999) throw new PdfEditorError("SIGN_TOO_LARGE", {}, { detail: "an offset does not fit a classic cross-reference table" });
        text += `${String(entry.offset).padStart(10, "0")} ${String(entry.generationNumber).padStart(5, "0")} ${entry.free ? "f" : "n"} \n`;
      }
    }
    text += `trailer\n<< ${trailerEntries({ size, root, info, id, prev: prevXrefOffset }).join(" ")} >>\n`;
    pushText(text);
  } else {
    xrefStreamObjectNumber = size;
    finalSize = size + 1;
    startxref = length;
    entries.push({ objectNumber: xrefStreamObjectNumber, generationNumber: 0, free: false, offset: startxref });
    entries.sort((a, b) => a.objectNumber - b.objectNumber);
    const offsetWidth = Math.max(4, bytesNeeded(startxref));
    const rowLength = 1 + offsetWidth + 2;
    const data = new Uint8Array(entries.length * rowLength);
    entries.forEach((entry, index) => {
      const at = index * rowLength;
      data[at] = entry.free ? 0 : 1;
      writeUIntBE(data, at + 1, entry.free ? 0 : entry.offset, offsetWidth);
      writeUIntBE(data, at + 1 + offsetWidth, entry.generationNumber, 2);
    });
    const index = subsections(entries).map(([first, count]) => `${first} ${count}`).join(" ");
    const dict = [
      "/Type /XRef",
      ...trailerEntries({ size: finalSize, root, info, id, prev: prevXrefOffset }),
      `/W [1 ${offsetWidth} 2]`,
      `/Index [${index}]`,
      `/Length ${data.length}`
    ];
    pushText(`${xrefStreamObjectNumber} 0 obj\n<< ${dict.join(" ")} >>\nstream\n`);
    push(data);
    pushText("\nendstream\nendobj\n");
  }
  pushText(`startxref\n${startxref}\n%%EOF\n`);

  const bytes = new Uint8Array(length);
  bytes.set(original, 0);
  let at = original.length;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, originalLength: original.length, updateStart, startxref, size: finalSize, offsets, xrefStreamObjectNumber };
}
