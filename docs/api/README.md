# Gateway API Reference

[Wiki Portal](../README.md) > Gateway API Reference

NOVA provides 100% wire-protocol compatibility with the official OpenAI API, allowing you to use existing client SDKs, tools, and libraries without modifying client-side code.

---

<a id="api-endpoints"></a>
## 🔌 API Endpoints Matrix

| Endpoint | Method | Scope | Description |
| :--- | :---: | :---: | :--- |
| **[/v1/chat/completions](./chat-completions.md)** | `POST` | Public | Streaming SSE or synchronous chat completion with function tool calls. |
| **[/v1/images/generations](./image-generations.md)** | `POST` | Public | Synthesize images with Sharp sRGB profile normalizations. |
| **[/v1/jobs/:id](./jobs-and-streaming.md)** | `GET` | Public | Inspect asynchronous decoupled job status. |
| **[/v1/jobs/:id/stream](./jobs-and-streaming.md)** | `GET` | Public | Re-attach or resume an active SSE stream (`Last-Event-ID`). |
| **[/v1/jobs/:id/cancel](./jobs-and-streaming.md)** | `POST` | Public | Instantly abort in-flight job and release shard lease ($<5\text{ms}$). |
| **[/v1/models](./chat-completions.md#list-models)** | `GET` | Public | List available models across healthy shards. |
| **[Admin & Telemetry](./admin-and-telemetry.md)** | Various | Admin | Inspect metrics (`/metrics`), latency telemetry, and manage shard accounts. |

---

<a id="authentication"></a>
## 🔑 Authentication

Public endpoints require a Bearer token in the `Authorization` header:

```http
Authorization: Bearer sk-nova-your-api-key-here
```

Administrative endpoints (`/metrics`, `/api/shards/*`, `/api/quota/*`) require the operator admin key (`RELAY_ADMIN_KEY`).
