# Banking System - Step-by-Step Learning Guide

## 📚 Overview
This guide breaks down the entire banking transaction system into digestible pieces. Go through each section one by one to understand how everything works together.

---

## 🎯 Day 1: Core Concepts

### Step 1: Understanding the Problem
**What are we building?**
- A banking system that processes transactions (DEBIT/CREDIT)
- Detects fraud in real-time
- Tracks everything for audit purposes
- Sends real-time updates to clients

**Key Challenges:**
- Prevent double-spending (concurrent requests)
- Handle failures gracefully
- Ensure data consistency across services
- Provide real-time updates

**Files to Review:**
- `src/schema.sql` - Database structure
- `DATABASE_SCHEMA.md` - Visual diagram

---

### Step 2: Database Schema Basics
**What to understand:**
1. **accounts** - Stores account balances
2. **transactions** - Every transaction attempt (idempotency store)
3. **outbox** - Events waiting to be published to Kafka
4. **ledger** - Append-only audit log
5. **analytics** - Aggregated metrics
6. **saga_state** - Tracks distributed transaction coordination
7. **dlq_messages** - Failed messages after retries

**Key Concept: Idempotency**
- Same `transaction_id` = same result (no duplicate processing)

**Files to Review:**
- `src/schema.sql` (lines 1-125)

---

### Step 3: Transaction Processing Flow
**The Basic Flow:**
```
1. API receives transaction request
2. Check if already processed (idempotency)
3. Fraud checks (amount limit, velocity)
4. Update balance (with row-level lock)
5. Save transaction record
6. Write event to outbox
7. Return response
```

**Files to Review:**
- `src/services/transactionsService.js` (lines 11-159)
- `src/routes/transactions.js`

**Key Concepts:**
- **Row-level locking** (`FOR UPDATE`) - Prevents concurrent balance updates
- **Idempotency check** - Prevents duplicate processing
- **Fraud rules** - Amount limit (₹50k) and velocity (5 txns/60s)

---

## 🎯 Day 2: Event-Driven Architecture

### Step 4: Understanding the Outbox Pattern
**Why Outbox?**
- Database transaction and Kafka publish must be atomic
- If Kafka is down, events are stored safely
- Worker retries publishing later

**How it Works:**
```
Transaction Service → Writes to outbox (same DB transaction)
                    ↓
Outbox Worker → Polls unprocessed events
              → Publishes to Kafka
              → Marks as processed
```

**Files to Review:**
- `src/services/transactionsService.js` (lines 123-142) - Writing to outbox
- `src/workers/outboxWorker.js` - Worker that publishes events

**Key Concept:**
- Events written atomically with transaction
- Worker handles Kafka publishing separately

---

### Step 5: Kafka Topics and Events
**Topics:**
- `transactions.events` - Completed transactions
- `transactions.blocked` - Blocked transactions
- `ledger.events` - Ledger confirmations
- `transactions.finalized` - Finalized transactions
- `transactions.dlq` - Dead letter queue

**Event Structure:**
```json
{
  "event_type": "TransactionCompleted",
  "event_version": 1,
  "transaction_id": "txn_123",
  "account_id": "acc_123",
  "amount": 5000,
  "balance_after": 95000
}
```

**Files to Review:**
- `src/kafka/topics.js`
- `src/kafka/producer.js`
- `src/kafka/consumer.js`

---

### Step 6: Consumers - Event Processing
**What Consumers Do:**
1. **Analytics Consumer** - Updates metrics (total_debit, total_credit, etc.)
2. **Ledger Consumer** - Records in append-only ledger
3. **Notification Consumer** - Sends notifications (simulated)
4. **DLQ Consumer** - Stores failed messages
5. **Orchestrator Consumer** - Coordinates distributed transactions

**Files to Review:**
- `src/consumers/Analyticsconsumer.js`
- `src/consumers/Ledgerconsumer.js`
- `src/consumers/NotificationConsumer.js`
- `src/consumers/dlqconsumer.js`

**Key Concept:**
- Each consumer has its own consumer group
- Same event can be processed by multiple consumers
- Consumers are independent and scalable

---

## 🎯 Day 3: Resilience & Error Handling

### Step 7: Retry Logic
**Why Retry?**
- Transient failures (network glitch, DB connection lost)
- Automatic recovery without manual intervention

**How it Works:**
```
Handler fails → Retry 1 (wait 2s)
             → Retry 2 (wait 4s)
             → Retry 3 (wait 8s)
             → All failed? Send to DLQ
```

**Files to Review:**
- `src/utils/retry.js`
- `src/kafka/consumer.js` (line 26) - Wraps handlers with retry

**Key Concept:**
- Exponential backoff (2s → 4s → 8s)
- After max retries, message goes to DLQ

---

### Step 8: Dead Letter Queue (DLQ)
**What is DLQ?**
- Final destination for messages that failed all retries
- Stored in database for manual inspection
- Can be reprocessed via API

**DLQ Flow:**
```
Consumer fails → Retries exhausted → Sent to DLQ topic
                                      ↓
                              DLQ Consumer → Stores in DB
                                      ↓
                              Manual review via GET /dlq
                                      ↓
                              Reprocess via POST /dlq/reprocess/:id
```

**Files to Review:**
- `src/consumers/dlqconsumer.js`
- `src/routes/DLQ.js`

---

### Step 9: Saga Pattern (Orchestrator)
**What Problem Does It Solve?**
- Coordinating multiple services (Payment + Ledger)
- Ensuring both complete or both fail
- Handling timeouts and compensation

**Saga Flow:**
```
TransactionCompleted → Create saga (payment_authorized = true)
                    ↓
LedgerUpdated → Mark ledger_updated = true
              → Both done? Finalize saga
              → Publish TransactionFinalized
```

**Timeout Handling:**
- If ledger doesn't respond in 30s → Mark as TIMED_OUT
- Trigger compensation (reverse payment, alert ops)

**Files to Review:**
- `src/consumers/orchestratorconsumer.js`
- `src/services/sagaStore.js`
- `src/schema.sql` (lines 114-125) - saga_state table

**Key Concept:**
- Tracks which steps completed
- Can trigger compensation if timeout

---

## 🎯 Day 4: Real-Time Features & API

### Step 10: Server-Sent Events (SSE)
**What is SSE?**
- One-way communication from server to client
- Client keeps connection open
- Server pushes updates as they happen

**Flow:**
```
Client → GET /sse/:account_id
       ↓
Server → Keeps connection open
       ↓
Transaction happens → pushToAccount() → All connected clients receive update
```

**Files to Review:**
- `src/services/SSEService.js`
- `src/routes/sse.js`
- `src/routes/transactions.js` (lines 27-33, 49-55, 62-69) - SSE updates

**Key Concept:**
- Real-time updates without polling
- Multiple clients can connect to same account

---

### Step 11: Audit & Replay
**What Can You Audit?**
1. **Account History** - All transactions for an account
2. **Transaction Trace** - Complete journey of one transaction
3. **Balance Replay** - Rebuild balance from scratch

**Why Replay?**
- Verify current balance is correct
- Debug discrepancies
- Audit trail

**Files to Review:**
- `src/routes/audit.js`

**Key Concept:**
- Event sourcing pattern
- Can rebuild state by replaying events

---

## 🎯 Day 5: Testing & Architecture

### Step 12: Test Scenarios
**What Tests Cover:**
1. **Idempotency** - Duplicate requests return cached result
2. **Concurrency** - Concurrent requests don't double-spend
3. **Worker Crash** - Outbox events survive crashes
4. **Retry Logic** - Retries work correctly, DLQ on failure
5. **Fraud Detection** - Amount and velocity limits work
6. **Event Replay** - Can rebuild balance from events

**Files to Review:**
- `src/tests/test.js`

---

### Step 13: Architecture Patterns Used
**1. Transactional Outbox Pattern**
- Ensures events are published even if Kafka is down
- Atomic write to database + outbox

**2. Saga Pattern**
- Coordinates distributed transactions
- Handles partial failures with compensation

**3. Event Sourcing**
- Ledger is append-only
- Can replay events to rebuild state

**4. CQRS (Command Query Responsibility Segregation)**
- Commands: Write to transactions table
- Queries: Read from ledger, analytics, audit

**5. Idempotency**
- Same request = same result
- Prevents duplicate processing

---

## 🎯 Day 6: Putting It All Together

### Step 14: Complete Request Flow
**Example: User makes a ₹5,000 debit**

```
1. POST /transactions
   ↓
2. transactionsService.processTransaction()
   - Idempotency check
   - Fraud checks (amount, velocity)
   - Lock account row (FOR UPDATE)
   - Update balance
   - Save transaction
   - Write to outbox
   ↓
3. SSE: Push PENDING to client
   ↓
4. Outbox Worker (background)
   - Polls outbox
   - Publishes TransactionCompleted to Kafka
   ↓
5. Multiple Consumers process event:
   - Analytics: Updates metrics
   - Ledger: Records in ledger
   - Notification: Sends email (simulated)
   - Orchestrator: Starts saga
   ↓
6. Ledger Consumer publishes LedgerUpdated
   ↓
7. Orchestrator receives LedgerUpdated
   - Marks ledger_updated = true
   - Both steps done? Finalize saga
   - Publish TransactionFinalized
   ↓
8. SSE: Push COMPLETED to client
```

---

### Step 15: Failure Scenarios
**What Happens If...**

**Kafka is Down?**
- Events stay in outbox (unprocessed)
- Worker retries on next poll
- No data loss

**Consumer Crashes?**
- Message stays in Kafka
- Consumer resumes from last offset
- Retry logic handles transient failures

**Ledger Never Responds?**
- Orchestrator timeout (30s)
- Saga marked as TIMED_OUT
- Compensation triggered
- Client sees FAILED status

**Database Connection Lost?**
- Transaction rolls back
- No partial state
- Client gets error, can retry

---

## 📝 Key Takeaways

### Design Principles
1. **Idempotency** - Safe to retry
2. **Atomicity** - All or nothing
3. **Eventual Consistency** - Services sync via events
4. **Resilience** - Handles failures gracefully
5. **Observability** - Full audit trail

### Best Practices
- Use row-level locks for balance updates
- Write events atomically with transactions
- Retry with exponential backoff
- Store failed messages for manual review
- Track distributed transactions with sagas

---

## 🚀 Next Steps

1. **Start with Step 1** - Understand the problem
2. **Read the code** - Follow along with the files mentioned
3. **Run the tests** - See how it works in practice
4. **Experiment** - Try modifying values, see what happens
5. **Ask questions** - Each concept builds on the previous

---

## 📚 File Reference Quick Guide

| Concept | Files |
|---------|-------|
| Database Schema | `src/schema.sql`, `DATABASE_SCHEMA.md` |
| Transaction Processing | `src/services/transactionsService.js` |
| API Routes | `src/routes/transactions.js` |
| Outbox Pattern | `src/workers/outboxWorker.js` |
| Kafka Setup | `src/kafka/producer.js`, `src/kafka/consumer.js` |
| Consumers | `src/consumers/*.js` |
| Retry Logic | `src/utils/retry.js` |
| Saga Pattern | `src/consumers/orchestratorconsumer.js`, `src/services/sagaStore.js` |
| SSE | `src/services/SSEService.js`, `src/routes/sse.js` |
| Audit | `src/routes/audit.js` |
| Tests | `src/tests/test.js` |

---

**Take your time. Understand each step before moving to the next. Good luck! 🎓**
