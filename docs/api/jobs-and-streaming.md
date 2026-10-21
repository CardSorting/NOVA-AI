# API Reference: Jobs & Stream Control

[Wiki Portal](../README.md) > [APIs](./README.md) > Jobs & Streaming

When the cluster is under heavy burst load or when requests are decoupled into the native `BroccoliQueue`, NOVA provides dedicated lifecycle endpoints for polling, streaming, and cancelling jobs.

---

## 1. Inspect Job Status (`GET /v1/jobs/:id`)

Retrieves the current execution status, token chunk counter, and duration of an asynchronous or in-flight job.

### Request:
```bash
curl -H "Authorization: Bearer <RELAY_API_KEY>" http://127.0.0.1:3001/v1/jobs/job_01j982a17f
```

### Response Schema:
```json
{
  "id": "job_01j982a17f",
  "status": "streaming",
  "outputChunks": 42,
  "tokensGenerated": null,
  "traceId": "tr_891238912",
  "terminal": false,
  "pollAfterMs": 2000,
  "createdAt": 1729497600,
  "durationMs": 1420,
  "streamUrl": "/v1/jobs/job_01j982a17f/stream",
  "error": null
}
```

---

## 2. Re-Attach or Resume Stream (`GET /v1/jobs/:id/stream`)

Allows clients to connect directly to the active SSE token stream of a queued or running job. Supports resuming after connection drops using `Last-Event-ID`.

### Request:
```bash
curl -N -H "Authorization: Bearer <RELAY_API_KEY>" \
  -H "Last-Event-ID: 42" \
  http://127.0.0.1:3001/v1/jobs/job_01j982a17f/stream
```

Tokens produced while the client was disconnected are replayed from the in-memory ring buffer, followed by real-time streaming of newly synthesized tokens.

---

## 3. Instant Wire Abort (`POST /v1/jobs/:id/cancel`)

Terminates an in-flight job in under 5 milliseconds:
1. Closes the upstream WebSocket socket immediately (`ws.terminate()`).
2. Clears intra-chunk and TTFT timers.
3. Releases the assigned shard back to the pool so it can serve other callers immediately.

### Request:
```bash
curl -X POST -H "Authorization: Bearer <RELAY_API_KEY>" \
  http://127.0.0.1:3001/v1/jobs/job_01j982a17f/cancel
```

### Response:
```json
{
  "id": "job_01j982a17f",
  "status": "cancelled",
  "outputChunks": 42,
  "cancellationApplied": true,
  "refundStatus": "not_managed_by_relay"
}
```
