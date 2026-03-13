const { createConsumer } = require("../kafka/consumer");
const { TOPICS } = require("../kafka/topics");
const pool = require("../db");

async function handleCompleted({ event }) {
  if (event.event_type !== "TransactionCompleted") return;

  const { account_id, type, amount } = event;

  await pool.query(
    `INSERT INTO analytics (account_id, total_debit, total_credit, transaction_count, last_updated)
     VALUES (
       $1,
       CASE WHEN $2 = 'DEBIT'  THEN $3 ELSE 0 END,
       CASE WHEN $2 = 'CREDIT' THEN $3 ELSE 0 END,
       1,
       NOW()
     )
     ON CONFLICT (account_id) DO UPDATE
       SET total_debit       = analytics.total_debit       + CASE WHEN $2 = 'DEBIT'  THEN $3 ELSE 0 END,
           total_credit      = analytics.total_credit      + CASE WHEN $2 = 'CREDIT' THEN $3 ELSE 0 END,
           transaction_count = analytics.transaction_count + 1,
           last_updated      = NOW()`,
    [account_id, type, amount]
  );

  console.log(`[Analytics] Updated metrics for account=${account_id} | ${type} ₹${amount}`);
}

async function handleBlocked({ event }) {
  if (event.event_type !== "TransactionBlocked") return;

  const { account_id } = event;

  await pool.query(
    `INSERT INTO analytics (account_id, total_blocked, last_updated)
     VALUES ($1, 1, NOW())
     ON CONFLICT (account_id) DO UPDATE
       SET total_blocked = analytics.total_blocked + 1,
           last_updated  = NOW()`,
    [account_id]
  );

  console.log(`[Analytics] Incremented blocked count for account=${account_id}`);
}

async function startAnalyticsConsumer() {
  await createConsumer("analytics-service", TOPICS.TRANSACTIONS_EVENTS, handleCompleted);
  await createConsumer("analytics-service-blocked", TOPICS.TRANSACTIONS_BLOCKED, handleBlocked);
}

module.exports = { startAnalyticsConsumer };