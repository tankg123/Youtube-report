// Hands a file that is not a PDF to the user (the .p12 of a certificate created in the page): a Blob URL and
// a[download], like actions.saveBytes() does for documents. Nothing leaves the device.

/**
 * @param {object} editor      the editor context (the link is put inside the editor root: the application's
 *                             read-only runtime leaves that subtree alone)
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @param {string} [type]      media type of the file
 */
export function saveFile(editor, bytes, fileName, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  (editor?.getElement?.("root") || document.body).append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

/** A file name from a person's name: "Nguyễn Văn An" -> "nguyen-van-an" (letters without accents, digits, hyphens). */
export function fileStem(name, fallback = "certificate") {
  const stem = String(name || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return stem || fallback;
}
