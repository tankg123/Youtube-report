// Analytics warehouse: one row per (owner, entity, Pacific day), append-only by default,
// every overwrite recorded in a ledger. Pure SQLite, synchronous, no Google calls and no
// require of analyticsService (CommonJS cycle).
const ExcelJS = require("exceljs");

const DAY = 86400000;
const SCOPES = ["claimed", "self", "thirdParty"];
const CHANNEL_ID = /^UC[\w-]{22}$/;
const HISTORY_RETENTION_DAYS = 180;
// Overwrite ledger rows are pruned after this many days (env ANALYTICS_HISTORY_OVERWRITE_DAYS, default 365).
const OVERWRITE_RETENTION_DAYS_DEFAULT = 365;
const MIGRATION_META_KEY = "migration:snapshots-to-facts";

function errorWithStatus(message, status = 400, reason) {
  const error = new Error(message); error.status = status; if (reason) error.reason = reason; return error;
}
function ensureWarehouseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytic_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analytic_daily_facts (
      owner_id TEXT NOT NULL, entity_key TEXT NOT NULL, day TEXT NOT NULL,
      metrics_json TEXT NOT NULL, monetary INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
      revision INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, job_id TEXT,
      first_synced_at TEXT NOT NULL, last_synced_at TEXT NOT NULL, last_changed_at TEXT NOT NULL,
      PRIMARY KEY(owner_id, entity_key, day));
    CREATE INDEX IF NOT EXISTS analytic_daily_facts_day ON analytic_daily_facts(owner_id, day, entity_key);
    CREATE TABLE IF NOT EXISTS analytic_daily_breakdowns (
      owner_id TEXT NOT NULL, entity_key TEXT NOT NULL, day TEXT NOT NULL, dimension TEXT NOT NULL, dimension_value TEXT NOT NULL,
      metrics_json TEXT NOT NULL, monetary INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, job_id TEXT,
      first_synced_at TEXT NOT NULL, last_synced_at TEXT NOT NULL, last_changed_at TEXT NOT NULL,
      PRIMARY KEY(owner_id, entity_key, day, dimension, dimension_value));
    CREATE INDEX IF NOT EXISTS analytic_daily_breakdowns_day ON analytic_daily_breakdowns(owner_id, entity_key, dimension, day);
    CREATE TABLE IF NOT EXISTS analytic_day_coverage (
      owner_id TEXT NOT NULL, entity_key TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL,
      monetary INTEGER NOT NULL DEFAULT 0, job_id TEXT, synced_at TEXT NOT NULL,
      PRIMARY KEY(owner_id, entity_key, day, kind));
    CREATE TABLE IF NOT EXISTS analytic_daily_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, entity_key TEXT NOT NULL, day TEXT NOT NULL,
      dimension TEXT NOT NULL DEFAULT '', dimension_value TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL, previous_json TEXT NOT NULL, new_json TEXT NOT NULL, job_id TEXT, recorded_at TEXT NOT NULL,
      monetary_only INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS analytic_daily_history_lookup ON analytic_daily_history(owner_id, entity_key, day, recorded_at DESC);
  `);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const additions = { analytic_jobs: { kind: "TEXT", mode: "TEXT" }, analytic_channels: { removed_at: "TEXT" } };
  for (const [table, columns] of Object.entries(additions)) {
    if (!tables.has(table)) continue;
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [column, type] of Object.entries(columns)) if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // monetary_only lets history() filter at SQL level for non-monetary readers; a ledger created before the column gets it backfilled once from the stored diffs.
  const historyColumns = new Set(db.prepare("PRAGMA table_info(analytic_daily_history)").all().map((column) => column.name));
  if (!historyColumns.has("monetary_only")) {
    db.transaction(() => {
      db.exec("ALTER TABLE analytic_daily_history ADD COLUMN monetary_only INTEGER NOT NULL DEFAULT 0");
      const flag = db.prepare("UPDATE analytic_daily_history SET monetary_only=1 WHERE id=?");
      for (const row of db.prepare("SELECT id,action,dimension,previous_json,new_json FROM analytic_daily_history").all()) {
        let entry; try { entry = { action: row.action, dimension: row.dimension, previous: JSON.parse(row.previous_json), next: JSON.parse(row.new_json) }; } catch { continue; }
        if (isMonetaryOnly(entry)) flag.run(row.id);
      }
    })();
  }
}

const metric = (key, kind, options = {}) => ({ key, kind, additive: false, monetary: false, derived: false, ...options });
const METRIC_REGISTRY = Object.freeze([
  metric("views", "count", { additive: true }), metric("engagedViews", "count", { additive: true }), metric("redViews", "count", { additive: true }),
  metric("estimatedMinutesWatched", "minutes", { additive: true }), metric("estimatedRedMinutesWatched", "minutes", { additive: true }),
  metric("averageViewDuration", "seconds", { approx: true }), metric("averageViewPercentage", "percent"),
  metric("likes", "count", { additive: true }), metric("dislikes", "count", { additive: true }), metric("comments", "count", { additive: true }),
  metric("shares", "count", { additive: true }), metric("subscribersGained", "count", { additive: true }), metric("subscribersLost", "count", { additive: true }),
  metric("videosAddedToPlaylists", "count", { additive: true }), metric("videosRemovedFromPlaylists", "count", { additive: true }),
  metric("estimatedRevenue", "money", { additive: true, monetary: true }), metric("estimatedAdRevenue", "money", { additive: true, monetary: true }),
  metric("estimatedRedPartnerRevenue", "money", { additive: true, monetary: true }), metric("grossRevenue", "money", { additive: true, monetary: true }),
  metric("monetizedPlaybacks", "count", { additive: true, monetary: true }), metric("playbackBasedCpm", "cpm", { monetary: true }),
  metric("adImpressions", "count", { additive: true, monetary: true }), metric("cpm", "cpm", { monetary: true }),
  metric("viewerPercentage", "percent"),
  metric("watchHours", "ratio", { derived: true }), metric("netSubscribers", "count", { derived: true }), metric("rpm", "cpm", { derived: true, monetary: true })
].map(Object.freeze));
const REGISTRY_BY_KEY = new Map(METRIC_REGISTRY.map((entry) => [entry.key, entry]));
const MONETARY_KEYS = new Set(METRIC_REGISTRY.filter((entry) => entry.monetary).map((entry) => entry.key));
const ADDITIVE_KEYS = new Set(METRIC_REGISTRY.filter((entry) => entry.additive).map((entry) => entry.key));
const DERIVED_KEYS = new Set(METRIC_REGISTRY.filter((entry) => entry.derived).map((entry) => entry.key));
const DIMENSION_SORT_KEY = { sharingService: "shares", adType: "grossRevenue" };

function stripMonetary(object, canMonetary) {
  if (canMonetary || !object || typeof object !== "object") return object;
  return Object.fromEntries(Object.entries(object).filter(([key]) => !MONETARY_KEYS.has(key)));
}
// Finite numbers only, keys sorted; numeric strings (CSV sources) are accepted, everything else is dropped.
function normalizeMetrics(object) {
  const result = {};
  for (const key of Object.keys(object || {}).sort()) {
    const raw = object[key];
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (Number.isFinite(value)) result[key] = value;
  }
  return result;
}
function hasMonetary(metrics) { return Object.keys(metrics).some((key) => MONETARY_KEYS.has(key)); }
function entityKey({ scope, channelId } = {}) {
  if (channelId) {
    if (!CHANNEL_ID.test(String(channelId))) throw errorWithStatus("Invalid YouTube channel ID.");
    return `channel:${channelId}`;
  }
  const value = scope || "claimed";
  if (!SCOPES.includes(value)) throw errorWithStatus("scope must be claimed, self, or thirdParty.");
  return `owner:${value}`;
}
function parseEntityKey(key) {
  const match = /^(owner):(claimed|self|thirdParty)$|^(channel):(UC[\w-]{22})$/.exec(String(key || ""));
  if (!match) throw errorWithStatus("Invalid entity key.");
  return match[1] ? { type: "owner", scope: match[2] } : { type: "channel", channelId: match[4] };
}
function isOwnerKey(key) { return /^owner:(claimed|self|thirdParty)$/.test(String(key || "")); }
function instant(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw errorWithStatus("A valid instant is required.");
  return date.toISOString();
}
function dayString(value, field = "day") {
  const text = String(value || ""); const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  // An impossible date (2026-13-01) has a NaN time; toISOString would throw a bare RangeError instead of the 400.
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw errorWithStatus(`${field} must use YYYY-MM-DD.`);
  return text;
}
function addDays(day, count) { return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10); }
function daysBetween(startDate, endDate) {
  const start = dayString(startDate, "startDate"); const end = dayString(endDate, "endDate");
  if (start > end) throw errorWithStatus("startDate must not be after endDate.");
  const days = []; for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}
function previousRange({ startDate, endDate }) {
  const length = daysBetween(startDate, endDate).length;
  return { startDate: addDays(startDate, -length), endDate: addDays(startDate, -1) };
}
function requireCurrency(currency) {
  if ((currency || "USD") !== "USD") throw errorWithStatus("Analytics facts are stored in USD only.");
}
function validateMode(mode) {
  if (!["append", "overwrite"].includes(mode)) throw errorWithStatus("mode must be append or overwrite.");
}
function diffKeys(previous, incoming) {
  const changed = {}; const added = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in previous)) added[key] = value;
    else if (previous[key] !== value) changed[key] = [previous[key], value];
  }
  return { changed, added, hasChanges: Object.keys(changed).length > 0, hasAdditions: Object.keys(added).length > 0 };
}
// The basic and monetary passes of one run record separate drift rows, so the dedupe looks at the latest few rows, not only the last one.
const DRIFT_DEDUPE_ROWS = 4;
function latestHistory(db, { ownerId, entityKey: key, day, dimension, action, limit = 1 }) {
  return db.prepare("SELECT new_json FROM analytic_daily_history WHERE owner_id=? AND entity_key=? AND day=? AND dimension=? AND action=? ORDER BY id DESC LIMIT ?")
    .all(ownerId, key, day, dimension, action, limit);
}
// A ledger row is monetary-only when a non-monetary reader would see nothing of it (adType rows always are).
function isMonetaryOnly(entry) { return entry.dimension === "adType" || stripDiff(entry, false) === null; }
function recordHistory(db, { ownerId, entityKey: key, day, dimension = "", dimensionValue = "", action, previous, next, jobId, now }) {
  const newJson = JSON.stringify(next);
  if (action === "drift" && latestHistory(db, { ownerId, entityKey: key, day, dimension, action, limit: DRIFT_DEDUPE_ROWS }).some((row) => row.new_json === newJson)) return false;
  db.prepare("INSERT INTO analytic_daily_history(owner_id,entity_key,day,dimension,dimension_value,action,previous_json,new_json,job_id,recorded_at,monetary_only) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(ownerId, key, day, dimension, dimensionValue, action, JSON.stringify(previous), newJson, jobId ?? null, now, isMonetaryOnly({ action, dimension, previous, next }) ? 1 : 0);
  return true;
}
function counters() { return { inserted: 0, updated: 0, enriched: 0, unchanged: 0, drift: 0, skipped: 0 }; }
// Metric keys a Google request asked for (array or comma-separated string); a non-monetary job never names a monetary key.
function requestedKeys(metricKeys, monetary) {
  const list = Array.isArray(metricKeys) ? metricKeys : typeof metricKeys === "string" ? metricKeys.split(",") : null;
  if (!list) return null;
  return new Set(list.map((key) => String(key).trim()).filter((key) => key && (monetary || !MONETARY_KEYS.has(key))));
}

function writeFacts(db, { ownerId, entityKey: key, rows = [], mode, source, jobId = null, monetary = false, currency = "USD", now }) {
  parseEntityKey(key); validateMode(mode); requireCurrency(currency);
  if (!source) throw errorWithStatus("source is required.");
  const at = instant(now); const result = counters();
  const select = db.prepare("SELECT metrics_json FROM analytic_daily_facts WHERE owner_id=? AND entity_key=? AND day=?");
  const insert = db.prepare(`INSERT INTO analytic_daily_facts(owner_id,entity_key,day,metrics_json,monetary,currency,revision,source,job_id,first_synced_at,last_synced_at,last_changed_at)
    VALUES(?,?,?,?,?,'USD',1,?,?,?,?,?)`);
  const touch = db.prepare("UPDATE analytic_daily_facts SET last_synced_at=? WHERE owner_id=? AND entity_key=? AND day=?");
  const merge = db.prepare("UPDATE analytic_daily_facts SET metrics_json=?,monetary=?,source=?,job_id=?,last_synced_at=? WHERE owner_id=? AND entity_key=? AND day=?");
  const driftMerge = db.prepare("UPDATE analytic_daily_facts SET metrics_json=?,monetary=?,last_synced_at=? WHERE owner_id=? AND entity_key=? AND day=?");
  // One overwriting job bumps the revision once even though its basic and monetary passes write separately.
  const overwrite = db.prepare("UPDATE analytic_daily_facts SET metrics_json=?,monetary=?,revision=revision+CASE WHEN ? IS NOT NULL AND job_id IS ? THEN 0 ELSE 1 END,source=?,job_id=?,last_synced_at=?,last_changed_at=? WHERE owner_id=? AND entity_key=? AND day=?");
  db.transaction(() => {
    for (const row of rows) {
      const day = dayString(row.day);
      // A non-monetary job never carries, modifies or removes monetary keys.
      const incoming = stripMonetary(normalizeMetrics(row.metrics), monetary);
      if (!Object.keys(incoming).length) { result.skipped += 1; continue; }
      const stored = select.get(ownerId, key, day);
      if (!stored) { insert.run(ownerId, key, day, JSON.stringify(incoming), hasMonetary(incoming) ? 1 : 0, source, jobId, at, at, at); result.inserted += 1; continue; }
      const previous = JSON.parse(stored.metrics_json);
      const { changed, added, hasChanges, hasAdditions } = diffKeys(previous, incoming);
      if (mode === "append" && hasChanges) {
        const merged = normalizeMetrics({ ...previous, ...added });
        driftMerge.run(JSON.stringify(merged), hasMonetary(merged) ? 1 : 0, at, ownerId, key, day);
        recordHistory(db, { ownerId, entityKey: key, day, action: "drift", previous: Object.fromEntries(Object.keys(changed).map((k) => [k, previous[k]])), next: changed, jobId, now: at });
        result.drift += 1; continue;
      }
      if (mode === "overwrite" && hasChanges) {
        const merged = normalizeMetrics({ ...previous, ...incoming });
        overwrite.run(JSON.stringify(merged), hasMonetary(merged) ? 1 : 0, jobId, jobId, source, jobId, at, at, ownerId, key, day);
        recordHistory(db, { ownerId, entityKey: key, day, action: "overwrite", previous, next: Object.fromEntries(Object.keys(changed).map((k) => [k, incoming[k]])), jobId, now: at });
        result.updated += 1; continue;
      }
      if (hasAdditions) {
        const merged = normalizeMetrics({ ...previous, ...added });
        merge.run(JSON.stringify(merged), hasMonetary(merged) ? 1 : 0, source, jobId, at, ownerId, key, day);
        result.enriched += 1; continue;
      }
      touch.run(at, ownerId, key, day); result.unchanged += 1;
    }
  })();
  return result;
}

function markCoverage(db, { ownerId, entityKey: key, days = [], kind = "facts", monetary = false, jobId = null, now }) {
  parseEntityKey(key);
  const at = instant(now);
  const upsert = db.prepare(`INSERT INTO analytic_day_coverage(owner_id,entity_key,day,kind,monetary,job_id,synced_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(owner_id,entity_key,day,kind) DO UPDATE SET monetary=MAX(monetary,excluded.monetary),job_id=excluded.job_id,synced_at=excluded.synced_at`);
  db.transaction(() => { for (const day of days) upsert.run(ownerId, key, dayString(day), kind, monetary ? 1 : 0, jobId, at); })();
  return days.length;
}

// metricKeys (optional) = the metric keys the Google request asked for; in overwrite mode they are the only keys a stored value
// absent from the response loses. Without them the union of the incoming keys is used.
function writeBreakdowns(db, { ownerId, entityKey: key, dimension, rows = [], mode, source, jobId = null, monetary = false, now, coveredDays, metricKeys = null }) {
  parseEntityKey(key); validateMode(mode);
  if (!dimension || !/^[A-Za-z]+$/.test(dimension)) throw errorWithStatus("dimension is required.");
  if (!source) throw errorWithStatus("source is required.");
  const at = instant(now); const result = counters(); const kind = `breakdown:${dimension}`;
  const requested = requestedKeys(metricKeys, monetary);
  const byDay = new Map();
  for (const row of rows) {
    const day = dayString(row.day); const value = String(row.value ?? "");
    const metrics = stripMonetary(normalizeMetrics(row.metrics), monetary);
    if (!Object.keys(metrics).length) { result.skipped += 1; continue; }
    if (!byDay.has(day)) byDay.set(day, new Map());
    byDay.get(day).set(value, metrics);
  }
  const selectDay = db.prepare("SELECT dimension_value,metrics_json FROM analytic_daily_breakdowns WHERE owner_id=? AND entity_key=? AND day=? AND dimension=? ORDER BY dimension_value");
  const covered = db.prepare("SELECT 1 FROM analytic_day_coverage WHERE owner_id=? AND entity_key=? AND day=? AND kind=?");
  const insert = db.prepare(`INSERT INTO analytic_daily_breakdowns(owner_id,entity_key,day,dimension,dimension_value,metrics_json,monetary,revision,source,job_id,first_synced_at,last_synced_at,last_changed_at)
    VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?)`);
  // Per value: revision +1 and last_changed_at only when the value itself changed, and once per overwriting job (its basic and monetary passes write separately).
  const update = db.prepare(`UPDATE analytic_daily_breakdowns SET metrics_json=?,monetary=?,revision=revision+CASE WHEN ?=1 AND NOT(? IS NOT NULL AND job_id IS ?) THEN 1 ELSE 0 END,
    source=?,job_id=?,last_synced_at=?,last_changed_at=CASE WHEN ?=1 THEN ? ELSE last_changed_at END
    WHERE owner_id=? AND entity_key=? AND day=? AND dimension=? AND dimension_value=?`);
  const touch = db.prepare("UPDATE analytic_daily_breakdowns SET last_synced_at=? WHERE owner_id=? AND entity_key=? AND day=? AND dimension=? AND dimension_value=?");
  const removeValue = db.prepare("DELETE FROM analytic_daily_breakdowns WHERE owner_id=? AND entity_key=? AND day=? AND dimension=? AND dimension_value=?");
  const insertRow = (day, value, metrics) => insert.run(ownerId, key, day, dimension, value, JSON.stringify(metrics), hasMonetary(metrics) ? 1 : 0, source, jobId, at, at, at);
  const updateRow = (day, value, metrics, changed) => update.run(JSON.stringify(metrics), hasMonetary(metrics) ? 1 : 0, changed ? 1 : 0, jobId, jobId, source, jobId, at, changed ? 1 : 0, at, ownerId, key, day, dimension, value);
  const touchRow = (day, value) => touch.run(at, ownerId, key, day, dimension, value);
  const keyCount = (metrics) => Object.keys(metrics).length;
  db.transaction(() => {
    for (const [day, incoming] of byDay) {
      const storedRows = selectDay.all(ownerId, key, day, dimension).map((row) => ({ value: row.dimension_value, metrics: JSON.parse(row.metrics_json) }));
      const stored = new Map(storedRows.map((row) => [row.value, row.metrics]));
      if (!stored.size && !covered.get(ownerId, key, day, kind)) {
        for (const [value, metrics] of incoming) { insertRow(day, value, metrics); result.inserted += 1; }
        continue;
      }
      // Canonical (sorted) value order so identical observations serialise identically for the drift dedupe.
      const values = [...incoming.keys()].sort();
      const added = values.filter((value) => !stored.has(value));
      const missing = [...stored.keys()].filter((value) => !incoming.has(value)).sort();
      const changed = {}; let enriched = false;
      for (const value of values) {
        if (!stored.has(value)) continue;
        const diff = diffKeys(stored.get(value), incoming.get(value));
        if (diff.hasChanges) changed[value] = diff.changed;
        if (diff.hasAdditions) enriched = true;
      }
      if (mode === "append") {
        // Keys absent from a stored row (monetary enrichment) are merged; stored values are never replaced and provenance moves only when a key was added.
        for (const value of values) {
          if (!stored.has(value)) continue;
          const previous = stored.get(value); const merged = normalizeMetrics({ ...incoming.get(value), ...previous });
          if (keyCount(merged) > keyCount(previous)) updateRow(day, value, merged, false); else touchRow(day, value);
        }
        if (added.length || missing.length || Object.keys(changed).length) {
          recordHistory(db, { ownerId, entityKey: key, day, dimension, action: "drift", previous: storedRows, next: { added, changed, missing }, jobId, now: at });
          result.drift += 1;
        } else result[enriched ? "enriched" : "unchanged"] += 1;
        continue;
      }
      // Overwrite: incoming keys replace the stored ones per value and every other stored key survives (the basic and monetary
      // passes never erase each other). A stored value the response no longer carries loses only the requested keys and is
      // deleted when nothing is left. Additions alone are an enrichment: no ledger row, no revision bump.
      const removable = requested || new Set(values.flatMap((value) => Object.keys(incoming.get(value))));
      const next = new Map(); let differs = added.length > 0;
      for (const value of values) {
        const metrics = incoming.get(value);
        if (!stored.has(value)) { insertRow(day, value, metrics); next.set(value, metrics); continue; }
        const previous = stored.get(value); const merged = normalizeMetrics({ ...previous, ...metrics });
        next.set(value, merged);
        if (changed[value]) { updateRow(day, value, merged, true); differs = true; }
        else if (keyCount(merged) > keyCount(previous)) updateRow(day, value, merged, false);
        else touchRow(day, value);
      }
      for (const value of missing) {
        const previous = stored.get(value);
        const remaining = Object.fromEntries(Object.entries(previous).filter(([metricKey]) => !removable.has(metricKey)));
        if (keyCount(remaining) === keyCount(previous)) { next.set(value, previous); continue; }
        differs = true;
        if (keyCount(remaining)) { updateRow(day, value, remaining, true); next.set(value, remaining); }
        else removeValue.run(ownerId, key, day, dimension, value);
      }
      if (!differs) { result[enriched ? "enriched" : "unchanged"] += 1; continue; }
      recordHistory(db, { ownerId, entityKey: key, day, dimension, action: "overwrite", previous: storedRows, next: [...next.keys()].sort().map((value) => ({ value, metrics: next.get(value) })), jobId, now: at });
      result.updated += 1;
    }
    if (Array.isArray(coveredDays) && coveredDays.length) markCoverage(db, { ownerId, entityKey: key, days: coveredDays, kind, monetary, jobId, now: at });
  })();
  return result;
}

function coverageRows(db, { ownerId, entityKey: key, startDate, endDate, kind }) {
  return db.prepare("SELECT day,monetary,synced_at FROM analytic_day_coverage WHERE owner_id=? AND entity_key=? AND kind=? AND day BETWEEN ? AND ? ORDER BY day")
    .all(ownerId, key, kind, startDate, endDate);
}
function missingDays(db, { ownerId, entityKey: key, startDate, endDate, kind = "facts", monetary = false }) {
  parseEntityKey(key);
  const days = daysBetween(startDate, endDate);
  const rows = new Map(coverageRows(db, { ownerId, entityKey: key, startDate, endDate, kind }).map((row) => [row.day, row]));
  return days.filter((day) => { const row = rows.get(day); return !row || (monetary && !row.monetary); });
}
function coverage(db, { ownerId, entityKey: key, startDate, endDate, canMonetary = false, lagDays = 3, latestAllowedDay }) {
  parseEntityKey(key);
  const days = daysBetween(startDate, endDate);
  const facts = new Map(coverageRows(db, { ownerId, entityKey: key, startDate, endDate, kind: "facts" }).map((row) => [row.day, row]));
  const breakdowns = new Map();
  for (const row of db.prepare("SELECT day,kind FROM analytic_day_coverage WHERE owner_id=? AND entity_key=? AND kind LIKE 'breakdown:%' AND day BETWEEN ? AND ? ORDER BY kind").all(ownerId, key, startDate, endDate)) {
    const dimension = row.kind.slice("breakdown:".length);
    if (dimension === "adType" && !canMonetary) continue;
    if (!breakdowns.has(row.day)) breakdowns.set(row.day, []);
    breakdowns.get(row.day).push(dimension);
  }
  const drifted = new Set(db.prepare("SELECT DISTINCT day FROM analytic_daily_history WHERE owner_id=? AND entity_key=? AND action='drift' AND day BETWEEN ? AND ?").all(ownerId, key, startDate, endDate).map((row) => row.day));
  const pendingAfter = latestAllowedDay ? addDays(dayString(latestAllowedDay, "latestAllowedDay"), -Math.max(0, Number(lagDays) || 0)) : null;
  const detail = days.map((day) => {
    const row = facts.get(day);
    return { day, facts: !!row, monetary: !!row?.monetary, breakdowns: breakdowns.get(day) || [], drift: drifted.has(day), pending: !row && !!pendingAfter && day > pendingAfter };
  });
  const bounds = db.prepare("SELECT MIN(day) AS firstDay,MAX(day) AS lastDay,MAX(synced_at) AS lastSyncedAt FROM analytic_day_coverage WHERE owner_id=? AND entity_key=? AND kind='facts'").get(ownerId, key);
  return { days: detail, covered: detail.filter((d) => d.facts).length, missing: detail.filter((d) => !d.facts && !d.pending).map((d) => d.day),
    pending: detail.filter((d) => d.pending).map((d) => d.day), firstDay: bounds?.firstDay || null, lastDay: bounds?.lastDay || null,
    lastSyncedAt: bounds?.lastSyncedAt || null, driftDays: detail.filter((d) => d.drift).length };
}
function latestCoveredDay(db, ownerId, entityKeyPrefix = "owner:") {
  const prefix = String(entityKeyPrefix || "").replace(/[\\%_]/g, "\\$&");
  return db.prepare("SELECT MAX(day) AS day FROM analytic_day_coverage WHERE owner_id=? AND kind='facts' AND entity_key LIKE ? ESCAPE '\\'").get(ownerId, `${prefix}%`)?.day || null;
}

function ratio(numerator, denominator, factor = 1) { return denominator > 0 && Number.isFinite(numerator) ? numerator * factor / denominator : null; }
// Aggregates fact rows ({ metrics, monetary }) of one or several entities/days into one metric object.
function aggregate(rows, { canMonetary = true, keyUnion = null } = {}) {
  const totals = {}; const nonAdditive = new Map(); let monetaryViews = 0; let monetaryRows = 0;
  for (const row of rows) {
    const metrics = row.metrics;
    if (hasMonetary(metrics)) { monetaryRows += 1; monetaryViews += Number(metrics.views) || 0; }
    for (const [key, value] of Object.entries(metrics)) {
      if (DERIVED_KEYS.has(key)) continue;
      if (ADDITIVE_KEYS.has(key) || !REGISTRY_BY_KEY.has(key)) totals[key] = (totals[key] || 0) + value;
      else nonAdditive.set(key, (nonAdditive.get(key) || []).concat(value));
    }
  }
  for (const key of keyUnion || []) if (ADDITIVE_KEYS.has(key) && !(key in totals)) totals[key] = 0;
  const single = rows.length === 1;
  for (const [key, values] of nonAdditive) {
    if (single) { totals[key] = values[0]; continue; }
    if (key === "averageViewDuration") totals[key] = ratio(totals.estimatedMinutesWatched, totals.engagedViews, 60);
    else if (key === "cpm") totals[key] = ratio(totals.grossRevenue, totals.adImpressions, 1000);
    else if (key === "playbackBasedCpm") totals[key] = ratio(totals.grossRevenue, totals.monetizedPlaybacks, 1000);
    else totals[key] = null;
  }
  if ("estimatedMinutesWatched" in totals) totals.watchHours = totals.estimatedMinutesWatched / 60;
  if ("subscribersGained" in totals && "subscribersLost" in totals) totals.netSubscribers = totals.subscribersGained - totals.subscribersLost;
  if ("estimatedRevenue" in totals) totals.rpm = ratio(totals.estimatedRevenue, monetaryViews, 1000);
  const approx = !single && nonAdditive.size ? [...nonAdditive.keys()].filter((key) => REGISTRY_BY_KEY.get(key)?.approx) : [];
  return { metrics: stripMonetary(totals, canMonetary), rows: rows.length, monetaryRows, monetaryViews, approx };
}
function factRows(db, { ownerId, entityKeys, startDate, endDate }) {
  const marks = entityKeys.map(() => "?").join(",");
  return db.prepare(`SELECT entity_key,day,metrics_json,monetary,revision,source,first_synced_at,last_synced_at FROM analytic_daily_facts WHERE owner_id=? AND entity_key IN (${marks}) AND day BETWEEN ? AND ? ORDER BY day,entity_key`)
    .all(ownerId, ...entityKeys, startDate, endDate).map((row) => ({ ...row, metrics: JSON.parse(row.metrics_json) }));
}
function validateEntityKeys(entityKeys) {
  if (!Array.isArray(entityKeys) || !entityKeys.length) throw errorWithStatus("At least one entity key is required.");
  const keys = [...new Set(entityKeys.map(String))]; keys.forEach(parseEntityKey);
  const owners = keys.filter(isOwnerKey).length;
  if (owners > 1) throw errorWithStatus("Owner scopes overlap and cannot be summed. Select one scope.");
  if (owners && owners !== keys.length) throw errorWithStatus("Owner scopes and channels cannot be mixed in one series.");
  return keys;
}
function readSeries(db, { ownerId, entityKeys, startDate, endDate, canMonetary = false }) {
  const keys = validateEntityKeys(entityKeys);
  const days = daysBetween(startDate, endDate);
  const rows = factRows(db, { ownerId, entityKeys: keys, startDate, endDate });
  const keyUnion = new Set(rows.flatMap((row) => Object.keys(row.metrics)));
  const byDay = new Map(); for (const row of rows) { if (!byDay.has(row.day)) byDay.set(row.day, []); byDay.get(row.day).push(row); }
  const marks = keys.map(() => "?").join(",");
  const covered = new Set(db.prepare(`SELECT DISTINCT day FROM analytic_day_coverage WHERE owner_id=? AND entity_key IN (${marks}) AND kind='facts' AND day BETWEEN ? AND ?`)
    .all(ownerId, ...keys, startDate, endDate).map((row) => row.day));
  return days.map((day) => {
    // The coverage table is the single source of truth: a stored row without a coverage row (interrupted job, migrated day past availableEndDate) is "not synced".
    if (!covered.has(day)) return { day, metrics: null, covered: false, rows: 0, monetaryRows: 0, monetaryViews: 0, approx: [] };
    const { metrics, rows: count, monetaryRows, monetaryViews, approx } = aggregate(byDay.get(day) || [], { canMonetary, keyUnion });
    return { day, metrics, covered: true, rows: count, monetaryRows, monetaryViews, approx };
  });
}
// Totals are always recomputed from the per-day sums (never passed through), so one-day and 90-day summaries follow the same rules.
function summarize(series = []) {
  const covered = series.filter((entry) => entry.covered && entry.metrics);
  const totals = {}; let rows = 0; let monetaryRows = 0; let monetaryViews = 0; let monetaryDays = 0; const nonAdditive = new Set();
  for (const entry of covered) {
    rows += entry.rows || 0; monetaryRows += entry.monetaryRows || 0; monetaryViews += entry.monetaryViews || 0;
    if (entry.monetaryRows > 0) monetaryDays += 1;
    for (const [key, value] of Object.entries(entry.metrics)) {
      if (DERIVED_KEYS.has(key) || !Number.isFinite(value)) continue;
      if (ADDITIVE_KEYS.has(key) || !REGISTRY_BY_KEY.has(key)) totals[key] = (totals[key] || 0) + value;
      else nonAdditive.add(key);
    }
  }
  for (const key of nonAdditive) {
    if (covered.length === 1) totals[key] = covered[0].metrics[key];
    else if (key === "averageViewDuration") totals[key] = ratio(totals.estimatedMinutesWatched, totals.engagedViews, 60);
    else if (key === "cpm") totals[key] = ratio(totals.grossRevenue, totals.adImpressions, 1000);
    else if (key === "playbackBasedCpm") totals[key] = ratio(totals.grossRevenue, totals.monetizedPlaybacks, 1000);
    else totals[key] = null;
  }
  if ("estimatedMinutesWatched" in totals) totals.watchHours = totals.estimatedMinutesWatched / 60;
  if ("subscribersGained" in totals && "subscribersLost" in totals) totals.netSubscribers = totals.subscribersGained - totals.subscribersLost;
  if ("estimatedRevenue" in totals) totals.rpm = ratio(totals.estimatedRevenue, monetaryViews, 1000);
  return { totals, coverage: { covered: covered.length, total: series.length }, monetaryCoverage: { rows, monetaryRows, days: covered.length, monetaryDays },
    partialRevenue: monetaryRows < rows, approx: [...nonAdditive].filter((key) => REGISTRY_BY_KEY.get(key)?.approx && covered.length > 1) };
}
function compareSummaries(current, previous) {
  const now = current?.totals || current || {}; const before = previous?.totals || previous || {};
  return Object.fromEntries(Object.keys(now).map((key) => [key, Number.isFinite(now[key]) && Number.isFinite(before[key]) && before[key] !== 0
    ? (now[key] - before[key]) * 100 / Math.abs(before[key]) : null]));
}

function readBreakdown(db, { ownerId, entityKey: key, dimension, startDate, endDate, canMonetary = false, limit = 200 }) {
  parseEntityKey(key);
  if (!dimension || !/^[A-Za-z]+$/.test(dimension)) throw errorWithStatus("dimension is required.");
  const totalDays = daysBetween(startDate, endDate).length;
  if (dimension === "adType" && !canMonetary) return { rows: [], coveredDays: 0, totalDays, status: "unsupported" };
  const coveredDays = coverageRows(db, { ownerId, entityKey: key, startDate, endDate, kind: `breakdown:${dimension}` }).length;
  const byValue = new Map();
  for (const row of db.prepare("SELECT dimension_value,metrics_json,monetary FROM analytic_daily_breakdowns WHERE owner_id=? AND entity_key=? AND dimension=? AND day BETWEEN ? AND ? ORDER BY day").all(ownerId, key, dimension, startDate, endDate)) {
    if (!byValue.has(row.dimension_value)) byValue.set(row.dimension_value, []);
    byValue.get(row.dimension_value).push({ metrics: JSON.parse(row.metrics_json), monetary: row.monetary });
  }
  const sortKey = DIMENSION_SORT_KEY[dimension] || "views";
  const rows = [...byValue].map(([value, entries]) => ({ value, metrics: aggregate(entries, { canMonetary }).metrics }))
    .sort((a, b) => (Number(b.metrics[sortKey]) || 0) - (Number(a.metrics[sortKey]) || 0) || a.value.localeCompare(b.value)).slice(0, Math.max(1, Number(limit) || 200));
  return { rows, coveredDays, totalDays, status: !coveredDays ? "missing" : coveredDays < totalDays ? "partial" : "ready" };
}
function readChannelTotals(db, { ownerId, channelIds = null, startDate, endDate, canMonetary = false }) {
  daysBetween(startDate, endDate);
  const keys = channelIds ? [...new Set(channelIds)].map((id) => entityKey({ channelId: id })) : null;
  const scope = keys ? `entity_key IN (${keys.map(() => "?").join(",")})` : "entity_key LIKE 'channel:%'";
  const args = keys ? [ownerId, ...keys, startDate, endDate] : [ownerId, startDate, endDate];
  const result = new Map();
  const entry = (key) => {
    const id = key.slice("channel:".length);
    if (!result.has(id)) result.set(id, { metrics: null, coveredDays: 0, daysWithRows: 0, monetaryDays: 0, firstDay: null, lastDay: null, rows: [] });
    return result.get(id);
  };
  for (const row of db.prepare(`SELECT entity_key,COUNT(*) AS n FROM analytic_day_coverage WHERE owner_id=? AND ${scope} AND kind='facts' AND day BETWEEN ? AND ? GROUP BY entity_key`).all(...args)) entry(row.entity_key).coveredDays = row.n;
  for (const row of db.prepare(`SELECT entity_key,day,metrics_json,monetary FROM analytic_daily_facts WHERE owner_id=? AND ${scope} AND day BETWEEN ? AND ? ORDER BY entity_key,day`).all(...args)) {
    const item = entry(row.entity_key);
    item.rows.push({ metrics: JSON.parse(row.metrics_json), monetary: row.monetary });
    item.daysWithRows += 1; if (row.monetary) item.monetaryDays += 1;
    item.firstDay = item.firstDay || row.day; item.lastDay = row.day;
  }
  if (keys) for (const key of keys) entry(key);
  for (const item of result.values()) { if (item.rows.length) item.metrics = aggregate(item.rows, { canMonetary }).metrics; delete item.rows; }
  return result;
}
function readFactRows(db, { ownerId, entityKeys, startDate, endDate, canMonetary = false, limit = 100000 }) {
  const keys = [...new Set((entityKeys || []).map(String))]; keys.forEach(parseEntityKey);
  if (!keys.length) return [];
  daysBetween(startDate, endDate);
  const marks = keys.map(() => "?").join(",");
  const count = db.prepare(`SELECT COUNT(*) AS n FROM analytic_daily_facts WHERE owner_id=? AND entity_key IN (${marks}) AND day BETWEEN ? AND ?`).get(ownerId, ...keys, startDate, endDate).n;
  if (count > limit) throw errorWithStatus(`The selection contains ${count} rows; the limit is ${limit}. Shorten the range or select fewer channels.`, 413, "tooManyRows");
  return factRows(db, { ownerId, entityKeys: keys, startDate, endDate }).map((row) => ({ entityKey: row.entity_key,
    channelId: row.entity_key.startsWith("channel:") ? row.entity_key.slice("channel:".length) : null, day: row.day,
    metrics: stripMonetary(row.metrics, canMonetary), monetary: !!row.monetary, revision: row.revision, source: row.source, firstSyncedAt: row.first_synced_at, lastSyncedAt: row.last_synced_at }));
}

// Ledger entries for non-monetary readers lose monetary keys; entries that become empty are dropped.
function stripDiff(entry, canMonetary) {
  const keep = (key) => canMonetary || !MONETARY_KEYS.has(key);
  const pick = (object) => Object.fromEntries(Object.entries(object || {}).filter(([key]) => keep(key)));
  const pairs = (object) => Object.entries(object || {}).filter(([key]) => keep(key)).map(([key, [before, after]]) => ({ key, before, after }));
  if (entry.action === "overwrite" && !entry.dimension) {
    const changedKeys = Object.entries(entry.next).filter(([key]) => keep(key)).map(([key, after]) => ({ key, before: entry.previous?.[key] ?? null, after }));
    return changedKeys.length ? { ...entry, previous: pick(entry.previous), next: pick(entry.next), changedKeys } : null;
  }
  if (entry.action === "drift" && !entry.dimension) {
    const changedKeys = pairs(entry.next);
    return changedKeys.length ? { ...entry, previous: pick(entry.previous), next: Object.fromEntries(changedKeys.map((c) => [c.key, [c.before, c.after]])), changedKeys } : null;
  }
  if (entry.action === "drift") {
    const changed = Object.fromEntries(Object.entries(entry.next.changed || {}).map(([value, diff]) => [value, Object.fromEntries(Object.entries(diff).filter(([key]) => keep(key)))]).filter(([, diff]) => Object.keys(diff).length));
    const next = { added: entry.next.added || [], changed, missing: entry.next.missing || [] };
    const changedKeys = Object.entries(changed).flatMap(([value, diff]) => Object.entries(diff).map(([key, [before, after]]) => ({ key, value, before, after })));
    if (!next.added.length && !next.missing.length && !changedKeys.length) return null;
    return { ...entry, previous: (entry.previous || []).map((row) => ({ ...row, metrics: pick(row.metrics) })), next, changedKeys };
  }
  // Breakdown overwrite: previous/next are whole row sets; changedKeys lists every (value, key) whose number differs, with null for a side that lacks it.
  const rowsOf = (list) => (Array.isArray(list) ? list : []).map((row) => ({ ...row, metrics: pick(row.metrics) }));
  const previous = rowsOf(entry.previous); const next = rowsOf(entry.next);
  const was = new Map(previous.map((row) => [row.value, row.metrics])); const is = new Map(next.map((row) => [row.value, row.metrics]));
  const changedKeys = [];
  for (const value of [...new Set([...was.keys(), ...is.keys()])].sort()) {
    const before = was.get(value) || {}; const after = is.get(value) || {};
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) if (before[key] !== after[key]) changedKeys.push({ key, value, before: before[key] ?? null, after: after[key] ?? null });
  }
  if (!canMonetary && !changedKeys.length) return null;
  return { ...entry, previous, next, changedKeys };
}
// Non-monetary readers are filtered at SQL level (monetary_only=0, no adType), so `limit`, `total` and `nextBefore` are exact for them too.
function history(db, { ownerId, entityKey: key = null, day = null, startDate = null, endDate = null, limit = 100, canMonetary = false, before = null }) {
  if (key) parseEntityKey(key);
  const clauses = ["owner_id=?"]; const args = [ownerId];
  if (key) { clauses.push("entity_key=?"); args.push(key); }
  if (day) { clauses.push("day=?"); args.push(dayString(day)); }
  if (startDate && endDate && dayString(startDate, "startDate") > dayString(endDate, "endDate")) throw errorWithStatus("startDate must not be after endDate.");
  if (startDate) { clauses.push("day>=?"); args.push(dayString(startDate, "startDate")); }
  if (endDate) { clauses.push("day<=?"); args.push(dayString(endDate, "endDate")); }
  if (before) { clauses.push("id<?"); args.push(Number(before)); }
  if (!canMonetary) clauses.push("dimension<>'adType'", "monetary_only=0");
  const where = clauses.join(" AND "); const pageSize = Math.min(1000, Math.max(1, Number(limit) || 100));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM analytic_daily_history WHERE ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM analytic_daily_history WHERE ${where} ORDER BY id DESC LIMIT ?`).all(...args, pageSize);
  const entries = rows.map((row) => stripDiff({ id: row.id, ownerId: row.owner_id, entityKey: row.entity_key, day: row.day, dimension: row.dimension, dimensionValue: row.dimension_value,
    action: row.action, previous: JSON.parse(row.previous_json), next: JSON.parse(row.new_json), jobId: row.job_id, recordedAt: row.recorded_at }, canMonetary)).filter(Boolean);
  return { entries, total, nextBefore: rows.length === pageSize ? rows[rows.length - 1].id : null };
}
function overwriteRetentionDays() {
  const days = Number(process.env.ANALYTICS_HISTORY_OVERWRITE_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : OVERWRITE_RETENTION_DAYS_DEFAULT;
}
// Drift rows older than 180 days (or `before`) and overwrite rows older than ANALYTICS_HISTORY_OVERWRITE_DAYS (default 365) are removed.
function pruneHistory(db, { before, now } = {}) {
  const at = instant(now);
  const cutoff = before ? instant(before) : new Date(Date.parse(at) - HISTORY_RETENTION_DAYS * DAY).toISOString();
  const overwriteCutoff = new Date(Date.parse(at) - overwriteRetentionDays() * DAY).toISOString();
  return db.prepare("DELETE FROM analytic_daily_history WHERE action='drift' AND recorded_at<?").run(cutoff).changes
    + db.prepare("DELETE FROM analytic_daily_history WHERE action='overwrite' AND recorded_at<?").run(overwriteCutoff).changes;
}

function normalizeTimestamp(value) {
  const text = String(value || "").trim();
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}Z` : text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : text;
}
function migrateSnapshotsToFacts(db, { now } = {}) {
  const at = instant(now);
  // Opt-out for operators who rolled the migrated facts back: nothing is read or written and no meta row is created.
  if (process.env.ANALYTICS_SKIP_SNAPSHOT_MIGRATION === "1") return { skipped: true, reason: "ANALYTICS_SKIP_SNAPSHOT_MIGRATION=1" };
  const existing = db.prepare("SELECT value FROM analytic_meta WHERE key=?").get(MIGRATION_META_KEY);
  if (existing && process.env.ANALYTICS_RERUN_SNAPSHOT_MIGRATION !== "1") return { ...JSON.parse(existing.value), skipped: true };
  const snapshots = db.prepare("SELECT owner_id,report_id,selection_json,rows_json,coverage_json,updated_at FROM analytic_snapshots WHERE report_id IN ('daily','monetaryDaily')").all()
    .map((row) => { try { return { ...row, selection: JSON.parse(row.selection_json), rows: JSON.parse(row.rows_json), coverage: JSON.parse(row.coverage_json || "{}"), at: normalizeTimestamp(row.updated_at) }; } catch { return null; } })
    .filter((snapshot) => snapshot && Array.isArray(snapshot.rows) && snapshot.selection && !snapshot.selection.videoId && !snapshot.selection.country && snapshot.selection.includeHistoricalChannelData !== true)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const result = { done: true, at, facts: 0, coverage: 0 };
  db.transaction(() => {
    const facts = new Map();
    for (const snapshot of snapshots) {
      let key;
      try { key = entityKey({ scope: snapshot.selection.scope, channelId: snapshot.selection.channelId || "" }); } catch { continue; }
      const limit = snapshot.coverage?.availableEndDate || null;
      for (const row of snapshot.rows) {
        if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.day))) continue;
        const { day, ...rest } = row;
        const metrics = normalizeMetrics(rest);
        if (!Object.keys(metrics).length) continue;
        const id = `${snapshot.owner_id}\n${key}\n${day}`;
        if (!facts.has(id)) facts.set(id, { ownerId: snapshot.owner_id, entityKey: key, day, metrics: {}, first: snapshot.at, last: snapshot.at, monetary: false, covered: false });
        const fact = facts.get(id);
        // Newest snapshot first: a key already present wins, older snapshots only fill gaps.
        for (const [metricKey, value] of Object.entries(metrics)) if (!(metricKey in fact.metrics)) fact.metrics[metricKey] = value;
        if (snapshot.at < fact.first) fact.first = snapshot.at;
        if (!limit || day <= limit) { fact.covered = true; if (snapshot.report_id === "monetaryDaily") fact.monetary = true; }
      }
    }
    const select = db.prepare("SELECT metrics_json FROM analytic_daily_facts WHERE owner_id=? AND entity_key=? AND day=?");
    const insert = db.prepare(`INSERT INTO analytic_daily_facts(owner_id,entity_key,day,metrics_json,monetary,currency,revision,source,job_id,first_synced_at,last_synced_at,last_changed_at)
      VALUES(?,?,?,?,?,'USD',1,'migration',NULL,?,?,?)`);
    const fill = db.prepare("UPDATE analytic_daily_facts SET metrics_json=?,monetary=? WHERE owner_id=? AND entity_key=? AND day=?");
    const cover = db.prepare(`INSERT INTO analytic_day_coverage(owner_id,entity_key,day,kind,monetary,job_id,synced_at) VALUES(?,?,?,'facts',?,NULL,?)
      ON CONFLICT(owner_id,entity_key,day,kind) DO UPDATE SET monetary=MAX(monetary,excluded.monetary)`);
    for (const fact of facts.values()) {
      const metrics = normalizeMetrics(fact.metrics);
      const stored = select.get(fact.ownerId, fact.entityKey, fact.day);
      if (!stored) { insert.run(fact.ownerId, fact.entityKey, fact.day, JSON.stringify(metrics), hasMonetary(metrics) ? 1 : 0, fact.first, fact.last, fact.last); result.facts += 1; }
      else {
        const previous = JSON.parse(stored.metrics_json); const merged = normalizeMetrics({ ...metrics, ...previous });
        if (Object.keys(merged).length !== Object.keys(previous).length) fill.run(JSON.stringify(merged), hasMonetary(merged) ? 1 : 0, fact.ownerId, fact.entityKey, fact.day);
      }
      if (fact.covered) { cover.run(fact.ownerId, fact.entityKey, fact.day, fact.monetary ? 1 : 0, fact.last); result.coverage += 1; }
    }
    db.prepare("INSERT INTO analytic_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(MIGRATION_META_KEY, JSON.stringify(result), at);
  })();
  return result;
}

function csvCell(value) {
  if (value == null) return '""';
  if (typeof value === "number") return `"${Number.isFinite(value) ? value : ""}"`;
  if (value instanceof Date) return `"${value.toISOString()}"`;
  let text = typeof value === "object" ? "" : String(value);
  if (/^[\s﻿]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function buildCsv({ columns = [], rows = [] }) {
  const lines = [columns.map((column) => csvCell(column.label ?? column.key)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row?.[column.key])).join(","));
  return `﻿${lines.join("\r\n")}`;
}
const NUMBER_FORMATS = { int: "#,##0", float: "#,##0.00", money: '"$"#,##0.00', percent: "0.0%" };
const NUMERIC_TYPES = new Set(Object.keys(NUMBER_FORMATS));
function sheetName(name, used) {
  const base = String(name || "Sheet").replace(/[\\/*?:[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) { const suffix = ` (${n})`; candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`; }
  used.add(candidate.toLowerCase());
  return candidate;
}
// Every cell is a primitive: strings stay strings (never formulas, hyperlinks or rich text), numbers are numbers.
function workbookValue(value, type) {
  if (NUMERIC_TYPES.has(type)) {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return Number.isFinite(number) ? (type === "percent" ? number / 100 : number) : null;
  }
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return typeof value === "object" ? "" : String(value);
}
function buildWorkbook({ sheets = [], meta = null } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ANS Network"; workbook.created = meta?.generatedAt ? new Date(meta.generatedAt) : new Date();
  const used = new Set();
  const header = { font: { bold: true }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF1FB" } } };
  if (meta) {
    const summary = workbook.addWorksheet(sheetName("Summary", used), { views: [{ state: "frozen", ySplit: 1 }] });
    summary.columns = [{ header: "Field", key: "field", width: 24 }, { header: "Value", key: "value", width: 80 }];
    summary.getRow(1).font = header.font; summary.getRow(1).fill = header.fill;
    const lines = [["Title", meta.title], ["Content Owner", meta.ownerId], ["Range", meta.range], ["Generated at", meta.generatedAt], ["Language", meta.language],
      ...(meta.notes || []).map((note, index) => [index ? "" : "Notes", note])];
    for (const [field, value] of lines) {
      const row = summary.addRow([workbookValue(field, "text"), workbookValue(value, "text")]);
      row.getCell(1).numFmt = "@"; row.getCell(2).numFmt = "@";
    }
  }
  for (const sheet of sheets) {
    const columns = sheet.columns || [];
    const ws = workbook.addWorksheet(sheetName(sheet.name, used), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = columns.map((column) => ({ header: workbookValue(column.label ?? column.key, "text"), key: column.key, ...(column.width ? { width: column.width } : {}) }));
    ws.getRow(1).font = header.font; ws.getRow(1).fill = header.fill;
    const widths = columns.map((column) => String(column.label ?? column.key).length);
    const append = (source, bold) => {
      const row = ws.addRow(columns.map((column) => workbookValue(source?.[column.key], column.type || "text")));
      columns.forEach((column, index) => {
        const cell = row.getCell(index + 1); const type = column.type || "text";
        cell.numFmt = NUMBER_FORMATS[type] || "@";
        if (!column.width) widths[index] = Math.max(widths[index], String(cell.value ?? "").length);
      });
      if (bold) row.font = { bold: true };
    };
    for (const row of sheet.rows || []) append(row, false);
    if (sheet.totals) append(sheet.totals, true);
    columns.forEach((column, index) => { if (!column.width) ws.getColumn(index + 1).width = Math.min(60, Math.max(10, widths[index] + 2)); });
  }
  return workbook;
}

module.exports = { ensureWarehouseSchema, METRIC_REGISTRY, MONETARY_KEYS, stripMonetary, entityKey, parseEntityKey, isOwnerKey, writeFacts, writeBreakdowns,
  markCoverage, coverage, missingDays, readSeries, summarize, compareSummaries, previousRange, readBreakdown, readChannelTotals, readFactRows, history, pruneHistory,
  migrateSnapshotsToFacts, latestCoveredDay, buildCsv, csvCell, buildWorkbook, normalizeMetrics, daysBetween, addDays, normalizeTimestamp };
