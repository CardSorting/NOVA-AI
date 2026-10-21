# Contributing to NOVA

Thank you for your interest in contributing to **NOVA**! We welcome contributions from developers, researchers, and systems engineers of all backgrounds.

This guide outlines our development workflow, coding standards, architectural boundaries, and pull request process.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Development Setup](#development-setup)
- [Architectural Boundary Guarantees](#architectural-boundary-guarantees)
- [Local Development Workflow](#local-development-workflow)
- [Running Tests & Typechecking](#running-tests--typechecking)
- [Coding & Style Guidelines](#coding--style-guidelines)
- [Commit Message Conventions](#commit-message-conventions)
- [Pull Request Checklist](#pull-request-checklist)
- [Reporting Security Issues](#reporting-security-issues)

---

## Code of Conduct

All contributors and maintainers are expected to adhere to our [Code of Conduct](file:///Users/bozoegg/Downloads/nova/CODE_OF_CONDUCT.md). Please read it before participating in discussions, opening issues, or submitting pull requests.

---

## Development Setup

### Prerequisites

- **Node.js**: `>= 20.0.0` (LTS recommended)
- **npm**: `>= 10.0.0`
- **Git**

### Clone & Install

```bash
git clone https://github.com/CardSorting/NOVA-AI.git nova
cd nova
npm install
```

Verify your environment immediately by running the test suite:
```bash
npm test
```
All 23 tests should pass in under 700ms.

---

## Architectural Boundary Guarantees

When contributing to NOVA, you must strictly uphold our core architectural invariants:

1. **Zero External Workspace Dependencies:**
   `nova` must never import from parent or sibling directories (`../`). All data structures, security primitives, and models must reside directly within `src/` or official npm packages.
2. **Headless Execution Substrate:**
   Backend queue and relay components must remain 100% headless. Do not introduce browser-only dependencies, client HTML templates, or UI servers into core runtime paths.
3. **Zero-Leak Privacy Firewall:**
   Public endpoints (`/v1/*`) must never expose internal shard IDs, upstream auth tokens, backend database connection strings, or unmasked upstream provider stack traces. All error paths must sanitize diagnostics through [src/relay/private-failure.ts](file:///Users/bozoegg/Downloads/nova/src/relay/private-failure.ts).
4. **Distilled PostgreSQL Portability:**
   Database schema changes must remain self-contained in [db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql). Do not introduce proprietary cloud dependencies (e.g., Supabase-specific extensions or external webhook handlers).
5. **Deterministic Idempotency:**
   All mutations and inferences passing through `NovaRequestQueue` or `BroccoliQueue` must maintain stable idempotency keys and prevent double-billing on client retries.
6. **Standalone Infrastructure Substrate (No Embedding in Other Products):**
   NOVA operates strictly as an autonomous out-of-process daemon and network service. Do not submit pull requests that attempt to embed NOVA in-process inside client application layers, or introduce consumer-facing UI frameworks, product payment checkouts, or user authentication schemas. See [Anti-Scope-Creep Policy](file:///Users/bozoegg/Downloads/nova/docs/maintainers/anti-scope-creep-policy.md) and [ADR-0007](file:///Users/bozoegg/Downloads/nova/docs/adrs/ADR-0007-standalone-daemon-substrate-non-embedding.md).

---


## Local Development Workflow

NOVA includes unified npm scripts and CLI tools for local iteration:

```bash
# 1. Typecheck TypeScript across the entire project (zero emission)
npm run typecheck

# 2. Run the full test suite
npm test

# 3. Start the Inference Relay Gateway on port 3001
npm run start:relay

# 4. Start the Multi-Worker Credential Pool Runtime on port 3000
npm run start:pool

# 5. Run the unified CLI runner
npm run nova -- --help

# 6. Apply distilled PostgreSQL migrations locally
npm run db:migrate
npm run db:seed
```

---

## Running Tests & Typechecking

We rely on Node.js native test runner (`node:test`) combined with `tsx` for sub-second execution without slow compile steps.

### Run All Tests
```bash
npm test
```

### Run a Single Test Suite
```bash
npx tsx --test tests/queue.test.ts
npx tsx --test tests/credential-pool.test.ts
npx tsx --test tests/relay-server.test.ts
```

### Strict Typechecking
```bash
npm run typecheck
```
> [!IMPORTANT]
> Your pull request will fail CI if `npm run typecheck` or `npm test` produces any errors or unhandled rejections.

---

## Coding & Style Guidelines

- **Language:** TypeScript 5.6+ with strict mode enabled (`"strict": true`, `"noImplicitAny": true`).
- **Imports:** Use Node.js ESM format (`import ... from './file.js'`) with the `.js` extension in import paths.
- **Async Code:** Prefer `async`/`await` and Node.js Streams / AsyncIterables (`for await`) over callback patterns.
- **Resource Cleanup:** Always guarantee deterministic cleanup of timers, event listeners, and socket handles in `finally` blocks or `stop()` hooks.
- **Error Handling:** Use typed error subclasses (`RequestError`, `DesktopCredentialError`, `SchedulerQueueError`) with standard HTTP status codes and error taxonomies.

---

## Commit Message Conventions

We adhere to the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <short description>

[optional body]

[optional footer(s)]
```

### Common Types:
- `feat`: A new feature or capability (e.g., `feat(queue): add batch lease renewal heartbeats`)
- `fix`: A bug fix (e.g., `fix(relay): prevent ITL stall false positives on deep reasoning models`)
- `docs`: Documentation-only updates (e.g., `docs(readme): add Kubernetes Helm deployment guide`)
- `refactor`: Code changes that neither fix a bug nor add a feature
- `test`: Adding or improving tests
- `chore`: Maintenance tasks, dependency updates, or build script tweaks

---

## Pull Request Checklist

Before submitting your pull request, please verify:

- [ ] My code strictly adheres to the [Architectural Boundary Guarantees](#architectural-boundary-guarantees).
- [ ] `npm run typecheck` passes with 0 errors.
- [ ] `npm test` passes all 23+ unit and integration tests.
- [ ] New features or bug fixes include dedicated unit/integration tests in `tests/`.
- [ ] Documentation and comments are updated where appropriate.
- [ ] Commit messages follow the [Conventional Commits](#commit-message-conventions) pattern.
- [ ] No secrets, private API keys, or personal tokens are committed.
- [ ] `npm run lint:docs` passes with 0 errors and 0 warnings.

---

## Path to Maintainership

Active, high-leverage contributors are regularly invited to become official repository Reviewers and Core Maintainers.

For full details on governance roles, voting procedures, maintainer SLAs, and nomination criteria:
- 👥 **[NOVA Governance Charter & Maintainer Roster](file:///Users/bozoegg/Downloads/nova/MAINTAINERS.md)**
- 🛠️ **[Maintainer Operations & Engineering Standards Portal](file:///Users/bozoegg/Downloads/nova/docs/maintainers/README.md)**

---

## Reporting Security Issues

Please do **NOT** open public GitHub issues for security vulnerabilities. Instead, refer to our [Security Policy](file:///Users/bozoegg/Downloads/nova/SECURITY.md) and our [Security Vulnerability Handling Runbook](file:///Users/bozoegg/Downloads/nova/docs/maintainers/security-vulnerability-handling.md) for our responsible disclosure procedure.

