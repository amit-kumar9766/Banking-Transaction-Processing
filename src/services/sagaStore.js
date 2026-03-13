const pool = require("../db");

const TIMEOUT_SECONDS = 30; // if ledger doesn't respond in 30s → compensation

// Called when TransactionCompleted event arrives.
// Creates the saga row and marks payment as authorized.
async function initSaga(transactionId, accountId, amount) {
  await pool.query(
    `INSERT INTO saga_state
       (transaction_id, account_id, amount, payment_authorized, timeout_at)
     VALUES ($1, $2, $3, true, NOW() + INTERVAL '${TIMEOUT_SECONDS} seconds')
     ON CONFLICT (transaction_id) DO UPDATE
       SET payment_authorized = true`,
    [transactionId, accountId, amount]
  );
}

// Called when LedgerUpdated event arrives.
// Marks ledger as done and checks if saga is complete.
// Returns the updated saga row.
async function markLedgerUpdated(transactionId) {
  const result = await pool.query(
    `UPDATE saga_state
     SET ledger_updated = true
     WHERE transaction_id = $1
     RETURNING *`,
    [transactionId]
  );
  return result.rows[0] || null;
}

// Marks saga as FINALIZED.
async function finalizeSaga(transactionId) {
  await pool.query(
    `UPDATE saga_state
     SET status = 'FINALIZED', finalized_at = NOW()
     WHERE transaction_id = $1`,
    [transactionId]
  );
}

// Marks saga as TIMED_OUT.
async function timeoutSaga(transactionId) {
  await pool.query(
    `UPDATE saga_state
     SET status = 'TIMED_OUT'
     WHERE transaction_id = $1`,
    [transactionId]
  );
}

// Finds all sagas that have timed out but are still PENDING.
// Called by the timeout checker on a schedule.
async function getTimedOutSagas() {
  const result = await pool.query(
    `SELECT * FROM saga_state
     WHERE status    = 'PENDING'
       AND timeout_at < NOW()`
  );
  return result.rows;
}

module.exports = {
  initSaga,
  markLedgerUpdated,
  finalizeSaga,
  timeoutSaga,
  getTimedOutSagas,
};
