const { createHash, createHmac, timingSafeEqual } = require("node:crypto");
const jwt = require("jsonwebtoken");
const db = require("../config/database");
const menu = require("../config/sidebarMenu.json");

function visit(items, callback, ancestors = []) {
  for (const item of items) {
    callback(item.id, ancestors);
    if (item.children) visit(item.children, callback, [...ancestors, item.id]);
  }
}

const parents = new Map();
visit(menu, (id, ancestors) => parents.set(id, ancestors));

function hiddenItems() {
  return db.prepare("SELECT item_id FROM sidebar_hidden_items ORDER BY item_id").pluck().all();
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

// Runtime navigation only needs the effective hidden IDs. The editable tree and
// the explicit choices (which survive hiding a parent) are returned after unlock.
function runtimeVisibility(hidden = hiddenItems()) {
  const off = new Set(hidden);
  return { hidden: [...parents.keys()].filter((id) => off.has(id) || parents.get(id).some((parent) => off.has(parent))) };
}

const grantSeconds = 15 * 60;
function authorizeSidebar(req, res, next) {
  res.set("Cache-Control", "no-store");
  const secret = process.env.SIDEBAR_SETTINGS_CODE;
  if (!secret?.trim()) {
    return res.status(503).json({ message: "Set SIDEBAR_SETTINGS_CODE on the backend before changing the sidebar." });
  }
  // A separate signing key for this login and this configured password. Grants
  // cannot serve as login tokens and rotating either secret invalidates them.
  const grantKey = createHmac("sha256", process.env.JWT_SECRET)
    .update(JSON.stringify(["sidebar-settings", req.headers.authorization, secret])).digest();
  const { code, grant } = req.body || {};
  if (grant && req.method === "PUT") {
    try {
      jwt.verify(grant, grantKey, { algorithms: ["HS256"], audience: "sidebar-settings", subject: String(req.user.id) });
    } catch {
      return res.status(403).json({ code: "SIDEBAR_LOCKED", message: "Unlock sidebar settings again." });
    }
    return next();
  }
  if (typeof code !== "string" || !timingSafeEqual(digest(secret), digest(code))) {
    return res.status(403).json({ message: "Incorrect sidebar code." });
  }
  res.locals.sidebarGrantKey = grantKey;
  next();
}

function unlock(req, res) {
  const grant = jwt.sign({}, res.locals.sidebarGrantKey, { algorithm: "HS256", subject: String(req.user.id),
    audience: "sidebar-settings", expiresIn: grantSeconds });
  const hidden = hiddenItems();
  res.json({ grant, expires_in: grantSeconds, menu, hidden, sidebar: runtimeVisibility(hidden) });
}

function updateVisibility(req, res) {
  const { id, visible } = req.body || {};
  if (!parents.has(id) || typeof visible !== "boolean") {
    return res.status(400).json({ message: "Invalid sidebar item or visibility." });
  }
  if (visible) db.prepare("DELETE FROM sidebar_hidden_items WHERE item_id = ?").run(id);
  else db.prepare("INSERT INTO sidebar_hidden_items (item_id) VALUES (?) ON CONFLICT DO NOTHING").run(id);
  const hidden = hiddenItems();
  res.json({ hidden, sidebar: runtimeVisibility(hidden) });
}

module.exports = { runtimeVisibility, authorizeSidebar, unlock, updateVisibility };
