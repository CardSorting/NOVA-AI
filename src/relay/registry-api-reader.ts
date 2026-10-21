import { RegistryEgressGuard, RegistryEgressLimitError, readBoundedRegistryJson } from './registry-egress-guard.js';
import type { RegistryPage, RegistryPageReader, RegistryRow } from './shard-registry-sync.js';

export class RegistryApiUnavailableError extends Error {
  constructor(readonly retryAtMs = 0) { super('Registry API temporarily unavailable'); }
}

function retryDeadline(value: string | null, now: number): number {
  if (!value) return 0;
  const timestamp = /^\d+(?:\.\d+)?$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(Math.ceil(timestamp)) ? Math.max(now, Math.ceil(timestamp)) : 0;
}

/** Only exact range evidence can end a nonempty page. Never trust page length. */
export function registryPage(rows: unknown, range: string | null, offset: number): RegistryPage {
  if (!Array.isArray(rows)) throw new Error('Invalid registry response');
  if (!range || range.endsWith('/*')) return { rows, complete: rows.length === 0 };
  const match = /^(?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(range);
  if (!match) throw new Error('Invalid registry response range');
  const total = Number(match[3]);
  if (!Number.isSafeInteger(total) || total > 2048) throw new RegistryEgressLimitError();
  if (match[1] === undefined) {
    if (rows.length || offset < total) throw new Error('Incomplete registry response range');
    return { rows, complete: true };
  }
  const first = Number(match[1]), last = Number(match[2]);
  if (first !== offset || last < first || last >= total || last - first + 1 !== rows.length) {
    throw new Error('Inconsistent registry response range');
  }
  return { rows: rows as RegistryRow[], complete: last + 1 === total };
}

/** Server-only, one physical request permit per page and one cap/deadline per snapshot. */
export function createRegistryApiPageReader(guard: RegistryEgressGuard, options: {
  url?: string; key?: string; userId?: string; fetch?: typeof fetch; timeoutMs?: number; beforeRequest?: () => void;
}): RegistryPageReader {
  const { key, url, userId } = options;
  let privileged = key?.startsWith('sb_secret_');
  if (key && !privileged) {
    try { privileged = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'service_role'; } catch {}
  }
  if (!url || !key || !privileged) throw new Error('Shard registry requires a Supabase URL and backend admin credential');
  const endpoint = new URL(process.env.NOVA_REGISTRY_PATH || '/rest/v1/nova_shard_accounts', url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Invalid registry endpoint');
  const policy = guard.snapshot().policy;
  let remaining = policy.maxResponseBytes;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  return async (columns, offset, ids) => {
    deadline.throwIfAborted();
    options.beforeRequest?.();
    return guard.run(async (allowance, charge) => {
      remaining -= policy.overheadBytes;
      const target = new URL(endpoint);
      target.searchParams.set('select', columns);
      target.searchParams.set('order', 'id.asc');
      target.searchParams.set('offset', String(offset));
      target.searchParams.set('limit', '64');
      target.searchParams.set('relay_pool_id', 'is.null');
      if (userId !== undefined) target.searchParams.set('user_id', `eq.${userId}`);
      if (ids) target.searchParams.set('id', `in.(${ids.map(id => JSON.stringify(id)).join(',')})`);
      const response = await (options.fetch ?? fetch)(target, {
        headers: { apikey: key, Prefer: 'count=exact',
          ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) },
        signal: deadline, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RegistryApiUnavailableError(retryDeadline(response.headers.get('retry-after'), Date.now()));
      }
      const rows = await readBoundedRegistryJson(response, allowance, bytes => { remaining -= bytes; charge(bytes); }, deadline);
      deadline.throwIfAborted();
      if (Array.isArray(rows) && rows.length > 64) throw new RegistryEgressLimitError();
      return registryPage(rows, response.headers.get('content-range'), offset);
    }, { maxResponseBytes: Math.max(0, remaining - policy.overheadBytes) });
  };
}
