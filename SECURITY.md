# Security Policy

The NOVA security team takes the safety and integrity of our software, user credentials, and distributed infrastructure seriously. We appreciate the responsible disclosure of security vulnerabilities by security researchers and community members.

---

## Supported Versions

Only the latest minor release of the current major version receives proactive security updates and patches.

| Version | Supported          | Security Maintenance Status |
| :---    | :---:              | :---                        |
| `1.x`   | :white_check_mark: | Actively supported with patches |
| `< 1.0` | :x:                | Deprecated / Unsupported    |

---

## Reporting a Vulnerability

If you discover a security vulnerability within NOVA, please do **NOT** open a public issue, discussion, or pull request.

Instead, please report it through one of the following secure channels:

1. **GitHub Private Security Advisory (Recommended):**
   Navigate to the [NOVA Security Advisories page](https://github.com/CardSorting/NOVA-AI/security/advisories) and click **"Report a vulnerability"**.
2. **Security Email:**
   Send an encrypted or confidential report to [security@cardsorting.org](mailto:security@cardsorting.org).

### What to Include in Your Report

To help us triage and resolve the issue quickly, please provide:
- A descriptive summary of the vulnerability and its potential impact.
- Step-by-step instructions or a minimal proof of concept (PoC) to reproduce the issue.
- The specific component(s) affected (e.g., Relay Gateway, Credential Substrate, AES-256-GCM Vault, BroccoliQueue).
- Any proposed mitigations or remediation steps if you have them.

### Response Timelines

- **Initial Acknowledgment:** Within **48 hours** of report receipt.
- **Triage & Severity Assessment:** Within **5 business days**.
- **Coordinated Disclosure:** We kindly request that you maintain confidentiality until we have authored, tested, and published a security release.

---

## Security Architecture & Defense-in-Depth Guarantees

NOVA incorporates multiple layers of defensive engineering designed to safeguard pooled API credentials and prevent unauthorized inspection of internal topologies:

### 1. Timing-Safe API Key Verification
All API key checks (`Authorization: Bearer <token>`) employ constant-time comparison via `crypto.timingSafeEqual()`. Hashes are computed using SHA-256 digests over padded buffers, completely mitigating side-channel and timing analysis attacks.

### 2. Hardware-Grade AES-256-GCM Envelope Encryption
All upstream credentials stored in PostgreSQL (`nova_shard_accounts`) or fleet files (`.galx-shards.json`) are encrypted using AES-256-GCM envelope encryption:
- Keys are derived via **HKDF-SHA256** using an isolated master secret (`$GALX_VAULT_KEY`), salt, and context info.
- Each ciphertext block is authenticated with a 12-byte initialization vector (IV) and a 16-byte authentication tag.
- Ciphertexts are cryptographically bound to **Additional Authenticated Data (AAD)** formatted as `${user_id}:${shard_id}:${provider}`, preventing ciphertext transposition attacks across tenants or shards even if a database snapshot is breached.

### 3. Zero-Leak Privacy Firewall & Sanitization
Public API callers (`/v1/*`) are strictly separated from upstream infrastructure:
- All internal headers (`x-shard-id`, `x-account-key`, `cf-ray`, `openai-organization`) are stripped before egress.
- Upstream diagnostics, raw vendor error messages, and internal stack traces are masked into standard error codes (`upstream_error`, `quota_exceeded`, `gateway_timeout`) or encrypted with AES-256-GCM.
- External telemetry surfaces strictly follow allowlisted schemas (`publicJob`, `publicUsage`).

### 4. Concurrency Bulkheads & Resource Ceilings
- **Slowloris Defense:** HTTP request bodies are subject to a strict 10-second read deadline (`HTTP_BODY_TIMEOUT_MS`) and a 2 MB hard payload limit (`MAX_PAYLOAD_BYTES`).
- **Concurrency Bulkheads:** Global and per-tenant concurrency ceilings prevent resource exhaustion and noisy-neighbor starvation.
- **Output Token Budgeting:** Generative outputs are tracked in real time against caller caps, terminating runaway generations cleanly.

### 5. Monotonic Fencing Tokens
To eliminate split-brain hazards in distributed worker environments, all execution leases carry monotonically increasing 64-bit fencing tokens verified atomically at settlement by the PostgreSQL substrate.

---

## Maintainer Security Response & Incident Playbooks

For detailed protocols governing how maintainers coordinate advisories, reserve CVEs, and backport security patches:
- 🔒 **[Security Vulnerability Handling Runbook](file:///Users/bozoegg/Downloads/nova/docs/maintainers/security-vulnerability-handling.md)**
- 👥 **[Security Response Team (SRT) Roster](file:///Users/bozoegg/Downloads/nova/MAINTAINERS.md#security-response-team-srt)**

