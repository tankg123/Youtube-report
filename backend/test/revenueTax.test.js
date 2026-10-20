// US / Brazil withholding tax: separate switches with the legacy single-switch fallback, per-kind tax amounts
// and SQL, the settings API, the Manager Report import telling when a switched-on tax has no column in the
// file, and the Excel export adding only the columns of the kinds that are on.
const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const ExcelJS = require("exceljs");

// Schema from database.js without opening the real database (its path is hard-coded).
const databaseSource = fs.readFileSync(path.join(__dirname, "../src/config/database.js"), "utf8");
const memoryDb = new Database(":memory:");
(databaseSource.match(/CREATE TABLE IF NOT EXISTS \w+ \([\s\S]*?\n\s*\);/g) || []).forEach((sql) => memoryDb.exec(sql));
(databaseSource.match(/ALTER TABLE \w+ ADD COLUMN [^"`;\n]+/g) || []).forEach((sql) => {
  try { memoryDb.exec(sql); } catch { /* column already part of CREATE TABLE */ }
});
// The import upserts on the unique (month, network_id, channel_id) index of channel_revenues.
(databaseSource.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+ ON [^;"`\n]+/g) || []).forEach((sql) => {
  try { memoryDb.exec(sql); } catch { /* index on a table the migrations rebuild later */ }
});

const youtubeStub = {
  getChannelFromYoutube: async () => null,
  getChannelsFromYoutube: async () => [],
  getQuotaStatus: () => ({})
};

const originalLoad = Module._load;
Module._load = function loadWithFakes(request, parent, isMain) {
  if (request === "../config/database") return memoryDb;
  if (request === "../services/youtubeService") return youtubeStub;
  return originalLoad.call(this, request, parent, isMain);
};
const taxService = require("../src/services/revenueTaxService");
const settingsController = require("../src/controllers/settingsController");
const reportController = require("../src/controllers/reportController");
const templateService = require("../src/services/reconciliationTemplateService");
Module._load = originalLoad;

const {
  REVENUE_TAX_SETTING_KEYS,
  LEGACY_REVENUE_TAX_SETTING_KEY,
  enabledRevenueTaxFlags,
  groupRevenueTaxFlags,
  groupAppliesRevenueTax,
  isRevenueTaxEnabled,
  revenueTaxAmounts,
  revenueTaxFlagsFromSettings,
  revenueTaxSqlExpression
} = taxService;

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.send = (payload) => { res.body = payload; return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; return res; };
  return res;
}

function clearSettings() {
  memoryDb.prepare("DELETE FROM system_settings").run();
}

function setSetting(key, value) {
  memoryDb.prepare("INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function storedSettings() {
  return Object.fromEntries(memoryDb.prepare("SELECT key, value FROM system_settings").all().map((row) => [row.key, row.value]));
}

function saveSettings(body) {
  const res = fakeRes();
  settingsController.updateSettings({ body }, res);
  return res.body.settings;
}

const NONE = { us: false, br: false, any: false };
const BOTH = { us: true, br: true, any: true };
const US_ONLY = { us: true, br: false, any: true };
const BR_ONLY = { us: false, br: true, any: true };

test("each kind has its own switch; a kind never saved inherits the legacy single switch", () => {
  assert.deepEqual(revenueTaxFlagsFromSettings({}), NONE);
  assert.deepEqual(revenueTaxFlagsFromSettings({ [LEGACY_REVENUE_TAX_SETTING_KEY]: "1" }), BOTH);
  assert.deepEqual(revenueTaxFlagsFromSettings({ [REVENUE_TAX_SETTING_KEYS.us]: "1", [REVENUE_TAX_SETTING_KEYS.br]: "0" }), US_ONLY);
  assert.deepEqual(revenueTaxFlagsFromSettings({ [REVENUE_TAX_SETTING_KEYS.us]: "0", [REVENUE_TAX_SETTING_KEYS.br]: "true" }), BR_ONLY);
  // The saved kinds win over the legacy switch; an empty value counts as never saved.
  assert.deepEqual(revenueTaxFlagsFromSettings({ [LEGACY_REVENUE_TAX_SETTING_KEY]: "1", [REVENUE_TAX_SETTING_KEYS.us]: "0", [REVENUE_TAX_SETTING_KEYS.br]: "0" }), NONE);
  assert.deepEqual(revenueTaxFlagsFromSettings({ [LEGACY_REVENUE_TAX_SETTING_KEY]: "1", [REVENUE_TAX_SETTING_KEYS.us]: "0", [REVENUE_TAX_SETTING_KEYS.br]: "" }), BR_ONLY);
});

test("enabledRevenueTaxFlags reads the switches from system_settings", () => {
  clearSettings();
  assert.deepEqual(enabledRevenueTaxFlags(), NONE);
  assert.equal(isRevenueTaxEnabled(), false);
  setSetting(LEGACY_REVENUE_TAX_SETTING_KEY, "1");
  assert.deepEqual(enabledRevenueTaxFlags(), BOTH);
  setSetting(REVENUE_TAX_SETTING_KEYS.us, "0");
  assert.deepEqual(enabledRevenueTaxFlags(), BR_ONLY);
  assert.equal(isRevenueTaxEnabled(), true);
  setSetting(REVENUE_TAX_SETTING_KEYS.br, "0");
  assert.deepEqual(enabledRevenueTaxFlags(), NONE);
  clearSettings();
});

test("a group withholds only the kinds that are on and that it opted into", () => {
  const optedIn = { apply_revenue_tax: 1 };
  const optedOut = { apply_revenue_tax: 0 };
  assert.deepEqual(groupRevenueTaxFlags(optedIn, US_ONLY), US_ONLY);
  assert.deepEqual(groupRevenueTaxFlags(optedIn, BOTH), BOTH);
  assert.deepEqual(groupRevenueTaxFlags(optedOut, BOTH), NONE);
  assert.deepEqual(groupRevenueTaxFlags(optedIn, NONE), NONE);
  // Boolean callers from before the split: true means both kinds.
  assert.deepEqual(groupRevenueTaxFlags(optedIn, true), BOTH);
  assert.equal(groupAppliesRevenueTax(optedIn, US_ONLY), true);
  assert.equal(groupAppliesRevenueTax(optedIn, false), false);
  clearSettings();
  setSetting(REVENUE_TAX_SETTING_KEYS.br, "1");
  assert.deepEqual(groupRevenueTaxFlags(optedIn), BR_ONLY);
  clearSettings();
});

test("tax amounts and the SQL share base only count the kinds that apply", () => {
  const channel = { revenue_us: 100, revenue_br: 50 };
  // 50 * 0.14 is 7.000000000000001 in floating point: compare rounded cents.
  const round = (value) => Math.round(value * 1e6) / 1e6;
  const amounts = (flags) => Object.fromEntries(Object.entries(revenueTaxAmounts(channel, flags)).map(([key, value]) => [key, round(value)]));
  assert.deepEqual(amounts(BOTH), { tax_us: 30, tax_br: 7, total_tax_usd: 37 });
  assert.deepEqual(amounts(US_ONLY), { tax_us: 30, tax_br: 0, total_tax_usd: 30 });
  assert.deepEqual(amounts(BR_ONLY), { tax_us: 0, tax_br: 7, total_tax_usd: 7 });
  assert.deepEqual(amounts(NONE), { tax_us: 0, tax_br: 0, total_tax_usd: 0 });
  assert.deepEqual(amounts(true), { tax_us: 30, tax_br: 7, total_tax_usd: 37 });
  assert.deepEqual(amounts(false), { tax_us: 0, tax_br: 0, total_tax_usd: 0 });

  assert.equal(revenueTaxSqlExpression("cr", BOTH), "(cr.revenue - cr.revenue_us * 0.3 - cr.revenue_br * 0.14)");
  assert.equal(revenueTaxSqlExpression("cr", US_ONLY), "(cr.revenue - cr.revenue_us * 0.3)");
  assert.equal(revenueTaxSqlExpression("cr", BR_ONLY), "(cr.revenue - cr.revenue_br * 0.14)");
  assert.equal(revenueTaxSqlExpression("cr", NONE), "cr.revenue");
  assert.equal(revenueTaxSqlExpression("cr", false), "cr.revenue");
  assert.equal(revenueTaxSqlExpression("cr"), revenueTaxSqlExpression("cr", BOTH));
  const evaluate = (flags) => round(memoryDb.prepare(`SELECT ${revenueTaxSqlExpression("cr", flags)} AS value FROM (SELECT 1000 AS revenue, 100 AS revenue_us, 50 AS revenue_br) cr`).get().value);
  assert.equal(evaluate(BOTH), 963);
  assert.equal(evaluate(US_ONLY), 970);
  assert.equal(evaluate(BR_ONLY), 993);
  assert.equal(evaluate(NONE), 1000);
});

test("settings API: separate switches, legacy fallback on read, legacy key mirrors 'any kind on'", () => {
  clearSettings();
  setSetting(LEGACY_REVENUE_TAX_SETTING_KEY, "1");
  const legacyOnly = fakeRes();
  settingsController.getSettings({}, legacyOnly);
  assert.equal(legacyOnly.body.settings.revenue_tax_us_enabled, "1");
  assert.equal(legacyOnly.body.settings.revenue_tax_br_enabled, "1");
  assert.equal(legacyOnly.body.settings.revenue_tax_us_br_enabled, "1");

  let settings = saveSettings({ revenue_tax_us_enabled: "1", revenue_tax_br_enabled: "0" });
  assert.deepEqual([settings.revenue_tax_us_enabled, settings.revenue_tax_br_enabled, settings.revenue_tax_us_br_enabled], ["1", "0", "1"]);
  assert.deepEqual(enabledRevenueTaxFlags(), US_ONLY);
  assert.equal(storedSettings().revenue_tax_us_br_enabled, "1");

  settings = saveSettings({ revenue_tax_us_enabled: "0", revenue_tax_br_enabled: "0" });
  assert.deepEqual([settings.revenue_tax_us_enabled, settings.revenue_tax_br_enabled, settings.revenue_tax_us_br_enabled], ["0", "0", "0"]);
  assert.deepEqual(enabledRevenueTaxFlags(), NONE);

  // One switch alone: the other keeps its stored value and the legacy key still reads as "any kind on".
  settings = saveSettings({ revenue_tax_br_enabled: "on" });
  assert.deepEqual([settings.revenue_tax_us_enabled, settings.revenue_tax_br_enabled, settings.revenue_tax_us_br_enabled], ["0", "1", "1"]);
  assert.deepEqual(enabledRevenueTaxFlags(), BR_ONLY);

  // A client from before the split sends the single switch: both kinds follow it.
  settings = saveSettings({ revenue_tax_us_br_enabled: "1" });
  assert.deepEqual([settings.revenue_tax_us_enabled, settings.revenue_tax_br_enabled], ["1", "1"]);
  settings = saveSettings({ revenue_tax_us_br_enabled: "0" });
  assert.deepEqual([settings.revenue_tax_us_enabled, settings.revenue_tax_br_enabled, settings.revenue_tax_us_br_enabled], ["0", "0", "0"]);
  clearSettings();
});

test("analyzeImportRows reports which optional revenue columns the header carried", () => {
  const withBoth = reportController.analyzeImportRows([
    ["Channel ID", "Revenue", "Revenue US", "Revenue BR"],
    ["UCabc", "1000", "100", "50"],
    ["UCdef", "200", "0", "20"]
  ]);
  assert.deepEqual(withBoth.columns, { revenue_us: true, revenue_br: true });
  assert.deepEqual(withBoth.rows, [
    { channel_id: "UCabc", revenue: 1000, revenue_us: 100, revenue_br: 50 },
    { channel_id: "UCdef", revenue: 200, revenue_us: 0, revenue_br: 20 }
  ]);
  const usOnly = reportController.analyzeImportRows([["Channel ID", "Revenue", "Revenue US"], ["UCabc", "10", "2"]]);
  assert.deepEqual(usOnly.columns, { revenue_us: true, revenue_br: false });
  assert.deepEqual(reportController.analyzeImportRows([["Channel ID", "Revenue"], ["UCabc", "10"]]).columns, { revenue_us: false, revenue_br: false });
  assert.deepEqual(reportController.analyzeImportRows([]), { rows: [], columns: { revenue_us: false, revenue_br: false } });
});

async function importCsv(csv, month = "2026-09") {
  const res = fakeRes();
  await reportController.importManagerReport({
    body: { month, network_id: 1, fileName: "report.csv", fileBase64: Buffer.from(csv, "utf8").toString("base64") }
  }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  return res.body.data;
}

test("the import names the switched-on taxes whose column is missing from the file", async () => {
  memoryDb.prepare("INSERT INTO networks (id, name, network_code) VALUES (1, 'Net', 'NET')").run();
  clearSettings();

  // No tax switched on: nothing to remind.
  let data = await importCsv("Channel ID,Revenue\nUCabc,1000\n");
  assert.deepEqual(data.missing_tax_columns, []);
  assert.deepEqual(data.revenue_tax, { us: 0, br: 0 });
  assert.deepEqual(data.columns, { revenue_us: false, revenue_br: false });

  // US on, BR off: only a missing US column is worth a reminder.
  setSetting(REVENUE_TAX_SETTING_KEYS.us, "1");
  setSetting(REVENUE_TAX_SETTING_KEYS.br, "0");
  data = await importCsv("Channel ID,Revenue,Revenue BR\nUCabc,1000,50\n");
  assert.deepEqual(data.missing_tax_columns, ["us"]);
  assert.deepEqual(data.revenue_tax, { us: 1, br: 0 });
  data = await importCsv("Channel ID,Revenue,Revenue US\nUCabc,1000,100\n");
  assert.deepEqual(data.missing_tax_columns, []);
  assert.equal(data.total_revenue_us, 100);
  const saved = memoryDb.prepare("SELECT revenue, revenue_us, revenue_br FROM channel_revenues WHERE channel_id = 'UCabc' AND month = '2026-09'").get();
  assert.deepEqual(saved, { revenue: 1000, revenue_us: 100, revenue_br: 0 });

  // Both on, neither column present.
  setSetting(REVENUE_TAX_SETTING_KEYS.br, "1");
  data = await importCsv("Channel ID,Revenue\nUCabc,1000\n", "2026-10");
  assert.deepEqual(data.missing_tax_columns, ["us", "br"]);
  clearSettings();
});

test("the Excel export adds only the Revenue / Tax columns of the kinds that are on", async () => {
  const { revenueTaxExportColumns, generateGroupReconciliationExcel } = templateService;
  const headers = (options) => revenueTaxExportColumns(options).map((column) => column.header);
  assert.deepEqual(headers({ export_tax_us: true, export_tax_br: true }), ["Revenue US", "Tax US", "Revenue BR", "Tax BR"]);
  assert.deepEqual(headers({ export_tax_us: true, export_tax_br: false }), ["Revenue US", "Tax US"]);
  assert.deepEqual(headers({ export_tax_us: false, export_tax_br: true }), ["Revenue BR", "Tax BR"]);
  assert.deepEqual(headers({ export_tax_us: false, export_tax_br: false }), []);
  // Pre-split callers: the single option means both kinds.
  assert.deepEqual(headers({ export_us_br: true }), ["Revenue US", "Tax US", "Revenue BR", "Tax BR"]);
  assert.deepEqual(headers({}), []);

  const detail = {
    id: 5,
    group_name: "Group A",
    partner_name: "Partner A",
    display_name: "Partner A",
    address: "",
    phone: "",
    email: "",
    contact_name: "Partner A",
    month: "2026-09",
    currency: "USD",
    fee_rate: 0,
    exchange_rate: { factor: 1, description: "" },
    channels: [{
      title: "Channel A",
      channel_id: "UCabc",
      network_name: "Net",
      status: "active",
      status_error: "",
      revenue_usd: 1000,
      revenue_us: 100,
      tax_us: 30,
      revenue_br: 50,
      tax_br: 0,
      applied_share: 50,
      share_amount: 485,
      share_amount_converted: 485,
      paid: 485
    }],
    summary: { total_revenue_usd: 1000, paid_converted: 485, fee_converted: 0, payable_converted: 485 }
  };
  const company = { company_name: "ANS Network", address: "", phone: "", email: "", representative_name: "", representative_position: "" };

  async function sheetTexts(options) {
    const buffer = await generateGroupReconciliationExcel(detail, company, options);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const texts = [];
    workbook.worksheets[0].eachRow((row) => row.eachCell((cell) => {
      if (typeof cell.value === "string") texts.push(cell.value);
    }));
    return texts;
  }

  const usOnly = await sheetTexts({ language: "vi", export_us_br: true, export_tax_us: true, export_tax_br: false });
  assert.ok(usOnly.includes("Revenue US") && usOnly.includes("Tax US"), "US columns present");
  assert.ok(!usOnly.includes("Revenue BR") && !usOnly.includes("Tax BR"), "BR columns absent");

  const both = await sheetTexts({ language: "vi", export_us_br: true, export_tax_us: true, export_tax_br: true });
  ["Revenue US", "Tax US", "Revenue BR", "Tax BR"].forEach((header) => assert.ok(both.includes(header), header));

  const none = await sheetTexts({ language: "vi" });
  ["Revenue US", "Tax US", "Revenue BR", "Tax BR"].forEach((header) => assert.ok(!none.includes(header), `${header} absent`));
});
