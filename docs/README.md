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
[![ADRs](https://img.shields.io/badge/ADRs-6%20Accepted-blue.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/adrs)
[![Runbooks](https://img.shields.io/badge/Runbooks-4%20Operational-orange.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/runbooks)
[![Playbooks](https://img.shields.io/badge/Playbooks-3%20Triage-purple.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/playbooks)
[![Post-Mortems](https://img.shields.io/badge/Post--Mortems-2%20Published-darkred.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/post-mortems)

</div>

---

<a id="wiki-index"></a>
## 📚 Knowledge Base Index

| Section | Target Audience | Primary Focus |
| :--- | :--- | :--- |
| 🚀 **[Setup & Startup Guides](./setup/README.md)** | Developers, DevOps, SRE | Local setup, Kubernetes clustering, PostgreSQL migrations, and AES-256 vault bootstrapping. |
| 🏛️ **[Architecture Decision Records (ADRs)](./adrs/README.md)** | Architects, Systems Engineers | Technical specifications and architectural rationales for SWRR, token buckets, BroccoliQueue, and timeouts. |
| 📋 **[Operational Runbooks](./runbooks/README.md)** | On-Call SRE, Sysadmins | Step-by-step standard operating procedures for incident response, cluster autoscaling, and shard rotation. |
| 🩺 **[Triage Playbooks](./playbooks/README.md)** | Platform Engineers | Fast-path diagnostic playbooks for upstream outages, ITL stalls, and burst queue decoupling. |
| 🔍 **[Blameless Post-Mortems](./post-mortems/README.md)** | Engineering Leadership, All | Retrospectives and root-cause analyses on production outages that shaped NOVA's resilience design. |
| 🛡️ **[Docs Freshness CI Gate](../scripts/lint-docs.ts)** | Contributors, Maintainers | Automated linter verifying link integrity, anchor resolution, and anti-staleness constraints. |

---

<a id="quick-links"></a>
## ⚡ Quick Direct Navigation

### Setup & Startup
- [Local 60-Second Development Guide](./setup/local-development.md)
- [Production Clustering & Systemd](./setup/production-clustering.md)
- [Distilled PostgreSQL Substrate](./setup/postgresql-substrate.md)
- [AES-256-GCM Credential Vault Bootstrapping](./setup/credential-vault.md)

### Architecture Decision Records (ADRs)
- [ADR-0001: Smooth Weighted Round Robin (SWRR) Credential Pooling](./adrs/ADR-0001-swrr-credential-pooling.md)
- [ADR-0002: Two-Phase Continuous Token-Bucket Rate Governance](./adrs/ADR-0002-continuous-token-buckets.md)
- [ADR-0003: Native Infused BroccoliQueue Engine](./adrs/ADR-0003-native-infused-broccoliqueue.md)
- [ADR-0004: Distilled PostgreSQL Substrate (Zero Supabase Bloat)](./adrs/ADR-0004-distilled-postgresql.md)
- [ADR-0005: 7-Layer WebSocket Timeout Hierarchy](./adrs/ADR-0005-7-layer-websocket-timeouts.md)
- [ADR-0006: Hardware-Grade AES-256-GCM Envelope Encryption](./adrs/ADR-0006-aes-256-gcm-vault-security.md)

### Operational Runbooks
- [Runbook: Production Incident Response & Severity Matrix](./runbooks/runbook-incident-response.md)
- [Runbook: Cluster Horizontal Autoscaling & Memory Bulkheads](./runbooks/runbook-cluster-scaling.md)
- [Runbook: PostgreSQL Database Maintenance & Backups](./runbooks/runbook-database-maintenance.md)
- [Runbook: Zero-Downtime Shard Credential Rotation](./runbooks/runbook-shard-rotation.md)

### Triage Playbooks
- [Playbook: Handling Upstream Provider 502/503/429 Outages](./playbooks/playbook-upstream-outage.md)
- [Playbook: Investigating Inter-Token Latency (ITL) Stalls](./playbooks/playbook-itl-stall-investigation.md)
- [Playbook: Managing Surge Bulkhead Decoupling (HTTP 202 Accepted)](./playbooks/playbook-burst-bulkhead-saturation.md)

### Blameless Post-Mortems
- [Post-Mortem: 2026-03-14 Upstream WebSocket Silent Stall Cascade](./post-mortems/postmortem-2026-03-14-upstream-cascade-itl-hang.md)
- [Post-Mortem: 2026-06-22 Tier-1 Burst Quota Exhaustion](./post-mortems/postmortem-2026-06-22-burst-quota-exhaustion.md)

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
