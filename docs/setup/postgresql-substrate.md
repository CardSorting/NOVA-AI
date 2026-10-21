# Distilled PostgreSQL Substrate Setup Guide

This guide details how to configure, migrate, and maintain the PostgreSQL relational substrate for NOVA with zero Supabase dependencies.

---

## Architectural Distillation

NOVA replaces 159 historical Supabase migrations with a single, production-hardened, idempotent schema: [db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql).

### Key Architectural Reductions:
- **Supabase Auth / GoTrue Removed:** Replaced with direct SHA-256 hashed API keys in `private.nova_relay_principals`.
- **pgvector Extension Removed:** Relay routing utilizes fast relational indexing on shard weights, token buckets, and active leases without high vector memory overhead.
- **Stripe & Persona Billing Removed:** Replaced with continuous in-memory leaky buckets and unconsumed token refunds.
- **Vanilla PostgreSQL 14–17+ Compatibility:** Zero proprietary cloud extensions required.

---

## Database Schema Structure

```sql
-- Public Shard Account Fleet
CREATE TABLE public.nova_shard_accounts (
  id VARCHAR(64) PRIMARY KEY,
  account_label TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  auth_type VARCHAR(32) NOT NULL,
  encrypted_ciphertext TEXT NOT NULL,
  encrypted_iv TEXT NOT NULL,
  encrypted_tag TEXT NOT NULL,
  token_bucket JSONB NOT NULL,
  stats JSONB NOT NULL DEFAULT '{}',
  fencing_token BIGINT NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  cooldown_until_ms BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Public Active Distributed Leases
CREATE TABLE public.nova_shard_leases (
  id VARCHAR(64) PRIMARY KEY,
  shard_id VARCHAR(64) REFERENCES public.nova_shard_accounts(id) ON DELETE CASCADE,
  fencing_token BIGINT NOT NULL,
  reserved_tokens INT NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Private Execution Store (Fencing & Settlement)
CREATE TABLE private.relay_executions (
  execution_id VARCHAR(128) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  fencing_token BIGINT NOT NULL,
  tokens_consumed INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'reserved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);
```

---

## Stored Procedures

The schema provisions two primary transactional stored procedures:

1. **`private.relay_execution(p_action, p_execution_id, p_account_id, p_fencing_token, p_tokens)`:**
   - Atomic verification of monotonic fencing tokens.
   - Atomically transitions lease state and refunds unconsumed tokens to the shard account.
2. **`private.relay_control(p_action, p_payload)`:**
   - Administrative coordination of shard health status, canary slot admission, and cooldown resets.

---

## Migration Commands

```bash
# 1. Check PostgreSQL connection health without modifying tables
npx tsx bin/migrate.ts --check --url postgresql://postgres:postgres@127.0.0.1:5432/nova

# 2. Apply the distilled schema (idempotent; safe to run multiple times)
npm run db:migrate

# 3. Apply schema AND development seed identities (development/testing only)
npm run db:seed
```

### Development Seed Identities

Running `npm run db:seed` provisions four default RBAC principals:
- **Runtime Principal:** `nova-dev-runtime-token`
- **Operator Principal:** `nova-dev-operator-token`
- **Registrar Principal:** `nova-dev-registrar-token`
- **Viewer Principal:** `nova-dev-viewer-token`
- **Synthetic Test Shard:** `nova_sh_000000000000000000000001` (Pre-configured healthy OpenAI shard)
