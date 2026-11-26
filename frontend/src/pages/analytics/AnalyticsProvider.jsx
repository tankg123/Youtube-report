import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { analyticsApi, analyticsBlobError, analyticsError, downloadAnalyticsFile } from "../../api/analyticsApi";
import { useAuth } from "../../context/AuthContext";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../assetDelivery/hooks";
import { AnalyticsContext } from "./analyticsContext";
import { useAbortableLoader, useJobPolling } from "./hooks";
import {
  ACTIVE_JOBS, DATE_PRESETS, countDays, exportChannelId, filtersToSearchParams, isRangeFallback, isValidDay, pacificToday, searchParamsToFilters
} from "./analyticsUtils";

const FILTER_PARAMS = ["owner", "start", "end", "scope", "channels"];
const STORAGE_PREFIX = "analytics.filters.";
const OWNER_KEY = `${STORAGE_PREFIX}ownerId`;
const EMPTY_LIST = Object.freeze([]);
const NO_DIALOG = Object.freeze({ open: false, options: null });

function readStorage(key) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorage(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode): the URL still carries the filters
  }
}

// The fresher of the job tracked locally (sync / cancel / polling answers) and the owner's latest job of the overview.
function newestJob(tracked, latest) {
  if (!tracked) return latest || null;
  if (!latest) return tracked;
  if (tracked.id === latest.id) return ACTIVE_JOBS.includes(tracked.status) && !ACTIVE_JOBS.includes(latest.status) ? latest : tracked;
  return String(latest.createdAt || "") > String(tracked.createdAt || "") ? latest : tracked;
}

// startSync rejects with an Error whose message is analyticsError(); status / reason / plan let the dialog react
// to 4xx answers (400 over-cap carries the plan, 409 tooManyJobs / cmsNotConnected).
function syncFailure(error) {
  const failure = new Error(analyticsError(error), { cause: error });
  failure.status = error?.response?.status ?? null;
  failure.reason = error?.response?.data?.error?.reason ?? null;
  failure.plan = error?.response?.data?.plan ?? null;
  return failure;
}

// Fallback name when the server sends no Content-Disposition; a single-channel export carries the channel marker.
const exportName = ({ type, dimension, format, ownerId, channelId, startDate, endDate }) =>
  `analytics-${type}${dimension ? `-${dimension}` : ""}-${ownerId}${channelId ? `-${channelId}` : ""}-${startDate}-${endDate}.${format}`;

export default function AnalyticsProvider({ children }) {
  const { t, tm, language } = useI18n();
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast, showToast, hideToast } = useToast();

  const bootstrapLoader = useCallback((signal) => analyticsApi.bootstrap(signal), []);
  const bootstrapState = useAbortableLoader(bootstrapLoader);
  const bootstrap = bootstrapState.data;
  const owners = bootstrap?.owners ?? EMPTY_LIST;
  const latestAllowedDay = isValidDay(bootstrap?.latestAllowedDay) ? bootstrap.latestAllowedDay : null;
  const lagDays = Number(bootstrap?.defaults?.lagDays) || 3;

  // Filters: the URL wins; without analytics params the owner's sessionStorage mirror is used, then the defaults.
  // `rangeRejected` flags a shared link whose start/end the whitelist replaced (handled once bootstrap is known).
  const search = searchParams.toString();
  const { filters, rangeRejected } = useMemo(() => {
    const params = new URLSearchParams(search);
    const context = { owners, latestAllowedDay, lagDays };
    if (FILTER_PARAMS.some((key) => params.has(key))) {
      const parsed = searchParamsToFilters(params, context);
      return { filters: parsed, rangeRejected: isRangeFallback(params, parsed) };
    }
    const { ownerId } = searchParamsToFilters({ owner: readStorage(OWNER_KEY) }, context);
    const stored = new URLSearchParams(ownerId ? readStorage(STORAGE_PREFIX + ownerId) : "");
    stored.set("owner", ownerId);
    return { filters: searchParamsToFilters(stored, context), rangeRejected: false };
  }, [search, owners, latestAllowedDay, lagDays]);
  const { ownerId, startDate, endDate, scope } = filters;
  const channelsCsv = filters.channelIds.join(",");
  const owner = useMemo(() => owners.find((item) => String(item.ownerId || item.id) === ownerId) || null, [owners, ownerId]);
  const latestDay = isValidDay(owner?.coverage?.lastDay) ? owner.coverage.lastDay : null;

  useEffect(() => {
    if (!ownerId) return;
    writeStorage(OWNER_KEY, ownerId);
    writeStorage(STORAGE_PREFIX + ownerId, new URLSearchParams(filtersToSearchParams(filters)).toString());
  }, [filters, ownerId]);

  // An invalid or out-of-bounds range in a shared link: the address bar gets the range actually shown (replace, no
  // history entry) and the user is told once; the bootstrap must be known first so latestAllowedDay is the real one.
  const rangeNoticeRef = useRef(false);
  useEffect(() => {
    if (!rangeRejected || !bootstrap) return;
    setSearchParams(filtersToSearchParams(filters), { replace: true });
    if (rangeNoticeRef.current) return;
    rangeNoticeRef.current = true;
    showToast(t("The link's date range was invalid — showing the last 28 days"), "warning", 6000);
  }, [rangeRejected, bootstrap, filters, setSearchParams, showToast, t]);

  const setFilters = useCallback(
    (patch = {}) => {
      const merged = { ...filters, ...patch };
      // Channels belong to one Content Owner: switching the owner drops the selection unless the patch sets one.
      if (patch.ownerId && patch.ownerId !== filters.ownerId && patch.channelIds === undefined) merged.channelIds = [];
      const next = searchParamsToFilters(filtersToSearchParams(merged), { owners, latestAllowedDay, lagDays });
      setSearchParams(filtersToSearchParams(next), { replace: true });
    },
    [filters, owners, latestAllowedDay, lagDays, setSearchParams]
  );

  const inventoryLoader = useCallback((signal) => analyticsApi.channelsInventory({ ownerId }, signal), [ownerId]);
  const inventoryState = useAbortableLoader(inventoryLoader, { enabled: Boolean(ownerId) });
  const inventory = useMemo(() => {
    const channels = inventoryState.data?.channels ?? EMPTY_LIST;
    return {
      channels,
      byId: new Map(channels.map((channel) => [channel.channelId, channel])),
      updatedAt: inventoryState.data?.updatedAt ?? null,
      loading: inventoryState.loading,
      error: inventoryState.error,
      reload: inventoryState.reload
    };
  }, [inventoryState.data, inventoryState.loading, inventoryState.error, inventoryState.reload]);

  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const overviewLoader = useCallback(
    (signal) => analyticsApi.overview({ ownerId, startDate, endDate, scope, channelIds: channelsCsv, compare: true }, signal),
    [ownerId, startDate, endDate, scope, channelsCsv]
  );
  const overviewState = useAbortableLoader(overviewLoader, {
    enabled: Boolean(ownerId) && isValidDay(startDate) && isValidDay(endDate),
    version: refreshKey
  });
  const overview = overviewState.data;

  const [trackedJob, setTrackedJob] = useState(null);
  const rememberJob = useCallback((next) => setTrackedJob(next ? { ...next, ownerId: next.ownerId || ownerId } : null), [ownerId]);
  const job = useMemo(
    () => newestJob(trackedJob && trackedJob.ownerId === ownerId ? trackedJob : null, overview?.latestJob ?? null),
    [trackedJob, ownerId, overview]
  );
  const jobActive = ACTIVE_JOBS.includes(job?.status);

  const reloadInventory = inventoryState.reload;
  const reloadBootstrap = bootstrapState.reload;
  // A finished job may have stored newer days: /bootstrap is re-read so latestDay, the "Latest data" badge, the day
  // count and every preset anchor follow the data (the loader keeps the current bootstrap on screen meanwhile).
  const onJobFinish = useCallback(
    (finished) => {
      refresh();
      reloadInventory();
      reloadBootstrap();
      const days = finished.result?.days || {};
      if (finished.status === "completed" || finished.status === "partial") {
        showToast(
          t("Added {days} · {drift} days drifted", { days: countDays(days, "added"), drift: countDays(days, "drifted") }),
          finished.status === "completed" ? "success" : "warning",
          6000
        );
      } else if (finished.status === "cancelled") {
        showToast(t("Sync cancelled"), "warning");
      } else if (finished.status === "interrupted") {
        showToast(t("Sync interrupted"), "error");
      } else {
        const reason = finished.errors?.[0]?.message || finished.error?.message || finished.error || "";
        showToast(t("Sync failed: {message}", { message: tm(String(reason)) || t("Unknown") }), "error", 8000);
      }
    },
    [refresh, reloadInventory, reloadBootstrap, showToast, t, tm]
  );
  useJobPolling(job, { onUpdate: rememberJob, onFinish: onJobFinish });

  // A tab left open across the Pacific midnight: latestAllowedDay moved, so the bootstrap is re-read when the tab
  // becomes visible on a later PT day (the daily sync may also have stored a new day by then).
  const pacificDayRef = useRef(pacificToday());
  useEffect(() => {
    if (bootstrap) pacificDayRef.current = pacificToday();
  }, [bootstrap]);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const today = pacificToday();
      if (today === pacificDayRef.current) return;
      pacificDayRef.current = today;
      reloadBootstrap();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [reloadBootstrap]);

  const [syncing, setSyncing] = useState(false);
  const startSync = useCallback(
    async (body) => {
      const dryRun = Boolean(body?.dryRun);
      if (!dryRun) setSyncing(true);
      try {
        const response = await analyticsApi.sync(body);
        if (!dryRun && response?.job) rememberJob(response.job);
        return response;
      } catch (error) {
        throw syncFailure(error);
      } finally {
        if (!dryRun) setSyncing(false);
      }
    },
    [rememberJob]
  );

  const [cancelling, setCancelling] = useState(false);
  const jobId = job?.id ?? null;
  const cancelJob = useCallback(async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      const response = await analyticsApi.cancel(jobId);
      if (response?.job) rememberJob(response.job);
    } catch (error) {
      showToast(t("Could not cancel the job: {message}", { message: tm(analyticsError(error)) }), "error");
    } finally {
      setCancelling(false);
    }
  }, [jobId, rememberJob, showToast, t, tm]);

  // exportFile({ type, dimension, format, channelId, filename, extra }): `extra` (e.g. { entityKey, day } for the
  // ledger) is merged into the /export query; with exactly one channel in the global filter the request carries its
  // channelId for every type except the owner-scope ones, so the file matches the channel snapshot on screen.
  const [exporting, setExporting] = useState("");
  const exportFile = useCallback(
    async ({ type, dimension, format = "csv", channelId, filename, extra } = {}) => {
      const key = `${type}${dimension ? `:${dimension}` : ""}:${format}`;
      const channel = exportChannelId(type, filters.channelIds, channelId);
      setExporting(key);
      try {
        const response = await analyticsApi.exportFile({
          ownerId, startDate, endDate, scope, channelIds: channelsCsv, ...(extra && typeof extra === "object" ? extra : {}),
          type, dimension, format, lang: language, channelId: channel
        });
        downloadAnalyticsFile(response, filename || exportName({ type, dimension, format, ownerId, channelId: channel, startDate, endDate }));
      } catch (error) {
        showToast(t("Could not export the file: {message}", { message: tm(await analyticsBlobError(error)) }), "error", 6000);
      } finally {
        setExporting("");
      }
    },
    [ownerId, startDate, endDate, scope, channelsCsv, filters.channelIds, language, showToast, t, tm]
  );

  const [syncDialog, setSyncDialog] = useState(NO_DIALOG);
  const openSyncDialog = useCallback((options = null) => setSyncDialog({ open: true, options }), []);
  const closeSyncDialog = useCallback(() => setSyncDialog(NO_DIALOG), []);

  const isReadOnly = Boolean(auth?.isReadOnly);
  const permissions = useMemo(() => {
    const granted = bootstrap?.permissions || {};
    return {
      canMonetary: Boolean(granted.canMonetary),
      canSync: Boolean(granted.canSync),
      canOverwrite: Boolean(granted.canOverwrite),
      canManageSchedules: Boolean(granted.canManageSchedules),
      connected: owner?.authStatus === "connected",
      isReadOnly
    };
  }, [bootstrap, owner, isReadOnly]);

  const value = useMemo(
    () => ({
      bootstrap,
      bootstrapLoading: bootstrapState.loading,
      bootstrapError: bootstrapState.error,
      reloadBootstrap,
      owners,
      owner,
      inventory,
      permissions,
      filters,
      setFilters,
      presets: DATE_PRESETS,
      latestDay,
      latestAllowedDay,
      lagDays,
      overview,
      overviewLoading: overviewState.loading,
      overviewError: overviewState.error,
      refresh,
      refreshKey,
      job,
      jobActive,
      startSync,
      cancelJob,
      syncing,
      cancelling,
      notify: showToast,
      toast,
      hideToast,
      exportFile,
      exporting,
      syncDialog,
      openSyncDialog,
      closeSyncDialog
    }),
    [
      bootstrap, bootstrapState.loading, bootstrapState.error, reloadBootstrap, owners, owner, inventory, permissions,
      filters, setFilters, latestDay, latestAllowedDay, lagDays, overview, overviewState.loading, overviewState.error, refresh,
      refreshKey, job, jobActive, startSync, cancelJob, syncing, cancelling, showToast, toast, hideToast, exportFile, exporting,
      syncDialog, openSyncDialog, closeSyncDialog
    ]
  );

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}
