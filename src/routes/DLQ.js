const express = require("express");
const router = express.Router();
const pool = require("../db");
const { publishEvent } = require("../kafka/producer");
const { TOPICS } = require("../kafka/topics");

// GET /dlq — list all unresolved DLQ messages
router.get("/", async (_req, res) => {
  const result = await pool.query(
    `SELECT * FROM dlq_messages
     WHERE reprocessed = false
     ORDER BY failed_at DESC`
  );
  res.json({ count: result.rowCount, messages: result.rows });
});

// POST /dlq/reprocess/:id — manually reprocess a single DLQ message
// This republishes the original event back to the correct topic
// so the consumer gets another chance to process it.
router.post("/reprocess/:id", async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(
    `SELECT * FROM dlq_messages WHERE id = $1`,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "DLQ message not found" });
  }

  const dlqMessage  = result.rows[0];
  const event       = JSON.parse(dlqMessage.original_event);
  const account_id  = event.account_id ?? "unknown";

  // Route back to the correct topic based on event type
  const topic =
    event.event_type === "TransactionCompleted" ? TOPICS.TRANSACTIONS_EVENTS :
    event.event_type === "TransactionBlocked"   ? TOPICS.TRANSACTIONS_BLOCKED :
    TOPICS.TRANSACTIONS_EVENTS;

  await publishEvent(topic, account_id, event);

  // Mark as reprocessed
  await pool.query(
    `UPDATE dlq_messages
     SET reprocessed = true, reprocessed_at = NOW()
     WHERE id = $1`,
    [id]
  );

  console.log(`[DLQ] Reprocessed message id=${id} → topic=${topic}`);
  res.json({ success: true, message: `Reprocessed to ${topic}`, event });
});

module.exports = router;