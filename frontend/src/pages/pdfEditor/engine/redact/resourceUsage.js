// Removes resource entries that no content stream uses any more.
//
// WHY: a resource dictionary keeps everything it names reachable. After a redaction the page content no longer
// draws the original Form XObject (a modified copy took its place), no longer uses the property list with the
// /ActualText, perhaps no longer uses a font or an image, but the entries are still in /Resources, so the
// objects are still written to the file. The same holds for a page that became a picture when its old
// /Resources dictionary is shared with other pages (very common: one dictionary inherited from /Pages), and
// for pages DELETED from a document: what only they drew stays reachable through the shared dictionary.
//
// pruneResources() deletes an entry only when it can PROVE that no content stream that sees the dictionary
// uses the name: every user of the dictionary (pages that own or inherit it, Form XObjects, tiling patterns,
// Type3 fonts) is found by scanning the document, and each of their content streams is tokenised. If a user
// cannot be analysed, nothing is deleted from the dictionaries it uses. The caller names the dictionaries to
// look at (the one a page used before, the one it uses now, the private dictionaries of the Form XObjects that
// were copied for it) and may restrict the categories (fontCleanup.js releases fonts only).
import { parseContentStream } from "./contentStream.js";
import { A } from "./pdfAccess.js";

/** Categories that are pruned. /ColorSpace and /Shading are left alone (no content; Default* are implicit). */
export const PRUNED_CATEGORIES = Object.freeze(["XObject", "Properties", "Pattern", "Font", "ExtGState"]);

const emptyUsage = () => ({ XObject: new Set(), Properties: new Set(), Pattern: new Set(), Font: new Set(), ExtGState: new Set() });

/**
 * Resource names a content stream refers to, by category. Throws ContentParseError when the stream is not
 * understood.
 */
export function usedResourceNames(bytes, into = emptyUsage()) {
  const { ops } = parseContentStream(bytes);
  for (const op of ops) {
    const a = op.args;
    switch (op.op) {
      case "Do":
        if (a[0]?.type === "name") into.XObject.add(a[0].value);
        break;
      case "Tf":
        if (a[0]?.type === "name") into.Font.add(a[0].value);
        break;
      case "gs":
        if (a[0]?.type === "name") into.ExtGState.add(a[0].value);
        break;
      case "scn": case "SCN": case "sc": case "SC": {
        const last = a[a.length - 1];
        if (last?.type === "name") into.Pattern.add(last.value);
        break;
      }
      case "BDC": case "DP":
        if (a[1]?.type === "name") into.Properties.add(a[1].value);
        break;
      default:
    }
  }
  return into;
}

function inheritedResourcesOf(node, context) {
  for (let guard = 0; A.isDict(node) && guard < 64; guard++) {
    const r = A.get(node, "Resources");
    if (A.isDict(r)) return r;
    node = A.resolve(context, A.getRaw(node, "Parent"));
  }
  return undefined;
}

/**
 * Deletes the entries of the given resource dictionaries that no user refers to.
 *   dicts        resource dictionaries (PDFDict) to examine, e.g. the dictionary a redacted page used before
 *                and the one it uses now. Duplicates and undefined are ignored.
 *   categories   the categories to prune (default: all of PRUNED_CATEGORIES)
 * Returns { deleted: [{ category, name, value }], skipped: [reason] }.
 */
export function pruneResources(pdfDoc, dicts, { categories = PRUNED_CATEGORIES } = {}) {
  const context = pdfDoc.context;
  const result = { deleted: [], skipped: [] };
  const wanted = [...new Set(dicts.filter((d) => A.isDict(d)))];
  if (!wanted.length) return result;

  // category sub-dictionaries to prune (by object identity), each with the users found for it
  const subs = new Map(); // PDFDict -> { category, holders: Set<resourceDict> }
  for (const d of wanted) {
    for (const category of categories) {
      const s = A.get(d, category);
      if (A.isDict(s) && !subs.has(s)) subs.set(s, { category, users: [], broken: null });
    }
  }
  if (!subs.size) return result;

  // every object with a /Resources entry is a potential user
  const leavesOf = (pagesNode, out, depth = 0) => {
    const kids = A.get(pagesNode, "Kids");
    if (!A.isArray(kids) || depth > 64) return;
    for (let i = 0; i < kids.size(); i++) {
      const k = kids.lookup(i);
      if (!A.isDict(k)) continue;
      if (A.isArray(A.get(k, "Kids"))) leavesOf(k, out, depth + 1);
      else out.push(k);
    }
  };
  const users = []; // { kind, object, resources }
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dict = A.isStream(obj) ? obj.dict : A.isDict(obj) ? obj : null;
    if (!dict) continue;
    const res = A.get(dict, "Resources");
    if (!A.isDict(res)) continue;
    if (A.isStream(obj)) users.push({ kind: "stream", object: obj, resources: res });
    else if (A.isDict(A.get(dict, "CharProcs"))) users.push({ kind: "type3", object: dict, resources: res });
    else if (A.isArray(A.get(dict, "Kids"))) {
      const leaves = [];
      leavesOf(dict, leaves);
      for (const leaf of leaves) if (inheritedResourcesOf(leaf, context) === res) users.push({ kind: "page", object: leaf, resources: res });
    } else if (A.getRaw(dict, "Contents") !== undefined || A.getName(dict, "Type") === "Page") users.push({ kind: "page", object: dict, resources: res });
    else users.push({ kind: "unknown", object: dict, resources: res });
  }
  // the default resources of the form (/AcroForm /DR) are used by field appearances that are generated later:
  // a dictionary shared with them is never pruned
  const acroForm = A.get(pdfDoc.catalog, "AcroForm");
  const dr = A.get(acroForm, "DR");
  if (A.isDict(dr)) users.push({ kind: "unknown", object: dr, resources: dr });

  const usageCache = new Map();
  /** Names used by one user through ITS resource dictionary; null when it cannot be analysed. */
  const usageOf = (user) => {
    if (usageCache.has(user.object)) return usageCache.get(user.object);
    let usage = emptyUsage();
    try {
      const scan = (bytes, depth) => {
        const local = usedResourceNames(bytes);
        for (const c of PRUNED_CATEGORIES) for (const n of local[c]) usage[c].add(n);
        // Form XObjects without /Resources use the resources of the content that draws them
        const xo = A.get(user.resources, "XObject");
        if (!A.isDict(xo)) return;
        for (const name of local.XObject) {
          const f = A.resolve(context, xo.get(A.N(name)));
          if (A.isStream(f) && A.getName(f.dict, "Subtype") === "Form" && !A.isDict(A.get(f.dict, "Resources"))) {
            if (depth > 16) throw new Error("forms nested too deeply");
            scan(A.streamBytes(f), depth + 1);
          }
        }
      };
      if (user.kind === "page") {
        const contents = A.get(user.object, "Contents");
        const streams = A.isStream(contents) ? [contents] : A.isArray(contents) ? contents.asArray().map((r) => A.resolve(context, r)) : [];
        const chunks = [];
        for (const s of streams) {
          if (!A.isStream(s)) continue;
          chunks.push(A.streamBytes(s));
        }
        const total = chunks.reduce((n, c) => n + c.length + 1, 0);
        const all = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.length;
          all[o++] = 0x0a;
        }
        scan(all, 0);
      } else if (user.kind === "stream") scan(A.streamBytes(user.object), 0);
      else if (user.kind === "type3") {
        for (const [, v] of A.get(user.object, "CharProcs").entries()) {
          const s = A.resolve(context, v);
          if (A.isStream(s)) scan(A.streamBytes(s), 0);
        }
      } else usage = null;
      // a Type3 font without /Resources draws its glyphs with the resources of the page that uses it
      if (usage) {
        const fonts = A.get(user.resources, "Font");
        if (A.isDict(fonts)) {
          for (const name of usage.Font) {
            const f = A.resolve(context, fonts.get(A.N(name)));
            if (A.isDict(f) && A.getName(f, "Subtype") === "Type3" && !A.isDict(A.get(f, "Resources"))) usage = null;
            if (!usage) break;
          }
        }
      }
    } catch {
      usage = null;
    }
    usageCache.set(user.object, usage);
    return usage;
  };

  for (const [sub, info] of subs) {
    const mine = users.filter((u) => A.get(u.resources, info.category) === sub);
    const union = new Set();
    let broken = null;
    for (const u of mine) {
      const usage = usageOf(u);
      if (!usage) {
        broken = `a ${u.kind} that uses this /${info.category} dictionary could not be analysed`;
        break;
      }
      for (const n of usage[info.category]) union.add(n);
    }
    if (broken) {
      result.skipped.push(broken);
      continue;
    }
    for (const key of sub.keys()) {
      const name = key.decodeText();
      if (union.has(name)) continue;
      const value = sub.get(key);
      sub.delete(key);
      result.deleted.push({ category: info.category, name, value });
    }
  }
  return result;
}

/** The resource dictionary a page uses (own or inherited), or undefined. */
export function pageResources(pdfDoc, pageIndex) {
  return inheritedResourcesOf(pdfDoc.getPage(pageIndex).node, pdfDoc.context);
}
