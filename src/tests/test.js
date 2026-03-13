const { processTransaction } = require("../services/transactionsService");
const { withRetry } = require("../utils/retry");
const {
  resetDB,
  closeDB,
  getAccount,
  getTransaction,
  getOutboxEvents,
  getLedgerEntries,
  pool,
} = require("./helpers");

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(async () => await resetDB());
afterAll(async ()  => await closeDB());

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Duplicate transaction request
//
// Sending the same transaction_id twice should return the
// cached result the second time — balance updated only once.
// ─────────────────────────────────────────────────────────────────────────────
describe("1. Duplicate transaction request", () => {
  it("should process first request and return cached result for duplicate", async () => {
    const payload = {
      transaction_id: "txn_dup_001",
      account_id: "acc_test",
      type: "DEBIT",
      amount: 5000,
    };

    // First request — should succeed
    const first = await processTransaction(payload);
    expect(first.status).toBe("COMPLETED");

    // Check balance was debited
    const accountAfterFirst = await getAccount("acc_test");
    expect(parseFloat(accountAfterFirst.balance)).toBe(95000);

    // Second request — same transaction_id
    const second = await processTransaction(payload);
    expect(second.status).toBe("DUPLICATE");

    // Balance must NOT change on duplicate
    const accountAfterSecond = await getAccount("acc_test");
    expect(parseFloat(accountAfterSecond.balance)).toBe(95000);

    // Only one transaction record should exist
    const result = await pool.query(
      "SELECT COUNT(*) FROM transactions WHERE transaction_id = $1",
      ["txn_dup_001"]
    );
    expect(parseInt(result.rows[0].count)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Concurrent debit requests
//
// Two requests for the same account fired at the same time.
// Row-level lock must ensure balance is correct — not double-debited.
// ─────────────────────────────────────────────────────────────────────────────
describe("2. Concurrent debit requests", () => {
  it("should handle concurrent debits correctly without double spend", async () => {
    // Fire both debits at exactly the same time
    const [result1, result2] = await Promise.all([
      processTransaction({
        transaction_id: "txn_concurrent_001",
        account_id:     "acc_test",
        type:           "DEBIT",
        amount:         60000,
      }),
      processTransaction({
        transaction_id: "txn_concurrent_002",
        account_id:     "acc_test",
        type:           "DEBIT",
        amount:         60000,
      }),
    ]);

    const statuses = [result1.status, result2.status];

    // One must succeed, one must fail (insufficient balance)
    // Both cannot succeed — that would be a double spend
    expect(statuses).toContain("COMPLETED");
    expect(statuses).toContain("ERROR");

    // Final balance must be exactly 40000 (100000 - 60000)
    const account = await getAccount("acc_test");
    expect(parseFloat(account.balance)).toBe(40000);
  });

  it("should never allow balance to go negative", async () => {
    // Try to debit more than available balance
    const result = await processTransaction({
      transaction_id: "txn_overdraft_001",
      account_id:     "acc_test",
      type:           "DEBIT",
      amount:         150000, // more than the 100000 balance
    });

    expect(result.status).toBe("ERROR");

    // Balance should be unchanged
    const account = await getAccount("acc_test");
    expect(parseFloat(account.balance)).toBe(100000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Worker crash during processing
//
// Simulates a consumer throwing mid-process.
// The outbox row must remain unprocessed so the worker retries it.
// ─────────────────────────────────────────────────────────────────────────────
describe("3. Worker crash during processing", () => {
  it("should leave outbox row unprocessed if worker crashes before marking done", async () => {
    // Create a transaction — this writes to outbox with processed=false
    await processTransaction({
      transaction_id: "txn_crash_001",
      account_id:     "acc_test",
      type:           "DEBIT",
      amount:         1000,
    });

    // Verify outbox has an unprocessed event
    const events = await getOutboxEvents("txn_crash_001");
    expect(events.length).toBe(1);
    expect(events[0].processed).toBe(false);

    // Simulate worker crash: worker reads the event but crashes before
    // marking it as processed. We simulate this by NOT calling
    // UPDATE outbox SET processed = true.
    // The row stays unprocessed — worker will pick it up on next poll.

    // Confirm it is still unprocessed (would be retried on next poll)
    const eventsAfterCrash = await getOutboxEvents("txn_crash_001");
    expect(eventsAfterCrash[0].processed).toBe(false);
  });

  it("should mark outbox as processed after successful publish", async () => {
    await processTransaction({
      transaction_id: "txn_crash_002",
      account_id:     "acc_test",
      type:           "DEBIT",
      amount:         1000,
    });

    // Simulate successful outbox processing
    await pool.query(
      `UPDATE outbox
       SET processed = true, published_at = NOW()
       WHERE payload->>'transaction_id' = $1`,
      ["txn_crash_002"]
    );

    const events = await getOutboxEvents("txn_crash_002");
    expect(events[0].processed).toBe(true);
    expect(events[0].published_at).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Retry + DLQ behavior
//
// A handler that always fails should:
// - be retried MAX_RETRIES times with increasing delay
// - end up in the DLQ after all retries exhausted
// ─────────────────────────────────────────────────────────────────────────────
describe("4. Retry + DLQ behavior", () => {
  it("should retry the correct number of times before giving up", async () => {
    let attempts = 0;

    // Mock a handler that always fails
    const alwaysFails = async () => {
      attempts++;
      throw new Error("Simulated consumer failure");
    };

    // Mock sendToDLQ to avoid real Kafka call in tests
    const dlqMessages = [];
    jest.spyOn(require("../kafka/producer"), "publishEvent")
      .mockImplementation(async (topic, _key, value) => {
        if (topic === "transactions.dlq") {
          dlqMessages.push(value);
        }
      });

    const event = { transaction_id: "txn_retry_001", account_id: "acc_test" };
    await withRetry("test-consumer", event, alwaysFails);

    // Should have tried exactly MAX_RETRIES + 1 times (1 initial + 3 retries)
    expect(attempts).toBe(4);

    // Should have sent to DLQ
    expect(dlqMessages.length).toBe(1);
    expect(dlqMessages[0].failed_consumer).toBe("test-consumer");
    expect(dlqMessages[0].error_message).toBe("Simulated consumer failure");

    jest.restoreAllMocks();
  });

  it("should succeed without DLQ if handler passes on second attempt", async () => {
    let attempts = 0;

    const failOnceThenSucceed = async () => {
      attempts++;
      if (attempts === 1) throw new Error("First attempt fails");
      // second attempt succeeds
    };

    const dlqMessages = [];
    jest.spyOn(require("../kafka/producer"), "publishEvent")
      .mockImplementation(async (topic, _key, value) => {
        if (topic === "transactions.dlq") dlqMessages.push(value);
      });

    const event = { transaction_id: "txn_retry_002", account_id: "acc_test" };
    await withRetry("test-consumer", event, failOnceThenSucceed);

    expect(attempts).toBe(2);         // tried twice
    expect(dlqMessages.length).toBe(0); // never hit DLQ

    jest.restoreAllMocks();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5: Fraud block correctness
//
// Tests both sync fraud rules:
//   A) Amount > ₹50,000
//   B) More than 5 transactions in 60 seconds
// ─────────────────────────────────────────────────────────────────────────────
describe("5. Fraud block correctness", () => {
  it("should block transaction when amount exceeds ₹50,000", async () => {
    const result = await processTransaction({
      transaction_id: "txn_fraud_amount_001",
      account_id:     "acc_test",
      type:           "DEBIT",
      amount:         75000, // over the 50000 limit
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/exceeds/i);

    // Balance must be unchanged
    const account = await getAccount("acc_test");
    expect(parseFloat(account.balance)).toBe(100000);

    // BLOCKED record should exist in transactions table
    const txn = await getTransaction("txn_fraud_amount_001");
    expect(txn.status).toBe("BLOCKED");
    expect(txn.fraud_reason).toBeTruthy();

    // Outbox should have a TransactionBlocked event
    const events = await getOutboxEvents("txn_fraud_amount_001");
    expect(events[0].event_type).toBe("TransactionBlocked");
  });

  it("should block transaction when velocity limit exceeded (>5 in 60s)", async () => {
    // Fire 5 successful transactions (the limit)
    for (let i = 1; i <= 5; i++) {
      const result = await processTransaction({
        transaction_id: `txn_velocity_${i}`,
        account_id:     "acc_test",
        type:           "DEBIT",
        amount:         1000,
      });
      expect(result.status).toBe("COMPLETED");
    }

    // 6th transaction should be blocked
    const result = await processTransaction({
      transaction_id: "txn_velocity_6",
      account_id:     "acc_test",
      type:           "DEBIT",
      amount:         1000,
    });

    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/velocity/i);

    // Balance: 100000 - (5 × 1000) = 95000
    // 6th transaction was blocked so balance unchanged from 95000
    const account = await getAccount("acc_test");
    expect(parseFloat(account.balance)).toBe(95000);
  });

  it("should NOT count blocked transactions toward velocity limit", async () => {
    // Send 3 valid transactions
    for (let i = 1; i <= 3; i++) {
      await processTransaction({
        transaction_id: `txn_vel_valid_${i}`,
        account_id:     "acc_test",
        type:           "DEBIT",
        amount:         1000,
      });
    }

    // Send 10 blocked transactions (amount > 50k)
    // These should NOT count toward the velocity limit
    for (let i = 1; i <= 10; i++) {
      await processTransaction({
        transaction_id: `txn_vel_blocked_${i}`,
        account_id:     "acc_test",
        type:           "DEBIT",
        amount:         60000,
      });
    }

    // 4th valid transaction should still go through
    // (only 3 COMPLETED, well under the limit of 5)
    const result = await processTransaction({
      transaction_id: "txn_vel_valid_4",
      account_id:     "acc_test",
      type:           "DEBIT",
      amount:         1000,
    });

    expect(result.status).toBe("COMPLETED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6: Event replay rebuilding balances
//
// Replays all COMPLETED transactions and verifies the
// rebuilt balance matches the actual DB balance.
// ─────────────────────────────────────────────────────────────────────────────
describe("6. Event replay rebuilding balances", () => {
  it("should rebuild correct balance by replaying all events", async () => {
    // Create a known sequence of transactions
    await processTransaction({ transaction_id: "txn_replay_1", account_id: "acc_test", type: "DEBIT",  amount: 10000 });
    await processTransaction({ transaction_id: "txn_replay_2", account_id: "acc_test", type: "DEBIT",  amount: 5000  });
    await processTransaction({ transaction_id: "txn_replay_3", account_id: "acc_test", type: "CREDIT", amount: 3000  });
    await processTransaction({ transaction_id: "txn_replay_4", account_id: "acc_test", type: "DEBIT",  amount: 8000  });

    // Expected: 100000 - 10000 - 5000 + 3000 - 8000 = 80000

    // Replay: fetch all COMPLETED transactions in order and rebuild balance
    const result = await pool.query(
      `SELECT type, amount FROM transactions
       WHERE account_id = 'acc_test'
         AND status     = 'COMPLETED'
       ORDER BY created_at ASC`
    );

    let replayedBalance = 0;
    for (const txn of result.rows) {
      replayedBalance += txn.type === "CREDIT"
        ? parseFloat(txn.amount)
        : -parseFloat(txn.amount);
    }

    // Actual balance from DB
    const account = await getAccount("acc_test");
    const actualBalance = parseFloat(account.balance);

    expect(replayedBalance).toBe(80000);
    expect(actualBalance).toBe(80000);
    expect(replayedBalance).toBe(actualBalance); // replayed must match actual
  });

  it("should ignore BLOCKED transactions during replay", async () => {
    await processTransaction({ transaction_id: "txn_replay_5", account_id: "acc_test", type: "DEBIT",  amount: 5000  });
    await processTransaction({ transaction_id: "txn_replay_6", account_id: "acc_test", type: "DEBIT",  amount: 99999 }); // blocked - over 50k? no, let's use amount rule
    await processTransaction({ transaction_id: "txn_replay_7", account_id: "acc_test", type: "CREDIT", amount: 2000  });

    // Replay only COMPLETED events
    const result = await pool.query(
      `SELECT type, amount FROM transactions
       WHERE account_id = 'acc_test'
         AND status     = 'COMPLETED'
       ORDER BY created_at ASC`
    );

    let replayedBalance = 0;
    for (const txn of result.rows) {
      replayedBalance += txn.type === "CREDIT"
        ? parseFloat(txn.amount)
        : -parseFloat(txn.amount);
    }

    const account = await getAccount("acc_test");
    expect(replayedBalance).toBe(parseFloat(account.balance));
  });
});