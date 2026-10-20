import test from "node:test";
import assert from "node:assert/strict";
import { createDraftAudioQueue } from "../src/pages/assetDelivery/draftAudioQueue.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const file = (name) => ({ name, size: 128 });

function setup() {
  const requests = [];
  const deleted = [];
  const rows = new Map();
  const queue = createDraftAudioQueue({
    upload: (audio, options) => new Promise((resolve, reject) => requests.push({ audio, options, resolve, reject })),
    remove: async (id) => { deleted.push(id); },
    onPatch: (id, patch) => rows.set(id, { ...rows.get(id), ...patch }),
    errorMessage: (error) => error.message
  });
  const complete = (index, token) => requests[index].resolve({ upload: { id: token, file_name: requests[index].audio.name } });
  return { queue, requests, deleted, rows, complete };
}

test("limits concurrency and keeps uploaded files tied to client IDs, regardless of completion order", async () => {
  const { queue, requests, rows, complete } = setup();
  queue.enqueue("track-a", file("same.wav"));
  queue.enqueue("track-b", file("same.wav"));
  queue.enqueue("track-c", file("third.wav"));
  assert.equal(requests.length, 2);
  complete(1, "upload-b");
  await flush();
  assert.equal(requests.length, 3);
  complete(2, "upload-c");
  complete(0, "upload-a");
  await flush();
  assert.equal(rows.get("track-a").audio_upload_id, "upload-a");
  assert.equal(rows.get("track-b").audio_upload_id, "upload-b");
  assert.equal(rows.get("track-c").audio_upload_id, "upload-c");
  assert.equal(rows.get("track-a").uploading, false);
});

test("replacement aborts the previous file and deletes a late upload without overwriting its replacement", async () => {
  const { queue, requests, rows, deleted, complete } = setup();
  queue.enqueue("track-a", file("old.wav"));
  queue.enqueue("track-a", file("new.wav"));
  assert.equal(requests[0].options.signal.aborted, true);
  complete(1, "new-token");
  await flush();
  requests[0].options.onProgress(42);
  complete(0, "old-token");
  await flush();
  assert.equal(rows.get("track-a").audio_upload_id, "new-token");
  assert.equal(rows.get("track-a").upload_progress, 100);
  assert.deepEqual(deleted, ["old-token"]);
});

test("removing a queued row prevents its upload, and removing an active row cleans up late success", async () => {
  const { queue, requests, deleted, complete } = setup();
  queue.enqueue("track-a", file("a.wav"));
  queue.enqueue("track-b", file("b.wav"));
  queue.enqueue("track-c", file("c.wav"));
  queue.forget("track-c");
  queue.forget("track-a");
  complete(0, "removed-token");
  await flush();
  assert.equal(requests.length, 2);
  assert.deepEqual(deleted, ["removed-token"]);
  complete(1, "kept-token");
  await flush();
});

test("failed files remain retryable; successful product creation protects consumed uploads from cleanup", async () => {
  const { queue, requests, rows, deleted, complete } = setup();
  queue.enqueue("track-a", file("a.wav"));
  requests[0].reject(new Error("Connection lost"));
  await flush();
  assert.equal(rows.get("track-a").audio_error, "Connection lost");
  assert.equal(rows.get("track-a").uploading, false);
  queue.enqueue("track-a", file("a.wav"));
  assert.equal(rows.get("track-a").audio_error, "");
  complete(1, "product-audio");
  await flush();
  queue.consume();
  queue.clear();
  queue.dispose();
  await flush();
  assert.deepEqual(deleted, []);
});

test("restored uploads can be removed, while leaving the form preserves completed draft files", async () => {
  const { queue, deleted } = setup();
  queue.restore("discarded", "discarded-token");
  queue.restore("restorable", "restorable-token");
  queue.forget("discarded");
  queue.dispose();
  await flush();
  assert.deepEqual(deleted, ["discarded-token"]);
});

test("forgetToken only drops the restored token it was given and never an upload in flight", async () => {
  const { queue, requests, rows, deleted, complete } = setup();
  queue.restore("track-a", "expired-token");
  queue.restore("track-b", "still-valid");
  assert.equal(queue.forgetToken("track-a", "expired-token"), true);
  assert.equal(queue.forgetToken("track-b", "expired-token"), false, "a different token is left alone");
  assert.equal(queue.forgetToken("missing", "expired-token"), false);

  // A replacement upload started before the server answered must keep running.
  queue.restore("track-c", "old-token");
  queue.enqueue("track-c", file("new.wav"));
  assert.equal(queue.forgetToken("track-c", "old-token"), false);
  assert.equal(requests[0].options.signal.aborted, false);
  complete(0, "new-token");
  await flush();
  assert.equal(rows.get("track-c").audio_upload_id, "new-token");
  queue.dispose();
  await flush();
  // Re-selecting a file replaces the restored draft on the server as usual; forgetToken itself deleted nothing.
  assert.deepEqual(deleted, ["old-token"]);
});
