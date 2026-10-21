import { createHmac } from 'node:crypto';
import { DesktopCredentialError, credentialClaims, type DesktopCredential } from './desktop-credentials.js';
import { readShardRegistry, decryptRegistryShard, encryptRegistryShard, enrollRegistryDesktop } from '../relay/shard-registry.js';
import { discoverOpenAIModels, CapabilityDiscoveryError } from '../relay/capability-discovery.js';

export type EnrollDesktopCredential = (desktopId: string, candidate: DesktopCredential,
  expectedShardId: string | null, current: () => Promise<boolean>) => Promise<string>;

/** Called only for an explicit administrator action on a persisted, running desktop. */
export function createDesktopEnrollment(overrides: Partial<{
  read: typeof readShardRegistry; decrypt: typeof decryptRegistryShard; encrypt: typeof encryptRegistryShard;
  write: typeof enrollRegistryDesktop; validate: (candidate: DesktopCredential) => Promise<unknown>;
  identitySecret: () => string | undefined;
}> = {}): EnrollDesktopCredential {
  const deps = { read: readShardRegistry, decrypt: decryptRegistryShard, encrypt: encryptRegistryShard,
    write: enrollRegistryDesktop, validate: (c: DesktopCredential) => discoverOpenAIModels({ id: 'desktop-enrollment', ...c }, AbortSignal.timeout(10000)),
    identitySecret: () => process.env.GALX_SHARD_ID_SECRET || process.env.GALX_VAULT_MASTER_SECRET, ...overrides };
  return async (desktopId, candidate, expectedShardId, current) => {
    const secret = deps.identitySecret();
    if (!secret) throw new DesktopCredentialError('credential_registry_unavailable');
    const rows = await deps.read();
    // Include revoked/dead matches: a different ID must never bypass revocation.
    const matches = rows.filter(row => row.provider === 'openai' && deps.decrypt(row)?.accountId === candidate.accountId);
    if (matches.length > 1) throw new DesktopCredentialError('credential_account_ambiguous');
    const existing = matches[0];
    if (expectedShardId && existing?.id !== expectedShardId) throw new DesktopCredentialError('credential_account_mismatch');
    if (existing && (existing.permission_retracted || ['revoked', 'dead', 'quarantined'].includes(existing.status)
      || existing.managed_desktop_id && existing.managed_desktop_id !== desktopId)) throw new DesktopCredentialError('credential_not_allowed');
    if (existing) {
      const previous = deps.decrypt(existing);
      const issued = credentialClaims(previous?.accessToken || '').iat;
      if (typeof issued === 'number' && candidate.issuedAtMs < issued * 1000) throw new DesktopCredentialError('credential_older');
    }
    try { await deps.validate(candidate); }
    catch (e) { throw new DesktopCredentialError(e instanceof CapabilityDiscoveryError && e.code === 'invalid_credential' ? 'credential_rejected' : 'credential_check_unavailable'); }
    if (!await current()) throw new DesktopCredentialError('credential_conflict');
    const id = existing?.id || `codex_sh_${createHmac('sha256', secret).update(`openai:${candidate.accountId}`).digest('hex').slice(0,24)}`;
    const row = existing || { id, user_id: 'system_admin', provider: 'openai' };
    const encrypted = deps.encrypt(row, { accessToken: candidate.accessToken, accountId: candidate.accountId,
      ...(candidate.refreshToken ? { refreshToken: candidate.refreshToken } : {}), expiresAtMs: candidate.expiresAtMs });
    try { return await deps.write(desktopId, { id, user_id: row.user_id, ...encrypted, credential_expires_at_ms: candidate.expiresAtMs }, existing); }
    catch { throw new DesktopCredentialError('credential_registry_unavailable'); }
  };
}
