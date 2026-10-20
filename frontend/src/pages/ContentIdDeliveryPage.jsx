import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CloudUpload, Info, ListChecks, Plus, RefreshCw, ShieldCheck, Tag } from "lucide-react";
import ErrorBoundary from "../components/ErrorBoundary";
import { useI18n } from "../context/I18nContext";
import { tk } from "../i18n/index.js";
import { getDeliveryOptions, listCmsNetworks, listLocalLabels } from "../api/deliveryApi";
import { STORAGE_KEYS } from "./assetDelivery/constants";
import { getErrorMessage, readLocalStorage, writeLocalStorage } from "./assetDelivery/utils";
import { Badge, Button, EmptyState, InlineMessage, Select, Spinner, Toast, useToast } from "./assetDelivery/shared";
import ProductList from "./assetDelivery/ProductList";
import ProductForm from "./assetDelivery/ProductForm";
import ProductDetail from "./assetDelivery/ProductDetail";

const OPTION_ERROR_LABELS = {
  policies: tk("Policies"),
  asset_labels: tk("Asset labels"),
  content_owner: tk("Content owner")
};

function readStoredNetwork() {
  const value = readLocalStorage(STORAGE_KEYS.network, "");
  return value ? String(value) : "";
}

export default function ContentIdDeliveryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // `networksTick` identifies the networks request in flight; `networksLoaded` is
  // derived from it so a Retry never has to set state synchronously in the effect.
  const [networksTick, setNetworksTick] = useState(0);
  const [networksState, setNetworksState] = useState({ tick: -1, list: [], error: "" });
  const [networkId, setNetworkId] = useState(readStoredNetwork);
  const [optionsState, setOptionsState] = useState({ networkId: "", loading: false, data: null, error: "" });
  const [localLabels, setLocalLabels] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const { toast, showToast } = useToast();
  const { t, tm } = useI18n();
  const optionsSeqRef = useRef(0);

  // View routing: ?view=new → form, ?product=<id> → detail, otherwise the list.
  const viewParam = searchParams.get("view");
  const productParam = searchParams.get("product");
  const view = viewParam === "new" ? "new" : productParam ? "detail" : "list";
  const productId = view === "detail" ? productParam : null;

  const openProduct = useCallback(
    (id) => {
      setSearchParams({ product: String(id) });
    },
    [setSearchParams]
  );
  const openNew = useCallback(() => {
    setSearchParams({ view: "new" });
  }, [setSearchParams]);
  const backToList = useCallback(() => {
    setSearchParams({});
  }, [setSearchParams]);

  const networks = networksState.list;
  const networksLoaded = networksState.tick === networksTick;
  const networksError = networksState.error;
  const network = useMemo(() => networks.find((item) => String(item.id) === String(networkId)) || null, [networks, networkId]);

  const options = optionsState.networkId === networkId ? optionsState.data : null;
  const optionsError = optionsState.networkId === networkId ? optionsState.error : "";
  const optionsLoading = Boolean(networkId) && (optionsState.networkId !== networkId || optionsState.loading);

  // Connected CMS networks (re-run by Retry through `networksTick`)
  useEffect(() => {
    let active = true;
    listCmsNetworks()
      .then((data) => {
        if (!active) return;
        const list = (data?.networks || []).filter((item) => item.cms_auth_status === "connected");
        setNetworksState({ tick: networksTick, list, error: "" });
        setNetworkId((current) => {
          if (current && list.some((item) => String(item.id) === current)) return current;
          return list.length ? String(list[0].id) : "";
        });
      })
      .catch((error) => {
        if (!active) return;
        // Keep whatever list a previous request produced; the error banner offers a retry.
        setNetworksState((current) => ({ tick: networksTick, list: current.list, error: getErrorMessage(error) }));
      });
    return () => {
      active = false;
    };
  }, [networksTick]);

  const retryNetworks = useCallback(() => setNetworksTick((current) => current + 1), []);

  // CMS options (policies / asset labels / content owner) per network
  useEffect(() => {
    if (!networkId) return undefined;
    const seq = optionsSeqRef.current + 1;
    optionsSeqRef.current = seq;
    getDeliveryOptions(networkId)
      .then((data) => {
        if (optionsSeqRef.current !== seq) return;
        setOptionsState({ networkId, loading: false, data: data?.options || null, error: "" });
      })
      .catch((error) => {
        if (optionsSeqRef.current !== seq) return;
        setOptionsState({ networkId, loading: false, data: null, error: getErrorMessage(error) });
      });
    return undefined;
  }, [networkId]);

  // Local record labels (label suggestions in the form)
  useEffect(() => {
    let active = true;
    listLocalLabels()
      .then((data) => {
        if (active) setLocalLabels(data?.labels || []);
      })
      .catch(() => {
        // optional data; the form falls back to free-text labels
      });
    return () => {
      active = false;
    };
  }, []);

  // Persist the CMS selection
  useEffect(() => {
    if (networkId) writeLocalStorage(STORAGE_KEYS.network, networkId);
  }, [networkId]);

  const reloadOptions = useCallback(async () => {
    if (!networkId) return null;
    const seq = optionsSeqRef.current + 1;
    optionsSeqRef.current = seq;
    setOptionsState((current) => ({
      networkId,
      loading: true,
      data: current.networkId === networkId ? current.data : null,
      error: ""
    }));
    try {
      const data = await getDeliveryOptions(networkId);
      const nextOptions = data?.options || null;
      if (optionsSeqRef.current === seq) {
        setOptionsState({ networkId, loading: false, data: nextOptions, error: "" });
      }
      return nextOptions;
    } catch (error) {
      const message = getErrorMessage(error);
      if (optionsSeqRef.current === seq) {
        setOptionsState((current) => ({
          networkId,
          loading: false,
          data: current.networkId === networkId ? current.data : null,
          error: message
        }));
      }
      showToast(t("Could not reload CMS options: {error}", { error: tm(message) }), "error");
      return null;
    }
  }, [networkId, showToast, t, tm]);

  const bumpRefresh = useCallback(() => setRefreshKey((current) => current + 1), []);

  const handleDelivered = useCallback(
    (id) => {
      bumpRefresh();
      if (id !== undefined && id !== null && id !== "") openProduct(id);
      else backToList();
    },
    [bumpRefresh, openProduct, backToList]
  );

  const handleDeleted = useCallback(() => {
    bumpRefresh();
    backToList();
  }, [bumpRefresh, backToList]);

  const optionErrors = Object.entries(options?.errors || {}).filter(([, message]) => Boolean(message));
  const contentOwner = options?.content_owner || null;
  const policyCount = options?.policies?.length ?? 0;
  const labelCount = options?.asset_labels?.length ?? 0;

  function renderView() {
    if (view === "new") {
      return (
        <ProductForm
          network={network}
          options={options}
          optionsLoading={optionsLoading}
          reloadOptions={reloadOptions}
          localLabels={localLabels}
          showToast={showToast}
          onCancel={backToList}
          onDelivered={handleDelivered}
        />
      );
    }
    if (view === "detail") {
      return (
        <ProductDetail
          productId={productId}
          network={network}
          options={options}
          optionsLoading={optionsLoading}
          reloadOptions={reloadOptions}
          localLabels={localLabels}
          showToast={showToast}
          onBack={backToList}
          onDeleted={handleDeleted}
        />
      );
    }
    return <ProductList network={network} networks={networks} showToast={showToast} onOpen={openProduct} onCreate={openNew} refreshKey={refreshKey} />;
  }

  return (
    <div className="space-y-5 p-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-black uppercase text-emerald-700">
              <CloudUpload size={15} />
              Content ID
            </p>
            <h1 className="mt-3 text-3xl font-black text-slate-950">{t("CMS Delivery")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              {t("Deliver releases straight to YouTube CMS through the Content ID API and manage them afterwards.")}
            </p>
            <p className="mt-2 inline-flex max-w-2xl items-start gap-1.5 text-xs text-slate-400">
              <Info size={13} className="mt-0.5 shrink-0" />
              <span>
                {t("Each track becomes a Sound Recording asset with ownership, match policy, labels and an audio reference. Art Tracks are not supported by the Content ID API.")}
              </span>
            </p>
          </div>

          <div className="w-full xl:max-w-2xl">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label htmlFor="cid-delivery-network" className="text-xs font-black uppercase tracking-wide text-slate-400">
                  {t("CMS network")}
                </label>
                <div className="mt-1.5">
                  <Select
                    id="cid-delivery-network"
                    value={networkId}
                    disabled={!networksLoaded || !networks.length}
                    onChange={(event) => setNetworkId(event.target.value)}
                    placeholder={!networksLoaded ? t("Loading CMS networks…") : networks.length ? t("Select a CMS network") : t("No connected CMS network")}
                    options={networks.map((item) => ({
                      value: String(item.id),
                      label: `${item.name}${item.network_code ? ` · ${item.network_code}` : ""}`
                    }))}
                  />
                </div>
              </div>
              <Button variant="secondary" icon={RefreshCw} loading={optionsLoading} disabled={!networkId} onClick={reloadOptions}>
                {t("Reload CMS options")}
              </Button>
              {view !== "new" && (
                <Button icon={Plus} disabled={!networksLoaded || !networks.length} onClick={openNew}>
                  {t("New product")}
                </Button>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {optionsLoading && (
                <span className="inline-flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Spinner size={14} /> {t("Loading CMS options…")}
                </span>
              )}
              {!optionsLoading && options && (
                <>
                  <Badge tone="emerald" icon={ShieldCheck} title={contentOwner?.id ? t("Content owner ID {id}", { id: contentOwner.id }) : undefined}>
                    {contentOwner?.display_name || network?.name || t("Content owner")}
                    {contentOwner?.id ? ` · ${contentOwner.id}` : network?.network_code ? ` · ${network.network_code}` : ""}
                  </Badge>
                  <Badge tone="blue" icon={ListChecks}>{t("{count} policies", { count: policyCount })}</Badge>
                  <Badge tone="indigo" icon={Tag}>{t("{count} asset labels", { count: labelCount })}</Badge>
                  {network?.cms_auth_email && <Badge tone="slate">{network.cms_auth_email}</Badge>}
                </>
              )}
            </div>
          </div>
        </div>

        {networksError && (
          <InlineMessage
            tone="error"
            className="mt-4"
            actions={
              <Button size="sm" variant="secondary" icon={RefreshCw} loading={!networksLoaded} onClick={retryNetworks}>
                {t("Retry")}
              </Button>
            }
          >
            {t("Could not load CMS networks: {error}", { error: tm(networksError) })}
          </InlineMessage>
        )}

        {optionsError && !optionsLoading && (
          <InlineMessage
            tone="error"
            className="mt-4"
            actions={
              <Button size="sm" variant="secondary" icon={RefreshCw} onClick={reloadOptions}>
                {t("Retry")}
              </Button>
            }
          >
            {t("Could not load CMS options: {error}", { error: tm(optionsError) })}
          </InlineMessage>
        )}

        {!optionsLoading && optionErrors.length > 0 && (
          <InlineMessage tone="warning" className="mt-4" title={t("Some CMS options could not be loaded")}>
            <ul className="mt-1 space-y-0.5">
              {optionErrors.map(([key, message]) => (
                <li key={key}>
                  <span className="font-black">{t(OPTION_ERROR_LABELS[key] || key)}:</span> {tm(String(message))}
                </li>
              ))}
            </ul>
          </InlineMessage>
        )}
      </section>

      {/* The "no network" empty state only when the request actually succeeded with nothing connected. */}
      {networksLoaded && !networks.length && !networksError ? (
        <EmptyState
          icon={CloudUpload}
          title={t("No connected CMS network")}
          description={t("Connect a YouTube CMS (content owner) network with the Content ID OAuth first, then come back to deliver releases.")}
          action={
            <Link to="/networks" className="inline-flex h-11 items-center gap-2 rounded-2xl bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-700">
              {t("Open Networks")}
            </Link>
          }
        />
      ) : (
        <ErrorBoundary key={`${view}:${productId || ""}`}>{renderView()}</ErrorBoundary>
      )}

      <Toast id={toast?.id} message={toast?.message} tone={toast?.tone} />
    </div>
  );
}
