import api from "./api";
import { unwrapBlobError } from "../pages/claimManager/utils";

// Claim Manager endpoints (backend: claimManagerController). Every function returns the
// JSON body (`{ success, ... }`); errors are axios errors whose `response.data` is
// `{ success: false, message, reason?, retry_after? }` (424 = CMS must be re-authorized,
// 429 = Google quota, honour `retry_after`).

const TIMEOUTS = {
  accounts: 30000,
  search: 120000,
  detail: 60000,
  release: 300000,
  // One claims.patch per item, like a release: same server budget, same client timeout.
  reinstate: 300000,
  confirm: 300000,
  recheck: 60000,
  history: 30000,
  export: 60000
};

/** Drop empty query values so URLs stay clean. */
function compactParams(params = {}) {
  const output = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "") return;
    output[key] = text;
  });
  return output;
}

export async function listClaimAccounts() {
  const response = await api.get("/content-id/claims/accounts", { timeout: TIMEOUTS.accounts });
  return response.data;
}

export async function searchClaims(payload, { signal } = {}) {
  const response = await api.post("/content-id/claims/search", payload, { signal, timeout: TIMEOUTS.search });
  return response.data;
}

export async function getThirdPartyUploads(videoId, networkIds, { signal } = {}) {
  const response = await api.post(`/content-id/claims/videos/${encodeURIComponent(videoId)}/third-party-uploads`, {
    network_ids: networkIds
  }, { signal, timeout: TIMEOUTS.search });
  return response.data;
}

export async function getClaimDetail(networkId, claimId, { signal } = {}) {
  const response = await api.get(`/content-id/claims/${encodeURIComponent(networkId)}/${encodeURIComponent(claimId)}`, {
    signal,
    timeout: TIMEOUTS.detail
  });
  return response.data;
}

export async function releaseClaims(releases, note = "", { signal } = {}) {
  const body = { releases };
  const text = String(note || "").trim();
  if (text) body.note = text;
  const response = await api.post("/content-id/claims/release", body, { signal, timeout: TIMEOUTS.release });
  return response.data;
}

/**
 * Set released (inactive) claims back to active. `items` have the release item shape
 * (buildReleaseItems()); the response mirrors /release: `{ operation_id, results, summary }` with
 * outcomes reinstated | already_active | failed | unknown | skipped.
 */
export async function reinstateClaims(items, note = "", { signal } = {}) {
  const body = { items };
  const text = String(note || "").trim();
  if (text) body.note = text;
  const response = await api.post("/content-id/claims/reinstate", body, { signal, timeout: TIMEOUTS.reinstate });
  return response.data;
}

/**
 * Confirm potential claims (matches awaiting confirmation): potential → active, Google's
 * "confirming a potential claim" through claims.patch. `items` have the release item shape
 * (buildReleaseItems()); the response mirrors /release: `{ operation_id, results, summary }` with
 * outcomes confirmed | already_active | failed | unknown | skipped.
 */
export async function confirmClaims(items, note = "", { signal } = {}) {
  const body = { items };
  const text = String(note || "").trim();
  if (text) body.note = text;
  const response = await api.post("/content-id/claims/confirm", body, { signal, timeout: TIMEOUTS.confirm });
  return response.data;
}

export async function recheckClaims(items) {
  const response = await api.post("/content-id/claims/recheck", { items }, { timeout: TIMEOUTS.recheck });
  return response.data;
}

export async function listClaimHistory(params = {}) {
  const response = await api.get("/content-id/claims/history", { params: compactParams(params), timeout: TIMEOUTS.history });
  return response.data;
}

/**
 * Returns the CSV Blob (BOM-prefixed, text/csv); save it with downloadBlob(). With `responseType:
 * "blob"` an error body (400 too many rows, 424, 429 …) arrives as a Blob too, so it is decoded
 * before the error is rethrown and the caller's requestMessage() sees the backend message as usual.
 */
export async function exportClaimHistory(params = {}) {
  try {
    const response = await api.get("/content-id/claims/history/export", {
      params: compactParams(params),
      timeout: TIMEOUTS.export,
      responseType: "blob"
    });
    return response.data;
  } catch (error) {
    throw await unwrapBlobError(error);
  }
}
