const express = require("express");
const { authMiddleware, allowRoles, normalizedRoles } = require("../middlewares/authMiddleware");
const { getService, publicError } = require("../services/analyticsBulkService");

const router = express.Router();
// Bulk includes system-managed financial reports. Gate the whole archive with
// the existing report permission rather than guessing sensitivity from type IDs.
const ANALYTICS_ROLES = ["admin", "Report Manager"];
router.use(authMiddleware, allowRoles(...ANALYTICS_ROLES));

function writeAllowed(req, res, next) {
  if (normalizedRoles(req.user?.roles?.length ? req.user.roles : req.user?.role).includes("read only")) {
    return res.status(403).json({ success: false, message: "Tài khoản chỉ đọc không thể đồng bộ hoặc tạo Reporting Job." });
  }
  next();
}

function route(handler, status = 200) {
  return async (req, res) => {
    try { res.status(status).json({ success: true, data: await handler(getService(), req) }); }
    catch (error) {
      const safe = publicError(error);
      res.status(safe.status).json({ success: false, message: safe.message, ...(error.runId ? { runId: error.runId } : {}) });
    }
  };
}

router.get("/catalog", route((service, req) => service.catalog(req.query.ownerId, { cached: req.query.cached === "true" })));
router.get("/reports", route((service, req) => service.reports(req.query.ownerId, req.query.jobId)));
router.get("/runs", route((service, req) => service.listRuns(req.query.ownerId)));
router.get("/runs/:id", route((service, req) => service.getRun(req.params.id)));
router.get("/data", route((service, req) => service.data(req.query)));
router.post("/jobs", writeAllowed, route((service, req) => service.startCreateJobs({
  ownerId: req.body?.ownerId, reportTypeIds: req.body?.reportTypeIds, all: req.body?.all === true, actorId: req.user.id
}), 202));
router.post("/sync", writeAllowed, route((service, req) => service.startSync({
  ownerId: req.body?.ownerId, jobIds: req.body?.jobIds, actorId: req.user.id
}), 202));
router.post("/runs/:id/cancel", writeAllowed, route((service, req) => service.cancelRun(req.params.id)));
router.get("/export", async (req, res) => {
  try {
    const output = getService().exportCsv(req.query.ownerId, req.query.reportId);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${output.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    for (const chunk of output.chunks) {
      if (res.destroyed) break;
      if (!res.write(chunk) && !res.destroyed) await new Promise(resolve => {
        const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
        res.once("drain", done);
        res.once("close", done);
      });
    }
    res.end();
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    const safe = publicError(error);
    res.status(safe.status).json({ success: false, message: safe.message });
  }
});

// Initialize durable run recovery when the route is mounted during server boot.
// Tests may import the service factory without touching a production database.
router.initialize = () => getService();
module.exports = router;
