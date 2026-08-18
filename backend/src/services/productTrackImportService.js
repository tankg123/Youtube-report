const DEFAULT_MEDIA_HOSTS = ["amazonaws.com", "cloudfront.net"];

const SOUND_RECORDING_HEADERS = [
  "filename", "isrc", "add_asset_labels", "song_title", "artist", "album", "upc", "genre",
  "label", "original_release_date", "ownership", "match_policy", "custom_id"
];

const ART_TRACK_HEADERS = [
  "ddex_party_id", "album_artist", "album_title", "album_upc", "album_release_date", "album_label",
  "album_art_filename", "track_number", "track_title", "track_filename", "track_custom_id",
  "track_artist", "track_genres", "track_isrc", "track_pline", "track_territory_start_dates",
  "track_explicit_lyrics", "track_add_at_asset_labels", "track_add_sr_asset_labels"
];

const REQUIRED_COLUMNS = ["Title", "IsrcCode", "ProductTitle"];

function parseCsvText(text) {
  const clean = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];

    if (inQuotes) {
      if (char !== '"') {
        field += char;
      } else if (clean[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((line) => line.some((value) => String(value).trim() !== ""));
}

function toRecords(text) {
  const rows = parseCsvText(text);
  if (rows.length < 2) {
    throw new Error("The CSV file is empty or has no data rows.");
  }

  const headers = rows[0].map((header) => String(header).trim());
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length) {
    throw new Error(`This is not a ProductTrack report. Missing column(s): ${missing.join(", ")}`);
  }

  return rows.slice(1).map((line) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = String(line[index] ?? "").trim();
    });
    return record;
  });
}

function removeVietnameseTones(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function sanitizeFileName(value, fallback = "untitled") {
  const clean = String(value || "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

function uniqueName(used, name) {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }

  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";

  let counter = 2;
  let candidate = `${base} (${counter})${extension}`;
  while (used.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${base} (${counter})${extension}`;
  }

  used.add(candidate.toLowerCase());
  return candidate;
}

function decodeUrlBaseName(url) {
  try {
    const parsed = new URL(url);
    const disposition = parsed.searchParams.get("response-content-disposition") || "";
    const match = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (match) return decodeURIComponent(match[1].trim());
    const segments = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] || "");
  } catch {
    return "";
  }
}

function extensionOf(url, fallback) {
  const base = decodeUrlBaseName(url);
  const match = base.match(/\.([A-Za-z0-9]{2,5})$/);
  return match ? `.${match[1].toLowerCase()}` : fallback;
}

function toDateOnly(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : text;
}

function joinNonEmpty(values, separator = ", ") {
  return values.map((value) => String(value || "").trim()).filter(Boolean).join(separator);
}

function customIdFor(label, isrc) {
  const cleanLabel = removeVietnameseTones(label).replace(/[^a-zA-Z0-9]/g, "");
  return `${cleanLabel}_${isrc}`;
}

function allowedMediaHosts() {
  const configured = String(process.env.CONTENT_ID_MEDIA_HOSTS || "").trim();
  if (!configured) return DEFAULT_MEDIA_HOSTS;
  return configured.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
}

function isAllowedMediaUrl(url) {
  if (!url) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return allowedMediaHosts().some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function buildAlbums(records) {
  const groups = new Map();

  records.forEach((record, recordIndex) => {
    const upc = String(record.UpcCode || "").trim();
    const productTitle = String(record.ProductTitle || "").trim() || "Untitled album";
    const key = upc ? `upc:${upc}` : `title:${productTitle.toLowerCase()}:${recordIndex}`;

    if (!groups.has(key)) {
      groups.set(key, { key, upc, productTitle, records: [] });
    }
    groups.get(key).records.push(record);
  });

  return Array.from(groups.values()).map((group) => {
    const sorted = group.records.slice().sort((left, right) => {
      const leftOrder = Number(left.Order || 0);
      const rightOrder = Number(right.Order || 0);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.Title || "").localeCompare(String(right.Title || ""));
    });

    const first = sorted[0];
    const warnings = [];
    const usedNames = new Set();

    const artworkUrl = sorted.map((record) => record.ImageUrl).find(Boolean) || "";
    const artworkFilename = artworkUrl
      ? uniqueName(usedNames, `${sanitizeFileName(group.productTitle, "artwork")}${extensionOf(artworkUrl, ".jpg")}`)
      : "";

    if (!group.upc) warnings.push("This album has no UPC in the report.");
    if (!artworkUrl) warnings.push("No artwork URL found for this album.");
    if (new Set(sorted.map((record) => record.ImageUrl).filter(Boolean)).size > 1) {
      warnings.push("Tracks reference different artwork files. The first artwork is used for the whole album.");
    }

    const tracks = sorted.map((record, index) => {
      const title = String(record.Title || "").trim()
        || String(record.ProductTitle || "").trim()
        || `Track ${index + 1}`;
      const titleVersion = String(record.TitleVersion || "").trim();
      const songTitle = titleVersion ? `${title} (${titleVersion})` : title;
      const mediaUrl = String(record.TrackMediaUrl || "").trim();
      const filename = mediaUrl
        ? uniqueName(usedNames, `${sanitizeFileName(songTitle, `track-${index + 1}`)}${extensionOf(mediaUrl, ".wav")}`)
        : "";

      if (!mediaUrl) warnings.push(`"${songTitle}" has no audio URL in the report.`);
      if (!String(record.IsrcCode || "").trim()) warnings.push(`"${songTitle}" has no ISRC in the report.`);

      return {
        source_id: String(record.Id || "").trim(),
        track_number: Number(record.Order || 0) || index + 1,
        song_title: songTitle,
        isrc: String(record.IsrcCode || "").trim(),
        artist: joinNonEmpty([record.MainArtist, record.FeaturedArtist]),
        main_artist: String(record.MainArtist || "").trim(),
        featured_artist: String(record.FeaturedArtist || "").trim(),
        genre: joinNonEmpty([record.PrimaryGenre, record.SecondaryGenre]),
        pline: joinNonEmpty([record.PLineYear, record.PLineText], " "),
        cline: joinNonEmpty([record.CLineYear, record.CLineText], " "),
        composer: String(record.Composer || "").trim(),
        lyricist: String(record.Lyricist || "").trim(),
        language: String(record.MetadataAudioLanguageCode || "").trim(),
        explicit: /^explicit$/i.test(String(record.MetadataParentalAdvisory || "").trim()) ? "yes" : "no",
        youtube_video_id: String(record.YoutubeVideoId || "").trim(),
        media_url: mediaUrl,
        filename
      };
    });

    return {
      key: group.key,
      folder_name: sanitizeFileName(group.upc ? `${group.productTitle} (${group.upc})` : group.productTitle, "album"),
      album_title: group.productTitle,
      album_upc: group.upc,
      album_artist: String(first.MainArtist || "").trim(),
      label: String(first.Label || "").trim(),
      genre: joinNonEmpty([first.PrimaryGenre, first.SecondaryGenre]),
      release_date: toDateOnly(first.ProductReleaseDate),
      created_date: toDateOnly(first.ProductCreatedDate),
      delivery_providers: String(first.DeliveryProviders || "").trim(),
      right_holder: String(first.RightHolder || "").trim(),
      artwork_url: artworkUrl,
      artwork_filename: artworkFilename,
      track_count: tracks.length,
      warnings: Array.from(new Set(warnings)),
      tracks
    };
  });
}

function normalizeOptions(options = {}) {
  return {
    match_policy: String(options.match_policy || "Monetize in all countries").trim(),
    ownership: String(options.ownership || "WW").trim() || "WW",
    ddex_party_id: String(options.ddex_party_id || "").trim(),
    include_audio: options.include_audio !== false,
    include_artwork: options.include_artwork !== false
  };
}

function buildSoundRecordingRows(album, options) {
  const settings = normalizeOptions(options);
  const releaseDate = toDateOnly(album.release_date);

  return [SOUND_RECORDING_HEADERS].concat(album.tracks.map((track) => [
    track.filename,
    track.isrc,
    album.label,
    track.song_title,
    track.artist,
    album.album_title,
    album.album_upc,
    track.genre || album.genre,
    album.label,
    releaseDate,
    settings.ownership,
    settings.match_policy,
    customIdFor(album.label, track.isrc)
  ]));
}

function buildArtTrackRows(album, options) {
  const settings = normalizeOptions(options);
  const releaseDate = toDateOnly(album.release_date);

  return [ART_TRACK_HEADERS].concat(album.tracks.map((track, index) => [
    settings.ddex_party_id,
    album.album_artist,
    album.album_title,
    album.album_upc,
    releaseDate,
    album.label,
    album.artwork_filename,
    track.track_number || index + 1,
    track.song_title,
    track.filename,
    customIdFor(album.label, track.isrc),
    track.artist,
    track.genre || album.genre,
    track.isrc,
    track.pline,
    `${settings.ownership}:${releaseDate}`,
    track.explicit,
    album.label,
    album.label
  ]));
}

function rowsToCsv(rows) {
  return rows
    .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

module.exports = {
  ART_TRACK_HEADERS,
  SOUND_RECORDING_HEADERS,
  buildAlbums,
  buildArtTrackRows,
  buildSoundRecordingRows,
  customIdFor,
  isAllowedMediaUrl,
  normalizeOptions,
  parseCsvText,
  removeVietnameseTones,
  rowsToCsv,
  sanitizeFileName,
  toRecords
};
