# API Reference: Image Generations

[Wiki Portal](../README.md) > [APIs](./README.md) > Image Generations

Generates images from textual prompts with automated Sharp-based sRGB profile normalizations and base64 validation.

---

## `POST /v1/images/generations`

### Request Headers
| Header | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `Authorization` | `string` | **Yes** | `Bearer <RELAY_API_KEY>` |
| `Content-Type` | `string` | **Yes** | `application/json` |
| `Idempotency-Key`| `string` | No | Prevents duplicate generation charges on retries. |

---

### Request Body Schema

```json
{
  "prompt": "An isometric technical blueprint of a distributed cluster, dark obsidian and cyan palette",
  "model": "gpt-image-1",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

---

### Response Body Schema

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

## Sharp sRGB Normalization & Security Pipeline

Before returning synthesized image buffers to the caller, NOVA executes an in-flight security pass via `sharp`:
1. **Malicious Payload Guard:** Validates image headers to prevent polyglot file attacks and buffer overflow exploits.
2. **Color Profile Normalization:** Converts vendor-specific or wide-gamut ICC profiles into clean, standardized sRGB.
3. **Artifact Metadata Verification:** Validates exact pixel dimensions (`width`, `height`) and byte length ceilings (`MAX_IMAGE_PAYLOAD_BYTES`).
