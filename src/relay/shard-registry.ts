import * as crypto from 'node:crypto';
import pg from 'pg';
import { REGISTRY_DELTA_SQL, ShardRegistrySync, readRegistryApiDelta } from './shard-registry-sync.js';
import { RegistryEgressGuard, RegistryEgressLimitError } from './registry-egress-guard.js';
import { createRegistryApiPageReader, RegistryApiUnavailableError } from './registry-api-reader.js';
import { resolveDatabaseUrl } from '../db/postgres.js';

let pool: pg.Pool | undefined;
let poolDatabaseUrl: string | undefined;

function getRegistryPool(databaseUrl = registryConfig().databaseUrl): pg.Pool {
  const target = databaseUrl || resolveDatabaseUrl();
  if (pool && poolDatabaseUrl !== target) { void pool.end(); pool = undefined; }
  poolDatabaseUrl = target;
  pool ??= new pg.Pool({ connectionString: target, max: 1, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000, idleTimeoutMillis: 30_000, allowExitOnIdle: true });
  return pool;
}

export interface ClearExpiredCredentialsOptions {
  /** Preview eligible records without changing the registry. */
  dryRun?: boolean;
  /** Restrict cleanup to one registry owner, when supplied by a trusted caller. */
  userId?: string;
  /** In-flight relay shards that must remain untouched. */
  excludeShardIds?: string[];
}

/**
 * Clear expired credentials from the pool by revoking their registry records.
 * Retains ciphertext and audit history for recovery; never deletes credentials.
 * This is a backend administrative operation, not an end-user authorization gate.
 */
export async function clearExpiredCredentials(
  options: ClearExpiredCredentialsOptions = {},
  database?: Pick<pg.PoolClient, 'query'>,
): Promise<{ dryRun: boolean; matchedCount: number; clearedCount: number }> {
  if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
  if (options.userId !== undefined && (typeof options.userId !== 'string' || !options.userId.trim())) throw new TypeError('userId must be a nonempty string');
  if (options.excludeShardIds !== undefined && (!Array.isArray(options.excludeShardIds) || options.excludeShardIds.some(id => typeof id !== 'string' || !id))) throw new TypeError('excludeShardIds must contain nonempty strings');
  const eligible = `credential_expires_at_ms > 0
    AND credential_expires_at_ms <= (EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::bigint
    AND managed_desktop_id IS NULL
    AND permission_retracted = false AND status <> 'revoked'
    AND COALESCE(active_in_flight_count, 0) = 0
    AND ($1::text IS NULL OR user_id = $1)
    AND NOT (id = ANY($2::text[]))`;
  // A single conditional UPDATE checks current expiry under PostgreSQL row locking.
  // A concurrent refresh committed before this update cannot be cleared by a stale list.
  const sql = options.dryRun
    ? `SELECT id FROM public.nova_shard_accounts WHERE ${eligible}`
    : `UPDATE public.nova_shard_accounts SET status = 'revoked', permission_retracted = true,
        updated_at_ms = (EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::bigint,
        updated_at = statement_timestamp()
       WHERE ${eligible} RETURNING id`;
  const result = await (database ?? getRegistryPool()).query(sql, [options.userId ?? null, options.excludeShardIds ?? []]);
  return { dryRun: options.dryRun === true, matchedCount: result.rows.length,
    clearedCount: options.dryRun ? 0 : result.rows.length };
}

export function registryConfig() {
  return {
    databaseUrl: process.env.DATABASE_URL || resolveDatabaseUrl(),
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

let registrySync: ShardRegistrySync | undefined;
let registryScope: string | undefined;
let egressGuard = new RegistryEgressGuard();
let sqlRetryAt = 0;
let retryAt = 0;
let failures = 0;
let apiNextReadAt = 0;

export function configureRegistryEgressGuard(stateFile: string): void {
  if (registrySync) throw new Error('Configure registry guard before synchronization starts');
  egressGuard = new RegistryEgressGuard({ stateFile });
}

/** Available only to the host controller's administrator diagnostics. */
export function getRegistryEgressSnapshot() {
  return { ...egressGuard.snapshot(), retryAt, sqlRetryAt, consecutiveFailures: failures };
}

/** A change-aware, memory-only projection of the encrypted authoritative registry. */
export function readShardRegistry(): Promise<Record<string, any>[]> {
  const { url, key, databaseUrl } = registryConfig();
  // Never reuse credentials across projects or changes in administrator authority.
  const scope = crypto.createHash('sha256').update(JSON.stringify([databaseUrl, url, key])).digest('hex');
  if (!registrySync || registryScope !== scope) {
    retryAt = 0;
    sqlRetryAt = 0;
    failures = 0;
    apiNextReadAt = 0;
    registryScope = scope;
    registrySync = new ShardRegistrySync(async known => {
      try {
      if (databaseUrl && Date.now() >= sqlRetryAt) {
        try {
          const fingerprints = Object.fromEntries([...known].map(([id, entry]) => [id, entry.fingerprint]));
          const delta = await egressGuard.run(async (allowance, charge) => {
            const result = await getRegistryPool(databaseUrl).query(REGISTRY_DELTA_SQL, [JSON.stringify(fingerprints), allowance]);
            if (!result.rows[0]) throw new Error('Missing registry delta');
            charge(Buffer.byteLength(JSON.stringify(result.rows[0])));
            if (result.rows[0].limit_exceeded) throw new RegistryEgressLimitError();
            return result.rows[0];
          });
          failures = 0;
          return delta;
        } catch (error) {
          if (error instanceof RegistryEgressLimitError) throw error;
          sqlRetryAt = Date.now() + 30_000;
          // The admin Data API is the only fallback; never resurrect local credentials.
        }
      }
      // Two exact manifest reads per warm poll need at least three seconds to
      // fit the physical-request budget. Concurrent readers share this wait.
      const delay = apiNextReadAt - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 3000)));
      const delta = await readRegistryApiDelta(known, createRegistryApiPageReader(egressGuard, { url, key }));
      apiNextReadAt = Date.now() + 3000;
      failures = 0;
      return delta;
      } catch (error) {
        retryAt = Math.max(error instanceof RegistryApiUnavailableError ? error.retryAtMs : 0,
          Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(5, failures++)));
        throw error;
      }
    });
  }
  if (Date.now() < retryAt) return Promise.reject(new Error('Registry synchronization is backing off'));
  return registrySync.read();
}

export function decryptRegistryShard(row: Record<string, any>): Record<string, any> | null {
  const version = row.key_version || 'v1';
  const seed = process.env[`GALX_VAULT_KEY_${version.toUpperCase()}`]
    || (version === 'v1' ? process.env.GALX_VAULT_MASTER_SECRET || process.env.GALX_VAULT_KEY : undefined);
  if (!seed) return null;
  try {
    const key = Buffer.from(crypto.hkdfSync('sha256', seed, 'galx-vault-salt-2026', `galx-shard-isolation-${version}`, 32));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.encrypted_iv, 'hex'));
    decipher.setAAD(Buffer.from(`${row.user_id}:${row.id}:${row.provider}`));
    decipher.setAuthTag(Buffer.from(row.encrypted_tag, 'hex'));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_ciphertext, 'hex')), decipher.final(),
    ]).toString('utf8'));
  } catch { return null; }
}

/** Same tenant/shard/provider envelope as the registry reader; no development key fallback. */
export function encryptRegistryShard(row: Record<string, any>, credential: Record<string, unknown>) {
  const keyVersion = process.env.GALX_VAULT_ACTIVE_KEY_VERSION || row.key_version || 'v1';
  if (!/^v[12]$/.test(keyVersion)) throw new Error('Credential encryption unavailable');
  const seed = process.env[`GALX_VAULT_KEY_${keyVersion.toUpperCase()}`]
    || (keyVersion === 'v1' ? process.env.GALX_VAULT_MASTER_SECRET || process.env.GALX_VAULT_KEY : undefined);
  if (!seed || !row.user_id || !row.id || row.provider !== 'openai') throw new Error('Credential encryption unavailable');
  const key = Buffer.from(crypto.hkdfSync('sha256', seed, 'galx-vault-salt-2026', `galx-shard-isolation-${keyVersion}`, 32));
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${row.user_id}:${row.id}:${row.provider}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]); key.fill(0);
  return { encrypted_ciphertext: ciphertext.toString('hex'), encrypted_iv: iv.toString('hex'), encrypted_tag: cipher.getAuthTag().toString('hex'), key_version: keyVersion };
}

/** SQL-only administrator authority. No service-key/REST ingestion fallback. */
export async function enrollRegistryDesktop(desktopId: string, row: Record<string, unknown>, expected?: Record<string, unknown>,
  database?: Pick<pg.PoolClient, 'query'>): Promise<string> {
  const result = await (database ?? getRegistryPool()).query(
    'SELECT private.enroll_desktop_shard($1::uuid,$2::jsonb,$3::jsonb) AS id',
    [desktopId, JSON.stringify(row), expected ? JSON.stringify(expected) : null]);
  if (result.rows[0]?.id !== row.id) throw new Error('Desktop enrollment not confirmed');
  return result.rows[0].id;
}

export const REPLACE_REGISTRY_CREDENTIAL_SQL =
  'SELECT private.refresh_desktop_shard($1::uuid,$2::text,$3::jsonb,$4::jsonb) AS updated';
export async function replaceRegistryCredential(row: Record<string, any>, encrypted: ReturnType<typeof encryptRegistryShard>, expiresAtMs: number,
  database?: Pick<pg.PoolClient, 'query'>): Promise<boolean> {
  if (!row.managed_desktop_id || typeof row.status !== 'string' || ['revoked', 'dead', 'quarantined'].includes(row.status) || row.permission_retracted) return false;
  const result = await (database ?? getRegistryPool()).query(REPLACE_REGISTRY_CREDENTIAL_SQL,
    [row.managed_desktop_id, row.id, JSON.stringify(row), JSON.stringify({ ...encrypted, credential_expires_at_ms: expiresAtMs })]);
  return result.rows[0]?.updated === true;
}
