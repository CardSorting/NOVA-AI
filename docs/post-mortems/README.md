# Blameless Post-Mortems

A collection of blameless retrospectives and root-cause analyses on production incidents that shaped NOVA's architectural and resilience designs.

---

<a id="post-mortems-index"></a>
## 🔍 Published Post-Mortems

| Date | Incident Title | Severity | Architectural Resolution |
| :--- | :--- | :---: | :--- |
| **[2026-03-14](./postmortem-2026-03-14-upstream-cascade-itl-hang.md)** | Upstream WebSocket Silent Stall Cascade | **SEV-1** | Introduction of 7-Layer Timeout Hierarchy & EWMA ITL Pacing. |
| **[2026-06-22](./postmortem-2026-06-22-burst-quota-exhaustion.md)** | Tier-1 Burst Quota Exhaustion | **SEV-1** | Replacement of classic round-robin with Smooth Weighted Round Robin (SWRR) and 2-phase continuous token refunds. |

---

## Post-Mortem Principles

- **Blameless Culture:** We focus on system vulnerabilities, missing automated safety boundaries, and observability gaps, not human error.
- **Actionable Remediation:** Every finding must result in a concrete, testable architectural invariant or automated circuit breaker.
