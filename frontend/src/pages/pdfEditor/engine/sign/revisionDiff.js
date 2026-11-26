// "What happened to the document after this signature?" - a HEURISTIC for the signature panel.
//
// The document as signed is the file prefix [0, signedEnd). Both that prefix and the whole file are parsed
// with the PDF library and compared object by object. Changes are sorted into
//   - signature maintenance (allowed): new signature fields / widgets / signature dictionaries, a previously
//     empty signature field that got its value, validation data (/DSS), /Perms, /Extensions, metadata;
//   - everything else (not allowed): page content, annotations, form values, resources, structure ...
// It answers "only signatures were added" versus "something else changed". The parser reads every object in
// file order and ignores the cross-reference tables, which a viewer does not; ./xrefAudit.js therefore checks
// the cross-reference data written after the signature against this picture (objects freed, re-pointed or
// defined twice), and references of the signed document to objects that were supplied only later are
// reported too. It remains a heuristic, not a proof: the hard facts are the byte-level ones (digest, coverage).
//
// Every finding is a code of ./codes.js (SIGN_CHANGE_...) with parameters; pages are numbered from 1 in the
// parameters because they go into sentences.

import { pdfLib } from "../lib.js";
import { auditLaterXref } from "./xrefAudit.js";

const ALLOWED_CATALOG_KEYS = new Set(["AcroForm", "DSS", "Perms", "Extensions", "Version", "Metadata"]);
const ALLOWED_ACROFORM_KEYS = new Set(["Fields", "SigFlags", "DR", "DA"]);
const ALLOWED_SIG_FIELD_KEYS = new Set(["V", "AP", "AS", "F", "M", "P", "Rect", "MK", "DA", "Lock", "Type", "Subtype"]);

/** Options that make the library read a file without changing or decrypting anything. */
export const READ_ONLY_LOAD_OPTIONS = Object.freeze({ ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false, parseSpeed: Infinity });

const refKey = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

function sameObject(a, b) {
  const aStream = Boolean(a && a.dict && typeof a.getContents === "function");
  const bStream = Boolean(b && b.dict && typeof b.getContents === "function");
  if (aStream !== bStream) return false;
  if (aStream) {
    if (a.dict.toString() !== b.dict.toString()) return false;
    const x = a.getContents();
    const y = b.getContents();
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  return a.toString() === b.toString();
}

/**
 * @param {Uint8Array} bytes      the whole file
 * @param {number} signedEnd      end of the signed range (ByteRange c + d)
 * @param {object} [finalDoc]     PDFDocument of the whole file when already loaded WITHOUT decryption
 * @returns {Promise<{ classification: "signatures-only" | "other" | "unknown", reason: string | null,
 *                     items: { code: string, params: object, allowed: boolean }[], unchanged: boolean,
 *                     onlyValidationData: boolean }>}
 *          reason (classification "unknown"): "load-failed" | "page-tree"; unchanged: no object of the document
 *          differs or was added (trailing bytes that are not a revision)
 */
export async function classifyChangesAfter(bytes, signedEnd, finalDoc = null) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } = pdfLib;
  const unknown = (reason) => ({ classification: "unknown", reason, items: [], unchanged: false, onlyValidationData: false });
  let before;
  let after;
  try {
    before = await PDFDocument.load(bytes.subarray(0, signedEnd), READ_ONLY_LOAD_OPTIONS);
    after = finalDoc || await PDFDocument.load(bytes, READ_ONLY_LOAD_OPTIONS);
  } catch {
    return unknown("load-failed");
  }
  const name = (text) => PDFName.of(text);
  const lookupIn = (doc, object) => (object instanceof PDFRef ? doc.context.lookup(object) : object);
  const dictKeys = (dict) => dict.entries().map(([key]) => key.decodeText());
  const nameValue = (object) => (object instanceof PDFName ? object.decodeText() : null);

  const beforeObjects = new Map();
  for (const [ref, object] of before.context.enumerateIndirectObjects()) beforeObjects.set(refKey(ref), object);
  const afterObjects = new Map();
  for (const [ref, object] of after.context.enumerateIndirectObjects()) afterObjects.set(refKey(ref), object);

  const added = new Set();
  const changed = [];
  for (const [key, object] of afterObjects) {
    if (!beforeObjects.has(key)) added.add(key);
    else if (!sameObject(beforeObjects.get(key), object)) changed.push(key);
  }
  const removed = [...beforeObjects.keys()].filter((key) => !afterObjects.has(key));

  const items = [];
  const other = (code, params = {}) => items.push({ code, params, allowed: false });
  const fine = (code, params = {}) => items.push({ code, params, allowed: true });

  // roles in the signed document
  const rootRef = before.context.trailerInfo.Root;
  const infoRef = before.context.trailerInfo.Info;
  const rootKey = rootRef instanceof PDFRef ? refKey(rootRef) : null;
  const infoKey = infoRef instanceof PDFRef ? refKey(infoRef) : null;
  const afterRootRef = after.context.trailerInfo.Root;
  if (rootKey && afterRootRef instanceof PDFRef && refKey(afterRootRef) !== rootKey) other("SIGN_CHANGE_CATALOG_REPLACED");

  let beforePages;
  let afterPages;
  let beforeCatalog;
  let afterCatalog;
  try {
    beforePages = before.getPages();
    afterPages = after.getPages();
    beforeCatalog = before.catalog;
    afterCatalog = after.catalog;
  } catch {
    return unknown("page-tree");
  }
  if (!(beforeCatalog instanceof PDFDict) || !(afterCatalog instanceof PDFDict)) return unknown("page-tree");
  const pageIndexByKey = new Map(beforePages.map((page, index) => [refKey(page.ref), index]));
  if (afterPages.length !== beforePages.length) other("SIGN_CHANGE_PAGE_COUNT", { before: beforePages.length, after: afterPages.length });
  else {
    afterPages.forEach((page, index) => {
      if (refKey(page.ref) !== refKey(beforePages[index].ref)) other("SIGN_CHANGE_PAGE_REPLACED", { page: index + 1 });
    });
  }

  const acroFormEntry = beforeCatalog.get(name("AcroForm"));
  const beforeAcroFormKey = acroFormEntry instanceof PDFRef ? refKey(acroFormEntry) : null;
  const metadataRef = beforeCatalog.get(name("Metadata"));
  const metadataKey = metadataRef instanceof PDFRef ? refKey(metadataRef) : null;

  // objects under /DSS of the signed document (validation data may grow)
  const dssKeys = new Set();
  const collect = (object, depth) => {
    if (depth > 6 || !object) return;
    if (object instanceof PDFRef) {
      const key = refKey(object);
      if (dssKeys.has(key)) return;
      dssKeys.add(key);
      collect(before.context.lookup(object), depth + 1);
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) collect(value, depth + 1);
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) collect(object.get(i), depth + 1);
    }
  };
  collect(beforeCatalog.get(name("DSS")), 0);

  const isSignatureField = (doc, dict) => {
    let current = dict;
    for (let i = 0; i < 8 && current instanceof PDFDict; i++) {
      const type = nameValue(lookupIn(doc, current.get(name("FT"))));
      if (type) return type === "Sig";
      current = lookupIn(doc, current.get(name("Parent")));
    }
    return false;
  };
  const isSignatureWidget = (doc, ref) => {
    const dict = lookupIn(doc, ref);
    if (!(dict instanceof PDFDict)) return false;
    return nameValue(lookupIn(doc, dict.get(name("Subtype")))) === "Widget" && isSignatureField(doc, dict);
  };
  const refList = (doc, value) => {
    const array = lookupIn(doc, value);
    if (!(array instanceof PDFArray)) return [];
    const out = [];
    for (let i = 0; i < array.size(); i++) {
      const item = array.get(i);
      out.push(item instanceof PDFRef ? refKey(item) : `direct:${item.toString()}`);
    }
    return out;
  };
  const refOf = (key) => {
    const [objectNumber, generation] = key.split(" ").map(Number);
    return PDFRef.of(objectNumber, generation);
  };

  /** Compares two dictionaries key by key; returns the names of the keys whose value differs. */
  const differingKeys = (a, b) => {
    const keys = new Set([...dictKeys(a), ...dictKeys(b)]);
    const out = [];
    for (const key of keys) {
      const x = a.get(name(key));
      const y = b.get(name(key));
      if ((x === undefined) !== (y === undefined) || (x && y && x.toString() !== y.toString())) out.push(key);
    }
    return out;
  };

  const checkFieldList = (beforeList, afterList) => {
    // existing entries must stay, in order; new entries must be signature fields
    for (let i = 0; i < beforeList.length; i++) {
      if (afterList[i] !== beforeList[i]) {
        other("SIGN_CHANGE_FIELD_REMOVED");
        return;
      }
    }
    for (const key of afterList.slice(beforeList.length)) {
      if (key.startsWith("direct:") || !isSignatureField(after, lookupIn(after, refOf(key)))) other("SIGN_CHANGE_FIELD_ADDED");
      else fine("SIGN_CHANGE_SIGNATURE_FIELD_ADDED", { object: key });
    }
  };
  const checkAcroForm = (beforeDict, afterDict) => {
    for (const key of differingKeys(beforeDict, afterDict)) {
      if (!ALLOWED_ACROFORM_KEYS.has(key)) other("SIGN_CHANGE_FORM_ENTRY", { key });
      else if (key === "Fields") checkFieldList(refList(before, beforeDict.get(name("Fields"))), refList(after, afterDict.get(name("Fields"))));
    }
  };
  const checkAnnots = (page, beforeValue, afterValue) => {
    const beforeList = refList(before, beforeValue);
    const afterList = refList(after, afterValue);
    for (const key of beforeList) {
      if (!afterList.includes(key)) {
        other("SIGN_CHANGE_ANNOTATION_REMOVED", { page });
        return;
      }
    }
    for (const key of afterList) {
      if (beforeList.includes(key)) continue;
      if (key.startsWith("direct:") || !isSignatureWidget(after, refOf(key))) other("SIGN_CHANGE_ANNOTATION_ADDED", { page });
      else fine("SIGN_CHANGE_SIGNATURE_WIDGET_ADDED", { page, object: key });
    }
  };

  // indirect /Annots arrays and the form's /Fields array of the signed document
  const annotsArrayOwner = new Map();
  beforePages.forEach((page, index) => {
    const annots = page.node.get(name("Annots"));
    if (annots instanceof PDFRef) annotsArrayOwner.set(refKey(annots), index);
  });
  const beforeAcroForm = lookupIn(before, acroFormEntry);
  const fieldsArrayKey = beforeAcroForm instanceof PDFDict && beforeAcroForm.get(name("Fields")) instanceof PDFRef ? refKey(beforeAcroForm.get(name("Fields"))) : null;

  for (const key of changed) {
    const was = beforeObjects.get(key);
    const now = afterObjects.get(key);
    if (key === infoKey || key === metadataKey) {
      fine("SIGN_CHANGE_METADATA", { what: key === infoKey ? "info" : "xmp" });
      continue;
    }
    if (dssKeys.has(key)) {
      fine("SIGN_CHANGE_VALIDATION_DATA", { object: key });
      continue;
    }
    if (key === rootKey && was instanceof PDFDict && now instanceof PDFDict) {
      for (const entry of differingKeys(was, now)) {
        if (!ALLOWED_CATALOG_KEYS.has(entry)) other("SIGN_CHANGE_CATALOG_OTHER_ENTRY", { key: entry });
        else if (entry === "AcroForm") {
          const a = lookupIn(before, was.get(name("AcroForm")));
          const b = lookupIn(after, now.get(name("AcroForm")));
          if (a instanceof PDFDict && b instanceof PDFDict) checkAcroForm(a, b);
          else if (!a && b instanceof PDFDict) checkFieldList([], refList(after, b.get(name("Fields"))));
          else other("SIGN_CHANGE_FORM_REPLACED");
        } else if (entry === "DSS") fine("SIGN_CHANGE_VALIDATION_DATA", { object: key });
        else fine("SIGN_CHANGE_CATALOG_ENTRY", { key: entry });
      }
      continue;
    }
    if (key === beforeAcroFormKey && was instanceof PDFDict && now instanceof PDFDict) {
      checkAcroForm(was, now);
      continue;
    }
    if (key === fieldsArrayKey) {
      checkFieldList(refList(before, was), refList(after, now));
      continue;
    }
    if (pageIndexByKey.has(key) && was instanceof PDFDict && now instanceof PDFDict) {
      const page = pageIndexByKey.get(key) + 1;
      for (const entry of differingKeys(was, now)) {
        if (entry === "Annots") checkAnnots(page, was.get(name("Annots")), now.get(name("Annots")));
        else if (entry === "Contents") other("SIGN_CHANGE_PAGE_CONTENT", { page });
        else other("SIGN_CHANGE_PAGE_ENTRY", { page, key: entry });
      }
      continue;
    }
    if (annotsArrayOwner.has(key)) {
      checkAnnots(annotsArrayOwner.get(key) + 1, was, now);
      continue;
    }
    if (was instanceof PDFDict && now instanceof PDFDict && isSignatureField(before, was) && !was.get(name("V")) && now.get(name("V"))) {
      const bad = differingKeys(was, now).filter((entry) => !ALLOWED_SIG_FIELD_KEYS.has(entry));
      if (bad.length) other("SIGN_CHANGE_SIGNATURE_FIELD_ALTERED", { keys: bad });
      else fine("SIGN_CHANGE_SIGNATURE_FIELD_FILLED", { object: key });
      continue;
    }
    // anything else: say what kind of object it was
    let objectType = "object";
    if (was instanceof PDFDict) {
      const type = nameValue(lookupIn(before, was.get(name("Type")))) || nameValue(lookupIn(before, was.get(name("Subtype"))));
      if (type) objectType = type;
      if (was.get(name("FT")) || was.get(name("Parent"))) objectType = "field-or-annotation";
    } else if (was && was.dict) {
      objectType = "stream";
    }
    other("SIGN_CHANGE_OBJECT", { object: key, objectType });
  }
  for (const key of removed) other("SIGN_CHANGE_OBJECT_REMOVED", { object: key });

  // what the cross-reference data after the signature does to the objects a viewer resolves
  const audit = await auditLaterXref(bytes, signedEnd, beforeObjects, afterObjects, sameObject);
  for (const item of audit.items) {
    if (!items.some((known) => known.code === item.code && JSON.stringify(known.params) === JSON.stringify(item.params))) items.push(item);
  }

  // A signed object may point at an object that did not exist (a viewer shows nothing for it). Supplying that
  // object later puts new content into the signed page although no object of the signed document changed.
  const supplied = new Set([...added, ...audit.defined]);
  if (supplied.size) {
    const referenced = new Set();
    const collect = (object, depth) => {
      if (!object || depth > 64) return;
      if (object instanceof PDFRef) referenced.add(refKey(object));
      else if (object instanceof PDFDict) for (const [, value] of object.entries()) collect(value, depth + 1);
      else if (object instanceof PDFArray) for (let i = 0; i < object.size(); i++) collect(object.get(i), depth + 1);
      else if (object.dict instanceof PDFDict) collect(object.dict, depth + 1);
    };
    for (const object of beforeObjects.values()) collect(object, 0);
    for (const key of supplied) if (referenced.has(key)) other("SIGN_CHANGE_DANGLING_REFERENCE", { object: key });
  }

  // (a file whose signed part ends in the middle of the last revision would show no object change at all)
  const classification = items.some((item) => !item.allowed) ? "other" : "signatures-only";
  const signatureCodes = ["SIGN_CHANGE_SIGNATURE_FIELD_ADDED", "SIGN_CHANGE_SIGNATURE_WIDGET_ADDED", "SIGN_CHANGE_SIGNATURE_FIELD_FILLED"];
  return {
    classification,
    reason: null,
    items,
    unchanged: items.length === 0 && added.size === 0,
    onlyValidationData: classification === "signatures-only" && !items.some((item) => signatureCodes.includes(item.code))
  };
}
