# Runbook: Incident Response & Severity Matrix

This runbook outlines the operational incident response procedure for on-call engineers managing NOVA inference gateways.

---

## Severity Classification Matrix

| Level | Definition | Response SLA | Escalation Target |
| :---: | :--- | :---: | :--- |
| **SEV-1** | Total cluster outage; all shards failing; gateway returning 5xx for $>5\%$ of traffic. | **15 minutes** | Lead On-Call SRE + VP Engineering |
| **SEV-2** | Partial shard degradation; ITL latency $>10\text{s}$; rate governor throttling tenants. | **30 minutes** | Primary On-Call SRE |
| **SEV-3** | Single shard quarantined; localized rate limit triggers; memory approaching RSS ceiling. | **2 hours** | Platform Engineering |
| **SEV-4** | Non-critical metric anomalies; minor documentation gaps; batch queue delays. | Next Business Day | Engineering Backlog |

---

## Initial Diagnostic Triage (First 5 Minutes)

Run the following diagnostic commands from your operations terminal:

```bash
# 1. Check Gateway Liveness & Readiness Probes
curl -i http://127.0.0.1:3001/health
curl -i http://127.0.0.1:3001/health/ready

# 2. Check Prometheus Metrics (Requires Admin Key)
curl -s -H "Authorization: Bearer $RELAY_ADMIN_KEY" http://127.0.0.1:3001/metrics | grep -E 'active_jobs|error_count|shard_status'

# 3. Check Shard Fleet Health
curl -s -H "Authorization: Bearer $RELAY_ADMIN_KEY" http://127.0.0.1:3001/api/shards
```

---

## Mitigation Action Paths

### Scenario A: Shard Quota Cascade (All Shards Returning 429)
1. Check the active shard count via `GET /api/shards`.
2. Dynamically enroll reserve shards via `POST /api/shards/enroll`.
3. If reserve credentials are unavailable, temporarily increase `TENANT_BURST_CAPACITY` or reduce `TENANT_RATE_LIMIT_PER_SEC` to throttle ingress safely.

### Scenario B: Memory Pressure (Pod RSS Exceeding Ceiling)
1. Check if `RELAY_MAX_RSS_MB` is breached.
2. Mark the pod for graceful drain:
   ```bash
   kill -TERM <pid>
   ```
3. Allow the 30-second completion grace period to drain active streams. Pod will restart cleanly.
