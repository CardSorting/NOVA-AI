# Maintainer Code Review & Merging Policy

This document establishes the code review expectations, architectural invariants checklist, and merge standards required of all **NOVA** maintainers and reviewers.

---

## Table of Contents

- [Review Philosophy & Expectations](#review-philosophy--expectations)
- [Maintainer Review Checklist](#maintainer-review-checklist)
  - [1. Architectural Invariant Checks](#1-architectural-invariant-checks)
  - [2. Concurrency, Memory & Async Safety](#2-concurrency-memory--async-safety)
  - [3. Type Safety & Error Taxonomy](#3-type-safety--error-taxonomy)
  - [4. Test Suite Rigor](#4-test-suite-rigor)
  - [5. Documentation & Freshness Compliance](#5-documentation--freshness-compliance)
- [Review Service-Level Agreements (SLAs)](#review-service-level-agreements-slas)
- [Merge Strategy & Conventional Commits](#merge-strategy--conventional-commits)
  - [Squash and Merge Enforcement](#squash-and-merge-enforcement)
  - [Sanitized Commit Message Formatting](#sanitized-commit-message-formatting)
- [Branch Protection Configuration](#branch-protection-configuration)

---

## Review Philosophy & Expectations

Code reviews in NOVA are a collaborative defense mechanism to ensure system reliability and long-term maintainability. 

Maintainers must balance two complementary objectives:
1. **Uncompromising Technical Rigor:** Never compromise on architectural boundaries, test completeness, or memory safety. If an invariant is violated, block the PR with clear technical explanations and constructive suggestions.
2. **Empathetic & Constructive Tone:** Treat contributors with respect. Explain *why* an invariant exists rather than issuing terse rejections. Point to specific [Architecture Guides](file:///Users/bozoegg/Downloads/nova/docs/architecture) or [ADRs](file:///Users/bozoegg/Downloads/nova/docs/adrs).

---

## Maintainer Review Checklist

Before approving any pull request, maintainers must verify each of the following five domains:

```
┌────────────────────────────────────────────────────────────────────────┐
│                     MAINTAINER QUALITY CHECKLIST                       │
├────────────────────────────────┬───────────────────────────────────────┤
│ 1. Architectural Boundaries    │ Hermetic workspace, headless queue,   │
│                                │ privacy firewall, distilled Postgres  │
├────────────────────────────────┼───────────────────────────────────────┤
│ 2. Concurrency & Memory Safety │ Deterministic cleanup, zero leaks,    │
│                                │ bounded heap, non-blocking I/O        │
├────────────────────────────────┼───────────────────────────────────────┤
│ 3. Type Safety & Errors        │ Zero `any`, typed error subclasses,   │
│                                │ exhaustive switch handling            │
├────────────────────────────────┼───────────────────────────────────────┤
│ 4. Test Suite Rigor            │ Unit + integration tests, zero skips, │
│                                │ fast execution (< 1s locally)         │
├────────────────────────────────┼───────────────────────────────────────┤
│ 5. Documentation Gate          │ npm run lint:docs passes, ADR added   │
│                                │ for architectural additions           │
└────────────────────────────────┴───────────────────────────────────────┘
```

### 1. Architectural Invariant Checks
- [ ] **Hermetic Substrate:** Confirm there are zero imports from outside the repository root (`../` that escape `nova`). All imports must be relative to `src/` or official npm packages.
- [ ] **Headless Queue Purity:** Verify that `src/queue` has zero browser DOM, CSS, or UI runtime dependencies. The queue must remain completely headless and operational in server/container environments.
- [ ] **Zero-Leak Privacy Firewall:** Public HTTP endpoints (`/v1/*`) must never expose internal shard credentials, upstream authorization tokens, or raw provider stack traces. All error paths must be sanitized via `src/relay/private-failure.ts`.
- [ ] **Distilled PostgreSQL Portability:** Database alterations must be reflected directly in [db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql). Cloud-proprietary lock-in (e.g. Supabase proprietary RPCs) is prohibited.
- [ ] **Deterministic Idempotency:** Any mutation or enqueued job must respect client idempotency keys to prevent duplicate execution during network retries.

### 2. Concurrency, Memory & Async Safety
- [ ] **Deterministic Resource Teardown:** Verify that all `setInterval`, `setTimeout`, event listeners, database clients, and WebSocket connections are reliably cleared in `finally` blocks, `dispose()`, or `stop()` methods.
- [ ] **Non-Blocking Hot Paths:** Ensure that hot request paths perform zero synchronous file system calls (`fs.readFileSync`) or CPU-intensive JSON parsing loops.
- [ ] **Algorithmic Efficiency:** Verify that Priority Queue insertions and deletions remain $O(\log N)$ and Token Bucket rate checks remain $O(1)$.
- [ ] **Backpressure Handling:** Streamed inference responses must handle client disconnects cleanly without unbounded memory buffer accumulation.

### 3. Type Safety & Error Taxonomy
- [ ] **No `any` Escapes:** Verify that TypeScript strict mode is satisfied without using `any` or loose type assertions (`as unknown as T`) unless strictly necessary and documented with a comment.
- [ ] **Typed Error Classes:** Use domain-specific error classes (`RequestError`, `DesktopCredentialError`, `SchedulerQueueError`) with valid HTTP status codes and structured details.
- [ ] **Explicit Nullability:** Ensure nullable database columns and optional API fields are explicitly typed with `T | null` or `T | undefined`.

### 4. Test Suite Rigor
- [ ] **Coverage for Changes:** Every new feature, endpoint, or bug fix must include corresponding tests in `tests/*.test.ts`.
- [ ] **Regression Assertion:** For bug fixes, the test must fail when run against the unpatched code and pass with the patch.
- [ ] **No Flaky Timing Tests:** Avoid fragile `setTimeout(..., 1000)` assertions. Use deterministic event triggers, mock clocks, or polling utilities.
- [ ] **Node Native Runner:** All tests must run cleanly via `npm test` using `node:test` without requiring Jest, Mocha, or heavy test harnesses.

### 5. Documentation & Freshness Compliance
- [ ] **Documentation Linter Passes:** `npm run lint:docs` must exit with 0 errors and 0 warnings.
- [ ] **ADR Requirement:** If the PR introduces a new subsystem, alters a public protocol wire contract, or adds a new runtime dependency, an Architecture Decision Record must be included in `docs/adrs/`.
- [ ] **Changelog Entry:** The PR must include an entry in [CHANGELOG.md](file:///Users/bozoegg/Downloads/nova/CHANGELOG.md) under `[Unreleased]`.

---

## Review Service-Level Agreements (SLAs)

Maintainers must meet the following review timelines:

| PR Category | Initial Review SLA | Re-Review SLA |
| :--- | :--- | :--- |
| **Security Patch (Private)** | $< 24$ hours | $< 12$ hours |
| **P0 / P1 Bug Fix** | $< 24$ hours | $< 24$ hours |
| **Standard Feature / Improvement** | $< 48$ hours | $< 48$ hours |
| **Documentation Only** | $< 48$ hours | $< 24$ hours |

If a maintainer cannot complete an assigned review within the SLA window, they must reassign the PR or notify the author to reset expectations.

---

## Merge Strategy & Conventional Commits

### Squash and Merge Enforcement
All pull requests must be merged using **Squash and Merge**. This policy ensures:
- A clean, linear Git history on `main`.
- Each commit on `main` represents a discrete, bisectable, and deployable unit of work.
- Intermediate "wip" or "fix typo" commits are collapsed.

### Sanitized Commit Message Formatting
When merging, maintainers must edit the squash commit title and body to strictly follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <clear, imperative description>

[Optional detailed body explaining context, rationale, and consequences]

Closes #<issue_number>
Reviewed-by: @maintainer1, @maintainer2
```

#### Example of a Pristine Merge Commit:
```
feat(queue): add batch lease renewal heartbeats and exponential backoff

Infuse native MinHeap queue with sliding lease heartbeats (context.heartbeat()),
allowing long-running inference jobs to preserve ownership without prematurely
triggering reaper reassignment.

Closes #142
Reviewed-by: @CardSorting, @nova-maintainer
```

---

## Branch Protection Configuration

The `main` branch is protected by the following GitHub settings:
1. **Require pull request before merging:**
   - Minimum 1 approving review from Code Owners (2 for breaking/subsystem changes).
   - Dismiss stale pull request approvals when new commits are pushed.
   - Require review from Code Owners.
2. **Require status checks to pass before merging:**
   - `lint:docs` (documentation gate)
   - `typecheck` (TypeScript compiler)
   - `test` (Node test runner across matrix)
3. **Require signed commits:** Commits must be cryptographically signed with a registered GPG or SSH key.
4. **Require linear history:** Prevent merge commits on `main`.
5. **Do not allow bypassing the above settings:** Applies to administrators and maintainers alike.
