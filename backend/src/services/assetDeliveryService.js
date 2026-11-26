const axios = require("axios");
const { setTimeout: waitForRetry } = require("node:timers/promises");
const { getConnectedNetwork, getAccessToken, getGoogleError } = require("./googleContentIdService");
const { customIdFor } = require("./productTrackImportService");

const PARTNER_API = "https://youtubepartner.googleapis.com/youtube/partner/v1";
const PARTNER_UPLOAD_API = "https://youtubepartner.googleapis.com/upload/youtube/partner/v1";
// Per-attempt deadline for ordinary (non-upload) Partner API calls: 30 s until an attempt ends
// in silence, 60 s for the attempt after it. A dead connection costs one short attempt, while
// a genuinely slow answer (ownership/matchPolicy updates occasionally take a while) gets room
// on the retry. A call gives up once two attempts ended in silence, so it never waits more than
// 30 s + 60 s for nothing (an answered 429/503 in between adds its own Retry-After wait of at
// most MAX_RETRY_DELAY_MS): a third silent wait rarely converts and would only push
// request-scoped actions past the budgets the UI waits with. CONTENT_ID_REQUEST_TIMEOUT_MS
// overrides the 30 s base.
const DEFAULT_TIMEOUT = Number(process.env.CONTENT_ID_REQUEST_TIMEOUT_MS) > 0
  ? Number(process.env.CONTENT_ID_REQUEST_TIMEOUT_MS)
  : 30000;
const MAX_ATTEMPTS = 3;
const MAX_TIMEOUT_ATTEMPTS = 2;
const RETRY_BASE_MS = Math.max(Number(process.env.CONTENT_ID_RETRY_BASE_MS) || 500, 0);
const MAX_RETRY_DELAY_MS = 30000;
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set(["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);
// Axios reports its own deadline as ECONNABORTED (ETIMEDOUT with clarifyTimeoutError).
const TIMEOUT_ERROR_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);
// A 429/503 response proves Google did not process the call, so re-sending a create is safe.
// Socket errors and other 5xx after a create are ambiguous (the insert may have committed).
const SAFE_WRITE_RETRY_STATUSES = new Set([429, 503]);
// Methods whose repeat is harmless by HTTP semantics. PATCH is opted in per call (see the
// `idempotent` request option) because only some PATCH bodies replace a whole field.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT"]);
// Reference statuses (Google enum): live ones match/claim or are on their way to it, dead ones
// never will again; anything unknown is treated as not live.
const LIVE_REFERENCE_STATUSES = ["active", "activating", "checking", "checking_quota", "computing_fingerprint", "live_streaming_processing"];
const DEAD_REFERENCE_STATUSES = ["inactive", "deactivating", "deleted"];
const LIVE_REFERENCE_SET = new Set(LIVE_REFERENCE_STATUSES);
const DEAD_REFERENCE_SET = new Set(DEAD_REFERENCE_STATUSES);
const DEFAULT_MAX_REFERENCE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_REFERENCE_BYTES = Number(process.env.CONTENT_ID_MAX_REFERENCE_BYTES) > 0
  ? Number(process.env.CONTENT_ID_MAX_REFERENCE_BYTES)
  : DEFAULT_MAX_REFERENCE_BYTES;
const REFERENCE_CONTENT_TYPES = new Set(["audio", "audiovisual", "video"]);
// Asset types this tool delivers. "kind" drives the UI (music vs video) and the default
// reference content type; the metadata builder per type follows the Content ID Metadata
// reference (artist/isrc: music videos + sound recordings; label/album: sound recordings only;
// description/notes/customId/infoUrl/upc: every type).
const ASSET_TYPE_META = {
  sound_recording: { kind: "music", default_reference_content_type: "audio", isrc: "required" },
  web: { kind: "video", default_reference_content_type: "audiovisual", isrc: "none" },
  music_video: { kind: "video", default_reference_content_type: "audiovisual", isrc: "optional" }
};
const DEFAULT_ASSET_TYPE = "sound_recording";
// Byte limits from the Content ID Metadata reference. customId: letters, digits, "-", "_", ".",
// "@" and "/" only.
const CUSTOM_ID_MAX_BYTES = 64;
const TITLE_MAX_BYTES = 255;
const DESCRIPTION_MAX_BYTES = 5000;
const NOTES_MAX_BYTES = 255;
const INFO_URL_MAX_BYTES = 1536;
const REFERENCE_PATCH_STATUSES = new Set(["active", "inactive"]);
const ASSET_SEARCH_CHUNK = 50;
const ASSET_SEARCH_MAX_PAGES = 5;
const ASSET_LABEL_MAX_PAGES = 50;
const REFERENCE_LIST_MAX_PAGES = 5;
const CLAIM_SEARCH_MAX_PAGES = 10;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function normalizeIsrc(value) {
  const code = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === 12 ? code : "";
}

function normalizeUpc(value) {
  const code = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length >= 8 && code.length <= 14 ? code : "";
}

function isValidIsrc(value) {
  return /^[A-Z0-9]{12}$/.test(String(value || ""));
}

function isValidUpc(value) {
  return /^[A-Z0-9]{8,14}$/.test(String(value || ""));
}

function splitList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[,;|\r\n]+/);
  const seen = new Set();
  const result = [];
  source.forEach((item) => {
    const clean = String(item ?? "").trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    result.push(clean);
  });
  return result;
}

function parseReleaseDate(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const year = Number(value.year);
    if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
    const result = { year };
    const month = Number(value.month);
    const day = Number(value.day);
    if (Number.isInteger(month) && month >= 1 && month <= 12) {
      result.month = month;
      if (Number.isInteger(day) && day >= 1 && day <= 31) result.day = day;
    }
    return result;
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (match) return validDate(match[1], match[2], match[3]);

  match = text.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (match) return validDate(match[1], match[2]);

  match = text.match(/^(\d{4})$/);
  if (match) return validDate(match[1]);

  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) return validDate(match[3], match[2], match[1]);

  return null;
}

function validDate(yearText, monthText, dayText) {
  const year = Number(yearText);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  const result = { year };

  if (monthText !== undefined) {
    const month = Number(monthText);
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    result.month = month;
  }

  if (dayText !== undefined) {
    const day = Number(dayText);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    result.day = day;
  }

  return result;
}

function toDateOnly(value) {
  const parsed = parseReleaseDate(value);
  if (!parsed) return String(value ?? "").trim();
  const parts = [String(parsed.year)];
  if (parsed.month) parts.push(String(parsed.month).padStart(2, "0"));
  if (parsed.day) parts.push(String(parsed.day).padStart(2, "0"));
  return parts.join("-");
}

function buildCustomId(label, isrc) {
  return customIdFor(label, isrc);
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeTerritories(territories) {
  return splitList(territories)
    .map((code) => code.toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code))
    .filter((code, index, list) => list.indexOf(code) === index);
}

function capitalize(value) {
  const text = cleanText(value).toLowerCase();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function isLiveReferenceStatus(status) {
  return LIVE_REFERENCE_SET.has(cleanText(status).toLowerCase());
}

function isDeadReferenceStatus(status) {
  return DEAD_REFERENCE_SET.has(cleanText(status).toLowerCase());
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }

  const workers = Math.max(1, Math.min(Number(concurrency) || 1, values.length));
  await Promise.all(Array.from({ length: workers }, runWorker));
  return results;
}

// ---------------------------------------------------------------------------
// Metadata / ownership builders
// ---------------------------------------------------------------------------

function buildSoundRecordingMetadata(row = {}) {
  const title = cleanText(row.title);
  if (!title) throw badRequest("Title is required");
  assertMaxBytes(title, TITLE_MAX_BYTES, "Title");

  const isrc = normalizeIsrc(row.isrc);
  if (!isrc) throw badRequest("Valid ISRC is required");

  const metadata = { title };

  const artists = splitList(row.artist);
  if (artists.length) metadata.artist = artists;

  const album = cleanText(row.album);
  if (album) metadata.album = album;

  metadata.isrc = isrc;

  const rawUpc = cleanText(row.upc);
  if (rawUpc) {
    const upc = normalizeUpc(rawUpc);
    if (!upc) throw badRequest("Valid UPC is required");
    metadata.upc = upc;
  }

  const label = cleanText(row.label);
  if (label) metadata.label = label;

  const genres = splitList(row.genre);
  if (genres.length) metadata.genre = genres;

  const rawRelease = row.release_date;
  if (rawRelease !== undefined && rawRelease !== null && cleanText(rawRelease) !== "") {
    const releaseDate = parseReleaseDate(rawRelease);
    if (!releaseDate) throw badRequest("Release date must be YYYY-MM-DD");
    metadata.releaseDate = releaseDate;
  }

  const customId = cleanText(row.custom_id);
  if (customId) metadata.customId = customId;

  const notes = cleanText(row.notes);
  if (notes) {
    assertMaxBytes(notes, NOTES_MAX_BYTES, "Notes");
    metadata.notes = notes;
  }

  return metadata;
}

function normalizeAssetType(value) {
  const type = cleanText(value).toLowerCase();
  return ASSET_TYPE_META[type] ? type : DEFAULT_ASSET_TYPE;
}

function isAssetType(value) {
  return Boolean(ASSET_TYPE_META[cleanText(value).toLowerCase()]);
}

function kindOfAssetType(value) {
  return ASSET_TYPE_META[normalizeAssetType(value)].kind;
}

function defaultReferenceContentType(assetType) {
  return ASSET_TYPE_META[normalizeAssetType(assetType)].default_reference_content_type;
}

function removeDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

// Keeps only the characters Content ID accepts in a customId and caps it at 64 bytes.
function sanitizeCustomId(value) {
  let clean = removeDiacritics(cleanText(value)).replace(/\s+/g, "_").replace(/[^A-Za-z0-9._@/-]/g, "");
  while (clean && Buffer.byteLength(clean, "utf8") > CUSTOM_ID_MAX_BYTES) clean = clean.slice(0, -1);
  return clean;
}

// customId for a video asset without an ISRC: <prefix>_<12 random chars> (the convention of the
// older web-asset CSV page), unique enough per content owner and readable in CMS.
function buildVideoCustomId(prefix, random = null) {
  const cleanPrefix = sanitizeCustomId(prefix).replace(/[^A-Za-z0-9]/g, "") || "ANS";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = cleanText(random);
  if (!token) {
    const bytes = require("crypto").randomBytes(12);
    token = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  }
  return sanitizeCustomId(`${cleanPrefix.slice(0, 40)}_${token}`);
}

function assertMaxBytes(value, max, label) {
  if (Buffer.byteLength(value, "utf8") > max) throw badRequest(`${label} must be ${max} bytes or shorter`);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Fields every asset type accepts (description, notes, customId, infoUrl, upc).
function applyCommonMetadata(metadata, row) {
  const description = cleanText(row.description);
  if (description) {
    assertMaxBytes(description, DESCRIPTION_MAX_BYTES, "Description");
    metadata.description = description;
  }
  const customId = sanitizeCustomId(row.custom_id);
  if (customId) metadata.customId = customId;
  const notes = cleanText(row.notes);
  if (notes) {
    assertMaxBytes(notes, NOTES_MAX_BYTES, "Notes");
    metadata.notes = notes;
  }
  const infoUrl = cleanText(row.info_url ?? row.source_url);
  if (infoUrl) {
    if (!isHttpUrl(infoUrl)) throw badRequest("The official URL must start with http:// or https://");
    assertMaxBytes(infoUrl, INFO_URL_MAX_BYTES, "Official URL");
    metadata.infoUrl = infoUrl;
  }
  const rawUpc = cleanText(row.upc);
  if (rawUpc) {
    const upc = normalizeUpc(rawUpc);
    if (!upc) throw badRequest("Valid UPC is required");
    metadata.upc = upc;
  }
  return metadata;
}

// Web video asset: title + description/notes/customId/infoUrl (+ optional credits).
function buildWebMetadata(row = {}) {
  const title = cleanText(row.title);
  if (!title) throw badRequest("Title is required");
  assertMaxBytes(title, TITLE_MAX_BYTES, "Title");
  const metadata = applyCommonMetadata({ title }, row);
  const directors = splitList(row.director);
  if (directors.length) metadata.director = directors;
  const producers = splitList(row.producer);
  if (producers.length) metadata.producer = producers;
  return metadata;
}

// Music video asset: like a web video plus artist, optional ISRC and release date.
function buildMusicVideoMetadata(row = {}) {
  const title = cleanText(row.title);
  if (!title) throw badRequest("Title is required");
  assertMaxBytes(title, TITLE_MAX_BYTES, "Title");
  const metadata = { title };
  const artists = splitList(row.artist);
  if (artists.length) metadata.artist = artists;
  const rawIsrc = cleanText(row.isrc);
  if (rawIsrc) {
    const isrc = normalizeIsrc(rawIsrc);
    if (!isrc) throw badRequest("ISRC must be 12 alphanumeric characters");
    metadata.isrc = isrc;
  }
  const rawRelease = row.release_date;
  if (rawRelease !== undefined && rawRelease !== null && cleanText(rawRelease) !== "") {
    const releaseDate = parseReleaseDate(rawRelease);
    if (!releaseDate) throw badRequest("Release date must be YYYY-MM-DD");
    metadata.releaseDate = releaseDate;
  }
  applyCommonMetadata(metadata, row);
  const directors = splitList(row.director);
  if (directors.length) metadata.director = directors;
  const producers = splitList(row.producer);
  if (producers.length) metadata.producer = producers;
  return metadata;
}

// Album-level data lives in every sound recording asset (album, upc, label, releaseDate); video
// items carry their own description/URL and inherit the batch UPC/release date where the type
// allows it.
function buildProductMetadata(product = {}, track = {}) {
  const assetType = normalizeAssetType(product.asset_type);
  if (assetType === "web") {
    return buildWebMetadata({
      title: track.title,
      description: track.description,
      custom_id: track.custom_id,
      notes: track.notes || product.notes,
      info_url: track.source_url,
      director: track.director,
      producer: track.producer
    });
  }
  if (assetType === "music_video") {
    return buildMusicVideoMetadata({
      title: track.title,
      artist: track.artist || product.artist,
      isrc: track.isrc,
      upc: product.upc,
      release_date: product.release_date,
      description: track.description,
      custom_id: track.custom_id,
      notes: track.notes || product.notes,
      info_url: track.source_url
    });
  }
  return buildSoundRecordingMetadata({
    title: track.title,
    artist: track.artist,
    album: product.title,
    isrc: track.isrc,
    upc: product.upc,
    label: product.label,
    genre: product.genre,
    release_date: product.release_date,
    custom_id: track.custom_id,
    notes: track.notes || product.notes
  });
}

function buildOwnership({ mode, territories, contentOwnerId, ratio = 100 } = {}) {
  const owner = cleanText(contentOwnerId);
  if (!owner) throw badRequest("Content owner ID is required for ownership");

  const ownershipMode = cleanText(mode).toLowerCase() || "worldwide";
  const list = normalizeTerritories(territories);
  const share = Number(ratio);
  const cleanRatio = Number.isFinite(share) ? share : 100;

  let general;
  if (ownershipMode === "worldwide") {
    general = { ratio: cleanRatio, owner, type: "exclude", territories: [] };
  } else if (ownershipMode === "include") {
    if (!list.length) throw badRequest("Select at least one territory to include");
    general = { ratio: cleanRatio, owner, type: "include", territories: list };
  } else if (ownershipMode === "exclude") {
    general = { ratio: cleanRatio, owner, type: "exclude", territories: list };
  } else {
    throw badRequest(`Unknown ownership mode "${ownershipMode}"`);
  }

  return { kind: "youtubePartner#rightsOwnership", general: [general] };
}

function summarizePolicyRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  if (!list.length) return "";

  const parts = [];
  let hasReview = false;

  list.forEach((rule) => {
    if (!rule || typeof rule !== "object") return;
    const action = capitalize(rule.action) || "Rule";
    const territories = rule.conditions?.requiredTerritories;
    const codes = Array.isArray(territories?.territories) ? territories.territories.filter(Boolean) : [];
    let scope = "WW";
    if (codes.length) {
      const type = cleanText(territories.type).toLowerCase();
      scope = type === "exclude" ? `exclude ${codes.join(", ")}` : codes.join(", ");
    }
    parts.push(`${action} (${scope})`);

    const subactions = Array.isArray(rule.subaction) ? rule.subaction : [];
    if (subactions.some((item) => cleanText(item).toLowerCase() === "review")) hasReview = true;
  });

  if (hasReview) parts.push("review");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function googleReason(error) {
  return error?.response?.data?.error?.errors?.[0]?.reason
    || error?.response?.data?.error?.status
    || "";
}

// An answer that never arrived (timeout, dropped socket, 5xx) leaves it unknown whether Google
// applied the call. Re-sending is safe only when the call is idempotent: GET, PUT (ownership
// and match policy replace the whole resource) and the PATCH bodies this module sends (they
// replace one field: the label list, metadataMine or a status). Creates are retried only when
// Google explicitly refused the call with 429/503 (honouring Retry-After), because a second
// POST could create a second asset or reference.
function isRetryableError(error, idempotent) {
  const status = Number(error?.response?.status || 0);
  if (!idempotent) return SAFE_WRITE_RETRY_STATUSES.has(status);
  return TRANSIENT_HTTP_STATUSES.has(status) || TRANSIENT_ERROR_CODES.has(error?.code);
}

function isTimeoutError(error) {
  if (error?.response) return false;
  return TIMEOUT_ERROR_CODES.has(error?.code) || /timeout of \d+ms exceeded/i.test(String(error?.message || ""));
}

// Axios/Node describe transport failures in their own words ("timeout of 30000ms exceeded",
// "socket hang up"); operators read these in the track error and the delivery log, so say what
// happened in CMS terms. Returns "" when Google actually answered.
function transportMessage(error, timeoutMs) {
  if (!error || error.response) return "";
  if (isTimeoutError(error)) {
    const seconds = Math.max(1, Math.round((Number(timeoutMs) || 0) / 1000));
    return `Google Content ID did not respond within ${seconds} s`;
  }
  if (error.code === "ECONNRESET") return "The connection to Google Content ID was dropped before it answered";
  if (error.code === "EAI_AGAIN" || error.code === "ENOTFOUND") return "Google Content ID could not be reached (DNS lookup failed)";
  return "";
}

function retryDelayMs(error, attempt) {
  const retryAfter = Number(error?.response?.headers?.["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  }
  return Math.min(RETRY_BASE_MS * (2 ** attempt), MAX_RETRY_DELAY_MS);
}

function wrapError(error, fallbackMessage = "Google Content ID request failed", { message } = {}) {
  if (error && error.isAssetDeliveryError) return error;

  const googleMessage = cleanText(message) || getGoogleError(error) || fallbackMessage;
  const wrapped = new Error(googleMessage);
  wrapped.isAssetDeliveryError = true;
  wrapped.status = error?.status || error?.response?.status || undefined;
  wrapped.reason = googleReason(error) || error?.reason || "";
  wrapped.googleMessage = googleMessage;
  wrapped.code = error?.code;
  if (error?.cmsAuthFailed) wrapped.cmsAuthFailed = true;
  if (error?.networkId) wrapped.networkId = error.networkId;
  if (isTimeoutError(error)) wrapped.timedOut = true;
  const retryAfter = Number(error?.response?.headers?.["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) wrapped.retryAfter = retryAfter;
  return wrapped;
}

async function authContext(networkId) {
  const network = getConnectedNetwork(networkId);
  const accessToken = await getAccessToken(network);
  const contentOwnerId = cleanText(network.network_code);
  return { network, contentOwnerId, accessToken, tokenForRequest: (options) => getAccessToken(network, options) };
}

function isContext(value) {
  return Boolean(value && typeof value === "object" && value.accessToken && value.contentOwnerId);
}

async function resolveContext(networkIdOrContext) {
  return isContext(networkIdOrContext) ? networkIdOrContext : authContext(networkIdOrContext);
}

// Delivery observers receive only operational metadata. Never emit request headers,
// request/response bodies, tokens, or resumable-upload URLs.
function notifyApi(ctx, event) {
  if (typeof ctx?.onApiEvent !== "function") return;
  try {
    ctx.onApiEvent({ step: ctx.deliveryStep || "api", ...event });
  } catch {
    // A logging observer must not change the outcome of a CMS request.
  }
}

// The deadline of one attempt: a fixed `timeout` option wins, otherwise 30 s, or 60 s once an
// earlier attempt of this call ended in silence. `timeout: 0` disables the deadline (uploads).
function attemptTimeout(options, silentAttempts) {
  if (options.timeout !== undefined) return options.timeout;
  return DEFAULT_TIMEOUT * Math.min(silentAttempts + 1, 2);
}

// Options beyond the Axios pass-throughs:
//   retry: false        — disables retries after transport errors or temporary HTTP failures.
//   idempotent: boolean — whether a lost answer may be followed by a second identical call
//                         (defaults to the HTTP method semantics, see IDEMPOTENT_METHODS).
// A streamed body cannot be sent twice, so such a call always gets a single attempt.
async function request(ctx, method, path, options = {}) {
  const url = /^https?:\/\//i.test(path) ? path : `${PARTNER_API}${path}`;
  const config = {
    method: String(method || "GET").toUpperCase(),
    url,
    signal: ctx.signal,
    params: { onBehalfOfContentOwner: ctx.contentOwnerId, ...(options.params || {}) },
    headers: options.headers || {}
  };
  if (options.data !== undefined) config.data = options.data;
  if (options.maxBodyLength !== undefined) config.maxBodyLength = options.maxBodyLength;
  if (options.maxContentLength !== undefined) config.maxContentLength = options.maxContentLength;
  if (options.validateStatus) config.validateStatus = options.validateStatus;
  if (options.responseType) config.responseType = options.responseType;

  const idempotent = options.idempotent === undefined ? IDEMPOTENT_METHODS.has(config.method) : Boolean(options.idempotent);
  const replayable = !(options.data && typeof options.data.pipe === "function");
  const maxRetries = options.retry === false || !replayable ? 0 : MAX_ATTEMPTS - 1;
  const endpoint = new URL(url).pathname;
  let lastError;
  let lastTimeout = attemptTimeout(options, 0);
  let made = 0;
  let timedOut = 0;
  let retries = 0;
  let rejectedAccessToken;
  let refreshedAfterRejection = false;

  while (true) {
    ctx.signal?.throwIfAborted();
    const accessToken = ctx.tokenForRequest ? await ctx.tokenForRequest({ rejectedAccessToken }) : ctx.accessToken;
    rejectedAccessToken = undefined;
    const timeout = attemptTimeout(options, timedOut);
    lastTimeout = timeout;
    made += 1;
    const started = Date.now();
    const event = { method: config.method, endpoint, attempt: made, timeout_ms: timeout };
    notifyApi(ctx, { ...event, phase: "started" });
    try {
      const response = await axios.request({ ...config, timeout, headers: { ...config.headers, Authorization: `Bearer ${accessToken}` } });
      notifyApi(ctx, { ...event, phase: "completed", http_status: response.status, duration_ms: Date.now() - started });
      return response;
    } catch (error) {
      ctx.signal?.throwIfAborted();
      lastError = error;
      if (isTimeoutError(error)) timedOut += 1;
      notifyApi(ctx, { ...event, phase: "failed", http_status: Number(error?.response?.status || error?.status) || null,
        error_code: cleanText(error?.code) || null, duration_ms: Date.now() - started,
        message: wrapError(error, undefined, { message: transportMessage(error, timeout) }).message });
      // A 401 response rejected the request before applying it, including a create with a JSON body.
      if (error?.response?.status === 401 && replayable && ctx.tokenForRequest && !refreshedAfterRejection) {
        rejectedAccessToken = accessToken;
        refreshedAfterRejection = true;
        notifyApi(ctx, { ...event, phase: "retry", retry_delay_ms: 0 });
        continue;
      }
      if (retries >= maxRetries || timedOut >= MAX_TIMEOUT_ATTEMPTS || !isRetryableError(error, idempotent)) break;
      const delay = retryDelayMs(error, retries);
      retries += 1;
      notifyApi(ctx, { ...event, phase: "retry", retry_delay_ms: delay });
      await waitForRetry(delay, undefined, { signal: ctx.signal });
    }
  }

  const transport = transportMessage(lastError, lastTimeout);
  const message = transport
    ? `${transport} (${config.method} ${endpoint}${made > 1 ? `, ${made} attempts` : ""})`
    : "";
  const failure = wrapError(lastError, undefined, { message });
  failure.attempts = made;
  throw tagNetwork(failure, ctx);
}

// Keep the target network available to callers and delivery logs.
function tagNetwork(error, ctx) {
  if (error && ctx?.network?.id && !error.networkId) error.networkId = ctx.network.id;
  return error;
}

// ---------------------------------------------------------------------------
// Read helpers (policies, labels, owner, search)
// ---------------------------------------------------------------------------

async function listPolicies(networkIdOrContext) {
  const ctx = await resolveContext(networkIdOrContext);
  const response = await request(ctx, "GET", "/policies", { params: { sort: "TIME_UPDATED_DESC" } });
  const items = Array.isArray(response.data?.items) ? response.data.items : [];

  return items
    .map((item) => ({
      id: cleanText(item.id),
      name: cleanText(item.name),
      description: cleanText(item.description),
      time_updated: item.timeUpdated || "",
      rules: Array.isArray(item.rules) ? item.rules : [],
      summary: summarizePolicyRules(item.rules)
    }))
    .filter((item) => item.id)
    .sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
}

async function listAssetLabels(networkIdOrContext) {
  const ctx = await resolveContext(networkIdOrContext);
  const labels = new Set();
  let pageToken = "";

  for (let page = 0; page < ASSET_LABEL_MAX_PAGES; page += 1) {
    const response = await request(ctx, "GET", "/assetLabels", {
      params: pageToken ? { pageToken } : {}
    });
    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    items.forEach((item) => {
      const name = cleanText(item?.labelName);
      if (name) labels.add(name);
    });
    pageToken = cleanText(response.data?.nextPageToken);
    if (!pageToken) break;
  }

  return Array.from(labels).sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
}

async function createAssetLabel(networkIdOrContext, labelName) {
  const name = cleanText(labelName);
  if (!name) throw badRequest("Label name is required");

  const ctx = await resolveContext(networkIdOrContext);
  const response = await request(ctx, "POST", "/assetLabels", {
    data: { kind: "youtubePartner#assetLabel", labelName: name }
  });
  return { labelName: cleanText(response.data?.labelName) || name };
}

async function getContentOwnerInfo(networkIdOrContext) {
  const ctx = await resolveContext(networkIdOrContext);
  const response = await request(ctx, "GET", "/contentOwners", { params: { fetchMine: true } });
  const items = Array.isArray(response.data?.items) ? response.data.items : [];
  if (!items.length) return null;

  const owner = items.find((item) => cleanText(item?.id) === ctx.contentOwnerId) || items[0];
  return {
    id: cleanText(owner.id),
    display_name: cleanText(owner.displayName),
    emails: Array.isArray(owner.primaryNotificationEmails) ? owner.primaryNotificationEmails.filter(Boolean) : []
  };
}

async function searchAssetsByIsrc(networkIdOrContext, isrcs) {
  const codes = Array.from(new Set(splitList(isrcs).map(normalizeIsrc).filter(Boolean)));
  const matches = new Map();
  if (!codes.length) return matches;

  const ctx = await resolveContext(networkIdOrContext);
  const wanted = new Set(codes);

  for (let index = 0; index < codes.length; index += ASSET_SEARCH_CHUNK) {
    const chunk = codes.slice(index, index + ASSET_SEARCH_CHUNK);
    let pageToken = "";

    for (let page = 0; page < ASSET_SEARCH_MAX_PAGES; page += 1) {
      const params = { isrcs: chunk.join(","), ownershipRestriction: "NONE" };
      if (pageToken) params.pageToken = pageToken;
      const response = await request(ctx, "GET", "/assetSearch", { params });
      const items = Array.isArray(response.data?.items) ? response.data.items : [];

      items.forEach((item) => {
        const isrc = normalizeIsrc(item?.isrc);
        if (!isrc || !wanted.has(isrc)) return;
        if (!matches.has(isrc)) matches.set(isrc, []);
        matches.get(isrc).push({
          asset_id: cleanText(item.id),
          title: cleanText(item.title),
          isrc,
          custom_id: cleanText(item.customId),
          type: cleanText(item.type),
          time_created: item.timeCreated || ""
        });
      });

      pageToken = cleanText(response.data?.nextPageToken);
      if (!pageToken) break;
    }
  }

  return matches;
}

function settledError(result) {
  if (result.status === "fulfilled") return "";
  const error = result.reason;
  return error?.googleMessage || getGoogleError(error) || "Request failed";
}

async function getDeliveryOptions(networkId) {
  const ctx = await authContext(networkId);
  const [policies, assetLabels, contentOwner] = await Promise.allSettled([
    listPolicies(ctx),
    listAssetLabels(ctx),
    getContentOwnerInfo(ctx)
  ]);

  const errors = {};
  if (policies.status === "rejected") errors.policies = settledError(policies);
  if (assetLabels.status === "rejected") errors.asset_labels = settledError(assetLabels);
  if (contentOwner.status === "rejected") errors.content_owner = settledError(contentOwner);

  return {
    network: {
      id: ctx.network.id,
      name: ctx.network.name,
      network_code: ctx.network.network_code,
      cms_auth_email: ctx.network.cms_auth_email || ""
    },
    content_owner: contentOwner.status === "fulfilled" ? contentOwner.value : null,
    policies: policies.status === "fulfilled" ? policies.value : [],
    asset_labels: assetLabels.status === "fulfilled" ? assetLabels.value : [],
    errors
  };
}

// ---------------------------------------------------------------------------
// Asset writes
// ---------------------------------------------------------------------------

async function insertAsset(networkIdOrContext, assetType, metadata, labels = []) {
  if (!metadata || typeof metadata !== "object") throw badRequest("Metadata is required");
  if (!isAssetType(assetType)) throw badRequest(`Unsupported asset type "${cleanText(assetType)}"`);
  const ctx = await resolveContext(networkIdOrContext);
  const labelList = splitList(labels);
  const body = {
    kind: "youtubePartner#asset",
    type: normalizeAssetType(assetType),
    metadataMine: metadata,
    ...(labelList.length ? { label: labelList } : {})
  };
  const response = await request(ctx, "POST", "/assets", { data: body });
  return response.data || {};
}

function insertSoundRecordingAsset(networkIdOrContext, metadata, labels = []) {
  return insertAsset(networkIdOrContext, "sound_recording", metadata, labels);
}

async function updateOwnership(networkIdOrContext, assetId, ownership) {
  const id = cleanText(assetId);
  if (!id) throw badRequest("Asset ID is required");
  if (!ownership || !Array.isArray(ownership.general)) throw badRequest("Ownership is required");

  const ctx = await resolveContext(networkIdOrContext);
  const body = { kind: "youtubePartner#rightsOwnership", ...ownership };
  const response = await request(ctx, "PUT", `/assets/${encodeURIComponent(id)}/ownership`, { data: body });
  return response.data || {};
}

async function updateMatchPolicy(networkIdOrContext, assetId, { policy_id, rules } = {}) {
  const id = cleanText(assetId);
  if (!id) throw badRequest("Asset ID is required");

  const policyId = cleanText(policy_id);
  const ruleList = Array.isArray(rules) ? rules.filter(Boolean) : [];
  if (!policyId && !ruleList.length) throw badRequest("A match policy ID or policy rules are required");

  const ctx = await resolveContext(networkIdOrContext);
  const body = policyId
    ? { kind: "youtubePartner#assetMatchPolicy", policyId }
    : { kind: "youtubePartner#assetMatchPolicy", rules: ruleList };
  const response = await request(ctx, "PUT", `/assets/${encodeURIComponent(id)}/matchPolicy`, { data: body });
  return response.data || {};
}

async function patchAssetLabels(networkIdOrContext, assetId, labels) {
  const id = cleanText(assetId);
  if (!id) throw badRequest("Asset ID is required");

  const ctx = await resolveContext(networkIdOrContext);
  // The body replaces the whole label list, so a repeat after a lost answer is harmless.
  const response = await request(ctx, "PATCH", `/assets/${encodeURIComponent(id)}`, {
    data: { label: splitList(labels) },
    idempotent: true
  });
  return response.data || {};
}

async function patchAssetMetadata(networkIdOrContext, assetId, metadata) {
  const id = cleanText(assetId);
  if (!id) throw badRequest("Asset ID is required");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw badRequest("Metadata is required");

  const ctx = await resolveContext(networkIdOrContext);
  // metadataMine is replaced as a whole, so a repeat after a lost answer is harmless.
  const response = await request(ctx, "PATCH", `/assets/${encodeURIComponent(id)}`, {
    data: { metadataMine: metadata },
    idempotent: true
  });
  return response.data || {};
}

async function getAssetDetail(networkIdOrContext, assetId) {
  const id = cleanText(assetId);
  if (!id) throw badRequest("Asset ID is required");

  const ctx = await resolveContext(networkIdOrContext);
  const response = await request(ctx, "GET", `/assets/${encodeURIComponent(id)}`, {
    params: { fetchMetadata: "mine", fetchOwnership: "mine", fetchMatchPolicy: "mine" }
  });
  return response.data || {};
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function normalizeReferenceContentType(value, fallback = "audio") {
  const type = cleanText(value).toLowerCase();
  return REFERENCE_CONTENT_TYPES.has(type) ? type : fallback;
}

async function listReferences(networkIdOrContext, assetId) {
  const id = cleanText(assetId);
  if (!id) throw badRequest("Asset ID is required");

  const ctx = await resolveContext(networkIdOrContext);
  const references = [];
  let pageToken = "";

  for (let page = 0; page < REFERENCE_LIST_MAX_PAGES; page += 1) {
    const params = { assetId: id };
    if (pageToken) params.pageToken = pageToken;
    const response = await request(ctx, "GET", "/references", { params });
    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    references.push(...items);
    pageToken = cleanText(response.data?.nextPageToken);
    if (!pageToken) break;
  }

  return references;
}

async function createReferenceFromClaim(networkIdOrContext, assetId, claimId, contentType = "audio") {
  const id = cleanText(assetId);
  const claim = cleanText(claimId);
  if (!id) throw badRequest("Asset ID is required");
  if (!claim) throw badRequest("Claim ID is required");

  const ctx = await resolveContext(networkIdOrContext);
  const response = await request(ctx, "POST", "/references", {
    params: { claimId: claim },
    data: {
      kind: "youtubePartner#reference",
      assetId: id,
      contentType: normalizeReferenceContentType(contentType)
    }
  });
  return response.data || {};
}

async function uploadReferenceStream(networkIdOrContext, assetId, options = {}) {
  const id = cleanText(assetId);
  if (!id) throw badRequest("Asset ID is required");

  const { stream, mimeType, urgent = false, audioswapEnabled = false } = options;
  if (!stream || typeof stream.pipe !== "function") throw badRequest("A readable file stream is required");

  const contentLength = Number(options.contentLength);
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    throw badRequest("File size must be a positive integer number of bytes");
  }
  if (contentLength > MAX_REFERENCE_BYTES) {
    const error = new Error(`File is larger than the allowed ${Math.floor(MAX_REFERENCE_BYTES / (1024 * 1024))} MB`);
    error.status = 413;
    throw error;
  }

  const mime = cleanText(mimeType) || "application/octet-stream";
  const contentType = normalizeReferenceContentType(options.contentType);
  const ctx = await resolveContext(networkIdOrContext);

  const initiateBody = {
    kind: "youtubePartner#reference",
    assetId: id,
    contentType,
    urgent: Boolean(urgent)
  };
  if (audioswapEnabled) initiateBody.audioswapEnabled = true;

  // Initiating only opens an upload session; no reference exists until the bytes are sent, so
  // an initiation whose answer was lost can simply be repeated.
  const initiate = await request(ctx, "POST", `${PARTNER_UPLOAD_API}/references`, {
    params: { uploadType: "resumable" },
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Content-Type": mime,
      "X-Upload-Content-Length": String(contentLength)
    },
    data: initiateBody,
    idempotent: true
  });

  const headers = initiate.headers || {};
  const location = cleanText(headers.location || headers.Location);
  if (!location) throw badRequest("Google did not return a resumable upload session URL");

  // The access token can expire while the resumable session is being opened.
  const accessToken = ctx.tokenForRequest ? await ctx.tokenForRequest() : ctx.accessToken;
  let upload;
  const uploadStarted = Date.now();
  const uploadEvent = { method: "PUT", endpoint: "/references/upload", attempt: 1 };
  notifyApi(ctx, { ...uploadEvent, phase: "started", bytes_total: contentLength });
  let lastProgress = -1;
  try {
    upload = await axios.request({
      method: "PUT",
      url: location,
      data: stream,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mime,
        "Content-Length": String(contentLength)
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0,
      onUploadProgress: (progress) => {
        const loaded = Math.min(contentLength, Math.max(0, Number(progress.loaded) || 0));
        const percent = Math.min(100, Math.floor((loaded / contentLength) * 100));
        // Bound persistent logs to ten percentage milestones per file.
        const milestone = Math.floor(percent / 10);
        if (milestone <= lastProgress) return;
        lastProgress = milestone;
        notifyApi(ctx, { ...uploadEvent, phase: "progress", bytes_loaded: loaded, bytes_total: contentLength,
          percent, duration_ms: Date.now() - uploadStarted });
      },
      validateStatus: (status) => (status >= 200 && status < 300) || status === 308
    });
    if (upload.status === 308) throw badRequest("Upload was interrupted");
    notifyApi(ctx, { ...uploadEvent, phase: "completed", http_status: upload.status,
      duration_ms: Date.now() - uploadStarted, bytes_loaded: contentLength, bytes_total: contentLength, percent: 100 });
  } catch (error) {
    notifyApi(ctx, { ...uploadEvent, phase: "failed", http_status: Number(error?.response?.status || error?.status) || null,
      duration_ms: Date.now() - uploadStarted, message: wrapError(error, "Reference upload failed").message });
    throw tagNetwork(wrapError(error, "Reference upload failed"), ctx);
  }

  return upload.data || {};
}

async function getReference(networkIdOrContext, referenceId) {
  const id = cleanText(referenceId);
  if (!id) throw badRequest("Reference ID is required");

  const ctx = await resolveContext(networkIdOrContext);
  const response = await request(ctx, "GET", `/references/${encodeURIComponent(id)}`);
  return response.data || {};
}

// Google refuses a status that is already set (references.patch: 400 permanentFailure /
// invalidReferenceState; claims.patch: 400 invalidStatusTransition). After a PATCH whose first
// answer was lost, or when someone else got there first, that refusal means the resource is
// already where we wanted it: read it back and treat the call as done. A failed read-back
// leaves the original error in place.
async function settledDespiteRefusal(error, read, isSettled) {
  if (Number(error?.status) !== 400) return null;
  try {
    const current = await read();
    return isSettled(current) ? current : null;
  } catch {
    return null;
  }
}

// Only `status` (and excludedIntervals) are patchable on a reference. Setting it inactive with
// releaseClaims=true also releases every claim that reference created (takedown).
async function patchReferenceStatus(networkIdOrContext, referenceId, status, { releaseClaims = false } = {}) {
  const id = cleanText(referenceId);
  if (!id) throw badRequest("Reference ID is required");

  const nextStatus = cleanText(status).toLowerCase();
  if (!REFERENCE_PATCH_STATUSES.has(nextStatus)) throw badRequest("Reference status must be \"active\" or \"inactive\"");

  const ctx = await resolveContext(networkIdOrContext);
  const params = {};
  if (releaseClaims === true) params.releaseClaims = true;
  // A repeat after a lost answer never changes CMS state; at worst Google refuses it because the
  // status is already set, which the read-back below recognises.
  try {
    const response = await request(ctx, "PATCH", `/references/${encodeURIComponent(id)}`, {
      params,
      data: { status: nextStatus },
      idempotent: true
    });
    return response.data || {};
  } catch (error) {
    const wanted = nextStatus === "inactive" ? isDeadReferenceStatus : isLiveReferenceStatus;
    const settled = await settledDespiteRefusal(error, () => getReference(ctx, id), (reference) => wanted(reference?.status));
    if (settled) return settled;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

function normalizeClaim(item = {}) {
  const origin = item?.origin && typeof item.origin === "object" ? item.origin.source : item?.origin;
  return {
    claim_id: cleanText(item?.id),
    video_id: cleanText(item?.videoId),
    status: cleanText(item?.status).toLowerCase(),
    content_type: cleanText(item?.contentType).toLowerCase(),
    origin: cleanText(origin),
    video_title: cleanText(item?.videoTitle),
    time_created: item?.timeCreated || "",
    time_status_last_modified: item?.timeStatusLastModified || ""
  };
}

async function searchClaimsByAsset(networkIdOrContext, assetId, { status } = {}) {
  const id = cleanText(assetId);
  if (!id) throw badRequest("Asset ID is required");

  const ctx = await resolveContext(networkIdOrContext);
  const claims = [];
  const wantedStatus = cleanText(status).toLowerCase();
  let pageToken = "";

  for (let page = 0; page < CLAIM_SEARCH_MAX_PAGES; page += 1) {
    const params = { assetId: id, includeThirdPartyClaims: false };
    if (wantedStatus) params.status = wantedStatus;
    if (pageToken) params.pageToken = pageToken;
    const response = await request(ctx, "GET", "/claimSearch", { params });
    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    items.forEach((item) => {
      const claim = normalizeClaim(item);
      if (claim.claim_id) claims.push(claim);
    });
    pageToken = cleanText(response.data?.nextPageToken);
    if (!pageToken) break;
  }

  return claims;
}

async function getClaim(networkIdOrContext, claimId) {
  const id = cleanText(claimId);
  if (!id) throw badRequest("Claim ID is required");

  const ctx = await resolveContext(networkIdOrContext);
  const response = await request(ctx, "GET", `/claims/${encodeURIComponent(id)}`);
  return response.data || {};
}

// Sets a claim's status. A repeat after a lost answer never changes CMS state; at worst Google
// refuses the same -> same transition, which the read-back below recognises as already done. The
// resource then carries `<refusedFlag>: true` so the caller can tell "Google changed it now" from
// "it was already there"; a refusal for another reason (the claim is disputed, taken down, …)
// keeps the read-back on `error.currentClaim` for the caller's message.
async function patchClaimStatus(networkIdOrContext, claimId, status, refusedFlag) {
  const id = cleanText(claimId);
  if (!id) throw badRequest("Claim ID is required");

  const ctx = await resolveContext(networkIdOrContext);
  try {
    const response = await request(ctx, "PATCH", `/claims/${encodeURIComponent(id)}`, {
      data: { status },
      idempotent: true
    });
    return response.data || {};
  } catch (error) {
    if (Number(error?.status) !== 400) throw error;
    let current = null;
    try {
      current = await getClaim(ctx, id);
    } catch {
      // The read-back did not answer either: the refusal stands as Google worded it.
    }
    if (current && cleanText(current.status).toLowerCase() === status) {
      // The refused call was a repeat of an attempt of this very request that Google applied but
      // never answered: that is this call's own work, not somebody else's.
      if (Number(error?.attempts) > 1) return { ...current, appliedOnEarlierAttempt: true };
      return { ...current, [refusedFlag]: true };
    }
    if (current && typeof current === "object") error.currentClaim = current;
    throw error;
  }
}

// Release: active/pending/potential -> inactive.
async function releaseClaim(networkIdOrContext, claimId) {
  return patchClaimStatus(networkIdOrContext, claimId, "inactive", "releaseRefused");
}

// Reinstate a released claim: inactive -> active (Google allows it when the content owner may;
// disputed claims cannot be reinstated through the API).
async function reinstateClaim(networkIdOrContext, claimId) {
  return patchClaimStatus(networkIdOrContext, claimId, "active", "reinstateRefused");
}

// Confirm a potential claim: potential -> active (Google's "confirming a potential claim" through claims.patch).
async function confirmClaim(networkIdOrContext, claimId) {
  return patchClaimStatus(networkIdOrContext, claimId, "active", "confirmRefused");
}

// ---------------------------------------------------------------------------
// Orchestration: one sound recording through insert → ownership → policy → labels
// ---------------------------------------------------------------------------

async function runSoundRecordingSteps(networkIdOrContext, plan = {}, hooks = {}) {
  const steps = {
    insert: false,
    ownership: false,
    policy: false,
    labels: false,
    ...(plan.steps_done && typeof plan.steps_done === "object" ? plan.steps_done : {})
  };
  const responses = {};
  const labels = splitList(plan.labels);
  const policyId = cleanText(plan.match_policy_id);
  const policyRules = Array.isArray(plan.match_policy_rules) ? plan.match_policy_rules.filter(Boolean) : [];
  let assetId = cleanText(plan.asset_id);
  let step = "";
  let error = null;

  const notify = (name, ok, data) => {
    if (typeof hooks.onStep === "function") {
      try {
        hooks.onStep(name, ok, data);
      } catch {
        // hooks must never break the pipeline
      }
    }
  };

  const runStep = async (name, work) => {
    step = name;
    if (typeof hooks.onStepStart === "function") {
      try { hooks.onStepStart(name); } catch { /* observers must not break delivery */ }
    }
    try {
      const data = await work();
      steps[name] = true;
      responses[name] = data;
      notify(name, true, data);
      return true;
    } catch (stepError) {
      const wrapped = wrapError(stepError);
      error = {
        step: name,
        message: wrapped.message,
        status: wrapped.status || null,
        reason: wrapped.reason || ""
      };
      notify(name, false, wrapped);
      return false;
    }
  };

  let ctx = null;
  const withContext = async () => {
    if (!ctx) ctx = await resolveContext(networkIdOrContext);
    return { ...ctx, deliveryStep: step };
  };

  const insertedNow = !assetId;
  if (!assetId) {
    const ok = await runStep("insert", async () => {
      if (!plan.metadata || typeof plan.metadata !== "object") throw badRequest("Metadata is required");
      const asset = await insertAsset(await withContext(), plan.asset_type || DEFAULT_ASSET_TYPE, plan.metadata, labels);
      assetId = cleanText(asset?.id);
      if (!assetId) throw badRequest("Google did not return an asset ID");
      return asset;
    });
    if (!ok) return { asset_id: assetId, steps, responses, step, error };
  } else {
    steps.insert = true;
  }

  if (!steps.ownership) {
    if (plan.ownership && Array.isArray(plan.ownership.general)) {
      const ok = await runStep("ownership", async () => updateOwnership(await withContext(), assetId, plan.ownership));
      if (!ok) return { asset_id: assetId, steps, responses, step, error };
    } else {
      steps.ownership = true;
    }
  }

  if (!steps.policy) {
    if (policyId || policyRules.length) {
      const ok = await runStep("policy", async () => updateMatchPolicy(await withContext(), assetId, {
        policy_id: policyId,
        rules: policyRules
      }));
      if (!ok) return { asset_id: assetId, steps, responses, step, error };
    } else {
      steps.policy = true;
    }
  }

  if (!steps.labels) {
    if (!labels.length || insertedNow) {
      // labels were sent on insert (or there are none) - nothing left to do
      steps.labels = true;
    } else {
      const ok = await runStep("labels", async () => patchAssetLabels(await withContext(), assetId, labels));
      if (!ok) return { asset_id: assetId, steps, responses, step, error };
    }
  }

  return { asset_id: assetId, steps, responses, step, error };
}

module.exports = {
  PARTNER_API,
  PARTNER_UPLOAD_API,
  DEFAULT_TIMEOUT,
  MAX_REFERENCE_BYTES,
  LIVE_REFERENCE_STATUSES,
  DEAD_REFERENCE_STATUSES,
  authContext,
  buildCustomId,
  ASSET_TYPE_META,
  CUSTOM_ID_MAX_BYTES,
  DEFAULT_ASSET_TYPE,
  DESCRIPTION_MAX_BYTES,
  INFO_URL_MAX_BYTES,
  NOTES_MAX_BYTES,
  TITLE_MAX_BYTES,
  buildMusicVideoMetadata,
  buildOwnership,
  buildProductMetadata,
  buildSoundRecordingMetadata,
  buildVideoCustomId,
  buildWebMetadata,
  confirmClaim,
  createAssetLabel,
  createReferenceFromClaim,
  defaultReferenceContentType,
  getAssetDetail,
  getClaim,
  getContentOwnerInfo,
  getDeliveryOptions,
  getReference,
  insertAsset,
  insertSoundRecordingAsset,
  isAssetType,
  isDeadReferenceStatus,
  isHttpUrl,
  isLiveReferenceStatus,
  isValidIsrc,
  isValidUpc,
  kindOfAssetType,
  normalizeAssetType,
  listAssetLabels,
  listPolicies,
  listReferences,
  mapWithConcurrency,
  normalizeIsrc,
  normalizeReferenceContentType,
  normalizeUpc,
  parseReleaseDate,
  // The shared Partner API client (retries, deadlines, observers) for other CMS features.
  partnerRequest: request,
  patchAssetLabels,
  patchAssetMetadata,
  patchReferenceStatus,
  releaseClaim,
  reinstateClaim,
  resolveContext,
  runAssetSteps: runSoundRecordingSteps,
  runSoundRecordingSteps,
  sanitizeCustomId,
  searchAssetsByIsrc,
  searchClaimsByAsset,
  splitList,
  summarizePolicyRules,
  toDateOnly,
  updateMatchPolicy,
  updateOwnership,
  uploadReferenceStream
};
