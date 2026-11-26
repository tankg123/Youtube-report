const express = require("express");
const {
  addCodes,
  addWhitelistChannels,
  createArtist,
  createLabel,
  deleteCode,
  deleteArtist,
  deleteLabel,
  deleteProduct,
  deleteWhitelistChannels,
  getAvailableCodes,
  getCodeSummary,
  getProduct,
  listArtists,
  listCodes,
  listCmsNetworks,
  listLabels,
  listProducts,
  listWhitelists,
  saveProduct,
  syncLabelsFromCms,
  syncWhitelistChannelInfo,
  syncWhitelists,
  updateArtist,
  updateLabel,
  updateCode
} = require("../controllers/contentIdController");
const {
  analyzeProductTrackCsv,
  packageAlbums
} = require("../controllers/productTrackImportController");
const claims = require("../controllers/claimManagerController");
const delivery = require("../controllers/deliveryController");
const { authMiddleware, allowRoles } = require("../middlewares/authMiddleware");

const router = express.Router();
const CONTENT_ID_ROLES = ["admin", "Content ID"];
const CLAIM_MANAGER_ROLES = ["admin", "Content ID", "Claim Manager"];
const LABEL_READ_ROLES = ["admin", "Content ID", "Claim Manager", "Account", "Account Claim Manager"];
const LABEL_WRITE_ROLES = ["admin", "Content ID"];

router.use(authMiddleware);

router.get("/codes/summary", allowRoles(...CONTENT_ID_ROLES), getCodeSummary);
router.get("/codes/available", allowRoles(...CONTENT_ID_ROLES), getAvailableCodes);
router.get("/codes", allowRoles(...CONTENT_ID_ROLES), listCodes);
router.post("/codes", allowRoles(...CONTENT_ID_ROLES), addCodes);
router.put("/codes/:id", allowRoles(...CONTENT_ID_ROLES), updateCode);
router.delete("/codes/:id", allowRoles(...CONTENT_ID_ROLES), deleteCode);

router.get("/cms-networks", allowRoles(...CLAIM_MANAGER_ROLES), listCmsNetworks);
router.get("/asset-check/search", allowRoles(...CONTENT_ID_ROLES), claims.searchArtistAssets);
router.get("/ownership-email", allowRoles(...CONTENT_ID_ROLES), claims.checkOwnershipEmail);
router.post("/asset-check/:networkId/export", allowRoles(...CONTENT_ID_ROLES), claims.exportSelectedAssets);
router.get("/asset-check/:networkId/:assetId", allowRoles(...CONTENT_ID_ROLES), claims.getAssetOwnership);

// Claim Manager: look up the claims a CMS owns and change their status through the Partner API:
// release (-> inactive), reinstate (inactive -> active) and confirm (potential -> active), each
// with an audit trail in content_id_claim_events. Limited "Claim Manager" users are restricted to
// their labels.
router.get("/claims/accounts", allowRoles(...CLAIM_MANAGER_ROLES), claims.listAccounts);
router.post("/claims/search", allowRoles(...CLAIM_MANAGER_ROLES), claims.search);
router.post("/claims/videos/:videoId/third-party-uploads", allowRoles(...CLAIM_MANAGER_ROLES), claims.getThirdPartyUploads);
router.post("/claims/release", allowRoles(...CLAIM_MANAGER_ROLES), claims.release);
router.post("/claims/reinstate", allowRoles(...CLAIM_MANAGER_ROLES), claims.reinstate);
router.post("/claims/confirm", allowRoles(...CLAIM_MANAGER_ROLES), claims.confirm);
router.post("/claims/recheck", allowRoles(...CLAIM_MANAGER_ROLES), claims.recheck);
router.get("/claims/history/export", allowRoles(...CLAIM_MANAGER_ROLES), claims.exportHistory);
router.get("/claims/history", allowRoles(...CLAIM_MANAGER_ROLES), claims.listHistory);
router.get("/claims/:networkId/:claimId", allowRoles(...CLAIM_MANAGER_ROLES), claims.getDetail);

router.get("/labels", allowRoles(...LABEL_READ_ROLES), listLabels);
router.post("/labels", allowRoles(...LABEL_WRITE_ROLES), createLabel);
router.post("/labels/sync-cms", allowRoles(...LABEL_WRITE_ROLES), syncLabelsFromCms);
router.put("/labels/:id", allowRoles(...LABEL_WRITE_ROLES), updateLabel);
router.delete("/labels/:id", allowRoles(...LABEL_WRITE_ROLES), deleteLabel);

router.get("/whitelists", allowRoles(...CONTENT_ID_ROLES), listWhitelists);
router.post("/whitelists/sync-cms", allowRoles(...CONTENT_ID_ROLES), syncWhitelists);
router.post("/whitelists/sync-channel-info", allowRoles(...CONTENT_ID_ROLES), syncWhitelistChannelInfo);
router.post("/whitelists", allowRoles(...CONTENT_ID_ROLES), addWhitelistChannels);
router.delete("/whitelists", allowRoles(...CONTENT_ID_ROLES), deleteWhitelistChannels);

router.get("/artists", allowRoles(...CONTENT_ID_ROLES), listArtists);
router.post("/artists", allowRoles(...CONTENT_ID_ROLES), createArtist);
router.put("/artists/:id", allowRoles(...CONTENT_ID_ROLES), updateArtist);
router.delete("/artists/:id", allowRoles(...CONTENT_ID_ROLES), deleteArtist);

router.post("/product-track/analyze", allowRoles(...CONTENT_ID_ROLES), analyzeProductTrackCsv);
router.post("/product-track/package", allowRoles(...CONTENT_ID_ROLES), packageAlbums);

// CMS Delivery: products (release + tracks) delivered straight to YouTube CMS through the
// Content ID API and managed afterwards from our database (edit, sync, takedown, reactivate).
// Literal paths are registered before the parameterized ones so they are not swallowed by :id.
router.get("/delivery/options", allowRoles(...CONTENT_ID_ROLES), delivery.getOptions);
router.post("/delivery/asset-labels", allowRoles(...CONTENT_ID_ROLES), delivery.createAssetLabel);
router.post("/delivery/check-duplicates", allowRoles(...CONTENT_ID_ROLES), delivery.checkDuplicates);
// Audio chosen in the product form is uploaded right away (raw PUT body) and attached to its
// track when the product is saved; unused uploads expire on the server.
router.put("/delivery/audio-uploads", allowRoles(...CONTENT_ID_ROLES), delivery.uploadDraftAudio);
router.get("/delivery/audio-uploads", allowRoles(...CONTENT_ID_ROLES), delivery.checkDraftAudio);
router.delete("/delivery/audio-uploads/:id", allowRoles(...CONTENT_ID_ROLES), delivery.deleteDraftAudio);
router.get("/delivery/products", allowRoles(...CONTENT_ID_ROLES), delivery.listProducts);
router.post("/delivery/products", allowRoles(...CONTENT_ID_ROLES), delivery.createProduct);
router.get("/delivery/products/:id", allowRoles(...CONTENT_ID_ROLES), delivery.getProduct);
router.get("/delivery/products/:id/progress", allowRoles(...CONTENT_ID_ROLES), delivery.getProductProgress);
// Persisted delivery logs: paged/filtered listing, one entry per delivery run, full export.
router.get("/delivery/products/:id/logs", allowRoles(...CONTENT_ID_ROLES), delivery.listProductLogs);
router.get("/delivery/products/:id/logs/runs", allowRoles(...CONTENT_ID_ROLES), delivery.listProductLogRuns);
router.get("/delivery/products/:id/logs/export", allowRoles(...CONTENT_ID_ROLES), delivery.exportProductLogs);
router.patch("/delivery/products/:id", allowRoles(...CONTENT_ID_ROLES), delivery.updateProduct);
router.delete("/delivery/products/:id", allowRoles(...CONTENT_ID_ROLES), delivery.deleteProduct);
router.post("/delivery/products/:id/deliver", allowRoles(...CONTENT_ID_ROLES), delivery.deliverProduct);
router.post("/delivery/products/:id/cleanup-audio", allowRoles(...CONTENT_ID_ROLES), delivery.cleanupProductAudio);
router.post("/delivery/products/:id/sync", allowRoles(...CONTENT_ID_ROLES), delivery.syncProduct);
router.post("/delivery/products/:id/rights", allowRoles(...CONTENT_ID_ROLES), delivery.updateRights);
router.post("/delivery/products/:id/takedown", allowRoles(...CONTENT_ID_ROLES), delivery.takedownProduct);
router.post("/delivery/products/:id/reactivate", allowRoles(...CONTENT_ID_ROLES), delivery.reactivateProduct);
router.patch("/delivery/tracks/:id", allowRoles(...CONTENT_ID_ROLES), delivery.updateTrack);
// Audio files are stored on the server (raw PUT body) and the reference is delivered from there.
router.put("/delivery/tracks/:id/audio", allowRoles(...CONTENT_ID_ROLES), delivery.uploadAudio);
router.get("/delivery/tracks/:id/audio", allowRoles(...CONTENT_ID_ROLES), delivery.getTrackAudio);
router.delete("/delivery/tracks/:id/audio", allowRoles(...CONTENT_ID_ROLES), delivery.deleteTrackAudio);
router.post("/delivery/tracks/:id/reference", allowRoles(...CONTENT_ID_ROLES), delivery.deliverReference);
router.post("/delivery/tracks/:id/reference-from-claim", allowRoles(...CONTENT_ID_ROLES), delivery.referenceFromClaim);
router.post("/delivery/tracks/:id/retry", allowRoles(...CONTENT_ID_ROLES), delivery.retryTrack);
router.post("/delivery/tracks/:id/sync", allowRoles(...CONTENT_ID_ROLES), delivery.syncTrack);
router.post("/delivery/tracks/:id/takedown", allowRoles(...CONTENT_ID_ROLES), delivery.takedownTrack);
router.post("/delivery/tracks/:id/reactivate", allowRoles(...CONTENT_ID_ROLES), delivery.reactivateTrack);
router.get("/delivery/tracks/:id/claims", allowRoles(...CONTENT_ID_ROLES), delivery.listTrackClaims);

router.get("/products", allowRoles(...CONTENT_ID_ROLES), listProducts);
router.post("/products", allowRoles(...CONTENT_ID_ROLES), saveProduct);
router.get("/products/:id", allowRoles(...CONTENT_ID_ROLES), getProduct);
router.delete("/products/:id", allowRoles(...CONTENT_ID_ROLES), deleteProduct);

module.exports = router;
