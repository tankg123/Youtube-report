const service = require("./assetDeliveryService");
const { describeAsset } = require("./assetCheckService");
const { claimSearchPages } = require("./claimManagerService");
const { getOwnershipContact } = require("./ownershipContactService");
const store = require("./deliveryStore");
const { recordLookup, cmsNameKey, findChannelContact } = require("./ownershipDirectory");

const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const DATA_API = "https://www.googleapis.com/youtube/v3/";
const CHANNEL_PAGE_SIZE = 5;
const VIDEO_FIELDS = "items(id,snippet(title,channelId,channelTitle),contentDetails/licensedContent)";

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function titleKey(title) {
  return String(title || "").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}

function optionalReadDenied(error) {
  return [403, 404].includes(Number(error.status)) && !store.isQuotaReason(error.reason) && !store.isCmsCredentialError(error);
}

async function lookupOwnershipEmail({ networkId, id, pageToken, scan }) {
  const input = typeof id === "string" ? id.trim() : "";
  const isChannel = CHANNEL_ID.test(input);
  if (!isChannel && !VIDEO_ID.test(input)) throw invalid("Enter a valid YouTube channel ID or video ID.");
  if (!Number.isSafeInteger(Number(networkId)) || Number(networkId) < 1) throw invalid("Select a connected CMS.");
  if (pageToken != null && (!isChannel || typeof pageToken !== "string" || pageToken.length > 512)) {
    throw invalid("Invalid uploads page token.");
  }
  const { signal } = scan || {};
  signal?.throwIfAborted();
  const ctx = scan?.ctx || { ...await service.authContext(Number(networkId)), signal };
  signal?.throwIfAborted();
  if (scan) scan.ctx = ctx;
  const get = async (path, params) => (await service.partnerRequest(ctx, "GET", path, { params })).data;
  const contacts = scan?.contacts || new Map();
  function contact(ownerId) {
    if (!contacts.has(ownerId)) contacts.set(ownerId, getOwnershipContact(ctx, ownerId));
    return contacts.get(ownerId);
  }

  const warnings = new Set();
  function noteFailure(warnings, error) {
    signal?.throwIfAborted();
    if (scan && !optionalReadDenied(error)) throw error;
    warnings.add(store.errorMessage(error));
  }
  const videoData = (ids) => get(DATA_API + "videos", {
    part: "snippet,contentDetails", fields: VIDEO_FIELDS, id: ids.join(",")
  });
  let videos = [];
  let channelId = input;
  if (!isChannel) {
    const video = (await videoData([input])).items?.find((item) => item.id === input);
    if (!video) throw invalid("YouTube could not find a video visible to this CMS for that ID.", 404);
    videos = [video];
    channelId = video.snippet.channelId;
  }
  let channel = scan?.channel;
  const channelParams = { id: channelId, part: "snippet,contentDetails,contentOwnerDetails",
    fields: "items(id,snippet/title,contentDetails/relatedPlaylists/uploads,contentOwnerDetails/contentOwner)" };
  try {
    if (!channel) channel = (await get(DATA_API + "channels", channelParams)).items?.[0];
  } catch (error) {
    if (!optionalReadDenied(error)) throw error;
    channel = (await get(DATA_API + "channels", {
      id: channelId, part: "snippet,contentDetails", fields: "items(id,snippet/title,contentDetails/relatedPlaylists/uploads)"
    })).items?.[0];
  }
  if (isChannel && !channel) throw invalid("YouTube could not find a channel visible to this CMS for that ID.", 404);
  if (scan) scan.channel = channel;
  const managerId = channel?.contentOwnerDetails?.contentOwner;
  let manager = null;
  if (managerId) {
    try {
      manager = await contact(managerId);
    } catch (error) {
      manager = { owner_id: managerId, name: "", email: null };
      noteFailure(warnings, error);
    }
  }

  let nextPageToken = null;
  const channelInfo = { id: channelId, title: channel?.snippet?.title || videos[0]?.snippet?.channelTitle || channelId, manager };
  if (scan && manager?.email && cmsNameKey(manager.name) === scan.target) {
    signal.throwIfAborted();
    const direct = { channel: channelInfo, videos: [], next_page_token: null, warnings: [...warnings] };
    const saved = recordLookup(direct, isChannel);
    if (findChannelContact(channelId, scan.target)?.email) return { ...direct, ...saved };
  }
  if (isChannel) {
    const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (playlistId) {
      try {
        const playlist = await get(DATA_API + "playlistItems", {
          playlistId, part: "contentDetails", fields: "items(contentDetails/videoId),nextPageToken",
          maxResults: CHANNEL_PAGE_SIZE, ...(pageToken ? { pageToken } : {})
        });
        const ids = (playlist.items || []).map((item) => item.contentDetails.videoId).filter((value) => VIDEO_ID.test(value));
        const items = ids.length ? (await videoData(ids)).items || [] : [];
        videos = ids.map((videoId) => items.find((item) => item.id === videoId && item.snippet?.channelId === channelId)).filter(Boolean);
        nextPageToken = playlist.nextPageToken || null;
      } catch (error) {
        if (!optionalReadDenied(error)) throw error;
        warnings.add("The uploads playlist is unavailable to this CMS.");
      }
    } else warnings.add("The uploads playlist is unavailable to this CMS.");
  }

  const byVideo = new Map(videos.map((video) => [video.id, new Set()]));
  if (videos.length) {
    try {
      const result = await claimSearchPages(ctx, {
        videoId: [...byVideo.keys()].join(","), includeThirdPartyClaims: true, partnerUploaded: true, status: "ACTIVE",
        fields: "items(videoId,assetId,isPartnerUploaded,origin,status),nextPageToken"
      });
      for (const claim of result.items) {
        const origin = claim.origin?.source || claim.origin || "";
        // An explicit audio/video match identifies rights in the matched material.
        if (!byVideo.has(claim.videoId) || !claim.assetId || String(claim.status).toLowerCase() !== "active") continue;
        if (["cmsUpload", "webUpload", "dropboxUpload"].includes(origin) ||
            (claim.isPartnerUploaded === true && !/match|audioSwap/i.test(origin))) {
          byVideo.get(claim.videoId).add(claim.assetId);
        }
      }
      if (result.truncated) warnings.add("YouTube returned more upload claims than could be checked.");
    } catch (error) {
      noteFailure(warnings, error);
    }
  }

  const assets = scan?.assets || new Map();
  function assetDetail(assetId) {
    if (!assets.has(assetId)) {
      assets.set(assetId, get("/assets/" + encodeURIComponent(assetId), {
        fetchMetadata: "effective", fetchOwnership: "effective"
      }).then(async (raw) => {
        if (!raw?.id) throw invalid("Asset not found in this CMS.", 404);
        const { asset, owners } = await describeAsset(raw, contact, { strictContacts: Boolean(scan) });
        return { id: asset.id, title: asset.title, owners: owners.map(({ rights, ...owner }) => owner) };
      }));
    }
    return assets.get(assetId);
  }
  async function inspect(video) {
    const title = video.snippet.title;
    const matches = new Map([...byVideo.get(video.id)].map((assetId) => [assetId, { evidence: "upload_claim" }]));
    const errors = new Set();
    if (!matches.size && titleKey(title)) {
      try {
        const data = await get("/assetSearch", {
          q: title, type: "web", ownershipRestriction: "NONE", fields: "items(id,title),nextPageToken"
        });
        const key = titleKey(title);
        for (const item of data.items || []) {
          if (!item.id || titleKey(item.title) !== key || matches.has(item.id)) continue;
          if (matches.size === 5) {
            errors.add("Showing the first five same-title assets for this video.");
            break;
          }
          matches.set(item.id, { title: item.title, evidence: "title" });
        }
        if (data.nextPageToken) errors.add("Title matching covers the first page of Web assets.");
      } catch (error) {
        noteFailure(errors, error);
      }
    }
    const found = await service.mapWithConcurrency([...matches], 2, async ([assetId, match]) => {
      let evidence = match.evidence;
      let asset = { id: assetId, title: match.title || "", owners: [] };
      if (evidence === "title") {
        try {
          let token;
          const seen = new Set();
          for (let page = 0; page < 3; page += 1) {
            const refs = await get("/references", {
              assetId, fields: "items(videoId),nextPageToken", ...(token ? { pageToken: token } : {})
            });
            if (refs.items?.some((ref) => ref.videoId === video.id)) {
              evidence = "reference_video";
              break;
            }
            token = refs.nextPageToken;
            if (!token) break;
            if (seen.has(token) || page === 2) {
              if (scan) errors.add("Some asset references could not be verified.");
              break;
            }
            seen.add(token);
          }
        } catch (error) {
          if (scan || !optionalReadDenied(error)) noteFailure(errors, error);
        }
      }
      // The public API needs a verified link before spending calls on an asset and its owners.
      if (!scan || evidence !== "title") {
        try {
          asset = await assetDetail(assetId);
        } catch (error) {
          noteFailure(errors, error);
        }
      }
      const url = new URL("https://studio.youtube.com/asset/" + encodeURIComponent(asset.id) + "/ownership");
      url.searchParams.set("o", ctx.contentOwnerId);
      return { ...asset, evidence, ownership_url: url.href };
    });
    return { id: video.id, title, licensed: video.contentDetails?.licensedContent === true, assets: found, warnings: [...errors] };
  }
  const result = {
    channel: channelInfo,
    videos: [], next_page_token: nextPageToken, warnings: [...warnings]
  };
  if (scan) {
    // Upload claims link directly to assets. Check them before any same-title reference searches.
    const linked = videos.filter((video) => byVideo.get(video.id).size);
    result.videos = await service.mapWithConcurrency(linked, 2, inspect);
    const matched = result.videos.some((video) => video.assets.some((asset) =>
      asset.owners.some((owner) => owner.email && cmsNameKey(owner.name) === scan.target)));
    if (matched) {
      signal.throwIfAborted();
      const saved = recordLookup(result, isChannel);
      if (findChannelContact(channelId, scan.target)?.email) return { ...result, ...saved };
    }
    const remaining = videos.filter((video) => !byVideo.get(video.id).size);
    result.videos.push(...await service.mapWithConcurrency(remaining, 2, inspect));
  } else {
    result.videos = await service.mapWithConcurrency(videos, 2, inspect);
  }
  signal?.throwIfAborted();
  return { ...result, ...recordLookup(result, isChannel) };
}

module.exports = { lookupOwnershipEmail };

