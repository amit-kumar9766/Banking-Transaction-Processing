const { createConsumer } = require("../kafka/consumer");
const { TOPICS } = require("../kafka/topics");
const pool = require("../db");

async function handleMessage({ event }) {
  if (event.event_type !== "TransactionCompleted") return;

  const { transaction_id, account_id, type, amount, balance_after } = event;

  await pool.query(
    `INSERT INTO ledger (transaction_id, account_id, type, amount, balance_after)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [transaction_id, account_id, type, amount, balance_after]
  );

  console.log(`[Ledger] Recorded txn=${transaction_id} | account=${account_id} | ₹${amount} ${type}`);
}

async function startLedgerConsumer() {
  await createConsumer("ledger-service", TOPICS.TRANSACTIONS_EVENTS, handleMessage);
}

module.exports = { startLedgerConsumer };