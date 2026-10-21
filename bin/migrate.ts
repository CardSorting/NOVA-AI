#!/usr/bin/env node
/**
 * NOVA Database Migration CLI
 * Runs schema creation and optional seeding against local or remote PostgreSQL.
 */
import { migrateDatabase } from '../src/db/migrate.js';
import { checkDatabaseHealth, resolveDatabaseUrl, createDatabasePool } from '../src/db/postgres.js';

const args = process.argv.slice(2);

function printHelp(): void {
  console.log(`
NOVA Database Migration Tool
Apply distilled schema and seeds to local PostgreSQL (zero Supabase bloat).

Usage:
  nova migrate [options]

Options:
  --seed             Apply development seed data (pools, runtimes, principals, test shards)
  --url <string>     PostgreSQL connection URL (default: $DATABASE_URL or postgresql://postgres:postgres@127.0.0.1:5432/nova)
  --check            Check database connection health without running migrations
  --help, -h         Show this help message

Environment Variables:
  DATABASE_URL       Connection string (e.g. postgresql://user:pass@127.0.0.1:5432/nova)
  PGHOST             PostgreSQL host (default: 127.0.0.1)
  PGPORT             PostgreSQL port (default: 5432)
  PGUSER             PostgreSQL user (default: postgres)
  PGPASSWORD         PostgreSQL password (default: postgres)
  PGDATABASE         PostgreSQL database (default: nova)
`);
}

async function main(): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  let customUrl: string | undefined;
  const urlIdx = args.indexOf('--url');
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    customUrl = args[urlIdx + 1];
  }

  const seed = args.includes('--seed');
  const checkOnly = args.includes('--check');
  const targetUrl = resolveDatabaseUrl(customUrl);

  // Mask password for display
  const maskedUrl = targetUrl.replace(/:([^@/:]+)@/, ':****@');
  console.log(`[NOVA DB] Target database: ${maskedUrl}`);

  if (checkOnly) {
    const pool = createDatabasePool(targetUrl);
    try {
      const health = await checkDatabaseHealth(pool);
      if (health.ok) {
        console.log(`[NOVA DB] Health check: OK (${health.latencyMs}ms)`);
        console.log(`[NOVA DB] Server version: ${health.version}`);
        process.exit(0);
      } else {
        console.error(`[NOVA DB] Health check failed: ${health.error}`);
        process.exit(1);
      }
    } finally {
      await pool.end();
    }
  }

  try {
    const res = await migrateDatabase({ url: targetUrl, seed });
    if (res.applied) {
      console.log('[NOVA DB] Database setup successfully completed.');
      process.exit(0);
    }
  } catch (error: any) {
    console.error(`[NOVA DB] Migration failed: ${error.message}`);
    process.exit(1);
  }
}

void main();
