// US / Brazil withholding tax switches as the UI sees them. Each kind has its own system setting; a kind whose
// key has never been saved inherits the legacy single switch `revenue_tax_us_br_enabled` (same rule as the
// backend's revenueTaxService), so a settings object from an older server still resolves.
export const REVENUE_TAX_KINDS = Object.freeze(["us", "br"]);
export const REVENUE_TAX_SETTING_KEYS = Object.freeze({ us: "revenue_tax_us_enabled", br: "revenue_tax_br_enabled" });
export const LEGACY_REVENUE_TAX_SETTING_KEY = "revenue_tax_us_br_enabled";
// Display only; the backend owns the rates used in the calculation.
export const REVENUE_TAX_RATE_PERCENT = Object.freeze({ us: 30, br: 14 });
// Country codes are the same in both languages, so these labels are not translated.
export const REVENUE_TAX_KIND_LABELS = Object.freeze({ us: "US", br: "BR" });

export function toFlag(value) {
  if (value === true || value === 1) return 1;
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text) ? 1 : 0;
}

function hasValue(source, key) {
  if (!source || !Object.prototype.hasOwnProperty.call(source, key)) return false;
  const value = source[key];
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function normalizeRevenueTaxFlags(value) {
  if (value === true) return { us: true, br: true, any: true };
  if (!value || typeof value !== "object") return { us: false, br: false, any: false };
  const us = Boolean(value.us);
  const br = Boolean(value.br);
  return { us, br, any: us || br };
}

// { us, br, any } from the system settings object.
export function revenueTaxFlags(settings) {
  const source = settings || {};
  const legacy = hasValue(source, LEGACY_REVENUE_TAX_SETTING_KEY) ? toFlag(source[LEGACY_REVENUE_TAX_SETTING_KEY]) === 1 : false;
  const flagOf = (kind) => (hasValue(source, REVENUE_TAX_SETTING_KEYS[kind]) ? toFlag(source[REVENUE_TAX_SETTING_KEYS[kind]]) === 1 : legacy);
  return normalizeRevenueTaxFlags({ us: flagOf("us"), br: flagOf("br") });
}

export function enabledRevenueTaxKinds(flags) {
  const normalized = normalizeRevenueTaxFlags(flags);
  return REVENUE_TAX_KINDS.filter((kind) => normalized[kind]);
}

// "US / BR", "US" or "BR" — the kinds that are on, as country codes.
export function revenueTaxKindsLabel(flags, separator = " / ") {
  return enabledRevenueTaxKinds(flags).map((kind) => REVENUE_TAX_KIND_LABELS[kind]).join(separator);
}

// "US 30% / BR 14%", "US 30%" or "BR 14%".
export function revenueTaxRatesLabel(flags, separator = " / ") {
  return enabledRevenueTaxKinds(flags).map((kind) => `${REVENUE_TAX_KIND_LABELS[kind]} ${REVENUE_TAX_RATE_PERCENT[kind]}%`).join(separator);
}

// The Excel column headers added for the kinds that are on: "Revenue US, Tax US, Revenue BR, Tax BR".
export function revenueTaxColumnsLabel(flags, separator = ", ") {
  return enabledRevenueTaxKinds(flags)
    .flatMap((kind) => [`Revenue ${REVENUE_TAX_KIND_LABELS[kind]}`, `Tax ${REVENUE_TAX_KIND_LABELS[kind]}`])
    .join(separator);
}

// Effective tax state of a loaded group: `enabled` are the switches as the server saw them, `applies` the kinds
// this group withholds (switch on AND the group opted in). The server's per-kind flags win; the cached settings
// fill in when no group is loaded or an older server answered without them.
export function groupRevenueTaxState(summary, settingsFlags) {
  const source = summary || {};
  const fallback = normalizeRevenueTaxFlags(settingsFlags);
  let enabled;
  if (source.revenue_tax_us_enabled !== undefined || source.revenue_tax_br_enabled !== undefined) {
    enabled = normalizeRevenueTaxFlags({ us: toFlag(source.revenue_tax_us_enabled) === 1, br: toFlag(source.revenue_tax_br_enabled) === 1 });
  } else if (source.revenue_tax_enabled !== undefined) {
    // Pre-split server: one switch for both kinds.
    enabled = normalizeRevenueTaxFlags(toFlag(source.revenue_tax_enabled) === 1);
  } else {
    enabled = fallback;
  }
  let applies;
  if (source.apply_tax_us !== undefined || source.apply_tax_br !== undefined) {
    applies = normalizeRevenueTaxFlags({ us: toFlag(source.apply_tax_us) === 1, br: toFlag(source.apply_tax_br) === 1 });
  } else {
    const optedIn = toFlag(source.apply_revenue_tax) === 1;
    applies = normalizeRevenueTaxFlags({ us: optedIn && enabled.us, br: optedIn && enabled.br });
  }
  return { enabled, applies };
}
