// Pure database helpers for CMS Delivery products/tracks/events. No req/res in here: the
// controller and the background delivery job both build on these.
const db = require("../config/database");
const service = require("./assetDeliveryService");
const media = require("./deliveryMediaService");
const { getGoogleError } = require("./googleContentIdService");

const EVENT_LIMIT = 100;
const STEP_KEYS = ["insert", "ownership", "policy", "labels", "reference"];
// Tracks a delivery run is still working on (or was working on when the process died).
const IN_FLIGHT_TRACK_STATUSES = new Set(["creating", "uploading"]);
const AUTH_HINT = "Re-authorize this CMS in Settings > Network.";
// The Partner API reports an exhausted project quota and per-user rate limits as HTTP 403 with
// one of these reasons; they are not a permissions problem and clear on their own.
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"]);
const QUOTA_HINT = "Content ID API quota or rate limit reached for this project; wait for the reset or raise the quota in Google Cloud.";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function cleanText(value) {
  return String(value ?? "").trim();
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeSteps(value) {
  const source = isObject(value) ? value : {};
  const steps = {};
  STEP_KEYS.forEach((key) => {
    steps[key] = Boolean(source[key]);
  });
  return steps;
}

function refStatus(reference) {
  return cleanText(reference?.status).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Errors: message / HTTP status mapping shared by the controller and the job
// ---------------------------------------------------------------------------

function upstreamStatus(error) {
  return Number(error?.status || error?.response?.status || 0);
}

function rawErrorMessage(error) {
  return error?.googleMessage || getGoogleError(error || {}) || "Request failed";
}

function isQuotaReason(reason) {
  return QUOTA_REASONS.has(cleanText(reason));
}

// The reason of a Google error: the shared client copies it onto the wrapped error, a raw Axios
// error still carries it in the response body.
function errorReason(error) {
  return cleanText(error?.reason) || cleanText(error?.response?.data?.error?.errors?.[0]?.reason);
}

// A Google 401 must never surface as our own 401 (the frontend treats 401 as an expired app
// session); it becomes an actionable message and, through noteCmsAuthFailure, a re-auth flag.
// A quota 403 is not a permissions problem, so it gets the quota hint instead.
function errorMessage(error) {
  const status = upstreamStatus(error);
  const message = rawErrorMessage(error);
  if (status === 401) return `CMS authorization failed: ${message.replace(/[.\s]+$/, "")}. ${AUTH_HINT}`;
  if (status === 403 && isQuotaReason(errorReason(error))) return message.startsWith(QUOTA_HINT) ? message : `${QUOTA_HINT} (${message})`;
  if (status === 403 && !/^CMS permission denied: /.test(message)) return `CMS permission denied: ${message}`;
  return message;
}

function errorStatus(error) {
  const status = upstreamStatus(error);
  if (status === 401) return 424;
  return status >= 400 && status < 600 ? status : 400;
}

// Marks the network as needing re-authorization when Google rejected its token.
function noteCmsAuthFailure(error, networkId) {
  if (upstreamStatus(error) !== 401) return false;
  const id = parseId(networkId || error?.networkId);
  if (!id) return false;
  db.prepare(`
    UPDATE networks
    SET cms_auth_status = 'error', cms_auth_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(rawErrorMessage(error), id);
  return true;
}

// ---------------------------------------------------------------------------
// Rows: read + parse
// ---------------------------------------------------------------------------

function getProductRow(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare("SELECT * FROM content_id_delivery_products WHERE id = ?").get(id) || null;
}

function getTrackRow(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare("SELECT * FROM content_id_delivery_tracks WHERE id = ?").get(id) || null;
}

function listTrackRows(productId) {
  return db.prepare(`
    SELECT * FROM content_id_delivery_tracks
    WHERE product_id = ?
    ORDER BY track_number ASC, id ASC
  `).all(productId);
}

// Step-by-step delivery logging (one row per API call, step, progress tick) is kept out of the
// product timeline; the log viewer shows it with filters and paging.
const VERBOSE_EVENT_ACTIONS = new Set(["api", "delivery_step", "delivery_progress", "track_delivery"]);
const EVENT_SELECT = `
  SELECT e.*, t.title AS track_title, t.track_number AS track_number
  FROM content_id_delivery_events e
  LEFT JOIN content_id_delivery_tracks t ON t.id = e.track_id
`;

// The timeline shows outcomes: verbose trace rows and intermediate "started" rows (other than
// the start of a delivery run) stay in the log viewer.
function listEventRows(productId) {
  const placeholders = Array.from(VERBOSE_EVENT_ACTIONS, () => "?").join(", ");
  return db.prepare(`
    ${EVENT_SELECT}
    WHERE e.product_id = ?
      AND e.action NOT IN (${placeholders})
      AND NOT (e.status = 'started' AND e.action != 'deliver')
    ORDER BY e.id DESC
    LIMIT ?
  `).all(productId, ...VERBOSE_EVENT_ACTIONS, EVENT_LIMIT);
}

const RUN_ID_SQL = "json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END, '$.run_id')";

// Action groups the log viewer can filter by (a plain action name is accepted as well).
const EVENT_ACTION_GROUPS = {
  delivery: ["deliver", "delivery_step", "track_delivery", "delivery_progress", "delivery_interrupted", "retry"],
  api: ["api"],
  reference: ["reference_upload", "reference_from_claim", "reference_cleanup"],
  audio: ["audio_upload", "audio_delete", "audio_cleanup", "reference_cleanup"],
  management: ["create", "sync", "metadata_update", "rights_update", "takedown", "reactivate", "delete"]
};

function eventFilterClauses(productId, { trackId, status, action, runId, search } = {}) {
  const clauses = ["e.product_id = ?"];
  const values = [productId];
  if (parseId(trackId)) { clauses.push("e.track_id = ?"); values.push(parseId(trackId)); }
  const wantedStatus = cleanText(status).toLowerCase();
  if (wantedStatus === "error") {
    clauses.push("e.status IN ('error', 'failed')");
  } else if (wantedStatus) {
    clauses.push("e.status = ?");
    values.push(wantedStatus);
  }
  const wantedAction = cleanText(action);
  if (wantedAction) {
    const group = EVENT_ACTION_GROUPS[wantedAction.toLowerCase()];
    if (group) {
      clauses.push(`e.action IN (${group.map(() => "?").join(", ")})`);
      values.push(...group);
    } else {
      clauses.push("e.action = ?");
      values.push(wantedAction);
    }
  }
  if (cleanText(runId)) {
    clauses.push(`${RUN_ID_SQL} = ?`);
    values.push(cleanText(runId));
  }
  const term = cleanText(search);
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
    clauses.push("(e.message LIKE ? ESCAPE '\\' OR e.action LIKE ? ESCAPE '\\' OR COALESCE(e.payload_json, '') LIKE ? ESCAPE '\\' OR COALESCE(t.title, '') LIKE ? ESCAPE '\\')");
    values.push(like, like, like, like);
  }
  return { clauses, values };
}

// Stable id cursors let the log viewer fetch older pages and poll new entries without
// missing events when several concurrent tracks finish within the same second.
function listEvents(productId, { beforeId, afterId, trackId, status, action, runId, search, limit = EVENT_LIMIT } = {}) {
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || EVENT_LIMIT));
  const { clauses, values } = eventFilterClauses(productId, { trackId, status, action, runId, search });
  if (parseId(beforeId)) { clauses.push("e.id < ?"); values.push(parseId(beforeId)); }
  if (parseId(afterId)) { clauses.push("e.id > ?"); values.push(parseId(afterId)); }
  const rows = db.prepare(`${EVENT_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY e.id ${parseId(afterId) ? "ASC" : "DESC"} LIMIT ?`)
    .all(...values, pageSize + 1);
  const hasMore = rows.length > pageSize;
  const events = rows.slice(0, pageSize).map(parseEventRow);
  return {
    events,
    has_more: hasMore,
    next_before_id: events.length ? Math.min(...events.map((event) => event.id)) : null,
    latest_id: events.length ? Math.max(...events.map((event) => event.id)) : (parseId(afterId) || null)
  };
}

// Walks every matching event oldest → newest in chunks (log export). `maxRows` bounds the walk.
function* iterateEvents(productId, filters = {}, { chunk = 500, maxRows = 50000 } = {}) {
  let afterId = 0;
  let produced = 0;
  const { clauses, values } = eventFilterClauses(productId, filters);
  const statement = db.prepare(`${EVENT_SELECT} WHERE ${clauses.join(" AND ")} AND e.id > ? ORDER BY e.id ASC LIMIT ?`);
  while (produced < maxRows) {
    const rows = statement.all(...values, afterId, Math.min(chunk, maxRows - produced));
    if (!rows.length) return;
    for (const row of rows) {
      produced += 1;
      afterId = row.id;
      yield parseEventRow(row);
    }
  }
}

function countEvents(productId, filters = {}) {
  const { clauses, values } = eventFilterClauses(productId, filters);
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM content_id_delivery_events e LEFT JOIN content_id_delivery_tracks t ON t.id = e.track_id WHERE ${clauses.join(" AND ")}`)
    .get(...values)?.count) || 0;
}

// One entry per delivery run (the "deliver" started/finished pair shares a run_id), newest first.
function listDeliveryRuns(productId, { limit = 50 } = {}) {
  const rows = db.prepare(`
    ${EVENT_SELECT}
    WHERE e.product_id = ? AND e.action IN ('deliver', 'delivery_interrupted')
    ORDER BY e.id ASC
  `).all(productId).map(parseEventRow);
  const runs = new Map();
  rows.forEach((event) => {
    const payload = isObject(event.payload) ? event.payload : {};
    const runId = cleanText(payload.run_id);
    if (!runId) return;
    if (!runs.has(runId)) {
      runs.set(runId, {
        run_id: runId,
        started_at: null,
        finished_at: null,
        status: "running",
        track_ids: [],
        track_count: 0,
        summary: null,
        duration_ms: null,
        message: "",
        created_by_name: event.created_by_name || null,
        include_reference: null,
        delete_reference_after_delivery: null,
        first_event_id: event.id,
        last_event_id: event.id
      });
    }
    const run = runs.get(runId);
    run.last_event_id = event.id;
    if (event.action === "delivery_interrupted") {
      run.status = "interrupted";
      run.finished_at = event.created_at;
      run.message = event.message || "";
      return;
    }
    if (event.status === "started") {
      run.started_at = event.created_at;
      run.track_ids = toArray(payload.track_ids).map(Number).filter(Number.isFinite);
      run.track_count = run.track_ids.length;
      run.include_reference = payload.include_reference ?? null;
      run.delete_reference_after_delivery = payload.delete_reference_after_delivery ?? null;
      run.message = event.message || "";
      return;
    }
    run.finished_at = event.created_at;
    run.status = event.status === "error" ? "error" : "completed";
    run.summary = isObject(payload.summary) ? payload.summary : null;
    run.duration_ms = Number.isFinite(Number(payload.duration_ms)) ? Number(payload.duration_ms) : null;
    run.message = event.message || run.message;
    if (!run.track_count && Array.isArray(payload.results)) run.track_count = payload.results.length;
  });
  // `sequence` is the absolute run number (1 = first delivery) so labels stay stable when the
  // list is cut to the newest `limit` runs.
  const ordered = Array.from(runs.values()).map((run, index) => ({ ...run, sequence: index + 1 }));
  return { runs: ordered.reverse().slice(0, Math.max(1, Number(limit) || 50)), total: ordered.length };
}

function normalizeOwnershipInput(value) {
  const source = isObject(value) ? value : {};
  const mode = cleanText(source.mode).toLowerCase() || "worldwide";
  const territories = service.splitList(source.territories)
    .map((code) => code.toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));
  return { mode, territories: mode === "worldwide" ? [] : territories };
}

function parseProductRow(row) {
  if (!row) return null;
  const { asset_labels: assetLabels, ownership_json: ownershipJson, ...rest } = row;
  const assetType = service.normalizeAssetType(row.asset_type);
  return {
    ...rest,
    asset_type: assetType,
    kind: service.kindOfAssetType(assetType),
    reference_urgent: Boolean(row.reference_urgent),
    delete_reference_after_delivery: Boolean(row.delete_reference_after_delivery),
    skip_duplicates: Boolean(row.skip_duplicates),
    include_reference: row.include_reference === undefined || row.include_reference === null
      ? true
      : Boolean(row.include_reference),
    asset_labels: service.splitList(parseJson(assetLabels, [])),
    ownership: normalizeOwnershipInput(parseJson(ownershipJson, null))
  };
}

function parseTrackLabels(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseJson(value, null);
  return Array.isArray(parsed) ? service.splitList(parsed) : null;
}

function parseTrackRow(row) {
  if (!row) return null;
  const {
    asset_labels: assetLabels,
    metadata_json: metadataJson,
    ownership_json: ownershipJson,
    steps_json: stepsJson,
    response_json: responseJson,
    duplicate_json: duplicateJson,
    cms_json: cmsJson,
    ...rest
  } = row;

  return {
    ...rest,
    asset_labels: parseTrackLabels(assetLabels),
    steps: normalizeSteps(parseJson(stepsJson, {})),
    metadata: parseJson(metadataJson, null),
    ownership: parseJson(ownershipJson, null),
    response: parseJson(responseJson, null),
    duplicates: toArray(parseJson(duplicateJson, [])),
    cms: parseJson(cmsJson, null),
    has_audio: Boolean(media.resolveTrackAudio(row))
  };
}

function parseEventRow(row) {
  const { payload_json: payloadJson, ...rest } = row;
  return { ...rest, payload: parseJson(payloadJson, null) };
}

function getProductDetail(id) {
  const row = getProductRow(id);
  if (!row) return null;
  const product = parseProductRow(row);
  product.tracks = listTrackRows(id).map(parseTrackRow);
  product.events = listEventRows(id).map(parseEventRow);
  return product;
}

function getTrackParsed(id) {
  return parseTrackRow(getTrackRow(id));
}

function hasLiveReference(track) {
  return Boolean(cleanText(track?.reference_id)) && service.isLiveReferenceStatus(track?.reference_status);
}

function assetStepsDone(track) {
  const steps = normalizeSteps(track?.steps ?? parseJson(track?.steps_json, {}));
  return Boolean(cleanText(track?.asset_id)) && steps.insert && steps.ownership && steps.policy && steps.labels;
}

// The stored audio may be removed from this server only once CMS holds a live reference for a
// fully delivered track (the job's opt-in cleanup and the manual "free storage" action agree).
function isAudioReleasable(track) {
  return Boolean(cleanText(track?.file_path)) && track?.status === "completed" && assetStepsDone(track) && hasLiveReference(track);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function redactLogText(value) {
  return String(value)
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:access_token|refresh_token|id_token|upload_id|key|token|signature)=)[^\s&#"']+/gi, "$1[redacted]")
    .slice(0, 8000);
}

function safeLogPayload(value, depth = 0) {
  if (depth > 10) return "[omitted]";
  if (typeof value === "string") return redactLogText(value);
  if (Array.isArray(value)) return value.map((item) => safeLogPayload(item, depth + 1));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:authorization|access.?token|refresh.?token|id.?token|client.?secret|password|cookie|upload.?url)/i.test(key)
      ? "[redacted]" : safeLogPayload(item, depth + 1)]));
}

function logEvent(productId, { track_id = null, action, status = "ok", message = "", payload = null, actor = {} } = {}) {
  db.prepare(`
    INSERT INTO content_id_delivery_events (
      product_id, track_id, action, status, message, payload_json, created_by, created_by_name
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId,
    track_id || null,
    action,
    status,
    redactLogText(cleanText(message)) || null,
    payload === null || payload === undefined ? null : JSON.stringify(safeLogPayload(payload)),
    actor.created_by || null,
    actor.created_by_name || null
  );
}

// ---------------------------------------------------------------------------
// Product counters / status
// ---------------------------------------------------------------------------

// Tracks still in flight are counted as not delivered so an interrupted run never makes a
// product look finished (or empty).
function countTracks(tracks) {
  const counters = {
    track_count: tracks.length,
    delivered_count: 0,
    completed_count: 0,
    error_count: 0,
    taken_down_count: 0,
    duplicate_count: 0,
    in_flight_count: 0
  };
  tracks.forEach((track) => {
    const inFlight = IN_FLIGHT_TRACK_STATUSES.has(track.status);
    if (inFlight) counters.in_flight_count += 1;
    if (cleanText(track.asset_id) && !inFlight) counters.delivered_count += 1;
    if (track.status === "completed") counters.completed_count += 1;
    if (track.status === "error") counters.error_count += 1;
    if (track.status === "taken_down") counters.taken_down_count += 1;
    if (track.status === "duplicate") counters.duplicate_count += 1;
  });
  return counters;
}

// Recomputes the product counters/status from its tracks. While a delivery is running the
// product stays "delivering" unless the caller finalizes the run.
function recomputeProduct(productId, { finalize = false } = {}) {
  const row = getProductRow(productId);
  if (!row) return null;

  const tracks = listTrackRows(productId);
  const counters = countTracks(tracks);
  const trackCount = counters.track_count;
  const delivered = counters.delivered_count;
  const errors = counters.error_count;

  let status;
  if (row.status === "delivering" && !finalize) status = "delivering";
  else if (!trackCount) status = "draft";
  else if (counters.taken_down_count === trackCount) status = "taken_down";
  else if (delivered === trackCount && !errors) status = "delivered";
  else if (delivered > 0 || counters.in_flight_count > 0) status = "partial";
  else if (errors > 0) status = "error";
  else if (counters.duplicate_count > 0) status = "partial";
  else status = "draft";

  const firstError = errors ? tracks.find((track) => track.status === "error") : null;

  db.prepare(`
    UPDATE content_id_delivery_products
    SET track_count = ?,
        delivered_count = ?,
        completed_count = ?,
        error_count = ?,
        status = ?,
        error_message = ?,
        delivered_at = CASE WHEN ? > 0 THEN COALESCE(delivered_at, CURRENT_TIMESTAMP) ELSE delivered_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(trackCount, delivered, counters.completed_count, errors, status, firstError?.error_message || null, delivered, productId);

  return getProductRow(productId);
}

function startProductJob(productId, { includeReference = null, deleteReferenceAfterDelivery = null } = {}) {
  db.prepare(`
    UPDATE content_id_delivery_products
    SET status = 'delivering',
        include_reference = COALESCE(?, include_reference),
        delete_reference_after_delivery = COALESCE(?, delete_reference_after_delivery),
        error_message = NULL,
        job_started_at = ?,
        job_finished_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    includeReference === null || includeReference === undefined ? null : (includeReference ? 1 : 0),
    deleteReferenceAfterDelivery === null || deleteReferenceAfterDelivery === undefined ? null : (deleteReferenceAfterDelivery ? 1 : 0),
    nowIso(),
    productId
  );
}

function setProductNetworkInfo(productId, { contentOwnerId = null, networkName = null } = {}) {
  db.prepare(`
    UPDATE content_id_delivery_products
    SET content_owner_id = COALESCE(?, content_owner_id),
        network_name = COALESCE(?, network_name),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(contentOwnerId || null, networkName || null, productId);
}

function finishProductJob(productId, { errorMessage: message = null } = {}) {
  recomputeProduct(productId, { finalize: true });
  db.prepare(`
    UPDATE content_id_delivery_products
    SET job_finished_at = ?,
        error_message = COALESCE(?, error_message),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nowIso(), message || null, productId);
  return getProductRow(productId);
}

// ---------------------------------------------------------------------------
// Code library
// ---------------------------------------------------------------------------

// Mirrors saveProduct in contentIdController: mark an existing library code as used or insert a
// used row. The legacy product_id/track_id columns point at the old Product Manager tables, so
// they stay NULL for delivery products (an existing legacy link is left untouched).
function markCodeUsed(type, code, { album_title = null, song_title = null, artist = null } = {}) {
  const clean = cleanText(code);
  if (!clean) return;
  try {
    const updated = db.prepare(`
      UPDATE content_id_codes
      SET status = 'used',
          album_title = ?,
          song_title = ?,
          artist = ?,
          used_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE type = ? AND code = ?
    `).run(album_title || null, song_title || null, artist || null, type, clean);
    if (!updated.changes) {
      db.prepare(`
        INSERT INTO content_id_codes (
          type, code, status, album_title, song_title, artist, product_id, track_id, used_at
        )
        VALUES (?, ?, 'used', ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
      `).run(type, clean, album_title || null, song_title || null, artist || null);
    }
  } catch {
    // the same code exists under another type; the CMS asset is what matters here
  }
}

function markTrackIsrcUsed(product, track) {
  markCodeUsed("ISRC", track.isrc, { album_title: product.title, song_title: track.title, artist: track.artist });
}

function markProductUpcUsed(product) {
  const upc = service.normalizeUpc(product.upc);
  if (!upc) return;
  markCodeUsed("UPC", upc, { album_title: product.title, song_title: null, artist: product.artist });
}

// ---------------------------------------------------------------------------
// Track state transitions used by deliver / retry / reference upload
// ---------------------------------------------------------------------------

function buildTrackPlan(product, track, contentOwnerId) {
  const metadata = service.buildProductMetadata(product, track);
  const labels = track.asset_labels ?? product.asset_labels;
  const ownership = service.buildOwnership({ ...product.ownership, contentOwnerId });
  const steps = normalizeSteps(track.steps);
  return {
    asset_id: cleanText(track.asset_id),
    asset_type: service.normalizeAssetType(product.asset_type),
    metadata,
    labels,
    ownership,
    match_policy_id: product.match_policy_id || null,
    match_policy_rules: null,
    steps_done: {
      insert: steps.insert,
      ownership: steps.ownership,
      policy: steps.policy,
      labels: steps.labels
    }
  };
}

function setTrackStatus(trackId, status, step = null, { clearError = true } = {}) {
  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET status = ?,
        step = ?,
        error_message = CASE WHEN ? THEN NULL ELSE error_message END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, step, clearError ? 1 : 0, trackId);
}

function markTrackQueued(trackId) {
  setTrackStatus(trackId, "creating", "queued");
}

function markTrackCreating(trackId, step = "insert") {
  setTrackStatus(trackId, "creating", step);
}

function markTrackUploading(trackId) {
  setTrackStatus(trackId, "uploading", "reference");
}

function markTrackError(trackId, step, error, networkId = null) {
  noteCmsAuthFailure(error, networkId);
  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET status = 'error', step = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(step, errorMessage(error), trackId);
}

function markTrackDuplicate(trackId, duplicates) {
  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET status = 'duplicate', step = 'check', duplicate_json = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(duplicates), trackId);
}

// Checkpoint each successful API step so a restart can resume ownership/policy work
// without creating a second asset after an insert already succeeded.
function recordTrackStep(trackId, step, data) {
  if (!STEP_KEYS.includes(step)) return;
  const row = getTrackRow(trackId);
  if (!row) return;
  const steps = normalizeSteps(parseJson(row.steps_json, {}));
  steps[step] = true;
  db.prepare(`UPDATE content_id_delivery_tracks
    SET steps_json = ?, asset_id = COALESCE(?, asset_id), response_json = COALESCE(?, response_json),
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    JSON.stringify(steps), step === "insert" ? cleanText(data?.id) || null : null,
    step === "insert" ? JSON.stringify(data || {}) : null, trackId
  );
}

// Persists the outcome of runSoundRecordingSteps. Returns the new track status.
function updateTrackAfterRun(trackId, plan, product, result) {
  const row = getTrackRow(trackId);
  if (!row) return "error";
  const previous = normalizeSteps(parseJson(row.steps_json, {}));
  const steps = normalizeSteps({ ...result.steps, reference: previous.reference });
  const ok = !result.error;
  let status = "error";
  if (ok) status = steps.reference && hasLiveReference(row) ? "completed" : "created";
  if (!ok) noteCmsAuthFailure(result.error, product?.network_id);

  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET status = ?,
        step = ?,
        asset_id = COALESCE(?, asset_id),
        error_message = ?,
        steps_json = ?,
        metadata_json = ?,
        ownership_json = ?,
        match_policy_id = ?,
        match_policy_name = ?,
        response_json = COALESCE(?, response_json),
        delivered_at = CASE WHEN ? THEN COALESCE(delivered_at, CURRENT_TIMESTAMP) ELSE delivered_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    status,
    result.step || null,
    cleanText(result.asset_id) || null,
    ok ? null : errorMessage(result.error),
    JSON.stringify(steps),
    JSON.stringify(plan.metadata),
    JSON.stringify(plan.ownership),
    product.match_policy_id || null,
    product.match_policy_name || null,
    result.responses?.insert ? JSON.stringify(result.responses.insert) : null,
    cleanText(result.asset_id) ? 1 : 0,
    trackId
  );
  return status;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function normalizeReference(reference) {
  const source = isObject(reference) ? reference : {};
  return {
    id: cleanText(source.id),
    asset_id: cleanText(source.assetId),
    status: refStatus(source),
    status_reason: cleanText(source.statusReason),
    length: Number(source.length) || 0,
    content_type: cleanText(source.contentType).toLowerCase()
  };
}

function pickNewestReference(references, preferredId) {
  const list = toArray(references).filter(isObject);
  if (!list.length) return null;

  const withTime = list.map((item, index) => ({
    item,
    index,
    time: Date.parse(item.timeCreated || "") || 0
  }));
  withTime.sort((left, right) => (right.time - left.time) || (left.index - right.index));

  if (!withTime[0].time && preferredId) {
    const preferred = list.find((item) => cleanText(item.id) === cleanText(preferredId));
    if (preferred) return preferred;
  }
  return withTime[0].item;
}

function applyReferenceResult(trackId, reference, { fileName, fileSize } = {}) {
  const row = getTrackRow(trackId);
  if (!row) return;
  const normalized = normalizeReference(reference);
  const steps = normalizeSteps(parseJson(row.steps_json, {}));
  steps.reference = true;

  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET reference_id = ?,
        reference_status = ?,
        reference_content_type = ?,
        file_name = COALESCE(?, file_name),
        file_size = COALESCE(?, file_size),
        steps_json = ?,
        status = 'completed',
        step = 'reference',
        error_message = NULL,
        response_json = ?,
        delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    normalized.id || null,
    normalized.status || null,
    normalized.content_type || null,
    fileName || null,
    Number.isFinite(fileSize) && fileSize > 0 ? fileSize : null,
    JSON.stringify(steps),
    JSON.stringify(reference || {}),
    trackId
  );
}

function markReferenceError(trackId, error, networkId = null) {
  noteCmsAuthFailure(error, networkId);
  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET status = 'error', step = 'reference', error_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(errorMessage(error), trackId);
}

// ---------------------------------------------------------------------------
// Stored audio columns
// ---------------------------------------------------------------------------

function setTrackAudio(trackId, stored) {
  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET file_path = ?,
        file_name = ?,
        file_size = ?,
        file_mime = ?,
        file_sha256 = ?,
        file_uploaded_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(stored.file_path, stored.file_name, stored.file_size, stored.file_mime, stored.file_sha256, nowIso(), trackId);
}

// Clears the stored-audio registration and reports whether one was cleared. With `filePath`
// the columns are only cleared while they still point at that file, so a removal that raced
// with a replacement upload never blanks the replacement's registration.
function clearTrackAudio(trackId, { filePath = null } = {}) {
  const guard = filePath === null || filePath === undefined ? null : cleanText(filePath);
  return db.prepare(`
    UPDATE content_id_delivery_tracks
    SET file_path = NULL,
        file_name = NULL,
        file_size = NULL,
        file_mime = NULL,
        file_sha256 = NULL,
        file_uploaded_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND file_path IS NOT NULL AND (? IS NULL OR file_path = ?)
  `).run(trackId, guard, guard).changes > 0;
}

function listDeliveringProductIds() {
  return db.prepare("SELECT id FROM content_id_delivery_products WHERE status = 'delivering' ORDER BY id ASC").all().map((row) => row.id);
}

function listProductIdsWithInFlightTracks() {
  const placeholders = Array.from(IN_FLIGHT_TRACK_STATUSES, () => "?").join(", ");
  return db.prepare(`SELECT DISTINCT product_id AS id FROM content_id_delivery_tracks WHERE status IN (${placeholders}) ORDER BY product_id ASC`)
    .all(...IN_FLIGHT_TRACK_STATUSES).map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Draft audio uploads (files uploaded from the product form before the product exists)
// ---------------------------------------------------------------------------

function parseAudioUploadRow(row) {
  if (!row) return null;
  return {
    ...row,
    file_size: Number(row.file_size) || 0,
    expired: Date.parse(row.expires_at || "") <= Date.now()
  };
}

function insertAudioUpload({ id, file_path, file_name, file_size, file_mime, file_sha256, expires_at, actor = {} }) {
  db.prepare(`
    INSERT INTO content_id_delivery_audio_uploads (
      id, file_path, file_name, file_size, file_mime, file_sha256, created_by, created_by_name, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, file_path, file_name, Number(file_size) || 0, file_mime || null, file_sha256 || null,
    actor.created_by || null, actor.created_by_name || null, expires_at);
  return getAudioUpload(id);
}

function getAudioUpload(id) {
  const key = cleanText(id).toLowerCase();
  if (!key) return null;
  return parseAudioUploadRow(db.prepare("SELECT * FROM content_id_delivery_audio_uploads WHERE id = ?").get(key));
}

function listAudioUploads(ids) {
  const keys = Array.from(new Set(toArray(ids).map((id) => cleanText(id).toLowerCase()).filter(Boolean)));
  if (!keys.length) return [];
  return db.prepare(`SELECT * FROM content_id_delivery_audio_uploads WHERE id IN (${keys.map(() => "?").join(", ")})`)
    .all(...keys).map(parseAudioUploadRow);
}

function deleteAudioUpload(id) {
  const key = cleanText(id).toLowerCase();
  if (!key) return false;
  return db.prepare("DELETE FROM content_id_delivery_audio_uploads WHERE id = ?").run(key).changes > 0;
}

function listExpiredAudioUploads(now = new Date()) {
  return db.prepare("SELECT * FROM content_id_delivery_audio_uploads WHERE expires_at <= ? ORDER BY expires_at ASC")
    .all(now.toISOString()).map(parseAudioUploadRow);
}

function countAudioUploads() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM content_id_delivery_audio_uploads").get()?.count) || 0;
}

module.exports = {
  EVENT_ACTION_GROUPS,
  EVENT_LIMIT,
  IN_FLIGHT_TRACK_STATUSES,
  STEP_KEYS,
  VERBOSE_EVENT_ACTIONS,
  applyReferenceResult,
  assetStepsDone,
  buildTrackPlan,
  cleanText,
  clearTrackAudio,
  countAudioUploads,
  countEvents,
  countTracks,
  deleteAudioUpload,
  errorMessage,
  errorStatus,
  finishProductJob,
  getAudioUpload,
  getProductDetail,
  getProductRow,
  getTrackParsed,
  getTrackRow,
  hasLiveReference,
  insertAudioUpload,
  isAudioReleasable,
  isObject,
  isQuotaReason,
  iterateEvents,
  listAudioUploads,
  listDeliveringProductIds,
  listDeliveryRuns,
  listEventRows,
  listProductIdsWithInFlightTracks,
  listEvents,
  listExpiredAudioUploads,
  listTrackRows,
  logEvent,
  markCodeUsed,
  markProductUpcUsed,
  markReferenceError,
  markTrackCreating,
  markTrackDuplicate,
  markTrackError,
  markTrackIsrcUsed,
  markTrackQueued,
  markTrackUploading,
  normalizeOwnershipInput,
  normalizeReference,
  normalizeSteps,
  noteCmsAuthFailure,
  parseEventRow,
  parseId,
  parseJson,
  parseProductRow,
  parseTrackLabels,
  parseTrackRow,
  pickNewestReference,
  rawErrorMessage,
  recordTrackStep,
  recomputeProduct,
  refStatus,
  setProductNetworkInfo,
  setTrackAudio,
  setTrackStatus,
  startProductJob,
  toArray,
  updateTrackAfterRun
};
