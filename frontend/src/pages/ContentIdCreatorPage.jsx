import { useEffect, useMemo, useState } from "react";
import { Download, FileAudio, Plus, Trash2 } from "lucide-react";
import api from "../api/api";

const GENRES = [
  "Pop", "Rock", "Hip-Hop", "Guitar", "Piano", "R&B", "Electronic", "Dance", "Jazz", "Classical",
  "Country", "Reggae", "Latin", "Metal", "Folk", "Blues", "Soul", "Funk", "Punk", "Alternative",
  "Indie", "Gospel", "World", "Ambient", "Lo-Fi", "Trap", "House", "Techno", "Trance", "Dubstep",
  "K-Pop", "J-Pop", "Soundtrack", "Children's Music", "Holiday", "Opera", "Experimental", "New Age",
  "Chill", "Instrumental", "Acoustic", "Hard Rock", "Progressive Rock", "EDM", "Reggaeton", "Bolero"
];

const MATCH_POLICIES = [
  "Monetize in all countries",
  "Track in all countries",
  "Block in all countries",
  "Manual Review"
];

const emptyRow = (filename = "") => ({
  filename,
  isrc: "",
  upc: "",
  song_title: filename.replace(/\.[^/.]+$/, ""),
  artist: "",
  album: "",
  label: "",
  ownership: "",
  error: ""
});

function removeVietnameseTones(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function downloadCsv(rows, filename) {
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function ContentIdCreatorPage() {
  const [rows, setRows] = useState([]);
  const [labels, setLabels] = useState([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [bulk, setBulk] = useState({ isrc: "", title: "", artist: "" });
  const [meta, setMeta] = useState({
    match_policy: MATCH_POLICIES[0],
    release_date: "",
    genre: "",
    ddex_party_id: "",
    album_artist: "",
    album_art_filename: ""
  });

  const albumTitle = rows[0]?.album || "";
  const canExport = rows.length > 0;

  const stats = useMemo(() => {
    const missingIsrc = rows.filter((row) => !row.isrc.trim()).length;
    const missingUpc = rows.filter((row) => !row.upc.trim()).length;
    return { missingIsrc, missingUpc };
  }, [rows]);

  useEffect(() => {
    api.get("/content-id/labels")
      .then((res) => setLabels(res.data.labels || []))
      .catch(() => setLabels([]));
  }, []);

  function updateMeta(field, value) {
    setMeta((current) => ({ ...current, [field]: value }));
  }

  function updateRow(index, field, value) {
    setRows((current) => current.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      return { ...row, [field]: value };
    }));

    if (["upc", "album", "label", "ownership"].includes(field) && index === 0) {
      setRows((current) => current.map((row, rowIndex) => rowIndex === 0 ? row : { ...row, [field]: value }));
    }
  }

  function applyLabel(value) {
    setRows((current) => current.map((row) => ({ ...row, label: value })));
  }

  function addRow(filename = "") {
    setRows((current) => [...current, emptyRow(filename)]);
  }

  function loadFilenames(event) {
    const files = Array.from(event.target.files || []);
    const audioRows = files
      .filter((file) => /\.(mp3|mp4|wav|flac)$/i.test(file.name))
      .map((file) => emptyRow(file.name));

    setRows((current) => [...current, ...audioRows]);
    setMessage(`Loaded ${audioRows.length} audio files`);
  }

  function clearAll() {
    setRows([]);
    setBulk({ isrc: "", title: "", artist: "" });
    setMeta({
      match_policy: MATCH_POLICIES[0],
      release_date: "",
      genre: "",
      ddex_party_id: "",
      album_artist: "",
      album_art_filename: ""
    });
    setMessage("");
  }

  async function fillCodes(type) {
    if (!rows.length) {
      setMessage("Add rows before taking codes.");
      return;
    }

    const count = type === "UPC" ? 1 : rows.length;
    const res = await api.get("/content-id/codes/available", { params: { type, count } });
    const codes = res.data.codes || [];

    if (codes.length < count) {
      setMessage(`Only ${codes.length}/${count} unused ${type} codes are available.`);
    } else {
      setMessage(`Filled ${codes.length} ${type} code${codes.length > 1 ? "s" : ""}.`);
    }

    setRows((current) => current.map((row, index) => {
      if (type === "UPC") return { ...row, upc: codes[0] || row.upc };
      return { ...row, isrc: codes[index] || row.isrc };
    }));
  }

  function pasteField(source, field) {
    const lines = String(source || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    setRows((current) => current.map((row, index) => lines[index] ? { ...row, [field]: lines[index] } : row));
    setMessage(`Pasted ${lines.length} values into ${field}`);
  }

  function buildCsvPayload() {
    const genre = meta.genre;
    const releaseDate = meta.release_date;
    const albumArtist = meta.album_artist.trim();
    const albumArtFileName = meta.album_art_filename.trim();

    if (!rows.length) throw new Error("No tracks to export.");
    if (!genre) throw new Error("Please select genre.");
    if (!releaseDate) throw new Error("Please select release date.");
    if (!albumArtist) throw new Error("Please enter album artist.");
    if (!albumArtFileName) throw new Error("Please choose album art filename.");

    const headers1 = ["filename", "isrc", "add_asset_labels", "song_title", "artist", "album", "upc", "genre", "label", "original_release_date", "ownership", "match_policy", "custom_id"];
    const headers2 = [
      "ddex_party_id", "album_artist", "album_title", "album_upc", "album_release_date", "album_label",
      "album_art_filename", "track_number", "track_title", "track_filename", "track_custom_id",
      "track_artist", "track_genres", "track_isrc", "track_pline", "track_territory_start_dates",
      "track_explicit_lyrics", "track_add_at_asset_labels", "track_add_sr_asset_labels"
    ];

    const soundRecordings = [headers1];
    const artTrack = [headers2];
    const tracks = [];

    rows.forEach((row, index) => {
      ["filename", "isrc", "song_title", "artist", "album", "upc", "label", "ownership"].forEach((field) => {
        if (!String(row[field] || "").trim()) throw new Error(`Row ${index + 1}: ${field} is required.`);
      });

      const asset = row.label;
      const cleanLabel = removeVietnameseTones(row.label).replace(/[^a-zA-Z0-9]/g, "");
      const customId = `${cleanLabel}_${row.isrc}`;
      const trackNumber = index + 1;
      const trackPline = `${new Date().getFullYear()} ${row.label}`;
      const territory = `${row.ownership}:${releaseDate}`;

      soundRecordings.push([
        row.filename, row.isrc, asset, row.song_title, row.artist, row.album, row.upc,
        genre, row.label, releaseDate, row.ownership, meta.match_policy, customId
      ]);

      artTrack.push([
        meta.ddex_party_id, albumArtist, row.album, row.upc, releaseDate, row.label,
        albumArtFileName, trackNumber, row.song_title, row.filename, customId,
        row.artist, genre, row.isrc, trackPline, territory, "no", asset, asset
      ]);

      tracks.push({
        track_number: trackNumber,
        filename: row.filename,
        isrc: row.isrc,
        song_title: row.song_title,
        artist: row.artist,
        custom_id: customId
      });
    });

    return { soundRecordings, artTrack, tracks };
  }

  async function exportCsvAndSave() {
    try {
      setSaving(true);
      const { soundRecordings, artTrack, tracks } = buildCsvPayload();
      const productPayload = {
        product: {
          album_title: albumTitle,
          album_artist: meta.album_artist,
          album_upc: rows[0]?.upc || "",
          genre: meta.genre,
          label: rows[0]?.label || "",
          release_date: meta.release_date,
          ownership: rows[0]?.ownership || "",
          match_policy: meta.match_policy,
          ddex_party_id: meta.ddex_party_id,
          album_art_filename: meta.album_art_filename
        },
        tracks
      };

      await api.post("/content-id/products", productPayload);
      const cleanAlbum = removeVietnameseTones(albumTitle).replace(/[^a-zA-Z0-9]/g, "") || "output";
      downloadCsv(soundRecordings, `${cleanAlbum}-SoundRecordings.csv`);
      downloadCsv(artTrack, `${cleanAlbum}-ArtTrack.csv`);
      setMessage("Product saved. CSV files downloaded.");
    } catch (error) {
      setMessage(error.response?.data?.message || error.message || "Export failed");
    } finally {
      setSaving(false);
    }
  }

  function exportTitles() {
    const data = [["STT", "Ten Bai Hat"], ...rows.map((row, index) => [index + 1, row.song_title])];
    downloadCsv(data, "DanhSachBaiHat.csv");
  }

  return (
    <div className="p-6 space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700">
              <FileAudio size={14} /> Content ID
            </p>
            <h1 className="mt-3 text-3xl font-black text-slate-950">Creator Soundrecording & Art</h1>
            <p className="mt-1 text-sm text-slate-500">Create YouTube CMS SoundRecordings and ArtTrack CSV files from stored ISRC/UPC codes.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-black text-white">
              Choose music folder
              <input type="file" multiple webkitdirectory="" className="hidden" onChange={loadFilenames} />
            </label>
            <button onClick={() => addRow()} className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-black text-white">
              <Plus size={17} /> Add row
            </button>
            <button onClick={clearAll} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700">Clear</button>
          </div>
        </div>

        {message && <div className="mt-4 rounded-2xl bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{message}</div>}

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <button onClick={() => fillCodes("ISRC")} className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700">Get ISRC from backend</button>
          <button onClick={() => fillCodes("UPC")} className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700">Get UPC from backend</button>
          <button onClick={exportTitles} disabled={!rows.length} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700 disabled:opacity-50">Export song titles CSV</button>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <select value={meta.match_policy} onChange={(event) => updateMeta("match_policy", event.target.value)} className="rounded-2xl border border-slate-200 px-4 py-3">
            {MATCH_POLICIES.map((policy) => <option key={policy}>{policy}</option>)}
          </select>
          <input type="date" value={meta.release_date} onChange={(event) => updateMeta("release_date", event.target.value)} className="rounded-2xl border border-slate-200 px-4 py-3" />
          <select value={meta.genre} onChange={(event) => updateMeta("genre", event.target.value)} className="rounded-2xl border border-slate-200 px-4 py-3">
            <option value="">Select genre</option>
            {GENRES.map((genre) => <option key={genre} value={genre}>{genre}</option>)}
          </select>
          <input value={meta.ddex_party_id} onChange={(event) => updateMeta("ddex_party_id", event.target.value)} placeholder="ddex_party_id" className="rounded-2xl border border-slate-200 px-4 py-3" />
          <input value={meta.album_artist} onChange={(event) => updateMeta("album_artist", event.target.value)} placeholder="album_artist" className="rounded-2xl border border-slate-200 px-4 py-3" />
          <select value={rows[0]?.label || ""} onChange={(event) => applyLabel(event.target.value)} className="rounded-2xl border border-slate-200 px-4 py-3">
            <option value="">Select label</option>
            {labels.map((label) => (
              <option key={label.id} value={label.name}>{label.display_name || label.name}</option>
            ))}
          </select>
          <label className="rounded-2xl border border-slate-200 px-4 py-3 text-slate-500">
            {meta.album_art_filename || "Choose album art filename"}
            <input
              type="file"
              accept=".png,.jpg,.jpeg"
              className="hidden"
              onChange={(event) => updateMeta("album_art_filename", event.target.files?.[0]?.name || "")}
            />
          </label>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-4">
          <textarea value={bulk.isrc} onChange={(event) => setBulk((current) => ({ ...current, isrc: event.target.value }))} rows={4} placeholder="Paste ISRC, one per line" className="w-full rounded-2xl border border-slate-200 p-3" />
          <button onClick={() => pasteField(bulk.isrc, "isrc")} className="mt-2 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white">Paste ISRC</button>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-4">
          <textarea value={bulk.title} onChange={(event) => setBulk((current) => ({ ...current, title: event.target.value }))} rows={4} placeholder="Paste song titles, one per line" className="w-full rounded-2xl border border-slate-200 p-3" />
          <button onClick={() => pasteField(bulk.title, "song_title")} className="mt-2 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white">Paste titles</button>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-4">
          <textarea value={bulk.artist} onChange={(event) => setBulk((current) => ({ ...current, artist: event.target.value }))} rows={4} placeholder="Paste artists, one per line. Use comma or semicolon for multiple artists." className="w-full rounded-2xl border border-slate-200 p-3" />
          <button onClick={() => pasteField(bulk.artist, "artist")} className="mt-2 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white">Paste artists</button>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
          <h2 className="text-lg font-black text-slate-950">{rows.length} tracks</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs font-black">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">Missing ISRC: {stats.missingIsrc}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">Missing UPC: {stats.missingUpc}</span>
            <button onClick={exportCsvAndSave} disabled={!canExport || saving} className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50">
              <Download size={17} /> {saving ? "Saving..." : "Download CSV"}
            </button>
          </div>
        </div>

        <div className="overflow-auto">
          <table className="min-w-[1400px] w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-3">X</th>
                <th className="px-3 py-3">Filename</th>
                <th className="px-3 py-3">ISRC</th>
                <th className="px-3 py-3">UPC</th>
                <th className="px-3 py-3">Song title</th>
                <th className="px-3 py-3">Artist(s)</th>
                <th className="px-3 py-3">Album</th>
                <th className="px-3 py-3">Label</th>
                <th className="px-3 py-3">Ownership</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.filename}-${index}`} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <button onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} className="rounded-xl bg-red-50 p-2 text-red-500">
                      <Trash2 size={15} />
                    </button>
                  </td>
                  {["filename", "isrc", "upc", "song_title", "artist", "album", "label", "ownership"].map((field) => (
                    <td key={field} className="px-3 py-2">
                      <input
                        value={row[field]}
                        onChange={(event) => updateRow(index, field, event.target.value)}
                        placeholder={field === "artist" ? "Artist A, Artist B" : ""}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2"
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-slate-500">Choose a music folder or add rows manually.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
