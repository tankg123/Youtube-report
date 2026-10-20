// Background delivery job: creates the Sound Recording assets of a product and uploads the
// stored audio files as references, without holding the HTTP request open. One job per
// product at a time; the controller polls progress from the track rows.
const service = require("./assetDeliveryService");
const media = require("./deliveryMediaService");
const store = require("./deliveryStore");
const { randomUUID } = require("crypto");

const DELIVER_CONCURRENCY = 2;
const jobs = new Map();
// Request-scoped runs (retryTrack) that no product job knows about. A stale in-flight row left
// by a crash has no entry here, so it stays deliverable; a live run makes Deliver / reference /
// sync wait instead of working on the same track twice.
const trackRuns = new Set();

function jobKey(productId) {
  return store.parseId(productId);
}

function isRunning(productId) {
  return jobs.has(jobKey(productId));
}

function isTrackRunning(trackId) {
  return trackRuns.has(store.parseId(trackId));
}

// Claims a track for a request-scoped run. Returns false when another run already holds it.
function beginTrackRun(trackId) {
  const key = store.parseId(trackId);
  if (!key || trackRuns.has(key)) return false;
  trackRuns.add(key);
  return true;
}

function endTrackRun(trackId) {
  trackRuns.delete(store.parseId(trackId));
}

function getJob(productId) {
  const job = jobs.get(jobKey(productId));
  if (!job) return null;
  return { running: true, run_id: job.runId, started_at: job.startedAt, track_ids: job.trackIds.slice() };
}

// Test hook: resolves with the job summary once the job for that product has finished
// (immediately with null when nothing is running).
function waitForJob(productId) {
  const job = jobs.get(jobKey(productId));
  return job ? job.promise : Promise.resolve(null);
}

function summarize(results) {
  const summary = { created: 0, references: 0, duplicate: 0, error: 0 };
  results.forEach((result) => {
    if (result.status === "duplicate") summary.duplicate += 1;
    else if (result.status === "error") summary.error += 1;
    if (result.asset_created) summary.created += 1;
    if (result.reference) summary.references += 1;
  });
  return summary;
}

const { assetStepsDone } = store;

function eventLogger(productId, runId, actor, trackId = null) {
  return (action, phase, message, payload = {}) => store.logEvent(productId, {
    track_id: trackId,
    action,
    status: phase === "failed" ? "error" : phase === "completed" ? "ok" : phase,
    message,
    payload: { ...payload, run_id: runId, phase },
    actor
  });
}

function observedContext(ctx, log, step) {
  return { ...ctx, deliveryStep: step, onApiEvent: (event) => {
    const { phase, message, ...details } = event;
    log("api", phase, `${event.method} ${event.endpoint}: ${message || phase}`, details);
  } };
}

// `reference` may override the product's reference settings (manual "Deliver reference" with
// content_type / urgent) and `reference.force` re-uploads even when a live reference exists.
async function uploadStoredReference(ctx, product, track, log, reference = {}) {
  const audio = media.resolveTrackAudio(track);
  if (!audio) {
    log("reference_upload", "skipped", "No stored audio file is available; reference upload skipped", { step: "reference" });
    return null;
  }

  const contentType = service.normalizeReferenceContentType(reference.contentType, product.reference_content_type || "audio");
  const urgent = reference.urgent === undefined || reference.urgent === null ? Boolean(product.reference_urgent) : Boolean(reference.urgent);
  store.markTrackUploading(track.id);
  const started = Date.now();
  log("reference_upload", "started", `Uploading ${track.file_name || "reference audio"}`, {
    step: "reference", file_name: track.file_name, bytes_total: audio.size, percent: 0,
    content_type: contentType, urgent, force: Boolean(reference.force)
  });
  let stream;
  try {
    stream = media.openTrackAudioStream(track);
    const uploaded = await service.uploadReferenceStream({ ...ctx, deliveryStep: "reference" }, track.asset_id, {
      stream,
      contentLength: audio.size,
      mimeType: audio.mime,
      contentType,
      urgent
    });
    const reference = uploaded;
    const normalized = store.normalizeReference(reference);
    if (normalized.asset_id && normalized.asset_id !== store.cleanText(track.asset_id)) {
      throw new Error("Google returned a reference for a different asset; local audio has been retained");
    }
    if (!normalized.id || !service.isLiveReferenceStatus(normalized.status)) {
      // Keep any returned CMS identity for diagnosis/reconciliation, but never treat an
      // empty or rejected response as permission to remove the only local reference.
      if (normalized.id) store.applyReferenceResult(track.id, reference, {});
      throw new Error(normalized.id
        ? `Reference ${normalized.id} is not ready for delivery (${normalized.status || "unknown status"})`
        : "Google did not return a reference ID");
    }
    store.applyReferenceResult(track.id, reference, {});
    log("reference_upload", "completed", `Reference ${normalized.id} uploaded (${normalized.status})`, {
        step: "reference", duration_ms: Date.now() - started, percent: 100,
        file_name: track.file_name,
        file_size: audio.size,
        content_type: contentType,
        urgent,
        force: Boolean(reference.force),
        reference: normalized
    });
    return { ok: true, reference: normalized };
  } catch (error) {
    store.markReferenceError(track.id, error, product.network_id);
    log("reference_upload", "failed", store.errorMessage(error), { step: "reference", duration_ms: Date.now() - started });
    return { ok: false, message: store.errorMessage(error) };
  } finally {
    // Initiation can fail before Axios starts consuming the file stream.
    if (stream && !stream.destroyed) stream.destroy();
  }
}

async function processTrack(ctx, product, track, { includeReference, log, reference = {} }) {
  const base = {
    track_id: track.id,
    status: "error",
    step: "",
    asset_id: store.cleanText(track.asset_id),
    error_message: "",
    duplicates: store.toArray(track.duplicates),
    asset_created: false,
    reference: null
  };

  let plan;
  try {
    plan = store.buildTrackPlan(product, track, ctx.contentOwnerId);
  } catch (error) {
    store.markTrackError(track.id, "metadata", error, product.network_id);
    return { ...base, step: "metadata", error_message: store.errorMessage(error) };
  }

  let status;
  if (assetStepsDone(track)) {
    // Asset already complete: only the reference step is left for this track.
    status = store.hasLiveReference(track) ? "completed" : "created";
    store.setTrackStatus(track.id, status, null);
  } else {
    store.markTrackCreating(track.id, plan.asset_id ? "ownership" : "insert");
    let result;
    try {
      const stepStarts = new Map();
      result = await service.runSoundRecordingSteps(ctx, plan, {
        onStepStart(step) {
          stepStarts.set(step, Date.now());
          store.markTrackCreating(track.id, step);
          log("delivery_step", "started", `Starting ${step}`, { step });
        },
        onStep(step, ok, data) {
          if (ok) store.recordTrackStep(track.id, step, data);
          log("delivery_step", ok ? "completed" : "failed", ok ? `Completed ${step}` : store.errorMessage(data), {
            step, duration_ms: Date.now() - (stepStarts.get(step) || Date.now()),
            ...(step === "insert" && ok ? { asset_id: store.cleanText(data?.id) } : {})
          });
        }
      });
    } catch (error) {
      store.markTrackError(track.id, "insert", error, product.network_id);
      return { ...base, step: "insert", error_message: store.errorMessage(error) };
    }
    status = store.updateTrackAfterRun(track.id, plan, product, result);
    base.asset_id = store.cleanText(result.asset_id) || base.asset_id;
    if (status === "error") {
      return { ...base, status, step: result.step || "", error_message: store.errorMessage(result.error) };
    }
    base.asset_created = true;
    store.markTrackIsrcUsed(product, track);
  }

  if (!includeReference) return { ...base, status, step: "" };

  const fresh = store.getTrackParsed(track.id);
  if (!fresh || (store.hasLiveReference(fresh) && !reference.force)) return { ...base, status, step: "" };

  const uploaded = await uploadStoredReference(ctx, product, fresh, log, reference);
  if (!uploaded) return { ...base, status, step: "" };
  if (!uploaded.ok) return { ...base, status: "error", step: "reference", error_message: uploaded.message };
  return { ...base, status: "completed", step: "reference", reference: uploaded.reference };
}

async function cleanupDeliveredAudio(product, trackId, log) {
  const track = store.getTrackParsed(trackId);
  if (!store.isAudioReleasable(track)) return;
  const started = Date.now();
  try {
    const removed = await media.removeTrackAudio(track);
    if (!removed) throw new Error("The stored audio path could not be safely removed");
    // Only clear the columns that still point at the file that was removed (a concurrent
    // replacement must keep its own file registered).
    store.clearTrackAudio(trackId, { filePath: track.file_path });
    log("reference_cleanup", "completed", `Removed the delivered file "${track.file_name || "media"}" from this server`, {
      step: "cleanup", file_name: track.file_name, bytes_freed: Number(track.file_size) || 0,
      reference_id: track.reference_id, duration_ms: Date.now() - started
    });
  } catch (error) {
    // A cleanup problem must not turn a successful CMS delivery into a failed upload.
    log("reference_cleanup", "failed", `Delivery succeeded, but removing the local file failed: ${store.errorMessage(error)}`, {
      step: "cleanup", duration_ms: Date.now() - started
    });
  }
}

async function runTrack(ctx, product, track, { includeReference, actor, runId, reference }) {
  const started = Date.now();
  const log = eventLogger(product.id, runId, actor, track.id);
  log("track_delivery", "started", `Delivering track ${track.track_number}: ${track.title}`, { step: "track", percent: 0 });
  let result;
  try {
    result = await processTrack(observedContext(ctx, log, "track"), product, track, { includeReference, log, reference });
  } catch (error) {
    store.markTrackError(track.id, "deliver", error, product.network_id);
    result = { track_id: track.id, status: "error", step: "deliver", error_message: store.errorMessage(error),
      asset_id: store.cleanText(store.getTrackRow(track.id)?.asset_id), asset_created: false, reference: null };
  }
  if (result.status === "completed" && includeReference && product.delete_reference_after_delivery) {
    await cleanupDeliveredAudio(product, track.id, log);
  }
  log("track_delivery", result.status === "error" ? "failed" : "completed",
    result.error_message || `Track finished (${result.status})`, {
      step: result.step || "track", duration_ms: Date.now() - started, percent: 100,
      track_status: result.status, asset_id: result.asset_id, reference_id: result.reference?.id || null
    });
  return result;
}

async function runJob({ productId, trackIds, forceDuplicates, includeReference, actor, runId, startedAt, reference = {} }) {
  const productRow = store.getProductRow(productId);
  if (!productRow) return { summary: summarize([]), results: [] };
  const product = store.parseProductRow(productRow);
  const tracks = trackIds.map((id) => store.getTrackParsed(id)).filter(Boolean);
  const results = new Map();
  const log = eventLogger(productId, runId, actor);
  const started = Date.parse(startedAt);

  let ctx;
  const authStarted = Date.now();
  log("delivery_step", "started", "Authorizing CMS connection", { step: "auth" });
  try {
    ctx = await service.authContext(productRow.network_id);
    log("delivery_step", "completed", "CMS connection authorized", { step: "auth", duration_ms: Date.now() - authStarted });
  } catch (error) {
    const message = store.errorMessage(error);
    log("delivery_step", "failed", message, { step: "auth", duration_ms: Date.now() - authStarted });
    tracks.forEach((track) => {
      store.markTrackError(track.id, "auth", error, productRow.network_id);
      results.set(track.id, { track_id: track.id, status: "error", step: "auth", asset_id: store.cleanText(track.asset_id), error_message: message, duplicates: [] });
      eventLogger(productId, runId, actor, track.id)("track_delivery", "failed", message, { step: "auth" });
    });
    const resultList = Array.from(results.values());
    const summary = summarize(resultList);
    store.finishProductJob(productId, { errorMessage: message });
    store.logEvent(productId, {
      action: "deliver",
      status: "error",
      message: `Delivery failed: ${message}`,
      payload: { run_id: runId, phase: "failed", duration_ms: Date.now() - started, percent: 100,
        summary, force_duplicates: Boolean(forceDuplicates), include_reference: Boolean(includeReference), results: resultList },
      actor
    });
    return { summary, results: resultList };
  }

  store.setProductNetworkInfo(productId, { contentOwnerId: ctx.contentOwnerId, networkName: ctx.network.name });

  if (product.skip_duplicates && !forceDuplicates) {
    // Only items with an ISRC can be matched against CMS (web videos have none).
    const candidates = tracks.filter((track) => !store.cleanText(track.asset_id) && store.cleanText(track.isrc));
    if (candidates.length) {
      let matches = null;
      const checkStarted = Date.now();
      try {
        log("delivery_step", "started", `Checking ${candidates.length} track(s) for duplicate ISRCs`, { step: "check" });
        matches = await service.searchAssetsByIsrc(observedContext(ctx, log, "check"), candidates.map((track) => track.isrc));
        log("delivery_step", "completed", "Duplicate check completed", {
          step: "check", duplicate_isrcs: matches.size, duration_ms: Date.now() - checkStarted
        });
      } catch (error) {
        const wrapped = Object.assign(new Error(`Duplicate check failed: ${store.rawErrorMessage(error)}`), {
          status: error?.status,
          networkId: error?.networkId
        });
        log("delivery_step", "failed", store.errorMessage(wrapped), { step: "check", duration_ms: Date.now() - checkStarted });
        candidates.forEach((track) => {
          store.markTrackError(track.id, "check", wrapped, productRow.network_id);
          results.set(track.id, { track_id: track.id, status: "error", step: "check", asset_id: "", error_message: store.errorMessage(wrapped), duplicates: [] });
          eventLogger(productId, runId, actor, track.id)("track_delivery", "failed", store.errorMessage(wrapped), { step: "check" });
        });
      }
      if (matches) {
        candidates.forEach((track) => {
          if (!matches.has(track.isrc)) return;
          const duplicates = matches.get(track.isrc);
          store.markTrackDuplicate(track.id, duplicates);
          results.set(track.id, { track_id: track.id, status: "duplicate", step: "check", asset_id: "", error_message: "", duplicates });
          eventLogger(productId, runId, actor, track.id)("track_delivery", "skipped", "Skipped an ISRC already present in this CMS", { step: "check", duplicates });
        });
      }
    }
  }

  const toRun = tracks.filter((track) => !results.has(track.id));
  await service.mapWithConcurrency(toRun, DELIVER_CONCURRENCY, async (track) => {
    results.set(track.id, await runTrack(ctx, product, track, { includeReference, actor, runId, reference }));
    log("delivery_progress", "progress", `Processed ${results.size}/${tracks.length} track(s)`, {
      step: "deliver", processed_tracks: results.size, total_tracks: tracks.length,
      percent: Math.round((results.size / Math.max(1, tracks.length)) * 100), duration_ms: Date.now() - started
    });
  });

  const resultList = tracks.map((track) => results.get(track.id)).filter(Boolean);
  const summary = summarize(resultList);
  if (summary.created) store.markProductUpcUsed(product);

  store.finishProductJob(productId);
  store.logEvent(productId, {
    action: "deliver",
    status: summary.error ? "error" : "ok",
    message: `Delivered ${summary.created} of ${tracks.length} track(s), ${summary.references} reference(s) uploaded`
      + (summary.duplicate ? `, ${summary.duplicate} duplicate` : "")
      + (summary.error ? `, ${summary.error} failed` : ""),
    payload: {
      run_id: runId, phase: summary.error ? "failed" : "completed", duration_ms: Date.now() - started, percent: 100,
      summary,
      force_duplicates: Boolean(forceDuplicates),
      include_reference: Boolean(includeReference),
      results: resultList.map(({ asset_created, ...rest }) => rest)
    },
    actor
  });

  return { summary, results: resultList };
}

// Registers the job and returns immediately; the caller must have marked the product
// "delivering" and the selected tracks "creating/queued" already. `reference` carries the
// overrides of a manual reference delivery ({ force, contentType, urgent }).
function startDeliveryJob({ productId, trackIds, forceDuplicates = false, includeReference = true, actor = {}, reference = {} }) {
  const key = jobKey(productId);
  if (!key) throw new Error("productId is required");
  if (jobs.has(key)) {
    const error = new Error("Delivery is already running for this product");
    error.status = 409;
    throw error;
  }

  const options = reference && typeof reference === "object" ? reference : {};
  const job = { runId: randomUUID(), startedAt: new Date().toISOString(), trackIds: trackIds.map(Number), promise: null };
  eventLogger(key, job.runId, actor)("deliver", "started",
    options.force || options.manual
      ? `Started reference delivery of ${job.trackIds.length} track(s)`
      : `Started delivery of ${job.trackIds.length} track(s)`, {
      step: "deliver", percent: 0, track_ids: job.trackIds, include_reference: Boolean(includeReference),
      delete_reference_after_delivery: Boolean(store.getProductRow(key)?.delete_reference_after_delivery),
      ...(options.manual ? { manual_reference: true, force: Boolean(options.force), content_type: options.contentType || null, urgent: options.urgent ?? null } : {})
    });
  jobs.set(key, job);
  job.promise = runJob({ productId: key, trackIds: job.trackIds, forceDuplicates, includeReference, actor,
    runId: job.runId, startedAt: job.startedAt, reference: options })
    .catch((error) => {
      console.error(`[cms-delivery] job for product ${key} failed unexpectedly: ${error?.message || error}`);
      try {
        const message = `Delivery job failed: ${error?.message || "unknown error"}`;
        // Tracks the job never got to finish must not stay "creating"/"uploading" forever: the
        // pollers would wait for them and the counters would treat them as in flight.
        const failure = Object.assign(new Error(message), { googleMessage: message });
        job.trackIds.forEach((trackId) => {
          const row = store.getTrackRow(trackId);
          if (!row || !store.IN_FLIGHT_TRACK_STATUSES.has(row.status)) return;
          store.markTrackError(trackId, row.step && row.step !== "queued" ? row.step : "deliver", failure);
          eventLogger(key, job.runId, actor, trackId)("track_delivery", "failed", message, { step: row.step || "deliver" });
        });
        store.finishProductJob(key, { errorMessage: message });
        eventLogger(key, job.runId, actor)("deliver", "failed", message, {
          step: "deliver", duration_ms: Date.now() - Date.parse(job.startedAt)
        });
      } catch (persistError) {
        console.error(`[cms-delivery] could not record the failure of product ${key}: ${persistError?.message || persistError}`);
      }
      return { summary: summarize([]), results: [], failed: true };
    })
    .finally(() => {
      if (jobs.get(key) === job) jobs.delete(key);
    });
  return getJob(key);
}

// Called when a controller encounters a product left running after a server restart.
// Recording the interruption is idempotent and never removes local reference audio.
function recordInterruptedJob(productId) {
  const key = jobKey(productId);
  const row = store.getProductRow(key);
  if (!row || isRunning(key) || row.status !== "delivering") return false;
  const started = store.listEvents(key, { action: "deliver", status: "started", limit: 1 }).events[0];
  const runId = started?.payload?.run_id || `interrupted-${key}-${row.job_started_at || "unknown"}`;
  if (store.listEvents(key, { action: "delivery_interrupted", runId, limit: 1 }).events.length) return false;
  const log = eventLogger(key, runId, {});
  const tracks = store.listTrackRows(key).filter((track) => store.IN_FLIGHT_TRACK_STATUSES.has(track.status));
  tracks.forEach((track) => eventLogger(key, runId, {}, track.id)("track_delivery", "failed",
    "Delivery was interrupted by a server restart; retry to resume the remaining steps", { step: track.step || "deliver" }));
  log("delivery_interrupted", "failed", "Delivery was interrupted by a server restart", {
    step: "deliver", interrupted_track_ids: tracks.map((track) => track.id)
  });
  return true;
}

// Start-up reconciliation: a fresh process has no running job, so every product still marked
// "delivering" and every track still "creating"/"uploading" (a retry request cut off mid-way)
// was interrupted. In-flight tracks become retryable errors, the product is finalized and the
// interruption is logged (once). Returns the number of products handled.
function reconcileInterruptedJobs() {
  const message = "Delivery was interrupted by a server restart; retry to resume the remaining steps";
  const failure = Object.assign(new Error(message), { googleMessage: message });
  const productIds = new Set([...store.listDeliveringProductIds(), ...store.listProductIdsWithInFlightTracks()]);
  let handled = 0;
  productIds.forEach((productId) => {
    if (isRunning(productId)) return;
    const row = store.getProductRow(productId);
    if (!row) return;
    const stuck = store.listTrackRows(productId).filter((track) => store.IN_FLIGHT_TRACK_STATUSES.has(track.status));
    if (row.status === "delivering") {
      recordInterruptedJob(productId);
    } else if (stuck.length) {
      // A request-scoped action (retry) died with the process: log it under its own run id.
      const runId = `interrupted-${productId}-${new Date().toISOString()}`;
      stuck.forEach((track) => eventLogger(productId, runId, {}, track.id)("track_delivery", "failed", message, { step: track.step || "deliver" }));
      eventLogger(productId, runId, {})("delivery_interrupted", "failed", "A track operation was interrupted by a server restart", {
        step: "deliver", interrupted_track_ids: stuck.map((track) => track.id)
      });
    }
    stuck.forEach((track) => store.markTrackError(track.id, track.step && track.step !== "queued" ? track.step : "deliver", failure));
    if (row.status === "delivering") {
      // The run died between the last track finishing and its bookkeeping when nothing was in
      // flight: the product status/error then come from the tracks alone.
      store.finishProductJob(productId, stuck.length ? { errorMessage: message } : {});
    } else {
      store.recomputeProduct(productId, { finalize: true });
    }
    handled += 1;
  });
  return handled;
}

module.exports = {
  DELIVER_CONCURRENCY,
  beginTrackRun,
  cleanupDeliveredAudio,
  endTrackRun,
  getJob,
  isRunning,
  isTrackRunning,
  reconcileInterruptedJobs,
  recordInterruptedJob,
  startDeliveryJob,
  waitForJob
};
