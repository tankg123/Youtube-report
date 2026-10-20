import { cloneElement, createContext, isValidElement, useContext, useEffect, useMemo, useState } from "react";
import { normalizeLanguage, setLanguage as setCoreLanguage, tk, translate, translateMessage } from "../i18n/index.js";
import { formatDate, formatDateTime, formatNumber, localeOf, regionName } from "../i18n/format.js";
import { translations } from "../i18n/legacy.js";

// The short-key dictionary (t("report"), t("save"), …) stays importable from here.
export { translations };

const I18nContext = createContext(null);
const STORAGE_KEY = "language";

function readStoredLanguage() {
  try {
    return normalizeLanguage(localStorage.getItem(STORAGE_KEY) || "en");
  } catch {
    return "en";
  }
}

// translate() returns an array when a {placeholder} received a React element: give each element a key.
function withKeys(result) {
  if (!Array.isArray(result)) return result;
  return result.map((part, index) => (isValidElement(part) && part.key == null ? cloneElement(part, { key: index }) : part));
}

export function I18nProvider({ children }) {
  // The core store is set in the initializer so plain modules (utils, constants) translate in the right
  // language from the very first render.
  const [language, setLanguageState] = useState(() => setCoreLanguage(readStoredLanguage()));

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo(() => {
    function setLanguage(next) {
      const normalized = normalizeLanguage(next);
      try {
        localStorage.setItem(STORAGE_KEY, normalized);
      } catch {
        // storage unavailable (private mode): the choice lasts for this session only
      }
      setCoreLanguage(normalized);
      setLanguageState(normalized);
    }

    return {
      language,
      setLanguage,
      locale: localeOf(language),
      // t("English text", { count }) → current language; the English text is the key.
      t: (key, params) => withKeys(translate(key, params, language)),
      // tm(message) → runtime / server message in the current language (exact entry, then rules).
      tm: (message) => translateMessage(message, language),
      // tk("English text") → marks a canonical string kept in state or a constant (identity).
      tk,
      pick: (copy) => copy?.[language] || copy?.en || {},
      formatDate: (value, options) => formatDate(value, language, options),
      formatDateTime: (value, options) => formatDateTime(value, language, options),
      formatNumber: (value, options) => formatNumber(value, language, options),
      regionName: (code, fallback) => regionName(code, language, fallback)
    };
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
