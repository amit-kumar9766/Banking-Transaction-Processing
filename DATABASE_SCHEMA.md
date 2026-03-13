# Database Schema Diagram

## Visual ER Diagram

```mermaid
erDiagram
    accounts ||--o{ transactions : "has"
    accounts ||--o{ ledger : "has"
    accounts ||--|| analytics : "has"
    
    transactions ||--o| outbox : "generates"
    transactions ||--o| saga_state : "tracks"
    transactions ||--o| ledger : "recorded_in"
    
    accounts {
        VARCHAR account_id PK
        VARCHAR owner_name
        NUMERIC balance
        TIMESTAMP created_at
    }
    
    transactions {
        SERIAL id PK
        VARCHAR transaction_id UK
        VARCHAR account_id FK
        VARCHAR type
        NUMERIC amount
        VARCHAR status
        NUMERIC balance_after
        TEXT fraud_reason
        VARCHAR device_fingerprint
        VARCHAR ip_address
        TIMESTAMP created_at
    }
    
    outbox {
        UUID id PK
        VARCHAR event_type
        JSONB payload
        BOOLEAN processed
        TIMESTAMP created_at
        TIMESTAMP published_at
    }
    
    ledger {
        SERIAL id PK
        VARCHAR transaction_id UK
        VARCHAR account_id FK
        VARCHAR type
        NUMERIC amount
        NUMERIC balance_after
        TIMESTAMP recorded_at
    }
    
    analytics {
        VARCHAR account_id PK_FK
        NUMERIC total_debit
        NUMERIC total_credit
        INT total_blocked
        INT transaction_count
        TIMESTAMP last_updated
    }
    
    dlq_messages {
        SERIAL id PK
        VARCHAR failed_consumer
        TEXT error_message
        JSONB original_event
        TIMESTAMP failed_at
        BOOLEAN reprocessed
        TIMESTAMP reprocessed_at
    }
    
    saga_state {
        VARCHAR transaction_id PK
        VARCHAR account_id
        NUMERIC amount
        BOOLEAN payment_authorized
        BOOLEAN ledger_updated
        VARCHAR status
        TIMESTAMP created_at
        TIMESTAMP finalized_at
        TIMESTAMP timeout_at
    }
```

## Table Descriptions

### 📊 **accounts**
- **Purpose**: Core account information
- **Key**: `account_id` (Primary Key)
- **Constraints**: Balance must be non-negative

### 💳 **transactions**
- **Purpose**: All transaction records (idempotency store)
- **Key**: `id` (PK), `transaction_id` (Unique)
- **Foreign Key**: `account_id` → `accounts.account_id`
- **Status**: COMPLETED | BLOCKED
- **Index**: `idx_transactions_account_time` (account_id, status, created_at)

### 📤 **outbox**
- **Purpose**: Transactional outbox pattern - events to be published to Kafka
- **Key**: `id` (UUID, Primary Key)
- **Fields**: `event_type`, `payload` (JSONB), `processed` flag
- **Index**: `idx_outbox_unprocessed` (for worker polling)

### 📝 **ledger**
- **Purpose**: Append-only audit log of completed transactions
- **Key**: `id` (PK), `transaction_id` (Unique)
- **Foreign Key**: `account_id` → `accounts.account_id`
- **Index**: `idx_ledger_account` (account_id, recorded_at)

### 📈 **analytics**
- **Purpose**: Aggregated metrics per account
- **Key**: `account_id` (Primary Key, Foreign Key)
- **Foreign Key**: `account_id` → `accounts.account_id`
- **Updates**: Upserted by analytics consumer

### ☠️ **dlq_messages**
- **Purpose**: Dead Letter Queue - failed messages after retries
- **Key**: `id` (Primary Key)
- **Fields**: Stores failed consumer, error message, original event

### 🎭 **saga_state**
- **Purpose**: Orchestrator pattern - tracks distributed transaction steps
- **Key**: `transaction_id` (Primary Key)
- **Status**: PENDING | FINALIZED | TIMED_OUT
- **Tracks**: `payment_authorized`, `ledger_updated` flags

## Relationships

1. **accounts** → **transactions** (1:N)
   - One account has many transactions

2. **accounts** → **ledger** (1:N)
   - One account has many ledger entries

3. **accounts** → **analytics** (1:1)
   - One account has one analytics record

4. **transactions** → **outbox** (1:N)
   - One transaction can generate multiple events

5. **transactions** → **saga_state** (1:1)
   - One transaction has one saga state (if orchestrated)

6. **transactions** → **ledger** (1:1)
   - One completed transaction has one ledger entry

## Data Flow

```
Transaction Created
    ↓
[transactions] table (idempotency store)
    ↓
[outbox] table (event written atomically)
    ↓
Outbox Worker → Kafka Topics
    ↓
Consumers → [ledger], [analytics], [saga_state]
```

## Key Patterns

1. **Transactional Outbox**: Events written to `outbox` atomically with `transactions`
2. **Idempotency**: `transaction_id` is unique across tables
3. **Event Sourcing**: `ledger` is append-only for audit/replay
4. **Saga Pattern**: `saga_state` tracks distributed transaction coordination
5. **Dead Letter Queue**: `dlq_messages` stores failed events for manual review
