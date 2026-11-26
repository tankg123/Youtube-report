import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, matchPath, useLocation } from "react-router-dom";
import { Activity, CalendarCheck, CloudOff, Database, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useSystemSettings } from "../../context/SystemSettingsContext";
import { useI18n } from "../../context/I18nContext";
import { Badge, Button, EmptyState, Field, InlineMessage, Modal, Select, Toast } from "../assetDelivery/shared";
import { cx } from "../assetDelivery/utils";
import AnalyticsProvider from "./AnalyticsProvider";
import { useAnalytics } from "./hooks";
import { ANALYTICS_SECTIONS, EXPORTS_BY_VIEW, SCOPE_LABELS, exportOptionAvailable, isRangeBehind, oauthReasonMessage, rangeEndingAt } from "./analyticsUtils";
import { ChannelPicker, DateRangeControl, ErrorPanel, ExportMenu, LoadingPanel, OwnerSelect, StatusBadge, SyncStatusPill } from "./shared";
import OverviewView from "./views/OverviewView.jsx";
import ChannelsView from "./views/ChannelsView.jsx";
import ChannelDetailView from "./views/ChannelDetailView.jsx";
import ContentView from "./views/ContentView.jsx";
import AudienceView from "./views/AudienceView.jsx";
import RevenueView from "./views/RevenueView.jsx";
import ExplorerView from "./views/ExplorerView.jsx";
import SyncView from "./views/SyncView.jsx";
import SyncDialog from "./SyncDialog.jsx";
import "./analytics.css";

// Analytics shell: the provider (filters in the URL, bootstrap, overview, job polling), the page header with the
// Content Owner, the sticky global filter bar, the section tabs and the nested routes. Views read useAnalytics()
// and never receive props. Export options follow the active view (EXPORTS_BY_VIEW); the single SyncDialog mount
// lives here so every view can open it through openSyncDialog().

const BASE = "/analytic";
const TAB_CLASS =
  "inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200";
const LINK_BUTTON_CLASS =
  "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300";

const sectionPath = (section) => `${BASE}/${section.path}`;

// The active view key for EXPORTS_BY_VIEW and the tabs; channel detail carries the channelId its exports need.
function resolveView(pathname) {
  const detail = matchPath(`${BASE}/channels/:channelId`, pathname);
  if (detail) return { view: "channelDetail", tab: "channels", channelId: detail.params.channelId };
  const section = ANALYTICS_SECTIONS.find((item) => matchPath({ path: sectionPath(item), end: false }, pathname));
  return { view: section?.key || "overview", tab: section?.key || "overview", channelId: null };
}

function SectionTabs({ sections, active, search }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("Analytic")} data-readonly-allow="true" className="flex flex-wrap gap-2 rounded-3xl border border-slate-200 bg-white p-2 shadow-sm">
      {sections.map((section) => {
        const Icon = section.icon;
        const selected = section.key === active;
        return (
          <Link
            key={section.key}
            to={{ pathname: sectionPath(section), search }}
            aria-current={selected ? "page" : undefined}
            className={cx(TAB_CLASS, selected ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900")}
          >
            <Icon size={16} aria-hidden="true" />
            {t(section.label)}
          </Link>
        );
      })}
    </nav>
  );
}

// Date range, channels and scope: inline in the sticky bar from `md`, stacked inside the Filters modal below it
// (where the presets render inline instead of a popover the modal body would clip).
function FilterControls({ stacked = false }) {
  const { t } = useI18n();
  const { filters, setFilters, inventory, presets, latestDay, latestAllowedDay, lagDays, owner } = useAnalytics();
  const range = useMemo(() => ({ startDate: filters.startDate, endDate: filters.endDate }), [filters.startDate, filters.endDate]);
  const scopeOptions = useMemo(() => Object.entries(SCOPE_LABELS).map(([value, label]) => ({ value, label: t(label) })), [t]);
  const disabled = !owner;
  const dateControl = (
    <DateRangeControl
      value={range}
      onChange={(next) => setFilters(next)}
      latestDay={latestDay}
      latestAllowedDay={latestAllowedDay}
      lagDays={lagDays}
      presets={presets}
      disabled={disabled}
      inline={stacked}
    />
  );
  const channelControl = (
    <ChannelPicker
      channels={inventory.channels}
      value={filters.channelIds}
      onChange={(channelIds) => setFilters({ channelIds })}
      disabled={disabled || inventory.loading}
      size={stacked ? "md" : "sm"}
    />
  );
  const scopeControl = !filters.channelIds.length && (
    <Select
      aria-label={t("Scope")}
      compact={!stacked}
      value={filters.scope}
      disabled={disabled}
      onChange={(event) => setFilters({ scope: event.target.value })}
      options={scopeOptions}
      wrapperClassName={stacked ? undefined : "w-48 shrink-0"}
    />
  );
  if (!stacked) {
    return (
      <>
        {dateControl}
        {channelControl}
        {scopeControl}
      </>
    );
  }
  return (
    <div data-readonly-allow="true" className="space-y-4">
      <Field label={t("Date range")}>{dateControl}</Field>
      <Field label={t("Channels")}>{channelControl}</Field>
      {scopeControl && <Field label={t("Scope")}>{scopeControl}</Field>}
    </div>
  );
}

function FilterBar({ view, channelId }) {
  const { isSidebarVisible } = useSystemSettings();
  const { t, formatDate } = useI18n();
  const { search } = useLocation();
  const { filters, setFilters, permissions, job, jobActive, exportFile, exporting, openSyncDialog, inventory, latestDay } = useAnalytics();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const channelCount = filters.channelIds.length;
  // Snapshot exports (breakdowns, top videos, demographics) follow the panels: hidden while several channels are selected.
  const exportOptions = useMemo(
    () =>
      (EXPORTS_BY_VIEW[view] || [])
        .filter((option) => exportOptionAvailable(option, { canMonetary: permissions.canMonetary, channelId, channelCount }))
        .map((option) => ({ ...option, label: t(option.label) })),
    [view, channelId, channelCount, permissions.canMonetary, t]
  );
  const syncTitle = !permissions.connected ? t("CMS disconnected") : jobActive ? t("A sync is already running") : undefined;
  const channelSummary = channelCount
    ? t("{count} channels", { count: channelCount })
    : t("All channels ({count})", { count: inventory.channels.length });
  // A persisted absolute range the morning after a sync ends before the newest stored day: one line offers to move it.
  const behind = isRangeBehind(filters, latestDay);

  function handleExport(option) {
    return exportFile({ type: option.type, dimension: option.dimension, format: option.format, channelId: option.channel ? channelId : undefined });
  }

  return (
    <div className="sticky top-14 z-30 rounded-3xl border border-slate-200 bg-white p-3 shadow-sm">
      {behind && (
        <p data-readonly-allow="true" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-800">
          <span className="min-w-0">{t("Newer data is stored up to {date} — this range ends earlier.", { date: formatDate(latestDay) })}</span>
          <button type="button" onClick={() => setFilters(rangeEndingAt(filters, latestDay))} className="font-black text-blue-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200">
            {t("Use latest data")}
          </button>
        </p>
      )}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="flex min-w-0 items-center gap-2 md:hidden">
            <span data-readonly-allow="true">
              <Button variant="secondary" size="sm" icon={SlidersHorizontal} onClick={() => setFiltersOpen(true)}>
                {t("Filters")}
              </Button>
            </span>
            <span className="min-w-0 truncate text-xs font-bold text-slate-500">
              {formatDate(filters.startDate)} – {formatDate(filters.endDate)} · {channelSummary}
            </span>
          </div>
          <div className="hidden min-w-0 flex-wrap items-center gap-2 md:flex">
            <FilterControls />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <SyncStatusPill job={job} to={isSidebarVisible("/analytic/sync") ? { pathname: `${BASE}/sync`, search } : null} />
          {exportOptions.length > 0 && <ExportMenu options={exportOptions} onSelect={handleExport} busy={exporting} />}
          {permissions.canSync && (
            <Button size="sm" icon={RefreshCw} disabled={!permissions.connected || jobActive} title={syncTitle} onClick={() => openSyncDialog()}>
              {t("Sync all")}
            </Button>
          )}
        </div>
      </div>
      <Modal
        open={filtersOpen}
        size="sm"
        title={t("Filters")}
        onClose={() => setFiltersOpen(false)}
        footer={
          <Button variant="secondary" onClick={() => setFiltersOpen(false)}>
            {t("Done")}
          </Button>
        }
      >
        <FilterControls stacked />
      </Modal>
    </div>
  );
}

// Stored data stays browsable while the CMS OAuth is revoked; only admins can open the Networks page to reconnect.
// Known OAuth reasons (invalid_grant, unauthorized_client, invalid_client) become one dictionary sentence; the raw
// Google string is shown only to the users who can act on it (Settings > Network).
function DisconnectedBanner({ owner, canOpenNetworks }) {
  const { t, tm } = useI18n();
  const raw = typeof owner.authError === "string" ? owner.authError : owner.authError?.message || "";
  const known = oauthReasonMessage(raw);
  const reason = known ? t(known) : canOpenNetworks && raw ? tm(raw) : "";
  return (
    <InlineMessage
      tone="warning"
      icon={CloudOff}
      title={t("CMS disconnected")}
      actions={
        canOpenNetworks ? (
          <Link to="/networks" className={LINK_BUTTON_CLASS}>
            {t("Open Networks")}
          </Link>
        ) : undefined
      }
    >
      {reason && <span className="block">{reason}</span>}
      {known && canOpenNetworks && raw && <span className="block break-words font-mono text-[11px] text-slate-500">{raw}</span>}
      <span className="block">
        {canOpenNetworks
          ? t("Reconnect the CMS OAuth to resume the daily sync. The stored numbers stay available.")
          : `${t("Ask an administrator to reconnect the CMS OAuth in Settings > Network.")} ${t("The stored numbers stay available.")}`}
      </span>
    </InlineMessage>
  );
}

// Revenue is a monetary section: other roles are sent back to the overview with one warning toast.
function RevenueRoute() {
  const { t } = useI18n();
  const { search } = useLocation();
  const { bootstrap, permissions, notify } = useAnalytics();
  const allowed = permissions.canMonetary;
  useEffect(() => {
    if (bootstrap && !allowed) notify(t("Revenue reports are available to administrators and Report Managers only"), "warning", 6000);
  }, [bootstrap, allowed, notify, t]);
  if (!bootstrap) return <LoadingPanel rows={6} />;
  if (!allowed) return <Navigate to={{ pathname: `${BASE}/overview`, search }} replace />;
  return <RevenueView />;
}

function AnalyticsShell() {
  const { isSidebarVisible, loading: loadingMenu } = useSystemSettings();
  const { t, formatDate, formatNumber } = useI18n();
  const { canViewSettings } = useAuth() || {};
  const location = useLocation();
  const { bootstrap, bootstrapLoading, bootstrapError, reloadBootstrap, owners, owner, permissions, filters, setFilters, toast, hideToast } = useAnalytics();
  const { view, tab, channelId } = useMemo(() => resolveView(location.pathname), [location.pathname]);
  const sections = ANALYTICS_SECTIONS.filter((section) => (!section.monetary || permissions.canMonetary) && isSidebarVisible(sectionPath(section)));
  // The /networks route and the cms-auth endpoints behind it are admin-only (canViewSettings).
  const canOpenNetworks = Boolean(canViewSettings);
  const storedDays = Number(owner?.coverage?.days) || 0;
  const redirect = sections.length ? <Navigate to={{ pathname: sectionPath(sections[0]), search: location.search }} replace /> : null;

  let body;
  if (loadingMenu) {
    body = <LoadingPanel rows={6} />;
  } else if (!sections.length) {
    body = <InlineMessage>{t("No visible subpages.")}</InlineMessage>;
  } else if (!isSidebarVisible(`${BASE}/${tab}`) || (channelId && !isSidebarVisible("/analytic/channels#detail"))) {
    body = channelId && isSidebarVisible("/analytic/channels")
      ? <Navigate to={{ pathname: "/analytic/channels", search: location.search }} replace /> : redirect;
  } else if (bootstrapError && !bootstrap) {
    body = <ErrorPanel error={bootstrapError} onRetry={reloadBootstrap} />;
  } else if (!bootstrap) {
    body = <LoadingPanel rows={6} />;
  } else if (!owners.length) {
    body = (
      <EmptyState
        icon={Database}
        title={t("No Content Owner connected")}
        description={t("Connect a YouTube CMS (content owner) with the Content ID OAuth to start storing analytics.")}
        action={
          canOpenNetworks ? (
            <Link to="/networks" className={LINK_BUTTON_CLASS}>
              {t("Open Networks")}
            </Link>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <>
        <FilterBar view={view} channelId={channelId} />
        {owner && !permissions.connected && <DisconnectedBanner owner={owner} canOpenNetworks={canOpenNetworks} />}
        <SectionTabs sections={sections} active={tab} search={location.search} />
        <Routes>
          <Route index element={redirect} />
          <Route path="overview" element={<OverviewView />} />
          <Route path="channels" element={<ChannelsView />} />
          <Route path="channels/:channelId" element={<ChannelDetailView />} />
          <Route path="content" element={<ContentView />} />
          <Route path="audience" element={<AudienceView />} />
          <Route path="revenue" element={<RevenueRoute />} />
          <Route path="explorer" element={<ExplorerView />} />
          <Route path="sync" element={<SyncView />} />
          <Route path="*" element={redirect} />
        </Routes>
        <SyncDialog />
      </>
    );
  }

  return (
    <div className="space-y-5 p-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-black uppercase text-blue-700">
              <Activity size={15} aria-hidden="true" />
              {t("YouTube Analytics")}
            </p>
            <h1 className="mt-3 text-3xl font-black text-slate-950">{t("Analytic")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              {t("Daily numbers of every managed channel, stored from the YouTube Analytics API: synced each morning, kept as reported and exportable at any time.")}
            </p>
          </div>
          <div className="w-full xl:max-w-xl">
            <p className="text-xs font-black uppercase tracking-wide text-slate-400">{t("Content Owner")}</p>
            <div className="mt-1.5">
              <OwnerSelect owners={owners} value={filters.ownerId} onChange={(ownerId) => setFilters({ ownerId })} disabled={bootstrapLoading && !bootstrap} />
            </div>
            {owner && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {permissions.connected && <StatusBadge status="connected" />}
                {owner.coverage?.lastDay && (
                  <Badge tone="blue" icon={CalendarCheck}>
                    {t("Latest data: {date}", { date: formatDate(owner.coverage.lastDay) })}
                  </Badge>
                )}
                {storedDays > 0 && <Badge tone="slate">{t("{count} days stored", { count: formatNumber(storedDays) })}</Badge>}
              </div>
            )}
          </div>
        </div>
        {bootstrapError && bootstrap && (
          <div className="mt-4">
            <ErrorPanel error={bootstrapError} onRetry={reloadBootstrap} />
          </div>
        )}
      </section>
      {body}
      {toast && (
        <Toast
          id={toast.id}
          tone={toast.tone}
          message={
            <span className="flex items-center gap-3">
              <span className="min-w-0">{toast.message}</span>
              <button
                type="button"
                onClick={hideToast}
                aria-label={t("Close")}
                title={t("Close")}
                className="shrink-0 rounded-lg p-0.5 opacity-80 transition hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </span>
          }
        />
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <AnalyticsProvider>
      <AnalyticsShell />
    </AnalyticsProvider>
  );
}
