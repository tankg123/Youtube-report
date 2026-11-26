import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import api from "../api/api";
import { applyAccentPalette, DEFAULT_ACCENT_ID } from "../theme/accentPalettes";

const SystemSettingsContext = createContext(null);
const LOGO_COLORS = ["#2f8ccf", "#0f9f6e", "#7c3aed", "#ef4444", "#f59e0b", "#0891b2", "#db2777"];

export const defaultSystemSettings = {
  brand_name: "ANS Network",
  brand_subtitle: "MCN Manager System",
  logo_mode: "random",
  logo_data_url: "",
  web_title: "ANS Network",
  favicon_data_url: "",
  export_template_language: "vi",
  ui_accent: DEFAULT_ACCENT_ID,
  revenue_tax_us_br_enabled: "0",
  revenue_tax_us_enabled: "0",
  revenue_tax_br_enabled: "0"
};

function ensureFaviconLink() {
  let link = document.querySelector("link[rel='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  return link;
}

export function SystemSettingsProvider({ children }) {
  const [settings, setSettings] = useState(defaultSystemSettings);
  const [sidebar, setSidebar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logoColor] = useState(() => LOGO_COLORS[Math.floor(Math.random() * LOGO_COLORS.length)]);

  const loadSettings = useCallback((signal) => api.get("/settings/system", { signal })
    .then(({ data }) => {
      if (signal?.aborted) return;
      setSettings({ ...defaultSystemSettings, ...(data.settings || {}) });
      setSidebar(data.sidebar || null);
    })
    .catch(() => { if (!signal?.aborted) setSettings(defaultSystemSettings); })
    .finally(() => { if (!signal?.aborted) setLoading(false); }), []);

  useEffect(() => {
    const controller = new AbortController();
    loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  useEffect(() => {
    document.title = settings.web_title || settings.brand_name || defaultSystemSettings.web_title;
    applyAccentPalette(settings.ui_accent);
    if (settings.favicon_data_url) {
      ensureFaviconLink().href = settings.favicon_data_url;
    }
  }, [settings]);

  const hiddenItems = useMemo(() => new Set(sidebar?.hidden), [sidebar]);

  const value = useMemo(
    () => ({
      settings,
      loading,
      logoColor,
      setSettings,
      sidebar,
      setSidebar,
      isSidebarVisible: (path) => Boolean(sidebar) && !hiddenItems.has(path),
      refreshSettings: () => loadSettings()
    }),
    [settings, loading, logoColor, sidebar, hiddenItems, loadSettings]
  );

  return <SystemSettingsContext.Provider value={value}>{children}</SystemSettingsContext.Provider>;
}

export function useSystemSettings() {
  const context = useContext(SystemSettingsContext);
  if (!context) {
    throw new Error("useSystemSettings must be used inside SystemSettingsProvider");
  }
  return context;
}
