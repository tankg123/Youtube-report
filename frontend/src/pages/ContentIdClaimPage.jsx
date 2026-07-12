import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleGauge,
  ExternalLink,
  FileSearch,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  SquareCheckBig,
  Sparkles,
  Unlock
} from "lucide-react";
import {
  listContentIdClaimCmsAccounts,
  releaseContentIdClaims,
  searchContentIdClaims
} from "../api/contentIdClaimsApi";
import { useAuth } from "../context/AuthContext";

const DEFAULT_MAX_RELEASE_ITEMS = 100;
const RELEASE_REQUEST_BATCH_SIZE = 20;

function statusBadge(claim) {
  const status = String(claim.status || "").toLowerCase();
  if (status === "inactive" || status === "released") return "border border-slate-200 bg-slate-100 text-slate-600";
  if (["pending", "release_requested", "release_unknown"].includes(status)) return "border border-amber-200 bg-amber-50 text-amber-700";
  if (status === "active") return "border border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border border-red-200 bg-red-50 text-red-600";
}

function statusLabel(claim) {
  const status = String(claim.status || "").toLowerCase();
  if (status === "inactive" || status === "released") return "Released";
  if (status === "release_requested") return "Release pending";
  if (status === "release_unknown") return "Check status";
  return claim.status || "-";
}

function hasYoutubePartnerScope(account) {
  return String(account.scopes || "").split(/\s+/).includes("https://www.googleapis.com/auth/youtubepartner");
}

function formatAssetLabels(claim) {
  const labels = claim.asset?.labels || [];
  if (!labels.length) return "-";
  return labels.join(", ");
}

function extractVideoId(input) {
  const value = String(input || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  const match = value.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] || null;
}

function countUniqueVideoIds(input) {
  return new Set(
    String(input || "")
      .split(/[\n,\s]+/)
      .map(extractVideoId)
      .filter(Boolean)
  ).size;
}

function errorMessage(error) {
  const status = error.response?.status;
  const reason = error.response?.data?.reason;
  if (status === 429 || ["quotaExceeded", "rateLimitExceeded"].includes(reason)) {
    return "Google quota or rate limit was reached. Wait for Retry-After, then retry only the failed items.";
  }
  if (status === 401) return "The CMS authorization expired. Reconnect this CMS in Settings > Network.";
  if (status === 403) return error.response?.data?.message || "This CMS account is not allowed to manage the requested claims.";
  return error.response?.data?.message || error.message;
}

function formatModifiedTime(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatOrigin(value) {
  if (!value) return "-";
  if (typeof value === "string") return value;
  return value.source || value.type || value.name || Object.values(value).find((item) => typeof item === "string") || "-";
}

function getVideoPreview(video) {
  const metadata = video?.metadata || {};
  return {
    title: metadata.title || video?.videoTitle || video?.videoId || "Untitled video",
    channelTitle: metadata.channel_title || video?.channelTitle || "Unknown channel",
    thumbnail: metadata.thumbnail || video?.thumbnail || "",
    durationText: metadata.duration_text || video?.durationText || "",
    url: metadata.url || video?.videoUrl || ""
  };
}

export default function ContentIdClaimPage() {
  const { isAdmin, isContentIdRole, isClaimManagerRole } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState([]);
  const [videoInput, setVideoInput] = useState("");
  const [includeDetails, setIncludeDetails] = useState(false);
  const [result, setResult] = useState(null);
  const [selectedClaims, setSelectedClaims] = useState({});
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [message, setMessage] = useState("");
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [releaseProgress, setReleaseProgress] = useState(null);
  const searchAbortRef = useRef(null);
  const releaseAbortRef = useRef(null);
  const searchRequestIdRef = useRef(0);

  const selectedCount = Object.values(selectedClaims).filter(Boolean).length;
  const maxReleaseItems = result?.limits?.maxReleaseItems || DEFAULT_MAX_RELEASE_ITEMS;
  const releaseRequestBatchSize = Math.min(RELEASE_REQUEST_BATCH_SIZE, maxReleaseItems);
  const assetDetailsRequired = isClaimManagerRole && !isAdmin && !isContentIdRole;
  const connectedAccounts = accounts.filter((account) => account.status === "connected" && hasYoutubePartnerScope(account));
  const missingScopeAccounts = accounts.filter((account) => account.status === "connected" && !hasYoutubePartnerScope(account));
  const inputVideoCount = useMemo(() => countUniqueVideoIds(videoInput), [videoInput]);
  const selectedConnectedAccounts = connectedAccounts.filter((account) => selectedAccountIds.includes(account.id));
  const estimatedClaimSearchBatches = inputVideoCount
    ? Math.ceil(inputVideoCount / 50) * selectedConnectedAccounts.length
    : 0;

  const selectedReleases = useMemo(() => {
    const claims = [];
    for (const video of result?.videos || []) {
      for (const claim of video.claims || []) {
        const key = `${claim.accountId}:${claim.id}`;
        if (selectedClaims[key] && claim.canRelease) {
          claims.push({
            accountId: claim.accountId,
            claimId: claim.id,
            videoId: claim.videoId || video.videoId,
            assetId: claim.assetId || claim.asset?.id || null
          });
        }
      }
    }
    return claims;
  }, [result, selectedClaims]);

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setError("");
    try {
      const data = await listContentIdClaimCmsAccounts();
      setAccounts(data);
      const connectedIds = data
        .filter((account) => account.status === "connected" && hasYoutubePartnerScope(account))
        .map((account) => account.id);
      setSelectedAccountIds((current) => {
        const validSelection = current.filter((id) => connectedIds.includes(id));
        return validSelection.length ? validSelection : connectedIds;
      });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(loadAccounts, 0);
    return () => window.clearTimeout(timer);
  }, [loadAccounts]);

  useEffect(() => () => {
    searchRequestIdRef.current += 1;
    searchAbortRef.current?.abort();
    releaseAbortRef.current?.abort();
  }, []);

  function toggleAccount(accountId) {
    if (loading || releasing) return;
    setSelectedAccountIds((current) => (
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId]
    ));
  }

  function toggleClaim(claim) {
    if (!claim.canRelease || loading || releasing) return;
    const key = `${claim.accountId}:${claim.id}`;
    if (!selectedClaims[key] && selectedCount >= maxReleaseItems) {
      setWarning(`A release operation can include at most ${maxReleaseItems} claims. Release the current selection first.`);
      return;
    }
    setWarning("");
    setSelectedClaims((current) => ({ ...current, [key]: !current[key] }));
  }

  function selectAllReleasable() {
    const next = {};
    let selected = 0;
    for (const video of result?.videos || []) {
      for (const claim of video.claims || []) {
        if (claim.canRelease && selected < maxReleaseItems) {
          next[`${claim.accountId}:${claim.id}`] = true;
          selected += 1;
        }
      }
    }
    if ((result?.totals?.releasable || 0) > maxReleaseItems) {
      setWarning(`Selected the first ${maxReleaseItems} releasable claims. Release them before selecting the remainder.`);
    } else {
      setWarning("");
    }
    setSelectedClaims(next);
  }

  async function handleSearch(event) {
    event.preventDefault();
    if (loading || releasing) return;
    if (!inputVideoCount) {
      setError("Enter at least one valid YouTube video link or 11-character video ID.");
      return;
    }
    if (inputVideoCount > 50) {
      setError("Use at most 50 unique videos per lookup to protect quota and keep the result responsive.");
      return;
    }
    if (!selectedConnectedAccounts.length) {
      setError("Select at least one connected CMS network.");
      return;
    }

    const requestId = ++searchRequestIdRef.current;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setLoading(true);
    setError("");
    setWarning("");
    setMessage("");
    setSelectedClaims({});
    setResult(null);

    try {
      const data = await searchContentIdClaims({
        videoInput,
        accountIds: selectedAccountIds,
        includeDetails
      }, { signal: controller.signal });
      if (requestId !== searchRequestIdRef.current) return;
      setResult(data);
      const reads = data.requestPlan?.claimSearchRequests ?? data.requestPlan?.claimSearchBatches;
      const summary = `Checked ${data.totals.videos} video(s) across ${data.accounts.length} CMS network(s), found ${data.totals.claims} claim(s) using ${reads} batched claim-search read(s).`;
      if (data.totals.errors) {
        const uniqueErrors = new Map();
        (data.videos || []).flatMap((video) => video.errors || []).forEach((item) => {
          uniqueErrors.set(`${item.accountId}:${item.message}`, `${item.cmsName}: ${item.message}`);
        });
        setWarning(`${summary} Partial lookup: ${[...uniqueErrors.values()].slice(0, 3).join(" ")}`);
      } else {
        setMessage(summary);
      }
    } catch (requestError) {
      if (requestError.code === "ERR_CANCELED" || requestId !== searchRequestIdRef.current) return;
      setError(errorMessage(requestError));
    } finally {
      if (requestId === searchRequestIdRef.current) {
        setLoading(false);
        searchAbortRef.current = null;
      }
    }
  }

  function applyReleaseResults(releaseResults = []) {
    if (!releaseResults.length) return;
    const releaseByKey = new Map(releaseResults.map((item) => [`${item.accountId}:${item.claimId}`, item]));

    setResult((current) => {
      if (!current?.videos) return current;
      let releasable = 0;
      return {
        ...current,
        videos: current.videos.map((video) => {
          const claims = (video.claims || []).map((claim) => {
            const release = releaseByKey.get(`${claim.accountId}:${claim.id}`);
            if (release?.outcomeUnknown) {
              return {
                ...claim,
                status: "release_unknown",
                canRelease: false
              };
            }
            if (!release?.ok) {
              if (claim.canRelease) releasable += 1;
              return claim;
            }
            const releasedClaim = release.claim || {};
            return {
              ...claim,
              ...releasedClaim,
              id: claim.id,
              accountId: claim.accountId,
              videoId: claim.videoId || video.videoId,
              asset: releasedClaim.asset || claim.asset,
              status: release.verified ? releasedClaim.status || "inactive" : "release_requested",
              canRelease: false
            };
          });
          return { ...video, claims, claimCount: claims.length };
        }),
        totals: {
          ...current.totals,
          releasable
        }
      };
    });
  }

  async function handleRelease() {
    if (!selectedReleases.length || loading || releasing) return;
    if (!window.confirm(`Release ${selectedReleases.length} selected claim(s)? This changes status to inactive and cannot be reversed through the API.`)) return;

    releaseAbortRef.current?.abort();
    const controller = new AbortController();
    releaseAbortRef.current = controller;
    setReleasing(true);
    setError("");
    setWarning("");
    setMessage("");
    setReleaseProgress({ completed: 0, total: selectedReleases.length });

    try {
      const releaseResults = [];
      for (let index = 0; index < selectedReleases.length; index += releaseRequestBatchSize) {
        const batch = selectedReleases.slice(index, index + releaseRequestBatchSize);
        const data = await releaseContentIdClaims(batch, { signal: controller.signal });
        const batchResults = data.results || [];
        releaseResults.push(...batchResults);
        applyReleaseResults(batchResults);
        setSelectedClaims((current) => {
          const next = { ...current };
          batchResults
            .filter((item) => item.ok || item.outcomeUnknown)
            .forEach((item) => delete next[`${item.accountId}:${item.claimId}`]);
          return next;
        });
        setReleaseProgress({ completed: Math.min(index + batch.length, selectedReleases.length), total: selectedReleases.length });
      }

      const accepted = releaseResults.filter((item) => item.ok).length;
      const verified = releaseResults.filter((item) => item.ok && item.verified).length;
      const pending = releaseResults.filter((item) => item.ok && !item.verified).length;
      const failed = releaseResults.filter((item) => !item.ok && !item.outcomeUnknown).length;
      const unknown = releaseResults.filter((item) => item.outcomeUnknown).length;
      const retryable = releaseResults.filter((item) => !item.ok && item.retryable && !item.outcomeUnknown).length;
      const retryAfter = releaseResults.find((item) => item.retryAfter)?.retryAfter;
      const summary = [
        verified ? `${verified} verified` : "",
        pending ? `${pending} pending Google status update` : "",
        failed ? `${failed} failed` : ""
      ].filter(Boolean).join(", ");

      if (accepted) {
        setMessage(`Release completed for ${accepted} claim(s).${summary ? ` ${summary}.` : ""} Google response was applied directly; no polling or full re-search was used.`);
      }
      if (failed) {
        const failedMessages = releaseResults
          .filter((item) => !item.ok && !item.outcomeUnknown && item.message)
          .slice(0, 3)
          .map((item) => item.message)
          .join(" ");
        setError(`Release failed for ${failed} claim(s).${failedMessages ? ` ${failedMessages}` : ""}`);
      }
      if (unknown || retryable) {
        setWarning([
          unknown ? `${unknown} claim(s) had an uncertain transport response and were locked. Run a targeted lookup before retrying.` : "",
          retryable ? `${retryable} claim(s) can be retried${retryAfter ? ` after ${retryAfter} seconds` : " later"}.` : ""
        ].filter(Boolean).join(" "));
      }
      if (!accepted && !failed && !unknown) {
        setMessage("No release result was returned.");
      }
    } catch (requestError) {
      if (requestError.code !== "ERR_CANCELED") {
        const timeout = requestError.code === "ECONNABORTED";
        setError(timeout
          ? "The current release batch exceeded the client deadline. Its outcome may be unknown; do not retry immediately. Wait briefly, then run a targeted claim lookup."
          : errorMessage(requestError));
      }
    } finally {
      setReleasing(false);
      setReleaseProgress(null);
      releaseAbortRef.current = null;
    }
  }

  return (
    <div className="claim-manager-page space-y-5 p-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-900/5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-black uppercase text-blue-700">
              <Sparkles size={14} /> Content ID operations
            </p>
            <h1 className="mt-3 text-3xl font-black text-slate-950">Claim Manager</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-500">
              Search claims in CMS-sized batches and release active or pending claims with the official YouTube Content ID API.
            </p>
          </div>
          <button
            type="button"
            onClick={loadAccounts}
            disabled={accountsLoading || loading || releasing}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className={accountsLoading ? "animate-spin" : ""} size={16} /> Refresh CMS
          </button>
        </div>
        {message && <div role="status" aria-live="polite" className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700">{message}</div>}
        {warning && <div role="status" aria-live="polite" className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">{warning}</div>}
        {error && <div role="alert" className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-600">{error}</div>}
      </section>

      <section className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <form onSubmit={handleSearch} className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h2 className="text-lg font-black text-slate-950">Claim lookup</h2>
            <p className="mt-1 text-sm text-slate-500">Choose only the CMS networks required for this lookup.</p>
          </div>

          {!!missingScopeAccounts.length && (
            <div className="space-y-2">
              {missingScopeAccounts.map((account) => (
                <div key={`missing-${account.id}`} className="rounded-2xl border border-red-200 bg-red-50 p-3 text-left">
                  <p className="font-black text-red-700">{account.cms_name}</p>
                  <p className="mt-1 text-xs font-bold text-red-600">
                    Missing YouTube Partner scope. Re-auth this CMS in Settings &gt; Network.
                  </p>
                </div>
              ))}
            </div>
          )}

          {!accountsLoading && !connectedAccounts.length && !missingScopeAccounts.length && (
            <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
              No CMS has been authorized yet.
            </div>
          )}

          {!!connectedAccounts.length && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-black text-slate-800">CMS networks</span>
                <button
                  type="button"
                  disabled={loading || releasing}
                  onClick={() => setSelectedAccountIds(
                    selectedConnectedAccounts.length === connectedAccounts.length
                      ? []
                      : connectedAccounts.map((account) => account.id)
                  )}
                  className="text-xs font-black text-blue-600 hover:underline"
                >
                  {selectedConnectedAccounts.length === connectedAccounts.length ? "Clear all" : "Select all"}
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">Select only the CMS accounts you need; each selected CMS adds one batched lookup per 50 videos.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {connectedAccounts.map((account) => {
                  const selected = selectedAccountIds.includes(account.id);
                  return (
                    <button
                      type="button"
                      key={account.id}
                      aria-pressed={selected}
                      disabled={loading || releasing}
                      onClick={() => toggleAccount(account.id)}
                      className={[
                        "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-black transition",
                        selected
                          ? "border-blue-300 bg-blue-50 text-blue-700 shadow-sm"
                          : "border-slate-200 bg-white text-slate-500 hover:border-blue-200"
                      ].join(" ")}
                    >
                      {selected ? <SquareCheckBig size={15} /> : <Square size={15} />}
                      <span>{account.cms_name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="block">
            <span className="flex items-center justify-between gap-3 text-sm font-black text-slate-800">
              <span>Video links / IDs</span>
              <small className={inputVideoCount > 50 ? "text-red-500" : "text-slate-400"}>{inputVideoCount}/50 unique</small>
            </span>
            <textarea
              value={videoInput}
              disabled={loading || releasing}
              onChange={(event) => setVideoInput(event.target.value)}
              rows={10}
              placeholder={"One video link or video ID per line\nhttps://www.youtube.com/watch?v=VIDEO_ID\nVIDEO_ID"}
              className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
            />
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-white p-3">
            <input
              type="checkbox"
              checked={includeDetails}
              disabled={loading || releasing}
              onChange={(event) => setIncludeDetails(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-blue-600"
            />
            <span>
              <strong className="block text-sm text-slate-800">Load preview and asset details</strong>
              <small className="mt-1 block text-xs leading-5 text-slate-500">Optional. Adds batched YouTube video and asset metadata reads; leave off for the fastest lookup.</small>
              {assetDetailsRequired ? <small className="mt-1 block text-xs font-bold text-amber-600">Fresh asset-label reads are still required to enforce your label permissions.</small> : null}
            </span>
          </label>

          <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3">
            <div className="flex items-center gap-2 text-sm font-black text-blue-700"><CircleGauge size={17} /> Request plan</div>
            <p className="mt-1 text-xs font-bold text-blue-600">
              {inputVideoCount || 0} video(s) × {selectedConnectedAccounts.length} CMS = about {estimatedClaimSearchBatches} batched Content ID lookup(s)
              {includeDetails && inputVideoCount ? ` + ${Math.ceil(inputVideoCount / 50)} YouTube preview read(s)` : ""}
              {assetDetailsRequired ? " + fresh asset-label verification batches for permission checks" : ""}.
            </p>
            <p className="mt-1 text-[11px] text-blue-600/80">This is a request-count estimate, not a quota-unit value; Content ID limits are managed in Google Cloud Console.</p>
          </div>

          <button
            type="submit"
            disabled={loading || releasing || !selectedConnectedAccounts.length || !inputVideoCount || inputVideoCount > 50}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 font-black text-white shadow-lg shadow-blue-900/20 hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : <FileSearch size={18} />} Search claims
          </button>
        </form>

        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-black uppercase text-slate-400">Videos</p>
              <p className="mt-2 text-3xl font-black text-slate-950">{result?.totals?.videos || 0}</p>
            </div>
            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-black uppercase text-slate-400">Claims</p>
              <p className="mt-2 text-3xl font-black text-blue-600">{result?.totals?.claims || 0}</p>
            </div>
            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-black uppercase text-slate-400">Releasable</p>
              <p className="mt-2 text-3xl font-black text-emerald-600">{result?.totals?.releasable || 0}</p>
            </div>
            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-black uppercase text-slate-400">Selected</p>
              <p className="mt-2 text-3xl font-black text-slate-950">{selectedCount}<small className="ml-1 text-sm text-slate-400">/{maxReleaseItems}</small></p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={selectAllReleasable}
                disabled={!result?.totals?.releasable || loading || releasing}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <CheckCircle2 size={16} /> Select all
              </button>
              <button
                type="button"
                onClick={() => setSelectedClaims({})}
                disabled={!selectedCount || loading || releasing}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-black text-slate-700 hover:bg-slate-50"
              >
                Clear selection
              </button>
            </div>
            <button
              type="button"
              onClick={handleRelease}
              disabled={!selectedCount || releasing || loading}
              className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-5 py-2.5 text-sm font-black text-white shadow-lg shadow-red-900/20 hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {releasing ? <Loader2 className="animate-spin" size={17} /> : <Unlock size={17} />}
              {releasing && releaseProgress
                ? `Releasing ${releaseProgress.completed}/${releaseProgress.total}`
                : `Release selected (${selectedCount})`}
            </button>
          </div>

          {releasing && releaseProgress ? (
            <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3" role="status" aria-live="polite">
              <div className="flex items-center justify-between text-xs font-black text-blue-700">
                <span>Processing controlled batches of {releaseRequestBatchSize}</span>
                <span>{releaseProgress.completed}/{releaseProgress.total}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100">
                <div
                  className="h-full rounded-full bg-blue-600 transition-[width] duration-300"
                  style={{ width: `${releaseProgress.total ? (releaseProgress.completed / releaseProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          ) : null}

          <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 p-4">
              <h2 className="text-lg font-black text-slate-950">Claim results</h2>
              {result?.invalid?.length ? (
                <p className="mt-1 text-sm text-red-500">Invalid input skipped: {result.invalid.join(", ")}</p>
              ) : null}
              {result?.metadataError ? (
                <p className="mt-1 text-sm font-bold text-amber-600">
                  Video preview could not be loaded from YouTube Data API: {result.metadataError}
                </p>
              ) : null}
              {result?.requestPlan ? (
                <p className="mt-1 text-xs font-bold text-slate-500">
                  Efficient lookup: {result.requestPlan.claimSearchRequests} claim-search read(s), {result.requestPlan.videoMetadataBatches} preview read(s), {result.requestPlan.assetMetadataBatches || 0} asset batch read(s), {result.requestPlan.assetCacheHits || 0} asset cache hit(s). No per-video polling.
                </p>
              ) : null}
            </div>

            <div className="divide-y divide-slate-100">
              {(result?.videos || []).map((video) => {
                const preview = getVideoPreview(video);
                return (
                  <div key={video.videoId} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex min-w-0 flex-1 gap-3">
                        <a
                          href={preview.url || video.videoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="relative h-16 w-28 flex-none overflow-hidden rounded-xl border border-slate-200 bg-slate-100"
                          title="Watch on YouTube"
                        >
                          {preview.thumbnail ? (
                            <img src={preview.thumbnail} alt={preview.title} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-xs font-black text-slate-400">
                              No image
                            </div>
                          )}
                          {preview.durationText ? (
                            <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-black text-white">
                              {preview.durationText}
                            </span>
                          ) : null}
                        </a>
                        <div className="min-w-0">
                          <a
                            href={preview.url || video.videoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block max-w-4xl break-words text-base font-black text-slate-950 hover:text-blue-700"
                          >
                            {preview.title}
                          </a>
                          <p className="mt-1 text-sm font-bold text-slate-500">{preview.channelTitle}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <a
                              href={preview.url || video.videoUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-black text-amber-600 hover:underline"
                            >
                              Watch on YouTube <ExternalLink size={13} />
                            </a>
                            <span className="font-mono text-xs font-bold text-slate-400">{video.videoId}</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {video.claimCount ? `${video.claimCount} claim(s) owned by this CMS` : "No claim owned by this CMS"}
                          </p>
                        </div>
                      </div>
                      {video.claimCount ? (
                        <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700">
                          <ShieldCheck size={14} /> Owned claim found
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">
                          <ShieldAlert size={14} /> No owned claim
                        </span>
                      )}
                    </div>

                  {video.errors?.length ? (
                    <div className="mt-3 space-y-1 rounded-2xl bg-red-50 p-3 text-xs font-bold text-red-600">
                      {video.errors.map((item) => (
                        <p key={`${video.videoId}-${item.accountId}`}>{item.cmsName}: {item.message}</p>
                      ))}
                    </div>
                  ) : null}

                  {video.claims?.length ? (
                    <div className="mt-4 overflow-auto rounded-2xl border border-slate-200">
                      <table className="min-w-[1080px] w-full text-left text-sm">
                        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                          <tr>
                            <th className="w-12 px-4 py-3">Select</th>
                            <th className="px-4 py-3">Claim</th>
                            <th className="px-4 py-3">CMS owner</th>
                            <th className="px-4 py-3">Asset</th>
                            <th className="px-4 py-3">ISRC</th>
                            <th className="px-4 py-3">UPC</th>
                            <th className="px-4 py-3">Asset Label</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3">Type</th>
                            <th className="px-4 py-3">Modified</th>
                          </tr>
                        </thead>
                        <tbody>
                          {video.claims.map((claim) => {
                            const key = `${claim.accountId}:${claim.id}`;
                            const checked = Boolean(selectedClaims[key]);
                            return (
                              <tr key={key} className="border-t border-slate-100 hover:bg-slate-50">
                                <td className="px-4 py-3">
                                  <button
                                    type="button"
                                    onClick={() => toggleClaim(claim)}
                                    disabled={!claim.canRelease || loading || releasing}
                                    aria-pressed={checked}
                                    aria-label={`${checked ? "Deselect" : "Select"} claim ${claim.id}`}
                                    title={claim.canRelease ? "Select claim for release" : `Status ${claim.status || "unknown"} cannot be released`}
                                    className="text-blue-600 disabled:text-slate-300"
                                  >
                                    {checked ? <SquareCheckBig size={19} /> : <Square size={19} />}
                                  </button>
                                </td>
                                <td className="px-4 py-3">
                                  <p className="font-mono text-xs font-black text-slate-950">{claim.id}</p>
                                  <p className="mt-1 text-xs text-emerald-700">Managed by this CMS</p>
                                </td>
                                <td className="px-4 py-3">
                                  <p className="font-black text-slate-950">{claim.cmsName}</p>
                                </td>
                                <td className="px-4 py-3">
                                  <p className="font-mono text-xs font-black text-slate-700">{claim.assetId || "-"}</p>
                                  <p className="mt-1 max-w-[220px] truncate text-xs text-slate-500" title={claim.asset?.title || ""}>
                                    {claim.asset?.title || "-"}
                                  </p>
                                </td>
                                <td className="px-4 py-3 font-mono text-xs text-emerald-700">{claim.asset?.isrc || "-"}</td>
                                <td className="px-4 py-3 font-mono text-xs text-blue-700">{claim.asset?.upc || "-"}</td>
                                <td className="max-w-[260px] truncate px-4 py-3 text-xs text-slate-600" title={formatAssetLabels(claim)}>
                                  {formatAssetLabels(claim)}
                                </td>
                                <td className="px-4 py-3">
                                  <span className={["rounded-full px-2 py-1 text-xs font-black", statusBadge(claim)].join(" ")}>
                                    {statusLabel(claim)}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-xs text-slate-600">{claim.contentType || formatOrigin(claim.origin)}</td>
                                <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{formatModifiedTime(claim.timeStatusLastModified || claim.timeCreated)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
                );
              })}

              {loading && (
                <div className="flex items-center justify-center gap-3 p-10 text-sm font-bold text-blue-600" role="status">
                  <Loader2 className="animate-spin" size={19} /> Searching selected CMS networks in controlled batches…
                </div>
              )}
              {!loading && !result && <div className="p-10 text-center text-sm text-slate-500">Enter video links or IDs to start claim lookup.</div>}
              {result && !result.videos?.length && <div className="p-10 text-center text-sm text-slate-500">No result.</div>}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
