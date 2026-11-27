const express = require("express");
const cors = require("cors");
const { listClaimAccounts } = require("../services/claimManagerService");
const ownership = require("../services/ownershipEmailService");
const directory = require("../services/ownershipDirectory");
const store = require("../services/deliveryStore");
const { requireOwnershipKey } = require("../controllers/ownershipApiKeys");

const router = express.Router();
const externalCors = cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "x-api-key"] });
const MANUAL = "Please check manually";

function channelTimeout() {
  const ms = Number(process.env.OWNERSHIP_CHANNEL_TIMEOUT_MS);
  return Number.isSafeInteger(ms) && ms >= 1000 && ms <= 120000 ? ms : 30000;
}

function lookupFailure(error) {
  if (error.oauthClientMisconfigured || error.tokenRefreshTransient || store.isCmsCredentialError(error)) {
    const reason = ["invalid_grant", "invalid_client", "unauthorized_client", "missing_refresh_token",
      "oauth_client_not_configured", "oauth_client_unverified"].includes(error.reason) ? ` (${error.reason})` : "";
    return { http: 503, message: `The CMS token could not be used or renewed${reason}.` };
  }
  if (error.status === 429 || store.isQuotaReason(error.reason)) {
    return { http: 429, message: "YouTube rate or quota limit reached." };
  }
  if (error.status === 403) return { http: 403, message: "YouTube denied this CMS access to the lookup." };
  if (error.isAssetDeliveryError || error.timedOut || error.status >= 500) {
    return { http: 502, message: "YouTube could not complete the ownership lookup." };
  }
  console.error("[ownership-api] lookup failed", error.code || error.name);
  return { http: 500, message: "The server could not complete the ownership lookup." };
}

function contactResult(contact) {
  if (!contact?.email) return null;
  if (contact.evidence !== "title") return { http: 200, contact };
  return { http: 200, contact,
    message: "The email belongs to the requested CMS on a same-title asset. Its link to the channel video is unconfirmed." };
}

async function resolveContact(id, name, signal, progress) {
  const readContact = () => directory.findChannelContact(id, name, { includeTitle: true });
  let contact = readContact();
  if (contact?.email) return contactResult(contact);
  const networks = listClaimAccounts({ includeAuthErrors: true }).filter((account) => account.has_partner_scope);
  if (!networks.length) return { http: 503, message: "No CMS with YouTube Partner access is available." };

  let failure, sawChannel = false, sawOwner = false;
  const warnings = new Set();
  for (const network of networks) {
    signal.throwIfAborted();
    if (network.status === "error") {
      failure = { http: 503, message: "A CMS connection has a saved token error." };
      continue;
    }
    const controller = new AbortController();
    const target = directory.cmsNameKey(name);
    const scan = { target, signal: AbortSignal.any([signal, controller.signal]),
      contacts: new Map(), assets: new Map(),
      onVideo(channel, video) {
        progress.checked.add(video.id);
        if (video.assets.some((asset) => asset.owners.some((owner) => directory.cmsNameKey(owner.name) === target))) {
          progress.partial ??= { channel, videos: [] };
          progress.partial.videos.push(video);
        }
      }
    };
    const seen = new Set();
    let pageToken;
    try {
      do {
        signal.throwIfAborted();
        const result = await ownership.lookupOwnershipEmail({ networkId: network.id, id, pageToken, scan });
        signal.throwIfAborted();
        progress.partial = null; // A completed page has already been saved by the lookup service.
        sawChannel = true;
        sawOwner ||= Boolean(result.channel.manager);
        for (const video of result.videos) {
          progress.checked.add(video.id);
          sawOwner ||= video.assets.some((asset) => asset.evidence !== "title" && asset.owners.length);
          if (video.warnings?.length) warnings.add("Some video or asset details could not be fully verified.");
        }
        if (result.warnings?.length) warnings.add("Some channel, playlist or claim details could not be fully verified.");
        contact = readContact();
        if (contact?.email) return contactResult(contact);
        pageToken = result.next_page_token;
        if (pageToken && seen.has(pageToken)) {
          warnings.add("YouTube returned a repeated uploads page. The scan is incomplete.");
          break;
        }
        seen.add(pageToken);
      } while (pageToken);
    } catch (error) {
      signal.throwIfAborted();
      progress.partial = null;
      if (error.status !== 404) {
        const issue = lookupFailure(error);
        if (!failure || issue.http === 503) failure = issue;
      }
    } finally {
      controller.abort();
    }
  }
  if (failure) return failure;
  let message = "No verified ownership was found for the videos checked.";
  if (!sawChannel) message = "The channel was not visible to the available CMS accounts.";
  else if (contact) message = "The requested CMS was found without an unambiguous contact email.";
  else if (sawOwner) message = "No verified owner matched the requested CMS name.";
  return { http: 200, message: [message, ...warnings].join(" ") };
}

async function lookup(req, res) {
  const input = (req.method === "POST" ? req.body : req.query) || {};
  const channel = input["Channel ID"] ?? input.channel_id;
  const cms = input["CMS Name"] ?? input.cms_name;
  if (typeof channel !== "string" || !/^UC[\w-]{22}$/.test(channel.trim()) ||
      typeof cms !== "string" || !cms.trim() || cms.trim().length > 200) {
    return res.status(400).json({ status: MANUAL, message: "Supply a valid Channel ID and a CMS Name of up to 200 characters." });
  }
  const id = channel.trim();
  const name = cms.trim();
  const ms = channelTimeout();
  const progress = { checked: new Set(), partial: null };
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  res.once("close", disconnect);
  const timer = setTimeout(() => controller.abort(new Error("Channel lookup deadline reached")), ms);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
  let result;
  try {
    // A shared OAuth refresh may still be settling for other callers. Bound this response independently.
    result = await Promise.race([resolveContact(id, name, controller.signal, progress), aborted]);
  } catch (error) {
    if (res.destroyed) return;
    if (controller.signal.aborted) {
      // A sibling video can still be waiting on YouTube when the timer fires.
      if (progress.partial) directory.recordLookup(progress.partial, true);
      result = contactResult(directory.findChannelContact(id, name, { includeTitle: true }));
      const timeout = `Channel time limit (${ms / 1000}s) reached. The scan is incomplete.`;
      if (!result) result = { http: 504, message: timeout };
      else if (result.message) result.message += " " + timeout;
    } else result = lookupFailure(error);
  } finally {
    clearTimeout(timer);
    res.off("close", disconnect);
    controller.abort();
  }
  const email = result.contact?.email || "";
  if (!res.destroyed) res.status(result.http).json({
    "Channel ID": id, "CMS Name": result.contact?.name || name, Email: email, status: email ? "Success" : MANUAL,
    ...(result.contact?.evidence === "title" ? { evidence: "title", video_id: result.contact.video_id, asset_ownership_url: result.contact.asset_url } : {}),
    ...(result.message ? { message: result.message, videos_checked: progress.checked.size } : {})
  });
}

router.route("/ownership-email")
  .options(externalCors)
  .get(externalCors, requireOwnershipKey, lookup)
  .post(externalCors, requireOwnershipKey, express.json(), lookup);

router.use("/ownership-email", (error, _req, res, next) => {
  if (!["entity.parse.failed", "entity.too.large"].includes(error.type)) return next(error);
  res.status(error.status).json({ status: MANUAL, message: error.type === "entity.too.large" ? "Request body too large." : "Invalid JSON body." });
});

module.exports = router;
