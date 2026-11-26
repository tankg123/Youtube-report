// Content-stream access: decoding, the content of a page as bytes, resources with copy-on-write, and
// graphics-state isolation (what makes a drawing land where it should on ANY page).
//
//   decodeStreamBytes(context, stream)          any stream object -> decoded bytes (filter arrays, predictors)
//   getPageContentBytes(page)                   all content streams of a page, decoded and joined
//   setPageContentBytes(page, bytes)            replaces them by ONE new Flate stream
//   getPageResources / ownResource              inherited resources, private copies of shared dictionaries
//   describeFormXObject / describeFont          the facts text surgery needs
//   isolatePageContent(page)                    wraps the existing content so that it leaves NO graphics state behind
//   ensureWritableResources(page)               a page whose resource dictionary is unparsed can be drawn on
//
// Private fields of the library touched here: page.contentStream / contentStreamRef (reset by
// setPageContentBytes and ensureWritableResources) and PDFPageLeaf.autoNormalizeCTM (switched off by
// isolatePageContent, which does the wrapping itself and exactly).
import { pdfLib } from "../lib.js";
import { N, resolve, dictOf, arrayOf, numberOf, nameOf } from "./pdfUtil.js";
import { tokenizeContent, analyseBalance } from "./contentTokens.js";

const { PDFRawStream, PDFStream, PDFArray, PDFDict, PDFRef, PDFName, PDFNumber, PDFInvalidObject, decodePDFRawStream } = pdfLib;

// ---------------------------------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------------------------------

/** Undoes a PNG (10-15) or TIFF (2) predictor (ISO 32000-1 7.4.4.4). */
export function undoPredictor(data, params) {
  const predictor = params.Predictor ?? 1;
  if (predictor === 1) return data;
  const colors = params.Colors ?? 1;
  const bpc = params.BitsPerComponent ?? 8;
  const columns = params.Columns ?? 1;
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) throw new Error(`TIFF predictor with ${bpc} bits per component is not supported`);
    const out = data.slice();
    for (let row = 0; row + rowLength <= out.length; row += rowLength) {
      for (let index = bytesPerPixel; index < rowLength; index += 1) out[row + index] = (out[row + index] + out[row + index - bytesPerPixel]) & 0xff;
    }
    return out;
  }
  if (predictor < 10 || predictor > 15) throw new Error(`unknown predictor ${predictor}`);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  for (let row = 0; row < rows; row += 1) {
    const filter = data[row * (rowLength + 1)];
    const src = row * (rowLength + 1) + 1;
    const dst = row * rowLength;
    const prev = dst - rowLength;
    for (let index = 0; index < rowLength; index += 1) {
      const raw = data[src + index];
      const left = index >= bytesPerPixel ? out[dst + index - bytesPerPixel] : 0;
      const up = row > 0 ? out[prev + index] : 0;
      const upLeft = row > 0 && index >= bytesPerPixel ? out[prev + index - bytesPerPixel] : 0;
      let value;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: throw new Error(`unknown PNG row filter ${filter}`);
      }
      out[dst + index] = value & 0xff;
    }
  }
  return out;
}

const FILTER_ALIASES = { Fl: "FlateDecode", LZW: "LZWDecode", A85: "ASCII85Decode", AHx: "ASCIIHexDecode", RL: "RunLengthDecode" };
const TEXT_FILTERS = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);

/**
 * Decoded bytes of any stream object of the library:
 *  - PDFRawStream (parsed from a file): every filter of the chain is undone (Flate, LZW with EarlyChange,
 *    ASCII85, ASCIIHex, RunLength), predictors included (the library's own decoder has no predictor support);
 *  - PDFContentStream / other generated streams: their unencoded contents.
 * Throws for filters that are not text filters (DCT, JPX, CCITT, JBIG2, Crypt): a content stream never has them.
 */
export function decodeStreamBytes(context, stream) {
  if (!(stream instanceof PDFStream)) throw new TypeError("decodeStreamBytes: not a stream");
  if (!(stream instanceof PDFRawStream)) {
    if (typeof stream.getUnencodedContents === "function") return stream.getUnencodedContents();
    return stream.getContents();
  }
  const filterValue = resolve(context, stream.dict.get(N("Filter")));
  const parmsValue = resolve(context, stream.dict.get(N("DecodeParms")) ?? stream.dict.get(N("DP")));
  const filters = filterValue instanceof PDFArray ? filterValue.asArray().map((filter) => nameOf(context, filter)) : filterValue instanceof PDFName ? [filterValue.decodeText()] : [];
  const parms = filters.map((_, index) => {
    const dict = parmsValue instanceof PDFArray ? dictOf(context, parmsValue.get(index)) : index === 0 ? dictOf(context, parmsValue) : undefined;
    if (!dict) return null;
    const out = {};
    for (const key of ["Predictor", "Colors", "BitsPerComponent", "Columns", "EarlyChange"]) {
      const value = numberOf(context, dict.get(N(key)));
      if (value !== undefined) out[key] = value;
    }
    return out;
  });
  let data = stream.contents;
  filters.forEach((given, index) => {
    const name = FILTER_ALIASES[given] || given;
    if (!TEXT_FILTERS.has(name)) throw new Error(`decodeStreamBytes: filter /${given} cannot be decoded here`);
    // one filter at a time through the library's decoders (a temporary stream with exactly this filter)
    const dict = context.obj({ Filter: name });
    if (name === "LZWDecode" && parms[index] && parms[index].EarlyChange !== undefined) {
      dict.set(N("DecodeParms"), context.obj({ EarlyChange: parms[index].EarlyChange }));
    }
    data = decodePDFRawStream(PDFRawStream.of(dict, data)).decode();
    if (parms[index] && (parms[index].Predictor ?? 1) > 1) data = undoPredictor(data, parms[index]);
  });
  return data;
}

// ---------------------------------------------------------------------------------------------------
// page content
// ---------------------------------------------------------------------------------------------------

/** The content stream refs of a page, in order (a single stream, an array, an indirect array, or nothing). */
export function pageContentRefs(page) {
  const node = page.node;
  const { context } = node;
  const value = node.get(N("Contents"));
  const target = resolve(context, value);
  if (target instanceof PDFStream) return value instanceof PDFRef ? [value] : [];
  if (target instanceof PDFArray) return target.asArray().filter((entry) => entry instanceof PDFRef && resolve(context, entry) instanceof PDFStream);
  return [];
}

/**
 * Every /Contents entry that resolves to an object: the streams, and objects the parser could not read
 * (PDFInvalidObject: written back as they are, so the viewer still gets them).
 */
export function pageContentEntries(page) {
  const node = page.node;
  const { context } = node;
  const value = node.get(N("Contents"));
  const target = resolve(context, value);
  const exists = (entry) => entry instanceof PDFRef && resolve(context, entry) !== undefined;
  if (target instanceof PDFArray) return target.asArray().filter(exists);
  return exists(value) ? [value] : [];
}

/** Joins byte chunks with a newline between them. */
export function joinChunks(parts) {
  let total = 0;
  for (const part of parts) total += part.length + 1;
  const out = new Uint8Array(Math.max(0, total - (parts.length ? 1 : 0)));
  let offset = 0;
  parts.forEach((part, index) => {
    out.set(part, offset);
    offset += part.length;
    if (index < parts.length - 1) {
      out[offset] = 0x0a;
      offset += 1;
    }
  });
  return out;
}

/**
 * All content streams of the page, decoded and joined with a newline (ISO 32000-1 7.8.2: the streams are
 * concatenated; the split may fall between any two tokens, so a separator is needed).
 * @returns {Uint8Array}
 */
export function getPageContentBytes(page) {
  const { context } = page.node;
  return joinChunks(pageContentRefs(page).map((ref) => decodeStreamBytes(context, context.lookup(ref))));
}

/** Which of `candidates` (a Set of refs) are referenced by some object of the document? One pass. */
function referencedAmong(context, candidates) {
  const found = new Set();
  if (!candidates.size) return found;
  const scan = (root) => {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      if (current instanceof PDFRef) {
        if (candidates.has(current)) found.add(current);
      } else if (current instanceof PDFDict) stack.push(...current.values());
      else if (current instanceof PDFArray) stack.push(...current.asArray());
      else if (current instanceof PDFStream) stack.push(current.dict);
    }
  };
  for (const [, object] of context.enumerateIndirectObjects()) {
    scan(object);
    if (found.size === candidates.size) break;
  }
  const trailer = context.trailerInfo;
  for (const root of [trailer.Root, trailer.Info, trailer.Encrypt]) if (root) scan(root);
  return found;
}

/**
 * Replaces the whole content of the page by ONE new Flate-compressed stream.
 * The old stream objects are deleted when no other object refers to them (a content stream can be shared by
 * several pages); pass { deleteOld: false } to leave that to collectGarbage().
 * @returns {{ ref: any, deleted: number, kept: number }}
 */
export function setPageContentBytes(page, bytes, { deleteOld = true } = {}) {
  const node = page.node;
  const { context } = node;
  const old = pageContentRefs(page);
  const oldArrayRef = node.get(N("Contents")) instanceof PDFRef && resolve(context, node.get(N("Contents"))) instanceof PDFArray ? node.get(N("Contents")) : null;
  const ref = context.register(context.flateStream(bytes));
  node.set(N("Contents"), context.obj([ref]));
  // the library keeps the page's own drawing stream in a private field; forget it, it is no longer on the page
  if ("contentStream" in page) {
    page.contentStream = undefined;
    page.contentStreamRef = undefined;
  }
  let deleted = 0;
  let kept = 0;
  if (deleteOld) {
    const candidates = new Set(old);
    if (oldArrayRef) candidates.add(oldArrayRef);
    const stillUsed = referencedAmong(context, candidates);
    for (const candidate of candidates) {
      if (stillUsed.has(candidate)) kept += 1;
      else {
        context.delete(candidate);
        deleted += 1;
      }
    }
  }
  return { ref, deleted, kept };
}

// ---------------------------------------------------------------------------------------------------
// resources (with copy-on-write)
// ---------------------------------------------------------------------------------------------------

/** The /Resources dictionary a page uses (its own, or the one inherited from the page tree); undefined if none. */
export function getPageResources(page) {
  const node = page.node;
  return dictOf(node.context, node.getInheritableAttribute(N("Resources")));
}

const privateResources = new WeakMap();

/**
 * Makes the page own its /Resources dictionary and the given category dictionary ("Font", "XObject", ...):
 * shallow private copies, so that changing an entry does not change another page that shared them.
 * Idempotent per page (a WeakMap remembers what is already private).
 * @returns {any} the private category dictionary (created when missing)
 */
export function ownResourceCategory(page, category) {
  const node = page.node;
  const { context } = node;
  let state = privateResources.get(node);
  if (!state || node.get(N("Resources")) !== state.resources) {
    const current = getPageResources(page);
    const resources = current ? current.clone(context) : context.obj({});
    node.set(N("Resources"), resources);
    state = { resources, categories: new Set() };
    privateResources.set(node, state);
  }
  const key = N(category);
  if (!state.categories.has(category)) {
    const current = dictOf(context, state.resources.get(key));
    state.resources.set(key, current ? current.clone(context) : context.obj({}));
    state.categories.add(category);
  }
  return state.resources.get(key);
}

/**
 * Copy-on-write for one resource: returns { ref, object } of a PRIVATE copy of the font dictionary / XObject
 * registered under `name` in `category`, and points the page's (private) category dictionary at it.
 * Use it before modifying a Form XObject or a font that other pages may share.
 */
export function ownResource(page, category, name) {
  const { context } = page.node;
  const dict = ownResourceCategory(page, category);
  const key = N(name);
  const object = resolve(context, dict.get(key));
  if (!object) throw new Error(`ownResource: /${category} /${name} does not exist on this page`);
  const clone = object.clone(context);
  const ref = context.register(clone);
  dict.set(key, ref);
  return { ref, object: clone };
}

/** How many objects of the document point at `ref` (cheap way to decide whether copy-on-write is needed). */
export function countReferences(context, ref) {
  let count = 0;
  const scan = (root) => {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      if (current === ref) count += 1;
      else if (current instanceof PDFDict) stack.push(...current.values());
      else if (current instanceof PDFArray) stack.push(...current.asArray());
      else if (current instanceof PDFStream) stack.push(current.dict);
    }
  };
  for (const [, object] of context.enumerateIndirectObjects()) scan(object);
  return count;
}

// ---------------------------------------------------------------------------------------------------
// Form XObjects
// ---------------------------------------------------------------------------------------------------

/** Facts about a Form XObject stream: decoded content, /BBox, /Matrix, /Resources. */
export function describeFormXObject(context, form) {
  const stream = resolve(context, form);
  if (!(stream instanceof PDFStream) || nameOf(context, stream.dict.get(N("Subtype"))) !== "Form") return null;
  const numbers = (key, fallback) => {
    const array = arrayOf(context, stream.dict.get(N(key)));
    return array ? array.asArray().map((value) => numberOf(context, value) ?? 0) : fallback;
  };
  return {
    stream,
    bbox: numbers("BBox", null),
    matrix: numbers("Matrix", [1, 0, 0, 1, 0, 0]),
    resources: dictOf(context, stream.dict.get(N("Resources"))),
    getBytes: () => decodeStreamBytes(context, stream)
  };
}

/** A new Form XObject stream with the same dictionary (minus filter entries) and new content. */
export function makeFormXObjectLike(context, form, bytes) {
  const original = resolve(context, form);
  const stream = context.flateStream(bytes);
  for (const [key, value] of original.dict.entries()) {
    const name = key.decodeText();
    if (name === "Filter" || name === "DecodeParms" || name === "Length" || name === "DL") continue;
    stream.dict.set(key, value);
  }
  return stream;
}

// ---------------------------------------------------------------------------------------------------
// fonts
// ---------------------------------------------------------------------------------------------------

/**
 * The facts text surgery needs about a font resource, resolved to plain data.
 * (Widths in glyph space units /1000; CID fonts: the W array through widthOfCid.)
 */
export function describeFont(context, fontValue) {
  const font = dictOf(context, fontValue);
  if (!font) return null;
  const subtype = nameOf(context, font.get(N("Subtype")));
  const out = {
    subtype,
    baseFont: nameOf(context, font.get(N("BaseFont"))),
    composite: subtype === "Type0",
    toUnicode: null,
    encoding: null
  };
  const toUnicode = resolve(context, font.get(N("ToUnicode")));
  if (toUnicode instanceof PDFStream) out.toUnicode = () => decodeStreamBytes(context, toUnicode);
  const encoding = resolve(context, font.get(N("Encoding")));
  if (encoding instanceof PDFName) out.encoding = { base: encoding.decodeText(), differences: [] };
  else if (encoding instanceof PDFDict) {
    const differences = [];
    const diffs = arrayOf(context, encoding.get(N("Differences")));
    let code = 0;
    for (const item of diffs ? diffs.asArray() : []) {
      const value = resolve(context, item);
      if (value instanceof PDFNumber) code = value.asNumber();
      else if (value instanceof PDFName) {
        differences.push([code, value.decodeText()]);
        code += 1;
      }
    }
    out.encoding = { base: nameOf(context, encoding.get(N("BaseEncoding"))) ?? null, differences };
  } else if (encoding instanceof PDFStream) out.encoding = { cmapStream: () => decodeStreamBytes(context, encoding) };

  if (out.composite) {
    const descendant = dictOf(context, arrayOf(context, font.get(N("DescendantFonts")))?.get(0));
    const readWidths = () => {
      // W: [ c [w1 w2 ...]  cFirst cLast w ... ]
      const map = new Map();
      const ranges = [];
      const w = arrayOf(context, descendant.get(N("W")));
      const list = w ? w.asArray().map((value) => resolve(context, value)) : [];
      for (let index = 0; index < list.length;) {
        const first = list[index] instanceof PDFNumber ? list[index].asNumber() : undefined;
        const next = list[index + 1];
        if (first === undefined) {
          index += 1;
          continue;
        }
        if (next instanceof PDFArray) {
          next.asArray().forEach((value, k) => map.set(first + k, numberOf(context, value) ?? 0));
          index += 2;
        } else if (next instanceof PDFNumber && list[index + 2] instanceof PDFNumber) {
          ranges.push([first, next.asNumber(), list[index + 2].asNumber()]);
          index += 3;
        } else index += 1;
      }
      return { map, ranges };
    };
    const readCidToGid = () => {
      const value = resolve(context, descendant.get(N("CIDToGIDMap")));
      if (value instanceof PDFName) return value.decodeText();
      if (value instanceof PDFStream) return () => decodeStreamBytes(context, value);
      return null;
    };
    out.descendant = descendant ? {
      subtype: nameOf(context, descendant.get(N("Subtype"))),
      defaultWidth: numberOf(context, descendant.get(N("DW"))) ?? 1000,
      cidToGidMap: readCidToGid(),
      widths: readWidths()
    } : null;
    out.widthOfCid = (cid) => {
      const info = out.descendant;
      if (!info) return 1000;
      if (info.widths.map.has(cid)) return info.widths.map.get(cid);
      for (const [low, high, width] of info.widths.ranges) if (cid >= low && cid <= high) return width;
      return info.defaultWidth;
    };
  } else {
    const firstChar = numberOf(context, font.get(N("FirstChar"))) ?? 0;
    const widths = arrayOf(context, font.get(N("Widths")));
    const list = widths ? widths.asArray().map((value) => numberOf(context, value) ?? 0) : null;
    const descriptor = dictOf(context, font.get(N("FontDescriptor")));
    const missing = descriptor ? numberOf(context, descriptor.get(N("MissingWidth"))) ?? 0 : 0;
    out.firstChar = firstChar;
    out.widths = list;
    out.widthOfCode = (code) => (list && code >= firstChar && code - firstChar < list.length ? list[code - firstChar] : (list ? missing : undefined));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// graphics-state isolation
// ---------------------------------------------------------------------------------------------------

const isolated = new WeakMap(); // page node -> { pre, post, analysis }

/**
 * A copy of the content in which every Q that has nothing to restore is blanked (spaces of the same
 * length), or null when there is none. A viewer IGNORES such a Q: the matrix, the colours and the clip that
 * were set before it stay in force for the rest of the page.
 */
function withoutStrayRestores(bytes, operations) {
  let copy = null;
  let depth = 0;
  for (const operation of operations) {
    if (operation.op === "q") depth += 1;
    else if (operation.op === "Q") {
      if (depth > 0) depth -= 1;
      else {
        if (!copy) copy = bytes.slice();
        copy.fill(0x20, operation.start, operation.end);
      }
    }
  }
  return copy;
}

/** What closes everything the content left open: "ET"?, "EMC" x n, "EX" x n, "Q" x `restores`. */
function closingOperators(analysis, restores) {
  const tail = [];
  if (analysis.inText) tail.push("ET");
  for (let count = 0; count < analysis.openMarkedContent; count += 1) tail.push("EMC");
  for (let count = 0; count < analysis.openCompatibility; count += 1) tail.push("EX");
  for (let count = 0; count < restores; count += 1) tail.push("Q");
  return tail.join(" ");
}

/**
 * Makes sure that whatever is drawn AFTER the existing content starts from the default graphics state
 * (identity CTM, no clip, default colours, no open text object ...), whatever the existing content does:
 * it may change the CTM without q/Q (pdfkit, Chrome and many others start a page with a flip matrix), leave
 * a q open, or contain more Q than q.
 *
 * The page's /Contents becomes [ pre, ...existing streams, post ] with
 *   pre  = "q"
 *   post = "ET"? "EMC" x open marked content, "EX"?, "Q" x (1 + unclosed q)
 * The existing streams are not touched (they may be shared with other pages). Idempotent.
 *
 * A Q WITHOUT a q is the one case in which the existing streams cannot stay as they are. A viewer ignores a
 * Q that has nothing to restore, so the matrix and the colours set before it apply to the rest of the page.
 * Inside ANY wrapper the same Q would restore the wrapper's state instead, and the rest of the page would
 * land somewhere else (more q in front do not help: each stray Q then undoes what the content set before
 * it). Such a page gets its own copy of the content, in one stream, with those operators blanked: the page
 * then looks as the viewer showed it, in every viewer (the ones that do restore at a stray Q showed the
 * source differently in the first place).
 *
 * When the content cannot be decoded or tokenized, the page is wrapped as if it were balanced and
 * `unreadable` is true: the caller reports it (what is drawn may then land in the wrong place).
 *
 * @returns {{ wrapped: boolean, analysis: object, problems: string[], unreadable: boolean }}
 *          analysis: analyseBalance() of the content as it is on the page afterwards (`strayRestores` = how
 *          many Q were blanked)
 */
export function isolatePageContent(page) {
  const node = page.node;
  const { context } = node;
  const entries = pageContentEntries(page);
  const done = isolated.get(node);
  if (done && entries[0] === done.pre && entries.includes(done.post)) return { wrapped: false, analysis: done.analysis, problems: [], unreadable: false };
  // this function wraps exactly; the library's own single q ... Q (two streams shared by all pages) is not needed
  if ("autoNormalizeCTM" in node) node.autoNormalizeCTM = false;
  if (!entries.length) {
    node.set(N("Contents"), context.obj([]));
    return { wrapped: false, analysis: { ...analyseBalance([]), strayRestores: 0 }, problems: [], unreadable: false };
  }
  // an entry the parser could not read stays on the page, but nothing is known about what it does
  let unreadable = entries.length !== pageContentRefs(page).length;
  let parsed;
  let bytes = null;
  try {
    bytes = getPageContentBytes(page);
    parsed = tokenizeContent(bytes);
  } catch (error) {
    parsed = { operations: [], problems: [`the content cannot be decoded: ${error.message}`] };
    unreadable = true;
  }
  const { operations, problems } = parsed;
  let analysis = analyseBalance(operations);
  let content = entries;
  let strayRestores = 0;
  if (analysis.underflow > 0 && bytes && !unreadable && problems.length === 0) {
    const copy = withoutStrayRestores(bytes, operations);
    strayRestores = analysis.underflow;
    content = [context.register(context.flateStream(copy))];
    analysis = analyseBalance(tokenizeContent(copy).operations);
  }
  analysis = { ...analysis, strayRestores };
  // a Q that could not be blanked (unreadable content) still needs a q to pop: the old, imperfect wrapper
  const opens = 1 + analysis.underflow;
  const pre = context.register(context.stream(`${"q ".repeat(opens).trim()}\n`));
  const post = context.register(context.stream(`\n${closingOperators(analysis, opens + analysis.endDepth)}\n`));
  node.set(N("Contents"), context.obj([pre, ...content, post]));
  isolated.set(node, { pre, post, analysis });
  return { wrapped: true, analysis, problems, unreadable: unreadable || problems.length > 0 };
}

/**
 * A page whose resource dictionary the parser could not read (PDFInvalidObject: it travels as raw bytes, see
 * rawObjects.js) cannot be given a font, a picture or a graphics state: nothing can be added to raw bytes.
 * The content of such a page moves into ONE form XObject that keeps the unread dictionary, and the page gets
 * a fresh dictionary that names only that form. What the page shows stays the same; what is drawn on it
 * afterwards finds a dictionary it can add to.
 *
 * @returns {{ changed: boolean, unreadable: boolean }}  unreadable: the content could not be tokenized, so
 *          what it leaves open inside the form is not known
 */
export function ensureWritableResources(page) {
  const node = page.node;
  const { context } = node;
  const value = node.getInheritableAttribute(N("Resources"));
  if (!(value instanceof PDFRef) || !(context.lookup(value) instanceof PDFInvalidObject)) return { changed: false, unreadable: false };
  if (pageContentEntries(page).length !== pageContentRefs(page).length) throw new Error("a page with an unparsed resource dictionary and an unparsed content stream cannot be drawn on");
  let bytes = getPageContentBytes(page);
  const { operations, problems } = tokenizeContent(bytes);
  if (!problems.length) {
    // a form must leave nothing open and restore nothing it did not save (a viewer saves once around it)
    bytes = withoutStrayRestores(bytes, operations) || bytes;
    const analysis = analyseBalance(tokenizeContent(bytes).operations);
    const tail = closingOperators(analysis, Math.max(0, analysis.endDepth));
    if (tail) bytes = joinChunks([bytes, new TextEncoder().encode(tail)]);
  }
  const media = arrayOf(context, node.getInheritableAttribute(N("MediaBox")));
  const numbers = media && media.size() === 4 ? media.asArray().map((item) => numberOf(context, item)) : [];
  const box = numbers.length === 4 && numbers.every(Number.isFinite)
    ? [Math.min(numbers[0], numbers[2]), Math.min(numbers[1], numbers[3]), Math.max(numbers[0], numbers[2]), Math.max(numbers[1], numbers[3])]
    : [0, 0, 612, 792];
  const form = context.flateStream(bytes, { Type: "XObject", Subtype: "Form", BBox: box });
  form.dict.set(N("Resources"), value);
  const formRef = context.register(form);
  node.set(N("Contents"), context.obj([context.register(context.stream("/PdfxPage Do\n"))]));
  node.set(N("Resources"), context.obj({ XObject: { PdfxPage: formRef } }));
  if ("contentStream" in page) {
    page.contentStream = undefined;
    page.contentStreamRef = undefined;
  }
  return { changed: true, unreadable: problems.length > 0 };
}
