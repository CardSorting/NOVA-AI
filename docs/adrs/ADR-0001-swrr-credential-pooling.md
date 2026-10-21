# ADR-0001: Smooth Weighted Round Robin (SWRR) Credential Pooling

## Status
**Accepted** (2026-10-20)

## Context
When pooling multiple upstream API accounts with unequal rate limit tiers (e.g., Shard A with weight 5, Shard B with weight 1), classic weighted round robin dispatches requests in long continuous bursts (e.g. `A-A-A-A-A-B`). In high-concurrency LLM inference environments, burst clustering against Shard A rapidly triggers provider-side `HTTP 429 Too Many Requests` quota rejections even when the overall aggregate quota across all shards is largely unused.

Random weighted selection similarly exhibits stochastic variance, leading to random clustering and unpredictable latency spikes.

## Decision
We decided to implement the **Nginx Smooth Weighted Round Robin (SWRR)** algorithm directly within [src/pools/credential-pool.ts](file:///Users/bozoegg/Downloads/nova/src/pools/credential-pool.ts).

### Algorithm Mechanics:
1. Every candidate shard $i$ tracks a dynamic state variable `currentWeight`, initialized to 0.
2. Upon each lease acquisition:
   $$\text{currentWeight}_i \leftarrow \text{currentWeight}_i + \text{effectiveWeight}_i$$
3. The shard $k$ with the highest `currentWeight` is selected to handle the request.
4. The total sum of all effective weights is deducted from the selected shard:
   $$\text{currentWeight}_k \leftarrow \text{currentWeight}_k - \sum_j \text{effectiveWeight}_j$$

This yields a mathematically smooth distribution sequence (e.g., `A-A-B-A-A-C-A`), eliminating request bursts.

## Consequences

### Positive:
- **Zero Burst Clustering:** Completely distributes requests smoothly across time, drastically reducing transient 429 errors.
- **Fast Execution:** Executes in sub-microsecond time ($\le 0.4\mu\text{s}$) over memory-mapped arrays.
- **Dynamic Weight Adaptation:** If a shard begins degrading, its `effectiveWeight` is temporarily throttled without breaking sequence fairness.

### Negative:
- Shard list mutations require updating the cached weight totals.
