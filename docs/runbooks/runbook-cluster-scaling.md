# Runbook: Cluster Scaling & Bulkhead Tuning

This runbook guides capacity planning, horizontal autoscaling, and concurrency bulkhead configuration for NOVA deployments.

---

## Scaling Dimensions

NOVA performance scales across two orthogonal dimensions:

1. **Ingress Gateway Tier (Stateless `nova-relay`):**
   - Handles incoming HTTP connections, TLS termination, SSE parsing, and WebSocket streaming.
   - Scale horizontally when CPU $>70\%$ or active connections exceed $10,000$.
2. **Shard Credential Capacity (Pooled `nova_shard_accounts`):**
   - Upstream API rate limits (RPM & TPM).
   - Scaling gateway pods does not increase upstream provider quota; additional shard accounts must be enrolled into the pool.

---

## Concurrency Bulkhead Configuration

Configure concurrency limits in your environment:

| Parameter | Default | Recommended Production Value | Description |
| :--- | :--- | :--- | :--- |
| `RELAY_MAX_CONCURRENT_REQUESTS` | `64` | `128`–`256` | Maximum global simultaneous in-flight inference requests. |
| `RELAY_MAX_RSS_MB` | `384` | `512`–`1024` | Memory ceiling; triggers readiness unhealthy state if exceeded. |
| `TENANT_RATE_LIMIT_PER_SEC` | `50.0` | `100.0` | Continuous token bucket refill rate per tenant. |
| `TENANT_BURST_CAPACITY` | `100` | `200` | Burst allowance before returning HTTP 429. |

---

## Kubernetes Horizontal Pod Autoscaler (HPA)

Deploy an HPA manifest targeting 65% average CPU utilization:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: nova-relay-hpa
  namespace: inference
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nova-relay
  minReplicas: 3
  maxReplicas: 15
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 65
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 75
```
