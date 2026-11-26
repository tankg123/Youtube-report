import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  AudioLines,
  Ban,
  BadgeCheck,
  Calendar,
  CheckCircle2,
  Circle,
  Clock,
  CloudUpload,
  Copy,
  Disc3,
  Download,
  Eye,
  ExternalLink,
  FileAudio,
  FileText,
  FileVideo,
  Globe,
  HardDrive,
  Hash,
  History,
  Info,
  Layers,
  Link,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Music,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Tag,
  Trash2,
  Upload,
  UserRound,
  Video,
  X,
  XCircle
} from "lucide-react";
import {
  cleanupProductAudio,
  createCmsAssetLabel,
  createTrackReferenceFromClaim,
  deleteProduct,
  deleteTrackAudio,
  deliverProduct,
  deliverTrackReference,
  getDeliveryOptions,
  getProduct,
  getProductProgress,
  getTrackAudioBlob,
  listTrackClaims,
  reactivateProduct,
  reactivateTrack,
  retryTrack,
  syncProduct,
  syncTrack,
  takedownProduct,
  takedownTrack,
  updateProduct,
  updateProductRights,
  updateTrack,
  uploadTrackAudio
} from "../../api/deliveryApi";
import {
  Badge,
  Button,
  Card,
  ChipInput,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Field,
  FilePickerButton,
  IconButton,
  InlineMessage,
  JsonViewer,
  Modal,
  PolicySelect,
  ProgressBar,
  Select,
  Spinner,
  StatTile,
  StatusBadge,
  TabBar,
  TerritoryPicker,
  TextArea,
  TextInput,
  Toggle
} from "./shared";
import {
  ASSET_TYPE_META,
  AUDIO_ACCEPT,
  EVENT_ACTION_META,
  GENRES,
  IMAGE_ACCEPT,
  MEDIA_ACCEPT_BY_KIND,
  PRODUCT_STATUS_META,
  REFERENCE_CONTENT_TYPES,
  REFERENCE_DEAD_STATUSES,
  REFERENCE_LIVE_STATUSES,
  REFERENCE_STATUS_META,
  STEP_LABELS,
  TRACK_STATUS_META,
  assetTypeMeta
} from "./constants";
import {
  cleanCode,
  cx,
  downloadBlob,
  downloadTextFile,
  formatBytes,
  formatDate,
  formatDateTime,
  getErrorMessage,
  guessAudioMime,
  isMediaFile,
  isValidIsrc,
  isValidUpc,
  joinList,
  makeClientId,
  matchFilesToTracks,
  normalizeIsrc,
  rowsToCsv,
  splitList,
  summarizeOwnership,
  toDateInputValue,
  truncate
} from "./utils";
import { useDocumentVisible, useInterval } from "./hooks";
import { useI18n } from "../../context/I18nContext";
import { useSystemSettings } from "../../context/SystemSettingsContext";
import { tk } from "../../i18n/index.js";
import DeliveryLogViewer from "./DeliveryLogViewer";
import ShortMediaDialog from "./ShortMediaDialog";
import { MIN_VIDEO_REFERENCE_SECONDS, formatSeconds, probeMediaDuration } from "./mediaProbe";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Background delivery job: poll the lightweight progress endpoint every 2 s
// while the server is working; otherwise refresh the product every 60 s while
// references are still being processed by YouTube.
const JOB_POLL_MS = 2000;
const AUTO_REFRESH_MS = 60000;

// Reference statuses that mean YouTube is still working on the fingerprint.
const PROCESSING_REFERENCE_STATUSES = new Set([
  "activating",
  "checking",
  "checking_quota",
  "computing_fingerprint",
  "live_streaming_processing",
  "deactivating"
]);

// Live / dead classification mirrors the backend (spec §1.5). The arrays come
// from constants.js; the fallbacks keep this page working if they are missing.
const LIVE_REFERENCE_STATUSES = new Set(
  Array.isArray(REFERENCE_LIVE_STATUSES) && REFERENCE_LIVE_STATUSES.length
    ? REFERENCE_LIVE_STATUSES
    : ["active", "activating", "checking", "checking_quota", "computing_fingerprint", "live_streaming_processing"]
);
const DEAD_REFERENCE_STATUSES = new Set(
  Array.isArray(REFERENCE_DEAD_STATUSES) && REFERENCE_DEAD_STATUSES.length ? REFERENCE_DEAD_STATUSES : ["inactive", "deactivating", "deleted"]
);

const STEP_TEXT = {
  queued: tk("Queued"),
  insert: tk("Creating asset"),
  ownership: tk("Ownership"),
  policy: tk("Match policy"),
  labels: tk("Labels"),
  reference: tk("Uploading reference"),
  audio: tk("Uploading audio"),
  check: tk("Checking duplicates"),
  ...(STEP_LABELS && typeof STEP_LABELS === "object" ? STEP_LABELS : {})
};

// Track statuses the "Deliver pending tracks" action picks up. `creating` / `uploading` are
// only deliverable as stale rows of a product that was left "delivering" with no job (a crash);
// otherwise a retry request is still working on them and the server refuses a second run.
const DELIVERABLE_TRACK_STATUSES = new Set(["pending", "error"]);
const STALE_TRACK_STATUSES = new Set(["creating", "uploading"]);

const STEP_ITEMS = [
  { key: "insert", label: tk("Create asset"), description: tk("POST /assets (sound_recording)") },
  { key: "ownership", label: tk("Ownership"), description: tk("PUT /assets/{id}/ownership") },
  { key: "policy", label: tk("Match policy"), description: tk("PUT /assets/{id}/matchPolicy") },
  { key: "labels", label: tk("Asset labels"), description: tk("PATCH /assets/{id} label[]") },
  { key: "reference", label: tk("Reference"), description: tk("Audio fingerprint upload") }
];

const TONE_CLASSES = {
  slate: "bg-slate-100 text-slate-600",
  blue: "bg-blue-50 text-blue-700",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-600",
  indigo: "bg-indigo-50 text-indigo-700"
};

const EVENT_ICONS = {
  create: Plus,
  deliver: Send,
  reference_upload: Upload,
  reference_from_claim: Link,
  audio_upload: FileAudio,
  audio_delete: Trash2,
  retry: RotateCcw,
  sync: RefreshCw,
  metadata_update: Pencil,
  rights_update: ShieldCheck,
  takedown: Ban,
  reactivate: BadgeCheck,
  delete: Trash2
};

const EVENT_TONES = {
  create: "slate",
  deliver: "blue",
  reference_upload: "indigo",
  reference_from_claim: "indigo",
  audio_upload: "indigo",
  audio_delete: "amber",
  retry: "amber",
  sync: "slate",
  metadata_update: "blue",
  rights_update: "blue",
  takedown: "red",
  reactivate: "emerald",
  delete: "red"
};

const ROW_ACTION_LABELS = {
  retry: tk("Retry"),
  sync: tk("Sync"),
  edit: tk("Save"),
  takedown: tk("Takedown"),
  reactivate: tk("Reactivate"),
  reference: tk("Reference delivery"),
  "from-claim": tk("Reference from claim"),
  "audio-download": tk("Download")
};

/** Label of a failed row action; the media actions name the stored file type (audio / video). */
function rowActionLabel(t, action, meta) {
  if (action === "audio-upload") return t("{media} upload", { media: capitalize(t(meta.media)) });
  if (action === "audio-remove") return t("Remove {media}", { media: t(meta.media) });
  return ROW_ACTION_LABELS[action] ? t(ROW_ACTION_LABELS[action]) : "";
}

// ---------------------------------------------------------------------------
// Kind-aware wording
// ---------------------------------------------------------------------------

// The same page serves music releases (Sound Recording assets, audio files) and video
// batches (Web / Music video assets, video files). `ASSET_TYPE_META` carries the per-type
// nouns (track / video, audio file / video file); this table holds the page-level phrases.
const DETAIL_COPY = {
  music: {
    product: tk("product"),
    Product: tk("Product"),
    backLabel: tk("Back to products"),
    loading: tk("Loading product…"),
    unavailable: tk("Product unavailable"),
    notFound: tk("Product not found"),
    itemIcon: Music,
    mediaIcon: FileAudio,
    filesTile: tk("Audio"),
    filesTileHint: tk("stored on server"),
    mediaHeader: tk("Audio"),
    serverMedia: tk("Server audio"),
    editTitle: tk("Edit release info"),
    levelWord: tk("Album"),
    infoSaved: tk("Release info saved"),
    titleLabel: tk("Release title"),
    titlePlaceholder: tk("Album / single title"),
    artistLabel: tk("Album artist"),
    artistPlaceholder: tk("Main artist(s)"),
    labelLabel: tk("Label"),
    labelHint: "",
    referenceToggle: tk("Deliver audio references automatically"),
    uploadHint: tk("Names like «VNA0123456789 - Song.wav», «03 - Song title.wav» or the track title itself are matched automatically. Every track can be matched once.")
  },
  video: {
    product: tk("batch"),
    Product: tk("Video batch"),
    backLabel: tk("Back to video batches"),
    loading: tk("Loading video batch…"),
    unavailable: tk("Video batch unavailable"),
    notFound: tk("Video batch not found"),
    itemIcon: Video,
    mediaIcon: FileVideo,
    filesTile: tk("Files"),
    filesTileHint: tk("video files on server"),
    mediaHeader: tk("Video file"),
    serverMedia: tk("Server video files"),
    editTitle: tk("Edit batch info"),
    levelWord: tk("Batch"),
    infoSaved: tk("Batch info saved"),
    titleLabel: tk("Batch name"),
    titlePlaceholder: tk("e.g. Channel uploads · October 2026"),
    artistLabel: tk("Creator / channel"),
    artistPlaceholder: tk("Creator or channel name"),
    labelLabel: tk("Custom ID prefix"),
    labelHint: tk("Used as the prefix of generated custom IDs"),
    referenceToggle: tk("Deliver reference files automatically"),
    uploadHint: tk("Names like «01 - Episode title.mp4» or the video title itself are matched automatically. Every video can be matched once.")
  }
};

// Asset type as written in sentences ("… created as Sound Recording assets").
const ASSET_NOUNS = { sound_recording: tk("Sound Recording"), web: tk("Web video"), music_video: tk("Music video") };

// Product fields each asset type carries (mirrors the backend product validation): web videos
// have no UPC / release date / genre / artwork, music videos keep UPC and release date.
const PRODUCT_FORM_BY_TYPE = {
  sound_recording: { upc: true, releaseDate: true, genre: true, artwork: true, patched: tk("album, UPC, label, genre, release date, notes") },
  web: { upc: false, releaseDate: false, genre: false, artwork: false, patched: tk("batch name, creator, custom ID prefix, notes") },
  music_video: { upc: true, releaseDate: true, genre: false, artwork: false, patched: tk("batch name, creator, UPC, custom ID prefix, release date, notes") }
};

// Meta used while the product is still loading (the page only knows its kind by then).
const DEFAULT_META_BY_KIND = { music: ASSET_TYPE_META.sound_recording, video: ASSET_TYPE_META.web };

function assetTypeKey(assetType) {
  const key = String(assetType || "").toLowerCase();
  return ASSET_TYPE_META[key] ? key : "sound_recording";
}

function assetNoun(assetType) {
  return ASSET_NOUNS[assetTypeKey(assetType)];
}

function productFormOf(assetType) {
  return PRODUCT_FORM_BY_TYPE[assetTypeKey(assetType)];
}

function copyOf(meta) {
  return DETAIL_COPY[meta?.kind] || DETAIL_COPY.music;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

const EXPORT_COLUMNS = [
  { label: "track_number", value: (track) => track.track_number },
  { label: "title", value: (track) => track.title },
  { label: "artist", value: (track) => track.artist },
  { label: "isrc", value: (track) => track.isrc },
  { label: "custom_id", value: (track) => track.custom_id },
  { label: "notes", value: (track) => track.notes },
  { label: "description", value: (track) => track.description },
  { label: "source_url", value: (track) => track.source_url },
  { label: "asset_id", value: (track) => track.asset_id },
  { label: "asset_status", value: (track) => track.asset_status },
  { label: "reference_id", value: (track) => track.reference_id },
  { label: "reference_status", value: (track) => track.reference_status },
  { label: "reference_content_type", value: (track) => track.reference_content_type },
  { label: "match_policy_name", value: (track) => track.match_policy_name },
  { label: "match_policy_id", value: (track) => track.match_policy_id },
  { label: "asset_labels", value: (track) => labelsOf(track).join("|") },
  { label: "has_audio", value: (track) => (hasStoredAudio(track) ? 1 : 0) },
  { label: "file_name", value: (track) => track.file_name },
  { label: "file_size", value: (track) => track.file_size },
  { label: "file_mime", value: (track) => track.file_mime },
  { label: "file_uploaded_at", value: (track) => track.file_uploaded_at },
  { label: "status", value: (track) => track.status },
  { label: "step", value: (track) => track.step },
  { label: "error_message", value: (track) => track.error_message },
  { label: "delivered_at", value: (track) => track.delivered_at },
  { label: "last_synced_at", value: (track) => track.last_synced_at }
];

const DETAIL_TABS = [
  { key: "metadata", label: tk("Metadata"), icon: FileText },
  { key: "ownership", label: tk("Ownership"), icon: Globe },
  { key: "response", label: tk("Last response"), icon: Activity },
  { key: "cms", label: tk("CMS snapshot"), icon: Layers }
];

// Fields copied from the polling payload (GET /products/:id/progress).
const PROGRESS_TRACK_FIELDS = ["status", "step", "asset_id", "reference_id", "reference_status", "error_message", "file_name", "file_size", "has_audio"];
const PROGRESS_PRODUCT_FIELDS = ["status", "track_count", "delivered_count", "completed_count", "error_count", "job_started_at", "job_finished_at", "include_reference", "delete_reference_after_delivery"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a status meta entry always carries `cls` (StatusBadge needs it). */
function withClasses(meta) {
  const output = {};
  Object.entries(meta || {}).forEach(([key, entry]) => {
    if (!entry || typeof entry !== "object") return;
    output[key] = { ...entry, cls: entry.cls || TONE_CLASSES[entry.tone] || TONE_CLASSES.slate };
  });
  return output;
}

const PRODUCT_META = withClasses(PRODUCT_STATUS_META);
// `uploading` is defined in constants.js (v3); the local fallback only applies when it is missing.
const TRACK_META = withClasses({ uploading: { label: tk("Uploading reference"), tone: "blue", spin: true }, ...TRACK_STATUS_META });
const REFERENCE_META = withClasses(REFERENCE_STATUS_META);

function safeJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function pickJson(row, parsedKey, jsonKey, fallback) {
  if (!row) return fallback;
  if (row[parsedKey] !== undefined && row[parsedKey] !== null) return safeJson(row[parsedKey], fallback);
  return safeJson(row[jsonKey], fallback);
}

function stepsOf(track) {
  const steps = pickJson(track, "steps", "steps_json", {});
  return steps && typeof steps === "object" ? steps : {};
}

function labelsOf(row) {
  const labels = pickJson(row, "asset_labels", "asset_labels", null);
  if (Array.isArray(labels)) return labels.map((item) => String(item)).filter(Boolean);
  if (typeof labels === "string") return splitList(labels);
  return [];
}

/** Track-level label override: null means "inherit from product". */
function trackLabelOverride(track) {
  const raw = track?.asset_labels;
  if (raw === null || raw === undefined || raw === "") return null;
  return labelsOf(track);
}

function duplicatesOf(track) {
  const duplicates = pickJson(track, "duplicates", "duplicate_json", []);
  return Array.isArray(duplicates) ? duplicates : [];
}

/**
 * Convert a Google RightsOwnership payload ({ general:[{ type, territories }] })
 * — the shape stored on track rows — into the UI shape { mode, territories }.
 */
function rightsToUi(rights) {
  const general = Array.isArray(rights?.general) ? rights.general[0] : null;
  if (!general || typeof general !== "object") return null;
  const territories = Array.isArray(general.territories) ? general.territories.map((code) => String(code)) : [];
  const type = String(general.type || "").toLowerCase();
  if (type === "include") return { mode: "include", territories };
  return territories.length ? { mode: "exclude", territories } : { mode: "worldwide", territories: [] };
}

function ownershipOf(row) {
  const ownership = pickJson(row, "ownership", "ownership_json", null);
  if (ownership && typeof ownership === "object") {
    if (Array.isArray(ownership.general)) return rightsToUi(ownership) || { mode: "worldwide", territories: [] };
    if (ownership.mode) {
      return { mode: ownership.mode, territories: Array.isArray(ownership.territories) ? ownership.territories : [] };
    }
  }
  return { mode: "worldwide", territories: [] };
}

function jobOf(raw) {
  return raw && typeof raw === "object" ? { running: Boolean(raw.running), ...raw } : { running: false };
}

function normalizeProduct(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const events = Array.isArray(raw.events) ? raw.events : [];
  return {
    ...raw,
    asset_labels: labelsOf(raw),
    ownership: ownershipOf(raw),
    job: jobOf(raw.job),
    tracks: [...tracks].sort((a, b) => Number(a.track_number || 0) - Number(b.track_number || 0) || Number(a.id) - Number(b.id)),
    events: [...events].sort((a, b) => Number(b.id) - Number(a.id))
  };
}

function pickDefined(source, keys) {
  const output = {};
  if (!source || typeof source !== "object") return output;
  keys.forEach((key) => {
    if (source[key] !== undefined) output[key] = source[key];
  });
  return output;
}

/** Merge a progress payload into the loaded product without dropping events/artwork. */
function mergeProgress(current, data) {
  if (!current || !data || typeof data !== "object") return current;
  const byId = new Map((Array.isArray(data.tracks) ? data.tracks : []).map((item) => [Number(item.id), item]));
  const tracks = (current.tracks || []).map((track) => {
    const next = byId.get(Number(track.id));
    return next ? { ...track, ...pickDefined(next, PROGRESS_TRACK_FIELDS) } : track;
  });
  return {
    ...current,
    ...pickDefined(data.product, PROGRESS_PRODUCT_FIELDS),
    job: data.job && typeof data.job === "object" ? { ...(current.job || {}), ...data.job, running: Boolean(data.job.running) } : { ...(current.job || {}), running: false },
    tracks
  };
}

function includeReferenceOf(product) {
  const value = product?.include_reference;
  if (value === undefined || value === null || value === "") return true;
  return Boolean(Number(value));
}

function trackLabel(t, track) {
  return track?.title || track?.isrc || (track?.id ? t("Track #{id}", { id: track.id }) : t("Track"));
}

function isProcessingReference(status) {
  return PROCESSING_REFERENCE_STATUSES.has(String(status || "").toLowerCase());
}

function isLiveReferenceStatus(status) {
  return LIVE_REFERENCE_STATUSES.has(String(status || "").toLowerCase());
}

function isDeadReferenceStatus(status) {
  return DEAD_REFERENCE_STATUSES.has(String(status || "").toLowerCase());
}

function hasLiveReference(track) {
  return Boolean(track?.reference_id) && isLiveReferenceStatus(track.reference_status);
}

// Mirrors the backend rule (store.isAudioReleasable): stored audio may be removed once the
// track is fully delivered (every asset step done) and CMS holds a live reference for it.
function isAudioReleasable(track) {
  const steps = stepsOf(track);
  return hasStoredAudio(track) && track.status === "completed" && Boolean(track.asset_id)
    && Boolean(steps.insert && steps.ownership && steps.policy && steps.labels) && hasLiveReference(track);
}

function hasStoredAudio(track) {
  if (!track) return false;
  if (track.has_audio !== undefined && track.has_audio !== null) return Boolean(track.has_audio);
  return Boolean(track.file_path);
}

function isInFlight(track) {
  return STALE_TRACK_STATUSES.has(track?.status);
}

function canRetry(track) {
  return track.status === "error" || track.status === "duplicate";
}

function canReferenceFromClaim(track) {
  return Boolean(track.asset_id) && track.status !== "taken_down" && !isInFlight(track);
}

/** Server-side reference delivery from the stored audio file. */
function canDeliverReference(track) {
  return canReferenceFromClaim(track) && hasStoredAudio(track) && !hasLiveReference(track);
}

function canTakedown(track) {
  return Boolean(track.asset_id) && track.status !== "taken_down" && !isInFlight(track);
}

function isDeliverable(track, jobRunning, interrupted = false) {
  if (DELIVERABLE_TRACK_STATUSES.has(track.status)) return true;
  return !jobRunning && interrupted && STALE_TRACK_STATUSES.has(track.status);
}

/** Meta for the reference badge: known statuses keep their entry, unknown ones get a live/dead tone. */
function referenceMeta(status) {
  const key = String(status || "").toLowerCase();
  if (!key || REFERENCE_META[key]) return REFERENCE_META;
  const tone = isLiveReferenceStatus(key) ? "emerald" : isDeadReferenceStatus(key) ? "slate" : "amber";
  return { ...REFERENCE_META, [key]: { label: key.replace(/_/g, " "), cls: TONE_CLASSES[tone], tone } };
}

function initialsOf(title) {
  const words = String(title || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return words.map((word) => word[0].toUpperCase()).join("") || "?";
}

function countBy(tracks, predicate) {
  return tracks.reduce((total, track) => (predicate(track) ? total + 1 : total), 0);
}

function summarizeErrors({ t, tm }, errors) {
  if (!Array.isArray(errors) || !errors.length) return "";
  const first = tm(errors[0]?.message || errors[0]?.error || String(errors[0]));
  return errors.length === 1 ? first : t("{message} (+{count} more)", { message: first, count: errors.length - 1 });
}

function toAudioBlob(data, fileName) {
  const fallbackType = guessAudioMime(fileName) || "application/octet-stream";
  let blob;
  if (data instanceof Blob) blob = data;
  else if (data?.data instanceof Blob) blob = data.data;
  else if (data?.blob instanceof Blob) blob = data.blob;
  else blob = new Blob([data ?? ""], { type: fallbackType });
  return blob.type ? blob : new Blob([blob], { type: fallbackType });
}

function audioVersionOf(track) {
  return `${track?.file_uploaded_at || ""}|${track?.file_sha256 || ""}|${track?.file_size || ""}`;
}

/** Downscale an image file to a JPEG data URL (max edge `maxSize`). */
function resizeImageToDataUrl(file, maxSize = 512, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(tk("The selected file is not a readable image")));
    };
    image.src = url;
  });
}

function dataUrlSize(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.round((base64.length * 3) / 4);
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function InfoItem({ label, children, mono = false, className }) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div className={cx("rounded-2xl bg-slate-50 px-4 py-3", className)}>
      <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">{label}</p>
      <div className={cx("mt-1 break-words text-sm font-bold text-slate-900", mono && "font-mono text-xs")}>
        {empty ? <span className="text-slate-400">–</span> : children}
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, children, aside }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="inline-flex items-center gap-2 text-sm font-black uppercase tracking-wide text-slate-500">
        {Icon ? <Icon size={15} /> : null}
        {children}
      </h3>
      {aside}
    </div>
  );
}

function MonoCode({ value, copy = true, className }) {
  if (!value) return <span className="text-xs text-slate-400">–</span>;
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1 font-mono text-xs font-bold text-slate-900", className)}>
      <span className="truncate" title={String(value)}>
        {value}
      </span>
      {copy && <CopyButton text={String(value)} iconOnly />}
    </span>
  );
}

/** External link to the official URL of a video item (web / music video assets); "–" when empty. */
function SourceLink({ url, max = 40, className }) {
  const href = String(url || "").trim();
  if (!href) return <span className="text-xs text-slate-400">–</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      className={cx("inline-flex max-w-full items-center gap-1 text-xs font-bold text-blue-700 hover:underline", className)}
    >
      <span className="truncate">{truncate(href.replace(/^https?:\/\/(www\.)?/i, ""), max)}</span>
      <ExternalLink size={12} className="shrink-0" />
    </a>
  );
}

function StepsChecklist({ track, product }) {
  const { t } = useI18n();
  const steps = stepsOf(track);
  const failedStep = track.status === "error" ? track.step : "";
  const activeStep = isInFlight(track) ? track.step : "";
  // The two type-specific steps name the asset type created and the kind of reference fingerprinted.
  const descriptions = {
    insert: `POST /assets (${assetTypeKey(product?.asset_type)})`,
    reference: t("{reference} fingerprint upload", { reference: capitalize(t(assetTypeMeta(product?.asset_type).reference)) })
  };
  return (
    <ol className="grid gap-2 md:grid-cols-5">
      {STEP_ITEMS.map((item, index) => {
        const done = Boolean(steps[item.key]);
        const failed = !done && failedStep === item.key;
        const active = !done && !failed && activeStep === item.key;
        const Icon = done ? CheckCircle2 : failed ? XCircle : active ? Loader2 : Circle;
        return (
          <li
            key={item.key}
            className={cx(
              "rounded-2xl border px-3 py-3",
              done
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : failed
                  ? "border-red-200 bg-red-50 text-red-600"
                  : active
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-500"
            )}
          >
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide">
              <Icon size={15} className={active ? "animate-spin" : undefined} />
              {index + 1}. {t(item.label)}
            </div>
            <p className="mt-1 text-[11px] font-bold opacity-80">{descriptions[item.key] || t(item.description)}</p>
          </li>
        );
      })}
    </ol>
  );
}

function StepDots({ track }) {
  const { t } = useI18n();
  const steps = stepsOf(track);
  return (
    <div className="flex gap-1" title={STEP_ITEMS.map((item) => `${t(item.label)}: ${steps[item.key] ? t("done") : t("pending")}`).join("\n")}>
      {STEP_ITEMS.map((item) => (
        <span
          key={item.key}
          className={cx(
            "h-1.5 w-4 rounded-full",
            steps[item.key]
              ? "bg-emerald-500"
              : track.status === "error" && track.step === item.key
                ? "bg-red-500"
                : isInFlight(track) && track.step === item.key
                  ? "bg-blue-400"
                  : "bg-slate-200"
          )}
        />
      ))}
    </div>
  );
}

function DuplicatesTable({ duplicates }) {
  const { t } = useI18n();
  if (!duplicates.length) return null;
  return (
    <div className="overflow-x-auto rounded-2xl border border-amber-200">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-amber-50 text-xs font-black uppercase tracking-wide text-amber-700">
          <tr>
            <th className="px-4 py-3">{t("Existing asset")}</th>
            <th className="px-4 py-3">{t("Title")}</th>
            <th className="px-4 py-3">{t("ISRC")}</th>
            <th className="px-4 py-3">{t("Custom ID")}</th>
            <th className="px-4 py-3">{t("Type")}</th>
            <th className="px-4 py-3">{t("Created")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {duplicates.map((item, index) => {
            const assetId = item.asset_id || item.id || "";
            return (
              <tr key={`${assetId || "dup"}-${index}`}>
                <td className="px-4 py-3">
                  <MonoCode value={assetId} />
                </td>
                <td className="px-4 py-3 font-bold text-slate-700">{item.title || "–"}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{item.isrc || "–"}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{item.custom_id || item.customId || "–"}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{item.type || "–"}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{formatDateTime(item.time_created || item.timeCreated) || "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Compact "…" menu rendered with fixed positioning so the table's overflow does not clip it. */
function RowMenu({ items, disabled = false, label = tk("More actions") }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const visibleItems = items.filter(Boolean);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event) => {
      if (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handleScroll = () => setOpen(false);
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open]);

  function toggle() {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const width = 220;
      const height = visibleItems.length * 38 + 12;
      const openUp = rect.bottom + height + 8 > window.innerHeight && rect.top - height - 8 > 0;
      setPosition({
        top: openUp ? rect.top - height - 6 : rect.bottom + 6,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      });
    }
    setOpen((current) => !current);
  }

  return (
    <>
      <span ref={buttonRef} className="inline-flex">
        <IconButton icon={MoreHorizontal} label={t(label)} size="sm" disabled={disabled} onClick={toggle} aria-haspopup="menu" aria-expanded={open} />
      </span>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          style={{ position: "fixed", top: position.top, left: position.left, width: 220 }}
          className="z-40 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl"
        >
          {visibleItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick?.();
                }}
                className={cx(
                  "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-50",
                  item.tone === "danger" ? "text-red-600 hover:bg-red-50" : item.tone === "success" ? "text-emerald-700 hover:bg-emerald-50" : "text-slate-700 hover:bg-slate-50"
                )}
              >
                {Icon && <Icon size={15} />}
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Hidden single-file input rendered as an icon button or a small text button. */
function AudioFileButton({ icon, label, accept = AUDIO_ACCEPT, disabled = false, onFile, tone = "slate", variant = "secondary", children }) {
  const inputRef = useRef(null);
  return (
    <>
      {children ? (
        <Button size="sm" variant={variant} icon={icon} disabled={disabled} onClick={() => inputRef.current?.click()} title={label}>
          {children}
        </Button>
      ) : (
        <IconButton icon={icon} label={label} size="sm" tone={tone} disabled={disabled} onClick={() => inputRef.current?.click()} />
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}

/**
 * Inline player for the audio or video file stored on the server. The file is
 * fetched as a blob (the API needs the auth header, so a plain URL cannot be
 * used) and the object URL is revoked when the player unmounts or the file changes.
 */
function AudioPlayer({ trackId, version, fileName, kind = "music", onClose }) {
  const { t, tm } = useI18n();
  const isVideo = kind === "video";
  const media = isVideo ? "video" : "audio";
  const HeaderIcon = isVideo ? Video : AudioLines;
  const loadKey = `${trackId}|${version}`;
  const [state, setState] = useState({ key: "", url: "", error: "" });
  const loading = state.key !== loadKey;

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    getTrackAudioBlob(trackId, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(toAudioBlob(data, fileName));
        setState({ key: loadKey, url: objectUrl, error: "" });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState({ key: loadKey, url: "", error: getErrorMessage(err) });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [trackId, loadKey, fileName]);

  return (
    <div className={cx("mt-1 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm", isVideo ? "w-[360px]" : "w-[260px]")}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1 text-[11px] font-bold text-slate-500">
          <HeaderIcon size={12} className="shrink-0" />
          <span className="truncate" title={fileName}>
            {fileName || t(media)}
          </span>
        </span>
        <IconButton icon={X} label={t("Close player")} size="sm" tone="ghost" onClick={onClose} />
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-[11px] font-bold text-slate-500">
          <Spinner size={13} /> {t("Loading {media}…", { media: t(media) })}
        </div>
      ) : state.error ? (
        <p className="py-1 text-[11px] font-bold text-red-600">{tm(state.error)}</p>
      ) : isVideo ? (
        <video controls preload="metadata" src={state.url} className="mt-1 max-h-64 w-full rounded-xl bg-black">
          {t("Your browser cannot play this file.")}
        </video>
      ) : (
        <audio controls autoPlay src={state.url} className="mt-1 h-9 w-full">
          {t("Your browser cannot play this file.")}
        </audio>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit release info
// ---------------------------------------------------------------------------

const ARTWORK_MAX_BYTES = 400 * 1024;
const OTHER_LABEL = "__other__";

function EditProductModal({ product, meta, localLabels = [], onClose, onSubmit }) {
  const { t, tm } = useI18n();
  const copy = copyOf(meta);
  const fields = productFormOf(product.asset_type);
  const videoKind = meta.kind === "video";
  const labelNames = useMemo(() => localLabels.map((label) => label.display_name || label.name).filter(Boolean), [localLabels]);
  const initialLabel = product.label || "";
  const [form, setForm] = useState(() => ({
    title: product.title || "",
    artist: product.artist || "",
    upc: product.upc || "",
    label: initialLabel,
    genre: splitList(product.genre),
    release_date: toDateInputValue(product.release_date),
    artwork_name: product.artwork_name || "",
    artwork_data_url: product.artwork_data_url || "",
    notes: product.notes || ""
  }));
  const [labelMode, setLabelMode] = useState(() => (initialLabel && !labelNames.includes(initialLabel) ? "custom" : "list"));
  const [applyToCms, setApplyToCms] = useState(true);
  const [saving, setSaving] = useState(false);
  const [artworkBusy, setArtworkBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const deliveredCount = countBy(product.tracks || [], (track) => Boolean(track.asset_id));
  const upcInvalid = Boolean(form.upc) && !isValidUpc(form.upc);
  const artworkSize = form.artwork_data_url ? dataUrlSize(form.artwork_data_url) : 0;

  function patch(next) {
    setForm((current) => ({ ...current, ...next }));
    setFieldErrors({});
  }

  async function handleArtwork(files) {
    const file = files[0];
    if (!file) return;
    setArtworkBusy(true);
    setError("");
    try {
      let dataUrl = "";
      for (const quality of [0.85, 0.7, 0.55, 0.4]) {
        dataUrl = await resizeImageToDataUrl(file, 512, quality);
        if (dataUrlSize(dataUrl) <= ARTWORK_MAX_BYTES) break;
      }
      if (dataUrlSize(dataUrl) > ARTWORK_MAX_BYTES) {
        setError(tk("Artwork is still larger than 400 KB after resizing — choose a simpler image."));
        return;
      }
      patch({ artwork_data_url: dataUrl, artwork_name: file.name });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setArtworkBusy(false);
    }
  }

  async function handleSave() {
    const errors = {};
    if (!form.title.trim()) errors.title = t("{field} is required", { field: t(copy.titleLabel) });
    if (upcInvalid) errors.upc = tk("UPC must be 8–14 digits");
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        product: {
          title: form.title.trim(),
          artist: form.artist.trim(),
          upc: cleanCode(form.upc),
          label: form.label.trim(),
          genre: joinList(form.genre),
          release_date: form.release_date || "",
          artwork_name: form.artwork_data_url ? form.artwork_name : "",
          artwork_data_url: form.artwork_data_url || "",
          notes: form.notes.trim()
        },
        apply_to_cms: applyToCms
      });
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
      const serverErrors = err?.response?.data?.field_errors;
      if (serverErrors && typeof serverErrors === "object") setFieldErrors(serverErrors);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t(copy.editTitle)}
      subtitle={t("{level}-level metadata stored on every {assetType} asset of this {product}.", { level: t(copy.levelWord), assetType: t(assetNoun(product.asset_type)), product: t(copy.product) })}
      onClose={saving ? undefined : onClose}
      size="lg"
      closeOnBackdrop={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" icon={Pencil} loading={saving} onClick={handleSave}>
            {applyToCms && deliveredCount ? (deliveredCount === 1 ? t("Save & update {count} asset", { count: deliveredCount }) : t("Save & update {count} assets", { count: deliveredCount })) : t("Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <InlineMessage tone="error">{tm(error)}</InlineMessage>}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t(copy.titleLabel)} required error={tm(fieldErrors.title)} className="md:col-span-2">
            <TextInput value={form.title} invalid={Boolean(fieldErrors.title)} disabled={saving} onChange={(event) => patch({ title: event.target.value })} placeholder={t(copy.titlePlaceholder)} />
          </Field>
          <Field label={t(copy.artistLabel)} error={tm(fieldErrors.artist)}>
            <TextInput value={form.artist} disabled={saving} onChange={(event) => patch({ artist: event.target.value })} placeholder={t(copy.artistPlaceholder)} />
          </Field>
          {fields.upc && (
            <Field label={t("UPC")} error={tm(fieldErrors.upc) || (upcInvalid ? t("UPC must be 8–14 digits") : "")} hint={t("Optional · stored on every asset")}>
              <TextInput mono value={form.upc} invalid={upcInvalid || Boolean(fieldErrors.upc)} disabled={saving} onChange={(event) => patch({ upc: cleanCode(event.target.value) })} placeholder={t("e.g. 0123456789012")} maxLength={14} />
            </Field>
          )}
          <Field label={t(copy.labelLabel)} hint={copy.labelHint ? t(copy.labelHint) : undefined} error={tm(fieldErrors.label)}>
            {videoKind ? (
              <TextInput mono value={form.label} disabled={saving} onChange={(event) => patch({ label: event.target.value })} placeholder={t("e.g. MYCHANNEL")} />
            ) : labelMode === "list" ? (
              <Select
                value={form.label && labelNames.includes(form.label) ? form.label : form.label ? OTHER_LABEL : ""}
                disabled={saving}
                placeholder={t("No label")}
                onChange={(event) => {
                  if (event.target.value === OTHER_LABEL) {
                    setLabelMode("custom");
                    patch({ label: labelNames.includes(form.label) ? "" : form.label });
                  } else {
                    patch({ label: event.target.value });
                  }
                }}
                options={[...labelNames.map((name) => ({ value: name, label: name })), { value: OTHER_LABEL, label: t("Other…") }]}
              />
            ) : (
              <div className="flex gap-2">
                <TextInput value={form.label} disabled={saving} onChange={(event) => patch({ label: event.target.value })} placeholder={t("Label name")} />
                <Button
                  variant="ghost"
                  size="md"
                  disabled={saving}
                  onClick={() => {
                    setLabelMode("list");
                    if (!labelNames.includes(form.label)) patch({ label: "" });
                  }}
                >
                  {t("List")}
                </Button>
              </div>
            )}
          </Field>
          {fields.genre && (
            <Field label={t("Genre")} hint={t("Comma separated · pick from the list or type your own")} error={tm(fieldErrors.genre)}>
              <ChipInput values={form.genre} suggestions={GENRES} disabled={saving} onChange={(next) => patch({ genre: next })} placeholder={t("Add a genre…")} />
            </Field>
          )}
          {fields.releaseDate && (
            <Field label={t("Release date")} error={tm(fieldErrors.release_date)}>
              <TextInput type="date" value={form.release_date} disabled={saving} onChange={(event) => patch({ release_date: event.target.value })} />
            </Field>
          )}
          {fields.artwork && (
            <Field label={t("Artwork")} hint={t("Resized to 512 px JPEG · max 400 KB · stored locally only")} error={tm(fieldErrors.artwork_data_url)} className="md:col-span-2">
              <div className="flex flex-wrap items-center gap-3">
                {form.artwork_data_url ? (
                  <img src={form.artwork_data_url} alt={t("Artwork preview")} className="h-20 w-20 rounded-2xl border border-slate-200 object-cover" />
                ) : (
                  <span className="flex h-20 w-20 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-slate-400">
                    <Disc3 size={22} />
                  </span>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  {form.artwork_data_url ? (
                    <p className="truncate text-xs font-bold text-slate-600" title={form.artwork_name}>
                      {form.artwork_name || "artwork.jpg"} · {formatBytes(artworkSize)}
                    </p>
                  ) : (
                    <p className="text-xs font-bold text-slate-400">{t("No artwork")}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <FilePickerButton accept={IMAGE_ACCEPT} icon={Upload} size="sm" loading={artworkBusy} disabled={saving} onFiles={handleArtwork}>
                      {form.artwork_data_url ? t("Replace") : t("Choose image")}
                    </FilePickerButton>
                    {form.artwork_data_url && (
                      <Button variant="ghost" size="sm" icon={X} disabled={saving || artworkBusy} onClick={() => patch({ artwork_data_url: "", artwork_name: "" })}>
                        {t("Remove")}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </Field>
          )}
          <Field label={t("Notes")} hint={t("Used as the asset notes when a {item} has none", { item: t(meta.item) })} error={tm(fieldErrors.notes)} className="md:col-span-2">
            <TextArea rows={3} value={form.notes} disabled={saving} onChange={(event) => patch({ notes: event.target.value })} placeholder={t("Internal notes")} />
          </Field>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <Toggle
            checked={applyToCms}
            disabled={saving}
            onChange={setApplyToCms}
            label={t("Apply to CMS")}
            description={
              deliveredCount
                ? deliveredCount === 1
                  ? t("Patch the metadata of {count} delivered asset ({fields}).", { count: deliveredCount, fields: t(fields.patched) })
                  : t("Patch the metadata of {count} delivered assets ({fields}).", { count: deliveredCount, fields: t(fields.patched) })
                : t("No asset has been created yet — only the local record will change.")
            }
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Change rights
// ---------------------------------------------------------------------------

function RightsModal({ product, meta, options, optionsLoading, optionsError, reloadOptions, selectedIds, onClose, onSubmit }) {
  const { t, tm } = useI18n();
  const [ownership, setOwnership] = useState(() => ownershipOf(product));
  const [policyId, setPolicyId] = useState(product.match_policy_id || "");
  const [policyName, setPolicyName] = useState(product.match_policy_name || "");
  const [labels, setLabels] = useState(() => labelsOf(product));
  const [applyOwnership, setApplyOwnership] = useState(true);
  const [applyPolicy, setApplyPolicy] = useState(true);
  const [applyLabels, setApplyLabels] = useState(true);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const policies = Array.isArray(options?.policies) ? options.policies : [];
  const labelSuggestions = Array.isArray(options?.asset_labels) ? options.asset_labels : [];
  const tracks = product.tracks || [];
  const selectedDelivered = tracks.filter((track) => selectedIds.has(track.id) && track.asset_id);
  const deliveredCount = countBy(tracks, (track) => Boolean(track.asset_id));
  const targetCount = selectedOnly ? selectedDelivered.length : deliveredCount;
  const nothingSelected = !applyOwnership && !applyPolicy && !applyLabels;
  const ownershipInvalid = applyOwnership && ownership.mode === "include" && !ownership.territories.length;
  const policyInvalid = applyPolicy && !policyId;

  async function handleCreateLabel(name) {
    // Always the product's own CMS — never the network selected in the page header.
    const data = await createCmsAssetLabel(product.network_id, name);
    const created = data?.label?.labelName || name;
    reloadOptions?.();
    return created;
  }

  async function handleSave() {
    if (nothingSelected) {
      setError(tk("Choose at least one setting to update."));
      return;
    }
    if (ownershipInvalid) {
      setError(tk("Select at least one territory to include."));
      return;
    }
    if (policyInvalid) {
      setError(tk("A match policy is required."));
      return;
    }
    const payload = {};
    if (applyOwnership) payload.ownership = { mode: ownership.mode, territories: ownership.mode === "worldwide" ? [] : ownership.territories };
    if (applyPolicy) {
      payload.match_policy_id = policyId;
      payload.match_policy_name = policyName || policies.find((policy) => String(policy.id) === String(policyId))?.name || "";
    }
    if (applyLabels) payload.asset_labels = labels;
    if (selectedOnly) {
      if (!selectedDelivered.length) {
        setError(t("None of the selected {items} has an asset in CMS. Select delivered {items} or switch the toggle off.", { items: t(meta.items) }));
        return;
      }
      payload.track_ids = selectedDelivered.map((track) => track.id);
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t("Change rights")}
      subtitle={t("Ownership, match policy and asset labels are pushed to every delivered asset in {network}.", { network: product.network_name || t("the product's CMS") })}
      onClose={saving ? undefined : onClose}
      size="lg"
      closeOnBackdrop={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" icon={ShieldCheck} loading={saving} disabled={nothingSelected} onClick={handleSave}>
            {targetCount ? (targetCount === 1 ? t("Apply to {count} asset", { count: targetCount }) : t("Apply to {count} assets", { count: targetCount })) : t("Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <InlineMessage tone="error">{tm(error)}</InlineMessage>}
        {optionsError && (
          <InlineMessage
            tone="warning"
            actions={
              <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => reloadOptions?.()}>
                {t("Retry")}
              </Button>
            }
          >
            {t("Could not load the policies and labels of this CMS: {error}", { error: tm(optionsError) })}
          </InlineMessage>
        )}

        <section className="rounded-2xl border border-slate-200 p-4">
          <Toggle checked={applyOwnership} disabled={saving} onChange={setApplyOwnership} label={t("Ownership")} description={tm(summarizeOwnership(ownership.mode, ownership.territories))} />
          {applyOwnership && (
            <div className="mt-4">
              <TerritoryPicker mode={ownership.mode} territories={ownership.territories} disabled={saving} onChange={setOwnership} />
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 p-4">
          <Toggle checked={applyPolicy} disabled={saving} onChange={setApplyPolicy} label={t("Match policy")} description={policyName || product.match_policy_name || t("Choose a saved policy")} />
          {applyPolicy && (
            <div className="mt-4">
              <PolicySelect
                policies={policies}
                value={policyId}
                loading={Boolean(optionsLoading)}
                error={options?.errors?.policies || ""}
                disabled={saving}
                onChange={(id, policy) => {
                  setPolicyId(id);
                  setPolicyName(policy?.name || "");
                }}
              />
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 p-4">
          <Toggle checked={applyLabels} disabled={saving} onChange={setApplyLabels} label={t("Asset labels")} description={labels.length ? labels.join(", ") : t("No labels")} />
          {applyLabels && (
            <div className="mt-4">
              <ChipInput
                values={labels}
                suggestions={labelSuggestions}
                onChange={setLabels}
                allowCreate
                onCreate={handleCreateLabel}
                disabled={saving}
                placeholder={t("Add asset label…")}
              />
              {options?.errors?.asset_labels && <p className="mt-1 text-xs font-bold text-amber-700">{tm(options.errors.asset_labels)}</p>}
              <p className="mt-1 text-xs text-slate-400">{t("{Item}-level label overrides are replaced when this is applied to a {item}.", { Item: capitalize(t(meta.item)), item: t(meta.item) })}</p>
            </div>
          )}
        </section>

        <div className="rounded-2xl bg-slate-50 p-4">
          <Toggle
            checked={selectedOnly}
            disabled={saving || !selectedDelivered.length}
            onChange={setSelectedOnly}
            label={t("Apply to selected {items} only ({count})", { items: t(meta.items), count: selectedDelivered.length })}
            description={
              selectedDelivered.length
                ? t("Product defaults are still updated; only the selected delivered assets are patched on CMS.")
                : t("Select delivered {items} in the table to limit the change.", { items: t(meta.items) })
            }
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Upload media files (multi-file, auto-matched to tracks, stored on the server)
// ---------------------------------------------------------------------------

function UploadAudioModal({ product, meta, tracks, jobRunning, onClose, onUploadFile, onDeliverReferences, onDeliverPending }) {
  const { t, tm } = useI18n();
  const copy = copyOf(meta);
  const MediaIcon = copy.mediaIcon;
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [skippedFiles, setSkippedFiles] = useState(0);
  const [dragging, setDragging] = useState(false);
  const controllerRef = useRef(null);
  const stopRef = useRef(false);

  const assignedCounts = useMemo(() => {
    const counts = new Map();
    rows.forEach((row) => {
      if (row.trackId) counts.set(row.trackId, (counts.get(row.trackId) || 0) + 1);
    });
    return counts;
  }, [rows]);
  const readyRows = rows.filter((row) => row.trackId && (row.status === "idle" || row.status === "error") && assignedCounts.get(row.trackId) === 1);
  const doneCount = countBy(rows, (row) => row.status === "done");
  const errorCount = countBy(rows, (row) => row.status === "error");
  // Follow-up actions appear once every assigned file was tried (failed rows can be retried or removed).
  const finished = !running && doneCount > 0 && readyRows.every((row) => row.status === "error");
  const doneTrackIds = useMemo(() => new Set(rows.filter((row) => row.status === "done").map((row) => Number(row.trackId))), [rows]);
  const referenceTargets = tracks.filter((track) => doneTrackIds.has(Number(track.id)) && canDeliverReference(track));
  const pendingTargets = tracks.filter((track) => doneTrackIds.has(Number(track.id)) && !track.asset_id && isDeliverable(track, jobRunning));

  function addFiles(files) {
    const audioFiles = files.filter((file) => isMediaFile(file.name, meta.kind));
    setSkippedFiles((current) => current + (files.length - audioFiles.length));
    if (!audioFiles.length) return;
    const existingNames = new Set(rows.map((row) => `${row.file.name}|${row.file.size}`));
    const fresh = audioFiles.filter((file) => !existingNames.has(`${file.name}|${file.size}`));
    if (!fresh.length) return;
    const taken = new Set(rows.map((row) => row.trackId).filter(Boolean));
    const freeTracks = tracks.filter((track) => !taken.has(track.id));
    const matched = matchFilesToTracks(fresh, freeTracks);
    const items = Array.isArray(matched) ? matched : [];
    setRows([
      ...rows,
      ...items.map((item) => ({
        key: makeClientId(),
        file: item.file,
        trackId: item.track_id ? Number(item.track_id) : "",
        reason: item.reason || "",
        status: "idle",
        progress: 0,
        error: ""
      }))
    ]);
  }

  function patchRow(key, patch) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function removeRow(key) {
    setRows((current) => current.filter((row) => row.key !== key));
  }

  async function run() {
    if (!readyRows.length) return;
    setRunning(true);
    stopRef.current = false;
    for (const row of readyRows) {
      if (stopRef.current) break;
      const track = tracks.find((item) => item.id === row.trackId);
      if (!track) continue;
      const controller = new AbortController();
      controllerRef.current = controller;
      patchRow(row.key, { status: "uploading", progress: 0, error: "" });
      try {
        await onUploadFile(track, row.file, {
          signal: controller.signal,
          onProgress: (percent) => patchRow(row.key, { progress: percent })
        });
        patchRow(row.key, { status: "done", progress: 100 });
      } catch (err) {
        if (controller.signal.aborted) {
          patchRow(row.key, { status: "idle", progress: 0, error: tk("Cancelled") });
        } else {
          patchRow(row.key, { status: "error", error: getErrorMessage(err) });
        }
      }
    }
    controllerRef.current = null;
    setRunning(false);
  }

  function stop() {
    stopRef.current = true;
    controllerRef.current?.abort();
  }

  function handleDragOver(event) {
    event.preventDefault();
    if (!dragging) setDragging(true);
  }

  function handleDragLeave(event) {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    if (running) return;
    addFiles(Array.from(event.dataTransfer?.files || []));
  }

  const trackOptions = tracks.map((track) => ({
    value: track.id,
    label: `${track.track_number ? `${track.track_number}. ` : ""}${trackLabel(t, track)}${hasStoredAudio(track) ? ` (${t("{media} stored", { media: t(meta.media) })})` : ""}${hasLiveReference(track) ? ` (${t("reference live")})` : ""}`
  }));

  return (
    <Modal
      open
      title={t("Upload {mediaFile}s", { mediaFile: t(meta.mediaFile) })}
      subtitle={t("Files are stored on this server with the {product}. They are matched to {items} by ISRC in the file name, then by {item} number, then by title — adjust the mapping before starting.", { product: t(copy.product), items: t(meta.items), item: t(meta.item) })}
      onClose={running ? undefined : onClose}
      size="xl"
      closeOnBackdrop={!running}
      footer={
        <>
          <span className="mr-auto text-xs font-bold text-slate-500">
            {rows.length
              ? [
                  rows.length === 1 ? t("{count} file", { count: rows.length }) : t("{count} files", { count: rows.length }),
                  t("{count} ready", { count: readyRows.length }),
                  t("{count} stored", { count: doneCount }),
                  errorCount ? t("{count} failed", { count: errorCount }) : ""
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t("No files selected")}
          </span>
          {running ? (
            <Button variant="danger" icon={X} onClick={stop}>
              {t("Stop")}
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              {finished ? t("Close") : t("Cancel")}
            </Button>
          )}
          {finished && pendingTargets.length > 0 && (
            <Button variant="indigo" icon={Send} disabled={jobRunning} title={jobRunning ? t("A delivery is already running on the server") : undefined} onClick={() => onDeliverPending(pendingTargets.map((track) => track.id))}>
              {pendingTargets.length === 1 ? t("Deliver {count} pending {item}", { count: pendingTargets.length, item: t(meta.item) }) : t("Deliver {count} pending {items}", { count: pendingTargets.length, items: t(meta.items) })}
            </Button>
          )}
          {finished && referenceTargets.length > 0 && (
            <Button variant="success" icon={CloudUpload} disabled={jobRunning} title={jobRunning ? t("A delivery is already running on the server") : undefined} onClick={() => onDeliverReferences(referenceTargets.map((track) => track.id))}>
              {referenceTargets.length === 1 ? t("Deliver {count} reference now", { count: referenceTargets.length }) : t("Deliver {count} references now", { count: referenceTargets.length })}
            </Button>
          )}
          <Button variant="primary" icon={Upload} loading={running} disabled={!readyRows.length} onClick={run}>
            {readyRows.length ? (readyRows.length === 1 ? t("Upload {count} file", { count: readyRows.length }) : t("Upload {count} files", { count: readyRows.length })) : t("Upload")}
          </Button>
        </>
      }
    >
      <div
        className={cx("space-y-4 rounded-2xl transition", dragging && "bg-blue-50 outline-2 outline-dashed outline-blue-300")}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {!tracks.length && <InlineMessage tone="warning">{t("This {product} has no {items}.", { product: t(copy.product), items: t(meta.items) })}</InlineMessage>}

        <div className="flex flex-wrap items-center gap-2">
          <FilePickerButton accept={MEDIA_ACCEPT_BY_KIND[meta.kind]} multiple icon={MediaIcon} disabled={running || !tracks.length} onFiles={addFiles}>
            {t("Choose {mediaFile}s", { mediaFile: t(meta.mediaFile) })}
          </FilePickerButton>
          <FilePickerButton directory icon={Layers} disabled={running || !tracks.length} onFiles={addFiles}>
            {t("Choose folder")}
          </FilePickerButton>
          {rows.length > 0 && !running && (
            <Button variant="ghost" icon={X} onClick={() => setRows([])}>
              {t("Clear")}
            </Button>
          )}
        </div>

        {skippedFiles > 0 && <p className="text-xs font-bold text-amber-700">{skippedFiles === 1 ? t("{count} non-{media} file skipped.", { count: skippedFiles, media: t(meta.media) }) : t("{count} non-{media} files skipped.", { count: skippedFiles, media: t(meta.media) })}</p>}

        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={MediaIcon}
            title={t("Drop {mediaFile}s here or choose them above", { mediaFile: t(meta.mediaFile) })}
            description={t(copy.uploadHint)}
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t("File")}</th>
                  <th className="px-4 py-3">{capitalize(t(meta.item))}</th>
                  <th className="px-4 py-3">{t("Match")}</th>
                  <th className="px-4 py-3">{t("Status")}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const conflict = row.trackId && assignedCounts.get(row.trackId) > 1;
                  const target = row.trackId ? tracks.find((track) => track.id === row.trackId) : null;
                  const replaces = target && hasStoredAudio(target) && row.status !== "done";
                  return (
                    <tr key={row.key} className={cx("align-top", row.status === "error" && "bg-red-50", row.status === "done" && "bg-emerald-50")}>
                      <td className="px-4 py-3">
                        <span className="block max-w-[280px] truncate font-bold text-slate-900" title={row.file.name}>
                          {row.file.name}
                        </span>
                        <span className="block text-[11px] font-bold text-slate-400">{formatBytes(row.file.size)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Select
                          compact
                          value={row.trackId || ""}
                          disabled={running || row.status === "done"}
                          invalid={Boolean(conflict)}
                          placeholder={t("Choose a {item}…", { item: t(meta.item) })}
                          options={trackOptions}
                          wrapperClassName="w-64"
                          onChange={(event) => patchRow(row.key, { trackId: event.target.value ? Number(event.target.value) : "", reason: event.target.value ? tk("Manual") : "" })}
                        />
                        {conflict && <p className="mt-1 text-[11px] font-bold text-red-600">{t("Two files point to the same {item}.", { item: t(meta.item) })}</p>}
                        {replaces && !conflict && <p className="mt-1 text-[11px] font-bold text-amber-700">{t("Replaces the stored file «{file}».", { file: truncate(target.file_name || t(meta.media), 40) })}</p>}
                      </td>
                      <td className="px-4 py-3 text-xs font-bold text-slate-500">{tm(row.reason) || (row.trackId ? t("Manual") : t("No match"))}</td>
                      <td className="px-4 py-3">
                        {row.status === "uploading" ? (
                          <ProgressBar value={row.progress} size="sm" className="w-40" />
                        ) : row.status === "done" ? (
                          <Badge tone="emerald" icon={CheckCircle2}>
                            {t("Stored")}
                          </Badge>
                        ) : row.status === "error" ? (
                          <span className="block max-w-[220px] text-[11px] font-bold text-red-600" title={tm(row.error)}>
                            {truncate(tm(row.error), 120)}
                          </span>
                        ) : row.error ? (
                          <span className="text-[11px] font-bold text-amber-700">{tm(row.error)}</span>
                        ) : (
                          <Badge tone={row.trackId ? "blue" : "slate"}>{row.trackId ? t("Ready") : t("Unassigned")}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!running && row.status !== "done" && <IconButton icon={X} label={t("Remove file")} size="sm" tone="ghost" onClick={() => removeRow(row.key)} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {finished && (referenceTargets.length > 0 || pendingTargets.length > 0) && (
          <InlineMessage tone="success" icon={CheckCircle2}>
            {doneCount === 1 ? t("{count} file stored on the server.", { count: doneCount }) : t("{count} files stored on the server.", { count: doneCount })}
            {referenceTargets.length > 0
              ? ` ${referenceTargets.length === 1 ? t("{count} {item} with an asset can get its reference delivered now.", { count: referenceTargets.length, item: t(meta.item) }) : t("{count} {items} with an asset can get its reference delivered now.", { count: referenceTargets.length, items: t(meta.items) })}`
              : ""}
            {pendingTargets.length > 0
              ? ` ${pendingTargets.length === 1 ? t("{count} {item} still needs an asset — deliver the pending {items}.", { count: pendingTargets.length, item: t(meta.item), items: t(meta.items) }) : t("{count} {items} still need an asset — deliver the pending {items}.", { count: pendingTargets.length, items: t(meta.items) })}`
              : ""}
          </InlineMessage>
        )}

        <InlineMessage tone="neutral" icon={Info}>
          {t("Files are uploaded one at a time and kept with the {product} on this server.", { product: t(copy.product) })} {includeReferenceOf(product) ? t("Delivering pending {items} uploads the stored {media} as the Content ID reference automatically.", { items: t(meta.items), media: t(meta.media) }) : t("Use «Deliver references» afterwards to send them to CMS.")}
        </InlineMessage>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Takedown / reactivate dialogs
// ---------------------------------------------------------------------------

function TakedownDialog({ product, meta, track, selectedCount = 0, defaultSelectedOnly = false, loading, onCancel, onConfirm }) {
  const { t } = useI18n();
  const copy = copyOf(meta);
  const [reason, setReason] = useState("");
  const [releaseClaims, setReleaseClaims] = useState(true);
  const [selectedOnly, setSelectedOnly] = useState(Boolean(defaultSelectedOnly));
  const tracks = product.tracks || [];
  const scoped = !track && selectedOnly;
  const blocked = scoped && selectedCount === 0;
  const affected = track ? 1 : scoped ? selectedCount : countBy(tracks, canTakedown);
  const subject = track
    ? `«${trackLabel(t, track)}»`
    : scoped
      ? selectedCount === 1
        ? t("{count} selected {item}", { count: selectedCount, item: t(meta.item) })
        : t("{count} selected {items}", { count: selectedCount, items: t(meta.items) })
      : affected === 1
        ? t("all {count} delivered {item}", { count: affected, item: t(meta.item) })
        : t("all {count} delivered {items}", { count: affected, items: t(meta.items) });

  return (
    <ConfirmDialog
      open
      tone="danger"
      size="md"
      title={track ? t("Take down {item}", { item: t(meta.item) }) : t("Take down {product}", { product: t(copy.product) })}
      confirmLabel={affected ? (affected === 1 ? t("Take down {count} {item}", { count: affected, item: t(meta.item) }) : t("Take down {count} {items}", { count: affected, items: t(meta.items) })) : t("Take down")}
      loading={loading}
      onCancel={onCancel}
      onConfirm={() => onConfirm({ reason: reason.trim(), release_claims: releaseClaims, selectedOnly: scoped })}
    >
      <div className="space-y-4">
        {blocked ? (
          <InlineMessage tone="warning">{t("None of the selected {items} can be taken down any more (refresh changed their status). Close this dialog and select again.", { items: t(meta.items) })}</InlineMessage>
        ) : (
          <InlineMessage tone="warning">
            {t("Every reference of {subject} will be set to {status} on YouTube CMS, so Content ID stops matching new uploads.", {
              subject,
              // eslint-disable-next-line i18n/no-untranslated -- literal Content ID reference status value, shown as a code token
              status: <span className="font-mono">inactive</span>
            })}
            {releaseClaims ? ` ${t("Existing claims made by those references will be released.")}` : ` ${t("Existing claims are kept.")}`} {t("The assets themselves stay in CMS and can be reactivated later.")}
          </InlineMessage>
        )}
        <Toggle checked={releaseClaims} disabled={loading} onChange={setReleaseClaims} label={t("Release existing claims")} description={t("Also release active and pending claims created by these assets.")} />
        {!track && selectedCount > 0 && (
          <Toggle checked={selectedOnly} disabled={loading} onChange={setSelectedOnly} label={selectedCount === 1 ? t("Only the {count} selected {item}", { count: selectedCount, item: t(meta.item) }) : t("Only the {count} selected {items}", { count: selectedCount, items: t(meta.items) })} description={t("Otherwise every delivered {item} of the {product} is taken down.", { item: t(meta.item), product: t(copy.product) })} />
        )}
        <Field label={t("Reason")} hint={t("Stored in the activity log")}>
          <TextArea rows={2} value={reason} disabled={loading} onChange={(event) => setReason(event.target.value)} placeholder={t("e.g. rights dispute, wrong {media}, client request", { media: t(meta.media) })} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

function ReactivateDialog({ product, meta, track, selectedCount = 0, defaultSelectedOnly = false, loading, onCancel, onConfirm }) {
  const { t } = useI18n();
  const copy = copyOf(meta);
  const [selectedOnly, setSelectedOnly] = useState(Boolean(defaultSelectedOnly));
  const tracks = product.tracks || [];
  const scoped = !track && selectedOnly;
  const blocked = scoped && selectedCount === 0;
  const affected = track ? 1 : scoped ? selectedCount : countBy(tracks, (item) => item.status === "taken_down");

  return (
    <ConfirmDialog
      open
      tone="success"
      title={track ? t("Reactivate {item}", { item: t(meta.item) }) : t("Reactivate {product}", { product: t(copy.product) })}
      confirmLabel={affected ? (affected === 1 ? t("Reactivate {count} {item}", { count: affected, item: t(meta.item) }) : t("Reactivate {count} {items}", { count: affected, items: t(meta.items) })) : t("Reactivate")}
      loading={loading}
      onCancel={onCancel}
      onConfirm={() => onConfirm({ selectedOnly: scoped })}
      message={
        track
          ? t("Inactive references of «{track}» will be set back to active so Content ID starts matching again.", { track: trackLabel(t, track) })
          : scoped
            ? selectedCount === 1
              ? t("Inactive references of the {count} selected {item} will be set back to active so Content ID starts matching again.", { count: selectedCount, item: t(meta.item) })
              : t("Inactive references of the {count} selected {items} will be set back to active so Content ID starts matching again.", { count: selectedCount, items: t(meta.items) })
            : t("Inactive references of the taken-down {items} will be set back to active so Content ID starts matching again.", { items: t(meta.items) })
      }
    >
      {blocked && <InlineMessage tone="warning">{t("None of the selected {items} is taken down any more. Close this dialog and select again.", { items: t(meta.items) })}</InlineMessage>}
      {!track && selectedCount > 0 && (
        <Toggle checked={selectedOnly} disabled={loading} onChange={setSelectedOnly} label={selectedCount === 1 ? t("Only the {count} selected {item}", { count: selectedCount, item: t(meta.item) }) : t("Only the {count} selected {items}", { count: selectedCount, items: t(meta.items) })} description={t("Otherwise every taken-down {item} of the {product} is reactivated.", { item: t(meta.item), product: t(copy.product) })} />
      )}
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Deliver / deliver references dialogs
// ---------------------------------------------------------------------------

function DeliverDialog({ product, meta, trackIds, tracksById, loading, onCancel, onConfirm }) {
  const { t, tm } = useI18n();
  const copy = copyOf(meta);
  const MediaIcon = copy.mediaIcon;
  const [includeReference, setIncludeReference] = useState(() => includeReferenceOf(product));
  const [deleteReference, setDeleteReference] = useState(() => Boolean(Number(product.delete_reference_after_delivery)));
  const targets = trackIds.map((id) => tracksById.get(Number(id))).filter(Boolean);
  const withAudio = countBy(targets, hasStoredAudio);
  const targetsLabel = targets.length === 1 ? t("{count} {item}", { count: targets.length, item: t(meta.item) }) : t("{count} {items}", { count: targets.length, items: t(meta.items) });
  return (
    <ConfirmDialog
      open
      title={t("Deliver to CMS")}
      confirmLabel={t("Deliver {tracks}", { tracks: targetsLabel })}
      loading={loading}
      onCancel={onCancel}
      onConfirm={() => onConfirm(trackIds, { include_reference: includeReference, delete_reference_after_delivery: deleteReference })}
      message={t("{tracks} will be created as {assetType} assets in {network} with ownership «{ownership}» and policy «{policy}». The server runs the delivery in the background; {items} that already have an asset only re-run their missing steps.", {
        tracks: targetsLabel,
        assetType: t(assetNoun(product.asset_type)),
        network: product.network_name || t("CMS"),
        ownership: tm(summarizeOwnership(product.ownership.mode, product.ownership.territories)),
        policy: product.match_policy_name || product.match_policy_id || t("none"),
        items: t(meta.items)
      })}
    >
      <div className="space-y-3">
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-2xl bg-slate-50 p-3 text-xs font-bold text-slate-600">
          {targets.map((track) => (
            <li key={track.id} className="flex items-center justify-between gap-3">
              <span className="truncate">{trackLabel(t, track)}</span>
              <span className="inline-flex items-center gap-2 font-mono text-slate-400">
                {hasStoredAudio(track) ? <MediaIcon size={12} className="text-emerald-600" /> : <span className="text-[10px] font-black uppercase text-amber-700">{t("no {media}", { media: t(meta.media) })}</span>}
                {track.isrc || track.custom_id}
              </span>
            </li>
          ))}
        </ul>
        <Toggle
          checked={includeReference}
          disabled={loading}
          onChange={setIncludeReference}
          label={t(copy.referenceToggle)}
          description={withAudio ? t("{withMedia} of {total} {items} have a stored {mediaFile}; the server uploads it as the Content ID reference right after the asset is created.", { withMedia: withAudio, total: targets.length, items: t(meta.items), mediaFile: t(meta.mediaFile) }) : t("No selected {item} has a stored {mediaFile} yet — upload {media} later and use «Deliver references».", { item: t(meta.item), mediaFile: t(meta.mediaFile), media: t(meta.media) })}
        />
        <Toggle
          checked={deleteReference}
          disabled={loading}
          onChange={setDeleteReference}
          label={t("Delete local reference files after successful delivery")}
          description={t("Free server storage after CMS accepts the reference and the track finishes delivery. Failed or unfinished uploads keep their files. The reference in YouTube CMS is retained.")}
        />
      </div>
    </ConfirmDialog>
  );
}

function ReferencesDialog({ product, meta, trackIds, tracksById, loading, onCancel, onConfirm }) {
  const { t } = useI18n();
  const targets = trackIds.map((id) => tracksById.get(Number(id))).filter(Boolean);
  const targetsLabel = targets.length === 1 ? t("{count} {item}", { count: targets.length, item: t(meta.item) }) : t("{count} {items}", { count: targets.length, items: t(meta.items) });
  return (
    <ConfirmDialog
      open
      tone="success"
      title={t("Deliver references")}
      confirmLabel={targets.length === 1 ? t("Deliver {count} reference", { count: targets.length }) : t("Deliver {count} references", { count: targets.length })}
      loading={loading}
      onCancel={onCancel}
      onConfirm={() => onConfirm(trackIds)}
      message={t("The server uploads the stored {mediaFile} of {tracks} to {network} as the Content ID reference ({contentType}), one {item} at a time. Keep an eye on the table — each row shows its own result.", {
        mediaFile: t(meta.mediaFile),
        tracks: targetsLabel,
        network: product.network_name || t("CMS"),
        contentType: `${product.reference_content_type || meta.reference}${Number(product.reference_urgent) ? `, ${t("urgent")}` : ""}`,
        item: t(meta.item)
      })}
    >
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-2xl bg-slate-50 p-3 text-xs font-bold text-slate-600">
        {targets.map((track) => (
          <li key={track.id} className="flex items-center justify-between gap-3">
            <span className="truncate">{trackLabel(t, track)}</span>
            <span className="truncate font-mono text-slate-400" title={track.file_name || ""}>
              {track.file_name || track.isrc}
            </span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Track edit
// ---------------------------------------------------------------------------

function TrackEditModal({ track, product, meta, options, onClose, onSubmit }) {
  const { t, tm } = useI18n();
  const initialOverride = trackLabelOverride(track);
  // Field set per asset type: web videos have no artist / ISRC, music videos keep the artist
  // with an optional ISRC, sound recordings require the ISRC. Video kinds add description + URL.
  const videoKind = meta.kind === "video";
  const showArtist = assetTypeKey(product.asset_type) !== "web";
  const showIsrc = meta.isrc !== "none";
  const isrcRequired = meta.isrc === "required";
  const [form, setForm] = useState(() => ({
    title: track.title || "",
    artist: track.artist || "",
    isrc: track.isrc || "",
    custom_id: track.custom_id || "",
    notes: track.notes || "",
    description: track.description || "",
    source_url: track.source_url || ""
  }));
  const [inheritLabels, setInheritLabels] = useState(initialOverride === null);
  const [labels, setLabels] = useState(initialOverride || labelsOf(product));
  const [applyToCms, setApplyToCms] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  const labelSuggestions = Array.isArray(options?.asset_labels) ? options.asset_labels : [];
  const isrcInvalid = showIsrc && (isrcRequired ? !isValidIsrc(form.isrc) : Boolean(form.isrc) && !isValidIsrc(form.isrc));
  const sourceUrlInvalid = videoKind && Boolean(form.source_url.trim()) && !/^https?:\/\/\S+$/i.test(form.source_url.trim());
  const productLabels = labelsOf(product);

  function patch(next) {
    setForm((current) => ({ ...current, ...next }));
    setFieldErrors({});
  }

  async function handleSave() {
    const errors = {};
    if (!form.title.trim()) errors.title = t("{Item} title is required", { Item: capitalize(t(meta.item)) });
    if (isrcInvalid) errors.isrc = tk("ISRC must be 12 alphanumeric characters");
    if (sourceUrlInvalid) errors.source_url = tk("Enter a full http(s) URL");
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      return;
    }
    const payload = {
      title: form.title.trim(),
      custom_id: form.custom_id.trim(),
      notes: form.notes.trim(),
      asset_labels: inheritLabels ? null : labels
    };
    if (showArtist) payload.artist = form.artist.trim();
    if (showIsrc) payload.isrc = normalizeIsrc(form.isrc);
    if (videoKind) {
      payload.description = form.description.trim();
      payload.source_url = form.source_url.trim();
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit({ track: payload, apply_to_cms: applyToCms });
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
      const serverErrors = err?.response?.data?.field_errors;
      if (serverErrors && typeof serverErrors === "object") setFieldErrors(serverErrors);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t("Edit {item}", { item: t(meta.item) })}
      subtitle={track.asset_id ? t("Asset {id}", { id: track.asset_id }) : t("Not delivered yet")}
      onClose={saving ? undefined : onClose}
      size="md"
      closeOnBackdrop={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" icon={Pencil} loading={saving} onClick={handleSave}>
            {applyToCms && track.asset_id ? t("Save & update asset") : t("Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <InlineMessage tone="error">{tm(error)}</InlineMessage>}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("Title")} required error={tm(fieldErrors.title)} className="md:col-span-2">
            <TextInput value={form.title} invalid={Boolean(fieldErrors.title)} disabled={saving} onChange={(event) => patch({ title: event.target.value })} />
          </Field>
          {showArtist && (
            <Field label={t("Artist(s)")} hint={t("Comma separated")} error={tm(fieldErrors.artist)} className="md:col-span-2">
              <TextInput value={form.artist} disabled={saving} onChange={(event) => patch({ artist: event.target.value })} />
            </Field>
          )}
          {showIsrc && (
            <Field label={t("ISRC")} required={isrcRequired} hint={isrcRequired ? undefined : t("Optional")} error={tm(fieldErrors.isrc) || (isrcInvalid && form.isrc ? t("ISRC must be 12 alphanumeric characters") : "")}>
              <TextInput mono value={form.isrc} invalid={isrcInvalid || Boolean(fieldErrors.isrc)} disabled={saving} maxLength={15} onChange={(event) => patch({ isrc: cleanCode(event.target.value) })} />
            </Field>
          )}
          <Field label={t("Custom ID")} error={tm(fieldErrors.custom_id)} className={showIsrc ? undefined : "md:col-span-2"}>
            <TextInput mono value={form.custom_id} disabled={saving} onChange={(event) => patch({ custom_id: event.target.value })} />
          </Field>
          {videoKind && (
            <>
              <Field label={t("Description")} hint={t("Shown on the asset in CMS, up to 5000 characters")} error={tm(fieldErrors.description)} className="md:col-span-2">
                <TextArea rows={4} value={form.description} invalid={Boolean(fieldErrors.description)} disabled={saving} onChange={(event) => patch({ description: event.target.value })} placeholder={t("What the video is about")} />
              </Field>
              <Field label={t("Official URL")} error={tm(fieldErrors.source_url) || (sourceUrlInvalid ? t("Enter a full http(s) URL") : "")} className="md:col-span-2">
                <TextInput type="url" value={form.source_url} invalid={sourceUrlInvalid || Boolean(fieldErrors.source_url)} disabled={saving} onChange={(event) => patch({ source_url: event.target.value })} placeholder="https://www.youtube.com/watch?v=…" />
              </Field>
            </>
          )}
          <Field label={t("Notes")} error={tm(fieldErrors.notes)} className="md:col-span-2">
            <TextArea rows={2} value={form.notes} disabled={saving} onChange={(event) => patch({ notes: event.target.value })} placeholder={t("Falls back to the product notes when empty")} />
          </Field>
        </div>

        <section className="rounded-2xl border border-slate-200 p-4">
          <Toggle
            checked={inheritLabels}
            disabled={saving}
            onChange={setInheritLabels}
            label={t("Inherit product asset labels")}
            description={productLabels.length ? productLabels.join(", ") : t("The product has no asset labels")}
          />
          {!inheritLabels && (
            <div className="mt-4">
              <ChipInput values={labels} suggestions={labelSuggestions} onChange={setLabels} disabled={saving} placeholder={t("Track-specific asset labels…")} />
            </div>
          )}
        </section>

        <div className="rounded-2xl bg-slate-50 p-4">
          <Toggle
            checked={applyToCms}
            disabled={saving || !track.asset_id}
            onChange={setApplyToCms}
            label={t("Apply to CMS")}
            description={track.asset_id ? t("Patch the asset metadata (and labels when changed) on YouTube CMS.") : t("The asset does not exist yet — only the local record changes.")}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reference from claim ID
// ---------------------------------------------------------------------------

function FromClaimModal({ track, product, onClose, onSubmit }) {
  const { t, tm } = useI18n();
  const [claimId, setClaimId] = useState("");
  const [contentType, setContentType] = useState(product.reference_content_type || "audio");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    const value = claimId.trim();
    if (!value) {
      setError(tk("Enter the claim ID."));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(value, contentType);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t("Reference from claim")}
      subtitle={t("Use the audio of an existing claim as the Content ID reference for «{track}».", { track: trackLabel(t, track) })}
      onClose={saving ? undefined : onClose}
      size="sm"
      closeOnBackdrop={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" icon={Link} loading={saving} onClick={handleSubmit}>
            {t("Create reference")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <InlineMessage tone="error">{tm(error)}</InlineMessage>}
        <Field label={t("Claim ID")} required hint={t("A claim on a video that contains this recording (see the Claims dialog).")}>
          <TextInput
            mono
            autoFocus
            value={claimId}
            disabled={saving}
            onChange={(event) => setClaimId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSubmit();
            }}
            placeholder={t("e.g. AbCdEfGhIjKlMnOp")}
          />
        </Field>
        <Field label={t("Reference content type")}>
          <Select value={contentType} disabled={saving} onChange={(event) => setContentType(event.target.value)} options={REFERENCE_CONTENT_TYPES} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const CLAIM_STATUS_TONES = {
  active: "emerald",
  pending: "amber",
  potential: "amber",
  inactive: "slate",
  disputed: "red",
  appealed: "red",
  takedown: "red",
  routedForReview: "indigo",
  routed_for_review: "indigo"
};

function ClaimsModal({ track, onClose }) {
  const { t, tm } = useI18n();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ key: "", claims: [], error: "" });
  const loadKey = `${track.id}|${tick}`;
  const loading = state.key !== loadKey;

  useEffect(() => {
    let cancelled = false;
    listTrackClaims(track.id)
      .then((data) => {
        if (cancelled) return;
        setState({ key: loadKey, claims: Array.isArray(data?.claims) ? data.claims : [], error: "" });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ key: loadKey, claims: [], error: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [track.id, loadKey]);

  const claims = state.claims;

  return (
    <Modal
      open
      title={t("Claims")}
      subtitle={t("Claims created by asset {asset} · «{track}»", { asset: track.asset_id, track: trackLabel(t, track) })}
      onClose={onClose}
      size="xl"
      footer={
        <>
          <span className="mr-auto text-xs font-bold text-slate-500">{loading ? t("Loading…") : claims.length === 1 ? t("{count} claim", { count: claims.length }) : t("{count} claims", { count: claims.length })}</span>
          <Button variant="secondary" icon={RefreshCw} loading={loading} onClick={() => setTick((current) => current + 1)}>
            {t("Refresh")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("Close")}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm font-bold text-slate-500">
          <Spinner /> {t("Fetching claims from CMS…")}
        </div>
      ) : state.error ? (
        <InlineMessage tone="error" actions={<Button size="sm" variant="secondary" onClick={() => setTick((current) => current + 1)}>{t("Retry")}</Button>}>
          {tm(state.error)}
        </InlineMessage>
      ) : !claims.length ? (
        <EmptyState compact icon={ListChecks} title={t("No claims yet")} description={t("Content ID has not matched any video against this reference, or the claims were released.")} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">{t("Video")}</th>
                <th className="px-4 py-3">{t("Claim ID")}</th>
                <th className="px-4 py-3">{t("Status")}</th>
                <th className="px-4 py-3">{t("Type")}</th>
                <th className="px-4 py-3">{t("Origin")}</th>
                <th className="px-4 py-3">{t("Created")}</th>
                <th className="px-4 py-3">{t("Last change")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {claims.map((claim) => {
                const videoId = claim.video_id || claim.videoId || "";
                const claimId = claim.claim_id || claim.id || "";
                const status = String(claim.status || "");
                return (
                  <tr key={claimId || videoId} className="align-top hover:bg-slate-50">
                    <td className="px-4 py-3">
                      {videoId ? (
                        <a
                          href={`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex max-w-[320px] items-center gap-1.5 font-bold text-blue-700 hover:underline"
                          title={claim.video_title || videoId}
                        >
                          <span className="truncate">{claim.video_title || videoId}</span>
                          <ExternalLink size={13} className="shrink-0" />
                        </a>
                      ) : (
                        <span className="text-slate-400">–</span>
                      )}
                      {videoId && claim.video_title && <span className="block font-mono text-[11px] text-slate-400">{videoId}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <MonoCode value={claimId} />
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={CLAIM_STATUS_TONES[status] || "slate"}>{tm(status.replace(/_/g, " ")) || t("unknown")}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs font-bold text-slate-600">{claim.content_type || claim.contentType || "–"}</td>
                    <td className="px-4 py-3 text-xs font-bold text-slate-600">{typeof claim.origin === "string" ? claim.origin : claim.origin?.source || "–"}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{formatDateTime(claim.time_created || claim.timeCreated) || "–"}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{formatDateTime(claim.time_status_last_modified || claim.timeStatusLastModified) || "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Track details
// ---------------------------------------------------------------------------

function TrackDetailsModal({ track, product, meta, onClose }) {
  const { t, tm } = useI18n();
  const copy = copyOf(meta);
  const { isSidebarVisible } = useSystemSettings();
  const path = meta.kind === "video" ? "/content-id/video-delivery" : "/content-id/delivery";
  const tabs = DETAIL_TABS.filter((item) => isSidebarVisible(`${path}#detail/${item.key}`));
  const [selectedTab, setTab] = useState("metadata");
  const tab = (tabs.find((item) => item.key === selectedTab) || tabs[0])?.key;
  const sections = {
    metadata: pickJson(track, "metadata", "metadata_json", null),
    ownership: pickJson(track, "ownership", "ownership_json", null),
    response: pickJson(track, "response", "response_json", null),
    cms: pickJson(track, "cms", "cms_json", null)
  };
  const duplicates = duplicatesOf(track);
  const override = trackLabelOverride(track);
  const effectiveLabels = override === null ? labelsOf(product) : override;
  // Track rows store the RightsOwnership payload that was sent to CMS; before
  // delivery there is nothing stored, so fall back to the product defaults.
  const ownership = sections.ownership ? ownershipOf(track) : ownershipOf(product);
  const audioStored = hasStoredAudio(track);

  return (
    <Modal
      open
      title={trackLabel(t, track)}
      subtitle={`${track.track_number ? `${t("{Item} {number}", { Item: capitalize(t(meta.item)), number: track.track_number })} · ` : ""}${track.artist || product.artist || ""}`}
      onClose={onClose}
      size="xl"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("Close")}
        </Button>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={track.status} meta={TRACK_META} />
          {isInFlight(track) && track.step && <Badge tone="blue">{t(STEP_TEXT[track.step] || track.step)}</Badge>}
          {track.reference_status && <StatusBadge status={track.reference_status} meta={referenceMeta(track.reference_status)} title={t("Reference status")} />}
          {track.asset_status && <Badge tone={track.asset_status === "active" ? "emerald" : "slate"}>{t("asset {status}", { status: track.asset_status })}</Badge>}
          <Badge tone={audioStored ? "emerald" : "slate"} icon={copy.mediaIcon}>
            {audioStored ? t("{media} stored", { media: t(meta.media) }) : t("no {media}", { media: t(meta.media) })}
          </Badge>
          {track.last_synced_at && <span className="text-xs font-bold text-slate-400">{t("Synced {time}", { time: formatDateTime(track.last_synced_at) })}</span>}
        </div>

        {track.error_message && (
          <InlineMessage
            tone={track.status === "error" ? "error" : "warning"}
            title={track.status === "error" ? (track.step ? t("Failed at step “{step}”", { step: track.step }) : t("Delivery error")) : track.step ? t("Last error at step “{step}”", { step: track.step }) : t("Last error")}
          >
            {tm(track.error_message)}
          </InlineMessage>
        )}

        <div className="grid gap-3 md:grid-cols-3">
          <InfoItem label={t("ISRC")} mono>
            {track.isrc}
          </InfoItem>
          <InfoItem label={t("Custom ID")} mono>
            {track.custom_id}
          </InfoItem>
          {track.source_url && (
            <InfoItem label={t("Official URL")}>
              <SourceLink url={track.source_url} max={60} />
            </InfoItem>
          )}
          <InfoItem label={t("Asset ID")} mono>
            {track.asset_id ? <MonoCode value={track.asset_id} /> : ""}
          </InfoItem>
          <InfoItem label={t("Reference ID")} mono>
            {track.reference_id ? <MonoCode value={track.reference_id} /> : ""}
          </InfoItem>
          <InfoItem label={t("Stored {media}", { media: t(meta.media) })}>
            {audioStored ? (
              <>
                <span className="block break-all">{track.file_name || t(meta.media)}</span>
                <span className="block text-[11px] font-bold text-slate-400">
                  {[formatBytes(track.file_size), track.file_mime, track.file_uploaded_at ? t("uploaded {time}", { time: formatDateTime(track.file_uploaded_at) }) : ""].filter(Boolean).join(" · ")}
                </span>
              </>
            ) : track.file_name ? (
              <span className="text-slate-400">{t("Not stored (reference file was «{file}»)", { file: track.file_name })}</span>
            ) : (
              ""
            )}
          </InfoItem>
          <InfoItem label={t("{Media} SHA-256", { Media: capitalize(t(meta.media)) })} mono>
            {track.file_sha256 ? <MonoCode value={track.file_sha256} /> : ""}
          </InfoItem>
          <InfoItem label={t("Content type")}>{track.reference_content_type}</InfoItem>
          <InfoItem label={t("Match policy")}>
            {track.match_policy_name || track.match_policy_id ? (
              <>
                <span className="block">{track.match_policy_name || t("Policy")}</span>
                {track.match_policy_id && <span className="block font-mono text-[11px] text-slate-400">{track.match_policy_id}</span>}
              </>
            ) : (
              ""
            )}
          </InfoItem>
          <InfoItem label={t("Ownership")}>
            {tm(summarizeOwnership(ownership.mode, ownership.territories))}
            {!sections.ownership && <span className="block text-[11px] font-bold text-slate-400">{t("product default · not sent yet")}</span>}
          </InfoItem>
          <InfoItem label={t("Asset labels")}>
            {effectiveLabels.length ? (
              <span className="flex flex-wrap gap-1">
                {effectiveLabels.map((label) => (
                  <Badge key={label} tone={override === null ? "slate" : "indigo"}>
                    {label}
                  </Badge>
                ))}
              </span>
            ) : (
              ""
            )}
          </InfoItem>
          <InfoItem label={t("Delivered")}>{formatDateTime(track.delivered_at)}</InfoItem>
          <InfoItem label={t("Created")}>{formatDateTime(track.created_at)}</InfoItem>
          <InfoItem label={t("Updated")}>{formatDateTime(track.updated_at)}</InfoItem>
          {track.description && (
            <InfoItem label={t("Description")} className="md:col-span-3">
              <span className="block whitespace-pre-wrap font-medium">{track.description}</span>
            </InfoItem>
          )}
        </div>

        <section className="space-y-3">
          <SectionTitle icon={ListChecks}>{t("Delivery steps")}</SectionTitle>
          <StepsChecklist track={track} product={product} />
        </section>

        {duplicates.length > 0 && (
          <section className="space-y-3">
            <SectionTitle icon={Copy}>{t("Existing assets with this ISRC")}</SectionTitle>
            <DuplicatesTable duplicates={duplicates} />
          </section>
        )}

        {tab && <section className="space-y-3">
          <SectionTitle icon={FileText}>{t("Payloads")}</SectionTitle>
          <TabBar tabs={tabs.map((item) => ({ ...item, label: t(item.label) }))} active={tab} onChange={setTab} />
          <JsonViewer value={sections[tab]} maxHeight={360} />
        </section>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Track row
// ---------------------------------------------------------------------------

function rowTint(track, selected) {
  if (selected) return "bg-blue-50";
  if (track.status === "error") return "bg-red-50";
  if (track.status === "duplicate") return "bg-amber-50";
  if (isInFlight(track)) return "bg-blue-50";
  if (track.error_message) return "bg-amber-50";
  if (track.status === "taken_down") return "bg-slate-50";
  return "";
}

function TrackRow({
  track,
  product,
  meta,
  selected,
  busy,
  audioUpload,
  rowError,
  playing,
  locked,
  jobRunning,
  onToggle,
  onAction,
  onAudioFile,
  onAudioDownload,
  onAudioRemove,
  onAudioCancel,
  onAudioDismiss,
  onTogglePlay,
  onDeliverReference,
  onDismissError
}) {
  const { t, tm } = useI18n();
  const rowBusy = Boolean(busy);
  const audioUploading = audioUpload?.status === "uploading";
  const disabled = locked || rowBusy || audioUploading;
  const override = trackLabelOverride(track);
  const duplicates = duplicatesOf(track);
  const audioStored = hasStoredAudio(track);
  const referencePending = busy === "reference" || track.status === "uploading";
  const liveReference = hasLiveReference(track);
  const showRowError = rowError && rowError.message && rowError.message !== track.error_message;
  const rowErrorLabel = showRowError ? rowActionLabel(t, rowError.action, meta) : "";
  // Web video assets carry no ISRC: that column shows the official URL instead.
  const showSourceUrl = meta.isrc === "none";
  const accept = MEDIA_ACCEPT_BY_KIND[meta.kind];

  const menuItems = [
    { key: "edit", label: t("Edit {item}", { item: t(meta.item) }), icon: Pencil, onClick: () => onAction("track-edit", track), disabled },
    canRetry(track) && {
      key: "retry",
      label: track.status === "duplicate" ? t("Create anyway") : t("Retry delivery"),
      icon: RotateCcw,
      onClick: () => onAction("retry", track),
      disabled: disabled || jobRunning
    },
    canDeliverReference(track) && { key: "reference", label: t("Deliver reference"), icon: CloudUpload, onClick: () => onDeliverReference(track), disabled: disabled || jobRunning },
    track.asset_id && { key: "sync", label: t("Sync from CMS"), icon: RefreshCw, onClick: () => onAction("sync", track), disabled: disabled || isInFlight(track) },
    track.asset_id && { key: "claims", label: t("View claims"), icon: ListChecks, onClick: () => onAction("claims", track), disabled: locked },
    canReferenceFromClaim(track) && { key: "from-claim", label: t("Reference from claim ID"), icon: Link, onClick: () => onAction("from-claim", track), disabled },
    canTakedown(track) && { key: "takedown", label: t("Take down"), icon: Ban, tone: "danger", onClick: () => onAction("takedown", track), disabled },
    track.status === "taken_down" && { key: "reactivate", label: t("Reactivate"), icon: BadgeCheck, tone: "success", onClick: () => onAction("reactivate", track), disabled },
    { key: "details", label: t("Details"), icon: Eye, onClick: () => onAction("details", track) },
    { key: "logs", label: t("View logs"), icon: History, onClick: () => onAction("logs", track) }
  ];

  return (
    <tr className={cx("align-top transition", rowTint(track, selected) || "hover:bg-slate-50")}>
      <td className="px-3 py-3">
        <input type="checkbox" className="h-4 w-4 cursor-pointer" checked={selected} disabled={locked} onChange={onToggle} aria-label={t("Select {track}", { track: trackLabel(t, track) })} />
      </td>
      <td className="px-2 py-3 text-xs font-black text-slate-400">{track.track_number || "–"}</td>
      <td className="px-3 py-3">
        <span className="block max-w-[240px] truncate font-black text-slate-950" title={track.title || ""}>
          {track.title || "–"}
        </span>
        <span className="block max-w-[240px] truncate text-xs font-bold text-slate-500" title={track.artist || ""}>
          {track.artist || product.artist || "–"}
        </span>
      </td>
      <td className="px-3 py-3">
        {showSourceUrl ? <SourceLink url={track.source_url} className="max-w-[200px]" /> : <MonoCode value={track.isrc} />}
      </td>
      <td className="px-3 py-3">
        <span className="block max-w-[160px] truncate font-mono text-xs text-slate-600" title={track.custom_id || ""}>
          {track.custom_id || "–"}
        </span>
      </td>
      <td className="px-3 py-3">
        <MonoCode value={track.asset_id} />
        {track.asset_status && <span className={cx("block text-[11px] font-bold", track.asset_status === "active" ? "text-emerald-700" : "text-slate-400")}>{track.asset_status}</span>}
      </td>
      <td className="px-3 py-3">
        {audioUpload ? (
          <div className="w-[220px] space-y-1">
            <ProgressBar
              value={audioUpload.progress}
              size="sm"
              tone={audioUpload.status === "error" ? "red" : "blue"}
              label={audioUpload.status === "error" ? t("Upload failed") : t("Uploading {file}", { file: truncate(audioUpload.file_name, 22) })}
            />
            {audioUpload.status === "error" && (
              <span className="block text-[11px] font-bold text-red-600" title={tm(audioUpload.error)}>
                {truncate(tm(audioUpload.error), 90)}
              </span>
            )}
            <button type="button" onClick={() => (audioUploading ? onAudioCancel(track) : onAudioDismiss(track))} className="text-[11px] font-black text-slate-500 hover:text-slate-900">
              {audioUploading ? t("Cancel upload") : t("Dismiss")}
            </button>
          </div>
        ) : audioStored ? (
          <div className="space-y-1">
            <span className="block max-w-[220px] truncate text-xs font-bold text-slate-900" title={track.file_name || ""}>
              {track.file_name || t(meta.media)}
            </span>
            <span className="block text-[11px] font-bold text-slate-400">
              {formatBytes(track.file_size)}
              {track.file_uploaded_at ? ` · ${formatDateTime(track.file_uploaded_at)}` : ""}
            </span>
            <div className="flex items-center gap-1">
              <IconButton icon={playing ? Square : Play} label={playing ? t("Stop playback") : t("Play")} size="sm" tone={playing ? "blue" : "slate"} onClick={() => onTogglePlay(track)} />
              <IconButton icon={Download} label={t("Download")} size="sm" loading={busy === "audio-download"} disabled={locked || audioUploading} onClick={() => onAudioDownload(track)} />
              {/* The backend refuses media changes while the job runs (it may be streaming this file). */}
              <AudioFileButton icon={RefreshCw} accept={accept} label={jobRunning ? t("Replace {mediaFile} (wait for the delivery to finish)", { mediaFile: t(meta.mediaFile) }) : t("Replace {mediaFile}", { mediaFile: t(meta.mediaFile) })} disabled={disabled || jobRunning} onFile={(file) => onAudioFile(track, file)} />
              <IconButton icon={Trash2} label={t("Remove {mediaFile}", { mediaFile: t(meta.mediaFile) })} size="sm" tone="red" loading={busy === "audio-remove"} disabled={disabled || jobRunning || isInFlight(track)} onClick={() => onAudioRemove(track)} />
            </div>
            {playing && <AudioPlayer trackId={track.id} version={audioVersionOf(track)} fileName={track.file_name || ""} kind={meta.kind} onClose={() => onTogglePlay(track)} />}
          </div>
        ) : (
          <div className="space-y-1.5">
            <span className="block text-[11px] font-bold text-slate-400">{t("No {media} stored", { media: t(meta.media) })}</span>
            <AudioFileButton icon={Upload} accept={accept} label={jobRunning ? t("Upload the {mediaFile} once the delivery has finished", { mediaFile: t(meta.mediaFile) }) : t("Upload the {mediaFile} of this {item}", { mediaFile: t(meta.mediaFile), item: t(meta.item) })} disabled={disabled || jobRunning} onFile={(file) => onAudioFile(track, file)}>
              {t("Upload")}
            </AudioFileButton>
          </div>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            {track.reference_id ? (
              <StatusBadge status={track.reference_status} meta={referenceMeta(track.reference_status)} title={t("Reference {id}", { id: track.reference_id })} />
            ) : (
              <Badge tone={track.asset_id && track.status !== "taken_down" ? "amber" : "slate"}>{track.asset_id && track.status !== "taken_down" ? t("missing") : t("none")}</Badge>
            )}
          </div>
          {track.reference_id && (
            <span className="block max-w-[200px] truncate font-mono text-[11px] text-slate-400" title={track.reference_id}>
              {track.reference_id}
            </span>
          )}
          {referencePending ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-blue-700">
              <Loader2 size={12} className="animate-spin" /> {t("Uploading to CMS…")}
            </span>
          ) : canDeliverReference(track) ? (
            <Button
              size="sm"
              variant="secondary"
              icon={CloudUpload}
              disabled={disabled || jobRunning}
              title={jobRunning ? t("A delivery is running on the server") : t("Upload the stored {mediaFile} to CMS as the reference", { mediaFile: t(meta.mediaFile) })}
              onClick={() => onDeliverReference(track)}
            >
              {t("Deliver reference")}
            </Button>
          ) : canReferenceFromClaim(track) && !liveReference ? (
            <span className="block text-[11px] font-bold text-amber-700">{t("Upload the {mediaFile} first", { mediaFile: t(meta.mediaFile) })}</span>
          ) : null}
          {canReferenceFromClaim(track) && !liveReference && !referencePending && (
            <button type="button" disabled={disabled} onClick={() => onAction("from-claim", track)} className="block text-[11px] font-black text-blue-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50">
              {t("From claim ID")}
            </button>
          )}
        </div>
      </td>
      <td className="px-3 py-3 text-xs">
        <span className="block max-w-[150px] truncate font-bold text-slate-700" title={track.match_policy_name || ""}>
          {track.match_policy_name || (track.match_policy_id ? t("Policy") : "–")}
        </span>
        {override !== null && (
          <span className="block max-w-[150px] truncate text-[11px] font-bold text-indigo-700" title={override.join(", ")}>
            {t("labels: {labels}", { labels: override.length ? override.join(", ") : t("none") })}
          </span>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <StatusBadge status={track.status} meta={TRACK_META} />
            {rowBusy && <Loader2 size={13} className="animate-spin text-slate-400" />}
          </div>
          <StepDots track={track} />
          {isInFlight(track) && track.step && <span className="block text-[11px] font-bold text-blue-700">{t(STEP_TEXT[track.step] || track.step)}…</span>}
          {track.error_message && (
            <span className={cx("block max-w-[220px] text-[11px] font-bold leading-snug", track.status === "error" ? "text-red-600" : "text-amber-700")} title={tm(track.error_message)}>
              {track.step ? `[${track.step}] ` : ""}
              {truncate(tm(track.error_message), 110)}
            </span>
          )}
          {showRowError && (
            <span className="flex max-w-[220px] items-start gap-1 text-[11px] font-bold leading-snug text-red-600">
              <span className="min-w-0 break-words" title={tm(rowError.message)}>
                {rowErrorLabel ? `${rowErrorLabel}: ` : ""}
                {truncate(tm(rowError.message), 110)}
              </span>
              <button type="button" onClick={() => onDismissError(track)} aria-label={t("Dismiss error")} className="shrink-0 text-slate-400 hover:text-slate-700">
                <X size={11} />
              </button>
            </span>
          )}
          {track.status === "duplicate" && <span className="block text-[11px] font-bold text-amber-700">{t("{count} existing asset(s) with this ISRC", { count: duplicates.length || 1 })}</span>}
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center justify-end gap-1">
          <IconButton icon={History} label={t("View track logs")} size="sm" onClick={() => onAction("logs", track)} />
          <IconButton icon={Eye} label={t("Details")} size="sm" onClick={() => onAction("details", track)} />
          <RowMenu items={menuItems} />
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Events timeline
// ---------------------------------------------------------------------------

const EVENTS_PREVIEW = 12;

function EventsTimeline({ events, tracksById }) {
  const { t, tm } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? events : events.slice(0, EVENTS_PREVIEW);

  if (!events.length) {
    return <EmptyState compact icon={History} title={t("No activity yet")} description={t("Deliveries, uploads, edits and takedowns are logged here.")} />;
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {visible.map((event) => {
          const meta = EVENT_ACTION_META?.[event.action] || null;
          const Icon = (meta && (typeof meta.icon === "function" || typeof meta.icon === "object") && meta.icon) || EVENT_ICONS[event.action] || Activity;
          const tone = event.status === "error" ? "red" : meta?.tone || EVENT_TONES[event.action] || "slate";
          const track = event.track_id ? tracksById.get(Number(event.track_id)) : null;
          return (
            <li key={event.id} className="flex gap-3 rounded-2xl border border-slate-100 px-3 py-2.5">
              <span className={cx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", TONE_CLASSES[tone] || TONE_CLASSES.slate)}>
                <Icon size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-black text-slate-900">{meta?.label ? t(meta.label) : String(event.action || "").replace(/_/g, " ")}</span>
                  {event.status === "error" && <Badge tone="red">{t("error")}</Badge>}
                  {track && (
                    <span className="max-w-[220px] truncate rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600" title={trackLabel(t, track)}>
                      {trackLabel(t, track)}
                    </span>
                  )}
                </div>
                {event.message && <p className="mt-0.5 break-words text-xs font-medium text-slate-600">{tm(event.message)}</p>}
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] font-bold text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <UserRound size={11} />
                    {event.created_by_name || t("system")}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock size={11} />
                    {formatDateTime(event.created_at) || "–"}
                  </span>
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {events.length > EVENTS_PREVIEW && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((current) => !current)}>
          {expanded ? t("Show less") : t("Show all {count} events", { count: events.length })}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ProductHeader({ product, meta, network, options, refreshing, jobRunning, onBack }) {
  const { t, tm } = useI18n();
  const copy = copyOf(meta);
  const fields = productFormOf(product.asset_type);
  const ItemIcon = copy.itemIcon;
  const MediaIcon = copy.mediaIcon;
  const tracks = product.tracks || [];
  const counters = {
    tracks: tracks.length || Number(product.track_count || 0),
    delivered: countBy(tracks, (track) => Boolean(track.asset_id)),
    completed: countBy(tracks, hasLiveReference),
    audio: countBy(tracks, hasStoredAudio),
    audioBytes: tracks.reduce((sum, track) => sum + (hasStoredAudio(track) ? Number(track.file_size) || 0 : 0), 0),
    errors: countBy(tracks, (track) => track.status === "error")
  };
  const contentOwner = options?.content_owner || null;
  const cmsName = product.network_name || network?.name || t("CMS");
  const ownerLabel = contentOwner?.display_name ? `${contentOwner.display_name} · ${contentOwner.id}` : product.content_owner_id || network?.network_code || "";
  const releaseLine = [product.label, joinList(product.genre), formatDate(product.release_date)].filter(Boolean).join(" · ");

  return (
    <Card>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-5">
          {product.artwork_data_url ? (
            <img src={product.artwork_data_url} alt={product.artwork_name || t("Artwork")} className="h-28 w-28 shrink-0 rounded-3xl border border-slate-200 object-cover shadow-sm" />
          ) : (
            <span className="flex h-28 w-28 shrink-0 items-center justify-center rounded-3xl bg-slate-100 text-3xl font-black text-slate-400">{initialsOf(product.title)}</span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
                {t("Back")}
              </Button>
              <span className="text-xs font-black uppercase tracking-wide text-slate-400">{t(copy.Product)} #{product.id}</span>
              {refreshing && (
                <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-400">
                  <Loader2 size={12} className="animate-spin" /> {t("Refreshing")}
                </span>
              )}
            </div>
            <h1 className="mt-2 break-words text-2xl font-black text-slate-950 md:text-3xl">{product.title}</h1>
            {product.artist && <p className="mt-1 text-base font-bold text-slate-600">{product.artist}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-bold text-slate-500">
              <Badge tone="indigo" title={t("Content ID asset type")}>
                {t(meta.label)}
              </Badge>
              {fields.upc && (product.upc ? (
                <span className="inline-flex items-center gap-1.5">
                  <Hash size={13} className="text-slate-400" /> {t("UPC")} <MonoCode value={product.upc} />
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-slate-400">
                  <Hash size={13} /> {t("No UPC")}
                </span>
              ))}
              {releaseLine && (
                <span className="inline-flex items-center gap-1.5">
                  <Tag size={13} className="text-slate-400" /> {releaseLine}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <Globe size={13} className="text-slate-400" /> {cmsName}
                {ownerLabel && <span className="font-mono text-[11px] text-slate-400">{ownerLabel}</span>}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold text-slate-400">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck size={12} /> {tm(summarizeOwnership(product.ownership.mode, product.ownership.territories))}
              </span>
              <span className="inline-flex items-center gap-1">
                <ListChecks size={12} /> {product.match_policy_name || product.match_policy_id || t("No policy")}
              </span>
              {product.asset_labels.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Tag size={12} /> {product.asset_labels.join(", ")}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <MediaIcon size={12} /> {includeReferenceOf(product) ? t("References delivered automatically") : t("References delivered manually")}
              </span>
              <span className="inline-flex items-center gap-1" title={t("Whether the delivery job removes each stored {mediaFile} once its reference is live in CMS", { mediaFile: t(meta.mediaFile) })}>
                <HardDrive size={12} /> {Number(product.delete_reference_after_delivery) ? t("{serverMedia} removed after delivery", { serverMedia: t(copy.serverMedia) }) : t("{serverMedia} kept after delivery", { serverMedia: t(copy.serverMedia) })}
              </span>
              {product.created_by_name && (
                <span className="inline-flex items-center gap-1">
                  <UserRound size={12} /> {product.created_by_name}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Calendar size={12} /> {t("Created {time}", { time: formatDateTime(product.created_at) || "–" })}
              </span>
              {product.delivered_at && (
                <span className="inline-flex items-center gap-1">
                  <Send size={12} /> {t("Delivered {time}", { time: formatDateTime(product.delivered_at) })}
                </span>
              )}
              {product.last_synced_at && (
                <span className="inline-flex items-center gap-1">
                  <RefreshCw size={12} /> {t("Synced {time}", { time: formatDateTime(product.last_synced_at) })}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-3 lg:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={product.status} meta={PRODUCT_META} />
            {jobRunning && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-700">
                <Loader2 size={12} className="animate-spin" /> {t("Delivering on the server…")}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:w-[560px]">
            <StatTile label={capitalize(t(meta.items))} value={counters.tracks} tone="slate" icon={ItemIcon} className="p-3" />
            <StatTile label={t(copy.filesTile)} value={`${counters.audio}/${counters.tracks}`} tone={counters.audio === counters.tracks && counters.tracks ? "emerald" : "indigo"} icon={HardDrive} hint={counters.audioBytes ? t("{size} on server", { size: formatBytes(counters.audioBytes) }) : t(copy.filesTileHint)} className="p-3" />
            <StatTile label={t("Assets")} value={counters.delivered} tone="blue" icon={Disc3} hint={t("created in CMS")} className="p-3" />
            <StatTile label={t("References")} value={counters.completed} tone="emerald" icon={MediaIcon} hint={t("active / processing")} className="p-3" />
            <StatTile label={t("Errors")} value={counters.errors} tone={counters.errors ? "red" : "slate"} icon={XCircle} className="p-3" />
          </div>
        </div>
      </div>
      {product.error_message && (
        <InlineMessage tone="error" className="mt-4">
          {tm(product.error_message)}
        </InlineMessage>
      )}
      {product.notes && <p className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-xs font-medium text-slate-600">{product.notes}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function clampPercent(value) {
  const number = typeof value === "number" ? value : Number(value?.percent ?? value?.progress ?? 0);
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(number) ? number : 0)));
}

function summarizeJob(t, tracks, trackIds) {
  const scope = Array.isArray(trackIds) && trackIds.length ? new Set(trackIds.map(Number)) : null;
  const subject = scope ? tracks.filter((track) => scope.has(Number(track.id))) : tracks;
  const completed = countBy(subject, (track) => track.status === "completed");
  const created = countBy(subject, (track) => track.status === "created");
  const duplicates = countBy(subject, (track) => track.status === "duplicate");
  const failed = countBy(subject, (track) => track.status === "error");
  const parts = [
    completed ? t("{count} delivered with reference", { count: completed }) : "",
    created ? (created === 1 ? t("{count} asset created", { count: created }) : t("{count} assets created", { count: created })) : "",
    duplicates ? t("{count} duplicate", { count: duplicates }) : "",
    failed ? t("{count} failed", { count: failed }) : ""
  ].filter(Boolean);
  return { text: parts.length ? parts.join(" · ") : t("nothing changed"), failed };
}

export default function ProductDetail({ productId, kind: kindProp = "music", network, options, optionsLoading, reloadOptions, localLabels = [], showToast, onBack, onDeleted }) {
  const { t, tm } = useI18n();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ key: "", product: null, error: "" });
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [busy, setBusy] = useState("");
  const [trackBusy, setTrackBusy] = useState({});
  const [rowErrors, setRowErrors] = useState({});
  const [audioUploads, setAudioUploads] = useState({});
  // Video files refused for being shorter than a Content ID reference may be (pop-up).
  const [shortMedia, setShortMedia] = useState([]);
  const [playingId, setPlayingId] = useState(null);
  const [pollError, setPollError] = useState("");
  const [optionsCache, setOptionsCache] = useState({});
  const [modal, setModal] = useState(null);
  const [prevProductId, setPrevProductId] = useState(productId);
  const controllersRef = useRef(new Map());
  const optionsInflightRef = useRef(new Set());
  const pollingRef = useRef(false);
  const mountedRef = useRef(true);
  const visible = useDocumentVisible();

  // Reset per-product UI state when the page switches to another product (adjusting state during render).
  if (prevProductId !== productId) {
    setPrevProductId(productId);
    setSelectedIds(new Set());
    setModal(null);
    setTrackBusy({});
    setRowErrors({});
    setPlayingId(null);
    setPollError("");
  }

  const loadKey = `${productId}|${tick}`;
  const loading = state.key !== loadKey;
  const product = state.product && state.key.startsWith(`${productId}|`) ? state.product : null;
  // Wording, accepted files and the ISRC rule follow the loaded product's asset type; the
  // `kind` prop only covers the loading / error screens shown before the product is known.
  const meta = product ? assetTypeMeta(product.asset_type) : DEFAULT_META_BY_KIND[kindProp] || ASSET_TYPE_META.sound_recording;
  const copy = copyOf(meta);
  const tracks = useMemo(() => product?.tracks || [], [product]);
  const events = product?.events || [];
  const tracksById = useMemo(() => new Map(tracks.map((track) => [Number(track.id), track])), [tracks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    if (!productId) return undefined;
    let cancelled = false;
    getProduct(productId)
      .then((data) => {
        if (cancelled) return;
        const next = normalizeProduct(data?.product);
        setState({ key: loadKey, product: next, error: next ? "" : tk("Product not found") });
      })
      .catch((err) => {
        if (cancelled) return;
        setState((current) => ({ ...current, key: loadKey, error: getErrorMessage(err) }));
      });
    return () => {
      cancelled = true;
    };
  }, [productId, loadKey]);

  // --- CMS options for the product's own network ------------------------------
  // The page header may have another CMS selected; policies, labels and the
  // content owner must always come from the network the product belongs to.

  const productNetworkId = product?.network_id !== undefined && product?.network_id !== null ? String(product.network_id) : "";
  const headerMatches = Boolean(productNetworkId) && network?.id !== undefined && network?.id !== null && String(network.id) === productNetworkId;
  const cachedOptions = productNetworkId ? optionsCache[productNetworkId] : null;
  const productOptions = headerMatches ? options || null : cachedOptions?.options || null;
  const productOptionsLoading = headerMatches ? Boolean(optionsLoading) : Boolean(productNetworkId) && !cachedOptions;
  const productOptionsError = headerMatches ? "" : cachedOptions?.error || "";

  useEffect(() => {
    if (!productNetworkId || headerMatches || optionsCache[productNetworkId]) return;
    const inflight = optionsInflightRef.current;
    if (inflight.has(productNetworkId)) return;
    inflight.add(productNetworkId);
    getDeliveryOptions(productNetworkId)
      .then((data) => {
        if (!mountedRef.current) return;
        setOptionsCache((current) => ({ ...current, [productNetworkId]: { options: data?.options || null, error: "" } }));
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setOptionsCache((current) => ({ ...current, [productNetworkId]: { options: null, error: getErrorMessage(err) } }));
      })
      .finally(() => {
        inflight.delete(productNetworkId);
      });
  }, [productNetworkId, headerMatches, optionsCache]);

  function reloadProductOptions() {
    if (headerMatches) {
      reloadOptions?.();
      return;
    }
    if (!productNetworkId) return;
    setOptionsCache((current) => {
      if (!current[productNetworkId]) return current;
      const next = { ...current };
      delete next[productNetworkId];
      return next;
    });
  }

  // --- derived --------------------------------------------------------------

  const jobRunning = Boolean(product?.job?.running);
  const selectedTracks = tracks.filter((track) => selectedIds.has(track.id));
  const pendingTracks = tracks.filter((track) => isDeliverable(track, jobRunning, product?.status === "delivering"));
  const referenceTargets = tracks.filter(canDeliverReference);
  const releasableTracks = tracks.filter(isAudioReleasable);
  const releasableBytes = releasableTracks.reduce((sum, track) => sum + (Number(track.file_size) || 0), 0);
  const deliveredCount = countBy(tracks, (track) => Boolean(track.asset_id));
  const takedownCount = countBy(tracks, canTakedown);
  const takenDownCount = countBy(tracks, (track) => track.status === "taken_down");
  const inFlightCount = countBy(tracks, isInFlight);
  const activeUploads = Object.values(audioUploads).some((item) => item.status === "uploading");
  const inProgress = Boolean(product) && (product.status === "delivering" || inFlightCount > 0 || tracks.some((track) => isProcessingReference(track.reference_status)));
  const locked = Boolean(busy);
  const allSelected = tracks.length > 0 && tracks.every((track) => selectedIds.has(track.id));

  function reload() {
    setTick((current) => current + 1);
  }

  // Slow refresh while YouTube is still processing references (or a job was
  // interrupted); the fast progress poll below takes over while a job runs.
  useInterval(
    () => {
      if (!busy && !activeUploads && !loading) reload();
    },
    !jobRunning && inProgress && visible ? AUTO_REFRESH_MS : null
  );

  async function pollProgress() {
    if (!product || pollingRef.current) return;
    pollingRef.current = true;
    const id = product.id;
    try {
      const data = await getProductProgress(id);
      if (!mountedRef.current) return;
      setPollError("");
      setState((current) => {
        if (!current.product || Number(current.product.id) !== Number(id)) return current;
        return { ...current, product: mergeProgress(current.product, data) };
      });
      if (!data?.job?.running) {
        // The progress payload carries every track's status; scope the summary to the job when known.
        const summary = summarizeJob(t, Array.isArray(data?.tracks) ? data.tracks : tracks, product.job?.track_ids);
        showToast(t("Delivery finished · {summary}", { summary: summary.text }), summary.failed ? "warning" : "success");
        reload();
      }
    } catch (err) {
      if (mountedRef.current) setPollError(getErrorMessage(err));
    } finally {
      pollingRef.current = false;
    }
  }

  useInterval(pollProgress, jobRunning && visible ? JOB_POLL_MS : null);

  // --- selection ------------------------------------------------------------

  function toggleTrack(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(tracks.map((track) => track.id)));
  }

  // --- per-row error / busy state ------------------------------------------

  function setRowError(id, error) {
    setRowErrors((current) => {
      const next = { ...current };
      if (error) next[id] = error;
      else delete next[id];
      return next;
    });
  }

  function setRowBusy(id, action) {
    setTrackBusy((current) => {
      const next = { ...current };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  }

  // --- audio upload state ---------------------------------------------------

  function patchAudioUpload(id, patch) {
    setAudioUploads((current) => (current[id] ? { ...current, [id]: { ...current[id], ...patch } } : current));
  }

  function removeAudioUpload(id) {
    setAudioUploads((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  /** Upload (or replace) the audio file stored on the server for one track. */
  async function startAudioUpload(track, file, uploadOptions = {}) {
    // Video references shorter than the Content ID minimum are refused before any byte is sent
    // (pop-up + row error); the server re-checks MP4/MOV files and answers 422 otherwise.
    if (meta.kind === "video") {
      const duration = await probeMediaDuration(file);
      if (!mountedRef.current) return null;
      if (duration !== null && duration < MIN_VIDEO_REFERENCE_SECONDS) {
        const message = t("«{file}» is {duration} long; Content ID references must be at least {min} seconds. Not uploaded.", { file: file.name, duration: formatSeconds(duration), min: MIN_VIDEO_REFERENCE_SECONDS });
        setShortMedia((current) => [...current, { file, duration }]);
        setRowError(track.id, { action: "audio-upload", message });
        throw new Error(message);
      }
    }
    const ownController = uploadOptions.signal ? null : new AbortController();
    const signal = uploadOptions.signal || ownController.signal;
    if (ownController) controllersRef.current.set(track.id, ownController);
    if (playingId === track.id) setPlayingId(null);
    setAudioUploads((current) => ({ ...current, [track.id]: { progress: 0, file_name: file.name, status: "uploading", error: "" } }));
    try {
      const data = await uploadTrackAudio(track.id, file, {
        signal,
        onProgress: (value) => {
          const percent = clampPercent(value);
          uploadOptions.onProgress?.(percent);
          if (mountedRef.current) patchAudioUpload(track.id, { progress: percent });
        }
      });
      if (mountedRef.current) {
        removeAudioUpload(track.id);
        setRowError(track.id, null);
        if (!uploadOptions.quiet) showToast(t("{Media} stored for «{track}» · {size}", { Media: capitalize(t(meta.media)), track: trackLabel(t, track), size: formatBytes(data?.track?.file_size ?? file.size) }), "success");
        reload();
      }
      return data;
    } catch (err) {
      if (mountedRef.current) {
        if (signal.aborted) {
          removeAudioUpload(track.id);
          if (!uploadOptions.quiet) showToast(t("Upload cancelled"), "warning");
        } else {
          const message = getErrorMessage(err);
          const data = err?.response?.data;
          if (data?.code === "VIDEO_TOO_SHORT") setShortMedia((current) => [...current, { file, duration: Number(data.duration_seconds) }]);
          patchAudioUpload(track.id, { status: "error", error: message });
          setRowError(track.id, { action: "audio-upload", message });
          if (!uploadOptions.quiet) showToast(t("{Media} upload failed: {message}", { Media: capitalize(t(meta.media)), message: tm(message) }), "error");
        }
      }
      throw err;
    } finally {
      if (ownController) controllersRef.current.delete(track.id);
    }
  }

  function cancelAudioUpload(track) {
    const controller = controllersRef.current.get(track.id);
    if (controller) controller.abort();
    else removeAudioUpload(track.id);
  }

  async function handleAudioDownload(track) {
    setRowBusy(track.id, "audio-download");
    try {
      const data = await getTrackAudioBlob(track.id);
      if (!mountedRef.current) return;
      downloadBlob(toAudioBlob(data, track.file_name), track.file_name || `track-${track.id}`);
      setRowError(track.id, null);
    } catch (err) {
      if (mountedRef.current) {
        const message = getErrorMessage(err);
        setRowError(track.id, { action: "audio-download", message });
        showToast(t("Download failed: {message}", { message: tm(message) }), "error");
      }
    } finally {
      if (mountedRef.current) setRowBusy(track.id, null);
    }
  }

  function togglePlay(track) {
    setPlayingId((current) => (current === track.id ? null : track.id));
  }

  // --- product-level actions ------------------------------------------------

  // The browser gave up waiting, but the server keeps applying the change (it re-sends CMS
  // calls whose answer never arrived, which can take a few minutes): refresh instead of
  // reporting a failure, and once more a little later so the outcome shows up by itself.
  function isClientTimeout(err) {
    return err?.code === "ECONNABORTED";
  }

  function followServerAfterTimeout(what) {
    showToast(t("{action} is still running on the server (the browser stopped waiting). Refreshing now and once more in 30 s; the delivery log has the outcome.", { action: what }), "warning", 10000);
    reload();
    setTimeout(() => {
      if (mountedRef.current) reload();
    }, 30000);
  }

  // `errorPrefix` ("Sync failed") and `actionLabel` ("Sync", named in the timeout notice) arrive already translated.
  async function runProductAction(action, worker, { successMessage, errorPrefix, actionLabel } = {}) {
    if (!product) return;
    setBusy(action);
    try {
      const data = await worker();
      if (!mountedRef.current) return;
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      if (errors.length) {
        errors.forEach((item) => {
          if (item?.track_id) setRowError(Number(item.track_id), { action, message: item.message || item.error || tk("Failed") });
        });
        const outcome = { summary: successMessage || t("Done"), count: errors.length, details: summarizeErrors({ t, tm }, errors) };
        showToast(errors.length === 1 ? t("{summary} · {count} error: {details}", outcome) : t("{summary} · {count} errors: {details}", outcome), "warning");
      } else if (successMessage) {
        showToast(successMessage, "success");
      }
      reload();
    } catch (err) {
      if (mountedRef.current && isClientTimeout(err)) {
        followServerAfterTimeout(actionLabel || t("Action"));
        return;
      }
      if (mountedRef.current) showToast(t("{prefix}: {message}", { prefix: errorPrefix || t("Action failed"), message: tm(getErrorMessage(err)) }), "error");
      throw err;
    } finally {
      if (mountedRef.current) setBusy("");
    }
  }

  function handleSyncProduct() {
    runProductAction("sync", () => syncProduct(product.id), { successMessage: t("Synced from CMS"), errorPrefix: t("Sync failed"), actionLabel: t("Sync") }).catch(() => {});
  }

  async function handleUpdateProduct(payload) {
    await runProductAction("edit", () => updateProduct(product.id, payload), {
      successMessage: payload.apply_to_cms && deliveredCount ? t("{saved} and pushed to CMS", { saved: t(copy.infoSaved) }) : t(copy.infoSaved),
      errorPrefix: t("Save failed"),
      actionLabel: t("Save")
    });
  }

  async function handleUpdateRights(payload) {
    await runProductAction("rights", () => updateProductRights(product.id, payload), { successMessage: t("Rights updated"), errorPrefix: t("Rights update failed"), actionLabel: t("Rights update") });
  }

  /** Applies a 202 "job started" answer to the page state and switches to fast polling. */
  function applyStartedJob(data, ids) {
    const job = jobOf(data?.job);
    const queued = new Set((Array.isArray(job.track_ids) && job.track_ids.length ? job.track_ids : ids).map(Number));
    setState((current) => {
      if (!current.product || Number(current.product.id) !== Number(product.id)) return current;
      return {
        ...current,
        product: {
          ...current.product,
          ...pickDefined(data?.product, PROGRESS_PRODUCT_FIELDS),
          status: "delivering",
          job: { ...job, running: true, track_ids: Array.from(queued) },
          tracks: current.product.tracks.map((track) => (queued.has(Number(track.id)) ? { ...track, status: "creating", step: "queued", error_message: "" } : track))
        }
      };
    });
    setPollError("");
    setSelectedIds(new Set());
    ids.forEach((id) => setRowError(Number(id), null));
    return queued;
  }

  /** Start the background delivery job on the server and switch to fast polling. */
  async function handleDeliver(trackIds, { include_reference: includeReference, delete_reference_after_delivery: deleteReference } = {}) {
    setModal(null);
    setBusy("deliver");
    const ids = Array.isArray(trackIds) ? trackIds : [];
    try {
      const data = await deliverProduct(product.id, { track_ids: ids, include_reference: includeReference, delete_reference_after_delivery: deleteReference });
      if (!mountedRef.current) return;
      const queued = applyStartedJob(data, ids);
      const count = queued.size || ids.length;
      showToast(count === 1 ? t("Delivery started on the server for {count} {item} · progress updates every 2 s", { count, item: t(meta.item) }) : t("Delivery started on the server for {count} {items} · progress updates every 2 s", { count, items: t(meta.items) }), "info");
    } catch (err) {
      if (mountedRef.current) {
        showToast(t("Delivery failed to start: {message}", { message: tm(getErrorMessage(err)) }), "error");
        reload();
      }
    } finally {
      if (mountedRef.current) setBusy("");
    }
  }

  /**
   * Server-side reference upload for one or several tracks. It runs as the product's background
   * job (202), so a large file never depends on this browser tab; the progress poll follows it.
   */
  async function startReferenceJob(trackIds, worker, label = t("Reference delivery")) {
    const ids = (Array.isArray(trackIds) ? trackIds : []).map(Number).filter((id) => tracksById.has(id));
    setModal(null);
    if (!ids.length) {
      showToast(t("No {item} with an asset and a stored {mediaFile} to deliver", { item: t(meta.item), mediaFile: t(meta.mediaFile) }), "warning");
      return;
    }
    setBusy("references");
    try {
      const data = await worker(ids);
      if (!mountedRef.current) return;
      const queued = applyStartedJob(data, ids);
      const count = queued.size || ids.length;
      showToast(count === 1 ? t("{label} started on the server for {count} {item} · progress updates every 2 s", { label, count, item: t(meta.item) }) : t("{label} started on the server for {count} {items} · progress updates every 2 s", { label, count, items: t(meta.items) }), "info");
    } catch (err) {
      if (mountedRef.current) {
        const message = getErrorMessage(err);
        if (ids.length === 1) setRowError(ids[0], { action: "reference", message });
        showToast(t("Reference delivery failed to start: {message}", { message: tm(message) }), "error");
        reload();
      }
    } finally {
      if (mountedRef.current) setBusy("");
    }
  }

  function runReferenceBatch(trackIds) {
    return startReferenceJob(trackIds, (ids) => deliverProduct(product.id, { track_ids: ids, include_reference: true }));
  }

  async function handleTakedown({ reason, release_claims: releaseClaims, selectedOnly }) {
    const track = modal?.track || null;
    const payload = { release_claims: releaseClaims, reason };
    if (!track && selectedOnly) {
      // Never send an empty list: the backend treats a missing key as "all delivered tracks".
      const ids = selectedTracks.filter(canTakedown).map((item) => item.id);
      if (!ids.length) {
        showToast(t("None of the selected {items} can be taken down", { items: t(meta.items) }), "warning");
        return;
      }
      payload.track_ids = ids;
    }
    setBusy("takedown");
    try {
      const data = track ? await takedownTrack(track.id, payload) : await takedownProduct(product.id, payload);
      if (!mountedRef.current) return;
      const results = Array.isArray(data?.results) ? data.results : [];
      const references = results.reduce((sum, item) => sum + Number(item.references_deactivated || 0), 0);
      const claims = results.reduce((sum, item) => sum + Number(item.claims_released || 0), 0);
      const failed = results.filter((item) => item.error);
      failed.forEach((item) => {
        if (item.track_id) setRowError(Number(item.track_id), { action: "takedown", message: String(item.error) });
      });
      const summary = results.length
        ? ` · ${references === 1 ? t("{count} reference deactivated", { count: references }) : t("{count} references deactivated", { count: references })} · ${claims === 1 ? t("{count} claim released", { count: claims }) : t("{count} claims released", { count: claims })}`
        : "";
      showToast(
        failed.length
          ? failed.length === 1
            ? t("Takedown finished with {count} error: {error}", { count: failed.length, error: tm(String(failed[0].error)) })
            : t("Takedown finished with {count} errors: {error}", { count: failed.length, error: tm(String(failed[0].error)) })
          : t("Taken down{summary}", { summary }),
        failed.length ? "warning" : "success"
      );
      setModal(null);
      setSelectedIds(new Set());
      reload();
    } catch (err) {
      if (mountedRef.current) {
        if (isClientTimeout(err)) {
          setModal(null);
          followServerAfterTimeout(t("Takedown"));
        } else {
          const message = getErrorMessage(err);
          if (track) setRowError(track.id, { action: "takedown", message });
          showToast(t("Takedown failed: {message}", { message: tm(message) }), "error");
        }
      }
    } finally {
      if (mountedRef.current) setBusy("");
    }
  }

  async function handleReactivate({ selectedOnly }) {
    const track = modal?.track || null;
    const payload = {};
    if (!track && selectedOnly) {
      const ids = selectedTracks.filter((item) => item.status === "taken_down").map((item) => item.id);
      if (!ids.length) {
        showToast(t("None of the selected {items} is taken down", { items: t(meta.items) }), "warning");
        return;
      }
      payload.track_ids = ids;
    }
    setBusy("reactivate");
    try {
      const data = track ? await reactivateTrack(track.id, payload) : await reactivateProduct(product.id, payload);
      if (!mountedRef.current) return;
      const results = Array.isArray(data?.results) ? data.results : [];
      const failed = results.filter((item) => item.error);
      failed.forEach((item) => {
        if (item.track_id) setRowError(Number(item.track_id), { action: "reactivate", message: String(item.error) });
      });
      showToast(
        failed.length
          ? failed.length === 1
            ? t("Reactivation finished with {count} error: {error}", { count: failed.length, error: tm(String(failed[0].error)) })
            : t("Reactivation finished with {count} errors: {error}", { count: failed.length, error: tm(String(failed[0].error)) })
          : t("Reactivated"),
        failed.length ? "warning" : "success"
      );
      setModal(null);
      setSelectedIds(new Set());
      reload();
    } catch (err) {
      if (mountedRef.current) {
        if (isClientTimeout(err)) {
          setModal(null);
          followServerAfterTimeout(t("Reactivation"));
        } else {
          const message = getErrorMessage(err);
          if (track) setRowError(track.id, { action: "reactivate", message });
          showToast(t("Reactivation failed: {message}", { message: tm(message) }), "error");
        }
      }
    } finally {
      if (mountedRef.current) setBusy("");
    }
  }

  /** Remove the stored audio of every fully delivered track to free server storage. */
  async function handleCleanupAudio() {
    setBusy("cleanup");
    // Only the files the dialog listed: the server re-checks each one right before removing it.
    const targetIds = releasableTracks.map((track) => Number(track.id));
    const targetSet = new Set(targetIds);
    try {
      const data = await cleanupProductAudio(product.id, { track_ids: targetIds });
      if (!mountedRef.current) return;
      const results = (Array.isArray(data?.results) ? data.results : []).filter((item) => targetSet.has(Number(item.track_id)));
      const failed = results.filter((item) => item.reason === "error");
      // Files the server kept because the track changed since the page loaded (asset step
      // missing, reference no longer live): say so instead of reporting a clean success.
      const kept = results.filter((item) => !item.removed && item.reason && item.reason !== "no_audio" && item.reason !== "error");
      failed.forEach((item) => {
        if (item.track_id) setRowError(Number(item.track_id), { action: "audio-remove", message: item.message || tk("Could not remove the file") });
      });
      kept.forEach((item) => {
        if (item.track_id) setRowError(Number(item.track_id), { action: "audio-remove", message: item.reason === "no_live_reference" ? tk("File kept: no live reference in CMS yet") : tk("File kept: the asset is not fully delivered yet") });
      });
      if (playingId && results.some((item) => item.removed && Number(item.track_id) === Number(playingId))) setPlayingId(null);
      const removedCount = Number(data?.removed) || 0;
      const freed = { size: formatBytes(data?.bytes_freed || 0), count: removedCount, mediaFile: t(meta.mediaFile) };
      showToast(
        (removedCount === 1 ? t("Freed {size} · {count} {mediaFile} removed from this server", freed) : t("Freed {size} · {count} {mediaFile}s removed from this server", freed))
          + (kept.length ? ` · ${kept.length === 1 ? t("{count} file kept (see the rows)", { count: kept.length }) : t("{count} files kept (see the rows)", { count: kept.length })}` : "")
          + (failed.length ? ` · ${t("{count} failed (see the rows)", { count: failed.length })}` : ""),
        failed.length || kept.length ? "warning" : "success"
      );
      setModal(null);
      reload();
    } catch (err) {
      if (mountedRef.current) showToast(t("Could not free server storage: {message}", { message: tm(getErrorMessage(err)) }), "error");
    } finally {
      if (mountedRef.current) setBusy("");
    }
  }

  async function handleDelete() {
    setBusy("delete");
    try {
      await deleteProduct(product.id);
      if (!mountedRef.current) return;
      showToast(t("Deleted local record of «{title}»", { title: product.title }), "success");
      setModal(null);
      onDeleted?.(product.id);
    } catch (err) {
      if (mountedRef.current) showToast(t("Delete failed: {message}", { message: tm(getErrorMessage(err)) }), "error");
    } finally {
      if (mountedRef.current) setBusy("");
    }
  }

  function handleExport() {
    if (!tracks.length) {
      showToast(t("No {items} to export", { items: t(meta.items) }), "warning");
      return;
    }
    const header = ["product_id", "product_title", "product_artist", "upc", "label", "cms", "content_owner_id", ...EXPORT_COLUMNS.map((column) => column.label)];
    const rows = tracks.map((track) => [
      product.id,
      product.title,
      product.artist,
      product.upc,
      product.label,
      product.network_name,
      product.content_owner_id,
      ...EXPORT_COLUMNS.map((column) => {
        const value = column.value(track);
        return value === null || value === undefined ? "" : String(value);
      })
    ]);
    const safeTitle = String(product.title || "product").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "product";
    downloadTextFile(rowsToCsv([header, ...rows]), `cms-delivery-${product.id}-${safeTitle}.csv`, "text/csv;charset=utf-8");
    showToast(tracks.length === 1 ? t("Exported {count} {item} to CSV", { count: tracks.length, item: t(meta.item) }) : t("Exported {count} {items} to CSV", { count: tracks.length, items: t(meta.items) }), "success");
  }

  // --- track-level actions --------------------------------------------------

  async function runTrackAction(track, action, worker, { onSuccess, errorPrefix, actionLabel, quiet } = {}) {
    setRowBusy(track.id, action);
    try {
      const data = await worker();
      if (!mountedRef.current) return;
      setRowError(track.id, null);
      onSuccess?.(data);
      reload();
    } catch (err) {
      if (mountedRef.current && isClientTimeout(err)) {
        setRowError(track.id, null);
        followServerAfterTimeout(actionLabel || t("Action"));
        return;
      }
      if (mountedRef.current) {
        const message = getErrorMessage(err);
        setRowError(track.id, { action, message });
        if (!quiet) showToast(t("{prefix}: {message}", { prefix: errorPrefix || t("Action failed"), message: tm(message) }), "error");
      }
      throw err;
    } finally {
      if (mountedRef.current) setRowBusy(track.id, null);
    }
  }

  function handleRetry(track) {
    runTrackAction(track, "retry", () => retryTrack(track.id), {
      errorPrefix: t("Retry failed"),
      actionLabel: t("Retry"),
      onSuccess: (data) => {
        const next = data?.track;
        if (next?.status === "error") showToast(t("Retry stopped at {step}: {error}", { step: next.step || t("unknown step"), error: next.error_message ? tm(next.error_message) : t("unknown error") }), "warning");
        else {
          const statusLabel = TRACK_META[next?.status]?.label;
          const status = statusLabel ? t(statusLabel).toLowerCase() : next?.status || t("updated");
          showToast(`${t("«{track}» is now {status}", { track: trackLabel(t, track), status })}${next?.asset_id ? ` · ${t("asset {id}", { id: next.asset_id })}` : ""}`, "success");
        }
      }
    }).catch(() => {});
  }

  function handleSyncTrack(track) {
    runTrackAction(track, "sync", () => syncTrack(track.id), {
      errorPrefix: t("Sync failed"),
      actionLabel: t("Sync"),
      onSuccess: (data) => {
        const next = data?.track;
        showToast(`${t("Synced «{track}»", { track: trackLabel(t, track) })}${next?.reference_status ? ` · ${t("reference {status}", { status: next.reference_status })}` : ""}`, "success");
      }
    }).catch(() => {});
  }

  function handleDeliverReference(track) {
    startReferenceJob(
      [track.id],
      () => deliverTrackReference(track.id, { content_type: product.reference_content_type || "audio", urgent: Boolean(Number(product.reference_urgent)) }),
      t("Reference delivery of «{track}»", { track: trackLabel(t, track) })
    );
  }

  async function handleAudioRemove(track) {
    await runTrackAction(track, "audio-remove", () => deleteTrackAudio(track.id), {
      errorPrefix: t("Remove {media} failed", { media: t(meta.media) }),
      actionLabel: t("Remove {media}", { media: t(meta.media) }),
      onSuccess: () => {
        if (playingId === track.id) setPlayingId(null);
        showToast(t("{MediaFile} removed from «{track}»", { MediaFile: capitalize(t(meta.mediaFile)), track: trackLabel(t, track) }), "success");
      }
    });
  }

  async function handleUpdateTrack(track, payload) {
    await runTrackAction(track, "edit", () => updateTrack(track.id, payload), {
      errorPrefix: t("Save failed"),
      actionLabel: t("Save"),
      onSuccess: () => showToast(payload.apply_to_cms && track.asset_id ? t("{Item} saved and asset updated", { Item: capitalize(t(meta.item)) }) : t("{Item} saved", { Item: capitalize(t(meta.item)) }), "success")
    });
  }

  async function handleReferenceFromClaim(track, claimId, contentType) {
    await runTrackAction(track, "from-claim", () => createTrackReferenceFromClaim(track.id, claimId, contentType), {
      errorPrefix: t("Reference creation failed"),
      actionLabel: t("Reference creation"),
      onSuccess: (data) => showToast(t("Reference created from claim · {status}", { status: data?.reference?.status || t("processing") }), "success")
    });
  }

  function handleRowAction(type, track) {
    switch (type) {
      case "retry":
        handleRetry(track);
        break;
      case "sync":
        handleSyncTrack(track);
        break;
      default:
        setModal({ type, track });
    }
  }

  // --- render ---------------------------------------------------------------

  if (!product) {
    return (
      <div className="space-y-5">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
          {t(copy.backLabel)}
        </Button>
        {loading ? (
          <Card>
            <div className="flex items-center justify-center gap-3 py-16 text-sm font-bold text-slate-500">
              <Spinner size={20} /> {t(copy.loading)}
            </div>
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon={XCircle}
              title={t(copy.unavailable)}
              description={tm(state.error) || t(copy.notFound)}
              action={
                <div className="flex gap-2">
                  <Button variant="secondary" icon={RefreshCw} onClick={reload}>
                    {t("Try again")}
                  </Button>
                  <Button variant="primary" icon={ArrowLeft} onClick={onBack}>
                    {t(copy.backLabel)}
                  </Button>
                </div>
              }
            />
          </Card>
        )}
      </div>
    );
  }

  const selectedPending = selectedTracks.filter((track) => isDeliverable(track, jobRunning, product?.status === "delivering"));
  const selectedReferences = selectedTracks.filter(canDeliverReference);
  const selectedTakedown = selectedTracks.filter(canTakedown);
  const selectedTakenDown = selectedTracks.filter((track) => track.status === "taken_down");
  const interrupted = product.status === "delivering" && !jobRunning;

  return (
    <div className="space-y-5">
      <ProductHeader product={product} meta={meta} network={headerMatches ? network : null} options={productOptions} refreshing={loading} jobRunning={jobRunning} onBack={onBack} />

      {state.error && (
        <InlineMessage
          tone="error"
          actions={
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={reload}>
              {t("Retry")}
            </Button>
          }
        >
          {t("Could not refresh the product: {error}", { error: tm(state.error) })}
        </InlineMessage>
      )}

      {productOptionsError && (
        <InlineMessage
          tone="warning"
          actions={
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={reloadProductOptions}>
              {t("Retry")}
            </Button>
          }
        >
          {t("Could not load the CMS options of «{network}»: {error}. Policies and labels are unavailable until this succeeds.", { network: product.network_name || t("network {id}", { id: product.network_id }), error: tm(productOptionsError) })}
        </InlineMessage>
      )}

      {(busy === "deliver" || jobRunning) && (
        <InlineMessage tone="info" actions={<Button size="sm" variant="secondary" icon={History} onClick={() => setModal({ type: "logs" })}>{t("View live logs")}</Button>}>
          <span className="inline-flex flex-wrap items-center gap-2">
            <Spinner size={15} className="text-blue-700" />
            {busy === "deliver"
              ? t("Starting the delivery on the server…")
              : inFlightCount === 1
                ? t("Delivering on the server… {count} {item} in progress. Progress updates every 2 s; you can leave this page and come back later.", { count: inFlightCount, item: t(meta.item) })
                : t("Delivering on the server… {count} {items} in progress. Progress updates every 2 s; you can leave this page and come back later.", { count: inFlightCount, items: t(meta.items) })}
            {pollError && <span className="text-amber-700">{t("Last progress check failed: {error} — retrying.", { error: tm(pollError) })}</span>}
          </span>
        </InlineMessage>
      )}

      {interrupted && (
        <InlineMessage
          tone="warning"
          actions={
            <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy === "sync"} disabled={locked} onClick={handleSyncProduct}>
              {t("Sync from CMS")}
            </Button>
          }
        >
          {t("The {product} is marked «delivering» but no job is running on the server (it may have been restarted). Sync from CMS to reconcile the {items}, then deliver the remaining ones again.", { product: t(copy.product), items: t(meta.items) })}
        </InlineMessage>
      )}

      <Card bodyClassName="flex flex-wrap items-center gap-2">
        <Button variant="secondary" icon={History} onClick={() => setModal({ type: "logs" })}>
          {t("View logs")}
        </Button>
        <Button variant="secondary" icon={RefreshCw} loading={busy === "sync"} disabled={locked || !deliveredCount} onClick={handleSyncProduct} title={t("Fetch asset and reference status for every delivered {item}", { item: t(meta.item) })}>
          {t("Sync from CMS")}
        </Button>
        <Button variant="secondary" icon={Pencil} disabled={locked} onClick={() => setModal({ type: "edit" })}>
          {t(copy.editTitle)}
        </Button>
        <Button variant="secondary" icon={ShieldCheck} disabled={locked} onClick={() => setModal({ type: "rights" })}>
          {t("Change rights")}
        </Button>
        <Button
          variant="secondary"
          icon={copy.mediaIcon}
          disabled={locked || jobRunning || !tracks.length}
          onClick={() => setModal({ type: "upload" })}
          title={jobRunning ? t("{MediaFile}s can be uploaded once the delivery has finished", { MediaFile: capitalize(t(meta.mediaFile)) }) : t("Store {mediaFile}s on the server and match them to the {items}", { mediaFile: t(meta.mediaFile), items: t(meta.items) })}
        >
          {t("Upload {mediaFile}s", { mediaFile: t(meta.mediaFile) })}
        </Button>
        <Button
          variant="secondary"
          icon={CloudUpload}
          disabled={locked || jobRunning || !referenceTargets.length}
          onClick={() => setModal({ type: "references", trackIds: referenceTargets.map((track) => track.id) })}
          title={referenceTargets.length ? t("Upload the stored {media} of every {item} with an asset and no live reference", { media: t(meta.media), item: t(meta.item) }) : t("No {item} has an asset with stored {media} and no live reference", { item: t(meta.item), media: t(meta.media) })}
        >
          {t("Deliver references")}{referenceTargets.length ? ` (${referenceTargets.length})` : ""}
        </Button>
        {releasableTracks.length > 0 && (
          <Button
            variant="secondary"
            icon={HardDrive}
            loading={busy === "cleanup"}
            disabled={locked || jobRunning}
            onClick={() => setModal({ type: "cleanup" })}
            title={jobRunning ? t("Wait for the running delivery to finish") : t("Delete the stored {media} of {items} whose reference is already live in CMS", { media: t(meta.media), items: t(meta.items) })}
          >
            {t("Free server storage ({size})", { size: formatBytes(releasableBytes) })}
          </Button>
        )}
        {pendingTracks.length > 0 && (
          <Button variant="primary" icon={Send} loading={busy === "deliver"} disabled={locked || jobRunning} onClick={() => setModal({ type: "deliver", trackIds: pendingTracks.map((track) => track.id) })}>
            {pendingTracks.length === 1 ? t("Deliver {count} pending {item}", { count: pendingTracks.length, item: t(meta.item) }) : t("Deliver {count} pending {items}", { count: pendingTracks.length, items: t(meta.items) })}
          </Button>
        )}
        {takedownCount > 0 && (
          <Button variant="danger" icon={Ban} loading={busy === "takedown" && !modal?.track} disabled={locked} onClick={() => setModal({ type: "takedown" })}>
            {t("Takedown")}
          </Button>
        )}
        {takenDownCount > 0 && (
          <Button variant="success" icon={BadgeCheck} loading={busy === "reactivate" && !modal?.track} disabled={locked} onClick={() => setModal({ type: "reactivate" })}>
            {t("Reactivate")}
          </Button>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="ghost" icon={Download} disabled={!tracks.length} onClick={handleExport}>
            {t("Export CSV")}
          </Button>
          <Button variant="ghost" icon={Trash2} disabled={locked} className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setModal({ type: "delete" })}>
            {t("Delete local record")}
          </Button>
        </span>
      </Card>

      <Card
        eyebrow={capitalize(t(meta.items))}
        title={tracks.length === 1 ? t("{count} {item}", { count: tracks.length, item: t(meta.item) }) : t("{count} {items}", { count: tracks.length, items: t(meta.items) })}
        subtitle={t("Each {item} is a {assetType} asset in CMS with its {mediaFile} stored on this server. Select rows to deliver, take down or change rights for a subset.", { item: t(meta.item), assetType: t(assetNoun(product.asset_type)), mediaFile: t(meta.mediaFile) })}
        icon={copy.itemIcon}
        actions={
          selectedTracks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-blue-50 px-3 py-2">
              <span className="text-xs font-black text-blue-700">{t("{count} selected", { count: selectedTracks.length })}</span>
              <Button
                size="sm"
                variant="primary"
                icon={Send}
                disabled={locked || jobRunning || !selectedPending.length}
                onClick={() => setModal({ type: "deliver", trackIds: selectedPending.map((track) => track.id) })}
              >
                {t("Deliver {count}", { count: selectedPending.length })}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={CloudUpload}
                disabled={locked || jobRunning || !selectedReferences.length}
                title={t("Upload the stored {media} of the selected {items} to CMS as references", { media: t(meta.media), items: t(meta.items) })}
                onClick={() => setModal({ type: "references", trackIds: selectedReferences.map((track) => track.id) })}
              >
                {t("Deliver references {count}", { count: selectedReferences.length })}
              </Button>
              <Button size="sm" variant="danger" icon={Ban} disabled={locked || !selectedTakedown.length} onClick={() => setModal({ type: "takedown", selectedOnly: true })}>
                {t("Take down {count}", { count: selectedTakedown.length })}
              </Button>
              <Button size="sm" variant="success" icon={BadgeCheck} disabled={locked || !selectedTakenDown.length} onClick={() => setModal({ type: "reactivate", selectedOnly: true })}>
                {t("Reactivate {count}", { count: selectedTakenDown.length })}
              </Button>
              <Button size="sm" variant="ghost" icon={X} onClick={() => setSelectedIds(new Set())}>
                {t("Clear")}
              </Button>
            </div>
          ) : null
        }
      >
        {tracks.length === 0 ? (
          <EmptyState icon={copy.itemIcon} title={t("No {items}", { items: t(meta.items) })} description={t("This {product} has no {items}. Delete it and create a new {product} from the form.", { product: t(copy.product), items: t(meta.items) })} />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[1420px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-3">
                    <input type="checkbox" className="h-4 w-4 cursor-pointer" checked={allSelected} disabled={locked} onChange={toggleAll} aria-label={t("Select all {items}", { items: t(meta.items) })} />
                  </th>
                  <th className="px-2 py-3">#</th>
                  <th className="px-3 py-3">{capitalize(t(meta.item))}</th>
                  <th className="px-3 py-3">{meta.isrc === "none" ? t("Official URL") : t("ISRC")}</th>
                  <th className="px-3 py-3">{t("Custom ID")}</th>
                  <th className="px-3 py-3">{t("Asset")}</th>
                  <th className="px-3 py-3">{t(copy.mediaHeader)}</th>
                  <th className="px-3 py-3">{t("Reference")}</th>
                  <th className="px-3 py-3">{t("Policy")}</th>
                  <th className="px-3 py-3">{t("Status")}</th>
                  <th className="px-3 py-3 text-right">{t("Actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tracks.map((track) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    product={product}
                    meta={meta}
                    selected={selectedIds.has(track.id)}
                    busy={trackBusy[track.id] || null}
                    audioUpload={audioUploads[track.id] || null}
                    rowError={rowErrors[track.id] || null}
                    playing={playingId === track.id}
                    locked={locked}
                    jobRunning={jobRunning}
                    onToggle={() => toggleTrack(track.id)}
                    onAction={handleRowAction}
                    onAudioFile={(row, file) => startAudioUpload(row, file).catch(() => {})}
                    onAudioDownload={handleAudioDownload}
                    onAudioRemove={(row) => setModal({ type: "audio-remove", track: row })}
                    onAudioCancel={cancelAudioUpload}
                    onAudioDismiss={(row) => removeAudioUpload(row.id)}
                    onTogglePlay={togglePlay}
                    onDeliverReference={handleDeliverReference}
                    onDismissError={(row) => setRowError(row.id, null)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card eyebrow={t("Activity")} title={t("Timeline")} subtitle={t("Recent activity. Open delivery logs for live progress, filters and older history.")} icon={History} tone="slate" actions={<Button variant="secondary" size="sm" icon={History} onClick={() => setModal({ type: "logs" })}>{t("View all logs")}</Button>}>
        <EventsTimeline events={events} tracksById={tracksById} />
      </Card>

      <DeliveryLogViewer productId={product.id} trackId={modal?.track?.id} open={modal?.type === "logs"} tracks={tracks} onClose={() => setModal(null)} />
      <ShortMediaDialog items={shortMedia} onClose={() => setShortMedia([])} />

      {modal?.type === "edit" && <EditProductModal product={product} meta={meta} localLabels={localLabels} onClose={() => setModal(null)} onSubmit={handleUpdateProduct} />}
      {modal?.type === "rights" && (
        <RightsModal
          product={product}
          meta={meta}
          options={productOptions}
          optionsLoading={productOptionsLoading}
          optionsError={productOptionsError}
          reloadOptions={reloadProductOptions}
          selectedIds={selectedIds}
          onClose={() => setModal(null)}
          onSubmit={handleUpdateRights}
        />
      )}
      {modal?.type === "upload" && (
        <UploadAudioModal
          product={product}
          meta={meta}
          tracks={tracks}
          jobRunning={jobRunning}
          onClose={() => setModal(null)}
          onUploadFile={(track, file, uploadOptions) => startAudioUpload(track, file, { ...uploadOptions, quiet: true })}
          onDeliverReferences={(trackIds) => setModal({ type: "references", trackIds })}
          onDeliverPending={(trackIds) => setModal({ type: "deliver", trackIds })}
        />
      )}
      {modal?.type === "deliver" && (
        <DeliverDialog product={product} meta={meta} trackIds={modal.trackIds || []} tracksById={tracksById} loading={busy === "deliver"} onCancel={() => setModal(null)} onConfirm={handleDeliver} />
      )}
      {modal?.type === "references" && (
        <ReferencesDialog product={product} meta={meta} trackIds={modal.trackIds || []} tracksById={tracksById} loading={busy === "references"} onCancel={() => setModal(null)} onConfirm={runReferenceBatch} />
      )}
      {modal?.type === "takedown" && (
        <TakedownDialog
          product={product}
          meta={meta}
          track={modal.track || null}
          selectedCount={selectedTakedown.length}
          defaultSelectedOnly={Boolean(modal.selectedOnly)}
          loading={busy === "takedown"}
          onCancel={() => setModal(null)}
          onConfirm={handleTakedown}
        />
      )}
      {modal?.type === "reactivate" && (
        <ReactivateDialog
          product={product}
          meta={meta}
          track={modal.track || null}
          selectedCount={selectedTakenDown.length}
          defaultSelectedOnly={Boolean(modal.selectedOnly)}
          loading={busy === "reactivate"}
          onCancel={() => setModal(null)}
          onConfirm={handleReactivate}
        />
      )}
      {modal?.type === "audio-remove" && (
        <ConfirmDialog
          open
          tone="danger"
          title={t("Remove {mediaFile}", { mediaFile: t(meta.mediaFile) })}
          confirmLabel={t("Remove file")}
          loading={trackBusy[modal.track.id] === "audio-remove"}
          onCancel={() => setModal(null)}
          onConfirm={() =>
            handleAudioRemove(modal.track)
              .then(() => setModal(null))
              .catch(() => {})
          }
          message={t("«{file}» will be deleted from this server for «{track}». A reference already uploaded to CMS is not affected; you will need to upload the file again to deliver a new reference.", { file: modal.track.file_name || t(meta.media), track: trackLabel(t, modal.track) })}
        />
      )}
      {modal?.type === "cleanup" && (
        <ConfirmDialog
          open
          tone="danger"
          size="md"
          title={t("Free server storage")}
          confirmLabel={releasableTracks.length === 1 ? t("Remove {count} {mediaFile}", { count: releasableTracks.length, mediaFile: t(meta.mediaFile) }) : t("Remove {count} {mediaFile}s", { count: releasableTracks.length, mediaFile: t(meta.mediaFile) })}
          loading={busy === "cleanup"}
          onCancel={() => setModal(null)}
          onConfirm={handleCleanupAudio}
          message={t("The stored {media} of {tracks} ({size}) will be deleted from this server. The references already delivered to YouTube CMS are not affected and the delivery history is kept. {Items} without a live reference keep their file so it can still be delivered.", {
            media: t(meta.media),
            tracks: releasableTracks.length === 1 ? t("{count} delivered {item}", { count: releasableTracks.length, item: t(meta.item) }) : t("{count} delivered {items}", { count: releasableTracks.length, items: t(meta.items) }),
            size: formatBytes(releasableBytes),
            Items: capitalize(t(meta.items))
          })}
        >
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-2xl bg-slate-50 p-3 text-xs font-bold text-slate-600">
            {releasableTracks.map((track) => (
              <li key={track.id} className="flex items-center justify-between gap-3">
                <span className="truncate">{trackLabel(t, track)}</span>
                <span className="truncate font-mono text-slate-400" title={track.file_name || ""}>
                  {track.file_name || track.isrc} · {formatBytes(track.file_size)}
                </span>
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
      {modal?.type === "delete" && (
        <ConfirmDialog
          open
          tone="danger"
          title={t("Delete local record")}
          confirmLabel={t("Delete record")}
          loading={busy === "delete"}
          onCancel={() => setModal(null)}
          onConfirm={handleDelete}
          message={t("«{title}», its {tracks} and the {mediaFile}s stored on this server will be removed from this tool only. Assets and references already created in YouTube CMS are NOT touched — take the {product} down first if you want Content ID to stop matching.", {
            title: product.title,
            tracks: tracks.length === 1 ? t("{count} {item}", { count: tracks.length, item: t(meta.item) }) : t("{count} {items}", { count: tracks.length, items: t(meta.items) }),
            mediaFile: t(meta.mediaFile),
            product: t(copy.product)
          })}
        />
      )}
      {modal?.type === "track-edit" && <TrackEditModal track={modal.track} product={product} meta={meta} options={productOptions} onClose={() => setModal(null)} onSubmit={(payload) => handleUpdateTrack(modal.track, payload)} />}
      {modal?.type === "from-claim" && (
        <FromClaimModal track={modal.track} product={product} onClose={() => setModal(null)} onSubmit={(claimId, contentType) => handleReferenceFromClaim(modal.track, claimId, contentType)} />
      )}
      {modal?.type === "claims" && <ClaimsModal track={modal.track} onClose={() => setModal(null)} />}
      {modal?.type === "details" && <TrackDetailsModal track={tracksById.get(Number(modal.track.id)) || modal.track} product={product} meta={meta} onClose={() => setModal(null)} />}
    </div>
  );
}
