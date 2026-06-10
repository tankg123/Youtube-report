import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Edit3, KeyRound, Loader2, Network, Plus, ShieldCheck, Trash2, Unplug, X } from "lucide-react";
import api from "../api/api";

const emptyNetwork = {
  name: "",
  network_code: "",
  description: ""
};

const apiLabels = [
  { label: "Content ID API", scopes: ["https://www.googleapis.com/auth/youtubepartner", "https://www.googleapis.com/auth/youtubepartner-channel-audit"] },
  { label: "Analytics API", scopes: ["https://www.googleapis.com/auth/yt-analytics.readonly", "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"] },
  { label: "YouTube Data API", scopes: ["https://www.googleapis.com/auth/youtube.readonly"] },
  { label: "YouTube CMS", scopes: ["https://www.googleapis.com/auth/youtube"] }
];

function statusClass(status) {
  if (status === "connected") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "pending") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "error") return "bg-red-50 text-red-700 border-red-200";
  return "bg-slate-50 text-slate-600 border-slate-200";
}

function parseGrantedApis(scopes = "") {
  const granted = new Set(String(scopes || "").split(/\s+/).filter(Boolean));
  return apiLabels.filter((item) => item.scopes.some((scope) => granted.has(scope)));
}

export default function NetworkPage() {
  const [networks, setNetworks] = useState([]);
  const [form, setForm] = useState(emptyNetwork);
  const [editing, setEditing] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [authingId, setAuthingId] = useState(null);
  const [message, setMessage] = useState("");

  const sortedNetworks = useMemo(
    () => [...networks].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" })),
    [networks]
  );

  async function fetchNetworks() {
    try {
      setLoading(true);
      const res = await api.get("/reports/networks");
      setNetworks(res.data.data || []);
    } catch (error) {
      setMessage(error.response?.data?.message || "Could not load networks");
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(emptyNetwork);
    setModalOpen(true);
  }

  function openEdit(network) {
    setEditing(network);
    setForm({
      name: network.name || "",
      network_code: network.network_code || "",
      description: network.description || ""
    });
    setModalOpen(true);
  }

  async function saveNetwork(e) {
    e.preventDefault();

    try {
      setSaving(true);
      if (editing) {
        await api.put(`/reports/networks/${editing.id}`, form);
        setMessage("Network updated");
      } else {
        await api.post("/reports/networks", form);
        setMessage("Network created");
      }

      setModalOpen(false);
      await fetchNetworks();
    } catch (error) {
      setMessage(error.response?.data?.message || error.response?.data?.error || "Could not save network");
    } finally {
      setSaving(false);
    }
  }

  async function deleteNetwork(id) {
    if (!window.confirm("Delete this network? Imported report rows for this network will also be deleted.")) return;

    try {
      await api.delete(`/reports/networks/${id}`);
      setMessage("Network deleted");
      await fetchNetworks();
    } catch (error) {
      setMessage(error.response?.data?.message || "Could not delete network");
    }
  }

  async function startCmsAuth(network) {
    try {
      setAuthingId(network.id);
      const res = await api.get(`/reports/networks/${network.id}/cms-auth-url`);
      const authUrl = res.data?.data?.url;
      if (!authUrl) throw new Error("Google auth URL was not returned");
      window.location.href = authUrl;
    } catch (error) {
      setMessage(error.response?.data?.error || error.response?.data?.message || error.message || "Could not start CMS auth");
    } finally {
      setAuthingId(null);
    }
  }

  async function disconnectCms(network) {
    if (!window.confirm(`Disconnect CMS auth for ${network.name}?`)) return;

    try {
      setAuthingId(network.id);
      await api.post(`/reports/networks/${network.id}/cms-auth/disconnect`);
      setMessage("CMS auth disconnected");
      await fetchNetworks();
    } catch (error) {
      setMessage(error.response?.data?.message || "Could not disconnect CMS auth");
    } finally {
      setAuthingId(null);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cmsAuth = params.get("cms_auth");
    if (cmsAuth === "success") {
      setMessage("CMS auth connected successfully");
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (cmsAuth === "error") {
      setMessage(params.get("message") || "CMS auth failed");
      window.history.replaceState({}, "", window.location.pathname);
    }

    fetchNetworks();
  }, []);

  return (
    <div className="p-5 lg:p-8">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-7">
        <div>
          <div className="inline-flex items-center gap-2 bg-cyan-50 text-cyan-700 px-4 py-2 rounded-full text-sm font-bold mb-4">
            <Network size={18} />
            Network
          </div>
          <h1 className="text-3xl lg:text-4xl font-black text-slate-900">Network</h1>
          <p className="text-slate-500 mt-2">Create networks, store CMS Network ID, and authorize Google CMS access for Content ID, Analytics, and Reports.</p>
        </div>

        <button onClick={openCreate} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl px-5 py-3 font-bold flex items-center justify-center gap-2">
          <Plus size={18} />
          Add network
        </button>
      </div>

      {message && <div className="mb-5 bg-blue-50 border border-blue-100 text-blue-700 rounded-2xl px-5 py-4 font-medium">{message}</div>}

      {loading ? (
        <div className="py-20 flex justify-center">
          <Loader2 className="animate-spin text-cyan-600" size={36} />
        </div>
      ) : sortedNetworks.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-3xl p-12 text-center text-slate-500">No networks yet.</div>
      ) : (
        <div className="grid xl:grid-cols-3 md:grid-cols-2 gap-5">
          {sortedNetworks.map((network) => {
            const grantedApis = parseGrantedApis(network.cms_auth_scopes);
            const isConnected = network.cms_auth_status === "connected";

            return (
              <div key={network.id} className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4 mb-5">
                  <div className="min-w-0">
                    <h2 className="text-xl font-black text-slate-900 truncate">{network.name}</h2>
                    {network.network_code ? (
                      <p className="mt-2 inline-flex rounded-full bg-cyan-50 px-3 py-1 text-xs font-black text-cyan-700">
                        Network ID: {network.network_code}
                      </p>
                    ) : null}
                    <p className="text-sm text-slate-500 mt-2 whitespace-pre-wrap">{network.description || "No description"}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => openEdit(network)} className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center" title="Edit">
                      <Edit3 size={17} />
                    </button>
                    <button onClick={() => deleteNetwork(network.id)} className="w-10 h-10 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 flex items-center justify-center" title="Delete">
                      <Trash2 size={17} />
                    </button>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-black uppercase ${statusClass(network.cms_auth_status)}`}>
                      <ShieldCheck size={14} />
                      {network.cms_auth_status || "not_connected"}
                    </span>
                    <span className="text-xs text-slate-400">Updated: {network.updated_at || "-"}</span>
                  </div>

                  {isConnected ? (
                    <div className="mt-4 space-y-3">
                      <div>
                        <p className="text-[11px] font-black uppercase text-slate-400">Google account</p>
                        <p className="text-sm font-bold text-slate-800 truncate">{network.cms_auth_email || "-"}</p>
                        {network.cms_auth_name ? <p className="text-xs text-slate-500 truncate">{network.cms_auth_name}</p> : null}
                      </div>

                      <div>
                        <p className="text-[11px] font-black uppercase text-slate-400">Authorized APIs</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(grantedApis.length ? grantedApis : apiLabels).map((item) => (
                            <span key={item.label} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
                              <CheckCircle2 size={13} />
                              {item.label}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-xs text-slate-500">
                        <div>
                          <p className="font-black uppercase text-slate-400">Authed at</p>
                          <p>{network.cms_authed_at || "-"}</p>
                        </div>
                        <div>
                          <p className="font-black uppercase text-slate-400">Token expires</p>
                          <p>{network.cms_token_expiry || "-"}</p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-4 text-sm text-slate-500">
                      Connect the Google account that has CMS owner access. This enables future Content ID, YouTube Analytics, and Reporting API calls for this network.
                    </p>
                  )}

                  {network.cms_auth_error ? <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">{network.cms_auth_error}</div> : null}

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => startCmsAuth(network)}
                      disabled={authingId === network.id}
                      className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white hover:bg-blue-700 disabled:opacity-60"
                    >
                      {authingId === network.id ? <Loader2 className="animate-spin" size={16} /> : <KeyRound size={16} />}
                      {isConnected ? "Re-auth CMS" : "Auth CMS"}
                    </button>
                    {isConnected ? (
                      <button
                        type="button"
                        onClick={() => disconnectCms(network)}
                        disabled={authingId === network.id}
                        className="inline-flex items-center gap-2 rounded-xl bg-red-50 px-4 py-2 text-sm font-black text-red-600 hover:bg-red-100 disabled:opacity-60"
                      >
                        <Unplug size={16} />
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={saveNetwork} className="w-full max-w-xl bg-white rounded-3xl shadow-2xl">
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-black text-slate-900">{editing ? "Edit Network" : "Create Network"}</h2>
              <button type="button" onClick={() => setModalOpen(false)} className="w-10 h-10 rounded-xl border border-slate-300 flex items-center justify-center">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <label>
                <span className="text-sm text-slate-700 mb-2 block">Network Name *</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-cyan-500"
                  placeholder="Example: Ohenemedia - Music"
                  required
                />
              </label>

              <label>
                <span className="text-sm text-slate-700 mb-2 block">Network ID</span>
                <input
                  value={form.network_code}
                  onChange={(e) => setForm({ ...form, network_code: e.target.value })}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-cyan-500"
                  placeholder="Optional CMS/content owner ID"
                />
              </label>

              <label>
                <span className="text-sm text-slate-700 mb-2 block">Description</span>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full min-h-32 rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-cyan-500"
                  placeholder="Network notes..."
                />
              </label>
            </div>

            <div className="px-6 py-5 border-t border-slate-100 flex justify-end gap-3">
              <button type="button" onClick={() => setModalOpen(false)} className="px-5 py-3 rounded-2xl border border-slate-300 font-bold">Cancel</button>
              <button type="submit" disabled={saving} className="px-5 py-3 rounded-2xl bg-emerald-600 text-white font-bold flex items-center gap-2 disabled:opacity-60">
                {saving ? <Loader2 className="animate-spin" size={18} /> : null}
                Save network
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
