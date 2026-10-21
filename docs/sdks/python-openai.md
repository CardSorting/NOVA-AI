# Official OpenAI Python SDK Integration

[Wiki Portal](../README.md) > [SDKs](./README.md) > Python OpenAI

Because NOVA is 100% protocol-compatible with the OpenAI API, you can point the official `openai` Python package directly to your NOVA gateway.

---

## 1. Installation

```bash
pip install openai
```

---

## 2. Client Initialization

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3001/v1",
    api_key="sk-nova-live-demo"
)
```

---

## 3. Streaming Chat Completion

```python
response = client.chat.completions.create(
    model="gpt-4o",
    stream=True,
    messages=[
        {"role": "system", "content": "You are a distributed systems architect."},
        {"role": "user", "content": "Why is Smooth Weighted Round Robin superior to random load balancing?"}
    ]
)

for chunk in response:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)
print()
```

---

## 4. Handling Rate Limits & Retries

NOVA returns standard `HTTP 429` headers (`Retry-After`) when tenant quotas are saturated. The official SDK respects these headers:

```python
import time
from openai import RateLimitError

try:
    completion = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "Hello!"}]
    )
    print(completion.choices[0].message.content)
except RateLimitError as e:
    print(f"Rate limited by NOVA rate governor: {e}")
```
