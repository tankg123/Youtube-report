import { useCallback, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, CalendarCheck, CircleDollarSign, Clock3, Download, ExternalLink, Eye, Film, Globe2, RefreshCw, TvMinimal, Users, UsersRound } from "lucide-react";
import { analyticsApi } from "../../../api/analyticsApi";
import { useI18n } from "../../../context/I18nContext";
import { Badge, Button, CopyButton, EmptyState, IconButton, InlineMessage, Select, Toggle } from "../../assetDelivery/shared";
import { cx } from "../../assetDelivery/utils";
import { useAbortableLoader, useAnalytics } from "../hooks";
import { CoverageStrip, ErrorPanel, KpiTile, LoadingPanel, MetricTable, PanelHeader, StatusBadge } from "../shared";
import { BarList, CoverageCalendar, DonutChart, TrendChart } from "../charts";
import { REPORT_LABELS, dimensionLabel, dimensionValueLabel, downloadCsv, formatMetric, formatScheduleDate, isValidDay, metricLabel, numberValue } from "../analyticsUtils";

// One channel of the Content Owner: public counts from the inventory, the stored daily facts of the range (KPIs,
// trend, coverage calendar) and the range reports of the pinned channel snapshots (top videos, breakdowns), which
// "Sync channel reports" (a channelDetail job) fetches for the current range.

const CHANNEL_ID = /^UC[\w-]{22}$/;
const PREVIEW_ROWS = 20;
const EMPTY = Object.freeze([]);
const KPI_TILES = [
  { key: "views", icon: Eye, tone: "blue" },
  { key: "watchHours", icon: Clock3, tone: "emerald" },
  { key: "netSubscribers", icon: Users, tone: "slate" },
  { key: "estimatedRevenue", icon: CircleDollarSign, tone: "amber", monetary: true },
  { key: "engagedViews", icon: UsersRound, tone: "blue" },
  { key: "rpm", icon: CircleDollarSign, tone: "amber", monetary: true }
];
const TREND_METRICS = ["views", "engagedViews", "watchHours", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "shares", "netSubscribers"];
const TREND_MONETARY_METRICS = ["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "rpm", "cpm", "monetizedPlaybacks"];
const DAY_METRICS = ["views", "engagedViews", "watchHours", "netSubscribers"];
const PUBLIC_COUNTS = ["subscribersTotal", "lifetimeViews", "videoCount"];
// Channel snapshots the channelDetail job stores: the API keys them by dimension (the report id is accepted
// as a fallback); every chart ranks by views.
const BREAKDOWN_PANELS = [
  { dimension: "country", report: "countries", title: REPORT_LABELS.countries, chart: "bars", limit: 8 },
  { dimension: "insightTrafficSourceType", report: "trafficSources", title: REPORT_LABELS.trafficSources, chart: "bars", limit: 8 },
  { dimension: "deviceType", report: "devices", title: REPORT_LABELS.devices, chart: "donut" },
  { dimension: "creatorContentType", report: "contentTypes", title: REPORT_LABELS.contentTypes, chart: "donut" },
  { dimension: "insightPlaybackLocationType", report: "playbackLocations", title: REPORT_LABELS.playbackLocations, chart: "bars", limit: 8 },
  { dimension: "operatingSystem", report: "operatingSystems", title: REPORT_LABELS.operatingSystems, chart: "bars", limit: 8 },
  { dimension: "subscribedStatus", report: "subscribedStatus", title: REPORT_LABELS.subscribedStatus, chart: "donut" },
  { dimension: "youtubeProduct", report: "youtubeProducts", title: REPORT_LABELS.youtubeProducts, chart: "bars", limit: 8 }
];

const toCount = (value) => (Array.isArray(value) ? value.length : Number(value) || 0);
const youtubeUrl = (path) => `https://www.youtube.com/${path}`;
const entryOf = (breakdowns, panel) => breakdowns[panel.dimension] ?? breakdowns[panel.report] ?? null;

// summary.current is summarize().totals (a metric map); a whole summarize() object is accepted too.
function metricsOf(summary) {
  if (!summary || typeof summary !== "object") return null;
  return summary.totals && typeof summary.totals === "object" ? summary.totals : summary;
}

function missingDays(coverage) {
  return Math.max(0, toCount(coverage?.total) - toCount(coverage?.covered));
}

// Snapshot statuses after the API mapping: ready | missing (+ stale, empty, error); the legacy words map the same.
function snapshotState(entry) {
  const status = entry?.status;
  if (status === "ready" || status === "empty") return entry.stale ? "stale" : "ready";
  if (status === "stale") return "stale";
  return "missing";
}

// Panel subtitle of a snapshot: when it was stored and, for a stale one, why the last refresh failed (the error of a
// missing snapshot goes to its empty state instead).
function snapshotSubtitle(entry, { t, tm, language }, base = "") {
  const parts = [base];
  if (entry?.updatedAt) parts.push(t("Updated {instant}", { instant: formatScheduleDate(entry.updatedAt, language) }));
  if (snapshotState(entry) === "stale" && entry?.error) parts.push(tm(String(entry.error)));
  return parts.filter(Boolean).join(" · ");
}

// Warehouse breakdown rows ({ value, metrics }) and raw snapshot rows ({ country, views, … }) both become { value, metrics }.
function breakdownRows(entry, dimension) {
  const rows = Array.isArray(entry?.rows) ? entry.rows : EMPTY;
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const nested = row.metrics && typeof row.metrics === "object";
      const value = nested ? row.value : row[dimension];
      return { value: value === undefined || value === null ? "" : String(value), metrics: nested ? row.metrics : row };
    });
}

function videoMetadata(videos) {
  const list = Array.isArray(videos) ? videos : videos && typeof videos === "object" ? Object.entries(videos).map(([videoId, meta]) => ({ videoId, ...meta })) : EMPTY;
  return new Map(list.filter(Boolean).map((video) => [String(video.videoId || video.id || ""), video]));
}

function Avatar({ thumbnail, size = "md" }) {
  const dims = size === "lg" ? "h-16 w-16" : "h-9 w-9";
  return thumbnail ? (
    <img src={thumbnail} alt="" loading="lazy" className={cx(dims, "shrink-0 rounded-full object-cover")} />
  ) : (
    <span className={cx(dims, "flex shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400")}>
      <TvMinimal size={size === "lg" ? 26 : 15} aria-hidden="true" />
    </span>
  );
}

function VideoCell({ id, meta }) {
  const { t, formatDate } = useI18n();
  return (
    <div className="flex min-w-0 items-center gap-3">
      {meta?.thumbnail ? (
        <img src={meta.thumbnail} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="flex h-9 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
          <Film size={15} aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0">
        <a href={youtubeUrl(`watch?v=${encodeURIComponent(id)}`)} target="_blank" rel="noreferrer" title={t("Open on YouTube")} className="block truncate font-bold text-slate-900 hover:underline">
          {meta?.title || id}
        </a>
        <p className="truncate font-mono text-[11px] text-slate-400">
          {id}
          {meta?.publishedAt ? ` · ${formatDate(meta.publishedAt)}` : ""}
        </p>
      </div>
    </div>
  );
}

// A range-report table (top videos, video revenue) with its snapshot status; long lists open on demand.
function VideoTablePanel({ title, subtitle, report, columns, rows, syncAction }) {
  const i18n = useI18n();
  const { t, tm } = i18n;
  const [expanded, setExpanded] = useState(false);
  const state = snapshotState(report);
  const visible = expanded ? rows : rows.slice(0, PREVIEW_ROWS);
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <PanelHeader title={title} subtitle={snapshotSubtitle(report, i18n, subtitle)} status={state} />
      <div className="mt-4">
        {state === "missing" ? (
          <EmptyState compact icon={Film} title={t("Not synced yet")} description={report?.error ? tm(report.error) : undefined} action={syncAction} />
        ) : (
          <MetricTable
            columns={columns}
            rows={visible}
            rowKey="video"
            footer={
              rows.length > PREVIEW_ROWS ? (
                <div className="flex justify-center pt-3">
                  <Button variant="ghost" size="sm" onClick={() => setExpanded((current) => !current)}>
                    {expanded ? t("Show fewer") : t("Show all ({count})", { count: rows.length })}
                  </Button>
                </div>
              ) : null
            }
          />
        )}
      </div>
    </section>
  );
}

function BreakdownPanel({ panel, entry, channelId, startDate, endDate }) {
  const i18n = useI18n();
  const { t, tm, language } = i18n;
  const rows = useMemo(() => breakdownRows(entry, panel.dimension), [entry, panel.dimension]);
  const state = snapshotState(entry);
  const items = useMemo(
    () =>
      rows
        .map((row) => ({ key: row.value, label: t(dimensionValueLabel(row.value, panel.dimension)), value: numberValue(row.metrics?.views) }))
        .filter((item) => item.value !== null)
        .sort((a, b) => b.value - a.value),
    [rows, panel.dimension, t]
  );
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const format = (value) => formatMetric(value, "views", { language });

  function exportCsv() {
    // Raw snapshot rows carry the dimension itself among their keys; it is already the first column.
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row.metrics || {})))].filter((key) => key !== panel.dimension);
    downloadCsv(
      [
        { key: "label", label: t(dimensionLabel(panel.dimension)), value: (row) => t(dimensionValueLabel(row.value, panel.dimension)) },
        { key: "value", label: t("Value") },
        ...keys.map((key) => ({ key, label: t(metricLabel(key)), value: (row) => numberValue(row.metrics?.[key]) }))
      ],
      rows,
      `analytics-${panel.dimension}-${channelId}-${startDate}-${endDate}.csv`
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <PanelHeader
        title={t(panel.title)}
        subtitle={snapshotSubtitle(entry, i18n) || undefined}
        status={state}
        actions={
          rows.length > 0 ? (
            <span data-readonly-allow="true">
              <IconButton icon={Download} label={t("Export CSV")} size="sm" onClick={exportCsv} />
            </span>
          ) : undefined
        }
      />
      <div className="mt-3">
        {state === "missing" ? (
          <EmptyState compact title={t("Not synced yet")} description={entry?.error ? tm(entry.error) : undefined} />
        ) : panel.chart === "donut" ? (
          <DonutChart segments={items} format={format} />
        ) : (
          <BarList rows={items.slice(0, panel.limit).map((item) => ({ ...item, share: total ? item.value / total : null }))} format={format} />
        )}
      </div>
    </section>
  );
}

function DemographicsPanel({ report, channelId, startDate, endDate }) {
  const i18n = useI18n();
  const { t, tm, language } = i18n;
  const state = snapshotState(report);
  const items = useMemo(
    () =>
      (Array.isArray(report?.rows) ? report.rows : EMPTY)
        .filter((row) => row && typeof row === "object")
        .map((row) => ({
          key: `${row.ageGroup}:${row.gender}`,
          ageGroup: row.ageGroup,
          gender: row.gender,
          label: `${t(dimensionValueLabel(row.ageGroup, "ageGroup"))} · ${t(dimensionValueLabel(row.gender, "gender"))}`,
          value: numberValue(row.viewerPercentage)
        }))
        .filter((item) => item.value !== null)
        .sort((a, b) => b.value - a.value),
    [report, t]
  );

  function exportCsv() {
    downloadCsv(
      [
        { key: "ageGroup", label: t(dimensionLabel("ageGroup")), value: (row) => dimensionValueLabel(row.ageGroup, "ageGroup") },
        { key: "gender", label: t(dimensionLabel("gender")), value: (row) => t(dimensionValueLabel(row.gender, "gender")) },
        { key: "value", label: t(metricLabel("viewerPercentage")) }
      ],
      items,
      `analytics-demographics-${channelId}-${startDate}-${endDate}.csv`
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <PanelHeader
        title={t(REPORT_LABELS.demographics)}
        subtitle={snapshotSubtitle(report, i18n) || undefined}
        status={state}
        actions={
          items.length > 0 ? (
            <span data-readonly-allow="true">
              <IconButton icon={Download} label={t("Export CSV")} size="sm" onClick={exportCsv} />
            </span>
          ) : undefined
        }
      />
      <div className="mt-3">
        {state === "missing" ? (
          <EmptyState compact title={t("Not synced yet")} description={report?.error ? tm(report.error) : undefined} />
        ) : (
          <BarList rows={items.slice(0, 12)} format={(value) => formatMetric(value, "viewerPercentage", { language })} max={100} />
        )}
      </div>
    </section>
  );
}

// The stored numbers of the day picked in the calendar (null metrics on a covered day = no activity reported).
function DayReadout({ day, series, coverageDay, canMonetary }) {
  const { t, language, formatDate } = useI18n();
  if (!day) return <p className="mt-3 text-xs text-slate-400">{t("Select a day in the calendar to see its stored numbers.")}</p>;
  const row = (Array.isArray(series) ? series : EMPTY).find((entry) => entry?.day === day) || null;
  const metrics = row?.metrics || null;
  const keys = canMonetary ? [...DAY_METRICS, "estimatedRevenue"] : DAY_METRICS;
  const covered = Boolean(row?.covered || coverageDay?.facts);
  return (
    <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm">
      <p className="font-black text-slate-800">{formatDate(day)}</p>
      {metrics ? (
        <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
          {keys.map((key) => (
            <div key={key} className="flex items-baseline gap-1.5">
              <dt className="text-xs font-bold text-slate-400">{t(metricLabel(key))}</dt>
              <dd className="font-black tabular-nums text-slate-900">{formatMetric(metrics[key], key, { language })}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 text-slate-500">{covered ? t("No activity reported on this day") : coverageDay?.pending ? t("Not yet published") : t("Not stored")}</p>
      )}
    </div>
  );
}

export default function ChannelDetailView() {
  const { t, tm, language, formatDate, regionName } = useI18n();
  const location = useLocation();
  const { channelId = "" } = useParams();
  const { filters, permissions, latestAllowedDay, lagDays, refreshKey, startSync, syncing, jobActive, notify } = useAnalytics();
  const { ownerId, startDate, endDate } = filters;
  const { canMonetary, canSync, connected } = permissions;
  const validId = CHANNEL_ID.test(channelId);
  const enabled = validId && Boolean(ownerId) && isValidDay(startDate) && isValidDay(endDate);

  const detailLoader = useCallback((signal) => analyticsApi.channel(channelId, { ownerId, startDate, endDate }, signal), [channelId, ownerId, startDate, endDate]);
  const detail = useAbortableLoader(detailLoader, { enabled, version: refreshKey });
  const coverageLoader = useCallback((signal) => analyticsApi.coverage({ ownerId, startDate, endDate, channelId }, signal), [channelId, ownerId, startDate, endDate]);
  const coverageState = useAbortableLoader(coverageLoader, { enabled, version: refreshKey });

  const [metric, setMetric] = useState("views");
  const [compare, setCompare] = useState(true);
  const [selected, setSelected] = useState({ key: "", day: null });
  const [syncError, setSyncError] = useState("");
  const rangeKey = `${channelId}|${startDate}|${endDate}`;
  const selectedDay = selected.key === rangeKey ? selected.day : null;

  const data = detail.data;
  const channel = data?.channel || null;
  const summary = data?.summary || null;
  const current = metricsOf(summary?.current) || {};
  const changes = summary?.changes || {};
  const coverageKnown = Boolean(summary?.coverage && summary?.previousCoverage);
  const currentMissing = missingDays(summary?.coverage);
  const previousMissing = missingDays(summary?.previousCoverage);
  const complete = coverageKnown && currentMissing === 0 && previousMissing === 0;
  const compareHint = !coverageKnown
    ? ""
    : previousMissing > 0
      ? t("n/a · previous range has {n} missing days", { n: previousMissing })
      : currentMissing > 0
        ? t("n/a · this range has {n} missing days", { n: currentMissing })
        : "";
  const coveredDays = toCount(channel?.coveredDays);
  const daysWithRows = toCount(channel?.daysWithRows);
  const coverage = coverageState.data || data?.coverage || null;
  const coverageDays = Array.isArray(coverage?.days) ? coverage.days : EMPTY;
  const coverageDay = selectedDay ? coverageDays.find((entry) => entry?.day === selectedDay) || null : null;
  const breakdowns = data?.breakdowns || {};
  const videos = useMemo(() => videoMetadata(data?.videos), [data]);

  const kpis = useMemo(() => KPI_TILES.filter((tile) => !tile.monetary || canMonetary), [canMonetary]);
  const metricOptions = useMemo(
    () => [...TREND_METRICS, ...(canMonetary ? TREND_MONETARY_METRICS : EMPTY)].map((key) => ({ value: key, label: t(metricLabel(key)) })),
    [canMonetary, t]
  );
  const activeMetric = metricOptions.some((option) => option.value === metric) ? metric : "views";

  const revenueById = useMemo(() => {
    const rows = Array.isArray(data?.videoRevenue?.rows) ? data.videoRevenue.rows : EMPTY;
    return new Map(rows.map((row) => [String(row.video), row]));
  }, [data]);
  const topVideoRows = useMemo(
    () =>
      (Array.isArray(data?.topVideos?.rows) ? data.topVideos.rows : EMPTY)
        .filter((row) => row && row.video)
        .map((row) => ({ ...row, meta: videos.get(String(row.video)), estimatedRevenue: numberValue(revenueById.get(String(row.video))?.estimatedRevenue) })),
    [data, videos, revenueById]
  );
  const revenueRows = useMemo(
    () =>
      (Array.isArray(data?.videoRevenue?.rows) ? data.videoRevenue.rows : EMPTY)
        .filter((row) => row && row.video)
        .map((row) => {
          const revenue = numberValue(row.estimatedRevenue);
          const views = numberValue(row.views);
          return { ...row, meta: videos.get(String(row.video)), rpm: revenue === null || !views ? null : (revenue * 1000) / views };
        }),
    [data, videos]
  );

  const videoColumns = useMemo(() => {
    const metricCell = (key) => (value) => formatMetric(value, key, { language });
    return [
      { key: "video", label: t("Video"), width: 320, format: (value, row) => <VideoCell id={String(value)} meta={row.meta} /> },
      { key: "views", label: t("Views"), align: "right", format: metricCell("views") },
      { key: "estimatedMinutesWatched", label: t("Watch hours"), align: "right", format: (value) => formatMetric(numberValue(value) === null ? null : Number(value) / 60, "watchHours", { language }) },
      { key: "averageViewDuration", label: t("Average view duration"), align: "right", format: metricCell("averageViewDuration") },
      { key: "likes", label: t("Likes"), align: "right", format: metricCell("likes") },
      { key: "comments", label: t("Comments"), align: "right", format: metricCell("comments") },
      ...(canMonetary ? [{ key: "estimatedRevenue", label: t("Estimated revenue"), align: "right", format: metricCell("estimatedRevenue") }] : EMPTY)
    ];
  }, [t, language, canMonetary]);
  const revenueColumns = useMemo(() => {
    const metricCell = (key) => (value) => formatMetric(value, key, { language });
    return [
      { key: "video", label: t("Video"), width: 320, format: (value, row) => <VideoCell id={String(value)} meta={row.meta} /> },
      { key: "views", label: t("Views"), align: "right", format: metricCell("views") },
      { key: "estimatedRevenue", label: t("Estimated revenue"), align: "right", format: metricCell("estimatedRevenue") },
      { key: "estimatedAdRevenue", label: t("Ad revenue"), align: "right", format: metricCell("estimatedAdRevenue") },
      { key: "estimatedRedPartnerRevenue", label: t("YouTube Premium revenue"), align: "right", format: metricCell("estimatedRedPartnerRevenue") },
      { key: "rpm", label: t("RPM"), align: "right", format: metricCell("rpm") }
    ];
  }, [t, language]);

  const handleSync = useCallback(async () => {
    setSyncError("");
    try {
      const response = await startSync({ kind: "channelDetail", ownerId, channelId, startDate, endDate, monetary: canMonetary });
      notify(response?.deduplicated ? t("This channel sync is already queued") : t("Channel reports sync queued"), "success");
    } catch (failure) {
      setSyncError(failure?.message || "");
    }
  }, [startSync, ownerId, channelId, startDate, endDate, canMonetary, notify, t]);

  const syncAction = canSync ? (
    <Button
      icon={RefreshCw}
      loading={syncing}
      disabled={!connected || jobActive}
      title={!connected ? t("CMS disconnected") : jobActive ? t("A sync is already running") : undefined}
      onClick={handleSync}
    >
      {t("Sync channel reports")}
    </Button>
  ) : null;
  const backLink = (
    <Link to={{ pathname: "/analytic/channels", search: location.search }} className="inline-flex items-center gap-1.5 text-sm font-black text-blue-700 hover:underline">
      <ArrowLeft size={15} aria-hidden="true" />
      {t("Back to channels")}
    </Link>
  );

  if (!validId) {
    return (
      <div className="space-y-5">
        {backLink}
        <InlineMessage tone="error" title={t("Invalid channel ID")}>
          {t("A YouTube channel ID starts with UC and has 24 characters.")}
        </InlineMessage>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-5">
        {backLink}
        {detail.error ? <ErrorPanel error={detail.error} onRetry={detail.reload} /> : enabled && <LoadingPanel rows={6} />}
      </div>
    );
  }

  const title = channel?.title || channelId;
  const firstDay = isValidDay(channel?.firstDay) ? channel.firstDay : null;
  const serverNotes = Array.isArray(data.notes) ? data.notes.filter((note) => typeof note === "string" && note) : EMPTY;
  const anyReport =
    BREAKDOWN_PANELS.some((panel) => snapshotState(entryOf(breakdowns, panel)) !== "missing") ||
    snapshotState(data.topVideos) !== "missing" ||
    snapshotState(data.demographics) !== "missing" ||
    (canMonetary && snapshotState(data.videoRevenue) !== "missing");

  return (
    <div className="space-y-5">
      {backLink}

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <Avatar thumbnail={channel?.thumbnail} size="lg" />
            <div className="min-w-0">
              <p className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-black uppercase text-blue-700">
                <TvMinimal size={14} aria-hidden="true" />
                {t("Channel")}
              </p>
              <h1 className="mt-3 flex flex-wrap items-center gap-2 text-3xl font-black text-slate-950">
                <span className="min-w-0 truncate">{title}</span>
                <StatusBadge status={channel?.status || "missing"} />
                {channel?.removedAt && <Badge tone="slate">{t("No longer managed")}</Badge>}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                <span className="inline-flex items-center gap-1 font-mono text-xs">
                  {channelId}
                  <CopyButton iconOnly text={channelId} />
                </span>
                {channel?.country && (
                  <span className="inline-flex items-center gap-1">
                    <Globe2 size={14} aria-hidden="true" />
                    {regionName(channel.country, channel.country)}
                  </span>
                )}
                {channel?.publishedAt && (
                  <span>
                    {t("Joined")}: {formatDate(channel.publishedAt)}
                  </span>
                )}
                <a href={youtubeUrl(`channel/${encodeURIComponent(channelId)}`)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-bold text-blue-700 hover:underline">
                  <ExternalLink size={14} aria-hidden="true" />
                  {t("Open on YouTube")}
                </a>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-3 lg:items-end">
            <dl className="grid grid-cols-3 gap-3">
              {PUBLIC_COUNTS.map((key) => (
                <div key={key} className="rounded-2xl bg-slate-50 px-3 py-2 text-center">
                  <dt className="text-[11px] font-black uppercase tracking-wide text-slate-400">{t(metricLabel(key))}</dt>
                  <dd className="text-lg font-black tabular-nums text-slate-900">{formatMetric(channel?.[key], key, { language })}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              {syncAction}
            </div>
          </div>
        </div>
      </section>

      {syncError && <InlineMessage tone="error">{tm(syncError)}</InlineMessage>}
      {firstDay && firstDay > startDate && (
        <InlineMessage tone="info">{t("No data before {date} — the channel may not have been linked to the Content Owner yet.", { date: formatDate(firstDay) })}</InlineMessage>
      )}
      {coveredDays > 0 && daysWithRows === 0 && (
        <InlineMessage tone="neutral">{t("YouTube reported no activity for this channel on the {count} stored days of this range.", { count: coveredDays })}</InlineMessage>
      )}
      {serverNotes.length > 0 && (
        <InlineMessage tone="neutral">
          {serverNotes.map((note) => (
            <p key={note}>{tm(note)}</p>
          ))}
        </InlineMessage>
      )}

      {coveredDays === 0 ? (
        <EmptyState
          icon={CalendarCheck}
          title={t("No stored days for this channel in this range")}
          description={t("Sync channel reports stores the channel's daily numbers and refreshes its range reports for the selected dates.")}
          action={syncAction}
        />
      ) : (
        <>
          <div className={cx("grid grid-cols-2 gap-4 md:grid-cols-3", kpis.length > 4 ? "xl:grid-cols-6" : "xl:grid-cols-4")}>
            {kpis.map((tile) => (
              <KpiTile
                key={tile.key}
                label={t(metricLabel(tile.key))}
                value={formatMetric(current[tile.key], tile.key, { language })}
                change={complete ? (changes[tile.key] ?? null) : null}
                hint={complete ? undefined : compareHint || undefined}
                tone={tile.tone}
                icon={tile.icon}
                monetary={Boolean(tile.monetary)}
                loading={detail.loading && !summary}
              />
            ))}
          </div>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <PanelHeader
              title={t("Trend")}
              subtitle={t("Daily values of one metric; a gap is a day that is not stored.")}
              actions={
                <>
                  <Select compact size="sm" aria-label={t("Metric")} value={activeMetric} onChange={(event) => setMetric(event.target.value)} options={metricOptions} wrapperClassName="w-52" />
                  <Toggle size="sm" checked={compare && complete} disabled={!complete} onChange={setCompare} label={t("Compare with the previous range")} description={complete ? undefined : compareHint || undefined} />
                </>
              }
            />
            <div className="mt-4">
              <TrendChart series={data.series} previousSeries={data.previousSeries} metric={activeMetric} compare={compare && complete} title={t(metricLabel(activeMetric))} />
            </div>
          </section>
        </>
      )}

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <PanelHeader title={t("Coverage")} subtitle={t("Days of this range stored for the channel; pick a day to read its numbers.")} />
        <div className="mt-4 space-y-4">
          {coverage && <CoverageStrip coverage={coverage} latestAllowedDay={latestAllowedDay} lagDays={lagDays} loading={coverageState.loading} />}
          {coverageState.error && !coverageDays.length ? (
            <ErrorPanel error={coverageState.error} onRetry={coverageState.reload} />
          ) : coverageState.loading && !coverageDays.length ? (
            <LoadingPanel rows={3} />
          ) : (
            <CoverageCalendar days={coverageDays} startDate={startDate} endDate={endDate} selectedDay={selectedDay} showMonetary={canMonetary} onSelectDay={(day) => setSelected({ key: rangeKey, day })} />
          )}
          <DayReadout day={selectedDay} series={data.series} coverageDay={coverageDay} canMonetary={canMonetary} />
        </div>
      </section>

      {anyReport ? (
        <>
          <VideoTablePanel
            title={t(REPORT_LABELS.videos)}
            subtitle={t("Up to 200 videos of this channel ranked by views in the range.")}
            report={data.topVideos}
            columns={videoColumns}
            rows={topVideoRows}
            syncAction={syncAction}
          />
          {canMonetary && (
            <VideoTablePanel
              title={t(REPORT_LABELS.videoRevenue)}
              subtitle={t("Up to 200 videos ranked by estimated revenue (USD).")}
              report={data.videoRevenue}
              columns={revenueColumns}
              rows={revenueRows}
              syncAction={syncAction}
            />
          )}
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {BREAKDOWN_PANELS.map((panel) => (
              <BreakdownPanel key={panel.dimension} panel={panel} entry={entryOf(breakdowns, panel)} channelId={channelId} startDate={startDate} endDate={endDate} />
            ))}
            <DemographicsPanel report={data.demographics} channelId={channelId} startDate={startDate} endDate={endDate} />
          </div>
        </>
      ) : (
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <PanelHeader title={t("Range reports")} />
          <div className="mt-4">
            <EmptyState
              compact
              icon={Film}
              title={t("Channel reports have not been synced for this range")}
              description={t("Top videos, countries, traffic sources, devices and the other reports of this channel are stored per range when you sync its reports.")}
              action={syncAction}
            />
          </div>
        </section>
      )}
    </div>
  );
}
