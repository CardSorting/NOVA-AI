import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readSchemaSql,
  readSeedSql,
  migrateDatabase,
  resolveDatabaseUrl,
  createDatabasePool,
  checkDatabaseHealth,
  PostgresExecutionStore,
  centralQuery
} from '../src/index.js';

test('Distilled PostgreSQL schema is bloat-free and contains all required NOVA definitions', async () => {
  const schema = await readSchemaSql();
  assert.ok(schema.length > 5000, 'Schema should contain complete DDL definitions');

  // Verify core schemas and tables
  assert.match(schema, /CREATE SCHEMA IF NOT EXISTS private;/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.nova_shard_accounts/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.nova_shard_leases/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS private\.relay_identity/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS private\.relay_executions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS private\.nova_relay_installations/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS private\.nova_relay_principals/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS private\.nova_relay_account_control/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS private\.nova_relay_lease_bindings/);

  // Verify backward compatibility views
  assert.match(schema, /CREATE OR REPLACE VIEW public\.galx_shard_accounts/);
  assert.match(schema, /CREATE OR REPLACE VIEW public\.galx_shard_leases/);
  assert.match(schema, /CREATE OR REPLACE VIEW private\.galx_relay_principals/);

  // Verify required stored procedures
  assert.match(schema, /CREATE OR REPLACE FUNCTION private\.relay_execution\(/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION private\.relay_control\(/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION private\.enroll_desktop_shard\(/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION private\.refresh_desktop_shard\(/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION private\.relay_base_acquire\(/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION private\.relay_base_release\(/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION private\.relay_base_extend\(/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION private\.relay_reconcile_activation\(/);

  // Ensure 100% elimination of Supabase bloat
  assert.doesNotMatch(schema, /auth\.users/, 'Must not reference Supabase Auth auth.users');
  assert.doesNotMatch(schema, /auth\.jwt\(\)/, 'Must not reference Supabase JWT auth');
  assert.doesNotMatch(schema, /stripe_/i, 'Must not reference Stripe billing bloat');
  assert.doesNotMatch(schema, /pgvector/i, 'Must not reference vector search bloat');
  assert.doesNotMatch(schema, /chat_conversations/i, 'Must not reference chat history bloat');
  assert.doesNotMatch(schema, /supabase_migrations/i, 'Must not reference Supabase cloud migration trackers');
});

test('Distilled PostgreSQL seed script provides local development identities', async () => {
  const seed = await readSeedSql();
  assert.ok(seed.length > 500, 'Seed file should contain setup records');

  assert.match(seed, /INSERT INTO private\.nova_relay_installations/);
  assert.match(seed, /INSERT INTO private\.nova_relay_installation_runtime/);
  assert.match(seed, /INSERT INTO private\.relay_identity/);
  assert.match(seed, /INSERT INTO private\.nova_relay_principals/);
  assert.match(seed, /INSERT INTO public\.nova_shard_accounts/);
});

test('resolveDatabaseUrl handles custom URLs and fallback defaults', () => {
  const custom = 'postgresql://myuser:mypass@db.local:5433/mydb';
  assert.equal(resolveDatabaseUrl(custom), custom);

  const originalEnv = { ...process.env };
  try {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    process.env.PGHOST = '10.0.0.1';
    process.env.PGPORT = '5433';
    process.env.PGUSER = 'nova_admin';
    process.env.PGPASSWORD = 'secret_password';
    process.env.PGDATABASE = 'nova_db';

    const resolved = resolveDatabaseUrl();
    assert.equal(resolved, 'postgresql://nova_admin:secret_password@10.0.0.1:5433/nova_db');
  } finally {
    process.env = originalEnv;
  }
});

test('PostgresExecutionStore executes relay_execution stored procedure', async () => {
  let executedSql = '';
  let executedParams: any[] = [];

  const mockDb = {
    query: async (sql: string, params: any[]) => {
      executedSql = sql;
      executedParams = params;
      return {
        rows: [{
          result: {
            requestKey: params[3]?.requestKey || 'key1',
            state: 'reserved',
            settled: false,
          }
        }]
      };
    }
  };

  const store = new PostgresExecutionStore(mockDb as any, 'premium', '00000000-0000-0000-0000-000000000001');
  const res = await store.call('reserve', { requestKey: 'a'.repeat(64), workload: 'text' });

  assert.equal(executedSql, 'SELECT private.relay_execution($1,$2::uuid,$3,$4::jsonb) AS result');
  assert.equal(executedParams[0], 'premium');
  assert.equal(executedParams[1], '00000000-0000-0000-0000-000000000001');
  assert.equal(executedParams[2], 'reserve');
  assert.equal(JSON.parse(executedParams[3]).requestKey, 'a'.repeat(64));
  assert.equal(res.state, 'reserved');
});

test('centralQuery executes relay_control stored procedure and maps errors', async () => {
  let executedSql = '';
  let executedParams: any[] = [];

  const mockDb = {
    query: async (sql: string, params: any[]) => {
      executedSql = sql;
      executedParams = params;
      return {
        rows: [{
          result: {
            pool: 'premium',
            installationId: '00000000-0000-0000-0000-000000000001',
            kind: 'operator'
          }
        }]
      };
    }
  };

  const query = centralQuery(mockDb as any);
  const res = await query('token_sha', 'authenticate', { pool: 'premium' });

  assert.equal(executedSql, 'SELECT private.relay_control($1,$2,$3::jsonb) AS result');
  assert.equal(executedParams[0], 'token_sha');
  assert.equal(executedParams[1], 'authenticate');
  assert.equal(JSON.parse(executedParams[2]).pool, 'premium');
  assert.equal(res.kind, 'operator');
});

test('migrateDatabase mock runner executes schema and seed queries sequentially', async () => {
  const executedQueries: string[] = [];

  const mockClient = {
    query: async (sql: string) => {
      executedQueries.push(sql);
      return { rows: [] };
    },
    release: () => {}
  };

  const mockPool = {
    connect: async () => mockClient,
    end: async () => {}
  };

  const result = await migrateDatabase({
    pool: mockPool as any,
    seed: true,
    quiet: true
  });

  assert.equal(result.applied, true);
  assert.equal(result.schemaApplied, true);
  assert.equal(result.seedApplied, true);
  assert.equal(executedQueries.length, 2);
  assert.ok(executedQueries[0].includes('CREATE TABLE IF NOT EXISTS public.nova_shard_accounts'));
  assert.ok(executedQueries[1].includes('INSERT INTO private.nova_relay_installations'));
});
