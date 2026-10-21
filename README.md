# NOVA: Autonomous Inference Relay Gateway & Resource Routing Substrate

**NOVA** is a standalone, enterprise-grade AI inference coordination gateway and multi-account credential pooling runtime extracted from GALX.

NOVA preserves high-performance, fault-tolerant **Inference Routing (Relay)** and **Algorithmic Resource Management (Pools)**, stripped of all legacy product bloat, UI dashboards, database compactors, and marketing orchestrators.

---

## 1. Core Architecture & Capabilities

### A. NOVA Relay Gateway (`src/relay/`)
- **OpenAI-Compatible Protocol:** Full gateway compatibility for streaming chat completions (`/v1/chat/completions`), image generation (`/v1/images/generations`), job tracking (`/v1/jobs/:id`), model discovery (`/v1/models`), and SSE event streams (`/v1/jobs/:id/stream`).
- **Resilient Upstream Streaming:** Native WebSocket protocol bridging to upstream providers (such as OpenAI/Codex) with automatic ITL (inter-token latency) stalling detection, EWMA pacing, and wall-clock execution ceilings.
- **Durable Idempotency & De-duplication:** SHA-256 prompt and parameter hashing with atomic stream attachment to eliminate duplicate provider billing.
- **Output Token Budgeting:** Token metering with hard limit enforcement.
- **Privacy Firewall & Error Sanitization:** Strict allowlists masking internal shard topology, upstream headers, raw diagnostics, and database connection strings from public caller responses.
- **Reverse Index Routing:** Capability registry routing queries only to healthy, verified, eligible shards.

### B. NOVA Credential & Shard Pooling (`src/pools/`)
- **Smooth Weighted Round Robin (SWRR):** Dynamic load balancing across multiple active shard accounts based on weight and capacity.
- **Continuous Token Bucket Rate Governance:** Real-time RPM/TPM tracking, sliding window quota evaluation, and 2-phase token reservations with unconsumed token refunds.
- **Circuit Breaker with Canary Probing:** Automatic failure classification (terminal vs. transient), sliding error windows, exponential cooldowns, and limited canary probing for half-open recovery.
- **Durable Write-Ahead-Log (WAL) Queue (`NovaRequestQueue`):** Persistent queueing powered by BroccoliDB/BroccoliQueue with per-tenant fairness limits, bounded waiting rooms, and clean draining.
- **Lease Coordination (`NovaExecution`):** Fenced lease grants with remote central synchronization and background settlement sweeps. Supports both PostgreSQL (`PostgresExecutionStore`) and in-memory (`MemoryExecutionStore`) backends.
- **Central Coordinator & RBAC (`pool-central.ts`):** Secure communication between runtime workers and the central controller with strict role isolation (`runtime`, `operator`, `viewer`).

### C. NOVA TypeScript Client SDK (`src/client/`)
- `NovaClient`: Full-featured async client supporting streaming chat completions (`chatStream()`), synchronous chat (`chat()`), image synthesis (`generateImage()`), model inspection (`listModels()`), and job status polling (`getJob()`).

---

## 2. Project Structure

```
├── db/
│   ├── schema.sql               # Single distilled PostgreSQL schema (no Supabase bloat)
│   └── seed.sql                 # Development seed data (pools, runtimes, principals, test shard)
├── src/
│   ├── db/
│   │   ├── postgres.ts          # Native PostgreSQL pool manager & health checker
│   │   └── migrate.ts           # Migration runner for schema.sql and seed.sql
│   ├── client/
│   │   ├── relay-client.ts      # NovaClient SDK for inference consumers
│   │   └── stream-parser.ts     # Resilient SSE parser for chunk streaming
│   ├── pools/
│   │   ├── circuit-breaker.ts   # NovaCircuitBreaker & canary slot governor
│   │   ├── credential-pool.ts   # NovaCredentialPool (SWRR & P-AHT)
│   │   ├── credential-substrate.ts # NovaCredentialSubstrate reactive registry
│   │   ├── desktop-credentials.ts # Multi-account token parsing & validation
│   │   ├── desktop-credential-refresh.ts # Token refresh routines
│   │   ├── desktop-enrollment.ts # Dynamic account enrollment
│   │   ├── lease-transition.ts  # Health coalescing & state transitions
│   │   ├── pool-central.ts      # Central coordinator HTTP server & RBAC
│   │   ├── pool-contracts.ts    # TypeScript interfaces for pools & quotas
│   │   ├── pool-execution.ts    # NovaExecution lease binding & settlement
│   │   ├── pool-image-policy.ts # Dedicated image generation workload policy
│   │   ├── pool-protocol.ts     # Wire protocol contracts & CentralClient
│   │   ├── pool-public-response.ts # Sanitized DTO formatters
│   │   ├── pool-queue-http.ts   # HTTP message abstraction for request queue
│   │   ├── pool-request-queue.ts# NovaRequestQueue BroccoliDB WAL queue
│   │   ├── pool-runtime.ts      # NovaPoolRuntime coordinator
│   │   ├── pool-scheduler.ts    # Fair queue dispatch scheduler
│   │   └── rate-governor.ts     # NovaRateGovernor continuous token bucket
│   ├── relay/
│   │   ├── admission-lifecycle.ts # Request admission lifecycle hooks
│   │   ├── admission-observability.ts # Observability & trace events
│   │   ├── admission-receipt-journal.ts # Local append-only admission journal
│   │   ├── admission-receipts.ts # Image request receipt tracker
│   │   ├── capability-discovery.ts # Remote upstream model capability discovery
│   │   ├── capability-registry.ts # Shard capability reverse index & routing
│   │   ├── codex-image-tool.ts  # Upstream Codex image alias definitions
│   │   ├── completion-usage.ts  # Token usage extractor
│   │   ├── durable-receipts.ts  # Durable receipt store interface
│   │   ├── function-tools.ts    # Function tool contract normalizer
│   │   ├── image-compatibility.ts # Image model parameter verification
│   │   ├── output-budget.ts     # Output token budget ceiling monitor
│   │   ├── private-failure.ts   # Error masking & sanitization
│   │   ├── quota-policy.ts      # Cooldown & quota deadline policies
│   │   ├── registry-api-reader.ts # Shard registry HTTP pagination reader
│   │   ├── registry-egress-guard.ts # Bounded JSON reader protecting memory
│   │   ├── relay-server.ts      # NovaRelayServer HTTP/WS engine
│   │   ├── request-bulkhead.ts  # Concurrency limiters & bulkheads
│   │   ├── request-policy.ts    # JSON body reader, validation, RequestError
│   │   ├── shard-registry-sync.ts # Shard database synchronization
│   │   ├── shard-registry.ts    # AES-256-GCM shard credential vault
│   │   ├── sites-contract.ts    # Sites contract validator
│   │   ├── telemetry.ts         # In-memory telemetry aggregator
│   │   └── upstream-diagnostic.ts # Private diagnostic sanitizer
│   ├── security/
│   │   └── image-artifact.ts    # Sharp sRGB sanitization & base64 encoding
│   ├── storage/
│   │   ├── memory-table.ts      # Standalone BroccoliDbTable in-memory table
│   │   ├── table-aggregation.ts # Table aggregation helpers
│   │   └── table-contracts.ts   # Storage interfaces
│   └── index.ts                 # Master entrypoint exporting public APIs
├── tests/
│   ├── credential-pool.test.ts  # SWRR, token buckets, circuit breaking tests
│   ├── pool-queue.test.ts       # WAL queue persistence & worker tests
│   ├── pool-runtime.test.ts     # Pool execution, leases, & central RBAC tests
│   ├── postgres-db.test.ts      # Distilled schema, seed, migration runner & store tests
│   ├── relay-client.test.ts     # End-to-end client streaming & model tests
│   └── relay-server.test.ts     # Relay HTTP/WS routing, auth, & idempotency tests
├── package.json
└── tsconfig.json
```

---

## 3. Distilled PostgreSQL Layer (Zero Supabase Bloat)

NOVA distills the 159 cumulative migrations from the legacy Supabase database into a **single, idempotent, self-contained PostgreSQL schema (`db/schema.sql`)**.

### What was removed:
- **Supabase Auth (`auth.users`, JWT policies):** Replaced with direct hashed token authentication via `private.nova_relay_principals`.
- **Stripe Billing Bloat:** Removed all webhook ledgers, invoices, subscriptions, and payment methods.
- **RAG & Vector Embeddings:** Stripped all `pgvector` extensions, semantic embeddings, and chat memory chunks.
- **Social & Persona Metadata:** Removed all user personas, workspace invites, and prompt engineering pyramids.
- **Supabase Cloud CLI & Infrastructure:** Zero dependence on Supabase CLI, Supabase Studio, Edge Functions, or Storage Buckets.

### Running Local PostgreSQL:
NOVA works natively with any standard PostgreSQL instance (version 14 to 17+):
```bash
# If using Homebrew PostgreSQL:
brew services start postgresql@17

# Or if using Docker:
docker run --name nova-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nova -p 5432:5432 -d postgres:17
```

### Applying Schema & Seeds:
```bash
# Run schema migrations
npm run db:migrate

# Run schema migrations AND apply dev seed data (pools, runtimes, principals, test shard)
npm run db:seed

# Or via the unified CLI
nova migrate --seed --url postgresql://postgres:postgres@127.0.0.1:5432/nova
```

---

## 4. Getting Started

### Prerequisites
- Node.js v20+ (Node v22+ or v26+ recommended)
- `npm` or `pnpm`

### Installation
From within the `nova` directory:
```bash
cd nova
npm install
```

### Running Tests
Execute the complete test suite:
```bash
npm test
```

### Type Checking
Validate strict TypeScript contracts:
```bash
npm run typecheck
```

---

## 5. Usage Examples

### Starting NOVA via CLI
```bash
# Unified CLI
npx tsx bin/nova.ts relay --port 3001 --api-key my-secret-inference-key

# Or start the pool coordinator
npx tsx bin/nova.ts pool --port 3000 --inference-key my-secret-inference-key
```

### Programmatic Usage: NOVA Client SDK
```typescript
import { NovaClient } from './src/index.js';

const client = new NovaClient({
  baseUrl: 'http://127.0.0.1:3001',
  apiKey: 'my-secret-inference-key',
  tenant: 'production-workload'
});

// Streaming Chat Completion
for await (const chunk of client.chatStream({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Design a distributed rate limiter in Go.' }]
})) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}

// Synchronous Aggregated Chat
const response = await client.chat({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is 42?' }]
});
console.log(response.choices[0].message.content);
```

### Programmatic Usage: Algorithmic Credential Pool
```typescript
import {
  NovaCredentialPool,
  NovaCredentialSubstrate,
  NovaRateGovernor,
  NovaCircuitBreaker
} from './src/index.js';

const substrate = new NovaCredentialSubstrate();
const pool = new NovaCredentialPool(
  substrate,
  new NovaRateGovernor(),
  new NovaCircuitBreaker(),
  'smooth_weighted_round_robin'
);

// Register upstream accounts
substrate.upsertShardAccount({
  id: 'account_alpha',
  accountLabel: 'Primary Tier-1 OpenAI Account',
  provider: 'openai',
  authType: 'api_key',
  shardMode: 'pooled',
  status: 'healthy',
  priority: 10,
  weight: 2,
  fencingToken: 1,
  apiKeyMasked: 'sk-proj...1111',
  encryptedSecrets: { ciphertext: '...', iv: '...', tag: '...', keyVersion: 'v1' },
  tokenBucket: {
    maxTokens: 1_000_000,
    remainingTokens: 1_000_000,
    refillRatePerMinute: 500_000,
    maxRequests: 500,
    remainingRequests: 500,
    lastRefillTimestampMs: Date.now()
  },
  stats: { totalRequestsServed: 0, totalTokensConsumed: 0, consecutiveFailures: 0, averageLatencyMs: 250 },
  createdAtMs: Date.now(),
  updatedAtMs: Date.now()
});

// Acquire lease with token reservation
const result = await pool.acquireLease({
  userId: 'tenant_omega',
  provider: 'openai',
  estimatedTokens: 3500
});

if (result.status === 'success' && result.lease) {
  try {
    // Perform inference call using result.lease.account
  } finally {
    await pool.releaseLease(result.lease.leaseId, {
      success: true,
      actualTokensConsumed: 1200
    });
  }
}
```

---

## 6. Architectural Boundary Guarantees

1. **Zero External Workspace Dependencies:** `nova` does not import any files from the parent repository (`../`). All required models, security routines, and storage drivers are self-contained.
2. **Untouched Source Codebase:** The parent GALX repository remains in its pristine, original state with zero deletions or invasive rewrites.
3. **Public Privacy Firewall:** All public DTOs format outputs through strict allowlists, preventing accidental disclosure of upstream telemetry, shard IDs, or internal failure diagnostics.
