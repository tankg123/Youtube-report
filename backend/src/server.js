const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

require("./config/database");

const channelRoutes = require("./routes/channelRoutes");
const authRoutes = require("./routes/authRoutes");
const videoRoutes = require("./routes/videoRoutes");
const reportRoutes = require("./routes/reportRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const contentIdRoutes = require("./routes/contentIdRoutes");
const expenseRoutes = require("./routes/expenseRoutes");
const emailRoutes = require("./routes/emailRoutes");
const publicRoutes = require("./routes/publicRoutes");
const { processDueEmailSchedules } = require("./controllers/emailController");
const { scheduleDraftAudioSweep } = require("./services/deliveryDraftService");
const { reconcileInterruptedJobs } = require("./services/deliveryJobService");
const apiKeyMiddleware = require("./middlewares/apiKeyMiddleware");

const app = express();

const PORT = process.env.PORT || 4015;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);

app.use(
  cors({
    origin: [FRONTEND_URL, "http://localhost:5173", "http://192.168.1.179:5173"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
    exposedHeaders: ["Content-Disposition", "X-Package-Skipped"]
  })
);

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "ANS Network API is running"
  });
});

app.use("/api", apiKeyMiddleware);

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "ok",
    time: new Date().toISOString()
  });
});

app.use("/api/public", publicRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/videos", videoRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/content-id", contentIdRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/email", emailRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found"
  });
});

let emailScheduleRunning = false;

async function runEmailScheduleTick() {
  if (emailScheduleRunning) return;

  try {
    emailScheduleRunning = true;
    const processed = await processDueEmailSchedules();
    if (processed) console.log(`[email-schedule] Processed ${processed} due schedule(s)`);
  } catch (error) {
    console.error("[email-schedule] Failed:", error.message);
  } finally {
    emailScheduleRunning = false;
  }
}

function scheduleEmailNotifications() {
  setTimeout(runEmailScheduleTick, 3000);
  setInterval(runEmailScheduleTick, 60 * 1000);
}

const server = app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  scheduleEmailNotifications();
  // CMS Delivery: a process restart interrupts any running delivery job; record it and make the
  // affected tracks retryable, then keep expiring audio uploaded from the form but never used.
  try {
    const interrupted = reconcileInterruptedJobs();
    if (interrupted) console.log(`[cms-delivery] ${interrupted} interrupted delivery job(s) recorded after restart`);
  } catch (error) {
    console.error("[cms-delivery] could not reconcile interrupted deliveries:", error.message);
  }
  scheduleDraftAudioSweep();
});

// CMS Delivery streams raw audio uploads (up to 2 GB) straight into the request; Node's default
// 5-minute whole-request timeout would cut slow uploads off with a 408. Headers keep their 60 s
// limit and idle sockets are still dropped, so stalled connections do not pile up.
const UPLOAD_REQUEST_TIMEOUT_MS = Number(process.env.HTTP_REQUEST_TIMEOUT_MS);
server.requestTimeout = Number.isFinite(UPLOAD_REQUEST_TIMEOUT_MS) && UPLOAD_REQUEST_TIMEOUT_MS >= 0 ? UPLOAD_REQUEST_TIMEOUT_MS : 0;
server.setTimeout(Number(process.env.HTTP_SOCKET_IDLE_TIMEOUT_MS) > 0 ? Number(process.env.HTTP_SOCKET_IDLE_TIMEOUT_MS) : 30 * 60 * 1000);
