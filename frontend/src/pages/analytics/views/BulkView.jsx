import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronLeft, ChevronRight, Clock3, Database, Download, FileSpreadsheet, LoaderCircle, RefreshCw, Search, Square } from "lucide-react";
import { Badge, Button, Card, EmptyState, InlineMessage, ProgressBar, Select, StatTile, TextInput } from "../../assetDelivery/shared";
import { cx } from "../../assetDelivery/utils";
import PaginationFooter from "../../../components/PaginationFooter";
import { useI18n } from "../../../context/I18nContext";
import { tk } from "../../../i18n/index.js";
import { analyticsApi, analyticsBlobError, analyticsError, downloadAnalyticsFile } from "../../../api/analyticsApi";
import { MetricTable, StatusBadge } from "../shared";
import { useAnalytics } from "../hooks";
import { ACTIVE_JOBS } from "../analyticsUtils";

// YouTube Reporting API archive of the current Content Owner (the pre-v2 AnalyticsBulk behaviour on the kit):
// discover report types, create reporting jobs, import the CSV files YouTube produced, browse the stored rows
// and download a source file. Bulk routes answer { success, data } and are limited to monetary roles.

const POLL_MS = 2200;
const POLL_RETRY_MS = 6500;
const FIRST_POLL_MS = 1200;
const FILES_PER_PAGE = 8;
const INITIAL_PAGE_SIZE = 50;
const PROVENANCE_LABELS = { periodStart: tk("Period start"), periodEnd: tk("Period end"), reportCreatedAt: tk("File created"), reportId: tk("Source file ID") };

const unwrap = (response) => response?.data ?? response;
const isCancelled = (error) => error?.code === "ERR_CANCELED" || error?.name === "CanceledError" || error?.name === "AbortError";
const isRetired = (type) => Boolean(type.deprecateTime) && Date.parse(type.deprecateTime) <= Date.now();
const canCreate = (type) => !type.systemManaged && !isRetired(type);
const toCount = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Provenance columns get a translated label that never shadows an original Google column of the same name.
function previewColumns(data, t) {
  const original = new Set(data.sourceColumns || data.columns || []);
  const labels = {};
  for (const [kind, key] of Object.entries(data.provenanceColumns || {})) {
    let label = PROVENANCE_LABELS[kind] ? t(PROVENANCE_LABELS[kind]) : kind;
    while (original.has(label) || Object.values(labels).includes(label)) label = t("{label} · source", { label });
    labels[key] = label;
  }
  return (data.columns || []).map((key) => ({ key, label: labels[key] || key }));
}

function runProgress(run) {
  if (!run) return 0;
  if (run.kind === "create_jobs") return run.totalJobs ? Math.round((toCount(run.completedJobs) / run.totalJobs) * 100) : 0;
  const handled = toCount(run.importedReports) + toCount(run.skippedReports) + toCount(run.failedReports);
  return run.totalReports ? Math.round((handled / run.totalReports) * 100) : 0;
}

export default function BulkView() {
  const { t, tm, formatDate, formatNumber } = useI18n();
  const { filters, permissions, notify } = useAnalytics();
  const ownerId = filters.ownerId;
  const canSync = permissions.canSync;
  const [catalog, setCatalog] = useState(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [run, setRun] = useState(null);
  const [jobId, setJobId] = useState("");
  const [reportTypeId, setReportTypeId] = useState("");
  const [data, setData] = useState(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [sourcePage, setSourcePage] = useState(0);
  const [exporting, setExporting] = useState("");
  const pageSizeRef = useRef(INITIAL_PAGE_SIZE);
  const dataRequest = useRef(null);

  useEffect(() => {
    if (!ownerId) return undefined;
    const controller = new AbortController();
    const load = async () => {
      const [cached, history] = await Promise.allSettled([
        analyticsApi.bulkCatalog({ ownerId, cached: true }, controller.signal),
        analyticsApi.bulkRuns({ ownerId }, controller.signal)
      ]);
      if (controller.signal.aborted) return;
      if (cached.status === "fulfilled") setCatalog(unwrap(cached.value));
      if (history.status === "fulfilled") {
        const runs = Array.isArray(unwrap(history.value)) ? unwrap(history.value) : [];
        setRun(runs.find((item) => ACTIVE_JOBS.includes(item.status)) || runs[0] || null);
      }
      const failed = [cached, history].find((result) => result.status === "rejected" && !isCancelled(result.reason));
      if (failed) setError(analyticsError(failed.reason));
    };
    load();
    return () => {
      controller.abort();
      dataRequest.current?.abort();
    };
  }, [ownerId]);

  // Poll the active run; when it ends, refresh the cached catalog (new jobs / storage) and report the outcome.
  const runId = run?.id;
  const runStatus = run?.status;
  useEffect(() => {
    if (!runId || !ACTIVE_JOBS.includes(runStatus)) return undefined;
    const controller = new AbortController();
    let timer = null;
    const poll = async () => {
      try {
        const next = unwrap(await analyticsApi.bulkRun(runId, controller.signal));
        if (controller.signal.aborted) return;
        setRun(next);
        if (ACTIVE_JOBS.includes(next.status)) {
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        if (next.kind === "create_jobs" && next.status === "completed") {
          notify(t("Created {created} reporting jobs and kept {existing} existing ones. YouTube usually needs up to 24 hours to produce the first file.", { created: formatNumber(toCount(next.createdJobs)), existing: formatNumber(toCount(next.existingJobs)) }), "success", 8000);
        } else if (next.kind === "sync" && next.status === "completed") {
          notify(t("Imported {files} files and {rows} rows into the Analytics archive.", { files: formatNumber(toCount(next.importedReports)), rows: formatNumber(toCount(next.rowsImported)) }), "success", 6000);
        }
        const cached = unwrap(await analyticsApi.bulkCatalog({ ownerId, cached: true }, controller.signal));
        if (!controller.signal.aborted) setCatalog(cached);
      } catch (failure) {
        if (controller.signal.aborted || isCancelled(failure)) return;
        setError(analyticsError(failure));
        timer = setTimeout(poll, POLL_RETRY_MS);
      }
    };
    timer = setTimeout(poll, FIRST_POLL_MS);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [runId, runStatus, ownerId, notify, t, formatNumber]);

  async function loadCatalog() {
    setLoading(true);
    setError("");
    try {
      const result = unwrap(await analyticsApi.bulkCatalog({ ownerId }));
      setCatalog(result);
      setSelected([]);
      setJobId((current) => (result?.jobs?.some((job) => job.id === current) ? current : ""));
    } catch (failure) {
      setError(analyticsError(failure));
    } finally {
      setLoading(false);
    }
  }

  async function perform(action) {
    setBusy(action);
    setError("");
    try {
      let response = null;
      if (action === "create") response = await analyticsApi.bulkCreate({ ownerId, reportTypeIds: selected });
      if (action === "sync") response = await analyticsApi.bulkSync({ ownerId, ...(jobId ? { jobIds: [jobId] } : {}) });
      if (action === "cancel" && run?.id) response = await analyticsApi.bulkCancel(run.id);
      if (response) setRun(unwrap(response));
    } catch (failure) {
      setError(analyticsError(failure));
      // 409: another run is active for this owner; show it so it can be followed or cancelled.
      const activeRunId = failure?.response?.data?.runId;
      if (activeRunId) {
        try {
          setRun(unwrap(await analyticsApi.bulkRun(activeRunId)));
        } catch {
          // the original error stays on screen; a refresh restores the progress
        }
      }
    } finally {
      setBusy("");
    }
  }

  async function loadData(page = 1, size = pageSizeRef.current) {
    if (!reportTypeId) return;
    dataRequest.current?.abort();
    const controller = new AbortController();
    dataRequest.current = controller;
    setDataLoading(true);
    setError("");
    try {
      const result = unwrap(await analyticsApi.bulkData({ ownerId, reportTypeId, page, pageSize: size }, controller.signal));
      if (controller.signal.aborted) return;
      setData(result);
      setSourcePage(0);
    } catch (failure) {
      if (controller.signal.aborted || isCancelled(failure)) return;
      setError(analyticsError(failure));
    } finally {
      if (!controller.signal.aborted) setDataLoading(false);
    }
  }

  async function exportReport(reportId) {
    setExporting(reportId);
    setError("");
    try {
      const response = await analyticsApi.bulkExport({ ownerId, reportId });
      downloadAnalyticsFile(response, `youtube-report-${reportId}.csv`);
    } catch (failure) {
      setError(await analyticsBlobError(failure));
    } finally {
      setExporting("");
    }
  }

  const reportTypes = useMemo(() => (Array.isArray(catalog?.reportTypes) ? catalog.reportTypes : []), [catalog]);
  const jobs = Array.isArray(catalog?.jobs) ? catalog.jobs : [];
  const storage = catalog?.storage;
  const needle = search.trim().toLowerCase();
  const visible = reportTypes.filter((type) => `${type.name || ""} ${type.id}`.toLowerCase().includes(needle));
  const active = ACTIVE_JOBS.includes(run?.status);
  const progress = Math.min(100, runProgress(run));
  const columns = useMemo(() => (data ? previewColumns(data, t) : []), [data, t]);
  const files = Array.isArray(data?.reports) ? data.reports : [];
  const filePages = Math.max(1, Math.ceil(files.length / FILES_PER_PAGE));
  const runSummary = run
    ? run.kind === "create_jobs"
      ? t("{done}/{total} types processed · {created} new jobs · {existing} existing jobs", { done: formatNumber(toCount(run.completedJobs)), total: formatNumber(toCount(run.totalJobs)), created: formatNumber(toCount(run.createdJobs)), existing: formatNumber(toCount(run.existingJobs)) })
      : t("{rows} rows · {imported} new files · {skipped} already stored · {failed} failed", { rows: formatNumber(toCount(run.rowsImported)), imported: formatNumber(toCount(run.importedReports)), skipped: formatNumber(toCount(run.skippedReports)), failed: formatNumber(toCount(run.failedReports)) })
    : "";

  function selectType(reportTypeKey) {
    dataRequest.current?.abort();
    setReportTypeId(reportTypeKey);
    setData(null);
    setDataLoading(false);
    setSourcePage(0);
  }

  return (
    <Card
      eyebrow={t("Reporting API")}
      icon={FileSpreadsheet}
      tone="amber"
      title={t("Bulk archive")}
      subtitle={t("The detailed report files of this Content Owner from the YouTube Reporting API, stored with every original column.")}
      actions={
        <span data-readonly-allow="true">
          <Button variant="secondary" size="sm" icon={RefreshCw} loading={loading} disabled={!ownerId} onClick={loadCatalog}>
            {reportTypes.length ? t("Refresh catalog") : t("Discover report types")}
          </Button>
        </span>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-slate-500">
          {t("Discover the report types, create daily reporting jobs and import the files YouTube produced; system-managed reports are included when the CMS has access. The import covers the whole Content Owner — the date, channel and video filters above do not limit the source files.")}
        </p>
        {error && (
          <InlineMessage
            tone="error"
            actions={
              <Button variant="ghost" size="sm" onClick={() => setError("")}>
                {t("Dismiss")}
              </Button>
            }
          >
            {tm(error)}
          </InlineMessage>
        )}
        {catalog && (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatTile label={t("Report types")} value={formatNumber(reportTypes.length)} tone="amber" />
            <StatTile label={t("Reporting jobs")} value={formatNumber(jobs.length)} tone="blue" />
            <StatTile label={t("Files in use")} value={formatNumber(toCount(storage?.reports))} tone="emerald" />
            <StatTile label={t("Rows stored")} value={formatNumber(toCount(storage?.rows))} tone="slate" />
          </div>
        )}

        {reportTypes.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 md:max-w-sm">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <TextInput compact value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Search report types or API IDs…")} aria-label={t("Search report types or API IDs…")} className="pl-9" />
              </div>
              <span className="text-xs font-bold text-slate-500">{t("{count} selected", { count: selected.length })}</span>
              {canSync && (
                <>
                  <Button variant="ghost" size="sm" disabled={active || !visible.some(canCreate)} onClick={() => setSelected(visible.filter(canCreate).map((type) => type.id))}>
                    {t("Select results")}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!selected.length} onClick={() => setSelected([])}>
                    {t("Clear selection")}
                  </Button>
                </>
              )}
            </div>
            <ul className="grid max-h-80 gap-2 overflow-y-auto rounded-2xl border border-slate-200 p-2 md:grid-cols-2">
              {visible.map((type) => {
                const disabled = !canSync || active || !canCreate(type);
                const scheduled = jobs.some((job) => job.reportTypeId === type.id);
                return (
                  <li key={type.id}>
                    <label className={cx("flex items-start gap-3 rounded-xl px-3 py-2 text-sm", disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-slate-50")}>
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                        disabled={disabled}
                        checked={selected.includes(type.id)}
                        onChange={(event) => setSelected((current) => (event.target.checked ? [...current, type.id] : current.filter((id) => id !== type.id)))}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold text-slate-800">{type.name || type.id}</span>
                        <code className="block truncate text-[11px] text-slate-400">{type.id}</code>
                      </span>
                      {type.systemManaged ? <Badge tone="blue">{t("System-managed")}</Badge> : isRetired(type) ? <Badge tone="slate">{t("Retired")}</Badge> : scheduled ? <Badge tone="emerald">{t("Scheduled")}</Badge> : null}
                    </label>
                  </li>
                );
              })}
              {!visible.length && <li className="px-3 py-2 text-xs font-bold text-slate-500">{t("No report types match “{query}”", { query: search.trim() })}</li>}
            </ul>
            {canSync && (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="secondary" size="sm" icon={Clock3} loading={busy === "create"} disabled={!selected.length || Boolean(busy) || active} onClick={() => perform("create")}>
                  {t("Create reporting jobs ({count})", { count: selected.length })}
                </Button>
                <p className="text-xs text-slate-400">{t("Existing jobs are kept. System reports need no job; the first file of a new job usually appears within 24 hours.")}</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                compact
                aria-label={t("Reporting jobs to import")}
                value={jobId}
                disabled={active}
                onChange={(event) => setJobId(event.target.value)}
                options={[{ value: "", label: t("All existing jobs ({count})", { count: jobs.length }) }, ...jobs.map((job) => ({ value: job.id, label: `${job.name || job.reportTypeId} · ${job.id}` }))]}
                wrapperClassName="min-w-0 flex-1 md:max-w-md"
              />
              {canSync && (
                <Button size="sm" icon={ArrowDownToLine} loading={busy === "sync"} disabled={!jobs.length || Boolean(busy) || active} onClick={() => perform("sync")}>
                  {jobId ? t("Import files of the selected job") : t("Import all available files")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          catalog && <EmptyState compact icon={Database} title={t("The catalog has not been discovered yet")} description={t("Refresh the catalog to read the report types and reporting jobs of this CMS.")} />
        )}

        {run && (
          <div className={cx("rounded-2xl border p-4", active ? "border-blue-200" : "border-slate-200")} aria-live="polite">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-black text-slate-900">{run.kind === "create_jobs" ? t("Create reporting jobs") : t("Import reports")}</span>
              <StatusBadge status={run.status} />
              <span className="min-w-0 text-sm text-slate-500">{runSummary}</span>
              <span className="ml-auto font-black tabular-nums text-slate-900">{progress}%</span>
              {active && canSync && (
                <Button variant="danger" size="sm" icon={Square} loading={busy === "cancel"} disabled={run.status === "cancelling"} onClick={() => perform("cancel")}>
                  {t("Stop")}
                </Button>
              )}
            </div>
            {active && <ProgressBar value={progress} size="sm" showValue={false} className="mt-3" />}
            {active && run.currentJob && <p className="mt-2 truncate text-xs text-slate-500">{String(run.currentJob)}</p>}
            {run.error && <p className="mt-2 text-sm font-bold text-red-600">{tm(String(run.error))}</p>}
            {Array.isArray(run.errors) && run.errors.length > 0 && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer font-black text-amber-700">{t("{count} issues to review", { count: run.errors.length })}</summary>
                <ul className="mt-2 space-y-1 text-slate-600">
                  {run.errors.map((item, index) => (
                    <li key={index}>
                      <span className="font-bold text-slate-800">{item.reportTypeId || item.reportId || item.jobId || t("Reporting API")}</span>
                      <span className="ml-1">{tm(String(item.message || item.error || "")) || t("The report could not be processed.")}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {run.status === "interrupted" && <p className="mt-2 text-sm text-slate-500">{t("The server restarted. Import again to continue; completed files are kept.")}</p>}
          </div>
        )}

        {reportTypes.length > 0 && (
          <div className="space-y-3 border-t border-slate-100 pt-5">
            <div>
              <h3 className="text-base font-black text-slate-950">{t("Browse imported data")}</h3>
              <p className="text-sm text-slate-500">{t("Browse every stored row per report type. The report period and source file are shown next to the original columns.")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                compact
                aria-label={t("Report type")}
                value={reportTypeId}
                placeholder={t("Select a report type")}
                onChange={(event) => selectType(event.target.value)}
                options={reportTypes.map((type) => ({ value: type.id, label: type.name || type.id }))}
                wrapperClassName="min-w-0 flex-1 md:max-w-md"
              />
              <span data-readonly-allow="true">
                <Button variant="secondary" size="sm" icon={Database} loading={dataLoading} disabled={!reportTypeId} onClick={() => loadData(1)}>
                  {t("View data")}
                </Button>
              </span>
            </div>
            {data && (
              <>
                <MetricTable
                  columns={columns}
                  rows={Array.isArray(data.rows) ? data.rows : []}
                  rowKey={(_, index) => `${data.page}-${index}`}
                  loading={dataLoading}
                  empty={t("No rows imported for this report type yet")}
                  footer={
                    <PaginationFooter
                      total={toCount(data.total)}
                      page={toCount(data.page) || 1}
                      pageSize={toCount(data.pageSize) || INITIAL_PAGE_SIZE}
                      onPageChange={(page) => loadData(page)}
                      onPageSizeChange={(size) => {
                        pageSizeRef.current = size;
                      }}
                    />
                  }
                />
                {files.length > 0 && (
                  <div data-readonly-allow="true" className="space-y-2">
                    <p className="text-xs font-black uppercase tracking-wide text-slate-400">{t("Source CSV files ({count})", { count: formatNumber(files.length) })}</p>
                    <ul className="grid gap-1 md:grid-cols-2">
                      {files.slice(sourcePage * FILES_PER_PAGE, (sourcePage + 1) * FILES_PER_PAGE).map((file) => (
                        <li key={file.id}>
                          <button
                            type="button"
                            disabled={Boolean(exporting)}
                            onClick={() => exportReport(file.id)}
                            className="flex w-full items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-left text-xs font-bold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {exporting === file.id ? <LoaderCircle size={14} className="shrink-0 animate-spin" aria-hidden="true" /> : <Download size={14} className="shrink-0 text-slate-400" aria-hidden="true" />}
                            <span className="min-w-0 flex-1 truncate">
                              {formatDate(file.startTime || file.createTime) || "—"} · {t("{count} rows", { count: formatNumber(toCount(file.rowCount)) })} · <span className="font-mono text-slate-400">{file.id}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {filePages > 1 && (
                      <div className="flex items-center gap-2 text-xs font-bold text-slate-500">
                        <Button variant="ghost" size="sm" icon={ChevronLeft} disabled={sourcePage === 0} onClick={() => setSourcePage((value) => value - 1)}>
                          {t("Previous")}
                        </Button>
                        <span>
                          {sourcePage + 1}/{filePages}
                        </span>
                        <Button variant="ghost" size="sm" icon={ChevronRight} disabled={sourcePage >= filePages - 1} onClick={() => setSourcePage((value) => value + 1)}>
                          {t("Next")}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
