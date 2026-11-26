import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, TERRITORY_NAME_BY_CODE, VIDEO_EXTENSIONS } from "./constants.js";
import { formatDate as formatLocalizedDate, formatDateTime as formatLocalizedDateTime, getLanguage, normalizeLanguage, t, tk } from "../../i18n/index.js";

// ---------------------------------------------------------------------------
// Class names
// ---------------------------------------------------------------------------

export function cx(...args) {
  return args
    .flat()
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
}

// ---------------------------------------------------------------------------
// Text / code normalisation (mirrors backend rules)
// ---------------------------------------------------------------------------

export function removeVietnameseTones(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/** Uppercase + strip non alphanumerics without enforcing a length (for live typing). */
export function cleanCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Uppercase, strip non-alphanumerics; returns "" unless exactly 12 characters. */
export function normalizeIsrc(value) {
  const clean = cleanCode(value);
  return clean.length === 12 ? clean : "";
}

/** Strip non-alphanumerics; returns "" unless 8-14 characters. */
export function normalizeUpc(value) {
  const clean = cleanCode(value);
  return clean.length >= 8 && clean.length <= 14 ? clean : "";
}

export function isValidIsrc(value) {
  return normalizeIsrc(value) !== "";
}

export function isValidUpc(value) {
  return normalizeUpc(value) !== "";
}

/** Same rule as backend customIdFor(): label without tones / non-alphanumerics + "_" + ISRC. */
export function buildCustomId(label, isrc) {
  const cleanLabel = removeVietnameseTones(label).replace(/[^a-zA-Z0-9]/g, "");
  return `${cleanLabel}_${String(isrc || "").trim()}`;
}

/** Split a string on , ; | and newlines; arrays pass through. Trimmed, deduped, non-empty. */
export function splitList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,;|\n\r]+/);
  const seen = new Set();
  const output = [];
  parts.forEach((part) => {
    const item = String(part ?? "").trim();
    if (!item || seen.has(item)) return;
    seen.add(item);
    output.push(item);
  });
  return output;
}

export function splitArtists(value) {
  return splitList(value);
}

export function joinList(value, separator = ", ") {
  return splitList(value).join(separator);
}

export function unique(array = []) {
  return Array.from(new Set(array));
}

export function chunk(array = [], size = 10) {
  const step = Math.max(1, Number(size) || 1);
  const output = [];
  for (let index = 0; index < array.length; index += step) {
    output.push(array.slice(index, index + step));
  }
  return output;
}

export function clamp(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${Number(count) === 1 ? singular : plural}`;
}

export function truncate(value, max = 60) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function makeClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `row_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

export function baseName(name) {
  return String(name || "").split(/[\\/]/).pop() || "";
}

export function fileExtension(name) {
  const match = baseName(name).match(/\.([a-z0-9]+)$/i);
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function stripExtension(name) {
  return baseName(name).replace(/\.[^/.]+$/, "");
}

export function isAudioFile(name) {
  return AUDIO_EXTENSIONS.includes(fileExtension(name));
}

export function isVideoFile(name) {
  return VIDEO_EXTENSIONS.includes(fileExtension(name));
}

/** Accepted media for a delivery page: audio for music releases, video for video batches. */
export function isMediaFile(name, kind = "music") {
  return kind === "video" ? isVideoFile(name) : isAudioFile(name);
}

export function isImageFile(name) {
  return IMAGE_EXTENSIONS.includes(fileExtension(name));
}

// Mirrors backend deliveryMediaService.guessMime(); used when the browser
// reports no File.type (common for WAV/FLAC/MKV picked from a folder).
const MEDIA_MIME_BY_EXTENSION = {
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".wma": "audio/x-ms-wma",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".wmv": "video/x-ms-wmv"
};

/** MIME type guessed from the file extension; "application/octet-stream" when unknown. */
export function guessMediaMime(name) {
  return MEDIA_MIME_BY_EXTENSION[fileExtension(name)] || "application/octet-stream";
}

export const guessAudioMime = guessMediaMime;

/** "01 - My_Song.wav" → "My Song" */
export function titleFromFilename(name) {
  return stripExtension(name)
    .replace(/^\s*\d{1,3}\s*(?:[-._)\]]+\s*|\s+)/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Leading track number of a file name: "01 - Song.wav" → 1, "1. Song" → 1, "1 Song" → 1, "Song.wav" → null. */
export function leadingTrackNumber(name) {
  const match = stripExtension(name).match(/^\s*(\d{1,3})(?:\s*[-._)\]]+\s*|\s+|$)/);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// File ↔ track matching (bulk audio upload)
// ---------------------------------------------------------------------------

const TITLE_MATCH_THRESHOLD = 0.6;

/** Lower-case ASCII word tokens of a title (Vietnamese tones stripped, punctuation ignored). */
export function titleTokens(value) {
  return new Set(
    removeVietnameseTones(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}

/** Token Jaccard similarity between two titles, 0..1. */
export function titleSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  a.forEach((token) => {
    if (b.has(token)) overlap += 1;
  });
  const union = a.size + b.size - overlap;
  return union ? overlap / union : 0;
}

/**
 * Assign audio files to tracks for a bulk upload. Passes, in order of confidence:
 * ISRC embedded in the file name → leading track-number prefix ("01", "1.", "1 -")
 * → normalised title similarity (token Jaccard ≥ 0.6). Every track is matched at
 * most once; unmatched files come back with `track_id: null` and a reason.
 *
 * @param {File[]} files
 * @param {Array<{id: number|string, isrc?: string, track_number?: number, title?: string}>} tracks
 * @returns {Array<{file: File, track_id: number|string|null, reason: string}>} same order as `files`
 */
export function matchFilesToTracks(files = [], tracks = []) {
  const candidates = (Array.isArray(tracks) ? tracks : []).filter((track) => track && track.id !== undefined && track.id !== null);
  const taken = new Set();
  const results = Array.from(files || []).map((file) => ({ file, track_id: null, reason: "" }));
  const assign = (item, track, reason) => {
    item.track_id = track.id;
    item.reason = reason;
    taken.add(track.id);
  };

  // Pass 1 — ISRC embedded in the file name (separators ignored: "VN-A12-24-00002" matches too).
  results.forEach((item) => {
    const haystack = cleanCode(stripExtension(item.file?.name));
    if (!haystack) return;
    const track = candidates.find((candidate) => {
      if (taken.has(candidate.id)) return false;
      const isrc = normalizeIsrc(candidate.isrc);
      return Boolean(isrc) && haystack.includes(isrc);
    });
    if (track) assign(item, track, t("ISRC in file name"));
  });

  // Pass 2 — leading track number.
  results.forEach((item) => {
    if (item.track_id !== null) return;
    const number = leadingTrackNumber(item.file?.name);
    if (number === null || number <= 0) return;
    const track = candidates.find((candidate) => !taken.has(candidate.id) && Number(candidate.track_number) === number);
    if (track) assign(item, track, t("Track number {number}", { number }));
  });

  // Pass 3 — title similarity (best unmatched candidate at or above the threshold).
  results.forEach((item) => {
    if (item.track_id !== null) return;
    const title = titleFromFilename(item.file?.name);
    let best = null;
    let bestScore = 0;
    candidates.forEach((candidate) => {
      if (taken.has(candidate.id)) return;
      const score = titleSimilarity(title, candidate.title);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });
    if (best && bestScore >= TITLE_MATCH_THRESHOLD) {
      assign(item, best, bestScore >= 0.999 ? t("Title match") : t("Similar title ({percent}%)", { percent: Math.round(bestScore * 100) }));
    } else {
      item.reason = t("No matching track");
    }
  });

  return results;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes, decimals = 1) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const number = value / 1024 ** exponent;
  return `${number.toFixed(exponent === 0 ? 0 : decimals)} ${units[exponent]}`;
}

export function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : "0";
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC.
  const sqlite = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  const date = sqlite ? new Date(`${sqlite[1]}T${sqlite[2]}Z`) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

// English keeps the en-GB "17 Oct 2026, 14:05" output; Vietnamese uses the shared vi-VN formatter.
export function formatDateTime(value, language = getLanguage()) {
  const date = toDate(value);
  if (!date) return "";
  if (normalizeLanguage(language) === "vi") return formatLocalizedDateTime(date, language);
  return date.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatDate(value, language = getLanguage()) {
  const date = toDate(value);
  if (!date) return "";
  if (normalizeLanguage(language) === "vi") return formatLocalizedDate(date, language);
  return date.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit" });
}

/** YYYYMMDD stamp for generated names (local time). */
export function todayStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/** Normalise many date spellings to YYYY-MM-DD (or "" when unparseable). */
export function toDateInputValue(value) {
  if (!value) return "";
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  match = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = text.match(/^(\d{4})-(\d{1,2})$/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-01`;
  match = text.match(/^(\d{4})$/);
  if (match) return `${match[1]}-01-01`;
  const date = toDate(text);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function yearOf(value) {
  const normalized = toDateInputValue(value);
  return normalized ? normalized.slice(0, 4) : "";
}

// ---------------------------------------------------------------------------
// CSV / delimited text
// ---------------------------------------------------------------------------

export function rowsToCsv(rows = []) {
  return rows
    .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

function detectDelimiter(line) {
  const candidates = ["\t", ",", ";"];
  let best = ",";
  let bestCount = -1;
  candidates.forEach((candidate) => {
    const count = line.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  });
  return best;
}

function parseDelimitedMatrix(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const source = String(text || "").replace(/\r\n?/g, "\n");

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => String(value).trim() !== ""));
}

/**
 * Parse pasted CSV/TSV text. Delimiter is auto-detected (tab, comma, semicolon)
 * and quoted fields are honoured.
 * @returns {{headers: string[], rows: Array<Record<string,string>>, matrix: string[][], delimiter: string}}
 *   `rows` are objects keyed by the (trimmed) header text; `matrix` is every line as an array (header first).
 */
export function parseDelimitedText(text, options = {}) {
  const source = String(text || "");
  const firstLine = source.split(/\r?\n/).find((line) => line.trim()) || "";
  const delimiter = options.delimiter || detectDelimiter(firstLine);
  const matrix = parseDelimitedMatrix(source, delimiter).map((cells) => cells.map((value) => String(value ?? "").trim()));
  if (!matrix.length) return { headers: [], rows: [], matrix: [], delimiter };

  const seen = new Map();
  const headers = matrix[0].map((raw, index) => {
    const base = raw || `column_${index + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base}_${count + 1}` : base;
  });
  const rows = matrix.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? "";
    });
    return record;
  });
  return { headers, rows, matrix, delimiter };
}

export function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const HEADER_SYNONYMS = {
  title: ["title", "song_title", "track_title", "song", "track", "name", "recording_title"],
  artist: ["artist", "artists", "track_artist", "performer", "singer", "album_artist"],
  album: ["album", "album_title", "release", "release_title"],
  isrc: ["isrc", "track_isrc"],
  upc: ["upc", "album_upc", "ean", "barcode"],
  label: ["label", "album_label", "record_label"],
  genre: ["genre", "genres", "track_genres"],
  release_date: ["release_date", "original_release_date", "album_release_date", "date", "released"],
  custom_id: ["custom_id", "track_custom_id", "customid", "custom"],
  filename: ["filename", "file_name", "file", "track_filename", "audio", "audio_file"],
  track_number: ["track_number", "track_no", "no", "number", "track_num", "index"],
  pline: ["pline", "track_pline", "p_line"],
  explicit: ["explicit", "track_explicit_lyrics", "explicit_lyrics"],
  notes: ["notes", "note", "comment", "comments", "description"],
  asset_labels: ["asset_labels", "add_asset_labels", "labels", "asset_label"],
  claim_id: ["claim_id", "claim"]
};

/** Map a pasted column header to one of the known row fields (or null). */
export function guessColumnField(header) {
  const key = normalizeHeader(header);
  if (!key) return null;
  const entries = Object.entries(HEADER_SYNONYMS);
  const exact = entries.find(([, synonyms]) => synonyms.includes(key));
  if (exact) return exact[0];
  const partial = entries.find(([, synonyms]) => synonyms.some((synonym) => key.includes(synonym)));
  return partial ? partial[0] : null;
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

/** Save a Blob (e.g. stored audio fetched with getTrackAudioBlob) through a temporary object URL. */
export function downloadBlob(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "download";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadTextFile(text, filename, mime = "text/plain;charset=utf-8") {
  downloadBlob(new Blob([text], { type: mime }), filename || "download.txt");
}

export async function copyToClipboard(text) {
  const value = String(text ?? "");
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function readLocalStorage(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return typeof fallback === "function" ? fallback() : fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return typeof fallback === "function" ? fallback() : fallback;
  }
}

export function writeLocalStorage(key, value) {
  try {
    if (value === undefined || value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
}

export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Canonical English (tk): render the result with tm() so the frontend messages below and the
// server answers are translated at the display site.
export function getErrorMessage(error) {
  if (!error) return tk("Request failed");
  if (typeof error === "string") return error;
  if (error.code === "ERR_CANCELED" || error.name === "CanceledError" || error.name === "AbortError") {
    return tk("Cancelled");
  }
  if (error.code === "ECONNABORTED") return tk("Request timed out");
  const data = error.response?.data;
  const status = Number(error.response?.status);
  const htmlResponse = typeof data === "string" && /<!doctype\s+html\b|<html\b|<head\b|<body\b/i.test(data);
  // Blob responses (responseType: "blob") carry the error body as a Blob; fall through to the generic message.
  if (data && !(typeof Blob !== "undefined" && data instanceof Blob)) {
    if (typeof data === "string" && !htmlResponse && status !== 413) return data;
    // Keep structured backend validation messages, including its configured media size limit.
    if (data.message) return data.message;
    if (data.error && typeof data.error === "string") return data.error;
    if (Array.isArray(data.errors) && data.errors.length) {
      return data.errors.map((item) => item.message || item.error || String(item)).join("; ");
    }
  }
  // A reverse proxy can reject the upload before it ever reaches the application.
  if (status === 413) {
    return tk("The file exceeds the server's upload size limit (HTTP 413). Ask an administrator to increase the limit, then retry the upload.");
  }
  if (htmlResponse) return tk("The server returned an error page. Please try again or contact an administrator.");
  return error.message || tk("Request failed");
}

// ---------------------------------------------------------------------------
// Ownership / policy summaries
// ---------------------------------------------------------------------------

function territoryListSummary(codes = [], max = 5) {
  const list = unique(codes.map((code) => String(code || "").toUpperCase()).filter(Boolean));
  if (!list.length) return "";
  const visible = list.slice(0, max).join(", ");
  return list.length > max ? `${visible} +${list.length - max}` : visible;
}

export function territoryName(code) {
  return TERRITORY_NAME_BY_CODE[String(code || "").toUpperCase()] || "";
}

// Rendered in the current language (t): components showing the summary must use useI18n().
export function summarizeOwnership(mode = "worldwide", territories = []) {
  if (!mode || mode === "worldwide") return t("Worldwide");
  const list = territoryListSummary(territories);
  if (mode === "include") return list ? t("Include: {list}", { list }) : t("Include: (none selected)");
  if (mode === "exclude") return list ? t("Exclude: {list}", { list }) : t("Worldwide (nothing excluded)");
  return String(mode);
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

// Policy rule action → summary part; an action missing here falls back to the capitalized action.
const POLICY_ACTION_SUMMARIES = {
  monetize: tk("Monetize ({scope})"),
  track: tk("Track ({scope})"),
  block: tk("Block ({scope})"),
  takedown: tk("Takedown ({scope})"),
  unknown: tk("Unknown ({scope})")
};

/** "Monetize (WW) · Block (exclude VN) · review" from PolicyRule[] */
export function summarizePolicyRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return "";
  const parts = [];
  let review = false;
  rules.forEach((rule) => {
    if (!rule) return;
    const action = rule.action || "unknown";
    const required = rule.conditions?.requiredTerritories;
    let scope = "WW";
    if (required && Array.isArray(required.territories) && required.territories.length) {
      const list = territoryListSummary(required.territories);
      scope = required.type === "exclude" ? t("exclude {list}", { list }) : list;
    }
    parts.push(POLICY_ACTION_SUMMARIES[action] ? t(POLICY_ACTION_SUMMARIES[action], { scope }) : `${capitalize(action)} (${scope})`);
    if (Array.isArray(rule.subaction) && rule.subaction.includes("review")) review = true;
  });
  if (review) parts.push(t("review"));
  return parts.join(" · ");
}
