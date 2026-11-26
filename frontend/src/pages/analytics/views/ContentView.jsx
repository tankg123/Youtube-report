import { useSystemSettings } from "../../../context/SystemSettingsContext";
import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Archive, DatabaseZap, Film, RefreshCw } from "lucide-react";
import PaginationFooter from "../../../components/PaginationFooter";
import { useI18n } from "../../../context/I18nContext";
import { Button, EmptyState } from "../../assetDelivery/shared";
import { cx } from "../../assetDelivery/utils";
import { BarList, DonutChart } from "../charts";
import { useAnalytics } from "../hooks";
import { ErrorPanel, ExportMenu, LoadingPanel, MetricTable, PanelHeader } from "../shared";
import {
  REPORT_DESCRIPTIONS,
  REPORT_LABELS,
  dimensionLabel,
  dimensionValueLabel,
  downloadCsv,
  formatMetric,
  formatScheduleDate,
  metricLabel,
  numberValue
} from "../analyticsUtils";

// Content view: top videos, video revenue and the content-shape breakdowns of the current filters. The report panels
// defined here (ReportPanel, BreakdownPanel, SnapshotPanel, PanelExportMenu, ViewPlaceholder) are shared with
// AudienceView and RevenueView: every panel reads the stored data of useAnalytics().overview, shows its status
// (ready / partial / missing / unsupported) with the pinned sentences, and exports the table it shows client-side
// ("This table (CSV)"); the server files of EXPORTS_BY_VIEW belong to the sticky top-bar ExportMenu only.

const TABLE_LIMIT = 10;
const PAGE_SIZE = 20;
const VIDEO_METRICS = ["views", "engagedViews", "watchHours", "averageViewDuration", "averageViewPercentage", "likes", "comments", "shares", "subscribersGained"];
const VIDEO_REVENUE_METRICS = ["views", "estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "rpm", "monetizedPlaybacks", "cpm", "playbackBasedCpm"];
const WATCH_METRICS = ["views", "engagedViews", "watchHours"];
const CONTENT_TYPE_METRICS = ["views", "engagedViews", "watchHours", "averageViewDuration", "estimatedRevenue", "rpm"];

const isRow = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Columns a table shows: the metrics present in at least one row (non-monetary roles never receive revenue keys).
const presentKeys = (keys, rows) => keys.filter((key) => rows.some((row) => row[key] !== undefined));

// Finite metric values plus the derived keys of the registry: watch hours from minutes, RPM from revenue and views.
function withDerived(source, omitKey) {
  const metrics = {};
  for (const [key, value] of Object.entries(source || {})) {
    const number = key === omitKey ? null : numberValue(value);
    if (number !== null) metrics[key] = number;
  }
  if (metrics.watchHours === undefined && metrics.estimatedMinutesWatched !== undefined) metrics.watchHours = metrics.estimatedMinutesWatched / 60;
  if (metrics.rpm === undefined && metrics.estimatedRevenue !== undefined && metrics.views > 0) metrics.rpm = (metrics.estimatedRevenue * 1000) / metrics.views;
  return metrics;
}

// Breakdown rows come as { value, metrics } from the warehouse, or as flat snapshot rows ({ deviceType, views, … })
// when one channel is selected; both become { value, label, metrics }.
function breakdownRows(breakdown, dimension) {
  return (Array.isArray(breakdown?.rows) ? breakdown.rows : []).filter(isRow).map((row) => {
    const raw = row.value ?? row[dimension] ?? "";
    const metrics = isRow(row.metrics) ? withDerived(row.metrics) : withDerived(row, dimension);
    return { value: String(raw), label: dimensionValueLabel(raw, dimension), metrics };
  });
}

// Numbers numerically, texts by locale, rows without the value last whatever the direction.
function sortRows(rows, sort) {
  if (!sort?.key) return rows;
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = numberValue(a[sort.key]);
    const right = numberValue(b[sort.key]);
    if (left === null && right === null) return sign * String(a[sort.key] ?? "").localeCompare(String(b[sort.key] ?? ""));
    if (left === null || right === null) return left === null ? 1 : -1;
    return sign * (left - right);
  });
}

// GET /overview `videos` metadata: an array of rows (videoId or video_id) or a map keyed by video ID.
function videoIndex(videos) {
  const list = Array.isArray(videos) ? videos : isRow(videos) ? Object.entries(videos).map(([videoId, item]) => ({ videoId, ...item })) : [];
  return new Map(
    list.filter(isRow).map((item) => [
      String(item.videoId ?? item.video_id ?? item.id ?? ""),
      { title: item.title || "", thumbnail: item.thumbnail || "", channelId: item.channelId ?? item.channel_id ?? "", publishedAt: item.publishedAt ?? item.published_at ?? "" }
    ])
  );
}

function flattenVideos(rows, index, inventory) {
  return (Array.isArray(rows) ? rows : []).filter(isRow).map((row) => {
    const id = String(row.video ?? row.videoId ?? "");
    const meta = index.get(id);
    const channel = meta?.channelId ? inventory.byId.get(meta.channelId)?.title || meta.channelId : "";
    return { id, title: meta?.title || id, thumbnail: meta?.thumbnail || "", channel, publishedAt: meta?.publishedAt || "", ...withDerived(row, "video") };
  });
}

// ---------------------------------------------------------------------------
// Shared panel chrome
// ---------------------------------------------------------------------------

export function ViewPlaceholder({ loading = false, error = "", onRetry, ownerId = "" }) {
  const { t } = useI18n();
  if (error) return <ErrorPanel error={error} onRetry={onRetry} />;
  if (loading) return <LoadingPanel rows={8} />;
  return <EmptyState icon={DatabaseZap} title={ownerId ? t("No stored data for this range") : t("No Content Owner available")} />;
}

export function ReportPanel({ title, subtitle, status, actions, children }) {
  return (
    <section className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <PanelHeader title={title} subtitle={subtitle} status={status} actions={actions} />
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * MetricTable sorted and cut client-side: `rows` are flat objects; with `limit` the table shows the leading rows
 * and a "Show all" toggle, otherwise it pages through PaginationFooter once the rows exceed one page.
 */
export function DataTable({ columns, rows, rowKey = "id", initialSort = null, limit = 0, empty }) {
  const { t } = useI18n();
  const [sort, setSort] = useState(initialSort);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const paged = !limit && sorted.length > PAGE_SIZE;
  const current = Math.min(page, Math.max(1, Math.ceil(sorted.length / pageSize)));
  const visible = limit ? (expanded ? sorted : sorted.slice(0, limit)) : paged ? sorted.slice((current - 1) * pageSize, current * pageSize) : sorted;
  return (
    <div className="space-y-3">
      <MetricTable
        columns={columns}
        rows={visible}
        rowKey={rowKey}
        sort={sort}
        onSort={setSort}
        empty={empty}
        footer={paged ? <PaginationFooter total={sorted.length} page={current} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} /> : undefined}
      />
      {limit > 0 && sorted.length > limit && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t("Show less") : t("Show all {count} rows", { count: sorted.length })}
        </Button>
      )}
    </div>
  );
}

/**
 * Export menu of one panel: only the table as shown (client-side CSV, formula-neutralised, never a server call).
 * `csv` = { columns, rows, filename } or null when there is nothing to save (the menu is then disabled).
 */
export function PanelExportMenu({ csv = null }) {
  const { t } = useI18n();
  const options = csv?.rows?.length ? [{ key: "table", label: t("This table (CSV)"), format: "csv" }] : [];
  return <ExportMenu options={options} onSelect={() => downloadCsv(csv.columns, csv.rows, csv.filename)} />;
}

// The pinned sentences of a report the server cannot build for the current channel selection.
function SelectionNotice({ dimension = "", kind = "breakdown" }) {
  const { t } = useI18n();
  const { filters } = useAnalytics();
  const text =
    dimension === "adType" && filters.channelIds.length
      ? t("Ad types are only reported at Content Owner level")
      : kind === "snapshot"
        ? t("Range reports are stored per Content Owner or for one channel — select one channel or none")
        : t("Breakdowns are stored per Content Owner — select one channel or none");
  return <EmptyState compact title={text} />;
}

// "Sync all" call to action of a report with nothing stored: a write action, hidden without canSync and disabled
// with a reason while the CMS is disconnected or a job is running (same rule as the shell's button).
function SyncCta({ description = "" }) {
  const { t } = useI18n();
  const { permissions, jobActive, openSyncDialog } = useAnalytics();
  const blocked = !permissions.connected ? t("CMS disconnected") : jobActive ? t("A sync is already running") : "";
  return (
    <EmptyState
      compact
      icon={DatabaseZap}
      title={t("Not synced for this range yet")}
      description={description || t("Run Sync all to store this report.")}
      action={
        permissions.canSync ? (
          <Button size="sm" icon={RefreshCw} disabled={Boolean(blocked)} title={blocked || undefined} onClick={() => openSyncDialog()}>
            {t("Sync all")}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * One stored breakdown (overview.breakdowns[dimension]): a chart of the leading rows, a sortable table of every row
 * with its share of the total, the client CSV and the server breakdown file. `metrics` lists the candidate columns;
 * only the keys present in the rows are shown.
 */
export function BreakdownPanel({ dimension, title, subtitle, breakdown, metrics, chart = "bars", chartMetric, limit = TABLE_LIMIT }) {
  const { t, language, formatNumber } = useI18n();
  const { filters } = useAnalytics();
  const metric = chartMetric || metrics[0];
  const rows = useMemo(() => breakdownRows(breakdown, dimension), [breakdown, dimension]);
  const ranked = useMemo(() => {
    const total = rows.reduce((sum, row) => sum + (row.metrics[metric] ?? 0), 0);
    const flat = rows.map((row) => ({
      id: row.value,
      value: row.value,
      label: row.label,
      share: total > 0 && row.metrics[metric] !== undefined ? row.metrics[metric] / total : null,
      ...row.metrics
    }));
    return sortRows(flat, { key: metric, direction: "desc" });
  }, [rows, metric]);
  const keys = presentKeys(metrics, ranked);
  const status = breakdown?.status || "missing";
  const coverageText =
    status === "partial" && breakdown?.totalDays ? t("{covered}/{total} days stored", { covered: breakdown.coveredDays ?? 0, total: breakdown.totalDays }) : "";
  const format = (value) => formatMetric(value, metric, { language });
  const percent = (value) => (value === null || value === undefined ? "—" : `${formatNumber(value * 100, { maximumFractionDigits: 1 })}%`);
  const columns = [
    {
      key: "label",
      label: t(dimensionLabel(dimension)),
      sortable: true,
      format: (value, row) => (
        <span className="font-bold text-slate-800" title={row.value}>
          {t(value)}
        </span>
      )
    },
    ...keys.map((key) => ({ key, label: t(metricLabel(key)), align: "right", sortable: true, format: (value) => formatMetric(value, key, { language }) })),
    { key: "share", label: t("Share of total"), align: "right", sortable: true, format: percent }
  ];
  const csv = {
    columns: [
      { key: "label", label: t(dimensionLabel(dimension)), value: (row) => t(row.label) },
      { key: "value", label: t("Code") },
      ...keys.map((key) => ({ key, label: t(metricLabel(key)) })),
      { key: "share", label: t("Share of total"), value: (row) => (row.share === null ? "" : Math.round(row.share * 10000) / 100) }
    ],
    rows: ranked,
    filename: `analytics-breakdown-${dimension}-${filters.ownerId}-${filters.startDate}-${filters.endDate}.csv`
  };

  let body;
  if (status === "unsupported") body = <SelectionNotice dimension={dimension} />;
  else if (status === "missing") body = <SyncCta />;
  else if (!ranked.length) body = <EmptyState compact title={t("YouTube reported no rows for this range")} />;
  else
    body = (
      <div className="space-y-4">
        {chart === "donut" && (
          <DonutChart segments={ranked.map((row) => ({ key: row.value, label: t(row.label), value: row[metric] }))} format={format} title={t(metricLabel(metric))} />
        )}
        {chart === "bars" && (
          <BarList
            rows={ranked.slice(0, limit).map((row) => ({ key: row.value, label: t(row.label), value: row[metric], share: row.share }))}
            format={format}
            title={t(metricLabel(metric))}
          />
        )}
        <DataTable columns={columns} rows={ranked} initialSort={{ key: metric, direction: "desc" }} limit={limit} />
      </div>
    );

  return (
    <ReportPanel
      title={title}
      subtitle={[subtitle, coverageText].filter(Boolean).join(" · ")}
      status={status === "ready" ? undefined : status}
      actions={<PanelExportMenu csv={ranked.length ? csv : null} />}
    >
      {body}
    </ReportPanel>
  );
}

/**
 * One range report stored as a snapshot (top videos, video revenue, age & gender): `snapshot` is the overview entry
 * ({ status, stale, attemptedAt, error, rows, updatedAt }); `children` renders the rows when there are any.
 */
export function SnapshotPanel({ title, subtitle, snapshot, csv = null, actions, children }) {
  const { t, tm, language } = useI18n();
  const status = snapshot?.status || "missing";
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const stale = Boolean(snapshot?.stale);
  const failure = typeof snapshot?.error === "string" ? snapshot.error : snapshot?.error?.message || "";
  const error = failure ? tm(failure) : "";
  const details = [subtitle];
  if (snapshot?.updatedAt) details.push(t("Updated {instant}", { instant: formatScheduleDate(snapshot.updatedAt, language) }));
  if (stale) details.push(t("Last refresh failed {instant}: {error}", { instant: formatScheduleDate(snapshot.attemptedAt, language), error }));

  let body;
  if (status === "unsupported") body = <SelectionNotice kind="snapshot" />;
  else if (status === "missing") body = <SyncCta description={error} />;
  else if (!rows.length) body = <EmptyState compact title={t("YouTube reported no rows for this range")} />;
  else body = children;

  return (
    <ReportPanel
      title={title}
      subtitle={details.filter(Boolean).join(" · ")}
      status={stale ? "stale" : status === "ready" ? undefined : status}
      actions={
        <>
          {actions}
          <PanelExportMenu csv={rows.length ? csv : null} />
        </>
      }
    >
      {body}
    </ReportPanel>
  );
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

function VideoCell({ row }) {
  const { t, formatDate } = useI18n();
  const meta = [row.channel, row.publishedAt ? formatDate(row.publishedAt) : ""].filter(Boolean).join(" · ");
  return (
    <div className="flex min-w-[16rem] items-center gap-3">
      {row.thumbnail ? (
        <img src={row.thumbnail} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="flex h-9 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
          <Film size={14} aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0">
        <a
          href={`https://www.youtube.com/watch?v=${encodeURIComponent(row.id)}`}
          target="_blank"
          rel="noreferrer"
          title={t("Watch on YouTube")}
          className="block truncate font-bold text-slate-800 hover:text-blue-700 hover:underline"
        >
          {row.title}
        </a>
        <span className="block truncate text-[11px] text-slate-400">{meta || row.id}</span>
      </span>
    </div>
  );
}

// Sortable, paged table of flattened video rows (`keys` = the metric columns present in the rows).
function VideoTable({ rows, keys }) {
  const { t, language } = useI18n();
  const columns = [
    { key: "title", label: t("Video"), sortable: true, format: (value, row) => <VideoCell row={row} /> },
    ...keys.map((key) => ({ key, label: t(metricLabel(key)), align: "right", sortable: true, format: (value) => formatMetric(value, key, { language }) }))
  ];
  return <DataTable columns={columns} rows={rows} initialSort={{ key: keys[0] || "title", direction: "desc" }} />;
}

export default function ContentView() {
  const { isSidebarVisible } = useSystemSettings();
  const { t } = useI18n();
  const location = useLocation();
  const { overview, overviewLoading, overviewError, refresh, filters, permissions, inventory } = useAnalytics();
  const index = useMemo(() => videoIndex(overview?.videos), [overview]);
  const topVideos = useMemo(() => flattenVideos(overview?.topVideos?.rows, index, inventory), [overview, index, inventory]);
  const videoRevenue = useMemo(() => flattenVideos(overview?.videoRevenue?.rows, index, inventory), [overview, index, inventory]);
  if (!overview) return <ViewPlaceholder loading={overviewLoading} error={overviewError} onRetry={refresh} ownerId={filters.ownerId} />;

  const stamp = `${filters.ownerId}-${filters.startDate}-${filters.endDate}`;
  const topKeys = presentKeys(VIDEO_METRICS, topVideos);
  const revenueKeys = presentKeys(VIDEO_REVENUE_METRICS, videoRevenue);
  const videoCsv = (rows, keys, filename) => ({
    columns: [
      { key: "id", label: t("Video ID") },
      { key: "title", label: t("Title") },
      { key: "channel", label: t("Channel") },
      { key: "publishedAt", label: t("Published") },
      ...keys.map((key) => ({ key, label: t(metricLabel(key)) }))
    ],
    rows,
    filename
  });
  const breakdowns = overview.breakdowns || {};

  return (
    <div className={cx("space-y-5", overviewLoading && "opacity-60")} aria-busy={overviewLoading || undefined}>
      {overviewError && <ErrorPanel error={overviewError} onRetry={refresh} />}
      <SnapshotPanel
        title={t(REPORT_LABELS.videos)}
        subtitle={t(REPORT_DESCRIPTIONS.videos)}
        snapshot={overview.topVideos}
        csv={videoCsv(topVideos, topKeys, `analytics-top-videos-${stamp}.csv`)}
        actions={
          permissions.canMonetary && isSidebarVisible("/analytic/sync#bulk") ? (
            <Link to={{ pathname: "/analytic/sync", search: location.search }} className="inline-flex items-center gap-1 text-xs font-black text-blue-700 hover:underline">
              <Archive size={13} aria-hidden="true" />
              {t("Open the Bulk archive")}
            </Link>
          ) : null
        }
      >
        <VideoTable rows={topVideos} keys={topKeys} />
      </SnapshotPanel>
      {permissions.canMonetary && (
        <SnapshotPanel
          title={t(REPORT_LABELS.videoRevenue)}
          subtitle={t(REPORT_DESCRIPTIONS.videoRevenue)}
          snapshot={overview.videoRevenue}
          csv={videoCsv(videoRevenue, revenueKeys, `analytics-video-revenue-${stamp}.csv`)}
        >
          <VideoTable rows={videoRevenue} keys={revenueKeys} />
        </SnapshotPanel>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        <BreakdownPanel
          dimension="creatorContentType"
          title={t(REPORT_LABELS.contentTypes)}
          subtitle={t(REPORT_DESCRIPTIONS.contentTypes)}
          breakdown={breakdowns.creatorContentType}
          metrics={CONTENT_TYPE_METRICS}
        />
        <BreakdownPanel
          dimension="liveOrOnDemand"
          title={t(REPORT_LABELS.liveStatus)}
          subtitle={t(REPORT_DESCRIPTIONS.liveStatus)}
          breakdown={breakdowns.liveOrOnDemand}
          metrics={WATCH_METRICS}
        />
        <BreakdownPanel
          dimension="insightPlaybackLocationType"
          title={t(REPORT_LABELS.playbackLocations)}
          subtitle={t(REPORT_DESCRIPTIONS.playbackLocations)}
          breakdown={breakdowns.insightPlaybackLocationType}
          metrics={WATCH_METRICS}
        />
        <BreakdownPanel
          dimension="youtubeProduct"
          title={t(REPORT_LABELS.youtubeProducts)}
          subtitle={t(REPORT_DESCRIPTIONS.youtubeProducts)}
          breakdown={breakdowns.youtubeProduct}
          metrics={WATCH_METRICS}
          chart="donut"
        />
      </div>
    </div>
  );
}
