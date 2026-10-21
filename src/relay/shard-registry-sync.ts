/** Server-only registry projection. Every read checks authority; only changes cross the wire. */
export const REGISTRY_COLUMNS = [
  'id', 'user_id', 'provider', 'status', 'permission_retracted', 'managed_desktop_id', 'desktop_enrolled_at',
  'encrypted_ciphertext', 'encrypted_iv', 'encrypted_tag', 'key_version',
  'credential_expires_at_ms', 'cooldown_until_ms', 'registry_revision', 'created_at',
] as const;

export type RegistryRow = Record<string, unknown> & { id: string };
export interface RegistryChange { fingerprint: string; row: RegistryRow }
export interface RegistryDelta { changed: RegistryChange[]; removed: string[]; limit_exceeded?: boolean }
const MAX_REGISTRY_ROWS = 2048;

// One MVCC snapshot covers updates AND deletions. Hash the actual projection so
// delete/recreate, credential rotation, and status changes cannot reuse stale data.
// No database function, elevated privilege, or migration is needed.
export const REGISTRY_DELTA_SQL = `
  WITH registry AS MATERIALIZED (
    SELECT ${REGISTRY_COLUMNS.map(column => `s.${column}`).join(', ')},
      encode(sha256(convert_to(ROW(${REGISTRY_COLUMNS.map(column => `s.${column}`).join(', ')})::text, 'UTF8')), 'hex') AS fingerprint
    FROM public.nova_shard_accounts AS s WHERE s.relay_pool_id IS NULL ORDER BY s.id LIMIT ${MAX_REGISTRY_ROWS + 1}
  ), delta AS MATERIALIZED (
  SELECT COALESCE((
    SELECT jsonb_agg(jsonb_build_object('fingerprint', r.fingerprint, 'row', to_jsonb(r) - 'fingerprint') ORDER BY r.id)
    FROM registry AS r WHERE r.fingerprint IS DISTINCT FROM ($1::jsonb ->> r.id)
  ), '[]'::jsonb) AS changed,
  COALESCE((
    SELECT jsonb_agg(k.id ORDER BY k.id)
    FROM jsonb_object_keys($1::jsonb) AS k(id)
    WHERE NOT EXISTS (SELECT 1 FROM registry AS r WHERE r.id = k.id)
  ), '[]'::jsonb) AS removed
  ), bounded AS (
    SELECT *, (octet_length(changed::text) + octet_length(removed::text) + 128 > $2::integer
      OR (SELECT count(*) FROM registry) > ${MAX_REGISTRY_ROWS}) AS limit_exceeded FROM delta
  )
  SELECT CASE WHEN limit_exceeded THEN '[]'::jsonb ELSE changed END AS changed,
    CASE WHEN limit_exceeded THEN '[]'::jsonb ELSE removed END AS removed, limit_exceeded FROM bounded
`;

export class ShardRegistrySync {
  private entries = new Map<string, RegistryChange>();
  private inFlight?: Promise<RegistryRow[]>;

  constructor(
    private readonly load: (known: ReadonlyMap<string, RegistryChange>) => Promise<RegistryDelta>,
    private readonly columns: readonly string[] = REGISTRY_COLUMNS,
  ) {}

  async read(): Promise<RegistryRow[]> {
    // No TTL or stale-on-error return: revocations keep the existing polling bound.
    this.inFlight ??= this.refresh().finally(() => { this.inFlight = undefined; });
    // Callers cannot mutate the credential cache or another concurrent caller's rows.
    return structuredClone(await this.inFlight);
  }

  private async refresh(): Promise<RegistryRow[]> {
    const delta = await this.load(this.entries);
    if (delta?.limit_exceeded) throw new Error('Registry response exceeds synchronization limits');
    if (!delta || !Array.isArray(delta.changed) || !Array.isArray(delta.removed)) throw new Error('Invalid registry delta');
    const next = new Map(this.entries);
    const seen = new Set<string>();
    for (const id of delta.removed) {
      if (typeof id !== 'string' || seen.has(id)) throw new Error('Invalid registry deletion');
      seen.add(id);
      next.delete(id);
    }
    for (const entry of delta.changed) {
      if (!entry || typeof entry.fingerprint !== 'string' || !entry.fingerprint
        || typeof entry.row?.id !== 'string' || !entry.row.id || seen.has(entry.row.id)
        || this.columns.some(column => !Object.hasOwn(entry.row, column))) throw new Error('Invalid registry change');
      seen.add(entry.row.id);
      const row = Object.fromEntries(this.columns.map(column => [column, entry.row[column]])) as RegistryRow;
      next.set(row.id, { fingerprint: entry.fingerprint, row });
    }
    if (next.size > MAX_REGISTRY_ROWS) throw new Error('Registry row limit exceeded');
    this.entries = next; // Commit only a complete, validated authoritative response.
    return [...next.values()].map(entry => entry.row).sort((a, b) => a.id.localeCompare(b.id));
  }
}

export interface RegistryPage { rows: RegistryRow[]; complete: boolean }
export type RegistryPageReader = (columns: string, offset: number, ids?: string[]) => Promise<RegistryRow[] | RegistryPage>;
const MANIFEST_COLUMNS = 'id,registry_revision,created_at';
const restFingerprint = (row: RegistryRow) => {
  if (row.registry_revision == null || typeof row.created_at !== 'string') throw new Error('Invalid registry revision');
  return `rest:${JSON.stringify([String(row.registry_revision), row.created_at])}`;
};

/** Data API fallback transfers metadata on polls and fetches credentials only for changed IDs. */
export async function readRegistryApiDelta(known: ReadonlyMap<string, RegistryChange>, page: RegistryPageReader, options: {
  columns?: readonly string[]; manifestColumns?: string; fingerprint?: (row: RegistryRow) => string;
  reuseCachedPayload?: (cached: RegistryRow, manifest: RegistryRow) => boolean;
} = {}): Promise<RegistryDelta> {
  const columns = options.columns ?? REGISTRY_COLUMNS;
  const manifestColumns = options.manifestColumns ?? MANIFEST_COLUMNS;
  const fingerprint = options.fingerprint ?? restFingerprint;
  let pages = 0;
  const readAll = async (columns: string, ids?: string[]) => {
    const rows: RegistryRow[] = [];
    const seen = new Set<string>();
    for (let offset = 0; ; ) {
      if (++pages > 64) throw new Error('Registry pagination limit exceeded');
      const result = await page(columns, offset, ids);
      const batch = Array.isArray(result) ? result : result?.rows;
      if (!Array.isArray(batch) || batch.some(row => !row || typeof row.id !== 'string' || !row.id)) throw new Error('Invalid registry response');
      for (const row of batch) {
        if (seen.has(row.id)) throw new Error('Inconsistent registry pagination');
        seen.add(row.id);
      }
      if (rows.length + batch.length > MAX_REGISTRY_ROWS) throw new Error('Registry row limit exceeded');
      rows.push(...batch);
      // A validated exact Content-Range avoids redundant empty-page requests.
      // Without one, a short page is not EOF: the server may enforce a smaller cap.
      if (!batch.length || (!Array.isArray(result) && result.complete === true)) break;
      offset += batch.length;
    }
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Inconsistent registry pagination');
    return rows;
  };
  const manifest = await readAll(manifestColumns);
  const changedIds = manifest.filter(row => {
    const cached = known.get(row.id);
    return !cached || fingerprint(cached.row) !== fingerprint(row);
  }).map(row => row.id);
  const changed: RegistryChange[] = [];
  const payloadIds = changedIds.filter(id => {
    const cached = known.get(id)?.row;
    const metadata = manifest.find(row => row.id === id)!;
    if (!cached || !options.reuseCachedPayload?.(cached, metadata)) return true;
    const row = { ...cached, ...metadata };
    changed.push({ fingerprint: fingerprint(row), row });
    return false;
  });
  for (let offset = 0; offset < payloadIds.length; offset += 50) {
    const rows = await readAll(columns.join(','), payloadIds.slice(offset, offset + 50));
    changed.push(...rows.map(row => ({ fingerprint: fingerprint(row), row })));
  }
  // Separate REST requests do not share a transaction. Recheck before accepting
  // removals or cached credentials; a racing mutation fails this poll closed.
  const confirmed = await readAll(manifestColumns);
  const expected = new Map(manifest.map(row => [row.id, fingerprint(row)]));
  if (confirmed.length !== expected.size || confirmed.some(row => expected.get(row.id) !== fingerprint(row))
    || changed.length !== changedIds.length || new Set(changed.map(entry => entry.row.id)).size !== changedIds.length
    || changed.some(entry => !changedIds.includes(entry.row.id) || expected.get(entry.row.id) !== entry.fingerprint)) {
    throw new Error('Registry changed during API synchronization');
  }
  return { changed, removed: [...known.keys()].filter(id => !expected.has(id)) };
}
