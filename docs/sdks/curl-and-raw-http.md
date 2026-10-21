# cURL & Raw HTTP Wire Protocol

[Wiki Portal](../README.md) > [SDKs](./README.md) > cURL & HTTP

This guide documents connecting to NOVA using cURL and raw HTTP/1.1 or HTTP/2 sockets.

---

## 1. Streaming Server-Sent Events (SSE) with cURL

The `-N` flag disables curl's internal output buffering, allowing tokens to appear in real time:

```bash
curl -N http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-nova-live-demo" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: a8f9b23-1123-4412-a1b2-984f18274a12" \
  -H "x-nova-tenant: analytics-pipeline" \
  -d '{
    "model": "gpt-4o",
    "stream": true,
    "messages": [
      { "role": "system", "content": "You are a network systems expert." },
      { "role": "user", "content": "Explain Server-Sent Events line framing." }
    ]
  }'
```

---

## 2. Synchronous JSON Completion

```bash
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-nova-live-demo" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "stream": false,
    "messages": [
      { "role": "user", "content": "What is 2 + 2?" }
    ]
  }'
```

---

## 3. Raw HTTP/1.1 Wire Frame

```http
POST /v1/chat/completions HTTP/1.1
Host: 127.0.0.1:3001
Authorization: Bearer sk-nova-live-demo
Content-Type: application/json
Content-Length: 124

{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"Ping"}]}
```

Response Wire Format:
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-RateLimit-Limit-Tokens: 500000
X-RateLimit-Remaining-Tokens: 498760

data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"Pong"}}]}

data: [DONE]
```
