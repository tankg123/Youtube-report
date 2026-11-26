import api from "./api";
import { tk } from "../i18n/index.js";

// Budgets (ms): the shared axios instance defaults to 15 s, too short for an overview that aggregates a year of
// facts plus range snapshots, for a sync enqueue that validates up to 200 channels, or for a workbook export.
const TIMEOUT_READ = 30000;
const TIMEOUT_WRITE = 60000;
const TIMEOUT_EXPORT = 180000;
const BASE = "/analytics";

// GET params: empty values are dropped and arrays (channelIds) travel as a csv string; POST bodies keep arrays.
function queryParams(params) {
  if (!params) return undefined;
  const output = {};
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length) output[key] = value.join(",");
      return;
    }
    output[key] = value;
  });
  return output;
}

const get = async (path, params, signal) => (await api.get(`${BASE}${path}`, { params: queryParams(params), signal, timeout: TIMEOUT_READ })).data;
const post = async (path, body) => (await api.post(`${BASE}${path}`, body ?? {}, { timeout: TIMEOUT_WRITE })).data;
const put = async (path, body) => (await api.put(`${BASE}${path}`, body ?? {}, { timeout: TIMEOUT_WRITE })).data;
const download = (path, params) => api.get(`${BASE}${path}`, { params: queryParams(params), responseType: "blob", timeout: TIMEOUT_EXPORT });
const segment = (value) => encodeURIComponent(String(value));

// Every method returns response.data ({ success, …fields }); exportFile / bulkExport return the axios response
// whose Blob body goes to downloadAnalyticsFile(response, fallbackName).
export const analyticsApi = {
  bootstrap: (signal) => get("/bootstrap", undefined, signal),
  overview: (params, signal) => get("/overview", params, signal),
  channelsInventory: (params, signal) => get("/channels/inventory", params, signal),
  channels: (params, signal) => get("/channels", params, signal),
  channel: (channelId, params, signal) => get(`/channels/${segment(channelId)}`, params, signal),
  coverage: (params, signal) => get("/coverage", params, signal),
  history: (params, signal) => get("/history", params, signal),
  facts: (params, signal) => get("/facts", params, signal),
  snapshots: (params, signal) => get("/snapshots", params, signal),
  exportFile: (params) => download("/export", params),
  sync: (body) => post("/sync", body),
  jobs: (params, signal) => get("/jobs", params, signal),
  job: (jobId, signal) => get(`/jobs/${segment(jobId)}`, undefined, signal),
  cancel: (jobId) => post(`/jobs/${segment(jobId)}/cancel`, {}),
  schedules: (signal) => get("/schedules", undefined, signal),
  saveSchedule: (body) => put("/schedules", body),
  query: (body) => post("/query", body),
  queries: (params, signal) => get("/queries", params, signal),
  bulkCatalog: (params, signal) => get("/bulk/catalog", params, signal),
  bulkCreate: (body) => post("/bulk/jobs", body),
  bulkSync: (body) => post("/bulk/sync", body),
  bulkRuns: (params, signal) => get("/bulk/runs", params, signal),
  bulkRun: (runId, signal) => get(`/bulk/runs/${segment(runId)}`, undefined, signal),
  bulkCancel: (runId) => post(`/bulk/runs/${segment(runId)}/cancel`, {}),
  bulkData: (params, signal) => get("/bulk/data", params, signal),
  bulkExport: (params) => download("/bulk/export", params)
};

const isCancelled = (error) => error?.code === "ERR_CANCELED" || error?.name === "CanceledError" || error?.name === "AbortError";

// Canonical English (tk): render the result with tm() so backend answers and these fallbacks are translated where shown.
export function analyticsError(error) {
  if (isCancelled(error)) return tk("Cancelled");
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") return tk("Request timed out");
  const data = error?.response?.data;
  const detail = data?.error;
  const message = data?.message || (typeof detail === "string" ? detail : detail?.message);
  if (message) return message;
  if (!error?.isAxiosError && error?.message) return error.message;
  return tk("Could not reach the Analytics service.");
}

// Export failures answer JSON inside a Blob (responseType: "blob"): read it before falling back to analyticsError.
export async function analyticsBlobError(error) {
  const data = error?.response?.data;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      const message = parsed?.message || (typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message);
      if (message) return message;
    } catch {
      // not a JSON body: fall through to the generic message
    }
  }
  return analyticsError(error);
}

export function downloadAnalyticsFile(response, fallbackName) {
  const disposition = response.headers?.["content-disposition"] || "";
  const match = disposition.match(
    /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i,
  );
  let filename = fallbackName;
  if (match) {
    try {
      filename = decodeURIComponent(match[1] || match[2]);
    } catch {
      filename = fallbackName;
    }
  }
  const url = URL.createObjectURL(response.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
