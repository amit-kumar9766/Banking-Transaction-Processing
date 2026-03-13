const { publishEvent } = require("../kafka/producer");
const { TOPICS } = require("../kafka/topics");

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // 2s → 4s → 8s

// Wraps a consumer handler with retry + exponential backoff + DLQ.
//
// Usage in any consumer:
//   await withRetry("ledger-service", event, () => processEvent(event));
//
async function withRetry(consumerName, event, fn) {
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      await fn();
      return; // success — exit

    } catch (err) {
      attempt++;

      if (attempt > MAX_RETRIES) {
        // All retries exhausted → send to DLQ
        console.error(`[${consumerName}] All ${MAX_RETRIES} retries exhausted. Sending to DLQ.`);
        await sendToDLQ(consumerName, event, err);
        return;
      }

      // Exponential backoff: 2s, 4s, 8s
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[${consumerName}] Attempt ${attempt} failed. Retrying in ${delay}ms...`, err);
      await sleep(delay);
    }
  }
}

// Publishes a failed message to the DLQ topic with metadata.
async function sendToDLQ(consumerName, event, err) {
  const dlqPayload = {
    original_event: event,
    failed_consumer: consumerName,
    error_message: err instanceof Error ? err.message : String(err),
    failed_at: new Date().toISOString(),
  };

  try {
    await publishEvent(
      TOPICS.TRANSACTIONS_DLQ,
      consumerName, // key = consumer name for routing
      dlqPayload
    );
    console.log(`[DLQ] Message sent to DLQ by ${consumerName}`);
  } catch (dlqErr) {
    // If even DLQ publish fails, log loudly — manual intervention needed
    console.error(`[DLQ] CRITICAL: Failed to publish to DLQ!`, dlqErr);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { withRetry };