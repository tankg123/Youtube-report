const crypto = require("node:crypto");
const { setImmediate: nextTick } = require("node:timers/promises");
const axios = require("axios");

const REPORTING_API = "https://youtubereporting.googleapis.com/v1";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_COLUMNS = 1024;
const MAX_CELL_LENGTH = 4 * 1024 * 1024;

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function identifier(value, label = "ID") {
  const result = String(value ?? "").trim();
  if (!result || result.length > 200 || /[\x00-\x1f\x7f]/.test(result)) throw failure(`${label} không hợp lệ.`);
  return result;
}

// A download URL is supplied by Google, never by a browser. Redirects are deliberately
// disabled: bearer credentials must not be forwarded to a different origin.
function validateDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure("Google trả về địa chỉ tải báo cáo không hợp lệ.", 502); }
  const allowed = new Set(["youtubereporting.googleapis.com", "www.googleapis.com"]);
  if (url.protocol !== "https:" || !allowed.has(url.hostname) || url.username || url.password || url.port || url.hash ||
      !/^\/(?:v1\/media\/|download\/youtube\/reporting\/v1\/|youtube\/reporting\/v1\/media\/)/.test(url.pathname)) {
    throw failure("Địa chỉ tải báo cáo không thuộc YouTube Reporting API.", 502);
  }
  return url.toString();
}

// RFC 4180 parser, including quoted commas, escaped quotes, CRLF and multiline
// fields. Yielding rows prevents a second in-memory copy of the complete CSV.
function* csvRecords(text) {
  let field = "", row = [], quoted = false, closedQuote = false;
  let started = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const c = text[i];
    started = true;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else { quoted = false; closedQuote = true; }
      } else field += c;
    } else if (c === '"') {
      if (field || closedQuote) throw failure("CSV không hợp lệ: dấu ngoặc kép trong ô chưa được escape.", 422);
      quoted = true;
    } else if (c === ",") {
      row.push(field); field = ""; closedQuote = false;
      if (row.length > MAX_COLUMNS) throw failure("Báo cáo vượt giới hạn số cột.", 413);
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      if (!(row.length === 1 && row[0] === "" && !closedQuote)) yield row;
      row = []; field = ""; closedQuote = false; started = false;
      if (c === "\r" && text[i + 1] === "\n") i += 1;
    } else {
      if (closedQuote) throw failure("CSV không hợp lệ: ký tự sau ô có ngoặc kép.", 422);
      field += c;
    }
    if (field.length > MAX_CELL_LENGTH) throw failure("Một ô CSV vượt giới hạn 4 MiB.", 413);
  }
  if (quoted) throw failure("CSV không hợp lệ: ô có ngoặc kép chưa kết thúc.", 422);
  if (started || field || row.length) { row.push(field); yield row; }
}

function csvCell(value) {
  let text = String(value ?? "");
  // Google may return user-provided titles/search terms. Neutralize spreadsheet
  // formulas in exported copies while the original downloaded CSV stays intact.
  if (/^[\s\uFEFF]*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text.trim())) text = `'${text}`;
  if (/^[\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function publicError(error) {
  const remote = error?.response?.data;
  const message = remote && !Buffer.isBuffer(remote) && typeof remote === "object"
    ? remote.error?.message || remote.error_description : null;
  const status = Number(error?.status || error?.response?.status) || 502;
  const raw = message || (error?.response || error?.request ? "Không thể đọc YouTube Reporting API. Kiểm tra quyền CMS, trạng thái API và thử lại." : error?.message);
  return { status: status >= 400 && status <= 599 ? status : 502,
    message: String(raw || "Đồng bộ Reporting API thất bại.").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1200) };
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytic_bulk_types (
      owner_id TEXT NOT NULL, type_id TEXT NOT NULL, name TEXT, system_managed INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, type_id)
    );
    CREATE TABLE IF NOT EXISTS analytic_bulk_jobs (
      owner_id TEXT NOT NULL, job_id TEXT NOT NULL, type_id TEXT NOT NULL, name TEXT,
      system_managed INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_id, job_id)
    );
    CREATE TABLE IF NOT EXISTS analytic_bulk_reports (
      owner_id TEXT NOT NULL, report_id TEXT NOT NULL, job_id TEXT NOT NULL, type_id TEXT NOT NULL,
      start_time TEXT NOT NULL DEFAULT '', end_time TEXT NOT NULL DEFAULT '', create_time TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}', imported_create_time TEXT, imported_at TEXT,
      active_generation TEXT, columns_json TEXT, row_count INTEGER NOT NULL DEFAULT 0,
      byte_count INTEGER NOT NULL DEFAULT 0, sha256 TEXT, raw_csv BLOB, superseded_by TEXT,
      PRIMARY KEY(owner_id, report_id)
    );
    CREATE INDEX IF NOT EXISTS idx_analytic_bulk_reports_type ON analytic_bulk_reports(owner_id, type_id, start_time);
    CREATE INDEX IF NOT EXISTS idx_analytic_bulk_reports_period ON analytic_bulk_reports(owner_id, job_id, start_time, end_time);
    CREATE TABLE IF NOT EXISTS analytic_bulk_rows (
      owner_id TEXT NOT NULL, report_id TEXT NOT NULL, generation TEXT NOT NULL, row_number INTEGER NOT NULL,
      values_json TEXT NOT NULL, PRIMARY KEY(owner_id, report_id, generation, row_number)
    );
    CREATE TABLE IF NOT EXISTS analytic_bulk_runs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      progress_json TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_analytic_bulk_runs_owner ON analytic_bulk_runs(owner_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_analytic_bulk_runs_active ON analytic_bulk_runs(owner_id)
      WHERE status IN ('queued', 'running', 'cancelling');
  `);
}

function createAnalyticsBulkService(options = {}) {
  const db = options.db || require("../config/analyticsDatabase");
  const core = options.core || require("./analyticsService");
  const http = options.http || axios;
  const withCmsAccessToken = options.withCmsAccessToken || require("./googleContentIdService").withCmsAccessToken;
  const maxBytes = Math.max(1024, Math.min(512 * 1024 * 1024,
    Number(options.maxBytes || process.env.ANALYTICS_BULK_MAX_BYTES) || DEFAULT_MAX_BYTES));
  const active = new Map();
  schema(db);

  function recoverInterruptedRuns() {
    db.prepare(`UPDATE analytic_bulk_runs SET status='interrupted', finished_at=?, updated_at=?
      WHERE status IN ('queued','running','cancelling')`).run(new Date().toISOString(), new Date().toISOString());
    // Staged rows are never visible until their import generation is committed.
    db.prepare(`DELETE FROM analytic_bulk_rows WHERE NOT EXISTS (
      SELECT 1 FROM analytic_bulk_reports p WHERE p.owner_id=analytic_bulk_rows.owner_id
        AND p.report_id=analytic_bulk_rows.report_id AND p.active_generation=analytic_bulk_rows.generation
    )`).run();
  }
  if (options.recover !== false) recoverInterruptedRuns();

  function ownerFrom(value, { requireConnected = true } = {}) {
    const owner = core.resolveOwner(identifier(value, "Content Owner"), { requireConnected });
    if (!owner || !owner.network_code) throw failure("Không tìm thấy CMS Content Owner đã kết nối.", 404);
    return owner;
  }

  async function allPages(path, key, owner, params = {}, signal) {
    const entries = [], seen = new Set();
    let pageToken;
    do {
      if (signal?.aborted) throw failure("Đã hủy đồng bộ.", 409);
      const body = await core.googleGet(`${REPORTING_API}${path}`, {
        owner, signal, params: { ...params, onBehalfOfContentOwner: owner.network_code, pageSize: 100, ...(pageToken ? { pageToken } : {}) }
      });
      if (body[key] && !Array.isArray(body[key])) throw failure("YouTube trả về danh sách báo cáo không hợp lệ.", 502);
      entries.push(...(body[key] || []));
      pageToken = body.nextPageToken;
      if (pageToken) {
        if (seen.has(pageToken) || seen.size >= 10000) throw failure("YouTube trả về vòng lặp phân trang; chưa thể hoàn tất đồng bộ.", 502);
        seen.add(pageToken);
      }
    } while (pageToken);
    return entries;
  }

  const saveTypes = db.prepare(`INSERT INTO analytic_bulk_types(owner_id,type_id,name,system_managed,metadata_json,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,type_id) DO UPDATE SET name=excluded.name,
    system_managed=excluded.system_managed,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`);
  const saveJob = db.prepare(`INSERT INTO analytic_bulk_jobs(owner_id,job_id,type_id,name,system_managed,metadata_json,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,job_id) DO UPDATE SET type_id=excluded.type_id,name=excluded.name,
    system_managed=excluded.system_managed,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`);

  function cacheJobs(owner, jobs) {
    db.transaction(() => {
      for (const job of jobs) saveJob.run(owner.network_code, identifier(job.id), identifier(job.reportTypeId),
        job.name || job.id, Number(Boolean(job.systemManaged)), JSON.stringify(job), new Date().toISOString());
    })();
  }

  async function listJobs(owner, signal) {
    const jobs = await allPages("/jobs", "jobs", owner, { includeSystemManaged: true }, signal);
    cacheJobs(owner, jobs);
    return jobs;
  }

  function storage(ownerId) {
    return db.prepare(`SELECT COUNT(*) AS reports, COALESCE(SUM(row_count),0) AS rows,
      COALESCE(SUM(byte_count),0) AS bytes, MAX(imported_at) AS lastImportedAt
      FROM analytic_bulk_reports WHERE owner_id=? AND imported_at IS NOT NULL AND superseded_by IS NULL`).get(ownerId);
  }

  async function catalog(ownerId, { cached = false } = {}) {
    if (cached) {
      const owner = ownerFrom(ownerId, { requireConnected: false });
      const reportTypes = db.prepare("SELECT metadata_json FROM analytic_bulk_types WHERE owner_id=? ORDER BY name,type_id").all(owner.network_code).map(row => JSON.parse(row.metadata_json));
      const jobs = db.prepare("SELECT metadata_json FROM analytic_bulk_jobs WHERE owner_id=? ORDER BY name,job_id").all(owner.network_code).map(row => JSON.parse(row.metadata_json));
      // A report may have been imported directly without first caching its type.
      for (const row of db.prepare("SELECT DISTINCT type_id FROM analytic_bulk_reports WHERE owner_id=? AND imported_at IS NOT NULL").all(owner.network_code)) {
        if (!reportTypes.some(type => type.id === row.type_id)) reportTypes.push({ id: row.type_id, name: row.type_id });
      }
      return { ownerId: owner.network_code, reportTypes, jobs, storage: storage(owner.network_code), maxReportBytes: maxBytes, cached: true };
    }
    const owner = ownerFrom(ownerId);
    const [reportTypes, jobs] = await Promise.all([
      allPages("/reportTypes", "reportTypes", owner, { includeSystemManaged: true }), listJobs(owner)
    ]);
    db.transaction(() => {
      for (const type of reportTypes) saveTypes.run(owner.network_code, identifier(type.id), type.name || type.id,
        Number(Boolean(type.systemManaged)), JSON.stringify(type), new Date().toISOString());
    })();
    return { ownerId: owner.network_code, reportTypes, jobs, storage: storage(owner.network_code), maxReportBytes: maxBytes, cached: false };
  }

  function storeReportMetadata(owner, job, report) {
    const { downloadUrl, ...metadata } = report;
    db.prepare(`INSERT INTO analytic_bulk_reports(owner_id,report_id,job_id,type_id,start_time,end_time,create_time,metadata_json)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,report_id) DO UPDATE SET job_id=excluded.job_id,
      type_id=excluded.type_id,start_time=excluded.start_time,end_time=excluded.end_time,
      create_time=excluded.create_time,metadata_json=excluded.metadata_json`).run(
      owner.network_code, identifier(report.id), job.id, job.reportTypeId, report.startTime || "", report.endTime || "",
      report.createTime || "", JSON.stringify(metadata));
  }

  async function reportsForJob(owner, job, signal) {
    const reports = await allPages(`/jobs/${encodeURIComponent(job.id)}/reports`, "reports", owner, {}, signal);
    db.transaction(() => { for (const report of reports) storeReportMetadata(owner, job, report); })();
    return reports;
  }

  function reportView(row) {
    return { ...JSON.parse(row.metadata_json), reportTypeId: row.type_id, imported: Boolean(row.imported_at),
      importedAt: row.imported_at, rowCount: row.row_count, byteCount: row.byte_count,
      supersededBy: row.superseded_by, columns: JSON.parse(row.columns_json || "[]") };
  }

  async function reports(ownerId, jobId) {
    const owner = ownerFrom(ownerId);
    const jobs = await listJobs(owner);
    const job = jobs.find(item => item.id === identifier(jobId, "Job"));
    if (!job) throw failure("Job không thuộc Content Owner đã chọn.", 404);
    await reportsForJob(owner, job);
    return db.prepare(`SELECT * FROM analytic_bulk_reports WHERE owner_id=? AND job_id=? ORDER BY create_time DESC,report_id`)
      .all(owner.network_code, job.id).map(reportView);
  }

  async function download(owner, urlValue, signal) {
    const url = validateDownloadUrl(urlValue);
    const response = await withCmsAccessToken(owner, async (token) => {
      checkCancelled(null, signal);
      try {
        return await http.get(url, {
          headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip", Accept: "text/csv,application/octet-stream" },
          responseType: "stream", timeout: 120000, maxRedirects: 0, signal,
          maxContentLength: maxBytes, maxBodyLength: maxBytes
        });
      } catch (error) {
        error.response?.data?.destroy?.();
        throw error;
      }
    });
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of response.data) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) throw failure(`Báo cáo vượt giới hạn ${Math.round(maxBytes / 1024 / 1024)} MiB. Tăng ANALYTICS_BULK_MAX_BYTES nếu cần.`, 413);
        chunks.push(buffer);
      }
    } catch (error) {
      response.data.destroy?.();
      throw error;
    }
    const type = String(response.headers?.["content-type"] || "");
    const buffer = Buffer.concat(chunks, bytes);
    if (/html|json/i.test(type) || /^\s*(?:<!doctype|<html|\{\s*"error")/i.test(buffer.subarray(0, 200).toString("utf8"))) {
      throw failure("Google không trả về CSV cho báo cáo này.", 502);
    }
    return buffer;
  }

  function checkCancelled(runId, signal) {
    if (signal?.aborted || (runId && db.prepare("SELECT cancel_requested FROM analytic_bulk_runs WHERE id=?").get(runId)?.cancel_requested)) {
      throw Object.assign(failure("Đã hủy đồng bộ.", 409), { cancelled: true });
    }
  }

  async function importCsv(ownerId, job, report, buffer, { runId, signal } = {}) {
    const owner = typeof ownerId === "object" ? ownerId : ownerFrom(ownerId);
    const csv = buffer.toString("utf8");
    const iterator = csvRecords(csv);
    const first = iterator.next();
    if (first.done) throw failure("Báo cáo CSV thiếu hàng tiêu đề.", 422);
    const columns = first.value;
    if (!columns.length || columns.some(column => !column) || new Set(columns).size !== columns.length || columns.length > MAX_COLUMNS) {
      throw failure("Báo cáo CSV có tên cột rỗng, trùng lặp hoặc vượt giới hạn.", 422);
    }
    const generation = crypto.randomUUID();
    const insert = db.prepare("INSERT INTO analytic_bulk_rows(owner_id,report_id,generation,row_number,values_json) VALUES(?,?,?,?,?)");
    const batchInsert = db.transaction(batch => {
      for (const [rowNumber, values] of batch) insert.run(owner.network_code, report.id, generation, rowNumber, JSON.stringify(values));
    });
    let count = 0, batch = [];
    try {
      for (const values of iterator) {
        if (values.length !== columns.length) throw failure(`CSV hàng ${count + 2} có ${values.length} ô, cần ${columns.length} ô.`, 422);
        count += 1;
        batch.push([count, values]);
        if (batch.length >= 1000) {
          checkCancelled(runId, signal); batchInsert(batch); batch = [];
          await nextTick();
        }
      }
      checkCancelled(runId, signal);
      if (batch.length) batchInsert(batch);
      const now = new Date().toISOString();
      db.transaction(() => {
        storeReportMetadata(owner, job, report);
        db.prepare(`UPDATE analytic_bulk_reports SET imported_create_time=?,imported_at=?,active_generation=?,
          columns_json=?,row_count=?,byte_count=?,sha256=?,raw_csv=? WHERE owner_id=? AND report_id=?`).run(
          report.createTime || "", now, generation, JSON.stringify(columns), count, buffer.length,
          crypto.createHash("sha256").update(buffer).digest("hex"), buffer, owner.network_code, report.id);
        db.prepare("DELETE FROM analytic_bulk_rows WHERE owner_id=? AND report_id=? AND generation<>?").run(owner.network_code, report.id, generation);
        // Backfills have a NEW ID but the same interval. Only the newest complete
        // import becomes visible. Retain originals for audit and individual export.
        if (report.startTime) {
          const latest = db.prepare(`SELECT report_id FROM analytic_bulk_reports WHERE owner_id=? AND job_id=?
            AND start_time=? AND end_time=? AND imported_at IS NOT NULL ORDER BY imported_create_time DESC,report_id DESC LIMIT 1`)
            .get(owner.network_code, job.id, report.startTime, report.endTime || "");
          db.prepare(`UPDATE analytic_bulk_reports SET superseded_by=CASE WHEN report_id=? THEN NULL ELSE ? END
            WHERE owner_id=? AND job_id=? AND start_time=? AND end_time=? AND imported_at IS NOT NULL`)
            .run(latest.report_id, latest.report_id, owner.network_code, job.id, report.startTime, report.endTime || "");
        }
      })();
      return { rows: count, bytes: buffer.length, columns };
    } catch (error) {
      db.prepare("DELETE FROM analytic_bulk_rows WHERE owner_id=? AND report_id=? AND generation=?").run(owner.network_code, report.id, generation);
      throw error;
    }
  }

  function getRun(id) {
    const row = db.prepare("SELECT * FROM analytic_bulk_runs WHERE id=?").get(identifier(id, "Run"));
    if (!row) throw failure("Không tìm thấy tiến trình Reporting API.", 404);
    return { ...JSON.parse(row.progress_json), id: row.id, ownerId: row.owner_id, kind: row.kind, status: row.status,
      cancelRequested: Boolean(row.cancel_requested), createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at };
  }

  function updateRun(id, changes = {}, status) {
    const run = getRun(id);
    db.prepare(`UPDATE analytic_bulk_runs SET progress_json=?,status=?,updated_at=?,finished_at=? WHERE id=?`).run(
      JSON.stringify({ ...run, ...changes }), status || run.status, new Date().toISOString(),
      status && !["queued", "running", "cancelling"].includes(status) ? new Date().toISOString() : null, id);
    return getRun(id);
  }

  function createRun(owner, kind, actorId) {
    const previous = db.prepare("SELECT id FROM analytic_bulk_runs WHERE owner_id=? AND status IN ('queued','running','cancelling')").get(owner.network_code);
    if (previous) throw Object.assign(failure("Content Owner đang có một tiến trình Reporting API. Chờ hoàn tất hoặc hủy tiến trình hiện tại.", 409), { runId: previous.id });
    const id = crypto.randomUUID(), now = new Date().toISOString();
    db.prepare(`INSERT INTO analytic_bulk_runs(id,owner_id,kind,status,progress_json,created_by,created_at,updated_at)
      VALUES(?,?,?,'queued',?,?,?,?)`).run(id, owner.network_code, kind,
      JSON.stringify({ totalReports: 0, importedReports: 0, skippedReports: 0, failedReports: 0, rowsImported: 0,
        totalJobs: 0, completedJobs: 0, failedJobs: 0, createdJobs: 0, existingJobs: 0, errors: [] }), actorId || null, now, now);
    return getRun(id);
  }

  function background(run, execute) {
    const controller = new AbortController();
    active.set(run.id, controller);
    setImmediate(async () => {
      try {
        checkCancelled(run.id, controller.signal);
        updateRun(run.id, {}, "running");
        await execute(controller.signal);
        checkCancelled(run.id, controller.signal);
        const progress = getRun(run.id);
        updateRun(run.id, { currentReport: null, currentJob: null }, progress.errors.length ? "partial" : "completed");
      } catch (error) {
        const cancelled = error.cancelled || controller.signal.aborted;
        updateRun(run.id, { error: cancelled ? "Đã hủy đồng bộ." : publicError(error).message }, cancelled ? "cancelled" : "failed");
      } finally { active.delete(run.id); }
    });
    return run;
  }

  function addRunError(id, error, context = {}) {
    const run = getRun(id);
    // Keep progress compact even if an owner has thousands of expired reports.
    updateRun(id, { errors: [...run.errors.slice(-199), { ...context, ...publicError(error) }],
      failedReports: run.failedReports + (context.reportId ? 1 : 0),
      failedJobs: (run.failedJobs || 0) + (context.reportId ? 0 : 1) });
  }

  function selectedIds(value, label) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 500) throw failure(`${label} phải là danh sách tối đa 500 ID.`);
    return [...new Set(value.map(item => identifier(item, label)))];
  }

  function startSync({ ownerId, jobIds, actorId }) {
    const owner = ownerFrom(ownerId), selection = selectedIds(jobIds, "Job");
    const run = createRun(owner, "sync", actorId);
    return background(run, async signal => {
      let jobs = await listJobs(owner, signal);
      if (selection.length) {
        if (selection.some(id => !jobs.some(job => job.id === id))) throw failure("Một Job không thuộc Content Owner đã chọn.", 404);
        jobs = jobs.filter(job => selection.includes(job.id));
      }
      updateRun(run.id, { totalJobs: jobs.length });
      for (const job of jobs) {
        checkCancelled(run.id, signal);
        updateRun(run.id, { currentJob: job.name || job.id });
        let reportList;
        try { reportList = await reportsForJob(owner, job, signal); }
        catch (error) {
          if (signal.aborted) throw error;
          addRunError(run.id, error, { jobId: job.id });
          updateRun(run.id, { completedJobs: getRun(run.id).completedJobs + 1 });
          continue;
        }
        // Import newest backfills first and skip earlier reports for an identical
        // interval. All API pages were read before this selection is made.
        reportList.sort((a, b) => String(b.createTime || "").localeCompare(String(a.createTime || "")) || String(b.id).localeCompare(String(a.id)));
        const periods = new Set();
        updateRun(run.id, { totalReports: getRun(run.id).totalReports + reportList.length });
        for (const report of reportList) {
          checkCancelled(run.id, signal);
          const period = report.startTime ? `${report.startTime}/${report.endTime || ""}` : report.id;
          const stored = db.prepare("SELECT imported_at,imported_create_time FROM analytic_bulk_reports WHERE owner_id=? AND report_id=?").get(owner.network_code, report.id);
          const newer = report.startTime && db.prepare(`SELECT report_id FROM analytic_bulk_reports WHERE owner_id=? AND job_id=?
            AND start_time=? AND end_time=? AND imported_at IS NOT NULL AND imported_create_time>? LIMIT 1`)
            .get(owner.network_code, job.id, report.startTime, report.endTime || "", report.createTime || "");
          if (periods.has(period) || newer || (stored?.imported_at && stored.imported_create_time === (report.createTime || ""))) {
            updateRun(run.id, { skippedReports: getRun(run.id).skippedReports + 1 });
            periods.add(period); continue;
          }
          updateRun(run.id, { currentReport: report.id });
          try {
            const buffer = await download(owner, report.downloadUrl, signal);
            const result = await importCsv(owner, job, report, buffer, { runId: run.id, signal });
            const progress = getRun(run.id);
            updateRun(run.id, { importedReports: progress.importedReports + 1, rowsImported: progress.rowsImported + result.rows });
            periods.add(period);
          } catch (error) { if (signal.aborted || error.cancelled) throw error; addRunError(run.id, error, { jobId: job.id, reportId: report.id }); }
        }
        updateRun(run.id, { completedJobs: getRun(run.id).completedJobs + 1 });
      }
    });
  }

  function startCreateJobs({ ownerId, reportTypeIds, all = false, actorId }) {
    const owner = ownerFrom(ownerId), selection = selectedIds(reportTypeIds, "Report Type");
    if (!selection.length && all !== true) throw failure("Chọn ít nhất một loại báo cáo hoặc all=true.");
    const run = createRun(owner, "create_jobs", actorId);
    return background(run, async signal => {
      const [types, jobs] = await Promise.all([
        allPages("/reportTypes", "reportTypes", owner, { includeSystemManaged: true }, signal), listJobs(owner, signal)
      ]);
      const requested = all === true ? types.filter(type => !type.systemManaged && (!type.deprecateTime || Date.parse(type.deprecateTime) > Date.now())) : selection.map(id => {
        const type = types.find(item => item.id === id);
        if (!type) throw failure(`Report Type ${id} không có quyền truy cập trên CMS này.`);
        if (type.systemManaged) throw failure(`Report Type ${id} do YouTube tự quản lý; không cần tạo Job.`);
        if (type.deprecateTime && Date.parse(type.deprecateTime) <= Date.now()) throw failure(`Report Type ${id} đã ngừng cung cấp; chọn phiên bản báo cáo mới hơn.`);
        return type;
      });
      updateRun(run.id, { totalJobs: requested.length });
      let cursor = 0;
      async function worker() {
        while (cursor < requested.length) {
          const type = requested[cursor++];
          checkCancelled(run.id, signal);
          try {
            const existing = jobs.find(job => job.reportTypeId === type.id && (!job.expireTime || Date.parse(job.expireTime) > Date.now()));
            if (existing) updateRun(run.id, { existingJobs: getRun(run.id).existingJobs + 1 });
            else {
              const response = await withCmsAccessToken(owner, (token) => {
                checkCancelled(run.id, signal);
                return http.post(`${REPORTING_API}/jobs`, { reportTypeId: type.id, name: `Analytic · ${type.name || type.id}`.slice(0, 100) }, {
                  params: { onBehalfOfContentOwner: owner.network_code }, headers: { Authorization: `Bearer ${token}` },
                  timeout: 45000, maxRedirects: 0, signal
                });
              });
              cacheJobs(owner, [response.data]); jobs.push(response.data);
              updateRun(run.id, { createdJobs: getRun(run.id).createdJobs + 1 });
            }
          } catch (error) { if (signal.aborted || error.cancelled) throw error; addRunError(run.id, error, { reportTypeId: type.id }); }
          updateRun(run.id, { completedJobs: getRun(run.id).completedJobs + 1 });
        }
      }
      // A POST with a lost reply may have created the remote job. The next run lists existing jobs.
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(3, requested.length) }, worker));
      const rejected = outcomes.find(outcome => outcome.status === "rejected");
      if (rejected) throw rejected.reason;
    });
  }

  function cancelRun(id) {
    const run = getRun(id);
    if (!["queued", "running", "cancelling"].includes(run.status)) return run;
    db.prepare("UPDATE analytic_bulk_runs SET cancel_requested=1,status='cancelling',updated_at=? WHERE id=?").run(new Date().toISOString(), run.id);
    active.get(run.id)?.abort();
    return getRun(run.id);
  }

  function listRuns(ownerId) {
    const owner = ownerFrom(ownerId, { requireConnected: false });
    return db.prepare("SELECT id FROM analytic_bulk_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 30").all(owner.network_code).map(row => getRun(row.id));
  }

  function data({ ownerId, reportTypeId, reportId, page = 1, pageSize = 50 }) {
    const owner = ownerFrom(ownerId, { requireConnected: false });
    const typeId = identifier(reportTypeId, "Report Type");
    const pageNumber = Math.max(1, Math.min(1000000, Math.floor(Number(page) || 1)));
    const limit = Math.max(1, Math.min(200, Math.floor(Number(pageSize) || 50)));
    const reportFilter = reportId ? " AND p.report_id=?" : " AND p.superseded_by IS NULL";
    const params = [owner.network_code, typeId, ...(reportId ? [identifier(reportId)] : [])];
    const reportRows = db.prepare(`SELECT p.report_id,p.metadata_json,p.type_id,p.imported_at,p.row_count,p.byte_count,p.superseded_by,p.columns_json
      FROM analytic_bulk_reports p WHERE p.owner_id=? AND p.type_id=? AND p.imported_at IS NOT NULL${reportFilter}
      ORDER BY p.start_time DESC,p.report_id`).all(...params);
    const sourceColumns = [...new Set(reportRows.flatMap(row => JSON.parse(row.columns_json || "[]")))];
    // Monthly system reports may have no date column at all. Include provenance
    // for every row so different report periods can be distinguished. Select a
    // collision-free prefix rather than overwriting any original Google column.
    const provenanceKeys = ["periodStart", "periodEnd", "reportCreatedAt", "reportId"];
    let prefix = "_";
    while (provenanceKeys.some(key => sourceColumns.includes(prefix + key))) prefix += "_";
    const provenanceColumns = Object.fromEntries(provenanceKeys.map(key => [key, prefix + key]));
    const columns = [...Object.values(provenanceColumns), ...sourceColumns];
    const total = reportRows.reduce((sum, row) => sum + row.row_count, 0);
    const rawRows = db.prepare(`SELECT r.values_json,r.report_id,p.columns_json,p.start_time,p.end_time,p.imported_create_time FROM analytic_bulk_rows r
      JOIN analytic_bulk_reports p ON p.owner_id=r.owner_id AND p.report_id=r.report_id AND p.active_generation=r.generation
      WHERE p.owner_id=? AND p.type_id=? AND p.imported_at IS NOT NULL${reportFilter}
      ORDER BY p.start_time DESC,p.report_id,r.row_number LIMIT ? OFFSET ?`).all(...params, limit, (pageNumber - 1) * limit);
    return { ownerId: owner.network_code, reportTypeId: typeId, columns, sourceColumns, provenanceColumns,
      rows: rawRows.map(row => {
        const values = JSON.parse(row.values_json);
        return { ...Object.fromEntries(JSON.parse(row.columns_json).map((column, index) => [column, values[index]])),
          [provenanceColumns.periodStart]: row.start_time, [provenanceColumns.periodEnd]: row.end_time,
          [provenanceColumns.reportCreatedAt]: row.imported_create_time, [provenanceColumns.reportId]: row.report_id };
      }),
      total, page: pageNumber, pageSize: limit, reports: reportRows.map(reportView) };
  }

  function exportCsv(ownerId, reportId) {
    const owner = ownerFrom(ownerId, { requireConnected: false });
    const report = db.prepare("SELECT * FROM analytic_bulk_reports WHERE owner_id=? AND report_id=? AND imported_at IS NOT NULL").get(owner.network_code, identifier(reportId));
    if (!report) throw failure("Báo cáo chưa được tải vào database Analytic.", 404);
    const records = csvRecords(report.raw_csv.toString("utf8"));
    const filename = `${report.type_id}_${report.report_id}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) + ".csv";
    function* chunks() { yield "\uFEFF"; for (const record of records) yield record.map(csvCell).join(",") + "\r\n"; }
    return { filename, chunks: chunks() };
  }

  return { catalog, reports, startSync, startCreateJobs, getRun, listRuns, cancelRun, data, exportCsv,
    storage, recoverInterruptedRuns, importCsv, download };
}

let singleton;
function getService() { if (!singleton) singleton = createAnalyticsBulkService(); return singleton; }

module.exports = { createAnalyticsBulkService, getService, csvRecords, csvCell, validateDownloadUrl, publicError, REPORTING_API };
