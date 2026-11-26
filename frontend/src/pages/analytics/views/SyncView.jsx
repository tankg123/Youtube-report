import { useSystemSettings } from "../../../context/SystemSettingsContext";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarCheck, Cloud, CloudOff, DatabaseZap, Download, History, ListChecks, Play, RefreshCw, X, XCircle } from "lucide-react";
import { Badge, Button, Card, EmptyState, IconButton, InlineMessage, ProgressBar, TextInput } from "../../assetDelivery/shared";
import { cx, formatBytes } from "../../assetDelivery/utils";
import { useAuth } from "../../../context/AuthContext";
import { useI18n } from "../../../context/I18nContext";
import { tk } from "../../../i18n/index.js";
import { analyticsApi, analyticsError } from "../../../api/analyticsApi";
import { CoverageCalendar } from "../charts";
import { ErrorPanel, ExportMenu, LoadingPanel, MetricTable, StatusBadge, SyncStatusPill } from "../shared";
import { useAbortableLoader, useAnalytics } from "../hooks";
import {
  ACTIVE_JOBS,
  JOB_LABELS,
  SCOPE_LABELS,
  buildFillMissingRequest,
  countDays,
  dimensionLabel,
  dimensionValueLabel,
  downloadCsv,
  formatMetric,
  formatScheduleDate,
  isValidDay,
  metricLabel
} from "../analyticsUtils";
import ScheduleCard from "../ScheduleCard";
import BulkView from "./BulkView";

// Data & sync: schedule, Sync all / daily run, the live job, stored-day coverage with "Fill missing days", the
// change ledger (drift and overwrites with before/after), the job history, the CMS connection and the Bulk
// archive (monetary roles). Every loader depends on refreshKey, which the provider bumps when a job finishes.

const LEDGER_PAGE = 50;
const MAX_DIFF_ROWS = 6;
const COUNT_LABELS = [
  ["inserted", tk("Inserted")],
  ["updated", tk("Updated rows")],
  ["enriched", tk("Enriched")],
  ["unchanged", tk("Unchanged")],
  ["drift", tk("Drift")],
  ["skipped", tk("Skipped")],
  ["failed", tk("Failed")]
];
const ACTION_TONES = { overwrite: "red", drift: "amber", migration: "slate" };
const ACTION_LABELS = { overwrite: tk("Overwrite"), drift: tk("Drift"), migration: tk("Migration") };
const EMPTY_MORE = Object.freeze({ key: "", entries: [], loading: false, error: "" });
const DT_CLASS = "text-xs font-black uppercase tracking-wide text-slate-400";

const toCount = (value) => (Array.isArray(value) ? value.length : Number.isFinite(Number(value)) ? Number(value) : 0);

function planEstimate(plan) {
  const value = plan?.requests?.estimate ?? plan?.estimate;
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
}

// progress arrives as 0–100 (completed / total) or 0–1; completed / total is the fallback.
function jobPercent(job) {
  const raw = Number(job.progress);
  const fraction = Number.isFinite(raw) && raw > 0 ? (raw > 1 ? raw / 100 : raw) : Number(job.total) > 0 ? Number(job.completed) / Number(job.total) : 0;
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

// v2 jobs carry their range in the plan (daily jobs compute it at run time); legacy snapshot jobs in the selection.
function jobRange(job) {
  const plan = job.plan || job.result?.plan;
  const source = isValidDay(plan?.startDate) ? plan : job.selection;
  return isValidDay(source?.startDate) && isValidDay(source?.endDate) ? { startDate: source.startDate, endDate: source.endDate } : null;
}

function monthRows(days) {
  const months = new Map();
  for (const entry of days) {
    if (!isValidDay(entry?.day)) continue;
    const month = entry.day.slice(0, 7);
    const row = months.get(month) || { month, total: 0, stored: 0, missing: 0, pending: 0, drift: 0, monetary: 0 };
    row.total += 1;
    if (entry.facts) row.stored += 1;
    else if (entry.pending) row.pending += 1;
    else row.missing += 1;
    if (entry.drift) row.drift += 1;
    if (entry.monetary) row.monetary += 1;
    months.set(month, row);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function monthLabel(month, locale) {
  const text = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function JobDetail({ job, canCancel = false, onCancel, cancelling = false }) {
  const { t, tm, language, formatDate, formatNumber } = useI18n();
  const { permissions } = useAnalytics();
  const active = ACTIVE_JOBS.includes(job.status);
  const counts = job.counts || job.result?.counts || null;
  const steps = Array.isArray(job.steps) ? job.steps : Array.isArray(job.result?.steps) ? job.result.steps : [];
  const errors = Array.isArray(job.errors) ? job.errors : [];
  const range = jobRange(job);
  const days = job.result?.days || null;
  const planned = planEstimate(job.plan ?? job.result?.plan);
  const used = job.result?.requests ?? job.requests;
  const fmt = (value) => formatNumber(toCount(value));
  const stepColumns = [
    { key: "label", label: t("Step"), format: (value, row) => tm(String(value || row.id || "")) },
    { key: "status", label: t("Status"), format: (value) => <StatusBadge status={value} /> },
    { key: "requests", label: t("Requests"), align: "right", format: fmt },
    { key: "inserted", label: t("Inserted"), align: "right", format: fmt },
    { key: "updated", label: t("Updated rows"), align: "right", format: fmt },
    { key: "drift", label: t("Drift"), align: "right", format: fmt },
    { key: "error", label: t("Error"), format: (value) => (value ? <span className="text-red-600">{tm(String(value?.message || value))}</span> : "—") }
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <StatusBadge status={job.status} />
        <Badge tone="slate">{t(JOB_LABELS.kind[job.kind] || JOB_LABELS.kind.snapshot)}</Badge>
        {job.mode && JOB_LABELS.mode[job.mode] && <Badge tone={job.mode === "overwrite" ? "red" : "blue"}>{t(JOB_LABELS.mode[job.mode])}</Badge>}
        {job.requestedBy && <Badge tone="slate">{t(JOB_LABELS.requestedBy[job.requestedBy] || job.requestedBy)}</Badge>}
        {job.monetary && permissions.canMonetary && <Badge tone="amber">USD</Badge>}
        {range && (
          <span className="font-bold text-slate-700">
            {formatDate(range.startDate)} – {formatDate(range.endDate)}
          </span>
        )}
        <span>
          {t("Created")} {formatScheduleDate(job.createdAt, language)}
        </span>
        {job.finishedAt && (
          <span>
            · {t("Finished")} {formatScheduleDate(job.finishedAt, language)}
          </span>
        )}
      </div>
      {active && <ProgressBar value={jobPercent(job)} size="sm" label={job.currentReport ? tm(String(job.currentReport)) : t("Syncing…")} />}
      <div className="flex flex-wrap gap-2 text-xs">
        {counts &&
          COUNT_LABELS.filter(([key]) => counts[key] !== undefined && counts[key] !== null).map(([key, label]) => (
            <span key={key} className={cx("rounded-lg px-2 py-1 font-bold", key === "drift" && toCount(counts[key]) > 0 ? "bg-amber-50 text-amber-700" : key === "failed" && toCount(counts[key]) > 0 ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600")}>
              {t(label)} <span className="font-black tabular-nums">{fmt(counts[key])}</span>
            </span>
          ))}
        {(used !== undefined || planned !== null) && (
          <span className="rounded-lg bg-slate-100 px-2 py-1 font-bold text-slate-600">
            {t("Requests")} <span className="font-black tabular-nums">{planned !== null ? `${fmt(used)} / ${fmt(planned)}` : fmt(used)}</span>
          </span>
        )}
        {days && !active && (
          <span className="rounded-lg bg-emerald-50 px-2 py-1 font-bold text-emerald-700">
            {t("Added {days} · {drift} days drifted", { days: formatNumber(countDays(days, "added")), drift: formatNumber(countDays(days, "drifted")) })}
          </span>
        )}
      </div>
      {steps.length > 0 && <MetricTable columns={stepColumns} rows={steps} rowKey={(row, index) => row.id ?? index} />}
      {errors.length > 0 && (
        <details className="rounded-2xl border border-red-100 bg-red-50 px-4 py-2 text-sm">
          <summary className="cursor-pointer font-black text-red-700">{t("{count} errors", { count: errors.length })}</summary>
          <ul className="mt-2 space-y-1 text-red-700">
            {errors.map((item, index) => (
              <li key={index}>
                {typeof item !== "string" && (item.reportId || item.step) && <span className="mr-1 font-bold">{String(item.reportId || item.step)}:</span>}
                {tm(typeof item === "string" ? item : String(item.message || item.error || ""))}
              </li>
            ))}
          </ul>
        </details>
      )}
      {canCancel && active && (
        <Button variant="danger" size="sm" icon={XCircle} loading={cancelling} disabled={job.status === "cancelling" || job.canCancel === false} onClick={() => onCancel?.()}>
          {t("Cancel job")}
        </Button>
      )}
    </div>
  );
}

// `schedule` is the stored daily schedule (from ScheduleCard): with "Refresh unsettled days" on, the daily run does
// overwrite the newest settleDays days, so the "never changes stored numbers" sentence says so.
function SyncAllCard({ schedule }) {
  const { t, tm, formatDate, formatNumber } = useI18n();
  const { filters, permissions, overview, job, jobActive, startSync, syncing, notify, openSyncDialog, latestDay } = useAnalytics();
  const { canSync, connected } = permissions;
  const [running, setRunning] = useState(false);
  const stale = toCount(overview?.coverage?.staleDays);
  const refreshes = Boolean(schedule?.refreshProvisional);
  const settleDays = Number.isInteger(Number(schedule?.settleDays)) && Number(schedule?.settleDays) > 0 ? Number(schedule.settleDays) : 7;
  const disabledTitle = !connected ? t("CMS disconnected") : jobActive ? t("A sync is already running") : undefined;

  async function runDaily() {
    setRunning(true);
    try {
      const response = await startSync({ kind: "daily", ownerId: filters.ownerId });
      notify(response?.deduplicated ? t("An identical sync is already queued") : t("Daily sync queued"), "success");
    } catch (failure) {
      notify(tm(failure.message), "error", 6000);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card eyebrow={t("Sync")} icon={DatabaseZap} tone="blue" title={t("Sync all")} subtitle={t("Pull a whole range from YouTube: add the missing days or overwrite every stored number.")}>
      <div className="space-y-3 text-sm text-slate-600">
        <p className="flex flex-wrap gap-x-2">
          <span>{latestDay ? t("Latest data: {date}", { date: formatDate(latestDay) }) : t("No days stored yet")}</span>
          {stale > 0 && <span>· {t("{count} newer days not yet synced", { count: stale })}</span>}
        </p>
        {job && <SyncStatusPill job={job} />}
        {canSync && (
          <div className="flex flex-wrap gap-2">
            <Button icon={RefreshCw} disabled={!connected || jobActive || syncing} title={disabledTitle} onClick={() => openSyncDialog()}>
              {t("Sync all")}
            </Button>
            <Button variant="secondary" icon={Play} loading={running} disabled={!connected || jobActive || syncing} title={disabledTitle} onClick={runDaily}>
              {t("Run the daily sync now")}
            </Button>
          </div>
        )}
        <p className="text-xs text-slate-400">
          {refreshes
            ? t("The daily run never changes stored numbers except the last {n} unsettled days, which the schedule refreshes; use Sync all to overwrite a range.", { n: formatNumber(settleDays) })
            : t("The daily run never changes stored numbers; use Sync all to overwrite a range.")}
        </p>
      </div>
    </Card>
  );
}

function ConnectionCard() {
  const { t, tm, formatNumber } = useI18n();
  const { canViewSettings } = useAuth();
  const { owner, bootstrap, permissions } = useAnalytics();
  const connected = permissions.connected;
  const database = bootstrap?.database;
  if (!owner) return null;
  return (
    <Card
      eyebrow={t("CMS")}
      icon={connected ? Cloud : CloudOff}
      tone={connected ? "emerald" : "red"}
      title={owner.name || owner.ownerId}
      subtitle={owner.ownerId}
      actions={<Badge tone={connected ? "emerald" : "red"}>{connected ? t("Connected") : t("CMS disconnected")}</Badge>}
    >
      <div className="space-y-3 text-sm">
        {!connected && owner.authError && <p className="font-bold text-red-600">{tm(String(owner.authError))}</p>}
        <ul className="flex flex-wrap gap-2">
          <li>
            <Badge tone={owner.hasAnalyticsScope ? "emerald" : "slate"}>{t("YouTube Analytics")}</Badge>
          </li>
          {permissions.canMonetary && (
            <li>
              <Badge tone={owner.hasMonetaryScope ? "emerald" : "slate"}>{t("Revenue")}</Badge>
            </li>
          )}
        </ul>
        <p className="text-xs text-slate-400">
          {permissions.canMonetary ? t("Scopes granted to the CMS OAuth connection; revenue needs the monetary scope.") : t("Scopes granted to the CMS OAuth connection.")}
        </p>
        {!connected &&
          (canViewSettings ? (
            <Link to="/networks" className="inline-flex h-9 items-center gap-2 rounded-xl bg-blue-600 px-3 text-xs font-black text-white hover:bg-blue-700">
              {t("Open Networks")}
            </Link>
          ) : (
            <p className="font-bold text-slate-700">{t("Ask an administrator to reconnect the CMS OAuth in Settings > Network.")}</p>
          ))}
        {!connected && <p className="text-xs text-slate-400">{t("A connection that drops every 7 days points to a Google OAuth consent screen still in Testing mode: publish it (status In production) or re-authorise weekly.")}</p>}
        {database && (
          <p className="text-xs text-slate-400">
            {t("Analytics database {name}: {facts} fact rows · {coverage} coverage rows · {size}", {
              name: database.name,
              facts: formatNumber(toCount(database.facts)),
              coverage: formatNumber(toCount(database.coverageRows)),
              size: formatBytes(database.sizeBytes)
            })}
          </p>
        )}
      </div>
    </Card>
  );
}

function CurrentJobCard() {
  const { t } = useI18n();
  const { job, jobActive, permissions, cancelJob, cancelling } = useAnalytics();
  if (!job) return null;
  return (
    <Card eyebrow={t("Job")} icon={ListChecks} tone={jobActive ? "blue" : "slate"} title={jobActive ? t("Current job") : t("Latest job")}>
      <JobDetail job={job} canCancel={permissions.canSync} onCancel={cancelJob} cancelling={cancelling} />
    </Card>
  );
}

function CoverageCard({ selectedDay, onSelectDay }) {
  const { t, tm, formatNumber, locale } = useI18n();
  const { filters, permissions, inventory, refreshKey, jobActive, startSync, notify } = useAnalytics();
  const { ownerId, startDate, endDate, scope, channelIds } = filters;
  const { canSync, canMonetary, connected } = permissions;
  const singleChannel = channelIds.length === 1 ? channelIds[0] : "";
  const [filling, setFilling] = useState(false);
  const loader = useCallback(
    (signal) => analyticsApi.coverage({ ownerId, startDate, endDate, ...(singleChannel ? { channelId: singleChannel } : { scope }) }, signal),
    [ownerId, startDate, endDate, scope, singleChannel]
  );
  const { data, loading, error, reload } = useAbortableLoader(loader, { enabled: Boolean(ownerId) && isValidDay(startDate) && isValidDay(endDate), version: refreshKey });
  const days = useMemo(() => (Array.isArray(data?.days) ? data.days : []), [data]);
  const months = useMemo(() => monthRows(days), [days]);
  const fillRequest = useMemo(() => (data ? buildFillMissingRequest(filters, permissions, data) : null), [data, filters, permissions]);
  const total = days.length;
  const covered = data?.covered !== undefined && data?.covered !== null ? toCount(data.covered) : days.filter((entry) => entry?.facts).length;
  const pending = toCount(data?.pending);
  const missing = toCount(data?.missing);
  const drifted = toCount(data?.driftDays);
  const pendingSet = new Set(Array.isArray(data?.pending) ? data.pending : []);
  const fillable = (Array.isArray(data?.missing) ? data.missing : []).filter((day) => !pendingSet.has(day)).length;
  const status = !total || !covered ? "empty" : covered === total ? "complete" : "partial";
  const entityLabel = singleChannel ? inventory.byId.get(singleChannel)?.title || singleChannel : t(SCOPE_LABELS[scope] || scope);
  const fmt = (value) => formatNumber(toCount(value));
  const summary = [t("{covered}/{total} days stored", { covered: fmt(covered), total: fmt(total) })];
  if (missing) summary.push(t("{count} missing", { count: fmt(missing) }));
  if (pending) summary.push(t("{count} not yet published", { count: fmt(pending) }));
  if (drifted) summary.push(t("{count} days drifted", { count: fmt(drifted) }));
  const monthColumns = [
    { key: "month", label: t("Month"), format: (value) => monthLabel(value, locale) },
    {
      key: "stored",
      label: t("Stored days"),
      align: "right",
      format: (value, row) => (
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <span className={cx("block h-full rounded-full", value === row.total ? "bg-emerald-600" : "bg-blue-600")} style={{ width: `${row.total ? Math.round((value / row.total) * 100) : 0}%` }} />
          </span>
          {fmt(value)}/{fmt(row.total)}
        </span>
      )
    },
    { key: "missing", label: t("Missing days"), align: "right", format: fmt },
    { key: "pending", label: t("Not yet published"), align: "right", format: fmt },
    { key: "drift", label: t("Drifted days"), align: "right", format: fmt },
    ...(canMonetary ? [{ key: "monetary", label: t("Revenue included"), align: "right", format: fmt }] : [])
  ];

  async function fill() {
    if (!fillRequest) return;
    setFilling(true);
    try {
      await startSync(fillRequest);
      notify(t("Queued a sync for {count} missing days", { count: fmt(fillable) }), "success");
    } catch (failure) {
      notify(tm(failure.message), "error", 6000);
    } finally {
      setFilling(false);
    }
  }

  function exportDays() {
    downloadCsv(
      [
        { key: "day", label: t("Day (Pacific time)") },
        { key: "facts", label: t("Stored"), value: (row) => (row.facts ? 1 : 0) },
        ...(canMonetary ? [{ key: "monetary", label: t("Revenue included"), value: (row) => (row.monetary ? 1 : 0) }] : []),
        { key: "drift", label: t("Drift"), value: (row) => (row.drift ? 1 : 0) },
        { key: "pending", label: t("Not yet published"), value: (row) => (row.pending ? 1 : 0) },
        { key: "breakdowns", label: t("Breakdowns"), value: (row) => (Array.isArray(row.breakdowns) ? row.breakdowns.join(" ") : "") }
      ],
      days,
      `analytics-coverage-${ownerId}-${startDate}-${endDate}.csv`
    );
  }

  return (
    <Card
      eyebrow={t("Coverage")}
      icon={CalendarCheck}
      tone={status === "complete" ? "emerald" : status === "partial" ? "amber" : "slate"}
      title={t("Stored days")}
      subtitle={summary.join(" · ")}
      actions={
        <>
          <StatusBadge status={status} />
          {canSync && fillable > 0 && (
            <Button size="sm" icon={RefreshCw} loading={filling} disabled={!connected || jobActive || !fillRequest} title={!connected ? t("CMS disconnected") : jobActive ? t("A sync is already running") : undefined} onClick={fill}>
              {t("Fill missing days")}
            </Button>
          )}
          <span data-readonly-allow="true" className="inline-flex gap-2">
            <IconButton icon={Download} label={t("Export CSV")} disabled={!days.length} onClick={exportDays} />
            <IconButton icon={RefreshCw} label={t("Refresh")} loading={loading && days.length > 0} onClick={reload} />
          </span>
        </>
      }
    >
      {error && !data ? (
        <ErrorPanel error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingPanel rows={5} />
      ) : (
        <div className="space-y-5" aria-busy={loading || undefined}>
          <p className="text-sm text-slate-500">
            {t("Entity")}: <span className="font-bold text-slate-800">{entityLabel}</span>
          </p>
          {channelIds.length > 1 && <InlineMessage tone="neutral">{t("Coverage is tracked per channel — showing the Content Owner scope; select one channel to see its days.")}</InlineMessage>}
          <CoverageCalendar days={days} startDate={startDate} endDate={endDate} selectedDay={selectedDay} showMonetary={canMonetary} onSelectDay={onSelectDay} />
          <MetricTable columns={monthColumns} rows={months} rowKey="month" loading={loading} empty={t("No stored data for this range")} />
        </div>
      )}
    </Card>
  );
}

function Changes({ entry }) {
  const { t, language } = useI18n();
  const keys = Array.isArray(entry.changedKeys) ? entry.changedKeys : [];
  const next = entry.next && typeof entry.next === "object" ? entry.next : {};
  const added = Array.isArray(next.added) ? next.added : [];
  const missing = Array.isArray(next.missing) ? next.missing : [];
  if (!keys.length && !added.length && !missing.length) return <span className="text-slate-400">—</span>;
  const shown = keys.slice(0, MAX_DIFF_ROWS);
  return (
    <ul className="space-y-0.5 text-xs">
      {shown.map((change, index) => (
        <li key={index} className="flex flex-wrap items-center gap-1 tabular-nums">
          {change.value !== undefined && change.value !== null && change.value !== "" && <span className="text-slate-400">{t(dimensionValueLabel(change.value, entry.dimension))} ·</span>}
          <span className="font-bold text-slate-700">{t(metricLabel(change.key))}</span>
          <span className="text-slate-400 line-through">{formatMetric(change.before, change.key, { language })}</span>
          <span aria-hidden="true">→</span>
          <span className="font-black text-slate-900">{formatMetric(change.after, change.key, { language })}</span>
        </li>
      ))}
      {keys.length > shown.length && <li className="text-slate-400">{t("+{count} more", { count: keys.length - shown.length })}</li>}
      {added.length > 0 && <li className="text-emerald-700">{t("{count} new values", { count: added.length })}</li>}
      {missing.length > 0 && <li className="text-amber-700">{t("{count} values missing", { count: missing.length })}</li>}
    </ul>
  );
}

function LedgerCard({ day, onDayChange, innerRef }) {
  const { t, language, formatDate, formatNumber } = useI18n();
  const { filters, inventory, refreshKey, exportFile, exporting } = useAnalytics();
  const { ownerId, scope, channelIds, startDate, endDate } = filters;
  const singleChannel = channelIds.length === 1 ? channelIds[0] : "";
  const entityKey = singleChannel ? `channel:${singleChannel}` : `owner:${scope}`;
  const dayFilter = isValidDay(day) ? day : "";
  const loader = useCallback((signal) => analyticsApi.history({ ownerId, entityKey, day: dayFilter, limit: LEDGER_PAGE }, signal), [ownerId, entityKey, dayFilter]);
  const { data, loading, error, reload } = useAbortableLoader(loader, { enabled: Boolean(ownerId), version: refreshKey });
  const pageKey = `${ownerId}|${entityKey}|${dayFilter}|${refreshKey}`;
  const [more, setMore] = useState(EMPTY_MORE);
  const extra = more.key === pageKey ? more : EMPTY_MORE;
  const entries = useMemo(() => [...(Array.isArray(data?.entries) ? data.entries : []), ...extra.entries], [data, extra.entries]);
  const total = Math.max(toCount(data?.total), entries.length);
  const dayId = useId();

  function entityName(key) {
    const text = String(key || "");
    if (text.startsWith("owner:")) return t(SCOPE_LABELS[text.slice(6)] || text.slice(6));
    if (text.startsWith("channel:")) return inventory.byId.get(text.slice(8))?.title || text.slice(8);
    return text;
  }

  async function loadMore() {
    const last = entries[entries.length - 1];
    if (!last || extra.loading) return;
    // The server's cursor skips the rows a non-monetary reader never sees; the last visible id is the fallback.
    const cursor = (extra.entries.length ? extra.nextBefore : data?.nextBefore) ?? last.id;
    setMore({ key: pageKey, entries: extra.entries, loading: true, error: "", nextBefore: extra.nextBefore ?? null });
    try {
      const response = await analyticsApi.history({ ownerId, entityKey, day: dayFilter, limit: LEDGER_PAGE, before: cursor });
      setMore({ key: pageKey, entries: [...extra.entries, ...(Array.isArray(response?.entries) ? response.entries : [])], loading: false, error: "", nextBefore: response?.nextBefore ?? null });
    } catch (failure) {
      setMore({ key: pageKey, entries: extra.entries, loading: false, error: analyticsError(failure), nextBefore: extra.nextBefore ?? null });
    }
  }

  function exportEntries() {
    const rows = entries.flatMap((entry) => {
      const keys = Array.isArray(entry.changedKeys) && entry.changedKeys.length ? entry.changedKeys : [{}];
      return keys.map((change) => ({
        recordedAt: entry.recordedAt,
        day: entry.day,
        entity: entry.entityKey,
        dimension: entry.dimension || "",
        dimensionValue: change.value ?? entry.dimensionValue ?? "",
        action: entry.action,
        metric: change.key ?? "",
        before: change.before ?? null,
        after: change.after ?? null,
        requestedBy: entry.createdBy?.name || entry.requestedBy || "",
        jobId: entry.jobId || ""
      }));
    });
    downloadCsv(
      [
        { key: "recordedAt", label: t("Recorded at") },
        { key: "day", label: t("Day (Pacific time)") },
        { key: "entity", label: t("Entity") },
        { key: "dimension", label: t("Breakdown") },
        { key: "dimensionValue", label: t("Value") },
        { key: "action", label: t("Action") },
        { key: "metric", label: t("Changed keys") },
        { key: "before", label: t("Before") },
        { key: "after", label: t("After") },
        { key: "requestedBy", label: t("Requested by") },
        { key: "jobId", label: t("Job") }
      ],
      rows,
      `analytics-history-${ownerId}-${dayFilter || "all"}.csv`
    );
  }

  // The panel export: the loaded rows client-side, or the server file of the SAME filter (entity + day) — the sticky
  // top-bar "Change ledger (CSV)" stays the whole owner ledger of the date range.
  const entityText = entityName(entityKey);
  const exportOptions = [
    { key: "table", label: t("This table (CSV)"), format: "csv" },
    { key: "history:csv", label: dayFilter ? t("Change ledger of {entity} on {date} (CSV)", { entity: entityText, date: formatDate(dayFilter) }) : t("Change ledger of {entity} (CSV)", { entity: entityText }), format: "csv" }
  ];
  function exportLedger(option) {
    if (option.key === "table") return exportEntries();
    return exportFile({
      type: "history",
      format: "csv",
      extra: { entityKey, ...(dayFilter ? { day: dayFilter } : {}) },
      filename: `analytics-history-${ownerId}-${entityKey.replace(/[^\w-]+/g, "_")}-${dayFilter || `${startDate}-${endDate}`}.csv`
    });
  }

  const columns = [
    { key: "recordedAt", label: t("Recorded at"), format: (value) => formatScheduleDate(value, language) },
    { key: "day", label: t("Day"), format: (value) => formatDate(value) },
    {
      key: "entityKey",
      label: t("Entity"),
      format: (value, row) => (
        <span className="block min-w-0">
          {entityName(value)}
          {row.dimension && (
            <span className="block text-xs text-slate-400">
              {t(dimensionLabel(row.dimension))}
              {row.dimensionValue ? ` · ${t(dimensionValueLabel(row.dimensionValue, row.dimension))}` : ""}
            </span>
          )}
        </span>
      )
    },
    { key: "action", label: t("Action"), format: (value) => <Badge tone={ACTION_TONES[value] || "slate"}>{ACTION_LABELS[value] ? t(ACTION_LABELS[value]) : String(value || "")}</Badge> },
    { key: "changedKeys", label: t("Changed keys"), format: (_, row) => <Changes entry={row} /> },
    {
      key: "requestedBy",
      label: t("Requested by"),
      format: (value, row) => (
        <span className="block min-w-0">
          {row.createdBy?.name || (value ? t(JOB_LABELS.requestedBy[value] || value) : "—")}
          {row.kind && (
            <span className="block text-xs text-slate-400">
              {t(JOB_LABELS.kind[row.kind] || row.kind)}
              {row.mode && JOB_LABELS.mode[row.mode] ? ` · ${t(JOB_LABELS.mode[row.mode])}` : ""}
            </span>
          )}
        </span>
      )
    }
  ];

  return (
    <div ref={innerRef} className="scroll-mt-20">
      <Card
        eyebrow={t("Change ledger")}
        icon={History}
        tone="amber"
        title={t("Change ledger")}
        subtitle={t("Every drift YouTube reported and every overwrite, with the numbers before and after, who ran the job and in which mode.")}
        actions={
          <>
            <span data-readonly-allow="true" className="inline-flex items-center gap-2">
              <label htmlFor={dayId} className={DT_CLASS}>
                {t("Day")}
              </label>
              <TextInput id={dayId} type="date" compact value={dayFilter} onChange={(event) => onDayChange(event.target.value)} className="w-40" />
              {dayFilter && <IconButton size="sm" icon={X} label={t("Clear")} onClick={() => onDayChange("")} />}
              <ExportMenu options={entries.length ? exportOptions : []} busy={exporting === "history:csv" ? "history:csv" : exporting ? true : ""} onSelect={exportLedger} />
              <IconButton icon={RefreshCw} label={t("Refresh")} loading={loading && entries.length > 0} onClick={reload} />
            </span>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-500">
          {t("Entity")}: <span className="font-bold text-slate-800">{entityText}</span>
          {channelIds.length > 1 && <span className="ml-2 text-xs">{t("Select one channel to see its ledger")}</span>}
        </p>
        {error && !data ? (
          <ErrorPanel error={error} onRetry={reload} />
        ) : (
          <MetricTable
            columns={columns}
            rows={entries}
            rowKey="id"
            loading={loading && !entries.length}
            empty={dayFilter ? t("No changes recorded for this day") : t("No drift or overwrite recorded yet")}
            footer={
              entries.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-3 text-xs font-bold text-slate-500">
                  <span>{t("Showing {count} of {total}", { count: formatNumber(entries.length), total: formatNumber(total) })}</span>
                  {extra.error && <span className="text-red-600">{extra.error}</span>}
                  {entries.length < total && (
                    <span data-readonly-allow="true">
                      <Button variant="secondary" size="sm" loading={extra.loading} onClick={loadMore}>
                        {t("Load more")}
                      </Button>
                    </span>
                  )}
                </div>
              ) : null
            }
          />
        )}
      </Card>
    </div>
  );
}

function JobHistoryCard() {
  const { t, tm, language, formatDate, formatNumber } = useI18n();
  const { filters, refreshKey, job, permissions, cancelJob, cancelling, notify } = useAnalytics();
  const ownerId = filters.ownerId;
  const [expanded, setExpanded] = useState("");
  const [cancellingRow, setCancellingRow] = useState("");
  const loader = useCallback((signal) => analyticsApi.jobs({ ownerId }, signal), [ownerId]);
  const { data, loading, error, reload } = useAbortableLoader(loader, { enabled: Boolean(ownerId), version: `${refreshKey}|${job?.id || ""}|${job?.status || ""}` });
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const expandedJob = jobs.find((row) => row.id === expanded) || null;
  const fmt = (value) => formatNumber(toCount(value));

  // The provider cancels the job it tracks; any other queued job goes straight to the API.
  async function cancelRow(id) {
    setCancellingRow(id);
    try {
      await analyticsApi.cancel(id);
      reload();
    } catch (failure) {
      notify(t("Could not cancel the job: {message}", { message: tm(analyticsError(failure)) }), "error");
    } finally {
      setCancellingRow("");
    }
  }

  const columns = [
    { key: "createdAt", label: t("Created"), format: (value) => formatScheduleDate(value, language) },
    { key: "kind", label: t("Kind"), format: (value) => t(JOB_LABELS.kind[value] || JOB_LABELS.kind.snapshot) },
    { key: "mode", label: t("Mode"), format: (value) => (value && JOB_LABELS.mode[value] ? t(JOB_LABELS.mode[value]) : "—") },
    { key: "requestedBy", label: t("Requested by"), format: (value) => (value ? t(JOB_LABELS.requestedBy[value] || value) : "—") },
    {
      key: "range",
      label: t("Date range"),
      format: (_, row) => {
        const range = jobRange(row);
        return range ? `${formatDate(range.startDate)} – ${formatDate(range.endDate)}` : "—";
      }
    },
    {
      key: "counts",
      label: t("Rows"),
      align: "right",
      format: (value, row) => {
        const counts = value || row.result?.counts;
        return counts ? t("{inserted} added · {updated} updated · {drift} drift", { inserted: fmt(counts.inserted), updated: fmt(counts.updated), drift: fmt(counts.drift) }) : "—";
      }
    },
    {
      key: "status",
      label: t("Status"),
      format: (value, row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge status={value} />
          {Array.isArray(row.errors) && row.errors.length > 0 && <Badge tone="red">{t("{count} errors", { count: row.errors.length })}</Badge>}
        </span>
      )
    }
  ];

  return (
    <Card
      eyebrow={t("History")}
      icon={ListChecks}
      tone="slate"
      title={t("Sync jobs")}
      subtitle={t("Every manual, scheduled and recovery run of this Content Owner, newest first. Click a row for its steps and errors.")}
      actions={
        <span data-readonly-allow="true">
          <IconButton icon={RefreshCw} label={t("Refresh")} loading={loading && jobs.length > 0} onClick={reload} />
        </span>
      }
    >
      {error && !jobs.length ? (
        <ErrorPanel error={error} onRetry={reload} />
      ) : (
        <MetricTable columns={columns} rows={jobs} rowKey="id" loading={loading} empty={t("No sync jobs yet")} onRowClick={(row) => setExpanded((current) => (current === row.id ? "" : row.id))} />
      )}
      {expandedJob && (
        <div className="mt-4 rounded-2xl border border-slate-200 p-4">
          <JobDetail
            job={expandedJob}
            canCancel={permissions.canSync}
            cancelling={expandedJob.id === job?.id ? cancelling : cancellingRow === expandedJob.id}
            onCancel={expandedJob.id === job?.id ? cancelJob : () => cancelRow(expandedJob.id)}
          />
        </div>
      )}
    </Card>
  );
}

export default function SyncView() {
  const { isSidebarVisible } = useSystemSettings();
  const showSchedule = isSidebarVisible("/analytic/sync#schedule");
  const showJobs = isSidebarVisible("/analytic/sync#jobs");
  const showBulk = isSidebarVisible("/analytic/sync#bulk");
  const { t } = useI18n();
  const { filters, permissions } = useAnalytics();
  const [ledgerDay, setLedgerDay] = useState("");
  // The stored schedule of the current owner, reported by ScheduleCard, for the Sync-all card's wording.
  const [schedule, setSchedule] = useState(null);
  const ledgerRef = useRef(null);

  function selectDay(day) {
    setLedgerDay((current) => (current === day ? "" : day));
    ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (!filters.ownerId) {
    // No Content Owner at all: nothing to reconnect, so the shell's sentence applies.
    return <EmptyState icon={CloudOff} title={t("No Content Owner available")} description={t("Connect a YouTube CMS (content owner) with the Content ID OAuth to start storing analytics.")} />;
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          {showSchedule && <ScheduleCard key={filters.ownerId} onScheduleLoaded={setSchedule} />}
        </div>
        <div className="min-w-0 space-y-5">
          <SyncAllCard schedule={schedule} />
          <ConnectionCard />
        </div>
      </div>
      <CurrentJobCard />
      <CoverageCard selectedDay={ledgerDay} onSelectDay={selectDay} />
      <LedgerCard day={ledgerDay} onDayChange={setLedgerDay} innerRef={ledgerRef} />
      {showJobs && <JobHistoryCard />}
      {permissions.canMonetary && showBulk && <BulkView key={filters.ownerId} />}
    </div>
  );
}
