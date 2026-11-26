const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
const Database = require("better-sqlite3");
const { createAnalyticsBulkService, csvRecords, csvCell, validateDownloadUrl, publicError } = require("../src/services/analyticsBulkService");

const OWNER = "OWNER_TEST";
const job = { id: "job-basic", reportTypeId: "content_owner_basic_a3", name: "Basic" };
const original = { id: "r-original", jobId: job.id, startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-02T00:00:00Z", createTime: "2026-10-03T00:00:00Z",
  downloadUrl: "https://youtubereporting.googleapis.com/v1/media/CONTENT_OWNER/test" };
const newer = { ...original, id: "r-backfill", createTime: "2026-10-05T00:00:00Z" };

function fixture(overrides = {}) {
  const db = new Database(":memory:");
  const calls = [];
  const core = {
    resolveOwner: value => ({ id: value === OWNER ? 1 : 2, network_code: String(value), name: "CMS" }),
    googleGet: async (url, { params }) => {
      calls.push({ url, params });
      if (url.endsWith("/reportTypes")) return { reportTypes: [{ id: job.reportTypeId, name: "Basic" }] };
      if (url.endsWith("/jobs")) return { jobs: [job] };
      if (url.endsWith("/reports")) return { reports: [original] };
      throw new Error(`Unexpected URL: ${url}`);
    }
  };
  const http = {
    get: async () => ({ data: Readable.from([Buffer.from("video_id,views\nv1,4\n")]), headers: { "content-type": "text/csv" } }),
    post: async (url, body) => ({ data: { id: "new-job", ...body } })
  };
  const service = createAnalyticsBulkService({ db, core: { ...core, ...overrides.core }, http: { ...http, ...overrides.http },
    withCmsAccessToken: async (_owner, request) => request("fixture-token"), ...overrides.options });
  return { db, service, calls };
}

async function finished(service, id) {
  for (let i = 0; i < 200; i += 1) {
    const run = service.getRun(id);
    if (!["queued", "running", "cancelling"].includes(run.status)) return run;
    await delay(5);
  }
  throw new Error("Bulk run did not finish");
}

test("CSV parser preserves BOM, quotes, multiline fields, empty dimensions and exact large IDs", () => {
  assert.deepEqual([...csvRecords('\uFEFFvideo_id,title,views\r\n123456789012345678901,"A, B ""quoted""\nline",4\r\n,"",0\r\n')], [
    ["video_id", "title", "views"], ["123456789012345678901", 'A, B "quoted"\nline', "4"], ["", "", "0"]
  ]);
  assert.deepEqual([...csvRecords('dimension\n""\n')], [["dimension"], [""]]);
  assert.throws(() => [...csvRecords('a,b\n"unclosed,b')], /chưa kết thúc/);
  assert.throws(() => [...csvRecords('a\n"quoted"x')], /sau ô/);
});

test("download accepts only exact Google Reporting hosts, safe paths, HTTPS and no credentials", () => {
  assert.match(validateDownloadUrl(original.downloadUrl), /^https:\/\/youtubereporting/);
  assert.doesNotThrow(() => validateDownloadUrl("https://www.googleapis.com/download/youtube/reporting/v1/media/foo?alt=media"));
  for (const unsafe of ["http://youtubereporting.googleapis.com/v1/media/x", "https://youtubereporting.googleapis.com.evil.test/v1/media/x",
    "https://localhost/v1/media/x", "https://127.0.0.1/v1/media/x", "https://user:pass@youtubereporting.googleapis.com/v1/media/x",
    "https://youtubereporting.googleapis.com:8443/v1/media/x", "https://www.googleapis.com/oauth2/v1/token", "file:///x"]) {
    assert.throws(() => validateDownloadUrl(unsafe), /không thuộc|không hợp lệ/, unsafe);
  }
});

test("paged catalog reads all report types and jobs including system-managed types", async () => {
  const { service, calls } = fixture({ core: { googleGet: async (url, { params }) => {
    calls.push({ url, params });
    const key = url.endsWith("/jobs") ? "jobs" : "reportTypes";
    if (!params.pageToken) return { [key]: key === "jobs" ? [job] : [{ id: "type-one" }], nextPageToken: "page-2" };
    return { [key]: key === "jobs" ? [{ ...job, id: "system-job", systemManaged: true }] : [{ id: "finance", systemManaged: true }] };
  } } });
  const result = await service.catalog(OWNER);
  assert.equal(result.reportTypes.length, 2);
  assert.equal(result.jobs.length, 2);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.params.includeSystemManaged === true && call.params.onBehalfOfContentOwner === OWNER));
});

test("pagination loops fail explicitly instead of silently truncating the catalog", async () => {
  const { service } = fixture({ core: { googleGet: async () => ({ nextPageToken: "again" }) } });
  await assert.rejects(service.catalog(OWNER), /vòng lặp phân trang/);
});

test("imports are atomic, repeated report IDs replace rows, and malformed corrections keep previous data", async () => {
  const { service, db } = fixture();
  await service.importCsv(OWNER, job, original, Buffer.from("video_id,views\nv1,4\nv2,9\n"));
  await service.importCsv(OWNER, job, original, Buffer.from("video_id,views\nv1,5\n"));
  assert.equal(service.data({ ownerId: OWNER, reportTypeId: job.reportTypeId }).total, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_bulk_rows").get().n, 1);
  await assert.rejects(service.importCsv(OWNER, job, { ...original, createTime: newer.createTime }, Buffer.from("video_id,views\nv1,20\nv2\n")), /ô/);
  assert.equal(service.data({ ownerId: OWNER, reportTypeId: job.reportTypeId }).rows[0].views, "5");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_bulk_rows").get().n, 1);
});

test("backfills with new IDs supersede the previous interval while retaining original CSV for audit", async () => {
  const { service, db } = fixture();
  await service.importCsv(OWNER, job, original, Buffer.from("video_id,views\nv1,4\n"));
  await service.importCsv(OWNER, job, newer, Buffer.from("video_id,views\nv1,8\n"));
  const data = service.data({ ownerId: OWNER, reportTypeId: job.reportTypeId });
  assert.equal(data.total, 1);
  assert.equal(data.rows[0].views, "8");
  assert.equal(db.prepare("SELECT superseded_by FROM analytic_bulk_reports WHERE report_id=?").get(original.id).superseded_by, newer.id);
  assert.match([...service.exportCsv(OWNER, original.id).chunks].join(""), /v1,4/);
  assert.equal(service.storage(OWNER).reports, 1);
});

test("system-managed backfills with missing endTime supersede cleanly", async () => {
  const { service } = fixture();
  await service.importCsv(OWNER, job, { ...original, endTime: undefined }, Buffer.from("amount\n1\n"));
  await service.importCsv(OWNER, job, { ...newer, endTime: undefined }, Buffer.from("amount\n2\n"));
  const data = service.data({ ownerId: OWNER, reportTypeId: job.reportTypeId });
  assert.equal(data.rows[0].amount, "2");
  assert.equal(data.rows[0]._periodStart, original.startTime);
  assert.equal(data.rows[0]._periodEnd, "");
  assert.equal(data.total, 1);
});

test("rows, schemas and exports are isolated per Content Owner", async () => {
  const { service } = fixture();
  await service.importCsv(OWNER, job, original, Buffer.from("video_id,views\nsecret-video,4\n"));
  assert.equal(service.data({ ownerId: "OTHER", reportTypeId: job.reportTypeId }).total, 0);
  assert.throws(() => service.exportCsv("OTHER", original.id), /chưa được tải/);
});

test("stored data, CSV export and run history remain readable after CMS OAuth disconnect", async () => {
  let connected = true;
  const { service } = fixture({ core: { resolveOwner: (value, { requireConnected = true } = {}) => {
    if (requireConnected && !connected) throw Object.assign(new Error("CMS OAuth disconnected"), { status: 409 });
    return { id: 1, network_code: value };
  } } });
  await service.importCsv(OWNER, job, original, Buffer.from("views\n4\n"));
  connected = false;
  assert.equal(service.data({ ownerId: OWNER, reportTypeId: job.reportTypeId }).total, 1);
  assert.match([...service.exportCsv(OWNER, original.id).chunks].join(""), /views/);
  assert.deepEqual(service.listRuns(OWNER), []);
  const cached = await service.catalog(OWNER, { cached: true });
  assert.equal(cached.cached, true);
  assert.equal(cached.reportTypes[0].id, job.reportTypeId);
  assert.equal(cached.storage.reports, 1);
  await assert.rejects(service.catalog(OWNER), /disconnected/);
  assert.throws(() => service.startSync({ ownerId: OWNER }), /disconnected/);
  assert.throws(() => service.startCreateJobs({ ownerId: OWNER, all: true }), /disconnected/);
});

test("bulk rows include period and report provenance without changing or overwriting original CSV columns", async () => {
  const { service } = fixture();
  await service.importCsv(OWNER, job, original, Buffer.from("_reportId,amount\ncsv-owned-value,4\n"));
  const nextMonth = { ...newer, startTime: "2026-11-01T00:00:00Z", endTime: "2026-12-01T00:00:00Z" };
  await service.importCsv(OWNER, job, nextMonth, Buffer.from("_reportId,amount\ncsv-owned-next,8\n"));
  const result = service.data({ ownerId: OWNER, reportTypeId: job.reportTypeId });
  assert.equal(result.total, 2);
  assert.deepEqual(result.sourceColumns, ["_reportId", "amount"]);
  assert.equal(result.provenanceColumns.reportId, "__reportId");
  assert.equal(result.rows[0]._reportId, "csv-owned-next");
  assert.equal(result.rows[0].__reportId, nextMonth.id);
  assert.equal(result.rows[0].__periodStart, nextMonth.startTime);
  assert.equal(result.rows[1].__periodStart, original.startTime);
  assert.ok(result.columns.includes("__periodStart") && result.columns.includes("_reportId"));
  const rawExport = [...service.exportCsv(OWNER, original.id).chunks].join("");
  assert.match(rawExport, /_reportId,amount/);
  assert.doesNotMatch(rawExport, /__periodStart/);
});

test("CSV export neutralizes formulas and keeps safe negative numeric values", async () => {
  assert.equal(csvCell("=HYPERLINK(\"https://example.test\")").startsWith('"\'='), true);
  assert.equal(csvCell("  @SUM(A1)"), "'  @SUM(A1)");
  assert.equal(csvCell("-12.34"), "-12.34");
  assert.equal(csvCell("-cmd|' /c calc'!A0").startsWith("'-cmd"), true);
  const { service, db } = fixture();
  const raw = Buffer.from('title,amount\n"=1+1",-2\n');
  await service.importCsv(OWNER, job, original, raw);
  assert.match([...service.exportCsv(OWNER, original.id).chunks].join(""), /'=1\+1,-2/);
  assert.deepEqual(db.prepare("SELECT raw_csv FROM analytic_bulk_reports").get().raw_csv, raw);
});

test("download bounds the decompressed stream and disables OAuth redirect forwarding", async () => {
  let config;
  const { service } = fixture({ options: { maxBytes: 1024 }, http: { get: async (_url, settings) => {
    config = settings;
    return { data: Readable.from([Buffer.alloc(1025)]), headers: {} };
  } } });
  await assert.rejects(service.download({ network_code: OWNER }, original.downloadUrl), /vượt giới hạn/);
  assert.equal(config.maxRedirects, 0);
  assert.equal(config.responseType, "stream");
  assert.match(config.headers.Authorization, /^Bearer /);
});

test("async sync handles all report pages, imports newest backfill, and reruns without duplicates", async () => {
  const { service } = fixture({ core: { googleGet: async (url, { params }) => {
    if (url.endsWith("/jobs")) return { jobs: [job] };
    if (url.endsWith("/reports")) return params.pageToken ? { reports: [newer] } : { reports: [original], nextPageToken: "second" };
    throw new Error("unexpected");
  } } });
  const run = service.startSync({ ownerId: OWNER });
  assert.equal(run.status, "queued");
  assert.throws(() => service.startSync({ ownerId: OWNER }), error => error.status === 409);
  const done = await finished(service, run.id);
  assert.equal(done.status, "completed");
  assert.equal(done.totalReports, 2);
  assert.equal(done.importedReports, 1);
  assert.equal(done.skippedReports, 1);
  const again = await finished(service, service.startSync({ ownerId: OWNER }).id);
  assert.equal(again.importedReports, 0);
  assert.equal(again.skippedReports, 2);
  assert.equal(service.data({ ownerId: OWNER, reportTypeId: job.reportTypeId }).total, 1);
});

test("cancelling staged import discards partial rows without destroying the prior committed generation", async () => {
  const { service, db } = fixture();
  await service.importCsv(OWNER, job, original, Buffer.from("video_id,views\nv1,4\n"));
  const controller = new AbortController();
  const large = Buffer.from("video_id,views\n" + Array.from({ length: 2500 }, (_, i) => `v${i},8`).join("\n"));
  setImmediate(() => controller.abort());
  await assert.rejects(service.importCsv(OWNER, job, newer, large, { signal: controller.signal }), error => error.cancelled === true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_bulk_rows").get().n, 1);
  assert.equal(service.data({ ownerId: OWNER, reportTypeId: job.reportTypeId }).rows[0].views, "4");
});

test("queued runs cancel durably and restart recovery marks interrupted runs and cleans only staged data", async () => {
  const { service, db } = fixture();
  const run = service.startSync({ ownerId: OWNER });
  service.cancelRun(run.id);
  assert.equal((await finished(service, run.id)).status, "cancelled");
  await service.importCsv(OWNER, job, original, Buffer.from("views\n4\n"));
  db.prepare("INSERT INTO analytic_bulk_rows VALUES (?,?,?,?,?)").run(OWNER, "orphan", "staging", 1, "[]");
  db.prepare("UPDATE analytic_bulk_runs SET status='running' WHERE id=?").run(run.id);
  service.recoverInterruptedRuns();
  assert.equal(service.getRun(run.id).status, "interrupted");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytic_bulk_rows").get().n, 1);
});

test("all report job creation skips existing active jobs and YouTube-managed jobs", async () => {
  let posted = 0;
  const { service } = fixture({ core: { googleGet: async url => url.endsWith("/jobs") ? { jobs: [job] } : {
    reportTypes: [{ id: job.reportTypeId }, { id: "type-new" }, { id: "type-system", systemManaged: true }, { id: "type-retired", deprecateTime: "2020-01-01T00:00:00Z" }]
  } }, http: { post: async (_url, body) => { posted += 1; return { data: { ...body, id: `new-${posted}` } }; } } });
  const run = await finished(service, service.startCreateJobs({ ownerId: OWNER, all: true }).id);
  assert.equal(run.status, "completed");
  assert.equal(run.totalJobs, 2);
  assert.equal(run.createdJobs, 1);
  assert.equal(run.existingJobs, 1);
  assert.equal(posted, 1);
});

test("errors redact bearer values and do not expose Axios request or response configuration", () => {
  assert.equal(publicError(new Error("Bearer secret-token")).message, "Bearer [redacted]");
  assert.doesNotMatch(publicError({ request: { Authorization: "secret-token" }, message: "request https://signed.test?token=secret-token failed" }).message, /secret-token/);
});
