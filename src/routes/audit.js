const express = require("express");
const router = express.Router();
const pool = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
// GET /audit/account/:account_id
//
// Full event history for an account.
// Answers: "What happened to account X?"
// ─────────────────────────────────────────────────────────────────────────────
router.get("/account/:account_id", async (req, res) => {
  const { account_id } = req.params;
  const { from, to } = req.query; // optional date filters

  let query = `
    SELECT
      transaction_id,
      type,
      amount,
      status,
      balance_after,
      fraud_reason,
      device_fingerprint,
      ip_address,
      created_at
    FROM transactions
    WHERE account_id = $1
  `;
  const params = [account_id];

  if (from) {
    params.push(from);
    query += ` AND created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    query += ` AND created_at <= $${params.length}`;
  }

  query += ` ORDER BY created_at ASC`;

  const result = await pool.query(query, params);

  res.json({
    account_id,
    total_events: result.rowCount,
    events:       result.rows,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /audit/account/:account_id/replay
//
// Rebuilds the account balance from scratch by replaying
// every COMPLETED transaction in order.
//
// Answers: "What should the balance be if we replay all events?"
// Useful for: verifying current balance is correct, debugging discrepancies.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/account/:account_id/replay", async (req, res) => {
  const { account_id } = req.params;

  // Fetch all COMPLETED transactions in chronological order
  const result = await pool.query(
    `SELECT transaction_id, type, amount, created_at
     FROM transactions
     WHERE account_id = $1
       AND status     = 'COMPLETED'
     ORDER BY created_at ASC`,
    [account_id]
  );

  // Replay each event and rebuild balance step by step
  let balance = 0;
  const steps = result.rows.map((txn) => {
    const before = balance;
    balance += txn.type === "CREDIT" ? txn.amount : -txn.amount;

    return {
      transaction_id: txn.transaction_id,
      type:           txn.type,
      amount:         txn.amount,
      balance_before: before,
      balance_after:  balance,
      created_at:     txn.created_at,
    };
  });

  // Compare replayed balance with actual DB balance
  const accountResult = await pool.query(
    `SELECT balance FROM accounts WHERE account_id = $1`,
    [account_id]
  );
  const actualBalance = accountResult.rows[0]?.balance ?? null;

  res.json({
    account_id,
    replayed_balance:  balance,
    actual_balance:    actualBalance,
    match:             parseFloat(actualBalance) === balance,  // sanity check
    total_events:      steps.length,
    steps,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /audit/transaction/:transaction_id
//
// Full trace of a single transaction across all systems.
// Answers: "Why was ₹12,000 debited from account X on Jan 4th?"
//
// Shows the complete journey:
//   transactions table → ledger table → saga_state → outbox events
// ─────────────────────────────────────────────────────────────────────────────
router.get("/transaction/:transaction_id", async (req, res) => {
  const { transaction_id } = req.params;

  // 1. Core transaction record
  const txnResult = await pool.query(
    `SELECT * FROM transactions WHERE transaction_id = $1`,
    [transaction_id]
  );
  if (txnResult.rowCount === 0) {
    return res.status(404).json({ error: "Transaction not found" });
  }
  const transaction = txnResult.rows[0];

  // 2. Ledger entry (only exists if transaction was COMPLETED + ledger processed it)
  const ledgerResult = await pool.query(
    `SELECT * FROM ledger WHERE transaction_id = $1`,
    [transaction_id]
  );

  // 3. Saga state (lifecycle tracking)
  const sagaResult = await pool.query(
    `SELECT * FROM saga_state WHERE transaction_id = $1`,
    [transaction_id]
  );

  // 4. All outbox events emitted for this transaction
  const outboxResult = await pool.query(
    `SELECT id, event_type, processed, created_at, published_at
     FROM outbox
     WHERE payload->>'transaction_id' = $1
     ORDER BY created_at ASC`,
    [transaction_id]
  );

  // Build a human-readable timeline
  const timeline = buildTimeline(transaction, outboxResult.rows, sagaResult.rows[0]);

  res.json({
    transaction_id,
    transaction,
    ledger_entry:   ledgerResult.rows[0]  ?? null,
    saga_state:     sagaResult.rows[0]    ?? null,
    outbox_events:  outboxResult.rows,
    timeline,       // human-readable ordered list of what happened and when
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a human-readable timeline from raw DB rows
// ─────────────────────────────────────────────────────────────────────────────
function buildTimeline(transaction, outboxEvents, saga) {
  const events = [];

  // Transaction created
  events.push({
    time:        transaction.created_at,
    description: `Transaction ${transaction.transaction_id} received — ${transaction.type} ₹${transaction.amount}`,
  });

  // Fraud blocked?
  if (transaction.status === "BLOCKED") {
    events.push({
      time:        transaction.created_at,
      description: `Transaction BLOCKED — reason: ${transaction.fraud_reason}`,
    });
  }

  // Outbox events
  for (const event of outboxEvents) {
    events.push({
      time:        event.published_at ?? event.created_at,
      description: `Event emitted: ${event.event_type} | published=${event.processed}`,
    });
  }

  // Saga finalized or timed out?
  if (saga?.status === "FINALIZED") {
    events.push({
      time:        saga.finalized_at,
      description: `Transaction FINALIZED — both payment and ledger confirmed`,
    });
  } else if (saga?.status === "TIMED_OUT") {
    events.push({
      time:        saga.timeout_at,
      description: `Transaction TIMED OUT — ledger confirmation never arrived`,
    });
  }

  // Sort by time
  return events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

module.exports = router;