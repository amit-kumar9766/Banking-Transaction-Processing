const express = require("express");
const router = express.Router();
const { addConnection, removeConnection } = require("../services/SSEService");

// GET /sse/:account_id
//
// Client opens this endpoint and keeps the connection open.
// Server pushes events as they happen — no polling needed.
//
// Usage from browser:
//   const es = new EventSource("http://localhost:3000/sse/acc_123");
//   es.onmessage = (e) => console.log(JSON.parse(e.data));
//
router.get("/:account_id", (req, res) => {
  const { account_id } = req.params;

  // These headers turn a normal HTTP connection into an SSE stream
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders(); // send headers immediately, keep connection open

  // Register this connection so we can push to it later
  addConnection(account_id, res);

  // Send an initial confirmation so client knows it's connected
  res.write(`data: ${JSON.stringify({ type: "CONNECTED", account_id })}\n\n`);

  // Clean up when client disconnects (tab closed, network drop)
  req.on("close", () => {
    removeConnection(account_id, res);
  });
});

module.exports = router;