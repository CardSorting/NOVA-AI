# ADR-0002: Two-Phase Continuous Token-Bucket Rate Governance

## Status
**Accepted** (2026-10-20)

## Context
Upstream AI providers meter accounts along two simultaneous constraints: **Requests Per Minute (RPM)** and **Tokens Per Minute (TPM)**. In streaming chat completion workloads, the total number of completion tokens is non-deterministic when a request begins.

Traditional API gateways exhibit severe flaws:
- **Pessimistic Reservation:** Reserving `max_tokens` (e.g. 4,000 tokens) locks quota for minutes, causing premature 429 rejections even when requests generate only 50 tokens.
- **Optimistic Dispatch:** Dispatching without reserving token quotas leads to sudden cascade quota exhaustion mid-stream.

## Decision
We implemented a **Two-Phase Continuous Leaky Bucket Rate Governor** in [src/pools/rate-governor.ts](file:///Users/bozoegg/Downloads/nova/src/pools/rate-governor.ts):

1. **Phase 1 (Atomic Reservation):** When lease acquisition begins, NOVA computes an estimated token envelope ($\text{prompt tokens} + \min(\text{max\_tokens}, \text{default\_envelope})$) and atomically deducts both 1 request from RPM and $N$ tokens from TPM.
2. **Phase 2 (Settlement & Unconsumed Refund):** Upon stream termination, the exact token count reported by upstream usage frames is evaluated. Any unconsumed reserved tokens (e.g., reserved 4,000, actual 1,120 $\rightarrow$ refund 2,880) are immediately credited back into the shard's token bucket.

## Consequences

### Positive:
- **Maximum Shard Utilization:** Accounts can safely handle $3\times$ to $5\times$ more concurrent streams without hitting artificial quota walls.
- **Continuous Sub-Millisecond Drain:** Token buckets drain smoothly on every clock tick rather than experiencing abrupt 60-second window resets.
- **Fair Multi-Tenant Quotas:** Individual tenants are prevented from consuming cluster-wide TPM pools.

### Negative:
- Requires tracking in-flight reservations across stream lifecycles.
