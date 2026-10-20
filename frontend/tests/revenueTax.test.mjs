import test from "node:test";
import assert from "node:assert/strict";
import {
  enabledRevenueTaxKinds,
  groupRevenueTaxState,
  revenueTaxColumnsLabel,
  revenueTaxFlags,
  revenueTaxKindsLabel,
  revenueTaxRatesLabel
} from "../src/utils/revenueTax.js";

test("each tax has its own switch; a kind never saved inherits the legacy single switch", () => {
  assert.deepEqual(revenueTaxFlags({ revenue_tax_us_enabled: "1", revenue_tax_br_enabled: "0" }), { us: true, br: false, any: true });
  assert.deepEqual(revenueTaxFlags({ revenue_tax_us_enabled: "0", revenue_tax_br_enabled: "1" }), { us: false, br: true, any: true });
  assert.deepEqual(revenueTaxFlags({ revenue_tax_us_enabled: "1", revenue_tax_br_enabled: "1" }), { us: true, br: true, any: true });
  // Older server: only the legacy key exists.
  assert.deepEqual(revenueTaxFlags({ revenue_tax_us_br_enabled: "1" }), { us: true, br: true, any: true });
  assert.deepEqual(revenueTaxFlags({ revenue_tax_us_br_enabled: "0" }), { us: false, br: false, any: false });
  // Saved kinds win over the legacy key; an empty value counts as "never saved".
  assert.deepEqual(revenueTaxFlags({ revenue_tax_us_br_enabled: "1", revenue_tax_us_enabled: "0", revenue_tax_br_enabled: "0" }), { us: false, br: false, any: false });
  assert.deepEqual(revenueTaxFlags({ revenue_tax_us_br_enabled: "1", revenue_tax_us_enabled: "", revenue_tax_br_enabled: "0" }), { us: true, br: false, any: true });
  assert.deepEqual(revenueTaxFlags(undefined), { us: false, br: false, any: false });
});

test("labels list only the kinds that are on", () => {
  const both = { us: true, br: true };
  assert.deepEqual(enabledRevenueTaxKinds(both), ["us", "br"]);
  assert.equal(revenueTaxKindsLabel(both), "US / BR");
  assert.equal(revenueTaxKindsLabel({ us: true }), "US");
  assert.equal(revenueTaxKindsLabel({ br: true }), "BR");
  assert.equal(revenueTaxKindsLabel({}), "");
  assert.equal(revenueTaxRatesLabel(both), "US 30% / BR 14%");
  assert.equal(revenueTaxRatesLabel({ br: true }), "BR 14%");
  assert.equal(revenueTaxColumnsLabel(both), "Revenue US, Tax US, Revenue BR, Tax BR");
  assert.equal(revenueTaxColumnsLabel({ us: true }), "Revenue US, Tax US");
});

test("groupRevenueTaxState prefers the server's per-kind flags and falls back to the settings", () => {
  const settings = { us: true, br: false, any: true };
  // Server answer after the split: US on, BR off, group opted in.
  assert.deepEqual(
    groupRevenueTaxState({ revenue_tax_us_enabled: 1, revenue_tax_br_enabled: 0, apply_revenue_tax: 1, apply_tax_us: 1, apply_tax_br: 0 }, settings),
    { enabled: { us: true, br: false, any: true }, applies: { us: true, br: false, any: true } }
  );
  // Group did not opt in.
  assert.deepEqual(
    groupRevenueTaxState({ revenue_tax_us_enabled: 1, revenue_tax_br_enabled: 1, apply_revenue_tax: 0, apply_tax_us: 0, apply_tax_br: 0 }, settings).applies,
    { us: false, br: false, any: false }
  );
  // Pre-split server: one switch means both kinds.
  assert.deepEqual(
    groupRevenueTaxState({ revenue_tax_enabled: 1, apply_revenue_tax: 1 }, settings),
    { enabled: { us: true, br: true, any: true }, applies: { us: true, br: true, any: true } }
  );
  // No group loaded: the cached settings describe what is on, nothing applies yet.
  assert.deepEqual(groupRevenueTaxState(undefined, settings), { enabled: settings, applies: { us: false, br: false, any: false } });
});
