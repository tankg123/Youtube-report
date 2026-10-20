// Claim Manager constants. Plain data only (no React / lucide imports) so that
// utils.js and the node:test suite can load this module outside the browser.
// tk() marks the canonical English labels; components render them with t(label).
import { tk } from "../../i18n/index.js";

// Claims per release request. Google has no bulk release: each claim is one claims.patch call and
// one quota unit whatever the batch size; 50 keeps a run well inside the server budget (150 s).
export const RELEASE_BATCH_SIZE = 50;
export const PAGE_SIZE = 50;
export const HISTORY_PAGE_SIZE = 50;
export const MAX_NOTE_LENGTH = 500;
export const MAX_RECHECK_ITEMS = 100;
export const RELEASE_PREVIEW_ROWS = 10;
export const QUICK_FILTER_DEBOUNCE_MS = 200;

export const DEFAULT_LIMITS = Object.freeze({
  max_videos: 50,
  max_assets: 20,
  max_claim_ids: 200,
  max_release_items: 100,
  video_batch_size: 50,
  max_networks: 20
});

export const STORAGE_KEYS = Object.freeze({
  networks: "cid_claims_networks",
  mode: "cid_claims_mode",
  details: "cid_claims_details",
  groupView: "cid_claims_group_view",
  filtersOpen: "cid_claims_filters_open"
});

export const SEARCH_MODES = [
  {
    key: "videos",
    label: tk("Video links / IDs"),
    shortLabel: tk("Videos"),
    noun: tk("video"),
    plural: tk("videos"),
    limitKey: "max_videos",
    rows: 8,
    placeholder: tk("One YouTube link or 11-character video ID per line\nhttps://www.youtube.com/watch?v=VIDEO_ID\nhttps://youtu.be/VIDEO_ID\nVIDEO_ID"),
    hint: tk("Lists every claim the selected CMS own on these videos, including videos without any claim.")
  },
  {
    key: "assets",
    label: tk("Asset IDs"),
    shortLabel: tk("Assets"),
    noun: tk("asset ID"),
    plural: tk("asset IDs"),
    limitKey: "max_assets",
    rows: 4,
    placeholder: tk("One asset ID per line (commas work too)\nA123456789012345"),
    hint: tk("Lists the claims created from these assets in the selected CMS.")
  },
  {
    key: "claims",
    label: tk("Claim IDs"),
    shortLabel: tk("Claims"),
    noun: tk("claim ID"),
    plural: tk("claim IDs"),
    limitKey: "max_claim_ids",
    rows: 6,
    placeholder: tk("One claim ID per line (commas work too)\nC123456789012345"),
    hint: tk("Reads the claims directly, with policy and match details.")
  },
  {
    key: "explore",
    label: tk("Explore"),
    shortLabel: tk("Explore"),
    noun: tk("query"),
    plural: tk("queries"),
    limitKey: null,
    rows: 1,
    placeholder: tk("Free text (optional): video title, channel or asset title"),
    hint: tk("Browses the claims of one CMS using the filters below; page through the results with Previous / Next.")
  }
];

export const CLAIM_STATUSES = ["active", "pending", "potential", "disputed", "appealed", "manual_review", "takedown", "inactive"];
// potential (a match awaiting confirmation) can be released too: verified against the live API on 2026-10-16.
export const RELEASABLE_STATUSES = ["active", "pending", "potential"];
// Google's claims resource doc: "the API also supports updating the status to active from inactive
// (when reinstating a claim) or potential (when confirming a potential claim). Disputed claims can't
// be reinstated through the API." Confirm is potential → active; "activate" is the page's umbrella
// for confirm + reinstate (one bulk button, two endpoints).
export const CONFIRMABLE_STATUSES = ["potential"];
export const ACTIVATABLE_STATUSES = ["potential", "inactive"];
export const RELEASE_UNKNOWN_STATUS = "release_unknown";

export const TONE_CLASSES = Object.freeze({
  slate: "bg-slate-100 text-slate-600",
  blue: "bg-blue-50 text-blue-700",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-600",
  indigo: "bg-indigo-50 text-indigo-700",
  violet: "bg-violet-50 text-violet-700"
});

export const CLAIM_STATUS_META = {
  active: { label: tk("Active"), tone: "emerald", order: 0 },
  pending: { label: tk("Pending"), tone: "amber", order: 1 },
  potential: { label: tk("Potential"), tone: "blue", order: 2 },
  disputed: { label: tk("Disputed"), tone: "violet", order: 3 },
  appealed: { label: tk("Appealed"), tone: "violet", order: 4 },
  manual_review: { label: tk("Manual review"), tone: "violet", order: 5 },
  takedown: { label: tk("Takedown"), tone: "red", order: 6 },
  inactive: { label: tk("Inactive"), tone: "slate", order: 7 },
  [RELEASE_UNKNOWN_STATUS]: { label: tk("Check status"), tone: "amber", order: 8 }
};

export const CONTENT_TYPES = [
  { value: "audio", label: tk("Audio") },
  { value: "audiovisual", label: tk("Audiovisual") },
  { value: "video", label: tk("Video") }
];

export const CLAIM_ORIGINS = [
  { value: "audioMatch", label: tk("Audio match") },
  { value: "videoMatch", label: tk("Video match") },
  { value: "melodyMatch", label: tk("Melody match") },
  { value: "descriptiveSearch", label: tk("Descriptive search") },
  { value: "cmsUpload", label: tk("CMS upload") },
  { value: "contentIdApi", label: tk("Content ID API") },
  { value: "webUpload", label: tk("Web upload") },
  { value: "batchTool", label: tk("Batch tool") },
  { value: "youTubeAdmin", label: tk("YouTube admin") },
  { value: "audioSwap", label: tk("Audio swap") },
  { value: "cvpSearch", label: tk("CVP search") },
  { value: "dropboxUpload", label: tk("Dropbox upload") },
  { value: "external", label: tk("External") },
  { value: "gameId", label: tk("Game ID") },
  { value: "googleDevId", label: tk("Google Dev ID") },
  { value: "hashcode", label: tk("Hashcode") },
  { value: "inProductShorts", label: tk("In-product Shorts") },
  { value: "inProductStudio", label: tk("In-product Studio") },
  { value: "syntheticVocal", label: tk("Synthetic vocal") }
];

export const EXPLORE_SORTS = [
  { value: "DATE", label: tk("Newest first") },
  { value: "DAILY_ENGAGED_VIEWS", label: tk("Daily engaged views") },
  { value: "LIFETIME_ENGAGED_VIEWS", label: tk("Lifetime engaged views") }
];

export const PARTNER_UPLOADED_OPTIONS = [
  { value: "", label: tk("Any uploader") },
  { value: "true", label: tk("Partner uploaded") },
  { value: "false", label: tk("Not partner uploaded (UGC)") }
];

export const EMPTY_FILTERS = Object.freeze({
  statuses: [],
  content_types: [],
  origins: [],
  created_after: "",
  created_before: "",
  status_modified_after: "",
  status_modified_before: "",
  partner_uploaded: null,
  sort: "DATE"
});

// Outcomes of a release, a reinstate or a confirm (claims.patch to inactive / back to active /
// potential to active); shared by the write dialog, the table rows and the history (tiles, result
// filter). Same values and order as the backend's RESULTS.
export const RELEASE_OUTCOMES = ["released", "already_inactive", "reinstated", "confirmed", "already_active", "failed", "unknown", "skipped"];

export const RELEASE_OUTCOME_META = {
  released: { label: tk("Released"), tone: "emerald", description: tk("Google confirmed the claim is now inactive.") },
  already_inactive: { label: tk("Already inactive"), tone: "slate", description: tk("The claim was already inactive; nothing changed.") },
  reinstated: { label: tk("Reinstated"), tone: "emerald", description: tk("Google confirmed the claim is active again.") },
  confirmed: { label: tk("Confirmed"), tone: "emerald", description: tk("Google confirmed the potential claim; it is active now.") },
  already_active: { label: tk("Already active"), tone: "slate", description: tk("The claim was already active; nothing changed.") },
  failed: { label: tk("Failed"), tone: "red", description: tk("Google rejected the status change, or it was not sent (time budget, CMS unreachable, claim not readable); the claim keeps its status. Retryable failures offer Retry.") },
  unknown: { label: tk("Check status"), tone: "amber", description: tk("Google never answered, so the claim may or may not have changed. Re-check it before retrying.") },
  skipped: { label: tk("Skipped"), tone: "indigo", description: tk("Not sent: not allowed for this status, outside your labels, CMS not usable, another request is changing the claim, or the run was cancelled.") }
};

export const HISTORY_ACTION_LABELS = {
  release: tk("Release"),
  reinstate: tk("Reinstate"),
  confirm: tk("Confirm"),
  recheck: tk("Re-check")
};

export const GOOGLE_HISTORY_TYPE_META = {
  claim_create: { label: tk("Claim created"), tone: "blue" },
  claim_create_pending: { label: tk("Claim created (pending)"), tone: "amber" },
  claim_release: { label: tk("Claim released"), tone: "emerald" },
  claim_update: { label: tk("Claim updated"), tone: "slate" },
  claim_close: { label: tk("Claim closed"), tone: "slate" },
  claim_reinstate: { label: tk("Claim reinstated"), tone: "blue" },
  claim_retract: { label: tk("Claim retracted"), tone: "slate" },
  dispute_create: { label: tk("Dispute opened"), tone: "violet" },
  dispute_appeal: { label: tk("Dispute appealed"), tone: "violet" },
  appeal_cancelled: { label: tk("Appeal cancelled"), tone: "slate" },
  delayed_takedown: { label: tk("Delayed takedown"), tone: "red" },
  retraction_request_create: { label: tk("Retraction requested"), tone: "amber" },
  retraction_request_expire: { label: tk("Retraction request expired"), tone: "slate" },
  retraction_request_reject: { label: tk("Retraction request rejected"), tone: "red" },
  takedown_request_create: { label: tk("Takedown requested"), tone: "red" },
  takedown_request_pushback: { label: tk("Takedown pushback"), tone: "amber" },
  takedown_request_retract: { label: tk("Takedown request retracted"), tone: "slate" },
  video_takedown_strike: { label: tk("Video takedown strike"), tone: "red" }
};

export const GOOGLE_HISTORY_SOURCE_LABELS = {
  cms_user: tk("CMS user"),
  yt_user: tk("YouTube user"),
  yt_admin: tk("YouTube admin"),
  batch_tool: tk("Batch tool"),
  bulk_update: tk("Bulk update"),
  dropbox_feed: tk("Dropbox feed")
};

export const GOOGLE_HISTORY_DETAIL_LABELS = {
  dispute_reason: tk("Dispute reason"),
  dispute_notes: tk("Dispute notes"),
  appeal_explanation: tk("Appeal explanation"),
  update_status: tk("Updated status")
};

export const SEARCH_ERROR_SCOPE_LABELS = {
  credentials: tk("CMS authorization"),
  search: tk("Claim search"),
  assets: tk("Asset metadata"),
  video_metadata: tk("Video metadata")
};

export const RELEASE_CONFIRMATION_TEXT = tk("I understand the released claims stop applying their policy immediately, and the time until a reinstate is not recovered");
export const ACTIVATE_CONFIRMATION_TEXT = tk("I understand the selected claims become active right away: the videos are claimed again and the assets' policies apply to them");
export const REINSTATE_BLOCK_DEFAULT = tk("Only inactive (released) claims can be reinstated");
export const CONFIRM_BLOCK_DEFAULT = tk("Only potential claims (matches awaiting confirmation) can be confirmed");
