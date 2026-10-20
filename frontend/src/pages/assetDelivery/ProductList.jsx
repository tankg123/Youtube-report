import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, CheckCircle2, Disc3, ExternalLink, FileAudio, FileVideo, Film, Layers, Music, Plus, RefreshCw, Search, Trash2, Video, X, XCircle } from "lucide-react";
import PaginationFooter from "../../components/PaginationFooter";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { deleteProduct, listProducts, syncProduct } from "../../api/deliveryApi";
import { Button, ConfirmDialog, EmptyState, InlineMessage, ProgressBar, Select, Spinner, StatTile, StatusBadge, TextInput } from "./shared";
import { PRODUCT_STATUS_META, assetTypeMeta } from "./constants";
import { useDebouncedValue } from "./hooks";
import { cx, formatDateTime, formatNumber, getErrorMessage, truncate } from "./utils";

const EMPTY_SUMMARY = { products: 0, tracks: 0, delivered: 0, completed: 0, errors: 0, taken_down: 0 };

// Wording per page kind: the music page lists releases of Sound Recording assets,
// the video page lists batches of Web / Music video assets. Same table, same actions.
const LIST_COPY = {
  music: {
    countOne: tk("{count} product"),
    countMany: tk("{count} products"),
    productsLabel: tk("Products"),
    productsHint: { all: tk("Releases across all CMS"), named: tk("Releases in «{name}»"), selected: tk("Releases in the selected CMS") },
    itemsLabel: tk("Tracks"),
    itemsHint: { all: tk("Across all products across all CMS"), named: tk("Across all products in «{name}»"), selected: tk("Across all products in the selected CMS") },
    withAssetHint: tk("Tracks with an asset ID"),
    withReferenceHint: tk("Tracks with a reference"),
    attentionHint: tk("Tracks needing attention"),
    productHeader: tk("Product"),
    codeHeader: tk("UPC"),
    mediaHeader: tk("Audio"),
    mediaWord: tk("audio"),
    mediaStoredOne: tk("{stored} of {total} track has audio stored on the server"),
    mediaStoredMany: tk("{stored} of {total} tracks have audio stored on the server"),
    productIcon: Disc3,
    itemIcon: Music,
    mediaIcon: FileAudio,
    untitled: tk("Untitled release"),
    searchPlaceholder: tk("Search title, artist, UPC, ISRC or asset ID…"),
    newLabel: tk("New product"),
    loading: tk("Loading products…"),
    loadError: tk("Could not load products"),
    noMatchTitle: tk("No products match these filters"),
    emptyTitle: tk("No products yet"),
    emptyDescription: tk("Create a release, add its tracks and audio files, then deliver everything straight to YouTube CMS."),
    syncErrorsOne: tk("Synced «{title}» with {count} track error"),
    syncErrorsMany: tk("Synced «{title}» with {count} track errors"),
    deleteMessageOne: tk("«{title}» and its {count} track will be removed from this database, together with any audio files stored on the server."),
    deleteMessageMany: tk("«{title}» and its {count} tracks will be removed from this database, together with any audio files stored on the server."),
    takedownHint: tk("Assets and references already created in YouTube CMS are not deleted. Use Takedown on the product first if you want them deactivated.")
  },
  video: {
    countOne: tk("{count} batch"),
    countMany: tk("{count} batches"),
    productsLabel: tk("Video batches"),
    productsHint: { all: tk("Batches across all CMS"), named: tk("Batches in «{name}»"), selected: tk("Batches in the selected CMS") },
    itemsLabel: tk("Videos"),
    itemsHint: { all: tk("Across all batches across all CMS"), named: tk("Across all batches in «{name}»"), selected: tk("Across all batches in the selected CMS") },
    withAssetHint: tk("Videos with an asset ID"),
    withReferenceHint: tk("Videos with a reference"),
    attentionHint: tk("Videos needing attention"),
    productHeader: tk("Batch"),
    codeHeader: tk("Type"),
    mediaHeader: tk("Files"),
    mediaWord: tk("files"),
    mediaStoredOne: tk("{stored} of {total} video has a video file stored on the server"),
    mediaStoredMany: tk("{stored} of {total} videos have a video file stored on the server"),
    productIcon: Film,
    itemIcon: Video,
    mediaIcon: FileVideo,
    untitled: tk("Untitled batch"),
    searchPlaceholder: tk("Search batch, creator, custom ID or asset ID…"),
    newLabel: tk("New video batch"),
    loading: tk("Loading video batches…"),
    loadError: tk("Could not load video batches"),
    noMatchTitle: tk("No video batches match these filters"),
    emptyTitle: tk("No video batches yet"),
    emptyDescription: tk("Create a batch, upload its video files, then deliver every video as a Web video or Music video asset straight to YouTube CMS."),
    syncErrorsOne: tk("Synced «{title}» with {count} video error"),
    syncErrorsMany: tk("Synced «{title}» with {count} video errors"),
    deleteMessageOne: tk("«{title}» and its {count} video will be removed from this database, together with any video files stored on the server."),
    deleteMessageMany: tk("«{title}» and its {count} videos will be removed from this database, together with any video files stored on the server."),
    takedownHint: tk("Assets and references already created in YouTube CMS are not deleted. Use Takedown on the batch first if you want them deactivated.")
  }
};

function copyFor(kind) {
  return LIST_COPY[kind] || LIST_COPY.music;
}

// The backend summary only honours the CMS filter, so the hints name that scope
// and say so when the status/search filters (which the table applies) are on.
function buildSummaryTiles(copy, scopeKind, scopeName, hasFilters, t) {
  const scoped = (hints) => (scopeKind === "named" ? t(hints.named, { name: scopeName }) : t(hints[scopeKind]));
  const productsHint = scoped(copy.productsHint);
  return [
    { key: "products", label: t(copy.productsLabel), tone: "slate", icon: copy.productIcon, hint: hasFilters ? t("{hint} · status/search filters not applied", { hint: productsHint }) : productsHint },
    { key: "tracks", label: t(copy.itemsLabel), tone: "indigo", icon: copy.itemIcon, hint: scoped(copy.itemsHint) },
    { key: "delivered", label: t("Assets created"), tone: "blue", icon: Layers, hint: t(copy.withAssetHint) },
    { key: "completed", label: t("Delivered"), tone: "emerald", icon: CheckCircle2, hint: t(copy.withReferenceHint) },
    { key: "errors", label: t("Errors"), tone: "red", icon: XCircle, hint: t(copy.attentionHint) },
    { key: "taken_down", label: t("Taken down"), tone: "amber", icon: Ban, hint: t("References deactivated") }
  ];
}

const STATUS_OPTIONS = Object.entries(PRODUCT_STATUS_META).map(([value, meta]) => ({ value, label: meta.label }));

function initialsOf(title) {
  const words = String(title || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function ArtworkThumb({ product }) {
  if (product.artwork_data_url) {
    return <img src={product.artwork_data_url} alt="" className="h-11 w-11 shrink-0 rounded-xl border border-slate-200 object-cover" />;
  }
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-sm font-black text-slate-500">
      {initialsOf(product.title)}
    </span>
  );
}

/** "n/m audio" — how many tracks have their media file stored on the server (list payload `audio_count`). */
function AudioIndicator({ product, kind }) {
  const { t } = useI18n();
  const copy = copyFor(kind);
  const MediaIcon = copy.mediaIcon;
  const total = Number(product.track_count) || 0;
  const hasCount = product.audio_count !== undefined && product.audio_count !== null;
  if (!hasCount) return <span className="text-xs text-slate-400">-</span>;
  const stored = Number(product.audio_count) || 0;
  const toneClass = total > 0 && stored >= total ? "text-emerald-700" : stored > 0 ? "text-amber-700" : "text-slate-400";
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-bold", toneClass)}
      title={t(total === 1 ? copy.mediaStoredOne : copy.mediaStoredMany, { stored, total })}
    >
      <MediaIcon size={14} />
      {stored}/{total}
      <span className="font-medium text-slate-400">{t(copy.mediaWord)}</span>
    </span>
  );
}

function syncTooltip(product, delivered) {
  if (product.status === "delivering") return tk("Fetch status from CMS and finalize an interrupted delivery");
  if (delivered > 0) return tk("Fetch asset and reference status from CMS");
  return tk("Recompute the local status (nothing delivered to CMS yet)");
}

function ProductRow({ product, kind, networkName, busy, onOpen, onSync, onDelete }) {
  const { t, tm } = useI18n();
  const copy = copyFor(kind);
  const total = Number(product.track_count) || 0;
  const delivered = Number(product.delivered_count) || 0;
  const completed = Number(product.completed_count) || 0;
  const errors = Number(product.error_count) || 0;
  const percent = total ? (delivered / total) * 100 : 0;
  const rowBusy = Boolean(busy);

  return (
    <tr
      className={cx("cursor-pointer align-top transition hover:bg-slate-50", rowBusy && "opacity-70")}
      onClick={() => onOpen(product.id)}
    >
      <td className="px-4 py-3">
        <div className="flex items-start gap-3">
          <ArtworkThumb product={product} />
          <div className="min-w-0">
            <span className="block max-w-[280px] truncate font-black text-slate-950" title={product.title || ""}>
              {product.title || t(copy.untitled)}
            </span>
            <span className="block max-w-[280px] truncate text-xs font-bold text-slate-500" title={product.artist || ""}>
              {product.artist || "-"}
            </span>
            {(product.label || product.release_date) && (
              <span className="block max-w-[280px] truncate text-[11px] text-slate-400">
                {[product.label, product.release_date].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        </div>
      </td>
      {/* Music releases show the UPC; video batches show the asset type (Web video / Music video). */}
      <td className={cx("whitespace-nowrap px-4 py-3 text-xs font-bold text-slate-700", kind !== "video" && "font-mono")}>
        {kind === "video" ? t(assetTypeMeta(product.asset_type).label) : product.upc || "-"}
      </td>
      <td className="px-4 py-3">
        <span className="block max-w-[180px] truncate font-bold text-slate-700" title={networkName || ""}>{networkName || "-"}</span>
        {product.content_owner_id && <span className="block font-mono text-[11px] text-slate-400">{product.content_owner_id}</span>}
      </td>
      <td className="px-4 py-3">
        <div className="w-[120px]">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-black text-slate-900">
              {delivered}/{total}
            </span>
            <span className="text-[11px] font-bold text-slate-400">{completed === 1 ? t("{count} ref", { count: completed }) : t("{count} refs", { count: completed })}</span>
          </div>
          <ProgressBar value={percent} size="sm" showValue={false} tone={errors ? "amber" : delivered === total && total > 0 ? "emerald" : "blue"} className="mt-1" />
          {errors > 0 && <span className="mt-1 block text-[11px] font-bold text-red-600">{errors === 1 ? t("{count} error", { count: errors }) : t("{count} errors", { count: errors })}</span>}
        </div>
      </td>
      <td className="px-4 py-3">
        <AudioIndicator product={product} kind={kind} />
      </td>
      <td className="px-4 py-3 text-xs">
        <span className="block max-w-[180px] truncate font-bold text-slate-700" title={product.match_policy_name || ""}>
          {product.match_policy_name || (product.match_policy_id ? t("Policy") : "-")}
        </span>
        {product.match_policy_id && (
          <span className="block max-w-[180px] truncate font-mono text-[11px] text-slate-400" title={product.match_policy_id}>
            {product.match_policy_id}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={product.status} meta={PRODUCT_STATUS_META} />
        {product.status === "error" && product.error_message && (
          <span className="mt-1 block max-w-[200px] text-[11px] font-bold leading-snug text-red-600" title={tm(product.error_message)}>
            {truncate(tm(product.error_message), 90)}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{product.delivered_at ? formatDateTime(product.delivered_at) : "-"}</td>
      <td className="px-4 py-3 text-xs">
        <span className="block font-bold text-slate-600">{product.created_by_name || "-"}</span>
        {product.created_at && <span className="block text-[11px] text-slate-400">{formatDateTime(product.created_at)}</span>}
      </td>
      <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button variant="secondary" size="sm" icon={ExternalLink} disabled={rowBusy} onClick={() => onOpen(product.id)}>
            {t("Open")}
          </Button>
          {/* Sync is never gated on status: it is the recovery path for a product left in "delivering". */}
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            loading={busy === "sync"}
            disabled={rowBusy}
            title={t(syncTooltip(product, delivered))}
            onClick={() => onSync(product)}
          >
            {t("Sync")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon={Trash2}
            loading={busy === "delete"}
            disabled={rowBusy}
            title={t("Delete the local record (assets stay in CMS)")}
            onClick={() => onDelete(product)}
          >
            {t("Delete")}
          </Button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Paginated list of delivery products for the selected CMS (or every CMS).
 * `kind` ("music" | "video") scopes the list and the summary to sound recordings
 * or to web / music video batches and picks the wording.
 * `onOpen(productId)` opens the detail view, `onCreate()` opens the form.
 */
export default function ProductList({ kind = "music", network, networks = [], showToast, onOpen, onCreate, refreshKey }) {
  const { t, tm } = useI18n();
  const copy = copyFor(kind);
  const pageNetworkId = network?.id ? String(network.id) : "";
  const [prevPageNetworkId, setPrevPageNetworkId] = useState(pageNetworkId);
  const [scope, setScope] = useState(pageNetworkId ? "current" : "all");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [reloadTick, setReloadTick] = useState(0);
  const [result, setResult] = useState({ key: "", error: "", products: [], total: 0, summary: EMPTY_SUMMARY });
  const [busy, setBusy] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);

  // Follow the page-level CMS selection when it changes (state adjusted during render).
  if (prevPageNetworkId !== pageNetworkId) {
    setPrevPageNetworkId(pageNetworkId);
    setScope(pageNetworkId ? "current" : "all");
    setPage(1);
  }

  const networkNameById = useMemo(() => {
    const map = new Map();
    (networks || []).forEach((item) => map.set(String(item.id), item.name));
    return map;
  }, [networks]);

  const effectiveNetworkId = scope === "current" ? pageNetworkId : scope === "all" ? "" : scope;
  const trimmedSearch = debouncedSearch.trim();
  const hasFilters = Boolean(statusFilter || trimmedSearch);

  // One string identifies the request in flight; `loading` is derived from it so
  // the effect never has to set state synchronously.
  const requestKey = useMemo(
    () => JSON.stringify({ k: kind, n: effectiveNetworkId, s: statusFilter, q: trimmedSearch, p: page, ps: pageSize, r: refreshKey, t: reloadTick }),
    [kind, effectiveNetworkId, statusFilter, trimmedSearch, page, pageSize, refreshKey, reloadTick]
  );
  const loading = result.key !== requestKey;

  useEffect(() => {
    const params = JSON.parse(requestKey);
    let active = true;
    listProducts({
      kind: params.k,
      network_id: params.n || undefined,
      status: params.s || undefined,
      search: params.q || undefined,
      page: params.p,
      page_size: params.ps
    })
      .then((data) => {
        if (!active) return;
        setResult({
          key: requestKey,
          error: "",
          products: Array.isArray(data?.products) ? data.products : [],
          total: Number(data?.total) || 0,
          summary: { ...EMPTY_SUMMARY, ...(data?.summary || {}) }
        });
      })
      .catch((error) => {
        if (!active) return;
        setResult((current) => ({ ...current, key: requestKey, error: getErrorMessage(error) }));
      });
    return () => {
      active = false;
    };
  }, [requestKey]);

  const reload = useCallback(() => setReloadTick((current) => current + 1), []);

  function setRowBusy(id, value) {
    setBusy((current) => {
      const next = { ...current };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });
  }

  async function handleSync(product) {
    setRowBusy(product.id, "sync");
    try {
      const data = await syncProduct(product.id);
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      if (errors.length) {
        showToast(t(errors.length === 1 ? copy.syncErrorsOne : copy.syncErrorsMany, { title: product.title, count: errors.length }), "warning");
      } else {
        showToast(t("Synced «{title}» from CMS", { title: product.title }), "success");
      }
      reload();
    } catch (error) {
      showToast(t("Sync failed: {error}", { error: tm(getErrorMessage(error)) }), "error");
    } finally {
      setRowBusy(product.id, null);
    }
  }

  async function handleDelete() {
    const product = deleteTarget;
    if (!product) return;
    setRowBusy(product.id, "delete");
    try {
      await deleteProduct(product.id);
      showToast(t("Deleted local record «{title}»", { title: product.title }), "success");
      setDeleteTarget(null);
      reload();
    } catch (error) {
      showToast(t("Delete failed: {error}", { error: tm(getErrorMessage(error)) }), "error");
    } finally {
      setRowBusy(product.id, null);
    }
  }

  function clearFilters() {
    setStatusFilter("");
    setSearch("");
    setPage(1);
  }

  const scopeOptions = useMemo(() => {
    const options = [];
    if (pageNetworkId) options.push({ value: "current", label: t("Current CMS · {name}", { name: network?.name || pageNetworkId }) });
    options.push({ value: "all", label: t("All CMS") });
    (networks || [])
      .filter((item) => String(item.id) !== pageNetworkId)
      .forEach((item) => options.push({ value: String(item.id), label: item.name || t("Network {id}", { id: item.id }) }));
    return options;
  }, [networks, network, pageNetworkId, t]);

  const summaryTiles = useMemo(() => {
    let scopeKind = "all";
    let scopeName = "";
    if (effectiveNetworkId) {
      scopeName = (scope === "current" ? network?.name : networkNameById.get(effectiveNetworkId)) || "";
      scopeKind = scopeName ? "named" : "selected";
    }
    return buildSummaryTiles(copy, scopeKind, scopeName, hasFilters, t);
  }, [copy, effectiveNetworkId, scope, network, networkNameById, hasFilters, t]);

  const { error, products, total, summary } = result;
  const deleteCount = Number(deleteTarget?.track_count) || 0;
  const showEmpty = !loading && !error && !products.length;
  // After a failed request keep showing the previous rows (dimmed) if there were any; otherwise only the error.
  const showTable = !showEmpty && (!error || products.length > 0);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {summaryTiles.map((tile) => (
          <StatTile key={tile.key} label={tile.label} value={formatNumber(summary[tile.key])} hint={tile.hint} tone={tile.tone} icon={tile.icon} />
        ))}
      </div>

      <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1 md:max-w-md">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <TextInput
                value={search}
                placeholder={t(copy.searchPlaceholder)}
                className="pl-11"
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
              {search && (
                <button
                  type="button"
                  aria-label={t("Clear search")}
                  onClick={() => {
                    setSearch("");
                    setPage(1);
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-800"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <Select
              value={statusFilter}
              placeholder={t("All statuses")}
              options={STATUS_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
              wrapperClassName="md:w-52"
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
            />
            <Select
              value={scope}
              options={scopeOptions}
              wrapperClassName="md:w-60"
              aria-label={t("CMS filter")}
              onChange={(event) => {
                setScope(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-slate-400">
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size={13} /> {t("Loading…")}
                </span>
              ) : (
                t(total === 1 ? copy.countOne : copy.countMany, { count: total })
              )}
            </span>
            <Button variant="secondary" size="sm" icon={RefreshCw} loading={loading && products.length > 0} onClick={reload}>
              {t("Refresh")}
            </Button>
            <Button size="sm" icon={Plus} onClick={onCreate}>
              {t(copy.newLabel)}
            </Button>
          </div>
        </div>

        {error && (
          <div className="p-5">
            <InlineMessage
              tone="error"
              actions={
                <Button size="sm" variant="secondary" icon={RefreshCw} onClick={reload}>
                  {t("Retry")}
                </Button>
              }
            >
              {t(copy.loadError)}: {tm(error)}
            </InlineMessage>
          </div>
        )}

        {showEmpty && (
          <div className="p-5">
            {hasFilters ? (
              <EmptyState
                icon={Search}
                title={t(copy.noMatchTitle)}
                description={t("Try another status, search term or CMS.")}
                action={
                  <Button variant="secondary" icon={X} onClick={clearFilters}>
                    {t("Clear filters")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={copy.productIcon}
                title={t(copy.emptyTitle)}
                description={t(copy.emptyDescription)}
                action={
                  <Button icon={Plus} onClick={onCreate}>
                    {t(copy.newLabel)}
                  </Button>
                }
              />
            )}
          </div>
        )}

        {showTable && (
          <div className="overflow-x-auto">
            <table className="min-w-[1280px] w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t(copy.productHeader)}</th>
                  <th className="px-4 py-3">{t(copy.codeHeader)}</th>
                  <th className="px-4 py-3">CMS</th>
                  <th className="px-4 py-3">{t(copy.itemsLabel)}</th>
                  <th className="px-4 py-3">{t(copy.mediaHeader)}</th>
                  <th className="px-4 py-3">{t("Policy")}</th>
                  <th className="px-4 py-3">{t("Status")}</th>
                  <th className="px-4 py-3">{t("Delivered")}</th>
                  <th className="px-4 py-3">{t("Created by")}</th>
                  <th className="px-4 py-3 text-right">{t("Actions")}</th>
                </tr>
              </thead>
              <tbody className={cx("divide-y divide-slate-100", loading && products.length > 0 && "opacity-60")}>
                {loading && !products.length ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-14 text-center">
                      <span className="inline-flex items-center gap-2 text-sm font-bold text-slate-400">
                        <Spinner size={18} /> {t(copy.loading)}
                      </span>
                    </td>
                  </tr>
                ) : (
                  products.map((product) => (
                    <ProductRow
                      key={product.id}
                      product={product}
                      kind={kind}
                      networkName={product.network_name || networkNameById.get(String(product.network_id)) || ""}
                      busy={busy[product.id]}
                      onOpen={onOpen}
                      onSync={handleSync}
                      onDelete={setDeleteTarget}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {!showEmpty && !error && (
          <PaginationFooter total={total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        )}
      </section>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("Delete local record?")}
        tone="danger"
        confirmLabel={t("Delete")}
        loading={Boolean(deleteTarget && busy[deleteTarget.id] === "delete")}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        message={deleteTarget ? t(deleteCount === 1 ? copy.deleteMessageOne : copy.deleteMessageMany, { title: deleteTarget.title, count: deleteCount }) : ""}
      >
        <InlineMessage tone="warning">
          {t(copy.takedownHint)}
        </InlineMessage>
      </ConfirmDialog>
    </div>
  );
}
