/**
 * PostgreSQL Database Adapter for NOVA
 * Manages native pg pools, connection health, and transactional execution
 * without cloud or proprietary vendor dependencies.
 */
import pg from 'pg';

let globalPool: pg.Pool | undefined;
let activeConnectionString: string | undefined;

export function resolveDatabaseUrl(explicitUrl?: string): string {
  if (explicitUrl) return explicitUrl;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;

  const host = process.env.PGHOST || '127.0.0.1';
  const port = process.env.PGPORT || '5432';
  const user = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD !== undefined ? process.env.PGPASSWORD : 'postgres';
  const database = process.env.PGDATABASE || 'nova';

  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
  return `postgresql://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function createDatabasePool(connectionString?: string, config: Partial<pg.PoolConfig> = {}): pg.Pool {
  const url = resolveDatabaseUrl(connectionString);
  return new pg.Pool({
    connectionString: url,
    max: config.max ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    allowExitOnIdle: true,
    ...config,
  });
}

export function getDatabasePool(connectionString?: string): pg.Pool {
  const targetUrl = resolveDatabaseUrl(connectionString);
  if (!globalPool || activeConnectionString !== targetUrl) {
    if (globalPool) {
      void globalPool.end();
    }
    activeConnectionString = targetUrl;
    globalPool = createDatabasePool(targetUrl);
  }
  return globalPool;
}

export async function closeDatabasePool(): Promise<void> {
  if (globalPool) {
    await globalPool.end();
    globalPool = undefined;
    activeConnectionString = undefined;
  }
}

export interface DatabaseHealth {
  ok: boolean;
  version?: string;
  now?: string;
  latencyMs: number;
  error?: string;
}

export async function checkDatabaseHealth(pool?: pg.Pool): Promise<DatabaseHealth> {
  const db = pool ?? getDatabasePool();
  const start = performance.now();
  try {
    const res = await db.query('SELECT version(), clock_timestamp() AS now');
    const elapsed = Math.round(performance.now() - start);
    return {
      ok: true,
      version: res.rows[0]?.version,
      now: res.rows[0]?.now?.toISOString?.() ?? String(res.rows[0]?.now),
      latencyMs: elapsed,
    };
  } catch (err: any) {
    const elapsed = Math.round(performance.now() - start);
    return {
      ok: false,
      latencyMs: elapsed,
      error: err?.message || String(err),
    };
  }
}

export async function withTransaction<T>(
  pool: pg.Pool,
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
