const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// Analytics owns its persistence. The Report database is used only by the credential bridge.
const analyticsPath = process.env.ANALYTICS_DB_PATH
  ? path.resolve(process.env.ANALYTICS_DB_PATH)
  : path.join(__dirname, "../../data/analytics.sqlite");
const reportPath = path.resolve(__dirname, "../../data/database.sqlite");
const canonical = (file) => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
const sameExistingFile = fs.existsSync(analyticsPath) && fs.existsSync(reportPath)
  && fs.statSync(analyticsPath).dev === fs.statSync(reportPath).dev
  && fs.statSync(analyticsPath).ino === fs.statSync(reportPath).ino;
if (canonical(analyticsPath).toLowerCase() === canonical(reportPath).toLowerCase() || sameExistingFile) {
  throw new Error("ANALYTICS_DB_PATH must be different from the Report database.");
}
fs.mkdirSync(path.dirname(analyticsPath), { recursive: true });
const db = new Database(analyticsPath);
if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('networks','channel_revenues','report_imports')").get()) {
  db.close();
  throw new Error("Analytics cannot use a database containing Report tables.");
}
db.analyticsPath = analyticsPath;
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS analytic_owners (
    owner_id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_network_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS analytic_channels (
    owner_id TEXT NOT NULL, channel_id TEXT NOT NULL, title TEXT NOT NULL, thumbnail TEXT,
    description TEXT, country TEXT, published_at TEXT, subscriber_count INTEGER,
    view_count INTEGER, video_count INTEGER, metadata_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(owner_id, channel_id)
  );
  CREATE TABLE IF NOT EXISTS analytic_videos (
    owner_id TEXT NOT NULL, video_id TEXT NOT NULL, channel_id TEXT, title TEXT NOT NULL,
    thumbnail TEXT, duration TEXT, published_at TEXT, metadata_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(owner_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS analytic_snapshots (
    snapshot_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, report_id TEXT NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, selection_json TEXT NOT NULL,
    query_json TEXT NOT NULL, headers_json TEXT NOT NULL, rows_json TEXT NOT NULL,
    coverage_json TEXT NOT NULL, monetary INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS analytic_snapshot_owner ON analytic_snapshots(owner_id, start_date, end_date);
  CREATE TABLE IF NOT EXISTS analytic_attempts (
    snapshot_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, report_id TEXT NOT NULL,
    status TEXT NOT NULL, error_json TEXT, attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS analytic_jobs (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_json TEXT NOT NULL,
    status TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
    current_report TEXT, errors_json TEXT NOT NULL DEFAULT '[]', result_json TEXT,
    created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancel_requested INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS analytic_jobs_owner ON analytic_jobs(owner_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS analytic_schedules (
    owner_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, lookback_days INTEGER NOT NULL DEFAULT 7,
    scope TEXT NOT NULL DEFAULT 'claimed', monetary INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER, next_run_at TEXT, last_run_at TEXT, last_job_id TEXT,
    times_json TEXT NOT NULL DEFAULT '["09:00"]', timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    last_scheduled_for TEXT, last_error TEXT, last_error_at TEXT, retry_at TEXT,
    schedule_version INTEGER NOT NULL DEFAULT 3,
    lag_days INTEGER NOT NULL DEFAULT 3, channel_mode TEXT NOT NULL DEFAULT 'all', channel_ids_json TEXT NOT NULL DEFAULT '[]',
    scopes_json TEXT NOT NULL DEFAULT '["claimed"]', include_breakdowns INTEGER NOT NULL DEFAULT 1, include_snapshots INTEGER NOT NULL DEFAULT 1,
    refresh_provisional INTEGER NOT NULL DEFAULT 0, settle_days INTEGER NOT NULL DEFAULT 7,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS analytic_schedule_runs (
    owner_id TEXT NOT NULL, scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    job_id TEXT, error_json TEXT, retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(owner_id, scheduled_for),
    FOREIGN KEY(owner_id) REFERENCES analytic_schedules(owner_id) ON DELETE CASCADE
  );
`);
require("../services/analyticsWarehouse").ensureWarehouseSchema(db);
// Upgrade existing daily interval schedules once. Subsequent starts preserve the
// stored slot so the worker can catch up the most recent missed occurrence.
const scheduleColumns = new Set(db.prepare("PRAGMA table_info(analytic_schedules)").all().map((column) => column.name));
const scheduleAdditions = {
  times_json: "TEXT NOT NULL DEFAULT '[\"08:00\",\"14:00\"]'", timezone: "TEXT NOT NULL DEFAULT 'Asia/Bangkok'",
  last_scheduled_for: "TEXT", last_error: "TEXT", last_error_at: "TEXT", retry_at: "TEXT",
  schedule_version: "INTEGER NOT NULL DEFAULT 1"
};
db.transaction(() => {
  for (const [column, definition] of Object.entries(scheduleAdditions)) {
    if (!scheduleColumns.has(column)) db.exec(`ALTER TABLE analytic_schedules ADD COLUMN ${column} ${definition}`);
  }
  const { nextSlot } = require("../services/analyticsScheduleService");
  db.prepare("UPDATE analytic_schedules SET schedule_version=2,next_run_at=CASE WHEN enabled=1 THEN ? ELSE NULL END WHERE schedule_version<2")
    .run(nextSlot(new Date()));
})();
// Schedule v3 (09:00 daily, lag/watermark, scopes, channel tracking, breakdown/snapshot switches, provisional refresh).
// The row upgrade runs once, guarded by analytic_meta['migration:schedule-v3'].
const scheduleV3Additions = {
  lag_days: "INTEGER NOT NULL DEFAULT 3", channel_mode: "TEXT NOT NULL DEFAULT 'all'", channel_ids_json: "TEXT NOT NULL DEFAULT '[]'",
  scopes_json: "TEXT NOT NULL DEFAULT '[\"claimed\"]'", include_breakdowns: "INTEGER NOT NULL DEFAULT 1", include_snapshots: "INTEGER NOT NULL DEFAULT 1",
  refresh_provisional: "INTEGER NOT NULL DEFAULT 0", settle_days: "INTEGER NOT NULL DEFAULT 7"
};
db.transaction(() => {
  const current = new Set(db.prepare("PRAGMA table_info(analytic_schedules)").all().map((column) => column.name));
  for (const [column, definition] of Object.entries(scheduleV3Additions)) {
    if (!current.has(column)) db.exec(`ALTER TABLE analytic_schedules ADD COLUMN ${column} ${definition}`);
  }
  require("../services/analyticsScheduleService").migrateToV3(db);
})();
module.exports = db;
