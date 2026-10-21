# Playbook: Handling Upstream Provider Outages (502 / 503 / 429)

This playbook guides engineers through investigating and mitigating upstream AI provider outages and circuit breaker trips.

---

## Symptoms & Alerts

- Gateway returns `HTTP 502 upstream_error` or `HTTP 429 shard_exhausted`.
- Prometheus metric `nova_relay_upstream_failures_total` increases sharply.
- Shards transition to `cooldown` or `quarantined` state.

---

## Diagnostic Procedure

### 1. Identify Quarantined Shards
```bash
curl -s -H "Authorization: Bearer $RELAY_ADMIN_KEY" http://127.0.0.1:3001/api/shards | jq '.[] | {id, status, consecutiveFailures, cooldownUntilMs}'
```

### 2. Inspect Error Classification
NOVA's `NovaCircuitBreaker` automatically classifies upstream responses:
- **Transient Failures (HTTP 502/503/504, TLS reset, ITL stall):** Shard is assigned an exponential backoff with AWS full jitter.
- **Terminal Failures (HTTP 401 Unauthorized, Account Suspended):** Shard is marked `revoked` and completely removed from SWRR rotation.

---

## Remediation Actions

### Action 1: Add Capacity via Dynamic Enrollment
If multiple shards have tripped their rate limits:
```bash
curl -X POST http://127.0.0.1:3001/api/shards/enroll \
  -H "Authorization: Bearer $RELAY_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "accountLabel": "Emergency Shard",
    "provider": "openai",
    "authType": "api_key",
    "apiKey": "sk-proj-emergency-key",
    "weight": 5,
    "priority": 10,
    "maxTokens": 2000000,
    "refillRatePerMinute": 1000000,
    "maxRequests": 1000
  }'
```

### Action 2: Force Reset Shard Quota Windows
If an upstream provider outage has cleared, force-reset the rolling quota window:
```bash
curl -X POST http://127.0.0.1:3001/api/quota/reset \
  -H "Authorization: Bearer $RELAY_ADMIN_KEY"
```
All healthy shards will immediately return to active rotation with single-canary probing.
