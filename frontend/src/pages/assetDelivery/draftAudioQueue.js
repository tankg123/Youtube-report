// Keeps staged audio tied to a stable client row, including when files are
// replaced or rows are removed while an upload request is still completing.
import { tk } from "../../i18n/index.js";

export function createDraftAudioQueue({ upload, remove, onPatch, errorMessage, concurrency = 2 }) {
  const entries = new Map();
  const waiting = [];
  let active = 0;
  let disposed = false;

  const discardToken = (token) => {
    if (token) Promise.resolve().then(() => remove(token)).catch(() => {});
    // Failed cleanup is retried by the server's draft expiry sweep.
  };
  const current = (entry) => !disposed && entries.get(entry.clientId) === entry;
  const patch = (entry, values) => { if (current(entry)) onPatch(entry.clientId, values); };

  async function run(entry) {
    active += 1;
    try {
      const data = await upload(entry.file, {
        signal: entry.controller.signal,
        onProgress: (value) => patch(entry, { upload_progress: value })
      });
      const token = data?.upload?.id;
      if (!token) throw new Error(tk("The server did not return an audio upload ID. Please retry."));
      if (!current(entry)) {
        discardToken(token);
        return;
      }
      entry.token = token;
      patch(entry, {
        audio_upload_id: token,
        file_name: data.upload.file_name || entry.file.name,
        file_size: Number(data.upload.file_size) || entry.file.size,
        uploading: false,
        upload_progress: 100,
        audio_error: ""
      });
    } catch (error) {
      if (current(entry)) patch(entry, {
        uploading: false,
        upload_progress: 0,
        audio_error: errorMessage(error) || tk("Audio upload failed. Please retry.")
      });
    } finally {
      active -= 1;
      drain();
    }
  }

  function drain() {
    while (!disposed && active < concurrency && waiting.length) {
      const entry = waiting.shift();
      if (current(entry)) void run(entry);
    }
  }

  function forget(clientId, deleteFile = true) {
    const entry = entries.get(clientId);
    entries.delete(clientId);
    if (!entry) return;
    entry.controller?.abort();
    if (deleteFile) discardToken(entry.token);
  }

  return {
    enqueue(clientId, file) {
      forget(clientId);
      const entry = { clientId, file, controller: new AbortController(), token: "" };
      entries.set(clientId, entry);
      patch(entry, { audio_upload_id: "", uploading: true, upload_progress: 0, audio_error: "", has_audio: false, audio_uploaded: false });
      waiting.push(entry);
      drain();
    },
    restore(clientId, token) {
      entries.set(clientId, { clientId, token });
    },
    // Drops a restored token that the server no longer knows, without touching a newer
    // upload that may have replaced it in the meantime. Never deletes anything on the server.
    forgetToken(clientId, token) {
      const entry = entries.get(clientId);
      if (!entry || entry.token !== token || entry.controller) return false;
      entries.delete(clientId);
      return true;
    },
    forget,
    clear() {
      for (const clientId of entries.keys()) forget(clientId);
      waiting.length = 0;
    },
    consume() {
      // A successful create transfers ownership of these files to the product.
      entries.clear();
      waiting.length = 0;
    },
    resume() { disposed = false; },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) entry.controller?.abort();
      // Completed tokens remain in the browser draft; late completions clean up.
      entries.clear();
      waiting.length = 0;
    }
  };
}
