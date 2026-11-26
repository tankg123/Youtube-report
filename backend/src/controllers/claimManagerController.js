// HTTP layer of the Claim Manager page: validation errors come back as 400, a rejected CMS
// token as 424 (the frontend treats 401 as an expired app session), Google rate limits and
// quota 403s as 429 with Retry-After, an unanswered Google call as 504, a Google 5xx (or a
// Google that could not be reached) as 502, and anything that is not a known error as 500
// with a reference the server log also carries.
const { randomBytes } = require("crypto");
const { Writable } = require("node:stream");
const claims = require("../services/claimManagerService");
const assetCheck = require("../services/assetCheckService");
const { lookupOwnershipEmail } = require("../services/ownershipEmailService");
const { buildAssetCheckWorkbook } = require("../services/assetCheckWorkbook");
const store = require("../services/deliveryStore");

// Answers caused on Google's side or by the CMS authorization are logged in one line so an
// operator can match a user's report to the server log.
const LOGGED_STATUSES = new Set([424, 429, 502, 504]);
// The Partner API reports an exhausted project quota as a 403 without Retry-After; a minute is
// the shortest interval after which a per-minute limit can have reset.
const QUOTA_RETRY_AFTER_SECONDS = 60;

function upstreamStatus(error) {
  return Number(error?.status || error?.response?.status || 0);
}

function isQuotaError(error) {
  return upstreamStatus(error) === 403 && store.isQuotaReason(error?.reason);
}

function httpStatus(error) {
  if (error?.isClaimManagerError) return Number(error.status) || 400;
  const status = upstreamStatus(error);
  if (store.isCmsCredentialError(error)) return 424;
  if (isQuotaError(error)) return 429;
  if ([403, 404, 409, 429].includes(status)) return status;
  if (error?.timedOut) return 504;
  if (status >= 500) return 502;
  // A Partner API call that ended without any HTTP answer (dropped socket, DNS failure) is
  // still Google's failure, not a bad request; so is a token service that could not be reached.
  if (!status && (error?.isAssetDeliveryError || error?.tokenRefreshTransient)) return 502;
  if (!status) return 500;
  return 400;
}

function retryAfterOf(error) {
  const value = Number(error?.retryAfter ?? error?.response?.headers?.["retry-after"]);
  if (Number.isFinite(value) && value >= 0) return value;
  return isQuotaError(error) ? QUOTA_RETRY_AFTER_SECONDS : null;
}

function fail(res, error, exportStream = false) {
  const status = httpStatus(error);
  const payload = { success: false, message: "" };
  if (status === 500 && error?.oauthClientMisconfigured) {
    // The server's own Google OAuth client is rejected: the message names what an administrator
    // must fix, and the log carries it too.
    payload.message = error.message;
    if (["invalid_client", "unauthorized_client", "oauth_client_not_configured", "oauth_client_unverified"].includes(error.reason)) {
      payload.recovery = "restore_oauth_client";
    }
    console.error(`[claim-manager] 500 network=${error.networkId ?? "-"} reason=${error.reason || "-"}: ${error.message}`);
  } else if (status === 500) {
    // Neither a validation error nor Google's answer: a bug or a database problem. The user
    // gets a reference, the log gets the error itself.
    const ref = randomBytes(4).toString("hex");
    payload.message = `Unexpected server error (ref ${ref})`;
    console.error("[claim-manager]", ref, error);
  } else {
    payload.message = error?.isClaimManagerError ? error.message : store.errorMessage(error);
  }
  if (error?.reason) payload.reason = error.reason;
  if (Array.isArray(error?.invalid) && error.invalid.length) payload.invalid = error.invalid;
  const retryAfter = retryAfterOf(error);
  if (retryAfter !== null) {
    payload.retry_after = retryAfter;
    if (!res.headersSent) res.set("Retry-After", String(retryAfter));
  }
  if (LOGGED_STATUSES.has(status)) {
    console.error(`[claim-manager] ${status} network=${error?.networkId ?? "-"} reason=${error?.reason || "-"}: ${payload.message}`);
  }
  if (exportStream) res.end(JSON.stringify({ type: "error", status, ...payload }) + "\n");
  else res.status(status).json(payload);
}

function listAccounts(req, res) {
  try {
    res.json({ success: true, accounts: claims.listClaimAccounts(), limits: claims.LIMITS, user: claims.describeUser(req.user) });
  } catch (error) {
    fail(res, error);
  }
}

async function checkOwnershipEmail(req, res) {
  try {
    const result = await lookupOwnershipEmail({
      networkId: req.query.network_id, id: req.query.id, pageToken: req.query.page_token
    });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

async function search(req, res) {
  try {
    const result = await claims.searchClaims({ user: req.user, body: req.body });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

async function getDetail(req, res) {
  try {
    const result = await claims.getClaimDetail({ user: req.user, networkId: req.params.networkId, claimId: req.params.claimId });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

async function searchArtistAssets(req, res) {
  try {
    const result = await assetCheck.searchArtistAssets({
      networkId: req.query.network_id,
      artist: req.query.artist,
      scope: req.query.scope,
      type: req.query.type,
      pageToken: req.query.page_token
    });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

async function getAssetOwnership(req, res) {
  try {
    const result = await assetCheck.getAssetOwnership(req.params);
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

async function exportSelectedAssets(req, res) {
  const controller = new AbortController();
  const abort = () => { if (!res.writableFinished) controller.abort(); };
  res.once("close", abort);
  const framed = req.get("accept") === "application/x-ndjson";
  let heartbeat, output, assets;
  try {
    assets = assetCheck.iterateExportAssets({
      networkId: req.params.networkId, items: req.body?.items, filter: req.body?.filter,
      excludedIds: req.body?.excluded_ids, signal: controller.signal
    });
    if (framed) {
      res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      let written = 0;
      let finalizing = false;
      const progress = () => {
        if (!res.destroyed && !res.writableNeedDrain) res.write(JSON.stringify({ type: "progress", written, finalizing }) + "\n");
      };
      progress();
      heartbeat = setInterval(progress, 10000);
      heartbeat.unref();
      output = new Writable({
        write(chunk, _encoding, callback) {
          res.write(JSON.stringify({ type: "xlsx", data: chunk.toString("base64") }) + "\n", callback);
        }
      });
      output.on("error", abort);
      async function* countedRows() {
        for await (const asset of assets) {
          yield asset;
          if (++written % 250 === 0) progress();
        }
        finalizing = true;
        progress();
      }
      await buildAssetCheckWorkbook(countedRows(), req.body?.language, output, controller.signal);
      res.end(JSON.stringify({ type: "complete", written }) + "\n");
      return;
    }
    // Validate the search and fetch its first row before switching to a binary response.
    const first = await assets.next();
    if (controller.signal.aborted) return;
    async function* rows() {
      yield first.value;
      yield* assets;
    }
    res.attachment("selected-assets.xlsx").set("X-Accel-Buffering", "no");
    await buildAssetCheckWorkbook(rows(), req.body.language, res, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {
      if (framed && res.headersSent) fail(res, error, true);
      else if (res.headersSent) res.destroy();
      else fail(res, error);
    }
  } finally {
    clearInterval(heartbeat);
    output?.destroy();
    await assets?.return();
    res.off("close", abort);
  }
}

async function getThirdPartyUploads(req, res) {
  try {
    const result = await claims.getThirdPartyUploads({
      user: req.user,
      videoId: req.params.videoId,
      networkIds: req.body?.network_ids
    });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

// The client aborting the request (Cancel run, closed tab, dropped connection) is passed on as an
// abort signal: the claims not reached yet are not sent, the ones in flight finish and are audited.
// 'close' also fires after a normal answer, hence the writableEnded check.
function abortSignalOf(res) {
  if (!res || typeof res.on !== "function") return null;
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

async function release(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = await claims.releaseClaims({ user: req.user, releases: body.releases, note: body.note, signal: abortSignalOf(res) });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

async function reinstate(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = await claims.reinstateClaims({ user: req.user, items: body.items, note: body.note, signal: abortSignalOf(res) });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

// Confirm potential claims (potential -> active); same body shape and abort handling as reinstate.
async function confirm(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = await claims.confirmClaims({ user: req.user, items: body.items, note: body.note, signal: abortSignalOf(res) });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

async function recheck(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = await claims.recheckClaims({ user: req.user, items: body.items });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

function listHistory(req, res) {
  try {
    const query = req.query || {};
    const result = claims.listHistory({ user: req.user, filters: query, page: query.page, pageSize: query.page_size });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
}

function exportHistory(req, res) {
  try {
    const csv = claims.exportHistoryCsv({ user: req.user, filters: req.query || {} });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="claim-release-history-${stamp}.csv"`);
    res.send(csv);
  } catch (error) {
    fail(res, error);
  }
}

module.exports = {
  checkOwnershipEmail,
  confirm,
  exportHistory,
  getDetail,
  listAccounts,
  listHistory,
  recheck,
  reinstate,
  release,
  search,
  getThirdPartyUploads,
  searchArtistAssets,
  exportSelectedAssets,
  getAssetOwnership
};
