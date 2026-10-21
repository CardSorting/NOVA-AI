# Operational Runbooks

Standard Operating Procedures (SOPs) for maintaining, scaling, and operating NOVA clusters in production.

---

<a id="runbooks-catalog"></a>
## 📋 Runbooks Catalog

| Runbook | Trigger / Purpose | Target Audience |
| :--- | :--- | :--- |
| **[Incident Response & Severity Matrix](./runbook-incident-response.md)** | Production outages, degraded latency, or error cascades. | On-Call SRE |
| **[Cluster Scaling & Bulkhead Tuning](./runbook-cluster-scaling.md)** | High concurrency spikes, memory pressure, or pod autoscaling. | DevOps, Platform |
| **[Database Maintenance & Backups](./runbook-database-maintenance.md)** | VACUUM scheduling, connection pooling, and DR backups. | DBAs, SRE |
| **[Zero-Downtime Shard Rotation](./runbook-shard-rotation.md)** | Rotating upstream API keys, enrolling new accounts, key retirement. | Security, Admins |
