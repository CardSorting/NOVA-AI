# Telemetry & Distributed Tracing

[Wiki Portal](../README.md) > [Observability](./README.md) > Telemetry & Tracing

NOVA tracks fine-grained execution percentiles and supports end-to-end distributed tracing across client applications and upstream shards.

---

## Distributed Trace ID Propagation

Every request entering the relay is assigned a trace ID:
- If the incoming request specifies `x-trace-id` or `traceparent`, NOVA adopts that trace ID.
- Otherwise, NOVA generates a cryptographically random UUID: `tr_<random>`.
- The trace ID is attached to all internal session records, error diagnostics, and returned in the HTTP response header:
  ```http
  X-Nova-Trace-Id: tr_01j982a17f
  ```

---

## Real-Time Latency Percentiles

The `RelayTelemetry` aggregator computes real-time sliding percentiles using in-memory circular ring buffers:

### Tracked Metrics:
1. **Time-To-First-Token (TTFT):** Measures latency from payload dispatch until the first token frame arrives from the upstream shard.
2. **Inter-Token Latency (ITL):** Measures the delta duration between consecutive token frames.
3. **Throughput (Tokens/Second):** Tracks aggregate generation rate across all concurrent streams.

### Querying Telemetry:
```bash
curl -H "Authorization: Bearer <RELAY_ADMIN_KEY>" http://127.0.0.1:3001/api/telemetry
```

Response:
```json
{
  "activeConnections": 12,
  "ttft": {
    "p50Ms": 380.0,
    "p95Ms": 850.5,
    "p99Ms": 1350.0
  },
  "itl": {
    "p50Ms": 17.5,
    "p95Ms": 34.0,
    "p99Ms": 68.0
  },
  "throughputTokensPerSec": 520.4
}
```
