const { randomUUID } = require("crypto");
const db = require("../config/database");
const service = require("../services/assetDeliveryService");
const media = require("../services/deliveryMediaService");
const jobs = require("../services/deliveryJobService");
const store = require("../services/deliveryStore");
const mediaDuration = require("../services/mediaDurationService");

const {
  cleanText,
  errorMessage,
  errorStatus,
  getProductDetail,
  getProductRow,
  getTrackParsed,
  getTrackRow,
  isObject,
  listTrackRows,
  normalizeSteps,
  parseId,
  parseJson,
  parseProductRow,
  parseTrackLabels,
  parseTrackRow,
  pickNewestReference,
  refStatus,
  toArray
} = store;

// Every mutation recomputes the product counters. A product left in "delivering" by an
// interrupted job (no job registered for it any more) is finalized on the way, so it never
// stays stuck after a retry, a reference upload, a takedown or a sync.
function recomputeProduct(productId, options = {}) {
  return store.recomputeProduct(productId, { finalize: !jobs.isRunning(productId), ...options });
}

const MAX_DUPLICATE_CHECK = 500;
const MAX_ARTWORK_BYTES = 400 * 1024;
const CMS_CONCURRENCY = 3;
const PAGE_SIZES = new Set([20, 50, 100]);
const DEFAULT_PAGE_SIZE = 20;
const PRODUCT_STATUSES = new Set(["draft", "delivering", "delivered", "partial", "error", "taken_down"]);
const OWNERSHIP_MODES = new Set(["worldwide", "include", "exclude"]);
// Statuses the delivery job picks up by default. "creating"/"uploading" are tracks an
// interrupted run left behind; "created" only needs the reference step.
const DELIVERABLE_TRACK_STATUSES = new Set(["pending", "error", "creating", "uploading", "created"]);
const RELEASABLE_CLAIM_STATUSES = new Set(["active", "pending"]);
const PRODUCT_FIELDS = ["title", "artist", "upc", "label", "genre", "release_date", "artwork_name", "artwork_data_url", "notes"];
const TRACK_FIELDS = ["title", "artist", "isrc", "custom_id", "notes", "description", "source_url", "asset_labels"];
const JOB_RUNNING_MESSAGE = "Delivery is already running for this product";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function isFlag(value) {
  if (value === true) return true;
  const text = cleanText(value).toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function flagOr(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return isFlag(value);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function toIdSet(value) {
  const list = Array.isArray(value) ? value : service.splitList(value);
  return new Set(list.map(parseId).filter(Boolean));
}

// An explicit empty list must never widen to "every track".
function isExplicitEmptyList(body, key) {
  return Array.isArray(body?.[key]) && body[key].length === 0;
}

function fail(res, error, extra = {}) {
  store.noteCmsAuthFailure(error);
  return res.status(errorStatus(error)).json({ success: false, message: errorMessage(error), ...extra });
}

function conflictRunning(res, productId, extra = {}) {
  return res.status(409).json({ success: false, message: JOB_RUNNING_MESSAGE, product: getProductDetail(productId), ...extra });
}

function actorFields(req) {
  return {
    created_by: req.user?.id || null,
    created_by_name: req.user?.full_name || req.user?.email || null
  };
}

const ADMIN_ROLES = new Set(["admin", "super admin", "supper admin"]);

function isAdminUser(req) {
  const source = req.user?.roles?.length ? req.user.roles : [req.user?.role];
  return source.map((role) => cleanText(role).toLowerCase()).some((role) => ADMIN_ROLES.has(role));
}

// Draft audio uploads belong to the user who made them; only that user (or an admin) may attach
// or delete them.
function ownsUpload(req, upload) {
  if (!upload) return false;
  if (!upload.created_by) return true;
  return Number(upload.created_by) === Number(req.user?.id) || isAdminUser(req);
}

function logEvent(req, productId, options = {}) {
  store.logEvent(productId, { ...options, actor: actorFields(req) });
}

// CMS calls made inside a request (retry, manual reference, sync, edits, takedowns) are traced
// the same way the delivery job traces its own: one "api" event per call, all sharing the
// request's run id, so the log viewer can filter them by run and by "CMS API calls".
function observed(req, ctx, productId, { trackId = null, step = "api", runId } = {}) {
  const actor = actorFields(req);
  return {
    ...ctx,
    deliveryStep: step,
    onApiEvent: (event) => {
      const { phase, message, ...details } = event;
      store.logEvent(productId, {
        track_id: trackId,
        action: "api",
        status: phase === "failed" ? "error" : phase === "completed" ? "ok" : phase,
        message: `${event.method} ${event.endpoint}: ${message || phase}`,
        payload: { ...details, run_id: runId, phase },
        actor
      });
    }
  };
}

// Same shape as the job's event logger, for shared helpers such as cleanupDeliveredAudio.
function requestLogger(req, productId, runId, trackId = null) {
  return (action, phase, message, payload = {}) => logEvent(req, productId, {
    track_id: trackId,
    action,
    status: phase === "failed" ? "error" : phase === "completed" ? "ok" : phase,
    message,
    payload: { ...payload, run_id: runId, phase }
  });
}

// A product left "delivering" with no job in this process was interrupted (restart); make sure
// the log says so before it is read. Idempotent and cheap.
function noteInterruptedIfStale(row) {
  if (row && row.status === "delivering" && !jobs.isRunning(row.id)) jobs.recordInterruptedJob(row.id);
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function productJobInfo(row) {
  const job = jobs.getJob(row.id);
  return { running: Boolean(job), started_at: job ? (row.job_started_at || job.started_at) : null };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateProductFields(input, fieldErrors) {
  const source = isObject(input) ? input : {};

  const title = cleanText(source.title);
  if (!title) fieldErrors.title = "Release title is required";
  else if (Buffer.byteLength(title, "utf8") > service.TITLE_MAX_BYTES) fieldErrors.title = `Title must be ${service.TITLE_MAX_BYTES} bytes or shorter`;

  const notes = cleanText(source.notes) || null;
  if (notes && Buffer.byteLength(notes, "utf8") > service.NOTES_MAX_BYTES) fieldErrors.notes = `Notes must be ${service.NOTES_MAX_BYTES} bytes or shorter`;

  let upc = null;
  const rawUpc = cleanText(source.upc);
  if (rawUpc) {
    upc = service.normalizeUpc(rawUpc);
    if (!upc) fieldErrors.upc = "UPC must be 8-14 letters or digits";
  }

  let releaseDate = null;
  const rawRelease = cleanText(source.release_date);
  if (rawRelease) {
    const parsed = service.parseReleaseDate(rawRelease);
    if (!parsed) fieldErrors.release_date = "Release date must be YYYY-MM-DD";
    else releaseDate = service.toDateOnly(parsed);
  }

  const artworkDataUrl = typeof source.artwork_data_url === "string" ? source.artwork_data_url.trim() : "";
  if (artworkDataUrl) {
    if (!/^data:image\//i.test(artworkDataUrl)) {
      fieldErrors.artwork_data_url = "Artwork must be an image data URL";
    } else if (Buffer.byteLength(artworkDataUrl, "utf8") > MAX_ARTWORK_BYTES) {
      fieldErrors.artwork_data_url = "Artwork must be 400 KB or smaller";
    }
  }

  return {
    title,
    artist: cleanText(source.artist) || null,
    upc,
    label: cleanText(source.label) || null,
    genre: service.splitList(source.genre).join(", ") || null,
    release_date: releaseDate,
    artwork_name: cleanText(source.artwork_name) || null,
    artwork_data_url: artworkDataUrl || null,
    notes
  };
}

function validateOwnershipInput(value, fieldErrors) {
  const ownership = store.normalizeOwnershipInput(value);
  if (!OWNERSHIP_MODES.has(ownership.mode)) {
    fieldErrors.ownership = "Ownership mode must be worldwide, include or exclude";
  } else if (ownership.mode === "include" && !ownership.territories.length) {
    fieldErrors.ownership = "Select at least one territory to include";
  }
  return ownership;
}

function normalizeTrackLabels(value) {
  if (value === null || value === undefined) return null;
  const list = service.splitList(value);
  return list.length ? list : null;
}

function findIsrcConflict(isrc, { excludeTrackId = null, excludeProductId = null } = {}) {
  if (!cleanText(isrc)) return null;
  return db.prepare(`
    SELECT t.id AS track_id, p.id AS product_id, p.title AS product_title, p.status AS product_status
    FROM content_id_delivery_tracks t
    JOIN content_id_delivery_products p ON p.id = t.product_id
    WHERE t.isrc = ?
      AND p.status != 'draft'
      AND (? IS NULL OR t.id != ?)
      AND (? IS NULL OR p.id != ?)
    ORDER BY t.id ASC
    LIMIT 1
  `).get(isrc, excludeTrackId, excludeTrackId, excludeProductId, excludeProductId) || null;
}

function conflictMessage(isrc, conflict) {
  return `ISRC ${isrc} already belongs to product "${conflict.product_title}" (#${conflict.product_id})`;
}

// Per asset type: sound recordings need an ISRC, music videos may carry one, web videos have none.
function isrcRuleOf(assetType) {
  return service.ASSET_TYPE_META[service.normalizeAssetType(assetType)].isrc;
}

// The same byte limits the metadata builders enforce, checked where the data enters so a batch
// never fails at the job's metadata step for something the form could have flagged.
function validateTitleInput(value, errors) {
  const title = cleanText(value);
  if (!title) errors.push("Title is required");
  else if (Buffer.byteLength(title, "utf8") > service.TITLE_MAX_BYTES) errors.push(`Title must be ${service.TITLE_MAX_BYTES} bytes or shorter`);
  return title;
}

function validateNotesInput(value, errors) {
  const notes = cleanText(value);
  if (notes && Buffer.byteLength(notes, "utf8") > service.NOTES_MAX_BYTES) errors.push(`Notes must be ${service.NOTES_MAX_BYTES} bytes or shorter`);
  return notes || null;
}

function validateIsrcInput(rawIsrc, rule, errors) {
  const raw = cleanText(rawIsrc);
  if (rule === "none") return "";
  const isrc = service.normalizeIsrc(raw);
  if (rule === "required" && !isrc) errors.push("Valid ISRC is required");
  else if (rule === "optional" && raw && !isrc) errors.push("ISRC must be 12 alphanumeric characters");
  return isrc;
}

function validateDescriptionInput(value, errors) {
  const description = cleanText(value);
  if (description && Buffer.byteLength(description, "utf8") > service.DESCRIPTION_MAX_BYTES) errors.push(`Description must be ${service.DESCRIPTION_MAX_BYTES} bytes or shorter`);
  return description || null;
}

function validateSourceUrlInput(value, errors) {
  const url = cleanText(value);
  if (url && !service.isHttpUrl(url)) errors.push("The official URL must start with http:// or https://");
  else if (url && Buffer.byteLength(url, "utf8") > service.INFO_URL_MAX_BYTES) errors.push(`Official URL must be ${service.INFO_URL_MAX_BYTES} bytes or shorter`);
  return url || null;
}

function validateCustomIdInput(value, errors) {
  const raw = cleanText(value);
  const customId = service.sanitizeCustomId(raw);
  if (raw && !customId) errors.push("Custom ID may only contain letters, digits and - _ . @ /");
  return customId;
}

function defaultCustomId(labelSource, isrc, rule) {
  if (isrc) return service.buildCustomId(labelSource, isrc);
  return rule === "required" ? null : service.buildVideoCustomId(labelSource);
}

function normalizeTracks(rawTracks, product, fieldErrors, assetType = service.DEFAULT_ASSET_TYPE) {
  const seen = new Map();
  const labelSource = product.label || product.artist || "ANS";
  const rule = isrcRuleOf(assetType);
  const itemLabel = rule === "required" ? "track" : "video";

  return toArray(rawTracks).map((raw, index) => {
    const source = isObject(raw) ? raw : {};
    const key = cleanText(source.client_id) || `track-${index + 1}`;
    const errors = [];

    const title = validateTitleInput(source.title, errors);
    const isrc = validateIsrcInput(source.isrc, rule, errors);
    if (isrc) {
      if (seen.has(isrc)) {
        errors.push(`ISRC ${isrc} is duplicated in this product (see ${itemLabel} ${seen.get(isrc)})`);
      } else {
        seen.set(isrc, index + 1);
        const conflict = findIsrcConflict(isrc);
        if (conflict) errors.push(conflictMessage(isrc, conflict));
      }
    }
    const description = validateDescriptionInput(source.description, errors);
    const sourceUrl = validateSourceUrlInput(source.source_url ?? source.info_url, errors);
    const customId = validateCustomIdInput(source.custom_id, errors);
    const notes = validateNotesInput(source.notes, errors);
    if (errors.length) fieldErrors[key] = errors.join("; ");

    const trackNumber = Number(source.track_number);
    return {
      client_id: key,
      track_number: Number.isInteger(trackNumber) && trackNumber > 0 ? trackNumber : index + 1,
      title,
      artist: cleanText(source.artist) || product.artist || null,
      isrc,
      custom_id: customId || defaultCustomId(labelSource, isrc, rule),
      notes,
      description,
      source_url: sourceUrl,
      asset_labels: normalizeTrackLabels(source.asset_labels),
      file_name: cleanText(source.file_name) || null,
      file_size: Number(source.file_size) > 0 ? Math.trunc(Number(source.file_size)) : null
    };
  });
}

function validationFailure(res, fieldErrors, fallback = "Please fix the highlighted fields") {
  const first = Object.values(fieldErrors)[0];
  return res.status(400).json({ success: false, message: first || fallback, field_errors: fieldErrors });
}

// ---------------------------------------------------------------------------
// Options / labels / duplicates
// ---------------------------------------------------------------------------

async function getOptions(req, res) {
  const networkId = parseId(req.query.network_id);
  if (!networkId) return res.status(400).json({ success: false, message: "network_id is required" });

  try {
    const options = await service.getDeliveryOptions(networkId);
    res.json({ success: true, options });
  } catch (error) {
    fail(res, error);
  }
}

async function createAssetLabel(req, res) {
  const networkId = parseId(req.body?.network_id);
  const labelName = cleanText(req.body?.label_name);
  if (!networkId) return res.status(400).json({ success: false, message: "network_id is required" });
  if (!labelName) return res.status(400).json({ success: false, message: "label_name is required" });

  try {
    const label = await service.createAssetLabel(networkId, labelName);
    const name = label.labelName || labelName;
    const existing = db.prepare("SELECT id FROM content_id_labels WHERE lower(name) = lower(?)").get(name);
    if (!existing) {
      try {
        db.prepare("INSERT INTO content_id_labels (name, display_name, notes) VALUES (?, ?, ?)")
          .run(name, name, "Created from CMS Delivery");
      } catch {
        // a concurrent insert already created it; the CMS label is what matters here
      }
    }
    res.json({ success: true, label: { labelName: name } });
  } catch (error) {
    fail(res, error);
  }
}

async function checkDuplicates(req, res) {
  const networkId = parseId(req.body?.network_id);
  if (!networkId) return res.status(400).json({ success: false, message: "network_id is required" });

  const rawList = service.splitList(req.body?.isrcs);
  if (rawList.length > MAX_DUPLICATE_CHECK) {
    return res.status(400).json({ success: false, message: `You can check at most ${MAX_DUPLICATE_CHECK} ISRCs per request` });
  }
  const codes = Array.from(new Set(rawList.map(service.normalizeIsrc).filter(Boolean)));

  try {
    const found = codes.length ? await service.searchAssetsByIsrc(networkId, codes) : new Map();
    const matches = {};
    found.forEach((items, isrc) => {
      matches[isrc] = items;
    });
    res.json({ success: true, matches, checked: codes.length });
  } catch (error) {
    fail(res, error);
  }
}

// ---------------------------------------------------------------------------
// Create product
// ---------------------------------------------------------------------------

// Resolves the draft audio uploads referenced by the tracks (audio_upload_id). Problems become
// field errors keyed by the track's client_id so the form can point at the row.
function resolveTrackUploads(req, rawTracks, tracks, fieldErrors) {
  const wanted = new Map();
  toArray(rawTracks).forEach((raw, index) => {
    const source = isObject(raw) ? raw : {};
    const uploadId = cleanText(source.audio_upload_id).toLowerCase();
    if (!uploadId) return;
    const key = tracks[index]?.client_id || cleanText(source.client_id) || `track-${index + 1}`;
    if (!media.isValidUploadId(uploadId)) {
      fieldErrors[key] = [fieldErrors[key], "The audio upload reference is invalid. Select the file again."].filter(Boolean).join("; ");
      return;
    }
    if (wanted.has(uploadId)) {
      fieldErrors[key] = [fieldErrors[key], `The same uploaded audio file is attached to track ${wanted.get(uploadId).index + 1} as well`].filter(Boolean).join("; ");
      return;
    }
    wanted.set(uploadId, { index, key });
  });
  if (!wanted.size) return new Map();

  const found = new Map(store.listAudioUploads(Array.from(wanted.keys())).map((upload) => [upload.id, upload]));
  const resolved = new Map();
  wanted.forEach(({ index, key }, uploadId) => {
    const upload = found.get(uploadId);
    let problem = "";
    if (!upload) problem = "The uploaded audio file has expired or was removed. Select the file again.";
    else if (!ownsUpload(req, upload)) problem = "The uploaded audio file belongs to another user. Select the file again.";
    else if (upload.expired) problem = "The uploaded audio file has expired. Select the file again.";
    else if (!media.resolveTrackAudio(upload)) problem = "The uploaded audio file is no longer on the server. Select the file again.";
    if (problem) {
      fieldErrors[key] = [fieldErrors[key], problem].filter(Boolean).join("; ");
      return;
    }
    resolved.set(index, upload);
  });
  return resolved;
}

// Moves the draft uploads next to their tracks once the product row exists. A failure here never
// undoes the product: the track simply has no audio yet and the log says why.
async function attachTrackUploads(req, productId, trackIds, uploads) {
  const errors = [];
  for (const [index, upload] of uploads) {
    const trackId = trackIds[index];
    if (!trackId) continue;
    try {
      const stored = await media.attachDraftAudio(upload, productId, trackId);
      store.setTrackAudio(trackId, stored);
      logEvent(req, productId, {
        track_id: trackId,
        action: "audio_upload",
        message: `Audio "${stored.file_name}" attached (${formatBytes(stored.file_size)}, uploaded while preparing the product)`,
        payload: { ...stored, upload_id: upload.id, uploaded_at: upload.created_at }
      });
    } catch (error) {
      const message = errorMessage(error);
      errors.push({ track_id: trackId, upload_id: upload.id, message });
      logEvent(req, productId, {
        track_id: trackId,
        action: "audio_upload",
        status: "error",
        message: `The uploaded audio could not be attached to the track: ${message}`,
        payload: { upload_id: upload.id, file_name: upload.file_name }
      });
    }
  }
  return errors;
}

async function createProduct(req, res) {
  const body = isObject(req.body) ? req.body : {};
  const networkId = parseId(body.network_id);
  if (!networkId) return res.status(400).json({ success: false, message: "network_id is required" });

  const network = db.prepare("SELECT id, name, network_code FROM networks WHERE id = ?").get(networkId);
  if (!network) return res.status(404).json({ success: false, message: "Network not found" });

  const fieldErrors = {};
  const product = validateProductFields(body.product, fieldErrors);
  // Content ID asset type of every item: sound_recording (music release), web or music_video.
  const rawAssetType = cleanText(isObject(body.product) ? body.product.asset_type : "") || cleanText(body.asset_type);
  if (rawAssetType && !service.isAssetType(rawAssetType)) fieldErrors.asset_type = "Asset type must be sound_recording, web or music_video";
  const assetType = service.normalizeAssetType(rawAssetType);

  const rights = isObject(body.rights) ? body.rights : {};
  const ownership = validateOwnershipInput(rights.ownership, fieldErrors);
  const matchPolicyId = cleanText(rights.match_policy_id);
  if (!matchPolicyId) fieldErrors.match_policy_id = "Match policy is required";
  const matchPolicyName = cleanText(rights.match_policy_name) || null;
  const assetLabels = service.splitList(rights.asset_labels);

  const reference = isObject(body.reference) ? body.reference : {};
  const referenceContentType = service.normalizeReferenceContentType(reference.content_type, service.defaultReferenceContentType(assetType));
  const referenceUrgent = flagOr(reference.urgent, false);
  const includeReference = flagOr(reference.include_reference ?? reference.upload_reference, true);

  const options = isObject(body.options) ? body.options : {};
  const skipDuplicates = flagOr(options.skip_duplicates, true);
  const deleteReferenceAfterDelivery = flagOr(options.delete_reference_after_delivery ?? reference.delete_reference_after_delivery, false);

  const rawTracks = toArray(body.tracks);
  if (!rawTracks.length) fieldErrors.tracks = assetType === "sound_recording" ? "Add at least one track" : "Add at least one video";
  const tracks = normalizeTracks(rawTracks, product, fieldErrors, assetType);
  const uploads = resolveTrackUploads(req, rawTracks, tracks, fieldErrors);

  if (Object.keys(fieldErrors).length) return validationFailure(res, fieldErrors);

  const actor = actorFields(req);
  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO content_id_delivery_products (
        network_id, network_name, content_owner_id,
        title, artist, upc, label, genre, release_date, artwork_name, artwork_data_url, notes,
        asset_labels, ownership_json, match_policy_id, match_policy_name,
        reference_content_type, reference_urgent, skip_duplicates, include_reference, delete_reference_after_delivery,
        asset_type, track_count, status, created_by, created_by_name
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      networkId,
      network.name,
      cleanText(network.network_code) || null,
      product.title,
      product.artist,
      product.upc,
      product.label,
      product.genre,
      product.release_date,
      product.artwork_name,
      product.artwork_data_url,
      product.notes,
      JSON.stringify(assetLabels),
      JSON.stringify(ownership),
      matchPolicyId,
      matchPolicyName,
      referenceContentType,
      referenceUrgent ? 1 : 0,
      skipDuplicates ? 1 : 0,
      includeReference ? 1 : 0,
      deleteReferenceAfterDelivery ? 1 : 0,
      assetType,
      tracks.length,
      actor.created_by,
      actor.created_by_name
    );
    const productId = Number(result.lastInsertRowid);

    const insertTrack = db.prepare(`
      INSERT INTO content_id_delivery_tracks (
        product_id, track_number, title, artist, isrc, custom_id, notes, description, source_url, asset_labels,
        file_name, file_size, steps_json, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    const trackIds = tracks.map((track, index) => {
      const upload = uploads.get(index);
      // Claim the upload inside the transaction: a concurrent create that references the same
      // upload id (two tabs restoring one draft, a retried request) fails validation instead of
      // producing a second product with the same tracks.
      if (upload && !store.deleteAudioUpload(upload.id)) {
        const error = new Error("The uploaded audio file has expired or was removed. Select the file again.");
        error.fieldKey = track.client_id;
        throw error;
      }
      const inserted = insertTrack.run(
        productId,
        track.track_number,
        track.title,
        track.artist,
        track.isrc,
        track.custom_id,
        track.notes,
        track.description,
        track.source_url,
        track.asset_labels ? JSON.stringify(track.asset_labels) : null,
        upload ? upload.file_name : track.file_name,
        upload ? upload.file_size : track.file_size,
        JSON.stringify(normalizeSteps({}))
      );
      return Number(inserted.lastInsertRowid);
    });

    return { productId, trackIds };
  });

  let created;
  try {
    created = insert();
  } catch (error) {
    if (error?.fieldKey) return validationFailure(res, { [error.fieldKey]: error.message });
    throw error;
  }
  const { productId, trackIds } = created;
  logEvent(req, productId, {
    action: "create",
    message: `Product created with ${tracks.length} track(s)` + (uploads.size ? `, ${uploads.size} audio file(s) uploaded beforehand` : ""),
    payload: {
      track_count: tracks.length,
      network_id: networkId,
      match_policy_id: matchPolicyId,
      include_reference: includeReference,
      delete_reference_after_delivery: deleteReferenceAfterDelivery,
      audio_uploads: uploads.size
    }
  });
  const audioErrors = uploads.size ? await attachTrackUploads(req, productId, trackIds, uploads) : [];
  // Echo each row's client_id so the form can map its rows to the stored tracks.
  const clientIds = new Map(trackIds.map((trackId, index) => [trackId, tracks[index].client_id]));
  const detail = getProductDetail(productId);
  detail.tracks = detail.tracks.map((track) => ({ ...track, client_id: clientIds.get(track.id) || null }));
  res.json({ success: true, product: detail, audio_errors: audioErrors });
}

// ---------------------------------------------------------------------------
// Deliver (background job) / retry / progress
// ---------------------------------------------------------------------------

function selectDeliverableTracks(allTracks, requested, forceDuplicates) {
  return allTracks.filter((track) => {
    if (requested.size) return requested.has(track.id) && (DELIVERABLE_TRACK_STATUSES.has(track.status) || track.status === "duplicate");
    return DELIVERABLE_TRACK_STATUSES.has(track.status) || (track.status === "duplicate" && forceDuplicates);
  });
}

function deliverProduct(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });
  if (jobs.isRunning(id)) return conflictRunning(res, id);

  const body = isObject(req.body) ? req.body : {};
  const requested = toIdSet(body.track_ids);
  const forceDuplicates = flagOr(body.force_duplicates, false);
  const product = parseProductRow(row);
  const provided = (key) => body[key] !== undefined && body[key] !== null && body[key] !== "";
  const includeReference = flagOr(body.include_reference, product.include_reference);
  // Both switches are remembered on the product when the caller sets them explicitly.
  const deleteReferenceAfterDelivery = flagOr(body.delete_reference_after_delivery, product.delete_reference_after_delivery);

  const selected = selectDeliverableTracks(listTrackRows(id), requested, forceDuplicates);
  // A track a retry request is still working on must not be queued a second time: asking for
  // it explicitly is refused, the default selection simply leaves it out. (Stale in-flight rows
  // left by a crash have no run on record and stay deliverable.)
  const busy = selected.filter((track) => jobs.isTrackRunning(track.id));
  if (busy.length && requested.size) return conflictInFlight(res, busy[0].id);
  const deliverable = selected.filter((track) => !jobs.isTrackRunning(track.id));
  if (!deliverable.length) return res.status(400).json({ success: false, message: "No tracks to deliver" });

  const trackIds = deliverable.map((track) => track.id);
  const prepare = db.transaction(() => {
    store.startProductJob(id, {
      includeReference: provided("include_reference") ? includeReference : null,
      deleteReferenceAfterDelivery: provided("delete_reference_after_delivery") ? deleteReferenceAfterDelivery : null
    });
    trackIds.forEach((trackId) => store.markTrackQueued(trackId));
  });
  prepare();

  try {
    jobs.startDeliveryJob({ productId: id, trackIds, forceDuplicates, includeReference, actor: actorFields(req) });
  } catch (error) {
    recomputeProduct(id, { finalize: true });
    return fail(res, error);
  }

  res.status(202).json({ success: true, product: getProductDetail(id), job: { running: true, track_ids: trackIds } });
}

// Asset steps for one track inside the request (used by retry). The delivery job has its own
// runner that also uploads the stored audio.
async function runTrackDelivery(ctx, product, track) {
  const base = {
    track_id: track.id,
    status: "error",
    step: "",
    asset_id: cleanText(track.asset_id),
    error_message: "",
    duplicates: toArray(track.duplicates)
  };

  let plan;
  try {
    plan = store.buildTrackPlan(product, track, ctx.contentOwnerId);
  } catch (error) {
    store.markTrackError(track.id, "metadata", error, product.network_id);
    return { ...base, step: "metadata", error_message: errorMessage(error) };
  }

  store.markTrackCreating(track.id, plan.asset_id ? "ownership" : "insert");
  try {
    // Checkpoint every successful step the way the job does, so an asset created by this
    // request is on record the moment it exists and no later run can insert it twice.
    const result = await service.runSoundRecordingSteps(ctx, plan, {
      onStepStart(step) {
        store.markTrackCreating(track.id, step);
      },
      onStep(step, ok, data) {
        if (ok) store.recordTrackStep(track.id, step, data);
      }
    });
    const status = store.updateTrackAfterRun(track.id, plan, product, result);
    if (status !== "error") store.markTrackIsrcUsed(product, track);
    return {
      ...base,
      status,
      step: result.step || "",
      asset_id: cleanText(result.asset_id),
      error_message: result.error ? errorMessage(result.error) : ""
    };
  } catch (error) {
    store.markTrackError(track.id, "insert", error, product.network_id);
    return { ...base, step: "insert", error_message: errorMessage(error) };
  }
}

async function retryTrack(req, res) {
  const id = parseId(req.params.id);
  const trackRow = getTrackRow(id);
  if (!trackRow) return res.status(404).json({ success: false, message: "Track not found" });
  const productRow = getProductRow(trackRow.product_id);
  if (!productRow) return res.status(404).json({ success: false, message: "Product not found" });
  if (jobs.isRunning(productRow.id)) return conflictRunning(res, productRow.id, { track: getTrackParsed(id) });
  if (trackRow.status === "taken_down") {
    return res.status(400).json({ success: false, message: "This track is taken down. Reactivate it instead of retrying." });
  }
  // Another retry is still working on this track (the browser may have given up waiting for
  // it): a second run could insert the asset twice. The in-process registry is claimed before
  // the first await, so two parallel requests cannot both pass these checks.
  if (store.IN_FLIGHT_TRACK_STATUSES.has(trackRow.status) || !jobs.beginTrackRun(id)) return conflictInFlight(res, id);

  try {
    const runId = randomUUID();
    let ctx;
    try {
      ctx = observed(req, await service.authContext(productRow.network_id), productRow.id, { trackId: id, step: "retry", runId });
    } catch (error) {
      return fail(res, error);
    }

    const product = parseProductRow(productRow);
    const track = parseTrackRow(trackRow);
    const result = await runTrackDelivery(ctx, product, track);
    if (result.status !== "error") store.markProductUpcUsed(product);

    recomputeProduct(product.id);
    logEvent(req, product.id, {
      track_id: id,
      action: "retry",
      status: result.status === "error" ? "error" : "ok",
      message: result.status === "error"
        ? `Retry failed at ${result.step || "unknown"}: ${result.error_message}`
        : `Retry succeeded (${result.status})`,
      payload: { ...result, run_id: runId }
    });

    res.json({
      success: true,
      track: getTrackParsed(id),
      product: getProductDetail(product.id),
      result
    });
  } finally {
    jobs.endTrackRun(id);
  }
}

// Lightweight polling payload for the delivery job (no artwork, no events).
function getProductProgress(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });
  noteInterruptedIfStale(row);

  const tracks = listTrackRows(id);
  const counters = store.countTracks(tracks);
  res.json({
    success: true,
    product: {
      id: row.id,
      status: row.status,
      track_count: counters.track_count,
      delivered_count: counters.delivered_count,
      completed_count: counters.completed_count,
      error_count: counters.error_count,
      job_started_at: row.job_started_at || null,
      job_finished_at: row.job_finished_at || null,
      include_reference: row.include_reference === null || row.include_reference === undefined ? true : Boolean(row.include_reference),
      delete_reference_after_delivery: Boolean(row.delete_reference_after_delivery)
    },
    tracks: tracks.map((track) => ({
      id: track.id,
      track_number: track.track_number,
      title: track.title,
      status: track.status,
      step: track.step || null,
      asset_id: track.asset_id || null,
      reference_id: track.reference_id || null,
      reference_status: track.reference_status || null,
      error_message: track.error_message || null,
      file_name: track.file_name || null,
      file_size: track.file_size || null,
      has_audio: Boolean(media.resolveTrackAudio(track))
    })),
    job: { running: jobs.isRunning(id) }
  });
}

// ---------------------------------------------------------------------------
// Stored audio (upload / stream / remove)
// ---------------------------------------------------------------------------

function loadTrackAndProduct(req, res) {
  const id = parseId(req.params.id);
  const track = getTrackRow(id);
  if (!track) {
    res.status(404).json({ success: false, message: "Track not found" });
    return null;
  }
  const product = getProductRow(track.product_id);
  if (!product) {
    res.status(404).json({ success: false, message: "Product not found" });
    return null;
  }
  return { id, track, product };
}

function isClientAbort(req, error) {
  return Boolean(req.aborted)
    || error?.code === "ECONNRESET"
    || error?.code === "ERR_STREAM_PREMATURE_CLOSE";
}

// Validates a raw-body upload request (PUT with the file bytes as the body). Responds and
// returns null when the request is not acceptable.
function validateRawUpload(req, res) {
  const mimeType = cleanText(req.headers?.["content-type"]) || "application/octet-stream";
  if (/^application\/(json|x-www-form-urlencoded)\b/i.test(mimeType) || /^multipart\//i.test(mimeType) || req.readableEnded) {
    res.status(415).json({ success: false, message: "Send the raw file bytes with the file's MIME type (for example audio/wav)" });
    return null;
  }

  const contentLength = Number(req.headers?.["content-length"]);
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    res.status(411).json({ success: false, message: "Content-Length header with the file size is required" });
    return null;
  }
  const querySize = Number(req.query?.file_size);
  if (Number.isFinite(querySize) && querySize > 0 && querySize !== contentLength) {
    res.status(400).json({ success: false, message: "file_size does not match the uploaded body size" });
    return null;
  }
  if (contentLength > media.MAX_AUDIO_BYTES) {
    res.status(413).json({ success: false, message: `File is larger than the allowed ${Math.floor(media.MAX_AUDIO_BYTES / (1024 * 1024))} MB` });
    return null;
  }
  if (req.aborted) {
    res.status(400).json({ success: false, message: "Upload was aborted by the client" });
    return null;
  }
  return { mimeType, contentLength, fileName: cleanText(req.query?.file_name) };
}

function conflictInFlight(res, id) {
  return res.status(409).json({ success: false, message: "This track is being delivered right now; wait for it to finish", track: getTrackParsed(id) });
}

async function uploadAudio(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { id, track, product } = loaded;
  if (jobs.isRunning(product.id)) return conflictRunning(res, product.id, { track: getTrackParsed(id) });
  // A retry request may be streaming/using this track's file right now.
  if (store.IN_FLIGHT_TRACK_STATUSES.has(track.status)) return conflictInFlight(res, id);

  const upload = validateRawUpload(req, res);
  if (!upload) return;
  const { mimeType, contentLength } = upload;
  const fileName = upload.fileName || track.file_name || "";
  const videoKind = service.kindOfAssetType(product.asset_type) === "video";

  try {
    const stored = await media.storeTrackAudio({
      productId: product.id,
      trackId: id,
      fileName,
      stream: req,
      contentLength,
      mimeType,
      // Video references shorter than Content ID accepts are refused before the old file is replaced.
      validateFile: videoKind ? (partPath) => mediaDuration.assertVideoReferenceLength(partPath, { fileName, mimeType }) : undefined
    });
    store.setTrackAudio(id, stored);
    logEvent(req, product.id, {
      track_id: id,
      action: "audio_upload",
      message: `${videoKind ? "Video" : "Audio"} "${stored.file_name}" stored (${formatBytes(stored.file_size)})`,
      payload: { ...stored }
    });
    res.json({ success: true, track: getTrackParsed(id) });
  } catch (error) {
    if (isClientAbort(req, error)) {
      return res.status(400).json({ success: false, message: "Upload was aborted by the client", track: getTrackParsed(id) });
    }
    if (error && typeof error === "object" && !error.status && !error.response) error.status = 500;
    logEvent(req, product.id, { track_id: id, action: "audio_upload", status: "error", message: errorMessage(error), payload: { file_name: fileName, code: error?.code, duration_seconds: error?.duration_seconds } });
    fail(res, error, { track: getTrackParsed(id), ...tooShortExtra(error) });
  }
}

function tooShortExtra(error) {
  if (error?.code !== "VIDEO_TOO_SHORT") return {};
  return { code: error.code, duration_seconds: error.duration_seconds, min_seconds: error.min_seconds };
}

function parseRangeHeader(header, size) {
  const text = cleanText(header);
  if (!text) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(text);
  if (!match) return { invalid: true };
  const [, startText, endText] = match;
  if (!startText && !endText) return { invalid: true };

  let start;
  let end;
  if (!startText) {
    const suffix = Number(endText);
    if (!suffix) return { invalid: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

function contentDisposition(fileName, download) {
  const name = cleanText(fileName) || "audio";
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function getTrackAudio(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { track } = loaded;

  const audio = media.resolveTrackAudio(track);
  if (!audio) return res.status(404).json({ success: false, message: "No audio file is stored for this track" });

  const range = parseRangeHeader(req.headers?.range, audio.size);
  if (range && range.invalid) {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${audio.size}`);
    return res.json({ success: false, message: "Requested range is not satisfiable" });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : audio.size - 1;
  res.status(range ? 206 : 200);
  res.setHeader("Content-Type", audio.mime);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", String(end - start + 1));
  res.setHeader("Cache-Control", "private, max-age=0");
  res.setHeader("Content-Disposition", contentDisposition(track.file_name, isFlag(req.query?.download)));
  if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${audio.size}`);

  let stream;
  try {
    stream = media.openTrackAudioStream(track, { start, end });
  } catch (error) {
    return fail(res, error);
  }
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: `Could not read the stored audio: ${error.message}` });
    } else if (typeof res.destroy === "function") {
      res.destroy(error);
    }
  });
  // A client that stops downloading (player closed, seek) must not leave the file handle open.
  if (typeof res.on === "function") {
    res.on("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
  }
  stream.pipe(res);
}

async function deleteTrackAudio(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { id, track, product } = loaded;
  if (jobs.isRunning(product.id)) return conflictRunning(res, product.id, { track: getTrackParsed(id) });
  if (store.IN_FLIGHT_TRACK_STATUSES.has(track.status)) return conflictInFlight(res, id);

  try {
    await media.removeTrackAudio(track);
  } catch (error) {
    error.status = 500;
    return fail(res, error, { track: getTrackParsed(id) });
  }
  store.clearTrackAudio(id, { filePath: track.file_path });
  logEvent(req, product.id, {
    track_id: id,
    action: "audio_delete",
    message: track.file_name ? `Audio "${track.file_name}" removed` : "Stored audio removed",
    payload: { file_name: track.file_name || null, file_path: track.file_path || null }
  });
  res.json({ success: true, track: getTrackParsed(id) });
}

// Removes the stored audio of every fully delivered track (live reference in CMS) to free
// server storage. Tracks that still need their file (no asset, no live reference, in flight)
// are reported as skipped and never touched.
async function cleanupProductAudio(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });
  if (jobs.isRunning(id)) return conflictRunning(res, id);
  if (isExplicitEmptyList(req.body, "track_ids")) return res.status(400).json({ success: false, message: "Select at least one track" });

  const requested = toIdSet(req.body?.track_ids);
  const trackIds = listTrackRows(id).map((track) => track.id).filter((trackId) => !requested.size || requested.has(trackId));
  const results = [];
  let removed = 0;
  let bytesFreed = 0;

  for (const trackId of trackIds) {
    // Re-read right before touching the file: an upload may have replaced it meanwhile.
    const track = getTrackParsed(trackId);
    if (!track) continue;
    if (!cleanText(track.file_path)) {
      results.push({ track_id: track.id, removed: false, reason: "no_audio" });
      continue;
    }
    if (!store.isAudioReleasable(track)) {
      results.push({ track_id: track.id, removed: false, reason: store.hasLiveReference(track) ? "not_completed" : "no_live_reference" });
      continue;
    }
    try {
      await media.removeTrackAudio(track);
      store.clearTrackAudio(track.id, { filePath: track.file_path });
      removed += 1;
      bytesFreed += Number(track.file_size) || 0;
      results.push({ track_id: track.id, removed: true, bytes_freed: Number(track.file_size) || 0 });
      logEvent(req, id, {
        track_id: track.id,
        action: "audio_cleanup",
        message: `Removed "${track.file_name || "audio"}" from this server (${formatBytes(track.file_size)}); reference ${track.reference_id} stays in CMS`,
        payload: { file_name: track.file_name || null, bytes_freed: Number(track.file_size) || 0, reference_id: track.reference_id || null }
      });
    } catch (error) {
      results.push({ track_id: track.id, removed: false, reason: "error", message: errorMessage(error) });
      logEvent(req, id, {
        track_id: track.id,
        action: "audio_cleanup",
        status: "error",
        message: `Could not remove "${track.file_name || "audio"}": ${errorMessage(error)}`,
        payload: { file_name: track.file_name || null }
      });
    }
  }

  const skipped = results.filter((item) => !item.removed);
  logEvent(req, id, {
    action: "audio_cleanup",
    status: results.some((item) => item.reason === "error") ? "error" : "ok",
    message: `Freed ${formatBytes(bytesFreed)} by removing ${removed} audio file(s)` + (skipped.length ? `, ${skipped.length} track(s) kept their file` : ""),
    payload: { removed, bytes_freed: bytesFreed, track_ids: Array.from(requested), results }
  });
  res.json({ success: true, removed, bytes_freed: bytesFreed, results, product: getProductDetail(id) });
}

// ---------------------------------------------------------------------------
// Draft audio uploads (from the product form, before the product exists)
// ---------------------------------------------------------------------------

function publicUpload(upload) {
  return {
    id: upload.id,
    file_name: upload.file_name,
    file_size: upload.file_size,
    file_mime: upload.file_mime,
    file_sha256: upload.file_sha256,
    created_at: upload.created_at,
    expires_at: upload.expires_at
  };
}

async function uploadDraftAudio(req, res) {
  const upload = validateRawUpload(req, res);
  if (!upload) return;
  const { mimeType, contentLength, fileName } = upload;
  const uploadId = media.newUploadId();
  // The video form marks its uploads (media_kind=video) so short clips are refused up front.
  const videoKind = cleanText(req.query?.media_kind).toLowerCase() === "video";

  try {
    const stored = await media.storeDraftAudio({
      uploadId,
      fileName,
      stream: req,
      contentLength,
      mimeType,
      validateFile: videoKind ? (partPath) => mediaDuration.assertVideoReferenceLength(partPath, { fileName, mimeType }) : undefined
    });
    const row = store.insertAudioUpload({
      id: uploadId,
      ...stored,
      expires_at: new Date(Date.now() + media.DRAFT_TTL_MS).toISOString(),
      actor: actorFields(req)
    });
    res.json({ success: true, upload: publicUpload(row) });
  } catch (error) {
    // The stored bytes are useless without a row; never leave them behind.
    await media.removeDraftAudio({ file_path: `${media.DRAFT_DIR_NAME}/${uploadId}__${media.sanitizeFileName(fileName)}` }).catch(() => {});
    if (isClientAbort(req, error)) {
      return res.status(400).json({ success: false, message: "Upload was aborted by the client" });
    }
    if (error && typeof error === "object" && !error.status && !error.response) error.status = 500;
    fail(res, error, tooShortExtra(error));
  }
}

// Which of the given draft uploads are still usable (restoring an autosaved form draft).
function checkDraftAudio(req, res) {
  const ids = service.splitList(req.query?.ids).map((id) => cleanText(id).toLowerCase()).filter(media.isValidUploadId);
  const uploads = store.listAudioUploads(ids)
    .filter((upload) => ownsUpload(req, upload) && !upload.expired && media.resolveTrackAudio(upload))
    .map(publicUpload);
  const found = new Set(uploads.map((upload) => upload.id));
  res.json({ success: true, uploads, missing: ids.filter((id) => !found.has(id)) });
}

async function deleteDraftAudio(req, res) {
  const id = cleanText(req.params.id).toLowerCase();
  if (!media.isValidUploadId(id)) return res.status(400).json({ success: false, message: "A valid upload id is required" });
  const upload = store.getAudioUpload(id);
  if (!upload) return res.status(404).json({ success: false, message: "Upload not found (it may have expired already)" });
  if (!ownsUpload(req, upload)) return res.status(403).json({ success: false, message: "This upload belongs to another user" });

  try {
    await media.removeDraftAudio(upload);
  } catch (error) {
    error.status = 500;
    return fail(res, error);
  }
  store.deleteAudioUpload(id);
  res.json({ success: true });
}

// ---------------------------------------------------------------------------
// Delivery logs (persisted events with cursors, filters, runs and export)
// ---------------------------------------------------------------------------

function logFilters(query = {}) {
  return {
    trackId: query.track_id,
    status: query.status,
    action: query.action,
    runId: query.run_id,
    search: query.search
  };
}

function listProductLogs(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });
  noteInterruptedIfStale(row);

  const query = req.query || {};
  const page = store.listEvents(id, {
    ...logFilters(query),
    beforeId: query.before_id,
    afterId: query.after_id,
    limit: query.limit
  });
  res.json({ success: true, ...page, job: { running: jobs.isRunning(id) } });
}

function listProductLogRuns(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });
  noteInterruptedIfStale(row);
  const { runs, total } = store.listDeliveryRuns(id, { limit: req.query?.limit });
  res.json({ success: true, runs, total, job: { running: jobs.isRunning(id) } });
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : (typeof value === "object" ? JSON.stringify(value) : String(value));
  // Track titles and messages are free text: neutralise anything a spreadsheet would evaluate
  // as a formula (=, +, -, @, tab, CR) so opening the export cannot run it.
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

const LOG_CSV_COLUMNS = ["id", "created_at", "run_id", "track_id", "track_number", "track_title", "action", "status", "step", "message",
  "http_status", "duration_ms", "percent", "asset_id", "reference_id", "created_by_name"];

// Streams every matching event of the product as JSON lines (default) or CSV.
function exportProductLogs(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });

  const format = cleanText(req.query?.format).toLowerCase() === "csv" ? "csv" : "jsonl";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `cms-delivery-${id}-logs-${stamp}.${format}`;
  res.status(200);
  res.setHeader("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Cache-Control", "private, no-store");

  // The BOM makes Excel read the UTF-8 file (Vietnamese titles) correctly.
  if (format === "csv") res.write(`﻿${LOG_CSV_COLUMNS.join(",")}\r\n`);
  for (const event of store.iterateEvents(id, logFilters(req.query))) {
    const payload = isObject(event.payload) ? event.payload : {};
    if (format === "csv") {
      const values = {
        ...event,
        run_id: payload.run_id,
        step: payload.step,
        http_status: payload.http_status,
        duration_ms: payload.duration_ms,
        percent: payload.percent,
        asset_id: payload.asset_id,
        reference_id: payload.reference_id ?? payload.reference?.id
      };
      res.write(`${LOG_CSV_COLUMNS.map((column) => csvCell(values[column])).join(",")}\r\n`);
    } else {
      res.write(`${JSON.stringify(event)}\n`);
    }
  }
  res.end();
}

// ---------------------------------------------------------------------------
// References (server-side upload from the stored file, from a claim)
// ---------------------------------------------------------------------------

async function deliverReference(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { id, track, product } = loaded;
  if (jobs.isTrackRunning(id)) return conflictInFlight(res, id);
  if (!cleanText(track.asset_id)) {
    return res.status(400).json({ success: false, message: "This track has no asset ID yet. Deliver the track first.", track: getTrackParsed(id) });
  }
  const audio = media.resolveTrackAudio(track);
  if (!audio) {
    return res.status(400).json({ success: false, message: "No audio file is stored for this track. Upload the audio first.", track: getTrackParsed(id) });
  }
  if (jobs.isRunning(product.id)) return conflictRunning(res, product.id, { track: getTrackParsed(id) });

  const body = isObject(req.body) ? req.body : {};
  const force = flagOr(body.force, false);
  if (!force && store.hasLiveReference(track)) {
    return res.status(409).json({ success: false, message: "A reference is already active for this asset", track: getTrackParsed(id) });
  }

  // A manual reference delivery runs through the same background job as a product delivery
  // (202 + progress polling): a large file must never hang on one HTTP request. The job
  // finishes the asset steps if any are missing, uploads the stored audio, and applies the
  // product's "delete after delivery" choice.
  const reference = {
    manual: true,
    force,
    contentType: service.normalizeReferenceContentType(body.content_type, product.reference_content_type || "audio"),
    urgent: body.urgent === undefined || body.urgent === null || body.urgent === "" ? null : isFlag(body.urgent)
  };
  const prepare = db.transaction(() => {
    store.startProductJob(product.id);
    store.markTrackQueued(id);
  });
  prepare();

  let job;
  try {
    job = jobs.startDeliveryJob({ productId: product.id, trackIds: [id], forceDuplicates: true, includeReference: true, actor: actorFields(req), reference });
  } catch (error) {
    recomputeProduct(product.id, { finalize: true });
    return fail(res, error, { track: getTrackParsed(id) });
  }

  res.status(202).json({
    success: true,
    track: getTrackParsed(id),
    product: getProductDetail(product.id),
    job: { running: true, run_id: job.run_id, track_ids: [id] }
  });
}

async function referenceFromClaim(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { id, track, product } = loaded;
  if (!cleanText(track.asset_id)) {
    return res.status(400).json({ success: false, message: "This track has no asset ID yet. Deliver the track first." });
  }
  if (jobs.isRunning(product.id)) return conflictRunning(res, product.id, { track: getTrackParsed(id) });

  const claimId = cleanText(req.body?.claim_id);
  if (!claimId) return res.status(400).json({ success: false, message: "claim_id is required" });
  const contentType = service.normalizeReferenceContentType(req.body?.content_type, product.reference_content_type || "audio");

  db.prepare("UPDATE content_id_delivery_tracks SET step = 'reference', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  const runId = randomUUID();

  try {
    const ctx = observed(req, await service.authContext(product.network_id), product.id, { trackId: id, step: "reference", runId });
    const reference = await service.createReferenceFromClaim(ctx, track.asset_id, claimId, contentType);
    store.applyReferenceResult(id, reference, {});
    recomputeProduct(product.id);
    const normalized = store.normalizeReference(reference);
    logEvent(req, product.id, {
      track_id: id,
      action: "reference_from_claim",
      message: `Reference ${normalized.id || ""} created from claim ${claimId}`.replace(/\s+/g, " "),
      payload: { claim_id: claimId, content_type: contentType, reference: normalized, run_id: runId }
    });
    if (product.delete_reference_after_delivery) await jobs.cleanupDeliveredAudio(parseProductRow(product), id, requestLogger(req, product.id, runId, id));
    res.json({ success: true, track: getTrackParsed(id), reference: normalized });
  } catch (error) {
    store.markReferenceError(id, error, product.network_id);
    recomputeProduct(product.id);
    logEvent(req, product.id, { track_id: id, action: "reference_from_claim", status: "error", message: errorMessage(error), payload: { run_id: runId } });
    fail(res, error, { track: getTrackParsed(id) });
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function syncTrackWithCms(ctx, row) {
  const [asset, referenceList] = await Promise.all([
    service.getAssetDetail(ctx, row.asset_id),
    service.listReferences(ctx, row.asset_id)
  ]);
  const references = toArray(referenceList).filter(isObject);
  const newest = pickNewestReference(references, row.reference_id);
  const hasLive = references.some((item) => service.isLiveReferenceStatus(refStatus(item)));

  const steps = normalizeSteps(parseJson(row.steps_json, {}));
  steps.insert = true;
  if (asset?.ownership && toArray(asset.ownership.general).length) steps.ownership = true;
  if (asset?.matchPolicy && (asset.matchPolicy.policyId || toArray(asset.matchPolicy.rules).length)) steps.policy = true;
  if (references.length) steps.reference = true;

  // A local takedown survives every non-live CMS state (deactivating, inactive, unknown); only
  // a reference that is live again ends it.
  let status;
  if (hasLive) status = "completed";
  else if (row.status === "taken_down") status = "taken_down";
  else if (row.status === "error" && (!steps.ownership || !steps.policy)) status = "error";
  else status = "created";

  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET status = ?,
        step = CASE WHEN ? = 'error' THEN step ELSE 'sync' END,
        asset_status = ?,
        reference_id = COALESCE(?, reference_id),
        reference_status = ?,
        reference_content_type = COALESCE(?, reference_content_type),
        steps_json = ?,
        cms_json = ?,
        error_message = CASE WHEN ? = 'error' THEN error_message ELSE NULL END,
        last_synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    status,
    status,
    cleanText(asset?.status).toLowerCase() || null,
    cleanText(newest?.id) || null,
    newest ? (refStatus(newest) || null) : null,
    cleanText(newest?.contentType).toLowerCase() || null,
    JSON.stringify(steps),
    JSON.stringify({ asset: asset || {}, references }),
    status,
    row.id
  );

  return { status, asset, references };
}

async function syncTrack(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { id, track, product } = loaded;
  // A retry request that is still working on this track owns its status.
  if (jobs.isTrackRunning(id)) return conflictInFlight(res, id);
  if (!cleanText(track.asset_id)) return res.status(400).json({ success: false, message: "This track has no asset ID to sync" });
  // The job owns the status of the tracks it is working on; syncing one now would overwrite it.
  if (jobs.isRunning(product.id) && store.IN_FLIGHT_TRACK_STATUSES.has(track.status)) {
    return conflictRunning(res, product.id, { track: getTrackParsed(id) });
  }

  const runId = randomUUID();
  try {
    const ctx = observed(req, await service.authContext(product.network_id), product.id, { trackId: id, step: "sync", runId });
    const result = await syncTrackWithCms(ctx, track);
    recomputeProduct(product.id);
    logEvent(req, product.id, {
      track_id: id,
      action: "sync",
      message: `Synced from CMS (${result.status}, ${result.references.length} reference(s))`,
      payload: { run_id: runId, status: result.status, references: result.references.length }
    });
    res.json({ success: true, track: getTrackParsed(id), product: getProductDetail(product.id) });
  } catch (error) {
    db.prepare("UPDATE content_id_delivery_tracks SET error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(errorMessage(error), id);
    logEvent(req, product.id, { track_id: id, action: "sync", status: "error", message: errorMessage(error), payload: { run_id: runId } });
    fail(res, error, { track: getTrackParsed(id) });
  }
}

async function syncProduct(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });

  // Tracks the running job is still working on keep their in-flight status (the job persists
  // the outcome itself); every other delivered track is reconciled with CMS.
  const running = jobs.isRunning(id);
  const tracks = listTrackRows(id)
    .filter((track) => cleanText(track.asset_id) && !jobs.isTrackRunning(track.id)
      && !(running && store.IN_FLIGHT_TRACK_STATUSES.has(track.status)));
  const errors = [];
  const runId = randomUUID();

  if (tracks.length) {
    let ctx;
    try {
      ctx = await service.authContext(row.network_id);
    } catch (error) {
      logEvent(req, id, { action: "sync", status: "error", message: errorMessage(error), payload: { run_id: runId } });
      return fail(res, error);
    }

    await service.mapWithConcurrency(tracks, CMS_CONCURRENCY, async (track) => {
      try {
        await syncTrackWithCms(observed(req, ctx, id, { trackId: track.id, step: "sync", runId }), track);
      } catch (error) {
        store.noteCmsAuthFailure(error, row.network_id);
        errors.push({ track_id: track.id, message: errorMessage(error) });
      }
    });
  }

  db.prepare("UPDATE content_id_delivery_products SET last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  // A product-level sync is an explicit reconcile with CMS, so it also finalizes a product that
  // was left in "delivering" by an interrupted delivery run - unless the job is still running.
  recomputeProduct(id, { finalize: !running });
  logEvent(req, id, {
    action: "sync",
    status: errors.length ? "error" : "ok",
    message: `Synced ${tracks.length - errors.length} of ${tracks.length} track(s) from CMS`,
    payload: { errors, run_id: runId }
  });

  res.json({ success: true, product: getProductDetail(id), errors });
}

// ---------------------------------------------------------------------------
// Edit product / track metadata
// ---------------------------------------------------------------------------

function pickProvided(source, keys) {
  const picked = {};
  keys.forEach((key) => {
    if (Object.hasOwn(source, key)) picked[key] = source[key];
  });
  return picked;
}

async function updateProduct(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });

  const body = isObject(req.body) ? req.body : {};
  const source = isObject(body.product) ? body.product : {};
  const applyToCms = flagOr(body.apply_to_cms, false);

  const current = {};
  PRODUCT_FIELDS.forEach((key) => {
    current[key] = row[key];
  });
  const fieldErrors = {};
  const fields = validateProductFields({ ...current, ...pickProvided(source, PRODUCT_FIELDS) }, fieldErrors);
  if (Object.keys(fieldErrors).length) return validationFailure(res, fieldErrors);

  db.prepare(`
    UPDATE content_id_delivery_products
    SET title = ?, artist = ?, upc = ?, label = ?, genre = ?, release_date = ?,
        artwork_name = ?, artwork_data_url = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    fields.title, fields.artist, fields.upc, fields.label, fields.genre, fields.release_date,
    fields.artwork_name, fields.artwork_data_url, fields.notes, id
  );

  const errors = [];
  let patched = 0;
  const runId = randomUUID();
  if (applyToCms) {
    const product = parseProductRow(getProductRow(id));
    const tracks = listTrackRows(id).map(parseTrackRow).filter((track) => cleanText(track.asset_id));
    if (tracks.length) {
      let ctx = null;
      try {
        ctx = await service.authContext(row.network_id);
      } catch (error) {
        tracks.forEach((track) => errors.push({ track_id: track.id, message: errorMessage(error) }));
      }

      if (ctx) {
        await service.mapWithConcurrency(tracks, CMS_CONCURRENCY, async (track) => {
          try {
            const metadata = service.buildProductMetadata(product, track);
            await service.patchAssetMetadata(observed(req, ctx, id, { trackId: track.id, step: "metadata", runId }), track.asset_id, metadata);
            db.prepare("UPDATE content_id_delivery_tracks SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
              .run(JSON.stringify(metadata), track.id);
            patched += 1;
          } catch (error) {
            store.noteCmsAuthFailure(error, row.network_id);
            errors.push({ track_id: track.id, message: errorMessage(error) });
          }
        });
      }
    }
  }

  logEvent(req, id, {
    action: "metadata_update",
    status: errors.length ? "error" : "ok",
    message: applyToCms
      ? `Release info updated and applied to ${patched} asset(s)` + (errors.length ? `, ${errors.length} failed` : "")
      : "Release info updated locally",
    payload: { changes: pickProvided(source, PRODUCT_FIELDS.filter((key) => key !== "artwork_data_url")), apply_to_cms: applyToCms, errors, run_id: runId }
  });

  res.json({ success: true, product: getProductDetail(id), errors });
}

async function updateTrack(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { id, track: row, product: productRow } = loaded;

  const body = isObject(req.body) ? req.body : {};
  const source = isObject(body.track) ? body.track : {};
  const applyToCms = flagOr(body.apply_to_cms, false);
  const provided = pickProvided(source, TRACK_FIELDS);

  const fieldErrors = {};
  const titleErrors = [];
  const title = validateTitleInput(Object.hasOwn(provided, "title") ? provided.title : row.title, titleErrors);
  if (titleErrors.length) fieldErrors.title = titleErrors.join("; ");
  const notesErrors = [];
  const notes = Object.hasOwn(provided, "notes") ? validateNotesInput(provided.notes, notesErrors) : row.notes;
  if (notesErrors.length) fieldErrors.notes = notesErrors.join("; ");

  const rule = isrcRuleOf(productRow.asset_type);
  const isrcErrors = [];
  const isrc = validateIsrcInput(Object.hasOwn(provided, "isrc") ? provided.isrc : row.isrc, rule, isrcErrors);
  if (isrcErrors.length) {
    fieldErrors.isrc = isrcErrors.join("; ");
  } else if (isrc) {
    const sibling = db.prepare(`
      SELECT id FROM content_id_delivery_tracks WHERE product_id = ? AND isrc = ? AND id != ? LIMIT 1
    `).get(row.product_id, isrc, id);
    if (sibling) fieldErrors.isrc = `ISRC ${isrc} is already used by another ${rule === "required" ? "track" : "video"} in this product`;
    else {
      const conflict = findIsrcConflict(isrc, { excludeTrackId: id });
      if (conflict) fieldErrors.isrc = conflictMessage(isrc, conflict);
    }
  }
  const descriptionErrors = [];
  const description = Object.hasOwn(provided, "description") ? validateDescriptionInput(provided.description, descriptionErrors) : row.description;
  if (descriptionErrors.length) fieldErrors.description = descriptionErrors.join("; ");
  const urlErrors = [];
  const sourceUrl = Object.hasOwn(provided, "source_url") ? validateSourceUrlInput(provided.source_url, urlErrors) : row.source_url;
  if (urlErrors.length) fieldErrors.source_url = urlErrors.join("; ");
  const customIdErrors = [];
  const customId = Object.hasOwn(provided, "custom_id") ? (validateCustomIdInput(provided.custom_id, customIdErrors) || null) : row.custom_id;
  if (customIdErrors.length) fieldErrors.custom_id = customIdErrors.join("; ");
  if (Object.keys(fieldErrors).length) return validationFailure(res, fieldErrors);

  const artist = Object.hasOwn(provided, "artist") ? (cleanText(provided.artist) || null) : row.artist;
  const previousLabels = parseTrackLabels(row.asset_labels);
  const nextLabels = Object.hasOwn(provided, "asset_labels") ? normalizeTrackLabels(provided.asset_labels) : previousLabels;
  const labelsChanged = JSON.stringify(previousLabels) !== JSON.stringify(nextLabels);

  db.prepare(`
    UPDATE content_id_delivery_tracks
    SET title = ?, artist = ?, isrc = ?, custom_id = ?, notes = ?, description = ?, source_url = ?, asset_labels = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, artist, isrc, customId, notes, description || null, sourceUrl || null, nextLabels ? JSON.stringify(nextLabels) : null, id);

  let cmsError = null;
  let applied = false;
  const runId = randomUUID();
  if (applyToCms && cleanText(row.asset_id)) {
    try {
      const ctx = observed(req, await service.authContext(productRow.network_id), row.product_id, { trackId: id, step: "metadata", runId });
      const product = parseProductRow(productRow);
      const track = getTrackParsed(id);
      const metadata = service.buildProductMetadata(product, track);
      await service.patchAssetMetadata(ctx, row.asset_id, metadata);
      db.prepare("UPDATE content_id_delivery_tracks SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(JSON.stringify(metadata), id);
      if (labelsChanged) {
        await service.patchAssetLabels(ctx, row.asset_id, track.asset_labels ?? product.asset_labels);
      }
      applied = true;
    } catch (error) {
      cmsError = error;
    }
  }

  logEvent(req, row.product_id, {
    track_id: id,
    action: "metadata_update",
    status: cmsError ? "error" : "ok",
    message: cmsError
      ? `Track updated locally but the CMS update failed: ${errorMessage(cmsError)}`
      : (applied ? "Track metadata updated and applied to CMS" : "Track metadata updated locally"),
    payload: { changes: provided, apply_to_cms: applyToCms, labels_changed: labelsChanged, run_id: runId }
  });

  if (cmsError) return fail(res, cmsError, { track: getTrackParsed(id), product: getProductDetail(row.product_id) });
  res.json({ success: true, track: getTrackParsed(id), product: getProductDetail(row.product_id) });
}

// ---------------------------------------------------------------------------
// Rights (ownership / policy / labels)
// ---------------------------------------------------------------------------

function updateTrackSteps(trackId, patch) {
  const row = getTrackRow(trackId);
  if (!row) return;
  const steps = normalizeSteps({ ...parseJson(row.steps_json, {}), ...patch });
  db.prepare("UPDATE content_id_delivery_tracks SET steps_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(JSON.stringify(steps), trackId);
}

async function updateRights(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });

  const body = isObject(req.body) ? req.body : {};
  const hasOwnership = isObject(body.ownership);
  const hasPolicy = Object.hasOwn(body, "match_policy_id");
  const hasLabels = Object.hasOwn(body, "asset_labels") && body.asset_labels !== null && body.asset_labels !== undefined;
  if (!hasOwnership && !hasPolicy && !hasLabels) {
    return res.status(400).json({ success: false, message: "Provide ownership, match_policy_id or asset_labels to update" });
  }

  const fieldErrors = {};
  const ownership = hasOwnership ? validateOwnershipInput(body.ownership, fieldErrors) : null;
  const matchPolicyId = hasPolicy ? cleanText(body.match_policy_id) : "";
  if (hasPolicy && !matchPolicyId) fieldErrors.match_policy_id = "Match policy is required";
  const matchPolicyName = Object.hasOwn(body, "match_policy_name") ? (cleanText(body.match_policy_name) || null) : row.match_policy_name;
  const labels = hasLabels ? service.splitList(body.asset_labels) : null;
  if (Object.keys(fieldErrors).length) return validationFailure(res, fieldErrors);

  const requested = toIdSet(body.track_ids);
  const previousProduct = parseProductRow(row);
  const allTracks = listTrackRows(id);

  const applyLocal = db.transaction(() => {
    if (hasOwnership) {
      db.prepare("UPDATE content_id_delivery_products SET ownership_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(JSON.stringify(ownership), id);
    }
    if (hasPolicy) {
      db.prepare("UPDATE content_id_delivery_products SET match_policy_id = ?, match_policy_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(matchPolicyId, matchPolicyName, id);
    }
    if (hasLabels) {
      // Tracks outside the selection keep the labels they effectively had in CMS.
      if (requested.size) {
        const freeze = db.prepare("UPDATE content_id_delivery_tracks SET asset_labels = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        allTracks
          .filter((track) => !requested.has(track.id) && parseTrackLabels(track.asset_labels) === null)
          .forEach((track) => freeze.run(JSON.stringify(previousProduct.asset_labels), track.id));
      }
      db.prepare("UPDATE content_id_delivery_products SET asset_labels = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(JSON.stringify(labels), id);
    }
  });
  applyLocal();

  const targets = allTracks.filter((track) => cleanText(track.asset_id) && (!requested.size || requested.has(track.id)));
  const errors = [];
  let updated = 0;
  const runId = randomUUID();

  if (targets.length) {
    let baseCtx = null;
    try {
      baseCtx = await service.authContext(row.network_id);
    } catch (error) {
      targets.forEach((track) => errors.push({ track_id: track.id, message: errorMessage(error) }));
    }

    if (baseCtx) {
      await service.mapWithConcurrency(targets, CMS_CONCURRENCY, async (track) => {
        const ctx = observed(req, baseCtx, id, { trackId: track.id, step: "rights", runId });
        try {
          if (hasOwnership) {
            const rights = service.buildOwnership({ ...ownership, contentOwnerId: ctx.contentOwnerId });
            await service.updateOwnership(ctx, track.asset_id, rights);
            db.prepare("UPDATE content_id_delivery_tracks SET ownership_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
              .run(JSON.stringify(rights), track.id);
            updateTrackSteps(track.id, { ownership: true });
          }
          if (hasPolicy) {
            await service.updateMatchPolicy(ctx, track.asset_id, { policy_id: matchPolicyId });
            db.prepare("UPDATE content_id_delivery_tracks SET match_policy_id = ?, match_policy_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
              .run(matchPolicyId, matchPolicyName, track.id);
            updateTrackSteps(track.id, { policy: true });
          }
          if (hasLabels) {
            await service.patchAssetLabels(ctx, track.asset_id, labels);
            db.prepare("UPDATE content_id_delivery_tracks SET asset_labels = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
              .run(requested.size ? JSON.stringify(labels) : null, track.id);
            updateTrackSteps(track.id, { labels: true });
          }
          updated += 1;
        } catch (error) {
          store.noteCmsAuthFailure(error, row.network_id);
          errors.push({ track_id: track.id, message: errorMessage(error) });
        }
      });
    }
  }

  recomputeProduct(id);
  logEvent(req, id, {
    action: "rights_update",
    status: errors.length ? "error" : "ok",
    message: `Rights updated on ${updated} of ${targets.length} asset(s)` + (errors.length ? `, ${errors.length} failed` : ""),
    payload: {
      ownership: hasOwnership ? ownership : undefined,
      match_policy_id: hasPolicy ? matchPolicyId : undefined,
      match_policy_name: hasPolicy ? matchPolicyName : undefined,
      asset_labels: hasLabels ? labels : undefined,
      track_ids: Array.from(requested),
      errors,
      run_id: runId
    }
  });

  res.json({ success: true, product: getProductDetail(id), errors });
}

// ---------------------------------------------------------------------------
// Takedown / reactivate
// ---------------------------------------------------------------------------

function joinErrors(errors) {
  if (!errors.length) return "";
  if (errors.length === 1) return errors[0].message;
  return `${errors.length} errors: ${errors.map((item) => item.message).join("; ")}`;
}

// Every reference and claim is attempted even when an earlier one fails. The track is only
// "taken_down" when every reference could be deactivated; otherwise it is an error at the
// takedown step (claim failures are reported but do not block the takedown).
async function runTakedown(ctx, track, { releaseClaims }) {
  const result = { track_id: track.id, references_deactivated: 0, claims_released: 0, error: "", errors: [] };
  let references = null;
  let referenceFailures = 0;

  try {
    references = toArray(await service.listReferences(ctx, track.asset_id)).filter(isObject);
  } catch (error) {
    store.noteCmsAuthFailure(error);
    referenceFailures += 1;
    result.errors.push({ scope: "references", message: `Could not list references: ${errorMessage(error)}` });
  }

  if (references) {
    for (const reference of references) {
      const referenceId = cleanText(reference.id);
      if (!referenceId || service.isDeadReferenceStatus(refStatus(reference))) continue;
      try {
        await service.patchReferenceStatus(ctx, referenceId, "inactive", { releaseClaims });
        result.references_deactivated += 1;
      } catch (error) {
        store.noteCmsAuthFailure(error);
        referenceFailures += 1;
        result.errors.push({ scope: "reference", reference_id: referenceId, message: `Reference ${referenceId}: ${errorMessage(error)}` });
      }
    }
  }

  if (releaseClaims) {
    let claims = [];
    try {
      claims = await service.searchClaimsByAsset(ctx, track.asset_id);
    } catch (error) {
      store.noteCmsAuthFailure(error);
      result.errors.push({ scope: "claims", message: `Could not list claims: ${errorMessage(error)}` });
    }
    for (const claim of claims) {
      if (!RELEASABLE_CLAIM_STATUSES.has(claim.status)) continue;
      try {
        await service.releaseClaim(ctx, claim.claim_id);
        result.claims_released += 1;
      } catch (error) {
        store.noteCmsAuthFailure(error);
        result.errors.push({ scope: "claim", claim_id: claim.claim_id, message: `Claim ${claim.claim_id}: ${errorMessage(error)}` });
      }
    }
  }

  result.error = joinErrors(result.errors);
  if (!referenceFailures) {
    db.prepare(`
      UPDATE content_id_delivery_tracks
      SET status = 'taken_down',
          step = 'takedown',
          reference_status = CASE WHEN reference_id IS NULL THEN reference_status ELSE 'inactive' END,
          error_message = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(result.error || null, track.id);
  } else {
    db.prepare("UPDATE content_id_delivery_tracks SET status = 'error', step = 'takedown', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(result.error, track.id);
  }
  return result;
}

async function runReactivate(ctx, track) {
  const result = { track_id: track.id, references_activated: 0, error: "" };
  try {
    const references = toArray(await service.listReferences(ctx, track.asset_id)).filter(isObject);
    const patchedStatus = new Map();
    for (const reference of references) {
      if (refStatus(reference) !== "inactive" || !cleanText(reference.id)) continue;
      const updated = await service.patchReferenceStatus(ctx, reference.id, "active");
      patchedStatus.set(cleanText(reference.id), refStatus(updated) || "active");
      result.references_activated += 1;
    }

    const usable = references.filter((reference) => refStatus(reference) !== "deleted");
    const statusOf = (reference) => patchedStatus.get(cleanText(reference.id)) || refStatus(reference);
    const newest = pickNewestReference(usable, track.reference_id);
    const referenceStatus = newest ? statusOf(newest) : null;
    const anyLive = usable.some((reference) => service.isLiveReferenceStatus(statusOf(reference)));

    // Right after a takedown Google reports the reference as "deactivating" for a while (longer
    // when claims were released). It cannot be activated yet, so the local takedown marker must
    // survive until a later attempt: the catch below records the error without touching the status.
    if (!anyLive && !result.references_activated) {
      const settling = usable.find((reference) => statusOf(reference) === "deactivating");
      if (settling) {
        throw Object.assign(
          new Error(`Reference ${cleanText(settling.id)} is still being deactivated by Google; try again in a few minutes`),
          { status: 409 }
        );
      }
    }

    db.prepare(`
      UPDATE content_id_delivery_tracks
      SET status = ?,
          step = 'reactivate',
          reference_id = COALESCE(?, reference_id),
          reference_status = COALESCE(?, reference_status),
          error_message = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(anyLive ? "completed" : "created", cleanText(newest?.id) || null, referenceStatus || null, track.id);
  } catch (error) {
    store.noteCmsAuthFailure(error);
    result.error = errorMessage(error);
    db.prepare("UPDATE content_id_delivery_tracks SET step = 'reactivate', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(result.error, track.id);
  }
  return result;
}

function selectDeliveredTracks(productId, requested) {
  return listTrackRows(productId)
    .filter((track) => cleanText(track.asset_id) && (!requested.size || requested.has(track.id)));
}

async function performTakedown(req, res, productRow, targets, { single = false } = {}) {
  const body = isObject(req.body) ? req.body : {};
  const releaseClaims = flagOr(body.release_claims, true);
  const reason = cleanText(body.reason);
  if (!targets.length) return res.status(400).json({ success: false, message: "No delivered tracks to take down" });
  const runId = randomUUID();

  let ctx;
  try {
    ctx = await service.authContext(productRow.network_id);
  } catch (error) {
    logEvent(req, productRow.id, { action: "takedown", status: "error", message: errorMessage(error), payload: { run_id: runId } });
    return fail(res, error);
  }

  const results = await service.mapWithConcurrency(targets, CMS_CONCURRENCY, (track) =>
    runTakedown(observed(req, ctx, productRow.id, { trackId: track.id, step: "takedown", runId }), track, { releaseClaims }));
  const failed = results.filter((item) => item.error).length;
  const references = results.reduce((sum, item) => sum + item.references_deactivated, 0);
  const claims = results.reduce((sum, item) => sum + item.claims_released, 0);

  recomputeProduct(productRow.id);
  logEvent(req, productRow.id, {
    track_id: single ? targets[0].id : null,
    action: "takedown",
    status: failed ? "error" : "ok",
    message: `Takedown: ${results.length - failed} of ${results.length} track(s), ${references} reference(s) deactivated, ${claims} claim(s) released`
      + (reason ? ` - ${reason}` : ""),
    payload: { reason, release_claims: releaseClaims, track_ids: targets.map((track) => track.id), results, run_id: runId }
  });

  const payload = { success: true, product: getProductDetail(productRow.id), results };
  if (single) payload.track = getTrackParsed(targets[0].id);
  res.json(payload);
}

async function performReactivate(req, res, productRow, targets, { single = false } = {}) {
  if (!targets.length) return res.status(400).json({ success: false, message: "No delivered tracks to reactivate" });
  const runId = randomUUID();

  let ctx;
  try {
    ctx = await service.authContext(productRow.network_id);
  } catch (error) {
    logEvent(req, productRow.id, { action: "reactivate", status: "error", message: errorMessage(error), payload: { run_id: runId } });
    return fail(res, error);
  }

  const results = await service.mapWithConcurrency(targets, CMS_CONCURRENCY, (track) =>
    runReactivate(observed(req, ctx, productRow.id, { trackId: track.id, step: "reactivate", runId }), track));
  const failed = results.filter((item) => item.error).length;
  const references = results.reduce((sum, item) => sum + item.references_activated, 0);

  recomputeProduct(productRow.id);
  logEvent(req, productRow.id, {
    track_id: single ? targets[0].id : null,
    action: "reactivate",
    status: failed ? "error" : "ok",
    message: `Reactivated ${results.length - failed} of ${results.length} track(s), ${references} reference(s) activated`,
    payload: { track_ids: targets.map((track) => track.id), results, run_id: runId }
  });

  const payload = { success: true, product: getProductDetail(productRow.id), results };
  if (single) payload.track = getTrackParsed(targets[0].id);
  res.json(payload);
}

async function takedownProduct(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });
  if (isExplicitEmptyList(req.body, "track_ids")) return res.status(400).json({ success: false, message: "Select at least one track" });
  const targets = selectDeliveredTracks(id, toIdSet(req.body?.track_ids));
  await performTakedown(req, res, row, targets);
}

async function reactivateProduct(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });
  if (isExplicitEmptyList(req.body, "track_ids")) return res.status(400).json({ success: false, message: "Select at least one track" });
  const requested = toIdSet(req.body?.track_ids);
  const targets = selectDeliveredTracks(id, requested)
    .filter((track) => requested.size || track.status === "taken_down");
  await performReactivate(req, res, row, targets);
}

async function takedownTrack(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { track, product } = loaded;
  if (!cleanText(track.asset_id)) return res.status(400).json({ success: false, message: "This track has no asset ID" });
  await performTakedown(req, res, product, [track], { single: true });
}

async function reactivateTrack(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { track, product } = loaded;
  if (!cleanText(track.asset_id)) return res.status(400).json({ success: false, message: "This track has no asset ID" });
  await performReactivate(req, res, product, [track], { single: true });
}

async function listTrackClaims(req, res) {
  const loaded = loadTrackAndProduct(req, res);
  if (!loaded) return;
  const { track, product } = loaded;
  if (!cleanText(track.asset_id)) return res.status(400).json({ success: false, message: "This track has no asset ID" });

  try {
    const claims = await service.searchClaimsByAsset(product.network_id, track.asset_id);
    res.json({ success: true, claims });
  } catch (error) {
    fail(res, error);
  }
}

// ---------------------------------------------------------------------------
// List / detail / delete
// ---------------------------------------------------------------------------

function listProducts(req, res) {
  const networkId = parseId(req.query.network_id);
  const status = cleanText(req.query.status).toLowerCase();
  const search = cleanText(req.query.search);
  const page = clampInt(req.query.page, 1, 1000000, 1);
  const requestedSize = Number(req.query.page_size);
  const pageSize = PAGE_SIZES.has(requestedSize) ? requestedSize : DEFAULT_PAGE_SIZE;

  const clauses = [];
  const params = [];
  if (networkId) {
    clauses.push("p.network_id = ?");
    params.push(networkId);
  }
  // The music page lists sound recordings, the video page web/music videos (`kind`), or one type.
  const kind = cleanText(req.query.kind).toLowerCase();
  const assetType = cleanText(req.query.asset_type).toLowerCase();
  const typeFilter = service.isAssetType(assetType)
    ? { sql: "p.asset_type = ?", params: [assetType] }
    : kind === "video"
      ? { sql: "p.asset_type IN ('web', 'music_video')", params: [] }
      : kind === "music"
        ? { sql: "p.asset_type = 'sound_recording'", params: [] }
        : null;
  if (typeFilter) {
    clauses.push(typeFilter.sql);
    params.push(...typeFilter.params);
  }
  if (status && PRODUCT_STATUSES.has(status)) {
    clauses.push("p.status = ?");
    params.push(status);
  }
  if (search) {
    const like = `%${search}%`;
    // Items match by ISRC, asset ID, custom ID (the only identifier of a web video) or title.
    clauses.push(`(
      p.title LIKE ? OR p.artist LIKE ? OR p.upc LIKE ?
      OR EXISTS (
        SELECT 1 FROM content_id_delivery_tracks t
        WHERE t.product_id = p.id AND (t.isrc LIKE ? OR t.asset_id LIKE ? OR t.custom_id LIKE ? OR t.title LIKE ?)
      )
    )`);
    params.push(like, like, like, like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const total = db.prepare(`SELECT COUNT(*) AS count FROM content_id_delivery_products p ${where}`).get(...params).count;
  const rows = db.prepare(`
    SELECT p.*,
      (
        SELECT COALESCE(SUM(CASE WHEN t.file_path IS NOT NULL AND t.file_path <> '' THEN 1 ELSE 0 END), 0)
        FROM content_id_delivery_tracks t
        WHERE t.product_id = p.id
      ) AS audio_count
    FROM content_id_delivery_products p
    ${where}
    ORDER BY p.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  const summaryClauses = [];
  const summaryParams = [];
  if (networkId) {
    summaryClauses.push("p.network_id = ?");
    summaryParams.push(networkId);
  }
  if (typeFilter) {
    summaryClauses.push(typeFilter.sql);
    summaryParams.push(...typeFilter.params);
  }
  const summaryWhere = summaryClauses.length ? `WHERE ${summaryClauses.join(" AND ")}` : "";
  const productCount = db.prepare(`SELECT COUNT(*) AS count FROM content_id_delivery_products p ${summaryWhere}`).get(...summaryParams).count;
  const trackStats = db.prepare(`
    SELECT
      COUNT(*) AS tracks,
      SUM(CASE WHEN t.asset_id IS NOT NULL AND t.asset_id != '' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN t.status = 'taken_down' THEN 1 ELSE 0 END) AS taken_down
    FROM content_id_delivery_tracks t
    JOIN content_id_delivery_products p ON p.id = t.product_id
    ${summaryWhere}
  `).get(...summaryParams) || {};

  res.json({
    success: true,
    products: rows.map((row) => ({ ...parseProductRow(row), audio_count: Number(row.audio_count) || 0, job_running: jobs.isRunning(row.id) })),
    total,
    page,
    page_size: pageSize,
    summary: {
      products: productCount,
      tracks: Number(trackStats.tracks) || 0,
      delivered: Number(trackStats.delivered) || 0,
      completed: Number(trackStats.completed) || 0,
      errors: Number(trackStats.errors) || 0,
      taken_down: Number(trackStats.taken_down) || 0
    }
  });
}

function getProduct(req, res) {
  const id = parseId(req.params.id);
  noteInterruptedIfStale(getProductRow(id));
  const product = getProductDetail(id);
  if (!product) return res.status(404).json({ success: false, message: "Product not found" });
  product.job = productJobInfo(product);
  res.json({ success: true, product });
}

// Deletes the local record (rows + stored audio); assets and references stay in CMS. Library
// codes are never touched here: drafts never marked any, delivered products keep theirs used.
async function deleteProduct(req, res) {
  const id = parseId(req.params.id);
  const row = getProductRow(id);
  if (!row) return res.status(404).json({ success: false, message: "Product not found" });
  if (jobs.isRunning(id)) return conflictRunning(res, id);

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM content_id_delivery_events WHERE product_id = ?").run(id);
    db.prepare("DELETE FROM content_id_delivery_tracks WHERE product_id = ?").run(id);
    db.prepare("DELETE FROM content_id_delivery_products WHERE id = ?").run(id);
  });
  remove();

  try {
    await media.removeProductMedia(id);
  } catch (error) {
    console.error(`[cms-delivery] could not remove the media folder of product ${id}: ${error?.message || error}`);
  }
  res.json({ success: true });
}

module.exports = {
  checkDraftAudio,
  checkDuplicates,
  cleanupProductAudio,
  createAssetLabel,
  createProduct,
  deleteDraftAudio,
  deleteProduct,
  deleteTrackAudio,
  deliverProduct,
  deliverReference,
  exportProductLogs,
  getOptions,
  getProduct,
  getProductProgress,
  getTrackAudio,
  listProductLogRuns,
  listProductLogs,
  listProducts,
  listTrackClaims,
  reactivateProduct,
  reactivateTrack,
  recomputeProduct,
  referenceFromClaim,
  retryTrack,
  syncProduct,
  syncTrack,
  takedownProduct,
  takedownTrack,
  updateProduct,
  updateRights,
  updateTrack,
  uploadAudio,
  uploadDraftAudio
};
