const db = require("../config/database");

const { syncAssetLabelsFromCms } = require("../services/assetLabelSyncService");
const {
  deleteWhitelistFromCms,
  insertWhitelistToCms,
  listWhitelistsFromCms
} = require("../services/cmsWhitelistService");
const {
  getChannelFromYoutube,
  getChannelsFromYoutube
} = require("../services/youtubeService");
const { parseRoles } = require("../middlewares/authMiddleware");

const CODE_TYPES = new Set(["ISRC", "UPC"]);

function normalizeCode(value, type) {
  const code = String(value || "").trim().replace(/\s+/g, "").toUpperCase();
  if (!code) return "";

  if (type === "ISRC") {
    return code.replace(/[^A-Z0-9]/g, "");
  }

  return code.replace(/[^0-9A-Z]/g, "");
}

function isValidCode(code, type) {
  if (type === "ISRC") return /^[A-Z0-9]{12}$/.test(code);
  if (type === "UPC") return /^[0-9A-Z]{8,14}$/.test(code);
  return false;
}

function parseCodes(codes, type) {
  const rawList = Array.isArray(codes)
    ? codes
    : String(codes || "").split(/[\r\n,;\t ]+/);

  const seen = new Set();
  const valid = [];
  const invalid = [];

  rawList.forEach((value) => {
    const code = normalizeCode(value, type);
    if (!code) return;
    if (!isValidCode(code, type)) {
      invalid.push(code);
      return;
    }
    if (!seen.has(code)) {
      seen.add(code);
      valid.push(code);
    }
  });

  return { valid, invalid };
}

function moneySafeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function actorHasRole(user, role) {
  const target = String(role || "").toLowerCase();
  return parseRoles(user?.roles?.length ? user.roles : user?.role).some((item) => String(item).toLowerCase() === target);
}

function isLimitedClaimManager(user) {
  return actorHasRole(user, "Claim Manager") && !actorHasRole(user, "admin") && !actorHasRole(user, "Content ID");
}

function canManageLabel(user, labelId) {
  if (!isLimitedClaimManager(user)) return true;
  const row = db.prepare("SELECT 1 FROM user_content_id_labels WHERE user_id = ? AND label_id = ?").get(user.id, labelId);
  return Boolean(row);
}

function splitArtists(value) {
  return String(value || "")
    .split(/[;,|]/)
    .map((artist) => normalizeName(artist))
    .filter(Boolean);
}

function getOrCreateLabel(name) {
  const cleanName = normalizeName(name);
  if (!cleanName) return null;

  const existing = db.prepare("SELECT * FROM content_id_labels WHERE lower(name) = lower(?)").get(cleanName);
  if (existing) return existing;

  const result = db.prepare("INSERT INTO content_id_labels (name, display_name) VALUES (?, ?)").run(cleanName, cleanName);
  return db.prepare("SELECT * FROM content_id_labels WHERE id = ?").get(result.lastInsertRowid);
}

function getOrCreateArtist(name) {
  const cleanName = normalizeName(name);
  if (!cleanName) return null;

  const existing = db.prepare("SELECT * FROM content_id_artists WHERE lower(name) = lower(?)").get(cleanName);
  if (existing) return existing;

  const result = db.prepare("INSERT INTO content_id_artists (name, display_name) VALUES (?, ?)").run(cleanName, cleanName);
  return db.prepare("SELECT * FROM content_id_artists WHERE id = ?").get(result.lastInsertRowid);
}

function getCodeSummary(req, res) {
  const rows = db.prepare(`
    SELECT type, status, COUNT(*) AS count
    FROM content_id_codes
    GROUP BY type, status
  `).all();

  const summary = {
    ISRC: { unused: 0, used: 0, reserved: 0, total: 0 },
    UPC: { unused: 0, used: 0, reserved: 0, total: 0 }
  };

  rows.forEach((row) => {
    if (!summary[row.type]) return;
    summary[row.type][row.status] = row.count;
    summary[row.type].total += row.count;
  });

  res.json({ success: true, summary });
}

function listCodes(req, res) {
  const type = String(req.query.type || "").toUpperCase();
  const status = String(req.query.status || "");
  const search = String(req.query.search || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);

  const clauses = [];
  const params = [];

  if (CODE_TYPES.has(type)) {
    clauses.push("type = ?");
    params.push(type);
  }

  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }

  if (search) {
    clauses.push("(code LIKE ? OR album_title LIKE ? OR song_title LIKE ? OR artist LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const codes = db.prepare(`
    SELECT *
    FROM content_id_codes
    ${where}
    ORDER BY
      CASE status WHEN 'unused' THEN 0 WHEN 'reserved' THEN 1 ELSE 2 END,
      id DESC
    LIMIT ?
  `).all(...params, limit);

  res.json({ success: true, codes });
}

function addCodes(req, res) {
  const type = String(req.body.type || "").toUpperCase();
  if (!CODE_TYPES.has(type)) {
    return res.status(400).json({ success: false, message: "Invalid code type" });
  }

  const { valid, invalid } = parseCodes(req.body.codes, type);
  const notes = String(req.body.notes || "").trim();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO content_id_codes (type, code, notes)
    VALUES (?, ?, ?)
  `);

  let added = 0;
  const transaction = db.transaction(() => {
    valid.forEach((code) => {
      const result = insert.run(type, code, notes || null);
      added += result.changes;
    });
  });

  transaction();

  res.json({
    success: true,
    added,
    duplicates: valid.length - added,
    invalid,
    totalParsed: valid.length + invalid.length
  });
}

function updateCode(req, res) {
  const id = Number(req.params.id);
  const status = String(req.body.status || "").trim();
  const notes = String(req.body.notes || "").trim();

  const code = db.prepare("SELECT * FROM content_id_codes WHERE id = ?").get(id);
  if (!code) {
    return res.status(404).json({ success: false, message: "Code not found" });
  }

  const nextStatus = status || code.status;
  if (!["unused", "used", "reserved"].includes(nextStatus)) {
    return res.status(400).json({ success: false, message: "Invalid status" });
  }

  db.prepare(`
    UPDATE content_id_codes
    SET status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextStatus, notes || null, id);

  res.json({ success: true, code: db.prepare("SELECT * FROM content_id_codes WHERE id = ?").get(id) });
}

function deleteCode(req, res) {
  const id = Number(req.params.id);
  const code = db.prepare("SELECT * FROM content_id_codes WHERE id = ?").get(id);

  if (!code) {
    return res.status(404).json({ success: false, message: "Code not found" });
  }

  if (code.status === "used") {
    return res.status(400).json({ success: false, message: "Used codes cannot be deleted" });
  }

  db.prepare("DELETE FROM content_id_codes WHERE id = ?").run(id);
  res.json({ success: true });
}

function getAvailableCodes(req, res) {
  const type = String(req.query.type || "").toUpperCase();
  const count = Math.min(Math.max(Number(req.query.count) || 1, 1), 500);

  if (!CODE_TYPES.has(type)) {
    return res.status(400).json({ success: false, message: "Invalid code type" });
  }

  const codes = db.prepare(`
    SELECT code
    FROM content_id_codes
    WHERE type = ? AND status = 'unused'
    ORDER BY id ASC
    LIMIT ?
  `).all(type, count).map((row) => row.code);

  res.json({ success: true, codes, requested: count, available: codes.length });
}

function ensureCodeCanBeUsed(code, type) {
  const existing = db.prepare("SELECT * FROM content_id_codes WHERE code = ?").get(code);
  if (existing && existing.type !== type) {
    throw new Error(`${code} already exists as ${existing.type}`);
  }
  if (existing && existing.status === "used") {
    throw new Error(`${type} ${code} is already used`);
  }
}

function saveProduct(req, res) {
  const product = req.body.product || {};
  const tracks = Array.isArray(req.body.tracks) ? req.body.tracks : [];

  const albumTitle = String(product.album_title || "").trim();
  const albumArtist = String(product.album_artist || "").trim();
  const albumUpc = normalizeCode(product.album_upc, "UPC");
  const releaseDate = String(product.release_date || "").trim();
  const label = String(product.label || "").trim();

  if (!albumTitle) {
    return res.status(400).json({ success: false, message: "Album title is required" });
  }
  if (!albumUpc || !isValidCode(albumUpc, "UPC")) {
    return res.status(400).json({ success: false, message: "Valid UPC is required" });
  }
  if (!tracks.length) {
    return res.status(400).json({ success: false, message: "At least one track is required" });
  }

  try {
    ensureCodeCanBeUsed(albumUpc, "UPC");
    const isrcsInPayload = new Set();
    tracks.forEach((track) => {
      const isrc = normalizeCode(track.isrc, "ISRC");
      if (!isValidCode(isrc, "ISRC")) {
        throw new Error(`Invalid ISRC: ${track.isrc || "-"}`);
      }
      if (isrcsInPayload.has(isrc)) {
        throw new Error(`Duplicated ISRC in this product: ${isrc}`);
      }
      isrcsInPayload.add(isrc);
      ensureCodeCanBeUsed(isrc, "ISRC");
    });

    const save = db.transaction(() => {
      const labelRow = getOrCreateLabel(label);
      const productResult = db.prepare(`
        INSERT INTO content_id_products (
          label_id, album_title, album_artist, album_upc, genre, label, release_date,
          ownership, match_policy, ddex_party_id, album_art_filename, track_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        labelRow?.id || null,
        albumTitle,
        albumArtist || null,
        albumUpc,
        String(product.genre || "").trim() || null,
        label || null,
        releaseDate || null,
        String(product.ownership || "").trim() || null,
        String(product.match_policy || "").trim() || null,
        String(product.ddex_party_id || "").trim() || null,
        String(product.album_art_filename || "").trim() || null,
        tracks.length
      );

      const productId = productResult.lastInsertRowid;
      const insertTrack = db.prepare(`
        INSERT INTO content_id_tracks (
          product_id, track_number, filename, isrc, song_title, artist, custom_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertUsedCode = db.prepare(`
        INSERT INTO content_id_codes (
          type, code, status, album_title, song_title, artist, product_id, track_id, used_at
        )
        VALUES (?, ?, 'used', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      const markUsed = db.prepare(`
        UPDATE content_id_codes
        SET status = 'used',
            album_title = ?,
            song_title = ?,
            artist = ?,
            product_id = ?,
            track_id = ?,
            used_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE type = ? AND code = ?
      `);
      const insertTrackArtist = db.prepare(`
        INSERT OR IGNORE INTO content_id_track_artists (track_id, artist_id)
        VALUES (?, ?)
      `);

      tracks.forEach((track, index) => {
        const isrc = normalizeCode(track.isrc, "ISRC");
        const songTitle = String(track.song_title || "").trim();
        const artist = splitArtists(track.artist).join(", ");
        const trackResult = insertTrack.run(
          productId,
          Number(track.track_number) || index + 1,
          String(track.filename || "").trim(),
          isrc,
          songTitle,
          artist || null,
          String(track.custom_id || "").trim() || null
        );

        const updated = markUsed.run(albumTitle, songTitle, artist || null, productId, trackResult.lastInsertRowid, "ISRC", isrc);
        if (!updated.changes) {
          insertUsedCode.run("ISRC", isrc, albumTitle, songTitle, artist || null, productId, trackResult.lastInsertRowid);
        }

        splitArtists(track.artist).forEach((artistName) => {
          const artistRow = getOrCreateArtist(artistName);
          if (artistRow) insertTrackArtist.run(trackResult.lastInsertRowid, artistRow.id);
        });
      });

      const upcUpdated = markUsed.run(albumTitle, null, albumArtist || null, productId, null, "UPC", albumUpc);
      if (!upcUpdated.changes) {
        insertUsedCode.run("UPC", albumUpc, albumTitle, null, albumArtist || null, productId, null);
      }

      return productId;
    });

    const productId = save();
    res.json({ success: true, product: getProductDetailById(productId) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
}

function getProductDetailById(id) {
  const product = db.prepare("SELECT * FROM content_id_products WHERE id = ?").get(id);
  if (!product) return null;
  product.tracks = db.prepare(`
    SELECT *
    FROM content_id_tracks
    WHERE product_id = ?
    ORDER BY track_number ASC, id ASC
  `).all(id);
  return product;
}

function listLabels(req, res) {
  const search = String(req.query.search || "").trim();
  const params = [];
  const clauses = [];

  if (search) {
    clauses.push("(l.name LIKE ? OR l.display_name LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  if (isLimitedClaimManager(req.user)) {
    clauses.push("l.id IN (SELECT label_id FROM user_content_id_labels WHERE user_id = ?)");
    params.push(req.user.id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const labels = db.prepare(`
    SELECT
      l.*,
      COUNT(DISTINCT p.id) AS album_count,
      COUNT(DISTINCT t.id) AS song_count
    FROM content_id_labels l
    LEFT JOIN content_id_products p ON p.label_id = l.id OR lower(p.label) = lower(l.name)
    LEFT JOIN content_id_tracks t ON t.product_id = p.id
    ${where}
    GROUP BY l.id
    ORDER BY l.name COLLATE NOCASE ASC
  `).all(...params);

  res.json({ success: true, labels });
}

function createLabel(req, res) {
  const name = normalizeName(req.body.name);
  const displayName = normalizeName(req.body.display_name) || name;
  const notes = String(req.body.notes || "").trim();

  if (!name) return res.status(400).json({ success: false, message: "Label name is required" });

  try {
    const result = db.prepare(`
      INSERT INTO content_id_labels (name, display_name, notes)
      VALUES (?, ?, ?)
    `).run(name, displayName, notes || null);

    if (isLimitedClaimManager(req.user)) {
      db.prepare("INSERT OR IGNORE INTO user_content_id_labels (user_id, label_id) VALUES (?, ?)").run(req.user.id, result.lastInsertRowid);
    }

    res.json({ success: true, label: db.prepare("SELECT * FROM content_id_labels WHERE id = ?").get(result.lastInsertRowid) });
  } catch {
    const existing = db.prepare("SELECT * FROM content_id_labels WHERE lower(name) = lower(?)").get(name);
    if (existing && isLimitedClaimManager(req.user)) {
      db.prepare("INSERT OR IGNORE INTO user_content_id_labels (user_id, label_id) VALUES (?, ?)").run(req.user.id, existing.id);
      return res.json({ success: true, label: existing, message: "Label assigned to your account" });
    }
    res.status(400).json({ success: false, message: "Label already exists" });
  }
}

function updateLabel(req, res) {
  const id = Number(req.params.id);
  const name = normalizeName(req.body.name);
  const displayName = normalizeName(req.body.display_name) || name;
  const notes = String(req.body.notes || "").trim();

  if (!name) return res.status(400).json({ success: false, message: "Label name is required" });

  const current = db.prepare("SELECT * FROM content_id_labels WHERE id = ?").get(id);
  if (!current) return res.status(404).json({ success: false, message: "Label not found" });
  if (!canManageLabel(req.user, id)) return res.status(403).json({ success: false, message: "You can only update labels assigned to your account" });

  try {
    db.prepare(`
      UPDATE content_id_labels
      SET name = ?, display_name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, displayName, notes || null, id);
    res.json({ success: true, label: db.prepare("SELECT * FROM content_id_labels WHERE id = ?").get(id) });
  } catch {
    res.status(400).json({ success: false, message: "Label already exists" });
  }
}

function deleteLabel(req, res) {
  const id = Number(req.params.id);
  const label = db.prepare("SELECT * FROM content_id_labels WHERE id = ?").get(id);
  if (!label) return res.status(404).json({ success: false, message: "Label not found" });
  if (!canManageLabel(req.user, id)) return res.status(403).json({ success: false, message: "You can only delete labels assigned to your account" });
  const used = db.prepare(`
    SELECT COUNT(*) AS count
    FROM content_id_products
    WHERE label_id = ? OR lower(label) = lower(?)
  `).get(id, label.name);

  if (used.count > 0) {
    return res.status(400).json({ success: false, message: "Label is used by products" });
  }

  db.prepare("DELETE FROM content_id_labels WHERE id = ?").run(id);
  res.json({ success: true });
}

async function syncLabelsFromCms(req, res) {
  try {
    const result = await syncAssetLabelsFromCms();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.response?.status || 400).json({
      success: false,
      message: error.response?.data?.error?.message || error.message
    });
  }
}

function listArtists(req, res) {
  const search = String(req.query.search || "").trim();
  const params = search ? [`%${search}%`, `%${search}%`] : [];
  const where = search ? "WHERE a.name LIKE ? OR a.display_name LIKE ?" : "";

  const artists = db.prepare(`
    SELECT
      a.*,
      COUNT(DISTINCT ta.track_id) AS song_count,
      COUNT(DISTINCT t.product_id) AS album_count
    FROM content_id_artists a
    LEFT JOIN content_id_track_artists ta ON ta.artist_id = a.id
    LEFT JOIN content_id_tracks t ON t.id = ta.track_id
    ${where}
    GROUP BY a.id
    ORDER BY a.name COLLATE NOCASE ASC
  `).all(...params);

  res.json({ success: true, artists });
}

function createArtist(req, res) {
  const name = normalizeName(req.body.name);
  const displayName = normalizeName(req.body.display_name) || name;
  const notes = String(req.body.notes || "").trim();

  if (!name) return res.status(400).json({ success: false, message: "Artist name is required" });

  try {
    const result = db.prepare(`
      INSERT INTO content_id_artists (name, display_name, notes)
      VALUES (?, ?, ?)
    `).run(name, displayName, notes || null);
    res.json({ success: true, artist: db.prepare("SELECT * FROM content_id_artists WHERE id = ?").get(result.lastInsertRowid) });
  } catch {
    res.status(400).json({ success: false, message: "Artist already exists" });
  }
}

function updateArtist(req, res) {
  const id = Number(req.params.id);
  const name = normalizeName(req.body.name);
  const displayName = normalizeName(req.body.display_name) || name;
  const notes = String(req.body.notes || "").trim();

  if (!name) return res.status(400).json({ success: false, message: "Artist name is required" });

  const current = db.prepare("SELECT * FROM content_id_artists WHERE id = ?").get(id);
  if (!current) return res.status(404).json({ success: false, message: "Artist not found" });

  try {
    db.prepare(`
      UPDATE content_id_artists
      SET name = ?, display_name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, displayName, notes || null, id);
    res.json({ success: true, artist: db.prepare("SELECT * FROM content_id_artists WHERE id = ?").get(id) });
  } catch {
    res.status(400).json({ success: false, message: "Artist already exists" });
  }
}

function deleteArtist(req, res) {
  const id = Number(req.params.id);
  const used = db.prepare("SELECT COUNT(*) AS count FROM content_id_track_artists WHERE artist_id = ?").get(id);

  if (used.count > 0) {
    return res.status(400).json({ success: false, message: "Artist is used by tracks" });
  }

  db.prepare("DELETE FROM content_id_artists WHERE id = ?").run(id);
  res.json({ success: true });
}

function listProducts(req, res) {
  const search = String(req.query.search || "").trim();
  const clauses = [];
  const params = [];

  if (search) {
    clauses.push("(album_title LIKE ? OR album_artist LIKE ? OR album_upc LIKE ? OR label LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const products = db.prepare(`
    SELECT *
    FROM content_id_products
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT 300
  `).all(...params);

  res.json({ success: true, products });
}

function getProduct(req, res) {
  const product = getProductDetailById(Number(req.params.id));
  if (!product) {
    return res.status(404).json({ success: false, message: "Product not found" });
  }
  res.json({ success: true, product });
}

function deleteProduct(req, res) {
  const id = Number(req.params.id);
  const product = db.prepare("SELECT * FROM content_id_products WHERE id = ?").get(id);
  if (!product) {
    return res.status(404).json({ success: false, message: "Product not found" });
  }

  const remove = db.transaction(() => {
    db.prepare(`
      UPDATE content_id_codes
      SET status = 'unused',
          album_title = NULL,
          song_title = NULL,
          artist = NULL,
          product_id = NULL,
          track_id = NULL,
          used_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE product_id = ?
    `).run(id);
    db.prepare("DELETE FROM content_id_products WHERE id = ?").run(id);
  });

  remove();
  res.json({ success: true });
}

function listCmsNetworks(req, res) {
  const networks = db.prepare(`
    SELECT
      id,
      name,
      network_code,
      description,
      cms_auth_status,
      cms_auth_email,
      cms_auth_name,
      cms_auth_scopes,
      cms_token_expiry,
      cms_authed_at,
      updated_at
    FROM networks
    WHERE cms_auth_status = 'connected'
    ORDER BY name COLLATE NOCASE ASC
  `).all();

  res.json({ success: true, networks });
}

function parseChannelInputs(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/[\r\n,;\t]+/);
  const seen = new Set();
  const results = [];

  list.forEach((item) => {
    let input = String(item || "").trim();
    if (!input) return;
    const channelMatch = input.match(/(?:youtube\.com\/channel\/)(UC[A-Za-z0-9_-]+)/i);
    if (channelMatch) input = channelMatch[1];
    if (/^[A-Za-z0-9_-]{22}$/.test(input) && !input.startsWith("UC")) {
      input = `UC${input}`;
    }
    const key = input.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(input);
    }
  });

  return results;
}

function toWhitelistChannelRow(networkId, contentOwnerId, cmsItem = {}, youtubeChannel = {}) {
  return {
    network_id: Number(networkId),
    content_owner_id: contentOwnerId || cmsItem.content_owner_id || "",
    whitelist_id: cmsItem.whitelist_id || cmsItem.id || youtubeChannel.channel_id || "",
    channel_id: youtubeChannel.channel_id || cmsItem.channel_id || "",
    channel_title: youtubeChannel.title || cmsItem.channel_title || "",
    custom_url: youtubeChannel.custom_url || cmsItem.custom_url || "",
    thumbnail_url: youtubeChannel.thumbnail || cmsItem.thumbnail_url || "",
    view_count: moneySafeNumber(youtubeChannel.view_count || cmsItem.view_count),
    subscriber_count: moneySafeNumber(youtubeChannel.subscriber_count || cmsItem.subscriber_count),
    video_count: moneySafeNumber(youtubeChannel.video_count || cmsItem.video_count)
  };
}

const upsertWhitelistStmt = db.prepare(`
  INSERT INTO content_id_whitelists (
    network_id,
    content_owner_id,
    whitelist_id,
    channel_id,
    channel_title,
    custom_url,
    thumbnail_url,
    view_count,
    subscriber_count,
    video_count,
    synced_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(network_id, channel_id) DO UPDATE SET
    content_owner_id = excluded.content_owner_id,
    whitelist_id = COALESCE(NULLIF(excluded.whitelist_id, ''), content_id_whitelists.whitelist_id),
    channel_title = COALESCE(NULLIF(excluded.channel_title, ''), content_id_whitelists.channel_title),
    custom_url = COALESCE(NULLIF(excluded.custom_url, ''), content_id_whitelists.custom_url),
    thumbnail_url = COALESCE(NULLIF(excluded.thumbnail_url, ''), content_id_whitelists.thumbnail_url),
    view_count = CASE WHEN excluded.view_count > 0 THEN excluded.view_count ELSE content_id_whitelists.view_count END,
    subscriber_count = CASE WHEN excluded.subscriber_count > 0 THEN excluded.subscriber_count ELSE content_id_whitelists.subscriber_count END,
    video_count = CASE WHEN excluded.video_count > 0 THEN excluded.video_count ELSE content_id_whitelists.video_count END,
    synced_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
`);

function upsertWhitelist(row) {
  if (!row.channel_id) return;
  upsertWhitelistStmt.run(
    row.network_id,
    row.content_owner_id || "",
    row.whitelist_id || "",
    row.channel_id,
    row.channel_title || "",
    row.custom_url || "",
    row.thumbnail_url || "",
    row.view_count || 0,
    row.subscriber_count || 0,
    row.video_count || 0
  );
}

function isYoutubeQuotaError(error) {
  const message = String(error?.message || "");
  return error?.youtube?.reason === "quotaExceeded"
    || error?.youtube?.reason === "dailyLimitExceeded"
    || /quotaExceeded|quota exceeded|quota reset/i.test(message);
}

function pushUniqueError(errors, error) {
  const key = `${error.network_id || ""}|${error.input || ""}|${error.message || ""}`;
  if (!errors.some((item) => `${item.network_id || ""}|${item.input || ""}|${item.message || ""}` === key)) {
    errors.push(error);
  }
}

function chunkList(values, size = 50) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function getYoutubeChannelsForWhitelist(channelIds, errors = []) {
  const uniqueIds = [...new Set((channelIds || []).filter(Boolean))];
  const channels = [];

  for (const [index, batch] of chunkList(uniqueIds, 50).entries()) {
    try {
      const result = await getChannelsFromYoutube(batch, { includeLatest: false });
      channels.push(...result);
    } catch (error) {
      const quotaError = isYoutubeQuotaError(error);
      pushUniqueError(errors, {
        input: `YouTube Data API batch ${index + 1}`,
        code: quotaError ? "quotaExceeded" : "youtubeDataApiError",
        message: quotaError
          ? (error.message || "YouTube API quota exceeded. Whitelist was synced, but channel stats could not be refreshed.")
          : (error.message || `Could not fetch channel info for ${batch.length} channel(s).`)
      });

      if (quotaError) break;
    }
  }

  return channels;
}

async function resolveWhitelistChannels(inputs) {
  const parsed = parseChannelInputs(inputs);
  const idInputs = parsed.filter((input) => /^UC[A-Za-z0-9_-]{20,}$/.test(input));
  const otherInputs = parsed.filter((input) => !/^UC[A-Za-z0-9_-]{20,}$/.test(input));
  const channels = new Map();
  const errors = [];

  if (idInputs.length) {
    const batch = await getYoutubeChannelsForWhitelist(idInputs, errors);
    batch.forEach((channel) => channels.set(channel.channel_id, channel));
    const batchFailed = errors.some((error) => error.code === "quotaExceeded" || error.code === "youtubeDataApiError");
    if (!batchFailed) {
      const foundIds = new Set(batch.map((channel) => channel.channel_id));
      idInputs.forEach((input) => {
        if (!foundIds.has(input)) errors.push({ input, message: "Channel not found on YouTube Data API" });
      });
    }
  }

  const otherResults = await Promise.allSettled(otherInputs.map((input) => getChannelFromYoutube(input, { includeLatest: false })));
  otherResults.forEach((result, index) => {
    const input = otherInputs[index];
    if (result.status === "fulfilled") {
      channels.set(result.value.channel_id, result.value);
    } else {
      if (isYoutubeQuotaError(result.reason)) {
        errors.push({
          input: "YouTube Data API",
          code: "quotaExceeded",
          message: result.reason?.message || "YouTube API quota exceeded. Whitelist was synced, but channel stats could not be refreshed."
        });
      } else {
        errors.push({ input, message: result.reason?.message || "Could not fetch channel from YouTube Data API" });
      }
    }
  });

  return { channels: Array.from(channels.values()), errors };
}

function listWhitelists(req, res) {
  const networkId = Number(req.query.network_id || 0);
  const search = String(req.query.search || "").trim();
  const clauses = [];
  const params = [];

  if (networkId) {
    clauses.push("w.network_id = ?");
    params.push(networkId);
  }

  if (search) {
    clauses.push("(w.channel_id LIKE ? OR w.channel_title LIKE ? OR w.custom_url LIKE ? OR n.name LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT
      w.*,
      n.name AS network_name,
      n.network_code
    FROM content_id_whitelists w
    LEFT JOIN networks n ON n.id = w.network_id
    ${where}
    ORDER BY n.name COLLATE NOCASE ASC, w.channel_title COLLATE NOCASE ASC, w.channel_id ASC
  `).all(...params);

  const summary = db.prepare(`
    SELECT COUNT(*) AS total, COUNT(DISTINCT network_id) AS networks
    FROM content_id_whitelists
  `).get();

  res.json({ success: true, whitelists: rows, summary });
}

async function syncWhitelists(req, res) {
  const networkId = Number(req.body?.network_id || req.query.network_id || 0);
  const networks = networkId
    ? db.prepare("SELECT id, name FROM networks WHERE id = ? AND cms_auth_status = 'connected'").all(networkId)
    : db.prepare("SELECT id, name FROM networks WHERE cms_auth_status = 'connected' AND COALESCE(network_code, '') <> '' ORDER BY name COLLATE NOCASE ASC").all();

  if (!networks.length) {
    return res.status(400).json({ success: false, message: "No connected CMS network found. Please authorize CMS in Settings > Network first." });
  }

  let synced = 0;
  let deletedStale = 0;
  const errors = [];
  const results = [];

  for (const network of networks) {
    try {
      const cms = await listWhitelistsFromCms(network.id);
      const channelIds = cms.items.map((item) => item.channel_id).filter(Boolean);
      const channelErrors = [];
      const channels = await getYoutubeChannelsForWhitelist(channelIds, channelErrors);
      const channelMap = new Map(channels.map((channel) => [channel.channel_id, channel]));

      const syncRows = db.transaction(() => {
        cms.items.forEach((item) => {
          const channel = channelMap.get(item.channel_id) || {};
          upsertWhitelist(toWhitelistChannelRow(network.id, cms.contentOwnerId, item, channel));
        });

        if (channelIds.length) {
          const placeholders = channelIds.map(() => "?").join(",");
          const info = db.prepare(`
            DELETE FROM content_id_whitelists
            WHERE network_id = ? AND channel_id NOT IN (${placeholders})
          `).run(network.id, ...channelIds);
          deletedStale += info.changes || 0;
        } else {
          const info = db.prepare("DELETE FROM content_id_whitelists WHERE network_id = ?").run(network.id);
          deletedStale += info.changes || 0;
        }
      });

      syncRows();
      synced += cms.items.length;
      results.push({ network_id: network.id, network_name: network.name, synced: cms.items.length });
      channelErrors.forEach((error) => pushUniqueError(errors, { network_id: network.id, ...error }));
    } catch (error) {
      errors.push({ network_id: network.id, network_name: network.name, message: error.message || "Could not sync whitelist" });
    }
  }

  res.json({ success: errors.length === 0, synced, deleted_stale: deletedStale, results, errors });
}

async function syncWhitelistChannelInfo(req, res) {
  const networkId = Number(req.body?.network_id || req.query.network_id || 0);
  const params = [];
  const where = networkId ? "WHERE network_id = ?" : "";
  if (networkId) params.push(networkId);

  const rows = db.prepare(`
    SELECT id, network_id, content_owner_id, whitelist_id, channel_id
    FROM content_id_whitelists
    ${where}
    ORDER BY id ASC
  `).all(...params);

  if (!rows.length) {
    return res.json({ success: true, synced: 0, missing: 0, errors: [], message: "No whitelist channels to sync." });
  }

  const errors = [];
  let synced = 0;
  let missing = 0;

  try {
    const channelIds = [...new Set(rows.map((row) => row.channel_id).filter(Boolean))];
    const channels = await getYoutubeChannelsForWhitelist(channelIds, errors);
    const channelMap = new Map(channels.map((channel) => [channel.channel_id, channel]));

    const updateRows = db.transaction(() => {
      rows.forEach((row) => {
        const channel = channelMap.get(row.channel_id);
        if (!channel) {
          missing += 1;
          return;
        }

        upsertWhitelist(toWhitelistChannelRow(row.network_id, row.content_owner_id, {
          whitelist_id: row.whitelist_id,
          channel_id: row.channel_id
        }, channel));
        synced += 1;
      });
    });

    updateRows();
  } catch (error) {
    pushUniqueError(errors, {
      input: "YouTube Data API",
      code: isYoutubeQuotaError(error) ? "quotaExceeded" : "youtubeDataApiError",
      message: error.message || "Could not sync channel info from YouTube Data API"
    });
  }

  res.status(errors.length && !synced ? 400 : 200).json({
    success: errors.length === 0,
    synced,
    missing,
    errors,
    message: `Synced channel info for ${synced} channel(s). ${missing} channel(s) not found.`
  });
}

async function addWhitelistChannels(req, res) {
  const networkId = Number(req.body?.network_id || 0);
  const inputs = parseChannelInputs(req.body?.channels || req.body?.channel_ids || "");
  if (!networkId) return res.status(400).json({ success: false, message: "CMS network is required" });
  if (!inputs.length) return res.status(400).json({ success: false, message: "Paste at least one channel" });

  const { channels, errors } = await resolveWhitelistChannels(inputs);
  const added = [];
  const skipped = [];

  for (const channel of channels) {
    try {
      const exists = db.prepare("SELECT * FROM content_id_whitelists WHERE network_id = ? AND channel_id = ?").get(networkId, channel.channel_id);
      if (exists?.whitelist_id) {
        skipped.push({ channel_id: channel.channel_id, message: "Already exists in local whitelist" });
        continue;
      }
      const cms = await insertWhitelistToCms(networkId, channel.channel_id);
      upsertWhitelist(toWhitelistChannelRow(networkId, cms.contentOwnerId, cms.item, channel));
      added.push({ channel_id: channel.channel_id, title: channel.title });
    } catch (error) {
      errors.push({ input: channel.channel_id, message: error.message || "Could not add channel to CMS whitelist" });
    }
  }

  res.status(errors.length && !added.length ? 400 : 200).json({
    success: errors.length === 0,
    added,
    skipped,
    errors,
    message: `Added ${added.length} channel(s), ${skipped.length} skipped, ${errors.length} error(s)`
  });
}

async function deleteWhitelistChannels(req, res) {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : String(req.body?.ids || "").split(/[,\s]+/))
    .map((id) => Number(id))
    .filter(Boolean);
  if (!ids.length) return res.status(400).json({ success: false, message: "Select at least one whitelist channel" });

  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM content_id_whitelists
    WHERE id IN (${placeholders})
  `).all(...ids);

  const deleted = [];
  const errors = [];

  for (const row of rows) {
    try {
      await deleteWhitelistFromCms(row.network_id, row.whitelist_id || row.channel_id);
      db.prepare("DELETE FROM content_id_whitelists WHERE id = ?").run(row.id);
      deleted.push(row.id);
    } catch (error) {
      const status = error.response?.status || error.status;
      if (status === 404) {
        db.prepare("DELETE FROM content_id_whitelists WHERE id = ?").run(row.id);
        deleted.push(row.id);
      } else {
        errors.push({ id: row.id, channel_id: row.channel_id, message: error.message || "Could not remove channel from CMS whitelist" });
      }
    }
  }

  res.status(errors.length && !deleted.length ? 400 : 200).json({
    success: errors.length === 0,
    deleted,
    errors,
    message: `Removed ${deleted.length} channel(s), ${errors.length} error(s)`
  });
}

module.exports = {
  addCodes,
  createArtist,
  createLabel,
  deleteCode,
  deleteArtist,
  deleteLabel,
  deleteProduct,
  deleteWhitelistChannels,
  getAvailableCodes,
  getCodeSummary,
  getProduct,
  listArtists,
  listCodes,
  listCmsNetworks,
  listLabels,
  listProducts,
  listWhitelists,
  saveProduct,
  syncLabelsFromCms,
  syncWhitelistChannelInfo,
  syncWhitelists,
  addWhitelistChannels,
  updateArtist,
  updateLabel,
  updateCode,
  moneySafeNumber
};
