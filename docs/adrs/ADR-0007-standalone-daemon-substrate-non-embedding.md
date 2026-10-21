# ADR-0007: Standalone Daemon Substrate Model & Prohibition of In-Process Embedding

## Status
**Accepted** (2026-10-21)

---

## Context

NOVA was conceived and implemented as a high-throughput, deterministic autonomous inference relay gateway and credential scheduling engine. In large enterprise environments and multi-service topologies, there is frequent temptation among engineers to "embed" infrastructure pipelines directly inside client applications—such as embedding the relay gateway into a Next.js web application, bundling it into an Electron desktop client, or importing it as an internal library within a customer-facing product monolith.

Embedding infrastructure-level inference routers, priority queues, and cryptographic credential vaults directly inside a consumer-facing product layer introduces fatal architectural flaws:
1. **Coupled Blast Radii:** An unhandled exception, high garbage collection pause, or crash in the host product application directly terminates the inference relay and drops active streaming WebSocket connections. Conversely, high-throughput inference token processing exhausts the host application's Node.js event loop.
2. **Credential & Secret Transposition:** Embedding credential vaults inside client application bundles risks accidental leakage of master vault keys (`$GALX_VAULT_KEY`) or upstream shard tokens to client-side runtimes, debug logs, or browser bundles.
3. **Scope Creep & Feature Pollution:** When infrastructure is embedded into a product, product-specific logic (user sessions, billing checkouts, UI components, application schemas) inevitably pollutes the infrastructure codebase.
4. **Horizontal Scaling Bottlenecks:** A relay gateway requires horizontal scaling based on network I/O concurrency and WebSocket count, whereas product layers scale based on user page views and business transactions. Coupling them prevents independent autoscaling.

---

## Decision

We formally establish that **NOVA is an Autonomous, Out-of-Process Infrastructure Substrate** and **MUST NEVER BE EMBEDDED DIRECTLY INTO ANOTHER PRODUCT LAYER**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       EXTERNAL PRODUCT APPLICATIONS                         │
│   (Web Apps, Next.js, AI Agents, Microservices, Worker Services)            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Standard Wire Protocols
                                       │ (HTTP/1.1, HTTP/2, SSE, WebSockets)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     NOVA STANDALONE DAEMON SUBSTRATE                        │
│                                                                             │
│  • Autonomous Process / Container (port 3001)                               │
│  • Producer & Consumer of Inference Requests & Background Jobs              │
│  • Independent Memory Bulkhead & 3-MinHeap Priority Queues                  │
│  • Isolated Hardware-Grade AES-256-GCM Credential Vault                     │
│  • Distilled PostgreSQL State Store                                         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Secure Upstream Wire
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      UPSTREAM INFERENCE PROVIDERS                           │
│   (OpenAI, Anthropic, Custom Shard Fleet)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Independent Process Isolation:** NOVA runs exclusively as a standalone process (via CLI, Docker/OCI container, Kubernetes Pod, or Systemd service).
2. **Strict Wire Protocol Boundary:** Applications interact with NOVA strictly over standard network protocols:
   - Synchronous & Streaming Inference: `POST /v1/chat/completions` (Server-Sent Events)
   - Decoupled Asynchronous Jobs: `POST /v1/chat/completions` (HTTP 202 Accepted) $\rightarrow$ `GET /v1/jobs/:id`
   - Image Generations: `POST /v1/images/generations`
   - Observability & Metrics: `GET /metrics`
3. **Producer & Consumer Architecture:** NOVA acts as an autonomous producer and consumer:
   - It ingests requests from external producer applications.
   - It enqueues, schedules, and leases credentials autonomously.
   - It executes inferences against upstream providers and produces streaming or persisted token outputs.
4. **Prohibition of In-Process Embedding:** Pull requests attempting to export internal runtime singletons for in-process embedding in foreign products, or introducing UI frameworks, client state managers, or consumer billing schemas, will be rejected.

---

## Consequences

### Positive Benefits
- **Zero Blast Radius Contamination:** Host application crashes or memory leaks cannot degrade the inference gateway, and heavy LLM token streaming does not saturate the host product's event loop.
- **Independent Scaling & Autoscaling:** NOVA instances scale independently using CPU and active WebSocket metrics, while product services scale on HTTP request volumes.
- **Architectural Simplicity & Purity:** NOVA maintains a hyper-focused mission: low-latency, deterministic, resilient inference routing and queue management.
- **Strict Security Boundaries:** Master cryptographic keys and shard tokens never leave the secure process boundary of the NOVA daemon.

### Negative / Trade-Offs
- **Network Boundary Overhead:** Calls between the host application and NOVA incur network hop latency (typically $< 0.4$ ms over `localhost` or internal VPC networks). This trade-off is minor compared to the massive gains in reliability and security.
- **Deployment Topology Requirement:** Deployers must run NOVA as a separate container or sidecar service rather than installing an npm package inside their existing frontend application.
