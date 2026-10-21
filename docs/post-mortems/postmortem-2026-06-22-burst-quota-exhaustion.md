# Post-Mortem: 2026-06-22 Tier-1 Burst Quota Exhaustion

## Executive Summary
On June 22, 2026, a morning traffic burst triggered cascading `HTTP 429 Rate Limit Exceeded` rejections across the primary enterprise OpenAI account. The gateway's classic round-robin algorithm dispatched contiguous batches of 10 requests to the primary shard before rotating, instantly exhausting provider-side per-second burst tokens.

---

## Incident Overview
- **Date:** 2026-06-22 09:15 UTC
- **Duration:** 12 minutes
- **Impact:** 28% of incoming requests received `HTTP 429`; downstream client retries briefly doubled ingress volume.
- **Severity:** SEV-1

---

## Timeline of Events

| Time (UTC) | Event |
| :--- | :--- |
| **09:15** | Peak morning traffic burst begins ($450\text{ req/sec}$). |
| **09:16** | Classic weighted balancer sends 10 consecutive requests to Shard 1. |
| **09:17** | Upstream provider responds with `HTTP 429` (per-second burst limit breached). |
| **09:18** | Circuit breaker marks Shard 1 failed; remaining traffic overflows to secondary shards. |
| **09:19** | Secondary shards saturate and trip their own rate limits. |
| **09:22** | Operators manually add emergency API keys and increase rate limits. |
| **09:27** | Traffic stabilizes; all shards return to service. |

---

## Root Cause Analysis (5 Whys)

1. **Why did Shard 1 return 429?** It received more tokens/sec than the provider's instantaneous leaky bucket allowed.
2. **Why did it receive too many requests at once?** The round-robin algorithm grouped Shard 1 selections together rather than interleaving them across shards.
3. **Why weren't tokens refunded?** The system reserved full pessimistic `max_tokens` (4,000) for every request and never refunded unconsumed tokens when requests finished early.
4. **Why did other shards cascade into failure?** When Shard 1 failed, 100% of traffic immediately hit lower-capacity fallback shards with zero smoothing.
5. **What is the systemic vulnerability?** Discrete, naive load balancing and static token accounting are fundamentally unsuited for high-burst LLM workloads.

---

## Action Items & Architectural Resolutions

1. **Adopt Smooth Weighted Round Robin ([ADR-0001](../adrs/ADR-0001-swrr-credential-pooling.md)):**
   - Completely eliminates burst clustering by smoothly interleaving dispatch sequences ($A-A-B-A-A-C-A$).
2. **Two-Phase Continuous Token Refunds ([ADR-0002](../adrs/ADR-0002-continuous-token-buckets.md)):**
   - Automatically credits unconsumed reserved tokens back to the shard's bucket upon stream completion.
3. **Canary Circuit Breaker with Exponential Jitter:**
   - Quarantined shards recover with single-canary probes rather than sudden thundering herds.
