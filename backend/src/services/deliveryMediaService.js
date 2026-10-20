const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

// Audio files chosen for a CMS Delivery product are stored on the server so the backend can
// deliver the reference itself (and retry it) instead of proxying a browser upload to Google.
//
// Layout under MEDIA_DIR:
//   <productId>/<trackId>__<safeName>   audio attached to a track of a saved product
//   _drafts/<uploadId>__<safeName>      audio uploaded while the product form is still being
//                                       filled in (attached to a track when the product is saved,
//                                       expired by the draft sweep otherwise)
const MEDIA_DIR = process.env.CONTENT_ID_MEDIA_DIR || path.resolve(__dirname, "../../data/delivery-media");
const DRAFT_DIR_NAME = "_drafts";
// Audio and video references share this store; video masters are large, so the default cap is
// generous and the disk is protected by the opt-in "delete after delivery" cleanup.
const DEFAULT_MAX_AUDIO_BYTES = 16 * 1024 * 1024 * 1024;
const configuredMaxBytes = Number(process.env.CONTENT_ID_MAX_MEDIA_BYTES || process.env.CONTENT_ID_MAX_AUDIO_BYTES);
const MAX_AUDIO_BYTES = configuredMaxBytes > 0 ? configuredMaxBytes : DEFAULT_MAX_AUDIO_BYTES;
const DEFAULT_DRAFT_TTL_HOURS = 24;
const DRAFT_TTL_MS = Number(process.env.CONTENT_ID_DRAFT_AUDIO_TTL_HOURS) > 0
  ? Number(process.env.CONTENT_ID_DRAFT_AUDIO_TTL_HOURS) * 60 * 60 * 1000
  : DEFAULT_DRAFT_TTL_HOURS * 60 * 60 * 1000;
const MAX_FILE_NAME_LENGTH = 150;
// Linux file names are capped at 255 bytes; the "<trackId>__" / "<uploadId>__" prefix and the
// ".<random>.part" staging suffix must still fit next to a Vietnamese/CJK name.
const MAX_FILE_NAME_BYTES = 180;
const FALLBACK_FILE_NAME = "track";

const MIME_BY_EXTENSION = {
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  wma: "audio/x-ms-wma",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  webm: "video/webm",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  wmv: "video/x-ms-wmv"
};

function cleanText(value) {
  return String(value ?? "").trim();
}

function withStatus(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function extensionOf(fileName) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(cleanText(fileName));
  return match ? match[1].toLowerCase() : "";
}

// Strips path separators and control characters, keeps the extension and caps the length.
function sanitizeFileName(name) {
  // eslint-disable-next-line no-control-regex
  let clean = cleanText(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "").trim();
  if (!clean) return FALLBACK_FILE_NAME;

  if (clean.length > MAX_FILE_NAME_LENGTH || Buffer.byteLength(clean, "utf8") > MAX_FILE_NAME_BYTES) {
    const ext = extensionOf(clean);
    const suffix = ext ? `.${ext}` : "";
    const base = ext ? clean.slice(0, clean.length - ext.length - 1) : clean;
    const keep = Math.max(MAX_FILE_NAME_LENGTH - suffix.length, 1);
    // Trim on code points, then on UTF-8 bytes, so a long accented name never exceeds the limit.
    let chars = Array.from(base).slice(0, keep);
    const maxBaseBytes = Math.max(MAX_FILE_NAME_BYTES - Buffer.byteLength(suffix, "utf8"), 1);
    while (chars.length > 1 && Buffer.byteLength(chars.join(""), "utf8") > maxBaseBytes) chars.pop();
    clean = chars.join("").trim() + suffix;
  }
  return clean || FALLBACK_FILE_NAME;
}

function guessMime(fileName, headerMime) {
  const header = cleanText(headerMime).split(";")[0].trim().toLowerCase();
  if (/^(audio|video)\//.test(header)) return header;
  return MIME_BY_EXTENSION[extensionOf(fileName)] || "application/octet-stream";
}

function productDir(productId) {
  return path.join(MEDIA_DIR, String(productId));
}

function draftDir() {
  return path.join(MEDIA_DIR, DRAFT_DIR_NAME);
}

function trackFilePrefix(trackId) {
  return `${trackId}__`;
}

function isValidUploadId(value) {
  return /^[a-f0-9]{32}$/i.test(cleanText(value));
}

function newUploadId() {
  return crypto.randomBytes(16).toString("hex");
}

async function removePrefixedFiles(dir, prefix) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.startsWith(prefix) && !entry.endsWith(".part"))
    .map((entry) => fsp.rm(path.join(dir, entry), { force: true })));
}

function removeTrackFiles(dir, trackId) {
  return removePrefixedFiles(dir, trackFilePrefix(trackId));
}

function sizeLimitError() {
  return withStatus(`File is larger than the allowed ${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))} MB`, 413);
}

// Streams a request body into <dir>/<finalName> while counting bytes and hashing. The bytes go
// to a ".part" file first, so a failure never leaves a half-written file under the final name.
// `validateFile(partPath)` may inspect the complete upload (e.g. its duration) and throw to
// reject it before anything existing is replaced.
async function storeStream({ dir, finalName, stream, contentLength, mimeType, fileName, beforeCommit, validateFile }) {
  if (!stream || typeof stream.pipe !== "function") throw withStatus("A readable file stream is required", 400);

  const expected = Number(contentLength);
  const hasExpected = Number.isInteger(expected) && expected > 0;
  if (hasExpected && expected > MAX_AUDIO_BYTES) throw sizeLimitError();

  await fsp.mkdir(dir, { recursive: true });
  // A unique staging name per request: two uploads of the same file to the same track must
  // never write into one ".part" file.
  const partPath = path.join(dir, `${finalName}.${crypto.randomBytes(6).toString("hex")}.part`);
  const finalPath = path.join(dir, finalName);

  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_AUDIO_BYTES) {
        callback(sizeLimitError());
        return;
      }
      if (hasExpected && bytes > expected) {
        callback(withStatus("The uploaded body is larger than the declared file size", 400));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(stream, counter, fs.createWriteStream(partPath));
    if (!bytes) throw withStatus("The uploaded file is empty", 400);
    if (hasExpected && bytes !== expected) {
      throw withStatus(`The uploaded body (${bytes} bytes) does not match the declared file size (${expected} bytes)`, 400);
    }
    if (typeof validateFile === "function") await validateFile(partPath);
    if (typeof beforeCommit === "function") await beforeCommit();
    await fsp.rename(partPath, finalPath);
  } catch (error) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    file_name: fileName,
    file_size: bytes,
    file_mime: guessMime(fileName, mimeType),
    file_sha256: hash.digest("hex")
  };
}

// Stores the request body as <MEDIA_DIR>/<productId>/<trackId>__<safeName>. Any failure removes
// the partial file; a previous file of the same track is replaced only once the new one is complete.
async function storeTrackAudio({ productId, trackId, fileName, stream, contentLength, mimeType, validateFile }) {
  const product = Number(productId);
  const track = Number(trackId);
  if (!Number.isInteger(product) || product <= 0 || !Number.isInteger(track) || track <= 0) {
    throw withStatus("Product and track ids are required", 400);
  }

  const safeName = sanitizeFileName(fileName);
  const dir = productDir(product);
  const finalName = `${trackFilePrefix(track)}${safeName}`;
  const stored = await storeStream({
    dir,
    finalName,
    stream,
    contentLength,
    mimeType,
    fileName: safeName,
    validateFile,
    beforeCommit: () => removeTrackFiles(dir, track)
  });
  return { file_path: `${product}/${finalName}`, ...stored };
}

// Stores an upload made while the product form is still open (no product/track yet) as
// <MEDIA_DIR>/_drafts/<uploadId>__<safeName>.
async function storeDraftAudio({ uploadId, fileName, stream, contentLength, mimeType, validateFile }) {
  const id = cleanText(uploadId);
  if (!isValidUploadId(id)) throw withStatus("A valid upload id is required", 400);

  const safeName = sanitizeFileName(fileName);
  const finalName = `${id}__${safeName}`;
  const stored = await storeStream({ dir: draftDir(), finalName, stream, contentLength, mimeType, fileName: safeName, validateFile });
  return { file_path: `${DRAFT_DIR_NAME}/${finalName}`, ...stored };
}

function absolutePathOf(track) {
  const relative = cleanText(track?.file_path);
  if (!relative) return "";
  const absPath = path.resolve(MEDIA_DIR, relative);
  const root = path.resolve(MEDIA_DIR);
  // A stored path must stay inside the media directory.
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return "";
  return absPath;
}

function isDraftPath(filePath) {
  return cleanText(filePath).replace(/\\/g, "/").startsWith(`${DRAFT_DIR_NAME}/`);
}

// Moves a draft upload next to the track it now belongs to. The rename is atomic on the same
// volume; a cross-device media dir falls back to copy + remove.
async function attachDraftAudio(upload, productId, trackId) {
  const product = Number(productId);
  const track = Number(trackId);
  if (!Number.isInteger(product) || product <= 0 || !Number.isInteger(track) || track <= 0) {
    throw withStatus("Product and track ids are required", 400);
  }
  if (!isDraftPath(upload?.file_path)) throw withStatus("The upload is not a draft audio file", 400);
  const source = absolutePathOf(upload);
  if (!source) throw withStatus("The draft audio path is invalid", 400);

  let stat;
  try {
    stat = await fsp.stat(source);
  } catch (error) {
    if (error.code === "ENOENT") throw withStatus("The uploaded audio file is no longer on the server. Select the file again.", 410);
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0) throw withStatus("The uploaded audio file is empty. Select the file again.", 410);

  const safeName = sanitizeFileName(upload.file_name || path.basename(source).replace(/^[a-f0-9]{32}__/i, ""));
  const dir = productDir(product);
  await fsp.mkdir(dir, { recursive: true });
  const finalName = `${trackFilePrefix(track)}${safeName}`;
  const target = path.join(dir, finalName);
  await removeTrackFiles(dir, track);
  try {
    await fsp.rename(source, target);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fsp.copyFile(source, target);
    await fsp.rm(source, { force: true });
  }

  return {
    file_path: `${product}/${finalName}`,
    file_name: safeName,
    file_size: Number(upload.file_size) || stat.size,
    file_mime: cleanText(upload.file_mime) || guessMime(safeName),
    file_sha256: cleanText(upload.file_sha256) || null
  };
}

// { absPath, size, mime } for a track whose stored file exists, otherwise null.
function resolveTrackAudio(track) {
  const absPath = absolutePathOf(track);
  if (!absPath) return null;
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;
  return {
    absPath,
    size: stat.size,
    mime: cleanText(track.file_mime) || guessMime(track.file_name || absPath)
  };
}

function openTrackAudioStream(track, { start, end } = {}) {
  const audio = resolveTrackAudio(track);
  if (!audio) throw withStatus("No audio file is stored for this track", 404);
  const range = {};
  if (Number.isInteger(start) && start >= 0) range.start = start;
  if (Number.isInteger(end) && end >= 0) range.end = end;
  return fs.createReadStream(audio.absPath, range);
}

async function removeTrackAudio(track) {
  const absPath = absolutePathOf(track);
  if (!absPath) return false;
  try {
    await fsp.rm(absPath, { force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Draft uploads share the same path guard; the file may already be gone (attached or swept).
async function removeDraftAudio(upload) {
  if (!isDraftPath(upload?.file_path)) return false;
  return removeTrackAudio(upload);
}

async function removeProductMedia(productId) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) return;
  await fsp.rm(productDir(id), { recursive: true, force: true });
}

// Every file in the draft folder with its upload id and last modification time, for the sweep.
async function listDraftFiles() {
  let entries;
  try {
    entries = await fsp.readdir(draftDir(), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absPath = path.join(draftDir(), entry.name);
    let stat;
    try {
      stat = await fsp.stat(absPath);
    } catch {
      continue;
    }
    const match = /^([a-f0-9]{32})__/i.exec(entry.name);
    files.push({
      name: entry.name,
      upload_id: match ? match[1].toLowerCase() : "",
      partial: entry.name.endsWith(".part"),
      size: stat.size,
      modified_at: stat.mtimeMs,
      file_path: `${DRAFT_DIR_NAME}/${entry.name}`
    });
  }
  return files;
}

module.exports = {
  DRAFT_DIR_NAME,
  DRAFT_TTL_MS,
  MEDIA_DIR,
  MAX_AUDIO_BYTES,
  attachDraftAudio,
  guessMime,
  isDraftPath,
  isValidUploadId,
  listDraftFiles,
  newUploadId,
  openTrackAudioStream,
  removeDraftAudio,
  removeProductMedia,
  removeTrackAudio,
  resolveTrackAudio,
  sanitizeFileName,
  storeDraftAudio,
  storeTrackAudio
};
