require("dotenv").config();
const express = require("express");
const transactionRoute = require("./routes/transactions");
const dlqRoute = require("./routes/DLQ");
const sseRoute = require("./routes/sse");
const { startOutboxWorker } = require("./workers/outboxWorker");
const { startNotificationConsumer } = require("./consumers/NotificationConsumer");
const { startLedgerConsumer } = require("./consumers/Ledgerconsumer");
const { startAnalyticsConsumer } = require("./consumers/Analyticsconsumer");
const { startDLQConsumer } = require("./consumers/dlqconsumer");

const app = express();
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/transactions", transactionRoute);
app.use("/dlq", dlqRoute);
app.use("/sse", sseRoute); // GET /sse/:account_id
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── Background Workers & Consumers ───────────────────────────────────────────
async function startBackgroundServices() {
  startOutboxWorker();
  await startNotificationConsumer();
  await startLedgerConsumer();
  await startAnalyticsConsumer();
  await startDLQConsumer();
  console.log("[App] All background services started");
}

startBackgroundServices().catch((err) => {
  console.error("[App] Failed to start background services:", err);
  process.exit(1);
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Banking service running on port ${PORT}`);
});

module.exports = app;