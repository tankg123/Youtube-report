import { useMemo, useState } from "react";
import { CircleCheckBig, Download, FileSearch, ListChecks, RefreshCw, Search, SquareCheckBig, TriangleAlert, Unlock, Video, X, Zap } from "lucide-react";
import { useI18n } from "../../context/I18nContext";
import { useDebouncedValue } from "../assetDelivery/hooks";
import { Button, EmptyState, InlineMessage, Spinner, StatTile, TextInput, Toggle } from "../assetDelivery/shared";
import { downloadTextFile, formatNumber, rowsToCsv, todayStamp } from "../assetDelivery/utils";
import { DEFAULT_LIMITS, PAGE_SIZE, QUICK_FILTER_DEBOUNCE_MS, SEARCH_ERROR_SCOPE_LABELS } from "./constants";
import ClaimsTable from "./ClaimsTable";
import { Chip, ReleaseButton } from "./shared";
import {
  claimKey,
  claimsToCsvRows,
  countByStatus,
  filterClaims,
  formatDurationMs,
  groupClaimsByVideo,
  isActivatable,
  isReleasable,
  orderedStatuses,
  paginate,
  paginateGroups,
  selectActivatableKeys,
  selectReleasableKeys,
  sortClaims,
  statusLabel,
  toggleInList,
  toggleSort
} from "./utils";

// UTF-8 byte-order mark so Excel opens the CSV with the right encoding.
const CSV_BOM = String.fromCharCode(0xfeff);

function requestPlanText(plan, t) {
  if (!plan) return "";
  const parts = [];
  const searches = plan.claim_search_requests;
  if (searches) parts.push(searches === 1 ? t("{count} claim-search read", { count: searches }) : t("{count} claim-search reads", { count: searches }));
  const lists = plan.claim_list_requests;
  if (lists) parts.push(lists === 1 ? t("{count} claim read", { count: lists }) : t("{count} claim reads", { count: lists }));
  const gets = plan.claim_get_requests;
  if (gets) parts.push(gets === 1 ? t("{count} claim status read", { count: gets }) : t("{count} claim status reads", { count: gets }));
  const patches = plan.claim_patch_requests;
  if (patches) parts.push(patches === 1 ? t("{count} status call", { count: patches }) : t("{count} status calls", { count: patches }));
  const assets = plan.asset_requests;
  if (assets) parts.push(assets === 1 ? t("{count} asset read", { count: assets }) : t("{count} asset reads", { count: assets }));
  const videos = plan.video_metadata_requests;
  if (videos) parts.push(videos === 1 ? t("{count} video read", { count: videos }) : t("{count} video reads", { count: videos }));
  const duration = formatDurationMs(plan.duration_ms);
  if (duration) parts.push(duration);
  return parts.join(" · ");
}

/** Tooltip of a "Select all …" button: explains why it is disabled (filters hide the rows / all picked already); `kind` is "releasable" | "activatable". */
function selectAllTitle(kind, inView, addable, t) {
  if (kind === "releasable") {
    if (!inView) return t("No releasable claim in the current view");
    if (!addable) return t("Every releasable claim in view is already selected");
    return t("Add the releasable claims of the current view to the selection");
  }
  if (!inView) return t("No activatable claim in the current view");
  if (!addable) return t("Every activatable claim in view is already selected");
  return t("Add the activatable claims of the current view to the selection");
}

function LoadingRows() {
  const { t } = useI18n();
  return (
    <div className="space-y-3 p-5" role="status" aria-live="polite">
      <p className="inline-flex items-center gap-2 text-sm font-bold text-slate-500">
        <Spinner size={16} /> {t("Searching the selected CMS networks…")}
      </p>
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="h-12 animate-pulse rounded-2xl bg-slate-100" />
      ))}
    </div>
  );
}

/**
 * Right column of the "Check claims" tab: stat tiles, toolbar (quick filter, status chips,
 * grouping, selection, CSV export, release / activate), server messages and the claims table.
 * Filtering, sorting and pagination are client-side; selection lives in the page. One selection
 * feeds two bulk buttons: Release takes its active / pending / potential rows, Activate its
 * potential / inactive rows (`onActivateClaims`: confirm + reinstate in one run).
 */
export default function ResultsPanel({
  result,
  claims,
  status,
  error,
  loading,
  limits,
  selection,
  grouped,
  onGroupedChange,
  busy,
  onOpenDetail,
  onReleaseClaims,
  onActivateClaims,
  onRecheckClaim,
  onReinstateClaim,
  onConfirmClaim,
  recheckingKeys,
  activatingKeys,
  onRetrySearch,
  showToast
}) {
  const { t, tm } = useI18n();
  const [quick, setQuick] = useState("");
  const debouncedQuick = useDebouncedValue(quick, QUICK_FILTER_DEBOUNCE_MS);
  const [statusFilter, setStatusFilter] = useState([]);
  const [sort, setSort] = useState(null);
  const [page, setPage] = useState(1);

  // A new search result resets the client-side view (state adjusted during render).
  const [prevResult, setPrevResult] = useState(result);
  if (prevResult !== result) {
    setPrevResult(result);
    setPage(1);
    setStatusFilter([]);
    setQuick("");
    setSort(null);
  }

  // One per-run limit for both writes (release and activate send batches of the same size).
  const maxSelectable = Number(limits?.max_release_items) || DEFAULT_LIMITS.max_release_items;
  const videos = useMemo(() => (Array.isArray(result?.videos) ? result.videos : []), [result]);
  const hasFilter = Boolean(debouncedQuick.trim()) || statusFilter.length > 0;
  const counts = useMemo(() => countByStatus(claims), [claims]);
  const filtered = useMemo(() => filterClaims(claims, { query: debouncedQuick, statuses: statusFilter }), [claims, debouncedQuick, statusFilter]);
  const sorted = useMemo(() => sortClaims(filtered, sort), [filtered, sort]);
  const releasableCount = useMemo(() => claims.filter(isReleasable).length, [claims]);
  const activatableCount = useMemo(() => claims.filter(isActivatable).length, [claims]);
  const effectiveGrouped = Boolean(grouped) || (claims.length === 0 && videos.length > 0);
  const flatPage = useMemo(() => paginate(sorted, page, PAGE_SIZE), [sorted, page]);
  const groupPages = useMemo(
    () => (effectiveGrouped ? paginateGroups(groupClaimsByVideo(sorted, videos, { includeEmpty: !hasFilter }), PAGE_SIZE) : null),
    [effectiveGrouped, sorted, videos, hasFilter]
  );

  let pagination;
  let pageGroups = null;
  if (groupPages) {
    const safePage = Math.min(Math.max(1, page), groupPages.length);
    pageGroups = groupPages[safePage - 1] || [];
    const groupTotal = groupPages.reduce((sum, groupsOfPage) => sum + groupsOfPage.length, 0);
    const tally = { claims: sorted.length, videos: groupTotal };
    const claimsInVideos =
      sorted.length === 1
        ? groupTotal === 1
          ? t("{claims} claim in {videos} video", tally)
          : t("{claims} claim in {videos} videos", tally)
        : groupTotal === 1
          ? t("{claims} claims in {videos} video", tally)
          : t("{claims} claims in {videos} videos", tally);
    const onThisPage =
      groupPages.length > 1 ? (pageGroups.length === 1 ? t("{count} video on this page", { count: pageGroups.length }) : t("{count} videos on this page", { count: pageGroups.length })) : "";
    pagination = {
      page: safePage,
      pageCount: groupPages.length,
      summary: [claimsInVideos, onThisPage].filter(Boolean).join(" · ")
    };
  } else {
    const range = { start: flatPage.start, end: flatPage.end, total: flatPage.total };
    pagination = {
      page: flatPage.page,
      pageCount: flatPage.pageCount,
      summary: flatPage.total ? (flatPage.total === 1 ? t("Showing {start}–{end} of {total} claim", range) : t("Showing {start}–{end} of {total} claims", range)) : t("No claims")
    };
  }

  const serverErrors = Array.isArray(result?.errors) ? result.errors : [];
  const invalid = Array.isArray(result?.invalid) ? result.invalid : [];
  // The backend copies every network error into videos[].errors as well, so only the top-level list is counted.
  const errorCount = serverErrors.length;
  const videosMode = result?.mode === "videos";
  // Outside the videos mode nothing was "requested": the tile counts the distinct videos the claims sit on.
  const distinctVideos = useMemo(() => new Set(claims.map((claim) => claim.video_id).filter(Boolean)).size, [claims]);
  const videosTotal = videosMode ? Number(result?.totals?.videos ?? videos.length) || 0 : distinctVideos;
  const selectedCount = selection.count;
  const planText = requestPlanText(result?.request_plan, t);
  // Releasable / activatable rows of the current view (filters applied, every page), and those of them not selected yet.
  const releasableKeysInView = useMemo(() => selectReleasableKeys(sorted).keys, [sorted]);
  const activatableKeysInView = useMemo(() => selectActivatableKeys(sorted).keys, [sorted]);
  const addableReleasable = useMemo(() => releasableKeysInView.filter((key) => !selection.selected.has(key)), [releasableKeysInView, selection.selected]);
  const addableActivatable = useMemo(() => activatableKeysInView.filter((key) => !selection.selected.has(key)), [activatableKeysInView, selection.selected]);
  // The selected rows and what each bulk button can take of them. A potential row suits both buttons;
  // an active / pending row only Release, an inactive (released) row only Activate.
  const selectedClaims = useMemo(() => claims.filter((claim) => selection.selected.has(claimKey(claim))), [claims, selection.selected]);
  const selectedStats = useMemo(() => {
    const stats = { releasable: 0, activatable: 0, releaseOnly: 0, activateOnly: 0 };
    selectedClaims.forEach((claim) => {
      const releasable = isReleasable(claim);
      const activatable = isActivatable(claim);
      if (releasable) stats.releasable += 1;
      if (activatable) stats.activatable += 1;
      if (releasable && !activatable) stats.releaseOnly += 1;
      if (activatable && !releasable) stats.activateOnly += 1;
    });
    return stats;
  }, [selectedClaims]);
  // Say so when the selection mixes rows only one of the two buttons can take.
  const mixedReleaseOnly = selectedStats.releaseOnly > 0 && selectedStats.activatable > 0;
  const mixedActivateOnly = selectedStats.activateOnly > 0 && selectedStats.releasable > 0;

  function toggleRow(claim) {
    const key = claimKey(claim);
    if (!selection.selected.has(key) && selectedCount >= maxSelectable) {
      showToast(t("A run can include at most {max} claims. Release or activate the current selection first.", { max: maxSelectable }), "warning", 5000);
      return;
    }
    selection.toggle(key);
  }

  function toggleKeys(keys, checked) {
    if (!checked) {
      selection.remove(keys);
      return;
    }
    const missing = keys.filter((key) => !selection.selected.has(key));
    const room = Math.max(0, maxSelectable - selectedCount);
    if (missing.length > room) {
      showToast(t("Only {room} more claims fit in this run (limit {max}). Release or activate the current selection first.", { room, max: maxSelectable }), "warning", 5000);
      selection.add(missing.slice(0, room));
      return;
    }
    selection.add(missing);
  }

  /**
   * "Select all releasable" / "Select all activatable": union with the current selection (never drops
   * what the operator picked by hand), capped at the per-run limit. `kind` ("releasable" | "activatable")
   * words the toasts (releasable / Release, activatable / Activate).
   */
  function selectAll(addable, kind) {
    const releasable = kind === "releasable";
    const room = Math.max(0, maxSelectable - selectedCount);
    const added = addable.slice(0, room);
    if (added.length) selection.add(added);
    if (addable.length > room) {
      const params = { added: added.length, total: addable.length, max: maxSelectable };
      let text;
      if (!added.length) {
        text = releasable
          ? t("The selection is full ({max} claims per run). Release it, then select the rest.", params)
          : t("The selection is full ({max} claims per run). Activate it, then select the rest.", params);
      } else if (releasable) {
        text =
          addable.length === 1
            ? t("Added {added} of {total} releasable claim: a run can include at most {max} claims. Release them, then select the rest.", params)
            : t("Added {added} of {total} releasable claims: a run can include at most {max} claims. Release them, then select the rest.", params);
      } else {
        text =
          addable.length === 1
            ? t("Added {added} of {total} activatable claim: a run can include at most {max} claims. Activate them, then select the rest.", params)
            : t("Added {added} of {total} activatable claims: a run can include at most {max} claims. Activate them, then select the rest.", params);
      }
      showToast(text, "warning", 6000);
    } else {
      const params = { count: added.length, total: selectedCount + added.length };
      let text;
      if (releasable) {
        text = added.length === 1 ? t("Selected {count} more releasable claim ({total} in total)", params) : t("Selected {count} more releasable claims ({total} in total)", params);
      } else {
        text = added.length === 1 ? t("Selected {count} more activatable claim ({total} in total)", params) : t("Selected {count} more activatable claims ({total} in total)", params);
      }
      showToast(text, "success");
    }
  }

  function exportCsv() {
    if (!sorted.length) return;
    // The header row is translated at export time; the cell values stay as the helper builds them.
    const [header, ...rows] = claimsToCsvRows(sorted);
    downloadTextFile(`${CSV_BOM}${rowsToCsv([header.map((cell) => t(cell)), ...rows])}`, `claims-${todayStamp()}.csv`, "text/csv;charset=utf-8");
    showToast(sorted.length === 1 ? t("Exported {count} claim to CSV", { count: sorted.length }) : t("Exported {count} claims to CSV", { count: sorted.length }), "success");
  }

  function releaseSelected() {
    onReleaseClaims(selectedClaims.filter(isReleasable));
  }

  function activateSelected() {
    onActivateClaims(selectedClaims.filter(isActivatable));
  }

  function clearFilters() {
    setQuick("");
    setStatusFilter([]);
    setPage(1);
  }

  /** The X inside the quick-filter input: the text only, the status chips stay. */
  function clearQuick() {
    setQuick("");
    setPage(1);
  }

  let body;
  if (loading && !claims.length) {
    body = <LoadingRows />;
  } else if (status === "idle") {
    body = (
      <EmptyState
        icon={FileSearch}
        title={t("Search for claims")}
        description={t("Pick your CMS networks, paste video links, asset IDs or claim IDs on the left and press Search (Ctrl+Enter).")}
        className="m-4"
      />
    );
  } else if (status === "error" && !claims.length) {
    body = <EmptyState compact icon={TriangleAlert} title={t("The search did not complete")} description={t("Fix the problem above and search again.")} className="m-4" />;
  } else if (!claims.length && !videos.length) {
    body = <EmptyState compact icon={ListChecks} title={t("No claims found")} description={t("The selected CMS own no claim matching this search.")} className="m-4" />;
  } else if (!sorted.length && hasFilter) {
    body = (
      <EmptyState
        compact
        icon={Search}
        title={t("No claims match the filters")}
        description={t("Try another text or status.")}
        action={
          <Button size="sm" variant="secondary" icon={X} onClick={clearFilters}>
            {t("Clear filters")}
          </Button>
        }
        className="m-4"
      />
    );
  } else {
    body = (
      <ClaimsTable
        rows={flatPage.items}
        groups={pageGroups}
        grouped={effectiveGrouped}
        selection={selection}
        onToggleRow={toggleRow}
        onToggleKeys={toggleKeys}
        sort={sort}
        onSort={(key) => {
          setSort((current) => toggleSort(current, key));
          setPage(1);
        }}
        busy={busy || loading}
        dimmed={loading}
        onOpenDetail={onOpenDetail}
        onRelease={(claim) => onReleaseClaims([claim])}
        onRecheck={onRecheckClaim}
        onReinstate={onReinstateClaim}
        onConfirm={onConfirmClaim}
        recheckingKeys={recheckingKeys}
        activatingKeys={activatingKeys}
        pagination={pagination}
        onPageChange={setPage}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {/* auto-fit: the results column is only ~560 px wide at xl, where fixed columns truncated the values. */}
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        <StatTile label={t("Videos")} value={formatNumber(videosTotal)} hint={videosMode ? t("Requested videos") : t("Distinct videos in the results")} tone="slate" icon={Video} />
        <StatTile
          label={t("Claims")}
          value={formatNumber(claims.length)}
          hint={hasFilter ? t("{count} match the filters", { count: filtered.length }) : t("Across the selected CMS")}
          tone="blue"
          icon={ListChecks}
        />
        <StatTile label={t("Releasable")} value={formatNumber(releasableCount)} hint={t("Active, pending or potential, allowed for you")} tone="emerald" icon={Unlock} />
        <StatTile label={t("Activatable")} value={formatNumber(activatableCount)} hint={t("Potential or released, allowed for you")} tone="indigo" icon={CircleCheckBig} />
        <StatTile label={t("Selected")} value={formatNumber(selectedCount)} hint={t("of {max} per run", { max: formatNumber(maxSelectable) })} tone="indigo" icon={SquareCheckBig} />
        <StatTile label={t("Errors")} value={formatNumber(errorCount)} hint={errorCount ? t("See the messages below") : t("No CMS error")} tone={errorCount ? "red" : "slate"} icon={TriangleAlert} />
      </div>

      {error && (
        <InlineMessage
          tone="error"
          actions={
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={onRetrySearch}>
              {t("Retry")}
            </Button>
          }
        >
          {tm(error)}
        </InlineMessage>
      )}

      {serverErrors.length > 0 && (
        <InlineMessage tone="warning" title={t("Some CMS could not be read completely")}>
          <ul className="mt-1 space-y-0.5">
            {serverErrors.map((item, index) => (
              <li key={`${item.network_id}-${item.scope}-${index}`}>
                <span className="font-black">{item.network_name || `CMS ${item.network_id}`}</span>
                {item.scope ? ` · ${t(SEARCH_ERROR_SCOPE_LABELS[item.scope] || item.scope)}` : ""}: {tm(item.message)}
              </li>
            ))}
          </ul>
        </InlineMessage>
      )}

      {invalid.length > 0 && (
        <InlineMessage
          tone="warning"
          title={invalid.length === 1 ? t("{count} input skipped by the server", { count: invalid.length }) : t("{count} inputs skipped by the server", { count: invalid.length })}
        >
          <div className="mt-1 flex flex-wrap gap-1">
            {invalid.map((value, index) => (
              <span key={`${value}-${index}`} className="max-w-full truncate rounded-lg bg-white/70 px-2 py-0.5 font-mono text-[11px]" title={value}>
                {value}
              </span>
            ))}
          </div>
        </InlineMessage>
      )}

      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="space-y-3 border-b border-slate-100 p-4">
          <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
            <div className="relative flex-1 2xl:max-w-md">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <TextInput
                value={quick}
                aria-label={t("Quick filter")}
                placeholder={t("Filter by claim, video, asset, title, ISRC, UPC or label…")}
                className="pl-11 pr-10"
                onChange={(event) => {
                  setQuick(event.target.value);
                  setPage(1);
                }}
              />
              {quick && (
                <button
                  type="button"
                  aria-label={t("Clear quick filter")}
                  title={t("Clear the text filter")}
                  onClick={clearQuick}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-800"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div data-claims-toolbar className="flex flex-wrap items-center gap-2">
              <Toggle size="sm" checked={effectiveGrouped} disabled={claims.length === 0 && videos.length > 0} onChange={onGroupedChange} label={t("Group by video")} className="mr-1" />
              <Button
                size="sm"
                variant="secondary"
                icon={SquareCheckBig}
                disabled={busy || !addableReleasable.length}
                title={selectAllTitle("releasable", releasableKeysInView.length, addableReleasable.length, t)}
                onClick={() => selectAll(addableReleasable, "releasable")}
              >
                {t("Select all releasable")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={CircleCheckBig}
                disabled={busy || !addableActivatable.length}
                title={selectAllTitle("activatable", activatableKeysInView.length, addableActivatable.length, t)}
                onClick={() => selectAll(addableActivatable, "activatable")}
              >
                {t("Select all activatable")}
              </Button>
              <Button size="sm" variant="secondary" icon={X} disabled={busy || !selectedCount} onClick={selection.clear}>
                {t("Clear selection")}
              </Button>
              <Button size="sm" variant="secondary" icon={Download} disabled={!sorted.length} onClick={exportCsv} title={t("Export the filtered rows (all pages)")}>
                {t("Export CSV")}
              </Button>
              <ReleaseButton size="sm" icon={Unlock} disabled={busy || !selectedStats.releasable} title={t("Set the selected active, pending or potential claims to inactive")} onClick={releaseSelected}>
                {t("Release selected ({count})", { count: selectedStats.releasable })}
              </ReleaseButton>
              <Button
                size="sm"
                variant="indigo"
                icon={Zap}
                disabled={busy || !selectedStats.activatable}
                title={t("Confirm the selected potential claims and reinstate the selected released claims (set them active)")}
                onClick={activateSelected}
              >
                {t("Activate selected ({count})", { count: selectedStats.activatable })}
              </Button>
            </div>
          </div>

          {(mixedReleaseOnly || mixedActivateOnly) && (
            <div className="space-y-0.5 text-[11px] text-slate-500">
              {mixedReleaseOnly && (
                <p>
                  {selectedStats.releaseOnly === 1
                    ? t("{count} selected claim can only be released: Activate cannot take it.", { count: selectedStats.releaseOnly })
                    : t("{count} selected claims can only be released: Activate cannot take them.", { count: selectedStats.releaseOnly })}
                </p>
              )}
              {mixedActivateOnly && (
                <p>
                  {selectedStats.activateOnly === 1
                    ? t("{count} selected claim can only be activated: Release cannot take it.", { count: selectedStats.activateOnly })
                    : t("{count} selected claims can only be activated: Release cannot take them.", { count: selectedStats.activateOnly })}
                </p>
              )}
            </div>
          )}

          {claims.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip
                active={!statusFilter.length}
                tone="slate"
                count={claims.length}
                onClick={() => {
                  setStatusFilter([]);
                  setPage(1);
                }}
              >
                {t("All")}
              </Chip>
              {orderedStatuses(counts).map((statusKey) => (
                <Chip
                  key={statusKey}
                  active={statusFilter.includes(statusKey)}
                  count={counts[statusKey]}
                  onClick={() => {
                    setStatusFilter(toggleInList(statusFilter, statusKey));
                    setPage(1);
                  }}
                >
                  {t(statusLabel(statusKey))}
                </Chip>
              ))}
              {planText && (
                <span className="ml-auto text-[11px] font-bold text-slate-400" title={t("Requests made for this search")}>
                  {planText}
                </span>
              )}
            </div>
          )}
        </div>
        {body}
      </section>
    </div>
  );
}
