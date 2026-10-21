# Smooth Weighted Round Robin (SWRR)

[Wiki Portal](../README.md) > [Architecture](./README.md) > Smooth Weighted Round Robin

Smooth Weighted Round Robin (SWRR) is the load-balancing algorithm utilized by `NovaCredentialPool` to schedule requests across heterogeneous upstream AI accounts without causing burst quota exhaustion.

---

## The Problem: Burst Clustering in Classic Balancers

Suppose a cluster pools two upstream accounts with different rate limits:
- **Shard A:** Weight 5 (Enterprise Tier)
- **Shard B:** Weight 1 (Standard Tier)

A naive or classic weighted round-robin scheduler produces the sequence:
$$\text{Sequence: } \mathbf{A - A - A - A - A - B}$$

In generative AI streaming, sending 5 high-throughput requests concurrently to Shard A rapidly exhausts the provider's instantaneous per-second token bucket, causing immediate `HTTP 429 Too Many Requests` rejections even though Shard B was completely idle.

---

## Mathematical Formulation

NOVA implements **Nginx Smooth Weighted Round Robin**:

Let $N$ be the number of active candidate shards. Each shard $i$ possesses:
- $\text{effectiveWeight}_i$: Configured capacity weight (dynamically throttled under transient errors).
- $\text{currentWeight}_i$: Dynamic state variable initialized to 0.

### Algorithm Steps:

1. **Weight Accumulation:** For every candidate shard $i \in \{1, \dots, N\}$:
   $$\text{currentWeight}_i \leftarrow \text{currentWeight}_i + \text{effectiveWeight}_i$$

2. **Selection:** Choose candidate $k$ with the maximum current weight:
   $$k = \arg\max_{i} (\text{currentWeight}_i)$$

3. **Weight Deduction:** Deduct the total sum of all effective weights from the selected shard:
   $$\text{currentWeight}_k \leftarrow \text{currentWeight}_k - \sum_{j=1}^{N} \text{effectiveWeight}_j$$

---

## State Progression Simulation

For Shards $\{A: 5, B: 1\}$, total weight sum is $5 + 1 = 6$:

| Request | Initial Current Weights | Added Effective Weights | Weights After Addition | Selected Shard | Deduct Sum (6) | Final Current Weights |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **#1** | $\{A: 0, B: 0\}$ | $\{+5, +1\}$ | $\{A: 5, B: 1\}$ | **A** | $A: 5 - 6 = -1$ | $\{A: -1, B: 1\}$ |
| **#2** | $\{A: -1, B: 1\}$ | $\{+5, +1\}$ | $\{A: 4, B: 2\}$ | **A** | $A: 4 - 6 = -2$ | $\{A: -2, B: 2\}$ |
| **#3** | $\{A: -2, B: 2\}$ | $\{+5, +1\}$ | $\{A: 3, B: 3\}$ | **A** | $A: 3 - 6 = -3$ | $\{A: -3, B: 3\}$ |
| **#4** | $\{A: -3, B: 3\}$ | $\{+5, +1\}$ | $\{A: 2, B: 4\}$ | **B** | $B: 4 - 6 = -2$ | $\{A: 2, B: -2\}$ |
| **#5** | $\{A: 2, B: -2\}$ | $\{+5, +1\}$ | $\{A: 7, B: -1\}$ | **A** | $A: 7 - 6 = 1$ | $\{A: 1, B: -1\}$ |
| **#6** | $\{A: 1, B: -1\}$ | $\{+5, +1\}$ | $\{A: 6, B: 0\}$ | **A** | $A: 6 - 6 = 0$ | $\{A: 0, B: 0\}$ |

Resulting Dispatch Sequence:
$$\mathbf{A \rightarrow A \rightarrow A \rightarrow B \rightarrow A \rightarrow A}$$

Notice that Shard B is placed directly into the middle of the sequence rather than clustered at the end, providing smooth, perfectly interleaved dispatch.

---

## Dynamic Fault Throttling

When a shard encounters transient network errors (e.g. HTTP 502 or ITL stall):
1. Its `effectiveWeight` is temporarily decremented by 1.
2. If failures continue, `effectiveWeight` approaches 0, reducing the rate at which requests are admitted to that shard.
3. Once the shard admits a successful canary request, its `effectiveWeight` is restored to its full configured value.
