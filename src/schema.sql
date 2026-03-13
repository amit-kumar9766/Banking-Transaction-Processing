-- ─────────────────────────────────────────────
-- Accounts
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
    account_id   VARCHAR(50)     PRIMARY KEY,
    owner_name   VARCHAR(100)    NOT NULL,
    balance      NUMERIC(15, 2)  NOT NULL DEFAULT 0.00,
    created_at   TIMESTAMP       DEFAULT NOW(),

    CONSTRAINT balance_non_negative CHECK (balance >= 0)
);

-- ─────────────────────────────────────────────
-- Transactions  (also acts as idempotency store)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
    id                  SERIAL          PRIMARY KEY,
    transaction_id      VARCHAR(100)    UNIQUE NOT NULL,
    account_id          VARCHAR(50)     NOT NULL REFERENCES accounts(account_id),
    type                VARCHAR(10)     NOT NULL CHECK (type IN ('DEBIT', 'CREDIT')),
    amount              NUMERIC(15, 2)  NOT NULL CHECK (amount > 0),
    status              VARCHAR(20)     NOT NULL DEFAULT 'COMPLETED',
                                        -- COMPLETED | BLOCKED
    balance_after       NUMERIC(15, 2), -- null if blocked (balance never changed)
    fraud_reason        TEXT,           -- set if status = BLOCKED
    device_fingerprint  VARCHAR(255),   -- for async fraud analysis
    ip_address          VARCHAR(45),    -- for async fraud analysis (supports IPv6)
    created_at          TIMESTAMP       DEFAULT NOW()
);

-- Velocity check: count COMPLETED txns per account in last 60s
-- status included so Postgres can resolve the query from the index alone
CREATE INDEX IF NOT EXISTS idx_transactions_account_time
    ON transactions(account_id, status, created_at);

-- ─────────────────────────────────────────────
-- Outbox  (transactional outbox pattern)
-- Events are written here atomically with the
-- transaction, then a worker publishes to Kafka.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox (
    id           UUID            PRIMARY KEY,
    event_type   VARCHAR(50)     NOT NULL,  -- TransactionCompleted | TransactionBlocked
    payload      JSONB           NOT NULL,
    processed    BOOLEAN         NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMP       DEFAULT NOW(),
    published_at TIMESTAMP                  -- set by outbox worker after Kafka publish
);

-- Outbox worker only reads unprocessed rows
CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed
    ON outbox(processed, created_at)
    WHERE processed = FALSE;

-- ─────────────────────────────────────────────
-- Seed data
-- ─────────────────────────────────────────────
INSERT INTO accounts (account_id, owner_name, balance)
VALUES ('acc_123', 'Test User', 100000.00)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────
-- Ledger  (append-only, never update/delete)
-- One row per completed transaction.
-- Used for audit, replay, and balance rebuild.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger (
    id             SERIAL          PRIMARY KEY,
    transaction_id VARCHAR(100)    UNIQUE NOT NULL,  -- idempotency: one ledger entry per txn
    account_id     VARCHAR(50)     NOT NULL REFERENCES accounts(account_id),
    type           VARCHAR(10)     NOT NULL CHECK (type IN ('DEBIT', 'CREDIT')),
    amount         NUMERIC(15, 2)  NOT NULL,
    balance_after  NUMERIC(15, 2)  NOT NULL,
    recorded_at    TIMESTAMP       DEFAULT NOW()     -- when ledger consumer processed it
);

CREATE INDEX IF NOT EXISTS idx_ledger_account
    ON ledger(account_id, recorded_at);

-- ─────────────────────────────────────────────
-- Analytics  (aggregated metrics per account)
-- Upserted by analytics consumer on each event.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics (
    account_id       VARCHAR(50)    PRIMARY KEY REFERENCES accounts(account_id),
    total_debit      NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    total_credit     NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    total_blocked    INT            NOT NULL DEFAULT 0,
    transaction_count INT           NOT NULL DEFAULT 0,
    last_updated     TIMESTAMP      DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- DLQ Messages
-- Failed messages land here after all retries
-- are exhausted. Can be inspected and manually
-- reprocessed via POST /dlq/reprocess/:id
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dlq_messages (
    id               SERIAL        PRIMARY KEY,
    failed_consumer  VARCHAR(100)  NOT NULL,
    error_message    TEXT          NOT NULL,
    original_event   JSONB         NOT NULL,
    failed_at        TIMESTAMP     NOT NULL,
    reprocessed      BOOLEAN       NOT NULL DEFAULT FALSE,
    reprocessed_at   TIMESTAMP
);

-- ─────────────────────────────────────────────
-- Saga State  (orchestrator tracking)
-- One row per transaction being orchestrated.
-- Tracks which steps have completed.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saga_state (
    transaction_id       VARCHAR(100)  PRIMARY KEY,
    account_id           VARCHAR(50)   NOT NULL,
    amount               NUMERIC(15,2) NOT NULL,
    payment_authorized   BOOLEAN       NOT NULL DEFAULT FALSE,
    ledger_updated       BOOLEAN       NOT NULL DEFAULT FALSE,
    status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
                                       -- PENDING | FINALIZED | TIMED_OUT
    created_at           TIMESTAMP     DEFAULT NOW(),
    finalized_at         TIMESTAMP,
    timeout_at           TIMESTAMP     NOT NULL  -- if not finalized by this time → compensation
);