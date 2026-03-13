const { createConsumer } = require("../kafka/consumer");
const { TOPICS } = require("../kafka/topics");
const pool = require("../db");

// Consumes from the DLQ topic and stores messages in the DB.
// This gives ops/devs a way to inspect, fix, and reprocess failures.
async function handleDLQMessage({ event }) {
  const dlqPayload = event;

  console.error(`[DLQ] ☠️  Received failed message from: ${dlqPayload.failed_consumer}`);
  console.error(`[DLQ]     Error: ${dlqPayload.error_message}`);
  console.error(`[DLQ]     Failed at: ${dlqPayload.failed_at}`);

  // Persist to DB so it can be queried and reprocessed via API
  await pool.query(
    `INSERT INTO dlq_messages
       (failed_consumer, error_message, original_event, failed_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [
      dlqPayload.failed_consumer,
      dlqPayload.error_message,
      JSON.stringify(dlqPayload.original_event),
      dlqPayload.failed_at,
    ]
  );
}

async function startDLQConsumer() {
  await createConsumer("dlq-consumer", TOPICS.TRANSACTIONS_DLQ, handleDLQMessage);
}

module.exports = { startDLQConsumer };