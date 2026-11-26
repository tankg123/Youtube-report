import { useSystemSettings } from "../../../context/SystemSettingsContext";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CalendarCheck, CircleDollarSign, Clock3, Eye, RefreshCw, Search, TvMinimal, X } from "lucide-react";
import PaginationFooter from "../../../components/PaginationFooter";
import { analyticsApi } from "../../../api/analyticsApi";
import { useI18n } from "../../../context/I18nContext";
import { Badge, Button, EmptyState, InlineMessage, Select, TextInput } from "../../assetDelivery/shared";
import { useDebouncedValue } from "../../assetDelivery/hooks";
import { cx } from "../../assetDelivery/utils";
import { useAbortableLoader, useAnalytics } from "../hooks";
import { ErrorPanel, KpiTile, MetricTable, PanelHeader, StatusBadge } from "../shared";
import { STATUS_META, formatMetric, formatScheduleDate, isValidDay, numberValue } from "../analyticsUtils";

// Channels of the Content Owner over the current range: GET /channels does the searching, filtering, sorting and
// paging (the inventory can exceed one page), so every control here is a request parameter. A row click opens
// /analytic/channels/:channelId with the filter search string kept.

const PAGE_SIZE = 20;
const SEARCH_LIMIT = 200;
const CHANNEL_STATUSES = ["ready", "partial", "missing"];
const EMPTY = Object.freeze([]);

// GET /channels sorts through a fixed key map; the direction travels as the "-" prefix of the catalog convention.
const sortParam = ({ key, direction }) => (direction === "asc" ? key : `-${key}`);
const toCount = (value) => (Array.isArray(value) ? value.length : Number(value) || 0);
const integer = (value, formatNumber) => (numberValue(value) === null ? "—" : formatNumber(value, { maximumFractionDigits: 0 }));

// Rows and totals carry the warehouse metric map; the derived keys are recomputed when a reader left them out.
function withDerived(metrics) {
  if (!metrics || typeof metrics !== "object") return null;
  const minutes = numberValue(metrics.estimatedMinutesWatched);
  const gained = numberValue(metrics.subscribersGained);
  const lost = numberValue(metrics.subscribersLost);
  const revenue = numberValue(metrics.estimatedRevenue);
  const views = numberValue(metrics.views);
  return {
    ...metrics,
    watchHours: numberValue(metrics.watchHours) ?? (minutes === null ? null : minutes / 60),
    netSubscribers: numberValue(metrics.netSubscribers) ?? (gained === null || lost === null ? null : gained - lost),
    rpm: numberValue(metrics.rpm) ?? (revenue === null || !views ? null : (revenue * 1000) / views)
  };
}

// `totals` is summarize() of the summed series ({ totals, coverage, … }); a bare metric map is accepted too.
function metricsOf(summary) {
  if (!summary || typeof summary !== "object") return null;
  return summary.totals && typeof summary.totals === "object" ? summary.totals : summary;
}

function ChannelCell({ row }) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 items-center gap-3">
      {row.thumbnail ? (
        <img src={row.thumbnail} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <TvMinimal size={15} aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2">
          <span className="truncate font-bold text-slate-900">{row.title || row.channelId}</span>
          {row.removedAt && <Badge tone="slate">{t("No longer managed")}</Badge>}
        </p>
        <p className="truncate font-mono text-[11px] text-slate-400">{row.channelId}</p>
      </div>
    </div>
  );
}

function CoverageCell({ covered, total }) {
  const { t } = useI18n();
  const safeTotal = Math.max(0, toCount(total));
  const safeCovered = Math.min(safeTotal, Math.max(0, toCount(covered)));
  const percent = safeTotal ? Math.round((safeCovered / safeTotal) * 100) : 0;
  const text = t("{covered}/{total} days stored", { covered: safeCovered, total: safeTotal });
  return (
    <div className="flex items-center justify-end gap-2" title={text}>
      <span className="tabular-nums">
        {safeCovered}/{safeTotal}
      </span>
      <span role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={text} className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-slate-100">
        <span className={cx("block h-full rounded-full", percent === 100 ? "bg-emerald-600" : "bg-blue-600")} style={{ width: `${percent}%` }} />
      </span>
    </div>
  );
}

export default function ChannelsView() {
  const { isSidebarVisible } = useSystemSettings();
  const { t, tm, language, formatNumber, regionName } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const { filters, setFilters, permissions, inventory, overview, refreshKey, openSyncDialog, jobActive } = useAnalytics();
  const { ownerId, startDate, endDate } = filters;
  const channelsCsv = filters.channelIds.join(",");
  const { canMonetary, canSync, connected } = permissions;

  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim().slice(0, SEARCH_LIMIT), 300);
  const [country, setCountry] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState({ key: "views", direction: "desc" });
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [pageState, setPageState] = useState({ key: "", page: 1 });
  // The page restarts at 1 whenever any other request parameter changes, without an effect.
  const listKey = [ownerId, startDate, endDate, channelsCsv, query, country, status, sort.key, sort.direction, pageSize].join("|");
  const page = pageState.key === listKey ? pageState.page : 1;
  const setPage = useCallback((next) => setPageState({ key: listKey, page: Math.max(1, Number(next) || 1) }), [listKey]);

  // The loader identity follows the selection (a new owner or range clears the rows); search, sort and paging
  // ride through a ref and the `version` key so the previous rows stay on screen, dimmed, while the page reloads.
  const table = useMemo(() => ({ search: query, sort: sortParam(sort), page, pageSize, country, status }), [query, sort, page, pageSize, country, status]);
  const tableRef = useRef(table);
  useEffect(() => {
    tableRef.current = table;
  }, [table]);
  const loader = useCallback(
    (signal) => analyticsApi.channels({ ownerId, startDate, endDate, channelIds: channelsCsv, ...tableRef.current }, signal),
    [ownerId, startDate, endDate, channelsCsv]
  );
  const enabled = Boolean(ownerId) && isValidDay(startDate) && isValidDay(endDate);
  const { data, loading, error, reload } = useAbortableLoader(loader, { enabled, version: `${refreshKey}|${listKey}|${page}` });

  const rows = useMemo(
    () =>
      (data?.rows ?? EMPTY).map((row) => {
        const metrics = withDerived(row.metrics);
        return {
          ...row,
          metrics,
          views: metrics?.views ?? null,
          watchHours: metrics?.watchHours ?? null,
          netSubscribers: metrics?.netSubscribers ?? null,
          estimatedRevenue: metrics?.estimatedRevenue ?? null,
          rpm: metrics?.rpm ?? null
        };
      }),
    [data]
  );

  const countries = useMemo(() => {
    const counts = new Map();
    inventory.channels.forEach((channel) => {
      const code = String(channel.country || "").toUpperCase();
      if (code) counts.set(code, (counts.get(code) || 0) + 1);
    });
    return [...counts].map(([code, count]) => ({ code, count, name: regionName(code, code) })).sort((a, b) => a.name.localeCompare(b.name, language));
  }, [inventory.channels, regionName, language]);

  const columns = useMemo(() => {
    const metric = (key) => (value) => formatMetric(value, key, { language });
    const money = metric("estimatedRevenue");
    return [
      { key: "title", label: t("Channel"), sortable: true, width: 280, format: (_, row) => <ChannelCell row={row} /> },
      { key: "views", label: t("Views"), align: "right", sortable: true, format: metric("views") },
      { key: "watchHours", label: t("Watch hours"), align: "right", sortable: true, format: metric("watchHours") },
      { key: "netSubscribers", label: t("Net subscribers"), align: "right", sortable: true, format: metric("netSubscribers") },
      ...(canMonetary
        ? [
            {
              key: "estimatedRevenue",
              label: t("Estimated revenue"),
              align: "right",
              sortable: true,
              format: (value, row) => (
                <span>
                  {money(value)}
                  {row.monetaryStatus === "partial" && (
                    <span className="ml-1 text-amber-600">
                      *<span className="sr-only">{t("Revenue stored for {covered}/{total} days", { covered: toCount(row.monetaryDays), total: toCount(row.coveredDays) })}</span>
                    </span>
                  )}
                </span>
              )
            },
            { key: "rpm", label: t("RPM"), align: "right", sortable: true, format: metric("rpm") }
          ]
        : []),
      { key: "subscribersTotal", label: t("Subscribers"), align: "right", sortable: true, format: (value) => integer(value, formatNumber) },
      { key: "videoCount", label: t("Videos"), align: "right", sortable: true, format: (value) => integer(value, formatNumber) },
      { key: "coveredDays", label: t("Covered days"), align: "right", sortable: true, format: (value, row) => <CoverageCell covered={value} total={row.totalDays} /> },
      { key: "status", label: t("Status"), format: (value) => <StatusBadge status={value || "missing"} /> }
    ];
  }, [t, language, canMonetary, formatNumber]);

  const openChannel = useCallback(
    (row) => navigate({ pathname: `/analytic/channels/${encodeURIComponent(row.channelId)}`, search: location.search }),
    [navigate, location.search]
  );
  const clearFilters = useCallback(() => {
    setSearch("");
    setCountry("");
    setStatus("");
  }, []);

  const totals = metricsOf(data?.totals);
  const coverage = data?.coverage || {};
  const inventoryCount = toCount(coverage.inventoryCount) || inventory.channels.length;
  const activeCount = coverage.activeCount === undefined ? inventory.channels.filter((channel) => !channel.removedAt).length : toCount(coverage.activeCount);
  const removedCount = Math.max(0, inventoryCount - activeCount);
  const storedDays = data?.totals?.coverage;
  const ownerMissing = toCount(overview?.coverage?.missing);
  const unknownIds = Array.isArray(data?.unknownChannelIds) ? data.unknownChannelIds : EMPTY;
  const serverNotes = Array.isArray(data?.notes) ? data.notes.filter((note) => typeof note === "string" && note) : EMPTY;
  const filtered = Boolean(query || country || status);
  const firstLoad = loading && !data;
  const inventoryUpdatedAt = coverage.inventoryUpdatedAt || inventory.updatedAt;
  const coverageNote = [
    inventoryUpdatedAt ? t("Inventory updated {instant}", { instant: formatScheduleDate(inventoryUpdatedAt, language) }) : "",
    storedDays && numberValue(storedDays.total) !== null ? t("{covered}/{total} days stored", { covered: toCount(storedDays.covered), total: toCount(storedDays.total) }) : "",
    ownerMissing > 0 ? t("{count} days of this range are not stored yet", { count: ownerMissing }) : "",
    t("Sums of the stored days in this range; “—” marks a channel with no stored day.")
  ].filter(Boolean);

  const syncAction = canSync ? (
    <Button icon={RefreshCw} disabled={!connected || jobActive} title={!connected ? t("CMS disconnected") : jobActive ? t("A sync is already running") : undefined} onClick={() => openSyncDialog()}>
      {t("Sync all")}
    </Button>
  ) : null;
  const clearAction = (
    <span data-readonly-allow="true">
      <Button variant="secondary" size="sm" icon={X} onClick={clearFilters}>
        {t("Clear filters")}
      </Button>
    </span>
  );
  const emptyNode =
    inventory.channels.length === 0 && !inventory.loading ? (
      <EmptyState icon={TvMinimal} title={t("No channels in the inventory yet")} description={t("Run Sync all to load the channel list and the first days of data.")} action={syncAction} />
    ) : filtered ? (
      <EmptyState compact icon={Search} title={t("No channels match the filters")} action={clearAction} />
    ) : (
      <EmptyState icon={CalendarCheck} title={t("No stored days for any channel in this range")} description={t("Run Sync all to store the daily numbers of every channel for this range.")} action={syncAction} />
    );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiTile
          label={t("Channels in CMS")}
          value={integer(inventoryCount, formatNumber)}
          hint={removedCount ? t("{count} no longer managed", { count: removedCount }) : undefined}
          icon={TvMinimal}
          tone="blue"
          loading={firstLoad && !inventory.channels.length}
        />
        <KpiTile
          label={t("With data in range")}
          value={integer(coverage.withData, formatNumber)}
          hint={t("of {count} active channels", { count: activeCount })}
          icon={CalendarCheck}
          tone="emerald"
          loading={firstLoad}
        />
        <KpiTile
          label={t("Views")}
          value={formatMetric(totals?.views, "views", { language })}
          hint={filters.channelIds.length ? t("{count} channels", { count: filters.channelIds.length }) : t("All channels")}
          icon={Eye}
          tone="blue"
          loading={firstLoad}
        />
        {canMonetary ? (
          <KpiTile
            label={t("Estimated revenue")}
            value={formatMetric(totals?.estimatedRevenue, "estimatedRevenue", { language })}
            hint={data?.totalsMeta?.partialRevenue ? t("Revenue is stored for part of the days") : numberValue(totals?.rpm) !== null ? t("RPM {value}", { value: formatMetric(totals.rpm, "rpm", { language }) }) : undefined}
            icon={CircleDollarSign}
            tone="amber"
            monetary
            loading={firstLoad}
          />
        ) : (
          <KpiTile label={t("Watch hours")} value={formatMetric(totals?.watchHours, "watchHours", { language })} icon={Clock3} tone="emerald" loading={firstLoad} />
        )}
      </div>

      <p className="text-xs text-slate-500">{coverageNote.join(" · ")}</p>

      {unknownIds.length > 0 && (
        <InlineMessage
          tone="warning"
          title={t("Unknown channel IDs were ignored: {ids}", { ids: unknownIds.join(", ") })}
          actions={
            <span data-readonly-allow="true">
              <Button variant="secondary" size="sm" onClick={() => setFilters({ channelIds: [] })}>
                {t("Clear selection")}
              </Button>
            </span>
          }
        >
          {t("They are not in the inventory of this Content Owner.")}
        </InlineMessage>
      )}

      {serverNotes.length > 0 && (
        <InlineMessage tone="neutral">
          {serverNotes.map((note) => (
            <p key={note}>{tm(note)}</p>
          ))}
        </InlineMessage>
      )}

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <PanelHeader
          title={t("Channel performance")}
          subtitle={t("Open a channel to see its daily numbers, coverage calendar and range reports.")}
        />
        <div className="mt-4 flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <TextInput
              value={search}
              maxLength={SEARCH_LIMIT}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search channels by name or ID…")}
              aria-label={t("Search channels")}
              className="pl-10"
            />
          </div>
          <Select
            aria-label={t("Country")}
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            placeholder={t("All countries")}
            options={countries.map((item) => ({ value: item.code, label: `${item.name} (${item.count})` }))}
            wrapperClassName="lg:w-56"
          />
          <Select
            aria-label={t("Status")}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            placeholder={t("All statuses")}
            options={CHANNEL_STATUSES.map((value) => ({ value, label: t(STATUS_META[value].label) }))}
            wrapperClassName="lg:w-44"
          />
          {filtered && clearAction}
          {data && <span className="text-xs font-bold text-slate-500 lg:ml-auto">{t("{count} channels", { count: toCount(data.total) })}</span>}
        </div>

        {error && (
          <div className="mt-4">
            <ErrorPanel error={error} onRetry={reload} />
          </div>
        )}

        {(data || loading) && (
          <div className="mt-4">
            <MetricTable
              columns={columns}
              rows={rows}
              rowKey="channelId"
              sort={sort}
              onSort={setSort}
              onRowClick={isSidebarVisible("/analytic/channels#detail") ? openChannel : undefined}
              loading={loading}
              empty={emptyNode}
              footer={data ? <PaginationFooter total={toCount(data.total)} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} /> : null}
            />
          </div>
        )}
      </section>
    </div>
  );
}
