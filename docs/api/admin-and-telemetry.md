# API Reference: Admin & Telemetry

[Wiki Portal](../README.md) > [APIs](./README.md) > Admin & Telemetry

Administrative endpoints provide real-time observability, telemetry inspection, and dynamic shard fleet management. All endpoints in this category require the operator Bearer token (`RELAY_ADMIN_KEY`).

---

## 1. Prometheus Metrics (`GET /metrics`)

Emits real-time Prometheus-compatible metrics for scraping by Prometheus, VictoriaMetrics, or Datadog.

### Request:
```bash
curl -H "Authorization: Bearer <RELAY_ADMIN_KEY>" http://127.0.0.1:3001/metrics
```

### Sample Output:
```text
# HELP nova_relay_active_jobs Current in-flight jobs being processed
# TYPE nova_relay_active_jobs gauge
nova_relay_active_jobs 14

# HELP nova_relay_requests_total Total HTTP requests received by gateway
# TYPE nova_relay_requests_total counter
nova_relay_requests_total{status="200"} 42891
nova_relay_requests_total{status="429"} 12
nova_relay_requests_total{status="502"} 3

# HELP nova_relay_itl_stalls_total Total inter-token latency stalls detected
# TYPE nova_relay_itl_stalls_total counter
nova_relay_itl_stalls_total 1
```

---

## 2. Real-Time Telemetry Percentiles (`GET /api/telemetry`)

Returns calculated latency percentiles (p50, p95, p99) and Time-To-First-Token (TTFT) metrics:

### Request:
```bash
curl -H "Authorization: Bearer <RELAY_ADMIN_KEY>" http://127.0.0.1:3001/api/telemetry
```

### Response Schema:
```json
{
  "uptimeSeconds": 86400,
  "activeConnections": 18,
  "ttft": {
    "p50Ms": 420.5,
    "p95Ms": 890.2,
    "p99Ms": 1420.0
  },
  "itl": {
    "p50Ms": 18.2,
    "p95Ms": 35.4,
    "p99Ms": 72.1
  },
  "throughputTokensPerSec": 450.8
}
```

---

## 3. Shard Fleet Administration

### Inspect Shard Accounts (`GET /api/shards`)
```bash
curl -H "Authorization: Bearer <RELAY_ADMIN_KEY>" http://127.0.0.1:3001/api/shards
```

### Force Synchronize with Database (`POST /api/shards/sync`)
Forces the in-memory gateway to re-query the PostgreSQL substrate and re-decrypt updated shard credentials:
```bash
curl -X POST -H "Authorization: Bearer <RELAY_ADMIN_KEY>" http://127.0.0.1:3001/api/shards/sync
```

### Force Reset Rolling Quota Window (`POST /api/quota/reset`)
```bash
curl -X POST -H "Authorization: Bearer <RELAY_ADMIN_KEY>" http://127.0.0.1:3001/api/quota/reset
```
