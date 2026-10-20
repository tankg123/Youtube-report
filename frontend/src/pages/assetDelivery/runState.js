// State of one delivery run in the product / video batch forms (save → server job).
// Kept apart from RunPanel.jsx so that file only exports components (fast refresh).

export const IDLE_RUN = {
  phase: "idle", // idle | creating | uploading (media → server) | delivering (server job) | done | failed
  mode: "",
  product_id: null,
  message: "",
  failed: false,
  stopped: false,
  stopping: false,
  timed_out: false,
  interrupted: false, // the server job disappeared while items were still in flight
  poll_error: "",
  job_started: false, // POST /deliver was accepted at least once during this run
  uploads: { total: 0, done: 0, failed: 0, skipped: 0 }
};

export const RUNNING_PHASES = ["creating", "uploading", "delivering"];
