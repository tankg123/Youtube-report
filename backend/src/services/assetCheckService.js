const service = require("./assetDeliveryService");
const { getOwnershipContact, getOwnershipContacts } = require("./ownershipContactService");
const store = require("./deliveryStore");

const RIGHTS_TYPES = ["general", "mechanical", "performance", "synchronization"];
const SEARCH_TYPES = new Set(["sound_recording", "music_video", "art_track_video", "composition", "web", "movie", "episode"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function textList(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(text).filter(Boolean))];
}

function errorWithStatus(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function contextFor(networkId) {
  const id = Number(networkId);
  if (!Number.isSafeInteger(id) || id < 1) throw errorWithStatus("Select a connected CMS.");
  return service.authContext(id);
}

// assetSearch supports MINE and NONE. An owned match can appear on a different page
// from its unrestricted match, so exhaust the owned cursor before returning outside assets.
async function excludeOwnedAssets(ctx, items, filters) {
  const remaining = new Set(items.map((item) => item.id));
  const seenTokens = new Set();
  let pageToken = "";
  while (remaining.size) {
    const { data } = await service.partnerRequest(ctx, "GET", "/assetSearch", {
      params: {
        ...filters, ownershipRestriction: "MINE", fields: "items(id),nextPageToken",
        ...(pageToken ? { pageToken } : {})
      }
    });
    for (const item of data?.items || []) remaining.delete(item.id);
    pageToken = text(data?.nextPageToken);
    if (!pageToken || !remaining.size) break;
    if (seenTokens.has(pageToken)) throw errorWithStatus("YouTube could not finish checking asset ownership.", 502);
    seenTokens.add(pageToken);
  }
  return items.filter((item) => remaining.has(item.id));
}

function searchFilters({ artist, scope, type = "" }) {
  const name = text(artist).normalize("NFC");
  if (!name || name.length > 200 || /[:,\r\n]/.test(name)) {
    throw errorWithStatus("Enter one artist name without commas or colons (up to 200 characters).");
  }
  if (!["all", "owned", "external"].includes(scope)) throw errorWithStatus("Select an asset scope.");
  if (type !== "" && !SEARCH_TYPES.has(type)) throw errorWithStatus("Select a valid asset type.");
  return { metadataSearchFields: `artist:${name}`, ...(type ? { type } : {}) };
}

async function searchPage(ctx, filters, scope, pageToken, ownedIds) {
  const { data } = await service.partnerRequest(ctx, "GET", "/assetSearch", {
    params: {
      ...filters,
      ownershipRestriction: scope === "owned" ? "MINE" : "NONE",
      ...(pageToken ? { pageToken } : {}),
      fields: "items(id,type,title,customId,isrc,isrcs,timeCreated),pageInfo(totalResults),nextPageToken"
    }
  });
  const matches = (data?.items || []).filter((item) => text(item.id));
  let visible = matches;
  if (ownedIds) visible = matches.filter((item) => !ownedIds.has(item.id));
  else if (scope === "external") visible = await excludeOwnedAssets(ctx, matches, filters);
  const items = visible.map((item) => ({
    id: item.id,
    title: text(item.title),
    type: text(item.type),
    isrcs: textList([...(item.isrcs || []), item.isrc]),
    custom_id: text(item.customId),
    created_at: text(item.timeCreated)
  }));
  return {
    items,
    total: scope === "external" ? null : data?.pageInfo?.totalResults ?? null,
    next_page_token: text(data?.nextPageToken) || null
  };
}

async function searchArtistAssets(query) {
  const filters = searchFilters(query);
  return searchPage(await contextFor(query.networkId), filters, query.scope, text(query.pageToken));
}

async function* matchingPages(ctx, filters, scope, signal, ownedIds) {
  const seen = new Set();
  let pending = searchPage(ctx, filters, scope, "", ownedIds);
  while (pending) {
    signal?.throwIfAborted();
    const page = await pending;
    const next = page.next_page_token;
    if (seen.has(next)) throw errorWithStatus("YouTube returned a repeated asset page. Please retry the search.", 502);
    seen.add(next);
    // Only the next cursor page is buffered while this page's details are being written.
    pending = next ? searchPage(ctx, filters, scope, next, ownedIds) : null;
    pending?.catch(() => {}); // consumed on the next iteration, or cancelled by the caller
    yield page.items;
  }
}

function groupOwnership(ownership, submittingOwner = "") {
  const owners = new Map();
  for (const type of RIGHTS_TYPES) {
    for (const entry of ownership?.[type] || []) {
      const ownerId = text(entry.owner) || text(submittingOwner);
      const territories = textList(entry.territories);
      const exclude = entry.type === "exclude";
      // An empty exclusion list grants worldwide rights. A zero share removes rights.
      if (!ownerId || entry.ratio === 0 || (!exclude && !territories.length)) continue;
      if (!owners.has(ownerId)) owners.set(ownerId, []);
      owners.get(ownerId).push(exclude ? { type, territories, exclude: true } : { type, territories });
    }
  }
  return owners;
}

const ASSET_ID = /^[A-Za-z0-9_-]{3,64}$/;
const EFFECTIVE_FIELDS = { fetchMetadata: "effective", fetchOwnership: "effective" };

async function getAssetOwnership({ networkId, assetId }) {
  const id = text(assetId);
  if (!ASSET_ID.test(id)) throw errorWithStatus("A valid asset ID is required.");
  const ctx = await contextFor(networkId);
  const asset = await readAssetWithOwnership(ctx, id);
  return describeAsset(asset, (ownerId) => getOwnershipContact(ctx, ownerId));
}

async function readAssetWithOwnership(ctx, id) {
  const { data: asset } = await service.partnerRequest(ctx, "GET", `/assets/${encodeURIComponent(id)}`, {
    params: EFFECTIVE_FIELDS
  });
  if (!asset?.id) throw errorWithStatus("Asset not found in this CMS.", 404);
  return asset;
}

async function describeAsset(asset, loadContact, { strictContacts = false } = {}) {
  const metadata = asset.metadataEffective || {};
  const owners = await service.mapWithConcurrency([...groupOwnership(asset.ownershipEffective)], 3, async ([ownerId, rights]) => {
    try {
      return { ...await loadContact(ownerId), rights };
    } catch (error) {
      if (strictContacts) throw error;
      return { owner_id: ownerId, name: "", email: null, contact_error: store.errorMessage(error), rights };
    }
  });
  return {
    asset: {
      id: asset.id,
      title: text(metadata.title),
      artists: textList(metadata.artist),
      type: text(asset.type),
      isrc: text(metadata.isrc),
      upc: text(metadata.upc),
      custom_id: text(metadata.customId),
      record_label: text(metadata.label),
      album: text(metadata.album),
      labels: textList(asset.label),
      created_at: text(asset.timeCreated)
    },
    owners
  };
}

async function* iterateExportAssets({ networkId, items, filter, excludedIds = [], signal }) {
  if (!filter && (!Array.isArray(items) || !items.length)) throw errorWithStatus("Select at least one asset to export.");
  const filters = filter ? searchFilters(filter) : null;
  if (!Array.isArray(excludedIds) || excludedIds.some((id) => typeof id !== "string" || !ASSET_ID.test(id))) {
    throw errorWithStatus("A valid asset ID is required.");
  }
  if (!filters && items.some((item) => !ASSET_ID.test(text(item?.id)))) throw errorWithStatus("A valid asset ID is required.");
  const work = new AbortController();
  const ctx = { ...await contextFor(networkId), signal: signal ? AbortSignal.any([signal, work.signal]) : work.signal };
  try {
    yield* exportPages(ctx, { items, filter, filters, excludedIds });
  } finally {
    work.abort();
  }
}

function batches(values, size) {
  const result = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

async function* exportPages(ctx, { items, filter, filters, excludedIds }) {
  const { signal } = ctx;
  const contacts = new Map();
  let ownedIds;
  if (filter?.scope === "external") {
    ownedIds = new Set();
    for await (const owned of matchingPages(ctx, filters, "owned", signal)) {
      for (const item of owned) ownedIds.add(item.id);
    }
  }
  const pages = filters ? matchingPages(ctx, filters, filter.scope, signal, ownedIds) : batches(items, 500);
  const seen = new Set(excludedIds);
  let count = 0;
  for await (const page of pages) {
    const selected = [];
    for (const item of page) {
      const id = text(item.id);
      if (seen.has(id)) continue;
      seen.add(id);
      selected.push(item);
    }
    yield* describePage(ctx, selected, contacts);
    count += selected.length;
  }
  if (!count) throw errorWithStatus("Select at least one asset to export.");
}

const EXPORT_FIELDS = "items(id,aliasId,type,timeCreated,label,metadataEffective(title,artist,isrc,upc,customId,label,album)," +
  "ownershipEffective(general(owner,type,ratio,territories),mechanical(owner,type,ratio,territories),performance(owner,type,ratio,territories),synchronization(owner,type,ratio,territories)))";

async function* describePage(ctx, selected, contacts) {
  const byId = new Map();
  const ownerIds = new Set();
  // assets.list accepts up to 50 IDs. Keep a bounded number of requests in flight.
  await service.mapWithConcurrency(batches(selected, 50), 5, async (batch) => {
    const { data } = await service.partnerRequest(ctx, "GET", "/assets", {
      params: { ...EFFECTIVE_FIELDS, fields: EXPORT_FIELDS, id: batch.map((item) => text(item.id)).join(",") }
    });
    for (const asset of data?.items || []) {
      for (const id of [asset.id, ...textList(asset.aliasId)]) byId.set(id, asset);
      for (const id of groupOwnership(asset.ownershipEffective).keys()) {
        if (!contacts.has(id)) ownerIds.add(id);
      }
    }
  });
  await service.mapWithConcurrency(batches([...ownerIds], 50), 3, async (ids) => {
    const found = await getOwnershipContacts(ctx, ids);
    for (const [id, owner] of found) contacts.set(id, owner);
  });
  for (const snippet of selected) {
    ctx.signal.throwIfAborted();
    const id = text(snippet.id);
    const raw = byId.get(id);
    const detail = raw ? await describeAsset(raw, (id) => contacts.get(id)) : null;
    const asset = detail?.asset || {};
    yield {
      ...asset, id,
      title: asset.title || text(snippet.title),
      custom_id: asset.custom_id || text(snippet.custom_id),
      type: asset.type || text(snippet.type),
      created_at: asset.created_at || text(snippet.created_at),
      isrcs: textList([...textList(snippet.isrcs), asset.isrc]),
      owners: detail?.owners || [],
      missing: !raw
    };
  }
}

async function loadSelectedAssets(options) {
  const details = [];
  for await (const asset of iterateExportAssets(options)) details.push(asset);
  return details;
}

module.exports = { describeAsset, getAssetOwnership, groupOwnership, iterateExportAssets, loadSelectedAssets, readAssetWithOwnership, searchArtistAssets };
