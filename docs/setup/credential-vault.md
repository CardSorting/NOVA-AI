# AES-256-GCM Credential Vault Setup Guide

This guide details the cryptographic architecture, master key generation, and dynamic enrollment procedures for safeguarding upstream AI credentials in NOVA.

---

## Cryptographic Architecture

NOVA protects upstream provider credentials (OpenAI, Codex, Anthropic API keys) using **hardware-grade AES-256-GCM envelope encryption** combined with **HKDF (HMAC-based Key Derivation Function)**:

```
Master Secret ($GALX_VAULT_KEY)
           │
           ▼ HKDF-SHA256 (salt: "galx-vault-salt-2026", info: "galx-shard-isolation-v1")
Derived Encryption Key (256-bit)
           │
           ▼ AES-256-GCM
Ciphertext + 12-byte IV + 16-byte Auth Tag
  ↳ Authenticated with AAD: `${user_id}:${shard_id}:${provider}`
```

### Additional Authenticated Data (AAD) Transposition Defense
Even if an attacker obtains a full database dump, ciphertexts cannot be swapped across shard accounts or tenants because the cryptographic MAC tag requires matching the exact `${user_id}:${shard_id}:${provider}` string at decryption time.

---

## 1. Generating a Secure Master Secret

Generate a cryptographically secure 256-bit master secret:

```bash
# Generate 32 bytes (64 hex characters)
openssl rand -hex 32
```

Export this secret in your environment:
```bash
export GALX_VAULT_KEY="<YOUR_64_CHARACTER_HEX_SECRET>"
```

---

## 2. Dynamic HTTP Shard Enrollment

Enroll new shard credentials dynamically without restarting the gateway:

```bash
curl -X POST http://127.0.0.1:3001/api/shards/enroll \
  -H "Authorization: Bearer <RELAY_ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "accountLabel": "Production Tier-1 Shard",
    "provider": "openai",
    "authType": "api_key",
    "apiKey": "sk-proj-actual-upstream-api-key",
    "weight": 5,
    "priority": 10,
    "maxTokens": 2000000,
    "refillRatePerMinute": 1000000,
    "maxRequests": 1000
  }'
```

Response:
```json
{
  "status": "enrolled",
  "shardId": "shard_01j98a287f",
  "accountLabel": "Production Tier-1 Shard",
  "apiKeyMasked": "sk-proj...87f"
}
```

---

## 3. Fleet File Configuration (`.galx-shards.json`)

To bootstrap credentials without an HTTP call, populate an encrypted fleet file in the working directory:

```json
[
  {
    "id": "shard_prod_01",
    "accountLabel": "OpenAI Primary Enterprise",
    "provider": "openai",
    "authType": "api_key",
    "apiKeyMasked": "sk-proj...9999",
    "encryptedSecrets": {
      "ciphertext": "a98f1293847a...hex",
      "iv": "3f8102938472...hex",
      "tag": "12da84729384...hex",
      "keyVersion": "v1"
    },
    "weight": 5,
    "priority": 10,
    "tokenBucket": {
      "maxTokens": 2000000,
      "remainingTokens": 2000000,
      "refillRatePerMinute": 1000000,
      "maxRequests": 1000,
      "remainingRequests": 1000
    }
  }
]
```
