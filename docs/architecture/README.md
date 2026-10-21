# Architecture & Substrates Deep Dive

[Wiki Portal](../README.md) > Architecture Deep Dive

This directory provides mathematical, systemic, and cryptographic deep dives into NOVA's core routing and governance substrates.

---

<a id="architecture-topics"></a>
## 🏛️ Architecture Topics

| Document | Core Concepts & Focus |
| :--- | :--- |
| **[Request Lifecycle & Dataflow](./dataflow-and-lifecycle.md)** | Northbound HTTP ingress, prompt hashing, lease acquisition, WebSocket streaming, and settlement. |
| **[Standalone Substrate & Process Topology](./standalone-daemon-substrate.md)** | Autonomous out-of-process daemon model, producer-consumer roles, and anti-pattern analysis of in-process embedding. |
| **[Smooth Weighted Round Robin (SWRR)](./smooth-weighted-round-robin.md)** | Mathematical formulation, variance minimization, dynamic weight throttling, and burst prevention. |
| **[Continuous Token Bucket Rate Governor](./rate-governor-leaky-bucket.md)** | Continuous microsecond drain, two-phase atomic reservations, sliding 3-hour quota logs, and unconsumed refunds. |
| **[7-Layer WebSocket Timeout Hierarchy](./7-layer-timeout-hierarchy.md)** | Layer 0 through Layer 6 breakdown, EWMA Inter-Token Latency (ITL) pacing, and reasoning model extensions. |
| **[BroccoliQueue 3-MinHeap Engine](./broccoliqueue-minheaps.md)** | Priority Ready Heap, Delayed Heap, Lease Heap, worker lease renewals, and crash-resilient WAL persistence. |
| **[Distilled PostgreSQL Relational Substrate](./distilled-postgresql-substrate.md)** | Monotonic fencing tokens, stored procedures (`relay_execution`, `relay_control`), and zero-bloat relational design. |
| **[Cryptographic Vault & Envelope Encryption](./cryptographic-vault-envelope-encryption.md)** | AES-256-GCM envelope encryption, HKDF key derivation, and multi-tenant AAD isolation. |


---

<a id="system-topology-overview"></a>
## 🌐 System Topology Overview

```
[ External Caller (cURL / Python / Node / OpenAI SDK) ]
                       │
                       ▼ HTTP/1.1 or HTTP/2
┌─────────────────────────────────────────────────────────────┐
│              NOVA RELAY GATEWAY (Port 3001)                 │
│                                                             │
│   Timing-Safe Auth  ──►  Concurrency Bulkhead (64)          │
│          │                                                  │
│          ▼                                                  │
│   Prompt Deduplication (SHA-256 Idempotency)                │
│          │                                                  │
│          ▼                                                  │
│   Zero-Leak Privacy Firewall (Header & Trace Stripping)     │
└──────────────────────────────┬──────────────────────────────┘
                               │ Internal Protocol
                               ▼
┌─────────────────────────────────────────────────────────────┐
│          NOVA RESOURCE POOL SUBSTRATE (Port 3000)           │
│                                                             │
│   Smooth Weighted Round Robin (SWRR) Shard Balancer         │
│          │                                                  │
│          ▼                                                  │
│   Two-Phase Continuous Leaky Bucket (RPM & TPM)             │
│          │                                                  │
│          ▼                                                  │
│   Canary Circuit Breaker & Outlier Isolation                │
│          │                                                  │
│          ▼                                                  │
│   Infused BroccoliQueue (3 MinHeaps & WAL Persistence)      │
│          │                                                  │
│          ▼                                                  │
│   PostgreSQL / Memory Execution Store (Fenced Leases)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ Secure WebSocket Stream
                               ▼
            [ Upstream Shard Fleet Accounts ]
```
