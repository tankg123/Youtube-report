import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ChevronDown, ChevronRight, LockKeyhole, PanelLeft } from "lucide-react";
import api from "../api/api";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { useSystemSettings } from "../context/SystemSettingsContext";
import { Button, Field, TextInput, Toggle } from "./assetDelivery/shared";

function MenuItem({ item, hidden, parentEnabled = true, saving, save }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const enabled = parentEnabled && !hidden.includes(item.id);
  return (
    <li>
      <div className="flex min-h-11 items-center gap-3 py-1">
        {item.children ? (
          <button type="button" aria-expanded={expanded} aria-label={t("Pages in {group}", { group: t(item.label) })}
            className="flex flex-1 items-center gap-2 py-2 text-left text-sm font-bold" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}{t(item.label)}
            <span className="text-xs text-slate-500">({item.children.length})</span>
          </button>
        ) : <span className="flex-1 pl-6 text-sm">{t(item.label)}</span>}
        <Toggle checked={enabled} disabled={!parentEnabled || saving} size="sm"
          label={<span className="sr-only">{t(item.label)}</span>} onChange={(visible) => save(item.id, visible)} />
      </div>
      {item.children && expanded && (
        <ul className="mb-2 ml-2 border-l border-slate-200 pl-4">
          {item.children.map((child) => <MenuItem key={child.id} item={child} hidden={hidden}
            parentEnabled={enabled} saving={saving} save={save} />)}
        </ul>
      )}
    </li>
  );
}

function SidebarEditor() {
  const { t, tm, tk } = useI18n();
  const { setSidebar } = useSystemSettings();
  const [session, setSession] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const expires = session?.expires;
  useEffect(() => {
    if (!expires) return;
    const lock = () => setSession(null);
    const timer = window.setTimeout(lock, Math.max(0, expires - Date.now()));
    window.addEventListener("pagehide", lock);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", lock); };
  }, [expires]);

  async function unlock(event) {
    event.preventDefault();
    if (saving) return;
    const input = event.currentTarget.elements.namedItem("sidebar-code");
    const code = input.value;
    input.value = "";
    setSaving(true);
    setError("");
    try {
      const { data } = await api.post("/settings/sidebar/unlock", { code });
      setSession({ grant: data.grant, expires: Date.now() + data.expires_in * 1000, menu: data.menu, hidden: data.hidden });
      setSidebar(data.sidebar);
    } catch (err) {
      setError(err.response?.data?.message || tk("Could not unlock sidebar settings."));
    } finally {
      setSaving(false);
    }
  }

  async function save(id, visible) {
    if (saving || !session) return;
    setSaving(true);
    setError("");
    try {
      const { data } = await api.put("/settings/sidebar", { id, visible, grant: session.grant });
      setSession((current) => current && { ...current, hidden: data.hidden });
      setSidebar(data.sidebar);
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 503) setSession(null);
      setError(err.response?.data?.message || tk("Could not update sidebar visibility."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stage p-4 lg:p-8">
      <section id="sidebar" className="surface-3d max-w-3xl space-y-4 rounded-3xl border border-slate-200 bg-white p-6">
        <h1 className="flex items-center gap-2 text-2xl font-black"><PanelLeft size={22} />{t("Sidebar visibility")}</h1>
        {error && <p role="alert" className="text-sm font-semibold text-red-600">{tm(error)}</p>}
        {session ? <>
          <p className="text-sm text-slate-600">{t("Choose which pages appear in the menu for all users. Showing a group restores its individual page choices.")}</p>
          <ul className="divide-y divide-slate-200">
            {session.menu.map((item) => <MenuItem key={item.id} item={item} hidden={session.hidden} saving={saving} save={save} />)}
          </ul>
        </> : (
          <form onSubmit={unlock} className="max-w-sm space-y-4">
            <Field label={t("Sidebar confirmation code")} htmlFor="sidebar-code">
              <TextInput id="sidebar-code" type="password" autoComplete="off" required readOnly={saving} />
            </Field>
            <Button type="submit" icon={LockKeyhole} loading={saving}>{t("Unlock sidebar settings")}</Button>
          </form>
        )}
      </section>
    </div>
  );
}

export default function SidebarSettings() {
  const location = useLocation();
  const { user } = useAuth();
  return <SidebarEditor key={`${user.id}:${location.key}`} />;
}
