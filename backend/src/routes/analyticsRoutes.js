const express = require("express");
const service = require("../services/analyticsService");
const warehouse = require("../services/analyticsWarehouse");
const db = require("../config/analyticsDatabase");
const { createReadService } = require("../services/analyticsReadService");
const v = require("../services/analyticsValidate");
const { authMiddleware, allowRoles, normalizedRoles } = require("../middlewares/authMiddleware");

const router = express.Router();
const reads = createReadService({ db, warehouse, core: service });
// Any Analytics role reads every configured Content Owner; the role only decides monetary visibility and writes.
const READ_ROLES = ["Report Manager", "Content ID"];
const READ_ONLY_MESSAGE = "This account is read only. Business data actions are disabled.";
const CSV_TYPE = "text/csv; charset=utf-8";

function access(req) {
  const roles = normalizedRoles(req.user?.roles?.length ? req.user.roles : req.user?.role);
  const admin = roles.some((role) => ["admin", "super admin", "supper admin"].includes(role));
  const canMonetary = admin || roles.includes("report manager");
  const canSync = !roles.includes("read only");
  return { userId: req.user?.id, canMonetary, canSync, canOverwrite: canMonetary && canSync, canManageSchedules: canSync };
}
function requireSync(req, res, next) {
  if (!access(req).canSync) return res.status(403).json({ success: false, message: READ_ONLY_MESSAGE, error: { reason: "readOnly", status: 403 } });
  return next();
}
// Validation and Google errors carry a status; anything else is a bug and must not leak its message.
function respond(res, error) {
  if (res.headersSent) { res.destroy(); return; }
  const status = Number(error?.status || error?.response?.status);
  if (!(status >= 400 && status <= 599)) {
    console.error("[analytics] unexpected error:", error);
    res.status(500).json({ success: false, message: "Internal error", error: { reason: "internalError", status: 500 } });
    return;
  }
  const detail = service.safeError(error);
  res.status(status).json({ success: false, message: detail.message, error: { reason: detail.reason, status, retryable: detail.retryable }, ...(error.plan ? { plan: error.plan } : {}) });
}
function handle(fn) {
  return async (req, res) => {
    try { const result = await fn(req, res); if (!res.headersSent) res.json({ success: true, ...result }); }
    catch (error) { respond(res, error); }
  };
}
function ownerFilter(req) {
  const ownerId = v.single(req.query, "ownerId");
  return ownerId ? service.resolveOwner(ownerId, { requireConnected: false }).network_code : null;
}
function legacyExport(req, reportId) {
  const result = service.exportReport({ ...req.query, reportId }, access(req));
  return { filename: result.filename, contentType: CSV_TYPE, stream: [result.csv] };
}
const drained = (res) => new Promise((resolve) => {
  const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
  res.once("drain", done); res.once("close", done);
});

router.use(authMiddleware, allowRoles(...READ_ROLES));
router.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

router.get("/bootstrap", handle((req) => reads.bootstrap(access(req))));
router.get("/overview", handle((req) => reads.overview(req.query, access(req))));
router.get("/channels/inventory", handle((req) => reads.channelsInventory(req.query)));
router.get("/channels", handle((req) => reads.channels(req.query, access(req))));
router.get("/channels/:channelId", handle((req) => reads.channelDetail(req.params.channelId, req.query, access(req))));
router.get("/coverage", handle((req) => reads.coverageReport(req.query, access(req))));
router.get("/history", handle((req) => reads.factHistory(req.query, access(req))));
router.get("/facts", handle((req) => reads.facts(req.query, access(req))));
router.get("/snapshots", handle((req) => reads.snapshots(req.query, access(req))));
// Warehouse exports stream CSV rows and build capped workbooks; `reportId` keeps the legacy snapshot/custom CSV working.
router.get("/export", async (req, res) => {
  try {
    const legacy = v.single(req.query, "reportId");
    const file = legacy ? legacyExport(req, legacy) : await reads.exportData(req.query, access(req));
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    if (file.buffer) { res.end(file.buffer); return; }
    for (const chunk of file.stream) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await drained(res);
    }
    res.end();
  } catch (error) { respond(res, error); }
});
router.get("/jobs", handle((req) => ({ jobs: service.listJobs(ownerFilter(req), access(req), v.integer(req.query, "limit", { min: 1, max: 100, fallback: 20 })) })));
router.get("/jobs/:id", handle((req) => ({ job: service.getJob(req.params.id, access(req)) })));
router.post("/sync", requireSync, handle((req) => {
  const result = service.createSync(req.body || {}, access(req));
  if (result?.plan && !result.id) return { plan: result.plan };
  const { deduplicated = false, ...job } = result;
  return { job, deduplicated };
}));
router.post("/jobs/:id/cancel", requireSync, handle((req) => ({ job: service.cancelJob(req.params.id, access(req)) })));
router.post("/query", requireSync, handle(async (req) => ({ report: await service.advancedQuery(req.body || {}, access(req)) })));
router.get("/queries", handle((req) => ({ queries: service.listQueries(v.single(req.query, "ownerId"), access(req)) })));
// `lastRun` is sanitised per role (a monetary step's error is hidden from non-monetary roles), so the access object travels along.
router.get("/schedules", handle((req) => ({ schedules: service.getSchedules(access(req)) })));
router.put("/schedules", requireSync, handle((req) => ({ schedule: service.saveSchedule(req.body || {}, access(req)) })));
module.exports = router;
