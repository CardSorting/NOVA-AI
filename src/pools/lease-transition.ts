import type { CredentialStatus } from './pool-contracts.js';

export interface LeaseHealthTransition {
  shardId: string;
  status: CredentialStatus;
  cooldownUntilMs?: number;
  fencingToken?: number;
  expectedRegistryRevision?: number;
  timestampMs: number;
}

/** Local slow-start states are projections, not extra PostgreSQL enum values. */
export function persistedHealthStatus(status: CredentialStatus): string {
  if (status === 'warming_up' || status === 'soft_draining') return 'healthy';
  if (status === 'half_open') return 'cooldown';
  if (status === 'quarantined') return 'exhausted';
  return status;
}

export function coalesceHealthTransitions(items: LeaseHealthTransition[]): LeaseHealthTransition[] {
  const latest = new Map<string, LeaseHealthTransition>();
  for (const item of items) {
    // Unfenced observations cannot change durable account health.
    if (!Number.isSafeInteger(item.fencingToken) || !Number.isSafeInteger(item.expectedRegistryRevision)) continue;
    const previous = latest.get(item.shardId);
    if (!previous || item.fencingToken! > previous.fencingToken!
      || (item.fencingToken === previous.fencingToken && item.timestampMs >= previous.timestampMs)) latest.set(item.shardId, item);
  }
  return [...latest.values()].sort((a, b) => a.shardId.localeCompare(b.shardId));
}

// Compare-and-set against the revision observed when the lease was acquired.
// Usage counters do not advance this revision; recovery and operator changes do.
export const APPLY_LEASE_HEALTH_TRANSITIONS_SQL = `
  WITH locked AS MATERIALIZED (
    SELECT id FROM public.nova_shard_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE
  )
  UPDATE public.nova_shard_accounts AS s
  SET status = c.status::public.nova_credential_status,
      cooldown_until_ms = NULLIF(c.cooldown_ms, 0),
      updated_at_ms = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
      updated_at = clock_timestamp()
  FROM UNNEST($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[])
    AS c(id, status, cooldown_ms, fence, revision), locked
  WHERE s.id = c.id AND locked.id = s.id
    AND s.fencing_token = c.fence AND s.registry_revision = c.revision
    AND NOT s.permission_retracted AND s.status NOT IN ('paused', 'revoked', 'dead')
  RETURNING s.id;
`;
