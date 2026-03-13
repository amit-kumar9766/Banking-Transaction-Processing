const pool = require("../db");
const { publishEvent } = require("../kafka/producer");
const { TOPICS } = require("../kafka/topics");

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 10;

function resolveTopic(eventType) {
  switch (eventType) {
    case "TransactionCompleted": return TOPICS.TRANSACTIONS_EVENTS;
    case "TransactionBlocked":   return TOPICS.TRANSACTIONS_BLOCKED;
    default:
      throw new Error(`Unknown event type: ${eventType}`);
  }
}

async function processBatch() {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT * FROM outbox
       WHERE processed = false
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE]
    );

    if (result.rows.length === 0) return;

    for (const row of result.rows) {
      try {
        const topic = resolveTopic(row.event_type);
        
        // PostgreSQL JSONB returns payload as an object, not a string
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const accountId = payload?.account_id || row.id;

        await publishEvent(topic, accountId, payload);

        await client.query(
          `UPDATE outbox
           SET processed = true,
               published_at = NOW()
           WHERE id = $1`,
          [row.id]
        );

        console.log(`[OutboxWorker] Published ${row.event_type} | id=${row.id}`);

      } catch (publishErr) {
        console.error(`[OutboxWorker] Failed to publish id=${row.id}:`, publishErr);
      }
    }

  } finally {
    client.release();
  }
}

function startOutboxWorker() {
  console.log(`[OutboxWorker] Started — polling every ${POLL_INTERVAL_MS}ms`);

  const run = async () => {
    try {
      await processBatch();
    } catch (err) {
      console.error("[OutboxWorker] Unexpected error:", err);
    } finally {
      setTimeout(run, POLL_INTERVAL_MS);
    }
  };

  run();
}

module.exports = { startOutboxWorker };
