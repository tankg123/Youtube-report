const { createHash, randomBytes } = require("node:crypto");
const db = require("../config/database");

const digest = (key) => createHash("sha256").update(key).digest("hex");

function listKeys(_req, res) {
  res.set("Cache-Control", "no-store").json({ keys: db.prepare(
    "SELECT id, name, prefix, created_at, revoked_at FROM ownership_api_keys ORDER BY id DESC"
  ).all() });
}

function createKey(req, res) {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 100) return res.status(400).json({ message: "Enter a key name (up to 100 characters)." });
  const key = "own_" + randomBytes(32).toString("hex");
  const prefix = key.slice(0, 12);
  const { lastInsertRowid } = db.prepare("INSERT INTO ownership_api_keys(name, key_hash, prefix) VALUES (?, ?, ?)")
    .run(name, digest(key), prefix);
  res.set("Cache-Control", "no-store").status(201).json({ id: Number(lastInsertRowid), name, prefix, key });
}

function revokeKey(req, res) {
  const result = db.prepare("UPDATE ownership_api_keys SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ message: "API key not found." });
  res.sendStatus(204);
}

function requireOwnershipKey(req, res, next) {
  res.set("Cache-Control", "no-store");
  const key = req.get("x-api-key") || "";
  if (!/^own_[0-9a-f]{64}$/.test(key) ||
      !db.prepare("SELECT 1 FROM ownership_api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(digest(key))) {
    return res.status(401).json({ status: "Please check manually", message: "Invalid or missing ownership API key." });
  }
  next();
}
module.exports = { listKeys, createKey, revokeKey, requireOwnershipKey };
