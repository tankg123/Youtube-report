import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ClipboardList,
  ClipboardPaste,
  CloudUpload,
  Disc3,
  ExternalLink,
  Eye,
  FileAudio,
  FolderOpen,
  ImagePlus,
  KeyRound,
  Library,
  ListPlus,
  Loader2,
  Music,
  PackageSearch,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  Wand2,
  X
} from "lucide-react";
import {
  checkDraftAudio,
  createCmsAssetLabel,
  createProduct,
  deleteDraftAudio,
  deliverProduct,
  getAvailableCodes,
  getLegacyProduct,
  getProduct,
  getProductProgress,
  listLegacyProducts,
  uploadDraftAudio,
  uploadTrackAudio
} from "../../api/deliveryApi";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { AUDIO_ACCEPT, GENRES, IMAGE_ACCEPT, REFERENCE_CONTENT_TYPES, STEP_LABELS, STORAGE_KEYS, TRACK_STATUS_META } from "./constants";
import { useDebouncedValue } from "./hooks";
import { createDraftAudioQueue } from "./draftAudioQueue";
import DeliveryLogViewer from "./DeliveryLogViewer";
import { DefinitionList, RunPanel } from "./RunPanel";
import { IDLE_RUN, RUNNING_PHASES } from "./runState";
import {
  Badge,
  Button,
  Card,
  ChipInput,
  ConfirmDialog,
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
  Stepper,
  TerritoryPicker,
  TextArea,
  TextInput,
  Toggle
} from "./shared";
import {
  baseName,
  buildCustomId,
  cleanCode,
  cx,
  formatBytes,
  formatDateTime,
  getErrorMessage,
  guessColumnField,
  isAudioFile,
  isValidUpc,
  makeClientId,
  normalizeIsrc,
  normalizeUpc,
  parseDelimitedText,
  readLocalStorage,
  splitArtists,
  splitList,
  summarizeOwnership,
  titleFromFilename,
  toDateInputValue,
  writeLocalStorage
} from "./utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OTHER_VALUE = "__other__";
const ARTWORK_MAX_EDGE = 512;
const ARTWORK_MAX_BYTES = 400 * 1024;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 30 * 60 * 1000;
const POLL_MAX_ERRORS = 5;
// Consecutive polls with no job registered on the server while tracks are still creating/uploading:
// the job died (server restart) and nothing will finish them — stop polling instead of waiting 30 min.
const POLL_MAX_IDLE = 3;
const ISRC_IN_NAME_RE = /([A-Z]{2})[-_. ]?([A-Z0-9]{3})[-_. ]?(\d{2})[-_. ]?(\d{5})/i;
// Server track statuses that mean the delivery job is still working on the track.
const BUSY_TRACK_STATUSES = ["creating", "uploading"];

const STEPS = [
  { key: "release", label: tk("Release info"), description: tk("Title, artist, UPC, artwork") },
  { key: "rights", label: tk("Rights"), description: tk("Ownership, policy, labels") },
  { key: "tracks", label: tk("Tracks"), description: tk("Audio files, ISRCs, metadata") },
  { key: "deliver", label: tk("Deliver"), description: tk("Push to CMS and store") }
];

const TONE_CLS = {
  slate: "bg-slate-100 text-slate-600",
  blue: "bg-blue-50 text-blue-700",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-600",
  indigo: "bg-indigo-50 text-indigo-700"
};

function withCls(meta) {
  return Object.fromEntries(
    Object.entries(meta || {}).map(([key, entry]) => [key, { ...entry, cls: entry?.cls || TONE_CLS[entry?.tone] || TONE_CLS.slate }])
  );
}

const ROW_STATUS_META = {
  pending: { label: tk("Pending"), cls: TONE_CLS.slate, tone: "slate" },
  creating: { label: tk("Creating asset"), cls: TONE_CLS.blue, tone: "blue", spin: true },
  created: { label: tk("Asset created"), cls: TONE_CLS.blue, tone: "blue" },
  completed: { label: tk("Delivered"), cls: TONE_CLS.emerald, tone: "emerald" },
  error: { label: tk("Error"), cls: TONE_CLS.red, tone: "red" },
  duplicate: { label: tk("Duplicate"), cls: TONE_CLS.amber, tone: "amber" },
  taken_down: { label: tk("Taken down"), cls: TONE_CLS.slate, tone: "slate" },
  ...withCls(TRACK_STATUS_META),
  uploading: { label: tk("Uploading reference"), cls: TONE_CLS.indigo, tone: "indigo", spin: true }
};

const ROW_TINT = {
  completed: "bg-emerald-50",
  created: "bg-blue-50",
  creating: "bg-blue-50",
  uploading: "bg-blue-50",
  duplicate: "bg-amber-50",
  error: "bg-red-50"
};

const REFERENCE_TYPE_OPTIONS = REFERENCE_CONTENT_TYPES.map((value) => ({
  value,
  label: value === "audio" ? tk("Audio (sound recording)") : value === "audiovisual" ? tk("Audiovisual") : tk("Video")
}));

const PASTE_TRACK_FIELDS = [
  { key: "title", label: tk("Title") },
  { key: "artist", label: tk("Artist(s)") },
  { key: "isrc", label: tk("ISRC") },
  { key: "custom_id", label: tk("Custom ID") },
  { key: "filename", label: tk("Audio file name") },
  { key: "track_number", label: tk("Track #") },
  { key: "asset_labels", label: tk("Asset labels") },
  { key: "notes", label: tk("Notes") }
];

const PASTE_ALBUM_FIELDS = [
  { key: "album", label: tk("Album title") },
  { key: "upc", label: tk("UPC") },
  { key: "label", label: tk("Label") },
  { key: "genre", label: tk("Genre") },
  { key: "release_date", label: tk("Release date") }
];

const BULK_FIELDS = [
  { value: "isrc", label: tk("ISRC") },
  { value: "title", label: tk("Title") },
  { value: "artist", label: tk("Artist(s)") },
  { value: "custom_id", label: tk("Custom ID") },
  { value: "notes", label: tk("Notes") }
];

const DEFAULT_RELEASE = {
  title: "",
  artist: "",
  upc: "",
  label: "",
  genre: "",
  release_date: "",
  artwork_name: "",
  artwork_data_url: "",
  artwork_bytes: 0,
  notes: ""
};

const DEFAULT_RIGHTS = {
  ownership: { mode: "worldwide", territories: [] },
  match_policy_id: "",
  match_policy_name: "",
  asset_labels: []
};

// `upload_reference` → `include_reference` on the deliver call: the server uploads the
// stored audio as the Content ID reference right after the asset is created.
const DEFAULT_REFERENCE = { content_type: "audio", urgent: false, upload_reference: true, delete_reference_after_delivery: false };

const RUNTIME_RESET = {
  track_id: null,
  status: "pending",
  step: "",
  error_message: "",
  asset_id: "",
  duplicates: [],
  reference_id: "",
  reference_status: "",
  upload_progress: 0,
  uploading: false, // audio file → server in progress (browser side)
  audio_uploaded: false, // audio file stored on the server during this run
  audio_error: "", // last audio upload failure (kept even after the server job changes the status)
  has_audio: false // server says a file is stored for the track (from the progress payload)
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function text(value) {
  return String(value ?? "").trim();
}

function createRow(overrides = {}) {
  return {
    client_id: makeClientId(),
    title: "",
    artist: "",
    isrc: "",
    custom_id: "",
    custom_id_auto: true,
    notes: "",
    asset_labels: null,
    file_name: "",
    file_size: 0,
    file_hint: "",
    audio_upload_id: "",
    ...RUNTIME_RESET,
    ...overrides
  };
}

function isrcFromFilename(name) {
  const match = String(name || "").match(ISRC_IN_NAME_RE);
  if (!match) return "";
  return normalizeIsrc(match.slice(1).join(""));
}

function dataUrlBytes(dataUrl) {
  const value = String(dataUrl || "");
  const comma = value.indexOf(",");
  const payload = comma >= 0 ? value.slice(comma + 1) : value;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(tk("The selected file is not a readable image")));
    };
    image.src = url;
  });
}

/** Downscale to ≤ 512px and encode as JPEG; lowers quality until the payload fits the 400 KB server limit. */
async function resizeArtwork(file) {
  const image = await loadImage(file);
  const scale = Math.min(1, ARTWORK_MAX_EDGE / Math.max(image.width || 1, image.height || 1));
  const width = Math.max(1, Math.round((image.width || 1) * scale));
  const height = Math.max(1, Math.round((image.height || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(tk("Canvas is not supported in this browser"));
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  let quality = 0.85;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrlBytes(dataUrl) > ARTWORK_MAX_BYTES && quality > 0.4) {
    quality = Math.round((quality - 0.15) * 100) / 100;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  const bytes = dataUrlBytes(dataUrl);
  if (bytes > ARTWORK_MAX_BYTES) throw new Error(tk("Artwork is still larger than 400 KB after resizing — choose a simpler image"));
  return { dataUrl, width, height, bytes };
}

function parseReleaseDateParts(value) {
  const normalized = toDateInputValue(value);
  if (!normalized) return undefined;
  const [year, month, day] = normalized.split("-").map(Number);
  return { year, month, day };
}

/** Mirrors backend buildProductMetadata for the preview modal. */
function buildMetadataPreview(release, row, customId, albumArtist) {
  const metadata = {
    title: text(row.title),
    artist: splitArtists(text(row.artist) || albumArtist),
    album: text(release.title),
    isrc: normalizeIsrc(row.isrc) || cleanCode(row.isrc),
    upc: normalizeUpc(release.upc) || undefined,
    label: text(release.label) || undefined,
    genre: splitList(release.genre),
    releaseDate: parseReleaseDateParts(release.release_date),
    customId: customId || undefined,
    notes: text(row.notes) || text(release.notes) || undefined
  };
  if (!metadata.genre.length) delete metadata.genre;
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function buildOwnershipPreview(ownership, contentOwnerId) {
  const mode = ownership?.mode || "worldwide";
  const territories = Array.isArray(ownership?.territories) ? ownership.territories : [];
  return {
    kind: "youtubePartner#rightsOwnership",
    general: [
      {
        ratio: 100,
        owner: contentOwnerId || "<content owner>",
        type: mode === "include" ? "include" : "exclude",
        territories: mode === "worldwide" ? [] : territories
      }
    ]
  };
}

function draftRow(row) {
  return {
    client_id: row.client_id,
    title: row.title,
    artist: row.artist,
    isrc: row.isrc,
    custom_id: row.custom_id,
    custom_id_auto: row.custom_id_auto,
    notes: row.notes,
    asset_labels: row.asset_labels,
    file_name: row.file_name || row.file_hint || "",
    file_size: row.file_size || 0,
    audio_selected: Boolean(row.file_name),
    audio_upload_id: row.audio_upload_id || ""
  };
}

function draftHasContent(draft) {
  if (!draft || typeof draft !== "object") return false;
  return Boolean(text(draft.release?.title) || text(draft.release?.artist) || (Array.isArray(draft.tracks) && draft.tracks.length));
}

function readDraft() {
  const draft = readLocalStorage(STORAGE_KEYS.draft, null);
  return draftHasContent(draft) ? draft : null;
}

// Maps form rows (client_id) to the stored tracks of the created product. The server echoes
// client_id; ISRC (unique per product) and track number are fallbacks for older responses.
function mapCreatedTracks(createdTracks, payloadTracks) {
  const map = new Map();
  const list = Array.isArray(createdTracks) ? createdTracks : [];
  const byClient = new Map(list.filter((track) => track?.client_id).map((track) => [track.client_id, track]));
  const byIsrc = new Map(list.filter((track) => normalizeIsrc(track?.isrc)).map((track) => [normalizeIsrc(track.isrc), track]));
  const byNumber = new Map(list.filter((track) => Number(track?.track_number) > 0).map((track) => [Number(track.track_number), track]));
  payloadTracks.forEach((item) => {
    const hit = byClient.get(item.client_id) || byIsrc.get(normalizeIsrc(item.isrc)) || byNumber.get(Number(item.track_number));
    if (hit?.id) map.set(item.client_id, hit);
  });
  return map;
}

/** Row patch from one entry of GET /delivery/products/:id/progress → tracks[]. */
function progressPatch(server, row) {
  const hasAudio = Boolean(server?.has_audio);
  return {
    status: server?.status || row.status,
    step: server?.step || "",
    asset_id: server?.asset_id || row.asset_id || "",
    reference_id: server?.reference_id || "",
    reference_status: server?.reference_status || "",
    error_message: server?.error_message || "",
    has_audio: hasAudio,
    audio_uploaded: hasAudio,
    audio_upload_id: "",
    audio_error: hasAudio ? "" : row.audio_error,
    file_name: row.file_name || server?.file_name || "",
    file_size: row.file_size || Number(server?.file_size) || 0
  };
}

function hasStoredAudio(row) {
  return Boolean(row?.has_audio || row?.audio_uploaded || row?.audio_upload_id);
}

// A row rejected by the server (status error / step validate) is editable again as soon as the
// user changes it or a new upload arrives; the marker must not hide "Audio ready" afterwards.
function clearValidationMarker(next, previous) {
  if (previous?.status !== "error" || previous?.step !== "validate") return next;
  return { ...next, status: "pending", step: "", error_message: "" };
}

function stepLabel(step) {
  const key = String(step || "");
  return (STEP_LABELS && STEP_LABELS[key]) || key;
}

/** Badge label / tone for a row, mapping the server status + step to the UI copy of the spec (`t` from useI18n). */
function describeRow(row, t) {
  if (row.uploading) {
    return { label: t("Uploading audio {percent}%", { percent: Math.round(row.upload_progress || 0) }), tone: "indigo", spin: true };
  }
  if (row.audio_error) return { label: t("Audio upload failed"), tone: "red", spin: false };
  if (row.audio_upload_id && row.status === "pending") return { label: t("Audio ready"), tone: "emerald", spin: false };
  switch (row.status) {
    case "creating": {
      const step = row.step || "queued";
      return { label: t(stepLabel(step) || ROW_STATUS_META.creating.label), tone: "blue", spin: true };
    }
    case "uploading":
      return { label: t(stepLabel("reference") || ROW_STATUS_META.uploading.label), tone: "indigo", spin: true };
    case "created":
      return { label: hasStoredAudio(row) ? t(ROW_STATUS_META.created.label) : t("Asset created (no audio)"), tone: "blue", spin: false };
    case "completed":
      return { label: t(ROW_STATUS_META.completed.label), tone: "emerald", spin: false };
    case "duplicate":
      return { label: t(ROW_STATUS_META.duplicate.label), tone: "amber", spin: false };
    case "error":
      return { label: t(ROW_STATUS_META.error.label), tone: "red", spin: false };
    default: {
      const meta = ROW_STATUS_META[row.status] || ROW_STATUS_META.pending;
      return { label: t(meta.label), tone: meta.tone || "slate", spin: Boolean(meta.spin) };
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted) || error?.name === "CanceledError" || error?.name === "AbortError" || error?.code === "ERR_CANCELED";
}

function focusCell(table, row, col) {
  if (!table) return false;
  const target = table.querySelector(`[data-col="${col}"][data-row="${row}"]`);
  if (!target) return false;
  target.focus();
  if (typeof target.select === "function") target.select();
  return true;
}

// ---------------------------------------------------------------------------
// Track row
// ---------------------------------------------------------------------------

const TrackRow = memo(function TrackRow({
  row,
  index,
  total,
  meta,
  albumArtist,
  assetLabelSuggestions,
  locked,
  forcing,
  retrying,
  showCreateAnyway,
  showRetryUpload,
  onUpdate,
  onRemove,
  onMove,
  onAttach,
  onDetach,
  onCellKeyDown,
  onCreateAnyway,
  onRetryUpload
}) {
  const { t, tm } = useI18n();
  const id = row.client_id;
  const issues = meta?.issues || [];
  const invalidIsrc = issues.includes("isrc") || issues.includes("duplicate");
  const displayStatus = row.uploading ? "uploading" : row.status;
  const tint = ROW_TINT[displayStatus] || "";
  const inputsDisabled = locked;
  const badge = describeRow(row, t);
  const stored = hasStoredAudio(row);

  return (
    <tr className={cx("border-t border-slate-100 align-top transition", tint || "hover:bg-slate-50")}>
      <td className="px-2 py-2">
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs font-black text-slate-500">{index + 1}</span>
          <div className="flex flex-col gap-0.5">
            <IconButton icon={ArrowUp} label={t("Move up")} size="sm" tone="ghost" disabled={inputsDisabled || index === 0} onClick={() => onMove(id, -1)} />
            <IconButton icon={ArrowDown} label={t("Move down")} size="sm" tone="ghost" disabled={inputsDisabled || index === total - 1} onClick={() => onMove(id, 1)} />
          </div>
        </div>
      </td>

      <td className="px-2 py-2">
        {row.file_name ? (
          <div className="flex items-start gap-2">
            <span className={cx("mt-0.5 rounded-lg p-1.5", row.audio_error ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700")}>
              <FileAudio size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-black text-slate-800" title={row.file_name}>
                {row.file_name}
              </p>
              <p className="text-[11px] font-bold text-slate-400">
                {stored && !row.uploading ? t("{size} · stored on server", { size: formatBytes(row.file_size) }) : formatBytes(row.file_size)}
              </p>
              {row.uploading && <ProgressBar value={row.upload_progress} size="sm" tone="indigo" className="mt-1.5" label={t("Uploading audio")} />}
              {row.audio_error && !row.uploading && (
                <div className="mt-1 space-y-1">
                  <p className="max-w-[13rem] text-[11px] font-bold text-red-600" title={tm(row.audio_error)}>
                    {row.status === "error" && row.step === "audio" ? t("Upload failed") : t("Upload failed: {message}", { message: tm(row.audio_error) })}
                  </p>
                  {showRetryUpload && (
                    <Button size="sm" variant="secondary" icon={Upload} loading={retrying} onClick={() => onRetryUpload(row)}>
                      {t("Retry upload")}
                    </Button>
                  )}
                  {!inputsDisabled && (
                    <FilePickerButton accept={AUDIO_ACCEPT} icon={Paperclip} size="sm" onFiles={(files) => onAttach(id, files[0])}>
                      {t("Select file again")}
                    </FilePickerButton>
                  )}
                </div>
              )}
              {!inputsDisabled && !row.audio_error && (
                <FilePickerButton accept={AUDIO_ACCEPT} icon={RefreshCw} size="sm" onFiles={(files) => onAttach(id, files[0])}>
                  {t("Replace file")}
                </FilePickerButton>
              )}
            </div>
            {!inputsDisabled && <IconButton icon={X} label={t("Remove audio file")} size="sm" tone="ghost" onClick={() => onDetach(id)} />}
          </div>
        ) : inputsDisabled ? (
          <div className="space-y-1">
            <Badge tone="slate" title={t("No audio file was attached — the asset is created without a reference. Upload the audio later from the product page.")}>
              {t("no audio")}
            </Badge>
            {row.file_hint && (
              <p className="max-w-[12rem] truncate text-[11px] font-bold text-slate-400" title={t("Expected file: {name}", { name: row.file_hint })}>
                {t("Expected: {name}", { name: row.file_hint })}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <FilePickerButton accept={AUDIO_ACCEPT} icon={Paperclip} size="sm" disabled={inputsDisabled} onFiles={(files) => onAttach(id, files[0])}>
              {t("Attach audio")}
            </FilePickerButton>
            {row.file_hint && (
              <p className="max-w-[12rem] truncate text-[11px] font-bold text-slate-400" title={t("Expected file: {name}", { name: row.file_hint })}>
                {t("Expected: {name}", { name: row.file_hint })}
              </p>
            )}
          </div>
        )}
      </td>

      <td className="px-2 py-2">
        <TextInput
          compact
          value={row.title}
          data-col="title"
          data-row={index}
          invalid={issues.includes("title")}
          disabled={inputsDisabled}
          placeholder={t("Track title")}
          onChange={(event) => onUpdate(id, { title: event.target.value })}
          onKeyDown={(event) => onCellKeyDown(event, index, "title")}
        />
      </td>

      <td className="px-2 py-2">
        <TextInput
          compact
          value={row.artist}
          data-col="artist"
          data-row={index}
          invalid={issues.includes("artist")}
          disabled={inputsDisabled}
          placeholder={albumArtist || t("Artist name")}
          title={albumArtist && !row.artist ? t("Defaults to the album artist ({artist})", { artist: albumArtist }) : undefined}
          onChange={(event) => onUpdate(id, { artist: event.target.value })}
          onKeyDown={(event) => onCellKeyDown(event, index, "artist")}
        />
      </td>

      <td className="px-2 py-2">
        <TextInput
          compact
          mono
          value={row.isrc}
          data-col="isrc"
          data-row={index}
          invalid={invalidIsrc}
          disabled={inputsDisabled}
          placeholder={t("USABC2412345")}
          maxLength={12}
          className="uppercase"
          onChange={(event) => onUpdate(id, { isrc: cleanCode(event.target.value).slice(0, 12) })}
          onKeyDown={(event) => onCellKeyDown(event, index, "isrc")}
        />
        {issues.includes("duplicate") && <p className="mt-1 text-[11px] font-bold text-red-600">{t("Duplicate ISRC in this product")}</p>}
      </td>

      <td className="px-2 py-2">
        <div className="flex items-center gap-1">
          <TextInput
            compact
            mono
            value={meta?.customId ?? row.custom_id}
            data-col="custom_id"
            data-row={index}
            disabled={inputsDisabled}
            placeholder="LABEL_ISRC"
            onChange={(event) => onUpdate(id, { custom_id: event.target.value, custom_id_auto: false })}
            onKeyDown={(event) => onCellKeyDown(event, index, "custom_id")}
          />
          <IconButton
            icon={RotateCcw}
            label={row.custom_id_auto ? t("Custom ID is generated from label + ISRC") : t("Regenerate from label + ISRC")}
            size="sm"
            tone={row.custom_id_auto ? "ghost" : "blue"}
            disabled={inputsDisabled || row.custom_id_auto}
            onClick={() => onUpdate(id, { custom_id: "", custom_id_auto: true })}
          />
        </div>
      </td>

      <td className="px-2 py-2">
        <ChipInput
          compact
          values={Array.isArray(row.asset_labels) ? row.asset_labels : []}
          suggestions={assetLabelSuggestions}
          disabled={inputsDisabled}
          placeholder={t("Inherit product labels")}
          onChange={(next) => onUpdate(id, { asset_labels: next.length ? next : null })}
        />
      </td>

      <td className="px-2 py-2">
        <TextInput
          compact
          value={row.notes}
          data-col="notes"
          data-row={index}
          disabled={inputsDisabled}
          placeholder={t("Optional")}
          onChange={(event) => onUpdate(id, { notes: event.target.value })}
          onKeyDown={(event) => onCellKeyDown(event, index, "notes")}
        />
      </td>

      <td className="px-2 py-2">
        <div className="space-y-1">
          <span
            className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide", TONE_CLS[badge.tone] || TONE_CLS.slate)}
            title={row.step && row.status !== "error" ? t("Step: {step}", { step: t(stepLabel(row.step)) }) : undefined}
          >
            {badge.spin && <Loader2 size={11} className="animate-spin" />}
            {badge.label}
          </span>
          {row.asset_id && (
            <p className="font-mono text-[11px] font-bold text-slate-600" title={t("Asset ID")}>
              {row.asset_id}
            </p>
          )}
          {row.reference_id && (
            <p className="font-mono text-[11px] text-slate-400" title={t("Reference ID")}>
              {t("ref {id}", { id: row.reference_id })}
              {row.reference_status ? ` · ${tm(row.reference_status)}` : ""}
            </p>
          )}
          {row.status === "error" && (
            <p className="max-w-[14rem] text-[11px] font-bold text-red-600" title={tm(row.error_message)}>
              {row.step
                ? t("Error at {step}: {message}", { step: t(stepLabel(row.step)), message: tm(row.error_message) || t("Failed") })
                : t("Error: {message}", { message: tm(row.error_message) || t("Failed") })}
            </p>
          )}
          {row.status !== "error" && row.error_message && (
            <p className="max-w-[14rem] text-[11px] font-bold text-amber-700" title={tm(row.error_message)}>
              {row.step ? t("{step}: {message}", { step: t(stepLabel(row.step)), message: tm(row.error_message) }) : tm(row.error_message)}
            </p>
          )}
          {row.status === "duplicate" && (
            <div className="max-w-[14rem] space-y-1">
              <p className="text-[11px] font-bold text-amber-700">{t("Already in CMS:")}</p>
              {(row.duplicates || []).slice(0, 3).map((duplicate) => (
                <p key={duplicate.asset_id || duplicate.id} className="truncate font-mono text-[11px] text-amber-700" title={duplicate.title || ""}>
                  {duplicate.asset_id || duplicate.id}
                  {duplicate.title ? ` · ${duplicate.title}` : ""}
                </p>
              ))}
              {showCreateAnyway && (
                <Button size="sm" variant="secondary" icon={Sparkles} loading={forcing} onClick={() => onCreateAnyway(row)}>
                  {t("Create anyway")}
                </Button>
              )}
            </div>
          )}
        </div>
      </td>

      <td className="px-2 py-2 text-right">
        <IconButton icon={Trash2} label={t("Remove track")} size="sm" tone="red" disabled={inputsDisabled} onClick={() => onRemove(id)} />
      </td>
    </tr>
  );
});

// ---------------------------------------------------------------------------
// ProductForm
// ---------------------------------------------------------------------------

export default function ProductForm({ network, options, optionsLoading, reloadOptions, localLabels, showToast, onCancel, onDelivered }) {
  const { t, tm } = useI18n();
  const steps = useMemo(() => STEPS.map((step) => ({ ...step, label: t(step.label), description: t(step.description) })), [t]);
  const referenceTypeOptions = useMemo(() => REFERENCE_TYPE_OPTIONS.map((option) => ({ ...option, label: t(option.label) })), [t]);
  const bulkFieldOptions = useMemo(() => BULK_FIELDS.map((option) => ({ ...option, label: t(option.label) })), [t]);
  const [release, setRelease] = useState(DEFAULT_RELEASE);
  const [labelOther, setLabelOther] = useState(false);
  const [genreOther, setGenreOther] = useState(false);
  const [rights, setRights] = useState(DEFAULT_RIGHTS);
  const [reference, setReference] = useState(DEFAULT_REFERENCE);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [tracks, setTracks] = useState([]);
  const [pendingDraft, setPendingDraft] = useState(() => readDraft());
  const [serverErrors, setServerErrors] = useState({});
  const [artworkBusy, setArtworkBusy] = useState(false);
  const [upcBusy, setUpcBusy] = useState(false);
  const [isrcBusy, setIsrcBusy] = useState(false);
  const [modal, setModal] = useState(""); // legacy | paste | bulk | preview | confirm | clear | cancel
  const [legacy, setLegacy] = useState({ search: "", items: [], loading: false, loadingId: null, replace: false, error: "" });
  const [paste, setPaste] = useState({ text: "", hasHeader: true, parsed: null });
  const [bulk, setBulk] = useState({ field: "isrc", text: "" });
  const [run, setRun] = useState(IDLE_RUN);
  const [forcingId, setForcingId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);

  const filesRef = useRef(new Map());
  const mountedRef = useRef(false);
  const abortRef = useRef(null);
  const pollTokenRef = useRef(null);
  const legacyTimerRef = useRef(null);
  const legacySeqRef = useRef(0);
  const tableRef = useRef(null);
  const [draftUploads] = useState(() => createDraftAudioQueue({
    upload: uploadDraftAudio,
    remove: deleteDraftAudio,
    errorMessage: getErrorMessage,
    onPatch: (clientId, patch) => {
      if (mountedRef.current) setTracks((current) => current.map((row) => row.client_id === clientId ? clearValidationMarker({ ...row, ...patch }, row) : row));
    }
  }));

  useEffect(() => {
    mountedRef.current = true;
    draftUploads.resume();
    return () => {
      mountedRef.current = false;
      pollTokenRef.current = null;
      if (legacyTimerRef.current) clearTimeout(legacyTimerRef.current);
      if (abortRef.current) abortRef.current.abort();
      draftUploads.dispose();
    };
  }, [draftUploads]);

  // ---------------------------------------------------------------- derived
  const running = RUNNING_PHASES.includes(run.phase);
  const locked = running || Boolean(run.product_id);
  // busy = the run itself or one of the per-row follow-ups (Create anyway / Retry upload).
  const busy = running || Boolean(forcingId) || Boolean(retryingId);
  const albumArtist = text(release.artist);
  const customIdPrefix = text(release.label) || albumArtist || "ANS";
  const policies = Array.isArray(options?.policies) ? options.policies : [];
  const assetLabelSuggestions = useMemo(() => (Array.isArray(options?.asset_labels) ? options.asset_labels : []), [options]);
  const contentOwner = options?.content_owner || null;
  const selectedPolicy = policies.find((policy) => String(policy.id) === String(rights.match_policy_id)) || null;
  const policyName = rights.match_policy_name || selectedPolicy?.name || (rights.match_policy_id ? `Policy ${rights.match_policy_id}` : "");
  const labelList = Array.isArray(localLabels) ? localLabels : [];
  const labelNames = labelList.map((label) => String(label.name || label.display_name || "")).filter(Boolean);
  const labelInList = Boolean(release.label) && labelNames.includes(release.label);
  const showLabelInput = labelOther || (Boolean(release.label) && !labelInList);
  const genreInList = Boolean(release.genre) && GENRES.includes(release.genre);
  const showGenreInput = genreOther || (Boolean(release.genre) && !genreInList);

  const analysis = useMemo(() => {
    const isrcCounts = new Map();
    tracks.forEach((row) => {
      const code = normalizeIsrc(row.isrc);
      if (code) isrcCounts.set(code, (isrcCounts.get(code) || 0) + 1);
    });
    const rows = tracks.map((row, index) => {
      const isrc = normalizeIsrc(row.isrc);
      const issues = [];
      if (!text(row.title)) issues.push("title");
      if (!text(row.artist) && !albumArtist) issues.push("artist");
      if (!isrc) issues.push("isrc");
      else if (isrcCounts.get(isrc) > 1) issues.push("duplicate");
      const customId = row.custom_id_auto ? buildCustomId(customIdPrefix, isrc || cleanCode(row.isrc)) : text(row.custom_id);
      return { client_id: row.client_id, index, issues, hasFile: hasStoredAudio(row), customId };
    });
    const byId = new Map(rows.map((row) => [row.client_id, row]));
    const counts = {
      total: tracks.length,
      withAudio: rows.filter((row) => row.hasFile).length,
      missingTitle: rows.filter((row) => row.issues.includes("title")).length,
      missingArtist: rows.filter((row) => row.issues.includes("artist")).length,
      invalidIsrc: rows.filter((row) => row.issues.includes("isrc")).length,
      duplicateIsrc: rows.filter((row) => row.issues.includes("duplicate")).length,
      invalid: rows.filter((row) => row.issues.length).length
    };
    return { rows, byId, counts };
  }, [tracks, albumArtist, customIdPrefix]);

  const releaseErrors = useMemo(() => {
    const errors = {};
    if (!text(release.title)) errors.title = t("Release title is required.");
    if (!text(release.artist)) errors.artist = t("Album artist is required.");
    if (text(release.upc) && !isValidUpc(release.upc)) errors.upc = t("UPC must be 8–14 digits.");
    return errors;
  }, [release, t]);

  const rightsErrors = useMemo(() => {
    const errors = {};
    if (!text(rights.match_policy_id)) errors.policy = t("Choose the match policy applied to every asset.");
    if (rights.ownership.mode === "include" && !rights.ownership.territories.length) errors.ownership = t("Select at least one territory to include.");
    return errors;
  }, [rights, t]);

  const releaseDone = Object.keys(releaseErrors).length === 0;
  const rightsDone = Object.keys(rightsErrors).length === 0;
  const tracksDone = tracks.length > 0 && analysis.counts.invalid === 0;
  const formValid = Boolean(network?.id) && releaseDone && rightsDone && tracksDone;
  const pendingAudio = tracks.filter((row) => row.uploading).length;
  const failedAudio = tracks.filter((row) => row.audio_error || (row.file_name && !row.uploading && !hasStoredAudio(row))).length;
  const audioReady = pendingAudio === 0 && failedAudio === 0;
  const canDeliver = formValid && audioReady && !locked;
  const hasContent = Boolean(text(release.title) || text(release.artist) || tracks.length);

  const doneSteps = useMemo(() => {
    const done = [];
    if (releaseDone) done.push("release");
    if (rightsDone) done.push("rights");
    if (tracksDone) done.push("tracks");
    if (run.phase === "done") done.push("deliver");
    return done;
  }, [releaseDone, rightsDone, tracksDone, run.phase]);
  const activeStep = STEPS.find((step) => !doneSteps.includes(step.key))?.key || "deliver";

  const runCounts = useMemo(
    () => ({
      created: tracks.filter((row) => row.asset_id).length,
      completed: tracks.filter((row) => row.status === "completed").length,
      duplicates: tracks.filter((row) => row.status === "duplicate").length,
      errors: tracks.filter((row) => row.status === "error").length,
      storedAudio: tracks.filter((row) => hasStoredAudio(row)).length
    }),
    [tracks]
  );

  // Server job progress (rows that exist on the server): busy = creating/uploading, finished = everything else.
  const jobProgress = useMemo(() => {
    const stored = tracks.filter((row) => row.track_id);
    const busy = stored.filter((row) => BUSY_TRACK_STATUSES.includes(row.status)).length;
    const pending = stored.filter((row) => row.status === "pending").length;
    return { total: stored.length, busy, finished: stored.length - busy - pending };
  }, [tracks]);

  const includeReference = reference.upload_reference !== false;

  const summaryLine = useMemo(() => {
    const trackCount = tracks.length;
    const cms = network?.name || t("not selected");
    const audioCount = analysis.counts.withAudio;
    const parts = [
      trackCount === 1 ? t("{count} track → CMS «{cms}»", { count: trackCount, cms }) : t("{count} tracks → CMS «{cms}»", { count: trackCount, cms }),
      summarizeOwnership(rights.ownership.mode, rights.ownership.territories),
      policyName || t("No match policy"),
      includeReference
        ? audioCount === 1
          ? t("{count} audio file → references delivered by the server", { count: audioCount })
          : t("{count} audio files → references delivered by the server", { count: audioCount })
        : audioCount === 1
          ? t("{count} audio file stored (references off)", { count: audioCount })
          : t("{count} audio files stored (references off)", { count: audioCount })
    ];
    return parts.join(" · ");
  }, [tracks.length, network, rights.ownership, policyName, analysis.counts.withAudio, includeReference, t]);

  // ---------------------------------------------------------------- draft autosave
  const draftSnapshot = useMemo(
    () => ({
      release,
      rights,
      reference,
      options: { skip_duplicates: skipDuplicates },
      tracks: tracks.map(draftRow)
    }),
    [release, rights, reference, skipDuplicates, tracks]
  );
  const debouncedDraft = useDebouncedValue(draftSnapshot, 500);

  // The restore banner is only offered while the form is pristine; typing anything hides it
  // and the autosave below starts persisting the new content (superseding the stored draft).
  const showDraftBanner = Boolean(pendingDraft) && !hasContent && !locked;
  const draftTrackCount = Array.isArray(pendingDraft?.tracks) ? pendingDraft.tracks.length : 0;

  useEffect(() => {
    if (locked) return;
    if (draftHasContent(debouncedDraft)) {
      writeLocalStorage(STORAGE_KEYS.draft, { ...debouncedDraft, saved_at: new Date().toISOString() });
    } else if (!pendingDraft) {
      // Never wipe a stored draft the user has neither restored nor discarded.
      writeLocalStorage(STORAGE_KEYS.draft, null);
    }
  }, [debouncedDraft, pendingDraft, locked]);

  function restoreDraft() {
    const draft = pendingDraft;
    if (!draft || hasContent) return;
    setRelease({ ...DEFAULT_RELEASE, ...(draft.release || {}) });
    setRights({
      ...DEFAULT_RIGHTS,
      ...(draft.rights || {}),
      ownership: {
        mode: draft.rights?.ownership?.mode || "worldwide",
        territories: Array.isArray(draft.rights?.ownership?.territories) ? draft.rights.ownership.territories : []
      },
      asset_labels: Array.isArray(draft.rights?.asset_labels) ? draft.rights.asset_labels : []
    });
    setReference({
      content_type: REFERENCE_CONTENT_TYPES.includes(draft.reference?.content_type) ? draft.reference.content_type : "audio",
      urgent: Boolean(draft.reference?.urgent),
      upload_reference: draft.reference?.upload_reference !== false,
      delete_reference_after_delivery: Boolean(draft.reference?.delete_reference_after_delivery)
    });
    setSkipDuplicates(draft.options?.skip_duplicates !== false);
    const rows = (Array.isArray(draft.tracks) ? draft.tracks : []).map((item) =>
      createRow({
        client_id: item.client_id || makeClientId(),
        title: text(item.title),
        artist: text(item.artist),
        isrc: cleanCode(item.isrc).slice(0, 12),
        custom_id: text(item.custom_id),
        custom_id_auto: item.custom_id_auto !== false,
        notes: text(item.notes),
        asset_labels: Array.isArray(item.asset_labels) && item.asset_labels.length ? item.asset_labels : null,
        file_hint: text(item.file_name),
        file_name: item.audio_selected || item.audio_upload_id ? text(item.file_name) : "",
        file_size: Number(item.file_size) || 0,
        audio_upload_id: text(item.audio_upload_id),
        audio_error: !item.audio_upload_id && item.audio_selected ? tk("Select this file again to finish uploading.") : ""
      })
    );
    filesRef.current.clear();
    rows.forEach((row) => { if (row.audio_upload_id) draftUploads.restore(row.client_id, row.audio_upload_id); });
    setTracks(rows);
    setPendingDraft(null);
    showToast?.(rows.some((row) => row.audio_error) ? t("Draft restored — select unfinished audio files again") : t("Draft restored with uploaded audio"), "info");
    verifyRestoredUploads(rows);
  }

  /** Uploads stored with a draft expire on the server after a while; flag the rows whose file is gone. */
  function verifyRestoredUploads(rows) {
    const tokens = rows.map((row) => row.audio_upload_id).filter(Boolean);
    if (!tokens.length) return;
    checkDraftAudio(tokens)
      .then((data) => {
        if (!mountedRef.current) return;
        const missing = new Set((Array.isArray(data?.missing) ? data.missing : []).map(String));
        if (!missing.size) return;
        rows.forEach((row) => {
          // Token-aware: a file the user re-selected meanwhile keeps its own upload running.
          if (missing.has(row.audio_upload_id)) draftUploads.forgetToken(row.client_id, row.audio_upload_id);
        });
        setTracks((current) =>
          current.map((row) =>
            missing.has(row.audio_upload_id)
              ? { ...row, audio_upload_id: "", has_audio: false, audio_uploaded: false, upload_progress: 0, audio_error: tk("The uploaded file expired on the server. Select this file again.") }
              : row
          )
        );
        showToast?.(
          missing.size === 1
            ? t("{count} uploaded audio file expired on the server — select it again", { count: missing.size })
            : t("{count} uploaded audio files expired on the server — select them again", { count: missing.size }),
          "warning"
        );
      })
      .catch(() => {
        // The server rejects unknown uploads when the product is saved; the row error will say so.
      });
  }

  /** Files the server could not attach when the product was created (rare: moved/removed on disk). */
  function applyAudioErrors(created, tracksByClient) {
    const audioErrors = Array.isArray(created?.audio_errors) ? created.audio_errors : [];
    if (!audioErrors.length) return;
    const byTrack = new Map(audioErrors.map((item) => [Number(item.track_id), String(item.message || tk("The uploaded audio could not be attached"))]));
    const clientIds = new Set();
    tracksByClient.forEach((server, clientId) => {
      if (byTrack.has(Number(server.id))) clientIds.add(clientId);
    });
    setTracks((current) =>
      current.map((row) => {
        const server = tracksByClient.get(row.client_id);
        if (!server || !byTrack.has(Number(server.id))) return row;
        return { ...row, audio_upload_id: "", has_audio: false, audio_uploaded: false, audio_error: byTrack.get(Number(server.id)) };
      })
    );
    const count = clientIds.size || audioErrors.length;
    showToast?.(
      count === 1
        ? audioErrors.length === 1
          ? t("{count} audio file could not be attached to the product — upload it again from the product page", { count })
          : t("{count} audio file could not be attached to the product — upload them again from the product page", { count })
        : audioErrors.length === 1
          ? t("{count} audio files could not be attached to the product — upload it again from the product page", { count })
          : t("{count} audio files could not be attached to the product — upload them again from the product page", { count }),
      "warning"
    );
  }

  function discardDraft() {
    (pendingDraft?.tracks || []).forEach((row) => {
      if (row.audio_upload_id) deleteDraftAudio(row.audio_upload_id).catch(() => {});
    });
    writeLocalStorage(STORAGE_KEYS.draft, null);
    setPendingDraft(null);
  }

  // ---------------------------------------------------------------- release helpers
  function patchRelease(patch) {
    setRelease((current) => ({ ...current, ...patch }));
  }

  function handleLabelSelect(value) {
    if (value === OTHER_VALUE) {
      setLabelOther(true);
      if (labelInList) patchRelease({ label: "" });
      return;
    }
    setLabelOther(false);
    patchRelease({ label: value });
  }

  function handleGenreSelect(value) {
    if (value === OTHER_VALUE) {
      setGenreOther(true);
      if (genreInList) patchRelease({ genre: "" });
      return;
    }
    setGenreOther(false);
    patchRelease({ genre: value });
  }

  async function handleArtwork(files) {
    const file = files?.[0];
    if (!file) return;
    setArtworkBusy(true);
    try {
      const result = await resizeArtwork(file);
      if (!mountedRef.current) return;
      patchRelease({ artwork_name: file.name, artwork_data_url: result.dataUrl, artwork_bytes: result.bytes });
      showToast?.(t("Artwork resized to {width}×{height} ({size})", { width: result.width, height: result.height, size: formatBytes(result.bytes) }), "success");
    } catch (error) {
      showToast?.(tm(getErrorMessage(error)), "error");
    } finally {
      if (mountedRef.current) setArtworkBusy(false);
    }
  }

  function removeArtwork() {
    patchRelease({ artwork_name: "", artwork_data_url: "", artwork_bytes: 0 });
  }

  async function fetchUpcFromLibrary() {
    setUpcBusy(true);
    try {
      const data = await getAvailableCodes("UPC", 1);
      const code = normalizeUpc((data?.codes || [])[0]);
      if (!code) throw new Error(tk("No unused UPC codes are available in the library"));
      if (!mountedRef.current) return;
      patchRelease({ upc: code });
      showToast?.(t("UPC {code} taken from the library", { code }), "success");
    } catch (error) {
      showToast?.(tm(getErrorMessage(error)), "error");
    } finally {
      if (mountedRef.current) setUpcBusy(false);
    }
  }

  // ---------------------------------------------------------------- rights helpers
  function handlePolicyChange(id, policy) {
    const resolved = policy || policies.find((item) => String(item.id) === String(id)) || null;
    setRights((current) => ({ ...current, match_policy_id: id, match_policy_name: resolved?.name || (id ? `Policy ${id}` : "") }));
  }

  async function handleCreateLabel(labelName) {
    if (!network?.id) throw new Error(tk("Select a CMS first"));
    const data = await createCmsAssetLabel(network.id, labelName);
    const created = data?.label?.labelName || labelName;
    try {
      await reloadOptions?.();
    } catch {
      // The label exists on CMS even if the option reload failed.
    }
    showToast?.(t("Asset label «{label}» created in CMS", { label: created }), "success");
    return created;
  }

  // ---------------------------------------------------------------- track helpers
  const updateRow = useCallback((clientId, patch) => {
    setTracks((current) =>
      current.map((row) => (row.client_id !== clientId ? row : clearValidationMarker({ ...row, ...(typeof patch === "function" ? patch(row) : patch) }, row)))
    );
  }, []);

  const removeRow = useCallback((clientId) => {
    draftUploads.forget(clientId);
    filesRef.current.delete(clientId);
    setTracks((current) => current.filter((row) => row.client_id !== clientId));
  }, [draftUploads]);

  const moveRow = useCallback((clientId, direction) => {
    setTracks((current) => {
      const index = current.findIndex((row) => row.client_id === clientId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const attachFile = useCallback(
    (clientId, file) => {
      if (!file) return;
      if (!isAudioFile(file.name)) {
        showToast?.(t("«{name}» is not a supported audio file", { name: file.name }), "warning");
        return;
      }
      filesRef.current.set(clientId, file);
      updateRow(clientId, (row) => ({
        file_name: file.name,
        file_size: file.size,
        title: row.title || titleFromFilename(file.name),
        isrc: row.isrc || isrcFromFilename(file.name)
      }));
      draftUploads.enqueue(clientId, file);
    },
    [showToast, updateRow, draftUploads, t]
  );

  const detachFile = useCallback(
    (clientId) => {
      draftUploads.forget(clientId);
      filesRef.current.delete(clientId);
      updateRow(clientId, { file_name: "", file_hint: "", file_size: 0, audio_upload_id: "", has_audio: false, audio_uploaded: false, uploading: false, upload_progress: 0, audio_error: "" });
    },
    [updateRow, draftUploads]
  );

  const handleCellKeyDown = useCallback((event, index, col) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    focusCell(tableRef.current, index + 1, col);
  }, []);

  function addRow() {
    const row = createRow();
    setTracks((current) => [...current, row]);
  }

  function addAudioFiles(files) {
    const audio = (files || [])
      .filter((file) => isAudioFile(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    if (!audio.length) {
      showToast?.(t("No supported audio files were selected"), "warning");
      return;
    }
    const claimed = new Set();
    const patches = new Map();
    const additions = [];
    const uploads = [];
    const candidates = tracks.filter((row) => !row.file_name);

    audio.forEach((file) => {
      const name = baseName(file.name);
      const isrc = isrcFromFilename(name);
      const title = titleFromFilename(name).toLowerCase();
      const free = candidates.filter((row) => !claimed.has(row.client_id));
      // ISRC in the file name wins, then the expected file name, then the title, then an empty row.
      const target =
        (isrc && free.find((row) => normalizeIsrc(row.isrc) === isrc)) ||
        free.find((row) => row.file_hint && baseName(row.file_hint).toLowerCase() === name.toLowerCase()) ||
        (title && free.find((row) => text(row.title).toLowerCase() === title)) ||
        free.find((row) => !text(row.title) && !text(row.isrc));
      if (target) {
        claimed.add(target.client_id);
        filesRef.current.set(target.client_id, file);
        uploads.push({ clientId: target.client_id, file });
        patches.set(target.client_id, {
          file_name: name,
          file_size: file.size,
          title: target.title || titleFromFilename(name),
          isrc: target.isrc || isrc
        });
      } else {
        const row = createRow({ file_name: name, file_size: file.size, title: titleFromFilename(name), isrc });
        filesRef.current.set(row.client_id, file);
        uploads.push({ clientId: row.client_id, file });
        additions.push(row);
      }
    });

    setTracks((current) => [...current.map((row) => (patches.has(row.client_id) ? { ...row, ...patches.get(row.client_id) } : row)), ...additions]);
    uploads.forEach(({ clientId, file }) => draftUploads.enqueue(clientId, file));
    const matched = patches.size;
    showToast?.(
      matched
        ? t("Added {count} audio file(s) — {matched} matched existing row(s)", { count: audio.length, matched })
        : audio.length === 1
          ? t("Added {count} audio file", { count: audio.length })
          : t("Added {count} audio files", { count: audio.length }),
      "success"
    );
  }

  function clearTracks() {
    draftUploads.clear();
    filesRef.current.clear();
    setTracks([]);
    setModal("");
  }

  async function fillIsrcFromLibrary() {
    const targets = tracks.filter((row) => !normalizeIsrc(row.isrc));
    if (!targets.length) {
      showToast?.(t("Every track already has an ISRC"), "info");
      return;
    }
    setIsrcBusy(true);
    try {
      const data = await getAvailableCodes("ISRC", targets.length);
      const used = new Set(tracks.map((row) => normalizeIsrc(row.isrc)).filter(Boolean));
      const fresh = (data?.codes || []).map(normalizeIsrc).filter((code) => code && !used.has(code));
      if (!fresh.length) throw new Error(tk("No unused ISRC codes are available in the library"));
      const assignment = new Map();
      targets.forEach((row, index) => {
        if (fresh[index]) assignment.set(row.client_id, fresh[index]);
      });
      if (!mountedRef.current) return;
      setTracks((current) => current.map((row) => (assignment.has(row.client_id) ? { ...row, isrc: assignment.get(row.client_id) } : row)));
      const missing = targets.length - assignment.size;
      showToast?.(
        missing
          ? t("Assigned {count} ISRC(s) — {missing} track(s) still need one", { count: assignment.size, missing })
          : assignment.size === 1
            ? t("Assigned {count} ISRC from the library", { count: assignment.size })
            : t("Assigned {count} ISRCs from the library", { count: assignment.size }),
        missing ? "warning" : "success"
      );
    } catch (error) {
      showToast?.(tm(getErrorMessage(error)), "error");
    } finally {
      if (mountedRef.current) setIsrcBusy(false);
    }
  }

  // ---------------------------------------------------------------- legacy product import
  const loadLegacy = useCallback(async (term) => {
    // Sequence counter: only the newest request may write the list (a slow earlier
    // response must not overwrite the results of a later search).
    legacySeqRef.current += 1;
    const seq = legacySeqRef.current;
    setLegacy((current) => ({ ...current, loading: true, error: "" }));
    try {
      const data = await listLegacyProducts(term);
      if (!mountedRef.current || legacySeqRef.current !== seq) return;
      setLegacy((current) => ({ ...current, items: Array.isArray(data?.products) ? data.products : [], loading: false }));
    } catch (error) {
      if (!mountedRef.current || legacySeqRef.current !== seq) return;
      setLegacy((current) => ({ ...current, loading: false, error: getErrorMessage(error) }));
    }
  }, []);

  function openLegacyModal() {
    setLegacy((current) => ({ ...current, replace: tracks.length > 0 }));
    setModal("legacy");
    loadLegacy(legacy.search);
  }

  function closeLegacyModal() {
    if (legacyTimerRef.current) {
      clearTimeout(legacyTimerRef.current);
      legacyTimerRef.current = null;
    }
    setModal("");
  }

  function handleLegacySearch(value) {
    setLegacy((current) => ({ ...current, search: value }));
    if (legacyTimerRef.current) clearTimeout(legacyTimerRef.current);
    legacyTimerRef.current = setTimeout(() => loadLegacy(value), 300);
  }

  async function importLegacyProduct(productId) {
    setLegacy((current) => ({ ...current, loadingId: productId }));
    try {
      const data = await getLegacyProduct(productId);
      const product = data?.product;
      if (!product) throw new Error(tk("Product not found"));
      const sourceTracks = (Array.isArray(product.tracks) ? product.tracks : [])
        .slice()
        .sort((a, b) => (Number(a.track_number) || 0) - (Number(b.track_number) || 0));
      const rows = sourceTracks.map((track) =>
        createRow({
          title: text(track.song_title || track.title),
          artist: text(track.artist),
          isrc: normalizeIsrc(track.isrc) || cleanCode(track.isrc).slice(0, 12),
          custom_id: text(track.custom_id),
          custom_id_auto: !text(track.custom_id),
          file_hint: text(track.filename)
        })
      );
      if (!mountedRef.current) return;
      setRelease((current) => ({
        ...current,
        title: text(product.album_title) || current.title,
        artist: text(product.album_artist) || current.artist,
        upc: normalizeUpc(product.album_upc) || cleanCode(product.album_upc) || current.upc,
        label: text(product.label) || current.label,
        genre: text(product.genre) || current.genre,
        release_date: toDateInputValue(product.release_date) || current.release_date
      }));
      if (legacy.replace) {
        draftUploads.clear();
        filesRef.current.clear();
        setTracks(rows);
      } else {
        setTracks((current) => [...current, ...rows]);
      }
      closeLegacyModal();
      showToast?.(
        rows.length === 1
          ? t("Imported {count} track from «{album}» — attach the audio files to deliver references", { count: rows.length, album: product.album_title || t("product") })
          : t("Imported {count} tracks from «{album}» — attach the audio files to deliver references", { count: rows.length, album: product.album_title || t("product") }),
        "success"
      );
    } catch (error) {
      showToast?.(tm(getErrorMessage(error)), "error");
    } finally {
      if (mountedRef.current) setLegacy((current) => ({ ...current, loadingId: null }));
    }
  }

  // ---------------------------------------------------------------- paste table
  function openPasteModal() {
    setPaste({ text: "", hasHeader: true, parsed: null });
    setModal("paste");
  }

  function parsePaste() {
    const parsed = parseDelimitedText(paste.text);
    let headers = parsed.headers;
    let records = parsed.rows;
    if (!paste.hasHeader) {
      const width = parsed.matrix.reduce((max, cells) => Math.max(max, cells.length), 0);
      headers = Array.from({ length: width }, (_, index) => t("Column {number}", { number: index + 1 }));
      records = parsed.matrix.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
    }
    const mapping = {};
    const albumMapping = {};
    if (paste.hasHeader) {
      headers.forEach((header) => {
        const field = guessColumnField(header);
        if (!field) return;
        if (PASTE_TRACK_FIELDS.some((item) => item.key === field) && !mapping[field]) mapping[field] = header;
        else if (PASTE_ALBUM_FIELDS.some((item) => item.key === field) && !albumMapping[field]) albumMapping[field] = header;
      });
    }
    setPaste((current) => ({ ...current, parsed: { headers, records, mapping, albumMapping } }));
  }

  function updatePasteMapping(group, key, header) {
    setPaste((current) => {
      if (!current.parsed) return current;
      const target = group === "album" ? "albumMapping" : "mapping";
      return { ...current, parsed: { ...current.parsed, [target]: { ...current.parsed[target], [key]: header } } };
    });
  }

  function importPaste() {
    const parsed = paste.parsed;
    if (!parsed) return;
    const { records, mapping, albumMapping } = parsed;
    const pick = (record, key) => (mapping[key] ? text(record[mapping[key]]) : "");
    const prepared = records
      .map((record, index) => {
        const title = pick(record, "title");
        const isrcRaw = pick(record, "isrc");
        const filename = pick(record, "filename");
        if (!title && !isrcRaw && !filename) return null;
        const customId = pick(record, "custom_id");
        const labels = splitList(pick(record, "asset_labels"));
        return {
          order: Number(pick(record, "track_number")) || index + 1,
          row: createRow({
            title: title || titleFromFilename(filename),
            artist: pick(record, "artist"),
            isrc: normalizeIsrc(isrcRaw) || cleanCode(isrcRaw).slice(0, 12),
            custom_id: customId,
            custom_id_auto: !customId,
            notes: pick(record, "notes"),
            asset_labels: labels.length ? labels : null,
            file_hint: filename
          })
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.order - b.order)
      .map((item) => item.row);
    if (!prepared.length) {
      showToast?.(t("No rows with a title, ISRC or file name were found in the pasted table"), "warning");
      return;
    }
    const first = records[0] || {};
    const album = (key) => (albumMapping[key] ? text(first[albumMapping[key]]) : "");
    setRelease((current) => ({
      ...current,
      title: current.title || album("album"),
      upc: current.upc || normalizeUpc(album("upc")),
      label: current.label || album("label"),
      genre: current.genre || album("genre"),
      release_date: current.release_date || toDateInputValue(album("release_date"))
    }));
    setTracks((current) => [...current, ...prepared]);
    setModal("");
    setPaste({ text: "", hasHeader: true, parsed: null });
    showToast?.(
      prepared.length === 1 ? t("Imported {count} track from the pasted table", { count: prepared.length }) : t("Imported {count} tracks from the pasted table", { count: prepared.length }),
      "success"
    );
  }

  // ---------------------------------------------------------------- bulk paste
  function applyBulk() {
    const lines = bulk.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return;
    const field = bulk.field;
    const normalizeLine = field === "isrc" ? (value) => normalizeIsrc(value) || cleanCode(value).slice(0, 12) : (value) => value;
    const extra = field === "custom_id" ? { custom_id_auto: false } : {};
    const additions = lines.slice(tracks.length).map((line) => createRow({ [field]: normalizeLine(line), ...extra }));
    setTracks((current) => [
      ...current.map((row, index) => (index < lines.length ? { ...row, [field]: normalizeLine(lines[index]), ...extra } : row)),
      ...additions
    ]);
    setModal("");
    setBulk((current) => ({ ...current, text: "" }));
    showToast?.(t("Applied {count} value(s) to the {column} column", { count: lines.length, column: t(BULK_FIELDS.find((item) => item.value === field)?.label || field) }), "success");
  }

  // ---------------------------------------------------------------- payload + run
  function buildPayload() {
    return {
      network_id: network?.id,
      product: {
        title: text(release.title),
        artist: text(release.artist),
        upc: normalizeUpc(release.upc) || "",
        label: text(release.label),
        genre: text(release.genre),
        release_date: toDateInputValue(release.release_date) || "",
        artwork_name: release.artwork_name || "",
        artwork_data_url: release.artwork_data_url || "",
        notes: text(release.notes)
      },
      rights: {
        ownership: { mode: rights.ownership.mode, territories: rights.ownership.mode === "worldwide" ? [] : rights.ownership.territories },
        match_policy_id: text(rights.match_policy_id),
        match_policy_name: policyName,
        asset_labels: rights.asset_labels
      },
      reference: { content_type: reference.content_type, urgent: Boolean(reference.urgent), include_reference: reference.upload_reference !== false },
      options: { skip_duplicates: Boolean(skipDuplicates), delete_reference_after_delivery: Boolean(reference.delete_reference_after_delivery) },
      tracks: tracks.map((row, index) => ({
        client_id: row.client_id,
        track_number: index + 1,
        title: text(row.title),
        artist: text(row.artist) || albumArtist,
        isrc: normalizeIsrc(row.isrc),
        custom_id: analysis.byId.get(row.client_id)?.customId || "",
        notes: text(row.notes),
        asset_labels: Array.isArray(row.asset_labels) && row.asset_labels.length ? row.asset_labels : null,
        file_name: row.file_name || row.file_hint || "",
        file_size: row.file_size || 0,
        audio_upload_id: row.audio_upload_id || undefined
      }))
    };
  }

  function applyCreateErrors(error) {
    const data = error?.response?.data;
    const fieldErrors = data?.field_errors && typeof data.field_errors === "object" ? data.field_errors : {};
    const rowIds = new Set(tracks.map((row) => row.client_id));
    const rowErrors = new Map();
    const formErrors = {};
    Object.entries(fieldErrors).forEach(([key, value]) => {
      if (rowIds.has(key)) rowErrors.set(key, String(value));
      else formErrors[key] = String(value);
    });
    if (rowErrors.size) {
      setTracks((current) =>
        current.map((row) => (rowErrors.has(row.client_id) ? { ...row, status: "error", step: "validate", error_message: rowErrors.get(row.client_id) } : row))
      );
      // A rejected row may hold an upload the server no longer knows (expired, or claimed by
      // another tab); drop such tokens so the row asks for the file again instead of resubmitting them.
      verifyRestoredUploads(tracks.filter((row) => rowErrors.has(row.client_id) && row.audio_upload_id));
    }
    setServerErrors(formErrors);
  }

  function bumpUploads(key) {
    setRun((current) => ({ ...current, uploads: { ...current.uploads, [key]: current.uploads[key] + 1 } }));
  }

  /** Uploads one audio file to the server (PUT /delivery/tracks/:id/audio). Resolves true when stored. */
  async function uploadAudioOne(item, signal) {
    updateRow(item.client_id, { uploading: true, upload_progress: 0, audio_error: "" });
    try {
      const data = await uploadTrackAudio(item.track_id, item.file, {
        signal,
        onProgress: (percent) => {
          if (mountedRef.current) updateRow(item.client_id, { upload_progress: percent });
        }
      });
      if (!mountedRef.current) return false;
      const track = data?.track || {};
      updateRow(item.client_id, (row) => ({
        uploading: false,
        upload_progress: 100,
        audio_uploaded: true,
        has_audio: true,
        audio_error: "",
        // A previous failed attempt left the row in error/audio; clear that local marker.
        status: row.status === "error" && row.step === "audio" ? "pending" : row.status,
        step: row.status === "error" && row.step === "audio" ? "" : row.step,
        error_message: row.status === "error" && row.step === "audio" ? "" : row.error_message,
        file_name: track.file_name || item.file.name,
        file_size: Number(track.file_size) || item.file.size
      }));
      bumpUploads("done");
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;
      if (isAbortError(error, signal)) {
        updateRow(item.client_id, { uploading: false, upload_progress: 0 });
        bumpUploads("skipped");
        return false;
      }
      const message = getErrorMessage(error);
      updateRow(item.client_id, { uploading: false, upload_progress: 0, status: "error", step: "audio", error_message: message, audio_error: message });
      bumpUploads("failed");
      return false;
    }
  }

  /** Applies one GET /delivery/products/:id/progress payload to the rows (matched by track id). */
  function applyProgress(data) {
    const serverTracks = Array.isArray(data?.tracks) ? data.tracks : [];
    if (!serverTracks.length) return;
    const byId = new Map(serverTracks.map((track) => [Number(track.id), track]));
    setTracks((current) =>
      current.map((row) => {
        const server = row.track_id ? byId.get(Number(row.track_id)) : null;
        return server && !row.uploading ? { ...row, ...progressPatch(server, row) } : row;
      })
    );
  }

  /**
   * Polls the progress endpoint every 2 s until the server job is idle and no track is
   * creating/uploading. Outcomes: finished | interrupted (job gone, tracks still in flight) |
   * timeout (30 min) | lost (5 failed polls) | cancelled.
   */
  async function pollJob(productId) {
    const token = {};
    pollTokenRef.current = token;
    const alive = () => mountedRef.current && pollTokenRef.current === token;
    const startedAt = Date.now();
    let failures = 0;
    let idlePolls = 0;
    while (alive()) {
      let data;
      try {
        data = await getProductProgress(productId);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (!alive()) return { outcome: "cancelled" };
        if (failures >= POLL_MAX_ERRORS) return { outcome: "lost", message: getErrorMessage(error) };
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (!alive()) return { outcome: "cancelled" };
      applyProgress(data);
      const serverTracks = Array.isArray(data?.tracks) ? data.tracks : [];
      const jobRunning = Boolean(data?.job?.running);
      const tracksInFlight = serverTracks.some((track) => BUSY_TRACK_STATUSES.includes(track.status));
      if (!jobRunning && !tracksInFlight) return { outcome: "finished", data };
      idlePolls = jobRunning ? 0 : idlePolls + 1;
      if (idlePolls >= POLL_MAX_IDLE) return { outcome: "interrupted", data };
      if (Date.now() - startedAt >= POLL_MAX_MS) return { outcome: "timeout", data };
      await sleep(POLL_INTERVAL_MS);
    }
    return { outcome: "cancelled" };
  }

  /** The progress payload carries no duplicate matches; fetch them once for the "Already in CMS" list. */
  async function loadDuplicateDetails(productId) {
    try {
      const data = await getProduct(productId);
      if (!mountedRef.current) return;
      const list = Array.isArray(data?.product?.tracks) ? data.product.tracks : [];
      const byId = new Map(list.map((track) => [Number(track.id), track]));
      setTracks((current) =>
        current.map((row) => {
          const server = row.track_id ? byId.get(Number(row.track_id)) : null;
          if (!server || row.status !== "duplicate") return row;
          return { ...row, duplicates: Array.isArray(server.duplicates) ? server.duplicates : row.duplicates };
        })
      );
    } catch {
      // Cosmetic only — the product page lists the matches.
    }
  }

  /** POST /deliver (202) then poll until idle. Returns the poll outcome, or null when unmounted/cancelled. */
  async function runServerJob(productId, options) {
    setRun((current) => ({ ...current, phase: "delivering", stopping: false, timed_out: false, poll_error: "", job_started: true }));
    const data = await deliverProduct(productId, { delete_reference_after_delivery: Boolean(reference.delete_reference_after_delivery), ...options });
    if (!mountedRef.current) return null;
    const queued = new Set((Array.isArray(data?.job?.track_ids) ? data.job.track_ids : []).map(Number));
    if (queued.size) {
      setTracks((current) =>
        current.map((row) => (row.track_id && queued.has(Number(row.track_id)) ? { ...row, status: "creating", step: "queued", error_message: "" } : row))
      );
    }
    const outcome = await pollJob(productId);
    if (!mountedRef.current || outcome.outcome === "cancelled") return null;
    if ((outcome.data?.tracks || []).some((track) => track.status === "duplicate")) {
      await loadDuplicateDetails(productId);
      if (!mountedRef.current) return null;
    }
    return outcome;
  }

  function finishRun(outcome) {
    const serverTracks = Array.isArray(outcome?.data?.tracks) ? outcome.data.tracks : [];
    const errors = serverTracks.filter((track) => track.status === "error").length;
    const interrupted = outcome?.outcome === "interrupted";
    setRun((current) => ({
      ...current,
      phase: "done",
      stopping: false,
      timed_out: outcome?.outcome === "timeout",
      interrupted,
      poll_error: outcome?.outcome === "lost" ? outcome.message || tk("network error") : "",
      failed: current.failed || errors > 0 || interrupted,
      message: errors
        ? errors === 1
          ? t("{count} track failed on CMS — retry them from the product page.", { count: errors })
          : t("{count} tracks failed on CMS — retry them from the product page.", { count: errors })
        : ""
    }));
  }

  function toastOutcome(outcome, finishedMessage, finishedTone) {
    if (outcome.outcome === "finished") showToast?.(finishedMessage, finishedTone);
    else if (outcome.outcome === "interrupted") showToast?.(t("The delivery was interrupted on the server — open the product page and sync from CMS"), "warning");
    else showToast?.(t("Delivery is still running on the server — follow it on the product page"), "warning");
  }

  /** deliver + poll + final summary, with the failure handling shared by every entry point. */
  async function deliverAndFollow(productId, options, failureLabel = tk("Delivery")) {
    try {
      const outcome = await runServerJob(productId, options);
      if (!outcome) return;
      finishRun(outcome);
      const errors = (outcome.data?.tracks || []).filter((track) => track.status === "error").length;
      toastOutcome(outcome, errors ? t("Delivery finished with errors") : t("Delivery finished"), errors ? "warning" : "success");
    } catch (error) {
      if (!mountedRef.current) return;
      const message = getErrorMessage(error);
      if (error?.response?.status !== 409) {
        setTracks((current) =>
          current.map((row) => (row.track_id && (row.status === "pending" || (row.status === "creating" && row.step === "queued")) ? { ...row, status: "error", step: "deliver", error_message: message } : row))
        );
      }
      setRun((current) => ({
        ...current,
        phase: "done",
        failed: true,
        stopping: false,
        message: t("{label} could not be started: {message}. The product is stored — continue from the product page.", { label: t(failureLabel), message: tm(message) })
      }));
      showToast?.(tm(message), "error");
    }
  }

  async function saveAsDraft() {
    if (!canDeliver) return;
    setServerErrors({});
    setRun({ ...IDLE_RUN, phase: "creating", mode: "draft" });
    try {
      const payload = buildPayload();
      const data = await createProduct(payload);
      draftUploads.consume();
      const productId = data?.product?.id;
      writeLocalStorage(STORAGE_KEYS.draft, null);
      const audioErrors = Array.isArray(data?.audio_errors) ? data.audio_errors : [];
      showToast?.(
        audioErrors.length
          ? audioErrors.length === 1
            ? t("Product saved as a draft, but {count} audio file could not be attached — upload it from the product page", { count: audioErrors.length })
            : t("Product saved as a draft, but {count} audio files could not be attached — upload them from the product page", { count: audioErrors.length })
          : t("Product saved as a draft"),
        audioErrors.length ? "warning" : "success"
      );
      if (mountedRef.current) {
        setPendingDraft(null);
        setRun({ ...IDLE_RUN, phase: "done", mode: "draft", product_id: productId });
      }
      onDelivered?.(productId);
    } catch (error) {
      if (!mountedRef.current) return;
      applyCreateErrors(error);
      setRun({ ...IDLE_RUN, phase: "failed", mode: "draft", message: getErrorMessage(error) });
      showToast?.(tm(getErrorMessage(error)), "error");
    }
  }

  async function startDelivery() {
    setModal("");
    if (!canDeliver) return;
    setServerErrors({});
    setRun({ ...IDLE_RUN, phase: "creating", mode: "deliver", uploads: { total: analysis.counts.withAudio, done: analysis.counts.withAudio, failed: 0, skipped: 0 } });
    const payload = buildPayload();

    // Attach completed staged uploads atomically with the product and track data.
    let created;
    try {
      created = await createProduct(payload);
    } catch (error) {
      if (!mountedRef.current) return;
      applyCreateErrors(error);
      setRun({ ...IDLE_RUN, phase: "failed", mode: "deliver", message: getErrorMessage(error) });
      showToast?.(tm(getErrorMessage(error)), "error");
      return;
    }
    draftUploads.consume();
    writeLocalStorage(STORAGE_KEYS.draft, null);
    if (!mountedRef.current) return;
    setPendingDraft(null);
    const productId = created?.product?.id;
    const tracksByClient = mapCreatedTracks(created?.product?.tracks, payload.tracks);
    setTracks((current) => current.map((row) => {
      const server = tracksByClient.get(row.client_id);
      return server ? { ...row, ...progressPatch(server, row), track_id: server.id } : row;
    }));
    applyAudioErrors(created, tracksByClient);
    setRun((current) => ({ ...current, product_id: productId }));

    // The server can start CMS delivery immediately; all selected audio is stored.
    await deliverAndFollow(productId, { include_reference: includeReference });
  }

  function stopUploads() {
    if (abortRef.current) abortRef.current.abort();
    setRun((current) => ({ ...current, stopping: true }));
  }

  /** After "Stop": deliver with whatever audio is already stored. */
  async function deliverNow() {
    if (!run.product_id || busy) return;
    await deliverAndFollow(run.product_id, { include_reference: includeReference });
  }

  async function createAnyway(row) {
    if (!run.product_id || !row.track_id || busy) return;
    setForcingId(row.client_id);
    updateRow(row.client_id, { status: "creating", step: "queued", error_message: "" });
    try {
      const outcome = await runServerJob(run.product_id, { track_ids: [row.track_id], force_duplicates: true, include_reference: includeReference });
      if (!outcome) return;
      finishRun(outcome);
      const server = (outcome.data?.tracks || []).find((track) => Number(track.id) === Number(row.track_id));
      if (outcome.outcome !== "finished") toastOutcome(outcome);
      else if (server?.status === "error") showToast?.(tm(server.error_message) || t("The track failed on CMS"), "error");
      else if (server?.status === "completed") showToast?.(t("Asset created and reference delivered"), "success");
      else if (server?.asset_id) showToast?.(t("Asset created on CMS"), "success");
      else showToast?.(t("Track is {status}", { status: server?.status ? tm(server.status) : t("unchanged") }), "warning");
    } catch (error) {
      if (!mountedRef.current) return;
      const message = getErrorMessage(error);
      // Keep the row a duplicate so "Create anyway" stays available; the message shows under the badge.
      updateRow(row.client_id, { status: "duplicate", step: "", error_message: message });
      setRun((current) => ({ ...current, phase: "done", stopping: false }));
      showToast?.(tm(message), "error");
    } finally {
      if (mountedRef.current) setForcingId(null);
    }
  }

  /** Retry a failed audio upload; when the asset already exists, the server then delivers the reference. */
  async function retryUpload(row) {
    if (!run.product_id) {
      const file = filesRef.current.get(row.client_id);
      if (file && !row.uploading) draftUploads.enqueue(row.client_id, file);
      else showToast?.(t("Select the audio file again to finish uploading"), "info");
      return;
    }
    if (!run.product_id || !row.track_id || busy) return;
    const file = filesRef.current.get(row.client_id);
    if (!file) {
      showToast?.(t("The audio file is no longer attached — upload it from the product page"), "warning");
      return;
    }
    setRetryingId(row.client_id);
    const controller = new AbortController();
    abortRef.current = controller;
    setRun((current) => ({ ...current, uploads: { ...current.uploads, failed: Math.max(0, current.uploads.failed - 1) } }));
    const stored = await uploadAudioOne({ client_id: row.client_id, track_id: row.track_id, file }, controller.signal);
    abortRef.current = null;
    if (!mountedRef.current) return;
    setRetryingId(null);
    if (!stored) return;
    if (row.asset_id && includeReference && !row.reference_id) {
      showToast?.(t("Audio stored — the server is delivering the reference"), "success");
      await deliverAndFollow(run.product_id, { track_ids: [row.track_id], include_reference: true }, tk("Reference delivery"));
    } else {
      showToast?.(row.asset_id ? t("Audio stored on the server") : t("Audio stored — the track is delivered with the product"), "success");
    }
  }

  function openProduct() {
    writeLocalStorage(STORAGE_KEYS.draft, null);
    setPendingDraft(null);
    onDelivered?.(run.product_id);
  }

  function handleCancel() {
    // Saving and uploading need this tab; once the server job runs the user may leave.
    if (run.phase === "creating" || run.phase === "uploading") return;
    if (!locked && hasContent) {
      setModal("cancel");
      return;
    }
    writeLocalStorage(STORAGE_KEYS.draft, null);
    setPendingDraft(null);
    onCancel?.();
  }

  function confirmCancel() {
    draftUploads.clear();
    setModal("");
    writeLocalStorage(STORAGE_KEYS.draft, null);
    setPendingDraft(null);
    onCancel?.();
  }

  // ---------------------------------------------------------------- preview plan
  const previewPlan = useMemo(() => {
    if (modal !== "preview") return null;
    const row = tracks[0];
    if (!row) return null;
    const customId = analysis.byId.get(row.client_id)?.customId || "";
    const labels = Array.isArray(row.asset_labels) && row.asset_labels.length ? row.asset_labels : rights.asset_labels;
    return {
      asset: {
        kind: "youtubePartner#asset",
        type: "sound_recording",
        metadataMine: buildMetadataPreview(release, row, customId, albumArtist),
        label: labels
      },
      ownership: buildOwnershipPreview(rights.ownership, contentOwner?.id || network?.network_code),
      matchPolicy: { kind: "youtubePartner#assetMatchPolicy", policyId: text(rights.match_policy_id), name: policyName },
      reference: {
        contentType: reference.content_type,
        urgent: Boolean(reference.urgent),
        deliverAutomatically: reference.upload_reference !== false,
        file: row.file_name || null
      },
      options: { skip_duplicates: Boolean(skipDuplicates), delete_reference_after_delivery: Boolean(reference.delete_reference_after_delivery) }
    };
  }, [modal, tracks, analysis, rights, release, albumArtist, contentOwner, network, policyName, reference, skipDuplicates]);

  const unknownServerErrors = Object.entries(serverErrors).filter(
    ([key]) => !["title", "artist", "upc", "match_policy_id", "artwork_data_url", "tracks", "network_id", "release_date"].includes(key)
  );

  const labelOptions = [
    ...labelList.map((label) => ({ value: String(label.name || label.display_name), label: label.display_name || label.name })),
    { value: OTHER_VALUE, label: t("Other…") }
  ];
  const genreOptions = [...GENRES.map((genre) => ({ value: genre, label: genre })), { value: OTHER_VALUE, label: t("Other…") }];
  const inputsDisabled = locked;
  const showRunPanel = run.mode === "deliver" && run.phase !== "idle";
  const showFieldErrors = hasContent;

  let readinessHint;
  if (locked) {
    readinessHint = run.product_id ? t("Product #{id} is stored. Open it to manage assets, references and takedowns.", { id: run.product_id }) : t("Working…");
  } else if (!network?.id) {
    readinessHint = t("Select a CMS to enable delivery.");
  } else if (pendingAudio) {
    readinessHint = pendingAudio === 1
      ? t("Uploading {count} audio file — saving and delivery unlock when uploads finish.", { count: pendingAudio })
      : t("Uploading {count} audio files — saving and delivery unlock when uploads finish.", { count: pendingAudio });
  } else if (failedAudio) {
    readinessHint = failedAudio === 1
      ? t("Fix or remove {count} unfinished audio upload before saving or delivering.", { count: failedAudio })
      : t("Fix or remove {count} unfinished audio uploads before saving or delivering.", { count: failedAudio });
  } else if (formValid) {
    readinessHint = t("Everything is valid — deliver when ready.");
  } else {
    const todo = [
      !releaseDone && t("complete the release info"),
      !rightsDone && t("choose the rights"),
      !tracksDone && (tracks.length ? t("fix the highlighted tracks") : t("add at least one track"))
    ]
      .filter(Boolean)
      .join(", ");
    readinessHint = `${todo.charAt(0).toUpperCase()}${todo.slice(1)}.`;
  }

  // ---------------------------------------------------------------- render
  return (
    <div className="space-y-5 pb-28">
      {/* Stepper */}
      <Card
        actions={
          <Button variant="ghost" size="sm" icon={X} onClick={handleCancel} disabled={run.phase === "creating" || run.phase === "uploading"}>
            {locked ? t("Back to products") : t("Cancel")}
          </Button>
        }
        title={t("New product")}
        subtitle={t("Fill in the release, choose the rights, add the tracks, then deliver straight to CMS.")}
      >
        <Stepper steps={steps} active={activeStep} done={doneSteps} />
      </Card>

      {!network?.id && (
        <InlineMessage tone="warning" title={t("No CMS selected")}>
          {t("Choose a connected CMS in the header before delivering. You can still prepare the product.")}
        </InlineMessage>
      )}

      {showDraftBanner && (
        <InlineMessage
          tone="info"
          icon={ClipboardList}
          title={t("Restore the unsaved draft?")}
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={discardDraft}>
                {t("Discard")}
              </Button>
              <Button size="sm" variant="primary" icon={RotateCcw} onClick={restoreDraft}>
                {t("Restore draft")}
              </Button>
            </>
          }
        >
          «{text(pendingDraft.release?.title) || t("Untitled release")}» · {draftTrackCount === 1 ? t("{count} track", { count: draftTrackCount }) : t("{count} tracks", { count: draftTrackCount })}
          {pendingDraft.saved_at ? ` · ${t("saved {date}", { date: formatDateTime(pendingDraft.saved_at) })}` : ""}. {t("Completed audio uploads are restored with the draft; unfinished uploads need the file selected again.")}
        </InlineMessage>
      )}

      {unknownServerErrors.length > 0 && (
        <InlineMessage tone="error" title={t("The server rejected the product")}>
          {unknownServerErrors.map(([key, message]) => (
            <p key={key}>
              <span className="font-mono text-xs">{key}</span>: {tm(message)}
            </p>
          ))}
        </InlineMessage>
      )}

      {showRunPanel && (
        <RunPanel
          run={run}
          counts={runCounts}
          job={jobProgress}
          includeReference={includeReference}
          onStop={stopUploads}
          onOpen={openProduct}
          onDismiss={() => setRun(IDLE_RUN)}
          onDeliverNow={busy ? null : deliverNow}
        />
      )}

      {/* Release info */}
      <Card eyebrow={t("Step 1")} icon={Disc3} title={t("Release info")} subtitle={t("Album-level metadata written into every Sound Recording asset (album, UPC, label, release date).")}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t("Release title")} required htmlFor="pf-title" error={tm(serverErrors.title) || (showFieldErrors ? releaseErrors.title : undefined)} hint={t("Album / single / EP name as it should appear in CMS.")}>
              <TextInput id="pf-title" value={release.title} disabled={inputsDisabled} placeholder={t("e.g. Midnight Sessions")} onChange={(event) => patchRelease({ title: event.target.value })} />
            </Field>
            <Field label={t("Album artist")} required htmlFor="pf-artist" error={tm(serverErrors.artist) || (showFieldErrors ? releaseErrors.artist : undefined)} hint={t("Default artist for every track. Separate several artists with commas.")}>
              <TextInput id="pf-artist" value={release.artist} disabled={inputsDisabled} placeholder={t("e.g. Lena Park")} onChange={(event) => patchRelease({ artist: event.target.value })} />
            </Field>
            <Field
              label="UPC"
              htmlFor="pf-upc"
              error={releaseErrors.upc || tm(serverErrors.upc)}
              hint={t("Optional. 8–14 digits; stored on each asset and used to find the product later.")}
              actions={
                <Button size="sm" variant="ghost" icon={Library} loading={upcBusy} disabled={inputsDisabled} onClick={fetchUpcFromLibrary}>
                  {t("Get UPC from library")}
                </Button>
              }
            >
              <TextInput
                id="pf-upc"
                mono
                value={release.upc}
                disabled={inputsDisabled}
                invalid={Boolean(releaseErrors.upc)}
                placeholder="0000000000000"
                maxLength={14}
                onChange={(event) => patchRelease({ upc: cleanCode(event.target.value).slice(0, 14) })}
              />
            </Field>
            <Field label={t("Release date")} htmlFor="pf-date" error={tm(serverErrors.release_date)} hint={t("Written as releaseDate on each asset.")}>
              <TextInput id="pf-date" type="date" value={release.release_date} disabled={inputsDisabled} onChange={(event) => patchRelease({ release_date: event.target.value })} />
            </Field>
            <Field label={t("Label")} htmlFor="pf-label" hint={t("Record label. Also used as the prefix of generated custom IDs.")}>
              <div className="space-y-2">
                <Select
                  id="pf-label"
                  value={labelInList ? release.label : showLabelInput ? OTHER_VALUE : ""}
                  disabled={inputsDisabled}
                  placeholder={t("Select a label")}
                  options={labelOptions}
                  onChange={(event) => handleLabelSelect(event.target.value)}
                />
                {showLabelInput && (
                  <TextInput value={release.label} disabled={inputsDisabled} placeholder={t("Type the label name")} onChange={(event) => patchRelease({ label: event.target.value })} />
                )}
              </div>
            </Field>
            <Field label={t("Genre")} htmlFor="pf-genre" hint={t("Optional. Several genres can be comma separated in the free-text box.")}>
              <div className="space-y-2">
                <Select
                  id="pf-genre"
                  value={genreInList ? release.genre : showGenreInput ? OTHER_VALUE : ""}
                  disabled={inputsDisabled}
                  placeholder={t("Select a genre")}
                  options={genreOptions}
                  onChange={(event) => handleGenreSelect(event.target.value)}
                />
                {showGenreInput && <TextInput value={release.genre} disabled={inputsDisabled} placeholder={t("e.g. Pop, Ballad")} onChange={(event) => patchRelease({ genre: event.target.value })} />}
              </div>
            </Field>
            <Field label={t("Notes")} htmlFor="pf-notes" className="md:col-span-2" hint={t("Internal notes written to every asset unless a track has its own notes.")}>
              <TextArea id="pf-notes" rows={3} value={release.notes} disabled={inputsDisabled} placeholder={t("Optional")} onChange={(event) => patchRelease({ notes: event.target.value })} />
            </Field>
          </div>

          <Field label={t("Artwork")} hint={t("Resized to 512px JPEG and stored with the product (not sent to CMS).")} error={tm(serverErrors.artwork_data_url)}>
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3">
              {release.artwork_data_url ? (
                <div className="space-y-2">
                  <img src={release.artwork_data_url} alt={t("Artwork preview")} className="aspect-square w-full rounded-xl object-cover" />
                  <p className="truncate text-xs font-bold text-slate-700" title={release.artwork_name}>
                    {release.artwork_name || "artwork.jpg"}
                  </p>
                  <p className="text-[11px] font-bold text-slate-400">{formatBytes(release.artwork_bytes || dataUrlBytes(release.artwork_data_url))}</p>
                  <div className="flex flex-wrap gap-2">
                    <FilePickerButton accept={IMAGE_ACCEPT} icon={ImagePlus} size="sm" loading={artworkBusy} disabled={inputsDisabled} onFiles={handleArtwork}>
                      {t("Replace")}
                    </FilePickerButton>
                    <Button size="sm" variant="danger" icon={Trash2} disabled={inputsDisabled} onClick={removeArtwork}>
                      {t("Remove")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 py-4 text-center">
                  <span className="rounded-2xl bg-white p-3 text-slate-400 shadow-sm">
                    <ImagePlus size={22} />
                  </span>
                  <p className="text-xs font-bold text-slate-500">{t("JPG or PNG, any size")}</p>
                  <FilePickerButton accept={IMAGE_ACCEPT} icon={ImagePlus} size="sm" loading={artworkBusy} disabled={inputsDisabled} onFiles={handleArtwork}>
                    {t("Choose image")}
                  </FilePickerButton>
                </div>
              )}
            </div>
          </Field>
        </div>
      </Card>

      {/* Rights */}
      <Card eyebrow={t("Step 2")} icon={ShieldCheck} title={t("Rights")} subtitle={t("Ownership, match policy and asset labels applied to every asset in this product.")}>
        <div className="grid gap-5 lg:grid-cols-2">
          <Field label={t("Ownership")} required hint={t("100% owned by this content owner. Worldwide sends an empty exclude list.")}>
            <TerritoryPicker mode={rights.ownership.mode} territories={rights.ownership.territories} disabled={inputsDisabled} onChange={(next) => setRights((current) => ({ ...current, ownership: next }))} />
          </Field>
          <Field label={t("Match policy")} required error={tm(serverErrors.match_policy_id) || (showFieldErrors ? rightsErrors.policy : undefined)} hint={t("Saved policies come from CMS. The policy is applied as the asset match policy.")}>
            <PolicySelect
              policies={policies}
              value={rights.match_policy_id}
              loading={optionsLoading}
              error={tm(options?.errors?.policies) || ""}
              disabled={inputsDisabled}
              onChange={handlePolicyChange}
            />
          </Field>
          <Field label={t("Asset labels")} hint={t("Optional. Applied to every track unless a track overrides them. Type a new name to create it in CMS.")} error={tm(options?.errors?.asset_labels) || undefined}>
            <ChipInput
              values={rights.asset_labels}
              suggestions={assetLabelSuggestions}
              disabled={inputsDisabled}
              allowCreate
              onCreate={handleCreateLabel}
              placeholder={t("Add asset labels…")}
              onChange={(next) => setRights((current) => ({ ...current, asset_labels: next }))}
            />
          </Field>
          <div className="grid gap-4">
            <Field label={t("Reference settings")} hint={t("Audio files upload as soon as you select them and stay linked to their track when the product is saved.")}>
              <div className="space-y-3">
                <Toggle
                  checked={includeReference}
                  disabled={inputsDisabled}
                  label={t("Deliver audio reference automatically")}
                  description={t("Right after each asset is created, from the audio stored on the server. Off = assets only; deliver references later from the product page.")}
                  onChange={(value) => setReference((current) => ({ ...current, upload_reference: value }))}
                />
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <Select value={reference.content_type} disabled={inputsDisabled} options={referenceTypeOptions} onChange={(event) => setReference((current) => ({ ...current, content_type: event.target.value }))} />
                  <Toggle checked={reference.urgent} disabled={inputsDisabled} label={t("Urgent")} description={t("Prioritise fingerprinting")} onChange={(value) => setReference((current) => ({ ...current, urgent: value }))} />
                </div>
                <Toggle
                  checked={reference.delete_reference_after_delivery}
                  disabled={inputsDisabled}
                  label={t("Delete server audio after successful delivery")}
                  description={t("Free server storage after the reference is delivered successfully. CMS references and delivery history are kept; failed uploads keep their audio for retry.")}
                  onChange={(value) => setReference((current) => ({ ...current, delete_reference_after_delivery: value }))}
                />
              </div>
            </Field>
            <Field label={t("Duplicates")}>
              <Toggle
                checked={skipDuplicates}
                disabled={inputsDisabled}
                label={t("Skip ISRCs that already exist in CMS")}
                description={t("Matching assets are reported as duplicates; you can still create them one by one.")}
                onChange={setSkipDuplicates}
              />
            </Field>
          </div>
        </div>
      </Card>

      {/* Tracks */}
      <Card
        eyebrow={t("Step 3")}
        icon={Music}
        title={t("Tracks")}
        subtitle={t("One Sound Recording asset per track. Select or drop audio files to upload immediately; each file is saved with its matching track.")}
        actions={
          <>
            <FilePickerButton accept={AUDIO_ACCEPT} multiple icon={FileAudio} size="sm" disabled={inputsDisabled} onFiles={addAudioFiles}>
              {t("Choose audio files")}
            </FilePickerButton>
            <FilePickerButton directory icon={FolderOpen} size="sm" disabled={inputsDisabled} onFiles={addAudioFiles}>
              {t("Choose folder")}
            </FilePickerButton>
            <Button variant="secondary" size="sm" icon={Plus} disabled={inputsDisabled} onClick={addRow}>
              {t("Add row")}
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" icon={PackageSearch} disabled={inputsDisabled} onClick={openLegacyModal}>
            {t("Import from Product Manager")}
          </Button>
          <Button variant="secondary" size="sm" icon={ClipboardPaste} disabled={inputsDisabled} onClick={openPasteModal}>
            {t("Paste table")}
          </Button>
          <Button variant="secondary" size="sm" icon={KeyRound} loading={isrcBusy} disabled={inputsDisabled || !tracks.length} onClick={fillIsrcFromLibrary}>
            {t("Fill ISRC from library")}
          </Button>
          <Button variant="secondary" size="sm" icon={ListPlus} disabled={inputsDisabled} onClick={() => setModal("bulk")}>
            {t("Bulk paste")}
          </Button>
          <Button variant="ghost" size="sm" icon={Trash2} disabled={inputsDisabled || !tracks.length} onClick={() => setModal("clear")}>
            {t("Clear")}
          </Button>
        </div>

        {tracks.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge tone="slate" icon={Music}>
              {analysis.counts.total === 1 ? t("{count} track", { count: analysis.counts.total }) : t("{count} tracks", { count: analysis.counts.total })}
            </Badge>
            <Badge tone={analysis.counts.withAudio === analysis.counts.total ? "emerald" : "amber"} icon={FileAudio}>
              {t("{count} with audio", { count: analysis.counts.withAudio })}
            </Badge>
            {analysis.counts.missingTitle > 0 && <Badge tone="red">{t("{count} missing title", { count: analysis.counts.missingTitle })}</Badge>}
            {analysis.counts.missingArtist > 0 && <Badge tone="red">{t("{count} missing artist", { count: analysis.counts.missingArtist })}</Badge>}
            {analysis.counts.invalidIsrc > 0 && <Badge tone="red">{t("{count} invalid ISRC", { count: analysis.counts.invalidIsrc })}</Badge>}
            {analysis.counts.duplicateIsrc > 0 && <Badge tone="red">{t("{count} duplicate ISRC", { count: analysis.counts.duplicateIsrc })}</Badge>}
            {analysis.counts.invalid === 0 && (
              <Badge tone="emerald" icon={CheckCircle2}>
                {t("Ready")}
              </Badge>
            )}
            <span className="ml-auto text-xs font-bold text-slate-400">{t("Press Enter in a cell to jump to the next row.")}</span>
          </div>
        )}

        {serverErrors.tracks && (
          <InlineMessage tone="error" className="mt-4">
            {tm(serverErrors.tracks)}
          </InlineMessage>
        )}

        <div className="mt-4">
          {tracks.length === 0 ? (
            <EmptyState
              icon={Music}
              title={t("No tracks yet")}
              description={t("Choose the audio files of the release, import a product from Product Manager, paste a table from your spreadsheet or add rows by hand.")}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <FilePickerButton accept={AUDIO_ACCEPT} multiple icon={FileAudio} variant="primary" disabled={inputsDisabled} onFiles={addAudioFiles}>
                    {t("Choose audio files")}
                  </FilePickerButton>
                  <Button variant="secondary" icon={Plus} disabled={inputsDisabled} onClick={addRow}>
                    {t("Add row")}
                  </Button>
                </div>
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <table ref={tableRef} className="w-full min-w-[1480px] text-left text-sm">
                <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-14 px-2 py-2.5">#</th>
                    <th className="w-56 px-2 py-2.5">{t("Audio file")}</th>
                    <th className="w-52 px-2 py-2.5">
                      {t("Title")} <span className="text-red-500">*</span>
                    </th>
                    <th className="w-44 px-2 py-2.5">
                      {t("Artist(s)")} <span className="text-red-500">*</span>
                    </th>
                    <th className="w-40 px-2 py-2.5">
                      ISRC <span className="text-red-500">*</span>
                    </th>
                    <th className="w-56 px-2 py-2.5">{t("Custom ID")}</th>
                    <th className="w-52 px-2 py-2.5">{t("Asset labels override")}</th>
                    <th className="w-40 px-2 py-2.5">{t("Notes")}</th>
                    <th className="w-48 px-2 py-2.5">{t("Status")}</th>
                    <th className="w-12 px-2 py-2.5" aria-label={t("Remove")} />
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((row, index) => (
                    <TrackRow
                      key={row.client_id}
                      row={row}
                      index={index}
                      total={tracks.length}
                      meta={analysis.byId.get(row.client_id)}
                      albumArtist={albumArtist}
                      assetLabelSuggestions={assetLabelSuggestions}
                      locked={inputsDisabled}
                      forcing={forcingId === row.client_id}
                      retrying={retryingId === row.client_id}
                      showCreateAnyway={Boolean(run.product_id) && !busy && row.status === "duplicate"}
                      showRetryUpload={!run.product_id ? Boolean(filesRef.current.get(row.client_id)) : Boolean(row.track_id) && (!busy || retryingId === row.client_id)}
                      onUpdate={updateRow}
                      onRemove={removeRow}
                      onMove={moveRow}
                      onAttach={attachFile}
                      onDetach={detachFile}
                      onCellKeyDown={handleCellKeyDown}
                      onCreateAnyway={createAnyway}
                      onRetryUpload={retryUpload}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Sticky deliver bar */}
      <div className="sticky bottom-4 z-20">
        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-xl">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-black text-slate-900" title={summaryLine}>
                {summaryLine}
              </p>
              <p className="mt-0.5 text-xs font-bold text-slate-400">{readinessHint}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {run.product_id && (
                <Button variant="secondary" icon={ClipboardList} onClick={() => setModal("logs")}>
                  {t("View logs")}
                </Button>
              )}
              {run.product_id && (run.phase === "done" || run.phase === "delivering") ? (
                <Button variant="primary" icon={ExternalLink} onClick={openProduct}>
                  {t("Open product")}
                </Button>
              ) : (
                <>
                  <Button variant="secondary" icon={Save} disabled={!canDeliver} loading={run.phase === "creating" && run.mode === "draft"} onClick={saveAsDraft}>
                    {t("Save as draft")}
                  </Button>
                  <Button variant="secondary" icon={Eye} disabled={!tracks.length} onClick={() => setModal("preview")}>
                    {t("Preview plan")}
                  </Button>
                  <Button variant="primary" icon={CloudUpload} disabled={!canDeliver} loading={running && run.mode === "deliver"} onClick={() => setModal("confirm")}>
                    {t("Deliver to CMS")}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Confirm delivery */}
      <ConfirmDialog
        open={modal === "confirm"}
        title={t("Deliver this product to CMS?")}
        message={t("The product and its audio files are stored on the server; the server then creates the assets on YouTube CMS through the Content ID API and delivers the references. You can follow the progress here or on the product page.")}
        confirmLabel={tracks.length === 1 ? t("Deliver {count} track", { count: tracks.length }) : t("Deliver {count} tracks", { count: tracks.length })}
        tone="primary"
        onConfirm={startDelivery}
        onCancel={() => setModal("")}
      >
        <DefinitionList
          items={[
            { label: "CMS", value: network?.name || "—" },
            { label: t("Content owner"), value: contentOwner ? `${contentOwner.display_name || ""} ${contentOwner.id ? `(${contentOwner.id})` : ""}`.trim() : network?.network_code || "—" },
            { label: t("Product"), value: `${text(release.title)} — ${text(release.artist)}` },
            { label: t("Tracks"), value: t("{count} Sound Recording asset(s)", { count: tracks.length }) },
            { label: t("Ownership"), value: summarizeOwnership(rights.ownership.mode, rights.ownership.territories) },
            { label: t("Match policy"), value: policyName || "—" },
            { label: t("Asset labels"), value: rights.asset_labels.length ? rights.asset_labels.join(", ") : t("None") },
            { label: t("Audio files"), value: t("{uploaded} of {total} uploaded to the server", { uploaded: analysis.counts.withAudio, total: tracks.length }) },
            {
              label: t("References"),
              value: includeReference
                ? reference.urgent
                  ? t("Delivered by the server ({type} · urgent)", { type: reference.content_type })
                  : t("Delivered by the server ({type})", { type: reference.content_type })
                : t("Not delivered now — deliver later from the product page")
            },
            { label: t("Duplicates"), value: skipDuplicates ? t("Skip ISRCs already in CMS") : t("Create even if the ISRC exists") },
            { label: t("Server audio"), value: reference.delete_reference_after_delivery ? t("Delete after each successful reference delivery") : t("Keep after delivery") }
          ]}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={modal === "clear"}
        title={t("Remove all tracks?")}
        message={t("Every row and attached audio file is removed from the form. The release info is kept.")}
        confirmLabel={t("Clear tracks")}
        tone="danger"
        onConfirm={clearTracks}
        onCancel={() => setModal("")}
      />

      <DeliveryLogViewer
        productId={run.product_id}
        tracks={tracks.filter((row) => row.track_id).map((row) => ({ ...row, id: row.track_id }))}
        open={modal === "logs"}
        onClose={() => setModal("")}
      />

      <ConfirmDialog
        open={modal === "cancel"}
        title={t("Discard this product?")}
        message={t("The form and the autosaved draft are discarded. Nothing has been sent to CMS.")}
        confirmLabel={t("Discard")}
        tone="danger"
        onConfirm={confirmCancel}
        onCancel={() => setModal("")}
      />

      {/* Preview plan */}
      <Modal
        open={modal === "preview"}
        title={t("Delivery plan preview")}
        subtitle={tracks[0] ? t("What the backend sends to CMS for track 1 «{title}». Other tracks follow the same shape.", { title: text(tracks[0].title) || t("untitled") }) : t("Add a track to preview the plan.")}
        size="lg"
        onClose={() => setModal("")}
        footer={
          <Button variant="secondary" onClick={() => setModal("")}>
            {t("Close")}
          </Button>
        }
      >
        {previewPlan ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-400">{t("Asset (metadataMine + labels)")}</p>
              <JsonViewer value={previewPlan.asset} maxHeight={360} />
            </div>
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-400">{t("Ownership")}</p>
                <JsonViewer value={previewPlan.ownership} maxHeight={150} />
              </div>
              <div>
                <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-400">{t("Match policy · reference · options")}</p>
                <JsonViewer value={{ matchPolicy: previewPlan.matchPolicy, reference: previewPlan.reference, options: previewPlan.options }} maxHeight={170} />
              </div>
            </div>
          </div>
        ) : (
          <EmptyState compact icon={Eye} title={t("Nothing to preview")} description={t("Add at least one track first.")} />
        )}
      </Modal>

      {/* Import from Product Manager */}
      <Modal
        open={modal === "legacy"}
        title={t("Import from Product Manager")}
        subtitle={t("Pick an album saved in Product Manager. Release info and tracks are copied into the form; attach the audio files afterwards.")}
        size="lg"
        onClose={closeLegacyModal}
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <TextInput value={legacy.search} placeholder={t("Search album, artist, UPC or label…")} className="pl-11" onChange={(event) => handleLegacySearch(event.target.value)} />
            </div>
            <Button variant="secondary" icon={RefreshCw} loading={legacy.loading} onClick={() => loadLegacy(legacy.search)}>
              {t("Refresh")}
            </Button>
            <Toggle size="sm" checked={legacy.replace} label={t("Replace current rows")} onChange={(value) => setLegacy((current) => ({ ...current, replace: value }))} />
          </div>
          {legacy.error && <InlineMessage tone="error">{tm(legacy.error)}</InlineMessage>}
          <div className="max-h-[440px] overflow-auto rounded-2xl border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">{t("Album")}</th>
                  <th className="px-3 py-2">UPC</th>
                  <th className="px-3 py-2">{t("Label")}</th>
                  <th className="px-3 py-2">{t("Tracks")}</th>
                  <th className="px-3 py-2" aria-label={t("Action")} />
                </tr>
              </thead>
              <tbody>
                {legacy.items.map((product) => (
                  <tr key={product.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <p className="font-black text-slate-950">{product.album_title || t("(untitled)")}</p>
                      <p className="text-xs text-slate-500">
                        {product.album_artist || "—"}
                        {product.release_date ? ` · ${String(product.release_date).slice(0, 10)}` : ""}
                        {product.genre ? ` · ${product.genre}` : ""}
                      </p>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">{product.album_upc || "—"}</td>
                    <td className="px-3 py-2 text-xs font-bold text-slate-600">{product.label || "—"}</td>
                    <td className="px-3 py-2 text-xs font-black text-slate-700">{product.track_count ?? product.tracks?.length ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="primary" loading={legacy.loadingId === product.id} disabled={legacy.loadingId !== null && legacy.loadingId !== product.id} onClick={() => importLegacyProduct(product.id)}>
                        {t("Import")}
                      </Button>
                    </td>
                  </tr>
                ))}
                {!legacy.items.length && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-sm font-bold text-slate-500">
                      {legacy.loading ? t("Loading products…") : t("No products found.")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      {/* Paste table */}
      <Modal
        open={modal === "paste"}
        title={t("Paste table")}
        subtitle={t("Paste rows copied from Excel / Google Sheets / a CSV. Columns are detected from the header row and can be remapped.")}
        size="lg"
        onClose={() => setModal("")}
        footer={
          <>
            <label className="mr-auto inline-flex items-center gap-2 text-xs font-bold text-slate-600">
              <input type="checkbox" checked={paste.hasHeader} onChange={(event) => setPaste((current) => ({ ...current, hasHeader: event.target.checked, parsed: null }))} />
              {t("First row is a header")}
            </label>
            <Button variant="secondary" icon={Wand2} disabled={!paste.text.trim()} onClick={parsePaste}>
              {t("Parse")}
            </Button>
            <Button variant="primary" icon={ListPlus} disabled={!paste.parsed?.records?.length} onClick={importPaste}>
              {t("Import {count} row(s)", { count: paste.parsed?.records?.length || 0 })}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <TextArea
            rows={7}
            mono
            value={paste.text}
            placeholder={t("Title\tArtist\tISRC\tFile name\nMidnight\tLena Park\tUSABC2412345\t01 Midnight.wav")}
            onChange={(event) => setPaste((current) => ({ ...current, text: event.target.value, parsed: null }))}
          />
          {paste.parsed && !paste.parsed.headers.length && <InlineMessage tone="warning">{t("Nothing could be parsed. Check the delimiter (tab, comma or semicolon).")}</InlineMessage>}
          {paste.parsed && paste.parsed.headers.length > 0 && (
            <div className="space-y-4">
              <p className="text-xs font-bold text-slate-500">
                {t("Detected {columns} column(s) and {rows} row(s). Map each field to a column — unmapped fields are left empty.", { columns: paste.parsed.headers.length, rows: paste.parsed.records.length })}
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {PASTE_TRACK_FIELDS.map((field) => (
                  <Field key={field.key} label={t(field.label)}>
                    <Select compact value={paste.parsed.mapping[field.key] || ""} placeholder={t("— not mapped —")} options={paste.parsed.headers.map((header) => ({ value: header, label: header }))} onChange={(event) => updatePasteMapping("track", field.key, event.target.value)} />
                  </Field>
                ))}
              </div>
              <details className="rounded-2xl border border-slate-200 p-3">
                <summary className="cursor-pointer text-xs font-black uppercase tracking-wide text-slate-500">{t("Album columns (fill empty release fields from the first row)")}</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {PASTE_ALBUM_FIELDS.map((field) => (
                    <Field key={field.key} label={t(field.label)}>
                      <Select compact value={paste.parsed.albumMapping[field.key] || ""} placeholder={t("— not mapped —")} options={paste.parsed.headers.map((header) => ({ value: header, label: header }))} onChange={(event) => updatePasteMapping("album", field.key, event.target.value)} />
                    </Field>
                  ))}
                </div>
              </details>
              <div className="overflow-x-auto rounded-2xl border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wide text-slate-500">
                    <tr>
                      {PASTE_TRACK_FIELDS.filter((field) => paste.parsed.mapping[field.key]).map((field) => (
                        <th key={field.key} className="px-3 py-2">
                          {t(field.label)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paste.parsed.records.slice(0, 5).map((record, index) => (
                      <tr key={index} className="border-t border-slate-100">
                        {PASTE_TRACK_FIELDS.filter((field) => paste.parsed.mapping[field.key]).map((field) => (
                          <td key={field.key} className={cx("max-w-[14rem] truncate px-3 py-2 font-bold text-slate-700", field.key === "isrc" && "font-mono")}>
                            {record[paste.parsed.mapping[field.key]] || "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {paste.parsed.records.length > 5 && <p className="px-3 py-2 text-[11px] font-bold text-slate-400">{t("…and {count} more row(s)", { count: paste.parsed.records.length - 5 })}</p>}
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* Bulk paste */}
      <Modal
        open={modal === "bulk"}
        title={t("Bulk paste")}
        subtitle={t("One value per line, applied to the rows in order. Extra lines add new rows.")}
        size="sm"
        onClose={() => setModal("")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModal("")}>
              {t("Cancel")}
            </Button>
            <Button variant="primary" icon={ListPlus} disabled={!bulk.text.trim()} onClick={applyBulk}>
              {t("Apply")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t("Column")}>
            <Select value={bulk.field} options={bulkFieldOptions} onChange={(event) => setBulk((current) => ({ ...current, field: event.target.value }))} />
          </Field>
          <Field label={t("Values")} hint={t("{lines} line(s) · {rows} existing row(s)", { lines: bulk.text.split(/\r?\n/).filter((line) => line.trim()).length, rows: tracks.length })}>
            <TextArea rows={8} mono={bulk.field === "isrc" || bulk.field === "custom_id"} value={bulk.text} placeholder={bulk.field === "isrc" ? t("USABC2412345\nUSABC2412346") : t("One value per line")} onChange={(event) => setBulk((current) => ({ ...current, text: event.target.value }))} />
          </Field>
          {!tracks.length && (
            <InlineMessage tone="neutral" icon={TriangleAlert}>
              {t("There are no rows yet — each line creates a new track row.")}
            </InlineMessage>
          )}
        </div>
      </Modal>

    </div>
  );
}
