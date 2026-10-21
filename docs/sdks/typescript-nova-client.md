# Native TypeScript Client (`NovaClient`)

[Wiki Portal](../README.md) > [SDKs](./README.md) > TypeScript Client

NOVA includes a native, zero-dependency async client (`NovaClient`) exported from [src/client/relay-client.ts](file:///Users/bozoegg/Downloads/nova/src/client/relay-client.ts).

---

## 1. Client Initialization

```typescript
import { NovaClient } from './src/index.js';

const client = new NovaClient({
  baseUrl: 'http://127.0.0.1:3001',
  apiKey: 'sk-nova-live-demo',
  tenant: 'production-workload',
  timeoutMs: 60_000
});
```

---

## 2. Streaming Chat Completions (`chatStream`)

Uses native async iterables (`for await`) to consume tokens in real time:

```typescript
async function streamChat() {
  const stream = client.chatStream({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are an expert kernel engineer.' },
      { role: 'user', content: 'Explain zero-copy socket buffer handoffs.' }
    ],
    temperature: 0.7
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      process.stdout.write(delta);
    }
  }
}

streamChat();
```

---

## 3. Synchronous Chat Completion (`chat`)

Aggregates all output tokens into a complete response object:

```typescript
const response = await client.chat({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Summarize continuous token buckets.' }]
});

console.log('Assistant response:', response.choices[0].message.content);
console.log('Tokens used:', response.usage?.total_tokens);
```

---

## 4. Image Synthesis (`generateImage`)

Generates images and parses sanitized Sharp sRGB artifacts:

```typescript
const result = await client.generateImage({
  prompt: 'A minimalist neon logo for an AI relay gateway',
  size: '1024x1024',
  response_format: 'b64_json'
});

console.log('Image dimensions:', `${result.artifact?.width}x${result.artifact?.height}`);
console.log('Sanitized byte length:', result.artifact?.byteLength);
```
