import { useSystemSettings } from "../../../context/SystemSettingsContext";
import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Clock3, Coins, Download, ExternalLink, Eye, Film, Globe2, Layers3, MonitorSmartphone, MousePointerClick, RefreshCw, Route, UserRoundPlus } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { tk } from "../../../i18n/index.js";
import { Button, Card, EmptyState, IconButton, InlineMessage, Select, Toggle } from "../../assetDelivery/shared";
import { cx } from "../../assetDelivery/utils";
import { useAnalytics } from "../hooks";
import { BarList, DonutChart, TrendChart } from "../charts";
import { CoverageStrip, DailyRunLine, ErrorPanel, KpiTile, LoadingPanel, MetricTable, PanelHeader } from "../shared";
import {
  buildFillMissingRequest,
  dimensionLabel,
  dimensionValueLabel,
  downloadCsv,
  formatMetric,
  formatScheduleDate,
  metricLabel,
  numberValue,
  rowsOf
} from "../analyticsUtils";

// Overview of the stored numbers for the current filters: the morning status of the daily sync, the coverage of
// the range, six KPI tiles, the daily trend and the headline panels (top videos, countries, traffic sources,
// devices, content types). Everything comes from GET /overview through useAnalytics(); refetches keep the frame.

const KPI_TILES = [
  { key: "views", icon: Eye },
  { key: "watchHours", icon: Clock3 },
  { key: "netSubscribers", icon: UserRoundPlus },
  { key: "estimatedRevenue", icon: Coins, monetary: true },
  { key: "engagedViews", icon: MousePointerClick },
  { key: "rpm", icon: Coins, monetary: true }
];
const TREND_METRICS = [
  "views", "engagedViews", "watchHours", "estimatedMinutesWatched", "netSubscribers", "subscribersGained", "subscribersLost", "likes",
  "comments", "shares", "averageViewDuration", "estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "rpm", "cpm"
];
const MONETARY_METRICS = new Set(["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "rpm", "cpm"]);
const BREAKDOWN_PANELS = [
  { dimension: "country", title: tk("Countries"), form: "bars", icon: Globe2 },
  { dimension: "insightTrafficSourceType", title: tk("Traffic sources"), form: "bars", icon: Route },
  { dimension: "deviceType", title: tk("Devices"), form: "donut", icon: MonitorSmartphone },
  { dimension: "creatorContentType", title: tk("Content types"), form: "bars", icon: Layers3 }
];
const BREAKDOWN_METRICS = ["views", "engagedViews", "estimatedMinutesWatched"];
const TOP_VIDEO_ROWS = 10;
const BAR_ROWS = 8;

const gap = (coverage) => Math.max(0, (Number(coverage?.total) || 0) - (Number(coverage?.covered) || 0));
const totalsOf = (summary) => summary?.totals || summary || {};

// Breakdown rows arrive as warehouse rows ({ value, metrics }) for owner entities and as snapshot rows
// ({ <dimension>: value, ...metrics }) for a single channel; both become { value, metrics }.
function breakdownRows(breakdown, dimension) {
  return rowsOf(breakdown)
    .map((row) => {
      if (row?.metrics && typeof row.metrics === "object") return { value: row.value, metrics: row.metrics };
      const { [dimension]: value, ...metrics } = row || {};
      return { value, metrics };
    })
    .filter((row) => row.value !== undefined && row.value !== null)
    .sort((a, b) => (numberValue(b.metrics.views) || 0) - (numberValue(a.metrics.views) || 0));
}

// GET /overview `videos` metadata: an array of inventory rows or a map keyed by video id.
function videoMetadata(videos) {
  const list = Array.isArray(videos) ? videos : videos && typeof videos === "object" ? Object.entries(videos).map(([id, item]) => ({ ...item, videoId: id })) : [];
  const map = new Map();
  for (const item of list) {
    const id = item?.videoId || item?.video_id || item?.id;
    if (id) map.set(String(id), item);
  }
  return map;
}

function snapshotStatus(snapshot) {
  if (!snapshot) return "missing";
  if (snapshot.stale) return "stale";
  return snapshot.status === "ready" || snapshot.status === "empty" ? "ready" : snapshot.status || "missing";
}

function ExportIcon({ label, onClick }) {
  return (
    <span data-readonly-allow="true">
      <IconButton icon={Download} label={label} size="sm" onClick={onClick} />
    </span>
  );
}

function SyncAllAction({ canSync, disabled, title, onClick }) {
  const { t } = useI18n();
  if (!canSync) return undefined;
  return (
    <Button size="sm" icon={RefreshCw} disabled={disabled} title={title} onClick={onClick}>
      {t("Sync all")}
    </Button>
  );
}

function BreakdownPanel({ panel, breakdown, multiChannel, filename, syncAction, loading }) {
  const { t, tm, language } = useI18n();
  const rows = useMemo(() => breakdownRows(breakdown, panel.dimension), [breakdown, panel.dimension]);
  const total = rows.reduce((sum, row) => sum + (numberValue(row.metrics.views) || 0), 0);
  const unsupported = multiChannel || breakdown?.status === "unsupported";
  const status = unsupported ? "unsupported" : !breakdown ? "missing" : breakdown.stale ? "stale" : breakdown.status || "missing";
  const label = (row) => t(dimensionValueLabel(row.value, panel.dimension));
  const formatViews = (value) => formatMetric(value, "views", { language });
  const subtitle =
    status === "partial" && breakdown?.totalDays
      ? t("{covered}/{total} days stored", { covered: breakdown.coveredDays, total: breakdown.totalDays })
      : status === "stale" && breakdown?.error
        ? tm(breakdown.error)
        : undefined;

  function exportRows() {
    downloadCsv(
      [
        { key: "label", label: t(dimensionLabel(panel.dimension)), value: label },
        { key: "value", label: t("Value") },
        ...BREAKDOWN_METRICS.map((key) => ({ key, label: t(metricLabel(key)), value: (row) => numberValue(row.metrics[key]) })),
        { key: "share", label: t("Share of total"), value: (row) => (total ? Math.round(((numberValue(row.metrics.views) || 0) / total) * 10000) / 100 : null) }
      ],
      rows,
      filename
    );
  }

  let body;
  if (unsupported) body = <EmptyState compact icon={Layers3} title={t("Breakdowns are stored per Content Owner — select one channel or none")} />;
  else if (status === "missing") body = <EmptyState compact title={t("No stored data for this range")} description={t("Run Sync all to store this report.")} action={syncAction} />;
  else if (!rows.length) body = <EmptyState compact title={t("Nothing to show.")} />;
  else if (panel.form === "donut") body = <DonutChart segments={rows.map((row) => ({ key: String(row.value), label: label(row), value: numberValue(row.metrics.views) }))} format={formatViews} />;
  else
    body = (
      <BarList
        rows={rows.slice(0, BAR_ROWS).map((row) => ({ key: String(row.value), label: label(row), value: numberValue(row.metrics.views), share: total ? (numberValue(row.metrics.views) || 0) / total : null }))}
        format={formatViews}
      />
    );

  return (
    <Card className="min-w-0">
      <PanelHeader title={t(panel.title)} status={status} subtitle={subtitle} actions={rows.length > 0 && !unsupported ? <ExportIcon label={t("Export CSV")} onClick={exportRows} /> : undefined} />
      <div className={cx("mt-4", loading && "opacity-60")} aria-busy={loading || undefined}>
        {body}
      </div>
    </Card>
  );
}

function TopVideosPanel({ snapshot, metadata, search, filename, syncAction, loading }) {
  const { isSidebarVisible } = useSystemSettings();
  const { t, tm, language } = useI18n();
  const status = snapshotStatus(snapshot);
  const rows = useMemo(
    () =>
      rowsOf(snapshot)
        .slice(0, TOP_VIDEO_ROWS)
        .map((row, index) => {
          const id = String(row.video ?? row.videoId ?? "");
          const meta = metadata.get(id) || {};
          const minutes = numberValue(row.estimatedMinutesWatched);
          return {
            rank: index + 1,
            id,
            title: meta.title || row.title || id,
            thumbnail: meta.thumbnail || null,
            channelTitle: meta.channelTitle || meta.channel_title || "",
            views: numberValue(row.views),
            watchHours: minutes === null ? null : minutes / 60,
            averageViewDuration: numberValue(row.averageViewDuration),
            likes: numberValue(row.likes),
            comments: numberValue(row.comments),
            shares: numberValue(row.shares)
          };
        }),
    [snapshot, metadata]
  );
  const cell = (key) => (value) => formatMetric(value, key, { language });
  const columns = [
    { key: "rank", label: "#", width: 44, align: "right", format: (value) => <span className="text-slate-400">{value}</span> },
    {
      key: "title",
      label: t("Video"),
      format: (value, row) => (
        <span className="flex min-w-0 items-center gap-3">
          {row.thumbnail ? (
            <img src={row.thumbnail} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="flex h-9 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
              <Film size={14} aria-hidden="true" />
            </span>
          )}
          <span className="min-w-0">
            <span className="block max-w-md truncate font-bold text-slate-800" title={value}>
              {value}
            </span>
            <span className="block truncate font-mono text-[11px] text-slate-400">{row.channelTitle || row.id}</span>
          </span>
          <a
            href={`https://www.youtube.com/watch?v=${encodeURIComponent(row.id)}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t("Open on YouTube")}
            title={t("Open on YouTube")}
            className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-blue-700"
          >
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </span>
      )
    },
    { key: "views", label: t("Views"), align: "right", format: cell("views") },
    { key: "watchHours", label: t("Watch hours"), align: "right", format: cell("watchHours") },
    { key: "averageViewDuration", label: t("Average view duration"), align: "right", format: cell("averageViewDuration") },
    { key: "likes", label: t("Likes"), align: "right", format: cell("likes") },
    { key: "comments", label: t("Comments"), align: "right", format: cell("comments") }
  ];
  const subtitle = [
    snapshot?.updatedAt ? t("Updated {instant}", { instant: formatScheduleDate(snapshot.updatedAt, language) }) : "",
    status === "stale" && snapshot?.error ? tm(snapshot.error) : ""
  ].filter(Boolean).join(" · ") || undefined;

  function exportRows() {
    downloadCsv(
      [
        { key: "rank", label: "#" },
        { key: "id", label: t("Video ID") },
        { key: "title", label: t("Title") },
        { key: "channelTitle", label: t("Channel") },
        { key: "views", label: t("Views") },
        { key: "watchHours", label: t("Watch hours"), value: (row) => (row.watchHours === null ? null : Math.round(row.watchHours * 100) / 100) },
        { key: "averageViewDuration", label: t("Average view duration") },
        { key: "likes", label: t("Likes") },
        { key: "comments", label: t("Comments") },
        { key: "shares", label: t("Shares") }
      ],
      rows,
      filename
    );
  }

  const empty =
    status === "missing" ? (
      <EmptyState compact icon={Film} title={t("No stored data for this range")} description={t("Run Sync all to store this report.")} action={syncAction} />
    ) : (
      t("Nothing to show.")
    );

  return (
    <Card className="min-w-0">
      <PanelHeader
        title={t("Top videos")}
        status={status}
        subtitle={subtitle}
        actions={
          <>
            {rows.length > 0 && <ExportIcon label={t("Export CSV")} onClick={exportRows} />}
            {isSidebarVisible("/analytic/content") && <Link to={{ pathname: "/analytic/content", search }} className="text-xs font-black text-blue-700 hover:underline">
              {t("View all in Content")}
            </Link>}
          </>
        }
      />
      <div className="mt-4">
        <MetricTable columns={columns} rows={rows} rowKey="id" loading={loading} empty={empty} />
      </div>
    </Card>
  );
}

export default function OverviewView() {
  const { t, tm, language } = useI18n();
  const { search } = useLocation();
  const { overview, overviewLoading, overviewError, refresh, filters, permissions, latestAllowedDay, lagDays, startSync, notify, openSyncDialog, jobActive } = useAnalytics();
  const [trendMetric, setTrendMetric] = useState("views");
  const [compareOn, setCompareOn] = useState(true);

  const summary = overview?.summary || null;
  const totals = totalsOf(summary?.current);
  const changes = summary?.changes || {};
  const series = useMemo(() => (Array.isArray(overview?.series) ? overview.series : []), [overview]);
  const previousSeries = Array.isArray(overview?.previousSeries) ? overview.previousSeries : [];
  const previousGap = gap(summary?.previousCoverage);
  const currentGap = gap(summary?.coverage);
  const canCompare = Boolean(summary) && previousGap === 0 && currentGap === 0 && (Number(summary.coverage?.total) || 0) > 0;
  const compareHint = !summary
    ? ""
    : previousGap > 0
      ? t("n/a · previous range has {n} missing days", { n: previousGap })
      : currentGap > 0
        ? t("n/a · this range has {n} missing days", { n: currentGap })
        : "";
  const monetaryCoverage = summary?.monetaryCoverage || null;
  const revenueHint =
    summary?.partialRevenue && monetaryCoverage ? t("Revenue stored for {covered}/{total} days", { covered: monetaryCoverage.monetaryDays ?? 0, total: monetaryCoverage.days ?? 0 }) : "";
  const tiles = KPI_TILES.filter((tile) => !tile.monetary || permissions.canMonetary);
  const availableMetrics = useMemo(() => {
    const keys = new Set();
    for (const row of series) for (const key of Object.keys(row?.metrics || {})) keys.add(key);
    return TREND_METRICS.filter((key) => keys.has(key) && (!MONETARY_METRICS.has(key) || permissions.canMonetary));
  }, [series, permissions.canMonetary]);
  const metric = availableMetrics.includes(trendMetric) ? trendMetric : availableMetrics[0] || "views";
  const metadata = useMemo(() => videoMetadata(overview?.videos), [overview]);
  const multiChannel = filters.channelIds.length > 1;
  const canWrite = permissions.canSync && permissions.connected && !jobActive;
  const syncTitle = !permissions.connected ? t("CMS disconnected") : jobActive ? t("A sync is already running") : undefined;
  const fileStem = `analytics-overview-${filters.ownerId}-${filters.startDate}-${filters.endDate}`;
  const unknownChannels = Array.isArray(overview?.selection?.unknownChannelIds) ? overview.selection.unknownChannelIds.length : 0;
  const notes = Array.isArray(overview?.notes) ? overview.notes.filter((note) => typeof note === "string" && note) : [];
  const syncAction = <SyncAllAction canSync={permissions.canSync} disabled={!permissions.connected || jobActive} title={syncTitle} onClick={() => openSyncDialog()} />;

  async function runDaily() {
    try {
      await startSync({ kind: "daily", ownerId: filters.ownerId });
      notify(t("Daily sync queued"), "success");
    } catch (error) {
      notify(tm(error.message), "error", 6000);
    }
  }

  async function fillMissing() {
    const request = buildFillMissingRequest(filters, permissions, overview?.coverage);
    if (!request) return;
    const pending = new Set(overview.coverage.pending);
    const count = overview.coverage.missing.filter((day) => !pending.has(day)).length;
    try {
      await startSync(request);
      notify(t("Filling {n} missing days…", { n: count }), "success", 5000);
    } catch (error) {
      notify(tm(error.message), "error", 6000);
    }
  }

  function exportTrend() {
    const keys = [...TREND_METRICS.filter((key) => availableMetrics.includes(key)), ...availableMetrics.filter((key) => !TREND_METRICS.includes(key))];
    downloadCsv(
      [{ key: "day", label: t("Day (Pacific time)") }, ...keys.map((key) => ({ key, label: t(metricLabel(key)), value: (row) => numberValue(row.metrics?.[key]) }))],
      series,
      `${fileStem}-daily.csv`
    );
  }

  if (overviewError && !overview) return <ErrorPanel error={overviewError} onRetry={refresh} />;
  if (!overview) {
    return (
      <div className="space-y-5">
        <LoadingPanel rows={2} />
        <LoadingPanel rows={6} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {overviewError && <ErrorPanel error={overviewError} onRetry={refresh} />}
      <DailyRunLine dailyRun={overview.dailyRun} onRunNow={runDaily} canSync={canWrite} />
      <CoverageStrip coverage={overview.coverage} latestAllowedDay={latestAllowedDay} lagDays={lagDays} onFill={fillMissing} canSync={canWrite} loading={overviewLoading} />
      {unknownChannels > 0 && (
        <InlineMessage tone="warning">{t("{count} selected channels are not in this Content Owner's inventory and were ignored", { count: unknownChannels })}</InlineMessage>
      )}
      {notes.length > 0 && (
        <InlineMessage tone="info">
          {notes.map((note) => (
            <span key={note} className="block">
              {tm(note)}
            </span>
          ))}
        </InlineMessage>
      )}
      <div className={cx("grid grid-cols-2 gap-3 md:grid-cols-3", tiles.length > 4 ? "xl:grid-cols-6" : "xl:grid-cols-4", overviewLoading && summary && "opacity-60")} aria-busy={overviewLoading || undefined}>
        {tiles.map((tile) => (
          <KpiTile
            key={tile.key}
            label={t(metricLabel(tile.key))}
            value={formatMetric(totals[tile.key], tile.key, { language, compact: true })}
            change={canCompare ? (changes[tile.key] ?? null) : null}
            hint={canCompare ? (tile.monetary ? revenueHint : "") : compareHint}
            icon={tile.icon}
            tone={tile.monetary ? "amber" : "blue"}
            monetary={tile.monetary}
            loading={overviewLoading && !summary}
          />
        ))}
      </div>
      <Card className="min-w-0">
        <PanelHeader
          title={t("Trend")}
          subtitle={!canCompare && compareHint ? compareHint : undefined}
          actions={
            <>
              <Select
                aria-label={t("Metric")}
                compact
                value={metric}
                onChange={(event) => setTrendMetric(event.target.value)}
                options={availableMetrics.map((key) => ({ value: key, label: t(metricLabel(key)) }))}
                disabled={!availableMetrics.length}
                wrapperClassName="w-52"
              />
              <Toggle size="sm" checked={compareOn && canCompare} disabled={!canCompare} onChange={setCompareOn} label={t("Compare with the previous range")} />
              {series.length > 0 && <ExportIcon label={t("Export CSV")} onClick={exportTrend} />}
            </>
          }
        />
        <div className={cx("mt-4", overviewLoading && "opacity-60")} aria-busy={overviewLoading || undefined}>
          <TrendChart series={series} previousSeries={previousSeries} metric={metric} compare={compareOn && canCompare} />
        </div>
      </Card>
      <TopVideosPanel snapshot={overview.topVideos} metadata={metadata} search={search} filename={`${fileStem}-top-videos.csv`} syncAction={syncAction} loading={overviewLoading} />
      <div className="grid gap-5 lg:grid-cols-2">
        {BREAKDOWN_PANELS.map((panel) => (
          <BreakdownPanel
            key={panel.dimension}
            panel={panel}
            breakdown={overview.breakdowns?.[panel.dimension] || null}
            multiChannel={multiChannel}
            filename={`${fileStem}-${panel.dimension}.csv`}
            syncAction={syncAction}
            loading={overviewLoading}
          />
        ))}
      </div>
    </div>
  );
}
