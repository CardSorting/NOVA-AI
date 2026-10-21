# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-10-21

### Added
- **Native Infused BroccoliQueue Engine ([src/queue/](file:///Users/bozoegg/Downloads/nova/src/queue/)):**
  - Fully embedded, zero-dependency, in-process job queue engine backed by BroccoliDB tables.
  - Implemented three internal MinHeaps: *Ready Heap* (priority-based FIFO ordering), *Delayed Heap* (sub-millisecond schedule deadlines), and *Lease Heap* (sub-second worker crash detection).
  - Implemented worker lease renewal heartbeats via `context.heartbeat()` to prevent timeout recovery during long-running generative reasoning models and image generation.
  - Implemented exponential backoff retries with attempt counters and failure histories.
  - Removed external tarball dependency `"broccoli-queue"` from `package.json`, making NOVA 100% self-contained.
- **Test Suite Expansion:**
  - Added [tests/queue.test.ts](file:///Users/bozoegg/Downloads/nova/tests/queue.test.ts) covering producer batch validation, payload isolation, idempotency preservation, concurrent write flush coalescing, worker claiming, lease renewals, retries, and job pruning.
  - Test suite expanded from 17 to **23 passing tests** across 7 test suites running in under 700ms.
- **Repository Governance & Open-Source Community Suite:**
  - Added official [LICENSE](file:///Users/bozoegg/Downloads/nova/LICENSE) (MIT License).
  - Added [CONTRIBUTING.md](file:///Users/bozoegg/Downloads/nova/CONTRIBUTING.md) with comprehensive development workflows, strict architectural boundaries, and PR checklists.
  - Added [CODE_OF_CONDUCT.md](file:///Users/bozoegg/Downloads/nova/CODE_OF_CONDUCT.md) adhering to Contributor Covenant v2.1.
  - Added [SECURITY.md](file:///Users/bozoegg/Downloads/nova/SECURITY.md) detailing vulnerability reporting procedures and defense-in-depth architectural guarantees.
  - Added GitHub issue templates ([.github/ISSUE_TEMPLATE/](file:///Users/bozoegg/Downloads/nova/.github/ISSUE_TEMPLATE/)) and PR template.

### Changed
- Refactored [src/pools/pool-request-queue.ts](file:///Users/bozoegg/Downloads/nova/src/pools/pool-request-queue.ts) to natively consume `../queue/index.js`.
- Exported `BroccoliQueue` and `JobProcessor` from master library entrypoint ([src/index.ts](file:///Users/bozoegg/Downloads/nova/src/index.ts)).
- Overhauled [README.md](file:///Users/bozoegg/Downloads/nova/README.md) with deterministic HTML anchors, complete 22-route API tables, multi-language client examples, and Kubernetes deployment manifests.

---

## [1.0.0] - 2026-10-20

### Added
- **Initial Release of NOVA Substrate:**
  - Autonomous inference relay gateway and multi-account credential pooling runtime extracted from GALX.
  - **Smooth Weighted Round Robin (SWRR):** Algorithmic shard dispatch preventing quota bursts.
  - **Two-Phase Continuous Token-Bucket Governor:** Atomic quota reservation with automated unconsumed token refunding.
  - **Canary Circuit Breakers:** Transient vs. terminal error classification with single-canary half-open probing.
  - **7-Layer WebSocket Timeout Hierarchy:** Model-adaptive TTFT ceilings, EWMA Inter-Token Latency (ITL) pacing, and Cloudflare `: ping\n\n` comment heartbeats.
  - **Zero-Leak Privacy Firewall:** Full stripping of internal shard topology, diagnostic stack traces, and auth headers.
  - **Hardware-Grade AES-256-GCM Envelope Encryption:** HKDF-SHA256 derived keys bound to tenant/shard/provider AAD metadata.
  - **Distilled PostgreSQL Layer:** Replaced 159 legacy Supabase migrations with a single idempotent schema ([db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql)) and dev seed dataset ([db/seed.sql](file:///Users/bozoegg/Downloads/nova/db/seed.sql)).
  - **Unified CLI (`bin/nova.ts`):** Providing `nova relay`, `nova pool`, and `nova migrate` subcommands.
  - **TypeScript Async Client (`NovaClient`):** SSE streaming and synchronous chat completion SDK with image generation support.
