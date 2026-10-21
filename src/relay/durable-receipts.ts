import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { completionUsage, type CompletionUsage } from './completion-usage.js';

type Value = string | number | null;
interface Statement { get(...args: Value[]): any; all(...args: Value[]): any[]; run(...args: Value[]): { changes: number | bigint }; }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void; }
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (file: string, options: { allowExtension: boolean }) => Database };
export const RECEIPT_RETENTION_MS = 30 * 86400_000;
export interface DurableReceipt { id: string; status: 'pending' | 'unknown' | 'not_started' | 'completed';
  output: string | null; usage: CompletionUsage | null; retainedUntil: number | null; }
export class ReceiptError extends Error { constructor(readonly code: string) { super(code); } }
const check = (v: unknown, code = 'receipt_store_unavailable') => { if (!v) throw new ReceiptError(code); };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

/** Private per-worker durable evidence, independently retrievable after restart.
 * DELETE journal deliberately avoids the affected SQLite WAL-reset versions.
 * One fenced writer, bounded capacity, full synchronization, no expiry of
 * unknowns. Expired terminal evidence is retained as an unknown tombstone.
 */
export class DurableReceipts {
  private readonly db: Database;
  private readonly epoch = randomUUID();
  private closed = false;
  constructor(directory: string, private readonly now = Date.now, private readonly capacity = 10000) {
    check(Number.isSafeInteger(capacity) && capacity > 0 && capacity <= 100000);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = fs.lstatSync(directory);
    check(dir.isDirectory() && !dir.isSymbolicLink() && (dir.mode & 0o077) === 0 && (process.getuid === undefined || dir.uid === process.getuid()));
    const filename = path.join(fs.realpathSync(directory), 'receipts.sqlite');
    try { fs.closeSync(fs.openSync(filename, 'wx', 0o600)); } catch (e: any) { if (e.code !== 'EEXIST') throw new ReceiptError('receipt_store_unavailable'); }
    const file = fs.lstatSync(filename);
    check(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && (file.mode & 0o077) === 0 && (process.getuid === undefined || file.uid === process.getuid()));
    this.db = new DatabaseSync(filename, { allowExtension: false });
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
      const application = this.db.prepare('PRAGMA application_id').get()?.application_id;
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      check((application === 1196576817 && version === 1) || (application === 0 && version === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length === 0));
      check(this.db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode === 'delete');
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;');
      check(this.db.prepare('PRAGMA synchronous').get()?.synchronous === 2);
      this.tx(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS authority(id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS receipts (
            id TEXT NOT NULL, tenant TEXT NOT NULL, fingerprint TEXT NOT NULL, epoch TEXT NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('queued','running','unknown','not_started','completed')),
            created_at INTEGER NOT NULL, retained_until INTEGER, outcome TEXT, outcome_hash TEXT,
            PRIMARY KEY(id,tenant)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS receipt_expiry ON receipts(retained_until) WHERE retained_until IS NOT NULL;
          PRAGMA application_id=1196576817; PRAGMA user_version=1;`);
        this.db.prepare('INSERT INTO authority VALUES(1,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch').run(this.epoch);
        // The new writer fences old queued work before declaring non-dispatch.
        this.db.prepare("UPDATE receipts SET phase='not_started', retained_until=? WHERE phase='queued'").run(this.now() + RECEIPT_RETENTION_MS);
        this.db.exec("UPDATE receipts SET phase='unknown' WHERE phase='running'");
      });
      const fd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { if (!this.closed) this.db.close(); this.closed = true; throw e; }
  }
  private tx<T>(fn: () => T): T {
    check(!this.closed);
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { try { this.db.close(); } finally { this.closed = true; } } throw e; }
  }
  private writer() { check(this.db.prepare('SELECT epoch FROM authority WHERE id=1').get()?.epoch === this.epoch, 'receipt_writer_fenced'); }
  verifyReady(): void { this.tx(() => this.writer()); }
  private retainExpiredEvidence(): void {
    // Forgetting a completed or known-not-started row would make a late retry
    // indistinguishable from new work. Keep its request identity/fingerprint,
    // discard the output, and make the outcome permanently uncertain instead.
    this.db.prepare("UPDATE receipts SET phase='unknown', outcome=NULL, outcome_hash=NULL, retained_until=NULL WHERE retained_until IS NOT NULL AND retained_until <= ? AND phase IN ('completed','not_started')").run(this.now());
  }
  reserve(id: string, tenant: string, fingerprint: string): void {
    check(/^[\w-]{1,128}$/.test(id) && /^[a-f0-9]{64}$/.test(tenant) && /^[a-f0-9]{64}$/.test(fingerprint), 'invalid_receipt_identity');
    this.tx(() => {
      this.writer();
      this.retainExpiredEvidence();
      const old = this.db.prepare('SELECT fingerprint FROM receipts WHERE id=? AND tenant=?').get(id, tenant);
      if (old) { check(old.fingerprint === fingerprint, 'receipt_conflict'); return; }
      check(this.db.prepare('SELECT count(*) AS n FROM receipts').get().n < this.capacity, 'receipt_capacity_exhausted');
      this.db.prepare("INSERT INTO receipts(id,tenant,fingerprint,epoch,phase,created_at) VALUES(?,?,?,?,'queued',?)").run(id, tenant, fingerprint, this.epoch, this.now());
    });
  }
  dispatch(id: string, tenant: string): void {
    this.tx(() => { this.writer(); check(this.db.prepare("UPDATE receipts SET phase='running' WHERE id=? AND tenant=? AND epoch=? AND phase='queued'").run(id, tenant, this.epoch).changes === 1, 'receipt_dispatch_conflict'); });
  }
  complete(id: string, tenant: string, output: string | null, usage: CompletionUsage | undefined): void {
    check(output === null || (typeof output === 'string' && Buffer.byteLength(output) <= 12000), 'invalid_receipt_output');
    const normalized = usage && completionUsage({ status: 'completed', usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } });
    const body = JSON.stringify({ output, usage: normalized ?? null });
    this.tx(() => {
      this.writer(); const old = this.db.prepare('SELECT phase,outcome FROM receipts WHERE id=? AND tenant=? AND epoch=?').get(id, tenant, this.epoch);
      check(old, 'receipt_not_found');
      if (old.phase === 'completed') { check(old.outcome === body, 'receipt_conflict'); return; }
      check(old.phase === 'running', 'receipt_completion_conflict');
      this.db.prepare("UPDATE receipts SET phase='completed',outcome=?,outcome_hash=?,retained_until=? WHERE id=? AND tenant=?").run(body, hash(body), normalized ? this.now()+RECEIPT_RETENTION_MS : null, id, tenant);
    });
  }
  stop(id: string, tenant: string): void {
    this.tx(() => {
      this.writer();
      this.db.prepare("UPDATE receipts SET phase=CASE phase WHEN 'queued' THEN 'not_started' ELSE 'unknown' END, retained_until=CASE phase WHEN 'queued' THEN ? ELSE NULL END WHERE id=? AND tenant=? AND epoch=? AND phase IN ('queued','running')")
        .run(this.now()+RECEIPT_RETENTION_MS, id, tenant, this.epoch);
    });
  }
  lookup(id: string, tenant: string): DurableReceipt | null {
    return this.tx(() => {
      this.writer();
      this.retainExpiredEvidence();
      const row = this.db.prepare('SELECT phase,outcome,outcome_hash,retained_until FROM receipts WHERE id=? AND tenant=?').get(id, tenant);
      if (!row) return null;
      let outcome = { output: null as string | null, usage: null as CompletionUsage | null };
      if (row.phase === 'completed') {
        check(typeof row.outcome === 'string' && hash(row.outcome) === row.outcome_hash, 'receipt_integrity_failed');
        const parsed = JSON.parse(row.outcome);
        check(parsed.output === null || (typeof parsed.output === 'string' && Buffer.byteLength(parsed.output) <= 12000));
        const usage = parsed.usage && completionUsage({ status: 'completed', usage: { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens, total_tokens: parsed.usage.total_tokens } });
        check(!parsed.usage || usage, 'receipt_integrity_failed');
        outcome = { output: parsed.output, usage: usage ?? null };
      }
      return { id, status: row.phase === 'queued' || row.phase === 'running' ? 'pending' : row.phase,
        output: outcome.output, usage: outcome.usage, retainedUntil: row.retained_until };
    });
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
