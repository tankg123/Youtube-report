import api from "./api";
import { unwrapBlobError } from "../pages/claimManager/utils";
import { readAssetExport } from "./readAssetExport.js";

export async function searchArtistAssets({ networkId, artist, scope, type, pageToken }, signal) {
  const { data } = await api.get("/content-id/asset-check/search", {
    params: { network_id: networkId, artist, scope, type: type || undefined, page_token: pageToken || undefined },
    signal,
    timeout: 120000
  });
  return data;
}

export async function getAssetOwnership(networkId, assetId, signal) {
  const { data } = await api.get(`/content-id/asset-check/${encodeURIComponent(networkId)}/${encodeURIComponent(assetId)}`, {
    signal,
    timeout: 120000
  });
  return data;
}

export async function exportSelectedAssets(networkId, selection, language, signal, onProgress) {
  try {
    const payload = Array.isArray(selection) ? { items: selection } : selection;
    const { data, headers } = await api.post(`/content-id/asset-check/${encodeURIComponent(networkId)}/export`, { ...payload, language }, {
      headers: { Accept: "application/x-ndjson" }, adapter: "fetch", responseType: "stream", signal, timeout: 0
    });
    const contentType = headers["content-type"] || "";
    if (contentType.includes("application/x-ndjson")) return await readAssetExport(data, onProgress);
    // During a rolling deployment, an older backend can still return its ordinary XLSX.
    if (contentType.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) {
      return { blob: await new Response(data).blob(), written: null };
    }
    await data.cancel();
    throw new Error("The Excel download was interrupted. Retry the export.");
  } catch (error) {
    if (error.response?.data?.getReader) {
      try { error.response.data = await new Response(error.response.data).json(); } catch { /* keep the HTTP error */ }
    }
    throw await unwrapBlobError(error);
  }
}
