# API Reference: Chat Completions

[Wiki Portal](../README.md) > [APIs](./README.md) > Chat Completions

Generates chat completion responses for conversation messages. Fully compatible with OpenAI wire specifications.

---

## `POST /v1/chat/completions`

### Request Headers
| Header | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `Authorization` | `string` | **Yes** | `Bearer <RELAY_API_KEY>` |
| `Content-Type` | `string` | **Yes** | `application/json` |
| `Idempotency-Key`| `string` | No | Client UUID (max 128 chars) to deduplicate in-flight requests. |
| `x-nova-tenant` | `string` | No | Tenant identifier for fair queue scheduling and quota tracking. |

---

### Request Body Schema

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a distributed systems architect." },
    { "role": "user", "content": "What is Smooth Weighted Round Robin?" }
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "lookup_shard_status",
        "description": "Fetch real-time shard status",
        "parameters": {
          "type": "object",
          "properties": {
            "shard_id": { "type": "string" }
          },
          "required": ["shard_id"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

---

### Streaming SSE Response (`stream: true`)

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-RateLimit-Limit-Tokens: 500000
X-RateLimit-Remaining-Tokens: 498760

data: {"id":"chatcmpl_98a","object":"chat.completion.chunk","created":1729497600,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Smooth"},"finish_reason":null}]}

data: {"id":"chatcmpl_98a","object":"chat.completion.chunk","created":1729497600,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" Weighted Round Robin..."},"finish_reason":null}]}

data: [DONE]
```

---

### Synchronous Response (`stream: false`)

```json
{
  "id": "chatcmpl_98a",
  "object": "chat.completion",
  "created": 1729497600,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Smooth Weighted Round Robin is a load balancing algorithm that smoothly interleaves request dispatch.",
        "tool_calls": null
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 28,
    "completion_tokens": 18,
    "total_tokens": 46
  }
}
```

---

<a id="list-models"></a>
## `GET /v1/models`

Lists eligible models across healthy, active shards in the pool.

### Response Schema:
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o",
      "object": "model",
      "created": 1729497600,
      "owned_by": "relay"
    },
    {
      "id": "gpt-4o-mini",
      "object": "model",
      "created": 1729497600,
      "owned_by": "relay"
    }
  ]
}
```
