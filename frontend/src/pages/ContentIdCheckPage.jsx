import { useSystemSettings } from "../context/SystemSettingsContext";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Download, Music2, PackageSearch, Search } from "lucide-react";
import { exportSelectedAssets, getAssetOwnership, searchArtistAssets } from "../api/assetCheckApi";
import PaginationFooter from "../components/PaginationFooter";
import { useI18n } from "../context/I18nContext";
import { useAuth } from "../context/AuthContext";
import { tk } from "../i18n/index.js";
import { Button, CopyButton, EmptyState, Field, InlineMessage, Modal, Select, Spinner, TextInput } from "./assetDelivery/shared";
import { downloadBlob, formatDateTime } from "./assetDelivery/utils";
import { useClaimAccounts } from "./claimManager/hooks";
import { KeyValueList } from "./claimManager/shared";
import { requestMessage } from "./claimManager/utils";

const RIGHTS_LABELS = {
  general: tk("General ownership"),
  mechanical: tk("Mechanical rights"),
  performance: tk("Performance rights"),
  synchronization: tk("Synchronization rights")
};

const ASSET_TYPE_LABELS = {
  sound_recording: tk("Sound recording"),
  music_video: tk("Music video"),
  art_track_video: tk("Art Track"),
  composition: tk("Composition"),
  web: tk("Web video"),
  movie: tk("Movie"),
  episode: tk("TV episode")
};

function readableType(type, tm) {
  return type ? tm(ASSET_TYPE_LABELS[type] || type.replaceAll("_", " ")) : "—";
}

function AssetOwnershipModal({ item, networkId, onClose }) {
  const { t, tm } = useI18n();
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    getAssetOwnership(networkId, item.id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDetail({ data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDetail({ error: requestMessage(error) });
      });
    return () => controller.abort();
  }, [item.id, networkId]);

  const asset = detail?.data?.asset;
  const owners = detail?.data?.owners || [];
  const isrcs = [...new Set([...item.isrcs, asset?.isrc].filter(Boolean))];
  const metadata = [
    [t("Asset ID"), item.id],
    [t("Type"), readableType(asset?.type || item.type, tm)],
    [t("Artist"), asset?.artists.join(", ")],
    [t("ISRC"), isrcs.join(", ")],
    [t("Custom ID"), asset?.custom_id || item.custom_id],
    [t("UPC"), asset?.upc],
    [t("Album"), asset?.album],
    [t("Record label"), asset?.record_label],
    [t("Labels"), asset?.labels.join(", ")],
    [t("Created"), formatDateTime(asset?.created_at || item.created_at)]
  ].filter(([, value]) => value && value !== "—");

  return (
    <Modal open size="lg" title={asset?.title || item.title || item.id} subtitle={t("Asset ownership")} onClose={onClose}
      footer={<div className="flex justify-end"><Button variant="secondary" onClick={onClose}>{t("Close")}</Button></div>}
    >
      <div className="space-y-5">
        <KeyValueList items={metadata.map(([label, value]) => ({ label, value }))} />
        <section className="space-y-3 border-t border-slate-200 pt-4">
          <h3 className="font-black text-slate-900">{t("Effective ownership")}</h3>
          {!detail && <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Spinner />{t("Loading…")}</p>}
          {detail?.error && <InlineMessage tone="error">{tm(detail.error)}</InlineMessage>}
          {detail?.data && owners.length === 0 && <p className="text-sm text-slate-600">{t("YouTube did not return effective ownership for this asset.")}</p>}
          {owners.map((owner) => (
            <article key={owner.owner_id} className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
              <div>
                <p className="break-words font-bold text-slate-900">{owner.name || owner.owner_id}</p>
                {owner.name && <p className="break-all font-mono text-xs text-slate-500">{owner.owner_id}</p>}
              </div>
              {owner.email ? (
                <div className="flex flex-wrap items-center gap-2">
                  <a className="break-all text-blue-700 underline" href={`mailto:${encodeURIComponent(owner.email).replace("%40", "@")}`}>{owner.email}</a>
                  <CopyButton text={owner.email} label={t("Copy email")} iconOnly />
                </div>
              ) : (
                <p className="text-slate-600">{owner.contact_error ? tm(owner.contact_error) : t("YouTube did not provide a contact email.")}</p>
              )}
              {owner.rights.map((right, index) => (
                <details key={`${right.type}-${index}`} className="rounded-lg bg-slate-50 px-2 py-1.5">
                  <summary className="cursor-pointer font-semibold text-slate-700">
                    {t(RIGHTS_LABELS[right.type])} · {right.exclude
                      ? (right.territories.length ? t("Excluded territories ({count})", { count: right.territories.length }) : t("Worldwide"))
                      : t("Territories ({count})", { count: right.territories.length })}
                  </summary>
                  <p className="mt-1 break-words text-xs text-slate-600">{right.territories.join(", ")}</p>
                </details>
              ))}
            </article>
          ))}
        </section>
      </div>
    </Modal>
  );
}

export default function ContentIdCheckPage() {
  const { isSidebarVisible } = useSystemSettings();
  const showOwnership = isSidebarVisible("/content-id/check#detail");
  const { t, tm, language } = useI18n();
  const { isAdmin } = useAuth();
  const accounts = useClaimAccounts();
  const networks = accounts.accounts.filter((account) => account.has_partner_scope);
  const [selectedNetwork, setSelectedNetwork] = useState("");
  const [artist, setArtist] = useState("");
  const [filters, setFilters] = useState({ scope: "all", type: "" });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [allMatching, setAllMatching] = useState(false);
  const [markedIds, setMarkedIds] = useState(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportProgress, setExportProgress] = useState(null);
  const exportRef = useRef(null);
  const searchRef = useRef(null);
  const cacheRef = useRef(null);
  const pageSizeRef = useRef(100);
  const networkId = networks.find((network) => String(network.id) === selectedNetwork)?.id || networks[0]?.id;

  useEffect(() => () => {
    searchRef.current?.abort();
    exportRef.current?.abort();
  }, []);

  async function showPage(cache, requestedPage) {
    searchRef.current?.abort();
    const controller = new AbortController();
    searchRef.current = controller;
    const pageSize = pageSizeRef.current;
    setLoading(true);
    setError(null);
    try {
      while (cache.nextToken !== null && cache.items.length < requestedPage * pageSize) {
        const token = cache.nextToken;
        if (cache.usedTokens.has(token)) throw new Error(t("YouTube returned a repeated asset page. Please retry the search."));
        const data = await searchArtistAssets({ ...cache.query, pageToken: token }, controller.signal);
        if (controller.signal.aborted) return;
        for (const item of data.items) {
          if (!cache.ids.has(item.id)) {
            cache.ids.add(item.id);
            cache.items.push(item);
          }
        }
        cache.usedTokens.add(token);
        cache.nextToken = data.next_page_token || null;
        cache.total = cache.exportTotal ?? data.total ?? cache.total;
      }
      const loaded = cache.items.length;
      const more = cache.nextToken !== null;
      const total = more ? Math.max(loaded + 1, cache.total || 0) : loaded;
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
      const start = (page - 1) * pageSize;
      setResult({ query: cache.query, items: cache.items.slice(start, start + pageSize), page, pageSize,
        loaded, total, more, confirmedTotal: !more || cache.exportTotal != null, unknownTotal: more && cache.total == null });
    } catch (err) {
      if (!controller.signal.aborted) setError({
        message: requestMessage(err), page: requestedPage, recovery: err.response?.data?.recovery
      });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function clearSearch() {
    searchRef.current?.abort();
    cacheRef.current = null;
    setLoading(false);
    setError(null);
    exportRef.current?.abort();
    exportRef.current = null;
    setExporting(false);
    setExportProgress(null);
    setExportError("");
    setAllMatching(false);
    setMarkedIds(new Set());
    setSelectedAsset(null);
    setResult(null);
  }

  function runSearch(query) {
    clearSearch();
    const cache = { query, items: [], ids: new Set(), usedTokens: new Set(), nextToken: "", total: null };
    cacheRef.current = cache;
    showPage(cache, 1);
  }
  function submit(event) {
    event.preventDefault();
    if (networkId && artist.trim()) runSearch({ networkId, artist: artist.trim(), ...filters });
  }

  function changeFilters(change) {
    const nextFilters = { ...filters, ...change };
    setFilters(nextFilters);
    if (cacheRef.current?.query.networkId === networkId && cacheRef.current.query.artist === artist.trim()) {
      runSearch({ networkId, artist: artist.trim(), ...nextFilters });
    }
  }

  function isChecked(id) {
    return allMatching !== markedIds.has(id);
  }

  function markItems(items, checked) {
    setMarkedIds((current) => {
      const next = new Set(current);
      for (const item of items) {
        if (checked !== allMatching) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }

  function selectAll(enabled) {
    setAllMatching(enabled);
    setMarkedIds(new Set());
  }

  const selectedCount = allMatching ? Math.max(0, (result?.total || 0) - markedIds.size) : markedIds.size;
  const pageChecked = result?.items.filter((item) => isChecked(item.id)).length || 0;

  async function handleExport() {
    if (!result || !selectedCount || exportRef.current) return;
    const controller = new AbortController();
    exportRef.current = controller;
    setExporting(true);
    setExportProgress({ written: 0 });
    setExportError("");
    try {
      const { artist, scope, type, networkId } = result.query;
      const selection = allMatching
        ? { filter: { artist, scope, type }, excluded_ids: [...markedIds] }
        : { items: cacheRef.current.items.filter((item) => markedIds.has(item.id)) };
      const { blob, written } = await exportSelectedAssets(networkId, selection, language, controller.signal, (progress) => {
        if (!controller.signal.aborted) setExportProgress(progress);
      });
      if (!controller.signal.aborted) {
        const artistName = result.query.artist.replace(/[^\p{L}\p{M}\p{N}._ -]+/gu, "-").slice(0, 100);
        downloadBlob(blob, `assets-${artistName}.xlsx`);
        if (written != null && allMatching && !markedIds.size) {
          cacheRef.current.exportTotal = written;
          cacheRef.current.total = written;
          setResult((current) => current && ({ ...current, total: Math.max(current.loaded, written), confirmedTotal: true, unknownTotal: false }));
        }
        const estimate = allMatching && !result.unknownTotal && selectedCount !== written ? selectedCount : null;
        setExportProgress(written == null ? null : { written, complete: true, estimate });
      }
    } catch (error) {
      if (exportRef.current === controller) {
        setExportProgress(null);
        if (!controller.signal.aborted) setExportError(requestMessage(error));
      }
    } finally {
      if (exportRef.current === controller) {
        exportRef.current = null;
        if (controller.signal.aborted) setExportProgress(null);
        setExporting(false);
      }
    }
  }

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <header>
        <div className="mb-3 inline-flex rounded-2xl bg-indigo-50 p-3 text-indigo-700"><PackageSearch size={24} aria-hidden="true" /></div>
        <h1 className="text-2xl font-black text-slate-900">{t("Check")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("Find assets by artist and view their ownership contacts.")}</p>
      </header>

      <form onSubmit={submit} className="grid items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-2 xl:grid-cols-[1fr_1.4fr_1.4fr_1fr_auto]">
        <Field label={t("CMS")} htmlFor="asset-check-cms">
          <Select id="asset-check-cms" value={networkId || ""} onChange={(event) => { clearSearch(); setSelectedNetwork(event.target.value); }} disabled={accounts.loading || !networks.length}>
            {!networks.length && <option value="">{accounts.loading ? t("Loading…") : "—"}</option>}
            {networks.map((network) => <option value={network.id} key={network.id}>{network.name}</option>)}
          </Select>
        </Field>
        <Field label={t("Artist name")} htmlFor="asset-check-artist">
          <TextInput id="asset-check-artist" value={artist} onChange={(event) => { if (cacheRef.current) clearSearch(); setArtist(event.target.value); }} maxLength={200} required />
        </Field>
        <Field label={t("Asset scope")} htmlFor="asset-check-scope">
          <Select id="asset-check-scope" value={filters.scope} onChange={(event) => changeFilters({ scope: event.target.value })}>
            <option value="all">{t("All assets")}</option>
            <option value="owned">{t("Assets owned by this CMS")}</option>
            <option value="external">{t("Assets outside this CMS")}</option>
          </Select>
        </Field>
        <Field label={t("Asset type")} htmlFor="asset-check-type">
          <Select id="asset-check-type" value={filters.type} onChange={(event) => changeFilters({ type: event.target.value })}>
            <option value="">{t("All types")}</option>
            {Object.entries(ASSET_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </Select>
        </Field>
        <Button type="submit" icon={Search} loading={loading && !result} disabled={!networkId || !artist.trim() || loading}>{t("Search")}</Button>
      </form>

      {accounts.error && <InlineMessage tone="error" actions={<Button variant="secondary" size="sm" onClick={accounts.reload}>{t("Retry")}</Button>}>{tm(accounts.error)}</InlineMessage>}
      {!accounts.loading && !accounts.error && !networks.length && <InlineMessage tone="warning">{t("Connect a CMS with YouTube Partner access to search for assets.")}</InlineMessage>}
      {error && (
        <InlineMessage tone="error" actions={<Button variant="secondary" size="sm" onClick={() => showPage(cacheRef.current, error.page)}>{t("Retry")}</Button>}>
          {tm(error.message)}
          {error.recovery === "restore_oauth_client" && (
            <p className="mt-1 font-medium">
              {isAdmin
                ? t("To keep this connection, configure GOOGLE_PREVIOUS_CLIENT_ID and GOOGLE_PREVIOUS_CLIENT_SECRET with the original client credentials on the API and workers. Reload their configuration, then retry this search.")
                : t("Ask your administrator to restore the original Google OAuth client for this CMS, then retry this search.")}
            </p>
          )}
        </InlineMessage>
      )}
      {loading && !result && <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Spinner />{t("Searching for assets…")}</p>}
      {result && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <h2 className="font-black text-slate-900">{result.query.artist}</h2>
            <p aria-live="polite" className="text-sm text-slate-600">
              {!result.more ? t("Assets found ({count})", { count: result.loaded })
                : result.unknownTotal ? t("Matching assets loaded ({count})", { count: result.loaded })
                : result.confirmedTotal ? t("{loaded} of {total} assets loaded", { loaded: result.loaded, total: result.total })
                : t("{loaded} assets loaded. YouTube reports {total} matches.", { loaded: result.loaded, total: result.total })}
            </p>
          </header>
          {result.items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2">
              <div className="flex flex-wrap items-center gap-3">
                <span aria-live="polite" className="text-sm text-slate-600">
                  {allMatching && result.unknownTotal ? t("All matching assets, except {count}", { count: markedIds.size })
                    : allMatching && !result.confirmedTotal ? t("All matching assets selected (about {count})", { count: selectedCount })
                    : t("Selected assets ({count})", { count: selectedCount })}
                </span>
                <Button size="sm" variant="secondary" disabled={exporting} onClick={() => selectAll(true)}>{t("Select all matching assets")}</Button>
                {selectedCount > 0 && <Button size="sm" variant="ghost" disabled={exporting} onClick={() => selectAll(false)}>{t("Clear selection")}</Button>}
              </div>
              <div className="flex items-center gap-2">
                {exporting && <Button size="sm" variant="secondary" onClick={() => exportRef.current?.abort()}>{t("Cancel")}</Button>}
                <Button size="sm" icon={Download} loading={exporting} disabled={!selectedCount} onClick={handleExport}>{t("Export Excel")}</Button>
              </div>
            </div>
          )}
          {exportError && <InlineMessage tone="error">{tm(exportError)}</InlineMessage>}
          {exportProgress && <p role="status" className="border-b border-slate-100 px-4 py-2 text-sm text-slate-600">
            {exportProgress.complete && exportProgress.estimate != null
              ? t("Exported {count} distinct assets from all pages. The initial selection estimate was {estimate}.", { count: exportProgress.written, estimate: exportProgress.estimate })
              : exportProgress.complete ? t("Exported {count} assets.", { count: exportProgress.written })
              : exportProgress.finalizing ? t("Finishing the Excel file…")
              : exportProgress.written ? t("Assets written to Excel: {count}", { count: exportProgress.written })
              : t("Loading asset details and ownership contacts…")}
          </p>}
          {result.items.length ? (
            <div key={`${result.page}-${result.pageSize}`} className="max-h-[65vh] overflow-auto">
              <table className="w-full min-w-[710px] text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th scope="col" className="w-10 px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={t("Select assets on this page")}
                        title={t("Select assets on this page")}
                        checked={pageChecked === result.items.length}
                        ref={(box) => { if (box) box.indeterminate = pageChecked > 0 && pageChecked < result.items.length; }}
                        disabled={exporting}
                        onChange={(event) => markItems(result.items, event.target.checked)}
                      />
                    </th>
                    {[t("Asset"), t("Type"), t("ISRC"), t("Custom ID"), t("Created")].map((label) => (
                      <th key={label} scope="col" className="px-4 py-3">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.items.map((item) => (
                    <tr key={item.id} className="align-top hover:bg-slate-50">
                      <td className="px-3 py-3">
                        <input type="checkbox" checked={isChecked(item.id)} disabled={exporting}
                          aria-label={t("Select asset {id}", { id: item.id })} onChange={(event) => markItems([item], event.target.checked)} />
                      </td>
                      <td className="px-4 py-3">
                        {showOwnership ? <button type="button" onClick={() => setSelectedAsset({ item, networkId: result.query.networkId })} className="inline-flex items-start gap-1 text-left font-bold text-blue-700 hover:underline">
                          {item.title || item.id}<ArrowUpRight className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
                        </button> : <span className="font-bold">{item.title || item.id}</span>}
                        {item.title && <p className="mt-1 font-mono text-xs text-slate-500">{item.id}</p>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">{readableType(item.type, tm)}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{item.isrcs.length ? item.isrcs.map((isrc) => <div key={isrc}>{isrc}</div>) : "—"}</td>
                      <td className="max-w-56 break-all px-4 py-3 font-mono text-xs">{item.custom_id || "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3">{formatDateTime(item.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState compact icon={Music2} title={t("No assets match these filters.")} />}
          {loading && <p role="status" className="flex items-center gap-2 px-4 py-2 text-sm text-slate-600"><Spinner />{t("Loading page…")}</p>}
          <PaginationFooter tinted total={result.total} unknownTotal={result.unknownTotal} page={result.page} pageSize={result.pageSize}
            onPageSizeChange={(value) => { pageSizeRef.current = value; }}
            onPageChange={(value) => showPage(cacheRef.current, value)} />
        </section>
      )}
      {showOwnership && selectedAsset && <AssetOwnershipModal item={selectedAsset.item} networkId={selectedAsset.networkId} onClose={() => setSelectedAsset(null)} />}
    </main>
  );
}
