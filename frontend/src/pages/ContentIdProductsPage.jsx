import { useEffect, useState } from "react";
import { PackageSearch, RefreshCw, Trash2 } from "lucide-react";
import api from "../api/api";

export default function ContentIdProductsPage() {
  const [products, setProducts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");

  async function loadProducts() {
    const res = await api.get("/content-id/products", { params: { search } });
    setProducts(res.data.products || []);
  }

  async function loadProduct(id) {
    const res = await api.get(`/content-id/products/${id}`);
    setSelected(res.data.product);
  }

  async function deleteProduct(id) {
    if (!window.confirm("Delete this product and return its codes to unused?")) return;
    await api.delete(`/content-id/products/${id}`);
    setMessage("Product deleted");
    setSelected(null);
    loadProducts();
  }

  useEffect(() => {
    loadProducts();
  }, []);

  return (
    <div className="p-6 space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-700">
              <PackageSearch size={14} /> Content ID
            </p>
            <h1 className="mt-3 text-3xl font-black text-slate-950">Product Manager</h1>
            <p className="mt-1 text-sm text-slate-500">Saved albums, tracks, UPC, ISRC and matched usage history.</p>
          </div>
          <div className="flex gap-2">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search album, artist, UPC..." className="rounded-2xl border border-slate-200 px-4 py-3" />
            <button onClick={loadProducts} className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700">
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
        </div>
        {message && <div className="mt-4 rounded-2xl bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{message}</div>}
      </section>

      <section className="grid gap-5 xl:grid-cols-[1fr_480px]">
        <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4">
            <h2 className="text-lg font-black text-slate-950">Products <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500">{products.length}</span></h2>
          </div>
          <div className="overflow-auto">
            <table className="min-w-[900px] w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Album</th>
                  <th className="px-4 py-3">UPC</th>
                  <th className="px-4 py-3">Genre</th>
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">Tracks</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <button onClick={() => loadProduct(product.id)} className="text-left">
                        <p className="font-black text-slate-950">{product.album_title}</p>
                        <p className="text-xs text-slate-500">{product.album_artist || "-"}</p>
                      </button>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-emerald-700">{product.album_upc}</td>
                    <td className="px-4 py-3">{product.genre || "-"}</td>
                    <td className="px-4 py-3">{product.label || "-"}</td>
                    <td className="px-4 py-3 font-black">{product.track_count}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{product.created_at}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => deleteProduct(product.id)} className="rounded-xl bg-red-50 p-2 text-red-500">
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!products.length && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-slate-500">No products yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-black text-slate-950">Product detail</h2>
          {!selected ? (
            <p className="mt-8 text-sm text-slate-500">Select a product to view tracks.</p>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-xl font-black text-slate-950">{selected.album_title}</p>
                <p className="text-sm text-slate-500">{selected.album_artist || "-"} | UPC {selected.album_upc}</p>
                <p className="mt-2 text-xs text-slate-500">Release: {selected.release_date || "-"} | Policy: {selected.match_policy || "-"}</p>
              </div>
              <div className="max-h-[620px] space-y-2 overflow-auto pr-1">
                {selected.tracks?.map((track) => (
                  <div key={track.id} className="rounded-2xl border border-slate-200 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-slate-950">{track.track_number}. {track.song_title}</p>
                        <p className="text-xs text-slate-500">{track.artist || "-"} | {track.filename}</p>
                      </div>
                      <span className="font-mono text-xs text-emerald-700">{track.isrc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
