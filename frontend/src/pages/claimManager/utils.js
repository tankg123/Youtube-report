// Pure helpers for the Claim Manager page. No React / DOM / lucide imports so
// `node --test frontend/tests/claimManagerUtils.test.mjs` can import this file
// directly (the explicit ".js" extension is required by node's ESM resolver).
import {
  CLAIM_ORIGINS,
  CLAIM_STATUS_META,
  CONFIRMABLE_STATUSES,
  CONFIRM_BLOCK_DEFAULT,
  CONTENT_TYPES,
  DEFAULT_LIMITS,
  REINSTATE_BLOCK_DEFAULT,
  RELEASABLE_STATUSES,
  RELEASE_BATCH_SIZE,
  RELEASE_OUTCOMES,
  RELEASE_OUTCOME_META,
  RELEASE_UNKNOWN_STATUS,
  SEARCH_MODES
} from "./constants.js";
// t() renders a sentence in the current language (call time), tk() marks a canonical English text kept
// in a row / result (rendered with tm()), tm() translates a server message.
import { t, tk, tm } from "../../i18n/index.js";

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ID_GROUP = "([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])";
// youtu.be/ID · /shorts/ID · /live/ID · /embed/ID · /v/ID · /e/ID · studio.youtube.com/video/ID/edit
const VIDEO_PATH_RE = new RegExp(`(?:youtu\\.be/|/(?:shorts|live|embed|v|e|video)/)${ID_GROUP}`, "i");
// watch?v=ID · ?feature=share&v=ID · #v=ID · plain "v=ID"
const VIDEO_QUERY_RE = new RegExp(`(?:^|[?&#])vi?=${ID_GROUP}`);
const WRAPPER_RE = /^[<"'([]+|[>"')\],;.]+$/g;
const TOKEN_SPLIT_RE = /[\s,;|]+/;
// A token "looks like a link" when it mentions youtu.be / youtube.com / youtube-nocookie.com or
// carries v= (the backend's looksLikeVideoLink rule; "v=" alone is accepted because extractVideoId
// understands it).
const LINK_TOKEN_RE = /youtu\.be|youtube(?:-nocookie)?\.com|v=/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YouTube video id from a link or a bare 11-character id; null when none is found. */
export function extractVideoId(input) {
  const value = String(input ?? "").trim().replace(WRAPPER_RE, "");
  if (!value) return null;
  if (VIDEO_ID_RE.test(value)) return value;
  const match = value.match(VIDEO_PATH_RE) || value.match(VIDEO_QUERY_RE);
  return match ? match[1] : null;
}

/** True for tokens that look like a YouTube link (youtu.be / youtube.com / v=). */
export function isVideoLinkToken(token) {
  return LINK_TOKEN_RE.test(String(token ?? ""));
}

/**
 * Parse a textarea of video links / ids, one line at a time, with the backend's link
 * precedence per line: when a line contains a link token only the link tokens count (a title
 * pasted next to a link never becomes a bare id); otherwise every token is parsed on its own,
 * so every bare 11-character token counts (exactly like the backend's parseVideoInputs).
 * @returns {{ ids: string[], invalid: string[], duplicates: number }} unique ids in input order,
 *   the lines that contain no video id, and how many repeated ids were dropped.
 */
export function parseVideoInput(text) {
  const lines = Array.isArray(text) ? text.map((item) => String(item ?? "")) : String(text ?? "").split(/\r?\n/);
  const ids = [];
  const seen = new Set();
  const invalid = [];
  let duplicates = 0;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const tokens = trimmed.split(TOKEN_SPLIT_RE).filter(Boolean);
    const links = tokens.filter(isVideoLinkToken);
    const candidates = (links.length ? links : tokens).map(extractVideoId);
    let found = false;
    candidates.forEach((id) => {
      if (!id) return;
      found = true;
      if (seen.has(id)) {
        duplicates += 1;
        return;
      }
      seen.add(id);
      ids.push(id);
    });
    if (!found) invalid.push(trimmed);
  });
  return { ids, invalid, duplicates };
}

/** Split asset / claim ids on whitespace, commas, semicolons and pipes; trimmed, unique, order kept. */
export function parseIdList(text) {
  const parts = Array.isArray(text) ? text : String(text ?? "").split(TOKEN_SPLIT_RE);
  const seen = new Set();
  const ids = [];
  parts.forEach((part) => {
    const value = String(part ?? "").trim().replace(WRAPPER_RE, "");
    if (!value || seen.has(value)) return;
    seen.add(value);
    ids.push(value);
  });
  return ids;
}

export function modeMeta(mode) {
  return SEARCH_MODES.find((item) => item.key === mode) || SEARCH_MODES[0];
}

export function isSearchMode(mode) {
  return SEARCH_MODES.some((item) => item.key === mode);
}

/** Parse the text of the active mode: `{ ids, invalid, duplicates, query }`. */
export function parseSearchInput(mode, text) {
  if (mode === "videos") return { ...parseVideoInput(text), query: "" };
  if (mode === "assets" || mode === "claims") return { ids: parseIdList(text), invalid: [], duplicates: 0, query: "" };
  return { ids: [], invalid: [], duplicates: 0, query: String(text ?? "").trim() };
}

/** Add `value` to the list when missing, remove it when present (chip toggles). */
export function toggleInList(list, value) {
  const items = Array.isArray(list) ? list : [];
  return items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
}

/** Remove every line of `text` that is listed in `lines` (exact trimmed match). */
export function removeLines(text, lines = []) {
  const drop = new Set(lines.map((line) => String(line).trim()));
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !drop.has(line.trim()))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Search validation / payload / request plan
// ---------------------------------------------------------------------------

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${Number(count) === 1 ? singular : plural}`;
}

/** `one` / `many` are "{count} …" keys (tk-marked by the caller); the whole phrase is translated with the count filled in. */
function countText(count, one, many) {
  return t(Number(count) === 1 ? one : many, { count });
}

export function effectiveLimits(limits) {
  return { ...DEFAULT_LIMITS, ...(limits && typeof limits === "object" ? limits : {}) };
}

export function modeLimit(mode, limits) {
  const meta = modeMeta(mode);
  return meta.limitKey ? Number(effectiveLimits(limits)[meta.limitKey]) || 0 : 0;
}

function validateDateRange(after, before, label) {
  if (after && !DATE_RE.test(after)) return t("{label} \"after\" date must be YYYY-MM-DD.", { label: t(label) });
  if (before && !DATE_RE.test(before)) return t("{label} \"before\" date must be YYYY-MM-DD.", { label: t(label) });
  if (after && before && after > before) return t("{label} date range is reversed: \"after\" {after} is later than \"before\" {before}.", { label: t(label), after, before });
  return "";
}

/** Human validation message for the search form, "" when the search can run. */
export function validateSearch({ mode, networkIds = [], parsed = { ids: [] }, limits, filters = {} }) {
  const meta = modeMeta(mode);
  const max = effectiveLimits(limits);
  if (!networkIds.length) return t("Select at least one CMS network.");
  if (mode === "explore" && networkIds.length !== 1) return t("Explore works with exactly one CMS: keep only one selected.");
  if (networkIds.length > max.max_networks) return t("Select at most {max} CMS networks per search.", { max: max.max_networks });
  // The backend refuses an explore without text and filters (it would list a whole CMS): say so before sending.
  if (mode === "explore" && !String(parsed.query || "").trim() && !countActiveFilters(filters)) {
    return t("Enter a search text or at least one filter to explore claims.");
  }
  if (meta.limitKey) {
    const limit = Number(max[meta.limitKey]) || 0;
    const count = parsed.ids.length;
    if (!count) {
      return mode === "videos" ? t("Enter at least one YouTube video link or 11-character video ID.") : t("Enter at least one {item}.", { item: t(meta.noun) });
    }
    if (limit && count > limit) return t("Use at most {limit} unique {items} per search (currently {count}).", { limit, items: t(meta.plural), count });
  }
  return (
    validateDateRange(filters.created_after, filters.created_before, tk("Created")) ||
    validateDateRange(filters.status_modified_after, filters.status_modified_before, tk("Status modified")) ||
    ""
  );
}

/** Drop empty filter values; `sort` is only meaningful for explore. */
export function cleanFilters(filters = {}, mode) {
  const list = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
  const output = {};
  if (list(filters.statuses).length) output.statuses = list(filters.statuses);
  if (list(filters.content_types).length) output.content_types = list(filters.content_types);
  if (list(filters.origins).length) output.origins = list(filters.origins);
  ["created_after", "created_before", "status_modified_after", "status_modified_before"].forEach((key) => {
    if (filters[key]) output[key] = filters[key];
  });
  if (filters.partner_uploaded === true || filters.partner_uploaded === false) output.partner_uploaded = filters.partner_uploaded;
  if (mode === "explore" && filters.sort) output.sort = filters.sort;
  return output;
}

/** Number of filters that narrow the search (the explore sort does not count). */
export function countActiveFilters(filters = {}) {
  return Object.keys(cleanFilters(filters, "videos")).length;
}

/** Request body for POST /content-id/claims/search. */
export function buildSearchPayload({ mode, networkIds = [], parsed = { ids: [] }, query = "", filters = {}, includeDetails = true, pageToken = "" }) {
  const payload = { network_ids: networkIds.map(Number), mode, include_details: Boolean(includeDetails) };
  if (mode === "videos") payload.videos = parsed.ids;
  else if (mode === "assets") payload.asset_ids = parsed.ids;
  else if (mode === "claims") payload.claim_ids = parsed.ids;
  else if (mode === "explore") {
    const text = String(query || "").trim();
    if (text) payload.query = text;
    if (pageToken) payload.page_token = pageToken;
  }
  const cleaned = cleanFilters(filters, mode);
  if (Object.keys(cleaned).length) payload.filters = cleaned;
  return payload;
}

/** Request-count estimate shown under the search form (not quota units). */
export function buildRequestPlan({ mode, count = 0, networkCount = 0, includeDetails = false, limits }) {
  const max = effectiveLimits(limits);
  const batch = Math.max(1, Number(max.video_batch_size) || DEFAULT_LIMITS.video_batch_size);
  if (!networkCount) return { reads: 0, detailReads: 0, text: t("Select a CMS network to estimate the request plan.") };
  if (!count && mode !== "explore") return { reads: 0, detailReads: 0, text: t("Enter {items} to estimate the request plan.", { items: t(modeMeta(mode).plural) }) };

  let reads;
  let text;
  if (mode === "videos") {
    reads = Math.ceil(count / batch) * networkCount;
    text = t("{items} × {networks} CMS ⇒ {reads}", {
      items: countText(count, tk("{count} video"), tk("{count} videos")),
      networks: networkCount,
      reads: countText(reads, tk("{count} claim-search read"), tk("{count} claim-search reads"))
    });
  } else if (mode === "assets") {
    reads = count * networkCount;
    text = t("{items} × {networks} CMS ⇒ {reads}", {
      items: countText(count, tk("{count} asset ID"), tk("{count} asset IDs")),
      networks: networkCount,
      reads: countText(reads, tk("{count} claim-search read"), tk("{count} claim-search reads"))
    });
  } else if (mode === "claims") {
    reads = Math.ceil(count / batch) * networkCount;
    text = t("{items} × {networks} CMS ⇒ {reads}", {
      items: countText(count, tk("{count} claim ID"), tk("{count} claim IDs")),
      networks: networkCount,
      reads: countText(reads, tk("{count} claim read"), tk("{count} claim reads"))
    });
  } else {
    reads = 1;
    text = t("1 claim-search read per page");
  }

  let detailReads = 0;
  if (includeDetails) {
    detailReads = mode === "videos" ? Math.ceil(count / 50) : 1;
    text =
      mode === "videos"
        ? t("{plan} + {reads} + asset reads", { plan: text, reads: countText(detailReads, tk("{count} video-detail read"), tk("{count} video-detail reads")) })
        : t("{plan} + video & asset detail reads", { plan: text });
  }
  return { reads, detailReads, text };
}

// ---------------------------------------------------------------------------
// Claim rows
// ---------------------------------------------------------------------------

/** "networkId:claimId" — accepts a claim-like object or the two ids. */
export function claimKey(networkId, claimId) {
  if (networkId && typeof networkId === "object") {
    const row = networkId;
    return row.key || `${row.network_id}:${row.claim_id}`;
  }
  return `${networkId}:${claimId}`;
}

export function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

export function statusLabel(status) {
  const key = normalizeStatus(status);
  if (!key) return tk("Unknown");
  return CLAIM_STATUS_META[key]?.label || key.replace(/_/g, " ");
}

export function statusTone(status) {
  return CLAIM_STATUS_META[normalizeStatus(status)]?.tone || "slate";
}

export function contentTypeLabel(value) {
  if (!value) return "";
  return CONTENT_TYPES.find((item) => item.value === value)?.label || String(value);
}

export function originLabel(value) {
  if (!value) return "";
  if (typeof value === "object") return originLabel(value.source || value.type || value.name || "");
  return CLAIM_ORIGINS.find((item) => item.value === value)?.label || String(value);
}

export function outcomeLabel(outcome) {
  return RELEASE_OUTCOME_META[outcome]?.label || String(outcome || "").replace(/_/g, " ") || tk("Unknown");
}

export function videoUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
}

export function videoTitle(claim) {
  return claim?.video_title || claim?.video?.title || claim?.video_id || t("Untitled video");
}

/** True when the row can be sent to the release endpoint right now. */
export function isReleasable(claim) {
  return Boolean(claim?.can_release) && normalizeStatus(claim?.status) !== RELEASE_UNKNOWN_STATUS;
}

/** Tooltip for a row that cannot be released. */
export function releaseBlockReason(claim) {
  if (!claim) return "";
  if (isReleasable(claim)) return "";
  if (claim.release_block_reason) return claim.release_block_reason;
  if (normalizeStatus(claim.status) === RELEASE_UNKNOWN_STATUS) return tk("Release outcome unknown: re-check the claim status first");
  return t("Claims in {status} status cannot be released", { status: t(statusLabel(claim.status)).toLowerCase() });
}

/** True when the row can be sent to the reinstate endpoint right now: an inactive claim the server lets this user touch. */
export function isReinstatable(claim) {
  return Boolean(claim?.can_reinstate) && normalizeStatus(claim?.status) === "inactive";
}

/** Tooltip for a row that cannot be reinstated. */
export function reinstateBlockReason(claim) {
  if (!claim) return "";
  if (isReinstatable(claim)) return "";
  if (claim.reinstate_block_reason) return claim.reinstate_block_reason;
  if (normalizeStatus(claim.status) === RELEASE_UNKNOWN_STATUS) return tk("Outcome unknown: re-check the claim status first");
  return REINSTATE_BLOCK_DEFAULT;
}

/**
 * True when the row can be sent to the confirm endpoint right now: a potential claim (a match
 * awaiting confirmation) the server lets this user touch. Rows from an older server carry no
 * `can_confirm`; they fall back to `can_release`, which answers the same label check.
 */
export function isConfirmable(claim) {
  if (!claim || !CONFIRMABLE_STATUSES.includes(normalizeStatus(claim.status))) return false;
  return typeof claim.can_confirm === "boolean" ? claim.can_confirm : Boolean(claim.can_release);
}

/** Tooltip for a row that cannot be confirmed. */
export function confirmBlockReason(claim) {
  if (!claim) return "";
  if (isConfirmable(claim)) return "";
  if (claim.confirm_block_reason) return claim.confirm_block_reason;
  if (normalizeStatus(claim.status) === RELEASE_UNKNOWN_STATUS) return tk("Outcome unknown: re-check the claim status first");
  return CONFIRM_BLOCK_DEFAULT;
}

/**
 * The write that sets this row active: "reinstate" for a released (inactive) claim, "confirm" for a
 * potential one, null when neither applies. "Activate" is the page's umbrella for both; each goes to
 * its own endpoint and audit action.
 */
export function activateActionOf(claim) {
  if (isReinstatable(claim)) return "reinstate";
  if (isConfirmable(claim)) return "confirm";
  return null;
}

/** True when the row can be set active right now (reinstated or confirmed). */
export function isActivatable(claim) {
  return activateActionOf(claim) !== null;
}

/** Tooltip for a row that cannot be activated: the reason of the write its status would need. */
export function activateBlockReason(claim) {
  if (!claim) return "";
  if (isActivatable(claim)) return "";
  const status = normalizeStatus(claim.status);
  if (status === "inactive") return reinstateBlockReason(claim);
  if (status === "potential") return confirmBlockReason(claim);
  if (status === RELEASE_UNKNOWN_STATUS) return tk("Outcome unknown: re-check the claim status first");
  return t("Only potential and released (inactive) claims can be activated; this claim is {status}", { status: t(statusLabel(status)).toLowerCase() });
}

/** Row checkbox rule: a row is selectable when at least one bulk button (Release / Activate) can take it. */
export function isSelectable(claim) {
  return isReleasable(claim) || isActivatable(claim);
}

const RESULT_ACTIONS = new Set(["release", "reinstate", "confirm"]);

/** The write a row's last outcome came from ("release" for rows from before the action tag). */
export function rowResultAction(claim) {
  const action = claim?.release_result?.action;
  return RESULT_ACTIONS.has(action) ? action : "release";
}

export function countByStatus(claims = []) {
  const counts = {};
  claims.forEach((claim) => {
    const status = normalizeStatus(claim?.status) || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}

/** Status keys present in `counts`, in the display order of CLAIM_STATUS_META. */
export function orderedStatuses(counts = {}) {
  return Object.keys(counts).sort((left, right) => {
    const a = CLAIM_STATUS_META[left]?.order ?? 99;
    const b = CLAIM_STATUS_META[right]?.order ?? 99;
    return a - b || left.localeCompare(right);
  });
}

function haystack(claim) {
  return [
    claim.claim_id,
    claim.video_id,
    claim.video_title,
    claim.video?.title,
    claim.video?.channel_title,
    claim.asset_id,
    claim.asset?.id,
    claim.asset?.title,
    claim.asset?.isrc,
    claim.asset?.upc,
    claim.asset?.custom_id,
    claim.network_name,
    ...(Array.isArray(claim.asset?.labels) ? claim.asset.labels : [])
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join(" \u0000 ")
    .toLowerCase();
}

/** Client-side quick filter (claim / video / asset / title / ISRC / UPC / label) + status chips. */
export function filterClaims(claims = [], { query = "", statuses = [] } = {}) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const statusSet = new Set((statuses || []).map(normalizeStatus).filter(Boolean));
  return claims.filter((claim) => {
    if (statusSet.size && !statusSet.has(normalizeStatus(claim.status))) return false;
    if (!terms.length) return true;
    const text = haystack(claim);
    return terms.every((term) => text.includes(term));
  });
}

const SORT_ACCESSORS = {
  created: (claim) => claim.time_created || "",
  modified: (claim) => claim.time_status_last_modified || claim.time_created || "",
  status: (claim) => CLAIM_STATUS_META[normalizeStatus(claim.status)]?.order ?? 99,
  video: (claim) => videoTitle(claim).toLowerCase(),
  claim: (claim) => String(claim.claim_id || "")
};

/** Stable sort; `sort` is `{ key, dir }` or null for the server order. */
export function sortClaims(claims = [], sort) {
  const accessor = sort && SORT_ACCESSORS[sort.key];
  if (!accessor) return claims;
  const direction = sort.dir === "desc" ? -1 : 1;
  return claims
    .map((claim, index) => ({ claim, index, value: accessor(claim) }))
    .sort((left, right) => {
      if (left.value < right.value) return -1 * direction;
      if (left.value > right.value) return 1 * direction;
      return left.index - right.index;
    })
    .map((item) => item.claim);
}

/** Header click cycle: none → asc → desc → none. */
export function toggleSort(current, key) {
  if (!current || current.key !== key) return { key, dir: "asc" };
  if (current.dir === "asc") return { key, dir: "desc" };
  return null;
}

export function paginate(items = [], page = 1, pageSize = 50) {
  const size = Math.max(1, Number(pageSize) || 1);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const start = (safePage - 1) * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: safePage, pageCount, total, start: total ? start + 1 : 0, end: start + slice.length };
}

function groupFromVideo(video) {
  return {
    video_id: video.video_id,
    video_url: video.video_url || videoUrl(video.video_id),
    title: video.title || video.video_id || t("Untitled video"),
    channel_title: video.channel_title || "",
    thumbnail: video.thumbnail || "",
    duration_text: video.duration_text || "",
    published_at: video.published_at || "",
    errors: Array.isArray(video.errors) ? video.errors : [],
    claims: []
  };
}

function groupFromClaim(claim) {
  return {
    video_id: claim.video_id,
    video_url: claim.video_url || videoUrl(claim.video_id),
    title: videoTitle(claim),
    channel_title: claim.video?.channel_title || "",
    thumbnail: claim.video?.thumbnail || "",
    duration_text: claim.video?.duration_text || "",
    published_at: claim.video?.published_at || "",
    errors: [],
    claims: []
  };
}

/**
 * Group claims by video. `videos` (mode "videos") fixes the group order and keeps videos
 * without claims; otherwise groups follow the first appearance of each video in `claims`.
 */
export function groupClaimsByVideo(claims = [], videos = [], { includeEmpty = true } = {}) {
  // Index the search's video blocks once (first block per id wins) instead of scanning them per claim.
  const videoById = new Map();
  (videos || []).forEach((video) => {
    if (video?.video_id && !videoById.has(video.video_id)) videoById.set(video.video_id, video);
  });
  const groups = new Map();
  if (includeEmpty) videoById.forEach((video, id) => groups.set(id, groupFromVideo(video)));
  claims.forEach((claim) => {
    const id = claim.video_id || "";
    if (!groups.has(id)) {
      const video = videoById.get(id);
      groups.set(id, video ? groupFromVideo(video) : groupFromClaim(claim));
    }
    groups.get(id).claims.push(claim);
  });
  return Array.from(groups.values()).map((group) => ({
    ...group,
    claim_count: group.claims.length,
    releasable_count: group.claims.filter(isReleasable).length,
    activatable_count: group.claims.filter(isActivatable).length
  }));
}

/** Split groups into pages of about `pageSize` claim rows without splitting a group (an empty group counts as one row). */
export function paginateGroups(groups = [], pageSize = 50) {
  const size = Math.max(1, Number(pageSize) || 1);
  const pages = [];
  let current = [];
  let rows = 0;
  groups.forEach((group) => {
    const weight = Math.max(1, group.claims?.length || 0);
    if (current.length && rows + weight > size) {
      pages.push(current);
      current = [];
      rows = 0;
    }
    current.push(group);
    rows += weight;
  });
  if (current.length || !pages.length) pages.push(current);
  return pages;
}

/** Keys of the first `max` claims that pass `predicate` (in order) and whether the limit cut the list. */
function selectKeys(claims, predicate, max) {
  const keys = [];
  let truncated = false;
  for (const claim of claims) {
    if (!predicate(claim)) continue;
    if (keys.length >= max) {
      truncated = true;
      break;
    }
    keys.push(claimKey(claim));
  }
  return { keys, truncated };
}

/** Keys of the first `max` releasable claims (in order) and whether the limit cut the list. */
export function selectReleasableKeys(claims = [], max = Infinity) {
  return selectKeys(claims, isReleasable, max);
}

/** Keys of the first `max` activatable claims (reinstate or confirm) and whether the limit cut the list. */
export function selectActivatableKeys(claims = [], max = Infinity) {
  return selectKeys(claims, isActivatable, max);
}

/**
 * Batches of an "activate" run: `[{ action: "reinstate" | "confirm", claims }]`, the released
 * (inactive) rows first, then the potential rows, each list chunked by `batchSize`. A batch never
 * mixes the two actions because each goes to its own endpoint; a row that neither write can take
 * (`activateActionOf` null) is left out.
 */
export function activateBatches(claims = [], batchSize = RELEASE_BATCH_SIZE) {
  const size = Math.max(1, Number(batchSize) || 1);
  const byAction = { reinstate: [], confirm: [] };
  (claims || []).forEach((claim) => {
    const action = activateActionOf(claim);
    if (action) byAction[action].push(claim);
  });
  const batches = [];
  ["reinstate", "confirm"].forEach((action) => {
    for (let index = 0; index < byAction[action].length; index += size) {
      batches.push({ action, claims: byAction[action].slice(index, index + size) });
    }
  });
  return batches;
}

/** Persisted CMS selection reconciled with the CMS that can currently be used; null = "never chosen" → all. */
export function reconcileNetworkIds(stored, eligibleIds = []) {
  const eligible = eligibleIds.map(Number).filter((id) => Number.isFinite(id));
  if (!Array.isArray(stored)) return eligible;
  const wanted = new Set(stored.map(Number));
  return eligible.filter((id) => wanted.has(id));
}

// ---------------------------------------------------------------------------
// Release flow
// ---------------------------------------------------------------------------

/** Release items; the titles / ISRC are stored in the audit row (the claims resource has no video title). */
export function buildReleaseItems(claims = []) {
  return claims.map((claim) => ({
    network_id: Number(claim.network_id),
    claim_id: String(claim.claim_id),
    video_id: claim.video_id || null,
    asset_id: claim.asset_id || claim.asset?.id || null,
    video_title: claim.video_title || claim.video?.title || "",
    channel_title: claim.video?.channel_title || "",
    asset_title: claim.asset?.title || "",
    isrc: claim.asset?.isrc || ""
  }));
}

/**
 * A claim-like row built from a release-history event (a released claim the operator wants to
 * reinstate from the history tab): enough for buildReleaseItems() and the confirm dialog. The log
 * knows the claim as inactive; the server re-reads it before writing, so a stale row is refused
 * ("skipped") rather than reinstated blindly.
 */
export function claimFromHistoryEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  return {
    key: claimKey(source.network_id, source.claim_id),
    network_id: source.network_id,
    network_name: source.network_name || "",
    content_owner_id: source.content_owner_id || "",
    claim_id: source.claim_id,
    video_id: source.video_id || null,
    video_url: source.video_url || videoUrl(source.video_id),
    video_title: source.video_title || "",
    video: { title: source.video_title || "", channel_title: source.channel_title || "" },
    asset_id: source.asset_id || null,
    asset: { id: source.asset_id || null, title: source.asset_title || "", isrc: source.isrc || "" },
    status: "inactive",
    can_release: false,
    release_block_reason: tk("Claims in inactive status cannot be released"),
    can_reinstate: true,
    reinstate_block_reason: "",
    can_confirm: false,
    confirm_block_reason: t("{reason}; this claim is {status}", { reason: t(CONFIRM_BLOCK_DEFAULT), status: t(statusLabel("inactive")).toLowerCase() })
  };
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

// Fields the server's bare claim (built from the claims resource) never carries reliably.
const ROW_PREFERRED_FIELDS = new Set(["key", "video", "video_title", "video_views", "engaged_views", "third_party"]);
// Fields that must follow the server whenever it answers (even "" for the block reasons).
const FRESH_AUTHORITATIVE_FIELDS = new Set([
  "status",
  "can_release",
  "release_block_reason",
  "can_reinstate",
  "reinstate_block_reason",
  "can_confirm",
  "confirm_block_reason",
  "time_status_last_modified"
]);

/**
 * Merge a claim returned by the server (release / reinstate / confirm / recheck / detail) over a
 * table row without losing what the row already knows: the row keeps `key`, `video`, `video_title`,
 * `video_views`, `engaged_views`, `third_party`, and any field (asset, policy, applied_policy,
 * match_info, ...) whose fresh value is null / "" / absent; `status`, the `can_*` flags, their
 * `*_block_reason` and `time_status_last_modified` always come from the fresh claim when present.
 */
export function mergeServerClaim(row, fresh) {
  const base = row && typeof row === "object" ? row : {};
  if (!fresh || typeof fresh !== "object") return base;
  const merged = { ...base };
  Object.entries(fresh).forEach(([field, value]) => {
    if (ROW_PREFERRED_FIELDS.has(field)) {
      if (!hasValue(base[field]) && hasValue(value)) merged[field] = value;
      return;
    }
    if (FRESH_AUTHORITATIVE_FIELDS.has(field)) {
      if (value !== undefined && value !== null) merged[field] = value;
      return;
    }
    if (hasValue(value)) merged[field] = value;
  });
  merged.key = base.key || fresh.key || claimKey(merged);
  return merged;
}

export function normalizeOutcome(outcome) {
  return RELEASE_OUTCOMES.includes(outcome) ? outcome : "unknown";
}

/** Synthetic results for a whole batch (client timeout → "unknown", request error → "failed"). */
export function outcomesForBatch(claims = [], outcome = "unknown", message = "", extra = {}) {
  return claims.map((claim) => ({
    key: claimKey(claim),
    network_id: claim.network_id,
    claim_id: claim.claim_id,
    outcome: normalizeOutcome(outcome),
    status: null,
    message,
    reason: extra.reason || null,
    retryable: Boolean(extra.retryable),
    retry_after: extra.retry_after ?? null,
    claim: null
  }));
}

/** One result per claim of the batch; a claim the server did not answer for becomes "unknown". */
export function reconcileBatchResults(claims = [], results = []) {
  const byKey = new Map();
  (Array.isArray(results) ? results : []).forEach((result) => {
    if (!result) return;
    const key = result.key || claimKey(result.network_id, result.claim_id);
    byKey.set(key, { ...result, key, outcome: normalizeOutcome(result.outcome) });
  });
  return claims.map(
    (claim) =>
      byKey.get(claimKey(claim)) ||
      outcomesForBatch([claim], "unknown", tk("The server returned no result for this claim. Re-check its status before retrying."))[0]
  );
}

/** Replace results that share a key, keeping the first-appearance order. */
export function mergeResultsByKey(existing = [], incoming = []) {
  const map = new Map(existing.map((result) => [result.key, result]));
  incoming.forEach((result) => map.set(result.key, result));
  return Array.from(map.values());
}

/** One counter per outcome (every RELEASE_OUTCOMES key, release and reinstate alike) plus `total`. */
export function summarizeRelease(results = []) {
  const summary = { total: 0 };
  RELEASE_OUTCOMES.forEach((outcome) => (summary[outcome] = 0));
  results.forEach((result) => {
    if (!result) return;
    summary.total += 1;
    summary[normalizeOutcome(result.outcome)] += 1;
  });
  return summary;
}

export function releaseSummaryText(summary) {
  const parts = [];
  if (summary.released) parts.push(t("{count} released", { count: summary.released }));
  if (summary.already_inactive) parts.push(t("{count} already inactive", { count: summary.already_inactive }));
  if (summary.reinstated) parts.push(t("{count} reinstated", { count: summary.reinstated }));
  if (summary.confirmed) parts.push(t("{count} confirmed", { count: summary.confirmed }));
  if (summary.already_active) parts.push(t("{count} already active", { count: summary.already_active }));
  if (summary.failed) parts.push(t("{count} failed", { count: summary.failed }));
  if (summary.unknown) parts.push(t("{count} to re-check", { count: summary.unknown }));
  if (summary.skipped) parts.push(t("{count} skipped", { count: summary.skipped }));
  return parts.length ? parts.join(" · ") : t("No claim was processed");
}

// Re-check message while the server is still writing the claim, per write (canonical English; rendered with tm()).
const IN_FLIGHT_MESSAGES = {
  release: tk("A release of this claim is still running on the server; re-check it in a minute."),
  reinstate: tk("A reinstate of this claim is still running on the server; re-check it in a minute."),
  confirm: tk("A confirm of this claim is still running on the server; re-check it in a minute.")
};

/**
 * Map a /recheck result onto the release-result shape used by the results panel. `action` is the
 * write the re-check follows up: after a release, inactive confirms it ("released"); after a
 * reinstate, active confirms it ("reinstated") and inactive means it did not go through; after a
 * confirm, active confirms it ("confirmed") and potential means it did not go through.
 */
export function recheckToOutcome(result, { action = "release" } = {}) {
  const write = action === "reinstate" || action === "confirm" ? action : "release";
  const key = result.key || claimKey(result.network_id, result.claim_id);
  const status = normalizeStatus(result.status || result.claim?.status);
  // The server's message describes the write it confirmed; when that is another action (an old
  // release settled while the operator follows up a reinstate), the wording below applies instead.
  if (result.confirmed && result.confirmed.action && result.confirmed.action !== write) result = { ...result, message: "" };
  const base = { key, network_id: result.network_id, claim_id: result.claim_id, status: status || null, claim: result.claim || null, reason: null, retry_after: null };
  const statusText = () => t(statusLabel(status)).toLowerCase();
  // The server is still writing this claim (queued or PATCH in flight): the status read back now
  // may be superseded within a minute, so the outcome stays unknown instead of "failed, retry it".
  if (result.in_flight) {
    return { ...base, outcome: "unknown", retryable: false, message: result.message || IN_FLIGHT_MESSAGES[write] };
  }
  if (!result.found) {
    return { ...base, outcome: "unknown", retryable: false, message: result.message || tk("Google could not find this claim. Check it in CMS.") };
  }
  if (write === "reinstate") {
    if (status === "active") {
      return { ...base, outcome: "reinstated", retryable: false, message: result.message || tk("Confirmed active by Google.") };
    }
    if (status === "inactive") {
      return { ...base, outcome: "failed", retryable: true, message: result.message || tk("Claim is still inactive: the reinstate did not go through. Retry it.") };
    }
    return { ...base, outcome: "failed", retryable: false, message: result.message || t("Claim is now {status} and cannot be reinstated.", { status: statusText() }) };
  }
  if (write === "confirm") {
    if (status === "active") {
      return { ...base, outcome: "confirmed", retryable: false, message: result.message || tk("Confirmed active by Google.") };
    }
    if (status === "potential") {
      return { ...base, outcome: "failed", retryable: true, message: result.message || tk("Claim is still potential: the confirm did not go through. Retry it.") };
    }
    return { ...base, outcome: "failed", retryable: false, message: result.message || t("Claim is now {status} and cannot be confirmed.", { status: statusText() }) };
  }
  if (status === "inactive") {
    return { ...base, outcome: "released", retryable: false, message: result.message || tk("Confirmed inactive by Google.") };
  }
  if (RELEASABLE_STATUSES.includes(status)) {
    return { ...base, outcome: "failed", retryable: true, message: result.message || t("Claim is still {status}: the release did not go through. Retry it.", { status: statusText() }) };
  }
  return { ...base, outcome: "failed", retryable: false, message: result.message || t("Claim is now {status} and cannot be released.", { status: statusText() }) };
}

/** Results indexed by claim key (a result without `key` is keyed from its ids). */
function indexResults(results) {
  const byKey = new Map();
  (results || []).forEach((result) => {
    if (result) byKey.set(result.key || claimKey(result.network_id, result.claim_id), result);
  });
  return byKey;
}

/**
 * Reinstate permission of a row the operator just released / confirmed inactive: the server's
 * `can_reinstate` when the refreshed claim carries it, otherwise inferred from the status (the
 * release was allowed for this user, so reinstating the same claim is too).
 */
function reinstateFields(fresh, status) {
  const allowed = typeof fresh?.can_reinstate === "boolean" ? fresh.can_reinstate : status === "inactive";
  return {
    can_reinstate: allowed,
    reinstate_block_reason: allowed ? "" : fresh?.reinstate_block_reason || REINSTATE_BLOCK_DEFAULT
  };
}

/**
 * Confirm permission of a row after a re-check: the server's `can_confirm` when the refreshed claim
 * carries it, otherwise inferred from the status (a potential claim the operator could read back is
 * one they may confirm, like the release rule above).
 */
function confirmFields(fresh, status) {
  const allowed = typeof fresh?.can_confirm === "boolean" ? fresh.can_confirm : status === "potential";
  return {
    can_confirm: allowed,
    confirm_block_reason: allowed ? "" : fresh?.confirm_block_reason || CONFIRM_BLOCK_DEFAULT
  };
}

/** Update table rows in place after a release batch (released / already inactive / unknown / skipped / failed). */
export function applyReleaseResults(claims = [], results = []) {
  const byKey = indexResults(results);
  if (!byKey.size) return claims;
  return claims.map((claim) => {
    const result = byKey.get(claimKey(claim));
    if (!result) return claim;
    const outcome = normalizeOutcome(result.outcome);
    const fresh = result.claim && typeof result.claim === "object" ? result.claim : null;
    const merged = fresh ? mergeServerClaim(claim, fresh) : claim;
    const note = { release_result: { outcome, message: result.message || "", action: "release" } };
    if (outcome === "released" || outcome === "already_inactive") {
      const status = normalizeStatus(fresh?.status || result.status) || "inactive";
      return {
        ...merged,
        status,
        can_release: false,
        release_block_reason: fresh?.release_block_reason || tk("Claims in inactive status cannot be released"),
        ...reinstateFields(fresh, status),
        // An inactive claim is reinstated, never confirmed: only potential claims take a confirm.
        can_confirm: false,
        confirm_block_reason: fresh?.confirm_block_reason || t("{reason}; this claim is {status}", { reason: t(CONFIRM_BLOCK_DEFAULT), status: t(statusLabel(status)).toLowerCase() }),
        ...note
      };
    }
    if (outcome === "unknown") {
      const reason = tk("Release outcome unknown: re-check the claim status first");
      return {
        ...claim,
        status: RELEASE_UNKNOWN_STATUS,
        can_release: false,
        release_block_reason: reason,
        can_reinstate: false,
        reinstate_block_reason: reason,
        can_confirm: false,
        confirm_block_reason: reason,
        ...note
      };
    }
    if (outcome === "skipped" && !fresh) {
      return { ...claim, can_release: false, release_block_reason: result.message || claim.release_block_reason || tk("Refused by the server"), ...note };
    }
    return { ...merged, ...note };
  });
}

/**
 * Update table rows in place after an activate run or a single reinstate / confirm (reinstated /
 * confirmed / already active / unknown / skipped / failed). Each result names the write it came
 * from (`action`: "reinstate" | "confirm"; an untagged result is read from the row's status), and
 * the row's `release_result` keeps that action so the table and a later re-check read the outcome
 * against the right write.
 */
export function applyActivateResults(claims = [], results = []) {
  const byKey = indexResults(results);
  if (!byKey.size) return claims;
  return claims.map((claim) => {
    const result = byKey.get(claimKey(claim));
    if (!result) return claim;
    const outcome = normalizeOutcome(result.outcome);
    const fresh = result.claim && typeof result.claim === "object" ? result.claim : null;
    const merged = fresh ? mergeServerClaim(claim, fresh) : claim;
    const action = result.action === "reinstate" || result.action === "confirm" ? result.action : normalizeStatus(claim.status) === "potential" ? "confirm" : "reinstate";
    const note = { release_result: { outcome, message: result.message || "", action } };
    if (outcome === "reinstated" || outcome === "confirmed" || outcome === "already_active") {
      const status = normalizeStatus(fresh?.status || result.status) || "active";
      // The operator could set it active, so they may release it again; the server's flag wins when present.
      const releasable = typeof fresh?.can_release === "boolean" ? fresh.can_release : RELEASABLE_STATUSES.includes(status);
      return {
        ...merged,
        status,
        can_release: releasable,
        release_block_reason: releasable ? "" : fresh?.release_block_reason || t("Claims in {status} status cannot be released", { status: t(statusLabel(status)).toLowerCase() }),
        can_reinstate: false,
        reinstate_block_reason: fresh?.reinstate_block_reason || REINSTATE_BLOCK_DEFAULT,
        can_confirm: false,
        confirm_block_reason: fresh?.confirm_block_reason || t("{reason}; this claim is {status}", { reason: t(CONFIRM_BLOCK_DEFAULT), status: t(statusLabel(status)).toLowerCase() }),
        ...note
      };
    }
    if (outcome === "unknown") {
      const reason = action === "confirm" ? tk("Confirm outcome unknown: re-check the claim status first") : tk("Reinstate outcome unknown: re-check the claim status first");
      return {
        ...claim,
        status: RELEASE_UNKNOWN_STATUS,
        can_release: false,
        release_block_reason: reason,
        can_reinstate: false,
        reinstate_block_reason: reason,
        can_confirm: false,
        confirm_block_reason: reason,
        ...note
      };
    }
    if (outcome === "skipped" && !fresh) {
      // Refused without a refreshed claim (outside the labels, CMS unusable, status moved on): stop offering that button, say why.
      if (action === "confirm") {
        return { ...claim, can_confirm: false, confirm_block_reason: result.message || claim.confirm_block_reason || tk("Refused by the server"), ...note };
      }
      return { ...claim, can_reinstate: false, reinstate_block_reason: result.message || claim.reinstate_block_reason || tk("Refused by the server"), ...note };
    }
    return { ...merged, ...note };
  });
}

/** Reinstate-only results (the single-claim flow, older callers): every untagged result is a reinstate. */
export function applyReinstateResults(claims = [], results = []) {
  const tagged = (Array.isArray(results) ? results : []).map((result) => (result ? { ...result, action: result.action || "reinstate" } : result));
  return applyActivateResults(claims, tagged);
}

/**
 * Update table rows after /recheck: fresh status (and can_release / can_reinstate / can_confirm)
 * from Google. A claim the server is still writing (`in_flight`) keeps its row as it is, "Check
 * status" included, until that request ends and a later re-check reads the final status.
 */
export function applyRecheckResults(claims = [], results = []) {
  const byKey = indexResults(results);
  if (!byKey.size) return claims;
  return claims.map((claim) => {
    const result = byKey.get(claimKey(claim));
    if (!result || !result.found || result.in_flight) return claim;
    const fresh = result.claim && typeof result.claim === "object" ? result.claim : null;
    if (fresh) {
      const merged = mergeServerClaim(claim, fresh);
      const status = normalizeStatus(fresh.status || result.status) || normalizeStatus(claim.status);
      // A refreshed claim without the reinstate / confirm fields (older server) falls back to the status rule.
      return { ...merged, status, ...reinstateFields(fresh, status), ...confirmFields(fresh, status), release_result: null };
    }
    const status = normalizeStatus(result.status) || normalizeStatus(claim.status);
    const releasable = RELEASABLE_STATUSES.includes(status);
    return {
      ...claim,
      status,
      can_release: releasable,
      release_block_reason: releasable ? "" : t("Claims in {status} status cannot be released", { status: t(statusLabel(status)).toLowerCase() }),
      ...reinstateFields(null, status),
      ...confirmFields(null, status),
      release_result: null
    };
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function isCanceled(error) {
  return Boolean(error) && (error.code === "ERR_CANCELED" || error.name === "CanceledError" || error.name === "AbortError");
}

/** axios reports a client-side timeout as ECONNABORTED (ETIMEDOUT with `transitional.clarifyTimeoutError`). */
export function isClientTimeout(error) {
  return Boolean(error) && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT");
}

/**
 * The request was sent but no response ever came back (connection dropped, server restarted
 * mid-request, DNS / CORS failure): axios sets ERR_NETWORK, or leaves `request` without a `response`.
 */
export function isNetworkError(error) {
  if (!error || isCanceled(error) || isClientTimeout(error)) return false;
  return error.code === "ERR_NETWORK" || (Boolean(error.request) && !error.response);
}

export function httpStatus(error) {
  return Number(error?.response?.status) || 0;
}

/**
 * The request may have reached Google although no answer came back: client timeout, cancel while
 * in flight, connection dropped (server restart mid-batch), or a 504. Such claims must be shown as
 * "re-check", never as failed.
 */
export function isUnknownOutcomeError(error) {
  return isClientTimeout(error) || isCanceled(error) || isNetworkError(error) || httpStatus(error) === 504;
}

export function isRetryableStatus(error) {
  return [429, 502, 503].includes(httpStatus(error));
}

export function retryAfterSeconds(error) {
  const fromBody = Number(error?.response?.data?.retry_after);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const header = Number(error?.response?.headers?.["retry-after"]);
  return Number.isFinite(header) && header > 0 ? Math.ceil(header) : 0;
}

/** Append an operator hint as its own sentence ("Quota" + hint → "Quota. <hint>"; a base that already ends a sentence is left alone). */
function withHint(base, hint) {
  if (!base) return hint;
  return /[.!?:;…]$/.test(base) ? `${base} ${hint}` : `${base}. ${hint}`;
}

/**
 * Adds the operator hint for 424 (re-authorize), 429 (retry_after) and 504 / timeouts to a base message.
 * `googleBacked: false` is for the endpoints that only read our own database (release history): a
 * timeout there is the server or the proxy, not Google.
 */
export function describeApiError(error, baseMessage, { googleBacked = true } = {}) {
  const data = error?.response?.data;
  const english = String(baseMessage || (data && typeof data === "object" && data.message) || error?.message || tk("Request failed")).trim();
  // The server's sentence is translated here (tm) so the operator hint appended below is in the same language.
  const base = tm(english);
  const status = httpStatus(error);
  if (status === 424) {
    // The server's 424 message may already tell the operator to re-authorize; never say it twice.
    return /re-?authori[sz]e/i.test(english) ? base : withHint(base, t("Re-authorize this CMS in Settings > Network, then try again."));
  }
  if (status === 429) {
    const seconds = retryAfterSeconds(error);
    return withHint(base, seconds ? t("Google rate limit reached: wait {seconds} s before retrying.", { seconds }) : t("Google rate limit reached: wait a moment before retrying."));
  }
  // Only read requests (search, detail, re-check, history) reach this hint: useReleaseRun routes every
  // unknown-outcome write error to unknownOutcomeMessage() instead.
  if (status === 504 || isClientTimeout(error)) {
    return withHint(base, googleBacked ? t("Google did not answer in time; try again in a moment.") : t("The server did not answer in time; try again in a moment."));
  }
  return base;
}

/**
 * Mirrors assetDelivery/utils getErrorMessage() without its browser-only imports (keeps this module
 * node-loadable), plus a readable message for a dropped connection (axios only says "Network Error").
 */
export function baseErrorMessage(error) {
  if (!error) return tk("Request failed");
  if (typeof error === "string") return error;
  if (isCanceled(error)) return tk("Cancelled");
  if (isClientTimeout(error)) return tk("Request timed out");
  if (isNetworkError(error)) return tk("Network error: no response from the server");
  const data = error.response?.data;
  // Blob responses (responseType: "blob") carry the error body as a Blob; fall through to the generic message.
  if (data && !(typeof Blob !== "undefined" && data instanceof Blob)) {
    if (typeof data === "string") return data;
    if (data.message) return data.message;
    if (data.error && typeof data.error === "string") return data.error;
    if (Array.isArray(data.errors) && data.errors.length) {
      return data.errors.map((item) => item.message || item.error || String(item)).join("; ");
    }
  }
  return error.message || tk("Request failed");
}

/**
 * A request made with `responseType: "blob"` (the CSV export) receives its error body as a Blob
 * too; decode it so requestMessage() sees `{ message, reason, retry_after }` like every other
 * endpoint. JSON is parsed; a short text/plain body is kept as text; anything else (an HTML
 * proxy error page) stays a Blob so it never ends up in a toast. Never throws: the same error
 * object comes back, with `response.data` replaced when the body could be decoded.
 */
export async function unwrapBlobError(error) {
  const data = error?.response?.data;
  if (!(typeof Blob !== "undefined" && data instanceof Blob)) return error;
  try {
    const text = await data.text();
    try {
      error.response.data = JSON.parse(text);
    } catch {
      if (String(data.type || "").startsWith("text/plain") && text.length <= 500) error.response.data = text;
    }
  } catch {
    // Unreadable body: keep the Blob; baseErrorMessage() falls back to the generic axios message.
  }
  return error;
}

/** Operator-facing message for a failed request: base message plus the 424 / 429 / timeout hints. */
export function requestMessage(error, options) {
  return describeApiError(error, baseErrorMessage(error), options);
}

/**
 * Per-claim message for a batch the server rejected as a whole (useReleaseRun). The 429 wait is
 * left out: the results panel renders it from `retry_after` (" Retry after N s."), so the hint would
 * state it twice; every other status keeps its operator hint (424 re-authorize).
 */
export function batchFailureMessage(error) {
  const base = baseErrorMessage(error);
  return httpStatus(error) === 429 ? tm(base) : describeApiError(error, base);
}

// Per write, the sentences that describe what Google may have done meanwhile (whole sentences, so each
// language words the write naturally).
const UNKNOWN_OUTCOME_TEXTS = {
  release: {
    applied: tk("The release may still have been applied; re-check the claim status."),
    cancelled: tk("Cancelled while waiting for Google. The claims already sent may still be released on the server: wait about a minute, then re-check them.")
  },
  reinstate: {
    applied: tk("The reinstate may still have been applied; re-check the claim status."),
    cancelled: tk("Cancelled while waiting for Google. The claims already sent may still be reinstated on the server: wait about a minute, then re-check them.")
  },
  confirm: {
    applied: tk("The confirm may still have been applied; re-check the claim status."),
    cancelled: tk("Cancelled while waiting for Google. The claims already sent may still be confirmed on the server: wait about a minute, then re-check them.")
  }
};

/** Result message for a batch whose outcome is unknown (see isUnknownOutcomeError); `action` names the write ("release" | "reinstate" | "confirm"). */
export function unknownOutcomeMessage(error, { action = "release" } = {}) {
  const texts = UNKNOWN_OUTCOME_TEXTS[action] || UNKNOWN_OUTCOME_TEXTS.release;
  if (isCanceled(error)) return t(texts.cancelled);
  const applied = t(texts.applied);
  if (isClientTimeout(error)) return `${t("The request timed out before Google answered.")} ${applied}`;
  if (isNetworkError(error)) return `${t("The connection dropped before Google's answer arrived.")} ${applied}`;
  return `${t("Google did not answer in time.")} ${applied}`;
}

// ---------------------------------------------------------------------------
// Formatting / export
// ---------------------------------------------------------------------------

/** 42 → "00:42", 201 → "03:21", 3723 → "1:02:03", null → "". */
export function formatSeconds(value) {
  if (value === null || value === undefined || value === "") return "";
  const total = Number(value);
  if (!Number.isFinite(total) || total < 0) return "";
  const whole = Math.round(total);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 320 → "320 ms", 1234 → "1.2 s", 59999 → "1 min" (rounding never yields "60 s" or "1 min 60 s"). */
export function formatDurationMs(value) {
  if (value === null || value === undefined || value === "") return "";
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return t("{count} ms", { count: Math.round(ms) });
  if (ms < 10000) {
    const tenths = Math.round(ms / 100) / 10;
    return t("{count} s", { count: tenths >= 10 ? 10 : tenths.toFixed(1) });
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return t("{count} s", { count: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? t("{minutes} min {seconds} s", { minutes, seconds }) : t("{count} min", { count: minutes });
}

export function shortId(value, length = 8) {
  const text = String(value || "");
  return text.length > length ? text.slice(0, length) : text;
}

function yesNo(value) {
  if (value === true) return t("yes");
  if (value === false) return t("no");
  return "";
}

const CSV_FORMULA_RE = /^[=+\-@\t\r]/;

/** Spreadsheets evaluate cells starting with = + - @ tab or CR as formulas: prefix them with an apostrophe. */
export function neutralizeCsvCell(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return value;
  return CSV_FORMULA_RE.test(value) ? `'${value}` : value;
}

// Canonical header labels; claimsToCsvRows() translates them at export time.
export const CLAIM_CSV_HEADER = [
  tk("Claim ID"),
  tk("CMS"),
  tk("Content owner"),
  tk("Video ID"),
  tk("Video URL"),
  tk("Video title"),
  tk("Channel"),
  tk("Asset ID"),
  tk("Asset title"),
  tk("ISRC"),
  tk("UPC"),
  tk("Asset labels"),
  tk("Status"),
  tk("Content type"),
  tk("Origin"),
  tk("Partner uploaded"),
  tk("Third party"),
  tk("Created"),
  tk("Status modified"),
  tk("Video views"),
  tk("Can release"),
  tk("Block reason")
];

/** Header + one row per claim, ready for rowsToCsv(); headers and label cells follow the UI language, ids / dates / numbers are raw. */
export function claimsToCsvRows(claims = []) {
  const rows = claims.map((claim) =>
    [
      claim.claim_id,
      claim.network_name,
      claim.content_owner_id,
      claim.video_id,
      claim.video_url || videoUrl(claim.video_id),
      claim.video_title || claim.video?.title || "",
      claim.video?.channel_title,
      claim.asset_id || claim.asset?.id,
      claim.asset?.title,
      claim.asset?.isrc,
      claim.asset?.upc,
      Array.isArray(claim.asset?.labels) ? claim.asset.labels.join("; ") : "",
      t(statusLabel(claim.status)),
      t(contentTypeLabel(claim.content_type)),
      t(originLabel(claim.origin)),
      yesNo(claim.is_partner_uploaded),
      yesNo(claim.third_party),
      claim.time_created,
      claim.time_status_last_modified,
      claim.video_views,
      isReleasable(claim) ? t("yes") : t("no"),
      tm(releaseBlockReason(claim))
    ].map(neutralizeCsvCell)
  );
  return [CLAIM_CSV_HEADER.map((label) => t(label)), ...rows];
}

/**
 * A local calendar day from the date pickers (YYYY-MM-DD) as the UTC instant of its local midnight
 * (`nextDay`: the following midnight, i.e. the exclusive end of that day). Anything else — an
 * instant a caller already built, or a day the Date parser rejects — passes through unchanged.
 */
function localDayToInstant(value, nextDay = false) {
  if (!DATE_RE.test(value)) return value;
  const [year, month, day] = value.split("-").map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0);
  // A day the calendar rejects (2026-13-45) would silently roll over: leave it for the backend's 400.
  if (Number.isNaN(start.getTime()) || start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return value;
  // Built from calendar parts, not by shifting a parsed instant: in a zone whose DST switch happens
  // at midnight, "T00:00:00" would parse as 01:00 and drag the next day's bound with it.
  const date = nextDay ? new Date(year, month - 1, day + 1, 0, 0, 0) : start;
  return date.toISOString();
}

/**
 * Query params for GET /content-id/claims/history (empty values dropped). The backend compares
 * `created_at` in UTC, so the pickers' local days are sent as instants: `from` is the local midnight
 * that starts the day (inclusive), `to` the local midnight that ends it (exclusive).
 */
export function historyQuery(filters = {}, page = 1, pageSize = 50) {
  const params = { page: Math.max(1, Number(page) || 1), page_size: Math.max(1, Number(pageSize) || 50) };
  ["network_id", "result", "user_id", "search", "from", "to"].forEach((key) => {
    const value = filters[key];
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (text) params[key] = text;
  });
  if (params.from) params.from = localDayToInstant(params.from);
  if (params.to) params.to = localDayToInstant(params.to, true);
  return params;
}

/** Same filters as historyQuery() without pagination, for GET /content-id/claims/history/export. */
export function historyExportQuery(filters = {}) {
  const params = historyQuery(filters, 1, 1);
  delete params.page;
  delete params.page_size;
  return params;
}

/** Toast text after a search. */
export function summarizeSearch(result) {
  if (!result) return "";
  const totals = result.totals || {};
  const claims = Number(totals.claims ?? (result.claims || []).length) || 0;
  const networks = (result.networks || []).length;
  const parts = [countText(claims, tk("{count} claim"), tk("{count} claims"))];
  if (result.mode === "videos") {
    parts.push(t("on {videos}", { videos: countText(Number(totals.videos ?? (result.videos || []).length) || 0, tk("{count} video"), tk("{count} videos")) }));
  }
  if (networks) parts.push(t("across {count} CMS", { count: networks }));
  const releasable = Number(totals.releasable);
  if (Number.isFinite(releasable)) parts.push(t("· {count} releasable", { count: releasable }));
  const errors = (result.errors || []).length;
  if (errors) parts.push(countText(errors, tk("· {count} CMS error"), tk("· {count} CMS errors")));
  return t("Found {summary}", { summary: parts.join(" ") });
}
