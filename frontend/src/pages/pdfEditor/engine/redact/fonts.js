// Glyph advances from PDF font dictionaries (no font program is parsed): what the remover needs to know where
// every glyph of a text-showing operation sits. The verifier does NOT use this module: it takes its glyph
// boxes from pdf.js (pdfjsGlyphs.js), so a wrong width here shows up as a failed verification, not as a leak.
//
// loadFont(fontDict) -> FontInfo
//   kind            "simple" | "type3" | "type0" | "unknown"
//   measurable      true when every code of a string can be split AND given an advance width
//   reason          why not, when measurable is false (English, for logs; the caller falls back)
//   codeLengths     true when strings can at least be split into codes (number of glyphs is known)
//   vertical        writing mode 1
//   ascent/descent  vertical extent of the glyph box in units of the font size (em box of the descriptor)
//   decode(bytes)   -> [{ start, length, code, cid, w0, w1, vx, vy, space }] or throws FontDecodeError
//                      w0 = horizontal advance, w1 = vertical advance (negative = downwards), (vx, vy) = position
//                      vector of the vertical origin; all in units of the font size.
//                      space = true for the single-byte code 32 (the only code word spacing applies to, 9.3.3)
//
// Supported: Type1 / MMType1 / TrueType with /Widths (FirstChar, MissingWidth); the 14 standard fonts
// without /Widths (metrics by glyph name through the base encoding and /Differences); Type3 (/Widths scaled
// by /FontMatrix); Type0 with Identity-H / Identity-V or an embedded CMap (codespace ranges, cidrange,
// cidchar, usecmap of an identity CMap), /W /DW /W2 /DW2. Predefined CMaps are not loaded: the pure 2-byte
// ones give the code length only, and their fonts are measurable only when /W is empty (every glyph is /DW).
import { createTokenReader } from "./contentStream.js";
import { A as ACCESS } from "./pdfAccess.js";
import { ENCODINGS, STANDARD_FONT_ALIASES, STANDARD_BASIC_METRICS, standardWidths } from "./stdFontData.js";

export class FontDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "FontDecodeError";
  }
}

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;

/** Predefined CMaps whose codes are all 2 bytes long (ISO 32000-1 Table 118; CMap resources of Adobe). */
const TWO_BYTE_PREDEFINED = new Set([
  "GB-H", "GB-V", "GBT-H", "GBT-V", "UniGB-UCS2-H", "UniGB-UCS2-V", "B5-H", "B5-V", "ETen-B5-H", "ETen-B5-V", "CNS1-H", "CNS1-V", "CNS2-H", "CNS2-V",
  "UniCNS-UCS2-H", "UniCNS-UCS2-V", "H", "V", "90pv-RKSJ-UCS2", "90ms-RKSJ-UCS2", "Ext-H", "Ext-V", "Add-H", "Add-V", "NWP-H", "NWP-V",
  "UniJIS-UCS2-H", "UniJIS-UCS2-V", "UniJIS-UCS2-HW-H", "UniJIS-UCS2-HW-V", "KSC-H", "KSC-V", "KSC-Johab-H", "KSC-Johab-V",
  "UniKS-UCS2-H", "UniKS-UCS2-V", "Adobe-Japan1-UCS2", "Adobe-GB1-UCS2", "Adobe-CNS1-UCS2", "Adobe-Korea1-UCS2"
]);

function normalizeFontName(name) {
  return name.replace(/[,_]/g, "-").replace(/\s/g, "");
}

function saneMetrics(ascent, descent) {
  let a = Number.isFinite(ascent) ? ascent : NaN;
  let d = Number.isFinite(descent) ? descent : NaN;
  if (d > 0) d = -d;
  if (!(a > 0.3 && a <= 1.6)) a = NaN;
  if (!(d < -0.02 && d >= -0.8)) d = NaN;
  return [a, d];
}

function descriptorMetrics(descriptor, A) {
  if (!A.isDict(descriptor)) return [NaN, NaN];
  let [a, d] = saneMetrics(A.getNum(descriptor, "Ascent") / 1000, A.getNum(descriptor, "Descent") / 1000);
  const bbox = A.numArray(A.get(descriptor, "FontBBox"), 4);
  if (bbox) {
    const [ba, bd] = saneMetrics(bbox[3] / 1000, bbox[1] / 1000);
    if (Number.isNaN(a)) a = ba;
    if (Number.isNaN(d)) d = bd;
  }
  return [a, d];
}

// ---------------------------------------------------------------- simple fonts
function baseEncodingFor(fontDict, stdName, A) {
  const enc = A.get(fontDict, "Encoding");
  let baseName = null;
  let differences = null;
  if (A.isName(enc)) baseName = A.nameOf(enc);
  else if (A.isDict(enc)) {
    baseName = A.getName(enc, "BaseEncoding") ?? null;
    const diff = A.get(enc, "Differences");
    if (A.isArray(diff)) {
      differences = new Map();
      let code = 0;
      for (let i = 0; i < diff.size(); i++) {
        const el = diff.lookup(i);
        if (A.isNumber(el)) code = el.asNumber();
        else if (A.isName(el)) differences.set(code++, A.nameOf(el));
        else throw new FontDecodeError("bad /Differences array");
      }
    }
  }
  let table;
  if (baseName === "WinAnsiEncoding" || baseName === "MacRomanEncoding" || baseName === "MacExpertEncoding") table = ENCODINGS[baseName];
  else if (stdName === "Symbol") table = ENCODINGS.SymbolSetEncoding;
  else if (stdName === "ZapfDingbats") table = ENCODINGS.ZapfDingbatsEncoding;
  else table = ENCODINGS.StandardEncoding;
  return { table, differences };
}

function loadSimple(fontDict, subtype, A) {
  const descriptor = A.get(fontDict, "FontDescriptor");
  const baseFont = A.getName(fontDict, "BaseFont") ?? "";
  const widthsArr = A.get(fontDict, "Widths");
  const widths = new Float64Array(256).fill(NaN);
  let missing = 0;
  let [ascent, descent] = descriptorMetrics(descriptor, A);
  let reason = null;
  if (A.isArray(widthsArr)) {
    const first = A.getNum(fontDict, "FirstChar") ?? 0;
    for (let i = 0; i < widthsArr.size(); i++) {
      const w = A.num(widthsArr.lookup(i));
      const code = first + i;
      if (w !== undefined && code >= 0 && code < 256) widths[code] = w / 1000;
    }
    missing = (A.getNum(descriptor, "MissingWidth") ?? 0) / 1000;
  } else {
    const stdName = STANDARD_FONT_ALIASES[normalizeFontName(baseFont)];
    if (!stdName) reason = `simple font "${baseFont}" has no /Widths and is not one of the 14 standard fonts`;
    else {
      const table = standardWidths(stdName);
      if (typeof table === "number") {
        missing = table / 1000; // monospaced: every code has the same width (pdf.js: defaultWidth)
      } else {
        const { table: encoding, differences } = baseEncodingFor(fontDict, stdName, A);
        for (let code = 0; code < 256; code++) {
          const w = (differences?.has(code) && table[differences.get(code)]) || (encoding[code] && table[encoding[code]]);
          if (w) widths[code] = w / 1000;
        }
      }
      const basic = STANDARD_BASIC_METRICS[stdName];
      if (Number.isNaN(ascent)) ascent = basic.ascent / 1000;
      if (Number.isNaN(descent)) descent = basic.descent / 1000;
    }
  }
  return {
    kind: "simple",
    subtype,
    name: baseFont,
    measurable: reason === null,
    codeLengths: true,
    reason,
    vertical: false,
    ascent: Number.isNaN(ascent) ? DEFAULT_ASCENT : ascent,
    descent: Number.isNaN(descent) ? DEFAULT_DESCENT : descent,
    decode(bytes) {
      const out = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        const code = bytes[i];
        const w = widths[code];
        out[i] = { start: i, length: 1, code, cid: code, w0: Number.isNaN(w) ? missing : w, space: code === 32 };
      }
      return out;
    }
  };
}

function loadType3(fontDict, A) {
  const fm = A.numArray(A.get(fontDict, "FontMatrix"), 6);
  const widthsArr = A.get(fontDict, "Widths");
  const widths = new Float64Array(256).fill(0);
  let reason = null;
  if (!fm) reason = "Type3 font without a valid /FontMatrix";
  else if (!A.isArray(widthsArr)) reason = "Type3 font without /Widths";
  else {
    const first = A.getNum(fontDict, "FirstChar") ?? 0;
    for (let i = 0; i < widthsArr.size(); i++) {
      const w = A.num(widthsArr.lookup(i));
      const code = first + i;
      if (w !== undefined && code >= 0 && code < 256) widths[code] = w * fm[0];
    }
  }
  // glyph box: /FontBBox in glyph space scaled by the font matrix; an all-zero box means "unknown"
  let ascent = NaN;
  let descent = NaN;
  const bbox = A.numArray(A.get(fontDict, "FontBBox"), 4);
  if (fm && bbox && bbox[3] > bbox[1]) {
    const y0 = bbox[1] * fm[3];
    const y1 = bbox[3] * fm[3];
    ascent = Math.max(y0, y1);
    descent = Math.min(y0, y1);
    if (!(ascent > 0.05 && ascent <= 3)) ascent = NaN;
    if (!(descent <= 0 && descent >= -2)) descent = NaN;
  }
  return {
    kind: "type3",
    subtype: "Type3",
    name: A.getName(fontDict, "Name") ?? "",
    measurable: reason === null,
    codeLengths: true,
    reason,
    vertical: false,
    ascent: Number.isNaN(ascent) ? DEFAULT_ASCENT : ascent,
    descent: Number.isNaN(descent) ? DEFAULT_DESCENT : descent,
    hasCharProcs: A.isDict(A.get(fontDict, "CharProcs")),
    decode(bytes) {
      const out = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) out[i] = { start: i, length: 1, code: bytes[i], cid: bytes[i], w0: widths[bytes[i]], space: bytes[i] === 32 };
      return out;
    }
  };
}

// ---------------------------------------------------------------- CMaps
/**
 * Parses an embedded CMap program.
 * Returns { codespaces: [{ length, lo: [..], hi: [..] }], cidRanges: [{ length, lo, hi, cid }], cidChars: Map,
 *           useCMap: name | null, wmode: 0 | 1 | null }.
 * (lo / hi of a cid range are the codes as integers; ranges are only valid within one code length.)
 */
export function parseCMap(bytes) {
  const next = createTokenReader(bytes);
  const codespaces = [];
  const cidRanges = [];
  const cidChars = new Map();
  let useCMap = null;
  let wmode = null;
  let prev = null;
  let prev2 = null;
  const intOf = (hex) => {
    let v = 0;
    for (const b of hex) v = v * 256 + b;
    return v;
  };
  const expectHex = (t) => {
    if (!t || t.type !== "hex") throw new FontDecodeError("CMap: hex string expected");
    return t.value;
  };
  for (;;) {
    const t = next();
    if (t === null) break;
    if (t.type === "op") {
      if (t.value === "begincodespacerange") {
        for (;;) {
          const a = next();
          if (a && a.type === "op" && a.value === "endcodespacerange") break;
          const lo = expectHex(a);
          const hi = expectHex(next());
          if (lo.length !== hi.length || lo.length < 1 || lo.length > 4) throw new FontDecodeError("CMap: bad codespace range");
          codespaces.push({ length: lo.length, lo: Array.from(lo), hi: Array.from(hi) });
        }
      } else if (t.value === "begincidrange") {
        for (;;) {
          const a = next();
          if (a && a.type === "op" && a.value === "endcidrange") break;
          const lo = expectHex(a);
          const hi = expectHex(next());
          const c = next();
          if (!c || c.type !== "num" || lo.length !== hi.length) throw new FontDecodeError("CMap: bad cidrange");
          cidRanges.push({ length: lo.length, lo: intOf(lo), hi: intOf(hi), cid: c.value });
        }
      } else if (t.value === "begincidchar") {
        for (;;) {
          const a = next();
          if (a && a.type === "op" && a.value === "endcidchar") break;
          const code = expectHex(a);
          const c = next();
          if (!c || c.type !== "num") throw new FontDecodeError("CMap: bad cidchar");
          cidChars.set(`${code.length}:${intOf(code)}`, c.value);
        }
      } else if (t.value === "usecmap") {
        if (!prev || prev.type !== "name") throw new FontDecodeError("CMap: usecmap without a name");
        useCMap = prev.value;
      } else if (t.value === "def" && prev && prev.type === "num" && prev2 && prev2.type === "name" && prev2.value === "WMode") {
        wmode = prev.value === 1 ? 1 : 0;
      } else if (t.value === "beginnotdefrange" || t.value === "beginnotdefchar") {
        const endName = t.value.replace("begin", "end");
        for (;;) {
          const a = next();
          if (a === null) throw new FontDecodeError("CMap: unterminated notdef section");
          if (a.type === "op" && a.value === endName) break;
        }
      }
    }
    prev2 = prev;
    prev = t;
  }
  return { codespaces, cidRanges, cidChars, useCMap, wmode };
}

const IDENTITY_CODESPACE = [{ length: 2, lo: [0, 0], hi: [255, 255] }];

function makeCodeReader(codespaces) {
  // returns (bytes, pos) -> { length, code } or null when no codespace range matches
  const byLength = [[], [], [], [], []];
  for (const cs of codespaces) byLength[cs.length].push(cs);
  return (bytes, pos) => {
    for (let len = 1; len <= 4; len++) {
      if (!byLength[len].length || pos + len > bytes.length) continue;
      outer: for (const cs of byLength[len]) {
        let code = 0;
        for (let k = 0; k < len; k++) {
          const v = bytes[pos + k];
          if (v < cs.lo[k] || v > cs.hi[k]) continue outer;
          code = code * 256 + v;
        }
        return { length: len, code };
      }
    }
    return null;
  };
}

function parseW(arr, A) {
  // /W [ c [w1 w2 ...]  c_first c_last w ... ] -> Map cid -> width (1/1000)
  const map = new Map();
  if (!A.isArray(arr)) return map;
  const n = arr.size();
  let i = 0;
  while (i < n) {
    const first = A.num(arr.lookup(i));
    if (!Number.isInteger(first)) break;
    const second = arr.lookup(i + 1);
    if (A.isArray(second)) {
      for (let k = 0; k < second.size(); k++) {
        const w = A.num(second.lookup(k));
        if (w !== undefined) map.set(first + k, w);
      }
      i += 2;
    } else if (Number.isInteger(A.num(second))) {
      const last = A.num(second);
      const w = A.num(arr.lookup(i + 2));
      if (w !== undefined) {
        if (last - first > 70000) throw new FontDecodeError("/W range too large");
        for (let c = first; c <= last; c++) map.set(c, w);
      }
      i += 3;
    } else break;
  }
  return map;
}

function parseW2(arr, A) {
  // /W2 [ c [w1y vx vy ...]  c_first c_last w1y vx vy ... ] -> Map cid -> [w1, vx, vy] (1/1000)
  const map = new Map();
  if (!A.isArray(arr)) return map;
  const n = arr.size();
  let i = 0;
  while (i < n) {
    const first = A.num(arr.lookup(i));
    if (!Number.isInteger(first)) break;
    const second = arr.lookup(i + 1);
    if (A.isArray(second)) {
      for (let k = 0; k + 2 < second.size(); k += 3) {
        const v = [A.num(second.lookup(k)), A.num(second.lookup(k + 1)), A.num(second.lookup(k + 2))];
        if (v.every((x) => x !== undefined)) map.set(first + k / 3, v);
      }
      i += 2;
    } else if (Number.isInteger(A.num(second))) {
      const last = A.num(second);
      const v = [A.num(arr.lookup(i + 2)), A.num(arr.lookup(i + 3)), A.num(arr.lookup(i + 4))];
      if (v.every((x) => x !== undefined)) {
        if (last - first > 70000) throw new FontDecodeError("/W2 range too large");
        for (let c = first; c <= last; c++) map.set(c, v);
      }
      i += 5;
    } else break;
  }
  return map;
}

function loadType0(fontDict, A) {
  const baseFont = A.getName(fontDict, "BaseFont") ?? "";
  const result = { kind: "type0", subtype: "Type0", name: baseFont, measurable: false, codeLengths: false, reason: null, vertical: false, ascent: DEFAULT_ASCENT, descent: DEFAULT_DESCENT };
  const fail = (reason) => {
    result.reason = reason;
    result.decode = () => {
      throw new FontDecodeError(reason);
    };
    return result;
  };
  const descArr = A.get(fontDict, "DescendantFonts");
  const cidFont = A.isArray(descArr) ? descArr.lookup(0) : undefined;
  if (!A.isDict(cidFont)) return fail(`Type0 font "${baseFont}" without a descendant font`);

  // ---- encoding: code lengths and code -> CID
  const encoding = A.get(fontDict, "Encoding");
  let codespaces;
  let cidOf = null; // (length, code) -> cid | undefined
  if (A.isName(encoding)) {
    const name = A.nameOf(encoding);
    if (name === "Identity-H" || name === "Identity-V") {
      codespaces = IDENTITY_CODESPACE;
      cidOf = (len, code) => code;
      result.vertical = name === "Identity-V";
    } else if (TWO_BYTE_PREDEFINED.has(name)) {
      codespaces = IDENTITY_CODESPACE;
      cidOf = null; // the CMap data is not available: CIDs unknown
      result.vertical = name.endsWith("-V") || name === "V";
      result.predefined = name;
    } else {
      result.vertical = /-V$/.test(name);
      return fail(`Type0 font "${baseFont}" uses the predefined CMap ${name} (code lengths unknown without the CMap)`);
    }
  } else if (A.isStream(encoding)) {
    let cmap;
    try {
      cmap = parseCMap(A.streamBytes(encoding));
    } catch (err) {
      return fail(`Type0 font "${baseFont}": embedded CMap not understood (${err.message})`);
    }
    let use = cmap.useCMap;
    const useEntry = A.get(encoding.dict, "UseCMap");
    if (useEntry !== undefined) use = A.isName(useEntry) ? A.nameOf(useEntry) : "(stream)";
    let baseIdentity = false;
    if (use) {
      if (use === "Identity-H" || use === "Identity-V") baseIdentity = true;
      else return fail(`Type0 font "${baseFont}": embedded CMap uses ${use}`);
    }
    codespaces = cmap.codespaces.length ? cmap.codespaces : baseIdentity ? IDENTITY_CODESPACE : null;
    if (!codespaces) return fail(`Type0 font "${baseFont}": embedded CMap without codespace ranges`);
    const ranges = cmap.cidRanges;
    cidOf = (len, code) => {
      const direct = cmap.cidChars.get(`${len}:${code}`);
      if (direct !== undefined) return direct;
      for (const r of ranges) if (r.length === len && code >= r.lo && code <= r.hi) return r.cid + (code - r.lo);
      return baseIdentity && len === 2 ? code : undefined;
    };
    const wm = A.getNum(encoding.dict, "WMode") ?? cmap.wmode ?? (use === "Identity-V" ? 1 : 0);
    result.vertical = wm === 1;
  } else {
    return fail(`Type0 font "${baseFont}" has no usable /Encoding`);
  }
  result.codeLengths = true;
  const readCode = makeCodeReader(codespaces);

  // ---- widths
  let dw;
  let wMap;
  let dw2;
  let w2Map;
  try {
    dw = A.getNum(cidFont, "DW") ?? 1000;
    wMap = parseW(A.get(cidFont, "W"), A);
    dw2 = A.numArray(A.get(cidFont, "DW2"), 2) ?? [880, -1000];
    w2Map = result.vertical ? parseW2(A.get(cidFont, "W2"), A) : new Map();
  } catch (err) {
    return fail(`Type0 font "${baseFont}": ${err.message}`);
  }
  const descriptor = A.get(cidFont, "FontDescriptor");
  const [a, d] = descriptorMetrics(descriptor, A);
  if (!Number.isNaN(a)) result.ascent = a;
  if (!Number.isNaN(d)) result.descent = d;

  const cidsKnown = cidOf !== null;
  const uniform = wMap.size === 0 && w2Map.size === 0; // every glyph has the default metrics
  if (!cidsKnown && !uniform) {
    result.reason = `Type0 font "${baseFont}" uses the predefined CMap ${result.predefined} and has a /W array (CIDs unknown without the CMap)`;
  } else {
    result.measurable = true;
  }
  const oneByteSpace = codespaces.some((cs) => cs.length === 1 && cs.lo[0] <= 32 && cs.hi[0] >= 32);
  result.decode = (bytes) => {
    const out = [];
    let pos = 0;
    while (pos < bytes.length) {
      const r = readCode(bytes, pos);
      if (!r) throw new FontDecodeError(`code at byte ${pos} is outside the codespace ranges of "${baseFont}"`);
      const cid = cidsKnown ? cidOf(r.length, r.code) : undefined;
      // an unmapped code shows the glyph of the notdef range: CID 0 (ISO 32000-1 9.7.6.3)
      const effCid = cid ?? 0;
      const w0 = (wMap.get(effCid) ?? dw) / 1000;
      const g = { start: pos, length: r.length, code: r.code, cid: effCid, w0, space: oneByteSpace && r.length === 1 && r.code === 32 };
      if (result.vertical) {
        const v = w2Map.get(effCid);
        g.w1 = (v ? v[0] : dw2[1]) / 1000;
        g.vx = v ? v[1] / 1000 : w0 / 2;
        g.vy = (v ? v[2] : dw2[0]) / 1000;
      }
      out.push(g);
      pos += r.length;
    }
    return out;
  };
  return result;
}

/**
 * FontInfo for a font dictionary (a PDFDict of the library). Never throws for an unsupported font: the result
 * then has measurable = false and a reason; decode() throws FontDecodeError.
 */
export function loadFont(fontDict, A = ACCESS) {
  const unsupported = (reason) => ({
    kind: "unknown", subtype: null, name: "", measurable: false, codeLengths: false, reason, vertical: false, ascent: DEFAULT_ASCENT, descent: DEFAULT_DESCENT,
    decode() {
      throw new FontDecodeError(reason);
    }
  });
  if (!A.isDict(fontDict)) return unsupported("font resource is not a dictionary");
  const subtype = A.getName(fontDict, "Subtype");
  try {
    if (subtype === "Type0") return loadType0(fontDict, A);
    if (subtype === "Type3") return loadType3(fontDict, A);
    if (subtype === "Type1" || subtype === "MMType1" || subtype === "TrueType") return loadSimple(fontDict, subtype, A);
  } catch (err) {
    return unsupported(`font dictionary not understood: ${err.message}`);
  }
  return unsupported(`font subtype ${subtype ?? "(none)"} is not supported`);
}
