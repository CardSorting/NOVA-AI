# Setup & Startup Directory

Welcome to the **NOVA Setup & Startup Directory**. This collection of operational guides covers bootstrapping NOVA across various environments, from single-laptop local development to highly available multi-region Kubernetes clusters.

---

<a id="setup-guides"></a>
## 🚀 Available Guides

| Guide | Description | Primary Audience |
| :--- | :--- | :--- |
| **[Local 60-Second Development](./local-development.md)** | Start serving OpenAI-compatible completions locally with zero databases. | All Developers |
| **[Production Clustering & Deployment](./production-clustering.md)** | Production Docker Compose, Kubernetes manifests, and Bare-Metal Systemd setups. | DevOps, SRE |
| **[Distilled PostgreSQL Substrate](./postgresql-substrate.md)** | Applying schema migrations, development seeds, and stored procedures. | DBAs, Backend Engineers |
| **[AES-256-GCM Credential Vault](./credential-vault.md)** | Master secret key generation, HKDF derivation, and dynamic shard enrollment. | Security Engineers |

---

<a id="quick-start-command"></a>
## ⚡ Quick Startup Command Summary

```bash
# 1. Local Relay Gateway (Default port 3001)
npx tsx bin/nova.ts relay --port 3001 --api-key sk-nova-dev

# 2. Local Pool Runtime Coordinator (Default port 3000)
npx tsx bin/nova.ts pool --port 3000 --inference-key secret-pool-key

# 3. Database Migration & Development Seed
npm run db:migrate
npm run db:seed
```
