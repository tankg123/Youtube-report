import { useSystemSettings } from "../../../context/SystemSettingsContext";
import { useCallback, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { CircleDollarSign, Crown, Eye, Gauge, Info, Megaphone, Play, Tv } from "lucide-react";
import { analyticsApi } from "../../../api/analyticsApi";
import { useI18n } from "../../../context/I18nContext";
import { Badge, InlineMessage, Select, TextInput, Toggle } from "../../assetDelivery/shared";
import { cx } from "../../assetDelivery/utils";
import { TrendChart } from "../charts";
import { useAbortableLoader, useAnalytics } from "../hooks";
import { ErrorPanel, KpiTile, LoadingPanel, StatusBadge } from "../shared";
import { METRIC_KINDS, REPORT_DESCRIPTIONS, REPORT_LABELS, foldText, formatMetric, metricLabel, numberValue } from "../analyticsUtils";
import { BreakdownPanel, DataTable, PanelExportMenu, ReportPanel, ViewPlaceholder } from "./ContentView";

// Revenue view (monetary roles only; the shell redirects everyone else): revenue KPIs against the previous range, the
// daily revenue trend, revenue per channel from GET /channels, and the revenue breakdowns by country, content type
// and ad type. Every figure is a USD estimate that YouTube keeps revising for about 45 days.

const REVENUE_KPIS = [
  { key: "estimatedRevenue", icon: CircleDollarSign, tone: "emerald" },
  { key: "estimatedAdRevenue", icon: Megaphone, tone: "blue" },
  { key: "estimatedRedPartnerRevenue", icon: Crown, tone: "amber" },
  { key: "rpm", icon: Gauge, tone: "slate" },
  { key: "cpm", icon: Gauge, tone: "slate" },
  { key: "playbackBasedCpm", icon: Gauge, tone: "slate" },
  { key: "monetizedPlaybacks", icon: Play, tone: "slate" },
  { key: "adImpressions", icon: Eye, tone: "slate" }
];
const TREND_METRICS = ["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "grossRevenue", "rpm", "cpm", "playbackBasedCpm", "monetizedPlaybacks", "adImpressions"];
const CHANNEL_METRICS = ["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "views", "rpm"];
const REVENUE_METRICS = ["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue", "views", "rpm", "monetizedPlaybacks", "cpm"];
const AD_TYPE_METRICS = ["grossRevenue", "adImpressions", "cpm"];
// GET /channels pages at most 200 rows; five pages keep even a large CMS in one table.
const CHANNEL_PAGE_SIZE = 200;
const CHANNEL_MAX_PAGES = 5;

const isRow = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const missingDays = (coverage) => (coverage && Number.isFinite(Number(coverage.total)) ? Math.max(0, Number(coverage.total) - (Number(coverage.covered) || 0)) : 0);

// Channel rows of GET /channels flattened for the table; RPM is derived when the server did not store it.
function channelRow(row) {
  const metrics = {};
  for (const [key, value] of Object.entries(isRow(row.metrics) ? row.metrics : {})) {
    const number = numberValue(value);
    if (number !== null) metrics[key] = number;
  }
  if (metrics.rpm === undefined && metrics.estimatedRevenue !== undefined && metrics.views > 0) metrics.rpm = (metrics.estimatedRevenue * 1000) / metrics.views;
  return {
    id: String(row.channelId || ""),
    title: row.title || String(row.channelId || ""),
    thumbnail: row.thumbnail || "",
    removed: Boolean(row.removedAt),
    monetaryStatus: row.monetaryStatus || "missing",
    monetaryDays: Number(row.monetaryDays) || 0,
    totalDays: Number(row.totalDays) || 0,
    haystack: foldText(`${row.title || ""} ${row.channelId || ""}`),
    ...metrics
  };
}

function ChannelCell({ row }) {
  const { isSidebarVisible } = useSystemSettings();
  const { t } = useI18n();
  const location = useLocation();
  return (
    <div className="flex min-w-[14rem] items-center gap-3">
      {row.thumbnail ? (
        <img src={row.thumbnail} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <Tv size={14} aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0">
        {isSidebarVisible("/analytic/channels#detail") ? <Link to={{ pathname: `/analytic/channels/${encodeURIComponent(row.id)}`, search: location.search }} className="block truncate font-bold text-slate-800 hover:text-blue-700 hover:underline">
          {row.title}
        </Link> : <span className="block truncate font-bold">{row.title}</span>}
        <span className="flex items-center gap-2 text-[11px] text-slate-400">
          <span className="truncate font-mono">{row.id}</span>
          {row.removed && <Badge tone="slate">{t("No longer managed")}</Badge>}
        </span>
      </span>
    </div>
  );
}

// Revenue per channel for the current filters: every page of GET /channels is loaded, then searched, sorted and
// paged client-side so the table and its CSV cover the whole inventory.
function ChannelRevenuePanel() {
  const { t, language } = useI18n();
  const { filters, refreshKey } = useAnalytics();
  const { ownerId, startDate, endDate } = filters;
  const channelsCsv = filters.channelIds.join(",");
  const loader = useCallback(
    async (signal) => {
      const rows = [];
      let total;
      let page = 1;
      do {
        const data = await analyticsApi.channels({ ownerId, startDate, endDate, channelIds: channelsCsv, page, pageSize: CHANNEL_PAGE_SIZE }, signal);
        const batch = Array.isArray(data?.rows) ? data.rows : [];
        rows.push(...batch);
        total = Number(data?.total) || rows.length;
        page += 1;
        if (!batch.length) break;
      } while (rows.length < total && page <= CHANNEL_MAX_PAGES);
      return { rows, total };
    },
    [ownerId, startDate, endDate, channelsCsv]
  );
  const { data, loading, error, reload } = useAbortableLoader(loader, { enabled: Boolean(ownerId), version: refreshKey });
  const [search, setSearch] = useState("");
  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []).filter(isRow).map(channelRow), [data]);
  const needle = foldText(search);
  const filtered = useMemo(() => (needle ? rows.filter((row) => row.haystack.includes(needle)) : rows), [rows, needle]);
  const keys = CHANNEL_METRICS.filter((key) => rows.some((row) => row[key] !== undefined));
  const withRevenue = rows.filter((row) => row.estimatedRevenue !== undefined).length;
  const details = [];
  if (rows.length) details.push(t("{count} of {total} channels have revenue stored in this range", { count: withRevenue, total: rows.length }));
  if (data && data.total > rows.length) details.push(t("Showing the first {count} of {total} channels", { count: rows.length, total: data.total }));
  const columns = [
    { key: "title", label: t("Channel"), sortable: true, format: (value, row) => <ChannelCell row={row} /> },
    ...keys.map((key) => ({ key, label: t(metricLabel(key)), align: "right", sortable: true, format: (value) => formatMetric(value, key, { language }) })),
    {
      key: "monetaryDays",
      label: t("Revenue days"),
      align: "right",
      sortable: true,
      format: (value, row) => (
        <span className="inline-flex items-center justify-end gap-2">
          <StatusBadge status={row.monetaryStatus} />
          {`${value}/${row.totalDays}`}
        </span>
      )
    }
  ];
  const csv = {
    columns: [
      { key: "id", label: t("Channel ID") },
      { key: "title", label: t("Channel") },
      ...keys.map((key) => ({ key, label: t(metricLabel(key)) })),
      { key: "monetaryDays", label: t("Revenue days") },
      { key: "totalDays", label: t("Days in range") },
      { key: "monetaryStatus", label: t("Status") }
    ],
    rows: filtered,
    filename: `analytics-revenue-channels-${ownerId}-${startDate}-${endDate}.csv`
  };

  let body;
  if (error && !data) body = <ErrorPanel error={error} onRetry={reload} />;
  else if (!data) body = <LoadingPanel rows={5} />;
  else
    body = (
      <div className={cx("space-y-3", loading && "opacity-60")} aria-busy={loading || undefined}>
        {error && <ErrorPanel error={error} onRetry={reload} />}
        <DataTable columns={columns} rows={filtered} initialSort={{ key: "estimatedRevenue", direction: "desc" }} />
      </div>
    );

  return (
    <ReportPanel
      title={t(REPORT_LABELS.channelRevenue)}
      subtitle={[t(REPORT_DESCRIPTIONS.channelRevenue), ...details].join(" · ")}
      actions={
        <>
          <TextInput
            compact
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search channels")}
            aria-label={t("Search channels")}
            className="w-56"
          />
          <PanelExportMenu csv={filtered.length ? csv : null} />
        </>
      }
    >
      {body}
    </ReportPanel>
  );
}

// Daily revenue trend with a metric switcher and the previous range as a dashed series only when BOTH ranges are
// complete (the same `comparable` rule as the KPI tiles; a gapped current line against a full previous one misleads).
function TrendPanel({ overview }) {
  const { t } = useI18n();
  const { filters } = useAnalytics();
  const [metric, setMetric] = useState(TREND_METRICS[0]);
  const [compare, setCompare] = useState(false);
  const series = Array.isArray(overview.series) ? overview.series : [];
  const previous = Array.isArray(overview.previousSeries) ? overview.previousSeries : [];
  const missingCurrent = missingDays(overview.summary?.coverage);
  const missingPrevious = missingDays(overview.summary?.previousCoverage);
  const canCompare = previous.length > 0 && missingCurrent === 0 && missingPrevious === 0;
  const comparing = compare && canCompare;
  const compareHint = canCompare
    ? ""
    : missingPrevious > 0
      ? t("n/a · previous range has {n} missing days", { n: missingPrevious })
      : missingCurrent > 0
        ? t("n/a · this range has {n} missing days", { n: missingCurrent })
        : t("No previous range to compare");
  const csv = {
    columns: [
      { key: "day", label: t("Day (Pacific time)") },
      { key: "value", label: t(metricLabel(metric)) },
      ...(comparing ? [{ key: "previousDay", label: t("Previous range") }, { key: "previous", label: `${t(metricLabel(metric))} (${t("Previous range")})` }] : [])
    ],
    rows: series.map((row, index) => ({
      day: row?.day || "",
      value: row?.metrics?.[metric] ?? null,
      previousDay: previous[index]?.day || "",
      previous: previous[index]?.metrics?.[metric] ?? null
    })),
    filename: `analytics-revenue-daily-${filters.ownerId}-${filters.startDate}-${filters.endDate}.csv`
  };
  return (
    <ReportPanel
      title={t("Revenue trend")}
      subtitle={t(REPORT_DESCRIPTIONS.monetaryDaily)}
      actions={
        <>
          <Select
            compact
            aria-label={t("Metric")}
            value={metric}
            onChange={(event) => setMetric(event.target.value)}
            options={TREND_METRICS.map((key) => ({ value: key, label: t(metricLabel(key)) }))}
            wrapperClassName="w-52"
          />
          <Toggle size="sm" checked={comparing} disabled={!canCompare} onChange={setCompare} label={t("Compare with the previous range")} description={compareHint} />
          <PanelExportMenu csv={series.length ? csv : null} />
        </>
      }
    >
      <TrendChart series={series} previousSeries={previous} metric={metric} kind="area" compare={comparing} title={t(metricLabel(metric))} />
    </ReportPanel>
  );
}

export default function RevenueView() {
  const { t, language } = useI18n();
  const { overview, overviewLoading, overviewError, refresh, filters, permissions } = useAnalytics();
  if (!permissions.canMonetary) return null;
  if (!overview) return <ViewPlaceholder loading={overviewLoading} error={overviewError} onRetry={refresh} ownerId={filters.ownerId} />;

  const summary = overview.summary || {};
  const current = summary.current || {};
  const missingCurrent = missingDays(summary.coverage);
  const missingPrevious = missingDays(summary.previousCoverage);
  const comparable = Boolean(summary.previous) && missingCurrent === 0 && missingPrevious === 0;
  const comparisonHint = comparable
    ? ""
    : missingPrevious > 0
      ? t("n/a · previous range has {n} missing days", { n: missingPrevious })
      : missingCurrent > 0
        ? t("n/a · this range has {n} missing days", { n: missingCurrent })
        : "";
  const revenueHint =
    summary.partialRevenue && summary.monetaryCoverage
      ? t("Revenue stored for {covered}/{total} days", { covered: summary.monetaryCoverage.monetaryDays ?? 0, total: summary.monetaryCoverage.days ?? 0 })
      : "";
  const hint = [comparisonHint, revenueHint].filter(Boolean).join(" · ");
  const breakdowns = overview.breakdowns || {};

  return (
    <div className={cx("space-y-5", overviewLoading && "opacity-60")} aria-busy={overviewLoading || undefined}>
      {overviewError && <ErrorPanel error={overviewError} onRetry={refresh} />}
      <InlineMessage tone="info" icon={Info}>
        {t("Estimates in USD. YouTube keeps revising revenue for about 45 days after each day; the daily sync records those revisions as drift.")}
      </InlineMessage>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {REVENUE_KPIS.map(({ key, icon, tone }) => (
          <KpiTile
            key={key}
            label={t(metricLabel(key))}
            value={formatMetric(current[key], key, { language })}
            change={comparable ? (summary.changes?.[key] ?? null) : null}
            hint={hint}
            icon={icon}
            tone={tone}
            monetary={METRIC_KINDS[key] === "money" || METRIC_KINDS[key] === "cpm"}
          />
        ))}
      </div>
      <TrendPanel overview={overview} />
      <ChannelRevenuePanel />
      <div className="grid gap-5 xl:grid-cols-2">
        <BreakdownPanel
          dimension="country"
          title={t(REPORT_LABELS.countryRevenue)}
          subtitle={t(REPORT_DESCRIPTIONS.countryRevenue)}
          breakdown={breakdowns.country}
          metrics={REVENUE_METRICS}
        />
        <BreakdownPanel
          dimension="creatorContentType"
          title={t(REPORT_LABELS.contentTypes)}
          subtitle={t(REPORT_DESCRIPTIONS.contentTypes)}
          breakdown={breakdowns.creatorContentType}
          metrics={REVENUE_METRICS}
        />
        <BreakdownPanel
          dimension="adType"
          title={t(REPORT_LABELS.adTypes)}
          subtitle={t(REPORT_DESCRIPTIONS.adTypes)}
          breakdown={breakdowns.adType}
          metrics={AD_TYPE_METRICS}
        />
      </div>
    </div>
  );
}
