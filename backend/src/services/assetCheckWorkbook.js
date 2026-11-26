const ExcelJS = require("exceljs");

async function finishWorkbook(workbook, signal) {
  if (!signal) return workbook.commit();
  signal.throwIfAborted();
  let onAbort;
  const disconnected = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // The HTTP response may close without emitting the finish event ExcelJS awaits.
    await Promise.race([workbook.commit(), disconnected]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function buildAssetCheckWorkbook(assets, language, stream, signal) {
  const vi = language === "vi";
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  const columns = [
    ["Asset ID", 22], [vi ? "Tên asset" : "Asset title", 44], [vi ? "Nghệ sĩ" : "Artists", 30],
    [vi ? "Chủ sở hữu" : "Owner", 38], ["Email", 42], ["Owner ID", 28],
    [vi ? "Quyền và lãnh thổ" : "Rights and territories", 56], ["ISRC", 30], ["Custom ID", 32],
    [vi ? "Loại asset" : "Asset type", 20], ["UPC", 18], ["Album", 30],
    [vi ? "Hãng thu âm" : "Record label", 30], [vi ? "Nhãn asset" : "Asset labels", 25],
    [vi ? "Ngày tạo (UTC)" : "Created (UTC)", 22], [vi ? "Ghi chú" : "Notes", 40]
  ];
  let sheetNumber = 0;
  function startSheet() {
    sheetNumber += 1;
    const sheet = workbook.addWorksheet(sheetNumber === 1 ? "Assets" : `Assets ${sheetNumber}`, {
      views: [{ state: "frozen", ySplit: 1, xSplit: 1 }]
    });
    sheet.columns = columns.map(([header, width]) => ({ header, width }));
    sheet.getColumn(15).numFmt = "yyyy-mm-dd hh:mm";
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
    header.height = 24;
    header.commit();
    return sheet;
  }
  let sheet = startSheet();
  let lastRow = 1;
  function finishSheet() {
    sheet.autoFilter = { from: "A1", to: { row: lastRow, column: columns.length } };
    sheet.commit();
  }

  try {
    for await (const asset of assets) {
      const created = new Date(asset.created_at || "");
      for (const owner of asset.owners.length ? asset.owners : [null]) {
        let note = owner?.contact_error || "";
        if (asset.missing) note = vi ? "CMS không trả về chi tiết asset." : "Asset details unavailable from CMS.";
        else if (!owner) note = vi ? "Chưa có dữ liệu quyền sở hữu." : "Effective ownership unavailable.";
        else if (!owner.email && !note) note = vi ? "Chưa có email liên hệ." : "Contact email unavailable.";
        const rights = owner?.rights.map((right) => {
          let coverage = right.territories.join(", ");
          if (right.exclude) coverage = coverage
            ? (vi ? "Toàn cầu trừ " : "Worldwide except ") + coverage
            : (vi ? "Toàn cầu" : "Worldwide");
          return `${right.type}: ${coverage}`;
        }).join("\n");
        if (lastRow === 1048576) {
          finishSheet();
          sheet = startSheet();
          lastRow = 1;
        }
        const row = sheet.addRow([
          asset.id, asset.title, asset.artists?.join(", "), owner?.name, owner?.email, owner?.owner_id,
          rights, asset.isrcs.join(", "), asset.custom_id, asset.type, asset.upc, asset.album, asset.record_label,
          asset.labels?.join(", "), Number.isNaN(created.getTime()) ? null : created, note
        ]);
        row.alignment = { vertical: "top", wrapText: true };
        row.commit();
        lastRow += 1;
      }
    }
    finishSheet();
    await finishWorkbook(workbook, signal);
    if (!stream) return workbook.stream.toBuffer();
  } catch (error) {
    workbook.zip.abort();
    throw error;
  }
}

module.exports = { buildAssetCheckWorkbook };
