# ADR-0005: 7-Layer WebSocket Timeout Hierarchy & ITL Pacing

## Status
**Accepted** (2026-10-20)

## Context
Streaming LLM completions over WebSockets present unique timeout failure modes:
- **Silent Upstream Stalls:** The remote WebSocket server stays open, but token generation halts indefinitely (deadlock or GPU driver hang).
- **Deep Reasoning Delays:** Models like OpenAI o1 or o3 spend up to 90 seconds thinking before generating the first token, causing naive 15s or 30s timeouts to abort healthy jobs.
- **Intermediary Drops:** Reverse proxies like Cloudflare automatically drop idle HTTP connections after 100 seconds if no bytes or SSE comments are transmitted.

A single flat timeout value is fundamentally insufficient.

## Decision
We implemented a **7-Layer Timeout Hierarchy** in [src/relay/relay-server.ts](file:///Users/bozoegg/Downloads/nova/src/relay/relay-server.ts):

| Layer | Name | Default | Purpose |
| :--- | :--- | :--- | :--- |
| **Layer 0** | Handshake Timeout | `15,000ms` | Hard ceiling for TCP, TLS, and WebSocket upgrade. |
| **Layer 1** | Time-To-First-Token | `60,000ms` | Baseline ceiling for initial token arrival. |
| **Layer 1b**| Deep Reasoning Multiplier | `2.0` ($120\text{s}$) | Extended TTFT for high-effort reasoning models. |
| **Layer 2** | Inter-Token Latency (ITL) Gap | `8,000ms` | Triggers stall detection when inter-token arrival pauses. |
| **Layer 2b**| ITL Consecutive Limit | `3` | Hard stream termination after 3 consecutive stalls. |
| **Layer 3** | Intra-Chunk Timeout | `45,000ms` | Max silence between chunks; resets on every received token. |
| **Layer 4** | Disconnect Grace Window | `15,000ms` | Grace period for client cellular or Wi-Fi handoffs. |
| **Layer 5** | Keepalive Comment Pings | `15,000ms` | Emits `: ping\n\n` comments to defeat Cloudflare 100s timeouts. |
| **Layer 6** | Job Wall-Time Ceiling | `300,000ms` | Absolute safety ceiling for any single job. |

## Consequences

### Positive:
- **Instant Stall Recovery:** Upstream hangs are detected and terminated in under 8 seconds instead of hanging for minutes.
- **Support for Deep Reasoning:** o1/o3 reasoning models are granted appropriate thinking windows without false aborts.
- **Zero Socket Leaks:** Dead connections are aggressively pruned via `ws.terminate()`.

### Negative:
- Requires tracking multiple nested timers per in-flight session.
