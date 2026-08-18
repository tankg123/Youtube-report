const fs = require("fs");
const os = require("os");
const path = require("path");
const stream = require("stream");
const util = require("util");
const archiver = require("archiver");
const axios = require("axios");

const {
  buildAlbums,
  buildArtTrackRows,
  buildSoundRecordingRows,
  isAllowedMediaUrl,
  normalizeOptions,
  removeVietnameseTones,
  rowsToCsv,
  sanitizeFileName,
  toRecords
} = require("../services/productTrackImportService");

const pipeline = util.promisify(stream.pipeline);

const MAX_FILE_BYTES = Number(process.env.CONTENT_ID_MAX_MEDIA_BYTES || 500 * 1024 * 1024);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.CONTENT_ID_MEDIA_TIMEOUT_MS || 180000);
const MAX_ALBUMS_PER_PACKAGE = Number(process.env.CONTENT_ID_MAX_ALBUMS_PER_PACKAGE || 25);

function csvFileBaseName(album) {
  const clean = removeVietnameseTones(album.album_title).replace(/[^a-zA-Z0-9]/g, "");
  return clean || "Album";
}

function albumsFromBody(body) {
  const csv = String(body.csv || "");
  if (!csv.trim()) {
    throw new Error("Please upload the ProductTrack report CSV first.");
  }
  return buildAlbums(toRecords(csv));
}

function analyzeProductTrackCsv(req, res) {
  try {
    const albums = albumsFromBody(req.body || {});
    const trackCount = albums.reduce((total, album) => total + album.track_count, 0);
    const downloadableTracks = albums.reduce(
      (total, album) => total + album.tracks.filter((track) => track.media_url).length,
      0
    );

    res.json({
      success: true,
      summary: {
        album_count: albums.length,
        track_count: trackCount,
        downloadable_tracks: downloadableTracks,
        albums_with_warnings: albums.filter((album) => album.warnings.length).length,
        labels: Array.from(new Set(albums.map((album) => album.label).filter(Boolean)))
      },
      albums
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
}

async function downloadToFile(url, destination) {
  if (!isAllowedMediaUrl(url)) {
    throw new Error(`Media URL is not from an allowed host: ${String(url).slice(0, 80)}`);
  }

  const response = await axios.get(url, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 3,
    validateStatus: (status) => status >= 200 && status < 300
  });

  const declaredSize = Number(response.headers["content-length"] || 0);
  if (declaredSize && declaredSize > MAX_FILE_BYTES) {
    response.data.destroy();
    throw new Error(`File is larger than the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit.`);
  }

  let received = 0;
  response.data.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_FILE_BYTES) {
      response.data.destroy(new Error(`File is larger than the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit.`));
    }
  });

  await pipeline(response.data, fs.createWriteStream(destination));
  return received;
}

function mediaErrorMessage(error, label) {
  const status = error.response?.status;
  if (status === 403) return `${label}: the download link has expired. Export a new report and import it again.`;
  if (status === 404) return `${label}: the file no longer exists on the media server.`;
  if (status) return `${label}: media server responded with HTTP ${status}.`;
  return `${label}: ${error.message}`;
}

async function prepareAlbumFiles(album, options, workingDir) {
  const albumDir = path.join(workingDir, album.folder_name);
  await fs.promises.mkdir(albumDir, { recursive: true });

  const entries = [];
  const skipped = [];

  if (options.include_artwork && album.artwork_url && album.artwork_filename) {
    const target = path.join(albumDir, album.artwork_filename);
    try {
      await downloadToFile(album.artwork_url, target);
      entries.push({ source: target, name: `${album.folder_name}/${album.artwork_filename}` });
    } catch (error) {
      skipped.push(mediaErrorMessage(error, `Artwork "${album.artwork_filename}"`));
    }
  }

  if (options.include_audio) {
    for (const track of album.tracks) {
      if (!track.media_url || !track.filename) {
        skipped.push(`"${track.song_title}": no audio link in the report.`);
        continue;
      }

      const target = path.join(albumDir, track.filename);
      try {
        await downloadToFile(track.media_url, target);
        entries.push({ source: target, name: `${album.folder_name}/${track.filename}` });
      } catch (error) {
        skipped.push(mediaErrorMessage(error, `"${track.song_title}"`));
      }
    }
  }

  const baseName = csvFileBaseName(album);
  const soundRecordingsPath = path.join(albumDir, `${baseName}-SoundRecordings.csv`);
  const artTrackPath = path.join(albumDir, `${baseName}-ArtTrack.csv`);

  await fs.promises.writeFile(soundRecordingsPath, rowsToCsv(buildSoundRecordingRows(album, options)), "utf8");
  await fs.promises.writeFile(artTrackPath, rowsToCsv(buildArtTrackRows(album, options)), "utf8");

  entries.push({ source: soundRecordingsPath, name: `${album.folder_name}/${baseName}-SoundRecordings.csv` });
  entries.push({ source: artTrackPath, name: `${album.folder_name}/${baseName}-ArtTrack.csv` });

  if (skipped.length) {
    const notesPath = path.join(albumDir, "README-missing-files.txt");
    const notes = [
      `Album: ${album.album_title}${album.album_upc ? ` (${album.album_upc})` : ""}`,
      "",
      "These files could not be added to the package:",
      ...skipped.map((line) => `- ${line}`)
    ].join("\r\n");
    await fs.promises.writeFile(notesPath, notes, "utf8");
    entries.push({ source: notesPath, name: `${album.folder_name}/README-missing-files.txt` });
  }

  return { entries, skipped };
}

function setZipHeaders(res, fileName) {
  const safeName = sanitizeFileName(removeVietnameseTones(fileName), "content-id-package.zip").replace(/[^\x20-\x7e]/g, "_");
  const encodedName = encodeURIComponent(fileName);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
}

async function packageAlbums(req, res) {
  const body = req.body || {};
  const requestedKeys = Array.isArray(body.keys) ? body.keys.map(String) : [];
  const options = normalizeOptions(body.options);

  let selected;
  let workingDir;

  try {
    const albums = albumsFromBody(body);
    selected = requestedKeys.length
      ? albums.filter((album) => requestedKeys.includes(album.key))
      : albums;

    if (!selected.length) {
      return res.status(400).json({ success: false, message: "No matching album was found in the uploaded report." });
    }
    if (selected.length > MAX_ALBUMS_PER_PACKAGE) {
      return res.status(400).json({
        success: false,
        message: `Please select at most ${MAX_ALBUMS_PER_PACKAGE} albums per download.`
      });
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }

  try {
    workingDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "content-id-package-"));

    const entries = [];
    const skipped = [];
    for (const album of selected) {
      const prepared = await prepareAlbumFiles(album, options, workingDir);
      entries.push(...prepared.entries);
      skipped.push(...prepared.skipped);
    }

    const zipName = selected.length === 1
      ? `${selected[0].folder_name}.zip`
      : `ContentID-Packages-${selected.length}-albums.zip`;

    setZipHeaders(res, zipName);
    if (skipped.length) {
      res.setHeader("X-Package-Skipped", String(skipped.length));
    }

    const archive = archiver("zip", { zlib: { level: 1 } });
    const finished = new Promise((resolve, reject) => {
      archive.on("error", reject);
      archive.on("warning", (warning) => {
        if (warning.code !== "ENOENT") reject(warning);
      });
      res.on("close", () => {
        if (!res.writableFinished) archive.abort();
        resolve();
      });
      archive.on("end", resolve);
    });

    archive.pipe(res);
    entries.forEach((entry) => archive.file(entry.source, { name: entry.name }));
    await archive.finalize();
    await finished;
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
    } else {
      res.status(502).json({ success: false, message: error.message || "Could not build the album package." });
    }
  } finally {
    if (workingDir) {
      await fs.promises.rm(workingDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  analyzeProductTrackCsv,
  packageAlbums
};
