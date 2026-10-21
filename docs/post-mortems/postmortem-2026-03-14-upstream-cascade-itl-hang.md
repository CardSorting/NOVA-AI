# Post-Mortem: 2026-03-14 Upstream WebSocket Silent Stall Cascade

## Executive Summary
On March 14, 2026, an upstream AI provider suffered an internal GPU scheduling hang that caused remote WebSocket connections to remain TCP-active while halting all output token generation. Because the gateway lacked inter-token pacing guards, 256 in-flight connections stalled simultaneously. This triggered a client retry storm that exhausted global connection pools for 18 minutes.

---

## Incident Overview
- **Date:** 2026-03-14 14:22 UTC
- **Duration:** 18 minutes
- **Impact:** 100% of streaming chat completions stalled; 4,200 requests timed out on client applications.
- **Severity:** SEV-1

---

## Timeline of Events

| Time (UTC) | Event |
| :--- | :--- |
| **14:22** | Upstream provider encounters partial cluster deadlock; output tokens stop streaming. |
| **14:24** | Inbound client requests accumulate; existing flat 120s timeout keeps connections alive. |
| **14:26** | Gateway hits concurrency bulkhead ceiling; new requests queue indefinitely. |
| **14:28** | Client SDKs hit client-side timeouts and reissue requests, multiplying cluster load $3\times$. |
| **14:35** | On-call engineer manually restarts gateway pods to terminate dead sockets. |
| **14:40** | Upstream provider resolves issue; gateway returns to normal operation. |

---

## Root Cause Analysis (5 Whys)

1. **Why did the cluster stall?** The concurrency bulkhead was saturated by 256 silent in-flight requests.
2. **Why didn't the gateway drop the connections?** The TCP sockets were alive and sending TCP keepalives, so basic socket monitoring showed healthy connections.
3. **Why didn't the timeout trigger?** The system only had a flat 120-second wall-time timeout, which was too long to prevent client retry storms.
4. **Why was there no token-level monitoring?** The proxy lacked Inter-Token Latency (ITL) gap detection.
5. **What is the systemic vulnerability?** The gateway assumed that a connected TCP socket implies active LLM token synthesis.

---

## Action Items & Architectural Resolutions

1. **Implement 7-Layer Timeout Hierarchy ([ADR-0005](../adrs/ADR-0005-7-layer-websocket-timeouts.md)):**
   - Implemented Layer 2: Hard abort if no token arrives within `ITL_GAP_THRESHOLD_MS` (8s).
   - Implemented Layer 5b: Proactive WebSocket ping/pong frame validation.
2. **Durable Idempotency Hash Collapsing:**
   - Retries with identical prompt hashes now collapse into existing active streams rather than opening duplicate upstream connections.
3. **Automated Unit Testing:**
   - Added automated tests verifying ITL stall detection and stream reattachment.
