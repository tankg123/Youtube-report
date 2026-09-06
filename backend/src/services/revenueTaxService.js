const db = require("../config/database");

// Global switch stored in system_settings; groups opt in individually via channel_groups.apply_revenue_tax.
const REVENUE_TAX_SETTING_KEY = "revenue_tax_us_br_enabled";

// Withholding rates applied to the US / Brazil portion of a channel's revenue before revenue sharing.
const REVENUE_TAX_RATES = Object.freeze({ us: 0.3, br: 0.14 });

function toFlag(value) {
  if (value === true || value === 1) return 1;
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text) ? 1 : 0;
}

function isRevenueTaxEnabled() {
  // No try/catch on purpose: a failed read must surface as an error, never as "tax off" with a higher payout.
  const row = db.prepare("SELECT value FROM system_settings WHERE key = ?").get(REVENUE_TAX_SETTING_KEY);
  return toFlag(row?.value) === 1;
}

function groupAppliesRevenueTax(group, enabled = isRevenueTaxEnabled()) {
  return Boolean(enabled) && toFlag(group?.apply_revenue_tax) === 1;
}

function revenueTaxAmounts(source = {}, applies = true) {
  const revenueUs = Number(source?.revenue_us || 0);
  const revenueBr = Number(source?.revenue_br || 0);
  const taxUs = applies && Number.isFinite(revenueUs) ? revenueUs * REVENUE_TAX_RATES.us : 0;
  const taxBr = applies && Number.isFinite(revenueBr) ? revenueBr * REVENUE_TAX_RATES.br : 0;
  return { tax_us: taxUs, tax_br: taxBr, total_tax_usd: taxUs + taxBr };
}

function revenueTaxSqlExpression(alias = "cr") {
  return `(${alias}.revenue - ${alias}.revenue_us * ${REVENUE_TAX_RATES.us} - ${alias}.revenue_br * ${REVENUE_TAX_RATES.br})`;
}

module.exports = {
  REVENUE_TAX_SETTING_KEY,
  REVENUE_TAX_RATES,
  toFlag,
  isRevenueTaxEnabled,
  groupAppliesRevenueTax,
  revenueTaxAmounts,
  revenueTaxSqlExpression
};
