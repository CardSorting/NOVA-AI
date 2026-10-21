# Native BroccoliQueue Engine & Three MinHeaps

[Wiki Portal](../README.md) > [Architecture](./README.md) > BroccoliQueue Engine

NOVA natively embeds **BroccoliQueue** ([src/queue/](file:///Users/bozoegg/Downloads/nova/src/queue/)), providing high-throughput, crash-resilient in-process job queueing without external Redis or BullMQ dependencies.

---

## The Three MinHeaps Architecture

At the heart of BroccoliQueue's sub-millisecond dispatch performance are three in-memory priority MinHeaps:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BROCCOLIQUEUE SCHEDULER                         │
│                                                                        │
│  ┌───────────────────────┐ ┌──────────────────────┐ ┌───────────────┐  │
│  │      READY HEAP       │ │     DELAYED HEAP     │ │  LEASE HEAP   │  │
│  │ priority DESC, seq ASC│ │   availableAt ASC    │ │leaseExpiry ASC│  │
│  │ O(1) Highest Priority │ │  O(log N) Deadlines  │ │Crash Recovery │  │
│  └───────────┬───────────┘ └──────────┬───────────┘ └───────┬───────┘  │
└──────────────┼────────────────────────┼─────────────────────┼──────────┘
               │                        │                     │
               ▼                        ▼                     ▼
      [ Worker Dispatch ]      [ Scheduled Delays ]   [ Lease Sweeper ]
```

### 1. Ready Heap
- **Ordering Criterion:** `priority DESC, sequence ASC`
- **Function:** Orders available jobs ready for immediate dispatch. Jobs with higher priority are popped first; jobs with identical priority preserve strict FIFO arrival order.
- **Complexity:** $O(1)$ peek, $O(\log N)$ push and pop.

### 2. Delayed Heap
- **Ordering Criterion:** `availableAt ASC`
- **Function:** Holds jobs scheduled for future execution or retrying under exponential backoff.
- **Maintenance Loop:** Periodically inspects root node. When `availableAt <= Date.now()`, the job is migrated to the *Ready Heap*.

### 3. Lease Heap
- **Ordering Criterion:** `leaseExpiresAt ASC`
- **Function:** Tracks active jobs currently being executed by workers.
- **Crash Recovery:** If a worker crashes or fails to renew its lease before `leaseExpiresAt`, the lease sweeper pops the expired entry and re-queues it for recovery.

---

## In-Process Worker Heartbeats (`context.heartbeat()`)

Long-running generative AI tasks (such as deep reasoning or high-resolution image generation) create a fundamental queue dilemma:
- If worker lease durations are set long (e.g., 5 minutes), crashed worker recovery takes up to 5 minutes, stalling customer traffic.
- If worker lease durations are set short (e.g., 15 seconds), slow generations are erroneously treated as crashed jobs and double-executed.

### The Heartbeat Solution:
Workers are provisioned with short lease windows (default: 30s). During execution, workers periodically issue heartbeats:

```typescript
queue.process('inference_tasks', async (job, context) => {
  // During long generation chunks:
  await context.heartbeat(); // Extends lease in Lease Heap by +30s!

  return { status: 'completed' };
}, { concurrency: 8, leaseDurationMs: 30_000 });
```

This guarantees that:
1. Actively running inference jobs remain locked indefinitely.
2. Truly crashed processes are reclaimed in $<30\text{ seconds}$.

---

## Write-Ahead-Log (WAL) Persistence & Replay

All state mutations (enqueue, claim, complete, fail, prune) are written to an append-only WAL backed by BroccoliDB tables:
- **Zero Corruption:** Flushes are atomic and frame-delimited.
- **Crash Recovery:** When the gateway restarts, WAL frames are read sequentially, re-populating the three MinHeaps in $<20\text{ms}$.
- **Retention & Pruning:** Completed jobs are retained for `retentionMs` (default: 1 hour) for telemetry and receipt auditing before automated vacuuming.
