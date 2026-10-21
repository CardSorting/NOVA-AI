# LangChain & LangGraph Integration

[Wiki Portal](../README.md) > [SDKs](./README.md) > LangChain

Integrate NOVA into LangChain and LangGraph agent pipelines across both Python and TypeScript.

---

## 1. Python (`langchain-openai`)

### Installation:
```bash
pip install langchain-openai
```

### Usage:
```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://127.0.0.1:3001/v1",
    api_key="sk-nova-live-demo",
    model="gpt-4o",
    temperature=0.3,
    model_kwargs={
        "extra_headers": {
            "x-nova-tenant": "enterprise-agent-pipeline"
        }
    }
)

response = llm.invoke("Design a fault-tolerant multi-tenant architecture.")
print(response.content)
```

---

## 2. TypeScript (`@langchain/openai`)

### Installation:
```bash
npm install @langchain/openai @langchain/core
```

### Usage:
```typescript
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  configuration: {
    baseURL: "http://127.0.0.1:3001/v1",
    apiKey: "sk-nova-live-demo",
    defaultHeaders: {
      "x-nova-tenant": "customer-service-bot"
    }
  },
  modelName: "gpt-4o",
  temperature: 0.2
});

async function run() {
  const response = await model.invoke("Summarize continuous token buckets.");
  console.log(response.content);
}

run();
```
