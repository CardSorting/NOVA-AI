# NOVA

<div align="center">

```
 _   _  _____  _   _   ___  
| \ | ||  _  || | | | / _ \ 
|  \| || | | || | | |/ /_\ \
| . ` || | | || | | ||  _  |
| |\  |\ \_/ /\ \_/ /| | | |
\_| \_/ \___/  \___/ \_| |_/
```

**Autonomous Inference Relay Gateway & Resource Routing Substrate**

*High-performance, fault-tolerant AI inference coordination, multi-account credential pooling, and resilient WebSocket streaming extracted from GALX.*

---

[![Tests](https://img.shields.io/badge/tests-17%20passing-brightgreen.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6%20Strict-blue.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/tsconfig.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-emerald.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/package.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14--17%2B-blueviolet.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/db/schema.sql)
[![Protocol](https://img.shields.io/badge/OpenAI-Compatible-orange.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/src/relay/relay-server.ts)
[![License](https://img.shields.io/badge/license-MIT-purple.svg?style=flat-square)](#license)
[![Zero Supabase Bloat](https://img.shields.io/badge/Supabase%20Bloat-0%25%20Distilled-success.svg?style=flat-square)](#distilled-postgresql-layer-zero-supabase-bloat)

</div>

---

## ⚡ Quick Navigation

| Getting Started | Architecture & APIs | Technical Substrates | Operations & DB |
| :--- | :--- | :--- | :--- |
| • [Why NOVA?](#why-nova) | • [Architecture & Dataflow](#architecture--system-topology) | • [Smooth Weighted Round Robin](#1-smooth-weighted-round-robin-swrr) | • [Distilled PostgreSQL](#distilled-postgresql-layer-zero-supabase-bloat) |
| • [60-Second Quickstart](#-60-second-quickstart) | • [Gateway API Reference](#-gateway-api-reference-openai-compatible) | • [Continuous Token Buckets](#2-continuous-token-bucket-rate-governor) | • [Configuration Matrix](#-configuration--environment-variables) |
| • [CLI Runner Guide](#-unified-cli-reference) | • [TypeScript Client SDK](#-typescript-client-sdk) | • [Canary Circuit Breaker](#3-canary-circuit-breaker--outlier-detection) | • [Docker & Deployment](#-production-deployment--docker-compose) |
| • [Project Structure](#-project-directory-structure) | • [Feature Comparison](#feature-comparison-matrix) | • [Privacy Firewall](#6-zero-leak-privacy-firewall) | • [Troubleshooting](#-troubleshooting--error-taxonomy) |

---

## Why NOVA?

Modern production LLM deployments face severe operational hurdles:
1. **Upstream Quota Exhaustion & Rate Limits:** Individual API accounts trigger burst `429 Too Many Requests`, halting entire application workloads.
2. **Brittle Streaming & Silent ITL Stalls:** Upstream WebSocket/SSE streams hang indefinitely with no tokens, causing client connections to dangle and leak socket descriptors.
3. **Duplicate Billing on Network Retries:** Naive client retries re-execute identical prompts, incurring multiple full-cost model inferences.
4. **Credential & Topology Leakage:** Generic forwarders accidentally expose upstream shard API tokens, bearer keys, database strings, and raw stack traces to public callers.
5. **Database & Infrastructure Bloat:** Traditional gateways enforce heavy cloud dependencies (Supabase Auth, Supabase Studio, Edge Functions, Stripe webhooks, RAG vector stores) just to route requests.

**NOVA solves all five problems in a single, high-performance runtime:**
- **Algorithmic Account Pooling:** Balances load across dozens of accounts using Smooth Weighted Round Robin (SWRR) and 2-phase token reservations with unconsumed token refunds.
- **Resilient Upstream Streaming:** Native WebSocket protocol bridging to Codex/OpenAI with automatic inter-token latency (ITL) stalling detection, EWMA pacing, and wall-clock execution ceilings.
- **Durable Idempotency:** SHA-256 prompt and parameter hashing with atomic stream attachment to eliminate duplicate provider billing.
- **Strict Privacy Firewall:** Enforces strict response DTO allowlists masking internal shard topologies, upstream headers, raw diagnostics, and database strings.
- **Distilled PostgreSQL Schema:** Distills 159 cumulative migrations from legacy systems into a single, clean, self-contained schema (`db/schema.sql`) runnable on vanilla PostgreSQL.

---

## Feature Comparison Matrix

| Capability | Standard Reverse Proxy (Nginx / Envoy) | Generic LLM Gateway (LiteLLM / Portkey) | Cloud Multi-Tenant PaaS (Supabase / AWS) | **NOVA Substrate (Relay + Pools)** |
| :--- | :---: | :---: | :---: | :---: |
| **OpenAI-Compatible Wire Protocol** | ❌ (Raw HTTP only) | ✅ (HTTP / REST) | ❌ (Proprietary SDKs) | **✅ Streaming SSE & Synchronous** |
| **Algorithmic Credential Pooling** | ❌ (Static round robin) | ⚠️ (Basic random / fallback) | ❌ (Single tenant auth) | **✅ Smooth Weighted Round Robin (SWRR)** |
| **Two-Phase Token Bucket Rate Governance** | ❌ (Basic RPM limiter) | ⚠️ (Static TPM estimates) | ❌ (Credit ledger only) | **✅ Continuous Leaky Bucket + Refund** |
| **Circuit Breakers with Canary Probing** | ⚠️ (Basic health checks) | ⚠️ (Threshold trip) | ❌ (None) | **✅ Transient vs. Terminal + Canary Slots** |
| **Resilient WebSocket Bridging** | ❌ (Blind TCP stream) | ❌ (HTTP-to-HTTP only) | ❌ (Edge functions only) | **✅ 7-Layer Timeout Hierarchy & ITL Pacing** |
| **Durable Idempotency & Stream Attachment**| ❌ (None) | ⚠️ (Response caching) | ❌ (Manual implementation) | **✅ Atomic In-Flight Stream Deduplication** |
| **Privacy Firewall & Error Sanitization** | ❌ (Pass-through headers) | ⚠️ (Partial redaction) | ❌ (Raw upstream errors) | **✅ Strict Zero-Leak Response Allowlist** |
| **Write-Ahead-Log (WAL) Request Queue** | ❌ (None) | ⚠️ (Redis required) | ⚠️ (External SQS / Celery) | **✅ Embedded BroccoliDB WAL Engine** |
| **Distributed Fenced Leases** | ❌ (None) | ❌ (None) | ⚠️ (Advisory locks) | **✅ Monotonic Fencing Tokens (Postgres & Memory)** |
| **Database Footprint** | ❌ (N/A) | ⚠️ (Redis + SQLite/Postgres) | ❌ (150+ migrations & Supabase bloat) | **✅ 1 Distilled Schema (Zero Supabase Bloat)** |

---

## ⚡ 60-Second Quickstart

Get NOVA running locally in less than one minute. Zero external databases required to start.

### 1. Installation
Ensure Node.js v20+ is installed:
```bash
git clone https://github.com/CardSorting/NOVA-AI.git nova
cd nova
npm install
```

### 2. Verify Your Environment
Run the test suite (all 17 unit and integration tests run in under 1 second):
```bash
npm test
```

### 3. Launch the NOVA Relay Gateway
Start the OpenAI-compatible gateway on port `3001` with an auto-generated or specified API key:
```bash
npx tsx bin/nova.ts relay --port 3001 --api-key sk-nova-live-demo
```
Output:
```
======================================================================
   🚀 INFERENCE RELAY SERVER
======================================================================
  Host:        127.0.0.1
  Port:        3001
  API Key:     sk-nova-live-demo
  Admin Key:   key_admin_...
----------------------------------------------------------------------
[NOVA Relay] Ready and listening on http://127.0.0.1:3001
```

### 4. Send Your First Request (OpenAI-Compatible)
In a separate terminal, test the standard chat completions endpoint using `curl`:
```bash
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-nova-live-demo" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      { "role": "user", "content": "Explain Smooth Weighted Round Robin in one sentence." }
    ]
  }'
```

### 5. Stream Real-Time SSE Tokens
Stream completions with Server-Sent Events (SSE):
```bash
curl -N http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-nova-live-demo" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Write a short haiku about low latency." }
    ]
  }'
```

---

## 🏛️ Architecture & System Topology

NOVA is architected as two decoupled, interoperable tiers: the **Inference Relay Gateway** (northbound HTTP/WS) and the **Resource Routing Substrate** (southbound pool coordination).

```
                            [ Client Applications ]
                         (curl / Python / TypeScript / OpenAI SDK)
                                    │
                                    ▼ HTTP / SSE
┌───────────────────────────────────┴────────────────────────────────────────┐
│                        NOVA RELAY GATEWAY (Port 3001)                      │
│                                                                            │
│  ┌───────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐  │
│  │ Timing-Safe API Auth  │  │ Concurrency Bulkhead │  │ Output Budget   │  │
│  │ (Constant-Time HMAC)  │  │ (Max 64 In-Flight)   │  │ (Hard Token Cap)│  │
│  └───────────┬───────────┘  └──────────┬───────────┘  └────────┬────────┘  │
│              │                         │                       │           │
│              ▼                         ▼                       ▼           │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │             Durable Idempotency & Stream Collapsing Engine           │  │
│  │            (SHA-256 Prompt Hashing & Atomic Stream Attachment)       │  │
│  └──────────────────────────────────┬───────────────────────────────────┘  │
│                                     │                                      │
│  ┌──────────────────────────────────▼───────────────────────────────────┐  │
│  │               Zero-Leak Privacy Firewall & Sanitizer                 │  │
│  │          (Masks Shard Topology, Upstream Headers & Diagnostics)      │  │
│  └──────────────────────────────────┬───────────────────────────────────┘  │
└─────────────────────────────────────┼──────────────────────────────────────┘
                                      │
                 ┌────────────────────┴────────────────────┐
                 ▼ Internal Protocol / Grants              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                    NOVA POOL ROUTING SUBSTRATE (Port 3000)                 │
│                                                                            │
│  ┌───────────────────────────┐           ┌──────────────────────────────┐  │
│  │ Smooth Weighted Round     │           │ Continuous Leaky Bucket      │  │
│  │ Robin (SWRR) Balancer     │           │ Rate Governor (TPM & RPM)    │  │
│  └─────────────┬─────────────┘           └──────────────┬───────────────┘  │
│                │                                        │                  │
│                ▼                                        ▼                  │
│  ┌───────────────────────────┐           ┌──────────────────────────────┐  │
│  │ Circuit Breaker & Canary  │           │ Bounded Waiting Room & Fair  │  │
│  │ Probing Engine            │           │ BroccoliDB WAL Queue         │  │
│  └─────────────┬─────────────┘           └──────────────┬───────────────┘  │
│                │                                        │                  │
│                ▼                                        ▼                  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │            Fenced Lease Coordination (Distributed Workers)           │  │
│  │               (PostgresExecutionStore / MemoryExecutionStore)        │  │
│  └──────────────────────────────────┬───────────────────────────────────┘  │
└─────────────────────────────────────┼──────────────────────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│ Upstream Shard A │        │ Upstream Shard B │        │ Upstream Shard C │
│ OpenAI Direct WS │        │ Codex Enterprise │        │ Custom LLM Shard │
└──────────────────┘        └──────────────────┘        └──────────────────┘
```

### Request Lifecycle Sequence Flow

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client App (OpenAI SDK / NovaClient)
    participant Relay as NovaRelayServer
    participant Idemp as Idempotency Engine
    participant Pool as NovaCredentialPool
    participant Shard as Upstream Shard (Codex/OpenAI)
    participant Store as ExecutionStore (Postgres / Memory)

    Client->>Relay: POST /v1/chat/completions (model, messages, stream: true)
    Relay->>Relay: Verify Bearer Key (Timing-Safe) & Check Concurrency Bulkhead
    Relay->>Idemp: Check SHA-256 Prompt Hash
    alt Active In-Flight Stream Matches
        Idemp-->>Relay: Attach to Active Stream
        Relay-->>Client: Stream Existing Tokens (Zero Extra Billing)
    else New Request
        Relay->>Pool: Acquire Lease (Tenant, Estimated Tokens: 4000)
        Pool->>Pool: SWRR Shard Selection & Check Circuit Breaker
        Pool->>Pool: Rate Governor Reserves 4000 Tokens (2-Phase)
        Pool->>Store: Fenced Lease Created (Fencing Token N)
        Pool-->>Relay: Grant Lease (Shard Account, Fencing Token)
        
        Relay->>Shard: Open/Reuse WS Connection (7-Layer Timeout Guard)
        Relay->>Shard: Dispatch Payload Frame
        
        loop Token Streaming with ITL Monitoring
            Shard-->>Relay: WS Output Delta Frame
            Relay->>Relay: Monitor EWMA Inter-Token Latency (Stall Check)
            Relay-->>Client: SSE data: {"choices":[{"delta":{"content":"..."}}]}
        end
        
        Shard-->>Relay: Stream Completed (Actual Tokens Used: 1240)
        Relay->>Pool: Release Lease (Actual Tokens: 1240, Success: true)
        Pool->>Pool: Rate Governor Refunds 2760 Unconsumed Tokens
        Pool->>Store: Settle Lease & Record Latency Metrics
        Relay-->>Client: SSE data: [DONE]
    end
```

---

## 🚀 Unified CLI Reference

NOVA provides a single entrypoint CLI with dedicated subcommands:

```bash
nova <command> [options]
```

### 1. `nova relay` (Inference Gateway)
Starts the OpenAI-compatible HTTP and WebSocket gateway.

```bash
npx tsx bin/nova.ts relay [options]
# Or directly:
npx tsx bin/relay.ts [options]
```

| Flag | Env Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--port <number>` | `PORT` | `3001` | TCP port to listen on |
| `--host <string>` | `HOST` | `127.0.0.1` | Network interface to bind |
| `--api-key <string>` | `RELAY_API_KEY` | `key_live_<random>` | Bearer token required for public inference calls |
| `--admin-key <string>` | `RELAY_ADMIN_KEY` | `key_admin_<random>`| Bearer token required for `/metrics` and shard administration |
| `--ws-endpoint <url>` | `CODEX_WS_ENDPOINT` | `wss://chatgpt.com/...` | Upstream WebSocket endpoint for streaming models |
| `--help, -h` | — | — | Show CLI help text |

**Production Example:**
```bash
nova relay \
  --port 8080 \
  --host 0.0.0.0 \
  --api-key prod_live_8fbc291884da2 \
  --admin-key prod_admin_71829e0192a
```

---

### 2. `nova pool` (Resource Coordinator Runtime)
Starts the multi-worker credential pooling coordinator.

```bash
npx tsx bin/nova.ts pool [options]
# Or directly:
npx tsx bin/pool.ts [options]
```

| Flag | Env Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--port <number>` | `PORT` | `3000` | Port for internal coordinator communication |
| `--inference-key <string>`| — | Auto-generated | Internal inference authorization key |
| `--central-origin <url>` | — | `http://127.0.0.1:1` | Central coordinator URL (mock or remote) |
| `--state-dir <path>` | — | OS Temp Dir | File system directory for BroccoliDB WAL queue & state checkpoints |
| `--help, -h` | — | — | Show CLI help text |

---

### 3. `nova migrate` (Database Migration & Seeding)
Applies the distilled schema and development seeds to PostgreSQL without Supabase.

```bash
npx tsx bin/nova.ts migrate [options]
# Or via npm scripts:
npm run db:migrate
npm run db:seed
```

| Flag | Env Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--url <string>` | `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:5432/nova` | PostgreSQL connection string |
| `--seed` | — | `false` | Apply dev seed data (pools, runtimes, principals, test shard) |
| `--check` | — | `false` | Test PostgreSQL connection and server version without applying migrations |
| `--help, -h` | — | — | Show CLI help text |

**Health Check Example:**
```bash
nova migrate --check --url postgresql://postgres:secret@localhost:5432/nova
# Output:
# [NOVA DB] Target database: postgresql://postgres:****@localhost:5432/nova
# [NOVA DB] Health check: OK (2.4ms)
# [NOVA DB] Server version: PostgreSQL 17.0
```

---

## 🔌 Gateway API Reference (OpenAI-Compatible)

NOVA implements complete protocol compatibility with the OpenAI REST and Streaming API. Any library, framework, or agent configured with an `openai` SDK works out of the box by updating `baseURL`.

### Overview of Endpoints

```
POST   /v1/chat/completions       Create streaming or synchronous chat completions
POST   /v1/images/generations     Synthesize images with Sharp sRGB artifact sanitization
GET    /v1/models                 List verified active models and capabilities
GET    /v1/jobs/:id               Inspect asynchronous job status & token counts
GET    /v1/jobs/:id/stream        Re-attach or resume an active SSE token stream
POST   /v1/jobs/:id/cancel        Instant wire abort and lease release (<5ms)
GET    /health                    Kubernetes liveness and basic process health check
GET    /health/ready              Kubernetes readiness probe (verifies memory and shard state)
GET    /metrics                   Prometheus-compatible real-time performance metrics (Admin key)
GET    /api/telemetry             Aggregated telemetry and latency distributions (Admin key)
```

---

### 1. `POST /v1/chat/completions`

Generates chat completions for given messages. Supports both streaming (Server-Sent Events) and synchronous aggregated responses.

#### Request Headers
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Authorization` | `string` | **Yes** | `Bearer <RELAY_API_KEY>` |
| `Content-Type` | `string` | **Yes** | `application/json` |
| `Idempotency-Key` | `string` | Optional | Client UUID to prevent duplicate processing on retries |
| `x-nova-tenant` | `string` | Optional | Tenant identifier for fair queue scheduling and rate limits |

#### Request Body
```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a concise engineering assistant." },
    { "role": "user", "content": "Explain circuit breaker half-open state." }
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false
}
```

#### Synchronous Response (`stream: false`)
```json
{
  "id": "chatcmpl_9b7d81a29f8c4e",
  "object": "chat.completion",
  "created": 1729497600,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The half-open state in a circuit breaker acts as a trial period where a limited number of requests (canary probes) are allowed through to verify if the underlying service has recovered before fully resetting."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 38,
    "total_tokens": 62
  }
}
```

#### Streaming Response (`stream: true`)
Returns a continuous Server-Sent Events (SSE) stream adhering to the OpenAI chunk schema:
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"id":"chatcmpl_9b7d81a2","object":"chat.completion.chunk","created":1729497600,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"The"},"finish_reason":null}]}

data: {"id":"chatcmpl_9b7d81a2","object":"chat.completion.chunk","created":1729497600,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" half-open"},"finish_reason":null}]}

data: {"id":"chatcmpl_9b7d81a2","object":"chat.completion.chunk","created":1729497600,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" state..."},"finish_reason":null}]}

data: [DONE]
```

---

### 2. `POST /v1/images/generations`

Generates images using upstream providers with automated Sharp-based sRGB profile normalizations and base64 security validation.

#### Request Body
```json
{
  "prompt": "An architectural diagram of a distributed consensus cluster, cyberpunk blueprint style",
  "model": "gpt-image-1",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

#### Response Body
```json
{
  "created": 1729497600,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6..."
    }
  ],
  "artifact": {
    "format": "png",
    "width": 1024,
    "height": 1024,
    "channels": 4,
    "byteLength": 248910
  }
}
```

---

### 3. `GET /v1/jobs/:id` & Reconnection Stream

When a request enters the bounded queue under heavy load, NOVA responds immediately with `HTTP 202 Accepted` and an execution receipt:
```json
{
  "id": "job_01j982a17f",
  "status": "queued",
  "model": "gpt-4o",
  "streamUrl": "/v1/jobs/job_01j982a17f/stream"
}
```
Clients can poll `GET /v1/jobs/:id` or connect directly to `GET /v1/jobs/:id/stream` to receive tokens in real-time as soon as a worker dispatches the job. The `NovaClient` SDK handles this transparently.

---

### 4. Health & Observability Endpoints

```bash
# Kubernetes Liveness
curl http://127.0.0.1:3001/health

# Kubernetes Readiness (validates memory limits, RSS bytes, and shard health)
curl http://127.0.0.1:3001/health/ready

# Prometheus Metrics (Admin Key required)
curl http://127.0.0.1:3001/metrics -H "Authorization: Bearer <RELAY_ADMIN_KEY>"
```

---

## 📦 TypeScript Client SDK

NOVA exports a production-grade, zero-dependency async TypeScript client (`NovaClient`).

### Client Initialization
```typescript
import { NovaClient } from './src/index.js';

const client = new NovaClient({
  baseUrl: 'http://127.0.0.1:3001',
  apiKey: 'sk-nova-live-demo',
  tenant: 'production-workload',
  timeoutMs: 60_000
});
```

### 1. Real-Time Streaming Chat (`client.chatStream`)
Streams chunks asynchronously using native `AsyncGenerator`:
```typescript
const stream = client.chatStream({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'You are a staff distributed systems engineer.' },
    { role: 'user', content: 'Explain monotonic fencing tokens in distributed leases.' }
  ]
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    process.stdout.write(content);
  }
}
```

### 2. Synchronous Chat (`client.chat`)
Awaits full completion with token usage metadata:
```typescript
const completion = await client.chat({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is the speed of light?' }]
});

console.log(completion.choices[0].message.content);
console.log('Total tokens consumed:', completion.usage?.total_tokens);
```

### 3. Seamless Transparent HTTP 202 Async Decoupling
If the gateway is under high load and returns `HTTP 202 Accepted` with a `streamUrl`, `NovaClient` automatically connects to `/v1/jobs/:id/stream` and transparently yields tokens to your generator without requiring manual polling code.

### 4. Image Synthesis (`client.generateImage`)
```typescript
const image = await client.generateImage({
  prompt: 'A minimalist neon logo for an AI relay gateway',
  size: '1024x1024'
});

console.log('Generated image format:', image.artifact?.format);
console.log('Image dimensions:', `${image.artifact?.width}x${image.artifact?.height}`);
```

### 5. Official OpenAI SDK Integration
Because NOVA is 100% protocol compatible, you can use the official `openai` NPM package directly:
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:3001/v1',
  apiKey: 'sk-nova-live-demo'
});

const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello NOVA!' }]
});
console.log(response.choices[0].message.content);
```

---

## ⚙️ Configuration & Environment Variables

Every setting can be specified via environment variables or CLI flags.

### Gateway Server & Network
| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3001` | HTTP and WebSocket server port |
| `HOST` | `127.0.0.1` | Network interface binding |
| `RELAY_MAX_CONCURRENT_REQUESTS`| `64` | Maximum global simultaneous in-flight inference requests |
| `RELAY_MAX_RSS_MB` | `384` | Memory ceiling (MB). Readiness probe reports unhealthy if exceeded |
| `MAX_PAYLOAD_BYTES` | `2097152` (2 MB) | Maximum incoming HTTP JSON body size |
| `HTTP_BODY_TIMEOUT_MS` | `10000` (10s) | Slowloris protection read timeout for incoming HTTP request bodies |
| `RELAY_ALLOWED_ORIGINS` | `*` | Comma-separated CORS allowed origin list |

### Security & API Keys
| Variable | Default | Description |
| :--- | :--- | :--- |
| `RELAY_API_KEY` | Auto-generated | Public inference Bearer token (`/v1/*`) |
| `RELAY_API_KEYS` | — | Comma-delimited list of multiple active inference keys |
| `RELAY_ADMIN_API_KEY` | Auto-generated | Operator Bearer token (`/metrics`, `/api/shards`, etc.) |
| `GALX_VAULT_KEY` | — | AES-256-GCM master secret for decrypting shard credentials |

### 7-Layer WebSocket Timeout Hierarchy
NOVA guards against slow, stalled, or dead upstream provider connections using a 7-layer defense:

| Layer | Environment Variable | Default | Behavioral Guarantee |
| :--- | :--- | :--- | :--- |
| **Layer 0** | `WS_CONNECT_TIMEOUT_MS` | `15000` (15s) | Hard ceiling for TCP + TLS + WebSocket upgrade handshake |
| **Layer 1** | `WS_TTFT_TIMEOUT_MS` | `60000` (60s) | Base ceiling for Time-To-First-Token |
| **Layer 1b**| `DEEP_REASONING_TTFT_MULTIPLIER`| `2.0` (120s) | Multiplier for reasoning models (e.g. o1/o3/high-effort) |
| **Layer 2** | `ITL_GAP_THRESHOLD_MS` | `8000` (8s) | Stalling trigger when no new token arrives within interval |
| **Layer 2b**| `ITL_CONSECUTIVE_LIMIT` | `3` | Max consecutive ITL stalls before terminating the stream |
| **Layer 3** | `WS_INTRA_CHUNK_TIMEOUT_MS` | `45000` (45s) | Silence window between chunks (resets on every token) |
| **Layer 4** | `CLIENT_DISCONNECT_GRACE_MS` | `15000` (15s) | Grace window for client cellular handoff or Wi-Fi reconnect |
| **Layer 5** | `SSE_KEEPALIVE_INTERVAL_MS` | `15000` (15s) | `: ping\n\n` comments preventing Cloudflare 100s idle drops |
| **Layer 5b**| `WS_DEAD_PEER_PING_INTERVAL_MS`| `20000` (20s) | Outbound WS ping frames with full jitter |
| **Layer 6** | `JOB_MAX_WALL_TIME_MS` | `300000` (5m) | Absolute execution safety ceiling for any single job |

### Rate Governance & Failover
| Variable | Default | Description |
| :--- | :--- | :--- |
| `TENANT_RATE_LIMIT_PER_SEC` | `50.0` | Continuous leaky bucket drain rate per tenant |
| `TENANT_BURST_CAPACITY` | `100` | Maximum burst token allowance per tenant |
| `MAX_UPSTREAM_RETRIES` | `3` | Maximum automatic shard failovers before reporting failure |
| `RETRY_BASE_DELAY_MS` | `500` | Base exponential backoff delay |
| `RETRY_MAX_DELAY_MS` | `5000` | Maximum backoff ceiling with full jitter |
| `IDEMPOTENCY_TTL_MS` | `120000` (2m) | Time-to-live for prompt deduplication cache |
| `DRAIN_TIMEOUT_MS` | `30000` (30s) | Graceful shutdown drain deadline on SIGINT/SIGTERM |

### PostgreSQL Database
| Variable | Default | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:5432/nova` | Primary PostgreSQL connection string |
| `PGHOST` | `127.0.0.1` | PostgreSQL server hostname |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGUSER` | `postgres` | Database username |
| `PGPASSWORD` | `postgres` | Database password |
| `PGDATABASE` | `nova` | Target database name |

---

## 🔬 Algorithmic Substrates Deep Dive

### 1. Smooth Weighted Round Robin (SWRR)
Standard weighted round robin causes bursty shard selection (e.g. weights `{A: 5, B: 1}` would select `AAAAAB`). NOVA implements **Nginx Smooth Weighted Round Robin**:
1. Every candidate shard starts with a dynamic `currentWeight = 0`.
2. On each lease acquisition:
   $$\text{currentWeight}_i \leftarrow \text{currentWeight}_i + \text{effectiveWeight}_i$$
3. Select shard $k$ with the maximum $\text{currentWeight}$.
4. Deduct the total sum of all weights from the selected shard:
   $$\text{currentWeight}_k \leftarrow \text{currentWeight}_k - \sum_j \text{effectiveWeight}_j$$
This guarantees perfectly interleaved request dispatch (e.g. `AABAACA`), minimizing burst contention and preventing upstream rate limit triggers.

```typescript
import { NovaCredentialPool, NovaCredentialSubstrate } from './src/index.js';

const substrate = new NovaCredentialSubstrate();
const pool = new NovaCredentialPool(substrate, undefined, undefined, 'smooth_weighted_round_robin');
```

---

### 2. Continuous Token Bucket Rate Governor
NOVA implements continuous rate evaluation with sub-millisecond precision:
- **Two-Phase Atomic Reservations:** Before a request is dispatched, NOVA calculates an `estimatedTokens` reservation (prompt tokens + estimated output tokens) and checks both RPM (Requests Per Minute) and TPM (Tokens Per Minute).
- **Automatic Unconsumed Refund:** When the upstream stream concludes with actual token usage (e.g. reserved 4,000, consumed 1,200), the remaining 2,800 tokens are immediately credited back to the shard's bucket.
- **Sliding 3-Hour Quota Log:** Evaluates rolling quota health to throttle shards gracefully prior to provider rejection.

```typescript
// 1. Reserve tokens
const reservation = await pool.acquireLease({
  userId: 'tenant_enterprise',
  provider: 'openai',
  estimatedTokens: 4000
});

// 2. Release with refund
await pool.releaseLease(reservation.lease.leaseId, {
  success: true,
  actualTokensConsumed: 1200 // 2800 tokens automatically refunded!
});
```

---

### 3. Canary Circuit Breaker & Outlier Detection
- **Error Taxonomy Classification:** Categorizes failures into **Transient** (HTTP 502/503/504, network reset, ITL stall) vs. **Terminal** (HTTP 401 Unauthorized, Account Revoked, Invalid Quota).
- **Outlier Shard Quarantine:** A shard incurring 3 consecutive failures enters `cooldown` with AWS full-jitter backoff:
  $$\text{backoff} = \text{random}(0, \min(\text{maxDelay}, \text{baseDelay} \times 2^{\text{failures}}))$$
- **Single-Canary Half-Open Probing:** When the cooldown expires, the shard transitions to `half-open`. Exactly one canary request is admitted. If it succeeds, the shard is restored to `healthy`; if it fails, cooldown doubles.

---

### 4. BroccoliDB Write-Ahead-Log (WAL) Request Queue
High-concurrency workloads are buffered by `NovaRequestQueue`:
- **Crash-Resilient Checkpoints:** Backed by an append-only WAL and atomic filesystem snapshots (`.broccolidb/relay-snapshot.json.tmp` $\to$ rename).
- **Per-Tenant Fairness:** Dispatches requests using a deficit round-robin algorithm across tenant IDs to prevent any single noisy neighbor from monopolizing shard resources.
- **Bounded Waiting Room:** Caps max queue depth (default: 500 requests). Incoming requests beyond capacity are rejected immediately with `HTTP 429` and a `Retry-After` header instead of causing cascading memory failure.

---

### 5. Distributed Fenced Leases
Distributed execution across multiple workers requires split-brain prevention:
- Every lease issued carries a monotonically increasing `fencingToken: bigint`.
- When an execution settles, `PostgresExecutionStore` verifies that the fencing token matches the current database generation via `relay_execution()` stored procedure.
- Stale or orphaned leases from partitioned workers are cleanly rejected.

---

### 6. Zero-Leak Privacy Firewall
Public callers must never gain visibility into internal infrastructure topology:
- **Header Masking:** Strips all `x-shard-id`, `x-account-key`, `cf-ray`, `openai-organization`, and internal routing headers from public responses.
- **Error Sanitization:** All raw upstream stack traces and diagnostic objects are encrypted with AES-256-GCM or masked into standard error codes (`upstream_error`, `quota_exceeded`, `gateway_timeout`).
- **Telemetry Allowlist:** Metrics emitted externally follow strict schema allowlists (`publicJob`, `publicUsage`).

---

## 🗄️ Distilled PostgreSQL Layer (Zero Supabase Bloat)

NOVA eliminates all dependence on Supabase Cloud, Supabase Auth, Edge Functions, Stripe billing webhooks, and `pgvector` extensions. The 159 legacy migrations are distilled into a **single, idempotent, production-ready schema (`db/schema.sql`)**.

### Architectural Distillation Summary

| Legacy Component | Removal Rationale | NOVA Replacement |
| :--- | :--- | :--- |
| `auth.users` & Supabase Auth | Heavy vendor lock-in, external JWT overhead | Direct SHA-256 hashed API keys via `private.nova_relay_principals` |
| `pgvector` & Semantic Embeddings | Memory overhead, unneeded for gateway routing | Clean relational indexing on accounts, leases, and runtimes |
| Stripe Billing & Invoices | Non-core product bloat | Lightweight per-tenant token accounting |
| Persona & Workspace Social Data | Unneeded for inference gateway | Pure shard account credentials and fencing records |
| Supabase Studio & CLI | Complex developer setup | Standard vanilla PostgreSQL 14 - 17+ with zero cloud dependencies |

### Distilled Table Architecture

```
public.nova_shard_accounts
├── id (PK, varchar)
├── account_label, provider, auth_type
├── encrypted_ciphertext, encrypted_iv, encrypted_tag (AES-256-GCM)
├── token_bucket (max_tokens, remaining_tokens, refill_rate)
├── stats (total_requests_served, total_tokens_consumed, average_latency_ms)
└── fencing_token, status, cooldown_until_ms

public.nova_shard_leases
├── id (PK, varchar)
├── shard_id (FK -> nova_shard_accounts.id)
├── fencing_token, reserved_tokens, state
└── expires_at, heartbeat_at

private.nova_relay_principals
├── id (PK, uuid)
├── kind ('runtime' | 'operator' | 'registrar' | 'viewer')
├── token_sha256 (SHA-256 digest of secret token)
└── disabled (boolean)

private.relay_executions
├── execution_id (PK, varchar)
├── status ('reserved' | 'bound' | 'settled' | 'released')
└── account_id, fencing_token, tokens_consumed
```

### Applying Schema & Seed Data
```bash
# 1. Apply single distilled schema:
npm run db:migrate

# 2. Apply schema AND development seed identities:
npm run db:seed
```

Development seed identities provisioned by `db/seed.sql`:
- **Runtime Principal Token:** `nova-dev-runtime-token`
- **Operator Principal Token:** `nova-dev-operator-token`
- **Registrar Principal Token:** `nova-dev-registrar-token`
- **Viewer Principal Token:** `nova-dev-viewer-token`
- **Local Seed Shard:** `nova_sh_000000000000000000000001` (Synthetic healthy OpenAI shard)

---

## 🐳 Production Deployment & Docker Compose

Deploy a complete, production-ready NOVA stack with PostgreSQL using `docker-compose.yml`:

```yaml
version: '3.8'

services:
  nova-postgres:
    image: postgres:17-alpine
    container_name: nova-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: production_postgres_password
      POSTGRES_DB: nova
    volumes:
      - nova-db-data:/var/lib/postgresql/data
      - ./db/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro
      - ./db/seed.sql:/docker-entrypoint-initdb.d/02-seed.sql:ro
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d nova"]
      interval: 5s
      timeout: 5s
      retries: 5

  nova-relay:
    build: .
    container_name: nova-relay
    restart: unless-stopped
    depends_on:
      nova-postgres:
        condition: service_healthy
    environment:
      PORT: "3001"
      HOST: "0.0.0.0"
      RELAY_API_KEY: "prod_live_your_secret_key_here"
      RELAY_ADMIN_KEY: "prod_admin_your_secret_key_here"
      DATABASE_URL: "postgresql://postgres:production_postgres_password@nova-postgres:5432/nova"
      RELAY_MAX_CONCURRENT_REQUESTS: "128"
      RELAY_MAX_RSS_MB: "512"
    ports:
      - "3001:3001"

volumes:
  nova-db-data:
```

### Launch Stack
```bash
docker compose up -d
```

### Graceful Drain & Zero-Downtime Deployment
NOVA handles `SIGTERM` and `SIGINT` signals gracefully:
1. Stops accepting new inbound HTTP requests (`HTTP 503 server_draining`).
2. Grants an active 30-second completion window (`DRAIN_TIMEOUT_MS`) to allow in-flight streaming responses to finish cleanly.
3. Flushes in-memory WAL tables to disk and releases all active leases before exiting with status `0`.

---

## 🛡️ Troubleshooting & Error Taxonomy

| HTTP Status | Error Code | Root Cause | Recommended Remedy |
| :---: | :--- | :--- | :--- |
| `401` | `unauthorized` | Missing or invalid `Authorization: Bearer <key>` header | Verify key with `--api-key` or `RELAY_API_KEYS` |
| `413` | `payload_too_large` | Request body exceeds `MAX_PAYLOAD_BYTES` (2 MB) | Compress payload or truncate excessive message context |
| `429` | `rate_limit_exceeded` | Tenant continuous leaky bucket exceeded burst allowance | Implement exponential backoff respecting `Retry-After` header |
| `429` | `shard_exhausted` | All candidate shards have exhausted their rate bucket | Add more shard accounts to the pool or increase refill rate |
| `502` | `upstream_error` | Upstream provider returned 5xx or unparseable frame | NOVA automatically retries up to `MAX_UPSTREAM_RETRIES` |
| `503` | `server_draining` | Relay is undergoing graceful restart | Resend request after new pod / container instance is healthy |
| `504` | `itl_stall_detected` | Upstream WebSocket stalled with no token for >8s | Gateway automatically terminated stalled stream to free resources |
| `504` | `gateway_timeout` | Total execution exceeded `JOB_MAX_WALL_TIME_MS` (300s) | Narrow request scope or reduce requested `max_tokens` |

---

## 🧪 Testing & Verification

NOVA includes an automated test suite covering unit behaviors, state machines, SWRR algorithms, and end-to-end HTTP/WebSocket streaming:

```bash
# Run complete test suite (17 tests across 6 suites)
npm test

# Run strict TypeScript type verification
npm run typecheck
```

### Test Suite Map
- [credential-pool.test.ts](file:///Users/bozoegg/Downloads/nova/tests/credential-pool.test.ts): SWRR distribution, continuous token buckets, unconsumed refunds, circuit breaker canary probing.
- [pool-queue.test.ts](file:///Users/bozoegg/Downloads/nova/tests/pool-queue.test.ts): BroccoliDB WAL queue persistence, worker round-robin fairness, graceful queue draining.
- [pool-runtime.test.ts](file:///Users/bozoegg/Downloads/nova/tests/pool-runtime.test.ts): Fenced lease binding, settlement sweeps, central coordinator RBAC isolation.
- [postgres-db.test.ts](file:///Users/bozoegg/Downloads/nova/tests/postgres-db.test.ts): Distilled schema validity, seed application, PostgreSQL stored procedure execution.
- [relay-client.test.ts](file:///Users/bozoegg/Downloads/nova/tests/relay-client.test.ts): End-to-end `NovaClient` streaming SSE parsing and synchronous chat against live mock server.
- [relay-server.test.ts](file:///Users/bozoegg/Downloads/nova/tests/relay-server.test.ts): Timing-safe authentication, idempotency deduplication, WebSocket routing, and error masking.

---

## 📂 Project Directory Structure

```
nova/
├── bin/
│   ├── nova.ts                  # Unified CLI runner (relay, pool, migrate)
│   ├── relay.ts                 # Standalone NOVA Relay Gateway CLI
│   ├── pool.ts                  # Standalone NOVA Pool Runtime CLI
│   └── migrate.ts               # Standalone PostgreSQL Migration CLI
├── db/
│   ├── schema.sql               # Single distilled PostgreSQL schema (0 Supabase bloat)
│   └── seed.sql                 # Development seed data (pools, runtimes, principals, shard)
├── src/
│   ├── client/
│   │   ├── relay-client.ts      # NovaClient async SDK (chatStream, chat, generateImage)
│   │   └── stream-parser.ts     # Resilient chunk-level SSE stream parser
│   ├── db/
│   │   ├── postgres.ts          # Native pg pool connection manager & health checker
│   │   └── migrate.ts           # Migration executor for schema.sql and seed.sql
│   ├── pools/
│   │   ├── circuit-breaker.ts   # NovaCircuitBreaker & canary slot governor
│   │   ├── credential-pool.ts   # NovaCredentialPool (SWRR, 2-phase reservations)
│   │   ├── credential-substrate.ts # Reactive shard account registry
│   │   ├── lease-transition.ts  # Health coalescing & state transitions
│   │   ├── pool-central.ts      # Central coordinator HTTP server & RBAC
│   │   ├── pool-contracts.ts    # TypeScript interfaces for pools, accounts & quotas
│   │   ├── pool-execution.ts    # Fenced lease binding & Postgres/Memory execution stores
│   │   ├── pool-image-policy.ts # Dedicated image generation workload policy
│   │   ├── pool-protocol.ts     # Wire protocol contracts & CentralClient
│   │   ├── pool-public-response.ts # Strict public DTO formatters
│   │   ├── pool-request-queue.ts# NovaRequestQueue BroccoliDB WAL queue
│   │   ├── pool-runtime.ts      # NovaPoolRuntime worker coordinator
│   │   ├── pool-scheduler.ts    # Fair queue dispatch scheduler
│   │   └── rate-governor.ts     # NovaRateGovernor continuous token bucket
│   ├── relay/
│   │   ├── admission-lifecycle.ts # Request admission lifecycle hooks
│   │   ├── capability-registry.ts # Shard capability reverse index & routing
│   │   ├── codex-image-tool.ts  # Upstream Codex image alias definitions
│   │   ├── completion-usage.ts  # Token usage extractor
│   │   ├── output-budget.ts     # Output token budget ceiling monitor
│   │   ├── private-failure.ts   # Zero-leak error masking & sanitization
│   │   ├── quota-policy.ts      # Cooldown & quota deadline policies
│   │   ├── relay-server.ts      # NovaRelayServer HTTP/WS engine & 7-layer timeouts
│   │   ├── request-bulkhead.ts  # In-flight concurrency limiters
│   │   ├── request-policy.ts    # JSON body validation & RequestError
│   │   ├── shard-registry.ts    # AES-256-GCM shard credential vault
│   │   └── telemetry.ts         # In-memory telemetry aggregator
│   ├── security/
│   │   └── image-artifact.ts    # Sharp sRGB sanitization & base64 validation
│   ├── storage/
│   │   ├── memory-table.ts      # Standalone BroccoliDbTable in-memory table
│   │   ├── table-aggregation.ts # Table aggregation engine
│   │   └── table-contracts.ts   # Storage interfaces
│   └── index.ts                 # Master library entrypoint exporting public APIs
├── tests/                       # 17 automated unit and integration tests
├── package.json
└── tsconfig.json
```

---

## 🔒 Architectural Boundary Guarantees

1. **Zero External Workspace Dependencies:** `nova` does not import any files from external or parent directories (`../`). All required models, security routines, and storage drivers are self-contained.
2. **Untouched Source Codebase:** The parent GALX codebase remains in its pristine state with zero modifications.
3. **Public Privacy Firewall:** All public DTOs format outputs through strict allowlists, preventing accidental disclosure of upstream telemetry, shard IDs, or internal failure diagnostics.
4. **Idempotent Distilled Database:** `db/schema.sql` can be re-run safely multiple times against any PostgreSQL database without data loss.

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:
1. Fork the repository and create a feature branch (`git checkout -b feature/amazing-feature`).
2. Make your changes and ensure all tests pass: `npm test`.
3. Verify type correctness: `npm run typecheck`.
4. Commit your changes using conventional commit messages: `git commit -m 'feat: add support for streaming function tool calls'`.
5. Push to the branch (`git push origin feature/amazing-feature`) and open a Pull Request.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
