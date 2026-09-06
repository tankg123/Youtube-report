import { useEffect, useState } from "react";
import { Check, ImageUp, Loader2, MonitorCog, Palette, Percent, Save, Sparkles, Upload } from "lucide-react";
import api from "../api/api";
import { useSystemSettings } from "../context/SystemSettingsContext";
import { useI18n } from "../context/I18nContext";
import { ACCENT_PALETTES, DEFAULT_ACCENT_ID, getAccentPalette } from "../theme/accentPalettes";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function SettingsPage() {
  const { settings, setSettings } = useSystemSettings();
  const { t } = useI18n();
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const useUploadedLogo = form.logo_mode === "upload" && form.logo_data_url;
  const selectedAccent = getAccentPalette(form.ui_accent);
  const revenueTaxEnabled = String(form.revenue_tax_us_br_enabled || "0") === "1";

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
      setMessage("Settings saved");
    } catch (error) {
      setMessage(error.response?.data?.message || "Could not save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-page page-stage p-4 lg:p-8 space-y-6">
      <section className="surface-3d rounded-3xl bg-white border border-slate-200 overflow-hidden">
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
              {message}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-[260px_1fr] gap-6">
            <div className="surface-3d-soft rounded-3xl border border-slate-200 bg-slate-50 p-5 text-center">
              <div
                className="mx-auto w-32 h-32 rounded-full flex items-center justify-center overflow-hidden shadow-lg"
                style={{ backgroundColor: useUploadedLogo ? "transparent" : "#2f8ccf" }}
              >
                {useUploadedLogo ? (
                  <img src={form.logo_data_url} alt="Brand logo" className="w-full h-full object-cover" />
                ) : (
                  <img src="https://revenue.ansnetwork.vn/images/logo-slideBar.png" alt="ANS" className="w-20 h-20 object-contain" />
                )}
              </div>
              <p className="mt-4 font-black text-slate-950">{form.brand_name || "ANS Network"}</p>
              <p className="text-sm font-bold text-slate-500">MCN Manager System</p>
            </div>

            <div className="space-y-5">
              <label className="block">
                <span className="text-sm font-black text-slate-700">Brand name</span>
                <input
                  value={form.brand_name || ""}
                  onChange={(event) => setForm({ ...form, brand_name: event.target.value })}
                  className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 bg-white"
                  placeholder="ANS Network"
                  required
                />
              </label>

              <div>
                <p className="text-sm font-black text-slate-700 mb-2">Sidebar logo</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, logo_mode: "random" })}
                    className={`rounded-2xl border px-4 py-4 text-left font-black ${form.logo_mode === "random" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700"}`}
                  >
                    Random color logo
                    <span className="block mt-1 text-xs font-bold text-slate-500">Use the current random round color.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, logo_mode: "upload" })}
                    className={`rounded-2xl border px-4 py-4 text-left font-black ${form.logo_mode === "upload" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700"}`}
                  >
                    Uploaded logo
                    <span className="block mt-1 text-xs font-bold text-slate-500">Use your uploaded logo image.</span>
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="text-sm font-black text-slate-700">Upload sidebar logo</span>
                <div className="mt-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 flex items-center gap-3">
                  <ImageUp size={18} className="text-slate-400" />
                  <input type="file" accept="image/*" onChange={(event) => handleFile("logo_data_url", event.target.files?.[0])} />
                </div>
              </label>
            </div>
          </div>

          <section className="theme-picker surface-3d-soft rounded-3xl border border-slate-200 bg-slate-50 p-5 lg:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <div className="ui-soft flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl">
                  <Palette size={21} />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-black text-slate-950">Primary interface color</h2>
                    <span className="ui-soft rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider">System wide</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    Choose the accent used for navigation, primary actions and focus states. Light green is the default.
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
                aria-label={`${selectedAccent.label} preview`}
              >
                <Sparkles size={16} />
                Live preview
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Primary interface color">
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
                      <span className="block truncate text-sm font-black text-slate-900">{palette.label}</span>
                      <span className="mt-0.5 block truncate text-xs font-semibold text-slate-500">{palette.description}</span>
                    </span>
                    {palette.id === DEFAULT_ACCENT_ID && !selected && (
                      <span className="rounded-full bg-white/80 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-slate-500">Default</span>
                    )}
                    {selected && (
                      <span className="theme-swatch-check" aria-label="Selected">
                        <Check size={14} strokeWidth={3} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="surface-3d-soft rounded-3xl border border-slate-200 bg-slate-50 p-5 lg:p-6">
            <div className="flex items-start gap-3">
              <div className="ui-soft flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl">
                <Percent size={21} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-black text-slate-950">US / BR revenue tax</h2>
                  <span className="ui-soft rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider">Revenue sharing</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  Withhold US 30% and Brazil 14% from channel revenue before the share rate is applied. Each group opts in separately,
                  Manager Report accepts Revenue US / Revenue BR columns, and Excel exports can add the tax columns.
                </p>
                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                  <input
                    type="checkbox"
                    checked={revenueTaxEnabled}
                    onChange={(event) => setForm({ ...form, revenue_tax_us_br_enabled: event.target.checked ? "1" : "0" })}
                    className="mt-1 h-4 w-4 rounded border-slate-300"
                  />
                  <span>
                    <span className="block font-black text-slate-900">Enable US / BR tax calculation</span>
                    <span className="mt-1 block text-sm text-slate-500">
                      When off, every group is calculated without tax, even if the group has the tax option ticked.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 border-t border-slate-200 pt-6">
            <label className="block">
              <span className="text-sm font-black text-slate-700">Website title</span>
              <input
                value={form.web_title || ""}
                onChange={(event) => setForm({ ...form, web_title: event.target.value })}
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 bg-white"
                placeholder="ANS Network"
                required
              />
            </label>

            <label className="block">
              <span className="text-sm font-black text-slate-700">Website icon</span>
              <div className="mt-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 flex items-center gap-3">
                {form.favicon_data_url ? (
                  <img src={form.favicon_data_url} alt="Website icon" className="w-7 h-7 rounded-lg object-contain" />
                ) : (
                  <Upload size={18} className="text-slate-400" />
                )}
                <input type="file" accept="image/*" onChange={(event) => handleFile("favicon_data_url", event.target.files?.[0])} />
              </div>
            </label>

            <label className="block">
              <span className="text-sm font-black text-slate-700">Default export template</span>
              <select
                value={form.export_template_language || "vi"}
                onChange={(event) => setForm({ ...form, export_template_language: event.target.value })}
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 bg-white font-bold text-slate-800"
              >
                <option value="vi">Vietnamese template (current)</option>
                <option value="en">English template</option>
              </select>
              <span className="mt-2 block text-xs font-bold text-slate-500">
                Used automatically for Excel and invoice PDF exports.
              </span>
            </label>
          </div>

          <div className="flex justify-end border-t border-slate-200 pt-6">
            <button
              disabled={saving}
              className="ui-primary btn-3d rounded-2xl px-6 py-3 font-black text-white flex items-center gap-2 disabled:opacity-60"
            >
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              Save settings
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
