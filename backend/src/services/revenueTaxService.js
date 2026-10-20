const db = require("../config/database");

// Each withholding has its own switch in system_settings. The legacy single switch `revenue_tax_us_br_enabled`
// (US and Brazil together) is still honoured for a kind whose own key has never been saved, so existing
// installs keep their behaviour until Settings are saved again. Groups opt in individually via
// channel_groups.apply_revenue_tax; a group only pays the kinds that are switched on.
const REVENUE_TAX_SETTING_KEYS = Object.freeze({ us: "revenue_tax_us_enabled", br: "revenue_tax_br_enabled" });
const LEGACY_REVENUE_TAX_SETTING_KEY = "revenue_tax_us_br_enabled";
// Name kept for the modules written before the split; it is the legacy key.
const REVENUE_TAX_SETTING_KEY = LEGACY_REVENUE_TAX_SETTING_KEY;
const REVENUE_TAX_KINDS = Object.freeze(["us", "br"]);

// Withholding rates applied to the US / Brazil portion of a channel's revenue before revenue sharing.
const REVENUE_TAX_RATES = Object.freeze({ us: 0.3, br: 0.14 });

function toFlag(value) {
  if (value === true || value === 1) return 1;
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text) ? 1 : 0;
}

function hasValue(settings, key) {
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, key)) return false;
  const value = settings[key];
  return value !== undefined && value !== null && String(value).trim() !== "";
}

// Accepts a { us, br } object, or a boolean for the callers written before the split (true = both kinds).
function normalizeRevenueTaxFlags(value) {
  if (value === true) return { us: true, br: true, any: true };
  if (!value || typeof value !== "object") return { us: false, br: false, any: false };
  const us = Boolean(value.us);
  const br = Boolean(value.br);
  return { us, br, any: us || br };
}

// { us, br, any } from a settings map (database rows or the API payload). A kind whose own key was never
// saved inherits the legacy single switch.
function revenueTaxFlagsFromSettings(settings = {}) {
  const source = settings || {};
  const legacy = hasValue(source, LEGACY_REVENUE_TAX_SETTING_KEY) ? toFlag(source[LEGACY_REVENUE_TAX_SETTING_KEY]) === 1 : false;
  const flagOf = (kind) => (hasValue(source, REVENUE_TAX_SETTING_KEYS[kind]) ? toFlag(source[REVENUE_TAX_SETTING_KEYS[kind]]) === 1 : legacy);
  return normalizeRevenueTaxFlags({ us: flagOf("us"), br: flagOf("br") });
}

function enabledRevenueTaxFlags() {
  // No try/catch on purpose: a failed read must surface as an error, never as "tax off" with a higher payout.
  const rows = db.prepare("SELECT key, value FROM system_settings WHERE key IN (?, ?, ?)")
    .all(REVENUE_TAX_SETTING_KEYS.us, REVENUE_TAX_SETTING_KEYS.br, LEGACY_REVENUE_TAX_SETTING_KEY);
  const settings = {};
  rows.forEach((row) => {
    settings[row.key] = row.value;
  });
  return revenueTaxFlagsFromSettings(settings);
}

// True when at least one kind is switched on.
function isRevenueTaxEnabled() {
  return enabledRevenueTaxFlags().any;
}

// The kinds one group withholds: the switches that are on AND the group opted in.
function groupRevenueTaxFlags(group, enabled = enabledRevenueTaxFlags()) {
  const flags = normalizeRevenueTaxFlags(enabled);
  const optedIn = toFlag(group?.apply_revenue_tax) === 1;
  return normalizeRevenueTaxFlags({ us: optedIn && flags.us, br: optedIn && flags.br });
}

function groupAppliesRevenueTax(group, enabled = enabledRevenueTaxFlags()) {
  return groupRevenueTaxFlags(group, enabled).any;
}

// Tax of one channel row for the kinds that apply (`applies` is a flags object, or a boolean = both kinds).
function revenueTaxAmounts(source = {}, applies = true) {
  const flags = normalizeRevenueTaxFlags(applies);
  const revenueUs = Number(source?.revenue_us || 0);
  const revenueBr = Number(source?.revenue_br || 0);
  const taxUs = flags.us && Number.isFinite(revenueUs) ? revenueUs * REVENUE_TAX_RATES.us : 0;
  const taxBr = flags.br && Number.isFinite(revenueBr) ? revenueBr * REVENUE_TAX_RATES.br : 0;
  return { tax_us: taxUs, tax_br: taxBr, total_tax_usd: taxUs + taxBr };
}

// After-tax revenue of a channel_revenues row for the kinds that apply; the plain revenue column when none does.
function revenueTaxSqlExpression(alias = "cr", applies = true) {
  const flags = normalizeRevenueTaxFlags(applies);
  const parts = [`${alias}.revenue`];
  if (flags.us) parts.push(`${alias}.revenue_us * ${REVENUE_TAX_RATES.us}`);
  if (flags.br) parts.push(`${alias}.revenue_br * ${REVENUE_TAX_RATES.br}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" - ")})`;
}

module.exports = {
  REVENUE_TAX_SETTING_KEY,
  REVENUE_TAX_SETTING_KEYS,
  LEGACY_REVENUE_TAX_SETTING_KEY,
  REVENUE_TAX_KINDS,
  REVENUE_TAX_RATES,
  toFlag,
  normalizeRevenueTaxFlags,
  revenueTaxFlagsFromSettings,
  enabledRevenueTaxFlags,
  isRevenueTaxEnabled,
  groupRevenueTaxFlags,
  groupAppliesRevenueTax,
  revenueTaxAmounts,
  revenueTaxSqlExpression
};
