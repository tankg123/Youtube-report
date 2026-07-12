const { releaseClaims, searchClaims } = require("../services/claimService");

function claimErrorStatus(error) {
  const status = Number(error.statusCode || error.response?.status || 0);
  if ([400, 401, 403, 404, 409, 429].includes(status)) return status;
  if (status >= 500) return 502;
  return 400;
}

function sendClaimError(res, error) {
  const retryAfter = error.response?.headers?.["retry-after"];
  if (retryAfter) res.set("Retry-After", retryAfter);
  return res.status(claimErrorStatus(error)).json({
    success: false,
    message: error.message,
    reason: error.response?.data?.error?.errors?.[0]?.reason || undefined
  });
}

async function searchVideoClaims(req, res) {
  try {
    const result = await searchClaims({
      accountIds: req.body.accountIds,
      videoInput: req.body.videoInput,
      includeDetails: req.body.includeDetails,
      user: req.user
    });

    res.json({ success: true, data: result });
  } catch (error) {
    sendClaimError(res, error);
  }
}

async function releaseVideoClaims(req, res) {
  try {
    const result = await releaseClaims({ releases: req.body.releases, user: req.user });
    res.json({ success: true, data: result });
  } catch (error) {
    sendClaimError(res, error);
  }
}

module.exports = {
  releaseVideoClaims,
  searchVideoClaims
};
