import api from "./api";
import { guessAudioMime } from "../pages/assetDelivery/utils";

// Timeouts (ms). The shared axios instance defaults to 15s which is too short
// for CMS round-trips, so every call below passes an explicit budget. The server re-sends an
// idempotent CMS call whose answer never arrived (30 s deadline, 60 s once an attempt stayed
// silent, at most two silent attempts), so one such call takes ~90 s when Google stays silent,
// plus up to 30 s of Retry-After when Google first answered 429/503. A create (asset insert,
// reference upload) is never re-sent after silence and costs one 30 s attempt. The budgets
// below cover the silent case of each action's longest path; when the browser still gives up
// first, ProductDetail treats the timeout as "still running on the server" and refreshes
// instead of reporting a failure.
const TIMEOUT_DEFAULT = 30000;
const TIMEOUT_OPTIONS = 60000;
const TIMEOUT_DUPLICATES = 60000;
const TIMEOUT_CREATE = 60000;
// Deliver only queues a background job on the server (202) — no CMS round-trip.
const TIMEOUT_DELIVER = 60000;
const TIMEOUT_PROGRESS = 15000;
// token refresh (≤ 20 s) + up to three CMS steps: insert (or a labels PATCH when the insert ran
// earlier), ownership, match policy — the idempotent ones ~90 s each
const TIMEOUT_RETRY = 300000;
// asset GET in parallel with the reference list (up to 5 pages)
const TIMEOUT_SYNC_TRACK = 200000;
const TIMEOUT_SYNC_PRODUCT = 300000;
const TIMEOUT_UPDATE_PRODUCT = 300000;
// metadata PATCH + labels PATCH
const TIMEOUT_UPDATE_TRACK = 300000;
const TIMEOUT_RIGHTS = 300000;
const TIMEOUT_TAKEDOWN_PRODUCT = 600000;
// list references + one PATCH per reference + claim search + one PATCH per claim; a long claim
// sweep falls through to the "still running" handling
const TIMEOUT_TAKEDOWN_TRACK = 300000;
const TIMEOUT_CLAIMS = 60000;

const BASE = "/content-id/delivery";

function cleanParams(params = {}) {
  const output = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    output[key] = value;
  });
  return output;
}

// ---------------------------------------------------------------------------
// CMS networks / options
// ---------------------------------------------------------------------------

export async function listCmsNetworks() {
  const response = await api.get("/content-id/cms-networks", { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

export async function getDeliveryOptions(networkId) {
  const response = await api.get(`${BASE}/options`, {
    params: { network_id: networkId },
    timeout: TIMEOUT_OPTIONS
  });
  return response.data;
}

export async function createCmsAssetLabel(networkId, labelName) {
  const response = await api.post(
    `${BASE}/asset-labels`,
    { network_id: networkId, label_name: labelName },
    { timeout: TIMEOUT_OPTIONS }
  );
  return response.data;
}

export async function checkDuplicateIsrcs(networkId, isrcs) {
  const response = await api.post(
    `${BASE}/check-duplicates`,
    { network_id: networkId, isrcs },
    { timeout: TIMEOUT_DUPLICATES }
  );
  return response.data;
}

// ---------------------------------------------------------------------------
// Products (create / deliver / manage)
// ---------------------------------------------------------------------------

export async function createProduct(payload) {
  const response = await api.post(`${BASE}/products`, payload, { timeout: TIMEOUT_CREATE });
  return response.data;
}

/**
 * Starts the server-side delivery job (asset steps + reference upload from the
 * stored audio). Responds 202 immediately with `{ product, job:{ running, track_ids } }`;
 * poll `getProductProgress` until `job.running` is false. `include_reference` is
 * only sent when given as a boolean (the backend defaults to the product setting).
 */
export async function deliverProduct(productId, options = {}) {
  const { track_ids, force_duplicates, include_reference, delete_reference_after_delivery } = options || {};
  const body = {};
  if (Array.isArray(track_ids) && track_ids.length) body.track_ids = track_ids;
  if (force_duplicates) body.force_duplicates = true;
  if (typeof include_reference === "boolean") body.include_reference = include_reference;
  // Remembered on the product: the job removes each stored audio file once its reference is live.
  if (typeof delete_reference_after_delivery === "boolean") body.delete_reference_after_delivery = delete_reference_after_delivery;
  const response = await api.post(`${BASE}/products/${productId}/deliver`, body, { timeout: TIMEOUT_DELIVER });
  return response.data;
}

/**
 * Removes the stored audio of every fully delivered track (live reference in CMS) to free
 * server storage. Pass `track_ids` to limit the cleanup. → `{ removed, bytes_freed, results, product }`
 */
export async function cleanupProductAudio(productId, payload = {}) {
  const body = {};
  if (Array.isArray(payload?.track_ids) && payload.track_ids.length) body.track_ids = payload.track_ids;
  const response = await api.post(`${BASE}/products/${productId}/cleanup-audio`, body, { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

// ---------------------------------------------------------------------------
// Delivery logs (persisted on the server)
// ---------------------------------------------------------------------------

/**
 * One page of persisted delivery events, newest first (oldest first when `after_id` is
 * given, for polling). Params: limit, before_id, after_id, track_id, run_id, status
 * ("error"), action (an action name or a group: delivery | api | reference | audio |
 * management), search. → `{ events, has_more, next_before_id, latest_id, job }`
 */
export async function getProductLogs(productId, params = {}) {
  const response = await api.get(`${BASE}/products/${productId}/logs`, { params: cleanParams(params), timeout: TIMEOUT_DEFAULT });
  return response.data;
}

/** Delivery runs of a product, newest first: `{ runs:[{ run_id, status, started_at, finished_at, summary, ... }] }`. */
export async function getProductLogRuns(productId) {
  const response = await api.get(`${BASE}/products/${productId}/logs/runs`, { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

/**
 * Downloads every matching event as a file (`format`: "jsonl" | "csv"; the other params are
 * the same filters as `getProductLogs`). → `{ blob, fileName }`
 */
export async function exportProductLogs(productId, params = {}) {
  const response = await api.get(`${BASE}/products/${productId}/logs/export`, {
    params: cleanParams(params),
    responseType: "blob",
    timeout: TIMEOUT_SYNC_PRODUCT
  });
  const disposition = String(response.headers?.["content-disposition"] || "");
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: response.data, fileName: match ? match[1] : `cms-delivery-${productId}-logs.${params?.format === "csv" ? "csv" : "jsonl"}` };
}

/** Lightweight polling payload: `{ product, tracks:[{ id, status, step, ... }], job:{ running } }`. */
export async function getProductProgress(productId) {
  const response = await api.get(`${BASE}/products/${productId}/progress`, { timeout: TIMEOUT_PROGRESS });
  return response.data;
}

export async function syncProduct(productId) {
  const response = await api.post(`${BASE}/products/${productId}/sync`, {}, { timeout: TIMEOUT_SYNC_PRODUCT });
  return response.data;
}

export async function updateProduct(productId, payload = {}) {
  const { product, apply_to_cms = true } = payload || {};
  const response = await api.patch(
    `${BASE}/products/${productId}`,
    { product, apply_to_cms: Boolean(apply_to_cms) },
    { timeout: TIMEOUT_UPDATE_PRODUCT }
  );
  return response.data;
}

export async function updateProductRights(productId, payload = {}) {
  const response = await api.post(`${BASE}/products/${productId}/rights`, payload || {}, { timeout: TIMEOUT_RIGHTS });
  return response.data;
}

export async function takedownProduct(productId, payload = {}) {
  const response = await api.post(`${BASE}/products/${productId}/takedown`, payload || {}, { timeout: TIMEOUT_TAKEDOWN_PRODUCT });
  return response.data;
}

export async function reactivateProduct(productId, payload = {}) {
  const response = await api.post(`${BASE}/products/${productId}/reactivate`, payload || {}, { timeout: TIMEOUT_TAKEDOWN_PRODUCT });
  return response.data;
}

export async function listProducts(params = {}) {
  const response = await api.get(`${BASE}/products`, { params: cleanParams(params), timeout: TIMEOUT_DEFAULT });
  return response.data;
}

export async function getProduct(productId) {
  const response = await api.get(`${BASE}/products/${productId}`, { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

export async function deleteProduct(productId) {
  const response = await api.delete(`${BASE}/products/${productId}`, { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/**
 * Uploads the raw audio file to the backend, which stores it with the product
 * (backend/data/delivery-media). Nothing is sent to CMS here — the reference is
 * delivered later, server-side, by `deliverTrackReference` / `deliverProduct`.
 * File metadata travels as query params because the CORS allow-list does not
 * accept custom request headers.
 *
 * @param {number|string} trackId
 * @param {File} file
 * @param {{onProgress?: (percent: number) => void, signal?: AbortSignal}} options
 * @returns {Promise<{track: object}>}
 */
export async function uploadTrackAudio(trackId, file, options = {}) {
  const { onProgress, signal } = options || {};
  const total = Number(file?.size) || 0;

  const response = await api.put(`${BASE}/tracks/${trackId}/audio`, file, {
    headers: { "Content-Type": file?.type || guessAudioMime(file?.name) || "application/octet-stream" },
    params: {
      file_name: file?.name || "track",
      file_size: total
    },
    timeout: 0,
    signal,
    onUploadProgress: (event) => {
      if (typeof onProgress !== "function") return;
      const denominator = Number(event?.total) || total;
      if (!denominator) {
        onProgress(0);
        return;
      }
      const percent = Math.round((Number(event?.loaded || 0) / denominator) * 100);
      onProgress(Math.max(0, Math.min(100, percent)));
    }
  });

  return response.data;
}

// ---------------------------------------------------------------------------
// Draft audio uploads (from the product form, before the product exists)
// ---------------------------------------------------------------------------

/**
 * Uploads an audio file the moment it is chosen in the product form. The server keeps it as
 * a draft upload (expires after a day when never used) and returns an id that `createProduct`
 * attaches to the track (`tracks[].audio_upload_id`). → `{ upload:{ id, file_name, file_size, ... } }`
 *
 * `kind: "video"` tells the server the file is a video reference: MP4/MOV clips shorter than
 * the Content ID minimum are refused with HTTP 422 (`code: "VIDEO_TOO_SHORT"`).
 * @param {File} file
 * @param {{onProgress?: (percent: number) => void, signal?: AbortSignal, kind?: "music"|"video"}} options
 */
export async function uploadDraftAudio(file, options = {}) {
  const { onProgress, signal, kind } = options || {};
  const total = Number(file?.size) || 0;

  const response = await api.put(`${BASE}/audio-uploads`, file, {
    headers: { "Content-Type": file?.type || guessAudioMime(file?.name) || "application/octet-stream" },
    params: {
      file_name: file?.name || "track",
      file_size: total,
      media_kind: kind || undefined
    },
    timeout: 0,
    signal,
    onUploadProgress: (event) => {
      if (typeof onProgress !== "function") return;
      const denominator = Number(event?.total) || total;
      if (!denominator) {
        onProgress(0);
        return;
      }
      const percent = Math.round((Number(event?.loaded || 0) / denominator) * 100);
      onProgress(Math.max(0, Math.min(100, percent)));
    }
  });

  return response.data;
}

/** Which of the given draft uploads are still usable (restoring a form draft). → `{ uploads, missing }` */
export async function checkDraftAudio(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id || "").trim()).filter(Boolean);
  if (!list.length) return { success: true, uploads: [], missing: [] };
  const response = await api.get(`${BASE}/audio-uploads`, { params: { ids: list.join(",") }, timeout: TIMEOUT_DEFAULT });
  return response.data;
}

/** Removes a draft upload that will not be used (row removed, file replaced, form discarded). */
export async function deleteDraftAudio(uploadId) {
  const response = await api.delete(`${BASE}/audio-uploads/${encodeURIComponent(uploadId)}`, { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

/** Removes the stored audio file (reference fields on the track are kept). → `{ track }` */
export async function deleteTrackAudio(trackId) {
  const response = await api.delete(`${BASE}/tracks/${trackId}/audio`, { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

/**
 * Fetches the stored audio as a Blob (for an object URL / download). The endpoint
 * needs the Authorization header, so a plain `<audio src>` URL cannot be used.
 * @param {number|string} trackId
 * @param {{signal?: AbortSignal}} options
 * @returns {Promise<Blob>}
 */
export async function getTrackAudioBlob(trackId, options = {}) {
  const { signal } = options || {};
  const response = await api.get(`${BASE}/tracks/${trackId}/audio`, { responseType: "blob", timeout: 0, signal });
  return response.data;
}

/**
 * Asks the backend to upload the stored audio file as the asset's reference. The upload
 * runs as the product's background job (same as `deliverProduct`): the call answers 202 with
 * `{ track, product, job:{ running, run_id, track_ids } }`; poll `getProductProgress` until
 * `job.running` is false. 409 when a live reference exists and `force` is not set, or when a
 * job is already running for the product.
 * @param {number|string} trackId
 * @param {{content_type?: string, urgent?: boolean, force?: boolean}} options
 */
export async function deliverTrackReference(trackId, options = {}) {
  const { content_type, urgent, force } = options || {};
  const body = {};
  if (content_type) body.content_type = content_type;
  if (typeof urgent === "boolean") body.urgent = urgent;
  if (force) body.force = true;
  const response = await api.post(`${BASE}/tracks/${trackId}/reference`, body, { timeout: TIMEOUT_DELIVER });
  return response.data;
}

export async function createTrackReferenceFromClaim(trackId, claimId, contentType = "audio") {
  const response = await api.post(
    `${BASE}/tracks/${trackId}/reference-from-claim`,
    { claim_id: claimId, content_type: contentType },
    { timeout: TIMEOUT_OPTIONS }
  );
  return response.data;
}

export async function retryTrack(trackId) {
  const response = await api.post(`${BASE}/tracks/${trackId}/retry`, {}, { timeout: TIMEOUT_RETRY });
  return response.data;
}

export async function syncTrack(trackId) {
  const response = await api.post(`${BASE}/tracks/${trackId}/sync`, {}, { timeout: TIMEOUT_SYNC_TRACK });
  return response.data;
}

export async function updateTrack(trackId, payload = {}) {
  const { track, apply_to_cms = true } = payload || {};
  const response = await api.patch(
    `${BASE}/tracks/${trackId}`,
    { track, apply_to_cms: Boolean(apply_to_cms) },
    { timeout: TIMEOUT_UPDATE_TRACK }
  );
  return response.data;
}

export async function takedownTrack(trackId, payload = {}) {
  const response = await api.post(`${BASE}/tracks/${trackId}/takedown`, payload || {}, { timeout: TIMEOUT_TAKEDOWN_TRACK });
  return response.data;
}

export async function reactivateTrack(trackId, payload = {}) {
  const response = await api.post(`${BASE}/tracks/${trackId}/reactivate`, payload || {}, { timeout: TIMEOUT_TAKEDOWN_TRACK });
  return response.data;
}

export async function listTrackClaims(trackId) {
  const response = await api.get(`${BASE}/tracks/${trackId}/claims`, { timeout: TIMEOUT_CLAIMS });
  return response.data;
}

// ---------------------------------------------------------------------------
// Existing Content ID endpoints reused by the page
// ---------------------------------------------------------------------------

export async function listLocalLabels() {
  const response = await api.get("/content-id/labels", { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

export async function listLegacyProducts(search = "") {
  const response = await api.get("/content-id/products", {
    params: cleanParams({ search }),
    timeout: TIMEOUT_DEFAULT
  });
  return response.data;
}

export async function getLegacyProduct(id) {
  const response = await api.get(`/content-id/products/${id}`, { timeout: TIMEOUT_DEFAULT });
  return response.data;
}

export async function getAvailableCodes(type, count = 1) {
  const response = await api.get("/content-id/codes/available", {
    params: { type: String(type || "ISRC").toUpperCase(), count },
    timeout: TIMEOUT_DEFAULT
  });
  return response.data;
}
