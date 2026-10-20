import { useEffect, useMemo, useState } from "react";
import { CloudDownload, Loader2, Pencil, RefreshCw, Save, Tags, Trash2, UserRound } from "lucide-react";
import api from "../api/api";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { tk } from "../i18n/index.js";

// The page serves two catalogs; every text that names the type is a full key per type (no concatenation).
const CATALOG_COPY = {
  artists: {
    title: tk("Artist"),
    description: tk("Manage artist catalog and see linked albums and songs."),
    edit: tk("Edit Artist"),
    create: tk("Create Artist"),
    namePlaceholder: tk("Artist name"),
    list: tk("Artist list"),
    searchPlaceholder: tk("Search artist..."),
    empty: tk("No artist yet."),
    updated: tk("Artist updated"),
    created: tk("Artist created"),
    deleted: tk("Artist deleted")
  },
  labels: {
    title: tk("Label"),
    description: tk("Manage label catalog and see linked albums and songs."),
    edit: tk("Edit Label"),
    create: tk("Create Label"),
    namePlaceholder: tk("Label name"),
    list: tk("Label list"),
    searchPlaceholder: tk("Search label..."),
    empty: tk("No label yet."),
    updated: tk("Label updated"),
    created: tk("Label created"),
    deleted: tk("Label deleted")
  }
};

export default function ContentIdCatalogPage({ type }) {
  const { canViewContentIdFull } = useAuth();
  const { t, tm } = useI18n();
  const isArtist = type === "artists";
  const endpoint = isArtist ? "/content-id/artists" : "/content-id/labels";
  const copy = CATALOG_COPY[isArtist ? "artists" : "labels"];
  const Icon = isArtist ? UserRound : Tags;
  const canManageCatalog = canViewContentIdFull;
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ id: null, name: "", display_name: "", notes: "" });
  const [message, setMessage] = useState("");
  const [syncingLabels, setSyncingLabels] = useState(false);

  const totals = useMemo(() => {
    return items.reduce((sum, item) => ({
      albums: sum.albums + Number(item.album_count || 0),
      songs: sum.songs + Number(item.song_count || 0)
    }), { albums: 0, songs: 0 });
  }, [items]);

  async function loadItems() {
    const res = await api.get(endpoint, { params: { search } });
    setItems(res.data[isArtist ? "artists" : "labels"] || []);
  }

  async function saveItem(event) {
    event.preventDefault();
    const payload = {
      name: form.name,
      display_name: form.display_name,
      notes: form.notes
    };

    if (form.id) {
      await api.put(`${endpoint}/${form.id}`, payload);
      setMessage(copy.updated);
    } else {
      await api.post(endpoint, payload);
      setMessage(copy.created);
    }

    setForm({ id: null, name: "", display_name: "", notes: "" });
    loadItems();
  }

  async function deleteItem(item) {
    if (!window.confirm(t("Delete {name}?", { name: item.name }))) return;
    try {
      await api.delete(`${endpoint}/${item.id}`);
      setMessage(copy.deleted);
      loadItems();
    } catch (error) {
      setMessage(error.response?.data?.message || tk("Delete failed"));
    }
  }

  async function syncCmsLabels() {
    if (isArtist || syncingLabels) return;
    setSyncingLabels(true);
    setMessage("");
    try {
      const res = await api.post("/content-id/labels/sync-cms");
      const created = res.data.created || 0;
      const updated = res.data.updated || 0;
      const failedItems = (res.data.cmsResults || []).filter((item) => !item.ok);
      const failures = failedItems.map((item) => `${item.cmsName}: ${tm(item.message) || t("Unknown error")}`).join("; ");
      setMessage(failedItems.length
        ? t("CMS labels synced. Created {created}, updated {updated}. Failed: {failures}", { created, updated, failures })
        : t("CMS labels synced. Created {created}, updated {updated}.", { created, updated }));
      await loadItems();
    } catch (error) {
      setMessage(error.response?.data?.message || tk("Could not sync CMS labels."));
    } finally {
      setSyncingLabels(false);
    }
  }

  function editItem(item) {
    setForm({
      id: item.id,
      name: item.name || "",
      display_name: item.display_name || "",
      notes: item.notes || ""
    });
  }

  useEffect(() => {
    loadItems();
  }, [type]);

  return (
    <div className="p-6 space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700">
              <Icon size={14} /> Content ID
            </p>
            <h1 className="mt-3 text-3xl font-black text-slate-950">{t(copy.title)}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {t(copy.description)}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!isArtist && canManageCatalog && (
              <button
                type="button"
                onClick={syncCmsLabels}
                disabled={syncingLabels}
                className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-black text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {syncingLabels ? <Loader2 className="animate-spin" size={16} /> : <CloudDownload size={16} />}
                {t("Sync CMS labels")}
              </button>
            )}
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-xs font-black text-slate-400">{t("TOTAL")}</p>
              <p className="text-xl font-black text-slate-950">{items.length}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-xs font-black text-slate-400">{t("ALBUMS")}</p>
              <p className="text-xl font-black text-blue-600">{totals.albums}</p>
            </div>
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-xs font-black text-slate-400">{t("SONGS")}</p>
              <p className="text-xl font-black text-emerald-600">{totals.songs}</p>
            </div>
          </div>
        </div>
        {message && <div className="mt-4 rounded-2xl bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{tm(message)}</div>}
      </section>

      <section className={canManageCatalog ? "grid gap-5 xl:grid-cols-[420px_1fr]" : "grid gap-5"}>
        {canManageCatalog && (
          <form onSubmit={saveItem} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-black text-slate-950">{form.id ? t(copy.edit) : t(copy.create)}</h2>
            <div className="mt-4 space-y-3">
              <input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder={t(copy.namePlaceholder)}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3"
                required
              />
              <input
                value={form.display_name}
                onChange={(event) => setForm((current) => ({ ...current, display_name: event.target.value }))}
                placeholder={t("Display name")}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3"
              />
              <textarea
                value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                rows={5}
                placeholder={t("Internal notes")}
                className="w-full rounded-2xl border border-slate-200 p-4"
              />
              <div className="flex gap-2">
                <button className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-black text-white">
                  <Save size={17} /> {t("Save")}
                </button>
                {form.id && (
                  <button type="button" onClick={() => setForm({ id: null, name: "", display_name: "", notes: "" })} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700">
                    {t("Cancel")}
                  </button>
                )}
              </div>
            </div>
          </form>
        )}

        <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
            <h2 className="text-lg font-black text-slate-950">{t(copy.list)}</h2>
            <div className="flex gap-2">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t(copy.searchPlaceholder)} className="rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
              <button onClick={loadItems} className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-black text-slate-700">
                <RefreshCw size={15} /> {t("Refresh")}
              </button>
            </div>
          </div>

          <div className="overflow-auto">
            <table className="min-w-[860px] w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t(copy.title)}</th>
                  <th className="px-4 py-3">{t("Notes")}</th>
                  <th className="px-4 py-3">{t("Albums")}</th>
                  <th className="px-4 py-3">{t("Songs")}</th>
                  <th className="px-4 py-3">{t("Updated")}</th>
                  {canManageCatalog && <th className="px-4 py-3">{t("Action")}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="px-4 py-3">
                      <p className="font-black text-slate-950">{item.display_name || item.name}</p>
                      <p className="text-xs text-slate-500">{item.name}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{item.notes || "-"}</td>
                    <td className="px-4 py-3 font-black text-blue-600">{item.album_count || 0}</td>
                    <td className="px-4 py-3 font-black text-emerald-600">{item.song_count || 0}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{item.updated_at || item.created_at}</td>
                    {canManageCatalog && (
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button onClick={() => editItem(item)} className="rounded-xl border border-slate-200 p-2 text-slate-600">
                            <Pencil size={15} />
                          </button>
                          <button onClick={() => deleteItem(item)} className="rounded-xl bg-red-50 p-2 text-red-500">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={canManageCatalog ? 6 : 5} className="px-4 py-12 text-center text-slate-500">{t(copy.empty)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
