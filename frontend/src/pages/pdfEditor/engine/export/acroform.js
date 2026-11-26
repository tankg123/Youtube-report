// AcroForm: facts about the form of a source, rebuilding the interactive form of the output document from the
// fields whose widgets were copied, and taking signed signature fields out of a document that is rewritten.
import { pdfLib } from "../lib.js";
import { N, dictOf, arrayOf, boolOf, numberOf, nameOf, textOf, textString, resolve } from "./pdfUtil.js";

const { PDFRef, PDFDict, PDFNumber, PDFBool, PDFNull } = pdfLib;

/** /FT of a field or widget: its own, or the one it inherits through /Parent. */
export function inheritedFieldType(context, dict) {
  let current = dict;
  for (let step = 0; step < 32 && current; step += 1) {
    const type = nameOf(context, current.get(N("FT")));
    if (type) return type;
    current = dictOf(context, current.get(N("Parent")));
  }
  return undefined;
}

/** A signature field (or a widget of one) that carries a signature: /FT /Sig with a /V on itself or above it. */
export function isSignedSignature(context, dict) {
  if (inheritedFieldType(context, dict) !== "Sig") return false;
  let current = dict;
  for (let step = 0; step < 32 && current; step += 1) {
    if (current.has(N("V"))) return true;
    current = dictOf(context, current.get(N("Parent")));
  }
  return false;
}

/** Categories of the form's default resources (/DR) that are carried over: fonts, their encodings, colour spaces. */
const DEFAULT_RESOURCE_CATEGORIES = new Set(["Font", "Encoding", "ColorSpace"]);

/** Cheap facts about the form of a (pristine) source, for the user interface and for the export report. */
export function describeAcroForm(srcDoc) {
  const { context, catalog } = srcDoc;
  const acroForm = dictOf(context, catalog.get(N("AcroForm")));
  if (!acroForm) return { present: false, fields: 0, hasXFA: false, needAppearances: false, signatureFields: 0, signedFields: 0, sigFlags: 0 };
  let fields = 0;
  let signatureFields = 0;
  let signedFields = 0;
  const seen = new Set();
  const walk = (entry, inheritedType, depth) => {
    const dict = dictOf(context, entry);
    if (!dict || seen.has(dict) || depth > 64) return;
    seen.add(dict);
    const type = nameOf(context, dict.get(N("FT"))) ?? inheritedType;
    const kids = arrayOf(context, dict.get(N("Kids")));
    const terminal = !kids || kids.asArray().every((kid) => !dictOf(context, kid)?.has(N("T")));
    if (terminal) {
      fields += 1;
      if (type === "Sig") {
        signatureFields += 1;
        if (dict.has(N("V"))) signedFields += 1;
      }
    } else {
      for (const kid of kids.asArray()) walk(kid, type, depth + 1);
    }
  };
  for (const entry of arrayOf(context, acroForm.get(N("Fields")))?.asArray() ?? []) walk(entry, undefined, 0);
  return {
    present: true,
    fields,
    hasXFA: acroForm.has(N("XFA")),
    needAppearances: boolOf(context, acroForm.get(N("NeedAppearances"))) === true,
    signatureFields,
    signedFields,
    sigFlags: numberOf(context, acroForm.get(N("SigFlags"))) ?? 0
  };
}

/**
 * Builds /AcroForm in the output document.
 *
 * @param {object} outDoc  PDFDocument
 * @param {Array<{ srcDoc: any, copier: any, survivingFieldRoots: any[], label?: string }>} sources
 *        one entry per source document, in output order: the values returned by copyPagesSafe()
 *        (srcDoc is the scrubbed source; the copier maps its objects to their copies)
 * @returns {{ fields: number, wrappedSources: number, needAppearances: boolean, droppedXFA: number, calculationOrder: number }}
 */
export function rebuildAcroForm(outDoc, sources) {
  const { context, catalog } = outDoc;
  const fieldsOut = context.obj([]);
  const usedNames = new Set();
  const drFonts = context.obj({});
  const dr = context.obj({});
  let da;
  let quadding;
  let needAppearances = false;
  let droppedXFA = 0;
  let wrappedSources = 0;
  let hasSignatureField = false;
  const calculationOrder = context.obj([]);

  sources.forEach((source, sourceIndex) => {
    const srcContext = source.srcDoc.context;
    const acroForm = dictOf(srcContext, source.srcDoc.catalog.get(N("AcroForm")));
    const map = source.copier.traversedObjects;
    const roots = [];
    for (const root of source.survivingFieldRoots) {
      if (!(root instanceof PDFRef)) continue; // a direct dictionary in /Fields cannot be shared with a page
      const mapped = map.get(root);
      if (mapped instanceof PDFRef && context.lookup(mapped) instanceof PDFDict) roots.push(mapped);
    }
    if (!roots.length) {
      if (acroForm && acroForm.has(N("XFA"))) droppedXFA += 1;
      return;
    }

    // Two sources may both have a field called "name": fully qualified names must be unique, otherwise
    // viewers treat them as ONE field. On a clash the roots of the later source go under a new parent.
    const names = roots.map((ref) => textOf(context, context.lookup(ref).get(N("T"))) ?? "");
    const clash = names.some((name) => usedNames.has(name));
    if (clash) {
      let prefix = source.label || `doc${sourceIndex + 1}`;
      while (usedNames.has(prefix)) prefix += "_";
      const parent = context.obj({});
      parent.set(N("T"), textString(prefix));
      const parentRef = context.register(parent);
      parent.set(N("Kids"), context.obj(roots));
      for (const ref of roots) context.lookup(ref).set(N("Parent"), parentRef);
      fieldsOut.push(parentRef);
      usedNames.add(prefix);
      wrappedSources += 1;
    } else {
      roots.forEach((ref, index) => {
        fieldsOut.push(ref);
        usedNames.add(names[index]);
      });
    }

    if (acroForm) {
      if (acroForm.has(N("XFA"))) droppedXFA += 1;
      if (boolOf(srcContext, acroForm.get(N("NeedAppearances"))) === true) needAppearances = true;
      if (!da && acroForm.get(N("DA"))) da = source.copier.copy(resolve(srcContext, acroForm.get(N("DA"))));
      if (quadding === undefined) quadding = numberOf(srcContext, acroForm.get(N("Q")));
      // Default resources: first source wins for a name that is already taken. Only what a default appearance
      // string (/DA) can name is carried over. /DR is a resource dictionary of the DOCUMENT: whatever else it
      // lists (pictures, forms, patterns of any page) would travel into every export that keeps one field.
      const srcDR = dictOf(srcContext, acroForm.get(N("DR")));
      if (srcDR) {
        for (const [category, value] of srcDR.entries()) {
          if (!DEFAULT_RESOURCE_CATEGORIES.has(category.decodeText())) continue;
          const srcCategory = dictOf(srcContext, value);
          if (!srcCategory) continue;
          const existing = dr.get(category);
          const target = category === N("Font") ? drFonts : (existing instanceof PDFDict ? existing : context.obj({}));
          for (const [name, entry] of srcCategory.entries()) {
            // a Type3 font is content (glyph procedures with resources of their own), not a font to type with
            if (category === N("Font") && nameOf(srcContext, dictOf(srcContext, entry)?.get(N("Subtype"))) === "Type3") continue;
            if (!target.has(name)) target.set(name, source.copier.copy(entry));
          }
          if (category !== N("Font") && target.keys().length) dr.set(category, target);
        }
      }
      // calculation order: only fields that made it into the output
      for (const entry of arrayOf(srcContext, acroForm.get(N("CO")))?.asArray() ?? []) {
        const mapped = entry instanceof PDFRef ? map.get(entry) : undefined;
        if (mapped instanceof PDFRef && context.lookup(mapped) instanceof PDFDict && srcContext.lookup(entry) !== PDFNull) calculationOrder.push(mapped);
      }
    }
  });

  if (fieldsOut.size() === 0) {
    catalog.delete(N("AcroForm"));
    return { fields: 0, wrappedSources: 0, needAppearances: false, droppedXFA, calculationOrder: 0 };
  }

  // is there still an (unsigned) signature field?
  const seen = new Set();
  const stack = fieldsOut.asArray().slice();
  while (stack.length) {
    const dict = dictOf(context, stack.pop());
    if (!dict || seen.has(dict)) continue;
    seen.add(dict);
    if (nameOf(context, dict.get(N("FT"))) === "Sig") hasSignatureField = true;
    for (const kid of arrayOf(context, dict.get(N("Kids")))?.asArray() ?? []) stack.push(kid);
  }

  const acroFormOut = context.obj({});
  acroFormOut.set(N("Fields"), fieldsOut);
  if (da) acroFormOut.set(N("DA"), da);
  if (quadding !== undefined) acroFormOut.set(N("Q"), PDFNumber.of(quadding));
  if (drFonts.keys().length) dr.set(N("Font"), drFonts);
  if (dr.keys().length) acroFormOut.set(N("DR"), dr);
  if (needAppearances) acroFormOut.set(N("NeedAppearances"), PDFBool.True);
  if (calculationOrder.size()) acroFormOut.set(N("CO"), calculationOrder);
  // /SigFlags 1 = "signature fields exist". Never 3: nothing in a rebuilt document is signed.
  if (hasSignatureField) acroFormOut.set(N("SigFlags"), PDFNumber.of(1));
  // /XFA is not carried over: the XML form description would contradict the rebuilt field tree.
  catalog.set(N("AcroForm"), context.register(acroFormOut));
  return { fields: fieldsOut.size(), wrappedSources, needAppearances, droppedXFA, calculationOrder: calculationOrder.size() };
}

/** Fully qualified names of the terminal fields of a document (for tests and reports). */
export function listFieldNames(pdfDoc) {
  const { context, catalog } = pdfDoc;
  const acroForm = dictOf(context, catalog.get(N("AcroForm")));
  const out = [];
  if (!acroForm) return out;
  const seen = new Set();
  const walk = (entry, prefix, depth) => {
    const dict = dictOf(context, entry);
    if (!dict || seen.has(dict) || depth > 64) return;
    seen.add(dict);
    const part = textOf(context, dict.get(N("T")));
    const name = part === undefined ? prefix : (prefix ? `${prefix}.${part}` : part);
    const kids = arrayOf(context, dict.get(N("Kids")))?.asArray() ?? [];
    const fieldKids = kids.filter((kid) => dictOf(context, kid)?.has(N("T")));
    if (fieldKids.length) fieldKids.forEach((kid) => walk(kid, name, depth + 1));
    else out.push(name);
  };
  for (const entry of arrayOf(context, acroForm.get(N("Fields")))?.asArray() ?? []) walk(entry, "", 0);
  return out;
}

/**
 * Takes the SIGNED signature fields out of a document that is about to be rewritten (no signature survives
 * that: left in, a viewer would announce a broken signature): their widgets leave the pages, their nodes
 * leave the field tree, and the catalog loses /Perms (the permissions a certification granted) and /DSS (the
 * validation material of the signatures). Empty signature fields stay; /SigFlags then says 1 ("signature
 * fields exist"), never 3. The objects are deleted, so that nothing else (an action, a reply) keeps one alive.
 *
 * @param {object} pdfDoc  PDFDocument (it is changed)
 * @returns {{ fields: number, widgets: number }}  what was removed
 */
export function removeSignedSignatures(pdfDoc) {
  const { context, catalog } = pdfDoc;
  const removed = { fields: 0, widgets: 0 };
  const gone = new Set();
  const isWidget = (dict) => nameOf(context, dict.get(N("Subtype"))) === "Widget";
  for (const page of pdfDoc.getPages()) {
    const annots = arrayOf(context, page.node.get(N("Annots")));
    if (!annots) continue;
    const staying = [];
    for (const entry of annots.asArray()) {
      const dict = dictOf(context, entry);
      if (dict && (isWidget(dict) || dict.has(N("FT"))) && isSignedSignature(context, dict)) {
        removed.widgets += 1;
        if (entry instanceof PDFRef) gone.add(entry);
      } else staying.push(entry);
    }
    if (staying.length !== annots.size()) page.node.set(N("Annots"), context.obj(staying));
  }
  const acroForm = dictOf(context, catalog.get(N("AcroForm")));
  if (acroForm) {
    const visiting = new Set();
    let unsigned = false;
    /** false = the node goes: it is a signed signature field, or a branch that held nothing else. */
    const stays = (entry, depth) => {
      const dict = dictOf(context, entry);
      if (!dict || visiting.has(dict) || depth > 64) return Boolean(dict);
      if (isSignedSignature(context, dict)) {
        const kids = arrayOf(context, dict.get(N("Kids")));
        const terminal = !kids || kids.asArray().every((kid) => !dictOf(context, kid)?.has(N("T")));
        if (terminal) removed.fields += 1;
        else for (const kid of kids.asArray()) stays(kid, depth + 1); // counts the fields below
        if (entry instanceof PDFRef) gone.add(entry);
        for (const kid of kids ? kids.asArray() : []) if (kid instanceof PDFRef) gone.add(kid);
        return false;
      }
      visiting.add(dict);
      const kids = arrayOf(context, dict.get(N("Kids")));
      let alive = true;
      if (kids) {
        const keptKids = kids.asArray().filter((kid) => stays(kid, depth + 1));
        if (keptKids.length !== kids.size()) {
          dict.set(N("Kids"), context.obj(keptKids));
          // a branch that only led to signatures has nothing to offer any more (a widget of its own keeps it)
          if (!keptKids.length && !isWidget(dict)) alive = false;
        }
      }
      visiting.delete(dict);
      if (alive && nameOf(context, dict.get(N("FT"))) === "Sig") unsigned = true;
      if (!alive && entry instanceof PDFRef) gone.add(entry);
      return alive;
    };
    const fields = arrayOf(context, acroForm.get(N("Fields")));
    if (fields) {
      const keptFields = fields.asArray().filter((entry) => stays(entry, 0));
      if (keptFields.length !== fields.size()) acroForm.set(N("Fields"), context.obj(keptFields));
    }
    if (unsigned) acroForm.set(N("SigFlags"), PDFNumber.of(1));
    else acroForm.delete(N("SigFlags"));
  }
  catalog.delete(N("Perms"));
  catalog.delete(N("DSS"));
  for (const ref of gone) context.delete(ref);
  return removed;
}
