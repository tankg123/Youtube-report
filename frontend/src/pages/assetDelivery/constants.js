// Shared constants for the Content ID "CMS Delivery" page.
// Only plain data lives here (plus lucide icon references for the event
// timeline) so every module can import it without side effects.
import { Activity, AlertTriangle, Ban, CloudUpload, FileAudio, FileX, Globe, HardDrive, Link2, ListChecks, Pencil, Play, Plus, RefreshCw, RotateCcw, ShieldCheck, Trash2, Upload } from "lucide-react";
import { tk } from "../../i18n/index.js";

export const GENRES = [
  "Pop", "Rock", "Hip-Hop", "Guitar", "Piano", "R&B", "Electronic", "Dance", "Jazz", "Classical",
  "Country", "Reggae", "Latin", "Metal", "Folk", "Blues", "Soul", "Funk", "Punk", "Alternative",
  "Indie", "Gospel", "World", "Ambient", "Lo-Fi", "Trap", "House", "Techno", "Trance", "Dubstep",
  "K-Pop", "J-Pop", "Soundtrack", "Children's Music", "Holiday", "Opera", "Experimental", "New Age",
  "Chill", "Instrumental", "Acoustic", "Hard Rock", "Progressive Rock", "EDM", "Reggaeton", "Bolero"
];

// Full ISO 3166-1 alpha-2 list (249 entries) with short English names.
/* eslint-disable i18n/no-untranslated -- ISO region names, shown through regionName() */
export const TERRITORIES = [
  { code: "AD", name: "Andorra" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "AF", name: "Afghanistan" },
  { code: "AG", name: "Antigua and Barbuda" },
  { code: "AI", name: "Anguilla" },
  { code: "AL", name: "Albania" },
  { code: "AM", name: "Armenia" },
  { code: "AO", name: "Angola" },
  { code: "AQ", name: "Antarctica" },
  { code: "AR", name: "Argentina" },
  { code: "AS", name: "American Samoa" },
  { code: "AT", name: "Austria" },
  { code: "AU", name: "Australia" },
  { code: "AW", name: "Aruba" },
  { code: "AX", name: "Aland Islands" },
  { code: "AZ", name: "Azerbaijan" },
  { code: "BA", name: "Bosnia and Herzegovina" },
  { code: "BB", name: "Barbados" },
  { code: "BD", name: "Bangladesh" },
  { code: "BE", name: "Belgium" },
  { code: "BF", name: "Burkina Faso" },
  { code: "BG", name: "Bulgaria" },
  { code: "BH", name: "Bahrain" },
  { code: "BI", name: "Burundi" },
  { code: "BJ", name: "Benin" },
  { code: "BL", name: "Saint Barthelemy" },
  { code: "BM", name: "Bermuda" },
  { code: "BN", name: "Brunei Darussalam" },
  { code: "BO", name: "Bolivia" },
  { code: "BQ", name: "Bonaire, Sint Eustatius and Saba" },
  { code: "BR", name: "Brazil" },
  { code: "BS", name: "Bahamas" },
  { code: "BT", name: "Bhutan" },
  { code: "BV", name: "Bouvet Island" },
  { code: "BW", name: "Botswana" },
  { code: "BY", name: "Belarus" },
  { code: "BZ", name: "Belize" },
  { code: "CA", name: "Canada" },
  { code: "CC", name: "Cocos (Keeling) Islands" },
  { code: "CD", name: "Congo (Democratic Republic)" },
  { code: "CF", name: "Central African Republic" },
  { code: "CG", name: "Congo" },
  { code: "CH", name: "Switzerland" },
  { code: "CI", name: "Cote d'Ivoire" },
  { code: "CK", name: "Cook Islands" },
  { code: "CL", name: "Chile" },
  { code: "CM", name: "Cameroon" },
  { code: "CN", name: "China" },
  { code: "CO", name: "Colombia" },
  { code: "CR", name: "Costa Rica" },
  { code: "CU", name: "Cuba" },
  { code: "CV", name: "Cabo Verde" },
  { code: "CW", name: "Curacao" },
  { code: "CX", name: "Christmas Island" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "DE", name: "Germany" },
  { code: "DJ", name: "Djibouti" },
  { code: "DK", name: "Denmark" },
  { code: "DM", name: "Dominica" },
  { code: "DO", name: "Dominican Republic" },
  { code: "DZ", name: "Algeria" },
  { code: "EC", name: "Ecuador" },
  { code: "EE", name: "Estonia" },
  { code: "EG", name: "Egypt" },
  { code: "EH", name: "Western Sahara" },
  { code: "ER", name: "Eritrea" },
  { code: "ES", name: "Spain" },
  { code: "ET", name: "Ethiopia" },
  { code: "FI", name: "Finland" },
  { code: "FJ", name: "Fiji" },
  { code: "FK", name: "Falkland Islands" },
  { code: "FM", name: "Micronesia" },
  { code: "FO", name: "Faroe Islands" },
  { code: "FR", name: "France" },
  { code: "GA", name: "Gabon" },
  { code: "GB", name: "United Kingdom" },
  { code: "GD", name: "Grenada" },
  { code: "GE", name: "Georgia" },
  { code: "GF", name: "French Guiana" },
  { code: "GG", name: "Guernsey" },
  { code: "GH", name: "Ghana" },
  { code: "GI", name: "Gibraltar" },
  { code: "GL", name: "Greenland" },
  { code: "GM", name: "Gambia" },
  { code: "GN", name: "Guinea" },
  { code: "GP", name: "Guadeloupe" },
  { code: "GQ", name: "Equatorial Guinea" },
  { code: "GR", name: "Greece" },
  { code: "GS", name: "South Georgia and the South Sandwich Islands" },
  { code: "GT", name: "Guatemala" },
  { code: "GU", name: "Guam" },
  { code: "GW", name: "Guinea-Bissau" },
  { code: "GY", name: "Guyana" },
  { code: "HK", name: "Hong Kong" },
  { code: "HM", name: "Heard Island and McDonald Islands" },
  { code: "HN", name: "Honduras" },
  { code: "HR", name: "Croatia" },
  { code: "HT", name: "Haiti" },
  { code: "HU", name: "Hungary" },
  { code: "ID", name: "Indonesia" },
  { code: "IE", name: "Ireland" },
  { code: "IL", name: "Israel" },
  { code: "IM", name: "Isle of Man" },
  { code: "IN", name: "India" },
  { code: "IO", name: "British Indian Ocean Territory" },
  { code: "IQ", name: "Iraq" },
  { code: "IR", name: "Iran" },
  { code: "IS", name: "Iceland" },
  { code: "IT", name: "Italy" },
  { code: "JE", name: "Jersey" },
  { code: "JM", name: "Jamaica" },
  { code: "JO", name: "Jordan" },
  { code: "JP", name: "Japan" },
  { code: "KE", name: "Kenya" },
  { code: "KG", name: "Kyrgyzstan" },
  { code: "KH", name: "Cambodia" },
  { code: "KI", name: "Kiribati" },
  { code: "KM", name: "Comoros" },
  { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "KP", name: "North Korea" },
  { code: "KR", name: "South Korea" },
  { code: "KW", name: "Kuwait" },
  { code: "KY", name: "Cayman Islands" },
  { code: "KZ", name: "Kazakhstan" },
  { code: "LA", name: "Laos" },
  { code: "LB", name: "Lebanon" },
  { code: "LC", name: "Saint Lucia" },
  { code: "LI", name: "Liechtenstein" },
  { code: "LK", name: "Sri Lanka" },
  { code: "LR", name: "Liberia" },
  { code: "LS", name: "Lesotho" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "LV", name: "Latvia" },
  { code: "LY", name: "Libya" },
  { code: "MA", name: "Morocco" },
  { code: "MC", name: "Monaco" },
  { code: "MD", name: "Moldova" },
  { code: "ME", name: "Montenegro" },
  { code: "MF", name: "Saint Martin (French part)" },
  { code: "MG", name: "Madagascar" },
  { code: "MH", name: "Marshall Islands" },
  { code: "MK", name: "North Macedonia" },
  { code: "ML", name: "Mali" },
  { code: "MM", name: "Myanmar" },
  { code: "MN", name: "Mongolia" },
  { code: "MO", name: "Macao" },
  { code: "MP", name: "Northern Mariana Islands" },
  { code: "MQ", name: "Martinique" },
  { code: "MR", name: "Mauritania" },
  { code: "MS", name: "Montserrat" },
  { code: "MT", name: "Malta" },
  { code: "MU", name: "Mauritius" },
  { code: "MV", name: "Maldives" },
  { code: "MW", name: "Malawi" },
  { code: "MX", name: "Mexico" },
  { code: "MY", name: "Malaysia" },
  { code: "MZ", name: "Mozambique" },
  { code: "NA", name: "Namibia" },
  { code: "NC", name: "New Caledonia" },
  { code: "NE", name: "Niger" },
  { code: "NF", name: "Norfolk Island" },
  { code: "NG", name: "Nigeria" },
  { code: "NI", name: "Nicaragua" },
  { code: "NL", name: "Netherlands" },
  { code: "NO", name: "Norway" },
  { code: "NP", name: "Nepal" },
  { code: "NR", name: "Nauru" },
  { code: "NU", name: "Niue" },
  { code: "NZ", name: "New Zealand" },
  { code: "OM", name: "Oman" },
  { code: "PA", name: "Panama" },
  { code: "PE", name: "Peru" },
  { code: "PF", name: "French Polynesia" },
  { code: "PG", name: "Papua New Guinea" },
  { code: "PH", name: "Philippines" },
  { code: "PK", name: "Pakistan" },
  { code: "PL", name: "Poland" },
  { code: "PM", name: "Saint Pierre and Miquelon" },
  { code: "PN", name: "Pitcairn" },
  { code: "PR", name: "Puerto Rico" },
  { code: "PS", name: "Palestine" },
  { code: "PT", name: "Portugal" },
  { code: "PW", name: "Palau" },
  { code: "PY", name: "Paraguay" },
  { code: "QA", name: "Qatar" },
  { code: "RE", name: "Reunion" },
  { code: "RO", name: "Romania" },
  { code: "RS", name: "Serbia" },
  { code: "RU", name: "Russia" },
  { code: "RW", name: "Rwanda" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SB", name: "Solomon Islands" },
  { code: "SC", name: "Seychelles" },
  { code: "SD", name: "Sudan" },
  { code: "SE", name: "Sweden" },
  { code: "SG", name: "Singapore" },
  { code: "SH", name: "Saint Helena, Ascension and Tristan da Cunha" },
  { code: "SI", name: "Slovenia" },
  { code: "SJ", name: "Svalbard and Jan Mayen" },
  { code: "SK", name: "Slovakia" },
  { code: "SL", name: "Sierra Leone" },
  { code: "SM", name: "San Marino" },
  { code: "SN", name: "Senegal" },
  { code: "SO", name: "Somalia" },
  { code: "SR", name: "Suriname" },
  { code: "SS", name: "South Sudan" },
  { code: "ST", name: "Sao Tome and Principe" },
  { code: "SV", name: "El Salvador" },
  { code: "SX", name: "Sint Maarten (Dutch part)" },
  { code: "SY", name: "Syria" },
  { code: "SZ", name: "Eswatini" },
  { code: "TC", name: "Turks and Caicos Islands" },
  { code: "TD", name: "Chad" },
  { code: "TF", name: "French Southern Territories" },
  { code: "TG", name: "Togo" },
  { code: "TH", name: "Thailand" },
  { code: "TJ", name: "Tajikistan" },
  { code: "TK", name: "Tokelau" },
  { code: "TL", name: "Timor-Leste" },
  { code: "TM", name: "Turkmenistan" },
  { code: "TN", name: "Tunisia" },
  { code: "TO", name: "Tonga" },
  { code: "TR", name: "Turkiye" },
  { code: "TT", name: "Trinidad and Tobago" },
  { code: "TV", name: "Tuvalu" },
  { code: "TW", name: "Taiwan" },
  { code: "TZ", name: "Tanzania" },
  { code: "UA", name: "Ukraine" },
  { code: "UG", name: "Uganda" },
  { code: "UM", name: "United States Minor Outlying Islands" },
  { code: "US", name: "United States" },
  { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" },
  { code: "VA", name: "Holy See (Vatican City)" },
  { code: "VC", name: "Saint Vincent and the Grenadines" },
  { code: "VE", name: "Venezuela" },
  { code: "VG", name: "British Virgin Islands" },
  { code: "VI", name: "U.S. Virgin Islands" },
  { code: "VN", name: "Vietnam" },
  { code: "VU", name: "Vanuatu" },
  { code: "WF", name: "Wallis and Futuna" },
  { code: "WS", name: "Samoa" },
  { code: "YE", name: "Yemen" },
  { code: "YT", name: "Mayotte" },
  { code: "ZA", name: "South Africa" },
  { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "Zimbabwe" }
];
/* eslint-enable i18n/no-untranslated */

export const TERRITORY_CODES = TERRITORIES.map((territory) => territory.code);

export const TERRITORY_NAME_BY_CODE = TERRITORIES.reduce((map, territory) => {
  map[territory.code] = territory.name;
  return map;
}, {});

export const TERRITORY_PRESETS = [
  { label: tk("Vietnam"), codes: ["VN"] },
  { label: tk("US + CA"), codes: ["US", "CA"] },
  { label: tk("ASEAN"), codes: ["BN", "KH", "ID", "LA", "MY", "MM", "PH", "SG", "TH", "VN"] },
  {
    label: tk("EU"),
    codes: [
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
      "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"
    ]
  }
];

export const OWNERSHIP_MODES = [
  { value: "worldwide", label: tk("Worldwide"), description: tk("Own the recording everywhere") },
  { value: "include", label: tk("Include"), description: tk("Own only in the listed territories") },
  { value: "exclude", label: tk("Exclude"), description: tk("Own everywhere except the listed territories") }
];

export const AUDIO_EXTENSIONS = [".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".aiff", ".wma", ".mp4"];
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mpg", ".mpeg", ".wmv"];
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
export const AUDIO_ACCEPT = AUDIO_EXTENSIONS.join(",");
export const VIDEO_ACCEPT = VIDEO_EXTENSIONS.join(",");
export const IMAGE_ACCEPT = IMAGE_EXTENSIONS.join(",");

// Content ID asset types the delivery pages create. `kind` picks the page (music vs video),
// the accepted files and the wording; the ISRC rule mirrors the backend validation.
export const ASSET_TYPE_META = {
  sound_recording: { label: tk("Sound recording"), kind: "music", isrc: "required", item: tk("track"), items: tk("tracks"), media: tk("audio"), mediaFile: tk("audio file"), reference: "audio" },
  web: { label: tk("Web video"), kind: "video", isrc: "none", item: tk("video"), items: tk("videos"), media: tk("video"), mediaFile: tk("video file"), reference: "audiovisual" },
  music_video: { label: tk("Music video"), kind: "video", isrc: "optional", item: tk("video"), items: tk("videos"), media: tk("video"), mediaFile: tk("video file"), reference: "audiovisual" }
};
export const VIDEO_ASSET_TYPE_OPTIONS = [
  { value: "web", label: tk("Web video"), description: tk("Any video: vlogs, shows, clips. Title, description, custom ID, official URL.") },
  { value: "music_video", label: tk("Music video"), description: tk("Official music videos: adds artist, optional ISRC, UPC and release date.") }
];

export function assetTypeMeta(assetType) {
  return ASSET_TYPE_META[String(assetType || "").toLowerCase()] || ASSET_TYPE_META.sound_recording;
}

export function kindOfAssetType(assetType) {
  return assetTypeMeta(assetType).kind;
}

export const MEDIA_ACCEPT_BY_KIND = { music: AUDIO_ACCEPT, video: VIDEO_ACCEPT };

// Status metadata: `cls` is a full Tailwind class string (background + text) so
// the global .theme-dark overrides keep applying; `tone` maps to <Badge tone>.

// content_id_delivery_products.status
export const PRODUCT_STATUS_META = {
  draft: { label: tk("Draft"), cls: "bg-slate-100 text-slate-600", tone: "slate" },
  delivering: { label: tk("Delivering"), cls: "bg-blue-50 text-blue-700", tone: "blue", spin: true },
  delivered: { label: tk("Delivered"), cls: "bg-emerald-50 text-emerald-700", tone: "emerald" },
  partial: { label: tk("Partially delivered"), cls: "bg-amber-50 text-amber-700", tone: "amber" },
  error: { label: tk("Error"), cls: "bg-red-50 text-red-600", tone: "red" },
  taken_down: { label: tk("Taken down"), cls: "bg-slate-100 text-slate-600", tone: "slate" }
};

// content_id_delivery_tracks.status
export const TRACK_STATUS_META = {
  pending: { label: tk("Pending"), cls: "bg-slate-100 text-slate-600", tone: "slate" },
  creating: { label: tk("Creating"), cls: "bg-blue-50 text-blue-700", tone: "blue", spin: true },
  uploading: { label: tk("Uploading reference"), cls: "bg-blue-50 text-blue-700", tone: "blue", spin: true },
  created: { label: tk("Asset created"), cls: "bg-blue-50 text-blue-700", tone: "blue" },
  completed: { label: tk("Delivered"), cls: "bg-emerald-50 text-emerald-700", tone: "emerald" },
  error: { label: tk("Error"), cls: "bg-red-50 text-red-600", tone: "red" },
  duplicate: { label: tk("Duplicate"), cls: "bg-amber-50 text-amber-700", tone: "amber" },
  taken_down: { label: tk("Taken down"), cls: "bg-slate-100 text-slate-600", tone: "slate" }
};

// Reference.status enum from the Content ID API.
export const REFERENCE_STATUS_META = {
  active: { label: tk("Active"), cls: "bg-emerald-50 text-emerald-700", tone: "emerald" },
  activating: { label: tk("Activating"), cls: "bg-blue-50 text-blue-700", tone: "blue", spin: true },
  checking: { label: tk("Checking"), cls: "bg-indigo-50 text-indigo-700", tone: "indigo", spin: true },
  checking_quota: { label: tk("Checking quota"), cls: "bg-indigo-50 text-indigo-700", tone: "indigo", spin: true },
  computing_fingerprint: { label: tk("Fingerprinting"), cls: "bg-indigo-50 text-indigo-700", tone: "indigo", spin: true },
  live_streaming_processing: { label: tk("Live processing"), cls: "bg-indigo-50 text-indigo-700", tone: "indigo", spin: true },
  deactivating: { label: tk("Deactivating"), cls: "bg-amber-50 text-amber-700", tone: "amber" },
  inactive: { label: tk("Inactive"), cls: "bg-slate-100 text-slate-600", tone: "slate" },
  deleted: { label: tk("Deleted"), cls: "bg-red-50 text-red-600", tone: "red" }
};

// Reference.status classification (mirrors the backend helper): a "live"
// reference is one CMS matches with or is still activating; a "dead" one is
// inactive or on its way out. Any other / unknown status counts as not live.
export const REFERENCE_LIVE_STATUSES = ["active", "activating", "checking", "checking_quota", "computing_fingerprint", "live_streaming_processing"];
export const REFERENCE_DEAD_STATUSES = ["inactive", "deactivating", "deleted"];

// content_id_delivery_tracks.step → label shown while a delivery job runs (and next to errors).
export const STEP_LABELS = {
  queued: tk("Queued"),
  insert: tk("Creating asset"),
  ownership: tk("Ownership"),
  policy: tk("Match policy"),
  labels: tk("Labels"),
  reference: tk("Uploading reference"),
  audio: tk("Uploading audio"),
  check: tk("Checking duplicates"),
  // Steps the backend only reports on failures.
  auth: tk("CMS authorization"),
  metadata: tk("Metadata"),
  validate: tk("Validation"),
  deliver: tk("Delivery"),
  takedown: tk("Takedown"),
  reactivate: tk("Reactivation"),
  sync: tk("Sync")
};

export const REFERENCE_CONTENT_TYPES = ["audio", "audiovisual", "video"];

export const DEFAULT_MATCH_POLICY_NAMES = [
  "Monetize in all countries",
  "Track in all countries",
  "Block in all countries",
  "Manual Review"
];

// content_id_delivery_events.action → label / icon / tone for the timeline.
export const EVENT_ACTION_META = {
  create: { label: tk("Product created"), icon: Plus, tone: "slate" },
  deliver: { label: tk("Delivered to CMS"), icon: CloudUpload, tone: "blue" },
  reference_upload: { label: tk("Reference uploaded"), icon: Upload, tone: "emerald" },
  reference_from_claim: { label: tk("Reference from claim"), icon: Link2, tone: "emerald" },
  audio_upload: { label: tk("Audio stored"), icon: FileAudio, tone: "blue" },
  audio_delete: { label: tk("Audio removed"), icon: FileX, tone: "slate" },
  retry: { label: tk("Retried"), icon: RotateCcw, tone: "indigo" },
  sync: { label: tk("Synced from CMS"), icon: RefreshCw, tone: "slate" },
  metadata_update: { label: tk("Metadata updated"), icon: Pencil, tone: "blue" },
  rights_update: { label: tk("Rights updated"), icon: ShieldCheck, tone: "indigo" },
  takedown: { label: tk("Taken down"), icon: Ban, tone: "red" },
  reactivate: { label: tk("Reactivated"), icon: Play, tone: "emerald" },
  delete: { label: tk("Deleted"), icon: Trash2, tone: "red" },
  // Detailed delivery trace (log viewer): steps, API calls, per-track runs, progress ticks.
  delivery_step: { label: tk("Delivery step"), icon: ListChecks, tone: "blue" },
  track_delivery: { label: tk("Track delivery"), icon: CloudUpload, tone: "blue" },
  delivery_progress: { label: tk("Progress"), icon: Activity, tone: "slate" },
  delivery_interrupted: { label: tk("Delivery interrupted"), icon: AlertTriangle, tone: "amber" },
  api: { label: tk("CMS API call"), icon: Globe, tone: "slate" },
  reference_cleanup: { label: tk("Server audio removed after delivery"), icon: HardDrive, tone: "slate" },
  audio_cleanup: { label: tk("Server storage freed"), icon: HardDrive, tone: "slate" }
};

// Filter groups of the delivery log viewer (mirrors EVENT_ACTION_GROUPS on the backend).
export const LOG_ACTION_GROUPS = [
  { value: "", label: tk("All events") },
  { value: "delivery", label: tk("Delivery steps & progress") },
  { value: "api", label: tk("CMS API calls") },
  { value: "reference", label: tk("References") },
  { value: "audio", label: tk("Audio files & storage") },
  { value: "management", label: tk("Edits, sync, takedowns") }
];

export const STORAGE_KEYS = {
  network: "cid_delivery_network",
  draft: "cid_delivery_draft",
  videoNetwork: "cid_video_delivery_network",
  videoDraft: "cid_video_delivery_draft"
};
