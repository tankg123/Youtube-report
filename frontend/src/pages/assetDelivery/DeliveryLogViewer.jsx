import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  Globe,
  History,
  ListChecks,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  SkipForward,
  UserRound
} from "lucide-react";
import { exportProductLogs, getProductLogRuns, getProductLogs } from "../../api/deliveryApi";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { EVENT_ACTION_META, LOG_ACTION_GROUPS, STEP_LABELS } from "./constants";
import { useDebouncedValue } from "./hooks";
import { Badge, Button, EmptyState, Field, InlineMessage, JsonViewer, Modal, ProgressBar, Select, Spinner, TextInput } from "./shared";
import { cx, downloadBlob, downloadTextFile, formatBytes, formatDateTime, getErrorMessage } from "./utils";

const PAGE_SIZE = 100;
const POLL_MS = 2000;
const RUNS_POLL_MS = 5000;
const ERROR_STATUSES = new Set(["error", "failed", "failure"]);
const RUN_STATUS_META = {
  running: { label: tk("Running"), tone: "blue", spin: true },
  completed: { label: tk("Completed"), tone: "emerald" },
  error: { label: tk("Finished with errors"), tone: "red" },
  interrupted: { label: tk("Interrupted"), tone: "amber" }
};

function payloadOf(event) {
  const value = event.payload ?? event.payload_json;
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value || "{}");
  } catch {
    return { detail: value };
  }
}

function eventTone(event) {
  const status = String(event.status || "").toLowerCase();
  if (ERROR_STATUSES.has(status)) return "red";
  if (["success", "completed", "ok"].includes(status)) return "emerald";
  if (["warning", "skipped"].includes(status)) return "amber";
  if (status === "started" || status === "progress") return "blue";
  return "slate";
}

function actionLabel(action) {
  return EVENT_ACTION_META?.[action]?.label || String(action || "event").replace(/_/g, " ");
}

// `t` comes from the calling component's useI18n() so the units follow the UI language.
function formatDuration(ms, t) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return t("{value} ms", { value: Math.round(value) });
  if (value < 60000) return t("{value} s", { value: (value / 1000).toFixed(value < 10000 ? 1 : 0) });
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return seconds ? t("{minutes} min {seconds} s", { minutes, seconds }) : t("{minutes} min", { minutes });
}

function runLabel(run, index, t) {
  const started = formatDateTime(run.started_at || run.finished_at) || t("unknown time");
  const meta = RUN_STATUS_META[run.status] || RUN_STATUS_META.running;
  const params = { index, started, status: t(meta.label), count: run.track_count };
  if (!run.track_count) return t("Run {index} · {started} · {status}", params);
  return run.track_count === 1 ? t("Run {index} · {started} · {status} · {count} track", params) : t("Run {index} · {started} · {status} · {count} tracks", params);
}

// The newest delivery_progress event of a batch (pages arrive newest-first, polls oldest-first).
function newestProgress(batch) {
  return batch.reduce((best, event) => (event.action === "delivery_progress" && Number(event.id) > Number(best?.id ?? -1) ? event : best), null);
}

function LogEvent({ event }) {
  const { t, tm } = useI18n();
  const payload = payloadOf(event);
  const tone = eventTone(event);
  const inFlight = event.status === "started" || event.status === "progress";
  // Static component references only (no factory call): the lint rule for stable components.
  const MetaIcon = EVENT_ACTION_META?.[event.action]?.icon || Activity;
  const Icon = tone === "red"
    ? AlertCircle
    : tone === "amber"
      ? (event.status === "skipped" ? SkipForward : AlertTriangle)
      : event.action === "api"
        ? Globe
        : inFlight
          ? Loader2
          : tone === "emerald"
            ? CheckCircle2
            : MetaIcon;
  const spinning = inFlight && tone !== "red" && tone !== "amber" && event.action !== "api";
  const title = event.track_title
    ? `${event.track_number ? `${event.track_number}. ` : ""}${event.track_title}`
    : event.track_id ? t("Track #{id}", { id: event.track_id }) : t("Product");
  const detail = payload && typeof payload === "object" && Object.keys(payload).length > 0;
  const step = payload?.step ? t(STEP_LABELS[payload.step] || payload.step) : "";
  const api = event.action === "api" && payload?.method ? `${payload.method} ${payload.endpoint || ""}` : "";
  const percent = payload?.percent != null && Number.isFinite(Number(payload.percent)) ? Number(payload.percent) : null;
  const showBar = percent != null && (event.status === "progress" || event.action === "delivery_progress" || (payload?.bytes_total && event.status !== "ok"));

  return (
    <li className={cx("rounded-2xl border p-3.5", tone === "red" ? "border-red-200 bg-red-50" : tone === "amber" ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-white")}>
      <div className="flex items-start gap-3">
        <span className={cx("mt-0.5 shrink-0 rounded-xl p-2", tone === "red" ? "bg-red-100 text-red-600" : tone === "emerald" ? "bg-emerald-50 text-emerald-700" : tone === "amber" ? "bg-amber-100 text-amber-700" : tone === "blue" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600")}>
          <Icon size={16} className={spinning ? "animate-spin" : undefined} />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words text-sm font-black text-slate-900">{title}</span>
            <Badge tone={tone === "slate" ? "slate" : tone}>{t(actionLabel(event.action))}</Badge>
            {event.status && event.status !== "ok" && <Badge tone={tone}>{tm(event.status)}</Badge>}
            {step && <Badge tone="slate">{step}</Badge>}
            <time className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500" title={event.created_at}>
              <Clock size={11} /> {formatDateTime(event.created_at)}
            </time>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{api ? <span className="mr-2 font-mono text-xs font-bold text-slate-500">{api}</span> : null}{event.message ? tm(event.message) : t("Event recorded")}</p>
          {showBar && <ProgressBar value={percent} size="sm" tone={tone === "red" ? "red" : "blue"} showValue label={payload?.bytes_total ? `${formatBytes(payload.bytes_loaded || 0)} / ${formatBytes(payload.bytes_total)}` : undefined} />}
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-slate-500">
            <span>#{event.id}</span>
            {payload?.attempt > 1 && <span>{t("attempt {attempt}", { attempt: payload.attempt })}</span>}
            {payload?.http_status != null && <span>HTTP {payload.http_status}</span>}
            {payload?.timeout_ms > 0 && event.action === "api" && event.status !== "ok" && <span>{t("deadline {duration}", { duration: formatDuration(payload.timeout_ms, t) })}</span>}
            {payload?.retry_delay_ms != null && <span>{t("retry in {duration}", { duration: formatDuration(payload.retry_delay_ms, t) })}</span>}
            {payload?.duration_ms != null && <span>{formatDuration(payload.duration_ms, t)}</span>}
            {percent != null && !showBar && <span>{percent}%</span>}
            {payload?.asset_id && <span>{t("asset {id}", { id: payload.asset_id })}</span>}
            {(payload?.reference_id || payload?.reference?.id) && <span>{t("ref {id}", { id: payload.reference_id || payload.reference.id })}</span>}
            {payload?.bytes_freed != null && <span>{t("{bytes} freed", { bytes: formatBytes(payload.bytes_freed) })}</span>}
            {payload?.run_id && <span className="break-all" title={payload.run_id}>{t("run {id}", { id: String(payload.run_id).slice(0, 8) })}</span>}
            {event.created_by_name && (
              <span className="inline-flex items-center gap-1">
                <UserRound size={11} /> {event.created_by_name}
              </span>
            )}
          </div>
          {detail && (
            <details className="text-xs text-slate-500">
              <summary className="w-fit cursor-pointer font-bold hover:text-blue-700">{t("View event details")}</summary>
              <JsonViewer value={payload} maxHeight={280} className="mt-2" />
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

function RunSummary({ run, index, latestProgress }) {
  const { t, tm } = useI18n();
  if (!run) return null;
  const meta = RUN_STATUS_META[run.status] || RUN_STATUS_META.running;
  const summary = run.summary || {};
  // Only a progress event of this very run may fill the bar (older runs end at 100%).
  const percent = run.status === "running" ? (latestProgress?.runId === run.run_id ? latestProgress.percent : 0) : 100;
  return (
    <div className={cx("rounded-2xl border p-4", run.status === "error" ? "border-red-200 bg-red-50/60" : run.status === "interrupted" ? "border-amber-200 bg-amber-50/60" : run.status === "running" ? "border-blue-200 bg-blue-50/60" : "border-emerald-200 bg-emerald-50/50")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone} icon={meta.spin ? Loader2 : run.status === "completed" ? CheckCircle2 : run.status === "error" ? AlertCircle : AlertTriangle}>
          {t(meta.label)}
        </Badge>
        <span className="text-sm font-black text-slate-900">{t("Run {index}", { index })}</span>
        <span className="text-xs font-bold text-slate-500">
          {run.started_at ? t("started {time}", { time: formatDateTime(run.started_at) }) : ""}
          {run.finished_at ? ` · ${t("finished {time}", { time: formatDateTime(run.finished_at) })}` : ""}
          {run.duration_ms != null ? ` · ${formatDuration(run.duration_ms, t)}` : ""}
          {run.created_by_name ? ` · ${run.created_by_name}` : ""}
        </span>
        <span className="ml-auto font-mono text-[11px] text-slate-400" title={run.run_id}>{String(run.run_id).slice(0, 8)}</span>
      </div>
      {run.status === "running" && (
        <div className="mt-3">
          <ProgressBar value={percent || 0} size="sm" tone="blue" showValue label={t("Tracks processed")} />
        </div>
      )}
      <div className="mt-3 grid gap-2 text-xs font-bold text-slate-600 sm:grid-cols-5">
        <span>{t("Tracks:")} <span className="text-slate-900">{run.track_count || 0}</span></span>
        <span>{t("Assets created:")} <span className="text-slate-900">{summary.created ?? "–"}</span></span>
        <span>{t("References:")} <span className="text-slate-900">{summary.references ?? "–"}</span></span>
        <span>{t("Duplicates:")} <span className="text-slate-900">{summary.duplicate ?? "–"}</span></span>
        <span>{t("Errors:")} <span className={summary.error ? "text-red-600" : "text-slate-900"}>{summary.error ?? "–"}</span></span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-bold text-slate-500">
        {run.include_reference != null && <span>{run.include_reference ? t("References delivered automatically") : t("References not delivered in this run")}</span>}
        {run.delete_reference_after_delivery != null && <span>{run.delete_reference_after_delivery ? t("Server audio removed after delivery") : t("Server audio kept")}</span>}
        {run.message && run.status !== "running" && <span className="break-words">{tm(run.message)}</span>}
      </div>
    </div>
  );
}

// Remount this component when server filters change. Each request generation
// owns its cursors, so an old response cannot overwrite a newly selected track.
function LogStream({ productId, filters, live, onTracks, onJob, onLatestProgress }) {
  const { t, tm } = useI18n();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState("");
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");
  const requestRef = useRef(null);
  const liveRef = useRef(live);
  const listRef = useRef(null);
  const { trackId, runId, action, status, search } = filters;

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    let alive = true;
    let inFlight = null;
    let initialized = false;
    let newestId = 0;
    let oldestId = null;
    let olderAvailable = false;
    let lastProgressId = 0;

    async function request(mode = "new") {
      if (inFlight) {
        await inFlight;
        if (alive && mode === "older") return request(mode);
        return;
      }
      const operation = async () => {
        try {
          let keepReading = true;
          while (keepReading && alive) {
            const params = {
              limit: PAGE_SIZE,
              track_id: trackId || undefined,
              run_id: runId || undefined,
              action: action || undefined,
              status: status || undefined,
              search: search || undefined
            };
            if (initialized && mode === "older" && oldestId) params.before_id = oldestId;
            else if (initialized && mode !== "older") params.after_id = newestId;
            const data = await getProductLogs(productId, params);
            if (!alive) return;
            const batch = Array.isArray(data?.events) ? data.events : [];
            const ids = batch.map((event) => Number(event.id)).filter(Number.isFinite);
            const previousNewest = newestId;
            // Advance only past events actually received. latest_id may point
            // beyond this page, which would skip events during a busy delivery.
            if (ids.length) newestId = Math.max(newestId, ...ids);
            if (!initialized || mode === "older") {
              oldestId = data?.next_before_id || (ids.length ? Math.min(...ids) : oldestId);
              olderAvailable = Boolean(data?.has_more);
              setHasOlder(olderAvailable);
            }
            setEvents((current) => {
              const unique = new Map(current.map((event) => [event.id, event]));
              batch.forEach((event) => unique.set(event.id, event));
              return [...unique.values()].sort((a, b) => Number(a.id) - Number(b.id));
            });
            onTracks(batch);
            onJob(Boolean(data?.job?.running));
            // Only ever move the run's progress bar forward (older pages must not rewind it).
            const progress = mode === "older" ? null : newestProgress(batch);
            if (progress && Number(progress.id) > lastProgressId) {
              lastProgressId = Number(progress.id);
              const payload = payloadOf(progress);
              onLatestProgress({ runId: payload.run_id || null, percent: Number(payload.percent) || 0 });
            }
            setError("");
            setCheckedAt(new Date());
            keepReading = initialized && mode !== "older" && Boolean(data?.has_more) && newestId > previousNewest;
            initialized = true;
          }
        } catch (err) {
          if (alive) setError(getErrorMessage(err));
        } finally {
          inFlight = null;
          if (alive) {
            setLoading(false);
            setActivity("");
          }
        }
      };
      inFlight = operation();
      return inFlight;
    }

    requestRef.current = request;
    request();
    const timer = window.setInterval(() => {
      if (liveRef.current && document.visibilityState !== "hidden") request();
    }, POLL_MS);
    return () => {
      alive = false;
      requestRef.current = null;
      window.clearInterval(timer);
    };
  }, [productId, trackId, runId, action, status, search, onTracks, onJob, onLatestProgress]);

  const errors = events.filter((event) => ERROR_STATUSES.has(String(event.status || "").toLowerCase())).length;

  function request(mode) {
    setActivity(mode);
    requestRef.current?.(mode);
  }

  function exportLoaded() {
    const content = events.map((event) => JSON.stringify({ ...event, payload: payloadOf(event) })).join("\n");
    downloadTextFile(content, `delivery-${productId}${trackId ? `-track-${trackId}` : ""}-loaded-logs.jsonl`, "application/x-ndjson;charset=utf-8");
  }

  async function exportAll(format) {
    setExporting(format);
    setExportError("");
    try {
      const { blob, fileName } = await exportProductLogs(productId, {
        format,
        track_id: trackId || undefined,
        run_id: runId || undefined,
        action: action || undefined,
        status: status || undefined,
        search: search || undefined
      });
      downloadBlob(blob, fileName);
    } catch (err) {
      // Kept apart from the poll error so the next successful refresh does not wipe it.
      setExportError(getErrorMessage(err));
    } finally {
      setExporting("");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50 p-3">
        <Badge tone={live ? "emerald" : "slate"} icon={live ? Activity : Pause}>{live ? t("Live · every 2 s") : t("Auto-refresh paused")}</Badge>
        <span className="text-xs font-bold text-slate-500" aria-live="polite">
          {errors === 1 ? t("{count} loaded · {errors} error", { count: events.length, errors }) : t("{count} loaded · {errors} errors", { count: events.length, errors })}
          {checkedAt ? ` · ${t("checked {time}", { time: checkedAt.toLocaleTimeString() })}` : ""}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={activity === "new"} disabled={loading || Boolean(activity)} onClick={() => request("new")}>
            {t("Refresh")}
          </Button>
          <Button size="sm" variant="secondary" icon={Download} loading={exporting === "jsonl"} disabled={Boolean(exporting)} onClick={() => exportAll("jsonl")} title={t("Download every matching event from the server as JSON lines")}>
            {t("Download full log")}
          </Button>
          <Button size="sm" variant="secondary" icon={FileSpreadsheet} loading={exporting === "csv"} disabled={Boolean(exporting)} onClick={() => exportAll("csv")} title={t("Download every matching event from the server as CSV")}>
            CSV
          </Button>
          <Button size="sm" variant="ghost" icon={Download} disabled={!events.length} onClick={exportLoaded} title={t("Save only the events currently loaded in this window")}>
            {t("Loaded only")}
          </Button>
          <Button size="sm" variant="ghost" icon={ArrowDown} disabled={!events.length} onClick={() => listRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" })}>
            {t("Latest")}
          </Button>
        </div>
      </div>
      {error && (
        <InlineMessage tone="error" title={t("Could not refresh logs")}>
          {tm(error)} {live ? t("The viewer will retry automatically.") : t("Use Refresh to try again.")}
        </InlineMessage>
      )}
      {exportError && (
        <InlineMessage tone="error" title={t("Could not download the log")} actions={<Button size="sm" variant="ghost" onClick={() => setExportError("")}>{t("Dismiss")}</Button>}>
          {tm(exportError)}
        </InlineMessage>
      )}
      {hasOlder && (
        <Button size="sm" variant="secondary" icon={History} loading={activity === "older"} disabled={loading || Boolean(activity)} onClick={() => request("older")}>
          {t("Load older events")}
        </Button>
      )}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
          <Spinner size={18} /> {t("Loading saved logs…")}
        </div>
      ) : !events.length ? (
        <EmptyState
          compact
          icon={History}
          title={t("No events match these filters")}
          description={search || trackId || runId || action || status ? t("Widen the filters or clear the search to see more of the saved history.") : t("Delivery, track operations and API activity will appear here as they are recorded.")}
        />
      ) : (
        <ol ref={listRef} className="space-y-2.5" aria-label={t("Delivery log, oldest to newest")}>
          {events.map((event) => (
            <LogEvent key={event.id} event={event} />
          ))}
        </ol>
      )}
      <p className="text-xs text-slate-400">{t("Logs are saved on the server with every delivery run, track step and CMS API call. You can close this window and come back later; downloads include the full history for the current filters.")}</p>
    </div>
  );
}

function LogPanel({ productId, trackId, tracks }) {
  const { t, tm } = useI18n();
  const [selectedTrack, setSelectedTrack] = useState(trackId ? String(trackId) : "");
  const [selectedRun, setSelectedRun] = useState("");
  const [action, setAction] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);
  const [jobRunning, setJobRunning] = useState(false);
  const [latestProgress, setLatestProgress] = useState({ runId: null, percent: 0 });
  const [runs, setRuns] = useState([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsError, setRunsError] = useState("");
  const [discoveredTracks, setDiscoveredTracks] = useState({});
  const debouncedSearch = useDebouncedValue(search.trim(), 400);

  // Keep the callbacks stable: they are dependencies of the stream effect.
  const rememberTracks = useCallback((events) => {
    setDiscoveredTracks((current) => {
      const next = { ...current };
      let changed = false;
      events.forEach((event) => {
        if (!event.track_id) return;
        const label = event.track_title ? `${event.track_number ? `${event.track_number}. ` : ""}${event.track_title}` : `Track #${event.track_id}`;
        if (next[event.track_id] !== label) {
          next[event.track_id] = label;
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, []);
  const rememberJob = useCallback((running) => setJobRunning(running), []);
  const rememberProgress = useCallback((progress) => setLatestProgress(progress), []);

  // Runs: loaded once, then refreshed while a delivery is running (a new run may start).
  useEffect(() => {
    let alive = true;
    let timer = null;
    async function load() {
      try {
        const data = await getProductLogRuns(productId);
        if (!alive) return;
        const list = Array.isArray(data?.runs) ? data.runs : [];
        setRuns(list);
        setRunsTotal(Number(data?.total) || list.length);
        setRunsError("");
        if (data?.job?.running !== undefined) setJobRunning(Boolean(data.job.running));
      } catch (err) {
        if (alive) setRunsError(getErrorMessage(err));
      }
    }
    load();
    if (live && jobRunning) timer = window.setInterval(load, RUNS_POLL_MS);
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [productId, live, jobRunning]);

  const trackOptions = { ...discoveredTracks };
  tracks.forEach((track) => {
    trackOptions[track.id] = `${track.track_number ? `${track.track_number}. ` : ""}${track.title || t("Track #{id}", { id: track.id })}`;
  });
  if (selectedTrack && !trackOptions[selectedTrack]) trackOptions[selectedTrack] = t("Track #{id}", { id: selectedTrack });

  // Runs come newest first with their absolute number ("Run 1" is the first delivery ever), so
  // the labels stay right even when the server only returns the newest runs.
  const numberedRuns = useMemo(() => runs.map((run, index) => ({ run, index: Number(run.sequence) || runs.length - index })), [runs]);
  const currentRun = numberedRuns.find((item) => item.run.run_id === selectedRun) || (jobRunning ? numberedRuns.find((item) => item.run.status === "running") : null) || null;
  const filters = { trackId: selectedTrack, runId: selectedRun, action, status, search: debouncedSearch };
  const streamKey = `${productId}:${selectedTrack}:${selectedRun}:${action}:${status}:${debouncedSearch}`;

  return (
    <div className="space-y-4">
      <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Field label={t("Track")}>
          <Select aria-label={t("Filter logs by track")} value={selectedTrack} onChange={(event) => setSelectedTrack(event.target.value)} options={[{ value: "", label: t("All tracks and product") }, ...Object.entries(trackOptions).map(([value, label]) => ({ value, label }))]} />
        </Field>
        <Field label={t("Delivery run")} hint={runsError ? t("Runs unavailable: {error}", { error: tm(runsError) }) : runsTotal > runs.length ? t("Newest {shown} of {total} runs listed; older runs stay searchable in the log", { shown: runs.length, total: runsTotal }) : undefined}>
          <Select aria-label={t("Filter logs by delivery run")} value={selectedRun} onChange={(event) => setSelectedRun(event.target.value)} options={[{ value: "", label: runsTotal ? t("All runs ({count})", { count: runsTotal }) : t("All runs") }, ...numberedRuns.map(({ run, index }) => ({ value: run.run_id, label: runLabel(run, index, t) }))]} />
        </Field>
        <Field label={t("Category")}>
          <Select aria-label={t("Filter logs by category")} value={action} onChange={(event) => setAction(event.target.value)} options={LOG_ACTION_GROUPS.map((group) => ({ ...group, label: t(group.label) }))} />
        </Field>
        <Field label={t("Status")}>
          <Select aria-label={t("Filter logs by status")} value={status} onChange={(event) => setStatus(event.target.value)} options={[{ value: "", label: t("All statuses") }, { value: "error", label: t("Errors only") }, { value: "ok", label: t("Completed only") }, { value: "skipped", label: t("Skipped only") }]} />
        </Field>
        <Field label={t("Search saved logs")} hint={t("Message, step, asset or reference ID")}>
          <div className="relative">
            <TextInput aria-label={t("Search saved logs")} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("e.g. ownership, R12345, 503")} className="pr-9" />
            <Search size={15} className="pointer-events-none absolute right-3 top-3.5 text-slate-400" />
          </div>
        </Field>
        <Button variant="secondary" icon={live ? Pause : Play} onClick={() => setLive((value) => !value)}>
          {live ? t("Pause auto-refresh") : t("Resume auto-refresh")}
        </Button>
      </div>
      {currentRun && <RunSummary run={currentRun.run} index={currentRun.index} latestProgress={latestProgress} />}
      {!currentRun && jobRunning && (
        <InlineMessage tone="info" icon={ListChecks}>
          {t("A delivery is running on the server right now — new events appear below as they are recorded.")}
        </InlineMessage>
      )}
      <LogStream key={streamKey} productId={productId} filters={filters} live={live} onTracks={rememberTracks} onJob={rememberJob} onLatestProgress={rememberProgress} />
    </div>
  );
}

export default function DeliveryLogViewer({ productId, trackId = null, open, onClose, tracks = [] }) {
  const { t } = useI18n();
  if (!open || !productId) return null;
  return (
    <Modal open title={t("Delivery logs")} subtitle={t("Saved progress of every delivery run, track step and CMS API call, with live updates, filters and downloads.")} size="xl" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>{t("Close")}</Button>}>
      <LogPanel key={`${productId}:${trackId || "all"}`} productId={productId} trackId={trackId} tracks={tracks} />
    </Modal>
  );
}
