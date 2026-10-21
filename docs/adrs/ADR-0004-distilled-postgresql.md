# ADR-0004: Distilled PostgreSQL Substrate (Zero Supabase Bloat)

## Status
**Accepted** (2026-10-20)

## Context
During extraction from legacy architectures, the database substrate contained 159 sequential migrations coupled tightly to Supabase Cloud, including GoTrue authentication, Edge Function triggers, Stripe billing webhooks, workspace social graphs, and memory-intensive `pgvector` extensions.

Running 159 migrations in CI took over 45 seconds, required complex cloud emulator containers, and introduced unnecessary failure points for a high-performance inference routing gateway.

## Decision
We distilled the entire database footprint into a **single, idempotent schema file ([db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql))** and a development seed file ([db/seed.sql](file:///Users/bozoegg/Downloads/nova/db/seed.sql)) targeting vanilla PostgreSQL 14 through 17+.

### Distilled Table Schema:
- `public.nova_shard_accounts`: Shard accounts, credentials, and token buckets.
- `public.nova_shard_leases`: Active distributed worker leases.
- `private.nova_relay_principals`: SHA-256 hashed API keys for RBAC.
- `private.relay_executions`: Fenced execution records with monotonic token verification.

## Consequences

### Positive:
- **Instant Migration Speed:** Schema applies in `<15ms`.
- **Zero Cloud Lock-in:** Compatible with standard PostgreSQL (AWS RDS, Google Cloud SQL, Azure Database, self-hosted Docker).
- **Reduced Memory Footprint:** Eliminating `pgvector` and bloat tables saves hundreds of megabytes of RAM.

### Negative:
- Vector search features must be handled in specialized external vector databases if ever needed.
