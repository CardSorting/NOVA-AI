# Cryptographic Vault & Envelope Encryption

[Wiki Portal](../README.md) > [Architecture](./README.md) > Cryptographic Vault

NOVA isolates and safeguards upstream provider credentials using hardware-grade **AES-256-GCM envelope encryption** and **HKDF key derivation**.

---

## Threat Model & Security Invariants

The credential vault is designed to withstand four primary threat vectors:

1. **Compromised Database Snapshots:** If an attacker steals a complete PostgreSQL database backup, zero credentials can be decrypted without the host master secret (`$GALX_VAULT_KEY`).
2. **Ciphertext Transposition Attacks:** An attacker with database write access cannot transplant encrypted credentials from Shard A to Shard B to access a higher quota tier; the decryption algorithm verifies AAD tenant binding.
3. **Side-Channel Timing Attacks:** Verification of API keys against memory registers utilizes constant-time comparison via `crypto.timingSafeEqual()`.
4. **Log Leakage Prevention:** Internal credentials, raw upstream headers, and decryptor objects are stripped before any response crosses the public Northbound gateway boundary.

---

## Cryptographic Pipeline

```
[ Master Secret ($GALX_VAULT_KEY) ]
                │
                ▼ HKDF-SHA256
  - Salt: "galx-vault-salt-2026"
  - Info: "galx-shard-isolation-v1"
                │
                ▼
  [ 256-bit Derived Encryption Key ]
                │
                ▼ AES-256-GCM Encryption
  - Input: Raw API Key (e.g., sk-proj-...)
  - Random IV: 12 bytes
  - AAD: `${user_id}:${shard_id}:${provider}`
                │
                ▼
  [ Ciphertext + 12-byte IV + 16-byte Auth Tag ]
```

---

## Additional Authenticated Data (AAD) Mechanics

When encrypting credentials for a shard account:
- The Additional Authenticated Data buffer is constructed as:
  ```typescript
  const aad = Buffer.from(`${userId}:${shardId}:${provider}`, 'utf-8');
  cipher.setAAD(aad);
  ```
- During decryption, the exact same AAD must be provided.
- If the ciphertext has been modified or moved to a different account row (`shard_id`), the GCM authentication tag verification fails with `Error: Unsupported state or unable to authenticate data`, preventing ciphertext substitution.
