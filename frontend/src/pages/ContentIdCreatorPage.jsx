import { useEffect, useMemo, useState } from "react";
import { Download, FileAudio, Loader2, PackageSearch, Plus, Trash2, TriangleAlert, Upload } from "lucide-react";
import api from "../api/api";
import { useI18n } from "../context/I18nContext";
import { tk } from "../i18n/index.js";

const GENRES = [
  "Pop", "Rock", "Hip-Hop", "Guitar", "Piano", "R&B", "Electronic", "Dance", "Jazz", "Classical",
  "Country", "Reggae", "Latin", "Metal", "Folk", "Blues", "Soul", "Funk", "Punk", "Alternative",
  "Indie", "Gospel", "World", "Ambient", "Lo-Fi", "Trap", "House", "Techno", "Trance", "Dubstep",
  "K-Pop", "J-Pop", "Soundtrack", "Children's Music", "Holiday", "Opera", "Experimental", "New Age",
  "Chill", "Instrumental", "Acoustic", "Hard Rock", "Progressive Rock", "EDM", "Reggaeton", "Bolero"
];

// CSV values YouTube expects (kept English in the data); the <option> labels are rendered with t(policy).
const MATCH_POLICIES = [
  tk("Monetize in all countries"),
  tk("Track in all countries"),
  tk("Block in all countries"),
  tk("Manual Review")
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

function downloadBlob(data, filename, type) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function filenameFromDisposition(disposition = "") {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || "";
}

function formatMegabytes(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MB`;
}

export default function ContentIdCreatorPage() {
  const { t, tm } = useI18n();
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

  const [importCsv, setImportCsv] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importAlbums, setImportAlbums] = useState([]);
  const [importSummary, setImportSummary] = useState(null);
  const [importMessage, setImportMessage] = useState("");
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [packagingKey, setPackagingKey] = useState("");
  const [packagingProgress, setPackagingProgress] = useState(0);
  const [importOptions, setImportOptions] = useState({
    ownership: "WW",
    match_policy: MATCH_POLICIES[0],
    ddex_party_id: "",
    include_audio: true,
    include_artwork: true
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
    setMessage(t("Loaded {count} audio files", { count: audioRows.length }));
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
      setMessage(tk("Add rows before taking codes."));
      return;
    }

    const count = type === "UPC" ? 1 : rows.length;
    const res = await api.get("/content-id/codes/available", { params: { type, count } });
    const codes = res.data.codes || [];

    if (codes.length < count) {
      setMessage(t("Only {available}/{count} unused {type} codes are available.", { available: codes.length, count, type }));
    } else {
      setMessage(codes.length > 1
        ? t("Filled {count} {type} codes.", { count: codes.length, type })
        : t("Filled {count} {type} code.", { count: codes.length, type }));
    }

    setRows((current) => current.map((row, index) => {
      if (type === "UPC") return { ...row, upc: codes[0] || row.upc };
      return { ...row, isrc: codes[index] || row.isrc };
    }));
  }

  function pasteField(source, field) {
    const lines = String(source || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    setRows((current) => current.map((row, index) => lines[index] ? { ...row, [field]: lines[index] } : row));
    setMessage(t("Pasted {count} values into {field}", { count: lines.length, field }));
  }

  function updateImportOption(field, value) {
    setImportOptions((current) => ({ ...current, [field]: value }));
  }

  async function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(tk("Could not read the CSV file.")));
      reader.readAsText(file, "utf-8");
    });
  }

  async function analyzeReport(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      setAnalyzing(true);
      setImportMessage(t("Reading {file}...", { file: file.name }));
      const text = await readFileAsText(file);
      const res = await api.post("/content-id/product-track/analyze", { csv: text }, { timeout: 120000 });
      const albums = res.data.albums || [];

      setImportCsv(text);
      setImportFileName(file.name);
      setImportAlbums(albums);
      setImportSummary(res.data.summary || null);
      setSelectedKeys(albums.map((album) => album.key));
      const foundParams = { albums: albums.length, tracks: res.data.summary?.track_count || 0, file: file.name };
      setImportMessage(albums.length === 1
        ? t("Found {albums} album and {tracks} tracks in {file}.", foundParams)
        : t("Found {albums} albums and {tracks} tracks in {file}.", foundParams));
    } catch (error) {
      setImportCsv("");
      setImportAlbums([]);
      setImportSummary(null);
      setSelectedKeys([]);
      setImportMessage(error.response?.data?.message || error.message || tk("Could not read this report."));
    } finally {
      setAnalyzing(false);
    }
  }

  function clearImport() {
    setImportCsv("");
    setImportFileName("");
    setImportAlbums([]);
    setImportSummary(null);
    setSelectedKeys([]);
    setImportMessage("");
  }

  function toggleAlbum(key) {
    setSelectedKeys((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]);
  }

  function toggleAllAlbums() {
    setSelectedKeys((current) => current.length === importAlbums.length ? [] : importAlbums.map((album) => album.key));
  }

  async function packageErrorMessage(error, fallback) {
    if (error.response?.data instanceof Blob) {
      const text = await error.response.data.text();
      try {
        return JSON.parse(text).message || fallback;
      } catch {
        return text || fallback;
      }
    }
    return error.response?.data?.message || error.message || fallback;
  }

  async function downloadPackage(keys, busyKey, label) {
    if (!importCsv) {
      setImportMessage(tk("Please import a ProductTrack report first."));
      return;
    }
    if (!keys.length) {
      setImportMessage(tk("Please select at least one album."));
      return;
    }

    try {
      setPackagingKey(busyKey);
      setPackagingProgress(0);
      setImportMessage(t("Preparing {label}. Downloading audio and artwork from the media server, this can take a few minutes...", { label }));

      const res = await api.post(
        "/content-id/product-track/package",
        { csv: importCsv, keys, options: importOptions },
        {
          responseType: "blob",
          timeout: 1800000,
          onDownloadProgress: (progress) => setPackagingProgress(progress.loaded || 0)
        }
      );

      const headerFileName = filenameFromDisposition(res.headers?.["content-disposition"] || "");
      downloadBlob(res.data, headerFileName || "content-id-package.zip", "application/zip");
      const skipped = Number(res.headers?.["x-package-skipped"] || 0);
      setImportMessage(skipped
        ? t("Downloaded {label} ({size}). {skipped} file(s) could not be fetched - see README-missing-files.txt inside the ZIP.", { label, size: formatMegabytes(res.data.size), skipped })
        : t("Downloaded {label} ({size}).", { label, size: formatMegabytes(res.data.size) }));
    } catch (error) {
      setImportMessage(await packageErrorMessage(error, t("Could not build the package for {label}", { label })));
    } finally {
      setPackagingKey("");
      setPackagingProgress(0);
    }
  }

  function buildCsvPayload() {
    const genre = meta.genre;
    const releaseDate = meta.release_date;
    const albumArtist = meta.album_artist.trim();
    const albumArtFileName = meta.album_art_filename.trim();

    if (!rows.length) throw new Error(tk("No tracks to export."));
    if (!genre) throw new Error(tk("Please select genre."));
    if (!releaseDate) throw new Error(tk("Please select release date."));
    if (!albumArtist) throw new Error(tk("Please enter album artist."));
    if (!albumArtFileName) throw new Error(tk("Please choose album art filename."));

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
        if (!String(row[field] || "").trim()) throw new Error(t("Row {row}: {field} is required.", { row: index + 1, field }));
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
      setMessage(tk("Product saved. CSV files downloaded."));
    } catch (error) {
      setMessage(error.response?.data?.message || error.message || tk("Export failed"));
    } finally {
      setSaving(false);
    }
  }

  function exportTitles() {
    const data = [[t("No."), t("Song title")], ...rows.map((row, index) => [index + 1, row.song_title])];
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
            <h1 className="mt-3 text-3xl font-black text-slate-950">{t("Creator Soundrecording & Art")}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("Create YouTube CMS SoundRecordings and ArtTrack CSV files from stored ISRC/UPC codes.")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-black text-white">
              {t("Choose music folder")}
              <input type="file" multiple webkitdirectory="" className="hidden" onChange={loadFilenames} />
            </label>
            <button onClick={() => addRow()} className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-black text-white">
              <Plus size={17} /> {t("Add row")}
            </button>
            <button onClick={clearAll} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700">{t("Clear")}</button>
          </div>
        </div>

        {message && <div className="mt-4 rounded-2xl bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">{tm(message)}</div>}

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <button onClick={() => fillCodes("ISRC")} className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700">{t("Get ISRC from backend")}</button>
          <button onClick={() => fillCodes("UPC")} className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700">{t("Get UPC from backend")}</button>
          <button onClick={exportTitles} disabled={!rows.length} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700 disabled:opacity-50">{t("Export song titles CSV")}</button>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <select value={meta.match_policy} onChange={(event) => updateMeta("match_policy", event.target.value)} className="rounded-2xl border border-slate-200 px-4 py-3">
            {MATCH_POLICIES.map((policy) => <option key={policy} value={policy}>{t(policy)}</option>)}
          </select>
          <input type="date" value={meta.release_date} onChange={(event) => updateMeta("release_date", event.target.value)} className="rounded-2xl border border-slate-200 px-4 py-3" />
          <select value={meta.genre} onChange={(event) => updateMeta("genre", event.target.value)} className="rounded-2xl border border-slate-200 px-4 py-3">
            <option value="">{t("Select genre")}</option>
            {GENRES.map((genre) => <option key={genre} value={genre}>{genre}</option>)}
          </select>
          <input value={meta.ddex_party_id} onChange={(event) => updateMeta("ddex_party_id", event.target.value)} placeholder="ddex_party_id" className="rounded-2xl border border-slate-200 px-4 py-3" />
          <input value={meta.album_artist} onChange={(event) => updateMeta("album_artist", event.target.value)} placeholder="album_artist" className="rounded-2xl border border-slate-200 px-4 py-3" />
          <select value={rows[0]?.label || ""} onChange={(event) => applyLabel(event.target.value)} className="rounded-2xl border border-slate-200 px-4 py-3">
            <option value="">{t("Select label")}</option>
            {labels.map((label) => (
              <option key={label.id} value={label.name}>{label.display_name || label.name}</option>
            ))}
          </select>
          <label className="rounded-2xl border border-slate-200 px-4 py-3 text-slate-500">
            {meta.album_art_filename || t("Choose album art filename")}
            <input
              type="file"
              accept=".png,.jpg,.jpeg"
              className="hidden"
              onChange={(event) => updateMeta("album_art_filename", event.target.files?.[0]?.name || "")}
            />
          </label>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-black text-indigo-700">
              <PackageSearch size={14} /> {t("Import ProductTrack report")}
            </p>
            <h2 className="mt-3 text-2xl font-black text-slate-950">{t("Build album packages from a report")}</h2>
            <p className="mt-1 text-sm text-slate-500">
              {t("Import a ProductTrack CSV export. Each album is packaged into a ZIP with its audio files, artwork and the SoundRecordings + ArtTrack CSV files already filled in from the report.")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className={`inline-flex items-center gap-2 rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-black text-white ${analyzing ? "opacity-60" : "cursor-pointer"}`}>
              {analyzing ? <Loader2 size={17} className="animate-spin" /> : <Upload size={17} />}
              {analyzing ? t("Reading...") : t("Import report CSV")}
              <input type="file" accept=".csv,text/csv" className="hidden" disabled={analyzing} onChange={analyzeReport} />
            </label>
            {importAlbums.length > 0 && (
              <button onClick={clearImport} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700">{t("Clear import")}</button>
            )}
          </div>
        </div>

        {importMessage && (
          <div className="mt-4 rounded-2xl bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-700">
            {tm(importMessage)}
            {packagingKey && packagingProgress > 0 && ` ${t("({size} received)", { size: formatMegabytes(packagingProgress) })}`}
          </div>
        )}

        {importAlbums.length > 0 && (
          <>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <label className="rounded-2xl border border-slate-200 px-4 py-3">
                <span className="block text-xs font-black uppercase text-slate-400">{t("Ownership")}</span>
                <input
                  value={importOptions.ownership}
                  onChange={(event) => updateImportOption("ownership", event.target.value)}
                  placeholder="WW"
                  className="mt-1 w-full text-sm font-bold text-slate-900 outline-none"
                />
              </label>
              <label className="rounded-2xl border border-slate-200 px-4 py-3">
                <span className="block text-xs font-black uppercase text-slate-400">{t("Match policy")}</span>
                <select
                  value={importOptions.match_policy}
                  onChange={(event) => updateImportOption("match_policy", event.target.value)}
                  className="mt-1 w-full bg-transparent text-sm font-bold text-slate-900 outline-none"
                >
                  {MATCH_POLICIES.map((policy) => <option key={policy} value={policy}>{t(policy)}</option>)}
                </select>
              </label>
              <label className="rounded-2xl border border-slate-200 px-4 py-3">
                <span className="block text-xs font-black uppercase text-slate-400">ddex_party_id</span>
                <input
                  value={importOptions.ddex_party_id}
                  onChange={(event) => updateImportOption("ddex_party_id", event.target.value)}
                  placeholder={t("Optional")}
                  className="mt-1 w-full text-sm font-bold text-slate-900 outline-none"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs font-black text-slate-600">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={importOptions.include_audio} onChange={(event) => updateImportOption("include_audio", event.target.checked)} />
                {t("Include audio files")}
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={importOptions.include_artwork} onChange={(event) => updateImportOption("include_artwork", event.target.checked)} />
                {t("Include artwork")}
              </label>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{importFileName}</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{t("{count} albums", { count: importSummary?.album_count || 0 })}</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{t("{count} tracks", { count: importSummary?.track_count || 0 })}</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{t("{count} audio links", { count: importSummary?.downloadable_tracks || 0 })}</span>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <button onClick={toggleAllAlbums} className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700">
                {selectedKeys.length === importAlbums.length ? t("Unselect all") : t("Select all")}
              </button>
              <button
                onClick={() => downloadPackage(selectedKeys, "selected", selectedKeys.length === 1 ? t("{count} album", { count: selectedKeys.length }) : t("{count} albums", { count: selectedKeys.length }))}
                disabled={!selectedKeys.length || Boolean(packagingKey)}
                className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50"
              >
                {packagingKey === "selected" ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}
                {t("Download selected ({count})", { count: selectedKeys.length })}
              </button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {importAlbums.map((album) => (
                <div
                  key={album.key}
                  className={`rounded-2xl border p-4 ${selectedKeys.includes(album.key) ? "border-indigo-300 bg-indigo-50/40" : "border-slate-200 bg-white"}`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedKeys.includes(album.key)}
                      onChange={() => toggleAlbum(album.key)}
                      className="mt-1"
                    />
                    {album.artwork_url ? (
                      <img
                        src={album.artwork_url}
                        alt={album.album_title}
                        loading="lazy"
                        className="h-16 w-16 shrink-0 rounded-xl object-cover"
                        onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                      />
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
                        <FileAudio size={20} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-black text-slate-950" title={album.album_title}>{album.album_title}</p>
                      <p className="mt-0.5 truncate text-xs font-bold text-slate-500">
                        {album.album_upc || t("No UPC")} - {album.track_count === 1 ? t("{count} track", { count: album.track_count }) : t("{count} tracks", { count: album.track_count })}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">{album.album_artist} - {album.label}</p>
                      <p className="mt-0.5 truncate text-xs text-slate-400">{album.genre} - {album.release_date}</p>
                    </div>
                  </div>

                  <ul className="mt-3 space-y-1 text-xs text-slate-600">
                    {album.tracks.slice(0, 4).map((track) => (
                      <li key={`${album.key}-${track.isrc || track.source_id}`} className="truncate">
                        {track.track_number}. {track.song_title} <span className="text-slate-400">{track.isrc}</span>
                      </li>
                    ))}
                    {album.track_count > 4 && <li className="text-slate-400">{t("+{count} more", { count: album.track_count - 4 })}</li>}
                  </ul>

                  {album.warnings.length > 0 && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
                      <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                      <span>{album.warnings.map((warning) => tm(warning)).join(" ")}</span>
                    </div>
                  )}

                  <button
                    onClick={() => downloadPackage([album.key], album.key, album.album_title)}
                    disabled={Boolean(packagingKey)}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-50"
                  >
                    {packagingKey === album.key ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                    {packagingKey === album.key ? t("Packaging...") : t("Download album ZIP")}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-4">
          <textarea value={bulk.isrc} onChange={(event) => setBulk((current) => ({ ...current, isrc: event.target.value }))} rows={4} placeholder={t("Paste ISRC, one per line")} className="w-full rounded-2xl border border-slate-200 p-3" />
          <button onClick={() => pasteField(bulk.isrc, "isrc")} className="mt-2 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white">{t("Paste ISRC")}</button>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-4">
          <textarea value={bulk.title} onChange={(event) => setBulk((current) => ({ ...current, title: event.target.value }))} rows={4} placeholder={t("Paste song titles, one per line")} className="w-full rounded-2xl border border-slate-200 p-3" />
          <button onClick={() => pasteField(bulk.title, "song_title")} className="mt-2 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white">{t("Paste titles")}</button>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-4">
          <textarea value={bulk.artist} onChange={(event) => setBulk((current) => ({ ...current, artist: event.target.value }))} rows={4} placeholder={t("Paste artists, one per line. Use comma or semicolon for multiple artists.")} className="w-full rounded-2xl border border-slate-200 p-3" />
          <button onClick={() => pasteField(bulk.artist, "artist")} className="mt-2 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white">{t("Paste artists")}</button>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
          <h2 className="text-lg font-black text-slate-950">{t("{count} tracks", { count: rows.length })}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs font-black">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{t("Missing ISRC: {count}", { count: stats.missingIsrc })}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{t("Missing UPC: {count}", { count: stats.missingUpc })}</span>
            <button onClick={exportCsvAndSave} disabled={!canExport || saving} className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50">
              <Download size={17} /> {saving ? t("Saving...") : t("Download CSV")}
            </button>
          </div>
        </div>

        <div className="overflow-auto">
          <table className="min-w-[1400px] w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-3">X</th>
                <th className="px-3 py-3">{t("Filename")}</th>
                <th className="px-3 py-3">ISRC</th>
                <th className="px-3 py-3">UPC</th>
                <th className="px-3 py-3">{t("Song title")}</th>
                <th className="px-3 py-3">{t("Artist(s)")}</th>
                <th className="px-3 py-3">{t("Album")}</th>
                <th className="px-3 py-3">{t("Label")}</th>
                <th className="px-3 py-3">{t("Ownership")}</th>
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
                        placeholder={field === "artist" ? t("Artist A, Artist B") : ""}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2"
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-slate-500">{t("Choose a music folder or add rows manually.")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
