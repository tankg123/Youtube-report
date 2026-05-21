import { useEffect, useState } from "react";
import { FileText, RefreshCw, Save, Settings2, Trash2 } from "lucide-react";
import api from "../api/api";

export default function ContentIdSettingsPage() {
  const [summary, setSummary] = useState({ ISRC: {}, UPC: {} });
  const [codes, setCodes] = useState([]);
  const [form, setForm] = useState({ type: "ISRC", codes: "", notes: "" });
  const [filters, setFilters] = useState({ type: "ISRC", status: "", search: "" });
  const [message, setMessage] = useState("");

  async function loadSummary() {
    const res = await api.get("/content-id/codes/summary");
    setSummary(res.data.summary || { ISRC: {}, UPC: {} });
  }

  async function loadCodes() {
    const res = await api.get("/content-id/codes", { params: filters });
    setCodes(res.data.codes || []);
  }

  async function refreshAll() {
    await Promise.all([loadSummary(), loadCodes()]);
  }

  async function addCodes(event) {
    event.preventDefault();
    const res = await api.post("/content-id/codes", form);
    setMessage(`Added ${res.data.added}, duplicates ${res.data.duplicates}, invalid ${res.data.invalid?.length || 0}`);
    setForm((current) => ({ ...current, codes: "" }));
    refreshAll();
  }

  function loadTxtFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      setForm((current) => ({
        ...current,
        codes: String(reader.result || "")
      }));
      setMessage(`Loaded ${file.name}`);
    };
    reader.readAsText(file, "utf-8");
    event.target.value = "";
  }

  async function deleteCode(id) {
    if (!window.confirm("Delete this unused code?")) return;
    await api.delete(`/content-id/codes/${id}`);
    setMessage("Code deleted");
    refreshAll();
  }

  useEffect(() => {
    refreshAll();
  }, []);

  return (
    <div className="p-6 space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-purple-50 px-3 py-1 text-xs font-black text-purple-700">
              <Settings2 size={14} /> Settings
            </p>
            <h1 className="mt-3 text-3xl font-black text-slate-950">Content ID Setting</h1>
            <p className="mt-1 text-sm text-slate-500">Manage ISRC and UPC inventory, usage status, album matches and song matches.</p>
          </div>
          <button onClick={refreshAll} className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700">
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
        {message && <div className="mt-4 rounded-2xl bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{message}</div>}
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {["ISRC", "UPC"].map((type) => (
          ["unused", "used"].map((status) => (
            <div key={`${type}-${status}`} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-black uppercase tracking-wider text-slate-400">{type} {status}</p>
              <p className={["mt-3 text-3xl font-black", status === "unused" ? "text-emerald-600" : "text-blue-600"].join(" ")}>
                {summary[type]?.[status] || 0}
              </p>
              <p className="mt-1 text-xs text-slate-500">Total: {summary[type]?.total || 0}</p>
            </div>
          ))
        ))}
      </section>

      <section className="grid gap-5 xl:grid-cols-[440px_1fr]">
        <form onSubmit={addCodes} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-black text-slate-950">Add codes</h2>
          <div className="mt-4 space-y-3">
            <select value={form.type} onChange={(event) => setForm((current) => ({ ...current, type: event.target.value }))} className="w-full rounded-2xl border border-slate-200 px-4 py-3">
              <option value="ISRC">ISRC</option>
              <option value="UPC">UPC</option>
            </select>
            <label className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700">
              <FileText size={17} /> Import .txt file
              <input type="file" accept=".txt,text/plain" className="hidden" onChange={loadTxtFile} />
            </label>
            <textarea
              value={form.codes}
              onChange={(event) => setForm((current) => ({ ...current, codes: event.target.value }))}
              rows={12}
              placeholder="Paste one code per line"
              className="w-full rounded-2xl border border-slate-200 p-4 font-mono text-sm"
            />
            <input value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Internal notes" className="w-full rounded-2xl border border-slate-200 px-4 py-3" />
            <button className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-black text-white">
              <Save size={17} /> Save codes
            </button>
          </div>
        </form>

        <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
            <h2 className="text-lg font-black text-slate-950">Code library <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500">{codes.length}</span></h2>
            <div className="flex flex-wrap gap-2">
              <select value={filters.type} onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value }))} className="rounded-2xl border border-slate-200 px-3 py-2 text-sm">
                <option value="">All types</option>
                <option value="ISRC">ISRC</option>
                <option value="UPC">UPC</option>
              </select>
              <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} className="rounded-2xl border border-slate-200 px-3 py-2 text-sm">
                <option value="">All status</option>
                <option value="unused">Unused</option>
                <option value="used">Used</option>
                <option value="reserved">Reserved</option>
              </select>
              <input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Search code, album, song..." className="rounded-2xl border border-slate-200 px-3 py-2 text-sm" />
              <button onClick={loadCodes} className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-black text-white">Filter</button>
            </div>
          </div>

          <div className="overflow-auto">
            <table className="min-w-[980px] w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Album</th>
                  <th className="px-4 py-3">Song</th>
                  <th className="px-4 py-3">Artist</th>
                  <th className="px-4 py-3">Used at</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => (
                  <tr key={code.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-black">{code.type}</td>
                    <td className="px-4 py-3 font-mono text-xs text-emerald-700">{code.code}</td>
                    <td className="px-4 py-3">
                      <span className={[
                        "rounded-full px-3 py-1 text-xs font-black",
                        code.status === "unused" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"
                      ].join(" ")}>{code.status}</span>
                    </td>
                    <td className="px-4 py-3">{code.album_title || "-"}</td>
                    <td className="px-4 py-3">{code.song_title || "-"}</td>
                    <td className="px-4 py-3">{code.artist || "-"}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{code.used_at || "-"}</td>
                    <td className="px-4 py-3">
                      {code.status !== "used" && (
                        <button onClick={() => deleteCode(code.id)} className="rounded-xl bg-red-50 p-2 text-red-500">
                          <Trash2 size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!codes.length && (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-slate-500">No codes found.</td>
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
