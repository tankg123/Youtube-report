const db = require("../config/database");

const DEFAULT_SETTINGS = {
  brand_name: "ANS Network",
  brand_subtitle: "MCN Manager System",
  logo_mode: "random",
  logo_data_url: "",
  web_title: "ANS Network",
  favicon_data_url: "",
  export_template_language: "vi",
  ui_accent: "mint"
};

const UI_ACCENTS = new Set(["mint", "orange", "blue", "violet", "rose", "teal"]);

function rowsToSettings(rows) {
  const settings = rows.reduce((current, row) => {
    current[row.key] = row.value || "";
    return current;
  }, { ...DEFAULT_SETTINGS });

  settings.ui_accent = UI_ACCENTS.has(settings.ui_accent) ? settings.ui_accent : DEFAULT_SETTINGS.ui_accent;
  return settings;
}

function getSettingsObject() {
  const rows = db.prepare("SELECT key, value FROM system_settings").all();
  return rowsToSettings(rows);
}

function getSettings(req, res) {
  res.json({
    success: true,
    settings: getSettingsObject()
  });
}

function normalizeSettings(body) {
  const next = {};

  if (Object.prototype.hasOwnProperty.call(body, "brand_name")) {
    next.brand_name = String(body.brand_name || "").trim() || DEFAULT_SETTINGS.brand_name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "logo_mode")) {
    next.logo_mode = body.logo_mode === "upload" ? "upload" : "random";
  }

  if (Object.prototype.hasOwnProperty.call(body, "logo_data_url")) {
    next.logo_data_url = String(body.logo_data_url || "");
  }

  if (Object.prototype.hasOwnProperty.call(body, "web_title")) {
    next.web_title = String(body.web_title || "").trim() || DEFAULT_SETTINGS.web_title;
  }

  if (Object.prototype.hasOwnProperty.call(body, "favicon_data_url")) {
    next.favicon_data_url = String(body.favicon_data_url || "");
  }

  if (Object.prototype.hasOwnProperty.call(body, "export_template_language")) {
    const language = String(body.export_template_language || "").trim().toLowerCase();
    next.export_template_language = ["en", "english"].includes(language) ? "en" : "vi";
  }

  if (Object.prototype.hasOwnProperty.call(body, "ui_accent")) {
    const accent = String(body.ui_accent || "").trim().toLowerCase();
    next.ui_accent = UI_ACCENTS.has(accent) ? accent : DEFAULT_SETTINGS.ui_accent;
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
