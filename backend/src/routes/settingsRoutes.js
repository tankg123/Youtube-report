const express = require("express");
const router = express.Router();

const settingsController = require("../controllers/settingsController");
const ownershipKeys = require("../controllers/ownershipApiKeys");
const sidebar = require("../controllers/sidebarVisibility");
const { authMiddleware, allowRoles } = require("../middlewares/authMiddleware");

router.get("/system", settingsController.getSettings);
router.use("/sidebar", authMiddleware, allowRoles("admin"), sidebar.authorizeSidebar);
router.post("/sidebar/unlock", sidebar.unlock);
router.put("/sidebar", sidebar.updateVisibility);
router.use("/ownership-api-keys", authMiddleware, allowRoles("admin"));
router.get("/ownership-api-keys", ownershipKeys.listKeys);
router.post("/ownership-api-keys", ownershipKeys.createKey);
router.delete("/ownership-api-keys/:id", ownershipKeys.revokeKey);
router.put("/system", authMiddleware, allowRoles("admin"), settingsController.updateSettings);

module.exports = router;
