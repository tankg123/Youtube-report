const path = require("path");
const ExcelJS = require("exceljs");

const EXCELJS_MERGE_CELL_TYPE = 8;

function safeStr(value) {
  return value == null ? "" : String(value);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round2(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function normalizedCurrency(value) {
  const currency = safeStr(value).trim().toUpperCase();
  return ["USD", "GBP", "VND"].includes(currency) ? currency : "USD";
}

function formatMonthLabel(month = "") {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  const [year, monthValue] = month.split("-");
  return `${monthValue}/${year}`;
}

function formatEnglishRevenuePeriod(month = "") {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  const [year, monthValue] = month.split("-");
  const date = new Date(Number(year), Number(monthValue) - 1, 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function moneyText(value, currency = "USD") {
  const normalized = normalizedCurrency(currency);
  return new Intl.NumberFormat(
    normalized === "VND" ? "vi-VN" : normalized === "GBP" ? "en-GB" : "en-US",
    {
      minimumFractionDigits: normalized === "VND" ? 0 : 2,
      maximumFractionDigits: normalized === "VND" ? 0 : 2
    }
  ).format(normalized === "VND" ? Math.round(toNumber(value)) : round2(value));
}

const VN_NUM = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

function readThreeDigits(input, full) {
  const value = input % 1000;
  const hundreds = Math.floor(value / 100);
  const tens = Math.floor((value % 100) / 10);
  const units = value % 10;
  const output = [];

  if (full || hundreds > 0) output.push(VN_NUM[hundreds], "trăm");

  if (tens === 0) {
    if (units !== 0) {
      if (full || hundreds > 0) output.push("lẻ");
      output.push(units === 5 && (full || hundreds > 0) ? "năm" : VN_NUM[units]);
    }
  } else if (tens === 1) {
    output.push("mười");
    if (units === 5) output.push("lăm");
    else if (units !== 0) output.push(VN_NUM[units]);
  } else {
    output.push(VN_NUM[tens], "mươi");
    if (units === 1) output.push("mốt");
    else if (units === 4) output.push("tư");
    else if (units === 5) output.push("lăm");
    else if (units !== 0) output.push(VN_NUM[units]);
  }

  return output.join(" ").replace(/\s+/g, " ").trim();
}

function integerWords(value) {
  let number = Math.round(toNumber(value));
  if (number === 0) return "Không";
  if (number < 0) return `Âm ${integerWords(Math.abs(number))}`;

  const units = ["", "nghìn", "triệu", "tỷ", "nghìn tỷ", "triệu tỷ"];
  const parts = [];
  let index = 0;

  while (number > 0 && index < units.length) {
    const block = number % 1000;
    number = Math.floor(number / 1000);

    if (block !== 0) {
      const text = readThreeDigits(block, number > 0);
      parts.unshift(`${text} ${units[index]}`.trim());
    }

    index += 1;
  }

  const result = parts.join(" ").replace(/\s+/g, " ").trim();
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function moneyWords(value, currency) {
  const normalized = normalizedCurrency(currency);
  if (normalized === "VND") return `${integerWords(value)} đồng`;
  if (normalized === "GBP") return `${integerWords(value)} bảng Anh`;

  const amount = Math.abs(toNumber(value));
  let dollars = Math.floor(amount);
  let cents = Math.round((amount - dollars) * 100);
  if (cents === 100) {
    dollars += 1;
    cents = 0;
  }

  const prefix = toNumber(value) < 0 ? "Âm " : "";
  const dollarsText = `${integerWords(dollars)} đô la`;
  return cents > 0 ? `${prefix}${dollarsText} và ${integerWords(cents)} cent` : `${prefix}${dollarsText}`;
}

function getByPath(source, pathValue) {
  return pathValue
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((value, key) => {
      if (value == null || typeof value !== "object") return undefined;
      return value[key];
    }, source);
}

function normalizedExportLanguage(value) {
  const language = safeStr(value).trim().toLowerCase();
  return ["en", "english"].includes(language) ? "en" : "vi";
}

const EN_ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen"
];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const EN_SCALES = ["", "thousand", "million", "billion", "trillion"];

function englishBelowThousand(value) {
  const number = Math.floor(Math.abs(value));
  const parts = [];
  const hundreds = Math.floor(number / 100);
  const rest = number % 100;

  if (hundreds) parts.push(`${EN_ONES[hundreds]} hundred`);
  if (rest) {
    if (rest < 20) {
      parts.push(EN_ONES[rest]);
    } else {
      const tens = Math.floor(rest / 10);
      const ones = rest % 10;
      parts.push(ones ? `${EN_TENS[tens]}-${EN_ONES[ones]}` : EN_TENS[tens]);
    }
  }

  return parts.join(" ");
}

function englishIntegerWords(value) {
  let number = Math.round(Math.abs(toNumber(value)));
  if (number === 0) return "zero";

  const parts = [];
  let scaleIndex = 0;
  while (number > 0 && scaleIndex < EN_SCALES.length) {
    const block = number % 1000;
    if (block) {
      const scale = EN_SCALES[scaleIndex];
      parts.unshift(`${englishBelowThousand(block)}${scale ? ` ${scale}` : ""}`);
    }
    number = Math.floor(number / 1000);
    scaleIndex += 1;
  }

  return parts.join(" ");
}

function capitalizeFirst(value) {
  const text = safeStr(value).trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function englishMoneyWords(value, currency) {
  const normalized = normalizedCurrency(currency);
  const amount = Math.abs(toNumber(value));
  const integer = Math.floor(amount);
  let cents = Math.round((amount - integer) * 100);
  let whole = integer;
  if (cents === 100) {
    whole += 1;
    cents = 0;
  }

  const unit = normalized === "VND" ? "Vietnamese dong" : normalized === "GBP" ? "pounds sterling" : "US dollars";
  const prefix = toNumber(value) < 0 ? "Minus " : "";
  const wholeText = `${capitalizeFirst(englishIntegerWords(whole))} ${unit}`;
  if (normalized !== "VND" && cents > 0) {
    return `${prefix}${wholeText} and ${englishIntegerWords(cents)} cents`;
  }
  return `${prefix}${wholeText}`;
}

const EN_STATIC_REPLACEMENTS = [
  [/C\u1ed8NG H\u00d2A X\u00c3 H\u1ed8I CH\u1ee6 NGH\u0128A VI\u1ec6T NAM/g, "YOUTUBE RECONCILIATION STATEMENT"],
  [/\u0110\u1ed9c l\u1eadp - T\u1ef1 do - H\u1ea1nh ph\u00fac/g, "Revenue Share Reconciliation"],
  [/----- o0o -----/g, ""],
  [/BI\u00caN B\u1ea2N \u0110\u1ed0I SO\u00c1T YOUTUBE/g, "YOUTUBE RECONCILIATION MINUTES"],
  [/B\u00ean A/g, "Party A"],
  [/B\u00ean B/g, "Party B"],
  [/\u0110\u1ecba ch\u1ec9/g, "Address"],
  [/\u0110i\u1ec7n tho\u1ea1i/g, "Phone"],
  [/\u0110\u1ea1i di\u1ec7n/g, "Representative"],
  [/Ch\u1ee9c v\u1ee5/g, "Position"],
  [/DOANH THU PH\u00c2N CHIA SAU \u0110\u1ed0I SO\u00c1T/g, "REVENUE SHARE AFTER RECONCILIATION"],
  [/STT/g, "No."],
  [/K\u00caNH/g, "Channel"],
  [/Link K\u00eanh/g, "Channel ID"],
  [/T\u1ed5ng Doanh Thu\s*K\u00eanh/g, "Total Channel Revenue"],
  [/T\u1ed5ng Doanh Thu/g, "Total Revenue"],
  [/T\u1ef7 L\u1ec7/g, "Share"],
  [/Ghi ch\u00fa/g, "Notes"],
  [/T\u1ed5ng Ti\u1ec1n B\u00ean A ph\u1ea3i thanh to\u00e1n cho B\u00ean B/g, "Total payable from Party A to Party B"],
  [/T\u1ed5ng Ti\u1ec1n Party A ph\u1ea3i thanh to\u00e1n cho Party B/g, "Total payable from Party A to Party B"],
  [/T\u1ed5ng Ti\u1ec1n/g, "Subtotal"],
  [/Thu\u1ebf Ph\u00ed/g, "Fee"],
  [/\u0110\u00e3 t\u1ea1m \u1ee9ng/g, "Advance"],
  [/S\u1ed1 ti\u1ec1n b\u1eb1ng ch\u1eef/g, "Amount in words"],
  [/Bi\u00ean b\u1ea3n n\u00e0y \u0111\u01b0\u1ee3c l\u1eadp th\u00e0nh.*$/g, "This reconciliation statement is made in two originals of equal legal validity, one for each party."],
  [/TP\.H\u1ed3 Ch\u00ed Minh, ng\u00e0y.*$/g, "Ho Chi Minh City, date ........ month ........ year 20...."],
  [/C\u1ed9ng H\u00f2a X\u00e3 H\u1ed9i Ch\u1ee7 Ngh\u0129a Vi\u1ec7t Nam/gi, "YOUTUBE RECONCILIATION STATEMENT"],
  [/Bi\u00ean B\u1ea3n \u0110\u1ed1i So\u00e1t Youtube/gi, "YOUTUBE RECONCILIATION MINUTES"]
];

function translateStaticTextToEnglish(input) {
  let output = safeStr(input);
  for (const [pattern, replacement] of EN_STATIC_REPLACEMENTS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function applyEnglishStaticText(ws) {
  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      const value = cell.value;
      if (typeof value === "string") {
        cell.value = translateStaticTextToEnglish(value);
        return;
      }

      if (value && typeof value === "object" && Array.isArray(value.richText)) {
        cell.value = {
          richText: value.richText.map((run) => ({
            ...run,
            text: translateStaticTextToEnglish(run.text || "")
          }))
        };
      }
    });
  });
}

function valueCell(cell) {
  return cell.master && cell.master.address !== cell.address ? cell.master : cell;
}

function normalizePhonePrefixText(value) {
  return safeStr(value)
    .replace(/((?:Phone|Phone \/ Email)\s*:?\s*)\+84\s+(?=\+)/gi, "$1")
    .replace(/(\u0110i\u1ec7n tho\u1ea1i\s*:?\s*)\+84\s+(?=\+)/gi, "$1");
}

function normalizePhonePrefixInWorksheet(ws) {
  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      const target = valueCell(cell);
      const value = target.value;

      if (typeof value === "string") {
        const normalized = normalizePhonePrefixText(value);
        if (normalized !== value) target.value = normalized;
        return;
      }

      if (value && typeof value === "object" && Array.isArray(value.richText)) {
        target.value = {
          richText: value.richText.map((run) => ({
            ...run,
            text: normalizePhonePrefixText(run.text || "")
          }))
        };
      }
    });
  });
}

function rowTextCells(ws, rowNumber) {
  const row = ws.getRow(rowNumber);
  const cells = [];
  const seen = new Set();

  row.eachCell({ includeEmpty: false }, (cell) => {
    const target = valueCell(cell);
    if (seen.has(target.address)) return;
    seen.add(target.address);
    if (typeof target.value === "string") cells.push(target);
  });

  return cells;
}

function replaceRowText(ws, rowNumber, text) {
  const cells = rowTextCells(ws, rowNumber);
  if (cells.length === 0) {
    ws.getRow(rowNumber).getCell(1).value = text;
    return;
  }

  cells[0].value = text;
  for (let index = 1; index < cells.length; index += 1) {
    cells[index].value = "";
  }
}

function clearRowText(ws, rowNumber) {
  for (const cell of rowTextCells(ws, rowNumber)) {
    cell.value = "";
  }
}

function applyEnglishHeader(ws, month) {
  replaceRowText(ws, 1, "YOUTUBE REVENUE SHARE STATEMENT");
  replaceRowText(ws, 2, `Revenue Period: ${formatEnglishRevenuePeriod(month)}`);
  clearRowText(ws, 4);
}

function templatePathForLanguage(language) {
  const fileName = normalizedExportLanguage(language) === "en"
    ? "youtube-reconciliation.template.en.xlsx"
    : "youtube-reconciliation.template.v2.xlsx";
  return path.resolve(__dirname, "../../templates", fileName);
}

function itemValue(item, field, payload) {
  if (field === "yt_channel_id") return item.yt_channels_id;
  if (field === "payout_by_type") return moneyText(item.payout_value, payload.meta.type_rate);
  return item[field];
}

function resolvePlaceholder(payload, key, item) {
  const cleanKey = key.trim();

  if (cleanKey.startsWith("table.items.")) {
    return item ? itemValue(item, cleanKey.replace("table.items.", "").trim(), payload) : "";
  }

  if (cleanKey === "grand.total_payout") return moneyText(payload.grand_raw.total_payout, payload.meta.type_rate);
  if (cleanKey === "grand.tax") return moneyText(payload.grand_raw.tax, payload.meta.type_rate);
  if (cleanKey === "grand.advance") return moneyText(payload.grand_raw.advance, payload.meta.type_rate);
  if (cleanKey === "grand.payable") return moneyText(payload.grand_raw.payable, payload.meta.type_rate);

  const value = getByPath(payload, cleanKey);
  return value == null ? "" : value;
}

function transformStaticText(input, payload) {
  const currency = normalizedCurrency(payload.meta.type_rate);
  if (currency === "VND") return input;
  return input.replace(/\(VND\)/g, `(${currency})`);
}

function replaceInString(payload, input, item) {
  const transformed = transformStaticText(input, payload);
  const pure = transformed.match(/^\$\{([^}]+)\}$/);

  if (pure) {
    return {
      result: resolvePlaceholder(payload, pure[1], item),
      pure: true
    };
  }

  const result = transformed.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const value = resolvePlaceholder(payload, key, item);
    return value == null ? "" : String(value);
  });

  return {
    result,
    pure: false
  };
}

function getMerges(ws) {
  return ws._merges || {};
}

function snapshotRow(ws, rowNumber) {
  const row = ws.getRow(rowNumber);
  const cells = [];

  row.eachCell({ includeEmpty: true }, (cell, col) => {
    cells.push({
      col,
      value: cell.value,
      style: JSON.parse(JSON.stringify(cell.style || {})),
      numFmt: cell.numFmt,
      isMaster: cell.type !== EXCELJS_MERGE_CELL_TYPE
    });
  });

  const merges = [];
  for (const key of Object.keys(getMerges(ws))) {
    const entry = getMerges(ws)[key];
    const merge = entry?.model || entry;
    if (merge && merge.top === rowNumber && merge.bottom === rowNumber && merge.left !== merge.right) {
      merges.push({ startCol: merge.left, endCol: merge.right });
    }
  }

  return {
    height: row.height || 15,
    cells,
    merges
  };
}

function clearOverlappingRowMerges(ws, rowNumber, startCol, endCol) {
  const raw = getMerges(ws);

  for (const key of Object.keys(raw)) {
    const entry = raw[key];
    const merge = entry?.model || entry;
    if (!merge) continue;

    if (
      merge.top <= rowNumber &&
      merge.bottom >= rowNumber &&
      merge.left <= endCol &&
      merge.right >= startCol
    ) {
      delete raw[key];
    }
  }
}

function applySnapshotToRow(ws, rowNumber, snapshot) {
  const row = ws.getRow(rowNumber);
  row.height = snapshot.height;

  for (const cellSnapshot of snapshot.cells) {
    const cell = row.getCell(cellSnapshot.col);
    cell.style = JSON.parse(JSON.stringify(cellSnapshot.style || {}));
    cell.numFmt = cellSnapshot.numFmt;
    if (cellSnapshot.isMaster) cell.value = cellSnapshot.value;
  }

  for (const merge of snapshot.merges) {
    clearOverlappingRowMerges(ws, rowNumber, merge.startCol, merge.endCol);
    ws.mergeCells(rowNumber, merge.startCol, rowNumber, merge.endCol);
  }
}

function shiftMergesDown(ws, afterRow, count) {
  if (count <= 0) return;
  const raw = getMerges(ws);
  const additions = [];
  const deletions = [];

  for (const key of Object.keys(raw)) {
    const entry = raw[key];
    const merge = entry?.model || entry;
    if (!merge) continue;

    if (merge.top > afterRow) {
      deletions.push(key);
      additions.push({
        top: merge.top + count,
        bottom: merge.bottom + count,
        left: merge.left,
        right: merge.right
      });
    }
  }

  deletions.forEach((key) => delete raw[key]);
  additions.forEach((merge) => ws.mergeCells(merge.top, merge.left, merge.bottom, merge.right));
}

function findItemsTemplateRow(ws) {
  let found = null;
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (found) return;
    row.eachCell({ includeEmpty: true }, (cell) => {
      if (typeof cell.value === "string" && cell.value.includes("${table.items.")) found = rowNumber;
    });
  });
  return found;
}

const REVENUE_TAX_EXPORT_COLUMNS = [
  { header: "Revenue US", placeholder: "${table.items.revenue_us}" },
  { header: "Tax US", placeholder: "${table.items.tax_us}" },
  { header: "Revenue BR", placeholder: "${table.items.revenue_br}" },
  { header: "Tax BR", placeholder: "${table.items.tax_br}" }
];

function isMergeSlaveCell(cell) {
  return cell.type === ExcelJS.ValueType.Merge;
}

function cloneCellValue(value) {
  if (value == null) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function cloneStyle(sourceCell, targetCell) {
  targetCell.style = JSON.parse(JSON.stringify(sourceCell.style || {}));
  targetCell.numFmt = sourceCell.numFmt;
}

function copyCell(sourceCell, targetCell) {
  cloneStyle(sourceCell, targetCell);
  // A merge slave only mirrors its master; copying its value would duplicate the master text.
  targetCell.value = isMergeSlaveCell(sourceCell) ? null : cloneCellValue(sourceCell.value);
}

function cloneStyleObject(style) {
  return JSON.parse(JSON.stringify(style || {}));
}

// Right edge of the row's content. Merge slaves report their master's value, so a merged band counts up to its
// own right edge, while formatted-but-empty cells (a common artifact of editing a template in Excel) do not.
function lastValueColumn(row) {
  let last = 0;
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    const value = cell.value;
    if (value != null && value !== "") last = col;
  });
  return last;
}

// Inserts Revenue US / Tax US / Revenue BR / Tax BR right after the "total_usd" columns of the items table and
// shifts the remaining table columns (share rate, payout, note) to the right. The table block is the group header,
// header, formula hint and item template rows plus the spacer and sum rows right under the template, so the
// border grid stays continuous.
function insertRevenueTaxExportColumns(ws, templateRow) {
  const template = ws.getRow(templateRow);
  let totalStartCol = null;
  let totalEndCol = null;

  template.eachCell({ includeEmpty: true }, (cell, col) => {
    if (typeof cell.value === "string" && cell.value.includes("${table.items.total_usd}")) {
      if (totalStartCol == null) totalStartCol = col;
      totalEndCol = col;
    }
  });

  if (totalStartCol == null || totalEndCol == null) return null;

  const insertAt = totalEndCol + 1;
  const insertedColumnCount = REVENUE_TAX_EXPORT_COLUMNS.length;
  const headerGroupRow = templateRow - 3;
  const headerRow = templateRow - 2;
  const formulaRow = templateRow - 1;
  const spacerRow = templateRow + 1;
  const sumRow = templateRow + 2;
  const tableRows = [headerGroupRow, headerRow, formulaRow, templateRow, spacerRow, sumRow].filter((rowNumber) => rowNumber >= 1);
  const originalLastCol = Math.max(totalEndCol, ...tableRows.map((rowNumber) => lastValueColumn(ws.getRow(rowNumber))));
  const shiftedLastCol = originalLastCol + insertedColumnCount;
  const groupHeaderValue = headerGroupRow >= 1 ? cloneCellValue(ws.getCell(headerGroupRow, totalStartCol).value) : null;

  // Border pattern of the first column being pushed right (the old "share rate" column), captured before the shift.
  const insertBorders = new Map();
  for (const rowNumber of tableRows) {
    insertBorders.set(rowNumber, cloneStyleObject(ws.getCell(rowNumber, insertAt).style).border);
  }

  for (let col = originalLastCol; col >= insertAt; col -= 1) {
    const width = ws.getColumn(col).width;
    if (width) ws.getColumn(col + insertedColumnCount).width = width;
  }

  for (const rowNumber of tableRows) {
    clearOverlappingRowMerges(ws, rowNumber, insertAt, shiftedLastCol);

    for (let col = originalLastCol; col >= insertAt; col -= 1) {
      const sourceCell = ws.getCell(rowNumber, col);
      const targetCell = ws.getCell(rowNumber, col + insertedColumnCount);
      copyCell(sourceCell, targetCell);
      if (!isMergeSlaveCell(sourceCell)) sourceCell.value = null;
      sourceCell.style = {};
    }
  }

  REVENUE_TAX_EXPORT_COLUMNS.forEach((column, index) => {
    const col = insertAt + index;
    ws.getColumn(col).width = 14;

    for (const rowNumber of tableRows) {
      // Look of the "total_usd" band (numeric format, fill, font) with the full border grid of a regular column.
      const style = cloneStyleObject(ws.getCell(rowNumber, totalStartCol).style);
      const border = insertBorders.get(rowNumber);
      if (border) style.border = cloneStyleObject(border);
      const cell = ws.getCell(rowNumber, col);
      cell.style = style;

      if (rowNumber === headerRow) {
        cell.value = column.header;
      } else if (rowNumber === templateRow) {
        cell.value = column.placeholder;
        cell.numFmt = "#,##0.00";
      } else {
        cell.value = null;
      }
    }
  });

  if (headerGroupRow >= 1) {
    clearOverlappingRowMerges(ws, headerGroupRow, totalStartCol, shiftedLastCol);
    // Keep each cell's own style so the right border of the (shifted) last cell survives the merge.
    ws.mergeCellsWithoutStyle(headerGroupRow, totalStartCol, headerGroupRow, shiftedLastCol);
    const mergedHeader = ws.getCell(headerGroupRow, totalStartCol);
    if (mergedHeader.value == null && groupHeaderValue != null) mergedHeader.value = groupHeaderValue;
  }

  return {
    valueStartCol: totalStartCol,
    originalLastCol,
    rightCol: shiftedLastCol,
    insertAt,
    insertedColumnCount
  };
}

// Extends one single-row merge [left..oldRight] to [left..newRight], keeping the master value and moving the
// old last cell's look (the right border) to the new last cell.
function extendRowMerge(ws, rowNumber, left, oldRight, newRight) {
  if (newRight <= oldRight) return;
  const masterCell = ws.getCell(rowNumber, left);
  if (isMergeSlaveCell(masterCell)) return;
  const value = cloneCellValue(masterCell.value);
  const innerStyle = cloneStyleObject(masterCell.style);
  const edgeStyle = cloneStyleObject(ws.getCell(rowNumber, oldRight).style || masterCell.style);

  clearOverlappingRowMerges(ws, rowNumber, left, newRight);

  for (let col = left + 1; col <= newRight; col += 1) {
    const cell = ws.getCell(rowNumber, col);
    if (!isMergeSlaveCell(cell)) cell.value = null;
    cell.style = cloneStyleObject(col === newRight ? edgeStyle : innerStyle);
  }

  masterCell.value = value;
  ws.mergeCellsWithoutStyle(rowNumber, left, rowNumber, newRight);
}

// Rows outside the items table that were merged up to the table's old right edge (summary rows under the table,
// the title block, amount in words, signature block) are widened to the new edge. A standalone cell right after
// such a band (the exchange-rate value) is pushed to the new edge so it stays at the table's right side.
function widenRowsOutsideTable(ws, tableTop, tableBottom, state) {
  if (!state) return;
  const { originalLastCol, rightCol, insertedColumnCount } = state;
  const raw = getMerges(ws);
  const merges = Object.keys(raw)
    .map((key) => raw[key]?.model || raw[key])
    .filter((merge) => merge && merge.top === merge.bottom && (merge.top < tableTop || merge.top > tableBottom))
    .map((merge) => ({ top: merge.top, left: merge.left, right: merge.right }))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  for (const merge of merges) {
    const rowNumber = merge.top;
    if (merge.right === originalLastCol) {
      extendRowMerge(ws, rowNumber, merge.left, originalLastCol, rightCol);
    } else if (merge.right === originalLastCol - 1) {
      const tail = ws.getCell(rowNumber, originalLastCol);
      if (isMergeSlaveCell(tail)) continue;
      copyCell(tail, ws.getCell(rowNumber, originalLastCol + insertedColumnCount));
      tail.value = null;
      extendRowMerge(ws, rowNumber, merge.left, originalLastCol - 1, rightCol - 1);
    }
  }
}

function replacePlaceholders(ws, payload, item) {
  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      const value = cell.value;

      if (typeof value === "string") {
        if (value.includes("${")) {
          const replaced = replaceInString(payload, value, item);
          cell.value = typeof replaced.result === "number" ? replaced.result : String(replaced.result || "");
          return;
        }

        const transformed = transformStaticText(value, payload);
        if (transformed !== value) cell.value = transformed;
        return;
      }

      if (value && typeof value === "object" && Array.isArray(value.richText)) {
        cell.value = {
          richText: value.richText.map((run) => ({
            ...run,
            text: typeof run.text === "string" && run.text.includes("${")
              ? String(replaceInString(payload, run.text, item).result || "")
              : transformStaticText(run.text || "", payload)
          }))
        };
      }
    });
  });
}

function makePayload(detail, company, options = {}) {
  const language = normalizedExportLanguage(options.language);
  const currency = normalizedCurrency(detail.currency || "USD");
  const advance = toNumber(options.advance, 0);
  const fee = toNumber(detail.summary?.fee_converted, 0);
  const totalPayout = toNumber(detail.summary?.paid_converted, 0);
  const payable = toNumber(detail.summary?.payable_converted, totalPayout - fee - advance);

  return {
    time: formatMonthLabel(detail.month || ""),
    company: {
      name: safeStr(company.company_name),
      address: safeStr(company.address),
      phone: safeStr(company.phone),
      email: safeStr(company.email),
      representative: safeStr(company.representative_name),
      position: safeStr(company.representative_position)
    },
    partner: {
      name: safeStr(detail.partner_name || detail.display_name),
      address: safeStr(detail.address),
      phone: safeStr(detail.phone),
      email: safeStr(detail.email),
      representative: safeStr(detail.contact_name || detail.partner_name),
      position: safeStr(detail.position)
    },
    exchange_rate: {
      title: detail.exchange_rate?.description
        ? ` ${safeStr(detail.exchange_rate.description)}`
        : "Exchange month description",
      value: currency === "USD"
        ? ""
        : `1 USD = ${moneyText(detail.exchange_rate?.factor || 0, currency)}`
    },
    table: {
      items: (detail.channels || []).map((channel, index) => ({
        no: index + 1,
        channel: safeStr(channel.title || (language === "en" ? "Channel error / dead" : "Channel lỗi / die")),
        yt_channels_id: safeStr(channel.channel_id),
        network: safeStr(channel.network_name || "-"),
        total_usd: round2(channel.revenue_usd),
        revenue_us: round2(channel.revenue_us),
        tax_us: round2(channel.tax_us),
        revenue_br: round2(channel.revenue_br),
        tax_br: round2(channel.tax_br),
        share_rate: `${round2(channel.applied_share)}%`,
        payout_value: currency === "USD" ? round2(channel.share_amount) : toNumber(channel.paid ?? channel.share_amount_converted),
        payout_usd: round2(channel.share_amount),
        payout_vnd: currency === "VND" ? toNumber(channel.paid ?? channel.share_amount_converted) : null,
        note: safeStr(channel.status === "error"
          ? (language === "en" ? "Could not retrieve YouTube data when adding this channel to the group" : channel.status_error)
          : "")
      }))
    },
    sum: {
      total_usd: round2(detail.summary?.total_revenue_usd)
    },
    grand: {
      total_payout: moneyText(totalPayout, currency),
      tax: moneyText(fee, currency),
      advance: moneyText(advance, currency),
      payable: moneyText(payable, currency),
      payable_words: language === "en" ? englishMoneyWords(payable, currency) : moneyWords(payable, currency)
    },
    grand_raw: {
      total_payout: totalPayout,
      tax: fee,
      advance,
      payable
    },
    meta: {
      group_channel_id: safeStr(detail.id),
      group_channel_name: safeStr(detail.group_name),
      month_revenue: safeStr(detail.month),
      currency,
      type_rate: currency,
      language
    }
  };
}

async function generateGroupReconciliationExcel(detail, company, options = {}) {
  const language = normalizedExportLanguage(options.language);
  const templatePath = templatePathForLanguage(language);
  const payload = makePayload(detail, company, { ...options, language });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  for (const ws of workbook.worksheets) {
    ws.name = safeStr(detail.partner_name || detail.group_name || "Reconciliation").slice(0, 31) || "Reconciliation";
    if (language === "en") applyEnglishStaticText(ws);
    const templateRow = findItemsTemplateRow(ws);
    const includeRevenueTaxColumns = Boolean(options.export_us_br || options.exportUsBr);
    let taxColumnState = null;
    const items = payload.table.items.length > 0
      ? payload.table.items
      : [{
          no: 1,
          channel: "",
          yt_channels_id: "",
          network: "",
          total_usd: 0,
          revenue_us: 0,
          tax_us: 0,
          revenue_br: 0,
          tax_br: 0,
          share_rate: "",
          payout_value: 0,
          note: ""
        }];

    if (templateRow) {
      if (includeRevenueTaxColumns) taxColumnState = insertRevenueTaxExportColumns(ws, templateRow);
      if (taxColumnState) {
        // The wider table no longer fits the template's fixed 70% landscape scale; fit it to one page width.
        ws.pageSetup.fitToPage = true;
        ws.pageSetup.fitToWidth = 1;
        ws.pageSetup.fitToHeight = 0;
      }
      const snapshot = snapshotRow(ws, templateRow);

      if (items.length > 1) {
        ws.spliceRows(templateRow + 1, 0, ...new Array(items.length - 1).fill([]));
        shiftMergesDown(ws, templateRow, items.length - 1);

        for (let index = 1; index < items.length; index += 1) {
          applySnapshotToRow(ws, templateRow + index, snapshot);
        }
      }

      for (let index = 0; index < items.length; index += 1) {
        const row = ws.getRow(templateRow + index);
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (typeof cell.value === "string" && cell.value.includes("${")) {
            const replaced = replaceInString(payload, cell.value, items[index]);
            cell.value = typeof replaced.result === "number" ? replaced.result : String(replaced.result || "");
          }
        });
      }
    }

    replacePlaceholders(ws, payload);
    if (templateRow && taxColumnState) {
      // Table block = group header row .. sum row under the last item (spacer + sum are the two rows below the items).
      widenRowsOutsideTable(ws, templateRow - 3, templateRow + items.length + 1, taxColumnState);
    }
    normalizePhonePrefixInWorksheet(ws);
    if (language === "en") applyEnglishHeader(ws, detail.month || "");
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = {
  generateGroupReconciliationExcel
};
