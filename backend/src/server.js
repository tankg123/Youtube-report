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
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"]
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

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  scheduleEmailNotifications();
});
