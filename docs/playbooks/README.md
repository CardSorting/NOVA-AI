# Triage Playbooks

Fast-path triage guides for operational symptoms, unexpected error codes, and provider anomalies.

---

<a id="playbooks-catalog"></a>
## 🩺 Playbooks Catalog

| Playbook | Symptom / Alert | Typical Time to Resolve |
| :--- | :--- | :---: |
| **[Upstream Outage & Circuit Quarantine](./playbook-upstream-outage.md)** | Sudden surge in HTTP 502/504 or provider 429 quota errors. | $< 10\text{ minutes}$ |
| **[Inter-Token Latency (ITL) Stalls](./playbook-itl-stall-investigation.md)** | WebSocket connections stalling mid-stream without tokens. | $< 5\text{ minutes}$ |
| **[Surge Bulkhead Decoupling (202 Accepted)](./playbook-burst-bulkhead-saturation.md)** | Requests receiving `HTTP 202 Accepted` execution receipts. | $< 15\text{ minutes}$ |
