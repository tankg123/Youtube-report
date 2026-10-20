// Source scanning shared by the i18n coverage test: which files are bilingual and which literal keys
// they pass to t() / tk() / tm().
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBilingualFile } from "../../i18n.files.mjs";

export const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(directory, out) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function toRelative(file) {
  return path.relative(FRONTEND_ROOT, file).split(path.sep).join("/");
}

export function listBilingualFiles() {
  return walk(path.join(FRONTEND_ROOT, "src"), [])
    .map(toRelative)
    .filter(isBilingualFile)
    .sort();
}

// I18N_FILES="src/pages/X.jsx,src/pages/Y.jsx" restricts a run to one slice while other slices are still
// being translated; the full list is used otherwise.
export function selectedFiles() {
  const all = listBilingualFiles();
  const only = process.env.I18N_FILES;
  if (!only) return all;
  const wanted = new Set(
    only
      .split(/[,;\n]+/)
      .map((item) => item.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^frontend\//, ""))
      .filter(Boolean)
  );
  const selected = all.filter((file) => wanted.has(file));
  if (!selected.length) throw new Error(`I18N_FILES matched none of the bilingual files: ${[...wanted].join(", ")}`);
  return selected;
}

const CALL = /\b(t|tk|tm)\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)/g;

export function unescapeLiteral(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, code) => {
    switch (code[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "0": return "\0";
      case "u": return String.fromCodePoint(parseInt(code.replace(/[u{}]/g, ""), 16));
      case "x": return String.fromCharCode(parseInt(code.slice(1), 16));
      case "\n": return "";
      default: return code;
    }
  });
}

// Every literal key passed to t() / tk() / tm() with its line number. Template literals with ${…} are not
// keys (the dictionary cannot know them) and are left to the lint rule.
export function extractKeys(source) {
  const keys = [];
  let line = 1;
  let cursor = 0;
  for (const match of source.matchAll(CALL)) {
    for (let index = cursor; index < match.index; index += 1) if (source.charCodeAt(index) === 10) line += 1;
    cursor = match.index;
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    keys.push({ call: match[1], key: unescapeLiteral(raw), line });
  }
  return keys;
}
