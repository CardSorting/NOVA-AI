# Distilled PostgreSQL Relational Substrate

[Wiki Portal](../README.md) > [Architecture](./README.md) > PostgreSQL Substrate

NOVA utilizes a distilled PostgreSQL relational substrate ([db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql)) designed for high-concurrency multi-worker shard lease coordination and split-brain prevention.

---

## Split-Brain Hazard in Distributed Inference

When multiple worker nodes coordinate over a shared credential pool:
- Worker A acquires a lease for Shard 1 with fencing token $N$.
- A temporary network partition causes Worker A to pause (e.g. Garbage Collection pause or network hiccup).
- The central coordinator assumes Worker A has died and reassigns Shard 1 to Worker B with fencing token $N+1$.
- Worker A resumes and attempts to commit token consumption or mutate shard state.

Without monotonic fencing, Worker A's stale write overwrites Worker B's active execution, causing quota tracking corruption and split-brain states.

---

## Monotonic Fencing Token Protocol

NOVA resolves this using monotonic fencing tokens validated inside transactional PostgreSQL stored procedures:

```
[ Central Coordinator / Shard Registry ]
                     │
         Issues Lease with Fencing Token N+1
                     │
       ┌─────────────┴─────────────┐
       ▼                           ▼
[ Stale Worker A ]         [ Valid Worker B ]
(Fencing Token: N)         (Fencing Token: N+1)
       │                           │
       ▼ Commit Settlement         ▼ Commit Settlement
┌────────────────────────────────────────────────────────┐
│        POSTGRESQL RELAY_EXECUTION PROCEDURE            │
│                                                        │
│  IF p_fencing_token < current_fencing_token THEN       │
│     RAISE EXCEPTION 'stale_fencing_token'; -- REJECTED!│
│  ELSE                                                  │
│     UPDATE nova_shard_accounts SET ...;    -- ACCEPTED!│
│  END IF;                                               │
└────────────────────────────────────────────────────────┘
```

---

## Core Relational Tables

### 1. `public.nova_shard_accounts`
Stores upstream AI credentials, token bucket limits, and active fencing tokens:
- Primary Key: `id` (VARCHAR)
- Encrypted Columns: `encrypted_ciphertext`, `encrypted_iv`, `encrypted_tag`
- Accounting Columns: `token_bucket` (JSONB), `stats` (JSONB)
- Fencing Column: `fencing_token` (BIGINT, incremented on every lease acquisition)

### 2. `public.nova_shard_leases`
Maintains currently active in-flight worker leases:
- Foreign Key: `shard_id -> nova_shard_accounts.id`
- Heartbeat Tracking: `heartbeat_at`, `expires_at`

### 3. `private.relay_executions`
Transactional audit ledger for execution finalization:
- Execution ID, Shard Account ID, Fencing Token, Actual Tokens Consumed, Status (`reserved`, `bound`, `settled`, `released`).
