// Document-level odds and ends of the rebuilt output: Info, XMP, /ID, language, viewer preferences, the base
// of relative link addresses, page labels, optional content (layers), attachments.
//
// Document information travels as plain data with the keys of model/schema.js:
//   { title?, author?, subject?, keywords?, creator?, producer?, creationDate?: Date, modDate?: Date }
import { pdfLib } from "../lib.js";
import { escapeLiteral } from "./outline.js";
import { N, dictOf, arrayOf, nameOf, numberOf, textOf, textString, readNumberTree, readNameTree, resolve, isString } from "./pdfUtil.js";

const { PDFRef, PDFDict, PDFName, PDFNumber, PDFHexString, PDFString, PDFBool } = pdfLib;

export const DEFAULT_PRODUCER = "ANS PDF Editor";

const INFO_TEXT_KEYS = Object.freeze({ title: "Title", author: "Author", subject: "Subject", keywords: "Keywords", creator: "Creator", producer: "Producer" });
const isDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

// ---------------------------------------------------------------------------------------------------
// Info dictionary and XMP
// ---------------------------------------------------------------------------------------------------

/** Reads the Info dictionary of a source as plain data (never throws on odd value types). */
export function readInfo(srcDoc) {
  const { context } = srcDoc;
  const info = dictOf(context, context.trailerInfo.Info);
  const out = {};
  if (!info) return out;
  for (const [key, pdfKey] of Object.entries(INFO_TEXT_KEYS)) {
    const value = textOf(context, info.get(N(pdfKey)));
    if (value !== undefined) out[key] = value;
  }
  for (const [key, pdfKey] of [["creationDate", "CreationDate"], ["modDate", "ModDate"]]) {
    const raw = resolve(context, info.get(N(pdfKey)));
    if (isString(raw)) {
      try {
        const date = raw.decodeDate();
        if (isDate(date)) out[key] = date;
      } catch {
        /* unparsable date: dropped */
      }
    }
  }
  return out;
}

/**
 * Writes a fresh Info dictionary. Text values become UTF-16BE strings; custom keys of a source are NOT carried.
 * @param {{ title?: string, author?: string, subject?: string, keywords?: string, creator?: string, creationDate?: Date }} info
 * @param {{ producer?: string, now?: Date }} [options]
 */
export function writeInfo(outDoc, info, { producer = DEFAULT_PRODUCER, now = new Date() } = {}) {
  const { context } = outDoc;
  const dict = context.obj({});
  for (const key of ["title", "author", "subject", "keywords", "creator"]) {
    if (typeof info[key] === "string" && info[key] !== "") dict.set(N(INFO_TEXT_KEYS[key]), textString(info[key]));
  }
  dict.set(N("Producer"), textString(producer));
  dict.set(N("CreationDate"), PDFString.fromDate(isDate(info.creationDate) ? info.creationDate : now));
  dict.set(N("ModDate"), PDFString.fromDate(now));
  context.trailerInfo.Info = context.register(dict);
  return dict;
}

/** XML text: the five entities, and without the characters XML 1.0 cannot carry at all. */
function xmlEscape(text) {
  let out = "";
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0xfffe || code === 0xffff || (code >= 0xd800 && code <= 0xdfff)) continue;
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === "\"") out += "&quot;";
    else out += char;
  }
  return out;
}

/**
 * A minimal XMP packet that says the same as the Info dictionary (ISO 32000-1 14.3.2).
 * The XMP of a source is never copied: it describes another file (document ids, history with paths and
 * user names, the old dates) and a viewer prefers its dc:title over the Info title.
 */
export function buildXmp(info, { producer = DEFAULT_PRODUCER, now = new Date() } = {}) {
  const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const created = isDate(info.creationDate) ? info.creationDate : now;
  const parts = [];
  if (info.title) parts.push(`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(info.title)}</rdf:li></rdf:Alt></dc:title>`);
  if (info.author) parts.push(`<dc:creator><rdf:Seq><rdf:li>${xmlEscape(info.author)}</rdf:li></rdf:Seq></dc:creator>`);
  if (info.subject) parts.push(`<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(info.subject)}</rdf:li></rdf:Alt></dc:description>`);
  if (info.keywords) parts.push(`<pdf:Keywords>${xmlEscape(info.keywords)}</pdf:Keywords>`);
  if (info.creator) parts.push(`<xmp:CreatorTool>${xmlEscape(info.creator)}</xmp:CreatorTool>`);
  parts.push(`<pdf:Producer>${xmlEscape(producer)}</pdf:Producer>`);
  parts.push(`<xmp:CreateDate>${iso(created)}</xmp:CreateDate>`);
  parts.push(`<xmp:ModifyDate>${iso(now)}</xmp:ModifyDate>`);
  parts.push(`<xmp:MetadataDate>${iso(now)}</xmp:MetadataDate>`);
  // the byte order mark of the packet header, built from its code so that the source holds no invisible character
  const bom = String.fromCharCode(0xfeff);
  return `<?xpacket begin="${bom}" id="W5M0MpCehiHzreSzNTczkc9d"?>\n`
    + "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">"
    + "<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\">"
    + parts.join("")
    + "</rdf:Description></rdf:RDF></x:xmpmeta>\n"
    + "<?xpacket end=\"w\"?>";
}

export function writeXmp(outDoc, info, options) {
  const { context, catalog } = outDoc;
  const xml = new TextEncoder().encode(buildXmp(info, options));
  // uncompressed on purpose: metadata is meant to be readable without a PDF parser
  catalog.set(N("Metadata"), context.register(context.stream(xml, { Type: "Metadata", Subtype: "XML" })));
}

/**
 * Trailer /ID (two identical 16-byte strings for a new file). The library writes none for a created
 * document; a signature revision, encryption and PDF 2.0 want one.
 * @param {Uint8Array} [seed] deterministic id (its first 16 bytes); random otherwise
 * @returns {string} the id in hexadecimal
 */
export function setDocumentId(outDoc, seed) {
  const bytes = new Uint8Array(16);
  if (seed instanceof Uint8Array && seed.length) bytes.set(seed.subarray(0, 16));
  else globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  const { context } = outDoc;
  const id = context.obj([]);
  id.push(PDFHexString.of(hex));
  id.push(PDFHexString.of(hex));
  context.trailerInfo.ID = id;
  return hex;
}

// ---------------------------------------------------------------------------------------------------
// Catalog settings
// ---------------------------------------------------------------------------------------------------

const VIEWER_PREF_KEYS = ["HideToolbar", "HideMenubar", "HideWindowUI", "FitWindow", "CenterWindow", "DisplayDocTitle",
  "NonFullScreenPageMode", "Direction", "PrintScaling", "Duplex", "PickTrayByPDFSize", "NumCopies"];

/**
 * The base that relative link addresses of a document are resolved against (catalog /URI << /Base >>), and
 * the address itself resolved against it. An address with a scheme of its own is absolute and stays as it is.
 */
export function resolveUri(uri, base) {
  if (!uri || !base || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) return uri;
  try {
    return new URL(uri, base).href;
  } catch {
    return uri; // a base that is no address: nothing to resolve against
  }
}

/** Lang, PageLayout, PageMode, ViewerPreferences and the /URI base of a pristine source as plain data. */
export function readCatalogSettings(srcDoc) {
  const { context, catalog } = srcDoc;
  const out = {};
  const lang = textOf(context, catalog.get(N("Lang")));
  if (lang) out.lang = lang;
  const uriBase = textOf(context, dictOf(context, catalog.get(N("URI")))?.get(N("Base")));
  if (uriBase) out.uriBase = uriBase;
  const layout = nameOf(context, catalog.get(N("PageLayout")));
  if (layout) out.pageLayout = layout;
  const mode = nameOf(context, catalog.get(N("PageMode")));
  if (mode) out.pageMode = mode;
  const prefs = dictOf(context, catalog.get(N("ViewerPreferences")));
  if (prefs) {
    out.viewerPreferences = {};
    for (const key of VIEWER_PREF_KEYS) {
      const value = resolve(context, prefs.get(N(key)));
      if (value instanceof PDFBool) out.viewerPreferences[key] = value.asBoolean();
      else if (value instanceof PDFName) out.viewerPreferences[key] = { name: value.decodeText() };
      else if (value instanceof PDFNumber) out.viewerPreferences[key] = value.asNumber();
    }
  }
  return out;
}

/**
 * @param {{ lang?: string, pageLayout?: string, pageMode?: string, viewerPreferences?: object, uriBase?: string }} settings
 * @param {{ hasOutline?: boolean }} [facts]  /PageMode /UseOutlines makes no sense without an outline
 */
export function writeCatalogSettings(outDoc, settings, { hasOutline = true } = {}) {
  const { context, catalog } = outDoc;
  if (settings.lang) catalog.set(N("Lang"), PDFString.of(settings.lang.replace(/[()\\]/g, "")));
  // without it every relative link address of the copied pages would lead somewhere else
  if (settings.uriBase) {
    const base = context.obj({});
    base.set(N("Base"), PDFString.of(escapeLiteral(settings.uriBase))); // an address is ASCII, not a text string
    catalog.set(N("URI"), base);
  }
  if (settings.pageLayout) catalog.set(N("PageLayout"), N(settings.pageLayout));
  if (settings.pageMode && !(settings.pageMode === "UseOutlines" && !hasOutline) && settings.pageMode !== "UseThumbs") {
    catalog.set(N("PageMode"), N(settings.pageMode));
  }
  if (settings.viewerPreferences && Object.keys(settings.viewerPreferences).length) {
    const dict = context.obj({});
    for (const [key, value] of Object.entries(settings.viewerPreferences)) {
      if (typeof value === "boolean") dict.set(N(key), value ? PDFBool.True : PDFBool.False);
      else if (typeof value === "number") dict.set(N(key), PDFNumber.of(value));
      else if (value && value.name) dict.set(N(key), N(value.name));
    }
    catalog.set(N("ViewerPreferences"), dict);
  }
}

// ---------------------------------------------------------------------------------------------------
// Page labels
// ---------------------------------------------------------------------------------------------------

/**
 * The label of every page of a pristine source as { style, prefix, value }: style = "D" | "r" | "R" | "a" | "A" | null.
 * Returns null when the document has no /PageLabels.
 */
export function readPageLabels(srcDoc) {
  const { context, catalog } = srcDoc;
  const root = catalog.get(N("PageLabels"));
  if (!root) return null;
  const tree = readNumberTree(context, root);
  if (!tree.size) return null;
  const starts = [...tree.keys()].sort((a, b) => a - b);
  const count = srcDoc.getPageCount();
  const labels = [];
  let rangeIndex = -1;
  let current = { style: "D", prefix: "", start: 1, from: 0 };
  for (let page = 0; page < count; page += 1) {
    while (rangeIndex + 1 < starts.length && starts[rangeIndex + 1] <= page) {
      rangeIndex += 1;
      const dict = dictOf(context, tree.get(starts[rangeIndex]));
      current = {
        style: dict ? nameOf(context, dict.get(N("S"))) ?? null : null,
        prefix: dict ? textOf(context, dict.get(N("P"))) ?? "" : "",
        start: dict ? numberOf(context, dict.get(N("St"))) ?? 1 : 1,
        from: starts[rangeIndex]
      };
    }
    labels.push(rangeIndex < 0 ? { style: "D", prefix: "", value: page + 1 } : { style: current.style, prefix: current.prefix, value: current.start + (page - current.from) });
  }
  return labels;
}

/**
 * Writes /PageLabels for the output from one label per output page (null = plain decimal page number of the
 * output). Consecutive pages whose numbers continue share a range.
 * @param {Array<{ style: string | null, prefix: string, value: number } | null>} labels
 * @returns {number} the number of ranges written
 */
export function writePageLabels(outDoc, labels) {
  const { context, catalog } = outDoc;
  if (!labels.some(Boolean)) {
    catalog.delete(N("PageLabels"));
    return 0;
  }
  const nums = context.obj([]);
  let ranges = 0;
  let previous = null;
  labels.forEach((given, index) => {
    const label = given || { style: "D", prefix: "", value: index + 1 };
    const continues = previous && previous.style === label.style && previous.prefix === label.prefix && label.value === previous.value + 1;
    if (!continues) {
      const dict = context.obj({});
      if (label.style) dict.set(N("S"), N(label.style));
      if (label.prefix) dict.set(N("P"), textString(label.prefix));
      if (label.value !== 1) dict.set(N("St"), PDFNumber.of(label.value));
      nums.push(PDFNumber.of(index));
      nums.push(dict);
      ranges += 1;
    }
    previous = label;
  });
  const tree = context.obj({});
  tree.set(N("Nums"), nums);
  catalog.set(N("PageLabels"), tree);
  return ranges;
}

// ---------------------------------------------------------------------------------------------------
// Optional content (layers)
// ---------------------------------------------------------------------------------------------------

/**
 * Carries the layer configuration over for the optional content groups that the copied pages use.
 * Without it every group is ON in the output: content that was hidden in the source becomes visible.
 *
 * @param {Array<{ srcDoc: any, copier: any }>} sources
 * @returns {{ groups: number, off: number }}
 */
export function rebuildOptionalContent(outDoc, sources) {
  const { context, catalog } = outDoc;
  const groups = context.obj([]);
  const off = context.obj([]);
  const order = context.obj([]);
  const locked = context.obj([]);
  for (const { srcDoc, copier } of sources) {
    const srcContext = srcDoc.context;
    const props = dictOf(srcContext, srcDoc.catalog.get(N("OCProperties")));
    if (!props) continue;
    const map = copier.traversedObjects;
    const config = dictOf(srcContext, props.get(N("D")));
    const baseState = config ? nameOf(srcContext, config.get(N("BaseState"))) ?? "ON" : "ON";
    const listed = (key) => new Set(config ? arrayOf(srcContext, config.get(N(key)))?.asArray() ?? [] : []);
    const onSet = listed("ON");
    const offSet = listed("OFF");
    const lockedSet = listed("Locked");
    for (const groupRef of arrayOf(srcContext, props.get(N("OCGs")))?.asArray() ?? []) {
      if (!(groupRef instanceof PDFRef)) continue;
      const mapped = map.get(groupRef); // only groups that a copied page (or annotation) really uses
      if (!(mapped instanceof PDFRef) || !(context.lookup(mapped) instanceof PDFDict)) continue;
      groups.push(mapped);
      order.push(mapped);
      const visible = offSet.has(groupRef) ? false : onSet.has(groupRef) ? true : baseState !== "OFF";
      if (!visible) off.push(mapped);
      if (lockedSet.has(groupRef)) locked.push(mapped);
    }
  }
  if (groups.size() === 0) {
    catalog.delete(N("OCProperties"));
    return { groups: 0, off: 0 };
  }
  const config = context.obj({ BaseState: "ON" });
  config.set(N("Order"), order); // flat: nested layer groups and their labels are not reproduced
  if (off.size()) config.set(N("OFF"), off);
  if (locked.size()) config.set(N("Locked"), locked);
  const props = context.obj({});
  props.set(N("OCGs"), groups);
  props.set(N("D"), config);
  catalog.set(N("OCProperties"), props);
  return { groups: groups.size(), off: off.size() };
}

// ---------------------------------------------------------------------------------------------------
// Attachments (document level)
// ---------------------------------------------------------------------------------------------------

/** The document-level embedded files of a pristine source: [{ key, fileName, size }] */
export function listAttachments(srcDoc) {
  const { context, catalog } = srcDoc;
  const names = dictOf(context, catalog.get(N("Names")));
  if (!names || !names.get(N("EmbeddedFiles"))) return [];
  const out = [];
  for (const [key, value] of readNameTree(context, names.get(N("EmbeddedFiles")))) {
    const spec = dictOf(context, value);
    if (!spec) continue;
    const files = dictOf(context, spec.get(N("EF")));
    const stream = files ? resolve(context, files.get(N("UF")) ?? files.get(N("F"))) : undefined;
    out.push({
      key,
      fileName: textOf(context, spec.get(N("UF"))) ?? textOf(context, spec.get(N("F"))) ?? key,
      size: stream && stream.contents ? stream.contents.length : undefined
    });
  }
  return out;
}

/**
 * Copies the document-level attachments of the sources into the output (a product decision: attachments are
 * not tied to pages, so "the pages I kept" says nothing about them: ask the user).
 * @param {Array<{ srcDoc: any, copier: any, only?: (key: string) => boolean }>} sources
 * @returns {number} the number of attachments copied
 */
export function copyAttachments(outDoc, sources) {
  const { context, catalog } = outDoc;
  const entries = new Map();
  for (const { srcDoc, copier, only } of sources) {
    const srcContext = srcDoc.context;
    const names = dictOf(srcContext, srcDoc.catalog.get(N("Names")));
    if (!names || !names.get(N("EmbeddedFiles"))) continue;
    for (const [key, value] of readNameTree(srcContext, names.get(N("EmbeddedFiles")))) {
      if (only && !only(key)) continue;
      let unique = key;
      for (let suffix = 2; entries.has(unique); suffix += 1) unique = `${key} (${suffix})`;
      entries.set(unique, copier.copy(value));
    }
  }
  if (!entries.size) return 0;
  // a name tree must be sorted by the bytes of its keys
  const sorted = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const array = context.obj([]);
  for (const key of sorted) {
    array.push(PDFHexString.of(Array.from(key, (char) => (char.charCodeAt(0) & 0xff).toString(16).padStart(2, "0")).join("")));
    array.push(entries.get(key));
  }
  let names = dictOf(context, catalog.get(N("Names")));
  if (!names) {
    names = context.obj({});
    catalog.set(N("Names"), names);
  }
  const tree = context.obj({});
  tree.set(N("Names"), array);
  names.set(N("EmbeddedFiles"), tree);
  return entries.size;
}
