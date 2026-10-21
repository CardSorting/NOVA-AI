# Local Development Setup Guide

This guide walks through configuring, starting, and verifying a local NOVA instance on macOS or Linux in under 60 seconds.

---

## Prerequisites

- **Node.js:** `>= 20.0.0`
- **npm:** `>= 10.0.0`
- **Git**

No external databases (PostgreSQL, Redis, RabbitMQ) are required for local development. NOVA automatically creates an in-memory BroccoliDB workspace for state checkpoints, prompt idempotency hashes, and the infused BroccoliQueue engine.

---

## 1. Installation

```bash
git clone https://github.com/CardSorting/NOVA-AI.git nova
cd nova
npm install
```

---

## 2. Verify Environment & Tests

Run the full verification suite before starting the servers:
```bash
# 1. Typecheck strict contracts
npm run typecheck

# 2. Run all 23 unit & integration tests
npm test
```

---

## 3. Starting the Relay Gateway

Launch the OpenAI-compatible HTTP and WebSocket relay on port `3001`:

```bash
npx tsx bin/nova.ts relay --port 3001 --api-key sk-nova-local-dev
```

Terminal Output:
```text
======================================================================
   🚀 INFERENCE RELAY SERVER
======================================================================
  Host:        127.0.0.1
  Port:        3001
  API Key:     sk-nova-local-dev
  Admin Key:   key_admin_98af...
----------------------------------------------------------------------
[NOVA Relay] Ready and listening on http://127.0.0.1:3001
```

---

## 4. Sending a Test Inference Request

### Synchronous Non-Streaming Request:
```bash
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-nova-local-dev" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      { "role": "user", "content": "Hello from NOVA local development!" }
    ]
  }'
```

### Streaming Server-Sent Events (SSE):
```bash
curl -N http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-nova-local-dev" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Explain Smooth Weighted Round Robin in 2 sentences." }
    ]
  }'
```

---

## 5. Health & Observability Verification

```bash
# Liveness probe:
curl http://127.0.0.1:3001/health

# Readiness probe:
curl http://127.0.0.1:3001/health/ready

# Prometheus metrics (Requires Admin API Key):
curl -H "Authorization: Bearer <ADMIN_KEY>" http://127.0.0.1:3001/metrics
```
