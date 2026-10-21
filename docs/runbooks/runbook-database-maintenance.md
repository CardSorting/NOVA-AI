# Runbook: Database Maintenance & Backups

This runbook covers regular maintenance, vacuuming schedules, and backup procedures for the distilled NOVA PostgreSQL database.

---

## Maintenance Overview

The distilled PostgreSQL schema contains four high-frequency tables:
- `public.nova_shard_accounts` (Low mutation, high read frequency)
- `public.nova_shard_leases` (High mutation: lease acquisitions, heartbeats, and settlements)
- `private.nova_relay_principals` (Read-only API key verification)
- `private.relay_executions` (Append-mostly execution auditing)

---

## 1. Automated VACUUM & ANALYZE Schedule

Because `nova_shard_leases` experiences frequent `UPDATE` operations as heartbeats arrive, PostgreSQL autovacuum should be tuned for aggressive dead tuple cleanup:

```sql
-- Tune autovacuum for high-frequency lease table
ALTER TABLE public.nova_shard_leases SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_cost_limit = 500
);

-- Weekly maintenance script:
VACUUM (ANALYZE, VERBOSE) public.nova_shard_leases;
VACUUM (ANALYZE, VERBOSE) private.relay_executions;
```

---

## 2. Connection Pool Sizing

Configure the connection pool in `src/db/postgres.ts`:
- **Default Pool Size:** 20 connections per relay process.
- **Idle Timeout:** 30,000ms.
- **Connection Timeout:** 5,000ms.

Formula for total cluster connections:
$$\text{Max DB Connections} \ge (\text{Relay Pods} \times 20) + (\text{Pool Runtimes} \times 10) + 15\text{ (Admin buffer)}$$

---

## 3. Backup & Disaster Recovery Procedures

### Full Logical Backup:
```bash
pg_dump -h 127.0.0.1 -U postgres -d nova -F c -b -v -f "/backups/nova-backup-$(date +%Y%m%d%H%M%S).dump"
```

### Complete Database Restoration:
```bash
# 1. Terminate active connections
psql -h 127.0.0.1 -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'nova' AND pid <> pg_backend_pid();"

# 2. Restore database
pg_restore -h 127.0.0.1 -U postgres -d nova -v --clean "/backups/nova-backup-<TIMESTAMP>.dump"

# 3. Verify health
npm run db:migrate -- --check
```
