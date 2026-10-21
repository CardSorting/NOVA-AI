import { DesktopCredentialError, credentialClaims, type DesktopCredential } from './desktop-credentials.js';
import { readShardRegistry, decryptRegistryShard, encryptRegistryShard, replaceRegistryCredential } from '../relay/shard-registry.js';
import { CapabilityDiscoveryError, discoverOpenAIModels } from '../relay/capability-discovery.js';
import { createHash } from 'node:crypto';

export interface CredentialRefreshResult { outcome: 'updated' | 'current' }
export interface CredentialTransaction { expectedRevision?: string; desktopId?: string; prepare: (revision: string) => void }
export type RefreshDesktopCredential = (shardId: string, candidate: DesktopCredential, current: () => boolean | Promise<boolean>, checkOnly?: boolean, transaction?: CredentialTransaction) => Promise<CredentialRefreshResult>;
interface Dependencies {
  read: typeof readShardRegistry;
  decrypt: typeof decryptRegistryShard;
  encrypt: typeof encryptRegistryShard;
  replace: typeof replaceRegistryCredential;
  validate: (candidate: DesktopCredential) => Promise<unknown>;
}
export type MatchDesktopCredential = (candidate: DesktopCredential) => Promise<string>;
export function createDesktopCredentialMatch(overrides: Partial<Pick<Dependencies, 'read' | 'decrypt'>> = {}): MatchDesktopCredential {
  const deps = { read: readShardRegistry, decrypt: decryptRegistryShard, ...overrides };
  return async candidate => {
    let rows: Record<string, any>[];
    try { rows = await deps.read(); } catch { throw new DesktopCredentialError('credential_registry_unavailable'); }
    const matches = rows.filter(row => row.provider === 'openai' && !row.permission_retracted && !['revoked', 'dead', 'quarantined'].includes(row.status)
      && deps.decrypt(row)?.accountId === candidate.accountId);
    if (!matches.length) throw new DesktopCredentialError('credential_account_unregistered');
    if (matches.length !== 1) throw new DesktopCredentialError('credential_account_ambiguous');
    return matches[0].id;
  };
}
/** Host-only handoff. No database key or returned credential crosses the desktop HTTP boundary. */
export function createDesktopCredentialRefresh(overrides: Partial<Dependencies> = {}): RefreshDesktopCredential {
  const deps: Dependencies = { read: readShardRegistry, decrypt: decryptRegistryShard, encrypt: encryptRegistryShard,
    replace: replaceRegistryCredential, validate: candidate => discoverOpenAIModels({ id: 'credential-check', ...candidate }, AbortSignal.timeout(10000)), ...overrides };
  return async (shardId, candidate, current, checkOnly = false, transaction) => {
    let row: Record<string, any> | undefined;
    try { row = (await deps.read()).find(r => r.id === shardId); }
    catch { throw new DesktopCredentialError('credential_registry_unavailable'); }
    if (!row || !row.managed_desktop_id || row.managed_desktop_id !== transaction?.desktopId || row.provider !== 'openai' || row.permission_retracted || ['revoked', 'dead', 'quarantined'].includes(row.status)) throw new DesktopCredentialError('credential_not_allowed');
    const previous = deps.decrypt(row);
    if (!previous || typeof previous.accountId !== 'string') throw new DesktopCredentialError('credential_registry_unavailable');
    if (previous.accountId !== candidate.accountId) throw new DesktopCredentialError('credential_account_mismatch');
    const oldToken = previous.accessToken || previous.apiKey;
    if (oldToken === candidate.accessToken && (!candidate.refreshToken || previous.refreshToken === candidate.refreshToken)) return { outcome: 'current' };
    // A previously applied file can confirm authority, but cannot restore an old token family.
    if (checkOnly) throw new DesktopCredentialError('credential_superseded');
    const revision = createHash('sha256').update(JSON.stringify([row.id, row.user_id, row.provider, row.encrypted_iv, row.encrypted_tag, row.key_version ?? null, row.encrypted_ciphertext])).digest('hex');
    // An interrupted write may only retry its original authority version. If it
    // already committed, the current-credential branch above finalizes locally.
    if (transaction?.expectedRevision && transaction.expectedRevision !== revision) throw new DesktopCredentialError('credential_superseded');
    const oldIssued = credentialClaims(oldToken || '').iat;
    if (typeof oldIssued === 'number' && candidate.issuedAtMs < oldIssued * 1000) throw new DesktopCredentialError('credential_older');
    try { await deps.validate(candidate); }
    catch (error) { throw new DesktopCredentialError(error instanceof CapabilityDiscoveryError && error.code === 'invalid_credential' ? 'credential_rejected' : 'credential_check_unavailable'); }
    if (!await current()) throw new DesktopCredentialError('credential_conflict');
    transaction?.prepare(revision);
    try {
      const encrypted = deps.encrypt(row, { accessToken: candidate.accessToken, accountId: candidate.accountId,
        ...(candidate.refreshToken ? { refreshToken: candidate.refreshToken } : {}), expiresAtMs: candidate.expiresAtMs,
        ...(typeof previous.email === 'string' ? { email: previous.email.slice(0, 320) } : {}),
        ...(typeof previous.name === 'string' ? { name: previous.name.slice(0, 256) } : {}) });
      if (!await deps.replace(row, encrypted, candidate.expiresAtMs)) throw new DesktopCredentialError('credential_conflict');
    } catch (error) { if (error instanceof DesktopCredentialError) throw error; throw new DesktopCredentialError('credential_registry_unavailable'); }
    return { outcome: 'updated' };
  };
}
