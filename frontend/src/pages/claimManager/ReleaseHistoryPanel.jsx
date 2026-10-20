import { useEffect, useMemo, useState } from "react";
import { Download, History, RefreshCw, Search, Undo2, X } from "lucide-react";
import PaginationFooter from "../../components/PaginationFooter";
import { exportClaimHistory, listClaimHistory, recheckClaims } from "../../api/contentIdClaimsApi";
import { useI18n } from "../../context/I18nContext";
import { useDebouncedValue } from "../assetDelivery/hooks";
import { Button, EmptyState, InlineMessage, Select, Spinner, StatTile, TextInput } from "../assetDelivery/shared";
import { cx, downloadBlob, formatDateTime, formatNumber, todayStamp, truncate } from "../assetDelivery/utils";
import { HISTORY_ACTION_LABELS, HISTORY_PAGE_SIZE, RELEASE_OUTCOMES, RELEASE_OUTCOME_META } from "./constants";
import { ClaimStatusBadge, MonoId, OutcomeBadge, ToneBadge } from "./shared";
import { claimKey, formatDurationMs, historyExportQuery, historyQuery, recheckToOutcome, requestMessage, shortId, statusLabel, videoUrl } from "./utils";

// History (server-side) filters; named apart from the search EMPTY_FILTERS of constants.js.
const EMPTY_HISTORY_FILTERS = { network_id: "", result: "", user_id: "", search: "", from: "", to: "" };
const EMPTY_SUMMARY = Object.fromEntries(RELEASE_OUTCOMES.map((outcome) => [outcome, 0]));
const RESULT_OPTIONS = RELEASE_OUTCOMES.map((outcome) => ({ value: outcome, label: RELEASE_OUTCOME_META[outcome].label }));

function HistoryRow({ event, busy, reinstating, onRecheck, onReinstate }) {
  const { t, tm } = useI18n();
  const url = event.video_url || videoUrl(event.video_id);
  // A release Google confirmed (the release itself or a re-check that read it back inactive) can be undone from here.
  const canReinstate = event.result === "released" && typeof onReinstate === "function";
  return (
    <tr className="align-top transition hover:bg-slate-50">
      <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">
        {formatDateTime(event.created_at)}
        <span className="block text-[11px] text-slate-400">{t(HISTORY_ACTION_LABELS[event.action] || event.action)}</span>
      </td>
      <td className="px-3 py-3 text-xs">
        <span className="block max-w-[140px] truncate font-bold text-slate-700" title={event.created_by_email || ""}>
          {event.created_by_name || event.created_by_email || "-"}
        </span>
      </td>
      <td className="px-3 py-3 text-xs">
        <span className="block max-w-[140px] truncate font-bold text-slate-700" title={event.network_name || ""}>
          {event.network_name || t("CMS {id}", { id: event.network_id })}
        </span>
        {event.content_owner_id && <span className="block font-mono text-[11px] text-slate-400">{event.content_owner_id}</span>}
      </td>
      <td className="px-3 py-3">
        <MonoId value={event.claim_id} />
      </td>
      <td className="px-3 py-3">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="block max-w-[220px] truncate text-sm font-black text-slate-900 hover:text-blue-700" title={event.video_title || event.video_id}>
            {event.video_title || event.video_id || t("Video")}
          </a>
        ) : (
          <span className="block max-w-[220px] truncate text-sm font-black text-slate-900">{event.video_title || "-"}</span>
        )}
        {event.channel_title && <span className="block max-w-[220px] truncate text-[11px] text-slate-500">{event.channel_title}</span>}
        {event.video_id && <MonoId value={event.video_id} tone="text-slate-500" />}
      </td>
      <td className="px-3 py-3">
        <MonoId value={event.asset_id} tone="text-slate-800" />
        {event.asset_title && (
          <span className="block max-w-[200px] truncate text-xs font-bold text-slate-600" title={event.asset_title}>
            {event.asset_title}
          </span>
        )}
        {event.isrc && <span className="block font-mono text-[11px] text-slate-500">{t("ISRC {isrc}", { isrc: event.isrc })}</span>}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {event.previous_status && <ClaimStatusBadge status={event.previous_status} title={t("Status before: {status}", { status: t(statusLabel(event.previous_status)) })} />}
          {event.previous_status && <span className="text-slate-300">→</span>}
          <OutcomeBadge outcome={event.result} />
        </div>
        {event.result_status && <span className="mt-1 block text-[11px] text-slate-500">{t("Now {status}", { status: t(statusLabel(event.result_status)).toLowerCase() })}</span>}
      </td>
      <td className="px-3 py-3 text-xs text-slate-600">
        {event.message && (
          <span className="block max-w-[260px]" title={tm(event.message)}>
            {truncate(tm(event.message), 140)}
          </span>
        )}
        {event.note && (
          <span className="mt-1 block max-w-[260px] italic text-slate-500" title={event.note}>
            {t("Note: {note}", { note: truncate(event.note, 120) })}
          </span>
        )}
        {event.duration_ms > 0 && (
          <span className="mt-1 block text-[11px] text-slate-400" title={t("Time Google took to answer")}>
            {formatDurationMs(event.duration_ms)}
          </span>
        )}
      </td>
      <td className="px-3 py-3">
        <MonoId value={event.operation_id} display={shortId(event.operation_id)} title={event.operation_id ? t("Operation {id}", { id: event.operation_id }) : ""} tone="text-slate-500" />
      </td>
      <td className="px-3 py-3">
        {(event.result === "unknown" || canReinstate) && (
          <div className="flex justify-end gap-1.5">
            {event.result === "unknown" && (
              <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy} disabled={reinstating} onClick={() => onRecheck(event)}>
                {t("Re-check")}
              </Button>
            )}
            {canReinstate && (
              <Button size="sm" variant="secondary" icon={Undo2} loading={reinstating} disabled={busy} title={t("Set this released claim back to active")} onClick={() => onReinstate(event)}>
                {t("Reinstate")}
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * "Release history" tab: the local audit log of releases, reinstates, confirms and re-checks with
 * server-side filters / pagination, CSV export, a Re-check action for unknown outcomes and a
 * Reinstate action for released claims (`onReinstate(event)`, run by the page; `reinstatingKeys`
 * holds the claim keys in flight). `refreshKey` changes after every status write so the list
 * reloads when revisited.
 */
export default function ReleaseHistoryPanel({ refreshKey = 0, networks = [], showToast, onReinstate, reinstatingKeys, onRecheckResults }) {
  const { t, tm } = useI18n();
  const [filters, setFilters] = useState(EMPTY_HISTORY_FILTERS);
  const debouncedSearch = useDebouncedValue(filters.search, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(HISTORY_PAGE_SIZE);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ key: "", events: [], total: 0, summary: EMPTY_SUMMARY, users: [], networks: [], error: "" });
  const [busy, setBusy] = useState({});
  const [exporting, setExporting] = useState(false);

  const requestKey = useMemo(
    () => JSON.stringify({ ...filters, search: debouncedSearch.trim(), page, pageSize, tick, refreshKey }),
    [filters, debouncedSearch, page, pageSize, tick, refreshKey]
  );
  const loading = state.key !== requestKey;

  useEffect(() => {
    const params = JSON.parse(requestKey);
    let active = true;
    listClaimHistory(historyQuery(params, params.page, params.pageSize))
      .then((data) => {
        if (!active) return;
        setState({
          key: requestKey,
          error: "",
          events: Array.isArray(data?.events) ? data.events : [],
          total: Number(data?.total) || 0,
          summary: { ...EMPTY_SUMMARY, ...(data?.summary || {}) },
          users: Array.isArray(data?.users) ? data.users : [],
          networks: Array.isArray(data?.networks) ? data.networks : []
        });
      })
      .catch((error) => {
        if (!active) return;
        // The history is our own database: a timeout here is not Google's.
        setState((current) => ({ ...current, key: requestKey, error: requestMessage(error, { googleBacked: false }) }));
      });
    return () => {
      active = false;
    };
  }, [requestKey]);

  const networkOptions = useMemo(() => {
    const source = state.networks.length ? state.networks : networks;
    return source.map((network) => ({ value: String(network.id), label: network.name || t("CMS {id}", { id: network.id }) }));
  }, [state.networks, networks, t]);
  const userOptions = useMemo(() => state.users.map((user) => ({ value: String(user.id), label: user.name || user.email || t("User {id}", { id: user.id }) })), [state.users, t]);
  const hasFilters = Object.values(filters).some((value) => String(value || "").trim());

  function updateFilter(patch) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }

  function clearFilters() {
    setFilters(EMPTY_HISTORY_FILTERS);
    setPage(1);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await exportClaimHistory(historyExportQuery(filters));
      downloadBlob(blob, `claim-release-history-${todayStamp()}.csv`);
      showToast(t("Release history exported"), "success");
    } catch (error) {
      showToast(t("Export failed: {error}", { error: tm(requestMessage(error, { googleBacked: false })) }), "error");
    } finally {
      setExporting(false);
    }
  }

  async function handleRecheck(event) {
    // Which status confirms the pending write: inactive after a release, active after a reinstate or a confirm.
    const action = ["reinstate", "confirm"].includes(event.action) ? event.action : "release";
    setBusy((current) => ({ ...current, [event.id]: true }));
    try {
      const data = await recheckClaims([{ network_id: event.network_id, claim_id: event.claim_id }]);
      const results = Array.isArray(data?.results) ? data.results : [];
      // The Check claims table shows the same claim: let the page update that row (it also refreshes this list).
      if (results.length && typeof onRecheckResults === "function") onRecheckResults(results);
      const result = results[0];
      if (!result) {
        showToast(t("No answer from the server for this claim"), "warning");
      } else {
        const outcome = recheckToOutcome(result, { action });
        if (result.in_flight) {
          // The server is still writing this claim: the status read back may be superseded within a minute.
          showToast(tm(outcome.message), "warning", 6000);
        } else if (!result.found) {
          showToast(t("Claim {id}: {message}", { id: event.claim_id, message: tm(outcome.message) }), "warning", 5000);
        } else {
          const confirmed = ["released", "reinstated", "confirmed"].includes(outcome.outcome);
          const status = t(statusLabel(result.status)).toLowerCase();
          showToast(
            confirmed
              ? t("Claim {id} is now {status}", { id: event.claim_id, status })
              : t("Claim {id} is now {status}: {message}", { id: event.claim_id, status, message: tm(outcome.message) }),
            confirmed ? "success" : "warning",
            confirmed ? 5000 : 7000
          );
        }
      }
      if (!(results.length && typeof onRecheckResults === "function")) setTick((current) => current + 1);
    } catch (error) {
      showToast(t("Re-check failed: {error}", { error: tm(requestMessage(error)) }), "error", 5000);
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[event.id];
        return next;
      });
    }
  }

  const { events, total, summary, error } = state;
  const showEmpty = !loading && !error && !events.length;
  const showTable = !showEmpty && (!error || events.length > 0);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        {RELEASE_OUTCOMES.map((outcome) => (
          <StatTile key={outcome} label={t(RELEASE_OUTCOME_META[outcome].label)} value={formatNumber(summary[outcome])} hint={t(RELEASE_OUTCOME_META[outcome].description)} tone={RELEASE_OUTCOME_META[outcome].tone} />
        ))}
      </div>

      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-5">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
            <div className="relative xl:col-span-2">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <TextInput value={filters.search} aria-label={t("Search history")} placeholder={t("Claim, video, asset, title or note…")} className="pl-11" onChange={(event) => updateFilter({ search: event.target.value })} />
            </div>
            <Select value={filters.network_id} placeholder={t("All CMS")} options={networkOptions} aria-label={t("CMS filter")} onChange={(event) => updateFilter({ network_id: event.target.value })} />
            <Select
              value={filters.result}
              placeholder={t("All results")}
              options={RESULT_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
              aria-label={t("Result filter")}
              onChange={(event) => updateFilter({ result: event.target.value })}
            />
            <Select value={filters.user_id} placeholder={t("All users")} options={userOptions} aria-label={t("User filter")} onChange={(event) => updateFilter({ user_id: event.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <TextInput type="date" value={filters.from} aria-label={t("From date")} onChange={(event) => updateFilter({ from: event.target.value })} />
              <TextInput type="date" value={filters.to} aria-label={t("To date")} onChange={(event) => updateFilter({ to: event.target.value })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-400">
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size={13} /> {t("Loading…")}
                </span>
              ) : total === 1 ? (
                t("{count} event", { count: total })
              ) : (
                t("{count} events", { count: total })
              )}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {hasFilters && (
                <Button size="sm" variant="ghost" icon={X} onClick={clearFilters}>
                  {t("Clear filters")}
                </Button>
              )}
              <Button size="sm" variant="secondary" icon={RefreshCw} loading={loading && events.length > 0} onClick={() => setTick((current) => current + 1)}>
                {t("Refresh")}
              </Button>
              <Button size="sm" variant="secondary" icon={Download} loading={exporting} disabled={!total} onClick={handleExport}>
                {t("Export CSV")}
              </Button>
            </div>
          </div>
        </div>

        {error && (
          <div className="p-5">
            <InlineMessage
              tone="error"
              actions={
                <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => setTick((current) => current + 1)}>
                  {t("Retry")}
                </Button>
              }
            >
              {t("Could not load the release history: {error}", { error: tm(error) })}
            </InlineMessage>
          </div>
        )}

        {showEmpty && (
          <div className="p-5">
            <EmptyState
              icon={History}
              title={hasFilters ? t("No event matches these filters") : t("No release recorded yet")}
              description={hasFilters ? t("Try another CMS, result, user, text or date range.") : t("Every release, reinstate, confirm and re-check made from this tool is logged here.")}
              action={
                hasFilters ? (
                  <Button variant="secondary" icon={X} onClick={clearFilters}>
                    {t("Clear filters")}
                  </Button>
                ) : null
              }
            />
          </div>
        )}

        {/* Same scroll box as ClaimsTable: the bounded height keeps the horizontal scrollbar in view and the header sticky. */}
        {showTable && (
          <div className="max-h-[72vh] overflow-auto">
            <table className="w-full min-w-[1500px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
                <tr>
                  <th scope="col" className="px-3 py-3">{t("Time")}</th>
                  <th scope="col" className="px-3 py-3">{t("User")}</th>
                  <th scope="col" className="px-3 py-3">{t("CMS")}</th>
                  <th scope="col" className="px-3 py-3">{t("Claim")}</th>
                  <th scope="col" className="px-3 py-3">{t("Video")}</th>
                  <th scope="col" className="px-3 py-3">{t("Asset")}</th>
                  <th scope="col" className="px-3 py-3">{t("Result")}</th>
                  <th scope="col" className="min-w-[280px] px-3 py-3">{t("Message / note")}</th>
                  <th scope="col" className="px-3 py-3">{t("Operation")}</th>
                  <th scope="col" className="px-3 py-3 text-right">{t("Actions")}</th>
                </tr>
              </thead>
              <tbody className={cx("divide-y divide-slate-100", loading && events.length > 0 && "opacity-60")}>
                {loading && !events.length ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-14 text-center">
                      <span className="inline-flex items-center gap-2 text-sm font-bold text-slate-400">
                        <Spinner size={18} /> {t("Loading release history…")}
                      </span>
                    </td>
                  </tr>
                ) : (
                  events.map((event) => (
                    <HistoryRow
                      key={event.id}
                      event={event}
                      busy={Boolean(busy[event.id])}
                      reinstating={Boolean(reinstatingKeys?.has(claimKey(event.network_id, event.claim_id)))}
                      onRecheck={handleRecheck}
                      onReinstate={onReinstate}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {!showEmpty && !error && <PaginationFooter total={total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />}
      </section>
      <p className="px-1 text-[11px] text-slate-400">
        {/* No space after {badge}: the badge's margin is the gap, as before. The badge texts are the outcome labels. */}
        {t("{badge}rows are releases, reinstates or confirms Google never answered: Re-check reads the current status and records it when the write went through.", {
          badge: (
            <ToneBadge tone="amber" className="mr-1">
              {t(RELEASE_OUTCOME_META.unknown.label)}
            </ToneBadge>
          )
        })}
        {t("{badge}rows offer Reinstate: it sets the claim back to active (the video is claimed again with the asset's policy) and is logged as its own event.", {
          badge: (
            <ToneBadge tone="emerald" className="mx-1">
              {t(RELEASE_OUTCOME_META.released.label)}
            </ToneBadge>
          )
        })}
      </p>
    </div>
  );
}
