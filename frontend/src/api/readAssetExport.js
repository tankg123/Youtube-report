import { t } from "../i18n/index.js";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Network reads can split a frame or contain several. Publish the file only after
// the server confirms ExcelJS finished its ZIP central directory.
export async function readAssetExport(stream, onProgress) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const parts = [];
  let pending = "";
  let written = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (pending + value).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const frame = JSON.parse(line);
        if (frame.type === "progress") onProgress?.(frame);
        else if (frame.type === "xlsx") parts.push(Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0)));
        else if (frame.type === "complete") written = frame.written;
        else if (frame.type === "error") {
          throw Object.assign(new Error(frame.message), { response: { status: frame.status, data: frame } });
        }
      }
    }
    if (pending || !Number.isSafeInteger(written) || written < 1 || !parts.length) {
      throw new Error(t("The Excel download was interrupted. Retry the export."));
    }
    return { blob: new Blob(parts, { type: XLSX_TYPE }), written };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
