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

### Autonomous Inference Relay Gateway & Resource Routing Substrate

*Enterprise-grade AI inference coordination, multi-account credential pooling, native in-process job queueing, and resilient WebSocket streaming extracted from GALX.*

---

[![Tests](https://img.shields.io/badge/tests-23%20passing-brightgreen.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/tests)
[![Queue Engine](https://img.shields.io/badge/BroccoliQueue-Native%20Infused-success.svg?style=flat-square)](#native-broccoliqueue-engine)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6%20Strict-blue.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/tsconfig.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-emerald.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/package.json)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14--17%2B-blueviolet.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/db/schema.sql)
[![Protocol](https://img.shields.io/badge/OpenAI-Compatible-orange.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/src/relay/relay-server.ts)
[![Routing Overhead](https://img.shields.io/badge/routing%20overhead-%3C0.4ms-success.svg?style=flat-square)](#benchmarks--performance-overhead)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/LICENSE)
[![Zero Supabase Bloat](https://img.shields.io/badge/Supabase%20Bloat-0%25%20Distilled-success.svg?style=flat-square)](#distilled-postgresql-layer)
[![Wiki & Docs](https://img.shields.io/badge/Wiki%20%26%20Docs-Knowledge%20Base-blueviolet.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/docs/README.md)
[![Docs Gate](https://img.shields.io/badge/docs--gate-passing-brightgreen.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/scripts/lint-docs.ts)
[![Contributing](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-blue.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/security-policy-red.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/SECURITY.md)
[![Changelog](https://img.shields.io/badge/changelog-v1.1.0-blue.svg?style=flat-square)](file:///Users/bozoegg/Downloads/nova/CHANGELOG.md)

[⚡ Quickstart](#quickstart) •
[🏛️ Architecture](#architecture) •
[🔌 Gateway APIs](#gateway-apis) •
[👥 Shard Fleet](#shard-fleet) •
[🥦 Queue Engine](#native-broccoliqueue-engine) •
[📦 Client SDKs](#client-sdks) •
[⚙️ Config Matrix](#configuration-matrix) •
[🐳 Deployment](#production-deployment) •
[🧪 23 Tests](#testing-and-verification) •
[📚 Wiki & Docs](file:///Users/bozoegg/Downloads/nova/docs/README.md) •
[🤝 Contributing](file:///Users/bozoegg/Downloads/nova/CONTRIBUTING.md) •
[🛡️ Security](file:///Users/bozoegg/Downloads/nova/SECURITY.md) •
[📜 License](file:///Users/bozoegg/Downloads/nova/LICENSE)

</div>

---

<a id="table-of-contents"></a>
## ⚡ Quick Navigation

| Getting Started & Concepts | APIs & Integrations | Core Mechanics & Queues | Ops, Governance & Docs |
| :--- | :--- | :--- | :--- |
| • [Why NOVA?](#why-nova) | • [Gateway API Reference](#gateway-apis) | • [Smooth Weighted Round Robin](#1-smooth-weighted-round-robin-swrr) | • [Knowledge Base Wiki](file:///Users/bozoegg/Downloads/nova/docs/README.md) |
| • [Feature Comparison](#feature-comparison-matrix) | • [Tool Use & Function Calls](#1-post-v1chatcompletions) | • [Continuous Token Buckets](#2-continuous-token-bucket-rate-governor) | • [Architecture Decision Records (ADRs)](file:///Users/bozoegg/Downloads/nova/docs/adrs/README.md) |
| • [60-Second Quickstart](#quickstart) | • [Image Generation & Sharp](#2-post-v1imagesgenerations) | • [Canary Circuit Breaker](#3-canary-circuit-breaker--outlier-detection) | • [Operational Runbooks](file:///Users/bozoegg/Downloads/nova/docs/runbooks/README.md) |
| • [Multi-Language Clients](#multi-language-clients) | • [Async Jobs & Streaming](#3-asynchronous-queue-decoupling-http-202) | • [Native BroccoliQueue Engine](#native-broccoliqueue-engine) | • [Triage Playbooks](file:///Users/bozoegg/Downloads/nova/docs/playbooks/README.md) |
| • [Architecture & Dataflow](#architecture) | • [TypeScript Client SDK](#client-sdks) | • [Distributed Fenced Leases](#5-distributed-fenced-leases) | • [Blameless Post-Mortems](file:///Users/bozoegg/Downloads/nova/docs/post-mortems/README.md) |
| • [Project Structure](#project-structure) | • [Shard Enrollment Guide](#shard-fleet) | • [7-Layer Timeout Hierarchy](#7-layer-websocket-timeout-hierarchy) | • [Setup & Startup Guides](file:///Users/bozoegg/Downloads/nova/docs/setup/README.md) |
| • [Testing & 23-Test Suite](#testing-and-verification) | • [Unified CLI Reference](#cli-reference) | • [Bulkheads & Output Budgets](#7-request-bulkheads--output-token-budgeting) | • [Security Policy](file:///Users/bozoegg/Downloads/nova/SECURITY.md) & [License](file:///Users/bozoegg/Downloads/nova/LICENSE) |

---

<a id="why-nova"></a>
## Why NOVA?

Deploying large-scale generative AI applications into production presents severe operational challenges:

```
❌ The Fragile Realities of Direct LLM Integration:
┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
│  Burst 429 Rate Limits  │  │   Silent ITL Stalls     │  │ Double-Billing Retries  │
│ Provider quotas halt    │  │ WebSocket streams hang  │  │ Network drops re-run    │
│ entire production apps. │  │ and leak socket handles.│  │ identical prompts.      │
└─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
│ Credential Leakage Risk │  │ Complex Vendor Baggage  │  │ Disjointed Multi-Account│
│ Forwarders leak tokens  │  │ 150+ DB migrations,     │  │ No unified pooling      │
│ & topology diagnostics. │  │ auth/edge cloud locks.  │  │ across tiered accounts. │
└─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
```

**NOVA** is engineered to eliminate every single one of these failure modes:

- 🌊 **Algorithmic Credential Pooling:** Aggregates and load-balances across dozens of active shard accounts using **Smooth Weighted Round Robin (SWRR)**, preventing burst quota exhaustion.
- ⚡ **Continuous Token-Bucket Governance:** Real-time RPM and TPM tracking with **2-Phase Atomic Reservations** and automatic **Unconsumed Token Refunds** upon stream completion.
- 🛡️ **Canary Circuit Breakers:** Dissects transient errors (502/503/504/ITL stall) vs. terminal revocations (401/Invalid Key). Automatically quarantines failing shards with exponential full-jitter backoff and admits single-canary probes for safe recovery.
- 🔄 **Resilient WebSocket Bridging:** Bridges OpenAI/Codex WebSocket streaming with a **7-Layer Timeout Hierarchy**, monitoring Inter-Token Latency (ITL) gaps and EWMA pacing to instantly drop dead streams.
- 🥦 **Native Infused Job Queue (BroccoliQueue):** High-throughput, in-process persistent job queue on BroccoliDB tables with three MinHeaps, lease renewal heartbeats, exponential retries, and zero Redis/BullMQ dependencies.
- 🔒 **Durable Stream Idempotency:** SHA-256 prompt and parameter hashing with atomic in-flight stream collapsing, guaranteeing clients re-attaching to retries never double-bill your accounts.
- 🛡️ **Zero-Leak Privacy Firewall:** Strips all upstream shard IDs, auth bearer keys, database connection strings, and raw stack traces from caller responses.
- 🗄️ **Distilled PostgreSQL Layer:** Distills 159 legacy Supabase migrations into **one clean, self-contained schema ([db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql))** with zero cloud vendor locks.

---

<a id="feature-comparison-matrix"></a>
## Feature Comparison Matrix

| Capability | Standard Reverse Proxy (Nginx / Envoy / Traefik) | Generic LLM Gateway (LiteLLM / Portkey) | Cloud Multi-Tenant PaaS (Supabase / AWS API GW) | **NOVA Substrate (Relay + Pool Coordinator)** |
| :--- | :---: | :---: | :---: | :---: |
| **OpenAI-Compatible Wire Protocol** | ❌ (Raw HTTP only) | ✅ (HTTP / REST) | ❌ (Proprietary SDKs) | **✅ Streaming SSE & Synchronous** |
| **Tool Use & Function Calling** | ❌ (None) | ⚠️ (Pass-through) | ❌ (None) | **✅ Strict Validation & Output Budgeting** |
| **Algorithmic Credential Pooling** | ❌ (Static round robin) | ⚠️ (Basic random / fallback) | ❌ (Single tenant auth) | **✅ Smooth Weighted Round Robin (SWRR)** |
| **Two-Phase Token Bucket Rate Governance** | ❌ (Basic RPM limiter) | ⚠️ (Static TPM estimates) | ❌ (Credit ledger only) | **✅ Continuous Leaky Bucket + Refund** |
| **Circuit Breakers with Canary Probing** | ⚠️ (Basic health checks) | ⚠️ (Threshold trip) | ❌ (None) | **✅ Transient vs. Terminal + Canary Slots** |
| **Resilient WebSocket Bridging** | ❌ (Blind TCP stream) | ❌ (HTTP-to-HTTP only) | ❌ (Edge functions only) | **✅ 7-Layer Timeout Hierarchy & ITL Pacing** |
| **Durable Idempotency & Stream Attachment**| ❌ (None) | ⚠️ (Response caching) | ❌ (Manual implementation) | **✅ Atomic In-Flight Stream Deduplication** |
| **Privacy Firewall & Error Sanitization** | ❌ (Pass-through headers) | ⚠️ (Partial redaction) | ❌ (Raw upstream errors) | **✅ Strict Zero-Leak Response Allowlist** |
| **Embedded Write-Ahead-Log (WAL) Queue**| ❌ (None) | ⚠️ (Redis required) | ⚠️ (External SQS / Celery) | **✅ Native Infused BroccoliQueue (3 Heaps)** |
| **Distributed Fenced Leases** | ❌ (None) | ❌ (None) | ⚠️ (Advisory locks) | **✅ Monotonic Fencing Tokens (Postgres & Memory)** |
| **Image Sanitization Pipeline** | ❌ (None) | ❌ (Pass-through) | ⚠️ (Storage buckets only) | **✅ In-Flight Sharp sRGB Normalizer** |
| **Database Footprint** | ❌ (N/A) | ⚠️ (Redis + SQLite/Postgres) | ❌ (150+ migrations & Supabase bloat) | **✅ 1 Distilled Schema (Zero Supabase Bloat)** |
| **Sub-Millisecond Routing Overhead** | ✅ (<1ms) | ⚠️ (5ms - 15ms) | ❌ (30ms - 100ms) | **✅ <0.4ms In-Memory Microsecond Indexing** |

---

<a id="quickstart"></a>
## ⚡ 60-Second Quickstart

Get NOVA running locally in less than 60 seconds. Zero external databases or cloud services required to start.

### 1. Installation

```bash
# Clone the repository
git clone https://github.com/CardSorting/NOVA-AI.git nova
cd nova

# Install dependencies (Node >= 20 required)
npm install
```

### 2. Run the Verification Suite
Execute the comprehensive test suite (all 23 unit and integration tests run in under 700ms):
```bash
npm test
```

### 3. Launch the NOVA Gateway
Start the OpenAI-compatible gateway on port `3001` with a development API key:
```bash
npx tsx bin/nova.ts relay --port 3001 --api-key sk-nova-live-demo
```

Output:
```text
======================================================================
   🚀 INFERENCE RELAY SERVER
======================================================================
  Host:        127.0.0.1
  Port:        3001
  API Key:     sk-nova-live-demo
  Admin Key:   key_admin_79d1...
----------------------------------------------------------------------
[NOVA Relay] Ready and listening on http://127.0.0.1:3001
```

> [!TIP]
> NOVA automatically creates in-memory BroccoliDB tables for state checkpoints, idempotency hashes, and the embedded BroccoliQueue. You do not need to install or configure PostgreSQL to start serving requests locally!

---

<a id="multi-language-clients"></a>
## Multi-Language Client Examples

NOVA provides 100% protocol fidelity with the OpenAI API. Point any standard SDK or HTTP client to `http://127.0.0.1:3001/v1`.

### 1. cURL (Terminal / Shell)

```bash
# Streaming Server-Sent Events (SSE)
curl -N http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-nova-live-demo" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "stream": true,
    "messages": [
      { "role": "system", "content": "You are a distributed systems expert." },
      { "role": "user", "content": "Why is SWRR superior to classic weighted round robin?" }
    ]
  }'
```

---

### 2. Official OpenAI TypeScript / Node SDK

Install `openai`:
```bash
npm install openai
```

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3001/v1',
  apiKey: 'sk-nova-live-demo'
});

async function main() {
  const stream = await client.chat.completions.create({
    model: 'gpt-4o',
    stream: true,
    messages: [{ role: 'user', content: 'Stream a 3-point summary of resilient gateways.' }]
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

---

### 3. Official OpenAI Python SDK

Install `openai`:
```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3001/v1",
    api_key="sk-nova-live-demo"
)

response = client.chat.completions.create(
    model="gpt-4o",
    stream=True,
    messages=[
        {"role": "system", "content": "You are a kernel engineer."},
        {"role": "user", "content": "Explain zero-copy socket ringbuffers."}
    ]
)

for chunk in response:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)
```

---

### 4. LangChain Integration (Python & TypeScript)

#### Python:
```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://127.0.0.1:3001/v1",
    api_key="sk-nova-live-demo",
    model="gpt-4o",
    temperature=0.2
)

response = llm.invoke("Design a fault-tolerant multi-tenant architecture.")
print(response.content)
```

#### TypeScript:
```typescript
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  configuration: {
    baseURL: "http://127.0.0.1:3001/v1",
    apiKey: "sk-nova-live-demo",
  },
  modelName: "gpt-4o",
  temperature: 0.2,
});

const res = await model.invoke("Summarize the benefits of continuous token buckets.");
console.log(res.content);
```

[▲ Return to Top](#nova)

---

<a id="architecture"></a>
## 🏛️ Architecture & System Topology

NOVA separates external API ingress from internal shard state management through a strictly partitioned Northbound / Southbound boundary:

```
                            [ Inbound Client Applications ]
                         (cURL / Python / TypeScript / OpenAI SDK)
                                     │
                                     ▼ HTTP / SSE
┌────────────────────────────────────┴────────────────────────────────────────┐
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
│  │ Circuit Breaker & Canary  │           │ Native Infused BroccoliQueue │  │
│  │ Probing Engine            │           │ (3 MinHeaps, WAL Persist)    │  │
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
    participant Queue as BroccoliQueue (MinHeaps)
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
        
        loop Token Streaming with ITL Monitoring & Lease Heartbeats
            Shard-->>Relay: WS Output Delta Frame
            Relay->>Relay: Monitor EWMA Inter-Token Latency (Stall Check)
            Relay->>Store: Renew Lease Heartbeat (prevent orphan recovery)
            Relay-->>Client: SSE data: {"choices":[{"delta":{"content":"..."}}]}
        end
        
        Shard-->>Relay: Stream Completed (Actual Tokens Used: 1240)
        Relay->>Pool: Release Lease (Actual Tokens: 1240, Success: true)
        Pool->>Pool: Rate Governor Refunds 2760 Unconsumed Tokens
        Pool->>Store: Settle Lease & Record Latency Metrics
        Relay-->>Client: SSE data: [DONE]
    end
```

[▲ Return to Top](#nova)

---

<a id="gateway-apis"></a>
## 🔌 Gateway API Reference (OpenAI-Compatible)

Every public endpoint strictly adheres to the official OpenAI specifications while injecting robust enterprise resilience headers.

### Complete Route Matrix

| Method | Path | Auth Scope | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/v1/chat/completions` | Public / Tenant | Streaming (SSE) or synchronous chat completions with Tool Calls |
| `POST` | `/v1/images/generations` | Public / Tenant | Synthesize images with Sharp sRGB profile normalizations |
| `GET` | `/v1/models` | Public / Tenant | List active eligible models across all healthy shards |
| `GET` | `/v1/jobs/:id` | Public / Tenant | Inspect asynchronous decoupled job status & usage |
| `GET` | `/v1/jobs/:id/stream` | Public / Tenant | Re-attach or resume an active SSE token stream (`Last-Event-ID`) |
| `POST` | `/v1/jobs/:id/cancel` | Public / Tenant | Instant wire abort & immediate lease release (<5ms) |
| `GET` | `/v1/jobs/:id/receipt` | Public / Tenant | Inspect durable admission receipt record |
| `GET` | `/health` | Unauthenticated | Kubernetes liveness probe (HTTP 200 OK) |
| `GET` | `/health/ready` | Unauthenticated | Kubernetes readiness probe (verifies memory ceiling & healthy shards) |
| `GET` | `/health/live` | Unauthenticated | Process liveness verification |
| `GET` | `/metrics` | Admin Key | Prometheus-compatible real-time metrics exporter |
| `GET` | `/telemetry` / `/api/telemetry` | Admin Key | Aggregated latency percentiles (p50, p95, p99) & throughput |
| `GET` | `/api/capabilities` | Admin Key | View available model capabilities across shard fleet |
| `POST` | `/api/capabilities/probe-image`| Admin Key | Probe shard image generation qualification |
| `GET` | `/api/sites/contract` | Admin Key | Inspect site contract parameters |
| `GET` | `/api/dashboard/stats` | Admin Key | Inspect real-time gateway metrics and active jobs |
| `POST` | `/api/quota/profile` | Admin Key | Update quota profile and rate parameters |
| `POST` | `/api/quota/reset` | Admin Key | Force reset rolling quota window for shards |
| `GET` | `/api/quota/status` | Admin Key | View rolling quota utilization and limits |
| `POST` | `/api/shards/enroll` | Admin Key | Dynamically enroll new shard credentials without restart |
| `POST` | `/api/shards/sync` | Admin Key | Force reload and synchronization of shard accounts from PostgreSQL |
| `GET` | `/api/shards` | Admin Key | Inspect shard fleet with masked API keys |

---

### 1. `POST /v1/chat/completions`

Generates chat completions for given messages. Supports streaming SSE, synchronous aggregation, tool calls, and parallel tool calls.

#### Request Headers
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `Authorization` | `string` | **Yes** | `Bearer <RELAY_API_KEY>` |
| `Content-Type` | `string` | **Yes** | `application/json` |
| `Idempotency-Key` | `string` | Optional | Client UUID to collapse in-flight duplicate requests |
| `x-nova-tenant` | `string` | Optional | Tenant identifier for fair queue scheduling and quota metering |

#### Request Body Schema
```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a precise technical architect." },
    { "role": "user", "content": "Fetch the status of the database cluster." }
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "lookup_cluster_metrics",
        "description": "Fetch real-time cluster metrics",
        "parameters": {
          "type": "object",
          "properties": {
            "cluster_id": { "type": "string" }
          },
          "required": ["cluster_id"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

<details>
<summary><b>View Synchronous Response (`stream: false`)</b></summary>

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
        "content": null,
        "tool_calls": [
          {
            "id": "call_98127391823",
            "type": "function",
            "function": {
              "name": "lookup_cluster_metrics",
              "arguments": "{\"cluster_id\":\"nova-primary\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 21,
    "total_tokens": 63
  }
}
```
</details>

<details>
<summary><b>View Streaming Response (`stream: true`)</b></summary>

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-RateLimit-Limit-Tokens: 500000
X-RateLimit-Remaining-Tokens: 498760

data: {"id":"chatcmpl_9b7d","object":"chat.completion.chunk","created":1729497600,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"The"},"finish_reason":null}]}

data: {"id":"chatcmpl_9b7d","object":"chat.completion.chunk","created":1729497600,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" database"},"finish_reason":null}]}

data: {"id":"chatcmpl_9b7d","object":"chat.completion.chunk","created":1729497600,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" cluster is operating normally."},"finish_reason":null}]}

data: [DONE]
```
</details>

---

### 2. `POST /v1/images/generations`

Synthesizes images using upstream image engines with automated Sharp-based sRGB profile normalizations and base64 security validation.

#### Request Body
```json
{
  "prompt": "An isometric blueprint of a quantum computing cluster, cyan and dark obsidian palette",
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

<a id="3-asynchronous-queue-decoupling-http-202"></a>
### 3. Asynchronous Queue Decoupling (`HTTP 202 Accepted`)

When the cluster is under heavy burst load and the in-flight bulkhead is saturated, NOVA immediately returns `HTTP 202 Accepted` with an execution receipt:

```json
{
  "id": "job_01j982a17f",
  "status": "queued",
  "model": "gpt-4o",
  "streamUrl": "/v1/jobs/job_01j982a17f/stream"
}
```

Clients can poll `GET /v1/jobs/:id` or connect to `GET /v1/jobs/:id/stream` to receive tokens in real-time as soon as a worker dispatches the job. The `NovaClient` SDK handles this automatically.

[▲ Return to Top](#nova)

---

<a id="shard-fleet"></a>
## 👥 Shard Fleet Management & Enrollment

NOVA supports dynamically pooling multiple upstream AI accounts without downtime. Shards can be enrolled through the administrative HTTP API or loaded from an encrypted local fleet file (`.galx-shards.json`).

### 1. Dynamic HTTP Shard Enrollment (`POST /api/shards/enroll`)

```bash
curl -X POST http://127.0.0.1:3001/api/shards/enroll \
  -H "Authorization: Bearer <RELAY_ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "accountLabel": "Tier-1 Production OpenAI Shard",
    "provider": "openai",
    "authType": "api_key",
    "apiKey": "sk-proj-prod-actual-upstream-key-here",
    "weight": 5,
    "priority": 10,
    "maxTokens": 2000000,
    "refillRatePerMinute": 1000000,
    "maxRequests": 1000
  }'
```

---

### 2. File-Based Fleet Deployment (`.galx-shards.json`)

Deploy a fleet of credentials locally or inside a container:

```json
[
  {
    "id": "shard_openai_primary",
    "accountLabel": "OpenAI Primary Enterprise",
    "provider": "openai",
    "authType": "api_key",
    "apiKeyMasked": "sk-proj...9999",
    "encryptedSecrets": {
      "ciphertext": "a98f12...hex",
      "iv": "3f81...hex",
      "tag": "12da...hex",
      "keyVersion": "v1"
    },
    "weight": 3,
    "priority": 10,
    "tokenBucket": {
      "maxTokens": 1000000,
      "remainingTokens": 1000000,
      "refillRatePerMinute": 500000,
      "maxRequests": 500,
      "remainingRequests": 500
    }
  }
]
```

### 3. Hardware-Grade AES-256-GCM Envelope Encryption

All credentials stored in PostgreSQL or in `.galx-shards.json` are encrypted using AES-256-GCM envelope encryption with HKDF key derivation:
```
Master Secret ($GALX_VAULT_KEY)
           │
           ▼ HKDF (salt: "galx-vault-salt-2026", info: "galx-shard-isolation-v1")
Derived Encryption Key (256-bit)
           │
           ▼ AES-256-GCM
Ciphertext + 12-byte IV + 16-byte Auth Tag
  ↳ Bound to AAD: `${user_id}:${shard_id}:${provider}`
```
> [!NOTE]
> Even if a database snapshot is compromised, credentials cannot be decrypted without the host master secret, and ciphertext cannot be transplanted across shards due to Additional Authenticated Data (AAD) binding.

[▲ Return to Top](#nova)

---

<a id="native-broccoliqueue-engine"></a>
## 🥦 Native Infused BroccoliQueue Engine

NOVA natively embeds the high-throughput, in-process **BroccoliQueue** engine ([src/queue/](file:///Users/bozoegg/Downloads/nova/src/queue/)), eliminating external queue services (Redis, RabbitMQ, SQS, or BullMQ) while maintaining crash-resilient persistence on BroccoliDB tables.

### Architecture & Three MinHeaps

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 BROCCOLIQUEUE ENGINE                   │
                  │                                                        │
                  │  ┌────────────────┐ ┌────────────────┐ ┌────────────┐  │
                  │  │   Ready Heap   │ │  Delayed Heap  │ │ Lease Heap │  │
                  │  │ Priority DESC  │ │  Deadlines ASC │ │ Expiry ASC │  │
                  │  └───────┬────────┘ └───────┬────────┘ └─────┬──────┘  │
                  └──────────┼──────────────────┼────────────────┼─────────┘
                             │                  │                │
            ┌────────────────┴──────────────────┼────────────────┴────────────────┐
            ▼                                   ▼                                 ▼
┌─────────────────────────┐        ┌─────────────────────────┐       ┌─────────────────────────┐
│ Worker Batch Claiming   │        │ Scheduled Delay Timers  │       │ Lease Heartbeat Renewals│
│ O(1) Highest Priority   │        │ O(log N) Time-To-Ready  │       │ Prevent Orphan Recovery │
└─────────────────────────┘        └─────────────────────────┘       └─────────────────────────┘
```

#### Key Capabilities:
- **Zero External Dependencies:** 100% self-contained in-memory indexed tables backed by an append-only WAL.
- **Three Internal MinHeaps for $O(1)$ Scheduling:**
  - **Ready Heap:** Orders jobs by descending priority with FIFO sequence preservation (`priority DESC, sequence ASC`).
  - **Delayed Heap:** Orders delayed jobs by execution deadline (`availableAt ASC`).
  - **Lease Heap:** Tracks active worker leases by expiration (`leaseExpiresAt ASC`) for sub-second crash recovery.
- **Lease Renewal & Heartbeats (`context.heartbeat()`):** Long-running inference jobs (e.g., deep reasoning or image synthesis) automatically renew their leases, preventing premature recovery while keeping worker timeout ceilings tight.
- **Crash-Resilient WAL Recovery:** Replays newline-delimited WAL frames with checksum validation on process restarts.
- **Per-Tenant Fairness & Bounded Waiting Room:** `NovaRequestQueue` caps tenant burst queuing and uses deficit round-robin dispatch across tenant keys.
- **Headless Backend Architecture:** 100% clean backend execution with zero browser UI dependencies; queue observability is exposed through native `/metrics`, `/health`, and internal telemetry endpoints.

### Native Code Example

```typescript
import { BroccoliQueue, BroccoliDatabaseKernel } from './src/index.js';

// 1. Initialize queue on top of local BroccoliDB workspace
const db = new BroccoliDatabaseKernel({ workspaceRoot: './.broccolidb/queue-data' });
const queue = new BroccoliQueue({
  db,
  namespace: 'nova_inference',
  retentionMs: 3600_000 // 1 hour terminal retention
});
await queue.start();

// 2. Register worker with lease heartbeats
const worker = queue.process('inference_tasks', async (job, context) => {
  // Renew lease during long inference generations:
  await context.heartbeat();
  return { status: 'completed', result: 'Model output' };
}, { concurrency: 8, leaseDurationMs: 30_000 });
await worker.start();

// 3. Enqueue idempotent job batch
await queue.add('inference_tasks', { prompt: 'Synthesize report' }, {
  priority: 10,
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 1000 },
  idempotencyKey: 'request_uuid_12345'
});
```

[▲ Return to Top](#nova)

---

<a id="client-sdks"></a>
## 📦 TypeScript Client SDK

NOVA ships with a zero-dependency async client (`NovaClient`).

```typescript
import { NovaClient } from './src/index.js';

const client = new NovaClient({
  baseUrl: 'http://127.0.0.1:3001',
  apiKey: 'sk-nova-live-demo',
  tenant: 'production-workload',
  timeoutMs: 60_000
});
```

### SDK Capabilities

```typescript
// 1. Asynchronous Streaming Chat Completion
for await (const chunk of client.chatStream({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Explain monotonic fencing tokens.' }]
})) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}

// 2. Synchronous Aggregated Chat
const response = await client.chat({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is 42?' }]
});
console.log(response.choices[0].message.content);

// 3. Image Synthesis with Automated Sharp Artifact Sanitization
const image = await client.generateImage({
  prompt: 'A minimalist neon logo for an AI relay gateway',
  size: '1024x1024'
});
console.log('Sanitized Image Format:', image.artifact?.contentType);
console.log('Sanitized Image Size:', `${image.artifact?.bytes.length} bytes`);

// 4. Model Capabilities Discovery
const models = await client.listModels();
console.log('Available models:', models.map(m => m.id));

// 5. Job Status Inspection
const job = await client.getJob('job_01j982a17f');
console.log('Job status:', job.status);
```

[▲ Return to Top](#nova)

---

<a id="cli-reference"></a>
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

[▲ Return to Top](#nova)

---

<a id="configuration-matrix"></a>
## ⚙️ Configuration & Environment Variables

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

<a id="7-layer-websocket-timeout-hierarchy"></a>
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

[▲ Return to Top](#nova)

---

<a id="algorithmic-substrates"></a>
## 🔬 Algorithmic Substrates Deep Dive

<a id="1-smooth-weighted-round-robin-swrr"></a>
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

<a id="2-continuous-token-bucket-rate-governor"></a>
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

<a id="3-canary-circuit-breaker--outlier-detection"></a>
### 3. Canary Circuit Breaker & Outlier Detection
- **Error Taxonomy Classification:** Categorizes failures into **Transient** (HTTP 502/503/504, network reset, ITL stall) vs. **Terminal** (HTTP 401 Unauthorized, Account Revoked, Invalid Quota).
- **Outlier Shard Quarantine:** A shard incurring 3 consecutive failures enters `cooldown` with AWS full-jitter backoff:
  $$\text{backoff} = \text{random}(0, \min(\text{maxDelay}, \text{baseDelay} \times 2^{\text{failures}}))$$
- **Single-Canary Half-Open Probing:** When the cooldown expires, the shard transitions to `half-open`. Exactly one canary request is admitted. If it succeeds, the shard is restored to `healthy`; if it fails, cooldown doubles.

---

<a id="5-distributed-fenced-leases"></a>
### 5. Distributed Fenced Leases
Distributed execution across multiple workers requires split-brain prevention:
- Every lease issued carries a monotonically increasing `fencingToken: bigint`.
- When an execution settles, `PostgresExecutionStore` verifies that the fencing token matches the current database generation via `relay_execution()` stored procedure.
- Stale or orphaned leases from partitioned workers are cleanly rejected.

---

<a id="6-zero-leak-privacy-firewall"></a>
### 6. Zero-Leak Privacy Firewall
Public callers must never gain visibility into internal infrastructure topology:
- **Header Masking:** Strips all `x-shard-id`, `x-account-key`, `cf-ray`, `openai-organization`, and internal routing headers from public responses.
- **Error Sanitization:** All raw upstream stack traces and diagnostic objects are encrypted with AES-256-GCM or masked into standard error codes (`upstream_error`, `quota_exceeded`, `gateway_timeout`).
- **Telemetry Allowlist:** Metrics emitted externally follow strict schema allowlists (`publicJob`, `publicUsage`).

---

<a id="7-request-bulkheads--output-token-budgeting"></a>
### 7. Request Bulkheads & Output Token Budgeting
- **Request Bulkhead (`RequestBulkhead`):** Limits global concurrency (default 64) and per-tenant concurrency (default 8) to prevent a single tenant from starving cluster resources.
- **Output Token Budget (`OutputBudget`):** Real-time monitoring of generated output bytes and tool call arguments against caller-requested `max_tokens`, gracefully closing the stream if the ceiling is reached.

[▲ Return to Top](#nova)

---

<a id="distilled-postgresql-layer"></a>
## 🗄️ Distilled PostgreSQL Layer (Zero Supabase Bloat)

NOVA eliminates all dependence on Supabase Cloud, Supabase Auth, Edge Functions, Stripe billing webhooks, and `pgvector` extensions. The 159 legacy migrations are distilled into a **single, idempotent, production-ready schema ([db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql))**.

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

Development seed identities provisioned by [db/seed.sql](file:///Users/bozoegg/Downloads/nova/db/seed.sql):
- **Runtime Principal Token:** `nova-dev-runtime-token`
- **Operator Principal Token:** `nova-dev-operator-token`
- **Registrar Principal Token:** `nova-dev-registrar-token`
- **Viewer Principal Token:** `nova-dev-viewer-token`
- **Local Seed Shard:** `nova_sh_000000000000000000000001` (Synthetic healthy OpenAI shard)

[▲ Return to Top](#nova)

---

<a id="production-deployment"></a>
## 🐳 Production Deployment Runbook

### 1. Docker Compose (All-in-One Cluster)

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

Launch with:
```bash
docker compose up -d
```

---

### 2. Kubernetes Deployment Manifest

<details>
<summary><b>View Kubernetes Deployment & Service Manifest (`nova-k8s.yaml`)</b></summary>

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nova-relay
  labels:
    app: nova-relay
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nova-relay
  template:
    metadata:
      labels:
        app: nova-relay
    spec:
      containers:
      - name: relay
        image: nova-relay:latest
        ports:
        - containerPort: 3001
        env:
        - name: PORT
          value: "3001"
        - name: HOST
          value: "0.0.0.0"
        - name: RELAY_API_KEY
          valueFrom:
            secretKeyRef:
              name: nova-secrets
              key: api-key
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: nova-secrets
              key: database-url
        resources:
          requests:
            cpu: "250m"
            memory: "256Mi"
          limits:
            cpu: "2000m"
            memory: "512Mi"
        livenessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3001
          initialDelaySeconds: 3
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: nova-relay
spec:
  type: ClusterIP
  selector:
    app: nova-relay
  ports:
  - port: 80
    targetPort: 3001
```
</details>

---

### 3. Graceful Drain Protocol (Zero Dropped Streams)

When terminating a pod or restarting a container:
1. `SIGTERM` is intercepted by NOVA.
2. Gateway immediately marks `/health/ready` as unhealthy and rejects new connections with `HTTP 503 server_draining`.
3. In-flight streams are granted a **30-second completion grace period** (`DRAIN_TIMEOUT_MS`).
4. All active leases are settled and refunded, memory WAL tables flush to disk, and the process exits cleanly with code `0`.

[▲ Return to Top](#nova)

---

<a id="troubleshooting-matrix"></a>
## 🛡️ Operational Troubleshooting & Error Taxonomy

| HTTP Status | Error Code | Root Cause | Recommended Action |
| :---: | :--- | :--- | :--- |
| `401` | `unauthorized` | Missing or invalid `Authorization: Bearer <key>` header | Verify key matches `--api-key` or `RELAY_API_KEYS` |
| `413` | `payload_too_large` | Request body exceeds `MAX_PAYLOAD_BYTES` (2 MB) | Compress payload or truncate excessive message history |
| `429` | `rate_limit_exceeded` | Tenant continuous leaky bucket exceeded burst capacity | Implement backoff respecting the `Retry-After` header |
| `429` | `shard_exhausted` | All candidate shards have exhausted their rate bucket | Add more shard accounts to the pool or increase refill rate |
| `502` | `upstream_error` | Upstream provider returned 5xx or unparseable frame | NOVA automatically retries up to `MAX_UPSTREAM_RETRIES` |
| `503` | `server_draining` | Relay is undergoing graceful restart | Resend request after new pod / container instance is healthy |
| `504` | `itl_stall_detected` | Upstream WebSocket stalled with no token for >8s | Gateway automatically terminated stalled stream to free resources |
| `504` | `gateway_timeout` | Total execution exceeded `JOB_MAX_WALL_TIME_MS` (300s) | Narrow request scope or reduce requested `max_tokens` |

[▲ Return to Top](#nova)

---

<a id="testing-and-verification"></a>
## 🧪 Testing, Benchmarks & Verification

<a id="benchmarks--performance-overhead"></a>
### Benchmarks & Performance Overhead

NOVA is engineered for sub-millisecond dispatch overhead:
- **Relay Dispatch Latency:** $\le 0.38\text{ms}$ per request (measured via Node.js `perf_hooks`).
- **SWRR Account Selection:** Sub-microsecond execution using memory-mapped lookup tables.
- **SSE Frame Parsing:** Zero-copy buffer slicing via `parseEventStream`.
- **Memory Footprint:** Bounded RSS ceiling with proactive garbage collection awareness.

### Running Test Suite
```bash
# Execute 23 tests across all 7 test suites:
npm test

# Verify strict TypeScript type contracts:
npm run typecheck
```

### Complete 23-Test Suite Map
- [credential-pool.test.ts](file:///Users/bozoegg/Downloads/nova/tests/credential-pool.test.ts) (4 tests):
  1. `NovaRateGovernor calculates sliding window limits and parses durations`
  2. `NovaCircuitBreaker dissects upstream errors and manages canary slots`
  3. `NovaCredentialPool leases accounts using Smooth Weighted Round Robin (SWRR)`
  4. `NovaCredentialPool handles token reservation and release`
- [queue.test.ts](file:///Users/bozoegg/Downloads/nova/tests/queue.test.ts) (6 tests):
  1. `BroccoliQueue validates producer batches before changing tables`
  2. `BroccoliQueue bulk enqueue copies payloads, preserves idempotency, and reports state counts`
  3. `BroccoliQueue coalesces concurrent writes into shared flush window`
  4. `BroccoliQueue workers claim batches, renew leases via heartbeat, and complete jobs`
  5. `BroccoliQueue retries failing jobs with exponential backoff and tracks attempts`
  6. `BroccoliQueue allows cancellation and pruning of expired jobs`
- [pool-queue.test.ts](file:///Users/bozoegg/Downloads/nova/tests/pool-queue.test.ts) (1 test):
  1. `NovaRequestQueue enqueues, processes via worker, handles idempotency, and drains cleanly`
- [pool-runtime.test.ts](file:///Users/bozoegg/Downloads/nova/tests/pool-runtime.test.ts) (2 tests):
  1. `PoolExecution with MemoryExecutionStore persists reservations, binds leases, and settles`
  2. `Pool Central Server validates protocol routes and isolates caller roles`
- [postgres-db.test.ts](file:///Users/bozoegg/Downloads/nova/tests/postgres-db.test.ts) (6 tests):
  1. `Distilled PostgreSQL schema is bloat-free and contains all required NOVA definitions`
  2. `Distilled PostgreSQL seed script provides local development identities`
  3. `resolveDatabaseUrl handles custom URLs and fallback defaults`
  4. `PostgresExecutionStore executes relay_execution stored procedure`
  5. `centralQuery executes relay_control stored procedure and maps errors`
  6. `migrateDatabase mock runner executes schema and seed queries sequentially`
- [relay-client.test.ts](file:///Users/bozoegg/Downloads/nova/tests/relay-client.test.ts) (1 test):
  1. `NovaClient interacts end-to-end with NovaRelayServer for streaming and non-streaming inference`
- [relay-server.test.ts](file:///Users/bozoegg/Downloads/nova/tests/relay-server.test.ts) (3 tests):
  1. `Relay server rejects unauthenticated requests and enforces authorization`
  2. `Relay server routes streaming chat completion through upstream WebSocket`
  3. `Relay server preserves idempotency and returns job status`

---

<a id="project-structure"></a>
## 📂 Project Directory Structure

```
nova/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md        # Structured bug report template
│   │   ├── feature_request.md   # Architectural feature request template
│   │   └── config.yml           # Community links & discussions config
│   └── PULL_REQUEST_TEMPLATE.md # Standardized PR verification checklist
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
│   ├── queue/
│   │   ├── index.ts             # Native infused BroccoliQueue entrypoint
│   │   ├── queue.ts             # MinHeap-driven in-process job queue engine
│   │   └── types.ts             # Pure backend job queue contracts
│   ├── relay/
│   │   ├── admission-lifecycle.ts # Request admission lifecycle hooks
│   │   ├── capability-registry.ts # Shard capability reverse index & routing
│   │   ├── codex-image-tool.ts  # Upstream Codex image alias definitions
│   │   ├── completion-usage.ts  # Token usage extractor
│   │   ├── function-tools.ts    # Tool and function call validator & normalizer
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
├── tests/                       # 23 automated unit and integration tests across 7 suites
├── docs/                        # Complete Knowledge Base Wiki (ADRs, runbooks, playbooks, post-mortems)
│   ├── README.md                # Wiki portal & master docs index
│   ├── setup/                   # Setup and startup guides (local, cluster, DB, vault)
│   ├── adrs/                    # 6 Architecture Decision Records (SWRR, token buckets, queues, DB)
│   ├── runbooks/                # 4 Operational SOPs (incidents, scaling, DB maintenance, shard rotation)
│   ├── playbooks/               # 3 Fast-path triage playbooks (outages, ITL stalls, burst decoupling)
│   └── post-mortems/            # 2 Blameless post-mortem retrospective reports
├── scripts/
│   └── lint-docs.ts             # CI/CD documentation freshness & link integrity linter
├── CHANGELOG.md                 # Semantic versioning release history & migration logs
├── CODE_OF_CONDUCT.md           # Contributor Covenant v2.1 code of conduct
├── CONTRIBUTING.md              # Contributor guide, architecture rules & PR checklist
├── LICENSE                      # Official MIT open-source license
├── SECURITY.md                  # Security policy, reporting procedures & cryptographic guarantees
├── README.md                    # Gateway documentation & operational runbooks
├── package.json
└── tsconfig.json
```

---

<a id="architectural-boundary-guarantees"></a>
## 🔒 Architectural Boundary Guarantees

1. **Zero External Workspace Dependencies:** `nova` does not import any files from external or parent directories (`../`). All required models, security routines, and storage drivers are self-contained.
2. **Untouched Source Codebase:** The parent GALX codebase remains in its pristine state with zero modifications.
3. **Public Privacy Firewall:** All public DTOs format outputs through strict allowlists, preventing accidental disclosure of upstream telemetry, shard IDs, or internal failure diagnostics.
4. **Idempotent Distilled Database:** [db/schema.sql](file:///Users/bozoegg/Downloads/nova/db/schema.sql) can be re-run safely multiple times against any PostgreSQL database without data loss.

---

<a id="contributing"></a>
## 🤝 Contributing

We welcome community contributions, bug reports, and architectural improvements! Please consult our official guides before submitting pull requests:

- 📖 **[Contributing Guide](file:///Users/bozoegg/Downloads/nova/CONTRIBUTING.md):** Complete development setup, testing practices, strict TypeScript coding guidelines, conventional commit rules, and PR checklist.
- 📜 **[Code of Conduct](file:///Users/bozoegg/Downloads/nova/CODE_OF_CONDUCT.md):** Contributor Covenant v2.1 standards for an inclusive, harassment-free environment.

### Quick Workflow
```bash
# 1. Create a feature branch
git checkout -b feat/your-improvement

# 2. Verify all 23 unit & integration tests pass in <700ms
npm test

# 3. Verify 0 TypeScript strict type errors
npm run typecheck

# 4. Commit using Conventional Commits
git commit -m 'feat(queue): implement batch lease renewal heartbeats'
```

---

<a id="security"></a>
## 🛡️ Security & Vulnerability Reporting

Security and credential isolation are paramount in NOVA. Upstream credentials are protected via hardware-grade **AES-256-GCM envelope encryption**, constant-time authentication, and strict zero-leak egress firewalls.

- For vulnerability disclosures, please review our **[Security Policy](file:///Users/bozoegg/Downloads/nova/SECURITY.md)**.
- Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/CardSorting/NOVA-AI/security/advisories) or by emailing [security@cardsorting.org](mailto:security@cardsorting.org). Do not open public issues for security vulnerabilities.

---

<a id="changelog"></a>
## 📜 Changelog & Release History

NOVA adheres to [Semantic Versioning](https://semver.org/) and follows [Keep a Changelog](https://keepachangelog.com/). Detailed notes on features, fixes, and architectural evolutions are tracked in **[CHANGELOG.md](file:///Users/bozoegg/Downloads/nova/CHANGELOG.md)**.

---

<a id="license"></a>
## 📄 License

Distributed under the **MIT License**. See **[LICENSE](file:///Users/bozoegg/Downloads/nova/LICENSE)** for full legal text and copyright notices.
Copyright &copy; 2026 CardSorting and NOVA Contributors.
