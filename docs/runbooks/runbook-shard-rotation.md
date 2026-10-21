# Runbook: Zero-Downtime Shard Rotation

This runbook guides operators through rotating upstream provider credentials without dropping active streaming connections or restarting the gateway.

---

## Shard Rotation Lifecycle

```
[ New Upstream Key Generated ]
              │
              ▼
  1. Enroll New Shard (POST /api/shards/enroll)
  2. Verify Health & Canary Slot Probe
  3. Rebalance SWRR Effective Weights
  4. Deprecate / Drain Old Shard
  5. Settle Active In-Flight Leases (<30s)
  6. Revoke Old Key at Provider
```

---

## Step-by-Step Rotation Execution

### 1. Enroll the Replacement Shard
Submit the new upstream key via the administrative endpoint:

```bash
curl -X POST http://127.0.0.1:3001/api/shards/enroll \
  -H "Authorization: Bearer $RELAY_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "accountLabel": "OpenAI Replacement Shard Q4",
    "provider": "openai",
    "authType": "api_key",
    "apiKey": "sk-proj-new-replacement-key",
    "weight": 5,
    "priority": 10,
    "maxTokens": 2000000,
    "refillRatePerMinute": 1000000,
    "maxRequests": 1000
  }'
```

---

### 2. Force Shard Synchronization & Health Verification
Trigger database synchronization across all relay instances:

```bash
curl -X POST http://127.0.0.1:3001/api/shards/sync \
  -H "Authorization: Bearer $RELAY_ADMIN_KEY"
```

Verify that the new shard appears with `status: "healthy"`:
```bash
curl -s -H "Authorization: Bearer $RELAY_ADMIN_KEY" http://127.0.0.1:3001/api/shards | jq '.[] | {id, accountLabel, status}'
```

---

### 3. Gracefully Drain the Old Shard
In PostgreSQL or via administrative control, set the deprecated shard's status:
```sql
UPDATE public.nova_shard_accounts
SET status = 'cooldown', cooldown_until_ms = 9999999999999
WHERE id = 'shard_old_deprecated_id';
```

Existing active leases on `shard_old_deprecated_id` will complete normally. Smooth Weighted Round Robin will immediately stop routing new leases to this shard.

---

### 4. Revoke Old Key Upstream
Wait 5 minutes for all trailing in-flight jobs and token reconciliations to complete, then safely revoke the old API key in the OpenAI/provider console.
