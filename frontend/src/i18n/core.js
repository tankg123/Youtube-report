// Translation core for the bilingual (English / Vietnamese) UI.
//
// No React and no DOM here, so plain modules (utils.js, constants.js, hooks) and the node:test suite
// can translate too. House rules:
//   * The English text IS the key: t("Release selected") gives "Gỡ claim đã chọn" in Vietnamese and
//     the key itself in English, so the English UI is unchanged by construction.
//   * Dictionaries live in ./vi/*.js (one file per feature slice) and are registered by ./index.js.
//     Always import from "./index.js", never from this file, so the dictionaries are loaded.
//   * tk("…") marks a canonical English string kept in a constant or in state (an outcome label, a
//     stored error); it is translated where it is rendered, with t(value) or tm(message).
//   * tm(message) translates a runtime message (server answers, stored texts): exact entry first,
//     then the ordered regex rules of ./vi/rules.js, otherwise the message is shown as it is. The
//     English side works the same way (./en/*.js) for the few server messages written in Vietnamese.
//   * The original short keys of I18nContext (t("report") → "Report") live in a separate legacy store
//     that is only consulted for keys no dictionary knows: a dictionary key such as "video" is always
//     the English text "video", never the legacy value "Video" of the same spelling.
//   * Placeholders are {name}; t("{count} claims", { count }) fills them. A placeholder whose value is
//     an object (a React element) makes t() return an array of parts instead of a string.

export const LANGUAGES = Object.freeze(["en", "vi"]);
export const DEFAULT_LANGUAGE = "en";

const dictionaries = { en: Object.create(null), vi: Object.create(null) };
const legacy = { en: Object.create(null), vi: Object.create(null) };
const dictionaryKeys = new Set();
const messageRules = { en: [], vi: [] };
const listeners = new Set();
let currentLanguage = DEFAULT_LANGUAGE;

function has(store, key) {
  return Object.prototype.hasOwnProperty.call(store, key);
}

export function normalizeLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "vi" || text === "vn" || text.startsWith("vi-") ? "vi" : "en";
}

export function getLanguage() {
  return currentLanguage;
}

// Returns the normalized language so callers can use it as a state initializer.
export function setLanguage(value) {
  const next = normalizeLanguage(value);
  if (next !== currentLanguage) {
    currentLanguage = next;
    listeners.forEach((listener) => {
      try {
        listener(next);
      } catch (error) {
        console.error("[i18n] language listener failed", error);
      }
    });
  }
  return next;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Later registrations win; the coverage test reports keys that two namespaces translate differently.
export function registerTranslations(language, entries) {
  const target = dictionaries[normalizeLanguage(language)];
  let count = 0;
  Object.keys(entries || {}).forEach((key) => {
    const value = entries[key];
    if (typeof value !== "string") return;
    target[key] = value;
    dictionaryKeys.add(key);
    count += 1;
  });
  return count;
}

// The short-key dictionary of the original I18nContext (t("report"), t("save"), …).
export function registerLegacyTranslations(language, entries) {
  const target = legacy[normalizeLanguage(language)];
  let count = 0;
  Object.keys(entries || {}).forEach((key) => {
    const value = entries[key];
    if (typeof value !== "string") return;
    target[key] = value;
    count += 1;
  });
  return count;
}

export function registerMessageRules(language, rules) {
  const target = messageRules[normalizeLanguage(language)];
  (rules || []).forEach((rule) => {
    if (!rule || !(rule.pattern instanceof RegExp)) throw new Error("[i18n] a message rule needs a RegExp `pattern`");
    if (rule.pattern.global) throw new Error(`[i18n] message rule ${rule.pattern} must not use the g flag`);
    if (typeof rule.to !== "function" && typeof rule.to !== "string") throw new Error(`[i18n] message rule ${rule.pattern} needs a \`to\` string or function`);
    target.push(rule);
  });
  return target.length;
}

// Marks a canonical English string for later translation (identity at runtime).
export function tk(key) {
  return key;
}

export function hasTranslation(key, language = currentLanguage) {
  const lang = normalizeLanguage(language);
  const text = String(key);
  return has(dictionaries[lang], text) || has(legacy[lang], text);
}

export function lookup(key, language = currentLanguage) {
  const lang = normalizeLanguage(language);
  const own = dictionaries[lang][key];
  if (typeof own === "string") return own;
  // A key some dictionary knows is an English text: it stays itself (no entry in this language) and
  // never falls back to a legacy short-key value of the same spelling ("video" → "Video").
  if (dictionaryKeys.has(key)) return undefined;
  const legacyOwn = legacy[lang][key];
  if (typeof legacyOwn === "string") return legacyOwn;
  if (lang !== "en") {
    const english = legacy.en[key];
    if (typeof english === "string") return english;
  }
  return undefined;
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

export function placeholdersOf(text) {
  return [...String(text ?? "").matchAll(PLACEHOLDER)].map((match) => match[1]);
}

// Fills {name} tokens. Unknown tokens are kept verbatim. Object values (React elements) turn the result
// into an array of parts so the caller can render rich text.
export function interpolate(template, params) {
  const text = String(template ?? "");
  if (!params || typeof params !== "object") return text;
  const parts = [];
  let rich = false;
  let cursor = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!Object.prototype.hasOwnProperty.call(params, name)) continue;
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const value = params[name];
    if (value !== null && typeof value === "object") {
      rich = true;
      parts.push(value);
    } else {
      parts.push(value === undefined || value === null ? "" : String(value));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return rich ? parts : parts.join("");
}

// t(key, params?) — params may also be a plain string: the legacy t(key, fallback) form.
export function translate(key, params, language = currentLanguage) {
  if (key === null || key === undefined) return "";
  const text = String(key);
  const found = lookup(text, language);
  const base = found !== undefined ? found : typeof params === "string" ? params : text;
  return interpolate(base, params && typeof params === "object" ? params : null);
}

// tm(message) — runtime messages: exact dictionary entry, then the ordered regex rules, else unchanged.
// English uses its own small dictionary / rules for server messages that are written in Vietnamese.
export function translateMessage(message, language = currentLanguage) {
  if (typeof message !== "string" || message === "") return message;
  const lang = normalizeLanguage(language);
  const dictionary = dictionaries[lang];
  const trimmed = message.trim();
  const exact = dictionary[message] ?? dictionary[trimmed];
  if (typeof exact === "string") return exact;
  const helpers = {
    t: (key, params) => translate(key, params, lang),
    tm: (inner) => translateMessage(inner, lang)
  };
  for (const rule of messageRules[lang]) {
    const match = rule.pattern.exec(trimmed);
    if (!match) continue;
    const result = typeof rule.to === "function"
      ? rule.to(match, helpers)
      : rule.to.replace(/\{(\d+)\}/g, (_, index) => match[Number(index)] ?? "");
    if (typeof result === "string" && result) return result;
  }
  return message;
}

// Test hook: how many entries / rules a language has.
export function dictionarySize(language = currentLanguage) {
  const lang = normalizeLanguage(language);
  return { entries: Object.keys(dictionaries[lang]).length, legacy: Object.keys(legacy[lang]).length, rules: messageRules[lang].length };
}
