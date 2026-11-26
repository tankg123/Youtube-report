import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useSystemSettings } from "../../context/SystemSettingsContext";

export default function useDeliveryViews(path) {
  const [params, setParams] = useSearchParams();
  const { isSidebarVisible } = useSystemSettings();
  const showList = isSidebarVisible(path + "#list");
  const showNew = isSidebarVisible(path + "#new");
  const showDetail = isSidebarVisible(path + "#detail");
  const productId = params.get("product");
  let view;
  if (params.get("view") === "new" && showNew) view = "new";
  else if (productId && showDetail) view = "detail";
  else if (showList) view = "list";
  else if (showNew) view = "new";

  const backToList = useCallback(() => setParams({}), [setParams]);
  const openNew = useCallback(() => setParams({ view: "new" }), [setParams]);
  const openProduct = useCallback((id) => setParams({ product: String(id) }), [setParams]);
  return { view, productId, backToList, openNew: showNew ? openNew : undefined,
    openProduct: showDetail ? openProduct : undefined };
}
