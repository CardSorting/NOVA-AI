# ADR-0006: Hardware-Grade AES-256-GCM Envelope Encryption

## Status
**Accepted** (2026-10-20)

## Context
NOVA manages a pool of high-privilege upstream AI provider credentials. If credentials were stored in plaintext or weakly encrypted, a database snapshot compromise, unmasked SQL log, or multi-tenant data leak would compromise all connected accounts.

Furthermore, multi-tenant databases are susceptible to *ciphertext transposition attacks*, where valid ciphertext from Shard A is copied into Shard B's database row to impersonate or access higher quota tiers.

## Decision
We implemented **AES-256-GCM Envelope Encryption** with **HKDF Key Derivation** and **AAD Binding** in [src/relay/shard-registry.ts](file:///Users/bozoegg/Downloads/nova/src/relay/shard-registry.ts):

### Cryptographic Invariants:
1. **HKDF-SHA256 Derivation:** A 256-bit key is derived from the master secret (`$GALX_VAULT_KEY`) with fixed salt (`galx-vault-salt-2026`) and application info context (`galx-shard-isolation-v1`).
2. **Authenticated Ciphertext:** Each credential payload produces a random 12-byte IV, AES-256-GCM ciphertext, and a 16-byte authentication tag.
3. **Additional Authenticated Data (AAD):** Ciphertext authentication is bound to `${user_id}:${shard_id}:${provider}`. If a ciphertext block is copied to another row, decryption fails automatically.

## Consequences

### Positive:
- **Zero Exposure on DB Dump:** Compromised database dumps cannot be decrypted without the host master secret.
- **Transposition Immunity:** Ciphertext cannot be transplanted across shards or accounts.
- **Constant-Time Operations:** Credential retrieval verifies tags without side-channel leaks.

### Negative:
- Loss of the master secret permanently invalidates all stored shard credentials.
