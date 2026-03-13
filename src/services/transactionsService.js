const pool = require("../db");
const { v4: uuidv4 } = require("uuid");

const FRAUD_MAX_AMOUNT      = 50000;
const FRAUD_VELOCITY_LIMIT  = 5;
const FRAUD_VELOCITY_WINDOW = 60; // seconds

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────
async function processTransaction(data) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      transaction_id,
      account_id,
      type,
      amount,
      device_fingerprint,
      ip_address,
    } = data;

    // ── Step 1: Idempotency check ─────────────────────────────────────────
    // If this transaction_id was already processed, return the saved result.
    // This makes the endpoint safe to retry.
    const existing = await client.query(
      `SELECT * FROM transactions WHERE transaction_id = $1`,
      [transaction_id]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query("ROLLBACK");
      return {
        status:  "DUPLICATE",
        message: "Transaction already processed",
        data:    existing.rows[0],
      };
    }

    // ── Step 2: Sync Fraud Rule 1 — amount limit ──────────────────────────
    // Hard stop BEFORE touching the account row.
    // Balance is never updated for blocked transactions.
    if (amount > FRAUD_MAX_AMOUNT) {
      const blocked = await recordBlocked(client, data, `Amount ₹${amount} exceeds limit of ₹${FRAUD_MAX_AMOUNT}`);
      await client.query("COMMIT");
      return { status: "BLOCKED", reason: blocked.fraud_reason, data: blocked };
    }

    // ── Step 3: Sync Fraud Rule 2 — velocity check ────────────────────────
    // Only count COMPLETED transactions — not BLOCKED ones.
    // Without this, a flood of blocked txns would permanently lock the account.
    const velocityResult = await client.query(
      `SELECT COUNT(*) AS txn_count
       FROM transactions
       WHERE account_id = $1
         AND status     = 'COMPLETED'
         AND created_at > NOW() - INTERVAL '${FRAUD_VELOCITY_WINDOW} seconds'`,
      [account_id]
    );
    const recentCount = parseInt(velocityResult.rows[0].txn_count, 10);

    if (recentCount >= FRAUD_VELOCITY_LIMIT) {
      const blocked = await recordBlocked(
        client,
        data,
        `Velocity limit: ${recentCount} completed transactions in last ${FRAUD_VELOCITY_WINDOW}s`
      );
      await client.query("COMMIT");
      return { status: "BLOCKED", reason: blocked.fraud_reason, data: blocked };
    }

    // ── Step 4: Lock account row ──────────────────────────────────────────
    // FOR UPDATE acquires a row-level lock.
    // Any concurrent request for the same account will wait here,
    // preventing double-spend or race conditions on balance.
    const accountResult = await client.query(
      `SELECT * FROM accounts WHERE account_id = $1 FOR UPDATE`,
      [account_id]
    );

    if (accountResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { status: "ERROR", message: `Account ${account_id} not found` };
    }

    const account = accountResult.rows[0];

    // ── Step 5: Balance validation ────────────────────────────────────────
    if (type === "DEBIT" && account.balance < amount) {
      await client.query("ROLLBACK");
      return {
        status:  "ERROR",
        message: `Insufficient balance. Available: ₹${account.balance}`,
      };
    }

    // ── Step 6: Update balance ────────────────────────────────────────────
    const balanceDelta = type === "DEBIT" ? -amount : amount;

    const updatedAccount = await client.query(
      `UPDATE accounts
       SET balance = balance + $1
       WHERE account_id = $2
       RETURNING balance`,
      [balanceDelta, account_id]
    );

    const balanceAfter = updatedAccount.rows[0].balance;

    // ── Step 7: Record transaction ────────────────────────────────────────
    // All fields stored here — this is the idempotency store AND audit record.
    const txnResult = await client.query(
      `INSERT INTO transactions
         (transaction_id, account_id, type, amount, status,
          balance_after, device_fingerprint, ip_address)
       VALUES ($1, $2, $3, $4, 'COMPLETED', $5, $6, $7)
       RETURNING *`,
      [transaction_id, account_id, type, amount, balanceAfter, device_fingerprint, ip_address]
    );

    // ── Step 8: Write to outbox ───────────────────────────────────────────
    // Written in the SAME DB transaction as the balance update.
    // If the commit succeeds, the event is guaranteed to exist.
    // The outbox worker will pick this up and publish to Kafka.
    const eventPayload = {
      event_type:        "TransactionCompleted",
      event_version:     1,
      transaction_id,
      account_id,
      amount,
      balance_after:     balanceAfter,
      device_fingerprint,
      ip_address,
    };

    await client.query(
      `INSERT INTO outbox (id, event_type, payload)
       VALUES ($1, $2, $3)`,
      [uuidv4(), "TransactionCompleted", JSON.stringify(eventPayload)]
    );

    await client.query("COMMIT");

    return {
      status:        "COMPLETED",
      transaction_id,
      balance_after: balanceAfter,
      data:          txnResult.rows[0],
    };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: record a blocked transaction + outbox event
// Called inside an open DB transaction — does NOT commit.
// ─────────────────────────────────────────────────────────────────────────────
async function recordBlocked(
  client,
  data,
  reason
) {
  // Store blocked txn — balance_after is NULL (balance never touched)
  const result = await client.query(
    `INSERT INTO transactions
       (transaction_id, account_id, type, amount, status,
        fraud_reason, device_fingerprint, ip_address)
     VALUES ($1, $2, $3, $4, 'BLOCKED', $5, $6, $7)
     RETURNING *`,
    [
      data.transaction_id,
      data.account_id,
      data.type,
      data.amount,
      reason,
      data.device_fingerprint,
      data.ip_address,
    ]
  );

  // Emit TransactionBlocked event via outbox
  const eventPayload = {
    event_type:        "TransactionBlocked",
    event_version:     1,
    transaction_id:    data.transaction_id,
    account_id:        data.account_id,
    amount:            data.amount,
    reason,
    device_fingerprint: data.device_fingerprint,
    ip_address:         data.ip_address,
  };

  await client.query(
    `INSERT INTO outbox (id, event_type, payload)
     VALUES ($1, $2, $3)`,
    [uuidv4(), "TransactionBlocked", JSON.stringify(eventPayload)]
  );

  return result.rows[0];
}

module.exports = { processTransaction };