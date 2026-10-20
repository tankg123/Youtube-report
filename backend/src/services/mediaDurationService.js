// Duration of an MP4-family file (MP4, M4V, MOV) read from the "mvhd" box, without decoding.
// Only box headers are read while walking the top level, so a 10 GB file costs a handful of
// small reads even when "moov" sits after "mdat". Other containers return null (unknown).
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_MIN_VIDEO_REFERENCE_SECONDS = 20;
const MIN_VIDEO_REFERENCE_SECONDS = Number(process.env.CONTENT_ID_MIN_VIDEO_REFERENCE_SECONDS) > 0
  ? Number(process.env.CONTENT_ID_MIN_VIDEO_REFERENCE_SECONDS)
  : DEFAULT_MIN_VIDEO_REFERENCE_SECONDS;
const MP4_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".m4a"]);
const MP4_MIMES = new Set(["video/mp4", "video/x-m4v", "video/quicktime", "audio/mp4"]);
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 10000;

function isMp4Family(fileName, mimeType) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  const mime = String(mimeType || "").split(";")[0].trim().toLowerCase();
  return MP4_EXTENSIONS.has(ext) || MP4_MIMES.has(mime);
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// { size, type, headerSize } of the box starting at `position`, or null at EOF / corrupt data.
async function readBoxHeader(handle, position, fileSize) {
  if (position + 8 > fileSize) return null;
  const header = await readAt(handle, position, 16);
  if (header.length < 8) return null;
  let size = header.readUInt32BE(0);
  const type = header.toString("latin1", 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (header.length < 16) return null;
    size = Number(header.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = fileSize - position;
  }
  if (!Number.isFinite(size) || size < headerSize) return null;
  return { size, type, headerSize };
}

function parseMvhd(box) {
  if (box.length < 8 + 4) return null;
  const version = box[8];
  if (version === 0) {
    if (box.length < 8 + 4 + 4 + 4 + 4 + 4) return null;
    const timescale = box.readUInt32BE(8 + 4 + 4 + 4);
    const duration = box.readUInt32BE(8 + 4 + 4 + 4 + 4);
    return timescale > 0 ? duration / timescale : null;
  }
  if (version === 1) {
    if (box.length < 8 + 4 + 8 + 8 + 4 + 8) return null;
    const timescale = box.readUInt32BE(8 + 4 + 8 + 8);
    const duration = Number(box.readBigUInt64BE(8 + 4 + 8 + 8 + 4));
    return timescale > 0 ? duration / timescale : null;
  }
  return null;
}

function findMvhd(moov) {
  let offset = 8;
  while (offset + 8 <= moov.length) {
    let size = moov.readUInt32BE(offset);
    const type = moov.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > moov.length) return null;
      size = Number(moov.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = moov.length - offset;
    }
    if (size < headerSize) return null;
    if (type === "mvhd") return parseMvhd(moov.subarray(offset, Math.min(offset + size, moov.length)));
    offset += size;
  }
  return null;
}

// Seconds (float) or null when the file is not a parsable MP4-family container.
async function probeMp4Duration(absPath) {
  let handle;
  try {
    handle = await fs.open(absPath, "r");
    const { size: fileSize } = await handle.stat();
    let position = 0;
    let sawFtyp = false;
    for (let count = 0; count < MAX_TOP_LEVEL_BOXES; count += 1) {
      const box = await readBoxHeader(handle, position, fileSize);
      if (!box) return null;
      if (box.type === "ftyp") sawFtyp = true;
      if (box.type === "moov") {
        if (box.size > MAX_MOOV_BYTES) return null;
        const moov = await readAt(handle, position, box.size);
        return findMvhd(moov);
      }
      if (count === 0 && !sawFtyp && !["moov", "mdat", "free", "skip", "wide", "pnot", "uuid", "moof", "styp"].includes(box.type)) {
        return null; // not an ISO base media file
      }
      position += box.size;
      if (position >= fileSize) return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Duration of a stored media file when the container can be read, otherwise null.
async function probeMediaDuration(absPath, { fileName, mimeType } = {}) {
  if (!isMp4Family(fileName || absPath, mimeType)) return null;
  return probeMp4Duration(absPath);
}

function formatSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "unknown length";
  if (value < 60) return `${value < 10 ? value.toFixed(1) : Math.round(value)} s`;
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  return `${minutes} min ${rest} s`;
}

// Error (HTTP 422) when a video reference is shorter than Content ID can work with.
function tooShortError(durationSeconds, { fileName } = {}) {
  const error = new Error(`"${fileName || "This video"}" is ${formatSeconds(durationSeconds)} long; Content ID references must be at least ${MIN_VIDEO_REFERENCE_SECONDS} seconds. The file was not stored.`);
  error.status = 422;
  error.code = "VIDEO_TOO_SHORT";
  error.duration_seconds = durationSeconds;
  error.min_seconds = MIN_VIDEO_REFERENCE_SECONDS;
  return error;
}

// Resolves when the file may be used as a video reference; throws tooShortError otherwise.
async function assertVideoReferenceLength(absPath, { fileName, mimeType } = {}) {
  const duration = await probeMediaDuration(absPath, { fileName, mimeType });
  if (duration !== null && duration < MIN_VIDEO_REFERENCE_SECONDS) throw tooShortError(duration, { fileName });
  return duration;
}

module.exports = {
  MIN_VIDEO_REFERENCE_SECONDS,
  assertVideoReferenceLength,
  formatSeconds,
  isMp4Family,
  probeMediaDuration,
  probeMp4Duration,
  tooShortError
};
