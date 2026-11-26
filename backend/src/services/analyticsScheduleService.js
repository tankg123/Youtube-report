// Bangkok has a fixed UTC+7 offset and no daylight-saving transitions. All stored
// instants are UTC; the machine's local timezone never participates in scheduling.
const DAY = 86400000;
const OFFSET = 7 * 3600000;
const TIMEZONE = "Asia/Bangkok";
const SCHEDULE_VERSION = 3;
const DEFAULT_TIMES = ["09:00"];
const LEGACY_DEFAULT_TIMES = ["08:00", "14:00"];
const RETRY_DELAYS = [60000, 300000, 900000, 1800000];
const MIGRATION_META_KEY = "migration:schedule-v3";
const SCOPES = ["claimed", "self", "thirdParty"];

function invalid(message) { const error = new Error(message); error.status = 400; return error; }
function normalizeTiming(times = DEFAULT_TIMES, timezone = TIMEZONE) {
  if (timezone !== TIMEZONE) throw invalid("Analytics schedules use Asia/Bangkok (GMT+7).");
  if (!Array.isArray(times) || !times.length || times.length > 6
    || times.some((time) => typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw invalid("times must contain between 1 and 6 daily HH:mm times in GMT+7.");
  }
  if (new Set(times).size !== times.length) throw invalid("Daily schedule times must be unique.");
  return { times: [...times].sort(), timezone: TIMEZONE };
}
function timestamp(value) {
  const result = new Date(value).getTime();
  if (!Number.isFinite(result)) throw invalid("A valid scheduling instant is required.");
  return result;
}
function slotsForDay(now, times) {
  const current = timestamp(now);
  const localMidnight = Math.floor((current + OFFSET) / DAY) * DAY - OFFSET;
  return normalizeTiming(times).times.map((time) => {
    const [hour, minute] = time.split(":").map(Number);
    return localMidnight + (hour * 60 + minute) * 60000;
  });
}
function nextSlot(now, times = DEFAULT_TIMES) {
  const current = timestamp(now); const slots = slotsForDay(current, times);
  return new Date(slots.find((slot) => slot > current) ?? slots[0] + DAY).toISOString();
}
function latestSlot(now, times = DEFAULT_TIMES) {
  const current = timestamp(now); const slots = slotsForDay(current, times);
  return new Date([...slots].reverse().find((slot) => slot <= current) ?? slots.at(-1) - DAY).toISOString();
}
// The slot before `slot` in the same daily timetable.
function previousSlot(slot, times = DEFAULT_TIMES) {
  return latestSlot(timestamp(slot) - 1, times);
}
function timingFromRow(row) {
  return normalizeTiming(JSON.parse(row.times_json || JSON.stringify(DEFAULT_TIMES)), row.timezone || TIMEZONE);
}
// One-off upgrade of version-2 rows: the legacy twice-daily default becomes the single 09:00 slot (custom times are kept),
// the deprecated single `scope` column becomes `scopes_json`, the lookback stays as saved. Guarded by analytic_meta so
// a later start preserves the stored cursor; one transaction.
function migrateToV3(db, { now = new Date() } = {}) {
  const at = new Date(timestamp(now)).toISOString();
  return db.transaction(() => {
    const existing = db.prepare("SELECT value FROM analytic_meta WHERE key=?").get(MIGRATION_META_KEY);
    if (existing) return { ...JSON.parse(existing.value), skipped: true };
    const rows = db.prepare("SELECT * FROM analytic_schedules WHERE schedule_version<?").all(SCHEDULE_VERSION);
    const update = db.prepare("UPDATE analytic_schedules SET times_json=?,scopes_json=?,schedule_version=?,next_run_at=?,updated_at=? WHERE owner_id=?");
    for (const row of rows) {
      let times;
      try { times = normalizeTiming(JSON.parse(row.times_json || "null")).times; } catch { times = [...LEGACY_DEFAULT_TIMES]; }
      if (JSON.stringify(times) === JSON.stringify(LEGACY_DEFAULT_TIMES)) times = [...DEFAULT_TIMES];
      const scopes = SCOPES.includes(row.scope) ? [row.scope] : ["claimed"];
      update.run(JSON.stringify(times), JSON.stringify(scopes), SCHEDULE_VERSION, row.enabled ? nextSlot(at, times) : null, at, row.owner_id);
    }
    const result = { done: true, at, migrated: rows.length };
    db.prepare("INSERT INTO analytic_meta(key,value,updated_at) VALUES(?,?,?)").run(MIGRATION_META_KEY, JSON.stringify(result), at);
    return result;
  })();
}

// Claim and job insertion run in one SQLite transaction. A crash cannot commit a
// slot without its queued job, and a second process cannot enqueue that slot again.
function tick(db, enqueue, { now = new Date(), safeError = (error) => ({ message: String(error.message), reason: "scheduleFailed" }) } = {}) {
  const nowAt = new Date(timestamp(now)).toISOString();
  const result = { queued: 0, failed: 0, skipped: 0 };
  const schedules = db.prepare("SELECT * FROM analytic_schedules WHERE enabled=1 ORDER BY owner_id").all();
  for (const row of schedules) {
    let timing;
    try { timing = timingFromRow(row); }
    catch (error) {
      db.prepare("UPDATE analytic_schedules SET last_error=?,last_error_at=?,retry_at=NULL WHERE owner_id=?")
        .run(safeError(error).message, nowAt, row.owner_id);
      result.failed += 1; continue;
    }
    const due = row.next_run_at && timestamp(row.next_run_at) <= timestamp(nowAt);
    const retryDue = row.retry_at && timestamp(row.retry_at) <= timestamp(nowAt);
    if (!due && !retryDue) {
      // Repair incomplete/legacy schedules without running arbitrary history.
      if (!row.next_run_at) db.prepare("UPDATE analytic_schedules SET next_run_at=? WHERE owner_id=?").run(nextSlot(nowAt, timing.times), row.owner_id);
      continue;
    }
    const scheduledFor = due ? latestSlot(nowAt, timing.times) : row.last_scheduled_for;
    if (!scheduledFor) continue;
    const outcome = db.transaction(() => {
      const schedule = db.prepare("SELECT * FROM analytic_schedules WHERE owner_id=? AND enabled=1").get(row.owner_id);
      if (!schedule) return "skipped";
      // Even a failed enqueue leaves the next regular slot anchored to GMT+7.
      db.prepare("UPDATE analytic_schedules SET next_run_at=? WHERE owner_id=?").run(nextSlot(nowAt, timing.times), row.owner_id);
      // Explicit ISO instants: the column defaults would write 'YYYY-MM-DD HH:MM:SS'.
      db.prepare(`INSERT OR IGNORE INTO analytic_schedule_runs(owner_id,scheduled_for,status,attempts,created_at,updated_at)
        VALUES(?,?,'pending',0,?,?)`).run(row.owner_id, scheduledFor, nowAt, nowAt);
      const occurrence = db.prepare("SELECT * FROM analytic_schedule_runs WHERE owner_id=? AND scheduled_for=?").get(row.owner_id, scheduledFor);
      if (occurrence.status === "queued") {
        // A stale schedule cursor (for example after a restored database) must
        // neither duplicate this job nor keep retrying an older failed slot.
        db.prepare(`UPDATE analytic_schedules SET last_scheduled_for=?,last_job_id=?,last_error=NULL,last_error_at=NULL,retry_at=NULL
          WHERE owner_id=?`).run(scheduledFor, occurrence.job_id, row.owner_id);
        return "skipped";
      }
      if (occurrence.attempts >= RETRY_DELAYS.length + 1) {
        db.prepare("UPDATE analytic_schedules SET retry_at=NULL WHERE owner_id=?").run(row.owner_id);
        return "skipped";
      }
      if (occurrence.retry_at && timestamp(occurrence.retry_at) > timestamp(nowAt)) return "skipped";
      const attempts = occurrence.attempts + 1;
      try {
        const job = db.transaction(() => enqueue(schedule, scheduledFor, nowAt))();
        if (!job?.id) throw new Error("The Analytics sync job could not be queued.");
        db.prepare(`UPDATE analytic_schedule_runs SET status='queued',attempts=?,job_id=?,error_json=NULL,retry_at=NULL,updated_at=?
          WHERE owner_id=? AND scheduled_for=?`).run(attempts, job.id, nowAt, row.owner_id, scheduledFor);
        db.prepare(`UPDATE analytic_schedules SET last_run_at=?,last_scheduled_for=?,last_job_id=?,last_error=NULL,last_error_at=NULL,retry_at=NULL
          WHERE owner_id=?`).run(nowAt, scheduledFor, job.id, row.owner_id);
        return "queued";
      } catch (error) {
        const detail = safeError(error);
        const retryAt = attempts <= RETRY_DELAYS.length ? new Date(timestamp(nowAt) + RETRY_DELAYS[attempts - 1]).toISOString() : null;
        db.prepare(`UPDATE analytic_schedule_runs SET status='failed',attempts=?,error_json=?,retry_at=?,updated_at=?
          WHERE owner_id=? AND scheduled_for=?`).run(attempts, JSON.stringify(detail), retryAt, nowAt, row.owner_id, scheduledFor);
        db.prepare("UPDATE analytic_schedules SET last_scheduled_for=?,last_error=?,last_error_at=?,retry_at=? WHERE owner_id=?")
          .run(scheduledFor, detail.message, nowAt, retryAt, row.owner_id);
        return "failed";
      }
    })();
    result[outcome] += 1;
  }
  return result;
}
// Gives a slot whose attempts were spent (or whose job failed) exactly one more attempt at `now`: the run goes back to
// `failed` with its attempt counter clamped so the retry ladder ends after this attempt, and the schedule retries immediately.
function rearmRun(db, { ownerId, scheduledFor, now, detail }) {
  const nowAt = new Date(timestamp(now)).toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE analytic_schedule_runs SET status='failed',attempts=MIN(attempts,?),error_json=?,retry_at=?,updated_at=? WHERE owner_id=? AND scheduled_for=?`)
      .run(RETRY_DELAYS.length, JSON.stringify({ ...detail, rearmedAt: nowAt }), nowAt, nowAt, ownerId, scheduledFor);
    db.prepare("UPDATE analytic_schedules SET retry_at=?,last_scheduled_for=? WHERE owner_id=?").run(nowAt, scheduledFor, ownerId);
  })();
}

module.exports = { TIMEZONE, SCHEDULE_VERSION, DEFAULT_TIMES, LEGACY_DEFAULT_TIMES, RETRY_DELAYS, MIGRATION_META_KEY, normalizeTiming, nextSlot, latestSlot, previousSlot,
  timingFromRow, migrateToV3, tick, rearmRun };
