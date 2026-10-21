# ADR-0003: Native Infused BroccoliQueue Engine (Zero Redis/BullMQ)

## Status
**Accepted** (2026-10-21)

## Context
Decoupled request queueing is essential when ingress spikes saturate available concurrent shard connections. Standard industry architectures commonly mandate external queue services like Redis, BullMQ, RabbitMQ, or AWS SQS.

However, requiring external Redis infrastructure causes:
- Operational complexity: Requires managing and monitoring additional stateful network daemons.
- Network latency penalty: Adds 2ms–10ms per job enqueue and dequeue.
- Risk of dependency mismatch: External package updates or network partitions can stall the inference gateway.

## Decision
We natively infused the high-throughput, in-process **BroccoliQueue** engine directly into [src/queue/](file:///Users/bozoegg/Downloads/nova/src/queue/), backed by BroccoliDB tables and append-only write-ahead-logs (WAL).

### Architectural Implementation:
- **Three MinHeaps:**
  - *Ready Heap:* $O(1)$ dispatch by priority and FIFO insertion sequence.
  - *Delayed Heap:* $O(\log N)$ delay timers for scheduled jobs.
  - *Lease Heap:* $O(\log N)$ lease tracking for sub-second crash recovery.
- **Worker Heartbeats (`context.heartbeat()`):** Long-running generative tasks renew their active leases, preventing premature worker recovery.
- **Pure Backend Engine:** 100% headless; zero HTML, browser, or UI dependencies.

## Consequences

### Positive:
- **Zero External Dependencies:** NOVA runs out of the box with zero external infrastructure to provision or configure.
- **Crash Resilience:** WAL frames are replayed with checksum verification upon process restart.
- **Deterministic Idempotency:** Derives stable deduplication hashes across namespaces and job keys.

### Negative:
- In-process memory footprint scales with maximum retained terminal jobs (capped by default to 4 retained jobs).
