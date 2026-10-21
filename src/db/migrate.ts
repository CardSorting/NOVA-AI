/**
 * NOVA PostgreSQL Migration Runner
 * Executes the distilled schema and development seed data against native PostgreSQL.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createDatabasePool, getDatabasePool, resolveDatabaseUrl } from './postgres.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_DIR = path.resolve(__dirname, '../../db');

export interface MigrationOptions {
  url?: string;
  pool?: pg.Pool;
  seed?: boolean;
  quiet?: boolean;
}

export interface MigrationResult {
  applied: boolean;
  schemaApplied: boolean;
  seedApplied: boolean;
  durationMs: number;
}

export async function readSchemaSql(): Promise<string> {
  const schemaPath = path.join(DB_DIR, 'schema.sql');
  return fs.readFile(schemaPath, 'utf8');
}

export async function readSeedSql(): Promise<string> {
  const seedPath = path.join(DB_DIR, 'seed.sql');
  return fs.readFile(seedPath, 'utf8');
}

export async function migrateDatabase(options: MigrationOptions = {}): Promise<MigrationResult> {
  const log = options.quiet ? () => {} : console.log;
  const start = performance.now();
  const db = options.pool ?? createDatabasePool(options.url ?? resolveDatabaseUrl());
  const client = await db.connect();

  let schemaApplied = false;
  let seedApplied = false;

  try {
    log('[NOVA DB] Running schema migration against PostgreSQL...');
    const schemaSql = await readSchemaSql();
    await client.query(schemaSql);
    schemaApplied = true;
    log('[NOVA DB] Distilled schema applied successfully.');

    if (options.seed) {
      log('[NOVA DB] Applying development seed data...');
      const seedSql = await readSeedSql();
      await client.query(seedSql);
      seedApplied = true;
      log('[NOVA DB] Development seed data applied successfully.');
    }

    const durationMs = Math.round(performance.now() - start);
    log(`[NOVA DB] Migration complete in ${durationMs}ms.`);
    return {
      applied: true,
      schemaApplied,
      seedApplied,
      durationMs,
    };
  } finally {
    client.release();
    if (!options.pool) {
      await db.end();
    }
  }
}
