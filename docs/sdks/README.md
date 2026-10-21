# Client SDKs & Integration Guides

[Wiki Portal](../README.md) > Client SDKs

Because NOVA strictly implements the standard OpenAI wire protocol, developers can connect using any official or third-party client library.

> [!NOTE]
> **Network Decoupling:** All SDKs and integrations connect to NOVA over standard network wire protocols (HTTP/WebSocket) to an independently running NOVA daemon. Client applications act strictly as external request producers and token consumers, maintaining absolute isolation from NOVA's internal queues and cryptographic vault.

---


<a id="sdk-guides"></a>
## 📦 Available Integration Guides

| Guide / SDK | Language / Framework | Description |
| :--- | :--- | :--- |
| **[Native TypeScript Client (`NovaClient`)](./typescript-nova-client.md)** | TypeScript / Node.js | Native zero-dependency client with automated stream reattachment and image artifact sanitization. |
| **[Official OpenAI Python SDK](./python-openai.md)** | Python 3.9+ | Standard `openai` Python client setup with streaming iterators and error handling. |
| **[LangChain & LangGraph](./langchain-integration.md)** | Python & TypeScript | Integrating NOVA with LangChain `ChatOpenAI` and multi-agent workflows. |
| **[cURL & Raw HTTP Wire Protocol](./curl-and-raw-http.md)** | Shell / Any Language | Terminal cURL examples, HTTP/1.1 wire specification, and raw SSE frame parsing. |
