// Expiry sweep for audio uploaded from the product form before the product was saved
// (content_id_delivery_audio_uploads + <media>/_drafts). A draft that is never attached to a
// track (tab closed, draft discarded, browser cleanup call lost) is removed after its TTL so
// the server does not keep orphaned audio around.
const media = require("./deliveryMediaService");
const store = require("./deliveryStore");

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5000;
// A ".part" file still being written keeps a fresh mtime; one this old was abandoned.
const PARTIAL_TTL_MS = 60 * 60 * 1000;

let timer = null;
let interval = null;
let running = false;

async function sweepExpiredDraftAudio({ now = new Date(), logger = console } = {}) {
  const result = { expired_uploads: 0, removed_files: 0, orphan_files: 0, bytes_freed: 0, errors: 0 };

  for (const upload of store.listExpiredAudioUploads(now)) {
    try {
      const removed = await media.removeDraftAudio(upload);
      if (removed) {
        result.removed_files += 1;
        result.bytes_freed += Number(upload.file_size) || 0;
      }
      store.deleteAudioUpload(upload.id);
      result.expired_uploads += 1;
    } catch (error) {
      result.errors += 1;
      logger.error?.(`[cms-delivery] could not expire draft audio ${upload.id}: ${error?.message || error}`);
    }
  }

  let files = [];
  try {
    files = await media.listDraftFiles();
  } catch (error) {
    result.errors += 1;
    logger.error?.(`[cms-delivery] could not list draft audio files: ${error?.message || error}`);
    return result;
  }
  const known = new Set(store.listAudioUploads(files.map((file) => file.upload_id)).map((upload) => upload.id));
  for (const file of files) {
    const age = now.getTime() - file.modified_at;
    const stale = file.partial
      ? age > PARTIAL_TTL_MS
      : (!file.upload_id || !known.has(file.upload_id)) && age > media.DRAFT_TTL_MS;
    if (!stale) continue;
    try {
      if (await media.removeDraftAudio({ file_path: file.file_path })) {
        result.orphan_files += 1;
        result.bytes_freed += Number(file.size) || 0;
      }
    } catch (error) {
      result.errors += 1;
      logger.error?.(`[cms-delivery] could not remove orphaned draft audio ${file.name}: ${error?.message || error}`);
    }
  }

  return result;
}

async function runSweep(logger) {
  if (running) return null;
  running = true;
  try {
    const result = await sweepExpiredDraftAudio({ logger });
    if (result.expired_uploads || result.orphan_files || result.errors) {
      logger.log?.(`[cms-delivery] draft audio sweep: ${result.expired_uploads} expired upload(s), ${result.orphan_files} orphan file(s), `
        + `${Math.round(result.bytes_freed / (1024 * 1024))} MB freed${result.errors ? `, ${result.errors} error(s)` : ""}`);
    }
    return result;
  } catch (error) {
    logger.error?.(`[cms-delivery] draft audio sweep failed: ${error?.message || error}`);
    return null;
  } finally {
    running = false;
  }
}

// Runs once shortly after start-up, then hourly. Timers are unref'd so they never keep a
// process (or a test) alive.
function scheduleDraftAudioSweep({ initialDelayMs = INITIAL_DELAY_MS, intervalMs = SWEEP_INTERVAL_MS, logger = console } = {}) {
  stopDraftAudioSweep();
  timer = setTimeout(() => runSweep(logger), initialDelayMs);
  timer.unref?.();
  interval = setInterval(() => runSweep(logger), intervalMs);
  interval.unref?.();
}

function stopDraftAudioSweep() {
  if (timer) clearTimeout(timer);
  if (interval) clearInterval(interval);
  timer = null;
  interval = null;
}

module.exports = {
  PARTIAL_TTL_MS,
  SWEEP_INTERVAL_MS,
  scheduleDraftAudioSweep,
  stopDraftAudioSweep,
  sweepExpiredDraftAudio
};
