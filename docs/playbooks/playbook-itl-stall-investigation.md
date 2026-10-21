# Playbook: Investigating Inter-Token Latency (ITL) Stalls

This playbook details how to diagnose and resolve streaming WebSocket stalls and `HTTP 504 itl_stall_detected` errors.

---

## Symptoms & Alerts

- Client applications report streaming chat completions cutting off with error: `itl_stall_detected`.
- Prometheus metric `nova_relay_itl_stalls_total` is incrementing.
- Log message appears: `[NOVA Relay] Upstream WebSocket stalled with no token for >8s`.

---

## Root Cause Analysis Tree

```
                     [ ITL Stall Detected ]
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼                                           ▼
[ Model is Deep Reasoning ]                [ True Upstream Socket Hang ]
   (e.g., o1-preview, o3)                     (Driver freeze / dropped TCP)
          │                                           │
          ▼                                           ▼
Increase TTFT multiplier &                  Gateway correctly dropped dead
reasoning activity extension.               socket to free cluster lease.
```

---

## Triage & Remediation Steps

### 1. Verify the Requested Model
Check whether the stalled requests targeted reasoning models (e.g., `o1-preview`, `o1-mini`, `o3`):
```bash
grep "itl_stall_detected" /var/log/nova/relay.log | grep -o 'model="[^"]*"' | sort | uniq -c
```

### 2. Tune Deep Reasoning Multipliers
If reasoning models are triggering false-positive stalls during extended thinking phases:
- Increase `DEEP_REASONING_TTFT_MULTIPLIER` from `2.0` to `3.0` (extends thinking window up to 180 seconds).
- Increase `REASONING_ACTIVITY_EXTENSION_MS` from `15000` to `30000` (extends window when thinking frames are received).

### 3. Check WebSocket Dead-Peer Pings
Verify that Layer 5b WebSocket pings are functioning:
```bash
# Look for pong latency logs in debug output:
grep "WS Ping -> Pong" /var/log/nova/relay.log
```
If pong ACKs are taking $>5\text{s}$, network egress to the provider is saturated or experiencing packet loss.
