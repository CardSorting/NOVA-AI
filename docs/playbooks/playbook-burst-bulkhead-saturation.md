# Playbook: Managing Surge Bulkhead Decoupling (HTTP 202 Accepted)

This playbook explains how to manage traffic surges when the concurrency bulkhead is saturated and requests are decoupled into the asynchronous queue.

---

## Symptoms & Behavior

- Inbound requests to `POST /v1/chat/completions` receive:
  ```http
  HTTP/1.1 202 Accepted
  Content-Type: application/json

  {
    "id": "job_01j982a17f",
    "status": "queued",
    "model": "gpt-4o",
    "streamUrl": "/v1/jobs/job_01j982a17f/stream"
  }
  ```
- Prometheus metric `nova_relay_bulkhead_saturated_total` increments.

> [!NOTE]
> `HTTP 202 Accepted` is **intended behavior** under burst load. NOVA dynamically decouples incoming requests into the native BroccoliQueue rather than dropping them with `HTTP 503` or blocking client TCP sockets.

---

## Client Handling

Standard clients using the `NovaClient` SDK automatically handle `HTTP 202 Accepted` by reattaching to the `streamUrl` and receiving tokens as soon as a worker claims the job:

```typescript
// NovaClient automatically waits and streams queued jobs:
for await (const chunk of client.chatStream({ model: 'gpt-4o', messages: [...] })) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

## Operator Triage & Capacity Adjustment

If you need to increase real-time synchronous throughput:

1. **Verify Memory Headroom:**
   Ensure current RSS memory usage is well below `RELAY_MAX_RSS_MB`.
2. **Increase Concurrency Bulkhead:**
   Update `RELAY_MAX_CONCURRENT_REQUESTS` in your environment:
   ```bash
   RELAY_MAX_CONCURRENT_REQUESTS=128
   ```
3. **Scale Shard Workers in BroccoliQueue:**
   In [src/pools/pool-request-queue.ts](file:///Users/bozoegg/Downloads/nova/src/pools/pool-request-queue.ts), worker concurrency can be tuned:
   ```typescript
   instance.workers.push(
     process(TEXT_QUEUE, 16), // Increased from 8 to 16
     process(IMAGE_QUEUE, 8), // Increased from 4 to 8
   );
   ```
