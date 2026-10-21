# Prometheus Metrics Catalog

[Wiki Portal](../README.md) > [Observability](./README.md) > Prometheus Metrics

This catalog documents all Prometheus metrics emitted on `GET /metrics` by NOVA Relay.

---

## Metric Reference Table

| Metric Name | Type | Labels | Description |
| :--- | :---: | :--- | :--- |
| `nova_relay_requests_total` | Counter | `status`, `method` | Total HTTP requests processed by the gateway. |
| `nova_relay_active_jobs` | Gauge | — | Number of active inference jobs currently streaming or executing. |
| `nova_relay_tokens_consumed_total` | Counter | `model`, `type` | Total prompt and completion tokens consumed upstream. |
| `nova_relay_tokens_refunded_total` | Counter | `model` | Total unconsumed tokens refunded back to token buckets. |
| `nova_relay_itl_stalls_total` | Counter | `model` | Total Inter-Token Latency stall events detected ($>8\text{s}$). |
| `nova_relay_bulkhead_saturated_total`| Counter| — | Total requests dynamically decoupled into queue due to bulkhead saturation. |
| `nova_relay_upstream_failures_total`| Counter | `shard_id`, `error_code` | Upstream provider 5xx, 429, or network drop occurrences. |
| `nova_relay_circuit_trips_total` | Counter | `shard_id` | Number of times shards were isolated into quarantine cooldown. |
| `nova_queue_ready_jobs` | Gauge | `queue` | Number of waiting jobs in the BroccoliQueue Ready Heap. |
| `nova_queue_delayed_jobs` | Gauge | `queue` | Number of delayed jobs in the BroccoliQueue Delayed Heap. |
| `nova_queue_leased_jobs` | Gauge | `queue` | Number of currently leased jobs in the BroccoliQueue Lease Heap. |

---

## Recommended Prometheus Alerting Rules

```yaml
groups:
  - name: nova_alerts
    rules:
      - alert: NovaHighErrorRate
        expr: rate(nova_relay_requests_total{status=~"5.."}[5m]) / rate(nova_relay_requests_total[5m]) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "NOVA Relay error rate exceeds 5% over 5m"

      - alert: NovaShardExhaustion
        expr: sum(nova_relay_circuit_trips_total) by (shard_id) > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Multiple shards entering quarantine cooldown"

      - alert: NovaItlStallsSpike
        expr: rate(nova_relay_itl_stalls_total[5m]) > 0.5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Elevated Inter-Token Latency stalls detected upstream"
```
