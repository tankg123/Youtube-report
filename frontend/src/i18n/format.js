// Locale-aware display formatting. Dates follow the UI language (vi-VN: 17/10/2026, en-US: 10/17/2026);
// numbers are formatted only through formatNumber so a page can opt in explicitly.
import { getLanguage, normalizeLanguage } from "./core.js";

export function localeOf(language = getLanguage()) {
  return normalizeLanguage(language) === "vi" ? "vi-VN" : "en-US";
}

// Accepts Date objects, ISO strings, SQLite "YYYY-MM-DD HH:MM:SS" (UTC) and plain "YYYY-MM-DD" (a local
// calendar day, so it never shifts across midnight). Returns null when the value is not a date.
export function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const text = String(value).trim();
  const dayOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayOnly) return new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3]));
  const sqlite = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  const date = sqlite ? new Date(`${sqlite[1]}T${sqlite[2]}Z`) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DATE_OPTIONS = Object.freeze({ year: "numeric", month: "2-digit", day: "2-digit" });
const DATE_TIME_OPTIONS = Object.freeze({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function formatDate(value, language = getLanguage(), options) {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(localeOf(language), options || DATE_OPTIONS).format(date);
}

export function formatDateTime(value, language = getLanguage(), options) {
  const date = toDate(value);
  if (!date) return "";
  const lang = normalizeLanguage(language);
  return new Intl.DateTimeFormat(localeOf(lang), options || (lang === "vi" ? { ...DATE_TIME_OPTIONS, hour12: false } : DATE_TIME_OPTIONS)).format(date);
}

export function formatNumber(value, language = getLanguage(), options) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat(localeOf(language), options).format(number);
}

// Country / territory name in the UI language from an ISO 3166-1 alpha-2 code ("VN" → "Việt Nam").
// Falls back to the given English name, then to the code, when the runtime lacks Intl.DisplayNames.
export function regionName(code, language = getLanguage(), fallback = "") {
  const region = String(code || "").toUpperCase();
  if (!region) return fallback || "";
  try {
    const names = new Intl.DisplayNames([localeOf(language)], { type: "region", fallback: "none" });
    return names.of(region) || fallback || region;
  } catch {
    return fallback || region;
  }
}
