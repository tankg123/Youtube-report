const db = require("../config/database");
const sidebar = require("./sidebarVisibility");
const {
  REVENUE_TAX_SETTING_KEY,
  REVENUE_TAX_SETTING_KEYS,
  revenueTaxFlagsFromSettings,
  toFlag
} = require("../services/revenueTaxService");

const DEFAULT_SETTINGS = {
  brand_name: "ANS Network",
  brand_subtitle: "MCN Manager System",
  logo_mode: "random",
  logo_data_url: "",
  web_title: "ANS Network",
  favicon_data_url: "",
  export_template_language: "vi",
  ui_accent: "mint",
  // US and Brazil withholding have their own switches; the legacy single key mirrors "any kind on".
  revenue_tax_us_enabled: "0",
  revenue_tax_br_enabled: "0",
  revenue_tax_us_br_enabled: "0"
};

const UI_ACCENTS = new Set(["mint", "orange", "blue", "violet", "rose", "teal"]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function rowsToSettings(rows) {
  const stored = rows.reduce((current, row) => {
    current[row.key] = row.value || "";
    return current;
  }, {});
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  settings.ui_accent = UI_ACCENTS.has(settings.ui_accent) ? settings.ui_accent : DEFAULT_SETTINGS.ui_accent;
  // Effective tax switches: a kind never saved on its own inherits the legacy single switch (from the stored rows
  // only, so the "0" defaults above cannot hide that fallback).
  const flags = revenueTaxFlagsFromSettings(stored);
  settings[REVENUE_TAX_SETTING_KEYS.us] = flags.us ? "1" : "0";
  settings[REVENUE_TAX_SETTING_KEYS.br] = flags.br ? "1" : "0";
  settings[REVENUE_TAX_SETTING_KEY] = flags.any ? "1" : "0";
  return settings;
}

function getSettingsObject() {
  const rows = db.prepare("SELECT key, value FROM system_settings").all();
  return rowsToSettings(rows);
}

function getSettings(req, res) {
  res.json({
    success: true,
    settings: getSettingsObject(),
    sidebar: sidebar.runtimeVisibility()
  });
}

function normalizeSettings(body) {
  const next = {};

  if (hasOwn(body, "brand_name")) {
    next.brand_name = String(body.brand_name || "").trim() || DEFAULT_SETTINGS.brand_name;
  }

  if (hasOwn(body, "logo_mode")) {
    next.logo_mode = body.logo_mode === "upload" ? "upload" : "random";
  }

  if (hasOwn(body, "logo_data_url")) {
    next.logo_data_url = String(body.logo_data_url || "");
  }

  if (hasOwn(body, "web_title")) {
    next.web_title = String(body.web_title || "").trim() || DEFAULT_SETTINGS.web_title;
  }

  if (hasOwn(body, "favicon_data_url")) {
    next.favicon_data_url = String(body.favicon_data_url || "");
  }

  if (hasOwn(body, "export_template_language")) {
    const language = String(body.export_template_language || "").trim().toLowerCase();
    next.export_template_language = ["en", "english"].includes(language) ? "en" : "vi";
  }

  if (hasOwn(body, "ui_accent")) {
    const accent = String(body.ui_accent || "").trim().toLowerCase();
    next.ui_accent = UI_ACCENTS.has(accent) ? accent : DEFAULT_SETTINGS.ui_accent;
  }

  const hasUs = hasOwn(body, REVENUE_TAX_SETTING_KEYS.us);
  const hasBr = hasOwn(body, REVENUE_TAX_SETTING_KEYS.br);
  if (hasUs) next[REVENUE_TAX_SETTING_KEYS.us] = toFlag(body[REVENUE_TAX_SETTING_KEYS.us]) ? "1" : "0";
  if (hasBr) next[REVENUE_TAX_SETTING_KEYS.br] = toFlag(body[REVENUE_TAX_SETTING_KEYS.br]) ? "1" : "0";
  if (!hasUs && !hasBr && hasOwn(body, REVENUE_TAX_SETTING_KEY)) {
    // A client from before the split sends the single switch: it means both kinds.
    const both = toFlag(body[REVENUE_TAX_SETTING_KEY]) ? "1" : "0";
    next[REVENUE_TAX_SETTING_KEYS.us] = both;
    next[REVENUE_TAX_SETTING_KEYS.br] = both;
  }
  if (hasOwn(next, REVENUE_TAX_SETTING_KEYS.us) && hasOwn(next, REVENUE_TAX_SETTING_KEYS.br)) {
    // The legacy key keeps meaning "at least one kind on" for anything that still reads it.
    next[REVENUE_TAX_SETTING_KEY] = next[REVENUE_TAX_SETTING_KEYS.us] === "1" || next[REVENUE_TAX_SETTING_KEYS.br] === "1" ? "1" : "0";
  }

  return next;
}

function updateSettings(req, res) {
  const updates = normalizeSettings(req.body || {});

  const statement = db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);

  const transaction = db.transaction((entries) => {
    for (const [key, value] of entries) {
      statement.run(key, value);
    }
  });

  transaction(Object.entries(updates));

  res.json({
    success: true,
    settings: getSettingsObject()
  });
}

module.exports = {
  getSettings,
  updateSettings
};
