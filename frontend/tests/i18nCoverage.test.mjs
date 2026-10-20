// Bilingual coverage of the Content ID / Report pages. Run one slice while others are in progress with
//   I18N_FILES="src/pages/claimManager/ClaimsTable.jsx,src/pages/claimManager/ResultsPanel.jsx" node --test tests/i18nCoverage.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { NAMESPACES, hasTranslation, placeholdersOf, translations } from "../src/i18n/index.js";
import { FRONTEND_ROOT, extractKeys, selectedFiles, toRelative } from "./helpers/i18nSource.mjs";

const files = selectedFiles();
const restricted = Boolean(process.env.I18N_FILES);

test("every t()/tk()/tm() literal in the bilingual pages has a Vietnamese entry", (context) => {
  const missing = [];
  const used = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(FRONTEND_ROOT, file), "utf8");
    for (const { key, line, call } of extractKeys(source)) {
      used.add(key);
      if (!hasTranslation(key, "vi")) missing.push(`${file}:${line} ${call}(${JSON.stringify(key)})`);
    }
  }
  if (!restricted) {
    const stale = [];
    for (const namespace of NAMESPACES) {
      if (namespace.runtimeOnly) continue;
      for (const key of Object.keys(namespace.entries)) if (!used.has(key)) stale.push(`${namespace.name}: ${JSON.stringify(key)}`);
    }
    if (stale.length) context.diagnostic(`${stale.length} Vietnamese entries are not referenced by a t()/tk()/tm() literal (runtime texts or leftovers): ${stale.slice(0, 30).join(" | ")}`);
  }
  assert.deepEqual(missing, [], `Add these Vietnamese entries in src/i18n/vi/*.js:\n  ${missing.join("\n  ")}`);
});

test("Vietnamese entries are non-empty and keep the {placeholders} of their key", () => {
  const problems = [];
  for (const namespace of NAMESPACES) {
    for (const [key, value] of Object.entries(namespace.entries)) {
      if (typeof value !== "string" || !value.trim()) {
        problems.push(`${namespace.name}: ${JSON.stringify(key)} is empty`);
        continue;
      }
      const expected = [...new Set(placeholdersOf(key))].sort().join(",");
      const actual = [...new Set(placeholdersOf(value))].sort().join(",");
      if (expected !== actual) problems.push(`${namespace.name}: ${JSON.stringify(key)} has {${expected}} but its Vietnamese text has {${actual}}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("no dictionary key spells a legacy short key (t(\"video\") must not mean \"Video\")", () => {
  const legacyKeys = new Set([...Object.keys(translations.en), ...Object.keys(translations.vi)]);
  const collisions = [];
  for (const namespace of NAMESPACES) {
    for (const key of Object.keys(namespace.entries)) if (legacyKeys.has(key)) collisions.push(`${namespace.name}: ${JSON.stringify(key)}`);
  }
  assert.deepEqual(collisions, [], "Rename the legacy short key in src/i18n/legacy.js (and its callers) or use another English text");
});

test("no key is translated differently by two namespaces", { skip: restricted ? "single-slice run" : false }, () => {
  const seen = new Map();
  const conflicts = [];
  for (const namespace of NAMESPACES) {
    for (const [key, value] of Object.entries(namespace.entries)) {
      const previous = seen.get(key);
      if (!previous) seen.set(key, { name: namespace.name, value });
      else if (previous.value !== value) conflicts.push(`${JSON.stringify(key)}: ${previous.name} → ${JSON.stringify(previous.value)} | ${namespace.name} → ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(conflicts, [], `Pick one Vietnamese text per key:\n  ${conflicts.join("\n  ")}`);
});

test("the bilingual pages have no untranslated literals (eslint i18n/no-untranslated)", async () => {
  const eslint = new ESLint({ cwd: FRONTEND_ROOT });
  const results = await eslint.lintFiles(files.map((file) => path.join(FRONTEND_ROOT, file)));
  const leftovers = results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === "i18n/no-untranslated")
      .map((message) => `${toRelative(result.filePath)}:${message.line}:${message.column} ${message.message}`)
  );
  assert.deepEqual(leftovers, [], `Wrap these texts with t()/tk() and add their Vietnamese entries:\n  ${leftovers.join("\n  ")}`);
});
