# 7-Layer WebSocket Timeout Hierarchy

[Wiki Portal](../README.md) > [Architecture](./README.md) > 7-Layer Timeouts

Streaming LLM inference over WebSockets exhibits severe failure modes that cannot be addressed with a single flat timeout. NOVA implements a defense-in-depth hierarchy comprising seven specialized timeout layers.

---

## The 7-Layer Defense Matrix

```
┌────────────────────────────────────────────────────────────────────────┐
│                        LAYER 6: JOB WALL-TIME                          │
│               Absolute Safety Ceiling (Default: 300,000ms)             │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              LAYER 1: TIME-TO-FIRST-TOKEN (TTFT)                 │  │
│  │     Base: 60,000ms  │  Reasoning Multiplier: 2.0x (120,000ms)    │  │
│  │  ┌────────────────────────────────────────────────────────────┐  │  │
│  │  │              LAYER 2: INTER-TOKEN LATENCY (ITL)            │  │  │
│  │  │     Stall Gap: 8,000ms  │  Consecutive Stalls: 3 Max       │  │  │
│  │  │  ┌──────────────────────────────────────────────────────┐  │  │  │
│  │  │  │            LAYER 3: INTRA-CHUNK SILENCE              │  │  │  │
│  │  │  │       Resets on EVERY chunk (Default: 45,000ms)      │  │  │  │
│  │  │  └──────────────────────────────────────────────────────┘  │  │  │
│  │  └────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────┐    ┌──────────────────────────────┐  │
│  │   LAYER 4: DISCONNECT GRACE  │    │  LAYER 5: HEARTBEAT & PING   │  │
│  │   Wi-Fi handoff: 15,000ms    │    │  SSE: 15s  │  WS Ping: 20s   │  │
│  └──────────────────────────────┘    └──────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Layer Specifications

### Layer 0: Handshake & Connection Timeout (`WS_CONNECT_TIMEOUT_MS`)
- **Default:** `15,000ms` (15s)
- **Scope:** Covers TCP three-way handshake, TLS negotiation, and HTTP-to-WebSocket upgrade headers.
- **Action on Timeout:** If the upstream connection fails to emit `open` within 15 seconds, the socket is immediately destroyed (`ws.terminate()`) and the request is failed over to the next candidate shard.

### Layer 1: Time-To-First-Token Ceiling (`WS_TTFT_TIMEOUT_MS`)
- **Default:** `60,000ms` (60s)
- **Deep Reasoning Multiplier (`DEEP_REASONING_TTFT_MULTIPLIER`):** `2.0` ($120\text{s}$)
- **Reasoning Activity Extension (`REASONING_ACTIVITY_EXTENSION_MS`):** `15,000ms`
- **Scope:** Measures elapsed time from payload dispatch until the first token or reasoning chunk arrives. High-effort reasoning models (e.g. OpenAI o1/o3) automatically receive extended TTFT budgets.

### Layer 2: Inter-Token Latency (ITL) Gap Monitoring
- **Threshold (`ITL_GAP_THRESHOLD_MS`):** `8,000ms` (8s)
- **Limit (`ITL_CONSECUTIVE_LIMIT`):** `3`
- **Scope:** Tracks latency gaps between consecutive output tokens using Exponential Weighted Moving Average (EWMA). If generation freezes mid-sentence for $>8\text{s}$, a stall is recorded. After 3 consecutive stalls, the stream is aborted with `HTTP 504 itl_stall_detected`.

### Layer 3: Intra-Chunk Silence Timeout (`WS_INTRA_CHUNK_TIMEOUT_MS`)
- **Default:** `45,000ms` (45s)
- **Scope:** The maximum allowable silence window between data chunks. **Critically, this timer resets upon every received token chunk**, guaranteeing that long-running outputs never hit arbitrary execution caps as long as tokens are actively flowing.

### Layer 4: Client Disconnect Grace Window (`CLIENT_DISCONNECT_GRACE_MS`)
- **Default:** `15,000ms` (15s)
- **Scope:** If a downstream client drops its TCP connection (e.g., cellular handoff, switching from LTE to Wi-Fi), the upstream inference job continues running for 15 seconds. If the client reconnects with its `Last-Event-ID` within this window, the stream resumes seamlessly without losing tokens or double-billing.

### Layer 5: Keepalives & Dead-Peer Detection
- **SSE Keepalive Comments (`SSE_KEEPALIVE_INTERVAL_MS`):** `15,000ms`
  - Emits `: ping\n\n` comments over the downstream SSE stream, preventing Cloudflare and intermediate load balancers from dropping the connection after 100 seconds of silence.
- **WebSocket Dead-Peer Pings (`WS_DEAD_PEER_PING_INTERVAL_MS`):** `20,000ms`
  - Transmits outbound WebSocket ping frames with full jitter. If a pong ACK is not received within 5 seconds (`WS_DEAD_PEER_PONG_TIMEOUT_MS`), the dead socket is forcefully terminated.

### Layer 6: Absolute Job Wall-Time Ceiling (`JOB_MAX_WALL_TIME_MS`)
- **Default:** `300,000ms` (5 minutes)
- **Scope:** Hard circuit-breaker ceiling protecting cluster resources against runaway infinite-generation loops.
