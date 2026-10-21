# NOVA Knowledge Base & Engineering Wiki

<div align="center">

```
 _   _  _____  _   _   ___  
| \ | ||  _  || | | | / _ \ 
|  \| || | | || | | |/ /_\ \
| . ` || | | || | | ||  _  |
| |\  |\ \_/ /\ \_/ /| | | |
\_| \_/ \___/  \___/ \_| |_/
```

### Architectural Decisions, Operational Runbooks, Setup Guides & Triage Playbooks

*The authoritative source of truth for operating, extending, and debugging the NOVA autonomous inference relay gateway.*

---

[![Documentation Gate](https://img.shields.io/badge/docs--gate-passing-brightgreen.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/scripts/lint-docs.ts)
[![Maintainers](https://img.shields.io/badge/Maintainers-Governance%20%26%20SOPs-purple.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/maintainers)
[![Architecture Guides](https://img.shields.io/badge/Architecture-7%20Guides-blue.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/architecture)
[![API Reference](https://img.shields.io/badge/APIs-5%20Endpoints-orange.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/api)
[![ADRs](https://img.shields.io/badge/ADRs-6%20Accepted-blueviolet.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/adrs)
[![Runbooks](https://img.shields.io/badge/Runbooks-4%20Operational-emerald.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/runbooks)
[![Playbooks](https://img.shields.io/badge/Playbooks-3%20Triage-purple.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/playbooks)
[![Observability](https://img.shields.io/badge/Observability-Prometheus%20%2B%20Telemetry-darkred.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/observability)

</div>

---

<a id="wiki-index"></a>
## 📚 Knowledge Base Index

| Section | Target Audience | Primary Focus |
| :--- | :--- | :--- |
| 🚀 **[Setup & Startup Directory](./setup/README.md)** | Developers, DevOps, SRE | Local setup, Kubernetes clustering, PostgreSQL migrations, and AES-256 vault bootstrapping. |
| 🏛️ **[Architecture Deep Dives](./architecture/README.md)** | Architects, Systems Engineers | Technical specifications for SWRR, continuous token buckets, BroccoliQueue MinHeaps, and timeouts. |
| 🔌 **[Gateway API Reference](./api/README.md)** | Application Developers | Comprehensive specs for `/v1/chat/completions`, `/v1/images/generations`, and async decoupled job streams. |
| 📊 **[Observability & Metrics](./observability/README.md)** | SRE, Platform Ops | Prometheus metrics catalog, alerting rules, and real-time latency telemetry (TTFT & ITL percentiles). |
| 📦 **[Client SDKs & Multi-Language](./sdks/README.md)** | Software Engineers | Native `NovaClient` TypeScript SDK, Python `openai`, LangChain, and raw HTTP/cURL wire examples. |
| 📑 **[Architecture Decision Records (ADRs)](./adrs/README.md)** | Technical Leadership | Decision records detailing context, rationales, and consequences for key architectural choices. |
| 📋 **[Operational Runbooks](./runbooks/README.md)** | On-Call Engineers | Standard operating procedures for incident response, cluster autoscaling, and shard rotation. |
| 🩺 **[Triage Playbooks](./playbooks/README.md)** | Platform Engineers | Diagnostic playbooks for upstream outages, ITL stalls, and burst queue decoupling. |
| 🔍 **[Blameless Post-Mortems](./post-mortems/README.md)** | Engineering Team | Retrospectives on historical outages that shaped NOVA's defensive resilience features. |
| 👥 **[Maintainer Operations & Governance](./maintainers/README.md)** | Maintainers, SRE Leads | Maintainer charter, SemVer release engineering, PR review checklists, security response, and zero-downtime DB migrations. |
| 🛡️ **[Docs Freshness CI Gate](../scripts/lint-docs.ts)** | Contributors, Maintainers | Automated linter verifying link integrity, anchor resolution, and anti-staleness constraints. |

---

<a id="quick-links"></a>
## ⚡ Quick Direct Navigation

### 1. Setup & Startup
- [Local 60-Second Development Guide](./setup/local-development.md)
- [Production Clustering & Systemd](./setup/production-clustering.md)
- [Distilled PostgreSQL Substrate](./setup/postgresql-substrate.md)
- [AES-256-GCM Credential Vault Bootstrapping](./setup/credential-vault.md)

### 2. Architecture Deep Dives
- [Request Lifecycle & Substrate Dataflow](./architecture/dataflow-and-lifecycle.md)
- [Smooth Weighted Round Robin (SWRR) Formulation](./architecture/smooth-weighted-round-robin.md)
- [Continuous Token Bucket Rate Governance](./architecture/rate-governor-leaky-bucket.md)
- [7-Layer WebSocket Timeout Hierarchy](./architecture/7-layer-timeout-hierarchy.md)
- [Native BroccoliQueue 3-MinHeap Engine](./architecture/broccoliqueue-minheaps.md)
- [Distilled PostgreSQL Relational Substrate](./architecture/distilled-postgresql-substrate.md)
- [Cryptographic Vault & Envelope Encryption](./architecture/cryptographic-vault-envelope-encryption.md)

### 3. Gateway API Reference
- [Chat Completions (`POST /v1/chat/completions`)](./api/chat-completions.md)
- [Image Generations (`POST /v1/images/generations`)](./api/image-generations.md)
- [Jobs & Stream Control (`/v1/jobs/*`)](./api/jobs-and-streaming.md)
- [Admin & Telemetry APIs (`/metrics`, `/api/*`)](./api/admin-and-telemetry.md)

### 4. Observability & SDKs
- [Prometheus Metrics Catalog & Alert Rules](./observability/prometheus-metrics.md)
- [Telemetry & Distributed Tracing](./observability/telemetry-and-tracing.md)
- [Native TypeScript Client (`NovaClient`)](./sdks/typescript-nova-client.md)
- [Official OpenAI Python SDK Integration](./sdks/python-openai.md)
- [LangChain & LangGraph Integration](./sdks/langchain-integration.md)
- [cURL & Raw HTTP Wire Protocol](./sdks/curl-and-raw-http.md)

### 5. Architecture Decision Records (ADRs)
- [ADR-0001: Smooth Weighted Round Robin (SWRR) Credential Pooling](./adrs/ADR-0001-swrr-credential-pooling.md)
- [ADR-0002: Two-Phase Continuous Token-Bucket Rate Governance](./adrs/ADR-0002-continuous-token-buckets.md)
- [ADR-0003: Native Infused BroccoliQueue Engine](./adrs/ADR-0003-native-infused-broccoliqueue.md)
- [ADR-0004: Distilled PostgreSQL Substrate (Zero Supabase Bloat)](./adrs/ADR-0004-distilled-postgresql.md)
- [ADR-0005: 7-Layer WebSocket Timeout Hierarchy](./adrs/ADR-0005-7-layer-websocket-timeouts.md)
- [ADR-0006: Hardware-Grade AES-256-GCM Envelope Encryption](./adrs/ADR-0006-aes-256-gcm-vault-security.md)

### 6. Operational Runbooks
- [Runbook: Production Incident Response & Severity Matrix](./runbooks/runbook-incident-response.md)
- [Runbook: Cluster Horizontal Autoscaling & Memory Bulkheads](./runbooks/runbook-cluster-scaling.md)
- [Runbook: PostgreSQL Database Maintenance & Backups](./runbooks/runbook-database-maintenance.md)
- [Runbook: Zero-Downtime Shard Credential Rotation](./runbooks/runbook-shard-rotation.md)

### 7. Triage Playbooks
- [Playbook: Handling Upstream Provider 502/503/429 Outages](./playbooks/playbook-upstream-outage.md)
- [Playbook: Investigating Inter-Token Latency (ITL) Stalls](./playbooks/playbook-itl-stall-investigation.md)
- [Playbook: Managing Surge Bulkhead Decoupling (HTTP 202 Accepted)](./playbooks/playbook-burst-bulkhead-saturation.md)

### 8. Blameless Post-Mortems
- [Post-Mortem: 2026-03-14 Upstream WebSocket Silent Stall Cascade](./post-mortems/postmortem-2026-03-14-upstream-cascade-itl-hang.md)
- [Post-Mortem: 2026-06-22 Tier-1 Burst Quota Exhaustion](./post-mortems/postmortem-2026-06-22-burst-quota-exhaustion.md)

### 9. Maintainer Operations & Governance
- [Project Maintainers Charter & Governance](../MAINTAINERS.md)
- [Maintainer Operations Portal & Index](./maintainers/README.md)
- [SemVer 2.0.0 Release Engineering & SLSA Provenance](./maintainers/release-engineering.md)
- [Strict PR Review Quality Gates & Merge Strategy](./maintainers/code-review-and-merging.md)
- [Security Vulnerability Handling & Coordinated Disclosure](./maintainers/security-vulnerability-handling.md)
- [Issue Triage State Machine & Reproduction Verification](./maintainers/triaging-and-support.md)
- [Zero-Downtime Database Migration & DDL Lock Safety](./maintainers/database-migration-policy.md)
- [Maintainer Onboarding, FIDO2/GPG & Offboarding](./maintainers/onboarding-and-offboarding.md)
- [Architecture Governance & Anti-Dependency Policy](./maintainers/architecture-governance.md)

---

<a id="documentation-governance"></a>
## 🛡️ Documentation Freshness & CI/CD Gate

NOVA documentation is treated with the same engineering rigor as production code:
- **Zero Stale Information:** References to deprecated test counts, old dependencies, or legacy cloud migrations are rejected by CI.
- **Link Integrity:** Every internal link, relative file path, and heading anchor is statically evaluated before merge.
- **Run the Linter Locally:**
  ```bash
  npm run lint:docs
  ```
