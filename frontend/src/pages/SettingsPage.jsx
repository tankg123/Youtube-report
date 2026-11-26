import { useEffect, useState } from "react";
import { Check, ImageUp, Loader2, MonitorCog, Palette, Percent, Save, Sparkles, Upload } from "lucide-react";
import api from "../api/api";
import { useSystemSettings } from "../context/SystemSettingsContext";
import { useI18n } from "../context/I18nContext";
import { ACCENT_PALETTES, DEFAULT_ACCENT_ID, getAccentPalette } from "../theme/accentPalettes";
import BrandLogoImage from "../components/BrandLogoImage";
import OwnershipApiSettings from "./OwnershipApiSettings";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function SettingsPage() {
  const { settings, setSettings, logoColor, isSidebarVisible } = useSystemSettings();
  const showGeneral = isSidebarVisible("/settings/system#general");
  const showBranding = isSidebarVisible("/settings/system#general/branding");
  const showColor = isSidebarVisible("/settings/system#general/color");
  const showTax = isSidebarVisible("/settings/system#general/tax");
  const showWebsite = isSidebarVisible("/settings/system#general/website");
  const showOwnershipApi = isSidebarVisible("/settings/system#ownership-api");
  const { t, tm, tk } = useI18n();
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const useUploadedLogo = form.logo_mode === "upload" && form.logo_data_url;
  const selectedAccent = getAccentPalette(form.ui_accent);
  const revenueTaxUsEnabled = String(form.revenue_tax_us_enabled || "0") === "1";
  const revenueTaxBrEnabled = String(form.revenue_tax_br_enabled || "0") === "1";

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  async function handleFile(field, file) {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    setForm((current) => ({ ...current, [field]: dataUrl }));
  }

  async function saveSettings(event) {
    event.preventDefault();
    try {
      setSaving(true);
      setMessage("");
      const res = await api.put("/settings/system", form);
      const nextSettings = res.data.settings || form;
      setSettings(nextSettings);
      setMessage(tk("Settings saved"));
    } catch (error) {
      setMessage(error.response?.data?.message || tk("Could not save settings"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-page page-stage p-4 lg:p-8 space-y-6">
      {showGeneral && (showBranding || showColor || showTax || showWebsite) && <section className="surface-3d rounded-3xl bg-white border border-slate-200 overflow-hidden">
        <div className="surface-3d-header px-6 py-5 border-b border-slate-200 flex items-center gap-3">
          <div className="ui-primary icon-cube w-11 h-11 rounded-2xl text-white flex items-center justify-center">
            <MonitorCog size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-950">{t("settings")}</h1>
            <p className="text-sm text-slate-500">{t("systemSettings")}</p>
          </div>
        </div>

        <form onSubmit={saveSettings} className="p-6 space-y-6">
          {message && (
            <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 font-bold text-blue-700">
              {tm(message)}
            </div>
          )}

          {showBranding && <div className="grid grid-cols-1 xl:grid-cols-[260px_1fr] gap-6">
            <div className="surface-3d-soft rounded-3xl border border-slate-200 bg-slate-50 p-5 text-center">
              <div
                className="mx-auto w-32 h-32 rounded-full flex items-center justify-center overflow-hidden shadow-lg"
                style={{ backgroundColor: useUploadedLogo ? "transparent" : logoColor }}
              >
                <BrandLogoImage
                  src={useUploadedLogo ? form.logo_data_url : undefined}
                  alt={form.brand_name || "ANS Network"}
                  className={useUploadedLogo ? "w-full h-full object-cover" : "w-20 h-20 object-contain"}
                />
              </div>
              <p className="mt-4 font-black text-slate-950">{form.brand_name || "ANS Network"}</p>
              <p className="text-sm font-bold text-slate-500">{t("MCN Manager System")}</p>
            </div>

            <div className="space-y-5">
              <label className="block">
                <span className="text-sm font-black text-slate-700">{t("Brand name")}</span>
                <input
                  value={form.brand_name || ""}
                  onChange={(event) => setForm({ ...form, brand_name: event.target.value })}
                  className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 bg-white"
                  placeholder="ANS Network"
                  required
                />
              </label>

              <div>
                <p className="text-sm font-black text-slate-700 mb-2">{t("Sidebar logo")}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, logo_mode: "random" })}
                    className={`rounded-2xl border px-4 py-4 text-left font-black ${form.logo_mode === "random" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700"}`}
                  >
                    {t("Random color logo")}
                    <span className="block mt-1 text-xs font-bold text-slate-500">{t("Use the current random round color.")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, logo_mode: "upload" })}
                    className={`rounded-2xl border px-4 py-4 text-left font-black ${form.logo_mode === "upload" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700"}`}
                  >
                    {t("Uploaded logo")}
                    <span className="block mt-1 text-xs font-bold text-slate-500">{t("Use your uploaded logo image.")}</span>
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="text-sm font-black text-slate-700">{t("Upload sidebar logo")}</span>
                <div className="mt-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 flex items-center gap-3">
                  <ImageUp size={18} className="text-slate-400" />
                  <input type="file" accept="image/*" onChange={(event) => handleFile("logo_data_url", event.target.files?.[0])} />
                </div>
              </label>
            </div>
          </div>}

          {showColor && <section className="theme-picker surface-3d-soft rounded-3xl border border-slate-200 bg-slate-50 p-5 lg:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <div className="ui-soft flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl">
                  <Palette size={21} />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-black text-slate-950">{t("Primary interface color")}</h2>
                    <span className="ui-soft rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider">{t("System wide")}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    {t("Choose the accent used for navigation, primary actions and focus states. Light green is the default.")}
                  </p>
                </div>
              </div>

              <div
                className="theme-live-preview"
                style={{
                  "--preview-primary": selectedAccent.primary,
                  "--preview-soft": selectedAccent.soft,
                  "--preview-border": selectedAccent.border
                }}
                aria-label={t("{accent} preview", { accent: t(selectedAccent.label) })}
              >
                <Sparkles size={16} />
                {t("Live preview")}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label={t("Primary interface color")}>
              {ACCENT_PALETTES.map((palette) => {
                const selected = (form.ui_accent || DEFAULT_ACCENT_ID) === palette.id;
                return (
                  <button
                    key={palette.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setForm({ ...form, ui_accent: palette.id })}
                    className={`theme-swatch-card ${selected ? "is-selected" : ""}`}
                    style={{
                      "--swatch": palette.swatch,
                      "--swatch-soft": palette.soft,
                      "--swatch-border": palette.border,
                      "--swatch-ink": palette.ink
                    }}
                  >
                    <span className="theme-swatch-orb" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm font-black text-slate-900">{t(palette.label)}</span>
                      <span className="mt-0.5 block truncate text-xs font-semibold text-slate-500">{t(palette.description)}</span>
                    </span>
                    {palette.id === DEFAULT_ACCENT_ID && !selected && (
                      <span className="rounded-full bg-white/80 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-slate-500">{t("Default")}</span>
                    )}
                    {selected && (
                      <span className="theme-swatch-check" aria-label={t("Selected")}>
                        <Check size={14} strokeWidth={3} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>}

          {showTax && <section className="surface-3d-soft rounded-3xl border border-slate-200 bg-slate-50 p-5 lg:p-6">
            <div className="flex items-start gap-3">
              <div className="ui-soft flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl">
                <Percent size={21} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-black text-slate-950">{t("US / BR revenue tax")}</h2>
                  <span className="ui-soft rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider">{t("Revenue sharing")}</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  {t("Withhold US 30% and/or Brazil 14% from channel revenue before the share rate is applied. Switch each tax on separately: each group still opts in, Manager Report reads the matching Revenue US / Revenue BR column, and Excel exports add only the columns of the taxes that are on.")}
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                    <input
                      type="checkbox"
                      checked={revenueTaxUsEnabled}
                      onChange={(event) => setForm({ ...form, revenue_tax_us_enabled: event.target.checked ? "1" : "0" })}
                      className="mt-1 h-4 w-4 rounded border-slate-300"
                    />
                    <span>
                      <span className="block font-black text-slate-900">{t("US tax (30%)")}</span>
                      <span className="mt-1 block text-sm text-slate-500">{t("Withhold 30% of the Revenue US column of every group that applies tax.")}</span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                    <input
                      type="checkbox"
                      checked={revenueTaxBrEnabled}
                      onChange={(event) => setForm({ ...form, revenue_tax_br_enabled: event.target.checked ? "1" : "0" })}
                      className="mt-1 h-4 w-4 rounded border-slate-300"
                    />
                    <span>
                      <span className="block font-black text-slate-900">{t("Brazil tax (14%)")}</span>
                      <span className="mt-1 block text-sm text-slate-500">{t("Withhold 14% of the Revenue BR column of every group that applies tax.")}</span>
                    </span>
                  </label>
                </div>
                <p className="mt-3 text-xs font-semibold text-slate-500">
                  {t("When both are off, every group is calculated without tax, even if the group has the tax option ticked.")}
                </p>
              </div>
            </div>
          </section>}

          {showWebsite && <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 border-t border-slate-200 pt-6">
            <label className="block">
              <span className="text-sm font-black text-slate-700">{t("Website title")}</span>
              <input
                value={form.web_title || ""}
                onChange={(event) => setForm({ ...form, web_title: event.target.value })}
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 bg-white"
                placeholder="ANS Network"
                required
              />
            </label>

            <label className="block">
              <span className="text-sm font-black text-slate-700">{t("Website icon")}</span>
              <div className="mt-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 flex items-center gap-3">
                {form.favicon_data_url ? (
                  <img src={form.favicon_data_url} alt={t("Website icon")} className="w-7 h-7 rounded-lg object-contain" />
                ) : (
                  <Upload size={18} className="text-slate-400" />
                )}
                <input type="file" accept="image/*" onChange={(event) => handleFile("favicon_data_url", event.target.files?.[0])} />
              </div>
            </label>

            <label className="block">
              <span className="text-sm font-black text-slate-700">{t("Default export template")}</span>
              <select
                value={form.export_template_language || "vi"}
                onChange={(event) => setForm({ ...form, export_template_language: event.target.value })}
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 bg-white font-bold text-slate-800"
              >
                <option value="vi">{t("Vietnamese template (current)")}</option>
                <option value="en">{t("English template")}</option>
              </select>
              <span className="mt-2 block text-xs font-bold text-slate-500">
                {t("Used automatically for Excel and invoice PDF exports.")}
              </span>
            </label>
          </div>}

          <div className="flex justify-end border-t border-slate-200 pt-6">
            <button
              disabled={saving}
              className="ui-primary btn-3d rounded-2xl px-6 py-3 font-black text-white flex items-center gap-2 disabled:opacity-60"
            >
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              {t("Save settings")}
            </button>
          </div>
        </form>
      </section>}
      {showOwnershipApi && <OwnershipApiSettings />}
    </div>
  );
}
