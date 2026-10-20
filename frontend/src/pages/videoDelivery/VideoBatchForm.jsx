import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clapperboard,
  ClipboardList,
  CloudUpload,
  ExternalLink,
  Eye,
  FileVideo,
  FolderOpen,
  Info,
  Loader2,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  checkDraftAudio,
  createCmsAssetLabel,
  createProduct,
  deleteDraftAudio,
  deliverProduct,
  getProduct,
  getProductProgress,
  uploadDraftAudio
} from "../../api/deliveryApi";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { ASSET_TYPE_META, REFERENCE_CONTENT_TYPES, STEP_LABELS, STORAGE_KEYS, VIDEO_ACCEPT, VIDEO_ASSET_TYPE_OPTIONS } from "../assetDelivery/constants";
import { useDebouncedValue } from "../assetDelivery/hooks";
import { createDraftAudioQueue } from "../assetDelivery/draftAudioQueue";
import DeliveryLogViewer from "../assetDelivery/DeliveryLogViewer";
import ShortMediaDialog from "../assetDelivery/ShortMediaDialog";
import { MIN_VIDEO_REFERENCE_SECONDS, probeMediaDuration, splitByReferenceLength } from "../assetDelivery/mediaProbe";
import { DefinitionList, RunPanel } from "../assetDelivery/RunPanel";
import { IDLE_RUN, RUNNING_PHASES } from "../assetDelivery/runState";
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
} from "../assetDelivery/shared";
import {
  baseName,
  cleanCode,
  cx,
  formatBytes,
  formatDateTime,
  getErrorMessage,
  isValidUpc,
  isVideoFile,
  makeClientId,
  normalizeIsrc,
  normalizeUpc,
  readLocalStorage,
  removeVietnameseTones,
  stripExtension,
  summarizeOwnership,
  titleFromFilename,
  toDateInputValue,
  writeLocalStorage
} from "../assetDelivery/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OTHER_VALUE = "__other__";
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 30 * 60 * 1000;
const POLL_MAX_ERRORS = 5;
const POLL_MAX_IDLE = 3;
const BUSY_TRACK_STATUSES = ["creating", "uploading"];
// Content ID metadata limits are in UTF-8 bytes (Vietnamese letters count 2–3 bytes each);
// the backend rejects the same values at create time.
const DESCRIPTION_MAX = 5000;
const NOTES_MAX = 255;
const TITLE_MAX = 255;
const URL_MAX = 1536;
const CUSTOM_ID_TOKEN_LENGTH = 12;
const CUSTOM_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ISRC_IN_NAME_RE = /([A-Z]{2})[-_. ]?([A-Z0-9]{3})[-_. ]?(\d{2})[-_. ]?(\d{5})/i;

const STEPS = [
  { key: "batch", label: tk("Batch"), description: tk("Name, asset type, prefix") },
  { key: "rights", label: tk("Rights"), description: tk("Ownership, policy, labels") },
  { key: "videos", label: tk("Videos"), description: tk("Files, titles, metadata") },
  { key: "deliver", label: tk("Deliver"), description: tk("Push to CMS, free the server") }
];

const REFERENCE_TYPE_OPTIONS = REFERENCE_CONTENT_TYPES.map((value) => ({
  value,
  label: value === "audiovisual" ? tk("Audiovisual (video + audio fingerprint)") : value === "video" ? tk("Video only (visual fingerprint)") : tk("Audio only (audio fingerprint)")
}));

const DEFAULT_BATCH = {
  title: "",
  artist: "",
  label: "",
  upc: "",
  release_date: "",
  notes: "",
  asset_type: "web"
};

const DEFAULT_RIGHTS = {
  ownership: { mode: "worldwide", territories: [] },
  match_policy_id: "",
  match_policy_name: "",
  asset_labels: []
};

// Video masters are large: the default is to remove each file once CMS holds its reference.
const DEFAULT_REFERENCE = { content_type: "audiovisual", urgent: false, upload_reference: true, delete_reference_after_delivery: true };

const TONE_CLS = {
  slate: "bg-slate-100 text-slate-600",
  blue: "bg-blue-50 text-blue-700",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-600",
  indigo: "bg-indigo-50 text-indigo-700"
};

const ROW_TINT = {
  error: "bg-red-50/60",
  duplicate: "bg-amber-50/60",
  completed: "bg-emerald-50/50",
  creating: "bg-blue-50/50",
  uploading: "bg-indigo-50/50"
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function text(value) {
  return String(value ?? "").trim();
}

function utf8Length(value) {
  return new TextEncoder().encode(text(value)).length;
}

function randomToken(length = CUSTOM_ID_TOKEN_LENGTH) {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => CUSTOM_ID_ALPHABET[byte % CUSTOM_ID_ALPHABET.length]).join("");
}

// Mirrors the backend: letters/digits only in the prefix, "<prefix>_<token|ISRC>" as the id.
function customIdPrefix(value) {
  return removeVietnameseTones(text(value)).replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "ANS";
}

function sanitizeCustomId(value) {
  return removeVietnameseTones(text(value)).replace(/\s+/g, "_").replace(/[^A-Za-z0-9._@/-]/g, "").slice(0, 64);
}

// Same rule as the server: an http(s) URL that parses, at most 1536 bytes.
function isHttpUrl(value) {
  try {
    const url = new URL(text(value));
    return (url.protocol === "http:" || url.protocol === "https:") && utf8Length(value) <= URL_MAX;
  } catch {
    return false;
  }
}

function isrcFromFilename(name) {
  const match = ISRC_IN_NAME_RE.exec(String(name || ""));
  if (!match) return "";
  return normalizeIsrc(`${match[1]}${match[2]}${match[3]}${match[4]}`);
}

function createRow(overrides = {}) {
  return {
    client_id: makeClientId(),
    title: "",
    artist: "",
    isrc: "",
    description: "",
    source_url: "",
    custom_id: "",
    custom_id_auto: true,
    custom_token: randomToken(),
    notes: "",
    asset_labels: null,
    file_name: "",
    file_size: 0,
    audio_upload_id: "",
    uploading: false,
    upload_progress: 0,
    audio_error: "",
    has_audio: false,
    audio_uploaded: false,
    track_id: null,
    status: "pending",
    step: "",
    error_message: "",
    asset_id: "",
    reference_id: "",
    reference_status: "",
    duplicates: [],
    ...overrides
  };
}

function hasStoredFile(row) {
  return Boolean(row?.has_audio || row?.audio_uploaded || row?.audio_upload_id);
}

function clearValidationMarker(next, previous) {
  if (previous?.status !== "error" || previous?.step !== "validate") return next;
  return { ...next, status: "pending", step: "", error_message: "" };
}

function draftRow(row) {
  return {
    client_id: row.client_id,
    title: row.title,
    artist: row.artist,
    isrc: row.isrc,
    description: row.description,
    source_url: row.source_url,
    custom_id: row.custom_id,
    custom_id_auto: row.custom_id_auto,
    custom_token: row.custom_token,
    notes: row.notes,
    asset_labels: row.asset_labels,
    file_name: row.file_name || "",
    file_size: row.file_size || 0,
    audio_selected: Boolean(row.file_name),
    audio_upload_id: row.audio_upload_id || ""
  };
}

function draftHasContent(draft) {
  if (!draft || typeof draft !== "object") return false;
  return Boolean(text(draft.batch?.title) || (Array.isArray(draft.rows) && draft.rows.length));
}

function readDraft() {
  const draft = readLocalStorage(STORAGE_KEYS.videoDraft, null);
  return draftHasContent(draft) ? draft : null;
}

function mapCreatedTracks(createdTracks, payloadTracks) {
  const map = new Map();
  const list = Array.isArray(createdTracks) ? createdTracks : [];
  const byClient = new Map(list.filter((track) => track?.client_id).map((track) => [track.client_id, track]));
  const byNumber = new Map(list.filter((track) => Number(track?.track_number) > 0).map((track) => [Number(track.track_number), track]));
  payloadTracks.forEach((item) => {
    const hit = byClient.get(item.client_id) || byNumber.get(Number(item.track_number));
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

function stepLabel(step) {
  return STEP_LABELS[step] || step || "";
}

function describeRow(row, t) {
  if (row.uploading) return { label: t("Uploading {progress}%", { progress: row.upload_progress }), tone: "indigo", spin: true };
  if (row.audio_error) return { label: t("Upload failed"), tone: "red", spin: false };
  if (row.status === "completed") return { label: t("Delivered"), tone: "emerald", spin: false };
  if (row.status === "created") return { label: row.reference_id ? t("Delivered") : t("Asset created"), tone: "blue", spin: false };
  if (row.status === "creating") return { label: row.step === "queued" ? t("Queued") : stepLabel(row.step) ? t(stepLabel(row.step)) : t("Creating"), tone: "blue", spin: true };
  if (row.status === "uploading") return { label: t("Uploading reference"), tone: "indigo", spin: true };
  if (row.status === "duplicate") return { label: t("Duplicate"), tone: "amber", spin: false };
  if (row.status === "error") return { label: t("Error"), tone: "red", spin: false };
  if (row.track_id) return { label: t("Pending"), tone: "slate", spin: false };
  if (row.audio_upload_id) return { label: t("File ready"), tone: "emerald", spin: false };
  if (row.file_name) return { label: t("Waiting for upload"), tone: "slate", spin: false };
  return { label: t("No file"), tone: "slate", spin: false };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Video row
// ---------------------------------------------------------------------------

const VideoRow = memo(function VideoRow({
  row,
  index,
  meta,
  assetType,
  defaultArtist,
  assetLabelSuggestions,
  locked,
  forcing,
  showCreateAnyway,
  canRetryUpload,
  onUpdate,
  onRemove,
  onAttach,
  onDetach,
  onRegenerate,
  onCreateAnyway,
  onRetryUpload
}) {
  const { t, tm } = useI18n();
  const id = row.client_id;
  const issues = meta?.issues || [];
  const badge = describeRow(row, t);
  const tint = ROW_TINT[row.uploading ? "uploading" : row.status] || "";
  const musicVideo = assetType === "music_video";
  const descriptionLength = utf8Length(row.description);

  return (
    <tr className={cx("border-t border-slate-100 align-top transition", tint || "hover:bg-slate-50")}>
      <td className="px-2 py-2 text-center text-xs font-black text-slate-500">{index + 1}</td>

      <td className="px-2 py-2">
        {row.file_name ? (
          <div className="flex items-start gap-2">
            <span className={cx("mt-0.5 rounded-lg p-1.5", row.audio_error ? "bg-red-50 text-red-600" : "bg-indigo-50 text-indigo-700")}>
              <FileVideo size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-black text-slate-800" title={row.file_name}>
                {row.file_name}
              </p>
              <p className="text-[11px] font-bold text-slate-400">
                {formatBytes(row.file_size)}
                {hasStoredFile(row) && !row.uploading ? ` · ${t("on server")}` : ""}
              </p>
              {row.uploading && <ProgressBar value={row.upload_progress} size="sm" tone="indigo" className="mt-1.5" label={t("Uploading")} />}
              {row.audio_error && !row.uploading && (
                <div className="mt-1 space-y-1">
                  <p className="max-w-[13rem] text-[11px] font-bold text-red-600" title={tm(row.audio_error)}>
                    {tm(row.audio_error)}
                  </p>
                  {canRetryUpload && (
                    <Button size="sm" variant="secondary" icon={Upload} onClick={() => onRetryUpload(row)}>
                      {t("Retry upload")}
                    </Button>
                  )}
                  {!locked && (
                    <FilePickerButton accept={VIDEO_ACCEPT} icon={Paperclip} size="sm" onFiles={(files) => onAttach(id, files[0])}>
                      {t("Select file again")}
                    </FilePickerButton>
                  )}
                </div>
              )}
              {!locked && !row.audio_error && (
                <FilePickerButton accept={VIDEO_ACCEPT} icon={RefreshCw} size="sm" onFiles={(files) => onAttach(id, files[0])}>
                  {t("Replace file")}
                </FilePickerButton>
              )}
            </div>
            {!locked && <IconButton icon={X} label={t("Remove video file")} size="sm" tone="ghost" onClick={() => onDetach(id)} />}
          </div>
        ) : locked ? (
          <Badge tone="slate" title={t("No video file was attached — the asset is created without a reference. Upload the file later from the batch page.")}>
            {t("no file")}
          </Badge>
        ) : (
          <FilePickerButton accept={VIDEO_ACCEPT} icon={Paperclip} size="sm" onFiles={(files) => onAttach(id, files[0])}>
            {t("Attach video")}
          </FilePickerButton>
        )}
      </td>

      <td className="px-2 py-2">
        <TextInput compact value={row.title} invalid={issues.includes("title")} disabled={locked} placeholder={t("Video title")} onChange={(event) => onUpdate(id, { title: event.target.value })} />
      </td>

      {musicVideo && (
        <td className="px-2 py-2">
          <TextInput compact value={row.artist} disabled={locked} placeholder={defaultArtist || t("Artist name")} onChange={(event) => onUpdate(id, { artist: event.target.value })} />
        </td>
      )}

      {musicVideo && (
        <td className="px-2 py-2">
          <TextInput
            compact
            mono
            value={row.isrc}
            invalid={issues.includes("isrc") || issues.includes("duplicate")}
            disabled={locked}
            placeholder={t("Optional")}
            maxLength={12}
            className="uppercase"
            onChange={(event) => onUpdate(id, { isrc: cleanCode(event.target.value).slice(0, 12) })}
          />
          {issues.includes("duplicate") && <p className="mt-1 text-[11px] font-bold text-red-600">{t("Duplicate ISRC in this batch")}</p>}
        </td>
      )}

      <td className="px-2 py-2">
        <TextArea compact rows={2} value={row.description} invalid={issues.includes("description")} disabled={locked} placeholder={t("Shown on the asset in CMS")} onChange={(event) => onUpdate(id, { description: event.target.value })} />
        {descriptionLength > DESCRIPTION_MAX - 500 && (
          <p className={cx("mt-0.5 text-[11px] font-bold", descriptionLength > DESCRIPTION_MAX ? "text-red-600" : "text-slate-400")}>{t("{length}/{max} bytes", { length: descriptionLength, max: DESCRIPTION_MAX })}</p>
        )}
      </td>

      <td className="px-2 py-2">
        <div className="flex items-center gap-1">
          <TextInput
            compact
            mono
            value={meta?.customId ?? row.custom_id}
            disabled={locked}
            invalid={issues.includes("custom_id")}
            placeholder={t("PREFIX_xxxxxxxx")}
            onChange={(event) => onUpdate(id, { custom_id: event.target.value, custom_id_auto: false })}
          />
          <IconButton
            icon={RotateCcw}
            label={row.custom_id_auto ? t("Generate a new custom ID") : t("Back to a generated custom ID")}
            size="sm"
            tone={row.custom_id_auto ? "ghost" : "blue"}
            disabled={locked}
            onClick={() => onRegenerate(id)}
          />
        </div>
      </td>

      <td className="px-2 py-2">
        <TextInput compact value={row.source_url} invalid={issues.includes("source_url")} disabled={locked} placeholder="https://www.youtube.com/watch?v=…" onChange={(event) => onUpdate(id, { source_url: event.target.value })} />
      </td>

      <td className="px-2 py-2">
        <ChipInput compact values={Array.isArray(row.asset_labels) ? row.asset_labels : []} suggestions={assetLabelSuggestions} disabled={locked} placeholder={t("Inherit batch labels")} onChange={(next) => onUpdate(id, { asset_labels: next.length ? next : null })} />
      </td>

      <td className="px-2 py-2">
        <TextInput compact value={row.notes} invalid={issues.includes("notes")} disabled={locked} placeholder={t("Optional (255 bytes)")} title={issues.includes("notes") ? t("Notes must be {max} bytes or shorter", { max: NOTES_MAX }) : undefined} onChange={(event) => onUpdate(id, { notes: event.target.value })} />
      </td>

      <td className="px-2 py-2">
        <div className="space-y-1">
          <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide", TONE_CLS[badge.tone] || TONE_CLS.slate)} title={row.step && row.status !== "error" ? t("Step: {step}", { step: t(stepLabel(row.step)) }) : undefined}>
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
              {row.reference_status ? ` · ${row.reference_status}` : ""}
            </p>
          )}
          {row.status === "error" && (
            <p className="max-w-[14rem] text-[11px] font-bold text-red-600" title={tm(row.error_message)}>
              {row.step
                ? t("Error at {step}: {message}", { step: t(stepLabel(row.step)), message: row.error_message ? tm(row.error_message) : t("Failed") })
                : t("Error: {message}", { message: row.error_message ? tm(row.error_message) : t("Failed") })}
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
        <IconButton icon={Trash2} label={t("Remove video")} size="sm" tone="red" disabled={locked} onClick={() => onRemove(id)} />
      </td>
    </tr>
  );
});

// ---------------------------------------------------------------------------
// VideoBatchForm
// ---------------------------------------------------------------------------

export default function VideoBatchForm({ network, options, optionsLoading, reloadOptions, localLabels, showToast, onCancel, onDelivered }) {
  const [batch, setBatch] = useState(DEFAULT_BATCH);
  const [labelOther, setLabelOther] = useState(false);
  const [rights, setRights] = useState(DEFAULT_RIGHTS);
  const [reference, setReference] = useState(DEFAULT_REFERENCE);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [rows, setRows] = useState([]);
  const [pendingDraft, setPendingDraft] = useState(() => readDraft());
  const [serverErrors, setServerErrors] = useState({});
  const [modal, setModal] = useState(""); // confirm | clear | cancel | preview | logs
  const [run, setRun] = useState(IDLE_RUN);
  const [forcingId, setForcingId] = useState(null);
  const [dragging, setDragging] = useState(false);
  // Files refused because they are shorter than a Content ID reference may be (pop-up).
  const [shortMedia, setShortMedia] = useState([]);
  const { t, tm } = useI18n();

  const filesRef = useRef(new Map());
  const mountedRef = useRef(false);
  const pollTokenRef = useRef(null);
  const [draftUploads] = useState(() => createDraftAudioQueue({
    // `kind: "video"` lets the server re-check MP4/MOV durations (HTTP 422 when too short).
    upload: async (file, uploadOptions) => {
      try {
        return await uploadDraftAudio(file, { ...uploadOptions, kind: "video" });
      } catch (error) {
        const data = error?.response?.data;
        if (data?.code === "VIDEO_TOO_SHORT" && mountedRef.current) setShortMedia((current) => [...current, { file, duration: Number(data.duration_seconds) }]);
        throw error;
      }
    },
    remove: deleteDraftAudio,
    errorMessage: getErrorMessage,
    onPatch: (clientId, patch) => {
      if (mountedRef.current) setRows((current) => current.map((row) => (row.client_id === clientId ? clearValidationMarker({ ...row, ...patch }, row) : row)));
    }
  }));

  useEffect(() => {
    mountedRef.current = true;
    draftUploads.resume();
    return () => {
      mountedRef.current = false;
      pollTokenRef.current = null;
      draftUploads.dispose();
    };
  }, [draftUploads]);

  // ---------------------------------------------------------------- derived
  const assetType = ASSET_TYPE_META[batch.asset_type] ? batch.asset_type : "web";
  const typeMeta = ASSET_TYPE_META[assetType];
  const assetTypeOption = VIDEO_ASSET_TYPE_OPTIONS.find((item) => item.value === assetType);
  const musicVideo = assetType === "music_video";
  const running = RUNNING_PHASES.includes(run.phase);
  const locked = running || Boolean(run.product_id);
  const busy = running || Boolean(forcingId);
  const prefix = customIdPrefix(batch.label || batch.artist || network?.name);
  const policies = Array.isArray(options?.policies) ? options.policies : [];
  const assetLabelSuggestions = useMemo(() => (Array.isArray(options?.asset_labels) ? options.asset_labels : []), [options]);
  const contentOwner = options?.content_owner || null;
  const selectedPolicy = policies.find((policy) => String(policy.id) === String(rights.match_policy_id)) || null;
  const policyName = rights.match_policy_name || selectedPolicy?.name || (rights.match_policy_id ? `Policy ${rights.match_policy_id}` : "");
  const labelList = Array.isArray(localLabels) ? localLabels : [];
  const labelNames = labelList.map((label) => String(label.name || label.display_name || "")).filter(Boolean);
  const labelInList = Boolean(batch.label) && labelNames.includes(batch.label);
  const showLabelInput = labelOther || (Boolean(batch.label) && !labelInList);
  const includeReference = reference.upload_reference !== false;

  const analysis = useMemo(() => {
    const isrcCounts = new Map();
    rows.forEach((row) => {
      const code = normalizeIsrc(row.isrc);
      if (musicVideo && code) isrcCounts.set(code, (isrcCounts.get(code) || 0) + 1);
    });
    const items = rows.map((row, index) => {
      const issues = [];
      const isrc = musicVideo ? normalizeIsrc(row.isrc) : "";
      if (!text(row.title) || utf8Length(row.title) > TITLE_MAX) issues.push("title");
      if (musicVideo && text(row.isrc) && !isrc) issues.push("isrc");
      else if (isrc && isrcCounts.get(isrc) > 1) issues.push("duplicate");
      if (text(row.source_url) && !isHttpUrl(row.source_url)) issues.push("source_url");
      if (utf8Length(row.description) > DESCRIPTION_MAX) issues.push("description");
      if (utf8Length(row.notes) > NOTES_MAX) issues.push("notes");
      const customId = row.custom_id_auto
        ? (musicVideo && isrc ? `${prefix}_${isrc}` : `${prefix}_${row.custom_token}`)
        : sanitizeCustomId(row.custom_id);
      if (!row.custom_id_auto && text(row.custom_id) && !customId) issues.push("custom_id");
      return { client_id: row.client_id, index, issues, hasFile: hasStoredFile(row), customId };
    });
    const byId = new Map(items.map((item) => [item.client_id, item]));
    const counts = {
      total: rows.length,
      withFile: items.filter((item) => item.hasFile).length,
      missingTitle: items.filter((item) => item.issues.includes("title")).length,
      invalidIsrc: items.filter((item) => item.issues.includes("isrc")).length,
      duplicateIsrc: items.filter((item) => item.issues.includes("duplicate")).length,
      invalidUrl: items.filter((item) => item.issues.includes("source_url")).length,
      tooLong: items.filter((item) => item.issues.includes("description") || item.issues.includes("notes")).length,
      invalid: items.filter((item) => item.issues.length).length
    };
    return { items, byId, counts };
  }, [rows, musicVideo, prefix]);

  const batchErrors = useMemo(() => {
    const errors = {};
    if (!text(batch.title)) errors.title = t("Batch name is required.");
    else if (utf8Length(batch.title) > TITLE_MAX) errors.title = t("Batch name must be {max} bytes or shorter.", { max: TITLE_MAX });
    if (utf8Length(batch.notes) > NOTES_MAX) errors.notes = t("Notes must be {max} bytes or shorter ({length} now; accented letters count 2–3 bytes).", { max: NOTES_MAX, length: utf8Length(batch.notes) });
    if (musicVideo && text(batch.upc) && !isValidUpc(normalizeUpc(batch.upc))) errors.upc = t("UPC must be 8–14 digits.");
    return errors;
  }, [batch, musicVideo, t]);

  const rightsErrors = useMemo(() => {
    const errors = {};
    if (!text(rights.match_policy_id)) errors.policy = t("Choose the match policy applied to every asset.");
    if (rights.ownership.mode === "include" && !rights.ownership.territories.length) errors.ownership = t("Select at least one territory to include.");
    return errors;
  }, [rights, t]);

  const batchDone = Object.keys(batchErrors).length === 0;
  const rightsDone = Object.keys(rightsErrors).length === 0;
  const videosDone = rows.length > 0 && analysis.counts.invalid === 0;
  const formValid = Boolean(network?.id) && batchDone && rightsDone && videosDone;
  const pendingUploads = rows.filter((row) => row.uploading).length;
  const failedUploads = rows.filter((row) => row.audio_error || (row.file_name && !row.uploading && !hasStoredFile(row))).length;
  const uploadsReady = pendingUploads === 0 && failedUploads === 0;
  const canDeliver = formValid && uploadsReady && !locked;
  const hasContent = Boolean(text(batch.title) || rows.length);

  const doneSteps = useMemo(() => {
    const done = [];
    if (batchDone) done.push("batch");
    if (rightsDone) done.push("rights");
    if (videosDone) done.push("videos");
    if (run.phase === "done") done.push("deliver");
    return done;
  }, [batchDone, rightsDone, videosDone, run.phase]);
  const activeStep = STEPS.find((step) => !doneSteps.includes(step.key))?.key || "deliver";
  const stepperSteps = useMemo(() => STEPS.map((step) => ({ ...step, label: t(step.label), description: t(step.description) })), [t]);

  const runCounts = useMemo(
    () => ({
      created: rows.filter((row) => row.asset_id).length,
      completed: rows.filter((row) => row.status === "completed").length,
      duplicates: rows.filter((row) => row.status === "duplicate").length,
      errors: rows.filter((row) => row.status === "error").length,
      storedAudio: rows.filter((row) => hasStoredFile(row)).length
    }),
    [rows]
  );

  const jobProgress = useMemo(() => {
    const stored = rows.filter((row) => row.track_id);
    const inFlight = stored.filter((row) => BUSY_TRACK_STATUSES.includes(row.status)).length;
    const pending = stored.filter((row) => row.status === "pending").length;
    return { total: stored.length, busy: inFlight, finished: stored.length - inFlight - pending };
  }, [rows]);

  const summaryLine = useMemo(() => {
    const assetTypeName = t(typeMeta.label).toLowerCase();
    const networkName = network?.name || t("not selected");
    const withFile = analysis.counts.withFile;
    const parts = [
      rows.length === 1
        ? t("{count} video → CMS «{network}» as {assetType} assets", { count: rows.length, network: networkName, assetType: assetTypeName })
        : t("{count} videos → CMS «{network}» as {assetType} assets", { count: rows.length, network: networkName, assetType: assetTypeName }),
      summarizeOwnership(rights.ownership.mode, rights.ownership.territories),
      policyName || t("No match policy"),
      includeReference
        ? withFile === 1
          ? t("{count} file uploaded → {contentType} references", { count: withFile, contentType: reference.content_type })
          : t("{count} files uploaded → {contentType} references", { count: withFile, contentType: reference.content_type })
        : withFile === 1
          ? t("{count} file uploaded (references off)", { count: withFile })
          : t("{count} files uploaded (references off)", { count: withFile }),
      reference.delete_reference_after_delivery ? t("files removed after delivery") : t("files kept on server")
    ];
    return parts.join(" · ");
  }, [rows.length, network, typeMeta, rights.ownership, policyName, analysis.counts.withFile, includeReference, reference, t]);

  // ---------------------------------------------------------------- draft autosave
  const draftSnapshot = useMemo(
    () => ({ batch, rights, reference, options: { skip_duplicates: skipDuplicates }, rows: rows.map(draftRow) }),
    [batch, rights, reference, skipDuplicates, rows]
  );
  const debouncedDraft = useDebouncedValue(draftSnapshot, 500);
  const showDraftBanner = Boolean(pendingDraft) && !hasContent && !locked;
  const draftTitle = text(pendingDraft?.batch?.title) || t("Untitled batch");
  const draftVideoCount = Array.isArray(pendingDraft?.rows) ? pendingDraft.rows.length : 0;

  useEffect(() => {
    if (locked) return;
    if (draftHasContent(debouncedDraft)) {
      writeLocalStorage(STORAGE_KEYS.videoDraft, { ...debouncedDraft, saved_at: new Date().toISOString() });
    } else if (!pendingDraft) {
      writeLocalStorage(STORAGE_KEYS.videoDraft, null);
    }
  }, [debouncedDraft, pendingDraft, locked]);

  function restoreDraft() {
    const draft = pendingDraft;
    if (!draft || hasContent) return;
    setBatch({ ...DEFAULT_BATCH, ...(draft.batch || {}), asset_type: ASSET_TYPE_META[draft.batch?.asset_type]?.kind === "video" ? draft.batch.asset_type : "web" });
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
      content_type: REFERENCE_CONTENT_TYPES.includes(draft.reference?.content_type) ? draft.reference.content_type : "audiovisual",
      urgent: Boolean(draft.reference?.urgent),
      upload_reference: draft.reference?.upload_reference !== false,
      delete_reference_after_delivery: draft.reference?.delete_reference_after_delivery !== false
    });
    setSkipDuplicates(draft.options?.skip_duplicates !== false);
    const restored = (Array.isArray(draft.rows) ? draft.rows : []).map((item) =>
      createRow({
        client_id: item.client_id || makeClientId(),
        title: text(item.title),
        artist: text(item.artist),
        isrc: cleanCode(item.isrc).slice(0, 12),
        description: String(item.description ?? ""),
        source_url: text(item.source_url),
        custom_id: text(item.custom_id),
        custom_id_auto: item.custom_id_auto !== false,
        custom_token: text(item.custom_token) || randomToken(),
        notes: text(item.notes),
        asset_labels: Array.isArray(item.asset_labels) && item.asset_labels.length ? item.asset_labels : null,
        file_name: item.audio_selected || item.audio_upload_id ? text(item.file_name) : "",
        file_size: Number(item.file_size) || 0,
        audio_upload_id: text(item.audio_upload_id),
        audio_error: !item.audio_upload_id && item.audio_selected ? tk("Select this file again to finish uploading.") : ""
      })
    );
    filesRef.current.clear();
    restored.forEach((row) => {
      if (row.audio_upload_id) draftUploads.restore(row.client_id, row.audio_upload_id);
    });
    setRows(restored);
    setPendingDraft(null);
    showToast?.(restored.some((row) => row.audio_error) ? t("Draft restored — select unfinished video files again") : t("Draft restored with the uploaded files"), "info");
    verifyRestoredUploads(restored);
  }

  /** Uploads kept with a draft expire on the server after a while; flag the rows whose file is gone. */
  function verifyRestoredUploads(list) {
    const tokens = list.map((row) => row.audio_upload_id).filter(Boolean);
    if (!tokens.length) return;
    checkDraftAudio(tokens)
      .then((data) => {
        if (!mountedRef.current) return;
        const missing = new Set((Array.isArray(data?.missing) ? data.missing : []).map(String));
        if (!missing.size) return;
        list.forEach((row) => {
          if (missing.has(row.audio_upload_id)) draftUploads.forgetToken(row.client_id, row.audio_upload_id);
        });
        setRows((current) =>
          current.map((row) =>
            missing.has(row.audio_upload_id)
              ? { ...row, audio_upload_id: "", has_audio: false, audio_uploaded: false, upload_progress: 0, audio_error: tk("The uploaded file expired on the server. Select this file again.") }
              : row
          )
        );
        showToast?.(
          missing.size === 1
            ? t("{count} uploaded video file expired on the server — select it again", { count: missing.size })
            : t("{count} uploaded video files expired on the server — select them again", { count: missing.size }),
          "warning"
        );
      })
      .catch(() => {
        // The server rejects unknown uploads when the batch is saved; the row error will say so.
      });
  }

  function discardDraft() {
    (pendingDraft?.rows || []).forEach((row) => {
      if (row.audio_upload_id) deleteDraftAudio(row.audio_upload_id).catch(() => {});
    });
    writeLocalStorage(STORAGE_KEYS.videoDraft, null);
    setPendingDraft(null);
  }

  // ---------------------------------------------------------------- batch / rights helpers
  function patchBatch(patch) {
    setBatch((current) => ({ ...current, ...patch }));
  }

  function handleLabelSelect(value) {
    if (value === OTHER_VALUE) {
      setLabelOther(true);
      if (labelInList) patchBatch({ label: "" });
      return;
    }
    setLabelOther(false);
    patchBatch({ label: value });
  }

  function handleAssetTypeChange(value) {
    const next = ASSET_TYPE_META[value]?.kind === "video" ? value : "web";
    patchBatch({ asset_type: next });
  }

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

  // ---------------------------------------------------------------- row helpers
  const updateRow = useCallback((clientId, patch) => {
    setRows((current) => current.map((row) => (row.client_id !== clientId ? row : clearValidationMarker({ ...row, ...(typeof patch === "function" ? patch(row) : patch) }, row))));
  }, []);

  const removeRow = useCallback(
    (clientId) => {
      draftUploads.forget(clientId);
      filesRef.current.delete(clientId);
      setRows((current) => current.filter((row) => row.client_id !== clientId));
    },
    [draftUploads]
  );

  const regenerateCustomId = useCallback((clientId) => {
    const token = randomToken();
    setRows((current) => current.map((row) => (row.client_id === clientId ? { ...row, custom_id: "", custom_id_auto: true, custom_token: token } : row)));
  }, []);

  const attachFile = useCallback(
    async (clientId, file) => {
      if (!file) return;
      if (!isVideoFile(file.name)) {
        showToast?.(t("«{file}» is not a supported video file", { file: file.name }), "warning");
        return;
      }
      // Clips shorter than the Content ID minimum never start uploading; a pop-up explains why.
      const duration = await probeMediaDuration(file);
      if (!mountedRef.current) return;
      if (duration !== null && duration < MIN_VIDEO_REFERENCE_SECONDS) {
        setShortMedia((current) => [...current, { file, duration }]);
        return;
      }
      filesRef.current.set(clientId, file);
      updateRow(clientId, (row) => ({
        file_name: file.name,
        file_size: file.size,
        title: row.title || titleFromFilename(file.name) || stripExtension(file.name),
        isrc: row.isrc || (musicVideo ? isrcFromFilename(file.name) : "")
      }));
      draftUploads.enqueue(clientId, file);
    },
    [showToast, updateRow, draftUploads, musicVideo, t]
  );

  const detachFile = useCallback(
    (clientId) => {
      draftUploads.forget(clientId);
      filesRef.current.delete(clientId);
      updateRow(clientId, { file_name: "", file_size: 0, audio_upload_id: "", has_audio: false, audio_uploaded: false, uploading: false, upload_progress: 0, audio_error: "" });
    },
    [updateRow, draftUploads]
  );

  function addRow() {
    const row = createRow();
    setRows((current) => [...current, row]);
  }

  /** Selected / dropped files: one row per video, uploaded to the server right away. */
  async function addVideoFiles(files) {
    const candidatesFiles = (files || [])
      .filter((file) => isVideoFile(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    if (!candidatesFiles.length) {
      showToast?.(t("No supported video files were selected"), "warning");
      return;
    }
    // Read the durations first (metadata only): too-short clips are listed in a pop-up and skipped.
    const { accepted: videos, rejected } = await splitByReferenceLength(candidatesFiles);
    if (!mountedRef.current) return;
    if (rejected.length) setShortMedia((current) => [...current, ...rejected]);
    if (!videos.length) return;
    const claimed = new Set();
    const patches = new Map();
    const additions = [];
    const uploads = [];
    const candidates = rows.filter((row) => !row.file_name);

    videos.forEach((file) => {
      const name = baseName(file.name);
      const title = (titleFromFilename(name) || stripExtension(name)).toLowerCase();
      const free = candidates.filter((row) => !claimed.has(row.client_id));
      // A row typed in advance with the same title, else an empty row, else a new row.
      const target = (title && free.find((row) => text(row.title).toLowerCase() === title)) || free.find((row) => !text(row.title));
      if (target) {
        claimed.add(target.client_id);
        filesRef.current.set(target.client_id, file);
        uploads.push({ clientId: target.client_id, file });
        patches.set(target.client_id, {
          file_name: name,
          file_size: file.size,
          title: target.title || titleFromFilename(name) || stripExtension(name),
          isrc: target.isrc || (musicVideo ? isrcFromFilename(name) : "")
        });
      } else {
        const row = createRow({ file_name: name, file_size: file.size, title: titleFromFilename(name) || stripExtension(name), isrc: musicVideo ? isrcFromFilename(name) : "" });
        filesRef.current.set(row.client_id, file);
        uploads.push({ clientId: row.client_id, file });
        additions.push(row);
      }
    });

    setRows((current) => [...current.map((row) => (patches.has(row.client_id) ? { ...row, ...patches.get(row.client_id) } : row)), ...additions]);
    uploads.forEach(({ clientId, file }) => draftUploads.enqueue(clientId, file));
    const added = videos.length === 1
      ? t("Added {count} video — uploading to the server now", { count: videos.length })
      : t("Added {count} videos — uploading to the server now", { count: videos.length });
    const skipped = rejected.length === 1
      ? t("{count} clip under {seconds} s skipped", { count: rejected.length, seconds: MIN_VIDEO_REFERENCE_SECONDS })
      : t("{count} clips under {seconds} s skipped", { count: rejected.length, seconds: MIN_VIDEO_REFERENCE_SECONDS });
    showToast?.(
      `${added}${rejected.length ? ` · ${skipped}` : ""}`,
      rejected.length ? "warning" : "success"
    );
  }

  function clearRows() {
    draftUploads.clear();
    filesRef.current.clear();
    setRows([]);
    setModal("");
  }

  // Drag & drop onto the Videos card. preventDefault keeps the browser from opening the file
  // (which would unload the page and abort every upload in flight).
  function handleDragOver(event) {
    event.preventDefault();
    if (!dragging && !inputsDisabled) setDragging(true);
  }

  function handleDragLeave(event) {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    if (inputsDisabled) return;
    addVideoFiles(Array.from(event.dataTransfer?.files || []));
  }

  // ---------------------------------------------------------------- payload + run
  function buildPayload() {
    return {
      network_id: network?.id,
      product: {
        title: text(batch.title),
        artist: text(batch.artist),
        label: text(batch.label),
        upc: musicVideo ? normalizeUpc(batch.upc) || "" : "",
        release_date: musicVideo ? toDateInputValue(batch.release_date) || "" : "",
        notes: text(batch.notes),
        asset_type: assetType
      },
      rights: {
        ownership: { mode: rights.ownership.mode, territories: rights.ownership.mode === "worldwide" ? [] : rights.ownership.territories },
        match_policy_id: text(rights.match_policy_id),
        match_policy_name: policyName,
        asset_labels: rights.asset_labels
      },
      reference: { content_type: reference.content_type, urgent: Boolean(reference.urgent), include_reference: includeReference },
      options: { skip_duplicates: musicVideo ? Boolean(skipDuplicates) : false, delete_reference_after_delivery: Boolean(reference.delete_reference_after_delivery) },
      tracks: rows.map((row, index) => ({
        client_id: row.client_id,
        track_number: index + 1,
        title: text(row.title),
        artist: musicVideo ? text(row.artist) || text(batch.artist) : "",
        isrc: musicVideo ? normalizeIsrc(row.isrc) : "",
        description: text(row.description),
        source_url: text(row.source_url),
        custom_id: analysis.byId.get(row.client_id)?.customId || "",
        notes: text(row.notes),
        asset_labels: Array.isArray(row.asset_labels) && row.asset_labels.length ? row.asset_labels : null,
        file_name: row.file_name || "",
        file_size: row.file_size || 0,
        audio_upload_id: row.audio_upload_id || undefined
      }))
    };
  }

  function applyCreateErrors(error) {
    const data = error?.response?.data;
    const fieldErrors = data?.field_errors && typeof data.field_errors === "object" ? data.field_errors : {};
    const rowIds = new Set(rows.map((row) => row.client_id));
    const rowErrors = new Map();
    const formErrors = {};
    Object.entries(fieldErrors).forEach(([key, value]) => {
      if (rowIds.has(key)) rowErrors.set(key, String(value));
      else formErrors[key] = String(value);
    });
    if (rowErrors.size) {
      setRows((current) => current.map((row) => (rowErrors.has(row.client_id) ? { ...row, status: "error", step: "validate", error_message: rowErrors.get(row.client_id) } : row)));
      verifyRestoredUploads(rows.filter((row) => rowErrors.has(row.client_id) && row.audio_upload_id));
    }
    setServerErrors(formErrors);
  }

  function applyAudioErrors(created, tracksByClient) {
    const audioErrors = Array.isArray(created?.audio_errors) ? created.audio_errors : [];
    if (!audioErrors.length) return;
    const byTrack = new Map(audioErrors.map((item) => [Number(item.track_id), String(item.message || tk("The uploaded file could not be attached"))]));
    setRows((current) =>
      current.map((row) => {
        const server = tracksByClient.get(row.client_id);
        if (!server || !byTrack.has(Number(server.id))) return row;
        return { ...row, audio_upload_id: "", has_audio: false, audio_uploaded: false, audio_error: byTrack.get(Number(server.id)) };
      })
    );
    showToast?.(
      audioErrors.length === 1
        ? t("{count} video file could not be attached — upload it again from the batch page", { count: audioErrors.length })
        : t("{count} video files could not be attached — upload them again from the batch page", { count: audioErrors.length }),
      "warning"
    );
  }

  function applyProgress(data) {
    const serverTracks = Array.isArray(data?.tracks) ? data.tracks : [];
    if (!serverTracks.length) return;
    const byId = new Map(serverTracks.map((track) => [Number(track.id), track]));
    setRows((current) =>
      current.map((row) => {
        const server = row.track_id ? byId.get(Number(row.track_id)) : null;
        return server && !row.uploading ? { ...row, ...progressPatch(server, row) } : row;
      })
    );
  }

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
      const inFlight = serverTracks.some((track) => BUSY_TRACK_STATUSES.includes(track.status));
      if (!jobRunning && !inFlight) return { outcome: "finished", data };
      idlePolls = jobRunning ? 0 : idlePolls + 1;
      if (idlePolls >= POLL_MAX_IDLE) return { outcome: "interrupted", data };
      if (Date.now() - startedAt >= POLL_MAX_MS) return { outcome: "timeout", data };
      await sleep(POLL_INTERVAL_MS);
    }
    return { outcome: "cancelled" };
  }

  async function loadDuplicateDetails(productId) {
    try {
      const data = await getProduct(productId);
      if (!mountedRef.current) return;
      const list = Array.isArray(data?.product?.tracks) ? data.product.tracks : [];
      const byId = new Map(list.map((track) => [Number(track.id), track]));
      setRows((current) =>
        current.map((row) => {
          const server = row.track_id ? byId.get(Number(row.track_id)) : null;
          if (!server || row.status !== "duplicate") return row;
          return { ...row, duplicates: Array.isArray(server.duplicates) ? server.duplicates : row.duplicates };
        })
      );
    } catch {
      // Cosmetic only — the batch page lists the matches.
    }
  }

  async function runServerJob(productId, jobOptions) {
    setRun((current) => ({ ...current, phase: "delivering", stopping: false, timed_out: false, poll_error: "", job_started: true }));
    const data = await deliverProduct(productId, { delete_reference_after_delivery: Boolean(reference.delete_reference_after_delivery), ...jobOptions });
    if (!mountedRef.current) return null;
    const queued = new Set((Array.isArray(data?.job?.track_ids) ? data.job.track_ids : []).map(Number));
    if (queued.size) {
      setRows((current) => current.map((row) => (row.track_id && queued.has(Number(row.track_id)) ? { ...row, status: "creating", step: "queued", error_message: "" } : row)));
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
          ? t("{count} video failed on CMS — retry them from the batch page.", { count: errors })
          : t("{count} videos failed on CMS — retry them from the batch page.", { count: errors })
        : ""
    }));
  }

  function toastOutcome(outcome, finishedMessage, finishedTone) {
    if (outcome.outcome === "finished") showToast?.(finishedMessage, finishedTone);
    else if (outcome.outcome === "interrupted") showToast?.(t("The delivery was interrupted on the server — open the batch page and sync from CMS"), "warning");
    else showToast?.(t("Delivery is still running on the server — follow it on the batch page"), "warning");
  }

  async function deliverAndFollow(productId, jobOptions, failureLabel = tk("Delivery")) {
    try {
      const outcome = await runServerJob(productId, jobOptions);
      if (!outcome) return;
      finishRun(outcome);
      const serverTracks = outcome.data?.tracks || [];
      const errors = serverTracks.filter((track) => track.status === "error").length;
      const kept = serverTracks.filter((track) => track.has_audio).length;
      const removesFiles = jobOptions?.include_reference !== false && Boolean(reference.delete_reference_after_delivery);
      const finished = removesFiles
        ? (kept
          ? (kept === 1
            ? t("Delivery finished — {count} video file still on the server (no live reference yet)", { count: kept })
            : t("Delivery finished — {count} video files still on the server (no live reference yet)", { count: kept }))
          : t("Delivery finished — video files removed from the server"))
        : (kept
          ? (kept === 1
            ? t("Delivery finished — {count} video file kept on the server", { count: kept })
            : t("Delivery finished — {count} video files kept on the server", { count: kept }))
          : t("Delivery finished"));
      toastOutcome(outcome, errors ? t("Delivery finished with errors") : finished, errors ? "warning" : "success");
    } catch (error) {
      if (!mountedRef.current) return;
      const message = getErrorMessage(error);
      if (error?.response?.status !== 409) {
        setRows((current) => current.map((row) => (row.track_id && (row.status === "pending" || (row.status === "creating" && row.step === "queued")) ? { ...row, status: "error", step: "deliver", error_message: message } : row)));
      }
      setRun((current) => ({ ...current, phase: "done", failed: true, stopping: false, message: t("{action} could not be started: {message}. The batch is stored — continue from the batch page.", { action: t(failureLabel), message: tm(message) }) }));
      showToast?.(tm(message), "error");
    }
  }

  async function createBatch(mode) {
    setServerErrors({});
    const withFiles = analysis.counts.withFile;
    setRun({ ...IDLE_RUN, phase: "creating", mode, uploads: { total: withFiles, done: withFiles, failed: 0, skipped: 0 } });
    const payload = buildPayload();
    let created;
    try {
      created = await createProduct(payload);
    } catch (error) {
      if (!mountedRef.current) return null;
      applyCreateErrors(error);
      setRun({ ...IDLE_RUN, phase: "failed", mode, message: getErrorMessage(error) });
      showToast?.(tm(getErrorMessage(error)), "error");
      return null;
    }
    draftUploads.consume();
    writeLocalStorage(STORAGE_KEYS.videoDraft, null);
    if (!mountedRef.current) return null;
    setPendingDraft(null);
    const productId = created?.product?.id;
    const tracksByClient = mapCreatedTracks(created?.product?.tracks, payload.tracks);
    setRows((current) =>
      current.map((row) => {
        const server = tracksByClient.get(row.client_id);
        return server ? { ...row, ...progressPatch(server, row), track_id: server.id } : row;
      })
    );
    applyAudioErrors(created, tracksByClient);
    setRun((current) => ({ ...current, product_id: productId }));
    return productId;
  }

  async function saveAsDraft() {
    if (!canDeliver) return;
    const productId = await createBatch("draft");
    if (!productId) return;
    showToast?.(t("Video batch saved as a draft"), "success");
    if (mountedRef.current) setRun((current) => ({ ...current, phase: "done" }));
    onDelivered?.(productId);
  }

  /** Submit: store the batch with the uploaded files, then the server creates the assets and references. */
  async function startDelivery() {
    setModal("");
    if (!canDeliver) return;
    const productId = await createBatch("deliver");
    if (!productId) return;
    await deliverAndFollow(productId, { include_reference: includeReference });
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
      else if (server?.status === "error") showToast?.(server.error_message ? tm(server.error_message) : t("The video failed on CMS"), "error");
      else if (server?.status === "completed") showToast?.(t("Asset created and reference delivered"), "success");
      else if (server?.asset_id) showToast?.(t("Asset created on CMS"), "success");
      else showToast?.(t("Video is {status}", { status: server?.status || t("unchanged") }), "warning");
    } catch (error) {
      if (!mountedRef.current) return;
      const message = getErrorMessage(error);
      updateRow(row.client_id, { status: "duplicate", step: "", error_message: message });
      setRun((current) => ({ ...current, phase: "done", stopping: false }));
      showToast?.(tm(message), "error");
    } finally {
      if (mountedRef.current) setForcingId(null);
    }
  }

  function retryUpload(row) {
    const file = filesRef.current.get(row.client_id);
    if (run.product_id) {
      showToast?.(t("Upload the file again from the batch page"), "info");
      return;
    }
    if (file && !row.uploading) draftUploads.enqueue(row.client_id, file);
    else showToast?.(t("Select the video file again to finish uploading"), "info");
  }

  function openBatch() {
    writeLocalStorage(STORAGE_KEYS.videoDraft, null);
    setPendingDraft(null);
    onDelivered?.(run.product_id);
  }

  function handleCancel() {
    if (run.phase === "creating") return;
    if (!locked && hasContent) {
      setModal("cancel");
      return;
    }
    writeLocalStorage(STORAGE_KEYS.videoDraft, null);
    setPendingDraft(null);
    onCancel?.();
  }

  function confirmCancel() {
    draftUploads.clear();
    setModal("");
    writeLocalStorage(STORAGE_KEYS.videoDraft, null);
    setPendingDraft(null);
    onCancel?.();
  }

  // ---------------------------------------------------------------- preview plan
  const previewPlan = useMemo(() => {
    if (modal !== "preview") return null;
    const row = rows[0];
    if (!row) return null;
    const item = analysis.byId.get(row.client_id);
    const metadata = { title: text(row.title) };
    if (musicVideo) {
      const artists = (text(row.artist) || text(batch.artist)).split(/\s*[,;]\s*/).filter(Boolean);
      if (artists.length) metadata.artist = artists;
      if (normalizeIsrc(row.isrc)) metadata.isrc = normalizeIsrc(row.isrc);
      if (toDateInputValue(batch.release_date)) {
        const [year, month, day] = toDateInputValue(batch.release_date).split("-").map(Number);
        metadata.releaseDate = { year, month, day };
      }
    }
    if (text(row.description)) metadata.description = text(row.description);
    if (item?.customId) metadata.customId = item.customId;
    if (text(row.notes) || text(batch.notes)) metadata.notes = text(row.notes) || text(batch.notes);
    if (text(row.source_url)) metadata.infoUrl = text(row.source_url);
    if (musicVideo && normalizeUpc(batch.upc)) metadata.upc = normalizeUpc(batch.upc);
    const labels = Array.isArray(row.asset_labels) && row.asset_labels.length ? row.asset_labels : rights.asset_labels;
    return {
      asset: { kind: "youtubePartner#asset", type: assetType, metadataMine: metadata, label: labels },
      ownership: { kind: "youtubePartner#rightsOwnership", general: [{ ratio: 100, owner: contentOwner?.id || network?.network_code || "<content owner>", type: rights.ownership.mode === "include" ? "include" : "exclude", territories: rights.ownership.mode === "worldwide" ? [] : rights.ownership.territories }] },
      matchPolicy: { kind: "youtubePartner#assetMatchPolicy", policyId: text(rights.match_policy_id), name: policyName },
      reference: { contentType: reference.content_type, urgent: Boolean(reference.urgent), deliverAutomatically: includeReference, file: row.file_name || null, deleteFileAfterDelivery: Boolean(reference.delete_reference_after_delivery) }
    };
  }, [modal, rows, analysis, musicVideo, batch, rights, assetType, contentOwner, network, policyName, reference, includeReference]);

  const unknownServerErrors = Object.entries(serverErrors).filter(([key]) => !["title", "artist", "upc", "match_policy_id", "tracks", "network_id", "release_date", "asset_type", "ownership"].includes(key));
  const labelOptions = [...labelList.map((label) => ({ value: String(label.name || label.display_name), label: label.display_name || label.name })), { value: OTHER_VALUE, label: t("Other…") }];
  const inputsDisabled = locked;
  const showRunPanel = run.mode === "deliver" && run.phase !== "idle";
  const showFieldErrors = hasContent;

  let readinessHint;
  if (locked) {
    readinessHint = run.product_id ? t("Batch #{id} is stored. Open it to manage assets, references and takedowns.", { id: run.product_id }) : t("Working…");
  } else if (!network?.id) {
    readinessHint = t("Select a CMS to enable delivery.");
  } else if (pendingUploads) {
    readinessHint = pendingUploads === 1
      ? t("Uploading {count} video file — delivery unlocks when every upload has finished.", { count: pendingUploads })
      : t("Uploading {count} video files — delivery unlocks when every upload has finished.", { count: pendingUploads });
  } else if (failedUploads) {
    readinessHint = failedUploads === 1
      ? t("Fix or remove {count} unfinished upload before delivering.", { count: failedUploads })
      : t("Fix or remove {count} unfinished uploads before delivering.", { count: failedUploads });
  } else if (formValid) {
    readinessHint = t("Everything is valid — submit to deliver.");
  } else {
    const todo = [!batchDone && t("complete the batch info"), !rightsDone && t("choose the rights"), !videosDone && (rows.length ? t("fix the highlighted videos") : t("add at least one video"))].filter(Boolean).join(", ");
    readinessHint = `${todo.charAt(0).toUpperCase()}${todo.slice(1)}.`;
  }

  // ---------------------------------------------------------------- render
  return (
    <div className="space-y-5 pb-28">
      <Card
        actions={
          <Button variant="ghost" size="sm" icon={X} onClick={handleCancel} disabled={run.phase === "creating"}>
            {locked ? t("Back to batches") : t("Cancel")}
          </Button>
        }
        title={t("New video batch")}
        subtitle={t("Name the batch, choose the rights, drop the video files (they upload immediately), then submit: the server creates the assets in CMS, delivers each file as the reference and removes it from this server.")}
      >
        <Stepper steps={stepperSteps} active={activeStep} done={doneSteps} />
      </Card>

      {!network?.id && (
        <InlineMessage tone="warning" title={t("No CMS selected")}>
          {t("Choose a connected CMS in the header before delivering. You can still prepare the batch.")}
        </InlineMessage>
      )}

      {showDraftBanner && (
        <InlineMessage
          tone="info"
          icon={ClipboardList}
          title={t("Restore the unsaved batch?")}
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={discardDraft}>
                {t("Discard")}
              </Button>
              <Button size="sm" variant="primary" icon={RotateCcw} onClick={restoreDraft}>
                {t("Restore")}
              </Button>
            </>
          }
        >
          {pendingDraft.saved_at
            ? draftVideoCount === 1
              ? t("«{title}» · {count} video · saved {date}.", { title: draftTitle, count: draftVideoCount, date: formatDateTime(pendingDraft.saved_at) })
              : t("«{title}» · {count} videos · saved {date}.", { title: draftTitle, count: draftVideoCount, date: formatDateTime(pendingDraft.saved_at) })
            : draftVideoCount === 1
              ? t("«{title}» · {count} video.", { title: draftTitle, count: draftVideoCount })
              : t("«{title}» · {count} videos.", { title: draftTitle, count: draftVideoCount })}{" "}
          {t("Completed uploads are restored; unfinished ones need the file selected again.")}
        </InlineMessage>
      )}

      {unknownServerErrors.length > 0 && (
        <InlineMessage tone="error" title={t("The server rejected the batch")}>
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
          words={{
            // tm() rather than t(): the legacy short-key dictionary maps the key "video" to "Video" in English.
            item: tm("video"),
            items: t("videos"),
            media: t("video files"),
            entity: t("batch"),
            stepsHint: t("{assetType} asset · ownership · match policy · labels · {contentType} reference", { assetType: t(typeMeta.label), contentType: reference.content_type }),
            stepsHintNoReference: t("{assetType} asset · ownership · match policy · labels (references off)", { assetType: t(typeMeta.label) })
          }}
          onStop={() => {}}
          onOpen={openBatch}
          onDismiss={() => setRun(IDLE_RUN)}
          onDeliverNow={null}
        />
      )}

      {/* Step 1: batch */}
      <Card eyebrow={t("Step 1")} icon={Clapperboard} title={t("Batch")} subtitle={t("Groups the videos delivered together. The asset type and custom-ID prefix apply to every video.")}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("Batch name")} required htmlFor="vb-title" error={tm(serverErrors.title) || (showFieldErrors ? batchErrors.title : undefined)} hint={t("For your own records (not sent to CMS), e.g. «Channel X · October uploads».")}>
            <TextInput id="vb-title" value={batch.title} disabled={inputsDisabled} placeholder={t("e.g. Channel X · October uploads")} onChange={(event) => patchBatch({ title: event.target.value })} />
          </Field>
          <Field label={t("Asset type")} required hint={assetTypeOption ? t(assetTypeOption.description) : undefined}>
            <Select value={assetType} disabled={inputsDisabled || rows.some((row) => row.track_id)} options={VIDEO_ASSET_TYPE_OPTIONS.map(({ value, label }) => ({ value, label: t(label) }))} onChange={(event) => handleAssetTypeChange(event.target.value)} />
          </Field>
          <Field label={musicVideo ? t("Artist") : t("Creator / channel")} htmlFor="vb-artist" error={tm(serverErrors.artist)} hint={musicVideo ? t("Default artist of every music video (comma separated).") : t("Optional, for your records and as a fallback custom-ID prefix.")}>
            <TextInput id="vb-artist" value={batch.artist} disabled={inputsDisabled} placeholder={musicVideo ? t("e.g. Lena Park") : t("e.g. Channel ABC")} onChange={(event) => patchBatch({ artist: event.target.value })} />
          </Field>
          <Field label={t("Custom ID prefix (label)")} htmlFor="vb-label" hint={musicVideo ? t("Generated custom IDs look like {prefix}_Ab3dE9fGh1Jk (or PREFIX_ISRC when an ISRC is set).", { prefix }) : t("Generated custom IDs look like {prefix}_Ab3dE9fGh1Jk.", { prefix })}>
            <div className="space-y-2">
              <Select id="vb-label" value={labelInList ? batch.label : showLabelInput ? OTHER_VALUE : ""} disabled={inputsDisabled} placeholder={t("Select a label")} options={labelOptions} onChange={(event) => handleLabelSelect(event.target.value)} />
              {showLabelInput && <TextInput value={batch.label} disabled={inputsDisabled} placeholder={t("Type the prefix")} onChange={(event) => patchBatch({ label: event.target.value })} />}
            </div>
          </Field>
          {musicVideo && (
            <Field label="UPC" htmlFor="vb-upc" error={batchErrors.upc || tm(serverErrors.upc)} hint={t("Optional. Written on every music video asset.")}>
              <TextInput id="vb-upc" mono value={batch.upc} disabled={inputsDisabled} invalid={Boolean(batchErrors.upc)} placeholder="0000000000000" maxLength={14} onChange={(event) => patchBatch({ upc: cleanCode(event.target.value).slice(0, 14) })} />
            </Field>
          )}
          {musicVideo && (
            <Field label={t("Release date")} htmlFor="vb-date" error={tm(serverErrors.release_date)} hint={t("Optional. Written as releaseDate on every music video asset.")}>
              <TextInput id="vb-date" type="date" value={batch.release_date} disabled={inputsDisabled} onChange={(event) => patchBatch({ release_date: event.target.value })} />
            </Field>
          )}
          <Field label={t("Notes")} htmlFor="vb-notes" className="md:col-span-2" error={tm(serverErrors.notes) || (showFieldErrors ? batchErrors.notes : undefined)} hint={t("Internal notes written to every asset unless a video has its own notes (255 bytes max).")}>
            <TextArea id="vb-notes" rows={2} value={batch.notes} invalid={Boolean(batchErrors.notes)} disabled={inputsDisabled} placeholder={t("Optional")} onChange={(event) => patchBatch({ notes: event.target.value })} />
          </Field>
        </div>
      </Card>

      {/* Step 2: rights */}
      <Card eyebrow={t("Step 2")} icon={ShieldCheck} title={t("Rights & reference")} subtitle={t("Ownership, match policy and asset labels applied to every asset; how the file is delivered and what happens to it afterwards.")}>
        <div className="grid gap-5 lg:grid-cols-2">
          <Field label={t("Ownership")} required hint={t("100% owned by this content owner. Worldwide sends an empty exclude list.")}>
            <TerritoryPicker mode={rights.ownership.mode} territories={rights.ownership.territories} disabled={inputsDisabled} onChange={(next) => setRights((current) => ({ ...current, ownership: next }))} />
          </Field>
          <Field label={t("Match policy")} required error={tm(serverErrors.match_policy_id) || (showFieldErrors ? rightsErrors.policy : undefined)} hint={t("Saved policies come from CMS. Applied as the asset match policy.")}>
            <PolicySelect policies={policies} value={rights.match_policy_id} loading={optionsLoading} error={tm(options?.errors?.policies) || ""} disabled={inputsDisabled} onChange={handlePolicyChange} />
          </Field>
          <Field label={t("Asset labels")} hint={t("Optional. Applied to every video unless a video overrides them. Type a new name to create it in CMS.")} error={tm(options?.errors?.asset_labels) || undefined}>
            <ChipInput values={rights.asset_labels} suggestions={assetLabelSuggestions} disabled={inputsDisabled} allowCreate onCreate={handleCreateLabel} placeholder={t("Add asset labels…")} onChange={(next) => setRights((current) => ({ ...current, asset_labels: next }))} />
          </Field>
          <div className="grid gap-4">
            <Field label={t("Reference settings")} hint={t("Video files upload as soon as you select them and stay linked to their video when the batch is submitted.")}>
              <div className="space-y-3">
                <Toggle checked={includeReference} disabled={inputsDisabled} label={t("Deliver the video file as the reference automatically")} description={t("Right after each asset is created. Off = assets only; deliver references later from the batch page.")} onChange={(value) => setReference((current) => ({ ...current, upload_reference: value }))} />
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <Select value={reference.content_type} disabled={inputsDisabled} options={REFERENCE_TYPE_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))} onChange={(event) => setReference((current) => ({ ...current, content_type: event.target.value }))} />
                  <Toggle checked={reference.urgent} disabled={inputsDisabled} label={t("Urgent")} description={t("Prioritise fingerprinting")} onChange={(value) => setReference((current) => ({ ...current, urgent: value }))} />
                </div>
                <Toggle
                  checked={reference.delete_reference_after_delivery}
                  disabled={inputsDisabled}
                  label={t("Delete the video file from this server after successful delivery")}
                  description={t("Recommended for video masters: the file is removed as soon as CMS holds the reference. Failed uploads keep their file for retry; the CMS reference and the delivery log are kept.")}
                  onChange={(value) => setReference((current) => ({ ...current, delete_reference_after_delivery: value }))}
                />
              </div>
            </Field>
            {musicVideo && (
              <Field label={t("Duplicates")}>
                <Toggle checked={skipDuplicates} disabled={inputsDisabled} label={t("Skip ISRCs that already exist in CMS")} description={t("Matching assets are reported as duplicates; you can still create them one by one.")} onChange={setSkipDuplicates} />
              </Field>
            )}
          </div>
        </div>
      </Card>

      {/* Step 3: videos */}
      <Card
        eyebrow={t("Step 3")}
        icon={FileVideo}
        title={t("Videos")}
        subtitle={t("One asset per video. Choose or drop the files: each one is uploaded to the server right away and matched to its row.")}
        actions={
          <>
            <FilePickerButton accept={VIDEO_ACCEPT} multiple icon={FileVideo} size="sm" disabled={inputsDisabled} onFiles={addVideoFiles}>
              {t("Choose video files")}
            </FilePickerButton>
            <FilePickerButton directory icon={FolderOpen} size="sm" disabled={inputsDisabled} onFiles={addVideoFiles}>
              {t("Choose folder")}
            </FilePickerButton>
            <Button variant="secondary" size="sm" icon={Plus} disabled={inputsDisabled} onClick={addRow}>
              {t("Add row")}
            </Button>
            <Button variant="ghost" size="sm" icon={Trash2} disabled={inputsDisabled || !rows.length} onClick={() => setModal("clear")}>
              {t("Clear")}
            </Button>
          </>
        }
      >
        <div
          className={cx("rounded-2xl transition", dragging && "bg-indigo-50 outline-2 outline-dashed outline-indigo-300")}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
        {rows.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone="slate" icon={FileVideo}>
              {analysis.counts.total === 1 ? t("{count} video", { count: analysis.counts.total }) : t("{count} videos", { count: analysis.counts.total })}
            </Badge>
            <Badge tone={analysis.counts.withFile === analysis.counts.total ? "emerald" : "amber"} icon={Upload}>
              {t("{count} with a file", { count: analysis.counts.withFile })}
            </Badge>
            {pendingUploads > 0 && (
              <Badge tone="indigo" icon={Loader2}>
                {t("{count} uploading", { count: pendingUploads })}
              </Badge>
            )}
            {analysis.counts.missingTitle > 0 && <Badge tone="red">{t("{count} missing title", { count: analysis.counts.missingTitle })}</Badge>}
            {analysis.counts.invalidIsrc > 0 && <Badge tone="red">{t("{count} invalid ISRC", { count: analysis.counts.invalidIsrc })}</Badge>}
            {analysis.counts.duplicateIsrc > 0 && <Badge tone="red">{t("{count} duplicate ISRC", { count: analysis.counts.duplicateIsrc })}</Badge>}
            {analysis.counts.invalidUrl > 0 && <Badge tone="red">{t("{count} invalid URL", { count: analysis.counts.invalidUrl })}</Badge>}
            {analysis.counts.tooLong > 0 && <Badge tone="red">{t("{count} description/notes too long", { count: analysis.counts.tooLong })}</Badge>}
            {analysis.counts.invalid === 0 && uploadsReady && (
              <Badge tone="emerald" icon={CheckCircle2}>
                {t("Ready")}
              </Badge>
            )}
          </div>
        )}

        {serverErrors.tracks && <InlineMessage tone="error" className="mb-4">{tm(serverErrors.tracks)}</InlineMessage>}

        {rows.length === 0 ? (
          <EmptyState
            icon={FileVideo}
            title={t("No videos yet")}
            description={t("Choose or drop the video files of this batch here (MP4, MOV, MKV, AVI, WEBM…). Titles are taken from the file names and every file starts uploading immediately. Clips shorter than {seconds} seconds cannot be used as references and are refused.", { seconds: MIN_VIDEO_REFERENCE_SECONDS })}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <FilePickerButton accept={VIDEO_ACCEPT} multiple icon={FileVideo} variant="primary" disabled={inputsDisabled} onFiles={addVideoFiles}>
                  {t("Choose video files")}
                </FilePickerButton>
                <Button variant="secondary" icon={Plus} disabled={inputsDisabled} onClick={addRow}>
                  {t("Add row")}
                </Button>
              </div>
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className={cx("w-full text-left text-sm", musicVideo ? "min-w-[1760px]" : "min-w-[1480px]")}>
              <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-10 px-2 py-2.5">#</th>
                  <th className="w-56 px-2 py-2.5">{t("Video file")}</th>
                  <th className="w-52 px-2 py-2.5">
                    {t("Title")} <span className="text-red-500">*</span>
                  </th>
                  {musicVideo && <th className="w-40 px-2 py-2.5">{t("Artist(s)")}</th>}
                  {musicVideo && <th className="w-36 px-2 py-2.5">ISRC</th>}
                  <th className="w-64 px-2 py-2.5">{t("Description")}</th>
                  <th className="w-56 px-2 py-2.5">{t("Custom ID")}</th>
                  <th className="w-52 px-2 py-2.5">{t("Official URL")}</th>
                  <th className="w-48 px-2 py-2.5">{t("Asset labels override")}</th>
                  <th className="w-36 px-2 py-2.5">{t("Notes")}</th>
                  <th className="w-44 px-2 py-2.5">{t("Status")}</th>
                  <th className="w-12 px-2 py-2.5" aria-label={t("Remove")} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <VideoRow
                    key={row.client_id}
                    row={row}
                    index={index}
                    meta={analysis.byId.get(row.client_id)}
                    assetType={assetType}
                    defaultArtist={text(batch.artist)}
                    assetLabelSuggestions={assetLabelSuggestions}
                    locked={inputsDisabled}
                    forcing={forcingId === row.client_id}
                    showCreateAnyway={Boolean(run.product_id) && !busy && row.status === "duplicate"}
                    canRetryUpload={!run.product_id && Boolean(filesRef.current.get(row.client_id))}
                    onUpdate={updateRow}
                    onRemove={removeRow}
                    onAttach={attachFile}
                    onDetach={detachFile}
                    onRegenerate={regenerateCustomId}
                    onCreateAnyway={createAnyway}
                    onRetryUpload={retryUpload}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {dragging && <p className="mt-3 text-center text-xs font-black text-indigo-700">{t("Drop the video files to add them — they start uploading right away.")}</p>}
        </div>
      </Card>

      {/* Sticky submit bar */}
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
                <Button variant="primary" icon={ExternalLink} onClick={openBatch}>
                  {t("Open batch")}
                </Button>
              ) : (
                <>
                  <Button variant="secondary" icon={Save} disabled={!canDeliver} loading={run.phase === "creating" && run.mode === "draft"} onClick={saveAsDraft}>
                    {t("Save as draft")}
                  </Button>
                  <Button variant="secondary" icon={Eye} disabled={!rows.length} onClick={() => setModal("preview")}>
                    {t("Preview plan")}
                  </Button>
                  <Button variant="primary" icon={CloudUpload} disabled={!canDeliver} loading={running && run.mode === "deliver"} onClick={() => setModal("confirm")}>
                    {t("Submit delivery")}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={modal === "confirm"}
        title={t("Deliver this batch to CMS?")}
        message={t("The batch and its uploaded video files are stored on the server; the server then creates the assets on YouTube CMS through the Content ID API, delivers each file as the reference and, when enabled, removes the file from this server. You can follow the progress here or on the batch page.")}
        confirmLabel={rows.length === 1 ? t("Deliver {count} video", { count: rows.length }) : t("Deliver {count} videos", { count: rows.length })}
        tone="primary"
        onConfirm={startDelivery}
        onCancel={() => setModal("")}
      >
        <DefinitionList
          items={[
            { label: "CMS", value: network?.name || "—" },
            { label: t("Content owner"), value: contentOwner ? `${contentOwner.display_name || ""} ${contentOwner.id ? `(${contentOwner.id})` : ""}`.trim() : network?.network_code || "—" },
            { label: t("Batch"), value: text(batch.title) },
            { label: t("Asset type"), value: t(typeMeta.label) },
            { label: t("Videos"), value: t("{count} asset(s)", { count: rows.length }) },
            { label: t("Ownership"), value: summarizeOwnership(rights.ownership.mode, rights.ownership.territories) },
            { label: t("Match policy"), value: policyName || "—" },
            { label: t("Asset labels"), value: rights.asset_labels.length ? rights.asset_labels.join(", ") : t("None") },
            { label: t("Files"), value: t("{uploaded} of {total} uploaded to the server", { uploaded: analysis.counts.withFile, total: rows.length }) },
            {
              label: t("References"),
              value: includeReference
                ? reference.urgent
                  ? t("Delivered by the server ({contentType} · urgent)", { contentType: reference.content_type })
                  : t("Delivered by the server ({contentType})", { contentType: reference.content_type })
                : t("Not delivered now — deliver later from the batch page")
            },
            { label: t("Server files"), value: reference.delete_reference_after_delivery ? t("Deleted after each successful reference delivery") : t("Kept after delivery") }
          ]}
        />
      </ConfirmDialog>

      <ConfirmDialog open={modal === "clear"} title={t("Remove all videos?")} message={t("Every row and uploaded file is removed from the form (uploaded files are deleted from the server). The batch info is kept.")} confirmLabel={t("Clear videos")} tone="danger" onConfirm={clearRows} onCancel={() => setModal("")} />

      <ConfirmDialog open={modal === "cancel"} title={t("Discard this batch?")} message={t("The form, the autosaved draft and the files uploaded so far are discarded. Nothing has been sent to CMS.")} confirmLabel={t("Discard")} tone="danger" onConfirm={confirmCancel} onCancel={() => setModal("")} />

      <DeliveryLogViewer productId={run.product_id} tracks={rows.filter((row) => row.track_id).map((row) => ({ ...row, id: row.track_id }))} open={modal === "logs"} onClose={() => setModal("")} />

      <ShortMediaDialog items={shortMedia} onClose={() => setShortMedia([])} />

      <Modal
        open={modal === "preview"}
        title={t("Delivery plan preview")}
        subtitle={rows[0] ? t("What the server sends to CMS for video 1 «{title}». Other videos follow the same shape.", { title: text(rows[0].title) || t("untitled") }) : t("Add a video to preview the plan.")}
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
                <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-400">{t("Match policy · reference")}</p>
                <JsonViewer value={{ matchPolicy: previewPlan.matchPolicy, reference: previewPlan.reference }} maxHeight={200} />
              </div>
              <InlineMessage tone="neutral" icon={Info}>
                {reference.delete_reference_after_delivery
                  ? t("The server creates the asset, sets the ownership, applies the match policy, then uploads the stored file as the {contentType} reference and deletes the file from this server once CMS holds it.", { contentType: reference.content_type })
                  : t("The server creates the asset, sets the ownership, applies the match policy, then uploads the stored file as the {contentType} reference.", { contentType: reference.content_type })}
              </InlineMessage>
            </div>
          </div>
        ) : (
          <EmptyState compact icon={FileVideo} title={t("Nothing to preview")} description={t("Add at least one video.")} />
        )}
      </Modal>
    </div>
  );
}
