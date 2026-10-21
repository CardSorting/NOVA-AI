# Continuous Token-Bucket Rate Governance

[Wiki Portal](../README.md) > [Architecture](./README.md) > Rate Governor

The `NovaRateGovernor` implements continuous sub-millisecond rate evaluation for Requests Per Minute (RPM) and Tokens Per Minute (TPM), combined with two-phase atomic reservations and unconsumed token refunds.

---

## The Flaw of Discrete Window Limiters

Traditional rate limiters count requests in fixed 60-second windows:
- A user can send 100% of their quota at second 59, and another 100% at second 61.
- This creates massive instantaneous $2\times$ thundering surges at boundary ticks, exceeding provider leaky buckets and triggering HTTP 429 rejections.

---

## Continuous Leaky Bucket Mechanics

NOVA uses continuous clock evaluation with sub-millisecond precision:

Let:
- $C$: Maximum bucket capacity (`maxTokens`)
- $R$: Refill rate per millisecond ($\text{refillRatePerMinute} / 60,000$)
- $T_{\text{last}}$: Timestamp of previous evaluation
- $B_{\text{remaining}}$: Current remaining token balance

Upon evaluation at timestamp $T_{\text{now}}$:

$$\Delta t = \max(0, T_{\text{now}} - T_{\text{last}})$$

$$B_{\text{remaining}} \leftarrow \min(C, B_{\text{remaining}} + (\Delta t \times R))$$

$$T_{\text{last}} \leftarrow T_{\text{now}}$$

If the requested tokens $K \le B_{\text{remaining}}$, the request is granted and $B_{\text{remaining}} \leftarrow B_{\text{remaining}} - K$. Otherwise, the caller is throttled with a precise `Retry-After` duration:

$$\text{waitMs} = \left\lceil \frac{K - B_{\text{remaining}}}{R} \right\rceil$$

---

## Two-Phase Atomic Reservation & Refund

Because generative LLM streams do not reveal their completion token count upfront, NOVA splits token metering into two deterministic phases:

```
[ Inbound Request ]
        │
        ▼ Phase 1: Atomic Reservation
Reserve: prompt_tokens + min(max_tokens, default_envelope)
        │
        ▼ Active Inference Stream
Upstream streams delta tokens...
        │
        ▼ Phase 2: Unconsumed Refund
Stream finishes with actual_tokens_consumed
Refund: max(0, reserved_tokens - actual_tokens_consumed)
Credit directly back to shard bucket!
```

### Numerical Example:
1. Caller submits a query with 300 prompt tokens and requests `max_tokens: 4000`.
2. **Phase 1:** NOVA reserves $300 + 4000 = 4300$ tokens from the shard's continuous bucket.
3. The LLM generates a concise answer consuming only 250 completion tokens.
4. Total actual tokens used: $300 + 250 = 550$ tokens.
5. **Phase 2:** NOVA immediately refunds $4300 - 550 = \mathbf{3750\text{ tokens}}$ back to the shard's available balance.
6. **Result:** Other concurrent requests can immediately utilize the 3,750 refunded tokens without waiting for the minute to roll over.

---

## Sliding 3-Hour Quota Health Log

In addition to per-minute leaky buckets, each shard tracks a rolling 3-hour sliding window of calls and tokens:
- Evaluates historical degradation patterns before provider quotas are breached.
- If a shard approaches 95% of its 3-hour rolling ceiling, SWRR gracefully reduces its effective weight, shifting ingress to fresher accounts.
