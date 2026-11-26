// Facts about the open document that several parts of the shell read: whether the author of a file limited
// changes (the permission flags of an encrypted PDF), and the dates of the document properties.
// Pure functions: tests/pdfUiDocumentFacts.test.mjs.

/**
 * True when the author of the file limited what may be changed: `permissions` is what the viewer read from an
 * encrypted file ({ modify, annotate, assemble, fillForms ... }; null = no restrictions at all).
 * Print and copy restrictions do not count: the editor asks only before it CHANGES a document.
 */
export function restrictsChanges(permissions) {
  if (!permissions || typeof permissions !== "object") return false;
  return permissions.modify === false || permissions.annotate === false || permissions.assemble === false || permissions.fillForms === false;
}

/** The changes the author did not allow, as stable words: "modify" | "annotate" | "assemble" | "fillForms". */
export function restrictedChanges(permissions) {
  if (!permissions || typeof permissions !== "object") return [];
  return ["modify", "annotate", "assemble", "fillForms"].filter((key) => permissions[key] === false);
}

const PDF_DATE = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/;

/**
 * A date of the document properties ("D:20261120093000+07'00'") as a Date, or null when it is not one.
 * Missing parts are the first month, the first day and midnight; a date without a zone is read as UTC, as
 * pdf.js does.
 */
export function parsePdfDate(text) {
  if (text instanceof Date) return Number.isNaN(text.getTime()) ? null : text;
  if (typeof text !== "string") return null;
  const match = PDF_DATE.exec(text.trim());
  if (!match) return null;
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", utc, sign, zoneHours = "00", zoneMinutes = "00"] = match;
  const numbers = [year, month, day, hour, minute, second].map(Number);
  if (numbers[1] < 1 || numbers[1] > 12 || numbers[2] < 1 || numbers[2] > 31 || numbers[3] > 23 || numbers[4] > 59 || numbers[5] > 59) return null;
  let time = Date.UTC(numbers[0], numbers[1] - 1, numbers[2], numbers[3], numbers[4], numbers[5]);
  if (!utc && sign) {
    const offset = (Number(zoneHours) * 60 + Number(zoneMinutes)) * 60000;
    time += sign === "+" ? -offset : offset;
  }
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A byte count for people: "512 B", "23.4 kB", "1.2 MB" (the number is formatted by the caller's formatter). */
export function byteSize(bytes, formatNumber = (value) => String(value)) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${formatNumber(size)} B`;
  if (size < 1024 * 1024) return `${formatNumber(size / 1024, { maximumFractionDigits: 1 })} kB`;
  return `${formatNumber(size / (1024 * 1024), { maximumFractionDigits: size < 10 * 1024 * 1024 ? 2 : 1 })} MB`;
}
