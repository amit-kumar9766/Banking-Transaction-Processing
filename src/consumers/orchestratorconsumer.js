const { createConsumer } = require("../kafka/consumer");
const { TOPICS } = require("../kafka/topics");
const { publishEvent } = require("../kafka/producer");
const { pushToAccount } = require("../services/SSEService");
const {
  initSaga,
  markLedgerUpdated,
  finalizeSaga,
  timeoutSaga,
  getTimedOutSagas,
} = require("../services/sagaStore");

const TIMEOUT_CHECK_MS = 5000; // check for timed-out sagas every 5s

// ── Step 1: TransactionCompleted → init saga ──────────────────────────────────
// When payment goes through, we create a saga row and
// wait for LedgerUpdated to arrive.
async function handleTransactionCompleted({ event }) {
  if (event.event_type !== "TransactionCompleted") return;

  const { transaction_id, account_id, amount } = event;

  await initSaga(transaction_id, account_id, amount);
  console.log(`[Orchestrator] Saga started for txn=${transaction_id}. Waiting for LedgerUpdated...`);
}

// ── Step 2: LedgerUpdated → check if both steps done ─────────────────────────
// When ledger confirms it saved the entry, we check if
// both payment_authorized + ledger_updated are true.
// If yes → finalize. If saga not found → ignore (blocked txn, no saga).
async function handleLedgerUpdated({ event }) {
  if (event.event_type !== "LedgerUpdated") return;

  const { transaction_id, account_id } = event;

  const saga = await markLedgerUpdated(transaction_id);

  // No saga means this was a blocked transaction — nothing to finalize
  if (!saga) {
    console.log(`[Orchestrator] No saga found for txn=${transaction_id} — skipping`);
    return;
  }

  // Both steps complete → finalize
  if (saga.payment_authorized && saga.ledger_updated) {
    await finalizeSaga(transaction_id);

    // Emit TransactionFinalized event
    await publishEvent(TOPICS.FINALIZED_EVENTS, account_id, {
      event_type: "TransactionFinalized",
      event_version: 1,
      transaction_id,
      account_id,
      amount: saga.amount,
    });

    // Push final SSE update to client
    pushToAccount(account_id, {
      type: "FINALIZED",
      transaction_id,
      account_id,
      amount: saga.amount,
      timestamp: new Date().toISOString(),
    });

    console.log(`[Orchestrator] ✅ txn=${transaction_id} FINALIZED`);
  }
}

// ── Step 3: Timeout checker ───────────────────────────────────────────────────
// Runs every 5s. Finds sagas stuck in PENDING past their timeout_at.
// This handles the case where ledger never responds (crash, bug, etc.)
async function checkTimeouts() {
  const timedOut = await getTimedOutSagas();

  for (const saga of timedOut) {
    console.error(`[Orchestrator] ⏰ Saga timed out for txn=${saga.transaction_id}`);

    await timeoutSaga(saga.transaction_id);

    // Compensation: push FAILED to client so they know something went wrong
    pushToAccount(saga.account_id, {
      type: "FAILED",
      transaction_id: saga.transaction_id,
      account_id: saga.account_id,
      reason: "Transaction timed out waiting for ledger confirmation",
      timestamp: new Date().toISOString(),
    });

    // In a real system you would also:
    // - Reverse the balance update (compensating transaction)
    // - Alert the ops team
    // - Trigger a refund flow
    console.error(`[Orchestrator] Compensation needed for txn=${saga.transaction_id}`);
  }
}

async function startOrchestratorConsumer() {
  // Listen for TransactionCompleted to start saga
  await createConsumer(
    "orchestrator-completed",
    TOPICS.TRANSACTIONS_EVENTS,
    handleTransactionCompleted
  );

  // Listen for LedgerUpdated to complete saga
  await createConsumer(
    "orchestrator-ledger",
    TOPICS.LEDGER_EVENTS,
    handleLedgerUpdated
  );

  // Start timeout checker loop
  console.log(`[Orchestrator] Timeout checker running every ${TIMEOUT_CHECK_MS}ms`);
  setInterval(checkTimeouts, TIMEOUT_CHECK_MS);
}

module.exports = { startOrchestratorConsumer };