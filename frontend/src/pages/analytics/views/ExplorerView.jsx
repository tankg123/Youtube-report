import { useCallback, useId, useMemo, useState } from "react";
import { Download, ExternalLink, FlaskConical, History, Play, Search } from "lucide-react";
import PaginationFooter from "../../../components/PaginationFooter";
import { useI18n } from "../../../context/I18nContext";
import { tk } from "../../../i18n/index.js";
import { analyticsApi, analyticsBlobError, analyticsError, downloadAnalyticsFile } from "../../../api/analyticsApi";
import { Badge, Button, Card, EmptyState, Field, InlineMessage, Select, Spinner, TextArea, TextInput, Toggle } from "../../assetDelivery/shared";
import { cx } from "../../assetDelivery/utils";
import { ErrorPanel, LoadingPanel, MetricTable, StatusBadge } from "../shared";
import { useAbortableLoader, useAnalytics } from "../hooks";
import {
  DIMENSION_LABELS,
  METRIC_KINDS,
  REPORT_DESCRIPTIONS,
  SCOPE_LABELS,
  dimensionLabel,
  dimensionValueLabel,
  foldText,
  formatMetric,
  formatScheduleDate,
  isValidDay,
  metricLabel,
  numberValue,
  reportLabel,
  rowsOf
} from "../analyticsUtils";

// Explorer: catalog reports and custom queries against the YouTube Analytics API for one Content Owner and one
// channel at a time (the filter bar's multi-select does not apply here). Results are range snapshots: GET /snapshots
// serves the stored ones of the current selection, POST /query fetches and stores a new one, GET /queries lists the
// stored custom queries and the legacy GET /export?reportId= path downloads a stored result as CSV.

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const OTHER_CHANNEL = "other";
const DEFAULT_REPORT = "daily";
const MAX_RESULTS = 200;
const PAGE_SIZE = 20;
const EMPTY_LIST = Object.freeze([]);
const DEFAULT_QUERY = Object.freeze({ dimensions: "day", metrics: "views,estimatedMinutesWatched,averageViewDuration", filters: "", sort: "day", maxResults: MAX_RESULTS });
const CATEGORY_LABELS = Object.freeze({
  overview: tk("Overview"),
  revenue: tk("Revenue"),
  content: tk("Content"),
  audience: tk("Audience"),
  reach: tk("Reach"),
  engagement: tk("Engagement")
});
// Example API tokens shown as input placeholders (identical in both languages).
const QUERY_PLACEHOLDERS = Object.freeze({ dimensions: "day,country", metrics: "views,estimatedMinutesWatched", filters: "country==VN", sort: "-views" });

const splitList = (value) => [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
const youtubeUrl = (kind, id) => (kind === "channel" ? `https://www.youtube.com/channel/${encodeURIComponent(id)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`);
const errorText = (report) => (typeof report?.error === "string" ? report.error : report?.error?.message || "");
const selectionKey = (id, selection = {}) =>
  [id, selection.startDate, selection.endDate, selection.scope, selection.channelId, selection.videoId, selection.country].map((part) => part || "").join("|");

// A bare 11-character ID, or the ID inside a pasted YouTube URL (watch?v=, youtu.be/, shorts/, live/, embed/).
function videoIdOf(value) {
  const text = String(value || "").trim();
  const match = /(?:[?&]v=|youtu\.be\/|\/(?:shorts|live|embed)\/)([\w-]{11})(?![\w-])/.exec(text);
  return match ? match[1] : text;
}

// readReport statuses (ready | empty | stale | error | missing) and the read service's mapped shape (ready | missing
// with empty / stale flags) both resolve to ready | empty | stale | missing.
function reportState(report) {
  if (!report) return "missing";
  if (report.status === "stale" || report.stale === true) return "stale";
  if (report.status === "empty" || (report.status === "ready" && (report.empty === true || !rowsOf(report).length))) return "empty";
  return report.status === "ready" ? "ready" : "missing";
}

// The filters the server prepends from a selection (see analyticsService baseFilters) so a stored custom query can
// be loaded back into the form with only the user's own filters.
function impliedFilters(selection = {}) {
  const parts = selection.videoId
    ? [`video==${selection.videoId}`]
    : selection.channelId
      ? [`channel==${selection.channelId}`]
      : selection.scope === "self"
        ? ["uploaderType==self"]
        : selection.scope === "thirdParty"
          ? ["claimedStatus==claimed", "uploaderType==thirdParty"]
          : ["claimedStatus==claimed"];
  if (selection.country) parts.push(`country==${selection.country}`);
  return new Set(parts);
}

function userFilters(query, selection) {
  const implied = impliedFilters(selection);
  return String(query?.filters || "")
    .split(";")
    .filter((part) => part && !implied.has(part))
    .join(";");
}

function sortRows(rows, sort) {
  if (!sort.key) return rows;
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a?.[sort.key];
    const right = b?.[sort.key];
    const leftNumber = numberValue(left);
    const rightNumber = numberValue(right);
    if (leftNumber !== null && rightNumber !== null) return (leftNumber - rightNumber) * direction;
    return String(left ?? "").localeCompare(String(right ?? "")) * direction;
  });
}

// Enum values come back as canonical tk labels, hence the t() at the end.
function dimensionText(value, name, { t, channelTitle }) {
  if (name === "channel" && value) return channelTitle(String(value)) || String(value);
  // Numeric dimensions (elapsedVideoTimeRatio) read as the registry kind, not as raw fractions.
  if (typeof value === "number" && METRIC_KINDS[name]) return formatMetric(value, name);
  return t(dimensionValueLabel(value, name));
}

function DimensionCell({ name, value, channelTitle }) {
  const { t } = useI18n();
  if (value === null || value === undefined || value === "") return "—";
  if (name === "video" || name === "channel") {
    const id = String(value);
    const label = name === "channel" ? channelTitle(id) || id : id;
    return (
      <a
        href={youtubeUrl(name, id)}
        target="_blank"
        rel="noreferrer"
        title={id}
        aria-label={t("Open {id} on YouTube", { id: label })}
        className="inline-flex max-w-[22rem] items-center gap-1 font-bold text-blue-700 hover:underline"
      >
        <span className={cx("truncate", label === id && "font-mono text-xs")}>{label}</span>
        <ExternalLink size={12} className="shrink-0" aria-hidden="true" />
      </a>
    );
  }
  return dimensionText(value, name, { t, channelTitle });
}

// Columns follow Google's columnHeaders ({ name, columnType }) when the stored table carries them, else the keys of
// the first row; metrics are right-aligned numbers, dimensions localised labels.
function buildColumns(report, { t, language, channelTitle }) {
  const rows = rowsOf(report);
  const headers =
    Array.isArray(report?.columnHeaders) && report.columnHeaders.length
      ? report.columnHeaders.map((header) => (typeof header === "string" ? { name: header } : header))
      : Object.keys(rows[0] || {}).map((name) => ({ name }));
  return headers
    .filter((header) => header && header.name)
    .map((header) => {
      const name = String(header.name);
      const metric = header.columnType
        ? header.columnType === "METRIC"
        : !DIMENSION_LABELS[name] && (Boolean(METRIC_KINDS[name]) || rows.some((row) => typeof row?.[name] === "number"));
      return {
        key: name,
        label: metric ? t(metricLabel(name)) : t(dimensionLabel(name)),
        align: metric ? "right" : "left",
        sortable: true,
        text: (row) => (metric ? String(row?.[name] ?? "") : dimensionText(row?.[name], name, { t, channelTitle })),
        format: (value) => (metric ? formatMetric(value, name, { language }) : <DimensionCell name={name} value={value} channelTitle={channelTitle} />)
      };
    });
}

// Search, sort and paging of one stored table; remounted (key) for every new result so the state starts clean.
function ResultTable({ report, channelTitle }) {
  const { t, language } = useI18n();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ key: "", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const rows = rowsOf(report);
  const columns = useMemo(() => buildColumns(report, { t, language, channelTitle }), [report, t, language, channelTitle]);
  const needle = foldText(search);
  const filtered = useMemo(
    () => (needle ? rows.filter((row) => columns.some((column) => foldText(column.text(row)).includes(needle))) : rows),
    [rows, columns, needle]
  );
  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const offset = (safePage - 1) * pageSize;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <TextInput
            id={searchId}
            compact
            value={search}
            placeholder={t("Search in the result…")}
            aria-label={t("Search in the result…")}
            className="pl-8"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <span className="text-xs font-bold text-slate-500">{t("{count} rows", { count: sorted.length })}</span>
      </div>
      <MetricTable
        columns={columns}
        rows={sorted.slice(offset, offset + pageSize)}
        rowKey={(row, index) => offset + index}
        sort={sort}
        onSort={(next) => {
          setSort(next);
          setPage(1);
        }}
        empty={t("No rows match the search")}
        footer={sorted.length > PAGE_SIZE ? <PaginationFooter total={sorted.length} page={safePage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} /> : null}
      />
    </div>
  );
}

function ExplorerPanel() {
  const { t, tm, language, formatDate, regionName } = useI18n();
  const { bootstrap, inventory, permissions, filters, refresh, refreshKey, notify } = useAnalytics();
  const { ownerId, startDate, endDate, scope } = filters;
  const baseId = useId();
  const fieldId = (name) => `${baseId}-${name}`;

  const catalog = useMemo(
    () => (bootstrap?.catalog?.reportCatalog ?? EMPTY_LIST).filter((report) => !report.monetary || permissions.canMonetary),
    [bootstrap, permissions.canMonetary]
  );
  const groups = useMemo(() => {
    const map = new Map();
    catalog.forEach((report) => {
      const category = report.category || "other";
      if (!map.has(category)) map.set(category, []);
      map.get(category).push(report);
    });
    return [...map.entries()];
  }, [catalog]);
  const channels = useMemo(() => [...inventory.channels].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""))), [inventory.channels]);
  const channelTitle = useCallback((id) => inventory.byId.get(id)?.title, [inventory.byId]);

  const [selectedId, setSelectedId] = useState(DEFAULT_REPORT);
  const [advanced, setAdvanced] = useState(false);
  const [custom, setCustom] = useState(DEFAULT_QUERY);
  const [channelChoice, setChannelChoice] = useState("");
  const [otherChannelId, setOtherChannelId] = useState("");
  const [videoInput, setVideoInput] = useState("");
  const [countryInput, setCountryInput] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  const selected = catalog.find((report) => report.id === selectedId) || null;
  const mode = advanced ? "custom" : "catalog";
  const videoId = videoIdOf(videoInput);
  const typedChannelId = channelChoice === OTHER_CHANNEL ? otherChannelId.trim() : channelChoice;
  // The API takes one resource filter: a video replaces the channel; retention rejects a country filter.
  const channelId = videoId ? "" : typedChannelId;
  const countryLocked = !advanced && Boolean(selected?.requiresVideo);
  const country = countryLocked ? "" : countryInput.trim().toUpperCase();
  const channelError = typedChannelId && !CHANNEL_ID.test(typedChannelId) ? t("Enter a valid channel ID (UC + 22 characters)") : "";
  const videoError = videoId && !VIDEO_ID.test(videoId) ? t("Enter a valid 11-character video ID") : "";
  const countryError = country && !COUNTRY_CODE.test(country) ? t("Enter a two-letter country code") : "";
  const needsVideo = !advanced && Boolean(selected?.requiresVideo) && !videoId;
  const maxResults = Number(custom.maxResults);
  const metricsError = advanced && !custom.metrics.trim() ? t("Enter at least one metric") : "";
  const maxResultsError = advanced && (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) ? t("Max rows must be between 1 and 200") : "";

  const selection = { ownerId, startDate, endDate, scope, channelId, videoId, country };
  const signature = selectionKey(mode === "custom" ? "custom" : selectedId, selection);
  const selectionValid = Boolean(ownerId) && isValidDay(startDate) && isValidDay(endDate) && !channelError && !videoError && !countryError;
  const storedEnabled = selectionValid;
  // One string key per selection keeps the loader identity stable (useAbortableLoader refetches when it changes).
  const storedParamsKey = JSON.stringify({ ownerId, startDate, endDate, scope, channelId, videoId, country });
  const storedLoader = useCallback((signal) => analyticsApi.snapshots(JSON.parse(storedParamsKey), signal), [storedParamsKey]);
  const stored = useAbortableLoader(storedLoader, { enabled: storedEnabled, version: refreshKey });
  const storedReports = storedEnabled && stored.data ? stored.data.reports || null : null;
  const savedLoader = useCallback((signal) => analyticsApi.queries({ ownerId }, signal), [ownerId]);
  const saved = useAbortableLoader(savedLoader, { enabled: Boolean(ownerId), version: refreshKey });
  const savedQueries = saved.data?.queries ?? EMPTY_LIST;

  // A fetched result stays on screen while the form still describes it; a loaded custom query carries its own
  // selection. Otherwise the stored snapshot of the selected catalog report is shown.
  const runResult = result && result.mode === mode && (mode === "custom" || result.signature === signature) ? result : null;
  const visible = runResult || (mode === "catalog" && storedReports ? { report: storedReports[selectedId] || null, context: selection, fetchedAt: null } : null);
  const report = visible?.report || null;
  const state = reportState(report);
  const rows = rowsOf(report);
  const activeSavedKey = runResult && runResult.mode === "custom" ? selectionKey(runResult.report.id, runResult.context) : "";
  const canRun = permissions.canSync && permissions.connected && selectionValid && !busy && !needsVideo && !metricsError && !maxResultsError;
  const dimensionKeys = splitList(advanced ? custom.dimensions : selected?.dimensions);
  const metricKeys = splitList(advanced ? custom.metrics : selected?.metrics);

  function describe(context, fetchedAt, updatedAt) {
    const parts = [`${formatDate(context.startDate)} – ${formatDate(context.endDate)}`];
    if (context.videoId) parts.push(t("Video {id}", { id: context.videoId }));
    else if (context.channelId) parts.push(channelTitle(context.channelId) || context.channelId);
    else parts.push(t(SCOPE_LABELS[context.scope] || SCOPE_LABELS.claimed));
    if (context.country) parts.push(regionName(context.country, context.country));
    if (fetchedAt) parts.push(t("Fetched {instant}", { instant: formatScheduleDate(fetchedAt, language) }));
    else if (updatedAt) parts.push(t("Stored result from {instant}", { instant: formatScheduleDate(updatedAt, language) }));
    return parts.join(" · ");
  }

  function chooseReport(id) {
    setSelectedId(id);
    setError("");
    if (catalog.find((item) => item.id === id)?.requiresVideo) setCountryInput("");
  }

  function updateCustom(field, value) {
    setCustom((current) => ({ ...current, [field]: value }));
  }

  function loadSaved(item) {
    const itemSelection = item.selection || {};
    setAdvanced(true);
    setCustom({
      dimensions: item.query?.dimensions || "",
      metrics: item.query?.metrics || "",
      filters: userFilters(item.query, itemSelection),
      sort: item.query?.sort || "",
      maxResults: Number(item.query?.maxResults) || MAX_RESULTS
    });
    setResult({
      mode: "custom",
      signature: "",
      report: item,
      fetchedAt: null,
      context: {
        ownerId: itemSelection.ownerId || ownerId,
        startDate: itemSelection.startDate || item.startDate,
        endDate: itemSelection.endDate || item.endDate,
        scope: itemSelection.scope || "claimed",
        channelId: itemSelection.channelId || "",
        videoId: itemSelection.videoId || "",
        country: itemSelection.country || ""
      }
    });
    setError("");
  }

  async function run(event) {
    event.preventDefault();
    if (!canRun) return;
    setBusy(true);
    setError("");
    const body = advanced
      ? { ...selection, dimensions: custom.dimensions.trim(), metrics: custom.metrics.trim(), filters: custom.filters.trim(), sort: custom.sort.trim(), maxResults }
      : { ...selection, reportId: selectedId };
    try {
      const response = await analyticsApi.query(body);
      const fetched = response?.report;
      if (!fetched) throw new Error(tk("The Analytics service answered without a report."));
      setResult({ mode, signature, report: fetched, context: selection, fetchedAt: new Date().toISOString() });
      notify(t("Report saved: {count} rows", { count: rowsOf(fetched).length }), "success");
      // refresh() bumps refreshKey, the version of the stored-results loader, and re-reads the overview whose
      // range-report panels (top videos, demographics, …) share these snapshots; custom queries only touch the list.
      if (advanced) saved.reload();
      else refresh();
    } catch (failure) {
      setError(analyticsError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    if (!report || !rows.length) return;
    const context = visible.context;
    setExporting(true);
    try {
      const response = await analyticsApi.exportFile({
        ownerId: context.ownerId,
        startDate: context.startDate,
        endDate: context.endDate,
        scope: context.scope,
        channelId: context.channelId,
        videoId: context.videoId,
        country: context.country,
        reportId: report.id,
        lang: language
      });
      downloadAnalyticsFile(response, `analytic-${String(report.id).replace(/[^\w-]/g, "-")}-${context.startDate}-${context.endDate}.csv`);
    } catch (failure) {
      notify(t("Could not export the file: {message}", { message: tm(await analyticsBlobError(failure)) }), "error", 6000);
    } finally {
      setExporting(false);
    }
  }

  let body;
  if (busy) {
    body = (
      <InlineMessage tone="info" icon={Spinner} title={t("Querying YouTube Analytics…")}>
        {t("A successful result is stored as a range report.")}
      </InlineMessage>
    );
  } else if (mode === "catalog" && !report && storedEnabled && stored.loading) {
    body = <LoadingPanel rows={5} />;
  } else if (mode === "catalog" && !report && storedEnabled && stored.error) {
    body = <ErrorPanel error={stored.error} onRetry={stored.reload} />;
  } else if (!report || state === "missing") {
    body = (
      <div className="space-y-3">
        {errorText(report) && <InlineMessage tone="warning">{tm(errorText(report))}</InlineMessage>}
        <EmptyState
          compact
          icon={Search}
          title={mode === "custom" ? t("Ready to explore") : t("Not stored yet")}
          description={
            mode === "custom"
              ? t("Set dimensions, metrics and filters, then run the query; results are kept in the saved queries below.")
              : t("Run the report to fetch it from YouTube Analytics; the result is kept for this selection.")
          }
        />
      </div>
    );
  } else if (state === "empty") {
    body = <EmptyState compact icon={Search} title={t("No rows for this selection")} description={t("YouTube answered without rows — missing rows are not zero.")} />;
  } else {
    body = (
      <div className="space-y-3" data-readonly-allow="true">
        {state === "stale" && (
          <InlineMessage tone="warning">
            {t("The latest attempt on {instant} failed: {message}", {
              instant: formatScheduleDate(report.attemptedAt, language) || t("Unknown"),
              message: tm(errorText(report)) || t("Unknown")
            })}
          </InlineMessage>
        )}
        {report.coverage?.limited && report.coverage?.limit && (
          <InlineMessage tone="neutral">{t("YouTube returns at most {limit} rows for this report; use the Bulk archive for the full data.", { limit: report.coverage.limit })}</InlineMessage>
        )}
        <ResultTable key={`${report.id}:${report.updatedAt || ""}:${visible.fetchedAt || ""}`} report={report} channelTitle={channelTitle} />
      </div>
    );
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] [&>*]:min-w-0">
      <Card title={t("Explore reports")} subtitle={t("Query YouTube Analytics for this Content Owner; every successful result is stored as a range report.")} icon={FlaskConical}>
        <form onSubmit={run} className="space-y-4">
          <Field label={t("Report")} htmlFor={fieldId("report")}>
            <Select id={fieldId("report")} value={selectedId} disabled={!catalog.length} onChange={(event) => chooseReport(event.target.value)}>
              {groups.map(([category, reports]) => (
                <optgroup key={category} label={t(CATEGORY_LABELS[category] || category)}>
                  {reports.map((item) => (
                    <option key={item.id} value={item.id}>
                      {t(reportLabel(item.id))}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          {selected && !advanced && (
            <div className="rounded-2xl bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="blue">{t(CATEGORY_LABELS[selected.category] || selected.category)}</Badge>
                {selected.monetary && <Badge tone="amber">USD</Badge>}
                {selected.requiresVideo && <Badge tone="amber">{t("Needs a Video ID")}</Badge>}
                {selected.limit ? <Badge tone="slate">{t("Up to {limit} rows", { limit: selected.limit })}</Badge> : null}
              </div>
              {REPORT_DESCRIPTIONS[selected.id] && <p className="mt-1.5">{t(REPORT_DESCRIPTIONS[selected.id])}</p>}
            </div>
          )}
          <Field
            label={t("Channel")}
            htmlFor={fieldId("channel")}
            error={channelError}
            hint={filters.channelIds.length ? t("The filter bar's channel selection does not apply here; the Explorer queries one channel at a time.") : undefined}
          >
            <Select
              id={fieldId("channel")}
              value={channelChoice}
              disabled={Boolean(videoId)}
              placeholder={t("Whole Content Owner")}
              onChange={(event) => setChannelChoice(event.target.value)}
              options={[
                ...channels.map((channel) => ({
                  value: channel.channelId,
                  label: channel.removedAt ? `${channel.title || channel.channelId} — ${t("No longer managed")}` : channel.title || channel.channelId
                })),
                { value: OTHER_CHANNEL, label: t("Other channel ID…") }
              ]}
            />
            {channelChoice === OTHER_CHANNEL && (
              <TextInput
                id={fieldId("channelId")}
                mono
                className="mt-2"
                value={otherChannelId}
                disabled={Boolean(videoId)}
                invalid={Boolean(channelError)}
                maxLength={24}
                placeholder="UC…"
                aria-label={t("Channel ID")}
                onChange={(event) => setOtherChannelId(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t("Video ID")}
            htmlFor={fieldId("video")}
            required={!advanced && Boolean(selected?.requiresVideo)}
            error={videoError}
            hint={needsVideo ? t("This report needs a Video ID") : t("Optional. A video filter replaces the channel filter.")}
          >
            <TextInput
              id={fieldId("video")}
              mono
              value={videoInput}
              invalid={Boolean(videoError)}
              placeholder={t("e.g. dQw4w9WgXcQ")}
              onChange={(event) => setVideoInput(event.target.value)}
              onBlur={() => setVideoInput(videoId)}
            />
          </Field>
          <Field label={t("Country")} htmlFor={fieldId("country")} error={countryError} hint={countryLocked ? t("Not available for this report") : t("Two-letter ISO code, e.g. VN")}>
            <TextInput
              id={fieldId("country")}
              value={countryLocked ? "" : countryInput}
              disabled={countryLocked}
              invalid={Boolean(countryError)}
              maxLength={2}
              placeholder="VN"
              className="uppercase"
              onChange={(event) => setCountryInput(event.target.value.toUpperCase())}
            />
          </Field>
          <Toggle
            checked={advanced}
            onChange={(next) => {
              setAdvanced(next);
              setError("");
            }}
            label={t("Custom query")}
            description={t("Dimensions, metrics, filters and sort of your choice")}
            className="w-full border border-slate-200 px-3 py-2.5"
          />
          {advanced && (
            <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">{t("Dimension and metric combinations must be supported by YouTube; the Content Owner filter and your role's permissions always apply.")}</p>
              <Field label={t("Dimensions")} htmlFor={fieldId("dimensions")}>
                <TextInput id={fieldId("dimensions")} mono compact value={custom.dimensions} placeholder={QUERY_PLACEHOLDERS.dimensions} onChange={(event) => updateCustom("dimensions", event.target.value)} />
              </Field>
              <Field label={t("Metrics")} htmlFor={fieldId("metrics")} required error={metricsError}>
                <TextArea id={fieldId("metrics")} mono compact rows={3} value={custom.metrics} placeholder={QUERY_PLACEHOLDERS.metrics} onChange={(event) => updateCustom("metrics", event.target.value)} />
              </Field>
              <Field label={t("Extra filters")} htmlFor={fieldId("filters")}>
                <TextInput id={fieldId("filters")} mono compact value={custom.filters} placeholder={QUERY_PLACEHOLDERS.filters} onChange={(event) => updateCustom("filters", event.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("Sort")} htmlFor={fieldId("sort")}>
                  <TextInput id={fieldId("sort")} mono compact value={custom.sort} placeholder={QUERY_PLACEHOLDERS.sort} onChange={(event) => updateCustom("sort", event.target.value)} />
                </Field>
                <Field label={t("Max rows")} htmlFor={fieldId("maxResults")} error={maxResultsError}>
                  <TextInput
                    id={fieldId("maxResults")}
                    type="number"
                    compact
                    min={1}
                    max={MAX_RESULTS}
                    value={custom.maxResults}
                    invalid={Boolean(maxResultsError)}
                    onChange={(event) => updateCustom("maxResults", event.target.value)}
                  />
                </Field>
              </div>
            </div>
          )}
          {permissions.canSync ? (
            <Button type="submit" icon={Play} loading={busy} disabled={!canRun} className="w-full" title={permissions.connected ? undefined : t("CMS disconnected")}>
              {advanced ? t("Run query") : t("Run report")}
            </Button>
          ) : (
            <InlineMessage tone="neutral">{t("Your role can browse stored results but cannot run new queries.")}</InlineMessage>
          )}
          {permissions.canSync && !permissions.connected && <InlineMessage tone="warning">{t("Reconnect the CMS to run new queries; stored results stay browsable.")}</InlineMessage>}
          {error && <InlineMessage tone="error">{tm(error)}</InlineMessage>}
        </form>
        <div className="mt-5 border-t border-slate-100 pt-4">
          <p className="text-xs font-black uppercase tracking-wide text-slate-400">{t("Report structure")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-black uppercase text-slate-400">{t("Dimensions")}</span>
            {dimensionKeys.length ? (
              dimensionKeys.map((key) => (
                <code key={key} title={t(dimensionLabel(key))} className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                  {key}
                </code>
              ))
            ) : (
              <span className="text-xs text-slate-500">{t("Totals")}</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-black uppercase text-slate-400">{t("Metrics")}</span>
            {metricKeys.map((key) => (
              <Badge key={key} tone="slate" title={key} className="normal-case tracking-normal">
                {t(metricLabel(key))}
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">{t("Availability depends on the CMS permissions, the content type and what YouTube publishes; empty results are shown as they are.")}</p>
        </div>
      </Card>

      <div className="space-y-5">
        <Card
          title={advanced ? t("Custom query result") : t(reportLabel(selectedId))}
          subtitle={visible ? describe(visible.context, visible.fetchedAt, report?.updatedAt) : describe(selection, null, null)}
          icon={Search}
          actions={
            <>
              {report && <StatusBadge status={state} />}
              <span data-readonly-allow="true">
                <Button variant="secondary" size="sm" icon={Download} loading={exporting} disabled={!rows.length} onClick={exportCsv}>
                  {t("Export CSV")}
                </Button>
              </span>
            </>
          }
        >
          {body}
        </Card>
        {savedQueries.length > 0 && (
          <Card title={t("Saved queries")} subtitle={t("Custom query results kept for this Content Owner")} icon={History}>
            <ul data-readonly-allow="true" className="grid gap-2 md:grid-cols-2">
              {savedQueries.map((item) => {
                const key = selectionKey(item.id, item.selection);
                const active = key === activeSavedKey;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => loadSaved(item)}
                      className={cx(
                        "w-full rounded-2xl border px-3 py-2.5 text-left transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200",
                        active ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white"
                      )}
                    >
                      <span className="block truncate text-sm font-black text-slate-800">
                        {item.query?.dimensions || t("Totals")} · {t("{count} rows", { count: rowsOf(item).length })}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-slate-500">{describe(item.selection || item, null, item.updatedAt)}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-400">{item.query?.metrics}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

// The channel / video / country inputs, the custom form and the last result belong to one Content Owner: a new
// owner remounts the panel with a clean state.
export default function ExplorerView() {
  const { filters } = useAnalytics();
  return <ExplorerPanel key={filters.ownerId || "none"} />;
}
