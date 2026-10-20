import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BadgeCheck, FileSearch, History, RefreshCw, ShieldAlert, ShieldCheck, Undo2 } from "lucide-react";
import { recheckClaims } from "../../api/contentIdClaimsApi";
import { useAuth } from "../../context/AuthContext";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { useLocalStorageState, useToast } from "../assetDelivery/hooks";
import { Button, ConfirmDialog, EmptyState, Field, InlineMessage, TabBar, TextArea, Toast } from "../assetDelivery/shared";
import { EMPTY_FILTERS, MAX_NOTE_LENGTH, STORAGE_KEYS } from "./constants";
import { useActivateClaim, useClaimAccounts, useClaimSearch, useSearchShortcut, useSelection } from "./hooks";
import {
  applyActivateResults,
  applyRecheckResults,
  applyReleaseResults,
  buildRequestPlan,
  buildSearchPayload,
  claimFromHistoryEvent,
  claimKey,
  confirmBlockReason,
  isActivatable,
  isConfirmable,
  isReinstatable,
  isReleasable,
  isSearchMode,
  parseSearchInput,
  recheckToOutcome,
  reconcileNetworkIds,
  reinstateBlockReason,
  requestMessage,
  rowResultAction,
  statusLabel,
  summarizeSearch,
  validateSearch,
  videoTitle
} from "./utils";
import { KeyValueList, LimitedBadge, MonoId, ToneBadge, VideoSummary } from "./shared";
import SearchPanel from "./SearchPanel";
import ResultsPanel from "./ResultsPanel";
import ClaimDetailModal from "./ClaimDetailModal";
import ReleaseDialog from "./ReleaseDialog";
import ReleaseHistoryPanel from "./ReleaseHistoryPanel";

const EMPTY_INPUTS = { videos: "", assets: "", claims: "", explore: "" };

// Outcomes a re-check reports when the write it follows up did go through.
const CONFIRMED_RECHECK_OUTCOMES = ["released", "reinstated", "confirmed"];

/**
 * Copy of the single-claim confirmation dialog per write: reinstate (inactive → active) and confirm
 * (potential → active, Google's "confirming a potential claim"). Both are "activate" writes for the
 * table (one busy set, one results handler) but Google and the audit log know them apart.
 */
const ACTIVATE_ONE_COPY = {
  reinstate: {
    title: tk("Reinstate claim"),
    label: tk("Reinstate"),
    icon: Undo2,
    message: tk("Set claim {id} back to active? The video is claimed again right away and the asset's policy applies to it."),
    logged: tk("Reinstating"),
    refused: tk("the claim is no longer inactive, or the status change is not allowed"),
    placeholder: tk("Reason for the reinstate, ticket number, requester…")
  },
  confirm: {
    title: tk("Confirm claim"),
    label: tk("Confirm"),
    icon: BadgeCheck,
    message: tk("Confirm claim {id} as a valid match? It becomes active right away and the asset's policy applies to the video."),
    logged: tk("Confirming"),
    refused: tk("the claim is no longer potential, or the status change is not allowed"),
    placeholder: tk("Reason for the confirm, ticket number, requester…")
  }
};

/** Toast after a single-claim reinstate / confirm, per outcome: text, tone, duration (`t` / `tm` of the current language). */
function activateToast(claim, action, outcome, message, t, tm) {
  const id = claim.claim_id;
  // A real title is data and stays as it is; only the helper's fallback ("Untitled video") is copy to translate.
  const video = claim.video_title || claim.video?.title || tm(videoTitle(claim));
  if (outcome === "reinstated") return [t("Claim {id} reinstated: active again on {video}", { id, video }), "success", 5000];
  if (outcome === "confirmed") return [t("Claim {id} confirmed: active on {video}", { id, video }), "success", 5000];
  if (outcome === "already_active") return [t("Claim {id} was already active; nothing changed.", { id }), "info", 5000];
  if (outcome === "unknown") return [tm(message) || t("Google did not answer; re-check the claim status before retrying."), "warning", 7000];
  const reason = tm(message) || t("refused by the server");
  return [
    action === "confirm" ? t("Claim {id} was not confirmed: {reason}", { id, reason }) : t("Claim {id} was not reinstated: {reason}", { id, reason }),
    outcome === "failed" ? "error" : "warning",
    7000
  ];
}

/**
 * Claim Manager: "Check claims" (search + release / activate) and "Release history" tabs.
 * This component owns the cross-panel state (CMS selection, mode, inputs, filters,
 * search results, row selection, open dialogs); the panels stay presentational.
 */
export default function ClaimManagerPage() {
  const { canViewSettings } = useAuth();
  const { t, tm } = useI18n();
  const { toast, showToast } = useToast();
  const accounts = useClaimAccounts();
  const search = useClaimSearch();
  const selection = useSelection();
  const activateNoteId = useId();
  // Stable callbacks of the hooks, destructured so the memoized handlers below depend on them only.
  const { run: runSearchRequest, nextPage, previousPage, cancel: cancelSearch, reset: resetSearch, updateClaims } = search;
  const { clear: clearSelection, remove: removeSelected } = selection;

  const [tab, setTab] = useState("check");
  const [historyMounted, setHistoryMounted] = useState(false);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [storedNetworkIds, setStoredNetworkIds] = useLocalStorageState(STORAGE_KEYS.networks, null);
  const [storedMode, setStoredMode] = useLocalStorageState(STORAGE_KEYS.mode, "videos");
  const [storedDetails, setStoredDetails] = useLocalStorageState(STORAGE_KEYS.details, true);
  const [grouped, setGrouped] = useLocalStorageState(STORAGE_KEYS.groupView, false);
  const [filtersOpen, setFiltersOpen] = useLocalStorageState(STORAGE_KEYS.filtersOpen, false);
  const [inputs, setInputs] = useState(EMPTY_INPUTS);
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS }));
  const [attempted, setAttempted] = useState(false);
  // `session` grows on every open so the detail modal remounts (fresh fetch, loading state) even
  // when the same claim is opened again after a release.
  const [detail, setDetail] = useState({ key: "", session: 0 });
  // The open bulk dialog: `{ session, action: "release" | "activate", claims }`; `session` remounts the dialog per run.
  const [write, setWrite] = useState(null);
  const [recheckingKeys, setRecheckingKeys] = useState(() => new Set());
  // Single-claim flow: the claim (a table row, the detail's claim or a row built from a history event),
  // the write ("reinstate" | "confirm"), where it was opened from and its note.
  const [activateTarget, setActivateTarget] = useState(null);
  const [activateNote, setActivateNote] = useState("");
  const writeSessionRef = useRef(0);

  const openDetail = useCallback((claim) => setDetail((current) => ({ key: claimKey(claim), session: current.session + 1 })), []);
  const closeDetail = useCallback(() => setDetail((current) => (current.key ? { ...current, key: "" } : current)), []);

  const mode = isSearchMode(storedMode) ? storedMode : "videos";
  const eligibleAccounts = useMemo(() => accounts.accounts.filter((account) => account.has_partner_scope !== false), [accounts.accounts]);
  const missingScopeAccounts = useMemo(() => accounts.accounts.filter((account) => account.has_partner_scope === false), [accounts.accounts]);
  const selectedNetworkIds = useMemo(
    () => reconcileNetworkIds(storedNetworkIds, eligibleAccounts.map((account) => account.id)),
    [storedNetworkIds, eligibleAccounts]
  );
  const limited = Boolean(accounts.user?.limited);
  const includeDetails = limited || storedDetails !== false;
  const value = inputs[mode] ?? "";
  const parsed = useMemo(() => parseSearchInput(mode, value), [mode, value]);
  // Both texts are shown to the operator (search panel, toast): translated here so a language toggle recomputes them.
  const validation = useMemo(
    () => tm(validateSearch({ mode, networkIds: selectedNetworkIds, parsed, limits: accounts.limits, filters })),
    [mode, selectedNetworkIds, parsed, accounts.limits, filters, tm]
  );
  const plan = useMemo(() => {
    const estimate = buildRequestPlan({ mode, count: parsed.ids.length, networkCount: selectedNetworkIds.length, includeDetails, limits: accounts.limits });
    return { ...estimate, text: tm(estimate.text) };
  }, [mode, parsed.ids.length, selectedNetworkIds.length, includeDetails, accounts.limits, tm]);
  const writing = Boolean(write);
  const detailClaim = useMemo(() => (detail.key ? search.claims.find((claim) => claimKey(claim) === detail.key) || null : null), [detail.key, search.claims]);
  const modalOpen = Boolean(detailClaim) || writing || Boolean(activateTarget);
  // The /networks route (App.jsx) and the cms-auth endpoints behind it are admin-only (canViewSettings).
  const canOpenNetworks = Boolean(canViewSettings);
  const noCms = accounts.loaded && !accounts.loading && !accounts.accounts.length && !accounts.error;

  const runSearch = useCallback(() => {
    if (search.loading || writing) return;
    setAttempted(true);
    if (validation) {
      showToast(validation, "warning", 4000);
      return;
    }
    const payload = buildSearchPayload({ mode, networkIds: selectedNetworkIds, parsed, query: parsed.query, filters, includeDetails });
    clearSelection();
    closeDetail();
    runSearchRequest(payload).then((data) => {
      if (data) showToast(summarizeSearch(data), (data.errors || []).length ? "warning" : "success", 5000);
    });
  }, [search.loading, runSearchRequest, writing, validation, mode, selectedNetworkIds, parsed, filters, includeDetails, clearSelection, closeDetail, showToast]);

  useSearchShortcut(tab === "check" && !modalOpen, runSearch);

  const changePage = useCallback(
    (direction) => {
      clearSelection();
      closeDetail();
      const promise = direction > 0 ? nextPage() : previousPage();
      promise.then((data) => {
        if (data) showToast(summarizeSearch(data), "success", 4000);
      });
    },
    [nextPage, previousPage, clearSelection, closeDetail, showToast]
  );

  const handleClear = useCallback(() => {
    setInputs((current) => ({ ...current, [mode]: "" }));
    setFilters({ ...EMPTY_FILTERS });
    setAttempted(false);
    closeDetail();
    clearSelection();
    resetSearch();
  }, [mode, clearSelection, closeDetail, resetSearch]);

  /** Open the bulk dialog for `action` with the claims it can write (`eligible` filter); `blockedMessage` when none qualifies. */
  const openWrite = useCallback(
    (action, claims, eligible, blockedMessage) => {
      const targets = claims.filter(eligible);
      if (!targets.length) {
        showToast(blockedMessage, "warning");
        return;
      }
      writeSessionRef.current += 1;
      closeDetail();
      setWrite({ session: writeSessionRef.current, action, claims: targets });
    },
    [closeDetail, showToast]
  );

  const openRelease = useCallback((claims) => openWrite("release", claims, isReleasable, t("None of these claims can be released.")), [openWrite, t]);

  /** Bulk activate: potential claims are confirmed and released (inactive) claims reinstated in one run. */
  const openActivate = useCallback(
    (claims) => openWrite("activate", claims, isActivatable, t("None of these claims can be activated: only potential and released claims can.")),
    [openWrite, t]
  );

  /**
   * Table update after every batch of the bulk dialog: released rows turn inactive, activated rows
   * (confirmed or reinstated) turn active. Written rows leave the selection whatever the outcome: their
   * eligibility changed (or they are "Check status" until re-checked), so the operator picks them again on purpose.
   */
  const writeAction = write?.action || "release";
  const handleWriteResults = useCallback(
    (results) => {
      updateClaims((claims) => (writeAction === "activate" ? applyActivateResults(claims, results) : applyReleaseResults(claims, results)));
      removeSelected(results.map((result) => result.key));
      setHistoryRefresh((current) => current + 1);
    },
    [writeAction, updateClaims, removeSelected]
  );

  const handleRecheckResults = useCallback(
    (results) => {
      updateClaims((claims) => applyRecheckResults(claims, results));
      setHistoryRefresh((current) => current + 1);
    },
    [updateClaims]
  );

  const handleActivateOneResults = useCallback(
    (results) => {
      updateClaims((claims) => applyActivateResults(claims, results));
      // A row whose status changed (active now, or "Check status" until re-checked) is no longer what the
      // operator selected it as: drop it from the selection; a refused row keeps its place.
      removeSelected(results.filter((result) => !["failed", "skipped"].includes(result.outcome)).map((result) => result.key));
      setHistoryRefresh((current) => current + 1);
    },
    [updateClaims, removeSelected]
  );

  const { activate, busyKeys: activatingKeys } = useActivateClaim({ onResults: handleActivateOneResults });
  const activateRunning = Boolean(activateTarget) && activatingKeys.has(claimKey(activateTarget.claim));

  // Row-level Re-check for a "Check status" row (release, reinstate or confirm outcome unknown) once the dialog is closed.
  const handleRecheckClaim = useCallback(
    async (claim) => {
      const key = claimKey(claim);
      // The write this re-check follows up decides which status confirms it (inactive after a release, active after a reinstate or a confirm).
      const action = rowResultAction(claim);
      setRecheckingKeys((current) => new Set(current).add(key));
      try {
        const data = await recheckClaims([{ network_id: claim.network_id, claim_id: claim.claim_id }]);
        const results = Array.isArray(data?.results) ? data.results : [];
        handleRecheckResults(results);
        const result = results[0];
        if (!result) {
          showToast(t("No answer from the server for this claim"), "warning");
        } else {
          const outcome = recheckToOutcome(result, { action });
          if (result.in_flight) {
            // The server is still writing this claim: the status read back may be superseded within a minute.
            showToast(tm(outcome.message), "warning", 6000);
          } else if (!result.found) {
            showToast(t("Claim {id}: {message}", { id: claim.claim_id, message: tm(outcome.message) }), "warning", 5000);
          } else {
            const confirmed = CONFIRMED_RECHECK_OUTCOMES.includes(outcome.outcome);
            const status = t(statusLabel(result.status)).toLowerCase();
            showToast(
              confirmed
                ? t("Claim {id} is now {status}", { id: claim.claim_id, status })
                : t("Claim {id} is now {status}: {message}", { id: claim.claim_id, status, message: tm(outcome.message) }),
              confirmed ? "success" : "warning",
              confirmed ? 5000 : 7000
            );
          }
        }
      } catch (error) {
        showToast(t("Re-check failed: {message}", { message: tm(requestMessage(error)) }), "error", 5000);
      } finally {
        setRecheckingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [handleRecheckResults, showToast, t, tm]
  );

  const closeWrite = useCallback(() => {
    setWrite(null);
    // The dialog hands the focus back to the button that opened it. After a run that button is usually
    // disabled ("Release selected (0)": the written rows left the selection) or gone (a row's Release
    // button once the row is inactive), so the keyboard would land on <body> and the next Tab would
    // start from the top of the page: put it on the results toolbar instead.
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      // The quick filter is found by its aria-label, which follows the UI language like the one ResultsPanel renders.
      (document.querySelector("[data-claims-toolbar] button:not(:disabled)") || document.querySelector(`[aria-label="${t("Quick filter")}"]`))?.focus();
    });
  }, [t]);

  /**
   * Open the confirmation for one claim: `action` "reinstate" (an inactive row) or "confirm" (a potential
   * row); `source` (table / detail / history) says where the focus goes back to.
   */
  const openActivateOne = useCallback(
    (claim, action, source = "table") => {
      if (!claim) return;
      const confirm = action === "confirm";
      if (!(confirm ? isConfirmable(claim) : isReinstatable(claim))) {
        showToast(
          tm(confirm ? confirmBlockReason(claim) : reinstateBlockReason(claim)) || (confirm ? t("This claim cannot be confirmed.") : t("This claim cannot be reinstated.")),
          "warning",
          4000
        );
        return;
      }
      closeDetail();
      setActivateNote("");
      setActivateTarget({ claim, action, source });
    },
    [closeDetail, showToast, t, tm]
  );

  const openReinstate = useCallback((claim, source) => openActivateOne(claim, "reinstate", source), [openActivateOne]);
  const openConfirm = useCallback((claim, source) => openActivateOne(claim, "confirm", source), [openActivateOne]);
  const openReinstateFromHistory = useCallback((event) => openReinstate(claimFromHistoryEvent(event), "history"), [openReinstate]);
  const openReinstateFromDetail = useCallback((claim) => openReinstate(claim, "detail"), [openReinstate]);
  const openConfirmFromDetail = useCallback((claim) => openConfirm(claim, "detail"), [openConfirm]);

  const closeActivateOne = useCallback(() => {
    if (activateRunning) return;
    setActivateTarget(null);
  }, [activateRunning]);

  const confirmActivateOne = useCallback(async () => {
    if (!activateTarget || activateRunning) return;
    const { claim, action, source } = activateTarget;
    try {
      const { outcome, message, result } = await activate(claim, action, activateNote.trim());
      const wait = outcome === "failed" && result?.retryable && Number(result?.retry_after) > 0 ? t("Retry after {seconds} s.", { seconds: Math.ceil(Number(result.retry_after)) }) : "";
      const [text, tone, ttl] = activateToast(claim, action, outcome, message, t, tm);
      showToast(wait ? `${text} ${wait}` : text, tone, ttl);
      setActivateTarget(null);
      // The row's Reinstate / Confirm button disappears on success (the active row offers Release only), so
      // the dialog cannot hand the focus back to it: put the keyboard on the row's first control instead.
      if (source === "table") {
        const key = claimKey(claim);
        requestAnimationFrame(() => {
          if (document.activeElement && document.activeElement !== document.body) return;
          document.querySelector(`[data-claim-key="${key}"] button`)?.focus();
        });
      }
    } catch (error) {
      // The request itself was refused (400 / 424 / 429 / 5xx): nothing changed; the dialog stays open to retry or cancel.
      showToast(t("{action} failed: {message}", { action: t((ACTIVATE_ONE_COPY[action] || ACTIVATE_ONE_COPY.reinstate).label), message: tm(error.message) }), "error", 6000);
    }
  }, [activateTarget, activateRunning, activate, activateNote, showToast, t, tm]);

  function changeTab(next) {
    setTab(next);
    if (next === "history") setHistoryMounted(true);
  }

  const tabs = [
    { key: "check", label: t("Check claims"), icon: FileSearch, count: search.claims.length || undefined },
    { key: "history", label: t("Release history"), icon: History }
  ];
  const activateCopy = activateTarget ? ACTIVATE_ONE_COPY[activateTarget.action] || ACTIVATE_ONE_COPY.reinstate : null;

  return (
    <div className="space-y-5 p-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-black uppercase text-blue-700">
              <ShieldCheck size={15} />
              {t("Content ID operations")}
            </p>
            <h1 className="mt-3 text-3xl font-black text-slate-950">{t("Claim Manager")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              {t(
                "Look up the Content ID claims owned by your CMS networks, release active, pending or potential claims, confirm potential ones and reinstate released ones through the official YouTube Partner API. Every status change is recorded in the release history."
              )}
            </p>
          </div>
          <div className="flex flex-col items-start gap-3 xl:items-end">
            <Button variant="secondary" icon={RefreshCw} loading={accounts.loading} onClick={accounts.reload}>
              {t("Refresh CMS")}
            </Button>
            <div className="flex flex-wrap gap-2 xl:justify-end">
              {accounts.loaded && (
                <ToneBadge tone={eligibleAccounts.length ? "emerald" : "slate"} icon={ShieldCheck}>
                  {t("{count} CMS ready", { count: eligibleAccounts.length })}
                </ToneBadge>
              )}
              {missingScopeAccounts.length > 0 && (
                <ToneBadge tone="amber" icon={ShieldAlert}>
                  {t("{count} need re-authorization", { count: missingScopeAccounts.length })}
                </ToneBadge>
              )}
              {limited && <LimitedBadge labels={accounts.user.allowed_labels} />}
            </div>
          </div>
        </div>
        {accounts.error && (
          <InlineMessage
            tone="error"
            className="mt-4"
            actions={
              <Button size="sm" variant="secondary" icon={RefreshCw} loading={accounts.loading} onClick={accounts.reload}>
                {t("Retry")}
              </Button>
            }
          >
            {t("Could not load CMS networks: {error}", { error: tm(accounts.error) })}
          </InlineMessage>
        )}
      </section>

      <TabBar tabs={tabs} active={tab} onChange={changeTab} />

      <div hidden={tab !== "check"}>
        {noCms ? (
          <EmptyState
            icon={ShieldAlert}
            title={t("No connected CMS network")}
            description={
              canOpenNetworks
                ? t("Connect a YouTube CMS (content owner) with the Content ID OAuth in Settings > Network, then come back to check claims.")
                : t("Ask an administrator to connect a YouTube CMS (content owner) with the Content ID OAuth in Settings > Network, then come back to check claims.")
            }
            action={
              canOpenNetworks ? (
                <Link to="/networks" className="inline-flex h-11 items-center gap-2 rounded-2xl bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-700">
                  {t("Open Networks")}
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
            {/* Sticky below the 3.5 rem Topbar; min-w-0 keeps the long textarea lines from widening the column. */}
            <div className="min-w-0 xl:sticky xl:top-[4.5rem] xl:max-h-[calc(100vh-5.5rem)] xl:self-start xl:overflow-y-auto">
              <SearchPanel
                accounts={eligibleAccounts}
                missingScopeAccounts={missingScopeAccounts}
                accountsLoading={accounts.loading}
                accountsLoaded={accounts.loaded}
                canOpenNetworks={canOpenNetworks}
                selectedNetworkIds={selectedNetworkIds}
                onNetworkIdsChange={setStoredNetworkIds}
                mode={mode}
                onModeChange={(next) => {
                  setStoredMode(next);
                  setAttempted(false);
                }}
                value={value}
                onValueChange={(text) => setInputs((current) => ({ ...current, [mode]: text }))}
                filters={filters}
                onFiltersChange={setFilters}
                filtersOpen={Boolean(filtersOpen)}
                onFiltersOpenChange={setFiltersOpen}
                includeDetails={includeDetails}
                onIncludeDetailsChange={setStoredDetails}
                limited={limited}
                limits={accounts.limits}
                parsed={parsed}
                validation={validation}
                attempted={attempted}
                plan={plan}
                loading={search.loading}
                disabled={writing}
                onSearch={runSearch}
                onCancel={cancelSearch}
                onClear={handleClear}
                explore={{
                  visible: Boolean(search.result) && search.result.mode === "explore",
                  hasNext: search.hasNext,
                  hasPrevious: search.hasPrevious,
                  pageIndex: search.pageIndex,
                  onNext: () => changePage(1),
                  onPrevious: () => changePage(-1)
                }}
              />
            </div>
            <ResultsPanel
              result={search.result}
              claims={search.claims}
              status={search.status}
              error={search.error}
              loading={search.loading}
              limits={accounts.limits}
              selection={selection}
              grouped={Boolean(grouped)}
              onGroupedChange={setGrouped}
              busy={writing}
              onOpenDetail={openDetail}
              onReleaseClaims={openRelease}
              onActivateClaims={openActivate}
              onRecheckClaim={handleRecheckClaim}
              onReinstateClaim={openReinstate}
              onConfirmClaim={openConfirm}
              recheckingKeys={recheckingKeys}
              activatingKeys={activatingKeys}
              onRetrySearch={runSearch}
              showToast={showToast}
            />
          </div>
        )}
      </div>

      {historyMounted && (
        <div hidden={tab !== "history"}>
          <ReleaseHistoryPanel
            refreshKey={historyRefresh}
            networks={accounts.accounts}
            showToast={showToast}
            onReinstate={openReinstateFromHistory}
            reinstatingKeys={activatingKeys}
            onRecheckResults={handleRecheckResults}
          />
        </div>
      )}

      {detailClaim && (
        <ClaimDetailModal
          key={detail.session}
          claim={detailClaim}
          onClose={closeDetail}
          onRelease={(claim) => openRelease([claim])}
          onReinstate={openReinstateFromDetail}
          onConfirm={openConfirmFromDetail}
        />
      )}

      {activateTarget && (
        <ConfirmDialog
          open
          size="md"
          tone="indigo"
          title={t(activateCopy.title)}
          confirmLabel={t(activateCopy.label)}
          loading={activateRunning}
          onConfirm={confirmActivateOne}
          onCancel={closeActivateOne}
          message={t(activateCopy.message, { id: activateTarget.claim.claim_id })}
        >
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <VideoSummary claim={activateTarget.claim} />
              <KeyValueList
                className="mt-3"
                items={[
                  { label: t("Claim ID"), value: <MonoId value={activateTarget.claim.claim_id} /> },
                  {
                    label: t("Asset"),
                    value: activateTarget.claim.asset?.title || activateTarget.claim.asset_id || activateTarget.claim.asset?.id ? (
                      <span className="block">
                        {activateTarget.claim.asset?.title && <span className="block">{activateTarget.claim.asset.title}</span>}
                        <MonoId value={activateTarget.claim.asset_id || activateTarget.claim.asset?.id} tone="text-slate-600" />
                      </span>
                    ) : (
                      ""
                    )
                  },
                  { label: t("CMS"), value: activateTarget.claim.network_name || `CMS ${activateTarget.claim.network_id}` }
                ]}
              />
            </div>
            <InlineMessage tone="info" icon={activateCopy.icon}>
              {activateNote.trim()
                ? t("{action} is logged in Release history with your name and note. If Google refuses ({refused}), nothing changes.", {
                    action: t(activateCopy.logged),
                    refused: t(activateCopy.refused)
                  })
                : t("{action} is logged in Release history with your name. If Google refuses ({refused}), nothing changes.", {
                    action: t(activateCopy.logged),
                    refused: t(activateCopy.refused)
                  })}
            </InlineMessage>
            <Field label={t("Note (optional, saved in the release log)")} htmlFor={activateNoteId} hint={`${activateNote.length}/${MAX_NOTE_LENGTH}`}>
              <TextArea
                id={activateNoteId}
                rows={2}
                maxLength={MAX_NOTE_LENGTH}
                value={activateNote}
                disabled={activateRunning}
                placeholder={t(activateCopy.placeholder)}
                onChange={(event) => setActivateNote(event.target.value.slice(0, MAX_NOTE_LENGTH))}
              />
            </Field>
          </div>
        </ConfirmDialog>
      )}

      {write && (
        <ReleaseDialog
          key={write.session}
          action={write.action}
          claims={write.claims}
          limits={accounts.limits}
          onClose={closeWrite}
          onResults={handleWriteResults}
          onRecheckResults={handleRecheckResults}
          showToast={showToast}
        />
      )}

      <Toast id={toast?.id} message={toast?.message} tone={toast?.tone} />
    </div>
  );
}
